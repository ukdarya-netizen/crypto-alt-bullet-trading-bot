import assert from "node:assert/strict";
import test from "node:test";
import { createVstStore } from "../vst-store.mjs";

test("close retry history uses a parameterized durable descending history including failed attempts", async () => {
  let captured;
  const store = createVstStore({
    async connect() { throw new Error("this read must not require a transaction"); },
    async query(sql, params) {
      captured = { sql, params };
      return { rows: [{
        source_signal_id: "s", phase: "p", state: "failed",
        request: { operation: "close_pre_runner_split" },
        outcome: { reason: "close_pre_runner_split_abandoned_confirmed_still_open" },
        updated_at: "2026-10-03T12:00:00Z",
      }] };
    },
  });
  const rows = await store.listPreRunnerCloseAttempts("s");
  assert.deepEqual(captured.params, ["s"]);
  assert.match(captured.sql, /ORDER BY created_at DESC, id DESC/);
  assert.equal(rows[0].state, "failed");
  assert.equal(rows[0].updatedAt, "2026-10-03T12:00:00Z");
});

test("reviewed guard evidence is persisted as complete JSON with a durable deduplication key", async () => {
  let captured;
  const store = createVstStore({
    async connect() { throw new Error("this event must use the existing leader serialization"); },
    async query(sql, params) { captured = { sql, params }; return { rows: [] }; },
  });
  const detail = { ref: "abc", symbol: "ETHUSDT", diagnostic: {
    proofEvidence: { checks: { identifierAliases: { actual: [], matched: false } } },
  } };
  await store.recordGuardEventOnce("s", "vst_position_management_diagnostic", detail);
  assert.deepEqual(JSON.parse(captured.params[2]), detail);
  assert.match(captured.sql, /NOT EXISTS/);
  assert.equal(captured.params[3], "abc");
  await assert.rejects(store.recordGuardEventOnce("s", "arbitrary", detail), /Invalid/);
});