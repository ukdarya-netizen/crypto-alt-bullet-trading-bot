import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchBulletPositions } from "../source-position-sync.mjs";
import { createSourceLifecycleScheduler } from "../source-lifecycle-scheduler.mjs";
import { buildSourceControl, applySourceProtection } from "../source-position-control.mjs";
import { buildSourceExitEvidence } from "../source-exit-evidence.mjs";
import { auditExchangeSourcePositions } from "../source-exchange-audit.mjs";

const at = "2026-10-25T11:12:53.817Z";
const now = Date.parse(at);
const entryAt = "2026-10-25T09:00:00.000Z";
// Synthetic identities/prices; null + unknown reproduces the exact observed
// producer pair. No production response bodies or credentials are fixtures.
function row(id, overrides = {}) {
  return {
    sourceSignalId: String(id), symbol: "ETHUSDT", signalAt: entryAt,
    botEnqueuedAt: null, initialStopPrice: 90,
    sourceStatus: "active", sourceAction: "hold", sourceUpdatedAt: at,
    sourceClosedAt: null, sourceEntryPrice: 100, sourceExitPrice: null,
    sourcePnlPercent: null, sourcePeakPrice: null, sourceStopLossPrice: 90,
    sourceTrailingStopLevel: null, sourceLastMilestone: null, sourceCancelReason: null,
    ...overrides,
  };
}
const unknown = id => row(id, { sourceStatus: null, sourceAction: "unknown" });
const closed = id => row(id, {
  sourceStatus: "profit", sourceAction: "close", sourceClosedAt: at,
});
const read = (positions, options = {}) => fetchBulletPositions({
  token: "fixture-token", requireSourceAction: true, clock: () => now,
  fetchImpl: async () => ({ ok: true, json: async () => ({
    asOf: at, nextAfterId: null, positions,
  }) }), ...options,
});
const flush = () => new Promise(resolve => setImmediate(resolve));

test("three null/unknown cards on page 3 retain a complete stable 443-card snapshot and independent exits", async () => {
  const rows = Array.from({ length: 443 }, (_, i) => row(i + 1));
  rows[400] = unknown(401);
  rows[401] = unknown(402);
  rows[402] = unknown(403);
  rows[403] = closed(404);
  rows[404] = row(405, { sourceAction: "review", sourceStatus: "cancelled" });
  let calls = 0;
  let paper;
  let vst;
  let applied;
  let audited;
  let wakes = 0;
  const scheduler = createSourceLifecycleScheduler({
    now: () => now,
    fetchSnapshot: () => read([], {
      fetchImpl: async url => {
        calls++;
        const start = Number(url.searchParams.get("afterId") ?? 0);
        const end = Math.min(start + 200, rows.length);
        return { ok: true, json: async () => ({
          asOf: new Date(now + calls).toISOString(),
          nextAfterId: end === rows.length ? null : end,
          positions: rows.slice(start, end),
        }) };
      },
    }),
    queuePaperExits: async snapshot => {
      paper = snapshot;
      return { queued: [], refreshed: [], rejected: [] };
    },
    queueVstExits: async snapshot => {
      vst = snapshot;
      return { queued: [{ sourceSignalId: "404" }], refreshed: [], rejected: [] };
    },
    applyPaperSnapshot: async snapshot => { applied = snapshot; return []; },
    auditSnapshot: async snapshot => { audited = snapshot; },
    wakeVst: () => wakes++,
  });
  try {
    const result = await scheduler.pollNow();
    await flush();
    assert.equal(result.kind, "ok");
    assert.equal(calls, 6, "all three pages are confirmed in a second full sweep");
    assert.equal(result.recordCount, 443);
    assert.deepEqual(result.sourceActions, { hold: 438, close: 1, review: 1, unknown: 3, missingAction: 0 });
    for (const snapshot of [paper, vst]) {
      assert.deepEqual([...snapshot.positions.keys()], ["404", "405"]);
      assert.equal(snapshot.allPositions.size, 443);
      assert.equal(snapshot.allPositions.get("401").sourceStatus, null);
    }
    assert.equal(applied.positions.size, 443);
    assert.equal(audited.positions.size, 443);
    assert.equal(wakes, 1);
  } finally { scheduler.stop(); }
});

