import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSourceFreshnessWatchdog,
  createSourceLifecycleScheduler,
} from "../source-lifecycle-scheduler.mjs";
import {
  beginBotRuntimeTick,
  configureBotRuntimeHealth,
  finishBotRuntimeTick,
  getBotRuntimeHealth,
} from "../bot-health-runtime.mjs";

const flush = async () => new Promise((resolve) => setImmediate(resolve));

function fakeWatchdog({ now, sendAlert, onState } = {}) {
  let timer;
  const watchdog = createSourceFreshnessWatchdog({
    now: () => now.value,
    ...(sendAlert ? { sendAlert } : {}),
    ...(onState ? { onState } : {}),
    setIntervalFn(callback) { timer = callback; return 1; },
    clearIntervalFn() {},
  });
  watchdog.start();
  return { watchdog, check: () => timer() };
}

test("a one-off 502 at the 60-second freshness boundary does not page", async () => {
  const now = { value: 0 };
  let telegramSends = 0;
  const { watchdog, check } = fakeWatchdog({
    now,
    sendAlert: async () => { telegramSends += 1; },
  });
  let fetches = 0;
  const scheduler = createSourceLifecycleScheduler({
    now: () => now.value,
    fetchSnapshot: async () => {
      fetches += 1;
      if (fetches === 1) throw Object.assign(new Error("provider unavailable"), { httpStatus: 502 });
      return { asOf: new Date(now.value).toISOString(), positions: new Map() };
    },
    queuePaperExits: async () => ({ queued: [], refreshed: [], rejected: [] }),
    onAttemptFailure: () => watchdog.failed(),
  });
  await scheduler.pollNow();
  now.value = 60_000;
  check();
  await flush();
  assert.equal(telegramSends, 0);
  now.value += 1;
  await scheduler.pollNow();
  await flush();
  watchdog.healthy(now.value); // next complete fresh admission
  await flush();
  assert.equal(telegramSends, 0);
  scheduler.stop();
  watchdog.stop();
});

test("warning needs three failed attempts after three minutes; critical escalates and repeats at 30 minutes", async () => {
  const now = { value: 0 };
  const sent = [];
  const { watchdog, check } = fakeWatchdog({
    now,
    sendAlert: async (event) => sent.push(event),
  });
  now.value = 179_999;
  watchdog.failed();
  watchdog.failed();
  watchdog.failed();
  check();
  await flush();
  assert.equal(sent.length, 0);
  now.value = 180_000;
  check();
  await flush();
  assert.deepEqual(sent.map(({ kind, severity }) => [kind, severity]), [["stale", "warning"]]);
  now.value = 300_000;
  check();
  await flush();
  assert.deepEqual(sent.map(({ severity }) => severity), ["warning", "critical"]);
  now.value = 2_100_000;
  check();
  await flush();
  assert.deepEqual(sent.map(({ severity }) => severity), ["warning", "critical", "critical"]);
  watchdog.stop();
});

test("a hung initial fetch reaches critical at five minutes even with zero failures", async () => {
  const now = { value: 0 };
  const sent = [];
  const { watchdog, check } = fakeWatchdog({
    now,
    sendAlert: async (event) => sent.push(event),
  });
  now.value = 300_000;
  check();
  await flush();
  assert.deepEqual(sent.map(({ severity }) => severity), ["critical"]);
  assert.equal(watchdog.getState().failureCount, 0);
  watchdog.stop();
});

test("recovery needs two complete admissions 30 seconds apart and any intervening failure resets it", async () => {
  const now = { value: 0 };
  const sent = [];
  const { watchdog } = fakeWatchdog({
    now,
    sendAlert: async (event) => sent.push(event.kind),
  });
  now.value = 180_000;
  watchdog.failed();
  watchdog.failed();
  watchdog.failed();
  await flush();
  assert.deepEqual(sent, ["stale"]);

  now.value = 181_000;
  watchdog.healthy(now.value);
  now.value = 190_000;
  watchdog.failed();
  now.value = 200_000;
  watchdog.healthy(now.value);
  await flush();
  assert.deepEqual(sent, ["stale"], "a short healthy blip cannot produce a recovered alert");
  now.value = 230_000;
  watchdog.healthy(now.value);
  await flush();
  assert.deepEqual(sent, ["stale", "recovered"]);
  assert.equal(watchdog.getIncident(), null);
  watchdog.stop();
});

test("three admitted snapshots 15 seconds apart qualify recovery at the 30-second span", async () => {
  const now = { value: 0 };
  const sent = [];
  const { watchdog } = fakeWatchdog({
    now,
    sendAlert: async ({ kind }) => sent.push(kind),
  });
  now.value = 180_000;
  watchdog.failed();
  watchdog.failed();
  watchdog.failed();
  await flush();
  assert.deepEqual(sent, ["stale"]);

  for (const time of [185_000, 200_000, 215_000]) {
    now.value = time;
    watchdog.healthy(time);
  }
  await flush();
  assert.deepEqual(sent, ["stale", "recovered"]);
  watchdog.stop();
});

