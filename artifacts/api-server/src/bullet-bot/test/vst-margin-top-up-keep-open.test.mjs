import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createVstWorker } from "../vst-worker.mjs";

// "Проверил(а) на BingX — маржа не добавлена" on the VST manual-review
// screen: the owner claims a stuck margin top-up did NOT land, but this
// never accepts that claim alone. A fresh, read-only BingX read of the same
// identified position's current isolated margin must corroborate it first --
// and, on corroboration, the ORIGINAL margin-top-up order intent must be
// settled in the very same store call, or that intent stays "unresolved"
// and keeps blocking the entire VST pipeline (see
// vst-unresolved-intent-blocking) even though the position-level gate was
// lifted.

const originalPauseSwitch = process.env.BULLET_VST_PAUSED;
process.env.BULLET_VST_PAUSED = "0";
after(() => {
  if (originalPauseSwitch === undefined) delete process.env.BULLET_VST_PAUSED;
  else process.env.BULLET_VST_PAUSED = originalPauseSwitch;
});

const NOW = Date.parse("2026-09-29T00:00:00.000Z");
const ACCOUNT_ID = "vst-account";
const SYMBOL = "ENSUSDT";
const POSITION_ID = "margin-top-up-position-1";
const SIGNAL_ID = "vst-signal-margin-1";
const REQUIRED_CAPABILITIES = [
  "vst_only",
  "complete_order_lookup",
  "guarded_long10_leverage_preparation",
  "atomic_protected_market_entry",
  "verified_core_stop_state",
  "verified_exact_full_position_close",
  "verified_position_state",
];

