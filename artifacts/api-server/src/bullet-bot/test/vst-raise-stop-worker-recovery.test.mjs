import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readFileSync } from "node:fs";
import { strictUncertaintyPool } from "./fixtures/strict-uncertainty-pool.mjs";
import { nativeDegradedBroker } from "./fixtures/native-degraded-broker.mjs";
import { createVstPolicy, VST_POLICY_VERSION } from "../vst-policy.mjs";
import { compareExactDecimals } from "../vst-exact-decimal.mjs";
import { createVstStore } from "../vst-store.mjs";
import {
  createVstWorker,
  roundStopPriceUpToPrecision,
} from "../vst-worker.mjs";

const accountId = "raise-stop-worker-account";
const sourceSignalId = "raise-stop-worker-signal";
const symbol = "ETHUSDT";
const positionId = "raise-stop-position";
const entryClientOrderId = "raise-stop-entry-client";
const entryOrderId = "raise-stop-entry-native";
const stopClientOrderId = "raise-stop-client";
const stopOrderId = "987654321";
const phase = "raise-stop-core-recovery";
const now = Date.parse("2026-05-01T12:00:00.000Z");
const entryIntentAt = now - 60_000;
const entryAt = new Date(entryIntentAt + 1_000).toISOString();
const updatedAt = new Date(now - 10_000).toISOString();

test("raise-stop tick normalization collapses binary residue but retains a real higher tick", () => {
  const equalTick = roundStopPriceUpToPrecision(
    0.49150000000000005, 4, "test stop price",
  );
  const higherTick = roundStopPriceUpToPrecision(
    0.49160000000000004, 4, "test stop price",
  );
  assert.equal(equalTick, "0.4915");
  assert.equal(compareExactDecimals(equalTick, "0.4915"), 0);
  assert.equal(higherTick, "0.4916");
  assert.equal(compareExactDecimals(higherTick, "0.4915"), 1);
  assert.equal(compareExactDecimals("0.4914", "0.4915"), -1);
});

function exitRules() {
  return {
    priceMoveBasis: "unleveraged_percent_from_actual_entry_fill",
    noFixedTakeProfit: true,
    rMultipleTargets: false,
    firstTargetAction: "milestone_not_full_close",
    firstTargetPct: 10,
    breakevenAtPct: 5,
    breakevenStopGainPct: 0,
    breakevenIncludesFees: false,
    protectedProfitAtPct: 10,
    protectedProfitPct: 5,
    trailingActivationPct: 15,
    trailingGapPercentagePoints: 10,
    trailingGapBasis: "percentage_points_of_entry_pnl",
    trailingStopNeverDecreases: true,
    trailingExitAction: "close_remaining_position",
    maxWatchDays: 4,
    expiryExitPrice: "observed_market_quote",
    partialProfitAdvice: {
      execution: "advice_only_not_automated",
      minFraction: 0.2,
      maxFraction: 0.25,
    },
  };
}

function createFixture({
  exchangeOrderId = stopOrderId,
  evidenceOrderId = stopOrderId,
  proofPositionId = positionId,
  entryFillQuantity = "0.1",
  concurrentClose = null,
  failFirstCommit = false,
  oldStopPrice = "95",
  targetStopPrice = "96",
  openPosition = false,
  outcome = { reason: "previous_raise_stop_write_requires_reconciliation" },
  intentPhase = phase,
  intentClientOrderId = stopClientOrderId,
  clock = () => now,
} = {}) {
  const signalAt = new Date(now - 120_000).toISOString();
  const signal = {
    sourceSignalId,
    confirmationStatus: "confirmed",
    patternStatus: "approved",
    patternId: "balanced_grind",
    side: "buy",
    orderType: "market",
    symbol,
    signalAt,
    stopLoss: 95,
    payload: { rulesVersion: VST_POLICY_VERSION, exitRules: exitRules() },
  };
  const policy = createVstPolicy({
    signal,
    fill: { price: 100, quantity: "0.1", at: entryAt },
  });
  const oldStop = {
    verified: true,
    tranche: "core",
    orderId: "raise-stop-original-native",
    positionId,
    quantity: "0.1",
    stopPrice: String(oldStopPrice),
  };
  const priorPosition = {
    ...policy,
    sourceSignalId,
    environment: "vst",
    accountId,
    entryClientOrderId,
    entryOrderId,
    entryOrderType: "MARKET",
    entryAt,
    exchangePositionId: positionId,
    coreStopOrderId: oldStop.orderId,
    coreStopPositionId: positionId,
    coreStopQuantity: "0.1",
    coreStopPrice: Number(oldStopPrice),
    verifiedProtectiveStops: { core: oldStop },
    signalSnapshot: signal,
    signalStopPrice: 95,
    actualEntryBreakEvenPrice: 100,
  };
  const nextPolicy = { ...priorPosition, stopPrice: Number(targetStopPrice) };
  const nextPosition = {
    ...priorPosition,
    ...nextPolicy,
    stopPrice: Number(targetStopPrice),
    status: "open",
  };
  const entryIntent = {
    sourceSignalId,
    phase: "market-entry",
    clientOrderId: entryClientOrderId,
    state: "reconciled",
    request: {
      operation: "entry",
      environment: "vst",
      accountId,
      symbol,
      entryOrderType: "MARKET",
      quantity: "0.1",
      intentCreatedAt: entryIntentAt,
    },
    exchangeOrderId: entryOrderId,
    outcome: {
      status: "filled",
      verified: true,
      fillQuantity: entryFillQuantity,
      positionId,
      price: "100",
    },
  };
  const entryProof = {
    entryClientOrderId,
    entryOrderId,
    positionId,
    entryOrderType: "MARKET",
    intentCreatedAt: entryIntentAt,
    quantity: "0.1",
  };
  const request = {
    operation: "raise_stop",
    sourceSignalId,
    symbol,
    environment: "vst",
    accountId,
    leg: "core",
    positionId,
    quantity: "0.1",
    previousQuantity: "0.1",
    stopPrice: String(targetStopPrice),
    entryClientOrderId,
    entryOrderId,
    entryAt,
    entryQuantity: "0.1",
    entryOrderType: "MARKET",
    entryProof,
    intentCreatedAt: now - 5_000,
    priorPosition,
    nextPolicy,
    nextPosition,
  };
  const intent = {
    sourceSignalId,
    phase: intentPhase,
    clientOrderId: intentClientOrderId,
    state: "unknown",
    request,
    exchangeOrderId,
    outcome,
  };
  const storedSnapshot = { ...priorPosition, status: openPosition ? "open" : "unknown" };
  const position = {
    sourceSignalId,
    symbol,
    status: openPosition ? "open" : "unknown",
    snapshot: storedSnapshot,
    updatedAt,
  };
  const state = {
    intents: [intent, entryIntent],
    position,
    signalStatus: "unknown",
    events: [],
    commitCalls: [],
    markCalls: [],
    beforeCommit: concurrentClose,
    failFirstCommit,
    reserveCalls: 0,
    markPrice: 100,
  };
  const store = {
    async withLeaderLock(callback) { return callback(); },
    async getPending() {
      return ["pending", "planning", "opening"].includes(state.signalStatus)
        ? { sourceSignalId, status: state.signalStatus }
        : null;
    },
    async reserveIntent(intent) {
      state.reserveCalls += 1;
      const row = { ...intent, state: "prepared", exchangeOrderId: null };
      state.intents.push(row);
      return { kind: "new", intent: row };
    },
    async retireExpiredUnstartedSignals() {},
    async listUnresolvedIntents() {
      return state.intents.filter((row) =>
        ["prepared", "submitted", "unknown"].includes(row.state));
    },
    async getIntent(signalId, phaseName) {
      return state.intents.find((row) =>
        row.sourceSignalId === signalId && row.phase === phaseName) ?? null;
    },
    async getPosition(signalId) {
      return signalId === sourceSignalId ? structuredClone(state.position) : null;
    },
    async recoverRaiseStopEqualPriceNoop(input) {
      state.equalPriceRecoveryCalls ??= [];
      state.equalPriceRecoveryCalls.push(input);
      if (state.position.status !== "open" ||
          state.position.updatedAt !== input.expectedPositionUpdatedAt ||
          JSON.stringify(state.position.snapshot) !==
            JSON.stringify(input.expectedPositionSnapshot)) {
        return { kind: "ineligible" };
      }
      const intent = state.intents.find((row) =>
        row.clientOrderId === input.clientOrderId);
      if (!intent || intent.state !== "unknown" ||
          intent.exchangeOrderId !== null ||
          JSON.stringify(intent.request) !== JSON.stringify(input.expectedRequest) ||
          JSON.stringify(intent.outcome) !== JSON.stringify(input.expectedOutcome)) {
        return { kind: "ineligible" };
      }
      intent.state = "failed";
      intent.outcome = { reason: "raise_stop_equal_price_noop_confirmed" };
      state.signalStatus = "open";
      state.events.push({ kind: "vst_raise_stop_equal_price_noop_confirmed" });
      return { kind: "recovered" };
    },
    async markIntent(clientOrderId, nextState, patch = {}) {
      state.markCalls.push({ clientOrderId, nextState, patch });
      const row = state.intents.find((item) => item.clientOrderId === clientOrderId);
      if (!row) throw new Error("missing intent");
      row.state = nextState;
      if (Object.hasOwn(patch, "exchangeOrderId") &&
          patch.exchangeOrderId !== null) {
        row.exchangeOrderId = patch.exchangeOrderId;
      }
      if (Object.hasOwn(patch, "outcome")) row.outcome = patch.outcome;
      return row;
    },
    async commitVerifiedIntent(commit) {
      state.commitCalls.push(commit);
      if (state.failFirstCommit) {
        state.failFirstCommit = false;
        throw new Error("simulated atomic transaction interruption");
      }
      if (state.beforeCommit) {
        const mutate = state.beforeCommit;
        state.beforeCommit = null;
        await mutate(state);
      }
      if (state.position.updatedAt !== commit.expectedPositionUpdatedAt ||
          state.position.status !== commit.expectedPositionSnapshot.status ||
          JSON.stringify(state.position.snapshot) !==
            JSON.stringify(commit.expectedPositionSnapshot)) {
        throw new Error("VST position changed before verified intent commit");
      }
      state.position = {
        sourceSignalId,
        symbol: commit.position.symbol,
        status: commit.position.status,
        snapshot: structuredClone(commit.position),
        updatedAt: new Date(now).toISOString(),
      };
      const row = state.intents.find((item) =>
        item.clientOrderId === commit.clientOrderId);
      row.state = "reconciled";
      row.exchangeOrderId = commit.exchangeOrderId;
      row.outcome = commit.outcome;
      state.signalStatus = commit.signalStatus;
      state.events.push({ kind: commit.eventKind, detail: commit.eventDetail });
      return { position: state.position, intent: row };
    },
    async setSignalStatus(_signalId, status) { state.signalStatus = status; },
    async upsertPosition(snapshot) {
      state.position = {
        sourceSignalId,
        symbol: snapshot.symbol,
        status: snapshot.status,
        snapshot: structuredClone(snapshot),
        updatedAt: new Date(now + state.commitCalls.length).toISOString(),
      };
    },
    async listOpenPositions() {
      return ["open", "closing", "unknown"].includes(state.position.status)
        ? [{
          sourceSignalId,
          status: state.position.status,
          snapshot: structuredClone(state.position.snapshot),
        }]
        : [];
    },
    async recordEvent(signalId, kind, detail) {
      state.events.push({ signalId, kind, detail });
    },
  };

  const calls = { reconcile: [], perform: 0 };
  const broker = {
    async getCapabilities() {
      return {
        verified: true,
        environment: "vst",
        accountId,
        features: [
          "vst_only",
          "complete_order_lookup",
          "guarded_long10_leverage_preparation",
          "atomic_protected_market_entry",
          "verified_core_stop_state",
          "verified_exact_full_position_close",
          "verified_position_state",
        ],
      };
    },
    async reconcileIntent(input) {
      calls.reconcile.push(input);
      const submittedStop = {
        verified: true,
        tranche: "core",
        orderId: evidenceOrderId,
        positionId: proofPositionId,
        quantity: "0.1",
        stopPrice: String(input.request?.stopPrice ?? "96"),
      };
      return {
        verified: true,
        status: "filled",
        exchangeOrderId: evidenceOrderId,
        position: {
          verified: true,
          symbol,
          side: "Buy",
          quantity: 0.1,
          leverage: 10,
          marginMode: "ISOLATED",
          positionId: proofPositionId,
          avgPrice: 100,
          protectiveStops: { core: submittedStop },
        },
        protectiveStops: { core: submittedStop },
      };
    },
    async readAccountState() {
      const activeStop = state.position.snapshot.verifiedProtectiveStops?.core ?? oldStop;
      return {
        verified: true,
        environment: "vst",
        accountId,
        positions: [{
          symbol,
          positionSide: "LONG",
          positionAmt: "0.1",
          positionId,
        }],
        openOrders: [{
          symbol,
          orderId: activeStop.orderId,
          type: "STOP_MARKET",
          status: "NEW",
          side: "SELL",
          positionSide: "LONG",
          positionId: activeStop.positionId,
          origQty: activeStop.quantity,
          stopPrice: String(activeStop.stopPrice),
          workingType: "MARK_PRICE",
          executedQty: "0",
        }],
      };
    },
    async verifyEntryOrderProof() {
      return {
        verified: true,
        status: "filled",
        exchangeOrderId: entryOrderId,
        positionId,
        fill: { quantity: "0.1" },
      };
    },
    async readPosition() {
      const activeStop = state.position.snapshot.verifiedProtectiveStops?.core ?? oldStop;
      return {
        verified: true,
        symbol,
        side: "Buy",
        quantity: 0.1,
        leverage: 10,
        marginMode: "ISOLATED",
        positionId,
        pricePrecision: 2,
        protectiveStops: { core: activeStop },
      };
    },
    async readMarketMark() {
      return { verified: true, price: state.markPrice, observedAt: now };
    },
    async readPlanningInputs() { return {}; },
    async performIntent() { calls.perform += 1; },
  };
  const worker = createVstWorker({
    store,
    broker,
    clock,
    sizingLimits: { environment: "vst" },
  });
  return { worker, store, broker, state, calls, priorPosition, request, oldStop };
}

