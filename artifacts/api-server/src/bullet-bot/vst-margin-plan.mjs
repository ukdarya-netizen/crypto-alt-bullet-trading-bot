function positive(value, name) {
  if ((typeof value !== "number" && typeof value !== "string") ||
      String(value).trim() === "") throw new TypeError(`${name} is unavailable`);
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new RangeError(`${name} must be positive and finite`);
  }
  return number;
}

function nonnegative(value, name) {
  if ((typeof value !== "number" && typeof value !== "string") ||
      String(value).trim() === "") throw new TypeError(`${name} is unavailable`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new RangeError(`${name} must be nonnegative and finite`);
  }
  return number;
}

// An estimate made before entry is not a ceiling on risk protection.
// Calculate from the exchange's current liquidation price and minimum
// allowed margin increment, with a buffer above the signal stop.
export function calculateVstMarginTopUp({
  quantity, stopLoss, avgPrice, liquidationPrice, minIncreaseMargin,
  pricePrecision, availableMargin,
}) {
  const qty = positive(quantity, "position quantity");
  const stop = positive(stopLoss, "signal stop");
  const entry = positive(avgPrice, "exchange entry average");
  const liquidation = positive(liquidationPrice, "exchange liquidation price");
  const minimum = nonnegative(minIncreaseMargin, "exchange minimum margin increase");
  const available = nonnegative(availableMargin, "available VST");
  if (!Number.isSafeInteger(pricePrecision) || pricePrecision < 0 ||
      pricePrecision > 12 || stop >= entry) {
    throw new RangeError("contract precision or stop is invalid");
  }
  const buffer = Math.max(entry * 0.005, 10 ** -pricePrecision);
  if (liquidation + buffer < stop) {
    return { amount: null, buffer, minimum, liquidationBefore: liquidation };
  }
  // Linear isolated-margin estimate. Never round down; allow an additional
  // cent for strict inequality and exchange rounding.
  const required = (liquidation + buffer - stop) * qty;
  const amount = (Math.ceil(Math.max(required, minimum) * 100 - 1e-9) + 1) / 100;
  if (!Number.isFinite(amount) || amount <= 0 || amount > available) {
    throw new RangeError("required protective margin exceeds verified available VST");
  }
  return {
    amount: amount.toFixed(2),
    buffer,
    minimum,
    liquidationBefore: liquidation,
  };
}