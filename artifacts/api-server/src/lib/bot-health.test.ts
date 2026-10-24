import assert from "node:assert/strict";
import test from "node:test";
import { GetJournalBotHealthResponse } from "@workspace/api-zod";
import {
  buildBotHealth, createLedgerHealthReader, type BotRuntimeTelemetry, type LedgerHealth,
} from "./bot-health";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
function runtime(): BotRuntimeTelemetry {
  const worker = {
    enabled: true, lastStartedAt: iso(-20_000), lastFinishedAt: iso(-5_000),
    lastSuccessAt: iso(-5_000), lastDurationMs: 15_000,
    lastOutcome: "success", lastReason: null, inFlight: false,
    errorTicks: 0, successfulTicks: 1, stallAfterMs: 120_000,
  };
  return {
    startedAt: iso(-500_000),
    source: {
      enabled: true, startedAt: iso(-500_000), lastAttemptAt: iso(-5_000),
      lastSuccessAt: iso(-5_000), lastSnapshotAt: iso(-6_000), lastDurationMs: 1_000,
      totalPolls: 20, totalFailures: 0, consecutiveFailures: 0,
      lastReason: null, lastHttpStatus: null, incident: null,
      policy: {
        freshnessMs: 60_000, warningAfterMs: 180_000, criticalAfterMs: 300_000,
        repeatMs: 1_800_000, recoveryStableMs: 30_000, recoverySuccesses: 2,
      },
    },
    vst: { ...worker }, paper: { ...worker },
  };
}
function ledger(): LedgerHealth {
  return { checkedAt: new Date(NOW), values: {
    queued: 0, queueOldestAt: null, unresolved: 0, unresolvedOldestAt: null,
    unknownIntents: 0, reviewPositions: 0, unsent: 0, unsentOldestAt: null,
    pendingSourceExits: 0, sourceExitOldestAt: null,
  } };
}
const build = (state = runtime(), rows = ledger()) =>
  buildBotHealth(state, rows, { now: NOW, production: true });

test("a stale source exit is critical even with zero unresolved exchange intents", () => {
  const rows = ledger();
  rows.values!.pendingSourceExits = 1;
  rows.values!.sourceExitOldestAt = new Date(NOW - 180_000);
  const health = GetJournalBotHealthResponse.parse(build(runtime(), rows));
  const reconciliation = health.checks.find((check) => check.key === "reconciliation")!;
  assert.equal(reconciliation.status, "critical");
  assert.match(reconciliation.summary, /заявки на выход/);
  assert.equal(reconciliation.metrics.find((metric) =>
    metric.key === "pending_source_exits")!.value, 1);
  rows.values!.pendingSourceExits = 0;
  rows.values!.sourceExitOldestAt = null;
  assert.equal(build(runtime(), rows).status, "healthy");
});

test("real source, worker and ledger evidence produce a validated healthy snapshot", () => {
  const health = GetJournalBotHealthResponse.parse(build());
  assert.equal(health.status, "healthy");
  assert.equal(health.environment, "production");
  assert.equal(health.readOnly, true);
  assert.equal(health.checks.length, 6);
  assert.equal(health.policy.sourceWarningAfterMs, 180_000);
  assert.equal(health.checks.find((check) => check.key === "entry_queue")!.metrics[0].value, 0);
});

test("60-second freshness stays visible without fabricating a delivered Telegram incident", () => {
  const state = runtime();
  state.source.lastSuccessAt = iso(-70_000);
  state.source.lastSnapshotAt = iso(-71_000);
  state.source.consecutiveFailures = 1;
  state.source.lastHttpStatus = 502;
  const health = build(state);
  assert.equal(health.status, "degraded");
  assert.deepEqual(health.incidents, []);
  assert.equal(health.checks[0].metrics.find((metric) => metric.key === "last_http_status")!.value, 502);
  assert.equal(health.policy.sourceFreshnessMs, 60_000);
});

test("snapshot age is independent of recent admission and a hung source becomes critical", () => {
  const state = runtime();
  state.source.lastSnapshotAt = iso(-70_000);
  assert.equal(build(state).checks[0].status, "degraded");
  state.source.lastSuccessAt = null;
  state.source.lastSnapshotAt = null;
  assert.equal(build(state).checks[0].status, "critical");
});

test("recovery stays degraded and failed alert delivery is not marked sent", () => {
  const state = runtime();
  state.source.incident = {
    startedAt: iso(-220_000), severity: "warning", alertedAt: null, recoverySince: iso(-15_000),
  };
  const health = build(state);
  assert.equal(health.checks[0].status, "degraded");
  assert.equal(health.incidents[0].alertedAt, null);
  assert.equal(health.incidents[0].recoverySince!.toISOString(), iso(-15_000));
});

