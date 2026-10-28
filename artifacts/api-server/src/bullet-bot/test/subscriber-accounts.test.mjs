// Run: node --experimental-test-module-mocks --test test/subscriber-accounts.test.mjs
import assert from "node:assert/strict";
import test, { mock } from "node:test";

const openBySchema = new Map(); // schema -> open positions
const started = [];
// Module mocks need --experimental-test-module-mocks; skipped without it.
const canMock = typeof mock.module === "function";
let createSubscriberTradingManager;
if (canMock) {
mock.module("@workspace/db", { namedExports: {
  createSubscriberSchemaPool: (schema) => ({ schema, end: async () => {}, query: async () => ({ rows: [], rowCount: 0 }) }),
} });
mock.module("../subscriber-keys.mjs", { namedExports: {
  decryptSecret: (v) => v, forbiddenPermissions: () => [], readBingXKeyPermissions: async () => ({ permissions: [] }),
} });
mock.module("../vst-store.mjs", { namedExports: {
  createVstStore: (pool) => ({
    schema: pool.schema,
    listOpenPositions: async () => Array.from({ length: openBySchema.get(pool.schema) ?? 0 }),
    enqueue: async () => {},
  }),
} });
mock.module("../server.mjs", { namedExports: {
  VST_ENTRY_BATCH_LIMITS: {}, VST_SIZING_LIMITS: {}, VST_WRITE_PATHS: new Set(),
} });
mock.module("../vst-broker.mjs", { namedExports: { createVstBroker: () => ({}) } });
mock.module("../vst-worker.mjs", { namedExports: {
  createVstWorker: () => ({ tick: async () => null, observeFullTakePrices: async () => 0 }),
} });
mock.module("../worker-tick-scheduler.mjs", { namedExports: {
  createIndependentWorkerTickScheduler: () => ({ drain: async () => {}, wakeVst: () => {} }),
} });
createSubscriberTradingManager = (await import("../subscriber-trading.mjs")).createSubscriberTradingManager;
}

function ownerPool(sub) {
  const pool = {
    async connect() {
      return { query: async (sql) => (sql.includes("information_schema.tables") ? { rows: [] } : { rows: [] }), release() {} };
    },
    async query(sql, params) {
      if (/CREATE TABLE|ALTER TABLE/.test(sql)) return { rows: [] };
      if (sql.includes("FROM subscribers")) return { rows: [{ ...sub.row }] };
      if (sql.includes("UPDATE subscribers")) return { rows: [] };
      if (sql.includes("information_schema.tables")) return { rowCount: openBySchema.has(params[0]) ? 1 : 0, rows: [] };
      const m = sql.match(/FROM (subr?_\d+)\.vst_positions/);
      if (m) return { rows: [{ n: openBySchema.get(m[1]) ?? 0 }] };
      if (sql.includes("FROM vst_signals")) return { rows: [] };
      return { rows: [] };
    },
  };
  return pool;
}

test("account switch keeps managing the old account until flat; restart drains a stopped account",
  { skip: !canMock && "needs --experimental-test-module-mocks" }, async () => {
  const sub = { row: { id: 7, status: "approved", strategy: "take5", api_key_encrypted: "k", api_secret_encrypted: "s",
    api_key_verified_at: new Date(), trading_enabled: true, trading_account: "vst", real_allowed: true,
    real_key_verified_at: new Date(), version: 1, leverage: 10, margin_mode: "ISOLATED",
    allocation_mode: "amount", allocation_value: 10 } };
  const logs = [];
  const manager = createSubscriberTradingManager({ ownerPool: ownerPool(sub), log: (l) => logs.push(l),
    configuration: { BULLET_VST_STOP_BUFFER_RATE: "0.003" } });
  await manager.reconcileNow();
  assert.ok(logs.some((l) => /Subscriber 7 trading worker started on VST/.test(l)), logs.join("\n"));
  // VST has an open trade; user presses Стоп and switches to REAL, then Старт.
  openBySchema.set("sub_7", 1);
  sub.row = { ...sub.row, trading_account: "real", version: 2 };
  await manager.reconcileNow();
  assert.ok(logs.some((l) => /trading worker started on REAL/.test(l)), logs.join("\n"));
  assert.ok(!logs.some((l) => /VST trading worker stopped/.test(l)), "VST keeps managing its open trade");
  assert.equal(manager.status(7).running, true);
  // The VST trade closes -> the VST worker stops; REAL keeps running.
  openBySchema.set("sub_7", 0);
  await manager.reconcileNow();
  assert.ok(logs.some((l) => /VST trading worker stopped \(account_flat\)/.test(l)), logs.join("\n"));
  assert.ok(!logs.some((l) => /REAL trading worker stopped/.test(l)));
  await manager.stop();

  // Restart with trading stopped but an open REAL trade: a draining worker manages it.
  logs.length = 0;
  openBySchema.set("subr_7", 1);
  sub.row = { ...sub.row, trading_enabled: false, real_allowed: false, version: 3 };
  const restarted = createSubscriberTradingManager({ ownerPool: ownerPool(sub), log: (l) => logs.push(l),
    configuration: { BULLET_VST_STOP_BUFFER_RATE: "0.003" } });
  await restarted.reconcileNow();
  assert.ok(logs.some((l) => /DRAINING \(open positions only\) trading worker started on REAL/.test(l)), logs.join("\n"));
  assert.ok(!logs.some((l) => /started on VST/.test(l)), "no VST worker without trading or open trades");
  openBySchema.set("subr_7", 0);
  await restarted.reconcileNow();
  assert.ok(logs.some((l) => /REAL trading worker stopped \(account_flat\)/.test(l)), logs.join("\n"));
  await restarted.stop();
});
