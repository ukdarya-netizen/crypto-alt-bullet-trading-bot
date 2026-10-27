import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createVstWorker } from "../vst-worker.mjs";
import { buildVstProofEvidence } from "../vst-proof-evidence.mjs";
import { recordVstDiagnostic } from "../vst-diagnostics.mjs";

const ORIGINAL_PAUSE = process.env.BULLET_VST_PAUSED;
process.env.BULLET_VST_PAUSED = "0";
after(() => {
  if (ORIGINAL_PAUSE === undefined) delete process.env.BULLET_VST_PAUSED;
  else process.env.BULLET_VST_PAUSED = ORIGINAL_PAUSE;
});

const NOW = Date.parse("2026-10-02T00:00:00.000Z");
const ACCOUNT_ID = "batch-test-vst-account";
const CAPABILITIES = [
  "vst_only",
  "complete_order_lookup",
  "guarded_long10_leverage_preparation",
  "atomic_protected_market_entry",
  "verified_core_stop_state",
  "verified_exact_full_position_close",
  "verified_position_state",
];
const EXIT_RULES = {
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

function makeSignals(count, now = NOW) {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    const symbol = `BATCH${String(n).padStart(2, "0")}USDT`;
    return {
      sourceSignalId: `batch-signal-${n}`,
      confirmationStatus: "confirmed",
      patternStatus: "approved",
      side: "buy",
      orderType: "market",
      patternId: "balanced_grind",
      symbol,
      signalAt: new Date(now).toISOString(),
      referencePrice: "100",
      stopLoss: "95",
      payload: { rulesVersion: "bullet-long-exits-v2", exitRules: EXIT_RULES },
    };
  });
}

