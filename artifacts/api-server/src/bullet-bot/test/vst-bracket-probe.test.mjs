import assert from "node:assert/strict";
import test from "node:test";
import { inspectVstBracketCohort, runControlledVstBracketProbe } from "../vst-bracket-probe.mjs";
import { createBingXLiveApi } from "../bingx-live-api.mjs";

function fixture({ entryAmbiguous = false, takeAmbiguous = false,
  closeAmbiguous = false, occupied = false, saveFails = false, takeDelayed = false } = {}) {
  const rows = new Map();
  const journal = [];
  const calls = [];
  let position = occupied ? { positionId: "999", positionSide: "LONG", positionAmt: "1" } : null;
  let serial = 0;
  let takeQuantity;
  let delayedRead = false;
  const api = {
    contract: async () => ({ pricePrecision: 2, quantityPrecision: 3,
      minQuantity: 0.001, minNotional: 2 }),
    getPositions: async () => position ? [structuredClone(position)] : [],
    getOpenOrders: async () => [...rows.values()].filter((row) => {
      if (row.orderId === "102" && takeDelayed && !delayedRead) {
        delayedRead = true;
        return false;
      }
      return row.status === "NEW";
    }),
    getPositionMode: async () => "HEDGE",
    getMarginType: async () => "ISOLATED",
    getLeverage: async () => ({ longLeverage: 10 }),
    getVstMarkPrice: async () => ({ markPrice: 100, timestamp: 1000 }),
    placeVstBoundedLong: async (request) => {
      calls.push("entry");
      takeQuantity = request.quantity;
      rows.set("101", { orderId: "101", symbol: "BTC-USDT", side: "BUY",
        positionSide: "LONG", status: "FILLED", clientOrderId: request.clientOrderId,
        executedQty: request.quantity, avgPrice: "100" });
      position = { positionId: "201", positionSide: "LONG", positionAmt: request.quantity };
      rows.set("103", { orderId: "103", symbol: "BTC-USDT", side: "SELL",
        positionSide: "LONG", status: "NEW", type: "STOP_MARKET",
        mainOrderId: "101", origQty: request.quantity, stopPrice: request.stopLoss });
      if (entryAmbiguous) throw Error("entry_ack_lost");
    },
    queryOrder: async (_, identifier) => {
      const row = identifier.orderId ? rows.get(identifier.orderId)
        : [...rows.values()].find((row) => row.clientOrderId === identifier.clientOrderId);
      return structuredClone(row ?? {});
    },
    closeLong: async (_, quantity, clientOrderId, expectedPositionId) => {
      calls.push("close");
      assert.equal(expectedPositionId, "201");
      assert.equal(quantity, takeQuantity);
      assert.ok(rows.get("103").status === "NEW", "do not remove SL before closing");
      position = null;
      rows.set("104", { orderId: "104", side: "SELL", positionSide: "LONG",
        status: "FILLED", clientOrderId, executedQty: quantity, avgPrice: "100.01" });
      if (closeAmbiguous) throw Error("close_ack_lost");
    },
  };
  const args = {
    api, clock: () => 1000, makeId: () => `vbp_test${++serial}`, readDelay: async () => {},
    save: async (state) => {
      if (saveFails) throw Error("journal_unavailable");
      journal.push(structuredClone(state));
    },
    submitTake: async (params, guard) => {
      await guard();
      calls.push("take");
      assert.equal(params.stopPrice, "105.00");
      assert.equal(params.type, "TAKE_PROFIT_MARKET");
      assert.equal(params.closePosition, "true");
      rows.set("102", { ...params, orderId: "102", origQty: params.quantity,
        status: "NEW", positionID: "201" });
      if (takeAmbiguous) throw Error("take_ack_lost");
      return { order: { orderId: "102" } };
    },
    cancelProtective: async (params, guard) => {
      await guard();
      assert.equal(position, null);
      calls.push(`cancel:${params.orderId}`);
      rows.get(params.orderId).status = "CANCELED";
    },
  };
  return { args, calls, journal, rows, position: () => position };
}

test("VST bracket probe independently proves both orders, then closes before cancellation", async () => {
  const f = fixture();
  const result = await runControlledVstBracketProbe(f.args);
  assert.equal(result.phase, "completed");
  assert.equal(result.finished, true);
  assert.equal(result.finalPositionCount, 0);
  assert.equal(result.finalOrderCount, 0);
  assert.ok(Number(result.quantity) * Number(result.maxPrice) / 10 <= 10);
  assert.deepEqual(f.calls, ["entry", "take", "close", "cancel:103", "cancel:102"]);
  assert.ok(f.journal.some((row) => row.phase === "dual_orders_verified"));
  assert.equal(f.journal.at(-1).takePrice, "105.00");
  await runControlledVstBracketProbe({ ...f.args, state: result });
  assert.equal(f.calls.filter((call) => call === "entry").length, 1);
});

test("VST bracket probe recovers ambiguous entry and close acknowledgements without another POST", async () => {
  const f = fixture({ entryAmbiguous: true, closeAmbiguous: true });
  const result = await runControlledVstBracketProbe(f.args);
  assert.equal(result.phase, "completed");
  assert.equal(f.calls.filter((call) => call === "entry").length, 1);
  assert.equal(f.calls.filter((call) => call === "close").length, 1);
});