function actualBtwRuntime({ nativeOutage = false, sourceExitsEnabled = false } = {}) {
  const saved = JSON.parse(readFileSync(new URL(
    "./fixtures/btw-pre-protocol-unknown.json", import.meta.url)));
  const at = Date.parse(saved.position.updatedAt) + 60_000;
  const { state, pool } = strictUncertaintyPool(saved);
  const realStore = createVstStore(pool);
  const native = nativeDegradedBroker(saved, at);
  native.state.readOutage = nativeOutage;
  const base = createFixture({ clock: () => native.state.now });
  base.store.getPosition = async id => id === state.position.sourceSignalId
    ? { ...structuredClone(state.position), symbol: saved.intent.request.symbol } : null;
  base.store.getIntent = async (id, phase) => id !== saved.intent.sourceSignalId ? null
    : phase === state.intent.phase ? structuredClone(state.intent)
      : phase === state.entry.phase ? structuredClone(state.entry)
        : structuredClone(base.state.intents.find(row =>
          row.sourceSignalId === id && row.phase === phase) ?? null);
  base.store.listUnresolvedIntents = async () =>
    ["prepared", "submitted", "unknown"].includes(state.intent.state)
      ? [structuredClone(state.intent)] : [];
  base.store.listOpenPositions = async () => state.position.status === "open"
    ? [{ ...structuredClone(state.position), symbol: saved.intent.request.symbol }] : [];
  base.store.getPending = async () => null;
  base.store.queueSourceExitRequests = async () => ({ queued: [], refreshed: [], rejected: [] });
  base.store.listPendingSourceExitRequests = async () =>
    state.sourceRequest?.state === "pending" ? [structuredClone(state.sourceRequest)] : [];
  base.store.hasPendingSourceExitRequest = async id =>
    state.sourceRequest?.state === "pending" && state.sourceRequest.sourceSignalId === id;
  base.store.finishSourceExitRequest = async (id, result) => {
    assert.equal(id, state.sourceRequest.requestId);
    state.sourceRequest.state = "finished";
    state.sourceRequest.result = structuredClone(result);
  };
  base.store.claimUncertaintyRead = realStore.claimUncertaintyRead;
  base.store.adoptUnlinkedRaiseStopProtection = realStore.adoptUnlinkedRaiseStopProtection;
  base.store.upsertPosition = async snapshot => {
    state.position.snapshot = structuredClone(snapshot);
    state.position.status = snapshot.status;
    state.position.updatedAt = new Date(native.state.now).toISOString();
  };
  base.store.setSignalStatus = async (_id, status) => { state.signalStatus = status; };
  base.store.markIntent = async (id, status, patch) => {
    assert.equal(id, state.intent.clientOrderId);
    state.intent.state = status;
    state.intent.outcome = { ...state.intent.outcome, ...patch.outcome };
  };
  const getCapabilities = base.broker.getCapabilities;
  base.broker.getCapabilities = async () => ({
    ...await getCapabilities(), accountId: saved.intent.request.accountId,
  });
  base.broker.verifyUnlinkedRaiseStopProtection = native.broker.verifyUnlinkedRaiseStopProtection;
  base.broker.verifyProtectedDegradedRaiseStop = native.broker.verifyProtectedDegradedRaiseStop;
  base.broker.verifyObservedDegradedProtection = native.broker.verifyObservedDegradedProtection;
  base.broker.reconcileIntent = async () => ({ verified: false, status: "unknown" });
  base.broker.readAccountState = async () => ({
    verified: true, environment: "vst", accountId: saved.intent.request.accountId,
    positions: [structuredClone(native.state.position)],
    openOrders: structuredClone(native.state.orders ??
      (native.state.stop.status === "NEW" ? [native.state.stop] : [])),
  });
  base.broker.readPosition = async () => ({
    verified: true, symbol: saved.intent.request.symbol, side: "Buy",
    quantity: 9051, leverage: 10, marginMode: "ISOLATED",
    positionId: saved.intent.request.positionId, pricePrecision: 4,
    protectiveStops: { core: structuredClone(state.position.snapshot.verifiedProtectiveStops.core) },
  });
  base.broker.readMarketMark = async () => ({
    verified: true, price: 1.25, observedAt: native.state.now,
  });
  const restart = () => createVstWorker({
    store: base.store, broker: base.broker, clock: () => native.state.now,
    sizingLimits: { environment: "vst" }, sourceExitsEnabled,
  });
  return { worker: restart(), restart, state, native, base, saved };
}

