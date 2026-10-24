/** Exit policy fields from the provided liquidation_cascade relay event.
 * Do not treat this as a captured event for any other pattern. */
export function bulletPayload(impulse = false) {
  return {
    source: "CryptoAltBullet", rulesVersion: "bullet-long-exits-v2",
    marginMode: "isolated", leverage: 10, initialMarginUsd: "10",
    exitRules: {
      priceMoveBasis: "unleveraged_percent_from_actual_entry_fill", breakevenAtPct: 5,
      protectedProfitAtPct: 10, protectedProfitPct: 5,
      trailingActivationPct: 15, trailingGapPercentagePoints: 10,
      maxWatchDays: 4, noFixedTakeProfit: true, rMultipleTargets: false,
      firstTargetAction: "milestone_not_full_close",
      firstTargetPct: 10, expiryExitPrice: "observed_market_quote",
      trailingGapBasis: "percentage_points_of_entry_pnl",
      trailingExitAction: "close_remaining_position",
      breakevenStopGainPct: 0, breakevenIncludesFees: false,
      trailingStopNeverDecreases: true,
      partialProfitAdvice: {
        execution: "advice_only_not_automated", minFraction: 0.2, maxFraction: 0.25,
      },
      ...(impulse ? { runner: {
        corePct: 80, runnerPct: 20, breakevenStop: "on_open",
        trailingActivationPct: 30, trailingGapPercentagePoints: 30, maxHoldHours: 120,
      } } : {}),
    },
  };
}