function memoryLedger(signals) {
  const data = {
    candidates: signals.map((body, index) => ({
      sourceSignalId: body.sourceSignalId,
      body,
      status: "pending",
      receivedAt: new Date(NOW + index).toISOString(),
    })),
    intents: [],
    positions: [],
    events: [],
    sourceExitRequests: [],
    statusHistory: [],
    replayedCommits: 0,
  };
  const active = new Set(["pending", "planning", "opening"]);
  const store = {
    data,
    async withLeaderLock(callback) { return callback(); },
    async getPending() {
      const row = data.candidates.find((candidate) => active.has(candidate.status));
      return row ?? null;
    },
    async listPendingCandidatesPage({ limit, after } = {}) {
      const priority = (row) => row.status === "opening" ? 0 :
        row.status === "planning" ? 1 : 2;
      const rows = data.candidates.filter((row) => active.has(row.status))
        .sort((a, b) => priority(a) - priority(b) ||
          a.receivedAt.localeCompare(b.receivedAt) ||
          a.sourceSignalId.localeCompare(b.sourceSignalId))
        .filter((row) => !after ||
          priority(row) > after.priority ||
          priority(row) === after.priority &&
            (row.receivedAt > after.receivedAt ||
              row.receivedAt === after.receivedAt &&
                row.sourceSignalId > after.sourceSignalId));
      const pageRows = rows.slice(0, limit);
      const last = pageRows.at(-1);
      return {
        rows: pageRows,
        nextCursor: last ? {
          priority: priority(last),
          receivedAt: last.receivedAt,
          sourceSignalId: last.sourceSignalId,
        } : null,
        hasMore: rows.length > pageRows.length,
      };
    },
    async setSignalStatus(sourceSignalId, status, reason = null) {
      const row = data.candidates.find((candidate) =>
        candidate.sourceSignalId === sourceSignalId);
      if (row) row.status = status;
      data.statusHistory.push({ sourceSignalId, status, reason });
    },
    async recordEvent(...event) { data.events.push(event); },
    async listUnresolvedIntents() {
      return data.intents.filter((intent) =>
        ["prepared", "submitted", "unknown"].includes(intent.state))
        .map((intent) => ({ ...intent, outcome: intent.outcome ?? intent.detail?.outcome }));
    },
    async getIntent(sourceSignalId, phase) {
      const row = data.intents.find((intent) =>
        intent.sourceSignalId === sourceSignalId && intent.phase === phase);
      return row ? { ...row, outcome: row.outcome ?? row.detail?.outcome } : null;
    },
    async reserveIntent(intent) {
      const existing = data.intents.find((row) =>
        row.sourceSignalId === intent.sourceSignalId && row.phase === intent.phase);
      if (existing) {
        const withoutTimestamp = (request) => {
          const { intentCreatedAt, ...rest } = request ?? {};
          return rest;
        };
        assert.equal(existing.clientOrderId, intent.clientOrderId);
        assert.deepEqual(withoutTimestamp(existing.request),
          withoutTimestamp(intent.request));
        return { kind: "existing", intent: existing };
      }
      const row = { ...intent, state: "prepared" };
      data.intents.push(row);
      return { kind: "new", intent: row };
    },
    async markIntent(clientOrderId, state, detail = {}) {
      const intent = data.intents.find((row) => row.clientOrderId === clientOrderId);
      assert.ok(intent, `durable intent ${clientOrderId} exists`);
      Object.assign(intent, { state, detail, outcome: detail.outcome ?? null });
      if (Object.hasOwn(detail, "exchangeOrderId")) {
        intent.exchangeOrderId = detail.exchangeOrderId;
      }
    },
    async commitVerifiedIntent(commit) {
      const intent = data.intents.find((row) =>
        row.clientOrderId === commit.clientOrderId);
      assert.ok(intent, "verified fill commits only after a durable intent");
      if (intent.state === "reconciled") {
        data.replayedCommits += 1;
        assert.deepEqual(intent.detail?.outcome, commit.outcome);
        return { replayed: true };
      }
      const existing = data.positions.find((row) =>
        row.sourceSignalId === commit.sourceSignalId);
      const position = {
        sourceSignalId: commit.sourceSignalId,
        symbol: commit.position.symbol,
        status: commit.position.status,
        snapshot: commit.position,
      };
      if (existing) Object.assign(existing, position);
      else data.positions.push(position);
      Object.assign(intent, {
        state: "reconciled",
        exchangeOrderId: commit.exchangeOrderId,
        detail: { outcome: commit.outcome },
        outcome: commit.outcome,
      });
      const candidate = data.candidates.find((row) =>
        row.sourceSignalId === commit.sourceSignalId);
      if (candidate) candidate.status = commit.signalStatus;
      if (commit.followUpIntent) {
        data.intents.push({ ...commit.followUpIntent, state: "prepared" });
      }
      if (commit.eventKind) {
        data.events.push([
          commit.sourceSignalId, commit.eventKind, commit.eventDetail,
          commit.clientOrderId,
        ]);
      }
      return { replayed: false };
    },
    async listOpenPositions() {
      return data.positions.filter((row) =>
        ["open", "opening", "closing", "unknown"].includes(row.status));
    },
    async upsertPosition(position) {
      const existing = data.positions.find((row) =>
        row.sourceSignalId === position.sourceSignalId);
      const row = {
        sourceSignalId: position.sourceSignalId,
        symbol: position.symbol,
        status: position.status,
        snapshot: position,
      };
      if (existing) Object.assign(existing, row);
      else data.positions.push(row);
    },
    async listPendingSourceExitRequests() {
      return data.sourceExitRequests.filter((row) => row.state === "pending");
    },
    async hasPendingSourceExitRequest(sourceSignalId) {
      return data.sourceExitRequests.some((row) =>
        row.state === "pending" && row.sourceSignalId === sourceSignalId);
    },
    async queueSourceExitRequests() {},
    async finishSourceExitRequest(requestId, result) {
      const row = data.sourceExitRequests.find((item) => item.requestId === requestId);
      if (row) Object.assign(row, { state: "finished", result });
    },
    async getPosition(sourceSignalId) {
      return data.positions.find((row) => row.sourceSignalId === sourceSignalId) ?? null;
    },
  };
  return store;
}

