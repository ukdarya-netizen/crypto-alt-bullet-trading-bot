import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createVstBroker } from "../vst-broker.mjs";
import { deriveVstExchangeClientOrderId } from "../vst-historical-close-evidence.mjs";
import { createVstWorker } from "../vst-worker.mjs";

const ORIGINAL_PAUSE = process.env.BULLET_VST_PAUSED;
process.env.BULLET_VST_PAUSED = "0";
after(() => {
  if (ORIGINAL_PAUSE === undefined) delete process.env.BULLET_VST_PAUSED;
  else process.env.BULLET_VST_PAUSED = ORIGINAL_PAUSE;
});

const NOW = Date.parse("2026-10-02T00:00:00.000Z");
const ACCOUNT = "bingx-vst";
const FEATURES = [
  "vst_only",
  "complete_order_lookup",
  "guarded_long10_leverage_preparation",
  "atomic_protected_market_entry",
  "verified_core_stop_state",
  "verified_exact_full_position_close",
  "verified_exact_source_full_position_close",
  "verified_source_flat_stop_cleanup",
  "verified_position_state",
];
const LEGACY_POSITIONS = [
  {
    symbol: "HBARUSDT", quantity: "93200", price: "0.10465", residual: "52000",
    intentCreatedAt: 1790709045621,
    entryAt: Date.parse("2026-09-29T19:11:06.000Z"),
    nativeEntryOrderType: "LIMIT",
  },
  {
    symbol: "GRTUSDT", quantity: "339778", price: "0.0287", residual: "339778",
    intentCreatedAt: 1790745323282,
    entryAt: Date.parse("2026-09-30T05:15:44.000Z"),
    entryOrderId: "2105164669871194113",
    positionId: "2105164670017994753",
    nativeEntryOrderType: "LIMIT",
  },
  {
    symbol: "AKEUSDT", quantity: "288618", price: "0.0214", residual: "288618",
    entryOrderType: "MARKET", nativeEntryOrderType: "MARKET",
  },
  {
    symbol: "PENGUUSDT", quantity: "501052.2", price: "0.0084", residual: "501052.2",
    entryOrderType: "MARKET", nativeEntryOrderType: "MARKET",
  },
  {
    symbol: "SUIUSDT", quantity: "7752", price: "2.901", residual: "7752",
    entryOrderType: "MARKET", nativeEntryOrderType: "MARKET",
  },
  {
    symbol: "DASHUSDT", quantity: "154.65", price: "24.83", residual: "154.65",
    entryOrderType: "MARKET", nativeEntryOrderType: "MARKET",
  },
];

