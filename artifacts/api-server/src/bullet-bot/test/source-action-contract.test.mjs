import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSourceExitEvidence } from "../source-exit-evidence.mjs";
import { fetchBulletPositions } from "../source-position-sync.mjs";
import { buildSourceControl, applySourceProtection, createSourceControlStore } from "../source-position-control.mjs";
import { createSourceLifecycleScheduler } from "../source-lifecycle-scheduler.mjs";
import { auditExchangeSourcePositions } from "../source-exchange-audit.mjs";

const at = "2026-10-05T03:30:00.000Z";
const entryAt = "2026-10-05T02:30:00.000Z";
const now = Date.parse(at);
function source(overrides = {}) {
  return { sourceSignalId: "cab-signal-1", symbol: "ETHUSDT", signalAt: entryAt,
    botEnqueuedAt: null, initialStopPrice: 90, sourceAction: "hold", sourceStatus: "active",
    sourceUpdatedAt: at, sourceClosedAt: null, sourceEntryPrice: 100, sourceExitPrice: null,
    sourcePnlPercent: null, sourcePeakPrice: null, sourceStopLossPrice: 90,
    sourceTrailingStopLevel: null, sourceLastMilestone: null, sourceCancelReason: null, ...overrides };
}
function evidence(row) {
  return buildSourceExitEvidence(row, { sourceSignalId: "cab-signal-1", symbol: "ETHUSDT",
    entryAt, asOf: at, observedAt: at });
}
function position(overrides = {}) {
  return { sourceSignalId: "cab-signal-1", symbol: "ETHUSDT", entryPrice: 100,
    coreOpen: true, runnerOpen: false, coreQty: 8, runnerQty: 0,
    remainingQty: 8, status: "open", stopPrice: 90, ...overrides };
}
function plan(state) { return { next: { ...state, observedAt: at }, actions: [] }; }
function control(row = source()) { return buildSourceControl(row, position(), { asOf: at, observedAt: at }); }

