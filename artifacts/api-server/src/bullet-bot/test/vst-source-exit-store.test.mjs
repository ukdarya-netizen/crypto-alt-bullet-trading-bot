import assert from "node:assert/strict";
import test from "node:test";
import { createVstStore } from "../vst-store.mjs";

const SIGNAL_ID = "cab-source-exit-1";
const SIGNAL_AT = "2025-03-01T00:00:00.000Z";
const EXIT_AT = "2025-03-01T00:01:00.000Z";
const AS_OF = "2025-03-01T00:02:00.000Z";
const OBSERVED_AT = Date.parse(AS_OF);

function sourcePosition(overrides = {}) {
  return {
    sourceSignalId: SIGNAL_ID,
    symbol: "ETHUSDT",
    sourceStatus: "reclassified",
    sourceUpdatedAt: EXIT_AT,
    sourceClosedAt: null,
    sourceExitPrice: null,
    sourceCancelReason: "withdrawn",
    ...overrides,
  };
}

function memoryPool({
  signalStatus = "pending",
  withPosition = false,
  positionStatus = "open",
  snapshot = { entryAt: SIGNAL_AT },
} = {}) {
  const signal = {
    source_signal_id: SIGNAL_ID,
    body: { sourceSignalId: SIGNAL_ID, symbol: "ETHUSDT", signalAt: SIGNAL_AT },
    status: signalStatus,
  };
  const position = withPosition
    ? { symbol: "ETHUSDT", status: positionStatus, snapshot }
    : null;
  const events = [];
  let nextEventId = 1;
  let transactionTail = Promise.resolve();

  function eventRow(event) {
    return {
      id: event.id,
      source_signal_id: event.source_signal_id,
      kind: event.kind,
      detail: event.detail,
      created_at: event.created_at,
    };
  }

  function execute(sql, params = []) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.startsWith("SELECT s.source_signal_id, s.body")) {
      if (params[0] !== signal.source_signal_id) return { rowCount: 0, rows: [] };
      return {
        rowCount: 1,
        rows: [{
          source_signal_id: signal.source_signal_id,
          body: signal.body,
          signal_status: signal.status,
          position_symbol: position?.symbol ?? null,
          position_status: position?.status ?? null,
          position_snapshot: position?.snapshot ?? null,
        }],
      };
    }
    if (normalized.startsWith("SELECT id, source_signal_id, kind, detail, created_at::text AS created_at FROM vst_events") &&
        normalized.includes("kind = 'source_exit_requested'")) {
      const rows = events
        .filter((event) => event.source_signal_id === params[0] && event.kind === "source_exit_requested")
        .sort((a, b) => a.id - b.id)
        .slice(0, 1)
        .map(eventRow);
      return { rowCount: rows.length, rows };
    }
    if (normalized.startsWith("UPDATE vst_events SET detail = detail || $2::jsonb")) {
      const event = events.find((candidate) => candidate.id === params[0]);
      if (!event) return { rowCount: 0, rows: [] };
      Object.assign(event.detail, JSON.parse(params[1]));
      return { rowCount: 1, rows: [eventRow(event)] };
    }
    if (normalized.startsWith("SELECT id FROM vst_events")) {
      const rows = events.filter((event) =>
        event.source_signal_id === params[0] &&
        event.kind === "source_exit_completed" &&
        event.detail.requestId === params[1]);
      return { rowCount: rows.length, rows: rows.slice(0, 1).map((event) => ({ id: event.id })) };
    }
    if (normalized.startsWith("INSERT INTO vst_events")) {
      const kind = normalized.includes("'source_exit_requested'")
        ? "source_exit_requested"
        : "source_exit_completed";
      const detailParameter = kind === "source_exit_requested" ? params[1] : params[1];
      const event = {
        id: nextEventId++,
        source_signal_id: params[0],
        kind,
        detail: JSON.parse(detailParameter),
        created_at: new Date(OBSERVED_AT + nextEventId).toISOString(),
      };
      events.push(event);
      return {
        rowCount: 1,
        rows: normalized.includes("RETURNING")
          ? [eventRow(event)]
          : [],
      };
    }
    if (normalized.startsWith("SELECT EXISTS (")) {
      const sourceSignalId = params[0];
      const pending = events.some((request) =>
        request.source_signal_id === sourceSignalId &&
        request.kind === "source_exit_requested" &&
        !events.some((completion) =>
          completion.source_signal_id === sourceSignalId &&
          completion.kind === "source_exit_completed" &&
          completion.detail.requestId === request.detail.requestId));
      return { rowCount: 1, rows: [{ pending }] };
    }
    if (normalized.startsWith("SELECT request.id, request.source_signal_id, request.kind, request.detail")) {
      const requests = events.filter((request) =>
        request.kind === "source_exit_requested" &&
        !events.some((completion) =>
          completion.source_signal_id === request.source_signal_id &&
          completion.kind === "source_exit_completed" &&
          completion.detail.requestId === request.detail.requestId))
        .sort((a, b) => a.id - b.id)
        .map(eventRow);
      return { rowCount: requests.length, rows: requests };
    }
    if (normalized.startsWith("SELECT source_signal_id FROM vst_events")) {
      const event = events.find((candidate) =>
        candidate.kind === "source_exit_requested" && candidate.detail.requestId === params[0]);
      return event
        ? { rowCount: 1, rows: [{ source_signal_id: event.source_signal_id }] }
        : { rowCount: 0, rows: [] };
    }
    if (normalized.startsWith("SELECT source_signal_id FROM vst_signals")) {
      return params[0] === signal.source_signal_id
        ? { rowCount: 1, rows: [{ source_signal_id: signal.source_signal_id }] }
        : { rowCount: 0, rows: [] };
    }
    if (normalized.startsWith("SELECT id, source_signal_id, detail FROM vst_events")) {
      const event = events.find((candidate) =>
        candidate.kind === "source_exit_requested" && candidate.detail.requestId === params[0]);
      return event
        ? { rowCount: 1, rows: [{
          id: event.id,
          source_signal_id: event.source_signal_id,
          detail: event.detail,
        }] }
        : { rowCount: 0, rows: [] };
    }
    if (normalized.startsWith("SELECT id, source_signal_id, kind, detail, created_at::text AS created_at FROM vst_events") &&
        normalized.includes("kind = 'source_exit_completed'")) {
      const rows = events.filter((event) =>
        event.source_signal_id === params[0] &&
        event.kind === "source_exit_completed" &&
        event.detail.requestId === params[1])
        .sort((a, b) => a.id - b.id)
        .slice(0, 1)
        .map(eventRow);
      return { rowCount: rows.length, rows };
    }
    throw new Error(`Unexpected source-exit store query: ${normalized}`);
  }

  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized === "BEGIN") {
        const previous = transactionTail;
        let release;
        transactionTail = new Promise((resolve) => { release = resolve; });
        await previous;
        this.releaseTransaction = release;
        return { rowCount: null, rows: [] };
      }
      if (normalized === "COMMIT" || normalized === "ROLLBACK") {
        this.releaseTransaction?.();
        this.releaseTransaction = null;
        return { rowCount: null, rows: [] };
      }
      return execute(sql, params);
    },
    release() {},
  };
  return {
    events,
    async query(sql, params = []) { return execute(sql, params); },
    async connect() { return client; },
  };
}

