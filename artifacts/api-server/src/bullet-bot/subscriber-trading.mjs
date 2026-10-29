// Subscriber trading (owner's family first). Every approved subscriber who
// saved a verified BingX key, chose an available strategy and pressed
// "Старт" gets an isolated copy of the VST executor:
//   * its own Postgres schema `sub_<id>` with the same vst_* ledger tables
//     (created with LIKE public.<table>), reached through a pool whose
//     search_path is ONLY that schema;
//   * its own leader lock, BingX client (own key, own request pacer),
//     broker, worker, tick loop and +5% take watcher;
//   * signals: every AltBullet signal the owner's bot received after the
//     subscriber pressed "Старт" is copied into the subscriber's queue;
//     source exits (AltBullet closed the trade) are copied the same way.
// "Стоп" stops new entries immediately; open positions keep being managed
// (stop-loss, take, closes) until they are closed, then the worker stops.
// Accounts (owner 2026-10-28): "vst" (BingX demo, default) or "real" (the
// real BingX account). REAL runs the very same managed executor; only the
// exchange host and the margin-asset name differ (see bingx-live-api
// REAL_ACCOUNT_CAPABILITY). REAL needs the owner's permission per person
// (the owner herself is always allowed) and a key verified on the real
// account; each account has its own ledger schema (sub_<id> / subr_<id>).
import { createSubscriberSchemaPool } from "@workspace/db";
import { REAL_ACCOUNT_CAPABILITY, createBingXLiveApi } from "./bingx-live-api.mjs";
import { createVstBroker } from "./vst-broker.mjs";
import { createVstStore } from "./vst-store.mjs";
import { createVstWorker } from "./vst-worker.mjs";
import { createIndependentWorkerTickScheduler } from "./worker-tick-scheduler.mjs";
import { decryptSecret, forbiddenPermissions, readBingXKeyPermissions } from "./subscriber-keys.mjs";
import { VST_ENTRY_BATCH_LIMITS, VST_SIZING_LIMITS, VST_WRITE_PATHS } from "./server.mjs";
import { normalizePositionProfile } from "./vst-position-profile.mjs";
import { TRADING_STRATEGIES, describeTradingStrategy, resolveTradingStrategy } from "./trading-strategy.mjs";
import { postTelegramMessage, redactTelegramError, validateTelegramCredentials } from "./telegram-client.mjs";
import { createVstTelegramNotifier } from "./vst-telegram.mjs";

/** The subscriber's chosen size, leverage and margin mode (validated). */
export function subscriberPositionProfile(row) {
  return normalizePositionProfile({
    leverage: Number(row.leverage ?? 10),
    marginMode: row.margin_mode ?? "ISOLATED",
    allocation: { mode: row.allocation_mode ?? "percent", value: Number(row.allocation_value ?? 1) },
  });
}

/** Strategies a subscriber can pick (owner 2026-10-28; same set as the owner's). */
export const SUBSCRIBER_STRATEGIES = TRADING_STRATEGIES;

/** The subscriber's stored choice, resolved; null when it is not valid. */
export function subscriberTradingStrategy(row) {
  try {
    return resolveTradingStrategy({ strategy: row.strategy, patternExit: row.pattern_exit,
      patterns: row.patterns });
  } catch { return null; }
}

const LEADER_LOCK_BASE = 100_000;
const REAL_LEADER_LOCK_BASE = 200_000;
export const TRADING_ACCOUNTS = Object.freeze(["vst", "real"]);
const runnerKey = (id, account) => `${id}:${account}`;
/** The account this subscriber trades on: "real" only when everything allows it. */
export function subscriberAccount(row) {
  return row?.trading_account === "real" ? "real" : "vst";
}
const RECONCILE_MS = 15_000;
const FEED_MS = 5_000;
const TAKE_WATCH_MS = 3_000;
const TELEGRAM_MS = 5_000;
// Delivery lock ids of subscriber ledgers (the owner's ledger uses 1).
const TELEGRAM_LOCK_BASE = 100_000;
const REAL_TELEGRAM_LOCK_BASE = 300_000;

