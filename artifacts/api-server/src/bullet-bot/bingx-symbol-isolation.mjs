const SYMBOL = /^[A-Z0-9]{2,20}USDT$/;

/**
 * A read-only collision check, not permission to place an order. An external
 * position or pending order on the same symbol belongs to the owner, not us.
 * Always recheck immediately before a future entry under the live lock.
 */
export function assessBingXSymbolIsolation(symbol, positions, openOrders, dualSidePosition) {
  if (typeof symbol !== "string" || !SYMBOL.test(symbol)) {
    return { symbolClear: false, positionSide: null, reason: "invalid_symbol" };
  }
  if (!Array.isArray(positions) || !Array.isArray(openOrders)) {
    return { symbolClear: false, positionSide: null, reason: "exchange_state_unknown" };
  }
  if (![true, false, "true", "false"].includes(dualSidePosition)) {
    return { symbolClear: false, positionSide: null, reason: "position_mode_unknown" };
  }

  const venueSymbol = `${symbol.slice(0, -4)}-USDT`;
  for (const position of positions) {
    const amount = position?.positionAmt;
    if (typeof position?.symbol !== "string" ||
        !((typeof amount === "string" && amount.trim() !== "") || typeof amount === "number") ||
        !Number.isFinite(Number(amount))) {
      return { symbolClear: false, positionSide: null, reason: "exchange_state_unknown" };
    }
    if (position.symbol === venueSymbol && Number(amount) !== 0) {
      return { symbolClear: false, positionSide: null, reason: "existing_position" };
    }
  }
  for (const order of openOrders) {
    if (typeof order?.symbol !== "string") {
      return { symbolClear: false, positionSide: null, reason: "exchange_state_unknown" };
    }
    if (order.symbol === venueSymbol) {
      return { symbolClear: false, positionSide: null, reason: "existing_order" };
    }
  }
  return {
    symbolClear: true,
    positionSide: dualSidePosition === true || dualSidePosition === "true" ? "LONG" : "BOTH",
    reason: null,
  };
}