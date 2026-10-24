import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePosition,
  initialPosition,
  isPaperAllocationFeasible,
} from "../engine.mjs";

const ordinaryRules = {
  priceMoveBasis: "unleveraged_percent_from_actual_entry_fill",
  rMultipleTargets: false,
  noFixedTakeProfit: true,
  partialProfitAdvice: {
    minFraction: 0.2,
    maxFraction: 0.25,
    execution: "advice_only_not_automated",
  },
  firstTargetPct: 10,
  firstTargetAction: "milestone_not_full_close",
  breakevenAtPct: 5,
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
};

const btcRules = {
  ...ordinaryRules,
  firstTargetPct: 1,
  breakevenAtPct: 1,
  protectedProfitAtPct: 0,
  protectedProfitPct: 0,
  trailingActivationPct: 2,
  trailingGapPercentagePoints: 1,
  progressMilestoneIntervalPct: 1,
};

const impulseRules = {
  ...ordinaryRules,
  runner: {
    policyVersion: "impulse_runner_v1",
    coreFraction: 0.8,
    runnerFraction: 0.19999999999999996,
    coreExit: "standard_trailing_stop",
    afterCoreEmergencyStop: "original_entry_breakeven",
    trailingActivationPct: 30,
    trailingGapPercentagePoints: 30,
    trailingGapBasis: "percentage_points_of_entry_pnl",
    maxAgeHoursFromOriginalEntry: 120,
    expiryExitPrice: "observed_market_quote",
  },
};

function makeSignal({ patternId = "balanced_grind", symbol = "XRPUSDT", rules = ordinaryRules } = {}) {
  return {
    sourceSignalId: "cab-signal-123",
    confirmationStatus: "confirmed",
    patternId,
    patternStatus: "approved",
    symbol,
    signalAt: "2026-09-25T00:00:00.000Z",
    stopLoss: "90",
    payload: { exitRules: rules },
  };
}

function openPosition(options = {}) {
  return initialPosition(makeSignal(options), {
    price: 100,
    quantity: 10,
    at: "2026-09-25T00:00:00.000Z",
    mode: "paper",
  });
}

function openLegacyPosition(options = {}) {
  const position = openPosition(options);
  position.paperExitPolicy = {
    version: "owner_25_25_50_v1",
    status: "active",
    targetPct: position.rules.firstTargetPct,
    firstTargetPct: position.rules.firstTargetPct,
    secondTargetPct: position.rules.firstTargetPct,
    firstTargetExecuted: false,
    secondTargetExecuted: false,
    quantityPrecision: position.paperQuantityPrecision,
    senderContractUnchanged: true,
  };
  if (position.patternId === "impulse_buy" && !position.symbol.startsWith("BTC")) {
    const scale = 10 ** position.paperQuantityPrecision;
    position.runnerQty = Math.floor(position.quantity * scale / 4) / scale;
    position.coreQty = Number((position.quantity - position.runnerQty).toPrecision(14));
    position.runnerOpen = false;
    position.runnerStopPrice = null;
  }
  return position;
}

test("Strategy 4 ladder closes 25/25/remaining at +5/+10/+15 for the two ladder patterns", () => {
  for (const patternId of ["balanced_grind", "liquidation_cascade"]) {
    const position = openPosition({ patternId });
    const atFive = evaluatePosition(position, {
      price: 105,
      at: "2026-09-25T01:00:00.000Z",
    });

    assert.deepEqual(atFive.actions.map(({ type, quantity, reason }) => [type, quantity, reason]), [
      ["close_partial", 2.5, "strategy4_first_target_partial"],
      ["raise_stop", 7.5, "breakeven_stop"],
    ]);
    assert.equal(atFive.next.stopPrice, 100);
    assert.equal(atFive.next.remainingQty, 7.5);
    assert.equal(atFive.next.paperExitPolicy.version, "owner_strategy_4_v1");
    assert.equal(atFive.next.paperExitPolicy.firstTargetExecuted, true);
    assert.equal(atFive.next.paperExitPolicy.secondTargetExecuted, false);

    const atTen = evaluatePosition(atFive.next, {
      price: 110,
      at: "2026-09-25T02:00:00.000Z",
    });
    assert.deepEqual(atTen.actions.map(({ type, quantity, reason }) => [type, quantity, reason]), [
      ["close_partial", 2.5, "strategy4_second_target_partial"],
      ["raise_stop", 5, "protected_profit_floor"],
    ]);
    assert.equal(atTen.next.remainingQty, 5);
    assert.equal(atTen.next.stopPrice, 105);

    const atFifteen = evaluatePosition(atTen.next, {
      price: 115,
      at: "2026-09-25T03:00:00.000Z",
    });
    assert.deepEqual(atFifteen.actions.map(({ type, quantity, reason }) => [type, quantity, reason]), [
      ["close_all", 5, "strategy4_final_target_close"],
    ]);
    assert.equal(atFifteen.next.status, "closed");
    assert.equal(atFifteen.next.remainingQty, 0);
  }
});

