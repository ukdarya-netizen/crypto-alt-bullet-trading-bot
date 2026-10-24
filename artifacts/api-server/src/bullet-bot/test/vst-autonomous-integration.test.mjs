import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after } from "node:test";
import { createVstBroker } from "../vst-broker.mjs";
import { createVstPolicy } from "../vst-policy.mjs";
import { createVstWorker } from "../vst-worker.mjs";
import { formatVstBlockedAlert } from "../vst-telegram.mjs";
import { getVstResultDiagnosticRef, recordVstDiagnostic } from "../vst-diagnostics.mjs";

const ORIGINAL_PAUSE = process.env.BULLET_VST_PAUSED;
process.env.BULLET_VST_PAUSED = "0";
after(() => {
  if (ORIGINAL_PAUSE === undefined) delete process.env.BULLET_VST_PAUSED;
  else process.env.BULLET_VST_PAUSED = ORIGINAL_PAUSE;
});

const NOW = Date.parse("2026-10-02T00:00:00.000Z");
const ACCOUNT = "integration-vst-account";
const SOURCE_ID = "cab-signal-integration-impulse";
const SYMBOL = "ETHUSDT";
const SYMBOL_NAME = "ETH-USDT";
const FEATURES = [
  "vst_only",
  "complete_order_lookup",
  "guarded_long10_leverage_preparation",
  "atomic_protected_market_entry",
  "verified_core_stop_state",
  "verified_exact_full_position_close",
  "verified_source_flat_stop_cleanup",
  "verified_position_state",
  "impulse_runner_stop_and_partial_close",
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
};

const signal = {
  sourceSignalId: SOURCE_ID,
  confirmationStatus: "confirmed",
  patternStatus: "approved",
  side: "buy",
  orderType: "market",
  patternId: "impulse_buy",
  symbol: SYMBOL,
  signalAt: new Date(NOW - 5_000).toISOString(),
  referencePrice: "100",
  stopLoss: "95",
  payload: { rulesVersion: "bullet-long-exits-v2", exitRules: EXIT_RULES },
};

function durableStore(initialPosition) {
  const data = {
    pending: null,
    status: "open",
    reason: null,
    intents: [],
    positions: initialPosition ? [{
      sourceSignalId: SOURCE_ID,
      symbol: SYMBOL,
      status: initialPosition.status,
      snapshot: initialPosition,
    }] : [],
    events: [],
    sourceExitRequests: [],
    failSourceExitFinishCount: 0,
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
      return data.pending && ["pending", "planning"].includes(data.pending.status)
        ? data.pending : null;
    },
    async getPosition(sourceSignalId) {
      return data.positions.find((row) =>
        row.sourceSignalId === sourceSignalId) ?? null;
    },
    async setSignalStatus(_id, status, reason = null) {
      data.status = status;
      data.reason = reason;
      if (data.pending) data.pending.status = status;
      for (const row of data.positions) row.status = status;
    },
    async recordEvent(...event) { data.events.push(event); },
    async listUnresolvedIntents() {
      return data.intents.filter((intent) =>
        ["prepared", "submitted", "unknown"].includes(intent.state));
    },
    async getIntent(sourceSignalId, phase) {
      const row = data.intents.find((intent) =>
        intent.sourceSignalId === sourceSignalId && intent.phase === phase);
      return row ? {
        ...row,
        outcome: row.outcome ?? row.detail?.outcome ?? null,
      } : null;
    },
    async reserveIntent(intent) {
      const existing = data.intents.find((row) =>
        row.sourceSignalId === intent.sourceSignalId && row.phase === intent.phase);
      if (existing) {
        // Mirror the real store: an intent already on file for this
        // (signal, phase) must match byte-for-byte, or this is a conflicting
        // rebuild that must fail loudly rather than silently reuse stale facts.
        if (existing.clientOrderId !== intent.clientOrderId ||
            JSON.stringify(existing.request) !== JSON.stringify(intent.request)) {
          throw new Error("VST intent phase already exists with conflicting order facts");
        }
        return { kind: "existing", intent: existing };
      }
      const row = { ...intent, state: "prepared" };
      data.intents.push(row);
      return { kind: "new", intent: row };
    },
    async markIntent(clientOrderId, state, detail = {}) {
      const row = data.intents.find((intent) => intent.clientOrderId === clientOrderId);
      assert.ok(row, `intent ${clientOrderId} was durably reserved`);
      Object.assign(row, { state, detail, outcome: detail.outcome ?? null });
    },
    async commitVerifiedIntent(commit) {
      const intent = data.intents.find((row) =>
        row.clientOrderId === commit.clientOrderId);
      assert.ok(intent, "commit follows a durable intent");
      if (intent.state === "reconciled") {
        assert.deepEqual(intent.detail?.outcome, commit.outcome);
        return { replayed: true };
      }
      const position = {
        sourceSignalId: commit.sourceSignalId,
        symbol: commit.position.symbol,
        status: commit.position.status,
        snapshot: commit.position,
      };
      const existingIndex = data.positions.findIndex((row) =>
        row.sourceSignalId === commit.sourceSignalId);
      if (existingIndex === -1) data.positions.push(position);
      else data.positions[existingIndex] = position;
      Object.assign(intent, {
        state: "reconciled",
        exchangeOrderId: commit.exchangeOrderId,
        detail: { outcome: commit.outcome },
        outcome: commit.outcome,
      });
      data.status = commit.signalStatus;
      if (data.pending?.sourceSignalId === commit.sourceSignalId) {
        data.pending.status = commit.signalStatus;
      }
      if (commit.followUpIntent) {
        const existingFollowUp = data.intents.find((row) =>
          row.clientOrderId === commit.followUpIntent.clientOrderId);
        if (!existingFollowUp) {
          data.intents.push({ ...commit.followUpIntent, state: "prepared" });
        } else {
          assert.deepEqual(existingFollowUp, { ...commit.followUpIntent, state: "prepared" });
        }
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
        ["open", "closing", "unknown"].includes(row.status));
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
    async queueSourceExitRequests({ positions = [], asOf, observedAt }) {
      for (const position of positions) {
        if (!position?.sourceExitRequest) continue;
        const request = position.sourceExitRequest;
        if (data.sourceExitRequests.some((row) =>
          row.requestId === request.requestId)) continue;
        data.sourceExitRequests.push({
          ...request,
          asOf,
          observedAt,
          state: "pending",
        });
      }
    },
    async listPendingSourceExitRequests() {
      return data.sourceExitRequests.filter((row) => row.state === "pending")
        .map(({ state: _state, ...row }) => structuredClone(row));
    },
    async finishSourceExitRequest(requestId, result) {
      if (data.failSourceExitFinishCount > 0) {
        data.failSourceExitFinishCount -= 1;
        throw new Error("simulated_source_exit_queue_acknowledgement_failure");
      }
      const row = data.sourceExitRequests.find((item) =>
        item.requestId === requestId && item.state === "pending");
      if (row) Object.assign(row, { state: "finished", result });
    },
    async hasPendingSourceExitRequest(sourceSignalId) {
      return data.sourceExitRequests.some((row) =>
        row.state === "pending" && row.sourceSignalId === sourceSignalId);
    },
  };
}

function openStop(orderId, quantity, price, parentId = "entry-order-1") {
  return {
    symbol: SYMBOL_NAME,
    orderId,
    mainOrderId: parentId,
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    workingType: "MARK_PRICE",
    positionId: "position-1",
    origQty: String(quantity),
    stopPrice: String(price),
    time: NOW - 1_000,
  };
}

function splitSnapshot() {
  const policy = createVstPolicy({
    signal,
    fill: { price: 100, quantity: 0.1, at: new Date(NOW - 1_000).toISOString() },
  });
  return {
    sourceSignalId: SOURCE_ID,
    symbol: SYMBOL,
    patternId: "impulse_buy",
    signalAt: signal.signalAt,
    status: "closing",
    executionStatus: "impulse_split_core_pending",
    environment: "vst",
    accountId: ACCOUNT,
    marginMode: "ISOLATED",
    leverage: 10,
    entryClientOrderId: "vst-entry-client",
    entryOrderType: "MARKET",
    entryOrderId: "entry-order-1",
    signalSnapshot: signal,
    exchangePositionId: "position-1",
    verifiedFill: {
      price: 100,
      quantity: 0.1,
      at: new Date(NOW - 1_000).toISOString(),
    },
    sizing: { quantity: "0.1" },
    originalStopOrderId: "attached-entry-stop",
    originalStopPositionId: "position-1",
    originalStopQuantity: 0.1,
    signalStopPrice: "95",
    actualEntryBreakEvenPrice: "100",
    baselineOpenOrderIds: ["attached-entry-stop"],
    split: {
      stage: "core_pending",
      totalQuantity: "0.1",
      coreQuantity: "0.08",
      runnerQuantity: "0.02",
      quantityPrecision: 3,
      pricePrecision: 2,
      minQuantity: "0.001",
      signalStopPrice: "95",
      breakEvenPrice: "100",
      actualEntryBreakEvenPrice: "100",
      positionId: "position-1",
      entryOrderId: "entry-order-1",
      originalStopOrderId: "attached-entry-stop",
      baselineOpenOrderIds: ["attached-entry-stop"],
      createdAt: NOW - 500,
      coreStop: null,
      runnerStop: null,
    },
    policy: {
      ...policy,
      coreQty: 0.08,
      runnerQty: 0.02,
      runnerStopPrice: null,
    },
    persistedPosition: {
      verified: true,
      environment: "vst",
      accountId: ACCOUNT,
      symbol: SYMBOL,
      positionId: "position-1",
      quantity: "0.1",
      protectiveStops: {},
      originalStop: {
        verified: true,
        positionId: "position-1",
        orderId: "attached-entry-stop",
        quantity: "0.1",
        stopPrice: "95",
      },
    },
  };
}

function mockExchange({
  ambiguousCorePost = false,
  coreHistoryPositionIdZero = false,
  ambiguousRunnerCleanup = false,
  ambiguousPartialClose = false,
  runnerStopFillsDuringPlacement = false,
  ambiguousRunnerStopFill = false,
  sourceExitClose = false,
  sourceExitPostUnknown = false,
  sourceExitPartialFill = false,
} = {}) {
  const position = {
    symbol: SYMBOL_NAME,
    positionSide: "LONG",
    positionAmt: "0.1",
    avgPrice: "100",
    positionId: "position-1",
  };
  const orders = [openStop("attached-entry-stop", "0.1", "95")];
  const history = orders.map((row) => ({ ...row }));
  const fills = [];
  const calls = [];
  const queryOrderResponses = new Map();
  let markPrice = "105";
  let exchangeClock = NOW;
  let firstCorePost = true;
  let firstRunnerCleanup = true;
  let firstPartialClose = true;
  let firstSourceExitPost = true;
  const saveHistory = (row) => {
    const index = history.findIndex((item) => item.orderId === row.orderId);
    if (index < 0) history.push({ ...row });
    else history[index] = { ...row };
  };
  const saveFill = (fill) => { fills.push({ ...fill }); };
  const setOrderSet = (nextOrders) => {
    orders.splice(0, orders.length, ...nextOrders.map((row) => ({ ...row })));
  };
  const queueQueryOrder = (id, ...responses) => queryOrderResponses.set(id, responses);
  const api = {
    async getVstMarkPrice(symbolName) {
      calls.push(["mark", symbolName]);
      return { symbol: SYMBOL_NAME, markPrice, timestamp: exchangeClock };
    },
    async getBalance() {
      return [{ asset: "VST", balance: "1000", availableMargin: "1000" }];
    },
    async getPositions(symbolName) {
      calls.push(["positions", symbolName]);
      return position.positionAmt === "0" ? [] : [{ ...position }];
    },
    async getOpenOrders(symbolName) {
      calls.push(["openOrders", symbolName]);
      return orders.map((row) => ({ ...row }));
    },
    async getPositionMode() { return "HEDGE"; },
    async getMarginType() { return "ISOLATED"; },
    async getLeverage() {
      return { longLeverage: 10, shortLeverage: 10, maxPositionLongVal: 1_000_000 };
    },
    async contract() {
      return {
        symbol: SYMBOL_NAME,
        quantityPrecision: 3,
        pricePrecision: 2,
        minQuantity: "0.001",
        minNotional: "5",
        maxLeverage: 10,
      };
    },
    async getFeeRate() { return { maker: 0.0002, taker: 0.0005 }; },
    async getFunding() { return { rate: 0, nextFundingTime: NOW + 60_000 }; },
    async getRiskTiers() {
      return [{ maxNotional: 100_000, maintenanceMarginRate: 0.01 }];
    },
    async setVstLongLeverage10() {},
    async queryOrderHistory(_symbol, range) {
      calls.push(["history", range]);
      assert.ok(Number.isSafeInteger(range.startTs));
      assert.ok(Number.isSafeInteger(range.endTs));
      assert.ok(range.startTs >= NOW - 24 * 60 * 60_000 - 2_000);
      return history.map((row) => {
        const copy = { ...row };
        if (coreHistoryPositionIdZero && copy.orderId === "split-core-stop") {
          copy.positionId = 0;
          copy.executedQty = "0.0";
          copy.closePosition = "";
        }
        return copy;
      });
    },
    async queryOrder(_symbol, identifier) {
      calls.push(["queryOrder", identifier]);
      if (identifier.orderId && queryOrderResponses.has(identifier.orderId)) {
        const responses = queryOrderResponses.get(identifier.orderId);
        if (responses.length > 1) return { ...responses.shift() };
        return responses[0] ? { ...responses[0] } : null;
      }
      return history.find((row) =>
        identifier.orderId ? row.orderId === identifier.orderId
          : row.clientOrderId === identifier.clientOrderId) ?? null;
    },
    async queryFills(_symbol, range) {
      calls.push(["fills", range]);
      return fills.filter((row) =>
        (!range.orderId || row.orderId === range.orderId) &&
        (!range.currency || row.currency === range.currency));
    },
    async placeVstAutomatedLong() {
      throw new Error("entry path is deliberately outside this focused split fixture");
    },
    async upgradeVstLongStop() {
      throw new Error("stop upgrade is outside this focused split fixture");
    },
    async closeLong() {
      if (!sourceExitClose) {
        throw new Error("close path is outside this focused split fixture");
      }
      const [requestedSymbol, quantity, clientOrderId, positionId] = arguments;
      calls.push(["sourceExitClose", {
        symbol: requestedSymbol, quantity, clientOrderId, positionId,
      }]);
      if (sourceExitPostUnknown && firstSourceExitPost) {
        firstSourceExitPost = false;
        throw new Error("simulated_lost_source_exit_acknowledgement");
      }
      assert.equal(requestedSymbol, SYMBOL);
      assert.equal(positionId, position.positionId);
      const filledQuantity = sourceExitPartialFill
        ? String(Number(quantity) / 2) : String(quantity);
      const closeOrderId = `source-exit-order-${history.length}`;
      const closeOrder = {
        symbol: SYMBOL_NAME,
        orderId: closeOrderId,
        clientOrderId,
        status: "FILLED",
        side: "SELL",
        positionSide: "LONG",
        type: "MARKET",
        origQty: String(quantity),
        executedQty: filledQuantity,
        time: NOW,
      };
      saveHistory(closeOrder);
      saveFill({
        symbol: SYMBOL_NAME,
        orderId: closeOrderId,
        tradeId: `${closeOrderId}-fill`,
        side: "SELL",
        positionSide: "LONG",
        volume: filledQuantity,
        price: "105",
        commission: "-0.012",
        currency: "VST",
        filledTm: NOW,
      });
      position.positionAmt = sourceExitPartialFill
        ? String(Number(quantity) - Number(filledQuantity)) : "0";
    },
    async cancelVstAutomatedKnownStopWhenFlat(request) {
      calls.push(["cancelKnownFlatStop", request]);
      const index = orders.findIndex((row) =>
        row.orderId === request.stopToCancel.orderId);
      assert.notEqual(index, -1, "only the exact ledger-owned stop is canceled");
      const [old] = orders.splice(index, 1);
      saveHistory({ ...old, status: "CANCELED", executedQty: "0" });
      return { verified: true, status: "CANCELED" };
    },
    async placeVstAutomatedVirtualSplitLongStop(request) {
      calls.push(["placeSplitStop", request]);
      const id = request.tranche === "core" ? "split-core-stop" : "split-runner-stop";
      const row = {
        ...openStop(id, request.quantity, request.stopPrice),
        ...(coreHistoryPositionIdZero ? { executedQty: "0.0" } : {}),
        time: NOW,
      };
      orders.push(row);
      history.push({ ...row });
      if (request.tranche === "core" && ambiguousCorePost && firstCorePost) {
        firstCorePost = false;
        throw new Error("simulated_lost_core_stop_acknowledgement");
      }
      if (request.tranche === "runner" && runnerStopFillsDuringPlacement) {
        const runnerParentId = row.orderId;
        const index = orders.findIndex((item) => item.orderId === runnerParentId);
        if (index >= 0) orders.splice(index, 1);
        position.positionAmt = "0.08";
        setOrderSet([
          exactStop(null, "attached-entry-stop", "0.08", "95"),
          exactStop(null, "split-core-stop", "0.08", "95"),
        ]);
        const childOrder = {
          symbol: SYMBOL_NAME,
          orderId: "runner-child-race-fill",
          mainOrderId: runnerParentId,
          type: "STOP_MARKET",
          status: "FILLED",
          side: "SELL",
          positionSide: "LONG",
          workingType: "MARK_PRICE",
          triggerOrderId: runnerParentId,
          positionId: "position-1",
          positionID: "position-1",
          origQty: "0.02",
          executedQty: "0.02",
          stopPrice: "100",
          time: NOW,
        };
        // BingX may answer a parent-ID lookup with its generated child and a
        // zero position-ID sentinel. A lookup of that exact child ID returns
        // the lossless child row with the real position identity.
        const parentLookupAlias = {
          ...childOrder,
          positionId: 0,
          positionID: 0,
        };
        history.splice(0, history.length,
          ...history.filter((item) => item.orderId !== runnerParentId));
        saveHistory(childOrder);
        queueQueryOrder(runnerParentId, parentLookupAlias);
        queueQueryOrder(childOrder.orderId, childOrder);
        saveFill({
          symbol: SYMBOL_NAME,
          orderId: childOrder.orderId,
          triggerOrderId: ambiguousRunnerStopFill
            ? "different-parent-id" : runnerParentId,
          side: "SELL",
          positionSide: "LONG",
          volume: "0.02",
          price: "100",
          commission: "-0.012",
          currency: "VST",
          filledTm: NOW,
        });
        throw new Error("simulated_runner_stop_triggered_during_exact_id_query");
      }
      return {
        symbol: SYMBOL_NAME,
        tranche: request.tranche,
        orderId: id,
        verified: true,
      };
    },
    async cancelVstAutomatedAttachedLongStopAfterSplit(request) {
      calls.push(["cancelOriginal", request]);
      const index = orders.findIndex((row) =>
        row.orderId === request.originalStopOrderId);
      assert.notEqual(index, -1, "only the known original entry stop is canceled");
      const [old] = orders.splice(index, 1);
      const canceled = { ...old, status: "CANCELED", executedQty: "0" };
      const historyIndex = history.findIndex((row) => row.orderId === old.orderId);
      history[historyIndex] = canceled;
      return { status: "CANCELED", verified: true };
    },
    async cancelVstAutomatedOriginalAfterTriggeredRunner(request) {
      calls.push(["cancelOriginalAfterRunnerFill", request]);
      const index = orders.findIndex((row) =>
        row.orderId === request.originalStopOrderId);
      assert.notEqual(index, -1, "runner cleanup removes only the stale original stop");
      const [original] = orders.splice(index, 1);
      saveHistory({ ...original, status: "CANCELED", executedQty: "0" });
      if (ambiguousRunnerCleanup && firstRunnerCleanup) {
        firstRunnerCleanup = false;
        throw new Error("simulated_lost_runner_cleanup_acknowledgement");
      }
      return {
        symbol: SYMBOL_NAME,
        status: "CANCELED",
        canceledOriginalStopOrderId: request.originalStopOrderId,
        coreStopOrderId: request.coreStopOrderId,
        positionId: request.positionId,
        remainingQuantity: request.remainingQuantity,
        runnerChildOrderId: request.runnerChildOrderId,
        cancellationIntentId: request.cancellationIntentId,
        verified: true,
      };
    },
    async closeVstAutomatedSplitTranche(request) {
      calls.push(["closeSplitTranche", request]);
      const remaining = request.tranche === "runner" ? "0.08" : "0.02";
      const closeOrderId = "split-expiry-close-order";
      const closeOrder = {
        symbol: SYMBOL_NAME,
        orderId: closeOrderId,
        clientOrderId: request.clientOrderId,
        status: "FILLED",
        side: "SELL",
        positionSide: "LONG",
        type: "MARKET",
        origQty: request.quantity,
        executedQty: request.quantity,
      };
      saveHistory(closeOrder);
      const fill = {
        symbol: SYMBOL_NAME,
        orderId: closeOrderId,
        tradeId: "split-expiry-close-fill-1",
        side: "SELL",
        positionSide: "LONG",
        volume: request.quantity,
        price: "105",
        filledTm: NOW,
        commission: "-0.01",
        currency: "VST",
      };
      saveFill(fill);
      position.positionAmt = remaining;
      const retained = orders.find((row) =>
        row.orderId === request.retainedStop.orderId);
      assert.ok(retained, "retained tranche stop remains live during partial close");
      retained.origQty = remaining;
      if (ambiguousPartialClose && firstPartialClose) {
        firstPartialClose = false;
        throw new Error("simulated_lost_partial_close_acknowledgement");
      }
      return {
        orderId: closeOrderId,
        status: "FILLED",
        executedQuantity: request.quantity,
        remainingQuantity: remaining,
        retainedStop: { ...retained },
        verified: true,
      };
    },
    async cancelVstAutomatedSplitStopAfterPartial(request) {
      calls.push(["cancelPartialStop", request]);
      const index = orders.findIndex((row) =>
        row.orderId === request.stopToCancel.orderId);
      assert.notEqual(index, -1, "stale tranche stop is explicitly present for cleanup");
      const [stale] = orders.splice(index, 1);
      saveHistory({ ...stale, status: "CANCELED", executedQty: "0" });
      return { status: "CANCELED", verified: true };
    },
    async closeVstAutomatedSoleSplitLeg(request) {
      calls.push(["closeSoleLeg", request]);
      const closeOrderId = "sole-runner-close-order";
      const closeOrder = {
        symbol: SYMBOL_NAME,
        orderId: closeOrderId,
        clientOrderId: request.clientOrderId,
        status: "FILLED",
        side: "SELL",
        positionSide: "LONG",
        type: "MARKET",
        origQty: request.quantity,
        executedQty: request.quantity,
      };
      saveHistory(closeOrder);
      const fill = {
        symbol: SYMBOL_NAME,
        orderId: closeOrderId,
        tradeId: "sole-runner-close-fill-1",
        side: "SELL",
        positionSide: "LONG",
        volume: request.quantity,
        price: "105",
        filledTm: NOW,
        commission: "-0.01",
        currency: "VST",
      };
      saveFill(fill);
      position.positionAmt = "0";
      const stopIndex = orders.findIndex((row) => row.orderId === request.stop.orderId);
      assert.notEqual(stopIndex, -1);
      const [stop] = orders.splice(stopIndex, 1);
      saveHistory({ ...stop, status: "CANCELED", executedQty: "0" });
      return {
        symbol: SYMBOL_NAME,
        positionId: request.positionId,
        closedQuantity: request.quantity,
        closeOrderId,
        clientOrderId: request.clientOrderId,
        closeIntentId: request.closeIntentId,
        fills: [fill],
        fees: [{ amount: "-0.01", asset: "VST" }],
        canceledStopOrderId: request.stop.orderId,
        status: "FILLED",
        flat: true,
        noOpenStops: true,
        verified: true,
      };
    },
  };
  return {
    api,
    calls,
    orders,
    history,
    fills,
    position,
    queueQueryOrder,
    setOrderSet,
    setMarkPrice(value) { markPrice = String(value); },
    setClock(value) { exchangeClock = Number(value); },
    setPositionQuantity(value) { position.positionAmt = String(value); },
    saveHistory,
    saveFill,
  };
}