test("paused preview is not healthy, while missing ledger reads are explicitly unknown", () => {
  const state = runtime();
  state.source.enabled = state.vst.enabled = state.paper.enabled = false;
  assert.equal(buildBotHealth(state, ledger(), { now: NOW }).status, "paused");
  const health = build(state, { checkedAt: null, values: null });
  assert.equal(health.status, "unknown");
  assert.equal(health.checks.find((check) => check.key === "entry_queue")!.metrics[0].value, null);
});

test("restoring an incident is not fresh source evidence; unavailable checkpoints are not healthy", () => {
  const state = runtime();
  state.source.startedAt = iso();
  state.source.lastSuccessAt = state.source.lastSnapshotAt = null;
  state.source.incident = {
    startedAt: iso(-190_000), severity: "warning", alertedAt: iso(-10_000), recoverySince: null,
  };
  const restored = GetJournalBotHealthResponse.parse(build(state));
  assert.equal(restored.checks[0].status, "degraded");
  assert.equal(restored.checks[0].lastSuccessAt, null);
  assert.equal(restored.incidents[0].alertedAt!.toISOString(), iso(-10_000));
  state.source.incident = null;
  state.source.lastSuccessAt = state.source.lastSnapshotAt = iso(-1_000);
  state.source.incidentStateKnown = false;
  assert.equal(build(state).checks[0].status, "unknown");
  state.source.enabled = false;
  assert.equal(build(state).checks[0].status, "paused");
});

test("queue wait, prolonged intents and review positions are not hidden by healthy ticks", () => {
  const rows = ledger();
  rows.values!.queued = 2;
  rows.values!.queueOldestAt = new Date(NOW - 200_000);
  assert.equal(build(runtime(), rows).status, "degraded");
  rows.values!.unresolved = 1;
  rows.values!.unresolvedOldestAt = new Date(NOW - 130_000);
  assert.equal(build(runtime(), rows).status, "critical");
  rows.values!.unresolved = 0;
  rows.values!.reviewPositions = 1;
  assert.equal(build(runtime(), rows).status, "critical");
});

test("an in-flight slow tick and a completed failing tick are different health states", () => {
  const state = runtime();
  state.vst.inFlight = true;
  state.vst.lastStartedAt = iso(-130_000);
  assert.equal(build(state).checks.find((check) => check.key === "vst_worker")!.status, "critical");
  state.vst.inFlight = false;
  state.vst.lastOutcome = "error";
  state.vst.lastReason = "credentials=must-not-leave-server";
  const check = build(state).checks.find((check) => check.key === "vst_worker")!;
  assert.equal(check.status, "degraded");
  assert.doesNotMatch(check.summary, /credentials|must-not/);
});

test("bounded ledger reads coalesce, preserve zeroes and exclude internal Telegram telemetry", async () => {
  let calls = 0;
  let time = NOW;
  const read = createLedgerHealthReader({
    query: async (config) => {
      calls++;
      assert.equal(config.query_timeout, 3_000);
      assert.match(config.text, /kind <> 'vst_entry_queue_telemetry'/);
      assert.doesNotMatch(config.text, /\b(?:INSERT|UPDATE|DELETE|ALTER)\b/);
      return { rows: [{
        queued: "0", queue_oldest_at: null, unresolved: "0", unresolved_oldest_at: null,
        unknown_intents: "0", review_positions: "0", unsent: "0", unsent_oldest_at: null,
        pending_source_exits: "0", source_exit_oldest_at: null,
      }] };
    },
  }, { clock: () => time });
  const [first, second] = await Promise.all([read(), read()]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.equal(first.values!.queued, 0);
  await read();
  assert.equal(calls, 1);
  time += 10_001;
  await read();
  assert.equal(calls, 2);
});

test("failed or malformed ledger aggregates never become synthetic healthy zeroes", async () => {
  const failed = createLedgerHealthReader({
    query: async () => { throw new Error("private database details"); },
  });
  assert.deepEqual(await failed(), { checkedAt: null, values: null });
  const malformed = createLedgerHealthReader({ query: async () => ({ rows: [{
    queued: 1, queue_oldest_at: null, unresolved: 0,
    unknown_intents: 0, review_positions: 0, unsent: 0,
    pending_source_exits: 0, source_exit_oldest_at: null,
  }] }) });
  assert.equal((await malformed()).values, null);
});