test("persisted owner_25_25_50_v1 positions keep their former +10% two-tranche policy", () => {
  const existing = openLegacyPosition({ patternId: "balanced_grind" });
  const atFive = evaluatePosition(existing, {
    price: 105,
    at: "2026-09-25T01:00:00.000Z",
  });
  assert.equal(atFive.next.paperExitPolicy.version, "owner_25_25_50_v1");
  assert.equal(atFive.next.paperExitPolicy.firstTargetExecuted, false);
  assert.equal(atFive.next.remainingQty, 10);

  const atTen = evaluatePosition(atFive.next, {
    price: 110,
    at: "2026-09-25T02:00:00.000Z",
  });
  assert.equal(atTen.next.paperExitPolicy.version, "owner_25_25_50_v1");
  assert.deepEqual(atTen.actions.filter((action) => action.type === "close_partial").map(
    ({ quantity, reason }) => [quantity, reason],
  ), [
    [2.5, "first_target_partial"],
    [2.5, "second_target_partial"],
  ]);
  assert.equal(atTen.next.remainingQty, 5);
  assert.equal(atTen.next.paperExitPolicy.firstTargetExecuted, true);
});

test("legacy Impulse adopts +5/+10 prospectively without inventing a fill at a past peak", () => {
  const position = openLegacyPosition({
    patternId: "impulse_buy",
    symbol: "ATHUSDT",
    rules: impulseRules,
  });
  position.peakPct = 6.4985;
  position.stopPrice = 100;
  position.milestones.breakevenReached = true;
  const belowFive = evaluatePosition(position, {
    price: 104.93,
    at: "2026-09-25T01:00:00.000Z",
  });
  assert.deepEqual(belowFive.actions, []);
  assert.equal(belowFive.next.paperExitPolicy.firstTargetPct, 5);
  assert.equal(belowFive.next.paperExitPolicy.secondTargetPct, 10);
  assert.equal(belowFive.next.paperExitPolicy.firstTargetExecuted, false);
  assert.equal(belowFive.next.remainingQty, 10);

  const atFive = evaluatePosition(belowFive.next, {
    price: 105.1,
    at: "2026-09-25T02:00:00.000Z",
  });
  assert.deepEqual(atFive.actions.map(({ type, quantity, reason }) => [type, quantity, reason]), [
    ["close_partial", 2.5, "first_target_partial"],
  ]);
  assert.equal(atFive.next.coreQty, 5);
  assert.equal(atFive.next.runnerQty, 2.5);
  assert.equal(atFive.next.paperExitPolicy.firstTargetExecuted, true);
  assert.equal(atFive.next.paperExitPolicy.secondTargetExecuted, false);
  const atTen = evaluatePosition(atFive.next, {
    price: 110,
    at: "2026-09-25T03:00:00.000Z",
  });
  assert.deepEqual(atTen.actions.filter((action) => action.type === "close_partial")
    .map(({ quantity, reason }) => [quantity, reason]), [[2.5, "second_target_partial"]]);
  assert.equal(atTen.next.remainingQty, 5);
  assert.equal(atTen.next.coreQty, 2.5);
  assert.equal(atTen.next.runnerQty, 2.5);
  assert.equal(atTen.next.paperExitPolicy.firstTargetExecuted, true);
  assert.equal(atTen.next.paperExitPolicy.secondTargetExecuted, true);
});

test("adopted Impulse does not replay an existing first take or bypass a protective stop", () => {
  const position = openLegacyPosition({
    patternId: "impulse_buy",
    symbol: "ATHUSDT",
    rules: impulseRules,
  });
  position.stopPrice = 100;
  position.paperExitPolicy.firstTargetExecuted = true;
  position.remainingQty = 7.5;
  position.coreQty = 5;
  position.paperFills = [
    { type: "entry", quantity: 10 },
    { type: "exit", quantity: 2.5, reason: "first_target_partial" },
  ];
  const migrated = evaluatePosition(position, {
    price: 105.5,
    at: "2026-09-25T01:00:00.000Z",
  });
  assert.equal(migrated.next.paperExitPolicy.firstTargetPct, 5);
  assert.equal(migrated.actions.some((action) => action.type === "close_partial"), false);
  const atTen = evaluatePosition(migrated.next, {
    price: 110,
    at: "2026-09-25T02:00:00.000Z",
  });
  assert.deepEqual(atTen.actions.filter((action) => action.type === "close_partial")
    .map(({ quantity, reason }) => [quantity, reason]), [[2.5, "second_target_partial"]]);
  const stopped = evaluatePosition(position, {
    price: 100,
    at: "2026-09-25T03:00:00.000Z",
  });
  assert.equal(stopped.actions.some((action) => action.type === "close_partial"), false);
  assert.equal(stopped.actions[0].reason, "core_protective_stop");
});