test("actual persisted BTW runtime retires waiting under native proof and strict SQL CAS", async () => {
  const f = actualBtwRuntime();
  await f.worker.runOnce();
  assert.equal(f.state.intent.state, "failed");
  assert.equal(f.state.intent.outcome.reason, "raise_stop_protected_degraded");
  assert.equal(f.state.position.snapshot.protectionDegradation.requestedStopPrice, "1.0534");
  assert.equal(f.state.position.snapshot.stopPrice, 1.0486);
  assert.equal(f.state.events[0].kind, "vst_stop_protection_degraded");
  assert.equal(f.native.state.mutations, 0);
  assert.equal(f.base.calls.perform, 0);
  assert.equal(f.base.state.reserveCalls, 0);
  f.native.state.now += 300_000;
  await f.restart().runOnce();
  assert.equal(f.state.position.status, "open");
  assert.equal(f.state.position.snapshot.protectionDegradation.status, "protected_degraded");
  assert.equal(f.state.position.snapshot.stopPrice, 1.0486);
  assert.ok(f.state.position.snapshot.peakPct >= f.saved.position.snapshot.peakPct);
  assert.equal(f.base.state.reserveCalls, 0, "a fresh higher market mark cannot re-arm a stop POST");
  assert.equal(f.base.calls.perform, 0);
  assert.equal(f.native.state.mutations, 0);
  assert.equal(f.state.events.length, 1);
});

test("BTW read outage persists unknown attribution and paced reads, then cold restart recovers", async () => {
  const f = actualBtwRuntime({ nativeOutage: true });
  await f.worker.runOnce();
  assert.equal(f.state.intent.state, "unknown");
  assert.equal(f.state.position.snapshot.protectionDegradation, undefined);
  const reads = f.native.state.calls.length;
  await f.restart().runOnce();
  assert.equal(f.native.state.calls.length, reads, "read pacing survives restart");
  f.native.state.readOutage = false;
  f.native.state.now = f.state.intent.outcome.uncertaintyRead.nextReadAt;
  await f.restart().runOnce();
  assert.equal(f.state.intent.state, "failed");
  assert.equal(f.state.intent.outcome.originalExecution, "unknown_unproven");
  assert.equal(f.native.state.mutations, 0);
  assert.equal(f.base.calls.perform, 0);
});

test("independently observed stronger protection upgrades degraded status without reauthorizing a POST or DELETE", async () => {
  const f = actualBtwRuntime();
  await f.worker.runOnce();
  f.native.state.now += 300_000;
  f.native.state.historicalStops = [{ ...f.native.state.stop, status: "CANCELED" }];
  f.native.state.stop = {
    ...f.native.state.stop, orderId: "2106661697317593090", stopPrice: "1.0534",
  };
  await f.restart().runOnce();
  const marker = f.state.position.snapshot.protectionDegradation;
  assert.equal(marker.status, "protection_observed_attribution_unknown");
  assert.equal(marker.requestedStopPrice, "1.0534");
  assert.equal(marker.originalWriteAttributed, false);
  assert.equal(f.state.intent.state, "failed");
  assert.equal(f.state.intent.exchangeOrderId, null);
  assert.equal(f.state.intent.outcome.originalExecution, "unknown_unproven");
  assert.equal(f.state.position.snapshot.stopPrice, 1.0534);
  assert.equal(f.state.events.at(-1).kind, "vst_stop_degraded_protection_observed");
  assert.deepEqual(marker.quarantinedEffects,
    ["stop_post", "stop_delete", "margin_post", "strategy_close"]);
  assert.equal(f.base.calls.perform, 0);
  assert.equal(f.native.state.mutations, 0);
  await f.restart().runOnce();
  assert.equal(f.base.state.reserveCalls, 0);
  assert.equal(f.state.events.length, 2);
});

test("protocol post_started uncertainty can degrade, never be mistaken for a definitely-unsent POST", async () => {
  const f = actualBtwRuntime();
  f.state.intent.request.stopTransferProtocol = 1;
  f.state.intent.outcome.stopTransfer = { version: 1, stage: "post_started" };
  await f.worker.runOnce();
  assert.equal(f.state.intent.state, "failed");
  assert.equal(f.state.intent.outcome.reason, "raise_stop_protected_degraded");
  assert.equal(f.state.intent.outcome.stopTransfer.stage, "post_started");
  assert.equal(f.state.position.snapshot.stopPrice, 1.0486);
  assert.equal(f.base.calls.perform, 0);
  assert.equal(f.native.state.mutations, 0);
});

function queueBtwSourceExit(f) {
  const at = new Date(f.native.state.now).toISOString();
  const evidence = {
    sourceSignalId: f.saved.intent.sourceSignalId, symbol: f.saved.intent.request.symbol,
    reason: "source_closed", sourceStatus: "profit",
    asOf: at, observedAt: at, sourceUpdatedAt: null,
    sourceClosedAt: at, sourceExitPrice: "1.25", sourceCancelReason: null,
    exitDecisionAt: at,
  };
  f.state.sourceRequest = {
    requestId: "btw-source-exit-pending", state: "pending",
    sourceSignalId: evidence.sourceSignalId, symbol: evidence.symbol,
    reason: evidence.reason, asOf: at, observedAt: at, evidence,
  };
}

test("pending source exit preserves degraded read-only stronger-stop recovery across restart", async () => {
  const f = actualBtwRuntime({ sourceExitsEnabled: true });
  await f.worker.runOnce();
  assert.equal(f.state.intent.outcome.reason, "raise_stop_protected_degraded");
  queueBtwSourceExit(f);
  f.native.state.now += 300_000;
  f.native.state.historicalStops = [{ ...f.native.state.stop, status: "CANCELED" }];
  f.native.state.stop = {
    ...f.native.state.stop, orderId: "2106661697317593090", stopPrice: "1.0534",
  };
  const reads = f.native.state.calls.length;
  await f.restart().runOnce();
  assert.ok(f.native.state.calls.length > reads, "pending source exit must not suppress native observations");
  assert.equal(f.state.position.snapshot.protectionDegradation.status,
    "protection_observed_attribution_unknown");
  assert.equal(f.state.position.snapshot.stopPrice, 1.0534);
  assert.equal(f.state.sourceRequest.state, "pending");
  assert.equal(f.state.intent.exchangeOrderId, null);
  await f.restart().runOnce();
  assert.equal(f.base.state.reserveCalls, 0, "missing independent entry proof cannot authorize a MARKET close");
  assert.equal(f.base.calls.perform, 0);
  assert.equal(f.native.state.mutations, 0);
});

for (const sourceLevel of [null, 1.12]) for (const autoCancelStops of [true, false]) test(
  `BTW crossed ${sourceLevel ? "source" : "own"} trailing floor closes without old-stop replay (exchange stop cleanup: ${!autoCancelStops})`,
  async () => {
  const f = actualBtwRuntime();
  await f.worker.runOnce();
   f.state.position.snapshot.peakPct = sourceLevel ? 0 : 25.095133186461048;
   if (sourceLevel) f.base.store.getSourceControl = async () => ({
     sourceSignalId: f.saved.intent.sourceSignalId, symbol: f.saved.intent.request.symbol,
     sourceAction: "hold", sourceTrailingStopLevel: sourceLevel,
     sourceLastMilestone: 10,
   });
  f.base.store.listOpenPositions = async () =>
    ["open", "closing", "unknown"].includes(f.state.position.status)
      ? [{ ...structuredClone(f.state.position), symbol: f.saved.intent.request.symbol }] : [];
  const caps = f.base.broker.getCapabilities;
  f.base.broker.getCapabilities = async () => ({
    ...await caps(),
    features: [...(await caps()).features, "verified_exact_source_full_position_close",
      "verified_source_flat_stop_cleanup"],
  });
  f.base.broker.verifySourceExitEntryProof = f.native.broker.verifySourceExitEntryProof;
  f.base.broker.readMarketMark = async () => ({
    verified: true, price: 1.10, observedAt: f.native.state.now,
  });
  const mark = f.base.store.markIntent;
  f.base.store.markIntent = async (id, status, patch) => {
    if (id === f.state.intent.clientOrderId) return mark(id, status, patch);
    const intent = f.base.state.intents.find(row => row.clientOrderId === id);
    assert.ok(intent);
    Object.assign(intent, { state: status, ...structuredClone(patch) });
  };
  let sent;
  const readAccount = f.base.broker.readAccountState;
  f.base.broker.readAccountState = async () => {
    const account = await readAccount();
    if (sent) {
      assert.equal(account.accountId, sent.request.accountId);
      assert.equal(account.environment, "vst");
      assert.ok(account.verified);
      assert.equal(Number(account.positions[0].quantity ?? account.positions[0].positionAmt), 0);
      assert.deepEqual(account.openOrders, f.native.state.orders);
    }
    return account;
  };
  f.base.broker.performIntent = async intent => {
    if (intent.request.operation === "cancel_flat_split_stop") {
      assert.equal(f.native.state.position.positionAmt, "0");
      assert.equal(intent.request.stopToCancel.orderId, f.native.state.stop.orderId);
      assert.deepEqual(intent.request.knownRemainingStopOrderIds, [f.native.state.stop.orderId]);
      f.native.state.orders = [];
      return;
    }
    assert.equal(intent.request.operation, "close_leg");
    assert.equal(intent.request.protectedExit.originalClientOrderId, f.state.intent.clientOrderId);
    assert.equal(intent.request.protectedExit.ownedStops[0].orderId, f.native.state.stop.orderId);
    assert.equal(intent.request.sourceExit, undefined, "never fabricate source authorization");
    sent = { clientOrderId: intent.clientOrderId, phase: intent.phase,
      request: structuredClone(intent.request) };
    f.native.state.position.positionAmt = "0";
    f.native.state.position.quantity = 0;
    f.native.state.orders = autoCancelStops ? [] : [structuredClone(f.native.state.stop)];
  };
  f.base.broker.reconcileIntent = async ({ request }) => request.operation === "cancel_flat_split_stop" ? {
    verified: true, status: "canceled", flat: true,
    positionId: request.positionId, canceledStopOrderId: request.stopToCancel.orderId,
    knownRemainingStopOrderIds: request.knownRemainingStopOrderIds,
    remainingKnownStopOrderIds: [], cancellationIntentId: request.cancellationIntentId,
    exchangeOrderId: request.stopToCancel.orderId,
  } : ({
    verified: true, status: "filled", exchangeOrderId: "btw-protected-market-exit",
    fill: { verified: true, quantity: 9051, price: 1.10,
      at: new Date(f.native.state.now).toISOString(),
      fee: { verified: true, amount: 0, asset: "VST" } },
    position: { verified: true, symbol: f.saved.intent.request.symbol, quantity: 0 },
  });
  f.base.store.commitVerifiedIntent = async commit => {
    if (commit.eventKind === "vst_protected_strategy_exit_verified") {
      assert.deepEqual(commit.expectedPositionSnapshot, f.state.position.snapshot);
      assert.equal(commit.expectedPositionUpdatedAt, f.state.position.updatedAt);
    } else {
      assert.equal(commit.eventKind, "vst_protected_strategy_exit_stops_cleaned");
    }
    await f.base.store.upsertPosition(commit.position);
    await f.base.store.markIntent(commit.clientOrderId, "reconciled", {
      exchangeOrderId: commit.exchangeOrderId, outcome: commit.outcome,
    });
  };
  f.native.state.now += 5000;
  const result = await f.restart().runOnce();
  assert.equal(result.operation, "protected_strategy_exit", JSON.stringify(result));
  assert.ok(sent);
  assert.equal(f.state.position.status, autoCancelStops ? "closed" : "closing");
  assert.equal(f.state.position.snapshot.remainingQty, 0);
  assert.equal(f.state.position.snapshot.lastCloseFill.price, 1.10);
  assert.equal(f.state.intent.exchangeOrderId, null);
  assert.equal(f.state.intent.outcome.originalExecution, "unknown_unproven");
  assert.equal(f.base.state.reserveCalls, 1);
  if (!autoCancelStops) {
    f.native.state.now += 5000;
    const cleanup = await f.restart().runOnce();
    assert.equal(cleanup.operation, "cancel_flat_split_stop", JSON.stringify(cleanup));
    assert.equal(f.state.position.status, "closed");
    assert.equal(f.base.state.reserveCalls, 2);
  }
  await f.restart().runOnce();
  assert.equal(f.base.state.reserveCalls, autoCancelStops ? 1 : 2,
    "restart does not resend the confirmed close");
});

