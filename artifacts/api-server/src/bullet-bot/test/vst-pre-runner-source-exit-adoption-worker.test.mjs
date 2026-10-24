import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createVstWorker } from "../vst-worker.mjs";

const now = Date.now();
const accountId = "worker-vst-account";
const sourceSignalId = "worker-pre-runner-adoption";
const symbol = "BTCUSDT";
const positionId = "worker-position-1";
const quantity = "100";
const entryOrderId = "worker-entry-order";
const entryClientOrderId = "worker-entry-client";
const intentCreatedAt = now - 120_000;
const phase = `impulse-runner-breakeven-abort-${intentCreatedAt}`;
const oldClientOrderId = `vst-${createHash("sha256")
  .update(`${sourceSignalId}:${phase}`).digest("hex").slice(0, 30)}`;
const originalStopId = "worker-original-stop";
const coreStopId = "worker-core-stop";

function makeRequestAndIntent({
  outcome = { error: "Error", errorMessage: "legacy request timed out" },
} = {}) {
  const originalStop = {
    orderId: originalStopId, quantity, stopPrice: "9.5",
  };
  const coreStop = {
    orderId: coreStopId, quantity: "80", stopPrice: "9.7",
  };
  const request = {
    operation: "close_pre_runner_split",
    sourceSignalId,
    environment: "vst",
    accountId,
    symbol,
    closeIntentId: oldClientOrderId,
    positionId,
    totalQuantity: quantity,
    originalStop,
    coreStop,
  };
  return {
    sourceSignalId,
    phase,
    clientOrderId: oldClientOrderId,
    request,
    state: "unknown",
    exchangeOrderId: null,
    outcome,
    createdAt: new Date(intentCreatedAt),
    updatedAt: new Date(now - 20_000),
  };
}