test("new Strategy 4 Impulse takes one 25% core tranche at +5 and another at +10", () => {
  const position = openPosition({
    patternId: "impulse_buy",
    symbol: "ATHUSDT",
    rules: impulseRules,
  });
  const atFive = evaluatePosition(position, {
    price: 105,
    at: "2026-09-25T01:00:00.000Z",
  });
  assert.deepEqual(atFive.actions.map(({ type, quantity, reason }) => [type, quantity, reason]), [
    ["close_partial", 2.5, "strategy4_impulse_first_target_partial"],
    ["raise_stop", 5.5, "breakeven_stop"],
  ]);
  assert.equal(atFive.next.runnerQty, 2);
  assert.equal(atFive.next.stopPrice, 100);
  const atTen = evaluatePosition(atFive.next, {
    price: 110,
    at: "2026-09-25T02:00:00.000Z",
  });
  assert.equal(atTen.actions[0].reason, "strategy4_impulse_second_target_partial");
  assert.equal(atTen.next.coreQty, 3);
  assert.equal(atTen.next.runnerQty, 2);
  assert.equal(atTen.next.remainingQty, 5);
  const replay = evaluatePosition(atTen.next, {
    price: 110,
    at: "2026-09-25T03:00:00.000Z",
  });
  assert.equal(replay.actions.some((action) => action.type === "close_partial"), false);
});

test("ordinary trailing stop trails by percentage points and never decreases", () => {
  const position = openPosition({ patternId: "price_led_momentum" });
  assert.equal(position.paperExitPolicy.mode, "classic");
  const first = evaluatePosition(position, {
    price: 124,
    at: "2026-09-25T01:00:00.000Z",
  });
  assert.equal(first.actions.some((action) => action.type.startsWith("close")), false);
  assert.ok(Math.abs(first.next.stopPrice - 114) < 1e-10);
  assert.equal(first.actions.find((action) => action.type === "raise_stop").reason, "percentage_point_trailing_stop");

  const pullback = evaluatePosition(first.next, {
    price: 118,
    at: "2026-09-25T02:00:00.000Z",
  });
  assert.ok(Math.abs(pullback.next.stopPrice - 114) < 1e-10);
  assert.deepEqual(pullback.actions, []);

  const stopped = evaluatePosition(pullback.next, {
    price: 113,
    at: "2026-09-25T03:00:00.000Z",
  });
  assert.equal(stopped.next.status, "closed");
  assert.equal(stopped.next.remainingQty, 0);
  assert.deepEqual(stopped.actions, [
    { type: "close_all", quantity: 10, price: 113, reason: "protective_stop" },
  ]);
});

test("existing stop is checked before a new quote can raise the peak", () => {
  const position = openPosition();
  position.stopPrice = 105;
  const result = evaluatePosition(position, {
    price: 104,
    at: "2026-09-25T01:00:00.000Z",
  });
  assert.equal(result.next.status, "closed");
  assert.equal(result.next.peakPct, 0);
  assert.equal(result.actions[0].reason, "protective_stop");
});

test("BTC keeps +1% breakeven/+2% trailing, with Strategy 4 ladder targets at +5/+10/+15", () => {
  const position = openPosition({
    patternId: "liquidation_cascade",
    symbol: "BTCUSDT",
    rules: btcRules,
  });

  const be = evaluatePosition(position, {
    price: 101,
    at: "2026-09-25T00:01:00.000Z",
  });
  assert.equal(be.next.stopPrice, 100);
  assert.deepEqual(be.actions.map(({ type, reason }) => [type, reason]), [
    ["raise_stop", "breakeven_stop"],
  ]);
  assert.equal(be.next.remainingQty, 10);
  assert.deepEqual(be.next.paperExitPolicy.targetPcts, [5, 10, 15]);

  const trail = evaluatePosition(be.next, {
    price: 102,
    at: "2026-09-25T00:02:00.000Z",
  });
  assert.equal(trail.next.stopPrice, 101);
  assert.equal(trail.actions[0].reason, "percentage_point_trailing_stop");

  const firstTarget = evaluatePosition(trail.next, {
    price: 105,
    at: "2026-09-25T00:03:00.000Z",
  });
  assert.equal(firstTarget.next.remainingQty, 7.5);
  assert.equal(firstTarget.actions[0].reason, "strategy4_first_target_partial");
});

