type AccountedTrade = {
  environment: "paper" | "live" | "testnet";
  status: "open" | "closed";
  accountingStatus: "open" | "verified" | "incomplete";
  profitUsdt: string | null;
  allocatedUsdt: string | null;
};

export function returnFor(trades: AccountedTrade[], environment: AccountedTrade["environment"], depositText: string | null) {
  const closed = trades.filter((trade) => trade.environment === environment && trade.status === "closed");
  // PAPER has historically failed closed as a group: an unresolved funding
  // debit in any closed trade invalidates the displayed total for that period.
  // REAL is a verified-only sum; incomplete LIVE trades are never counted.
  if (!closed.length || (environment !== "live" && closed.some((trade) =>
    trade.accountingStatus !== "verified" || trade.profitUsdt === null))) {
    return null;
  }
  const eligible = environment === "live"
    ? closed.filter((trade) => trade.accountingStatus === "verified" && trade.profitUsdt !== null)
    : closed;
  if (!eligible.length || eligible.some((trade) =>
    !Number.isFinite(Number(trade.profitUsdt)))) {
    return null;
  }
  const deposit = depositText === null ? NaN : Number(depositText);
  const pnl = eligible.reduce((sum, trade) => sum + Number(trade.profitUsdt), 0);
  const allocations = eligible.map((trade) =>
    trade.allocatedUsdt === null ? NaN : Number(trade.allocatedUsdt));
  const totalAllocation = allocations.every((value) => Number.isFinite(value) && value > 0)
    ? allocations.reduce((sum, value) => sum + value, 0)
    : null;
  return {
    percent: Number.isFinite(deposit) && deposit > 0 ? pnl / deposit * 100 : null,
    tradePercent: totalAllocation === null ? null : pnl / totalAllocation * 100,
  };
}