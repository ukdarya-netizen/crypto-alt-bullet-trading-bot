import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createVstBroker } from "../vst-broker.mjs";
import { getVstResultDiagnosticRef } from "../vst-diagnostics.mjs";
import { createVstWorker } from "../vst-worker.mjs";

const accountId = "recovery-test-account";
const symbol = "BTCUSDT";
const exchangeSymbol = "BTC-USDT";
const positionId = "position-2025-09-30-01";
const oldStopId = "old-stop-2025-10-01-01";
const newStopId = "raised-stop-2025-10-02-01";
const entryOrderId = "entry-2025-09-30-01";
const entryClientOrderId = "policy-recovery-entry-2025-09-30";
const exchangeEntryClientOrderId =
  `vst-${createHash("sha256").update(entryClientOrderId).digest("hex").slice(0, 28)}`;
const entryAt = Date.parse("2025-09-30T12:00:05.000Z");
const entryIntentAt = Date.parse("2025-09-30T12:00:00.000Z");
const recoveryAt = Date.parse("2025-10-02T12:00:00.000Z");

const oldStop = (orderId = oldStopId, stopPrice = "95", quantity = "0.1") => ({
  symbol: exchangeSymbol,
  orderId,
  type: "STOP_MARKET",
  status: "CANCELED",
  side: "SELL",
  positionSide: "LONG",
  positionId,
  origQty: String(quantity),
  stopPrice: String(stopPrice),
  workingType: "MARK_PRICE",
  executedQty: "0",
});
const raisedStop = (overrides = {}, orderId = newStopId, stopPrice = "96") => ({
  symbol: exchangeSymbol,
  orderId,
  type: "STOP_MARKET",
  status: "NEW",
  side: "SELL",
  positionSide: "LONG",
  positionId: "0",
  origQty: "0.1",
  stopPrice,
  workingType: "MARK_PRICE",
  executedQty: "0",
  ...overrides,
});

function createFixture({
  currentStop,
  queriedStop,
  old,
  activeStopId = newStopId,
  activeStopPrice = "96",
  canceledStopId = oldStopId,
  canceledStopPrice = "95",
  positionOverrides = {},
  positionMode = "HEDGE",
  marginMode = "ISOLATED",
  leverage = { longLeverage: 10 },
  priorOverrides = {},
  requestOverrides = {},
  queryError = null,
  historyStepMs = 0,
  pairDelayMs = 0,
} = {}) {
  const calls = [];
  const clockState = { value: recoveryAt };
  const activeOrder = currentStop ??
    raisedStop({ positionId }, activeStopId, activeStopPrice);
  const queriedOrder = queriedStop ?? activeOrder;
  const canceledOrder = old ?? oldStop(canceledStopId, canceledStopPrice);
  const prior = {
    sourceSignalId: "source-impulse-buy-2025-09-30-01",
    environment: "vst",
    accountId,
    symbol,
    status: "open",
    patternId: "impulse_buy",
    coreOpen: true,
    runnerOpen: false,
    split: { stage: "complete", activeLegs: ["core"] },
    exchangePositionId: positionId,
    coreStopPositionId: positionId,
    coreStopOrderId: canceledStopId,
    coreStopQuantity: "0.1",
    quantity: "0.1",
    entryClientOrderId,
    entryOrderId,
    entryOrderType: "MARKET",
    entryQuantity: "0.1",
    entryAt: new Date(entryAt).toISOString(),
    coreStopPrice: canceledStopPrice,
    verifiedProtectiveStops: {
      core: {
        verified: true,
        tranche: "core",
        orderId: canceledStopId,
        positionId,
        quantity: "0.1",
        stopPrice: canceledStopPrice,
      },
    },
    ...priorOverrides,
  };
  const request = {
    operation: "raise_stop",
    leg: "core",
    symbol,
    environment: "vst",
    accountId,
    sourceSignalId: prior.sourceSignalId,
    intentCreatedAt: recoveryAt,
    positionId,
    quantity: "0.1",
    previousQuantity: "0.1",
    stopPrice: activeStopPrice,
    entryClientOrderId,
    entryOrderId,
    entryQuantity: "0.1",
    entryOrderType: "MARKET",
    entryAt: new Date(entryAt).toISOString(),
    entryProof: {
      entryClientOrderId,
      entryOrderId,
      positionId,
      entryOrderType: "MARKET",
      intentCreatedAt: entryIntentAt,
      quantity: "0.1",
    },
    priorPosition: prior,
    ...requestOverrides,
  };
  const historyOrder = {
    symbol: exchangeSymbol,
    orderId: entryOrderId,
    clientOrderId: exchangeEntryClientOrderId,
    status: "FILLED",
    side: "BUY",
    type: "MARKET",
    executedQty: "0.1",
    positionId,
  };
  const api = {
    async queryOrder(_symbol, identifier) {
      calls.push(["queryOrder", identifier?.orderId]);
      clockState.value += historyStepMs;
      if (queryError && identifier?.orderId === activeStopId) throw queryError;
      if (identifier?.orderId === activeStopId) return queriedOrder;
      if (identifier?.orderId === canceledStopId) return canceledOrder;
      if (identifier?.orderId === entryOrderId) return historyOrder;
      return null;
    },
    async queryOrderHistory() {
      calls.push(["queryOrderHistory"]);
      return [];
    },
    async queryFills(_symbol, range) {
      calls.push(["queryFills", range.orderId]);
      clockState.value += historyStepMs;
      return [{
        symbol: exchangeSymbol,
        orderId: entryOrderId,
        side: "BUY",
        positionSide: "LONG",
        volume: "0.1",
        price: "100",
        filledTm: entryAt,
      }];
    },
    async getPositions() {
      calls.push(["getPositions"]);
      clockState.value += pairDelayMs;
      return [{
        symbol: exchangeSymbol,
        positionSide: "LONG",
        positionAmt: "0.1",
        avgPrice: "100",
        positionId,
        ...positionOverrides,
      }];
    },
    async getOpenOrders() {
      calls.push(["getOpenOrders"]);
      return [activeOrder];
    },
    async getVstMarkPrice() { return { symbol: exchangeSymbol, markPrice: "100", timestamp: recoveryAt }; },
    async placeVstAutomatedLong() { throw new Error("unexpected mutation"); },
    async upgradeVstLongStop() { throw new Error("unexpected mutation"); },
    async closeLong() { throw new Error("unexpected mutation"); },
    async getBalance() { return [{ asset: "VST", balance: "100" }]; },
    async getPositionMode() {
      calls.push(["getPositionMode"]);
      return positionMode;
    },
    async getMarginType() {
      calls.push(["getMarginType"]);
      return marginMode;
    },
    async getLeverage() {
      calls.push(["getLeverage"]);
      return typeof leverage === "number" ? { longLeverage: leverage } : leverage;
    },
    async contract() {
      calls.push(["contract"]);
      return { symbol: exchangeSymbol, pricePrecision: 1 };
    },
    async getRiskTiers() { return []; },
    async getFeeRate() { return { maker: 0, taker: 0 }; },
    async getFunding() { return { rate: 0, nextFundingTime: recoveryAt + 60_000 }; },
    async setVstLongLeverage10() {},
  };
  const broker = createVstBroker({
    api,
    accountId,
    canarySymbols: [symbol],
    clock: () => clockState.value,
    stopBufferRate: 0.01,
  });
  return { broker, calls, request, api, activeStopId };
}