test("nullable status exception requires exactly an explicit unknown action", async () => {
  for (const sourceAction of ["hold", "close", "review", undefined, null, "other"]) {
    const record = row(1, { sourceStatus: null, sourceAction, sourceClosedAt: at });
    if (sourceAction === undefined) delete record.sourceAction;
    await assert.rejects(read([record]), error => error.code === "invalid_source_status");
  }
  for (const sourceStatus of ["", "new-producer-status", 0, {}, ["active"]]) {
    await assert.rejects(read([row(1, { sourceStatus, sourceAction: "unknown" })]),
      error => error.code === "invalid_source_status");
  }
  const missing = unknown(1);
  delete missing.sourceStatus;
  await assert.rejects(read([missing]), error => error.code === "invalid_response");
  assert.equal((await read([unknown(1)])).positions.get("1").sourceStatus, null);
  assert.equal((await read([row(1, { sourceStatus: "unknown", sourceAction: "unknown" })]))
    .positions.get("1").sourceStatus, "unknown");
});

test("null/unknown with apparent close or stop fields never authorizes an exit or protection change", async () => {
  const record = unknown(1);
  record.sourceClosedAt = at;
  record.sourceExitPrice = 120;
  record.sourceTrailingStopLevel = 115;
  record.sourceLastMilestone = 10;
  const snapshot = await read([record]);
  const local = { sourceSignalId: "1", symbol: "ETHUSDT", entryAt,
    entryPrice: 100, stopPrice: 90, coreQty: 1, coreOpen: true, remainingQty: 1 };
  const source = snapshot.positions.get("1");
  assert.equal(buildSourceExitEvidence(source, { ...local, asOf: at, observedAt: at }), null);
  const control = buildSourceControl(source, local, { asOf: at, observedAt: at });
  assert.equal(control.sourceStatus, null);
  assert.equal(control.sourceAction, "unknown");
  const plan = { next: { ...local }, actions: [] };
  assert.deepEqual(applySourceProtection(plan, local, control, 110), plan);
  const audit = await auditExchangeSourcePositions({
    pool: { query: async sql => ({ rows: sql.includes("FROM vst_positions") ? [
      { source_signal_id: "1", symbol: "ETHUSDT", status: "open" },
      { source_signal_id: "absent", symbol: "ETHUSDT", status: "open" },
    ] : [{ signal_id: "1", symbol: "ETHUSDT", status: "open" }] }) },
    ...snapshot, observedAt: at,
  });
  assert.equal(audit.mode, "read_only");
  assert.equal(audit.discrepancies.length, 3);
  assert.ok(audit.discrepancies.every(item => item.verification === "unverified"));
  assert.ok(audit.discrepancies.some(item => item.kind === "source_missing"));
  assert.equal(audit.discrepancies.filter(item => item.kind === "source_action_unknown").length, 2);
  assert.equal(buildSourceExitEvidence(undefined, { ...local, asOf: at, observedAt: at }), null);
});

test("later-page failures or unstable null status never dispatch even an earlier confirmed close", async () => {
  for (const failure of ["http", "body", "envelope", "duplicate", "stale", "changed-status", "changed-action"]) {
    let calls = 0;
    let consumers = 0;
    const scheduler = createSourceLifecycleScheduler({
      now: () => now,
      fetchSnapshot: () => read([], {
        fetchImpl: async url => {
          calls++;
          const last = url.searchParams.has("afterId");
          if (last && failure === "http") return { ok: false, status: 500 };
          if (last && failure === "body") return { ok: true, json: async () => { throw new Error("bad JSON"); } };
          if (last && failure === "envelope") return { ok: true, json: async () => ({ positions: [] }) };
          const record = last ? unknown(2) : closed(1);
          if (last && failure === "duplicate") record.sourceSignalId = "1";
          if (calls === 4 && failure === "changed-status") record.sourceStatus = "unknown";
          if (calls === 4 && failure === "changed-action") {
            record.sourceStatus = "active";
            record.sourceAction = "hold";
          }
          return { ok: true, json: async () => ({
            asOf: new Date(now + calls - (last && failure === "stale" ? 360_000 : 0)).toISOString(),
            nextAfterId: last ? null : 1, positions: [record],
          }) };
        },
      }),
      queuePaperExits: async () => { consumers++; },
      queueVstExits: async () => { consumers++; },
      applyPaperSnapshot: async () => { consumers++; return []; },
      auditSnapshot: async () => { consumers++; },
      wakeVst: () => { consumers++; },
    });
    try {
      const result = await scheduler.pollNow();
      await flush();
      assert.equal(result.kind, "error", failure);
      assert.equal(consumers, 0, failure);
    } finally { scheduler.stop(); }
  }
});
