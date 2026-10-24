const LEVERAGE = 10;
const VST_BUDGET_RATE = 0.01;
const CENTS = 100;

function decimal(value, name, { allowZero = false } = {}) {
  const text = typeof value === "string" ? value
    : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new TypeError(`${name} must be a plain non-negative decimal`);
  const fraction = match[2] ?? "";
  const parsed = { units: BigInt(`${match[1]}${fraction}`), scale: 10n ** BigInt(fraction.length) };
  if (parsed.units === 0n && !allowZero) throw new RangeError(`${name} must be greater than zero`);
  return parsed;
}

function numeric(value, name, options) {
  const parsed = decimal(value, name, options);
  const result = Number(parsed.units) / Number(parsed.scale);
  if (!Number.isFinite(result)) throw new RangeError(`${name} is outside the supported range`);
  return result;
}

function precision(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 12) {
    throw new RangeError(`${name} must be an integer from 0 through 12`);
  }
  return value;
}

function ceilRatio(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

function formatUnits(units, places) {
  const scale = 10n ** BigInt(places);
  const whole = units / scale;
  const fraction = String(units % scale).padStart(places, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function roundUpToCents(value) {
  return Math.ceil(value * CENTS) / CENTS;
}

function findVstBalance(balanceSnapshot) {
  let rows;
  if (Array.isArray(balanceSnapshot)) rows = balanceSnapshot;
  else if (Array.isArray(balanceSnapshot?.balance)) rows = balanceSnapshot.balance;
  else if (balanceSnapshot?.balance && typeof balanceSnapshot.balance === "object") {
    rows = [balanceSnapshot.balance];
  } else if (balanceSnapshot && typeof balanceSnapshot === "object" &&
      Object.hasOwn(balanceSnapshot, "asset")) {
    rows = [balanceSnapshot];
  } else {
    throw new TypeError("A VST balance snapshot is required");
  }
  const vstRows = rows.filter((row) => row?.asset === "VST");
  if (vstRows.length !== 1) {
    throw new Error("VST balance snapshot must contain exactly one VST row");
  }
  const balanceDecimal = decimal(vstRows[0].balance, "VST total balance");
  const balance = Number(balanceDecimal.units) / Number(balanceDecimal.scale);
  if (!Number.isFinite(balance)) throw new RangeError("VST total balance is outside the supported range");
  const availableMargin = numeric(vstRows[0].availableMargin, "VST available margin", {
    allowZero: true,
  });
  return { balance, balanceDecimal, availableMargin };
}

/**
 * Pure, read-only VST long sizing. The balance's `balance` field—not equity,
 * available margin, or a portfolio aggregate—is the 1% initial-margin budget.
 * `quote.observedAtMs` and `nowMs` are millisecond timestamps.
 *
 * The result is advisory only: it never configures exchange margin/leverage
 * and never submits an order.
 *
 * When the exchange's per-symbol, per-leverage position-value cap
 * (`maxPositionValue`) is tighter than the 1% budget, the position is
 * resized down to the largest quantity that fits within it (see
 * `positionCapBound` on the result) rather than blocking the signal. A
 * signal still blocks with `below_minimum_quantity`/`below_minimum_notional`
 * if that capped size is too small to trade at all.
 */
export function sizeVstLongTrade({
  environment,
  symbol,
  balanceSnapshot,
  quote,
  nowMs,
  maxQuoteAgeMs,
  expectedPrice,
  maxSlippageBps,
  stopLoss,
  filters,
  takerFeeRate,
  fundingRate,
  maintenanceMarginRate,
  stopBufferRate,
  tickSize,
  maxPositionValue,
  quantityUnitMultiple = 1,
}) {
  if (environment !== "vst") throw new Error("VST sizing is unavailable outside the VST environment");
  if (typeof symbol !== "string" || !/^[A-Z0-9]{1,20}USDT$/.test(symbol)) {
    throw new Error("VST sizing requires a canonical USDT perpetual symbol");
  }
  // `filters` is the normalized result of bingx-live-api's contract() read,
  // which only returns active, API-tradeable USDT contracts. Bind it to this
  // exact instrument so metadata cannot be reused across symbols.
  const venueSymbol = `${symbol.slice(0, -4)}-USDT`;
  if (filters?.symbol !== venueSymbol) {
    throw new Error("Verified active USDT contract filters for this symbol are required");
  }
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0 ||
      !Number.isSafeInteger(quote?.observedAtMs) || quote.observedAtMs <= 0) {
    throw new TypeError("A quote timestamp and nowMs are required in milliseconds");
  }
  if (!Number.isSafeInteger(maxQuoteAgeMs) || maxQuoteAgeMs <= 0 ||
      quote.observedAtMs > nowMs || nowMs - quote.observedAtMs > maxQuoteAgeMs) {
    throw new Error("VST quote is stale or has an invalid timestamp");
  }
  if (!Number.isSafeInteger(maxSlippageBps) || maxSlippageBps < 0 ||
      maxSlippageBps >= 10_000) {
    throw new RangeError("Slippage limit must be valid basis points");
  }

  const quotePrice = decimal(quote.price, "quote price");
  const expected = decimal(expectedPrice, "expected price");
  const quoteNumber = Number(quotePrice.units) / Number(quotePrice.scale);
  const expectedNumber = Number(expected.units) / Number(expected.scale);
  const deviationPct = (quoteNumber - expectedNumber) / expectedNumber * 100;
  if (!Number.isFinite(deviationPct)) {
    throw new RangeError("Signal-to-market price comparison is unavailable");
  }
  // The owner wants every otherwise safe VST signal priced from the current
  // exchange quote. Preserve the source comparison for audit, never use its
  // magnitude to reject an entry or rewrite the source's exit rules.

  const quantityPrecision = precision(filters?.quantityPrecision, "quantityPrecision");
  if (quantityUnitMultiple !== 1 && quantityUnitMultiple !== 5) {
    throw new RangeError("VST quantity unit multiple must be 1 or 5");
  }
  const pricePrecision = precision(filters?.pricePrecision, "pricePrecision");
  if (filters?.maxLeverage !== undefined &&
      (!Number.isFinite(Number(filters.maxLeverage)) || Number(filters.maxLeverage) < LEVERAGE)) {
    throw new Error("Contract does not support isolated leverage 10");
  }
  const minQuantity = numeric(filters?.minQuantity, "minimum quantity");
  const minNotional = numeric(filters?.minNotional, "minimum notional");
  const feeRate = numeric(takerFeeRate, "taker fee rate", { allowZero: true });
  const fundingText = String(fundingRate ?? "");
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(fundingText) ||
      !Number.isFinite(Number(fundingText)) ||
      Math.abs(Number(fundingText)) >= 1) {
    throw new RangeError("A verified funding rate below 1 in magnitude is required");
  }
  const fundingReserveRate = Math.abs(Number(fundingText));
  const maintenanceRate = numeric(
    maintenanceMarginRate, "maintenance margin rate", { allowZero: true },
  );
  const bufferRate = numeric(stopBufferRate, "stop buffer rate");
  const tick = numeric(tickSize, "price tick size");
  if (feeRate >= 1 || maintenanceRate >= 1 || bufferRate >= 1) {
    throw new RangeError("Fee, maintenance, or stop-buffer rate is outside the supported range");
  }
  // The exchange's own per-symbol maximum position value at this leverage --
  // distinct from, and sometimes far smaller than, the maintenance-margin
  // risk tiers. Required so a doomed order is never even attempted. When it
  // is tighter than the 1% budget, sizing is resized down to fit within it
  // (see capQuantityUnits below) instead of blocking the signal outright.
  const maxPositionValueDecimal = decimal(maxPositionValue, "maximum position value");
  const maxPositionValueVst = Number(maxPositionValueDecimal.units) / Number(maxPositionValueDecimal.scale);

  const { balance, balanceDecimal, availableMargin } = findVstBalance(balanceSnapshot);
  const budgetDecimal = {
    units: balanceDecimal.units,
    scale: balanceDecimal.scale * 100n,
  };
  const budget = Number(budgetDecimal.units) / Number(budgetDecimal.scale);

  // Round the quote-plus-slippage limit upward to the instrument's price
  // precision. Quantity is then floored exactly in contract precision.
  const priceScale = 10n ** BigInt(pricePrecision);
  const maxPriceUnits = ceilRatio(
    quotePrice.units * BigInt(10_000 + maxSlippageBps) * priceScale,
    quotePrice.scale * 10_000n,
  );
  const maxPriceText = formatUnits(maxPriceUnits, pricePrecision);
  const maxPrice = Number(maxPriceUnits) / Number(priceScale);
  const quantityScale = 10n ** BigInt(quantityPrecision);
  const stopDecimal = decimal(stopLoss, "stop loss");
  // A LONG protective stop is rounded toward the entry, never farther away.
  // Use decimal integer math so floating-point rounding cannot weaken it.
  const stopUnits = ceilRatio(stopDecimal.units * priceScale, stopDecimal.scale);
  const executableStopLoss = formatUnits(stopUnits, pricePrecision);
  const stop = Number(stopUnits) / Number(priceScale);
  if (stop >= quoteNumber) throw new Error("Long stop loss must be below the current quote");
  const stopBufferVst = Math.max(maxPrice * bufferRate, tick);
  const liquidationEstimate = maxPrice * (
    1 - 1 / LEVERAGE + maintenanceRate + 2 * feeRate + fundingReserveRate
  );
  // MARKET has no guaranteed execution price. Leave 5% of the one-percent
  // initial-margin ceiling unallocated so an ordinary rise between planning
  // and the final signed ask check does not consume the entire budget.
  // This is NOT a 5% exchange-enforced slippage limit: the final fresh ask
  // and available balance still must pass their own checks before submission.
  const marketBudgetHeadroomBps = 500n;
  // The 1% cap applies to initial margin only. Independently pre-fund any
  // stop-buffer top-up from available VST.
  const quantityUnits = (
    budgetDecimal.units * BigInt(LEVERAGE) * priceScale * quantityScale *
    (10_000n - marketBudgetHeadroomBps)
  ) / (budgetDecimal.scale * maxPriceUnits * 10_000n);
  // The exchange's per-symbol position-value cap can be tighter than the 1%
  // budget. Floor (never round up) the quantity it allows, then take the
  // smaller of the two quantities -- resizing down instead of rejecting the
  // whole signal. If the cap is not tighter, this leaves sizing unchanged.
  const capQuantityUnits = (
    maxPositionValueDecimal.units * priceScale * quantityScale
  ) / (maxPositionValueDecimal.scale * maxPriceUnits);
  const positionCapBound = capQuantityUnits < quantityUnits;
  // Impulse closes exactly 80/20; floor its total to five exchange quantity
  // units so both tranches are representable, without raising the 1% budget.
  const boundedUnits = positionCapBound ? capQuantityUnits : quantityUnits;
  const sizedQuantityUnits = boundedUnits -
    boundedUnits % BigInt(quantityUnitMultiple);
  const finalQuantity = formatUnits(sizedQuantityUnits, quantityPrecision);
  const finalQuantityNumber = Number(sizedQuantityUnits) / Number(quantityScale);
  const finalNotional = finalQuantityNumber * maxPrice;
  const finalInitialMargin = finalNotional / LEVERAGE;
  const finalRawTopUp = Math.max(
    0, (liquidationEstimate + stopBufferVst - stop) * finalQuantityNumber,
  );
  const finalTopUp = finalRawTopUp > 0 ? roundUpToCents(finalRawTopUp) + 0.01 : 0;
  const finalAllocatedMargin = finalInitialMargin + finalTopUp;
  const feeReserveVst = finalNotional * feeRate + finalQuantityNumber * stop * feeRate;
  const requiredAvailableVst = finalAllocatedMargin + feeReserveVst;
  const blockers = [];

  if (finalQuantityNumber < minQuantity) blockers.push("below_minimum_quantity");
  if (finalNotional < minNotional) blockers.push("below_minimum_notional");
  if (finalInitialMargin > budget) blockers.push("initial_margin_exceeds_one_percent_budget");
  if (availableMargin < requiredAvailableVst) blockers.push("insufficient_available_vst");
  // Defensive backstop only: sizedQuantityUnits is already floored to fit
  // within the cap above, so this should never fire except for a residual
  // float rounding step in finalNotional itself.
  if (finalNotional > maxPositionValueVst) blockers.push("exceeds_leverage_position_cap");

  return {
    status: blockers.length ? "blocked" : "ready",
    environment,
    symbol,
    marginAsset: "VST",
    leverage: LEVERAGE,
    marginMode: "ISOLATED",
    balanceSnapshotVst: balance,
    initialBudgetVst: budget,
    allocationBudgetRate: VST_BUDGET_RATE,
    marketBudgetHeadroomRate: Number(marketBudgetHeadroomBps) / 10_000,
    signalReferencePrice: expectedNumber,
    signalPriceDeviationPct: Number(deviationPct.toFixed(6)),
    quotePrice: quoteNumber,
    quoteObservedAtMs: quote.observedAtMs,
    stopLoss: executableStopLoss,
    maxEntryPrice: maxPriceText,
    quantity: finalQuantity,
    entryNotionalVst: finalNotional,
    initialMarginVst: finalInitialMargin,
    takerFeeReserveVst: feeReserveVst,
    fundingRate: Number(fundingText),
    estimatedLiquidationPrice: liquidationEstimate,
    stopBufferVst,
    plannedTopUpVst: finalTopUp,
    reservedTopUpVst: finalTopUp,
    allocatedMarginVst: finalAllocatedMargin,
    requiredAvailableVst,
    availableMarginVst: availableMargin,
    maxPositionValueVst,
    positionCapBound,
    blockers,
  };
}