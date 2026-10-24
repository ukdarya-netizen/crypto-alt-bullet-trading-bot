import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createVstStore } from "../vst-store.mjs";
import {
  VST_UNCERTAINTY_OPERATIONS, classifyVstUncertainty, nextUncertaintyRead,
  protectedDegradedMarker, reconcileVstUncertaintyEvidence,
} from "../vst-uncertainty.mjs";
import { strictUncertaintyPool } from "./fixtures/strict-uncertainty-pool.mjs";
import { nativeDegradedBroker } from "./fixtures/native-degraded-broker.mjs";

const actual = JSON.parse(readFileSync(new URL("./fixtures/btw-pre-protocol-unknown.json", import.meta.url)));
const now = Date.parse(actual.position.updatedAt) + 60_000;
function degradedArgs(f = actual, observed = now) {
  const stop = f.position.snapshot.verifiedProtectiveStops.core;
  const protection = {
    orderId: stop.orderId, positionId: stop.positionId,
    quantity: String(stop.quantity), stopPrice: String(stop.stopPrice),
    status: "NEW", workingType: "MARK_PRICE",
  };
  const position = {
    ...structuredClone(f.position.snapshot), status: "open",
    stopPrice: Number(stop.stopPrice), coreStopPrice: Number(stop.stopPrice),
    coreStopQuantity: String(stop.quantity),
    verifiedProtectiveStops: { ...f.position.snapshot.verifiedProtectiveStops,
      core: { ...stop, tranche: "core", quantity: String(stop.quantity) } },
    protectionDegradation: protectedDegradedMarker(f.intent, protection, observed),
  };
  return {
    sourceSignalId: f.intent.sourceSignalId, clientOrderId: f.intent.clientOrderId,
    phase: f.intent.phase, expectedRequest: f.intent.request,
    expectedOutcome: f.intent.outcome, expectedPositionSnapshot: f.position.snapshot,
    expectedPositionUpdatedAt: f.position.updatedAt,
    expectedEntryIntent: f.entryIntent, entryProof: f.intent.request.entryProof,
    currentProtection: protection, position, protectedDegraded: true,
    requestStartedAtMs: observed, maxEvidenceAgeMs: 5_000, clock: () => observed,
    eventDetail: { originalWriteAttributed: false,
      requestedStopPrice: f.intent.request.stopPrice, verifiedStopPrice: stop.stopPrice },
  };
}

test("actual pre-protocol BTW persists a degraded floor atomically, never successful execution", async () => {
  const { state, pool } = strictUncertaintyPool(actual);
  const store = createVstStore(pool);
  const input = degradedArgs();
  assert.equal((await store.adoptUnlinkedRaiseStopProtection(input)).kind, "recovered");
  assert.equal(state.intent.state, "failed");
  assert.equal(state.intent.exchangeOrderId, null);
  assert.equal(state.intent.outcome.reason, "raise_stop_protected_degraded");
  assert.equal(state.intent.outcome.originalExecution, "unknown_unproven");
  assert.deepEqual(state.intent.outcome.originalOutcome, actual.intent.outcome);
  assert.deepEqual(state.intent.request, actual.intent.request);
  assert.equal(state.position.snapshot.coreStopOrderId, actual.position.snapshot.coreStopOrderId);
  assert.equal(state.position.snapshot.stopPrice, 1.0486);
  assert.equal(state.position.snapshot.protectionDegradation.requestedStopPrice, "1.0534");
  assert.equal(state.events[0].kind, "vst_stop_protection_degraded");
  // A fresh store simulates a cold restart, not a cached in-process success.
  assert.equal((await createVstStore(pool).adoptUnlinkedRaiseStopProtection(input)).kind, "ineligible");
  assert.equal(state.events.length, 1);
});

test("degraded retirement refuses stale evidence, changed IDs/quantity and competing intents", async t => {
  for (const [name, options, mutate] of [
    ["stale evidence", {}, a => { a.clock = () => now + 5_001; }],
    ["position CAS changed", { positionChanged: true }, () => {}],
    ["concurrent same-position intent", { competing: true }, () => {}],
    ["partial floor", {}, a => { a.currentProtection.quantity = "9050"; }],
    ["changed floor identity", {}, a => { a.currentProtection.orderId = "2106661697317593089"; }],
    ["requested price fabricated as installed", {}, a => { a.currentProtection.stopPrice = "1.0534"; }],
    ["unknown marker version cannot authorize writes", {}, a => { a.position.protectionDegradation.version = 2; }],
  ]) await t.test(name, async () => {
    const { state, pool } = strictUncertaintyPool(actual, options);
    const a = degradedArgs(); mutate(a);
    assert.equal((await createVstStore(pool).adoptUnlinkedRaiseStopProtection(a)).kind, "ineligible");
    assert.equal(state.intent.state, "unknown");
    assert.equal(state.events.length, 0);
  });
});

