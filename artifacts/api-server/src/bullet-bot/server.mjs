import http from "node:http";
import { createBingX } from "./bingx.mjs";
import { authorized, validateSignal } from "./contract.mjs";
import { createStore } from "./store.mjs";
import { ensurePaperAccount } from "./paper-account.mjs";
import { createWorker } from "./worker.mjs";
import { createPaperFeeReader } from "./paper-fees.mjs";
import { createVstStore } from "./vst-store.mjs";
import { createVstWorker } from "./vst-worker.mjs";
import { ReceiveSourceCommandBody } from "@workspace/api-zod";
import { createBingXLiveApi } from "./bingx-live-api.mjs";
import { createVstBroker } from "./vst-broker.mjs";
import { createIngressAuditEvent } from "./ingress-audit.mjs";

const MAX_BODY_BYTES = 32 * 1024;
export const VST_WRITE_PATHS = new Set([
  "/openApi/swap/v2/trade/leverage",
  "/openApi/swap/v2/trade/marginType",
  "/openApi/swap/v2/trade/order",
  "/openApi/swap/v2/trade/positionMargin",
]);
const VST_SIZING_CONFIGURATION = {
  environment: "vst",
  maxQuoteAgeMs: 10_000,
  maxSlippageBps: 20,
};

function validateVstSizingConfiguration(configuration) {
  if (configuration.environment !== "vst" ||
      !Number.isSafeInteger(configuration.maxQuoteAgeMs) ||
      configuration.maxQuoteAgeMs <= 0 ||
      !Number.isSafeInteger(configuration.maxSlippageBps) ||
      configuration.maxSlippageBps < 0 ||
      configuration.maxSlippageBps >= 10_000) {
    throw new Error("Invalid fixed VST sizing configuration");
  }
  return Object.freeze(configuration);
}

export const VST_SIZING_LIMITS =
  validateVstSizingConfiguration({ ...VST_SIZING_CONFIGURATION });

// A single worker/account coordinator owns these cohorts. This is not three
// independently trading workers, and it does not increase the BingX API budget.
export const VST_ENTRY_BATCH_LIMITS = Object.freeze({
  entryBatchSize: 3,
  entryBatchBudgetMs: 30_000,
});

export function createConfiguredVstWorker({
  store, broker, workerFactory = createVstWorker, onBlocked, onTiming, entryGuard,
  shouldYieldToUrgentWork,
}) {
  const sourceExitStoreMethods = [
    "queueSourceExitRequests",
    "listPendingSourceExitRequests",
    "finishSourceExitRequest",
    "hasPendingSourceExitRequest",
  ];
  const missing = sourceExitStoreMethods.filter((name) => typeof store?.[name] !== "function");
  if (missing.length) {
    throw new TypeError(`VST source exit queue store contract is unavailable: ${missing.join(", ")}`);
  }
  return workerFactory({
    store,
    broker,
    sizingLimits: VST_SIZING_LIMITS,
    sourceExitsEnabled: true,
    strategyAuthority: "source",
    exitStrategy: "full_take_5pct",
    entryGuard,
    shouldYieldToUrgentWork,
    ...VST_ENTRY_BATCH_LIMITS,
    onBlocked,
    onTiming,
  });
}

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function parseBody(req) {
  let size = 0;
  const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("request_too_large");
      error.status = 413;
      throw error;
    }
    parts.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    const error = new Error("invalid_json");
    error.status = 400;
    throw error;
  }
}

