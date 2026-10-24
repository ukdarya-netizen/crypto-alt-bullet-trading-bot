import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFullTakeWatchHealth, FULL_TAKE_WATCH_OUTAGE_TEXT, FULL_TAKE_WATCH_RESTORED_TEXT,
} from "../full-take-watch-health.mjs";

test("price-watch outage notifies once after two minutes and once on recovery", async () => {
  let now = 0;
  const sent = [];
  const health = createFullTakeWatchHealth({ now: () => now, send: async (text) => { sent.push(text); } });
  await health.success();
  await health.failure();
  now = 119_000; await health.failure();
  assert.deepEqual(sent, [], "short blips stay silent");
  now = 120_000; await health.failure();
  now = 600_000; await health.failure();
  assert.deepEqual(sent, [FULL_TAKE_WATCH_OUTAGE_TEXT]);
  await health.success();
  await health.success();
  assert.deepEqual(sent, [FULL_TAKE_WATCH_OUTAGE_TEXT, FULL_TAKE_WATCH_RESTORED_TEXT]);
});

test("a failed Telegram send is retried on the next observation, never thrown", async () => {
  let now = 0;
  let fail = true;
  const sent = [];
  const health = createFullTakeWatchHealth({ now: () => now,
    send: async (text) => { if (fail) throw new Error("telegram down"); sent.push(text); } });
  await health.failure();
  now = 130_000; await health.failure();
  assert.equal(health.state().alerted, false);
  fail = false; await health.failure();
  assert.deepEqual(sent, [FULL_TAKE_WATCH_OUTAGE_TEXT]);
  assert.ok(!/[<>]/.test(FULL_TAKE_WATCH_OUTAGE_TEXT + FULL_TAKE_WATCH_RESTORED_TEXT));
});
