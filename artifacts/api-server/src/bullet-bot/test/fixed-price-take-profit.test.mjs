import test from "node:test";
import assert from "node:assert/strict";
import { reachedFullTake, applyFullTake, fullTakeRequest, fullTakeEvidenceValid,
  FULL_TAKE_REASON } from "../fixed-price-take-profit.mjs";

test("full take is exactly five percent of actual entry, independent of leverage", () => {
  for (const [entry, price, hit] of [
    ["100", "104.999999999", false], ["100", "105", true],
    ["100", "105.01", true], ["0.1", "0.105", true],
    ["1e-7", "1.05e-7", true], ["1e-7", "1.049999e-7", false],
    ["100", "100.5", false], ["100", "95", false],
    ["0", "105", false], ["bad", "105", false],
  ]) assert.equal(reachedFullTake(entry, price), hit, `${entry} -> ${price}`);
});

test("full take closes the whole current remainder, never an 80/20 tranche", () => {
  const state = { entryPrice: 100, quantity: 10, remainingQty: 2,
    coreQty: 0, coreOpen: false, runnerQty: 2, runnerOpen: true, peakPrice: 150 };
  const at = "2026-10-12T12:00:00.000Z";
  const observation = { next: { ...state, status: "open" }, actions: [] };
  assert.equal(applyFullTake(observation, state, 104, at), observation);
  const result = applyFullTake(observation, state, 105, at);
  assert.deepEqual(result.actions, [{
    type: "close_all", quantity: 2, price: 105, reason: FULL_TAKE_REASON,
  }]);
  assert.equal(result.next.remainingQty, 0);
  assert.equal(result.next.coreOpen, false);
  assert.equal(result.next.runnerOpen, false);
  assert.equal(result.next.status, "closed");
});

test("native take proof requires fresh verified marks and is not a source close", () => {
  const now = Date.parse("2026-10-12T12:00:00.000Z");
  const state = { sourceSignalId: "s1", symbol: "ETHUSDT", entryPrice: 100,
    environment: "vst", accountId: "test-account" };
  const mark = { verified: true, symbol: state.symbol, price: "105",
    observedAt: new Date(now).toISOString() };
  for (const bad of [
    { ...mark, verified: false }, { ...mark, symbol: "BTCUSDT" },
    { ...mark, observedAt: new Date(now - 10_001).toISOString() },
    { ...mark, observedAt: new Date(now + 2001).toISOString() },
    { ...mark, price: "104.9999" },
  ]) assert.equal(fullTakeRequest(state, bad, now), null);
  assert.equal(fullTakeRequest({ ...state, environment: "live" }, mark, now), null);
  const row = fullTakeRequest(state, mark, now);
  assert.equal(row.evidence.sourceAction, null);
  assert.equal(row.evidence.issuer, "executor_policy");
  assert.equal(fullTakeEvidenceValid(row.evidence, state.sourceSignalId, state.symbol, row.requestId), true);
  assert.equal(fullTakeEvidenceValid({ ...row.evidence, observedPrice: "104" },
    state.sourceSignalId, state.symbol, row.requestId), false);
  assert.equal(fullTakeEvidenceValid(row.evidence, "another-generation", state.symbol, row.requestId), false);
});
