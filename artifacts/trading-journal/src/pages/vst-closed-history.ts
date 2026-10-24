type RecordValue = Record<string, unknown>;

export type ExchangeHistoryClosedAccounting = {
  closedByExchangeHistory: true;
  closedAt: string | null;
  entryPrice: string | null;
  entryFillAt: string | null;
  closePrice: string | null;
  closeQuantity: string | null;
  entryCommissionUsdt: number | null;
  closeCommissionUsdt: number | null;
  grossPnlUsdt: number | null;
  knownFeeExpenseUsdt: number | null;
  knownAfterFeesUsdt: number | null;
  feeAsset: "VST" | "USDT" | null;
  fundingStatus: "unverified";
};

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : {};
}

function finiteNumber(value: unknown): number | null {
  if ((typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "string" && value.trim() === "")) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function rounded(value: number): number {
  return Number(value.toFixed(8));
}

/**
 * Translate only verified exchange-history repairs into their own accounting
 * view. Commissions are signed cash flows (negative means expense); funding
 * is deliberately not inferred, since this provenance does not verify it.
 */
export function exchangeHistoryClosedAccounting(
  snapshotValue: unknown,
  positionUpdatedAt: string,
): ExchangeHistoryClosedAccounting | null {
  const snapshot = record(snapshotValue);
  const provenance = record(snapshot.exchangeHistoryProvenance);
  if (provenance.verified !== true || provenance.environment !== "vst") return null;

  const entryFill = record(provenance.entryFill);
  const closeFill = record(provenance.closeFill);
  const entryFee = record(entryFill.fee);
  const closeFee = record(closeFill.fee);
  const feeAsset = entryFee.asset === closeFee.asset &&
    (entryFee.asset === "USDT" || entryFee.asset === "VST") ? entryFee.asset : null;
  const entryFeeAmount = feeAsset ? finiteNumber(entryFee.amount) : null;
  const closeFeeAmount = feeAsset ? finiteNumber(closeFee.amount) : null;

  // Report the provider's signed realized result, never price × quantity:
  // rounded historical prices can produce a different result from BingX.
  const grossPnlUsdt = closeFill.realisedPnlProvenance === "bingx_fill_history.realisedPNL" &&
    closeFill.realisedPnlAsset === "USDT" ? finiteNumber(closeFill.realisedPnl) : null;
  const hasBothCommissions = entryFeeAmount !== null && closeFeeAmount !== null;
  const knownFeeExpenseUsdt = hasBothCommissions
    ? rounded(-(entryFeeAmount + closeFeeAmount))
    : null;
  // Do not invent a VST -> USDT conversion. A verified gross result in quote
  // units and native VST commissions are shown separately.
  const knownAfterFeesUsdt = grossPnlUsdt !== null && hasBothCommissions && feeAsset === "USDT"
    ? rounded(grossPnlUsdt + entryFeeAmount! + closeFeeAmount!)
    : null;
  const closeAt = typeof closeFill.at === "string" ? closeFill.at : null;

  return {
    closedByExchangeHistory: true,
    closedAt: typeof snapshot.closedAt === "string"
      ? snapshot.closedAt
      : closeAt ?? positionUpdatedAt,
    entryPrice: typeof entryFill.price === "string" || typeof entryFill.price === "number"
      ? String(entryFill.price) : null,
    entryFillAt: typeof entryFill.at === "string" ? entryFill.at : null,
    closePrice: typeof closeFill.price === "string" || typeof closeFill.price === "number"
      ? String(closeFill.price) : null,
    closeQuantity: typeof closeFill.quantity === "string" || typeof closeFill.quantity === "number"
      ? String(closeFill.quantity) : null,
    entryCommissionUsdt: entryFeeAmount,
    closeCommissionUsdt: closeFeeAmount,
    grossPnlUsdt,
    knownFeeExpenseUsdt,
    knownAfterFeesUsdt,
    feeAsset,
    fundingStatus: "unverified",
  };
}