function freshEntryExchange({
  symbol = "BTCUSDT",
  initialLeverage = 5,
  initialMarginMode = "ISOLATED",
  expectedStopLoss = "95",
  ambiguousMarginSwitch = false,
  ambiguousCoreStop = false,
  ambiguousPreRunnerClose = false,
  ambiguousTopUp = null,
  minIncreaseMargin = "0.01",
  liquidationPriceAfterEntry = "90",
  topUpMovesLiquidation = true,
  fillPrice = "100",
} = {}) {
  const exchangeSymbol = symbol.endsWith("USDT")
    ? `${symbol.slice(0, -4)}-USDT` : symbol;
  const position = {
    symbol: exchangeSymbol,
    positionSide: "LONG",
    positionAmt: "0",
    avgPrice: "0",
    isolatedMargin: "0",
    liquidationPrice: "90",
    minIncreaseMargin,
    positionId: "fresh-position-1",
  };
  const orders = [];
  const foreignOrders = [];
  const history = [];
  const marginAdjustments = [];
  const fills = [];
  const calls = [];
  const writes = [];
  const markReads = [];
  const preRunnerClosePosts = [];
  let firstPreRunnerClose = true;
  let firstMarginSwitch = true;
  let firstCoreStop = true;
  const longLeverageBySymbol = new Map([[exchangeSymbol, initialLeverage]]);
  const marginModeBySymbol = new Map([[exchangeSymbol, initialMarginMode]]);
  let markPrice = "100";
  const nameOf = (requestedSymbol) => requestedSymbol.endsWith("USDT")
    ? `${requestedSymbol.slice(0, -4)}-USDT` : requestedSymbol;
  const saveHistory = (row) => {
    const index = history.findIndex((item) => item.orderId === row.orderId);
    if (index === -1) history.push({ ...row });
    else history[index] = { ...row };
  };
  const api = {
    async getVstMarkPrice(requestedSymbol) {
      calls.push(["mark", requestedSymbol]);
      const quote = {
        symbol: nameOf(requestedSymbol),
        markPrice,
        timestamp: NOW,
      };
      markReads.push({ ...quote });
      return quote;
    },
    async getBalance() {
      calls.push(["balance"]);
      return [{ asset: "VST", balance: "1000", availableMargin: "1000" }];
    },
    async getPositions(requestedSymbol) {
      calls.push(["positions", requestedSymbol]);
      if (position.positionAmt === "0" ||
          requestedSymbol && nameOf(requestedSymbol) !== position.symbol) return [];
      return [{ ...position }];
    },
    async getPositionMarginHistory(requestedSymbol, positionId, interval) {
      const records = marginAdjustments.filter((row) =>
        row.symbol === nameOf(requestedSymbol) &&
        row.positionId === positionId &&
        row.time >= interval.startTime && row.time <= interval.endTime);
      return { total: records.length, records };
    },
    async getOpenOrders(requestedSymbol) {
      calls.push(["openOrders", requestedSymbol]);
      const accountOrders = [...orders, ...foreignOrders];
      return requestedSymbol
        ? accountOrders.filter((row) => row.symbol === nameOf(requestedSymbol))
          .map((row) => ({ ...row }))
        : accountOrders.map((row) => ({ ...row }));
    },
    async getPositionMode() { calls.push(["positionMode"]); return "HEDGE"; },
    async getMarginType(requestedSymbol) {
      calls.push(["marginType", requestedSymbol]);
      return marginModeBySymbol.get(nameOf(requestedSymbol)) ?? "ISOLATED";
    },
    async getLeverage(requestedSymbol) {
      calls.push(["leverage", requestedSymbol]);
      return {
        longLeverage: longLeverageBySymbol.get(nameOf(requestedSymbol)) ??
          initialLeverage,
        shortLeverage: 5,
        maxPositionLongVal: 1_000_000,
      };
    },
    async contract(requestedSymbol) {
      calls.push(["contract", requestedSymbol]);
      return {
        symbol: nameOf(requestedSymbol),
        quantityPrecision: 3,
        pricePrecision: 2,
        minQuantity: "0.001",
        minNotional: "5",
        maxLeverage: 10,
      };
    },
    async getFeeRate(requestedSymbol) {
      calls.push(["fees", requestedSymbol]);
      return { maker: 0.0002, taker: 0.0005 };
    },
    async getFunding() {
      return { rate: 0, nextFundingTime: NOW + 60_000 };
    },
    async getRiskTiers(requestedSymbol) {
      calls.push(["riskTiers", requestedSymbol]);
      return [{ maxNotional: 100_000, maintenanceMarginRate: 0.01 }];
    },
    async setVstLongLeverage10(requestedSymbol) {
      calls.push(["setLeverage10", requestedSymbol]);
      writes.push(["setLeverage10", requestedSymbol]);
      longLeverageBySymbol.set(nameOf(requestedSymbol), 10);
    },
    async setVstIsolatedMarginForFlatSymbol(requestedSymbol) {
      calls.push(["setMarginIsolated", requestedSymbol]);
      writes.push(["setMarginIsolated", requestedSymbol]);
      assert.equal(position.positionAmt, "0");
      assert.equal([...orders, ...foreignOrders].length, 0);
      assert.equal(marginModeBySymbol.get(nameOf(requestedSymbol)) ?? "ISOLATED",
        "CROSSED");
      marginModeBySymbol.set(nameOf(requestedSymbol), "ISOLATED");
      if (ambiguousMarginSwitch && firstMarginSwitch) {
        firstMarginSwitch = false;
        throw new Error("simulated_lost_isolated_margin_acknowledgement");
      }
    },
    async queryOrderHistory(_requestedSymbol, range) {
      calls.push(["history", range]);
      assert.ok(Number.isSafeInteger(range.startTs));
      assert.ok(Number.isSafeInteger(range.endTs));
      assert.ok(range.startTs >= NOW - 24 * 60 * 60_000 - 2_000);
      const rows = ambiguousPreRunnerClose && position.positionAmt === "0"
        ? [...history].sort((a, b) =>
          Number(b.time ?? 0) - Number(a.time ?? 0) ||
          history.indexOf(b) - history.indexOf(a))
        : history;
      return rows.map((row) => ({ ...row }));
    },
    async queryOrder(_requestedSymbol, identifier) {
      calls.push(["queryOrder", identifier]);
      return history.find((row) =>
        identifier.orderId ? row.orderId === identifier.orderId
          : row.clientOrderId === identifier.clientOrderId) ?? null;
    },
    async queryFills(_requestedSymbol, range) {
      calls.push(["fills", range]);
      return fills
        .filter((row) =>
          (!range.orderId || row.orderId === range.orderId) &&
          (!range.currency || row.currency === range.currency))
        .sort((a, b) =>
          Number(b.filledTm ?? b.time ?? 0) - Number(a.filledTm ?? a.time ?? 0) ||
          fills.indexOf(b) - fills.indexOf(a));
    },
    async placeVstAutomatedLong(request) {
      calls.push(["placeEntry", request]);
      writes.push(["placeEntry", request]);
      assert.equal(request.policy, "vst-automated-long-1pct");
      assert.equal(request.quantity.trim(), request.quantity);
      assert.equal(request.stopLoss, expectedStopLoss);
      const entryOrderId = "fresh-entry-order-1";
      const entry = {
        symbol: exchangeSymbol,
        orderId: entryOrderId,
        clientOrderId: request.clientOrderId,
        status: "FILLED",
        side: "BUY",
        positionSide: "LONG",
        type: "MARKET",
        origQty: request.quantity,
        executedQty: request.quantity,
        avgPrice: fillPrice,
        time: NOW,
      };
      saveHistory(entry);
      const fill = {
        symbol: exchangeSymbol,
        orderId: entryOrderId,
        tradeId: "fresh-entry-fill-90071992547409931234",
        side: "BUY",
        positionSide: "LONG",
        volume: request.quantity,
        price: fillPrice,
        commission: "-0.01",
        currency: "USDT",
        filledTm: NOW,
      };
      fills.push(fill);
      position.positionAmt = request.quantity;
      position.avgPrice = fillPrice;
      position.isolatedMargin = "10";
      position.liquidationPrice = liquidationPriceAfterEntry;
      const attachedStop = {
        symbol: exchangeSymbol,
        orderId: "fresh-attached-signal-stop",
        mainOrderId: entryOrderId,
        type: "STOP_MARKET",
        status: "NEW",
        side: "SELL",
        positionSide: "LONG",
        workingType: "MARK_PRICE",
        positionId: position.positionId,
        origQty: request.quantity,
        stopPrice: request.stopLoss,
        time: NOW,
      };
      orders.push(attachedStop);
      saveHistory(attachedStop);
    },
    async addVstIsolatedLongMargin(request) {
      calls.push(["addMargin", request]);
      writes.push(["addMargin", request]);
      assert.equal(request.positionId, position.positionId);
      assert.equal(request.entryOrderId, "fresh-entry-order-1");
      assert.equal(request.stopLoss, expectedStopLoss);
      assert.equal(position.positionAmt, request.quantity);
      if (ambiguousTopUp === "before") {
        throw new Error("simulated_margin_top_up_ack_lost_before_write");
      }
      marginAdjustments.push({
        symbol: exchangeSymbol,
        positionId: position.positionId,
        changeReason: "ManualMarginAddition",
        marginChange: request.amount,
        marginAfterChange: (
          Number(position.isolatedMargin) + Number(request.amount)
        ).toFixed(2),
        time: NOW,
      });
      if (topUpMovesLiquidation) {
        position.liquidationPrice = String(
          Number(position.liquidationPrice) -
            Number(request.amount) / Number(position.positionAmt),
        );
      }
      if (ambiguousTopUp === "after") {
        throw new Error("simulated_margin_top_up_ack_lost_after_write");
      }
    },
    async readMarginTopUpBaseline(request) {
      calls.push(["marginBaseline", request]);
      assert.equal(request.environment, "vst");
      assert.equal(request.positionId, position.positionId);
      assert.equal(request.entryOrderId, "fresh-entry-order-1");
      const stop = orders.find((row) => row.orderId === "fresh-attached-signal-stop");
      return {
        verified: true,
        environment: "vst",
        accountId: ACCOUNT,
        symbol: exchangeSymbol,
        positionId: position.positionId,
        entryOrderId: "fresh-entry-order-1",
        quantity: position.positionAmt,
        isolatedMarginBefore: position.isolatedMargin,
        protectiveStop: {
          orderId: stop.orderId,
          positionId: stop.positionId,
          quantity: stop.origQty,
          stopPrice: stop.stopPrice,
          status: stop.status,
          workingType: stop.workingType,
        },
      };
    },
    async upgradeVstLongStop() {
      throw new Error("fresh impulse fixture does not upgrade stops");
    },
    async closeLong() {
      throw new Error("fresh impulse fixture does not close positions");
    },
    async placeVstAutomatedVirtualSplitLongStop(request) {
      calls.push(["placeSplitStop", request]);
      writes.push(["placeSplitStop", request]);
      const orderId = request.tranche === "core"
        ? "fresh-split-core-stop" : "fresh-split-runner-stop";
      const row = {
        symbol: exchangeSymbol,
        orderId,
        mainOrderId: request.entryOrderId,
        type: "STOP_MARKET",
        status: "NEW",
        side: "SELL",
        positionSide: "LONG",
        workingType: "MARK_PRICE",
        positionId: request.positionId,
        origQty: String(request.quantity),
        stopPrice: String(request.stopPrice),
        time: NOW,
      };
      orders.push(row);
      saveHistory(row);
      if (request.tranche === "core" && ambiguousCoreStop && firstCoreStop) {
        firstCoreStop = false;
        throw new Error("simulated_lost_core_stop_acknowledgement");
      }
      return {
        symbol: exchangeSymbol,
        tranche: request.tranche,
        orderId,
        verified: true,
      };
    },
    async closeVstAutomatedSplitTranche() {
      throw new Error("fresh entry fixture does not close a tranche");
    },
    async cancelVstAutomatedSplitStopAfterPartial() {
      throw new Error("fresh entry fixture does not clean a partially closed tranche");
    },
    async placeVstAutomatedSplitLegStopUpgrade() {
      throw new Error("fresh entry fixture does not upgrade a split stop");
    },
    async cancelVstAutomatedSplitLegStopUpgrade() {
      throw new Error("fresh entry fixture does not cancel an upgraded split stop");
    },
    async closeVstAutomatedSoleSplitLeg() {
      throw new Error("fresh entry fixture does not close a sole split leg");
    },
    async closeVstAutomatedFullSplitPosition() {
      throw new Error("fresh entry fixture does not close a full split position");
    },
    async closeVstAutomatedPreRunnerSplit(request) {
      calls.push(["closePreRunnerSplit", request]);
      writes.push(["closePreRunnerSplit", request]);
      preRunnerClosePosts.push({ ...request });
      assert.equal(position.positionAmt, request.totalQuantity);
      const stops = [request.originalStop, request.coreStop];
      for (const stop of stops) {
        assert.ok(orders.some((row) =>
          row.orderId === stop.orderId &&
          row.origQty === stop.quantity &&
          row.stopPrice === stop.stopPrice));
      }
      const closeOrderId = "fresh-pre-runner-close-order";
      const closeOrder = {
        symbol: exchangeSymbol,
        orderId: closeOrderId,
        clientOrderId: request.clientOrderId,
        status: "FILLED",
        side: "SELL",
        positionSide: "LONG",
        type: "MARKET",
        reduceOnly: true,
        origQty: request.totalQuantity,
        executedQty: request.totalQuantity,
        time: NOW,
      };
      saveHistory(closeOrder);
      fills.push({
        symbol: exchangeSymbol,
        orderId: closeOrderId,
        tradeId: "fresh-pre-runner-close-fill-90071992547409931235",
        side: "SELL",
        positionSide: "LONG",
        volume: request.totalQuantity,
        price: "100",
        commission: "-0.02",
        currency: "VST",
        filledTm: NOW,
      });
      position.positionAmt = "0";
      const remainingKnownStopOrderIds = stops.map((stop) => stop.orderId);
      if (ambiguousPreRunnerClose && firstPreRunnerClose) {
        firstPreRunnerClose = false;
        throw new Error("simulated_lost_pre_runner_close_acknowledgement");
      }
      return {
        verified: true,
        symbol: exchangeSymbol,
        positionId: request.positionId,
        clientOrderId: request.clientOrderId,
        closeIntentId: request.closeIntentId,
        flat: true,
        remainingKnownStopOrderIds,
      };
    },
    async cancelVstAutomatedKnownStopWhenFlat(request) {
      calls.push(["cancelFlatStop", request]);
      writes.push(["cancelFlatStop", request]);
      assert.equal(position.positionAmt, "0");
      const index = orders.findIndex((row) =>
        row.orderId === request.stopToCancel.orderId);
      assert.notEqual(index, -1);
      const [stop] = orders.splice(index, 1);
      saveHistory({ ...stop, status: "CANCELED", executedQty: "0" });
      return {
        verified: true,
        symbol: exchangeSymbol,
        positionId: request.positionId,
        cancellationIntentId: request.cancellationIntentId,
        canceledStopOrderId: request.stopToCancel.orderId,
        status: "CANCELED",
        flat: true,
        knownRemainingStopOrderIds: [...request.knownRemainingStopOrderIds],
        remainingKnownStopOrderIds: orders.map((row) => row.orderId),
      };
    },
    async cancelVstAutomatedOriginalAfterTriggeredRunner() {
      throw new Error("fresh entry fixture does not clean a triggered runner");
    },
    async cancelVstAutomatedAttachedLongStopAfterSplit(request) {
      calls.push(["cancelOriginal", request]);
      writes.push(["cancelOriginal", request]);
      const index = orders.findIndex((row) =>
        row.orderId === request.originalStopOrderId);
      assert.notEqual(index, -1);
      const [stop] = orders.splice(index, 1);
      saveHistory({ ...stop, status: "CANCELED", executedQty: "0" });
      return { status: "CANCELED", verified: true };
    },
  };
  return {
    api,
    calls,
    writes,
    orders,
    history,
    fills,
    position,
    markReads,
    preRunnerClosePosts,
    foreignOrders,
    setAmbiguousTopUp(value) { ambiguousTopUp = value; },
    setMarkPrice(value) { markPrice = String(value); },
    addForeignStop() {
      const row = {
        symbol: exchangeSymbol,
        orderId: "fresh-foreign-stop",
        mainOrderId: "foreign-entry-order",
        type: "STOP_MARKET",
        status: "NEW",
        side: "SELL",
        positionSide: "LONG",
        workingType: "MARK_PRICE",
        positionId: position.positionId,
        origQty: String(position.positionAmt),
        stopPrice: "94",
        time: NOW,
      };
      orders.push(row);
      saveHistory(row);
      return row;
    },
    addForeignOpenOrder(foreignSymbol = "BTCUSDT") {
      const row = {
        symbol: nameOf(foreignSymbol),
        orderId: "fresh-foreign-symbol-open-order",
        clientOrderId: "fresh-foreign-symbol-order-client",
        type: "LIMIT",
        status: "NEW",
        side: "BUY",
        positionSide: "LONG",
        price: "100",
        origQty: "0.01",
        executedQty: "0",
        time: NOW,
      };
      foreignOrders.push(row);
      saveHistory(row);
      return row;
    },
  };
}

function makeFreshSignalWorker(
  store, exchange, canarySymbols, decorateBroker = (value) => value,
  sourceExitsEnabled = false, clock = () => NOW,
) {
  const broker = decorateBroker(createVstBroker({
    api: exchange.api,
    accountId: ACCOUNT,
    canarySymbols,
    clock,
    sleep: async () => {},
    stopBufferRate: 0.005,
  }));
  return {
    broker,
    worker: createVstWorker({
      store,
      broker,
      clock,
      sizingLimits: {
        environment: "vst",
        maxQuoteAgeMs: 10_000,
        maxPriceMoveBps: 500,
        maxSlippageBps: 100,
      },
      sourceExitsEnabled,
    }),
  };
}

function historicalErrorCandidate(sourceSignalId = "historical-error-signal", symbol = "ETHUSDT") {
  const entryAt = new Date(NOW - 90_000).toISOString();
  return {
    sourceSignalId,
    symbol,
    status: "error",
    snapshot: {
      sourceSignalId,
      symbol,
      status: "error",
      environment: "vst",
      accountId: ACCOUNT,
      remainingQty: "0.1",
      entryAt,
      verifiedFill: { price: "100", quantity: "0.1", at: entryAt },
    },
    updatedAt: new Date(NOW - 60_000).toISOString(),
    positionVersion: new Date(NOW - 60_000).toISOString()
      .replace(".000Z", ".000000Z"),
    signalStatus: "unknown",
    signalReason: "entry_verification_abandoned_confirmed_open_unprotected",
    entryIntent: {
      sourceSignalId,
      phase: "market-entry",
      clientOrderId: `parent-${sourceSignalId}`,
      request: {
        operation: "entry",
        environment: "vst",
        accountId: ACCOUNT,
        symbol,
        entryOrderType: "MARKET",
      },
      state: "failed",
      exchangeOrderId: `entry-${sourceSignalId}`,
      outcome: { reason: "entry_verification_abandoned_confirmed_open_unprotected" },
    },
  };
}

function addHistoricalRepairCandidate(store, candidate) {
  const listing = [];
  store.data.positions.push({
    sourceSignalId: candidate.sourceSignalId,
    symbol: candidate.symbol,
    status: "error",
    snapshot: candidate.snapshot,
  });
  store.listHistoricalCloseCandidates = async (limit = 2, { after = null } = {}) => {
    listing.push({ limit, after });
    return after ? [] : [candidate].slice(0, limit);
  };
  store.reconcileHistoricalClose = async (supplied, proof) => {
    assert.equal(supplied.sourceSignalId, candidate.sourceSignalId);
    assert.equal(proof.verified, true);
    const row = store.data.positions.find((item) =>
      item.sourceSignalId === candidate.sourceSignalId);
    row.status = "closed";
    row.snapshot = { ...row.snapshot, status: "closed" };
    store.data.events.push([candidate.sourceSignalId, "exchange_history_provenance"]);
    return { kind: "reconciled", position: row };
  };
  return listing;
}

function confirmedImpulseSignal(symbol, sourceSignalId) {
  return {
    ...signal,
    sourceSignalId,
    symbol,
    signalAt: new Date(NOW - 5_000).toISOString(),
    payload: {
      ...signal.payload,
      exitRules: {
        ...EXIT_RULES,
        breakevenAtPct: symbol.startsWith("BTC") ? 1 : 5,
      },
    },
  };
}

test("automatic historical close repair commits one flat error candidate without unresolved intents", async () => {
  const store = durableStore(null);
  const candidate = historicalErrorCandidate();
  const listing = addHistoricalRepairCandidate(store, candidate);
  const exchange = freshEntryExchange({ symbol: "BTCUSDT", initialLeverage: 10 });
  const proofCalls = [];
  const { worker } = makeFreshSignalWorker(store, exchange, ["BTCUSDT"], (broker) => ({
    ...broker,
    async readHistoricalErrorClose(supplied) {
      proofCalls.push(supplied.sourceSignalId);
      return { verified: true, sourceSignalId: supplied.sourceSignalId };
    },
  }));

  const result = await worker.runOnce();
  assert.deepEqual(result, {
    kind: "acted",
    reason: "historical_close_ledger_reconciled",
    operation: "historical_close_ledger_reconciled",
    sourceSignalId: candidate.sourceSignalId,
    symbol: candidate.symbol,
  });
  assert.deepEqual(proofCalls, [candidate.sourceSignalId]);
  assert.equal(listing[0].limit, 1);
  assert.deepEqual(store.data.intents, []);
  assert.equal(store.data.positions.find((row) =>
    row.sourceSignalId === candidate.sourceSignalId).status, "closed");
  assert.deepEqual(store.data.events.at(-1), [
    candidate.sourceSignalId, "exchange_history_provenance",
  ]);
  assert.deepEqual(exchange.writes, []);
});

test("refused historical proof is local and fresh signal processing stays ahead of repair", async () => {
  const store = durableStore(null);
  const candidate = historicalErrorCandidate();
  const listing = addHistoricalRepairCandidate(store, candidate);
  const fresh = confirmedImpulseSignal("BTCUSDT", "fresh-entry-ahead-of-history");
  await store.enqueue(fresh);
  const exchange = freshEntryExchange({ symbol: "BTCUSDT", initialLeverage: 10 });
  let proofCalls = 0;
  const { worker } = makeFreshSignalWorker(store, exchange, ["BTCUSDT"], (broker) => ({
    ...broker,
    async readHistoricalErrorClose() {
      proofCalls += 1;
      throw new Error("historical proof refused");
    },
  }));
  const entryResult = await worker.runOnce();
  assert.notEqual(entryResult.reason, "historical_close_ledger_reconciled");
  assert.equal(listing.length, 0);
  assert.equal(proofCalls, 0);

  const idleStore = durableStore(null);
  const refusedCandidate = historicalErrorCandidate("refused-proof-signal");
  const idleListing = addHistoricalRepairCandidate(idleStore, refusedCandidate);
  const idleExchange = freshEntryExchange({ symbol: "BTCUSDT", initialLeverage: 10 });
  const { worker: idleWorker } = makeFreshSignalWorker(
    idleStore, idleExchange, ["BTCUSDT"], (broker) => ({
      ...broker,
      async readHistoricalErrorClose() {
        proofCalls += 1;
        throw new Error("historical proof refused");
      },
    }),
  );
  assert.deepEqual(await idleWorker.runOnce(), { kind: "idle" });
  assert.deepEqual(await idleWorker.runOnce(), { kind: "idle" });
  assert.deepEqual(await idleWorker.runOnce(), { kind: "idle" });
  assert.deepEqual(await idleWorker.runOnce(), { kind: "idle" });
  assert.equal(idleListing.length, 4);
  assert.equal(idleListing[0].limit, 1);
  assert.equal(proofCalls, 1, "failed history proof is bounded by retry backoff");
  assert.equal(idleStore.data.positions.find((row) =>
    row.sourceSignalId === refusedCandidate.sourceSignalId).status, "error");
  assert.deepEqual(idleExchange.writes, []);
});

test("explicitly unsupported fill completeness skips candidate scans and proof reads", async () => {
  const store = durableStore(null);
  const candidate = historicalErrorCandidate("unsupported-history-signal");
  const listing = addHistoricalRepairCandidate(store, candidate);
  const exchange = freshEntryExchange({ symbol: "BTCUSDT", initialLeverage: 10 });
  let proofCalls = 0;
  const { worker } = makeFreshSignalWorker(store, exchange, ["BTCUSDT"], (broker) => ({
    ...broker,
    supportsHistoricalCloseProof: false,
    async readHistoricalErrorClose() {
      proofCalls += 1;
      throw new Error("must not issue historical proof read");
    },
  }));

  assert.deepEqual(await worker.runOnce(), { kind: "idle" });
  assert.equal(listing.length, 0, "unsupported capability skips DB candidate reads");
  assert.equal(proofCalls, 0, "unsupported capability skips exchange proof reads");
  assert.equal(store.data.positions.find((row) =>
    row.sourceSignalId === candidate.sourceSignalId).status, "error");
  assert.deepEqual(exchange.writes, []);
});

test("historical repair runs after management of nine known open positions without changing them", async () => {
  const store = durableStore(null);
  const symbols = [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "ADAUSDT", "XRPUSDT",
    "LTCUSDT", "LINKUSDT", "AVAXUSDT", "DOTUSDT",
  ];
  const activePositions = symbols.map((symbol, index) => {
    const sourceSignalId = `known-open-${index}`;
    const activeSignal = confirmedImpulseSignal(symbol, sourceSignalId);
    activeSignal.patternId = "balanced_grind";
    const exitRules = { ...activeSignal.payload.exitRules };
    delete exitRules.runner;
    activeSignal.payload = { rulesVersion: "bullet-long-exits-v2", exitRules };
    const fill = {
      price: "100",
      quantity: "0.1",
      at: new Date(NOW - 1_000).toISOString(),
    };
    const policy = createVstPolicy({ signal: activeSignal, fill });
    const snapshot = {
      ...policy,
      sourceSignalId,
      symbol,
      status: "open",
      executionStatus: "open",
      environment: "vst",
      accountId: ACCOUNT,
      marginMode: "ISOLATED",
      leverage: 10,
      signalSnapshot: activeSignal,
      verifiedFill: fill,
      entryClientOrderId: `entry-client-${index}`,
      entryOrderId: `entry-order-${index}`,
    };
    return { sourceSignalId, symbol, status: "open", snapshot };
  });
  store.data.positions.push(...activePositions);
  const candidate = historicalErrorCandidate("repair-after-nine", "ATOMUSDT");
  const listing = addHistoricalRepairCandidate(store, candidate);
  const exchange = freshEntryExchange({ symbol: "BTCUSDT", initialLeverage: 10 });
  const capabilities = {
    verified: true,
    environment: "vst",
    accountId: ACCOUNT,
    features: FEATURES,
  };
  const positions = activePositions.map((record) => ({
    symbol: `${record.symbol.slice(0, -4)}-USDT`,
    positionSide: "LONG",
    positionAmt: "0.1",
    positionId: `exchange-${record.sourceSignalId}`,
  }));
  const { worker } = makeFreshSignalWorker(store, exchange, ["BTCUSDT"], (broker) => ({
    ...broker,
    async getCapabilities() { return capabilities; },
    async readAccountState() {
      return {
        verified: true, environment: "vst", accountId: ACCOUNT,
        positions, openOrders: [],
      };
    },
    async readPosition(symbol) {
      const record = activePositions.find((item) => item.symbol === symbol);
      assert.ok(record, `known position ${symbol} is read`);
      return {
        verified: true,
        symbol,
        side: "Buy",
        quantity: "0.1",
        leverage: 10,
        marginMode: "ISOLATED",
        positionId: `exchange-${record.sourceSignalId}`,
        protectiveStops: {
          core: {
            verified: true,
            orderId: `stop-${record.sourceSignalId}`,
            positionId: `exchange-${record.sourceSignalId}`,
            quantity: "0.1",
            stopPrice: String(record.snapshot.stopPrice),
          },
        },
      };
    },
    async readMarketMark(symbol) {
      return {
        verified: true, symbol, price: "100", observedAt: new Date(NOW).toISOString(),
      };
    },
    async readHistoricalErrorClose(supplied) {
      return { verified: true, sourceSignalId: supplied.sourceSignalId };
    },
  }));

  const result = await worker.runOnce();
  assert.equal(result.reason, "historical_close_ledger_reconciled");
  assert.equal(listing.length, 1);
  assert.equal(store.data.positions.filter((row) => row.status === "open").length, 9);
  assert.deepEqual(
    store.data.positions.filter((row) => row.status === "open")
      .map((row) => row.sourceSignalId).sort(),
    activePositions.map((row) => row.sourceSignalId).sort(),
  );
  assert.equal(store.data.positions.find((row) =>
    row.sourceSignalId === candidate.sourceSignalId).status, "closed");
  assert.deepEqual(exchange.writes, []);
});

test("deep-stop VST entry atomically reserves, adds and verifies post-fill margin before management", async () => {
  const store = durableStore(null);
  const exchange = freshEntryExchange({
    symbol: "BTCUSDT",
    initialLeverage: 5,
    expectedStopLoss: "85",
    ambiguousTopUp: "after",
  });
  const { worker } = makeFreshSignalWorker(store, exchange, ["BTCUSDT"]);
  const freshSignal = {
    ...confirmedImpulseSignal("BTCUSDT", "deep-stop-requires-unavailable-preentry-margin"),
    stopLoss: "85",
  };
  assert.equal((await worker.enqueue(freshSignal)).kind, "new");
  assert.equal((await worker.runOnce()).kind, "prepared");
  const entered = await worker.runOnce();
  assert.equal(entered.kind, "top_up_pending", JSON.stringify({
    entered, status: store.data.status, reason: store.data.reason,
  }));
  const topUpIntent = store.data.intents.find((row) =>
    row.phase === "margin-top-up");
  const entryRequest = store.data.intents.find((row) =>
    row.phase === "market-entry").request;
  assert.ok(topUpIntent);
  assert.equal(
    entryRequest.approvedTopUpMargin,
    String(entryRequest.sizing.plannedTopUpVst),
  );
  assert.equal(topUpIntent.request.amount, "5.18",
    "the exchange liquidation price, not the pre-entry estimate, determines funding");
  assert.notEqual(topUpIntent.request.amount, entryRequest.approvedTopUpMargin);
  assert.equal(topUpIntent.state, "prepared");
  assert.equal(topUpIntent.request.stopLoss, "85");
  assert.equal(store.data.positions[0].snapshot.marginTopUp.status, "pending");
  const writesBeforeTopUp = exchange.writes.filter(([kind]) =>
    kind === "addMargin" || kind === "placeSplitStop");
  assert.deepEqual(writesBeforeTopUp, []);
  const result = await worker.runOnce();
  assert.deepEqual(result, {
    kind: "funded", reason: "vst_margin_top_up_verified_refresh_required",
  });
  assert.equal(topUpIntent.state, "reconciled");
  assert.equal(store.data.positions[0].snapshot.marginTopUp.status, "verified");
  assert.equal(store.data.positions[0].snapshot.marginTopUp.protectionStatus,
    "liquidation_below_stop_buffer");
  assert.equal(store.data.positions[0].snapshot.signalStopPrice, "85");
  const topUpIndex = exchange.writes.findIndex(([kind]) => kind === "addMargin");
  assert.notEqual(topUpIndex, -1);
  const firstManagementIndex = exchange.writes.findIndex(([kind]) =>
    kind === "placeSplitStop" || kind === "closePreRunnerSplit");
  assert.equal(firstManagementIndex, -1);
  await worker.runOnce();
  const managementAfterRefresh = exchange.writes.findIndex(([kind]) =>
    kind === "placeSplitStop" || kind === "closePreRunnerSplit");
  assert.ok(managementAfterRefresh > topUpIndex);
  assert.equal(exchange.writes.filter(([kind]) => kind === "addMargin").length, 1);
});

test("a zero pre-entry estimate cannot suppress a live post-fill liquidation risk", async () => {
  const store = durableStore(null);
  const commitVerifiedIntent = store.commitVerifiedIntent.bind(store);
  store.commitVerifiedIntent = async (commit) => {
    if (commit.position?.marginTopUp?.status === "verified") {
      const marker = commit.position.marginTopUp;
      assert.equal(Object.hasOwn(marker, "failureReason"), false,
        "the strict production store cannot serialize an undefined old failure reason");
      assert.ok(Object.values(marker).every((value) => value !== undefined));
    }
    return commitVerifiedIntent(commit);
  };
  const exchange = freshEntryExchange({
    expectedStopLoss: "95", liquidationPriceAfterEntry: "97",
  });
  const { worker } = makeFreshSignalWorker(store, exchange, ["BTCUSDT"]);
  await worker.enqueue({
    ...confirmedImpulseSignal("BTCUSDT", "new-post-fill-risk"),
    stopLoss: "95",
  });
  await worker.runOnce();
  assert.equal((await worker.runOnce()).kind, "top_up_pending");
  const entry = store.data.intents.find((row) => row.phase === "market-entry");
  assert.equal(entry.request.sizing.plannedTopUpVst, 0);
  const topUp = store.data.intents.find((row) => row.phase === "margin-top-up");
  assert.equal(topUp.request.amount, "2.36");
  assert.equal((await worker.runOnce()).kind, "funded");
  assert.equal(store.data.positions[0].snapshot.marginTopUp.protectionStatus,
    "liquidation_below_stop_buffer");
});

test("a funded top-up survives a ledger failure and is reconciled without a second margin POST", async () => {
  const store = durableStore(null);
  // Production lists in-flight "opening" signals even after their entry
  // created a position; the narrow getPending fallback does not.
  store.listPendingCandidates = async () =>
    store.data.pending ? [store.data.pending] : [];
  const commitVerifiedIntent = store.commitVerifiedIntent.bind(store);
  let rejectFirstFundedCommit = true;
  store.commitVerifiedIntent = async (commit) => {
    if (commit.position?.marginTopUp?.status === "verified") {
      const marker = commit.position.marginTopUp;
      if (Object.values(marker).some((value) => value === undefined)) {
        throw new TypeError("Persisted objects must not contain undefined values");
      }
      assert.equal(Object.hasOwn(marker, "failureReason"), false);
      if (rejectFirstFundedCommit) {
        rejectFirstFundedCommit = false;
        throw new Error("simulated_database_commit_failure");
      }
    }
    return commitVerifiedIntent(commit);
  };
  const exchange = freshEntryExchange({
    expectedStopLoss: "85", initialLeverage: 5,
  });
  const { worker } = makeFreshSignalWorker(store, exchange, ["BTCUSDT"]);
  await worker.enqueue({
    ...confirmedImpulseSignal("BTCUSDT", "top-up-commit-recovery"),
    stopLoss: "85",
  });
  assert.equal((await worker.runOnce()).kind, "prepared");
  assert.equal((await worker.runOnce()).kind, "top_up_pending");
  assert.equal((await worker.runOnce()).kind, "unknown",
    "a margin POST ends the tick after its mandatory fresh-account read");
  const topUp = store.data.intents.find((row) => row.phase === "margin-top-up");
  assert.equal(topUp.state, "unknown");
  assert.equal(store.data.status, "unknown",
    "an in-flight signal with a committed position must not re-enter planning");
  assert.equal(store.data.positions[0].snapshot.marginTopUp.status, "pending");
  assert.equal(exchange.writes.filter(([kind]) => kind === "addMargin").length, 1);

  assert.equal((await worker.runOnce()).kind, "funded");
  assert.equal(topUp.state, "reconciled");
  assert.equal(store.data.positions[0].snapshot.marginTopUp.status, "verified");
  assert.equal(exchange.writes.filter(([kind]) => kind === "addMargin").length, 1);
});