async function reconcile(fixture, exchangeOrderId = newStopId) {
  return fixture.broker.reconcileIntent({
    clientOrderId: "worker-policy-recovery",
    phase: `raise_stop-core-${recoveryAt}-0`,
    exchangeOrderId,
    request: fixture.request,
  });
}

function createActualPolicyShapeFixture() {
  const fixture = createFixture();
  const quantity = "18850.91";
  const actualPositionId = "position-actual-policy-2025-09-30";
  const actualOldStopId = "old-stop-actual-policy";
  const actualNewStopId = "new-stop-actual-policy";
  const actualEntryOrderId = "entry-actual-policy";
  const actualEntryClientId = "actual-policy-entry-client";
  const actualEntryIntentAt = Date.parse("2025-09-30T12:00:00.000Z");
  const actualEntryAt = Date.parse("2025-09-30T12:00:05.000Z");
  const old = {
    symbol: exchangeSymbol,
    orderId: actualOldStopId,
    type: "STOP_MARKET",
    status: "CANCELED",
    side: "SELL",
    positionSide: "LONG",
    positionId: actualPositionId,
    origQty: quantity,
    stopPrice: "0.4408",
    workingType: "MARK_PRICE",
    executedQty: "0",
  };
  const live = {
    symbol: exchangeSymbol,
    orderId: actualNewStopId,
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionId: actualPositionId,
    origQty: quantity,
    stopPrice: "0.4915",
    workingType: "MARK_PRICE",
    executedQty: "0",
  };
  fixture.request.quantity = Number(quantity);
  fixture.request.previousQuantity = Number(quantity);
  fixture.request.stopPrice = "0.4915";
  fixture.request.positionId = actualPositionId;
  fixture.request.entryAt = new Date(actualEntryAt).toISOString();
  fixture.request.entryClientOrderId = actualEntryClientId;
  delete fixture.request.entryOrderId;
  delete fixture.request.entryQuantity;
  delete fixture.request.entryOrderType;
  fixture.request.entryProof = {
    quantity,
    positionId: actualPositionId,
    entryOrderId: actualEntryOrderId,
    entryOrderType: "MARKET",
    intentCreatedAt: actualEntryIntentAt,
    entryClientOrderId: actualEntryClientId,
  };
  const prior = fixture.request.priorPosition;
  prior.sourceSignalId = fixture.request.sourceSignalId;
  prior.environment = "vst";
  prior.accountId = accountId;
  prior.symbol = symbol;
  prior.status = "open";
  prior.coreOpen = true;
  prior.runnerOpen = false;
  delete prior.split;
  prior.exchangePositionId = actualPositionId;
  prior.coreStopPositionId = actualPositionId;
  prior.positionId = actualPositionId;
  prior.coreStopOrderId = actualOldStopId;
  prior.coreStopQuantity = Number(quantity);
  prior.quantity = Number(quantity);
  prior.remainingQty = Number(quantity);
  prior.coreQty = Number(quantity);
  prior.runnerQty = 0;
  prior.stopPrice = 0.4408;
  prior.coreStopPrice = 0.4408;
  prior.entryClientOrderId = actualEntryClientId;
  prior.entryOrderType = "MARKET";
  delete prior.entryOrderId;
  delete prior.entryQuantity;
  prior.entryAt = new Date(actualEntryAt).toISOString();
  prior.verifiedProtectiveStops = {
    core: {
      orderId: actualOldStopId,
      quantity: Number(quantity),
      verified: true,
      stopPrice: 0.4408,
      positionId: actualPositionId,
    },
  };
  fixture.request = JSON.parse(JSON.stringify(fixture.request));

  fixture.api.queryOrder = async (_symbol, identifier) => {
    fixture.calls.push(["queryOrder", identifier?.orderId]);
    if (identifier?.orderId === actualNewStopId) return { ...live, positionId: "0" };
    if (identifier?.orderId === actualOldStopId) return old;
    if (identifier?.orderId === actualEntryOrderId) {
      return {
        symbol: exchangeSymbol,
        orderId: actualEntryOrderId,
        clientOrderId: `vst-${createHash("sha256").update(actualEntryClientId).digest("hex").slice(0, 28)}`,
        status: "FILLED",
        side: "BUY",
        type: "MARKET",
        executedQty: quantity,
        positionId: actualPositionId,
      };
    }
    return null;
  };
  fixture.api.queryFills = async (_symbol, range) => {
    fixture.calls.push(["queryFills", range.orderId]);
    return [{
      symbol: exchangeSymbol,
      orderId: actualEntryOrderId,
      side: "BUY",
      positionSide: "LONG",
      volume: quantity,
      price: "0.4915",
      filledTm: actualEntryAt,
    }];
  };
  fixture.api.getPositions = async () => {
    fixture.calls.push(["getPositions"]);
    return [{
      symbol: exchangeSymbol,
      positionSide: "LONG",
      positionAmt: quantity,
      avgPrice: "0.4915",
      positionId: actualPositionId,
    }];
  };
  fixture.api.getOpenOrders = async () => {
    fixture.calls.push(["getOpenOrders"]);
    return [live];
  };
  return {
    ...fixture,
    actualNewStopId,
    actualPositionId,
    actualEntryOrderId,
    actualEntryAt,
    actualEntryIntentAt,
  };
}

