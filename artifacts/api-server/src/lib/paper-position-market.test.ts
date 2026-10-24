import assert from "node:assert/strict";
import { test } from "node:test";
import { paperPositionMarket } from "./paper-position-market";

const now = Date.parse("2026-03-01T12:00:00.000Z");
const position = (overrides: Record<string, unknown> = {}) => ({
  mode: "paper",
  entryPrice: "100",
  remainingQty: "0.25",
  marginHeldUsd: "10",
  marketQuote: {
    price: "110",
    at: new Date(now).toISOString(),
    source: "BingX public swap ticker",
  },
  ...overrides,
});

test("fresh saved quote returns precise long mark estimates", () => {
  assert.deepEqual(paperPositionMarket(position(), now), {
    quotePrice: "110",
    quoteAt: new Date(now).toISOString(),
    quoteSource: "BingX public swap ticker",
    quoteStatus: "fresh",
    priceBasis: "last",
    unrealizedPnlUsdt: "2.5",
    roePercent: "25",
    notionalUsdt: "27.5",
    projectedExitFeeUsdt: "0.01375",
    pnlAfterExitFeeUsdt: "2.48625",
    roeAfterExitFeePercent: "24.8625",
  });
});

test("fresh verified BingX mark is preferred to last trade for unrealized PnL", () => {
  const result = paperPositionMarket(position({
    marketMark: {
      price: "112",
      at: new Date(now).toISOString(),
      source: "BingX public swap premiumIndex",
    },
  }), now);
  assert.equal(result.priceBasis, "mark");
  assert.equal(result.quotePrice, "112");
  assert.equal(result.unrealizedPnlUsdt, "3");
  assert.equal(result.projectedExitFeeUsdt, "0.014");
  assert.equal(result.pnlAfterExitFeeUsdt, "2.986");
});

test("stale or untrusted mark falls back to the clearly labeled last trade", () => {
  for (const mark of [
    { price: "120", at: new Date(now - 90_001).toISOString(), source: "BingX public swap premiumIndex" },
    { price: "120", at: new Date(now).toISOString(), source: "unknown" },
  ]) {
    const result = paperPositionMarket(position({ marketMark: mark }), now);
    assert.equal(result.priceBasis, "last");
    assert.equal(result.quotePrice, "110");
  }
});

test("stale quote remains displayable but has no numeric estimates", () => {
  const result = paperPositionMarket(position({
    marketQuote: {
      price: "110",
      at: new Date(now - 90_001).toISOString(),
      source: "BingX public swap ticker",
    },
  }), now);
  assert.equal(result.quoteStatus, "stale");
  assert.equal(result.quotePrice, "110");
  assert.equal(result.quoteAt, new Date(now - 90_001).toISOString());
  assert.equal(result.unrealizedPnlUsdt, null);
  assert.equal(result.roePercent, null);
  assert.equal(result.notionalUsdt, null);
  assert.equal(result.pnlAfterExitFeeUsdt, null);
});

test("invalid and absent quotes are unavailable without fake zeroes", () => {
  const invalid = paperPositionMarket(position({
    marketQuote: { price: "NaN", at: new Date(now).toISOString(), source: "BingX" },
  }), now);
  assert.equal(invalid.quoteStatus, "unavailable");
  assert.equal(invalid.quotePrice, null);
  assert.equal(invalid.unrealizedPnlUsdt, null);
  assert.equal(invalid.notionalUsdt, null);
  assert.equal(invalid.roePercent, null);

  const unknownSource = paperPositionMarket(position({
    marketQuote: { price: "110", at: new Date(now).toISOString(), source: "unknown" },
  }), now);
  assert.equal(unknownSource.quoteStatus, "unavailable");
  assert.equal(unknownSource.quotePrice, null);
  assert.equal(unknownSource.quoteSource, null);
  assert.equal(unknownSource.unrealizedPnlUsdt, null);

  const absent = paperPositionMarket(position({ marketQuote: undefined }), now);
  assert.equal(absent.quoteStatus, "unavailable");
  assert.equal(absent.quotePrice, null);
  assert.equal(absent.quoteAt, null);
  assert.equal(absent.quoteSource, null);
  assert.equal(absent.unrealizedPnlUsdt, null);
  assert.equal(absent.roePercent, null);
  assert.equal(absent.notionalUsdt, null);
});

test("future quotes outside tolerance and invalid sizing inputs suppress estimates", () => {
  const future = paperPositionMarket(position({
    marketQuote: {
      price: "110",
      at: new Date(now + 5_001).toISOString(),
      source: "BingX",
    },
  }), now);
  assert.equal(future.quoteStatus, "unavailable");
  assert.equal(future.unrealizedPnlUsdt, null);

  const invalidPosition = paperPositionMarket(position({ remainingQty: "0" }), now);
  assert.equal(invalidPosition.quoteStatus, "fresh");
  assert.equal(invalidPosition.unrealizedPnlUsdt, null);
  assert.equal(invalidPosition.notionalUsdt, null);
  assert.equal(invalidPosition.roePercent, null);
});

test("fresh market quote cannot mark a non-PAPER position", () => {
  const result = paperPositionMarket(position({ mode: "live" }), now);
  assert.equal(result.quoteStatus, "fresh");
  assert.equal(result.quotePrice, "110");
  assert.equal(result.unrealizedPnlUsdt, null);
  assert.equal(result.roePercent, null);
  assert.equal(result.notionalUsdt, null);
});