test("pending source exit permits exact triggered-stop settlement, then durable queue completion after restart", async () => {
  const f = actualBtwRuntime({ sourceExitsEnabled: true });
  await f.worker.runOnce();
  queueBtwSourceExit(f);
  f.native.state.now += 300_000;
  let positionReads = 0, fillReads = 0;
  const snapshot = structuredClone(f.state.position.snapshot);
  const childOrderId = "2106661697317593091";
  f.native.state.position.positionAmt = "0";
  f.native.state.orders = [];
  f.native.state.stop.status = "FILLED";
  f.native.state.stop.executedQty = "9051";
  const fill = {
    orderId: childOrderId, triggerOrderId: snapshot.coreStopOrderId,
    quantity: "9051", price: "1.0486",
    at: new Date(f.native.state.now).toISOString(),
    fee: { amount: "0.5", asset: "VST" }, feeEvidenceAvailable: true,
  };
  f.base.broker.readPosition = async () => {
    positionReads++;
    return { verified: true, symbol: snapshot.symbol, side: "Buy",
      quantity: 0, positionId: snapshot.exchangePositionId,
      leverage: 10, marginMode: "ISOLATED", protectiveStops: {} };
  };
  f.base.broker.observeTriggeredStop = async request => {
    fillReads++;
    assert.equal(request.stopOrderId, snapshot.coreStopOrderId);
    assert.equal(request.positionId, snapshot.exchangePositionId);
    return { verified: true, status: "filled",
      parentStopId: snapshot.coreStopOrderId, parentStopPrice: "1.0486",
      childOrderId, fill: structuredClone(fill),
      residualPosition: { verified: true, positionId: snapshot.exchangePositionId, quantity: "0" },
      openStops: [] };
  };
  f.base.store.commitVerifiedIntent = async commit => {
    const intent = f.base.state.intents.find(row => row.clientOrderId === commit.clientOrderId);
    assert.equal(intent.request.operation, "observe_triggered_stop");
    assert.equal(intent.request.stopOrderId, snapshot.coreStopOrderId);
    assert.equal(commit.exchangeOrderId, childOrderId);
    assert.equal(commit.outcome.fill.triggerOrderId, snapshot.coreStopOrderId);
    assert.equal(commit.position.remainingQty, 0);
    intent.state = "reconciled";
    intent.exchangeOrderId = commit.exchangeOrderId;
    intent.outcome = structuredClone(commit.outcome);
    await f.base.store.upsertPosition(commit.position);
    f.state.signalStatus = commit.signalStatus;
    f.state.events.push({ kind: commit.eventKind, detail: structuredClone(commit.eventDetail) });
  };
  const result = await f.restart().runOnce();
  assert.ok(["observe_triggered_stop", "source_exit_stop_fill_reconciled"].includes(result.operation),
    JSON.stringify(result));
  assert.ok(positionReads > 0);
  assert.equal(fillReads, 1);
  assert.equal(f.state.position.status, "closed");
  assert.equal(f.state.position.snapshot.lastCloseFill.price, 1.0486);
  assert.equal(f.state.sourceRequest.state, "pending");
  assert.equal(f.state.intent.outcome.originalExecution, "unknown_unproven");
  const finished = await f.restart().runOnce();
  assert.equal(finished.operation, "source_exit_request_finished");
  assert.equal(f.state.sourceRequest.state, "finished");
  assert.equal(f.state.sourceRequest.result.detail.closureOrigin, "already_committed_protective_stop");
  assert.deepEqual(f.state.sourceRequest.result.detail.sourceEvidence, f.state.sourceRequest.evidence);
  assert.equal(f.state.sourceRequest.result.detail.childOrderId, childOrderId);
  assert.equal(f.base.state.reserveCalls, 1, "only a read-observation intent, never a close intent");
  assert.equal(f.base.calls.perform, 0);
  assert.equal(f.native.state.mutations, 0);
});

test("journaled preparation interrupted before POST is retired only with fresh unchanged protection", async () => {
  const f = createFixture({
    exchangeOrderId: null,
    outcome: { stopTransfer: { version: 1, stage: "prepared" } },
  });
  f.request.stopTransferProtocol = 1;
  let proofCalls = 0;
  let settlementCalls = 0;
  f.broker.verifyPreparedStopTransfer = async request => {
    proofCalls += 1;
    assert.equal(request, f.request);
    return true;
  };
  f.store.settlePreparedStopTransfer = async ({ expectedPosition }) => {
    settlementCalls += 1;
    assert.equal(expectedPosition.updatedAt, updatedAt);
    f.state.intents[0].state = "failed";
    f.state.position.status = "open";
    f.state.position.snapshot.status = "open";
    f.state.signalStatus = "open";
    return true;
  };
  await f.worker.tick();
  assert.equal(proofCalls, 1);
  assert.equal(settlementCalls, 1);
  assert.equal(f.state.intents[0].state, "failed");
  assert.equal(f.calls.perform, 0);
});

test("missing or stale protection never retires even a definitely-unsent stop transfer", async () => {
  const f = createFixture({
    exchangeOrderId: null, outcome: { stopTransfer: { version: 1, stage: "prepared" } },
  });
  f.request.stopTransferProtocol = 1;
  f.broker.verifyPreparedStopTransfer = async () => false;
  f.store.settlePreparedStopTransfer = async () => assert.fail("unverified retirement");
  await f.worker.tick();
  assert.equal(f.state.intents[0].state, "unknown");
  assert.equal(f.calls.perform, 0);
});

test("restart with an acknowledged replacement resumes only the first guarded cancellation", async () => {
  const f = createFixture({
    outcome: { stopTransfer: { version: 1, stage: "post_acknowledged", newStopOrderId: stopOrderId } },
  });
  f.request.stopTransferProtocol = 1;
  let cancelled = false;
  let cancellationCalls = 0;
  const reconcile = f.broker.reconcileIntent;
  f.broker.reconcileIntent = async input => cancelled
    ? reconcile(input) : { verified: false, status: "unknown" };
  f.broker.resumeStopTransferCancellation = async ({ intent, stopTransferJournal }) => {
    cancellationCalls += 1;
    assert.equal(intent.exchangeOrderId, stopOrderId);
    assert.equal(stopTransferJournal.getProgress().stage, "post_acknowledged");
    cancelled = true;
  };
  await f.worker.tick();
  assert.equal(cancellationCalls, 1);
  assert.equal(f.calls.perform, 0);
  assert.equal(f.state.intents[0].state, "reconciled");
  assert.equal(f.state.commitCalls.length, 1);
});

test("a possibly-sent cancellation is read-only after restart", async () => {
  const f = createFixture({
    outcome: { stopTransfer: { version: 1, stage: "cancel_started", newStopOrderId: stopOrderId } },
  });
  f.request.stopTransferProtocol = 1;
  f.broker.resumeStopTransferCancellation = async () => assert.fail("DELETE replay");
  await f.worker.tick();
  assert.equal(f.calls.perform, 0);
  assert.equal(f.state.intents[0].state, "reconciled");
});