test("VST bracket probe confirms delayed TP visibility using only reads, retaining the original SL", async () => {
  const f = fixture({ takeDelayed: true });
  const result = await runControlledVstBracketProbe(f.args);
  assert.equal(result.phase, "completed");
  assert.equal(result.verificationReads.length, 2);
  assert.equal(result.verificationReads[0].checks.takeOpen, false);
  assert.equal(result.verificationReads[0].checks.stopOpen, true);
  assert.equal(f.calls.filter((call) => call === "take").length, 1);
});

test("a safely closed but failed probe can never become a successful result on recovery", async () => {
  const f = fixture();
  await assert.rejects(runControlledVstBracketProbe({
    ...f.args, state: { version: 1, symbol: "BTCUSDT", entryClientId: "vbp_test1",
      closeClientId: "vbp_test2", finished: true, phase: "closed_after_failure",
      failure: "dual_order_proof_failed" },
  }), /dual_order_proof_failed/);
  assert.equal(f.calls.length, 0);
});

test("VST bracket probe closes after ambiguous TP POST, never retries or cancels an unattributed order", async () => {
  const f = fixture({ takeAmbiguous: true });
  await assert.rejects(runControlledVstBracketProbe(f.args),
    /foreign_or_unattributed_order_not_cancelled/);
  assert.equal(f.position(), null);
  assert.deepEqual(f.calls, ["entry", "take", "close", "cancel:103"]);
  assert.equal(f.rows.get("102").status, "NEW");
});

test("VST bracket probe refuses an existing position and cannot trade without its journal", async () => {
  for (const options of [{ occupied: true }, { saveFails: true }]) {
    const f = fixture(options);
    await assert.rejects(runControlledVstBracketProbe(f.args));
    assert.equal(f.calls.length, 0);
  }
});

test("controlled bracket probe cannot be invoked on mainnet", async () => {
  let requests = 0;
  const api = createBingXLiveApi({ environment: "mainnet", writePermission: () => true,
    fetchImpl: async () => { requests++; throw Error("must not fetch"); } });
  await assert.rejects(async () => api.runControlledVstBracketProbe({}),
    /VST.*unavailable|requires VST|only.*VST|unavailable outside VST/);
  assert.equal(requests, 0);
});

function nativeConditionalCohort() {
  const expected = { positionId: "201", entryOrderId: "101", stopOrderId: "103",
    takeOrderId: "102", quantity: "0.0011", stopLoss: "78595.4", takePrice: "84208.2" };
  const common = { symbol: "BTC-USDT", side: "SELL", positionSide: "LONG",
    status: "NEW", origQty: expected.quantity, positionID: "201", workingType: "MARK_PRICE" };
  const openStop = { ...common, orderId: "103", type: "STOP_MARKET", stopPrice: expected.stopLoss };
  const openTake = { ...common, orderId: "102", type: "TAKE_PROFIT_MARKET", stopPrice: expected.takePrice };
  return { expected, orders: [openTake, openStop], stop: { ...openStop, positionID: 0 },
    position: { id: "201", quantity: expected.quantity },
    take: { ...common, orderId: "102", positionID: 0, type: "LIMIT", price: "0.0",
      stopPrice: "", executedQty: "0.0000", workingType: "CONTRACT_PRICE",
      takeProfit: { type: "TAKE_PROFIT_MARKET", stopPrice: 0, workingType: "CONTRACT_PRICE" } } };
}

test("native TP placeholder is corroborated only by the exact owned active TAKE order", () => {
  const cohort = nativeConditionalCohort();
  const result = inspectVstBracketCohort(cohort);
  assert.equal(result.coexistenceVerified, true);
  assert.equal(result.takeQuerySource, "corroborated_conditional_placeholder");
  assert.equal(result.triggerBasisVerified, false, "do not hide the real native trigger-basis discrepancy");
  assert.deepEqual(result.triggerBasis, {
    submitted: "CONTRACT_PRICE", openOrders: "MARK_PRICE", exactQuery: "CONTRACT_PRICE",
  });
});

test("corroboration never accepts an ordinary LIMIT, wrong target, volume, ID, side, or owner", () => {
  for (const mutate of [
    (c) => { c.take.price = "84208.2"; },
    (c) => { c.take.takeProfit.type = ""; },
    (c) => { c.take.stopPrice = "1"; },
    (c) => { c.take.orderId = "999"; },
    (c) => { c.take.origQty = "0.0010"; },
    (c) => { c.take.side = "BUY"; },
    (c) => { c.take.status = "CANCELLED"; },
    (c) => { c.take.positionID = "999"; },
    (c) => { c.stop.positionID = "999"; },
    (c) => { c.orders[0].stopPrice = "84208.3"; },
    (c) => { c.orders[0].positionID = "999"; },
    (c) => { c.orders[0].origQty = "0.0010"; },
    (c) => { c.orders.pop(); },
  ]) {
    const cohort = nativeConditionalCohort();
    mutate(cohort);
    assert.equal(inspectVstBracketCohort(cohort).coexistenceVerified, false);
  }
});