test("Strategy 4 rejects unsupported BTC Impulse PAPER allocations but preserves live and legacy feasibility", () => {
  const btcImpulseSignal = makeSignal({
    patternId: "impulse_buy",
    symbol: "BTCUSDT",
    rules: btcRules,
  });
  assert.throws(() => initialPosition(btcImpulseSignal, {
    price: 100,
    quantity: 10,
    at: "2026-09-25T00:00:00.000Z",
    mode: "paper",
  }), /Strategy 4 PAPER does not support BTC Impulse Buy/);

  const live = initialPosition(btcImpulseSignal, {
    price: 100,
    quantity: 10,
    at: "2026-09-25T00:00:00.000Z",
    mode: "live",
  });
  assert.equal(isPaperAllocationFeasible(live), true);

  const legacy = {
    mode: "paper",
    patternId: "impulse_buy",
    symbol: "BTCUSDT",
    quantity: 10,
    paperQuantityPrecision: 12,
    paperExitPolicy: {
      version: "owner_25_25_50_v1",
    },
  };
  assert.equal(isPaperAllocationFeasible(legacy), true);
  assert.equal(isPaperAllocationFeasible({
    ...legacy,
    paperExitPolicy: { version: "owner_strategy_4_v1" },
  }), false);
});

test("Strategy 4 Impulse keeps an 80% core and 20% break-even runner concurrent", () => {
  const position = openPosition({
    patternId: "impulse_buy",
    symbol: "WAXPUSDT",
    rules: impulseRules,
  });
  assert.equal(position.coreQty, 8);
  assert.equal(position.runnerQty, 2);
  assert.equal(position.runnerOpen, true);
  assert.equal(position.runnerStopPrice, position.entryPrice);
  assert.equal(position.paperExitPolicy.mode, "impulse_25_25_core_runner");

  const runnerStopped = evaluatePosition(position, {
    price: 99,
    at: "2026-09-25T00:30:00.000Z",
  });
  assert.equal(runnerStopped.next.status, "open");
  assert.equal(runnerStopped.next.coreOpen, true);
  assert.equal(runnerStopped.next.runnerOpen, false);
  assert.equal(runnerStopped.next.remainingQty, 8);
  assert.deepEqual(runnerStopped.actions.map(({ type, quantity, reason }) => [
    type, quantity, reason,
  ]), [["close_runner", 2, "runner_stop"]]);

  const coreStopActive = { ...position, stopPrice: 105 };
  const coreStopped = evaluatePosition(coreStopActive, {
    price: 104,
    at: "2026-09-25T00:45:00.000Z",
  });
  assert.equal(coreStopped.next.status, "open");
  assert.equal(coreStopped.next.coreOpen, false);
  assert.equal(coreStopped.next.runnerOpen, true);
  assert.equal(coreStopped.next.remainingQty, 2);
  assert.equal(coreStopped.next.runnerStopPrice, position.entryPrice);
  assert.deepEqual(coreStopped.actions.map(({ type, quantity, reason }) => [
    type, quantity, reason,
  ]), [["close_core", 8, "core_protective_stop"]]);

  const runnerClosesAfterCore = evaluatePosition(coreStopped.next, {
    price: 100,
    at: "2026-09-25T01:00:00.000Z",
  });
  assert.equal(runnerClosesAfterCore.next.status, "closed");
  assert.equal(runnerClosesAfterCore.next.remainingQty, 0);
  assert.equal(runnerClosesAfterCore.actions[0].quantity, 2);
  assert.equal(runnerClosesAfterCore.actions[0].reason, "runner_stop");
});

test("Impulse runner is protected at entry and trails by 30 points after a +30% peak", () => {
  const position = openPosition({
    patternId: "impulse_buy",
    symbol: "WAXPUSDT",
    rules: impulseRules,
  });
  assert.equal(position.runnerOpen, true);
  assert.equal(position.runnerStopPrice, 100);
  const atThreshold = evaluatePosition(position, {
    price: 130,
    at: "2026-09-25T01:00:00.000Z",
  });
  assert.equal(atThreshold.next.runnerStopPrice, 100);
  assert.equal(atThreshold.next.runnerPeakPct, 30);
  assert.equal(atThreshold.next.coreOpen, true);

  const pastThreshold = evaluatePosition(atThreshold.next, {
    price: 160,
    at: "2026-09-25T02:00:00.000Z",
  });
  assert.equal(pastThreshold.next.runnerStopPrice, 130);
  assert.equal(pastThreshold.next.runnerPeakPct, 60);

  const backToEntry = evaluatePosition(pastThreshold.next, {
    price: 130,
    at: "2026-09-25T03:00:00.000Z",
  });
  assert.equal(backToEntry.next.status, "closed");
  assert.equal(backToEntry.next.remainingQty, 0);
  assert.deepEqual(backToEntry.actions.map(({ type, quantity, reason }) => [
    type, quantity, reason,
  ]), [
    ["close_runner", position.runnerQty, "runner_stop"],
    ["close_core", pastThreshold.next.coreQty, "core_protective_stop"],
  ]);
});

