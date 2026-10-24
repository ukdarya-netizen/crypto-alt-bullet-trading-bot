import assert from "node:assert/strict";
import test from "node:test";
import { createVstFillArchiveScheduler } from "../vst-fill-archive-scheduler.mjs";

const HOUR = 60 * 60 * 1_000;
const TAIL = 60_000;
const NOW = 1_800_000_000_000;

function makeWindow({ accountId = "account", currency = "USDT", startTs, endTs }) {
  return Object.freeze({
    environment: "vst",
    accountId,
    currency,
    coverage: Object.freeze({
      verified: true, startTs, endTs, currency,
    }),
    rawFills: Object.freeze([]),
    orders: Object.freeze([]),
    archivedAt: new Date(NOW).toISOString(),
  });
}

function makeStore(initialCursor = null) {
  let cursor = initialCursor;
  const saved = [];
  const invalidated = [];
  return {
    saved,
    invalidated,
    getFillArchiveCursor: async () => cursor,
    saveFillArchiveWindow: async (window) => {
      if (cursor !== null) assert.equal(window.coverage.startTs, cursor);
      saved.push(window);
      cursor = window.coverage.endTs;
    },
    invalidateFillArchiveWindows: async (input) => { invalidated.push(input); },
    cursor: () => cursor,
  };
}

test("bootstraps six days, bounds windows to an hour, and resumes from the durable cursor", async () => {
  const store = makeStore();
  const calls = [];
  const scheduler = createVstFillArchiveScheduler({
    broker: {
      captureFillArchiveWindow: async (input) => {
        calls.push(input);
        return makeWindow({ accountId: "account", ...input });
      },
    },
    store,
    accountId: "account",
    now: () => NOW,
    maxCallsPerCycle: 2,
  });

  const first = await scheduler.pollNow();
  assert.equal(first.calls, 2);
  assert.equal(calls[0].startTs, NOW - 6 * 24 * HOUR);
  assert.equal(calls[0].endTs - calls[0].startTs, HOUR);
  assert.equal(calls[1].startTs, calls[0].endTs);
  assert.equal(store.cursor(), calls[1].endTs);

  const resumedCalls = [];
  const resumed = createVstFillArchiveScheduler({
    broker: {
      captureFillArchiveWindow: async (input) => {
        resumedCalls.push(input);
        return makeWindow({ accountId: "account", ...input });
      },
    },
    store,
    accountId: "account",
    now: () => NOW,
    maxCallsPerCycle: 1,
  });
  await resumed.pollNow();
  assert.equal(resumedCalls[0].startTs, calls[1].endTs);
  assert.equal(resumedCalls[0].endTs - resumedCalls[0].startTs, HOUR);
});

test("cadence is slow when current and fast while catching up", async () => {
  const timers = [];
  const setTimeoutFn = (callback, delay) => {
    const handle = { callback, delay, unref() {} };
    timers.push(handle);
    return handle;
  };
  const clearTimeoutFn = () => {};
  const currentStore = makeStore(NOW - TAIL);
  const current = createVstFillArchiveScheduler({
    broker: { captureFillArchiveWindow: async () => assert.fail("already caught up") },
    store: currentStore,
    accountId: "account",
    now: () => NOW,
    setTimeoutFn,
    clearTimeoutFn,
  });
  current.start();
  await new Promise(setImmediate);
  assert.equal(timers.at(-1).delay, 60_000);
  current.stop();

  timers.length = 0;
  const catchupStore = makeStore(NOW - TAIL - HOUR - 10);
  const catchup = createVstFillArchiveScheduler({
    broker: { captureFillArchiveWindow: async (input) =>
      makeWindow({ accountId: "account", ...input }) },
    store: catchupStore,
    accountId: "account",
    now: () => NOW,
    setTimeoutFn,
    clearTimeoutFn,
    maxCallsPerCycle: 1,
  });
  catchup.start();
  await new Promise(setImmediate);
  assert.equal(timers.at(-1).delay, 15_000);
  assert.equal(catchupStore.cursor(), NOW - TAIL - 10);
  catchup.stop();
});

