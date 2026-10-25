import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after } from "node:test";
import { createVstStore } from "../vst-store.mjs";
import { createVstWorker } from "../vst-worker.mjs";
import { createVstPolicy } from "../vst-policy.mjs";
import { BingXLiveApiError } from "../bingx-live-api.mjs";
import { formatVstBlockedAlert } from "../vst-telegram.mjs";

const originalPauseSwitch = process.env.BULLET_VST_PAUSED;
process.env.BULLET_VST_PAUSED = "0";
const INTENT_SERIALIZATION_LOCK_NAMESPACE = 4_348_997;
const INTENT_SERIALIZATION_LOCK_SQL =
  "SELECT pg_advisory_xact_lock($1, hashtext($2))";
after(() => {
  if (originalPauseSwitch === undefined) delete process.env.BULLET_VST_PAUSED;
  else process.env.BULLET_VST_PAUSED = originalPauseSwitch;
});

function memoryStore(signal) {
  const data = {
    pending: signal ? { sourceSignalId: signal.sourceSignalId, body: signal, status: "pending" } : null,
    status: "pending",
    intents: [],
    positions: [],
    events: [],
    positionUpdateSequence: 0,
  };
  return {
    data,
    async enqueue(body) {
      if (data.pending) return { kind: "duplicate", status: data.status };
      data.pending = { sourceSignalId: body.sourceSignalId, body, status: "pending" };
      return { kind: "new", status: "pending" };
    },
    async withLeaderLock(callback) { return callback(); },
    async getPending() {
      return ["pending", "planning", "opening"].includes(data.pending?.status)
        ? data.pending : null;
    },
    async setSignalStatus(_id, status, reason = null) {
      data.status = status;
      data.reason = reason;
      if (data.pending) data.pending.status = status;
    },
    async recordEvent(...args) { data.events.push(args); },
    async listUnresolvedIntents() {
      return data.intents.filter((row) =>
        ["prepared", "submitted", "unknown"].includes(row.state))
        .map((row) => ({
          ...row,
          outcome: row.outcome ?? row.detail?.outcome,
        }));
    },
    async getIntent(sourceSignalId, phase) {
      const intent = data.intents.find((row) =>
        row.sourceSignalId === sourceSignalId && row.phase === phase);
      return intent ? {
        ...intent,
        outcome: intent.outcome ?? intent.detail?.outcome,
      } : null;
    },
    async getPosition(sourceSignalId) {
      const row = data.positions.find((item) =>
        item.sourceSignalId === sourceSignalId);
      return row ? {
        ...row,
        snapshot: row.snapshot,
        updatedAt: row.updatedAt,
      } : null;
    },
    async reserveIntent(intent) {
      const existing = data.intents.find((row) =>
        row.sourceSignalId === intent.sourceSignalId && row.phase === intent.phase);
      if (existing) {
        // Mirror the real store: an intent already on file for this
        // (signal, phase) must match byte-for-byte outside of the
        // bookkeeping intentCreatedAt timestamp, or this is a conflicting
        // rebuild that must fail loudly rather than silently reuse stale facts.
        const withoutTimestamp = (request) => {
          const { intentCreatedAt, ...rest } = request ?? {};
          return rest;
        };
        if (existing.clientOrderId !== intent.clientOrderId ||
            JSON.stringify(withoutTimestamp(existing.request)) !==
              JSON.stringify(withoutTimestamp(intent.request))) {
          throw new Error("VST intent phase already exists with conflicting order facts");
        }
        return { kind: "existing", intent: existing };
      }
      data.intents.push({ ...intent, state: "prepared" });
      return { kind: "new", intent: data.intents.at(-1) };
    },
    async markIntent(clientOrderId, state, detail = {}) {
      const intent = data.intents.find((row) => row.clientOrderId === clientOrderId);
      if (intent) {
        Object.assign(intent, { state, detail });
        if (Object.hasOwn(detail, "exchangeOrderId")) {
          intent.exchangeOrderId = detail.exchangeOrderId;
        }
      }
    },
    async commitVerifiedIntent(commit) {
      const intent = data.intents.find((row) =>
        row.clientOrderId === commit.clientOrderId);
      assert.ok(intent, "verified intent exists before atomic commit");
      data.lastVerifiedCommit = commit;
      if (intent.state === "reconciled") {
        assert.deepEqual(intent.detail?.outcome, commit.outcome);
        return { replayed: true };
      }
      if (commit.expectedPositionSnapshot !== undefined) {
        const current = await this.getPosition(commit.sourceSignalId);
        assert.equal(current?.updatedAt, commit.expectedPositionUpdatedAt);
        assert.equal(current?.status, commit.expectedPositionSnapshot.status);
        assert.deepEqual(current?.snapshot, commit.expectedPositionSnapshot);
      }
      await this.upsertPosition(commit.position);
      Object.assign(intent, {
        state: "reconciled",
        exchangeOrderId: commit.exchangeOrderId,
        detail: { outcome: commit.outcome },
      });
      await this.setSignalStatus(commit.sourceSignalId, commit.signalStatus);
      if (commit.followUpIntent) {
        const existingFollowUp = data.intents.find((row) =>
          row.clientOrderId === commit.followUpIntent.clientOrderId);
        if (!existingFollowUp) {
          data.intents.push({ ...commit.followUpIntent, state: "prepared" });
        }
      }
      if (commit.eventKind) {
        await this.recordEvent(
          commit.sourceSignalId, commit.eventKind, commit.eventDetail, commit.clientOrderId,
        );
      }
      return { replayed: false };
    },
    async listOpenPositions() {
      return data.positions.filter((row) => ["open", "closing", "unknown"].includes(row.status));
    },
    async upsertPosition(position) {
      const row = {
        sourceSignalId: position.sourceSignalId,
        symbol: position.symbol,
        status: position.status,
        snapshot: position,
        updatedAt: new Date(NOW + data.positionUpdateSequence++).toISOString(),
      };
      const index = data.positions.findIndex((item) =>
        item.sourceSignalId === position.sourceSignalId);
      if (index === -1) data.positions.push(row);
      else data.positions[index] = row;
    },
  };
}

function seedRaiseStopEntry(store, {
  sourceSignalId,
  symbol,
  accountId = "vst-account",
  positionId,
  clientOrderId,
  exchangeOrderId,
  quantity,
  entryAt = new Date(NOW).toISOString(),
  entryOrderType = "MARKET",
  stop,
}) {
  const position = store.data.positions.find((row) =>
    row.sourceSignalId === sourceSignalId)?.snapshot;
  assert.ok(position, "position exists before seeding its durable entry proof");
  const stopProof = {
    verified: true,
    orderId: stop.orderId,
    positionId,
    quantity: String(quantity),
    stopPrice: String(stop.stopPrice),
  };
  Object.assign(position, {
    exchangePositionId: positionId,
    positionId,
    entryClientOrderId: clientOrderId,
    entryOrderId: exchangeOrderId,
    entryOrderType,
    entryAt,
    remainingQty: String(quantity),
    verifiedProtectiveStops: { core: stopProof },
  });
  store.data.intents.push({
    sourceSignalId,
    phase: "market-entry",
    clientOrderId,
    state: "reconciled",
    exchangeOrderId,
    request: {
      operation: "entry",
      environment: "vst",
      accountId,
      symbol,
      entryOrderType,
      quantity: String(quantity),
      intentCreatedAt: Date.parse(entryAt),
    },
    outcome: {
      verified: true,
      status: "filled",
      positionId,
      fillQuantity: String(quantity),
    },
  });
}

const NOW = Date.parse("2026-10-02T00:00:00.000Z");
test("a newly queued priority action interrupts ordinary work after capability reads without reserving a write", async () => {
  const store = memoryStore(activePolicy());
  const broker = guardedBroker(store);
  let urgent = false;
  const getCapabilities = broker.getCapabilities;
  broker.getCapabilities = async () => {
    const result = await getCapabilities();
    urgent = true;
    return result;
  };
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    shouldYieldToUrgentWork: () => urgent,
  });
  assert.deepEqual(await worker.runOnce(), {
    kind: "waiting", reason: "priority_work_queued",
  });
  assert.equal(store.data.intents.length, 0);
  assert.equal(store.data.positions.length, 0);
});

test("a cancellation/take queued while planning yields before settings or entry, then resumes with fresh reads", async () => {
  const store = memoryStore(activePolicy());
  const broker = guardedBroker(store);
  let urgent = false;
  let planningReads = 0;
  broker.readPlanningInputs = async () => {
    if (++planningReads === 1) urgent = true;
    return safePlanningInputs();
  };
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: { environment: "vst", maxQuoteAgeMs: 10_000, maxPriceMoveBps: 500, maxSlippageBps: 100 },
    shouldYieldToUrgentWork: () => urgent,
  });
  assert.deepEqual(await worker.runOnce(), { kind: "waiting", reason: "priority_work_queued" });
  assert.equal(store.data.intents.length, 0);
  urgent = false;
  assert.notEqual((await worker.runOnce()).reason, "priority_work_queued");
  assert.equal(planningReads, 2);
});

test("a failed priority hint refuses entry instead of opening without the scheduling check", async () => {
  const store = memoryStore(activePolicy());
  const worker = createVstWorker({
    store, broker: guardedBroker(store), clock: () => NOW,
    shouldYieldToUrgentWork: () => { throw Error("scheduler unavailable"); },
  });
  assert.equal((await worker.runOnce()).reason, "priority_work_queued");
  assert.equal(store.data.intents.length, 0);
});
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
    execution: "advice_only_not_automated", minFraction: 0.2, maxFraction: 0.25,
  },
};

function activePolicy({ patternId = "balanced_grind", stopLoss = "90" } = {}) {
  return {
    ...signal,
    sourceSignalId: `cab-signal-${patternId === "impulse_buy" ? "123" : "122"}`,
    patternId,
    signalAt: new Date(NOW).toISOString(),
    stopLoss,
    payload: {
      rulesVersion: "bullet-long-exits-v2",
      exitRules: patternId === "impulse_buy"
        ? {
            ...EXIT_RULES,
            runner: {
              policyVersion: "impulse_runner_v1",
              coreExit: "standard_trailing_stop",
              coreFraction: 0.8,
              runnerFraction: 0.2,
              afterCoreEmergencyStop: "original_entry_breakeven",
              trailingActivationPct: 30,
              trailingGapPercentagePoints: 30,
              trailingGapBasis: "percentage_points_of_entry_pnl",
              maxAgeHoursFromOriginalEntry: 120,
              expiryExitPrice: "observed_market_quote",
            },
          }
        : EXIT_RULES,
    },
  };
}

function installPagedCandidates(store, rows) {
  const priority = (row) => row.status === "opening" ? 0 : row.status === "planning" ? 1 : 2;
  store.listPendingCandidatesPage = async ({ limit, after }) => {
    const ordered = rows
      .filter((row) => ["opening", "planning", "pending"].includes(row.status))
      .sort((a, b) => priority(a) - priority(b) ||
        a.receivedAt.localeCompare(b.receivedAt) ||
        a.sourceSignalId.localeCompare(b.sourceSignalId));
    const afterKey = (row) => [
      priority(row), row.receivedAt, row.sourceSignalId,
    ];
    const laterThanCursor = (row) => {
      if (!after) return true;
      const key = afterKey(row);
      return key[0] > after.priority ||
        key[0] === after.priority &&
        (key[1] > after.receivedAt ||
          key[1] === after.receivedAt && key[2] > after.sourceSignalId);
    };
    const matching = ordered.filter(laterThanCursor);
    const pageRows = matching.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      rows: pageRows,
      nextCursor: last ? Object.freeze({
        priority: priority(last),
        receivedAt: last.receivedAt,
        sourceSignalId: last.sourceSignalId,
      }) : null,
      hasMore: matching.length > limit,
    };
  };
}

const FULL_CAPABILITIES = [
  "vst_only",
  "complete_order_lookup",
  "guarded_long10_leverage_preparation",
  "atomic_protected_market_entry",
  "verified_core_stop_state",
  "verified_exact_full_position_close",
  "verified_position_state",
];

function guardedBroker(store, {
  currentPosition,
  originalStopOrderId = "entry-stop-1",
  marketMark = { verified: true, price: 105, observedAt: new Date(NOW + 60_000).toISOString() },
  reconcile = null,
  onPerform = null,
  capabilitiesError = null,
  readCalls = null,
  observeTriggeredStop = null,
  openOrders = null,
  // A plain Error always throws on every readAccountState() call. A function
  // is invoked per call and may return an Error (throw) or a falsy value
  // (proceed normally) -- used to simulate a transient outage that later
  // recovers, e.g. `() => (calls++ === 0 ? new Error("outage") : null)`.
  readAccountStateError = null,
} = {}) {
  return {
    async readMarginTopUpPlan(request) {
      return {
        ...request, verified: true, amount: null,
        isolatedMarginBefore: "10",
        protectiveStop: {
          orderId: originalStopOrderId,
          positionId: request.positionId,
          stopPrice: request.stopLoss,
          quantity: request.quantity,
          status: "NEW",
          workingType: "MARK_PRICE",
        },
      };
    },
    ...(observeTriggeredStop ? { observeTriggeredStop } : {}),
    async getCapabilities() {
      if (capabilitiesError) throw capabilitiesError;
      return {
        environment: "vst", verified: true, accountId: "vst-account",
        features: FULL_CAPABILITIES,
        missingCapabilities: [{
          capability: "impulse_runner_stop_and_partial_close",
          reason: "The worker does not yet persist and emit the complete impulse split request/evidence contract; capability remains withheld.",
        }],
      };
    },
    async readPlanningInputs() { throw new Error("not needed for open-position tests"); },
    async verifyEntryOrderProof({
      expectedPositionId, expectedOrderId, expectedQuantity,
    }) {
      return {
        verified: true,
        status: "filled",
        positionId: expectedPositionId,
        exchangeOrderId: expectedOrderId,
        fill: { quantity: expectedQuantity },
      };
    },
    async readAccountState() {
      if (readCalls) readCalls.accountState += 1;
      if (readAccountStateError) {
        const error = typeof readAccountStateError === "function"
          ? readAccountStateError()
          : readAccountStateError;
        if (error) throw error;
      }
      return {
        verified: true,
        environment: "vst",
        accountId: "vst-account",
        positions: currentPosition ? [{
          symbol: currentPosition.symbol,
          positionId: currentPosition.positionId,
          positionSide: currentPosition.positionSide ??
            (currentPosition.side === "Sell" ? "SHORT" : "LONG"),
          positionAmt: String(currentPosition.positionAmt ?? currentPosition.quantity),
          ...(currentPosition.avgPrice !== undefined
            ? { avgPrice: currentPosition.avgPrice } : {}),
          ...(currentPosition.entryPrice !== undefined
            ? { entryPrice: currentPosition.entryPrice } : {}),
        }] : [],
        openOrders: openOrders ?? Object.values(currentPosition?.protectiveStops ?? {})
          .map((stop) => ({
            symbol: currentPosition.symbol,
            orderId: stop.orderId,
            positionId: stop.positionId,
            origQty: String(stop.quantity),
            stopPrice: String(stop.stopPrice),
            type: "STOP_MARKET",
            status: "NEW",
            side: "SELL",
            positionSide: "LONG",
            workingType: "MARK_PRICE",
          })),
      };
    },
    async readMarketMark() {
      if (readCalls) readCalls.marketMark += 1;
      return typeof marketMark === "function" ? marketMark() : marketMark;
    },
    async readPosition() {
      if (readCalls) readCalls.position += 1;
      return currentPosition;
    },
    async performIntent(intent) {
      const row = store.data.intents.find((item) =>
        item.clientOrderId === intent.clientOrderId);
      assert.ok(row, "durable order intent exists before broker mutation");
      assert.equal(row.state, "submitted");
      assert.equal(Number.isSafeInteger(intent.request.intentCreatedAt), true);
      return await onPerform?.(intent, currentPosition);
    },
    async reconcileIntent(intent) {
      const durable = store.data.intents.find((item) =>
        item.clientOrderId === intent.clientOrderId);
      assert.ok(durable);
      assert.equal(intent.request.intentCreatedAt, durable.request.intentCreatedAt);
      return reconcile ? reconcile(intent, currentPosition) : {
        verified: false, status: "unknown",
      };
    },
  };
}

function safePlanningInputs({
  marginMode = "ISOLATED",
  requiresIsolatedMarginPreparation = false,
} = {}) {
  return {
    balanceSnapshot: {
      asset: "VST", balance: "98455.6472", equity: "98455.6472",
      availableMargin: "98455.6472",
    },
    quote: { price: "100", observedAtMs: NOW - 1_000 },
    filters: {
      symbol: "ETH-USDT",
      quantityPrecision: 3,
      pricePrecision: 2,
      minQuantity: "0.001",
      minNotional: "5",
    },
    marginMode,
    marginModeVerified: marginMode === "ISOLATED",
    requiresIsolatedMarginPreparation,
    risk: {
      takerFeeRate: "0.0005",
      fundingRate: 0,
      maintenanceMarginRate: "0.01",
      stopBufferRate: "0.005",
      tickSize: "0.01",
      maxPositionValue: "1000000",
    },
  };
}

async function preparedEntryFixture({ sourceSignalId, onPerform, reconcile }) {
  const entrySignal = {
    ...activePolicy({ stopLoss: "95" }),
    sourceSignalId,
    signalAt: new Date(NOW).toISOString(),
  };
  const store = memoryStore(entrySignal);
  const reconcileIntent = async (intent, position) => {
    const result = await reconcile?.(intent, position);
    if (result !== undefined) return result;
    return intent.phase === "market-entry"
      ? { verified: false, status: "unknown" }
      : {
        verified: true, status: "filled",
        position: { marginMode: "ISOLATED", leverage: 10 },
      };
  };
  const broker = guardedBroker(store, {
    currentPosition: null,
    onPerform,
    reconcile: reconcileIntent,
  });
  broker.getCapabilities = async () => ({
    environment: "vst",
    verified: true,
    accountId: "vst-account",
    features: FULL_CAPABILITIES,
    evidence: { canarySymbols: ["BTCUSDT"] },
  });
  broker.readPlanningInputs = async () => safePlanningInputs();
  const makeWorker = (selectedBroker = broker) => createVstWorker({
    store,
    broker: selectedBroker,
    clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  const worker = makeWorker();
  const prepared = await worker.runOnce();
  assert.equal(prepared.kind, "prepared", JSON.stringify(prepared));
  return { store, broker, worker, makeWorker };
}

function impulseLifecycleFixture({
  failOperation = null,
  ambiguousOperation = null,
  foreignOrderAfterPreRunnerClose = false,
  mutateEvidence = null,
  markPrice = 105,
} = {}) {
  const impulse = activePolicy({ patternId: "impulse_buy", stopLoss: "95" });
  const store = memoryStore(impulse);
  const mutations = [];
  const mutationRequests = [];
  const readPositionCalls = [];
  const exchange = { position: null, orders: [] };
  let markObservedAt = NOW;
  const openStop = (orderId, positionId, quantity, stopPrice, entryOrderId) => ({
    symbol: impulse.symbol,
    orderId,
    mainOrderId: entryOrderId,
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    workingType: "MARK_PRICE",
    positionId,
    origQty: String(quantity),
    stopPrice: String(stopPrice),
  });
  const currentPosition = () => exchange.position
    ? {
        verified: true,
        symbol: impulse.symbol,
        positionId: exchange.position.positionId,
        side: "Buy",
        quantity: exchange.position.quantity,
        avgPrice: exchange.position.avgPrice,
        leverage: 10,
        marginMode: "ISOLATED",
        pricePrecision: 2,
        protectiveStops: { ...exchange.position.protectiveStops },
      }
    : null;
  const broker = {
    async readMarginTopUpPlan(request) {
      const originalStop = exchange.orders.find((order) =>
        order.mainOrderId === request.entryOrderId &&
        order.positionId === request.positionId &&
        Number(order.stopPrice) === Number(request.stopLoss));
      return {
        ...request, verified: true, amount: null,
        isolatedMarginBefore: "10",
        protectiveStop: {
          orderId: originalStop?.orderId,
          positionId: request.positionId, stopPrice: request.stopLoss,
          quantity: request.quantity, status: "NEW", workingType: "MARK_PRICE",
        },
      };
    },
    async getCapabilities() {
      return {
        environment: "vst", verified: true, accountId: "vst-account",
        features: [...FULL_CAPABILITIES, "impulse_runner_stop_and_partial_close"],
      };
    },
    async readPlanningInputs() {
      return {
        balanceSnapshot: {
          asset: "VST", balance: "98455.6472",
          availableMargin: "98455.6472",
        },
        quote: { price: "100", observedAtMs: NOW - 1_000 },
        filters: {
          symbol: "ETH-USDT",
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
    },
    async readAccountState() {
      return {
        verified: true,
        environment: "vst",
        accountId: "vst-account",
        positions: exchange.position ? [{
          symbol: exchange.position.symbol ?? impulse.symbol,
          positionId: exchange.position.positionId,
          positionSide: "LONG",
          positionAmt: String(exchange.position.quantity),
        }] : [],
        openOrders: exchange.orders.map((order) => ({ ...order })),
      };
    },
    async readPosition(symbol, options = {}) {
      const { persistedPosition, allowProcessCache } = options;
      readPositionCalls.push({ symbol, ...options });
      assert.equal(allowProcessCache, false,
        "split position reads must never use process-local stop cache");
      if (persistedPosition !== undefined) {
        assert.equal(persistedPosition.verified, true);
        assert.equal(persistedPosition.environment, "vst");
        assert.equal(persistedPosition.accountId, "vst-account");
        assert.equal(persistedPosition.symbol, symbol);
        assert.equal(persistedPosition.positionId, exchange.position?.positionId);
        assert.equal(Number(persistedPosition.quantity), Number(exchange.position?.quantity));
        assert.ok(Object.keys(persistedPosition.protectiveStops ?? {})
          .every((tranche) => ["core", "runner"].includes(tranche)));
        for (const [tranche, stop] of Object.entries(
          persistedPosition.protectiveStops ?? {},
        )) {
          assert.equal(stop.tranche, tranche);
        }
        if (persistedPosition.originalStop) {
          assert.equal(persistedPosition.originalStop.tranche, "original");
        }
        const descriptors = [
          ...Object.values(persistedPosition.protectiveStops ?? {}),
          ...(persistedPosition.originalStop ? [persistedPosition.originalStop] : []),
        ];
        assert.equal(descriptors.length, exchange.orders.length,
          "snapshot must account for every open order and no foreign order");
        assert.equal(new Set(descriptors.map((stop) => stop.orderId)).size,
          exchange.orders.length);
        for (const descriptor of descriptors) {
          assert.equal(descriptor.verified, true);
          const matches = exchange.orders.filter((order) =>
            order.orderId === descriptor.orderId);
          assert.equal(matches.length, 1, "snapshot stop must be active and unique");
          assert.equal(matches[0].positionId, descriptor.positionId);
          assert.equal(Number(matches[0].origQty), Number(descriptor.quantity));
          assert.equal(Number(matches[0].stopPrice), Number(descriptor.stopPrice));
        }
      }
      return currentPosition();
    },
    async readMarketMark() {
      return {
        verified: true,
        symbol: impulse.symbol,
        price: markPrice,
        observedAt: new Date(markObservedAt).toISOString(),
      };
    },
    async performIntent(intent) {
      const row = store.data.intents.find((item) =>
        item.clientOrderId === intent.clientOrderId);
      assert.ok(row);
      assert.equal(row.state, "submitted");
      assert.equal(Number.isSafeInteger(intent.request.intentCreatedAt), true);
      mutations.push(intent.request.operation);
      mutationRequests.push(intent.request);
      if ([
        "split_core_stop", "split_runner_stop", "cancel_original_stop",
        "split_raise_stop_place", "cancel_split_stop",
        "cancel_original_after_runner_fill", "close_survivor",
          "close_pre_runner_split",
      ].includes(intent.request.operation) ||
          intent.request.operation === "close_leg" ||
          intent.request.operation === "raise_stop") {
        assert.equal(intent.request.persistedPosition?.verified, true,
          `${intent.request.operation} must carry its verified persisted position`);
        assert.equal(intent.request.persistedPosition?.positionId,
          exchange.position?.positionId);
      }
      if (intent.request.operation === "split_raise_stop_cancel") {
        assert.equal(intent.request.persistedPosition, undefined,
          "duplicate same-tranche upgrade stops cannot be represented as a snapshot");
      }
      if (failOperation === intent.request.operation) {
        throw new Error("simulated_impulse_write_unknown");
      }
      if (intent.request.operation === "entry") {
        const request = intent.request;
        const positionId = "impulse-position-1";
        const original = {
          verified: true,
          orderId: "impulse-original-stop",
          positionId,
          quantity: Number(request.quantity),
          stopPrice: Number(request.stopLoss),
        };
        exchange.position = {
          positionId,
          quantity: Number(request.quantity),
          avgPrice: 100,
          protectiveStops: { core: original },
        };
        exchange.orders = [openStop(
          original.orderId, positionId, request.quantity, request.stopLoss,
          "impulse-entry-order",
        )];
      } else if (intent.request.operation === "split_core_stop") {
        const request = intent.request;
        const stop = {
          verified: true,
          orderId: "impulse-core-stop",
          positionId: request.positionId,
          quantity: Number(request.coreQuantity),
          stopPrice: Number(request.signalStopPrice),
        };
        exchange.position.protectiveStops.core = stop;
        exchange.orders.push(openStop(
          stop.orderId, request.positionId, request.coreQuantity,
          request.signalStopPrice, request.entryOrderId,
        ));
      } else if (intent.request.operation === "split_runner_stop") {
        const request = intent.request;
        const stop = {
          verified: true,
          orderId: "impulse-runner-stop",
          positionId: request.positionId,
          quantity: Number(request.runnerQuantity),
          stopPrice: Number(request.breakEvenPrice),
        };
        exchange.position.protectiveStops.runner = stop;
        exchange.orders.push(openStop(
          stop.orderId, request.positionId, request.runnerQuantity,
          request.breakEvenPrice, request.entryOrderId,
        ));
      } else if (intent.request.operation === "cancel_original_stop") {
        exchange.orders = exchange.orders.filter((order) =>
          order.orderId !== intent.request.originalStopOrderId);
      } else if (intent.request.operation === "split_raise_stop_place") {
        const request = intent.request;
        const orderId = `impulse-${request.leg}-upgrade-stop`;
        const stop = {
          verified: true,
          tranche: request.leg,
          orderId,
          positionId: request.positionId,
          quantity: Number(request.oldStop.quantity),
          stopPrice: Number(request.newStopPrice),
          clientOrderId: "vst-upgrade-client",
        };
        exchange.upgradedStop = stop;
        exchange.orders.push({
          ...openStop(
          orderId, request.positionId, request.oldStop.quantity,
          request.newStopPrice, request.entryOrderId,
          ),
          clientOrderId: "vst-upgrade-client",
        });
      } else if (intent.request.operation === "split_raise_stop_cancel") {
        const request = intent.request;
        exchange.orders = exchange.orders.filter((order) =>
          order.orderId !== request.oldStop.orderId);
        exchange.position.protectiveStops[request.leg] = {
          verified: true,
          tranche: request.leg,
          orderId: request.newStop.orderId,
          positionId: request.positionId,
          quantity: Number(request.newStop.quantity),
          stopPrice: Number(request.newStop.stopPrice),
          clientOrderId: request.newStop.clientOrderId,
        };
      } else if (intent.request.operation === "close_leg") {
        if (intent.request.fullSplitAbort === true) {
          exchange.position.quantity = 0;
          exchange.position.protectiveStops = {};
        } else {
          const retainedLeg = intent.request.leg === "core" ? "runner" : "core";
          exchange.position.quantity = Number(intent.request[`${retainedLeg}Quantity`]);
        }
      } else if (intent.request.operation === "cancel_split_stop") {
        const stopId = intent.request[`${intent.request.leg}Stop`].orderId;
        exchange.orders = exchange.orders.filter((order) => order.orderId !== stopId);
        delete exchange.position.protectiveStops[intent.request.leg];
      } else if (intent.request.operation === "cancel_original_after_runner_fill") {
        exchange.orders = exchange.orders.filter((order) =>
          order.orderId !== intent.request.originalStopOrderId);
      } else if (intent.request.operation === "close_survivor") {
        exchange.position.quantity = 0;
        exchange.position.protectiveStops = {};
        exchange.orders = [];
      } else if (intent.request.operation === "close_split_all") {
        exchange.position.quantity = 0;
        exchange.position.protectiveStops = {};
      } else if (intent.request.operation === "close_pre_runner_split") {
        exchange.position.quantity = 0;
        exchange.position.protectiveStops = {};
        if (foreignOrderAfterPreRunnerClose) {
          exchange.orders.push(openStop(
            "foreign-open-stop", intent.request.positionId, "0.001", "80",
            intent.request.priorPosition.entryOrderId,
          ));
        }
      } else if (intent.request.operation === "cancel_flat_split_stop") {
        exchange.orders = exchange.orders.filter((order) =>
          order.orderId !== intent.request.stopToCancel.orderId);
      } else if (intent.request.operation === "raise_stop") {
        const request = intent.request;
        const orderId = "impulse-core-sole-upgrade-stop";
        const stop = {
          verified: true,
          tranche: "core",
          orderId,
          positionId: request.positionId,
          quantity: Number(request.quantity),
          stopPrice: Number(request.stopPrice),
        };
        exchange.orders = exchange.orders.filter((order) =>
          order.orderId !== request.priorPosition.split.coreStop.orderId);
        exchange.orders.push(openStop(
          orderId, request.positionId, request.quantity,
          request.stopPrice, request.priorPosition.entryOrderId,
        ));
        exchange.position.protectiveStops.core = stop;
      }
      if (ambiguousOperation === intent.request.operation) {
        throw new Error("simulated_ambiguous_exchange_write");
      }
    },
    async reconcileIntent(intent) {
      const durable = store.data.intents.find((item) =>
        item.clientOrderId === intent.clientOrderId);
      assert.ok(durable);
      assert.equal(intent.request.intentCreatedAt, durable.request.intentCreatedAt,
        "immediate broker reconciliation must use the persisted preparation timestamp");
      const request = intent.request;
      if (request.operation === "set_isolated_leverage") {
        return {
          verified: true, status: "filled",
          position: { leverage: 10, marginMode: "ISOLATED" },
        };
      }
      if (request.operation === "entry") {
        return {
          verified: true,
          status: "filled",
          exchangeOrderId: "impulse-entry-order",
          fill: {
            price: 100,
            quantity: Number(request.quantity),
            at: new Date(NOW).toISOString(),
          },
          position: currentPosition(),
          protectiveStops: currentPosition().protectiveStops,
        };
      }
      const snapshot = currentPosition();
      const result = {
        verified: true,
        status: "filled",
        position: snapshot,
        protectiveStops: snapshot.protectiveStops,
      };
      if (request.operation === "split_core_stop") {
        result.stop = {
          tranche: "core", orderId: "impulse-core-stop",
          quantity: String(request.coreQuantity),
          stopPrice: String(request.signalStopPrice),
        };
        result.exchangeOrderId = "impulse-core-stop";
      } else if (request.operation === "split_runner_stop") {
        result.stop = {
          tranche: "runner", orderId: "impulse-runner-stop",
          quantity: String(request.runnerQuantity),
          stopPrice: String(request.breakEvenPrice),
        };
        result.exchangeOrderId = "impulse-runner-stop";
      } else if (request.operation === "split_raise_stop_place") {
        const oldStop = request.oldStop;
        const otherStop = request.otherStop;
        result.newStop = {
          verified: true,
          tranche: request.leg,
          orderId: `impulse-${request.leg}-upgrade-stop`,
          clientOrderId: "vst-upgrade-client",
          positionId: request.positionId,
          quantity: String(oldStop.quantity),
          stopPrice: String(request.newStopPrice),
        };
        result.oldStop = { ...oldStop };
        result.otherStop = { ...otherStop };
        result.upgradeIntentId = request.upgradeIntentId;
        result.clientOrderId = "vst-upgrade-client";
        result.protectiveStops = {
          [request.leg]: { ...result.newStop },
          [request.otherStop.tranche]: {
            verified: true,
            ...request.otherStop,
            positionId: request.positionId,
          },
        };
      } else if (request.operation === "split_raise_stop_cancel") {
        result.canceledStopOrderId = request.oldStop.orderId;
        result.newStop = { ...request.newStop, verified: true };
        result.otherStop = { ...request.otherStop, verified: true };
        result.upgradeIntentId = request.upgradeIntentId;
        result.protectiveStops = {
          [request.leg]: { ...exchange.position.protectiveStops[request.leg] },
          [request.otherStop.tranche]: {
            verified: true,
            ...request.otherStop,
            positionId: request.positionId,
          },
        };
      } else if (request.operation === "cancel_original_after_runner_fill") {
        result.canceledOriginalStopOrderId = request.originalStopOrderId;
        result.runnerStopOrderId = request.runnerStopOrderId;
        result.runnerChildOrderId = request.runnerChildOrderId;
        result.cancellationIntentId = request.intentId;
        result.protectiveStops = {
          core: {
            verified: true,
            orderId: request.coreStopOrderId,
            positionId: request.positionId,
            quantity: request.remainingQuantity,
            stopPrice: request.signalStopPrice,
          },
        };
      } else if (request.operation === "close_survivor") {
        result.exchangeOrderId = "impulse-sole-leg-close";
        result.clientOrderId = request.closeIntentId;
        result.closeIntentId = request.closeIntentId;
        result.closedQuantity = String(request.quantity);
        result.canceledStopOrderId = request.stop.orderId;
        result.flat = true;
        result.noOpenStops = true;
        result.fill = {
          quantity: String(request.quantity),
          price: "105",
          at: new Date(NOW + 1_000).toISOString(),
          fee: { asset: "USDT", amount: "0.01" },
        };
      } else if (request.operation === "close_split_all") {
        result.exchangeOrderId = "impulse-full-split-close";
        result.clientOrderId = request.closeIntentId;
        result.closeIntentId = request.closeIntentId;
        result.positionId = request.positionId;
        result.closedQuantity = String(request.totalQuantity);
        result.flat = true;
        result.remainingKnownStopOrderIds = exchange.orders.map((order) => order.orderId);
        result.fullyCleaned = result.remainingKnownStopOrderIds.length === 0;
        result.fill = {
          quantity: String(request.totalQuantity),
          price: "105",
          at: new Date(NOW + 1_000).toISOString(),
          fees: { VST: "0.02" },
        };
      } else if (request.operation === "close_pre_runner_split") {
        result.exchangeOrderId = "impulse-pre-runner-abort-close";
        result.clientOrderId = "linked-pre-runner-close";
        result.closeIntentId = request.closeIntentId;
        result.positionId = request.positionId;
        result.closedQuantity = String(request.totalQuantity);
        result.flat = true;
        result.remainingKnownStopOrderIds = exchange.orders
          .filter((order) => request.flatCleanupStops.some((stop) =>
            stop.orderId === order.orderId))
          .map((order) => order.orderId);
        result.fill = {
          quantity: String(request.totalQuantity),
          price: "100",
          at: new Date(NOW + 1_000).toISOString(),
          fees: { VST: "0.02" },
        };
      } else if (request.operation === "cancel_flat_split_stop") {
        result.verified = true;
        result.status = "canceled";
        result.positionId = request.positionId;
        result.flat = true;
        result.canceledStopOrderId = request.stopToCancel.orderId;
        result.cancellationIntentId = request.cancellationIntentId;
        result.knownRemainingStopOrderIds = [...request.knownRemainingStopOrderIds];
        result.remainingKnownStopOrderIds = exchange.orders.map((order) => order.orderId);
      } else if (request.operation === "close_leg" && request.fullSplitAbort === true) {
        result.exchangeOrderId = "impulse-runner-abort-close";
        result.fill = {
          price: "100",
          quantity: String(request.quantity),
          at: new Date(NOW + 1_000).toISOString(),
          fees: { VST: "0.02" },
        };
      } else if (request.operation === "close_leg") {
        result.exchangeOrderId = "impulse-partial-close";
        result.fill = {
          price: 90,
          quantity: Number(request.quantity),
          at: new Date(NOW).toISOString(),
          fees: { VST: "0.01" },
        };
        const retainedLeg = request.leg === "core" ? "runner" : "core";
        result.autoResize = {
          awarenessRequired: true,
          retainedStopOrderId: request[`${retainedLeg}Stop`].orderId,
          observedQuantity: String(
            Number(request.previousQuantity) - Number(request.quantity),
          ),
        };
      }
      return mutateEvidence ? mutateEvidence(request, result) ?? result : result;
    },
  };
  return {
    signal: impulse,
    store,
    broker,
    exchange,
    mutations,
    mutationRequests,
    readPositionCalls,
    makeOpenStop: openStop,
    setMarkPrice(value) {
      markPrice = value;
      markObservedAt = NOW + 1_000;
    },
  };
}

test("unknown positions stay visible and keep independent symbol-scoped alerts", async () => {
  let now = NOW;
  const positions = ["ETHUSDT", "BTCUSDT"].map((symbol, index) => ({
    sourceSignalId: `unknown-position-${index}`,
    symbol,
    status: "unknown",
    snapshot: {
      sourceSignalId: `unknown-position-${index}`,
      symbol,
      status: "unknown",
      environment: "vst",
      accountId: "vst-account",
      patternId: "liquidation_cascade",
    },
  }));
  const alerts = [];
  const store = {
    async withLeaderLock(callback) { return callback(); },
    async listOpenPositions() { return positions; },
    async reserveIntent() { throw new Error("no intents are present"); },
    async getIntent() { return null; },
    async listUnresolvedIntents() { return []; },
    async listPendingCandidates() { return []; },
    async getPending() { return null; },
    async setSignalStatus() {},
    async recordEvent() {},
    async upsertPosition(position) {
      const row = positions.find((item) =>
        item.sourceSignalId === position.sourceSignalId);
      Object.assign(row, { status: position.status, snapshot: position });
    },
  };
  const broker = {
    async getCapabilities() {
      return {
        environment: "vst",
        verified: true,
        accountId: "vst-account",
        features: [...FULL_CAPABILITIES, "impulse_runner_stop_and_partial_close"],
      };
    },
    async readAccountState() {
      return {
        verified: true,
        environment: "vst",
        accountId: "vst-account",
        positions: [],
        openOrders: [],
      };
    },
    async readMarketMark() { throw new Error("unexpected mark read"); },
    async readPosition() { throw new Error("unknown positions need no exchange read"); },
    async reconcileIntent() { throw new Error("no intents are present"); },
    async readPlanningInputs() { throw new Error("there are no candidates"); },
    async performIntent() { throw new Error("there are no actions"); },
  };
  const worker = createVstWorker({
    store,
    broker,
    clock: () => now,
    onBlocked: async (info) => alerts.push(info),
  });

  const first = await worker.runOnce();
  assert.equal(first.kind, "unknown");
  assert.equal(first.scope, "symbol");
  assert.equal(first.symbol, "ETHUSDT");
  now += 5 * 60_000 + 1;
  const repeated = await worker.runOnce();
  assert.equal(repeated.kind, "unknown");
  assert.equal(repeated.scope, "symbol");
  assert.deepEqual(alerts.map((item) => [item.symbol, item.scope]).sort(),
    [["BTCUSDT", "symbol"], ["ETHUSDT", "symbol"]]);
  assert.equal(alerts.length, 2,
    "the local position timers report each symbol once without shared-alert duplicates");
});

const signal = {
  sourceSignalId: "cab-signal-121",
  confirmationStatus: "confirmed",
  patternStatus: "approved",
  side: "buy",
  orderType: "market",
  patternId: "balanced_grind",
  symbol: "ETHUSDT",
  signalAt: new Date().toISOString(),
  referencePrice: "100",
  stopLoss: "90",
  payload: { rulesVersion: "bullet-long-exits-v2", exitRules: EXIT_RULES },
};

test("VST store persists only in its isolated table namespace", async () => {
  const statements = [];
  const pool = {
    async query(sql, params) {
      statements.push({ sql, params });
      return { rowCount: 1, rows: [{ status: "pending" }] };
    },
    async connect() { throw new Error("not needed"); },
  };
  const store = createVstStore(pool);
  const result = await store.enqueue(signal);
  assert.equal(result.kind, "new");
  assert.match(statements[0].sql, /INSERT INTO vst_signals/);
  assert.doesNotMatch(statements[0].sql, /btb_(?:signals|positions|paper)/);
});

test("VST store refuses persisting credential-shaped fields", async () => {
  let queries = 0;
  const pool = {
    async query() { queries += 1; return { rowCount: 0, rows: [] }; },
    async connect() { throw new Error("not needed"); },
  };
  const store = createVstStore(pool);
  await assert.rejects(
    store.enqueue({ ...signal, apiKey: "not-a-real-secret" }),
    /Credentials are not allowed/,
  );
  assert.equal(queries, 0);
});

// A minimal pool + client double for exercising the real reserveIntent
// transaction (per-signal advisory lock, ledger terminal-state checks, and
// exact phase reservation) without a live database.
function assertIntentSerializationLockOrder(statements, sourceSignalId) {
  const lockIndexes = statements
    .map(({ sql }, index) => sql === INTENT_SERIALIZATION_LOCK_SQL ? index : -1)
    .filter((index) => index >= 0);
  assert.ok(lockIndexes.length > 0, "expected per-signal transaction advisory locks");
  for (const lockIndex of lockIndexes) {
    const lock = statements[lockIndex];
    assert.deepEqual(lock.params, [INTENT_SERIALIZATION_LOCK_NAMESPACE, sourceSignalId]);
    let beginIndex = -1;
    for (let index = lockIndex - 1; index >= 0; index -= 1) {
      if (statements[index].sql === "BEGIN") {
        beginIndex = index;
        break;
      }
    }
    const endIndex = statements.findIndex(({ sql }, index) =>
      index > lockIndex && ["COMMIT", "ROLLBACK"].includes(sql));
    assert.ok(endIndex > lockIndex, "advisory lock is released by transaction end");
    const firstRowLockIndex = statements.findIndex(({ sql }, index) =>
      index > beginIndex && index < endIndex && sql.includes("FOR UPDATE"));
    assert.ok(firstRowLockIndex < 0 || lockIndex < firstRowLockIndex,
      "advisory lock must precede ledger row locks");
  }
}

function intentReservationTestPool() {
  const rows = new Map();
  const statements = [];
  const client = {
    async query(sql, params = []) {
      const trimmed = sql.trim();
      statements.push({ sql: trimmed, params });
      if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK") {
        return { rowCount: 0, rows: [] };
      }
      if (trimmed === INTENT_SERIALIZATION_LOCK_SQL) {
        assert.equal(params[0], INTENT_SERIALIZATION_LOCK_NAMESPACE);
        assert.equal(typeof params[1], "string");
        assert.ok(params[1].length > 0);
        return { rowCount: 1, rows: [{ pg_advisory_xact_lock: null }] };
      }
      if (trimmed ===
          "SELECT status FROM vst_positions WHERE source_signal_id = $1 FOR UPDATE") {
        return { rowCount: 0, rows: [] };
      }
      if (trimmed ===
          "SELECT status FROM vst_signals WHERE source_signal_id = $1 FOR UPDATE") {
        return { rowCount: 1, rows: [{ status: "opening" }] };
      }
      if (sql.includes("INSERT INTO vst_order_intents")) {
        const [sourceSignalId, phase, clientOrderId, request] = params;
        const key = `${sourceSignalId}::${phase}`;
        if (rows.has(key)) return { rowCount: 0, rows: [] };
        const now = new Date().toISOString();
        const row = {
          source_signal_id: sourceSignalId,
          phase,
          client_order_id: clientOrderId,
          request: JSON.parse(request),
          state: "prepared",
          exchange_order_id: null,
          outcome: null,
          created_at: now,
          updated_at: now,
        };
        rows.set(key, row);
        return { rowCount: 1, rows: [row] };
      }
      if (sql.includes("FROM vst_order_intents") && sql.includes("FOR UPDATE")) {
        const [sourceSignalId, phase] = params;
        const row = rows.get(`${sourceSignalId}::${phase}`);
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      throw new Error(`Unexpected query in intentReservationTestPool: ${sql}`);
    },
    release() {},
  };
  return {
    statements,
    async connect() { return client; },
    async query() { throw new Error("not needed"); },
  };
}

test("reserveIntent treats a re-stamped intentCreatedAt as the same reservation, not a conflict", async () => {
  // Reproduces the cab-signal-13402/13420/13426 incident: prepareIntentRequest
  // (vst-worker.mjs) races its own "reuse the persisted intentCreatedAt"
  // lookup against a re-entry into openSignal for a phase that already
  // reconciled, and can rebuild the leverage request with a freshly stamped
  // timestamp even though every real order fact is unchanged.
  const pool = intentReservationTestPool();
  const store = createVstStore(pool);
  const baseRequest = {
    operation: "set_isolated_leverage",
    accountId: "vst-account",
    symbol: "FARTCOINUSDT",
    leverage: 10,
    marginMode: "ISOLATED",
    environment: "vst",
    intentCreatedAt: 1_000,
  };
  const first = await store.reserveIntent({
    sourceSignalId: "cab-signal-13402",
    phase: "isolated-leverage-10",
    clientOrderId: "order-fartcoin-leverage",
    request: baseRequest,
  });
  assert.equal(first.kind, "new");

  const second = await store.reserveIntent({
    sourceSignalId: "cab-signal-13402",
    phase: "isolated-leverage-10",
    clientOrderId: "order-fartcoin-leverage",
    request: { ...baseRequest, intentCreatedAt: 2_000 },
  });
  assert.equal(second.kind, "existing");
  // The first-committed timestamp wins; reservation is not rewritten.
  assert.equal(second.intent.request.intentCreatedAt, 1_000);
  assertIntentSerializationLockOrder(pool.statements, "cab-signal-13402");
});

test("reserveIntent still rejects a genuine order-fact mismatch for the same phase", async () => {
  const pool = intentReservationTestPool();
  const store = createVstStore(pool);
  const baseRequest = {
    operation: "set_isolated_leverage",
    accountId: "vst-account",
    symbol: "UNIUSDT",
    leverage: 10,
    marginMode: "ISOLATED",
    environment: "vst",
    intentCreatedAt: 1_000,
  };
  const first = await store.reserveIntent({
    sourceSignalId: "cab-signal-13420",
    phase: "isolated-leverage-10",
    clientOrderId: "order-uni-leverage",
    request: baseRequest,
  });
  assert.equal(first.kind, "new");

  await assert.rejects(
    store.reserveIntent({
      sourceSignalId: "cab-signal-13420",
      phase: "isolated-leverage-10",
      clientOrderId: "order-uni-leverage",
      // leverage genuinely differs, not just the bookkeeping timestamp:
      // this must still be rejected as a real conflict.
      request: { ...baseRequest, leverage: 20, intentCreatedAt: 2_000 },
    }),
    /VST intent phase already exists with conflicting order facts/,
  );
  assertIntentSerializationLockOrder(pool.statements, "cab-signal-13420");
});

test("missing broker interface preserves pending signal and never fabricates a fill", async () => {
  const store = memoryStore(signal);
  let brokerCalls = 0;
  const worker = createVstWorker({
    store,
    broker: { performIntent: async () => { brokerCalls += 1; } },
    sizingLimits: { environment: "vst" },
  });
  const result = await worker.runOnce();
  assert.equal(result.kind, "waiting");
  assert.match(result.reason, /unsupported_vst_broker_interface/);
  assert.equal(store.data.status, "pending");
  assert.equal(store.data.pending.status, "pending");
  assert.equal(store.data.positions.length, 0);
  assert.equal(brokerCalls, 0);
});

test("mainnet or unverified broker declarations fail before any mutation", async () => {
  const store = memoryStore(signal);
  let mutationCalls = 0;
  const broker = {
    async getCapabilities() {
      return {
        environment: "mainnet",
        verified: true,
        accountId: "account",
        features: [],
      };
    },
    async readPlanningInputs() { throw new Error("must not read after wrong environment"); },
    async readAccountState() { throw new Error("must not read after wrong environment"); },
    async readMarketMark() { throw new Error("must not read after wrong environment"); },
    async reconcileIntent() { throw new Error("must not reconcile after wrong environment"); },
    async readPosition() { throw new Error("must not read after wrong environment"); },
    async performIntent() { mutationCalls += 1; },
  };
  const result = await createVstWorker({
    store, broker, sizingLimits: { environment: "vst" },
  }).runOnce();
  assert.equal(result.kind, "blocked");
  assert.match(result.reason, /unverified_or_wrong_environment/);
  assert.equal(store.data.status, "pending");
  assert.equal(store.data.pending.status, "pending");
  assert.equal(mutationCalls, 0);
});

test("verified ETHUSDT signal reaches safe broker planning with BTC-only bootstrap evidence", async () => {
  const ethSignal = {
    ...activePolicy({ stopLoss: "95" }),
    sourceSignalId: "verified-eth-planning",
    signalAt: new Date(NOW).toISOString(),
  };
  const store = memoryStore(ethSignal);
  const planningSymbols = [];
  const mutationRequests = [];
  const broker = guardedBroker(store, {
    currentPosition: null,
    onPerform: async (intent) => { mutationRequests.push(intent); },
    reconcile: async ({ request }) => ({
      verified: true,
      status: "filled",
      position: { marginMode: "ISOLATED", leverage: 10 },
    }),
  });
  broker.getCapabilities = async () => ({
    environment: "vst",
    verified: true,
    accountId: "vst-account",
    features: FULL_CAPABILITIES,
    evidence: { canarySymbols: ["BTCUSDT"] },
  });
  broker.readPlanningInputs = async (requestedSignal) => {
    planningSymbols.push(requestedSignal.symbol);
    return {
      balanceSnapshot: {
        asset: "VST", balance: "98455.6472", equity: "98455.6472",
        availableMargin: "98455.6472",
      },
      quote: { price: "100", observedAtMs: NOW - 1_000 },
      filters: {
        symbol: "ETH-USDT",
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
  };

  const result = await createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  }).runOnce();

  assert.equal(result.kind, "prepared", JSON.stringify(result));
  assert.deepEqual(planningSymbols, ["ETHUSDT"]);
  assert.equal(store.data.status, "planning");
  assert.deepEqual(mutationRequests.map(({ phase, request }) =>
    [phase, request.symbol]), [["isolated-leverage-10", "ETHUSDT"]]);
});

test("an entry whose exchange evidence never verifies is marked unknown and notifies the owner exactly once", async () => {
  // Reproduces the production gap where a market entry was submitted, its
  // fill could not be confirmed, and the position sat untracked/unprotected
  // with no Telegram notification at all until someone checked by hand.
  const ethSignal = {
    ...activePolicy({ stopLoss: "95" }),
    sourceSignalId: "entry-evidence-unverified",
    signalAt: new Date(NOW).toISOString(),
  };
  const store = memoryStore(ethSignal);
  const broker = guardedBroker(store, {
    currentPosition: null,
    reconcile: async ({ phase }) => phase === "market-entry"
      ? { verified: false, status: "unknown" }
      : { verified: true, status: "filled", position: { marginMode: "ISOLATED", leverage: 10 } },
  });
  broker.getCapabilities = async () => ({
    environment: "vst", verified: true, accountId: "vst-account",
    features: FULL_CAPABILITIES, evidence: { canarySymbols: ["BTCUSDT"] },
  });
  broker.readPlanningInputs = async () => safePlanningInputs();
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  const first = await worker.runOnce();
  assert.equal(first.kind, "prepared", JSON.stringify(first));
  const second = await worker.runOnce();
  assert.equal(second.kind, "unknown", JSON.stringify(second));
  assert.equal(second.reason, "entry_result_not_verified");
  assert.equal(store.data.status, "unknown");
  const notified = store.data.events.filter(([, kind]) => kind === "vst_action_unresolved");
  assert.equal(notified.length, 1);
  assert.equal(notified[0][2].operation, "entry");
  assert.equal(notified[0][2].reason, "entry_result_not_verified");
  // Must never carry a clientOrderId -- the Telegram queue's failure-kind
  // branch requires client_order_id IS NULL, or this event could never send.
  assert.equal(notified[0].length, 3);
  // A third tick finds the same intent already unknown and must stay silent.
  await worker.runOnce();
  assert.equal(
    store.data.events.filter(([, kind]) => kind === "vst_action_unresolved").length, 1,
  );
});

test("submission callback durably records exact native order ID before failure and restart never reposts", async () => {
  const nativeOrderId = "2105896637783695360";
  let entryPosts = 0;
  let callbackPersistedBeforeFailure = false;
  const fixture = await preparedEntryFixture({
    sourceSignalId: "native-order-id-callback-restart",
    onPerform: async (intent) => {
      if (intent.request.operation !== "entry") return;
      entryPosts += 1;
      await intent.onSubmission({ exchangeOrderId: nativeOrderId });
      const submitted = fixture.store.data.intents.find((row) =>
        row.clientOrderId === intent.clientOrderId);
      assert.equal(submitted.state, "submitted");
      assert.equal(submitted.exchangeOrderId, nativeOrderId);
      callbackPersistedBeforeFailure = true;
      throw new Error("entry verification failed after native submission response");
    },
  });

  const firstResult = await fixture.worker.runOnce();
  assert.equal(firstResult.kind, "unknown");
  assert.equal(callbackPersistedBeforeFailure, true);
  const entryIntent = fixture.store.data.intents.find((row) =>
    row.request.operation === "entry");
  assert.equal(entryIntent.state, "unknown");
  assert.equal(entryIntent.exchangeOrderId, nativeOrderId);
  assert.equal(entryIntent.detail.exchangeOrderId, nativeOrderId);

  const reconciledIds = [];
  let replayPosts = 0;
  const restartedBroker = guardedBroker(fixture.store, {
    currentPosition: null,
    onPerform: async () => { replayPosts += 1; },
    reconcile: async (intent) => {
      if (intent.phase === "market-entry") {
        const persisted = fixture.store.data.intents.find((row) =>
          row.clientOrderId === intent.clientOrderId);
        reconciledIds.push(persisted.exchangeOrderId);
        return { verified: false, status: "unknown" };
      }
      return {
        verified: true, status: "filled",
        position: { marginMode: "ISOLATED", leverage: 10 },
      };
    },
  });
  restartedBroker.getCapabilities = fixture.broker.getCapabilities;
  restartedBroker.readPlanningInputs = fixture.broker.readPlanningInputs;
  await fixture.makeWorker(restartedBroker).runOnce();
  assert.equal(entryPosts, 1);
  assert.equal(replayPosts, 0);
  assert.deepEqual(reconciledIds, [nativeOrderId]);
});

test("submission response and tagged post-error IDs are retained; missing IDs never get invented or replayed", async (context) => {
  const nativeOrderId = "2105896637783695360";
  const cases = [
    {
      name: "broker-returned ID without callback",
      onPerform: async (intent) => intent.request.operation === "entry"
        ? { exchangeOrderId: nativeOrderId }
        : undefined,
      reconcile: async (intent) => intent.phase === "market-entry"
        ? { verified: false, status: "unknown", exchangeOrderId: nativeOrderId }
        : {
          verified: true, status: "filled",
          position: { marginMode: "ISOLATED", leverage: 10 },
        },
      expectedId: nativeOrderId,
    },
    {
      name: "ID tagged on a post-submission error",
      onPerform: async (intent) => {
        if (intent.request.operation !== "entry") return;
        throw Object.assign(new Error("transport failed after response"), {
          exchangeOrderId: nativeOrderId,
        });
      },
      expectedId: nativeOrderId,
    },
    {
      name: "pre-POST throw has no invented ID",
      onPerform: async (intent) => {
        if (intent.request.operation !== "entry") return;
        throw new Error("request failed before POST");
      },
      expectedId: undefined,
    },
    {
      name: "unsafe numeric callback ID is refused",
      onPerform: async (intent) => {
        if (intent.request.operation === "entry") {
          await intent.onSubmission({ exchangeOrderId: 2105896637783695360 });
        }
      },
      expectedId: undefined,
    },
    {
      name: "missing callback ID is refused",
      onPerform: async (intent) => {
        if (intent.request.operation === "entry") {
          await intent.onSubmission({});
        }
      },
      expectedId: undefined,
    },
  ];

  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      let entryPosts = 0;
      const onPerform = async (intent) => {
        if (intent.request.operation === "entry") entryPosts += 1;
        return scenario.onPerform(intent);
      };
      const fixture = await preparedEntryFixture({
        sourceSignalId: `native-id-${scenario.name.replaceAll(/[^a-z0-9]+/gi, "-")}`,
        onPerform,
        reconcile: scenario.reconcile,
      });
      const result = await fixture.worker.runOnce();
      assert.equal(result.kind, "unknown");
      const entryIntent = fixture.store.data.intents.find((row) =>
        row.request.operation === "entry");
      assert.equal(entryIntent.state, "unknown");
      assert.equal(entryIntent.exchangeOrderId, scenario.expectedId);

      let replayPosts = 0;
      const restartedBroker = guardedBroker(fixture.store, {
        currentPosition: null,
        onPerform: async () => { replayPosts += 1; },
        reconcile: async (intent) => {
          if (intent.phase === "market-entry") {
            const persisted = fixture.store.data.intents.find((row) =>
              row.clientOrderId === intent.clientOrderId);
            assert.equal(persisted.exchangeOrderId, scenario.expectedId);
            return { verified: false, status: "unknown" };
          }
          return {
            verified: true, status: "filled",
            position: { marginMode: "ISOLATED", leverage: 10 },
          };
        },
      });
      restartedBroker.getCapabilities = fixture.broker.getCapabilities;
      restartedBroker.readPlanningInputs = fixture.broker.readPlanningInputs;
      await fixture.makeWorker(restartedBroker).runOnce();
      assert.equal(entryPosts, 1);
      assert.equal(replayPosts, 0);
    });
  }
});

test("malicious non-canonical signal symbols are rejected before broker writes", async () => {
  const maliciousSignal = {
    ...signal,
    sourceSignalId: "malicious-symbol-before-write",
    symbol: "ETHUSDT;BTCUSDT",
    signalAt: new Date(NOW).toISOString(),
  };
  const store = memoryStore(maliciousSignal);
  const broker = guardedBroker(store, { currentPosition: null });
  let planningReads = 0;
  let mutationCalls = 0;
  broker.readPlanningInputs = async () => {
    planningReads += 1;
    throw new Error("invalid symbol must be rejected before planning");
  };
  broker.performIntent = async () => { mutationCalls += 1; };

  const result = await createVstWorker({
    store, broker, clock: () => NOW, sizingLimits: { environment: "vst" },
  }).runOnce();

  const reason = "invalid_canonical_vst_symbol";
  assert.equal(result.kind, "rejected");
  assert.equal(result.reason, reason);
  assert.equal(store.data.status, "rejected");
  assert.equal(store.data.reason, reason);
  assert.equal(store.data.pending.status, "rejected");
  assert.equal(planningReads, 0);
  assert.equal(mutationCalls, 0);
  assert.equal(store.data.intents.length, 0);
  assert.ok(store.data.events.some(([, kind, detail]) =>
    kind === "vst_signal_rejected" && detail.reason === reason));
});

test("a currently-offline BingX contract rejects the signal instead of recording an opaque error", async () => {
  const offlineSignal = {
    ...signal,
    sourceSignalId: "offline-contract-signal",
    symbol: "ICPUSDT",
    signalAt: new Date(NOW).toISOString(),
  };
  const store = memoryStore(offlineSignal);
  const broker = guardedBroker(store, { currentPosition: null });
  let planningReads = 0;
  broker.readPlanningInputs = async () => {
    planningReads += 1;
    throw Object.assign(new Error("bingx_vst_symbol_currently_offline:ICP-USDT"), {
      code: "vst_symbol_currently_offline",
      exchangeMessage: "ICP-USDT is offline currently,all validted symbols in api:" +
        "/openApi/swap/v2/quote/contracts, please verify it",
    });
  };

  const result = await createVstWorker({
    store, broker, clock: () => NOW, sizingLimits: { environment: "vst" },
  }).runOnce();

  assert.equal(result.kind, "rejected");
  assert.match(result.reason, /^vst_symbol_currently_offline:ICP-USDT is offline currently/);
  assert.equal(store.data.status, "rejected");
  assert.equal(planningReads, 1);
  assert.ok(store.data.events.some(([, kind, detail]) =>
    kind === "vst_signal_rejected" && detail.reason === result.reason));
});

test("persisted ETHUSDT positions remain managed with BTC-only bootstrap evidence", async () => {
  const signalBody = {
    ...activePolicy(),
    sourceSignalId: "persisted-eth-position",
    signalAt: new Date(NOW).toISOString(),
  };
  const store = memoryStore(null);
  const policy = createVstPolicy({
    signal: signalBody,
    fill: { price: 100, quantity: 10, at: new Date(NOW).toISOString() },
  });
  await store.upsertPosition({
    ...policy,
    sourceSignalId: signalBody.sourceSignalId,
    status: "open",
    sizing: { quantity: "10" },
    marginMode: "ISOLATED",
    leverage: 10,
    environment: "vst",
    accountId: "vst-account",
  });
  const readCalls = { accountState: 0, position: 0, marketMark: 0 };
  let mutationCalls = 0;
  const broker = guardedBroker(store, {
    currentPosition: {
      verified: true,
      symbol: "ETHUSDT",
      side: "Buy",
      quantity: 10,
      avgPrice: 100,
      leverage: 10,
      marginMode: "ISOLATED",
      pricePrecision: 2,
      protectiveStops: {
        core: {
          verified: true, stopPrice: 90, quantity: 10, orderId: "eth-core-stop",
        },
      },
    },
    marketMark: {
      verified: true, price: 101, observedAt: new Date(NOW + 60_000).toISOString(),
    },
    readCalls,
    onPerform: async () => { mutationCalls += 1; },
  });
  broker.getCapabilities = async () => ({
    environment: "vst",
    verified: true,
    accountId: "vst-account",
    features: FULL_CAPABILITIES,
    evidence: { canarySymbols: ["BTCUSDT"] },
  });

  const result = await createVstWorker({
    store, broker, clock: () => NOW, sizingLimits: { environment: "vst" },
  }).runOnce();

  assert.equal(result.kind, "idle");
  assert.deepEqual(readCalls, { accountState: 1, position: 1, marketMark: 1 });
  assert.equal(mutationCalls, 0);
  assert.equal(store.data.positions[0].snapshot.symbol, "ETHUSDT");
});

test("a pending signal for a fresh symbol opens while a different symbol already has an open ledger and exchange position", async () => {
  // Reproduces the production bug directly: a whole-account "position or
  // order already exists" guard used to reject every OTHER symbol's brand
  // new signal just because one symbol (here SOLUSDT) already had an open
  // position. With 90+ concurrent positions expected, this must never
  // happen -- only the SAME symbol already being open may block a signal.
  const secondSymbolSignal = {
    ...activePolicy(),
    sourceSignalId: "concurrent-second-symbol",
    symbol: "ETHUSDT",
    signalAt: new Date(NOW).toISOString(),
  };
  const store = memoryStore(secondSymbolSignal);
  const firstSymbolPolicy = createVstPolicy({
    signal: { ...activePolicy(), sourceSignalId: "concurrent-first-symbol", symbol: "SOLUSDT" },
    fill: { price: 100, quantity: 1, at: new Date(NOW).toISOString() },
  });
  await store.upsertPosition({
    ...firstSymbolPolicy,
    sourceSignalId: "concurrent-first-symbol",
    symbol: "SOLUSDT",
    status: "open",
    sizing: { quantity: "1" },
    marginMode: "ISOLATED",
    leverage: 10,
    environment: "vst",
    accountId: "vst-account",
  });

  const firstSymbolPosition = {
    verified: true,
    symbol: "SOLUSDT",
    side: "Buy",
    quantity: 1,
    avgPrice: 100,
    leverage: 10,
    marginMode: "ISOLATED",
    pricePrecision: 2,
    protectiveStops: {
      core: { verified: true, stopPrice: 90, quantity: 1, orderId: "sol-core-stop" },
    },
  };
  const planningSymbols = [];
  const mutationRequests = [];
  const broker = guardedBroker(store, {
    currentPosition: firstSymbolPosition,
    marketMark: {
      verified: true, price: 101, observedAt: new Date(NOW + 60_000).toISOString(),
    },
    onPerform: async (intent) => { mutationRequests.push(intent); },
    reconcile: async () => ({
      verified: true, status: "filled", position: { marginMode: "ISOLATED", leverage: 10 },
    }),
  });
  broker.getCapabilities = async () => ({
    environment: "vst",
    verified: true,
    accountId: "vst-account",
    features: FULL_CAPABILITIES,
    evidence: { canarySymbols: ["BTCUSDT"] },
  });
  broker.readPlanningInputs = async (requestedSignal) => {
    planningSymbols.push(requestedSignal.symbol);
    return {
      balanceSnapshot: {
        asset: "VST", balance: "98455.6472", equity: "98455.6472",
        availableMargin: "98455.6472",
      },
      quote: { price: "100", observedAtMs: NOW - 1_000 },
      filters: {
        symbol: "ETH-USDT",
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
  };

  const result = await createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  }).runOnce();

  assert.equal(result.kind, "prepared", JSON.stringify(result));
  assert.deepEqual(planningSymbols, ["ETHUSDT"]);
  assert.deepEqual(mutationRequests.map(({ phase, request }) =>
    [phase, request.symbol]), [["isolated-leverage-10", "ETHUSDT"]]);
  // SOLUSDT's own position must stay exactly as it was -- unrelated,
  // untouched, and not consulted as a reason to block ETHUSDT.
  assert.equal(store.data.positions.find((row) => row.symbol === "SOLUSDT").status, "open");
});

test("an uncorroborated position mark waits only that symbol and permits another candidate", async () => {
  const secondSymbolSignal = {
    ...activePolicy(),
    sourceSignalId: "mark-failure-second-symbol",
    symbol: "ETHUSDT",
    signalAt: new Date(NOW).toISOString(),
  };
  const store = memoryStore(secondSymbolSignal);
  const firstSymbolPolicy = createVstPolicy({
    signal: {
      ...activePolicy(),
      sourceSignalId: "mark-failure-first-symbol",
      symbol: "SOLUSDT",
    },
    fill: { price: 100, quantity: 1, at: new Date(NOW).toISOString() },
  });
  await store.upsertPosition({
    ...firstSymbolPolicy,
    sourceSignalId: "mark-failure-first-symbol",
    symbol: "SOLUSDT",
    status: "open",
    sizing: { quantity: "1" },
    marginMode: "ISOLATED",
    leverage: 10,
    environment: "vst",
    accountId: "vst-account",
  });
  const positionBefore = structuredClone(store.data.positions[0]);
  const firstSymbolPosition = {
    verified: true,
    symbol: "SOLUSDT",
    side: "Buy",
    quantity: 1,
    avgPrice: 100,
    leverage: 10,
    marginMode: "ISOLATED",
    pricePrecision: 2,
    protectiveStops: {
      core: { verified: true, stopPrice: 90, quantity: 1, orderId: "sol-core-stop" },
    },
  };
  const planningSymbols = [];
  const mutationRequests = [];
  const broker = guardedBroker(store, {
    currentPosition: firstSymbolPosition,
    onPerform: async (intent) => { mutationRequests.push(intent); },
    reconcile: async () => ({
      verified: true, status: "filled", position: { marginMode: "ISOLATED", leverage: 10 },
    }),
  });
  broker.getCapabilities = async () => ({
    environment: "vst",
    verified: true,
    accountId: "vst-account",
    features: FULL_CAPABILITIES,
    evidence: { canarySymbols: ["BTCUSDT"] },
  });
  broker.readMarketMark = async (symbol) => {
    assert.equal(symbol, "SOLUSDT");
    throw new Error("VST mark is not corroborated by a fresh quote");
  };
  broker.readPlanningInputs = async (requestedSignal) => {
    planningSymbols.push(requestedSignal.symbol);
    return safePlanningInputs();
  };

  const result = await createVstWorker({
    store,
    broker,
    clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  }).runOnce();

  assert.equal(result.kind, "prepared", JSON.stringify(result));
  assert.deepEqual(planningSymbols, ["ETHUSDT"], "the other symbol reaches openSignal");
  assert.equal(mutationRequests.length, 1, "the one-action-per-tick boundary remains intact");
  assert.deepEqual(
    store.data.positions[0],
    positionBefore,
    "the mark failure leaves the first symbol's ledger snapshot unchanged",
  );
});

test("a generic position mark read error still propagates", async () => {
  const positionSignal = {
    ...activePolicy(),
    sourceSignalId: "generic-mark-error-position",
    symbol: "SOLUSDT",
    signalAt: new Date(NOW).toISOString(),
  };
  const store = memoryStore(null);
  const positionPolicy = createVstPolicy({
    signal: positionSignal,
    fill: { price: 100, quantity: 1, at: new Date(NOW).toISOString() },
  });
  await store.upsertPosition({
    ...positionPolicy,
    sourceSignalId: positionSignal.sourceSignalId,
    symbol: positionSignal.symbol,
    status: "open",
    sizing: { quantity: "1" },
    marginMode: "ISOLATED",
    leverage: 10,
    environment: "vst",
    accountId: "vst-account",
  });
  const broker = guardedBroker(store, {
    currentPosition: {
      verified: true,
      symbol: "SOLUSDT",
      side: "Buy",
      quantity: 1,
      avgPrice: 100,
      leverage: 10,
      marginMode: "ISOLATED",
      protectiveStops: {
        core: { verified: true, stopPrice: 90, quantity: 1, orderId: "sol-core-stop" },
      },
    },
  });
  broker.getCapabilities = async () => ({
    environment: "vst",
    verified: true,
    accountId: "vst-account",
    features: FULL_CAPABILITIES,
    evidence: { canarySymbols: ["BTCUSDT"] },
  });
  broker.readMarketMark = async () => {
    throw new Error("unrelated market read failure");
  };

  await assert.rejects(
    createVstWorker({
      store, broker, clock: () => NOW, sizingLimits: { environment: "vst" },
    }).runOnce(),
    /unrelated market read failure/,
  );
});

test("the execution pause switch still prevents all worker activity", async () => {
  const store = memoryStore(signal);
  let capabilityReads = 0;
  const broker = guardedBroker(store);
  const getCapabilities = broker.getCapabilities;
  broker.getCapabilities = async () => {
    capabilityReads += 1;
    return getCapabilities();
  };
  process.env.BULLET_VST_PAUSED = "1";
  try {
    const result = await createVstWorker({
      store, broker, sizingLimits: { environment: "vst" },
    }).runOnce();
    assert.equal(result.kind, "paused");
    assert.equal(capabilityReads, 0);
    assert.equal(store.data.pending.status, "pending");
  } finally {
    process.env.BULLET_VST_PAUSED = "0";
  }
});

test("impulse entry persists exact split and advances core, runner, then original cancel", async () => {
  const fixture = impulseLifecycleFixture();
  const stopStateBeforePhase = [];
  const performIntent = fixture.broker.performIntent;
  fixture.broker.performIntent = async (intent) => {
    if ([
      "split_core_stop", "split_runner_stop", "cancel_original_stop",
    ].includes(intent.request.operation)) {
      stopStateBeforePhase.push({
        operation: intent.request.operation,
        orderIds: fixture.exchange.orders.map((order) => order.orderId).sort(),
      });
    }
    return performIntent(intent);
  };
  const worker = createVstWorker({
    store: fixture.store,
    broker: fixture.broker,
    clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  assert.equal((await worker.runOnce()).kind, "prepared");
  const result = await worker.runOnce();
  assert.equal(result.kind, "acted", JSON.stringify(result));
  assert.equal(result.operation, "cancel_original_stop");
  const saved = fixture.store.data.positions[0].snapshot;
  assert.equal(saved.status, "open");
  assert.equal(saved.executionStatus, "open");
  assert.equal(saved.split.stage, "complete");
  assert.equal(saved.runnerStopPrice, 100);
  assert.equal(saved.coreStopOrderId, "impulse-core-stop");
  assert.equal(saved.runnerStopOrderId, "impulse-runner-stop");
  assert.equal(saved.persistedPosition.originalStop, undefined);
  assert.equal(saved.persistedPosition.protectiveStops.core.orderId, "impulse-core-stop");
  assert.equal(saved.persistedPosition.protectiveStops.runner.orderId, "impulse-runner-stop");
  assert.deepEqual(fixture.exchange.orders.map((row) => row.orderId).sort(),
    ["impulse-core-stop", "impulse-runner-stop"]);
  assert.deepEqual(fixture.mutations, [
    "set_isolated_leverage", "entry", "split_core_stop",
    "split_runner_stop", "cancel_original_stop",
  ]);
  assert.deepEqual(stopStateBeforePhase, [
    { operation: "split_core_stop", orderIds: ["impulse-original-stop"] },
    { operation: "split_runner_stop",
      orderIds: ["impulse-core-stop", "impulse-original-stop"] },
    { operation: "cancel_original_stop",
      orderIds: ["impulse-core-stop", "impulse-original-stop", "impulse-runner-stop"] },
  ]);
  assert.ok(fixture.readPositionCalls.every((call) =>
    call.allowProcessCache === false && call.persistedPosition?.verified === true),
  "fresh workers must recover exact persisted stops without process-local cache");
  assert.ok(fixture.store.data.intents.every((intent) => intent.state === "reconciled"));
});

test("unknown split phase after entry stops the same-tick chain immediately", async () => {
  const fixture = impulseLifecycleFixture({
    mutateEvidence: (request, evidence) =>
      request.operation === "split_core_stop"
        ? {
            ...evidence,
            stop: { ...evidence.stop, quantity: "0" },
          }
        : evidence,
  });
  const worker = createVstWorker({
    store: fixture.store,
    broker: fixture.broker,
    clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });

  await worker.runOnce();
  const result = await worker.runOnce();
  assert.equal(result.kind, "unknown", JSON.stringify(result));
  assert.deepEqual(fixture.mutations, [
    "set_isolated_leverage", "entry", "split_core_stop",
  ]);
  const saved = fixture.store.data.positions[0].snapshot;
  assert.equal(saved.status, "unknown");
  assert.equal(saved.split.stage, "core_pending");
  assert.deepEqual(fixture.exchange.orders.map((row) => row.orderId).sort(),
    ["impulse-core-stop", "impulse-original-stop"]);
  assert.equal(fixture.store.data.intents.some((intent) =>
    intent.request.operation === "split_runner_stop"), false);
  assert.equal(fixture.store.data.intents.some((intent) =>
    intent.request.operation === "cancel_original_stop"), false);
});

test("an existing core-pending split waits on read failure then advances all verified phases", async () => {
  const fixture = impulseLifecycleFixture();
  const originalReadPosition = fixture.broker.readPosition;
  let failOneRead = false;
  fixture.broker.readPosition = async (...args) => {
    if (failOneRead && fixture.exchange.position) {
      failOneRead = false;
      const error = new Error("temporary position read outage");
      error.method = "GET";
      error.endpoint = "/openApi/swap/v2/user/positions";
      error.code = "exchange_busy";
      throw error;
    }
    return originalReadPosition(...args);
  };
  const worker = createVstWorker({
    store: fixture.store,
    broker: fixture.broker,
    clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });

  await worker.runOnce();
  failOneRead = true;
  const deferred = await worker.runOnce();
  assert.equal(deferred.kind, "unknown", JSON.stringify(deferred));
  assert.equal(deferred.reason, "managed_position_read_unavailable");
  assert.equal(deferred.scope, "symbol");
  assert.equal(fixture.store.data.positions[0].snapshot.split.stage, "core_pending");
  assert.deepEqual(fixture.mutations, ["set_isolated_leverage", "entry"]);

  const completed = await worker.runOnce();
  assert.equal(completed.operation, "cancel_original_stop");
  assert.equal(fixture.store.data.positions[0].snapshot.split.stage, "complete");
  assert.deepEqual(fixture.mutations, [
    "set_isolated_leverage", "entry", "split_core_stop",
    "split_runner_stop", "cancel_original_stop",
  ]);
});

test("a source-exit request accepted after core protection preempts extra split phases", async () => {
  const fixture = impulseLifecycleFixture();
  const requests = [];
  Object.assign(fixture.store, {
    async queueSourceExitRequests() { return { queued: [], refreshed: [], rejected: [] }; },
    async listPendingSourceExitRequests() {
      return requests.filter((row) => row.state === "pending");
    },
    async finishSourceExitRequest(requestId, result) {
      const row = requests.find((item) => item.requestId === requestId);
      if (row) Object.assign(row, { state: "finished", result });
    },
    async hasPendingSourceExitRequest(sourceSignalId) {
      return requests.some((row) =>
        row.sourceSignalId === sourceSignalId && row.state === "pending");
    },
    async getPosition(sourceSignalId) {
      return fixture.store.data.positions.find((row) =>
        row.sourceSignalId === sourceSignalId) ?? null;
    },
  });
  const sourceSignalId = fixture.store.data.pending.sourceSignalId;
  const symbol = fixture.store.data.pending.body.symbol;
  const observedAt = new Date(NOW).toISOString();
  const evidence = {
    sourceSignalId,
    symbol,
    reason: "source_withdrawal",
    sourceStatus: "reclassified",
    sourceUpdatedAt: observedAt,
    sourceClosedAt: null,
    sourceExitPrice: null,
    sourceCancelReason: "owner_withdrew_signal",
    exitDecisionAt: observedAt,
    asOf: observedAt,
    observedAt,
  };
  const originalPerformIntent = fixture.broker.performIntent;
  fixture.broker.performIntent = async (intent) => {
    const result = await originalPerformIntent(intent);
    if (intent.request.operation === "split_core_stop") {
      requests.push({
        requestId: "accepted-source-exit-after-core",
        sourceSignalId,
        symbol,
        reason: "source_withdrawal",
        asOf: observedAt,
        observedAt,
        evidence,
        state: "pending",
      });
    }
    return result;
  };
  const worker = createVstWorker({
    store: fixture.store,
    broker: fixture.broker,
    clock: () => NOW,
    sourceExitsEnabled: true,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });

  await worker.runOnce();
  const result = await worker.runOnce();
  assert.equal(result.kind, "waiting");
  assert.equal(result.reason, "source_exit_waiting_for_tick_mutation_boundary");
  assert.deepEqual(fixture.mutations, [
    "set_isolated_leverage", "entry", "split_core_stop",
  ]);
  assert.equal(fixture.store.data.positions[0].snapshot.split.stage, "runner_pending");
  assert.deepEqual(fixture.exchange.orders.map((row) => row.orderId).sort(),
    ["impulse-core-stop", "impulse-original-stop"]);
  assert.equal(requests[0].state, "pending");
});

test("an uncorroborated impulse runner mark waits only after exact original/core stop preflight", async () => {
  const fixture = impulseLifecycleFixture();
  const readMarketMark = fixture.broker.readMarketMark;
  const worker = createVstWorker({
    store: fixture.store,
    broker: fixture.broker,
    clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  assert.equal((await worker.runOnce()).kind, "prepared");
  fixture.broker.readMarketMark = async () => {
    throw new Error("VST mark is not corroborated by a fresh quote");
  };

  const result = await worker.runOnce();

  assert.equal(result.kind, "waiting", JSON.stringify(result));
  assert.equal(result.reason, "impulse_runner_be_requires_fresh_mark_above_entry");
  const saved = fixture.store.data.positions[0].snapshot;
  assert.equal(saved.split.stage, "runner_pending");
  assert.equal(saved.split.coreStop.orderId, "impulse-core-stop");
  assert.deepEqual(fixture.mutations,
    ["set_isolated_leverage", "entry", "split_core_stop"]);
  assert.deepEqual(fixture.exchange.orders.map((row) => row.orderId).sort(),
    ["impulse-core-stop", "impulse-original-stop"]);

  fixture.broker.readMarketMark = readMarketMark;
  const resumed = await worker.runOnce();
  assert.equal(resumed.operation, "cancel_original_stop");
  assert.equal(fixture.store.data.positions[0].snapshot.split.stage, "complete");
  assert.deepEqual(fixture.mutations, [
    "set_isolated_leverage", "entry", "split_core_stop",
    "split_runner_stop", "cancel_original_stop",
  ]);
});

test("impulse entry remains blocked by an explicit missing split capability", async () => {
  const fixture = impulseLifecycleFixture();
  fixture.broker.getCapabilities = async () => ({
    environment: "vst",
    verified: true,
    accountId: "vst-account",
    features: FULL_CAPABILITIES,
    missingCapabilities: [{
      capability: "impulse_runner_stop_and_partial_close",
      reason: "split contract is not advertised",
    }],
  });
  const result = await createVstWorker({
    store: fixture.store,
    broker: fixture.broker,
    clock: () => NOW,
    sizingLimits: { environment: "vst" },
  }).runOnce();
  assert.equal(result.kind, "rejected");
  assert.match(result.reason, /impulse_runner_stop_and_partial_close/);
  assert.equal(fixture.mutations.length, 0);
  assert.equal(fixture.store.data.intents.length, 0);
});

test("persisted split position reads reject stale or foreign snapshots", async () => {
  const fixture = impulseLifecycleFixture();
  fixture.broker.readMarketMark = async () => {
    throw new Error("VST mark is not corroborated by a fresh quote");
  };
  const worker = createVstWorker({
    store: fixture.store, broker: fixture.broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  await worker.runOnce();
  const snapshot = fixture.store.data.positions[0].snapshot.persistedPosition;
  const options = { allowProcessCache: false };
  for (const mutate of [
    (value) => { value.accountId = "foreign-account"; },
    (value) => { value.positionId = "stale-position"; },
    (value) => { value.quantity = "1"; },
    (value) => { value.originalStop.orderId = "foreign-stop"; },
  ]) {
    const stale = structuredClone(snapshot);
    mutate(stale);
    await assert.rejects(
      fixture.broker.readPosition(fixture.signal.symbol, {
        ...options, persistedPosition: stale,
      }),
    );
  }
});

test("impulse 80/20 sizing rejects a tranche below exchange minimum before entry", async () => {
  const fixture = impulseLifecycleFixture();
  const readInputs = fixture.broker.readPlanningInputs;
  fixture.broker.readPlanningInputs = async (...args) => {
    const inputs = await readInputs(...args);
    return {
      ...inputs,
      filters: { ...inputs.filters, minQuantity: "25" },
    };
  };
  const result = await createVstWorker({
    store: fixture.store, broker: fixture.broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  }).runOnce();
  assert.equal(result.kind, "rejected");
  assert.equal(result.reason, "impulse_split_tranche_below_minimum_quantity");
  assert.equal(fixture.mutations.length, 0);
  assert.equal(fixture.store.data.intents.length, 0);
});

async function prepareRunnerAbortCleanup(fixture) {
  const worker = createVstWorker({
    store: fixture.store, broker: fixture.broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  const result = await worker.runOnce();
  assert.equal(result.kind, "acted", JSON.stringify(result));
  assert.equal(result.operation, "close_pre_runner_split");
  assert.equal(fixture.store.data.positions[0].snapshot.split.stage,
    "flat_cleanup_pending");
  return worker;
}

function setDegradedFlatCleanupCapabilities(broker, features = [
  "vst_only", "complete_order_lookup", "verified_position_state",
]) {
  broker.getCapabilities = async () => ({
    environment: "vst",
    verified: true,
    accountId: "vst-account",
    features,
  });
}

test("at-or-below-entry runner BE uses pre-runner full close and cleans both known stops", async () => {
  const fixture = impulseLifecycleFixture({ markPrice: 100 });
  const worker = createVstWorker({
    store: fixture.store, broker: fixture.broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  const result = await worker.runOnce();
  assert.equal(result.operation, "close_pre_runner_split");
  assert.equal(result.kind, "acted", JSON.stringify(result));
  let saved = fixture.store.data.positions[0].snapshot;
  assert.equal(saved.split.stage, "flat_cleanup_pending");
  assert.equal(saved.status, "closing");
  assert.deepEqual(saved.split.remainingKnownStopOrderIds,
    ["impulse-core-stop", "impulse-original-stop"]);
  assert.equal(fixture.mutations.includes("close_pre_runner_split"), true);
  assert.equal(fixture.mutations.includes("close_leg"), false);
  assert.equal(fixture.mutations.includes("split_runner_stop"), false);
  assert.equal(fixture.store.data.intents.some((intent) =>
    intent.request.operation === "split_runner_stop"), false);
  const abort = fixture.store.data.intents.find((intent) =>
    intent.request.operation === "close_pre_runner_split");
  assert.equal(abort.state, "reconciled");
  assert.equal(abort.request.totalQuantity, abort.request.priorPosition.split.totalQuantity);
  assert.equal(abort.request.originalStop.orderId, "impulse-original-stop");
  assert.equal(abort.request.originalStop.positionId, abort.request.positionId);
  assert.equal(abort.request.originalStop.quantity, abort.request.totalQuantity);
  assert.equal(abort.request.originalStop.stopPrice,
    abort.request.priorPosition.split.signalStopPrice);
  assert.equal(abort.request.coreStop.orderId, "impulse-core-stop");
  assert.equal(abort.request.coreStop.positionId, abort.request.positionId);
  assert.equal(abort.request.coreStop.quantity,
    abort.request.priorPosition.split.coreQuantity);
  assert.equal(abort.request.coreStop.stopPrice,
    abort.request.priorPosition.split.coreStop.stopPrice);
  assert.equal(abort.request.closeIntentId, abort.clientOrderId);
  assert.equal(Number.isSafeInteger(abort.request.intentCreatedAt), true);
  assert.equal(abort.request.intentCreatedAt, NOW);
  assert.equal(fixture.exchange.orders.length, 2);

  assert.equal((await worker.runOnce()).operation, "cancel_flat_split_stop");
  saved = fixture.store.data.positions[0].snapshot;
  assert.equal(saved.status, "closing");
  assert.equal(saved.split.stage, "flat_cleanup_pending");
  assert.equal(saved.split.remainingKnownStopOrderIds.length, 1);
  assert.equal(fixture.exchange.orders.length, 1);
  assert.equal((await worker.runOnce()).operation, "cancel_flat_split_stop");
  saved = fixture.store.data.positions[0].snapshot;
  assert.equal(saved.status, "closed");
  assert.equal(saved.split.stage, "closed");
  assert.deepEqual(saved.split.remainingKnownStopOrderIds, []);
  assert.equal(fixture.exchange.orders.length, 0);
  assert.equal(fixture.mutations.filter((operation) =>
    operation === "cancel_flat_split_stop").length, 2);
});

test("degraded verified read capabilities permit only flat split stop cleanup", async () => {
  const fixture = impulseLifecycleFixture({ markPrice: 100 });
  const worker = await prepareRunnerAbortCleanup(fixture);
  setDegradedFlatCleanupCapabilities(fixture.broker);

  const beforeCleanup = fixture.mutations.length;
  assert.equal((await worker.runOnce()).operation, "cancel_flat_split_stop");
  assert.deepEqual(fixture.mutations.slice(beforeCleanup), ["cancel_flat_split_stop"]);
  assert.equal(fixture.store.data.positions[0].snapshot.split.remainingKnownStopOrderIds.length, 1);
  assert.equal((await worker.runOnce()).operation, "cancel_flat_split_stop");
  assert.equal(fixture.store.data.positions[0].snapshot.status, "closed");
  assert.equal(fixture.exchange.orders.length, 0);
  assert.equal(fixture.mutations.filter((operation) =>
    operation === "cancel_flat_split_stop").length, 2);

  let planningReads = 0;
  const readPlanningInputs = fixture.broker.readPlanningInputs;
  fixture.broker.readPlanningInputs = async (...args) => {
    planningReads += 1;
    return readPlanningInputs(...args);
  };
  const newSignal = {
    ...fixture.signal,
    sourceSignalId: "canary-new-entry-must-wait",
    signalAt: new Date(NOW).toISOString(),
  };
  fixture.store.data.pending = {
    sourceSignalId: newSignal.sourceSignalId, body: newSignal, status: "pending",
  };
  fixture.store.data.status = "pending";
  const beforeNewSignal = fixture.mutations.length;
  const blocked = await worker.runOnce();
  assert.equal(blocked.kind, "waiting");
  assert.equal(planningReads, 0);
  assert.equal(fixture.mutations.length, beforeNewSignal);
});

test("flat split cleanup refuses foreign orders and missing read trust", async () => {
  const foreignFixture = impulseLifecycleFixture({ markPrice: 100 });
  const foreignWorker = await prepareRunnerAbortCleanup(foreignFixture);
  setDegradedFlatCleanupCapabilities(foreignFixture.broker);
  foreignFixture.exchange.orders.push(foreignFixture.makeOpenStop(
    "foreign-flat-cleanup-stop",
    foreignFixture.store.data.positions[0].snapshot.exchangePositionId,
    "0.001",
    "80",
    foreignFixture.store.data.positions[0].snapshot.entryOrderId,
  ));
  const foreignWrites = foreignFixture.mutations.length;
  const foreign = await foreignWorker.runOnce();
  assert.equal(foreign.kind, "waiting");
  assert.equal(foreignFixture.mutations.length, foreignWrites);

  const untrustedFixture = impulseLifecycleFixture({ markPrice: 100 });
  const untrustedWorker = await prepareRunnerAbortCleanup(untrustedFixture);
  setDegradedFlatCleanupCapabilities(untrustedFixture.broker, [
    "vst_only", "verified_position_state",
  ]);
  const untrustedWrites = untrustedFixture.mutations.length;
  const untrusted = await untrustedWorker.runOnce();
  assert.equal(untrusted.kind, "waiting");
  assert.equal(untrustedFixture.mutations.length, untrustedWrites);
  assert.equal(untrustedFixture.store.data.positions[0].snapshot.split.stage,
    "flat_cleanup_pending");

  const unresolvedFixture = impulseLifecycleFixture({ markPrice: 100 });
  const unresolvedWorker = await prepareRunnerAbortCleanup(unresolvedFixture);
  setDegradedFlatCleanupCapabilities(unresolvedFixture.broker);
  unresolvedFixture.store.data.intents.push({
    sourceSignalId: "unrelated-pending-triggered-stop",
    phase: "unresolved-trigger-observation",
    clientOrderId: "vst-unresolved-trigger-observation",
    state: "unknown",
    request: {
      operation: "observe_triggered_stop",
      environment: "vst",
      accountId: "vst-account",
    },
  });
  const unresolvedWrites = unresolvedFixture.mutations.length;
  const unresolved = await unresolvedWorker.runOnce();
  assert.equal(unresolved.kind, "blocked");
  assert.equal(unresolvedFixture.mutations.length, unresolvedWrites);
});

test("ambiguous pre-runner close reconciles after restart without reposting", async () => {
  const fixture = impulseLifecycleFixture({
    markPrice: 100,
    ambiguousOperation: "close_pre_runner_split",
  });
  const makeWorker = () => createVstWorker({
    store: fixture.store, broker: fixture.broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  let worker = makeWorker();
  await worker.runOnce();
  const result = await worker.runOnce();
  assert.equal(result.kind, "unknown");
  assert.equal(fixture.exchange.position.quantity, 0);
  const intent = fixture.store.data.intents.find((row) =>
    row.request.operation === "close_pre_runner_split");
  assert.equal(intent.state, "unknown");
  const createdAt = intent.request.intentCreatedAt;

  worker = makeWorker();
  const recovered = await worker.runOnce();
  assert.ok(["waiting", "idle"].includes(recovered.kind), JSON.stringify(recovered));
  assert.equal(intent.state, "reconciled");
  assert.equal(intent.request.intentCreatedAt, createdAt);
  assert.equal(fixture.mutations.filter((operation) =>
    operation === "close_pre_runner_split").length, 1);
  assert.equal(fixture.store.data.positions[0].snapshot.split.stage,
    "flat_cleanup_pending");
  assert.equal(fixture.store.data.positions[0].snapshot.split.remainingKnownStopOrderIds.length, 2);

  assert.equal((await worker.runOnce()).operation, "cancel_flat_split_stop");
  const cleaned = await worker.runOnce();
  assert.equal(cleaned.operation, "cancel_flat_split_stop");
  assert.equal(fixture.store.data.positions[0].snapshot.status, "closed");
  assert.equal(fixture.exchange.orders.length, 0);
  assert.equal(fixture.mutations.filter((operation) =>
    operation === "close_pre_runner_split").length, 1);
});

test("owner review passes a multi-fill closed proof through to atomic persistence without replaying MARKET", async () => {
  const fixture = impulseLifecycleFixture({ markPrice: 100 });
  const perform = fixture.broker.performIntent;
  fixture.broker.performIntent = async (intent) => {
    if (intent.request.operation === "close_pre_runner_split") {
      throw new Error("legacy close outcome unknown");
    }
    return perform(intent);
  };
  const reconcile = fixture.broker.reconcileIntent;
  fixture.broker.reconcileIntent = async (intent) =>
    intent.request.operation === "close_pre_runner_split"
      ? { verified: false, status: "unknown" } : reconcile(intent);
  await createVstWorker({
    store: fixture.store, broker: fixture.broker, clock: () => NOW,
    policyProvider: async () => activePolicy({ patternId: "impulse_buy", stopLoss: "90" }),
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  }).runOnce();
  const worker = createVstWorker({
    store: fixture.store, broker: fixture.broker, clock: () => NOW + 2_000,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  assert.equal((await worker.runOnce()).kind, "unknown");
  const row = fixture.store.data.intents.find((intent) =>
    intent.request.operation === "close_pre_runner_split");
  assert.ok(row);
  fixture.store.getIntentByClientOrderId = async (clientOrderId) => {
    const found = fixture.store.data.intents.find((intent) => intent.clientOrderId === clientOrderId);
    return found ? { ...found, outcome: found.detail?.outcome } : null;
  };
  fixture.exchange.position.quantity = 0;
  fixture.exchange.orders = [];
  let saved;
  fixture.store.resolveLegacyPreRunnerCloseReview = async (args) => {
    saved = args;
    return { kind: "resolved", position: args.position };
  };
  const beforeMutations = [...fixture.mutations];
  fixture.broker.supportsHistoricalCloseProof = true;
  fixture.broker.readHistoricalErrorClose = async (candidate) => ({
    verified: true, lifecycleVersion: 2, environment: "vst",
    accountId: candidate.snapshot.accountId, sourceSignalId: candidate.sourceSignalId,
    symbol: candidate.symbol, positionId: candidate.snapshot.exchangePositionId,
    observedAt: new Date(NOW + 2_000).toISOString(),
    flatCheck: { verified: true, positionQuantity: "0", openOrderCount: 0 },
    fills: Array.from({ length: 6 }, (_, index) => ({ tradeId: String(index) })),
    entryFills: [{ exchangeFillId: "0" }, { exchangeFillId: "1" }],
    closeFills: [2, 3, 4, 5].map((index) => ({ exchangeFillId: String(index) })),
  });
  const reviewed = await worker.resolveLegacyPreRunnerClose(row.sourceSignalId, {
    clientOrderId: row.clientOrderId, confirmation: true, resolvedBy: "owner-1", note: null,
  });
  assert.equal(reviewed.kind, "resolved");
  assert.equal(saved.review.outcome, "closed");
  assert.equal(saved.review.evidence.lifecycleVersion, 2);
  assert.equal(saved.review.evidence.fills.length, 6);
  assert.equal(saved.position.status, "closed");
  assert.equal(saved.position.remainingQty, 0);
  assert.deepEqual(fixture.mutations, beforeMutations);
});

test("owner review resolves a legacy pre-runner close using fresh open-and-stops proof without POST", async () => {
  const fixture = impulseLifecycleFixture({ markPrice: 100 });
  const originalPerformIntent = fixture.broker.performIntent;
  const originalReconcileIntent = fixture.broker.reconcileIntent;
  let closeClientOrderId;
  fixture.broker.performIntent = async (intent) => {
    if (intent.request.operation === "close_pre_runner_split") {
      closeClientOrderId = intent.clientOrderId;
      const error = new Error("legacy pre-runner close request outcome unknown");
      error.mutationProvenance = {
        operation: "close_pre_runner_split",
        boundary: "before_transport",
        noMutationSubmitted: true,
      };
      throw error;
    }
    return originalPerformIntent(intent);
  };
  fixture.broker.reconcileIntent = async (intent) =>
    intent.clientOrderId === closeClientOrderId
      ? { verified: false, status: "unknown" }
      : originalReconcileIntent(intent);
  await createVstWorker({
    store: fixture.store, broker: fixture.broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  }).runOnce();
  const worker = createVstWorker({
    store: fixture.store, broker: fixture.broker, clock: () => NOW + 1_000,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  assert.equal((await worker.runOnce()).kind, "unknown");
  const row = fixture.store.data.intents.find((intent) =>
    intent.clientOrderId === closeClientOrderId);
  assert.ok(row);
  fixture.store.getIntentByClientOrderId = async (clientOrderId) => {
    const found = fixture.store.data.intents.find((intent) =>
      intent.clientOrderId === clientOrderId);
    return found ? {
      ...found,
      outcome: found.outcome ?? found.detail?.outcome,
    } : null;
  };
  // This represents the old unknown shape that is not eligible for the
  // autonomous no-write recovery guard.
  delete row.detail.outcome.mutationProvenance;
  const originalOutcome = structuredClone(row.detail.outcome);
  let resolveCalls = 0;
  fixture.store.resolveLegacyPreRunnerCloseReview = async (args) => {
    if (row.detail.outcome.ownerPreRunnerCloseReview) {
      return {
        kind: "replayed",
        position: fixture.store.data.positions[0].snapshot,
        review: row.detail.outcome.ownerPreRunnerCloseReview,
      };
    }
    resolveCalls += 1;
    row.state = "failed";
    row.detail.outcome = {
      ...row.detail.outcome,
      ownerPreRunnerCloseReview: {
        ...args.review,
        originalOutcome: row.detail.outcome,
      },
    };
    fixture.store.data.positions[0].snapshot = args.position;
    fixture.store.data.positions[0].status = "closing";
    return { kind: "resolved", position: args.position };
  };
  const beforeMutations = [...fixture.mutations];
  const reviewed = await worker.resolveLegacyPreRunnerClose(
    row.sourceSignalId,
    {
      clientOrderId: closeClientOrderId,
      confirmation: true,
      resolvedBy: "owner-1",
      note: "verified existing position and both stops",
    },
  );
  assert.equal(reviewed.kind, "resolved");
  assert.equal(reviewed.review.outcome, "open");
  assert.equal(reviewed.review.evidence.verified, true);
  assert.equal(reviewed.review.evidence.stops.length, 2);
  assert.equal(row.state, "failed");
  assert.deepEqual(row.detail.outcome.ownerPreRunnerCloseReview.originalOutcome,
    originalOutcome);
  assert.equal(fixture.store.data.positions[0].snapshot.status, "closing");
  assert.equal(fixture.store.data.positions[0].snapshot.split.stage,
    "runner_pending");
  assert.deepEqual(fixture.mutations, beforeMutations);

  let accountReads = 0;
  const originalReadAccountState = fixture.broker.readAccountState;
  fixture.broker.readAccountState = async (...args) => {
    accountReads += 1;
    return originalReadAccountState(...args);
  };
  const restartWorker = createVstWorker({
    store: fixture.store, broker: fixture.broker, clock: () => NOW + 2_000,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  const replay = await restartWorker.resolveLegacyPreRunnerClose(
    row.sourceSignalId,
    {
      clientOrderId: closeClientOrderId,
      confirmation: true,
      resolvedBy: "owner-1",
      note: "replay",
    },
  );
  assert.equal(replay.kind, "replayed");
  assert.equal(resolveCalls, 1);
  assert.equal(accountReads, 0);
  assert.deepEqual(fixture.mutations, beforeMutations);
});

test("sent pre-runner close provenance survives submission failure, restart and repeated reconciliation", async () => {
  const fixture = impulseLifecycleFixture({ markPrice: 100 });
  const perform = fixture.broker.performIntent;
  const reconcile = fixture.broker.reconcileIntent;
  const sent = {
    operation: "close_pre_runner_split",
    boundary: "after_transport_started",
    mutationSubmitted: true,
  };
  let closeCalls = 0;
  fixture.broker.performIntent = async (intent) => {
    if (intent.request.operation !== "close_pre_runner_split") return perform(intent);
    closeCalls += 1;
    const error = new Error("close_acknowledgement_read_failed_after_transport");
    error.mutationProvenance = sent;
    throw error;
  };
  fixture.broker.reconcileIntent = async (intent) =>
    intent.request.operation === "close_pre_runner_split"
      ? { verified: false, status: "unknown" }
      : reconcile(intent);
  const workerAt = (now) => createVstWorker({
    store: fixture.store, broker: fixture.broker, clock: () => now,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  const initialWorker = workerAt(NOW);
  await initialWorker.runOnce();
  await initialWorker.runOnce();
  const intent = fixture.store.data.intents.find((row) =>
    row.request.operation === "close_pre_runner_split");
  assert.ok(intent);
  assert.equal(intent.state, "unknown");
  assert.deepEqual(intent.detail.outcome.mutationProvenance, sent);
  for (const elapsed of [1_000, 20 * 60_000]) {
    await workerAt(NOW + elapsed).runOnce();
    assert.equal(intent.state, "unknown");
    assert.deepEqual(intent.detail.outcome.mutationProvenance, sent);
  }
  assert.equal(closeCalls, 1, "sent provenance must never become no-write retry permission");
});

test("a proven-still-open pre-runner split close gets a fresh retry that completes, after recovery", async () => {
  const fixture = impulseLifecycleFixture({ markPrice: 100 });
  const originalPerformIntent = fixture.broker.performIntent;
  const originalReconcileIntent = fixture.broker.reconcileIntent;
  let firstCloseClientOrderId = null;
  // Simulate a close_pre_runner_split attempt that never reached the
  // exchange at all (lost in transit, not merely unconfirmed): the very
  // first such submission throws before any exchange mutation, and every
  // reconciliation query against that specific attempt comes back unusable,
  // exactly like a real broker that has no record of it.
  fixture.broker.performIntent = async (intent) => {
    if (intent.request.operation === "close_pre_runner_split" &&
        firstCloseClientOrderId === null) {
      firstCloseClientOrderId = intent.clientOrderId;
      const error = new Error("simulated_close_pre_runner_split_lost_in_transit");
      error.mutationProvenance = {
        operation: "close_pre_runner_split",
        boundary: "before_transport",
        noMutationSubmitted: true,
      };
      throw error;
    }
    return originalPerformIntent(intent);
  };
  fixture.broker.reconcileIntent = async (intent) => {
    if (intent.request.operation === "close_pre_runner_split" &&
        intent.clientOrderId === firstCloseClientOrderId) {
      return { verified: false, status: "unknown" };
    }
    return originalReconcileIntent(intent);
  };
  const makeWorker = (clock) => createVstWorker({
    store: fixture.store, broker: fixture.broker, clock,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });

  let worker = makeWorker(() => NOW);
  await worker.runOnce();
  const firstAttempt = await worker.runOnce();
  assert.equal(firstAttempt.kind, "unknown", JSON.stringify(firstAttempt));
  assert.ok(firstCloseClientOrderId);
  const totalQuantity = fixture.store.data.positions[0].snapshot.split.totalQuantity;
  assert.equal(fixture.exchange.position.quantity, Number(totalQuantity));
  assert.equal(fixture.exchange.orders.length, 2);
  const firstIntent = fixture.store.data.intents.find((row) =>
    row.clientOrderId === firstCloseClientOrderId);
  assert.equal(firstIntent.state, "unknown");

  // The strict pre-transport proof resolves immediately after fresh reads,
  // with no 10-minute ambiguous-close timeout and no exchange write.
  worker = makeWorker(() => NOW + 1_000);
  const recovered = await worker.runOnce();
  assert.deepEqual(recovered, {
    kind: "acted",
    operation: "recover_pretransport_pre_runner_split_close",
  });
  const abandoned = fixture.store.data.intents.find((row) =>
    row.clientOrderId === firstCloseClientOrderId);
  assert.equal(abandoned.state, "failed");
  assert.equal(abandoned.detail.outcome.reason,
    "close_pre_runner_split_pre_transport_refusal_confirmed_still_open");
  assert.equal(fixture.store.data.status, "error");
  // The position itself must be untouched by the abandonment: still exactly
  // where normal per-tick management left it, free to be retried.
  const untouched = fixture.store.data.positions[0].snapshot;
  assert.equal(untouched.split.stage, "runner_pending");
  assert.equal(untouched.split.totalQuantity, totalQuantity);
  assert.equal(fixture.exchange.position.quantity, Number(totalQuantity));
  assert.equal(fixture.exchange.orders.length, 2);
  assert.equal(untouched.status, "closing");
  assert.equal(fixture.mutations.filter((operation) =>
    operation === "close_pre_runner_split").length, 0);

  // A fresh, recent mark -- exactly what a real later tick would observe --
  // still shows price at-or-below breakeven, so normal management should
  // decide to retry the very same logical close. With a fresh idempotency
  // key (this task's fix) it can now actually reach the exchange.
  const symbol = untouched.symbol;
  const retryNow = NOW + 2_000;
  fixture.broker.readMarketMark = async () => ({
    verified: true,
    symbol,
    price: 100,
    observedAt: new Date(retryNow - 500).toISOString(),
  });
  worker = makeWorker(() => retryNow);
  const retried = await worker.runOnce();
  assert.equal(retried.kind, "acted", JSON.stringify(retried));
  assert.equal(retried.operation, "close_pre_runner_split");
  const secondIntent = fixture.store.data.intents.find((row) =>
    row.request.operation === "close_pre_runner_split" &&
    row.clientOrderId !== firstCloseClientOrderId);
  assert.ok(secondIntent, "expected a fresh close_pre_runner_split intent with its own clientOrderId");
  assert.equal(secondIntent.state, "reconciled");
  assert.equal(fixture.store.data.positions[0].snapshot.split.stage,
    "flat_cleanup_pending");
  assert.equal(fixture.store.data.positions[0].snapshot.status, "closing");
  assert.equal(fixture.exchange.position.quantity, 0);
  // The old, abandoned intent must remain exactly as abandonment left it.
  assert.equal(fixture.store.data.intents.find((row) =>
    row.clientOrderId === firstCloseClientOrderId).state, "failed");
});

test("pre-runner close recovery rejects error-string-only and changed-stop no-write claims", async () => {
  for (const mode of ["missing_provenance", "changed_stop"]) {
    const fixture = impulseLifecycleFixture({ markPrice: 100 });
    const originalPerformIntent = fixture.broker.performIntent;
    const originalReconcileIntent = fixture.broker.reconcileIntent;
    let closeClientOrderId = null;
    fixture.broker.performIntent = async (intent) => {
      if (intent.request.operation === "close_pre_runner_split") {
        closeClientOrderId = intent.clientOrderId;
        const error = new Error(
          "VST close_pre_runner_split was refused before transport",
        );
        if (mode === "changed_stop") {
          error.mutationProvenance = {
            operation: "close_pre_runner_split",
            boundary: "before_transport",
            noMutationSubmitted: true,
          };
        }
        throw error;
      }
      return originalPerformIntent(intent);
    };
    fixture.broker.reconcileIntent = async (intent) =>
      intent.clientOrderId === closeClientOrderId
        ? { verified: false, status: "unknown" }
        : originalReconcileIntent(intent);
    const makeWorker = (clock) => createVstWorker({
      store: fixture.store, broker: fixture.broker, clock,
      sizingLimits: {
        environment: "vst", maxQuoteAgeMs: 10_000,
        maxPriceMoveBps: 500, maxSlippageBps: 100,
      },
    });

    await makeWorker(() => NOW).runOnce();
    const firstAttempt = await makeWorker(() => NOW).runOnce();
    assert.equal(firstAttempt.kind, "unknown");
    assert.ok(closeClientOrderId);
    if (mode === "changed_stop") {
      fixture.exchange.orders.find((order) =>
        order.orderId === "impulse-core-stop").stopPrice = "94";
    }

    const next = await makeWorker(() => NOW + 1_000).runOnce();
    assert.equal(next.kind, "blocked", JSON.stringify(next));
    const intent = fixture.store.data.intents.find((row) =>
      row.clientOrderId === closeClientOrderId);
    assert.equal(intent.state, "unknown");
    assert.equal(
      intent.detail.outcome.reason,
      "exchange_state_not_verified",
    );
    assert.equal(fixture.store.data.positions[0].snapshot.status, "closing");
    assert.equal(fixture.mutations.filter((operation) =>
      operation === "close_pre_runner_split").length, 0);

    const oldIntentTick = await makeWorker(() => NOW + 11 * 60_000).runOnce();
    assert.notEqual(oldIntentTick.kind, "acted",
      "generic close-abandon age must never retire an unsafe pre-runner close");
    assert.equal(intent.state, "unknown");
    assert.equal(fixture.mutations.filter((operation) =>
      operation === "close_pre_runner_split").length, 0);

    // A restarted worker whose exact execution read is unavailable must keep
    // the pre-fix ambiguous intent unresolved, regardless of its age.
    fixture.broker.reconcileIntent = async () => {
      throw new Error("simulated_close_execution_read_timeout");
    };
    const restartWithReadOutage = await makeWorker(() => NOW + 24 * 60 * 60_000)
      .runOnce();
    assert.notEqual(restartWithReadOutage.kind, "acted");
    assert.equal(intent.state, "unknown");
    assert.equal(fixture.mutations.filter((operation) =>
      operation === "close_pre_runner_split").length, 0);
  }
});

test("foreign order after pre-runner close stays unknown without another close POST", async () => {
  const fixture = impulseLifecycleFixture({
    markPrice: 100,
    foreignOrderAfterPreRunnerClose: true,
  });
  const makeWorker = () => createVstWorker({
    store: fixture.store, broker: fixture.broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  const worker = makeWorker();
  await worker.runOnce();
  const result = await worker.runOnce();
  assert.equal(result.kind, "unknown");
  const intent = fixture.store.data.intents.find((row) =>
    row.request.operation === "close_pre_runner_split");
  assert.equal(intent.state, "unknown");
  assert.equal(fixture.store.data.positions[0].snapshot.status, "unknown");
  assert.equal(fixture.mutations.filter((operation) =>
    operation === "close_pre_runner_split").length, 1);
  assert.equal(fixture.mutations.includes("cancel_flat_split_stop"), false);

  const retry = await makeWorker().runOnce();
  assert.notEqual(retry.kind, "acted");
  assert.equal(fixture.mutations.filter((operation) =>
    operation === "close_pre_runner_split").length, 1);
  assert.equal(fixture.mutations.includes("close_leg"), false);
});

test("split exits do not submit when their required stop identities fail preflight", async () => {
  const abortFixture = impulseLifecycleFixture({ markPrice: 100 });
  abortFixture.broker.readMarketMark = async () => {
    throw new Error("VST mark is not corroborated by a fresh quote");
  };
  const abortWorker = createVstWorker({
    store: abortFixture.store, broker: abortFixture.broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await abortWorker.runOnce();
  await abortWorker.runOnce();
  assert.equal(abortFixture.exchange.orders.length, 2, JSON.stringify({
    mutations: abortFixture.mutations,
    state: abortFixture.store.data.positions[0]?.snapshot?.split,
  }));
  abortFixture.exchange.orders[0].stopPrice = "96";
  const abort = await abortWorker.runOnce();
  assert.equal(abort.kind, "unknown");
  assert.equal(abortFixture.store.data.positions[0].status, "unknown");
  assert.equal(abortFixture.mutations.includes("close_leg"), false);
  assert.equal(abortFixture.mutations.includes("close_pre_runner_split"), false);
  assert.equal(abortFixture.store.data.intents.some((intent) =>
    intent.request.fullSplitAbort === true), false);
  assert.equal(abortFixture.exchange.orders.length, 2);

  const expiryFixture = impulseLifecycleFixture();
  const expiryWorker = createVstWorker({
    store: expiryFixture.store, broker: expiryFixture.broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  for (let tick = 0; tick < 5; tick += 1) await expiryWorker.runOnce();
  expiryFixture.store.data.positions[0].snapshot.entryAt =
    new Date(NOW - 120 * 60 * 60 * 1000).toISOString();
  expiryFixture.setMarkPrice(105);
  expiryFixture.exchange.orders.find((order) =>
    order.orderId === "impulse-runner-stop").stopPrice = "101";
  const expiry = await expiryWorker.runOnce();
  assert.equal(expiry.kind, "unknown");
  assert.equal(expiryFixture.store.data.positions[0].status, "unknown");
  assert.equal(expiryFixture.mutations.includes("close_leg"), false);
  assert.equal(expiryFixture.mutations.includes("close_split_all"), false);
  assert.equal(expiryFixture.store.data.intents.some((intent) =>
    intent.request.operation === "close_leg"), false);
});

test("impulse stop upgrades persist the new stop before a separate old-stop cancellation", async () => {
  const fixture = impulseLifecycleFixture();
  const worker = createVstWorker({
    store: fixture.store, broker: fixture.broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  await worker.runOnce();
  const placed = await worker.runOnce();
  assert.equal(placed.operation, "split_raise_stop_place");
  let saved = fixture.store.data.positions[0].snapshot;
  assert.equal(saved.split.upgradePending.stage, "cancel_old_pending");
  assert.equal(saved.split.upgradePending.newStop.orderId, "impulse-core-upgrade-stop");
  assert.equal(saved.persistedPosition, null,
    "same-tranche overlapping upgrade orders are not representable in the snapshot schema");
  assert.equal(fixture.exchange.orders.length, 3);
  assert.equal(fixture.exchange.orders.some((order) =>
    order.orderId === saved.split.upgradePending.oldStop.orderId), true);
  assert.equal(fixture.readPositionCalls.some((call) =>
    call.allowProcessCache === false && call.persistedPosition === undefined), false);

  const canceled = await worker.runOnce();
  assert.equal(canceled.operation, "split_raise_stop_cancel", JSON.stringify(canceled));
  saved = fixture.store.data.positions[0].snapshot;
  assert.equal(saved.split.upgradePending, undefined);
  assert.equal(saved.split.coreStop.orderId, "impulse-core-upgrade-stop");
  assert.equal(saved.persistedPosition.protectiveStops.core.orderId,
    "impulse-core-upgrade-stop");
  assert.equal(saved.persistedPosition.protectiveStops.runner.orderId,
    saved.split.runnerStop.orderId);
  assert.equal(fixture.readPositionCalls.some((call) =>
    call.allowProcessCache === false && call.persistedPosition === undefined), true,
  "the three-order overlap cannot be represented without mislabeling a tranche");
  assert.equal(fixture.exchange.orders.length, 2);
  assert.equal(fixture.exchange.orders.some((order) =>
    order.orderId === "impulse-core-stop"), false);
  assert.equal(fixture.store.data.intents.some((intent) =>
    intent.request.operation === "split_raise_stop_place"), true);
  assert.equal(fixture.store.data.intents.some((intent) =>
    intent.request.operation === "split_raise_stop_cancel"), true);
});

test("ambiguous split-stop upgrade writes reconcile after restart without re-posting", async () => {
  let corruptPlaceEvidence = true;
  const fixture = impulseLifecycleFixture({
    mutateEvidence(request, evidence) {
      if (request.operation === "split_raise_stop_place" && corruptPlaceEvidence) {
        corruptPlaceEvidence = false;
        return {
          ...evidence,
          newStop: { ...evidence.newStop, quantity: "0" },
        };
      }
      return evidence;
    },
  });
  const makeWorker = () => createVstWorker({
    store: fixture.store, broker: fixture.broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  let worker = makeWorker();
  for (let tick = 0; tick < 4; tick += 1) await worker.runOnce();
  const ambiguousPlace = await worker.runOnce();
  assert.equal(ambiguousPlace.kind, "idle", JSON.stringify(ambiguousPlace));
  assert.equal(fixture.mutations.filter((operation) =>
    operation === "split_raise_stop_place").length, 1);
  assert.equal(fixture.store.data.positions[0].snapshot.split.upgradePending, undefined);

  worker = makeWorker();
  await worker.runOnce();
  assert.equal(fixture.mutations.filter((operation) =>
    operation === "split_raise_stop_place").length, 1);
  assert.equal(fixture.mutations.filter((operation) =>
    operation === "split_raise_stop_cancel").length, 1);
  assert.equal(fixture.store.data.positions[0].snapshot.split.upgradePending, undefined);
  assert.equal(fixture.store.data.positions[0].snapshot.split.coreStop.orderId,
    "impulse-core-upgrade-stop");

  let corruptCancelEvidence = true;
  const cancelFixture = impulseLifecycleFixture({
    mutateEvidence(request, evidence) {
      if (request.operation === "split_raise_stop_cancel" && corruptCancelEvidence) {
        corruptCancelEvidence = false;
        return { ...evidence, canceledStopOrderId: "ambiguous-old-stop" };
      }
      return evidence;
    },
  });
  const makeCancelWorker = () => createVstWorker({
    store: cancelFixture.store, broker: cancelFixture.broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  worker = makeCancelWorker();
  for (let tick = 0; tick < 5; tick += 1) await worker.runOnce();
  await worker.runOnce();
  assert.equal((await worker.runOnce()).kind, "idle");
  assert.equal(cancelFixture.mutations.filter((operation) =>
    operation === "split_raise_stop_cancel").length, 1);
  worker = makeCancelWorker();
  await worker.runOnce();
  assert.equal(cancelFixture.mutations.filter((operation) =>
    operation === "split_raise_stop_cancel").length, 1);
  assert.equal(cancelFixture.store.data.positions[0].snapshot.split.upgradePending, undefined);
  assert.equal(cancelFixture.store.data.positions[0].snapshot.split.coreStop.orderId,
    "impulse-core-upgrade-stop");
});

test("impulse partial close remains pending until stale tranche stop cleanup is proven", async () => {
  const fixture = impulseLifecycleFixture();
  let worker = createVstWorker({
    store: fixture.store, broker: fixture.broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  await worker.runOnce();
  await worker.runOnce();
  await worker.runOnce();
  fixture.setMarkPrice(90);
  assert.equal((await worker.runOnce()).operation, "close_leg");
  let saved = fixture.store.data.positions[0].snapshot;
  assert.equal(saved.status, "closing");
  assert.equal(saved.split.stage, "cleanup_pending");
  assert.equal(saved.pendingClose.closedLeg, "core");
  assert.equal(saved.pendingClose.remainingQuantity, saved.split.runnerQuantity);
  assert.equal(Number(saved.persistedPosition.quantity),
    Number(saved.pendingClose.remainingQuantity));
  assert.equal(saved.persistedPosition.protectiveStops.core.orderId,
    saved.split.coreStop.orderId);
  assert.equal(saved.persistedPosition.protectiveStops.runner.orderId,
    saved.split.runnerStop.orderId);
  assert.equal(fixture.exchange.orders.length, 2);

  worker = createVstWorker({
    store: fixture.store, broker: fixture.broker, clock: () => NOW,
    sizingLimits: { environment: "vst" },
  });
  assert.equal((await worker.runOnce()).operation, "cancel_split_stop");
  saved = fixture.store.data.positions[0].snapshot;
  assert.equal(saved.status, "open");
  assert.equal(saved.split.stage, "complete");
  assert.deepEqual(saved.split.activeLegs, ["runner"]);
  assert.equal(saved.coreOpen, false);
  assert.equal(saved.runnerOpen, true);
  assert.equal(saved.runnerQty, Number(saved.split.runnerQuantity));
  assert.equal(Number(saved.persistedPosition.quantity), Number(saved.runnerQty));
  assert.equal(saved.persistedPosition.protectiveStops.runner.orderId,
    saved.split.runnerStop.orderId);
  assert.equal(saved.persistedPosition.protectiveStops.core, undefined);
  assert.deepEqual(fixture.exchange.orders.map((row) => row.orderId),
    ["impulse-runner-stop"]);
  assert.deepEqual(fixture.mutations.slice(-2), ["close_leg", "cancel_split_stop"]);
});

test("impulse survivor cleanup with incorrect stop facts remains fail-closed", async () => {
  const fixture = impulseLifecycleFixture({
    mutateEvidence: (request, evidence) => {
      if (request.operation === "cancel_split_stop") {
        evidence.protectiveStops.runner.quantity += 0.001;
      }
      return evidence;
    },
  });
  let worker = createVstWorker({
    store: fixture.store, broker: fixture.broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  await worker.runOnce();
  await worker.runOnce();
  await worker.runOnce();
  fixture.setMarkPrice(90);
  await worker.runOnce();
  assert.equal(fixture.store.data.positions[0].snapshot.split.stage, "cleanup_pending");
  assert.equal((await worker.runOnce()).kind, "unknown");
  worker = createVstWorker({
    store: fixture.store, broker: fixture.broker, clock: () => NOW,
    sizingLimits: { environment: "vst" },
  });
  assert.equal((await worker.runOnce()).kind, "blocked");
  assert.equal(fixture.store.data.positions[0].snapshot.status, "closing");
  assert.equal(fixture.store.data.positions[0].snapshot.split.stage, "cleanup_pending");
  assert.equal(fixture.mutations.filter((operation) =>
    operation === "cancel_split_stop").length, 1);
});

test("natural impulse runner stop without exact core survivor proof stays unknown", async () => {
  const fixture = impulseLifecycleFixture();
  const worker = createVstWorker({
    store: fixture.store, broker: fixture.broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  await worker.runOnce();
  await worker.runOnce();
  await worker.runOnce();
  const snapshot = fixture.store.data.positions[0].snapshot;
  fixture.exchange.position.quantity = Number(snapshot.split.coreQuantity);
  delete fixture.exchange.position.protectiveStops.runner;
  fixture.exchange.orders = fixture.exchange.orders.filter((row) =>
    row.orderId !== snapshot.split.runnerStop.orderId);
  fixture.broker.observeTriggeredStop = async (request) => ({
    verified: true,
    status: "filled",
    parentStopId: request.stopOrderId,
    parentStopPrice: request.stopPrice,
    childOrderId: "impulse-runner-trigger-fill",
    fill: {
      orderId: "impulse-runner-trigger-fill",
      triggerOrderId: request.stopOrderId,
      quantity: String(request.stopQuantity),
      price: "100",
      at: new Date(NOW + 1_000).toISOString(),
      fee: { asset: "USDT", amount: "0.01" },
    },
    residualPosition: {
      verified: true,
      positionId: request.positionId,
      quantity: snapshot.split.coreQuantity,
    },
    openStops: [],
  });
  assert.equal((await worker.runOnce()).kind, "unknown");
  assert.equal(fixture.store.data.positions[0].status, "unknown");
  assert.equal(fixture.store.data.positions[0].snapshot.runnerOpen, true);
  assert.equal(fixture.store.data.positions[0].snapshot.remainingQty,
    Number(snapshot.split.totalQuantity));
});

test("runner child fill durably stages two exact residual stops before original cancellation", async () => {
  const fixture = impulseLifecycleFixture();
  const worker = createVstWorker({
    store: fixture.store, broker: fixture.broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  for (let tick = 0; tick < 5; tick += 1) await worker.runOnce();
  const snapshot = fixture.store.data.positions[0].snapshot;
  const residual = String(snapshot.split.coreQuantity);
  const originalId = snapshot.split.originalStopOrderId;
  const coreId = snapshot.split.coreStop.orderId;
  fixture.exchange.position.quantity = Number(residual);
  delete fixture.exchange.position.protectiveStops.runner;
  fixture.exchange.orders = [
    fixture.makeOpenStop(
      originalId, snapshot.exchangePositionId, residual, snapshot.stopPrice,
      snapshot.entryOrderId,
    ),
    fixture.makeOpenStop(
      coreId, snapshot.exchangePositionId, residual, snapshot.stopPrice,
      snapshot.entryOrderId,
    ),
  ];
  fixture.broker.observeTriggeredStop = async (request) => ({
    verified: true,
    status: "filled",
    parentStopId: request.stopOrderId,
    parentStopPrice: request.stopPrice,
    childOrderId: "impulse-runner-trigger-fill",
    fill: {
      orderId: "impulse-runner-trigger-fill",
      triggerOrderId: request.stopOrderId,
      quantity: String(request.stopQuantity),
      price: "100",
      at: new Date(NOW + 1_000).toISOString(),
      fee: { asset: "USDT", amount: "0.01" },
    },
    residualPosition: {
      verified: true,
      positionId: request.positionId,
      quantity: residual,
    },
    openStops: [
      {
        orderId: originalId, positionId: request.positionId,
        quantity: residual, stopPrice: String(snapshot.stopPrice),
      },
      {
        orderId: coreId, positionId: request.positionId,
        quantity: residual, stopPrice: String(snapshot.stopPrice),
      },
    ],
  });

  assert.equal((await worker.runOnce()).operation, "observe_triggered_stop");
  let saved = fixture.store.data.positions[0].snapshot;
  assert.equal(saved.status, "closing");
  assert.equal(saved.split.stage, "runner_cleanup_pending");
  assert.equal(saved.split.runnerCleanup.childOrderId, "impulse-runner-trigger-fill");
  assert.equal(Number(saved.persistedPosition.quantity), Number(residual));
  assert.equal(saved.persistedPosition.protectiveStops.core.orderId, coreId);
  assert.equal(saved.persistedPosition.originalStop.orderId, originalId);
  assert.deepEqual(fixture.exchange.orders.map((order) => order.orderId).sort(),
    [originalId, coreId].sort());
  assert.equal(fixture.mutations.includes("cancel_original_after_runner_fill"), false);

  assert.equal((await worker.runOnce()).operation, "cancel_original_after_runner_fill");
  saved = fixture.store.data.positions[0].snapshot;
  assert.equal(saved.split.stage, "complete");
  assert.equal(saved.split.runnerCleanup, null);
  assert.equal(saved.runnerOpen, false);
  assert.equal(saved.coreOpen, true);
  assert.equal(saved.remainingQty, Number(residual));
  assert.equal(Number(saved.persistedPosition.quantity), Number(residual));
  assert.equal(saved.persistedPosition.protectiveStops.core.orderId, coreId);
  assert.equal(saved.persistedPosition.originalStop, undefined);
  assert.deepEqual(fixture.exchange.orders.map((order) => order.orderId), [coreId]);
  assert.equal(fixture.store.data.intents.some((intent) =>
    intent.request.operation === "cancel_original_after_runner_fill"), true);
});

test("120-hour sole runner exit uses exact guarded flat-close evidence", async () => {
  const fixture = impulseLifecycleFixture();
  for (let tick = 0; tick < 5; tick += 1) {
    await createVstWorker({
      store: fixture.store, broker: fixture.broker, clock: () => NOW,
      sizingLimits: {
        environment: "vst", maxQuoteAgeMs: 10_000,
        maxPriceMoveBps: 500, maxSlippageBps: 100,
      },
    }).runOnce();
  }
  const row = fixture.store.data.positions[0];
  const state = row.snapshot;
  const runnerQuantity = String(state.split.runnerQuantity);
  const runnerStop = { ...state.split.runnerStop, quantity: runnerQuantity };
  state.entryAt = new Date(NOW - 120 * 60 * 60 * 1000).toISOString();
  state.observedAt = state.entryAt;
  state.coreOpen = false;
  state.coreQty = 0;
  state.runnerOpen = true;
  state.runnerQty = Number(runnerQuantity);
  state.remainingQty = Number(runnerQuantity);
  state.coreStopOrderId = null;
  state.coreStopPositionId = null;
  state.coreStopQuantity = 0;
  state.runnerStopQuantity = Number(runnerQuantity);
  state.split.coreStop = null;
  state.split.runnerStop = runnerStop;
  state.split.activeLegs = ["runner"];
  state.split.baselineOpenOrderIds = [runnerStop.orderId];
  fixture.exchange.position.quantity = Number(runnerQuantity);
  fixture.exchange.position.protectiveStops = {
    runner: {
      verified: true,
      orderId: runnerStop.orderId,
      positionId: state.exchangePositionId,
      quantity: Number(runnerQuantity),
      stopPrice: Number(runnerStop.stopPrice),
    },
  };
  fixture.exchange.orders = [fixture.makeOpenStop(
    runnerStop.orderId, state.exchangePositionId, runnerQuantity,
    runnerStop.stopPrice, state.entryOrderId,
  )];
  fixture.setMarkPrice(105);

  const worker = createVstWorker({
    store: fixture.store, broker: fixture.broker, clock: () => NOW,
    sizingLimits: { environment: "vst" },
  });
  const result = await worker.runOnce();
  assert.equal(result.operation, "close_survivor");
  assert.equal(result.leg, "runner");
  assert.equal(fixture.mutations.at(-1), "close_survivor");
  assert.equal(fixture.store.data.positions[0].snapshot.status, "closed");
  assert.equal(fixture.store.data.positions[0].snapshot.remainingQty, 0);
  assert.equal(fixture.exchange.orders.length, 0);
  const closeIntent = fixture.store.data.intents.find((intent) =>
    intent.request.operation === "close_survivor");
  assert.equal(closeIntent.state, "reconciled");
  assert.equal(closeIntent.request.stop.orderId, runnerStop.orderId);
  assert.equal(closeIntent.request.quantity, runnerQuantity);
});

test("120-hour expiry closes only runner, cleans its stop, and keeps core protected", async () => {
  const fixture = impulseLifecycleFixture();
  const makeWorker = () => createVstWorker({
    store: fixture.store, broker: fixture.broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  let worker = makeWorker();
  for (let tick = 0; tick < 5 &&
       fixture.store.data.positions[0]?.snapshot.split?.stage !== "complete";
  tick += 1) await worker.runOnce();
  const state = fixture.store.data.positions[0].snapshot;
  assert.equal(state.split.stage, "complete", JSON.stringify(state.split));
  assert.equal(fixture.exchange.orders.length, 2, JSON.stringify(fixture.exchange.orders));
  state.entryAt = new Date(NOW - 120 * 60 * 60 * 1000).toISOString();
  state.observedAt = state.entryAt;
  fixture.setMarkPrice(105);
  const result = await worker.runOnce();
  assert.equal(result.kind, "acted", JSON.stringify(result));
  assert.equal(result.operation, "close_leg");
  assert.equal(result.leg, "runner");
  assert.equal(fixture.mutations.includes("close_split_all"), false);
  let saved = fixture.store.data.positions[0].snapshot;
  assert.equal(saved.status, "closing");
  assert.equal(saved.split.stage, "cleanup_pending");
  assert.equal(saved.pendingClose.closedLeg, "runner");
  assert.equal(saved.pendingClose.remainingQuantity, saved.split.coreQuantity);
  assert.equal(saved.coreOpen, true);
  assert.equal(saved.split.pendingClosePolicy.coreOpen, true);
  assert.equal(saved.split.pendingClosePolicy.runnerOpen, false);
  assert.equal(saved.split.pendingClosePolicy.stopPrice, saved.stopPrice);
  const runnerCloseIntent = fixture.store.data.intents.find((intent) =>
    intent.request.operation === "close_leg");
  assert.equal(runnerCloseIntent.state, "reconciled");
  assert.equal(Number.isSafeInteger(runnerCloseIntent.request.intentCreatedAt), true);
  assert.ok(runnerCloseIntent.request.intentCreatedAt > Date.parse(state.entryAt));
  assert.notEqual(runnerCloseIntent.request.intentCreatedAt, Date.parse(state.entryAt),
    "120-hour expiry history must start from this close intent, not the old entryAt");
  assert.equal(runnerCloseIntent.request.leg, "runner");
  assert.equal(runnerCloseIntent.request.quantity, saved.split.runnerQuantity);
  assert.equal(runnerCloseIntent.request.nextPolicy.coreOpen, true);
  assert.equal(runnerCloseIntent.request.nextPolicy.runnerOpen, false);
  assert.equal(fixture.exchange.position.quantity, Number(saved.split.coreQuantity));
  assert.equal(fixture.exchange.orders.length, 2);

  assert.equal((await worker.runOnce()).operation, "cancel_split_stop");
  saved = fixture.store.data.positions[0].snapshot;
  assert.equal(saved.status, "open");
  assert.equal(saved.split.stage, "complete");
  assert.deepEqual(saved.split.activeLegs, ["core"]);
  assert.equal(saved.coreOpen, true);
  assert.equal(saved.runnerOpen, false);
  assert.equal(saved.coreQty, Number(saved.split.coreQuantity));
  assert.equal(saved.remainingQty, saved.coreQty);
  assert.equal(saved.split.runnerStop, null);
  assert.equal(fixture.exchange.orders.length, 1);
  assert.deepEqual(fixture.exchange.orders.map((row) => row.orderId),
    [saved.split.coreStop.orderId]);
  assert.equal(fixture.exchange.orders[0].stopPrice, String(saved.stopPrice));

  // Entry fills older than the broker's exact-history retention window cannot
  // authorize a later core stop raise, even though the old protection remains.
  worker = makeWorker();
  const corePolicyAction = await worker.runOnce();
  assert.equal(corePolicyAction.kind, "unknown");
  assert.equal(corePolicyAction.reason, "raise_stop_original_entry_intent_not_verified");
  saved = fixture.store.data.positions[0].snapshot;
  assert.equal(saved.status, "unknown");
  assert.equal(saved.split.stage, "complete");
  assert.equal(saved.coreOpen, true);
  assert.equal(saved.runnerOpen, false);
  assert.equal(saved.stopPrice, 95);
  assert.equal(saved.split.coreStop.stopPrice, "95");
  assert.equal(fixture.mutations.includes("raise_stop"), false);
  assert.equal(fixture.exchange.orders.length, 1);
  assert.equal(fixture.exchange.orders[0].orderId, saved.split.coreStop.orderId);
  assert.equal(fixture.readPositionCalls.length > 0, true);
  assert.ok(fixture.readPositionCalls.every((call) =>
    call.allowProcessCache === false && call.persistedPosition?.verified === true));
});

test("ambiguous runner expiry close and stale-stop cleanup reconcile without replay", async () => {
  let obscureCloseEvidence = true;
  let obscureStopCancelEvidence = true;
  const fixture = impulseLifecycleFixture({
    mutateEvidence(request, evidence) {
      if (request.operation === "close_leg" && obscureCloseEvidence) {
        obscureCloseEvidence = false;
        return { ...evidence, verified: false, status: "unknown" };
      }
      if (request.operation === "cancel_split_stop" &&
          request.leg === "runner" && obscureStopCancelEvidence) {
        obscureStopCancelEvidence = false;
        return { ...evidence, verified: false, status: "unknown" };
      }
      return evidence;
    },
  });
  const makeWorker = () => createVstWorker({
    store: fixture.store, broker: fixture.broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  let worker = makeWorker();
  for (let tick = 0; tick < 5 &&
       fixture.store.data.positions[0]?.snapshot.split?.stage !== "complete";
  tick += 1) await worker.runOnce();
  const state = fixture.store.data.positions[0].snapshot;
  state.entryAt = new Date(NOW - 120 * 60 * 60 * 1000).toISOString();
  state.observedAt = state.entryAt;
  fixture.setMarkPrice(105);
  assert.equal((await worker.runOnce()).kind, "unknown");
  assert.equal(fixture.mutations.filter((operation) =>
    operation === "close_leg").length, 1);
  assert.equal(fixture.store.data.positions[0].snapshot.split.stage, "complete");

  worker = makeWorker();
  assert.equal((await worker.runOnce()).kind, "unknown");
  assert.equal(fixture.mutations.filter((operation) =>
    operation === "close_leg").length, 1);
  assert.equal(fixture.mutations.filter((operation) =>
    operation === "cancel_split_stop").length, 1);
  assert.equal(fixture.mutationRequests.filter((request) =>
    request.operation === "cancel_split_stop" &&
    request.leg === "runner").length, 1);
  assert.equal(fixture.store.data.positions[0].snapshot.split.stage,
    "cleanup_pending");

  worker = makeWorker();
  await worker.runOnce();
  assert.equal(fixture.mutations.filter((operation) =>
    operation === "close_leg").length, 1);
  assert.equal(fixture.mutationRequests.filter((request) =>
    request.operation === "cancel_split_stop" &&
    request.leg === "runner").length, 1);
  assert.equal(fixture.mutationRequests.filter((request) =>
    request.operation === "cancel_split_stop" &&
    request.leg === "core").length, 0);
  const saved = fixture.store.data.positions[0].snapshot;
  assert.equal(saved.split.stage, "complete");
  assert.equal(saved.status, "unknown");
  assert.equal(saved.coreOpen, true);
  assert.equal(saved.runnerOpen, false);
  assert.deepEqual(fixture.exchange.orders.map((order) => order.orderId),
    [saved.split.coreStop.orderId]);
  assert.ok(fixture.store.data.intents.filter((intent) =>
    ["close_leg", "cancel_split_stop"].includes(intent.request.operation))
    .every((intent) => intent.state === "reconciled"));
});

test("restart reconciliation leaves ambiguous entry unknown and never invents a fill", async () => {
  const store = memoryStore(null);
  store.data.intents.push({
    sourceSignalId: "cab-signal-124",
    phase: "market-entry",
    clientOrderId: "vst-restart-entry",
    request: {
      operation: "entry",
      environment: "vst",
      accountId: "vst-account",
      symbol: "ETHUSDT",
      signal: signal,
      sizing: { quantity: "1" },
    },
    state: "submitted",
  });
  let mutationCalls = 0;
  const broker = guardedBroker(store, {
    reconcile: async () => ({ verified: false, status: "unknown" }),
    onPerform: async () => { mutationCalls += 1; },
  });
  const result = await createVstWorker({
    store, broker, clock: () => NOW, sizingLimits: { environment: "vst" },
  }).runOnce();
  assert.equal(result.kind, "blocked");
  assert.equal(result.reason, "unresolved_vst_order_intents");
  assert.equal(store.data.intents[0].state, "unknown");
  assert.equal(store.data.positions.length, 0);
  assert.equal(mutationCalls, 0);
});

test("restart recovers a retired protected entry with one tick of price rounding without reposting", async () => {
  const entrySignal = {
    ...activePolicy({ stopLoss: "95" }),
    sourceSignalId: "rounded-entry-recovery",
  };
  const store = memoryStore(null);
  store.data.intents.push({
    sourceSignalId: entrySignal.sourceSignalId,
    phase: "market-entry",
    clientOrderId: "rounded-entry-id",
    request: {
      operation: "entry", environment: "vst", accountId: "vst-account",
      symbol: entrySignal.symbol, signal: entrySignal, quantity: "1",
      stopLoss: "95", intentCreatedAt: NOW - 60_000,
      sizing: { quantity: "1", plannedTopUpVst: 0, initialMarginVst: 10 },
    },
    state: "failed",
  });
  let resumed = 0;
  store.listRecoverableFailedEntries = async () =>
    store.data.intents.filter((intent) => intent.state === "failed");
  store.resumeVerifiedFailedEntry = async (id) => {
    const intent = store.data.intents.find((row) => row.clientOrderId === id);
    if (!intent || intent.state !== "failed") return false;
    intent.state = "unknown";
    resumed += 1;
    return true;
  };
  let mutationCalls = 0;
  const broker = guardedBroker(store, {
    originalStopOrderId: "exact-stop-id",
    reconcile: async () => ({
      verified: true, status: "filled", exchangeOrderId: "exact-entry-id",
      fill: { price: 100, quantity: 1, at: new Date(NOW).toISOString() },
      position: {
        verified: true, symbol: entrySignal.symbol, side: "Buy",
        marginMode: "ISOLATED", leverage: 10, positionId: "exact-position-id",
        quantity: 1, avgPrice: 99.9, pricePrecision: 1,
      },
      protectiveStops: {
        core: {
          verified: true, orderId: "exact-stop-id", positionId: "exact-position-id",
          quantity: 1, stopPrice: 95,
        },
      },
    }),
    onPerform: async () => { mutationCalls += 1; },
  });
  await createVstWorker({
    store, broker, clock: () => NOW, sizingLimits: { environment: "vst" },
  }).runOnce();
  assert.equal(store.data.intents[0].state, "reconciled");
  // The test broker does not expose a live managed position on the next
  // tick, but the recovery itself must commit the verified open position.
  assert.equal(store.data.lastVerifiedCommit.position.status, "open");
  assert.equal(store.data.lastVerifiedCommit.position.coreStopOrderId, "exact-stop-id");
  assert.equal(resumed, 1);
  assert.equal(mutationCalls, 0);
});

test("a retired entry with no independently verified stop is never resumed or reposted", async () => {
  const store = memoryStore(null);
  const intent = {
    sourceSignalId: "unverified-retired-entry", phase: "market-entry",
    clientOrderId: "unverified-entry-id", state: "failed",
    request: { operation: "entry", symbol: "ETHUSDT", environment: "vst",
      accountId: "vst-account", intentCreatedAt: NOW - 60_000 },
  };
  store.data.intents.push(intent);
  store.listRecoverableFailedEntries = async () => [intent];
  let resumes = 0;
  store.resumeVerifiedFailedEntry = async () => { resumes += 1; return true; };
  let submissions = 0;
  const broker = guardedBroker(store, {
    reconcile: async () => ({
      verified: true, status: "filled", exchangeOrderId: "entry-id",
      position: { positionId: "position-id" }, protectiveStops: {},
    }),
    onPerform: async () => { submissions += 1; },
  });
  await createVstWorker({
    store, broker, clock: () => NOW, sizingLimits: { environment: "vst" },
  }).runOnce();
  assert.equal(intent.state, "failed");
  assert.equal(resumes, 0);
  assert.equal(submissions, 0);
});

function stuckIntentFixture(sourceSignalId, clientOrderId) {
  const store = memoryStore(null);
  store.data.intents.push({
    sourceSignalId,
    phase: "market-entry",
    clientOrderId,
    request: {
      operation: "entry",
      environment: "vst",
      accountId: "vst-account",
      symbol: "ETHUSDT",
      signal: signal,
      sizing: { quantity: "1" },
    },
    state: "submitted",
  });
  const broker = guardedBroker(store, {
    reconcile: async () => ({ verified: false, status: "unknown" }),
  });
  return { store, broker };
}

test("alerts once a blocked pipeline crosses the threshold, then waits before repeating", async () => {
  const { store, broker } = stuckIntentFixture("cab-signal-124", "vst-restart-entry");
  let now = NOW;
  const alerts = [];
  const worker = createVstWorker({
    store, broker, clock: () => now, sizingLimits: { environment: "vst" },
    onBlocked: async (info) => { alerts.push(info); },
  });

  assert.equal((await worker.runOnce()).kind, "blocked");
  assert.equal(alerts.length, 0, "no alert before the threshold");

  now += 4 * 60_000;
  assert.equal((await worker.runOnce()).kind, "blocked");
  assert.equal(alerts.length, 0, "still under the 5-minute threshold");

  now += 2 * 60_000; // 6 minutes of continuous blockage
  const crossing = await worker.runOnce();
  assert.equal(crossing.kind, "blocked");
  assert.equal(alerts.length, 1, "exactly one alert once the threshold is crossed");
  assert.equal(alerts[0].reason, "unresolved_vst_order_intents");
  assert.equal(alerts[0].count, 1);
  assert.equal(alerts[0].blockedForMs, 6 * 60_000);

  now += 10 * 60_000; // 16 minutes total; repeat interval (30 min) not yet reached
  await worker.runOnce();
  assert.equal(alerts.length, 1, "no repeat before the 30-minute repeat interval");

  now += 25 * 60_000; // 41 minutes total; long incident earns a second alert
  await worker.runOnce();
  assert.equal(alerts.length, 2, "a long-running incident is resurfaced");
  assert.equal(alerts[1].blockedForMs, 41 * 60_000);
});

test("resets the blocked timer once the pipeline recovers, requiring a fresh threshold next time", async () => {
  const { store, broker } = stuckIntentFixture("cab-signal-126", "vst-restart-entry-reset");
  let now = NOW;
  const alerts = [];
  const worker = createVstWorker({
    store, broker, clock: () => now, sizingLimits: { environment: "vst" },
    onBlocked: async (info) => { alerts.push(info); },
  });

  await worker.runOnce();
  now += 6 * 60_000;
  await worker.runOnce();
  assert.equal(alerts.length, 1);

  // Manually resolve the stuck intent (as an operator would) and confirm the
  // pipeline reports itself unblocked.
  store.data.intents.length = 0;
  now += 60_000;
  const recovered = await worker.runOnce();
  assert.equal(recovered.kind, "idle");

  // A brand new incident must cross the threshold again from zero -- it
  // must not immediately re-alert just because a prior incident happened.
  store.data.intents.push({
    sourceSignalId: "cab-signal-126",
    phase: "market-entry",
    clientOrderId: "vst-restart-entry-reset",
    request: {
      operation: "entry",
      environment: "vst",
      accountId: "vst-account",
      symbol: "ETHUSDT",
      signal: signal,
      sizing: { quantity: "1" },
    },
    state: "submitted",
  });
  assert.equal((await worker.runOnce()).kind, "blocked");
  assert.equal(alerts.length, 1, "the new incident has not yet crossed its own threshold");

  now += 6 * 60_000;
  await worker.runOnce();
  assert.equal(alerts.length, 2, "the new incident alerts independently once it crosses the threshold");
});

test("a busy leader lock skips the tick without crashing timing or resetting alerts", async () => {
  const store = memoryStore(null);
  store.withLeaderLock = async () => null;
  const alerts = [];
  const timings = [];
  const worker = createVstWorker({
    store, broker: guardedBroker(store),
    clock: () => NOW, sizingLimits: { environment: "vst" },
    onTiming: async (timing) => { timings.push(timing); },
    onBlocked: async (alert) => { alerts.push(alert); },
  });
  assert.equal(await worker.runOnce(), null);
  assert.deepEqual(timings, []);
  assert.deepEqual(alerts, []);
  assert.equal(store.data.intents.length, 0);
});

test("prolonged capability waits alert only for pending signals and log sanitized diagnostics", async () => {
  let now = NOW;
  const store = memoryStore(null);
  const alerts = [];
  const timings = [];
  let capabilityUnavailable = true;
  let submissions = 0;
  const broker = guardedBroker(store, {
    onPerform: async () => { submissions += 1; },
  });
  broker.getCapabilities = async () => {
    if (capabilityUnavailable) {
      const error = new Error("private endpoint details must never be logged");
      error.code = 100410;
      throw error;
    }
    return {
      environment: "vst", verified: true, accountId: "vst-account",
      features: FULL_CAPABILITIES,
    };
  };
  const worker = createVstWorker({
    store, broker, clock: () => now, sizingLimits: { environment: "vst" },
    onBlocked: async (info) => { alerts.push(info); },
    onTiming: async (info) => { timings.push(info); },
  });

  // A long capabilities outage with no pending signal is not a signal-wait
  // incident and must not generate an alert.
  for (let minute = 0; minute < 6; minute += 1) {
    const result = await worker.runOnce();
    assert.equal(result.kind, "waiting");
    now += 60_000;
  }
  assert.equal(alerts.length, 0);

  const pendingSignal = {
    ...signal,
    sourceSignalId: "cab-signal-waiting-capabilities",
    symbol: "ETHUSDT",
  };
  await store.enqueue(pendingSignal);
  const waiting = await worker.runOnce();
  assert.equal(waiting.kind, "waiting");
  assert.equal(timings.at(-1).diagnosticReason, "capability_read_failed");
  assert.equal(timings.at(-1).diagnosticCode, 100410);
  assert.doesNotMatch(JSON.stringify(timings), /private endpoint|cab-signal-waiting|ETHUSDT/);
  assert.equal(store.data.intents.length, 0);
  assert.equal(submissions, 0);

  now += 6 * 60_000;
  assert.equal((await worker.runOnce()).kind, "waiting");
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0], {
    reason: "pending_vst_signals_waiting",
    scope: "account",
    blockedForMs: 6 * 60_000,
    count: 1,
    sourceSignalId: pendingSignal.sourceSignalId,
    symbol: "ETHUSDT",
  });
  assert.equal(store.data.pending.status, "pending");
  assert.equal(store.data.intents.length, 0);
  assert.equal(submissions, 0);
});

async function captureManagementReadFailureTiming(error, symbol = "ETHUSDT") {
  const store = memoryStore(null);
  const sourceSignalId = "cab-diagnostic-read-failure";
  store.data.positions.push({
    sourceSignalId,
    symbol,
    status: "open",
    snapshot: {
      sourceSignalId,
      symbol,
      patternId: "balanced_grind",
      status: "open",
      environment: "vst",
      accountId: "vst-account",
    },
  });
  const broker = guardedBroker(store, {});
  broker.readPosition = async () => { throw error; };
  const timings = [];
  const worker = createVstWorker({
    store, broker, clock: () => NOW, sizingLimits: { environment: "vst" },
    onTiming: async (timing) => { timings.push(timing); },
  });
  let propagated;
  try {
    await worker.runOnce();
  } catch (caught) {
    propagated = caught;
  }
  return { timing: timings.at(-1), propagated };
}

test("production-like BingX read failures log only the allowlisted request context and managed symbol", async () => {
  const error = new BingXLiveApiError(
    "BingX response contains private apiKey=credential and https://private.example/?token=secret",
    {
      code: 109400,
      endpoint: "/openApi/swap/v2/user/positions",
      method: "GET",
    },
  );
  const { timing, propagated } = await captureManagementReadFailureTiming(error);
  assert.equal(propagated, error, "diagnostic reporting must preserve exception propagation");
  assert.equal(timing.kind, "exception");
  assert.equal(timing.diagnosticCode, 109400);
  assert.equal(timing.diagnosticEndpoint, "/openApi/swap/v2/user/positions");
  assert.equal(timing.diagnosticMethod, "GET");
  assert.equal(timing.managedSymbol, "ETHUSDT");
  assert.match(timing.diagnosticMessage,
    /^BingXLiveApiError: BingX error code 109400 \[ref:[a-f0-9]{12}\]$/);
  assert.doesNotMatch(JSON.stringify(timing),
    /apiKey|credential|private\.example|token=secret|https:\/\//);
  assert.equal(error.message,
    "BingX response contains private apiKey=credential and https://private.example/?token=secret");
});

test("BingX read diagnostics reject arbitrary URL/secret endpoints and noncanonical symbols", async () => {
  for (const endpoint of [
    "https://open-api-vst.bingx.com/openApi/swap/v2/user/positions?apiKey=secret",
    "/openApi/swap/v2/user/positions?secret=credential",
    "/openApi/swap/v2/private/accountState",
  ]) {
    const error = new BingXLiveApiError("private exchange response", {
      code: 109400, endpoint, method: "GET",
    });
    const { timing, propagated } = await captureManagementReadFailureTiming(error);
    assert.equal(propagated, error);
    assert.equal(Object.hasOwn(timing, "diagnosticEndpoint"), false);
    assert.equal(Object.hasOwn(timing, "diagnosticMethod"), false);
    assert.equal(timing.managedSymbol, "ETHUSDT");
  }

  const nonReadMethodError = new BingXLiveApiError("private exchange response", {
    code: 109400,
    endpoint: "/openApi/swap/v2/user/positions",
    method: "POST",
  });
  const { timing: nonReadMethodTiming } =
    await captureManagementReadFailureTiming(nonReadMethodError);
  assert.equal(Object.hasOwn(nonReadMethodTiming, "diagnosticEndpoint"), false);
  assert.equal(Object.hasOwn(nonReadMethodTiming, "diagnosticMethod"), false);

  const invalidSymbolError = new BingXLiveApiError("private exchange response", {
    code: 109400,
    endpoint: "/openApi/swap/v2/user/positions",
    method: "GET",
  });
  const { timing } = await captureManagementReadFailureTiming(
    invalidSymbolError, "ETH-USDT",
  );
  assert.equal(Object.hasOwn(timing, "managedSymbol"), false);
});

test("pending-signal wait alerts reset when the queue empties or capabilities recover", async () => {
  let now = NOW;
  const store = memoryStore(null);
  const alerts = [];
  let capabilityUnavailable = true;
  let submissions = 0;
  const broker = guardedBroker(store, {
    onPerform: async () => { submissions += 1; },
  });
  broker.getCapabilities = async () => {
    if (capabilityUnavailable) throw new Error("temporary capability read failure");
    return {
      environment: "vst", verified: true, accountId: "vst-account",
      features: FULL_CAPABILITIES,
    };
  };
  const worker = createVstWorker({
    store, broker, clock: () => now, sizingLimits: { environment: "vst" },
    onBlocked: async (info) => { alerts.push(info); },
  });
  const pendingSignal = {
    ...signal,
    sourceSignalId: "cab-signal-waiting-reset",
    symbol: "ETHUSDT",
  };
  await store.enqueue(pendingSignal);
  await worker.runOnce();
  now += 4 * 60_000;

  // No candidate ends the wait incident even though the capability read
  // remains unavailable.
  store.data.pending = null;
  await worker.runOnce();
  assert.equal(alerts.length, 0);

  // A successful fresh capabilities check also ends the old wait incident.
  capabilityUnavailable = false;
  assert.equal((await worker.runOnce()).kind, "idle");

  capabilityUnavailable = true;
  await store.enqueue({
    ...pendingSignal,
    sourceSignalId: "cab-signal-waiting-reset-again",
  });
  await worker.runOnce();
  now += 4 * 60_000;
  await worker.runOnce();
  assert.equal(alerts.length, 0, "a recovered/new incident starts a fresh threshold");

  now += 2 * 60_000;
  await worker.runOnce();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].sourceSignalId, "cab-signal-waiting-reset-again");
  assert.equal(alerts[0].blockedForMs, 6 * 60_000);
  assert.equal(store.data.intents.length, 0);
  assert.equal(submissions, 0);
});

test("waiting results do not reset or mask an unresolved intent's alert timer", async () => {
  let now = NOW;
  const store = memoryStore({
    ...signal,
    sourceSignalId: "cab-signal-also-waiting",
    symbol: "ETHUSDT",
  });
  store.data.intents.push({
    sourceSignalId: "cab-signal-unresolved-during-wait",
    phase: "observe-triggered-stop",
    clientOrderId: "vst-unresolved-during-wait",
    state: "unknown",
    request: {
      operation: "observe_triggered_stop",
      environment: "vst",
      accountId: "vst-account",
      symbol: "BTCUSDT",
    },
  });
  const alerts = [];
  let submissions = 0;
  const broker = guardedBroker(store, {
    onPerform: async () => { submissions += 1; },
  });
  broker.getCapabilities = async () => {
    const error = new Error("provider message must remain private");
    error.code = 100410;
    throw error;
  };
  const worker = createVstWorker({
    store, broker, clock: () => now, sizingLimits: { environment: "vst" },
    onBlocked: async (info) => { alerts.push(info); },
  });

  await worker.runOnce();
  now += 4 * 60_000;
  await worker.runOnce();
  now += 2 * 60_000;
  const result = await worker.runOnce();
  assert.equal(result.kind, "waiting");
  assert.ok(alerts.some((alert) =>
    alert.reason === "pending_vst_signals_waiting"));
  const unresolved = alerts.find((alert) =>
    alert.reason === "unresolved_vst_order_intents");
  assert.ok(unresolved, "the independent unresolved-intent timer still fires");
  assert.equal(unresolved.blockedForMs, 6 * 60_000);
  assert.equal(unresolved.sourceSignalId, "cab-signal-unresolved-during-wait");
  assert.equal(store.data.intents[0].state, "unknown");
  assert.equal(store.data.intents.length, 1);
  assert.equal(submissions, 0);
});

test("a failing alert callback never changes runOnce()'s result or retries every tick", async () => {
  const { store, broker } = stuckIntentFixture("cab-signal-127", "vst-restart-entry-failing-alert");
  let now = NOW;
  let alertAttempts = 0;
  const worker = createVstWorker({
    store, broker, clock: () => now, sizingLimits: { environment: "vst" },
    onBlocked: async () => {
      alertAttempts += 1;
      throw new Error("Telegram is down");
    },
  });

  await worker.runOnce();
  now += 6 * 60_000;
  const result = await worker.runOnce();
  assert.equal(result.kind, "blocked");
  assert.equal(result.reason, "unresolved_vst_order_intents");
  assert.equal(alertAttempts, 1);

  // A failed delivery still counts as "alerted" for this incident; it must
  // not retry on every subsequent tick regardless of the outcome.
  now += 5 * 60_000;
  await worker.runOnce();
  assert.equal(alertAttempts, 1);
});

test("omitting onBlocked keeps runOnce() working with no alerting side effects", async () => {
  const { store, broker } = stuckIntentFixture("cab-signal-128", "vst-restart-entry-no-callback");
  let now = NOW;
  const worker = createVstWorker({
    store, broker, clock: () => now, sizingLimits: { environment: "vst" },
  });
  assert.equal((await worker.runOnce()).kind, "blocked");
  now += 20 * 60_000;
  assert.equal((await worker.runOnce()).kind, "blocked");
});

test("unresolved-action logs are immediate, symbol scoped, cause-sensitive, throttled, and cleaned up", async () => {
  const { store, broker } = stuckIntentFixture("cab-signal-201", "vst-action-201");
  const akt = store.data.intents[0];
  Object.assign(akt, {
    phase: "impulse-cancel_original_stop",
    exchangeOrderId: "5001",
    request: { ...akt.request, symbol: "AKTUSDT", operation: "cancel_original_stop" },
    outcome: {
      submissionError: "BingXLiveApiError",
      submissionErrorMessage: "private response apiKey=must-not-log",
      submissionCode: 109400,
      submissionMethod: "GET",
      submissionEndpoint: "/openApi/swap/v2/trade/leverage",
      submissionHttpStatus: 200,
      submissionExchangeMessage: "timestamp is invalid",
    },
  });
  store.data.intents.push(
    {
      ...akt,
      sourceSignalId: "cab-signal-202",
      clientOrderId: "vst-action-202",
      phase: "impulse-runner-breakeven-abort-1790873680714",
      request: { ...akt.request, symbol: "KIIUSDT", operation: "close_pre_runner_split" },
      outcome: {
        submissionError: "BingXLiveApiError",
        submissionCode: 109421,
        submissionMethod: "GET",
        submissionEndpoint: "/openApi/swap/v2/trade/order",
        submissionHttpStatus: 200,
        submissionExchangeMessage: "order not exist",
      },
    },
    {
      ...akt,
      sourceSignalId: "cab-signal-203",
      clientOrderId: "vst-action-203",
      phase: "impulse-sole-core-stop-203",
      request: { ...akt.request, symbol: "REUSDT", operation: "raise_stop" },
      outcome: { reason: "bingx_vst_entry_history_fills_unverified" },
    },
  );
  const logs = [];
  const stderrDiagnostics = [];
  const alerts = [];
  let now = NOW;
  const originalWarn = console.warn;
  const originalStderrWrite = process.stderr.write;
  console.warn = (message) => logs.push(String(message));
  process.stderr.write = function (chunk, ...args) {
    const text = String(chunk);
    if (text.includes("Bullet VST")) {
      stderrDiagnostics.push(text);
      return true;
    }
    return originalStderrWrite.call(this, chunk, ...args);
  };
  try {
    const worker = createVstWorker({
      store, broker, clock: () => now, sizingLimits: { environment: "vst" },
      onBlocked: async (info) => alerts.push(info),
    });
    await worker.runOnce();
    assert.equal(logs.length, 3, "every unresolved intent is logged before alert threshold");
    const lines = logs.map((message) => JSON.parse(message.split(": ").at(-1)));
    const aktLog = lines.find((line) => line.symbol === "AKTUSDT");
    assert.equal(aktLog.symbolUnresolvedCount, 1);
    assert.equal(aktLog.accountUnresolvedCount, 3);
    assert.equal(aktLog.phase, "impulse-cancel_original_stop");
    assert.equal(aktLog.state, "unknown");
    assert.equal(aktLog.originalDiagnostic.code, "109400");
    assert.doesNotMatch(logs.join("\n"), /must-not-log|apiKey=/);
    const diagnosticsAfterFirstTick = logs.length + stderrDiagnostics.length;

    await worker.runOnce();
    assert.ok(logs.length + stderrDiagnostics.length <= diagnosticsAfterFirstTick + 1,
      "a newly persisted recovery refusal may be logged once, never every tick");
    await worker.runOnce();
    const beforeChange = logs.length;
    const diagnosticsBeforeStableTick = logs.length + stderrDiagnostics.length;
    await worker.runOnce();
    assert.equal(logs.length + stderrDiagnostics.length, diagnosticsBeforeStableTick,
      "all VST diagnostics are throttled for unchanged causes");
    assert.equal(logs.length, beforeChange);

    now += 5 * 60_000;
    await worker.runOnce();
    assert.equal(alerts.length, 3, "Telegram warning begins only after the established threshold");
    const aktAlert = alerts.find((alert) => alert.symbol === "AKTUSDT");
    assert.equal(aktAlert.symbolUnresolvedCount, 1);
    assert.equal(aktAlert.accountUnresolvedCount, 3);

    const kii = store.data.intents.find((row) => row.sourceSignalId === "cab-signal-202");
    kii.request.operation = "split_core_stop";
    await worker.runOnce();
    assert.ok(logs.length >= beforeChange + 1, "a meaningful action change logs immediately");
    assert.equal(alerts.length, 4, "a changed action cause alerts immediately after threshold");
    assert.equal(alerts.at(-1).operation, "split_core_stop");

    store.data.intents.splice(1);
    await worker.runOnce();
    const beforeCleanup = logs.length;
    store.data.intents.length = 0;
    await worker.runOnce();
    store.data.intents.push(akt);
    await worker.runOnce();
    assert.equal(logs.length, beforeCleanup + 1,
      "resolved intents are removed from throttle state");
  } finally {
    console.warn = originalWarn;
    process.stderr.write = originalStderrWrite;
  }
});

function unresolvedPreRunnerCloseFixture({
  sourceSignalId,
  clientOrderId,
  reconcile,
}) {
  const store = memoryStore(null);
  store.data.intents.push({
    sourceSignalId,
    phase: "impulse-runner-breakeven-abort-1790873680714",
    clientOrderId,
    exchangeOrderId: null,
    state: "unknown",
    request: {
      operation: "close_pre_runner_split",
      environment: "vst",
      accountId: "vst-account",
      symbol: "KIIUSDT",
    },
    outcome: {
      reason: "exchange_state_not_verified",
      submissionError: "BingXLiveApiError",
      submissionErrorMessage: "BingX order error; details withheld",
      submissionCode: 109421,
      submissionMethod: "GET",
      submissionEndpoint: "/openApi/swap/v2/trade/order",
      submissionHttpStatus: 200,
      submissionExchangeMessage: "order not exist",
    },
  });
  let mutations = 0;
  const broker = guardedBroker(store, {
    reconcile,
    onPerform: async () => { mutations += 1; },
  });
  return { store, broker, mutations: () => mutations };
}

test("legacy KII pre-runner close without no-write provenance remains deferred and alerts original 109421", async () => {
  let now = NOW;
  const { store, broker, mutations } = unresolvedPreRunnerCloseFixture({
    sourceSignalId: "cab-signal-301",
    clientOrderId: "vst-legacy-kii-301",
    reconcile: async () => ({ verified: false, status: "unknown" }),
  });
  const alerts = [];
  const worker = createVstWorker({
    store, broker, clock: () => now, sizingLimits: { environment: "vst" },
    onBlocked: async (info) => alerts.push(info),
  });
  await worker.runOnce();
  now += 5 * 60_000;
  await worker.runOnce();
  const alert = alerts.find((item) => item.reason === "unresolved_vst_order_intents");
  assert.ok(alert);
  assert.equal(alert.recoveryDeferredReason,
    "close_pre_runner_split_mutation_provenance_missing");
  assert.equal(alert.originalDiagnostic.code, "109421");
  assert.equal(alert.originalDiagnostic.providerReason, "order_not_found");
  assert.equal(alert.phase, "impulse-runner-breakeven-abort-1790873680714");
  assert.equal(alert.state, "unknown");
  assert.equal(alert.lastAttemptAt, new Date(now).toISOString());
  assert.equal(alert.lastAttemptAgeMs, 0);
  const text = formatVstBlockedAlert(alert);
  assert.match(text, /закрытие позиции до настройки runner/);
  assert.match(text, /код BingX 109421/);
  assert.match(text, /нет проверенного доказательства/);
  assert.doesNotMatch(text, /закрытие не отправлялось|повторить автоматически/);
  assert.equal(mutations(), 0, "legacy GET evidence never authorizes a fresh close");
});

test("throwing GET reconciliation preserves original cause and records current read refusal", async () => {
  let now = NOW;
  const { store, broker, mutations } = unresolvedPreRunnerCloseFixture({
    sourceSignalId: "cab-signal-302",
    clientOrderId: "vst-legacy-kii-302",
    reconcile: async () => {
      throw new BingXLiveApiError("private timestamp response apiKey=SECRET", {
        httpStatus: 200,
        code: 109400,
        exchangeMessage: "timestamp is invalid",
        endpoint: "/openApi/swap/v2/trade/leverage",
        method: "GET",
      });
    },
  });
  const alerts = [];
  const stderrDiagnostics = [];
  const originalStderrWrite = process.stderr.write;
  process.stderr.write = function (chunk, ...args) {
    const text = String(chunk);
    if (text.includes("Bullet VST diagnostic")) {
      stderrDiagnostics.push(text);
      return true;
    }
    return originalStderrWrite.call(this, chunk, ...args);
  };
  try {
    const worker = createVstWorker({
      store, broker, clock: () => now, sizingLimits: { environment: "vst" },
      onBlocked: async (info) => alerts.push(info),
    });
    await worker.runOnce();
    now += 5 * 60_000;
    await worker.runOnce();
  } finally {
    process.stderr.write = originalStderrWrite;
  }
  const alert = alerts.find((item) => item.reason === "unresolved_vst_order_intents");
  assert.ok(alert);
  assert.equal(alert.recoveryDeferredReason,
    "unresolved_intent_reconciliation_read_failed");
  assert.match(alert.diagnosticRef, /^[a-f0-9]{12}$/);
  assert.equal(alert.originalDiagnostic.code, "109421",
    "current GET refusal does not replace the intent's original 109421 cause");
  assert.equal(alert.originalDiagnostic.endpoint, "/openApi/swap/v2/trade/order");
  const text = formatVstBlockedAlert(alert);
  assert.match(text, /код BingX 109421/);
  assert.match(text, /Исходный запрос: GET \/openApi\/swap\/v2\/trade\/order/);
  assert.match(text, /не удалось выполнить свежие чтения биржи/);
  assert.doesNotMatch(text, /SECRET|private timestamp response|apiKey=/);
  assert.ok(stderrDiagnostics.some((line) =>
    line.includes('"code":"109400"') &&
    line.includes('"endpoint":"/openApi/swap/v2/trade/leverage"')),
  "the separately recorded current reconciliation exception is available in safe logs");
  assert.equal(mutations(), 0, "failed read-only reconciliation performs no exchange mutation");
});

// managePosition (not order-intent reconciliation) is a second, architecturally
// separate place runOnce() can stall the whole pipeline: an open position stuck
// "unknown" (e.g. an exchange/leverage mismatch, or an account/environment
// mismatch) has no order intent behind it at all for most of these reasons, so
// reconcileOutstanding's unresolved-intent tracking never sees it. Without
// counting toward the same blocked-alert incident, such a position could freeze
// the pipeline (no later position managed, no pending signal opened) silently
// forever -- neither this alert nor a per-signal Telegram notification would
// ever fire, no matter how long it persisted.
function stuckPositionFixture(sourceSignalId, symbol = "ETHUSDT") {
  const store = memoryStore(null);
  store.data.positions.push({
    sourceSignalId,
    symbol,
    status: "unknown",
    snapshot: {
      sourceSignalId,
      symbol,
      patternId: "balanced_grind",
      status: "unknown",
      environment: "vst",
      accountId: "vst-account",
    },
  });
  const broker = guardedBroker(store, {});
  return { store, broker };
}

test("a position stuck in management review blocks the pipeline and alerts like a stuck intent", async () => {
  const { store, broker } = stuckPositionFixture("cab-signal-225", "ETHUSDT");
  let now = NOW;
  const alerts = [];
  const worker = createVstWorker({
    store, broker, clock: () => now, sizingLimits: { environment: "vst" },
    onBlocked: async (info) => { alerts.push(info); },
  });

  const first = await worker.runOnce();
  // The tick's own return value is unchanged ("unknown", not "blocked") --
  // only the worker-level alert timer treats it as a blocking incident.
  assert.equal(first.kind, "unknown");
  assert.equal(first.reason, "position_management_unsupported_or_unverified");
  assert.equal(first.sourceSignalId, "cab-signal-225");
  assert.equal(first.symbol, "ETHUSDT");
  assert.equal(alerts.length, 0, "no alert before the threshold");

  now += 4 * 60_000;
  await worker.runOnce();
  assert.equal(alerts.length, 0, "still under the 5-minute threshold");

  now += 2 * 60_000; // 6 minutes of continuous blockage
  const crossing = await worker.runOnce();
  assert.equal(crossing.kind, "unknown");
  assert.equal(alerts.length, 1, "the stuck position crosses the same 5-minute threshold");
  assert.equal(alerts[0].reason, "position_management_unsupported_or_unverified");
  assert.equal(alerts[0].sourceSignalId, "cab-signal-225");
  assert.equal(alerts[0].symbol, "ETHUSDT");
  assert.equal(alerts[0].blockedForMs, 6 * 60_000);

  now += 10 * 60_000; // 16 minutes total; repeat interval (30 min) not yet reached
  await worker.runOnce();
  assert.equal(alerts.length, 1, "no repeat before the 30-minute repeat interval");

  now += 25 * 60_000; // 41 minutes total; long incident earns a second alert
  await worker.runOnce();
  assert.equal(alerts.length, 2, "a long-running stuck position is resurfaced");
});

test("a stuck order intent and a stuck position share one continuous blocked incident", async () => {
  const { store, broker } = stuckIntentFixture("cab-signal-226", "vst-shared-incident-entry");
  let now = NOW;
  const alerts = [];
  const worker = createVstWorker({
    store, broker, clock: () => now, sizingLimits: { environment: "vst" },
    onBlocked: async (info) => { alerts.push(info); },
  });

  await worker.runOnce();
  now += 4 * 60_000; // 4 minutes blocked on the stuck intent
  await worker.runOnce();
  assert.equal(alerts.length, 0, "still under the 5-minute threshold");

  // Resolve the intent but immediately introduce a stuck position -- from the
  // owner's perspective the pipeline has never actually recovered, so the
  // incident clock must not restart from zero.
  store.data.intents.length = 0;
  store.data.positions.push({
    sourceSignalId: "cab-signal-227",
    symbol: "BTCUSDT",
    status: "unknown",
    snapshot: {
      sourceSignalId: "cab-signal-227",
      symbol: "BTCUSDT",
      patternId: "balanced_grind",
      status: "unknown",
      environment: "vst",
      accountId: "vst-account",
    },
  });
  now += 2 * 60_000; // 6 minutes of continuous blockage across both causes
  const crossing = await worker.runOnce();
  assert.equal(crossing.kind, "unknown");
  assert.equal(alerts.length, 1, "the incident crosses the threshold as one continuous span");
  assert.equal(alerts[0].blockedForMs, 6 * 60_000, "elapsed time carries over from the intent stall");
  assert.equal(alerts[0].reason, "position_management_unsupported_or_unverified");
});

test("capability outage preserves pending signal and read-only manages known exposure", async () => {
  const signalBody = activePolicy();
  const store = memoryStore(signalBody);
  const policy = createVstPolicy({
    signal: signalBody,
    fill: { price: 100, quantity: 10, at: new Date(NOW).toISOString() },
  });
  await store.upsertPosition({
    ...policy,
    sourceSignalId: signalBody.sourceSignalId,
    status: "open",
    sizing: { quantity: "10" },
    marginMode: "ISOLATED",
    leverage: 10,
    environment: "vst",
    accountId: "vst-account",
  });
  const position = {
    verified: true,
    symbol: "ETHUSDT",
    positionId: "position-unknown-upgrade-1",
    side: "Buy",
    quantity: 10,
    avgPrice: 100,
    leverage: 10,
    marginMode: "ISOLATED",
    pricePrecision: 2,
    protectiveStops: {
      core: { verified: true, stopPrice: 90, quantity: 10, orderId: "core-stop-1" },
    },
  };
  const readCalls = { accountState: 0, position: 0, marketMark: 0 };
  let mutationCalls = 0;
  const broker = guardedBroker(store, {
    currentPosition: position,
    capabilitiesError: new Error("temporary_capability_read_failure"),
    readCalls,
    onPerform: async () => { mutationCalls += 1; },
  });
  const result = await createVstWorker({
    store, broker, clock: () => NOW, sizingLimits: { environment: "vst" },
  }).runOnce();
  assert.equal(result.kind, "waiting");
  assert.equal(result.reason, "temporary_capability_read_failure");
  assert.equal(store.data.pending.status, "pending");
  assert.equal(store.data.status, "pending");
  assert.deepEqual(readCalls, { accountState: 1, position: 1, marketMark: 1 });
  assert.equal(mutationCalls, 0);
  const saved = store.data.positions[0].snapshot;
  assert.equal(saved.stopPrice, 90);
  assert.equal(saved.remainingQty, 10);
});

test("verified VST capabilities missing a required feature keep the signal nonterminal", async () => {
  const store = memoryStore(signal);
  let mutations = 0;
  const broker = guardedBroker(store, {
    onPerform: async () => { mutations += 1; },
  });
  broker.getCapabilities = async () => ({
    environment: "vst",
    verified: true,
    accountId: "vst-account",
    features: FULL_CAPABILITIES.filter((feature) => feature !== "verified_core_stop_state"),
  });
  const result = await createVstWorker({
    store, broker, clock: () => NOW, sizingLimits: { environment: "vst" },
  }).runOnce();
  assert.equal(result.kind, "waiting");
  assert.match(result.reason, /verified_core_stop_state/);
  assert.equal(store.data.pending.status, "pending");
  assert.equal(store.data.status, "pending");
  assert.equal(store.data.intents.length, 0);
  assert.equal(mutations, 0);
});

test("entry preparation and entry each use separate confirmed worker ticks", async () => {
  const signalBody = activePolicy({ stopLoss: "95" });
  const store = memoryStore(signalBody);
  const mutationPhases = [];
  const broker = guardedBroker(store, {
    onPerform: async ({ phase }) => { mutationPhases.push(phase); },
    reconcile: async ({ request }) => {
      if (request.operation === "set_isolated_leverage") {
        return {
          verified: true,
          status: "filled",
          position: { marginMode: "ISOLATED", leverage: 10 },
        };
      }
      return {
        verified: true,
        status: "filled",
        exchangeOrderId: "entry-order-1",
        fill: {
          price: 100,
          quantity: Number(request.quantity),
          at: new Date(NOW).toISOString(),
        },
        position: {
          verified: true,
          symbol: request.symbol,
          positionId: "position-entry-1",
          side: "Buy",
          quantity: Number(request.quantity),
          avgPrice: 100,
          leverage: 10,
          marginMode: "ISOLATED",
        },
        protectiveStops: {
          core: {
            verified: true, stopPrice: 95, quantity: Number(request.quantity),
            orderId: "entry-stop-1", positionId: "position-entry-1",
          },
        },
      };
    },
  });
  broker.readPlanningInputs = async () => ({
    balanceSnapshot: {
      asset: "VST", balance: "98455.6472", equity: "98455.6472",
      availableMargin: "98455.6472",
    },
    quote: { price: "100", observedAtMs: NOW - 1_000 },
    filters: {
      symbol: "ETH-USDT",
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
  });
  const worker = createVstWorker({
    store,
    broker,
    clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  const firstTick = await worker.runOnce();
  assert.equal(firstTick.kind, "prepared");
  assert.deepEqual(mutationPhases, ["isolated-leverage-10"]);
  assert.equal(store.data.pending.status, "planning");
  const secondTick = await worker.runOnce();
  assert.equal(secondTick.kind, "opened");
  assert.deepEqual(mutationPhases, ["isolated-leverage-10", "market-entry"]);
  assert.equal(store.data.intents.filter((intent) => intent.state === "reconciled").length, 2);
  assert.equal(store.data.positions[0].snapshot.exchangePositionId, "position-entry-1");
  assert.equal(store.data.positions[0].snapshot.coreStopOrderId, "entry-stop-1");
  assert.equal(store.data.positions[0].snapshot.coreStopQuantity,
    Number(store.data.positions[0].snapshot.remainingQty));
});

test("crossed VST margin is durably isolated before LONG10 preparation and entry", async () => {
  const signalBody = activePolicy({ stopLoss: "95" });
  const store = memoryStore(signalBody);
  const operations = [];
  let marginMode = "CROSSED";
  const broker = guardedBroker(store, {
    currentPosition: null,
    originalStopOrderId: "eth-prepared-entry-stop",
    onPerform: async ({ request }) => {
      operations.push(request.operation);
      if (request.operation === "prepare_margin_mode") marginMode = "ISOLATED";
    },
    reconcile: async ({ request }) => {
      if (request.operation === "prepare_margin_mode") {
        return { verified: true, status: "filled", marginMode: "ISOLATED" };
      }
      if (request.operation === "set_isolated_leverage") {
        return {
          verified: true,
          status: "filled",
          position: { marginMode: "ISOLATED", leverage: 10 },
        };
      }
      return {
        verified: true,
        status: "filled",
        exchangeOrderId: "eth-entry-after-preparation",
        fill: {
          price: 100, quantity: Number(request.quantity),
          at: new Date(NOW).toISOString(),
        },
        position: {
          verified: true,
          symbol: request.symbol,
          positionId: "eth-prepared-position",
          side: "Buy",
          quantity: Number(request.quantity),
          avgPrice: 100,
          leverage: 10,
          marginMode: "ISOLATED",
        },
        protectiveStops: {
          core: {
            verified: true,
            stopPrice: 95,
            quantity: Number(request.quantity),
            orderId: "eth-prepared-entry-stop",
            positionId: "eth-prepared-position",
          },
        },
      };
    },
  });
  broker.readPlanningInputs = async () => safePlanningInputs({
    marginMode,
    requiresIsolatedMarginPreparation: marginMode === "CROSSED",
  });
  const worker = createVstWorker({
    store,
    broker,
    clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });

  const marginPrepared = await worker.runOnce();
  assert.deepEqual(marginPrepared, {
    kind: "prepared", reason: "isolated_margin_mode_confirmed",
  });
  assert.deepEqual(operations, ["prepare_margin_mode"]);
  assert.equal(store.data.intents[0].request.operation, "prepare_margin_mode");
  assert.equal(store.data.intents[0].state, "reconciled");
  assert.equal(store.data.pending.status, "planning");

  const leveragePrepared = await worker.runOnce();
  assert.equal(leveragePrepared.kind, "prepared");
  assert.deepEqual(operations, ["prepare_margin_mode", "set_isolated_leverage"]);

  const opened = await worker.runOnce();
  assert.equal(opened.kind, "opened");
  assert.deepEqual(operations, [
    "prepare_margin_mode", "set_isolated_leverage", "entry",
  ]);
  assert.equal(store.data.positions[0].snapshot.symbol, "ETHUSDT");
});

test("invalid or inconsistent margin-mode planning facts fail closed before writes", async () => {
  const invalidStates = [
    {
      marginMode: "CROSSED",
      marginModeVerified: false,
      requiresIsolatedMarginPreparation: false,
    },
    {
      marginMode: "ISOLATED",
      marginModeVerified: false,
      requiresIsolatedMarginPreparation: false,
    },
    {
      marginMode: "ISOLATED",
      marginModeVerified: true,
      requiresIsolatedMarginPreparation: true,
    },
  ];
  for (const [index, state] of invalidStates.entries()) {
    const signalBody = {
      ...activePolicy({ stopLoss: "95" }),
      sourceSignalId: `invalid-margin-state-${index}`,
    };
    const store = memoryStore(signalBody);
    let mutationCalls = 0;
    const broker = guardedBroker(store, {
      currentPosition: null,
      onPerform: async () => { mutationCalls += 1; },
    });
    broker.readPlanningInputs = async () => ({
      ...safePlanningInputs(), ...state,
    });
    const result = await createVstWorker({
      store, broker, clock: () => NOW,
      sizingLimits: { environment: "vst" },
    }).runOnce();

    assert.equal(result.kind, "rejected");
    assert.equal(result.reason, "vst_margin_mode_state_not_verified_or_preparable");
    assert.equal(store.data.intents.length, 0);
    assert.equal(mutationCalls, 0);
  }
});

test("ambiguous margin-mode preparation reconciles after restart without reposting", async () => {
  const signalBody = activePolicy({ stopLoss: "95" });
  const store = memoryStore(signalBody);
  let marginMode = "CROSSED";
  let preparationEvidence = { verified: false, status: "unknown" };
  const operations = [];
  const broker = guardedBroker(store, {
    currentPosition: null,
    onPerform: async ({ request }) => {
      operations.push(request.operation);
      if (request.operation === "prepare_margin_mode") marginMode = "ISOLATED";
    },
    reconcile: async ({ request }) => {
      if (request.operation === "prepare_margin_mode") return preparationEvidence;
      if (request.operation === "set_isolated_leverage") {
        return {
          verified: true,
          status: "filled",
          position: { marginMode: "ISOLATED", leverage: 10 },
        };
      }
      return { verified: false, status: "unknown" };
    },
  });
  broker.readPlanningInputs = async () => safePlanningInputs({
    marginMode,
    requiresIsolatedMarginPreparation: marginMode === "CROSSED",
  });
  const makeWorker = () => createVstWorker({
    store,
    broker,
    clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });

  const worker = makeWorker();
  const ambiguous = await worker.runOnce();
  assert.equal(ambiguous.kind, "unknown");
  const preparationIntent = store.data.intents.find((intent) =>
    intent.request.operation === "prepare_margin_mode");
  assert.equal(preparationIntent.state, "unknown");
  assert.deepEqual(operations, ["prepare_margin_mode"]);

  const stillUnknown = await makeWorker().runOnce();
  assert.equal(stillUnknown.kind, "blocked");
  assert.deepEqual(operations, ["prepare_margin_mode"]);

  preparationEvidence = {
    verified: true, status: "filled", marginMode: "ISOLATED",
  };
  const recovered = await makeWorker().runOnce();
  assert.deepEqual(recovered, {
    kind: "prepared", reason: "isolated_margin_mode_confirmed",
  });
  assert.equal(preparationIntent.state, "reconciled");
  assert.deepEqual(operations, ["prepare_margin_mode"]);

  const leveragePrepared = await makeWorker().runOnce();
  assert.equal(leveragePrepared.kind, "prepared");
  assert.deepEqual(operations, ["prepare_margin_mode", "set_isolated_leverage"]);
});

test("a possibly sent entry stays quarantined even when currently flat past the read timeout", async () => {
  const store = memoryStore(null);
  const clientOrderId = "entry-stuck-1";
  store.data.intents.push({
    sourceSignalId: "cab-signal-entry-stuck",
    phase: "entry",
    clientOrderId,
    request: {
      operation: "entry",
      environment: "vst",
      accountId: "vst-account",
      symbol: "ETHUSDT",
      intentCreatedAt: NOW - 11 * 60 * 1000,
    },
    state: "unknown",
  });
  let submissions = 0;
  const broker = guardedBroker(store, { currentPosition: null,
    onPerform: () => { submissions++; } });
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  const intent = store.data.intents.find((row) => row.clientOrderId === clientOrderId);
  assert.equal(intent.state, "unknown");
  assert.notEqual(intent.detail?.outcome?.reason, "entry_abandoned_confirmed_flat_account");
  assert.notEqual(store.data.status, "error");
  assert.equal(submissions, 0);
});

test("an entry intent with a definite exchange rejection is abandoned quickly, not after the full ambiguous-failure wait", async () => {
  const store = memoryStore(null);
  const clientOrderId = "entry-rejected-1";
  store.data.intents.push({
    sourceSignalId: "cab-signal-entry-rejected",
    phase: "entry",
    clientOrderId,
    request: {
      operation: "entry",
      environment: "vst",
      accountId: "vst-account",
      symbol: "PROMUSDT",
      // Far too recent for the ordinary ENTRY_ABANDON_AFTER_MS (10 minutes),
      // but past the much shorter definite-rejection threshold.
      intentCreatedAt: NOW - 5_000,
    },
    state: "unknown",
    // Mirrors the real store's row shape (outcome is a top-level column --
    // see vst-store.mjs), not the `detail` wrapper markIntent's own second
    // argument happens to be named in this in-memory test double.
    outcome: {
      reason: "entry_intent_requires_reconciliation",
      definiteRejection: true,
      error: "BingXLiveApiError",
      errorMessage: "BingX private request failed (HTTP 200, code 101209, " +
        "msg: The maximum position value for this leverage is 5000 USDT)",
    },
  });
  const broker = guardedBroker(store, { currentPosition: null });
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  const intent = store.data.intents.find((row) => row.clientOrderId === clientOrderId);
  assert.equal(intent.state, "failed");
  assert.equal(intent.detail.outcome.reason, "entry_abandoned_confirmed_flat_account");
  assert.equal(store.data.status, "error");
});

for (const preSignReason of ["final_budget_exceeded", "final_pre_sign_pacing_expired"]) {
test(`a failed verification read preserves no-POST proof: ${preSignReason}`, async () => {
  const store = memoryStore(null);
  const clientOrderId = "entry-no-post-read-unavailable";
  store.data.intents.push({
    sourceSignalId: "cab-signal-no-post",
    phase: "entry",
    clientOrderId,
    request: {
      operation: "entry", environment: "vst", accountId: "vst-account",
      symbol: "PROMUSDT", intentCreatedAt: NOW - 5_000,
    },
    state: "unknown",
    outcome: {
      definiteRejection: true,
      preSignReason,
      error: "BingXLiveApiError",
      errorMessage: "BingX final pre-sign check failed",
    },
  });
  // Mirror the real store's top-level outcome column across markIntent calls.
  const markIntent = store.markIntent.bind(store);
  store.markIntent = async (id, state, detail) => {
    await markIntent(id, state, detail);
    const row = store.data.intents.find((intent) => intent.clientOrderId === id);
    if (detail.outcome) row.outcome = detail.outcome;
  };
  let accountReads = 0;
  const broker = guardedBroker(store, {
    currentPosition: null,
    readAccountStateError: () =>
      accountReads++ === 0 ? new Error("temporary_exchange_read_failure") : null,
  });
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  const intent = store.data.intents.find((row) => row.clientOrderId === clientOrderId);
  assert.equal(intent.state, "unknown");
  assert.equal(intent.outcome.definiteRejection, true);
  assert.equal(intent.outcome.preSignReason, preSignReason);
  await worker.runOnce();
  assert.equal(intent.state, "failed");
  assert.equal(intent.outcome.reason, "entry_abandoned_confirmed_flat_account");
});
}

test("an ambiguous (non-rejected) stuck entry intent still waits the full timeout even when very recent", async () => {
  const store = memoryStore(null);
  const clientOrderId = "entry-ambiguous-1";
  store.data.intents.push({
    sourceSignalId: "cab-signal-entry-ambiguous",
    phase: "entry",
    clientOrderId,
    request: {
      operation: "entry",
      environment: "vst",
      accountId: "vst-account",
      symbol: "PROMUSDT",
      intentCreatedAt: NOW - 5_000,
    },
    state: "unknown",
    detail: { outcome: { reason: "entry_intent_requires_reconciliation" } },
  });
  const broker = guardedBroker(store, { currentPosition: null });
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  const intent = store.data.intents.find((row) => row.clientOrderId === clientOrderId);
  assert.equal(intent.state, "unknown");
});

test("an open but unattributed entry is isolated without fabricated fills or automatic manual-review abandonment", async () => {
  const store = memoryStore(null);
  const clientOrderId = "entry-stuck-open-1";
  // Mirrors a real incident: the fill genuinely happened (account is not
  // flat), but the margin top-up that must follow every entry failed and
  // took the protective stop down with it, so orderEvidence's exact
  // stop-match requirement cannot currently verify. A finite read budget
  // cannot turn the current average into an attributed fill or authorize
  // a repeat submission. Isolation is symbol-scoped, not account-wide.
  store.data.intents.push({
    sourceSignalId: "cab-signal-entry-stuck-open",
    phase: "entry",
    clientOrderId,
    request: {
      operation: "entry",
      environment: "vst",
      accountId: "vst-account",
      symbol: "ONDOUSDT",
      quantity: "18879.3",
      stopLoss: "0.4681",
      marginMode: "ISOLATED",
      signal: {
        patternId: "liquidation_cascade",
        signalAt: new Date(NOW - 20 * 60 * 1000).toISOString(),
      },
      sizing: { quantity: "18879.3", initialMarginVst: "981.5" },
      intentCreatedAt: NOW - 11 * 60 * 1000,
    },
    state: "unknown",
  });
  let submissions = 0;
  const broker = guardedBroker(store, {
    onPerform: () => { submissions++; },
    currentPosition: { symbol: "ONDOUSDT", quantity: "18879.3", avgPrice: "0.5203" },
    openOrders: [],
  });
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  const intent = store.data.intents.find((row) => row.clientOrderId === clientOrderId);
  assert.equal(intent.state, "unknown");
  assert.notEqual(intent.detail?.outcome?.reason,
    "entry_verification_abandoned_confirmed_open_unprotected");
  assert.notEqual(store.data.status, "error");
  const position = store.data.positions.find((row) =>
    row.sourceSignalId === "cab-signal-entry-stuck-open");
  assert.equal(position, undefined, "a live average is not an attributed fill");
  assert.equal(submissions, 0);
});

test("only an exact raise_stop entry-proof refusal can settle after fresh exact old-stop proof", async () => {
  const makeCase = ({
    accountPositions,
    openOrders,
    operation = "raise_stop",
    phaseOverride = null,
    requestChanges = {},
    duringEntryProof = () => {},
    entryProofResult = null,
    afterAccountRead = () => {},
    clock = () => NOW,
    actualLegacy = false,
    entryAgeMs = null,
    intentState = "unknown",
    exchangeOrderId = null,
    closedVerifiedFill = false,
    outcome = {
      error: "Error",
      errorMessage: "bingx_vst_entry_history_fills_unverified",
    },
  }) => {
    const store = memoryStore(null);
    const phase = phaseOverride ?? `raise_stop-core-${NOW - 5_000}`;
    const sourceSignalId = actualLegacy
      ? "cab-signal-15958" : "raise-stop-entry-proof-refusal-signal";
    const clientOrderId = `vst-${createHash("sha256")
      .update(`${sourceSignalId}:${phase}`).digest("hex").slice(0, 30)}`;
    const quantity = actualLegacy ? "18850.91" : "1";
    const entryIntent = {
      sourceSignalId,
      phase: "market-entry",
      clientOrderId: "raise-stop-entry-client",
      state: "reconciled",
      exchangeOrderId: "raise-stop-entry-order",
      request: {
        operation: "entry",
        environment: "vst",
        accountId: "vst-account",
        symbol: "ETHUSDT",
        entryOrderType: actualLegacy ? "MARKET" : "LIMIT",
        quantity,
        intentCreatedAt: NOW - (entryAgeMs ?? 10_000),
      },
      outcome: {
        verified: true,
        status: "filled",
        positionId: "raise-stop-position",
        fillQuantity: quantity,
      },
    };
    const positionSnapshot = {
      sourceSignalId,
      status: "open",
      environment: "vst",
      accountId: "vst-account",
      symbol: "ETHUSDT",
      exchangePositionId: "raise-stop-position",
      entryClientOrderId: entryIntent.clientOrderId,
      remainingQty: quantity,
      ...(entryAgeMs === null ? {} : {
        entryAt: new Date(NOW - entryAgeMs + 1_000).toISOString(),
      }),
      verifiedProtectiveStops: {
        core: {
          verified: true,
          orderId: "raise-stop-old-order",
          positionId: "raise-stop-position",
          quantity,
          stopPrice: actualLegacy ? "0.4408" : "90",
        },
      },
      ...(actualLegacy
        ? { peakPct: 0.52, observedAt: new Date(NOW - 1_000).toISOString() }
        : {}),
    };
    const request = {
      operation,
      environment: "vst",
      accountId: "vst-account",
      sourceSignalId,
      symbol: "ETHUSDT",
      intentCreatedAt: NOW - 1_000,
      entryClientOrderId: entryIntent.clientOrderId,
      leg: "core",
      quantity,
      previousQuantity: quantity,
      stopPrice: actualLegacy ? "0.4915" : "101",
      nextPosition: {
        ...structuredClone(positionSnapshot),
        exchangePositionId: "raise-stop-position",
        ...(actualLegacy ? { stopPrice: "0.4915" } : {}),
      },
      ...(closedVerifiedFill
        ? { priorPosition: structuredClone(positionSnapshot) } : {}),
      ...requestChanges,
    };
    store.data.intents.push(entryIntent);
    store.data.intents.push({
      sourceSignalId,
      phase,
      clientOrderId,
      request,
      state: intentState,
      exchangeOrderId,
      outcome,
    });
    store.data.positions.push({
      sourceSignalId,
      symbol: "ETHUSDT",
      status: "open",
      snapshot: positionSnapshot,
      updatedAt: "2026-10-02 00:00:00+00",
    });
    store.listOpenPositions = async () =>
      store.data.positions.map((row) => structuredClone(row));
    store.getPosition = async () => structuredClone(store.data.positions[0]);
    store.recoverRaiseStopPreUpgradeRefusal = async (input) => {
      const intent = store.data.intents.find((row) =>
        row.clientOrderId === input.clientOrderId);
      if (!intent || intent.state !== "unknown" ||
          intent.request !== input.expectedRequest ||
          intent.outcome !== input.expectedOutcome ||
          store.data.positions[0].updatedAt !== input.expectedPositionUpdatedAt ||
          JSON.stringify(store.data.positions[0].snapshot) !==
            JSON.stringify(input.expectedPositionSnapshot)) {
        return { kind: "ineligible", reason: "position_changed" };
      }
      intent.state = "failed";
      intent.detail = { outcome: {
        reason: "raise_stop_entry_proof_refused_before_upgrade",
        noWriteConfirmed: true,
        oldPositionAndStop: input.oldPositionAndStop,
      } };
      store.data.status = "open";
      store.data.positions[0].status = "open";
      store.data.events.push(["event", input]);
      return { kind: "recovered" };
    };
    let capturedClosedSettlementInput = null;
    if (closedVerifiedFill) {
      const closePhase = `triggered-stop-${createHash("sha256")
        .update("raise-stop-old-order").digest("hex").slice(0, 24)}`;
      const fill = {
        price: "89.9",
        quantity,
        at: new Date(NOW - 100).toISOString(),
        orderId: "raise-stop-closed-child",
        triggerOrderId: "raise-stop-old-order",
        fee: { asset: "USDT", amount: "0.001" },
        fees: { asset: "USDT", amount: "0.001" },
        feeEvidenceAvailable: true,
        exchangeOrderId: "raise-stop-closed-child",
      };
      positionSnapshot.status = "closed";
      positionSnapshot.remainingQty = 0;
      positionSnapshot.coreOpen = false;
      positionSnapshot.coreQty = 0;
      positionSnapshot.lastCloseFill = structuredClone(fill);
      positionSnapshot.triggeredStop = {
        parentStopId: "raise-stop-old-order",
        parentStopPrice: "90",
        childOrderId: fill.orderId,
      };
      store.data.positions[0].status = "closed";
      store.data.status = "closed";
      store.data.intents.push({
        sourceSignalId,
        phase: closePhase,
        clientOrderId: `vst-${createHash("sha256")
          .update(`${sourceSignalId}:${closePhase}`).digest("hex").slice(0, 30)}`,
        request: {
          operation: "observe_triggered_stop",
          environment: "vst",
          accountId: "vst-account",
          symbol: "ETHUSDT",
          positionId: "raise-stop-position",
          stopOrderId: "raise-stop-old-order",
          stopQuantity: quantity,
          stopPrice: "90",
        },
        state: "reconciled",
        exchangeOrderId: fill.orderId,
        outcome: {
          verified: true,
          status: "filled",
          operation: "observe_triggered_stop",
          parentStopId: "raise-stop-old-order",
          parentStopPrice: "90",
          childOrderId: fill.orderId,
          fill: structuredClone(fill),
          residualPosition: {
            verified: true, positionId: "raise-stop-position", quantity: 0,
          },
          openStops: [],
        },
      });
      store.settleRaiseStopRefusalAfterVerifiedClose = async (input) => {
        capturedClosedSettlementInput = input;
        const target = store.data.intents.find((row) =>
          row.clientOrderId === input.clientOrderId);
        if (!target || target.state !== "unknown" ||
            target.request !== input.expectedRequest ||
            target.outcome !== input.expectedOutcome ||
            store.data.positions[0].status !== "closed" ||
            JSON.stringify(store.data.positions[0].snapshot) !==
              JSON.stringify(input.expectedPositionSnapshot) ||
            input.closeIntent.phase !== closePhase) {
          return { kind: "ineligible", reason: "position_changed" };
        }
        target.state = "failed";
        store.data.events.push(["closed-stop-refusal-settled", input]);
        return { kind: "recovered" };
      };
    }
    let reconciles = 0;
    const broker = guardedBroker(store, {
      reconcile: async () => {
        reconciles += 1;
        return { verified: false, status: "unknown" };
      },
    });
    broker.readAccountState = async () => {
      const result = {
        verified: true,
        environment: "vst",
        accountId: "vst-account",
        positions: accountPositions,
        openOrders,
      };
      afterAccountRead();
      return result;
    };
    broker.verifyEntryOrderProof = async ({
      expectedPositionId, expectedOrderId, expectedQuantity,
    }) => {
      duringEntryProof();
      return entryProofResult ?? {
        verified: true,
        status: "filled",
        positionId: expectedPositionId,
        exchangeOrderId: expectedOrderId,
        fill: { quantity: expectedQuantity },
      };
    };
    let writes = 0;
    broker.performIntent = async () => { writes += 1; };
    const worker = createVstWorker({
      store,
      broker,
      clock,
      sizingLimits: {
        environment: "vst", maxQuoteAgeMs: 10_000,
        maxPriceMoveBps: 500, maxSlippageBps: 100,
      },
    });
    return {
      store, broker, worker, clientOrderId,
      getWrites: () => writes,
      getReconciles: () => reconciles,
      getClosedSettlementInput: () => capturedClosedSettlementInput,
    };
  };
  const makeClosedSettlementPg = (input) => {
    const state = {
      signalStatus: "closed",
      positionStatus: "closed",
      positionSnapshot: structuredClone(input.expectedPositionSnapshot),
      positionUpdatedAt: input.expectedPositionUpdatedAt,
      intents: [
        {
          source_signal_id: input.sourceSignalId,
          phase: input.phase,
          client_order_id: input.clientOrderId,
          request: structuredClone(input.expectedRequest),
          state: "unknown",
          exchange_order_id: null,
          outcome: structuredClone(input.expectedOutcome),
        },
        {
          source_signal_id: input.closeIntent.sourceSignalId,
          phase: input.closeIntent.phase,
          client_order_id: input.closeIntent.clientOrderId,
          request: structuredClone(input.closeIntent.request),
          state: input.closeIntent.state,
          exchange_order_id: input.closeIntent.exchangeOrderId,
          outcome: structuredClone(input.closeIntent.outcome),
        },
      ],
      events: [],
    };
    const matchesJson = (value, serialized) => {
      try {
        assert.deepEqual(value, JSON.parse(serialized));
        return true;
      } catch {
        return false;
      }
    };
    let transactionSnapshot = null;
    const restore = (value) => {
      state.signalStatus = value.signalStatus;
      state.positionStatus = value.positionStatus;
      state.positionSnapshot = value.positionSnapshot;
      state.positionUpdatedAt = value.positionUpdatedAt;
      state.intents = value.intents;
      state.events = value.events;
    };
    const client = {
      async query(sql, params = []) {
        const normalized = sql.trim();
        if (normalized === "BEGIN") {
          transactionSnapshot = structuredClone(state);
          return { rowCount: 0, rows: [] };
        }
        if (normalized === "COMMIT") {
          transactionSnapshot = null;
          return { rowCount: 0, rows: [] };
        }
        if (normalized === "ROLLBACK") {
          if (transactionSnapshot) restore(transactionSnapshot);
          transactionSnapshot = null;
          return { rowCount: 0, rows: [] };
        }
        if (normalized === INTENT_SERIALIZATION_LOCK_SQL) {
          return { rowCount: 1, rows: [{ pg_advisory_xact_lock: null }] };
        }
        if (normalized.includes("FROM vst_signals") && normalized.includes("FOR UPDATE")) {
          return {
            rowCount: 1,
            rows: [{ source_signal_id: input.sourceSignalId, status: state.signalStatus }],
          };
        }
        if (normalized.includes("FROM vst_positions") && normalized.includes("FOR UPDATE")) {
          return {
            rowCount: 1,
            rows: [{
              source_signal_id: input.sourceSignalId,
              symbol: input.expectedPositionSnapshot.symbol,
              status: state.positionStatus,
              snapshot: structuredClone(state.positionSnapshot),
              updated_at_text: state.positionUpdatedAt,
            }],
          };
        }
        if (normalized.includes("FROM vst_order_intents") &&
            normalized.includes("client_order_id = $2 FOR UPDATE")) {
          const row = state.intents.find((intent) =>
            intent.client_order_id === params[1]);
          return { rowCount: row ? 1 : 0, rows: row ? [structuredClone(row)] : [] };
        }
        if (normalized.includes("FROM vst_order_intents") &&
            normalized.includes("phase = $2 FOR UPDATE")) {
          const row = state.intents.find((intent) =>
            intent.source_signal_id === params[0] && intent.phase === params[1]);
          return { rowCount: row ? 1 : 0, rows: row ? [structuredClone(row)] : [] };
        }
        if (normalized.startsWith("UPDATE vst_order_intents")) {
          const row = state.intents.find((intent) =>
            intent.source_signal_id === params[0] &&
            intent.client_order_id === params[1]);
          if (!row || row.state !== "unknown" || row.exchange_order_id !== null ||
              !matchesJson(row.request, params[3]) ||
              !matchesJson(row.outcome, params[4])) {
            return { rowCount: 0, rows: [] };
          }
          row.state = "failed";
          return { rowCount: 1, rows: [{ client_order_id: row.client_order_id }] };
        }
        if (normalized.startsWith("INSERT INTO vst_events")) {
          state.events.push({
            source_signal_id: params[0],
            client_order_id: params[1],
            kind: "vst_raise_stop_pre_upgrade_refusal_confirmed",
            detail: JSON.parse(params[2]),
          });
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`Unexpected query in closedSettlementPg: ${normalized}`);
      },
      release() {},
    };
    return {
      state,
      async connect() { return client; },
      async query() { throw new Error("closed settlement must use a transaction"); },
    };
  };
  const oldPosition = {
    symbol: "ETH-USDT",
    positionSide: "LONG",
    positionAmt: "1",
    positionId: "raise-stop-position",
  };
  const oldStop = {
    symbol: "ETH-USDT",
    orderId: "raise-stop-old-order",
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    workingType: "MARK_PRICE",
    positionId: "raise-stop-position",
    origQty: "1",
    executedQty: "0.000",
    stopPrice: "90",
  };
  for (const outcome of [
    {
      error: "Error",
      errorMessage: "bingx_vst_entry_history_fills_unverified",
    },
    {
      error: "Error",
      preSignReason:
        "bingx_vst_raise_stop_entry_fill_proof_refused_before_upgrade",
      errorMessage:
        "bingx_vst_entry_history_fills_unverified " +
        "(bingx_vst_raise_stop_entry_fill_proof_refused_before_upgrade)",
    },
    {
      reason: "exchange_state_not_verified",
      submissionError: "Error",
      submissionErrorMessage:
        "bingx_vst_entry_history_fills_unverified " +
        "(bingx_vst_raise_stop_entry_fill_proof_refused_before_upgrade)",
      preSignReason:
        "bingx_vst_raise_stop_entry_fill_proof_refused_before_upgrade",
    },
  ]) {
    const { store, worker, clientOrderId, getWrites, getReconciles } = makeCase({
      accountPositions: [oldPosition], openOrders: [oldStop], outcome,
    });
    const result = await worker.runOnce();
    assert.deepEqual(result, {
      kind: "reconciled",
      reason: "raise_stop_entry_proof_refusal_recovered",
    });
    const intent = store.data.intents.find((row) => row.clientOrderId === clientOrderId);
    assert.equal(intent.state, "failed");
    assert.equal(intent.detail.outcome.reason,
      "raise_stop_entry_proof_refused_before_upgrade");
    assert.equal(intent.detail.outcome.noWriteConfirmed, true);
    assert.equal(intent.detail.outcome.oldPositionAndStop.positionId,
      "raise-stop-position");
    assert.equal(store.data.status, "open");
    assert.equal(getWrites(), 0);
    assert.equal(getReconciles(), 0);
  }
  for (const { age, recovered } of [
    { age: 44 * 60 * 60_000, recovered: true },
    { age: 7 * 24 * 60 * 60_000 + 1_000, recovered: false },
    { age: -10_000, recovered: false },
  ]) {
    const delayed = makeCase({
      accountPositions: [oldPosition], openOrders: [oldStop],
      entryAgeMs: age,
    });
    await delayed.worker.runOnce();
    const intent = delayed.store.data.intents.find((row) =>
      row.clientOrderId === delayed.clientOrderId);
    assert.equal(intent.state, recovered ? "failed" : "unknown",
      "entry age uses native retention, not the maximum duration of one query");
    assert.equal(delayed.getWrites(), 0,
      "historical read proof never replays the original stop mutation");
    assert.equal(delayed.getReconciles(), 0);
  }
  {
    const outcome = {
      error: "Error",
      preSignReason:
        "bingx_vst_raise_stop_entry_fill_proof_refused_before_upgrade",
      errorMessage:
        "bingx_vst_entry_history_fills_unverified " +
        "(bingx_vst_raise_stop_entry_fill_proof_refused_before_upgrade)",
    };
    const alreadyClosed = makeCase({
      accountPositions: [],
      openOrders: [],
      closedVerifiedFill: true,
      outcome,
    });
    const result = await alreadyClosed.worker.runOnce();
    assert.deepEqual(result, {
      kind: "reconciled",
      reason: "raise_stop_refusal_settled_after_committed_close",
    });
    const retired = alreadyClosed.store.data.intents.find((row) =>
      row.clientOrderId === alreadyClosed.clientOrderId);
    assert.equal(retired.state, "failed");
    assert.deepEqual(retired.outcome, outcome,
      "verified close settlement preserves the original refusal outcome");
    assert.equal(alreadyClosed.store.data.status, "closed");
    assert.equal(alreadyClosed.getWrites(), 0);
    assert.equal(alreadyClosed.getReconciles(), 0);
    const realPool = makeClosedSettlementPg(
      alreadyClosed.getClosedSettlementInput(),
    );
    const realStore = createVstStore(realPool);
    assert.deepEqual(
      await realStore.settleRaiseStopRefusalAfterVerifiedClose(
        alreadyClosed.getClosedSettlementInput(),
      ),
      { kind: "recovered" },
    );
    assert.equal(realPool.state.signalStatus, "closed");
    assert.equal(realPool.state.positionStatus, "closed");
    assert.equal(realPool.state.intents[0].state, "failed");
    assert.equal(realPool.state.intents[0].exchange_order_id, null);
    assert.equal(realPool.state.events.length, 1);
    assert.deepEqual(
      await realStore.settleRaiseStopRefusalAfterVerifiedClose(
        alreadyClosed.getClosedSettlementInput(),
      ),
      { kind: "replayed" },
    );
    assert.equal(realPool.state.events.length, 1,
      "the actual store close-settlement replay does not duplicate its event");
  }
  {
    const flatOnly = makeCase({
      accountPositions: [],
      openOrders: [],
      outcome: {
        error: "Error",
        preSignReason:
          "bingx_vst_raise_stop_entry_fill_proof_refused_before_upgrade",
        errorMessage:
          "bingx_vst_entry_history_fills_unverified " +
          "(bingx_vst_raise_stop_entry_fill_proof_refused_before_upgrade)",
      },
    });
    const record = flatOnly.store.data.positions[0];
    record.status = "closed";
    record.snapshot.status = "closed";
    record.snapshot.remainingQty = 0;
    flatOnly.store.data.status = "closed";
    await flatOnly.worker.runOnce();
    assert.equal(flatOnly.store.data.intents.find((row) =>
      row.clientOrderId === flatOnly.clientOrderId).state, "unknown",
    "flatness without a committed child-fill intent is not close proof");
    assert.equal(flatOnly.getWrites(), 0);
    assert.equal(flatOnly.getReconciles(), 0);
  }
  {
    const unlinkedClose = makeCase({
      accountPositions: [],
      openOrders: [],
      closedVerifiedFill: true,
      outcome: {
        error: "Error",
        preSignReason:
          "bingx_vst_raise_stop_entry_fill_proof_refused_before_upgrade",
        errorMessage:
          "bingx_vst_entry_history_fills_unverified " +
          "(bingx_vst_raise_stop_entry_fill_proof_refused_before_upgrade)",
      },
    });
    const closeIntent = unlinkedClose.store.data.intents.find((row) =>
      row.request?.operation === "observe_triggered_stop");
    closeIntent.outcome.fill.triggerOrderId = "another-stop";
    await unlinkedClose.worker.runOnce();
    assert.equal(unlinkedClose.store.data.intents.find((row) =>
      row.clientOrderId === unlinkedClose.clientOrderId).state, "unknown",
    "a closed snapshot with an unlinked child fill remains unresolved");
    assert.equal(unlinkedClose.store.data.events.some(([name]) =>
      name === "closed-stop-refusal-settled"), false);
    assert.equal(unlinkedClose.getWrites(), 0);
  }
  {
    let proofClock = NOW;
    const actualPosition = {
      symbol: "ETH-USDT",
      positionSide: "LONG",
      positionAmt: "18850.91",
      positionId: "raise-stop-position",
    };
    const actualOldStop = {
      symbol: "ETH-USDT",
      orderId: "raise-stop-old-order",
      mainOrderId: "",
      type: "STOP_MARKET",
      status: "NEW",
      side: "SELL",
      positionSide: "LONG",
      workingType: "MARK_PRICE",
      positionId: "raise-stop-position",
      origQty: "18850.91",
      executedQty: "0.000",
      stopPrice: "0.4408",
    };
    const actualOutcome = {
      reason: "exchange_state_not_verified",
      submissionError: "Error",
      submissionErrorMessage: "bingx_vst_entry_history_fills_unverified",
    };
    const { store, worker, clientOrderId, getWrites, getReconciles } = makeCase({
      accountPositions: [actualPosition],
      openOrders: [actualOldStop],
      actualLegacy: true, outcome: actualOutcome,
      phaseOverride: "raise_stop-core-1790838521907",
      clock: () => proofClock,
      duringEntryProof: () => { proofClock += 6_000; },
    });
    const originalIntent = structuredClone(store.data.intents[1]);
    await worker.runOnce();
    const intent = store.data.intents.find((row) => row.clientOrderId === clientOrderId);
    assert.equal(intent.state, "failed",
      "actual normalized legacy outcome remains eligible for narrow recovery");
    assert.deepEqual(intent.detail.outcome.oldPositionAndStop, {
      positionId: "raise-stop-position", quantity: "18850.91",
      stopOrderId: "raise-stop-old-order", stopPrice: "0.4408",
      executionProof: {
        orderId: "raise-stop-old-order", executedQty: "0.000",
      },
    });
    assert.deepEqual(intent.request, originalIntent.request);
    assert.deepEqual(intent.outcome, originalIntent.outcome);
    assert.equal(store.data.positions[0].snapshot.verifiedProtectiveStops.core.stopPrice,
      "0.4408", "the proposed policy is never applied during refusal recovery");
    assert.equal(getWrites(), 0);
    assert.equal(getReconciles(), 0);
  }
  const entryProofUnavailable = makeCase({
    accountPositions: [oldPosition],
    openOrders: [oldStop],
    outcome: {
      error: "Error",
      preSignReason:
        "bingx_vst_raise_stop_entry_fill_proof_refused_before_upgrade",
      errorMessage:
        "bingx_vst_entry_history_fills_unverified " +
        "(bingx_vst_raise_stop_entry_fill_proof_refused_before_upgrade)",
    },
    entryProofResult: { verified: false, status: "unknown" },
  });
  const originalMarker = structuredClone(entryProofUnavailable.store.data.intents[1].outcome);
  await entryProofUnavailable.worker.runOnce();
  assert.equal(entryProofUnavailable.store.data.intents[1].state, "unknown");
  assert.deepEqual(entryProofUnavailable.store.data.intents[1].outcome, originalMarker);
  assert.equal(entryProofUnavailable.getWrites(), 0);
  assert.equal(entryProofUnavailable.getReconciles(), 0);

  {
    let clockNow = NOW;
    const deferred = [];
    const originalUpdatedAt = "2026-10-02 00:00:00+00";
    const actualPosition = {
      symbol: "ETH-USDT",
      positionSide: "LONG",
      positionAmt: "18850.91",
      positionId: "raise-stop-position",
    };
    const actualOldStop = {
      symbol: "ETH-USDT",
      orderId: "raise-stop-old-order",
      mainOrderId: "",
      type: "STOP_MARKET",
      status: "NEW",
      side: "SELL",
      positionSide: "LONG",
      workingType: "MARK_PRICE",
      positionId: "raise-stop-position",
      origQty: "18850.91",
      executedQty: "0.000",
      stopPrice: "0.4408",
    };
    let mutationsRemaining = 2;
    const incident = makeCase({
      accountPositions: [actualPosition],
      openOrders: [actualOldStop],
      actualLegacy: true,
      outcome: {
        reason: "exchange_state_not_verified",
        submissionError: "Error",
        submissionErrorMessage: "bingx_vst_entry_history_fills_unverified",
      },
      phaseOverride: "raise_stop-core-1790838521907",
      clock: () => clockNow,
      duringEntryProof: () => {
        if (mutationsRemaining <= 0) return;
        mutationsRemaining -= 1;
        const row = incident?.store.data.positions[0];
        if (row) {
          row.snapshot.peakPct = mutationsRemaining === 1 ? 0.61 : 0.63;
          row.snapshot.observedAt = new Date(NOW + 1_000 +
            (1 - mutationsRemaining) * 1_000).toISOString();
          row.updatedAt = mutationsRemaining === 1
            ? "2026-10-02 00:00:01+00"
            : "2026-10-02 00:00:02+00";
        }
      },
    });
    incident.store.data.positions[0].updatedAt = originalUpdatedAt;
    incident.worker = createVstWorker({
      store: incident.store,
      broker: incident.broker,
      clock: () => clockNow,
      onBlocked: async (detail) => deferred.push(detail),
      sizingLimits: {
        environment: "vst", maxQuoteAgeMs: 10_000,
        maxPriceMoveBps: 500, maxSlippageBps: 100,
      },
    });
    // This synthetic legacy position lacks the policy/exchange-position
    // fields needed by normal management. Keep this case focused on the
    // reconciliation CAS so the unrelated manager cannot mark the position
    // unknown between the deliberately racing CAS attempts.
    incident.store.listOpenPositions = async () => [];
    await incident.worker.runOnce();
    assert.equal(incident.store.data.intents[1].state, "unknown",
      "a position mutation while waiting for proof fails the store CAS");
    assert.equal(incident.store.data.positions[0].snapshot.peakPct, 0.61);
    clockNow += 5 * 60_000 + 1;
    await incident.worker.runOnce();
    assert.equal(incident.store.data.intents[1].state, "unknown",
      "a second concurrent management update remains fail-closed");
    assert.ok(deferred.some((detail) =>
      detail.recoveryDeferredReason ===
        "raise_stop_recovery_compare_and_set_changed"),
    "the deferred CAS reason is surfaced without provider text");
    await incident.worker.runOnce();
    assert.equal(incident.store.data.intents[1].state, "failed",
      "the next pass re-reads the updated persisted snapshot and can settle");
    assert.equal(incident.store.data.positions[0].snapshot.peakPct, 0.63);
    assert.equal(incident.store.data.positions[0].snapshot.verifiedProtectiveStops.core.stopPrice,
      "0.4408");
  }

  const normalizedHistoricalOutcome = {
    reason: "exchange_state_not_verified",
    submissionError: "Error",
    submissionErrorMessage: "bingx_vst_entry_history_fills_unverified",
  };
  const refusalLookalikes = [
    {
      label: "adapter error with the same literal",
      outcome: {
        error: "BingXLiveApiError",
        errorMessage: "bingx_vst_entry_history_fills_unverified",
      },
    },
    {
      label: "same literal with unexpected error metadata",
      outcome: {
        error: "Error",
        errorMessage: "bingx_vst_entry_history_fills_unverified",
        exchangeCode: 109400,
      },
    },
    {
      label: "legacy-shaped error from a new proof-bearing request",
      outcome: {
        error: "Error",
        errorMessage: "bingx_vst_entry_history_fills_unverified",
      },
      requestChanges: { entryProof: { entryOrderId: "raise-stop-entry-order" } },
    },
    {
      label: "known refusal with noncanonical phase",
      phaseOverride: "raise_stop-core",
    },
    {
      label: "normalized refusal with unexpected marker",
      outcome: {
        ...normalizedHistoricalOutcome, definiteRejection: true,
      },
    },
    {
      label: "normalized refusal with conflicting outcome reason",
      outcome: {
        ...normalizedHistoricalOutcome, reason: "action_fill_unconfirmed",
      },
    },
    {
      label: "normalized refusal with adapter error name",
      outcome: {
        ...normalizedHistoricalOutcome, submissionError: "BingXLiveApiError",
      },
    },
    {
      label: "normalized refusal with exchange-order evidence",
      exchangeOrderId: "already-submitted-order",
    },
    {
      label: "normalized refusal with conflicting intent state",
      intentState: "submitted",
    },
    {
      label: "normalized refusal for another operation",
      operation: "close_leg",
    },
    {
      label: "known refusal with stale entry time",
      requestChanges: { entryAt: NOW - 25 * 60 * 60_000 },
      expectedReconciles: 0,
    },
  ];
  for (const scenario of refusalLookalikes) {
    const { store, worker, clientOrderId, getWrites, getReconciles } = makeCase({
      accountPositions: [oldPosition], openOrders: [oldStop], ...scenario,
    });
    await worker.runOnce();
    const intent = store.data.intents.find((row) => row.clientOrderId === clientOrderId);
    assert.equal(intent.state, "unknown", scenario.label);
    assert.equal(getWrites(), 0, scenario.label);
    assert.equal(getReconciles(), scenario.expectedReconciles ?? 1, scenario.label);
  }

  for (const mutation of [
    {
      label: "old stop triggers during entry verification",
      mutate: (_positions, orders) => { orders[0].status = "TRIGGERED"; },
    },
    {
      label: "old stop is replaced during entry verification",
      mutate: (_positions, orders) => {
        orders.splice(0, 1, { ...orders[0], orderId: "replacement-stop" });
      },
    },
  ]) {
    const positions = [oldPosition];
    const orders = [{ ...oldStop }];
    const { store, worker, clientOrderId, getWrites, getReconciles } = makeCase({
      accountPositions: positions,
      openOrders: orders,
      duringEntryProof: () => mutation.mutate(positions, orders),
    });
    await worker.runOnce();
    assert.equal(store.data.intents.find((row) =>
      row.clientOrderId === clientOrderId).state, "unknown", mutation.label);
    assert.equal(getWrites(), 0, mutation.label);
    assert.equal(getReconciles(), 0, mutation.label);
  }
  // Actual globally paced position/order reads took 2660ms in a GET-only
  // VST probe. This is not a cached observation or an exchange-write permit.
  {
    let currentTime = NOW;
    const { store, worker, clientOrderId, getWrites } = makeCase({
      accountPositions: [oldPosition],
      openOrders: [oldStop],
      clock: () => currentTime,
      afterAccountRead: () => { currentTime += 2_660; },
    });
    await worker.runOnce();
    assert.equal(store.data.intents.find((row) =>
      row.clientOrderId === clientOrderId).state, "failed");
    assert.equal(getWrites(), 0);
  }
  for (const delta of [5_001, 30_001, -1]) {
    let currentTime = NOW;
    const { store, worker, clientOrderId, getWrites } = makeCase({
      accountPositions: [oldPosition],
      openOrders: [oldStop],
      clock: () => currentTime,
      afterAccountRead: () => { currentTime += delta; },
    });
    await worker.runOnce();
    assert.equal(store.data.intents.find((row) =>
      row.clientOrderId === clientOrderId).state, "unknown");
    assert.equal(getWrites(), 0);
  }

  const rejectedProofs = [
    {
      label: "stale quantity",
      positions: [{ ...oldPosition, positionAmt: "0.9" }],
      orders: [oldStop],
    },
    {
      label: "extra order",
      positions: [oldPosition],
      orders: [oldStop, { ...oldStop, orderId: "unrelated-stop" }],
    },
    {
      label: "unattributable extra order",
      positions: [oldPosition],
      orders: [oldStop, { orderId: "unknown-symbol-order" }],
    },
    {
      label: "target/new stop already present",
      positions: [oldPosition],
      orders: [{ ...oldStop, stopPrice: "101" }],
    },
    {
      label: "wrong position identity",
      positions: [{ ...oldPosition, positionId: "replacement-position" }],
      orders: [oldStop],
    },
    {
      label: "contradictory parent identity",
      positions: [oldPosition],
      orders: [{ ...oldStop, parentOrderID: "wrong-entry-order" }],
    },
    {
      label: "contradictory stop quantities",
      positions: [oldPosition],
      orders: [{ ...oldStop, quantity: "0.9" }],
    },
    {
      label: "old stop has executed quantity",
      positions: [oldPosition],
      orders: [{ ...oldStop, executedQty: "0.1" }],
    },
    {
      label: "old stop omits explicit executed quantity",
      positions: [oldPosition],
      orders: [{ ...oldStop, executedQty: undefined }],
    },
    {
      label: "old stop has malformed execution alias",
      positions: [oldPosition],
      orders: [{ ...oldStop, cumExecQty: "unknown" }],
    },
  ];
  for (const scenario of rejectedProofs) {
    const { store, worker, clientOrderId, getWrites, getReconciles } = makeCase({
      accountPositions: scenario.positions,
      openOrders: scenario.orders,
    });
    await worker.runOnce();
    const intent = store.data.intents.find((row) => row.clientOrderId === clientOrderId);
    assert.equal(intent.state, "unknown", scenario.label);
    assert.equal(getWrites(), 0, scenario.label);
    assert.equal(getReconciles(), 0, scenario.label);
  }
  const wrongOperation = makeCase({
    accountPositions: [oldPosition],
    openOrders: [oldStop],
    operation: "close_leg",
  });
  await wrongOperation.worker.runOnce();
  assert.equal(wrongOperation.store.data.intents.find((row) =>
    row.clientOrderId === wrongOperation.clientOrderId).state, "unknown");
  assert.equal(wrongOperation.getWrites(), 0);
});

test("AKT exact legacy pre-DELETE refusal requires explicit zero execution on every stop", async () => {
  const sourceSignalId = "cab-signal-akt-original-stop";
  const positionId = "2105617358220427265";
  const entryOrderId = "2105617357000000001";
  const originalStopOrderId = "2105617358999085056";
  const coreStopOrderId = "2105618283276886016";
  const runnerStopOrderId = "2105622652764381184";
  const originalStopIds = [
    originalStopOrderId, coreStopOrderId, runnerStopOrderId,
  ].sort();
  const originalRefusal = {
    definiteRejection: true,
    reason: "exchange_state_not_verified",
    submissionError: "BingXLiveApiError",
    submissionErrorMessage:
      "BingX request failed (GET /openApi/swap/v2/trade/leverage, HTTP 200, code 109400, msg: timestamp is invalid)",
  };

  const fixture = ({
    parentMutation = null,
    executionMutation = null,
    accountReadDelays = [],
    runnerProofDelayMs = 0,
    transportUnknown = false,
    runnerFillProof = null,
    runnerFillStoreResult = "recovered",
    intentOutcomeOverride = null,
  } = {}) => {
    let clockNow = NOW;
    const store = memoryStore(null);
    const snapshot = {
      sourceSignalId,
      symbol: "AKTUSDT",
      patternId: "impulse_buy",
      status: "closing",
      executionStatus: "impulse_split_cancel_original_pending",
      environment: "vst",
      accountId: "vst-account",
      entryClientOrderId: "akt-entry-client",
      entryOrderId,
      exchangePositionId: positionId,
      remainingQty: "7498.500",
      quantity: "7498.500",
      signalSnapshot: {
        sourceSignalId, patternId: "impulse_buy", symbol: "AKTUSDT",
      },
      split: {
        stage: "cancel_original_pending",
        totalQuantity: "7498.500",
        coreQuantity: "5998.800",
        runnerQuantity: "1499.700",
        signalStopPrice: "0.6140",
        breakEvenPrice: "0.6650",
        actualEntryBreakEvenPrice: "0.6650",
        positionId,
        entryOrderId,
        originalStopOrderId,
        baselineOpenOrderIds: originalStopIds,
        createdAt: NOW - 60_000,
        coreStop: {
          tranche: "core", orderId: coreStopOrderId, positionId,
          quantity: "5998.800", stopPrice: "0.6140",
        },
        runnerStop: {
          tranche: "runner", orderId: runnerStopOrderId, positionId,
          quantity: "1499.700", stopPrice: "0.6650",
        },
      },
      policy: {
        status: "closing",
        coreQty: 5998.8,
        runnerQty: 1499.7,
        remainingQty: 7498.5,
        coreOpen: true,
        runnerOpen: true,
        stopPrice: 0.614,
        runnerStopPrice: 0.665,
      },
    };
    const request = {
      operation: "cancel_original_stop",
      sourceSignalId,
      environment: "vst",
      accountId: "vst-account",
      symbol: "AKTUSDT",
      positionId,
      originalStopOrderId,
      entryOrderId,
      totalQuantity: "7498.500",
      coreQuantity: "5998.800",
      runnerQuantity: "1499.700",
      signalStopPrice: "0.6140",
      breakEvenPrice: "0.6650",
      actualEntryBreakEvenPrice: "0.6650",
      baselineOpenOrderIds: originalStopIds,
      createdAt: NOW - 60_000,
      coreStop: structuredClone(snapshot.split.coreStop),
      runnerStop: structuredClone(snapshot.split.runnerStop),
      position: { positionId },
      priorPosition: structuredClone(snapshot),
    };
    const phase = "impulse-cancel_original_stop";
    const clientOrderId = `vst-${createHash("sha256")
      .update(`${sourceSignalId}:${phase}`).digest("hex").slice(0, 30)}`;
    const intentOutcome = intentOutcomeOverride
      ? structuredClone(intentOutcomeOverride)
      : transportUnknown
      ? {
          reason: "exchange_state_not_verified",
          submissionError: "BingXLiveApiError",
          submissionErrorMessage: "transport ended before response",
        }
      : structuredClone(originalRefusal);
    const intent = {
      sourceSignalId, phase, clientOrderId, request,
      state: "unknown", exchangeOrderId: null, outcome: intentOutcome,
    };
    store.data.status = "unknown";
    store.data.positions.push({
      sourceSignalId, symbol: "AKTUSDT", status: "closing",
      snapshot, updatedAt: new Date(NOW - 10_000).toISOString(),
    });
    store.data.intents.push(intent);
    store.getPosition = async (id) => {
      const row = store.data.positions.find((item) =>
        item.sourceSignalId === id);
      return row ? structuredClone(row) : null;
    };
    let recoveryCalls = 0;
    let capturedRecoveryInput = null;
    let runnerFillRecoveryCalls = 0;
    let capturedRunnerFillRecoveryInput = null;
    store.recoverPreDeleteOriginalStopCancel = async (input) => {
      recoveryCalls += 1;
      capturedRecoveryInput = input;
      const row = store.data.positions[0];
      if (input.expectedRequest !== intent.request ||
          input.expectedOutcome !== intent.outcome ||
          JSON.stringify(row.snapshot) !==
            JSON.stringify(input.expectedPositionSnapshot) ||
          input.maxEvidenceAgeMs !== 5_000 ||
          input.verifiedPositionAndStops?.stopExecutionProofs?.length !== 3 ||
          input.verifiedPositionAndStops.stopExecutionProofs.some((proof) =>
            !["0.00", "0.000"].includes(proof.executedQty)) ||
          input.recoveryPhase !==
            "impulse-cancel_original_stop-retry-1") {
        return { kind: "ineligible", reason: "position_changed" };
      }
      intent.state = "failed";
      intent.outcome = {
        reason: "cancel_original_stop_pre_mutation_read_refused",
        operation: "cancel_original_stop",
        canceled: false,
        mutationRequestSent: false,
        mutationProvenance: {
          operation: "cancel_original_stop",
          mutationMethod: "DELETE",
          mutationEndpoint: "/openApi/swap/v2/trade/order",
          mutationRequestSent: false,
          phase: "pre_mutation_read",
        },
        recoveryPhase: input.recoveryPhase,
      };
      row.snapshot = structuredClone(input.recoveryPosition);
      row.updatedAt = new Date(NOW).toISOString();
      store.data.status = "opening";
      store.data.reason = null;
      store.data.events.push(["vst_original_stop_cancel_pre_mutation_read_refused"]);
      return { kind: "recovered" };
    };
    store.recoverOriginalStopCancelRunnerFill = async (input) => {
      runnerFillRecoveryCalls += 1;
      capturedRunnerFillRecoveryInput = input;
      if (runnerFillStoreResult !== "recovered") {
        return { kind: "ineligible", reason: "position_changed" };
      }
      const row = store.data.positions[0];
      if (intent.state !== "unknown" ||
          JSON.stringify(row.snapshot) !==
            JSON.stringify(input.expectedPositionSnapshot) ||
          input.requestStartedAtMs !== runnerFillProof.requestStartedAtMs ||
          input.maxEvidenceAgeMs !== 5_000 ||
          JSON.stringify(input.runnerFillProof) !== JSON.stringify(runnerFillProof) ||
          input.position.split?.stage !==
            (input.recoveryMode === "sent_cancel_confirmed"
              ? "complete" : "runner_cleanup_pending") ||
          input.recoveryMode !== "sent_cancel_confirmed" &&
            input.position.split.runnerCleanup?.stage !==
              "cancel_original_pending" ||
          input.runnerFillIntent?.request?.operation !==
            "observe_triggered_stop") {
        return { kind: "ineligible", reason: "position_changed" };
      }
      if (input.recoveryMode === "sent_cancel_confirmed") {
        intent.state = "reconciled";
        intent.exchangeOrderId = originalStopOrderId;
        intent.outcome = {
          ...intent.outcome,
          status: "canceled",
          verified: true,
          operation: "cancel_original_stop",
          originalCancellationConfirmed: true,
          canceledOriginalStopOrderId: originalStopOrderId,
          runnerFillOrderId: runnerFillProof.fill.orderId,
        };
      } else {
        intent.state = "failed";
      }
      row.snapshot = structuredClone(input.position);
      row.status = input.position.status;
      row.updatedAt = new Date(NOW).toISOString();
      store.data.status = "open";
      store.data.reason = null;
      store.data.intents.push({
        sourceSignalId,
        phase: input.runnerFillIntent.phase,
        clientOrderId: input.runnerFillIntent.clientOrderId,
        request: structuredClone(input.runnerFillIntent.request),
        state: "reconciled",
        exchangeOrderId: input.runnerFillIntent.exchangeOrderId,
        outcome: structuredClone(input.runnerFillIntent.outcome),
      });
      store.data.events.push([
        "vst_impulse_runner_fill_cleanup_pending",
      ]);
      return { kind: "recovered" };
    };

    const rawPosition = {
      symbol: "AKT-USDT",
      positionSide: "LONG",
      positionAmt: "7498.500",
      positionId,
    };
    const openOrders = [
      {
        symbol: "AKT-USDT", orderId: originalStopOrderId, mainOrderId: "",
        type: "STOP_MARKET", status: "NEW", side: "SELL",
        positionSide: "LONG", workingType: "MARK_PRICE", positionId,
        origQty: "7498.500", executedQty: "0.00", stopPrice: "0.6140",
      },
      {
        symbol: "AKT-USDT", orderId: coreStopOrderId, mainOrderId: "",
        type: "STOP_MARKET", status: "NEW", side: "SELL",
        positionSide: "LONG", workingType: "MARK_PRICE", positionId,
        origQty: "5998.800", executedQty: "0.00", stopPrice: "0.6140",
      },
      {
        symbol: "AKT-USDT", orderId: runnerStopOrderId, mainOrderId: "",
        type: "STOP_MARKET", status: "NEW", side: "SELL",
        positionSide: "LONG", workingType: "MARK_PRICE", positionId,
        origQty: "1499.700", executedQty: "0.00", stopPrice: "0.6650",
      },
    ];
    if (runnerFillProof) {
      rawPosition.positionAmt = "5998.800";
      openOrders.splice(
        0,
        openOrders.length,
        ...(runnerFillProof.originalCancellationConfirmed
          ? [structuredClone(runnerFillProof.coreStop)]
          : [structuredClone(runnerFillProof.originalStop),
            structuredClone(runnerFillProof.coreStop)]),
      );
    }
    if (parentMutation) parentMutation(openOrders[0]);
    if (executionMutation) executionMutation(openOrders);
    const exchangePosition = {
      verified: true,
      symbol: "AKTUSDT",
      positionId,
      quantity: "7498.500",
      side: "Buy",
      leverage: 10,
      marginMode: "ISOLATED",
    };
    if (runnerFillProof) exchangePosition.quantity = "5998.800";
    let accountReads = 0;
    let positionReads = 0;
    let writes = 0;
    let reconciles = 0;
    const broker = guardedBroker(store, {
      currentPosition: exchangePosition,
      onPerform: async (submitted) => {
        writes += 1;
        if (runnerFillProof &&
            submitted.request.operation === "cancel_original_after_runner_fill") {
          assert.equal(submitted.phase,
            `impulse-runner-cancel-original-${runnerFillProof.fill.orderId}`);
          assert.notEqual(submitted.clientOrderId, clientOrderId);
        } else {
          assert.equal(submitted.phase, "impulse-cancel_original_stop-retry-1");
          assert.notEqual(submitted.clientOrderId, clientOrderId);
        }
        const originalIndex = openOrders.findIndex((row) =>
          row.orderId === originalStopOrderId);
        if (originalIndex >= 0) openOrders.splice(originalIndex, 1);
      },
      reconcile: async (submitted) => {
        reconciles += 1;
        if (submitted?.request?.operation === "cancel_original_after_runner_fill") {
          return {
            verified: true,
            status: "filled",
            canceledOriginalStopOrderId: originalStopOrderId,
            runnerStopOrderId: runnerStopOrderId,
            runnerChildOrderId: runnerFillProof.fill.orderId,
            cancellationIntentId: submitted.clientOrderId,
            position: {
              verified: true,
              symbol: "AKTUSDT",
              positionId,
              quantity: "5998.800",
            },
            protectiveStops: {
              core: {
                verified: true, orderId: coreStopOrderId, positionId,
                quantity: "5998.800", stopPrice: "0.6140",
              },
            },
          };
        }
        return {
          verified: true,
          status: "filled",
          position: {
            ...exchangePosition,
            symbol: "AKTUSDT",
            positionId,
            quantity: runnerFillProof ? "5998.800" : "7498.500",
          },
          protectiveStops: {
            core: {
              verified: true, orderId: coreStopOrderId, positionId,
              quantity: "5998.800", stopPrice: "0.6140",
            },
            runner: {
              verified: true, orderId: runnerStopOrderId, positionId,
              quantity: "1499.700", stopPrice: "0.6650",
            },
          },
        };
      },
    });
    broker.getCapabilities = async () => ({
      environment: "vst",
      verified: true,
      accountId: "vst-account",
      features: [...FULL_CAPABILITIES, "impulse_runner_stop_and_partial_close"],
    });
    broker.readAccountState = async () => {
      accountReads += 1;
      if (transportUnknown) throw new Error("synthetic read outage");
      clockNow += accountReadDelays[accountReads - 1] ?? 0;
      return {
        verified: true,
        environment: "vst",
        accountId: "vst-account",
        positions: [rawPosition],
        openOrders: structuredClone(openOrders),
      };
    };
    broker.readPosition = async () => {
      positionReads += 1;
      return structuredClone(exchangePosition);
    };
    if (runnerFillProof) {
      broker.readOriginalStopRefusalRunnerFillEvidence = async (input) => {
        assert.equal(input.clientOrderId, clientOrderId);
        assert.deepEqual(input.request, intent.request);
        assert.deepEqual(input.persistedPosition, snapshot);
        clockNow += runnerProofDelayMs;
        return structuredClone(runnerFillProof);
      };
      broker.readSentOriginalStopCancellationRunnerFillEvidence = async (input) => {
        assert.equal(input.clientOrderId, clientOrderId);
        assert.deepEqual(input.request, intent.request);
        assert.deepEqual(input.persistedPosition, snapshot);
        clockNow += runnerProofDelayMs;
        return structuredClone(runnerFillProof);
      };
    }
    const worker = createVstWorker({ store, broker, clock: () => clockNow });
    return {
      store, worker, broker, openOrders, intent, phase, clientOrderId,
      getRecoveryCalls: () => recoveryCalls,
      getCapturedRecoveryInput: () => capturedRecoveryInput,
      getRunnerFillRecoveryCalls: () => runnerFillRecoveryCalls,
      getCapturedRunnerFillRecoveryInput: () => capturedRunnerFillRecoveryInput,
      getAccountReads: () => accountReads,
      getPositionReads: () => positionReads,
      getWrites: () => writes,
      getReconciles: () => reconciles,
    };
  };

  const makeRunnerFillProof = (overrides = {}, sentCancelConfirmed = false) => {
    const originalStop = {
      verified: true,
      symbol: "AKT-USDT",
      orderId: originalStopOrderId,
      mainOrderId: entryOrderId,
      type: "STOP_MARKET",
      status: sentCancelConfirmed ? "CANCELED" : "NEW",
      side: "SELL",
      positionSide: "LONG",
      workingType: "MARK_PRICE",
      positionId,
      origQty: sentCancelConfirmed ? "7498.500" : "5998.800",
      quantity: sentCancelConfirmed ? "7498.500" : "5998.800",
      executedQty: "0.00",
      stopPrice: "0.6140",
    };
    const coreStop = {
      ...originalStop,
      verified: true,
      orderId: coreStopOrderId,
      status: "NEW",
      origQty: "5998.800",
      quantity: "5998.800",
    };
    const fill = {
      orderId: "2105622652764399999",
      triggerOrderId: runnerStopOrderId,
      quantity: "1499.700",
      price: "0.6640",
      at: new Date(NOW - 100).toISOString(),
      fee: { asset: "USDT", amount: "0.0123" },
    };
    const proof = {
      verified: true,
      outcome: sentCancelConfirmed
        ? "confirmed_sent_original_stop_cancel_runner_fill"
        : "confirmed_original_stop_cancel_runner_fill",
      status: "filled",
      runnerFillRecovery: true,
      ...(sentCancelConfirmed ? { originalCancellationConfirmed: true } : {}),
      requestStartedAtMs: NOW - 200,
      fill,
      position: {
        verified: true,
        symbol: "AKTUSDT",
        positionId,
        quantity: 5998.8,
        side: "Buy",
        leverage: 10,
        marginMode: "ISOLATED",
      },
      originalStop,
      coreStop,
      runnerStop: {
        verified: true,
        symbol: "AKT-USDT",
        orderId: runnerStopOrderId,
        childOrderId: fill.orderId,
        positionId,
        type: "STOP_MARKET",
        status: "FILLED",
        side: "SELL",
        positionSide: "LONG",
        origQty: "1499.700",
        executedQty: "1499.700",
        stopPrice: "0.6650",
        workingType: "MARK_PRICE",
      },
    };
    return { ...proof, ...overrides };
  };

  const runnerFillRecoveryPg = (input, { failPositionUpdate = false } = {}) => {
    const state = {
      signalStatus: "unknown",
      positionStatus: input.expectedPositionSnapshot.status,
      positionSnapshot: structuredClone(input.expectedPositionSnapshot),
      positionUpdatedAt: input.expectedPositionUpdatedAt,
      intents: [{
        source_signal_id: input.sourceSignalId,
        phase: input.oldCancelPhase,
        client_order_id: input.oldCancelClientOrderId,
        request: structuredClone(input.expectedRequest),
        state: input.expectedOldIntentState ?? "unknown",
        exchange_order_id: null,
        outcome: structuredClone(input.expectedOutcome),
      }],
      events: [],
    };
    const matchesJson = (value, serialized) => {
      try {
        assert.deepEqual(value, JSON.parse(serialized));
        return true;
      } catch {
        return false;
      }
    };
    const statements = [];
    let transactionSnapshot = null;
    const restore = (value) => {
      state.signalStatus = value.signalStatus;
      state.positionStatus = value.positionStatus;
      state.positionSnapshot = value.positionSnapshot;
      state.positionUpdatedAt = value.positionUpdatedAt;
      state.intents = value.intents;
      state.events = value.events;
    };
    const client = {
      async query(sql, params = []) {
        const normalized = sql.trim();
        statements.push({ sql: normalized, params });
        if (normalized === "BEGIN") {
          transactionSnapshot = structuredClone(state);
          return { rowCount: 0, rows: [] };
        }
        if (normalized === "COMMIT") {
          transactionSnapshot = null;
          return { rowCount: 0, rows: [] };
        }
        if (normalized === "ROLLBACK") {
          if (transactionSnapshot) restore(transactionSnapshot);
          transactionSnapshot = null;
          return { rowCount: 0, rows: [] };
        }
        if (normalized === INTENT_SERIALIZATION_LOCK_SQL) {
          return { rowCount: 1, rows: [{ pg_advisory_xact_lock: null }] };
        }
        if (normalized.includes("FROM vst_signals") && normalized.includes("FOR UPDATE")) {
          return {
            rowCount: 1,
            rows: [{ source_signal_id: input.sourceSignalId, status: state.signalStatus }],
          };
        }
        if (normalized.includes("FROM vst_positions") && normalized.includes("FOR UPDATE")) {
          return {
            rowCount: 1,
            rows: [{
              source_signal_id: input.sourceSignalId,
              symbol: input.expectedPositionSnapshot.symbol,
              status: state.positionStatus,
              snapshot: structuredClone(state.positionSnapshot),
              updated_at_text: state.positionUpdatedAt,
            }],
          };
        }
        if (normalized.includes("FROM vst_order_intents") &&
            normalized.includes("client_order_id = $2 FOR UPDATE")) {
          const row = state.intents.find((item) =>
            item.client_order_id === params[1]);
          return { rowCount: row ? 1 : 0, rows: row ? [structuredClone(row)] : [] };
        }
        if (normalized.includes("FROM vst_order_intents") &&
            normalized.includes("phase = $2 FOR UPDATE")) {
          const row = state.intents.find((item) =>
            item.source_signal_id === params[0] && item.phase === params[1]);
          return { rowCount: row ? 1 : 0, rows: row ? [structuredClone(row)] : [] };
        }
        if (normalized.includes("FROM vst_order_intents") &&
            normalized.includes("state IN ('prepared', 'submitted', 'unknown')")) {
          return { rowCount: 0, rows: [] };
        }
        if (normalized.startsWith("UPDATE vst_order_intents")) {
          const row = state.intents.find((item) =>
            item.source_signal_id === params[0] &&
            item.client_order_id === params[1]);
          if (!row || row.phase !== params[2] || row.state !== params[5] ||
              row.exchange_order_id !== null ||
              !matchesJson(row.request, params[3]) ||
              !matchesJson(row.outcome, params[4])) {
            return { rowCount: 0, rows: [] };
          }
          row.state = params[6];
          row.exchange_order_id = params[7];
          row.outcome = JSON.parse(params[8]);
          return { rowCount: 1, rows: [{ client_order_id: row.client_order_id }] };
        }
        if (normalized.startsWith("UPDATE vst_positions")) {
          if (failPositionUpdate ||
              state.positionStatus !== params[4] ||
              state.positionUpdatedAt !== input.expectedPositionUpdatedAt ||
              !matchesJson(state.positionSnapshot, params[1])) {
            return { rowCount: 0, rows: [] };
          }
          state.positionStatus = params[2];
          state.positionSnapshot = JSON.parse(params[3]);
          state.positionUpdatedAt = new Date(NOW + 1).toISOString();
          return { rowCount: 1, rows: [{ source_signal_id: input.sourceSignalId }] };
        }
        if (normalized.startsWith("UPDATE vst_signals")) {
          if (state.signalStatus !== "unknown") return { rowCount: 0, rows: [] };
          state.signalStatus = "open";
          return { rowCount: 1, rows: [{ source_signal_id: input.sourceSignalId }] };
        }
        if (normalized.startsWith("INSERT INTO vst_order_intents")) {
          state.intents.push({
            source_signal_id: params[0],
            phase: params[1],
            client_order_id: params[2],
            request: JSON.parse(params[3]),
            state: "reconciled",
            exchange_order_id: params[4],
            outcome: JSON.parse(params[5]),
          });
          return { rowCount: 1, rows: [{ client_order_id: params[2] }] };
        }
        if (normalized.startsWith("INSERT INTO vst_events")) {
          state.events.push({
            source_signal_id: params[0],
            client_order_id: params[1],
            kind: params[2],
            detail: JSON.parse(params[3]),
          });
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`Unexpected query in runnerFillRecoveryPg: ${normalized}`);
      },
      release() {},
    };
    const pool = {
      state,
      statements,
      async connect() { return client; },
      async query() { throw new Error("runner-fill recovery must use a transaction"); },
    };
    return pool;
  };

  const incident = fixture();
  const recovered = await incident.worker.runOnce();
  assert.deepEqual(recovered, {
    kind: "reconciled",
    reason: "original_stop_cancel_pre_read_refusal_recovered",
  });
  assert.equal(incident.intent.state, "failed");
  assert.equal(incident.intent.outcome.canceled, false);
  assert.equal(incident.intent.outcome.mutationRequestSent, false);
  assert.deepEqual(
    incident.store.data.positions[0].snapshot.split.cancelOriginalRecoveryPhase,
    "impulse-cancel_original_stop-retry-1",
  );
  assert.equal(incident.getWrites(), 0);
  assert.equal(incident.getReconciles(), 0);
  assert.equal(incident.getRecoveryCalls(), 1);
  assert.ok(incident.getAccountReads() >= 2);
  assert.equal(incident.getPositionReads(), 1);
  const capturedRecoveryInput = incident.getCapturedRecoveryInput();
  assert.equal(capturedRecoveryInput.requestStartedAtMs, NOW,
    "the paired proof is anchored to the first account-read start");
  assert.deepEqual(
    capturedRecoveryInput.verifiedPositionAndStops.stopExecutionProofs.map(
      (proof) => proof.executedQty,
    ),
    ["0.00", "0.00", "0.00"],
  );
  const neverEnterTransaction = {
    async connect() { throw new Error("invalid proof entered ledger transaction"); },
    async query() { throw new Error("invalid proof used pool-level query"); },
  };
  for (const [label, mutate] of [
    ["missing executedQty", (proofs) => { delete proofs[0].executedQty; }],
    ["nonzero executedQty", (proofs) => { proofs[1].executedQty = "1"; }],
    ["malformed execution alias", (proofs) => {
      proofs[2].cumExecQty = "not-a-quantity";
    }],
  ]) {
    const stopExecutionProofs = structuredClone(
      capturedRecoveryInput.verifiedPositionAndStops.stopExecutionProofs,
    );
    mutate(stopExecutionProofs);
    assert.deepEqual(
      await createVstStore(neverEnterTransaction)
        .recoverPreDeleteOriginalStopCancel({
          ...capturedRecoveryInput,
          verifiedPositionAndStops: {
            ...capturedRecoveryInput.verifiedPositionAndStops,
            stopExecutionProofs,
          },
        }),
      { kind: "ineligible", reason: "proof_shape_mismatch" },
      label,
    );
  }
  assert.deepEqual(
    await createVstStore(neverEnterTransaction)
      .recoverPreDeleteOriginalStopCancel({
        ...capturedRecoveryInput,
        maxEvidenceAgeMs: 30_000,
      }),
    { kind: "ineligible", reason: "invalid_evidence_time" },
    "store does not accept a caller-relaxed account-to-ledger evidence age",
  );
  let stalePoolQueries = 0;
  const stalePairedProofInput = {
    ...capturedRecoveryInput,
    clock: () => NOW + 5_001,
  };
  const stalePairedProofPool = {
    async connect() {
      return {
        async query(sql) {
          stalePoolQueries += 1;
          if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql.trim()) ||
              sql.includes("pg_advisory_xact_lock")) {
            return { rowCount: 0, rows: [] };
          }
          throw new Error("stale paired proof reached ledger row reads");
        },
        release() {},
      };
    },
    async query() { throw new Error("stale proof used pool-level query"); },
  };
  assert.deepEqual(
    await createVstStore(stalePairedProofPool)
      .recoverPreDeleteOriginalStopCancel(stalePairedProofInput),
    { kind: "ineligible", reason: "evidence_stale" },
    "CAS acquisition rechecks age from the paired account-read start",
  );
  assert.equal(stalePoolQueries, 3,
    "stale evidence is rejected after the lock and before any ledger row read");

  const slowFirstAccountRead = fixture({ accountReadDelays: [6_000, 0] });
  await slowFirstAccountRead.worker.runOnce();
  assert.equal(slowFirstAccountRead.intent.state, "unknown",
    "a fresh final response cannot hide a stale start of the paired proof");
  assert.ok(slowFirstAccountRead.getAccountReads() >= 2);
  assert.equal(slowFirstAccountRead.getRecoveryCalls(), 0);
  assert.equal(slowFirstAccountRead.getWrites(), 0);
  assert.equal(slowFirstAccountRead.getReconciles(), 0);

  {
    const slowFinalPair = fixture({
      runnerFillProof: makeRunnerFillProof(),
      runnerProofDelayMs: 6_000,
    });
    const before = structuredClone(slowFinalPair.store.data);
    await slowFinalPair.worker.runOnce();
    assert.equal(slowFinalPair.intent.state, "unknown");
    assert.deepEqual(slowFinalPair.store.data, before,
      "a slow no-send final account pair cannot mutate ledger state");
    assert.equal(slowFinalPair.getRunnerFillRecoveryCalls(), 0);
    assert.equal(slowFinalPair.getWrites(), 0);
    assert.equal(slowFinalPair.getReconciles(), 0);
  }

  {
    const runnerFillProof = makeRunnerFillProof();
    const runnerRecovery = fixture({ runnerFillProof });
    const originalOutcome = structuredClone(runnerRecovery.intent.outcome);
    const recoveredRunner = await runnerRecovery.worker.runOnce();
    assert.deepEqual(recoveredRunner, {
      kind: "acted",
      operation: "observe_triggered_stop",
      leg: "runner",
    });
    assert.equal(runnerRecovery.getRunnerFillRecoveryCalls(), 1);
    assert.equal(runnerRecovery.getRecoveryCalls(), 0,
      "a verified runner fill does not use the unchanged-three-stop refusal path");
    assert.equal(runnerRecovery.getWrites(), 0,
      "runner fill recovery performs no same-tick DELETE");
    assert.equal(runnerRecovery.getReconciles(), 0);
    assert.equal(runnerRecovery.intent.state, "failed");
    assert.deepEqual(runnerRecovery.intent.outcome, originalOutcome,
      "old refusal evidence remains unchanged and is not mislabeled canceled");
    assert.equal(runnerRecovery.store.data.status, "open");
    const cleanupPosition = runnerRecovery.store.data.positions[0].snapshot;
    assert.equal(cleanupPosition.split.stage, "runner_cleanup_pending");
    assert.equal(cleanupPosition.split.runnerCleanup.stage,
      "cancel_original_pending");
    assert.equal(cleanupPosition.split.runnerCleanup.fill.orderId,
      runnerFillProof.fill.orderId);
    assert.deepEqual(cleanupPosition.split.runnerCleanup.fill.fee,
      runnerFillProof.fill.fee);
    assert.equal(cleanupPosition.split.runnerCleanup.fill.feeEvidenceAvailable,
      true);
    const recoveredFillIntent = runnerRecovery.store.data.intents.find((row) =>
      row.request?.operation === "observe_triggered_stop");
    assert.equal(recoveredFillIntent?.state, "reconciled");
    assert.equal(recoveredFillIntent?.exchangeOrderId,
      runnerFillProof.fill.orderId);
    assert.equal(runnerRecovery.store.data.intents.some((row) =>
      row.request?.operation === "cancel_original_after_runner_fill"), false,
    "the new durable cancellation belongs to a later tick only");

    const laterCleanup = await runnerRecovery.worker.runOnce();
    assert.equal(laterCleanup.kind, "acted");
    assert.equal(laterCleanup.operation, "cancel_original_after_runner_fill");
    assert.equal(runnerRecovery.getWrites(), 1,
      "the existing durable cleanup phase makes exactly one later DELETE");
    assert.equal(runnerRecovery.getReconciles(), 1);
    assert.equal(runnerRecovery.store.data.positions[0].snapshot.split.stage,
      "complete");
    assert.equal(runnerRecovery.store.data.intents.filter((row) =>
      row.request?.operation === "cancel_original_after_runner_fill").length, 1);

    const realStoreInput = runnerRecovery.getCapturedRunnerFillRecoveryInput();
    const staleStoreInput = {
      ...realStoreInput,
      clock: () => NOW + 5_001,
    };
    const stalePool = runnerFillRecoveryPg(staleStoreInput);
    const staleBefore = structuredClone(stalePool.state);
    assert.deepEqual(await createVstStore(stalePool)
      .recoverOriginalStopCancelRunnerFill(staleStoreInput),
    { kind: "ineligible", reason: "evidence_stale" });
    assert.deepEqual(stalePool.state, staleBefore,
      "a stale no-send final-read-start-to-CAS interval leaves the ledger unchanged");
    assert.equal(stalePool.statements.some(({ sql }) =>
      /FROM vst_(signals|positions|order_intents)|UPDATE vst_|INSERT INTO vst_/.test(sql)),
    false,
    "stale no-send evidence is rejected after the advisory lock and before row reads");

    const realPool = runnerFillRecoveryPg(realStoreInput);
    const realStore = createVstStore(realPool);
    assert.deepEqual(await realStore.recoverOriginalStopCancelRunnerFill(
      realStoreInput,
    ), { kind: "recovered" });
    assert.equal(realPool.state.signalStatus, "open");
    assert.equal(realPool.state.intents[0].state, "failed");
    assert.deepEqual(realPool.state.intents[0].outcome,
      realStoreInput.expectedOutcome);
    const bookedFill = realPool.state.intents.find((row) =>
      row.request?.operation === "observe_triggered_stop");
    assert.equal(bookedFill?.state, "reconciled");
    assert.equal(bookedFill?.exchange_order_id, runnerFillProof.fill.orderId);
    assert.equal(realPool.state.intents.filter((row) =>
      row.request?.operation === "observe_triggered_stop").length, 1);
    assert.equal(realPool.state.positionSnapshot.remainingQty, 5998.8);
    assert.equal(realPool.state.positionSnapshot.lastCloseFill.orderId,
      runnerFillProof.fill.orderId);
    assert.deepEqual(realPool.state.positionSnapshot.lastCloseFill.fee,
      runnerFillProof.fill.fee);
    const recordedSnapshot = structuredClone(realPool.state.positionSnapshot);
    assert.deepEqual(await realStore.recoverOriginalStopCancelRunnerFill(
      realStoreInput,
    ), { kind: "replayed" });
    assert.equal(realPool.state.intents.filter((row) =>
      row.request?.operation === "observe_triggered_stop").length, 1,
    "the real store replay does not add a second exit fill");
    assert.deepEqual(realPool.state.positionSnapshot, recordedSnapshot,
      "replay does not reapply the fee or fill");

    const casPool = runnerFillRecoveryPg(realStoreInput, {
      failPositionUpdate: true,
    });
    const beforeCas = structuredClone(casPool.state);
    await assert.rejects(
      createVstStore(casPool)
        .recoverOriginalStopCancelRunnerFill(realStoreInput),
      /runner-fill recovery CAS failed/,
    );
    assert.deepEqual(casPool.state, beforeCas,
      "a real-method CAS failure rolls back retirement, fill, fee, and position");
    assert.equal(casPool.state.intents.some((row) =>
      row.request?.operation === "observe_triggered_stop"), false,
    "CAS rollback leaves no phantom unresolved or reconciled fill intent");
  }

  {
    const sentTransportOutcome = {
      reason: "exchange_state_not_verified",
      submissionError: "BingXLiveApiError",
      submissionErrorMessage: "transport ended before DELETE response",
      mutationProvenance: {
        operation: "cancel_original_stop",
        mutationMethod: "DELETE",
        mutationEndpoint: "/openApi/swap/v2/trade/order",
        mutationRequestSent: true,
        phase: "mutation_transport_started",
      },
    };
    const slowSentPair = fixture({
      runnerFillProof: makeRunnerFillProof({}, true),
      runnerProofDelayMs: 6_000,
      intentOutcomeOverride: sentTransportOutcome,
    });
    const slowSentBefore = structuredClone(slowSentPair.store.data);
    await slowSentPair.worker.runOnce();
    assert.equal(slowSentPair.intent.state, "unknown");
    assert.deepEqual(slowSentPair.store.data, slowSentBefore,
      "a slow sent-cancellation final account pair cannot mutate ledger state");
    assert.equal(slowSentPair.getRunnerFillRecoveryCalls(), 0);
    assert.equal(slowSentPair.getWrites(), 0);
    assert.equal(slowSentPair.getReconciles(), 0);

    const proof = makeRunnerFillProof({}, true);
    const sentRecovery = fixture({
      runnerFillProof: proof,
      intentOutcomeOverride: sentTransportOutcome,
    });
    const settled = await sentRecovery.worker.runOnce();
    assert.deepEqual(settled, {
      kind: "acted",
      operation: "observe_triggered_stop",
      leg: "runner",
    });
    assert.equal(sentRecovery.getRunnerFillRecoveryCalls(), 1);
    assert.equal(sentRecovery.getWrites(), 0,
      "a post-DELETE confirmation never authorizes a second DELETE");
    assert.equal(sentRecovery.getReconciles(), 0);
    assert.equal(sentRecovery.intent.state, "reconciled");
    assert.equal(sentRecovery.intent.exchangeOrderId, originalStopOrderId);
    assert.equal(sentRecovery.intent.outcome.submissionError,
      sentTransportOutcome.submissionError);
    assert.equal(sentRecovery.intent.outcome.mutationProvenance.mutationRequestSent,
      true);
    assert.equal(sentRecovery.intent.outcome.originalCancellationConfirmed, true);
    assert.equal(sentRecovery.store.data.status, "open");
    const coreOnly = sentRecovery.store.data.positions[0].snapshot;
    assert.equal(coreOnly.status, "open");
    assert.equal(coreOnly.remainingQty, 5998.8);
    assert.equal(coreOnly.split.stage, "complete");
    assert.equal(coreOnly.split.runnerCleanup, null);
    assert.deepEqual(coreOnly.split.activeLegs, ["core"]);
    assert.equal(coreOnly.lastCloseFill.orderId, proof.fill.orderId);
    assert.deepEqual(coreOnly.lastCloseFill.fee, proof.fill.fee);
    assert.equal(sentRecovery.store.data.intents.filter((row) =>
      row.request?.operation === "observe_triggered_stop" &&
      row.state === "reconciled").length, 1);
    assert.equal(sentRecovery.store.data.intents.some((row) =>
      row.request?.operation === "cancel_original_after_runner_fill"), false);

    await sentRecovery.worker.runOnce();
    assert.equal(sentRecovery.getWrites(), 0,
      "the next normal tick does not repeat original-stop cancellation");
    assert.equal(sentRecovery.store.data.intents.some((row) =>
      row.request?.operation === "cancel_original_after_runner_fill"), false);

    const realStoreInput = sentRecovery.getCapturedRunnerFillRecoveryInput();
    const staleStoreInput = {
      ...realStoreInput,
      clock: () => NOW + 5_001,
    };
    const stalePool = runnerFillRecoveryPg(staleStoreInput);
    const staleBefore = structuredClone(stalePool.state);
    assert.deepEqual(await createVstStore(stalePool)
      .recoverOriginalStopCancelRunnerFill(staleStoreInput),
    { kind: "ineligible", reason: "evidence_stale" });
    assert.deepEqual(stalePool.state, staleBefore,
      "a stale sent final-read-start-to-CAS interval leaves the ledger unchanged");
    assert.equal(stalePool.statements.some(({ sql }) =>
      /FROM vst_(signals|positions|order_intents)|UPDATE vst_|INSERT INTO vst_/.test(sql)),
    false,
    "stale sent evidence is rejected before any ledger row read or mutation");

    const realPool = runnerFillRecoveryPg(realStoreInput);
    const realStore = createVstStore(realPool);
    assert.deepEqual(await realStore.recoverOriginalStopCancelRunnerFill(
      realStoreInput,
    ), { kind: "recovered" });
    assert.equal(realPool.state.signalStatus, "open");
    assert.equal(realPool.state.intents[0].state, "reconciled");
    assert.equal(realPool.state.intents[0].exchange_order_id, originalStopOrderId);
    assert.equal(realPool.state.intents[0].outcome.originalCancellationConfirmed,
      true);
    assert.equal(realPool.state.intents[0].outcome.mutationProvenance
      .mutationRequestSent, true);
    assert.equal(realPool.state.intents[0].outcome.submissionError,
      sentTransportOutcome.submissionError);
    assert.equal(realPool.state.positionStatus, "open");
    assert.equal(realPool.state.positionSnapshot.split.stage, "complete");
    assert.equal(realPool.state.positionSnapshot.remainingQty, 5998.8);
    assert.equal(realPool.state.positionSnapshot.lastCloseFill.orderId,
      proof.fill.orderId);
    assert.deepEqual(realPool.state.positionSnapshot.lastCloseFill.fee,
      proof.fill.fee);
    assert.equal(realPool.state.intents.filter((row) =>
      row.request?.operation === "observe_triggered_stop").length, 1);
    const recordedSnapshot = structuredClone(realPool.state.positionSnapshot);
    assert.deepEqual(await realStore.recoverOriginalStopCancelRunnerFill(
      realStoreInput,
    ), { kind: "replayed" });
    assert.deepEqual(realPool.state.positionSnapshot, recordedSnapshot);
    assert.equal(realPool.state.intents.filter((row) =>
      row.request?.operation === "observe_triggered_stop").length, 1,
    "the sent-cancellation replay does not double-book the runner fill");
  }

  {
    const sentTransportOutcome = {
      reason: "exchange_state_not_verified",
      submissionError: "BingXLiveApiError",
      submissionErrorMessage: "transport ended before DELETE response",
      mutationProvenance: {
        operation: "cancel_original_stop",
        mutationMethod: "DELETE",
        mutationEndpoint: "/openApi/swap/v2/trade/order",
        mutationRequestSent: true,
        phase: "mutation_transport_started",
      },
    };
    const proof = makeRunnerFillProof({}, true);
    proof.originalStop.origQty = "5998.800";
    proof.originalStop.quantity = "5998.800";
    proof.originalStopQuantityBasis = "post_runner_residual";
    const sentResidual = fixture({
      runnerFillProof: proof,
      intentOutcomeOverride: sentTransportOutcome,
    });
    await sentResidual.worker.runOnce();
    assert.equal(sentResidual.intent.state, "reconciled");
    assert.equal(sentResidual.getWrites(), 0);
    const storeInput = sentResidual.getCapturedRunnerFillRecoveryInput();
    const realPool = runnerFillRecoveryPg(storeInput);
    assert.deepEqual(await createVstStore(realPool)
      .recoverOriginalStopCancelRunnerFill(storeInput),
    { kind: "recovered" },
    "the real store accepts the canceled original resized to the 80% residual");
    assert.equal(realPool.state.positionSnapshot.remainingQty, 5998.8);
    assert.equal(realPool.state.positionSnapshot.lastCloseFill.orderId,
      proof.fill.orderId);

    for (const mutate of [
      (invalid) => {
        invalid.originalStop.origQty = "2999.400";
        invalid.originalStop.quantity = "2999.400";
        delete invalid.originalStopQuantityBasis;
      },
      (invalid) => {
        invalid.originalStop.quantity = "7498.500";
        delete invalid.originalStopQuantityBasis;
      },
    ]) {
      const invalidInput = {
        ...storeInput,
        runnerFillProof: structuredClone(storeInput.runnerFillProof),
      };
      mutate(invalidInput.runnerFillProof);
      const untouchedPool = runnerFillRecoveryPg(invalidInput);
      const before = structuredClone(untouchedPool.state);
      assert.deepEqual(await createVstStore(untouchedPool)
        .recoverOriginalStopCancelRunnerFill(invalidInput),
      { kind: "ineligible", reason: "proof_shape_mismatch" });
      assert.deepEqual(untouchedPool.state, before,
        "arbitrary or conflicting original quantity cannot commit");
    }
  }

  for (const [label, mutate] of [
    ["sent original was still NEW", (proof) => { proof.originalStop.status = "NEW"; }],
    ["sent original executed quantity was nonzero", (proof) => {
      proof.originalStop.executedQty = "1";
    }],
    ["sent original status was missing", (proof) => {
      delete proof.originalStop.status;
    }],
    ["sent original quantity was neither accepted basis", (proof) => {
      proof.originalStop.origQty = "2999.400";
      proof.originalStop.quantity = "2999.400";
    }],
    ["sent original quantity aliases conflicted", (proof) => {
      proof.originalStop.quantity = "5998.800";
    }],
    ["sent original quantity basis contradicted its quantity", (proof) => {
      proof.originalStopQuantityBasis = "post_runner_residual";
    }],
    ["sent residual was flat", (proof) => { proof.position.quantity = 0; }],
    ["sent child was unlinked", (proof) => {
      proof.runnerStop.childOrderId = "unlinked-child";
    }],
    ["sent runner fill was partial", (proof) => { proof.fill.quantity = "1000.000"; }],
    ["sent broker history proof failed", (proof) => {
      proof.verified = false;
      proof.outcome = "unknown";
    }],
  ]) {
    const proof = makeRunnerFillProof({}, true);
    mutate(proof);
    const rejected = fixture({
      runnerFillProof: proof,
      intentOutcomeOverride: {
        reason: "exchange_state_not_verified",
        submissionError: "BingXLiveApiError",
        submissionErrorMessage: "transport ended before DELETE response",
        mutationProvenance: {
          operation: "cancel_original_stop",
          mutationMethod: "DELETE",
          mutationEndpoint: "/openApi/swap/v2/trade/order",
          mutationRequestSent: true,
          phase: "mutation_transport_started",
        },
      },
    });
    const before = structuredClone(rejected.store.data);
    await rejected.worker.runOnce();
    assert.equal(rejected.intent.state, "unknown", label);
    assert.deepEqual(rejected.store.data, before, label);
    assert.equal(rejected.getRunnerFillRecoveryCalls(), 0, label);
    assert.equal(rejected.getWrites(), 0, label);
  }

  for (const [label, mutate] of [
    ["partial runner fill", (proof) => { proof.fill.quantity = "1000.000"; }],
    ["wrong trigger-stop linkage", (proof) => {
      proof.fill.triggerOrderId = originalStopOrderId;
    }],
    ["wrong child linkage", (proof) => {
      proof.runnerStop.childOrderId = "unlinked-child";
    }],
    ["wrong residual quantity", (proof) => {
      proof.position.quantity = "5998.799";
    }],
    ["missing runner fee", (proof) => { proof.fill.fee = null; }],
    ["missing active-stop execution proof", (proof) => {
      delete proof.coreStop.executedQty;
    }],
    ["stale read-start timestamp", (proof) => {
      proof.requestStartedAtMs = NOW - 5_001;
    }],
  ]) {
    const proof = makeRunnerFillProof();
    mutate(proof);
    const rejected = fixture({ runnerFillProof: proof });
    const before = structuredClone(rejected.store.data);
    await rejected.worker.runOnce();
    assert.equal(rejected.intent.state, "unknown", label);
    assert.deepEqual(rejected.store.data, before, label);
    assert.equal(rejected.getRunnerFillRecoveryCalls(), 0, label);
    assert.equal(rejected.getWrites(), 0, label);
  }

  {
    const proof = makeRunnerFillProof();
    const casFailure = fixture({
      runnerFillProof: proof,
      runnerFillStoreResult: "cas_failed",
    });
    const before = structuredClone(casFailure.store.data);
    await casFailure.worker.runOnce();
    assert.deepEqual(casFailure.store.data, before,
      "a failed old-position CAS leaves every ledger row untouched");
    assert.equal(casFailure.getRunnerFillRecoveryCalls(), 1);
    assert.equal(casFailure.getWrites(), 0);
  }

  {
    const proof = makeRunnerFillProof({
      verified: false,
      status: "unknown",
    });
    const historyUnavailable = fixture({ runnerFillProof: proof });
    const before = structuredClone(historyUnavailable.store.data);
    await historyUnavailable.worker.runOnce();
    assert.deepEqual(historyUnavailable.store.data, before,
      "unavailable linked fill history cannot mutate the ledger");
    assert.equal(historyUnavailable.getRunnerFillRecoveryCalls(), 0);
    assert.equal(historyUnavailable.getWrites(), 0);
  }

  {
    const afterDeleteRefusal = {
      definiteRejection: true,
      reason: "exchange_state_not_verified",
      submissionError: "BingXLiveApiError",
      submissionErrorMessage:
        "BingX request failed (DELETE /openApi/swap/v2/trade/order, HTTP 200, code 109400, msg: timestamp is invalid)",
      mutationProvenance: {
        operation: "cancel_original_stop",
        mutationMethod: "DELETE",
        mutationEndpoint: "/openApi/swap/v2/trade/order",
        mutationRequestSent: true,
        phase: "post_mutation",
      },
    };
    const postDelete = fixture({
      runnerFillProof: makeRunnerFillProof(),
      intentOutcomeOverride: afterDeleteRefusal,
    });
    await postDelete.worker.runOnce();
    assert.equal(postDelete.getRunnerFillRecoveryCalls(), 0,
      "a definitive post-DELETE refusal is outside the recovery predicate");
    assert.equal(postDelete.store.data.intents.some((row) =>
      row.request?.operation === "observe_triggered_stop"), false);
    assert.equal(postDelete.getWrites(), 0);
  }

  const retry = await incident.worker.runOnce();
  assert.equal(retry.kind, "acted");
  assert.equal(retry.operation, "cancel_original_stop");
  assert.equal(incident.getWrites(), 1,
    "the next normal management pass attempts one distinct DELETE only");
  assert.equal(incident.getReconciles(), 1);
  assert.equal(incident.intent.state, "failed",
    "the proven read refusal is never described as an exchange cancellation");
  const retryIntent = incident.store.data.intents.find((row) =>
    row.phase === "impulse-cancel_original_stop-retry-1");
  assert.ok(retryIntent);
  assert.equal(retryIntent.state, "reconciled");
  assert.deepEqual(
    incident.store.data.positions[0].snapshot.split.baselineOpenOrderIds,
    [coreStopOrderId, runnerStopOrderId].sort(),
  );

  const paddedZeroes = fixture({
    executionMutation: (orders) => {
      for (const row of orders) {
        row.executedQty = "0.000";
        row.executedQuantity = "0.0000";
        row.cumExecQty = "0";
        row.filledQty = "0.00000";
      }
    },
  });
  await paddedZeroes.worker.runOnce();
  assert.equal(paddedZeroes.intent.state, "failed",
    "exact decimal zero aliases, including padded zeroes, are accepted");
  assert.equal(paddedZeroes.getRecoveryCalls(), 1);
  assert.equal(paddedZeroes.getWrites(), 0);

  for (const [label, mutate] of [
    ["executed original stop", (orders) => { orders[0].executedQty = "1"; }],
    ["missing known executed quantity", (orders) => {
      delete orders[0].executedQty;
    }],
    ["malformed secondary execution alias", (orders) => {
      orders[1].cumExecQty = "unknown";
    }],
    ["conflicting execution aliases", (orders) => {
      orders[2].executedQuantity = "0.001";
    }],
  ]) {
    const refused = fixture({ executionMutation: mutate });
    await refused.worker.runOnce();
    assert.equal(refused.intent.state, "unknown", label);
    assert.equal(refused.getRecoveryCalls(), 0, label);
    assert.equal(refused.getWrites(), 0, label);
    assert.equal(refused.getReconciles(), 0, label);
  }

  for (const [label, mutation] of [
    ["malformed nonempty parent", (row) => { row.mainOrderId = " "; }],
    ["contradictory parent", (row) => { row.parentOrderId = "wrong-parent"; }],
  ]) {
    const refused = fixture({ parentMutation: mutation });
    await refused.worker.runOnce();
    assert.equal(refused.intent.state, "unknown", label);
    assert.equal(refused.getRecoveryCalls(), 0, label);
    assert.equal(refused.getWrites(), 0, label);
    assert.deepEqual(refused.intent.outcome, originalRefusal, label);
  }

  const transport = fixture({ transportUnknown: true });
  await transport.worker.runOnce();
  assert.equal(transport.intent.state, "unknown",
    "a transport-ambiguous DELETE is never admitted to the legacy GET-only path");
  assert.equal(transport.getRecoveryCalls(), 0);
  assert.equal(transport.getWrites(), 0);
});

test("a stuck raise_stop intent is abandoned once the account is confirmed flat past the timeout", async () => {
  const store = memoryStore(null);
  const clientOrderId = "raise-stop-stuck-1";
  store.data.intents.push({
    sourceSignalId: "cab-signal-raise-stuck",
    phase: "raise-stop",
    clientOrderId,
    request: {
      operation: "raise_stop",
      environment: "vst",
      accountId: "vst-account",
      symbol: "ETHUSDT",
      leg: "core",
      positionId: "position-1",
      quantity: "1",
      previousQuantity: "1",
      stopPrice: "95",
      intentCreatedAt: NOW - 11 * 60 * 1000,
    },
    state: "unknown",
  });
  const broker = guardedBroker(store, { currentPosition: null });
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  const intent = store.data.intents.find((row) => row.clientOrderId === clientOrderId);
  assert.equal(intent.state, "failed");
  assert.equal(intent.detail.outcome.reason, "raise_stop_abandoned_confirmed_flat_account");
  assert.equal(store.data.status, "error");
});

test("a stuck raise_stop intent stays unknown past the timeout when a position still exists", async () => {
  const store = memoryStore(null);
  const clientOrderId = "raise-stop-stuck-2";
  store.data.intents.push({
    sourceSignalId: "cab-signal-raise-stuck-2",
    phase: "raise-stop",
    clientOrderId,
    request: {
      operation: "raise_stop",
      environment: "vst",
      accountId: "vst-account",
      symbol: "ETHUSDT",
      leg: "core",
      positionId: "position-1",
      quantity: "1",
      previousQuantity: "1",
      stopPrice: "95",
      intentCreatedAt: NOW - 11 * 60 * 1000,
    },
    state: "unknown",
  });
  // A foreign-looking but still-present position: proves elapsed time alone
  // is never enough -- the account must also be verifiably flat.
  const broker = guardedBroker(store, {
    currentPosition: {
      verified: true, symbol: "ETHUSDT", positionId: "position-1", side: "Buy",
      quantity: "1", avgPrice: "100", leverage: 10, marginMode: "ISOLATED",
      pricePrecision: 2, protectiveStops: {},
    },
  });
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  const intent = store.data.intents.find((row) => row.clientOrderId === clientOrderId);
  assert.equal(intent.state, "unknown");
});

test("a first-time ambiguous raise_stop reconciliation notifies the owner once, then stays silent on repeat", async () => {
  const store = memoryStore(null);
  const clientOrderId = "raise-stop-first-ambiguous-1";
  store.data.intents.push({
    sourceSignalId: "cab-signal-raise-first-ambiguous",
    phase: "raise-stop",
    clientOrderId,
    request: {
      operation: "raise_stop",
      environment: "vst",
      accountId: "vst-account",
      symbol: "ETHUSDT",
      leg: "core",
      positionId: "position-1",
      quantity: "1",
      previousQuantity: "1",
      stopPrice: "95",
      intentCreatedAt: NOW,
    },
    state: "submitted",
  });
  // Default guardedBroker.reconcileIntent() returns { verified: false,
  // status: "unknown" } -- an ordinary ambiguous read, well before any
  // abandon timeout, on the intent's very first reconciliation attempt.
  const broker = guardedBroker(store, {
    currentPosition: {
      verified: true, symbol: "ETHUSDT", positionId: "position-1", side: "Buy",
      quantity: "1", avgPrice: "100", leverage: 10, marginMode: "ISOLATED",
      pricePrecision: 2, protectiveStops: {},
    },
  });
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  const intent = store.data.intents.find((row) => row.clientOrderId === clientOrderId);
  assert.equal(intent.state, "unknown");
  assert.equal(store.data.status, "unknown");
  const events = store.data.events.filter(([, kind]) => kind === "vst_action_unresolved");
  assert.equal(events.length, 1);
  assert.equal(events[0][2].operation, "raise_stop");
  assert.equal(events[0][2].reason, "exchange_state_not_verified");
  // A second tick finds the SAME intent already unknown -- must not repeat.
  await worker.runOnce();
  assert.equal(
    store.data.events.filter(([, kind]) => kind === "vst_action_unresolved").length, 1,
  );
});

test("a stuck close_leg intent with a flat account past the timeout is abandoned as unconfirmed, never as a fabricated success or failure", async () => {
  const store = memoryStore(null);
  const clientOrderId = "close-leg-stuck-1";
  await store.upsertPosition({
    sourceSignalId: "cab-signal-close-stuck",
    symbol: "ETHUSDT",
    status: "closing",
    environment: "vst",
    accountId: "vst-account",
    positionId: "position-1",
  });
  store.data.intents.push({
    sourceSignalId: "cab-signal-close-stuck",
    phase: "close",
    clientOrderId,
    request: {
      operation: "close_leg",
      environment: "vst",
      accountId: "vst-account",
      symbol: "ETHUSDT",
      positionId: "position-1",
      quantity: "1",
      previousQuantity: "1",
      intentCreatedAt: NOW - 11 * 60 * 1000,
    },
    state: "unknown",
  });
  // Flat account is this operation's own SUCCESS signal, not proof it never
  // happened -- and there is no verified fill/PnL to commit either. This
  // must resolve as a distinct "unconfirmed outcome" rather than reusing the
  // flat-account-abandon reason other operations get, and without ever
  // fabricating a close.
  const broker = guardedBroker(store, { currentPosition: null });
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  const intent = store.data.intents.find((row) => row.clientOrderId === clientOrderId);
  assert.equal(intent.state, "failed");
  assert.equal(intent.detail.outcome.reason, "close_leg_abandoned_unconfirmed_outcome");
  // No fabricated fill or PnL: the outcome carries only the give-up reason.
  assert.equal(intent.detail.outcome.fill, undefined);
  assert.equal(store.data.status, "error");
  // Genuinely ambiguous -- move the position to the terminal "error" status
  // (excluded from listOpenPositions) so nothing keeps acting on it, the
  // same way the margin_top_up precedent clears its own gate.
  const position = store.data.positions.find((row) =>
    row.sourceSignalId === "cab-signal-close-stuck");
  assert.equal(position.snapshot.status, "error");
  const secondTick = await worker.runOnce();
  assert.ok(
    !(secondTick.kind === "blocked" && secondTick.reason === "unresolved_vst_order_intents"),
    `expected the pipeline to stop blocking on the abandoned close, got ${JSON.stringify(secondTick)}`,
  );
});

test("a stuck close_leg intent is abandoned without touching the position when a fresh read proves it never closed", async () => {
  const store = memoryStore(null);
  const clientOrderId = "close-leg-stuck-2";
  // No position record is created here: the point of this test is the
  // reconciliation verdict on the INTENT itself. Since case 1 never calls
  // upsertPosition, there is nothing to write, and pairing a full open
  // position with this deliberately minimal fixture would only pull in
  // managePosition's own (unrelated) verification pass later in the same
  // tick, which reacts to the incomplete fixture on its own terms.
  store.data.intents.push({
    sourceSignalId: "cab-signal-close-stuck-2",
    phase: "close",
    clientOrderId,
    request: {
      operation: "close_leg",
      environment: "vst",
      accountId: "vst-account",
      symbol: "ETHUSDT",
      positionId: "position-1",
      quantity: "1",
      previousQuantity: "1",
      intentCreatedAt: NOW - 11 * 60 * 1000,
    },
    state: "unknown",
  });
  // A fresh read finds the SAME position at EXACTLY its pre-close quantity:
  // strong, specific proof this close attempt never executed. Safe to give
  // up on the intent alone -- nothing was lost.
  const broker = guardedBroker(store, {
    currentPosition: { symbol: "ETHUSDT", positionId: "position-1", quantity: "1" },
  });
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  const intent = store.data.intents.find((row) => row.clientOrderId === clientOrderId);
  assert.equal(intent.state, "failed");
  assert.equal(intent.detail.outcome.reason, "close_leg_abandoned_confirmed_still_open");
  assert.equal(store.data.status, "error");
  // No position record was ever written by this path -- proven-still-open
  // never touches store.upsertPosition, unlike the ambiguous case below.
  assert.equal(store.data.positions.length, 0);
  const secondTick = await worker.runOnce();
  assert.ok(
    !(secondTick.kind === "blocked" && secondTick.reason === "unresolved_vst_order_intents"),
    `expected the pipeline to stop blocking on the abandoned close, got ${JSON.stringify(secondTick)}`,
  );
});

test("a stuck close_leg intent past the timeout stays unresolved, never terminally errored, while the confirmation read itself keeps failing", async () => {
  const store = memoryStore(null);
  const clientOrderId = "close-leg-read-outage-1";
  await store.upsertPosition({
    sourceSignalId: "cab-signal-close-read-outage",
    symbol: "ETHUSDT",
    status: "closing",
    environment: "vst",
    accountId: "vst-account",
    positionId: "position-1",
  });
  store.data.intents.push({
    sourceSignalId: "cab-signal-close-read-outage",
    phase: "close",
    clientOrderId,
    request: {
      operation: "close_leg",
      environment: "vst",
      accountId: "vst-account",
      symbol: "ETHUSDT",
      positionId: "position-1",
      quantity: "1",
      previousQuantity: "1",
      intentCreatedAt: NOW - 11 * 60 * 1000,
    },
    state: "unknown",
  });
  // The confirmation read itself fails on every call -- a transient
  // exchange/network outage, not evidence about the position. This must
  // NOT be treated the same as a successful-but-ambiguous read: the intent
  // stays unresolved (state "unknown") and the position must not be
  // silently retired into the terminal "error" status just because the
  // exchange was briefly unreachable.
  const broker = guardedBroker(store, {
    currentPosition: null,
    readAccountStateError: new Error("simulated exchange outage"),
  });
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  const intent = store.data.intents.find((row) => row.clientOrderId === clientOrderId);
  assert.equal(intent.state, "unknown");
  assert.equal(intent.detail.outcome.reason, "exchange_state_not_verified");
  // The abandon-evidence path itself never touches the position record on
  // "read_unavailable" -- but ordinary per-tick position management also
  // reacts to the same read failure independently and may mark the
  // position "unknown" pending re-verification. Either way, the position
  // must still be one of listOpenPositions()'s actively-tracked statuses
  // (never the terminal "error" this fix exists to prevent here).
  const position = store.data.positions.find((row) =>
    row.sourceSignalId === "cab-signal-close-read-outage");
  assert.notEqual(position.snapshot.status, "error");
  assert.notEqual(store.data.status, "error");
  // A second consecutive tick with the outage still ongoing must behave the
  // same way -- repeated failure is still silence, not new evidence, so it
  // must not eventually be waved through as ambiguous or confirmed either.
  await worker.runOnce();
  const intentAfterSecondTick = store.data.intents.find((row) =>
    row.clientOrderId === clientOrderId);
  assert.equal(intentAfterSecondTick.state, "unknown");
  const positionAfterSecondTick = store.data.positions.find((row) =>
    row.sourceSignalId === "cab-signal-close-read-outage");
  assert.notEqual(positionAfterSecondTick.snapshot.status, "error");
  assert.notEqual(store.data.status, "error");
});

test("a stuck close_leg intent resolves normally once the confirmation read recovers after an outage", async () => {
  const store = memoryStore(null);
  const clientOrderId = "close-leg-read-outage-2";
  store.data.intents.push({
    sourceSignalId: "cab-signal-close-read-recovers",
    phase: "close",
    clientOrderId,
    request: {
      operation: "close_leg",
      environment: "vst",
      accountId: "vst-account",
      symbol: "ETHUSDT",
      positionId: "position-1",
      quantity: "1",
      previousQuantity: "1",
      intentCreatedAt: NOW - 11 * 60 * 1000,
    },
    state: "unknown",
  });
  // First call fails (outage); once it recovers, the read finds the SAME
  // position at EXACTLY its pre-close quantity -- the ordinary
  // "confirmed_still_open" evidence path from the test above. The prior
  // failed attempt must not have consumed or corrupted this intent's one
  // give-up opportunity.
  let calls = 0;
  const broker = guardedBroker(store, {
    currentPosition: { symbol: "ETHUSDT", positionId: "position-1", quantity: "1" },
    readAccountStateError: () => (calls++ === 0 ? new Error("simulated exchange outage") : null),
  });
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  assert.equal(
    store.data.intents.find((row) => row.clientOrderId === clientOrderId).state,
    "unknown",
  );
  await worker.runOnce();
  const intent = store.data.intents.find((row) => row.clientOrderId === clientOrderId);
  assert.equal(intent.state, "failed");
  assert.equal(intent.detail.outcome.reason, "close_leg_abandoned_confirmed_still_open");
  assert.equal(store.data.status, "error");
});

test("a stuck close_leg intent stays unknown before the timeout even with a flat account", async () => {
  const store = memoryStore(null);
  const clientOrderId = "close-leg-stuck-3";
  store.data.intents.push({
    sourceSignalId: "cab-signal-close-stuck-3",
    phase: "close",
    clientOrderId,
    request: {
      operation: "close_leg",
      environment: "vst",
      accountId: "vst-account",
      symbol: "ETHUSDT",
      positionId: "position-1",
      quantity: "1",
      previousQuantity: "1",
      // Well inside the give-up window -- could still be ordinary exchange
      // indexing lag, not yet safe to conclude anything.
      intentCreatedAt: NOW - 60 * 1000,
    },
    state: "unknown",
  });
  const broker = guardedBroker(store, { currentPosition: null });
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  const intent = store.data.intents.find((row) => row.clientOrderId === clientOrderId);
  assert.equal(intent.state, "unknown");
});

test("a stuck close_leg intent stays unknown past the timeout when the position quantity does not match pre-close expectations", async () => {
  const store = memoryStore(null);
  const clientOrderId = "close-leg-stuck-4";
  await store.upsertPosition({
    sourceSignalId: "cab-signal-close-stuck-4",
    symbol: "ETHUSDT",
    status: "closing",
    environment: "vst",
    accountId: "vst-account",
    positionId: "position-1",
  });
  store.data.intents.push({
    sourceSignalId: "cab-signal-close-stuck-4",
    phase: "close",
    clientOrderId,
    request: {
      operation: "close_leg",
      environment: "vst",
      accountId: "vst-account",
      symbol: "ETHUSDT",
      positionId: "position-1",
      quantity: "0.4",
      previousQuantity: "1",
      intentCreatedAt: NOW - 11 * 60 * 1000,
    },
    state: "unknown",
  });
  // A reduced (but nonzero) quantity is consistent with a partial fill --
  // this must NOT be treated as "confirmed still open, nothing happened".
  const broker = guardedBroker(store, {
    currentPosition: { symbol: "ETHUSDT", positionId: "position-1", quantity: "0.6" },
  });
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  const intent = store.data.intents.find((row) => row.clientOrderId === clientOrderId);
  // Ambiguous, not proven either way -- resolves via the unconfirmed path,
  // not the confirmed-still-open one.
  assert.equal(intent.state, "failed");
  assert.equal(intent.detail.outcome.reason, "close_leg_abandoned_unconfirmed_outcome");
});

test("a stuck close_split_all intent is abandoned without touching the position when a fresh read proves it never closed", async () => {
  const store = memoryStore(null);
  const clientOrderId = "close-split-all-stuck-1";
  // No position record is created here for the same reason as the close_leg
  // proven-still-open test above: this checks the reconciliation verdict on
  // the intent itself, not an interaction with managePosition's own
  // (unrelated) per-tick verification of a full position fixture.
  store.data.intents.push({
    sourceSignalId: "cab-signal-split-all-stuck",
    phase: "close",
    clientOrderId,
    request: {
      operation: "close_split_all",
      environment: "vst",
      accountId: "vst-account",
      symbol: "ETHUSDT",
      positionId: "position-1",
      totalQuantity: "0.1",
      intentCreatedAt: NOW - 11 * 60 * 1000,
    },
    state: "unknown",
  });
  const broker = guardedBroker(store, {
    currentPosition: { symbol: "ETHUSDT", positionId: "position-1", quantity: "0.1" },
  });
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  const intent = store.data.intents.find((row) => row.clientOrderId === clientOrderId);
  assert.equal(intent.state, "failed");
  assert.equal(intent.detail.outcome.reason, "close_split_all_abandoned_confirmed_still_open");
  assert.equal(store.data.status, "error");
  assert.equal(store.data.positions.length, 0);
});

test("a stuck close_leg intent stays unconfirmed, not confirmed still open, when a live non-stop order remains for the symbol", async () => {
  const store = memoryStore(null);
  const clientOrderId = "close-leg-stuck-live-order";
  // The position sits at exactly its pre-close quantity, which alone would
  // satisfy confirmedStillOpenAtExpectedQuantity -- but a still-open MARKET
  // order for the same symbol means the close attempt's fate is unproven: it
  // could still fill moments later. This must NOT be waved through as
  // "confirmed still open, safe to retry", or a fresh close submitted by
  // normal position management could race a second order against this one.
  store.data.intents.push({
    sourceSignalId: "cab-signal-close-live-order",
    phase: "close",
    clientOrderId,
    request: {
      operation: "close_leg",
      environment: "vst",
      accountId: "vst-account",
      symbol: "ETHUSDT",
      positionId: "position-1",
      quantity: "1",
      previousQuantity: "1",
      intentCreatedAt: NOW - 11 * 60 * 1000,
    },
    state: "unknown",
  });
  const broker = guardedBroker(store, {
    currentPosition: { symbol: "ETHUSDT", positionId: "position-1", quantity: "1" },
    openOrders: [{
      symbol: "ETHUSDT", type: "MARKET", status: "NEW", side: "SELL", orderId: "9001",
    }],
  });
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  const intent = store.data.intents.find((row) => row.clientOrderId === clientOrderId);
  assert.equal(intent.state, "failed");
  assert.equal(intent.detail.outcome.reason, "close_leg_abandoned_unconfirmed_outcome");
  assert.equal(store.data.status, "error");
});

test("a stuck close_leg intent is confirmed still open when the only resting order is the position's own protective stop", async () => {
  const store = memoryStore(null);
  const clientOrderId = "close-leg-stuck-own-stop";
  // A STOP_MARKET order for the same symbol is the position's own,
  // expected protective stop -- every genuinely still-open position carries
  // one. Its presence must not, by itself, block the confirmed-still-open
  // verdict, or that path would never be reachable in practice.
  store.data.intents.push({
    sourceSignalId: "cab-signal-close-own-stop",
    phase: "close",
    clientOrderId,
    request: {
      operation: "close_leg",
      environment: "vst",
      accountId: "vst-account",
      symbol: "ETHUSDT",
      positionId: "position-1",
      quantity: "1",
      previousQuantity: "1",
      intentCreatedAt: NOW - 11 * 60 * 1000,
    },
    state: "unknown",
  });
  const broker = guardedBroker(store, {
    currentPosition: { symbol: "ETHUSDT", positionId: "position-1", quantity: "1" },
    openOrders: [{
      symbol: "ETHUSDT", type: "STOP_MARKET", status: "NEW", side: "SELL", orderId: "9002",
    }],
  });
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  const intent = store.data.intents.find((row) => row.clientOrderId === clientOrderId);
  assert.equal(intent.state, "failed");
  assert.equal(intent.detail.outcome.reason, "close_leg_abandoned_confirmed_still_open");
  assert.equal(store.data.positions.length, 0);
});

test("a stuck close_survivor intent stays unconfirmed, not confirmed still open, when the observed position is a different position on the same symbol", async () => {
  const store = memoryStore(null);
  const clientOrderId = "close-survivor-stuck-wrong-position";
  // Same symbol and same quantity, but a DIFFERENT exchange positionId --
  // a coincidence, not proof the targeted close attempt never executed.
  // Requiring positionId to match (when the request carries one) prevents
  // this from being waved through as "confirmed still open".
  store.data.intents.push({
    sourceSignalId: "cab-signal-survivor-wrong-position",
    phase: "close",
    clientOrderId,
    request: {
      operation: "close_survivor",
      environment: "vst",
      accountId: "vst-account",
      symbol: "ETHUSDT",
      positionId: "position-1",
      quantity: "1",
      intentCreatedAt: NOW - 11 * 60 * 1000,
    },
    state: "unknown",
  });
  const broker = guardedBroker(store, {
    currentPosition: { symbol: "ETHUSDT", positionId: "position-2", quantity: "1" },
  });
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  const intent = store.data.intents.find((row) => row.clientOrderId === clientOrderId);
  assert.equal(intent.state, "failed");
  assert.equal(intent.detail.outcome.reason, "close_survivor_abandoned_unconfirmed_outcome");
  assert.equal(store.data.status, "error");
});

test("one slow tick retires expired pending signals before reaching a fresh candidate", async () => {
  const store = memoryStore(null);
  const rows = [
    { sourceSignalId: "stale-a", status: "pending",
      body: { ...signal, sourceSignalId: "stale-a",
        signalAt: new Date(NOW - 11 * 60_000).toISOString() } },
    { sourceSignalId: "stale-b", status: "pending",
      body: { ...signal, sourceSignalId: "stale-b",
        signalAt: new Date(NOW - 12 * 60_000).toISOString() } },
    { sourceSignalId: "fresh", status: "pending",
      body: { ...signal, sourceSignalId: "fresh", symbol: "INVALID-SYMBOL",
        signalAt: new Date(NOW).toISOString() } },
  ];
  store.listPendingCandidates = async () => rows.filter((row) => row.status === "pending");
  store.setSignalStatus = async (id, status, reason) => {
    const row = rows.find((candidate) => candidate.sourceSignalId === id);
    row.status = status;
    row.reason = reason;
  };
  const broker = guardedBroker(store, {
    onPerform: async () => { assert.fail("no exchange write is permitted"); },
  });
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: { environment: "vst" },
  });
  const result = await worker.runOnce();
  assert.equal(result.kind, "rejected");
  assert.equal(result.reason, "invalid_canonical_vst_symbol",
    "the fresh signal was reached in the same tick");
  assert.deepEqual(rows.map((row) => row.status),
    ["rejected", "rejected", "rejected"]);
  assert.deepEqual(rows.slice(0, 2).map((row) => row.reason),
    ["not_a_fresh_approved_v2_long", "not_a_fresh_approved_v2_long"]);
  assert.equal(store.data.intents.length, 0);
  assert.equal(store.data.events.filter((event) =>
    event[1] === "vst_signal_rejected").length, 3);
});

test("keyset scan reaches another symbol after 200 blocked signals even when stale rows change status mid-scan", async () => {
  const store = memoryStore(null);
  const receivedAt = (index) => new Date(NOW + index).toISOString();
  const stale = {
    sourceSignalId: "cab-signal-stale-000",
    body: {
      ...activePolicy({ stopLoss: "95" }),
      sourceSignalId: "cab-signal-stale-000",
      symbol: "XRPUSDT",
      signalAt: new Date(NOW - 11 * 60_000).toISOString(),
    },
    status: "pending",
    receivedAt: receivedAt(0),
  };
  const blockedRows = Array.from({ length: 200 }, (_, index) => {
    const id = `cab-signal-blocked-${String(index).padStart(3, "0")}`;
    return {
      sourceSignalId: id,
      body: {
        ...activePolicy({ stopLoss: "95" }),
        sourceSignalId: id,
        symbol: "XRPUSDT",
        signalAt: new Date(NOW).toISOString(),
      },
      status: "pending",
      receivedAt: receivedAt(index + 1),
    };
  });
  const eligible = {
    sourceSignalId: "cab-signal-eligible-201",
    body: {
      ...activePolicy({ stopLoss: "95" }),
      sourceSignalId: "cab-signal-eligible-201",
      symbol: "ETHUSDT",
      signalAt: new Date(NOW).toISOString(),
    },
    status: "pending",
    receivedAt: receivedAt(201),
  };
  const rows = [stale, ...blockedRows, eligible];
  installPagedCandidates(store, rows);
  store.setSignalStatus = async (id, status, reason = null) => {
    const row = rows.find((candidate) => candidate.sourceSignalId === id);
    if (row) Object.assign(row, { status, reason });
    store.data.status = status;
    store.data.reason = reason;
  };
  const pageRequests = [];
  const listPage = store.listPendingCandidatesPage;
  store.listPendingCandidatesPage = async (options) => {
    pageRequests.push(options);
    return listPage(options);
  };
  const brokerActions = [];
  const broker = guardedBroker(store, {
    currentPosition: null,
    onPerform: async (intent) => { brokerActions.push(intent.request.operation); },
    reconcile: async () => ({
      verified: true,
      status: "filled",
      position: { marginMode: "ISOLATED", leverage: 10 },
    }),
  });
  broker.readAccountState = async () => ({
    verified: true,
    positions: [{ symbol: "XRP-USDT" }],
    openOrders: [],
  });
  broker.readPlanningInputs = async () => safePlanningInputs();
  const worker = createVstWorker({
    store,
    broker,
    clock: () => NOW,
    sizingLimits: {
      environment: "vst",
      maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500,
      maxSlippageBps: 100,
    },
  });

  const result = await worker.runOnce();

  assert.equal(result.kind, "prepared", JSON.stringify(result));
  assert.equal(store.data.status, "planning");
  assert.equal(stale.status, "rejected", "expired untouched row is retired once");
  assert.equal(brokerActions.length, 1, "the tick performs at most one exchange action");
  assert.equal(pageRequests.length, 2, "the page after the first 200 contains the eligible signal");
  assert.equal(pageRequests[0].after, null);
  assert.equal(
    pageRequests[1].after.sourceSignalId,
    blockedRows[198].sourceSignalId,
    "cursor comes from the last fetched row, not rows remaining after stale status changed",
  );
});

test("keyset scan reaches candidate 6001 in one tick and restarts at priority head next tick", async () => {
  const store = memoryStore(null);
  const rows = Array.from({ length: 6_001 }, (_, index) => {
    const blocked = index < 6_000;
    const id = blocked
      ? `cab-signal-blocked-${String(index).padStart(4, "0")}`
      : "cab-signal-eligible-6001";
    return {
      sourceSignalId: id,
      body: {
        ...activePolicy({ stopLoss: "95" }),
        sourceSignalId: id,
        symbol: blocked ? "XRPUSDT" : "ETHUSDT",
        signalAt: new Date(NOW).toISOString(),
      },
      status: "pending",
      receivedAt: new Date(NOW + index).toISOString(),
    };
  });
  installPagedCandidates(store, rows);
  const pageRequests = [];
  const timings = [];
  const listPage = store.listPendingCandidatesPage;
  store.listPendingCandidatesPage = async (options) => {
    pageRequests.push(options);
    return listPage(options);
  };
  const brokerActions = [];
  const broker = guardedBroker(store, {
    currentPosition: null,
    onPerform: async (intent) => {
      brokerActions.push(intent.request.operation);
      if (brokerActions.length === 1) {
        const id = "cab-signal-newly-inflight";
        rows.push({
          sourceSignalId: id,
          body: {
            ...activePolicy({ stopLoss: "95" }),
            sourceSignalId: id,
            symbol: "ETHUSDT",
            signalAt: new Date(NOW).toISOString(),
          },
          status: "planning",
          receivedAt: new Date(NOW - 1).toISOString(),
        });
      }
    },
    reconcile: async () => ({
      verified: true,
      status: "filled",
      position: { marginMode: "ISOLATED", leverage: 10 },
    }),
  });
  broker.readAccountState = async () => ({
    verified: true,
    positions: [{ symbol: "XRP-USDT" }],
    openOrders: [],
  });
  broker.readPlanningInputs = async () => safePlanningInputs();
  store.setSignalStatus = async (id, status, reason = null) => {
    const row = rows.find((candidate) => candidate.sourceSignalId === id);
    if (row) Object.assign(row, { status, reason });
    store.data.status = status;
    store.data.reason = reason;
  };
  const worker = createVstWorker({
    store,
    broker,
    clock: () => NOW,
    sizingLimits: {
      environment: "vst",
      maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500,
      maxSlippageBps: 100,
    },
    onTiming: async (timing) => { timings.push(timing); },
  });

  const firstTick = await worker.runOnce();
  assert.equal(firstTick.kind, "prepared", JSON.stringify(firstTick));
  assert.equal(pageRequests.length, 31, "the eligible 6,001st row is reached in the same tick");
  assert.equal(pageRequests[0].after, null, "every candidate scan starts at the ordered head");
  assert.equal(
    pageRequests.at(-1).after.sourceSignalId,
    "cab-signal-blocked-5999",
    "the final page follows all 6,000 blocked rows",
  );
  assert.equal(brokerActions.length, 1, "the tick performs at most one exchange action");
  assert.equal(timings[0].candidateScan.pages, 31);
  assert.equal(timings[0].candidateScan.candidates, 6_001);
  assert.ok(Number.isSafeInteger(timings[0].candidateScan.elapsedMs));
  assert.ok(timings[0].candidateScan.elapsedMs >= 0);

  const secondTick = await worker.runOnce();
  assert.equal(secondTick.kind, "prepared", JSON.stringify(secondTick));
  assert.equal(pageRequests.length, 32, "the next tick scans one page for the new in-flight row");
  assert.equal(pageRequests[31].after, null, "no previous-tick cursor is retained");
  assert.equal(
    store.data.intents.at(-1).sourceSignalId,
    "cab-signal-newly-inflight",
    "new planning work ahead of the previous scan is selected first",
  );
  assert.equal(brokerActions.length, 2, "the second tick also performs only one exchange action");
});

test("a margin top-up stuck on one symbol no longer blocks a brand-new candidate on a different symbol", async () => {
  // Same production bug as the unresolved-intent case above, but reached via
  // the margin-top-up gate instead: an open ETHUSDT position with a pending
  // margin top-up must not stop a fresh BTCUSDT signal from being planned.
  const btcSignal = {
    ...activePolicy({ stopLoss: "95" }),
    sourceSignalId: "cab-signal-btc-fresh",
    symbol: "ETHUSDT",
    signalAt: new Date(NOW).toISOString(),
  };
  function multiCandidateStore() {
    const base = memoryStore(null);
    base.data.positions.push({
      sourceSignalId: "cab-signal-sol-stuck-margin",
      symbol: "SOLUSDT",
      status: "open",
      snapshot: {
        sourceSignalId: "cab-signal-sol-stuck-margin",
        symbol: "SOLUSDT",
        environment: "vst",
        accountId: "vst-account",
        marginTopUp: { status: "pending" },
      },
    });
    base.data.pending = { sourceSignalId: btcSignal.sourceSignalId, body: btcSignal, status: "pending" };
    base.listPendingCandidates = async () =>
      base.data.pending ? [base.data.pending] : [];
    return base;
  }
  const store = multiCandidateStore();
  const broker = guardedBroker(store, {
    currentPosition: null,
    reconcile: async () => ({
      verified: true, status: "filled", position: { marginMode: "ISOLATED", leverage: 10 },
    }),
  });
  broker.readPlanningInputs = async () => safePlanningInputs();
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  const result = await worker.runOnce();
  assert.equal(result.kind, "prepared", JSON.stringify(result));
  assert.equal(store.data.status, "planning");

  // The mirror case: a fresh candidate on the SAME stuck symbol must still
  // be held back, since its own margin/exposure state is unresolved.
  const sameSymbolStore = multiCandidateStore();
  sameSymbolStore.data.pending = {
    sourceSignalId: "cab-signal-sol-fresh-blocked",
    body: { ...btcSignal, sourceSignalId: "cab-signal-sol-fresh-blocked", symbol: "SOLUSDT" },
    status: "pending",
  };
  const sameSymbolBroker = guardedBroker(sameSymbolStore, { currentPosition: null });
  sameSymbolBroker.readPlanningInputs = async () => safePlanningInputs();
  const sameSymbolWorker = createVstWorker({
    store: sameSymbolStore, broker: sameSymbolBroker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  const sameSymbolResult = await sameSymbolWorker.runOnce();
  assert.equal(sameSymbolResult.kind, "blocked", JSON.stringify(sameSymbolResult));
  assert.equal(sameSymbolResult.reason, "vst_margin_top_up_requires_verified_reconciliation");
});

test("a stuck margin_top_up intent is abandoned once flat past the timeout and clears the position's own gate", async () => {
  const store = memoryStore(null);
  const clientOrderId = "margin-top-up-stuck-1";
  await store.upsertPosition({
    sourceSignalId: "cab-signal-margin-stuck",
    symbol: "ETHUSDT",
    status: "open",
    environment: "vst",
    accountId: "vst-account",
    positionId: "position-1",
    marginTopUp: { status: "pending" },
  });
  store.data.intents.push({
    sourceSignalId: "cab-signal-margin-stuck",
    phase: "margin-top-up",
    clientOrderId,
    request: {
      operation: "margin_top_up",
      environment: "vst",
      accountId: "vst-account",
      symbol: "ETHUSDT",
      positionId: "position-1",
      entryOrderId: "exchange-1",
      quantity: "1",
      stopLoss: "90",
      stopOrderId: "stop-1",
      expectedIsolatedMarginBefore: "10",
      amount: "2.5",
      approvedTopUpMargin: "2.5",
      intentCreatedAt: NOW - 11 * 60 * 1000,
    },
    state: "unknown",
  });
  const broker = guardedBroker(store, { currentPosition: null });
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  const intent = store.data.intents.find((row) => row.clientOrderId === clientOrderId);
  assert.equal(intent.state, "failed");
  assert.equal(intent.detail.outcome.reason, "margin_top_up_abandoned_confirmed_flat_account");
  // margin_top_up keeps its own established pattern: the signal goes to
  // "unknown" for manual review (via flagMarginTopUpUnconfirmed), never the
  // generic "error" other operations get, and the position's own gate clears.
  assert.equal(store.data.status, "unknown");
  const position = store.data.positions.find((row) =>
    row.sourceSignalId === "cab-signal-margin-stuck");
  assert.equal(position.snapshot.marginTopUp.status, "failed");
  // Resolving the intent alone is not enough: the position's own
  // unresolvedMarginTopUp gate in runOnce() checks marginTopUp.status
  // independent of intent state, so it must also move the position to the
  // dedicated terminal "error" status (excluded from listOpenPositions) --
  // "unknown" would not clear the gate, since that status already means
  // "ambiguous, may still be open" elsewhere and must keep blocking.
  // Otherwise this single confirmed-gone position blocks every future
  // signal forever even though its intent is already resolved.
  assert.equal(position.snapshot.status, "error");
  const secondTick = await worker.runOnce();
  assert.ok(
    !(secondTick.kind === "blocked" &&
      secondTick.reason === "vst_margin_top_up_requires_verified_reconciliation"),
    `expected the pipeline to stop blocking on the abandoned margin top-up, got ${JSON.stringify(secondTick)}`,
  );
});

test("margin preparation that outlives signal freshness cannot proceed to leverage", async () => {
  const signalBody = activePolicy({ stopLoss: "95" });
  const store = memoryStore(signalBody);
  let now = NOW;
  const operations = [];
  const broker = guardedBroker(store, {
    currentPosition: null,
    onPerform: async ({ request }) => {
      operations.push(request.operation);
      now = NOW + 10 * 60_000 + 1;
    },
    reconcile: async () => ({
      verified: true, status: "filled", marginMode: "ISOLATED",
    }),
  });
  broker.readPlanningInputs = async () =>
    safePlanningInputs({ marginMode: "CROSSED", requiresIsolatedMarginPreparation: true });

  const result = await createVstWorker({
    store,
    broker,
    clock: () => now,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  }).runOnce();

  assert.equal(result.kind, "rejected");
  assert.equal(result.reason, "signal_expired_during_margin_mode_preparation");
  assert.deepEqual(operations, ["prepare_margin_mode"]);
  assert.equal(store.data.status, "rejected");
  assert.equal(store.data.intents[0].state, "reconciled");
});

test("unknown stop-upgrade evidence leaves old stop snapshot and intent unresolved", async () => {
  const signalBody = activePolicy();
  const store = memoryStore(null);
  const policy = createVstPolicy({
    signal: signalBody,
    fill: { price: 100, quantity: 10, at: new Date(NOW).toISOString() },
  });
  await store.upsertPosition({
    ...policy,
    sourceSignalId: signalBody.sourceSignalId,
    status: "open",
    sizing: { quantity: "10" },
    marginMode: "ISOLATED",
    leverage: 10,
    environment: "vst",
    accountId: "vst-account",
  });
  const position = {
    verified: true,
    symbol: "ETHUSDT",
    positionId: "position-unknown-upgrade-1",
    side: "Buy",
    quantity: 10,
    avgPrice: 100,
    leverage: 10,
    marginMode: "ISOLATED",
    pricePrecision: 2,
    protectiveStops: {
      core: { verified: true, stopPrice: 90, quantity: 10, orderId: "core-stop-1" },
    },
  };
  position.protectiveStops.core.positionId = position.positionId;
  seedRaiseStopEntry(store, {
    sourceSignalId: signalBody.sourceSignalId,
    symbol: signalBody.symbol,
    positionId: position.positionId,
    clientOrderId: "entry-confirmed",
    exchangeOrderId: "entry-order-unknown-upgrade-1",
    quantity: "10",
    stop: position.protectiveStops.core,
  });
  const broker = guardedBroker(store, {
    currentPosition: position,
    reconcile: async () => ({ verified: false, status: "unknown" }),
  });
  const result = await createVstWorker({
    store, broker, clock: () => NOW, sizingLimits: { environment: "vst" },
  }).runOnce();
  assert.equal(result.kind, "unknown");
  assert.equal(result.reason, "exchange_action_not_confirmed");
  assert.equal(store.data.intents.length, 2);
  assert.equal(store.data.intents.find((intent) =>
    intent.request.operation === "raise_stop").state, "unknown");
  assert.equal(store.data.positions[0].snapshot.stopPrice, 90);
});

test("recovered impulse entry with incorrect split stop facts stays unknown without retry", async () => {
  const impulse = activePolicy({ patternId: "impulse_buy" });
  const fixture = impulseLifecycleFixture({
    mutateEvidence: (request, evidence) => {
      if (request.operation === "split_core_stop") {
        evidence.protectiveStops.core.quantity = Number(request.coreQuantity) - 0.001;
        evidence.stop.quantity = String(Number(request.coreQuantity) - 0.001);
      }
      return evidence;
    },
  });
  fixture.store.data.pending = null;
  fixture.store.data.intents = [{
    sourceSignalId: impulse.sourceSignalId,
    phase: "market-entry",
    clientOrderId: "vst-recovered-impulse",
    request: {
      operation: "entry",
      environment: "vst",
      accountId: "vst-account",
      symbol: impulse.symbol,
      signal: impulse,
      sizing: { quantity: "10" },
      impulseSplit: {
        totalQuantity: "10", coreQuantity: "8", runnerQuantity: "2",
        quantityPrecision: 3, pricePrecision: 2, minQuantity: "0.001",
      },
    },
    state: "submitted",
  }];
  const originalEntryReconcile = fixture.broker.reconcileIntent;
  fixture.broker.reconcileIntent = async (intent) => {
    if (intent.request.operation === "entry") {
      const quantity = 10;
      fixture.exchange.position = {
        positionId: "impulse-position-1",
        quantity,
        avgPrice: 100,
        protectiveStops: {
          core: {
            verified: true, orderId: "impulse-original-stop",
            positionId: "impulse-position-1", quantity, stopPrice: 90,
          },
        },
      };
      fixture.exchange.orders = [fixture.makeOpenStop(
        "impulse-original-stop", "impulse-position-1", quantity, 90,
        "impulse-entry-order",
      )];
      return {
        verified: true, status: "filled", exchangeOrderId: "impulse-entry-order",
        fill: { price: 100, quantity, at: new Date(NOW).toISOString() },
        position: {
          verified: true, symbol: impulse.symbol, positionId: "impulse-position-1",
          side: "Buy", quantity, avgPrice: 100, leverage: 10, marginMode: "ISOLATED",
        },
        protectiveStops: {
          core: {
            verified: true, orderId: "impulse-original-stop",
            positionId: "impulse-position-1", quantity, stopPrice: 90,
          },
        },
      };
    }
    return originalEntryReconcile(intent);
  };
  const worker = createVstWorker({
    store: fixture.store,
    broker: fixture.broker,
    clock: () => NOW,
    sizingLimits: { environment: "vst" },
  });
  const result = await worker.runOnce();
  assert.equal(result.kind, "unknown");
  assert.equal(fixture.store.data.intents.find((row) =>
    row.phase === "impulse-split_core_stop").state, "unknown");
  assert.equal(fixture.store.data.positions[0].snapshot.split.stage, "core_pending");
  assert.equal(fixture.store.data.positions[0].snapshot.status, "unknown");
  assert.equal(fixture.mutations.filter((operation) =>
    operation === "split_core_stop").length, 1);
  assert.equal(fixture.store.data.pending, null);
});

test("an ambiguous impulse stop write is never retried after restart", async () => {
  const fixture = impulseLifecycleFixture({ failOperation: "split_core_stop" });
  let worker = createVstWorker({
    store: fixture.store, broker: fixture.broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  assert.equal((await worker.runOnce()).kind, "unknown");
  worker = createVstWorker({
    store: fixture.store, broker: fixture.broker, clock: () => NOW,
    sizingLimits: { environment: "vst" },
  });
  assert.equal((await worker.runOnce()).kind, "blocked");
  assert.equal(fixture.mutations.filter((operation) =>
    operation === "split_core_stop").length, 1);
  assert.equal(fixture.store.data.intents.filter((intent) =>
    intent.request.operation === "split_core_stop").length, 1);
  assert.ok(fixture.store.data.intents.some((intent) =>
    intent.request.operation === "split_core_stop" && intent.state === "unknown"));
});

test("policy BE, protected-profit, and trailing actions persist only after verified stop state", async () => {
  const store = memoryStore(null);
  const signalBody = activePolicy();
  const policy = createVstPolicy({
    signal: signalBody,
    fill: { price: 100, quantity: 10, at: new Date(NOW).toISOString() },
  });
  const sourceSignalId = signalBody.sourceSignalId;
  await store.upsertPosition({
    ...policy,
    sourceSignalId,
    status: "open",
    sizing: { quantity: "10" },
    marginMode: "ISOLATED",
    leverage: 10,
    environment: "vst",
    accountId: "vst-account",
    entryClientOrderId: "entry-confirmed",
  });
  const position = {
    verified: true,
    symbol: "ETHUSDT",
    positionId: "position-policy-1",
    side: "Buy",
    quantity: 10,
    avgPrice: 100,
    leverage: 10,
    marginMode: "ISOLATED",
    pricePrecision: 2,
    protectiveStops: {
      core: {
        verified: true, stopPrice: 90, quantity: 10,
        orderId: "900000", positionId: "position-policy-1",
      },
    },
  };
  seedRaiseStopEntry(store, {
    sourceSignalId,
    symbol: signalBody.symbol,
    positionId: "position-policy-1",
    clientOrderId: "entry-confirmed",
    exchangeOrderId: "entry-order-policy-1",
    quantity: "10",
    stop: position.protectiveStops.core,
  });
  let price = 105;
  let observedAt = NOW + 60_000;
  let replacementStopSequence = 1;
  const broker = guardedBroker(store, {
    currentPosition: position,
    marketMark: () => ({
      verified: true, price, observedAt: new Date(observedAt).toISOString(),
    }),
    onPerform: async ({ request }) => {
      position.protectiveStops.core = {
        verified: true,
        stopPrice: Number(request.stopPrice),
        quantity: Number(request.quantity),
        orderId: String(900000 + replacementStopSequence++),
        positionId: "position-policy-1",
      };
      return { exchangeOrderId: position.protectiveStops.core.orderId };
    },
    reconcile: async ({ request }) => ({
      verified: true,
      status: "filled",
      exchangeOrderId: position.protectiveStops.core.orderId,
      position: { ...position },
      protectiveStops: position.protectiveStops,
    }),
  });
  const worker = createVstWorker({
    store, broker, clock: () => NOW, sizingLimits: { environment: "vst" },
  });
  for (const [nextPrice, nextTime, expectedStop] of [
    [105, NOW + 60_000, 100],
    [110, NOW + 120_000, 105],
    [124, NOW + 180_000, 114],
  ]) {
    price = nextPrice;
    observedAt = nextTime;
    await worker.runOnce();
    const saved = store.data.positions.find((row) => row.sourceSignalId === sourceSignalId);
    assert.ok(Math.abs(saved.snapshot.stopPrice - expectedStop) < 1e-8);
    assert.ok(Math.abs(position.protectiveStops.core.stopPrice - expectedStop) < 1e-8);
    assert.equal(
      saved.snapshot.coreStopOrderId,
      position.protectiveStops.core.orderId,
    );
    assert.equal(saved.snapshot.exchangePositionId, "position-policy-1");
  }
  assert.deepEqual(
    store.data.intents
      .filter((intent) => intent.request.operation === "raise_stop")
      .map((intent) => intent.request.reason),
    ["breakeven_stop", "protected_profit_floor", "percentage_point_trailing_stop"],
  );
  assert.ok(store.data.intents.every((intent) => intent.state === "reconciled"));
});

test("raised stop prices are rounded up to contract precision, not rejected at the exchange boundary", async () => {
  // Regression test for production vst_events id 1 (cab-signal-12702, 2026-09-27):
  // a "Stop loss exceeds contract price precision" rejection thrown from
  // decimalAtPrecision. The initial entry stop is already rounded by
  // vst-sizing.mjs, but priceForGain (vst-policy.mjs) computes later
  // breakeven/protected-profit/trailing raises with plain floating-point
  // percentage math, e.g. 0.2964 * 1.14 = 0.33789600000000003 on a 4-decimal
  // contract. Those raises must be rounded up to pricePrecision before they
  // ever reach the exchange call, not merely rejected once they get there.
  const store = memoryStore(null);
  const signalBody = { ...activePolicy(), symbol: "ARXUSDT", stopLoss: "0.27" };
  const policy = createVstPolicy({
    signal: signalBody,
    fill: { price: 0.2964, quantity: 100, at: new Date(NOW).toISOString() },
  });
  const sourceSignalId = signalBody.sourceSignalId;
  await store.upsertPosition({
    ...policy,
    sourceSignalId,
    status: "open",
    sizing: { quantity: "100" },
    marginMode: "ISOLATED",
    leverage: 10,
    environment: "vst",
    accountId: "vst-account",
    entryClientOrderId: "entry-confirmed",
  });
  const position = {
    verified: true,
    symbol: "ARXUSDT",
    positionId: "position-precision-1",
    side: "Buy",
    quantity: 100,
    avgPrice: 0.2964,
    leverage: 10,
    marginMode: "ISOLATED",
    pricePrecision: 4,
    protectiveStops: {
      core: {
        verified: true, stopPrice: 0.27, quantity: 100,
        orderId: "910000", positionId: "position-precision-1",
      },
    },
  };
  seedRaiseStopEntry(store, {
    sourceSignalId,
    symbol: signalBody.symbol,
    positionId: "position-precision-1",
    clientOrderId: "entry-confirmed",
    exchangeOrderId: "entry-order-precision-1",
    quantity: "100",
    stop: position.protectiveStops.core,
  });
  let price = 0.2964;
  let observedAt = NOW + 60_000;
  const submittedStopPrices = [];
  let replacementStopSequence = 1;
  const broker = guardedBroker(store, {
    currentPosition: position,
    marketMark: () => ({
      verified: true, price, observedAt: new Date(observedAt).toISOString(),
    }),
    onPerform: async ({ request }) => {
      submittedStopPrices.push(request.stopPrice);
      // decimalAtPrecision's own precision contract: at most pricePrecision
      // fractional digits, expressed as a plain (non-exponential) decimal.
      assert.match(String(request.stopPrice), /^\d+(\.\d{1,4})?$/);
      position.protectiveStops.core = {
        verified: true,
        stopPrice: Number(request.stopPrice),
        quantity: Number(request.quantity),
        orderId: String(910000 + replacementStopSequence++),
        positionId: "position-precision-1",
      };
      return { exchangeOrderId: position.protectiveStops.core.orderId };
    },
    reconcile: async () => ({
      verified: true,
      status: "filled",
      exchangeOrderId: position.protectiveStops.core.orderId,
      position: { ...position },
      protectiveStops: position.protectiveStops,
    }),
  });
  const worker = createVstWorker({
    store, broker, clock: () => NOW, sizingLimits: { environment: "vst" },
  });
  for (const [nextPrice, nextTime, rawExpectedStop, roundedExpectedStop] of [
    [0.31122, NOW + 60_000, 0.2964, "0.2964"],
    [0.32604, NOW + 120_000, 0.31122, "0.3113"],
    [0.367536, NOW + 180_000, 0.33789600000000003, "0.3379"],
  ]) {
    price = nextPrice;
    observedAt = nextTime;
    await worker.runOnce();
    const saved = store.data.positions.find((row) => row.sourceSignalId === sourceSignalId);
    assert.equal(saved.snapshot.stopPrice, Number(roundedExpectedStop));
    assert.ok(Number(roundedExpectedStop) >= rawExpectedStop);
    assert.equal(position.protectiveStops.core.stopPrice, Number(roundedExpectedStop));
  }
  assert.deepEqual(submittedStopPrices, ["0.2964", "0.3113", "0.3379"]);
  assert.deepEqual(
    store.data.intents
      .filter((intent) => intent.request.operation === "raise_stop")
      .map((intent) => intent.request.reason),
    ["breakeven_stop", "protected_profit_floor", "percentage_point_trailing_stop"],
  );
  assert.ok(store.data.intents.every((intent) => intent.state === "reconciled"));
});

test("confirmed full close accepts a verified flat snapshot without a LONG side", async () => {
  const store = memoryStore(null);
  const signalBody = activePolicy();
  const policy = createVstPolicy({
    signal: signalBody,
    fill: { price: 100, quantity: 10, at: new Date(NOW).toISOString() },
  });
  const sourceSignalId = signalBody.sourceSignalId;
  await store.upsertPosition({
    ...policy,
    sourceSignalId,
    status: "open",
    sizing: { quantity: "10" },
    marginMode: "ISOLATED",
    leverage: 10,
    environment: "vst",
    accountId: "vst-account",
    entryClientOrderId: "entry-confirmed",
  });
  const position = {
    verified: true,
    symbol: "ETHUSDT",
    side: "Buy",
    quantity: 10,
    avgPrice: 100,
    leverage: 10,
    marginMode: "ISOLATED",
    pricePrecision: 2,
    protectiveStops: {
      core: { verified: true, stopPrice: 90, quantity: 10 },
    },
  };
  const broker = guardedBroker(store, {
    currentPosition: position,
    marketMark: { verified: true, price: 89, observedAt: new Date(NOW + 60_000).toISOString() },
    reconcile: async ({ request }) => ({
      verified: true,
      status: "filled",
      fill: {
        price: 89,
        quantity: 10,
        at: new Date(NOW + 60_000).toISOString(),
        fee: "0.01",
        feeCurrency: "USDT",
      },
      position: { verified: true, symbol: request.symbol, quantity: 0 },
      protectiveStops: {},
    }),
  });
  await createVstWorker({
    store, broker, clock: () => NOW, sizingLimits: { environment: "vst" },
  }).runOnce();
  const saved = store.data.positions.find((row) => row.sourceSignalId === sourceSignalId);
  assert.equal(saved.status, "closed");
  assert.equal(saved.snapshot.remainingQty, 0);
  assert.equal(saved.snapshot.lastCloseFill.price, 89);
  assert.equal(saved.snapshot.lastCloseFill.quantity, 10);
  assert.equal(saved.snapshot.lastCloseFill.fee, "0.01");
  assert.equal(saved.snapshot.lastCloseFill.fees, "0.01");
  assert.equal(saved.snapshot.lastCloseFill.feeEvidenceAvailable, true);
  assert.equal(saved.snapshot.lastCloseFill.at, new Date(NOW + 60_000).toISOString());
  assert.deepEqual(saved.snapshot.residualProtectiveStops, {});
  assert.equal(store.data.intents[0].state, "reconciled");
  assert.equal(store.data.intents[0].request.operation, "close_leg");
});

test("legacy impulse policy snapshots without completed split protection stay unknown", async () => {
  const signalBody = activePolicy({ patternId: "impulse_buy" });
  const store = memoryStore(null);
  const policy = createVstPolicy({
    signal: signalBody,
    fill: { price: 100, quantity: 10, at: new Date(NOW).toISOString() },
  });
  await store.upsertPosition({
    ...policy,
    sourceSignalId: signalBody.sourceSignalId,
    status: "open",
    sizing: { quantity: "10" },
    marginMode: "ISOLATED",
    leverage: 10,
    environment: "vst",
    accountId: "vst-account",
  });
  const position = {
    verified: true,
    symbol: "ETHUSDT",
    side: "Buy",
    quantity: 10,
    avgPrice: 100,
    leverage: 10,
    marginMode: "ISOLATED",
    pricePrecision: 2,
    protectiveStops: {
      core: { verified: true, stopPrice: 90, quantity: 8, orderId: "core-stop-1" },
      runner: { verified: true, stopPrice: 100, quantity: 2, orderId: "runner-stop-7" },
    },
  };
  let mutationCalls = 0;
  const broker = guardedBroker(store, {
    currentPosition: position,
    marketMark: { verified: true, price: 89, observedAt: new Date(NOW + 60_000).toISOString() },
    onPerform: async () => { mutationCalls += 1; },
    reconcile: async ({ request }) => ({
      verified: true,
      status: "filled",
      exchangeOrderId: "close-core-1",
      fill: {
        price: 89,
        quantity: 8,
        at: new Date(NOW + 60_000).toISOString(),
        fees: "0.02",
        feeCurrency: "USDT",
      },
      position: {
        verified: true,
        symbol: request.symbol,
        side: "Buy",
        quantity: 2,
        avgPrice: 100,
        leverage: 10,
        marginMode: "ISOLATED",
      },
      protectiveStops: {
        runner: {
          verified: true,
          stopPrice: 100,
          quantity: 2,
          orderId: "runner-stop-7",
          positionId: "position-1",
        },
      },
    }),
  });
  const result = await createVstWorker({
    store, broker, clock: () => NOW, sizingLimits: { environment: "vst" },
  }).runOnce();
  assert.equal(result.kind, "unknown");
  assert.equal(mutationCalls, 0);
  assert.equal(store.data.intents.length, 0);
  const saved = store.data.positions[0].snapshot;
  assert.equal(saved.status, "unknown");
  assert.equal(store.data.status, "unknown");
});

test("close fill quantity mismatch stays unknown and cannot commit a flat policy snapshot", async () => {
  const signalBody = activePolicy();
  const store = memoryStore(null);
  const policy = createVstPolicy({
    signal: signalBody,
    fill: { price: 100, quantity: 10, at: new Date(NOW).toISOString() },
  });
  await store.upsertPosition({
    ...policy,
    sourceSignalId: signalBody.sourceSignalId,
    status: "open",
    sizing: { quantity: "10" },
    marginMode: "ISOLATED",
    leverage: 10,
    environment: "vst",
    accountId: "vst-account",
  });
  const position = {
    verified: true,
    symbol: "ETHUSDT",
    side: "Buy",
    quantity: 10,
    avgPrice: 100,
    leverage: 10,
    marginMode: "ISOLATED",
    pricePrecision: 2,
    protectiveStops: {
      core: { verified: true, stopPrice: 90, quantity: 10, orderId: "core-stop-1" },
    },
  };
  const broker = guardedBroker(store, {
    currentPosition: position,
    marketMark: { verified: true, price: 89, observedAt: new Date(NOW + 60_000).toISOString() },
    reconcile: async ({ request }) => ({
      verified: true,
      status: "filled",
      fill: {
        price: 89,
        quantity: Number(request.quantity) - 1,
        at: new Date(NOW + 60_000).toISOString(),
        fee: "0.01",
      },
      position: { verified: true, symbol: request.symbol, quantity: 0 },
      protectiveStops: {},
    }),
  });
  const result = await createVstWorker({
    store, broker, clock: () => NOW, sizingLimits: { environment: "vst" },
  }).runOnce();
  assert.equal(result.kind, "unknown");
  assert.equal(result.reason, "close_fill_price_quantity_time_not_verified");
  assert.equal(store.data.intents[0].state, "unknown");
  assert.equal(store.data.positions[0].status, "open");
  assert.equal(store.data.positions[0].snapshot.remainingQty, 10);
  assert.equal(store.data.positions[0].snapshot.lastCloseFill, undefined);
});

function triggeredStopFixture({ observeTriggeredStop, patternId = "balanced_grind" }) {
  const signalBody = activePolicy({ patternId });
  const store = memoryStore(null);
  const policy = createVstPolicy({
    signal: signalBody,
    fill: { price: 100, quantity: 10, at: new Date(NOW).toISOString() },
  });
  const priorSnapshot = {
    ...policy,
    sourceSignalId: signalBody.sourceSignalId,
    status: "open",
    sizing: { quantity: "10" },
    marginMode: "ISOLATED",
    leverage: 10,
    environment: "vst",
    accountId: "vst-account",
    exchangePositionId: "position-stop-1",
    coreStopOrderId: "core-stop-triggered",
    coreStopPositionId: "position-stop-1",
    coreStopQuantity: 10,
    coreStopStartedAt: NOW,
  };
  return {
    signalBody,
    store,
    priorSnapshot,
    flatPosition: {
      verified: true,
      symbol: signalBody.symbol,
      side: "Buy",
      quantity: 0,
      avgPrice: 0,
      leverage: 10,
      marginMode: "ISOLATED",
      pricePrecision: 2,
      protectiveStops: {},
    },
    broker: guardedBroker(store, {
      currentPosition: {
        verified: true,
        symbol: signalBody.symbol,
        side: "Buy",
        quantity: 0,
        avgPrice: 0,
        leverage: 10,
        marginMode: "ISOLATED",
        pricePrecision: 2,
        protectiveStops: {},
      },
      observeTriggeredStop,
    }),
  };
}

function validTriggeredStopEvidence() {
  return {
    verified: true,
    status: "filled",
    parentStopId: "core-stop-triggered",
    parentStopPrice: "90",
    childOrderId: "child-market-close",
    fill: {
      orderId: "child-market-close",
      triggerOrderId: "core-stop-triggered",
      quantity: "10",
      price: "89.5",
      fee: { asset: "USDT", amount: "0.01" },
      at: new Date(NOW + 60_000).toISOString(),
    },
    residualPosition: {
      verified: true,
      positionId: "position-stop-1",
      quantity: "0",
    },
    openStops: [],
  };
}

test("natural ordinary protective stop close is committed from verified child fill evidence", async () => {
  let observed;
  const fixture = triggeredStopFixture({
    observeTriggeredStop: async (request) => {
      observed = request;
      return validTriggeredStopEvidence();
    },
  });
  await fixture.store.upsertPosition(fixture.priorSnapshot);
  const result = await createVstWorker({
    store: fixture.store,
    broker: fixture.broker,
    clock: () => NOW + 60_000,
    sizingLimits: { environment: "vst" },
  }).runOnce();
  assert.equal(result.kind, "acted");
  assert.deepEqual(observed, {
    symbol: fixture.signalBody.symbol,
    positionId: "position-stop-1",
    stopOrderId: "core-stop-triggered",
    stopQuantity: 10,
    stopPrice: 90,
    previousQuantity: 10,
    startedAt: NOW,
  });
  const saved = fixture.store.data.positions[0];
  assert.equal(saved.status, "closed");
  assert.equal(saved.snapshot.remainingQty, 0);
  assert.equal(saved.snapshot.lastCloseFill.quantity, 10);
  assert.equal(saved.snapshot.lastCloseFill.orderId, "child-market-close");
  assert.equal(saved.snapshot.triggeredStop.parentStopId, "core-stop-triggered");
  assert.equal(fixture.store.data.status, "closed");
  assert.equal(fixture.store.data.intents.length, 1);
  assert.equal(fixture.store.data.intents[0].state, "reconciled");
  assert.equal(fixture.store.data.intents[0].request.operation, "observe_triggered_stop");
  assert.equal(fixture.store.data.events[0][1], "vst_triggered_stop_verified");
});

test("triggered stop child fill mismatch remains unknown and cannot close policy", async () => {
  const evidence = validTriggeredStopEvidence();
  evidence.fill.quantity = "9";
  const fixture = triggeredStopFixture({
    observeTriggeredStop: async () => evidence,
  });
  await fixture.store.upsertPosition(fixture.priorSnapshot);
  const result = await createVstWorker({
    store: fixture.store,
    broker: fixture.broker,
    clock: () => NOW + 60_000,
    sizingLimits: { environment: "vst" },
  }).runOnce();
  assert.equal(result.kind, "unknown");
  assert.equal(fixture.store.data.positions[0].status, "unknown");
  assert.equal(fixture.store.data.positions[0].snapshot.remainingQty, 10);
  assert.equal(fixture.store.data.intents.length, 0);
  assert.equal(fixture.store.data.events.length, 0);
});

test("triggered stop synthetic intent commit replays without duplicate events", async () => {
  const fixture = triggeredStopFixture({
    observeTriggeredStop: async () => validTriggeredStopEvidence(),
  });
  await fixture.store.upsertPosition(fixture.priorSnapshot);
  const worker = createVstWorker({
    store: fixture.store,
    broker: fixture.broker,
    clock: () => NOW + 60_000,
    sizingLimits: { environment: "vst" },
  });
  await worker.runOnce();
  const committedSnapshot = fixture.store.data.positions[0].snapshot;
  const replay = await fixture.store.commitVerifiedIntent(
    fixture.store.data.lastVerifiedCommit,
  );
  assert.equal(replay.replayed, true);
  assert.equal(fixture.store.data.intents.length, 1);
  assert.equal(fixture.store.data.intents[0].state, "reconciled");
  assert.equal(fixture.store.data.events.length, 1);
  assert.equal(fixture.store.data.positions[0].status, "closed");
  assert.equal(fixture.store.data.positions[0].snapshot.remainingQty, 0);
  assert.equal(committedSnapshot.remainingQty, 0);
});

test("triggered stop crash before atomic commit leaves retryable prepared intent", async () => {
  const fixture = triggeredStopFixture({
    observeTriggeredStop: async () => validTriggeredStopEvidence(),
  });
  await fixture.store.upsertPosition(fixture.priorSnapshot);
  const atomicCommit = fixture.store.commitVerifiedIntent.bind(fixture.store);
  fixture.store.commitVerifiedIntent = async () => {
    throw new Error("simulated commit boundary crash");
  };
  const worker = createVstWorker({
    store: fixture.store,
    broker: fixture.broker,
    clock: () => NOW + 60_000,
    sizingLimits: { environment: "vst" },
  });
  await assert.rejects(worker.runOnce(), /simulated commit boundary crash/);
  assert.equal(fixture.store.data.positions[0].status, "open");
  assert.equal(fixture.store.data.positions[0].snapshot.remainingQty, 10);
  assert.equal(fixture.store.data.intents[0].state, "prepared");
  assert.equal(fixture.store.data.events.length, 0);
  fixture.store.commitVerifiedIntent = atomicCommit;
  assert.equal((await worker.runOnce()).kind, "acted");
  assert.equal(fixture.store.data.positions[0].status, "closed");
  assert.equal(fixture.store.data.intents[0].state, "reconciled");
  assert.equal(fixture.store.data.events.length, 1);
});

function atomicCommitPool({ state = "submitted", outcome = null, exchangeOrderId = null,
  sourceSignalId = "commit-signal-1", serializationSignalId = "commit-signal-1",
  failPositionWrite = false,
  failFollowUpWrite = false, initialFollowUp = null } = {}) {
  const statements = [];
  const intent = {
    source_signal_id: sourceSignalId,
    phase: "market-entry",
    client_order_id: "commit-order-1",
    request: { operation: "entry" },
    state,
    exchange_order_id: exchangeOrderId,
    outcome,
    created_at: "created",
    updated_at: "updated",
  };
  const signalRow = {
    source_signal_id: sourceSignalId,
    body: { sourceSignalId },
    body_hash: "hash",
    status: "opening",
    reason: null,
    received_at: "received",
    updated_at: "updated",
  };
  let positionRow = state === "reconciled" ? {
    source_signal_id: sourceSignalId,
    symbol: "ETHUSDT",
    status: "open",
    snapshot: { sourceSignalId, symbol: "ETHUSDT", status: "open", snapshot: { fill: 100 } },
    updated_at: "position-updated",
  } : null;
  let followUpRow = initialFollowUp;
  const pool = {
    statements,
    async query(sql) {
      if (sql.includes("FROM vst_positions WHERE status IN")) {
        return { rowCount: positionRow ? 1 : 0, rows: positionRow ? [positionRow] : [] };
      }
      throw new Error("atomic commit should use a checked-out transaction");
    },
    async connect() {
      return {
        async query(sql, params = []) {
          statements.push({ sql, params });
          if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
            return { rowCount: 0, rows: [] };
          }
          if (sql.trim() === INTENT_SERIALIZATION_LOCK_SQL) {
            assert.deepEqual(params, [
              INTENT_SERIALIZATION_LOCK_NAMESPACE, serializationSignalId,
            ]);
            return { rowCount: 1, rows: [{ pg_advisory_xact_lock: null }] };
          }
          if (sql.includes("FROM vst_order_intents i")) {
            return {
              rowCount: 1,
              rows: [{
                ...intent,
                signal_source_signal_id: sourceSignalId,
                signal_body: signalRow.body,
                signal_body_hash: signalRow.body_hash,
                signal_status: signalRow.status,
                signal_reason: signalRow.reason,
                signal_received_at: signalRow.received_at,
                signal_updated_at: signalRow.updated_at,
              }],
            };
          }
          if (sql.includes("FROM vst_order_intents WHERE source_signal_id = $1 AND phase = $2")) {
            return {
              rowCount: followUpRow ? 1 : 0,
              rows: followUpRow ? [followUpRow] : [],
            };
          }
          if (sql.includes("FROM vst_positions WHERE")) {
            return { rowCount: positionRow ? 1 : 0, rows: positionRow ? [positionRow] : [] };
          }
          if (sql.includes("INSERT INTO vst_positions")) {
            if (failPositionWrite) throw new Error("position write failed");
            positionRow = {
              source_signal_id: params[0],
              symbol: params[1],
              status: params[2],
              snapshot: JSON.parse(params[3]),
              updated_at: "position-updated",
            };
            return { rowCount: 1, rows: [positionRow] };
          }
          if (sql.includes("UPDATE vst_order_intents")) {
            Object.assign(intent, {
              state: "reconciled",
              exchange_order_id: params[1],
              outcome: JSON.parse(params[2]),
            });
            return { rowCount: 1, rows: [intent] };
          }
          if (sql.includes("UPDATE vst_signals")) {
            Object.assign(signalRow, { status: params[1] });
            return { rowCount: 1, rows: [signalRow] };
          }
          if (sql.includes("INSERT INTO vst_order_intents")) {
            if (failFollowUpWrite) throw new Error("follow-up intent write failed");
            if (followUpRow) return { rowCount: 0, rows: [] };
            followUpRow = {
              source_signal_id: params[0],
              phase: params[1],
              client_order_id: params[2],
              request: JSON.parse(params[3]),
              state: "prepared",
              exchange_order_id: null,
              outcome: null,
              created_at: "created",
              updated_at: "updated",
            };
            return { rowCount: 1, rows: [followUpRow] };
          }
          if (sql.includes("INSERT INTO vst_events")) {
            return {
              rowCount: 1,
              rows: [{
                id: 7, source_signal_id: params[0], client_order_id: params[1],
                kind: params[2], detail: JSON.parse(params[3]), created_at: "event-created",
              }],
            };
          }
          throw new Error(`Unexpected transaction SQL: ${sql}`);
        },
        release() { statements.push({ sql: "RELEASE" }); },
      };
    },
  };
  return pool;
}

test("real store recovery claim serializes the marker, commits once, and rejects a second claim", async () => {
  const original = {
    operation: "margin_top_up", environment: "vst", accountId: "vst-account",
    symbol: "GRTUSDT", positionId: "grt-position", entryOrderId: "grt-entry",
    stopOrderId: "grt-stop", quantity: "339778", stopLoss: "0.02591",
    expectedIsolatedMarginBefore: "975.0716", amount: "140.51",
  };
  const position = {
    source_signal_id: "grt-recovery-test", symbol: "GRTUSDT", status: "error",
    snapshot: {
      status: "error", exchangePositionId: "grt-position",
      marginTopUp: {
        status: "failed", failureReason: "margin_top_up_abandoned_confirmed_not_applied",
      },
    },
  };
  const old = {
    client_order_id: "old-grt-attempt", request: original, state: "failed",
    outcome: {
      reason: "margin_top_up_abandoned_confirmed_not_applied",
      isolatedMarginObserved: "975.0716",
    },
  };
  const statements = [];
  let inserted = null;
  const pool = {
    async query() { throw new Error("recovery claim must use a transaction"); },
    async connect() {
      return {
        async query(sql, params = []) {
          statements.push({ sql, params });
          if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
            return { rows: [], rowCount: 0 };
          }
          if (sql.trim() === INTENT_SERIALIZATION_LOCK_SQL) {
            assert.deepEqual(params, [
              INTENT_SERIALIZATION_LOCK_NAMESPACE, "grt-recovery-test",
            ]);
            return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
          }
          if (sql.includes("FROM vst_positions WHERE source_signal_id = $1 FOR UPDATE")) {
            return { rows: [position], rowCount: 1 };
          }
          if (sql.includes("FROM vst_order_intents") &&
              sql.includes("phase = 'margin-top-up' FOR UPDATE")) {
            return { rows: [old], rowCount: 1 };
          }
          if (sql.includes("INSERT INTO vst_order_intents")) {
            if (inserted) return { rows: [], rowCount: 0 };
            inserted = { sourceSignalId: params[0], clientOrderId: params[1],
              request: JSON.parse(params[2]) };
            return { rows: [{ client_order_id: params[1] }], rowCount: 1 };
          }
          if (sql.includes("UPDATE vst_positions")) {
            position.status = "open";
            position.snapshot = JSON.parse(params[1]);
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("UPDATE vst_signals") ||
              sql.includes("INSERT INTO vst_events")) {
            return { rows: [], rowCount: 1 };
          }
          throw new Error(`Unexpected recovery query: ${sql}`);
        },
        release() {},
      };
    },
  };
  const store = createVstStore(pool);
  const request = { ...original, amount: "292.53", approvedTopUpMargin: "292.53",
    intentCreatedAt: NOW };
  const marker = { status: "pending", failureReason: undefined, amount: "292.53",
    positionId: "grt-position" };
  const claim = { sourceSignalId: "grt-recovery-test",
    clientOrderId: "grt-recovery-id", request, marker };
  assert.equal(await store.prepareFailedMarginTopUpRecovery(claim), true);
  assert.deepEqual(inserted.request, request);
  assert.equal(position.snapshot.status, "open");
  assert.equal(position.snapshot.marginTopUp.status, "pending");
  assert.equal(Object.hasOwn(position.snapshot.marginTopUp, "failureReason"), false);
  assert.equal(position.snapshot.marginTopUp.previousAttempt.clientOrderId, "old-grt-attempt");
  assert.equal(await store.prepareFailedMarginTopUpRecovery(claim), false);
  assert.equal(statements.filter(({ sql }) =>
    sql.includes("INSERT INTO vst_order_intents")).length, 1);
  assertIntentSerializationLockOrder(statements, "grt-recovery-test");
});

test("permission-denied recovery can be claimed once for approved HBAR/GRT only", async () => {
  const request = {
    operation: "margin_top_up", environment: "vst", accountId: "vst-account",
    symbol: "GRTUSDT", positionId: "grt-position", entryOrderId: "grt-entry",
    stopOrderId: "grt-stop", quantity: "339778", stopLoss: "0.02591",
    expectedIsolatedMarginBefore: "975.0716", amount: "140.51",
    approvedTopUpMargin: "140.51",
  };
  const position = {
    source_signal_id: "cab-signal-15892", symbol: "GRTUSDT", status: "error",
    snapshot: {
      status: "error", exchangePositionId: "grt-position",
      marginTopUp: {
        status: "failed", failureReason: "margin_top_up_abandoned_confirmed_not_applied",
      },
    },
  };
  const previous = {
    client_order_id: "failed-permission-recovery", request, state: "failed",
    outcome: {
      reason: "margin_top_up_abandoned_confirmed_not_applied",
      isolatedMarginObserved: "975.0716",
      submissionErrorMessage: "BingX live writes are disabled: explicit permission was not granted",
    },
  };
  let inserted = 0;
  const statements = [];
  const pool = {
    async query(sql) {
      assert.match(sql, /i\.phase = 'margin-top-up-recovery'/);
      assert.match(sql, /i\.outcome->>'submissionErrorMessage'/);
      assert.match(sql, /next\.phase = 'margin-top-up-permission-recovery'/);
      assert.match(sql, /cab-signal-15471/);
      assert.match(sql, /cab-signal-15892/);
      return { rows: [{
        ...position, client_order_id: previous.client_order_id,
        request, outcome: previous.outcome,
      }] };
    },
    async connect() {
      return {
        async query(sql, params = []) {
          statements.push({ sql, params });
          if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
          if (sql.trim() === INTENT_SERIALIZATION_LOCK_SQL) {
            assert.deepEqual(params, [
              INTENT_SERIALIZATION_LOCK_NAMESPACE, "cab-signal-15892",
            ]);
            return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
          }
          if (sql.includes("FROM vst_positions WHERE source_signal_id = $1 FOR UPDATE")) {
            return { rows: [position] };
          }
          if (sql.includes("FROM vst_order_intents") &&
              sql.includes("phase = 'margin-top-up-recovery' FOR UPDATE")) {
            return { rows: [previous] };
          }
          if (sql.includes("INSERT INTO vst_order_intents")) {
            assert.match(sql, /'margin-top-up-permission-recovery'/);
            if (inserted) return { rowCount: 0, rows: [] };
            inserted += 1;
            assert.equal(JSON.parse(params[2]).amount, "209.01");
            return { rowCount: 1, rows: [{ client_order_id: params[1] }] };
          }
          if (sql.includes("UPDATE vst_positions")) {
            position.status = "open";
            position.snapshot = JSON.parse(params[1]);
          } else if (!sql.includes("UPDATE vst_signals") &&
                     !sql.includes("INSERT INTO vst_events")) {
            throw new Error(`Unexpected SQL: ${sql}`);
          }
          return { rowCount: 1, rows: [] };
        },
        release() {},
      };
    },
  };
  const store = createVstStore(pool);
  const candidates = await store.listRecoverableFailedPermissionMarginTopUps();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].recoveryPhase, "margin-top-up-permission-recovery");
  const claim = {
    sourceSignalId: "cab-signal-15892", clientOrderId: "new-permission-recovery",
    recoveryPhase: "margin-top-up-permission-recovery",
    request: { ...request, amount: "209.01", approvedTopUpMargin: "209.01",
      intentCreatedAt: NOW },
    marker: { status: "pending", amount: "209.01" },
  };
  const wrongSignal = { ...claim, sourceSignalId: "cab-signal-unapproved" };
  assert.equal(await store.prepareFailedMarginTopUpRecovery(wrongSignal), false);
  previous.outcome.submissionErrorMessage = "timed out after transport";
  assert.equal(await store.prepareFailedMarginTopUpRecovery(claim), false);
  previous.outcome.submissionErrorMessage =
    "BingX live writes are disabled: explicit permission was not granted";
  assert.equal(await store.prepareFailedMarginTopUpRecovery(claim), true);
  assert.equal(position.snapshot.marginTopUp.previousAttempt.clientOrderId,
    "failed-permission-recovery");
  assert.equal(await store.prepareFailedMarginTopUpRecovery(claim), false);
  assert.equal(inserted, 1);
  assertIntentSerializationLockOrder(statements, "cab-signal-15892");
});

const ATOMIC_COMMIT = {
  sourceSignalId: "commit-signal-1",
  clientOrderId: "commit-order-1",
  position: { sourceSignalId: "commit-signal-1", symbol: "ETHUSDT", status: "open", snapshot: { fill: 100 } },
  signalStatus: "open",
  exchangeOrderId: "exchange-1",
  outcome: { status: "filled", fill: { price: 100 } },
  eventKind: "verified_fill",
  eventDetail: { verified: true },
};

const ATOMIC_ENTRY_WITH_TOP_UP = {
  ...ATOMIC_COMMIT,
  position: {
    ...ATOMIC_COMMIT.position,
    accountId: "vst-account",
    marginTopUp: { status: "pending", amount: "2.5" },
  },
  signalStatus: "opening",
  eventKind: "vst_entry_margin_top_up_pending",
  followUpIntent: {
    sourceSignalId: ATOMIC_COMMIT.sourceSignalId,
    phase: "margin-top-up",
    clientOrderId: "commit-top-up-1",
    request: {
      operation: "margin_top_up",
      environment: "vst",
      accountId: "vst-account",
      symbol: "ETHUSDT",
      positionId: "position-1",
      entryOrderId: "exchange-1",
      quantity: "1",
      stopLoss: "90",
      stopOrderId: "stop-1",
      expectedIsolatedMarginBefore: "10",
      amount: "2.5",
      approvedTopUpMargin: "2.5",
      intentCreatedAt: 1_791_511_200_000,
    },
  },
};

test("verified intent commit atomically updates position, intent, signal, and optional event", async () => {
  const pool = atomicCommitPool();
  const result = await createVstStore(pool).commitVerifiedIntent(ATOMIC_COMMIT);
  assert.equal(result.replayed, false);
  assert.equal(result.intent.state, "reconciled");
  assert.equal(result.position.status, "open");
  assert.equal(result.signal.status, "open");
  assert.equal(result.event.kind, "verified_fill");
  assert.deepEqual(
    pool.statements.filter(({ sql }) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql))
      .map(({ sql }) => sql),
    ["BEGIN", "COMMIT"],
  );
  assertIntentSerializationLockOrder(pool.statements, "commit-signal-1");
  const writeOrder = pool.statements
    .filter(({ sql }) => /^(INSERT INTO vst_positions|UPDATE vst_order_intents|UPDATE vst_signals|INSERT INTO vst_events)/.test(sql))
    .map(({ sql }) => sql.match(/(?:INSERT INTO|UPDATE) (vst_\w+)/)[1]);
  assert.deepEqual(writeOrder, ["vst_positions", "vst_order_intents", "vst_signals", "vst_events"]);
});

test("verified entry price audit survives durable position reload", async () => {
  const priceAudit = {
    signalReferencePrice: "100",
    planningQuotePrice: "102",
    planningQuoteObservedAt: "2026-10-02T00:00:01.000Z",
    planningPriceDeviationPct: 2,
    verifiedFillPrice: "103",
    verifiedFillAt: "2026-10-02T00:00:02.000Z",
    actualFillDeviationPct: 3,
  };
  const pool = atomicCommitPool();
  const store = createVstStore(pool);
  await store.commitVerifiedIntent({
    ...ATOMIC_COMMIT,
    position: { ...ATOMIC_COMMIT.position, priceAudit },
  });
  const [reloaded] = await store.listOpenPositions();
  assert.deepEqual(reloaded.snapshot.priceAudit, priceAudit);
});

test("production store serializes a verified funded top-up but rejects an undefined failure marker", async () => {
  const funded = {
    ...ATOMIC_COMMIT,
    position: {
      ...ATOMIC_COMMIT.position,
      marginTopUp: {
        status: "verified", protectionStatus: "liquidation_below_stop_buffer",
        marginDelta: "149.48", liquidationPriceAfter: 0.4811,
      },
    },
    outcome: {
      status: "filled", verified: true, operation: "margin_top_up",
      marginDelta: "149.48", protectionVerified: true,
    },
    eventKind: "vst_margin_top_up_verified",
    eventDetail: { amount: "149.48", protectionVerified: true },
  };
  const pool = atomicCommitPool();
  const committed = await createVstStore(pool).commitVerifiedIntent(funded);
  assert.equal(committed.position.snapshot.marginTopUp.marginDelta, "149.48");
  assert.equal(committed.intent.state, "reconciled");
  const broken = {
    ...funded,
    position: {
      ...funded.position,
      marginTopUp: { ...funded.position.marginTopUp, failureReason: undefined },
    },
  };
  const rejectedPool = atomicCommitPool();
  await assert.rejects(createVstStore(rejectedPool).commitVerifiedIntent(broken),
    /Persisted objects must not contain undefined values/);
  assert.equal(rejectedPool.statements.some(({ sql }) => sql === "COMMIT"), false);
});

test("entry commit atomically reserves the margin top-up follow-up before management can resume", async () => {
  const pool = atomicCommitPool();
  const result = await createVstStore(pool).commitVerifiedIntent(ATOMIC_ENTRY_WITH_TOP_UP);
  assert.equal(result.replayed, false);
  assert.equal(result.followUpIntent.state, "prepared");
  assert.equal(result.followUpIntent.phase, "margin-top-up");
  assert.equal(result.followUpIntent.request.amount, "2.5");
  assert.equal(result.signal.status, "opening");
  assert.deepEqual(
    pool.statements.filter(({ sql }) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql))
      .map(({ sql }) => sql),
    ["BEGIN", "COMMIT"],
  );
  const writeOrder = pool.statements
    .filter(({ sql }) => /^(INSERT INTO vst_positions|UPDATE vst_order_intents|UPDATE vst_signals|INSERT INTO vst_order_intents|INSERT INTO vst_events)/.test(sql))
    .map(({ sql }) => sql.match(/(?:INSERT INTO|UPDATE) (vst_\w+)/)[1]);
  assert.deepEqual(
    writeOrder,
    ["vst_positions", "vst_order_intents", "vst_signals", "vst_order_intents", "vst_events"],
  );
});

test("failed atomic margin top-up reservation rolls back the entry position and event", async () => {
  const pool = atomicCommitPool({ failFollowUpWrite: true });
  await assert.rejects(
    createVstStore(pool).commitVerifiedIntent(ATOMIC_ENTRY_WITH_TOP_UP),
    /follow-up intent write failed/,
  );
  assert.deepEqual(
    pool.statements.filter(({ sql }) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql))
      .map(({ sql }) => sql),
    ["BEGIN", "ROLLBACK"],
  );
  assert.equal(pool.statements.some(({ sql }) => sql.includes("INSERT INTO vst_events")), false);
});

test("replayed entry commit requires the exact atomic margin top-up follow-up", async () => {
  const pool = atomicCommitPool({
    state: "reconciled",
    outcome: ATOMIC_ENTRY_WITH_TOP_UP.outcome,
    exchangeOrderId: ATOMIC_ENTRY_WITH_TOP_UP.exchangeOrderId,
    initialFollowUp: {
      source_signal_id: ATOMIC_ENTRY_WITH_TOP_UP.sourceSignalId,
      phase: ATOMIC_ENTRY_WITH_TOP_UP.followUpIntent.phase,
      client_order_id: ATOMIC_ENTRY_WITH_TOP_UP.followUpIntent.clientOrderId,
      request: ATOMIC_ENTRY_WITH_TOP_UP.followUpIntent.request,
      state: "prepared",
      exchange_order_id: null,
      outcome: null,
      created_at: "created",
      updated_at: "updated",
    },
  });
  const result = await createVstStore(pool).commitVerifiedIntent(ATOMIC_ENTRY_WITH_TOP_UP);
  assert.equal(result.replayed, true);
  assert.deepEqual(
    pool.statements.filter(({ sql }) => /^(INSERT INTO|UPDATE)/.test(sql)),
    [],
  );
});

test("replayed entry commit tolerates a re-stamped margin top-up intentCreatedAt", async () => {
  // finalizeEntry (vst-worker.mjs) rebuilds the margin top-up follow-up
  // request from scratch on every call -- including a fresh intentCreatedAt
  // -- and has no persisted value to reuse. A restart-driven replay of an
  // already-reconciled entry must not be rejected just because that
  // bookkeeping timestamp differs from what was first persisted.
  const pool = atomicCommitPool({
    state: "reconciled",
    outcome: ATOMIC_ENTRY_WITH_TOP_UP.outcome,
    exchangeOrderId: ATOMIC_ENTRY_WITH_TOP_UP.exchangeOrderId,
    initialFollowUp: {
      source_signal_id: ATOMIC_ENTRY_WITH_TOP_UP.sourceSignalId,
      phase: ATOMIC_ENTRY_WITH_TOP_UP.followUpIntent.phase,
      client_order_id: ATOMIC_ENTRY_WITH_TOP_UP.followUpIntent.clientOrderId,
      request: ATOMIC_ENTRY_WITH_TOP_UP.followUpIntent.request,
      state: "prepared",
      exchange_order_id: null,
      outcome: null,
      created_at: "created",
      updated_at: "updated",
    },
  });
  const replayedCommit = {
    ...ATOMIC_ENTRY_WITH_TOP_UP,
    followUpIntent: {
      ...ATOMIC_ENTRY_WITH_TOP_UP.followUpIntent,
      request: {
        ...ATOMIC_ENTRY_WITH_TOP_UP.followUpIntent.request,
        intentCreatedAt: ATOMIC_ENTRY_WITH_TOP_UP.followUpIntent.request.intentCreatedAt + 60_000,
      },
    },
  };
  const result = await createVstStore(pool).commitVerifiedIntent(replayedCommit);
  assert.equal(result.replayed, true);
  assert.deepEqual(
    pool.statements.filter(({ sql }) => /^(INSERT INTO|UPDATE)/.test(sql)),
    [],
  );
});

test("replayed entry commit still rejects a genuinely different margin top-up amount", async () => {
  const pool = atomicCommitPool({
    state: "reconciled",
    outcome: ATOMIC_ENTRY_WITH_TOP_UP.outcome,
    exchangeOrderId: ATOMIC_ENTRY_WITH_TOP_UP.exchangeOrderId,
    initialFollowUp: {
      source_signal_id: ATOMIC_ENTRY_WITH_TOP_UP.sourceSignalId,
      phase: ATOMIC_ENTRY_WITH_TOP_UP.followUpIntent.phase,
      client_order_id: ATOMIC_ENTRY_WITH_TOP_UP.followUpIntent.clientOrderId,
      request: ATOMIC_ENTRY_WITH_TOP_UP.followUpIntent.request,
      state: "prepared",
      exchange_order_id: null,
      outcome: null,
      created_at: "created",
      updated_at: "updated",
    },
  });
  const conflictingCommit = {
    ...ATOMIC_ENTRY_WITH_TOP_UP,
    followUpIntent: {
      ...ATOMIC_ENTRY_WITH_TOP_UP.followUpIntent,
      request: {
        ...ATOMIC_ENTRY_WITH_TOP_UP.followUpIntent.request,
        // A genuinely different top-up amount, not just the bookkeeping
        // timestamp: this must still be rejected as a real conflict.
        amount: "9.99",
        intentCreatedAt: ATOMIC_ENTRY_WITH_TOP_UP.followUpIntent.request.intentCreatedAt + 60_000,
      },
    },
  };
  await assert.rejects(
    createVstStore(pool).commitVerifiedIntent(conflictingCommit),
    /VST reconciled entry has a conflicting follow-up intent/,
  );
});

test("verified intent commit rolls back when a ledger write fails", async () => {
  const pool = atomicCommitPool({ failPositionWrite: true });
  await assert.rejects(
    createVstStore(pool).commitVerifiedIntent(ATOMIC_COMMIT),
    /position write failed/,
  );
  assert.deepEqual(
    pool.statements.filter(({ sql }) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql))
      .map(({ sql }) => sql),
    ["BEGIN", "ROLLBACK"],
  );
});

test("identical reconciled intent commit is an idempotent replay", async () => {
  const committedOutcome = ATOMIC_COMMIT.outcome;
  const pool = atomicCommitPool({
    state: "reconciled",
    outcome: committedOutcome,
    exchangeOrderId: ATOMIC_COMMIT.exchangeOrderId,
  });
  const result = await createVstStore(pool).commitVerifiedIntent(ATOMIC_COMMIT);
  assert.equal(result.replayed, true);
  assert.equal(result.intent.state, "reconciled");
  assert.deepEqual(
    pool.statements.filter(({ sql }) => /^(INSERT INTO|UPDATE)/.test(sql)),
    [],
  );
  assert.deepEqual(
    pool.statements.filter(({ sql }) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql))
      .map(({ sql }) => sql),
    ["BEGIN", "COMMIT"],
  );
});

test("verified intent commit fails closed when requested source signal mismatches", async () => {
  const pool = atomicCommitPool({
    sourceSignalId: "another-signal",
    serializationSignalId: ATOMIC_COMMIT.sourceSignalId,
  });
  await assert.rejects(
    createVstStore(pool).commitVerifiedIntent(ATOMIC_COMMIT),
    /source signal mismatch/,
  );
  assertIntentSerializationLockOrder(pool.statements, ATOMIC_COMMIT.sourceSignalId);
  assert.deepEqual(
    pool.statements.filter(({ sql }) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql))
      .map(({ sql }) => sql),
    ["BEGIN", "ROLLBACK"],
  );
  assert.equal(pool.statements.some(({ sql }) => sql.includes("INSERT INTO vst_positions")), false);
});

test("reconciled intent replay rejects a different verified outcome", async () => {
  const pool = atomicCommitPool({
    state: "reconciled",
    outcome: { status: "filled", fill: { price: 99 } },
    exchangeOrderId: ATOMIC_COMMIT.exchangeOrderId,
  });
  await assert.rejects(
    createVstStore(pool).commitVerifiedIntent(ATOMIC_COMMIT),
    /conflicts with verified outcome/,
  );
  assert.equal(pool.statements.some(({ sql }) => sql.includes("UPDATE vst_signals")), false);
  assert.deepEqual(
    pool.statements.filter(({ sql }) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql))
      .map(({ sql }) => sql),
    ["BEGIN", "ROLLBACK"],
  );
});

// Regression coverage for "signals go through but not every Telegram
// message arrives": many vst-worker.mjs call sites move a signal's status
// without recording their own event. setSignalStatus must record a generic
// vst_signal_status_changed event on every real transition so the Telegram
// notifier (which now sends every unsent vst_events row) always has
// something to deliver, without depending on the caller remembering to.
test("listPendingCandidatesPage preserves exact priority/keyset ordering and timestamp precision", async () => {
  const candidate = (id, priority, timestamp) => ({
    source_signal_id: id,
    body: { sourceSignalId: id },
    body_hash: `${id}-hash`,
    status: priority === 0 ? "opening" : priority === 1 ? "planning" : "pending",
    reason: null,
    received_at: new Date(timestamp),
    updated_at: new Date(timestamp),
    candidate_priority: priority,
    cursor_received_at: timestamp,
  });
  const rows = [
    candidate("cab-signal-opening", 0, "2026-10-02T00:00:00.000001Z"),
    candidate("cab-signal-planning", 1, "2026-10-02T00:00:00.000002Z"),
    candidate("cab-signal-pending", 2, "2026-10-02T00:00:00.000003Z"),
  ];
  const statements = [];
  const pool = {
    async query(sql, params) {
      statements.push({ sql, params });
      return { rows: statements.length === 1 ? rows : [rows[2]] };
    },
    async connect() { throw new Error("not used by keyset page reads"); },
  };
  const store = createVstStore(pool);

  const first = await store.listPendingCandidatesPage({ limit: 2 });
  assert.deepEqual(first.rows.map((row) => row.sourceSignalId), [
    "cab-signal-opening", "cab-signal-planning",
  ]);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.nextCursor, {
    priority: 1,
    receivedAt: "2026-10-02T00:00:00.000002Z",
    sourceSignalId: "cab-signal-planning",
  });
  assert.equal(Object.isFrozen(first.nextCursor), true);

  const second = await store.listPendingCandidatesPage({
    limit: 2,
    after: first.nextCursor,
  });
  assert.deepEqual(second.rows.map((row) => row.sourceSignalId), ["cab-signal-pending"]);
  assert.equal(second.hasMore, false);
  assert.deepEqual(statements.map(({ params }) => params), [
    [null, null, null, 3],
    [1, "2026-10-02T00:00:00.000002Z", "cab-signal-planning", 3],
  ]);
  assert.match(statements[0].sql, /CASE WHEN status = 'opening' THEN 0\s+WHEN status = 'planning' THEN 1 ELSE 2 END/);
  assert.match(statements[0].sql, /\(priority, received_at, source_signal_id\) >/);
  assert.match(statements[0].sql, /ORDER BY priority, received_at, source_signal_id/);
  assert.match(statements[0].sql, /to_char\(received_at AT TIME ZONE 'UTC'/);
  assert.doesNotMatch(statements[0].sql, /\bOFFSET\b/i);
});

function signalStatusTestPool(initialStatus) {
  let status = initialStatus;
  let reason = null;
  const statements = [];
  const client = {
    async query(sql, params = []) {
      const trimmed = sql.trim();
      statements.push({ sql: trimmed, params });
      if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK") {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("SELECT status FROM vst_signals") && sql.includes("FOR UPDATE")) {
        const [id] = params;
        return status === null
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ status }] };
      }
      if (sql.includes("UPDATE vst_signals SET status =")) {
        const [id, newStatus, newReason] = params;
        status = newStatus;
        reason = newReason;
        return {
          rowCount: 1,
          rows: [{
            source_signal_id: id, body: {}, body_hash: "hash", status, reason,
            received_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          }],
        };
      }
      if (sql.includes("INSERT INTO vst_events")) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query in signalStatusTestPool: ${sql}`);
    },
    release() {},
  };
  return {
    statements,
    async connect() { return client; },
    async query() { throw new Error("not needed"); },
  };
}

test("setSignalStatus records a durable event for a genuine status transition", async () => {
  const pool = signalStatusTestPool("planning");
  const store = createVstStore(pool);
  const updated = await store.setSignalStatus("cab-signal-1", "rejected", "policy_rejected");
  assert.equal(updated.status, "rejected");
  const insert = pool.statements.find(({ sql }) => sql.includes("INSERT INTO vst_events"));
  assert.ok(insert, "expected setSignalStatus to record a vst_events row");
  assert.equal(insert.params[0], "cab-signal-1");
  const detail = JSON.parse(insert.params[1]);
  assert.deepEqual(detail, { from: "planning", to: "rejected", reason: "policy_rejected" });
  assert.deepEqual(
    pool.statements.filter(({ sql }) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql))
      .map(({ sql }) => sql),
    ["BEGIN", "COMMIT"],
  );
});

test("setSignalStatus does not re-record an event when the status does not actually change", async () => {
  const pool = signalStatusTestPool("unknown");
  const store = createVstStore(pool);
  const updated = await store.setSignalStatus("cab-signal-2", "unknown", "still retrying");
  assert.equal(updated.status, "unknown");
  assert.equal(pool.statements.some(({ sql }) => sql.includes("INSERT INTO vst_events")), false);
});

test("setSignalStatus returns null without recording an event for an unknown signal", async () => {
  const pool = signalStatusTestPool(null);
  const store = createVstStore(pool);
  const updated = await store.setSignalStatus("cab-signal-missing", "error", "boom");
  assert.equal(updated, null);
  assert.equal(pool.statements.some(({ sql }) => sql.includes("INSERT INTO vst_events")), false);
});

// resolveMarginTopUpKeepOpen (see vst-margin-top-up-keep-open.test.mjs for
// the caller-level corroboration coverage) must settle the ORIGINAL
// margin-top-up order intent in the very same transaction as the position
// snapshot write, or that intent stays "unresolved" and keeps blocking the
// ENTIRE pipeline (listUnresolvedIntents) even after the position-level gate
// is lifted.
function marginTopUpKeepOpenPool({ intentState = "unknown", positionSnapshot = null } = {}) {
  const snapshot = positionSnapshot ?? {
    environment: "vst", accountId: "vst-account", exchangePositionId: "position-1",
    marginTopUp: { status: "pending", amount: "2.5", expectedIsolatedMarginBefore: "10" },
  };
  const state = { intentState, positionSnapshot: snapshot, signalStatus: "error" };
  const statements = [];
  const client = {
    async query(sql, params = []) {
      const trimmed = sql.trim();
      statements.push({ sql: trimmed, params });
      if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK") {
        return { rowCount: 0, rows: [] };
      }
      if (trimmed === INTENT_SERIALIZATION_LOCK_SQL) {
        assert.deepEqual(params, [
          INTENT_SERIALIZATION_LOCK_NAMESPACE, "margin-signal-1",
        ]);
        return { rowCount: 1, rows: [{ pg_advisory_xact_lock: null }] };
      }
      if (sql.includes("FROM vst_positions WHERE") && sql.includes("FOR UPDATE")) {
        return {
          rowCount: 1,
          rows: [{
            source_signal_id: "margin-signal-1", symbol: "ENSUSDT", status: "open",
            snapshot: state.positionSnapshot, updated_at: "position-updated",
          }],
        };
      }
      if (sql.includes("FROM vst_order_intents WHERE source_signal_id = $1 AND phase = $2 FOR UPDATE") ||
          (sql.includes("FROM vst_order_intents") && sql.includes("phase = 'margin-top-up' FOR UPDATE"))) {
        return state.intentState === null
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ client_order_id: "margin-top-up-order-1", state: state.intentState }] };
      }
      if (sql.includes("UPDATE vst_order_intents") && sql.includes("phase = 'margin-top-up'")) {
        state.intentState = "failed";
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE vst_positions SET snapshot")) {
        state.positionSnapshot = JSON.parse(params[1]);
        return {
          rowCount: 1,
          rows: [{
            source_signal_id: "margin-signal-1", symbol: "ENSUSDT", status: "open",
            snapshot: state.positionSnapshot, updated_at: "position-resolved",
          }],
        };
      }
      if (sql.includes("UPDATE vst_signals SET status = 'open'")) {
        state.signalStatus = "open";
        return { rowCount: 1, rows: [{ source_signal_id: "margin-signal-1" }] };
      }
      if (sql.includes("INSERT INTO vst_events")) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query in marginTopUpKeepOpenPool: ${sql}`);
    },
    release() {},
  };
  return {
    state,
    statements,
    async connect() { return client; },
    async query() { throw new Error("resolveMarginTopUpKeepOpen must use a checked-out transaction"); },
  };
}

test("resolveMarginTopUpKeepOpen settles the original margin-top-up intent atomically with the position snapshot", async () => {
  const pool = marginTopUpKeepOpenPool({ intentState: "unknown" });
  const store = createVstStore(pool);

  const result = await store.resolveMarginTopUpKeepOpen("margin-signal-1", {
    resolvedBy: "owner-user-1", note: "checked BingX directly",
  });

  assert.equal(result.snapshot.marginTopUp.status, "failed");
  assert.equal(result.snapshot.marginTopUp.manualResolution.outcome, "keep_open");
  assert.equal(pool.state.intentState, "failed", "the margin-top-up intent must be settled, not left unresolved");
  const intentUpdate = pool.statements.find(
    ({ sql }) => sql.includes("UPDATE vst_order_intents") && sql.includes("phase = 'margin-top-up'"),
  );
  assert.ok(intentUpdate, "expected the intent settlement UPDATE to run");
  assert.deepEqual(
    pool.statements.filter(({ sql }) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)).map(({ sql }) => sql),
    ["BEGIN", "COMMIT"],
    "the position write and the intent settlement must commit together",
  );
  assertIntentSerializationLockOrder(pool.statements, "margin-signal-1");
});

test("resolveMarginTopUpKeepOpen refuses when there is no unresolved margin-top-up intent to settle, instead of writing the position alone", async () => {
  const pool = marginTopUpKeepOpenPool({ intentState: null });
  const store = createVstStore(pool);

  await assert.rejects(
    store.resolveMarginTopUpKeepOpen("margin-signal-1", { resolvedBy: "owner-user-1" }),
    /vst_margin_top_up_intent_not_unresolved/,
  );
  assert.equal(pool.statements.some(({ sql }) => sql.includes("UPDATE vst_positions SET snapshot")), false);
  assert.deepEqual(
    pool.statements.filter(({ sql }) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)).map(({ sql }) => sql),
    ["BEGIN", "ROLLBACK"],
  );
});

test("resolveMarginTopUpKeepOpen refuses when the intent already reconciled, instead of overriding a fact that beat it to the lock", async () => {
  const pool = marginTopUpKeepOpenPool({ intentState: "reconciled" });
  const store = createVstStore(pool);

  await assert.rejects(
    store.resolveMarginTopUpKeepOpen("margin-signal-1", { resolvedBy: "owner-user-1" }),
    /vst_margin_top_up_intent_not_unresolved/,
  );
  assert.equal(pool.statements.some(({ sql }) => sql.includes("UPDATE vst_positions SET snapshot")), false);
});

function runnerCancelRecoveryPool({ otherAttempt = false } = {}) {
  const childOrderId = "runner-child-1";
  const sourceSignalId = "runner-recovery-signal";
  const intentPhase = `impulse-runner-cancel-original-${childOrderId}`;
  const recoveryPhase = `impulse-runner-cancel-recovery-${childOrderId}`;
  const expectedRequest = {
    operation: "cancel_original_after_runner_fill",
    sourceSignalId,
    runnerChildOrderId: childOrderId,
    originalStopOrderId: "original-stop-1",
    positionId: "position-1",
  };
  const expectedSnapshot = {
    sourceSignalId,
    status: "closing",
    split: {
      runnerCleanup: { childOrderId, originalStopOrderId: "original-stop-1" },
    },
  };
  const recoveryPosition = structuredClone(expectedSnapshot);
  recoveryPosition.split.runnerCleanup.recoveryPhase = recoveryPhase;
  const state = {
    signalStatus: "unknown",
    positionStatus: "closing",
    positionSnapshot: structuredClone(expectedSnapshot),
    intents: [{
      source_signal_id: sourceSignalId,
      phase: intentPhase,
      client_order_id: "runner-cancel-1",
      request: expectedRequest,
      state: "unknown",
      outcome: {
        submissionError: "BingXLiveApiError",
        submissionErrorMessage:
          "VST runner parent order is not an exact verified 20% BE stop fill",
      },
    }],
    events: [],
  };
  if (otherAttempt) {
    state.intents.push({
      source_signal_id: sourceSignalId,
      phase: "another-cancel-attempt",
      client_order_id: "runner-cancel-2",
      request: { ...expectedRequest, originalStopOrderId: "original-stop-1" },
      state: "failed",
      outcome: {},
    });
  }
  const statements = [];
  let transactionTail = Promise.resolve();
  const client = {
    async query(sql, params = []) {
      const normalized = sql.trim();
      if (normalized === "BEGIN") {
        let release;
        const prior = transactionTail;
        transactionTail = new Promise((resolve) => { release = resolve; });
        await prior;
        statements.push({ sql: normalized, params });
        this.releaseTransaction = release;
        return { rowCount: 0, rows: [] };
      }
      statements.push({ sql: normalized, params });
      if (normalized === "COMMIT" || normalized === "ROLLBACK") {
        this.releaseTransaction?.();
        this.releaseTransaction = null;
        return { rowCount: 0, rows: [] };
      }
      if (normalized === INTENT_SERIALIZATION_LOCK_SQL) {
        assert.deepEqual(params, [
          INTENT_SERIALIZATION_LOCK_NAMESPACE, sourceSignalId,
        ]);
        return { rowCount: 1, rows: [{ pg_advisory_xact_lock: null }] };
      }
      if (normalized.includes("FROM vst_signals") && normalized.includes("FOR UPDATE")) {
        return {
          rowCount: 1,
          rows: [{
            source_signal_id: sourceSignalId, body: {}, body_hash: "hash",
            status: state.signalStatus, reason: null, received_at: "received", updated_at: "updated",
          }],
        };
      }
      if (normalized.includes("FROM vst_positions") && normalized.includes("FOR UPDATE")) {
        return {
          rowCount: 1,
          rows: [{
            source_signal_id: sourceSignalId, symbol: "ETHUSDT",
            status: state.positionStatus, snapshot: state.positionSnapshot, updated_at: "updated",
          }],
        };
      }
      if (normalized.includes("FROM vst_order_intents") &&
          normalized.includes("client_order_id = $2 FOR UPDATE")) {
        const intent = state.intents.find((row) => row.client_order_id === params[1]);
        return { rowCount: intent ? 1 : 0, rows: intent ? [intent] : [] };
      }
      if (normalized.includes("FROM vst_order_intents") &&
          normalized.includes("request->>'operation'")) {
        const intents = state.intents.filter((row) =>
          row.source_signal_id === params[0] &&
          row.request.operation === "cancel_original_after_runner_fill");
        return { rowCount: intents.length, rows: intents };
      }
      if (normalized.startsWith("UPDATE vst_order_intents")) {
        const intent = state.intents.find((row) => row.client_order_id === params[1]);
        if (!intent || intent.state !== "unknown") return { rowCount: 0, rows: [] };
        intent.state = "failed";
        intent.outcome = JSON.parse(params[2]);
        return { rowCount: 1, rows: [{ client_order_id: intent.client_order_id }] };
      }
      if (normalized.startsWith("UPDATE vst_positions")) {
        let snapshotMatches = true;
        try {
          assert.deepEqual(state.positionSnapshot, JSON.parse(params[1]));
        } catch {
          snapshotMatches = false;
        }
        if (state.positionStatus !== "closing" || !snapshotMatches) {
          return { rowCount: 0, rows: [] };
        }
        state.positionSnapshot = JSON.parse(params[2]);
        return { rowCount: 1, rows: [{ source_signal_id: sourceSignalId }] };
      }
      if (normalized.startsWith("UPDATE vst_signals")) {
        if (state.signalStatus !== "unknown") return { rowCount: 0, rows: [] };
        state.signalStatus = "open";
        return { rowCount: 1, rows: [{ source_signal_id: sourceSignalId }] };
      }
      if (normalized.startsWith("INSERT INTO vst_events")) {
        state.events.push({
          sourceSignalId: params[0], clientOrderId: params[1],
          kind: "vst_runner_cancel_pre_transport_refused",
          detail: JSON.parse(params[2]),
        });
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query in runnerCancelRecoveryPool: ${normalized}`);
    },
    release() {},
  };
  const pool = {
    state, statements,
    async connect() { return client; },
    async query() { throw new Error("runner cancel recovery must use a transaction"); },
  };
  return {
    pool, sourceSignalId, childOrderId, recoveryPhase,
    expectedRequest, expectedSnapshot, recoveryPosition,
  };
}

function runnerCancelSecondRecoveryPool() {
  const fixture = runnerCancelRecoveryPool();
  const state = fixture.pool.state;
  const originalRequest = structuredClone(fixture.expectedRequest);
  const firstRecoveryPhase = fixture.recoveryPhase;
  const expectedSnapshot = structuredClone(fixture.recoveryPosition);
  const recoveryPhase =
    `impulse-runner-cancel-recovery-2-${fixture.childOrderId}`;
  const expectedRequest = {
    ...structuredClone(originalRequest),
    priorPosition: structuredClone(expectedSnapshot),
  };
  const targetIntent = {
    source_signal_id: fixture.sourceSignalId,
    phase: firstRecoveryPhase,
    client_order_id: "runner-cancel-2",
    request: expectedRequest,
    state: "unknown",
    outcome: {
      error: "BingXLiveApiError",
      errorMessage:
        "VST runner fill history does not uniquely link to its exact parent stop",
    },
  };
  state.intents[0].state = "failed";
  state.intents[0].outcome = {
    ...state.intents[0].outcome,
    status: "pre_transport_refused_no_delete",
    recoveryPhase: firstRecoveryPhase,
  };
  state.intents[0].request = originalRequest;
  state.intents.push(targetIntent);
  state.positionSnapshot = structuredClone(expectedSnapshot);
  const recoveryPosition = structuredClone(expectedSnapshot);
  recoveryPosition.split.runnerCleanup.recoveryPhase = recoveryPhase;
  return {
    ...fixture,
    recoveryPhase,
    recoveryPosition,
    expectedRequest,
    expectedSnapshot,
    recoveryAttempt: 2,
    firstRecoveryPhase,
  };
}

test("recoverPreTransportRunnerCancel atomically marks refusal without claiming cancellation and safely replays", async () => {
  const fixture = runnerCancelRecoveryPool();
  const store = createVstStore(fixture.pool);
  const input = {
    sourceSignalId: fixture.sourceSignalId,
    clientOrderId: "runner-cancel-1",
    expectedRequest: fixture.expectedRequest,
    expectedSnapshot: fixture.expectedSnapshot,
    recoveryPhase: fixture.recoveryPhase,
    recoveryPosition: fixture.recoveryPosition,
  };
  const results = await Promise.all([
    store.recoverPreTransportRunnerCancel(input),
    store.recoverPreTransportRunnerCancel(input),
  ]);
  assert.deepEqual(results.map((result) => result.kind).sort(), ["recovered", "replayed"]);
  assert.equal(fixture.pool.state.signalStatus, "open");
  assert.deepEqual(fixture.pool.state.positionSnapshot, fixture.recoveryPosition);
  assert.equal(fixture.pool.state.intents[0].state, "failed");
  assert.equal(fixture.pool.state.intents[0].outcome.status, "pre_transport_refused_no_delete");
  assert.equal(fixture.pool.state.intents[0].outcome.recoveryPhase, fixture.recoveryPhase);
  assert.equal(fixture.pool.state.events.length, 1);
  assert.equal(fixture.pool.state.events[0].detail.canceled, false);
  assert.deepEqual(
    fixture.pool.statements.filter(({ sql }) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql))
      .map(({ sql }) => sql).sort(),
    ["BEGIN", "BEGIN", "COMMIT", "COMMIT"].sort(),
  );
  assertIntentSerializationLockOrder(fixture.pool.statements, fixture.sourceSignalId);
});

test("recoverPreTransportRunnerCancel fails closed on changed request, extra cancellation, or snapshot", async () => {
  const mismatch = runnerCancelRecoveryPool();
  await assert.rejects(createVstStore(mismatch.pool).recoverPreTransportRunnerCancel({
    sourceSignalId: mismatch.sourceSignalId,
    clientOrderId: "runner-cancel-1",
    expectedRequest: { ...mismatch.expectedRequest, originalStopOrderId: "different-stop" },
    expectedSnapshot: mismatch.expectedSnapshot,
    recoveryPhase: mismatch.recoveryPhase,
    recoveryPosition: mismatch.recoveryPosition,
  }), /request or deterministic phase mismatch/);

  const extra = runnerCancelRecoveryPool({ otherAttempt: true });
  const extraResult = await createVstStore(extra.pool).recoverPreTransportRunnerCancel({
    sourceSignalId: extra.sourceSignalId,
    clientOrderId: "runner-cancel-1",
    expectedRequest: extra.expectedRequest,
    expectedSnapshot: extra.expectedSnapshot,
    recoveryPhase: extra.recoveryPhase,
    recoveryPosition: extra.recoveryPosition,
  });
  assert.deepEqual(extraResult, { kind: "ineligible" });
  assert.equal(extra.pool.state.intents[0].state, "unknown");

  const changed = runnerCancelRecoveryPool();
  changed.pool.state.positionSnapshot.remainingQty = 1;
  const result = await createVstStore(changed.pool).recoverPreTransportRunnerCancel({
    sourceSignalId: changed.sourceSignalId,
    clientOrderId: "runner-cancel-1",
    expectedRequest: changed.expectedRequest,
    expectedSnapshot: changed.expectedSnapshot,
    recoveryPhase: changed.recoveryPhase,
    recoveryPosition: changed.recoveryPosition,
  });
  assert.deepEqual(result, { kind: "ineligible" });
  assert.equal(changed.pool.state.intents[0].state, "unknown");
  assert.equal(changed.pool.state.signalStatus, "unknown");
});

test("recoverPreTransportRunnerCancel never reopens a closed or errored signal", async () => {
  for (const status of ["closed", "error"]) {
    const fixture = runnerCancelRecoveryPool();
    fixture.pool.state.signalStatus = status;
    const result = await createVstStore(fixture.pool).recoverPreTransportRunnerCancel({
      sourceSignalId: fixture.sourceSignalId,
      clientOrderId: "runner-cancel-1",
      expectedRequest: fixture.expectedRequest,
      expectedSnapshot: fixture.expectedSnapshot,
      recoveryPhase: fixture.recoveryPhase,
      recoveryPosition: fixture.recoveryPosition,
    });
    assert.equal(result.kind, "ineligible");
    assert.equal(fixture.pool.state.signalStatus, status);
    assert.equal(fixture.pool.state.intents[0].state, "unknown");
    assert.equal(fixture.pool.state.events.length, 0);
  }
});

test("recoverPreTransportRunnerCancel safely records the exact second no-DELETE refusal", async () => {
  const fixture = runnerCancelSecondRecoveryPool();
  const store = createVstStore(fixture.pool);
  const input = {
    sourceSignalId: fixture.sourceSignalId,
    clientOrderId: "runner-cancel-2",
    expectedRequest: fixture.expectedRequest,
    expectedSnapshot: fixture.expectedSnapshot,
    recoveryPhase: fixture.recoveryPhase,
    recoveryPosition: fixture.recoveryPosition,
    recoveryAttempt: fixture.recoveryAttempt,
  };
  const previousAttempt = structuredClone(fixture.pool.state.intents[0]);
  const result = await store.recoverPreTransportRunnerCancel(input);

  assert.deepEqual(result, { kind: "recovered" });
  assert.equal(fixture.pool.state.intents.length, 2);
  assert.deepEqual(fixture.pool.state.intents[0], previousAttempt);
  assert.equal(fixture.pool.state.intents[1].state, "failed");
  assert.equal(fixture.pool.state.intents[1].outcome.status,
    "pre_transport_refused_no_delete");
  assert.equal(fixture.pool.state.intents[1].outcome.recoveryPhase,
    fixture.recoveryPhase);
  assert.equal(fixture.pool.state.positionSnapshot.split.runnerCleanup.recoveryPhase,
    fixture.recoveryPhase);
  assert.equal(fixture.pool.state.signalStatus, "open");
  assert.equal(fixture.pool.state.events.length, 1);
  assert.equal(fixture.pool.state.events[0].detail.recoveryAttempt, 2);
  assert.equal(fixture.pool.statements.some(({ sql }) =>
    sql.includes("FROM vst_order_intents") &&
      sql.includes("request->>'operation'") &&
      sql.includes("ORDER BY client_order_id FOR UPDATE")), true);

  const replay = await store.recoverPreTransportRunnerCancel(input);
  assert.deepEqual(replay, { kind: "replayed" });
  assert.equal(fixture.pool.state.events.length, 1);
});

test("second recovery accepts the persisted reconciliation error but rejects conflicting proof", async () => {
  const call = (fixture) => createVstStore(fixture.pool).recoverPreTransportRunnerCancel({
    sourceSignalId: fixture.sourceSignalId,
    clientOrderId: "runner-cancel-2",
    expectedRequest: fixture.expectedRequest,
    expectedSnapshot: fixture.expectedSnapshot,
    recoveryPhase: fixture.recoveryPhase,
    recoveryPosition: fixture.recoveryPosition,
    recoveryAttempt: 2,
  });
  const persisted = runnerCancelSecondRecoveryPool();
  persisted.pool.state.intents[1].outcome = {
    reason: "exchange_state_not_verified",
    submissionError: "BingXLiveApiError",
    submissionErrorMessage:
      "VST runner fill history does not uniquely link to its exact parent stop",
  };
  assert.deepEqual(await call(persisted), { kind: "recovered" });

  const conflicting = runnerCancelSecondRecoveryPool();
  conflicting.pool.state.intents[1].outcome.submissionError = "BingXLiveApiError";
  conflicting.pool.state.intents[1].outcome.submissionErrorMessage =
    "an inconsistent cancellation result";
  assert.deepEqual(await call(conflicting), { kind: "ineligible" });
  assert.equal(conflicting.pool.state.intents[1].state, "unknown");
});

test("recoverPreTransportRunnerCancel refuses a second recovery without exact prior history", async () => {
  const invoke = async (fixture) => createVstStore(fixture.pool)
    .recoverPreTransportRunnerCancel({
      sourceSignalId: fixture.sourceSignalId,
      clientOrderId: "runner-cancel-2",
      expectedRequest: fixture.expectedRequest,
      expectedSnapshot: fixture.expectedSnapshot,
      recoveryPhase: fixture.recoveryPhase,
      recoveryPosition: fixture.recoveryPosition,
      recoveryAttempt: 2,
    });

  const badPrior = runnerCancelSecondRecoveryPool();
  badPrior.pool.state.intents[0].outcome.recoveryPhase = "wrong-phase";
  assert.deepEqual(await invoke(badPrior), { kind: "ineligible" });
  assert.equal(badPrior.pool.state.intents[1].state, "unknown");

  const badTargetError = runnerCancelSecondRecoveryPool();
  badTargetError.pool.state.intents[1].outcome.errorMessage =
    "a different transport refusal";
  assert.deepEqual(await invoke(badTargetError), { kind: "ineligible" });
  assert.equal(badTargetError.pool.state.intents[1].state, "unknown");

  const changedSnapshot = runnerCancelSecondRecoveryPool();
  changedSnapshot.pool.state.positionSnapshot.split.runnerCleanup.recoveryPhase =
    "unexpected-phase";
  assert.deepEqual(await invoke(changedSnapshot), { kind: "ineligible" });
  assert.equal(changedSnapshot.pool.state.intents[1].state, "unknown");

  const thirdAttempt = runnerCancelSecondRecoveryPool();
  thirdAttempt.pool.state.intents.push({
    source_signal_id: thirdAttempt.sourceSignalId,
    phase: "impulse-runner-cancel-recovery-3-runner-child-1",
    client_order_id: "runner-cancel-3",
    request: {
      ...structuredClone(thirdAttempt.expectedRequest),
      originalStopOrderId: "different-original-stop",
    },
    state: "unknown",
    outcome: {},
  });
  assert.deepEqual(await invoke(thirdAttempt), { kind: "ineligible" });
  assert.equal(thirdAttempt.pool.state.intents[1].state, "unknown");
});

function raiseStopRecoveryPool({
  competing = false,
  failEvent = false,
  clock = () => NOW,
} = {}) {
  const canonicalJson = (value) => {
    if (Array.isArray(value)) return value.map(canonicalJson);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) =>
        [key, canonicalJson(value[key])]));
    }
    return value;
  };
  const sourceSignalId = "legacy-raise-stop-recovery-signal";
  const phase = "raise_stop-core-1790838521907";
  const clientOrderId = `vst-${createHash("sha256")
    .update(`${sourceSignalId}:${phase}`).digest("hex").slice(0, 30)}`;
  const positionId = "legacy-position-1";
  const entryOrderId = "legacy-entry-order-1";
  const entryClientOrderId = "legacy-entry-client-1";
  const updatedAt = "2026-10-02 00:00:00+00";
  const positionSnapshot = {
    sourceSignalId,
    status: "open",
    environment: "vst",
    accountId: "vst-account",
    symbol: "ETHUSDT",
    exchangePositionId: positionId,
    entryClientOrderId,
    remainingQty: "1",
    verifiedProtectiveStops: {
      core: {
        verified: true,
        orderId: "legacy-old-stop-1",
        positionId,
        quantity: "1",
        stopPrice: "0.4408",
      },
    },
    peakPct: 0.52,
    observedAt: new Date(NOW - 1_000).toISOString(),
  };
  const nextPosition = { ...structuredClone(positionSnapshot), stopPrice: "0.4915" };
  const expectedRequest = {
    operation: "raise_stop",
    environment: "vst",
    accountId: "vst-account",
    symbol: "ETHUSDT",
    entryClientOrderId,
    leg: "core",
    quantity: "1",
    previousQuantity: "1",
    stopPrice: "0.4915",
    // This pre-fix intent has neither priorPosition nor top-level positionId
    // or entryOrderId. Its old safety facts are in nextPosition.
    nextPosition,
  };
  const expectedOutcome = {
    reason: "exchange_state_not_verified",
    submissionError: "Error",
    submissionErrorMessage: "bingx_vst_entry_history_fills_unverified",
  };
  const entryIntent = {
    sourceSignalId,
    phase: "market-entry",
    clientOrderId: entryClientOrderId,
    state: "reconciled",
    exchangeOrderId: entryOrderId,
    request: {
      operation: "entry",
      environment: "vst",
      accountId: "vst-account",
      symbol: "ETHUSDT",
      entryOrderType: "MARKET",
      quantity: "1",
      intentCreatedAt: NOW - 10_000,
    },
    outcome: {
      verified: true,
      status: "filled",
      fillQuantity: "1",
      positionId,
    },
  };
  const proof = {
    entryClientOrderId,
    entryOrderId,
    positionId,
    entryOrderType: "MARKET",
    intentCreatedAt: NOW - 10_000,
    quantity: "1",
  };
  const target = {
    source_signal_id: sourceSignalId,
    phase,
    client_order_id: clientOrderId,
    request: expectedRequest,
    state: "unknown",
    exchange_order_id: null,
    outcome: expectedOutcome,
  };
  const state = {
    signalStatus: "unknown",
    positionStatus: "open",
    positionSnapshot: structuredClone(positionSnapshot),
    positionUpdatedAt: updatedAt,
    intents: [target, {
      source_signal_id: sourceSignalId,
      phase: "market-entry",
      client_order_id: entryClientOrderId,
      request: entryIntent.request,
      state: "reconciled",
      exchange_order_id: entryOrderId,
      outcome: entryIntent.outcome,
    }],
    events: [],
  };
  if (competing) {
    state.intents.push({
      source_signal_id: sourceSignalId,
      phase: "other-unresolved",
      client_order_id: "other-unresolved",
      request: { operation: "close_leg" },
      state: "unknown",
      exchange_order_id: null,
      outcome: {},
    });
  }
  const statements = [];
  let transactionTail = Promise.resolve();
  let failNextEvent = failEvent;
  const client = {
    async query(sql, params = []) {
      const normalized = sql.trim();
      if (normalized === "BEGIN") {
        let release;
        const prior = transactionTail;
        transactionTail = new Promise((resolve) => { release = resolve; });
        await prior;
        this.backup = structuredClone(state);
        this.releaseTransaction = release;
        statements.push({ sql: normalized, params });
        return { rowCount: 0, rows: [] };
      }
      statements.push({ sql: normalized, params });
      if (normalized === "COMMIT") {
        this.releaseTransaction?.();
        this.releaseTransaction = null;
        return { rowCount: 0, rows: [] };
      }
      if (normalized === "ROLLBACK") {
        Object.assign(state, this.backup);
        this.releaseTransaction?.();
        this.releaseTransaction = null;
        return { rowCount: 0, rows: [] };
      }
      if (normalized === INTENT_SERIALIZATION_LOCK_SQL) {
        return { rowCount: 1, rows: [{ pg_advisory_xact_lock: null }] };
      }
      if (normalized.includes("FROM vst_signals") && normalized.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [{
          source_signal_id: sourceSignalId,
          status: state.signalStatus,
          reason: null,
        }] };
      }
      if (normalized.includes("FROM vst_positions") && normalized.includes("FOR UPDATE")) {
        const matches = state.positionStatus === "open" &&
          state.positionUpdatedAt === params[1];
        return {
          rowCount: matches ? 1 : 0,
          rows: matches ? [{
            source_signal_id: sourceSignalId,
            symbol: "ETHUSDT",
            status: "open",
            snapshot: state.positionSnapshot,
            updated_at_text: state.positionUpdatedAt,
          }] : [],
        };
      }
      if (normalized.includes("FROM vst_order_intents") &&
          normalized.includes("client_order_id = $2 FOR UPDATE")) {
        const intent = state.intents.find((row) =>
          row.source_signal_id === params[0] && row.client_order_id === params[1]);
        return { rowCount: intent ? 1 : 0, rows: intent ? [intent] : [] };
      }
      if (normalized.includes("FROM vst_order_intents") &&
          normalized.includes("phase = 'market-entry'")) {
        const intent = state.intents.find((row) =>
          row.source_signal_id === params[0] && row.phase === "market-entry");
        return { rowCount: intent ? 1 : 0, rows: intent ? [intent] : [] };
      }
      if (normalized.includes("FROM vst_order_intents") &&
          normalized.includes("state IN ('prepared', 'submitted', 'unknown')")) {
        return {
          rowCount: state.intents.filter((row) =>
            row.source_signal_id === params[0] &&
            row.client_order_id !== params[1] &&
            ["prepared", "submitted", "unknown"].includes(row.state)).length,
          rows: state.intents.filter((row) =>
            row.source_signal_id === params[0] &&
            row.client_order_id !== params[1] &&
            ["prepared", "submitted", "unknown"].includes(row.state)),
        };
      }
      if (normalized.startsWith("UPDATE vst_order_intents")) {
        const intent = state.intents.find((row) => row.client_order_id === params[1]);
        if (!intent || intent.state !== "unknown" ||
            JSON.stringify(canonicalJson(intent.request)) !== params[3] ||
            JSON.stringify(canonicalJson(intent.outcome)) !== params[5]) {
          return { rowCount: 0, rows: [] };
        }
        intent.state = "failed";
        intent.outcome = JSON.parse(params[4]);
        return { rowCount: 1, rows: [{ client_order_id: intent.client_order_id }] };
      }
      if (normalized.startsWith("UPDATE vst_signals")) {
        if (state.signalStatus !== "unknown") return { rowCount: 0, rows: [] };
        state.signalStatus = "open";
        return { rowCount: 1, rows: [{ source_signal_id: sourceSignalId }] };
      }
      if (normalized.startsWith("INSERT INTO vst_events")) {
        if (failNextEvent) {
          failNextEvent = false;
          throw new Error("simulated crash before recovery event");
        }
        state.events.push({
          sourceSignalId: params[0],
          clientOrderId: params[1],
          kind: "vst_raise_stop_pre_upgrade_refusal_confirmed",
          detail: JSON.parse(params[2]),
        });
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query in raiseStopRecoveryPool: ${normalized}`);
    },
    release() {},
  };
  const pool = {
    state,
    statements,
    async connect() { return client; },
    async query() { throw new Error("raise_stop recovery must use a transaction"); },
  };
  return {
    pool,
    sourceSignalId,
    clientOrderId,
    phase,
    expectedRequest,
    expectedOutcome,
    positionSnapshot,
    updatedAt,
    entryIntent,
    proof,
    input: {
      sourceSignalId,
      clientOrderId,
      phase,
      expectedRequest,
      expectedOutcome,
      expectedPositionSnapshot: positionSnapshot,
      expectedPositionUpdatedAt: updatedAt,
      expectedEntryIntent: entryIntent,
      entryProof: proof,
      requestStartedAtMs: NOW - 1_000,
      maxEvidenceAgeMs: 5_000,
      clock,
      oldPositionAndStop: {
        positionId,
        quantity: "1",
        stopOrderId: "legacy-old-stop-1",
        stopPrice: "0.4408",
        executionProof: {
          orderId: "legacy-old-stop-1",
          executedQty: "0.000",
        },
      },
    },
  };
}

test("raise_stop refusal recovery atomically CAS-settles an untouched pre-fix request", async () => {
  const fixture = raiseStopRecoveryPool();
  const store = createVstStore(fixture.pool);
  const input = fixture.input;
  const result = await store.recoverRaiseStopPreUpgradeRefusal(input);
  assert.deepEqual(result, { kind: "recovered" });
  assert.equal(fixture.pool.state.intents[0].state, "failed");
  assert.equal(fixture.pool.state.signalStatus, "open");
  assert.deepEqual(fixture.pool.state.positionSnapshot, fixture.positionSnapshot);
  assert.equal(fixture.pool.state.events.length, 1);
  assert.deepEqual(fixture.pool.state.intents[0].request, fixture.expectedRequest);
  assert.equal(fixture.expectedRequest.nextPosition.stopPrice, "0.4915");
  assert.equal(fixture.expectedRequest.nextPosition.verifiedProtectiveStops.core.stopPrice,
    "0.4408");
  assert.equal(fixture.entryIntent.request.entryOrderType, "MARKET");
  assert.deepEqual(
    fixture.pool.statements.filter(({ sql }) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql))
      .map(({ sql }) => sql),
    ["BEGIN", "COMMIT"],
  );

  const explicit = raiseStopRecoveryPool();
  explicit.expectedOutcome = {
    reason: "exchange_state_not_verified",
    submissionError: "Error",
    submissionErrorMessage:
      "bingx_vst_entry_history_fills_unverified " +
      "(bingx_vst_raise_stop_entry_fill_proof_refused_before_upgrade)",
    preSignReason: "bingx_vst_raise_stop_entry_fill_proof_refused_before_upgrade",
  };
  explicit.pool.state.intents[0].outcome = explicit.expectedOutcome;
  explicit.input.expectedOutcome = explicit.expectedOutcome;
  assert.deepEqual(
    await createVstStore(explicit.pool)
      .recoverRaiseStopPreUpgradeRefusal(explicit.input),
    { kind: "recovered" },
    "normalization preserves the explicit pre-sign no-write marker",
  );

  const concurrent = raiseStopRecoveryPool();
  const concurrentStore = createVstStore(concurrent.pool);
  const results = await Promise.all([
    concurrentStore.recoverRaiseStopPreUpgradeRefusal(concurrent.input),
    concurrentStore.recoverRaiseStopPreUpgradeRefusal(concurrent.input),
  ]);
  assert.deepEqual(results.map(({ kind }) => kind).sort(), ["ineligible", "recovered"]);
  assert.equal(concurrent.pool.state.events.length, 1);
});

test("raise_stop recovery fails closed on competing/manual/CAS changes and rolls back crashes", async () => {
  for (const [label, mutate] of [
    ["missing raw execution quantity", (proof) => { delete proof.executedQty; }],
    ["nonzero raw execution quantity", (proof) => { proof.executedQty = "1"; }],
    ["malformed execution alias", (proof) => { proof.cumExecQty = "bad"; }],
  ]) {
    const invalidExecutionProof = raiseStopRecoveryPool();
    mutate(invalidExecutionProof.input.oldPositionAndStop.executionProof);
    assert.deepEqual(
      await createVstStore(invalidExecutionProof.pool)
        .recoverRaiseStopPreUpgradeRefusal(invalidExecutionProof.input),
      { kind: "ineligible" },
      label,
    );
    assert.equal(invalidExecutionProof.pool.state.intents[0].state, "unknown", label);
    assert.equal(invalidExecutionProof.pool.statements.some(({ sql }) =>
      sql === "BEGIN"), false, label);
  }

  const competing = raiseStopRecoveryPool({ competing: true });
  assert.deepEqual(
    await createVstStore(competing.pool)
      .recoverRaiseStopPreUpgradeRefusal(competing.input),
    { kind: "ineligible" },
  );
  assert.equal(competing.pool.state.intents[0].state, "unknown");

  const manual = raiseStopRecoveryPool();
  manual.input.expectedPositionSnapshot.manualResolution = {
    resolvedBy: "owner",
  };
  manual.pool.state.positionSnapshot.manualResolution = {
    resolvedBy: "owner",
  };
  assert.deepEqual(
    await createVstStore(manual.pool)
      .recoverRaiseStopPreUpgradeRefusal(manual.input),
    { kind: "ineligible" },
  );
  assert.equal(manual.pool.state.intents[0].state, "unknown");

  const changed = raiseStopRecoveryPool();
  changed.pool.state.positionUpdatedAt = "2026-10-02 00:00:01+00";
  assert.deepEqual(
    await createVstStore(changed.pool)
      .recoverRaiseStopPreUpgradeRefusal(changed.input),
    { kind: "ineligible" },
  );
  assert.equal(changed.pool.state.signalStatus, "unknown");

  const crashed = raiseStopRecoveryPool({ failEvent: true });
  await assert.rejects(createVstStore(crashed.pool)
    .recoverRaiseStopPreUpgradeRefusal(crashed.input),
  /simulated crash/);
  assert.equal(crashed.pool.state.intents[0].state, "unknown");
  assert.equal(crashed.pool.state.signalStatus, "unknown");
  assert.deepEqual(crashed.pool.state.positionSnapshot, crashed.positionSnapshot);
  assert.equal(crashed.pool.state.events.length, 0);
});

test("raise_stop recovery rechecks account-proof age through ledger commit", async () => {
  for (const lockedAt of [NOW + 5_001, NOW - 1_001]) {
    const fixture = raiseStopRecoveryPool();
    fixture.input.clock = () => lockedAt;
    assert.deepEqual(
      await createVstStore(fixture.pool)
        .recoverRaiseStopPreUpgradeRefusal(fixture.input),
      { kind: "ineligible" },
    );
    assert.equal(fixture.pool.state.intents[0].state, "unknown");
    assert.equal(fixture.pool.statements.some(({ sql }) =>
      sql.includes("FROM vst_signals")), false);
  }
  let clockCalls = 0;
  const agedDuringCas = raiseStopRecoveryPool({
    clock: () => ++clockCalls === 1 ? NOW : NOW + 5_001,
  });
  assert.deepEqual(
    await createVstStore(agedDuringCas.pool)
      .recoverRaiseStopPreUpgradeRefusal(agedDuringCas.input),
    { kind: "ineligible" },
  );
  assert.equal(agedDuringCas.pool.state.intents[0].state, "unknown",
    "evidence that expires before the settlement CAS remains unresolved");

  const tooLong = raiseStopRecoveryPool();
  tooLong.input.maxEvidenceAgeMs = 30_000;
  assert.deepEqual(
    await createVstStore(tooLong.pool)
      .recoverRaiseStopPreUpgradeRefusal(tooLong.input),
    { kind: "ineligible" },
  );
  assert.equal(tooLong.pool.statements.some(({ sql }) => sql === "BEGIN"), false);
});
test("an ambiguous entry is retired as an error only with a read-only proof it never executed", async () => {
  const store = memoryStore(null);
  const clientOrderId = "entry-ambiguous-flat-timeout";
  store.data.intents.push({
    sourceSignalId: "cab-signal-entry-ambiguous-flat",
    phase: "market-entry",
    clientOrderId,
    request: {
      operation: "entry",
      environment: "vst",
      accountId: "vst-account",
      symbol: "OFCUSDT",
      intentCreatedAt: NOW - 11 * 60 * 1000,
    },
    state: "unknown",
  });
  let submissions = 0;
  const proofCalls = [];
  const broker = {
    ...guardedBroker(store, {
      currentPosition: null,
      onPerform: () => { submissions++; },
    }),
    proveEntryNotExecuted: async (input) => {
      proofCalls.push(input);
      return true;
    },
  };
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000,
      maxPriceMoveBps: 500, maxSlippageBps: 100,
    },
  });
  await worker.runOnce();
  const intent = store.data.intents.find((row) => row.clientOrderId === clientOrderId);
  assert.equal(proofCalls[0]?.clientOrderId, clientOrderId);
  assert.equal(intent.state, "failed");
  assert.equal(submissions, 0, "never resubmitted");
  assert.equal(store.data.positions.length, 0, "never invents a fill");
});

test("subscriber cross-margin profile prepares CROSSED margin, then its own leverage", async () => {
  const profile = { leverage: 5, marginMode: "CROSSED", allocation: { mode: "amount", value: 50 } };
  const signalBody = activePolicy({ stopLoss: "95" });
  const store = memoryStore(signalBody);
  const requests = [];
  let marginMode = "ISOLATED";
  const broker = guardedBroker(store, {
    currentPosition: null,
    onPerform: async ({ request }) => {
      requests.push(request);
      if (request.operation === "prepare_margin_mode") marginMode = request.targetMarginMode;
    },
    reconcile: async ({ request }) => request.operation === "prepare_margin_mode"
      ? { verified: true, status: "filled", marginMode }
      : {
        verified: true, status: "filled",
        position: { verified: true, marginMode, leverage: request.leverage },
      },
  });
  broker.readPlanningInputs = async () => ({
    ...safePlanningInputs(),
    marginMode,
    marginModeVerified: marginMode === "CROSSED",
    requiresIsolatedMarginPreparation: marginMode !== "CROSSED",
  });
  const worker = createVstWorker({
    store, broker, clock: () => NOW, positionProfile: profile,
    sizingLimits: { environment: "vst", maxQuoteAgeMs: 10_000, maxSlippageBps: 100 },
  });

  const first = await worker.runOnce();
  assert.equal(first.kind, "prepared");
  assert.equal(requests[0].operation, "prepare_margin_mode");
  assert.equal(requests[0].targetMarginMode, "CROSSED");

  const second = await worker.runOnce();
  assert.equal(second.kind, "prepared", JSON.stringify(second));
  assert.equal(requests[1].operation, "set_isolated_leverage");
  assert.equal(requests[1].leverage, 5);
  assert.equal(requests[1].marginMode, "CROSSED");
});

test("owner worker still refuses a symbol that is in cross margin without preparation", async () => {
  const signalBody = activePolicy({ stopLoss: "95" });
  const store = memoryStore(signalBody);
  const broker = guardedBroker(store, { currentPosition: null });
  broker.readPlanningInputs = async () =>
    ({ ...safePlanningInputs({ marginMode: "CROSSED" }), marginModeVerified: true });
  const result = await createVstWorker({
    store, broker, clock: () => NOW,
    sizingLimits: { environment: "vst", maxQuoteAgeMs: 10_000, maxSlippageBps: 100 },
  }).runOnce();
  assert.equal(result.kind, "rejected");
  assert.equal(result.reason, "vst_margin_mode_state_not_verified_or_preparable");
});
