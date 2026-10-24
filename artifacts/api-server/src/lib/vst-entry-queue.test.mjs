import assert from "node:assert/strict";
import test from "node:test";
import { readVstEntryQueue } from "./vst-entry-queue.mjs";

function queueRow(index, overrides = {}) {
  return {
    source_signal_id: `signal-${index}`,
    symbol: "BTCUSDT",
    status: "pending",
    received_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    total: "1",
    telemetry_event: null,
    telemetry_prepared: null,
    defer_reason: null,
    telemetry_created_at: null,
    timing_queue_wait_ms: null,
    prepare_ms: null,
    execute_ms: null,
    has_timing_event: false,
    intent_phase: null,
    intent_state: null,
    intent_updated_at: null,
    ...overrides,
  };
}

test("queue read is database-only, bounded to 100 rows, and reports an accurate total", async () => {
  const rows = Array.from({ length: 100 }, (_, index) =>
    queueRow(index + 1, { total: "104" }));
  let query;
  const queue = await readVstEntryQueue({
    async query(sql) {
      query = sql;
      return { rows };
    },
  }, { now: () => Date.parse("2026-01-01T00:01:00.000Z") });

  assert.equal(queue.total, 104);
  assert.equal(queue.hasMore, true);
  assert.equal(queue.entries.length, 100);
  assert.equal(queue.entries[0].queueWaitMs, 60_000);
  assert.match(query, /FROM vst_signals/);
  assert.match(query, /NOT EXISTS\s*\(\s*SELECT 1 FROM vst_positions/);
  assert.match(query, /COUNT\(\*\) OVER\(\)/);
  assert.doesNotMatch(query, /\b(INSERT|UPDATE|DELETE|broker|exchange)\b/i);
});

test("queue projection uses confirmed intents and allowlisted values only", async () => {
  const secretish = queueRow("private", {
    symbol: "BTCUSDT",
    status: "opening",
    received_at: null,
    total: "1",
    telemetry_event: "timing",
    telemetry_prepared: true,
    defer_reason: "upstream token: secret",
    signal_reason: "upstream error token: secret",
    telemetry_created_at: "2026-01-01T00:00:02Z",
    timing_queue_wait_ms: null,
    prepare_ms: "25",
    execute_ms: "40",
    has_timing_event: true,
    intent_phase: "market-entry",
    intent_state: "submitted",
    intent_updated_at: "2026-01-01T00:00:03Z",
  });
  const result = await readVstEntryQueue({
    async query() { return { rows: [secretish] }; },
  }, { now: () => Date.parse("2026-01-01T00:01:00.000Z") });
  assert.deepEqual(result.entries[0], {
    sourceSignalId: "signal-private",
    symbol: "BTCUSDT",
    status: "opening",
    receivedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    queueWaitMs: null,
    prepareMs: 25,
    executeMs: 40,
    stage: "market-entry:submitted",
    stageConfirmedAt: "2026-01-01T00:00:03.000Z",
    deferReason: null,
  });
  assert.doesNotMatch(JSON.stringify(result), /token|secret/);
});

test("unknown receipt timestamps remain null and terminal/no-position states are query-filtered", async () => {
  let sql = "";
  const result = await readVstEntryQueue({
    async query(statement) {
      sql = statement;
      return { rows: [queueRow(1, {
        received_at: "not a timestamp",
        telemetry_event: "deferred",
        telemetry_created_at: "2026-01-01T00:00:01Z",
        defer_reason: "batch_execution_budget_exceeded",
        total: "1",
      })] };
    },
  }, { now: () => Date.parse("2026-01-01T00:01:00.000Z") });
  assert.equal(result.entries[0].receivedAt, null);
  assert.equal(result.entries[0].queueWaitMs, null);
  assert.equal(result.entries[0].deferReason, "batch_execution_budget_exceeded");
  assert.match(sql, /s\.status IN \('pending', 'planning', 'opening'\)/);
  assert.equal(result.hasMore, false);
});

test("queue wait is always current receipt age, never historical timing", async () => {
  const result = await readVstEntryQueue({
    async query() {
      return { rows: [queueRow(1, {
        received_at: "2026-01-01T00:00:00Z",
        total: "1",
        has_timing_event: true,
        timing_queue_wait_ms: "5",
      })] };
    },
  }, { now: () => Date.parse("2026-01-01T00:02:00Z") });
  assert.equal(result.entries[0].queueWaitMs, 120_000);

  for (const received_at of [
    null,
    "1970-01-01T00:00:00.000Z",
    "2026-01-01T00:03:00Z",
  ]) {
    const unknown = await readVstEntryQueue({
      async query() {
        return { rows: [queueRow(1, {
          received_at,
          total: "1",
          has_timing_event: true,
          timing_queue_wait_ms: "9876",
        })] };
      },
    }, { now: () => Date.parse("2026-01-01T00:02:00Z") });
    assert.equal(unknown.entries[0].queueWaitMs, null);
  }
});

test("latest failed preparation replaces stale prepared stage and exposes only safe row reasons", async () => {
  let sql = "";
  const result = await readVstEntryQueue({
    async query(statement) {
      sql = statement;
      return { rows: [queueRow(1, {
        status: "planning",
        total: "1",
        telemetry_event: "prepared",
        telemetry_prepared: false,
        telemetry_created_at: "2026-01-01T00:00:05Z",
        prepare_ms: "15",
        signal_reason: "source_exit_queue_unavailable",
      })] };
    },
  }, { now: () => Date.parse("2026-01-01T00:01:00Z") });
  assert.equal(result.entries[0].stage, "preparation_failed");
  assert.equal(result.entries[0].prepareMs, 15);
  assert.equal(result.entries[0].deferReason, "source_exit_queue_unavailable");
  assert.match(sql, /telemetry\.detail->>'prepareMs' AS prepare_ms/);
  assert.doesNotMatch(sql, /timing\.detail->>'prepareMs'/);
});

test("deferred failed preparation remains failed instead of being reported as prepared", async () => {
  const result = await readVstEntryQueue({
    async query() {
      return { rows: [queueRow(1, {
        total: "1",
        telemetry_event: "deferred",
        telemetry_prepared: false,
        telemetry_created_at: "2026-01-01T00:00:05Z",
        prepare_ms: "19",
        defer_reason: "source_exit_priority_before_entry_batch_phase",
      })] };
    },
  }, { now: () => Date.parse("2026-01-01T00:01:00Z") });
  assert.equal(result.entries[0].stage, "preparation_failed");
  assert.equal(result.entries[0].prepareMs, 19);
  assert.equal(result.entries[0].deferReason, "source_exit_priority_before_entry_batch_phase");
});

test("head execution telemetry exposes only its allowlisted waiting reason", async () => {
  const result = await readVstEntryQueue({
    async query() {
      return { rows: [queueRow(1, {
        total: "1",
        status: "planning",
        telemetry_event: "timing",
        telemetry_prepared: true,
        telemetry_created_at: "2026-01-01T00:00:05Z",
        prepare_ms: "19",
        defer_reason: "source_exit_priority_before_entry_batch_phase",
      })] };
    },
  }, { now: () => Date.parse("2026-01-01T00:01:00Z") });
  assert.equal(result.entries[0].deferReason, "source_exit_priority_before_entry_batch_phase");
});