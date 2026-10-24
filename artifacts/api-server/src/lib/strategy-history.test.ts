import assert from "node:assert/strict";
import { test } from "node:test";
import Decimal from "decimal.js";
import { liveStrategyTrade, paperStrategyTrade } from "./strategy-history";

const closedPaper = {
  source_signal_id: "signal-1",
  pattern_id: "liquidation_cascade",
  symbol: "BTCUSDT",
  status: "closed",
  entry_margin: "12",
  snapshot: {
    entryAt: "2026-09-01T12:00:00Z",
    realizedPnlUsdt: "3.25", // already includes the 0.25 funding debit
    fundingPaidUsdt: "0.25",
    fundingStatus: "current",
    paperFills: [
      { type: "entry", occurredAt: "2026-09-01T12:00:00Z" },
      { type: "exit", occurredAt: "2026-09-10T12:00:00Z" },
      { type: "exit", occurredAt: "2026-10-02T12:00:00Z" },
    ],
  },
};

test("all entered PAPER trades retain four scenario slots even without historical observations", () => {
  for (const status of ["open", "closed"]) {
    const trade = paperStrategyTrade({ ...closedPaper, status }, new Decimal(1000));
    assert.deepEqual(trade.scenarios.map((scenario) => scenario.strategyId), [1, 2, 3, 4]);
    assert.ok(trade.scenarios.every((scenario) => scenario.status === "unobserved"));
    assert.ok(trade.scenarios.every((scenario) => scenario.profitUsdt === null));
    assert.equal(trade.allocatedPercent, "1.200000");
    if (status === "closed") assert.equal(trade.profitPercent, "0.325000");
  }
});

test("a missing classic variant in an older model is unobserved, not fabricated", () => {
  const trade = paperStrategyTrade({
    ...closedPaper,
    snapshot: { ...closedPaper.snapshot, scenarioModel: {
      version: "prospective_observed_quotes_v1", variants: {},
    } },
  }, new Decimal(1000));
  assert.equal(trade.scenarios[0].status, "unobserved");
  assert.equal(trade.scenarios[0].profitUsdt, null);
});

test("closed PAPER trade uses net realized PnL once and opening margin", () => {
  const trade = paperStrategyTrade(closedPaper, new Decimal(100));
  assert.equal(trade.executedStrategyId, null);
  assert.equal(trade.closedAt, "2026-10-02T12:00:00.000Z");
  assert.equal(trade.profitUsdt, "3.25000000");
  assert.equal(trade.profitPercent, "3.250000");
  assert.equal(trade.tradeProfitPercent, "27.083333");
  assert.equal(trade.allocatedPercent, "12.000000");
  assert.equal(trade.accountingStatus, "verified");
});

test("incomplete funding and open trades never show final profit", () => {
  const incomplete = paperStrategyTrade({
    ...closedPaper,
    snapshot: { ...closedPaper.snapshot, fundingStatus: "incomplete" },
  }, new Decimal(100));
  assert.equal(incomplete.profitUsdt, null);
  assert.equal(incomplete.profitPercent, null);
  assert.equal(incomplete.tradeProfitPercent, null);
  assert.equal(incomplete.accountingStatus, "incomplete");

  const open = paperStrategyTrade({
    ...closedPaper,
    status: "open",
  }, new Decimal(100));
  assert.equal(open.profitUsdt, null);
  assert.equal(open.tradeProfitPercent, null);
  assert.equal(open.closedAt, null);
});

test("REAL position is visible without inventing a yield or margin allocation", () => {
  const trade = liveStrategyTrade({
    signal_id: "signal-2",
    pattern_id: "impulse_buy",
    environment: "mainnet",
    symbol: "ETHUSDT",
    status: "closed",
    signal_at: "2026-09-01T12:00:00Z",
    snapshot: { closedAt: "2026-09-03T12:00:00Z" },
  });
  assert.equal(trade.environment, "live");
  assert.equal(trade.accountingStatus, "incomplete");
  assert.equal(trade.profitUsdt, null);
  assert.equal(trade.tradeProfitPercent, null);
  assert.equal(trade.allocatedPercent, null);
});