async function captureDiagnostics(callback) {
  const writers = [process.stdout.write, process.stderr.write];
  const records = [];
  for (const [index, stream] of [process.stdout, process.stderr].entries()) {
    stream.write = function (line, ...args) {
      if (typeof line === "string" && line.startsWith("Bullet VST diagnostic: ")) {
        records.push(JSON.parse(line.slice("Bullet VST diagnostic: ".length)));
        return true;
      }
      return writers[index].call(this, line, ...args);
    };
  }
  try {
    return { result: await callback(), records };
  } finally {
    process.stdout.write = writers[0];
    process.stderr.write = writers[1];
  }
}

function createWorkerLedger(position) {
  const intents = [];
  const commits = [];
  let savedPosition = structuredClone(position);
  const store = {
    intents,
    commits,
    get position() { return savedPosition; },
    async withLeaderLock(callback) { return callback(); },
    async getPending() { return null; },
    async reserveIntent() {
      throw new Error("recovery must not reserve or submit a replacement intent");
    },
    async getIntent(clientOrderId, phase) {
      return intents.find((intent) =>
        intent.clientOrderId === clientOrderId ||
        intent.sourceSignalId === clientOrderId && intent.phase === phase) ?? null;
    },
    async listUnresolvedIntents() {
      return intents.filter((intent) =>
        ["prepared", "submitted", "unknown"].includes(intent.state));
    },
    async listOpenPositions() { return []; },
    async getPosition() {
      return { sourceSignalId: savedPosition.sourceSignalId,
        symbol: savedPosition.symbol, status: savedPosition.status,
        snapshot: savedPosition };
    },
    async commitVerifiedIntent(commit) {
      const intent = intents.find((row) =>
        row.clientOrderId === commit.clientOrderId);
      assert.ok(intent, "verified intent and position are committed together");
      commits.push(commit);
      savedPosition = structuredClone(commit.position);
      Object.assign(intent, {
        state: "reconciled",
        exchangeOrderId: commit.exchangeOrderId,
        outcome: structuredClone(commit.outcome),
      });
      return { replayed: false };
    },
    async markIntent(clientOrderId, state, patch = {}) {
      const intent = intents.find((row) => row.clientOrderId === clientOrderId);
      assert.ok(intent);
      Object.assign(intent, patch, { state });
    },
    async setSignalStatus() {},
    async recordEvent() {},
    addIntent(intent) { intents.push(intent); },
  };
  return store;
}

async function recoverThroughWorker(fixture, store, request, clientOrderId, phase) {
  const intent = {
    clientOrderId,
    sourceSignalId: request.sourceSignalId,
    phase,
    exchangeOrderId: fixture.activeStopId ?? newStopId,
    request,
    state: "submitted",
  };
  store.addIntent(intent);
  const broker = fixture.broker;
  const worker = createVstWorker({
    store,
    broker,
    clock: () => recoveryAt,
    sizingLimits: { environment: "vst" },
  });
  return { result: await worker.runOnce(), intent };
}

test("persisted raise-stop policy is safely reconstructed and adopted read-only", async () => {
  const fixture = createFixture({ historyStepMs: 1_100, pairDelayMs: 2_200 });
  const evidence = await reconcile(fixture);

  assert.equal(evidence.verified, true);
  assert.equal(evidence.status, "filled");
  assert.equal(evidence.exchangeOrderId, newStopId);
  assert.deepEqual(Object.keys(evidence.protectiveStops), ["core"]);
  assert.equal(evidence.protectiveStops.core.orderId, newStopId);
  assert.equal(evidence.position.positionId, positionId);
  assert.equal(evidence.position.leverage, 10);
  assert.equal(evidence.position.marginMode, "ISOLATED");
  assert.equal(evidence.position.positionMode, "HEDGE");
  assert.equal(evidence.position.protectiveStops.core.orderId, newStopId);
  assert.equal(fixture.calls.filter(([method]) => method === "queryOrder").length, 3);
  assert.equal(fixture.calls.some(([method]) =>
    ["upgradeVstLongStop", "cancelVstOrder"].includes(method)), false);
  const pairIndex = fixture.calls.findIndex(([method], index) =>
    method === "getPositions" &&
    fixture.calls[index + 1]?.[0] === "getOpenOrders");
  assert.deepEqual(fixture.calls.slice(pairIndex, pairIndex + 2)
    .map(([method]) => method),
    ["getPositions", "getOpenOrders"],
  "the last observation is a fresh position/open-order pair after historical proof");
  const fillProofIndex = fixture.calls.findIndex(([method]) => method === "queryFills");
  const finalPairIndex = fixture.calls.findIndex(([method]) => method === "getPositions");
  for (const method of ["getPositionMode", "getMarginType", "getLeverage"]) {
    const settingsIndex = fixture.calls.findIndex(([called]) => called === method);
    assert.ok(fillProofIndex < settingsIndex && settingsIndex < finalPairIndex,
      `${method} follows entry-history proof and precedes the final pair`);
  }
  for (const method of ["contract", "getPositions", "getOpenOrders",
    "getPositionMode", "getMarginType", "getLeverage"]) {
    assert.equal(fixture.calls.filter(([called]) => called === method).length, 1,
      `${method} belongs to one independently acquired final native snapshot`);
  }
  assert.ok(fixture.calls.findIndex(([method]) => method === "queryFills") <
    fixture.calls.findIndex(([method]) => method === "getPositions"));
});

