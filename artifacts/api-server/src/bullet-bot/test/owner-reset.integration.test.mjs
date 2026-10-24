import test from "node:test";
import assert from "node:assert/strict";
import { createOwnerResetStore } from "../owner-reset.mjs";

test("reset is atomic, idempotent, waits for both modes, fences old signals and preserves ledger history", {
  skip: process.env.RUN_SOURCE_COMMAND_DB_TESTS !== "1",
}, async () => {
  const { pool } = await import("@workspace/db");
  const client = await pool.connect();
  const other = await pool.connect();
  const db = { query: (...args) => client.query(...args),
    connect: async () => ({ query: (...args) => client.query(...args), release() {} }) };
  const leaderLocks = [[1_200_000_010, 1], [1_200_000_011, 1]];
  const now = Date.parse("2026-10-24T12:00:00.000Z");
  const store = createOwnerResetStore(db, { clock: () => now, leaderLocks });
  try {
    // Session-private TEMP tables shadow real ledgers. No user trading rows
    // or production data are edited by this integration test.
    await client.query(`CREATE TEMP TABLE vst_events (
      id bigserial, kind text, detail jsonb, telegram_sent_at timestamptz)`);
    for (const prefix of ["btb", "vst"]) {
      await client.query(`CREATE TEMP TABLE ${prefix}_signals (
        source_signal_id text PRIMARY KEY, body jsonb, status text, received_at timestamptz DEFAULT NOW())`);
      await client.query(`CREATE TEMP TABLE ${prefix}_positions (
        source_signal_id text PRIMARY KEY, status text, snapshot jsonb)`);
    }
    await client.query(`INSERT INTO btb_signals VALUES ('s1',
      '{"symbol":"ETHUSDT","signalAt":"2026-10-24T11:59:00Z"}', 'pending',NOW())`);
    await client.query(`INSERT INTO vst_positions VALUES ('s1','open','{"symbol":"ETHUSDT"}')`);
    await other.query("SELECT pg_advisory_lock($1,$2)", leaderLocks[0]);
    assert.deepEqual(await store.requestReset({ resetId: "reset-test", vstAvailable: true }), { kind: "busy" });
    assert.equal((await client.query("SELECT count(*) AS n FROM vst_events")).rows[0].n, "0");
    await other.query("SELECT pg_advisory_unlock($1,$2)", leaderLocks[0]);
    assert.equal((await store.requestReset({ resetId: "no-vst", vstAvailable: false })).reason, "vst_worker_required");
    const result = await store.requestReset({ resetId: "reset-test", vstAvailable: true });
    assert.equal(result.kind, "received");
    assert.equal(result.reset.positionCloseRequests, 1);
    assert.equal(result.reset.queuedEntryCancellations, 1);
    assert.equal(result.reset.pending, 2);
    assert.equal(result.reset.queuedCommands, 1);
    assert.equal((await store.requestReset({ resetId: "reset-test", vstAvailable: true })).kind, "duplicate");
    assert.equal((await client.query("SELECT count(*) AS n FROM vst_events")).rows[0].n, "2");
    assert.equal(await store.resetBlocksEntry("new", "paper", "2026-10-24T12:01:00Z"), false);
    await client.query(`INSERT INTO btb_signals VALUES ('new',
      '{"symbol":"SOLUSDT","signalAt":"2026-10-24T12:01:00Z"}','pending',NOW())`);
    assert.equal(await store.resetBlocksEntry("new", "paper"), "maintenance");
    assert.equal(await store.resetBlocksEntry("s1", "paper"), true);
    assert.equal((await client.query("SELECT status FROM vst_positions")).rows[0].status, "open");
    assert.equal((await client.query("SELECT status FROM btb_signals WHERE source_signal_id='s1'")).rows[0].status, "pending");
    assert.equal((await store.requestReset({ resetId: "another", vstAvailable: true })).reason, "reset_already_active");
    // Only simulate executor receipts here. Native fill/protection verification
    // is tested separately by the actual close-lane integration tests.
    await client.query(`UPDATE vst_events SET detail = jsonb_set(detail,'{targets,paper,status}','"executed"')
      WHERE kind='source_command_received'`);
    assert.equal((await store.resetStatus("reset-test")).phase, "closing");
    await client.query(`UPDATE vst_events SET detail = jsonb_set(detail,'{targets,vst,status}','"rejected"')
      WHERE kind='source_command_received'`);
    assert.equal((await store.resetStatus("reset-test")).phase, "needs_review");
    assert.equal(await store.resetBlocksEntry("new", "paper"), "maintenance");
    await client.query(`UPDATE vst_events SET detail = jsonb_set(detail,'{targets,vst,status}','"already_closed"')
      WHERE kind='source_command_received'`);
    assert.equal((await store.resetStatus("reset-test")).phase, "completed");
    assert.equal(await store.resetBlocksEntry("new", "paper"), false);
    assert.equal(await store.resetBlocksEntry("s1", "paper"), true);
  } finally {
    await other.query("SELECT pg_advisory_unlock_all()");
    // TEMP tables must not survive in a pooled application connection.
    other.release(true);
    client.release(true);
    await pool.end();
  }
});
