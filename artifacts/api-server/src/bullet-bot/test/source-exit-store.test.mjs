import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "../store.mjs";

const sourceSignalId = "cab-signal-10536";
const evidence = {
  sourceSignalId,
  signalAt: "2026-09-25T00:35:48.399Z",
  botEnqueuedAt: "2026-09-25T00:35:49.000Z",
  symbol: "WAXPUSDT",
  initialStopPrice: "0.0055522",
  sourceStatus: "reclassified",
  sourceUpdatedAt: "2026-10-01T11:59:59.000Z",
  sourceClosedAt: null,
  sourceEntryPrice: "0.006035",
  sourceExitPrice: null,
  sourcePnlPercent: null,
  sourcePeakPrice: null,
  sourceStopLossPrice: null,
  sourceTrailingStopLevel: null,
  sourceLastMilestone: null,
  sourceCancelReason: "lc_no_lower_ob_moved_to_wait",
};

function sourceExitStore() {
  let nextEventId = 1;
  const events = [];
  const position = {
    status: "open",
    snapshot: {
      sourceSignalId,
      symbol: "WAXPUSDT",
      mode: "paper",
      remainingQty: 100,
      entryAt: "2026-09-25T00:36:38.399Z",
      signalAt: evidence.signalAt,
    },
  };

  const query = async (sql, params = []) => {
    const text = sql.trim();
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
      return { rowCount: 0, rows: [] };
    }
    if (text.startsWith("SELECT source_signal_id\n            FROM btb_positions")) {
      return position.status === "open"
        ? { rowCount: 1, rows: [{ source_signal_id: sourceSignalId }] }
        : { rowCount: 0, rows: [] };
    }
    if (text.startsWith("SELECT snapshot\n              FROM btb_positions")) {
      return position.status === "open"
        ? { rowCount: 1, rows: [{ snapshot: position.snapshot }] }
        : { rowCount: 0, rows: [] };
    }
    if (text.startsWith("SELECT id, detail, created_at\n              FROM btb_events")) {
      const row = events.find((event) =>
        event.source_signal_id === params[0] &&
        event.kind === "paper_source_exit_requested");
      return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    }
    if (text.startsWith("INSERT INTO btb_events (source_signal_id, kind, detail)")) {
      const [id, detail] = params;
      const kind = text.includes("'paper_source_exit_requested'")
        ? "paper_source_exit_requested"
        : "paper_source_exit_applied";
      const row = {
        id: nextEventId++,
        source_signal_id: id,
        kind,
        detail: JSON.parse(detail),
        created_at: "2026-10-01T12:00:01.000Z",
      };
      events.push(row);
      return { rowCount: 1, rows: [row] };
    }
    if (text.startsWith("SELECT request.id, request.source_signal_id")) {
      const [filterId] = params;
      const pending = events.filter((request) =>
        request.kind === "paper_source_exit_requested" &&
        (filterId === null || request.source_signal_id === filterId) &&
        !events.some((applied) =>
          applied.kind === "paper_source_exit_applied" &&
          applied.source_signal_id === request.source_signal_id &&
          applied.detail.requestId === String(request.id)));
      return {
        rowCount: pending.length,
        rows: pending.map((request) => ({
          id: request.id,
          source_signal_id: request.source_signal_id,
          detail: request.detail,
          created_at: request.created_at,
        })),
      };
    }
    if (text.startsWith("SELECT request.id")) {
      const [id] = params;
      const pending = events.some((request) =>
        request.source_signal_id === id &&
        request.kind === "paper_source_exit_requested" &&
        !events.some((applied) =>
          applied.kind === "paper_source_exit_applied" &&
          applied.source_signal_id === id &&
          applied.detail.requestId === String(request.id)));
      return { rowCount: pending ? 1 : 0, rows: pending ? [{ id: 1 }] : [] };
    }
    if (text.startsWith("SELECT status, snapshot")) {
      return { rowCount: 1, rows: [{ status: position.status, snapshot: position.snapshot }] };
    }
    if (text.includes("WHERE id = $2::bigint")) {
      const [id, requestId] = params;
      const row = events.find((event) =>
        String(event.id) === String(requestId) &&
        event.source_signal_id === id &&
        event.kind === "paper_source_exit_requested");
      return {
        rowCount: row ? 1 : 0,
        rows: row ? [{ id: row.id, detail: row.detail }] : [],
      };
    }
    if (text.includes("kind = 'paper_source_exit_applied'")) {
      const [id, requestId] = params;
      const row = events.find((event) =>
        event.source_signal_id === id &&
        event.kind === "paper_source_exit_applied" &&
        event.detail.requestId === requestId);
      return { rowCount: row ? 1 : 0, rows: row ? [{ id: row.id }] : [] };
    }
    throw new Error(`Unexpected query: ${text.slice(0, 100)}`);
  };

  const pool = {
    query,
    connect: async () => ({ query, release() {} }),
  };
  return {
    store: createStore(pool),
    position,
    events,
  };
}

