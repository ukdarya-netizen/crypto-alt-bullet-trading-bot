import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { mapJournalTrade } from "./journal";
import { classifyExchangeState, withTestnetControlFence } from "./testnet-execution";

test("exchange acceptance and partial fills do not claim completed execution", () => {
  assert.deepEqual(classifyExchangeState({ orderStatus: "New", cumExecQty: "0" }), {
    status: "new", signalStatus: "processing",
  });
  assert.deepEqual(classifyExchangeState({ orderStatus: "PartiallyFilled", cumExecQty: "0.1" }), {
    status: "partiallyfilled", signalStatus: "processing",
  });
  assert.deepEqual(classifyExchangeState({ orderStatus: "Filled", cumExecQty: "1" }), {
    status: "filled", signalStatus: "executed",
  });
  assert.deepEqual(classifyExchangeState({ orderStatus: "Filled", cumExecQty: "1" }), {
    status: "filled", signalStatus: "executed",
  });
  assert.deepEqual(classifyExchangeState({ orderStatus: "Cancelled", cumExecQty: "0" }), {
    status: "cancelled", signalStatus: "failed",
  });
});

test("unverified exchange closure never inherits old exit/PnL fields", () => {
  const order = {
    id: randomUUID(), status: "closure_unverified", protectionStatus: "reconciliation_required",
    symbol: "BTCUSDT", side: "buy", filledQuantity: "1", averagePrice: "10",
    quantity: "1", createdAt: new Date(), paperEntryOrderId: null,
  } as Parameters<typeof mapJournalTrade>[0];
  const details = {
    environment: "testnet", instrumentType: "linear", exitAt: new Date(),
    exitPrice: "12", entryFee: "0.1", exitFee: "0.1", funding: "0.1",
    markPrice: "12", markAt: new Date(),
  } as Parameters<typeof mapJournalTrade>[1];
  const signal = { sourceSignalId: "exchange-entry", reduceOnly: false } as Parameters<typeof mapJournalTrade>[2];
  const trade = mapJournalTrade(order, details, signal);
  assert.equal(trade.environment, "testnet");
  assert.equal(trade.status, "open");
  assert.equal(trade.exitPrice, null);
  assert.equal(trade.exitAt, null);
  assert.equal(trade.markPrice, null);
  assert.equal(trade.grossPnl, null);
  assert.equal(trade.netPnl, null);
  assert.equal(trade.unrealizedPnl, null);
  assert.equal(trade.calculationStatus, "incomplete");
});

test("the final control-row lock spans dispatch, and a kill switch prevents dispatch", async () => {
  const events: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const makeClient = (killSwitch: boolean) => ({
    query: async (sql: string) => {
      events.push(sql === "BEGIN" ? "begin" : sql === "ROLLBACK" ? "unlock" : "lock");
      return { rows: [{ mode: "testnet", kill_switch_active: killSwitch,
        accepting_new_entries: true, max_notional_per_order: "100" }] };
    },
    release: () => { events.push("release"); },
  });
  const request = withTestnetControlFence(50, async () => {
    events.push("dispatch");
    await pending;
    events.push("exchange response");
  }, async () => makeClient(false) as never);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["begin", "lock", "dispatch"]);
  release();
  await request;
  assert.deepEqual(events, ["begin", "lock", "dispatch", "exchange response", "unlock", "release"]);

  events.length = 0;
  await assert.rejects(withTestnetControlFence(50, async () => {
    events.push("dispatch");
  }, async () => makeClient(true) as never), /safety controls changed/);
  assert.deepEqual(events, ["begin", "lock", "unlock", "release"]);
});