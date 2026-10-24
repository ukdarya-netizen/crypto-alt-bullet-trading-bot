export const VST_POLICY_VERSION = "bullet-long-exits-v2";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SIGNAL_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_FUTURE_SIGNAL_MS = 30 * 1000;
import { isTradablePatternId } from "./pattern-eligibility.mjs";

export const VST_POLICY_THRESHOLDS = Object.freeze({
  ordinary: Object.freeze({
    breakevenPct: 5,
    protectProfitAtPct: 10,
    protectProfitPct: 5,
    trailingActivationPct: 15,
    trailingGapPercentagePoints: 10,
    observationDays: 4,
  }),
  btc: Object.freeze({
    breakevenPct: 1,
    protectProfitAtPct: 10,
    protectProfitPct: 5,
    trailingActivationPct: 15,
    trailingGapPercentagePoints: 10,
    observationDays: 4,
  }),
  impulseRunner: Object.freeze({
    coreFraction: 0.8,
    runnerFraction: 0.2,
    trailingActivationPct: 30,
    trailingGapPercentagePoints: 30,
    maxAgeHours: 120,
  }),
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return number;
}

function timestamp(value, name) {
  const result = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  if (!Number.isFinite(result)) {
    throw new TypeError(`${name} must be a valid date, ISO timestamp, or epoch millisecond`);
  }
  return result;
}

function isBtc(symbol) {
  return symbol === "BTCUSDT" || symbol === "BTC-USDT";
}

function near(value, expected) {
  return typeof value === "number" && Number.isFinite(value) &&
    Math.abs(value - expected) < 1e-8;
}

function validateRules(signal) {
  const rules = signal.payload?.exitRules;
  if (!isObject(rules) ||
      rules.priceMoveBasis !== "unleveraged_percent_from_actual_entry_fill" ||
      rules.noFixedTakeProfit !== true ||
      rules.rMultipleTargets !== false ||
      rules.firstTargetAction !== "milestone_not_full_close" ||
      rules.trailingGapBasis !== "percentage_points_of_entry_pnl" ||
      rules.trailingStopNeverDecreases !== true ||
      rules.trailingExitAction !== "close_remaining_position" ||
      rules.expiryExitPrice !== "observed_market_quote" ||
      rules.breakevenStopGainPct !== 0 ||
      rules.breakevenIncludesFees !== false ||
      rules.maxWatchDays !== 4 ||
      !isObject(rules.partialProfitAdvice) ||
      rules.partialProfitAdvice.execution !== "advice_only_not_automated" ||
      !near(rules.partialProfitAdvice.minFraction, 0.2) ||
      !near(rules.partialProfitAdvice.maxFraction, 0.25)) {
    throw new TypeError("Unsupported VST exit-rule semantics");
  }

  const btc = isBtc(signal.symbol);
  if (btc) {
    if (rules.firstTargetPct !== 10 ||
        rules.breakevenAtPct !== 1 ||
        rules.protectedProfitAtPct !== 10 ||
        rules.protectedProfitPct !== 5 ||
        rules.trailingActivationPct !== 15 ||
        rules.trailingGapPercentagePoints !== 10) {
      throw new TypeError("Unsupported BTC VST exit ladder");
    }
  } else if (rules.firstTargetPct !== 10 ||
      rules.breakevenAtPct !== 5 ||
      rules.protectedProfitAtPct !== 10 ||
      rules.protectedProfitPct !== 5 ||
      rules.trailingActivationPct !== 15 ||
      rules.trailingGapPercentagePoints !== 10) {
    throw new TypeError("Unsupported non-BTC VST exit ladder");
  }

  if (signal.patternId === "impulse_buy") {
    const runner = rules.runner;
    if (!isObject(runner) ||
        runner.policyVersion !== "impulse_runner_v1" ||
        runner.coreExit !== "standard_trailing_stop" ||
        runner.afterCoreEmergencyStop !== "original_entry_breakeven" ||
        !near(runner.coreFraction, 0.8) ||
        !near(runner.runnerFraction, 0.2) ||
        runner.trailingActivationPct !== 30 ||
        runner.trailingGapPercentagePoints !== 30 ||
        runner.trailingGapBasis !== "percentage_points_of_entry_pnl" ||
        runner.maxAgeHoursFromOriginalEntry !== 120 ||
        runner.expiryExitPrice !== "observed_market_quote") {
      throw new TypeError("Unsupported VST impulse runner allocation or policy");
    }
  } else if (Object.hasOwn(rules, "runner")) {
    throw new TypeError("Runner allocation is supported only for impulse_buy");
  }
  return rules;
}

function thresholdProfile(symbol) {
  return isBtc(symbol)
    ? VST_POLICY_THRESHOLDS.btc
    : VST_POLICY_THRESHOLDS.ordinary;
}

function gainPct(entryPrice, price) {
  return ((price - entryPrice) / entryPrice) * 100;
}

function priceForGain(entryPrice, percent) {
  return entryPrice * (1 + percent / 100);
}

function raiseStop(state, leg, proposed, reason, actions) {
  const field = leg === "runner" ? "runnerStopPrice" : "stopPrice";
  if (proposed <= state[field]) return;
  state[field] = proposed;
  actions.push({
    type: "raise_stop",
    leg,
    stopPrice: proposed,
    reason,
  });
}

function closeLeg(state, leg, observedPrice, reason, actions) {
  const qtyField = leg === "runner" ? "runnerQty" : "coreQty";
  const openField = leg === "runner" ? "runnerOpen" : "coreOpen";
  const quantity = state[qtyField];
  if (!state[openField] || quantity <= 0) return;
  state[qtyField] = 0;
  state[openField] = false;
  state.remainingQty = Math.max(0, state.remainingQty - quantity);
  actions.push({ type: leg === "runner" ? "close_runner" : "close_core", leg, quantity,
    price: observedPrice, reason });
  if (state.remainingQty <= 0) {
    state.remainingQty = 0;
    state.status = "closed";
  }
}

function validatePolicyState(state) {
  if (!isObject(state) || state.version !== VST_POLICY_VERSION ||
      !isTradablePatternId(state.patternId)) {
    throw new TypeError("Unsupported VST policy version or pattern");
  }
  if (state.status !== "open") throw new TypeError("VST policy must be open");
  positive(state.entryPrice, "policy.entryPrice");
  positive(state.stopPrice, "policy.stopPrice");
  positive(state.remainingQty, "policy.remainingQty");
  if (typeof state.symbol !== "string" || !state.symbol) {
    throw new TypeError("policy.symbol is required");
  }
  const impulse = state.patternId === "impulse_buy";
  if (impulse) {
    const allocatedQty = state.coreQty + state.runnerQty;
    if (!Number.isFinite(state.coreQty) || state.coreQty < 0 ||
        !Number.isFinite(state.runnerQty) || state.runnerQty < 0 ||
        !near(allocatedQty, state.remainingQty) ||
        (state.coreOpen && state.coreQty <= 0) ||
        (!state.coreOpen && state.coreQty !== 0) ||
        (state.runnerOpen && state.runnerQty <= 0) ||
        (!state.runnerOpen && state.runnerQty !== 0) ||
        (state.coreOpen && state.runnerOpen &&
          (!near(state.coreQty / allocatedQty, 0.8) ||
           !near(state.runnerQty / allocatedQty, 0.2))) ||
        !Number.isFinite(state.runnerStopPrice) ||
        state.runnerStopPrice < state.entryPrice ||
        !Number.isFinite(state.runnerPeakPct) || state.runnerPeakPct < 0) {
      throw new TypeError("Unsupported or invalid VST impulse runner allocation");
    }
  } else if (state.patternId === "impulse_buy" || state.runnerOpen ||
      state.runnerQty !== 0 || state.runnerStopPrice !== null) {
    throw new TypeError("Unsupported VST runner allocation");
  }
  return impulse;
}

/**
 * Initialize the pure VST policy only after a confirmed market-entry fill.
 * `fill.price` is the actual average fill. `signal.stopLoss` is the executable
 * exchange-precision stop, rounded toward entry during sizing when necessary.
 */
export function createVstPolicy({ signal, fill, runnerAllocation } = {}) {
  if (!isObject(signal) || !isObject(fill)) {
    throw new TypeError("signal and confirmed fill are required");
  }
  if (signal.confirmationStatus !== "confirmed" ||
      signal.side !== "buy" ||
      signal.orderType !== "market") {
    throw new TypeError("VST policy requires a fresh confirmed LONG market signal");
  }
  if (!isTradablePatternId(signal.patternId)) {
    throw new TypeError(`Unsupported VST pattern: ${signal.patternId}`);
  }
  if (signal.payload?.rulesVersion !== VST_POLICY_VERSION) {
    throw new TypeError(`Unsupported VST rules version: ${signal.payload?.rulesVersion}`);
  }
  if (typeof signal.symbol !== "string" || !/^[A-Z0-9]+USDT$/.test(signal.symbol)) {
    throw new TypeError("signal.symbol must be a supported USDT market");
  }

  const rules = validateRules(signal);
  const entryPrice = positive(fill.price, "fill.price");
  const quantity = positive(fill.quantity, "fill.quantity");
  const entryAtMs = timestamp(fill.at, "fill.at");
  const signalAtMs = timestamp(signal.signalAt, "signal.signalAt");
  const signalAge = entryAtMs - signalAtMs;
  if (signalAge > SIGNAL_MAX_AGE_MS || signalAge < -MAX_FUTURE_SIGNAL_MS) {
    throw new TypeError("VST signal is stale or future-dated at fill time");
  }
  const stopPrice = positive(signal.stopLoss, "signal.stopLoss");
  if (stopPrice >= entryPrice) {
    throw new TypeError("signal.stopLoss must be below the actual fill price");
  }

  const impulse = signal.patternId === "impulse_buy";
  if (runnerAllocation !== undefined &&
      (!isObject(runnerAllocation) ||
       !near(runnerAllocation.coreFraction, 0.8) ||
       !near(runnerAllocation.runnerFraction, 0.2))) {
    throw new TypeError("Unsupported VST runner allocation; only 80/20 is supported");
  }
  const coreQty = impulse ? quantity * rules.runner.coreFraction : quantity;
  const runnerQty = impulse ? quantity - coreQty : 0;
  if (impulse && (!(coreQty > 0) || !(runnerQty > 0))) {
    throw new TypeError("Confirmed fill quantity cannot support the 80/20 runner allocation");
  }
  const entryAt = new Date(entryAtMs).toISOString();
  return {
    version: VST_POLICY_VERSION,
    status: "open",
    patternId: signal.patternId,
    symbol: signal.symbol,
    entryPrice,
    entryAt,
    signalAt: new Date(signalAtMs).toISOString(),
    quantity,
    remainingQty: quantity,
    stopPrice,
    peakPct: 0,
    coreQty,
    coreOpen: true,
    runnerQty,
    runnerOpen: impulse,
    runnerStopPrice: impulse ? entryPrice : null,
    runnerPeakPct: 0,
    observationWindowNoted: false,
  };
}

/**
 * Propose policy state/actions from one observed market mark. This function
 * never submits exchange orders; returned close/stop actions are advisory.
 */
export function evaluateVstPolicy(policy, { price, at } = {}) {
  const impulse = validatePolicyState(policy);
  const quote = positive(price, "price");
  const now = timestamp(at, "at");
  const entryAtMs = timestamp(policy.entryAt, "policy.entryAt");
  const previousAtMs = policy.observedAt === undefined
    ? entryAtMs
    : timestamp(policy.observedAt, "policy.observedAt");
  if (now < entryAtMs || now < previousAtMs) {
    throw new TypeError("VST mark is stale or earlier than the previous observation");
  }
  const next = { ...policy };
  const actions = [];
  const ageMs = now - entryAtMs;
  const currentGain = gainPct(policy.entryPrice, quote);

  // Existing protection is tested before recording a new peak or proposing
  // higher stops, and all close prices are the observed market price.
  if (policy.coreOpen && quote <= policy.stopPrice) {
    closeLeg(next, "core", quote, "protective_stop", actions);
  }
  if (impulse && policy.runnerOpen && quote <= policy.runnerStopPrice &&
      !(ageMs === 0 && quote === policy.entryPrice)) {
    closeLeg(next, "runner", quote, "runner_stop", actions);
  }
  if (impulse && next.runnerOpen && ageMs >= 120 * HOUR_MS) {
    closeLeg(next, "runner", quote, "runner_max_age_expiry", actions);
  }

  if (next.status === "open" && next.coreOpen &&
      !(policy.coreOpen && quote <= policy.stopPrice)) {
    next.peakPct = Math.max(policy.peakPct, currentGain, 0);
    const thresholds = thresholdProfile(policy.symbol);
    let protectedGain = null;
    let reason = null;
    if (next.peakPct >= thresholds.trailingActivationPct) {
      protectedGain = next.peakPct - thresholds.trailingGapPercentagePoints;
      reason = "percentage_point_trailing_stop";
    } else if (next.peakPct >= thresholds.protectProfitAtPct) {
      protectedGain = thresholds.protectProfitPct;
      reason = "protected_profit_floor";
    } else if (next.peakPct >= thresholds.breakevenPct) {
      protectedGain = 0;
      reason = "breakeven_stop";
    }
    if (protectedGain !== null) {
      const target = priceForGain(policy.entryPrice, protectedGain);
      // A delayed/unconfirmed transfer can leave the exchange stop behind the
      // observed peak. Once the desired floor is crossed, a stop above market
      // is not an executable trailing action: close at the observed quote.
      if (quote <= target) closeLeg(next, "core", quote, reason, actions);
      else raiseStop(next, "core", target, reason, actions);
    }
  }

  if (impulse && next.runnerOpen &&
      !(policy.runnerOpen && quote <= policy.runnerStopPrice &&
        !(ageMs === 0 && quote === policy.entryPrice))) {
    next.runnerPeakPct = Math.max(policy.runnerPeakPct, currentGain, 0);
    if (next.runnerPeakPct >= VST_POLICY_THRESHOLDS.impulseRunner.trailingActivationPct) {
      const protectedGain = next.runnerPeakPct -
        VST_POLICY_THRESHOLDS.impulseRunner.trailingGapPercentagePoints;
      const target = priceForGain(policy.entryPrice, protectedGain);
      if (quote <= target) {
        closeLeg(next, "runner", quote, "runner_percentage_point_trailing_stop", actions);
      } else {
        raiseStop(next, "runner", target, "runner_percentage_point_trailing_stop", actions);
      }
    }
  }

  if (ageMs >= 4 * DAY_MS && !next.observationWindowNoted) {
    next.observationWindowNoted = true;
    actions.push({ type: "observation_window_elapsed", action: "continue_protection" });
  }
  next.observedAt = new Date(now).toISOString();
  return { next, actions, thresholds: thresholdProfile(policy.symbol) };
}