function fixture({
  sourceExitsEnabled = true,
  sourceExit = "valid",
  proof = "valid",
  adoption = "adopted",
  outcome,
  unrelatedExit = false,
} = {}) {
  const closeIntent = makeRequestAndIntent({ outcome });
  const sourceExitRequestId = `source-exit-${"c".repeat(64)}`;
  const entryAt = new Date(intentCreatedAt + 5_000).toISOString();
  const entryRequest = {
    operation: "entry",
    environment: "vst",
    accountId,
    symbol,
    entryOrderType: "MARKET",
    quantity,
    intentCreatedAt: intentCreatedAt - 1_000,
    signal: { sourceSignalId, symbol, orderType: "market" },
    sizing: { environment: "vst", quantity },
    priorPosition: { entryOrderType: "MARKET" },
  };
  const entryIntent = {
    sourceSignalId,
    phase: "market-entry",
    clientOrderId: entryClientOrderId,
    request: entryRequest,
    state: "reconciled",
    exchangeOrderId: entryOrderId,
    outcome: {
      operation: "entry",
      verified: true,
      status: "filled",
      entryOrderId,
      positionId,
      fillPrice: "10",
      fillQuantity: quantity,
      totalQuantity: quantity,
      coreQuantity: "80",
      runnerQuantity: "20",
      splitStage: "complete",
    },
    createdAt: new Date(intentCreatedAt - 1_000),
    updatedAt: new Date(intentCreatedAt),
  };
  const originalStop = {
    orderId: originalStopId, positionId, quantity, stopPrice: "9.5",
  };
  const coreStop = {
    orderId: coreStopId, positionId, quantity: "80", stopPrice: "9.7",
  };
  const snapshot = {
    sourceSignalId,
    symbol,
    environment: "vst",
    accountId,
    patternId: "impulse_buy",
    status: "closing",
    executionStatus: "closing",
    exchangePositionId: positionId,
    quantity,
    remainingQty: quantity,
    entryAt,
    entryPrice: "10",
    entryOrderId,
    entryClientOrderId,
    entryOrderType: "MARKET",
    verifiedFill: { price: "10", quantity, at: entryAt },
    signalStopPrice: "9.5",
    originalStopQuantity: quantity,
    originalStopPositionId: positionId,
    coreStopOrderId: coreStopId,
    coreStopPositionId: positionId,
    coreStopQuantity: "80",
    coreStopPrice: "9.7",
    verifiedProtectiveStops: { core: { ...coreStop, verified: true } },
    split: {
      stage: "runner_pending",
      positionId,
      totalQuantity: quantity,
      originalStopOrderId: originalStopId,
      signalStopPrice: "9.5",
      entryOrderId,
      entryOrderType: "MARKET",
      coreStop,
      runnerStop: null,
    },
  };
  const position = {
    sourceSignalId, symbol, status: "closing", snapshot, updatedAt: new Date(now - 1_000),
  };
  const exitEvidence = {
    sourceSignalId,
    symbol,
    reason: "source_closed",
    sourceStatus: "profit",
    sourceUpdatedAt: null,
    sourceClosedAt: new Date(now - 20_000).toISOString(),
    sourceExitPrice: "10.2",
    sourceCancelReason: null,
    exitDecisionAt: new Date(now - 20_000).toISOString(),
    asOf: new Date(now - 5_000).toISOString(),
    observedAt: new Date(now - 5_000).toISOString(),
  };
  const sourceExitRequest = {
    requestId: sourceExitRequestId,
    id: sourceExitRequestId,
    sourceSignalId,
    symbol,
    reason: "source_closed",
    evidence: exitEvidence,
    asOf: exitEvidence.asOf,
    observedAt: exitEvidence.observedAt,
    createdAt: new Date(now - 4_000).toISOString(),
    eventId: 10,
  };
  const otherRequest = {
    ...sourceExitRequest,
    requestId: "source-exit-other-symbol",
    id: "source-exit-other-symbol",
    sourceSignalId: "unentered-other-symbol",
    symbol: "ETHUSDT",
    eventId: 11,
    evidence: {
      ...exitEvidence,
      sourceSignalId: "unentered-other-symbol",
      symbol: "ETHUSDT",
    },
  };
  const pendingSourceExits = sourceExit === "missing"
    ? []
    : [{
      ...sourceExitRequest,
      ...(sourceExit === "unconfirmed" ? { reason: "not_confirmed" } : {}),
      ...(sourceExit === "other_symbol" ? { symbol: "ETHUSDT" } : {}),
    }, ...(unrelatedExit ? [otherRequest] : [])];
  const historyCoverage = [{
    verified: true,
    endpoint: "/openApi/swap/v2/trade/fillHistory",
    currency: "USDT",
    startTs: intentCreatedAt - 32_000,
    endTs: now - 1_000,
    rawCount: 1,
    pageSize: 1_000,
    passes: 2,
    terminalPage: 2,
    snapshotSha256: "a".repeat(64),
    observedAt: new Date(now - 500).toISOString(),
  }];
  const openEvidence = {
    verified: true,
    environment: "vst",
    accountId,
    symbol,
    positionId,
    quantity,
    observedAt: new Date(now - 400).toISOString(),
    stops: [
      { ...originalStop },
      { ...coreStop },
    ],
    entryProof: {
      entryClientOrderId,
      entryOrderId,
      positionId,
      entryOrderType: "MARKET",
      intentCreatedAt: entryRequest.intentCreatedAt,
      quantity,
    },
    historyCoverage,
    coverageEndTs: historyCoverage[0].endTs,
    entryFills: [{
      symbol: "BTC-USDT", orderId: entryOrderId, tradeId: "entry-trade-1",
      positionID: positionId, side: "BUY", positionSide: "LONG",
      filledTime: entryAt, qty: quantity, price: "10",
    }],
  };
  const evidence = structuredClone(openEvidence);
  if (proof === "unverified") evidence.verified = false;
  if (proof === "stale") evidence.observedAt = new Date(now - 6_000).toISOString();
  if (proof === "mismatch") evidence.positionId = "foreign-position";

  const db = {
    position: structuredClone(position),
    intents: [structuredClone(closeIntent), structuredClone(entryIntent)],
    pendingSourceExits,
    finishedSourceExits: [],
    events: [],
    signals: new Map([[sourceSignalId, { status: "error", reason: null }]]),
    adoptionCalls: [],
    sourceExitMutationCalls: [],
    positionMutations: 0,
  };
  if (unrelatedExit) {
    db.signals.set(otherRequest.sourceSignalId, { status: "pending", reason: null });
  }
  const account = {
    positions: [{
      symbol: "BTC-USDT",
      positionId,
      positionAmt: quantity,
      positionSide: "LONG",
      leverage: 10,
      marginMode: "ISOLATED",
    }],
    openOrders: [
      {
        symbol: "BTC-USDT", orderId: originalStopId, mainOrderId: entryOrderId,
        positionID: positionId, origQty: quantity, stopPrice: "9.5",
        type: "STOP_MARKET", status: "NEW", side: "SELL",
        positionSide: "LONG", workingType: "MARK_PRICE",
      },
      {
        symbol: "BTC-USDT", orderId: coreStopId, mainOrderId: entryOrderId,
        positionID: positionId, origQty: "80", stopPrice: "9.7",
        type: "STOP_MARKET", status: "NEW", side: "SELL",
        positionSide: "LONG", workingType: "MARK_PRICE",
      },
    ],
  };
  const accountState = () => ({
    verified: true, environment: "vst", accountId,
    positions: structuredClone(account.positions),
    openOrders: structuredClone(account.openOrders),
  });

  const store = {
    async withLeaderLock(callback) { return callback(); },
    async getPending() { return null; },
    async reserveIntent({ sourceSignalId: id, phase: intentPhase, clientOrderId, request }) {
      const existing = db.intents.find((item) => item.sourceSignalId === id &&
        item.phase === intentPhase);
      if (existing) return { kind: "existing", intent: structuredClone(existing) };
      const intent = {
        sourceSignalId: id, phase: intentPhase, clientOrderId, request,
        state: "prepared", exchangeOrderId: null, outcome: null,
        createdAt: new Date(now), updatedAt: new Date(now),
      };
      db.intents.push(intent);
      return { kind: "new", intent: structuredClone(intent) };
    },
    async markIntent(clientOrderId, state, values = {}) {
      const intent = db.intents.find((item) => item.clientOrderId === clientOrderId);
      if (!intent) throw new Error("test intent not found");
      intent.state = state;
      if (Object.hasOwn(values, "exchangeOrderId")) {
        intent.exchangeOrderId = values.exchangeOrderId;
      }
      if (Object.hasOwn(values, "outcome")) intent.outcome = values.outcome;
      intent.updatedAt = new Date(now);
      return structuredClone(intent);
    },
    async listUnresolvedIntents() {
      return db.intents.filter((item) =>
        ["prepared", "submitted", "unknown"].includes(item.state))
        .map((item) => structuredClone(item));
    },
    async getIntent(id, phaseOrClientId) {
      const item = db.intents.find((row) => row.sourceSignalId === id &&
        (row.phase === phaseOrClientId || row.clientOrderId === phaseOrClientId));
      return item ? structuredClone(item) : null;
    },
    async getPosition(id) {
      return id === sourceSignalId ? structuredClone(db.position) : null;
    },
    async listOpenPositions() {
      return db.position && db.position.status !== "closed"
        ? [structuredClone(db.position)] : [];
    },
    async listPendingSourceExitRequests({ sourceSignalId: id } = {}) {
      return db.pendingSourceExits.filter((row) =>
        !id || row.sourceSignalId === id).map((row) => structuredClone(row));
    },
    async queueSourceExitRequests() { return { queued: [], refreshed: [], rejected: [] }; },
    async hasPendingSourceExitRequest(id) {
      return db.pendingSourceExits.some((row) => row.sourceSignalId === id);
    },
    async finishSourceExitRequest(requestId, details) {
      const index = db.pendingSourceExits.findIndex((row) => row.requestId === requestId);
      if (index >= 0) {
        const [request] = db.pendingSourceExits.splice(index, 1);
        db.finishedSourceExits.push({ request, details });
      }
      return { kind: "source_exit_completed" };
    },
    async setSignalStatus(id, status, reason = null) {
      db.signals.set(id, { status, reason });
    },
    async recordEvent(id, kind, detail) { db.events.push({ id, kind, detail }); },
    async upsertPosition(next) {
      db.position = {
        ...db.position,
        sourceSignalId: next.sourceSignalId,
        symbol: next.symbol,
        status: next.status,
        snapshot: structuredClone(next),
        updatedAt: new Date(now),
      };
      db.positionMutations++;
      return structuredClone(db.position);
    },
    async commitVerifiedIntent({
      sourceSignalId: id, clientOrderId, position: nextPosition, signalStatus,
      exchangeOrderId, outcome: nextOutcome,
    }) {
      const intent = db.intents.find((item) => item.clientOrderId === clientOrderId);
      if (!intent) throw new Error("test committed intent not found");
      intent.state = "reconciled";
      intent.exchangeOrderId = exchangeOrderId ?? intent.exchangeOrderId;
      intent.outcome = structuredClone(nextOutcome);
      db.position = {
        sourceSignalId: id,
        symbol: nextPosition.symbol,
        status: nextPosition.status,
        snapshot: structuredClone(nextPosition),
        updatedAt: new Date(now),
      };
      db.positionMutations++;
      await this.setSignalStatus(id, signalStatus);
      return {
        position: structuredClone(db.position),
        intent: structuredClone(intent),
        signal: { status: signalStatus },
      };
    },
    async adoptPreRunnerOpenForSourceExit(args) {
      db.adoptionCalls.push(structuredClone(args));
      if (adoption !== "adopted") return { kind: "refused", reason: "test_cas_conflict" };
      const intent = db.intents.find((item) => item.clientOrderId === args.clientOrderId);
      if (!intent || intent.state !== "unknown") return { kind: "refused" };
      intent.state = "failed";
      intent.outcome = {
        ...intent.outcome,
        originalExecution: "unknown_unproven",
        sourceExitCurrentPositionAdoption: {
          reason: args.expectedSourceExitRequest.reason,
          entryProof: args.evidence.entryProof,
          observedAt: args.evidence.observedAt,
          sourceExitRequestId: args.expectedSourceExitRequest.requestId,
        },
      };
      return { kind: "adopted" };
    },
  };
  const features = [
    "vst_only",
    "complete_order_lookup",
    "guarded_long10_leverage_preparation",
    "atomic_protected_market_entry",
    "verified_core_stop_state",
    "verified_exact_full_position_close",
    "verified_position_state",
    "verified_source_flat_stop_cleanup",
  ];
  const performCalls = [];
  const broker = {
    async getCapabilities() {
      return { verified: true, environment: "vst", accountId, features };
    },
    async readAccountState() { return accountState(); },
    async readMarketMark() { return { verified: true, symbol, price: "10" }; },
    async readPosition() { throw new Error("flat position requires no residual read"); },
    async readPlanningInputs() { return {}; },
    async verifyPreRunnerOpenForSourceExit() {
      return structuredClone(evidence);
    },
    async verifySourceExitEntryProof() {
      return {
        verified: true,
        status: "filled",
        exchangeOrderId: entryOrderId,
        positionId,
        entryOrderType: "MARKET",
        fill: { price: "10", quantity, at: entryAt },
      };
    },
    async reconcileIntent({ request, clientOrderId }) {
      if (request.operation === "close_pre_runner_split") {
        return { verified: false, status: "unknown" };
      }
      if (request.operation === "close_leg" && request.sourceExit?.stage === "close") {
        return {
          verified: true,
          status: "filled",
          exchangeOrderId: "source-close-exchange-order",
          position: { verified: true, symbol: request.symbol, positionId, quantity: 0 },
          fill: {
            price: "10.1", quantity: request.quantity, at: new Date(now).toISOString(),
            fees: "0",
          },
        };
      }
      if (request.operation === "cancel_flat_split_stop") {
        const remainingKnownStopOrderIds = account.openOrders
          .filter((row) => row.symbol === "BTC-USDT")
          .map((row) => row.orderId);
        return {
          verified: true,
          status: "canceled",
          positionId,
          flat: true,
          canceledStopOrderId: request.stopToCancel.orderId,
          cancellationIntentId: clientOrderId,
          knownRemainingStopOrderIds: request.knownRemainingStopOrderIds,
          remainingKnownStopOrderIds,
        };
      }
      return { verified: false, status: "unknown" };
    },
    async performIntent({ clientOrderId, phase: operationPhase, request }) {
      performCalls.push({ clientOrderId, phase: operationPhase, request: structuredClone(request) });
      if (request.operation === "close_pre_runner_split") {
        throw new Error("legacy ambiguous close must never be submitted again");
      }
      if (request.operation === "close_leg" && request.sourceExit?.stage === "close") {
        db.sourceExitMutationCalls.push(request);
        account.positions = [];
        return { exchangeOrderId: "source-close-exchange-order" };
      }
      if (request.operation === "cancel_flat_split_stop") {
        const index = account.openOrders.findIndex((row) =>
          row.orderId === request.stopToCancel.orderId);
        if (index >= 0) account.openOrders.splice(index, 1);
        return { exchangeOrderId: `cancel-${request.stopToCancel.orderId}` };
      }
      throw new Error(`Unexpected test exchange mutation: ${request.operation}`);
    },
  };
  const workerOptions = {
    store,
    broker,
    clock: () => now,
    sourceExitsEnabled,
    sizingLimits: { environment: "vst" },
  };
  const worker = createVstWorker(workerOptions);
  return {
    worker, workerOptions, store, broker, db, account, performCalls,
    sourceExitRequest, evidence,
  };
}