function makeBroker(store, {
  nowRef = { value: NOW },
  availableMargin = "100000",
  planningDelay = async () => {},
  unsafeAccount = false,
  staleFirstQuote = false,
  safetySnapshot = null,
} = {}) {
  const metrics = {
    activePlanningReads: 0,
    maxPlanningReads: 0,
    planningReads: new Map(),
    activeMutations: 0,
    maxMutations: 0,
    mutationOrder: [],
    reconciliations: [],
    entrySubmissions: [],
    accountReads: 0,
  };
  const exchange = new Map();
  const broker = {
    async getCapabilities() {
      return {
        environment: "vst",
        verified: true,
        accountId: ACCOUNT_ID,
        features: CAPABILITIES,
      };
    },
    async readPlanningInputs(signal) {
      metrics.activePlanningReads += 1;
      metrics.maxPlanningReads = Math.max(metrics.maxPlanningReads,
        metrics.activePlanningReads);
      metrics.planningReads.set(signal.sourceSignalId,
        (metrics.planningReads.get(signal.sourceSignalId) ?? 0) + 1);
      const readStartedAt = nowRef.value;
      try {
        await planningDelay(signal, metrics, nowRef);
        return {
          balanceSnapshot: {
            asset: "VST",
            balance: availableMargin,
            equity: availableMargin,
            availableMargin,
          },
          quote: {
            price: "100",
            observedAtMs: staleFirstQuote &&
              metrics.planningReads.get(signal.sourceSignalId) === 1
              ? readStartedAt : nowRef.value,
          },
          filters: {
            symbol: signal.symbol.replace(/USDT$/, "-USDT"),
            quantityPrecision: 3,
            pricePrecision: 2,
            minQuantity: "0.001",
            minNotional: "5",
          },
          marginMode: "ISOLATED",
          marginModeVerified: true,
          requiresIsolatedMarginPreparation: false,
          risk: {
            takerFeeRate: "0.0005",
            fundingRate: 0,
            maintenanceMarginRate: "0.01",
            stopBufferRate: "0.005",
            tickSize: "0.01",
            maxPositionValue: "1000000",
          },
        };
      } finally {
        metrics.activePlanningReads -= 1;
      }
    },
    async readAccountState() {
      metrics.accountReads += 1;
      return {
        verified: !unsafeAccount && safetySnapshot === null,
        environment: "vst",
        accountId: ACCOUNT_ID,
        positions: safetySnapshot?.positions ?? [...exchange.values()].map((row) => ({
          ...row.position,
          protectiveStops: { core: row.stopProof },
        })),
        openOrders: safetySnapshot?.openOrders ??
          [...exchange.values()].map((row) => row.stop),
      };
    },
    async readMarketMark(symbol) {
      return {
        verified: true,
        symbol,
        price: "100",
        observedAt: new Date(nowRef.value).toISOString(),
      };
    },
    async readPosition(symbol) {
      const row = exchange.get(symbol);
      return row ? {
        ...row.position,
        environment: "vst",
        accountId: ACCOUNT_ID,
        protectiveStops: { core: row.stopProof },
      } : null;
    },
    async readMarginTopUpPlan(request) {
      const row = exchange.get(request.symbol);
      return {
        verified: true,
        environment: "vst",
        accountId: ACCOUNT_ID,
        symbol: request.symbol,
        positionId: request.positionId,
        entryOrderId: request.entryOrderId,
        quantity: request.quantity,
        amount: null,
        isolatedMarginBefore: "100",
        protectiveStop: {
          orderId: row.stop.orderId,
          positionId: request.positionId,
          stopPrice: request.stopLoss,
          quantity: request.quantity,
          status: "NEW",
          workingType: "MARK_PRICE",
        },
      };
    },
    async performIntent(intent) {
      const durable = store.data.intents.find((row) =>
        row.clientOrderId === intent.clientOrderId);
      assert.ok(durable, "broker mutation has a durable intent first");
      assert.equal(durable.state, "submitted");
      metrics.activeMutations += 1;
      metrics.maxMutations = Math.max(metrics.maxMutations, metrics.activeMutations);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        const request = intent.request;
        metrics.mutationOrder.push({
          sourceSignalId: durable.sourceSignalId,
          phase: intent.phase,
          operation: request.operation,
          stateAtTransport: durable.state,
        });
        if (request.operation === "entry") {
          metrics.entrySubmissions.push(durable.sourceSignalId);
          const positionId = `position-${intent.sourceSignalId}`;
          const orderId = `entry-order-${intent.sourceSignalId}`;
          const stop = {
            verified: true,
            orderId: `stop-${intent.sourceSignalId}`,
            positionId,
            quantity: String(request.quantity),
            stopPrice: String(request.stopLoss),
          };
          const position = {
            verified: true,
            symbol: request.symbol,
            positionId,
            side: "Buy",
            quantity: String(request.quantity),
            avgPrice: "100",
            leverage: 10,
            marginMode: "ISOLATED",
            pricePrecision: 2,
          };
          exchange.set(request.symbol, {
            position,
            stop: {
              symbol: request.symbol,
              orderId: stop.orderId,
              positionId,
              type: "STOP_MARKET",
              status: "NEW",
              side: "SELL",
              positionSide: "LONG",
              workingType: "MARK_PRICE",
              origQty: String(request.quantity),
              stopPrice: String(request.stopLoss),
            },
            fill: {
              price: "100",
              quantity: String(request.quantity),
              at: new Date(nowRef.value).toISOString(),
            },
            stopProof: stop,
            orderId,
          });
        }
      } finally {
        metrics.activeMutations -= 1;
      }
    },
    async reconcileIntent(intent) {
      metrics.reconciliations.push({
        sourceSignalId: intent.sourceSignalId,
        phase: intent.phase,
        operation: intent.request.operation,
      });
      if (intent.request.operation === "set_isolated_leverage") {
        return {
          verified: true,
          status: "filled",
          position: { marginMode: "ISOLATED", leverage: 10 },
        };
      }
      const row = exchange.get(intent.request.symbol);
      assert.ok(row, `entry exchange proof exists for ${intent.sourceSignalId}`);
      return {
        verified: true,
        status: "filled",
        exchangeOrderId: row.orderId,
        fill: row.fill,
        position: row.position,
        protectiveStops: { core: row.stopProof },
      };
    },
  };
  return { broker, metrics, exchange };
}

