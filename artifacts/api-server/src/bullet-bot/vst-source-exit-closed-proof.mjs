import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import Decimal from "decimal.js";

const id = (value) => typeof value === "string" && value.trim() === value &&
  value.length > 0 ? value : null;
const equalDecimal = (left, right) => {
  try {
    if (!["number", "string"].includes(typeof left) ||
        !["number", "string"].includes(typeof right)) return false;
    const a = new Decimal(left), b = new Decimal(right);
    return a.isFinite() && b.isFinite() && a.eq(b);
  } catch { return false; }
};

/** A previously committed complete native lifecycle retires only its old
 * source command. It does not authorize a new exchange action. */
export function committedHistoricalCloseProof(record, row, event) {
  const s = record?.snapshot, h = s?.exchangeHistoryProvenance;
  if (record?.status !== "closed" || s?.status !== "closed" ||
      record.sourceSignalId !== row?.sourceSignalId ||
      s.sourceSignalId !== row.sourceSignalId ||
      record.symbol !== row.symbol || s.symbol !== row.symbol ||
      s.environment !== "vst" || !id(s.accountId) ||
      s.closeReason !== "exchange_history_provenance" ||
      h?.verified !== true || h.environment !== "vst" ||
      h.accountId !== s.accountId || h.symbol !== row.symbol ||
      h.positionId !== s.exchangePositionId ||
      !id(h.entryOrderId) || !id(h.closeOrderId) ||
      !equalDecimal(s.remainingQty, 0) ||
      s.coreOpen === true || s.runnerOpen === true ||
      !equalDecimal(h.entryFill?.quantity, h.closeFill?.quantity) ||
      h.exchangeFlatCheck?.verified !== true ||
      !equalDecimal(h.exchangeFlatCheck.positionQuantity, 0) ||
      h.exchangeFlatCheck.openOrderCount !== 0 ||
      event?.sourceSignalId !== row.sourceSignalId ||
      event.symbol !== row.symbol || event.accountId !== s.accountId ||
      event.entryOrderId !== h.entryOrderId ||
      event.closeOrderId !== h.closeOrderId ||
      !isDeepStrictEqual(event.entryFill, h.entryFill) ||
      !isDeepStrictEqual(event.closeFill, h.closeFill) ||
      !isDeepStrictEqual(event.exchangeFlatCheck, h.exchangeFlatCheck) ||
      !isDeepStrictEqual(s.closeFill, h.closeFill)) return null;
  return {
    closureOrigin: "already_committed_exchange_history",
    entryOrderId: h.entryOrderId, closeOrderId: h.closeOrderId,
    positionId: h.positionId, fill: h.closeFill,
    flat: true, noOpenStops: true,
  };
}

/** Retire only the queue command, not a position or an exchange order.
 * A status flag/flat account alone is insufficient: require the committed
 * exact stop-child fill, zero residual and no surviving stops. */
export async function readCommittedStopCloseProof(store, record, row) {
  const s = record?.snapshot;
  const parentId = id(s?.triggeredStop?.parentStopId);
  const childId = id(s?.triggeredStop?.childOrderId);
  const positionId = id(s?.exchangePositionId);
  if (record?.status !== "closed" || s?.status !== "closed" ||
      record.sourceSignalId !== row.sourceSignalId ||
      s.sourceSignalId !== row.sourceSignalId ||
      record.symbol !== row.symbol || s.symbol !== row.symbol ||
      s.environment !== "vst" || !id(s.accountId) ||
      s.manualResolution != null || !parentId || !childId || !positionId ||
      !equalDecimal(s.remainingQty, 0)) return null;
  const phases = [
    `triggered-stop-${createHash("sha256").update(parentId).digest("hex").slice(0, 24)}`,
    `impulse-triggered-stop-${createHash("sha256")
      .update(`${positionId}:${parentId}`).digest("hex").slice(0, 24)}`,
  ];
  for (const phase of phases) {
    const intent = await store.getIntent(row.sourceSignalId, phase);
    const request = intent?.request, outcome = intent?.outcome, fill = outcome?.fill;
    const expectedClientId = `vst-${createHash("sha256")
      .update(`${row.sourceSignalId}:${phase}`).digest("hex").slice(0, 30)}`;
    if (intent?.state !== "reconciled" ||
        intent.sourceSignalId !== row.sourceSignalId ||
        intent.clientOrderId !== expectedClientId ||
        intent.exchangeOrderId !== childId ||
        request?.operation !== "observe_triggered_stop" ||
        request.environment !== "vst" || request.accountId !== s.accountId ||
        request.symbol !== s.symbol || request.positionId !== positionId ||
        request.stopOrderId !== parentId ||
        outcome?.operation !== "observe_triggered_stop" ||
        outcome.status !== "filled" || outcome.verified !== true ||
        outcome.parentStopId !== parentId || outcome.childOrderId !== childId ||
        !equalDecimal(outcome.parentStopPrice, request.stopPrice) ||
        !equalDecimal(s.triggeredStop.parentStopPrice, request.stopPrice) ||
        !equalDecimal(fill?.quantity, request.stopQuantity) ||
        fill?.orderId !== childId || fill.triggerOrderId !== parentId ||
        !Number.isFinite(Date.parse(fill.at)) ||
        !equalDecimal(fill.price, s.lastCloseFill?.price) ||
        Number(fill.price) <= 0 || Number(fill.quantity) <= 0 ||
        !isDeepStrictEqual(fill, s.lastCloseFill) ||
        fill.feeEvidenceAvailable !== true ||
        typeof fill.fee?.asset !== "string" || !fill.fee.asset ||
        !equalDecimal(fill.fee.amount, fill.fee.amount) ||
        outcome.residualPosition?.verified !== true ||
        outcome.residualPosition.positionId !== positionId ||
        !equalDecimal(outcome.residualPosition.quantity, 0) ||
        !Array.isArray(outcome.openStops) || outcome.openStops.length !== 0) continue;
    return { fill, phase, clientOrderId: intent.clientOrderId,
      parentStopId: parentId, childOrderId: childId };
  }
  return null;
}