test("real worker repairs an unknown position only from the exact submitted raise-stop ID and entry proof", async () => {
  const fixture = createFixture();
  await fixture.worker.runOnce();

  assert.equal(fixture.calls.reconcile.length, 1);
  assert.equal(fixture.calls.reconcile[0].exchangeOrderId, stopOrderId);
  assert.equal(fixture.calls.perform, 0, "unknown-ID recovery is read-only");
  assert.equal(fixture.state.commitCalls.length, 1);
  assert.equal(fixture.state.position.status, "open");
  assert.equal(fixture.state.position.snapshot.status, "open");
  assert.equal(fixture.state.position.snapshot.coreStopOrderId, stopOrderId);
  assert.equal(fixture.state.position.snapshot.coreStopPositionId, positionId);
  assert.equal(fixture.state.position.snapshot.coreStopQuantity, 0.1);
  assert.equal(fixture.state.position.snapshot.stopPrice, 96);
  assert.equal(fixture.state.intents[0].state, "reconciled");
  assert.equal(fixture.state.signalStatus, "open");
  assert.equal(fixture.state.events[0].kind, "vst_raise_stop_verified");
  assert.equal(fixture.state.commitCalls[0].expectedPositionSnapshot.status, "unknown");
  assert.equal(fixture.state.commitCalls[0].expectedPositionUpdatedAt, updatedAt);
});

test("legacy NULL-ID raise-stop adopts current protection separately and stops this tick", async () => {
  const intentPhase = `raise_stop-core-${now - 5_000}`;
  const clientOrderId = `vst-${createHash("sha256")
    .update(`${sourceSignalId}:${intentPhase}`).digest("hex").slice(0, 30)}`;
  const fixture = createFixture({
    exchangeOrderId: null,
    intentPhase,
    intentClientOrderId: clientOrderId,
    outcome: { reason: "exchange_state_not_verified" },
  });
  const activeStopId = "unlinked-current-native-stop";
  const stopEvidence = {
    verified: true,
    tranche: "core",
    orderId: activeStopId,
    positionId,
    quantity: "0.1",
    stopPrice: "96",
  };
  fixture.broker.verifyUnlinkedRaiseStopProtection = async () => ({
    verified: true,
    status: "filled",
    currentProtectionOnly: true,
    currentProtectionObservedAt: now,
    exchangeOrderId: activeStopId,
    position: {
      verified: true,
      symbol,
      side: "Buy",
      quantity: 0.1,
      positionId,
      protectiveStops: { core: stopEvidence },
    },
    protectiveStops: { core: stopEvidence },
  });
  fixture.store.adoptUnlinkedRaiseStopProtection = async (input) => {
    assert.equal(input.currentProtection.orderId, activeStopId);
    assert.equal(input.eventDetail.originalWriteAttributed, false);
    const intent = fixture.state.intents.find((row) =>
      row.clientOrderId === clientOrderId);
    intent.state = "failed";
    intent.exchangeOrderId = null;
    intent.outcome = {
      reason: "raise_stop_unlinked_protection_adopted",
      originalExecution: "unknown_unproven",
      originalOutcome: input.expectedOutcome,
    };
    fixture.state.position = {
      ...fixture.state.position,
      status: "open",
      snapshot: structuredClone(input.position),
      updatedAt: new Date(now).toISOString(),
    };
    fixture.state.signalStatus = "open";
    fixture.state.events.push({ kind: "vst_stop_protection_adopted" });
    return { kind: "recovered" };
  };

  const result = await fixture.worker.runOnce();
  assert.equal(result.kind, "reconciled");
  assert.equal(result.reason, "raise_stop_unlinked_protection_adopted");
  assert.equal(fixture.state.intents[0].state, "failed");
  assert.equal(fixture.state.intents[0].exchangeOrderId, null,
    "the adopted exchange ID is never written as the original execution ID");
  assert.equal(fixture.state.intents[0].outcome.originalExecution,
    "unknown_unproven");
  assert.equal(fixture.state.position.snapshot.coreStopOrderId, activeStopId);
  assert.equal(fixture.state.position.snapshot.status, "open");
  assert.equal(fixture.state.events.at(-1).kind, "vst_stop_protection_adopted");
  assert.equal(fixture.calls.perform, 0);

  await fixture.worker.runOnce();
  assert.equal(fixture.state.intents[0].state, "failed",
    "a restart does not revisit or duplicate the committed adoption");
  assert.equal(fixture.calls.perform, 0);
});

function coexistenceWorkerFixture({ failFirstCommit = false, retirementVerified = true } = {}) {
  const intentPhase = `raise_stop-core-${now}`;
  const clientOrderId = `vst-${createHash("sha256")
    .update(`${sourceSignalId}:${intentPhase}`).digest("hex").slice(0, 30)}`;
  const fixture = createFixture({
    exchangeOrderId: null, intentPhase, intentClientOrderId: clientOrderId,
    outcome: { reason: "exchange_state_not_verified" }, failFirstCommit,
  });
  const old = fixture.state.position.snapshot.verifiedProtectiveStops.core;
  const { verified: _verified, tranche: _tranche, ...oldStop } = old;
  const adoptedStop = { ...oldStop, orderId: "777777777", stopPrice: "96" };
  const protection = { ...adoptedStop, verified: true, tranche: "core" };
  fixture.broker.verifyUnlinkedRaiseStopProtection = async () => ({
    verified: true, status: "filled", currentProtectionOnly: true,
    exchangeOrderId: adoptedStop.orderId, currentProtectionObservedAt: now,
    protectiveStops: { core: protection },
    oldStopRetirement: { oldStop, adoptedStop },
  });
  fixture.store.adoptUnlinkedRaiseStopProtection = async (input) => {
    assert.deepEqual(input.oldStopRetirement, { oldStop, adoptedStop });
    assert.deepEqual(input.position.pendingStopRetirement.originalIntent,
      { clientOrderId, phase: intentPhase });
    const original = fixture.state.intents[0];
    original.state = "failed";
    original.exchangeOrderId = null;
    original.outcome = {
      reason: "raise_stop_unlinked_protection_adopted",
      originalExecution: "unknown_unproven",
    };
    fixture.state.position = {
      ...fixture.state.position, status: "open",
      snapshot: structuredClone(input.position), updatedAt: new Date(now).toISOString(),
    };
    fixture.state.signalStatus = "open";
    fixture.state.events.push({ kind: "vst_stop_protection_adopted" });
    return { kind: "recovered" };
  };
  fixture.broker.performIntent = async ({ request }) => {
    fixture.calls.perform += 1;
    assert.equal(request.operation, "retire_adopted_stop", "never recreate the stop");
    assert.equal(request.oldStop.orderId, oldStop.orderId);
    assert.equal(request.adoptedStop.orderId, adoptedStop.orderId);
    assert.equal(request.nextPosition.pendingStopRetirement, undefined);
    // This fixture's legacy old ID is nonnumeric; no submission ACK is
    // simulated. The subsequent independent read establishes cancellation.
    return undefined;
  };
  fixture.broker.reconcileIntent = async ({ request }) => {
    assert.equal(request.operation, "retire_adopted_stop");
    return retirementVerified ? {
      verified: true, status: "filled", exchangeOrderId: oldStop.orderId,
      canceledStopOrderId: oldStop.orderId, protectiveStops: { core: protection },
    } : { verified: false, status: "unknown" };
  };
  return fixture;
}

test("coexisting stop recovery adopts first and retires old protection in a separate durable intent", async () => {
  const fixture = coexistenceWorkerFixture();
  await fixture.worker.runOnce();
  assert.equal(fixture.calls.perform, 0, "adoption is read-only");
  assert.equal(fixture.state.position.snapshot.coreStopOrderId, "777777777");
  assert.ok(fixture.state.position.snapshot.pendingStopRetirement);
  assert.equal(fixture.state.intents[0].exchangeOrderId, null);
  await fixture.worker.runOnce();
  assert.equal(fixture.calls.perform, 1);
  assert.equal(fixture.state.position.snapshot.pendingStopRetirement, undefined);
  assert.equal(fixture.state.intents[0].outcome.originalExecution, "unknown_unproven");
  const retirement = fixture.state.intents.find(row =>
    row.request.operation === "retire_adopted_stop");
  assert.equal(retirement.state, "reconciled");
  assert.equal(retirement.exchangeOrderId, "raise-stop-original-native");
  assert.equal(fixture.state.events.at(-1).kind,
    "vst_adopted_stop_old_protection_retired");
});

test("interrupted retirement settlement retries reads and commit without repeating cancellation", async () => {
  const fixture = coexistenceWorkerFixture({ failFirstCommit: true });
  await fixture.worker.runOnce();
  await fixture.worker.runOnce().catch(() => {});
  assert.equal(fixture.calls.perform, 1);
  assert.ok(fixture.state.position.snapshot.pendingStopRetirement);
  await fixture.worker.runOnce();
  assert.equal(fixture.calls.perform, 1);
  assert.equal(fixture.state.position.snapshot.pendingStopRetirement, undefined);
});

test("unverified retirement leaves adopted protection and original unknown attribution intact", async () => {
  const fixture = coexistenceWorkerFixture({ retirementVerified: false });
  await fixture.worker.runOnce();
  await fixture.worker.runOnce();
  await fixture.worker.runOnce();
  assert.equal(fixture.calls.perform, 1);
  assert.ok(fixture.state.position.snapshot.pendingStopRetirement);
  assert.equal(fixture.state.position.snapshot.coreStopOrderId, "777777777");
  assert.equal(fixture.state.intents[0].exchangeOrderId, null);
});

