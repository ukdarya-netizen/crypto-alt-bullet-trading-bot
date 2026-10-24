import Decimal from "decimal.js";

export const PAPER_STARTING_DEPOSIT_USDT = "100";
export const PAPER_POSITION_RESERVE_USDT = "10";
export const PAPER_MAX_NOTIONAL_USDT = "100";
export const PAPER_SIGNAL_MAX_AGE_MS = 600_000;
export const BULLET_RULES_VERSION = "bullet-long-exits-v2";
export const PAPER_AUTO_EXIT_PATTERNS = new Set([
  "liquidation_cascade", "balanced_grind", "price_led_momentum", "impulse_buy",
]);

type Json = Record<string, unknown>;
function record(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Json, expected: Json): boolean {
  return Object.keys(value).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, item]) => value[key] === item);
}

// Require the exact supported exit policy for all four owner-approved patterns.
// The source example is liquidation_cascade; a matching policy for the others
// can enter PAPER, but this is not proof of their live sender's payload shape.
export function hasExactBulletRules(payload: unknown, patternId?: string, stored = false): boolean {
  if (!record(payload) || !record(payload.exitRules)) return false;
  const { exitRules, relay, relayContractVerified, ...envelope } = payload;
  if (relayContractVerified !== undefined && (!stored || relayContractVerified !== true)) return false;
  if (relay !== undefined && (!stored || !record(relay) || relay.side !== "buy" ||
      relay.orderType !== "market" || relay.reduceOnly !== false)) return false;
  if (!exact(envelope, {
    source: "CryptoAltBullet", rulesVersion: BULLET_RULES_VERSION,
    marginMode: "isolated", leverage: 10, initialMarginUsd: "10",
  })) return false;
  const { runner, partialProfitAdvice, ...common } = exitRules;
  if (!exact(common, {
    priceMoveBasis: "unleveraged_percent_from_actual_entry_fill",
    breakevenAtPct: 5, protectedProfitAtPct: 10, protectedProfitPct: 5,
    trailingActivationPct: 15, trailingGapPercentagePoints: 10,
    maxWatchDays: 4, noFixedTakeProfit: true, rMultipleTargets: false,
    firstTargetAction: "milestone_not_full_close",
    firstTargetPct: 10, expiryExitPrice: "observed_market_quote",
    trailingGapBasis: "percentage_points_of_entry_pnl",
    trailingExitAction: "close_remaining_position",
    breakevenStopGainPct: 0, breakevenIncludesFees: false,
    trailingStopNeverDecreases: true,
  })) return false;
  if (!record(partialProfitAdvice) ||
      !exact(partialProfitAdvice, {
        execution: "advice_only_not_automated", minFraction: 0.2, maxFraction: 0.25,
      })) return false;
  if (patternId === "impulse_buy") {
    return record(runner) && exact(runner, {
      corePct: 80, runnerPct: 20, breakevenStop: "on_open",
      trailingActivationPct: 30, trailingGapPercentagePoints: 30,
      maxHoldHours: 120,
    });
  }
  return runner === undefined;
}

/** Historical PAPER entries were already filled under this recorded v2 policy.
 * Never use it for new intake or queued orders. */
export function hasLegacyPaperRules(payload: unknown): boolean {
  if (!record(payload) || !record(payload.exitRules) ||
      payload.direction !== "LONG" || typeof payload.stopLoss !== "string" ||
      payload.rulesVersion !== BULLET_RULES_VERSION) return false;
  const rules = payload.exitRules;
  return exact(rules, {
    breakEvenAtPercent: 5, btcBreakEvenAtPercent: 1,
    protectFiveAtPercent: 10, trailAtPercent: 15,
    trailDistancePercentagePoints: 10, maxHoldHours: 96,
  });
}

function positive(value: string): Decimal | null {
  try {
    const amount = new Decimal(value);
    return amount.isFinite() && amount.gt(0) && amount.decimalPlaces() <= 12 &&
      amount.lt("1e16") ? amount : null;
  } catch {
    return null;
  }
}

export type PaperIntakeInput = {
  sourceSignalId: string;
  patternId: string;
  symbol: string;
  side: "buy";
  orderType: "market";
  quantity: string;
  limitPrice: string;
  referencePrice: string;
  stopLoss: string;
  reduceOnly: false;
  payload: Json;
  signalAt: Date;
};

export function paperLongEligible(input: PaperIntakeInput) {
  return /^cab-signal-\d+$/.test(input.sourceSignalId) &&
    PAPER_AUTO_EXIT_PATTERNS.has(input.patternId) &&
    /^[A-Z0-9]{2,26}USDT$/.test(input.symbol) &&
    input.side === "buy" && input.orderType === "market" &&
    input.reduceOnly === false && hasExactBulletRules(input.payload, input.patternId);
}

type PaperControls = {
  mode: string;
  acceptingNewEntries: boolean;
  killSwitchActive: boolean;
};

/** Decide once at intake; no legacy entries and no synthesized size or stop. */
export function decidePaperIntake(input: PaperIntakeInput, controls?: PaperControls, now = Date.now()) {
  const blocked = (errorCode: string, errorMessage: string) => ({
    intent: null, errorCode, errorMessage,
  });
  if (!paperLongEligible(input)) {
    return blocked("PAPER_RULES_UNSUPPORTED", "Signal identity, instrument, direction or exit policy is unsupported.");
  }
  const age = now - input.signalAt.getTime();
  if (!Number.isFinite(age) || age < -30_000 || age > PAPER_SIGNAL_MAX_AGE_MS) {
    return blocked("PAPER_SIGNAL_OUTSIDE_WINDOW", "Signal was not within the ten-minute entry window.");
  }
  if (controls?.mode !== "paper") return blocked("PAPER_MODE_INACTIVE", "Only paper mode accepts relay entries.");
  if (!controls.acceptingNewEntries || controls.killSwitchActive) {
    return blocked("PAPER_ENTRIES_PAUSED", "Paper entries were disabled when the signal arrived.");
  }
  const reference = positive(input.referencePrice);
  const limit = positive(input.limitPrice);
  const quantity = positive(input.quantity);
  const stop = positive(input.stopLoss);
  if (!reference || !limit || !quantity || !stop || stop.gte(reference) ||
      stop.gte(limit) || quantity.mul(reference).gt(PAPER_MAX_NOTIONAL_USDT) ||
      quantity.mul(limit).gt(PAPER_MAX_NOTIONAL_USDT)) {
    return blocked("PAPER_INTENT_UNREPRESENTABLE", "Supplied size, reference or protective stop cannot be honored.");
  }
  if (input.patternId === "impulse_buy") {
    const core = quantity.mul("0.8").toDecimalPlaces(12, Decimal.ROUND_DOWN);
    if (core.lte(0) || quantity.minus(core).lte(0)) {
      return blocked("PAPER_INTENT_UNREPRESENTABLE", "Paper quantity cannot be split into core and runner.");
    }
  }
  return {
    intent: {
      side: input.side, orderType: input.orderType, quantity: quantity.toFixed(12),
      limitPrice: limit.toFixed(12), stopLoss: stop.toFixed(12),
    },
    errorCode: null, errorMessage: null,
  };
}