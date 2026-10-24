import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sourcePollingPolicy, sourceFailureMetadata } from "../source-polling-policy.mjs";
import { formatSourceSyncLivenessAlert } from "../vst-telegram.mjs";

test("only production automatically subscribes to the shared source", () => {
  assert.deepEqual(sourcePollingPolicy({ NODE_ENV: "production" }),
    { enabled: true, reason: null });
  for (const NODE_ENV of ["development", "test", undefined]) {
    assert.deepEqual(sourcePollingPolicy({ NODE_ENV }), {
      enabled: false, reason: "source_sync_disabled_outside_production",
    });
  }
});

test("development polling needs an exact explicit opt-in", () => {
  assert.equal(sourcePollingPolicy({
    NODE_ENV: "development", BULLET_SOURCE_SYNC_ALLOW_DEVELOPMENT: "true",
  }).enabled, true);
  for (const value of ["false", "TRUE", "1", true, undefined]) {
    assert.equal(sourcePollingPolicy({
      NODE_ENV: "development", BULLET_SOURCE_SYNC_ALLOW_DEVELOPMENT: value,
    }).enabled, false);
  }
});

test("source failure logs contain only bounded reviewed metadata", () => {
  const secret = "PRIVATE_TOKEN_AND_RESPONSE";
  assert.deepEqual(sourceFailureMetadata({
    httpStatus: 429, failureStage: "http", pageNumber: 2, attempts: 2,
    retryAfterMs: 60_000, message: secret, cause: secret,
    url: secret, headers: { authorization: secret }, body: secret,
  }), {
    httpStatus: 429, failureStage: "http", page: 2, attempts: 2,
    retryAfterMs: 60_000,
  });
  assert.deepEqual(sourceFailureMetadata({
    httpStatus: "429", failureStage: secret, pageNumber: 101, attempts: 3,
    retryAfterMs: Infinity, message: secret,
  }), {});
});

test("runtime starts both source polling and its watchdog only under the same policy", async () => {
  const runtime = await readFile(new URL("../bot-runtime.mjs", import.meta.url), "utf8");
  assert.match(runtime, /if \(sourcePolling\.enabled\) \{\s*sourceFreshnessWatchdog\.start\(\);\s*sourceLifecycleScheduler\.start\(\);/);
  assert.equal(runtime.match(/sourceFreshnessWatchdog\.start\(\)/g)?.length, 1);
  assert.equal(runtime.match(/sourceLifecycleScheduler\.start\(\)/g)?.length, 1);
  assert.match(runtime, /reportSourceSyncFailure\(sourcePolling\.reason\)/);
  assert.match(runtime, /sourceFailureMetadata\(poll\.error\)/);
  assert.match(runtime, /failure: lastSourceReadFailure/);
  assert.match(runtime, /lastSourceReadFailure = \{\};\s*\}\s*const pollLog = poll\.kind === "error" \? process\.stderr : process\.stdout;\s*pollLog\.write\(`Bullet source poll end/);
  assert.match(runtime, /intervalMs: 60_000/);
  assert.match(runtime, /requireSourceAction: true/);
});

test("source alerts explain reviewed failures without revealing error payloads or claiming fills", () => {
  const secret = "PRIVATE_TOKEN_AND_RESPONSE";
  const stale = formatSourceSyncLivenessAlert({
    kind: "stale", severity: "warning", staleForMs: 181_000,
    failure: { httpStatus: 429, retryAfterMs: 60_000, message: secret },
  });
  assert.match(stale, /HTTP 429.*ограничение частоты/);
  assert.match(stale, /60 сек/);
  assert.equal(stale.includes(secret), false);
  const recovered = formatSourceSyncLivenessAlert({
    kind: "recovered", failure: { httpStatus: 429, message: secret },
  });
  assert.match(recovered, /Два свежих полных снимка.*не менее 30 секунд/);
  assert.match(recovered, /подтверждается отдельно/);
  assert.doesNotMatch(recovered, /HTTP|PRIVATE_TOKEN/);
});