test("saturation is split oldest-first into an exact, contiguous partition", async () => {
  const start = NOW - TAIL - 100;
  const store = makeStore(start);
  const calls = [];
  const scheduler = createVstFillArchiveScheduler({
    broker: {
      captureFillArchiveWindow: async (input) => {
        calls.push(input);
        if (input.endTs - input.startTs > 25) {
          throw Object.assign(new Error("history saturated"), { code: "fill_history_saturated" });
        }
        return makeWindow({ accountId: "account", ...input });
      },
    },
    store,
    accountId: "account",
    now: () => NOW,
  });
  const result = await scheduler.pollNow();
  assert.equal(result.kind, "ok");
  assert.deepEqual(store.saved.map((window) => [
    window.coverage.startTs, window.coverage.endTs,
  ]), [
    [start, start + 25],
    [start + 25, start + 50],
    [start + 50, start + 75],
    [start + 75, start + 100],
  ]);
  assert.equal(store.cursor(), NOW - TAIL);
  assert.ok(calls.length <= 24);
});

test("a retention gap is reported and never skipped", async () => {
  const oldCursor = NOW - 7 * 24 * HOUR - 1;
  const store = makeStore(oldCursor);
  const errors = [];
  let captures = 0;
  const scheduler = createVstFillArchiveScheduler({
    broker: { captureFillArchiveWindow: async () => { captures += 1; } },
    store,
    accountId: "account",
    now: () => NOW,
    onError: (event) => errors.push(event),
  });
  const result = await scheduler.pollNow();
  assert.equal(result.kind, "error");
  assert.equal(captures, 0);
  assert.equal(store.cursor(), oldCursor);
  assert.equal(errors[0].code, "fill_archive_retention_gap");
});

test("capture failures retry boundedly, report, and leave the cursor unchanged", async () => {
  const start = NOW - TAIL - 50;
  const store = makeStore(start);
  const errors = [];
  let captures = 0;
  const scheduler = createVstFillArchiveScheduler({
    broker: {
      captureFillArchiveWindow: async () => {
        captures += 1;
        throw Object.assign(new Error("history read unavailable"), { code: "read_unavailable" });
      },
    },
    store,
    accountId: "account",
    now: () => NOW,
    maxCaptureAttempts: 2,
    retryDelayMs: 0,
    onError: (event) => errors.push(event),
  });
  const result = await scheduler.pollNow();
  assert.equal(result.kind, "error");
  assert.equal(captures, 2);
  assert.equal(store.cursor(), start);
  assert.equal(errors[0].code, "read_unavailable");
  assert.deepEqual(store.invalidated, []);
});

test("a missing archive table is reported once, then readiness recovery resumes verified contiguous capture", async () => {
  const start = NOW - TAIL - 50;
  const store = makeStore(start);
  const errors = [];
  const recoveries = [];
  let schemaAvailable = false;
  let captures = 0;
  const scheduler = createVstFillArchiveScheduler({
    broker: {
      captureFillArchiveWindow: async (input) => {
        captures += 1;
        return makeWindow({ accountId: "account", ...input });
      },
    },
    store,
    accountId: "account",
    now: () => NOW,
    checkSchema: async () => schemaAvailable
      ? { ready: true, missing: [] }
      : { ready: false, missing: ["vst_fill_archive_windows"] },
    onError: (event) => errors.push(event),
    onRecovery: (event) => recoveries.push(event),
  });

  const first = await scheduler.pollNow();
  assert.deepEqual(first, { kind: "error", calls: 0, saved: 0, caughtUp: false });
  assert.equal(store.cursor(), start);
  assert.equal(captures, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "fill_archive_schema_not_ready");
  assert.match(errors[0].error.message, /vst_fill_archive_windows/);
  assert.match(errors[0].error.message, /Publish/);

  await scheduler.pollNow();
  assert.equal(errors.length, 1, "the same missing-schema incident is not logged every retry");
  assert.equal(store.cursor(), start);

  schemaAvailable = true;
  const recovered = await scheduler.pollNow();
  assert.equal(recovered.kind, "ok");
  assert.equal(recovered.saved, 1);
  assert.equal(recovered.caughtUp, true);
  assert.equal(captures, 1);
  assert.equal(store.saved[0].coverage.startTs, start);
  assert.equal(store.saved[0].coverage.endTs, NOW - TAIL);
  assert.equal(store.cursor(), NOW - TAIL);
  assert.deepEqual(recoveries.map(({ code }) => code), ["fill_archive_schema_recovered"]);
});

