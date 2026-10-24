import { isTradablePatternId, isSupportedSourceLadder } from "./pattern-eligibility.mjs";
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const PAPER_EXIT_POLICY_VERSION = "owner_25_25_50_v1";
const PAPER_STRATEGY_4_POLICY_VERSION = "owner_strategy_4_v1";
const LIVE_STRATEGY_4_PLAN_VERSION = "owner_strategy_4_live_plan_v1";
const PAPER_TARGET_FRACTION = 0.25;
const ARITHMETIC_PRECISION = 12;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finitePositive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return number;
}

function asMillis(value, name) {
  const millis = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new TypeError(`${name} must be a valid date, ISO timestamp, or epoch millisecond`);
  }
  return millis;
}

function isBitcoin(symbol) {
  return symbol === "BTCUSDT" || symbol === "BTC-USDT";
}

function isImpulseAlt(position) {
  return position.patternId === "impulse_buy" && !isBitcoin(position.symbol);
}

function priceAtGain(entryPrice, gainPct) {
  return entryPrice * (1 + gainPct / 100);
}

function quoteGainPct(entryPrice, price) {
  return ((price - entryPrice) / entryPrice) * 100;
}

function quantityPrecision(value) {
  return Number.isInteger(value) && value >= 0 && value <= 12 ? value : 12;
}

function quantityUnits(value, precision) {
  const decimal = String(value).trim().toLowerCase();
  const match = decimal.match(/^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/);
  if (!match) throw new TypeError("quantity must be a finite decimal number");
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? 0);
  const digits = BigInt(`${match[2]}${fraction}` || "0");
  const shift = quantityPrecision(precision) + exponent - fraction.length;
  const units = shift >= 0
    ? digits * 10n ** BigInt(shift)
    : digits / 10n ** BigInt(-shift);
  return match[1] === "-" ? -units : units;
}

function quantityFromUnits(units, precision) {
  const places = quantityPrecision(precision);
  const scale = 10n ** BigInt(places);
  const whole = units / scale;
  const fraction = places
    ? String(units % scale).padStart(places, "0").replace(/0+$/, "")
    : "";
  return Number(fraction ? `${whole}.${fraction}` : whole);
}

function floorQuarterQuantity(value, precision) {
  return quantityFromUnits(quantityUnits(value, precision) / 4n, precision);
}

function floorFifthQuantity(value, precision) {
  return quantityFromUnits(quantityUnits(value, precision) / 5n, precision);
}

function legacyAllocationIsFeasible(position, precision, firstDone, secondDone) {
  const remainingUnits = quantityUnits(position.remainingQty, precision);
  const targetUnits = quantityUnits(position.quantity, precision) / 4n;
  const pendingTargets = (firstDone ? 0n : targetUnits) +
    (secondDone ? 0n : targetUnits);
  if ((!firstDone || !secondDone) && targetUnits <= 0n) return false;
  const unitsAfterTargets = remainingUnits - pendingTargets;
  if (unitsAfterTargets <= 0n) return false;
  if (!isImpulseAlt(position) || !position.coreOpen) return true;
  const runnerUnits = quantityUnits(position.quantity, precision) / 4n;
  return runnerUnits > 0n && unitsAfterTargets - runnerUnits > 0n;
}

function legacyPaperAllocationIsFeasible(position) {
  if (!position || position.mode !== "paper") return true;
  const precision = quantityPrecision(position.paperQuantityPrecision);
  const totalUnits = quantityUnits(position.quantity, precision);
  const targetUnits = totalUnits / 4n;
  if (targetUnits <= 0n) return false;
  if (isImpulseAlt(position)) {
    const runnerUnits = targetUnits;
    const coreUnits = totalUnits - targetUnits * 2n - runnerUnits;
    return runnerUnits > 0n && coreUnits > 0n;
  }
  return totalUnits - targetUnits * 2n > 0n;
}

function strategy4PaperAllocationIsFeasible(position) {
  if (!position || position.mode !== "paper") return true;
  if (position.patternId === "impulse_buy" && isBitcoin(position.symbol)) {
    return false;
  }
  const precision = quantityPrecision(position.paperQuantityPrecision);
  const totalUnits = quantityUnits(position.quantity, precision);
  if (position.patternId === "balanced_grind" ||
      position.patternId === "liquidation_cascade") {
    const trancheUnits = totalUnits / 4n;
    return trancheUnits > 0n && totalUnits - trancheUnits * 2n > 0n;
  }
  if (isImpulseAlt(position)) {
    const runnerUnits = totalUnits / 5n;
    const trancheUnits = totalUnits / 4n;
    const coreAfterTargets = totalUnits - runnerUnits - trancheUnits * 2n;
    return runnerUnits > 0n && trancheUnits > 0n && coreAfterTargets > 0n;
  }
  return true;
}