test("legacy milestone alone is not a fill; tranches execute only at a fresh target quote", () => {
  const legacy = openPosition();
  delete legacy.paperExitPolicy;
  legacy.peakPct = 12;
  legacy.milestones.firstTargetReached = true;
  legacy.remainingQty = 9;
  legacy.coreQty = 9;
  legacy.paperFills = [
    { type: "entry", quantity: 10 },
    { type: "exit", quantity: 1, reason: "legacy_manual_reduction" },
  ];
  const historicalFills = structuredClone(legacy.paperFills);

  const below = evaluatePosition(legacy, {
    price: 105,
    at: "2026-09-25T01:00:00.000Z",
  });
  assert.equal(below.actions.some((action) => action.type === "close_partial"), false);
  assert.equal(below.next.remainingQty, 9);
  assert.deepEqual(below.next.paperFills, historicalFills);
  assert.equal(below.next.paperExitPolicy.firstTargetExecuted, false);
  assert.equal(below.next.paperExitPolicy.secondTargetExecuted, false);
  assert.equal(below.next.paperExitPolicy.source, "owner_directed_prospective_legacy_adoption");

  const targetNow = evaluatePosition(below.next, {
    price: 110,
    at: "2026-09-25T02:00:00.000Z",
  });
  assert.deepEqual(targetNow.actions.slice(0, 2).map((action) => action.reason), [
    "first_target_partial",
    "second_target_partial",
  ]);
  assert.equal(targetNow.next.remainingQty, 4);
  assert.deepEqual(targetNow.next.paperFills, historicalFills);
  assert.equal(targetNow.next.paperExitPolicy.firstTargetExecuted, true);
  assert.equal(targetNow.next.paperExitPolicy.secondTargetExecuted, true);
});

test("legacy open runner preserves its historical 20% split", () => {
  const legacy = openPosition({
    patternId: "impulse_buy",
    symbol: "WAXPUSDT",
    rules: impulseRules,
  });
  delete legacy.paperExitPolicy;
  legacy.coreOpen = false;
  legacy.runnerOpen = true;
  legacy.coreQty = 0;
  legacy.runnerQty = 2;
  legacy.remainingQty = 2;
  legacy.runnerStopPrice = 100;
  legacy.paperFills = [{ type: "entry", quantity: 10 }];

  const result = evaluatePosition(legacy, {
    price: 110,
    at: "2026-09-25T01:00:00.000Z",
  });
  assert.deepEqual(result.actions, []);
  assert.equal(result.next.remainingQty, 2);
  assert.equal(result.next.runnerQty, 2);
  assert.equal(result.next.coreQty, 0);
  assert.equal(result.next.paperExitPolicy.status, "legacy_runner_split");
  assert.equal(result.next.paperExitPolicy.legacyRunnerFraction, 0.2);
  assert.deepEqual(result.next.paperFills, legacy.paperFills);
});

test("an existing stop or expiry takes priority over coincident target tranches", () => {
  const stopped = openPosition();
  stopped.stopPrice = 110;
  const stopResult = evaluatePosition(stopped, {
    price: 110,
    at: "2026-09-25T01:00:00.000Z",
  });
  assert.deepEqual(stopResult.actions.map((action) => action.reason), ["protective_stop"]);
  assert.equal(stopResult.next.remainingQty, 0);
  assert.equal(stopResult.next.paperExitPolicy.firstTargetExecuted, false);

  const expiring = openLegacyPosition();
  const expiryResult = evaluatePosition(expiring, {
    price: 110,
    at: "2026-09-29T00:00:00.000Z",
  });
  assert.deepEqual(expiryResult.actions.map((action) => action.reason), ["max_watch_expiry"]);
  assert.equal(expiryResult.next.remainingQty, 0);
  assert.equal(expiryResult.next.paperExitPolicy.secondTargetExecuted, false);
});

test("target tranche quantities floor to BingX precision without increasing size", () => {
  const position = initialPosition(makeSignal(), {
    price: 100,
    quantity: 10.037,
    at: "2026-09-25T00:00:00.000Z",
    mode: "paper",
    quantityPrecision: 2,
  });
  const result = evaluatePosition(position, {
    price: 111,
    at: "2026-09-25T01:00:00.000Z",
  });
  assert.deepEqual(result.actions.slice(0, 2).map((action) => action.quantity), [2.5, 2.5]);
  assert.ok(result.actions.every((action) =>
    action.type !== "close_partial" || action.quantity <= position.quantity * 0.25));
  assert.equal(result.next.remainingQty, 5.03);
});