test("PostgreSQL missing-relation errors produce a schema incident without capture retry spam", async () => {
  const errors = [];
  let cursorReads = 0;
  const store = makeStore();
  store.getFillArchiveCursor = async () => {
    cursorReads += 1;
    const error = new Error('relation "vst_fill_archive_windows" does not exist');
    error.code = "42P01";
    throw error;
  };
  const scheduler = createVstFillArchiveScheduler({
    broker: { captureFillArchiveWindow: async () => assert.fail("must not capture") },
    store,
    accountId: "account",
    now: () => NOW,
    onError: (event) => errors.push(event),
  });

  const result = await scheduler.pollNow();
  assert.equal(result.kind, "error");
  assert.equal(result.caughtUp, false);
  assert.equal(cursorReads, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "fill_archive_schema_not_ready");
  assert.match(errors[0].error.message, /42P01|does not exist/);
  assert.match(errors[0].error.message, /Publish/);
});

test("schema preflight database failures remain degraded with their SQLSTATE cause", async () => {
  const errors = [];
  let cursorReads = 0;
  const databaseError = Object.assign(new Error("database connection lost"), { code: "08006" });
  const store = makeStore();
  store.getFillArchiveCursor = async () => {
    cursorReads += 1;
    return null;
  };
  const scheduler = createVstFillArchiveScheduler({
    broker: { captureFillArchiveWindow: async () => assert.fail("must not capture") },
    store,
    accountId: "account",
    now: () => NOW,
    checkSchema: async () => { throw databaseError; },
    onError: (event) => errors.push(event),
  });

  const result = await scheduler.pollNow();
  assert.equal(result.kind, "error");
  assert.equal(result.caughtUp, false);
  assert.equal(cursorReads, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "fill_archive_schema_preflight_failed");
  assert.equal(errors[0].error.databaseCode, "08006");
  assert.equal(errors[0].error.cause, databaseError);
  assert.match(errors[0].error.message, /SQLSTATE 08006/);
});

test("capture retry count is also constrained by the cycle call budget", async () => {
  const start = NOW - TAIL - 50;
  const store = makeStore(start);
  let captures = 0;
  const scheduler = createVstFillArchiveScheduler({
    broker: {
      captureFillArchiveWindow: async () => {
        captures += 1;
        throw new Error("temporary read failure");
      },
    },
    store,
    accountId: "account",
    now: () => NOW,
    maxCallsPerCycle: 2,
    maxCaptureAttempts: 5,
    retryDelayMs: 0,
  });
  const result = await scheduler.pollNow();
  assert.equal(result.calls, 2);
  assert.equal(captures, 2);
  assert.equal(store.cursor(), start);
});

test("snapshot changes and raw identity conflicts invalidate before a retry", async (context) => {
  for (const [failure, expectedReason] of [
    ["bingx_complete_fill_history_snapshot_changed", "fill_history_snapshot_changed"],
    ["vst_fill_archive_conflicting_trade_content", "fill_archive_raw_identity_conflict"],
  ]) {
    await context.test(failure, async () => {
      const start = NOW - TAIL - 20;
      const store = makeStore(start);
      const events = [];
      store.invalidateFillArchiveWindows = async (input) => {
        events.push(["invalidate", input]);
      };
      let captures = 0;
      const scheduler = createVstFillArchiveScheduler({
        broker: {
          captureFillArchiveWindow: async (input) => {
            captures += 1;
            events.push(["capture", captures]);
            if (captures === 1) throw new Error(failure);
            return makeWindow({ accountId: "account", ...input });
          },
        },
        store,
        accountId: "account",
        now: () => NOW,
        retryDelayMs: 0,
      });
      const result = await scheduler.pollNow();
      assert.equal(result.kind, "ok");
      assert.equal(captures, 2);
      assert.equal(events[1][0], "invalidate");
      assert.deepEqual(events[1][1], {
        accountId: "account",
        currency: "USDT",
        startTs: start,
        endTs: NOW - TAIL,
        reason: expectedReason,
      });
    });
  }
});

