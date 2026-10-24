import assert from "node:assert/strict";
import test from "node:test";
import {
  createVstTickLivenessWatchdog, isSafeTickErrorSummary, safeTickErrorSummary,
} from "../vst-tick-watchdog.mjs";

test("reviewed quote-corroboration failures are identifiable without exposing arbitrary details", () => {
  const error = new Error("VST mark is not corroborated by a fresh quote");
  error.name = "BingXLiveApiError";
  const summary = safeTickErrorSummary(error);
  assert.equal(summary,
    "BingXLiveApiError: VST mark is not corroborated by a fresh quote [ref:6b3d6de49d72]");
  assert.equal(isSafeTickErrorSummary(summary), true);
  error.message += ' {"apiKey":"short-secret","balance":123}';
  assert.match(safeTickErrorSummary(error), /Details withheld/);
  assert.doesNotMatch(safeTickErrorSummary(error), /short-secret|balance/);
});
import { createIndependentWorkerTickScheduler } from "../worker-tick-scheduler.mjs";

test("VST tick watchdog alerts at two minutes and repeats only at its re-notification interval", () => {
  let clock = 1_000;
  const alerts = [];
  const watchdog = createVstTickLivenessWatchdog({
    now: () => clock,
    blockedAlerter: { async send(info) { alerts.push(info); } },
  });

  watchdog.begin();
  clock += 120_000 - 1;
  assert.equal(watchdog.check(), false);
  assert.equal(alerts.length, 0);

  clock += 1;
  assert.equal(watchdog.check(), true);
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0], {
    reason: "vst_worker_tick_stalled",
    blockedForMs: 120_000,
  });

  clock += 300;
  assert.equal(watchdog.check(), false);
  assert.equal(alerts.length, 1);

  clock += 30 * 60_000 - 300;
  assert.equal(watchdog.check(), true);
  assert.equal(alerts.length, 2);
  assert.equal(alerts[1].blockedForMs, 30 * 60_000 + 120_000);
});

test("two-minute ticks share the thirty-minute stalled-alert repeat throttle", async () => {
  let clock = 10_000;
  const alerts = [];
  const watchdog = createVstTickLivenessWatchdog({
    now: () => clock,
    blockedAlerter: { async send(info) { alerts.push(info); } },
  });

  const tick = async () => {
    watchdog.begin();
    clock += 120_000;
    const result = watchdog.check();
    watchdog.complete();
    await Promise.resolve();
    return result;
  };

  assert.equal(await tick(), true);
  assert.equal(await tick(), false);
  assert.equal(await tick(), false);
  assert.equal(alerts.length, 1);

  clock += 30 * 60_000 - 360_000;
  assert.equal(await tick(), true);
  assert.equal(alerts.length, 2);
  assert.equal(alerts[1].blockedForMs, 120_000);
});

test("watchdog is inert without the production-gated blocked alerter", () => {
  let clock = 0;
  const watchdog = createVstTickLivenessWatchdog({ now: () => clock });
  watchdog.begin();
  clock = 10 * 60_000;
  assert.equal(watchdog.check(), false);
});

test("distinct worker errors alert once each and repeat only after thirty minutes", async () => {
  let clock = 0;
  const alerts = [];
  const watchdog = createVstTickLivenessWatchdog({
    now: () => clock,
    blockedAlerter: { async send(info) { alerts.push(info); } },
  });
  const first = new TypeError("Unsupported VST policy version or pattern");

  assert.equal(watchdog.reportError(first), true);
  await Promise.resolve();
  assert.equal(alerts[0].reason, "vst_worker_error");
  assert.match(alerts[0].errorSummary,
    /^TypeError: Unsupported VST policy version or pattern \[ref:[a-f0-9]{12}\]$/);
  clock += 60_000;
  assert.equal(watchdog.reportError(first), false);
  assert.equal(watchdog.reportError(new Error("different exchange failure")), true);
  await Promise.resolve();
  assert.equal(alerts.length, 2, "a distinct error isn't suppressed by the first");

  clock += 30 * 60_000;
  assert.equal(watchdog.reportError(first), true);
  await Promise.resolve();
  assert.equal(alerts.length, 3);
});

