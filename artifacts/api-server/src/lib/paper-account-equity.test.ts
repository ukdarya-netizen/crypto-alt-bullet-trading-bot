import assert from "node:assert/strict";
import { test } from "node:test";
import { paperAccountEquity } from "./paper-account-equity";
import type { PaperPositionMarket } from "./paper-position-market";

const base = { initialUsdt: 100, freeUsdt: 100, reservedUsdt: 0, realizedPnlUsdt: 0 };
const at = "2026-09-26T12:00:00.000Z";
const market = (pnl: string | null, status: PaperPositionMarket["quoteStatus"] = "fresh",
  quoteAt: string | null = at): PaperPositionMarket => ({
  quotePrice: status === "unavailable" ? null : "105",
  quoteAt, quoteSource: "BingX public swap ticker",
  quoteStatus: status, priceBasis: "last", unrealizedPnlUsdt: pnl, roePercent: null,
  notionalUsdt: null, projectedExitFeeUsdt: null, pnlAfterExitFeeUsdt: null,
  roeAfterExitFeePercent: null,
});

test("without open positions, current PAPER equity includes realized results", () => {
  assert.deepEqual(paperAccountEquity(
    { ...base, freeUsdt: 94, realizedPnlUsdt: -6 }, [],
  ), {
    status: "no_position", walletUsdt: "94", equityUsdt: "94",
    unrealizedPnlUsdt: "0", changeUsdt: "-6", changePercent: "-6",
    oldestQuoteAt: null,
    fundingStatus: "current", fundingIncompleteCount: 0, fundingLegacyUnknownCount: 0,
    fundingVerifiedSettlementCount: 0, fundingVerifiedNetCostUsdt: "0",
    fundingUnverifiedPositions: [],
    quoteStatus: "no_position", provisionalEquityUsdt: "94",
    provisionalUnrealizedPnlUsdt: "0", provisionalChangeUsdt: "-6",
    provisionalChangePercent: "-6",
  });
});

test("fresh quotes change total equity without subtracting reserved margin twice", () => {
  const result = paperAccountEquity(
    { ...base, freeUsdt: 80, reservedUsdt: 10, realizedPnlUsdt: -10 },
    [
      { market: market("2.5", "fresh", "2026-09-26T12:00:10.000Z") },
      { market: market("-3", "fresh", at) },
    ],
  );
  assert.deepEqual(result, {
    status: "fresh", walletUsdt: "90", equityUsdt: "89.5",
    unrealizedPnlUsdt: "-0.5", changeUsdt: "-10.5", changePercent: "-10.5",
    oldestQuoteAt: at,
    fundingStatus: "current", fundingIncompleteCount: 0, fundingLegacyUnknownCount: 0,
    fundingVerifiedSettlementCount: 0, fundingVerifiedNetCostUsdt: "0",
    fundingUnverifiedPositions: [],
    quoteStatus: "fresh", provisionalEquityUsdt: "89.5",
    provisionalUnrealizedPnlUsdt: "-0.5", provisionalChangeUsdt: "-10.5",
    provisionalChangePercent: "-10.5",
  });
});

test("a new saved quote changes PAPER equity while reserved margin stays the same", () => {
  const account = { ...base, freeUsdt: 90, reservedUsdt: 10 };
  const rising = paperAccountEquity(account, [{ market: market("2.5") }]);
  const falling = paperAccountEquity(account, [{ market: market("-2") }]);
  assert.equal(rising.equityUsdt, "102.5");
  assert.equal(rising.changeUsdt, "2.5");
  assert.equal(falling.equityUsdt, "98");
  assert.equal(falling.changeUsdt, "-2");
  assert.equal(falling.walletUsdt, rising.walletUsdt);
});

test("stale, missing or malformed open-position estimates never become zero PnL", () => {
  const account = { ...base, freeUsdt: 90, reservedUsdt: 10 };
  for (const unsafe of [market(null, "stale"), market(null, "unavailable", null), market(null), market("NaN")]) {
    const result = paperAccountEquity(account, [
      { market: market("2.5") }, { market: unsafe },
    ]);
    assert.equal(result.walletUsdt, "100");
    assert.equal(result.equityUsdt, null);
    assert.equal(result.changeUsdt, null);
    assert.equal(result.unrealizedPnlUsdt, null);
    assert.equal(result.provisionalEquityUsdt, null);
    assert.equal(result.provisionalUnrealizedPnlUsdt, null);
    assert.equal(result.provisionalChangeUsdt, null);
  }
});

test("unreconciled funding preserves definitive nulls but exposes a fresh provisional estimate", () => {
  const result = paperAccountEquity(
    // Stored realized fees and fills have already reduced free balance. The
    // estimate includes that wallet effect exactly once, plus open unrealized PnL.
    { ...base, freeUsdt: 85.5, reservedUsdt: 10, realizedPnlUsdt: -4.5 },
    [{ market: market("2.5"), snapshot: { fundingStatus: "incomplete" } }],
  );
  assert.equal(result.status, "funding_incomplete");
  assert.equal(result.walletUsdt, "95.5");
  assert.equal(result.equityUsdt, null);
  assert.equal(result.changeUsdt, null);
  assert.equal(result.unrealizedPnlUsdt, null);
  assert.equal(result.provisionalEquityUsdt, "98");
  assert.equal(result.provisionalUnrealizedPnlUsdt, "2.5");
  assert.equal(result.provisionalChangeUsdt, "-2");
  assert.equal(result.provisionalChangePercent, "-2");
  assert.equal(result.fundingStatus, "incomplete");
  assert.equal(result.fundingIncompleteCount, 1);
  assert.equal(result.quoteStatus, "fresh");
});

test("stale or unavailable quotes suppress provisional equity even when funding is incomplete", () => {
  const account = { ...base, freeUsdt: 90, reservedUsdt: 10 };
  for (const stale of [market("2.5", "stale"), market(null, "unavailable", null)]) {
    const result = paperAccountEquity(
      account,
      [{ market: stale, snapshot: { fundingStatus: "incomplete" } }],
    );
    assert.equal(result.status, "funding_incomplete");
    assert.equal(result.equityUsdt, null);
    assert.equal(result.provisionalEquityUsdt, null);
    assert.equal(result.provisionalUnrealizedPnlUsdt, null);
    assert.equal(result.provisionalChangeUsdt, null);
    assert.equal(result.quoteStatus, stale.quoteStatus);
  }
});

test("closed PAPER funding unknown keeps the wallet visible as provisional equity without open quotes", () => {
  const result = paperAccountEquity(
    { ...base, freeUsdt: 101, realizedPnlUsdt: 1 },
    [],
    { incompleteCount: 1, legacyUnknownCount: 0 },
  );
  assert.equal(result.status, "funding_incomplete");
  assert.equal(result.walletUsdt, "101");
  assert.equal(result.equityUsdt, null);
  assert.equal(result.provisionalEquityUsdt, "101");
  assert.equal(result.provisionalUnrealizedPnlUsdt, "0");
  assert.equal(result.provisionalChangeUsdt, "1");
  assert.equal(result.quoteStatus, "no_position");
  assert.equal(result.fundingIncompleteCount, 1);
});

test("legacy closed funding status is explicitly counted while the wallet remains provisional", () => {
  const result = paperAccountEquity(
    { ...base, freeUsdt: 101, realizedPnlUsdt: 1 },
    [],
    { incompleteCount: 0, legacyUnknownCount: 2 },
  );
  assert.equal(result.fundingStatus, "incomplete");
  assert.equal(result.fundingLegacyUnknownCount, 2);
  assert.equal(result.provisionalEquityUsdt, "101");
});