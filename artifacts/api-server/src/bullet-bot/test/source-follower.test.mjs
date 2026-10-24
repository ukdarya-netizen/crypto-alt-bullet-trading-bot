import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSourceFollower } from "../source-position-control.mjs";
import { committedHistoricalCloseProof } from "../vst-source-exit-closed-proof.mjs";

const at = "2026-10-11T07:20:00.000Z";
const position = { sourceSignalId: "cab-signal-source", symbol: "ETHUSDT",
  status: "open", patternId: "impulse_buy", entryPrice: 100,
  entryAt: "2026-10-05T00:00:00.000Z", remainingQty: 10, coreQty: 10,
  coreOpen: true, runnerQty: 0, runnerOpen: false, stopPrice: 90,
  runnerStopPrice: null, peakPct: 150, peakPrice: 250 };
const hold = { sourceSignalId: position.sourceSignalId, symbol: position.symbol,
  sourceAction: "hold", sourceLastMilestone: 20, observedAt: at };

test("source follower never invents takes, peak trailing, breakeven or timed exits", () => {
  for (const price of [30, 50, 95, 100, 105, 110, 130, 180, 400]) {
    const result = evaluateSourceFollower(position, hold, price, { observedAt: at });
    assert.deepEqual(result.actions, []);
    assert.equal(result.next.remainingQty, 10);
    assert.equal(result.next.stopPrice, 90);
    assert.equal(result.next.status, "open");
  }
});

test("only a matched fresh explicit source price authorizes a stop update", () => {
  const control = { ...hold, sourceTrailingStopLevel: 115 };
  const result = evaluateSourceFollower(position, control, 125, { observedAt: at });
  assert.deepEqual(result.actions.map(a => [a.type, a.quantity, a.stopPrice]),
    [["raise_stop", 10, 115]]);
  assert.equal(result.next.stopPrice, 115);
  for (const invalid of [
    { ...control, sourceSignalId: "other" }, { ...control, symbol: "BTCUSDT" },
    { ...control, sourceAction: "review" }, { ...control, sourceAction: "unknown" },
    { ...control, observedAt: "2026-10-11T07:10:00.000Z" },
    { ...control, observedAt: null }, null,
  ]) assert.deepEqual(evaluateSourceFollower(position, invalid, 125, { observedAt: at }).actions, []);
});

test("a crossed source stop is not a market-close command and not a fabricated fill", () => {
  const result = evaluateSourceFollower(position,
    { ...hold, sourceTrailingStopLevel: 115 }, 110, { observedAt: at });
  assert.deepEqual(result.actions, []);
  assert.equal(result.next.remainingQty, 10);
  assert.equal(result.next.status, "open");
  assert.equal(result.next.sourceFollower.stopUpdateStatus, "crossed_source_stop_waiting_for_close");
});

test("source updates cannot silently lower native protection", () => {
  assert.deepEqual(evaluateSourceFollower(position,
    { ...hold, sourceTrailingStopLevel: 80 }, 120, { observedAt: at }).actions, []);
});

function committedFixture() {
  const row = { sourceSignalId: position.sourceSignalId, symbol: position.symbol };
  const entryFill = { quantity: "10", price: "100" };
  const closeFill = { quantity: "10", price: "110" };
  const exchangeFlatCheck = { verified: true, positionQuantity: "0", openOrderCount: 0 };
  const event = { ...row, environment: "vst", accountId: "test-vst",
    positionId: "12345", entryOrderId: "12346", closeOrderId: "12347",
    entryFill, closeFill, exchangeFlatCheck };
  const snapshot = { ...row, environment: "vst", accountId: "test-vst", status: "closed",
    remainingQty: 0, coreOpen: false, runnerOpen: false, exchangePositionId: "12345",
    closeReason: "exchange_history_provenance", closeFill,
    exchangeHistoryProvenance: { ...event, verified: true } };
  return { row, record: { ...row, status: "closed", snapshot }, event };
}

test("a matching committed complete exchange close can retire an old source command", () => {
  const { record, row, event } = committedFixture();
  const proof = committedHistoricalCloseProof(record, row, event);
  assert.equal(proof.closureOrigin, "already_committed_exchange_history");
  assert.equal(proof.closeOrderId, "12347");
  assert.equal(proof.flat, true);
});

test("a closed flag or unmatched/partial exchange evidence never acknowledges a source command", () => {
  for (const corrupt of [
    f => { f.record.snapshot.remainingQty = 1; },
    f => { f.event.closeOrderId = "other"; },
    f => { f.row.sourceSignalId = "other"; },
    f => { f.record.snapshot.exchangeHistoryProvenance.verified = false; },
    f => { f.record.snapshot.exchangeHistoryProvenance = null; },
    f => { f.event.accountId = "other"; },
    f => { f.event.closeFill = { quantity: "9", price: "110" }; },
    f => { f.event.exchangeFlatCheck = { verified: true, positionQuantity: 0, openOrderCount: 1 }; },
    f => { f.record.status = "unknown"; },
  ]) {
    const fixture = structuredClone(committedFixture());
    corrupt(fixture);
    assert.equal(committedHistoricalCloseProof(fixture.record, fixture.row, fixture.event), null);
  }
});