function poll(store, source = sourcePosition(), {
  asOf = AS_OF,
  observedAt = OBSERVED_AT,
  id = SIGNAL_ID,
} = {}) {
  return store.queueSourceExitRequests({
    asOf,
    positions: new Map([[id, source]]),
    observedAt,
  });
}

test("VST cancelled-review request persists and deduplicates after store recreation", async () => {
  const pool = memoryPool({ signalStatus: "open", withPosition: true, snapshot: { entryAt: SIGNAL_AT } });
  const request = {
    asOf: AS_OF, observedAt: OBSERVED_AT,
    positions: new Map([[SIGNAL_ID, sourcePosition({ sourceAction: "review", sourceStatus: "cancelled" })]]),
  };
  const store = createVstStore(pool);
  const queued = await store.queueSourceExitRequests(request);
  assert.equal(queued.queued.length, 1);
  assert.equal(queued.queued[0].evidence.sourceAction, "review");
  assert.equal(queued.queued[0].evidence.sourceExitPrice, null);
  const restarted = createVstStore(pool);
  await restarted.queueSourceExitRequests(request);
  assert.equal(pool.events.filter(event => event.kind === "source_exit_requested").length, 1);
  assert.equal(await restarted.hasPendingSourceExitRequest(SIGNAL_ID), true);
  assert.equal((await restarted.listPendingSourceExitRequests()).length, 1);
});