async function quietRunOnce(worker) {
  const originalWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    return await worker.runOnce();
  } finally {
    process.stderr.write = originalWrite;
  }
}

test("unknown legacy abort is retired without replay, then a fresh source-exit key closes and cleans owned stops", async () => {
  const data = fixture({ unrelatedExit: true });
  const first = await quietRunOnce(data.worker);
  assert.equal(first.kind, "acted");
  assert.equal(first.operation, "source_exit_prerequisite_reconciled");
  assert.equal(data.db.adoptionCalls.length, 1);
  const oldIntent = data.db.intents.find((item) => item.clientOrderId === oldClientOrderId);
  assert.equal(oldIntent.state, "failed");
  assert.equal(oldIntent.outcome.originalExecution, "unknown_unproven");
  assert.equal(data.db.position.status, "closing");
  assert.equal(data.db.position.snapshot.split.stage, "runner_pending");
  assert.equal(data.performCalls.some((call) =>
    call.clientOrderId === oldClientOrderId ||
    call.request.operation === "close_pre_runner_split"), false);
  assert.equal(data.db.adoptionCalls[0].expectedSourceExitRequest.requestId,
    data.sourceExitRequest.requestId);

  // A restarted worker sees the failed old intent as terminal. It proceeds
  // only with the durable, independently keyed source exit and stop cleanup.
  for (let tick = 0; tick < 5 && data.db.pendingSourceExits.length; tick++) {
    const restarted = createVstWorker({
      store: makeRestartStore(data),
      broker: makeRestartBroker(data),
      clock: () => now,
      sourceExitsEnabled: true,
      sizingLimits: { environment: "vst" },
    });
    await quietRunOnce(restarted);
  }
  assert.equal(data.db.adoptionCalls.length, 1, "restart cannot adopt the legacy intent twice");
  assert.equal(data.db.intents.find((item) =>
    item.clientOrderId === oldClientOrderId).state, "failed");
  assert.equal(data.performCalls.some((call) =>
    call.request.operation === "close_pre_runner_split"), false);
  assert.ok(data.db.sourceExitMutationCalls.length >= 1);
  const sourceClose = data.performCalls.find((call) =>
    call.request.sourceExit?.stage === "close");
  assert.ok(sourceClose);
  assert.notEqual(sourceClose.clientOrderId, oldClientOrderId);
  assert.equal(sourceClose.request.operation, "close_leg");
  assert.ok(data.performCalls.some((call) =>
    call.request.operation === "cancel_flat_split_stop"),
  "source exit lifecycle advances through protected-stop cleanup");
  assert.equal(data.db.position.status, "closed");
  assert.equal(data.db.position.snapshot.split.stage, "closed");
  assert.equal(data.db.pendingSourceExits.length, 0,
    "the unrelated unentered symbol continues after BTC source-exit cleanup");
  assert.equal(data.db.finishedSourceExits.length, 2);
});

