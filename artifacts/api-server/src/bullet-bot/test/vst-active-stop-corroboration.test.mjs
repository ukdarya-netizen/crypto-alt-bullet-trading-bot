import assert from "node:assert/strict";
import test from "node:test";
import { corroborateVstActiveStopPosition } from "../vst-active-stop-corroboration.mjs";

const orderId = "2105663921788116992";
const positionId = "2105662971440005121";

const openRow = {
  symbol: "DOGE-USDT",
  orderId,
  positionID: positionId,
  status: "NEW",
  type: "STOP_MARKET",
  side: "SELL",
  positionSide: "LONG",
  workingType: "MARK_PRICE",
  origQty: "82294.4",
  executedQty: "0.0",
  stopPrice: "0.08262",
  closePosition: "false",
  mainOrderId: "",
};

const queryRow = {
  ...openRow,
  positionID: 0,
  closePosition: "",
};

test("corroborates the exact active VST stop when query linkage is zero", () => {
  const corroborated = corroborateVstActiveStopPosition(
    queryRow, openRow, { orderId, positionId },
  );

  assert.deepEqual(corroborated, { ...queryRow, positionID: positionId });
  assert.equal(corroborated.positionID, positionId);
  assert.equal(queryRow.positionID, 0);
});

test("fails closed for wrong, mixed, malformed, or omitted position linkage", () => {
  for (const row of [
    { ...queryRow, positionID: "wrong-position" },
    { ...queryRow, positionId: 0, positionID: positionId },
    { ...queryRow, positionID: "0.0" },
    { ...queryRow, positionID: null },
    { ...queryRow, positionID: undefined },
    { ...queryRow, positionID: undefined, positionId: undefined },
    { ...queryRow, positionID: "0", positionId: positionId },
  ]) {
    assert.equal(
      corroborateVstActiveStopPosition(row, openRow, { orderId, positionId }),
      null,
    );
  }
});

test("fails closed when the independent open row is not exactly linked", () => {
  for (const evidence of [
    { ...openRow, positionID: "another-position" },
    { ...openRow, positionID: 0 },
    { ...openRow, positionID: positionId, positionId: "other-position" },
    { ...openRow, orderId: "other-order" },
    { ...openRow, stopPrice: "0.08263" },
    { ...openRow, origQty: "82294.5" },
    { ...openRow, workingType: "CONTRACT_PRICE" },
  ]) {
    assert.equal(
      corroborateVstActiveStopPosition(queryRow, evidence, {
        orderId, positionId,
      }),
      null,
    );
  }
});

test("requires the independent open row to explicitly prove zero execution", () => {
  const { executedQty: _executedQty, ...missingExecution } = openRow;
  for (const evidence of [
    missingExecution,
    { ...openRow, executedQty: null },
    { ...openRow, executedQty: "0.1" },
    { ...openRow, executedQty: "0", cumExecQty: "1" },
  ]) {
    assert.equal(
      corroborateVstActiveStopPosition(queryRow, evidence, {
        orderId, positionId,
      }),
      null,
    );
  }
});

test("fails closed on query identity, specification, and execution mismatches", () => {
  for (const row of [
    { ...queryRow, orderId: "other-order" },
    { ...queryRow, symbol: "BTC-USDT" },
    { ...queryRow, status: "FILLED" },
    { ...queryRow, type: "MARKET" },
    { ...queryRow, side: "BUY" },
    { ...queryRow, positionSide: "SHORT" },
    { ...queryRow, workingType: "CONTRACT_PRICE" },
    { ...queryRow, origQty: "82294.5" },
    { ...queryRow, stopPrice: "0.08263" },
    { ...queryRow, executedQty: "0.1" },
    { ...queryRow, executedQty: null },
    { ...queryRow, executedQty: "0", cumExecQty: "1" },
    { ...queryRow, executedQty: undefined },
  ]) {
    assert.equal(
      corroborateVstActiveStopPosition(row, openRow, { orderId, positionId }),
      null,
    );
  }
});