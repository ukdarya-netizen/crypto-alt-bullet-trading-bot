import Decimal from "decimal.js";

const PreciseDecimal = Decimal.clone({ precision: 40 });
const DECIMAL_TEXT = /^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_QUOTE_AGE_MS = 90_000;
const FUTURE_TOLERANCE_MS = 5_000;
const QUOTE_SOURCE = "BingX public swap ticker";

export type PaperPositionMarket = {
  quotePrice: string | null;
  quoteAt: string | null;
  quoteSource: string | null;
  quoteStatus: "fresh" | "stale" | "unavailable";
  priceBasis: "mark" | "last" | "none";
  unrealizedPnlUsdt: string | null;
  roePercent: string | null;
  notionalUsdt: string | null;
  projectedExitFeeUsdt: string | null;
  pnlAfterExitFeeUsdt: string | null;
  roeAfterExitFeePercent: string | null;
};

function decimal(value: unknown, allowZero = false): Decimal | null {
  if (
    !(typeof value === "string" && DECIMAL_TEXT.test(value)) &&
    !(typeof value === "number" && Number.isFinite(value))
  ) return null;
  try {
    const parsed = new PreciseDecimal(value);
    return parsed.isFinite() && (allowZero ? parsed.gte(0) : parsed.gt(0))
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function decimalText(value: Decimal): string {
  return value.isZero() ? "0" : value.toString();
}

/** Computes display-only estimates from a saved BingX last-trade quote. */
export function paperPositionMarket(
  snapshot: Record<string, unknown>,
  now = Date.now(),
): PaperPositionMarket {
  const readQuote = (value: unknown, expectedSource: string) => {
    const record = value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
    const price = decimal(record?.price);
    const at = typeof record?.at === "string" ? record.at : null;
    const source = record?.source;
    const timestamp = at !== null && DATE_TIME.test(at) ? Date.parse(at) : NaN;
    const age = now - timestamp;
    const trusted = price !== null && Number.isFinite(timestamp) &&
      age >= -FUTURE_TOLERANCE_MS && source === expectedSource;
    const status: PaperPositionMarket["quoteStatus"] = !trusted
      ? "unavailable" : age > MAX_QUOTE_AGE_MS ? "stale" : "fresh";
    return {
      price: trusted ? price : null,
      at: trusted ? at : null,
      source: trusted ? expectedSource : null,
      status,
    };
  };
  const mark = readQuote(snapshot.marketMark, "BingX public swap premiumIndex");
  const last = readQuote(snapshot.marketQuote, QUOTE_SOURCE);
  const selected = mark.status === "fresh" ? mark
    : last.status === "fresh" ? last
    : mark.status === "stale" ? mark : last;
  const priceBasis: PaperPositionMarket["priceBasis"] =
    selected === mark && selected.status !== "unavailable" ? "mark"
      : selected.status !== "unavailable" ? "last" : "none";
  let unrealizedPnlUsdt: string | null = null;
  let notionalUsdt: string | null = null;
  let roePercent: string | null = null;
  let projectedExitFeeUsdt: string | null = null;
  let pnlAfterExitFeeUsdt: string | null = null;
  let roeAfterExitFeePercent: string | null = null;

  if (selected.status === "fresh" && snapshot.mode === "paper") {
    const entry = decimal(snapshot.entryPrice);
    const quantity = decimal(snapshot.remainingQty);
    if (entry && quantity) {
      const pnl = selected.price!.minus(entry).times(quantity);
      const notional = selected.price!.times(quantity);
      unrealizedPnlUsdt = decimalText(pnl);
      notionalUsdt = decimalText(notional);
      const feeModel = snapshot.feeModel !== null &&
        typeof snapshot.feeModel === "object" && !Array.isArray(snapshot.feeModel)
        ? snapshot.feeModel as Record<string, unknown> : null;
      const feeRate = decimal(feeModel?.rate, true) ?? new PreciseDecimal("0.0005");
      if (feeRate.lt(1)) {
        const exitFee = notional.times(feeRate);
        projectedExitFeeUsdt = decimalText(exitFee);
        pnlAfterExitFeeUsdt = decimalText(pnl.minus(exitFee));
      }
      const margin = decimal(snapshot.marginHeldUsd);
      if (margin?.gt(0)) {
        roePercent = decimalText(pnl.div(margin).times(100));
        if (pnlAfterExitFeeUsdt !== null) {
          roeAfterExitFeePercent = decimalText(
            new PreciseDecimal(pnlAfterExitFeeUsdt).div(margin).times(100),
          );
        }
      }
    }
  }

  return {
    quotePrice: selected.price ? decimalText(selected.price) : null,
    quoteAt: selected.at,
    quoteSource: selected.source,
    quoteStatus: selected.status,
    priceBasis,
    unrealizedPnlUsdt,
    roePercent,
    notionalUsdt,
    projectedExitFeeUsdt,
    pnlAfterExitFeeUsdt,
    roeAfterExitFeePercent,
  };
}