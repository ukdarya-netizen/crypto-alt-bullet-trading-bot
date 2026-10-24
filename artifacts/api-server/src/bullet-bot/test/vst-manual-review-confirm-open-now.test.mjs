import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createVstWorker } from "../vst-worker.mjs";

// "Всё ещё открыта" on the VST manual-review screen: one owner click reads
// the live BingX position instead of the owner typing the remaining
// quantity by hand. Unlike closeErrorPositionNow (see
// vst-manual-review-close-now.test.mjs) this path never mutates the
// exchange -- it only ever forwards a fresh, verified exchange read into the
// exact same store.resolvePositionAsStillOpen write path the manual form
// itself uses, so no intent/reconciliation machinery is involved and a
// failed or ambiguous read is always safe to retry.

const originalPauseSwitch = process.env.BULLET_VST_PAUSED;
process.env.BULLET_VST_PAUSED = "0";
after(() => {
  if (originalPauseSwitch === undefined) delete process.env.BULLET_VST_PAUSED;
  else process.env.BULLET_VST_PAUSED = originalPauseSwitch;
});

const NOW = Date.parse("2026-09-29T00:00:00.000Z");
const ACCOUNT_ID = "vst-account";
const SYMBOL = "ENSUSDT";
const POSITION_ID = "review-position-77";
const REQUIRED_CAPABILITIES = [
  "vst_only",
  "complete_order_lookup",
  "guarded_long10_leverage_preparation",
  "atomic_protected_market_entry",
  "verified_core_stop_state",
  "verified_exact_full_position_close",
  "verified_position_state",
];