/** HTTP ingress only. Never places an order from the request handler. */
export function createServer({
  store, token, mode = "paper", clock = Date.now, basePath = "",
  ingestAliases = [], marketCheck, paperStore = store, vstEnabledAt, onIngress,
  commandInbox,
  onWorkQueued,
}) {
  if (!token) throw new Error("TRADING_INGEST_TOKEN is required");
  if (mode !== "paper" && mode !== "vst" && mode !== "both")
    throw new Error("PAPER_ONLY_SIGNAL: live mode is disabled");
  if (!store || typeof store.enqueue !== "function")
    throw new TypeError("A signal store is required");
  const vstGated = mode === "vst" || mode === "both";
  if (vstGated && typeof store.listOpenPositions !== "function")
    throw new TypeError("VST mode requires a VST position store");
  if (mode === "both" && (!paperStore || typeof paperStore.enqueue !== "function"))
    throw new TypeError("both mode requires a PAPER signal store");
  if (basePath && !/^\/[a-z0-9/-]+$/i.test(basePath)) throw new Error("Invalid bot base path");
  if (!Array.isArray(ingestAliases) ||
      ingestAliases.some((path) => typeof path !== "string" || !/^\/[a-z0-9/-]+$/i.test(path)))
    throw new Error("Invalid bot ingest alias");
  if (onIngress !== undefined && typeof onIngress !== "function")
    throw new TypeError("onIngress must be a function");
  const prefix = basePath.replace(/\/$/, "");
  const ingestPaths = new Set([`${prefix}/api/trading/signals`, ...ingestAliases]);
  const enabledAt = vstGated ? Number(vstEnabledAt ?? clock()) : null;
  if (vstGated && !Number.isFinite(enabledAt))
    throw new TypeError("vstEnabledAt must be a valid timestamp");
  return http.createServer(async (req, res) => {
    const path = new URL(req.url || "/", "http://localhost").pathname;
    const isIngressRequest = req.method === "POST" && ingestPaths.has(path);
    const logIngress = (details) => {
      if (!onIngress) return;
      try {
        onIngress(createIngressAuditEvent({ mode, ...details }));
      } catch {
        // Diagnostics must never alter whether a signal is accepted.
      }
    };
    if (path === `${prefix}/healthz` && req.method === "GET") {
      json(res, 200, {
        ok: true, mode,
        ...(vstGated ? { executionPaused: process.env.BULLET_VST_PAUSED === "1" } : {}),
      });
      return;
    }
    if (!authorized(req.headers["x-trading-token"], token)) {
      if (isIngressRequest) {
        logIngress({
          status: 401,
          outcome: "unauthorized",
          rejectionCode: "unauthorized",
        });
      }
      json(res, 401, { accepted: false, error: { code: "unauthorized" } });
      return;
    }
    if (path === `${prefix}/api/trading/market-health` && req.method === "GET") {
      if (typeof marketCheck !== "function") {
        json(res, 503, { ok: false, source: "BingX", error: "market_check_unavailable" });
        return;
      }
      try {
        await marketCheck();
        json(res, 200, { ok: true, source: "BingX", mode });
      } catch (error) {
        json(res, 503, {
          ok: false,
          source: "BingX",
          error: error?.httpStatus === 403 ? "bingx_access_denied" : "bingx_unavailable",
          ...(Number.isInteger(error?.httpStatus) ? { httpStatus: error.httpStatus } : {}),
        });
      }
      return;
    }
    if (path === "/api/trading/reset" || path === `${prefix}/api/trading/reset`) {
      if (!commandInbox?.requestReset) {
        json(res, 503, { error: { code: "command_inbox_unavailable" } });
        return;
      }
      try {
        if (req.method === "GET") {
          const resetId = new URL(req.url, "http://localhost").searchParams.get("resetId");
          if (resetId !== null && !/^[A-Za-z0-9_-]{1,100}$/.test(resetId)) {
            json(res, 422, { error: { code: "invalid_reset_id" } });
            return;
          }
          json(res, 200, { reset: await commandInbox.resetStatus(resetId) });
        } else if (req.method === "POST") {
          const body = await parseBody(req);
          if (body?.confirm !== "cancel_queue_and_close_paper_vst" ||
              typeof body.resetId !== "string" ||
              !/^[A-Za-z0-9_-]{1,100}$/.test(body.resetId) ||
              Object.keys(body).some(key => !["resetId", "confirm"].includes(key))) {
            json(res, 422, { error: { code: "explicit_reset_confirmation_required" } });
            return;
          }
          const outcome = await commandInbox.requestReset({
            resetId: body.resetId, vstAvailable: mode === "vst" || mode === "both",
          });
          json(res, outcome.kind === "busy" ? 423 : outcome.kind === "conflict" ? 409 :
            outcome.kind === "duplicate" ? 200 : 202, outcome);
        } else json(res, 405, { error: { code: "method_not_allowed" } });
      } catch {
        json(res, 503, { error: { code: "reset_storage_unavailable" } });
      }
      return;
    }
    if (path === "/api/trading/commands" || path === `${prefix}/api/trading/commands`) {
      if (!commandInbox) {
        json(res, 503, { error: { code: "command_inbox_unavailable" } });
        return;
      }
      try {
        if (req.method === "GET") {
          const query = new URL(req.url, "http://localhost").searchParams;
          const commandId = query.get("commandId");
          const limit = Number(query.get("limit") ?? 100);
          if (commandId !== null && !/^[A-Za-z0-9_-]{1,100}$/.test(commandId) ||
              !Number.isInteger(limit) || limit < 1 || limit > 100) {
            json(res, 422, { error: { code: "invalid_command_query" } });
            return;
          }
          json(res, 200, { commands: await commandInbox.list({ commandId, limit }) });
          return;
        }
        if (req.method !== "POST") {
          json(res, 405, { error: { code: "method_not_allowed" } });
          return;
        }
        const body = await parseBody(req);
        const valid = ReceiveSourceCommandBody.safeParse(body);
        if (!valid.success) {
          json(res, 422, { error: { code: "invalid_source_command" } });
          return;
        }
        // Validate the original body as well: generated schemas strip unknown
        // fields and coerce dates; neither may alter the idempotency payload.
        const saved = await commandInbox.receive(body,
          mode === "both" ? ["paper", "vst"] : mode === "vst" ? ["vst"] : ["paper"]);
        if (saved.kind === "conflict") {
          json(res, 409, { error: { code: saved.reason } });
          return;
        }
        if (saved.kind !== "duplicate") {
          try { onWorkQueued?.({ kind: "source_command" }); } catch {}
        }
        json(res, saved.kind === "duplicate" ? 200 : 202,
          { accepted: true, duplicate: saved.kind === "duplicate", command: saved.receipt });
      } catch (error) {
        json(res, error instanceof TypeError || error instanceof SyntaxError ? 422 : 503,
          { error: { code: error instanceof TypeError ? error.message : "command_storage_unavailable" } });
      }
      return;
    }
    if (path === `${prefix}/api/trading/status` && req.method === "GET") {
      try {
        if (vstGated) {
          const [positions, paperSignals, paperPositions, paperAccount] = await Promise.all([
            store.listOpenPositions(),
            paperStore?.listRecent?.(50) ?? [],
            paperStore?.listRecentPositions?.(100) ?? [],
            paperStore?.getPaperAccount?.() ?? null,
          ]);
          json(res, 200, {
            mode,
            signals: [],
            positions: positions.map(({ snapshot, ...row }) => ({ ...row, snapshot })),
            paperHistory: {
              // In "both" mode PAPER is an active, independently-writing
              // engine (see the ingestion branch below), not a read-only
              // history mirror the way it is under exclusive VST mode.
              readOnly: mode !== "both",
              paperAccount,
              signals: paperSignals.map(({ body, bodyHash, ...row }) => row),
              positions: paperPositions.map(({ snapshot, ...row }) => ({ ...row, snapshot })),
            },
          });
          return;
        }
        const [recent, positions, paperAccount] = await Promise.all([
          store.listRecent(50),
          store.listRecentPositions(100),
          store.getPaperAccount(),
        ]);
        json(res, 200, {
          mode,
          paperAccount,
          signals: recent.map(({ body, bodyHash, ...row }) => row),
          positions: positions.map(({ snapshot, ...row }) => ({
            ...row,
            snapshot,
          })),
        });
      } catch {
        json(res, 503, { error: { code: "storage_unavailable" } });
      }
      return;
    }
    if (!ingestPaths.has(path) || req.method !== "POST") {
      json(res, 404, { error: { code: "not_found" } });
      return;
    }
    let ingressSourceSignalId;
    try {
      const signal = await parseBody(req);
      ingressSourceSignalId = signal?.sourceSignalId;
      const validation = validateSignal(signal, clock());
      if (validation.status === 200 && commandInbox &&
          await commandInbox.isEntryBlocked(signal.sourceSignalId,
            mode === "vst" || mode === "both" ? "vst" : "paper", signal.signalAt)) {
        json(res, 422, { accepted: false, error: { code: "source_entry_cancelled" } });
        return;
      }
      if (validation.status !== 200) {
        logIngress({
          status: validation.status,
          outcome: "rejected",
          sourceSignalId: signal?.sourceSignalId,
          rejectionCode: validation.error.code,
          rejectionField: validation.error.field,
        });
        json(res, validation.status, {
          accepted: false,
          error: validation.error,
        });
        return;
      }
      if (vstGated && Date.parse(signal.signalAt) < enabledAt) {
        logIngress({
          status: 422,
          outcome: "rejected",
          sourceSignalId: signal.sourceSignalId,
          rejectionCode: "signal_predates_vst_enable",
          rejectionField: "signalAt",
        });
        json(res, 422, {
          accepted: false,
          error: { code: "signal_predates_vst_enable", field: "signalAt" },
        });
        return;
      }
      if (mode === "both") {
        // Enqueue into both ledgers so every future signal is processed by
        // PAPER and VST concurrently. btb_signals and vst_signals are
        // separate tables keyed on the same sourceSignalId, so this is
        // collision-free; each side reports its own duplicate/conflict
        // independently.
        const [vstResult, paperResult] = await Promise.allSettled([
          store.enqueue(signal),
          paperStore.enqueue(signal),
        ]);
        const vstSaved = vstResult.status === "fulfilled" ? vstResult.value : null;
        const paperSaved = paperResult.status === "fulfilled" ? paperResult.value : null;
        const storeStates = {
          vst: vstResult.status === "rejected" ? "failed"
            : vstSaved?.kind === "conflict" ? "conflict" : "received",
          paper: paperResult.status === "rejected" ? "failed"
            : paperSaved?.kind === "conflict" ? "conflict" : "received",
        };
        const hasFailedStore = storeStates.vst === "failed" || storeStates.paper === "failed";
        if (hasFailedStore) {
          const receivedCount = Object.values(storeStates).filter((state) => state === "received").length;
          const outcome = receivedCount > 0 ? "partial_dual_write" : "dual_write_failed";
          logIngress({
            status: 503,
            outcome,
            sourceSignalId: signal.sourceSignalId,
            rejectionCode: "storage_unavailable",
            stores: storeStates,
          });
          json(res, 503, {
            accepted: false,
            error: { code: "storage_unavailable" },
          });
          return;
        }
        if (vstSaved.kind === "conflict" || paperSaved.kind === "conflict") {
          const receivedCount = Object.values(storeStates).filter((state) => state === "received").length;
          logIngress({
            status: 409,
            outcome: receivedCount > 0 ? "partial_dual_write" : "conflict",
            sourceSignalId: signal.sourceSignalId,
            rejectionCode: "source_signal_id_conflict",
            rejectionField: "sourceSignalId",
            stores: storeStates,
          });
          json(res, 409, {
            accepted: false,
            error: { code: "source_signal_id_conflict" },
          });
          return;
        }
        logIngress({
          status: 202,
          outcome: "both_received",
          sourceSignalId: signal.sourceSignalId,
          stores: storeStates,
          duplicate: vstSaved.kind === "duplicate" && paperSaved.kind === "duplicate",
        });
        json(res, 202, {
          accepted: true,
          signal: {
            status: paperSaved.status ?? vstSaved.status ?? "pending",
            sourceSignalId: signal.sourceSignalId,
            duplicate: vstSaved.kind === "duplicate" && paperSaved.kind === "duplicate",
          },
        });
        return;
      }
      const saved = await store.enqueue(signal);
      if (saved.kind === "conflict") {
        logIngress({
          status: 409,
          outcome: "conflict",
          sourceSignalId: signal.sourceSignalId,
          rejectionCode: "source_signal_id_conflict",
          rejectionField: "sourceSignalId",
        });
        json(res, 409, {
          accepted: false,
          error: { code: "source_signal_id_conflict" },
        });
        return;
      }
      logIngress({
        status: 202,
        outcome: saved.kind === "duplicate" ? "duplicate" : "accepted",
        sourceSignalId: signal.sourceSignalId,
        duplicate: saved.kind === "duplicate",
      });
      json(res, 202, {
        accepted: true,
        signal: {
          status: saved.status ?? "pending",
          sourceSignalId: signal.sourceSignalId,
          duplicate: saved.kind === "duplicate",
        },
      });
    } catch (error) {
      const status = error.status ?? (error instanceof TypeError ? 400 : 503);
      if (isIngressRequest) {
        const parseCode = ["invalid_json", "request_too_large"].includes(error?.message)
          ? error.message
          : status === 503 ? "storage_unavailable" : undefined;
        logIngress({
          status,
          outcome: status === 503 ? "storage_failure" : "rejected",
          sourceSignalId: ingressSourceSignalId,
          rejectionCode: parseCode,
          rejectionField: parseCode === "invalid_json" || parseCode === "request_too_large"
            ? "body" : undefined,
        });
      }
      json(res, status, {
        accepted: false,
        error: { code: status === 503 ? "storage_unavailable" : error.message },
      });
    }
  });
}

