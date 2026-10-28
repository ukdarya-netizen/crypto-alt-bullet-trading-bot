import { inspectVstFillArchiveSchema, pool } from "@workspace/db";
import { createBingX } from "./bingx.mjs";
import { sourcePollingPolicy, sourceFailureMetadata } from "./source-polling-policy.mjs";
import { createServer } from "./server.mjs";
import { createStore } from "./store.mjs";
import { ensurePaperAccount } from "./paper-account.mjs";
import { createHealthIncidentStore } from "./health-incident-store.mjs";
import { createWorker } from "./worker.mjs";
import { createPaperFeeReader } from "./paper-fees.mjs";
import { createVstTickLivenessWatchdog, safeTickErrorSummary } from "./vst-tick-watchdog.mjs";
import { recordVstDiagnostic } from "./vst-diagnostics.mjs";
import { createVstContractDriftMonitor } from "./vst-contract-drift.mjs";
import { postTelegramMessage } from "./telegram-client.mjs";
import { createFullTakeWatchHealth } from "./full-take-watch-health.mjs";
import { createSubscriberTradingManager } from "./subscriber-trading.mjs";
import { createOwnerStrategyHolder } from "./owner-trading-strategy.mjs";
import { recordStrategyPaperSnapshot } from "./strategy-paper.mjs";
import { TECHNICAL_TELEGRAM_ALERTS_ENABLED } from "./telegram-trade-outcomes.mjs";
import { createVstStore } from "./vst-store.mjs";
import { createVstEntryHealthMonitor } from "./vst-entry-health.mjs";
import { createVstEntryHealthAlerter } from "./vst-telegram.mjs";
import {
  createVstTelegramNotifier,
  createVstBlockedAlerter,
  createSourceDiscrepancyAlerter,
  createSourceSyncLivenessAlerter,
} from "./vst-telegram.mjs";
import { createIndependentWorkerTickScheduler } from "./worker-tick-scheduler.mjs";
import { createVstFillArchiveScheduler } from "./vst-fill-archive-scheduler.mjs";
import {
  isSourceExitOperationalFailure,
  summarizeSourceExitQueue,
} from "./source-exit-queue-summary.mjs";
import { createSourceLifecycleScheduler, createSourceFreshnessWatchdog } from "./source-lifecycle-scheduler.mjs";
import { fetchBulletPositions } from "./source-position-sync.mjs";
import { auditExchangeSourcePositions } from "./source-exchange-audit.mjs";
import { reportSourceSyncFailure, reportSourceSyncStart, reportSourceSyncSuccess } from "./source-sync-status.mjs";
import { selectNewlyProvenDiscrepancies, markDiscrepanciesAlerted } from "./discrepancy-alert-dedup.mjs";
import {
  beginBotRuntimeTick,
  configureBotRuntimeHealth,
  finishBotRuntimeTick,
  getBotRuntimeHealth,
  updateBotSourceHealth,
} from "./bot-health-runtime.mjs";
import { authorized } from "./contract.mjs";
import {
  configuredMode,
  assertVstStateSafeToDisable,
  createPaperMonitorWorker,
  createConfiguredVstWorker,
  loadVstBroker,
} from "./server.mjs";
import { createSourceCommandInbox } from "./source-command-inbox.mjs";
import { runSourceCommandOrTick } from "./source-command-runtime.mjs";

const store = createStore(pool);
const commandInbox = createSourceCommandInbox(pool);
export async function listSourceCommands() {
  return commandInbox.list();
}
const vstStore = createVstStore(pool);
let entryHealthTimer;
const exchange = createBingX({});
const runtimeStartedAt = Date.now();
let server;
let workerTickLoopsStarted = false;
let vstWorker;
let paperWorker;
let paperMonitor;
let notificationTimer;
let sourceLifecycleScheduler;
let sourceFreshnessWatchdog;
let vstFillArchiveScheduler;
let workerTickScheduler;
let fullTakeWatchTimer;
let subscriberTrading;
let stopping = false;
let drainPromise;

function safeRuntimeReason(error) {
  return typeof error?.code === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(error.code)
    ? error.code
    : error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,60}$/.test(error.name)
      ? error.name : "Error";
}

async function observeRuntimeTick(lane, run) {
  beginBotRuntimeTick(lane);
  try {
    const result = await run();
    // Runtime tick completion is liveness telemetry only; it does not prove
    // fills, exchange protection, or any individual trade outcome.
    finishBotRuntimeTick(lane, { outcome: "success" });
    return result;
  } catch (error) {
    finishBotRuntimeTick(lane, { outcome: "error", reason: safeRuntimeReason(error) });
    throw error;
  }
}

const BOT_INGEST_PATHS = new Set([
  "/api/bot/api/trading/signals",
  "/api/trading/signals",
]);

function assertNotLive() {
  if (process.env.PAPER_ONLY_SIGNAL === "false" ||
      process.env.EXECUTION_MODE === "live") {
    throw new Error("PAPER_ONLY_SIGNAL: live mode is not approved");
  }
}

