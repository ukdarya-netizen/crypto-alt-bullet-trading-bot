import test from "node:test";
import assert from "node:assert/strict";
import { refreshVstEntrySizing } from "../vst-fresh-entry-sizing.mjs";
import { ENTRY_HEALTH_SQL, createVstEntryHealthMonitor } from "../vst-entry-health.mjs";
import { createVstStore } from "../vst-store.mjs";

const inputs = {
  symbol: "RESOLVUSDT", stopLoss: "0.01799", nowMs: 1700000000000,
  policy: { maxSlippageBps: 20, maxQuoteAgeMs: 10000,
    expectedPrice: "0.01955", quantityUnitMultiple: 1 },
  balanceData: [{ asset: "VST", balance: "95467.1553", availableMargin: "95467.1553" }],
  filters: { symbol: "RESOLV-USDT", quantityPrecision: 2, pricePrecision: 5,
    minQuantity: 1, minNotional: 5, maxLeverage: 10 },
  tiers: [{ maxNotional: 400000, maintenanceMarginRate: 0.005 }],
  leverage: { maxPositionLongVal: 400000 },
  fees: { taker: 0.0005 }, funding: { rate: 0.00005 },
  quote: { ask: 0.01958, timestamp: 1700000000000 },
};

test("fresh quote reprices quantity, fees and top-up without changing stop or 1% budget", () => {
  const old = refreshVstEntrySizing(inputs);
  const fresh = refreshVstEntrySizing({ ...inputs,
    quote: { ask: 0.0205, timestamp: inputs.nowMs } });
  assert.ok(Number(fresh.quantity) < Number(old.quantity));
  assert.equal(fresh.stopLoss, old.stopLoss);
  assert.equal(fresh.initialBudgetVst, old.initialBudgetVst);
  assert.equal(fresh.initialBudgetVst, 954.671553);
  assert.equal(fresh.maxSlippageBps, 20);
  assert.ok(Number(fresh.maxEntryPrice) >= 0.0205 * 1.002);
  assert.ok(Number(fresh.maxEntryPrice) < 0.0205 * 1.002 + 0.00001);
  assert.ok(fresh.initialMarginVst <= fresh.initialBudgetVst);
  assert.ok(fresh.plannedTopUpVst > old.plannedTopUpVst);
  assert.ok(fresh.requiredAvailableVst <= fresh.availableMarginVst);
  assert.ok(fresh.takerFeeReserveVst > 0);
});

test("fresh sizing fails closed on stale quote, unavailable funds, wrong symbol and invalid stop", () => {
  assert.throws(() => refreshVstEntrySizing({ ...inputs,
    quote: { ask: 0.02, timestamp: inputs.nowMs - 10001 } }), /stale/);
  assert.throws(() => refreshVstEntrySizing({ ...inputs,
    balanceData: [{ asset: "VST", balance: "95467.1553", availableMargin: "1" }] }), /blocked/);
  assert.throws(() => refreshVstEntrySizing({ ...inputs,
    filters: { ...inputs.filters, symbol: "BTC-USDT" } }), /this symbol/);
  assert.throws(() => refreshVstEntrySizing({ ...inputs, stopLoss: "0.02000" }), /below/);
});

test("fresh sizing retains exchange cap and exact 80/20 lot representability", () => {
  const sizing = refreshVstEntrySizing({ ...inputs,
    policy: { ...inputs.policy, quantityUnitMultiple: 5 },
    leverage: { maxPositionLongVal: 100 } });
  assert.equal(sizing.positionCapBound, true);
  assert.ok(sizing.entryNotionalVst <= 100);
  assert.equal(Math.round(Number(sizing.quantity) * 100) % 5, 0);
});

test("durable reprice uses a one-shot CAS and protects every non-pricing request field", async () => {
  let query;
  const store = createVstStore({
    async query(sql, params) { query = { sql, params }; return { rowCount: 1 }; },
    async connect() { throw new Error("unexpected connection"); },
  });
  assert.equal(await store.refreshPendingEntryIntent({
    clientOrderId: "test_entry", expectedRequest: { operation: "entry" },
    request: { operation: "entry", quantity: "2" },
  }), true);
  assert.match(query.sql, /state = 'submitted'/);
  assert.match(query.sql, /exchange_order_id IS NULL/);
  assert.match(query.sql, /request = \$2::jsonb/);
  assert.match(query.sql, /NOT \(request \? 'entryPricingTelemetry'\)/);
  assert.match(query.sql, /submission_started/);
  assert.match(query.sql, /\$3::jsonb - ARRAY/);
});

test("metrics use distinct signals, durable refusal reasons, fixed windows and a separate fresh cohort", () => {
  assert.match(ENTRY_HEALTH_SQL, /ARRAY\[1,24,168\]/);
  assert.match(ENTRY_HEALTH_SQL, /count\(DISTINCT e.source_signal_id\)/);
  assert.match(ENTRY_HEALTH_SQL, /submissionErrorMessage/);
  assert.match(ENTRY_HEALTH_SQL, /fresh_sizing/);
  assert.match(ENTRY_HEALTH_SQL, /s.received_at/);
});

test("monitor aggregates alerts, retries failure, and honors durable six-hour cooldown across restarts", async () => {
  let at = 1700000000000;
  let sentAt = null, sends = 0, fail = true;
  const pool = {
    async query(sql) {
      if (sql === ENTRY_HEALTH_SQL) return { rows: [{
        hours: 24, cohort: "fresh_sizing", attempts: 10, refusals: 6,
      }] };
      if (sql.startsWith("SELECT max")) return { rows: [{ alert_at: sentAt }] };
      if (sql.startsWith("INSERT")) sentAt = new Date(at);
      return { rows: [] };
    },
  };
  const make = () => createVstEntryHealthMonitor({
    pool, log: () => {}, clock: () => at,
    alert: async (info) => {
      assert.equal(info.refusalPct, 60);
      if (fail) throw new Error("telegram unavailable");
      sends++;
    },
  });
  const monitor = make();
  await assert.rejects(monitor.tick(), /telegram unavailable/);
  fail = false;
  await monitor.tick();
  await monitor.tick();
  await make().tick();
  assert.equal(sends, 1);
  at += 6 * 60 * 60 * 1000;
  await make().tick();
  assert.equal(sends, 2);
});

test("low sample or low refusal fraction logs metrics without raising an alert", async () => {
  let logs = 0;
  const monitor = createVstEntryHealthMonitor({
    pool: { query: async () => ({ rows: [
      { hours: 24, cohort: "fresh_sizing", attempts: 4, refusals: 4 },
    ] }) },
    log: () => { logs++; },
    alert: () => { throw new Error("must not alert"); },
  });
  await monitor.tick();
  assert.equal(logs, 1);
});