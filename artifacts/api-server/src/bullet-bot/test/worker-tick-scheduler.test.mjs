import assert from "node:assert/strict";
import { test } from "node:test";
import { createIndependentWorkerTickScheduler } from "../worker-tick-scheduler.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("shutdown stops scheduling and drains both in-flight lanes without starting another tick", async () => {
  const timers = [];
  const vst = deferred();
  const paper = deferred();
  let vstCalls = 0;
  let paperCalls = 0;
  const stop = createIndependentWorkerTickScheduler({
    runVst: async () => { vstCalls += 1; await vst.promise; },
    runPaper: async () => { paperCalls += 1; await paper.promise; },
    setIntervalFn: callback => { timers.push(callback); return { unref() {} }; },
    clearIntervalFn() {},
  });
  const running = timers.map(callback => callback());
  let drained = false;
  const pending = stop.drain().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  assert.equal(stop.wakeVst(), false);
  await Promise.all(timers.map(callback => callback()));
  assert.equal(vstCalls, 1);
  assert.equal(paperCalls, 1);
  vst.resolve();
  await Promise.resolve();
  assert.equal(drained, false);
  paper.resolve();
  await Promise.all([...running, pending]);
  assert.equal(drained, true);
  await stop.drain();
});

test("VST wakes coalesce and a busy wake launches exactly one follow-up after the active tick", async () => {
  const intervals = [];
  const gates = [];
  const active = { count: 0, max: 0 };
  let calls = 0;
  const stop = createIndependentWorkerTickScheduler({
    async runVst() {
      calls += 1;
      active.count += 1;
      active.max = Math.max(active.max, active.count);
      const gate = deferred();
      gates.push(gate);
      try { await gate.promise; } finally { active.count -= 1; }
    },
    setIntervalFn(callback) {
      const timer = { callback };
      intervals.push(timer);
      return timer;
    },
    clearIntervalFn() {},
  });

  assert.equal(stop.wakeVst(), true);
  assert.equal(stop.wakeVst(), true);
  assert.equal(stop.hasPendingVstWake(), true);
  await Promise.resolve();
  assert.equal(stop.hasPendingVstWake(), false);
  assert.equal(calls, 1);

  // Multiple new durable enqueues during the same tick retain one pending
  // wake rather than creating parallel VST work.
  stop.wakeVst();
  stop.wakeVst();
  assert.equal(stop.hasPendingVstWake(), true);
  gates[0].resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 2);
  assert.equal(stop.hasPendingVstWake(), false);
  assert.equal(active.max, 1);
  gates[1].resolve();
  await Promise.resolve();
  stop();
  assert.equal(stop.hasPendingVstWake(), false);
});

test("a VST wake remains pending through a periodic busy tick and stop makes it inert", async () => {
  const intervals = [];
  const gate = deferred();
  let calls = 0;
  const stop = createIndependentWorkerTickScheduler({
    async runVst() {
      calls += 1;
      if (calls === 1) await gate.promise;
    },
    setIntervalFn(callback) {
      const timer = { callback };
      intervals.push(timer);
      return timer;
    },
    clearIntervalFn() {},
  });

  const firstTick = intervals[0].callback();
  await Promise.resolve();
  stop.wakeVst();
  await intervals[0].callback();
  assert.equal(calls, 1);
  gate.resolve();
  await firstTick;
  await Promise.resolve();
  assert.equal(calls, 2);
  stop();
  assert.equal(stop.wakeVst(), false);
  await intervals[0].callback();
  assert.equal(calls, 2);
});

test("new entries wake ordinary work without starving an active entry; a take/cancel upgrades the wake", async () => {
  const intervals = [];
  const gate = deferred();
  let calls = 0;
  const stop = createIndependentWorkerTickScheduler({
    async runVst() { if (++calls === 1) await gate.promise; },
    setIntervalFn(callback) { intervals.push(callback); return {}; },
    clearIntervalFn() {},
  });
  const first = intervals[0]();
  await Promise.resolve();
  stop.wakeVst({ urgent: false });
  assert.equal(stop.hasPendingVstWake(), true);
  assert.equal(stop.hasPendingVstWake({ urgentOnly: true }), false);
  stop.wakeVst();
  assert.equal(stop.hasPendingVstWake({ urgentOnly: true }), true);
  gate.resolve();
  await first;
  assert.equal(calls, 2);
  assert.equal(stop.hasPendingVstWake(), false);
  stop();
});