test("minimum-width saturation is reported without advancing the cursor", async () => {
  const start = NOW - TAIL - 1;
  const store = makeStore(start);
  const errors = [];
  let captures = 0;
  const scheduler = createVstFillArchiveScheduler({
    broker: {
      captureFillArchiveWindow: async () => {
        captures += 1;
        throw Object.assign(new Error("saturated"), { code: "saturated" });
      },
    },
    store,
    accountId: "account",
    now: () => NOW,
    maxCallsPerCycle: 5,
    onError: (event) => errors.push(event),
  });
  const result = await scheduler.pollNow();
  assert.equal(result.calls, 1);
  assert.equal(captures, 1);
  assert.equal(store.cursor(), start);
  assert.equal(errors[0].code, "fill_archive_minimum_window_saturated");
});

test("saturation work stops at its per-cycle call budget without advancing the cursor", async () => {
  const start = NOW - TAIL - 100;
  const store = makeStore(start);
  let captures = 0;
  const scheduler = createVstFillArchiveScheduler({
    broker: {
      captureFillArchiveWindow: async () => {
        captures += 1;
        throw Object.assign(new Error("saturated"), { code: "saturated" });
      },
    },
    store,
    accountId: "account",
    now: () => NOW,
    maxCallsPerCycle: 5,
  });
  const result = await scheduler.pollNow();
  assert.equal(result.calls, 5);
  assert.equal(captures, 5);
  assert.equal(store.cursor(), start);
});

test("periodically re-observes and saves the latest completed window without moving the cursor", async () => {
  let clock = NOW;
  const cursor = NOW + 5 * 60_000 - TAIL;
  const startTs = cursor - HOUR;
  const saved = [];
  const listQueries = [];
  const store = {
    getFillArchiveCursor: async () => cursor,
    listFillArchiveWindows: async (input) => {
      listQueries.push(input);
      return [makeWindow({ accountId: "account", startTs, endTs: cursor })];
    },
    saveFillArchiveWindow: async (window) => { saved.push(window); },
  };
  const captures = [];
  const scheduler = createVstFillArchiveScheduler({
    broker: {
      captureFillArchiveWindow: async (input) => {
        captures.push(input);
        return makeWindow({ accountId: "account", ...input });
      },
    },
    store,
    accountId: "account",
    now: () => clock,
  });
  clock += 5 * 60_000;
  const result = await scheduler.pollNow();
  assert.equal(result.kind, "ok");
  assert.deepEqual(captures, [{ startTs, endTs: cursor, currency: "USDT" }]);
  assert.deepEqual(listQueries, [{
    accountId: "account", currency: "USDT",
    startTs: cursor - 24 * HOUR, endTs: cursor,
  }]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].coverage.startTs, startTs);
  assert.equal(saved[0].coverage.endTs, cursor);
  assert.equal(await store.getFillArchiveCursor(), cursor);
});

