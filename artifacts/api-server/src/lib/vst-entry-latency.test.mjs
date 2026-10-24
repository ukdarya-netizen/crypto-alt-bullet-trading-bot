import test from "node:test";
import assert from "node:assert/strict";
import { buildVstEntryLatency, readVstEntryLatency } from "./vst-entry-latency.mjs";

const base = Date.parse("2026-10-24T10:00:00Z");
const options = { since: new Date(base - 86400000).toISOString(), asOf: new Date(base + 100000).toISOString() };
const timestamp = (offset) => new Date(base + offset).toISOString();
function row(id, delay) {
  return {
    source_signal_id: id, symbol: "GRASSUSDT", status: "open", received_at: timestamp(0),
    intents: [
      { phase: "market-entry", clientOrderId: id, state: "reconciled" },
      { phase: "isolated-margin-mode", state: "reconciled", createdAt: timestamp(100), updatedAt: timestamp(600) },
      { phase: "isolated-leverage-10", state: "reconciled", createdAt: timestamp(700), updatedAt: timestamp(1700) },
    ],
    measurements: [
      { version: "entry-latency-v1", clientOrderId: id, boundary: "started", attemptStartedAtMs: base + 2000 },
      { version: "entry-latency-v1", clientOrderId: id, boundary: "transport_started",
        attemptStartedAtMs: base + 2000, finalPriceStartedAtMs: base + delay - 1000,
        finalPriceCompletedAtMs: base + delay - 600, checksCompletedAtMs: base + delay - 500,
        transportStartedAtMs: base + delay },
    ],
  };
}
test("latency stages and p50/p95 use actual receipt and transport, including closed signals", () => {
  const result = buildVstEntryLatency([row("a", 5000), row("b", 10000), row("c", 30000)], options);
  assert.deepEqual(result.cohorts[0], {
    cohort: "measured", count: 3, timedCount: 3, p50Ms: 10000, p95Ms: 30000,
    refusals: 0, freshnessRefusals: 0, freshnessRefusalPercent: null,
  });
  const a = result.entries[0];
  assert.equal(a.marginModeMs, 500);
  assert.equal(a.leverageMs, 1000);
  assert.equal(a.nativeChecksMs, 2000);
  assert.equal(a.finalPriceMs, 400);
  assert.equal(a.pacingMs, 500);
  assert.equal(a.receiptToNativeAttemptMs, 2000);
  assert.equal(a.transportAt, timestamp(5000));
});
test("missing, invalid and reversed timestamps stay unknown; already-configured phases are not zero", () => {
  const source = row("a", 5000);
  source.received_at = null;
  source.intents = [source.intents[0]];
  source.measurements[1].finalPriceCompletedAtMs = base;
  const result = buildVstEntryLatency([source, { source_signal_id: "b", status: "rejected" }], options);
  assert.equal(result.entries[0].receiptToTransportMs, null);
  assert.equal(result.entries[0].marginModeMs, null);
  assert.equal(result.entries[0].finalPriceMs, null);
  assert.equal(result.entries[1].symbol, null);
  assert.equal(result.entries[1].cohort, "not_attempted");
  assert.equal(result.cohorts[0].p50Ms, null);
});
test("historical timing never merges into new percentiles or borrows another exact attempt", () => {
  const source = row("old", 500000);
  source.measurements.forEach((m) => { m.clientOrderId = "other"; });
  source.legacy_transport = { transportStartedAtMs: base + 500000 };
  const result = buildVstEntryLatency([row("new", 5000), source], options);
  assert.equal(result.cohorts[0].p95Ms, 5000);
  assert.equal(result.cohorts[1].p95Ms, 500000);
  assert.equal(result.entries[1].nativeChecksMs, null);
});
test("freshness refusal share has an explicit denominator and ambiguous submission is not a refusal", () => {
  const stale = row("stale", 5000);
  stale.measurements[1] = { ...stale.measurements[1],
    boundary: "refused_before_transport", transportStartedAtMs: undefined,
    refusedAtMs: base + 5000, preSignReason: "final_pre_sign_pacing_expired" };
  const budget = row("budget", 5000);
  budget.measurements[1] = { ...stale.measurements[1], clientOrderId: "budget", preSignReason: "final_budget_exceeded" };
  const unknown = row("unknown", 5000);
  unknown.measurements.pop();
  const sent = row("sent", 5000);
  sent.intents[0].outcome = { definiteRejection: true };
  const result = buildVstEntryLatency([stale, budget, unknown, sent], options);
  assert.equal(result.cohorts[0].refusals, 2);
  assert.equal(result.cohorts[0].freshnessRefusals, 1);
  assert.equal(result.cohorts[0].freshnessRefusalPercent, 50);
  assert.equal(result.entries[0].transportAt, null);
  assert.equal(result.entries[0].receiptToTransportMs, null);
  assert.equal(result.entries[0].pacingMs, 500);
  assert.equal(result.entries[2].refusedBeforeTransport, false);
  assert.equal(result.entries[3].refusedBeforeTransport, false);
});
test("historical no-POST evidence survives outcome reconciliation, without classifying generic failures", () => {
  const old = row("old", 5000);
  old.measurements = [];
  old.intents[0].outcome = { originalSubmissionError: {
    preSignReason: "final_pre_sign_pacing_expired", definiteRejection: true,
  } };
  const result = buildVstEntryLatency([old], options);
  assert.equal(result.cohorts[1].freshnessRefusals, 1);
  assert.equal(result.entries[0].pacingMs, null);
});
test("read-only bounded seven-day query reports sampling and propagates database failure", async () => {
  const result = await readVstEntryLatency({ query: async (sql, params) => {
    assert.match(sql, /count\(\*\) OVER\(\)/);
    assert.match(sql, /LIMIT 1000/);
    assert.match(sql, /vst_order_intents/);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE)\b/);
    assert.equal(Date.parse(params[1]) - Date.parse(params[0]), 7 * 86400000);
    return { rows: [{ ...row("a", 5000), total: "1001" }] };
  } }, { now: () => base + 100000 });
  assert.equal(result.hasMore, true);
  assert.equal(result.total, 1001);
  await assert.rejects(readVstEntryLatency({ query: async () => { throw new Error("unavailable"); } }));
});
