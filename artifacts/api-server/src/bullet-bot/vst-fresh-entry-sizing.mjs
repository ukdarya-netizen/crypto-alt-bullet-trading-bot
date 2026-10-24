import { sizeVstLongTrade } from "./vst-sizing.mjs";

// Called only after the native preflight's exchange reads have completed.
// No account/contract/risk verdict is cached across attempts.
export function refreshVstEntrySizing({
  symbol, stopLoss, policy, balanceData, filters, tiers, fees, funding,
  leverage, quote, nowMs,
}) {
  if (!policy || !Array.isArray(tiers) || !tiers.length) {
    throw new Error("vst_fresh_sizing_inputs_unverified");
  }
  const balanceRows = Array.isArray(balanceData?.balance)
    ? balanceData.balance : Array.isArray(balanceData) ? balanceData
      : balanceData?.balance ? [balanceData.balance] : [balanceData];
  const vstRows = balanceRows.filter((row) => row?.asset === "VST");
  if (vstRows.length !== 1) throw new Error("vst_fresh_sizing_balance_unverified");
  const maximumNotional = Math.min(
    Number(vstRows[0].balance) * 0.01 * 10,
    Number(leverage?.maxPositionLongVal),
  );
  const tier = tiers.find((row) => maximumNotional <= row.maxNotional);
  if (!tier) throw new Error("vst_fresh_sizing_risk_tier_unverified");
  const sizing = sizeVstLongTrade({
    environment: "vst", symbol, stopLoss,
    balanceSnapshot: vstRows,
    quote: { price: String(quote.ask), observedAtMs: quote.timestamp },
    nowMs, maxQuoteAgeMs: policy.maxQuoteAgeMs,
    expectedPrice: policy.expectedPrice, maxSlippageBps: policy.maxSlippageBps,
    quantityUnitMultiple: policy.quantityUnitMultiple,
    filters, takerFeeRate: fees.taker, fundingRate: funding.rate,
    maintenanceMarginRate: tier.maintenanceMarginRate,
    stopBufferRate: 0.005, tickSize: 10 ** -filters.pricePrecision,
    maxPositionValue: leverage.maxPositionLongVal,
  });
  if (sizing.status !== "ready") {
    throw new Error(`vst_fresh_sizing_blocked:${sizing.blockers.join(",")}`);
  }
  return { ...sizing, calculatedAtMs: nowMs, maxSlippageBps: policy.maxSlippageBps };
}