export function isPaperAllocationFeasible(position) {
  return position?.paperExitPolicy?.version === PAPER_STRATEGY_4_POLICY_VERSION
    ? strategy4PaperAllocationIsFeasible(position)
    : legacyPaperAllocationIsFeasible(position);
}

function paperExitPolicy({
  rules,
  precision,
  precisionSource,
  at,
  legacy = false,
  legacyRunnerSplit = false,
  legacyUnsplittable = false,
}) {
  return {
    version: PAPER_EXIT_POLICY_VERSION,
    scope: "paper_only",
    source: legacy ? "owner_directed_prospective_legacy_adoption" : "owner_directed_override",
    senderContractUnchanged: true,
    status: legacyRunnerSplit
      ? "legacy_runner_split"
      : legacyUnsplittable
        ? "legacy_unsplittable"
        : legacy
          ? "prospective"
          : "active",
    targetPct: rules.firstTargetPct,
    firstTargetPct: rules.firstTargetPct,
    secondTargetPct: rules.firstTargetPct,
    targetBasis: "unleveraged_percent_from_actual_entry_fill",
    firstTargetFraction: PAPER_TARGET_FRACTION,
    secondTargetFraction: PAPER_TARGET_FRACTION,
    ordinaryTrailingRemainderFraction: 0.5,
    impulseCoreTrailingFraction: 0.25,
    impulseRunnerFraction: 0.25,
    quantityPrecision: precision,
    quantityPrecisionSource: precisionSource,
    firstTargetExecuted: false,
    secondTargetExecuted: false,
    adoptedAt: at,
  };
}

function strategy4PaperExitPolicy({ patternId, precision, precisionSource, at }) {
  const impulse = patternId === "impulse_buy";
  return {
    version: PAPER_STRATEGY_4_POLICY_VERSION,
    scope: "paper_only",
    source: impulse ? "owner_directed_impulse_partial_5_10" : "owner_directed_strategy_4",
    senderContractUnchanged: true,
    status: "active",
    mode: patternId === "liquidation_cascade" || patternId === "balanced_grind"
      ? "ladder_25_25_50"
      : impulse ? "impulse_25_25_core_runner" : "classic",
    targetPcts: [5, 10, 15],
    ...(impulse ? { firstTargetPct: 5, secondTargetPct: 10 } : {}),
    targetBasis: "unleveraged_percent_from_actual_entry_fill",
    firstTargetFraction: PAPER_TARGET_FRACTION,
    secondTargetFraction: PAPER_TARGET_FRACTION,
    quantityPrecision: precision,
    quantityPrecisionSource: precisionSource,
    firstTargetExecuted: false,
    secondTargetExecuted: false,
    thirdTargetExecuted: false,
    adoptedAt: at,
  };
}

function strategy4LiveExitPlan({ patternId, rules, precision, precisionSource, at }) {
  const targets = strategy4PaperExitPolicy({ patternId, precision, precisionSource, at });
  return {
    ...targets,
    version: LIVE_STRATEGY_4_PLAN_VERSION,
    scope: "live_plan_only_no_order_execution",
    source: "owner_directed_strategy_4_live_plan",
    status: "blocked_pending_exchange_proof",
    targetPcts: targets.mode === "ladder_25_25_50" ? [5, 10, 15] :
      targets.mode === "impulse_25_25_core_runner" ? [5, 10] : [],
    trailingPlan: {
      coreActivationPct: rules.trailingActivationPct,
      coreGapPercentagePoints: rules.trailingGapPercentagePoints,
      runnerActivationPct: targets.mode === "impulse_25_25_core_runner"
        ? rules.runner.trailingActivationPct : null,
      runnerGapPercentagePoints: targets.mode === "impulse_25_25_core_runner"
        ? rules.runner.trailingGapPercentagePoints : null,
    },
    blockedReason: "partial_fills_and_continuous_stop_protection_not_proven",
  };
}

