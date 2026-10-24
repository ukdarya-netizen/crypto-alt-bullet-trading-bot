import test from "node:test";
import assert from "node:assert/strict";
import { initialPosition } from "../engine.mjs";
import { startScenarios, observeScenarios } from "../scenario-model.mjs";

const rules = {
  priceMoveBasis: "unleveraged_percent_from_actual_entry_fill",
  rMultipleTargets: false,
  noFixedTakeProfit: true,
  partialProfitAdvice: { execution: "advice_only_not_automated" },
  firstTargetPct: 10,
  firstTargetAction: "milestone_not_full_close",
  breakevenAtPct: 5,
  breakevenStopGainPct: 0,
  protectedProfitAtPct: 10,
  protectedProfitPct: 5,
  trailingActivationPct: 15,
  trailingGapPercentagePoints: 10,
  trailingGapBasis: "percentage_points_of_entry_pnl",
  trailingStopNeverDecreases: true,
  trailingExitAction: "close_remaining_position",
  maxWatchDays: 4,
  expiryExitPrice: "observed_market_quote",
};

function model() {
  const position = initialPosition({
    sourceSignalId: "new-paper-signal",
    patternId: "balanced_grind",
    symbol: "XRPUSDT",
    signalAt: "2026-09-28T00:00:00Z",
    stopLoss: "90",
    payload: { exitRules: rules },
  }, {
    price: 100, quantity: 10, quantityPrecision: 2,
    at: "2026-09-28T00:00:00Z", mode: "paper",
  });
  position.feeModel = { rate: 0.0005 };
  return startScenarios(position);
}

function impulseModel() {
  const position = initialPosition({
    sourceSignalId: "new-impulse-paper-signal",
    patternId: "impulse_buy",
    symbol: "XRPUSDT",
    signalAt: "2026-09-28T00:00:00Z",
    stopLoss: "90",
    payload: { exitRules: { ...rules, runner: {
      policyVersion: "impulse_runner_v1",
      coreFraction: 0.8,
      runnerFraction: 0.2,
      coreExit: "standard_trailing_stop",
      afterCoreEmergencyStop: "original_entry_breakeven",
      trailingActivationPct: 30,
      trailingGapPercentagePoints: 30,
      trailingGapBasis: "percentage_points_of_entry_pnl",
      maxAgeHoursFromOriginalEntry: 120,
      expiryExitPrice: "observed_market_quote",
    } } },
  }, {
    price: 100, quantity: 10, quantityPrecision: 2,
    at: "2026-09-28T00:00:00Z", mode: "paper",
  });
  position.feeModel = { rate: 0.0005 };
  return startScenarios(position);
}

test("partials retain gross profit when the remainder later stops at break-even", () => {
  let state = model();
  state = observeScenarios(state, { price: 105, bid: 105, at: "2026-09-28T01:00:00Z" });
  assert.equal(state.variants["2"].status, "closed");
  assert.deepEqual(state.variants["3"].exits.map((exit) => exit.quantity), [2.5]);
  state = observeScenarios(state, { price: 100, bid: 100, at: "2026-09-28T02:00:00Z" });
  assert.equal(state.variants["3"].status, "closed");
  assert.deepEqual(state.variants["3"].exits.map((exit) => exit.quantity), [2.5, 7.5]);
  assert.equal(state.variants["3"].exits.reduce((sum, exit) => sum + exit.grossUsdt, 0), 12.5);
  assert.ok(state.variants["3"].costUsdt > 0);
  assert.equal(state.variants["4"].status, "closed");
});

test("every entered PAPER trade starts all four independent scenarios", () => {
  for (const state of [model(), impulseModel()]) {
    assert.deepEqual(Object.keys(state.variants), ["1", "2", "3", "4"]);
    for (const variant of Object.values(state.variants)) {
      assert.equal(variant.status, "open");
      assert.equal(variant.position.quantity, 10);
      assert.deepEqual(variant.exits, []);
    }
  }
});