test("PAPER cancelled-review request persists and deduplicates across polls", async () => {
  const h = sourceExitStore();
  const request = {
    asOf: "2026-10-01T12:00:00.000Z",
    positions: new Map([[sourceSignalId, { ...evidence, sourceStatus: "cancelled", sourceAction: "review" }]]),
    observedAt: "2026-10-01T12:00:01.000Z",
  };
  const queued = await h.store.queueSourceExitRequests(request);
  assert.equal(queued.queued.length, 1);
  assert.equal(queued.queued[0].evidence.sourceAction, "review");
  assert.equal(queued.queued[0].evidence.sourceExitPrice, null);
  await h.store.queueSourceExitRequests(request);
  assert.equal(h.events.filter(event => event.kind === "paper_source_exit_requested").length, 1);
  assert.equal(await h.store.hasPendingSourceExitRequest(sourceSignalId), true);
  assert.equal((await h.store.listPendingSourceExitRequests()).length, 1);
});

test("PAPER source exit requests are durable, idempotent, and finish only after close", async () => {
  const h = sourceExitStore();
  const request = {
    asOf: "2026-10-01T12:00:00.000Z",
    positions: new Map([[sourceSignalId, evidence]]),
    observedAt: "2026-10-01T12:00:01.000Z",
  };
  const queued = await h.store.queueSourceExitRequests(request);
  assert.equal(queued.queued.length, 1);
  assert.equal(queued.queued[0].evidence.reason, "source_withdrawal");
  assert.equal(queued.queued[0].evidence.sourceClosedAt, null);
  assert.equal(queued.queued[0].evidence.sourceExitPrice, null);

  await h.store.queueSourceExitRequests({
    ...request,
    positions: new Map([[sourceSignalId, {
      ...evidence,
      sourceStatus: "active",
      sourceUpdatedAt: "2026-10-01T12:00:00.000Z",
      sourceCancelReason: null,
    }]]),
  });
  assert.equal(h.events.filter((event) =>
    event.kind === "paper_source_exit_requested").length, 1);
  assert.equal(await h.store.hasPendingSourceExitRequest(sourceSignalId), true);
  const pending = await h.store.listPendingSourceExitRequests({
    sourceSignalId,
    limit: 1,
  });
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].evidence, queued.queued[0].evidence);

  await assert.rejects(
    h.store.finishSourceExitRequest(sourceSignalId, queued.queued[0].id),
    /before its PAPER close is committed/,
  );
  assert.equal(await h.store.hasPendingSourceExitRequest(sourceSignalId), true);

  h.position.status = "closed";
  h.position.snapshot = {
    ...h.position.snapshot,
    status: "closed",
    sourceWithdrawal: {
      ...queued.queued[0].evidence,
      sourceCancelReason: "different decision",
    },
  };
  await assert.rejects(
    h.store.finishSourceExitRequest(sourceSignalId, queued.queued[0].id),
    /request was not found/,
  );
  assert.equal(await h.store.hasPendingSourceExitRequest(sourceSignalId), true);
  h.position.snapshot.sourceWithdrawal = queued.queued[0].evidence;
  assert.equal(await h.store.finishSourceExitRequest(sourceSignalId, queued.queued[0].id), true);
  assert.equal(await h.store.finishSourceExitRequest(sourceSignalId, queued.queued[0].id), true);
  assert.equal(await h.store.hasPendingSourceExitRequest(sourceSignalId), false);
  assert.deepEqual(await h.store.listPendingSourceExitRequests(), []);
  assert.equal(h.events.filter((event) =>
    event.kind === "paper_source_exit_applied").length, 1);
});