function preparePaperExitPolicy(position, next, now) {
  if (position.mode !== "paper") return null;
  // Reporting-only classic shadow: do not adopt the executing strategy 4
  // partial-exit policy. All ordinary stop/runner rules still run below.
  if (position.paperExitPolicy?.version === "observed_classic_scenario_v1") {
    next.paperExitPolicy = { ...position.paperExitPolicy };
    return next.paperExitPolicy;
  }
  if (position.paperExitPolicy?.version === PAPER_STRATEGY_4_POLICY_VERSION) {
    next.paperExitPolicy = { ...position.paperExitPolicy };
    if (isImpulseAlt(position) && position.coreOpen &&
        next.paperExitPolicy.mode === "classic") {
      next.paperExitPolicy.mode = "impulse_25_25_core_runner";
      next.paperExitPolicy.firstTargetPct = 5;
      next.paperExitPolicy.secondTargetPct = 10;
      next.paperExitPolicy.source = "owner_directed_impulse_partial_5_10";
      next.paperExitPolicy.impulsePartialAdoptedAt = new Date(now).toISOString();
    }
    if (!strategy4PaperAllocationIsFeasible(position)) {
      next.paperExitPolicy.status = "unsplittable";
    }
    return next.paperExitPolicy;
  }
  if (position.paperExitPolicy?.version === PAPER_EXIT_POLICY_VERSION) {
    next.paperExitPolicy = { ...position.paperExitPolicy };
    if (isImpulseAlt(position) && position.coreOpen &&
        !["legacy_runner_split", "legacy_unsplittable"].includes(next.paperExitPolicy.status) &&
        next.paperExitPolicy.firstTargetPct !== 5) {
      next.paperExitPolicy.targetPct = 5;
      next.paperExitPolicy.firstTargetPct = 5;
      next.paperExitPolicy.secondTargetPct = 10;
      next.paperExitPolicy.source = "owner_directed_impulse_partial_5_10_prospective";
      next.paperExitPolicy.impulsePartialAdoptedAt = new Date(now).toISOString();
    }
    if (
      position.coreOpen &&
      next.paperExitPolicy.status !== "legacy_runner_split" &&
      !isPaperAllocationFeasible(position)
    ) {
      next.paperExitPolicy.status = "legacy_unsplittable";
      next.coreQty = Number(position.remainingQty);
      next.runnerQty = 0;
    }
    return next.paperExitPolicy;
  }

  const legacy = Boolean(position.paperExitPolicy);
  const precision = quantityPrecision(position.paperQuantityPrecision);
  const runnerOnly = isImpulseAlt(position) &&
    position.coreOpen === false && position.runnerOpen === true;
  const policy = paperExitPolicy({
    rules: position.rules,
    precision,
    precisionSource: position.paperQuantityPrecisionSource ??
      "conservative_default_for_legacy_snapshot",
    at: new Date(now).toISOString(),
    legacy: legacy || !position.paperExitPolicy,
    legacyRunnerSplit: runnerOnly,
  });
  policy.source = "owner_directed_prospective_legacy_adoption";
  if (isImpulseAlt(position) && position.coreOpen && !runnerOnly) {
    policy.targetPct = 5;
    policy.firstTargetPct = 5;
    policy.secondTargetPct = 10;
    policy.source = "owner_directed_impulse_partial_5_10_prospective";
    policy.impulsePartialAdoptedAt = new Date(now).toISOString();
  }
  const existingExits = Array.isArray(position.paperFills)
    ? position.paperFills.filter((fill) => fill?.type === "exit")
    : [];
  policy.firstTargetExecuted = existingExits.some(
    (fill) => fill.reason === "first_target_partial",
  );
  policy.secondTargetExecuted = existingExits.some(
    (fill) => fill.reason === "second_target_partial",
  );
  const unsplittable = !runnerOnly &&
    !legacyAllocationIsFeasible(
      position,
      precision,
      policy.firstTargetExecuted,
      policy.secondTargetExecuted,
    );
  if (unsplittable) policy.status = "legacy_unsplittable";
  if (runnerOnly) {
    policy.legacyRunnerQty = position.runnerQty;
    policy.legacyRunnerFraction = Number(position.quantity) > 0
      ? Number(position.runnerQty) / Number(position.quantity)
      : null;
  } else if (isImpulseAlt(position) && unsplittable) {
    next.coreQty = Number(position.remainingQty);
    next.runnerQty = 0;
  } else if (isImpulseAlt(position)) {
    // Existing legacy core/runner positions keep their aggregate quantity;
    // only allocate the still-open remainder prospectively.
    const newRunnerQty = Math.min(
      Number(position.remainingQty),
      floorQuarterQuantity(Number(position.quantity), precision),
    );
    next.runnerQty = newRunnerQty;
    next.coreQty = Number(
      (Number(position.remainingQty) - newRunnerQty).toPrecision(14),
    );
  } else {
    next.coreQty = Number(position.remainingQty);
    next.runnerQty = 0;
  }
  next.paperExitPolicy = policy;
  next.paperQuantityPrecision = precision;
  return policy;
}

function copyPosition(position) {
  return {
    ...position,
    rules: { ...position.rules },
    milestones: { ...position.milestones },
    ...(position.paperExitPolicy
      ? { paperExitPolicy: { ...position.paperExitPolicy } }
      : {}),
    ...(position.liveExitPolicy
      ? { liveExitPolicy: { ...position.liveExitPolicy } }
      : {}),
  };
}