test("proven pre-DELETE read refusal gets a fresh guarded retirement attempt, not a permanent unknown", async () => {
  const fixture = coexistenceWorkerFixture();
  const perform = fixture.broker.performIntent;
  let refused = false;
  fixture.broker.performIntent = async input => {
    if (!refused) {
      refused = true;
      const error = new Error("temporary read refusal before cancellation");
      error.mutationProvenance = {
        operation: "cancel_original_stop", mutationMethod: "DELETE",
        mutationEndpoint: "/openApi/swap/v2/trade/order",
        mutationRequestSent: false, phase: "pre_mutation_read",
      };
      throw error;
    }
    return await perform(input);
  };
  await fixture.worker.runOnce();
  await fixture.worker.runOnce();
  assert.equal(fixture.calls.perform, 0);
  const refusedIntent = fixture.state.intents.find(row =>
    row.request.operation === "retire_adopted_stop");
  assert.equal(refusedIntent.state, "failed");
  assert.equal(refusedIntent.outcome.reason, "adopted_stop_retirement_not_sent");
  assert.ok(fixture.state.position.snapshot.pendingStopRetirement);
  await fixture.worker.runOnce();
  assert.equal(fixture.calls.perform, 1);
  assert.equal(fixture.state.position.snapshot.pendingStopRetirement, undefined);
  assert.equal(fixture.state.intents.filter(row =>
    row.request.operation === "retire_adopted_stop").length, 2);
});

test("raise-stop acknowledgement shape diagnosis survives repeated unknown reconciliation without raw response data", async () => {
  const acknowledgement = {
    responseType: "object", orderWrapper: "object",
    flatOrderIdPresent: false, flatOrderIDPresent: false,
    nestedOrderIdPresent: true, nestedOrderIDPresent: true,
    reason: "conflicting_aliases",
  };
  const fixture = createFixture({
    exchangeOrderId: null,
    outcome: { error: "BingXLiveApiError", errorMessage: "Ambiguous response",
      acknowledgement: { ...acknowledgement, rawResponse: "must-not-persist" } },
  });
  fixture.broker.reconcileIntent = async () => ({ verified: false, status: "unknown" });
  await fixture.worker.runOnce();
  await fixture.worker.runOnce();
  assert.deepEqual(fixture.state.intents[0].outcome.acknowledgement, acknowledgement);
  assert.equal(fixture.calls.perform, 0);
});

test("exact equal-price BingX refusal retires only after fresh unchanged-stop proof and is idempotent", async () => {
  const intentPhase = `raise_stop-core-${now}`;
  const intentClientOrderId = `vst-${createHash("sha256")
    .update(`${sourceSignalId}:${intentPhase}`).digest("hex").slice(0, 30)}`;
  const fixture = createFixture({
    exchangeOrderId: null,
    openPosition: true,
    oldStopPrice: "96",
    targetStopPrice: "96",
    intentPhase,
    intentClientOrderId,
    outcome: {
      reason: "exchange_state_not_verified",
      submissionError: "BingXLiveApiError",
      submissionErrorMessage:
        "VST protective stop upgrades may only raise the stop",
    },
  });
  fixture.store.listOpenPositions = async () => [];
  await fixture.worker.runOnce();

  assert.equal(fixture.state.equalPriceRecoveryCalls?.length, 1);
  assert.equal(fixture.state.intents[0].state, "failed");
  assert.equal(fixture.state.intents[0].exchangeOrderId, null);
  assert.equal(fixture.state.signalStatus, "open");
  assert.equal(fixture.state.position.status, "open");
  assert.equal(fixture.calls.perform, 0);
  assert.equal(fixture.state.events.some((event) =>
    event.kind === "vst_raise_stop_verified"), false);

  const restarted = createVstWorker({
    store: fixture.store,
    broker: fixture.broker,
    clock: () => now,
    sizingLimits: { environment: "vst" },
  });
  await restarted.runOnce();
  assert.equal(fixture.state.equalPriceRecoveryCalls.length, 1);
  assert.equal(fixture.calls.perform, 0);

  const explicitPhase = `raise_stop-core-${now}`;
  const explicitClientId = `vst-${createHash("sha256")
    .update(`${sourceSignalId}:${explicitPhase}`).digest("hex").slice(0, 30)}`;
  const explicit = createFixture({
    exchangeOrderId: null,
    openPosition: true,
    oldStopPrice: "96",
    targetStopPrice: "96",
    intentPhase: explicitPhase,
    intentClientOrderId: explicitClientId,
    outcome: {
      reason: "exchange_state_not_verified",
      submissionError: "BingXLiveApiError",
      submissionErrorMessage:
        "VST protective stop upgrades may only raise the stop",
      mutationProvenance: {
        operation: "raise_stop",
        method: "POST",
        phase: "pre_mutation_guard",
        mutationRequestSent: false,
        reason: "non_increasing_stop",
      },
    },
  });
  explicit.store.listOpenPositions = async () => [];
  await explicit.worker.runOnce();
  assert.equal(explicit.state.equalPriceRecoveryCalls?.length, 1);
  assert.equal(explicit.state.intents[0].state, "failed");
  assert.equal(explicit.calls.perform, 0);
});

test("native RE empty mainOrderId and entryProof-only identity are eligible for the legacy no-op boundary", async () => {
  const intentPhase = `raise_stop-core-${now}`;
  const intentClientOrderId = `vst-${createHash("sha256")
    .update(`${sourceSignalId}:${intentPhase}`).digest("hex").slice(0, 30)}`;
  const fixture = createFixture({
    exchangeOrderId: null,
    openPosition: true,
    oldStopPrice: "0.4915",
    targetStopPrice: "0.4915",
    intentPhase,
    intentClientOrderId,
    outcome: {
      reason: "exchange_state_not_verified",
      submissionError: "BingXLiveApiError",
      submissionErrorMessage:
        "VST protective stop upgrades may only raise the stop",
    },
  });
  const nativePositionId = "2105271515231551489";
  const nativeStopId = "2105952049086160896";
  const nativeEntryId = "2105271515000000000";
  const nativeQuantity = "18850.91";
  const nativeSymbol = "REUSDT";
  const snapshots = [
    fixture.priorPosition,
    fixture.state.position.snapshot,
    fixture.request.nextPosition,
  ];
  for (const snapshot of snapshots) {
    snapshot.symbol = nativeSymbol;
    snapshot.exchangePositionId = nativePositionId;
    snapshot.positionId = nativePositionId;
    delete snapshot.entryOrderId;
    snapshot.quantity = nativeQuantity;
    snapshot.remainingQty = nativeQuantity;
    snapshot.coreStopOrderId = nativeStopId;
    snapshot.coreStopPositionId = nativePositionId;
    snapshot.coreStopQuantity = nativeQuantity;
    snapshot.coreStopPrice = 0.4915;
    snapshot.stopPrice = 0.4915;
    snapshot.verifiedProtectiveStops = {
      core: {
        verified: true,
        tranche: "core",
        orderId: nativeStopId,
        positionId: nativePositionId,
        quantity: nativeQuantity,
        stopPrice: "0.4915",
      },
    };
  }
  fixture.state.position.symbol = nativeSymbol;
  fixture.oldStop.orderId = nativeStopId;
  fixture.oldStop.positionId = nativePositionId;
  fixture.oldStop.quantity = nativeQuantity;
  fixture.oldStop.stopPrice = "0.4915";
  fixture.request.symbol = nativeSymbol;
  fixture.request.positionId = nativePositionId;
  fixture.request.quantity = nativeQuantity;
  fixture.request.previousQuantity = nativeQuantity;
  fixture.request.entryQuantity = nativeQuantity;
  fixture.request.stopPrice = "0.4915";
  delete fixture.request.entryOrderId;
  fixture.request.entryProof = {
    entryClientOrderId,
    entryOrderId: nativeEntryId,
    positionId: nativePositionId,
    entryOrderType: "MARKET",
    intentCreatedAt: entryIntentAt,
    quantity: nativeQuantity,
  };
  const entryIntent = fixture.state.intents[1];
  entryIntent.request.symbol = nativeSymbol;
  entryIntent.request.quantity = nativeQuantity;
  entryIntent.exchangeOrderId = nativeEntryId;
  entryIntent.outcome.fillQuantity = nativeQuantity;
  entryIntent.outcome.positionId = nativePositionId;
  fixture.broker.verifyEntryOrderProof = async () => ({
    verified: true,
    status: "filled",
    exchangeOrderId: nativeEntryId,
    positionId: nativePositionId,
    fill: { quantity: nativeQuantity },
  });
  fixture.broker.readAccountState = async () => ({
    verified: true,
    environment: "vst",
    accountId,
    positions: [{
      symbol: "RE-USDT",
      positionId: nativePositionId,
      positionSide: "LONG",
      positionAmt: nativeQuantity,
    }],
    openOrders: [{
      symbol: "RE-USDT",
      positionID: nativePositionId,
      orderId: nativeStopId,
      origQty: nativeQuantity,
      stopPrice: "0.4915",
      type: "STOP_MARKET",
      status: "NEW",
      side: "SELL",
      positionSide: "LONG",
      workingType: "MARK_PRICE",
      mainOrderId: "",
      executedQty: "0.00",
    }],
  });
  fixture.store.listOpenPositions = async () => [];

  await fixture.worker.runOnce();
  assert.equal(fixture.state.equalPriceRecoveryCalls?.length, 1);
  assert.equal(fixture.state.equalPriceRecoveryCalls[0].oldPositionAndStop.positionId,
    nativePositionId);
  assert.equal(fixture.state.equalPriceRecoveryCalls[0].oldPositionAndStop.stopOrderId,
    nativeStopId);
  assert.equal(fixture.state.equalPriceRecoveryCalls[0].oldPositionAndStop.quantity,
    nativeQuantity);
  assert.equal(
    fixture.state.equalPriceRecoveryCalls[0].oldPositionAndStop.executionProof.executedQty,
    "0.00",
  );
  assert.equal(Object.hasOwn(fixture.state.equalPriceRecoveryCalls[0].expectedRequest,
    "entryOrderId"), false);
  assert.equal(
    fixture.state.equalPriceRecoveryCalls[0].expectedRequest.entryProof.entryOrderId,
    nativeEntryId,
  );
  assert.equal(fixture.state.intents[0].state, "failed");
  assert.equal(fixture.calls.perform, 0);
});