test("stage timing still reports a thrown reconciliation failure without changing the trading error", async () => {
  const store = durableStore(null);
  const exchange = freshEntryExchange({});
  const { broker } = makeFreshSignalWorker(store, exchange, ["BTCUSDT"]);
  const failure = new Error("simulated_reconciliation_store_failure");
  store.listUnresolvedIntents = async () => { throw failure; };
  const timings = [];
  const worker = createVstWorker({
    store, broker, clock: () => NOW,
    onTiming: (timing) => { timings.push(timing); },
    sizingLimits: {
      environment: "vst", maxQuoteAgeMs: 10_000, maxSlippageBps: 100,
    },
  });
  await assert.rejects(worker.runOnce(), (error) => error === failure);
  assert.equal(timings.length, 1);
  assert.equal(timings[0].kind, "exception");
  assert.ok(timings[0].stages.capabilities >= 0);
  assert.ok(timings[0].stages.capabilityAccountSnapshot >= 0);
  assert.ok(timings[0].stages.capabilityHistoryAndSymbolReads >= 0);
  assert.equal(Object.hasOwn(timings[0].stages, "capabilityFreshMarks"), false);
  assert.equal(Object.hasOwn(timings[0], "reason"), false);
});

test("a safe liquidation cannot excuse a changed original stop order", async () => {
  const store = durableStore(null);
  const exchange = freshEntryExchange({ expectedStopLoss: "95" });
  const { worker } = makeFreshSignalWorker(store, exchange, ["BTCUSDT"], (broker) => ({
    ...broker,
    async readMarginTopUpPlan(request) {
      const plan = await broker.readMarginTopUpPlan(request);
      assert.equal(plan.amount, null);
      return {
        ...plan,
        protectiveStop: { ...plan.protectiveStop, orderId: "unrelated-stop" },
      };
    },
  }));
  await worker.enqueue({
    ...confirmedImpulseSignal("BTCUSDT", "safe-but-replaced-original-stop"),
    stopLoss: "95",
  });
  await worker.runOnce();
  assert.equal((await worker.runOnce()).kind, "unknown");
  const entry = store.data.intents.find((row) => row.phase === "market-entry");
  assert.equal(entry.state, "unknown");
  assert.equal(entry.detail.outcome.reason,
    "vst_margin_top_up_baseline_or_original_stop_not_verified");
  assert.equal(store.data.positions.length, 0);
  assert.equal(store.data.events.some((row) =>
    Object.hasOwn(row[2] ?? {}, "actualFillDeviationPct")), false);
});

test("exact funded margin without a safely moved liquidation price stays in error, never managed", async () => {
  const store = durableStore(null);
  const exchange = freshEntryExchange({
    expectedStopLoss: "85", topUpMovesLiquidation: false,
  });
  const { worker } = makeFreshSignalWorker(store, exchange, ["BTCUSDT"]);
  await worker.enqueue({
    ...confirmedImpulseSignal("BTCUSDT", "funded-but-liquidation-unsafe"),
    stopLoss: "85",
  });
  await worker.runOnce();
  assert.equal((await worker.runOnce()).kind, "top_up_pending");
  assert.equal((await worker.runOnce()).kind, "funded");
  const topUp = store.data.intents.find((row) => row.phase === "margin-top-up");
  assert.equal(topUp.state, "reconciled");
  assert.equal(topUp.detail.outcome.protectionVerified, false);
  assert.equal(store.data.positions[0].snapshot.status, "error");
  assert.equal(store.data.positions[0].snapshot.marginTopUp.protectionStatus,
    "unsafe_after_funding");
  assert.equal(store.data.events.filter((row) =>
    row[1] === "vst_margin_top_up_funded_but_unsafe").length, 1);
  await worker.runOnce();
  assert.equal(exchange.writes.filter(([kind]) => kind === "addMargin").length, 1);
  assert.equal(exchange.writes.filter(([kind]) =>
    kind === "placeSplitStop").length, 0);
});

test("ambiguous VST top-up is reconciled read-only after restart and is never retried", async () => {
  const store = durableStore(null);
  const exchange = freshEntryExchange({
    symbol: "BTCUSDT",
    initialLeverage: 5,
    expectedStopLoss: "85",
    ambiguousTopUp: "before",
  });
  const { worker } = makeFreshSignalWorker(store, exchange, ["BTCUSDT"]);
  const freshSignal = {
    ...confirmedImpulseSignal("BTCUSDT", "ambiguous-post-fill-top-up-is-not-retried"),
    stopLoss: "85",
  };
  await worker.enqueue(freshSignal);
  await worker.runOnce(); // confirm 10× leverage
  assert.equal((await worker.runOnce()).kind, "top_up_pending"); // entry + atomic prepared intent
  assert.equal(store.data.intents.find((row) =>
    row.phase === "margin-top-up").state, "prepared");

  const firstReconcile = await worker.runOnce();
  assert.equal(firstReconcile.kind, "unknown",
    "an ambiguous margin POST ends the tick after its mandatory fresh-account read");
  const topUpIntent = store.data.intents.find((row) =>
    row.phase === "margin-top-up");
  assert.equal(topUpIntent.state, "unknown");
  assert.equal(store.data.positions[0].snapshot.marginTopUp.status, "pending");
  const unconfirmedEvents = store.data.events.filter((event) =>
    event[1] === "vst_margin_top_up_unconfirmed");
  assert.equal(unconfirmedEvents.length, 1, JSON.stringify(store.data.events));
  assert.equal(unconfirmedEvents[0][0], freshSignal.sourceSignalId);
  assert.equal(unconfirmedEvents[0][2].reason, "vst_margin_top_up_state_not_verified");
  assert.equal(unconfirmedEvents[0][3], undefined);
  assert.equal(exchange.writes.filter(([kind]) => kind === "addMargin").length, 1);

  const beforeRestartRecovery = exchange.writes.filter(([kind]) => kind === "addMargin").length;
  assert.equal((await worker.runOnce()).kind, "blocked");
  assert.equal(
    exchange.writes.filter(([kind]) => kind === "addMargin").length,
    beforeRestartRecovery,
    "submitted/unknown top-up must be reconciled by reads and never resubmitted",
  );
  assert.equal(store.data.events.filter((event) =>
    event[1] === "vst_margin_top_up_unconfirmed").length, 1);
  exchange.position.isolatedMargin = String(
    Number(topUpIntent.request.expectedIsolatedMarginBefore) +
    Number(topUpIntent.request.amount) + 1,
  );
  assert.equal((await worker.runOnce()).kind, "blocked",
    "an oversized margin change after an ambiguous write must not unlock management");
  assert.equal(topUpIntent.state, "unknown");
  assert.equal(store.data.positions[0].snapshot.marginTopUp.status, "pending");
  assert.equal(exchange.writes.filter(([kind]) =>
    kind === "placeSplitStop" || kind === "closePreRunnerSplit").length, 0);
});

test("a signal far from market still preserves its source stop and stores the comparison", async () => {
  const store = durableStore(null);
  const exchange = freshEntryExchange({
    symbol: "BTCUSDT", initialLeverage: 5, expectedStopLoss: "85",
  });
  const { worker } = makeFreshSignalWorker(store, exchange, ["BTCUSDT"]);
  await worker.enqueue({
    ...confirmedImpulseSignal("BTCUSDT", "market-priced-with-source-exits"),
    referencePrice: "90",
    stopLoss: "85",
  });
  assert.equal((await worker.runOnce()).kind, "prepared");
  assert.equal((await worker.runOnce()).kind, "top_up_pending");
  const entry = store.data.intents.find((row) => row.phase === "market-entry");
  assert.equal(entry.request.signal.referencePrice, "90");
  assert.equal(entry.request.stopLoss, "85");
  assert.equal(entry.request.sizing.signalReferencePrice, 90);
  assert.equal(entry.request.sizing.quotePrice, 100);
  assert.equal(entry.request.sizing.signalPriceDeviationPct, 11.111111);
  assert.equal(entry.request.entryOrderType, "MARKET");
  const position = store.data.positions[0].snapshot;
  assert.equal(position.entryOrderType, "MARKET");
  assert.equal(position.verifiedFill.price, 100);
  assert.equal(position.signalStopPrice, "85");
  assert.equal(position.sizing.signalPriceDeviationPct, 11.111111);
  assert.deepEqual(position.priceAudit, {
    signalReferencePrice: "90",
    signalAt: entry.request.signal.signalAt,
    planningQuotePrice: "100",
    planningQuoteObservedAt: new Date(entry.request.sizing.quoteObservedAtMs).toISOString(),
    planningPriceDeviationPct: 11.111111,
    verifiedFillPrice: "100",
    verifiedFillAt: new Date(NOW).toISOString(),
    actualFillDeviationPct: 11.111111,
  });
  const entryEvent = store.data.events.find((event) =>
    event[1] === "vst_impulse_entry_margin_top_up_pending");
  assert.equal(entryEvent[2].signalPriceDeviationPct, 11.111111);
  assert.equal(entryEvent[2].actualFillDeviationPct, 11.111111);
  assert.equal(entryEvent[2].verifiedFillPrice, 100);
  assert.equal(entryEvent[2].verifiedFillAt, new Date(NOW).toISOString());
  const reloadedSnapshot = JSON.parse(JSON.stringify(position));
  assert.equal(reloadedSnapshot.priceAudit.actualFillDeviationPct, 11.111111);
  assert.equal(reloadedSnapshot.priceAudit.verifiedFillAt, new Date(NOW).toISOString());
  assert.deepEqual(entry.request.signal.payload.exitRules,
    confirmedImpulseSignal("BTCUSDT", "market-priced-with-source-exits").payload.exitRules);
  assert.equal(exchange.writes.filter(([kind]) => kind === "placeEntry").length, 1);
});

test("verified MARKET fill records a negative signed deviation from the source price", async () => {
  const store = durableStore(null);
  const exchange = freshEntryExchange({
    symbol: "BTCUSDT", initialLeverage: 5, expectedStopLoss: "85", fillPrice: "95",
  });
  const { worker } = makeFreshSignalWorker(store, exchange, ["BTCUSDT"]);
  await worker.enqueue({
    ...confirmedImpulseSignal("BTCUSDT", "market-fill-below-source-reference"),
    referencePrice: "100",
    stopLoss: "85",
  });
  assert.equal((await worker.runOnce()).kind, "prepared");
  assert.equal((await worker.runOnce()).kind, "top_up_pending");
  const position = store.data.positions[0].snapshot;
  assert.equal(position.verifiedFill.price, 95);
  assert.equal(position.priceAudit.signalReferencePrice, "100");
  assert.equal(position.priceAudit.planningPriceDeviationPct, 0);
  assert.equal(position.priceAudit.actualFillDeviationPct, -5);
  assert.equal(position.priceAudit.verifiedFillPrice, "95");
  const event = store.data.events.find((row) =>
    row[1] === "vst_impulse_entry_margin_top_up_pending");
  assert.equal(event[2].signalPriceDeviationPct, 0);
  assert.equal(event[2].actualFillDeviationPct, -5);
});

test("missing history does not falsely abandon or replay an ambiguous margin top-up", async () => {
  const store = durableStore(null);
  const exchange = freshEntryExchange({
    symbol: "BTCUSDT",
    initialLeverage: 5,
    expectedStopLoss: "85",
    ambiguousTopUp: "before", // the write throws before ever touching isolatedMargin
  });
  const { worker } = makeFreshSignalWorker(store, exchange, ["BTCUSDT"]);
  const freshSignal = {
    ...confirmedImpulseSignal("BTCUSDT", "never-applied-top-up-is-eventually-abandoned"),
    stopLoss: "85",
  };
  await worker.enqueue(freshSignal);
  await worker.runOnce(); // confirm 10x leverage
  assert.equal((await worker.runOnce()).kind, "top_up_pending"); // entry + atomic prepared intent

  const firstReconcile = await worker.runOnce();
  assert.equal(firstReconcile.kind, "unknown",
    "an ambiguous margin POST ends the tick after its mandatory fresh-account read");
  const topUpIntent = store.data.intents.find((row) => row.phase === "margin-top-up");
  assert.equal(topUpIntent.state, "unknown");
  assert.equal(store.data.positions[0].snapshot.marginTopUp.status, "pending");

  // A single unconfirmed tick must not give up early -- a genuinely
  // transient read cannot be told apart from a real failure on the first
  // observation alone.
  assert.equal((await worker.runOnce()).kind, "blocked");
  assert.equal(topUpIntent.state, "unknown");

  // Even after the timer, unchanged entry margin and missing adjustment
  // history cannot prove the POST failed. Never send it twice.
  topUpIntent.request = {
    ...topUpIntent.request,
    intentCreatedAt: NOW - 10 * 60 * 1000 - 1,
  };
  await worker.runOnce();
  assert.equal(topUpIntent.state, "unknown");
  assert.equal(store.data.positions[0].snapshot.marginTopUp.status, "pending");
  assert.equal(exchange.writes.filter(([kind]) => kind === "addMargin").length, 1,
    "an ambiguous submitted adjustment must never be retried");
});

test("fresh VST impulse retains the source stop but submits and verifies a tighter price-precision stop", async () => {
  const store = durableStore(null);
  const exchange = freshEntryExchange({
    symbol: "BTCUSDT", initialLeverage: 5, expectedStopLoss: "95.01",
  });
  const { worker } = makeFreshSignalWorker(store, exchange, ["BTCUSDT"]);
  const freshSignal = {
    ...confirmedImpulseSignal("BTCUSDT", "precision-adjusted-btc-impulse"),
    stopLoss: "95.001",
  };
  assert.equal((await worker.enqueue(freshSignal)).kind, "new");
  assert.equal((await worker.runOnce()).kind, "prepared");
  exchange.setMarkPrice("101");
  const opened = await worker.runOnce();
  assert.equal(opened.kind, "acted", JSON.stringify(opened));
  assert.equal(opened.operation, "cancel_original_stop");
  const request = store.data.intents.find((row) => row.request.operation === "entry").request;
  assert.equal(store.data.pending.body.stopLoss, "95.001");
  assert.equal(request.stopLoss, "95.01");
  assert.equal(request.signal.stopLoss, "95.01");
  assert.equal(request.sizing.stopLoss, "95.01");
  assert.equal(store.data.positions[0].snapshot.split.signalStopPrice, "95.01");
  assert.equal(store.data.positions[0].snapshot.version, "bullet-long-exits-v2");
  assert.equal(store.data.positions[0].snapshot.entryPrice, 100);
  assert.equal(store.data.positions[0].snapshot.runnerOpen, true);
});

async function prepareFreshImpulseAtRunnerPending({
  sourceSignalId,
  exchangeOptions = {},
} = {}) {
  const store = durableStore(null);
  const exchange = freshEntryExchange({
    symbol: "BTCUSDT",
    initialLeverage: 5,
    ...exchangeOptions,
  });
  let failRunnerMarkOnce = true;
  const { broker, worker } = makeFreshSignalWorker(
    store, exchange, ["BTCUSDT"], (base) => {
      const readMarketMark = base.readMarketMark.bind(base);
      return {
        ...base,
        async readMarketMark(...args) {
          const coreStopPresent = exchange.orders.some((row) =>
            row.orderId === "fresh-split-core-stop");
          const runnerStopPresent = exchange.orders.some((row) =>
            row.orderId === "fresh-split-runner-stop");
          if (failRunnerMarkOnce && coreStopPresent && !runnerStopPresent) {
            failRunnerMarkOnce = false;
            throw new Error("VST mark is not corroborated by a fresh quote");
          }
          return readMarketMark(...args);
        },
      };
    },
  );
  const freshSignal = confirmedImpulseSignal(
    "BTCUSDT", sourceSignalId ?? "fresh-confirmed-btc-impulse-abort",
  );
  assert.equal((await worker.enqueue(freshSignal)).kind, "new");
  const leveragePrepared = await worker.runOnce();
  assert.equal(leveragePrepared.kind, "prepared", JSON.stringify(leveragePrepared));
  const entry = await worker.runOnce();
  assert.equal(entry.kind, "waiting", JSON.stringify(entry));
  assert.equal(entry.reason, "impulse_runner_be_requires_fresh_mark_above_entry");
  assert.equal(store.data.positions[0].snapshot.split.stage, "runner_pending");
  assert.deepEqual(exchange.orders.map((row) => row.orderId).sort(),
    ["fresh-attached-signal-stop", "fresh-split-core-stop"]);
  return { store, exchange, broker, worker, freshSignal };
}

test("a previously false-failed adjustment is repaired from history without another POST", async () => {
  const store = durableStore(null);
  const exchange = freshEntryExchange({
    symbol: "BTCUSDT", initialLeverage: 5, expectedStopLoss: "85",
  });
  const { worker } = makeFreshSignalWorker(store, exchange, ["BTCUSDT"]);
  await worker.enqueue({
    ...confirmedImpulseSignal("BTCUSDT", "history-recovered-topup"),
    stopLoss: "85",
  });
  await worker.runOnce();
  assert.equal((await worker.runOnce()).kind, "top_up_pending");
  assert.equal((await worker.runOnce()).kind, "funded");
  const intent = store.data.intents.find((row) => row.phase === "margin-top-up");
  const position = store.data.positions[0];
  assert.equal(exchange.writes.filter(([kind]) => kind === "addMargin").length, 1);

  // Recreate the old worker's false terminal verdict, not a second exchange
  // mutation. The same history row is still available to the new worker.
  intent.state = "failed";
  intent.detail = { outcome: {
    reason: "margin_top_up_abandoned_confirmed_not_applied",
    submissionErrorMessage:
      "VST margin top-up was submitted but exact read-after-write margin change is unverified",
  } };
  position.status = "error";
  position.snapshot = { ...position.snapshot, status: "error", marginTopUp: {
    ...position.snapshot.marginTopUp, status: "failed",
    failureReason: "margin_top_up_abandoned_confirmed_not_applied",
  } };
  store.listErrorPositions = async () => store.data.positions.filter((row) =>
    row.status === "error");
  store.listFailedSubmittedMarginTopUps = async () => position.status === "error"
    ? [{ ...position, failedIntent: intent }] : [];
  assert.equal((await worker.runOnce()).kind, "funded");
  assert.equal(intent.state, "reconciled");
  assert.equal(store.data.positions[0].snapshot.status, "open");
  assert.equal(store.data.positions[0].snapshot.marginTopUp.status, "verified");
  assert.equal(intent.detail.outcome.marginHistory.source,
    "bingx_position_margin_history");
  assert.equal(exchange.writes.filter(([kind]) => kind === "addMargin").length, 1);
});

function makeWorker(
  store,
  exchange,
  canarySymbols = [SYMBOL],
  sizingLimits = { environment: "vst" },
  clock = () => NOW,
  sourceExitsEnabled = false,
  capabilityFeatures = FEATURES,
  onBlocked = async () => {},
) {
  const makeBroker = () => createVstBroker({
    api: exchange.api,
    accountId: ACCOUNT,
    canarySymbols,
    clock,
    sleep: async () => {},
    stopBufferRate: 0.005,
  });
  const realBroker = makeBroker();
  // The production broker currently withholds this worker capability. Enable
  // it only in this focused fixture so its real request/evidence path can be
  // exercised without changing production capability policy.
  const broker = {
    ...realBroker,
    async reconcileIntent(intent) {
      const evidence = await realBroker.reconcileIntent(intent);
      exchange.lastBrokerEvidence = evidence;
      return evidence;
    },
    async performIntent(intent) {
      try {
        return await realBroker.performIntent(intent);
      } catch (error) {
        exchange.lastBrokerError = error.message;
        throw error;
      }
    },
    async getCapabilities() {
      return {
        environment: "vst",
        verified: true,
        accountId: ACCOUNT,
        features: capabilityFeatures,
      };
    },
  };
  return {
    broker,
    worker: createVstWorker({
      store,
      broker,
      clock,
      sizingLimits,
      sourceExitsEnabled,
      onBlocked,
    }),
  };
}

async function completeSplitFixture(exchangeOptions = {}) {
  const store = durableStore(splitSnapshot());
  const exchange = mockExchange(exchangeOptions);
  const protectionPhases = [];
  const placeSplitStop = exchange.api.placeVstAutomatedVirtualSplitLongStop;
  exchange.api.placeVstAutomatedVirtualSplitLongStop = async (request) => {
    protectionPhases.push({
      operation: `split_${request.tranche}_stop`,
      openOrderIds: exchange.orders.map((row) => row.orderId).sort(),
    });
    return placeSplitStop(request);
  };
  const cancelOriginal = exchange.api.cancelVstAutomatedAttachedLongStopAfterSplit;
  exchange.api.cancelVstAutomatedAttachedLongStopAfterSplit = async (request) => {
    protectionPhases.push({
      operation: "cancel_original_stop",
      openOrderIds: exchange.orders.map((row) => row.orderId).sort(),
    });
    return cancelOriginal(request);
  };
  const { worker } = makeWorker(store, exchange);
  const completed = await worker.runOnce();
  assert.equal(completed.operation, "cancel_original_stop", JSON.stringify(completed));
  assert.deepEqual(protectionPhases, [
    { operation: "split_core_stop", openOrderIds: ["attached-entry-stop"] },
    { operation: "split_runner_stop",
      openOrderIds: ["attached-entry-stop", "split-core-stop"] },
    { operation: "cancel_original_stop",
      openOrderIds: ["attached-entry-stop", "split-core-stop", "split-runner-stop"] },
  ]);
  assert.equal(store.data.positions[0].snapshot.split.stage, "complete");
  if (exchangeOptions.sourceExitClose) {
    seedReconciledEntryForSourceExit(store, exchange);
  }
  return { store, exchange, worker };
}

function seedReconciledEntryForSourceExit(store, exchange) {
  const state = store.data.positions[0].snapshot;
  const fill = state.verifiedFill;
  const fillAt = Date.parse(fill.at);
  const intentCreatedAt = fillAt - 1_000;
  const exchangeClientOrderId = `vst-${createHash("sha256")
    .update(state.entryClientOrderId).digest("hex").slice(0, 28)}`;
  const originalQuantity = String(fill.quantity);
  const entryIntent = {
    sourceSignalId: state.sourceSignalId,
    phase: "market-entry",
    clientOrderId: state.entryClientOrderId,
    state: "reconciled",
    request: {
      operation: "entry",
      entryOrderType: state.entryOrderType,
      symbol: state.symbol,
      environment: "vst",
      accountId: state.accountId,
      intentCreatedAt,
      quantity: originalQuantity,
      sizing: {
        ...state.sizing,
        environment: "vst",
        quantity: originalQuantity,
      },
      impulseSplit: {
        totalQuantity: originalQuantity,
        coreQuantity: String(state.split.coreQuantity),
        runnerQuantity: String(state.split.runnerQuantity),
        quantityPrecision: state.split.quantityPrecision,
        pricePrecision: state.split.pricePrecision,
        minQuantity: String(state.split.minQuantity),
      },
      signal: state.signalSnapshot,
    },
    exchangeOrderId: state.entryOrderId,
    outcome: {
      status: "filled",
      verified: true,
      operation: "entry",
      positionId: state.exchangePositionId,
      entryOrderId: state.entryOrderId,
      originalStopOrderId: state.originalStopOrderId,
      totalQuantity: originalQuantity,
      coreQuantity: String(state.split.coreQuantity),
      runnerQuantity: String(state.split.runnerQuantity),
      splitStage: "core_pending",
    },
  };
  store.data.intents.push(entryIntent);
  exchange.history.push({
    symbol: SYMBOL_NAME,
    orderId: state.entryOrderId,
    clientOrderId: exchangeClientOrderId,
    status: "FILLED",
    side: "BUY",
    positionSide: "LONG",
    type: state.entryOrderType,
    positionID: state.exchangePositionId,
    origQty: originalQuantity,
    executedQty: originalQuantity,
    avgPrice: String(fill.price),
    time: fillAt,
    updateTime: fillAt,
  });
  exchange.fills.push({
    symbol: SYMBOL_NAME,
    orderId: state.entryOrderId,
    tradeId: "native-entry-fill-1",
    side: "BUY",
    positionSide: "LONG",
    qty: originalQuantity,
    price: String(fill.price),
    filledTm: fillAt,
    commission: "0",
    currency: "USDT",
    commissionAsset: "VST",
  });
}

function exactStop(exchange, orderId, quantity, stopPrice) {
  return {
    ...openStop(orderId, quantity, stopPrice),
    time: NOW,
  };
}

async function completedCoreOnlyVersionlessFixture() {
  const { store, exchange, worker } = await completeSplitFixture();
  const snapshot = structuredClone(store.data.positions[0].snapshot);
  const coreQty = Number(snapshot.split.coreQuantity);
  const coreStop = snapshot.split.coreStop;
  const lastCloseFill = {
    price: "100",
    quantity: String(snapshot.split.runnerQuantity),
    at: new Date(NOW - 500).toISOString(),
    exchangeOrderId: "runner-close-verified",
  };
  const verifiedFill = {
    price: 100,
    quantity: 0.1,
    at: new Date(NOW - 1_000).toISOString(),
  };
  snapshot.verifiedFill = verifiedFill;
  snapshot.policy = {
    ...createVstPolicy({
      signal: snapshot.signalSnapshot,
      fill: verifiedFill,
    }),
    status: "open",
    stopPrice: Number(snapshot.stopPrice),
    peakPct: 4,
    coreQty,
    coreOpen: true,
    runnerQty: 0,
    runnerOpen: false,
    runnerStopPrice: null,
    runnerPeakPct: 9,
    remainingQty: coreQty,
    observedAt: new Date(NOW - 250).toISOString(),
    lastCloseFill,
  };
  snapshot.status = "open";
  snapshot.executionStatus = "open";
  snapshot.signalStopPrice = "95";
  snapshot.actualEntryBreakEvenPrice = "100";
  snapshot.remainingQty = undefined;
  snapshot.coreQty = undefined;
  snapshot.coreOpen = undefined;
  snapshot.runnerQty = undefined;
  snapshot.runnerOpen = undefined;
  snapshot.runnerPeakPct = undefined;
  snapshot.peakPct = undefined;
  snapshot.observationWindowNoted = undefined;
  snapshot.observedAt = undefined;
  snapshot.version = undefined;
  snapshot.entryPrice = undefined;
  snapshot.entryAt = undefined;
  snapshot.runnerStopPrice = null;
  snapshot.coreStopOrderId = coreStop.orderId;
  snapshot.coreStopPositionId = coreStop.positionId;
  snapshot.coreStopQuantity = coreQty;
  snapshot.coreStopPrice = Number(coreStop.stopPrice);
  snapshot.runnerStopOrderId = null;
  snapshot.runnerStopPositionId = null;
  snapshot.runnerStopQuantity = 0;
  snapshot.baselineOpenOrderIds = [coreStop.orderId];
  snapshot.lastCloseFill = structuredClone(lastCloseFill);
  snapshot.split = {
    ...snapshot.split,
    coreStop: { ...coreStop, quantity: String(coreQty) },
    runnerStop: null,
    activeLegs: ["core"],
    baselineOpenOrderIds: [coreStop.orderId],
  };
  store.data.positions[0].snapshot = snapshot;
  store.data.positions[0].status = "open";
  exchange.setPositionQuantity(String(coreQty));
  exchange.setOrderSet([
    exactStop(exchange, coreStop.orderId, coreQty, coreStop.stopPrice),
  ]);
  exchange.setMarkPrice("100");
  const oldSignal = confirmedImpulseSignal("BTCUSDT", "expired-old-zen-entry");
  oldSignal.signalAt = new Date(NOW - 60 * 60_000).toISOString();
  return { store, exchange, worker, snapshot, coreQty, coreStop, lastCloseFill, oldSignal };
}

function trackLedgerWrites(store) {
  const writes = [];
  for (const method of [
    "setSignalStatus", "recordEvent", "upsertPosition", "reserveIntent",
    "markIntent", "commitVerifiedIntent",
  ]) {
    const original = store[method];
    store[method] = async (...args) => {
      writes.push(method);
      return await original(...args);
    };
  }
  return writes;
}

function healthyBtcCoreOnlyPosition(template) {
  const sourceSignalId = "healthy-btc-position-after-quote-error";
  const signal = confirmedImpulseSignal("BTCUSDT", sourceSignalId);
  const fill = structuredClone(template.verifiedFill);
  const initialPolicy = createVstPolicy({ signal, fill });
  const coreStop = {
    orderId: "healthy-btc-core-stop",
    positionId: "healthy-btc-position-id",
    quantity: "0.08",
    stopPrice: "101",
  };
  const policy = {
    ...initialPolicy,
    status: "open",
    stopPrice: 101,
    peakPct: 0,
    coreQty: 0.08,
    coreOpen: true,
    runnerQty: 0,
    runnerOpen: false,
    runnerStopPrice: null,
    runnerPeakPct: 0,
    remainingQty: 0.08,
    observationWindowNoted: false,
    observedAt: new Date(NOW - 1_000).toISOString(),
    lastCloseFill: structuredClone(template.lastCloseFill),
  };
  const position = {
    ...template,
    ...policy,
    sourceSignalId,
    symbol: "BTCUSDT",
    status: "open",
    executionStatus: "open",
    environment: "vst",
    accountId: ACCOUNT,
    signalSnapshot: signal,
    verifiedFill: fill,
    exchangePositionId: "healthy-btc-position-id",
    entryOrderId: "healthy-btc-entry-order",
    signalStopPrice: "95",
    actualEntryBreakEvenPrice: "100",
    remainingQty: 0.08,
    coreQty: 0.08,
    coreOpen: true,
    runnerQty: 0,
    runnerOpen: false,
    stopPrice: 101,
    coreStopOrderId: coreStop.orderId,
    coreStopPositionId: coreStop.positionId,
    coreStopQuantity: 0.08,
    coreStopPrice: 101,
    runnerStopOrderId: null,
    runnerStopPositionId: null,
    runnerStopQuantity: 0,
    runnerStopPrice: null,
    baselineOpenOrderIds: [coreStop.orderId],
    lastCloseFill: structuredClone(policy.lastCloseFill),
    policy,
    split: {
      ...template.split,
      stage: "complete",
      positionId: "healthy-btc-position-id",
      entryOrderId: "healthy-btc-entry-order",
      activeLegs: ["core"],
      baselineOpenOrderIds: [coreStop.orderId],
      coreStop,
      runnerStop: null,
      runnerCleanup: null,
    },
  };
  return { sourceSignalId, position, coreStop };
}