function createHarness(signals, options = {}) {
  const store = memoryLedger(signals);
  const nowRef = options.nowRef ?? { value: NOW };
  const { broker, metrics, exchange } = makeBroker(store, { ...options, nowRef });
  const makeWorker = (workerOptions = {}) => createVstWorker({
    store,
    broker,
    clock: () => nowRef.value,
    sizingLimits: {
      environment: "vst",
      maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500,
      maxSlippageBps: 100,
    },
    entryBatchSize: 3,
    entryBatchBudgetMs: 30_000,
    ...workerOptions,
  });
  return { store, broker, metrics, exchange, nowRef, makeWorker };
}

async function drain(harness, { maxTicks = 200 } = {}) {
  const worker = harness.makeWorker();
  let lastResult;
  for (let tick = 0; tick < maxTicks; tick += 1) {
    const unfinished = harness.store.data.candidates.some((row) =>
      ["pending", "planning", "opening"].includes(row.status));
    if (!unfinished) return;
    lastResult = await worker.runOnce();
  }
  const state = {
    candidates: harness.store.data.candidates.map((row) => ({
      sourceSignalId: row.sourceSignalId, status: row.status,
    })),
    intents: harness.store.data.intents.map((row) => ({
      sourceSignalId: row.sourceSignalId, phase: row.phase, state: row.state,
      reason: row.detail?.outcome?.reason,
    })),
  };
  assert.fail(`worker did not drain queued signals: ${JSON.stringify(state)}; lastResult=${JSON.stringify(lastResult)}`);
}

test("a known-symbol management exception preserves full evidence and does not drop unrelated entries", async () => {
  const harness = createHarness(makeSignals(2));
  await drain(harness);
  const managed = harness.store.data.positions[0];
  const originalUpsert = harness.store.upsertPosition;
  harness.store.upsertPosition = async (snapshot) => {
    if (snapshot.sourceSignalId === managed.sourceSignalId) {
      const error = new Error("managed position persistence failed");
      recordVstDiagnostic(error, {
        proofEvidence: buildVstProofEvidence({
          source: "broker_validation", condition: "identifier_aliases",
          validationField: "position_id",
          checks: {
            identifierAliases: { actual: [], matched: false },
            identifierPresent: { expected: true, actual: false, matched: false },
            identifierAliasesAgree: { expected: true, actual: false, matched: false },
          },
        }),
      });
      throw error;
    }
    return originalUpsert.call(harness.store, snapshot);
  };
  const diagnostics = [];
  harness.store.recordGuardEventOnce = async (sourceSignalId, kind, detail) => {
    diagnostics.push({ sourceSignalId, kind, detail });
  };
  const next = makeSignals(3)[2];
  harness.store.data.candidates.push({
    sourceSignalId: next.sourceSignalId, body: next,
    status: "pending", receivedAt: new Date(NOW + 3).toISOString(),
  });
  await drain(harness);
  assert.ok(harness.metrics.entrySubmissions.includes(next.sourceSignalId));
  assert.ok(diagnostics.some((item) =>
    item.sourceSignalId === managed.sourceSignalId &&
    item.detail.diagnostic.stage === "positionManagement"));
  assert.ok(diagnostics.some((item) =>
    item.detail.diagnostic.proofEvidence?.validationField === "position_id"),
  "the complete reviewed proof survives nested exception propagation");
  assert.equal(harness.store.data.positions.find((row) =>
    row.sourceSignalId === managed.sourceSignalId).status, "open");
});

