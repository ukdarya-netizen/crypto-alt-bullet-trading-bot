import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createVstStore } from "../vst-store.mjs";
import { createVstWorker } from "../vst-worker.mjs";

// "Закрыть сейчас" on the margin-top-up-pending manual-review card: the
// owner would rather close the position than confirm "margin not added,
// keep open" (see vst-margin-top-up-keep-open.test.mjs). Mirrors
// vst-manual-review-close-now.test.mjs's discipline for the analogous
// "error" position path: a bad or unverifiable fill must never fabricate a
// close, and the stuck margin-top-up order intent must be settled in the
// SAME store call that records the close, or listUnresolvedIntents() keeps
// blocking the entire VST pipeline even though the position itself closed.

const originalPauseSwitch = process.env.BULLET_VST_PAUSED;
process.env.BULLET_VST_PAUSED = "0";
after(() => {
  if (originalPauseSwitch === undefined) delete process.env.BULLET_VST_PAUSED;
  else process.env.BULLET_VST_PAUSED = originalPauseSwitch;
});

const NOW = Date.parse("2026-09-29T00:00:00.000Z");
const ACCOUNT_ID = "vst-account";
const SYMBOL = "ENSUSDT";
const SIGNAL_ID = "vst-signal-margin-close-1";
const INTENT_SERIALIZATION_LOCK_NAMESPACE = 4_348_997;
const INTENT_SERIALIZATION_LOCK_SQL =
  "SELECT pg_advisory_xact_lock($1, hashtext($2))";
const REQUIRED_CAPABILITIES = [
  "vst_only",
  "complete_order_lookup",
  "guarded_long10_leverage_preparation",
  "atomic_protected_market_entry",
  "verified_core_stop_state",
  "verified_exact_full_position_close",
  "verified_position_state",
];

const baseFill = {
  price: "22.7",
  quantity: "12",
  at: "2026-09-27T11:00:00.000Z",
  exchangeOrderId: "9988776655",
  fee: { asset: "USDT", amount: "0.05" },
};

// --- vst-store.mjs: resolveMarginTopUpPositionAsClosed --------------------