test("actual serialized raise-stop producer shape recovers entry metadata from entryProof", async () => {
  const fixture = createActualPolicyShapeFixture();
  const request = JSON.parse(JSON.stringify(fixture.request));
  assert.equal(Object.hasOwn(request, "entryOrderId"), false);
  assert.equal(Object.hasOwn(request, "entryQuantity"), false);
  assert.equal(Object.hasOwn(request.priorPosition, "entryOrderId"), false);
  assert.equal(Object.hasOwn(request.priorPosition, "entryQuantity"), false);
  assert.equal(Object.hasOwn(request.priorPosition.verifiedProtectiveStops.core,
    "tranche"), false);
  assert.equal(request.entryProof.entryOrderId, fixture.actualEntryOrderId);
  assert.equal(request.entryProof.quantity, "18850.91");

  const evidence = await reconcile(fixture, fixture.actualNewStopId);
  assert.equal(evidence.verified, true);
  assert.equal(evidence.status, "filled");
  assert.equal(evidence.exchangeOrderId, fixture.actualNewStopId);
  assert.equal(evidence.position.positionId, fixture.actualPositionId);
  assert.equal(evidence.position.leverage, 10);
  assert.equal(evidence.position.marginMode, "ISOLATED");
  assert.equal(evidence.position.positionMode, "HEDGE");
  assert.equal(evidence.protectiveStops.core.orderId, fixture.actualNewStopId);
  assert.equal(fixture.calls.some(([method, id]) =>
    method === "queryOrder" && id === fixture.actualEntryOrderId), true);
  assert.equal(fixture.calls.some(([method]) =>
    ["upgradeVstLongStop", "cancelVstOrder"].includes(method)), false);
});

test("legacy NULL-ID raise-stop can adopt only exact, freshly active sole-core protection", async () => {
  const fixture = createActualPolicyShapeFixture();
  const request = JSON.parse(JSON.stringify(fixture.request));
  request.intentCreatedAt = recoveryAt - 8 * 60 * 60_000;
  const liveOrder = fixture.api.getOpenOrders;
  const activeRows = await liveOrder();
  activeRows[0].createTime = request.intentCreatedAt + 34_000;
  fixture.api.getOpenOrders = async () => activeRows;

  const evidence = await fixture.broker.verifyUnlinkedRaiseStopProtection({ request });
  assert.equal(evidence.verified, true, JSON.stringify(evidence));
  assert.equal(evidence.currentProtectionOnly, true);
  assert.equal(evidence.exchangeOrderId, fixture.actualNewStopId);
  assert.equal(evidence.protectiveStops.core.orderId, fixture.actualNewStopId);
  assert.equal(fixture.calls.some(([method]) =>
    ["upgradeVstLongStop", "cancelVstOrder"].includes(method)), false);
});

test("legacy NULL-ID raise-stop adopts a verified candidate beside its persisted old stop", async () => {
  const fixture = createActualPolicyShapeFixture();
  const request = JSON.parse(JSON.stringify(fixture.request));
  request.intentCreatedAt = recoveryAt;
  const candidate = {
    ...(await fixture.api.getOpenOrders())[0],
    createTime: recoveryAt,
    positionId: fixture.actualPositionId,
    mainOrderId: "",
    parentOrderId: null,
  };
  const old = {
    symbol: exchangeSymbol,
    orderId: fixture.request.priorPosition.coreStopOrderId,
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionId: fixture.actualPositionId,
    origQty: "18850.91",
    stopPrice: "0.4408",
    workingType: "MARK_PRICE",
    executedQty: "0",
  };
  fixture.api.getOpenOrders = async () => [old, candidate];
  const originalQueryOrder = fixture.api.queryOrder;
  fixture.api.queryOrder = async (_symbol, identifier) =>
    identifier?.orderId === candidate.orderId ? { ...candidate, positionId: "0" } :
      identifier?.orderId === old.orderId ? old :
        originalQueryOrder(_symbol, identifier);

  const readPositions = fixture.api.getPositions;
  let marketTick = 0;
  fixture.api.getPositions = async (...args) =>
    (await readPositions(...args)).map(row => ({
      ...row, unrealizedProfit: String(++marketTick),
      markPrice: String(100 + marketTick), updateTime: recoveryAt + marketTick,
    }));
  const evidence = await fixture.broker.verifyUnlinkedRaiseStopProtection({ request });
  assert.equal(evidence.verified, true, JSON.stringify(evidence));
  assert.equal(evidence.currentProtectionOnly, true);
  assert.equal(evidence.exchangeOrderId, fixture.actualNewStopId);
  assert.equal(evidence.protectiveStops.core.orderId, fixture.actualNewStopId);
  assert.deepEqual(evidence.oldStopRetirement, {
    oldStop: {
      orderId: old.orderId,
      positionId: fixture.actualPositionId,
      quantity: "18850.91",
      stopPrice: "0.4408",
    },
    adoptedStop: {
      orderId: fixture.actualNewStopId,
      positionId: fixture.actualPositionId,
      quantity: "18850.91",
      stopPrice: "0.4915",
    },
  });
  assert.equal(fixture.calls.some(([method]) =>
    ["upgradeVstLongStop", "cancelVstOrder"].includes(method)), false);
});

