import assert from "node:assert/strict";
import test from "node:test";
import { createVstWorker } from "../vst-worker.mjs";

const sourceSignalId = "review-signal-1";
const sourceFill = {
  price: "22.7",
  quantity: "12",
  at: "2026-09-27T11:00:00.000Z",
  exchangeOrderId: "owner-attested-order-id",
  fee: { asset: "USDT", amount: "0.05" },
};

function setup({
  accountState, busy = false, readError = null, snapshotOverrides = {},
} = {}) {
  let position = {
    sourceSignalId,
    symbol: "ENSUSDT",
    status: "error",
    snapshot: {
      status: "error",
      environment: "vst",
      accountId: "vst-account-alias",
      symbol: "ENSUSDT",
      remainingQty: "12",
      ...snapshotOverrides,
    },
    updatedAt: "2026-09-27T10:00:00.000Z",
  };
  let reads = 0;
  let writes = 0;
  let events = 0;
  const store = {
    async withLeaderLock(callback) { return busy ? null : callback(); },
    async getPending() { return null; },
    async reserveIntent() { throw new Error("not used"); },
    async listUnresolvedIntents() { return []; },
    async getIntent() { return null; },
    async getPosition(id) { return id === sourceSignalId ? position : null; },
    async resolvePositionAsClosed(id, input) {
      assert.equal(id, sourceSignalId);
      assert.deepEqual(input.fill, sourceFill);
      assert.equal(input.resolvedBy, "owner-user");
      assert.equal(input.exchangeFlatCheck.verified, true);
      assert.equal(input.exchangeFlatCheck.accountId, "vst-account-alias");
      assert.equal(input.exchangeFlatCheck.environment, "vst");
      assert.equal(input.exchangeFlatCheck.symbol, "ENSUSDT");
      assert.equal(input.exchangeFlatCheck.positionQuantity, "0");
      assert.equal(input.exchangeFlatCheck.openOrderCount, 0);
      writes += 1;
      events += 1;
      position = {
        ...position,
        status: "closed",
        snapshot: {
          ...position.snapshot,
          status: "closed",
          manualResolution: {
            outcome: "closed",
            provenance: "owner_attested",
            exchangeFlatCheck: input.exchangeFlatCheck,
          },
        },
      };
      return position;
    },
  };
  const broker = {
    async readAccountState() {
      reads += 1;
      if (readError) throw readError;
      return accountState;
    },
  };
  const worker = createVstWorker({
    store,
    broker,
    clock: () => Date.parse("2026-09-27T11:01:00.000Z"),
  });
  return {
    worker,
    counters: () => ({ reads, writes, events }),
  };
}

const flatAccount = {
  verified: true,
  environment: "vst",
  accountId: "vst-account-alias",
  positions: [],
  openOrders: [],
};

async function resolve(worker) {
  return worker.resolveOwnerAttestedPositionClosed(sourceSignalId, {
    fill: sourceFill,
    resolvedBy: "owner-user",
    note: "I confirmed the fill on BingX",
  });
}

test("owner-attested close writes only after a fresh verified VST read proves its symbol flat", async () => {
  const { worker, counters } = setup({
    accountState: {
      ...flatAccount,
      positions: [{ symbol: "BTC-USDT", positionAmt: "0.25" }],
      openOrders: [{ symbol: "DOGE-USDT", orderId: "other-symbol-order" }],
    },
  });
  const result = await resolve(worker);

  assert.equal(result.kind, "closed");
  assert.equal(result.position.snapshot.manualResolution.provenance, "owner_attested");
  assert.equal(result.position.snapshot.manualResolution.exchangeFlatCheck.verified, true);
  assert.deepEqual(counters(), { reads: 1, writes: 1, events: 1 });
});

test("an open matching BingX position keeps the error ledger untouched", async () => {
  const { worker, counters } = setup({
    accountState: {
      ...flatAccount,
      positions: [{ symbol: "ENS-USDT", positionAmt: "12" }],
    },
  });
  assert.deepEqual(await resolve(worker), { kind: "position_open" });
  assert.deepEqual(counters(), { reads: 1, writes: 0, events: 0 });
});

test("a matching open BingX order also keeps the ledger untouched", async () => {
  const { worker, counters } = setup({
    accountState: {
      ...flatAccount,
      openOrders: [{ symbol: "ENS-USDT", orderId: "protective-stop" }],
    },
  });
  assert.deepEqual(await resolve(worker), { kind: "orders_open" });
  assert.deepEqual(counters(), { reads: 1, writes: 0, events: 0 });
});

test("unknown, unverified, and unavailable BingX reads fail closed", async () => {
  for (const options of [
    { accountState: { ...flatAccount, verified: false } },
    { accountState: { ...flatAccount, positions: null } },
    { readError: new Error("exchange unavailable") },
  ]) {
    const { worker, counters } = setup(options);
    const result = await resolve(worker);
    assert.ok(["exchange_unavailable", "exchange_unverified"].includes(result.kind));
    assert.deepEqual(counters(), { reads: 1, writes: 0, events: 0 });
  }
});

test("mismatched account or environment never closes the ledger", async () => {
  for (const accountState of [
    { ...flatAccount, accountId: "another-account" },
    { ...flatAccount, environment: "real" },
  ]) {
    const { worker, counters } = setup({ accountState });
    assert.deepEqual(await resolve(worker), { kind: "account_mismatch" });
    assert.deepEqual(counters(), { reads: 1, writes: 0, events: 0 });
  }
  const wrongStoredAccount = setup({
    accountState: flatAccount,
    snapshotOverrides: { environment: "real" },
  });
  assert.deepEqual(await resolve(wrongStoredAccount.worker), { kind: "account_mismatch" });
  assert.deepEqual(wrongStoredAccount.counters(), { reads: 0, writes: 0, events: 0 });
});

test("an unavailable leader lock prevents even the read-only exchange call", async () => {
  const { worker, counters } = setup({ accountState: flatAccount, busy: true });
  assert.equal(await resolve(worker), null);
  assert.deepEqual(counters(), { reads: 0, writes: 0, events: 0 });
});

test("repeated owner-close submissions are idempotent and do not duplicate events", async () => {
  const { worker, counters } = setup({ accountState: flatAccount });
  assert.equal((await resolve(worker)).kind, "closed");
  const repeated = await resolve(worker);
  assert.equal(repeated.kind, "already_closed");
  assert.deepEqual(counters(), { reads: 1, writes: 1, events: 1 });
});