function requireSourceExitQueueSuccess(mode, result) {
  if (!result || !Array.isArray(result.queued) ||
      !Array.isArray(result.refreshed) || !Array.isArray(result.rejected)) {
    const error = new Error(`${mode}_source_exit_queue_result_invalid`);
    error.code = `${mode}_source_exit_queue_result_invalid`;
    throw error;
  }
  const rejected = Array.isArray(result?.rejected) ? result.rejected : [];
  if (rejected.some(isSourceExitOperationalFailure)) {
    const error = new Error(`${mode}_source_exit_persistence_failed`);
    error.code = `${mode}_source_exit_persistence_failed`;
    error.queueSummary = summarizeSourceExitQueue(result);
    throw error;
  }
  return result;
}

export function botRequestHandler(req, res) {
  try {
    assertNotLive();
  } catch {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "PAPER_ONLY_SIGNAL" }));
    return;
  }
  let mode;
  try {
    mode = configuredMode();
  } catch {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_bullet_vst_mode" }));
    return;
  }
  if (!process.env.TRADING_INGEST_TOKEN) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "bot_not_configured" }));
    return;
  }
  const requestPath = new URL(req.url || "/", "http://localhost").pathname;
  const isSignalIngest = req.method === "POST" && BOT_INGEST_PATHS.has(requestPath);
  if (isSignalIngest &&
      (mode === "vst" || mode === "both") &&
      process.env.NODE_ENV !== "production") {
    if (!authorized(req.headers?.["x-trading-token"], process.env.TRADING_INGEST_TOKEN)) {
      res.writeHead(401, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ accepted: false, error: { code: "unauthorized" } }));
      return;
    }
    res.writeHead(503, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({
      accepted: false,
      error: { code: "vst_ingress_not_available_outside_production" },
    }));
    return;
  }
  server ??= createServer({
    store: mode === "vst" || mode === "both" ? vstStore : store,
    paperStore: store,
    commandInbox,
    token: process.env.TRADING_INGEST_TOKEN,
    onWorkQueued: () => workerTickScheduler?.wakeVst?.(),
    mode,
    vstEnabledAt: runtimeStartedAt,
    onIngress: (event) => {
      process.stdout.write(`Bullet signal ingress: ${JSON.stringify(event)}\n`);
      if (["accepted", "both_received", "partial_dual_write"].includes(event.outcome) &&
          event.duplicate !== true) workerTickScheduler?.wakeVst?.({ urgent: false });
    },
    basePath: "/api/bot",
    ingestAliases: ["/api/trading/signals"],
    ...(mode === "paper" || mode === "both" ? { marketCheck: async () => {
      // Bypass the metadata cache so this proves live BingX access.
      await exchange.instrument("BTCUSDT", { fresh: true });
      await exchange.ticker("BTCUSDT");
    } } : {}),
  });
  server.emit("request", req, res);
}

// Route-triggered recovery action for the "Закрыта на BingX" manual review
// screen. Deliberately reuses the SAME vstWorker instance the periodic tick
// drives (never a freshly constructed broker/store), so it shares BingX's
// per-client request-gap throttling and the same leader lock instead of
// racing it.
export async function closeVstReviewPositionNow(sourceSignalId, resolvedBy) {
  if (!vstWorker || typeof vstWorker.closeErrorPositionNow !== "function") {
    throw new Error("vst_worker_not_active");
  }
  return vstWorker.closeErrorPositionNow(sourceSignalId, { resolvedBy });
}

export async function resolveLegacyPreRunnerClose(sourceSignalId, input) {
  if (!vstWorker ||
      typeof vstWorker.resolveLegacyPreRunnerClose !== "function") {
    throw new Error("vst_worker_not_active");
  }
  return vstWorker.resolveLegacyPreRunnerClose(sourceSignalId, input);
}

// Owner-entered fill facts are never enough to retire a position: the same
// worker first verifies a fresh, account-scoped BingX VST snapshot under the
// shared VST leader lock. Development has no worker and therefore cannot
// perform this resolution or call the exchange.
export async function resolveVstReviewOwnerAttestedClosed(sourceSignalId, input) {
  if (!vstWorker ||
      typeof vstWorker.resolveOwnerAttestedPositionClosed !== "function") {
    throw new Error("vst_worker_not_active");
  }
  return vstWorker.resolveOwnerAttestedPositionClosed(sourceSignalId, input);
}

// Route-triggered recovery action for the "Всё ещё открыта" manual review
// path: reads BingX directly instead of the owner typing the remaining
// quantity by hand. Reuses the SAME vstWorker instance as
// closeVstReviewPositionNow, for the same reason -- shared BingX request-gap
// throttling and the same leader lock instead of racing the periodic tick.
export async function confirmVstReviewPositionStillOpenNow(sourceSignalId, resolvedBy) {
  if (!vstWorker || typeof vstWorker.confirmPositionStillOpenNow !== "function") {
    throw new Error("vst_worker_not_active");
  }
  return vstWorker.confirmPositionStillOpenNow(sourceSignalId, { resolvedBy });
}

