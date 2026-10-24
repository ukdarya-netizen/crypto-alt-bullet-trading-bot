import assert from "node:assert/strict";
import test from "node:test";
import { sizeVstLongTrade } from "../vst-sizing.mjs";

const NOW = 1_800_000_000_000;
const base = {
  environment: "vst",
  symbol: "BTCUSDT",
  balanceSnapshot: {
    asset: "VST",
    balance: "98455.6472",
    equity: "98455.6472",
    availableMargin: "98455.6472",
  },
  quote: { price: "100", observedAtMs: NOW - 1_000 },
  nowMs: NOW,
  maxQuoteAgeMs: 10_000,
  expectedPrice: "100",
  maxSlippageBps: 100,
  stopLoss: "95",
  filters: {
    symbol: "BTC-USDT",
    quantityPrecision: 3,
    pricePrecision: 2,
    minQuantity: "0.001",
    minNotional: "5",
  },
  takerFeeRate: "0.0005",
  fundingRate: 0,
  maintenanceMarginRate: "0.01",
  stopBufferRate: "0.005",
  tickSize: "0.01",
  maxPositionValue: "1000000",
};

test("sizes against one percent of total VST balance at isolated 10x", () => {
  const result = sizeVstLongTrade(base);
  assert.equal(result.status, "ready");
  assert.equal(result.initialBudgetVst, 984.556472);
  assert.equal(result.leverage, 10);
  assert.equal(result.marginMode, "ISOLATED");
  assert.equal(result.maxEntryPrice, "101");
  assert.ok(result.entryNotionalVst <= result.initialBudgetVst * 10);
  assert.ok(result.initialMarginVst <= result.initialBudgetVst);
  assert.equal(result.marketBudgetHeadroomRate, 0.05);
  assert.equal(result.quantity, "92.606");
  assert.ok(Number(result.quantity) * 104 / 10 <= result.initialBudgetVst,
    "a moderately higher final ask still fits the one-percent margin ceiling");
  assert.ok(Number(result.quantity) * 107 / 10 > result.initialBudgetVst,
    "headroom is not permission to exceed the one-percent margin ceiling");
});

test("impulse quantity floors to five exchange units without exceeding budget or cap", () => {
  const result = sizeVstLongTrade({
    ...base,
    balanceSnapshot: { ...base.balanceSnapshot, balance: "98456.11" },
    quantityUnitMultiple: 5,
  });
  assert.equal(result.status, "ready");
  assert.equal(Math.round(Number(result.quantity) * 1000) % 5, 0);
  assert.ok(result.initialMarginVst <= result.initialBudgetVst);
  assert.ok(result.entryNotionalVst <= result.maxPositionValueVst);
  const capped = sizeVstLongTrade({
    ...base, maxPositionValue: "500", quantityUnitMultiple: 5,
  });
  assert.equal(capped.status, "ready");
  assert.equal(Math.round(Number(capped.quantity) * 1000) % 5, 0);
  assert.ok(capped.entryNotionalVst <= 500);
});