test("completed versionless impulse policy is repaired from fresh core-stop evidence without replaying old signals", async () => {
  const {
    store, exchange, snapshot, coreQty, coreStop, lastCloseFill, oldSignal,
  } = await completedCoreOnlyVersionlessFixture();
  const { broker, worker } = makeWorker(store, exchange);
  const positionReadOptions = [];
  const readPosition = broker.readPosition.bind(broker);
  broker.readPosition = async (symbol, options) => {
    positionReadOptions.push(options);
    return await readPosition(symbol, options);
  };
  store.data.pending = {
    sourceSignalId: oldSignal.sourceSignalId,
    body: oldSignal,
    status: "pending",
  };
  const mutationKinds = new Set([
    "placeSplitStop", "cancelOriginal", "cancelOriginalAfterRunnerFill",
    "closeSplitTranche", "cancelPartialStop", "closeSoleLeg",
  ]);
  const mutationsBefore = exchange.calls.filter(([kind]) =>
    mutationKinds.has(kind)).length;

  const result = await worker.runOnce();

  assert.equal(result.kind, "idle", JSON.stringify(result));
  const repaired = store.data.positions[0].snapshot;
  assert.equal(repaired.version, "bullet-long-exits-v2");
  assert.equal(repaired.entryPrice, 100);
  assert.equal(repaired.entryAt, snapshot.policy.entryAt);
  assert.equal(repaired.remainingQty, coreQty);
  assert.equal(repaired.coreOpen, true);
  assert.equal(repaired.runnerOpen, false);
  assert.equal(repaired.runnerQty, 0);
  assert.equal(repaired.runnerStopPrice, null);
  assert.equal(repaired.peakPct, 4);
  assert.equal(repaired.runnerPeakPct, 9);
  assert.deepEqual(repaired.lastCloseFill, lastCloseFill);
  assert.equal(repaired.split.stage, "complete");
  assert.equal(repaired.split.runnerStop, null);
  assert.equal(repaired.split.coreStop.orderId, coreStop.orderId);
  assert.equal(store.data.pending.status, "rejected",
    "an expired pending signal is retired rather than replayed during repair");
  assert.equal(exchange.calls.filter(([kind]) => mutationKinds.has(kind)).length,
    mutationsBefore, "repair and policy evaluation are read-only");
  assert.equal(positionReadOptions.length, 1);
  assert.equal(positionReadOptions[0]?.accountStateContext, undefined,
    "versionless policy restoration never consumes a shared account context");
  assert.equal(store.data.intents.filter((intent) =>
    intent.sourceSignalId === oldSignal.sourceSignalId).length, 0);
});

test("readPosition quote corroboration failure waits without ledger writes or trade commands", async () => {
  const fixture = await completedCoreOnlyVersionlessFixture();
  const before = structuredClone(fixture.snapshot);
  const { broker, worker } = makeWorker(fixture.store, fixture.exchange);
  let readPositionCalls = 0;
  broker.readPosition = async () => {
    readPositionCalls += 1;
    throw new Error("VST mark is not corroborated by a fresh quote");
  };
  const ledgerWrites = trackLedgerWrites(fixture.store);
  const mutationKinds = new Set([
    "placeSplitStop", "cancelOriginal", "cancelOriginalAfterRunnerFill",
    "closeSplitTranche", "cancelPartialStop", "closeSoleLeg",
  ]);
  const mutationsBefore = fixture.exchange.calls.filter(([kind]) =>
    mutationKinds.has(kind)).length;

  const result = await worker.runOnce();

  assert.equal(result.kind, "unknown");
  assert.equal(result.scope, "symbol");
  assert.equal(result.reason, "managed_position_read_unavailable");
  assert.equal(readPositionCalls, 1);
  assert.deepEqual(ledgerWrites, []);
  assert.deepEqual(fixture.store.data.positions[0].snapshot, before);
  assert.equal(fixture.exchange.calls.filter(([kind]) =>
    mutationKinds.has(kind)).length, mutationsBefore);
});

test("stale mark/ticker corroboration errors stay bounded to symbol-read isolation", async (t) => {
  for (const message of [
    "VST mark became stale before use",
    "VST mark or ticker became stale while reading the corroboration pair",
    "VST mark became stale while waiting for fresh ticker corroboration",
  ]) {
    await t.test(message, async () => {
      const fixture = await completedCoreOnlyVersionlessFixture();
      const before = structuredClone(fixture.snapshot);
      const { broker, worker } = makeWorker(fixture.store, fixture.exchange);
      broker.readPosition = async () => { throw new Error(message); };
      const ledgerWrites = trackLedgerWrites(fixture.store);
      const mutationKinds = new Set([
        "placeSplitStop", "cancelOriginal", "cancelOriginalAfterRunnerFill",
        "closeSplitTranche", "cancelPartialStop", "closeSoleLeg",
      ]);
      const mutationsBefore = fixture.exchange.calls.filter(([kind]) =>
        mutationKinds.has(kind)).length;

      const result = await worker.runOnce();
      assert.equal(result.kind, "unknown");
      assert.equal(result.scope, "symbol");
      assert.equal(result.reason, "managed_position_read_unavailable");
      assert.deepEqual(ledgerWrites, []);
      assert.deepEqual(fixture.store.data.positions[0].snapshot, before);
      assert.equal(fixture.exchange.calls.filter(([kind]) =>
        mutationKinds.has(kind)).length, mutationsBefore);
    });
  }
});

test("caught position GET error keeps its diagnostic ref through delayed owner alert without retry or writes", async () => {
  const fixture = await completedCoreOnlyVersionlessFixture();
  const alerts = [];
  const originalStderrWrite = process.stderr.write;
  const stderrLines = [];
  let now = NOW;
  const { broker, worker } = makeWorker(
    fixture.store, fixture.exchange, [SYMBOL], { environment: "vst" },
    () => now, false, FEATURES, async (info) => alerts.push(info),
  );
  const freshGetError = Object.assign(new Error("fresh VST position GET failed"), {
    name: "BingXLiveApiError",
    method: "GET",
    endpoint: "/openApi/swap/v2/user/positions",
    httpStatus: 503,
    transportStage: "transport",
  });
  let positionReads = 0;
  broker.readPosition = async () => {
    positionReads += 1;
    throw freshGetError;
  };
  const ledgerWrites = trackLedgerWrites(fixture.store);
  const mutationKinds = new Set([
    "placeSplitStop", "cancelOriginal", "cancelOriginalAfterRunnerFill",
    "closeSplitTranche", "cancelPartialStop", "closeSoleLeg",
  ]);
  const mutationsBefore = fixture.exchange.calls.filter(([kind]) =>
    mutationKinds.has(kind)).length;
  process.stderr.write = (line) => { stderrLines.push(String(line)); return true; };
  try {
    assert.equal((await worker.runOnce()).reason, "managed_position_read_unavailable");
    assert.equal(alerts.length, 0, "the existing delayed alert threshold remains in force");
    now += 5 * 60_000;
    assert.equal((await worker.runOnce()).reason, "managed_position_read_unavailable");
  } finally {
    process.stderr.write = originalStderrWrite;
  }
  assert.equal(positionReads, 2, "one fresh read per tick; no retry within a tick");
  assert.deepEqual(ledgerWrites, []);
  assert.equal(fixture.exchange.calls.filter(([kind]) =>
    mutationKinds.has(kind)).length, mutationsBefore);
  assert.equal(alerts.length, 1);
  const diagnostic = stderrLines.filter((line) =>
    line.startsWith("Bullet VST diagnostic: "))
    .map((line) => JSON.parse(line.slice("Bullet VST diagnostic: ".length)))
    .find((item) => item.reason === "exchange_transport_error");
  assert.ok(diagnostic);
  assert.equal(diagnostic.reason, "exchange_transport_error");
  assert.equal(diagnostic.stage, "positionManagement");
  assert.equal(diagnostic.operation, "read_position");
  assert.equal(diagnostic.check, "position_row");
  assert.equal(alerts[0].diagnosticRef, diagnostic.ref, JSON.stringify(alerts[0]));
  assert.match(formatVstBlockedAlert(alerts[0]), new RegExp(`\\[ref:${diagnostic.ref}\\]`));
});

test("pure entry proof refusal returns its logged ref without invoking exchange reads", async () => {
  const fixture = await completedCoreOnlyVersionlessFixture();
  const { broker } = makeWorker(fixture.store, fixture.exchange);
  const originalStderrWrite = process.stderr.write;
  const stderrLines = [];
  const callsBefore = fixture.exchange.calls.length;
  let result;
  process.stderr.write = (line) => { stderrLines.push(String(line)); return true; };
  try {
    result = await broker.verifyEntryOrderProof({
      clientOrderId: "",
      request: { operation: "entry", symbol: SYMBOL, sourceSignalId: SOURCE_ID },
      expectedPositionId: "",
      expectedOrderId: "",
      expectedQuantity: "1",
    });
  } finally {
    process.stderr.write = originalStderrWrite;
  }
  assert.deepEqual(
    { verified: result.verified, status: result.status },
    { verified: false, status: "unknown" },
  );
  const diagnosticRef = getVstResultDiagnosticRef(result);
  assert.match(diagnosticRef, /^[a-f0-9]{12}$/);
  assert.deepEqual(result, { verified: false, status: "unknown" });
  assert.equal(JSON.stringify(result).includes("diagnosticRef"), false);
  assert.equal(fixture.exchange.calls.length, callsBefore);
  const diagnostic = JSON.parse(stderrLines.find((line) =>
    line.startsWith("Bullet VST diagnostic: "))
    .slice("Bullet VST diagnostic: ".length));
  assert.equal(diagnosticRef, diagnostic.ref);
  assert.equal(diagnostic.reason, "entry_proof_missing");
  assert.equal(diagnostic.check, "entry_parent");
  assert.match(formatVstBlockedAlert({
    reason: "vst_worker_error", blockedForMs: 60_000,
    diagnosticRef,
  }), new RegExp(`\\[ref:${diagnosticRef}\\]`));
});

test("read-only position management reuses one fresh tick account snapshot", async () => {
  const { store, exchange } = await completeSplitFixture();
  exchange.calls.length = 0;
  exchange.setMarkPrice("104");
  const { worker } = makeWorker(store, exchange);

  const result = await worker.runOnce();

  assert.equal(result.kind, "idle", JSON.stringify(result));
  const globalPositionGets = exchange.calls.filter(([kind, symbol]) =>
    kind === "positions" && symbol === undefined).length;
  const globalOpenOrderGets = exchange.calls.filter(([kind, symbol]) =>
    kind === "openOrders" && symbol === undefined).length;
  assert.equal(globalPositionGets, 1,
    "the tick-wide positions GET also supplies the fresh position pre-read");
  assert.equal(globalOpenOrderGets, 1,
    "the tick-wide open-orders GET also supplies the fresh position pre-read");
  assert.equal(exchange.calls.filter(([kind, symbol]) =>
    kind === "positions" && symbol === SYMBOL).length, 0,
  "the one-shot verified raw account rows replace the scoped position GET");
  assert.equal(exchange.calls.filter(([kind, symbol]) =>
    kind === "openOrders" && symbol === SYMBOL).length, 0,
  "the one-shot verified raw account orders replace the scoped orders GET");
  assert.equal(exchange.calls.filter(([kind]) =>
    ["placeSplitStop", "cancelOriginal", "closeSplitTranche", "closeSoleLeg"]
      .includes(kind)).length, 0,
  "the optimization performs no exchange writes");
});

test("tick snapshot freshness includes delayed account-state response time", async () => {
  const { store, exchange } = await completeSplitFixture();
  exchange.calls.length = 0;
  exchange.setMarkPrice("104");
  const { broker, worker } = makeWorker(store, exchange);
  const readAccountState = broker.readAccountState.bind(broker);
  let accountStateReads = 0;
  broker.readAccountState = async (...args) => {
    accountStateReads += 1;
    const state = await readAccountState(...args);
    if (accountStateReads === 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_050));
    }
    return state;
  };

  const result = await worker.runOnce();

  assert.equal(result.kind, "idle", JSON.stringify(result));
  assert.equal(accountStateReads, 2,
    "the delayed tick-wide snapshot is refreshed before position proof");
  assert.equal(exchange.calls.filter(([kind, symbol]) =>
    kind === "positions" && symbol === undefined).length, 2);
  assert.equal(exchange.calls.filter(([kind, symbol]) =>
    kind === "openOrders" && symbol === undefined).length, 2);
  assert.equal(exchange.calls.filter(([kind, symbol]) =>
    kind === "positions" && symbol === SYMBOL).length, 0);
  assert.equal(exchange.calls.filter(([kind, symbol]) =>
    kind === "openOrders" && symbol === SYMBOL).length, 0);
});

test("a readPosition account context is followed by fresh account proof before an action", async () => {
  const { store, exchange } = await completeSplitFixture();
  exchange.calls.length = 0;
  exchange.setMarkPrice("105");
  const { broker, worker } = makeWorker(store, exchange);
  const events = [];
  const readAccountState = broker.readAccountState.bind(broker);
  broker.readAccountState = async (...args) => {
    const state = await readAccountState(...args);
    events.push({ kind: "readAccountState", state });
    return state;
  };
  const readPosition = broker.readPosition.bind(broker);
  broker.readPosition = async (symbol, options) => {
    const result = await readPosition(symbol, options);
    events.push({
      kind: "readPosition",
      usedAccountContext: options?.accountStateContext !== undefined,
    });
    return result;
  };
  const performIntent = broker.performIntent.bind(broker);
  broker.performIntent = async (...args) => {
    events.push({ kind: "performIntent" });
    return await performIntent(...args);
  };

  const result = await worker.runOnce();

  const positionObservationIndex = events.findIndex((event) =>
    event.kind === "readPosition" && event.usedAccountContext);
  assert.notEqual(positionObservationIndex, -1, JSON.stringify(result));
  const freshAccountAfterObservationIndex = events.findIndex((event, index) =>
    index > positionObservationIndex && event.kind === "readAccountState");
  assert.notEqual(freshAccountAfterObservationIndex, -1,
    "action handling obtains a new account snapshot after context-backed observation");
  const mutationIntentIndex = events.findIndex((event, index) =>
    index > positionObservationIndex && event.kind === "performIntent");
  assert.notEqual(mutationIntentIndex, -1, JSON.stringify(result));
  assert.ok(freshAccountAfterObservationIndex < mutationIntentIndex,
    "fresh account proof precedes any mutation intent");
  assert.equal(exchange.calls.filter(([kind]) =>
    ["positions", "openOrders"].includes(kind)).length > 0, true);
});

test("an aged shared account snapshot is refreshed before position proof and never authorizes mutation", async () => {
  const { store, exchange } = await completeSplitFixture();
  exchange.calls.length = 0;
  exchange.setMarkPrice("104");
  const { broker, worker } = makeWorker(store, exchange);
  const readAccountState = broker.readAccountState.bind(broker);
  let accountStateReads = 0;
  broker.readAccountState = async () => {
    accountStateReads += 1;
    const current = await readAccountState();
    // Model an account snapshot that no longer matches the exchange by the
    // time the slow position loop gets to it.
    return accountStateReads === 1
      ? { ...current, positions: [], openOrders: [] }
      : current;
  };
  const readPosition = broker.readPosition.bind(broker);
  let persistedPosition;
  broker.readPosition = async (symbol, options) => {
    persistedPosition = options?.persistedPosition;
    return await readPosition(symbol, options);
  };
  const listOpenPositions = store.listOpenPositions.bind(store);
  let delayedPositionListing = false;
  store.listOpenPositions = async () => {
    const positions = await listOpenPositions();
    if (!delayedPositionListing) {
      delayedPositionListing = true;
      await new Promise((resolve) => setTimeout(resolve, 2_100));
    }
    return positions;
  };

  const result = await worker.runOnce();

  assert.equal(result.kind, "idle", JSON.stringify(result));
  assert.equal(accountStateReads, 2,
    "the expired tick snapshot is refreshed rather than reused");
  assert.equal(exchange.calls.filter(([kind, symbol]) =>
    kind === "positions" && symbol === undefined).length, 2,
  "the global positions GET is repeated for the refreshed account proof");
  assert.equal(exchange.calls.filter(([kind, symbol]) =>
    kind === "openOrders" && symbol === undefined).length, 2,
  "the global open-orders GET is repeated for the refreshed account proof");
  assert.equal(exchange.calls.filter(([kind, symbol]) =>
    kind === "positions" && symbol === SYMBOL).length, 0);
  assert.equal(exchange.calls.filter(([kind, symbol]) =>
    kind === "openOrders" && symbol === SYMBOL).length, 0);
  assert.equal(persistedPosition?.verified, true,
    "readPosition receives proof built from the refreshed account snapshot");
  assert.equal(exchange.calls.filter(([kind]) =>
    ["placeSplitStop", "cancelOriginal", "closeSplitTranche", "closeSoleLeg"]
      .includes(kind)).length, 0,
  "stale account evidence did not authorize an exchange write");
});

test("a quote failure does not prevent checking a later healthy position", async () => {
  const fixture = await completedCoreOnlyVersionlessFixture();
  const { sourceSignalId, position, coreStop } =
    healthyBtcCoreOnlyPosition(fixture.snapshot);
  fixture.store.data.positions.push({
    sourceSignalId,
    symbol: "BTCUSDT",
    status: "open",
    snapshot: position,
  });
  const { broker, worker } = makeWorker(fixture.store, fixture.exchange);
  const readPositionSymbols = [];
  broker.readPosition = async (symbol) => {
    readPositionSymbols.push(symbol);
    if (symbol === SYMBOL) {
      throw new Error("VST mark is not corroborated by a fresh quote");
    }
    assert.equal(symbol, "BTCUSDT");
    return {
      verified: true,
      symbol,
      positionId: "healthy-btc-position-id",
      side: "Buy",
      leverage: 10,
      marginMode: "ISOLATED",
      quantity: "0.08",
      protectiveStops: {
        core: {
          verified: true,
          ...coreStop,
        },
      },
    };
  };
  broker.readMarketMark = async (symbol) => ({
    verified: true,
    symbol,
    price: "102",
    observedAt: new Date(NOW).toISOString(),
  });
  const ledgerWrites = trackLedgerWrites(fixture.store);

  const result = await worker.runOnce();

  assert.equal(result.kind, "unknown");
  assert.equal(result.scope, "symbol");
  assert.equal(result.reason, "managed_position_read_unavailable");
  assert.deepEqual(readPositionSymbols, [SYMBOL, "BTCUSDT"]);
  assert.equal(fixture.store.data.positions[0].snapshot.version, undefined,
    "the quote-failed position remains unrepaired");
  assert.equal(fixture.store.data.positions[1].snapshot.observedAt,
    new Date(NOW).toISOString(),
    "the later healthy position completed normal policy evaluation");
  assert.deepEqual(ledgerWrites, ["upsertPosition"],
    "only the healthy position's ordinary evaluation is persisted");
});

test("an unrelated fresh BTC candidate can prepare after another position's read quote failure", async () => {
  const fixture = await completeSplitFixture();
  const freshExchange = freshEntryExchange({ symbol: "BTCUSDT" });
  const { broker, worker } = makeFreshSignalWorker(
    fixture.store,
    freshExchange,
    ["BTCUSDT"],
    (base) => {
      const readPosition = base.readPosition.bind(base);
      return {
        ...base,
        async readPosition(symbol, options) {
          if (symbol === SYMBOL) {
            throw new Error("VST mark is not corroborated by a fresh quote");
          }
          return await readPosition(symbol, options);
        },
      };
    },
  );
  const freshSignal = confirmedImpulseSignal(
    "BTCUSDT", "fresh-btc-after-read-quote-failure",
  );
  assert.equal((await worker.enqueue(freshSignal)).kind, "new");
  const originalSnapshot = structuredClone(fixture.store.data.positions[0].snapshot);

  const result = await worker.runOnce();

  assert.equal(result.kind, "prepared", JSON.stringify(result));
  assert.deepEqual(fixture.store.data.positions[0].snapshot, originalSnapshot);
  assert.equal(freshExchange.writes.some(([kind]) => kind === "setLeverage10"), true);
  assert.equal(freshExchange.writes.some(([kind]) => kind === "placeEntry"), false,
    "the unrelated candidate reaches preparation without placing an entry this tick");
});

test("unreviewed readPosition errors still propagate", async () => {
  const fixture = await completedCoreOnlyVersionlessFixture();
  const { broker, worker } = makeWorker(fixture.store, fixture.exchange);
  const unexpected = new Error("unrelated_read_position_failure");
  broker.readPosition = async () => { throw unexpected; };

  await assert.rejects(worker.runOnce(), (error) => error === unexpected);
});

test("worker keeps a price-read warning cooldown across a brief verified position read", async () => {
  const fixture = await completedCoreOnlyVersionlessFixture();
  let at = NOW;
  let failing = true;
  const alerts = [];
  const nativeMarkRead = fixture.exchange.api.getVstMarkPrice;
  fixture.exchange.api.getVstMarkPrice = async (...args) => ({
    ...await nativeMarkRead(...args), timestamp: at,
  });
  const { broker, worker } = makeWorker(fixture.store, fixture.exchange,
    [SYMBOL], { environment: "vst" }, () => at, false, FEATURES,
    async (alert) => { alerts.push(alert); });
  const nativePositionRead = broker.readPosition.bind(broker);
  broker.readPosition = async (...args) => {
    if (failing) throw new Error("VST mark is not corroborated by a fresh quote");
    return nativePositionRead(...args);
  };
  await worker.runOnce();
  at += 301_000;
  await worker.runOnce();
  assert.equal(alerts.length, 1, "sustained read failure must still warn");
  failing = false;
  at += 1_000;
  await worker.runOnce();
  failing = true;
  at += 301_000;
  await worker.runOnce();
  assert.equal(alerts.length, 1, "a brief success must not permit another first warning");
  for (let i = 0; i < 3; i += 1) {
    failing = false;
    at += 60_000;
    await worker.runOnce();
  }
  failing = true;
  at += 1_000;
  await worker.runOnce();
  at += 301_000;
  await worker.runOnce();
  assert.equal(alerts.length, 2, "stable verified recovery allows a later genuine new incident");
});

test("a bounded transient managed-position GET failure is symbol-local and recovers next tick", async () => {
  const fixture = await completeSplitFixture();
  const template = {
    ...fixture.store.data.positions[0].snapshot,
    verifiedFill: {
      price: 100,
      quantity: 0.1,
      at: new Date(NOW - 1_000).toISOString(),
    },
  };
  const { sourceSignalId, position, coreStop } =
    healthyBtcCoreOnlyPosition(template);
  coreStop.stopPrice = "95";
  position.stopPrice = 95;
  position.coreStopPrice = 95;
  position.policy.stopPrice = 95;
  position.split.coreStop.stopPrice = "95";
  fixture.store.data.positions.push({
    sourceSignalId,
    symbol: "BTCUSDT",
    status: "open",
    snapshot: position,
  });
  let now = NOW;
  const alerts = [];
  const { broker, worker } = makeWorker(
    fixture.store,
    fixture.exchange,
    [SYMBOL, "BTCUSDT"],
    { environment: "vst" },
    () => now,
    false,
    FEATURES,
    async (alert) => alerts.push(alert),
  );
  const readPosition = broker.readPosition.bind(broker);
  const readSymbols = [];
  let transientFailures = 2;
  broker.readPosition = async (symbol, options) => {
    readSymbols.push(symbol);
    if (symbol === SYMBOL && transientFailures > 0) {
      transientFailures -= 1;
      const error = new Error("BingX exchange busy during GET");
      error.method = "GET";
      error.endpoint = "/openApi/swap/v2/user/positions";
      error.code = "exchange_busy";
      throw error;
    }
    if (symbol === "BTCUSDT") {
      return {
        verified: true,
        symbol,
        positionId: "healthy-btc-position-id",
        side: "Buy",
        leverage: 10,
        marginMode: "ISOLATED",
        quantity: "0.08",
        protectiveStops: {
          core: { verified: true, ...coreStop },
        },
      };
    }
    return await readPosition(symbol, options);
  };
  broker.readMarketMark = async (symbol) => ({
    verified: true,
    symbol,
    price: "100",
    observedAt: new Date(now).toISOString(),
  });
  const ledgerWrites = trackLedgerWrites(fixture.store);
  const statusChanges = [];
  const setSignalStatus = fixture.store.setSignalStatus.bind(fixture.store);
  fixture.store.setSignalStatus = async (...args) => {
    statusChanges.push(args);
    return setSignalStatus(...args);
  };

  const first = await worker.runOnce();
  assert.equal(first.kind, "unknown");
  assert.equal(first.scope, "symbol");
  assert.equal(first.symbol, SYMBOL);
  assert.equal(first.reason, "managed_position_read_unavailable");
  assert.equal(fixture.store.data.positions[0].status, "open");
  assert.deepEqual(statusChanges, []);
  assert.deepEqual(readSymbols.slice(0, 2), [SYMBOL, "BTCUSDT"]);
  const readsAfterFirstTick = readSymbols.length;
  assert.equal(fixture.store.data.positions[0].status, "open");
  assert.equal(fixture.store.data.positions[1].snapshot.observedAt,
    new Date(now).toISOString());

  now += 5 * 60_000 + 1;
  fixture.exchange.setClock(now);
  const repeated = await worker.runOnce();
  assert.equal(repeated.kind, "unknown");
  assert.deepEqual(readSymbols.slice(readsAfterFirstTick, readsAfterFirstTick + 2),
    [SYMBOL, "BTCUSDT"],
    JSON.stringify({
      readSymbols,
      readsAfterFirstTick,
      positionStatus: fixture.store.data.positions[0].status,
      intentStates: fixture.store.data.intents.map((intent) => intent.state),
      repeated,
    }));
  assert.match(alerts[0].diagnosticRef, /^[a-f0-9]{12}$/);
  assert.equal(alerts[0].diagnostic.symbol, SYMBOL);
  assert.equal(alerts[0].diagnostic.operation, "read_position");
  assert.equal(alerts[0].diagnostic.method, "GET");
  assert.equal(alerts[0].diagnostic.endpoint, "/openApi/swap/v2/user/positions");
  assert.deepEqual(alerts.map(({ diagnosticRef, diagnostic, ...alert }) => alert), [{
    reason: "managed_position_read_unavailable",
    sourceSignalId: fixture.store.data.positions[0].sourceSignalId,
    symbol: SYMBOL,
    operation: "read_position",
    scope: "symbol",
    blockedForMs: 5 * 60_000 + 1,
    count: 1,
  }]);

  now += 1;
  fixture.exchange.setClock(now);
  const readsBeforeRecovery = readSymbols.length;
  const recovered = await worker.runOnce();
  assert.equal(recovered.kind, "acted", JSON.stringify(recovered));
  assert.equal(recovered.operation, "close_leg");
  assert.equal(readSymbols[readsBeforeRecovery], SYMBOL);
  assert.equal(fixture.store.data.positions[0].snapshot.version,
    "bullet-long-exits-v2");
});

test("worker batches proven read failures without trading retries and reports only corroborated recovery", async () => {
  const fixture = await completeSplitFixture();
  const template = {
    ...fixture.store.data.positions[0].snapshot,
    verifiedFill: { price: 100, quantity: 0.1, at: new Date(NOW - 1000).toISOString() },
  };
  const { position, coreStop } = healthyBtcCoreOnlyPosition(template);
  coreStop.stopPrice = "95";
  position.stopPrice = position.coreStopPrice = position.policy.stopPrice = 95;
  position.split.coreStop.stopPrice = "95";
  fixture.store.data.positions = [SYMBOL, "BTCUSDT"].map((symbol) => {
    const snapshot = structuredClone(position);
    snapshot.symbol = snapshot.signalSnapshot.symbol = symbol;
    snapshot.sourceSignalId = snapshot.signalSnapshot.sourceSignalId = `read-group-${symbol}`;
    return { sourceSignalId: snapshot.sourceSignalId, symbol, status: "open", snapshot };
  });
  let now = NOW;
  const alerts = [];
  const { broker, worker } = makeWorker(
    fixture.store, fixture.exchange, [SYMBOL, "BTCUSDT"],
    { environment: "vst" }, () => now, false, FEATURES,
    async (alert) => alerts.push(alert),
  );
  let unavailable = true;
  const mutations = () => fixture.exchange.calls.filter(([name]) =>
    /^(place|cancel|close|sourceExitClose|addMargin|setLeverage|setMargin)/.test(name));
  const mutationsBefore = structuredClone(mutations());
  broker.readPosition = async (symbol) => {
    if (unavailable) {
      const error = Object.assign(new Error(`read timeout for ${symbol}`), {
        name: "BingXLiveApiError", method: "GET",
        endpoint: "/openApi/swap/v2/user/positions",
        transportStage: "network_request",
      });
      // The real instrumented API records this before the outer worker catch.
      recordVstDiagnostic(error, { stage: "positionManagement",
        apiMethod: "getPositions", operation: "read_position", check: "position_row", symbol });
      throw error;
    }
    return { verified: true, symbol, positionId: position.exchangePositionId,
      side: "Buy", leverage: 10, marginMode: "ISOLATED", quantity: "0.08",
      protectiveStops: { core: { verified: true, ...coreStop } } };
  };
  broker.readMarketMark = async (symbol) => ({
    verified: true, symbol, price: "100", observedAt: new Date(now).toISOString(),
  });
  assert.equal((await worker.runOnce()).kind, "unknown");
  assert.equal(alerts.length, 0);
  now += 5 * 60_000 + 1;
  fixture.exchange.setClock(now);
  assert.equal((await worker.runOnce()).kind, "unknown");
  assert.deepEqual(alerts.map((alert) => alert.incidentStatus), ["first"]);
  assert.deepEqual(alerts[0].symbols, ["BTCUSDT", "ETHUSDT"]);
  assert.equal(alerts[0].occurrences, 4);
  await worker.runOnce();
  assert.equal(alerts.length, 1);
  unavailable = false;
  await worker.runOnce();
  assert.deepEqual(alerts.map((alert) => alert.incidentStatus), ["first"],
    "one corroborated read is not stable recovery");
  for (let i = 0; i < 2; i += 1) {
    now += 60_000;
    fixture.exchange.setClock(now);
    await worker.runOnce();
  }
  assert.deepEqual(alerts.map((alert) => alert.incidentStatus), ["first", "recovered"]);
  assert.deepEqual(mutations(), mutationsBefore,
    "notification grouping and successful observations never replay exchange writes");
});

