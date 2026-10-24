import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createVstWorker } from "../vst-worker.mjs";

// "Закрыть сейчас" on the VST manual-review screen: one owner click instead
// of typing price/quantity/time/order-id/fee by hand. These tests exercise
// closeErrorPositionNow (the interactive path) AND reconcileOne's dedicated
// handling of the "manual_review_close_now" phase (the passive-tick path
// that must retry the exact same verification+commit logic on its own,
// without ever falling through to the generic upsertPosition/setSignalStatus
// fallback other automated closes use -- see
// .agents/memory/vst-closed-position-provenance.md and
// vst-unresolved-intent-blocking.md for why that distinction is safety
// critical: a leaked intent into the generic path both loses the
// manualResolution provenance marker AND can otherwise sit unresolved
// forever, freezing every other symbol's signals behind it.

const originalPauseSwitch = process.env.BULLET_VST_PAUSED;
process.env.BULLET_VST_PAUSED = "0";
after(() => {
  if (originalPauseSwitch === undefined) delete process.env.BULLET_VST_PAUSED;
  else process.env.BULLET_VST_PAUSED = originalPauseSwitch;
});

const NOW = Date.parse("2026-09-29T00:00:00.000Z");
const ACCOUNT_ID = "vst-account";
const SYMBOL = "ENSUSDT";
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
      remainingQty: 12,
      coreQty: 12,
      runnerQty: 0,
    },
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

// Deliberately omits upsertPosition/setSignalStatus: the generic
// reconcileOne fallback for an ordinary close_leg intent calls exactly those
// two methods when request.nextPolicy is set (which this phase's request
// always sets). If a future change ever lets a "manual_review_close_now"
// intent fall through to that generic path instead of
// reconcileManualReviewCloseNow, this store throws "not a function" and the
// affected test fails loudly instead of silently closing the position
// without owner-review provenance.
function reviewCloseStore({ errorPosition, resolveCloseError = null } = {}) {
  const data = {
    intents: [],
    errorPositions: errorPosition ? [errorPosition] : [],
    resolvedCloses: [],
    resolveCloseCalls: 0,
  };
  return {
    data,
    async withLeaderLock(callback) { return callback(); },
    async getPending() { return null; },
    async listUnresolvedIntents() {
      return data.intents.filter((row) => ["prepared", "submitted", "unknown"].includes(row.state));
    },
    async getIntent(sourceSignalId, phase) {
      return data.intents.find((row) =>
        row.sourceSignalId === sourceSignalId && row.phase === phase) ?? null;
    },
    async reserveIntent(intent) {
      const existing = data.intents.find((row) =>
        row.sourceSignalId === intent.sourceSignalId && row.phase === intent.phase);
      if (existing) return { kind: "existing", intent: existing };
      data.intents.push({ ...intent, state: "prepared" });
      return { kind: "new", intent: data.intents.at(-1) };
    },
    async markIntent(clientOrderId, state, detail = {}) {
      const intent = data.intents.find((row) => row.clientOrderId === clientOrderId);
      if (intent) Object.assign(intent, { state, detail });
    },
    async listErrorPositions() { return data.errorPositions; },
    async resolvePositionAsClosed(sourceSignalId, { fill, resolvedBy, note }) {
      data.resolveCloseCalls += 1;
      if (resolveCloseError && data.resolveCloseCalls === 1) throw resolveCloseError;
      const position = data.errorPositions.find((row) => row.sourceSignalId === sourceSignalId);
      if (!position) throw new Error("vst_position_not_found");
      data.resolvedCloses.push({ sourceSignalId, fill, resolvedBy, note });
      data.errorPositions = data.errorPositions.filter((row) => row.sourceSignalId !== sourceSignalId);
      return { sourceSignalId, symbol: position.symbol, status: "closed", updatedAt: new Date(NOW).toISOString() };
    },
    async listOpenPositions() { return []; },
    async listPendingCandidates() { return []; },
  };
}

function reviewCloseBroker({ exchangePosition, reconcile, onPerform = null } = {}) {
  let performCalls = 0;
  return {
    performCalls: () => performCalls,
    async getCapabilities() {
      return { environment: "vst", verified: true, accountId: ACCOUNT_ID, features: REQUIRED_CAPABILITIES };
    },
    async readPlanningInputs() { throw new Error("not needed for close-now tests"); },
    async readAccountState() { return { verified: true, positions: [], openOrders: [] }; },
    async readMarketMark() { return { verified: true, price: 100, observedAt: new Date(NOW).toISOString() }; },
    async readPosition() { return exchangePosition; },
    async performIntent(intent) {
      performCalls += 1;
      await onPerform?.(intent);
    },
    async reconcileIntent(intent) {
      return typeof reconcile === "function" ? reconcile(intent) : reconcile;
    },
  };
}

const verifiedFillEvidence = {
  verified: true,
  status: "filled",
  exchangeOrderId: "9988776655",
  position: { verified: true, symbol: SYMBOL, quantity: "0" },
  fill: {
    price: "22.7", quantity: "12", at: "2026-09-29T00:05:00.000Z",
    fees: [{ currency: "USDT", amount: "0.75" }],
  },
};

