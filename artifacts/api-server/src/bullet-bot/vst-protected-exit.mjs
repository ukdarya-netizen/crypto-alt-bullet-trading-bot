// A new risk-reducing exit is not a replay or attribution of the old stop POST.
// The original ambiguity must remain in the durable position/intent history.
export function validateProtectedExit(exit, { symbol, positionId, quantity }) {
  const id = value => typeof value === "string" && value.trim().length > 0;
  const decimal = value => typeof value === "string" &&
    /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) && Number(value) > 0;
  if (!exit || exit.version !== 1 || exit.symbol !== symbol ||
      exit.positionId !== positionId || exit.quantity !== String(quantity) ||
      !id(exit.sourceSignalId) || !id(exit.originalClientOrderId) ||
      !id(exit.entryOrderId) ||
      !["protective_stop", "percentage_point_trailing_stop",
        "protected_profit_floor", "breakeven_stop"].includes(exit.reason) ||
      !Number.isFinite(Date.parse(exit.observedAt)) ||
      !decimal(exit.price) || !decimal(exit.quantity) ||
      !Array.isArray(exit.ownedStops) || exit.ownedStops.length !== 1) {
    throw new Error("vst_protected_exit_identity_invalid");
  }
  const stop = exit.ownedStops[0];
  if (!id(stop?.orderId) || stop.positionId !== positionId ||
      stop.quantity !== exit.quantity || !decimal(stop.stopPrice) ||
      !["core", undefined].includes(stop.tranche)) {
    throw new Error("vst_protected_exit_stop_invalid");
  }
  return exit;
}