test("two competing retirement attempts commit only once under row locks", async () => {
  const { state, pool } = strictUncertaintyPool(actual);
  const results = await Promise.all([
    createVstStore(pool).adoptUnlinkedRaiseStopProtection(degradedArgs()),
    createVstStore(pool).adoptUnlinkedRaiseStopProtection(degradedArgs()),
  ]);
  assert.deepEqual(results.map(r => r.kind).sort(), ["ineligible", "recovered"]);
  assert.equal(state.events.length, 1);
});

test("a changed position during commit rolls back retirement and notification", async () => {
  const { state, pool } = strictUncertaintyPool(actual, {
    commitDelay: s => { s.position.snapshot.remainingQty = 0; },
  });
  await assert.rejects(createVstStore(pool).adoptUnlinkedRaiseStopProtection(degradedArgs()),
    /compare-and-set failed/);
  assert.equal(state.intent.state, "unknown");
  assert.equal(state.position.snapshot.remainingQty, 9051);
  assert.equal(state.events.length, 0);
});

test("all six adapters retain IDs and execute only paced read proofs across restart/outage", async t => {
  for (const operation of VST_UNCERTAINTY_OPERATIONS) await t.test(operation, async () => {
    const f = structuredClone(actual);
    f.intent.request.operation = operation === "source_exit" ? "close_leg" : operation;
    if (operation === "source_exit") f.intent.request.sourceExit = { requestId: "source-decision", evidence: { outcome: "closed" } };
    f.intent.exchangeOrderId = "2106661697317593000";
    f.intent.outcome = { error: "BingXLiveApiError", errorMessage: "original POST response lost" };
    const { state, pool } = strictUncertaintyPool(f);
    let at = now, reads = 0;
    const adapters = Object.fromEntries(VST_UNCERTAINTY_OPERATIONS.map(op => [op, async input => {
      reads++;
      assert.equal(op, operation);
      assert.equal(input.exchangeOrderId, f.intent.exchangeOrderId);
      assert.deepEqual(input.request, f.intent.request);
      throw new Error("GET read outage");
    }]));
    for (let attempt = 0; attempt < 5; attempt++) {
      const store = createVstStore(pool);
      const previous = structuredClone(state.intent);
      const claimed = await store.claimUncertaintyRead(previous, at);
      assert.ok(claimed);
      await assert.rejects(reconcileVstUncertaintyEvidence(claimed, adapters), /read outage/);
      const blocked = await createVstStore(pool).claimUncertaintyRead(structuredClone(state.intent), at + 1);
      assert.equal(blocked, null);
      assert.equal(state.intent.state, "unknown");
      assert.equal(state.intent.exchangeOrderId, f.intent.exchangeOrderId);
      assert.deepEqual(state.intent.outcome.originalSubmissionOutcome, f.intent.outcome);
      const report = classifyVstUncertainty(state.intent, "read_refused");
      assert.equal(report.mutationAttribution, "unknown_potentially_sent");
      assert.equal(report.writeRetryAuthorized, false);
      assert.equal(report.automaticOwnerApprovalRequired, false);
      assert.equal(report.currentReadRefusal, "read_refused");
      at = state.intent.outcome.uncertaintyRead.nextReadAt;
    }
    assert.equal(reads, 5);
    assert.equal(state.intent.outcome.uncertaintyRead.totalAttempts, 5);
    assert.equal(state.events.length, 0);
  });
});

test("all six operations reject changed request/state/ID and racing read claims", async t => {
  for (const operation of VST_UNCERTAINTY_OPERATIONS) await t.test(operation, async () => {
    const f = structuredClone(actual);
    f.intent.request.operation = operation === "source_exit" ? "close_leg" : operation;
    if (operation === "source_exit") f.intent.request.sourceExit = { requestId: "immutable-source-decision" };
    const { state, pool } = strictUncertaintyPool(f);
    const previous = structuredClone(state.intent);
    const changed = structuredClone(previous);
    changed.request.quantity = "9000";
    assert.equal(await createVstStore(pool).claimUncertaintyRead(changed, now), null);
    changed.request = previous.request;
    changed.exchangeOrderId = "2106661697317593000";
    assert.equal(await createVstStore(pool).claimUncertaintyRead(changed, now), null);
    changed.exchangeOrderId = previous.exchangeOrderId;
    changed.state = "submitted";
    assert.equal(await createVstStore(pool).claimUncertaintyRead(changed, now), null);
    const result = await Promise.all([
      createVstStore(pool).claimUncertaintyRead(previous, now),
      createVstStore(pool).claimUncertaintyRead(previous, now),
    ]);
    assert.equal(result.filter(Boolean).length, 1);
    assert.equal(state.intent.outcome.uncertaintyRead.totalAttempts, 1);
    assert.equal(state.intent.state, "unknown");
    assert.equal(state.events.length, 0);
  });
});