/** "Кабинет · <name or e-mail> · BingX VST · SYMBOL" — whose test account traded. */
export function subscriberTelegramLabel(row) {
  const who = String(row.name || row.email || `#${row.id}`).replace(/[^\p{L}\p{N}@#._\- ]/gu, "").trim().slice(0, 40);
  return `Кабинет · ${who || `#${row.id}`}`;
}

// The subscribers table creates itself (same definition as
// lib/db/src/schema/subscribers.ts), so no drizzle push is needed: a push
// would also try to rewrite unrelated constraints in the production DB.
const SUBSCRIBERS_DDL = `CREATE TABLE IF NOT EXISTS subscribers (
  id serial PRIMARY KEY NOT NULL,
  clerk_user_id text NOT NULL,
  email text,
  name text,
  status text DEFAULT 'pending' NOT NULL,
  requested_at timestamp with time zone DEFAULT now() NOT NULL,
  decided_at timestamp with time zone,
  decided_by text,
  strategy text,
  api_key_encrypted text,
  api_secret_encrypted text,
  api_key_last4 text,
  api_key_verified_at timestamp with time zone,
  api_key_error text,
  trading_enabled boolean DEFAULT false NOT NULL,
  trading_started_at timestamp with time zone,
  trading_stopped_at timestamp with time zone,
  runtime_status text,
  runtime_reason text,
  runtime_at timestamp with time zone,
  version integer DEFAULT 0 NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT subscribers_clerk_user_id_unique UNIQUE (clerk_user_id)
)`;
// Columns added after the first release; ADD COLUMN IF NOT EXISTS is idempotent.
const SUBSCRIBERS_UPGRADES = [
  "ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS allocation_mode text DEFAULT 'percent' NOT NULL",
  "ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS allocation_value numeric DEFAULT '1' NOT NULL",
  "ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS leverage integer DEFAULT 10 NOT NULL",
  "ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS margin_mode text DEFAULT 'ISOLATED' NOT NULL",
  // Strategy "patterns": exit choice and 1-3 chosen patterns ("a,b").
  "ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS pattern_exit text",
  "ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS patterns text",
  // REAL account (owner 2026-10-28).
  "ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS trading_account text DEFAULT 'vst' NOT NULL",
  "ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS real_allowed boolean DEFAULT false NOT NULL",
  "ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS real_key_verified_at timestamp with time zone",
  "ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS key_is_owner_main boolean DEFAULT false NOT NULL",
  // Last trading state announced in Telegram ("real:on", "vst:off", ...).
  "ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS trading_notice text",
];
const ensuredPools = new WeakMap();

/** Idempotent; the first call per pool creates the table, later calls reuse the result. */
export function ensureSubscribersTable(pool) {
  let pending = ensuredPools.get(pool);
  if (!pending) {
    pending = (async () => {
      await pool.query(SUBSCRIBERS_DDL);
      for (const statement of SUBSCRIBERS_UPGRADES) await pool.query(statement);
      return true;
    })();
    pending.catch(() => ensuredPools.delete(pool));
    ensuredPools.set(pool, pending);
  }
  return pending;
}

export function subscriberSchema(id, account = "vst") {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("invalid subscriber id");
  if (!TRADING_ACCOUNTS.includes(account)) throw new Error("invalid trading account");
  return account === "real" ? `subr_${id}` : `sub_${id}`;
}

/** Creates the subscriber schema and copies every public vst_* table definition into it. */
export async function ensureSubscriberSchema(ownerPool, id, account = "vst") {
  const schema = subscriberSchema(id, account);
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(4348999, $1)", [account === "real" ? -id : id]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name LIKE 'vst\\_%'
       ORDER BY table_name`,
    );
    for (const { table_name: table } of tables.rows) {
      if (!/^vst_[a-z0-9_]+$/.test(table)) continue;
      await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    await client.query("COMMIT");
    return { schema, tables: tables.rows.map((row) => row.table_name) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function createSubscriberTradingManager({
  ownerPool,
  isEntryBlocked = () => false,
  log = (line) => process.stdout.write(`${line}\n`),
  configuration = process.env,
  clock = Date.now,
  fetchImpl = globalThis.fetch,
}) {
  const runners = new Map(); // id -> runner
  let reconcileTimer = null;
  let reconciling = false;
  let stopped = false;

  async function setRuntime(id, status, reason = null) {
    try {
      await ownerPool.query(
        `UPDATE subscribers SET runtime_status = $2, runtime_reason = $3, runtime_at = now() WHERE id = $1`,
        [id, status, reason === null ? null : String(reason).slice(0, 300)],
      );
    } catch {}
  }

  /**
   * `account` defaults to the chosen one. A DRAINING runner manages the open
   * positions left on the other account (after a switch, a "Стоп" or a
   * restart): it never opens new trades and does not report the cabinet
   * status, but keeps stops, takes and CAB closes until the account is flat.
   */
  // Owner 2026-10-28: the owner's Telegram chat is told when a cabinet's
  // trading really starts / stops / fails, and on which account. Each state
  // is announced once (stored), so restarts and deploys do not repeat it.
  const announced = new Map(); // id -> state
  async function announce(sub, account, state, lines) {
    const key = `${account}:${state}`;
    // The cabinet API records what it already announced (e.g. "Стоп").
    if (sub.trading_notice === key || announced.get(sub.id) === key) return;
    announced.set(sub.id, key);
    try {
      await ownerPool.query("UPDATE subscribers SET trading_notice = $2 WHERE id = $1", [sub.id, key]);
    } catch {}
    const token = configuration.TELEGRAM_BOT_TOKEN, chatId = configuration.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    const head = `${subscriberTelegramLabel(sub)}\nBingX ${account === "real" ? "REAL" : "VST"} · `;
    try {
      validateTelegramCredentials(token, chatId);
      await postTelegramMessage({ token, chatId, text: head + lines.join("\n"), fetcher: fetchImpl });
    } catch (error) {
      log(`Subscriber ${sub.id} trading notice failed: ${redactTelegramError(error)}`);
    }
  }
  function startedLines(sub, account) {
    let profile = null;
    try { profile = subscriberPositionProfile(sub); } catch {}
    const unit = account === "real" ? "USDT" : "VST";
    const strategy = subscriberTradingStrategy(sub);
    return [
      account === "real" ? "Торговля на РЕАЛЬНОМ счёте запущена." : "Торговля на демо-счёте запущена.",
      `Стратегия: ${strategy ? describeTradingStrategy(strategy) : "—"}`,
      profile ? `Размер: ${profile.allocation.mode === "percent" ? `${profile.allocation.value}% от баланса`
        : `${profile.allocation.value} ${unit}`} · ${profile.marginMode === "CROSSED" ? "кросс" : "изолированная"} · ${profile.leverage}x` : null,
    ].filter(Boolean);
  }

  async function startRunner(sub, account = subscriberAccount(sub), { draining = false } = {}) {
    const id = sub.id;
    const key = runnerKey(id, account);
    const strategy = subscriberTradingStrategy(sub) ??
      (draining ? { exitStrategy: "source", allowedPatterns: null, patterns: null } : null);
    if (!strategy) throw new Error("strategy_not_available");
    if (!draining && account === "real" && (!sub.real_allowed || !sub.real_key_verified_at)) {
      throw new Error("real_account_not_allowed_or_key_not_verified");
    }
    const report = (status, reason) => (draining ? Promise.resolve() : setRuntime(id, status, reason));
    const stopBufferRate = Number(configuration.BULLET_VST_STOP_BUFFER_RATE);
    if (!Number.isFinite(stopBufferRate) || stopBufferRate <= 0 || stopBufferRate >= 1) {
      throw new Error("BULLET_VST_STOP_BUFFER_RATE is not configured");
    }
    const positionProfile = subscriberPositionProfile(sub);
    const credentials = Object.freeze({
      key: decryptSecret(sub.api_key_encrypted),
      secret: decryptSecret(sub.api_secret_encrypted),
    });
    // The owner's main bot trades the DEMO account of BINGX_API_KEY. Checked on
    // the decrypted key itself (not a stored flag), so no lost column can
    // ever put a second bot on that account.
    const mainKey = String(configuration.BINGX_API_KEY ?? "").trim();
    if (account === "vst" && mainKey && credentials.key.trim() === mainKey) {
      throw new Error("owner_main_key_on_demo_account");
    }
    // Re-checked on every start: a key that gained withdraw/transfer rights
    // after it was saved is never used.
    const { permissions } = await readBingXKeyPermissions(credentials);
    if (forbiddenPermissions(permissions).length) throw new Error("key_has_money_moving_permissions");
    await ensureSubscriberSchema(ownerPool, id, account);
    const pool = createSubscriberSchemaPool(subscriberSchema(id, account));
    const store = createVstStore(pool, {
      leaderLockId: (account === "real" ? REAL_LEADER_LOCK_BASE : LEADER_LOCK_BASE) + id });
    const api = createBingXLiveApi({
      environment: "vst",
      ...(account === "real" ? { account: REAL_ACCOUNT_CAPABILITY } : {}),
      credentials: () => credentials,
      writePermission: ({ method, path }) => method !== "GET" && VST_WRITE_PATHS.has(path),
      positionProfile,
    });
    const broker = createVstBroker({
      api, accountId: account === "real" ? `subr-${id}` : `sub-${id}`, canarySymbols: ["BTCUSDT"], stopBufferRate,
    });
    const runner = {
      id, key, account, draining, version: sub.version, pool, store,
      tradingEnabled: !draining && Boolean(sub.trading_enabled),
      feedCursor: new Date(sub.trading_started_at ?? clock()), lastResult: null, lastReportAt: 0,
      timers: [], scheduler: null,
    };
    const worker = createVstWorker({
      store,
      broker,
      sizingLimits: VST_SIZING_LIMITS,
      sourceExitsEnabled: true,
      strategyAuthority: "source",
      // Legacy +5% positions stay +5%; new entries use the chosen strategy.
      exitStrategy: "full_take_5pct",
      entryExitStrategyGetter: () => strategy.exitStrategy,
      allowedPatterns: strategy.allowedPatterns,
      positionStrategySwitching: true,
      // "Стоп" or an owner cancel blocks entries; open positions are still managed.
      entryGuard: (signalId) => !runner.tradingEnabled || isEntryBlocked(signalId, "vst"),
      ...VST_ENTRY_BATCH_LIMITS,
    });
    runner.worker = worker;
    runner.scheduler = createIndependentWorkerTickScheduler({
      runVst: async () => {
        const result = await worker.tick();
        runner.lastResult = result;
        if (clock() - runner.lastReportAt > 30_000) {
          runner.lastReportAt = clock();
          await report(result?.kind ?? "idle", result?.reason ?? result?.operation ?? null);
        }
        return result;
      },
      onVstError: (error) => {
        runner.lastResult = { kind: "error", reason: error instanceof Error ? error.message : "error" };
        void report("error", runner.lastResult.reason);
      },
    });
    const every = (ms, fn) => {
      let busy = false;
      const timer = setInterval(async () => {
        if (busy || stopped) return;
        busy = true;
        try { await fn(); } catch (error) {
          log(`Subscriber ${id} background task failed: ${error instanceof Error ? error.message : "error"}`);
        } finally { busy = false; }
      }, ms);
      timer.unref?.();
      runner.timers.push(timer);
    };
    // Copy the owner's received signals (only while trading is enabled).
    every(FEED_MS, async () => {
      if (!runner.tradingEnabled) return;
      const rows = await ownerPool.query(
        `SELECT body, received_at FROM vst_signals WHERE received_at > $1 ORDER BY received_at LIMIT 50`,
        [runner.feedCursor],
      );
      for (const row of rows.rows) {
        await store.enqueue(row.body);
        runner.feedCursor = row.received_at;
      }
      if (rows.rows.length) runner.scheduler.wakeVst?.();
    });
    // Always watched: open positions may carry an earlier take strategy
    // (+5/+8/+10 %); positions without one are skipped by the worker itself.
    every(TAKE_WATCH_MS, async () => {
      if ((await worker.observeFullTakePrices()) > 0) runner.scheduler.wakeVst?.();
    });
    // Owner 2026-10-28: every cabinet trade (open / close / not opened) goes to
    // the owner's Telegram chat, the same messages as the main bot's, with
    // the cabinet's name in front. Events older than an hour (before this
    // feature or a long outage) are acknowledged silently, not replayed.
    const token = configuration.TELEGRAM_BOT_TOKEN, chatId = configuration.TELEGRAM_CHAT_ID;
    if (token && chatId) {
      try {
        await pool.query(
          `UPDATE vst_events SET telegram_sent_at = now()
           WHERE telegram_sent_at IS NULL AND created_at < now() - interval '1 hour'`);
        const notifier = createVstTelegramNotifier({ pool, token, chatId,
          label: subscriberTelegramLabel(sub), realAccount: account === "real",
          lockId: (account === "real" ? REAL_TELEGRAM_LOCK_BASE : TELEGRAM_LOCK_BASE) + id });
        every(TELEGRAM_MS, () => notifier.tick());
      } catch (error) {
        log(`Subscriber ${id} Telegram notifications unavailable: ${error instanceof Error ? error.message : "error"}`);
      }
    }
    runners.set(key, runner);
    log(`Subscriber ${id} ${draining ? "DRAINING (open positions only) " : ""}trading worker started on ${account.toUpperCase()} (${sub.strategy} → ${strategy.exitStrategy}${strategy.patterns ? ` [${strategy.patterns.join(",")}]` : ""}, ${positionProfile.allocation.mode} ${positionProfile.allocation.value}, ${positionProfile.marginMode} ${positionProfile.leverage}x)`);
    await report("started");
    if (!draining && runner.tradingEnabled) await announce(sub, account, "on", startedLines(sub, account));
    return runner;
  }

  async function stopRunner(key, reason) {
    const runner = runners.get(key);
    if (!runner) return;
    runners.delete(key);
    const id = runner.id;
    for (const timer of runner.timers) clearInterval(timer);
    try { await runner.scheduler?.drain?.(); } catch {}
    try { await runner.pool.end(); } catch {}
    log(`Subscriber ${id} ${runner.account.toUpperCase()} trading worker stopped (${reason})`);
    if (!runner.draining) await setRuntime(id, "stopped", reason);
  }

  /** Open positions in an account's ledger without a running worker (0 when it never traded). */
  async function ledgerOpenPositions(id, account) {
    const schema = subscriberSchema(id, account);
    const exists = await ownerPool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'vst_positions'`,
      [schema]);
    if (!exists.rowCount) return 0;
    const { rows } = await ownerPool.query(
      `SELECT count(*)::int AS n FROM ${schema}.vst_positions WHERE status IN ('open','closing','unknown')`);
    return rows[0]?.n ?? 0;
  }

  async function openPositionCount(runner) {
    try { return (await runner.store.listOpenPositions()).length; } catch { return 1; }
  }

  async function reconcile() {
    if (reconciling || stopped) return;
    reconciling = true;
    try {
      await ensureSubscribersTable(ownerPool);
      const { rows } = await ownerPool.query(
        `SELECT * FROM subscribers
         WHERE status = 'approved' AND api_key_encrypted IS NOT NULL AND api_key_verified_at IS NOT NULL
           AND strategy IS NOT NULL`,
      );
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const [key, runner] of runners) {
        const sub = byId.get(runner.id);
        if (!sub) {
          // Removed or blocked (a blocked person's key is not used any more).
          await stopRunner(key, "not_eligible");
          continue;
        }
        if (runner.account !== subscriberAccount(sub) || runner.draining) {
          // The other account (or a drain): no new trades; stop once flat.
          if (runner.tradingEnabled) {
            await announce(sub, runner.account, "off", [
              "Торговля остановлена: выбран другой счёт. Открытые сделки здесь бот доведёт до закрытия."]);
          }
          runner.tradingEnabled = false;
          if (runner.account === subscriberAccount(sub) && sub.trading_enabled) {
            await stopRunner(key, "trading_restarted"); // a full runner starts below
          } else if ((await openPositionCount(runner)) === 0) {
            await stopRunner(key, "account_flat");
          }
          continue;
        }
        if (sub.version !== runner.version) {
          // Key/strategy/account settings changed: stop (restart below if still eligible).
          await stopRunner(key, "settings_changed");
          continue;
        }
        if (!runner.tradingEnabled && sub.trading_enabled) {
          // Restarted after "Стоп": never trade signals that arrived while stopped.
          runner.feedCursor = new Date(sub.trading_started_at ?? clock());
          await announce(sub, runner.account, "on", startedLines(sub, runner.account));
        }
        if (runner.tradingEnabled && !sub.trading_enabled) {
          await announce(sub, runner.account, "off", [
            "Торговля остановлена. Новые сделки не открываются; открытые бот доведёт до закрытия."]);
        }
        runner.tradingEnabled = Boolean(sub.trading_enabled);
        if (!runner.tradingEnabled && (await openPositionCount(runner)) === 0) {
          await stopRunner(key, "stopped_by_subscriber");
        }
      }
      for (const sub of rows) {
        const current = subscriberAccount(sub);
        for (const account of TRADING_ACCOUNTS) {
          if (runners.has(runnerKey(sub.id, account))) continue;
          const trade = account === current && sub.trading_enabled && subscriberTradingStrategy(sub);
          try {
            if (trade) {
              await startRunner(sub, account);
            } else if ((await ledgerOpenPositions(sub.id, account)) > 0) {
              // Open positions with no worker (after "Стоп", a switch or a
              // restart): manage them until they are closed.
              await startRunner(sub, account, { draining: true });
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message : "start_failed";
            log(`Subscriber ${sub.id} ${account.toUpperCase()} trading worker could not start: ${reason}`);
            if (trade) {
              await setRuntime(sub.id, "error", reason);
              await announce(sub, account, `error:${reason.slice(0, 60)}`,
                ["Торговля НЕ запустилась.", `Причина: ${reason.slice(0, 200)}`]);
            }
          }
        }
      }
    } finally {
      reconciling = false;
    }
  }

  return {
    start() {
      if (reconcileTimer) return;
      reconcileTimer = setInterval(() => void reconcile().catch((error) => {
        log(`Subscriber reconcile failed: ${error instanceof Error ? error.message : "error"}`);
      }), RECONCILE_MS);
      reconcileTimer.unref?.();
      void reconcile().catch(() => {});
    },
    reconcileNow: () => reconcile(),
    /** Called with every AltBullet positions snapshot the owner's bot queues. */
    async queueSourceExits(snapshot) {
      for (const runner of runners.values()) {
        try {
          await runner.store.queueSourceExitRequests({
            asOf: snapshot.asOf, positions: snapshot.positions, observedAt: snapshot.observedAt,
          });
          await runner.store.syncSourceControls({
            asOf: snapshot.asOf, positions: snapshot.allPositions ?? snapshot.positions, observedAt: snapshot.observedAt,
          });
          runner.scheduler.wakeVst?.();
        } catch (error) {
          log(`Subscriber ${runner.id} source exit copy failed: ${error instanceof Error ? error.message : "error"}`);
        }
      }
    },
    status(id) {
      const runner = runners.get(runnerKey(id, "vst")) ?? runners.get(runnerKey(id, "real"));
      return runner ? { running: true, tradingEnabled: runner.tradingEnabled, lastResult: runner.lastResult } : { running: false };
    },
    async stop() {
      stopped = true;
      clearInterval(reconcileTimer);
      for (const key of [...runners.keys()]) await stopRunner(key, "runtime_shutdown");
    },
  };
}
