export const PAPER_BASE_MARGIN_USDT: number;
export const PAPER_ASSUMED_MAINTENANCE_RATE: number;
export const PAPER_ASSUMED_SAFETY_RATE: number;
export const PAPER_ASSUMED_CLOSE_FEE_RATE: number;

export function assessPaperMargin(input: {
  entryPrice: string | number;
  stopPrice: string | number;
  remainingQty: string | number;
  marginHeldUsdt: string | number;
  closeFeeRate?: string | number;
}): {
  lossAtStopUsdt: number;
  requiredMarginUsdt: number;
  marginHeldUsdt: number;
  stopBufferUsdt: number;
  topUpUsdt: number;
  status: "buffered" | "insufficient_funds";
};