// Route-triggered recovery action for the "Не добавлена маржа" manual review
// path: never records the owner's "not added" claim on its own. Reuses the
// SAME vstWorker instance as the two recovery actions above, for the same
// reason -- shared BingX request-gap throttling and the same leader lock
// instead of racing the periodic tick.
export async function resolveVstReviewMarginTopUpKeepOpenNow(sourceSignalId, resolvedBy, note) {
  if (!vstWorker || typeof vstWorker.verifyMarginTopUpNotAddedAndResolve !== "function") {
    throw new Error("vst_worker_not_active");
  }
  return vstWorker.verifyMarginTopUpNotAddedAndResolve(sourceSignalId, { resolvedBy, note });
}

// Route-triggered, read-only companion to resolveVstReviewMarginTopUpKeepOpenNow:
// surfaces the same live BingX isolated-margin reading on the review card
// itself, before the owner clicks anything. Reuses the SAME vstWorker
// instance as the recovery actions above, for the same reason -- shared
// BingX request-gap throttling instead of racing the periodic tick. Never
// writes to the ledger.
export async function readVstReviewMarginTopUpMarginNow(sourceSignalId) {
  if (!vstWorker || typeof vstWorker.readMarginTopUpMarginNow !== "function") {
    throw new Error("vst_worker_not_active");
  }
  return vstWorker.readMarginTopUpMarginNow(sourceSignalId);
}

// Route-triggered recovery action for the margin-top-up-pending manual
// review card's "close now" path. Reuses the SAME vstWorker instance as the
// other recovery actions above, for the same reason -- shared BingX
// request-gap throttling and the same leader lock instead of racing the
// periodic tick.
export async function closeVstReviewMarginTopUpPositionNow(sourceSignalId, resolvedBy) {
  if (!vstWorker || typeof vstWorker.closeMarginTopUpPositionNow !== "function") {
    throw new Error("vst_worker_not_active");
  }
  return vstWorker.closeMarginTopUpPositionNow(sourceSignalId, { resolvedBy });
}