function marginTopUpCloseTestPool({ positionRow, signalRow, intentRow }) {
  let position = positionRow ? { ...positionRow } : null;
  let signal = signalRow ? { ...signalRow } : null;
  let intent = intentRow ? { ...intentRow } : null;
  const events = [];
  const statements = [];
  const client = {
    async query(sql, params = []) {
      const trimmed = sql.trim();
      statements.push({ sql: trimmed, params });
      if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK") {
        return { rowCount: 0, rows: [] };
      }
      if (trimmed === INTENT_SERIALIZATION_LOCK_SQL) {
        assert.deepEqual(params, [INTENT_SERIALIZATION_LOCK_NAMESPACE, SIGNAL_ID]);
        return { rowCount: 1, rows: [{ pg_advisory_xact_lock: null }] };
      }
      if (sql.includes("FROM vst_positions") && sql.includes("FOR UPDATE")) {
        const [sourceSignalId] = params;
        const match = position && position.source_signal_id === sourceSignalId ? position : null;
        return { rowCount: match ? 1 : 0, rows: match ? [match] : [] };
      }
      if (sql.includes("FROM vst_order_intents") && sql.includes("FOR UPDATE")) {
        const [sourceSignalId] = params;
        const match = intent && intent.source_signal_id === sourceSignalId ? intent : null;
        return { rowCount: match ? 1 : 0, rows: match ? [match] : [] };
      }
      if (sql.includes("UPDATE vst_order_intents")) {
        const [sourceSignalId] = params;
        if (intent && intent.source_signal_id === sourceSignalId) {
          intent = { ...intent, state: "failed" };
        }
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE vst_positions SET status =")) {
        const [sourceSignalId, snapshotJson] = params;
        position = {
          ...position,
          source_signal_id: sourceSignalId,
          status: "closed",
          snapshot: JSON.parse(snapshotJson),
          updated_at: new Date().toISOString(),
        };
        return { rowCount: 1, rows: [position] };
      }
      if (sql.includes("UPDATE vst_signals SET status =")) {
        const [sourceSignalId] = params;
        if (!signal || signal.source_signal_id !== sourceSignalId) return { rowCount: 0, rows: [] };
        signal = { ...signal, status: "closed", reason: null };
        return { rowCount: 1, rows: [{ source_signal_id: sourceSignalId }] };
      }
      if (sql.includes("INSERT INTO vst_events")) {
        events.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query in marginTopUpCloseTestPool: ${sql}`);
    },
    release() {},
  };
  return {
    events,
    statements,
    getPosition: () => position,
    getSignal: () => signal,
    getIntent: () => intent,
    async connect() { return client; },
    async query() { throw new Error("not needed at pool level"); },
  };
}

function pendingPositionRow(overrides = {}) {
  return {
    source_signal_id: SIGNAL_ID,
    symbol: SYMBOL,
    status: "open",
    snapshot: {
      environment: "vst",
      accountId: ACCOUNT_ID,
      remainingQty: 12,
      coreQty: 12,
      runnerQty: 0,
      marginTopUp: { status: "pending", amount: "5", expectedIsolatedMarginBefore: "20" },
    },
    updated_at: "2026-09-27T10:00:00.000Z",
    ...overrides,
  };
}

test("resolveMarginTopUpPositionAsClosed closes the position and settles the stuck margin-top-up intent atomically", async () => {
  const positionRow = pendingPositionRow();
  const signalRow = { source_signal_id: SIGNAL_ID, status: "open", reason: null };
  const intentRow = { source_signal_id: SIGNAL_ID, phase: "margin-top-up", state: "unknown" };
  const pool = marginTopUpCloseTestPool({ positionRow, signalRow, intentRow });
  const store = createVstStore(pool);

  const result = await store.resolveMarginTopUpPositionAsClosed(SIGNAL_ID, {
    fill: baseFill,
    resolvedBy: "owner-user-id",
    note: "Closed via close-now button",
  });

  assert.equal(result.status, "closed");
  assert.equal(pool.getSignal().status, "closed");
  assert.equal(pool.getIntent().state, "failed");
  const snapshot = pool.getPosition().snapshot;
  assert.equal(snapshot.remainingQty, 0);
  assert.equal(snapshot.coreQty, 0);
  assert.equal(snapshot.closeFill.exchangeOrderId, "9988776655");
  assert.equal(snapshot.manualResolution.outcome, "closed");
  assert.equal(snapshot.manualResolution.resolvedBy, "owner-user-id");
  assert.equal(snapshot.marginTopUp.status, "abandoned");
  assert.equal(pool.events.length, 1);
  assert.match(pool.events[0].sql, /vst_margin_top_up_manually_resolved_closed/);
  const lockIndex = pool.statements.findIndex(({ sql }) =>
    sql === INTENT_SERIALIZATION_LOCK_SQL);
  const rowLockIndex = pool.statements.findIndex(({ sql }) => sql.includes("FOR UPDATE"));
  assert.ok(lockIndex >= 0 && lockIndex < rowLockIndex,
    "shared signal advisory lock precedes position and intent row locks");
});

test("resolveMarginTopUpPositionAsClosed rejects a position that is not awaiting margin top-up review", async () => {
  const positionRow = pendingPositionRow({ status: "closed", snapshot: {} });
  const signalRow = { source_signal_id: SIGNAL_ID, status: "closed", reason: null };
  const store = createVstStore(marginTopUpCloseTestPool({ positionRow, signalRow, intentRow: null }));
  await assert.rejects(
    store.resolveMarginTopUpPositionAsClosed(SIGNAL_ID, { fill: baseFill, resolvedBy: "owner-user-id" }),
    /vst_position_not_awaiting_margin_top_up_review/,
  );
});

test("resolveMarginTopUpPositionAsClosed refuses when the margin-top-up intent is already settled", async () => {
  const positionRow = pendingPositionRow();
  const signalRow = { source_signal_id: SIGNAL_ID, status: "open", reason: null };
  const intentRow = { source_signal_id: SIGNAL_ID, phase: "margin-top-up", state: "reconciled" };
  const store = createVstStore(marginTopUpCloseTestPool({ positionRow, signalRow, intentRow }));
  await assert.rejects(
    store.resolveMarginTopUpPositionAsClosed(SIGNAL_ID, { fill: baseFill, resolvedBy: "owner-user-id" }),
    /vst_margin_top_up_intent_not_unresolved/,
  );
});

test("resolveMarginTopUpPositionAsClosed leaves the position and intent untouched for a mismatched fill", async () => {
  const positionRow = pendingPositionRow();
  const signalRow = { source_signal_id: SIGNAL_ID, status: "open", reason: "unconfirmed" };
  const intentRow = { source_signal_id: SIGNAL_ID, phase: "margin-top-up", state: "unknown" };
  const pool = marginTopUpCloseTestPool({ positionRow, signalRow, intentRow });
  await assert.rejects(
    createVstStore(pool).resolveMarginTopUpPositionAsClosed(SIGNAL_ID, {
      fill: { ...baseFill, quantity: "11" }, resolvedBy: "owner-user-id",
    }),
    /vst_manual_close_quantity_mismatch/,
  );
  assert.equal(pool.getPosition().status, "open");
  assert.equal(pool.getIntent().state, "unknown");
  assert.equal(pool.events.length, 0);
});

test("resolveMarginTopUpPositionAsClosed never fabricates a fill from incomplete evidence", async () => {
  const positionRow = pendingPositionRow();
  const signalRow = { source_signal_id: SIGNAL_ID, status: "open", reason: null };
  const intentRow = { source_signal_id: SIGNAL_ID, phase: "margin-top-up", state: "unknown" };
  const store = createVstStore(marginTopUpCloseTestPool({ positionRow, signalRow, intentRow }));
  const { exchangeOrderId: _dropped, ...incompleteFill } = baseFill;
  await assert.rejects(
    store.resolveMarginTopUpPositionAsClosed(SIGNAL_ID, { fill: incompleteFill, resolvedBy: "owner-user-id" }),
    TypeError,
  );
});

// --- vst-worker.mjs: closeMarginTopUpPositionNow ---------------------------

const POSITION_ID = "margin-top-up-position-1";

function pendingPositionRecord(overrides = {}) {
  return {
    sourceSignalId: SIGNAL_ID,
    symbol: SYMBOL,
    status: "open",
    snapshot: {
      environment: "vst",
      accountId: ACCOUNT_ID,
      exchangePositionId: POSITION_ID,
      remainingQty: 12,
      coreQty: 12,
      runnerQty: 0,
      marginTopUp: { status: "pending", amount: "5", expectedIsolatedMarginBefore: "20" },
    },
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function marginTopUpCloseWorkerStore({ pendingPosition, resolveError = null } = {}) {
  const data = {
    intents: [],
    pendingPositions: pendingPosition ? [pendingPosition] : [],
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
    async listMarginTopUpPendingPositions() { return data.pendingPositions; },
    async resolveMarginTopUpPositionAsClosed(sourceSignalId, { fill, resolvedBy, note }) {
      data.resolveCloseCalls += 1;
      if (resolveError && data.resolveCloseCalls === 1) throw resolveError;
      const position = data.pendingPositions.find((row) => row.sourceSignalId === sourceSignalId);
      if (!position) throw new Error("vst_position_not_found");
      data.resolvedCloses.push({ sourceSignalId, fill, resolvedBy, note });
      data.pendingPositions = data.pendingPositions.filter((row) => row.sourceSignalId !== sourceSignalId);
      return { sourceSignalId, symbol: position.symbol, status: "closed", updatedAt: new Date(NOW).toISOString() };
    },
    async listErrorPositions() { return []; },
    async listOpenPositions() { return []; },
    async listPendingCandidates() { return []; },
  };
}

function marginTopUpCloseWorkerBroker({ exchangePosition, reconcile, onPerform = null } = {}) {
  let performCalls = 0;
  return {
    performCalls: () => performCalls,
    async getCapabilities() {
      return { environment: "vst", verified: true, accountId: ACCOUNT_ID, features: REQUIRED_CAPABILITIES };
    },
    async readPlanningInputs() { throw new Error("not needed for margin-top-up close-now tests"); },
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

test("closeMarginTopUpPositionNow closes a margin-top-up-pending position and clears the stuck intent so the pipeline unblocks", async () => {
  const store = marginTopUpCloseWorkerStore({ pendingPosition: pendingPositionRecord() });
  const broker = marginTopUpCloseWorkerBroker({
    exchangePosition: { verified: true, quantity: 12, positionId: POSITION_ID },
    reconcile: () => verifiedFillEvidence,
  });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.closeMarginTopUpPositionNow(SIGNAL_ID, { resolvedBy: "owner-user-1" });

  assert.equal(result.kind, "closed");
  assert.equal(broker.performCalls(), 1);
  assert.equal(store.data.resolvedCloses.length, 1);
  assert.equal(store.data.resolvedCloses[0].resolvedBy, "owner-user-1");
  assert.equal(store.data.resolvedCloses[0].fill.exchangeOrderId, "9988776655");
  assert.equal(store.data.intents[0].phase, "manual_review_margin_top_up_close_now");
  assert.equal(store.data.intents[0].state, "reconciled");
  assert.equal(store.data.pendingPositions.length, 0);
});

test("closeMarginTopUpPositionNow reports already_flat and places no order when BingX shows no open position", async () => {
  const store = marginTopUpCloseWorkerStore({ pendingPosition: pendingPositionRecord() });
  const broker = marginTopUpCloseWorkerBroker({
    exchangePosition: { verified: true, quantity: 0, positionId: POSITION_ID },
    reconcile: () => verifiedFillEvidence,
  });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.closeMarginTopUpPositionNow(SIGNAL_ID, { resolvedBy: "owner-user-1" });

  assert.equal(result.kind, "already_flat");
  assert.equal(broker.performCalls(), 0);
  assert.equal(store.data.intents.length, 0);
  assert.equal(store.data.resolvedCloses.length, 0);
});

test("closeMarginTopUpPositionNow reports not_found for a signal with no margin-top-up-pending position", async () => {
  const store = marginTopUpCloseWorkerStore({ pendingPosition: pendingPositionRecord() });
  const broker = marginTopUpCloseWorkerBroker({ exchangePosition: { verified: true, quantity: 12, positionId: POSITION_ID } });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.closeMarginTopUpPositionNow("no-such-signal", { resolvedBy: "owner-user-1" });

  assert.equal(result.kind, "not_found");
});

test("closeMarginTopUpPositionNow refuses to act on a position from a different account or environment", async () => {
  const store = marginTopUpCloseWorkerStore({
    pendingPosition: pendingPositionRecord({
      snapshot: {
        environment: "vst",
        accountId: "some-other-account",
        remainingQty: 12,
        marginTopUp: { status: "pending", amount: "5", expectedIsolatedMarginBefore: "20" },
      },
    }),
  });
  const broker = marginTopUpCloseWorkerBroker({ exchangePosition: { verified: true, quantity: 12, positionId: POSITION_ID } });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.closeMarginTopUpPositionNow(SIGNAL_ID, { resolvedBy: "owner-user-1" });

  assert.equal(result.kind, "blocked");
  assert.equal(result.reason, "position_account_or_environment_mismatch");
  assert.equal(broker.performCalls(), 0);
});

test("closeMarginTopUpPositionNow refuses to close when the exchange position id does not match the one this record got stuck on", async () => {
  const store = marginTopUpCloseWorkerStore({ pendingPosition: pendingPositionRecord() });
  const broker = marginTopUpCloseWorkerBroker({
    exchangePosition: { verified: true, quantity: 12, positionId: "a-different-position" },
  });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.closeMarginTopUpPositionNow(SIGNAL_ID, { resolvedBy: "owner-user-1" });

  assert.equal(result.kind, "blocked");
  assert.equal(result.reason, "position_identity_not_verified");
  assert.equal(broker.performCalls(), 0);
  assert.equal(store.data.intents.length, 0);
});

test("closeMarginTopUpPositionNow refuses to close when the record never captured a position id to verify against", async () => {
  const store = marginTopUpCloseWorkerStore({
    pendingPosition: pendingPositionRecord({
      snapshot: {
        environment: "vst",
        accountId: ACCOUNT_ID,
        remainingQty: 12,
        marginTopUp: { status: "pending", amount: "5", expectedIsolatedMarginBefore: "20" },
      },
    }),
  });
  const broker = marginTopUpCloseWorkerBroker({
    exchangePosition: { verified: true, quantity: 12, positionId: POSITION_ID },
  });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const result = await worker.closeMarginTopUpPositionNow(SIGNAL_ID, { resolvedBy: "owner-user-1" });

  assert.equal(result.kind, "blocked");
  assert.equal(result.reason, "position_identity_not_verified");
  assert.equal(broker.performCalls(), 0);
});

test("closeMarginTopUpPositionNow uses its own phase so it never collides with a same-signal closeErrorPositionNow intent", async () => {
  const store = marginTopUpCloseWorkerStore({ pendingPosition: pendingPositionRecord() });
  const broker = marginTopUpCloseWorkerBroker({
    exchangePosition: { verified: true, quantity: 12, positionId: POSITION_ID },
    reconcile: () => verifiedFillEvidence,
  });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  await worker.closeMarginTopUpPositionNow(SIGNAL_ID, { resolvedBy: "owner-user-1" });

  assert.equal(store.data.intents.length, 1);
  assert.notEqual(store.data.intents[0].phase, "manual_review_close_now");
});

test("an unverified close-now attempt is finished by a later passive tick through the margin-top-up resolver, never the generic close fallback", async () => {
  let verified = false;
  const store = marginTopUpCloseWorkerStore({ pendingPosition: pendingPositionRecord() });
  const broker = marginTopUpCloseWorkerBroker({
    exchangePosition: { verified: true, quantity: 12, positionId: POSITION_ID },
    reconcile: () => verified
      ? verifiedFillEvidence
      : { verified: false, status: "unknown" },
  });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const firstAttempt = await worker.closeMarginTopUpPositionNow(SIGNAL_ID, { resolvedBy: "owner-user-1" });
  assert.equal(firstAttempt.kind, "unverified");
  assert.equal(broker.performCalls(), 1);
  assert.equal(store.data.intents[0].state, "unknown");
  assert.equal((await store.listUnresolvedIntents()).length, 1);

  verified = true;
  await worker.runOnce();

  assert.equal(broker.performCalls(), 1, "still no second live close order");
  assert.equal(store.data.resolvedCloses.length, 1);
  assert.equal(store.data.resolvedCloses[0].resolvedBy, "owner-user-1");
  assert.equal(store.data.intents[0].state, "reconciled");
  assert.equal(store.data.pendingPositions.length, 0);
  assert.equal((await store.listUnresolvedIntents()).length, 0);
});

test("a ledger write failure after a verified fill retries only the save, never a second exchange order", async () => {
  const store = marginTopUpCloseWorkerStore({
    pendingPosition: pendingPositionRecord(),
    resolveError: new Error("transient_db_write_failure"),
  });
  const broker = marginTopUpCloseWorkerBroker({
    exchangePosition: { verified: true, quantity: 12, positionId: POSITION_ID },
    reconcile: () => verifiedFillEvidence,
  });
  const worker = createVstWorker({ store, broker, clock: () => NOW, sizingLimits: { environment: "vst" } });

  const firstAttempt = await worker.closeMarginTopUpPositionNow(SIGNAL_ID, { resolvedBy: "owner-user-1" });
  assert.equal(firstAttempt.kind, "closed_but_unrecorded");
  assert.equal(broker.performCalls(), 1);
  assert.equal(store.data.resolvedCloses.length, 0);

  const retry = await worker.closeMarginTopUpPositionNow(SIGNAL_ID, { resolvedBy: "owner-user-1" });
  assert.equal(retry.kind, "closed");
  assert.equal(broker.performCalls(), 1, "retry must never place a second live close order");
  assert.equal(store.data.resolvedCloses.length, 1);
});
