import assert from "node:assert/strict";
import test from "node:test";
import { createVstWorker } from "../vst-worker.mjs";

function setup({ exposure = [], openOrders = [], accountVerified = true,
  proofVerified = true, capabilityAccountId = null } = {}) {
  const accountId = "vst-test";
  const counts = { proof: 0, commit: 0, management: 0, mutation: 0 };
  const candidate = {
    sourceSignalId: "cab-signal-18058", symbol: "XLMUSDT",
    status: "unknown", positionVersion: "2026-10-08T11:18:50.124000Z",
    snapshot: { sourceSignalId: "cab-signal-18058", symbol: "XLMUSDT",
      environment: "vst", accountId, status: "unknown" },
  };
  const store = {
    async withLeaderLock(run) { return run(); },
    async getPending() { return null; },
    async getIntent() { return null; },
    async listUnresolvedIntents() { return []; },
    async listOpenPositions() { return candidate.status === "closed" ? [] : [candidate]; },
    async reserveIntent() { counts.mutation++; throw new Error("unexpected reservation"); },
    async upsertPosition() {},
    async setSignalStatus() {},
    async listHistoricalCloseCandidates() { return [candidate]; },
    async listFlatPositionCloseCandidates() { return [candidate]; },
    async reconcileHistoricalClose(actual, proof) {
      assert.equal(actual, candidate);
      assert.equal(proof.verified, true);
      counts.commit++;
      candidate.status = "closed";
      return { kind: "reconciled" };
    },
  };
  const broker = {
    async getCapabilities() {
      // Trading proof may be unavailable independently of safe native reads.
      return capabilityAccountId
        ? { verified: true, environment: "vst", accountId: capabilityAccountId, features: [] }
        : { verified: false, environment: "vst" };
    },
    async readAccountState() {
      return { verified: accountVerified, environment: "vst", accountId,
        positions: exposure, openOrders };
    },
    async readPosition() { counts.management++; return { verified: false }; },
    async readMarketMark() { throw new Error("unexpected mark read"); },
    async reconcileIntent() { throw new Error("unexpected intent"); },
    async readPlanningInputs() { throw new Error("unexpected entry preparation"); },
    async performIntent() { counts.mutation++; throw new Error("unexpected exchange write"); },
    async readHistoricalErrorClose() { counts.proof++; return { verified: proofVerified }; },
  };
  return {
    worker: createVstWorker({ store, broker,
      clock: () => Date.parse("2026-10-08T16:00:00Z"),
      sizingLimits: { environment: "vst" } }),
    counts, candidate,
  };
}

test("flat-history repair precedes stale stop management and unavailable trading capabilities", async () => {
  const { worker, counts, candidate } = setup();
  const result = await worker.runOnce();
  assert.equal(result.reason, "historical_close_ledger_reconciled");
  assert.equal(candidate.status, "closed");
  assert.deepEqual(counts, { proof: 1, commit: 1, management: 0, mutation: 0 });
});

test("flat alone cannot close a ledger without verified history or matching fresh account identity", async () => {
  for (const options of [
    { proofVerified: false },
    { accountVerified: false },
    { capabilityAccountId: "different-vst-account" },
  ]) {
    const { worker, counts, candidate } = setup(options);
    await worker.runOnce();
    assert.equal(candidate.status, "unknown");
    assert.equal(counts.commit, 0);
    assert.equal(counts.mutation, 0);
  }
});

test("history lane skips a symbol with current exposure or open orders", async () => {
  for (const options of [
    { exposure: [{ symbol: "XLM-USDT", positionAmt: "1" }] },
    { openOrders: [{ symbol: "XLM-USDT", orderId: "9001" }] },
  ]) {
    const { worker, counts, candidate } = setup(options);
    await worker.runOnce();
    assert.equal(counts.proof, 0);
    assert.equal(counts.commit, 0);
    assert.equal(counts.mutation, 0);
    assert.equal(candidate.status, "unknown");
  }
});