test("two-stop NULL-ID adoption permits blank parents but rejects ambiguous snapshots", async (t) => {
  for (const [name, mutate] of [
    ["foreign candidate parent", (old, candidate) => {
      candidate.mainOrderId = "foreign-entry";
    }],
    ["third open order", (old, candidate) => {
      return [old, candidate, { ...candidate, orderId: "third-stop" }];
    }],
    ["old-stop snapshot changed", (old, candidate) => {
      old.stopPrice = "0.4409";
    }],
  ]) {
    await t.test(name, async () => {
      const fixture = createActualPolicyShapeFixture();
      const request = JSON.parse(JSON.stringify(fixture.request));
      request.intentCreatedAt = recoveryAt;
      const candidate = {
        ...(await fixture.api.getOpenOrders())[0],
        createTime: recoveryAt,
        positionId: fixture.actualPositionId,
        mainOrderId: "",
        parentOrderId: null,
      };
      const old = {
        symbol: exchangeSymbol,
        orderId: fixture.request.priorPosition.coreStopOrderId,
        type: "STOP_MARKET",
        status: "NEW",
        side: "SELL",
        positionSide: "LONG",
        positionId: fixture.actualPositionId,
        origQty: "18850.91",
        stopPrice: "0.4408",
        workingType: "MARK_PRICE",
        executedQty: "0",
      };
      const result = mutate(old, candidate);
      const rows = Array.isArray(result) ? result : [old, candidate];
      fixture.api.getOpenOrders = async () => rows;
      fixture.api.queryOrder = async (_symbol, identifier) =>
        identifier?.orderId === candidate.orderId ? { ...candidate, positionId: "0" } :
          identifier?.orderId === old.orderId ? old : null;
      const evidence = await fixture.broker.verifyUnlinkedRaiseStopProtection({ request });
      assert.equal(evidence.verified, false, name);
      assert.equal(fixture.calls.some(([method]) =>
        ["upgradeVstLongStop", "cancelVstOrder"].includes(method)), false);
    });
  }
});

test("adopted-stop retirement reconciles only a canceled old stop and sole current candidate", async () => {
  const fixture = createActualPolicyShapeFixture();
  const request = JSON.parse(JSON.stringify(fixture.request));
  const candidate = {
    ...(await fixture.api.getOpenOrders())[0],
    positionId: fixture.actualPositionId,
  };
  const old = {
    symbol: exchangeSymbol,
    orderId: fixture.request.priorPosition.coreStopOrderId,
    type: "STOP_MARKET",
    status: "CANCELED",
    side: "SELL",
    positionSide: "LONG",
    positionId: fixture.actualPositionId,
    origQty: "18850.91",
    stopPrice: "0.4408",
    workingType: "MARK_PRICE",
    executedQty: "0",
  };
  request.operation = "retire_adopted_stop";
  request.oldStop = {
    orderId: old.orderId, positionId: fixture.actualPositionId,
    quantity: "18850.91", stopPrice: "0.4408",
  };
  request.adoptedStop = {
    orderId: candidate.orderId, positionId: fixture.actualPositionId,
    quantity: "18850.91", stopPrice: "0.4915",
  };
  request.priorPosition.verifiedProtectiveStops.core = {
    verified: true, tranche: "core", orderId: candidate.orderId,
    positionId: fixture.actualPositionId, quantity: "18850.91", stopPrice: "0.4915",
  };
  request.priorPosition.coreStopOrderId = candidate.orderId;
  request.priorPosition.coreStopPrice = "0.4915";
  request.priorPosition.coreStopPositionId = fixture.actualPositionId;
  request.nextPosition = JSON.parse(JSON.stringify(request.priorPosition));
  request.nextPosition.verifiedProtectiveStops.core = {
    verified: true, tranche: "core", orderId: candidate.orderId,
    positionId: fixture.actualPositionId, quantity: "18850.91", stopPrice: "0.4915",
  };
  request.priorPosition.pendingStopRetirement = {
    oldStop: request.oldStop,
    adoptedStop: request.adoptedStop,
    entryProof: request.entryProof,
    originalIntent: {
      clientOrderId: "legacy-null-id-raise-intent",
      phase: `raise_stop-core-${recoveryAt}-0`,
    },
  };
  fixture.api.getOpenOrders = async () => [candidate];
  const originalQueryOrder = fixture.api.queryOrder;
  fixture.api.queryOrder = async (_symbol, identifier) =>
    identifier?.orderId === candidate.orderId ? { ...candidate, positionId: "0" } :
      identifier?.orderId === old.orderId ? old :
        originalQueryOrder(_symbol, identifier);

  const evidence = await fixture.broker.reconcileIntent({
    clientOrderId: "retire-adopted-stop",
    phase: "retire-adopted-stop",
    request,
  });
  assert.equal(evidence.verified, true, JSON.stringify(evidence));
  assert.equal(evidence.status, "filled");
  assert.equal(evidence.canceledStopOrderId, old.orderId);
  assert.equal(evidence.exchangeOrderId, old.orderId);
  assert.equal(evidence.protectiveStops.core.orderId, candidate.orderId);
  assert.equal(Object.hasOwn(evidence, "fills"), false);
  assert.equal(fixture.calls.some(([method]) =>
    ["upgradeVstLongStop", "cancelVstOrder"].includes(method)), false);
});