test("batch preparation continues before another full sweep, bounded and fresh on the next tick", async () => {
  const harness = createHarness(makeSignals(2));
  await drain(harness);
  const next = makeSignals(3)[2];
  harness.store.data.candidates.push({
    sourceSignalId: next.sourceSignalId, body: next,
    status: "pending", receivedAt: new Date(NOW + 3).toISOString(),
  });
  const worker = harness.makeWorker();
  const first = await worker.runOnce();
  assert.equal(harness.store.data.candidates.at(-1).status, "planning");
  let managementReads = 0;
  const oldReadPosition = harness.broker.readPosition;
  harness.broker.readPosition = async (...args) => {
    managementReads++;
    return oldReadPosition(...args);
  };
  const beforeAccountReads = harness.metrics.accountReads;
  const second = await worker.runOnce();
  assert.equal(second.kind, "opened", JSON.stringify({ first, second }));
  assert.equal(managementReads, 0, "no repeated full management sweep between confirmed preparation and entry");
  assert.ok(harness.metrics.accountReads > beforeAccountReads,
    "continuation still obtains fresh account evidence");
  await worker.runOnce();
  assert.ok(managementReads > 0, "normal position management resumes after completion");
});

test("real worker batches bursts of 5, 10, and 26: parallel plans, serialized durable actions, restart-safe fills", async () => {
  for (const count of [5, 10, 26]) {
    const signals = makeSignals(count);
    const harness = createHarness(signals);
    await drain(harness);

    assert.ok(harness.metrics.maxPlanningReads > 1,
      `${count}-signal cohort should overlap strictly read-only planning`);
    assert.equal(harness.metrics.maxMutations, 1,
      `native action boundary must remain serial; ${JSON.stringify({
        statuses: harness.store.data.candidates.map(({ sourceSignalId, status }) => ({
          sourceSignalId, status,
        })),
        history: harness.store.data.statusHistory.slice(-10),
      })}`);
    assert.equal(harness.metrics.entrySubmissions.length, count);
    assert.equal(new Set(harness.metrics.entrySubmissions).size, count);
    assert.equal(harness.store.data.positions.length, count);
    assert.equal(harness.store.data.replayedCommits, 0);
    assert.ok(harness.metrics.mutationOrder.every((action) =>
      action.stateAtTransport === "submitted"));
    for (const row of harness.store.data.positions) {
      assert.equal(row.snapshot.environment, "vst");
      assert.equal(row.snapshot.accountId, ACCOUNT_ID);
      assert.equal(row.snapshot.marginMode, "ISOLATED");
      assert.equal(row.snapshot.leverage, 10);
      assert.equal(row.snapshot.status, "open");
      const sizing = row.snapshot.sizing;
      for (const field of [
        "quantity", "requiredAvailableVst", "availableMarginVst",
        "initialMarginVst", "quotePrice", "quoteObservedAtMs",
      ]) {
        assert.ok(Number.isFinite(Number(sizing[field])), `${field} is finite`);
      }
      assert.equal(sizing.status, "ready");
      assert.ok(Number(sizing.requiredAvailableVst) > 0);
    }
    const totalPlannedAvailable = harness.store.data.positions.reduce(
      (sum, row) => sum + Number(row.snapshot.sizing.requiredAvailableVst), 0,
    );
    assert.ok(Number.isFinite(totalPlannedAvailable));
    assert.ok(totalPlannedAvailable <= 100_000,
      "cohort sizing reserves available margin without exceeding its verified ceiling");
    const reconciledEntries = harness.store.data.intents.filter((intent) =>
      intent.phase === "market-entry");
    assert.equal(reconciledEntries.length, count);
    assert.ok(reconciledEntries.every((intent) =>
      intent.state === "reconciled" &&
      typeof intent.exchangeOrderId === "string" &&
      intent.detail?.outcome?.verified === true));

    // A fresh process using the same ledger must observe terminal durable
    // intents, not submit/reconcile the already committed market entries again.
    const entriesBeforeRestart = harness.metrics.entrySubmissions.length;
    await harness.makeWorker().runOnce();
    assert.equal(harness.metrics.entrySubmissions.length, entriesBeforeRestart);
    assert.equal(harness.store.data.replayedCommits, 0);
  }
});