function assertNotLive() {
  if (
    process.env.PAPER_ONLY_SIGNAL === "false" ||
    process.env.EXECUTION_MODE === "live"
  ) {
    throw new Error("PAPER_ONLY_SIGNAL: live mode is not approved");
  }
}

export function configuredMode() {
  const selection = process.env.BULLET_VST_MODE;
  if (selection === undefined || selection === "") return "paper";
  if (selection === "vst") return "vst";
  // "both" runs PAPER and VST concurrently: every incoming signal is
  // enqueued into both ledgers instead of exactly one. See createServer's
  // ingestion branch and bot-runtime.mjs's vstActive/paperActive wiring.
  if (selection === "both") return "both";
  throw new Error("BULLET_VST_MODE must be unset, or exactly 'vst' or 'both'");
}

/**
 * Prevent PAPER mode or a paused VST worker from abandoning VST work that
 * still needs supervision. This reads only the local ledger; it never talks
 * to the exchange. A legacy PAPER database without any VST schema is allowed.
 */
export async function assertVstStateSafeToDisable(pool, {
  mode, paused = process.env.BULLET_VST_PAUSED === "1",
} = {}) {
  const switchingToPaper = mode === "paper";
  if (!switchingToPaper && !(mode === "vst" && paused)) return;

  const requiredTables = [
    "vst_signals", "vst_positions", "vst_order_intents", "vst_events",
  ];
  const tables = await pool.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name = ANY($1::text[])`,
    [requiredTables],
  );
  const present = new Set(tables.rows.map((row) => row.table_name));
  if (present.size === 0) return; // Legacy PAPER-only installation.
  const missing = requiredTables.filter((table) => !present.has(table));
  if (missing.length) {
    throw new Error(`Cannot safely disable VST: incomplete VST schema (missing ${missing.join(", ")})`);
  }

  const state = await pool.query(`
    SELECT
      (SELECT count(*) FROM vst_positions
       WHERE status IS DISTINCT FROM 'closed')::int AS active_positions,
      (SELECT count(*) FROM vst_order_intents
       WHERE state IS NULL OR state NOT IN ('reconciled', 'failed'))::int AS unresolved_intents,
      (SELECT count(*) FROM vst_signals
       WHERE status IS NULL OR status NOT IN ('closed', 'rejected', 'error', 'unsupported'))::int AS active_signals
  `);
  const row = state.rows[0];
  if (!row) throw new Error("Cannot safely disable VST: ledger state could not be read");
  const activePositions = Number(row.active_positions);
  const unresolvedIntents = Number(row.unresolved_intents);
  const activeSignals = Number(row.active_signals);
  if (![activePositions, unresolvedIntents, activeSignals].every(Number.isSafeInteger)) {
    throw new Error("Cannot safely disable VST: ledger state is invalid");
  }

  const reasons = [];
  if (activePositions > 0) reasons.push(`${activePositions} non-closed position(s)`);
  if (unresolvedIntents > 0) reasons.push(`${unresolvedIntents} unresolved order intent(s)`);
  if (switchingToPaper && activeSignals > 0) {
    reasons.push(`${activeSignals} active VST signal(s)`);
  }
  if (reasons.length) {
    const action = switchingToPaper ? "switch to PAPER" : "pause VST";
    throw new Error(`Cannot ${action} while VST state requires supervision: ${reasons.join(", ")}`);
  }
}

/** Configure the explicit VST bridge; capability verification stays in the worker. */
export function loadVstBroker({
  configuration = process.env,
  apiFactory = createBingXLiveApi,
  brokerFactory = createVstBroker,
  fillArchiveStore,
  contractDriftMonitor,
} = {}) {
  const accountId = configuration.BULLET_VST_ACCOUNT_ALIAS;
  if (typeof accountId !== "string" || accountId.trim() === "") {
    throw new Error("BULLET_VST_ACCOUNT_ALIAS must be a stable, nonsecret account alias");
  }
  const canarySymbolsText = configuration.BULLET_VST_CANARY_SYMBOLS ?? "BTCUSDT";
  if (typeof canarySymbolsText !== "string" || canarySymbolsText.trim() === "") {
    throw new Error("BULLET_VST_CANARY_SYMBOLS must be a comma-separated canary symbol list");
  }
  const canarySymbols = canarySymbolsText.split(",").map((symbol) => symbol.trim());
  if (canarySymbols.length > 8 ||
      canarySymbols.some((symbol) => !/^[A-Z0-9]+USDT$/.test(symbol)) ||
      new Set(canarySymbols).size !== canarySymbols.length) {
    throw new Error("BULLET_VST_CANARY_SYMBOLS must contain 1..8 unique canonical USDT symbols");
  }
  const stopBufferRate = Number(configuration.BULLET_VST_STOP_BUFFER_RATE);
  if (!Number.isFinite(stopBufferRate) || stopBufferRate <= 0 || stopBufferRate >= 1) {
    throw new Error("BULLET_VST_STOP_BUFFER_RATE must be configured between 0 and 1");
  }
  const api = apiFactory({
    environment: "vst",
    ...(contractDriftMonitor ? { contractDriftMonitor } : {}),
    writePermission: ({ method, path }) =>
      method !== "GET" && VST_WRITE_PATHS.has(path),
  });
  const broker = brokerFactory({
    api,
    accountId: accountId.trim(),
    canarySymbols,
    stopBufferRate,
    ...(fillArchiveStore ? { fillArchiveStore } : {}),
  });
  const required = [
    "getCapabilities", "readPlanningInputs", "readAccountState", "readMarketMark",
    "performIntent", "reconcileIntent", "readPosition",
  ];
  const missing = required.filter((name) => typeof broker?.[name] !== "function");
  if (missing.length) {
    throw new Error(`VST broker contract is unavailable: ${missing.join(", ")}`);
  }
  return broker;
}

export function createPaperMonitorWorker({ store, exchange, feeReader }) {
  const monitorOnlyStore = new Proxy(store, {
    get(target, property, receiver) {
      if (property === "getPending") return async () => null;
      return Reflect.get(target, property, receiver);
    },
  });
  return createWorker({
    store: monitorOnlyStore, exchange, feeReader, mode: "paper", strategyAuthority: "source",
    exitStrategy: "full_take_5pct",
  });
}

export async function start() {
  if (!process.env.TRADING_INGEST_TOKEN)
    throw new Error("TRADING_INGEST_TOKEN is required");
  assertNotLive();
  const mode = configuredMode();
  const vstActive = mode === "vst" || mode === "both";
  // This standalone receiver has no way to coordinate an exchange account
  // with the published VM when their databases/leader locks are separate.
  if (vstActive && process.env.NODE_ENV !== "production") {
    throw new Error("VST execution is disabled outside the published production runtime");
  }
  const paperActive = mode === "paper" || mode === "both";
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const { pool } = await import("@workspace/db");
  // Mandatory schema gate. Runtime never creates or migrates tables.
  try {
    await pool.query("SELECT source_signal_id FROM btb_signals LIMIT 0");
    await pool.query("SELECT source_signal_id FROM btb_positions LIMIT 0");
    await pool.query("SELECT id FROM btb_events LIMIT 0");
    await pool.query("SELECT singleton FROM btb_paper_account WHERE singleton = true");
    if (vstActive) {
      await pool.query("SELECT source_signal_id FROM vst_signals LIMIT 0");
      await pool.query("SELECT source_signal_id FROM vst_positions LIMIT 0");
      await pool.query("SELECT id FROM vst_order_intents LIMIT 0");
      await pool.query("SELECT id FROM vst_events LIMIT 0");
    }
  } catch (error) {
    await pool.end();
    const schema = vstActive ? "schema.sql and vst-schema.sql" : "schema.sql";
    throw new Error(`Bot schema is missing; apply ${schema} to its database before starting`, { cause: error });
  }
  await assertVstStateSafeToDisable(pool, { mode });
  const paperStore = createStore(pool);
  const store = vstActive ? createVstStore(pool) : paperStore;
  const exchange = createBingX({});
  if (paperActive) {
    await ensurePaperAccount(pool);
  }
  const worker = vstActive
    ? createConfiguredVstWorker({ store, broker: loadVstBroker() })
    : createWorker({ store, exchange, feeReader: createPaperFeeReader(), mode: "paper", strategyAuthority: "source" });
  // In "both" mode PAPER runs as its own concurrent worker (not just the
  // reconciliation-only monitor VST-exclusive mode uses), since new PAPER
  // entries must be opened, not merely closed.
  const paperWorker = mode === "both"
    ? createWorker({ store: paperStore, exchange, feeReader: createPaperFeeReader(), mode: "paper", strategyAuthority: "source" })
    : null;
  const paperMonitor = mode === "vst"
    ? createPaperMonitorWorker({ store: paperStore, exchange, feeReader: createPaperFeeReader() })
    : null;
  const server = createServer({
    store,
    paperStore,
    mode,
    token: process.env.TRADING_INGEST_TOKEN,
    ...(paperActive ? { marketCheck: async () => {
      await exchange.instrument("BTCUSDT", { fresh: true });
      await exchange.ticker("BTCUSDT");
    } } : {}),
  });
  const port = Number(process.env.PORT || 3003);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  process.stdout.write(`Bullet trading receiver listening on ${port} (${mode.toUpperCase()})\n`);
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await worker.tick();
    } catch (error) {
      process.stderr.write(`${mode.toUpperCase()} worker tick failed: ${error.name || "Error"}\n`);
    }
    try {
      if (paperWorker) await paperWorker.tick();
      else if (paperMonitor) await paperMonitor.tick();
    } catch (error) {
      process.stderr.write(`PAPER worker tick failed: ${error.name || "Error"}\n`);
    } finally {
      busy = false;
    }
  }, 3000);
  timer.unref();
  const shutdown = async () => {
    clearInterval(timer);
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  return { server, store, worker, paperWorker, paperMonitor, pool, shutdown };
}

// A bundled copy of this module lives inside the parent API entrypoint; never
// treat that bundle as an invocation of this standalone server.
if (import.meta.url.endsWith("/server.mjs") &&
    process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  start().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}