test("a rejected alert send is reported without ending the active scheduler tick", async () => {
  let clock = 0;
  const intervals = [];
  const failures = [];
  let resolveTick;
  let active = 0;
  let maxActive = 0;
  const watchdog = createVstTickLivenessWatchdog({
    now: () => clock,
    onAlertError(error) { failures.push(error.message); },
    blockedAlerter: {
      async send() { throw new Error("simulated Telegram failure"); },
    },
  });
  const scheduler = createIndependentWorkerTickScheduler({
    runVst() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => {
        resolveTick = () => {
          active -= 1;
          resolve();
        };
      });
    },
    vstTickWatchdog: watchdog,
    setIntervalFn(callback) {
      intervals.push(callback);
      return { unref() {} };
    },
    clearIntervalFn() {},
  });

  const firstTick = intervals[0]();
  clock = 120_000;
  await intervals[0]();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(failures, ["simulated Telegram failure"]);
  assert.equal(active, 1);
  assert.equal(watchdog.check(), false);
  await intervals[0]();
  assert.equal(active, 1, "a failed alert cannot admit a concurrent trading tick");
  assert.equal(maxActive, 1);

  resolveTick();
  await firstTick;
  scheduler();
});

test("critical tick errors keep independent notifications and safe diagnostic links", async () => {
  const sent = [];
  const watchdog = createVstTickLivenessWatchdog({
    blockedAlerter: { send: async (info) => { sent.push(info); } },
    diagnoseError: () => ({ ref: "0123456789ab" }),
  });
  watchdog.reportError(new Error("uncertain order submission BTC"));
  watchdog.reportError(new Error("uncertain stop cancellation ETH"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 2);
  assert.ok(sent.every((info) => info.reason === "vst_worker_error"));
  assert.ok(sent.every((info) => info.diagnosticRef === "0123456789ab"));
});

test("VST tick summaries expose only reviewed templates, validated BingX codes, and a fingerprint", () => {
  const policyError = safeTickErrorSummary(
    new TypeError("Unsupported VST policy version or pattern"),
  );
  assert.match(policyError,
    /^TypeError: Unsupported VST policy version or pattern \[ref:[a-f0-9]{12}\]$/);
  assert.equal(isSafeTickErrorSummary(policyError), true);

  const bingxError = new Error("private exchange response");
  bingxError.name = "BingXLiveApiError";
  bingxError.code = 109500;
  const codedSummary = safeTickErrorSummary(bingxError);
  assert.match(codedSummary, /^BingXLiveApiError: BingX error code 109500 \[ref:[a-f0-9]{12}\]$/);
  assert.equal(isSafeTickErrorSummary(codedSummary), true);

  const readError = new Error("private exchange response");
  readError.name = "BingXLiveApiError";
  readError.code = 109400;
  const readSummary = safeTickErrorSummary(readError);
  assert.match(readSummary, /^BingXLiveApiError: BingX error code 109400 \[ref:[a-f0-9]{12}\]$/);
  assert.equal(isSafeTickErrorSummary(readSummary), true);

  const unknownCode = new Error("private exchange response");
  unknownCode.code = 123456;
  assert.match(safeTickErrorSummary(unknownCode),
    /^Error: Details withheld \[ref:[a-f0-9]{12}\]$/);

  const maliciousName = new TypeError("private exception");
  maliciousName.name = "Error accountBalance=987654321";
  assert.match(safeTickErrorSummary(maliciousName),
    /^Error: Details withheld \[ref:[a-f0-9]{12}\]$/);
});

test("VST tick summaries withhold JSON secrets and balances but fingerprint distinct failures", () => {
  const first = new Error(
    '{"password":"p4ss","apiKey":"short-key","balance":"123.45"}',
  );
  const second = new Error(
    '{"password":"other","apiKey":"another-key","balance":"987.65"}',
  );
  const firstSummary = safeTickErrorSummary(first);
  const secondSummary = safeTickErrorSummary(second);

  assert.match(firstSummary, /^Error: Details withheld \[ref:[a-f0-9]{12}\]$/);
  assert.match(secondSummary, /^Error: Details withheld \[ref:[a-f0-9]{12}\]$/);
  assert.notEqual(firstSummary, secondSummary);
  for (const secret of ["p4ss", "short-key", "123.45", "other", "another-key", "987.65"]) {
    assert.equal(firstSummary.includes(secret), false);
    assert.equal(secondSummary.includes(secret), false);
  }
  assert.equal(isSafeTickErrorSummary('Error: password="p4ss" [ref:0123456789ab]'), false);

  const nonNumericCode = new Error("details withheld");
  nonNumericCode.code = "accountBalance=123.45";
  assert.doesNotMatch(safeTickErrorSummary(nonNumericCode), /accountBalance|123\.45/);
});