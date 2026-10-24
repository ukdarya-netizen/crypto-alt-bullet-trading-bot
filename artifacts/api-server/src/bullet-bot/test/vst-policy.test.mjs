import assert from "node:assert/strict";
import test from "node:test";
import {
  createVstPolicy,
  evaluateVstPolicy,
  VST_POLICY_VERSION,
} from "../vst-policy.mjs";

const entryAt = "2026-09-25T00:00:00.000Z";

function exitRules({ btc = false, impulse = false } = {}) {
  return {
    priceMoveBasis: "unleveraged_percent_from_actual_entry_fill",
    noFixedTakeProfit: true,
    rMultipleTargets: false,
    firstTargetAction: "milestone_not_full_close",
    firstTargetPct: 10,
    breakevenAtPct: btc ? 1 : 5,
    breakevenStopGainPct: 0,
    breakevenIncludesFees: false,
    protectedProfitAtPct: 10,
    protectedProfitPct: 5,
    trailingActivationPct: 15,
    trailingGapPercentagePoints: 10,
    trailingGapBasis: "percentage_points_of_entry_pnl",
    trailingStopNeverDecreases: true,
    trailingExitAction: "close_remaining_position",
    maxWatchDays: 4,
    expiryExitPrice: "observed_market_quote",
    partialProfitAdvice: {
      execution: "advice_only_not_automated",
      minFraction: 0.2,
      maxFraction: 0.25,
    },
    ...(impulse ? {
      runner: {
        policyVersion: "impulse_runner_v1",
        coreExit: "standard_trailing_stop",
        coreFraction: 0.8,
        runnerFraction: 0.2,
        afterCoreEmergencyStop: "original_entry_breakeven",
        trailingActivationPct: 30,
        trailingGapPercentagePoints: 30,
        trailingGapBasis: "percentage_points_of_entry_pnl",
        maxAgeHoursFromOriginalEntry: 120,
        expiryExitPrice: "observed_market_quote",
      },
    } : {}),
  };
}

function makeSignal({
  patternId = "balanced_grind",
  symbol = "ETHUSDT",
  rules = exitRules(),
  signalAt = entryAt,
  stopLoss = "90",
  version = VST_POLICY_VERSION,
} = {}) {
  return {
    confirmationStatus: "confirmed",
    patternStatus: "approved",
    side: "buy",
    orderType: "market",
    patternId,
    symbol,
    signalAt,
    stopLoss,
    payload: { rulesVersion: version, exitRules: rules },
  };
}

function makePolicy(options) {
  return createVstPolicy({
    signal: makeSignal(options),
    fill: { price: 100, quantity: 10, at: entryAt },
  });
}

test("BTC uses +1% breakeven and ordinary later protection/trailing thresholds", () => {
  let policy = makePolicy({
    patternId: "balanced_grind",
    symbol: "BTCUSDT",
    rules: exitRules({ btc: true }),
  });
  const be = evaluateVstPolicy(policy, { price: 101, at: "2026-09-25T01:00:00Z" });
  assert.equal(be.next.stopPrice, 100);
  assert.deepEqual(be.actions.map(({ type, reason }) => [type, reason]), [
    ["raise_stop", "breakeven_stop"],
  ]);

  const protect = evaluateVstPolicy(be.next, { price: 110, at: "2026-09-25T02:00:00Z" });
  assert.equal(protect.next.stopPrice, 105);
  const trail = evaluateVstPolicy(protect.next, { price: 124, at: "2026-09-25T03:00:00Z" });
  assert.ok(Math.abs(trail.next.stopPrice - 114) < 1e-10);
  assert.equal(trail.actions[0].reason, "percentage_point_trailing_stop");
});

test("BTC rejects legacy non-doc exit thresholds and supports the independent impulse runner", () => {
  const contradictoryLegacyRules = {
    ...exitRules({ btc: true }),
    firstTargetPct: 1,
    protectedProfitAtPct: 0,
    protectedProfitPct: 0,
    trailingActivationPct: 2,
    trailingGapPercentagePoints: 1,
    progressMilestoneIntervalPct: 1,
  };
  assert.throws(() => makePolicy({
    patternId: "balanced_grind",
    symbol: "BTCUSDT",
    rules: contradictoryLegacyRules,
  }), /Unsupported BTC VST exit ladder/);

  const impulse = makePolicy({
    patternId: "impulse_buy",
    symbol: "BTCUSDT",
    rules: exitRules({ btc: true, impulse: true }),
  });
  assert.equal(impulse.coreQty, 8);
  assert.equal(impulse.runnerQty, 2);
  assert.equal(impulse.stopPrice, 90);
  assert.equal(impulse.runnerStopPrice, 100);
});

test("confirmed impulse fill allocates 80/20 with runner breakeven immediately", () => {
  const policy = makePolicy({
    patternId: "impulse_buy",
    rules: exitRules({ impulse: true }),
  });
  assert.equal(policy.stopPrice, 90);
  assert.equal(policy.coreQty, 8);
  assert.equal(policy.runnerQty, 2);
  assert.equal(policy.runnerStopPrice, 100);
  assert.equal(policy.runnerOpen, true);
});