test("fresh reclassified withdrawal queues even without source close time or exit price", async () => {
  const pool = memoryPool({
    signalStatus: "open",
    withPosition: true,
    snapshot: { entryAt: SIGNAL_AT, marker: "worker-owned fields remain elsewhere" },
  });
  const store = createVstStore(pool);
  const result = await poll(store);

  assert.equal(result.queued.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.queued[0].reason, "source_withdrawal");
  assert.equal(result.queued[0].evidence.sourceStatus, "reclassified");
  assert.equal(result.queued[0].evidence.sourceClosedAt, null);
  assert.equal(result.queued[0].evidence.sourceExitPrice, null);
  assert.match(result.queued[0].requestId, /^source-exit-[a-f0-9]{64}$/);
  assert.equal(pool.events[0].kind, "source_exit_requested");
  assert.equal(pool.events[0].detail.symbol, "ETHUSDT");
  assert.equal(pool.events[0].detail.evidence.sourceCancelReason, "withdrawn");
});

test("source withdrawal must be chronologically at or after entry or signal time", async () => {
  const pool = memoryPool({
    signalStatus: "unknown",
    withPosition: true,
    positionStatus: "unknown",
    snapshot: {},
  });
  const store = createVstStore(pool);
  const result = await poll(store, sourcePosition({
    sourceUpdatedAt: "2025-02-28T23:59:59.000Z",
  }));

  assert.equal(result.queued.length, 0);
  assert.equal(result.refreshed.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, "source_exit_evidence_not_eligible");
  assert.equal(pool.events.length, 0);
});

test("null source-exit evidence is visibly rejected without creating a request", async () => {
  const pool = memoryPool({ signalStatus: "pending" });
  const store = createVstStore(pool);
  const result = await poll(store, sourcePosition({ sourceStatus: "active" }));

  assert.equal(result.queued.length, 0);
  assert.equal(result.refreshed.length, 0);
  assert.deepEqual(result.rejected, [{
    sourceSignalId: SIGNAL_ID,
    reason: "source_exit_evidence_not_eligible",
  }]);
  assert.equal(pool.events.length, 0);
});

test("existing request with newly ineligible evidence is rejected without refreshing immutable request metadata", async () => {
  const pool = memoryPool({ signalStatus: "pending" });
  const store = createVstStore(pool);
  const original = await poll(store);
  const originalDetail = structuredClone(pool.events[0].detail);
  assert.equal(original.queued.length, 1);

  const ineligible = await poll(store, sourcePosition({
    sourceUpdatedAt: "2025-02-28T23:59:59.000Z",
  }), {
    asOf: "2025-03-01T00:03:00.000Z",
    observedAt: Date.parse("2025-03-01T00:03:00.000Z"),
  });

  assert.equal(ineligible.queued.length, 0);
  assert.equal(ineligible.refreshed.length, 0);
  assert.deepEqual(ineligible.rejected, [{
    sourceSignalId: SIGNAL_ID,
    requestId: original.queued[0].requestId,
    reason: "source_exit_evidence_not_eligible",
  }]);
  assert.deepEqual(pool.events[0].detail, originalDetail);
});

test("closed positions and terminal signals retain their specific no-entry rejections", async () => {
  const closedPositionPool = memoryPool({
    signalStatus: "closed",
    withPosition: true,
    positionStatus: "closed",
  });
  const closedPosition = await poll(
    createVstStore(closedPositionPool),
    sourcePosition({ sourceUpdatedAt: "2025-02-28T23:59:59.000Z" }),
  );
  assert.equal(closedPosition.rejected[0].reason, "vst_position_already_closed");
  assert.equal(closedPositionPool.events.length, 0);

  const terminalPool = memoryPool({ signalStatus: "rejected" });
  const terminal = await poll(
    createVstStore(terminalPool),
    sourcePosition({ sourceStatus: "active" }),
  );
  assert.equal(terminal.rejected[0].reason, "terminal_no_entry_signal");
  assert.equal(terminalPool.events.length, 0);
});

