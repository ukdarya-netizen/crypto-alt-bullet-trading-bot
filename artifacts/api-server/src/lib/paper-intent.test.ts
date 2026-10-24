import assert from "node:assert/strict";
import { test } from "node:test";
import { EnqueueTradingSignalBody } from "@workspace/api-zod";
import { bulletPayload } from "./bullet-test-fixture";
import { decidePaperIntake, hasExactBulletRules, PAPER_AUTO_EXIT_PATTERNS, PAPER_SIGNAL_MAX_AGE_MS, type PaperIntakeInput } from "./paper-intent";

const now = Date.parse("2026-09-24T12:00:00Z");
const controls = { mode: "paper", acceptingNewEntries: true, killSwitchActive: false };
test("provided liquidation_cascade event validates, but its original timestamp cannot execute", () => {
  const frozen = {
    sourceSignalId: "cab-signal-9924", confirmationStatus: "confirmed",
    patternId: "liquidation_cascade", patternStatus: "approved",
    side: "buy" as const, symbol: "XRPUSDT", orderType: "market" as const,
    reduceOnly: false as const,
    quantity: "67.66815536", referencePrice: "1.4778", limitPrice: "1.4778",
    stopLoss: "1.33002", signalAt: "2026-09-24T12:55:00.504Z",
    payload: bulletPayload(),
  };
  assert.equal(EnqueueTradingSignalBody.safeParse(frozen).success, true);
  assert.equal(hasExactBulletRules(frozen.payload, frozen.patternId), true);
  assert.deepEqual([...PAPER_AUTO_EXIT_PATTERNS],
    ["liquidation_cascade", "balanced_grind", "price_led_momentum", "impulse_buy"]);
  const input = { ...frozen, signalAt: new Date(frozen.signalAt) };
  assert.equal(decidePaperIntake(input, controls,
    Date.parse("2026-09-24T13:05:00.505Z")).errorCode, "PAPER_SIGNAL_OUTSIDE_WINDOW");
  assert.deepEqual(decidePaperIntake(input, controls,
    Date.parse("2026-09-24T12:55:01.504Z")).intent, {
    side: "buy", orderType: "market", quantity: "67.668155360000",
    limitPrice: "1.477800000000", stopLoss: "1.330020000000",
  });
  assert.equal(hasExactBulletRules({ ...frozen.payload, exitRules: {
    ...frozen.payload.exitRules, firstTargetPct: 11,
  } }, frozen.patternId), false);
});
function signal(patternId = "balanced_grind"): PaperIntakeInput {
  return {
    sourceSignalId: "cab-signal-42", patternId, symbol: "ETHUSDT",
    side: "buy", orderType: "market", quantity: "1",
    limitPrice: "100", referencePrice: "100", stopLoss: "94.375",
    reduceOnly: false, payload: bulletPayload(patternId === "impulse_buy"),
    signalAt: new Date(now - 1_000),
  };
}

test("all four supported plans preserve supplied size and stop ($10 margin at 10x)", () => {
  for (const pattern of ["balanced_grind", "liquidation_cascade", "price_led_momentum", "impulse_buy"]) {
    const input = signal(pattern);
    const body = { ...input, confirmationStatus: "confirmed", patternStatus: "approved",
      signalAt: input.signalAt.toISOString() };
    assert.equal(EnqueueTradingSignalBody.safeParse(body).success, true, pattern);
    assert.deepEqual(decidePaperIntake(input, controls, now).intent, {
      side: "buy", orderType: "market", quantity: "1.000000000000",
      limitPrice: "100.000000000000", stopLoss: "94.375000000000",
    });
  }
});

test("fail closed for forbidden patterns, legacy, unknown policy, size and stale timestamp", () => {
  for (const pattern of ["whale_watch", "stealth_breakout", "neon_support_bounce",
    "bullish_accumulation", "unlisted"]) {
    assert.equal(decidePaperIntake(signal(pattern), controls, now).errorCode, "PAPER_RULES_UNSUPPORTED");
  }
  const input = signal();
  assert.equal(hasExactBulletRules({ rulesVersion: "bullet-long-exits-v2" }), false);
  assert.equal(EnqueueTradingSignalBody.safeParse({
    ...input, signalAt: input.signalAt.toISOString(), payload: undefined,
  }).success, false);
  assert.equal(decidePaperIntake({ ...input, payload: {
    ...input.payload, exitRules: { ...(input.payload.exitRules as object), trailingGapPercentagePoints: 5 },
  } }, controls, now).errorCode, "PAPER_RULES_UNSUPPORTED");
  assert.equal(decidePaperIntake({ ...input, quantity: "1.1" }, controls, now).errorCode,
    "PAPER_INTENT_UNREPRESENTABLE");
  assert.equal(PAPER_SIGNAL_MAX_AGE_MS, 600_000);
  assert.equal(decidePaperIntake({ ...input, signalAt: new Date(now - 600_001) }, controls, now).errorCode,
    "PAPER_SIGNAL_OUTSIDE_WINDOW");
  assert.equal(decidePaperIntake({ ...input, signalAt: new Date(now - 599_999) }, controls, now).errorCode, null);
  assert.equal(decidePaperIntake(input, { ...controls, mode: "testnet" }, now).errorCode, "PAPER_MODE_INACTIVE");
  assert.equal(decidePaperIntake(input, { ...controls, acceptingNewEntries: false }, now).errorCode, "PAPER_ENTRIES_PAUSED");
});