import { createHash } from "node:crypto";
import { exactDecimalParts } from "./vst-exact-decimal.mjs";

export const FULL_TAKE_5PCT = "full_take_5pct";
export const FULL_TAKE_REASON = "fixed_price_take_profit_5pct";

// Price movement, not ROE, fees, historical peaks, or the sender's entry price.
export function reachedFullTake(entryPrice, price) {
  const entry = exactDecimalParts(entryPrice);
  const current = exactDecimalParts(price);
  if (!entry || !current || entry.units <= 0n || current.units <= 0n) return false;
  const scale = Math.max(entry.scale, current.scale);
  return current.units * 10n ** BigInt(scale - current.scale) * 100n >=
    entry.units * 10n ** BigInt(scale - entry.scale) * 105n;
}

export function applyFullTake(result, position, price, observedAt) {
  if (!reachedFullTake(position.entryPrice, price) ||
      !(Number(position.remainingQty) > 0)) return result;
  return {
    next: { ...result.next, exitStrategy: FULL_TAKE_5PCT, status: "closed",
      remainingQty: 0, coreQty: 0, runnerQty: 0, coreOpen: false, runnerOpen: false,
      closedAt: observedAt },
    actions: [{ type: "close_all", quantity: Number(position.remainingQty),
      price: Number(price), reason: FULL_TAKE_REASON }],
  };
}

export function fullTakeRequestId(sourceSignalId, entryPrice) {
  return `take5-${createHash("sha256").update(
    JSON.stringify([sourceSignalId, String(entryPrice)])).digest("hex").slice(0, 32)}`;
}

export function fullTakeRequest(position, mark, now) {
  const at = Date.parse(mark?.observedAt ?? "");
  if (mark?.verified !== true || position.environment !== "vst" ||
      typeof position.accountId !== "string" || !position.accountId ||
      mark.symbol !== position.symbol ||
      !Number.isFinite(at) || now - at > 5_000 || at > now + 2_000 ||
      !reachedFullTake(position.entryPrice, mark.price)) return null;
  const requestId = fullTakeRequestId(position.sourceSignalId, position.entryPrice);
  const evidence = {
    reason: FULL_TAKE_REASON, rule: FULL_TAKE_5PCT, issuer: "executor_policy",
    sourceSignalId: position.sourceSignalId, symbol: position.symbol,
    entryPrice: String(position.entryPrice), observedPrice: String(mark.price),
    sourceAction: null, sourceStatus: "executor_policy",
    sourceUpdatedAt: mark.observedAt, sourceClosedAt: null, sourceExitPrice: null,
    sourceCancelReason: null, exitDecisionAt: mark.observedAt,
    asOf: mark.observedAt, observedAt: mark.observedAt,
  };
  return { requestId, sourceSignalId: position.sourceSignalId, symbol: position.symbol,
    reason: FULL_TAKE_REASON, asOf: evidence.asOf, observedAt: evidence.observedAt, evidence };
}

export function fullTakeEvidenceValid(evidence, sourceSignalId, symbol, requestId) {
  return evidence?.reason === FULL_TAKE_REASON && evidence.rule === FULL_TAKE_5PCT &&
    evidence.issuer === "executor_policy" && evidence.sourceSignalId === sourceSignalId &&
    evidence.symbol === symbol && evidence.sourceAction === null &&
    evidence.sourceStatus === "executor_policy" && evidence.sourceClosedAt === null &&
    evidence.sourceExitPrice === null && evidence.sourceCancelReason === null &&
    Number.isFinite(Date.parse(evidence.observedAt)) &&
    evidence.asOf === evidence.observedAt && evidence.exitDecisionAt === evidence.observedAt &&
    evidence.sourceUpdatedAt === evidence.observedAt &&
    reachedFullTake(evidence.entryPrice, evidence.observedPrice) &&
    requestId === fullTakeRequestId(sourceSignalId, evidence.entryPrice);
}
