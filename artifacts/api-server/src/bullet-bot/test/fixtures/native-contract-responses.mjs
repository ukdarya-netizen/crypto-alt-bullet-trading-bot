// Synthetic read-only native endpoint contracts, not exchange/account data.
// Kept separate from the unedited persisted protected-degraded proof fixture.
export function nativeContractResponses() {
  const symbol = "BTC-USDT";
  const position = { symbol, positionId: "1234567890123456789",
    positionSide: "LONG", positionAmt: "1", avgPrice: "200", initialMargin: "20" };
  const stop = { symbol, orderId: "2234567890123456789", positionID: 0,
    type: "STOP_MARKET", status: "NEW", side: "SELL", positionSide: "LONG",
    origQty: "1", stopPrice: "190", workingType: "MARK_PRICE" };
  const fill = { symbol, orderId: stop.orderId, volume: "1", price: "190",
    filledTm: 1700000000000 };
  const historyFill = { ...fill, tradeId: "3234567890123456789",
    filledTime: "2023-11-14T22:13:20Z" };
  const margin = { symbol, positionId: position.positionId,
    changeReason: "ManualMarginAddition", marginChange: "10",
    marginAfterChange: "30", time: 1700000000000 };
  return [
    ["/openApi/swap/v2/user/positions", [position], {}],
    ["/openApi/swap/v2/trade/order", { order: stop }, {}],
    ["/openApi/swap/v2/trade/openOrders", { orders: [stop] }, {}],
    ["/openApi/swap/v2/trade/allFillOrders", { fill_orders: [fill] }, {}],
    ["/openApi/swap/v2/trade/fillHistory", { fill_history_orders: [historyFill], total: 1 },
      { pageIndex: 1, pageSize: 1000 }],
    ["/openApi/swap/v1/positionMargin/history", { records: [margin], total: 1 },
      { pageIndex: 1, pageSize: 100 }],
  ];
}