function validateRules(patternId, symbol, rules) {
  if (!isTradablePatternId(patternId)) {
    throw new TypeError(`Unsupported approved pattern: ${patternId}`);
  }
  if (!isObject(rules)) throw new TypeError("signal.payload.exitRules is required");
  if (
    rules.noFixedTakeProfit !== true ||
    rules.rMultipleTargets !== false ||
    rules.firstTargetAction !== "milestone_not_full_close" ||
    rules.priceMoveBasis !== "unleveraged_percent_from_actual_entry_fill" ||
    rules.trailingGapBasis !== "percentage_points_of_entry_pnl" ||
    rules.trailingStopNeverDecreases !== true ||
    rules.trailingExitAction !== "close_remaining_position" ||
    rules.expiryExitPrice !== "observed_market_quote" ||
    rules.partialProfitAdvice?.execution !== "advice_only_not_automated"
  ) {
    throw new TypeError("Unsupported exit-rule semantics");
  }

  const btc = isBitcoin(symbol);
  const positiveFields = [
    "firstTargetPct",
    "breakevenAtPct",
    "trailingActivationPct",
    "trailingGapPercentagePoints",
    "maxWatchDays",
  ];
  for (const field of positiveFields) finitePositive(rules[field], `exitRules.${field}`);
  if (
    typeof rules.protectedProfitAtPct !== "number" ||
    !Number.isFinite(rules.protectedProfitAtPct) ||
    typeof rules.protectedProfitPct !== "number" ||
    !Number.isFinite(rules.protectedProfitPct) ||
    typeof rules.breakevenStopGainPct !== "number" ||
    !Number.isFinite(rules.breakevenStopGainPct)
  ) {
    throw new TypeError("Exit rules contain invalid stop thresholds");
  }

  if (btc) {
    if (
      rules.breakevenAtPct !== 1 ||
      rules.protectedProfitAtPct !== 0 ||
      rules.protectedProfitPct !== 0 ||
      rules.trailingActivationPct !== 2 ||
      rules.trailingGapPercentagePoints !== 1 ||
      rules.progressMilestoneIntervalPct !== 1 ||
      Object.hasOwn(rules, "runner")
    ) {
      throw new TypeError("Unsupported BTC exit ladder");
    }
  } else if (!isSupportedSourceLadder(rules)) {
    throw new TypeError("Unsupported non-BTC exit ladder");
  }

  if (patternId === "impulse_buy" && !btc) {
    const runner = rules.runner;
    if (
      !isObject(runner) ||
      runner.policyVersion !== "impulse_runner_v1" ||
      runner.coreExit !== "standard_trailing_stop" ||
      !Number.isFinite(runner.coreFraction) ||
      Math.abs(runner.coreFraction - 0.8) >= 1e-8 ||
      !Number.isFinite(runner.runnerFraction) ||
      Math.abs(runner.runnerFraction - 0.2) >= 1e-8 ||
      runner.afterCoreEmergencyStop !== "original_entry_breakeven" ||
      runner.trailingActivationPct !== 30 ||
      runner.trailingGapPercentagePoints !== 30 ||
      runner.trailingGapBasis !== "percentage_points_of_entry_pnl" ||
      runner.maxAgeHoursFromOriginalEntry !== 120 ||
      runner.expiryExitPrice !== "observed_market_quote"
    ) {
      throw new TypeError("Unsupported Impulse Buy runner policy");
    }
  } else if (Object.hasOwn(rules, "runner")) {
    throw new TypeError("Runner rules are only supported for non-BTC Impulse Buy");
  }
}

/**
 * Create the persisted position snapshot after an entry fill is confirmed.
 * `price` must be the actual fill, not Bullet's reference price.
 */