test("decimal contract units preserve an exact 25% tranche and Impulse runner at 1.16", () => {
  const ordinary = initialPosition(makeSignal(), {
    price: 100,
    quantity: 1.16,
    at: "2026-09-25T00:00:00.000Z",
    mode: "paper",
    quantityPrecision: 2,
  });
  const ordinaryTarget = evaluatePosition(ordinary, {
    price: 110,
    at: "2026-09-25T01:00:00.000Z",
  });
  assert.deepEqual(
    ordinaryTarget.actions.slice(0, 2).map((action) => action.quantity),
    [0.29, 0.29],
  );
  assert.equal(ordinaryTarget.next.remainingQty, 0.58);

  const impulse = initialPosition(makeSignal({
    patternId: "impulse_buy",
    symbol: "WAXPUSDT",
    rules: impulseRules,
  }), {
    price: 100,
    quantity: 1.16,
    at: "2026-09-25T00:00:00.000Z",
    mode: "paper",
    quantityPrecision: 2,
  });
  assert.equal(impulse.runnerQty, 0.23);
  assert.equal(impulse.coreQty, 0.93);
  assert.equal(impulse.runnerOpen, true);
  assert.equal(impulse.runnerStopPrice, 100);
  const impulseTarget = evaluatePosition(impulse, {
    price: 110,
    at: "2026-09-25T01:00:00.000Z",
  });
  assert.deepEqual(impulseTarget.actions.filter((action) => action.type === "close_partial")
    .map((action) => [action.quantity, action.reason]), [
      [0.29, "strategy4_impulse_first_target_partial"],
      [0.29, "strategy4_impulse_second_target_partial"],
    ]);
  assert.equal(impulseTarget.next.coreQty, 0.35);
  assert.equal(impulseTarget.next.runnerQty, 0.23);
  assert.equal(impulseTarget.next.remainingQty, 0.58);
});

test("legacy unsplittable Impulse closes all on stop or expiry without a zero-quantity runner", () => {
  const legacyImpulse = () => {
    const position = openPosition({
      patternId: "impulse_buy",
      symbol: "WAXPUSDT",
      rules: impulseRules,
    });
    delete position.paperExitPolicy;
    position.quantity = 3;
    position.remainingQty = 3;
    position.paperQuantityPrecision = 0;
    position.coreQty = 3;
    position.runnerQty = 0;
    return position;
  };

  const stopped = legacyImpulse();
  stopped.stopPrice = 110;
  const stopResult = evaluatePosition(stopped, {
    price: 110,
    at: "2026-09-25T01:00:00.000Z",
  });
  assert.deepEqual(stopResult.actions.map((action) => [
    action.type,
    action.quantity,
    action.reason,
  ]), [["close_all", 3, "legacy_unsplittable_protective_stop"]]);
  assert.equal(stopResult.next.status, "closed");
  assert.equal(stopResult.next.remainingQty, 0);
  assert.equal(stopResult.next.runnerOpen, false);

  const expiring = legacyImpulse();
  const expiryResult = evaluatePosition(expiring, {
    price: 110,
    at: "2026-09-29T00:00:00.000Z",
  });
  assert.deepEqual(expiryResult.actions.map((action) => [
    action.type,
    action.quantity,
    action.reason,
  ]), [["close_all", 3, "legacy_unsplittable_max_watch_expiry"]]);
  assert.equal(expiryResult.next.status, "closed");
  assert.equal(expiryResult.next.remainingQty, 0);
  assert.equal(expiryResult.next.runnerOpen, false);
});

test("an already-zero legacy snapshot is retired without emitting a zero-quantity exit", () => {
  const position = openPosition({
    patternId: "impulse_buy",
    symbol: "WAXPUSDT",
    rules: impulseRules,
  });
  position.remainingQty = 0;
  const result = evaluatePosition(position, {
    price: 100,
    at: "2026-09-25T01:00:00.000Z",
  });
  assert.equal(result.next.status, "closed");
  assert.equal(result.next.remainingQty, 0);
  assert.equal(result.actions.length, 0);
});

test("live Impulse proposes +5/+10 tranches but never treats the plan as a verified fill", () => {
  const live = initialPosition(makeSignal({
    patternId: "impulse_buy",
    symbol: "WAXPUSDT",
    rules: impulseRules,
  }), {
    price: 100,
    quantity: 10,
    at: "2026-09-25T00:00:00.000Z",
    mode: "live",
  });
  assert.equal(live.coreQty, 8);
  assert.equal(live.runnerQty, 2);
  assert.equal(Object.hasOwn(live, "paperExitPolicy"), false);
  assert.equal(Object.hasOwn(live, "paperQuantityPrecision"), false);
  assert.equal(live.liveExitPolicy.scope, "live_plan_only_no_order_execution");
  assert.equal(live.liveExitPolicy.status, "blocked_pending_exchange_proof");
  assert.deepEqual(live.liveExitPolicy.targetPcts, [5, 10]);
  assert.equal(live.liveExitPolicy.trailingPlan.runnerActivationPct, 30);

  const result = evaluatePosition(live, {
    price: 105,
    at: "2026-09-25T01:00:00.000Z",
  });
  assert.deepEqual(result.actions.filter((action) => action.type === "close_partial")
    .map(({ quantity, reason }) => [quantity, reason]), [
      [2.5, "strategy4_live_impulse_first_target_partial"],
    ]);
  assert.equal(result.next.remainingQty, 7.5);
  assert.equal(live.remainingQty, 10);
  assert.equal(live.liveExitPolicy.firstTargetExecuted, false);
  const atTen = evaluatePosition(result.next, {
    price: 110,
    at: "2026-09-25T02:00:00.000Z",
  });
  assert.deepEqual(atTen.actions.filter((action) => action.type === "close_partial")
    .map(({ quantity, reason }) => [quantity, reason]), [
      [2.5, "strategy4_live_impulse_second_target_partial"],
    ]);
  assert.equal(atTen.next.coreQty, 3);
  assert.equal(atTen.next.runnerQty, 2);
});

