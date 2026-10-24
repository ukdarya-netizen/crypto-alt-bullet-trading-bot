import Decimal from "decimal.js";
import {
  assessPaperMargin,
  PAPER_ASSUMED_MAINTENANCE_RATE,
  PAPER_ASSUMED_SAFETY_RATE,
  PAPER_ASSUMED_CLOSE_FEE_RATE,
} from "../bullet-bot/paper-margin.mjs";

const D = Decimal.clone({ precision: 40 });
const DECIMAL = /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const ASSUMED_MAINTENANCE_RATE = new D(PAPER_ASSUMED_MAINTENANCE_RATE);
const ASSUMED_SAFETY_RATE = new D(PAPER_ASSUMED_SAFETY_RATE);
const STANDARD_TAKER_RATE = new D(PAPER_ASSUMED_CLOSE_FEE_RATE);

export type PaperPositionMargin = {
  status: "estimated_buffer" | "estimated_shortfall" | "unavailable";
  stopPercentFromEntry: string | null;
  stopPriceUsed: string | null;
  stopLossUsdt: string | null;
  stopLossPercentOfMargin: string | null;
  requiredMarginUsdt: string | null;
  additionalMarginNeededUsdt: string | null;
  bufferAtStopUsdt: string | null;
  estimatedLiquidationPrice: string | null;
  marginHeldUsdt: string | null;
  addedMarginUsdt: string | null;
  maintenanceRateAssumed: string;
  safetyRateAssumed: string;
  closeFeeRateAssumed: string;
};

function amount(value: unknown, zero = false): Decimal | null {
  if (!(typeof value === "number" && Number.isFinite(value)) &&
      !(typeof value === "string" && DECIMAL.test(value))) return null;
  try {
    const parsed = new D(value);
    return parsed.isFinite() && parsed.lte("1e12") &&
      (zero ? parsed.gte(0) : parsed.gt(0)) ? parsed : null;
  } catch {
    return null;
  }
}

function text(value: Decimal): string {
  return value.isZero() ? "0" : value.toString();
}

/** Read-only PAPER risk estimate. BingX's actual maintenance tier is not public. */
export function paperPositionMargin(snapshot: Record<string, unknown>): PaperPositionMargin {
  const entry = amount(snapshot.entryPrice);
  const quantity = amount(snapshot.remainingQty);
  const margin = amount(snapshot.marginHeldUsd);
  const coreOpen = snapshot.coreOpen !== false;
  const runnerStop = snapshot.runnerOpen === true && !coreOpen
    ? amount(snapshot.runnerStopPrice) : null;
  const stop = runnerStop ?? amount(snapshot.stopPrice);
  const feeModel = snapshot.feeModel && typeof snapshot.feeModel === "object" &&
    !Array.isArray(snapshot.feeModel) ? snapshot.feeModel as Record<string, unknown> : null;
  const modeledRate = amount(feeModel?.rate, true);
  const closeFeeRate = modeledRate && modeledRate.lt("0.1")
    ? modeledRate : STANDARD_TAKER_RATE;
  const paperMargin = snapshot.paperMargin && typeof snapshot.paperMargin === "object" &&
    !Array.isArray(snapshot.paperMargin) ? snapshot.paperMargin as Record<string, unknown> : null;
  const addedMargin = amount(paperMargin?.addedMarginUsdt, true);
  const empty = {
    status: "unavailable" as const,
    stopPercentFromEntry: null,
    stopPriceUsed: null,
    stopLossUsdt: null,
    stopLossPercentOfMargin: null,
    requiredMarginUsdt: null,
    additionalMarginNeededUsdt: null,
    bufferAtStopUsdt: null,
    estimatedLiquidationPrice: null,
    marginHeldUsdt: margin ? text(margin) : null,
    addedMarginUsdt: addedMargin ? text(addedMargin) : null,
    maintenanceRateAssumed: text(ASSUMED_MAINTENANCE_RATE),
    safetyRateAssumed: text(ASSUMED_SAFETY_RATE),
    closeFeeRateAssumed: text(closeFeeRate),
  };
  if (!entry || !quantity || !margin || !stop) return empty;

  let assessment: ReturnType<typeof assessPaperMargin>;
  try {
    assessment = assessPaperMargin({
      entryPrice: entry.toString(),
      stopPrice: stop.toString(),
      remainingQty: quantity.toString(),
      marginHeldUsdt: margin.toString(),
      closeFeeRate: closeFeeRate.toString(),
    });
  } catch {
    return empty;
  }
  const loss = new D(assessment.lossAtStopUsdt);
  const liquidationDenominator = new D(1).minus(ASSUMED_MAINTENANCE_RATE).minus(closeFeeRate);
  const liquidation = entry.minus(margin.div(quantity)).div(liquidationDenominator);

  return {
    status: assessment.status === "buffered" ? "estimated_buffer" : "estimated_shortfall",
    stopPercentFromEntry: text(stop.minus(entry).div(entry).times(100)),
    stopPriceUsed: text(stop),
    stopLossUsdt: text(loss),
    stopLossPercentOfMargin: text(loss.div(margin).times(100)),
    requiredMarginUsdt: String(assessment.requiredMarginUsdt),
    additionalMarginNeededUsdt: String(assessment.topUpUsdt),
    bufferAtStopUsdt: String(assessment.stopBufferUsdt),
    estimatedLiquidationPrice: liquidation.gt(0) ? text(liquidation) : null,
    marginHeldUsdt: text(margin),
    addedMarginUsdt: addedMargin ? text(addedMargin) : null,
    maintenanceRateAssumed: text(ASSUMED_MAINTENANCE_RATE),
    safetyRateAssumed: text(ASSUMED_SAFETY_RATE),
    closeFeeRateAssumed: text(closeFeeRate),
  };
}