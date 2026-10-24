import assert from "node:assert/strict";
import test from "node:test";
import { createVstStore } from "../vst-store.mjs";

function makeStore() {
  const calls = [];
  const store = createVstStore({
    async query(sql, params) {
      calls.push({ sql, params });
      return { rowCount: 1, rows: [] };
    },
    async connect() {
      throw new Error("unexpected database transaction");
    },
  });
  return { store, calls };
}

test("queue telemetry upserts bounded slots without writing events or notifications", async () => {
  const { store, calls } = makeStore();
  await store.recordEntryQueueTelemetry("signal-1", { event: "preparing" });
  await store.recordEntryQueueTelemetry("signal-1", {
    event: "timing",
    prepareMs: 12,
    executeMs: 20,
    queueWaitMs: null,
    prepared: false,
    deferReason: "source_exit_priority_before_entry_batch_phase",
  });
  await store.recordEntryQueueTelemetry("signal-2", {
    event: "deferred",
    prepareMs: 17,
    deferReason: "source_exit_priority_before_entry_batch_phase",
    prepared: false,
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ sql }) =>
    sql.includes("INSERT INTO vst_entry_queue_snapshots") &&
    sql.includes("ON CONFLICT (source_signal_id, slot) DO UPDATE")));
  assert.deepEqual(JSON.parse(calls[1].params[1]), {
    event: "timing",
    prepareMs: 12,
    executeMs: 20,
    queueWaitMs: null,
    prepared: false,
    deferReason: "source_exit_priority_before_entry_batch_phase",
  });
  assert.deepEqual(JSON.parse(calls[2].params[1]), {
    event: "deferred",
    prepareMs: 17,
    deferReason: "source_exit_priority_before_entry_batch_phase",
    prepared: false,
  });
  assert.ok(calls.every(({ sql }) =>
    !/\b(DELETE|vst_events|telegram_sent_at)\b/i.test(sql)));
});

test("untrusted reasons, extra fields, and invalid durations are rejected before persistence", async () => {
  const { store, calls } = makeStore();
  await assert.rejects(store.recordEntryQueueTelemetry("signal-1", {
    event: "deferred",
    deferReason: "upstream response contained secret token",
  }), /Invalid VST entry queue telemetry fields/);
  await assert.rejects(store.recordEntryQueueTelemetry("signal-1", {
    event: "timing",
    prepareMs: -1,
    executeMs: 0,
    queueWaitMs: null,
    prepared: true,
  }), /Invalid VST entry queue prepareMs/);
  await assert.rejects(store.recordEntryQueueTelemetry("signal-1", {
    event: "timing",
    prepareMs: 1,
    executeMs: 1,
    queueWaitMs: null,
    prepared: false,
    deferReason: "unsafe raw token",
  }), /Invalid VST entry queue telemetry deferReason/);
  await assert.rejects(store.recordEntryQueueTelemetry("signal-1", {
    event: "prepared",
    prepareMs: 1,
    prepared: true,
    errorMessage: "sensitive",
  }), /Invalid VST entry queue telemetry fields/);
  assert.equal(calls.length, 0);
});