test("equal-price legacy refusal is not healed on error, identifier, identity, read, or CAS mismatch", async (t) => {
  const exactMessage = "VST protective stop upgrades may only raise the stop";
  const cases = [
    ["different error message", { outcome: {
      reason: "exchange_state_not_verified",
      submissionError: "BingXLiveApiError",
      submissionErrorMessage: "request timed out",
    } }],
    ["native exchange order ID", { exchangeOrderId: stopOrderId }],
    ["different old stop ID", { brokerChange: "stop-id" }],
    ["different position ID", { brokerChange: "position-id" }],
    ["different position quantity", { brokerChange: "position-quantity" }],
    ["old stop shows execution", { brokerChange: "stop-executed" }],
    ["position read failure", { brokerChange: "account-read-failure" }],
    ["entry proof timeout", { brokerChange: "entry-proof-timeout" }],
    ["different entry identity", { brokerChange: "entry-id-mismatch" }],
    ["stale evidence window", { brokerChange: "stale-evidence" }],
    ["stale compare-and-set snapshot", { brokerChange: "cas-race" }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async () => {
      let testClock = now;
      const intentPhase = `raise_stop-core-${now}`;
      const intentClientOrderId = `vst-${createHash("sha256")
        .update(`${sourceSignalId}:${intentPhase}`).digest("hex").slice(0, 30)}`;
      const fixture = createFixture({
        exchangeOrderId: null,
        openPosition: true,
        oldStopPrice: "96",
        targetStopPrice: "96",
        intentPhase,
        intentClientOrderId,
        clock: () => testClock,
        outcome: {
          reason: "exchange_state_not_verified",
          submissionError: "BingXLiveApiError",
          submissionErrorMessage: exactMessage,
        },
      });
      if (options.outcome) fixture.state.intents[0].outcome = options.outcome;
      if (options.exchangeOrderId) {
        fixture.state.intents[0].exchangeOrderId = options.exchangeOrderId;
        fixture.broker.reconcileIntent = async () => ({
          verified: false, status: "unknown",
        });
      }
      if (options.brokerChange === "stop-id") {
        const read = fixture.broker.readAccountState;
        fixture.broker.readAccountState = async () => {
          const snapshot = await read();
          snapshot.openOrders[0].orderId = "different-stop-id";
          return snapshot;
        };
      } else if (options.brokerChange === "position-id") {
        const read = fixture.broker.readAccountState;
        fixture.broker.readAccountState = async () => {
          const snapshot = await read();
          snapshot.positions[0].positionId = "different-position-id";
          return snapshot;
        };
      } else if (options.brokerChange === "position-quantity") {
        const read = fixture.broker.readAccountState;
        fixture.broker.readAccountState = async () => {
          const snapshot = await read();
          snapshot.positions[0].positionAmt = "0.09";
          return snapshot;
        };
      } else if (options.brokerChange === "stop-executed") {
        const read = fixture.broker.readAccountState;
        fixture.broker.readAccountState = async () => {
          const snapshot = await read();
          snapshot.openOrders[0].executedQty = "0.1";
          return snapshot;
        };
      } else if (options.brokerChange === "account-read-failure") {
        fixture.broker.readAccountState = async () => {
          throw new Error("temporary account read failure");
        };
      } else if (options.brokerChange === "entry-proof-timeout") {
        fixture.broker.verifyEntryOrderProof = async () => {
          throw new Error("entry proof timeout");
        };
      } else if (options.brokerChange === "entry-id-mismatch") {
        fixture.broker.verifyEntryOrderProof = async () => ({
          verified: true,
          status: "filled",
          exchangeOrderId: "other-entry-order",
          positionId,
          fill: { quantity: "0.1" },
        });
      } else if (options.brokerChange === "stale-evidence") {
        const read = fixture.broker.readAccountState;
        fixture.broker.readAccountState = async () => {
          const snapshot = await read();
          testClock += 6_000;
          return snapshot;
        };
      } else if (options.brokerChange === "cas-race") {
        const recover = fixture.store.recoverRaiseStopEqualPriceNoop;
        fixture.store.recoverRaiseStopEqualPriceNoop = async (input) => {
          fixture.state.position.updatedAt = new Date(now + 1).toISOString();
          return recover(input);
        };
      }
      await fixture.worker.runOnce();
      assert.equal(fixture.state.equalPriceRecoveryCalls?.length ?? 0,
        options.brokerChange === "cas-race" ? 1 : 0);
      assert.equal(fixture.state.intents[0].state, "unknown");
      assert.equal(fixture.state.signalStatus, "unknown");
      assert.equal(fixture.calls.perform, 0);
    });
  }
});

test("atomic commit interruption retries only read-only reconciliation and never repeats a POST", async () => {
  const fixture = createFixture({ failFirstCommit: true });
  await fixture.worker.runOnce();
  assert.equal(fixture.state.position.status, "unknown");
  assert.equal(fixture.state.intents[0].state, "unknown");

  await fixture.worker.runOnce();
  assert.equal(fixture.calls.reconcile.length, 2);
  assert.equal(fixture.calls.perform, 0);
  assert.equal(fixture.state.position.status, "open");
  assert.equal(fixture.state.intents[0].state, "reconciled");
});

test("real worker commits an immediate raise-stop ACK with its captured native ID", async () => {
  const fixture = createFixture();
  fixture.state.intents = [fixture.state.intents[1]];
  fixture.state.position = {
    ...fixture.state.position,
    status: "open",
    snapshot: structuredClone(fixture.priorPosition),
  };
  fixture.state.signalStatus = "open";
  fixture.state.markPrice = 106;
  fixture.broker.performIntent = async ({ onSubmission }) => {
    fixture.calls.perform += 1;
    await onSubmission({ exchangeOrderId: stopOrderId });
    return { exchangeOrderId: stopOrderId };
  };
  const reconcile = fixture.broker.reconcileIntent.bind(fixture.broker);
  fixture.broker.reconcileIntent = async (intent) => {
    const durableIntent = fixture.state.intents.find((row) =>
      row.request.operation === "raise_stop");
    fixture.state.submissionAtReconcile = {
      intent,
      durableIntent: durableIntent && {
        state: durableIntent.state,
        exchangeOrderId: durableIntent.exchangeOrderId,
      },
    };
    return reconcile(intent);
  };

  await fixture.worker.runOnce();

  assert.equal(fixture.calls.perform, 1);
  assert.equal(fixture.calls.reconcile.length, 1);
  assert.equal(fixture.state.submissionAtReconcile.durableIntent.state, "submitted");
  assert.equal(
    fixture.state.submissionAtReconcile.durableIntent.exchangeOrderId,
    stopOrderId,
  );
  assert.equal(fixture.state.commitCalls.length, 1);
  assert.equal(fixture.state.position.status, "open");
  assert.equal(fixture.state.position.snapshot.coreStopOrderId, stopOrderId);
  const raisedIntent = fixture.state.intents.find((row) =>
    row.request.operation === "raise_stop");
  assert.equal(raisedIntent.state, "reconciled");
  assert.equal(raisedIntent.exchangeOrderId, stopOrderId);
  assert.equal(fixture.state.signalStatus, "open");
  assert.equal(fixture.state.events[0].kind, "vst_raise_stop_verified");
});

test("a missing atomic commit primitive refuses a fresh raise-stop before reservation or POST", async () => {
  const fixture = createFixture();
  fixture.state.intents = [fixture.state.intents[1]];
  fixture.state.position.status = "open";
  fixture.state.position.snapshot = structuredClone(fixture.priorPosition);
  fixture.state.signalStatus = "open";
  fixture.state.markPrice = 106;
  fixture.store.commitVerifiedIntent = undefined;

  await fixture.worker.runOnce();

  assert.equal(fixture.state.reserveCalls, 0);
  assert.equal(fixture.calls.perform, 0);
  assert.equal(fixture.state.position.status, "open");
  assert.equal(fixture.state.position.snapshot.coreStopOrderId,
    fixture.priorPosition.coreStopOrderId);
});

test("missing native ID and mismatched replacement proof cannot recover or resurrect", async (t) => {
  for (const [name, options] of [
    ["missing submitted ID", { exchangeOrderId: null }],
    ["wrong native order proof", { evidenceOrderId: "foreign-native-order" }],
    ["foreign position proof", { proofPositionId: "foreign-position" }],
    ["mismatched durable entry fill proof", { entryFillQuantity: "0.09" }],
  ]) {
    await t.test(name, async () => {
      const fixture = createFixture(options);
      await fixture.worker.runOnce();
      assert.equal(fixture.state.commitCalls.length, 0);
      assert.equal(fixture.state.position.status, "unknown");
      assert.equal(fixture.state.position.snapshot.status, "unknown");
      assert.equal(fixture.state.intents[0].state, "unknown");
      assert.equal(fixture.calls.perform, 0);
      if (options.exchangeOrderId === null) {
        assert.equal(
          Object.hasOwn(fixture.calls.reconcile[0], "exchangeOrderId"),
          false,
        );
      }
    });
  }
});