test("refresh saturation invalidates broad proof, then verified halves restore a contiguous cursor", async () => {
  let clock = NOW;
  const cursor = NOW + 5 * 60_000 - TAIL;
  const startTs = cursor - 100;
  const invalidations = [];
  const windows = [makeWindow({ accountId: "account", startTs, endTs: cursor })];
  const cursorOf = () => {
    const ordered = windows.slice().sort((a, b) =>
      a.coverage.startTs - b.coverage.startTs ||
      a.coverage.endTs - b.coverage.endTs);
    let current = null;
    for (const window of ordered) {
      if (current === null) current = window.coverage.endTs;
      else if (window.coverage.startTs <= current) {
        current = Math.max(current, window.coverage.endTs);
      } else break;
    }
    return current;
  };
  const store = {
    getFillArchiveCursor: async () => cursorOf(),
    listFillArchiveWindows: async ({ startTs: lower, endTs: upper }) =>
      windows.filter((window) =>
        window.coverage.startTs <= upper && window.coverage.endTs >= lower),
    invalidateFillArchiveWindows: async ({ startTs: lower, endTs: upper, reason }) => {
      invalidations.push({ startTs: lower, endTs: upper, reason });
      for (let index = windows.length - 1; index >= 0; index -= 1) {
        const coverage = windows[index].coverage;
        if (coverage.startTs <= upper && coverage.endTs >= lower) windows.splice(index, 1);
      }
    },
    saveFillArchiveWindow: async (window) => { windows.push(window); },
  };
  const captures = [];
  const scheduler = createVstFillArchiveScheduler({
    broker: {
      captureFillArchiveWindow: async (input) => {
        captures.push(input);
        if (input.endTs - input.startTs > 50) {
          throw Object.assign(new Error("fill history saturated"), {
            code: "fill_history_saturated",
          });
        }
        return makeWindow({ accountId: "account", ...input });
      },
    },
    store,
    accountId: "account",
    now: () => clock,
  });
  clock += 5 * 60_000;
  const result = await scheduler.pollNow();
  assert.equal(result.kind, "ok");
  assert.deepEqual(invalidations, [{
    startTs, endTs: cursor, reason: "fill_history_saturated",
  }]);
  assert.deepEqual(captures.slice(0, 3).map(({ startTs: begin, endTs: end }) =>
    [begin, end]), [
    [startTs, cursor],
    [startTs, startTs + 50],
    [startTs + 50, cursor],
  ]);
  assert.deepEqual(windows.map((window) => [
    window.coverage.startTs, window.coverage.endTs,
  ]), [
    [startTs, startTs + 50],
    [startTs + 50, cursor],
  ]);
  assert.equal(cursorOf(), cursor);
});

test("periodic refresh rotates across recent fixed windows instead of repeating only the tail", async () => {
  let clock = NOW;
  let cursor = NOW + 5 * 60_000 - TAIL;
  const first = makeWindow({
    accountId: "account", startTs: cursor - 3 * HOUR, endTs: cursor - 2 * HOUR,
  });
  const second = makeWindow({
    accountId: "account", startTs: cursor - 2 * HOUR, endTs: cursor - HOUR,
  });
  const third = makeWindow({
    accountId: "account", startTs: cursor - HOUR, endTs: cursor,
  });
  const windows = [first, second, third];
  const store = {
    getFillArchiveCursor: async () => cursor,
    listFillArchiveWindows: async ({ startTs, endTs }) =>
      windows.filter((window) =>
        window.coverage.startTs <= endTs && window.coverage.endTs >= startTs),
    saveFillArchiveWindow: async (window) => { windows.push(window); },
  };
  const captures = [];
  const scheduler = createVstFillArchiveScheduler({
    broker: {
      captureFillArchiveWindow: async (input) => {
        captures.push(input);
        return makeWindow({ accountId: "account", ...input });
      },
    },
    store,
    accountId: "account",
    now: () => clock,
  });

  clock = NOW + 5 * 60_000;
  await scheduler.pollNow();
  assert.deepEqual(captures[0], {
    startTs: first.coverage.startTs,
    endTs: first.coverage.endTs,
    currency: "USDT",
  });

  const priorCursor = cursor;
  clock += 5 * 60_000;
  cursor = clock - TAIL;
  windows.push(makeWindow({
    accountId: "account", startTs: priorCursor, endTs: cursor,
  }));
  await scheduler.pollNow();
  assert.deepEqual(captures[1], {
    startTs: second.coverage.startTs,
    endTs: second.coverage.endTs,
    currency: "USDT",
  });
});

test("polls are single-flight, including a slow archive read", async () => {
  const start = NOW - TAIL - 10;
  const store = makeStore(start);
  let release;
  let captures = 0;
  const scheduler = createVstFillArchiveScheduler({
    broker: {
      captureFillArchiveWindow: async (input) => {
        captures += 1;
        await new Promise((resolve) => { release = resolve; });
        return makeWindow({ accountId: "account", ...input });
      },
    },
    store,
    accountId: "account",
    now: () => NOW,
  });
  const active = scheduler.pollNow();
  await new Promise(setImmediate);
  assert.deepEqual(await scheduler.pollNow(), { kind: "in_flight" });
  assert.equal(captures, 1);
  release();
  assert.equal((await active).kind, "ok");
});