test("retire_adopted_stop submits only after pending snapshot and dual-stop proof match", async () => {
  const fixture = createActualPolicyShapeFixture();
  const candidate = {
    ...(await fixture.api.getOpenOrders())[0],
    createTime: recoveryAt,
    positionId: fixture.actualPositionId,
  };
  const old = {
    symbol: exchangeSymbol,
    orderId: fixture.request.priorPosition.coreStopOrderId,
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionId: fixture.actualPositionId,
    origQty: "18850.91",
    stopPrice: "0.4408",
    workingType: "MARK_PRICE",
    executedQty: "0",
  };
  fixture.api.getOpenOrders = async () => [old, candidate];
  const originalQueryOrder = fixture.api.queryOrder;
  fixture.api.queryOrder = async (_symbol, identifier) =>
    identifier?.orderId === candidate.orderId ? { ...candidate, positionId: "0" } :
      identifier?.orderId === old.orderId ? old :
        originalQueryOrder(_symbol, identifier);
  const calls = [];
  fixture.api.retireVstAutomatedAdoptedStop = async (details) => {
    calls.push(details);
  };
  const request = JSON.parse(JSON.stringify(fixture.request));
  request.operation = "retire_adopted_stop";
  request.oldStop = {
    orderId: old.orderId, positionId: fixture.actualPositionId,
    quantity: "18850.91", stopPrice: "0.4408",
  };
  request.adoptedStop = {
    orderId: candidate.orderId, positionId: fixture.actualPositionId,
    quantity: "18850.91", stopPrice: "0.4915",
  };
  request.priorPosition.verifiedProtectiveStops.core = {
    verified: true, tranche: "core", orderId: candidate.orderId,
    positionId: fixture.actualPositionId, quantity: "18850.91", stopPrice: "0.4915",
  };
  request.priorPosition.coreStopOrderId = candidate.orderId;
  request.priorPosition.coreStopPrice = "0.4915";
  request.priorPosition.coreStopPositionId = fixture.actualPositionId;
  request.nextPosition = JSON.parse(JSON.stringify(request.priorPosition));
  request.nextPosition.verifiedProtectiveStops.core = {
    verified: true, tranche: "core", orderId: candidate.orderId,
    positionId: fixture.actualPositionId, quantity: "18850.91", stopPrice: "0.4915",
  };
  request.priorPosition.pendingStopRetirement = {
    oldStop: request.oldStop,
    adoptedStop: request.adoptedStop,
    entryProof: request.entryProof,
    originalIntent: {
      clientOrderId: "legacy-null-id-raise-intent",
      phase: `raise_stop-core-${recoveryAt}-0`,
    },
  };

  const badPending = structuredClone(request);
  badPending.priorPosition.pendingStopRetirement.adoptedStop.orderId = "foreign-stop";
  await assert.rejects(() => fixture.broker.performIntent({
    clientOrderId: "retire-adopted-stop-bad-pending",
    phase: "retire-adopted-stop",
    request: badPending,
  }));
  const badSource = structuredClone(request);
  badSource.nextPosition.sourceSignalId = "foreign-source-signal";
  await assert.rejects(() => fixture.broker.performIntent({
    clientOrderId: "retire-adopted-stop-bad-source",
    phase: "retire-adopted-stop",
    request: badSource,
  }));
  assert.equal(calls.length, 0, "snapshot/source mismatches refuse before the native write");

  await fixture.broker.performIntent({
    clientOrderId: "retire-adopted-stop-intent",
    phase: "retire-adopted-stop",
    request,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    symbol,
    policy: "vst-automated-long-1pct",
    positionId: fixture.actualPositionId,
    entryOrderId: fixture.actualEntryOrderId,
    oldStopOrderId: old.orderId,
    oldStopPrice: "0.4408",
    newStopOrderId: candidate.orderId,
    stopPrice: "0.4915",
    quantity: "18850.91",
    cancellationIntentId:
      `vst-${createHash("sha256").update("retire-adopted-stop-intent").digest("hex").slice(0, 28)}`,
  });
});

test("unlinked protection adoption broker boundary rejects unsafe current evidence", async (t) => {
  const mutations = [
    ["stale-created-time", (rows) => { rows[0].createTime = recoveryAt - 61_000; }],
    ["wrong-parent", (rows) => { rows[0].mainOrderId = "foreign-entry"; }],
    ["wrong-position", (rows) => { rows[0].positionId = "foreign-position"; }],
    ["wrong-trigger", (rows) => { rows[0].stopPrice = "0.4916"; }],
    ["nonzero-execution", (rows) => { rows[0].executedQty = "0.01"; }],
    ["wrong-quantity", (rows) => { rows[0].origQty = "18850.90"; }],
    ["terminal-order", (rows) => { rows[0].status = "CANCELED"; }],
    ["extra-stop", (rows) => { rows.push({ ...rows[0], orderId: "extra-stop" }); }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const fixture = createActualPolicyShapeFixture();
      const request = JSON.parse(JSON.stringify(fixture.request));
      request.intentCreatedAt = recoveryAt - 35_000;
      const existing = await fixture.api.getOpenOrders();
      existing[0].createTime = recoveryAt;
      mutate(existing);
      fixture.api.getOpenOrders = async () => existing;
      const evidence = await fixture.broker.verifyUnlinkedRaiseStopProtection({ request });
      assert.equal(evidence.verified, false, name);
      assert.equal(fixture.calls.some(([method]) =>
        ["upgradeVstLongStop", "cancelVstOrder"].includes(method)), false);
    });
  }
});

test("raise-stop result requires exchange-backed hedge/isolated/10x settings", async () => {
  const invalidSettings = [
    ["wrong position mode", { positionMode: "ONE_WAY" }],
    ["wrong margin mode", { marginMode: "CROSSED" }],
    ["wrong leverage", { leverage: { longLeverage: 5 } }],
    ["missing position mode", { positionMode: null }],
    ["missing margin mode", { marginMode: null }],
    ["missing long leverage", { leverage: {} }],
  ];
  for (const [label, options] of invalidSettings) {
    const fixture = createFixture(options);
    const evidence = await reconcile(fixture);
    assert.deepEqual(
      { verified: evidence.verified, status: evidence.status },
      { verified: false, status: "unknown" },
      label,
    );
    assert.equal(fixture.calls.some(([method]) => method === "getLeverage"), true,
      `${label}: settings were read`);
    assert.equal(fixture.calls.some(([method]) =>
      ["upgradeVstLongStop", "closeLong", "retireVstAutomatedAdoptedStop"].includes(method)), false,
    `${label}: unsupported settings cannot authorize a mutation`);
  }

  const nativeWrongLeverage = createFixture({
    positionOverrides: { leverage: "9" },
  });
  assert.equal((await reconcile(nativeWrongLeverage)).verified, false,
    "a supplied native position leverage must agree with verified settings");

  const nativeWrongMargin = createFixture({
    positionOverrides: { marginMode: "CROSSED" },
  });
  assert.equal((await reconcile(nativeWrongMargin)).verified, false,
    "a supplied native position margin mode must be ISOLATED");
});