test("manual close before or after the worker's last snapshot read wins the atomic position CAS", async (t) => {
  for (const [name, when] of [
    ["before revalidation", "duringReconciliation"],
    ["after revalidation but before the transaction CAS", "beforeCommit"],
  ]) {
    await t.test(name, async () => {
      const close = async (state) => {
        state.position.status = "closed";
        state.position.snapshot = {
          ...state.position.snapshot,
          status: "closed",
          manualResolution: { outcome: "owner_closed" },
        };
        state.position.updatedAt = new Date(now + 1).toISOString();
      };
      const fixture = createFixture({
        ...(when === "beforeCommit" ? { concurrentClose: close } : {}),
      });
      if (when === "duringReconciliation") {
        const reconcile = fixture.broker.reconcileIntent.bind(fixture.broker);
        fixture.broker.reconcileIntent = async (input) => {
          const evidence = await reconcile(input);
          await close(fixture.state);
          return evidence;
        };
      }
      await fixture.worker.runOnce();
      assert.equal(fixture.state.position.status, "closed");
      assert.equal(fixture.state.position.snapshot.status, "closed");
      assert.equal(fixture.state.position.snapshot.manualResolution.outcome, "owner_closed");
      assert.equal(fixture.state.commitCalls.length,
        when === "beforeCommit" ? 1 : 0);
      assert.equal(fixture.state.intents[0].state, "unknown");
      assert.equal(fixture.calls.perform, 0);
    });
  }
});

test("store locks and compares the expected position snapshot inside the atomic transaction before writing", async () => {
  const statements = [];
  const expectedSnapshot = {
    sourceSignalId,
    symbol,
    status: "unknown",
    accountId,
    environment: "vst",
    quantity: "0.1",
  };
  const currentSnapshot = {
    ...expectedSnapshot,
    status: "closed",
    manualResolution: { outcome: "owner_closed" },
  };
  const pool = {
    async query() { throw new Error("transaction checkout required"); },
    async connect() {
      return {
        async query(sql, params = []) {
          statements.push({ sql, params });
          if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes("pg_advisory_xact_lock")) {
            return { rowCount: 1, rows: [{}] };
          }
          if (sql.includes("FROM vst_order_intents i")) {
            return {
              rowCount: 1,
              rows: [{
                source_signal_id: sourceSignalId,
                phase,
                client_order_id: stopClientOrderId,
                request: { operation: "raise_stop" },
                state: "unknown",
                exchange_order_id: stopOrderId,
                outcome: { reason: "pending" },
                created_at: "created",
                updated_at: "updated",
                signal_source_signal_id: sourceSignalId,
                signal_body: {},
                signal_body_hash: "hash",
                signal_status: "unknown",
                signal_reason: null,
                signal_received_at: "received",
                signal_updated_at: "updated",
              }],
            };
          }
          if (sql.includes("FROM vst_positions WHERE source_signal_id = $1 FOR UPDATE")) {
            return {
              rowCount: 1,
              rows: [{
                source_signal_id: sourceSignalId,
                symbol,
                status: "closed",
                snapshot: currentSnapshot,
                updated_at: "closed-after-read",
              }],
            };
          }
          throw new Error(`unexpected SQL in compare-and-set test: ${sql}`);
        },
        release() {},
      };
    },
  };
  const store = createVstStore(pool);
  await assert.rejects(store.commitVerifiedIntent({
    sourceSignalId,
    clientOrderId: stopClientOrderId,
    position: { ...expectedSnapshot, status: "open" },
    signalStatus: "open",
    exchangeOrderId: stopOrderId,
    outcome: { status: "filled", verified: true },
    expectedPositionSnapshot: expectedSnapshot,
    expectedPositionUpdatedAt: updatedAt,
  }), /VST position changed before verified intent commit/);
  const positionLock = statements.findIndex(({ sql }) =>
    sql.includes("FROM vst_positions WHERE source_signal_id = $1 FOR UPDATE"));
  assert.ok(positionLock >= 0, "the position is re-read under a transaction row lock");
  assert.equal(statements.some(({ sql }) => sql.includes("INSERT INTO vst_positions")), false);
  assert.equal(statements.at(-1).sql, "ROLLBACK");
});

test("equal-price no-op recovery persists only under the full strict intent, entry, position, and stop CAS", async () => {
  const signalId = "strict-equal-stop-signal";
  const strictPhase = `raise_stop-core-${now}`;
  const strictClientId = `vst-${createHash("sha256")
    .update(`${signalId}:${strictPhase}`).digest("hex").slice(0, 30)}`;
  const strictUpdatedAt = new Date(now - 2_000).toISOString();
  const entryAtValue = new Date(now - 60_000).toISOString();
  const originalStop = {
    verified: true,
    orderId: "2105952049086160896",
    positionId: "2105271515231551489",
    quantity: 18850.91,
    stopPrice: "0.4915",
    mainOrderId: "",
  };
  const snapshot = {
    sourceSignalId: signalId,
    symbol: "REUSDT",
    status: "open",
    environment: "vst",
    accountId,
    entryClientOrderId: "entry-client-1",
    entryOrderType: "MARKET",
    entryAt: entryAtValue,
    exchangePositionId: "2105271515231551489",
    remainingQty: 18850.91,
    verifiedProtectiveStops: { core: originalStop },
  };
  const entryIntent = {
    sourceSignalId: signalId,
    phase: "market-entry",
    clientOrderId: "entry-client-1",
    state: "reconciled",
    request: {
      operation: "entry",
      environment: "vst",
      accountId,
      symbol: "REUSDT",
      entryOrderType: "MARKET",
      quantity: 18850.91,
      intentCreatedAt: now - 61_000,
    },
    exchangeOrderId: "2105271515000000000",
    outcome: {
      verified: true,
      status: "filled",
      fillQuantity: 18850.91,
      positionId: "2105271515231551489",
    },
  };
  const entryProof = {
    entryClientOrderId: "entry-client-1",
    entryOrderId: "2105271515000000000",
    positionId: "2105271515231551489",
    entryOrderType: "MARKET",
    intentCreatedAt: now - 61_000,
    quantity: 18850.91,
  };
  const request = {
    operation: "raise_stop",
    sourceSignalId: signalId,
    environment: "vst",
    accountId,
    symbol: "REUSDT",
    leg: "core",
    positionId: "2105271515231551489",
    entryClientOrderId: "entry-client-1",
    entryOrderType: "MARKET",
    quantity: 18850.91,
    previousQuantity: 18850.91,
    stopPrice: "0.4915",
    entryProof,
    priorPosition: structuredClone(snapshot),
    nextPosition: structuredClone(snapshot),
  };
  const outcome = {
    reason: "exchange_state_not_verified",
    submissionError: "BingXLiveApiError",
    submissionErrorMessage:
      "VST protective stop upgrades may only raise the stop",
  };
  const intentRow = {
    source_signal_id: signalId,
    phase: strictPhase,
    client_order_id: strictClientId,
    request,
    state: "unknown",
    exchange_order_id: null,
    outcome,
  };
  const statements = [];
  const pool = {
    async query() { throw new Error("transaction checkout required"); },
    async connect() {
      return {
        async query(sql, params = []) {
          statements.push({ sql, params });
          if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes("pg_advisory_xact_lock")) {
            return { rowCount: 1, rows: [{}] };
          }
          if (sql.includes("FROM vst_signals")) {
            return { rowCount: 1, rows: [{ source_signal_id: signalId, status: "unknown" }] };
          }
          if (sql.includes("FROM vst_positions")) {
            return {
              rowCount: 1,
              rows: [{
                source_signal_id: signalId,
                status: "open",
                snapshot,
                updated_at_text: strictUpdatedAt,
              }],
            };
          }
          if (sql.includes("FROM vst_order_intents") &&
              sql.includes("client_order_id = $2")) {
            return { rowCount: 1, rows: [intentRow] };
          }
          if (sql.includes("phase = 'market-entry'")) {
            return {
              rowCount: 1,
              rows: [{
                source_signal_id: signalId,
                phase: "market-entry",
                client_order_id: entryIntent.clientOrderId,
                request: entryIntent.request,
                state: entryIntent.state,
                exchange_order_id: entryIntent.exchangeOrderId,
                outcome: entryIntent.outcome,
              }],
            };
          }
          if (sql.includes("state IN ('prepared', 'submitted', 'unknown')")) {
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes("UPDATE vst_order_intents")) {
            return { rowCount: 1, rows: [{ client_order_id: strictClientId }] };
          }
          if (sql.includes("UPDATE vst_signals")) {
            return { rowCount: 1, rows: [{ source_signal_id: signalId }] };
          }
          if (sql.includes("INSERT INTO vst_events")) return { rowCount: 1, rows: [] };
          throw new Error(`unexpected SQL in equal-price strict persistence test: ${sql}`);
        },
        release() {},
      };
    },
  };
  const store = createVstStore(pool);
  const result = await store.recoverRaiseStopEqualPriceNoop({
    sourceSignalId: signalId,
    clientOrderId: strictClientId,
    phase: strictPhase,
    expectedRequest: request,
    expectedOutcome: outcome,
    expectedPositionSnapshot: snapshot,
    expectedPositionUpdatedAt: strictUpdatedAt,
    expectedEntryIntent: entryIntent,
    entryProof,
    oldPositionAndStop: {
      positionId: "2105271515231551489",
      quantity: 18850.91,
      stopOrderId: "2105952049086160896",
      stopPrice: "0.4915",
      executionProof: {
        orderId: "2105952049086160896",
        executedQty: "0.00",
      },
    },
    requestStartedAtMs: now - 1_000,
    maxEvidenceAgeMs: 5_000,
    clock: () => now,
  });
  assert.deepEqual(result, { kind: "recovered" });
  assert.ok(statements.some(({ sql }) => sql.includes("FOR UPDATE")));
  assert.ok(statements.some(({ sql }) =>
    sql.includes("exchange_order_id IS NULL") && sql.includes("outcome = $6::jsonb")));
  assert.equal(statements.at(-1).sql, "COMMIT");
});