export async function startBotWorker() {
  assertNotLive();
  const mode = configuredMode();
  // "both" runs PAPER and VST concurrently: every incoming signal reaches
  // both engines (see createServer's dual-enqueue branch). These booleans
  // replace exact mode-equality checks everywhere a step is needed whenever
  // that engine is active, regardless of whether it is the only one.
  const vstActive = mode === "vst" || mode === "both";
  const paperActive = mode === "paper" || mode === "both";
  if (!process.env.TRADING_INGEST_TOKEN) {
    throw new Error("TRADING_INGEST_TOKEN is required for the bot");
  }
  await pool.query("SELECT source_signal_id FROM btb_signals LIMIT 0");
  await pool.query("SELECT source_signal_id FROM btb_positions LIMIT 0");
  await pool.query("SELECT id FROM btb_events LIMIT 0");
  await pool.query("SELECT singleton FROM btb_paper_account LIMIT 0");
  if (vstActive) {
    await pool.query("SELECT source_signal_id FROM vst_signals LIMIT 0");
    await pool.query("SELECT source_signal_id FROM vst_positions LIMIT 0");
    await pool.query("SELECT id FROM vst_order_intents LIMIT 0");
    await pool.query("SELECT id FROM vst_events LIMIT 0");
    await pool.query("SELECT telegram_sent_at FROM vst_events LIMIT 0");
  }
  // No-ops for "vst" (unpaused) and "both" -- neither is disabling or
  // pausing VST. Still enforced for "paper" (disabling VST) and a paused
  // "vst".
  await assertVstStateSafeToDisable(pool, { mode });
  if (paperActive) {
    await ensurePaperAccount(pool);
  }

  if (workerTickLoopsStarted) return;
  const feeReader = createPaperFeeReader();
  // Development and production share the bot token. Only the published VM
  // delivers notifications, and only to the explicitly paired chat ID.
  const vstAlertsEnabled = vstActive && process.env.NODE_ENV === "production" &&
    Boolean(process.env.TELEGRAM_BOT_TOKEN) && Boolean(process.env.TELEGRAM_CHAT_ID);
  const blockedAlerter = vstAlertsEnabled && TECHNICAL_TELEGRAM_ALERTS_ENABLED
    ? createVstBlockedAlerter({
        token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID,
      })
    : null;
  // A thrown tick may have followed an exchange mutation: retain its own
  // watchdog warning, never fold it into a symbol's read-only incident.
  const vstTickWatchdog = createVstTickLivenessWatchdog({
    blockedAlerter,
    diagnoseError: (error) => recordVstDiagnostic(error, { stage: "bot_runtime" }),
  });
  // REAL/VST exchange-vs-source discrepancy alerts share the same
  // production-only, explicit-chat-id gating as the other Telegram alerts.
  const discrepancyAlertsEnabled = TECHNICAL_TELEGRAM_ALERTS_ENABLED && process.env.NODE_ENV === "production" &&
    Boolean(process.env.TELEGRAM_BOT_TOKEN) && Boolean(process.env.TELEGRAM_CHAT_ID);
  const discrepancyAlerter = discrepancyAlertsEnabled
    ? createSourceDiscrepancyAlerter({
        token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID,
      })
    : null;
  const alertedDiscrepancies = new Set();
  // The dev preview and published VM may use the same VST API credentials
  // while holding advisory locks in different databases. Never let both
  // independently mutate the same exchange account.
  if (vstActive && process.env.NODE_ENV !== "production") {
    process.stdout.write("Bullet VST execution disabled outside production; journal remains available\n");
  }
  const runtimeVstBroker = vstActive && process.env.NODE_ENV === "production"
    ? loadVstBroker({
        fillArchiveStore: vstStore,
        contractDriftMonitor: createVstContractDriftMonitor({
          onAlert: async (report) => {
            // Independent of signal-health and conflicting-intent diagnostics.
            // report is a value-free allowlisted projection, never raw data.
            process.stderr.write(`BingX VST contract drift: ${JSON.stringify(report)}\n`);
            if (vstAlertsEnabled && TECHNICAL_TELEGRAM_ALERTS_ENABLED) {
              await postTelegramMessage({
                token: process.env.TELEGRAM_BOT_TOKEN,
                chatId: process.env.TELEGRAM_CHAT_ID,
                fetcher: fetch,
                text: `BingX VST · изменение контракта ответа\n` +
                  `${report.summary.contract} · ${report.fingerprint}\n` +
                  `Устойчивое расхождение: ${report.summary.issues.join(", ")}\n` +
                  `Нужна проверка формата ответа биржи. Строгие проверки сохранены; ` +
                  `этот монитор не отправляет торговые команды.`,
              });
            }
          },
        }),
      })
    : null;
  // Owner 2026-10-28: the owner's strategy (follow CAB / +5 / +8 / +10 / by
  // patterns) is chosen in the journal and applies to every new entry.
  const ownerStrategy = createOwnerStrategyHolder(pool);
  if (vstActive && process.env.NODE_ENV === "production") {
    await ownerStrategy.refresh();
    ownerStrategy.start();
  }
  vstWorker = vstActive && process.env.NODE_ENV === "production"
    ? createConfiguredVstWorker({
        store: vstStore,
        broker: runtimeVstBroker,
        onBlocked: blockedAlerter
          ? (info) => {
            if (info.reason === "vst_read_incident") {
              process.stderr.write(`Bullet VST read incident: ${JSON.stringify(info)}\n`);
            }
            return blockedAlerter.send(info).catch((error) => {
              process.stderr.write(`Bullet VST blocked-alert failed: ${safeTickErrorSummary(error)}\n`);
              throw error;
            });
          }
          : undefined,
        onTiming: (timing) => {
          process.stdout.write(`Bullet VST stage timing: ${JSON.stringify(timing)}\n`);
        },
        entryGuard: id => commandInbox.isEntryBlocked(id, "vst"),
        entryExitStrategyGetter: () => ownerStrategy.exitStrategy(),
        allowedPatterns: () => ownerStrategy.allowedPatterns(),
        shouldYieldToUrgentWork: ({ entryPhase } = {}) =>
          workerTickScheduler?.hasPendingVstWake?.({ urgentOnly: entryPhase === true }) === true,
      })
    : null;
  paperWorker = paperActive
    ? createWorker({ store, exchange, feeReader, mode: "paper", strategyAuthority: "source",
        exitStrategy: "full_take_5pct",
        entryGuard: id => commandInbox.isEntryBlocked(id, "paper") })
    : null;
  // The reconciliation-only monitor exists solely to give PAPER positions
  // source-sync coverage when PAPER has no full worker of its own (exclusive
  // VST mode). In "both" mode paperWorker already covers that duty.
  paperMonitor = mode === "vst"
    ? createPaperMonitorWorker({ store, exchange, feeReader })
    : null;
  if (typeof store.queueSourceExitRequests !== "function") {
    throw new TypeError("PAPER source exit queue store contract is unavailable");
  }
  if (vstActive) {
    const sourceExitStoreMethods = [
      "queueSourceExitRequests",
      "listPendingSourceExitRequests",
      "finishSourceExitRequest",
      "hasPendingSourceExitRequest",
    ];
    const missing = sourceExitStoreMethods.filter((name) => typeof vstStore[name] !== "function");
    if (missing.length) {
      throw new TypeError(`VST source exit queue store contract is unavailable: ${missing.join(", ")}`);
    }
  }
  // VST prepares a bounded cohort of three candidates concurrently, then
  // coordinates native actions sequentially. Each decision still requires
  // fresh account/position protection; a cohort is not a reusable positive
  // account proof. Real throughput remains capped by BingX's request gate
  // (bingx-live-api.mjs enforces a minimum gap between signed calls).
  // The short interval is only scheduling delay, not a rate limit. Each
  // engine gets its own single-flight loop so one slow worker cannot delay
  // the other; VST still keeps its watchdog and durable advisory lock.
  if (stopping) return;
  workerTickScheduler = createIndependentWorkerTickScheduler({
    runVst: vstWorker ? () => observeRuntimeTick("vst", () =>
      runSourceCommandOrTick(commandInbox, "vst", vstWorker)) : null,
    runPaper: paperWorker
      ? () => observeRuntimeTick("paper", () =>
        runSourceCommandOrTick(commandInbox, "paper", paperWorker))
      : paperMonitor ? () => observeRuntimeTick("paper", () =>
        runSourceCommandOrTick(commandInbox, "paper", paperMonitor)) : null,
    vstTickWatchdog,
    onVstError: (error) => {
      recordVstDiagnostic(error, { stage: "bot_runtime" });
      process.stderr.write(`Bullet VST worker tick failed: ${safeTickErrorSummary(error)}\n`);
    },
    onPaperError: (error) => {
      process.stderr.write(`Bullet PAPER worker tick failed: ${error instanceof Error ? error.name : "Error"}\n`);
    },
  });
  // Subscriber (family) trading: isolated VST workers, one per approved and
  // started subscriber. Runs only next to the owner's production VST worker.
  if (vstWorker) {
    subscriberTrading = createSubscriberTradingManager({
      ownerPool: pool,
      isEntryBlocked: (id, engine) => commandInbox.isEntryBlocked(id, engine),
    });
    subscriberTrading.start();
  }
  // Fixed +5% take: a read-only last-price watcher between management ticks.
  // A touch is latched with exchange-timestamped evidence and wakes the VST
  // worker, which closes through the normal verified exit lane.
  if (vstWorker && typeof vstWorker.observeFullTakePrices === "function") {
    let fullTakeWatchBusy = false;
    const fullTakeWatchHealth = createFullTakeWatchHealth({
      send: async (text) => {
        if (!vstAlertsEnabled) return;
        await postTelegramMessage({
          token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID,
          fetcher: fetch, text,
        });
      },
    });
    fullTakeWatchTimer = setInterval(async () => {
      if (stopping || fullTakeWatchBusy) return;
      fullTakeWatchBusy = true;
      try {
        const latched = await vstWorker.observeFullTakePrices();
        await fullTakeWatchHealth.success();
        if (latched > 0) workerTickScheduler?.wakeVst?.();
      } catch (error) {
        process.stderr.write(`Bullet VST full-take watch failed: ${safeTickErrorSummary(error)}\n`);
        await fullTakeWatchHealth.failure();
      } finally {
        fullTakeWatchBusy = false;
      }
    }, 3_000);
    fullTakeWatchTimer.unref?.();
  }
  // Exit decisions are durably recorded from each complete, fresh snapshot
  // before PAPER application or a VST wake. The three consumers are isolated:
  // a PAPER advisory-lock wait, an exchange audit, or Telegram delivery never
  // owns the 15-second source fetch cadence.
  const sourcePaperWorker = paperMonitor ?? paperWorker;
  const sourceQueuesRequired = ["paper", ...(vstActive ? ["vst"] : [])];
  const sourceQueueStatus = new Map();
  let lastSourceReadFailure = {};
  let latestSourcePollId = 0;
  const noteSourceAttemptFailure = (error) => {
    const current = getBotRuntimeHealth().source;
    updateBotSourceHealth({
      totalFailures: current.totalFailures + 1,
      consecutiveFailures: current.consecutiveFailures + 1,
      lastReason: safeRuntimeReason(error),
      lastHttpStatus: Number.isSafeInteger(error?.httpStatus) ? error.httpStatus : null,
    });
    sourceFreshnessWatchdog?.failed();
  };
  const sourceAlertsEnabled = TECHNICAL_TELEGRAM_ALERTS_ENABLED && process.env.NODE_ENV === "production" &&
    Boolean(process.env.TELEGRAM_BOT_TOKEN) && Boolean(process.env.TELEGRAM_CHAT_ID);
  const sourceLivenessAlerter = sourceAlertsEnabled
    ? createSourceSyncLivenessAlerter({
        token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID,
      })
    : null;
  const markSourceQueueResult = (pollId, queueName, successful, snapshot) => {
    const status = sourceQueueStatus.get(pollId);
    if (!status) return;
    status[queueName] = successful;
    if (snapshot?.asOf) status.asOf = snapshot.asOf;
    if (sourceQueuesRequired.every((name) => status[name] === true)) {
      const ageMs = Date.now() - Date.parse(status.asOf);
      if (ageMs >= -30_000 && ageMs <= 60_000) {
        if (pollId === latestSourcePollId) reportSourceSyncSuccess();
        const completedAt = Date.now();
        updateBotSourceHealth({
          lastSuccessAt: new Date(completedAt).toISOString(),
          lastSnapshotAt: new Date(Date.parse(status.asOf)).toISOString(),
          consecutiveFailures: 0,
          lastReason: null,
          lastHttpStatus: null,
        });
        sourceFreshnessWatchdog?.healthy(Date.parse(status.asOf));
      }
      for (const [id] of sourceQueueStatus) {
        if (id <= pollId) sourceQueueStatus.delete(id);
      }
    }
    while (sourceQueueStatus.size > 30) {
      sourceQueueStatus.delete(sourceQueueStatus.keys().next().value);
    }
  };
  sourceFreshnessWatchdog = createSourceFreshnessWatchdog({
    // Preview is paused and must not mutate the published incident checkpoint.
    ...(process.env.NODE_ENV === "production" ? {
      persistence: createHealthIncidentStore(pool),
    } : {}),
    ...(sourceLivenessAlerter ? {
      sendAlert: (info) => sourceLivenessAlerter.send({
        ...info, failure: lastSourceReadFailure,
      }),
    } : {}),
    onError: (error) => {
      process.stderr.write(`Bullet source liveness alert failed: ${error instanceof Error ? error.name : "Error"}\n`);
    },
    onStale: (staleForMs) => {
      reportSourceSyncFailure("source_sync_stale");
      process.stderr.write(`Bullet source liveness stale: ${Math.floor(staleForMs)}ms\n`);
    },
    onRecovered: () => {
      process.stdout.write("Bullet source liveness recovered\n");
    },
    onState: (incident) => updateBotSourceHealth({ incident }),
    onPersistenceState: (known) => updateBotSourceHealth({ incidentStateKnown: known }),
  });
  let sourceContractAlertKey = null;
  let sourceContractAlertAt = 0;
  let sourceContractAlertSending = false;
  sourceLifecycleScheduler = createSourceLifecycleScheduler({
    intervalMs: 60_000,
    fetchSnapshot: () => fetchBulletPositions({
      token: process.env.TRADING_INGEST_TOKEN, requireSourceAction: true,
    }),
    queuePaperExits: async ({ asOf, positions, observedAt }) =>
      requireSourceExitQueueSuccess("paper",
        await store.queueSourceExitRequests({ asOf, positions, observedAt })),
    ...(vstActive ? {
      queueVstExits: async ({ asOf, positions, allPositions, observedAt }) => {
        // Admit independent exits first; observational/control persistence
        // cannot erase or starve an already validated risk-reducing decision.
        const exits = await vstStore.queueSourceExitRequests({ asOf, positions, observedAt });
        await subscriberTrading?.queueSourceExits({ asOf, positions, allPositions, observedAt });
        const controls = await vstStore.syncSourceControls({ asOf, positions: allPositions, observedAt });
        // Background PAPER per strategy: never blocks exits or controls.
        void recordStrategyPaperSnapshot(pool, allPositions).catch((error) => {
          process.stderr.write(`Strategy paper snapshot failed: ${error instanceof Error ? error.message : "error"}\n`);
        });
        if (controls.refusals.length) process.stderr.write(
          `Bullet source control refusals: ${JSON.stringify(controls.refusals)}\n`,
        );
        return requireSourceExitQueueSuccess("vst", exits);
      },
    } : {}),
    applyPaperSnapshot: async (snapshot) => {
      const outcomes = await sourcePaperWorker?.syncSourcePositions(snapshot.positions) ?? [];
      for (const outcome of outcomes) {
        if (outcome.kind === "closed") {
          process.stderr.write(`Bullet source apply: PAPER simulated close ${outcome.sourceSignalId}\n`);
        } else if (outcome.kind === "error") {
          process.stderr.write(`Bullet source apply: PAPER close deferred ${outcome.sourceSignalId}\n`);
        } else if (outcome.kind === "missed") {
          process.stderr.write(`Bullet source apply: signal never ingested ${outcome.sourceSignalId}\n`);
        }
      }
      return outcomes;
    },
    auditSnapshot: async ({ positions, asOf, observedAt }) => {
      const audit = await auditExchangeSourcePositions({ pool, positions, asOf,
        observedAt: new Date(observedAt).toISOString() });
      if (audit.status === "unavailable") {
        process.stderr.write(`Bullet source audit unavailable (${audit.reason})\n`);
        return;
      }
      for (const item of audit.discrepancies) {
        process.stderr.write(
          `Bullet source audit: ${item.ledger} ${item.sourceSignalId} ${item.kind} (${item.verification})\n`,
        );
      }
      for (const item of audit.observations ?? []) {
        process.stdout.write(`Bullet source observation: ${JSON.stringify(item)}\n`);
      }
      // REAL remains discrepancy-only; VST exchange state is never closed
      // directly by source snapshots. Only proven mismatches alert the owner.
      const proven = audit.discrepancies.filter((item) => item.verification === "discrepancy");
      const newlyProven = selectNewlyProvenDiscrepancies(alertedDiscrepancies, proven);
      if (newlyProven.length && discrepancyAlerter) {
        try {
          await discrepancyAlerter.send(newlyProven);
          markDiscrepanciesAlerted(alertedDiscrepancies, newlyProven);
        } catch {
          process.stderr.write("Bullet source audit discrepancy alert failed\n");
        }
      }
    },
    wakeVst: () => workerTickScheduler.wakeVst(),
    onPollStart: ({ pollId }) => {
      latestSourcePollId = pollId;
      const sourceHealth = getBotRuntimeHealth().source;
      updateBotSourceHealth({
        lastAttemptAt: new Date().toISOString(),
        totalPolls: sourceHealth.totalPolls + 1,
      });
      reportSourceSyncStart();
      sourceQueueStatus.set(pollId, {});
      process.stdout.write("Bullet source poll start\n");
    },
    onPollEnd: (poll) => {
      updateBotSourceHealth({ lastDurationMs: poll.fetchLatencyMs });
      if (poll.kind === "error") {
        const error = poll.error;
        lastSourceReadFailure = sourceFailureMetadata(error);
        const reason = typeof error?.code === "string" ? error.code
          : error?.name === "BulletPositionSyncError" ? error.code
            : error instanceof Error ? error.name : "Error";
        reportSourceSyncFailure(reason);
        updateBotSourceHealth({
          lastReason: reason,
          lastHttpStatus: Number.isSafeInteger(error?.httpStatus) ? error.httpStatus : null,
        });
        // Permanent contract/auth failures are actionable immediately. Keep
        // transient transport alarms on the existing sustained-fault watchdog.
        const permanent = ["source_action_contract_not_published", "invalid_source_action"].includes(error?.code) ||
          [401, 403].includes(error?.httpStatus);
        const key = `${error?.code ?? "auth"}:${error?.httpStatus ?? ""}`;
        if (permanent && discrepancyAlerter && !sourceContractAlertSending &&
            (sourceContractAlertKey !== key || Date.now() - sourceContractAlertAt >= 30 * 60_000)) {
          sourceContractAlertSending = true;
          void discrepancyAlerter.send([{
            ledger: "source", kind: "source_contract_unavailable",
            failureCode: error?.code ?? null,
            httpStatus: Number.isSafeInteger(error?.httpStatus) ? error.httpStatus : null,
            observedAt: new Date().toISOString(),
          }]).then(() => {
            sourceContractAlertKey = key;
            sourceContractAlertAt = Date.now();
          }).catch(() => {
            process.stderr.write("Bullet source contract alert delivery failed\n");
          }).finally(() => { sourceContractAlertSending = false; });
        }
      } else {
        // A later successful read must not blame an old HTTP failure if the
        // current incident is instead delayed durable queue persistence.
        lastSourceReadFailure = {};
      }
      const pollLog = poll.kind === "error" ? process.stderr : process.stdout;
      pollLog.write(`Bullet source poll end: ${JSON.stringify({
        state: poll.kind,
        fetchLatencyMs: poll.fetchLatencyMs,
        asOfAgeMs: poll.asOfAgeMs,
        ...(poll.kind === "ok" ? { recordCount: poll.recordCount, sourceActions: poll.sourceActions } : {}),
        reason: poll.kind === "error"
          ? (typeof poll.error?.code === "string" ? poll.error.code : poll.error?.name ?? "Error")
          : null,
        ...(poll.kind === "error" ? sourceFailureMetadata(poll.error) : {}),
      })}\n`);
    },
    onPollSkip: ({ reason, remainingDelayMs }) => {
      process.stderr.write(`Bullet source poll deferred: ${reason}${Number.isSafeInteger(remainingDelayMs) && remainingDelayMs >= 0
        ? ` (${remainingDelayMs}ms remaining)` : ""}\n`);
    },
    onQueueResult: (modeName, result, snapshot) => {
      const summary = summarizeSourceExitQueue(result);
      process.stdout.write(`Bullet source exit queue: ${JSON.stringify({
        mode: modeName, ...summary,
      })}\n`);
      const persistenceFailed = summary.errors > 0;
      markSourceQueueResult(snapshot.pollId, modeName, !persistenceFailed, snapshot);
      if (persistenceFailed) {
        reportSourceSyncFailure(`${modeName}_source_exit_persistence_failed`);
        noteSourceAttemptFailure(Object.assign(
          new Error(`${modeName}_source_exit_persistence_failed`),
          { code: `${modeName}_source_exit_persistence_failed` },
        ));
      }
    },
    onAttemptFailure: ({ error }) => {
      noteSourceAttemptFailure(error);
    },
    onError: ({ lane, error, snapshot }) => {
      const reason = typeof error?.code === "string" ? error.code
        : error instanceof Error ? error.name : "Error";
      if (snapshot && lane === "paper_persist") markSourceQueueResult(snapshot.pollId, "paper", false, snapshot);
      if (snapshot && lane === "vst_persist") markSourceQueueResult(snapshot.pollId, "vst", false, snapshot);
      if (lane === "fetch" || lane === "paper_persist" || lane === "vst_persist" ||
          lane === "paper_apply") {
        reportSourceSyncFailure(reason);
      }
      if (error?.queueSummary && snapshot) {
        process.stdout.write(`Bullet source exit queue: ${JSON.stringify({
          mode: lane === "paper_persist" ? "paper" : "vst",
          ...error.queueSummary,
        })}\n`);
      }
      process.stderr.write(`Bullet source lifecycle ${lane} failed: ${reason} ${JSON.stringify(sourceFailureMetadata(error))}\n`);
    },
  });
  const sourcePolling = sourcePollingPolicy(process.env);
  configureBotRuntimeHealth({
    sourceEnabled: sourcePolling.enabled,
    sourceStartedAt: sourcePolling.enabled ? Date.now() : null,
    vstEnabled: Boolean(vstWorker),
    paperEnabled: Boolean(paperWorker || paperMonitor),
  });
  if (sourcePolling.enabled) {
    sourceFreshnessWatchdog.start();
    sourceLifecycleScheduler.start();
  } else {
    reportSourceSyncFailure(sourcePolling.reason);
    process.stdout.write(`Bullet source polling disabled: ${sourcePolling.reason}\n`);
  }
  // This read-only archive lane is independent of worker ticks and therefore
  // continues while trading is pending or an intent is unresolved. It is
  // enabled only for the production VST account and only when both optional
  // archive contracts are available.
  if (vstActive && process.env.NODE_ENV === "production") {
    const archiveMethods = [
      typeof runtimeVstBroker.captureFillArchiveWindow === "function",
      typeof vstStore.saveFillArchiveWindow === "function",
      typeof vstStore.getFillArchiveCursor === "function",
    ];
    if (archiveMethods.every(Boolean)) {
      vstFillArchiveScheduler = createVstFillArchiveScheduler({
        broker: runtimeVstBroker,
        store: vstStore,
        accountId: process.env.BULLET_VST_ACCOUNT_ALIAS.trim(),
        currency: "USDT",
        // Read-only readiness check. Production schema is provisioned through
        // Replit Publish, never by application startup.
        checkSchema: () => inspectVstFillArchiveSchema(pool),
        onError: ({ error, code, startTs, endTs }) => {
          process.stderr.write(`Bullet VST fill archive failed: ${JSON.stringify({
            code: code ?? (error instanceof Error ? error.name : "Error"),
            causeCode: error?.databaseCode ?? error?.cause?.code ?? null,
            startTs: startTs ?? null,
            endTs: endTs ?? null,
            message: error instanceof Error ? error.message : "Error",
            ...(error?.archiveDiagnostic ? { diagnostic: error.archiveDiagnostic } : {}),
          })}\n`);
        },
        onRecovery: ({ code }) => {
          process.stdout.write(`Bullet VST fill archive readiness recovered: ${code}\n`);
        },
        onProgress: ({ startTs, endTs }) => {
          process.stdout.write(`Bullet VST fill archive saved: ${startTs}-${endTs}\n`);
        },
      });
      vstFillArchiveScheduler.start();
    } else {
      process.stderr.write("Bullet VST fill archive unavailable: optional broker/store contract missing\n");
    }
  }
  workerTickLoopsStarted = true;
  if (mode === "vst" || mode === "both") {
    const healthAlerter = vstAlertsEnabled && TECHNICAL_TELEGRAM_ALERTS_ENABLED ? createVstEntryHealthAlerter({
      token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID,
    }) : null;
    const healthMonitor = createVstEntryHealthMonitor({
      pool,
      alert: healthAlerter ? (info) => healthAlerter.send(info) : null,
      log: (info) => process.stdout.write(`Bullet VST entry health: ${JSON.stringify(info)}\n`),
    });
    const checkHealth = () => {
      void healthMonitor.tick().catch((error) => {
        recordVstDiagnostic(error, { stage: "entry_health_metrics" });
        process.stderr.write("Bullet VST entry health metrics unavailable\n");
      });
    };
    entryHealthTimer = setInterval(checkHealth, 5 * 60 * 1000);
    entryHealthTimer.unref();
    checkHealth();
  }
  if (vstAlertsEnabled) {
    const notifier = createVstTelegramNotifier({
      pool, token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID,
    });
    notificationTimer = setInterval(() => {
      void notifier.tick().catch((error) => {
        process.stderr.write(`Bullet VST Telegram notification failed: ${error instanceof Error ? error.message : "Error"}\n`);
      });
    }, 5_000);
    notificationTimer.unref();
  }
  process.once("SIGTERM", stopBotWorker);
  process.once("SIGINT", stopBotWorker);
}

export function stopBotWorker() {
  stopping = true;
  workerTickScheduler?.();
  void subscriberTrading?.stop();
  clearInterval(fullTakeWatchTimer);
  fullTakeWatchTimer = undefined;
  sourceLifecycleScheduler?.stop();
  sourceFreshnessWatchdog?.stop?.();
  clearInterval(notificationTimer);
  notificationTimer = undefined;
  clearInterval(entryHealthTimer);
  entryHealthTimer = undefined;
  vstFillArchiveScheduler?.stop();
  vstFillArchiveScheduler = undefined;
  drainPromise ??= workerTickScheduler?.drain() ?? Promise.resolve();
  return drainPromise;
}