test("live ladder proposes 25/25/remaining while classic trailing has no automatic take", () => {
  const ladder = initialPosition(makeSignal({ patternId: "balanced_grind" }), {
    price: 100,
    quantity: 10,
    quantityPrecision: 2,
    at: "2026-09-25T00:00:00.000Z",
    mode: "live",
  });
  const mixed = evaluatePosition(ladder, {
    price: 115,
    at: "2026-09-25T01:00:00.000Z",
  });
  assert.deepEqual(mixed.actions.map(({ type, quantity, reason }) => [type, quantity, reason]), [
    ["close_partial", 2.5, "strategy4_live_first_target_partial"],
    ["close_partial", 2.5, "strategy4_live_second_target_partial"],
    ["close_all", 5, "strategy4_live_final_target_close"],
  ]);
  assert.equal(ladder.status, "open");
  assert.equal(ladder.liveExitPolicy.firstTargetExecuted, false);

  const classic = initialPosition(makeSignal({ patternId: "price_led_momentum" }), {
    price: 100,
    quantity: 10,
    at: "2026-09-25T00:00:00.000Z",
    mode: "live",
  });
  assert.deepEqual(classic.liveExitPolicy.targetPcts, []);
  const trailing = evaluatePosition(classic, {
    price: 116,
    at: "2026-09-25T01:00:00.000Z",
  });
  assert.equal(trailing.actions.some((action) => action.type.startsWith("close")), false);
  assert.deepEqual(trailing.actions.filter((action) => action.type === "raise_stop")
    .map(({ stopPrice, reason }) => [stopPrice, reason]), [
      [106, "percentage_point_trailing_stop"],
    ]);
});

test("live Impulse plans core and runner trailing separately, without asserting exchange protection", () => {
  const live = initialPosition(makeSignal({
    patternId: "impulse_buy",
    symbol: "WAXPUSDT",
    rules: impulseRules,
  }), {
    price: 100,
    quantity: 10,
    at: "2026-09-25T00:00:00.000Z",
    mode: "live",
  });
  assert.equal(live.runnerOpen, false);
  assert.equal(live.runnerStopPrice, null);
  // Model only: a real position must not reach this state without an
  // independently verified 20% runner stop and two confirmed partial fills.
  const verifiedHypothesis = {
    ...live,
    remainingQty: 5,
    coreQty: 3,
    runnerOpen: true,
    runnerStopPrice: 100,
    stopPrice: 105,
    peakPct: 10,
    liveExitPolicy: {
      ...live.liveExitPolicy,
      firstTargetExecuted: true,
      secondTargetExecuted: true,
    },
  };
  const proposal = evaluatePosition(verifiedHypothesis, {
    price: 160,
    at: "2026-09-25T01:00:00.000Z",
  });
  assert.deepEqual(proposal.actions.filter((action) => action.type === "raise_stop")
    .map(({ quantity, stopPrice, reason }) => [quantity, stopPrice, reason]), [
      [3, 150, "percentage_point_trailing_stop"],
      [2, 130, "runner_percentage_point_trailing_stop"],
    ]);
  assert.equal(verifiedHypothesis.stopPrice, 105);
  assert.equal(verifiedHypothesis.runnerStopPrice, 100);
});

test("Impulse runner trails by 30 percentage points after +30% peak", () => {
  const initial = openPosition({
    patternId: "impulse_buy",
    symbol: "WAXPUSDT",
    rules: impulseRules,
  });
  const peak = evaluatePosition(initial, {
    price: 140,
    at: "2026-09-25T01:00:00.000Z",
  });
  assert.ok(Math.abs(peak.next.runnerStopPrice - 110) < 1e-10);
  assert.equal(peak.actions.find((action) =>
    action.type === "raise_stop" && action.quantity === initial.runnerQty).reason,
  "runner_percentage_point_trailing_stop");

  const pullback = evaluatePosition(peak.next, {
    price: 120,
    at: "2026-09-25T03:00:00.000Z",
  });
  assert.equal(pullback.next.runnerStopPrice, peak.next.runnerStopPrice);
  assert.equal(pullback.next.runnerOpen, true);
  assert.deepEqual(pullback.actions.map(({ type, reason }) => [type, reason]), [
    ["close_core", "core_protective_stop"],
  ]);
});

