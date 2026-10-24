import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fundingIntervalFromHours,
  fundingQuantityAt,
  inferFundingInterval,
  reconcilePaperFunding,
} from "../paper-funding.mjs";

const entryAt = Date.parse("2026-01-01T00:00:00.000Z");
const settlementAt = Date.parse("2026-01-01T08:00:00.000Z");

test("validated premium funding interval supplements sparse rate samples", () => {
  assert.equal(fundingIntervalFromHours(8), 8 * 60 * 60_000);
  assert.equal(fundingIntervalFromHours("8"), null);
  assert.equal(fundingIntervalFromHours(0), null);
  assert.equal(inferFundingInterval([
    { fundingTime: settlementAt - 16 * 60 * 60_000 },
    { fundingTime: settlementAt - 8 * 60 * 60_000 },
    { fundingTime: settlementAt },
  ]), 8 * 60 * 60_000);
});

function position() {
  return {
    entryAt: new Date(entryAt).toISOString(),
    entryPrice: 100,
    quantity: 10,
    remainingQty: 8,
    realizedPnlUsdt: -0.5,
    fundingPaidUsdt: 0,
    fundingStatus: "current",
    marketMark: {
      price: "110",
      at: new Date(settlementAt).toISOString(),
      source: "BingX public swap premiumIndex",
    },
    paperFills: [
      {
        type: "entry",
        quantity: 10,
        occurredAt: new Date(entryAt).toISOString(),
      },
      {
        type: "exit",
        quantity: 2,
        occurredAt: new Date(settlementAt - 1000).toISOString(),
      },
    ],
    fundingSettlements: [],
  };
}

test("positive funding is a debit and partial closes determine settlement quantity", async () => {
  const initial = position();
  assert.deepEqual(fundingQuantityAt(initial, settlementAt), {
    quantity: 8,
    reason: null,
  });
  const result = await reconcilePaperFunding(initial, {
    history: [{
      fundingRate: "0.001",
      fundingTime: settlementAt,
    }],
    now: settlementAt + 1000,
    expectedFundingTime: settlementAt,
  });
  assert.equal(result.next.fundingPaidUsdt, 0.88);
  assert.equal(result.next.realizedPnlUsdt, -1.38);
  assert.equal(result.next.fundingStatus, "current");
  assert.deepEqual(result.next.fundingSettlements[0], {
    fundingTime: settlementAt,
    fundingRate: "0.001",
    quantity: 8,
    settlementPrice: 110,
    priceSource: "BingX public premiumIndex mark near funding time",
    priceEstimation: "near_settlement_mark",
    priceObservedAt: new Date(settlementAt).toISOString(),
    signedCostUsdt: 0.88,
    status: "applied",
  });
});

test("validated funding-history markPrice is preferred over premium and kline marks", async () => {
  const initial = position();
  let historicalCalls = 0;
  const result = await reconcilePaperFunding(initial, {
    history: [{
      fundingRate: "0.001",
      fundingTime: settlementAt,
      markPrice: "84057.9",
    }],
    now: settlementAt + 1000,
    expectedFundingTime: settlementAt,
    historicalPrice: async () => {
      historicalCalls += 1;
      return null;
    },
  });
  assert.equal(result.next.fundingSettlements[0].settlementPrice, 84057.9);
  assert.equal(
    result.next.fundingSettlements[0].priceSource,
    "BingX public swap fundingRate markPrice",
  );
  assert.equal(
    result.next.fundingSettlements[0].priceEstimation,
    "validated_funding_history_mark",
  );
  assert.equal(historicalCalls, 0);

  const malformed = await reconcilePaperFunding({
    ...initial,
    marketMark: {
      ...initial.marketMark,
      at: new Date(settlementAt - 10 * 60_000).toISOString(),
    },
  }, {
    history: [{
      fundingRate: "0.001",
      fundingTime: settlementAt,
      markPrice: "0x100",
    }],
    now: settlementAt + 1000,
    expectedFundingTime: settlementAt,
    historicalPrice: async () => ({
      price: "105",
      observedAt: new Date(settlementAt + 60_000).toISOString(),
      source: "BingX public 1m last-trade kline close",
      estimation: "last_trade_kline_close_proxy",
    }),
  });
  assert.equal(malformed.next.fundingSettlements[0].settlementPrice, 105);
  assert.equal(malformed.next.fundingSettlements[0].priceEstimation, "last_trade_kline_close_proxy");
});

