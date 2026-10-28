import test from "node:test";
import assert from "node:assert/strict";
import {
  FULL_TAKE_5PCT, FULL_TAKE_REASON, applyFullTake, fullTakeEvidenceValid, fullTakePct,
  fullTakeReason, fullTakeRequest, fullTakeRequestId, isFullTakeReason, isFullTakeStrategy,
  reachedFullTake,
} from "../fixed-price-take-profit.mjs";

test("+5% identifiers are unchanged for existing latches and intents", () => {
  assert.equal(FULL_TAKE_5PCT, "full_take_5pct");
  assert.equal(FULL_TAKE_REASON, "fixed_price_take_profit_5pct");
  assert.equal(fullTakeReason(5), FULL_TAKE_REASON);
  assert.match(fullTakeRequestId("cab-signal-1", "100"), /^take5-[0-9a-f]{32}$/);
  assert.equal(fullTakeRequestId("cab-signal-1", "100"),
    fullTakeRequestId("cab-signal-1", "100", "full_take_5pct"));
});

test("+8 / +10 strategies take at their own percent", () => {
  assert.equal(fullTakePct("full_take_8pct"), 8);
  assert.equal(fullTakePct("full_take_10pct"), 10);
  assert.equal(fullTakePct("source"), null);
  assert.ok(isFullTakeStrategy("full_take_10pct") && !isFullTakeStrategy("full_take_7pct"));
  assert.ok(isFullTakeReason("fixed_price_take_profit_8pct"));
  assert.ok(reachedFullTake("100", "108", 8) && !reachedFullTake("100", "107.99", 8));
  assert.ok(reachedFullTake("100", "110", 10) && !reachedFullTake("100", "109.99", 10));
  const r = applyFullTake({ next: {} }, { entryPrice: "100", remainingQty: 2 }, "108", "t",
    "full_take_8pct");
  assert.equal(r.actions[0].reason, "fixed_price_take_profit_8pct");
  assert.equal(r.next.exitStrategy, "full_take_8pct");
  assert.equal(applyFullTake({ next: {} }, { entryPrice: "100", remainingQty: 2 }, "107", "t",
    "full_take_8pct").actions, undefined);
});

test("+10% evidence validates only with its own request id", () => {
  const now = Date.parse("2026-10-28T12:00:05Z");
  const position = { sourceSignalId: "cab-signal-7", symbol: "ABCUSDT", entryPrice: "2",
    environment: "vst", accountId: "owner" };
  const mark = { verified: true, symbol: "ABCUSDT", price: "2.2", observedAt: "2026-10-28T12:00:00Z" };
  assert.equal(fullTakeRequest(position, { ...mark, price: "2.19" }, now, "full_take_10pct"), null);
  const row = fullTakeRequest(position, mark, now, "full_take_10pct");
  assert.equal(row.reason, "fixed_price_take_profit_10pct");
  assert.ok(fullTakeEvidenceValid(row.evidence, "cab-signal-7", "ABCUSDT", row.requestId));
  assert.ok(!fullTakeEvidenceValid(row.evidence, "cab-signal-7", "ABCUSDT",
    fullTakeRequestId("cab-signal-7", "2")));
});