test("REAL net PnL counts own partial exits, USDT fees and signed funding exactly once", () => {
  const baseline = new Decimal("113.0319");
  const facts = {
    signal_id: "signal-3",
    pattern_id: "liquidation_cascade",
    environment: "mainnet",
    symbol: "BTCUSDT",
    status: "closed",
    signal_at: "2026-09-28T08:00:00Z",
    snapshot: { entryAt: "2026-09-28T08:00:00Z", remainingQty: 0 },
    allocation_usdt: "10",
    allocation_deposit_usdt: "113.0319",
    coverage_through: "2026-09-30T00:00:00Z",
    unresolved_intents: 0,
    fills: [
      { phase: "supervised-one-shot-entry", state: "reconciled", side: "BUY",
        quantity: "2", price: "100", fee: "0.20", feeAsset: "USDT", filledAt: "2026-09-28T08:00:00Z" },
      { phase: "take", state: "reconciled", side: "SELL",
        quantity: "1", price: "105", fee: "0.105", feeAsset: "USDT", filledAt: "2026-09-29T08:00:00Z" },
      { phase: "exit", state: "reconciled", side: "SELL",
        quantity: "1", price: "100", fee: "0.10", feeAsset: "USDT", filledAt: "2026-09-29T09:00:00Z" },
    ],
    funding: [{ amount: "-0.25", settledAt: "2026-09-29T00:00:00Z" }],
  };
  const verified = liveStrategyTrade(facts, baseline, "2026-09-27T06:24:14.363Z");
  assert.equal(verified.accountingStatus, "verified");
  assert.equal(verified.profitUsdt, "4.34500000");
  assert.equal(verified.tradeProfitPercent, "43.450000");
  assert.equal(verified.allocatedPercent, "8.847060");
  assert.equal(verified.closedAt, "2026-09-29T09:00:00.000Z");
  assert.equal(verified.executedStrategyId, null);

  for (const changed of [
    { coverage_through: null },
    { unresolved_intents: 1 },
    { allocation_usdt: null },
    { fills: facts.fills.slice(0, 2) },
    { fills: [{ ...facts.fills[0], fee: null }, ...facts.fills.slice(1)] },
    { fills: [facts.fills[0], { ...facts.fills[1], phase: "external" }, facts.fills[2]] },
    { snapshot: { ...facts.snapshot, externalClose: true } },
    { funding: [{ amount: "0.2", settledAt: "2026-10-01T00:00:00Z" }] },
  ]) {
    const incomplete = liveStrategyTrade({ ...facts, ...changed }, baseline, "2026-09-27T06:24:14.363Z");
    assert.equal(incomplete.accountingStatus, "incomplete");
    assert.equal(incomplete.profitUsdt, null);
  }
});

test("break-even on the remainder retains profit from an earlier partial exit", () => {
  const trade = paperStrategyTrade({
    ...closedPaper,
    entry_margin: "10",
    snapshot: {
      ...closedPaper.snapshot,
      paperExitPolicy: { version: "owner_strategy_4_v1" },
      realizedPnlUsdt: "1.80",
      paperFills: [
        { type: "entry", occurredAt: "2026-09-01T12:00:00Z" },
        { type: "exit", quantity: 0.25, occurredAt: "2026-09-02T12:00:00Z" },
        { type: "exit", quantity: 0.75, occurredAt: "2026-09-03T12:00:00Z", reason: "stop_at_break_even" },
      ],
    },
  }, new Decimal(100));
  assert.equal(trade.profitUsdt, "1.80000000");
  assert.equal(trade.executedStrategyId, 4);
  assert.equal(trade.tradeProfitPercent, "18.000000");
  assert.equal(trade.profitPercent, "1.800000");
  assert.equal(trade.allocatedPercent, "10.000000");
});