test("a later tick resumes normal repair after readPosition quote corroboration recovers", async () => {
  const fixture = await completedCoreOnlyVersionlessFixture();
  const before = structuredClone(fixture.snapshot);
  const { broker, worker } = makeWorker(fixture.store, fixture.exchange);
  const readPosition = broker.readPosition.bind(broker);
  let readPositionCalls = 0;
  broker.readPosition = async (...args) => {
    readPositionCalls += 1;
    if (readPositionCalls === 1) {
      throw new Error("VST mark is not corroborated by a fresh quote");
    }
    return await readPosition(...args);
  };
  const ledgerWrites = trackLedgerWrites(fixture.store);

  const first = await worker.runOnce();

  assert.equal(first.kind, "unknown");
  assert.equal(first.scope, "symbol");
  assert.equal(first.reason, "managed_position_read_unavailable");
  assert.deepEqual(fixture.store.data.positions[0].snapshot, before);
  assert.deepEqual(ledgerWrites, []);

  const second = await worker.runOnce();

  assert.equal(second.kind, "idle", JSON.stringify(second));
  assert.equal(readPositionCalls, 2);
  assert.equal(fixture.store.data.positions[0].snapshot.version,
    "bullet-long-exits-v2");
  assert.deepEqual(ledgerWrites, ["upsertPosition", "upsertPosition"],
    "the next tick persists the policy repair and then the normal evaluated state");
});

for (const mismatch of [
  {
    name: "wrong account identity",
    mutate({ snapshot }) {
      snapshot.accountId = "different-vst-account";
    },
  },
  {
    name: "changed live position quantity",
    mutate({ exchange }) {
      exchange.setPositionQuantity("0.07");
    },
  },
  {
    name: "changed live core stop",
    mutate({ exchange, coreStop, coreQty }) {
      exchange.setOrderSet([
        exactStop(exchange, coreStop.orderId, coreQty, "96"),
      ]);
    },
  },
  {
    name: "extra same-symbol open order",
    mutate({ exchange, coreStop, coreQty }) {
      exchange.setOrderSet([
        exactStop(exchange, coreStop.orderId, coreQty, coreStop.stopPrice),
        openStop("unexpected-extra-stop", "0.001", "90"),
      ]);
    },
  },
  {
    name: "missing fresh account/order read proof",
    mutate({ exchange }) {
      exchange.api.getOpenOrders = async () => {
        throw new Error("simulated_unavailable_open_order_read");
      };
    },
  },
]) {
  test(`versionless policy recovery refuses repair on ${mismatch.name}`, async () => {
    const fixture = await completedCoreOnlyVersionlessFixture();
    mismatch.mutate(fixture);
    const snapshotBefore = structuredClone(fixture.snapshot);
    const upserts = [];
    const upsertPosition = fixture.store.upsertPosition;
    fixture.store.upsertPosition = async (position) => {
      upserts.push(structuredClone(position));
      return await upsertPosition(position);
    };
    const mutationKinds = new Set([
      "placeSplitStop", "cancelOriginal", "cancelOriginalAfterRunnerFill",
      "closeSplitTranche", "cancelPartialStop", "closeSoleLeg",
    ]);
    const mutationsBefore = fixture.exchange.calls.filter(([kind]) =>
      mutationKinds.has(kind)).length;

    if (mismatch.name === "missing fresh account/order read proof") {
      await assert.rejects(
        fixture.worker.runOnce(),
        /simulated_unavailable_open_order_read/,
      );
    } else {
      await fixture.worker.runOnce();
    }

    assert.equal(fixture.store.data.positions[0].snapshot.version, undefined);
    assert.deepEqual(fixture.store.data.positions[0].snapshot, snapshotBefore);
    assert.equal(upserts.length, 0, "unverified state must not reach position persistence");
    assert.equal(fixture.exchange.calls.filter(([kind]) =>
      mutationKinds.has(kind)).length, mutationsBefore,
    "mismatched evidence must not cause exchange mutations");
  });
}

test("versionless policy recovery leaves the snapshot unchanged when normal persistence fails", async () => {
  const fixture = await completedCoreOnlyVersionlessFixture();
  const snapshotBefore = structuredClone(fixture.snapshot);
  let repairAttempted = false;
  fixture.store.upsertPosition = async (position) => {
    if (position.version === "bullet-long-exits-v2") {
      repairAttempted = true;
      throw new Error("simulated_position_store_failure");
    }
    throw new Error("unexpected_non-repair_position_write");
  };
  const mutationKinds = new Set([
    "placeSplitStop", "cancelOriginal", "cancelOriginalAfterRunnerFill",
    "closeSplitTranche", "cancelPartialStop", "closeSoleLeg",
  ]);
  const mutationsBefore = fixture.exchange.calls.filter(([kind]) =>
    mutationKinds.has(kind)).length;

  await fixture.worker.runOnce();

  assert.equal(repairAttempted, true);
  assert.equal(fixture.store.data.positions[0].snapshot.version, undefined);
  assert.deepEqual(fixture.store.data.positions[0].snapshot, snapshotBefore);
  assert.equal(fixture.exchange.calls.filter(([kind]) =>
    mutationKinds.has(kind)).length, mutationsBefore);
});

test("invalid local impulse policy does not block a fresh unrelated symbol candidate", async () => {
  const fixture = await completedCoreOnlyVersionlessFixture();
  fixture.snapshot.policy.version = "unsupported-saved-policy";
  const freshExchange = freshEntryExchange({ symbol: "BTCUSDT" });
  const { worker } = makeWorker(
    fixture.store, freshExchange, [SYMBOL, "BTCUSDT"], {
      environment: "vst",
      maxQuoteAgeMs: 10_000,
      maxSlippageBps: 1_000,
    },
  );
  const freshSignal = confirmedImpulseSignal("BTCUSDT", "unrelated-fresh-btc-signal");
  assert.equal((await fixture.store.enqueue(freshSignal)).kind, "new");

  const result = await worker.runOnce();

  assert.equal(result.kind, "prepared", JSON.stringify(result));
  assert.equal(freshExchange.writes.some(([kind]) => kind === "setLeverage10"), true);
  assert.equal(fixture.store.data.positions[0].snapshot.version, undefined,
    "the invalid local policy remains unrepaired while the unrelated candidate proceeds");
});

test("worker and real VST broker complete impulse core/runner split from mocked exchange facts", async () => {
  const store = durableStore(splitSnapshot());
  const exchange = mockExchange();
  const { worker } = makeWorker(store, exchange);

  const completed = await worker.runOnce();
  assert.equal(completed.kind, "acted",
    `split phases must reconcile through the broker; actual=${JSON.stringify(completed)}, ` +
    `brokerError=${exchange.lastBrokerError}`);
  assert.equal(completed.operation, "cancel_original_stop");
  const coreRequest = store.data.intents.find((row) =>
    row.request.operation === "split_core_stop").request;
  assert.equal(coreRequest.coreQuantity, "0.08");
  assert.equal(coreRequest.runnerQuantity, "0.02");
  assert.equal(coreRequest.persistedPosition.verified, true);
  assert.deepEqual(coreRequest.persistedPosition.originalStop, {
    verified: true,
    positionId: "position-1",
    orderId: "attached-entry-stop",
    quantity: "0.1",
    stopPrice: "95",
    tranche: "original",
  });
  assert.deepEqual(exchange.calls.find(([kind]) => kind === "placeSplitStop")[1], {
    symbol: SYMBOL,
    policy: exchange.calls.find(([kind]) => kind === "placeSplitStop")[1].policy,
    quantity: "0.08",
    stopPrice: "95",
    positionId: "position-1",
    originalStopOrderId: "attached-entry-stop",
    originalStopPrice: "95",
    entryOrderId: "entry-order-1",
    totalQuantity: "0.1",
    tranche: "core",
    breakEvenPrice: "100",
    existingReplacementStops: [],
    baselineOpenOrderIds: ["attached-entry-stop"],
    createdAt: NOW - 500,
    quantityPrecision: 3,
    pricePrecision: 2,
    sourceSignalId: SOURCE_ID,
    signal,
  });
  assert.equal(store.data.intents.find((row) =>
    row.request.operation === "split_core_stop").state, "reconciled");
  assert.equal(store.data.positions[0].snapshot.split.stage, "complete");
  assert.equal(store.data.positions[0].snapshot.split.coreStop.orderId, "split-core-stop");

  const runnerRequest = store.data.intents.find((row) =>
    row.request.operation === "split_runner_stop").request;
  assert.equal(runnerRequest.coreStop.orderId, "split-core-stop");
  assert.equal(runnerRequest.persistedPosition.verified, true);
  assert.equal(exchange.calls.find(([kind, request]) =>
    kind === "placeSplitStop" && request.tranche === "runner")[1].quantity, "0.02");

  const cancelRequest = store.data.intents.find((row) =>
    row.request.operation === "cancel_original_stop").request;
  assert.equal(cancelRequest.coreStop.orderId, "split-core-stop");
  assert.equal(cancelRequest.runnerStop.orderId, "split-runner-stop");
  assert.deepEqual(exchange.orders.map((row) => row.orderId).sort(), [
    "split-core-stop", "split-runner-stop",
  ]);
  assert.equal(store.data.positions[0].snapshot.split.stage, "complete");
  assert.equal(store.data.status, "open");
  assert.deepEqual(exchange.calls.filter(([kind]) =>
    ["placeSplitStop", "cancelOriginal"].includes(kind)).map(([kind, request]) =>
    kind === "placeSplitStop" ? `split_${request.tranche}_stop` : "cancel_original_stop"),
  ["split_core_stop", "split_runner_stop", "cancel_original_stop"]);
  assert.ok(store.data.events.some(([, eventKind, detail]) =>
    eventKind === "vst_impulse_split_phase_verified" &&
    detail.operation === "cancel_original_stop"));
});

test("durable unknown split intent reconciles from exchange state after worker and broker restart", async () => {
  const store = durableStore(splitSnapshot());
  const exchange = mockExchange({ ambiguousCorePost: true });
  let { worker, broker } = makeWorker(store, exchange);

  const firstAttempt = await worker.runOnce();
  assert.equal(firstAttempt.kind, "unknown");
  const ambiguous = store.data.intents.find((row) =>
    row.request.operation === "split_core_stop");
  assert.equal(ambiguous.state, "unknown");
  assert.equal(exchange.lastBrokerError, "simulated_lost_core_stop_acknowledgement");
  assert.equal(exchange.calls.filter(([kind]) => kind === "placeSplitStop").length, 1);
  assert.deepEqual(exchange.orders.map((row) => row.orderId).sort(), [
    "attached-entry-stop", "split-core-stop",
  ]);

  // Simulate process restart: retain only durable store + exchange state, and
  // construct a fresh broker/worker with no mutation-local knowledge.
  ({ worker, broker } = makeWorker(store, exchange));
  assert.notEqual(broker, undefined);
  const recovered = await worker.runOnce();
  assert.equal(recovered.kind, "acted");
  assert.equal(recovered.operation, "cancel_original_stop");
  assert.equal(exchange.calls.filter(([kind]) => kind === "placeSplitStop").length, 2);
  assert.equal(exchange.calls.filter(([kind, request]) =>
    kind === "placeSplitStop" && request.tranche === "core").length, 1,
  "restarted worker must reconstruct the accepted core stop rather than POST it again");
  assert.equal(ambiguous.state, "reconciled");
  assert.equal(ambiguous.exchangeOrderId, "split-core-stop");
  assert.equal(store.data.positions[0].snapshot.split.stage, "complete");
  const cancelRequest = store.data.intents.find((row) =>
    row.request.operation === "cancel_original_stop").request;
  assert.equal(cancelRequest.coreStop.orderId, "split-core-stop");
  assert.equal(cancelRequest.runnerStop.orderId, "split-runner-stop");
  assert.deepEqual(exchange.orders.map((row) => row.orderId).sort(), [
    "split-core-stop", "split-runner-stop",
  ]);
  assert.equal(store.data.positions[0].snapshot.split.stage, "complete");
});

test("worker advances a core-pending ledger from exact open evidence when history positionID is zero", async () => {
  let currentTime = NOW;
  const store = durableStore(splitSnapshot());
  const exchange = mockExchange({
    ambiguousCorePost: true,
    coreHistoryPositionIdZero: true,
  });
  const { worker } = makeWorker(
    store, exchange, [SYMBOL], { environment: "vst" }, () => currentTime,
  );

  const submitted = await worker.runOnce();
  assert.equal(submitted.kind, "unknown");
  const coreIntent = store.data.intents.find((row) =>
    row.request.operation === "split_core_stop");
  assert.equal(coreIntent.state, "unknown");
  assert.equal(store.data.positions[0].snapshot.split.stage, "core_pending");
  assert.equal(exchange.calls.filter(([kind, request]) =>
    kind === "placeSplitStop" && request.tranche === "core").length, 1);

  // Keep the follow-up runner phase from writing in this test: recovery itself
  // must be read-only, while its transaction may advance only the proven core.
  exchange.setMarkPrice("99");
  currentTime += 30_000;
  exchange.setClock(currentTime);
  await worker.runOnce();

  assert.equal(coreIntent.state, "reconciled");
  assert.equal(coreIntent.exchangeOrderId, "split-core-stop");
  assert.equal(store.data.positions[0].snapshot.split.stage, "runner_pending");
  assert.equal(store.data.positions[0].snapshot.split.coreStop.orderId,
    "split-core-stop");
  assert.equal(exchange.calls.filter(([kind, request]) =>
    kind === "placeSplitStop" && request.tranche === "core").length, 1,
  "exact read-only recovery must not POST the already-open core stop again");
  assert.equal(exchange.calls.some(([kind]) =>
    ["cancelOriginal", "cancelOriginalAfterRunnerFill"].includes(kind)), false,
  "recovery must not DELETE either protective stop");
  assert.equal(exchange.calls.filter(([kind, request]) =>
    kind === "placeSplitStop" && request.tranche === "runner").length, 0,
  "the blocked follow-up phase must not write during this recovery proof");
});

test("natural runner child fill preserves fees and trigger identity, then restart removes only stale original stop", async () => {
  const { store, exchange } = await completeSplitFixture({
    ambiguousRunnerCleanup: true,
  });
  const saved = store.data.positions[0].snapshot;
  const originalId = saved.split.originalStopOrderId;
  const coreStop = saved.split.coreStop;
  const runnerStop = saved.split.runnerStop;
  const runnerChildId = "runner-child-fill-90071992547409931234";
  const childOrder = {
    symbol: SYMBOL_NAME,
    orderId: runnerChildId,
    mainOrderId: runnerStop.orderId,
    type: "STOP_MARKET",
    status: "FILLED",
    side: "SELL",
    positionSide: "LONG",
    positionId: "position-1",
    positionID: "position-1",
    origQty: "0.02",
    executedQty: "0.02",
    stopPrice: "100",
  };
  const parentOrder = {
    ...exactStop(exchange, runnerStop.orderId, "0.02", "100"),
    status: "FILLED",
    executedQty: "0.02",
  };
  exchange.saveHistory(parentOrder);
  exchange.saveHistory(childOrder);
  const parentLookupAlias = {
    ...childOrder,
    positionId: 0,
    positionID: 0,
  };
  // The parent lookup may alias the filled child and expose BingX's zero
  // position-ID sentinel. A separate child-ID lookup returns the exact
  // position identity needed for lossless cleanup reconciliation.
  exchange.queueQueryOrder(runnerStop.orderId, parentLookupAlias, parentLookupAlias);
  exchange.queueQueryOrder(runnerChildId, childOrder);
  exchange.setPositionQuantity("0.08");
  exchange.setOrderSet([
    exactStop(exchange, originalId, "0.08", "95"),
    exactStop(exchange, coreStop.orderId, "0.08", "95"),
  ]);
  exchange.saveFill({
    symbol: SYMBOL_NAME,
    orderId: runnerChildId,
    triggerOrderId: runnerStop.orderId,
    side: "SELL",
    positionSide: "LONG",
    volume: "0.02",
    price: "100",
    commission: "-0.012",
    currency: "VST",
    filledTm: NOW,
  });

  let { worker } = makeWorker(store, exchange);
  const observed = await worker.runOnce();
  assert.equal(observed.kind, "acted", JSON.stringify(observed));
  assert.equal(observed.operation, "observe_triggered_stop");
  let state = store.data.positions[0].snapshot;
  assert.equal(state.split.stage, "runner_cleanup_pending");
  assert.equal(state.split.runnerCleanup.childOrderId, runnerChildId);
  assert.equal(state.split.runnerCleanup.fill.orderId, runnerChildId);
  assert.equal(state.split.runnerCleanup.fill.triggerOrderId, runnerStop.orderId);
  const persistedRunnerFillAt = Date.parse(state.split.runnerCleanup.fill.at);
  assert.ok(Number.isSafeInteger(persistedRunnerFillAt));
  assert.ok(persistedRunnerFillAt <= NOW);
  assert.ok(NOW - persistedRunnerFillAt <= 23 * 60 * 60_000);
  assert.deepEqual(state.split.runnerCleanup.fill.fee, {
    asset: "VST",
    amount: "-0.012",
  });
  assert.equal(Number(state.persistedPosition.quantity), 0.08);
  assert.equal(state.persistedPosition.protectiveStops.core.orderId, coreStop.orderId);
  assert.equal(state.persistedPosition.originalStop.orderId, originalId);
  assert.deepEqual(exchange.orders.map((row) => ({
    orderId: row.orderId,
    quantity: row.origQty,
    stopPrice: row.stopPrice,
  })).sort((a, b) => a.orderId.localeCompare(b.orderId)), [
    { orderId: coreStop.orderId, quantity: "0.08", stopPrice: "95" },
    { orderId: originalId, quantity: "0.08", stopPrice: "95" },
  ].sort((a, b) => a.orderId.localeCompare(b.orderId)));
  assert.equal(exchange.calls.filter(([kind]) =>
    kind === "cancelOriginalAfterRunnerFill").length, 0);

  const ambiguousCleanup = await worker.runOnce();
  assert.equal(ambiguousCleanup.reason,
    "impulse_runner_cleanup_requires_reconciliation", JSON.stringify(ambiguousCleanup));
  const cleanupIntent = store.data.intents.find((row) =>
    row.request.operation === "cancel_original_after_runner_fill");
  assert.ok(cleanupIntent, JSON.stringify({
    result: ambiguousCleanup,
    intents: store.data.intents,
    status: store.data.status,
    reason: store.data.reason,
  }));
  assert.equal(cleanupIntent.state, "unknown");
  assert.equal(exchange.calls.filter(([kind]) =>
    kind === "cancelOriginalAfterRunnerFill").length, 1);
  assert.deepEqual(exchange.orders.map((row) => row.orderId), [coreStop.orderId]);

  // A new worker and broker recover cancellation evidence without submitting
  // the original-stop cancellation a second time.
  exchange.setMarkPrice("102");
  ({ worker } = makeWorker(store, exchange));
  const recovered = await worker.runOnce();
  assert.notEqual(recovered.kind, "unknown", JSON.stringify(recovered));
  state = store.data.positions[0].snapshot;
  assert.equal(cleanupIntent.state, "reconciled");
  assert.equal(state.split.stage, "complete");
  assert.equal(state.split.runnerCleanup, null);
  assert.equal(state.runnerOpen, false);
  assert.equal(state.coreOpen, true);
  assert.equal(state.remainingQty, 0.08);
  assert.equal(Number(state.persistedPosition.quantity), 0.08);
  assert.equal(state.persistedPosition.protectiveStops.core.orderId, coreStop.orderId);
  assert.equal(state.persistedPosition.originalStop, undefined);
  assert.deepEqual(exchange.orders.map((row) => ({
    orderId: row.orderId,
    quantity: row.origQty,
    stopPrice: row.stopPrice,
  })), [{ orderId: coreStop.orderId, quantity: "0.08", stopPrice: "95" }]);
  assert.equal(exchange.calls.filter(([kind]) =>
    kind === "cancelOriginalAfterRunnerFill").length, 1);
});

test("unknown runner split recovers a filled parent omitted from history and atomically starts cleanup", async () => {
  const store = durableStore(splitSnapshot());
  const exchange = mockExchange({ runnerStopFillsDuringPlacement: true });
  let { worker } = makeWorker(store, exchange);

  const failedPlacement = await worker.runOnce();
  assert.equal(failedPlacement.kind, "unknown");
  const runnerIntent = store.data.intents.find((row) =>
    row.request.operation === "split_runner_stop");
  assert.equal(runnerIntent.state, "unknown");
  assert.equal(exchange.history.some((row) =>
    row.orderId === "split-runner-stop"), false,
  "the parent is absent from order history; only its child is listed");

  ({ worker } = makeWorker(store, exchange));
  const recovered = await worker.runOnce();
  assert.equal(recovered.kind, "acted", JSON.stringify({
    recovered,
    evidence: exchange.lastBrokerEvidence,
    reason: store.data.reason,
    position: store.data.positions[0],
  }));
  assert.equal(recovered.operation, "observe_triggered_stop");
  assert.equal(runnerIntent.state, "reconciled");
  assert.equal(runnerIntent.exchangeOrderId, "runner-child-race-fill");
  let state = store.data.positions[0].snapshot;
  assert.equal(state.split.stage, "runner_cleanup_pending");
  assert.equal(state.split.runnerCleanup.parentStopId, "split-runner-stop");
  assert.equal(state.split.runnerCleanup.childOrderId, "runner-child-race-fill");
  assert.equal(state.split.runnerCleanup.fill.orderId, "runner-child-race-fill");
  assert.equal(state.split.runnerCleanup.fill.triggerOrderId, "split-runner-stop");
  const persistedRunnerFillAt = Date.parse(state.split.runnerCleanup.fill.at);
  assert.ok(Number.isSafeInteger(persistedRunnerFillAt));
  assert.ok(persistedRunnerFillAt <= NOW);
  assert.ok(NOW - persistedRunnerFillAt <= 23 * 60 * 60_000);
  assert.equal(state.remainingQty, 0.08);
  assert.equal(state.runnerOpen, false);
  assert.equal(Number(state.persistedPosition.quantity), 0.08);
  assert.equal(exchange.calls.filter(([kind, request]) =>
    kind === "placeSplitStop" && request.tranche === "runner").length, 1);
  assert.equal(exchange.calls.filter(([kind]) =>
    kind === "cancelOriginalAfterRunnerFill").length, 0);

  const cleanup = await worker.runOnce();
  assert.equal(cleanup.kind, "acted", JSON.stringify(cleanup));
  assert.equal(cleanup.operation, "cancel_original_after_runner_fill");
  state = store.data.positions[0].snapshot;
  assert.equal(state.split.stage, "complete");
  assert.equal(exchange.calls.filter(([kind]) =>
    kind === "cancelOriginalAfterRunnerFill").length, 1);
});

test("unknown runner split stays unresolved without exact parent/fill linkage", async () => {
  const store = durableStore(splitSnapshot());
  const exchange = mockExchange({
    runnerStopFillsDuringPlacement: true,
    ambiguousRunnerStopFill: true,
  });
  let { worker } = makeWorker(store, exchange);

  const failedPlacement = await worker.runOnce();
  assert.equal(failedPlacement.kind, "unknown");
  const runnerIntent = store.data.intents.find((row) =>
    row.request.operation === "split_runner_stop");
  ({ worker } = makeWorker(store, exchange));
  const recovery = await worker.runOnce();
  assert.equal(recovery.kind, "blocked");
  assert.equal(recovery.reason, "unresolved_vst_order_intents");
  assert.equal(runnerIntent.state, "unknown");
  assert.equal(store.data.positions[0].snapshot.split.stage, "runner_pending");
  assert.equal(exchange.calls.filter(([kind, request]) =>
    kind === "placeSplitStop" && request.tranche === "runner").length, 1);
  assert.equal(exchange.calls.filter(([kind]) =>
    kind === "cancelOriginalAfterRunnerFill").length, 0);
});

