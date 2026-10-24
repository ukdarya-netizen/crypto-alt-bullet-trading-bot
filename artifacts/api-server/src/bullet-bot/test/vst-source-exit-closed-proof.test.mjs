import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { readCommittedStopCloseProof } from "../vst-source-exit-closed-proof.mjs";

function fixture(impulse = false) {
  const row = { sourceSignalId: "cab-signal-proof", symbol: "REUSDT" };
  const parent = "2105952049086160896", child = "2106091719796719617";
  const positionId = "2105271515231551489";
  const phase = impulse
    ? `impulse-triggered-stop-${createHash("sha256")
      .update(`${positionId}:${parent}`).digest("hex").slice(0, 24)}`
    : `triggered-stop-${createHash("sha256").update(parent).digest("hex").slice(0, 24)}`;
  const clientOrderId = `vst-${createHash("sha256")
    .update(`${row.sourceSignalId}:${phase}`).digest("hex").slice(0, 30)}`;
  const fill = {
    at: "2026-10-02T18:39:30.000Z", orderId: child, triggerOrderId: parent,
    exchangeOrderId: child, quantity: 18850.91, price: 0.4905,
    fee: { asset: "USDT", amount: "-4.622774" },
    fees: { asset: "USDT", amount: "-4.622774" }, feeEvidenceAvailable: true,
  };
  const record = { ...row, status: "closed", snapshot: {
    ...row, status: "closed", environment: "vst", accountId: "proof-account",
    remainingQty: 0, exchangePositionId: positionId,
    triggeredStop: { parentStopId: parent, childOrderId: child, parentStopPrice: "0.4915" },
    lastCloseFill: structuredClone(fill),
  }};
  const intent = {
    sourceSignalId: row.sourceSignalId, state: "reconciled",
    clientOrderId, exchangeOrderId: child,
    request: { operation: "observe_triggered_stop", environment: "vst",
      accountId: "proof-account", symbol: row.symbol, positionId,
      stopOrderId: parent, stopQuantity: 18850.91, stopPrice: 0.4915 },
    outcome: { operation: "observe_triggered_stop", verified: true, status: "filled",
      parentStopId: parent, childOrderId: child, parentStopPrice: "0.4915",
      fill, residualPosition: { verified: true, positionId, quantity: "0" }, openStops: [] },
  };
  const store = { getIntent: async (sourceId, key) =>
    sourceId === row.sourceSignalId && key === phase ? intent : null };
  return { row, record, intent, store };
}

for (const impulse of [false, true]) {
  test(`committed ${impulse ? "impulse" : "core"} stop close is durable queue proof`, async () => {
    const f = fixture(impulse);
    assert.equal((await readCommittedStopCloseProof(f.store, f.record, f.row)).childOrderId,
      f.intent.exchangeOrderId);
  });
}

for (const [label, damage] of [
  ["local flag without fill", (f) => { f.intent.outcome = null; }],
  ["manual resolution", (f) => { f.record.snapshot.manualResolution = { outcome: "closed" }; }],
  ["unreconciled intent", (f) => { f.intent.state = "unknown"; }],
  ["foreign symbol", (f) => { f.intent.request.symbol = "BTCUSDT"; }],
  ["foreign account", (f) => { f.intent.request.accountId = "other"; }],
  ["foreign position", (f) => { f.intent.outcome.residualPosition.positionId = "other"; }],
  ["nonzero residual", (f) => { f.intent.outcome.residualPosition.quantity = "1"; }],
  ["unverified residual", (f) => { f.intent.outcome.residualPosition.verified = false; }],
  ["remaining stop", (f) => { f.intent.outcome.openStops = [{ orderId: "other" }]; }],
  ["wrong child", (f) => { f.intent.exchangeOrderId = "other"; }],
  ["wrong parent", (f) => { f.intent.request.stopOrderId = "other"; }],
  ["altered saved fill", (f) => { f.record.snapshot.lastCloseFill.fee.amount = "0"; }],
  ["wrong deterministic identity", (f) => { f.intent.clientOrderId = "other"; }],
]) {
  test(`queue proof rejects ${label}`, async () => {
    const f = fixture(); damage(f);
    assert.equal(await readCommittedStopCloseProof(f.store, f.record, f.row), null);
  });
}