test("planning that advances the signal clock beyond a quote TTL re-reads a fresh quote within the 30s batch budget", async () => {
  const nowRef = { value: NOW };
  const signals = makeSignals(3);
  const harness = createHarness(signals, {
    nowRef,
    staleFirstQuote: true,
    planningDelay: async (signal, metrics, clock) => {
      const readNumber = metrics.planningReads.get(signal.sourceSignalId);
      if (readNumber === 1) {
        // Model an exchange preparation cycle longer than the old 10s default.
        // The initial quote is over its TTL when sizing resumes; a safe worker
        // must perform a fresh read rather than permanently rejecting its hint.
        clock.value += 11_001;
      }
    },
  });
  await drain(harness);
  assert.ok(nowRef.value - NOW > 10_000,
    "the injected clock confirms preparation outlasted the 10s quote TTL");
  assert.equal(harness.store.data.positions.length, signals.length);
  assert.ok([...harness.metrics.planningReads.values()].some((reads) => reads > 1),
    "a stale planning hint is refreshed instead of trusted or rejected forever");
  assert.ok(harness.store.data.positions.every((row) => {
    const observedAtMs = Number(row.snapshot.sizing.quoteObservedAtMs);
    return Number.isSafeInteger(observedAtMs) &&
      nowRef.value - observedAtMs >= 0 &&
      nowRef.value - observedAtMs <= 10_000;
  }), "committed sizing retains only a fresh quote after fallback reads");
  assert.ok(harness.metrics.entrySubmissions.length > 0);
});

test("unverified account state and account-wide unknown intents fail closed for every candidate", async () => {
  for (const mode of ["unverified-account", "unknown-intent"]) {
    const signals = makeSignals(3);
    const harness = createHarness(signals, {
      unsafeAccount: mode === "unverified-account",
    });
    if (mode === "unknown-intent") {
      harness.store.data.intents.push({
        sourceSignalId: "foreign-signal",
        phase: "unknown-operation",
        clientOrderId: "unknown-account-wide-intent",
        state: "unknown",
        request: { operation: "unknown", environment: "vst" },
      });
    }
    await harness.makeWorker().runOnce();
    assert.equal(harness.metrics.entrySubmissions.length, 0, mode);
    assert.equal(harness.store.data.positions.length, 0, mode);
    assert.equal(harness.metrics.maxMutations, 0, mode);
  }
});

test("foreign exposure and unprotected account orders fail closed for each queued candidate", async () => {
  const signals = makeSignals(3);
  for (const mode of ["foreign-position", "unprotected-order"]) {
    for (const signal of signals) {
      const foreign = {
        verified: true,
        symbol: "FOREIGNUSDT",
        positionId: "foreign-position",
        side: "Buy",
        quantity: "1",
      };
      const unprotectedOrder = {
        symbol: signal.symbol,
        orderId: "unowned-open-order",
        type: "LIMIT",
        status: "NEW",
      };
      const harness = createHarness([signal], {
        safetySnapshot: mode === "foreign-position"
          ? { positions: [foreign], openOrders: [] }
          : { positions: [], openOrders: [unprotectedOrder] },
      });
      await harness.makeWorker().runOnce();
      assert.equal(harness.metrics.entrySubmissions.length, 0,
        `${mode} ${signal.sourceSignalId}`);
      assert.equal(harness.metrics.maxMutations, 0,
        `${mode} ${signal.sourceSignalId}`);
    }
  }
});

test("same-symbol unknown intent blocks only that symbol and queue scanning preserves later distinct candidates", async () => {
  const signals = makeSignals(4);
  signals[0].symbol = signals[1].symbol;
  const harness = createHarness(signals);
  harness.store.data.intents.push({
    sourceSignalId: "older-signal",
    phase: "unknown-entry",
    clientOrderId: "unknown-same-symbol",
    state: "unknown",
    request: { operation: "entry", environment: "vst", symbol: signals[0].symbol },
  });
  await harness.makeWorker().runOnce();
  assert.ok(harness.metrics.planningReads.has(signals[2].sourceSignalId) ||
    harness.metrics.planningReads.has(signals[3].sourceSignalId),
  "blocked same-symbol queue heads do not starve later independent symbols");
  assert.equal(harness.metrics.entrySubmissions.includes(signals[0].sourceSignalId), false);
  assert.equal(harness.metrics.entrySubmissions.includes(signals[1].sourceSignalId), false);
});