test("second pre-DELETE runner cancellation recovery uses a distinct intent and never retries an ambiguous DELETE", async () => {
  const recoveryAttempt = 2;
  const { store, exchange } = await completeSplitFixture({
    ambiguousRunnerCleanup: true,
  });
  const snapshot = store.data.positions[0].snapshot;
  const childOrderId = "runner-child-predelete-recovery";
  const runnerStop = snapshot.split.runnerStop;
  const originalStopId = snapshot.split.originalStopOrderId;
  const coreStop = snapshot.split.coreStop;
  const runnerFillAt = new Date(NOW - 60_000).toISOString();
  const runnerFill = {
    orderId: childOrderId,
    triggerOrderId: runnerStop.orderId,
    price: "100",
    quantity: "0.02",
    at: runnerFillAt,
    fee: { asset: "VST", amount: "-0.012" },
  };
  const cleanup = {
    stage: "cancel_original_pending",
    parentStopId: runnerStop.orderId,
    childOrderId,
    runnerQuantity: "0.02",
    remainingQuantity: "0.08",
    originalStopOrderId: originalStopId,
    coreStopOrderId: coreStop.orderId,
    originalStop: {
      orderId: originalStopId,
      quantity: "0.08",
      stopPrice: "95",
    },
    coreStop: { ...coreStop, quantity: "0.08" },
    fill: runnerFill,
    startedAt: NOW - 60_000,
    recoveryPhase: `impulse-runner-cancel-recovery-${childOrderId}`,
  };
  const residualCore = { ...coreStop, quantity: "0.08" };
  const residualOriginal = {
    orderId: originalStopId,
    quantity: "0.08",
    stopPrice: "95",
  };
  Object.assign(snapshot, {
    status: "closing",
    executionStatus: "impulse_runner_fill_cleanup_pending",
    coreOpen: true,
    coreQty: 0.08,
    runnerOpen: false,
    runnerQty: 0,
    remainingQty: 0.08,
    lastCloseFill: runnerFill,
    persistedPosition: {
      verified: true,
      environment: "vst",
      accountId: ACCOUNT,
      symbol: SYMBOL,
      positionId: snapshot.exchangePositionId,
      quantity: "0.08",
      protectiveStops: {
        core: {
          verified: true,
          orderId: coreStop.orderId,
          positionId: snapshot.exchangePositionId,
          quantity: "0.08",
          stopPrice: "95",
        },
      },
      originalStop: {
        verified: true,
        ...residualOriginal,
        positionId: snapshot.exchangePositionId,
      },
    },
    split: {
      ...snapshot.split,
      stage: "runner_cleanup_pending",
      coreStop: residualCore,
      runnerCleanup: cleanup,
      baselineOpenOrderIds: [originalStopId, coreStop.orderId].sort(),
    },
  });
  store.data.positions[0].status = "closing";
  exchange.setPositionQuantity("0.08");
  exchange.setOrderSet([
    exactStop(exchange, originalStopId, "0.08", "95"),
    exactStop(exchange, coreStop.orderId, "0.08", "95"),
  ]);

  const childOrder = {
    symbol: SYMBOL_NAME,
    orderId: childOrderId,
    mainOrderId: runnerStop.orderId,
    type: "STOP_MARKET",
    status: "FILLED",
    side: "SELL",
    positionSide: "LONG",
    workingType: "MARK_PRICE",
    positionId: snapshot.exchangePositionId,
    positionID: snapshot.exchangePositionId,
    origQty: "0.02",
    executedQty: "0.02",
    stopPrice: "100",
    time: NOW - 60_000,
  };
  const parentLookupAlias = {
    ...childOrder,
    positionId: 0,
    positionID: 0,
  };
  const filledParent = {
    ...exactStop(exchange, runnerStop.orderId, "0.02", "100"),
    status: "FILLED",
    executedQty: "0.02",
  };
  exchange.saveHistory(filledParent);
  exchange.saveHistory(childOrder);
  exchange.queueQueryOrder(runnerStop.orderId, parentLookupAlias);
  exchange.queueQueryOrder(childOrderId, childOrder);
  // BingX's fill row can link the child and trigger without carrying
  // positionID; the separate exact child-order lookup supplies that identity.
  exchange.saveFill({
    symbol: SYMBOL_NAME,
    orderId: childOrderId,
    triggerOrderId: runnerStop.orderId,
    side: "SELL",
    positionSide: "LONG",
    volume: "0.02",
    price: "100",
    commission: "-0.012",
    currency: "VST",
    filledTm: NOW - 60_000,
  });

  const originalPriorPosition = structuredClone(snapshot);
  delete originalPriorPosition.split.runnerCleanup.recoveryPhase;
  const oldPhase = `impulse-runner-cancel-original-${childOrderId}`;
  const oldClientOrderId = `vst-${createHash("sha256")
    .update(`${SOURCE_ID}:${oldPhase}`).digest("hex").slice(0, 30)}`;
  const oldIntent = {
    sourceSignalId: SOURCE_ID,
    phase: oldPhase,
    clientOrderId: oldClientOrderId,
    state: "unknown",
    outcome: {
      submissionError: "BingXLiveApiError",
      submissionErrorMessage:
        "VST runner parent order is not an exact verified 20% BE stop fill",
    },
    request: {
      operation: "cancel_original_after_runner_fill",
      environment: "vst",
      accountId: ACCOUNT,
      sourceSignalId: SOURCE_ID,
      symbol: SYMBOL,
      positionId: snapshot.exchangePositionId,
      runnerStopOrderId: runnerStop.orderId,
      runnerChildOrderId: childOrderId,
      originalStopOrderId: originalStopId,
      coreStopOrderId: coreStop.orderId,
      totalQuantity: "0.1",
      remainingQuantity: "0.08",
      signalStopPrice: "95",
      breakEvenPrice: "100",
      intentId: oldClientOrderId,
      priorPosition: originalPriorPosition,
    },
  };
  oldIntent.state = "failed";
  oldIntent.outcome = {
    ...oldIntent.outcome,
    status: "pre_transport_refused_no_delete",
    recoveryPhase: `impulse-runner-cancel-recovery-${childOrderId}`,
  };
  const recoveryPhase = `impulse-runner-cancel-recovery-${childOrderId}`;
  const recoveryClientOrderId = `vst-${createHash("sha256")
    .update(`${SOURCE_ID}:${recoveryPhase}`).digest("hex").slice(0, 30)}`;
  const firstRecoveryIntent = {
    sourceSignalId: SOURCE_ID,
    phase: recoveryPhase,
    clientOrderId: recoveryClientOrderId,
    state: "unknown",
    outcome: {
      error: "BingXLiveApiError",
      errorMessage:
        "VST runner fill history does not uniquely link to its exact parent stop",
    },
    request: {
      operation: "cancel_original_after_runner_fill",
      environment: "vst",
      accountId: ACCOUNT,
      sourceSignalId: SOURCE_ID,
      symbol: SYMBOL,
      positionId: snapshot.exchangePositionId,
      runnerStopOrderId: runnerStop.orderId,
      runnerChildOrderId: childOrderId,
      originalStopOrderId: originalStopId,
      coreStopOrderId: coreStop.orderId,
      totalQuantity: "0.1",
      remainingQuantity: "0.08",
      signalStopPrice: "95",
      breakEvenPrice: "100",
      intentId: recoveryClientOrderId,
      priorPosition: structuredClone(snapshot),
    },
  };
  store.data.intents.push(oldIntent, firstRecoveryIntent);
  const recoveries = [];
  store.recoverPreTransportRunnerCancel = async (args) => {
    const position = store.data.positions.find((row) =>
      row.sourceSignalId === args.sourceSignalId);
    const intent = store.data.intents.find((row) =>
      row.clientOrderId === args.clientOrderId);
    assert.ok(position && intent);
    assert.equal(intent.state, "unknown");
    assert.equal(args.recoveryAttempt, recoveryAttempt);
    assert.equal(intent.request, args.expectedRequest);
    assert.equal(position.snapshot, args.expectedSnapshot);
    position.snapshot = args.recoveryPosition;
    position.status = args.recoveryPosition.status;
    intent.state = "failed";
    intent.outcome = {
      ...intent.outcome,
      status: "pre_transport_refused_no_delete",
      recoveryPhase: args.recoveryPhase,
    };
    recoveries.push(args);
    return { kind: "recovered" };
  };

  let { worker } = makeWorker(store, exchange);
  const recoveryTick = await worker.runOnce();
  assert.equal(recoveryTick.operation, "recover_pretransport_runner_cancel",
    JSON.stringify(recoveryTick));
  assert.equal(recoveries.length, 1);
  const secondRecoveryPhase = `impulse-runner-cancel-recovery-2-${childOrderId}`;
  const nextRecoveryPhase = secondRecoveryPhase;
  assert.equal(store.data.positions[0].snapshot.split.runnerCleanup.recoveryPhase,
    nextRecoveryPhase);
  assert.equal(oldIntent.state, "failed");
  assert.notEqual(firstRecoveryIntent.state, "unknown");
  assert.equal(firstRecoveryIntent.outcome.status, "pre_transport_refused_no_delete");
  assert.notEqual(oldIntent.state, "reconciled");
  assert.notEqual(oldIntent.state, "canceled");
  assert.equal(exchange.calls.filter(([kind]) =>
    kind === "cancelOriginalAfterRunnerFill").length, 0);
  assert.ok(exchange.orders.some((row) => row.orderId === originalStopId),
    "first tick must not DELETE the original stop");
  assert.ok(NOW - Date.parse(runnerFillAt) <= 23 * 60 * 60_000);

  const originalIntentCount = store.data.intents.length;
  ({ worker } = makeWorker(store, exchange));
  const cleanupTick = await worker.runOnce();
  assert.equal(cleanupTick.kind, "unknown",
    "the deliberately lost DELETE acknowledgement remains ambiguous");
  const newIntent = store.data.intents.find((row) =>
    row.phase === nextRecoveryPhase);
  assert.ok(newIntent);
  assert.notEqual(newIntent.clientOrderId, oldClientOrderId);
  assert.equal(store.data.intents.length, originalIntentCount + 1);
  assert.equal(exchange.calls.filter(([kind]) =>
    kind === "cancelOriginalAfterRunnerFill").length, 1,
    JSON.stringify({ cleanupTick, newIntent, lastBrokerError: exchange.lastBrokerError }));
  assert.ok(exchange.calls.some(([kind, request]) =>
    kind === "cancelOriginalAfterRunnerFill" &&
    request.originalStopOrderId === originalStopId &&
    request.coreStopOrderId === coreStop.orderId &&
    request.runnerChildOrderId === childOrderId));
  assert.equal(exchange.orders.some((row) => row.orderId === originalStopId), false);
  const exchangeMutations = () => exchange.calls.filter(([kind]) =>
    ["placeSplitStop", "cancelOriginal", "cancelOriginalAfterRunnerFill",
      "closeSplitTranche", "cancelPartialStop", "closeSoleLeg"].includes(kind));
  const mutationsAfterAmbiguousDelete = exchangeMutations();

  exchange.setMarkPrice("100");
  ({ worker } = makeWorker(store, exchange));
  const settledTick = await worker.runOnce();
  assert.notEqual(settledTick.kind, "unknown", JSON.stringify({
    settledTick,
    evidence: exchange.lastBrokerEvidence,
    error: exchange.lastBrokerError,
    intents: store.data.intents,
  }));
  assert.equal(newIntent.state, "reconciled");
  assert.equal(store.data.positions[0].snapshot.split.stage, "complete");
  assert.equal(exchange.calls.filter(([kind]) =>
    kind === "cancelOriginalAfterRunnerFill").length, 1,
    "ambiguous DELETE is reconciled without a second mutation");
  assert.deepEqual(exchangeMutations(), mutationsAfterAmbiguousDelete,
    "the third tick reconciles the DELETE without any exchange mutation");
});

test("120-hour expiry closes only runner through real broker and cleans stale stop while core stays protected", async () => {
  const { store, exchange } = await completeSplitFixture();
  const state = store.data.positions[0].snapshot;
  state.entryAt = new Date(NOW - 120 * 60 * 60_000).toISOString();
  state.observedAt = state.entryAt;
  exchange.setMarkPrice("105");
  const { worker } = makeWorker(store, exchange);

  const close = await worker.runOnce();
  assert.equal(close.kind, "acted", JSON.stringify(close));
  assert.equal(close.operation, "close_leg");
  assert.equal(close.leg, "runner");
  assert.equal(exchange.calls.filter(([kind]) =>
    kind === "closeSplitTranche").length, 1);
  let saved = store.data.positions[0].snapshot;
  assert.equal(saved.split.stage, "cleanup_pending");
  assert.equal(saved.pendingClose.closedLeg, "runner");
  assert.equal(saved.pendingClose.remainingQuantity, "0.08");
  assert.equal(saved.coreOpen, true);
  assert.equal(saved.split.pendingClosePolicy.coreOpen, true);
  assert.equal(saved.split.pendingClosePolicy.runnerOpen, false);
  assert.equal(exchange.position.positionAmt, "0.08");
  assert.deepEqual(exchange.orders.map((row) => ({
    orderId: row.orderId,
    quantity: row.origQty,
  })).sort((a, b) => a.orderId.localeCompare(b.orderId)), [
    { orderId: saved.split.coreStop.orderId, quantity: "0.08" },
    { orderId: saved.split.runnerStop.orderId, quantity: "0.02" },
  ].sort((a, b) => a.orderId.localeCompare(b.orderId)));
  const closeIntent = store.data.intents.find((row) =>
    row.request.operation === "close_leg");
  assert.equal(closeIntent.state, "reconciled");
  assert.equal(closeIntent.request.leg, "runner");
  assert.equal(closeIntent.request.quantity, saved.split.runnerQuantity);
  assert.equal(closeIntent.request.nextPolicy.coreOpen, true);
  assert.equal(closeIntent.request.nextPolicy.runnerOpen, false);

  const cleanup = await worker.runOnce();
  assert.equal(cleanup.kind, "acted", JSON.stringify(cleanup));
  assert.equal(cleanup.operation, "cancel_split_stop");
  assert.equal(cleanup.leg, "runner");
  saved = store.data.positions[0].snapshot;
  assert.equal(saved.split.stage, "complete");
  assert.deepEqual(saved.split.activeLegs, ["core"]);
  assert.equal(saved.coreOpen, true);
  assert.equal(saved.runnerOpen, false);
  assert.equal(saved.remainingQty, 0.08);
  assert.equal(exchange.position.positionAmt, "0.08");
  assert.deepEqual(exchange.orders.map((row) => ({
    orderId: row.orderId,
    quantity: row.origQty,
    stopPrice: row.stopPrice,
  })), [{
    orderId: saved.split.coreStop.orderId,
    quantity: "0.08",
    stopPrice: String(saved.stopPrice),
  }]);
  assert.equal(exchange.calls.filter(([kind]) =>
    kind === "cancelPartialStop").length, 1);
});

test("runner remains closable as sole leg after core stop exit and later expiry", async () => {
  const { store, exchange } = await completeSplitFixture();
  const state = store.data.positions[0].snapshot;
  const coreStop = state.split.coreStop;
  const runnerStop = state.split.runnerStop;
  const coreChildId = "core-child-fill-after-split";
  const coreChild = {
    symbol: SYMBOL_NAME,
    orderId: coreChildId,
    type: "STOP_MARKET",
    status: "FILLED",
    side: "SELL",
    positionSide: "LONG",
    origQty: "0.08",
    executedQty: "0.08",
    stopPrice: "95",
  };
  exchange.saveHistory({
    ...exactStop(exchange, coreStop.orderId, "0.08", "95"),
    status: "FILLED",
    executedQty: "0.08",
  });
  exchange.saveHistory(coreChild);
  exchange.queueQueryOrder(coreStop.orderId, coreChild);
  exchange.setPositionQuantity("0.02");
  exchange.setOrderSet([
    exactStop(exchange, runnerStop.orderId, "0.02", "100"),
  ]);
  exchange.saveFill({
    symbol: SYMBOL_NAME,
    orderId: coreChildId,
    triggerOrderId: coreStop.orderId,
    side: "SELL",
    positionSide: "LONG",
    volume: "0.08",
    price: "95",
    commission: "-0.02",
    currency: "VST",
    filledTm: NOW,
  });

  let { worker } = makeWorker(store, exchange);
  const coreExit = await worker.runOnce();
  assert.equal(coreExit.kind, "acted", JSON.stringify(coreExit));
  assert.equal(coreExit.operation, "observe_triggered_stop");
  const survivingState = store.data.positions[0].snapshot;
  survivingState.entryAt = new Date(NOW - 120 * 60 * 60_000).toISOString();
  survivingState.observedAt = survivingState.entryAt;
  exchange.setMarkPrice("105");

  ({ worker } = makeWorker(store, exchange));
  const runnerExit = await worker.runOnce();
  assert.equal(runnerExit.kind, "acted", JSON.stringify({
    runnerExit,
    brokerEvidence: exchange.lastBrokerEvidence,
  }));
  assert.equal(runnerExit.operation, "close_survivor");
  assert.equal(runnerExit.leg, "runner");
  const saved = store.data.positions[0].snapshot;
  assert.equal(saved.status, "closed");
  assert.equal(saved.remainingQty, 0);
  assert.equal(saved.coreOpen, false);
  assert.equal(saved.runnerOpen, false);
  assert.equal(exchange.position.positionAmt, "0");
  assert.equal(exchange.orders.length, 0);
  assert.equal(exchange.calls.filter(([kind]) =>
    kind === "closeSoleLeg").length, 1);
  const closeIntent = store.data.intents.find((row) =>
    row.request.operation === "close_survivor");
  assert.equal(closeIntent.state, "reconciled");
  assert.equal(closeIntent.request.stop.orderId, runnerStop.orderId);
  assert.equal(closeIntent.request.quantity, "0.02");
});

test("fresh queued confirmed impulse signal performs guarded leverage, protected MARKET entry, and complete real-broker split", async () => {
  const store = durableStore(null);
  const exchange = freshEntryExchange({ symbol: "BTCUSDT", initialLeverage: 5 });
  const { broker, worker } = makeFreshSignalWorker(store, exchange, ["BTCUSDT"]);
  const freshSignal = confirmedImpulseSignal(
    "BTCUSDT", "fresh-confirmed-btc-impulse-entry",
  );

  assert.equal(typeof broker.getCapabilities, "function");
  assert.equal((await worker.enqueue(freshSignal)).kind, "new");
  assert.equal(store.data.pending.body, freshSignal);

  const leveragePrepared = await worker.runOnce();
  assert.equal(leveragePrepared.kind, "prepared", JSON.stringify(leveragePrepared));
  assert.equal(leveragePrepared.reason, "isolated_leverage_confirmed");
  assert.deepEqual(exchange.writes.map(([kind, requestedSymbol]) =>
    [kind, requestedSymbol]), [["setLeverage10", "BTCUSDT"]]);
  assert.equal(exchange.position.positionAmt, "0");
  assert.equal(exchange.orders.length, 0);
  const leverageIntent = store.data.intents.find((row) =>
    row.request.operation === "set_isolated_leverage");
  assert.equal(leverageIntent.state, "reconciled");
  assert.equal(leverageIntent.request.leverage, 10);
  assert.equal(leverageIntent.request.marginMode, "ISOLATED");

  const marksBeforeSplit = exchange.markReads.length;
  const runnerMarkPrice = "104";
  exchange.setMarkPrice(runnerMarkPrice);
  const entryResult = await worker.runOnce();
  assert.equal(entryResult.kind, "acted", JSON.stringify(entryResult));
  assert.equal(entryResult.operation, "cancel_original_stop");
  let entrySnapshot = store.data.positions[0].snapshot;
  assert.equal(entrySnapshot.split.stage, "complete");
  assert.equal(entrySnapshot.status, "open");
  assert.equal(entrySnapshot.environment, "vst");
  assert.equal(entrySnapshot.accountId, ACCOUNT);
  assert.equal(entrySnapshot.marginMode, "ISOLATED");
  assert.equal(entrySnapshot.leverage, 10);

  const entryIntent = store.data.intents.find((row) =>
    row.request.operation === "entry");
  assert.equal(entryIntent.state, "reconciled");
  assert.equal(entryIntent.exchangeOrderId, "fresh-entry-order-1");
  assert.equal(entryIntent.request.signal.sourceSignalId, freshSignal.sourceSignalId);
  assert.equal(entryIntent.request.signal.symbol, "BTCUSDT");
  const entryPost = exchange.calls.find(([kind]) => kind === "placeEntry")[1];
  assert.equal(typeof entryPost.clientOrderId, "string");
  assert.notEqual(entryPost.clientOrderId, "");
  assert.equal(entrySnapshot.entryClientOrderId, entryIntent.clientOrderId);
  assert.equal(entryPost.stopLoss, freshSignal.stopLoss);
  assert.equal(entryPost.quantity, entryIntent.request.sizing.quantity);
  assert.ok(Number(entryPost.maxPrice) >= 100);
  const exchangeEntry = exchange.history.find((row) =>
    row.orderId === entryIntent.exchangeOrderId);
  assert.equal(exchangeEntry.type, "MARKET");
  assert.equal(exchangeEntry.status, "FILLED");
  assert.equal(exchangeEntry.side, "BUY");
  assert.equal(exchangeEntry.clientOrderId, entryPost.clientOrderId);
  assert.equal(Object.hasOwn(exchangeEntry, "price"), false);
  assert.equal(Object.hasOwn(exchangeEntry, "timeInForce"), false);
  const entryFill = exchange.fills.find((row) =>
    row.orderId === entryIntent.exchangeOrderId);
  assert.equal(entryFill.orderId, exchangeEntry.orderId);
  assert.equal(entryFill.tradeId, "fresh-entry-fill-90071992547409931234");
  assert.equal(entryFill.side, "BUY");
  assert.equal(entryFill.positionSide, "LONG");
  assert.equal(entryFill.volume, entryPost.quantity);
  assert.equal(entryFill.price, "100");
  assert.ok(Number(entryFill.price) <= Number(entryPost.maxPrice));
  assert.equal(entrySnapshot.entryOrderId, entryIntent.exchangeOrderId);
  assert.equal(entrySnapshot.entryPrice, 100);
  assert.equal(entrySnapshot.remainingQty, Number(entryPost.quantity));
  assert.deepEqual(exchange.orders.map((row) => ({
    orderId: row.orderId,
    quantity: row.origQty,
    stopPrice: row.stopPrice,
    status: row.status,
  })).sort((left, right) => left.orderId.localeCompare(right.orderId)), [
    {
      orderId: "fresh-split-core-stop",
      quantity: entrySnapshot.split.coreQuantity,
      stopPrice: entrySnapshot.split.coreStop.stopPrice,
      status: "NEW",
    },
    {
      orderId: "fresh-split-runner-stop",
      quantity: entrySnapshot.split.runnerQuantity,
      stopPrice: entrySnapshot.split.runnerStop.stopPrice,
      status: "NEW",
    },
  ].sort((left, right) => left.orderId.localeCompare(right.orderId)));
  assert.equal(entrySnapshot.split.totalQuantity, entryPost.quantity);
  assert.equal(
    Math.abs(Number(entrySnapshot.split.coreQuantity) +
      Number(entrySnapshot.split.runnerQuantity) -
      Number(entrySnapshot.split.totalQuantity)) < 1e-10,
    true,
  );

  const postEntryMark = exchange.markReads.slice(marksBeforeSplit).find((quote) =>
    quote.markPrice === runnerMarkPrice && quote.timestamp === NOW);
  assert.ok(postEntryMark, "runner decision uses a fresh current VST quote");
  assert.ok(Number(postEntryMark.markPrice) >
    Number(entrySnapshot.split.actualEntryBreakEvenPrice));
  const runnerStopPost = exchange.calls.find(([kind, request]) =>
    kind === "placeSplitStop" && request.tranche === "runner")[1];
  assert.equal(String(runnerStopPost.stopPrice),
    entrySnapshot.split.actualEntryBreakEvenPrice);

  entrySnapshot = store.data.positions[0].snapshot;
  assert.equal(entrySnapshot.split.stage, "complete");
  assert.equal(entrySnapshot.status, "open");
  assert.equal(entrySnapshot.coreOpen, true);
  assert.equal(entrySnapshot.runnerOpen, true);
  assert.equal(entrySnapshot.remainingQty, Number(entrySnapshot.split.totalQuantity));
  assert.deepEqual(exchange.orders.map((row) => ({
    orderId: row.orderId,
    quantity: row.origQty,
    stopPrice: row.stopPrice,
    status: row.status,
  })).sort((left, right) => left.orderId.localeCompare(right.orderId)), [
    {
      orderId: entrySnapshot.split.coreStop.orderId,
      quantity: entrySnapshot.split.coreQuantity,
      stopPrice: entrySnapshot.split.coreStop.stopPrice,
      status: "NEW",
    },
    {
      orderId: entrySnapshot.split.runnerStop.orderId,
      quantity: entrySnapshot.split.runnerQuantity,
      stopPrice: entrySnapshot.split.runnerStop.stopPrice,
      status: "NEW",
    },
  ].sort((left, right) => left.orderId.localeCompare(right.orderId)));
  assert.equal(exchange.orders.some((row) =>
    row.orderId === "fresh-attached-signal-stop"), false);
  assert.equal(exchange.history.find((row) =>
    row.orderId === "fresh-attached-signal-stop").status, "CANCELED");
  assert.deepEqual(exchange.writes.map(([kind]) => kind), [
    "setLeverage10",
    "placeEntry",
    "placeSplitStop",
    "placeSplitStop",
    "cancelOriginal",
  ]);
  assert.equal(broker.getCapabilities instanceof Function, true);
});

test("break-even runner abort reconciles one ambiguous full close after restart, then cancels both known stops separately", async () => {
  const { store, exchange, worker } = await prepareFreshImpulseAtRunnerPending({
    sourceSignalId: "fresh-impulse-pre-runner-abort-restart",
    exchangeOptions: { ambiguousPreRunnerClose: true },
  });
  const beforeAbort = store.data.positions[0].snapshot;
  exchange.setMarkPrice(beforeAbort.actualEntryBreakEvenPrice);
  const abort = await worker.runOnce();
  assert.equal(abort.kind, "unknown", JSON.stringify(abort));
  assert.equal(exchange.position.positionAmt, "0");
  assert.deepEqual(exchange.orders.map((row) => row.orderId).sort(), [
    "fresh-attached-signal-stop",
    "fresh-split-core-stop",
  ]);
  assert.equal(exchange.preRunnerClosePosts.length, 1);
  assert.equal(exchange.writes.filter(([kind]) => kind === "closePreRunnerSplit").length, 1);
  assert.equal(exchange.writes.filter(([kind]) => kind === "placeSplitStop").length, 1);
  assert.equal(exchange.writes.some(([kind]) => kind === "cancelFlatStop"), false);

  const closeIntent = store.data.intents.find((row) =>
    row.request.operation === "close_pre_runner_split");
  assert.ok(closeIntent);
  assert.equal(closeIntent.state, "unknown");
  assert.equal(closeIntent.request.totalQuantity, beforeAbort.split.totalQuantity);
  assert.equal(closeIntent.request.originalStop.orderId, "fresh-attached-signal-stop");
  assert.equal(closeIntent.request.originalStop.quantity, beforeAbort.split.totalQuantity);
  assert.equal(closeIntent.request.coreStop.orderId, "fresh-split-core-stop");
  assert.equal(closeIntent.request.coreStop.quantity, beforeAbort.split.coreQuantity);
  assert.notEqual(
    closeIntent.request.originalStop.orderId,
    closeIntent.request.coreStop.orderId,
  );

  const restarted = makeFreshSignalWorker(store, exchange, ["BTCUSDT"]);
  const reconciliation = await restarted.worker.runOnce();
  assert.ok(
    ["acted", "waiting", "idle"].includes(reconciliation.kind),
    JSON.stringify({
      reconciliation,
      closeIntent: { state: closeIntent.state, detail: closeIntent.detail },
      positions: store.data.positions.map((row) => ({
        status: row.status, splitStage: row.snapshot.split?.stage,
      })),
      unresolved: store.data.intents.filter((intent) =>
        ["prepared", "submitted", "unknown"].includes(intent.state))
        .map((intent) => ({ phase: intent.phase, state: intent.state })),
    }),
  );
  assert.equal(closeIntent.state, "reconciled");
  assert.equal(closeIntent.exchangeOrderId, "fresh-pre-runner-close-order");
  assert.equal(exchange.position.positionAmt, "0");
  assert.equal(exchange.preRunnerClosePosts.length, 1);
  assert.equal(exchange.history.filter((row) =>
    row.orderId === "fresh-pre-runner-close-order" &&
    row.type === "MARKET" && row.status === "FILLED").length, 1);
  const closeFill = exchange.fills.find((row) =>
    row.orderId === "fresh-pre-runner-close-order");
  assert.equal(closeFill.volume, beforeAbort.split.totalQuantity);
  assert.equal(closeFill.currency, "VST");
  assert.equal(closeFill.commission, "-0.02");
  const historyRange = {
    startTs: NOW - 24 * 60 * 60_000,
    endTs: NOW,
  };
  const newestOrders = await exchange.api.queryOrderHistory(
    "BTCUSDT", historyRange,
  );
  assert.equal(newestOrders[0].orderId, "fresh-pre-runner-close-order");
  assert.equal(newestOrders[0].side, "SELL");
  const newestFills = await exchange.api.queryFills("BTCUSDT", historyRange);
  assert.deepEqual(newestFills.slice(0, 2).map((fill) => [
    fill.orderId, fill.side, fill.currency,
  ]), [
    ["fresh-pre-runner-close-order", "SELL", "VST"],
    ["fresh-entry-order-1", "BUY", "USDT"],
  ]);
  assert.deepEqual((await exchange.api.queryFills("BTCUSDT", {
    ...historyRange,
    currency: "VST",
  })).map((fill) => fill.orderId), ["fresh-pre-runner-close-order"]);
  assert.deepEqual(store.data.positions[0].snapshot.split.remainingKnownStopOrderIds.sort(), [
    "fresh-attached-signal-stop",
    "fresh-split-core-stop",
  ]);
  const cleanupCapabilities = await restarted.broker.getCapabilities();
  assert.ok(
    cleanupCapabilities.features.includes("complete_order_lookup"),
    JSON.stringify(cleanupCapabilities),
  );

  let result = reconciliation;
  for (let tick = 0; tick < 3 &&
      store.data.positions[0].snapshot.split.stage !== "closed"; tick += 1) {
    result = await restarted.worker.runOnce();
    assert.equal(result.kind, "acted", JSON.stringify({
      result,
      completeOrderLookup: cleanupCapabilities.features.includes("complete_order_lookup"),
      missingCapabilities: cleanupCapabilities.missingCapabilities,
    }));
    assert.equal(result.operation, "cancel_flat_split_stop");
  }
  const closed = store.data.positions[0].snapshot;
  assert.equal(closed.status, "closed");
  assert.equal(closed.split.stage, "closed");
  assert.equal(closed.executionStatus, "closed");
  assert.equal(closed.remainingQty, 0);
  assert.equal(exchange.position.positionAmt, "0");
  assert.deepEqual(exchange.orders, []);
  assert.deepEqual(exchange.history.filter((row) =>
    ["fresh-attached-signal-stop", "fresh-split-core-stop"]
      .includes(row.orderId)).map((row) => [row.orderId, row.status]).sort(), [
    ["fresh-attached-signal-stop", "CANCELED"],
    ["fresh-split-core-stop", "CANCELED"],
  ]);

  const cancelIntents = store.data.intents.filter((row) =>
    row.request.operation === "cancel_flat_split_stop");
  assert.equal(cancelIntents.length, 2);
  assert.ok(cancelIntents.every((intent) => intent.state === "reconciled"));
  assert.deepEqual(cancelIntents.map((intent) =>
    intent.request.stopToCancel.orderId).sort(), [
    "fresh-attached-signal-stop",
    "fresh-split-core-stop",
  ]);
  assert.equal(new Set(cancelIntents.map((intent) =>
    intent.clientOrderId)).size, 2);
  assert.equal(exchange.writes.filter(([kind]) =>
    kind === "closePreRunnerSplit").length, 1,
  "restart reconciles the ambiguous close instead of submitting another MARKET");
  assert.equal(exchange.writes.filter(([kind]) =>
    kind === "cancelFlatStop").length, 2);
  assert.equal(exchange.writes.some(([kind, request]) =>
    kind === "placeSplitStop" && request.tranche === "runner"), false);
});

test("foreign stop present before break-even abort prevents any full-close or cleanup write", async () => {
  const { store, exchange, worker } = await prepareFreshImpulseAtRunnerPending({
    sourceSignalId: "fresh-impulse-pre-runner-abort-foreign-stop",
  });
  const state = store.data.positions[0].snapshot;
  exchange.addForeignStop();
  exchange.setMarkPrice(state.actualEntryBreakEvenPrice);
  const outcome = await worker.runOnce();

  assert.ok(["waiting", "unknown", "idle"].includes(outcome.kind), JSON.stringify(outcome));
  assert.equal(exchange.position.positionAmt, state.split.totalQuantity);
  assert.deepEqual(exchange.orders.map((row) => row.orderId).sort(), [
    "fresh-attached-signal-stop",
    "fresh-foreign-stop",
    "fresh-split-core-stop",
  ]);
  assert.equal(exchange.preRunnerClosePosts.length, 0);
  assert.equal(exchange.writes.some(([kind]) =>
    kind === "closePreRunnerSplit" || kind === "cancelFlatStop"), false);
  assert.equal(exchange.writes.filter(([kind]) =>
    kind === "placeSplitStop").length, 1);
  assert.equal(store.data.intents.some((row) =>
    row.request.operation === "close_pre_runner_split" ||
    row.request.operation === "cancel_flat_split_stop"), false);
});