test("core and runner use independent trailing rules; runner expires at 120h", () => {
  const initial = makePolicy({
    patternId: "impulse_buy",
    rules: exitRules({ impulse: true }),
  });
  const peak = evaluateVstPolicy(initial, { price: 150, at: "2026-09-25T01:00:00Z" });
  assert.equal(peak.next.stopPrice, 140);
  assert.equal(peak.next.runnerStopPrice, 120);
  const expired = evaluateVstPolicy(peak.next, {
    price: 145,
    at: "2026-09-30T00:00:00Z",
  });
  assert.equal(expired.next.runnerOpen, false);
  assert.equal(expired.next.coreOpen, true);
  assert.equal(expired.next.remainingQty, 8);
  assert.deepEqual(expired.actions.filter(({ type }) => type === "close_runner")
    .map(({ type, reason, price }) => [type, reason, price]), [
    ["close_runner", "runner_max_age_expiry", 145],
  ]);
});

test("trailing stop only rises when a later peak is higher", () => {
  const start = makePolicy();
  const peak = evaluateVstPolicy(start, { price: 130, at: "2026-09-25T01:00:00Z" });
  assert.equal(peak.next.stopPrice, 120);
  const pullback = evaluateVstPolicy(peak.next, { price: 125, at: "2026-09-25T02:00:00Z" });
  assert.equal(pullback.next.stopPrice, 120);
  assert.deepEqual(pullback.actions, []);
  const newPeak = evaluateVstPolicy(pullback.next, { price: 140, at: "2026-09-25T03:00:00Z" });
  assert.equal(newPeak.next.stopPrice, 130);
});

test("a missed stop transfer closes when the observed quote crosses the peak-derived floor", () => {
  const start = { ...makePolicy(), peakPct: 25, stopPrice: 105 };
  const result = evaluateVstPolicy(start, { price: 114, at: "2026-09-25T02:00:00Z" });
  assert.equal(result.next.status, "closed");
  assert.equal(result.next.remainingQty, 0);
  assert.deepEqual(result.actions.map(action => [action.type, action.reason, action.price]), [
    ["close_core", "percentage_point_trailing_stop", 114],
  ]);
  assert.equal(start.stopPrice, 105, "the old exchange stop is not rewritten as a modeled fill");
});

test("a delayed profit-floor transfer exits at the current quote, never at a historic target", () => {
  const start = { ...makePolicy(), peakPct: 11, stopPrice: 90 };
  const result = evaluateVstPolicy(start, { price: 104, at: "2026-09-25T02:00:00Z" });
  assert.equal(result.actions[0].type, "close_core");
  assert.equal(result.actions[0].reason, "protected_profit_floor");
  assert.equal(result.actions[0].price, 104);
});

test("the independent runner also exits when its missed peak-derived transfer is crossed", () => {
  const start = { ...makePolicy({ patternId: "impulse_buy", rules: exitRules({ impulse: true }) }),
    runnerPeakPct: 40, runnerStopPrice: 100 };
  const result = evaluateVstPolicy(start, { price: 109, at: "2026-09-25T02:00:00Z" });
  const exit = result.actions.find(action => action.type === "close_runner");
  assert.equal(exit.reason, "runner_percentage_point_trailing_stop");
  assert.equal(exit.price, 109);
  assert.equal(result.next.runnerOpen, false);
});

test("four-day ordinary window is observation only; no automatic partial or close", () => {
  const start = makePolicy();
  const result = evaluateVstPolicy(start, {
    price: 102,
    at: "2026-09-29T00:00:00Z",
  });
  assert.equal(result.next.status, "open");
  assert.equal(result.next.remainingQty, 10);
  assert.equal(result.next.stopPrice, 90);
  assert.deepEqual(result.actions, [{
    type: "observation_window_elapsed",
    action: "continue_protection",
  }]);
  assert.equal(result.actions.some(({ type }) => type.includes("partial")), false);
});

test("rejects malformed pattern/version, invalid stop, stale signal, and unsupported runner split", () => {
  assert.throws(() => makePolicy({ patternId: "" }), /Unsupported VST pattern/);
  assert.throws(() => makePolicy({ version: "unknown-v3" }), /Unsupported VST rules version/);
  assert.throws(() => makePolicy({ stopLoss: "100" }), /below the actual fill/);
  assert.throws(() => createVstPolicy({
    signal: makeSignal({ signalAt: "2026-09-25T00:11:00Z" }),
    fill: { price: 100, quantity: 10, at: entryAt },
  }), /stale or future-dated/);
  assert.throws(() => createVstPolicy({
    signal: makeSignal({ patternId: "impulse_buy", rules: exitRules({ impulse: true }) }),
    fill: { price: 100, quantity: 10, at: entryAt },
    runnerAllocation: { coreFraction: 0.75, runnerFraction: 0.25 },
  }), /Unsupported VST runner allocation/);
  const invalidRunnerRules = exitRules({ impulse: true });
  invalidRunnerRules.runner.runnerFraction = 0.25;
  assert.throws(() => makePolicy({
    patternId: "impulse_buy",
    rules: invalidRunnerRules,
  }), /Unsupported VST impulse runner allocation/);
});

test("invalid and out-of-order marks are rejected without mutating the input", () => {
  const policy = makePolicy();
  const snapshot = structuredClone(policy);
  assert.throws(() => evaluateVstPolicy(policy, {
    price: 0, at: "2026-09-25T01:00:00Z",
  }), /positive finite/);
  const next = evaluateVstPolicy(policy, {
    price: 105, at: "2026-09-25T01:00:00Z",
  }).next;
  assert.throws(() => evaluateVstPolicy(next, {
    price: 106, at: "2026-09-25T00:30:00Z",
  }), /stale or earlier/);
  assert.deepEqual(policy, snapshot);
});