function pendingPositionRecord(overrides = {}) {
  return {
    sourceSignalId: SIGNAL_ID,
    symbol: SYMBOL,
    status: "open",
    snapshot: {
      environment: "vst",
      accountId: ACCOUNT_ID,
      exchangePositionId: POSITION_ID,
      marginTopUp: {
        status: "pending",
        amount: "5",
        expectedIsolatedMarginBefore: "20",
        stopOrderId: "stop-margin-top-up",
        entryOrderId: "entry-margin-top-up",
      },
    },
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function marginTopUpStore({ pendingPosition, resolveError = null, topUpRequest = null } = {}) {
  const data = {
    pendingPositions: pendingPosition ? [pendingPosition] : [],
    resolvedKeepOpen: [],
    settledIntentCalls: 0,
    topUpRequest: topUpRequest ?? {
      operation: "margin_top_up",
      environment: "vst",
      accountId: ACCOUNT_ID,
      symbol: SYMBOL,
      positionId: POSITION_ID,
      entryOrderId: "entry-margin-top-up",
      stopOrderId: "stop-margin-top-up",
      quantity: "0.1",
      stopLoss: "90",
      amount: "5",
      approvedTopUpMargin: "5",
      expectedIsolatedMarginBefore: "20",
      intentCreatedAt: NOW - 1_000,
    },
  };
  return {
    data,
    async withLeaderLock(callback) { return callback(); },
    async getPending() { return null; },
    async listUnresolvedIntents() { return []; },
    async getIntent() { return { request: data.topUpRequest }; },
    async reserveIntent() { throw new Error("margin-top-up-keep-open must never reserve a new intent"); },
    async listMarginTopUpPendingPositions() { return data.pendingPositions; },
    async resolveMarginTopUpKeepOpen(sourceSignalId, { resolvedBy, note }) {
      data.settledIntentCalls += 1;
      if (resolveError) throw resolveError;
      const position = data.pendingPositions.find((row) => row.sourceSignalId === sourceSignalId);
      if (!position) throw new Error("vst_position_not_found");
      data.resolvedKeepOpen.push({ sourceSignalId, resolvedBy, note });
      return { sourceSignalId, symbol: position.symbol, status: "open", updatedAt: new Date(NOW).toISOString() };
    },
  };
}

function marginTopUpBroker({
  exchangeMargin, readMarginTopUpMargin = null, verifyMarginTopUpNotAdded = null,
} = {}) {
  let performIntentCalls = 0;
  return {
    async getCapabilities() {
      return { environment: "vst", verified: true, accountId: ACCOUNT_ID, features: REQUIRED_CAPABILITIES };
    },
    async readPlanningInputs() { throw new Error("not needed for margin-top-up-keep-open tests"); },
    async readAccountState() { return { verified: true, positions: [], openOrders: [] }; },
    async readMarketMark() { return { verified: true, price: 100, observedAt: new Date(NOW).toISOString() }; },
    async readPosition() { throw new Error("margin-top-up-keep-open must use readMarginTopUpMargin, not readPosition"); },
    async readMarginTopUpMargin(...args) {
      if (typeof readMarginTopUpMargin === "function") return readMarginTopUpMargin(...args);
      return exchangeMargin;
    },
    async verifyMarginTopUpNotAdded(...args) {
      if (typeof verifyMarginTopUpNotAdded === "function") {
        return verifyMarginTopUpNotAdded(...args);
      }
      return {
        verified: true,
        status: "not_added",
        symbol: SYMBOL,
        positionId: POSITION_ID,
        safe: true,
        protectiveStop: {
          orderId: "stop-margin-top-up",
          status: "NEW",
          workingType: "MARK_PRICE",
        },
      };
    },
    get performIntentCalls() { return performIntentCalls; },
    async performIntent() {
      performIntentCalls += 1;
      throw new Error("margin-top-up-keep-open must never submit an exchange order");
    },
    async reconcileIntent() { throw new Error("margin-top-up-keep-open must never reconcile an intent"); },
  };
}

test("verifyMarginTopUpNotAddedAndResolve resolves keep-open once BingX corroborates margin was not added, settling the intent atomically with it", async () => {
  const store = marginTopUpStore({ pendingPosition: pendingPositionRecord() });
  const broker = marginTopUpBroker({
    verifyMarginTopUpNotAdded: async () => ({
      verified: true,
      status: "not_added",
      symbol: SYMBOL,
      positionId: POSITION_ID,
      safe: true,
      protectiveStop: {
        orderId: "stop-margin-top-up",
        status: "NEW",
        workingType: "MARK_PRICE",
      },
    }),
  });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.verifyMarginTopUpNotAddedAndResolve(SIGNAL_ID, {
    resolvedBy: "owner-user-1", note: null,
  });

  assert.equal(result.kind, "resolved");
  assert.equal(store.data.resolvedKeepOpen.length, 1);
  assert.equal(store.data.resolvedKeepOpen[0].resolvedBy, "owner-user-1");
  // The single store call is the atomic settlement point for both the
  // position snapshot and the underlying order intent -- see
  // vst-store.mjs resolveMarginTopUpKeepOpen, which now settles the
  // "margin-top-up" phase intent in the same transaction.
  assert.equal(store.data.settledIntentCalls, 1);
});

test("verifyMarginTopUpNotAddedAndResolve refuses when full margin history contains an addition", async () => {
  const store = marginTopUpStore({ pendingPosition: pendingPositionRecord() });
  const broker = marginTopUpBroker({
    verifyMarginTopUpNotAdded: async () => ({
      verified: false,
      status: "addition_found",
      additions: 1,
    }),
  });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.verifyMarginTopUpNotAddedAndResolve(SIGNAL_ID, {
    resolvedBy: "owner-user-1", note: null,
  });

  assert.equal(result.kind, "mismatch_margin_was_added");
  assert.equal(store.data.resolvedKeepOpen.length, 0);
  assert.equal(broker.performIntentCalls, 0);
});

test("verifyMarginTopUpNotAddedAndResolve refuses when full history or stop protection is unverified", async () => {
  const store = marginTopUpStore({ pendingPosition: pendingPositionRecord() });
  const broker = marginTopUpBroker({
    verifyMarginTopUpNotAdded: async () => ({
      verified: false, status: "unsafe_protection", safe: false,
    }),
  });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.verifyMarginTopUpNotAddedAndResolve(SIGNAL_ID, {
    resolvedBy: "owner-user-1", note: null,
  });

  assert.equal(result.kind, "history_or_protection_unverified");
  assert.equal(store.data.resolvedKeepOpen.length, 0);
});

test("readMarginTopUpMarginNow only exposes a not-added reading after history and safe protection are verified", async () => {
  const store = marginTopUpStore({ pendingPosition: pendingPositionRecord() });
  let checkedRequest;
  const broker = marginTopUpBroker({
    readMarginTopUpMargin: async () => {
      throw new Error("informational result must not trust initialMargin by itself");
    },
    verifyMarginTopUpNotAdded: async (request) => {
      checkedRequest = request;
      return {
        verified: true,
        status: "not_added",
        safe: true,
        symbol: SYMBOL,
        positionId: POSITION_ID,
        isolatedMargin: "20",
        protectiveStop: {
          orderId: "stop-margin-top-up",
          status: "NEW",
          workingType: "MARK_PRICE",
        },
      };
    },
  });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.readMarginTopUpMarginNow(SIGNAL_ID);

  assert.equal(result.kind, "ok");
  assert.equal(result.isolatedMargin, "20");
  assert.equal(result.expectedIsolatedMarginAfter, "25");
  assert.equal(checkedRequest.intentCreatedAt, NOW - 1_000);
});

test("readMarginTopUpMarginNow returns indeterminate when history contains an addition", async () => {
  const store = marginTopUpStore({ pendingPosition: pendingPositionRecord() });
  const broker = marginTopUpBroker({
    verifyMarginTopUpNotAdded: async () => ({
      verified: false,
      status: "addition_found",
      additions: 1,
    }),
  });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.readMarginTopUpMarginNow(SIGNAL_ID);

  assert.equal(result.kind, "history_or_protection_unverified");
  assert.equal(Object.hasOwn(result, "isolatedMargin"), false);
});

test("verifyMarginTopUpNotAddedAndResolve keeps an unverified exchange position unresolved", async () => {
  const store = marginTopUpStore({ pendingPosition: pendingPositionRecord() });
  const broker = marginTopUpBroker({
    verifyMarginTopUpNotAdded: async () => ({ verified: false, status: "unknown" }),
  });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.verifyMarginTopUpNotAddedAndResolve(SIGNAL_ID, {
    resolvedBy: "owner-user-1", note: null,
  });

  assert.equal(result.kind, "history_or_protection_unverified");
  assert.equal(store.data.resolvedKeepOpen.length, 0);
});

test("verifyMarginTopUpNotAddedAndResolve defers instead of guessing when history read fails", async () => {
  const store = marginTopUpStore({ pendingPosition: pendingPositionRecord() });
  const broker = marginTopUpBroker({
    verifyMarginTopUpNotAdded: async () => { throw new Error("temporary_network_error"); },
  });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.verifyMarginTopUpNotAddedAndResolve(SIGNAL_ID, {
    resolvedBy: "owner-user-1", note: null,
  });

  assert.equal(result.kind, "read_unavailable");
  assert.equal(store.data.resolvedKeepOpen.length, 0);
});

test("verifyMarginTopUpNotAddedAndResolve reports not_found for a signal with no margin-top-up-pending position", async () => {
  const store = marginTopUpStore({ pendingPosition: pendingPositionRecord() });
  const broker = marginTopUpBroker({});
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.verifyMarginTopUpNotAddedAndResolve("no-such-signal", {
    resolvedBy: "owner-user-1", note: null,
  });

  assert.equal(result.kind, "not_found");
  assert.equal(store.data.resolvedKeepOpen.length, 0);
});

test("verifyMarginTopUpNotAddedAndResolve refuses to act on a position from a different account or environment", async () => {
  const store = marginTopUpStore({
    pendingPosition: pendingPositionRecord({
      snapshot: {
        environment: "vst",
        accountId: "some-other-account",
        exchangePositionId: POSITION_ID,
        marginTopUp: { status: "pending", amount: "5", expectedIsolatedMarginBefore: "20" },
      },
    }),
  });
  const broker = marginTopUpBroker({});
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.verifyMarginTopUpNotAddedAndResolve(SIGNAL_ID, {
    resolvedBy: "owner-user-1", note: null,
  });

  assert.equal(result.kind, "blocked");
  assert.equal(result.reason, "position_account_or_environment_mismatch");
  assert.equal(store.data.resolvedKeepOpen.length, 0);
});

test("verifyMarginTopUpNotAddedAndResolve is blocked without live mutation capabilities", async () => {
  const store = marginTopUpStore({ pendingPosition: pendingPositionRecord() });
  const broker = marginTopUpBroker({ exchangeMargin: { verified: true, positionId: POSITION_ID, isolatedMargin: "20" } });
  broker.getCapabilities = async () => ({ environment: "vst", verified: false, features: [] });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.verifyMarginTopUpNotAddedAndResolve(SIGNAL_ID, {
    resolvedBy: "owner-user-1", note: null,
  });

  assert.equal(result.kind, "blocked");
  assert.equal(store.data.resolvedKeepOpen.length, 0);
});