test("fresh CROSSED 75x ETHUSDT impulse reconciles an ambiguous isolated-margin switch before leverage, entry, and split", async () => {
  const store = durableStore(null);
  const exchange = freshEntryExchange({
    symbol: "ETHUSDT",
    initialLeverage: 75,
    initialMarginMode: "CROSSED",
    ambiguousMarginSwitch: true,
    ambiguousCoreStop: true,
  });
  const { broker, worker } = makeFreshSignalWorker(store, exchange, ["BTCUSDT"]);
  assert.equal(typeof broker.getCapabilities, "function");
  const ethSignal = confirmedImpulseSignal(
    "ETHUSDT", "fresh-confirmed-eth-impulse-entry",
  );
  assert.equal(ethSignal.patternId, "impulse_buy");
  assert.equal((await worker.enqueue(ethSignal)).kind, "new");
  assert.equal(store.data.pending.body, ethSignal);

  const ambiguousMargin = await worker.runOnce();
  assert.equal(ambiguousMargin.kind, "unknown", JSON.stringify(ambiguousMargin));
  const marginIntent = store.data.intents.find((row) =>
    row.request.operation === "prepare_margin_mode");
  assert.ok(marginIntent);
  assert.equal(marginIntent.state, "unknown");
  assert.equal(marginIntent.request.symbol, "ETHUSDT");
  assert.equal(marginIntent.request.targetMarginMode, "ISOLATED");
  assert.equal(await exchange.api.getMarginType("ETHUSDT"), "ISOLATED");
  assert.deepEqual(exchange.writes, [["setMarginIsolated", "ETHUSDT"]]);
  assert.equal(exchange.writes.some(([kind]) =>
    kind === "setLeverage10" || kind === "placeEntry"), false,
  "neither leverage nor entry may occur before ISO mode is durably confirmed");

  const restartedMargin = makeFreshSignalWorker(store, exchange, ["BTCUSDT"]);
  const marginRecovered = await restartedMargin.worker.runOnce();
  assert.equal(marginRecovered.kind, "prepared", JSON.stringify(marginRecovered));
  assert.equal(marginRecovered.reason, "isolated_margin_mode_confirmed");
  assert.equal(marginIntent.state, "reconciled");
  assert.equal(exchange.writes.filter(([kind]) =>
    kind === "setMarginIsolated").length, 1,
  "restart reconciles the applied margin switch instead of repeating its POST");
  assert.equal(exchange.writes.filter(([kind]) =>
    kind === "setLeverage10").length, 0);
  assert.equal(exchange.writes.some(([kind]) => kind === "placeEntry"), false);

  const leveragePrepared = await restartedMargin.worker.runOnce();
  assert.equal(leveragePrepared.kind, "prepared", JSON.stringify(leveragePrepared));
  assert.equal(leveragePrepared.reason, "isolated_leverage_confirmed");
  assert.equal(exchange.writes.filter(([kind]) =>
    kind === "setLeverage10").length, 1);
  assert.equal(exchange.writes.some(([kind]) => kind === "placeEntry"), false);
  const leverageIntent = store.data.intents.find((row) =>
    row.request.operation === "set_isolated_leverage");
  assert.equal(leverageIntent.state, "reconciled");
  assert.equal(leverageIntent.request.symbol, "ETHUSDT");
  assert.equal(leverageIntent.request.leverage, 10);

  const entry = await restartedMargin.worker.runOnce();
  assert.equal(entry.kind, "unknown", JSON.stringify(entry));
  assert.equal(entry.reason, "impulse_split_intent_requires_reconciliation");
  let snapshot = store.data.positions[0].snapshot;
  assert.equal(snapshot.symbol, "ETHUSDT");
  assert.equal(snapshot.split.stage, "core_pending");
  assert.equal(snapshot.status, "closing");
  assert.equal(snapshot.environment, "vst");
  assert.equal(snapshot.marginMode, "ISOLATED");
  assert.equal(snapshot.leverage, 10);
  const entryIntent = store.data.intents.find((row) =>
    row.request.operation === "entry");
  assert.equal(entryIntent.state, "reconciled");
  assert.equal(entryIntent.request.signal.symbol, "ETHUSDT");
  assert.equal(exchange.writes.filter(([kind]) => kind === "placeEntry").length, 1);
  assert.equal(exchange.position.symbol, "ETH-USDT");
  assert.equal(Number(exchange.position.positionAmt), Number(snapshot.split.totalQuantity));

  exchange.setMarkPrice(String(Number(snapshot.actualEntryBreakEvenPrice) + 1));
  const recovered = await restartedMargin.worker.runOnce();
  assert.equal(recovered.kind, "acted", JSON.stringify(recovered));
  assert.equal(recovered.operation, "cancel_original_stop");
  const coreIntent = store.data.intents.find((row) =>
    row.request.operation === "split_core_stop");
  assert.equal(coreIntent.state, "reconciled");
  assert.equal(coreIntent.request.symbol, "ETHUSDT");
  assert.equal(exchange.writes.filter(([kind, request]) =>
    kind === "placeSplitStop" && request.tranche === "core").length, 1);
  assert.equal(coreIntent.exchangeOrderId, "fresh-split-core-stop");
  assert.equal(exchange.writes.filter(([kind, request]) =>
    kind === "placeSplitStop" && request.tranche === "core").length, 1,
  "restart reconciles the accepted ETH core stop instead of repeating its POST");
  assert.equal(exchange.writes.filter(([kind]) => kind === "placeEntry").length, 1);
  assert.equal(exchange.writes.filter(([kind, request]) =>
    kind === "placeSplitStop" && request.tranche === "runner").length, 1);
  assert.equal(exchange.writes.filter(([kind]) =>
    kind === "cancelOriginal").length, 1);
  snapshot = store.data.positions[0].snapshot;
  assert.equal(snapshot.status, "open");
  assert.equal(snapshot.split.stage, "complete");
  assert.equal(snapshot.coreOpen, true);
  assert.equal(snapshot.runnerOpen, true);
  assert.equal(snapshot.remainingQty, Number(snapshot.split.totalQuantity));
  assert.equal(exchange.position.positionAmt, snapshot.split.totalQuantity);
  assert.deepEqual(exchange.orders.map((row) => ({
    symbol: row.symbol,
    orderId: row.orderId,
    quantity: row.origQty,
    stopPrice: row.stopPrice,
  })).sort((left, right) => left.orderId.localeCompare(right.orderId)), [
    {
      symbol: "ETH-USDT",
      orderId: snapshot.split.coreStop.orderId,
      quantity: snapshot.split.coreQuantity,
      stopPrice: snapshot.split.coreStop.stopPrice,
    },
    {
      symbol: "ETH-USDT",
      orderId: snapshot.split.runnerStop.orderId,
      quantity: snapshot.split.runnerQuantity,
      stopPrice: snapshot.split.runnerStop.stopPrice,
    },
  ].sort((left, right) => left.orderId.localeCompare(right.orderId)));
  assert.equal(exchange.writes.filter(([kind]) => kind === "placeEntry").length, 1);
  assert.equal(exchange.writes.filter(([kind, request]) =>
    kind === "placeSplitStop" && request.tranche === "core").length, 1);
  assert.equal(exchange.writes.filter(([kind, request]) =>
    kind === "placeSplitStop" && request.tranche === "runner").length, 1);
  assert.ok(exchange.calls.some(([kind, requestedSymbol]) =>
    kind === "openOrders" && requestedSymbol === undefined),
  "account-wide open-order reads are available for VST safety checks");
});

test("foreign account-wide order blocks fresh CROSSED ETH margin-mode preparation", async () => {
  const store = durableStore(null);
  const exchange = freshEntryExchange({
    symbol: "ETHUSDT",
    initialLeverage: 75,
    initialMarginMode: "CROSSED",
  });
  const foreignOrder = exchange.addForeignOpenOrder("BTCUSDT");
  assert.deepEqual(await exchange.api.getOpenOrders(), [foreignOrder]);
  assert.deepEqual(await exchange.api.getOpenOrders("ETHUSDT"), []);
  const { worker } = makeFreshSignalWorker(store, exchange, ["BTCUSDT"]);
  const signal = confirmedImpulseSignal(
    "ETHUSDT", "fresh-eth-impulse-blocked-by-foreign-order",
  );
  assert.equal((await worker.enqueue(signal)).kind, "new");

  const result = await worker.runOnce();
  assert.notEqual(result.kind, "acted", JSON.stringify(result));
  assert.ok(exchange.calls.some(([kind, requestedSymbol]) =>
    kind === "openOrders" && requestedSymbol === undefined),
  "the worker must inspect account-wide orders instead of treating symbol-local absence as account-flat");
  assert.deepEqual(exchange.writes, []);
  assert.equal(exchange.writes.some(([kind]) => kind === "placeEntry"), false);
  assert.equal(exchange.writes.some(([kind]) => kind === "setLeverage10"), false);
  assert.equal(exchange.writes.some(([kind]) => kind === "setMarginIsolated"), false);
  assert.equal(await exchange.api.getMarginType("ETHUSDT"), "CROSSED");
  assert.deepEqual(exchange.foreignOrders.map((row) => row.orderId), [
    "fresh-foreign-symbol-open-order",
  ]);
  assert.deepEqual(await exchange.api.getOpenOrders(), [foreignOrder]);
  assert.deepEqual(store.data.intents, []);
});

function acceptedOldSourceExitRequest(
  sourceSignalId = SOURCE_ID,
  requestId = `source-exit-${sourceSignalId}`,
  {
    symbol = SYMBOL,
    reason = "source_withdrawal",
    sourceStatus = reason === "source_closed" ? "profit" : "reclassified",
    sourceUpdatedAt = new Date(NOW - 3 * 60_000).toISOString(),
    sourceClosedAt = null,
    sourceExitPrice = reason === "source_closed" ? "105" : null,
    asOf = new Date(NOW - 3 * 60_000).toISOString(),
    observedAt = new Date(NOW - 3 * 60_000).toISOString(),
  } = {},
) {
  const oldAt = new Date(NOW - 3 * 60_000).toISOString();
  const evidence = {
    sourceSignalId,
    symbol,
    reason,
    sourceStatus,
    sourceUpdatedAt,
    sourceClosedAt,
    sourceExitPrice,
    sourceCancelReason: "owner_withdrew_signal",
    exitDecisionAt: reason === "source_closed" ? sourceClosedAt : sourceUpdatedAt,
    asOf: oldAt,
    observedAt: oldAt,
  };
  return {
    requestId,
    sourceSignalId,
    symbol,
    reason,
    asOf,
    observedAt,
    evidence,
  };
}

function enqueueAcceptedSourceExit(store, request) {
  store.data.sourceExitRequests.push({ ...request, state: "pending" });
}

test("fixed five-percent take closes the whole native split and cleans both stops across restart", async () => {
  const { store, exchange } = await completeSplitFixture({ sourceExitClose: true });
  exchange.setMarkPrice("105");
  const { broker } = makeWorker(store, exchange, [SYMBOL], { environment: "vst" }, () => NOW, true);
  const make = () => createVstWorker({ store, broker, clock: () => NOW,
    sourceExitsEnabled: true, strategyAuthority: "source", exitStrategy: "full_take_5pct" });
  for (let i = 0; i < 10 && store.data.positions[0].status !== "closed"; i++) {
    await make().tick();
  }
  const position = store.data.positions[0];
  assert.equal(position.status, "closed", JSON.stringify({
    position, intents: store.data.intents, events: store.data.events.slice(-3),
  }));
  assert.equal(position.snapshot.remainingQty, 0);
  const closes = store.data.intents.filter(row => row.request.operation === "close_leg" &&
    row.request.reason === "fixed_price_take_profit_5pct");
  assert.equal(closes.length, 1);
  assert.equal(closes[0].request.sourceExit.evidence.issuer, "executor_policy");
  assert.equal(closes[0].state, "reconciled");
  assert.equal(Number(closes[0].request.quantity), 0.1);
  assert.equal(exchange.orders.length, 0);
  assert.deepEqual(await make().executeSourceCommand({
    commandId: "owner-reset-after-verified-take", sourceSignalId: SOURCE_ID,
    symbol: SYMBOL, type: "close", scope: "all", sequence: 99,
    occurredAt: new Date(NOW).toISOString(), reason: "owner_reset",
  }), { status: "already_closed", result: "exchange_close_verified" });
  await make().tick();
  assert.equal(store.data.intents.filter(row => row.request.reason === "fixed_price_take_profit_5pct").length, 1);
});

test("direct source stop does not claim execution or repeat writes when a required legacy adapter is unavailable", async () => {
  const { store, exchange } = await completeSplitFixture();
  const { broker } = makeWorker(store, exchange, [SYMBOL], { environment: "vst" }, () => NOW, true);
  const worker = createVstWorker({ store, broker, clock: () => NOW,
    sourceExitsEnabled: true, strategyAuthority: "source" });
  const command = { commandId: "direct-stop-native-test", sourceSignalId: SOURCE_ID,
    symbol: SYMBOL, type: "move_stop", sequence: 1, occurredAt: new Date(NOW).toISOString(),
    reason: "source_stop", stopPrice: "103.111" };
  let outcome;
  for (let i = 0; i < 12; i++) {
    outcome = await worker.executeSourceCommand(command);
    if (outcome.status !== "pending") break;
    await worker.tick();
  }
  assert.equal(outcome.status, "pending");
  assert.equal(outcome.reason, "intent_requires_reconciliation");
  assert.match(JSON.stringify(store.data.intents),
    /bingx_vst_split_leg_stop_upgrade_adapter_unavailable/);
  const ids = exchange.orders.map(row => row.orderId).sort();
  assert.equal((await worker.executeSourceCommand(command)).status, "pending");
  assert.deepEqual(exchange.orders.map(row => row.orderId).sort(), ids);
});

test("direct source stop rounds to the native tick and acknowledges already verified protection without a write", async () => {
  const { store, exchange } = await completeSplitFixture();
  exchange.setMarkPrice("105");
  for (const row of exchange.orders) {
    if (row.status === "NEW" && row.type === "STOP_MARKET") row.stopPrice = "100";
  }
  const snapshot = store.data.positions[0].snapshot;
  snapshot.stopPrice = 100;
  snapshot.runnerStopPrice = 100;
  // The native read reconstructs split-stop ownership from this persisted
  // cohort, not from the display-level stop fields alone.
  for (const leg of ["core", "runner"]) {
    if (snapshot.split?.[`${leg}Stop`]) snapshot.split[`${leg}Stop`].stopPrice = "100";
  }
  for (const key of ["protectiveStops", "verifiedProtectiveStops"]) {
    for (const leg of ["core", "runner"]) {
      if (snapshot[key]?.[leg]) snapshot[key][leg].stopPrice = "100";
    }
  }
  const { broker } = makeWorker(store, exchange, [SYMBOL], { environment: "vst" }, () => NOW, true);
  const worker = createVstWorker({ store, broker, clock: () => NOW,
    sourceExitsEnabled: true, strategyAuthority: "source" });
  const command = { commandId: "direct-stop-already-native", sourceSignalId: SOURCE_ID,
    symbol: SYMBOL, type: "move_stop", sequence: 1, occurredAt: new Date(NOW).toISOString(),
    reason: "source_stop", stopPrice: "99.991" };
  const ids = exchange.orders.map(row => row.orderId).sort();
  const native = await broker.readPosition(SYMBOL);
  assert.deepEqual(await worker.executeSourceCommand(command),
    { status: "executed", result: "exchange_stop_verified" },
    JSON.stringify({ native, expected: { id: snapshot.exchangePositionId,
      qty: snapshot.remainingQty, core: snapshot.coreStopOrderId,
      runner: snapshot.runnerStopOrderId, accountId: snapshot.accountId } }));
  assert.equal((await worker.executeSourceCommand(command)).status, "executed");
  assert.deepEqual(exchange.orders.map(row => row.orderId).sort(), ids);
});

test("direct source close survives restart, verifies cleanup and never repeats an exchange write", async () => {
  const { store, exchange } = await completeSplitFixture({ sourceExitClose: true });
  const { broker } = makeWorker(store, exchange, [SYMBOL], { environment: "vst" }, () => NOW, true);
  const make = () => createVstWorker({ store, broker, clock: () => NOW,
    sourceExitsEnabled: true, strategyAuthority: "source" });
  const command = { commandId: "direct-close-native-test", sourceSignalId: SOURCE_ID,
    symbol: SYMBOL, type: "close", sequence: 1, occurredAt: new Date(NOW).toISOString(),
    reason: "trailing_exit", scope: "all" };
  let outcome;
  for (let i = 0; i < 8; i++) {
    outcome = await make().executeSourceCommand(command);
    if (outcome.status !== "pending") break;
  }
  assert.equal(outcome.status, "executed", JSON.stringify({
    outcome, position: store.data.positions[0], intents: store.data.intents,
    calls: exchange.calls.filter(([kind]) => kind === "sourceExitClose"),
  }));
  assert.equal(store.data.positions[0].status, "closed");
  assert.equal(exchange.orders.length, 0);
  assert.equal(exchange.calls.filter(([kind]) => kind === "sourceExitClose").length, 1);
  const repeat = await make().executeSourceCommand(command);
  assert.equal(repeat.status, "already_closed", JSON.stringify(repeat));
  assert.equal(exchange.calls.filter(([kind]) => kind === "sourceExitClose").length, 1);
});

test("accepted stale source withdrawal survives restart and source outage, then closes and cleans exact stops", async () => {
  const { store, exchange } = await completeSplitFixture({
    sourceExitClose: true,
  });
  const request = acceptedOldSourceExitRequest();
  request.asOf = new Date(NOW).toISOString();
  request.observedAt = new Date(NOW).toISOString();
  enqueueAcceptedSourceExit(store, request);

  const firstWorker = makeWorker(
    store, exchange, [SYMBOL], { environment: "vst" }, () => NOW, true,
  ).worker;
  const close = await firstWorker.runOnce();
  assert.equal(close.kind, "acted", JSON.stringify(close));
  assert.equal(close.operation, "source_exit_close");
  assert.equal(exchange.calls.filter(([kind]) => kind === "sourceExitClose").length, 1);
  assert.equal(store.data.positions[0].status, "closing");
  assert.deepEqual(store.data.positions[0].snapshot.sourceExitEvidence,
    request.evidence);

  // A replacement worker has only the durable queue row and exchange facts;
  // it does not need a fresh source poll or a newer source snapshot.
  store.data.sourceExitRequests[0].asOf = new Date(NOW + 1_000).toISOString();
  store.data.sourceExitRequests[0].observedAt = new Date(NOW + 1_000).toISOString();
  const restartedWorker = makeWorker(
    store, exchange, [SYMBOL], { environment: "vst" }, () => NOW, true,
  ).worker;
  const firstCleanup = await restartedWorker.runOnce();
  assert.equal(firstCleanup.kind, "acted", JSON.stringify(firstCleanup));
  assert.equal(firstCleanup.operation, "source_exit_stop_cleanup");
  store.data.sourceExitRequests[0].asOf = new Date(NOW + 2_000).toISOString();
  store.data.sourceExitRequests[0].observedAt = new Date(NOW + 2_000).toISOString();
  const secondCleanup = await restartedWorker.runOnce();
  assert.equal(secondCleanup.kind, "acted", JSON.stringify(secondCleanup));
  assert.equal(exchange.calls.filter(([kind]) => kind === "sourceExitClose").length, 1);
  assert.equal(exchange.orders.length, 0);
  assert.equal(store.data.positions[0].status, "closed");
  assert.equal(store.data.positions[0].snapshot.status, "closed");
  assert.equal(store.data.positions[0].snapshot.sourceExitRequestId,
    request.requestId);
  assert.deepEqual(store.data.positions[0].snapshot.sourceExitEvidence,
    request.evidence);
  assert.equal(store.data.positions[0].snapshot.lastCloseFill.price, 105);
  assert.equal(store.data.positions[0].snapshot.lastCloseFill.quantity, 0.1);
  assert.deepEqual(store.data.positions[0].snapshot.lastCloseFill.fees,
    [{ currency: "VST", amount: "-0.012" }]);
  assert.equal(store.data.sourceExitRequests[0].state, "finished");
  assert.equal(store.data.sourceExitRequests[0].result.outcome, "closed");
});

test("legacy source-exit entry proof recovers only an absent timestamp from native fills", async () => {
  const { store, exchange } = await completeSplitFixture({
    sourceExitClose: true,
  });
  const state = store.data.positions[0].snapshot;
  const nativeFillAt = state.verifiedFill.at;
  delete state.entryAt;
  delete state.verifiedFill.at;
  const entryIntent = store.data.intents.find((intent) =>
    intent.phase === "market-entry");
  delete entryIntent.outcome.operation;
  delete entryIntent.outcome.totalQuantity;
  delete entryIntent.outcome.coreQuantity;
  delete entryIntent.outcome.runnerQuantity;
  delete entryIntent.outcome.splitStage;
  entryIntent.outcome.fillQuantity = "0.1";
  entryIntent.outcome.fillPrice = "100";
  const request = acceptedOldSourceExitRequest(
    SOURCE_ID, "source-exit-legacy-entry-timestamp-recovery",
  );
  enqueueAcceptedSourceExit(store, request);
  const worker = makeWorker(
    store, exchange, [SYMBOL], { environment: "vst" }, () => NOW, true,
  ).worker;

  const result = await worker.runOnce();

  assert.equal(result.operation, "source_exit_close", JSON.stringify(result));
  assert.equal(store.data.positions[0].snapshot.entryAt, nativeFillAt);
  assert.equal(store.data.positions[0].snapshot.verifiedFill.at, nativeFillAt);
});

test("modern multi-fill source proof preserves the saved earliest timestamp and rejects conflicts", async () => {
  for (const conflict of [false, true]) {
    const { store, exchange } = await completeSplitFixture({
      sourceExitClose: true,
    });
    const state = store.data.positions[0].snapshot;
    const entryOrderId = state.entryOrderId;
    const originalSavedAt = Date.parse(state.verifiedFill.at);
    const earliestAt = originalSavedAt - 1_000;
    const entryFills = exchange.fills.filter((fill) =>
      fill.orderId === entryOrderId && fill.side === "BUY");
    assert.equal(entryFills.length, 1);
    Object.assign(entryFills[0], {
      qty: "0.05",
      filledTm: earliestAt,
    });
    exchange.fills.push({
      ...entryFills[0],
      tradeId: "native-entry-fill-2",
      qty: "0.05",
      filledTm: originalSavedAt,
    });
    state.entryAt = new Date(earliestAt).toISOString();
    state.verifiedFill.at = new Date(conflict ? originalSavedAt : earliestAt).toISOString();
    const request = acceptedOldSourceExitRequest(
      SOURCE_ID, `source-exit-multi-fill-${conflict ? "conflict" : "earliest"}`,
    );
    enqueueAcceptedSourceExit(store, request);
    const worker = makeWorker(
      store, exchange, [SYMBOL], { environment: "vst" }, () => NOW, true,
    ).worker;

    const result = await worker.runOnce();
    const closeCount = exchange.calls.filter(([kind]) =>
      kind === "sourceExitClose").length;
    const reservedClose = store.data.intents.some((intent) =>
      intent.request?.sourceExit?.requestId === request.requestId);
    if (conflict) {
      assert.notEqual(result.operation, "source_exit_close");
      assert.equal(closeCount, 0);
      assert.equal(reservedClose, false);
      assert.equal(state.entryAt, new Date(earliestAt).toISOString());
      assert.equal(state.verifiedFill.at, new Date(originalSavedAt).toISOString());
    } else {
      assert.equal(result.operation, "source_exit_close", JSON.stringify(result));
      assert.equal(closeCount, 1);
      assert.equal(reservedClose, true);
      assert.equal(state.entryAt, new Date(earliestAt).toISOString());
      assert.equal(state.verifiedFill.at, new Date(earliestAt).toISOString());
    }
  }
});

test("source exit recovers an undeclared entry type only from the native filled parent", async () => {
  for (const { label, type, timeInForce } of [
    { label: "undeclared historical MARKET", type: "MARKET" },
    { label: "legacy HBAR/GRT LIMIT FOK", type: "LIMIT", timeInForce: "FOK" },
  ]) {
    const { store, exchange } = await completeSplitFixture({
      sourceExitClose: true,
    });
    const state = store.data.positions[0].snapshot;
    const entryIntent = store.data.intents.find((intent) =>
      intent.phase === "market-entry");
    const nativeEntryOrder = exchange.history.find((order) =>
      order.orderId === state.entryOrderId);
    delete state.entryOrderType;
    delete state.verifiedFill;
    delete entryIntent.request.entryOrderType;
    nativeEntryOrder.type = type;
    if (timeInForce) nativeEntryOrder.timeInForce = timeInForce;
    else delete nativeEntryOrder.timeInForce;
    const request = acceptedOldSourceExitRequest(
      SOURCE_ID, `source-exit-type-recovery-${type.toLowerCase()}`,
    );
    enqueueAcceptedSourceExit(store, request);
    const { worker } = makeWorker(
      store, exchange, [SYMBOL], { environment: "vst" }, () => NOW, true,
    );

    const result = await worker.runOnce();

    assert.equal(result.operation, "source_exit_close", `${label}: ${JSON.stringify(result)}`);
    const closeIntent = store.data.intents.find((intent) =>
      intent.request?.sourceExit?.requestId === request.requestId);
    assert.equal(closeIntent.request.priorPosition.entryOrderType, type);
    assert.equal(store.data.positions[0].snapshot.entryAt,
      state.entryAt, "saved production entryAt is preserved after native corroboration");
  }
});

test("unsupported undeclared native entry type is rejected before source-close reservation", async () => {
  const { store, exchange } = await completeSplitFixture({
    sourceExitClose: true,
  });
  const state = store.data.positions[0].snapshot;
  const entryIntent = store.data.intents.find((intent) =>
    intent.phase === "market-entry");
  const nativeEntryOrder = exchange.history.find((order) =>
    order.orderId === state.entryOrderId);
  delete state.entryOrderType;
  delete state.verifiedFill;
  delete entryIntent.request.entryOrderType;
  nativeEntryOrder.type = "STOP_MARKET";
  const request = acceptedOldSourceExitRequest(
    SOURCE_ID, "source-exit-unsupported-stop-entry-type",
  );
  enqueueAcceptedSourceExit(store, request);
  const writesBefore = exchange.calls.filter(([kind]) =>
    kind === "sourceExitClose").length;
  const { worker } = makeWorker(
    store, exchange, [SYMBOL], { environment: "vst" }, () => NOW, true,
  );

  await worker.runOnce();

  assert.equal(exchange.calls.filter(([kind]) =>
    kind === "sourceExitClose").length, writesBefore,
  "unrecognized native entry types do not cause a source-close POST");
  assert.equal(store.data.intents.some((intent) =>
    intent.request?.sourceExit?.requestId === request.requestId), false,
  "the source-close intent is not reserved without a supported native parent");
});

test("source-exit entry timestamp conflicts fail closed without rewriting saved times", async () => {
  for (const conflictingField of ["entryAt", "verifiedFill.at"]) {
    const { store, exchange } = await completeSplitFixture({
      sourceExitClose: true,
    });
    const state = store.data.positions[0].snapshot;
    const nativeFillAt = state.verifiedFill.at;
    const conflict = new Date(Date.parse(nativeFillAt) + 1_000).toISOString();
    if (conflictingField === "entryAt") state.entryAt = conflict;
    else state.verifiedFill.at = conflict;
    const request = acceptedOldSourceExitRequest(
      SOURCE_ID, `source-exit-conflicting-${conflictingField.replace(".", "-")}`,
    );
    enqueueAcceptedSourceExit(store, request);
    const worker = makeWorker(
      store, exchange, [SYMBOL], { environment: "vst" }, () => NOW, true,
    ).worker;

    await worker.runOnce();

    assert.equal(exchange.calls.filter(([kind]) => kind === "sourceExitClose").length, 0);
    assert.equal(store.data.intents.some((intent) =>
      intent.request?.sourceExit?.requestId === request.requestId), false,
    "conflicting saved time is rejected before reserving a source close");
    assert.equal(store.data.positions[0].snapshot.entryAt,
      conflictingField === "entryAt" ? conflict : nativeFillAt);
    assert.equal(store.data.positions[0].snapshot.verifiedFill.at,
      conflictingField === "verifiedFill.at" ? conflict : nativeFillAt);
  }
});

test("unknown source close is reconciled read-only after restart and never reposted", async () => {
  const { store, exchange } = await completeSplitFixture({
    sourceExitClose: true,
    sourceExitPostUnknown: true,
  });
  const request = acceptedOldSourceExitRequest(
    SOURCE_ID, "source-exit-unknown-after-restart",
  );
  enqueueAcceptedSourceExit(store, request);

  const firstWorker = makeWorker(
    store, exchange, [SYMBOL], { environment: "vst" }, () => NOW, true,
  ).worker;
  const first = await firstWorker.runOnce();
  assert.notEqual(first.operation, "source_exit_close");
  assert.equal(exchange.calls.filter(([kind]) => kind === "sourceExitClose").length, 1);
  assert.equal(store.data.sourceExitRequests[0].state, "pending");

  const restartedWorker = makeWorker(
    store, exchange, [SYMBOL], { environment: "vst" }, () => NOW, true,
  ).worker;
  await restartedWorker.runOnce();
  assert.equal(exchange.calls.filter(([kind]) => kind === "sourceExitClose").length, 1);
  assert.equal(store.data.sourceExitRequests[0].state, "pending");
  assert.notEqual(store.data.positions[0].status, "closed");
});

test("partial source-close fill remains durably pending and cannot be repeated", async () => {
  const { store, exchange } = await completeSplitFixture({
    sourceExitClose: true,
    sourceExitPartialFill: true,
  });
  const request = acceptedOldSourceExitRequest(
    SOURCE_ID, "source-exit-partial-fill",
  );
  enqueueAcceptedSourceExit(store, request);
  const worker = makeWorker(
    store, exchange, [SYMBOL], { environment: "vst" }, () => NOW, true,
  ).worker;

  await worker.runOnce();
  assert.equal(exchange.calls.filter(([kind]) => kind === "sourceExitClose").length, 1);
  assert.equal(exchange.position.positionAmt, "0.05");
  assert.equal(store.data.sourceExitRequests[0].state, "pending");

  const restartedWorker = makeWorker(
    store, exchange, [SYMBOL], { environment: "vst" }, () => NOW, true,
  ).worker;
  await restartedWorker.runOnce();
  assert.equal(exchange.calls.filter(([kind]) => kind === "sourceExitClose").length, 1);
  assert.equal(store.data.sourceExitRequests[0].state, "pending");
  assert.notEqual(store.data.positions[0].status, "closed");
});

