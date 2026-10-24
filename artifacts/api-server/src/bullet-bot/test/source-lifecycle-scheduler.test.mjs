import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSourceFreshnessWatchdog,
  createSourceLifecycleScheduler,
} from "../source-lifecycle-scheduler.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
};

function snapshot(now, sourceSignalId = "source-1") {
  return {
    asOf: new Date(now).toISOString(),
    positions: new Map([[sourceSignalId, {
      sourceSignalId,
      symbol: "BTCUSDT",
      sourceStatus: "reclassified",
    }]]),
  };
}

test("a hung PAPER apply does not hold up subsequent source polls or durable queues", async () => {
  let now = 1_800_000_000_000;
  let fetches = 0;
  let applyCalls = 0;
  const applyGate = deferred();
  const queuedPaper = [];
  const queuedVst = [];
  const scheduler = createSourceLifecycleScheduler({
    now: () => now,
    async fetchSnapshot() {
      fetches += 1;
      return snapshot(now, `source-${fetches}`);
    },
    async queuePaperExits(value) { queuedPaper.push(value); return { queued: [], refreshed: [], rejected: [] }; },
    async queueVstExits(value) { queuedVst.push(value); return { queued: [], refreshed: [], rejected: [] }; },
    async applyPaperSnapshot() {
      applyCalls += 1;
      await applyGate.promise;
    },
  });

  await scheduler.pollNow();
  await flush();
  now += 15_000;
  await scheduler.pollNow();
  await flush();
  now += 15_000;
  await scheduler.pollNow();
  await flush();

  assert.equal(fetches, 3);
  assert.equal(queuedPaper.length, 3);
  assert.equal(queuedVst.length, 3);
  assert.equal(applyCalls, 1, "PAPER source work remains single-flight while hung");
  applyGate.resolve();
  await flush();
  scheduler.stop();
});

test("PAPER lock unavailability retries soon without blocking fetching", async () => {
  let now = 1_800_000_000_000;
  const retryTimers = [];
  let applyCalls = 0;
  let fetches = 0;
  const scheduler = createSourceLifecycleScheduler({
    now: () => now,
    fetchSnapshot: async () => { fetches += 1; return snapshot(now); },
    queuePaperExits: async () => ({ queued: [], refreshed: [], rejected: [] }),
    applyPaperSnapshot: async () => {
      applyCalls += 1;
      return applyCalls === 1 ? null : [];
    },
    setTimeoutFn(callback, delay) {
      retryTimers.push({ callback, delay });
      return { unref() {} };
    },
    clearTimeoutFn() {},
    paperRetryMs: 250,
  });

  await scheduler.pollNow();
  await flush();
  assert.equal(retryTimers[0].delay, 250);
  now += 15_000;
  await scheduler.pollNow();
  assert.equal(fetches, 2, "the source fetch cadence continues while PAPER lock is busy");
  retryTimers[0].callback();
  await flush();
  assert.equal(applyCalls, 2);
  scheduler.stop();
});

test("PAPER persistence failures and hung audit/alert work do not gate VST persistence and wake", async () => {
  let now = 1_800_000_000_000;
  const paperGate = deferred();
  const auditGate = deferred();
  let vstQueued = 0;
  let wakeCalls = 0;
  const scheduler = createSourceLifecycleScheduler({
    now: () => now,
    fetchSnapshot: async () => snapshot(now),
    queuePaperExits: async () => { await paperGate.promise; throw new Error("paper store unavailable"); },
    queueVstExits: async () => {
      vstQueued += 1;
      return { queued: [{ sourceSignalId: "source-1" }], refreshed: [], rejected: [] };
    },
    auditSnapshot: async () => auditGate.promise,
    wakeVst: () => { wakeCalls += 1; },
    applyPaperSnapshot: async () => [],
  });
  await scheduler.pollNow();
  await flush();
  assert.equal(vstQueued, 1);
  assert.equal(wakeCalls, 1, "wake occurs after the VST durable queue returns a new request");
  paperGate.resolve();
  scheduler.stop();
  auditGate.resolve();
});