test("concurrent enqueue deduplicates by signal row lock and active reopening cannot revoke request", async () => {
  const pool = memoryPool({ signalStatus: "pending" });
  const store = createVstStore(pool);
  const [first, second] = await Promise.all([poll(store), poll(store)]);

  assert.equal(first.queued.length + second.queued.length, 1);
  assert.equal(first.refreshed.length + second.refreshed.length, 1);
  assert.equal(pool.events.filter((event) => event.kind === "source_exit_requested").length, 1);

  const reopened = await poll(store, sourcePosition({
    sourceStatus: "active",
    sourceUpdatedAt: "2025-03-01T00:01:30.000Z",
  }), {
    asOf: "2025-03-01T00:03:00.000Z",
    observedAt: Date.parse("2025-03-01T00:03:00.000Z"),
  });
  assert.equal(reopened.refreshed.length, 0);
  assert.equal(reopened.rejected[0].reason, "source_exit_evidence_not_eligible");
  assert.equal((await store.listPendingSourceExitRequests()).length, 1);
  assert.equal((await store.listPendingSourceExitRequests())[0].asOf, AS_OF);
  assert.equal(pool.events[0].detail.evidence.sourceStatus, "reclassified");
  assert.equal(pool.events[0].detail.latestAsOf, AS_OF);
  assert.equal(pool.events[0].detail.latestObservedAt, new Date(OBSERVED_AT).toISOString());
});

test("request survives store recreation, completion is idempotent, and later polls cannot revive it", async () => {
  const pool = memoryPool({ signalStatus: "opening" });
  const requestStore = createVstStore(pool);
  const queued = await poll(requestStore);
  const requestId = queued.queued[0].requestId;

  const restartedStore = createVstStore(pool);
  assert.equal((await restartedStore.listPendingSourceExitRequests()).length, 1);
  const [pending] = await restartedStore.listPendingSourceExitRequests({
    sourceSignalId: SIGNAL_ID,
    limit: 1,
  });
  assert.equal(pending.id, requestId);
  assert.equal(await restartedStore.hasPendingSourceExitRequest(SIGNAL_ID), true);

  const completed = await restartedStore.finishSourceExitRequest(requestId, {
    outcome: "closed_after_verified_cleanup",
    detail: { exchangeVerified: true, runnerCleanup: "confirmed" },
  });
  assert.equal(completed.kind, "source_exit_completed");
  assert.equal(completed.detail.evidence.reason, "source_withdrawal");
  const replayed = await restartedStore.finishSourceExitRequest(requestId, {
    outcome: "different_replay",
    detail: {},
  });
  assert.equal(replayed.eventId, completed.eventId);

  const repeated = await poll(restartedStore);
  assert.equal(repeated.queued.length, 0);
  assert.equal(repeated.refreshed.length, 1);
  assert.equal(repeated.refreshed[0].completed, true);
  assert.deepEqual(await restartedStore.listPendingSourceExitRequests(), []);
  assert.equal(await restartedStore.hasPendingSourceExitRequest(SIGNAL_ID), false);
  assert.equal(pool.events.filter((event) => event.kind === "source_exit_requested").length, 1);
  assert.equal(pool.events.filter((event) => event.kind === "source_exit_completed").length, 1);
});

test("different terminal evidence is rejected without replacing original provenance", async () => {
  const pool = memoryPool();
  const store = createVstStore(pool);
  await poll(store);
  const conflicting = await poll(store, sourcePosition({
    sourceUpdatedAt: "2025-03-01T00:01:30.000Z",
  }));

  assert.equal(conflicting.rejected[0].reason, "source_exit_evidence_conflict");
  assert.equal(pool.events[0].detail.evidence.sourceUpdatedAt, EXIT_AT);
});