export function initialPosition(signal, {
  price,
  quantity,
  at,
  mode,
  quantityPrecision: precision,
  quantityPrecisionSource,
}) {
  if (!isObject(signal)) throw new TypeError("signal must be an object");
  const entryPrice = finitePositive(price, "price");
  const totalQuantity = finitePositive(quantity, "quantity");
  const entryAtMs = asMillis(at, "at");
  if (precision !== undefined &&
      (!Number.isInteger(precision) || precision < 0 || precision > 12)) {
    throw new TypeError("quantityPrecision must be an integer between 0 and 12");
  }
  const actualQuantityPrecision = quantityPrecision(precision);
  if (mode !== "paper" && mode !== "live") {
    throw new TypeError('mode must be "paper" or "live"');
  }

  const rules = signal.payload?.exitRules;
  validateRules(signal.patternId, signal.symbol, rules);
  if (
    mode === "paper" &&
    signal.patternId === "impulse_buy" &&
    isBitcoin(signal.symbol)
  ) {
    throw new TypeError(
      "Strategy 4 PAPER does not support BTC Impulse Buy because its contract has no runner",
    );
  }
  const initialStop = finitePositive(signal.stopLoss, "signal.stopLoss");
  if (initialStop >= entryPrice) {
    throw new TypeError("signal.stopLoss must be below the actual entry fill");
  }

  const splitRunner = signal.patternId === "impulse_buy" && !isBitcoin(signal.symbol);
  let coreQuantity = totalQuantity;
  let runnerQuantity = 0;
  if (splitRunner && mode === "paper") {
    runnerQuantity = floorFifthQuantity(totalQuantity, actualQuantityPrecision);
    coreQuantity = Number((totalQuantity - runnerQuantity).toPrecision(14));
  } else if (splitRunner) {
    coreQuantity = Number((totalQuantity * rules.runner.coreFraction).toPrecision(14));
    runnerQuantity = totalQuantity - coreQuantity;
  }
  const entryAt = new Date(entryAtMs).toISOString();

  const position = {
    sourceSignalId: signal.sourceSignalId,
    symbol: signal.symbol,
    patternId: signal.patternId,
    signalAt: signal.signalAt,
    entryAt,
    entryPrice,
    quantity: totalQuantity,
    remainingQty: totalQuantity,
    coreQty: coreQuantity,
    runnerQty: runnerQuantity,
    stopPrice: initialStop,
    runnerStopPrice: splitRunner && mode === "paper" ? entryPrice : null,
    peakPct: Math.max(0, quoteGainPct(entryPrice, entryPrice)),
    runnerPeakPct: 0,
    coreOpen: true,
    runnerOpen: splitRunner && mode === "paper",
    status: "open",
    mode,
    ...(mode === "paper"
      ? {
          paperQuantityPrecision: actualQuantityPrecision,
          paperQuantityPrecisionSource: quantityPrecisionSource ??
            (precision === undefined ? "conservative_default" : "bingx_contract_metadata"),
        }
      : {}),
    rules: { ...rules },
    milestones: {
      breakevenReached: false,
      firstTargetReached: false,
    },
  };
  if (mode === "paper") {
    position.paperExitPolicy = strategy4PaperExitPolicy({
      patternId: signal.patternId,
      precision: actualQuantityPrecision,
      precisionSource: position.paperQuantityPrecisionSource,
      at: entryAt,
    });
  } else if (signal.patternId !== "impulse_buy" || splitRunner) {
    position.liveExitPolicy = strategy4LiveExitPlan({
      patternId: signal.patternId,
      rules,
      precision: actualQuantityPrecision,
      precisionSource: precision === undefined
        ? "unknown_live_contract_precision" : "exchange_contract_metadata",
      at: entryAt,
    });
  }
  return position;
}

function closeAll(next, quantity, actions, reason, price) {
  actions.push({
    type: "close_all",
    quantity,
    price,
    reason,
  });
  next.remainingQty = 0;
  next.coreOpen = false;
  next.runnerOpen = false;
  next.status = "closed";
}

function handleCoreStop(next, actions, price) {
  if (!isImpulseAlt(next) || !next.runnerOpen) {
    closeAll(next, next.remainingQty, actions, "protective_stop", price);
    return;
  }

  closeAll(next, next.remainingQty, actions, "runner_stop", price);
}

function closeStrategy4ImpulseRunner(next, actions, price, reason) {
  const quantity = Math.min(Number(next.runnerQty), Number(next.remainingQty));
  if (!(quantity > 0)) return;
  actions.push({ type: "close_runner", quantity, price, reason });
  next.remainingQty = Number((next.remainingQty - quantity).toPrecision(14));
  next.runnerQty = 0;
  next.runnerOpen = false;
  if (next.remainingQty <= 0) {
    next.remainingQty = 0;
    next.coreQty = 0;
    next.coreOpen = false;
    next.status = "closed";
  }
}

function closeStrategy4ImpulseCore(next, actions, price) {
  const quantity = Math.min(Number(next.coreQty), Number(next.remainingQty));
  if (!(quantity > 0)) return;
  actions.push({
    type: "close_core",
    quantity,
    price,
    reason: "core_protective_stop",
  });
  next.remainingQty = Number((next.remainingQty - quantity).toPrecision(14));
  next.coreQty = 0;
  next.coreOpen = false;
  if (next.remainingQty <= 0) {
    next.remainingQty = 0;
    next.runnerQty = 0;
    next.runnerOpen = false;
    next.status = "closed";
  }
}