for (const status of ["profit", "stop_loss", "bu_stop", "breakeven", "expired"]) {
  test(`explicit close admits ${status} with close time, without an invented source fill`, () => {
    const proof = evidence(source({ sourceAction: "close", sourceStatus: status, sourceClosedAt: at }));
    assert.equal(proof.sourceAction, "close");
    assert.equal(proof.reason, "source_closed");
    assert.equal(proof.sourceExitPrice, null);
    assert.equal(proof.exitDecisionAt, at);
  });
}
test("non-cancellation review, hold, unknown, missing time, wrong ID and stale snapshots never authorize a close", () => {
  for (const row of [
    source({ sourceAction: "review", sourceStatus: "reclassified" }),
    source({ sourceAction: "hold" }), source({ sourceAction: "unknown" }),
    source({ sourceAction: "close", sourceStatus: "profit" }),
    source({ sourceAction: "close", sourceStatus: "profit", sourceClosedAt: at, sourceSignalId: "other" }),
  ]) assert.equal(evidence(row), null);
  assert.equal(buildSourceExitEvidence(source({ sourceAction: "close", sourceStatus: "profit", sourceClosedAt: at }),
    { sourceSignalId: "cab-signal-1", symbol: "ETHUSDT", entryAt, asOf: at, observedAt: now + 60_001 }), null);
});
test("published strict reader rejects the old contract and accepts paginated explicit actions", async () => {
  let calls = 0;
  const read = row => fetchBulletPositions({ token: "fixture-token", requireSourceAction: true,
    clock: () => now, fetchImpl: async url => {
      calls++;
      const second = new URL(url).searchParams.has("afterId");
      return { ok: true, json: async () => ({ asOf: at,
        nextAfterId: second ? null : "1",
        positions: [{ ...row, sourceSignalId: second ? "cab-signal-2" : "cab-signal-1" }] }) };
    } });
  const legacy = source(); delete legacy.sourceAction;
  await assert.rejects(read(legacy), error => error.code === "source_action_contract_not_published");
  calls = 0;
  const snapshot = await read(source());
  assert.equal(snapshot.positions.size, 2);
  assert.equal(calls, 2);
  assert.equal(snapshot.positions.get("cab-signal-2").sourceAction, "hold");
});
test("review can carry a neutral cancelled row without closure fields; inconsistent actions fail", async () => {
  const read = row => fetchBulletPositions({ token: "fixture-token", requireSourceAction: true,
    clock: () => now, fetchImpl: async () => ({ ok: true,
      json: async () => ({ asOf: at, nextAfterId: null, positions: [row] }) }) });
  assert.equal((await read(source({ sourceAction: "review", sourceStatus: "cancelled" }))).positions.size, 1);
  await assert.rejects(read(source({ sourceAction: "close", sourceStatus: "cancelled", sourceClosedAt: at })),
    error => error.code === "invalid_source_action");
});
test("source milestones place breakeven at the bot fill, then raise to the source price without lowering protection", () => {
  const state = position({ entryPrice: 101 });
  const breakEven = applySourceProtection(plan(state), state,
    control(source({ sourceLastMilestone: 5 })), 120);
  assert.equal(breakEven.actions[0].stopPrice, 101);
  const trailing = applySourceProtection(plan(state), state,
    control(source({ sourceTrailingStopLevel: 112 })), 120);
  assert.equal(trailing.actions[0].stopPrice, 112);
  assert.equal(trailing.actions[0].sourceProtection.requestedStopPrice, 112);
  const protectedState = position({ stopPrice: 115 });
  assert.equal(applySourceProtection(plan(protectedState), protectedState,
    control(source({ sourceTrailingStopLevel: 112 })), 120).actions.length, 0);
});
test("a crossed source floor exits at the observed price, not at the source stop", () => {
  const state = position();
  const result = applySourceProtection(plan(state), state,
    control(source({ sourceTrailingStopLevel: 112 })), 110);
  assert.equal(result.actions[0].type, "close_core");
  assert.equal(result.actions[0].price, 110);
  assert.equal(result.actions[0].quantity, 8);
  assert.equal(result.next.remainingQty, 0);
  assert.equal(result.next.stopPrice, 90);
  assert.equal(result.next.status, "closed");
});
test("source protection covers both open legs but cannot recreate a closed leg", () => {
  const state = position({ runnerOpen: true, runnerQty: 2, remainingQty: 10, runnerStopPrice: 100 });
  const result = applySourceProtection(plan(state), state,
    control(source({ sourceTrailingStopLevel: 112 })), 120);
  assert.deepEqual(result.actions.map(action => action.leg), ["core", "runner"]);
  const sole = position({ coreOpen: false, coreQty: 0, runnerOpen: true, runnerQty: 2,
    runnerStopPrice: 100, remainingQty: 2 });
  assert.deepEqual(applySourceProtection(plan(sole), sole,
    control(source({ sourceTrailingStopLevel: 112 })), 120).actions.map(action => action.leg), ["runner"]);
});
test("review, unknown and wrong identity cannot raise or close from a source floor", () => {
  const state = position();
  for (const observed of [
    { ...control(), sourceAction: "review", sourceTrailingStopLevel: 120 },
    { ...control(), sourceAction: "unknown", sourceTrailingStopLevel: 120 },
    { ...control(), sourceSignalId: "foreign", sourceTrailingStopLevel: 120 },
  ]) assert.deepEqual(applySourceProtection(plan(state), state, observed, 100), plan(state));
  assert.equal(control(null).sourceAction, "unknown");
});
test("control persistence is ID-scoped, keeps actual source levels and isolates a conflicting identity", async () => {
  let saved = { id: 1, detail: { ...control(), sourceTrailingStopLevel: 115, sourceLastMilestone: 10 } };
  const commands = [];
  const client = {
    release() {},
    async query(sql, args) {
      commands.push(sql);
      if (sql.includes("SELECT p.source_signal_id")) return { rows: [{ source_signal_id: "cab-signal-1", symbol: "ETHUSDT" }] };
      if (sql.includes("SELECT id, detail")) return { rows: [saved] };
      if (sql.includes("UPDATE vst_events")) saved.detail = JSON.parse(args[1]);
      return { rows: [] };
    },
  };
  const store = createSourceControlStore({ connect: async () => client,
    query: async () => ({ rows: [saved] }) });
  await store.syncSourceControls({ positions: new Map([["cab-signal-1",
    source({ sourceTrailingStopLevel: 112, sourceLastMilestone: 5 })]]), asOf: at, observedAt: at });
  assert.equal((await store.getSourceControl("cab-signal-1")).sourceTrailingStopLevel, 112);
  assert.equal(saved.detail.sourceLastMilestone, 5);
  assert.ok(commands.includes("COMMIT"));
  commands.length = 0;
  const refusal = await store.syncSourceControls({ positions: new Map([["cab-signal-1",
    source({ symbol: "BTCUSDT" })]]), asOf: at, observedAt: at });
  assert.equal(refusal.refusals[0].reason, "source_control_identity_mismatch");
  assert.equal(saved.detail.sourceAction, "unknown");
  assert.equal(saved.detail.symbol, "ETHUSDT");
  assert.equal(saved.detail.sourceTrailingStopLevel, null);
  assert.ok(commands.includes("COMMIT"));
});
test("scheduler sends only explicit close to queues, keeps the full map for controls, and reports counts", async () => {
  const rows = new Map([
    ["cab-signal-1", source()],
    ["cab-signal-2", source({ sourceSignalId: "cab-signal-2", sourceAction: "review", sourceStatus: "reclassified" })],
    ["cab-signal-3", source({ sourceSignalId: "cab-signal-3", sourceAction: "close", sourceStatus: "profit", sourceClosedAt: at })],
  ]);
  let queued;
  let metric;
  const scheduler = createSourceLifecycleScheduler({
    fetchSnapshot: async () => ({ asOf: at, positions: rows }),
    queueVstExits: async snapshot => { queued = snapshot; return { queued: [], refreshed: [], rejected: [] }; },
    now: () => now, onPollEnd: result => { metric = result; },
  });
  await scheduler.pollNow();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual([...queued.positions.keys()], ["cab-signal-3"]);
  assert.equal(queued.allPositions.size, 3);
  assert.equal(metric.recordCount, 3);
  assert.equal(metric.sourceActions.close, 1);
  scheduler.stop();
});
test("audit marks neutral review and missing source, and identifies an old updated timestamp", async () => {
  const pool = { query: async sql => ({ rows: sql.includes("FROM vst_positions")
    ? [{ source_signal_id: "cab-signal-1", symbol: "ETHUSDT", status: "open" },
       { source_signal_id: "missing", symbol: "BTCUSDT", status: "open" }] : [] }) };
  const result = await auditExchangeSourcePositions({ pool,
    positions: new Map([["cab-signal-1", source({ sourceAction: "review", sourceStatus: "cancelled",
      sourceUpdatedAt: entryAt, sourceClosedAt: at, sourceExitPrice: 120 })]]) });
  assert.ok(result.discrepancies.some(item => item.kind === "source_action_review"));
  assert.ok(result.observations.some(item => item.kind === "source_record_update_age"));
  assert.ok(result.observations.every(item => item.verification === "informational"));
  assert.equal(result.discrepancies.some(item => item.kind === "source_updated_at_stale"), false);
  assert.ok(result.discrepancies.some(item => item.kind === "source_missing"));
  assert.equal(result.discrepancies.some(item => item.kind === "source_closed_while_local_active"), false);
});