test("a source-exit arriving during read-only cohort planning stops all sequential entry phases", async () => {
  const signals = makeSignals(3);
  let queued = false;
  const harness = createHarness(signals, {
    sourceExitsEnabled: true,
    planningDelay: async (_signal, _metrics, _clock) => {
      if (queued) return;
      queued = true;
      harness.store.data.sourceExitRequests.push({
        requestId: "source-exit-arrived-during-planning",
        sourceSignalId: "unrelated-position",
        symbol: "OTHERUSDT",
        state: "pending",
        evidence: { reason: "withdrawn", asOf: new Date(NOW).toISOString() },
      });
    },
  });
  await harness.makeWorker({ sourceExitsEnabled: true }).runOnce();
  assert.equal(harness.metrics.entrySubmissions.length, 0);
  assert.equal(harness.metrics.maxMutations, 0);
});

test("expired untouched candidates are retired before valid pending work enters the batch", async () => {
  const signals = makeSignals(3);
  const harness = createHarness(signals);
  harness.store.data.candidates[1].body.signalAt =
    new Date(NOW - 11 * 60_000).toISOString();
  await harness.makeWorker().runOnce();
  assert.equal(harness.store.data.candidates[1].status, "rejected");
  assert.equal(harness.store.data.candidates[0].status, "planning");
  assert.equal(harness.store.data.candidates[2].status, "planning");
});

test("a source exit arriving during final account reads wins before the new entry phase", async () => {
  const harness = createHarness(makeSignals(3));
  const readAccountState = harness.broker.readAccountState.bind(harness.broker);
  let reads = 0;
  harness.broker.readAccountState = async () => {
    const state = await readAccountState();
    if (++reads === 3) {
      harness.store.data.sourceExitRequests.push({
        requestId: "source-exit-arrived-during-final-account",
        sourceSignalId: "unrelated-position",
        symbol: "OTHERUSDT",
        state: "pending",
        evidence: { reason: "withdrawn", asOf: new Date(NOW).toISOString() },
      });
    }
    return state;
  };
  const result = await harness.makeWorker({ sourceExitsEnabled: true }).runOnce();
  assert.equal(reads, 3);
  assert.equal(result.reason, "source_exit_priority_before_entry_batch_phase");
  assert.equal(harness.metrics.entrySubmissions.length, 0);
  assert.equal(harness.metrics.maxMutations, 0);
});

test("in-flight rows are never treated as untouched expired signals or replayed", async () => {
  const signals = makeSignals(1);
  const harness = createHarness(signals);
  harness.store.data.candidates[0].body.signalAt =
    new Date(NOW - 11 * 60_000).toISOString();
  harness.store.data.candidates[0].status = "planning";
  harness.store.data.intents.push({
    sourceSignalId: signals[0].sourceSignalId,
    phase: "isolated-leverage-10",
    clientOrderId: "durable-inflight-leverage",
    state: "unknown",
    request: {
      operation: "set_isolated_leverage",
      environment: "vst",
      accountId: ACCOUNT_ID,
      symbol: signals[0].symbol,
      intentCreatedAt: NOW - 1,
    },
  });
  await harness.makeWorker().runOnce();
  assert.notEqual(harness.store.data.candidates[0].status, "rejected");
  assert.equal(harness.metrics.entrySubmissions.length, 0);
  assert.equal(harness.store.data.intents.length, 1);
});
test("an exit queued for another symbol that this tick could not finish does not block entries (BIRB 2026-10-27)", async () => {
  const harness = createHarness(makeSignals(3), { sourceExitsEnabled: true });
  harness.store.data.sourceExitRequests.push({
    requestId: "stuck-exit-other-symbol",
    sourceSignalId: "unrelated-position",
    symbol: "OTHERUSDT",
    state: "pending",
    evidence: { reason: "withdrawn", asOf: new Date(NOW).toISOString() },
  });
  const worker = harness.makeWorker({ sourceExitsEnabled: true });
  const results = [];
  for (let i = 0; i < 4 && harness.metrics.entrySubmissions.length === 0; i++) {
    results.push(await worker.runOnce());
  }
  assert.ok(harness.metrics.entrySubmissions.length > 0,
    JSON.stringify(results.map((r) => r?.reason ?? r?.kind)));
});