function activateRunnerAfterCore(next, actions, entry, quote, gainPct) {
  next.coreOpen = false;
  next.runnerOpen = true;
  next.runnerPeakPct = Math.max(next.runnerPeakPct, next.peakPct, gainPct, 0);

  // PAPER runner protection starts at the original entry immediately.
  // If the peak was already +30% before core closed, its trailing floor
  // must be active at handover, not one market observation later.
  const runnerRules = next.rules.runner;
  const trailingActive = next.mode === "paper" &&
    next.runnerPeakPct >= runnerRules.trailingActivationPct;
  const protectedGain = trailingActive
    ? Math.max(0, next.runnerPeakPct - runnerRules.trailingGapPercentagePoints)
    : 0;
  const stop = priceAtGain(entry, protectedGain);
  next.runnerStopPrice = stop;

  if (quote <= stop) {
    closeAll(
      next,
      next.remainingQty,
      actions,
      stop > entry ? "runner_stop" : "runner_breakeven_emergency_stop",
      quote,
    );
  } else {
    actions.push({
      type: "raise_stop",
      quantity: next.remainingQty,
      stopPrice: stop,
      reason: trailingActive
        ? "runner_percentage_point_trailing_stop"
        : "runner_breakeven_emergency_stop",
    });
  }
}

/**
 * Compute a proposed state transition for one observed market quote.
 *
 * This is deliberately side-effect-free. The caller must execute every
 * returned action successfully before persisting `next`; on exchange failure,
 * keep the original snapshot and reconcile the actual exchange position first.
 * The caller must also use `price` as the observed market quote for stop/expiry
 * closes rather than treating the stop threshold as a guaranteed fill price.
 */