test("source exit recovers queue acknowledgement from closed ledger and production intent outcomes", async () => {
  const { store, exchange } = await completeSplitFixture({
    sourceExitClose: true,
  });
  const request = acceptedOldSourceExitRequest(
    SOURCE_ID, "source-exit-queue-ack-failure",
  );
  enqueueAcceptedSourceExit(store, request);
  store.data.failSourceExitFinishCount = 1;
  const worker = makeWorker(
    store, exchange, [SYMBOL], { environment: "vst" }, () => NOW, true,
  ).worker;

  assert.equal((await worker.runOnce()).operation, "source_exit_close");
  assert.equal((await worker.runOnce()).operation, "source_exit_stop_cleanup");
  const finalCleanup = await worker.runOnce();
  assert.equal(finalCleanup.operation, "source_exit_stop_cleanup",
    JSON.stringify(finalCleanup));
  assert.equal(store.data.positions[0].status, "closed");
  assert.equal(store.data.sourceExitRequests[0].state, "pending",
    "the simulated completion-event acknowledgement fails after ledger commit");
  const closeIntent = store.data.intents.find((intent) =>
    intent.request?.sourceExit?.requestId === request.requestId &&
    intent.request?.operation === "close_leg");
  assert.ok(closeIntent?.outcome?.fill,
    "fixture exposes the production intent.outcome field");

  const restarted = makeWorker(
    store, exchange, [SYMBOL], { environment: "vst" }, () => NOW, true,
  ).worker;
  const recovered = await restarted.runOnce();
  assert.equal(recovered.operation, "source_exit_request_finished",
    JSON.stringify(recovered));
  assert.equal(store.data.sourceExitRequests[0].state, "finished");
  assert.equal(exchange.calls.filter(([kind]) => kind === "sourceExitClose").length, 1);
  assert.equal(exchange.orders.length, 0);
});

test("a queued source exit retires from its committed protective-stop close without a second exchange write", async () => {
  const parent = "2105952049086160896", child = "2106091719796719617";
  const positionId = "2105271515231551489";
  const phase = `triggered-stop-${createHash("sha256").update(parent).digest("hex").slice(0, 24)}`;
  const clientOrderId = `vst-${createHash("sha256")
    .update(`${SOURCE_ID}:${phase}`).digest("hex").slice(0, 30)}`;
  const fill = { at: new Date(NOW - 20_000).toISOString(), orderId: child,
    triggerOrderId: parent, exchangeOrderId: child, quantity: 0.1, price: 95,
    fee: { asset: "VST", amount: "-0.01" },
    fees: { asset: "VST", amount: "-0.01" }, feeEvidenceAvailable: true };
  const snapshot = { sourceSignalId: SOURCE_ID, symbol: SYMBOL, status: "closed",
    environment: "vst", accountId: ACCOUNT, remainingQty: 0,
    exchangePositionId: positionId, lastCloseFill: structuredClone(fill),
    triggeredStop: { parentStopId: parent, childOrderId: child, parentStopPrice: "95" } };
  const store = durableStore(snapshot);
  store.data.intents.push({
    sourceSignalId: SOURCE_ID, phase, clientOrderId, state: "reconciled",
    exchangeOrderId: child,
    request: { operation: "observe_triggered_stop", environment: "vst", accountId: ACCOUNT,
      symbol: SYMBOL, positionId, stopOrderId: parent, stopQuantity: 0.1, stopPrice: 95 },
    outcome: { operation: "observe_triggered_stop", verified: true, status: "filled",
      parentStopId: parent, childOrderId: child, parentStopPrice: "95",
      fill, residualPosition: { verified: true, positionId, quantity: "0" }, openStops: [] },
  });
  const request = acceptedOldSourceExitRequest(SOURCE_ID, "stop-close-queue-ack");
  enqueueAcceptedSourceExit(store, request);
  store.data.failSourceExitFinishCount = 1;
  const exchange = mockExchange();
  exchange.setPositionQuantity("0");
  exchange.setOrderSet([]);
  const alerts = [];
  const worker = makeWorker(store, exchange, [SYMBOL], { environment: "vst" },
    () => NOW, true, FEATURES, async (alert) => alerts.push(alert)).worker;
  const first = await worker.runOnce();
  assert.equal(first.kind, "waiting", JSON.stringify(first));
  assert.equal(first.reason, "source_exit_queue_acknowledgement_unavailable");
  assert.equal(store.data.sourceExitRequests[0].state, "pending");
  const readsBeforeRestart = exchange.calls.length;
  const restarted = makeWorker(store, exchange, [SYMBOL], { environment: "vst" },
    () => NOW, true, FEATURES, async (alert) => alerts.push(alert)).worker;
  assert.equal((await restarted.runOnce()).operation, "source_exit_request_finished");
  assert.equal(store.data.sourceExitRequests[0].state, "finished");
  assert.equal(exchange.calls.length, readsBeforeRestart,
    "successful durable closure acknowledgement needs no additional exchange request");
  assert.ok(exchange.calls.every(([kind]) =>
    ["positions", "openOrders", "mark", "history", "queryOrder", "fills"].includes(kind)),
  "even a failed queue acknowledgement must never produce an exchange mutation");
  assert.deepEqual(store.data.positions[0].snapshot, snapshot);
  assert.deepEqual(alerts, []);
});

test("terminal source-closed evidence with null sourceUpdatedAt survives queue metadata refresh", async () => {
  const { store, exchange } = await completeSplitFixture({
    sourceExitClose: true,
  });
  const request = acceptedOldSourceExitRequest(
    SOURCE_ID,
    "source-exit-closed-null-updated-at",
    {
      reason: "source_closed",
      sourceStatus: "profit",
      sourceUpdatedAt: null,
      sourceClosedAt: new Date(NOW - 3 * 60_000).toISOString(),
      asOf: new Date(NOW).toISOString(),
      observedAt: new Date(NOW).toISOString(),
    },
  );
  enqueueAcceptedSourceExit(store, request);
  const worker = makeWorker(
    store, exchange, [SYMBOL], { environment: "vst" }, () => NOW, true,
  ).worker;

  assert.equal((await worker.runOnce()).operation, "source_exit_close");
  store.data.sourceExitRequests[0].asOf = new Date(NOW + 1_000).toISOString();
  store.data.sourceExitRequests[0].observedAt = new Date(NOW + 1_000).toISOString();
  assert.equal((await worker.runOnce()).operation, "source_exit_stop_cleanup");
  assert.equal((await worker.runOnce()).operation, "source_exit_stop_cleanup");
  assert.equal(store.data.sourceExitRequests[0].state, "finished");
  assert.equal(store.data.positions[0].snapshot.sourceExitEvidence.sourceUpdatedAt, null);
});

test("source-closed exit evidence requires terminal status, valid closedAt, and a positive source price", async () => {
  const invalidEvidenceCases = [
    {
      requestId: "source-exit-closed-nonterminal-status",
      options: {
        reason: "source_closed",
        sourceStatus: "active",
        sourceUpdatedAt: null,
        sourceClosedAt: new Date(NOW - 3 * 60_000).toISOString(),
      },
    },
    {
      requestId: "source-exit-closed-missing-closed-at",
      options: {
        reason: "source_closed",
        sourceStatus: "profit",
        sourceUpdatedAt: null,
        sourceClosedAt: null,
      },
    },
    {
      requestId: "source-exit-closed-missing-exit-price",
      options: {
        reason: "source_closed",
        sourceStatus: "profit",
        sourceUpdatedAt: null,
        sourceClosedAt: new Date(NOW - 3 * 60_000).toISOString(),
        sourceExitPrice: null,
      },
    },
  ];

  for (const { requestId, options } of invalidEvidenceCases) {
    const { store, exchange } = await completeSplitFixture({
      sourceExitClose: true,
    });
    enqueueAcceptedSourceExit(
      store, acceptedOldSourceExitRequest(SOURCE_ID, requestId, options),
    );
    const worker = makeWorker(
      store, exchange, [SYMBOL], { environment: "vst" }, () => NOW, true,
    ).worker;
    const result = await worker.runOnce();
    assert.equal(result.reason, "source_exit_request_invalid", JSON.stringify(result));
    assert.equal(exchange.calls.filter(([kind]) => kind === "sourceExitClose").length, 0);
  }
});

test("flat source-stop cleanup needs its narrow capability, not active-position close capability", async () => {
  const { store, exchange } = await completeSplitFixture({
    sourceExitClose: true,
  });
  const request = acceptedOldSourceExitRequest(
    SOURCE_ID, "source-exit-flat-cleanup-capability",
  );
  enqueueAcceptedSourceExit(store, request);
  const closeWorker = makeWorker(
    store, exchange, [SYMBOL], { environment: "vst" }, () => NOW, true,
  ).worker;
  assert.equal((await closeWorker.runOnce()).operation, "source_exit_close");

  const cleanupWorker = makeWorker(
    store,
    exchange,
    [SYMBOL],
    { environment: "vst" },
    () => NOW,
    true,
    ["vst_only", "verified_position_state", "verified_source_flat_stop_cleanup"],
  ).worker;
  const cleanup = await cleanupWorker.runOnce();
  assert.equal(cleanup.operation, "source_exit_stop_cleanup", JSON.stringify(cleanup));
  assert.equal(exchange.calls.filter(([kind]) => kind === "cancelKnownFlatStop").length, 1);
  assert.equal(store.data.positions[0].status, "closing");
});

test("source exit reconciles a filled native split stop before closing its verified residual", async () => {
  const { store, exchange } = await completeSplitFixture({
    sourceExitClose: true,
  });
  const state = store.data.positions[0].snapshot;
  const coreStop = state.split.coreStop;
  const runnerStop = state.split.runnerStop;
  const childId = "source-prerequisite-core-stop-fill";
  const childOrder = {
    symbol: SYMBOL_NAME,
    orderId: childId,
    mainOrderId: coreStop.orderId,
    type: "STOP_MARKET",
    status: "FILLED",
    side: "SELL",
    positionSide: "LONG",
    positionId: "position-1",
    positionID: "position-1",
    workingType: "MARK_PRICE",
    origQty: "0.08",
    executedQty: "0.08",
    stopPrice: "95",
  };
  const parentOrder = {
    ...exactStop(exchange, coreStop.orderId, "0.08", "95"),
    status: "FILLED",
    executedQty: "0.08",
  };
  exchange.saveHistory(parentOrder);
  exchange.saveHistory(childOrder);
  exchange.queueQueryOrder(coreStop.orderId, {
    ...childOrder,
    positionId: 0,
    positionID: 0,
  });
  exchange.queueQueryOrder(childId, childOrder);
  exchange.setPositionQuantity("0.02");
  exchange.setOrderSet([
    exactStop(exchange, runnerStop.orderId, "0.02", runnerStop.stopPrice),
  ]);
  exchange.saveFill({
    symbol: SYMBOL_NAME,
    orderId: childId,
    triggerOrderId: coreStop.orderId,
    side: "SELL",
    positionSide: "LONG",
    volume: "0.08",
    price: "95",
    commission: "-0.01",
    currency: "VST",
    filledTm: NOW,
  });
  const request = acceptedOldSourceExitRequest(
    SOURCE_ID, "source-exit-after-native-core-stop",
  );
  enqueueAcceptedSourceExit(store, request);
  const worker = makeWorker(
    store, exchange, [SYMBOL], { environment: "vst" }, () => NOW, true,
  ).worker;

  const reconciliation = await worker.runOnce();
  assert.equal(reconciliation.operation, "source_exit_stop_fill_reconciled",
    JSON.stringify(reconciliation));
  assert.equal(exchange.calls.filter(([kind]) => kind === "sourceExitClose").length, 0);
  assert.equal(store.data.positions[0].snapshot.remainingQty, 0.02);
  assert.equal(store.data.positions[0].snapshot.coreOpen, false);
  assert.equal(store.data.positions[0].snapshot.runnerOpen, true);
  assert.equal(store.data.positions[0].snapshot.lastCloseFill.orderId, childId);
  assert.deepEqual(store.data.positions[0].snapshot.lastCloseFill.fees, {
    asset: "VST",
    amount: "-0.01",
  });

  await worker.runOnce();
  const sourceClose = exchange.calls.find(([kind]) => kind === "sourceExitClose");
  assert.ok(sourceClose, "source close follows the verified residual ledger refresh");
  assert.equal(Number(sourceClose[1].quantity), 0.02);
  assert.equal(exchange.calls.filter(([kind]) => kind === "sourceExitClose").length, 1);
});

test("modern core-only source exit proves original entry quantity and closes core residual", async () => {
  const { store, exchange } = await completeSplitFixture({
    sourceExitClose: true,
  });
  const state = store.data.positions[0].snapshot;
  const coreStop = state.split.coreStop;
  state.remainingQty = 0.08;
  state.coreQty = 0.08;
  state.coreOpen = true;
  state.runnerQty = 0;
  state.runnerOpen = false;
  state.runnerStopPrice = null;
  state.runnerStopOrderId = null;
  state.runnerStopPositionId = null;
  state.runnerStopQuantity = 0;
  state.verifiedProtectiveStops = {
    core: { verified: true, ...coreStop },
  };
  state.persistedPosition.protectiveStops = {
    core: { verified: true, ...coreStop },
  };
  state.split.runnerStop = null;
  state.split.activeLegs = ["core"];
  exchange.setPositionQuantity("0.08");
  exchange.setOrderSet([
    exactStop(exchange, coreStop.orderId, "0.08", coreStop.stopPrice),
  ]);
  const request = acceptedOldSourceExitRequest(
    SOURCE_ID, "source-exit-modern-core-only-original-entry-quantity",
  );
  enqueueAcceptedSourceExit(store, request);
  const { broker, worker } = makeWorker(
    store, exchange, [SYMBOL], { environment: "vst" }, () => NOW, true,
  );
  let nativeProofQuantity;
  const verifySourceExitEntryProof = broker.verifySourceExitEntryProof.bind(broker);
  broker.verifySourceExitEntryProof = async (proofRequest) => {
    nativeProofQuantity = proofRequest.expectedQuantity;
    return await verifySourceExitEntryProof(proofRequest);
  };

  const result = await worker.runOnce();

  assert.equal(result.operation, "source_exit_close", JSON.stringify(result));
  assert.equal(nativeProofQuantity, "0.1",
    "native proof uses the original filled entry quantity, not the core residual");
  const close = exchange.calls.find(([kind]) => kind === "sourceExitClose");
  assert.equal(close[1].quantity, "0.08",
    "the separate close request is limited to the currently verified core residual");
  assert.equal(store.data.intents.find((intent) =>
    intent.phase === "market-entry").outcome.totalQuantity, "0.1");
});

test("a blocked AKE source exit does not starve an unrelated ETH entry or repeat its unknown intent", async () => {
  const store = durableStore(null);
  const sourceSignalId = "AKE-source-signal";
  const priorPosition = structuredClone(splitSnapshot());
  priorPosition.sourceSignalId = sourceSignalId;
  priorPosition.symbol = "AKEUSDT";
  priorPosition.signalSnapshot = {
    ...priorPosition.signalSnapshot,
    sourceSignalId,
    symbol: "AKEUSDT",
  };
  store.data.positions.push({
    sourceSignalId,
    symbol: "AKEUSDT",
    status: "open",
    snapshot: priorPosition,
  });
  const request = acceptedOldSourceExitRequest(
    sourceSignalId,
    "source-exit-ake-blocked-by-prior-intent",
    { symbol: "AKEUSDT" },
  );
  enqueueAcceptedSourceExit(store, request);
  const priorIntentClientOrderId = "ake-unknown-partial-close-client";
  const priorIntent = {
    sourceSignalId,
    phase: "unknown-prior-partial-close",
    clientOrderId: priorIntentClientOrderId,
    request: {
      operation: "close_leg",
      sourceSignalId,
      symbol: "AKEUSDT",
      environment: "vst",
      accountId: ACCOUNT,
      positionId: priorPosition.exchangePositionId,
      quantity: "0.02",
      previousQuantity: "0.1",
      reason: "partial_close",
      intentCreatedAt: NOW - 1_000,
      signal: {
        sourceSignalId,
        symbol: "AKEUSDT",
        patternId: "source_exit",
      },
      signalAt: priorPosition.signalAt,
      priorPosition,
    },
    state: "unknown",
    outcome: { reason: "previous_partial_close_acknowledgement_unknown" },
  };
  store.data.intents.push(priorIntent);
  await store.enqueue(confirmedImpulseSignal(
    "ETHUSDT", "fresh-eth-unblocked-by-ake-source-exit",
  ));
  const exchange = freshEntryExchange({ symbol: "ETHUSDT" });
  const { worker } = makeFreshSignalWorker(
    store, exchange, ["AKEUSDT", "ETHUSDT"], undefined, true,
  );

  const preparation = await worker.runOnce();
  assert.equal(preparation.kind, "prepared", JSON.stringify(preparation));
  const brokerClientOrderId = `vst-${createHash("sha256")
    .update(priorIntentClientOrderId).digest("hex").slice(0, 28)}`;
  const priorIntentQueriesAfterFirstTick = exchange.calls.filter(([kind, identifier]) =>
    kind === "queryOrder" &&
    identifier?.clientOrderId === brokerClientOrderId).length;
  assert.equal(priorIntentQueriesAfterFirstTick, 1,
    "the read-only prerequisite is attempted once, not again in normal reconciliation");
  exchange.setMarkPrice("101");
  const result = await worker.runOnce();
  assert.equal(result.kind, "acted", JSON.stringify(result));
  assert.equal(result.operation, "cancel_original_stop");
  assert.equal(store.data.positions.find((row) =>
    row.sourceSignalId === "fresh-eth-unblocked-by-ake-source-exit")
    .snapshot.split.stage, "complete");
  assert.ok(exchange.writes.some(([kind]) => kind === "placeEntry"),
    "the unrelated fresh ETH candidate progresses");
  assert.equal(exchange.writes.some(([kind]) =>
    kind === "closeLong" || kind === "closePreRunnerSplit"), false,
  "the accepted AKE close is never posted behind its unknown predecessor");
  assert.equal(store.data.sourceExitRequests[0].state, "pending");
  assert.equal(store.data.intents.find((item) =>
    item.clientOrderId === priorIntent.clientOrderId).state, "unknown");
  assert.equal(exchange.calls.filter(([kind, identifier]) =>
    kind === "queryOrder" &&
    identifier?.clientOrderId === brokerClientOrderId).length, 2,
  "each tick performs at most one read-only prerequisite reconciliation");
});

async function handoffFixture({
  sourceExitsEnabled = false,
  decorateBroker = (broker) => broker,
  ambiguousCoreStop = false,
} = {}) {
  // Reuse the real completed-position fixture so this unrelated management
  // pass exercises a valid, durable open position rather than a synthetic row.
  const { store } = await completeSplitFixture();
  // durableStore's compact fixture setter treats every position as if it
  // belonged to the updated signal. Keep the existing unrelated ETH ledger
  // record open when the BTC candidate moves through planning/opening.
  store.setSignalStatus = async (sourceSignalId, status, reason = null) => {
    store.data.status = status;
    store.data.reason = reason;
    if (store.data.pending?.sourceSignalId === sourceSignalId) {
      store.data.pending.status = status;
    }
    const position = store.data.positions.find((row) =>
      row.sourceSignalId === sourceSignalId);
    if (position) position.status = status;
  };
  const exchange = freshEntryExchange({
    symbol: "BTCUSDT",
    initialLeverage: 75,
    initialMarginMode: "CROSSED",
    ambiguousCoreStop,
  });
  const freshReads = { capabilities: 0, account: 0 };
  let managedPositionReads = 0;
  let now = NOW;
  const { broker, worker } = makeFreshSignalWorker(
    store,
    exchange,
    ["BTCUSDT", SYMBOL],
    (value) => {
      const readPosition = value.readPosition.bind(value);
      const readDecorator = {
        ...value,
        async readPosition(symbol, ...args) {
          if (String(symbol).replace(/[^A-Za-z0-9]/g, "") === SYMBOL) {
            managedPositionReads += 1;
            // Match the existing regression's bounded, symbol-local managed
            // position read failure while allowing unrelated entry work.
            throw new Error("VST mark is not corroborated by a fresh quote");
          }
          return readPosition(symbol, ...args);
        },
      };
      const decorated = { ...decorateBroker(readDecorator) };
      const getCapabilities = decorated.getCapabilities.bind(decorated);
      const readAccountState = decorated.readAccountState.bind(decorated);
      Object.defineProperties(decorated, {
        getCapabilities: {
          configurable: true,
          value: async (...args) => {
            freshReads.capabilities += 1;
            return getCapabilities(...args);
          },
        },
        readAccountState: {
          configurable: true,
          value: async (...args) => {
            freshReads.account += 1;
            return readAccountState(...args);
          },
        },
      });
      return decorated;
    },
    sourceExitsEnabled,
    () => now,
  );
  const target = confirmedImpulseSignal(
    "BTCUSDT", "handoff-target-btc",
  );
  return {
    store, exchange, broker, worker, target, freshReads,
    get managedPositionReads() { return managedPositionReads; },
    advanceClock(milliseconds) { now += milliseconds; },
  };
}

test("prepared VST entry handoff skips only repeated position management, with fresh account checks each tick", async () => {
  const fixture = await handoffFixture();
  const {
    store, exchange, worker, target, freshReads, advanceClock,
  } = fixture;
  await worker.enqueue(target);

  const margin = await worker.runOnce();
  assert.equal(margin.kind, "prepared", JSON.stringify(margin));
  assert.equal(margin.reason, "isolated_margin_mode_confirmed");
  assert.equal(fixture.managedPositionReads, 1);
  assert.deepEqual(exchange.writes.map(([kind]) => kind), ["setMarginIsolated"]);

  advanceClock(250);
  const leverage = await worker.runOnce();
  assert.equal(leverage.kind, "prepared", JSON.stringify(leverage));
  assert.equal(leverage.reason, "isolated_leverage_confirmed");
  assert.equal(fixture.managedPositionReads, 1,
    "the exact prepared continuation does not repeat unrelated management");
  assert.deepEqual(exchange.writes.map(([kind]) => kind),
    ["setMarginIsolated", "setLeverage10"]);

  advanceClock(250);
  const entry = await worker.runOnce();
  assert.notEqual(entry.kind, "prepared", JSON.stringify(entry));
  assert.equal(exchange.writes.filter(([kind]) => kind === "placeEntry").length, 1);
  assert.equal(fixture.managedPositionReads, 1,
    "entry continuation also skips only the already-completed position sweep");
  assert.equal(exchange.writes.filter(([kind]) => kind === "placeEntry").length, 1);
  assert.equal(freshReads.capabilities, 3,
    "capabilities are freshly inspected for every continuation tick");
  assert.ok(freshReads.account >= 3,
    "the verified account snapshot is freshly read for every continuation tick");
  const accountReadsAfterEntry = freshReads.account;

  // This lightweight exchange fixture deliberately leaves the first split-stop
  // phase unresolved. Model its later durable reconciliation so the following
  // tick can reach the ordinary position-management sweep.
  const splitIntent = store.data.intents.find((row) =>
    row.sourceSignalId === target.sourceSignalId &&
    row.request.operation === "split_core_stop");
  if (splitIntent) {
    store.data.intents.splice(store.data.intents.indexOf(splitIntent), 1);
  }
  advanceClock(250);
  const afterEntry = await worker.runOnce();
  assert.notEqual(afterEntry.kind, "prepared", JSON.stringify(afterEntry));
  assert.ok(fixture.managedPositionReads > 1,
    `after the entry result, ordinary position management resumes: ${JSON.stringify(afterEntry)}; reads=${fixture.managedPositionReads}`);
  assert.equal(freshReads.capabilities, 4);
  assert.ok(freshReads.account > accountReadsAfterEntry);
});

test("source exits and same-symbol or symbol-less unresolved intents defeat a prepared handoff", async (t) => {
  await t.test("accepted source exit", async () => {
    const fixture = await handoffFixture({
      sourceExitsEnabled: true,
    });
    const { store, exchange, worker, target } = fixture;
    await worker.enqueue(target);
    const prepared = await worker.runOnce();
    assert.equal(prepared.kind, "prepared");
    enqueueAcceptedSourceExit(store, acceptedOldSourceExitRequest(
      target.sourceSignalId,
      `source-exit-${target.sourceSignalId}`,
      { symbol: target.symbol },
    ));

    await worker.runOnce();
    assert.equal(exchange.writes.some(([kind]) => kind === "setLeverage10"), false,
      "source-exit processing wins before continuation planning");
    assert.ok(fixture.managedPositionReads >= 1);
  });

  for (const intentSymbol of ["BTCUSDT", undefined]) {
    await t.test(intentSymbol ?? "symbol-less unresolved intent", async () => {
      const fixture = await handoffFixture();
      const { store, exchange, worker, target } = fixture;
      await worker.enqueue(target);
      const prepared = await worker.runOnce();
      assert.equal(prepared.kind, "prepared");
      store.data.intents.push({
        sourceSignalId: intentSymbol
          ? target.sourceSignalId : "handoff-unresolved-blocker",
        phase: "manual-unresolved-phase",
        clientOrderId: `handoff-unresolved-${intentSymbol ?? "global"}`,
        request: {
          operation: "set_isolated_leverage",
          environment: "vst",
          accountId: ACCOUNT,
          leverage: 10,
          marginMode: "ISOLATED",
          ...(intentSymbol ? { symbol: intentSymbol } : {}),
        },
        state: "prepared",
        outcome: { reason: "manual_review_required" },
      });

      const blocked = await worker.runOnce();
      assert.notEqual(blocked?.reason, "isolated_leverage_confirmed");
      assert.equal(exchange.writes.some(([kind]) =>
        kind === "setLeverage10" || kind === "placeEntry"), false,
      "unresolved intent gates run before the prepared continuation");
      assert.notEqual(blocked.kind === "prepared" &&
        blocked.reason === "isolated_leverage_confirmed", true,
      "the unresolved intent wins before the prepared continuation");
    });
  }
});

test("a changed priority head or entry error clears the prepared handoff", async (t) => {
  await t.test("pending priority head changed", async () => {
    const fixture = await handoffFixture();
    const { store, exchange, worker, target } = fixture;
    await worker.enqueue(target);
    assert.equal((await worker.runOnce()).reason, "isolated_margin_mode_confirmed");
    const differentHead = confirmedImpulseSignal(
      "BTCUSDT", "handoff-new-priority-head",
    );
    differentHead.signalAt = new Date(NOW - 30 * 60_000).toISOString();
    store.data.pending = {
      sourceSignalId: differentHead.sourceSignalId,
      body: differentHead,
      status: "pending",
    };

    await worker.runOnce();
    assert.equal(exchange.writes.some(([kind]) => kind === "setLeverage10"), false,
      "a different pending head cannot borrow the old signal's handoff");
    assert.equal(exchange.writes.some(([kind]) =>
      kind === "setLeverage10" || kind === "placeEntry"), false);
  });

  await t.test("entry failure", async () => {
    const fixture = await handoffFixture({
      ambiguousCoreStop: false,
    });
    const { store, exchange, worker, target } = fixture;
    await worker.enqueue(target);
    assert.equal((await worker.runOnce()).reason, "isolated_margin_mode_confirmed");
    assert.equal((await worker.runOnce()).reason, "isolated_leverage_confirmed");
    exchange.api.placeVstAutomatedLong = async () => {
      throw new Error("simulated_entry_transport_failure");
    };

    await worker.runOnce();
    const capabilitiesAtFailure = fixture.freshReads.capabilities;
    await worker.runOnce();
    assert.ok(fixture.freshReads.capabilities > capabilitiesAtFailure,
      "the following tick uses a fresh full worker pass rather than the old continuation");
    assert.equal(exchange.writes.some(([kind]) => kind === "placeEntry"), false);
  });
});

test("an unverified account snapshot cancels the prepared handoff", async () => {
  let denyAccountRead = false;
  const fixture = await handoffFixture({
    decorateBroker(value) {
      const read = value.readAccountState.bind(value);
      return {
        ...value,
        async readAccountState() {
          return denyAccountRead
          ? { verified: false, environment: "vst", accountId: ACCOUNT,
            positions: [], openOrders: [] }
            : read();
        },
      };
    },
  });
  const { exchange, broker, worker, target } = fixture;
  await worker.enqueue(target);
  assert.equal((await worker.runOnce()).reason, "isolated_margin_mode_confirmed");
  denyAccountRead = true;
  const unverified = await worker.runOnce();
  assert.notEqual(unverified.kind, "prepared", JSON.stringify(unverified));
  assert.notEqual(unverified.reason, "isolated_leverage_confirmed");
  assert.equal(exchange.writes.some(([kind]) => kind === "setLeverage10"), false);
  const accountReadsBeforeNext = fixture.freshReads.account;
  denyAccountRead = false;

  await worker.runOnce();
  assert.ok(fixture.freshReads.account > accountReadsBeforeNext,
    "the cancelled handoff does not reuse an earlier account snapshot");
  assert.equal(typeof broker.readAccountState, "function");
});
test("fixed five-percent take latches a last-price touch between ticks and closes after the mark retraces", async () => {
  const { store, exchange } = await completeSplitFixture({ sourceExitClose: true });
  exchange.setMarkPrice("101");
  const { broker } = makeWorker(store, exchange, [SYMBOL], { environment: "vst" }, () => NOW, true);
  let lastPrice = "104.99";
  const watched = { ...broker, readLastPrices: async (symbols) => symbols.map((symbol) => ({
    verified: true, symbol, price: Number(lastPrice), priceDecimal: lastPrice,
    observedAt: new Date(NOW - 1_000).toISOString(), source: "last_trade",
  })) };
  const worker = createVstWorker({ store, broker: watched, clock: () => NOW,
    sourceExitsEnabled: true, strategyAuthority: "source", exitStrategy: "full_take_5pct" });
  await worker.tick();
  assert.equal(await worker.observeFullTakePrices(), 0, "below +5% is never latched");
  assert.notEqual(store.data.positions[0].status, "closed");
  lastPrice = "105";
  assert.equal(await worker.observeFullTakePrices(), 1);
  assert.equal(await worker.observeFullTakePrices(), 0, "a latched touch is not re-latched");
  assert.ok(store.data.events.some((row) => row[1] === "vst_full_take_touched"));
  for (let i = 0; i < 10 && store.data.positions[0].status !== "closed"; i++) {
    await worker.tick();
  }
  const position = store.data.positions[0];
  assert.equal(position.status, "closed", JSON.stringify({
    position, intents: store.data.intents, events: store.data.events.slice(-3),
  }));
  const closes = store.data.intents.filter(row => row.request.operation === "close_leg" &&
    row.request.reason === "fixed_price_take_profit_5pct");
  assert.equal(closes.length, 1);
  assert.equal(closes[0].request.sourceExit.evidence.observedPrice, "105");
  assert.equal(exchange.orders.length, 0);
});