function makeRestartStore(data) {
  // The original fixture closes over its stateful adapter. The factory keeps
  // the same durable objects but supplies fresh method bindings to the new
  // worker instance, matching restart semantics.
  return data.store;
}

function makeRestartBroker(data) {
  return data.broker;
}

test("worker declines adoption for disabled feature, sent writes, bad source requests, failed proof, and CAS refusal", async (t) => {
  const cases = [
    ["feature disabled", { sourceExitsEnabled: false }],
    ["sent mutation provenance", {
      outcome: {
        error: "Error",
        errorMessage: "transport timed out",
        mutationProvenance: {
          operation: "close_pre_runner_split",
          boundary: "after_transport_started",
          mutationSubmitted: true,
        },
      },
    }],
    ["source exit missing", { sourceExit: "missing" }],
    ["source exit unconfirmed", { sourceExit: "unconfirmed" }],
    ["source exit for another symbol", { sourceExit: "other_symbol" }],
    ["broker proof unverified", { proof: "unverified" }],
    ["broker proof stale", { proof: "stale" }],
    ["broker proof identity mismatch", { proof: "mismatch" }],
    ["store CAS refuses", { adoption: "refused" }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async () => {
      const data = fixture(options);
      const beforePosition = structuredClone(data.db.position);
      const beforeIntent = structuredClone(
        data.db.intents.find((item) => item.clientOrderId === oldClientOrderId),
      );
      await quietRunOnce(data.worker);
      assert.equal(data.db.adoptionCalls.length,
        options.adoption === "refused" ? 1 : 0);
      assert.equal(data.db.intents.find((item) =>
        item.clientOrderId === oldClientOrderId).state, "unknown");
      assert.equal(data.performCalls.some((call) =>
        call.clientOrderId === oldClientOrderId ||
        call.request.operation === "close_pre_runner_split"), false);
      assert.deepEqual(data.db.position, beforePosition);
      const finalIntent = data.db.intents.find((item) =>
        item.clientOrderId === oldClientOrderId);
      assert.deepEqual(finalIntent.outcome.mutationProvenance,
        beforeIntent.outcome.mutationProvenance);
      if (options.adoption === "refused") {
        assert.equal(data.db.adoptionCalls.length, 1);
        assert.equal(data.db.positionMutations, 0);
      }
    });
  }
});