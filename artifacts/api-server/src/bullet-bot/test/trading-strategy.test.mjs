import test from "node:test";
import assert from "node:assert/strict";
import { describeTradingStrategy, entryExitStrategy, resolveTradingStrategy } from "../trading-strategy.mjs";

test("the five strategies resolve to an exit and a pattern filter", () => {
  assert.equal(resolveTradingStrategy({ strategy: "follow_cab" }).exitStrategy, "source");
  assert.equal(resolveTradingStrategy({ strategy: "take5" }).exitStrategy, "full_take_5pct");
  assert.equal(resolveTradingStrategy({ strategy: "take8" }).exitStrategy, "full_take_8pct");
  assert.equal(resolveTradingStrategy({ strategy: "take10" }).exitStrategy, "full_take_10pct");
  assert.equal(resolveTradingStrategy({ strategy: "take10" }).allowedPatterns, null);
  const p = resolveTradingStrategy({ strategy: "patterns", patternExit: "take8",
    patterns: "impulse_buy,liquidation_cascade" });
  assert.equal(p.exitStrategy, "full_take_8pct");
  assert.deepEqual([...p.allowedPatterns].sort(), ["impulse_buy", "liquidation_cascade"]);
  assert.match(describeTradingStrategy(p), /По паттернам: Impulse Buy, Liquidation Cascade · Полная фиксация на \+8%/);
  assert.equal(resolveTradingStrategy({ strategy: "patterns", patternExit: "follow_cab",
    patterns: ["stealth_breakout"] }).exitStrategy, "source");
});

test("invalid choices are refused", () => {
  assert.throws(() => resolveTradingStrategy({ strategy: "classic" }), /unknown_strategy/);
  assert.throws(() => resolveTradingStrategy({ strategy: "patterns", patterns: ["impulse_buy"] }),
    /pattern_exit_required/);
  assert.throws(() => resolveTradingStrategy({ strategy: "patterns", patternExit: "take5", patterns: [] }),
    /patterns_must_be_1_to_3_of_4/);
  assert.throws(() => resolveTradingStrategy({ strategy: "patterns", patternExit: "take5",
    patterns: ["stealth_breakout", "neon_support_bounce", "impulse_buy", "liquidation_cascade"] }),
  /patterns_must_be_1_to_3_of_4/);
  assert.throws(() => resolveTradingStrategy({ strategy: "patterns", patternExit: "take5",
    patterns: ["price_led_momentum"] }), /patterns_must_be_1_to_3_of_4/);
});

test("BTC always follows CAB whatever the take strategy", () => {
  assert.equal(entryExitStrategy("full_take_10pct", "BTCUSDT"), "source");
  assert.equal(entryExitStrategy("full_take_10pct", "ETHUSDT"), "full_take_10pct");
  assert.equal(entryExitStrategy("source", "ETHUSDT"), "source");
});