test("blocks when contract minimum quantity cannot be met by the budget", () => {
  const result = sizeVstLongTrade({
    ...base,
    balanceSnapshot: { asset: "VST", balance: "0.05", availableMargin: "0.05" },
    filters: { ...base.filters, minQuantity: "0.01" },
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.includes("below_minimum_quantity"));
});

test("requires available VST for isolated margin plus fee reserves", () => {
  const result = sizeVstLongTrade({
    ...base,
    balanceSnapshot: { ...base.balanceSnapshot, availableMargin: "10" },
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.requiredAvailableVst > result.availableMarginVst);
  assert.ok(result.blockers.includes("insufficient_available_vst"));
});

test("resizes down to fit within the exchange's per-leverage position cap instead of skipping the signal", () => {
  const result = sizeVstLongTrade({
    ...base,
    // One percent of this balance at 10x is far above a 500 USDT cap, mirroring
    // BingX code 101209 ("the maximum position value for this leverage is X USDT").
    maxPositionValue: "500",
  });
  assert.equal(result.status, "ready");
  assert.equal(result.maxPositionValueVst, 500);
  assert.equal(result.positionCapBound, true);
  assert.ok(result.entryNotionalVst <= result.maxPositionValueVst);
  // The capped size should use nearly all of the 500 USDT allowance, not an
  // arbitrarily small fraction of it.
  assert.ok(result.entryNotionalVst > result.maxPositionValueVst - 1);
  assert.deepEqual(result.blockers, []);
});

test("stays ready and unresized when sizing lands under the exchange's per-leverage position cap", () => {
  const result = sizeVstLongTrade({ ...base, maxPositionValue: "100000" });
  assert.equal(result.status, "ready");
  assert.equal(result.maxPositionValueVst, 100000);
  assert.equal(result.positionCapBound, false);
  assert.ok(result.entryNotionalVst <= result.maxPositionValueVst);
  assert.equal(result.quantity, "92.606");
});

test("still blocks with a clear reason when even the capped size is below minimum notional", () => {
  const result = sizeVstLongTrade({ ...base, maxPositionValue: "3" });
  assert.equal(result.status, "blocked");
  assert.equal(result.positionCapBound, true);
  assert.ok(result.entryNotionalVst < base.filters.minNotional);
  assert.ok(result.blockers.includes("below_minimum_notional"));
  assert.ok(!result.blockers.includes("exceeds_leverage_position_cap"));
});

test("still blocks with a clear reason when even the capped size is below minimum quantity", () => {
  const result = sizeVstLongTrade({
    ...base,
    filters: { ...base.filters, minQuantity: "1", minNotional: "5" },
    maxPositionValue: "50",
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.positionCapBound, true);
  assert.ok(Number(result.quantity) < 1);
  assert.ok(result.blockers.includes("below_minimum_quantity"));
  assert.ok(!result.blockers.includes("below_minimum_notional"));
});

test("fails closed when the exchange's maximum position value is missing or invalid", () => {
  assert.throws(() => sizeVstLongTrade({ ...base, maxPositionValue: undefined }),
    /maximum position value/);
  assert.throws(() => sizeVstLongTrade({ ...base, maxPositionValue: "0" }),
    /maximum position value/);
  assert.throws(() => sizeVstLongTrade({ ...base, maxPositionValue: "-5000" }),
    /maximum position value/);
});

test("records large signed signal-to-market deviations without rejecting safe market pricing", () => {
  const higher = sizeVstLongTrade({
    ...base,
    quote: { price: "106", observedAtMs: NOW - 1_000 },
  });
  assert.equal(higher.status, "ready");
  assert.equal(higher.signalReferencePrice, 100);
  assert.equal(higher.quotePrice, 106);
  assert.equal(higher.signalPriceDeviationPct, 6);
  assert.equal(higher.maxEntryPrice, "107.06");

  const lower = sizeVstLongTrade({
    ...base,
    quote: { price: "80", observedAtMs: NOW - 1_000 },
    stopLoss: "70",
  });
  assert.equal(lower.status, "ready");
  assert.equal(lower.signalPriceDeviationPct, -20);
  assert.equal(lower.maxEntryPrice, "80.8");
  assert.throws(() => sizeVstLongTrade({
    ...base, expectedPrice: "0",
  }), /expected price must be greater than zero/);
});

test("rounds a LONG stop toward entry using verified contract price precision", () => {
  const input = {
    ...base,
    symbol: "ARXUSDT",
    filters: { ...base.filters, symbol: "ARX-USDT", pricePrecision: 4 },
    quote: { price: "0.2964", observedAtMs: NOW - 1_000 },
    expectedPrice: "0.2964",
    stopLoss: "0.272688",
    tickSize: "0.0001",
  };
  const result = sizeVstLongTrade(input);
  assert.equal(result.stopLoss, "0.2727");
  assert.ok(Number(result.stopLoss) >= Number(input.stopLoss));
  assert.ok(Number(result.stopLoss) < Number(input.quote.price));
  assert.throws(() => sizeVstLongTrade({
    ...input, quote: { price: "0.27269", observedAtMs: NOW - 1_000 },
    expectedPrice: "0.27269", stopLoss: "0.272688",
  }), /Long stop loss must be below the current quote/);
});

test("preplans a deep-stop top-up above one percent while keeping initial margin capped", () => {
  const result = sizeVstLongTrade({
    ...base,
    stopLoss: "70",
    stopBufferRate: "0.02",
  });
  assert.equal(result.status, "ready");
  assert.equal(result.quantity, "92.606");
  assert.ok(result.initialMarginVst <= result.initialBudgetVst);
  assert.ok(result.plannedTopUpVst > result.initialBudgetVst);
  assert.equal(result.reservedTopUpVst, result.plannedTopUpVst);
  assert.ok(result.allocatedMarginVst > result.initialBudgetVst);
  assert.deepEqual(result.blockers, []);
});

test("rejects a preplanned top-up when total required funds exceed available VST", () => {
  const result = sizeVstLongTrade({
    ...base,
    balanceSnapshot: { ...base.balanceSnapshot, availableMargin: "2000" },
    stopLoss: "70",
    stopBufferRate: "0.02",
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.initialMarginVst < result.availableMarginVst);
  assert.ok(result.requiredAvailableVst > result.availableMarginVst);
  assert.ok(result.blockers.includes("insufficient_available_vst"));
});

test("rejects ambiguous or missing VST balance rows and never accepts mainnet", () => {
  assert.throws(() => sizeVstLongTrade({
    ...base,
    balanceSnapshot: [
      base.balanceSnapshot,
      { asset: "VST", balance: "100", availableMargin: "100" },
    ],
  }), /exactly one VST row/);
  assert.throws(() => sizeVstLongTrade({
    ...base,
    environment: "mainnet",
  }), /outside the VST environment/);
});

test("stale quotes and unsupported symbols are rejected", () => {
  assert.throws(() => sizeVstLongTrade({
    ...base,
    quote: { price: "100", observedAtMs: NOW - 20_000 },
  }), /stale/);
  assert.throws(() => sizeVstLongTrade({ ...base, symbol: "ETHUSDT" }), /Verified active USDT contract filters/);
  assert.throws(() => sizeVstLongTrade({
    ...base,
    symbol: "ETHUSD",
    filters: { ...base.filters, symbol: "ETH-USD" },
  }), /canonical USDT perpetual symbol/);
});

test("sizes other USDT perpetuals only with matching verified contract metadata", () => {
  const result = sizeVstLongTrade({
    ...base,
    symbol: "ETHUSDT",
    expectedPrice: "100",
    quote: { price: "100", observedAtMs: NOW - 1_000 },
    filters: { ...base.filters, symbol: "ETH-USDT" },
  });
  assert.equal(result.status, "ready");
  assert.equal(result.symbol, "ETHUSDT");
  assert.throws(() => sizeVstLongTrade({
    ...base,
    symbol: "BTCUSDC",
    filters: { ...base.filters, symbol: "BTC-USDC" },
  }), /canonical USDT perpetual symbol/);
});