test("classic shadow never adopts strategy 4 takes and preserves its stop", () => {
  let state = observeScenarios(model(), {
    price: 115, bid: 115, at: "2026-09-28T01:00:00Z",
  });
  assert.equal(state.variants["1"].status, "open");
  assert.deepEqual(state.variants["1"].exits, []);
  assert.equal(state.variants["1"].position.remainingQty, 10);
  assert.equal(state.variants["3"].status, "closed");
  state = observeScenarios(state, {
    price: 105, bid: 105, at: "2026-09-28T02:00:00Z",
  });
  assert.equal(state.variants["1"].status, "closed");
  assert.deepEqual(state.variants["1"].exits.map((exit) => exit.quantity), [10]);
  assert.equal(state.variants["1"].exits[0].grossUsdt, 50);
});

test("classic Impulse records both original core and runner without partial takes", () => {
  let state = observeScenarios(impulseModel(), {
    price: 105, bid: 105, at: "2026-09-28T01:00:00Z",
  });
  assert.deepEqual(state.variants["1"].exits, []);
  state = observeScenarios(state, {
    price: 100, bid: 100, at: "2026-09-28T02:00:00Z",
  });
  assert.equal(state.variants["1"].status, "closed");
  assert.deepEqual(state.variants["1"].exits.map((exit) => exit.quantity), [8, 2]);
  assert.equal(state.variants["1"].exits.reduce((sum, exit) => sum + exit.grossUsdt, 0), 0);
});

test("stop before first target does not invent a partial; missing bid stays incomplete", () => {
  const stopped = observeScenarios(model(), { price: 89, bid: 89, at: "2026-09-28T01:00:00Z" });
  assert.equal(stopped.variants["3"].status, "closed");
  assert.deepEqual(stopped.variants["3"].exits.map((exit) => exit.quantity), [10]);
  const unknown = observeScenarios(model(), { price: 105, bid: NaN, at: "2026-09-28T01:00:00Z" });
  assert.equal(unknown.variants["2"].status, "incomplete");
  assert.equal(unknown.variants["3"].status, "incomplete");
});

test("three target steps close original 25/25/50 even on a single sampled quote", () => {
  const state = observeScenarios(model(), { price: 115, bid: 114, at: "2026-09-28T01:00:00Z" });
  assert.deepEqual(state.variants["3"].exits.map((exit) => exit.quantity), [2.5, 2.5, 5]);
  assert.equal(state.variants["3"].status, "closed");
});

test("Impulse runner is protected separately while 25/25/50 still totals original size", () => {
  let state = impulseModel();
  state = observeScenarios(state, { price: 105, bid: 105, at: "2026-09-28T01:00:00Z" });
  assert.equal(state.variants["3"].position.remainingQty, 5.5);
  assert.equal(state.variants["3"].runner.remainingQty, 2);
  state = observeScenarios(state, { price: 100, bid: 100, at: "2026-09-28T02:00:00Z" });
  assert.deepEqual(state.variants["3"].exits.map((exit) => exit.quantity), [2.5, 5.5, 2]);
  assert.equal(state.variants["3"].status, "closed");

  const oneQuote = observeScenarios(impulseModel(), { price: 115, bid: 115, at: "2026-09-28T01:00:00Z" });
  assert.deepEqual(oneQuote.variants["3"].exits.map((exit) => exit.quantity), [2.5, 2.5, 3, 2]);
  assert.equal(oneQuote.variants["3"].status, "closed");
});

test("Impulse scalp keeps all 100% through an entry-price quote until the +5% target", () => {
  let state = impulseModel();
  state = observeScenarios(state, { price: 100, bid: 100, at: "2026-09-28T01:00:00Z" });
  assert.equal(state.variants["2"].status, "open");
  assert.equal(state.variants["2"].runner, null);
  assert.deepEqual(state.variants["2"].exits, []);
  state = observeScenarios(state, { price: 105, bid: 105, at: "2026-09-28T02:00:00Z" });
  assert.equal(state.variants["2"].status, "closed");
  assert.deepEqual(state.variants["2"].exits.map((exit) => exit.quantity), [10]);
  assert.equal(state.variants["2"].exits[0].grossUsdt, 50);
  assert.equal(state.variants["2"].costUsdt, 1.025);
});