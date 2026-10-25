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
// Phase 1: VST demo accounts only. Mainnet stays disabled.
import { createSubscriberSchemaPool } from "@workspace/db";
import { createBingXLiveApi, createBingXOutboundPacer } from "./bingx-live-api.mjs";
import { createVstBroker } from "./vst-broker.mjs";
import { createVstStore } from "./vst-store.mjs";
import { createVstWorker } from "./vst-worker.mjs";
import { createIndependentWorkerTickScheduler } from "./worker-tick-scheduler.mjs";
import { decryptSecret, forbiddenPermissions, readBingXKeyPermissions } from "./subscriber-keys.mjs";
import { VST_ENTRY_BATCH_LIMITS, VST_SIZING_LIMITS, VST_WRITE_PATHS } from "./server.mjs";
import { normalizePositionProfile } from "./vst-position-profile.mjs";

/** The subscriber's chosen size, leverage and margin mode (validated). */
export function subscriberPositionProfile(row) {
  return normalizePositionProfile({
    leverage: Number(row.leverage ?? 10),
    marginMode: row.margin_mode ?? "ISOLATED",
    allocation: { mode: row.allocation_mode ?? "percent", value: Number(row.allocation_value ?? 1) },
  });
}

/** Strategies a subscriber can pick. Only executable ones can be started. */
export const SUBSCRIBER_STRATEGIES = Object.freeze({
  take5: { label: "Тейк +5% целиком", exitStrategy: "full_take_5pct", available: true },
  classic: { label: "Классическая", available: false },
  ladder: { label: "25 / 25 / 50", available: false },
  patterns: { label: "По паттернам", available: false },
});

const LEADER_LOCK_BASE = 100_000;
const RECONCILE_MS = 15_000;
const FEED_MS = 5_000;
const TAKE_WATCH_MS = 3_000;

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

export function subscriberSchema(id) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("invalid subscriber id");
  return `sub_${id}`;
}

/** Creates the subscriber schema and copies every public vst_* table definition into it. */
export async function ensureSubscriberSchema(ownerPool, id) {
  const schema = subscriberSchema(id);
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(4348999, $1)", [id]);
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

  async function startRunner(sub) {
    const id = sub.id;
    const strategy = SUBSCRIBER_STRATEGIES[sub.strategy];
    if (!strategy?.available) throw new Error("strategy_not_available");
    const stopBufferRate = Number(configuration.BULLET_VST_STOP_BUFFER_RATE);
    if (!Number.isFinite(stopBufferRate) || stopBufferRate <= 0 || stopBufferRate >= 1) {
      throw new Error("BULLET_VST_STOP_BUFFER_RATE is not configured");
    }
    const positionProfile = subscriberPositionProfile(sub);
    const credentials = Object.freeze({
      key: decryptSecret(sub.api_key_encrypted),
      secret: decryptSecret(sub.api_secret_encrypted),
    });
    // Re-checked on every start: a key that gained withdraw/transfer rights
    // after it was saved is never used.
    const { permissions } = await readBingXKeyPermissions(credentials);
    if (forbiddenPermissions(permissions).length) throw new Error("key_has_money_moving_permissions");
    await ensureSubscriberSchema(ownerPool, id);
    const pool = createSubscriberSchemaPool(subscriberSchema(id));
    const store = createVstStore(pool, { leaderLockId: LEADER_LOCK_BASE + id });
    const api = createBingXLiveApi({
      environment: "vst",
      credentials: () => credentials,
      requestPacer: createBingXOutboundPacer(),
      writePermission: ({ method, path }) => method !== "GET" && VST_WRITE_PATHS.has(path),
      positionProfile,
    });
    const broker = createVstBroker({
      api, accountId: `sub-${id}`, canarySymbols: ["BTCUSDT"], stopBufferRate,
    });
    const runner = {
      id, version: sub.version, pool, store, tradingEnabled: Boolean(sub.trading_enabled),
      feedCursor: new Date(sub.trading_started_at ?? clock()), lastResult: null, lastReportAt: 0,
      timers: [], scheduler: null,
    };
    const worker = createVstWorker({
      store,
      broker,
      sizingLimits: VST_SIZING_LIMITS,
      sourceExitsEnabled: true,
      strategyAuthority: "source",
      exitStrategy: strategy.exitStrategy,
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
          await setRuntime(id, result?.kind ?? "idle", result?.reason ?? result?.operation ?? null);
        }
        return result;
      },
      onVstError: (error) => {
        runner.lastResult = { kind: "error", reason: error instanceof Error ? error.message : "error" };
        void setRuntime(id, "error", runner.lastResult.reason);
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
    if (strategy.exitStrategy === "full_take_5pct") {
      every(TAKE_WATCH_MS, async () => {
        if ((await worker.observeFullTakePrices()) > 0) runner.scheduler.wakeVst?.();
      });
    }
    runners.set(id, runner);
    log(`Subscriber ${id} trading worker started (${sub.strategy}, ${positionProfile.allocation.mode} ${positionProfile.allocation.value}, ${positionProfile.marginMode} ${positionProfile.leverage}x)`);
    await setRuntime(id, "started");
    return runner;
  }

  async function stopRunner(id, reason) {
    const runner = runners.get(id);
    if (!runner) return;
    runners.delete(id);
    for (const timer of runner.timers) clearInterval(timer);
    try { await runner.scheduler?.drain?.(); } catch {}
    try { await runner.pool.end(); } catch {}
    log(`Subscriber ${id} trading worker stopped (${reason})`);
    await setRuntime(id, "stopped", reason);
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
      for (const [id, runner] of runners) {
        const sub = byId.get(id);
        if (!sub || sub.version !== runner.version) {
          // Removed, blocked, or key/strategy changed: stop (restart below if still eligible).
          await stopRunner(id, sub ? "settings_changed" : "not_eligible");
          continue;
        }
        if (!runner.tradingEnabled && sub.trading_enabled) {
          // Restarted after "Стоп": never trade signals that arrived while stopped.
          runner.feedCursor = new Date(sub.trading_started_at ?? clock());
        }
        runner.tradingEnabled = Boolean(sub.trading_enabled);
        if (!runner.tradingEnabled && (await openPositionCount(runner)) === 0) {
          await stopRunner(id, "stopped_by_subscriber");
        }
      }
      for (const sub of rows) {
        if (runners.has(sub.id) || !sub.trading_enabled) continue;
        if (!SUBSCRIBER_STRATEGIES[sub.strategy]?.available) continue;
        try { await startRunner(sub); } catch (error) {
          const reason = error instanceof Error ? error.message : "start_failed";
          log(`Subscriber ${sub.id} trading worker could not start: ${reason}`);
          await setRuntime(sub.id, "error", reason);
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
      const runner = runners.get(id);
      return runner ? { running: true, tradingEnabled: runner.tradingEnabled, lastResult: runner.lastResult } : { running: false };
    },
    async stop() {
      stopped = true;
      clearInterval(reconcileTimer);
      for (const id of [...runners.keys()]) await stopRunner(id, "runtime_shutdown");
    },
  };
}
