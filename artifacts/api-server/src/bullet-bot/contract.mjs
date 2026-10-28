import { createHash, timingSafeEqual } from "node:crypto";
import { isTradablePatternId, isSupportedSourceLadder } from "./pattern-eligibility.mjs";
export const SIGNAL_TTL_MS = 10 * 60_000;

const obj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const approx = (x, y) =>
  typeof x === "number" && Number.isFinite(x) && Math.abs(x - y) < 1e-8;
const positive = (x) =>
  typeof x === "string" && x.trim() !== "" && Number.isFinite(+x) && +x > 0;

export function authorized(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string" || !expected)
    return false;
  const a = createHash("sha256").update(actual).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function reject(status, code, field) {
  return { status, error: { code, field } };
}

/** Strict Bullet v2 wire contract. Never interpret a milestone as a TP order. */
export function validateSignal(s, now = Date.now()) {
  if (!obj(s)) return reject(400, "invalid_payload", "body");
  if (!/^cab-signal-[1-9]\d*$/.test(s.sourceSignalId ?? ""))
    return reject(400, "invalid_signal_id", "sourceSignalId");
  if (s.confirmationStatus !== "confirmed")
    return reject(422, "unconfirmed_signal", "confirmationStatus");
  if (!isTradablePatternId(s.patternId))
    return reject(422, "invalid_pattern_id", "patternId");
  if (
    typeof s.signalAt !== "string" ||
    !/Z$/.test(s.signalAt) ||
    !Number.isFinite(Date.parse(s.signalAt))
  )
    return reject(400, "invalid_timestamp", "signalAt");
  const age = now - Date.parse(s.signalAt);
  if (age > SIGNAL_TTL_MS || age < -30_000)
    return reject(422, "expired_or_future_signal", "signalAt");
  if (typeof s.symbol !== "string" || !/^[A-Z0-9]+USDT$/.test(s.symbol))
    return reject(400, "invalid_symbol", "symbol");
  if (
    s.side !== "buy" ||
    s.orderType !== "market" ||
    s.reduceOnly !== false ||
    Object.hasOwn(s, "takeProfit")
  )
    return reject(422, "unsupported_order", "orderType");
  for (const key of ["quantity", "referencePrice", "limitPrice", "stopLoss"])
    if (!positive(s[key])) return reject(400, "invalid_number", key);
  if (+s.referencePrice !== +s.limitPrice || +s.stopLoss >= +s.referencePrice)
    return reject(422, "invalid_entry_or_stop", "stopLoss");
  const p = s.payload;
  if (
    !obj(p) ||
    p.source !== "CryptoAltBullet" ||
    p.rulesVersion !== "bullet-long-exits-v2" ||
    p.marginMode !== "isolated" ||
    p.initialMarginUsd !== "10" ||
    p.leverage !== 10
  )
    return reject(422, "unsupported_plan", "payload");
  const r = p.exitRules;
  if (
    !obj(r) ||
    r.priceMoveBasis !== "unleveraged_percent_from_actual_entry_fill" ||
    r.noFixedTakeProfit !== true ||
    r.rMultipleTargets !== false ||
    r.firstTargetAction !== "milestone_not_full_close" ||
    r.breakevenStopGainPct !== 0 ||
    r.breakevenIncludesFees !== false ||
    r.trailingGapBasis !== "percentage_points_of_entry_pnl" ||
    r.trailingStopNeverDecreases !== true ||
    r.trailingExitAction !== "close_remaining_position" ||
    r.expiryExitPrice !== "observed_market_quote" ||
    r.maxWatchDays !== 4 ||
    !obj(r.partialProfitAdvice) ||
    r.partialProfitAdvice.execution !== "advice_only_not_automated" ||
    !approx(r.partialProfitAdvice.minFraction, 0.2) ||
    !approx(r.partialProfitAdvice.maxFraction, 0.25)
  )
    return reject(422, "unsupported_exit_rules", "payload.exitRules");
  const btc = s.symbol === "BTCUSDT";
  // Owner 2026-10-28: CAB's ladder is followed for every symbol; only coherence is checked.
  if (!isSupportedSourceLadder(r)) return reject(422, "unsupported_ladder", "payload.exitRules");
  if (!btc && s.patternId === "impulse_buy") {
    const runner = r.runner;
    if (
      !obj(runner) ||
      runner.policyVersion !== "impulse_runner_v1" ||
      runner.coreExit !== "standard_trailing_stop" ||
      !approx(runner.coreFraction, 0.8) ||
      !approx(runner.runnerFraction, 0.2) ||
      runner.afterCoreEmergencyStop !== "original_entry_breakeven" ||
      runner.trailingActivationPct !== 30 ||
      runner.trailingGapPercentagePoints !== 30 ||
      runner.trailingGapBasis !== "percentage_points_of_entry_pnl" ||
      runner.maxAgeHoursFromOriginalEntry !== 120 ||
      runner.expiryExitPrice !== "observed_market_quote"
    )
      return reject(422, "unsupported_runner", "payload.exitRules.runner");
  } else if (Object.hasOwn(r, "runner"))
    return reject(422, "unexpected_runner", "payload.exitRules.runner");
  return { status: 200 };
}