test("negative funding is credited to net realized PnL exactly once", async () => {
  const initial = position();
  initial.marketMark.price = "100";
  initial.paperFills[1].occurredAt = new Date(settlementAt + 1000).toISOString();
  const funding = {
    fundingRate: "-0.002",
    fundingTime: settlementAt,
  };
  const first = await reconcilePaperFunding(initial, {
    history: [funding],
    now: settlementAt + 2000,
    expectedFundingTime: settlementAt,
  });
  assert.equal(first.next.fundingPaidUsdt, -2);
  assert.equal(first.next.realizedPnlUsdt, 1.5);
  const retry = await reconcilePaperFunding(first.next, {
    history: [funding],
    now: settlementAt + 3000,
    expectedFundingTime: settlementAt,
  });
  assert.equal(retry.next.fundingPaidUsdt, -2);
  assert.equal(retry.next.realizedPnlUsdt, 1.5);
  assert.equal(retry.next.fundingSettlements.length, 1);
});

test("missing rate history or settlement price stays incomplete instead of assuming zero", async () => {
  const initial = position();
  const noRate = await reconcilePaperFunding(initial, {
    history: [],
    now: settlementAt + 1000,
    expectedFundingTime: settlementAt,
  });
  assert.equal(noRate.next.fundingStatus, "incomplete");
  assert.equal(noRate.next.fundingPaidUsdt, 0);
  assert.equal(noRate.next.realizedPnlUsdt, -0.5);

  initial.marketMark.at = new Date(settlementAt - 10 * 60_000).toISOString();
  const noPrice = await reconcilePaperFunding(initial, {
    history: [{ fundingRate: "0.001", fundingTime: settlementAt }],
    now: settlementAt + 1000,
    expectedFundingTime: settlementAt,
    historicalPrice: async () => null,
  });
  assert.equal(noPrice.next.fundingStatus, "incomplete");
  assert.equal(noPrice.next.fundingPaidUsdt, 0);
  assert.equal(noPrice.next.fundingSettlements[0].status, "incomplete");
});

test("a missing later interval during long downtime remains incomplete after an earlier rate is applied", async () => {
  const initial = position();
  const secondSettlementAt = settlementAt + 8 * 60 * 60_000;
  const result = await reconcilePaperFunding(initial, {
    history: [{
      fundingRate: "0.001",
      fundingTime: settlementAt,
    }],
    now: secondSettlementAt + 1000,
    expectedFundingTime: settlementAt,
    expectedIntervalMs: 8 * 60 * 60_000,
  });
  assert.equal(result.next.fundingPaidUsdt, 0.88);
  assert.equal(result.next.fundingStatus, "incomplete");
});

test("historical 1m close is tagged as a proxy and must be near the funding instant", async () => {
  const initial = position();
  initial.marketMark.at = new Date(settlementAt - 10 * 60_000).toISOString();
  const result = await reconcilePaperFunding(initial, {
    history: [{ fundingRate: "0.001", fundingTime: settlementAt }],
    now: settlementAt + 1000,
    historicalPrice: async () => ({
      price: "105",
      observedAt: new Date(settlementAt + 60_000).toISOString(),
      source: "BingX public 1m last-trade kline close",
      estimation: "last_trade_kline_close_proxy",
    }),
  });
  assert.equal(result.next.fundingPaidUsdt, 0.84);
  assert.equal(result.next.fundingSettlements[0].priceEstimation, "last_trade_kline_close_proxy");

  const tooFar = await reconcilePaperFunding(initial, {
    history: [{ fundingRate: "0.001", fundingTime: settlementAt }],
    now: settlementAt + 1000,
    historicalPrice: async () => ({
      price: "105",
      observedAt: new Date(settlementAt + 120_000).toISOString(),
      source: "BingX public 1m last-trade kline close",
      estimation: "last_trade_kline_close_proxy",
    }),
  });
  assert.equal(tooFar.next.fundingStatus, "incomplete");
  assert.equal(tooFar.next.fundingPaidUsdt, 0);
});

test("entry-time and simultaneous close settlements are excluded or marked ambiguous", async () => {
  const initial = position();
  const simultaneous = {
    ...initial,
    paperFills: [
      initial.paperFills[0],
      { ...initial.paperFills[1], occurredAt: new Date(settlementAt).toISOString() },
    ],
  };
  assert.deepEqual(fundingQuantityAt(simultaneous, settlementAt), {
    quantity: null,
    reason: "settlement_close_time_ambiguous",
  });
  const result = await reconcilePaperFunding(simultaneous, {
    history: [
      { fundingRate: "0.001", fundingTime: entryAt },
      { fundingRate: "0.001", fundingTime: settlementAt },
    ],
    now: settlementAt + 1000,
    expectedFundingTime: settlementAt,
  });
  assert.equal(result.next.fundingSettlements.length, 1);
  assert.equal(result.next.fundingSettlements[0].status, "incomplete");
  assert.equal(result.next.fundingPaidUsdt, 0);
});