function assertPersistable(value, path = "$", ancestors = new Set()) {
  assert.notEqual(value, undefined, `undefined value at ${path}`);
  if (value === null || typeof value !== "object") return;
  assert.equal(ancestors.has(value), false, `cycle at ${path}`);
  ancestors.add(value);
  for (const [key, nested] of Object.entries(value)) {
    assertPersistable(nested, `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

function acceptedSourceExit(sourceSignalId, symbol) {
  const oldAt = new Date(NOW - 60_000).toISOString();
  const asOf = new Date(NOW - 30_000).toISOString();
  const evidence = {
    sourceSignalId,
    symbol,
    reason: "source_withdrawal",
    sourceStatus: "reclassified",
    sourceUpdatedAt: oldAt,
    sourceClosedAt: null,
    sourceExitPrice: null,
    sourceCancelReason: "withdrawn",
    exitDecisionAt: oldAt,
    asOf,
    observedAt: asOf,
  };
  return {
    requestId: `source-exit-${sourceSignalId}`,
    sourceSignalId,
    symbol,
    reason: "source_withdrawal",
    asOf,
    observedAt: asOf,
    evidence,
  };
}

function nativeVstBroker(contexts, writes) {
  const findContext = (symbol) => [...contexts.values()].find((item) =>
    item.exchangeSymbol === symbol || item.positionSpec.symbol === symbol);
  const api = {
    async getBalance() { return [{ asset: "VST", balance: "1000", availableMargin: "100" }]; },
    async getPositions(symbol) {
      const rows = [...contexts.values()]
        .filter((item) => !item.flat)
        .map((item) => ({
          symbol: item.exchangeSymbol,
          positionSide: "LONG",
          positionAmt: item.positionSpec.residual,
          avgPrice: item.positionSpec.price,
          positionID: item.positionId,
          leverage: 10,
          marginType: "ISOLATED",
        }));
      return symbol ? rows.filter((row) => row.symbol ===
        String(symbol).replace(/USDT$/, "-USDT")) : rows;
    },
    async getOpenOrders(symbol) {
      const rows = [...contexts.values()].filter((item) => item.stopPresent)
        .map((item) => ({ ...item.stop }));
      return symbol ? rows.filter((row) => row.symbol ===
        String(symbol).replace(/USDT$/, "-USDT")) : rows;
    },
    async getPositionMode() { return "HEDGE"; },
    async getMarginType() { return "ISOLATED"; },
    async getLeverage() { return { longLeverage: 10, shortLeverage: 3 }; },
    async contract(symbol) {
      const item = findContext(symbol);
      return {
        symbol: item?.exchangeSymbol ?? String(symbol).replace(/USDT$/, "-USDT"),
        pricePrecision: 8,
        quantityPrecision: 8,
        minQuantity: 0.00000001,
        minNotional: 0.00000001,
        maxLeverage: 10,
      };
    },
    async getRiskTiers() { return [{ maxNotional: 1_000_000_000, maintenanceMarginRate: 0.005 }]; },
    async getFeeRate() { return { maker: 0, taker: 0 }; },
    async getFunding() { return { rate: 0, nextFundingTime: NOW + 60_000 }; },
    async queryOrderHistory(symbol, range) {
      const item = findContext(symbol);
      if (item) {
        item.nativeProofHistoryReads += 1;
        item.historyRanges.push(range);
      }
      if (item?.entryHistoryError) {
        const error = new Error("BingX error code 109421");
        error.code = "109421";
        throw error;
      }
      return item?.history ?? [];
    },
    async queryOrder(symbol, identifier) {
      const item = findContext(symbol);
      const rows = item?.history ?? [];
      if (identifier?.orderId === item?.entryOrderId) {
        item.nativeProofOrderReads += 1;
        item.nativeProofOrderQueries.push({ ...identifier });
        if (item.entryHistoryError) {
          const error = new Error("exact native parent lookup failed");
          error.code = "109421";
          throw error;
        }
        return rows.find((row) => row.orderId === identifier.orderId) ?? null;
      }
      if (identifier?.clientOrderId &&
          [item?.entryClientOrderId,
            item ? deriveVstExchangeClientOrderId(item.entryClientOrderId) : null]
            .includes(identifier.clientOrderId)) {
        item.nativeProofClientOrderReads += 1;
        return null;
      }
      return rows.find((row) =>
        identifier?.orderId === row.orderId ||
        identifier?.clientOrderId === row.clientOrderId) ?? null;
    },
    async queryFills(symbol, range) {
      const item = findContext(symbol);
      if (!item) return [];
      if (range?.orderId === item.entryOrderId) {
        item.nativeProofFillReads += 1;
        item.nativeProofFillRanges.push({ ...range });
        assert.ok(range.endTs >= range.startTs);
        assert.ok(range.endTs - range.startTs <= 10 * 60_000 + 30_000,
          "native entry fills use only the original bounded entry window");
        if (item.entryFillsUnavailable) return [];
      }
      return item.fills.filter((fill) => {
        const filledAt = Number(fill.filledTm);
        return fill.orderId === range?.orderId &&
          (!Number.isFinite(filledAt) ||
            filledAt >= Number(range.startTs) &&
            filledAt <= Number(range.endTs));
      });
    },
    async setVstLongLeverage10() {},
    async placeVstAutomatedLong() {},
    async upgradeVstLongStop() {},
    async getVstMarkPrice(symbol) {
      const item = findContext(symbol);
      return {
        symbol: item?.exchangeSymbol ?? String(symbol).replace(/USDT$/, "-USDT"),
        markPrice: item?.positionSpec.price ?? "1",
        timestamp: NOW,
      };
    },
    async closeLong(symbol, quantity, clientOrderId, positionId, options) {
      const item = findContext(symbol);
      assert.ok(item);
      assert.equal(item.flat, false);
      assert.equal(String(quantity), item.positionSpec.residual);
      assert.equal(positionId, item.positionId);
      assert.equal(options?.sourceExitRequest?.entryOrderId, item.entryOrderId);
      writes.push({ operation: "close_leg", sourceSignalId: item.sourceSignalId });
      const orderId = `native-close-${item.positionSpec.symbol}`;
      const order = {
        symbol: item.exchangeSymbol,
        orderId,
        clientOrderId,
        status: "FILLED",
        side: "SELL",
        positionSide: "LONG",
        type: "MARKET",
        positionID: item.positionId,
        origQty: String(quantity),
        executedQty: String(quantity),
        time: NOW,
        updateTime: NOW,
      };
      item.history.push(order);
      item.fills.push({
        symbol: item.exchangeSymbol,
        orderId,
        tradeId: `native-close-fill-${item.positionSpec.symbol}`,
        side: "SELL",
        positionSide: "LONG",
        qty: String(quantity),
        price: item.positionSpec.price,
        filledTm: NOW,
        commission: "0",
        currency: "VST",
        commissionAsset: "VST",
      });
      item.flat = true;
    },
    async cancelVstAutomatedKnownStopWhenFlat(request) {
      const item = findContext(request.symbol);
      assert.ok(item);
      assert.equal(item.flat, true);
      assert.equal(request.stopToCancel.orderId, item.stopOrderId);
      writes.push({ operation: "cancel_flat_split_stop", sourceSignalId: item.sourceSignalId });
      const canceled = {
        ...item.stop,
        status: "CANCELED",
        executedQty: "0",
        updateTime: NOW,
      };
      item.history.push(canceled);
      item.stopPresent = false;
      return {
        verified: true,
        symbol: item.exchangeSymbol,
        positionId: item.positionId,
        cancellationIntentId: request.cancellationIntentId,
        canceledStopOrderId: item.stopOrderId,
        status: "CANCELED",
        flat: true,
        knownRemainingStopOrderIds: [...request.knownRemainingStopOrderIds],
        remainingKnownStopOrderIds: [],
      };
    },
  };
  const native = createVstBroker({
    api,
    accountId: ACCOUNT,
    canarySymbols: [...contexts.values()].map((item) => item.positionSpec.symbol),
    clock: () => NOW,
    sleep: async () => {},
    stopBufferRate: 0.005,
  });
  return {
    ...native,
    async getCapabilities() {
      return {
        environment: "vst",
        verified: true,
        accountId: ACCOUNT,
        features: FEATURES,
      };
    },
  };
}

function fixture(positionSpec, {
  entryIntentOverrides = {},
  snapshotOverrides = {},
  failReserveSignalId = null,
  entryHistoryError = false,
  entryFillsUnavailable = false,
  onTiming = async () => {},
} = {}) {
  const sourceSignalId = `legacy-${positionSpec.symbol.toLowerCase()}`;
  const entryClientOrderId = `entry-client-${positionSpec.symbol.toLowerCase()}`;
  const entryOrderId = positionSpec.entryOrderId ??
    `entry-order-${positionSpec.symbol.toLowerCase()}`;
  const positionId = positionSpec.positionId ??
    `position-${positionSpec.symbol.toLowerCase()}`;
  const stopOrderId = `core-stop-${positionSpec.symbol.toLowerCase()}`;
  const intentCreatedAt = positionSpec.intentCreatedAt ?? NOW - 120_000;
  const entryAt = positionSpec.entryAt ?? NOW - 120_000;
  const stopPrice = "0.07";
  const stopQuantity = positionSpec.quantity;
  const exchangeSymbol = positionSpec.symbol.replace("USDT", "-USDT");
  const stop = {
    symbol: exchangeSymbol,
    orderId: stopOrderId,
    mainOrderId: entryOrderId,
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    workingType: "MARK_PRICE",
    positionId,
    origQty: stopQuantity,
    stopPrice,
    executedQty: "0",
  };
  const snapshot = {
    sourceSignalId,
    symbol: positionSpec.symbol,
    status: "open",
    executionStatus: "open",
    environment: "vst",
    accountId: ACCOUNT,
    exchangePositionId: positionId,
    entryClientOrderId,
    entryAt: new Date(entryAt).toISOString(),
    entryPrice: positionSpec.price,
    quantity: positionSpec.quantity,
    remainingQty: positionSpec.residual,
    ...(positionSpec.entryOrderType
      ? { entryOrderType: positionSpec.entryOrderType } : {}),
    coreStopOrderId: stopOrderId,
    coreStopPositionId: positionId,
    coreStopQuantity: stopQuantity,
    coreStopPrice: stopPrice,
    verifiedProtectiveStops: {
      core: {
        verified: true,
        orderId: stopOrderId,
        positionId,
        quantity: stopQuantity,
        stopPrice,
      },
    },
    // This historical nested ID is not entry proof and must never substitute
    // for the reconciled market-entry intent.
    marginTopUp: {
      status: "verified",
      entryOrderId: `untrusted-margin-entry-${positionSpec.symbol}`,
    },
    ...snapshotOverrides,
  };
  const legacyWithoutIdentity = LEGACY_POSITIONS
    .slice(0, 5).some((item) => item.symbol === positionSpec.symbol);
  if (!legacyWithoutIdentity) snapshot.entryOrderId = entryOrderId;

  const entryIntent = {
    sourceSignalId,
    phase: "market-entry",
    clientOrderId: entryClientOrderId,
    state: "reconciled",
    request: {
      operation: "entry",
      ...(positionSpec.entryOrderType
        ? { entryOrderType: positionSpec.entryOrderType } : {}),
      symbol: positionSpec.symbol,
      environment: "vst",
      accountId: ACCOUNT,
      intentCreatedAt,
      quantity: positionSpec.quantity,
      sizing: {
        environment: "vst",
        quantity: positionSpec.quantity,
      },
      signal: {
        sourceSignalId,
        symbol: positionSpec.symbol,
        orderType: "market",
      },
    },
    exchangeOrderId: entryOrderId,
    outcome: {
      status: "filled",
      verified: true,
      fillPrice: positionSpec.price,
      fillQuantity: positionSpec.quantity,
      positionId,
      stopOrderId,
      stopQuantity,
    },
    ...entryIntentOverrides,
  };

  const positionRecord = {
    sourceSignalId,
    symbol: positionSpec.symbol,
    status: "open",
    snapshot,
  };
  const sourceExitRequest = acceptedSourceExit(sourceSignalId, positionSpec.symbol);
  const data = {
    positions: [positionRecord],
    intents: [entryIntent],
    sourceExitRequests: [{ ...sourceExitRequest, state: "pending" }],
    writes: [],
    sourceExitReservations: [],
  };
  const contexts = new Map();
  const context = {
    sourceSignalId,
    positionSpec,
    entryIntent,
    entryClientOrderId,
    entryOrderId,
    positionId,
    stopOrderId,
    stop,
    exchangeSymbol,
    flat: false,
    stopPresent: true,
    entryHistoryError,
    entryFillsUnavailable,
      nativeProofHistoryReads: 0,
      nativeProofOrderReads: 0,
      nativeProofClientOrderReads: 0,
      nativeProofOrderQueries: [],
    nativeProofFillReads: 0,
      nativeProofFillRanges: [],
    historyRanges: [],
    history: [{
      symbol: exchangeSymbol,
      orderId: entryOrderId,
      clientOrderId: deriveVstExchangeClientOrderId(entryClientOrderId),
      status: "FILLED",
      side: "BUY",
      positionSide: "LONG",
      type: positionSpec.nativeEntryOrderType ?? "MARKET",
      ...(positionSpec.timeInForce
        ? { timeInForce: positionSpec.timeInForce } : {}),
      positionID: positionId,
      origQty: positionSpec.quantity,
      executedQty: positionSpec.quantity,
      avgPrice: positionSpec.price,
      time: entryAt,
      updateTime: entryAt,
    }],
    fills: [{
      symbol: exchangeSymbol,
      orderId: entryOrderId,
      tradeId: `native-entry-fill-${positionSpec.symbol}`,
      side: "BUY",
      positionSide: "LONG",
      qty: positionSpec.quantity,
      price: positionSpec.price,
      positionID: positionId,
      filledTm: entryAt,
      commission: "0",
      currency: "USDT",
      commissionAsset: "VST",
    }],
  };
  contexts.set(positionSpec.symbol, context);
  const store = {
    async withLeaderLock(callback) { return callback(); },
    async getPending() { return null; },
    async queueSourceExitRequests() { return { queued: [], refreshed: [], rejected: [] }; },
    async listOpenPositions() {
      return data.positions.filter((row) =>
        ["open", "closing", "unknown"].includes(row.status));
    },
    async listUnresolvedIntents() {
      return data.intents.filter((intent) =>
        ["prepared", "submitted", "unknown"].includes(intent.state));
    },
    async getPosition(id) {
      return data.positions.find((row) => row.sourceSignalId === id) ?? null;
    },
    async getIntent(id, phase) {
      const intent = data.intents.find((row) =>
        row.sourceSignalId === id && row.phase === phase);
      return intent ? structuredClone(intent) : null;
    },
    async listPendingSourceExitRequests() {
      return data.sourceExitRequests
        .filter((row) => row.state === "pending")
        .map(({ state: _state, ...row }) => structuredClone(row));
    },
    async hasPendingSourceExitRequest(id) {
      return data.sourceExitRequests.some((row) =>
        row.sourceSignalId === id && row.state === "pending");
    },
    async reserveIntent(intent) {
      assertPersistable(intent);
      if (intent.sourceSignalId === failReserveSignalId) {
        const error = new TypeError(
          "Persisted objects must not contain undefined values",
        );
        error.privateAuthToken = "private-auth-token=not-for-logs";
        throw error;
      }
      const prior = data.intents.find((row) =>
        row.sourceSignalId === intent.sourceSignalId &&
        row.phase === intent.phase);
      if (prior) return { kind: "existing", intent: prior };
      const row = { ...structuredClone(intent), state: "prepared" };
      data.intents.push(row);
      if (intent.request.sourceExit?.stage === "close") {
        data.sourceExitReservations.push(row);
      }
      return { kind: "new", intent: row };
    },
    async markIntent(clientOrderId, state, detail = {}) {
      const row = data.intents.find((intent) =>
        intent.clientOrderId === clientOrderId);
      assert.ok(row);
      Object.assign(row, { state, detail: structuredClone(detail),
        outcome: detail.outcome ?? null });
    },
    async commitVerifiedIntent(commit) {
      assertPersistable(commit);
      const intent = data.intents.find((row) =>
        row.clientOrderId === commit.clientOrderId);
      assert.ok(intent);
      Object.assign(intent, {
        state: "reconciled",
        exchangeOrderId: commit.exchangeOrderId ?? null,
        outcome: structuredClone(commit.outcome),
        detail: { outcome: structuredClone(commit.outcome) },
      });
      const position = {
        sourceSignalId: commit.sourceSignalId,
        symbol: commit.position.symbol,
        status: commit.position.status,
        snapshot: structuredClone(commit.position),
      };
      const index = data.positions.findIndex((row) =>
        row.sourceSignalId === commit.sourceSignalId);
      if (index < 0) data.positions.push(position);
      else data.positions[index] = position;
    },
    async upsertPosition(position) {
      assertPersistable(position);
      const row = data.positions.find((item) =>
        item.sourceSignalId === position.sourceSignalId);
      if (row) {
        Object.assign(row, {
          symbol: position.symbol,
          status: position.status,
          snapshot: structuredClone(position),
        });
      } else {
        data.positions.push({
          sourceSignalId: position.sourceSignalId,
          symbol: position.symbol,
          status: position.status,
          snapshot: structuredClone(position),
        });
      }
    },
    async setSignalStatus(sourceSignalId, status, reason = null) {
      for (const row of data.positions) {
        if (row.sourceSignalId === sourceSignalId) row.status = status;
      }
      data.status = status;
      data.reason = reason;
    },
    async recordEvent() {},
    async finishSourceExitRequest(requestId, result) {
      const row = data.sourceExitRequests.find((item) =>
        item.requestId === requestId && item.state === "pending");
      if (row) Object.assign(row, { state: "finished", result });
    },
  };

  const broker = nativeVstBroker(contexts, data.writes);
  const worker = createVstWorker({
    store,
    broker,
    clock: () => NOW,
    sourceExitsEnabled: true,
    sizingLimits: { environment: "vst" },
    onTiming,
  });
  return {
    worker,
    store,
    broker,
    data,
    entryIntent,
    snapshot,
    context,
    attach(other) {
      data.positions.push(...other.data.positions);
      data.intents.push(...other.data.intents);
      data.sourceExitRequests.push(...other.data.sourceExitRequests);
      for (const [symbol, item] of other.contexts) contexts.set(symbol, item);
    },
    contexts,
  };
}

test("a retired ambiguous stop cannot veto a fresh strictly verified source exit and cleanup", async () => {
  const spec = LEGACY_POSITIONS.at(-1);
  const degradation = {
    version: 1, status: "protected_degraded",
    originalClientOrderId: "old-ambiguous-stop", originalPhase: "old-stop-phase",
    originalExecution: "unknown_unproven", originalWriteAttributed: false,
  };
  const f = fixture(spec, { snapshotOverrides: { protectionDegradation: degradation } });
  f.data.intents.push({
    sourceSignalId: f.data.positions[0].sourceSignalId,
    phase: degradation.originalPhase, clientOrderId: degradation.originalClientOrderId,
    state: "failed", exchangeOrderId: null,
    request: { operation: "raise_stop", symbol: spec.symbol },
    outcome: { reason: "raise_stop_protected_degraded", originalExecution: "unknown_unproven" },
  });
  const closed = await f.worker.runOnce();
  assert.equal(closed.operation, "source_exit_close", JSON.stringify(closed));
  assert.equal(f.data.writes.length, 1);
  assert.equal(f.data.writes[0].operation, "close_leg");
  assert.equal(f.data.positions[0].snapshot.protectionDegradation.originalWriteAttributed, false);
  const cleanup = await f.worker.runOnce();
  assert.equal(cleanup.operation, "source_exit_stop_cleanup", JSON.stringify(cleanup));
  assert.equal(f.data.sourceExitRequests[0].state, "finished");
  assert.equal(f.data.intents.find(intent =>
    intent.clientOrderId === degradation.originalClientOrderId).exchangeOrderId, null);
});

test("cancelled review closes VST through native proof and cleanup once, including after restart", async () => {
  const value = fixture(LEGACY_POSITIONS[1]);
  const request = value.data.sourceExitRequests[0];
  Object.assign(request.evidence, { sourceStatus: "cancelled", sourceAction: "review" });
  value.store.getSourceControl = async () => ({
    sourceSignalId: request.sourceSignalId, symbol: request.symbol,
    sourceStatus: "cancelled", sourceAction: "review",
  });
  const close = await value.worker.runOnce();
  assert.equal(close.kind, "acted", JSON.stringify(close));
  assert.equal(close.operation, "source_exit_close");
  assert.equal(value.data.writes.filter(write => write.operation === "close_leg").length, 1);
  const restarted = createVstWorker({
    store: value.store, broker: value.broker, clock: () => NOW,
    sourceExitsEnabled: true, sizingLimits: { environment: "vst" },
  });
  for (let tick = 0; tick < 5 && request.state === "pending"; tick++) await restarted.runOnce();
  assert.equal(request.state, "finished");
  assert.equal(value.data.positions[0].status, "closed");
  assert.equal(value.context.stopPresent, false);
  assert.equal(value.data.writes.filter(write => write.operation === "close_leg").length, 1);
  await restarted.runOnce();
  assert.equal(value.data.writes.filter(write => write.operation === "close_leg").length, 1);
});

test("legacy confirmed source withdrawals close only on reconciled entry proof and finish exact stop cleanup", async () => {
  for (const position of LEGACY_POSITIONS) {
    const value = fixture(position);
    const close = await value.worker.runOnce();

    assert.equal(close.kind, "acted", `${position.symbol}: ${JSON.stringify(close)}`);
    assert.equal(close.operation, "source_exit_close");
    assert.equal(value.data.writes.length, 1);
    assert.equal(value.data.writes[0].operation, "close_leg");
    assert.equal(value.data.sourceExitReservations.length, 1);
    const closeRequest = value.data.sourceExitReservations[0].request;
    const expectedOrderId = value.entryIntent.exchangeOrderId;
    const expectedType = position.nativeEntryOrderType ?? "MARKET";
    const intentCreatedAt = position.intentCreatedAt ?? NOW - 120_000;
    const entryAt = position.entryAt ?? NOW - 120_000;
    assert.equal(closeRequest.priorPosition.entryOrderId, expectedOrderId);
    assert.equal(closeRequest.priorPosition.entryOrderType, expectedType);
    assert.equal(String(closeRequest.priorPosition.verifiedFill.quantity), position.quantity);
    assert.equal(String(closeRequest.priorPosition.verifiedFill.price), position.price);
    assert.equal(value.entryIntent.request.intentCreatedAt, intentCreatedAt);
    assert.equal(value.context.nativeProofOrderReads, 1);
    assert.deepEqual(value.context.nativeProofOrderQueries, [
      { orderId: expectedOrderId },
    ], "the native parent is read only by its exact durable order ID");
    assert.equal(value.context.nativeProofClientOrderReads, 0,
      "client-ID lookups are not used to discover a missing parent");
    const fillRange = value.context.nativeProofFillRanges[0];
    assert.equal(fillRange.startTs, intentCreatedAt);
    assert.equal(fillRange.endTs, Math.min(NOW, entryAt + 30_000));
    assert.ok(fillRange.endTs - fillRange.startTs <= 10 * 60_000 + 30_000,
      "native fills are bounded from original intent to saved entryAt plus 30s");
    if (NOW - entryAt > 23 * 60 * 60_000) {
      assert.ok(NOW - fillRange.endTs > 23 * 60 * 60_000,
        "old parent proof ends near the original fill, not at now");
    }
    if (position.entryOrderType === undefined) {
      assert.equal(Object.hasOwn(value.snapshot, "entryOrderType"), false);
      assert.equal(Object.hasOwn(value.entryIntent.request, "entryOrderType"), false);
      assert.equal(value.context.history[0].type,
        position.nativeEntryOrderType ?? "MARKET");
      assert.equal(value.context.history[0].timeInForce, position.timeInForce);
    }
    assert.equal(closeRequest.quantity, position.residual,
      "fresh residual, not original fill quantity, is closed");
    assert.equal(closeRequest.previousQuantity, position.residual);
    assert.equal(Object.hasOwn(closeRequest, "persistedPosition"), false,
      "an absent legacy persistedPosition is omitted from the durable request");
    assert.equal(Object.hasOwn(closeRequest, "signalAt"), false,
      "an absent legacy signalAt is omitted from the durable request");
    assert.deepEqual(
      value.data.positions[0].snapshot.sourceExitEvidence,
      value.data.sourceExitRequests[0].evidence,
    );
    assert.equal(value.data.sourceExitRequests[0].state, "pending");

    const cleanup = await value.worker.runOnce();
    assert.equal(cleanup.kind, "acted", `${position.symbol}: ${JSON.stringify(cleanup)}`);
    assert.equal(cleanup.operation, "source_exit_stop_cleanup");
    assert.equal(value.data.writes.length, 2);
    assert.equal(value.data.writes[1].operation, "cancel_flat_split_stop");
    assert.equal(value.data.positions[0].status, "closed");
    assert.equal(value.data.sourceExitRequests[0].state, "finished");
  }
});

test("mismatched or unreconciled market-entry evidence never authorizes a source close", async () => {
  const cases = [
    ["wrong recorded client ID", (intent) => {
      intent.clientOrderId = "different-entry-client-id";
    }],
    ["wrong exchange position ID", (intent) => {
      intent.outcome.positionId = "different-position-id";
    }],
    ["wrong fill price", (intent) => {
      intent.outcome.fillPrice = "0.10466";
    }],
    ["wrong fill quantity", (intent) => {
      intent.outcome.fillQuantity = "93199";
    }],
    ["wrong sizing quantity", (intent) => {
      intent.request.sizing.quantity = "93199";
    }],
    ["wrong request symbol", (intent) => {
      intent.request.symbol = "GRTUSDT";
    }],
    ["wrong request environment", (intent) => {
      intent.request.environment = "real";
    }],
    ["wrong request account", (intent) => {
      intent.request.accountId = "different-account";
    }],
    ["wrong signal identity", (intent) => {
      intent.request.signal.sourceSignalId = "different-signal";
    }],
    ["wrong exchange order ID", (intent) => {
      intent.exchangeOrderId = "different-entry-order-id";
    }],
    ["ambiguous recorded fill", (intent) => {
      intent.outcome.status = "unknown";
    }],
    ["unreconciled execution", (intent) => {
      intent.state = "unknown";
    }],
  ];
  for (const [label, alter] of cases) {
    const position = LEGACY_POSITIONS[0];
    const setup = fixture(position);
    alter(setup.entryIntent);
    const result = await setup.worker.runOnce();

    assert.notEqual(result.kind, "acted", label);
    assert.equal(setup.data.writes.length, 0, label);
    assert.equal(setup.data.sourceExitReservations.length, 0, label);
    if (label === "unreconciled execution") {
      assert.equal(result.reason, "unresolved_vst_order_intents");
      assert.equal(setup.data.positions[0].snapshot.sourceExitBlockReason, undefined);
    } else {
      const expectedReason = label === "wrong exchange order ID"
        ? "source_exit_native_entry_proof_unavailable"
        : "source_exit_entry_identity_unavailable";
      assert.equal(setup.data.positions[0].snapshot.sourceExitBlockReason,
        expectedReason, label);
    }
  }
});

test("native exact-parent and fill refusals reserve no close intent and recover on retry", async () => {
  for (const [label, options] of [
    ["entry history refusal", { entryHistoryError: true }],
    ["entry fills unavailable", { entryFillsUnavailable: true }],
  ]) {
    const setup = fixture(LEGACY_POSITIONS[0], options);
    const refused = await setup.worker.runOnce();

    assert.notEqual(refused.kind, "acted", label);
    assert.ok(setup.context.nativeProofOrderReads > 0, label);
    assert.equal(setup.data.writes.length, 0, label);
    assert.equal(setup.data.sourceExitReservations.length, 0, label);
    assert.equal(setup.data.intents.some((intent) =>
      intent.request?.operation === "close_leg" &&
      intent.request?.sourceExit?.stage === "close"), false, label);

    setup.context.entryHistoryError = false;
    setup.context.entryFillsUnavailable = false;
    const recovered = await setup.worker.runOnce();

    assert.equal(recovered.kind, "acted", `${label}: ${JSON.stringify(recovered)}`);
    assert.equal(recovered.operation, "source_exit_close", label);
    assert.equal(setup.data.writes[0].operation, "close_leg", label);
    assert.equal(setup.data.sourceExitReservations.length, 1, label);
    assert.ok(setup.context.nativeProofFillReads > 0, label);
  }
});

test("native entry proof must match the ledger order, position, fill quantity, and price", async () => {
  const mismatches = [
    ["native order identity mismatch", (context) => {
      context.history[0].orderId = "different-native-entry-order";
    }],
    ["native returned client ID conflict", (context) => {
      context.history[0].clientOrderId = "different-native-client-id";
    }],
    ["native position identity mismatch", (context) => {
      context.history[0].positionID = "different-native-position";
    }],
    ["native fill quantity mismatch", (context) => {
      context.fills[0].qty = "93199";
    }],
    ["native fill price mismatch", (context) => {
      context.fills[0].price = "0.10466";
    }],
    ["native last fill timestamp mismatch", (context) => {
      context.fills[0].filledTm += 1;
    }],
  ];
  for (const [label, alter] of mismatches) {
    const setup = fixture(LEGACY_POSITIONS[0]);
    alter(setup.context);
    const result = await setup.worker.runOnce();

    assert.notEqual(result.kind, "acted", label);
    assert.ok(setup.context.nativeProofOrderReads > 0, label);
    assert.equal(setup.data.writes.length, 0, label);
    assert.equal(setup.data.sourceExitReservations.length, 0, label);
    assert.equal(setup.data.intents.some((intent) =>
      intent.request?.operation === "close_leg" &&
      intent.request?.sourceExit?.stage === "close"), false, label);
  }
});

test("a valid persisted broker snapshot is preserved in the durable source-close request", async () => {
  const position = LEGACY_POSITIONS[5];
  const sourceSignalId = `legacy-${position.symbol.toLowerCase()}`;
  const entryOrderId = `entry-order-${position.symbol.toLowerCase()}`;
  const positionId = `position-${position.symbol.toLowerCase()}`;
  const stopOrderId = `core-stop-${position.symbol.toLowerCase()}`;
  const persistedPosition = {
    positionId,
    protectiveStops: {
      core: {
        verified: true,
        orderId: stopOrderId,
        positionId,
        quantity: position.quantity,
        stopPrice: "0.07",
      },
    },
  };
  const setup = fixture(position, { snapshotOverrides: { persistedPosition } });

  const result = await setup.worker.runOnce();

  assert.equal(result.kind, "acted");
  const request = setup.data.sourceExitReservations[0].request;
  assert.equal(request.priorPosition.entryOrderId, entryOrderId);
  assert.deepEqual(request.persistedPosition, persistedPosition);
  assertPersistable(request);
});

test("a typed source-row failure is safely logged, blocked, and cannot starve another canonical exit", async () => {
  const sourceErrors = [];
  const first = LEGACY_POSITIONS[0];
  const second = LEGACY_POSITIONS[5];
  const failed = fixture(first, {
    failReserveSignalId: `legacy-${first.symbol.toLowerCase()}`,
    onTiming: async (timing) => sourceErrors.push(timing),
  });
  const next = fixture(second);
  failed.attach(next);

  const worker = createVstWorker({
    store: failed.store,
    broker: failed.broker,
    clock: () => NOW,
    sourceExitsEnabled: true,
    sizingLimits: { environment: "vst" },
    onTiming: async (timing) => sourceErrors.push(timing),
  });
  const result = await worker.runOnce();

  assert.equal(result.kind, "acted", JSON.stringify(result));
  assert.equal(result.sourceSignalId, `legacy-${second.symbol.toLowerCase()}`);
  assert.equal(failed.data.writes.length, 1);
  assert.equal(failed.data.writes[0].sourceSignalId,
    `legacy-${second.symbol.toLowerCase()}`);
  assert.equal(failed.data.sourceExitReservations.length, 1);
  assert.equal(sourceErrors.length, 1);
  assert.equal(sourceErrors[0].diagnosticReason, "source_exit_row_preflight_error");
  assert.match(sourceErrors[0].diagnosticMessage, /Details withheld/);
  assert.doesNotMatch(sourceErrors[0].diagnosticMessage, /private-auth-token/);
  assert.ok(sourceErrors[0].stages.sourceExits >= 0);
});