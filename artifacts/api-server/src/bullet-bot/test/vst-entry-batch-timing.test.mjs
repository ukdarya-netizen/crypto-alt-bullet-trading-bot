import assert from "node:assert/strict";
import test from "node:test";
import { coordinateVstEntryBatch } from "../vst-entry-batch/coordinator.mjs";

test("queue timing includes time before preparation but excludes execution", async () => {
  let elapsed = 0;
  let wall = 100_000;
  const timings = [];
  await coordinateVstEntryBatch({
    candidates: [{ sourceSignalId: "signal-1", receivedAt: new Date(40_000) }],
    now: () => elapsed,
    wallClock: () => wall,
    prepare: async () => { elapsed += 1_000; wall += 1_000; return {}; },
    execute: async () => { elapsed += 2_000; wall += 2_000; return { kind: "prepared" }; },
    onTiming: (timing) => { timings.push(timing); },
  });
  assert.equal(timings[0].queueWaitMs, 61_000);
  assert.equal(timings[0].batchWaitMs, 1_000);
  assert.equal(timings[0].executeMs, 2_000);
});

test("missing, invalid, and future receipt times stay unknown in telemetry", async () => {
  for (const receivedAt of [undefined, "", "invalid", 0, 200_000]) {
    let timing;
    await coordinateVstEntryBatch({
      candidates: [{ sourceSignalId: "signal-1", receivedAt }],
      now: () => 0,
      wallClock: () => 100_000,
      prepare: async () => ({}),
      execute: async () => ({ kind: "prepared" }),
      onTiming: (event) => { timing = event; },
    });
    assert.equal(timing.queueWaitMs, null);
  }
});

test("preparation and deferred telemetry callbacks are failure-isolated", async () => {
  const calls = [];
  let headTiming;
  let executions = 0;
  const result = await coordinateVstEntryBatch({
    candidates: [
      { sourceSignalId: "signal-1" },
      { sourceSignalId: "signal-2" },
    ],
    maxEntries: 2,
    now: () => 0,
    wallClock: () => 100_000,
    prepare: async (candidate) => candidate.sourceSignalId,
    execute: async () => {
      executions += 1;
      return {
        kind: "waiting",
        reason: "source_exit_queue_unavailable",
        batchStop: true,
      };
    },
    onPreparationStart: async (event) => {
      calls.push(["start", event.sourceSignalId]);
      throw new Error("telemetry unavailable");
    },
    onPreparationComplete: (event) => {
      calls.push(["prepared", event.sourceSignalId]);
      return Promise.reject(new Error("telemetry unavailable"));
    },
    onTiming: (timing) => {
      headTiming = timing;
      throw new Error("telemetry unavailable");
    },
    onDeferred: (event) => {
      calls.push(["deferred", event.sourceSignalId, event.deferReason]);
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executions, 1);
  assert.equal(result.deferred, 1);
  assert.equal(headTiming.deferReason, "source_exit_queue_unavailable");
  assert.deepEqual(calls.filter(([kind]) => kind === "deferred"), [
    ["deferred", "signal-2", "source_exit_queue_unavailable"],
  ]);
});

test("unrecognized execution reasons are replaced with a safe defer code", async () => {
  let deferred;
  await coordinateVstEntryBatch({
    candidates: [{ sourceSignalId: "signal-1" }, { sourceSignalId: "signal-2" }],
    maxEntries: 2,
    now: () => 0,
    prepare: async () => ({}),
    execute: async () => ({
      kind: "unknown",
      reason: "raw upstream secret token",
      batchStop: true,
    }),
    onTiming: () => {},
    onDeferred: (event) => { deferred = event; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deferred.deferReason, "entry_attempt_stopped");
});