test("real broker native recovery atomically settles in worker and permits a successive raise", async () => {
  const firstFixture = createFixture();
  const initialPosition = {
    ...firstFixture.request.priorPosition,
    patternId: "impulse_buy",
    remainingQty: "0.1",
    coreQty: "0.1",
    leverage: 10,
    marginMode: "ISOLATED",
    split: {
      ...firstFixture.request.priorPosition.split,
      stage: "complete",
      positionId,
      totalQuantity: "0.1",
      coreQuantity: "0.1",
      runnerQuantity: "0",
      activeLegs: ["core"],
      coreStop: {
        verified: true,
        tranche: "core",
        orderId: oldStopId,
        positionId,
        quantity: "0.1",
        stopPrice: "95",
      },
      runnerStop: null,
    },
  };
  const firstNextPosition = structuredClone(initialPosition);
  firstNextPosition.split.coreStop = {
    verified: true,
    tranche: "core",
    orderId: newStopId,
    positionId,
    quantity: "0.1",
    stopPrice: "96",
  };
  const firstRequest = {
    ...firstFixture.request,
    priorPosition: initialPosition,
    nextPosition: firstNextPosition,
  };
  const ledger = createWorkerLedger(initialPosition);
  const { result: firstResult, intent: firstIntent } = await recoverThroughWorker(
    firstFixture, ledger, firstRequest, "native-raise-recovery-1",
    `raise_stop-core-${recoveryAt}-0`,
  );
  assert.equal(firstIntent.state, "reconciled", JSON.stringify(firstResult));
  assert.equal(ledger.commits.length, 1, "atomic worker commit follows verified native reads");
  assert.equal(ledger.commits[0].eventKind, "vst_impulse_sole_core_stop_raised");
  assert.equal(ledger.commits[0].outcome.stop.orderId, newStopId);
  assert.equal(ledger.position.leverage, 10);
  assert.equal(ledger.position.marginMode, "ISOLATED");
  assert.equal(ledger.position.verifiedProtectiveStops.core.orderId, newStopId);
  assert.equal(firstFixture.calls.some(([method]) =>
    ["upgradeVstLongStop", "cancelVstOrder"].includes(method)), false);

  const secondStopId = "raised-stop-2025-10-03-01";
  const secondFixture = createFixture({
    activeStopId: secondStopId,
    activeStopPrice: "97",
    canceledStopId: newStopId,
    canceledStopPrice: "96",
    currentStop: raisedStop({ positionId }, secondStopId, "97"),
    old: oldStop(newStopId, "96"),
    priorOverrides: {
      coreStopOrderId: newStopId,
      coreStopPositionId: positionId,
      coreStopPrice: "96",
      verifiedProtectiveStops: {
        core: {
          verified: true,
          tranche: "core",
          orderId: newStopId,
          positionId,
          quantity: "0.1",
          stopPrice: "96",
        },
      },
    },
    requestOverrides: { stopPrice: "97" },
  });
  const secondPrior = structuredClone(ledger.position);
  const secondNextPosition = structuredClone(secondPrior);
  secondNextPosition.split.coreStop = {
    verified: true,
    tranche: "core",
    orderId: secondStopId,
    positionId,
    quantity: "0.1",
    stopPrice: "97",
  };
  const secondRequest = {
    ...secondFixture.request,
    priorPosition: secondPrior,
    nextPosition: secondNextPosition,
  };
  const { result: secondResult, intent: secondIntent } = await recoverThroughWorker(
    secondFixture, ledger, secondRequest, "native-raise-recovery-2",
    `raise_stop-core-${recoveryAt + 1}-0`,
  );
  assert.equal(secondIntent.state, "reconciled", JSON.stringify(secondResult));
  assert.equal(ledger.commits.length, 2);
  assert.equal(ledger.commits[1].outcome.stop.orderId, secondStopId);
  assert.equal(ledger.position.verifiedProtectiveStops.core.orderId, secondStopId);
  assert.equal(Number(ledger.position.verifiedProtectiveStops.core.stopPrice), 97);
  assert.equal(secondFixture.calls.some(([method]) =>
    ["upgradeVstLongStop", "cancelVstOrder"].includes(method)), false);
});

test("native raise-stop reconciliation refuses changed exchange leverage or margin settings", async () => {
  for (const changedSettings of [
    { leverage: 5 },
    { marginMode: "CROSSED" },
    { positionMode: "ONE_WAY" },
  ]) {
    const fixture = createFixture(changedSettings);
    const evidence = await reconcile(fixture);
    assert.deepEqual(
      { verified: evidence.verified, status: evidence.status },
      { verified: false, status: "unknown" },
      JSON.stringify(changedSettings),
    );
    assert.equal(fixture.calls.some(([method]) =>
      ["upgradeVstLongStop", "cancelVstOrder"].includes(method)), false);
  }
});

test("worker never atomically commits native recovery after exchange settings change", async () => {
  for (const changedSettings of [
    { leverage: 5 },
    { marginMode: "CROSSED" },
  ]) {
    const fixture = createFixture(changedSettings);
    const initialPosition = {
      ...fixture.request.priorPosition,
      patternId: "impulse_buy",
      remainingQty: "0.1",
      coreQty: "0.1",
      leverage: 10,
      marginMode: "ISOLATED",
      split: {
        ...fixture.request.priorPosition.split,
        stage: "complete",
        positionId,
        totalQuantity: "0.1",
        coreQuantity: "0.1",
        runnerQuantity: "0",
        activeLegs: ["core"],
        coreStop: {
          verified: true,
          tranche: "core",
          orderId: oldStopId,
          positionId,
          quantity: "0.1",
          stopPrice: "95",
        },
        runnerStop: null,
      },
    };
    const nextPosition = structuredClone(initialPosition);
    nextPosition.split.coreStop = {
      verified: true,
      tranche: "core",
      orderId: newStopId,
      positionId,
      quantity: "0.1",
      stopPrice: "96",
    };
    const request = {
      ...fixture.request,
      priorPosition: initialPosition,
      nextPosition,
    };
    const ledger = createWorkerLedger(initialPosition);
    const { intent } = await recoverThroughWorker(
      fixture, ledger, request,
      `native-raise-changed-settings-${changedSettings.leverage ?? changedSettings.marginMode}`,
      `raise_stop-core-${recoveryAt}-0`,
    );
    assert.equal(ledger.commits.length, 0, JSON.stringify(changedSettings));
    assert.equal(intent.state, "unknown", JSON.stringify(changedSettings));
    for (const method of ["getPositionMode", "getMarginType", "getLeverage"]) {
      assert.ok(fixture.calls.some(([called]) => called === method),
        `worker independently read ${method}`);
    }
    assert.equal(fixture.calls.some(([method]) =>
      ["upgradeVstLongStop", "cancelVstOrder"].includes(method)), false);
  }
});

