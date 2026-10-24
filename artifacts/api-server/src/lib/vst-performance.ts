// Compact, read-only performance rows for closed VST positions. Mirrors the
// journal's closed-position accounting (trading-journal JournalPositions
// vstClosedPosition): exchange-history repairs report BingX's realised PnL
// after both USDT commissions; other close paths use (close - entry) × qty
// minus the stored close fee. Nothing is guessed: unknown inputs give null.

type RecordValue = Record<string, unknown>;

const VST_LEVERAGE = 10;

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function finite(value: unknown): number | null {
  if ((typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "string" && value.trim() === "")) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value: unknown): number | null {
  const parsed = finite(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function isoTime(value: unknown): string | null {
  const ms = typeof value === "number" ? value
    : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function round(value: number, digits = 8): number {
  return Number(value.toFixed(digits));
}

export type VstPerformanceRow = {
  sourceSignalId: string;
  symbol: string;
  patternId: string | null;
  entryAt: string | null;
  closedAt: string;
  entryPrice: number | null;
  closePrice: number | null;
  quantity: number | null;
  marginUsdt: number | null;
  pnlUsdt: number | null;
  roePercent: number | null;
  closeReason: string | null;
  manual: boolean;
  accounting: "exchange_fills" | "exchange_history" | "unknown";
};

export function vstPerformanceRow(row: {
  source_signal_id: string;
  symbol: string;
  pattern_id: string | null;
  snapshot: unknown;
  updated_at: Date | string;
}): VstPerformanceRow {
  const snapshot = record(row.snapshot);
  const verifiedFill = record(snapshot.verifiedFill);
  const entryIntent = record(snapshot.entryIntent);
  const entryOutcome = record(snapshot.reconciledEntryOutcome ?? snapshot.reconciledOutcome ??
    snapshot.entryOutcome ?? entryIntent.outcome);
  const manual = record(snapshot.manualResolution).outcome === "closed";
  const provenance = record(snapshot.exchangeHistoryProvenance);
  const history = provenance.verified === true && provenance.environment === "vst";
  const historyEntry = record(provenance.entryFill);
  const historyClose = record(provenance.closeFill);
  const fill = history ? historyClose : record(snapshot.closeFill ?? snapshot.lastCloseFill);
  const updatedAt = new Date(row.updated_at).toISOString();

  const entryPrice = positive(history ? historyEntry.price
    : verifiedFill.price ?? entryOutcome.fillPrice ?? entryOutcome.price ?? snapshot.entryPrice);
  const closePrice = positive(fill.price);
  const quantity = positive(fill.quantity);
  const hasInputs = entryPrice !== null && closePrice !== null && quantity !== null;

  let pnlUsdt: number | null = null;
  let accounting: VstPerformanceRow["accounting"] = "unknown";
  if (history) {
    const entryFee = record(historyEntry.fee);
    const closeFee = record(historyClose.fee);
    const usdtFees = entryFee.asset === "USDT" && closeFee.asset === "USDT";
    const gross = historyClose.realisedPnlProvenance === "bingx_fill_history.realisedPNL" &&
      historyClose.realisedPnlAsset === "USDT" ? finite(historyClose.realisedPnl) : null;
    const entryAmount = usdtFees ? finite(entryFee.amount) : null;
    const closeAmount = usdtFees ? finite(closeFee.amount) : null;
    if (gross !== null && entryAmount !== null && closeAmount !== null) {
      pnlUsdt = round(gross + entryAmount + closeAmount);
      accounting = "exchange_history";
    }
  } else if (hasInputs) {
    const fee = finite(record(fill.fee ?? fill.fees).amount);
    pnlUsdt = round((closePrice! - entryPrice!) * quantity! - (fee ?? 0));
    accounting = "exchange_fills";
  }
  const marginUsdt = hasInputs ? round(entryPrice! * quantity! / VST_LEVERAGE, 6) : null;
  const roePercent = pnlUsdt !== null && marginUsdt !== null && marginUsdt > 0
    ? round(pnlUsdt / marginUsdt * 100, 2) : null;
  const closedAt = (history ? isoTime(snapshot.closedAt) ?? isoTime(historyClose.at) : null) ??
    isoTime(snapshot.closedAt) ?? isoTime(fill.at) ?? updatedAt;
  const entryAt = isoTime(history ? historyEntry.at : undefined) ??
    isoTime(record(snapshot.priceAudit).verifiedFillAt) ?? isoTime(verifiedFill.at) ??
    isoTime(entryOutcome.at) ?? isoTime(entryOutcome.fillAt) ?? isoTime(snapshot.entryAt);
  return {
    sourceSignalId: row.source_signal_id,
    symbol: row.symbol,
    patternId: row.pattern_id ?? (typeof snapshot.patternId === "string" ? snapshot.patternId : null),
    entryAt,
    closedAt,
    entryPrice,
    closePrice,
    quantity,
    marginUsdt,
    pnlUsdt,
    roePercent,
    closeReason: history ? "exchange_history_provenance"
      : manual ? "manual_owner_resolution"
        : typeof snapshot.closeReason === "string" ? snapshot.closeReason
          : Object.keys(record(snapshot.triggeredStop)).length ? "protective_stop" : null,
    manual,
    accounting,
  };
}