test("stable recovery silently clears a failed unacknowledged warning before its retry", async () => {
  const now = { value: 0 };
  const sent = [];
  const states = [];
  const { watchdog } = fakeWatchdog({
    now,
    onState: (incident) => states.push(incident),
    sendAlert: async (event) => {
      sent.push(event.kind);
      if (sent.length === 1) throw new Error("temporary Telegram failure");
    },
  });
  now.value = 180_000;
  watchdog.failed();
  watchdog.failed();
  watchdog.failed();
  await flush();
  assert.deepEqual(sent, ["stale"]);
  assert.equal(watchdog.getIncident().alertedAt, null);

  for (const time of [185_000, 200_000, 215_000]) {
    now.value = time;
    watchdog.healthy(time);
  }
  assert.equal(watchdog.getIncident(), null);
  assert.equal(states.at(-1), null, "health consumers receive the cleared incident immediately");
  now.value = 240_000;
  watchdog.check();
  await flush();
  assert.deepEqual(sent, ["stale"], "an unacknowledged incident that stably recovered is not retried");
  watchdog.stop();
});

test("a brief healthy blip does not discard a failed page before its 60-second retry", async () => {
  const now = { value: 0 };
  const sent = [];
  const { watchdog } = fakeWatchdog({
    now,
    sendAlert: async (event) => {
      sent.push(event.kind);
      if (sent.length === 1) throw new Error("temporary Telegram failure");
    },
  });
  now.value = 180_000;
  watchdog.failed();
  watchdog.failed();
  watchdog.failed();
  await flush();
  now.value = 185_000;
  watchdog.healthy(now.value);
  now.value = 190_000;
  watchdog.failed();
  assert.notEqual(watchdog.getIncident(), null);
  now.value = 240_000;
  watchdog.check();
  await flush();
  assert.deepEqual(sent, ["stale", "stale"]);
  assert.notEqual(watchdog.getIncident(), null);
  assert.notEqual(watchdog.getIncident().alertedAt, null);
  watchdog.stop();
});

test("a failed Telegram delivery does not acknowledge the page and is retried after at most 60 seconds", async () => {
  const now = { value: 0 };
  let deliveries = 0;
  const { watchdog } = fakeWatchdog({
    now,
    sendAlert: async ({ kind }) => {
      deliveries += 1;
      if (deliveries === 1) throw new Error("temporary Telegram failure");
      assert.equal(kind, deliveries === 3 ? "recovered" : "stale");
    },
  });
  now.value = 180_000;
  watchdog.failed();
  watchdog.failed();
  watchdog.failed();
  await flush();
  assert.equal(deliveries, 1);
  assert.equal(watchdog.getIncident().alertedAt, null);

  now.value = 200_000;
  watchdog.healthy(now.value); // do not discard the failed page during a blip
  now.value = 239_999;
  watchdog.check();
  await flush();
  assert.equal(deliveries, 1);
  now.value = 240_000;
  watchdog.check();
  await flush();
  assert.equal(deliveries, 2);
  assert.notEqual(watchdog.getIncident().alertedAt, null);

  now.value = 240_001;
  watchdog.healthy(now.value);
  now.value = 270_001;
  watchdog.healthy(now.value);
  await flush();
  assert.equal(deliveries, 3);
  assert.equal(watchdog.getIncident(), null);
  watchdog.stop();
});

test("runtime getter exposes independent preview pause state and lane tick telemetry", () => {
  configureBotRuntimeHealth({
    sourceEnabled: false,
    vstEnabled: false,
    paperEnabled: false,
  });
  const paused = getBotRuntimeHealth();
  assert.equal(typeof paused.startedAt, "string");
  assert.equal(paused.source.enabled, false);
  assert.equal(paused.source.startedAt, null);
  assert.equal(paused.source.lastAttemptAt, null);
  assert.equal(paused.source.policy.freshnessMs, 60_000);
  assert.equal(paused.vst.enabled, false);
  assert.equal(paused.paper.enabled, false);
  assert.equal(paused.vst.inFlight, false);

  const started = Date.now();
  beginBotRuntimeTick("paper", started);
  assert.equal(getBotRuntimeHealth().paper.inFlight, true);
  finishBotRuntimeTick("paper", { at: started + 12, outcome: "success" });
  const finished = getBotRuntimeHealth().paper;
  assert.equal(finished.inFlight, false);
  assert.equal(finished.lastOutcome, "success");
  assert.equal(finished.lastDurationMs, 12);
  assert.equal(finished.successfulTicks, 1);
  assert.equal(finished.lastSuccessAt, finished.lastFinishedAt);
});