test("final position/order pair must complete within ten seconds of its own request start", async () => {
  const fixture = createFixture({ historyStepMs: 1_100, pairDelayMs: 10_001 });
  const evidence = await reconcile(fixture);
  assert.deepEqual(
    { verified: evidence.verified, status: evidence.status },
    { verified: false, status: "unknown" },
  );
  assert.deepEqual(fixture.calls.slice(-2).map(([method]) => method),
    ["getPositions", "getOpenOrders"]);
});

test("raise-stop policy recovery refuses conflicting, incomplete, or non-native evidence", async () => {
  const cases = [
    ["mismatched position aliases", () => createFixture({
      priorOverrides: { exchangePositionId: "foreign-position" },
    }), "historical_context_unavailable"],
    ["conflicting persisted core quantity", () => createFixture({
      priorOverrides: { remainingQty: "0.09", coreQty: "0.09" },
    }), "historical_context_unavailable"],
    ["runner quantity despite core-only state", () => createFixture({
      priorOverrides: { runnerQty: "0.01" },
    }), "historical_context_unavailable"],
    ["core-mapped stop falsely labels itself runner", () => {
      const fixture = createFixture();
      fixture.request.priorPosition.verifiedProtectiveStops.core.tranche = "runner";
      return fixture;
    }, "historical_context_unavailable"],
    ["optional entry ID alias conflicts with entryProof", () => createFixture({
      requestOverrides: { entryOrderId: "foreign-entry" },
    }), "historical_context_unavailable"],
    ["optional entry quantity alias conflicts with entryProof", () => createFixture({
      requestOverrides: { entryQuantity: "0.09" },
    }), "historical_context_unavailable"],
    ["missing immutable POST parent ID", () => createFixture(), null, "omit"],
    ["foreign submitted quantity", () => createFixture({
      currentStop: raisedStop({ origQty: "0.09" }),
      queriedStop: raisedStop({ origQty: "0.09" }),
    }), "submitted_stop_query_mismatch"],
    ["prior stop still active", () => createFixture({
      old: { ...oldStop(), status: "NEW", executedQty: "0" },
    }), "prior_stop_cancellation_unverified"],
    ["prior stop has a fill", () => createFixture({
      old: { ...oldStop(), executedQty: "0.001" },
    }), "prior_stop_cancellation_unverified"],
    ["untrusted source context", () => createFixture({
      requestOverrides: { sourceSignalId: "foreign-source" },
    }), "historical_context_unavailable"],
    ["conflicting native-order aliases", () => createFixture({
      queriedStop: raisedStop({ orderID: "different-stop" }),
    }), "submitted_stop_query_mismatch"],
  ];
  for (const [label, makeFixture, expectedCondition, submittedId] of cases) {
    const fixture = makeFixture();
    const evidence = await reconcile(fixture,
      submittedId === "omit" ? null : newStopId);
    assert.deepEqual(
      { verified: evidence.verified, status: evidence.status },
      { verified: false, status: "unknown" },
      label,
    );
    assert.match(getVstResultDiagnosticRef(evidence), /^[a-f0-9]{12}$/, label);
    if (expectedCondition) {
      assert.equal(fixture.calls.some(([method]) => method === "getPositions"),
        false, `${label}: reject before final-current-state reads`);
    } else {
      assert.equal(fixture.calls.length, 0, `${label}: missing POST ID causes no exchange read`);
    }
    assert.equal(fixture.calls.some(([method]) =>
      ["upgradeVstLongStop", "cancelVstOrder"].includes(method)), false, label);
  }
});

test("caught exchange errors are diagnosed with bounded proof context, not private response text", async () => {
  const fixture = createFixture({
    queryError: new Error("PRIVATE EXCHANGE RESPONSE MUST NOT BE LOGGED"),
  });
  const { result, records } = await captureDiagnostics(() => reconcile(fixture));
  assert.equal(result.verified, false);
  const diagnostic = records.find((record) =>
    record.proofEvidence?.condition === "read_or_validation_exception");
  assert.ok(diagnostic, "the refusal names its bounded GET/validation condition");
  assert.equal(JSON.stringify(records).includes("PRIVATE EXCHANGE RESPONSE MUST NOT BE LOGGED"),
    false);
});

test("query position ID zero is unavailable linkage; positive foreign IDs are rejected", async () => {
  const zeroLink = createFixture({ queriedStop: raisedStop({ positionId: "0" }) });
  const accepted = await reconcile(zeroLink);
  assert.equal(accepted.verified, true);

  const foreignLink = createFixture({
    queriedStop: raisedStop({ positionId: "foreign-position" }),
  });
  const refused = await reconcile(foreignLink);
  assert.deepEqual(
    { verified: refused.verified, status: refused.status },
    { verified: false, status: "unknown" },
  );
  assert.equal(foreignLink.calls.some(([method]) => method === "getPositions"), false);
});

test("mismatched final position, old-stop alias, and absent execution proof fail closed", async () => {
  const mismatchedPosition = createFixture({
    positionOverrides: { positionID: "different-position" },
  });
  assert.equal((await reconcile(mismatchedPosition)).verified, false);

  const mismatchedOldStop = createFixture({
    old: { ...oldStop(), orderID: "different-old-stop" },
  });
  assert.equal((await reconcile(mismatchedOldStop)).verified, false);

  const noExecution = createFixture({
    queriedStop: raisedStop({ executedQty: undefined }),
  });
  assert.equal((await reconcile(noExecution)).verified, false);
});