test("closeErrorPositionNow closes a stuck position from a single click using only exchange-read facts", async () => {
  const store = reviewCloseStore({ errorPosition: errorPositionRecord() });
  const broker = reviewCloseBroker({
    exchangePosition: { verified: true, quantity: 12 },
    reconcile: () => verifiedFillEvidence,
  });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.closeErrorPositionNow("vst-signal-review-1", { resolvedBy: "owner-user-1" });

  assert.equal(result.kind, "closed");
  assert.equal(broker.performCalls(), 1);
  assert.equal(store.data.resolvedCloses.length, 1);
  assert.equal(store.data.resolvedCloses[0].resolvedBy, "owner-user-1");
  assert.equal(store.data.resolvedCloses[0].fill.exchangeOrderId, "9988776655");
  assert.equal(store.data.intents[0].state, "reconciled");
  assert.equal(store.data.errorPositions.length, 0);
});

test("closeErrorPositionNow reports already_flat and places no order when BingX shows no open position", async () => {
  const store = reviewCloseStore({ errorPosition: errorPositionRecord() });
  const broker = reviewCloseBroker({
    exchangePosition: { verified: true, quantity: 0 },
    reconcile: () => verifiedFillEvidence,
  });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.closeErrorPositionNow("vst-signal-review-1", { resolvedBy: "owner-user-1" });

  assert.equal(result.kind, "already_flat");
  assert.equal(broker.performCalls(), 0);
  assert.equal(store.data.intents.length, 0);
  assert.equal(store.data.resolvedCloses.length, 0);
});

test("closeErrorPositionNow reports not_found for a signal with no error-status position", async () => {
  const store = reviewCloseStore({ errorPosition: errorPositionRecord() });
  const broker = reviewCloseBroker({ exchangePosition: { verified: true, quantity: 12 } });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.closeErrorPositionNow("no-such-signal", { resolvedBy: "owner-user-1" });

  assert.equal(result.kind, "not_found");
});

test("closeErrorPositionNow refuses to act on a position from a different account or environment", async () => {
  const store = reviewCloseStore({
    errorPosition: errorPositionRecord({
      snapshot: { environment: "vst", accountId: "some-other-account", remainingQty: 12 },
    }),
  });
  const broker = reviewCloseBroker({ exchangePosition: { verified: true, quantity: 12 } });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.closeErrorPositionNow("vst-signal-review-1", { resolvedBy: "owner-user-1" });

  assert.equal(result.kind, "blocked");
  assert.equal(result.reason, "position_account_or_environment_mismatch");
  assert.equal(broker.performCalls(), 0);
});

test("closeErrorPositionNow defers instead of guessing when the exchange read itself fails", async () => {
  const store = reviewCloseStore({ errorPosition: errorPositionRecord() });
  const broker = reviewCloseBroker({ exchangePosition: null });
  broker.readPosition = async () => { throw new Error("temporary_network_error"); };
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.closeErrorPositionNow("vst-signal-review-1", { resolvedBy: "owner-user-1" });

  assert.equal(result.kind, "read_unavailable");
  assert.equal(store.data.intents.length, 0);
});

test("an unverified close-now attempt is finished by a later passive tick, never the generic close fallback, and keeps the owner's attribution", async () => {
  let verified = false;
  const store = reviewCloseStore({ errorPosition: errorPositionRecord() });
  const broker = reviewCloseBroker({
    exchangePosition: { verified: true, quantity: 12 },
    reconcile: () => verified
      ? verifiedFillEvidence
      : { verified: false, status: "unknown" },
  });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  // First click: BingX evidence is not yet verifiable (e.g. read lag).
  const firstAttempt = await worker.closeErrorPositionNow("vst-signal-review-1", { resolvedBy: "owner-user-1" });
  assert.equal(firstAttempt.kind, "unverified");
  assert.equal(broker.performCalls(), 1, "the market close order is still only ever submitted once");
  assert.equal(store.data.intents[0].state, "unknown");
  assert.equal((await store.listUnresolvedIntents()).length, 1,
    "an unresolved close-now intent must still surface for manual attention");

  // Evidence becomes verifiable; a passive tick (no owner click) must finish
  // the job on its own so this can never permanently block the pipeline.
  verified = true;
  const tick = await worker.runOnce();

  assert.equal(broker.performCalls(), 1, "still no second live close order");
  assert.equal(store.data.resolvedCloses.length, 1);
  assert.equal(store.data.resolvedCloses[0].resolvedBy, "owner-user-1",
    "attribution captured at click time must survive a passive tick with no request context");
  assert.equal(store.data.intents[0].state, "reconciled");
  assert.equal(store.data.errorPositions.length, 0);
  assert.equal((await store.listUnresolvedIntents()).length, 0);
  assert.equal(tick.kind, "idle");
});

test("a ledger write failure after a verified fill retries only the save, never a second exchange order", async () => {
  const store = reviewCloseStore({
    errorPosition: errorPositionRecord(),
    resolveCloseError: new Error("transient_db_write_failure"),
  });
  const broker = reviewCloseBroker({
    exchangePosition: { verified: true, quantity: 12 },
    reconcile: () => verifiedFillEvidence,
  });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const firstAttempt = await worker.closeErrorPositionNow("vst-signal-review-1", { resolvedBy: "owner-user-1" });
  assert.equal(firstAttempt.kind, "closed_but_unrecorded");
  assert.equal(broker.performCalls(), 1);
  assert.equal(store.data.resolvedCloses.length, 0);

  const retry = await worker.closeErrorPositionNow("vst-signal-review-1", { resolvedBy: "owner-user-1" });
  assert.equal(retry.kind, "closed");
  assert.equal(broker.performCalls(), 1, "retry must never place a second live close order");
  assert.equal(store.data.resolvedCloses.length, 1);
});