test("legacy four-day expiry keeps applying to a position pinned to the old policy", () => {
  const position = openLegacyPosition();
  const result = evaluatePosition(position, {
    price: 97,
    at: "2026-09-29T00:00:00.000Z",
  });
  assert.equal(result.next.status, "closed");
  assert.deepEqual(result.actions, [
    { type: "close_all", quantity: 10, price: 97, reason: "max_watch_expiry" },
  ]);
});

test("runner survives the four-day core window and expires at 120 hours", () => {
  const position = openPosition({
    patternId: "impulse_buy",
    symbol: "WAXPUSDT",
    rules: impulseRules,
  });
  position.coreOpen = false;
  position.runnerOpen = true;
  position.remainingQty = position.runnerQty;
  position.runnerStopPrice = 100;

  const result = evaluatePosition(position, {
    price: 105,
    at: "2026-09-29T20:00:00.000Z",
  });
  assert.equal(result.next.status, "open");
  assert.deepEqual(result.actions, []);

  const expired = evaluatePosition(position, {
    price: 105,
    at: "2026-09-30T00:00:00.000Z",
  });
  assert.equal(expired.next.status, "closed");
  assert.equal(expired.actions[0].reason, "runner_max_age_expiry");
});

test("Strategy 4 never expires the Impulse core at four days and expires its runner at 120 hours", () => {
  const position = openPosition({
    patternId: "impulse_buy",
    symbol: "WAXPUSDT",
    rules: impulseRules,
  });
  const fourDays = evaluatePosition(position, {
    price: 105,
    at: "2026-09-29T00:00:00.000Z",
  });
  assert.equal(fourDays.next.status, "open");
  assert.equal(fourDays.next.coreOpen, true);
  assert.equal(fourDays.next.runnerOpen, true);
  assert.equal(fourDays.actions.some((action) => action.reason.includes("expiry")), false);

  const runnerExpiry = evaluatePosition(fourDays.next, {
    price: 105,
    at: "2026-09-30T00:00:00.000Z",
  });
  assert.equal(runnerExpiry.next.status, "open");
  assert.equal(runnerExpiry.next.coreOpen, true);
  assert.equal(runnerExpiry.next.runnerOpen, false);
  assert.equal(runnerExpiry.next.remainingQty, fourDays.next.coreQty);
  assert.equal(runnerExpiry.actions[0].type, "close_runner");
  assert.equal(runnerExpiry.actions[0].reason, "runner_max_age_expiry");
});

test("Strategy 4 expires the runner with a coincident core stop in one transition", () => {
  const position = openPosition({
    patternId: "impulse_buy",
    symbol: "WAXPUSDT",
    rules: impulseRules,
  });
  position.stopPrice = 105;

  const result = evaluatePosition(position, {
    price: 104,
    at: "2026-09-30T00:00:00.000Z",
  });

  assert.deepEqual(result.actions.map(({ type, quantity, reason }) => [
    type, quantity, reason,
  ]), [
    ["close_core", position.coreQty, "core_protective_stop"],
    ["close_runner", position.runnerQty, "runner_max_age_expiry"],
  ]);
  assert.equal(result.next.status, "closed");
  assert.equal(result.next.remainingQty, 0);
  assert.equal(result.next.coreOpen, false);
  assert.equal(result.next.runnerOpen, false);
});

test("Strategy 4 runner-only expiry still advances the reduced core stop on that quote", () => {
  const position = openPosition({
    patternId: "impulse_buy",
    symbol: "WAXPUSDT",
    rules: impulseRules,
  });

  const result = evaluatePosition(position, {
    price: 140,
    at: "2026-09-30T00:00:00.000Z",
  });

  assert.deepEqual(result.actions.map(({ type, quantity, reason }) => [
    type, quantity, reason,
  ]), [
    ["close_runner", position.runnerQty, "runner_max_age_expiry"],
    ["close_partial", 2.5, "strategy4_impulse_first_target_partial"],
    ["close_partial", 2.5, "strategy4_impulse_second_target_partial"],
    ["raise_stop", 3, "percentage_point_trailing_stop"],
  ]);
  assert.equal(result.next.status, "open");
  assert.equal(result.next.coreOpen, true);
  assert.equal(result.next.runnerOpen, false);
  assert.equal(result.next.remainingQty, 3);
  assert.ok(Math.abs(result.next.stopPrice - 130) < 1e-10);
});

test("initialPosition rejects unsupported rule sets and invalid stop prices", () => {
  assert.throws(
    () => initialPosition(makeSignal({ patternId: "" }), {
      price: 100,
      quantity: 10,
      at: "2026-09-25T00:00:00.000Z",
      mode: "paper",
    }),
    /Unsupported approved pattern/,
  );

  const invalidStop = makeSignal();
  invalidStop.stopLoss = "101";
  assert.throws(
    () => initialPosition(invalidStop, {
      price: 100,
      quantity: 10,
      at: "2026-09-25T00:00:00.000Z",
      mode: "paper",
    }),
    /below the actual entry fill/,
  );
});