import { createHash } from "node:crypto";
import { exactDecimalParts } from "./vst-exact-decimal.mjs";

// Owner 2026-10-28: full fixation of the whole position at +5%, +8% or +10%
// price movement from the actual entry. The +5% identifiers are unchanged so
// existing latches, intents and evidence keep validating.
export const FULL_TAKE_5PCT = "full_take_5pct";
export const FULL_TAKE_REASON = "fixed_price_take_profit_5pct";
export const FULL_TAKE_STRATEGIES = Object.freeze({
  full_take_5pct: 5,
  full_take_8pct: 8,
  full_take_10pct: 10,
});

export function isFullTakeStrategy(strategy) {
  return typeof strategy === "string" && Object.hasOwn(FULL_TAKE_STRATEGIES, strategy);
}

/** Take percentage of a full-take strategy, or null. */
export function fullTakePct(strategy) {
  return isFullTakeStrategy(strategy) ? FULL_TAKE_STRATEGIES[strategy] : null;
}

export function fullTakeReason(pct = 5) {
  return `fixed_price_take_profit_${pct}pct`;
}

export function isFullTakeReason(reason) {
  return Object.values(FULL_TAKE_STRATEGIES).some((pct) => fullTakeReason(pct) === reason);
}

function strategyPct(strategy) {
  const pct = fullTakePct(strategy);
  if (pct === null) throw new TypeError(`Not a full-take strategy: ${strategy}`);
  return pct;
}

// Price movement, not ROE, fees, historical peaks, or the sender's entry price.
export function reachedFullTake(entryPrice, price, pct = 5) {
  const entry = exactDecimalParts(entryPrice);
  const current = exactDecimalParts(price);
  if (!entry || !current || entry.units <= 0n || current.units <= 0n) return false;
  if (!Number.isSafeInteger(pct) || pct <= 0) return false;
  const scale = Math.max(entry.scale, current.scale);
  return current.units * 10n ** BigInt(scale - current.scale) * 100n >=
    entry.units * 10n ** BigInt(scale - entry.scale) * BigInt(100 + pct);
}

export function applyFullTake(result, position, price, observedAt, strategy = FULL_TAKE_5PCT) {
  const pct = strategyPct(strategy);
  if (!reachedFullTake(position.entryPrice, price, pct) ||
      !(Number(position.remainingQty) > 0)) return result;
  return {
    next: { ...result.next, exitStrategy: strategy, status: "closed",
      remainingQty: 0, coreQty: 0, runnerQty: 0, coreOpen: false, runnerOpen: false,
      closedAt: observedAt },
    actions: [{ type: "close_all", quantity: Number(position.remainingQty),
      price: Number(price), reason: fullTakeReason(pct) }],
  };
}

export function fullTakeRequestId(sourceSignalId, entryPrice, strategy = FULL_TAKE_5PCT) {
  const pct = strategyPct(strategy);
  const key = pct === 5 ? [sourceSignalId, String(entryPrice)]
    : [sourceSignalId, String(entryPrice), pct];
  return `take${pct}-${createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 32)}`;
}

export function fullTakeRequest(position, mark, now, strategy = FULL_TAKE_5PCT) {
  const pct = strategyPct(strategy);
  const at = Date.parse(mark?.observedAt ?? "");
  if (mark?.verified !== true || position.environment !== "vst" ||
      typeof position.accountId !== "string" || !position.accountId ||
      mark.symbol !== position.symbol ||
      !Number.isFinite(at) || now - at > 10_000 || at > now + 2_000 ||
      !reachedFullTake(position.entryPrice, mark.price, pct)) return null;
  return fullTakeRowFromTouch({
    sourceSignalId: position.sourceSignalId, symbol: position.symbol,
    entryPrice: position.entryPrice, observedPrice: mark.price, observedAt: mark.observedAt,
    strategy,
  });
}

// Rebuilds the exact evidence from a durable touch record (vst_full_take_touched).
// The result is only usable if fullTakeEvidenceValid accepts it.
export function fullTakeRowFromTouch({ sourceSignalId, symbol, entryPrice, observedPrice, observedAt,
  strategy = FULL_TAKE_5PCT }) {
  const pct = strategyPct(strategy);
  const reason = fullTakeReason(pct);
  const requestId = fullTakeRequestId(sourceSignalId, entryPrice, strategy);
  const evidence = {
    reason, rule: strategy, issuer: "executor_policy",
    sourceSignalId, symbol,
    entryPrice: String(entryPrice), observedPrice: String(observedPrice),
    sourceAction: null, sourceStatus: "executor_policy",
    sourceUpdatedAt: observedAt, sourceClosedAt: null, sourceExitPrice: null,
    sourceCancelReason: null, exitDecisionAt: observedAt,
    asOf: observedAt, observedAt,
  };
  return { requestId, sourceSignalId, symbol,
    reason, asOf: evidence.asOf, observedAt: evidence.observedAt, evidence };
}

export function fullTakeEvidenceValid(evidence, sourceSignalId, symbol, requestId) {
  const pct = fullTakePct(evidence?.rule);
  return pct !== null && evidence?.reason === fullTakeReason(pct) &&
    evidence.issuer === "executor_policy" && evidence.sourceSignalId === sourceSignalId &&
    evidence.symbol === symbol && evidence.sourceAction === null &&
    evidence.sourceStatus === "executor_policy" && evidence.sourceClosedAt === null &&
    evidence.sourceExitPrice === null && evidence.sourceCancelReason === null &&
    Number.isFinite(Date.parse(evidence.observedAt)) &&
    evidence.asOf === evidence.observedAt && evidence.exitDecisionAt === evidence.observedAt &&
    evidence.sourceUpdatedAt === evidence.observedAt &&
    reachedFullTake(evidence.entryPrice, evidence.observedPrice, pct) &&
    requestId === fullTakeRequestId(sourceSignalId, evidence.entryPrice, evidence.rule);
}