export function evaluatePosition(position, { price, at }) {
  if (!isObject(position) || position.status !== "open") {
    throw new TypeError("position must be an open position snapshot");
  }
  const next = copyPosition(position);
  const remaining = Number(position.remainingQty);
  if (!Number.isFinite(remaining)) {
    throw new TypeError("position.remainingQty must be finite");
  }
  if (remaining <= 0) {
    if (position.mode !== "paper") {
      throw new TypeError("live open position must have positive remainingQty");
    }
    next.remainingQty = 0;
    next.coreOpen = false;
    next.runnerOpen = false;
    next.status = "closed";
    return { next, actions: [] };
  }
  const quote = finitePositive(price, "price");
  const now = asMillis(at, "at");
  const entry = finitePositive(position.entryPrice, "position.entryPrice");
  const actions = [];
  const gainPct = quoteGainPct(entry, quote);
  const ageMs = now - asMillis(position.entryAt, "position.entryAt");
  if (ageMs < 0) throw new TypeError("at cannot be earlier than the position entry time");

  const impulseAlt = isImpulseAlt(position);
  const paperPolicy = preparePaperExitPolicy(position, next, now);
  const strategy4Paper = paperPolicy?.version === PAPER_STRATEGY_4_POLICY_VERSION;
  // This plan is proposal data only. The live executor must reject every
  // partial/runner action until an exchange-confirmed fill and the remaining
  // stop can be reconciled without any unprotected interval.
  const livePlan = position.mode === "live" &&
    next.liveExitPolicy?.version === LIVE_STRATEGY_4_PLAN_VERSION
    ? next.liveExitPolicy : null;

  // Stops already installed on the exchange are checked first. Do not update
  // the peak on a quote which has already crossed existing protection.
  if (strategy4Paper && impulseAlt) {
    const entryFillObservation = ageMs === 0 &&
      quote === entry &&
      position.runnerStopPrice === entry;
    if (
      position.runnerOpen &&
      quote <= position.runnerStopPrice &&
      !entryFillObservation
    ) {
      closeStrategy4ImpulseRunner(next, actions, quote, "runner_stop");
    }
    const coreStopHit = position.coreOpen && quote <= position.stopPrice;
    if (coreStopHit) {
      closeStrategy4ImpulseCore(next, actions, quote);
    }
    const runnerExpiryDue = ageMs >=
      position.rules.runner.maxAgeHoursFromOriginalEntry * HOUR_MS;
    if (runnerExpiryDue && next.runnerOpen) {
      closeStrategy4ImpulseRunner(next, actions, quote, "runner_max_age_expiry");
    }
    if (
      coreStopHit ||
      actions.some((action) => action.reason === "runner_stop")
    ) {
      return { next, actions };
    }
  } else {
    if (position.coreOpen && quote <= position.stopPrice) {
      if (impulseAlt && paperPolicy?.status === "legacy_unsplittable") {
        closeAll(
          next,
          position.remainingQty,
          actions,
          "legacy_unsplittable_protective_stop",
          quote,
        );
      } else if (impulseAlt) {
        const coreQty = Math.min(next.coreQty, next.remainingQty);
        actions.push({
          type: "close_core",
          quantity: coreQty,
          price: quote,
          reason: "core_protective_stop",
        });
        next.remainingQty = Number((next.remainingQty - coreQty).toPrecision(14));
        activateRunnerAfterCore(next, actions, entry, quote, gainPct);
      } else {
        handleCoreStop(next, actions, quote);
      }
      return { next, actions };
    }

    if (position.runnerOpen && quote <= position.runnerStopPrice) {
      closeAll(next, position.remainingQty, actions, "runner_stop", quote);
      return { next, actions };
    }
  }

  const runnerOnly = impulseAlt && !position.coreOpen && position.runnerOpen;
  const lifetimeMs = strategy4Paper
    ? null
    : runnerOnly
      ? position.rules.runner.maxAgeHoursFromOriginalEntry * HOUR_MS
      : position.rules.maxWatchDays * DAY_MS;
  if (lifetimeMs !== null && ageMs >= lifetimeMs) {
    if (impulseAlt && position.coreOpen) {
      if (paperPolicy?.status === "legacy_unsplittable") {
        closeAll(
          next,
          position.remainingQty,
          actions,
          "legacy_unsplittable_max_watch_expiry",
          quote,
        );
        return { next, actions };
      }
      // The ordinary four-day window belongs to the core. The runner
      // retains its separate 120-hour clock measured from original entry.
      const coreQty = Math.min(next.coreQty, next.remainingQty);
      actions.push({
        type: "close_core",
        quantity: coreQty,
        price: quote,
        reason: "core_max_watch_expiry",
      });
      next.remainingQty = Number((next.remainingQty - coreQty).toPrecision(14));
      activateRunnerAfterCore(next, actions, entry, quote, gainPct);
      return { next, actions };
    }
    closeAll(
      next,
      position.remainingQty,
      actions,
      runnerOnly ? "runner_max_age_expiry" : "max_watch_expiry",
      quote,
    );
    return { next, actions };
  }

  const targetPolicy = strategy4Paper ? paperPolicy : livePlan;
  if (
    targetPolicy &&
    (targetPolicy.status === "active" ||
      (livePlan && targetPolicy.status === "blocked_pending_exchange_proof")) &&
    (targetPolicy.mode === "ladder_25_25_50" ||
      (targetPolicy.mode === "impulse_25_25_core_runner" && impulseAlt)) &&
    next.coreOpen
  ) {
    const precision = targetPolicy.quantityPrecision;
    const requestedTrancheUnits = quantityUnits(
      floorQuarterQuantity(Number(position.quantity), precision),
      precision,
    );
    const ladderMode = targetPolicy.mode === "ladder_25_25_50";
    const targetTranches = ladderMode
      ? livePlan ? [
          ["firstTargetExecuted", 5, "strategy4_live_first_target_partial"],
          ["secondTargetExecuted", 10, "strategy4_live_second_target_partial"],
          ["thirdTargetExecuted", 15, "strategy4_live_final_target_close"],
        ] : [
          ["firstTargetExecuted", 5, "strategy4_first_target_partial"],
          ["secondTargetExecuted", 10, "strategy4_second_target_partial"],
          ["thirdTargetExecuted", 15, "strategy4_final_target_close"],
        ]
      : livePlan ? [
          ["firstTargetExecuted", 5, "strategy4_live_impulse_first_target_partial"],
          ["secondTargetExecuted", 10, "strategy4_live_impulse_second_target_partial"],
        ] : [
          ["firstTargetExecuted", 5, "strategy4_impulse_first_target_partial"],
          ["secondTargetExecuted", 10, "strategy4_impulse_second_target_partial"],
        ];
    for (const [flag, targetPct, reason] of targetTranches) {
      if (targetPolicy[flag] || gainPct + 1e-10 < targetPct) continue;
      const availableCoreUnits = [
        quantityUnits(next.remainingQty, precision),
        quantityUnits(next.coreQty, precision),
      ].reduce((smallest, units) => units < smallest ? units : smallest);
      const quantityUnitsForAction = ladderMode && targetPct === 15
        ? availableCoreUnits
        : requestedTrancheUnits < availableCoreUnits
          ? requestedTrancheUnits
          : availableCoreUnits;
      if (quantityUnitsForAction <= 0n) continue;
      const quantity = quantityFromUnits(quantityUnitsForAction, precision);
      const isFinalTarget = ladderMode && targetPct === 15;
      actions.push({
        type: isFinalTarget ? "close_all" : "close_partial",
        quantity,
        price: quote,
        reason,
      });
      targetPolicy[flag] = true;
      const remainingUnits = quantityUnits(next.remainingQty, precision) -
        quantityUnitsForAction;
      const coreUnits = quantityUnits(next.coreQty, precision) -
        quantityUnitsForAction;
      next.remainingQty = quantityFromUnits(remainingUnits, precision);
      next.coreQty = quantityFromUnits(coreUnits, precision);
      if (isFinalTarget || remainingUnits <= 0n) {
        next.remainingQty = 0;
        next.coreQty = 0;
        next.coreOpen = false;
        next.runnerOpen = false;
        next.runnerQty = 0;
        next.status = "closed";
      }
    }
  }

  if (
    paperPolicy?.version === PAPER_EXIT_POLICY_VERSION &&
    paperPolicy.status !== "legacy_runner_split" &&
    paperPolicy.status !== "legacy_unsplittable" &&
    position.coreOpen
  ) {
    const precision = paperPolicy.quantityPrecision;
    let availableCoreUnits = [
      quantityUnits(next.remainingQty, precision),
      quantityUnits(next.coreQty ?? next.remainingQty, precision),
    ].reduce((smallest, units) => units < smallest ? units : smallest);
    const requestedTrancheUnits = quantityUnits(
      floorQuarterQuantity(Number(position.quantity), precision),
      precision,
    );

    for (const [flag, targetPct, reason] of [
      ["firstTargetExecuted", paperPolicy.firstTargetPct ?? paperPolicy.targetPct, "first_target_partial"],
      ["secondTargetExecuted", paperPolicy.secondTargetPct ?? paperPolicy.targetPct, "second_target_partial"],
    ]) {
      if (paperPolicy[flag] || gainPct + 1e-10 < targetPct) continue;
      const quantityUnitsForAction = requestedTrancheUnits < availableCoreUnits
        ? requestedTrancheUnits
        : availableCoreUnits;
      if (quantityUnitsForAction <= 0n) continue;
      const quantity = quantityFromUnits(quantityUnitsForAction, precision);
      actions.push({
        type: "close_partial",
        quantity,
        price: quote,
        reason,
      });
      paperPolicy[flag] = true;
      availableCoreUnits -= quantityUnitsForAction;
      next.remainingQty = quantityFromUnits(
        quantityUnits(next.remainingQty, ARITHMETIC_PRECISION) -
          quantityUnits(quantity, ARITHMETIC_PRECISION),
        ARITHMETIC_PRECISION,
      );
      next.coreQty = quantityFromUnits(
        quantityUnits(next.coreQty ?? next.remainingQty, ARITHMETIC_PRECISION) -
          quantityUnits(quantity, ARITHMETIC_PRECISION),
        ARITHMETIC_PRECISION,
      );
    }
  }

  next.peakPct = Math.max(position.peakPct, gainPct, 0);
  if (position.runnerOpen) {
    next.runnerPeakPct = Math.max(position.runnerPeakPct, gainPct, 0);
  }
  next.milestones.breakevenReached =
    position.milestones.breakevenReached || next.peakPct >= position.rules.breakevenAtPct;
  next.milestones.firstTargetReached =
    position.milestones.firstTargetReached || next.peakPct >= position.rules.firstTargetPct;

  if (next.coreOpen) {
    const rules = position.rules;
    let protectedGain = null;
    if (next.peakPct >= rules.breakevenAtPct) {
      protectedGain = rules.breakevenStopGainPct;
    }
    if (rules.protectedProfitAtPct > 0 && next.peakPct >= rules.protectedProfitAtPct) {
      protectedGain = Math.max(protectedGain ?? -Infinity, rules.protectedProfitPct);
    }
    if (next.peakPct >= rules.trailingActivationPct) {
      protectedGain = Math.max(
        protectedGain ?? -Infinity,
        next.peakPct - rules.trailingGapPercentagePoints,
      );
    }
    if (protectedGain !== null) {
      const candidate = priceAtGain(entry, protectedGain);
      if (candidate > position.stopPrice) {
        next.stopPrice = candidate;
        actions.push({
          type: "raise_stop",
          quantity: next.coreOpen ? next.coreQty : next.remainingQty,
          stopPrice: candidate,
          reason: next.peakPct >= rules.trailingActivationPct
            ? "percentage_point_trailing_stop"
            : rules.protectedProfitAtPct > 0 &&
                next.peakPct >= rules.protectedProfitAtPct
              ? "protected_profit_floor"
              : "breakeven_stop",
        });
      }
    }
  }

  if (next.runnerOpen) {
    const runnerRules = position.rules.runner;
    let runnerGain = 0;
    if (next.runnerPeakPct >= runnerRules.trailingActivationPct) {
      runnerGain = Math.max(
        0,
        next.runnerPeakPct - runnerRules.trailingGapPercentagePoints,
      );
    }
    const candidate = priceAtGain(entry, runnerGain);
    if (candidate > position.runnerStopPrice) {
      next.runnerStopPrice = candidate;
      actions.push({
        type: "raise_stop",
        quantity: strategy4Paper || livePlan ? next.runnerQty : next.remainingQty,
        stopPrice: candidate,
        reason: next.runnerPeakPct >= runnerRules.trailingActivationPct
          ? "runner_percentage_point_trailing_stop"
          : "runner_breakeven_emergency_stop",
      });
    }
  }

  return { next, actions };
}