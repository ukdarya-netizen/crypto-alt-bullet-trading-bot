import test from "node:test";
import assert from "node:assert/strict";
import { coordinateVstEntryBatch } from "../vst-entry-batch/coordinator.mjs";

function candidates(count) {
  return Array.from({ length: count }, (_, index) => ({
    sourceSignalId: `signal-${index}`,
    symbol: `COIN${index}USDT`,
  }));
}

test("entry batches handle bursts of 5, 10, and 26 with parallel reads and serialized phases", async () => {
  for (const burstSize of [5, 10, 26]) {
    const queue = candidates(burstSize);
    const processed = [];
    let activeReads = 0;
    let maxConcurrentReads = 0;
    let activeWrites = 0;
    let maxConcurrentWrites = 0;
    while (queue.length) {
      const batch = queue.splice(0, 3);
      await coordinateVstEntryBatch({
        candidates: batch,
        maxEntries: 3,
        prepare: async (candidate) => {
          activeReads += 1;
          maxConcurrentReads = Math.max(maxConcurrentReads, activeReads);
          await new Promise((resolve) => setImmediate(resolve));
          activeReads -= 1;
          return { symbol: candidate.symbol };
        },
        execute: async (candidate, hint) => {
          activeWrites += 1;
          maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
          assert.equal(hint.symbol, candidate.symbol);
          processed.push(candidate.sourceSignalId);
          await new Promise((resolve) => setImmediate(resolve));
          activeWrites -= 1;
          return { kind: "prepared" };
        },
      });
    }
    assert.equal(processed.length, burstSize);
    assert.equal(new Set(processed).size, burstSize);
    assert.ok(maxConcurrentReads > 1, `burst ${burstSize} read preparation was not parallel`);
    assert.equal(maxConcurrentWrites, 1);
  }
});

test("default coordinator limit remains one and time budget yields before next phase", async () => {
  let currentTime = 0;
  const phases = [];
  const result = await coordinateVstEntryBatch({
    candidates: candidates(3),
    maxEntries: 3,
    prepare: async (candidate) => candidate,
    execute: async (candidate) => {
      phases.push(candidate.sourceSignalId);
      currentTime += 60;
      return { kind: "prepared" };
    },
    now: () => currentTime,
    budgetMs: 100,
  });
  assert.deepEqual(phases, ["signal-0", "signal-1"]);
  assert.equal(result.processed, 2);
  assert.equal(result.deferred, 1);

  const defaultResult = await coordinateVstEntryBatch({
    candidates: candidates(3),
    prepare: async (candidate) => candidate,
    execute: async () => ({ kind: "prepared" }),
  });
  assert.equal(defaultResult.processed, 1);
});

test("slow parallel preparations still allow the queue head one execution attempt", async () => {
  let currentTime = 0;
  const executed = [];
  const result = await coordinateVstEntryBatch({
    candidates: candidates(3),
    maxEntries: 3,
    prepare: async (candidate) => {
      currentTime += 20_000;
      return candidate;
    },
    execute: async (candidate) => {
      executed.push(candidate.sourceSignalId);
      currentTime += 100;
      return { kind: "prepared" };
    },
    now: () => currentTime,
    budgetMs: 100,
  });
  assert.deepEqual(executed, ["signal-0"]);
  assert.equal(result.processed, 1);
  assert.equal(result.deferred, 2);
});

test("a failed fresh-safety check or queued source exit stops later writes", async () => {
  for (const barrier of ["unsafe-account", "source-exit", "expired"]) {
    const writes = [];
    const result = await coordinateVstEntryBatch({
      candidates: candidates(3),
      maxEntries: 3,
      prepare: async (candidate) => candidate,
      execute: async (candidate) => {
        if (candidate.sourceSignalId === "signal-1") {
          return { kind: "waiting", reason: barrier, batchStop: true };
        }
        writes.push(candidate.sourceSignalId);
        return { kind: "prepared" };
      },
    });
    assert.deepEqual(writes, ["signal-0"], barrier);
    assert.equal(result.processed, 2, barrier);
  }
});

test("prepared reservations remain idempotent when a coordinator is recreated", async () => {
  const durableIntentIds = new Set();
  let writes = 0;
  const execute = async (candidate) => {
    if (durableIntentIds.has(candidate.sourceSignalId)) {
      return { kind: "existing" };
    }
    durableIntentIds.add(candidate.sourceSignalId);
    writes += 1;
    return { kind: "prepared" };
  };
  const row = [candidates(1)[0]];
  await coordinateVstEntryBatch({
    candidates: row,
    prepare: async (candidate) => candidate,
    execute,
  });
  await coordinateVstEntryBatch({
    candidates: row,
    prepare: async (candidate) => candidate,
    execute,
  });
  assert.equal(writes, 1);
});