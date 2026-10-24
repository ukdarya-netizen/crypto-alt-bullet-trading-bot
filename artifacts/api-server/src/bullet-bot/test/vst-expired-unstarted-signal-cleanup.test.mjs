import assert from "node:assert/strict";
import test from "node:test";
import { createVstStore } from "../vst-store.mjs";

const NOW = Date.parse("2026-10-02T00:00:00.000Z");
const EXPIRED_SIGNAL_AT = new Date(NOW - 11 * 60 * 1_000).toISOString();
const FRESH_SIGNAL_AT = new Date(NOW - 5 * 60 * 1_000).toISOString();

function signalRow(sourceSignalId, signalAt, bodyOverrides = {}) {
  return {
    source_signal_id: sourceSignalId,
    body: { sourceSignalId, signalAt, ...bodyOverrides },
    body_hash: `hash-${sourceSignalId}`,
    status: "pending",
  };
}

function cleanupTestPool(rows, { intents = [], positionSignalIds = [] } = {}) {
  const state = {
    rows,
    intents,
    positionSignalIds: new Set(positionSignalIds),
    events: [],
    transactionStatements: [],
    queries: [],
  };

  const client = {
    async query(sql, values = []) {
      state.queries.push({ sql, values });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
        state.transactionStatements.push(sql);
        return { rows: [], rowCount: 0 };
      }
      if (/FROM vst_signals\s+WHERE status = 'pending'/.test(sql)) {
        const pending = state.rows.filter((row) => row.status === "pending");
        return { rows: pending, rowCount: pending.length };
      }
      if (/FROM vst_order_intents/.test(sql)) {
        const ids = new Set(values[0]);
        const found = state.intents
          .filter((intent) => ids.has(intent.sourceSignalId))
          .map((intent) => ({ source_signal_id: intent.sourceSignalId }));
        return { rows: found, rowCount: found.length };
      }
      if (/FROM vst_positions/.test(sql)) {
        const ids = new Set(values[0]);
        const found = [...state.positionSignalIds]
          .filter((sourceSignalId) => ids.has(sourceSignalId))
          .map((source_signal_id) => ({ source_signal_id }));
        return { rows: found, rowCount: found.length };
      }
      if (/UPDATE vst_signals/.test(sql)) {
        const [id, bodyJson, bodyHash, reason] = values;
        const row = state.rows.find((candidate) => candidate.source_signal_id === id);
        const matchesBody = row &&
          JSON.stringify(row.body) === JSON.stringify(JSON.parse(bodyJson));
        if (!row || row.status !== "pending" || !matchesBody || row.body_hash !== bodyHash) {
          return { rows: [], rowCount: 0 };
        }
        row.status = "rejected";
        row.reason = reason;
        return { rows: [{ source_signal_id: id }], rowCount: 1 };
      }
      if (/INSERT INTO vst_events/.test(sql)) {
        const kind = sql.includes("'vst_signal_rejected'")
          ? "vst_signal_rejected" : "vst_signal_status_changed";
        state.events.push({
          sourceSignalId: values[0],
          kind,
          detail: JSON.parse(values[1]),
        });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected test query: ${sql}`);
    },
    release() {},
  };
  return {
    state,
    pool: {
      async query() {
        throw new Error("Cleanup must run its queries inside a transaction");
      },
      async connect() { return client; },
    },
  };
}

test("retires only old pending signals without any intent or position, once", async () => {
  const rows = [
    signalRow("expired-unstarted", EXPIRED_SIGNAL_AT),
    signalRow("fresh-unstarted", FRESH_SIGNAL_AT),
    signalRow("prepared-intent", EXPIRED_SIGNAL_AT),
    signalRow("failed-intent", EXPIRED_SIGNAL_AT),
    signalRow("has-position", EXPIRED_SIGNAL_AT),
    signalRow("malformed-timestamp", "not a timestamp"),
    signalRow("invalid-calendar-date", "2026-02-30T00:00:00.000Z"),
  ];
  const { pool, state } = cleanupTestPool(rows, {
    intents: [
      { sourceSignalId: "prepared-intent", state: "prepared" },
      { sourceSignalId: "failed-intent", state: "failed" },
    ],
    positionSignalIds: ["has-position"],
  });
  const store = createVstStore(pool);

  assert.equal(await store.retireExpiredUnstartedSignals({
    nowMs: NOW,
    maxAgeMs: 10 * 60 * 1_000,
  }), 1);
  assert.equal(rows[0].status, "rejected");
  assert.equal(rows[0].reason, "signal_expired_before_entry_reservation");
  for (const row of rows.slice(1)) assert.equal(row.status, "pending", row.source_signal_id);

  const rejections = state.events.filter((event) =>
    event.kind === "vst_signal_rejected" &&
    event.detail.reason === "signal_expired_before_entry_reservation");
  assert.deepEqual(rejections, [{
    sourceSignalId: "expired-unstarted",
    kind: "vst_signal_rejected",
    detail: { reason: "signal_expired_before_entry_reservation" },
  }]);
  assert.equal(state.events.filter((event) =>
    event.kind === "vst_signal_status_changed" &&
    event.sourceSignalId === "expired-unstarted").length, 1);

  assert.equal(await store.retireExpiredUnstartedSignals({ nowMs: NOW }), 0);
  assert.equal(state.events.filter((event) =>
    event.kind === "vst_signal_rejected").length, 1);
  assert.deepEqual(state.transactionStatements, ["BEGIN", "COMMIT", "BEGIN", "COMMIT"]);

  const candidateScan = state.queries.find(({ sql }) =>
    /FROM vst_signals\s+WHERE status = 'pending'/.test(sql));
  assert.match(candidateScan.sql, /FOR UPDATE SKIP LOCKED/);
  const casUpdate = state.queries.find(({ sql }) => /UPDATE vst_signals/.test(sql));
  assert.match(casUpdate.sql, /status = 'pending'/);
  assert.match(casUpdate.sql, /body = \$2::jsonb AND body_hash = \$3/);
  assert.equal(casUpdate.values[0], "expired-unstarted");
});

test("requires a positive max age and never allows cleanup sooner than ten minutes", async () => {
  const row = signalRow("exactly-ten-minutes-old", new Date(NOW - 10 * 60 * 1_000).toISOString());
  const { pool } = cleanupTestPool([row]);
  const store = createVstStore(pool);

  assert.equal(await store.retireExpiredUnstartedSignals({ nowMs: NOW, maxAgeMs: 1 }), 0);
  assert.equal(row.status, "pending");
  await assert.rejects(
    store.retireExpiredUnstartedSignals({ nowMs: NOW, maxAgeMs: 0 }),
    /maxAgeMs must be a positive finite number/,
  );
});