function errorPositionRecord(overrides = {}) {
  return {
    sourceSignalId: "vst-signal-review-1",
    symbol: SYMBOL,
    status: "error",
    snapshot: {
      environment: "vst",
      accountId: ACCOUNT_ID,
      exchangePositionId: POSITION_ID,
      remainingQty: 12,
      coreQty: 12,
      runnerQty: 0,
    },
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

// confirmPositionStillOpenNow never reserves or reconciles an intent (it has
// no exchange mutation to make durable), but createVstWorker validates the
// store's full durable interface up front regardless of which function ends
// up calling it -- so the intent-machinery methods below are unused stubs,
// asserted never-called rather than omitted.
function reviewConfirmStore({ errorPosition, resolveOpenError = null } = {}) {
  const data = {
    errorPositions: errorPosition ? [errorPosition] : [],
    resolvedOpens: [],
    resolveOpenCalls: 0,
  };
  return {
    data,
    async withLeaderLock(callback) { return callback(); },
    async getPending() { return null; },
    async listUnresolvedIntents() { return []; },
    async getIntent() { return null; },
    async reserveIntent() { throw new Error("confirm-open-now must never reserve an intent"); },
    async listErrorPositions() { return data.errorPositions; },
    async resolvePositionAsStillOpen(sourceSignalId, { remainingQty, resolvedBy, note }) {
      data.resolveOpenCalls += 1;
      if (resolveOpenError && data.resolveOpenCalls === 1) throw resolveOpenError;
      const position = data.errorPositions.find((row) => row.sourceSignalId === sourceSignalId);
      if (!position) throw new Error("vst_position_not_found");
      data.resolvedOpens.push({ sourceSignalId, remainingQty, resolvedBy, note });
      return { sourceSignalId, symbol: position.symbol, status: "open", updatedAt: new Date(NOW).toISOString() };
    },
  };
}

function reviewConfirmBroker({ exchangePosition, readPosition = null } = {}) {
  return {
    async getCapabilities() {
      return { environment: "vst", verified: true, accountId: ACCOUNT_ID, features: REQUIRED_CAPABILITIES };
    },
    async readPlanningInputs() { throw new Error("not needed for confirm-open-now tests"); },
    async readAccountState() { return { verified: true, positions: [], openOrders: [] }; },
    async readMarketMark() { return { verified: true, price: 100, observedAt: new Date(NOW).toISOString() }; },
    async readPosition(...args) {
      if (typeof readPosition === "function") return readPosition(...args);
      return exchangePosition;
    },
    async performIntent() { throw new Error("confirm-open-now must never submit an exchange order"); },
    async reconcileIntent() { throw new Error("confirm-open-now must never reconcile an intent"); },
  };
}

test("confirmPositionStillOpenNow confirms a stuck position open using the exchange-reported quantity", async () => {
  const store = reviewConfirmStore({ errorPosition: errorPositionRecord() });
  const broker = reviewConfirmBroker({
    exchangePosition: { verified: true, quantity: 9.5, positionId: POSITION_ID },
  });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.confirmPositionStillOpenNow("vst-signal-review-1", { resolvedBy: "owner-user-1" });

  assert.equal(result.kind, "confirmed_open");
  assert.equal(result.position.status, "open");
  assert.equal(store.data.resolvedOpens.length, 1);
  assert.equal(store.data.resolvedOpens[0].remainingQty, "9.5");
  assert.equal(store.data.resolvedOpens[0].resolvedBy, "owner-user-1");
});

test("confirmPositionStillOpenNow refuses to confirm a different position that reopened on the same symbol", async () => {
  const store = reviewConfirmStore({ errorPosition: errorPositionRecord() });
  const broker = reviewConfirmBroker({
    // Same symbol, genuinely open, but a different exchange positionId: the
    // original stuck trade closed outside the bot and this is a newer,
    // unrelated position -- must never be reported as confirmation of the
    // old one, regardless of its quantity.
    exchangePosition: { verified: true, quantity: 40, positionId: "unrelated-position-99" },
  });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.confirmPositionStillOpenNow("vst-signal-review-1", { resolvedBy: "owner-user-1" });

  assert.equal(result.kind, "blocked");
  assert.equal(result.reason, "position_identity_not_verified");
  assert.equal(store.data.resolvedOpens.length, 0);
});

test("confirmPositionStillOpenNow declines when the ledger never captured a position id to verify against", async () => {
  const store = reviewConfirmStore({
    errorPosition: errorPositionRecord({
      // Models entry_verification_abandoned_confirmed_open_unprotected: the
      // position reached "error" status before any exchange positionId was
      // ever recorded, so there is nothing to verify a fresh read against.
      snapshot: { environment: "vst", accountId: ACCOUNT_ID, remainingQty: 12 },
    }),
  });
  const broker = reviewConfirmBroker({
    exchangePosition: { verified: true, quantity: 9.5, positionId: "some-open-position" },
  });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.confirmPositionStillOpenNow("vst-signal-review-1", { resolvedBy: "owner-user-1" });

  assert.equal(result.kind, "blocked");
  assert.equal(result.reason, "position_identity_not_verified");
  assert.equal(store.data.resolvedOpens.length, 0);
});

test("confirmPositionStillOpenNow reports already_flat and changes nothing when BingX shows no open position", async () => {
  const store = reviewConfirmStore({ errorPosition: errorPositionRecord() });
  const broker = reviewConfirmBroker({ exchangePosition: { verified: true, quantity: 0 } });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.confirmPositionStillOpenNow("vst-signal-review-1", { resolvedBy: "owner-user-1" });

  assert.equal(result.kind, "already_flat");
  assert.equal(store.data.resolvedOpens.length, 0);
});

test("confirmPositionStillOpenNow reports not_found for a signal with no error-status position", async () => {
  const store = reviewConfirmStore({ errorPosition: errorPositionRecord() });
  const broker = reviewConfirmBroker({ exchangePosition: { verified: true, quantity: 9.5 } });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.confirmPositionStillOpenNow("no-such-signal", { resolvedBy: "owner-user-1" });

  assert.equal(result.kind, "not_found");
  assert.equal(store.data.resolvedOpens.length, 0);
});

test("confirmPositionStillOpenNow refuses to act on a position from a different account or environment", async () => {
  const store = reviewConfirmStore({
    errorPosition: errorPositionRecord({
      snapshot: { environment: "vst", accountId: "some-other-account", remainingQty: 12 },
    }),
  });
  const broker = reviewConfirmBroker({ exchangePosition: { verified: true, quantity: 9.5 } });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.confirmPositionStillOpenNow("vst-signal-review-1", { resolvedBy: "owner-user-1" });

  assert.equal(result.kind, "blocked");
  assert.equal(result.reason, "position_account_or_environment_mismatch");
  assert.equal(store.data.resolvedOpens.length, 0);
});

test("confirmPositionStillOpenNow defers instead of guessing when the exchange read itself fails", async () => {
  const store = reviewConfirmStore({ errorPosition: errorPositionRecord() });
  const broker = reviewConfirmBroker({
    readPosition: async () => { throw new Error("temporary_network_error"); },
  });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.confirmPositionStillOpenNow("vst-signal-review-1", { resolvedBy: "owner-user-1" });

  assert.equal(result.kind, "read_unavailable");
  assert.equal(store.data.resolvedOpens.length, 0);
});

test("confirmPositionStillOpenNow defers instead of guessing when the exchange read is unverified", async () => {
  const store = reviewConfirmStore({ errorPosition: errorPositionRecord() });
  const broker = reviewConfirmBroker({ exchangePosition: { verified: false, quantity: 9.5 } });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.confirmPositionStillOpenNow("vst-signal-review-1", { resolvedBy: "owner-user-1" });

  assert.equal(result.kind, "read_unavailable");
  assert.equal(store.data.resolvedOpens.length, 0);
});

test("confirmPositionStillOpenNow is blocked without live mutation capabilities, even though it never mutates", async () => {
  const store = reviewConfirmStore({ errorPosition: errorPositionRecord() });
  const broker = reviewConfirmBroker({ exchangePosition: { verified: true, quantity: 9.5 } });
  broker.getCapabilities = async () => ({ environment: "vst", verified: false, features: [] });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.confirmPositionStillOpenNow("vst-signal-review-1", { resolvedBy: "owner-user-1" });

  assert.equal(result.kind, "blocked");
});

test("a ledger write failure after a good read is always safe to retry and re-reads rather than reusing a stale quantity", async () => {
  const store = reviewConfirmStore({
    errorPosition: errorPositionRecord(),
    resolveOpenError: new Error("transient_db_write_failure"),
  });
  let reads = 0;
  const broker = reviewConfirmBroker({
    readPosition: async () => {
      reads += 1;
      // The live quantity moves between the failed attempt and the retry;
      // the retry must reflect the fresh read, not a cached first value.
      return { verified: true, quantity: reads === 1 ? 9.5 : 8.25, positionId: POSITION_ID };
    },
  });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const firstAttempt = await worker.confirmPositionStillOpenNow("vst-signal-review-1", { resolvedBy: "owner-user-1" });
  assert.equal(firstAttempt.kind, "resolve_failed");
  assert.equal(store.data.resolvedOpens.length, 0);

  const retry = await worker.confirmPositionStillOpenNow("vst-signal-review-1", { resolvedBy: "owner-user-1" });
  assert.equal(retry.kind, "confirmed_open");
  assert.equal(reads, 2, "each attempt must perform its own fresh read");
  assert.equal(store.data.resolvedOpens.length, 1);
  assert.equal(store.data.resolvedOpens[0].remainingQty, "8.25");
});