test("finite budget exhaustion and missing aliases never become no-send evidence", () => {
  const i = structuredClone(actual.intent);
  let at = now;
  for (let n = 0; n < 4; n++) {
    i.outcome.uncertaintyRead = nextUncertaintyRead(i, at);
    at = i.outcome.uncertaintyRead.nextReadAt;
  }
  assert.equal(i.outcome.uncertaintyRead.budgetExhausted, true);
  assert.equal(classifyVstUncertainty(i).mutationAttribution, "unknown_potentially_sent");
  assert.equal(classifyVstUncertainty(i).writeRetryAuthorized, false);
  assert.equal(classifyVstUncertainty({ request: { operation: "unreviewed" } }).automaticOwnerApprovalRequired, true);
});

test("prepared margin addition has one durable claimant and no restart/outage resubmission", async () => {
  const f = structuredClone(actual);
  f.intent.phase = "margin-top-up";
  f.intent.state = "prepared";
  f.intent.request.operation = "margin_top_up";
  const { state, pool } = strictUncertaintyPool(f);
  const claims = await Promise.all([
    createVstStore(pool).claimPreparedMarginAddition(f.intent),
    createVstStore(pool).claimPreparedMarginAddition(f.intent),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(state.intent.state, "submitted");
  assert.equal(await createVstStore(pool).claimPreparedMarginAddition(f.intent), false);
  state.intent.state = "unknown";
  assert.equal(await createVstStore(pool).claimPreparedMarginAddition(f.intent), false);
  assert.equal(state.events.length, 0);
});

test("native BTW protection proof independently verifies entry/fills, exact stop and two current cohorts", async () => {
  const f = nativeDegradedBroker(actual, now);
  const result = await f.broker.verifyProtectedDegradedRaiseStop({ request: f.request });
  assert.equal(result.verified, true);
  assert.equal(result.status, "protected_degraded");
  assert.equal(result.protectiveStops.core.orderId, actual.position.snapshot.coreStopOrderId);
  assert.equal(result.protectiveStops.core.stopPrice, "1.0486");
  assert.equal(result.currentProtectionOnly, true);
  assert.ok(f.state.calls.includes("queryFills"));
  assert.ok(f.state.calls.filter(c => c === "getPositions").length >= 2);
  assert.ok(f.state.calls.filter(c => c === "getOpenOrders").length >= 2);
  assert.equal(f.state.mutations, 0);
});

test("native degraded proof refuses outage and changed/fill/stale/foreign evidence without a write", async t => {
  const mutations = [
    ["read outage", f => { f.state.readOutage = true; }],
    ["entry belongs to someone else", f => { f.entry.clientOrderId = "foreign"; }],
    ["position identity alias conflict", f => { f.state.position.positionID = "2106641464919326722"; }],
    ["stop identity alias conflict", f => { f.state.stop.orderID = "2106661697317593089"; }],
    ["stop position alias conflict", f => { f.state.stop.positionID = "2106641464919326722"; }],
    ["wrong side", f => { f.state.position.positionSide = "SHORT"; }],
    ["partial position", f => { f.state.position.positionAmt = "9000"; }],
    ["partial coverage", f => { f.state.stop.origQty = "9000"; }],
    ["floor filled", f => { f.state.stop.executedQty = "1"; }],
    ["hidden execution alias", f => { f.state.stop.filledQty = "1"; }],
    ["parent stop echo only", f => { f.state.orders = []; }],
    ["unexpected extra stop", f => { f.state.orders = [f.state.stop, { ...f.state.stop, orderId: "2106661697317593089" }]; }],
    ["weaker floor", f => { f.state.stop.stopPrice = "1.0400"; }],
    ["quantity changes after first cohort", f => {
      let passes = 0;
      f.state.onRead = (name, s) => { if (name === "getPositions" && ++passes === 2) s.position.positionAmt = "9000"; };
    }],
    ["history proof exceeds budget", f => {
      f.state.onRead = (name, s) => { if (name === "queryFills") s.now += 30_001; };
    }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    const f = nativeDegradedBroker(actual, now);
    mutate(f);
    assert.equal((await f.broker.verifyProtectedDegradedRaiseStop({ request: f.request })).verified, false);
    assert.equal(f.state.mutations, 0);
  });
});

test("zero positionID from the lookup needs an independently linked exact native open stop", async () => {
  const f = nativeDegradedBroker(actual, now);
  const query = f.api.queryOrder;
  f.api.queryOrder = async (...args) => {
    const result = await query(...args);
    return result?.orderId === f.state.stop.orderId ? { ...result, positionId: "0" } : result;
  };
  assert.equal((await f.broker.verifyProtectedDegradedRaiseStop({ request: f.request })).verified, true);
  f.state.stop.positionId = "0";
  assert.equal((await f.broker.verifyProtectedDegradedRaiseStop({ request: f.request })).verified, false);
  assert.equal(f.state.mutations, 0);
});