test("an errored PAPER queue write is retried/reported without gating VST queue delivery", async () => {
  let now = 1_800_000_000_000;
  let vstWrites = 0;
  let wakeCalls = 0;
  const errors = [];
  const scheduler = createSourceLifecycleScheduler({
    now: () => now,
    fetchSnapshot: async () => snapshot(now),
    queuePaperExits: async () => { throw Object.assign(new Error("database down"), { code: "db_down" }); },
    queueVstExits: async () => {
      vstWrites += 1;
      return { queued: [{ sourceSignalId: "source-1" }], refreshed: [], rejected: [] };
    },
    wakeVst: () => { wakeCalls += 1; },
    onError: ({ lane }) => errors.push(lane),
    maxEnqueueAttempts: 1,
  });
  await scheduler.pollNow();
  await flush();
  assert.equal(vstWrites, 1);
  assert.equal(wakeCalls, 1);
  assert.ok(errors.includes("paper_persist"));
  assert.ok(!errors.includes("vst_persist"));
  scheduler.stop();
});

test("poll failures retry on the next bounded interval and stale snapshots are never enqueued", async () => {
  let now = 1_800_000_000_000;
  let calls = 0;
  let queued = 0;
  const ends = [];
  const timers = [];
  const scheduler = createSourceLifecycleScheduler({
    now: () => now,
    async fetchSnapshot() {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      if (calls === 2) return snapshot(now - 61_000);
      return snapshot(now);
    },
    queuePaperExits: async () => { queued += 1; return { queued: [], refreshed: [], rejected: [] }; },
    onPollEnd: (result) => ends.push(result.kind),
    setIntervalFn(callback, delay) {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn() {},
  });
  scheduler.start();
  await flush();
  assert.deepEqual(ends, ["error"]);
  await timers[0].callback();
  await flush();
  assert.deepEqual(ends, ["error", "error"]);
  assert.equal(queued, 0, "failed and stale snapshots are not reused for exit decisions");
  now += 1_000;
  await timers[0].callback();
  await flush();
  assert.deepEqual(ends, ["error", "error", "ok"]);
  assert.equal(queued, 1);
  scheduler.stop();
});

test("provider Retry-After cooldown skips polls without accepting snapshots, then queues the full recovered lifecycle", async () => {
  let now = 1_800_000_000_000;
  let fetches = 0;
  let paperQueued;
  let vstQueued;
  let wakes = 0;
  const skips = [];
  const asOf = () => new Date(now).toISOString();
  const sourceRecord = (sourceSignalId, sourceStatus, closure = false) => ({
    sourceSignalId,
    signalAt: asOf(),
    botEnqueuedAt: null,
    symbol: "BTCUSDT",
    initialStopPrice: null,
    sourceStatus,
    sourceUpdatedAt: asOf(),
    sourceClosedAt: closure ? asOf() : null,
    sourceEntryPrice: null,
    sourceExitPrice: closure ? 100 : null,
    sourcePnlPercent: null,
    sourcePeakPrice: null,
    sourceStopLossPrice: null,
    sourceTrailingStopLevel: null,
    sourceLastMilestone: null,
    sourceCancelReason: sourceStatus === "reclassified" ? "withdrawn" : null,
  });
  const scheduler = createSourceLifecycleScheduler({
    now: () => now,
    async fetchSnapshot() {
      fetches += 1;
      if (fetches === 1) {
        throw Object.assign(new Error("provider busy"), { code: "request_failed", retryAfterMs: 90_000 });
      }
      return {
        asOf: asOf(),
        positions: new Map([
          ["profit-close", sourceRecord("profit-close", "profit", true)],
          ["withdrawn", sourceRecord("withdrawn", "reclassified")],
          ["still-open", sourceRecord("still-open", "active")],
        ]),
      };
    },
    async queuePaperExits(snapshot) {
      paperQueued = snapshot;
      return { queued: [], refreshed: [], rejected: [] };
    },
    async queueVstExits(snapshot) {
      vstQueued = snapshot;
      return { queued: [{ sourceSignalId: "profit-close" }], refreshed: [], rejected: [] };
    },
    wakeVst: () => { wakes += 1; },
    onPollSkip: (detail) => skips.push(detail),
  });

  assert.equal((await scheduler.pollNow()).kind, "error");
  assert.equal(paperQueued, undefined, "failed fetches never queue a partial or old snapshot");
  assert.equal(vstQueued, undefined);
  now += 15_000;
  assert.equal((await scheduler.pollNow()).kind, "provider_backoff");
  assert.deepEqual(skips.at(-1), { reason: "provider_backoff", remainingDelayMs: 75_000 });
  assert.equal(fetches, 1);
  now += 75_000;
  assert.equal((await scheduler.pollNow()).kind, "ok");
  await flush();
  for (const queued of [paperQueued, vstQueued]) {
    assert.ok(queued.positions instanceof Map);
    assert.deepEqual([...queued.positions.keys()].sort(), ["profit-close", "withdrawn"]);
  }
  assert.equal(wakes, 1);
  scheduler.stop();
});

test("stopping source lifecycle scheduling makes interval and poll entrypoints inert", async () => {
  let calls = 0;
  const timers = [];
  const scheduler = createSourceLifecycleScheduler({
    fetchSnapshot: async () => { calls += 1; return snapshot(Date.now()); },
    setIntervalFn(callback) {
      const timer = { callback };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn() {},
  });
  scheduler.start();
  await flush();
  const callsAtStop = calls;
  scheduler.stop();
  await timers[0].callback();
  assert.equal((await scheduler.pollNow()).kind, "stopped");
  assert.equal(calls, callsAtStop);
});

test("a source fetch completing after stop cannot dispatch its snapshot", async () => {
  const gate = deferred();
  let queued = 0;
  let ended = 0;
  const scheduler = createSourceLifecycleScheduler({
    fetchSnapshot: () => gate.promise,
    queuePaperExits: async () => { queued += 1; return { queued: [], refreshed: [], rejected: [] }; },
    onPollEnd: () => { ended += 1; },
  });
  scheduler.start();
  await Promise.resolve();
  scheduler.stop();
  gate.resolve(snapshot(Date.now()));
  await flush();
  assert.equal(queued, 0);
  assert.equal(ended, 0);
});

test("freshness watchdog requires sustained staleness, repeated failures, and stable admitted recovery", async () => {
  let now = 0;
  const sent = [];
  const states = [];
  let timer;
  const watchdog = createSourceFreshnessWatchdog({
    now: () => now,
    staleAfterMs: 60_000,
    checkIntervalMs: 5_000,
    sendAlert: async ({ kind }) => { sent.push(kind); },
    onStale: () => states.push("stale"),
    onRecovered: () => states.push("recovered"),
    setIntervalFn(callback) { timer = callback; return 1; },
    clearIntervalFn() {},
  });
  watchdog.start();
  now = 180_000;
  watchdog.failed();
  watchdog.failed();
  watchdog.failed();
  timer();
  await flush();
  timer();
  await flush();
  assert.deepEqual(sent, ["stale"]);
  assert.deepEqual(states, ["stale"]);
  now += 1_000;
  watchdog.healthy();
  await flush();
  assert.deepEqual(sent, ["stale"], "a single fresh snapshot cannot clear an incident");
  now += 30_000;
  watchdog.healthy();
  await flush();
  assert.deepEqual(sent, ["stale", "recovered"]);
  assert.deepEqual(states, ["stale", "recovered"]);
  watchdog.stop();
  timer();
  await flush();
  assert.deepEqual(sent, ["stale", "recovered"]);
});