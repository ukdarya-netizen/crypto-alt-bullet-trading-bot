import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createVstBroker } from "../vst-broker.mjs";
import { sizeVstLongTrade } from "../vst-sizing.mjs";
import {
  BingXLiveApiError, createBingXOutboundPacer,
} from "../bingx-live-api.mjs";
import { getVstResultDiagnosticRef } from "../vst-diagnostics.mjs";

const now = 1_700_000_000_000;
const filters = {
  symbol: "BTC-USDT",
  quantityPrecision: 4,
  pricePrecision: 1,
  minQuantity: 0.001,
  minNotional: 5,
  maxLeverage: 10,
};

async function captureStopDiagnostics(callback) {
  const writes = [process.stdout.write, process.stderr.write];
  const observations = [];
  for (const [index, stream] of [process.stdout, process.stderr].entries()) {
    stream.write = function (line, ...args) {
      if (typeof line === "string" && line.startsWith("Bullet VST diagnostic: ")) {
        observations.push(JSON.parse(line.slice("Bullet VST diagnostic: ".length)));
        return true;
      }
      return writes[index].call(this, line, ...args);
    };
  }
  try { return { result: await callback(), observations }; }
  finally { process.stdout.write = writes[0]; process.stderr.write = writes[1]; }
}

test("triggered stop failures log exact guard and values without extra exchange reads or DTO fields", async () => {
  const request = {
    symbol: "BTCUSDT", positionId: "2105662972415795600",
    stopOrderId: "2105662972415795601", stopQuantity: "0.1",
    stopPrice: "95", previousQuantity: "0.1", startedAt: now - 1000,
  };
  const child = "2105662972415795602";
  const validOrder = { symbol: "BTC-USDT", orderId: child, type: "STOP_MARKET",
    status: "FILLED", side: "SELL", positionSide: "LONG", origQty: "0.1", executedQty: "0.1" };
  const validFill = { symbol: "BTC-USDT", orderId: child, triggerOrderId: request.stopOrderId,
    side: "SELL", positionSide: "LONG", volume: "0.1", price: "94.7",
    commission: "-0.01", currency: "VST", filledTm: now };
  for (const [order, fills, condition, field, expected, actual] of [
    [{ ...validOrder, status: "NEW" }, [validFill], "queried_stop_fields", "orderStatus", "FILLED", "NEW"],
    [{ ...validOrder, origQty: "0.09" }, [validFill], "order_quantity", "orderQuantity", "0.1", "0.09"],
    [validOrder, [], "linked_fill_count", "linkedFillCount", "1", "0"],
    [validOrder, [{ ...validFill, volume: "0.09" }], "fill_quantity", "filledQuantity", "0.1", "0.09"],
  ]) {
    const { broker, calls } = apiFixture({ queriedOrder: order, fills });
    const { result, observations } = await captureStopDiagnostics(() => broker.observeTriggeredStop(request));
    assert.deepEqual(result, { verified: false, status: "unknown" });
    const diagnostic = observations.find((item) => item.proofEvidence?.condition === condition);
    assert.ok(diagnostic, condition);
    const check = diagnostic.proofEvidence.checks.find((item) => item.field === field);
    assert.equal(check.expected, expected);
    assert.equal(check.actual, actual);
    assert.equal(check.matches, false);
    assert.match(getVstResultDiagnosticRef(result), /^[a-f0-9]{12}$/);
    assert.equal(calls.filter(([name]) => name === "positions").length, 1);
    assert.equal(calls.filter(([name]) => name === "openOrders").length, 1);
    assert.ok(diagnostic.callerFrames.some((item) => item.startsWith("vst-broker.mjs:")));
  }
});

test("triggered stop malformed decimals expose the exact field and missing-value state", async () => {
  const { broker, calls } = apiFixture();
  const { result, observations } = await captureStopDiagnostics(() => broker.observeTriggeredStop({
    symbol: "BTCUSDT", positionId: "2105662972415795700", stopOrderId: "2105662972415795701",
    stopQuantity: undefined, stopPrice: "95", previousQuantity: "0.1", startedAt: now - 1000,
  }));
  assert.deepEqual(result, { verified: false, status: "unknown" });
  const evidence = observations.find((item) =>
    item.proofEvidence?.validationField === "triggered_stop_quantity")?.proofEvidence;
  assert.ok(evidence);
  assert.equal(evidence.checks.find((item) => item.field === "numericValue").actualState, "missing");
  assert.equal(calls.length, 0);
});

test("triggered stop read errors retain GET identity without asserting stop absence", async () => {
  const { broker, api, calls } = apiFixture();
  api.queryOrder = async () => {
    throw new BingXLiveApiError("PRIVATE_RESPONSE_TEXT", { code: 109400,
      method: "GET", endpoint: "/openApi/swap/v2/trade/order", transportStage: "exchange_response" });
  };
  const { result, observations } = await captureStopDiagnostics(() => broker.observeTriggeredStop({
    symbol: "BTCUSDT", positionId: "2105662972415795800", stopOrderId: "2105662972415795801",
    stopQuantity: "0.1", stopPrice: "95", previousQuantity: "0.1", startedAt: now - 1000,
  }));
  assert.deepEqual(result, { verified: false, status: "unknown" });
  const diagnostic = observations.find((item) => item.proofEvidence?.condition === "read_or_validation_exception");
  assert.equal(diagnostic.method, "GET");
  assert.equal(diagnostic.endpoint, "/openApi/swap/v2/trade/order");
  assert.equal(diagnostic.code, "109400");
  assert.equal(JSON.stringify(observations).includes("PRIVATE_RESPONSE_TEXT"), false);
  assert.equal(diagnostic.stopEvidence?.positionPresent, undefined);
  assert.equal(calls.filter(([name]) => name === "positions").length, 1);
});

test("ambiguous position reads log their specific failing count and preserve refusal", async () => {
  const positions = ["2105662972415795900", "2105662972415795901"].map((positionId) => ({
    positionId, symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1", avgPrice: "100",
  }));
  const { broker } = apiFixture({ positions });
  const { observations } = await captureStopDiagnostics(async () => {
    await assert.rejects(broker.readPosition("BTCUSDT"), /bingx_vst_position_state_ambiguous/);
  });
  const evidence = observations.find((item) => item.proofEvidence?.source === "broker_position_rows")?.proofEvidence;
  assert.equal(evidence.checks.find((item) => item.field === "matchingPositionCount").actual, "2");
  assert.ok(evidence.failedChecks.includes("matchingPositionCount"));
});

test("stop diagnostics distinguish verified protection, returned absence and field mismatch without extra reads", async () => {
  const position = { symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
    avgPrice: "100", positionId: "2105662972415795200" };
  const stop = { symbol: "BTC-USDT", orderId: "2105662972415795201",
    positionId: position.positionId, type: "STOP_MARKET", status: "NEW", side: "SELL",
    positionSide: "LONG", origQty: "0.1", stopPrice: "95", workingType: "MARK_PRICE" };
  for (const [orders, verdict] of [
    [[stop], "stop_verified"], [[], "expected_stop_not_found_in_response"],
    [[{ ...stop, positionId: "0" }], "stop_fields_mismatch"],
  ]) {
    const { api, calls } = apiFixture({ positions: [position], orders });
    const broker = createVstBroker({ api, accountId: "test-vst-account",
      canarySymbols: ["BTCUSDT"], clock: () => now, stopBufferRate: 0.005 });
    const { result, observations } = await captureStopDiagnostics(() =>
      broker.readPosition("BTCUSDT"));
    const diagnostic = observations.find((item) => item.stopEvidence?.verdict === verdict);
    assert.ok(diagnostic, verdict);
    assert.equal(calls.filter(([name]) => name === "positions").length, 1);
    assert.equal(calls.filter(([name]) => name === "openOrders").length, 1);
    assert.equal(JSON.stringify(result).includes("stopEvidence"), false);
    assert.equal(getVstResultDiagnosticRef(result) !== undefined, verdict !== "stop_verified");
    if (verdict === "stop_verified") assert.equal(diagnostic.level, "info");
  }
});

test("original-only persisted staging has present verified evidence and no false failure", async () => {
  const position = { symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
    avgPrice: "100", positionId: "2105662972415795300" };
  const stop = { symbol: "BTC-USDT", orderId: "2105662972415795301",
    positionId: position.positionId, type: "STOP_MARKET", status: "NEW", side: "SELL",
    positionSide: "LONG", origQty: "0.1", stopPrice: "95", workingType: "MARK_PRICE" };
  const snapshot = { verified: true, environment: "vst", accountId: "test-vst-account",
    symbol: "BTCUSDT", positionId: position.positionId, quantity: "0.1",
    protectiveStops: {}, originalStop: { verified: true, positionId: position.positionId,
      orderId: stop.orderId, quantity: "0.1", stopPrice: "95" } };
  const { api } = apiFixture({ positions: [position], orders: [stop] });
  const broker = createVstBroker({ api, accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"], clock: () => now, stopBufferRate: 0.005 });
  const { result, observations } = await captureStopDiagnostics(() =>
    broker.readPosition("BTCUSDT", { persistedPosition: snapshot }));
  assert.equal(result.originalStop.orderId, stop.orderId);
  assert.equal(getVstResultDiagnosticRef(result), undefined);
  assert.ok(observations.some((item) => item.stopEvidence?.verdict === "original_stop_verified"));
  assert.equal(observations.some((item) => item.reason === "stop_unverified"), false);
});

test("persisted stop mismatch keeps native exception and exact price evidence through outer catch", async () => {
  const position = { symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
    avgPrice: "100", positionId: "2105662972415795400" };
  const stop = { symbol: "BTC-USDT", orderId: "2105662972415795401",
    positionId: position.positionId, type: "STOP_MARKET", status: "NEW", side: "SELL",
    positionSide: "LONG", origQty: "0.1", stopPrice: "94", workingType: "MARK_PRICE" };
  const snapshot = { verified: true, environment: "vst", accountId: "test-vst-account",
    symbol: "BTCUSDT", positionId: position.positionId, quantity: "0.1",
    protectiveStops: { core: { verified: true, tranche: "core", positionId: position.positionId,
      orderId: stop.orderId, quantity: "0.1", stopPrice: "95" } } };
  const { api } = apiFixture({ positions: [position], orders: [stop] });
  const broker = createVstBroker({ api, accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"], clock: () => now, stopBufferRate: 0.005 });
  const { observations } = await captureStopDiagnostics(() =>
    assert.rejects(broker.readPosition("BTCUSDT", { persistedPosition: snapshot }),
      /persisted_stop_raw_order_mismatch/));
  assert.ok(observations.some((item) => item.stopEvidence?.expectedStops?.[0]
    ?.observations?.[0]?.checks.stopPrice === false));
  assert.equal(observations.some((item) => item.stopEvidence?.readStatus === "failed"), false);
});

test("readPosition observes every parallel failure before delayed siblings settle", () => {
  const brokerUrl = new URL("../vst-broker.mjs", import.meta.url).href;
  for (const scopedMethod of ["getPositions", "getOpenOrders"]) {
    for (const metadataFirst of [false, true]) {
      const script = `
        import assert from "node:assert/strict";
        import { createVstBroker } from ${JSON.stringify(brokerUrl)};
        const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        const api = {
          getBalance: async () => { throw Error("unused"); },
          getRiskTiers: async () => { throw Error("unused"); },
          getFeeRate: async () => { throw Error("unused"); },
          getFunding: async () => { throw Error("unused"); },
          queryOrder: async () => { throw Error("unused"); },
          queryOrderHistory: async () => { throw Error("unused"); },
          queryFills: async () => { throw Error("unused"); },
          setVstLongLeverage10: async () => { throw Error("writes forbidden"); },
          getVstMarkPrice: async () => ({symbol:"BTC-USDT", timestamp:Date.now()}),
          placeVstAutomatedLong: async () => { throw Error("writes forbidden"); },
          upgradeVstLongStop: async () => { throw Error("writes forbidden"); },
          closeLong: async () => { throw Error("writes forbidden"); },
          getPositions: async () => [],
          getOpenOrders: async () => [],
          getPositionMode: async () => ({dualSidePosition:true}),
          getMarginType: async () => "ISOLATED",
          getLeverage: async () => ({longLeverage:10,shortLeverage:3}),
          contract: async () => {
            ${metadataFirst ? 'throw Error("metadata_failed");'
              : 'await delay(100); return {symbol:"BTC-USDT",pricePrecision:1};'}
          },
        };
        api[${JSON.stringify(scopedMethod)}] = async () => {
          ${metadataFirst ? "await delay(100);" : ""}
          throw Error("scoped_failed");
        };
        const broker = createVstBroker({
          api,accountId:"fixture-vst",canarySymbols:["BTCUSDT"],stopBufferRate:0.005,
        });
        await assert.rejects(broker.readPosition("BTCUSDT"),
          /${metadataFirst ? "metadata_failed" : "scoped_failed"}/);
        await delay(150);
        console.log("failure handled; worker alive");
      `;
      const child = spawnSync(process.execPath, [
        "--unhandled-rejections=strict", "--input-type=module", "--eval", script,
      ], { encoding: "utf8", timeout: 5000 });
      assert.equal(child.status, 0,
        `${scopedMethod}, metadataFirst=${metadataFirst}: ${child.stderr || child.error}`);
      assert.match(child.stdout, /failure handled; worker alive/);
    }
  }
});

function apiFixture({
  positions = [],
  orders = [],
  queriedOrder = null,
  queriedOrders = {},
  history = [],
  fills = [],
  longLeverage = 10,
  maxPositionLongVal = 1_000_000,
  marginType = "ISOLATED",
  marginModes = {},
  positionMode = "HEDGE",
  clock = () => now,
  quoteTimestamp = now,
  markPrice = "100",
  fundingRate = 0,
  sleep = async () => {},
  fullSplitRemainingIds = ["split-runner-stop"],
  balanceSnapshot = [{ asset: "VST", balance: "1000", availableMargin: "20" }],
  tiers = [{ maxNotional: 100_000, maintenanceMarginRate: 0.005 }],
  splitStopVerified = true,
  canarySymbols = ["BTCUSDT"],
  omitAdapterMethods = [],
  ambiguousPreRunnerClose = false,
  strictFillCurrency = false,
  filterFillsByTime = false,
  contractOfflineMessage = null,
  pricePrecision = filters.pricePrecision,
} = {}) {
  const calls = [];
  const marginAdjustments = [];
  let exchangeLongLeverage = longLeverage;
  const exchangeMarginModes = { ...marginModes };
  const api = {
    async getVstMarkPrice(symbol) {
      calls.push(["mark", symbol]);
      return {
        symbol: `${symbol.slice(0, -4)}-USDT`,
        markPrice,
        timestamp: typeof quoteTimestamp === "function" ? quoteTimestamp() : quoteTimestamp,
      };
    },
    async getBalance() {
      calls.push(["balance"]);
      return balanceSnapshot;
    },
    async getPositions(symbol) {
      calls.push(["positions", symbol]);
      return symbol
        ? positions.filter((row) => row?.symbol === `${symbol.slice(0, -4)}-USDT`)
        : positions;
    },
    async getPositionMarginHistory(symbol, positionId, interval) {
      calls.push(["marginHistory", symbol, positionId, interval]);
      const records = marginAdjustments.filter((row) =>
        row.positionId === positionId &&
        row.time >= interval.startTime && row.time <= interval.endTime);
      return { total: records.length, records };
    },
    async getOpenOrders(symbol) {
      calls.push(["openOrders", symbol]);
      return symbol
        ? orders.filter((row) => row?.symbol === `${symbol.slice(0, -4)}-USDT`)
        : orders;
    },
    async getPositionMode() {
      calls.push(["getPositionMode"]);
      return positionMode;
    },
    async getMarginType(symbol) {
      calls.push(["getMarginType", symbol]);
      return exchangeMarginModes[symbol] ?? marginType;
    },
    async getLeverage(symbol) {
      calls.push(["getLeverage", symbol]);
      return { longLeverage: exchangeLongLeverage, shortLeverage: 3, maxPositionLongVal };
    },
    async contract(symbol) {
      calls.push(["contract", symbol]);
      if (contractOfflineMessage) {
        throw new BingXLiveApiError(
          `BingX request failed (HTTP 200, code 109418, msg: ${contractOfflineMessage})`,
          { httpStatus: 200, code: 109418, exchangeMessage: contractOfflineMessage },
        );
      }
      return { ...filters, pricePrecision, symbol: `${symbol.slice(0, -4)}-USDT` };
    },
    async getFeeRate(symbol) {
      calls.push(["feeRate", symbol]);
      return { maker: 0.0002, taker: 0.0005 };
    },
    async getFunding() {
      calls.push(["funding"]);
      return { rate: fundingRate, nextFundingTime: now + 60_000 };
    },
    async getRiskTiers(symbol) {
      calls.push(["riskTiers", symbol]);
      return tiers;
    },
    async setVstLongLeverage10(symbol) {
      calls.push(["setVstLongLeverage10", symbol]);
      exchangeLongLeverage = 10;
    },
    async setVstIsolatedMarginForFlatSymbol(symbol) {
      calls.push(["setVstIsolatedMarginForFlatSymbol", symbol]);
      exchangeMarginModes[symbol] = "ISOLATED";
    },
    async queryOrder(symbol, identifier) {
      calls.push(["queryOrder", symbol, identifier]);
      const matchingClientOrder = identifier?.clientOrderId
        ? history.find((row) => (row?.clientOrderId ?? row?.clientOrderID) ===
          identifier.clientOrderId)
        : null;
      const matchingOpenOrder = identifier?.orderId
        ? orders.find((row) => (row?.orderId ?? row?.orderID) === identifier.orderId)
        : null;
      return queriedOrders[identifier?.orderId] ??
        queriedOrders[`client:${identifier?.clientOrderId}`] ??
        matchingClientOrder ?? matchingOpenOrder ?? queriedOrder;
    },
    async queryOrderHistory(symbol, range) {
      calls.push(["history", symbol, range]);
      const current = Number(clock());
      if (!Number.isSafeInteger(Number(range?.startTs)) ||
          !Number.isSafeInteger(Number(range?.endTs)) ||
          Number(range.startTs) < current - 24 * 60 * 60_000 - 2_000 ||
          Number(range.endTs) - Number(range.startTs) > 24 * 60 * 60_000 ||
          Number(range.endTs) > current + 2_000) {
        throw new TypeError("mock API rejects order-history windows beyond 24 hours");
      }
      return history;
    },
    async queryFills(symbol, range) {
      calls.push(["fills", symbol, range]);
      const current = Number(clock());
      if (!Number.isSafeInteger(Number(range?.startTs)) ||
          !Number.isSafeInteger(Number(range?.endTs)) ||
          Number(range.startTs) < current - 24 * 60 * 60_000 - 2_000 ||
          Number(range.endTs) - Number(range.startTs) > 24 * 60 * 60_000 ||
          Number(range.endTs) > current + 2_000) {
        throw new TypeError("mock API rejects fill windows beyond 24 hours");
      }
      return fills.filter((fill) => {
        const rawTime = fill.filledTm ?? fill.filledTime ?? fill.time ??
          fill.timestamp ?? fill.tradeTime;
        const numeric = Number(rawTime);
        const at = Number.isFinite(numeric)
          ? numeric < 100_000_000_000 ? numeric * 1000 : numeric
          : typeof rawTime === "string" ? Date.parse(rawTime) : null;
        const inTimeRange = !filterFillsByTime || !Number.isSafeInteger(at) ||
          at >= Number(range?.startTs) && at <= Number(range?.endTs);
        return inTimeRange &&
        (!range?.orderId ||
          String(fill.orderId ?? fill.orderID) === String(range.orderId)) &&
        (!strictFillCurrency || !range?.currency ||
          (fill.currency ?? fill.commissionAsset) === range.currency);
      });
    },
    async discoverVstAutomatedLongStop() {
      calls.push(["discoverStop"]);
      return { verified: true };
    },
    async placeVstAutomatedLong(request) {
      calls.push(["entry", request]);
      return { orderId: "echo-only" };
    },
    async addVstIsolatedLongMargin(request) {
      calls.push(["addVstIsolatedLongMargin", request]);
      const position = positions.find((row) =>
        row?.symbol === `${request.symbol.slice(0, -4)}-USDT` &&
        row?.positionSide === "LONG" &&
        String(row?.positionId ?? row?.positionID) === request.positionId &&
        String(row?.positionAmt) === request.quantity);
      if (!position) throw new Error("mock exact VST LONG position missing");
      marginAdjustments.push({
        symbol: `${request.symbol.slice(0, -4)}-USDT`,
        positionId: request.positionId,
        changeReason: "ManualMarginAddition",
        marginChange: String(request.amount),
        marginAfterChange: String(Number(position.isolatedMargin) + Number(request.amount)),
        time: now,
      });
      return {
        verified: false,
        amount: Number(request.amount),
        isolatedMarginBefore: Number(position.isolatedMargin) - Number(request.amount),
        isolatedMarginAfter: Number(position.isolatedMargin) + Number(request.amount),
      };
    },
    async upgradeVstLongStop(request) {
      calls.push(["upgradeStop", request]);
      return { verified: true };
    },
    async placeVstAutomatedSplitLegStopUpgrade(request) {
      calls.push(["splitRaisePlace", request]);
      const newStop = {
        symbol: "BTC-USDT",
        orderId: `split-${request.leg}-raised`,
        clientOrderId: request.clientOrderId,
        type: "STOP_MARKET",
        status: "NEW",
        side: "SELL",
        positionSide: "LONG",
        positionId: request.positionId,
        origQty: request.oldStop.quantity,
        stopPrice: request.newStopPrice,
        workingType: "MARK_PRICE",
        time: now,
      };
      orders.push(newStop);
      history.push(newStop);
      return {
        symbol: "BTC-USDT",
        positionId: request.positionId,
        totalQuantity: request.totalQuantity,
        leg: request.leg,
        oldStop: request.oldStop,
        newStop: {
          tranche: request.leg,
          orderId: newStop.orderId,
          quantity: request.oldStop.quantity,
          stopPrice: request.newStopPrice,
          clientOrderId: request.clientOrderId,
        },
        otherStop: request.otherStop,
        clientOrderId: request.clientOrderId,
        upgradeIntentId: request.upgradeIntentId,
        verified: true,
      };
    },
    async cancelVstAutomatedSplitLegStopUpgrade(request) {
      calls.push(["splitRaiseCancel", request]);
      const index = orders.findIndex((row) => row.orderId === request.oldStop.orderId);
      if (index >= 0) {
        const old = orders.splice(index, 1)[0];
        const canceled = { ...old, status: "CANCELED", executedQty: "0" };
        queriedOrders[request.oldStop.orderId] = canceled;
        history.push(canceled);
      }
      return {
        symbol: "BTC-USDT",
        status: "CANCELED",
        canceledStopOrderId: request.oldStop.orderId,
        activeUpgradedStop: request.newStop,
        activeOtherStop: request.otherStop,
        positionId: request.positionId,
        quantity: request.totalQuantity,
        upgradeIntentId: request.upgradeIntentId,
        verified: true,
      };
    },
    async closeVstAutomatedSoleSplitLeg(request) {
      calls.push(["closeSurvivor", request]);
      const closeOrder = {
        symbol: "BTC-USDT",
        orderId: "sole-split-close-order",
        clientOrderId: request.clientOrderId,
        status: "FILLED",
        side: "SELL",
        positionSide: "LONG",
        type: "MARKET",
        origQty: request.quantity,
        executedQty: request.quantity,
      };
      history.push(closeOrder);
      queriedOrders[closeOrder.orderId] = closeOrder;
      queriedOrders[`client:${request.clientOrderId}`] = closeOrder;
      fills.push({
        symbol: "BTC-USDT",
        orderId: closeOrder.orderId,
        tradeId: "sole-split-close-fill-1",
        side: "SELL",
        positionSide: "LONG",
        volume: request.quantity,
        price: "100",
        filledTm: now,
        commission: "-0.001",
        currency: "VST",
      });
      const stopIndex = orders.findIndex((row) => row.orderId === request.stop.orderId);
      if (stopIndex >= 0) {
        const stop = orders.splice(stopIndex, 1)[0];
        const canceled = { ...stop, status: "CANCELED", executedQty: "0" };
        queriedOrders[request.stop.orderId] = canceled;
        history.push(canceled);
      }
      if (positions[0]) positions[0].positionAmt = "0";
      return {
        symbol: "BTC-USDT",
        positionId: request.positionId,
        closedQuantity: request.quantity,
        closeOrderId: closeOrder.orderId,
        clientOrderId: request.clientOrderId,
        closeIntentId: request.closeIntentId,
        fills: fills.filter((fill) => fill.orderId === closeOrder.orderId),
        fees: [{ amount: "-0.001", asset: "VST" }],
        canceledStopOrderId: request.stop.orderId,
        status: "FILLED",
        flat: true,
        noOpenStops: true,
        verified: true,
      };
    },
    async closeVstAutomatedFullSplitPosition(request) {
      calls.push(["closeSplitAll", request]);
      const closeOrder = {
        symbol: "BTC-USDT",
        orderId: "full-split-close-order",
        clientOrderId: request.clientOrderId,
        status: "FILLED",
        side: "SELL",
        positionSide: "LONG",
        type: "MARKET",
        origQty: request.totalQuantity,
        executedQty: request.totalQuantity,
        reduceOnly: "true",
      };
      history.push(closeOrder);
      queriedOrders[closeOrder.orderId] = closeOrder;
      queriedOrders[`client:${request.clientOrderId}`] = closeOrder;
      const closeFill = {
        symbol: "BTC-USDT",
        orderId: closeOrder.orderId,
        tradeId: "full-split-close-fill-1",
        side: "SELL",
        positionSide: "LONG",
        volume: request.totalQuantity,
        price: "100",
        filledTm: now,
        commission: "-0.002",
        currency: "VST",
      };
      fills.push(closeFill);
      for (const stop of [request.coreStop, request.runnerStop]) {
        if (fullSplitRemainingIds.includes(stop.orderId)) continue;
        const index = orders.findIndex((row) => row.orderId === stop.orderId);
        if (index >= 0) {
          const active = orders.splice(index, 1)[0];
          const canceled = { ...active, status: "CANCELED", executedQty: "0" };
          queriedOrders[stop.orderId] = canceled;
          history.push(canceled);
        }
      }
      if (positions[0]) positions[0].positionAmt = "0";
      const remainingKnownStopOrderIds = orders.map((row) => row.orderId);
      return {
        symbol: "BTC-USDT",
        positionId: request.positionId,
        closedQuantity: request.totalQuantity,
        closeOrderId: closeOrder.orderId,
        clientOrderId: request.clientOrderId,
        closeIntentId: request.closeIntentId,
        fills: [closeFill],
        fees: [{ fillId: closeFill.tradeId, amount: closeFill.commission, asset: "VST" }],
        flat: true,
        remainingKnownStopOrderIds,
        fullyCleaned: remainingKnownStopOrderIds.length === 0,
        stopCleanupRequired: remainingKnownStopOrderIds.length > 0,
        verified: true,
      };
    },
    async closeVstAutomatedPreRunnerSplit(request) {
      calls.push(["closePreRunnerSplit", request]);
      const closeOrder = {
        symbol: "BTC-USDT",
        orderId: "pre-runner-close-order",
        clientOrderId: request.clientOrderId,
        status: "FILLED",
        side: "SELL",
        positionSide: "LONG",
        type: "MARKET",
        origQty: request.totalQuantity,
        executedQty: request.totalQuantity,
        reduceOnly: "true",
      };
      history.push(closeOrder);
      queriedOrders[closeOrder.orderId] = closeOrder;
      queriedOrders[`client:${request.clientOrderId}`] = closeOrder;
      const closeFill = {
        symbol: "BTC-USDT",
        orderId: closeOrder.orderId,
        tradeId: "pre-runner-close-fill-1",
        side: "SELL",
        positionSide: "LONG",
        volume: request.totalQuantity,
        price: "100",
        filledTm: now,
        commission: "-0.002",
        currency: "VST",
      };
      fills.push(closeFill);
      for (const position of positions) {
        if (position?.symbol === "BTC-USDT" &&
            position?.positionId === request.positionId) position.positionAmt = "0";
      }
      if (ambiguousPreRunnerClose) {
        throw new Error("simulated_lost_pre_runner_close_acknowledgement");
      }
      return {
        symbol: "BTC-USDT",
        positionId: request.positionId,
        clientOrderId: request.clientOrderId,
        closeIntentId: request.closeIntentId,
        closeOrderId: closeOrder.orderId,
        closedQuantity: request.totalQuantity,
        fills: [closeFill],
        status: "FILLED",
        flat: true,
        remainingKnownStopOrderIds: orders.map((row) => row.orderId),
        verified: true,
      };
    },
    async cancelVstAutomatedKnownStopWhenFlat(request) {
      calls.push(["cancelFlatSplitStop", request]);
      const stop = request.stopToCancel;
      const index = orders.findIndex((row) => row.orderId === stop.orderId);
      if (index >= 0) {
        const active = orders.splice(index, 1)[0];
        const canceled = { ...active, status: "CANCELED", executedQty: "0" };
        queriedOrders[stop.orderId] = canceled;
        history.push(canceled);
      }
      return {
        symbol: "BTC-USDT",
        positionId: request.positionId,
        status: "CANCELED",
        canceledStopOrderId: stop.orderId,
        cancellationIntentId: request.cancellationIntentId,
        knownRemainingStopOrderIds: request.knownRemainingStopOrderIds,
        remainingKnownStopOrderIds: orders.map((row) => row.orderId),
        flat: true,
        verified: true,
      };
    },
    async placeVstAutomatedVirtualSplitLongStop(request) {
      calls.push(["splitStop", request]);
      const stopOrderId = request.tranche === "core"
        ? "split-core-stop" : "split-runner-stop";
      orders.push({
        symbol: "BTC-USDT",
        orderId: stopOrderId,
        type: "STOP_MARKET",
        status: "NEW",
        side: "SELL",
        positionSide: "LONG",
        positionId: "position-1",
        origQty: request.quantity,
        stopPrice: request.stopPrice,
        workingType: "MARK_PRICE",
        mainOrderId: "entry-order-1",
        time: now,
      });
      history.push(orders.at(-1));
      return {
        symbol: "BTC-USDT",
        tranche: request.tranche,
        orderId: stopOrderId,
        verified: splitStopVerified,
      };
    },
    async cancelVstAutomatedAttachedLongStopAfterSplit(request) {
      calls.push(["cancelOriginalStop", request]);
      const index = orders.findIndex((row) => row.orderId === request.originalStopOrderId);
      if (index >= 0) {
        const original = orders.splice(index, 1)[0];
        const canceled = { ...original, status: "CANCELED", executedQty: "0" };
        queriedOrders[request.originalStopOrderId] = canceled;
        const historyIndex = history.findIndex((row) =>
          row.orderId === request.originalStopOrderId);
        if (historyIndex >= 0) history[historyIndex] = canceled;
        else history.push(canceled);
      }
      return { status: "CANCELED", verified: true };
    },
    async closeVstAutomatedSplitTranche(request) {
      calls.push(["splitClose", request]);
      const remainingQuantity = request.quantity === "0.08" ? "0.02" : "0.08";
      const closeOrder = {
        symbol: "BTC-USDT",
        orderId: "split-close-order",
        clientOrderId: request.clientOrderId,
        status: "FILLED",
        side: "SELL",
        positionSide: "LONG",
        type: "MARKET",
        origQty: request.quantity,
        executedQty: request.quantity,
      };
      queriedOrders[closeOrder.orderId] = closeOrder;
      history.push(closeOrder);
      if (positions[0]) positions[0].positionAmt = remainingQuantity;
      const retained = orders.find((row) => row.orderId === request.retainedStop.orderId);
      if (retained) retained.origQty = remainingQuantity;
      fills.push({
        symbol: "BTC-USDT",
        orderId: closeOrder.orderId,
        tradeId: "split-close-fill-1",
        side: "SELL",
        positionSide: "LONG",
        volume: request.quantity,
        price: "100",
        filledTm: now,
        commission: "-0.001",
        currency: "VST",
      });
      return {
        orderId: "split-close-order",
        status: "FILLED",
        executedQuantity: request.quantity,
        remainingQuantity,
        retainedStop: retained,
        verified: true,
      };
    },
    async cancelVstAutomatedSplitStopAfterPartial(request) {
      calls.push(["cleanupSplitStop", request]);
      const index = orders.findIndex((row) => row.orderId === request.stopToCancel.orderId);
      if (index >= 0) {
        const stopped = orders.splice(index, 1)[0];
        const canceled = { ...stopped, status: "CANCELED", executedQty: "0" };
        queriedOrders[request.stopToCancel.orderId] = canceled;
        history.push(canceled);
      }
      return { status: "CANCELED", verified: true };
    },
    async cancelVstAutomatedOriginalAfterTriggeredRunner(request) {
      calls.push(["cancelOriginalAfterRunnerFill", request]);
      const index = orders.findIndex((row) => row.orderId === request.originalStopOrderId);
      const original = index >= 0 ? orders.splice(index, 1)[0] : null;
      if (original) {
        const terminal = {
          ...original,
          status: "CANCELED",
          origQty: request.remainingQuantity,
          executedQty: "0",
        };
        queriedOrders[request.originalStopOrderId] = terminal;
        history.push(terminal);
      }
      return {
        symbol: "BTC-USDT",
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
    async closeLong(...args) { calls.push(["close", ...args]); return { orderId: "echo-only" }; },
  };
  for (const method of omitAdapterMethods) delete api[method];
  const broker = createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols,
    clock,
    sleep,
    stopBufferRate: 0.005,
  });
  return { api, broker, calls };
}

function splitReadContextFacts(symbol = "BTC-USDT", prefix = "context") {
  const positionId = `${prefix}-position`;
  const position = {
    symbol,
    positionSide: "LONG",
    positionAmt: "0.1",
    avgPrice: "100",
    positionId,
  };
  const coreOrder = {
    symbol,
    orderId: `${prefix}-core`,
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionId,
    origQty: "0.08",
    stopPrice: "95",
    workingType: "MARK_PRICE",
  };
  const runnerOrder = {
    symbol,
    orderId: `${prefix}-runner`,
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionId,
    origQty: "0.02",
    stopPrice: "100",
    workingType: "MARK_PRICE",
  };
  const persistedPosition = {
    verified: true,
    environment: "vst",
    accountId: "test-vst-account",
    symbol: symbol.replace("-", ""),
    positionId,
    quantity: "0.1",
    protectiveStops: {
      core: {
        verified: true,
        tranche: "core",
        orderId: coreOrder.orderId,
        positionId,
        quantity: "0.08",
        stopPrice: "95",
      },
      runner: {
        verified: true,
        tranche: "runner",
        orderId: runnerOrder.orderId,
        positionId,
        quantity: "0.02",
        stopPrice: "100",
      },
    },
  };
  return { position, coreOrder, runnerOrder, persistedPosition };
}

function impulseSplitRequest({
  operation = "split_core_stop",
  baselineOpenOrderIds = ["original-signal-stop"],
  coreStop,
  runnerStop,
  priorPosition,
  persistedPosition,
} = {}) {
  return {
    operation,
    sourceSignalId: "signal-impulse-1",
    signal: {
      sourceSignalId: "signal-impulse-1",
      patternId: "impulse_buy",
      symbol: "BTCUSDT",
      stopLoss: "95",
      signalAt: new Date(now).toISOString(),
    },
    symbol: "BTCUSDT",
    environment: "vst",
    accountId: "test-vst-account",
    intentCreatedAt: now,
    positionId: "position-1",
    originalStopOrderId: "original-signal-stop",
    entryOrderId: "entry-order-1",
    totalQuantity: "0.1",
    coreQuantity: "0.08",
    runnerQuantity: "0.02",
    quantityPrecision: 4,
    pricePrecision: 1,
    signalStopPrice: "95",
    breakEvenPrice: "100",
    actualEntryBreakEvenPrice: "100",
    baselineOpenOrderIds,
    createdAt: now,
    ...(coreStop ? { coreStop } : {}),
    ...(runnerStop ? { runnerStop } : {}),
    ...(priorPosition ? { priorPosition } : {}),
    ...(persistedPosition ? { persistedPosition } : {}),
  };
}

function triggeredRunnerCancelFixture(
  intentId = "durable-runner-cancel-1",
  identitySuffix = "",
) {
  const identity = identitySuffix ? `${identitySuffix}-` : "";
  const positionId = identity ? `${identity}position` : "position-1";
  const originalStopOrderId = `${identity}original-stop`;
  const coreStopOrderId = `${identity}core-stop`;
  const runnerStopOrderId = `${identity}runner-stop`;
  const runnerChildOrderId = `${identity}runner-child`;
  const positions = [{
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: "0.08",
    avgPrice: "100",
    positionId,
  }];
  const orders = [
    {
      symbol: "BTC-USDT",
      orderId: originalStopOrderId,
      type: "STOP_MARKET",
      status: "NEW",
      side: "SELL",
      positionSide: "LONG",
      positionId,
      origQty: "0.08",
      stopPrice: "95",
      workingType: "MARK_PRICE",
    },
    {
      symbol: "BTC-USDT",
      orderId: coreStopOrderId,
      type: "STOP_MARKET",
      status: "NEW",
      side: "SELL",
      positionSide: "LONG",
      positionId,
      origQty: "0.08",
      stopPrice: "95",
      workingType: "MARK_PRICE",
    },
  ];
  const runnerStop = {
    symbol: "BTC-USDT",
    orderId: runnerChildOrderId,
    type: "STOP_MARKET",
    status: "FILLED",
    side: "SELL",
    positionSide: "LONG",
    positionID: 0,
    origQty: "0.02",
    executedQty: "0.02",
    stopPrice: "100",
    workingType: "MARK_PRICE",
    mainOrderId: "",
  };
  const runnerChild = {
    symbol: "BTC-USDT",
    orderId: runnerChildOrderId,
    type: "STOP_MARKET",
    status: "FILLED",
    side: "SELL",
    positionSide: "LONG",
    positionId,
    origQty: "0.02",
    executedQty: "0.02",
  };
  const queriedOrders = {
    [runnerStopOrderId]: runnerStop,
    [runnerChildOrderId]: runnerChild,
  };
  const fills = [{
    symbol: "BTC-USDT",
    orderId: runnerChildOrderId,
    triggerOrderId: runnerStopOrderId,
    side: "SELL",
    positionSide: "LONG",
    volume: "0.02",
    price: "100",
    filledTm: now,
  }];
  const staleBuyFill = {
    symbol: "BTC-USDT",
    orderId: "old-entry-order",
    triggerOrderId: 0,
    side: "BUY",
    positionSide: "LONG",
    volume: "0.1",
    price: "100",
    filledTm: now - 2 * 24 * 60 * 60_000,
  };
  const options = {
    positions, orders, queriedOrders, fills: [...fills, staleBuyFill],
    filterFillsByTime: true,
  };
  const { api, broker, calls } = apiFixture(options);
  const request = {
    operation: "cancel_original_after_runner_fill",
    sourceSignalId: "signal-impulse-1",
    symbol: "BTCUSDT",
    environment: "vst",
    accountId: "test-vst-account",
    intentCreatedAt: now,
    intentId,
    positionId,
    runnerStopOrderId,
    runnerChildOrderId,
    originalStopOrderId,
    coreStopOrderId,
    totalQuantity: "0.1",
    remainingQuantity: "0.08",
    signalStopPrice: "95",
    breakEvenPrice: "100",
    priorPosition: {
      split: {
        runnerCleanup: {
          fill: { at: new Date(now).toISOString() },
        },
      },
    },
  };
  return { api, broker, calls, request, intentId };
}

test("VST capability report advertises impulse only when complete guarded support is verified", async () => {
  const { broker, calls } = apiFixture();
  const capabilities = await broker.getCapabilities();
  assert.equal(capabilities.environment, "vst");
  assert.equal(capabilities.verified, true);
  assert.equal(capabilities.features.includes("atomic_protected_market_entry"), true);
  assert.equal(capabilities.features.includes("complete_order_lookup"), true);
  assert.equal(capabilities.features.includes("verified_core_stop_state"), true);
  assert.equal(capabilities.features.includes("verified_exact_full_position_close"), true);
  assert.equal(capabilities.features.includes("guarded_isolated_margin_preparation"), true);
  assert.equal(capabilities.features.includes("impulse_runner_stop_and_partial_close"), true);
  assert.equal(capabilities.missingCapabilities.some(({ capability }) =>
    capability === "impulse_runner_stop_and_partial_close"), false);
  assert.ok(calls.some(([name]) => name === "balance"));
  assert.ok(calls.some(([name]) => name === "history"));
  assert.ok(calls.some(([name]) => name === "fills"));
  assert.equal(calls.filter(([name]) => name === "getMarginType").length, 1);
  assert.equal(calls.filter(([name]) => name === "getLeverage").length, 1);
  assert.equal(calls.some(([name]) =>
    ["contract", "feeRate", "riskTiers", "mark"].includes(name)), false);
});

test("capability history overlaps symbol settings, mode is read once, and no market data is probed", async () => {
  let current = now;
  const { api, broker, calls } = apiFixture({
    canarySymbols: ["BTCUSDT", "ETHUSDT"],
    clock: () => current,
    quoteTimestamp: () => current,
  });
  let releaseHistory;
  const historyGate = new Promise((resolve) => { releaseHistory = resolve; });
  const historyRead = api.queryOrderHistory;
  api.queryOrderHistory = async (...args) => {
    await historyGate;
    return historyRead(...args);
  };
  const pending = broker.getCapabilities();
  // Give the independent settings requests a chance to start while history waits.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter(([name]) => name === "getPositionMode").length, 1);
  assert.equal(calls.filter(([name]) => name === "getMarginType").length, 2);
  assert.equal(calls.filter(([name]) => name === "getLeverage").length, 2);
  assert.equal(calls.some(([name]) =>
    ["contract", "feeRate", "riskTiers", "mark"].includes(name)), false);
  current += 15_000;
  releaseHistory();
  const capabilities = await pending;
  assert.equal(capabilities.verified, true);
  assert.equal(calls.some(([name]) =>
    ["contract", "feeRate", "riskTiers", "mark"].includes(name)), false);
});

test("foreign exposure is quarantined per symbol without querying market-data prerequisites", async () => {
  const { api, broker, calls } = apiFixture({ quoteTimestamp: now - 11_000 });
  const baseline = await broker.getCapabilities();
  assert.equal(baseline.verified, true);
  assert.equal(calls.some(([name]) =>
    ["contract", "feeRate", "riskTiers", "mark"].includes(name)), false);
  const positions = api.getPositions;
  api.getPositions = async (...args) => [...await positions(...args), {
    symbol: "ETH-USDT", positionSide: "SHORT", positionAmt: "1",
    positionId: "foreign",
  }];
  const capabilities = await broker.getCapabilities();
  assert.ok(capabilities.unverifiedSymbols.includes("ETHUSDT"));
  assert.equal(capabilities.features.includes("impulse_runner_stop_and_partial_close"), false);
});

test("capability timing diagnostics cannot prevent a safe read or expose account values", async () => {
  const { broker } = apiFixture();
  const stages = [];
  const capabilities = await broker.getCapabilities((name, elapsed) => {
    stages.push([name, elapsed]);
    if (name === "capabilityAccountSnapshot") throw new Error("broken logger");
  });
  assert.equal(capabilities.verified, true);
  assert.deepEqual(stages.map(([name]) => name), [
    "capabilityAccountSnapshot", "capabilityHistoryAndSymbolReads",
    "capabilityLookupSample",
    "capabilityLookupProtocolRefreshed",
  ]);
  assert.ok(stages.every(([, ms]) => Number.isFinite(ms) && ms >= 0));
});

test("capability checks do not substitute for fresh target risk and quote reads at planning", async () => {
  const { api, broker, calls } = apiFixture();
  await broker.getCapabilities();
  const marksBeforePlanning = calls.filter(([name]) => name === "mark").length;
  assert.equal(marksBeforePlanning, 0);
  assert.equal(calls.some(([name]) =>
    ["contract", "feeRate", "riskTiers"].includes(name)), false);
  api.getRiskTiers = async () => [];
  await assert.rejects(broker.readPlanningInputs({ symbol: "BTCUSDT" }),
    /bingx_vst_planning_reads_unverified/);
  assert.ok(calls.filter(([name]) => name === "mark").length > marksBeforePlanning);
  api.getRiskTiers = async () => [{ maxNotional: 100_000, maintenanceMarginRate: 0.005 }];
  api.getVstMarkPrice = async () => ({
    symbol: "BTC-USDT", markPrice: "100", timestamp: now - 11_000,
  });
  await assert.rejects(broker.readPlanningInputs({ symbol: "BTCUSDT" }),
    /bingx_vst_quote_stale_or_invalid/);
});

test("impulse capability names unavailable adapter methods explicitly", async () => {
  const { broker } = apiFixture({
    omitAdapterMethods: ["closeVstAutomatedSplitTranche"],
  });
  const capabilities = await broker.getCapabilities();
  assert.equal(capabilities.features.includes("impulse_runner_stop_and_partial_close"), false);
  const missing = capabilities.missingCapabilities.find(({ capability }) =>
    capability === "impulse_runner_stop_and_partial_close");
  assert.match(missing.reason, /closeVstAutomatedSplitTranche/);
});

test("isolated-margin preparation capability is omitted when its VST adapter is unavailable", async () => {
  const { broker } = apiFixture({
    omitAdapterMethods: ["setVstIsolatedMarginForFlatSymbol"],
  });
  const capabilities = await broker.getCapabilities();
  assert.equal(capabilities.features.includes("guarded_isolated_margin_preparation"), false);
  assert.equal(capabilities.missingCapabilities.some(({ capability }) =>
    capability === "guarded_isolated_margin_preparation"), true);
});

test("impulse capability survives safe flat-to-active transition but rejects foreign exposure", async () => {
  const positions = [];
  const orders = [];
  const { broker } = apiFixture({ positions, orders });
  const flat = await broker.getCapabilities();
  assert.equal(flat.features.includes("impulse_runner_stop_and_partial_close"), true);

  positions.push({
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: "0.1",
    avgPrice: "100",
    positionId: "owned-position",
  });
  orders.push(
    {
      symbol: "BTC-USDT",
      orderId: "owned-core-stop",
      mainOrderId: "owned-entry",
      type: "STOP_MARKET",
      status: "NEW",
      side: "SELL",
      positionSide: "LONG",
      workingType: "MARK_PRICE",
      positionId: "owned-position",
      origQty: "0.08",
      stopPrice: "95",
    },
    {
      symbol: "BTC-USDT",
      orderId: "owned-runner-stop",
      mainOrderId: "owned-entry",
      type: "STOP_MARKET",
      status: "NEW",
      side: "SELL",
      positionSide: "LONG",
      workingType: "MARK_PRICE",
      positionId: "owned-position",
      origQty: "0.02",
      stopPrice: "100",
    },
  );
  const active = await broker.getCapabilities();
  assert.equal(active.features.includes("impulse_runner_stop_and_partial_close"), true);

  positions.push({
    symbol: "DOGE-USDT",
    positionSide: "LONG",
    positionAmt: "1",
    avgPrice: "100",
    positionId: "foreign-position",
  });
  const foreignPosition = await broker.getCapabilities();
  assert.equal(
    foreignPosition.features.includes("impulse_runner_stop_and_partial_close"),
    false,
  );

  positions.pop();
  orders.push({
    symbol: "BTC-USDT",
    orderId: "foreign-limit-order",
    type: "LIMIT",
    status: "NEW",
    side: "BUY",
    positionSide: "LONG",
    positionId: "owned-position",
    origQty: "0.01",
    price: "90",
  });
  const foreignOrder = await broker.getCapabilities();
  assert.equal(foreignOrder.features.includes("impulse_runner_stop_and_partial_close"), false);
});

test("active ETH management is discovered from account-wide reads when BTC is only a reference probe", async () => {
  const { broker, calls } = apiFixture({
    canarySymbols: ["BTCUSDT"],
    positions: [{
      symbol: "ETH-USDT",
      positionSide: "LONG",
      positionAmt: "0.1",
      avgPrice: "2000",
      positionId: "owned-eth-position",
    }],
    orders: [{
      symbol: "ETH-USDT",
      orderId: "owned-eth-stop",
      mainOrderId: "owned-eth-entry",
      type: "STOP_MARKET",
      status: "NEW",
      side: "SELL",
      positionSide: "LONG",
      workingType: "MARK_PRICE",
      positionId: "owned-eth-position",
      origQty: "0.1",
      stopPrice: "1900",
    }],
  });
  const capabilities = await broker.getCapabilities();
  assert.ok(capabilities.features.includes("impulse_runner_stop_and_partial_close"));
  assert.deepEqual(capabilities.evidence.activeManagementSymbols, ["ETHUSDT"]);
  assert.equal(calls.some(([name, symbol]) =>
    ["mark", "contract", "feeRate", "riskTiers"].includes(name) &&
      symbol === "ETHUSDT"), false);
  assert.ok(calls.some(([name, symbol]) => name === "getMarginType" && symbol === "ETHUSDT"));
  assert.ok(calls.some(([name, symbol]) => name === "getLeverage" && symbol === "ETHUSDT"));
});

test("active ETH capabilities do not depend on unrelated startup BTC market reads", async () => {
  const { api, broker, calls } = apiFixture({
    canarySymbols: ["BTCUSDT"],
    positions: [{
      symbol: "ETH-USDT",
      positionSide: "LONG",
      positionAmt: "0.1",
      avgPrice: "2000",
      positionId: "owned-eth-position",
    }],
    orders: [{
      symbol: "ETH-USDT",
      orderId: "owned-eth-stop",
      type: "STOP_MARKET",
      status: "NEW",
      side: "SELL",
      positionSide: "LONG",
      workingType: "MARK_PRICE",
      positionId: "owned-eth-position",
      origQty: "0.1",
      stopPrice: "1900",
    }],
  });
  const getMark = api.getVstMarkPrice;
  const contract = api.contract;
  const getMarginType = api.getMarginType;
  api.getVstMarkPrice = async (symbol) => {
    if (symbol === "BTCUSDT") throw new Error("unrelated BTC quote unavailable");
    return getMark(symbol);
  };
  api.contract = async (symbol) => {
    if (symbol === "BTCUSDT") throw new Error("unrelated BTC contract unavailable");
    return contract(symbol);
  };
  api.getMarginType = async (symbol) => {
    if (symbol === "BTCUSDT") throw new Error("unrelated BTC settings unavailable");
    return getMarginType(symbol);
  };

  const capabilities = await broker.getCapabilities();
  assert.ok(capabilities.features.includes("impulse_runner_stop_and_partial_close"));
  assert.ok(capabilities.features.includes("atomic_protected_market_entry"));
  assert.ok(capabilities.features.includes("verified_exact_full_position_close"));
  assert.deepEqual(capabilities.evidence.activeManagementSymbols, ["ETHUSDT"]);
  assert.ok(calls.some(([name, symbol]) => name === "history" && symbol === "ETHUSDT"));
  assert.ok(calls.some(([name, symbol]) => name === "fills" && symbol === "ETHUSDT"));
  assert.equal(calls.some(([name, symbol]) =>
    ["mark", "contract", "feeRate", "riskTiers", "getMarginType",
      "getLeverage"].includes(name) && symbol === "BTCUSDT"), false);
});

test("flat residual ETH stops preserve cleanup read trust without startup BTC probes or entry", async () => {
  const { api, broker, calls } = apiFixture({
    canarySymbols: ["BTCUSDT"],
    orders: [{
      symbol: "ETH-USDT",
      orderId: "known-residual-eth-stop",
      type: "STOP_MARKET",
      status: "NEW",
      side: "SELL",
      positionSide: "LONG",
      workingType: "MARK_PRICE",
      positionId: "closed-eth-position",
      origQty: "0.1",
      stopPrice: "1900",
    }],
  });
  const getMark = api.getVstMarkPrice;
  const contract = api.contract;
  const getMarginType = api.getMarginType;
  api.getVstMarkPrice = async (symbol) => {
    if (symbol === "BTCUSDT") throw new Error("unrelated BTC quote unavailable");
    return getMark(symbol);
  };
  api.contract = async (symbol) => {
    if (symbol === "BTCUSDT") throw new Error("unrelated BTC contract unavailable");
    return contract(symbol);
  };
  api.getMarginType = async (symbol) => {
    if (symbol === "BTCUSDT") throw new Error("unrelated BTC settings unavailable");
    return getMarginType(symbol);
  };

  const capabilities = await broker.getCapabilities();
  assert.ok(capabilities.features.includes("complete_order_lookup"));
  assert.ok(capabilities.features.includes("impulse_runner_stop_and_partial_close"));
  // Residual cleanup stops are a recognised shape, not a quarantine. Entry on
  // another symbol is allowed; ETH entry stays refused by the per-symbol
  // flat/no-orders preflight before signing.
  assert.deepEqual(capabilities.unverifiedSymbols, []);
  assert.deepEqual(capabilities.evidence.activeManagementSymbols, ["ETHUSDT"]);
  assert.ok(calls.some(([name, symbol]) => name === "history" && symbol === "ETHUSDT"));
  assert.ok(calls.some(([name, symbol]) => name === "fills" && symbol === "ETHUSDT"));
  assert.equal(calls.some(([name, symbol]) =>
    ["mark", "contract", "feeRate", "riskTiers", "getMarginType",
      "getLeverage"].includes(name) && symbol === "BTCUSDT"), false);
  assert.ok(calls.some(([name, symbol]) => name === "getMarginType" && symbol === "ETHUSDT"));
  assert.ok(calls.some(([name, symbol]) => name === "getLeverage" && symbol === "ETHUSDT"));
});

test("capability uses only its pre-read history clock", async () => {
  let clockReads = 0;
  const clock = () => {
    clockReads += 1;
    return clockReads === 1 ? now : now + 1_500;
  };
  const { broker, calls } = apiFixture({
    clock,
    quoteTimestamp: now + 1_000,
  });
  const capabilities = await broker.getCapabilities();
  assert.equal(capabilities.verified, true);
  assert.equal(capabilities.evidence.orderHistoryWindowEndMs, now);
  assert.equal(clockReads, 3);
  const historyCall = calls.find(([name]) => name === "history");
  assert.equal(historyCall[2].endTs, now);
});

test("capability retains per-active-symbol settings and protection checks without metadata reads", async () => {
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT"];
  const positions = symbols.map((symbol) => ({
    symbol: `${symbol.slice(0, -4)}-USDT`,
    positionSide: "LONG",
    positionAmt: "0.1",
    avgPrice: "100",
    positionId: `position-${symbol}`,
  }));
  const orders = symbols.map((symbol) => ({
    symbol: `${symbol.slice(0, -4)}-USDT`,
    orderId: `stop-${symbol}`,
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    workingType: "MARK_PRICE",
    positionId: `position-${symbol}`,
    origQty: "0.1",
    stopPrice: "90",
  }));
  const { broker, calls } = apiFixture({ positions, orders, canarySymbols: ["BTCUSDT"] });
  const capabilities = await broker.getCapabilities();
  assert.equal(capabilities.features.includes("impulse_runner_stop_and_partial_close"), true);
  assert.deepEqual(capabilities.evidence.activeManagementSymbols, symbols);
  assert.equal(calls.filter(([name]) => name === "getMarginType").length, symbols.length);
  assert.equal(calls.filter(([name]) => name === "getLeverage").length, symbols.length);
  assert.equal(calls.filter(([name]) => name === "getPositionMode").length, 1);
  assert.equal(calls.filter(([name]) => name === "balance").length, 1);
  assert.equal(calls.filter(([name]) => name === "positions").length, 1);
  assert.equal(calls.filter(([name]) => name === "openOrders").length, 1);
  assert.equal(calls.filter(([name]) => name === "history").length, 1);
  assert.equal(calls.filter(([name]) => name === "fills").length, 1);
  assert.equal(calls.some(([name]) =>
    ["contract", "feeRate", "riskTiers", "mark"].includes(name)), false);
});

test("active position capability fails closed when its stop or LONG leverage is unverified", async () => {
  const position = {
    symbol: "ETH-USDT",
    positionSide: "LONG",
    positionAmt: "0.1",
    avgPrice: "2000",
    positionId: "owned-eth-position",
  };
  const stop = {
    symbol: "ETH-USDT",
    orderId: "owned-eth-stop",
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    workingType: "MARK_PRICE",
    positionId: "owned-eth-position",
    origQty: "0.1",
    stopPrice: "1900",
  };
  const unprotected = apiFixture({ positions: [position], orders: [] });
  const withoutStop = await unprotected.broker.getCapabilities();
  assert.equal(withoutStop.features.includes("impulse_runner_stop_and_partial_close"), false);
  assert.deepEqual(withoutStop.unverifiedSymbols, ["ETHUSDT"]);

  const wrongLeverage = apiFixture({ positions: [position], orders: [stop] });
  wrongLeverage.api.getLeverage = async (symbol) => {
    wrongLeverage.calls.push(["getLeverage", symbol]);
    return { longLeverage: 9, shortLeverage: 3, maxPositionLongVal: 1_000_000 };
  };
  const leverageMismatch = await wrongLeverage.broker.getCapabilities();
  assert.equal(leverageMismatch.features.includes("impulse_runner_stop_and_partial_close"), false);
  assert.deepEqual(leverageMismatch.unverifiedSymbols, ["ETHUSDT"]);
});

test("API mock rejects epoch and over-24-hour history/fill requests", async () => {
  const { api } = apiFixture();
  await assert.rejects(
    api.queryOrderHistory("BTCUSDT", { startTs: 1, endTs: now }),
    /24 hours/,
  );
  await assert.rejects(
    api.queryFills("BTCUSDT", {
      startTs: now - 24 * 60 * 60_000 - 3_000,
      endTs: now,
      currency: "VST",
    }),
    /24 hours/,
  );
});

test("capability sample retries both fee currencies for a VST close fill", async () => {
  const pending = {
    symbol: "BTC-USDT",
    orderId: "newer-pending-order",
    clientOrderId: "pending-client-id",
    status: "NEW",
    executedQty: "0",
  };
  const close = {
    symbol: "BTC-USDT",
    orderId: "lossless-vst-close-order-90071992547409931",
    clientOrderId: "vst-close-client-id",
    status: "FILLED",
    side: "SELL",
    executedQty: "0.1",
  };
  const vstFill = {
    symbol: "BTC-USDT",
    orderId: close.orderId,
    tradeId: "vst-close-fill-1",
    side: "SELL",
    positionSide: "LONG",
    volume: "0.1",
    price: "99",
    filledTm: now,
    commission: "-0.001",
    currency: "VST",
  };
  const { broker, calls } = apiFixture({
    history: [pending, close],
    fills: [vstFill],
    strictFillCurrency: true,
  });
  const capabilities = await broker.getCapabilities();
  assert.ok(capabilities.features.includes("complete_order_lookup"));
  const sampledReads = calls.filter(([name, , range]) =>
    name === "fills" && range?.orderId === close.orderId);
  assert.deepEqual(sampledReads.map(([, , range]) => range.currency).sort(),
    ["USDT", "VST"]);
  assert.equal(sampledReads.some(([, , range]) =>
    range.currency === "USDT"), true);
  assert.equal(sampledReads.some(([, , range]) =>
    range.currency === "VST"), true);
});

test("capability sample deduplicates the same exact fill returned by both currency scopes", async () => {
  const close = {
    symbol: "BTC-USDT",
    orderId: "overlapping-vst-close-order-90071992547409931",
    clientOrderId: "overlapping-vst-close-client-id",
    status: "FILLED",
    side: "SELL",
    executedQty: "0.1",
  };
  const fill = {
    symbol: "BTC-USDT",
    orderId: close.orderId,
    tradeId: "overlapping-close-fill-1",
    side: "SELL",
    positionSide: "LONG",
    volume: "0.1",
    price: "99",
    filledTm: now,
    commission: "-0.001",
    currency: "USDT",
  };
  const { api, broker, calls } = apiFixture({ history: [close] });
  const originalQueryFills = api.queryFills;
  api.queryFills = async (symbol, range) => {
    if (range?.orderId === close.orderId) {
      calls.push(["fills", symbol, range]);
      return [fill];
    }
    return originalQueryFills(symbol, range);
  };

  const capabilities = await broker.getCapabilities();
  assert.ok(capabilities.features.includes("complete_order_lookup"));
  const sampledReads = calls.filter(([name, , range]) =>
    name === "fills" && range?.orderId === close.orderId);
  assert.deepEqual(sampledReads.map(([, , range]) => range.currency).sort(),
    ["USDT", "VST"]);
});

test("capability sample rejects conflicting duplicate fill identities across currency scopes", async () => {
  const close = {
    symbol: "BTC-USDT",
    orderId: "conflicting-vst-close-order-90071992547409931",
    clientOrderId: "conflicting-vst-close-client-id",
    status: "FILLED",
    side: "SELL",
    executedQty: "0.1",
  };
  const vstScopedFill = {
    symbol: "BTC-USDT",
    orderId: close.orderId,
    tradeId: "conflicting-close-fill-1",
    side: "SELL",
    positionSide: "LONG",
    volume: "0.1",
    price: "99",
    filledTm: now,
    commission: "-0.001",
    currency: "USDT",
  };
  const usdtScopedFill = {
    ...vstScopedFill,
    price: "98",
    commission: "-0.002",
  };
  const { api, broker } = apiFixture({ history: [close] });
  const originalQueryFills = api.queryFills;
  api.queryFills = async (symbol, range) => {
    if (range?.orderId === close.orderId) {
      return [range.currency === "VST" ? vstScopedFill : usdtScopedFill];
    }
    return originalQueryFills(symbol, range);
  };

  const capabilities = await broker.getCapabilities();
  assert.equal(capabilities.features.includes("complete_order_lookup"), false);
  assert.match(
    capabilities.missingCapabilities.find(({ capability }) =>
      capability === "complete_order_lookup").reason,
    /did not support a lossless order-ID-to-fills lookup/,
  );
});

test("24-hour history and fill-by-ID protocol proves lookup and guarded preparation from exchange-read 75x", async () => {
  const historyRow = {
    symbol: "BTC-USDT",
    orderId: "lossless-order-90071992547409931",
    clientOrderId: "known-client-order",
    status: "FILLED",
  };
  const { broker, calls } = apiFixture({
    queriedOrder: historyRow,
    history: [historyRow],
    fills: [{
      symbol: "BTC-USDT",
      orderId: historyRow.orderId,
      volume: "0.1",
      price: "100",
    }],
    longLeverage: 75,
  });
  const capabilities = await broker.getCapabilities();
  assert.ok(capabilities.features.includes("complete_order_lookup"));
  assert.ok(capabilities.features.includes("guarded_long10_leverage_preparation"));
  assert.equal(capabilities.features.includes("verified_isolated_leverage"), false);
  const historyCall = calls.find(([name]) => name === "history");
  assert.ok(historyCall[2].endTs - historyCall[2].startTs <= 24 * 60 * 60_000);
  assert.ok(calls.some(([name, , range]) =>
    name === "fills" && range.orderId === historyRow.orderId));

  await broker.performIntent({
    clientOrderId: "worker-leverage-intent",
    phase: "isolated-leverage-10",
    request: {
      operation: "set_isolated_leverage",
      symbol: "BTCUSDT",
      environment: "vst",
      accountId: "test-vst-account",
      marginMode: "ISOLATED",
      leverage: 10,
    },
  });
  assert.ok(calls.some(([name, symbol]) =>
    name === "setVstLongLeverage10" && symbol === "BTCUSDT"));
  const leverageEvidence = await broker.reconcileIntent({
    clientOrderId: "worker-leverage-intent",
    phase: "isolated-leverage-10",
    request: {
      operation: "set_isolated_leverage",
      symbol: "BTCUSDT",
      environment: "vst",
      accountId: "test-vst-account",
      marginMode: "ISOLATED",
      leverage: 10,
    },
  });
  assert.equal(leverageEvidence.verified, true);
  assert.equal(leverageEvidence.position.leverage, 10);
});

test("planning inputs use the fresh exchange VST balance, contract, fees, tiers, and mark", async () => {
  const { broker } = apiFixture();
  const result = await broker.readPlanningInputs({ symbol: "BTCUSDT" });
  assert.equal(result.balanceSnapshot[0].asset, "VST");
  assert.equal(result.filters.symbol, "BTC-USDT");
  assert.equal(result.quote.price, 100);
  assert.equal(result.quote.observedAtMs, now);
  assert.equal(result.risk.takerFeeRate, 0.0005);
  assert.equal(result.risk.fundingRate, 0);
  assert.equal(result.risk.maintenanceMarginRate, 0.005);
  assert.equal(result.risk.tickSize, 0.1);
  assert.equal(result.risk.maxPositionValue, 1_000_000);
});

test("a currently-offline contract is a distinct planning failure, not an opaque exchange error", async () => {
  const { broker } = apiFixture({
    contractOfflineMessage: "ICP-USDT is offline currently,all validted symbols in api:" +
      "/openApi/swap/v2/quote/contracts, please verify it",
  });
  await assert.rejects(
    broker.readPlanningInputs({ symbol: "ICPUSDT" }),
    (error) => {
      assert.equal(error.code, "vst_symbol_currently_offline");
      assert.match(error.message, /bingx_vst_symbol_currently_offline:ICP-USDT/);
      assert.match(error.exchangeMessage, /ICP-USDT is offline currently/);
      return true;
    },
  );
});

test("planning selects the smallest maintenance tier covering worst-case one-percent notional", async () => {
  const { broker } = apiFixture({
    balanceSnapshot: [{ asset: "VST", balance: "10000000", availableMargin: "200000" }],
    markPrice: "84000",
    tiers: [
      { maxNotional: 100_000, maintenanceMarginRate: 0.03 },
      { maxNotional: 2_000_000, maintenanceMarginRate: 0.005 },
      { maxNotional: 1_000_000_000, maintenanceMarginRate: 0.2 },
    ],
  });
  const planning = await broker.readPlanningInputs({ symbol: "BTCUSDT" });
  assert.equal(planning.risk.maintenanceMarginRate, 0.005);
  const sizing = sizeVstLongTrade({
    environment: "vst",
    symbol: "BTCUSDT",
    balanceSnapshot: planning.balanceSnapshot,
    quote: planning.quote,
    nowMs: now,
    maxQuoteAgeMs: 10_000,
    expectedPrice: "84000",
    maxPriceMoveBps: 0,
    maxSlippageBps: 0,
    stopLoss: "82320",
    filters: planning.filters,
    takerFeeRate: planning.risk.takerFeeRate,
    fundingRate: planning.risk.fundingRate,
    maintenanceMarginRate: planning.risk.maintenanceMarginRate,
    stopBufferRate: planning.risk.stopBufferRate,
    tickSize: planning.risk.tickSize,
    maxPositionValue: planning.risk.maxPositionValue,
  });
  assert.equal(sizing.status, "ready");
  assert.equal(sizing.plannedTopUpVst, 0);
});

test("planning feeds signed nonzero funding into deep-stop VST sizing", async () => {
  const { broker } = apiFixture({ fundingRate: "0.001" });
  const planning = await broker.readPlanningInputs({ symbol: "BTCUSDT" });
  const inputs = {
    environment: "vst",
    symbol: "BTCUSDT",
    balanceSnapshot: planning.balanceSnapshot,
    quote: planning.quote,
    nowMs: now,
    maxQuoteAgeMs: 10_000,
    expectedPrice: "100",
    maxPriceMoveBps: 500,
    maxSlippageBps: 100,
    stopLoss: "85",
    filters: planning.filters,
    takerFeeRate: planning.risk.takerFeeRate,
    fundingRate: planning.risk.fundingRate,
    maintenanceMarginRate: planning.risk.maintenanceMarginRate,
    stopBufferRate: planning.risk.stopBufferRate,
    tickSize: planning.risk.tickSize,
    maxPositionValue: planning.risk.maxPositionValue,
  };
  const fundedRateSizing = sizeVstLongTrade(inputs);
  const zeroRateSizing = sizeVstLongTrade({ ...inputs, fundingRate: 0 });
  assert.equal(planning.risk.fundingRate, 0.001);
  assert.equal(fundedRateSizing.status, "ready");
  assert.equal(fundedRateSizing.fundingRate, 0.001);
  assert.ok(fundedRateSizing.plannedTopUpVst > zeroRateSizing.plannedTopUpVst);
});

test("planning fails closed when no valid maintenance tier covers worst-case notional", async () => {
  const { broker } = apiFixture({
    balanceSnapshot: [{ asset: "VST", balance: "10000000", availableMargin: "200000" }],
    markPrice: "84000",
    tiers: [
      { maxNotional: 100_000, maintenanceMarginRate: 0.005 },
      { maxNotional: 999_999, maintenanceMarginRate: 0.005 },
    ],
  });
  await assert.rejects(
    broker.readPlanningInputs({ symbol: "BTCUSDT" }),
    /bingx_vst_no_risk_tier_covers_worst_case_notional/,
  );
});

test("planning rejects invalid tiers even when another tier covers worst-case notional", async () => {
  const { broker } = apiFixture({
    balanceSnapshot: [{ asset: "VST", balance: "10000000", availableMargin: "200000" }],
    markPrice: "84000",
    tiers: [
      { maxNotional: 2_000_000, maintenanceMarginRate: 0.005 },
      { maxNotional: "not-a-number", maintenanceMarginRate: 0.2 },
    ],
  });
  await assert.rejects(
    broker.readPlanningInputs({ symbol: "BTCUSDT" }),
    /bingx_vst_invalid_risk_tier_max_notional/,
  );
});

test("flat HEDGE CROSSED ETH planning returns a guarded margin-preparation requirement", async () => {
  const { broker, calls } = apiFixture({
    canarySymbols: ["BTCUSDT"],
    marginModes: { ETHUSDT: "CROSSED" },
  });
  const planning = await broker.readPlanningInputs({ symbol: "ETHUSDT" });
  assert.equal(planning.marginMode, "CROSSED");
  assert.equal(planning.marginModeVerified, false);
  assert.equal(planning.requiresIsolatedMarginPreparation, true);
  assert.equal(calls.some(([name]) =>
    name === "setVstIsolatedMarginForFlatSymbol" ||
    name === "setVstLongLeverage10"), false);
});

test("ETH entry and LONG10 preparation remain blocked until isolated margin is verified", async () => {
  const { broker, calls } = apiFixture({
    canarySymbols: ["BTCUSDT"],
    marginModes: { ETHUSDT: "CROSSED" },
    longLeverage: 75,
  });
  const base = {
    symbol: "ETHUSDT",
    environment: "vst",
    accountId: "test-vst-account",
  };
  await assert.rejects(broker.performIntent({
    clientOrderId: "worker-eth-entry-crossed",
    phase: "market-entry",
    request: {
      ...base,
      operation: "entry",
      entryOrderType: "MARKET",
      side: "Buy",
      marginMode: "ISOLATED",
      leverage: 10,
      quantity: "0.1",
      maxEntryPrice: "100",
      stopLoss: "95",
    },
  }), /bingx_vst_entry_requires_verified_hedge_isolated_long10/);
  await assert.rejects(broker.performIntent({
    clientOrderId: "worker-eth-leverage-crossed",
    phase: "isolated-leverage-10",
    request: {
      ...base,
      operation: "set_isolated_leverage",
      marginMode: "ISOLATED",
      leverage: 10,
    },
  }), /bingx_vst_hedge_isolated_margin_must_be_exchange_verified/);
  assert.equal(calls.some(([name]) =>
    name === "entry" || name === "setVstLongLeverage10"), false);
});

test("non-startup ETH signal planning and entry remain admitted with BTC as the reference probe", async () => {
  const { broker, calls } = apiFixture({ canarySymbols: ["BTCUSDT"] });
  const planning = await broker.readPlanningInputs({ symbol: "ETHUSDT" });
  assert.equal(planning.filters.symbol, "ETH-USDT");
  assert.equal(planning.quote.price, 100);
  assert.ok(calls.some(([name, symbol]) => name === "contract" && symbol === "ETHUSDT"));
  assert.ok(calls.some(([name, symbol]) => name === "mark" && symbol === "ETHUSDT"));

  await broker.performIntent({
    clientOrderId: "worker-eth-entry",
    phase: "market-entry",
    request: {
      operation: "entry",
      entryOrderType: "MARKET",
      symbol: "ETHUSDT",
      environment: "vst",
      accountId: "test-vst-account",
      side: "Buy",
      marginMode: "ISOLATED",
      leverage: 10,
      quantity: "0.1",
      maxEntryPrice: "100",
      stopLoss: "95",
      approvedTopUpMargin: "5.25",
    },
  });
  const entryCall = calls.find(([name]) => name === "entry");
  assert.equal(entryCall[1].symbol, "ETHUSDT");
  assert.equal(entryCall[1].approvedTopUpMargin, "5.25");
});

test("a synchronous exchange rejection on entry is tagged so callers can skip the ambiguous-failure wait", async () => {
  const { api: rejectedApi, broker: rejectedBroker } = apiFixture({
    canarySymbols: ["ETHUSDT"],
  });
  rejectedApi.placeVstAutomatedLong = async () => {
    throw new BingXLiveApiError(
      "BingX private request failed (HTTP 200, code 101209, msg: " +
        "The maximum position value for this leverage is 5000 USDT)",
      { httpStatus: 200, code: 101209, transportStage: "exchange_response" },
    );
  };
  const base = {
    symbol: "ETHUSDT", environment: "vst", accountId: "test-vst-account",
    operation: "entry", entryOrderType: "MARKET",
    side: "Buy", marginMode: "ISOLATED", leverage: 10,
    quantity: "0.1", maxEntryPrice: "100", stopLoss: "95",
  };
  await assert.rejects(
    rejectedBroker.performIntent({
      clientOrderId: "worker-eth-entry-rejected", phase: "market-entry", request: base,
    }),
    (error) => {
      assert.equal(error.definiteRejection, true);
      assert.equal(error.code, 101209);
      return true;
    },
  );

  const { api: preSignApi, broker: preSignBroker } = apiFixture({
    canarySymbols: ["ETHUSDT"],
  });
  preSignApi.placeVstAutomatedLong = async () => {
    throw new BingXLiveApiError("BingX final pre-sign check failed", {
      transportStage: "pre_transport", preSignReason: "final_budget_exceeded",
    });
  };
  await assert.rejects(
    preSignBroker.performIntent({
      clientOrderId: "worker-eth-entry-presign", phase: "market-entry", request: base,
    }),
    (error) => {
      assert.equal(error.definiteRejection, true);
      assert.equal(error.preSignReason, "final_budget_exceeded");
      return true;
    },
  );

  // A genuinely ambiguous transport failure (no completed exchange response)
  // must NOT be tagged -- there is no proof the order was never accepted.
  const { api: networkFailureApi, broker: networkFailureBroker } = apiFixture({
    canarySymbols: ["ETHUSDT"],
  });
  networkFailureApi.placeVstAutomatedLong = async () => {
    throw new BingXLiveApiError("BingX private request failed: TimeoutError", {
      transportStage: "network_request",
    });
  };
  await assert.rejects(
    networkFailureBroker.performIntent({
      clientOrderId: "worker-eth-entry-ambiguous", phase: "market-entry", request: base,
    }),
    (error) => {
      assert.equal(error.definiteRejection, undefined);
      return true;
    },
  );
});

test("VST margin top-up persists and reconciles exact margin delta without retry", async () => {
  const position = {
    symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
    positionId: "position-topup", isolatedMargin: "10", avgPrice: "100",
    liquidationPrice: "80",
  };
  const stop = {
    symbol: "BTC-USDT", orderId: "stop-topup", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", workingType: "MARK_PRICE",
    positionId: "position-topup", mainOrderId: "entry-topup",
    origQty: "0.1", stopPrice: "90",
  };
  const { api, broker, calls } = apiFixture({
    positions: [position],
    orders: [stop],
  });
  const request = {
    operation: "margin_top_up",
    environment: "vst",
    accountId: "test-vst-account",
    symbol: "BTCUSDT",
    positionId: "position-topup",
    entryOrderId: "entry-topup",
    quantity: "0.1",
    stopLoss: "90",
    stopOrderId: "stop-topup",
    expectedIsolatedMarginBefore: "10",
    amount: "5.25",
    approvedTopUpMargin: "5.25",
    intentCreatedAt: now - 1000,
  };
  const baseline = await broker.readMarginTopUpBaseline(request);
  assert.deepEqual(baseline, {
    verified: true,
    environment: "vst",
    accountId: "test-vst-account",
    symbol: "BTCUSDT",
    positionId: "position-topup",
    quantity: "0.1",
    entryOrderId: "entry-topup",
    isolatedMarginBefore: "10",
    protectiveStop: {
      orderId: "stop-topup",
      positionId: "position-topup",
      quantity: "0.1",
      stopPrice: "90",
      status: "NEW",
      workingType: "MARK_PRICE",
    },
  });
  const noAddition = await broker.verifyMarginTopUpNotAdded(request);
  assert.equal(noAddition.verified, true);
  assert.equal(noAddition.status, "not_added");
  assert.equal(noAddition.safe, true);
  assert.equal(noAddition.protectiveStop.orderId, "stop-topup");
  position.liquidationPrice = "90";
  const unsafe = await broker.verifyMarginTopUpNotAdded(request);
  assert.equal(unsafe.verified, false);
  assert.equal(unsafe.status, "unsafe_protection");
  position.liquidationPrice = "80";
  assert.deepEqual(await broker.reconcileIntent({
    clientOrderId: "worker-margin-topup-1", phase: "margin-top-up", request,
  }), {
    verified: false,
    status: "unknown",
  },
  "an unchanged entry margin is not evidence that the adjustment failed");

  await broker.performIntent({
    clientOrderId: "worker-margin-topup-1",
    phase: "margin-top-up",
    request,
  });
  assert.equal(calls.filter(([name]) => name === "addVstIsolatedLongMargin").length, 1);
  const additionPresent = await broker.verifyMarginTopUpNotAdded(request);
  assert.equal(additionPresent.verified, false);
  assert.equal(additionPresent.status, "addition_found");
  assert.equal(additionPresent.additions, 1);
  const evidence = await broker.reconcileIntent({
    clientOrderId: "worker-margin-topup-1",
    phase: "margin-top-up",
    request,
  });
  assert.deepEqual(evidence, {
    verified: true,
    status: "filled",
    symbol: "BTCUSDT",
    positionId: "position-topup",
    positionSide: "LONG",
    quantity: "0.1",
    amount: "5.25",
    isolatedMarginBefore: "10",
    isolatedMarginAfter: "15.25",
    marginDelta: "5.25",
    marginHistory: {
      source: "bingx_position_margin_history",
      changeReason: "ManualMarginAddition",
      attribution: "unique_exchange_adjustment_without_operation_id",
      positionId: "position-topup",
      amount: "5.25",
      time: now,
    },
    protectiveStop: {
      orderId: "stop-topup",
      positionId: "position-topup",
      quantity: "0.1",
      stopPrice: "90",
      status: "NEW",
      workingType: "MARK_PRICE",
    },
  });

  const restartedBroker = createVstBroker({
    api, accountId: "test-vst-account", canarySymbols: ["BTCUSDT"],
    clock: () => now, stopBufferRate: 0.005,
  });
  const restartEvidence = await restartedBroker.reconcileIntent({
    clientOrderId: "worker-margin-topup-1", phase: "margin-top-up", request,
  });
  assert.deepEqual(restartEvidence, evidence);
  const readHistory = api.getPositionMarginHistory.bind(api);
  api.getPositionMarginHistory = async (...args) => {
    const result = await readHistory(...args);
    return { total: 1, records: [{
      ...result.records[0],
      marginChange: "5.24999999",
      marginAfterChange: "15.24999999",
    }] };
  };
  const rounded = await restartedBroker.reconcileIntent({
    clientOrderId: "worker-margin-topup-1", phase: "margin-top-up", request,
  });
  assert.equal(rounded.verified, true,
    "the VST host may round the adjustment down by one 1e-8 unit");
  assert.equal(rounded.marginDelta, "5.24999999");
  assert.equal(rounded.isolatedMarginAfter, "15.24999999");
  api.getPositionMarginHistory = async (...args) => {
    const result = await readHistory(...args);
    return { total: 2, records: [result.records[0], result.records[0]] };
  };
  assert.deepEqual(await restartedBroker.reconcileIntent({
    clientOrderId: "worker-margin-topup-1", phase: "margin-top-up", request,
  }), { verified: false, status: "unknown" },
  "two indistinguishable additions cannot be attributed to one POST");
  api.getPositionMarginHistory = readHistory;
  await assert.rejects(restartedBroker.performIntent({
    clientOrderId: "worker-margin-topup-1", phase: "margin-top-up", request,
  }), /prior_addition_or_history_unverified/);
  assert.equal(calls.filter(([name]) => name === "addVstIsolatedLongMargin").length, 1);

  position.isolatedMargin = "15.26";
  assert.deepEqual(await restartedBroker.reconcileIntent({
    clientOrderId: "worker-margin-topup-1", phase: "margin-top-up", request,
  }), { verified: false, status: "unknown" },
  "an unexplained margin increase above approval cannot prove exact funding");
  position.isolatedMargin = "15.25";

  stop.stopPrice = "91";
  const missingProtection = await restartedBroker.reconcileIntent({
    clientOrderId: "worker-margin-topup-1", phase: "margin-top-up", request,
  });
  assert.deepEqual(missingProtection, { verified: false, status: "unknown" });
  assert.equal(calls.filter(([name]) => name === "addVstIsolatedLongMargin").length, 1);
});

test("a unique exact margin-history addition is reconciled after the former 120-second window", async () => {
  const position = {
    symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
    positionId: "position-late-topup", isolatedMargin: "10", avgPrice: "100",
    liquidationPrice: "80",
  };
  const stop = {
    symbol: "BTC-USDT", orderId: "stop-late-topup", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", workingType: "MARK_PRICE",
    positionId: "position-late-topup", mainOrderId: "entry-late-topup",
    origQty: "0.1", stopPrice: "90",
  };
  const { api, broker, calls } = apiFixture({ positions: [position], orders: [stop] });
  const request = {
    operation: "margin_top_up",
    environment: "vst",
    accountId: "test-vst-account",
    symbol: "BTCUSDT",
    positionId: "position-late-topup",
    entryOrderId: "entry-late-topup",
    quantity: "0.1",
    stopLoss: "90",
    stopOrderId: "stop-late-topup",
    expectedIsolatedMarginBefore: "10",
    amount: "5.25",
    approvedTopUpMargin: "5.25",
    intentCreatedAt: now - 5 * 60_000,
  };
  await broker.performIntent({
    clientOrderId: "worker-margin-topup-late", phase: "margin-top-up", request,
  });
  const rows = Array.from({ length: 100 }, (_, index) => ({
    symbol: "BTC-USDT",
    positionId: "position-late-topup",
    changeReason: "OtherAdjustment",
    marginChange: "1",
    marginAfterChange: "11",
    time: request.intentCreatedAt + index,
  }));
  rows.push({
    symbol: "BTC-USDT",
    positionId: "position-late-topup",
    changeReason: "ManualMarginAddition",
    marginChange: "5.25",
    marginAfterChange: "15.25",
    time: now,
  });
  api.getPositionMarginHistory = async (symbol, positionId, range) => {
    calls.push(["marginHistory", symbol, positionId, range]);
    const offset = (range.pageIndex - 1) * range.pageSize;
    return { total: rows.length, records: rows.slice(offset, offset + range.pageSize) };
  };
  const evidence = await broker.reconcileIntent({
    clientOrderId: "worker-margin-topup-late", phase: "margin-top-up", request,
  });
  assert.equal(evidence.verified, true);
  assert.equal(evidence.status, "filled");
  assert.equal(evidence.marginHistory.time, now);
  assert.equal(evidence.marginDelta, "5.25");
  assert.equal(calls.filter(([name]) => name === "addVstIsolatedLongMargin").length, 1);
  assert.ok(calls.some(([name, , , range]) =>
    name === "marginHistory" && range.startTime === request.intentCreatedAt &&
    range.endTime === now));
  assert.ok(calls.some(([name, , , range]) =>
    name === "marginHistory" && range.pageIndex === 2));
});

test("margin history must match the stored entry baseline within its rounding precision", async () => {
  const createScenario = (marginAfterChange) => {
    const position = {
      symbol: "PENGU-USDT",
      positionSide: "LONG",
      positionAmt: "501052.2",
      positionId: "position-rounded-baseline",
      initialMargin: "498.1881",
      avgPrice: "0.009942",
      liquidationPrice: "0.008713",
    };
    const stop = {
      symbol: "PENGU-USDT",
      orderId: "stop-rounded-baseline",
      type: "STOP_MARKET",
      status: "NEW",
      side: "SELL",
      positionSide: "LONG",
      workingType: "MARK_PRICE",
      positionId: "position-rounded-baseline",
      mainOrderId: "entry-rounded-baseline",
      origQty: "501052.2",
      stopPrice: "0.008937",
    };
    const { api, broker, calls } = apiFixture({
      positions: [position],
      orders: [stop],
    });
    api.getPositionMarginHistory = async (symbol, positionId, range) => {
      calls.push(["marginHistory", symbol, positionId, range]);
      return {
        total: 1,
        records: [{
          symbol: "PENGU-USDT",
          positionId: "position-rounded-baseline",
          changeReason: "ManualMarginAddition",
          marginChange: "149.45999999",
          marginAfterChange,
          time: now,
        }],
      };
    };
    return {
      api,
      broker,
      calls,
      request: {
        operation: "margin_top_up",
        environment: "vst",
        accountId: "test-vst-account",
        symbol: "PENGUUSDT",
        positionId: "position-rounded-baseline",
        entryOrderId: "entry-rounded-baseline",
        quantity: "501052.2",
        stopLoss: "0.008937",
        stopOrderId: "stop-rounded-baseline",
        expectedIsolatedMarginBefore: "498.1881",
        amount: "149.46",
        approvedTopUpMargin: "149.46",
        intentCreatedAt: now - 5 * 60_000,
      },
    };
  };
  const actualExchangeRounding = createScenario("647.64807704");
  const actualEvidence = await actualExchangeRounding.broker.reconcileIntent({
    clientOrderId: "worker-margin-rounded-baseline",
    phase: "margin-top-up",
    request: actualExchangeRounding.request,
  });
  assert.equal(actualEvidence.verified, true, JSON.stringify(actualEvidence));
  assert.equal(actualEvidence.status, "filled");
  assert.equal(actualEvidence.isolatedMarginBefore, "498.18807705");
  assert.equal(actualEvidence.marginHistory.attribution,
    "unique_exchange_adjustment_without_operation_id");
  assert.equal(actualExchangeRounding.calls.some(([name]) =>
    name === "addVstIsolatedLongMargin"), false);

  const unrelatedSameSizeAdjustment = createScenario("947.64807704");
  assert.deepEqual(await unrelatedSameSizeAdjustment.broker.reconcileIntent({
    clientOrderId: "worker-margin-unrelated-adjustment",
    phase: "margin-top-up",
    request: unrelatedSameSizeAdjustment.request,
  }), { verified: false, status: "unknown" },
  "an exact-size owner adjustment from a different pre-margin is not proof of the bot POST");
  assert.equal(unrelatedSameSizeAdjustment.calls.some(([name]) =>
    name === "addVstIsolatedLongMargin"), false);
});

test("a same-baseline same-amount manual adjustment is exchange evidence, not proof of a bot POST", async () => {
  const position = {
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: "0.1",
    positionId: "position-manual-adjustment",
    initialMargin: "10.00",
    avgPrice: "100",
    liquidationPrice: "80",
  };
  const stop = {
    symbol: "BTC-USDT",
    orderId: "stop-manual-adjustment",
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    workingType: "MARK_PRICE",
    positionId: "position-manual-adjustment",
    mainOrderId: "entry-manual-adjustment",
    origQty: "0.1",
    stopPrice: "90",
  };
  const { api, broker, calls } = apiFixture({
    positions: [position],
    orders: [stop],
  });
  api.getPositionMarginHistory = async (symbol, positionId, range) => {
    calls.push(["marginHistory", symbol, positionId, range]);
    return {
      total: 1,
      records: [{
        symbol: "BTC-USDT",
        positionId: "position-manual-adjustment",
        changeReason: "ManualMarginAddition",
        marginChange: "5.25",
        marginAfterChange: "15.25",
        time: now,
      }],
    };
  };
  const request = {
    operation: "margin_top_up",
    environment: "vst",
    accountId: "test-vst-account",
    symbol: "BTCUSDT",
    positionId: "position-manual-adjustment",
    entryOrderId: "entry-manual-adjustment",
    quantity: "0.1",
    stopLoss: "90",
    stopOrderId: "stop-manual-adjustment",
    expectedIsolatedMarginBefore: "10.00",
    amount: "5.25",
    approvedTopUpMargin: "5.25",
    intentCreatedAt: now - 5 * 60_000,
  };

  // No performIntent call is made: model a never-sent/never-executed bot POST
  // followed by an owner manually adding the identical amount from the exact
  // persisted baseline. BingX history cannot tell these cases apart.
  const evidence = await broker.reconcileIntent({
    clientOrderId: "worker-manual-adjustment-no-post",
    phase: "margin-top-up",
    request,
  });

  assert.equal(evidence.verified, true);
  assert.equal(evidence.status, "filled");
  assert.equal(evidence.marginHistory.source, "bingx_position_margin_history");
  assert.equal(evidence.marginHistory.attribution,
    "unique_exchange_adjustment_without_operation_id");
  assert.equal(evidence.marginHistory.amount, "5.25");
  assert.equal(Object.hasOwn(evidence.marginHistory, "clientOrderId"), false);
  assert.doesNotMatch(JSON.stringify(evidence), /bot_post_confirmed|posted_by_bot/i);
  assert.equal(calls.filter(([name]) => name === "addVstIsolatedLongMargin").length, 0);
});

test("margin top-up remains unknown when margin history is incomplete or unreadable", async () => {
  const position = {
    symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
    positionId: "position-history-unknown", isolatedMargin: "10", avgPrice: "100",
    liquidationPrice: "80",
  };
  const stop = {
    symbol: "BTC-USDT", orderId: "stop-history-unknown", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", workingType: "MARK_PRICE",
    positionId: "position-history-unknown", mainOrderId: "entry-history-unknown",
    origQty: "0.1", stopPrice: "90",
  };
  const { api, broker, calls } = apiFixture({ positions: [position], orders: [stop] });
  const request = {
    operation: "margin_top_up",
    environment: "vst",
    accountId: "test-vst-account",
    symbol: "BTCUSDT",
    positionId: "position-history-unknown",
    entryOrderId: "entry-history-unknown",
    quantity: "0.1",
    stopLoss: "90",
    stopOrderId: "stop-history-unknown",
    expectedIsolatedMarginBefore: "10",
    amount: "5",
    approvedTopUpMargin: "5",
    intentCreatedAt: now - 10 * 60_000,
  };
  api.getPositionMarginHistory = async (_symbol, _positionId, range) => ({
    total: 301,
    records: range.pageIndex === 1 ? Array.from({ length: 100 }, () => ({
      symbol: "BTC-USDT",
      positionId: "position-history-unknown",
      changeReason: "OtherAdjustment",
      marginChange: "1",
      marginAfterChange: "11",
      time: now - 1,
    })) : [],
  });
  assert.deepEqual(await broker.reconcileIntent({
    clientOrderId: "worker-margin-history-incomplete", phase: "margin-top-up", request,
  }), { verified: false, status: "unknown" });
  await assert.rejects(broker.verifyMarginTopUpNotAdded(request),
    /margin_history_incomplete/);
  assert.equal(calls.some(([name, , , range]) =>
    name === "marginHistory" && range.pageIndex > 1), false,
  "histories over three pages fail closed without slow pagination");
  api.getPositionMarginHistory = async () => { throw new Error("history read failed"); };
  assert.deepEqual(await broker.reconcileIntent({
    clientOrderId: "worker-margin-history-failed", phase: "margin-top-up", request,
  }), { verified: false, status: "unknown" });
  await assert.rejects(broker.verifyMarginTopUpNotAdded(request), /history read failed/);
  assert.equal(calls.filter(([name]) => name === "addVstIsolatedLongMargin").length, 0);
});

test("VST margin top-up baseline reads real BingX field name, not the nonexistent isolatedMargin", async () => {
  // BingX's actual swap v2 positions response has no "isolatedMargin" field at
  // all -- only "initialMargin" (documented) and "margin" (undocumented,
  // includes unrealized PnL). A position shaped exactly like the live
  // response must still produce a verified baseline instead of throwing
  // bingx_vst_invalid_margin_top_up_isolated_margin_before on every read.
  const position = {
    symbol: "OND-USDT", positionSide: "LONG", positionAmt: "500",
    positionId: "position-real-shape", initialMargin: "982.3278",
    margin: "1043.5918", unrealizedProfit: "61.2640",
  };
  const stop = {
    symbol: "OND-USDT", orderId: "stop-real-shape", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", workingType: "MARK_PRICE",
    positionId: "position-real-shape", mainOrderId: "entry-real-shape",
    origQty: "500", stopPrice: "0.4681",
  };
  const { broker } = apiFixture({
    positions: [position],
    orders: [stop],
  });
  const baseline = await broker.readMarginTopUpBaseline({
    environment: "vst",
    accountId: "test-vst-account",
    symbol: "ONDUSDT",
    positionId: "position-real-shape",
    entryOrderId: "entry-real-shape",
    quantity: "500",
    stopLoss: "0.4681",
  });
  assert.equal(baseline.verified, true);
  assert.equal(baseline.isolatedMarginBefore, "982.3278",
    "must read the documented initialMargin field, not the PnL-inflated margin field");
});

test("VST live plan accepts wrapped balance and sizes GRT above its exchange minimum", async () => {
  const position = {
    symbol: "GRT-USDT", positionSide: "LONG", positionAmt: "339778",
    positionId: "grt-position", initialMargin: "975.0716",
    avgPrice: "0.02869", liquidationPrice: "0.02609", minIncreaseMargin: "292.52",
  };
  const stop = {
    symbol: "GRT-USDT", orderId: "grt-stop", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", workingType: "MARK_PRICE",
    positionId: "grt-position", mainOrderId: "grt-entry",
    origQty: "339778", stopPrice: "0.02591",
  };
  const { broker } = apiFixture({
    positions: [position], orders: [stop], canarySymbols: ["GRTUSDT"],
    balanceSnapshot: { balance: [{ asset: "VST", balance: "97681",
      availableMargin: "95732.0667" }] },
    pricePrecision: 5,
  });
  const request = {
    environment: "vst", accountId: "test-vst-account", symbol: "GRTUSDT",
    positionId: "grt-position", entryOrderId: "grt-entry",
    quantity: "339778", stopLoss: "0.02591",
  };
  const plan = await broker.readMarginTopUpPlan(request);
  assert.equal(plan.amount, "292.53");
  assert.equal(plan.protectiveStop.orderId, "grt-stop");
  const before = await broker.readMarginTopUpProtection(request);
  assert.equal(before.safe, false);
});

test("fresh broker reconciles an unknown persisted ETH intent read-only", async () => {
  const { broker, calls } = apiFixture({ canarySymbols: ["BTCUSDT"] });
  const result = await broker.reconcileIntent({
    clientOrderId: "worker-eth-restart",
    phase: "market-entry",
    request: {
      operation: "entry",
      entryOrderType: "MARKET",
      symbol: "ETHUSDT",
      environment: "vst",
      accountId: "test-vst-account",
      quantity: "0.1",
      stopLoss: "95",
    },
  });
  assert.equal(result.verified, false);
  assert.equal(result.status, "unknown");
  assert.ok(calls.some(([name, symbol]) =>
    name === "history" && symbol === "ETHUSDT"));
  assert.equal(calls.some(([name]) => name === "entry"), false);
  const readsBeforeMalformed = calls.length;
  const malformedSymbol = await broker.reconcileIntent({
    clientOrderId: "worker-eth-malformed-symbol",
    phase: "market-entry",
    request: {
      operation: "entry",
      entryOrderType: "MARKET",
      symbol: "ETH-USD",
      environment: "vst",
      accountId: "test-vst-account",
    },
  });
  const malformedAccount = await broker.reconcileIntent({
    clientOrderId: "worker-eth-malformed-account",
    phase: "market-entry",
    request: {
      operation: "entry",
      entryOrderType: "MARKET",
      symbol: "ETHUSDT",
      environment: "vst",
      accountId: " ",
    },
  });
  assert.equal(malformedSymbol.status, "unknown");
  assert.equal(malformedAccount.status, "unknown");
  assert.equal(calls.length, readsBeforeMalformed);
});

test("ambiguous ETH isolated-margin POST reconciles on a fresh broker without retrying", async () => {
  const { api, broker, calls } = apiFixture({
    canarySymbols: ["BTCUSDT"],
    marginModes: { ETHUSDT: "CROSSED" },
  });
  const request = {
    operation: "prepare_margin_mode",
    symbol: "ETHUSDT",
    environment: "vst",
    accountId: "test-vst-account",
    intentCreatedAt: now,
  };
  const prepare = api.setVstIsolatedMarginForFlatSymbol;
  api.setVstIsolatedMarginForFlatSymbol = async (symbol) => {
    await prepare(symbol);
    throw new Error("ambiguous isolated-margin acknowledgement");
  };
  await assert.rejects(broker.performIntent({
    clientOrderId: "worker-eth-isolated-margin",
    phase: "prepare-isolated-margin",
    request,
  }), /ambiguous isolated-margin acknowledgement/);
  assert.equal(calls.filter(([name, symbol]) =>
    name === "setVstIsolatedMarginForFlatSymbol" && symbol === "ETHUSDT").length, 1);

  const restartedBroker = createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    stopBufferRate: 0.005,
  });
  const evidence = await restartedBroker.reconcileIntent({
    clientOrderId: "worker-eth-isolated-margin",
    phase: "prepare-isolated-margin",
    request,
  });
  assert.equal(evidence.verified, true);
  assert.equal(evidence.status, "filled");
  assert.equal(evidence.marginMode, "ISOLATED");
  assert.equal(calls.filter(([name]) =>
    name === "setVstIsolatedMarginForFlatSymbol").length, 1);
  assert.equal(calls.some(([name]) => name === "setVstLongLeverage10"), false);
});

test("a different symbol's open order no longer blocks ETH isolated-margin preparation, but ETH's own order still does", async () => {
  // Many symbols now carry their own independent position/orders
  // concurrently by design -- a foreign symbol's order is never evidence
  // THIS symbol is unsafe to prepare.
  const foreign = apiFixture({
    canarySymbols: ["BTCUSDT"],
    marginModes: { ETHUSDT: "CROSSED" },
    orders: [{ symbol: "BTC-USDT", orderId: "foreign-open-order" }],
  });
  await foreign.broker.performIntent({
    clientOrderId: "worker-eth-margin-foreign-order",
    phase: "prepare-isolated-margin",
    request: {
      operation: "prepare_margin_mode",
      symbol: "ETHUSDT",
      environment: "vst",
      accountId: "test-vst-account",
      intentCreatedAt: now,
    },
  });
  assert.ok(foreign.calls.some(([name, symbol]) =>
    name === "setVstIsolatedMarginForFlatSymbol" && symbol === "ETHUSDT"));

  // The SAME symbol already having an open order is still unsafe.
  const own = apiFixture({
    canarySymbols: ["BTCUSDT"],
    marginModes: { ETHUSDT: "CROSSED" },
    orders: [{ symbol: "ETH-USDT", orderId: "eth-open-order" }],
  });
  await assert.rejects(own.broker.performIntent({
    clientOrderId: "worker-eth-margin-own-order",
    phase: "prepare-isolated-margin",
    request: {
      operation: "prepare_margin_mode",
      symbol: "ETHUSDT",
      environment: "vst",
      accountId: "test-vst-account",
      intentCreatedAt: now,
    },
  }), /bingx_vst_symbol_preparation_requires_flat_symbol_and_no_open_orders/);
  assert.equal(own.calls.some(([name]) =>
    name === "setVstIsolatedMarginForFlatSymbol"), false);
});

test("a different symbol's open order no longer blocks an ETH entry, but ETH's own order still does", async () => {
  const entryRequest = (overrides) => ({
    operation: "entry",
    entryOrderType: "MARKET",
    symbol: "ETHUSDT",
    environment: "vst",
    accountId: "test-vst-account",
    side: "Buy",
    marginMode: "ISOLATED",
    leverage: 10,
    quantity: "0.1",
    maxEntryPrice: "100",
    stopLoss: "95",
    ...overrides,
  });

  // Many symbols now carry their own independent position/orders
  // concurrently by design -- a foreign symbol's open order is never
  // evidence THIS symbol is unsafe to enter.
  const foreign = apiFixture({
    canarySymbols: ["BTCUSDT"],
    orders: [{ symbol: "BTC-USDT", orderId: "anchor-open-order" }],
  });
  await foreign.broker.performIntent({
    clientOrderId: "worker-eth-foreign-order",
    phase: "market-entry",
    request: entryRequest(),
  });
  assert.ok(foreign.calls.some(([name]) => name === "entry"));

  // The SAME symbol already having an open order is still unsafe.
  const own = apiFixture({
    canarySymbols: ["BTCUSDT"],
    orders: [{ symbol: "ETH-USDT", orderId: "eth-open-order" }],
  });
  await assert.rejects(own.broker.performIntent({
    clientOrderId: "worker-eth-own-order",
    phase: "market-entry",
    request: entryRequest(),
  }), /bingx_vst_entry_requires_symbol_flat_and_no_open_orders/);
  assert.equal(own.calls.some(([name]) => name === "entry"), false);
});

test("account state returns globally read positions and orders with validated identifiers", async () => {
  const { broker, calls } = apiFixture({
    positions: [{
      symbol: "ETH-USDT",
      positionSide: "LONG",
      positionAmt: "0.1",
      positionId: "account-eth-position",
    }],
    orders: [{ symbol: "DOGE-USDT", orderId: "account-doge-order" }],
  });
  const state = await broker.readAccountState();
  assert.equal(state.verified, true);
  assert.equal(state.environment, "vst");
  assert.equal(state.accountId, "test-vst-account");
  assert.deepEqual(state.positions.map(({ symbol }) => symbol), ["ETH-USDT"]);
  assert.deepEqual(state.openOrders.map(({ orderId }) => orderId), ["account-doge-order"]);
  assert.ok(calls.some(([name, symbol]) => name === "positions" && symbol === undefined));
  assert.ok(calls.some(([name, symbol]) => name === "openOrders" && symbol === undefined));
  assert.equal(calls.some(([name, symbol]) =>
    name === "openOrders" && symbol === "BTCUSDT"), false);
});

test("non-canonical symbols fail before exchange reads", async () => {
  const { broker, calls } = apiFixture();
  await assert.rejects(
    broker.readPlanningInputs({ symbol: "DOGEUSD" }),
    /canonical USDT perpetual symbol/,
  );
  assert.equal(calls.length, 0);
});

test("planning rejects unsupported settings; fresh account gate still exposes occupied symbols before writes", async () => {
  const unsupported = apiFixture({
    marginType: "PORTFOLIO", canarySymbols: ["DOGEUSDT"],
  });
  await assert.rejects(
    unsupported.broker.readPlanningInputs({ symbol: "DOGEUSDT" }),
    /bingx_vst_symbol_not_ready_flat_hedge_isolated/,
  );
  const scenarios = [
    { positions: [{
      symbol: "DOGE-USDT", positionSide: "LONG", positionAmt: "1", positionId: "p1",
    }] },
    { orders: [{ symbol: "DOGE-USDT", orderId: "o1" }] },
  ];
  for (const options of scenarios) {
    const { broker, calls } = apiFixture({
      ...options,
      canarySymbols: ["DOGEUSDT"],
    });
    await broker.readPlanningInputs({ symbol: "DOGEUSDT" });
    assert.equal(calls.filter(([name]) =>
      name === "positions" || name === "openOrders").length, 0,
    "planning must not duplicate the final fresh account read");
    const state = await broker.readAccountState();
    assert.equal(state.verified, true);
    assert.ok(state.positions.some((row) => row.symbol === "DOGE-USDT") ||
      state.openOrders.some((row) => row.symbol === "DOGE-USDT"));
    assert.equal(calls.some(([name]) => name === "setVstLongLeverage10" || name === "entry"), false);
  }
});

test("a POST acknowledgement and matching order history without actual fills remain unknown", async () => {
  const workerId = "vst-worker-id";
  const id = `vst-${createHash("sha256").update(workerId).digest("hex").slice(0, 28)}`;
  const row = {
    symbol: "BTC-USDT",
    orderId: "lossless-9876543210123456789",
    clientOrderId: id,
    status: "FILLED",
    executedQty: "1",
  };
  const { broker, calls } = apiFixture({
    queriedOrder: row,
    history: [row],
    fills: [],
  });
  const evidence = await broker.reconcileIntent({
    clientOrderId: workerId,
    phase: "market-entry",
    request: {
      operation: "entry",
      entryOrderType: "MARKET",
      symbol: "BTCUSDT",
      environment: "vst",
      accountId: "test-vst-account",
      signal: { signalAt: new Date(now).toISOString() },
    },
  });
  assert.deepEqual(evidence, { verified: false, status: "unknown" });
  assert.equal(calls.some(([name]) => name === "queryOrder"), false);
});

test("recorded VST order-history, volume fill, position, and detached-parent stop shapes verify an entry", async () => {
  const workerId = "recorded-vst-entry";
  const exchangeClientId =
    `vst-${createHash("sha256").update(workerId).digest("hex").slice(0, 28)}`;
  const exchangeOrderId = "90071992547409931234";
  const position = {
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: "0.1",
    avgPrice: "100",
    positionId: "position-vst-1",
  };
  const stop = {
    symbol: "BTC-USDT",
    orderId: "stop-vst-1",
    mainOrderId: "",
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionId: "position-vst-1",
    origQty: "0.1",
    stopPrice: "95",
  };
  const historyRow = {
    symbol: "BTC-USDT",
    orderId: exchangeOrderId,
    clientOrderId: exchangeClientId,
    side: "BUY",
    type: "MARKET",
    status: "FILLED",
  };
  const fill = {
    symbol: "BTC-USDT",
    orderId: exchangeOrderId,
    clientOrderID: "",
    side: "BUY",
    positionSide: "LONG",
    volume: "0.1",
    price: "100",
    time: now,
    currency: "USDT",
  };
  const { broker, calls } = apiFixture({
    positions: [position],
    orders: [stop],
    history: [historyRow],
    fills: [fill],
  });
  const evidence = await broker.reconcileIntent({
    clientOrderId: workerId,
    phase: "market-entry",
    request: {
      operation: "entry",
      entryOrderType: "MARKET",
      symbol: "BTCUSDT",
      environment: "vst",
      accountId: "test-vst-account",
      side: "Buy",
      quantity: "0.1",
      stopLoss: "95",
      signal: { signalAt: new Date(now).toISOString() },
    },
  });
  assert.equal(evidence.verified, true);
  assert.equal(evidence.status, "filled");
  assert.equal(evidence.exchangeOrderId, exchangeOrderId);
  assert.equal(evidence.fill.quantity, 0.1);
  assert.equal(evidence.protectiveStops.core.orderId, "stop-vst-1");
  assert.equal(calls.some(([name]) => name === "queryOrder"), false);
  assert.equal(calls.some(([name]) => name === "discoverStop"), false);
  const fillQuery = calls.find(([name]) => name === "fills");
  assert.equal(fillQuery[2].orderId, exchangeOrderId);
});

test("legacy VST entry reconciliation still accepts an unmarked LIMIT FOK order", async () => {
  const workerId = "legacy-vst-entry";
  const exchangeClientId =
    `vst-${createHash("sha256").update(workerId).digest("hex").slice(0, 28)}`;
  const exchangeOrderId = "legacy-entry-order-1";
  const stop = {
    symbol: "BTC-USDT",
    orderId: "legacy-stop-1",
    mainOrderId: "",
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionId: "legacy-position-1",
    origQty: "0.1",
    stopPrice: "95",
  };
  const { broker } = apiFixture({
    positions: [{
      symbol: "BTC-USDT",
      positionSide: "LONG",
      positionAmt: "0.1",
      avgPrice: "100",
      positionId: "legacy-position-1",
    }],
    orders: [stop],
    history: [{
      symbol: "BTC-USDT",
      orderId: exchangeOrderId,
      clientOrderId: exchangeClientId,
      side: "BUY",
      type: "LIMIT",
      timeInForce: "FOK",
      status: "FILLED",
      executedQty: "0.1",
    }],
    fills: [{
      symbol: "BTC-USDT",
      orderId: exchangeOrderId,
      side: "BUY",
      positionSide: "LONG",
      volume: "0.1",
      price: "100",
      time: now,
      currency: "USDT",
    }],
  });
  const evidence = await broker.reconcileIntent({
    clientOrderId: workerId,
    phase: "market-entry",
    request: {
      operation: "entry",
      symbol: "BTCUSDT",
      environment: "vst",
      accountId: "test-vst-account",
      side: "Buy",
      quantity: "0.1",
      stopLoss: "95",
      signal: { signalAt: new Date(now).toISOString() },
    },
  });
  assert.equal(evidence.verified, true);
  assert.equal(evidence.status, "filled");
  assert.equal(evidence.exchangeOrderId, exchangeOrderId);
  assert.equal(evidence.fill.quantity, 0.1);
  assert.equal(evidence.protectiveStops.core.orderId, stop.orderId);
});

test("VST entry reconciliation accepts one tick of BingX fill/position price rounding, not two", async () => {
  const workerId = "rounded-vst-entry";
  const exchangeClientId =
    `vst-${createHash("sha256").update(workerId).digest("hex").slice(0, 28)}`;
  const exchangeOrderId = "2105164669871194113";
  const position = {
    symbol: "GRT-USDT", positionSide: "LONG", positionAmt: "339778",
    avgPrice: "0.02869", positionId: "2105164670017994753",
  };
  const stop = {
    symbol: "GRT-USDT", orderId: "2105164670888927232", type: "STOP_MARKET",
    status: "NEW", side: "SELL", positionSide: "LONG",
    positionId: position.positionId, origQty: "339778", stopPrice: "0.02591",
  };
  const order = {
    symbol: "GRT-USDT", orderId: exchangeOrderId, clientOrderId: exchangeClientId,
    side: "BUY", type: "MARKET", status: "FILLED", executedQty: "339778",
  };
  const fill = {
    symbol: "GRT-USDT", orderId: exchangeOrderId, side: "BUY",
    positionSide: "LONG", volume: "339778", price: "0.02870",
    time: now, currency: "USDT",
  };
  const input = {
    clientOrderId: workerId, phase: "market-entry",
    request: {
      operation: "entry", entryOrderType: "MARKET",
      symbol: "GRTUSDT", environment: "vst",
      accountId: "test-vst-account", quantity: "339778", stopLoss: "0.02591",
      signal: { signalAt: new Date(now).toISOString() },
    },
  };
  const fixture = apiFixture({
    positions: [position], orders: [stop], history: [order], fills: [fill],
    pricePrecision: 5,
  });
  const evidence = await fixture.broker.reconcileIntent(input);
  assert.equal(evidence.verified, true);
  assert.equal(evidence.status, "filled");
  assert.equal(evidence.protectiveStops.core.orderId, stop.orderId);
  assert.equal(fixture.calls.some(([name]) => name === "queryOrder"), false);

  const mismatched = apiFixture({
    positions: [{ ...position, avgPrice: "0.02867" }],
    orders: [stop], history: [order], fills: [fill],
    pricePrecision: 5,
  });
  assert.deepEqual(await mismatched.broker.reconcileIntent(input),
    { verified: false, status: "unknown" });
  const wrongStop = apiFixture({
    positions: [position],
    orders: [{ ...stop, stopPrice: "0.02590" }],
    history: [order], fills: [fill],
    pricePrecision: 5,
  });
  assert.deepEqual(await wrongStop.broker.reconcileIntent(input),
    { verified: false, status: "unknown" });
});

test("close intents call the VST adapter only for a full identified position", async () => {
  const position = {
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: "0.1",
    avgPrice: "100",
    positionId: "position-1",
  };
  const { broker, calls } = apiFixture({ positions: [position] });
  await broker.performIntent({
    clientOrderId: "vst-worker-close-id",
    phase: "close_core",
    request: {
      operation: "close_leg",
      symbol: "BTCUSDT",
      environment: "vst",
      accountId: "test-vst-account",
      intentCreatedAt: now,
      quantity: "0.1",
      previousQuantity: "0.1",
    },
  });
  const close = calls.find(([name]) => name === "close");
  assert.ok(close);
  assert.equal(close[1], "BTCUSDT");
  assert.equal(close[2], "0.1");
  assert.equal(close[4], "position-1");
  assert.equal(close[5].automatedLongPolicy, "vst-automated-long-1pct");
});

test("stop upgrades resolve entry identity from history and fills by lossless order ID", async () => {
  const workerEntryId = "vst-original-entry";
  const exchangeClientId =
    `vst-${createHash("sha256").update(workerEntryId).digest("hex").slice(0, 28)}`;
  const exchangeOrderId = "entry-order-90071992547409931";
  const position = {
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: "0.1",
    avgPrice: "100",
    positionId: "position-1",
  };
  const stop = {
    symbol: "BTC-USDT",
    orderId: "stop-1",
    mainOrderId: "",
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionId: "position-1",
    origQty: "0.1",
    stopPrice: "95",
  };
  const { broker, calls } = apiFixture({
    positions: [position],
    orders: [stop],
    history: [{
      symbol: "BTC-USDT",
      orderId: exchangeOrderId,
      clientOrderId: exchangeClientId,
      side: "BUY",
      type: "MARKET",
      status: "FILLED",
      executedQty: "0.1",
      positionId: "position-1",
    }],
    fills: [{
      symbol: "BTC-USDT",
      orderId: exchangeOrderId,
      clientOrderID: "",
      side: "BUY",
      positionSide: "LONG",
      volume: "0.1",
      price: "100",
      time: now,
    }],
  });
  await broker.performIntent({
    clientOrderId: "worker-stop-upgrade",
    phase: "raise_stop-core-1700000000000-0",
    request: {
      operation: "raise_stop",
      entryOrderType: "MARKET",
      symbol: "BTCUSDT",
      environment: "vst",
      accountId: "test-vst-account",
      intentCreatedAt: now,
      entryOrderId: exchangeOrderId,
      entryQuantity: "0.1",
      positionId: "position-1",
      entryAt: new Date(now).toISOString(),
      leg: "core",
      quantity: "0.1",
      previousQuantity: "0.1",
      stopPrice: "96",
      entryProof: {
        entryClientOrderId: workerEntryId,
        entryOrderId: exchangeOrderId,
        positionId: "position-1",
        entryOrderType: "MARKET",
        intentCreatedAt: now,
        quantity: "0.1",
      },
      nextPosition: {
        entryClientOrderId: workerEntryId,
        entryOrderId: exchangeOrderId,
        entryAt: new Date(now).toISOString(),
        signalAt: new Date(now).toISOString(),
      },
    },
  });
  const upgrade = calls.find(([name]) => name === "upgradeStop");
  assert.ok(upgrade);
  assert.equal(upgrade[1].entryOrderId, exchangeOrderId);
  assert.ok(calls.some(([name, , query]) =>
    name === "queryOrder" && query.clientOrderId === exchangeClientId));
  assert.ok(calls.some(([name, , range]) =>
    name === "fills" && range.orderId === exchangeOrderId));
});

test("entry proof recovers a missing position entryOrderId only from exact durable entry history", async () => {
  const clientOrderId = "legacy-entry-client-210527";
  const exchangeClientId =
    `vst-${createHash("sha256").update(clientOrderId).digest("hex").slice(0, 28)}`;
  const entryOrderId = "2105271515101528065";
  const positionId = "2105271515231551489";
  const intentCreatedAt = 1790770797709;
  const { broker, calls } = apiFixture({
    clock: () => intentCreatedAt,
    history: [{
      symbol: "BTC-USDT",
      orderId: entryOrderId,
      clientOrderId: exchangeClientId,
      status: "FILLED",
      side: "BUY",
      type: "MARKET",
      executedQty: "18850.91",
      positionId,
    }],
    fills: [{
      symbol: "BTC-USDT",
      orderId: entryOrderId,
      side: "BUY",
      positionSide: "LONG",
      volume: "18850.91",
      price: "0.52",
      time: intentCreatedAt,
    }],
  });
  const entryRequest = {
    operation: "entry",
    environment: "vst",
    accountId: "test-vst-account",
    symbol: "BTCUSDT",
    entryOrderType: "MARKET",
    quantity: "18850.91",
    intentCreatedAt,
  };
  const proof = await broker.verifyEntryOrderProof({
    clientOrderId,
    request: entryRequest,
    expectedPositionId: positionId,
    expectedOrderId: entryOrderId,
    expectedQuantity: "18850.91",
  });
  assert.deepEqual(proof, {
    verified: true,
    status: "filled",
    exchangeOrderId: entryOrderId,
    positionId,
    fill: {
      quantity: 18850.91,
      price: 0.52,
      at: new Date(intentCreatedAt).toISOString(),
    },
  });
  assert.ok(calls.some(([name, , query]) =>
    name === "queryOrder" && query.clientOrderId === exchangeClientId));
  assert.ok(calls.some(([name, , range]) =>
    name === "fills" && range.orderId === entryOrderId));
  assert.equal(Object.hasOwn(entryRequest, "entryOrderId"), false);
});

test("source-exit native entry type recovery accepts MARKET and LIMIT/FOK, rejects conflicts", async () => {
  for (const { type, timeInForce, declaredType } of [
    { type: "MARKET" },
    { type: "LIMIT", timeInForce: "FOK" },
    { type: "LIMIT" },
    { type: "LIMIT", timeInForce: "GTC" },
    { type: "LIMIT", timeInForce: "FOK", declaredType: "MARKET" },
    { type: "STOP_MARKET" },
  ]) {
    const clientOrderId = `undeclared-entry-${type.toLowerCase()}`;
    const exchangeClientId = `vst-${createHash("sha256")
      .update(clientOrderId).digest("hex").slice(0, 28)}`;
    const exchangeOrderId = `native-${type.toLowerCase()}-entry`;
    const positionId = `native-${type.toLowerCase()}-position`;
    const entryAt = now - 1_000;
    const { broker, calls, api } = apiFixture({
      orders: [{
        symbol: "BTC-USDT",
        orderId: exchangeOrderId,
        clientOrderId: exchangeClientId,
        status: "FILLED",
        side: "BUY",
        positionSide: "LONG",
        type,
        ...(timeInForce ? { timeInForce } : {}),
        executedQty: "0.2",
        origQty: "0.2",
        positionId,
      }],
      fills: [{
        symbol: "BTC-USDT",
        orderId: exchangeOrderId,
        tradeId: `${exchangeOrderId}-fill-1`,
        side: "BUY",
        positionSide: "LONG",
        volume: "0.1",
        price: "100",
        time: now - 1_000,
        currency: "USDT",
      }, {
        symbol: "BTC-USDT",
        orderId: exchangeOrderId,
        tradeId: `${exchangeOrderId}-fill-2`,
        side: "BUY",
        positionSide: "LONG",
        volume: "0.1",
        price: "100",
        time: now,
        currency: "USDT",
      }],
    });
    const proof = await broker.verifySourceExitEntryProof({
      clientOrderId,
      request: {
        operation: "entry",
        environment: "vst",
        accountId: "test-vst-account",
        symbol: "BTCUSDT",
        intentCreatedAt: now - 2_000,
        ...(declaredType ? { entryOrderType: declaredType } : {}),
      },
      expectedPositionId: positionId,
      expectedOrderId: exchangeOrderId,
      expectedQuantity: "0.2",
      expectedEntryAt: new Date(entryAt).toISOString(),
      ...(declaredType ? { entryOrderType: declaredType } : {}),
    });

    if (type === "STOP_MARKET" ||
        type === "LIMIT" && timeInForce !== undefined &&
          timeInForce !== null && timeInForce !== "FOK" ||
        declaredType && declaredType !== type) {
      assert.equal(proof.verified, false);
      assert.equal(proof.status, "unknown");
    } else {
      assert.equal(proof.verified, true);
      assert.equal(proof.entryOrderType, type);
      assert.equal(proof.fill.quantity, 0.2);
      assert.equal(proof.fill.price, 100);
      assert.equal(proof.fill.at, new Date(entryAt).toISOString(),
        "saved entry time follows the ordinary earliest-fill convention");
    }
    assert.equal(calls.some(([name]) =>
      name === "placeEntry" || name === "closeLong" ||
      name === "upgradeStop" || name === "cancelOrder"), false,
    "type recovery and unsupported-type rejection are read-only");
    if (type !== "STOP_MARKET" &&
        !(type === "LIMIT" && timeInForce !== undefined &&
          timeInForce !== null && timeInForce !== "FOK") &&
        !(declaredType && declaredType !== type)) {
      const orderLookup = calls.find(([name, , identifier]) =>
        name === "queryOrder" && identifier?.orderId === exchangeOrderId);
      assert.ok(orderLookup);
      assert.equal(orderLookup[2].clientOrderId, undefined);
      const fillLookup = calls.find(([name]) => name === "fills");
      assert.equal(fillLookup[2].startTs, now - 2_000);
      assert.equal(fillLookup[2].endTs, now);
      assert.ok(fillLookup[2].endTs - fillLookup[2].startTs < 10_000);
    }
  }
});

test("old GRT source proof uses the exact known parent and bounded original fill window", async () => {
  const now = Date.parse("2026-10-02T00:00:00.000Z");
  const clientOrderId = "legacy-entry-client-grt-210516";
  const exchangeClientId = `vst-${createHash("sha256")
    .update(clientOrderId).digest("hex").slice(0, 28)}`;
  const entryOrderId = "2105164669871194113";
  const positionId = "2105164670017994753";
  const intentCreatedAt = 1790745323282;
  const entryAt = Date.parse("2026-09-30T05:15:44.000Z");
  const order = {
    symbol: "GRT-USDT",
    orderId: entryOrderId,
    clientOrderId: exchangeClientId,
    status: "FILLED",
    side: "BUY",
    positionSide: "LONG",
    type: "LIMIT",
    positionID: positionId,
    origQty: "339778",
    executedQty: "339778",
    avgPrice: "0.0287",
  };
  const fills = [{
    symbol: "GRT-USDT",
    orderId: entryOrderId,
    tradeId: "grt-entry-fill-exact-parent",
    side: "BUY",
    positionSide: "LONG",
    positionID: positionId,
    volume: "339778",
    price: "0.0287",
    time: entryAt,
    currency: "USDT",
  }];
  const { api, broker, calls } = apiFixture({ clock: () => now });
  api.queryOrder = async (symbol, identifier) => {
    calls.push(["queryOrder", symbol, identifier]);
    return identifier?.orderId === entryOrderId ? order : null;
  };
  api.queryFills = async (symbol, range) => {
    calls.push(["fills", symbol, range]);
    return fills.filter((fill) =>
      fill.symbol === symbol.replace(/USDT$/, "-USDT") &&
      fill.orderId === range.orderId &&
      fill.time >= range.startTs && fill.time <= range.endTs);
  };

  const proof = await broker.verifySourceExitEntryProof({
    clientOrderId,
    request: {
      operation: "entry",
      environment: "vst",
      accountId: "test-vst-account",
      symbol: "GRTUSDT",
      intentCreatedAt,
    },
    expectedPositionId: positionId,
    expectedOrderId: entryOrderId,
    expectedQuantity: "339778",
    expectedEntryAt: "2026-09-30T05:15:44.000Z",
  });

  assert.equal(now - entryAt > 23 * 60 * 60_000, true);
  assert.deepEqual(proof, {
    verified: true,
    status: "filled",
    exchangeOrderId: entryOrderId,
    positionId,
    entryOrderType: "LIMIT",
    fill: {
      quantity: 339778,
      price: 0.0287,
      at: "2026-09-30T05:15:44.000Z",
    },
  });
  const parentRead = calls.find(([name]) => name === "queryOrder");
  assert.deepEqual(parentRead[2], { orderId: entryOrderId });
  assert.equal(calls.some(([, , identifier]) =>
    identifier?.clientOrderId !== undefined), false,
  "source proof never asks raw or normalized client IDs to discover a parent");
  const fillsRead = calls.find(([name]) => name === "fills");
  assert.equal(fillsRead[2].startTs, intentCreatedAt);
  assert.equal(fillsRead[2].endTs, entryAt + 30_000);
  assert.equal(fillsRead[2].endTs - fillsRead[2].startTs, 50_718);
  assert.ok(now - fillsRead[2].endTs > 23 * 60 * 60_000,
    "the exact original fill window remains old and narrow");
});

test("source exact-parent DTO accepts known client-ID aliases and rejects invalid IDs", async () => {
  const clientOrderId = "source-parent-client-id";
  const exchangeClientId = `vst-${createHash("sha256")
    .update(clientOrderId).digest("hex").slice(0, 28)}`;
  const exchangeOrderId = "source-parent-exact-order";
  const positionId = "source-parent-position";
  const at = now - 1_000;
  const baseOrder = {
    symbol: "BTC-USDT",
    orderId: exchangeOrderId,
    status: "FILLED",
    side: "BUY",
    positionSide: "LONG",
    type: "MARKET",
    positionID: positionId,
    origQty: "0.1",
    executedQty: "0.1",
  };
  const fill = {
    symbol: "BTC-USDT",
    orderId: exchangeOrderId,
    tradeId: "source-parent-fill",
    side: "BUY",
    positionSide: "LONG",
    positionID: positionId,
    qty: "0.1",
    price: "100",
    filledTm: at,
  };
  const cases = [
    { label: "absent client ID", fields: {}, verified: true },
    { label: "normalized durable alias", fields: { clientOrderId: exchangeClientId }, verified: true },
    { label: "raw durable alias", fields: { clientOrderID: clientOrderId }, verified: true },
    { label: "numeric zero ID", fields: { clientOrderId: 0 }, verified: false },
    { label: "string zero ID", fields: { clientOrderID: "0" }, verified: false },
    { label: "blank ID", fields: { clientOrderId: "" }, verified: false },
    { label: "unmatched genuine ID", fields: { clientOrderId: "provider-owned-id" }, verified: false },
    {
      label: "conflicting alias beside known ID",
      fields: {
        clientOrderId: exchangeClientId,
        clientOrderID: "provider-owned-id",
      },
      verified: false,
    },
  ];

  for (const scenario of cases) {
    const { api, broker, calls } = apiFixture();
    api.queryOrder = async (symbol, identifier) => {
      calls.push(["queryOrder", symbol, identifier]);
      return identifier?.orderId === exchangeOrderId
        ? { ...baseOrder, ...scenario.fields }
        : null;
    };
    api.queryFills = async (symbol, range) => {
      calls.push(["fills", symbol, range]);
      return range.orderId === exchangeOrderId ? [fill] : [];
    };
    const proof = await broker.verifySourceExitEntryProof({
      clientOrderId,
      request: {
        operation: "entry",
        symbol: "BTCUSDT",
        intentCreatedAt: at - 1_000,
      },
      expectedPositionId: positionId,
      expectedOrderId: exchangeOrderId,
      expectedQuantity: "0.1",
      expectedEntryAt: new Date(at).toISOString(),
    });

    assert.equal(proof.verified, scenario.verified, scenario.label);
    assert.equal(calls.filter(([name]) => name === "queryOrder").length, 1);
    assert.deepEqual(calls.find(([name]) => name === "queryOrder")[2], {
      orderId: exchangeOrderId,
    });
  }
});

test("44-hour-delayed entry proof skips unsupported history and uses exact parent in narrow fill window", async () => {
  const clientOrderId = "legacy-delayed-entry-client";
  const exchangeClientId = `vst-${createHash("sha256")
    .update(clientOrderId).digest("hex").slice(0, 28)}`;
  const exchangeOrderId = "delayed-entry-exact-parent";
  const positionId = "delayed-entry-position";
  const entryAt = now - 44 * 60 * 60_000;
  const intentAt = entryAt - 1_000;
  const order = {
    symbol: "BTC-USDT",
    orderId: exchangeOrderId,
    status: "FILLED",
    side: "BUY",
    positionSide: "LONG",
    type: "MARKET",
    positionId,
    origQty: "0.1",
    executedQty: "0.1",
  };
  const fill = {
    symbol: "BTC-USDT",
    orderId: exchangeOrderId,
    tradeId: "delayed-entry-fill",
    side: "BUY",
    positionSide: "LONG",
    quantity: "0.1",
    price: "100",
    time: entryAt,
  };
  const { api, broker, calls } = apiFixture({ clock: () => now });
  api.queryOrderHistory = async (symbol, range) => {
    calls.push(["history", symbol, range]);
    throw new Error("old order-history range is unavailable");
  };
  api.queryOrder = async (symbol, identifier) => {
    calls.push(["queryOrder", symbol, identifier]);
    if (identifier?.clientOrderId === exchangeClientId) return null;
    return identifier?.orderId === exchangeOrderId ? order : null;
  };
  api.queryFills = async (symbol, range) => {
    calls.push(["fills", symbol, range]);
    return range.orderId === exchangeOrderId &&
      fill.time >= range.startTs && fill.time <= range.endTs ? [fill] : [];
  };

  const proof = await broker.verifyEntryOrderProof({
    clientOrderId,
    request: {
      operation: "entry",
      symbol: "BTCUSDT",
      intentCreatedAt: new Date(intentAt).toISOString(),
      entryClientOrderId: clientOrderId,
      entryAt: new Date(entryAt).toISOString(),
      entryQuantity: "0.1",
      entryOrderType: "MARKET",
      marginTopUp: { entryOrderId: exchangeOrderId },
      nextPosition: {
        entryClientOrderId: clientOrderId,
        entryAt: new Date(entryAt).toISOString(),
        entryQuantity: "0.1",
        entryOrderType: "MARKET",
      },
    },
    expectedPositionId: positionId,
    expectedOrderId: exchangeOrderId,
    expectedQuantity: "0.1",
  });

  assert.equal(proof.verified, true);
  assert.equal(proof.exchangeOrderId, exchangeOrderId);
  const orderReads = calls.filter(([name]) => name === "queryOrder");
  assert.deepEqual(orderReads.map(([, , identifier]) => identifier), [
    { orderId: exchangeOrderId },
  ]);
  assert.equal(calls.some(([name]) => name === "history"), false);
  const fillRead = calls.find(([name]) => name === "fills");
  assert.equal(fillRead[2].startTs, intentAt - 30_000);
  assert.equal(fillRead[2].endTs, entryAt + 30_000);
  assert.ok(fillRead[2].endTs - fillRead[2].startTs < 90_000);
  assert.ok(now - entryAt > 23 * 60 * 60_000);
  assert.ok(now - entryAt < 7 * 24 * 60 * 60_000);
  assert.ok(now - fillRead[2].startTs <= 7 * 24 * 60 * 60_000,
    "the 30-second query margin remains inside the seven-day evidence retention");
  assert.ok(now - fillRead[2].endTs > 43 * 60 * 60_000,
    "the original fill read remains anchored to entry despite delayed management");
});

test("exact-parent entry fallback refuses foreign IDs and inconsistent aliases", async () => {
  const clientOrderId = "legacy-entry-fallback-identity";
  const exchangeClientId = `vst-${createHash("sha256")
    .update(clientOrderId).digest("hex").slice(0, 28)}`;
  const expectedOrderId = "expected-entry-parent";
  const positionId = "expected-entry-position";
  const entryAt = now - 60_000;
  const baseOrder = {
    symbol: "BTC-USDT",
    orderId: expectedOrderId,
    status: "FILLED",
    side: "BUY",
    positionSide: "LONG",
    type: "MARKET",
    positionId,
    origQty: "0.1",
    executedQty: "0.1",
  };
  for (const scenario of [
    {
      name: "foreign order id",
      order: { ...baseOrder, orderId: "foreign-parent" },
    },
    {
      name: "inconsistent order aliases",
      order: { ...baseOrder, orderID: "foreign-parent" },
    },
    {
      name: "foreign client id",
      order: { ...baseOrder, clientOrderId: "foreign-client-id" },
    },
    {
      name: "inconsistent client aliases",
      order: {
        ...baseOrder,
        clientOrderId: exchangeClientId,
        clientOrderID: "foreign-client-id",
      },
    },
  ]) {
    const { api, broker } = apiFixture({ clock: () => now });
    api.queryOrderHistory = async () => [];
    api.queryOrder = async (_symbol, identifier) =>
      identifier?.orderId === expectedOrderId ? scenario.order : null;
    api.queryFills = async () => [{
      symbol: "BTC-USDT",
      orderId: expectedOrderId,
      tradeId: "entry-identity-fill",
      side: "BUY",
      positionSide: "LONG",
      quantity: "0.1",
      price: "100",
      time: entryAt,
    }];
    const proof = await broker.verifyEntryOrderProof({
      clientOrderId,
      request: {
        operation: "entry",
        symbol: "BTCUSDT",
        intentCreatedAt: new Date(entryAt - 1_000).toISOString(),
        entryClientOrderId: clientOrderId,
        entryAt: new Date(entryAt).toISOString(),
        entryQuantity: "0.1",
        entryOrderType: "MARKET",
      },
      expectedPositionId: positionId,
      expectedOrderId,
      expectedQuantity: "0.1",
    });
    assert.equal(proof.verified, false, scenario.name);
  }
});

test("legacy management may use only the persisted top-up exact entry parent when client lookup misses", async () => {
  const clientOrderId = "legacy-top-up-parent-client";
  const exchangeClientId = `vst-${createHash("sha256")
    .update(clientOrderId).digest("hex").slice(0, 28)}`;
  const entryOrderId = "legacy-top-up-entry-parent";
  const positionId = "legacy-top-up-position";
  const entryAt = now - 8 * 60 * 60_000;
  const stop = {
    symbol: "BTC-USDT",
    orderId: "legacy-top-up-old-stop",
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionId,
    origQty: "0.1",
    stopPrice: "95",
  };
  const order = {
    symbol: "BTC-USDT",
    orderId: entryOrderId,
    status: "FILLED",
    side: "BUY",
    positionSide: "LONG",
    type: "MARKET",
    positionId,
    origQty: "0.1",
    executedQty: "0.1",
  };
  const { api, broker, calls } = apiFixture({
    clock: () => now,
    positions: [{
      symbol: "BTC-USDT",
      positionSide: "LONG",
      positionAmt: "0.1",
      avgPrice: "100",
      positionId,
    }],
    orders: [stop],
  });
  api.queryOrderHistory = async (_symbol, range) => {
    calls.push(["history", _symbol, range]);
    return [];
  };
  api.queryOrder = async (_symbol, identifier) => {
    calls.push(["queryOrder", _symbol, identifier]);
    if (identifier?.clientOrderId === exchangeClientId) return null;
    return identifier?.orderId === entryOrderId ? order : null;
  };
  api.queryFills = async (_symbol, range) => {
    calls.push(["fills", _symbol, range]);
    return range.orderId === entryOrderId ? [{
      symbol: "BTC-USDT",
      orderId: entryOrderId,
      tradeId: "legacy-top-up-entry-fill",
      side: "BUY",
      positionSide: "LONG",
      quantity: "0.1",
      price: "100",
      time: entryAt,
    }] : [];
  };

  await broker.performIntent({
    clientOrderId: "legacy-top-up-raise-stop-intent",
    phase: "raise_stop-core-management",
    request: {
      operation: "raise_stop",
      symbol: "BTCUSDT",
      environment: "vst",
      accountId: "test-vst-account",
      intentCreatedAt: now,
      positionId,
      entryClientOrderId: clientOrderId,
      entryAt: new Date(entryAt).toISOString(),
      entryQuantity: "0.1",
      entryOrderType: "MARKET",
      marginTopUp: { entryOrderId },
      leg: "core",
      quantity: "0.1",
      previousQuantity: "0.1",
      stopPrice: "96",
    },
  });

  const upgrade = calls.find(([name]) => name === "upgradeStop");
  assert.ok(upgrade);
  assert.equal(upgrade[1].entryOrderId, entryOrderId);
  assert.deepEqual(calls.filter(([name]) => name === "queryOrder")
    .map(([, , identifier]) => identifier), [
    { clientOrderId: exchangeClientId },
    { orderId: entryOrderId },
  ]);
  const fillRead = calls.find(([name]) => name === "fills");
  assert.equal(fillRead[2].startTs, entryAt - 30_000);
  assert.equal(fillRead[2].endTs, entryAt + 30_000);
});

test("stop upgrades query fills from durable entryAt, not the new management intent", async () => {
  const workerEntryId = "worker-entry-from-yesterday";
  const exchangeClientId =
    `vst-${createHash("sha256").update(workerEntryId).digest("hex").slice(0, 28)}`;
  const exchangeOrderId = "entry-order-yesterday";
  const entryAt = now - 8 * 60 * 60_000;
  const stop = {
    symbol: "BTC-USDT", orderId: "stop-yesterday", type: "STOP_MARKET",
    status: "NEW", side: "SELL", positionSide: "LONG",
    workingType: "MARK_PRICE", positionId: "position-yesterday",
    origQty: "0.1", stopPrice: "95",
  };
  const { broker, calls } = apiFixture({
    positions: [{
      symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
      avgPrice: "100", positionId: "position-yesterday",
    }],
    orders: [stop],
    history: [{
      symbol: "BTC-USDT", orderId: exchangeOrderId,
      clientOrderId: exchangeClientId, status: "FILLED", side: "BUY",
      type: "MARKET", executedQty: "0.1",
      positionId: "position-proof-fail-closed",
      positionId: "position-yesterday",
    }],
    fills: [{
      symbol: "BTC-USDT", orderId: exchangeOrderId, side: "BUY",
      positionSide: "LONG", volume: "0.1", price: "100", time: entryAt,
    }],
    filterFillsByTime: true,
  });
  await broker.performIntent({
    clientOrderId: "worker-raise-stop-today",
    phase: "raise_stop-core-today",
    request: {
      operation: "raise_stop", entryOrderType: "MARKET",
      symbol: "BTCUSDT", environment: "vst", accountId: "test-vst-account",
      // This is today's raise_stop timestamp; it must not be reused for the
      // original entry order/fill history lookup.
      intentCreatedAt: now, entryOrderId: exchangeOrderId,
      entryClientOrderId: workerEntryId, entryAt,
      entryQuantity: "0.1", positionId: "position-yesterday",
      leg: "core", quantity: "0.1", previousQuantity: "0.1",
      stopPrice: "96",
      entryProof: {
        entryClientOrderId: workerEntryId,
        entryOrderId: exchangeOrderId,
        positionId: "position-yesterday",
        entryOrderType: "MARKET",
        intentCreatedAt: entryAt,
        quantity: "0.1",
      },
      nextPosition: {
        entryClientOrderId: workerEntryId, entryOrderId: exchangeOrderId,
        entryAt, entryOrderType: "MARKET",
      },
    },
  });
  const fillRead = calls.find(([name]) => name === "fills");
  assert.ok(fillRead);
  assert.equal(fillRead[2].startTs, entryAt - 30_000);
  assert.equal(fillRead[2].endTs, entryAt + 30_000);
  assert.ok(calls.some(([name]) => name === "upgradeStop"));
});

test("stop upgrades fail closed on malformed/stale entry times and incomplete or mismatched fills", async () => {
  const workerEntryId = "worker-entry-proof-fail-closed";
  const exchangeClientId =
    `vst-${createHash("sha256").update(workerEntryId).digest("hex").slice(0, 28)}`;
  const exchangeOrderId = "entry-order-proof-fail-closed";
  const makeRequest = (entryAt) => ({
    operation: "raise_stop", entryOrderType: "MARKET",
    symbol: "BTCUSDT", environment: "vst", accountId: "test-vst-account",
    intentCreatedAt: now, entryOrderId: exchangeOrderId,
    entryClientOrderId: workerEntryId, entryAt,
    entryQuantity: "0.1", positionId: "position-proof-fail-closed",
    leg: "core", quantity: "0.1", previousQuantity: "0.1", stopPrice: "96",
    nextPosition: {
      entryClientOrderId: workerEntryId, entryOrderId: exchangeOrderId,
      entryAt, entryOrderType: "MARKET",
    },
    entryProof: {
      entryClientOrderId: workerEntryId,
      entryOrderId: exchangeOrderId,
      positionId: "position-proof-fail-closed",
      entryOrderType: "MARKET",
      intentCreatedAt: entryAt,
      quantity: "0.1",
    },
  });
  const stop = {
    symbol: "BTC-USDT", orderId: "stop-proof-fail-closed",
    type: "STOP_MARKET", status: "NEW", side: "SELL",
    positionSide: "LONG", workingType: "MARK_PRICE",
    positionId: "position-proof-fail-closed", origQty: "0.1", stopPrice: "95",
  };
  const base = {
    positions: [{
      symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
      avgPrice: "100", positionId: "position-proof-fail-closed",
    }],
    orders: [stop],
    history: [{
      symbol: "BTC-USDT", orderId: exchangeOrderId,
      clientOrderId: exchangeClientId, status: "FILLED", side: "BUY",
      type: "MARKET", executedQty: "0.1",
      positionId: "position-proof-fail-closed",
    }],
  };
  const entryAt = now - 60_000;
  const cases = [
    {
      label: "malformed entryAt",
      entryAt: "not-a-date",
      fills: [{ symbol: "BTC-USDT", orderId: exchangeOrderId }],
      expected: /bingx_vst_entry_intent_time_unverified/,
    },
    {
      label: "missing original protective stop",
      entryAt,
      fills: [{
        symbol: "BTC-USDT", orderId: exchangeOrderId, side: "BUY",
        positionSide: "LONG", volume: "0.1", price: "100", time: entryAt,
      }],
      noStop: true,
      expected: /bingx_vst_existing_core_stop_unverified/,
    },
    {
      label: "conflicting entry client identity",
      entryAt,
      fills: [{
        symbol: "BTC-USDT", orderId: exchangeOrderId, side: "BUY",
        positionSide: "LONG", volume: "0.1", price: "100", time: entryAt,
      }],
      mutateRequest: (request) => {
        request.nextPosition.entryClientOrderId = "different-entry-client";
      },
      expected: /bingx_vst_entry_identity_metadata_unverified/,
    },
    {
      label: "outside seven-day evidence retention",
      entryAt: now - 7 * 24 * 60 * 60_000 - 1_000,
      fills: [{ symbol: "BTC-USDT", orderId: exchangeOrderId }],
      expected: /bingx_vst_entry_intent_time_unverified/,
    },
    {
      label: "future entryAt",
      entryAt: now + 1_000,
      fills: [{ symbol: "BTC-USDT", orderId: exchangeOrderId }],
      expected: /bingx_vst_entry_intent_time_unverified/,
    },
    {
      label: "partial fills",
      entryAt,
      fills: [{
        symbol: "BTC-USDT", orderId: exchangeOrderId, side: "BUY",
        positionSide: "LONG", volume: "0.05", price: "100", time: entryAt,
      }],
      expected: /bingx_vst_entry_history_fills_unverified/,
    },
    {
      label: "wrong-order fills",
      entryAt,
      fills: [{
        symbol: "BTC-USDT", orderId: "other-order", side: "BUY",
        positionSide: "LONG", volume: "0.1", price: "100", time: entryAt,
      }],
      expected: /bingx_vst_entry_history_fills_unverified/,
    },
    {
      label: "malformed fill time",
      entryAt,
      fills: [{
        symbol: "BTC-USDT", orderId: exchangeOrderId, side: "BUY",
        positionSide: "LONG", volume: "0.1", price: "100", time: "malformed",
      }],
      expected: /bingx_vst_entry_fills_unverified/,
    },
  ];
  for (const scenario of cases) {
    const { broker, calls } = apiFixture({
      ...base,
      ...(scenario.noStop ? { orders: [] } : {}),
      fills: scenario.fills,
    });
    const request = makeRequest(scenario.entryAt);
    scenario.mutateRequest?.(request);
    let refusal;
    await assert.rejects(broker.performIntent({
      clientOrderId: `worker-stop-refusal-${scenario.label}`,
      phase: "raise_stop-core-refusal",
      request,
    }), (error) => {
      refusal = error;
      return scenario.expected.test(error.message);
    }, scenario.label);
    if (scenario.label === "partial fills") {
      assert.equal(refusal.preSignReason,
        "bingx_vst_raise_stop_entry_fill_proof_refused_before_upgrade");
    }
    assert.equal(calls.some(([name]) => name === "upgradeStop"), false, scenario.label);
  }
});

test("an adapter error with the verifier's literal message is not tagged as a pre-sign refusal", async () => {
  const entryClientOrderId = "adapter-error-entry";
  const exchangeClientOrderId =
    `vst-${createHash("sha256").update(entryClientOrderId).digest("hex").slice(0, 28)}`;
  const entryOrderId = "adapter-error-entry-order";
  const positionId = "adapter-error-position";
  const oldStop = {
    symbol: "BTC-USDT", orderId: "adapter-error-stop", type: "STOP_MARKET",
    status: "NEW", side: "SELL", positionSide: "LONG", workingType: "MARK_PRICE",
    positionId, origQty: "0.1", stopPrice: "95",
  };
  const { broker, api } = apiFixture({
    positions: [{
      symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
      avgPrice: "100", positionId,
    }],
    orders: [oldStop],
    history: [{
      symbol: "BTC-USDT", orderId: entryOrderId,
      clientOrderId: exchangeClientOrderId, side: "BUY",
      type: "MARKET", status: "FILLED", executedQty: "0.1", positionId,
    }],
    fills: [{
      symbol: "BTC-USDT", orderId: entryOrderId, side: "BUY",
      positionSide: "LONG", volume: "0.1", price: "100", time: now,
    }],
  });
  api.upgradeVstLongStop = async () => {
    throw new Error("bingx_vst_entry_history_fills_unverified");
  };
  await assert.rejects(broker.performIntent({
    clientOrderId: "adapter-error-target",
    phase: "raise_stop-core-adapter",
    request: {
      operation: "raise_stop", environment: "vst", accountId: "test-vst-account",
      symbol: "BTCUSDT", positionId, entryClientOrderId,
      entryOrderId, entryAt: new Date(now).toISOString(),
      leg: "core", quantity: "0.1", previousQuantity: "0.1", stopPrice: "96",
      intentCreatedAt: now,
      persistedPosition: {
        verified: true,
        environment: "vst",
        accountId: "test-vst-account",
        symbol: "BTCUSDT",
        positionId,
        quantity: "0.1",
        entryClientOrderId,
        entryOrderId,
        entryOrderType: "MARKET",
        protectiveStops: {
          core: {
            verified: true,
            tranche: "core",
            orderId: oldStop.orderId,
            positionId,
            quantity: "0.1",
            stopPrice: "95",
          },
        },
      },
      entryProof: {
        entryClientOrderId, entryOrderId, positionId,
        entryOrderType: "MARKET", intentCreatedAt: now, quantity: "0.1",
      },
    },
  }), (error) => {
    assert.equal(error.message, "bingx_vst_entry_history_fills_unverified");
    assert.equal(error.preSignReason, undefined);
    return true;
  });
});

test("stop upgrades fail closed without history-to-ID fills and verified position stop", async () => {
  const { broker, calls } = apiFixture({
    positions: [{
      symbol: "BTC-USDT",
      positionSide: "LONG",
      positionAmt: "0.1",
      avgPrice: "100",
      positionId: "position-1",
    }],
    orders: [{
      symbol: "BTC-USDT",
      orderId: "stop-1",
      type: "STOP_MARKET",
      status: "NEW",
      side: "SELL",
      positionSide: "LONG",
      positionId: "position-1",
      origQty: "0.1",
      stopPrice: "95",
    }],
  });
  await assert.rejects(broker.performIntent({
    clientOrderId: "worker-stop-upgrade",
    phase: "raise_stop-core-1700000000000-0",
    request: {
      operation: "raise_stop",
      entryOrderType: "MARKET",
      symbol: "BTCUSDT",
      environment: "vst",
      accountId: "test-vst-account",
      intentCreatedAt: now,
      entryClientOrderId: "missing-entry-history",
      entryAt: new Date(now).toISOString(),
      leg: "core",
      quantity: "0.1",
      previousQuantity: "0.1",
      stopPrice: "96",
      entryProof: {
        entryClientOrderId: "missing-entry-history",
        entryOrderId: "missing-entry-order",
        positionId: "position-1",
        entryOrderType: "MARKET",
        intentCreatedAt: now,
        quantity: "0.1",
      },
      nextPosition: {
        entryClientOrderId: "missing-entry-history",
        entryAt: new Date(now).toISOString(),
        signalAt: new Date(now).toISOString(),
      },
    },
  }), /bingx_vst_entry_history_unverified/);
  assert.equal(calls.some(([name]) => name === "upgradeStop"), false);
});

test("core stop upgrade reconciliation is read-only and requires the active verified stop", async () => {
  const entryClientOrderId = "worker-stop-entry";
  const exchangeEntryClientOrderId =
    `vst-${createHash("sha256").update(entryClientOrderId).digest("hex").slice(0, 28)}`;
  const position = {
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: "0.1",
    avgPrice: "100",
    positionId: "position-1",
  };
  const stop = {
    symbol: "BTC-USDT",
    orderId: "raised-stop-1",
    clientOrderId: "",
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionId: "position-1",
    origQty: "0.1",
    stopPrice: "95",
    workingType: "MARK_PRICE",
    executedQty: "0",
  };
  const canceledOldStop = {
    ...stop,
    orderId: "stop-1",
    status: "CANCELED",
    stopPrice: "94",
    executedQty: "0",
  };
  const { broker, calls } = apiFixture({
    positions: [position],
    orders: [stop],
    queriedOrders: { "stop-1": canceledOldStop },
    history: [{
      symbol: "BTC-USDT",
      orderId: "entry-order-1",
      clientOrderId: exchangeEntryClientOrderId,
      status: "FILLED",
      side: "BUY",
      type: "MARKET",
      executedQty: "0.1",
      positionId: "position-1",
    }],
    fills: [{
      symbol: "BTC-USDT",
      orderId: "entry-order-1",
      side: "BUY",
      positionSide: "LONG",
      volume: "0.1",
      price: "100",
      filledTm: now,
    }],
  });
  const reconcileRequest = {
    operation: "raise_stop",
    symbol: "BTCUSDT",
    environment: "vst",
    accountId: "test-vst-account",
    intentCreatedAt: now,
    entryOrderId: "entry-order-1",
    entryQuantity: "0.1",
    positionId: "position-1",
    entryClientOrderId,
    entryAt: new Date(now).toISOString(),
    entryProof: {
      entryClientOrderId,
      entryOrderId: "entry-order-1",
      positionId: "position-1",
      entryOrderType: "MARKET",
      intentCreatedAt: now,
      quantity: "0.1",
    },
    leg: "core",
    quantity: "0.1",
    stopPrice: "95",
    previousQuantity: "0.1",
    persistedPosition: {
      verified: true,
      entryOrderType: "MARKET",
      entryClientOrderId,
      entryOrderId: "entry-order-1",
      entryAt: new Date(now).toISOString(),
      environment: "vst",
      accountId: "test-vst-account",
      symbol: "BTCUSDT",
      positionId: "position-1",
      quantity: "0.1",
      protectiveStops: {
        core: {
          verified: true,
          tranche: "core",
          positionId: "position-1",
           orderId: "stop-1",
          quantity: "0.1",
          stopPrice: "94",
        },
      },
    },
  };
  const withoutSubmissionId = await broker.reconcileIntent({
    clientOrderId: "worker-stop-upgrade",
    phase: "raise_stop-core-1700000000000-0",
    request: reconcileRequest,
  });
  assert.deepEqual(withoutSubmissionId, { verified: false, status: "unknown" },
    "matching stop price/quantity without immutable POST identity is not adoption proof");
  assert.equal(calls.length, 0);

  const result = await broker.reconcileIntent({
    clientOrderId: "worker-stop-upgrade",
    phase: "raise_stop-core-1700000000000-0",
    exchangeOrderId: "raised-stop-1",
    request: reconcileRequest,
  });
  assert.equal(result.verified, true);
  assert.equal(result.status, "filled");
  assert.equal(result.protectiveStops.core.orderId, "raised-stop-1");
  assert.equal(calls.some(([name]) => name === "upgradeStop"), false);
  assert.ok(calls.some(([name, , identifier]) => name === "queryOrder" &&
    identifier?.orderId === "raised-stop-1"),
  "reconciliation fetches the immutable native parent by exact order ID despite blank client ID");
  assert.ok(calls.some(([name, , identifier]) => name === "queryOrder" &&
    identifier?.orderId === "stop-1"),
  "reconciliation separately proves the exact old core stop was canceled and unfilled");
  const foreignParent = await broker.reconcileIntent({
    clientOrderId: "worker-stop-upgrade",
    phase: "raise_stop-core-1700000000000-0",
    exchangeOrderId: "different-native-stop",
    request: reconcileRequest,
  });
  assert.deepEqual(foreignParent, { verified: false, status: "unknown" },
    "a matching live price/quantity cannot substitute for the persisted exact parent ID");
});

test("sole core stop raise verifies original entry fills separately from residual quantity", async () => {
  const rawEntryClientOrderId = "worker-sole-core-entry";
  const exchangeClientOrderId =
    `vst-${createHash("sha256").update(rawEntryClientOrderId).digest("hex").slice(0, 28)}`;
  const position = {
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: "0.08",
    avgPrice: "100",
    positionId: "position-after-runner",
  };
  const coreStop = {
    symbol: "BTC-USDT",
    orderId: "sole-core-stop",
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionId: position.positionId,
    origQty: "0.08",
    stopPrice: "96",
    workingType: "MARK_PRICE",
    executedQty: "0",
  };
  const liveOrders = [coreStop];
  const { broker, api, calls } = apiFixture({
    positions: [position],
    orders: liveOrders,
    history: [{
      symbol: "BTC-USDT",
      orderId: "original-entry-order",
      clientOrderId: exchangeClientOrderId,
      status: "FILLED",
      side: "BUY",
      type: "MARKET",
      executedQty: "0.1",
      positionId: "position-after-runner",
    }],
    fills: [{
      symbol: "BTC-USDT",
      orderId: "original-entry-order",
      side: "BUY",
      positionSide: "LONG",
      volume: "0.1",
      price: "100",
      filledTm: now,
    }],
  });
  const originalQueryOrder = api.queryOrder.bind(api);
  api.queryOrder = async (symbol, identifier) => {
    if (identifier?.orderId === coreStop.orderId) {
      calls.push(["queryOrder", symbol, identifier]);
      return { ...coreStop, status: "CANCELED", executedQty: "0" };
    }
    return originalQueryOrder(symbol, identifier);
  };
  api.upgradeVstLongStop = async (request) => {
    calls.push(["upgradeStop", request]);
    liveOrders.splice(0, liveOrders.length, {
      ...coreStop,
      orderId: "raised-core-stop",
      clientOrderId: "",
      stopPrice: "97",
      executedQty: "0",
    });
    await request.onSubmission?.({ exchangeOrderId: "raised-core-stop" });
    return { verified: true, exchangeOrderId: "raised-core-stop" };
  };
  const priorPosition = {
    verified: true,
    environment: "vst",
    accountId: "test-vst-account",
    symbol: "BTCUSDT",
    positionId: position.positionId,
    quantity: "0.08",
    protectiveStops: {
      core: {
        verified: true,
        tranche: "core",
        positionId: position.positionId,
        orderId: coreStop.orderId,
        quantity: "0.08",
        stopPrice: "96",
      },
    },
  };
  let submittedStopId;
  const submission = await broker.performIntent({
    clientOrderId: "worker-raise-sole-core",
    phase: "raise_stop-core",
    onSubmission: ({ exchangeOrderId }) => { submittedStopId = exchangeOrderId; },
    request: {
      operation: "raise_stop",
      entryOrderType: "MARKET",
      environment: "vst",
      accountId: "test-vst-account",
      intentCreatedAt: now,
      symbol: "BTCUSDT",
      positionId: position.positionId,
      entryAt: new Date(now).toISOString(),
      leg: "core",
      quantity: "0.08",
      previousQuantity: "0.08",
      stopPrice: "96",
      entryOrderId: "original-entry-order",
      entryQuantity: "0.1",
      entryClientOrderId: rawEntryClientOrderId,
      entryAt: new Date(now).toISOString(),
      priorPosition,
      entryProof: {
        entryClientOrderId: rawEntryClientOrderId,
        entryOrderId: "original-entry-order",
        positionId: position.positionId,
        entryOrderType: "MARKET",
        intentCreatedAt: now,
        quantity: "0.1",
      },
    },
  });
  assert.equal(submittedStopId, "raised-core-stop");
  assert.deepEqual(submission, { exchangeOrderId: "raised-core-stop" });
  const upgraded = calls.find(([name]) => name === "upgradeStop");
  assert.ok(upgraded);
  assert.equal(upgraded[1].entryOrderId, "original-entry-order");
  assert.equal(upgraded[1].quantity, "0.08");
  const evidence = await createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    stopBufferRate: 0.005,
  }).reconcileIntent({
    clientOrderId: "worker-raise-sole-core",
    phase: "raise_stop-core",
    exchangeOrderId: submittedStopId,
    request: {
      operation: "raise_stop",
      entryOrderType: "MARKET",
      environment: "vst",
      accountId: "test-vst-account",
      intentCreatedAt: now,
      symbol: "BTCUSDT",
      positionId: position.positionId,
      entryAt: new Date(now).toISOString(),
      leg: "core",
      quantity: "0.08",
      previousQuantity: "0.08",
      stopPrice: "96",
      entryOrderId: "original-entry-order",
      entryQuantity: "0.1",
      entryClientOrderId: rawEntryClientOrderId,
      entryAt: new Date(now).toISOString(),
      priorPosition,
      entryProof: {
        entryClientOrderId: rawEntryClientOrderId,
        entryOrderId: "original-entry-order",
        positionId: position.positionId,
        entryOrderType: "MARKET",
        intentCreatedAt: now,
        quantity: "0.1",
      },
    },
  });
  assert.equal(evidence.verified, true);
  assert.equal(evidence.position.quantity, 0.08);
  assert.equal(evidence.exchangeOrderId, submittedStopId);
  assert.equal(evidence.position.protectiveStops.core.orderId, submittedStopId);
  assert.ok(calls.some(([name, , identifier]) => name === "queryOrder" &&
    identifier?.orderId === coreStop.orderId),
  "recovery independently reads the old core stop's canceled/unfilled state");
});

test("full close reconciles actual VST fill fields and deduplicates repeated fill records", async () => {
  const order = {
    symbol: "BTC-USDT",
    orderId: "close-order-90071992547409931",
    clientOrderId: `vst-${createHash("sha256").update("worker-full-close").digest("hex").slice(0, 28)}`,
    status: "FILLED",
    side: "SELL",
    type: "MARKET",
    executedQty: "0.1",
  };
  const fill = {
    symbol: "BTC-USDT",
    orderId: order.orderId,
    filledTm: now,
    volume: "0.05",
    amount: "0.05",
    commission: "-2.000000",
    currency: "VST",
    filledTime: now,
    clientOrderID: "",
    side: "SELL",
    positionSide: "LONG",
    price: "100",
  };
  const secondFill = {
    ...fill,
    filledTm: now + 10,
    filledTime: now + 10,
    volume: "0.05",
    amount: "0.05",
    commission: "-2.894978",
  };
  const { broker } = apiFixture({
    queriedOrder: order,
    history: [order],
    fills: [fill, secondFill, { ...secondFill }],
  });
  const result = await broker.reconcileIntent({
    clientOrderId: "worker-full-close",
    phase: "close_core",
    request: {
      operation: "close_leg",
      symbol: "BTCUSDT",
      environment: "vst",
      accountId: "test-vst-account",
      intentCreatedAt: now,
      quantity: "0.1",
      previousQuantity: "0.1",
    },
  });
  assert.equal(result.verified, true);
  assert.equal(result.status, "filled");
  assert.equal(result.position.quantity, 0);
  assert.equal(result.fill.price, 100);
  assert.equal(result.fill.quantity, 0.1);
  assert.equal(result.fill.at, new Date(now).toISOString());
  assert.deepEqual(result.fill.fees, [{ currency: "VST", amount: "-4.894978" }]);
});

test("close evidence stays unknown when commission or its currency is missing or invalid", async () => {
  const workerId = "worker-close-fee-proof";
  const order = {
    symbol: "BTC-USDT",
    orderId: "close-order-without-fee",
    clientOrderId: `vst-${createHash("sha256").update(workerId).digest("hex").slice(0, 28)}`,
    status: "FILLED",
    side: "SELL",
    type: "MARKET",
    executedQty: "0.1",
  };
  const baseFill = {
    symbol: "BTC-USDT",
    orderId: order.orderId,
    filledTm: now,
    volume: "0.1",
    price: "100",
    side: "SELL",
    positionSide: "LONG",
  };
  for (const fill of [
    baseFill,
    { ...baseFill, commission: "not-a-number", currency: "VST" },
    { ...baseFill, commission: "-0.1", currency: "" },
  ]) {
    const { broker } = apiFixture({ history: [order], fills: [fill] });
    const evidence = await broker.reconcileIntent({
      clientOrderId: workerId,
      phase: "close_core",
      request: {
        operation: "close_leg",
        symbol: "BTCUSDT",
        environment: "vst",
        accountId: "test-vst-account",
        quantity: "0.1",
        previousQuantity: "0.1",
      },
    });
    assert.deepEqual(evidence, { verified: false, status: "unknown" });
  }
});

test("triggered VST stops reconcile a child fill with exact residual protection or flat state", async () => {
  const scenarios = [
    {
      stopQuantity: "0.04",
      previousQuantity: "0.1",
      residualQuantity: "0.06",
      positions: [{
        symbol: "BTC-USDT",
        positionSide: "LONG",
        positionAmt: "0.06",
        positionId: "position-triggered-stop",
      }],
      orders: [{
        symbol: "BTC-USDT",
        orderId: "surviving-stop-1",
        type: "STOP_MARKET",
        status: "NEW",
        side: "SELL",
        positionSide: "LONG",
        positionId: "position-triggered-stop",
        origQty: "0.06",
        stopPrice: "95",
      }],
    },
    {
      stopQuantity: "0.1",
      previousQuantity: "0.1",
      residualQuantity: "0",
      positions: [],
      orders: [],
    },
  ];
  for (const scenario of scenarios) {
    const childOrderId = "child-fill-90071992547409931234";
    const { broker, calls } = apiFixture({
      positions: scenario.positions,
      orders: scenario.orders,
      queriedOrder: {
        symbol: "BTC-USDT",
        orderId: childOrderId,
        type: "STOP_MARKET",
        status: "FILLED",
        side: "SELL",
        positionSide: "LONG",
        origQty: scenario.stopQuantity,
        executedQty: scenario.stopQuantity,
      },
      fills: [{
        symbol: "BTC-USDT",
        orderId: childOrderId,
        triggerOrderId: "parent-stop-1",
        side: "SELL",
        positionSide: "LONG",
        volume: scenario.stopQuantity,
        price: "94.7",
        commission: "-0.012",
        currency: "VST",
        filledTm: now,
      }],
    });
    const evidence = await broker.observeTriggeredStop({
      symbol: "BTCUSDT",
      positionId: "position-triggered-stop",
      stopOrderId: "parent-stop-1",
      stopQuantity: scenario.stopQuantity,
      stopPrice: "95",
      previousQuantity: scenario.previousQuantity,
      startedAt: now - 1_000,
    });
    assert.equal(evidence.verified, true);
    assert.equal(evidence.status, "filled");
    assert.equal(evidence.parentStopId, "parent-stop-1");
    assert.equal(evidence.childOrderId, childOrderId);
    assert.deepEqual(evidence.fill, {
      orderId: childOrderId,
      triggerOrderId: "parent-stop-1",
      quantity: scenario.stopQuantity,
      price: "94.7",
      fee: { asset: "VST", amount: "-0.012" },
      at: new Date(now).toISOString(),
    });
    assert.equal(evidence.residualPosition.quantity, scenario.residualQuantity);
    assert.equal(evidence.residualPosition.positionId, "position-triggered-stop");
    assert.deepEqual(evidence.openStops.map(({ orderId, quantity }) => ({
      orderId, quantity,
    })), scenario.orders.map(({ orderId, origQty }) => ({
      orderId, quantity: origQty,
    })));
    assert.equal(calls.some(([name]) =>
      ["entry", "upgradeStop", "close", "setVstLongLeverage10"].includes(name)), false);
    assert.deepEqual(calls.find(([name]) => name === "queryOrder"), [
      "queryOrder", "BTCUSDT", { orderId: "parent-stop-1" },
    ]);
  }
});

test("triggered VST stop observation fails closed on mismatched, duplicate, or unsafe evidence", async () => {
  const childOrderId = "child-fill-1";
  const baseOrder = {
    symbol: "BTC-USDT",
    orderId: childOrderId,
    type: "STOP_MARKET",
    status: "FILLED",
    side: "SELL",
    positionSide: "LONG",
    origQty: "0.04",
    executedQty: "0.04",
  };
  const baseFill = {
    symbol: "BTC-USDT",
    orderId: childOrderId,
    triggerOrderId: "parent-stop-1",
    side: "SELL",
    positionSide: "LONG",
    volume: "0.04",
    price: "94.7",
    commission: "-0.012",
    currency: "VST",
    filledTm: now,
  };
  const residualPosition = {
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: "0.06",
    positionId: "position-triggered-stop",
  };
  const residualStop = {
    symbol: "BTC-USDT",
    orderId: "surviving-stop-1",
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionId: "position-triggered-stop",
    origQty: "0.06",
    stopPrice: "95",
  };
  const mismatches = [
    { fills: [{ ...baseFill, triggerOrderId: "different-parent" }] },
    { fills: [baseFill, { ...baseFill }] },
    { fills: [{ ...baseFill, volume: "0.039" }] },
    { fills: [{ ...baseFill, commission: undefined }] },
    { fills: [{ ...baseFill, filledTm: now + 10_000 }] },
    { fills: [{ ...baseFill, triggerOrderId: 90071992547409931234 }] },
    { queriedOrder: { ...baseOrder, orderId: "different-child" } },
    { positions: [{ ...residualPosition, positionAmt: "0.061" }] },
    { orders: [{ ...residualStop, origQty: "0.059" }] },
    { orders: [] },
    { fills: [{ ...baseFill, orderID: "conflicting-child" }] },
  ];
  for (const mismatch of mismatches) {
    const { broker } = apiFixture({
      queriedOrder: baseOrder,
      fills: [baseFill],
      positions: [residualPosition],
      orders: [residualStop],
      ...mismatch,
    });
    const evidence = await broker.observeTriggeredStop({
      symbol: "BTCUSDT",
      positionId: "position-triggered-stop",
      stopOrderId: "parent-stop-1",
      stopQuantity: "0.04",
      stopPrice: "95",
      previousQuantity: "0.1",
      startedAt: now - 1_000,
    });
    assert.deepEqual(evidence, { verified: false, status: "unknown" });
  }
});

test("partial-leg close intents are rejected before any adapter mutation", async () => {
  const position = {
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: "0.1",
    avgPrice: "100",
    positionId: "position-1",
  };
  const { broker, calls } = apiFixture({ positions: [position] });
  await assert.rejects(
    broker.performIntent({
      clientOrderId: "vst-worker-partial-close",
      phase: "close_core",
      request: {
        operation: "close_leg",
        symbol: "BTCUSDT",
        environment: "vst",
        accountId: "test-vst-account",
        intentCreatedAt: now,
        quantity: "0.08",
        previousQuantity: "0.1",
      },
    }),
    /exact_whole_position_close/,
  );
  assert.equal(calls.some(([name]) => name === "close"), false);
});

test("impulse planning is allowed with complete adapters and guarded flat-account preparation", async () => {
  const { broker, calls } = apiFixture({ longLeverage: 75 });
  const planning = await broker.readPlanningInputs({
    symbol: "BTCUSDT",
    patternId: "impulse_buy",
  });
  assert.equal(planning.filters.symbol, "BTC-USDT");
  assert.equal(planning.balanceSnapshot[0].asset, "VST");
  assert.equal(calls.some(([name]) =>
    name === "setVstLongLeverage10" || name === "entry" || name === "upgradeStop" ||
    name === "close"), false);
});

test("impulse planning fails closed before reads when a required adapter is absent", async () => {
  const { broker, calls } = apiFixture({
    omitAdapterMethods: ["cancelVstAutomatedSplitStopAfterPartial"],
  });
  await assert.rejects(
    broker.readPlanningInputs({ symbol: "BTCUSDT", patternId: "impulse_buy" }),
    /bingx_vst_impulse_adapters_unavailable:.*cancelVstAutomatedSplitStopAfterPartial/,
  );
  assert.equal(calls.length, 0);
});

test("impulse split broker wires core-first, runner-at-entry-BE, and original-stop cleanup", async () => {
  const position = {
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: "0.1",
    avgPrice: "100",
    positionId: "position-1",
  };
  const originalStop = {
    symbol: "BTC-USDT",
    orderId: "original-signal-stop",
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionId: "position-1",
    origQty: "0.1",
    stopPrice: "95",
    workingType: "MARK_PRICE",
    mainOrderId: "entry-order-1",
  };
  const { broker, api, calls } = apiFixture({
    positions: [position],
    orders: [originalStop],
    markPrice: "101",
  });
  const newBroker = () => createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    sleep: async () => {},
    stopBufferRate: 0.005,
  });
  const coreRequest = impulseSplitRequest();
  await broker.performIntent({
    clientOrderId: "worker-split-core",
    phase: "split_core_stop",
    request: coreRequest,
  });
  const coreAdapterRequest = calls.find(([name]) => name === "splitStop")[1];
  assert.equal(coreAdapterRequest.tranche, "core");
  assert.equal(coreAdapterRequest.quantity, "0.08");
  assert.equal(coreAdapterRequest.stopPrice, "95");
  assert.equal(coreAdapterRequest.originalStopOrderId, "original-signal-stop");
  assert.equal(coreAdapterRequest.entryOrderId, "entry-order-1");
  assert.equal(coreAdapterRequest.createdAt, now);
  assert.deepEqual(coreAdapterRequest.baselineOpenOrderIds, ["original-signal-stop"]);

  const coreEvidence = await newBroker().reconcileIntent({
    clientOrderId: "worker-split-core",
    phase: "split_core_stop",
    request: coreRequest,
  });
  assert.equal(coreEvidence.verified, true);
  assert.equal(coreEvidence.stop.orderId, "split-core-stop");
  assert.equal(coreEvidence.position.protectiveStops.core.orderId, "split-core-stop");
  // The original protective stop remains active until both replacement stops
  // have independently verified.
  assert.ok((await broker.readPosition("BTCUSDT")).protectiveStops.core);

  const coreStop = {
    tranche: "core",
    orderId: "split-core-stop",
    quantity: "0.08",
    stopPrice: "95",
  };
  const runnerRequest = impulseSplitRequest({
    operation: "split_runner_stop",
    baselineOpenOrderIds: ["original-signal-stop", "split-core-stop"],
    coreStop,
    persistedPosition: coreEvidence.position.persistedSnapshot,
  });
  await newBroker().performIntent({
    clientOrderId: "worker-split-runner",
    phase: "split_runner_stop",
    request: runnerRequest,
  });
  const runnerAdapterRequest = calls.filter(([name]) => name === "splitStop")[1][1];
  assert.equal(runnerAdapterRequest.tranche, "runner");
  assert.equal(runnerAdapterRequest.quantity, "0.02");
  assert.equal(runnerAdapterRequest.stopPrice, "100");
  assert.deepEqual(runnerAdapterRequest.existingReplacementStops, [coreStop]);
  const runnerEvidence = await newBroker().reconcileIntent({
    clientOrderId: "worker-split-runner",
    phase: "split_runner_stop",
    request: runnerRequest,
  });
  assert.equal(runnerEvidence.verified, true);
  assert.equal(runnerEvidence.position.protectiveStops.core.orderId, "split-core-stop");
  assert.equal(runnerEvidence.position.protectiveStops.runner.orderId, "split-runner-stop");

  const cancelRequest = impulseSplitRequest({
    operation: "cancel_original_stop",
    baselineOpenOrderIds: [
      "original-signal-stop", "split-core-stop", "split-runner-stop",
    ],
    coreStop,
    runnerStop: {
      tranche: "runner",
      orderId: "split-runner-stop",
      quantity: "0.02",
      stopPrice: "100",
    },
    persistedPosition: runnerEvidence.position.persistedSnapshot,
  });
  const originalCancelAdapter = api.cancelVstAutomatedAttachedLongStopAfterSplit;
  const refusal = new BingXLiveApiError("BingX final pre-sign check failed", {
    httpStatus: 200,
    code: 109400,
    exchangeMessage: "timestamp is invalid",
    transportStage: "exchange_response",
    endpoint: "/openApi/swap/v2/trade/leverage",
    method: "GET",
  });
  refusal.mutationProvenance = Object.freeze({
    operation: "cancel_original_stop",
    mutationMethod: "DELETE",
    mutationEndpoint: "/openApi/swap/v2/trade/order",
    mutationRequestSent: false,
    phase: "pre_mutation_read",
  });
  api.cancelVstAutomatedAttachedLongStopAfterSplit = async () => {
    throw refusal;
  };
  await assert.rejects(newBroker().performIntent({
    clientOrderId: "worker-cancel-original",
    phase: "cancel_original_stop",
    request: cancelRequest,
  }), (error) => {
    assert.equal(error, refusal);
    assert.deepEqual(error.mutationProvenance, {
      operation: "cancel_original_stop",
      mutationMethod: "DELETE",
      mutationEndpoint: "/openApi/swap/v2/trade/order",
      mutationRequestSent: false,
      phase: "pre_mutation_read",
    });
    assert.equal(error.method, "GET");
    assert.equal(error.code, 109400);
    assert.equal(error.definiteRejection, undefined);
    return true;
  });
  // The broker releases its local reservation only because this response
  // carried exact proof that the request never reached DELETE transport.
  api.cancelVstAutomatedAttachedLongStopAfterSplit = originalCancelAdapter;
  await newBroker().performIntent({
    clientOrderId: "worker-cancel-original",
    phase: "cancel_original_stop",
    request: cancelRequest,
  });
  const cancelEvidence = await newBroker().reconcileIntent({
    clientOrderId: "worker-cancel-original",
    phase: "cancel_original_stop",
    request: cancelRequest,
  });
  assert.equal(cancelEvidence.verified, true);
  assert.equal(cancelEvidence.position.protectiveStops.core.orderId, "split-core-stop");
  assert.equal(cancelEvidence.position.protectiveStops.runner.orderId, "split-runner-stop");
  assert.equal(calls.some(([name]) => name === "cancelOriginalStop"), true);
});

function runnerSplitFillRaceFixture() {
  const originalStop = {
    symbol: "BTC-USDT",
    orderId: "original-signal-stop",
    mainOrderId: "entry-order-1",
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    workingType: "MARK_PRICE",
    positionId: "position-1",
    origQty: "0.08",
    stopPrice: "95",
  };
  const coreStop = { ...originalStop, orderId: "split-core-stop" };
  const child = {
    symbol: "BTC-USDT",
    orderId: "runner-child-fill",
    clientOrderId: "",
    positionId: 0,
    type: "STOP_MARKET",
    status: "FILLED",
    side: "SELL",
    positionSide: "LONG",
    triggerOrderId: "split-runner-parent",
    origQty: "0.02",
    executedQty: "0.02",
    stopPrice: "100",
    time: now,
  };
  const parent = {
    symbol: "BTC-USDT",
    orderId: "split-runner-parent",
    mainOrderId: "entry-order-1",
    type: "STOP_MARKET",
    status: "FILLED",
    side: "SELL",
    positionSide: "LONG",
    workingType: "MARK_PRICE",
    origQty: "0.02",
    executedQty: "0.02",
    stopPrice: "100",
  };
  const { broker, api, calls } = apiFixture({
    positions: [{
      symbol: "BTC-USDT",
      positionSide: "LONG",
      positionAmt: "0.08",
      avgPrice: "100",
      positionId: "position-1",
    }],
    orders: [originalStop, coreStop],
    history: [child],
    queriedOrders: {
      "split-runner-parent": parent,
      "runner-child-fill": child,
    },
    fills: [{
      symbol: "BTC-USDT",
      orderId: child.orderId,
      triggerOrderId: "split-runner-parent",
      side: "SELL",
      positionSide: "LONG",
      volume: "0.02",
      price: "100",
      commission: "-0.012",
      currency: "VST",
      filledTime: new Date(now + 8 * 60 * 60_000).toISOString()
        .replace("Z", "+08:00"),
    }],
  });
  return {
    broker,
    api,
    calls,
    request: impulseSplitRequest({
      operation: "split_runner_stop",
      baselineOpenOrderIds: ["original-signal-stop", "split-core-stop"],
      coreStop: {
        tranche: "core",
        orderId: "split-core-stop",
        quantity: "0.08",
        stopPrice: "95",
      },
    }),
  };
}

test("split runner reconciliation recovers a linked child when history omits its parent", async () => {
  const { broker, request, calls } = runnerSplitFillRaceFixture();
  const triggered = await broker.observeTriggeredStop({
    symbol: "BTCUSDT",
    positionId: "position-1",
    stopOrderId: "split-runner-parent",
    stopQuantity: "0.02",
    stopPrice: "100",
    previousQuantity: "0.1",
    startedAt: now,
    requireStopDetails: true,
    expectedParentEntryOrderId: "entry-order-1",
  });
  assert.equal(triggered.verified, true, JSON.stringify({ triggered, calls }));
  const residualSnapshot = await broker.readPosition("BTCUSDT", {
    persistedPosition: {
      verified: true,
      environment: "vst",
      accountId: "test-vst-account",
      symbol: "BTCUSDT",
      positionId: "position-1",
      quantity: "0.08",
      protectiveStops: {
        core: {
          verified: true,
          orderId: "split-core-stop",
          positionId: "position-1",
          quantity: "0.08",
          stopPrice: "95",
        },
      },
      originalStop: {
        verified: true,
        orderId: "original-signal-stop",
        positionId: "position-1",
        quantity: "0.08",
        stopPrice: "95",
      },
    },
  });
  assert.equal(residualSnapshot.positionId, "position-1");
  const evidence = await broker.reconcileIntent({
    clientOrderId: "worker-split-runner",
    phase: "split_runner_stop",
    request,
  });
  assert.equal(evidence.verified, true, JSON.stringify({ evidence, calls }));
  assert.equal(evidence.runnerFillRecovery, true);
  assert.equal(evidence.parentStopId, "split-runner-parent");
  assert.equal(evidence.childOrderId, "runner-child-fill");
  assert.equal(evidence.fill.triggerOrderId, "split-runner-parent");
  assert.equal(evidence.residualPosition.quantity, "0.08");
  assert.deepEqual(evidence.openStops.map((stop) => stop.orderId).sort(), [
    "original-signal-stop", "split-core-stop",
  ]);
  assert.ok(calls.some(([name, _symbol, identifier]) =>
    name === "queryOrder" && identifier?.orderId === "split-runner-parent"));
});

test("runner recovery excludes an older entry fill with BingX's numeric trigger sentinel", async () => {
  const { broker, api, request, calls } = runnerSplitFillRaceFixture();
  request.createdAt = now - 3 * 60 * 60_000;
  const originalQueryFills = api.queryFills.bind(api);
  api.queryFills = async (symbol, range) => {
    const rows = await originalQueryFills(symbol, range);
    if (range.orderId || range.startTs > request.createdAt - 60_000) return rows;
    return [{
      symbol: "BTC-USDT",
      orderId: "entry-order-1",
      triggerOrderId: 0,
      side: "BUY",
      positionSide: "LONG",
      volume: "0.1",
      price: "100",
      filledTime: new Date(request.createdAt).toISOString(),
    }, ...rows];
  };
  const oldWindow = await broker.observeTriggeredStop({
    symbol: "BTCUSDT",
    positionId: "position-1",
    stopOrderId: "split-runner-parent",
    stopQuantity: "0.02",
    stopPrice: "100",
    previousQuantity: "0.1",
    startedAt: request.createdAt,
    requireStopDetails: true,
    expectedParentEntryOrderId: "entry-order-1",
  });
  assert.equal(oldWindow.verified, false);
  const evidence = await broker.reconcileIntent({
    clientOrderId: "worker-split-runner-old-entry",
    phase: "split_runner_stop",
    request,
  });
  assert.equal(evidence.verified, true, JSON.stringify(evidence));
  assert.equal(evidence.runnerFillRecovery, true);
  assert.ok(calls.some(([name, _symbol, range]) =>
    name === "fills" && !range.orderId && range.startTs >= request.intentCreatedAt - 60_000));
});

test("split runner reconciliation rejects duplicate child fills without mutating exchange state", async () => {
  const { broker, api, request } = runnerSplitFillRaceFixture();
  api.queryFills = async (_symbol, range) => {
    const row = {
      symbol: "BTC-USDT",
      orderId: "runner-child-fill",
      triggerOrderId: "split-runner-parent",
      side: "SELL",
      positionSide: "LONG",
      volume: "0.02",
      price: "100",
      commission: "-0.012",
      currency: "VST",
      filledTm: now,
    };
    return range.orderId ? [row] : [
      row,
      { ...row, tradeId: "duplicate-child-fill" },
    ];
  };
  const evidence = await broker.reconcileIntent({
    clientOrderId: "worker-split-runner",
    phase: "split_runner_stop",
    request,
  });
  assert.equal(evidence.verified, false);
  assert.equal(evidence.status, "unknown");
  assert.equal(evidence.runnerFillRecovery, undefined);
});

test("readPosition rehydrates exact persisted split snapshots on a fresh broker", async () => {
  const position = {
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: "0.1",
    avgPrice: "100",
    positionId: "position-1",
  };
  const coreOrder = {
    symbol: "BTC-USDT",
    orderId: "rehydrated-core",
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionId: "position-1",
    origQty: "0.08",
    stopPrice: "95",
    workingType: "MARK_PRICE",
  };
  const runnerOrder = {
    symbol: "BTC-USDT",
    orderId: "rehydrated-runner",
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionId: "position-1",
    origQty: "0.02",
    stopPrice: "100",
    workingType: "MARK_PRICE",
  };
  const snapshot = {
    verified: true,
    environment: "vst",
    accountId: "test-vst-account",
    symbol: "BTCUSDT",
    positionId: "position-1",
    quantity: "0.1",
    protectiveStops: {
      core: {
        verified: true,
        tranche: "core",
        orderId: coreOrder.orderId,
        positionId: "position-1",
        quantity: "0.08",
        stopPrice: "95",
      },
      runner: {
        verified: true,
        tranche: "runner",
        orderId: runnerOrder.orderId,
        positionId: "position-1",
        quantity: "0.02",
        stopPrice: "100",
      },
    },
  };
  const createBroker = (api) => createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    stopBufferRate: 0.005,
  });
  const { api } = apiFixture({
    positions: [position],
    orders: [coreOrder, runnerOrder],
  });
  const result = await createBroker(api).readPosition("BTCUSDT", {
    persistedPosition: snapshot,
  });
  assert.equal(result.protectiveStops.core.orderId, coreOrder.orderId);
  assert.equal(result.protectiveStops.runner.orderId, runnerOrder.orderId);
  assert.equal(result.persistedSnapshot.quantity, "0.1");
  assert.equal(result.persistedSnapshot.protectiveStops.core.quantity, "0.08");
  const roundTrip = await createBroker(api).readPosition("BTCUSDT", {
    persistedPosition: result.persistedSnapshot,
  });
  assert.equal(roundTrip.protectiveStops.runner.orderId, runnerOrder.orderId);

  const originalOrder = {
    ...coreOrder,
    orderId: "original-during-split",
    origQty: "0.1",
  };
  const pendingSnapshot = {
    ...snapshot,
    protectiveStops: { core: snapshot.protectiveStops.core },
    originalStop: {
      verified: true,
      positionId: "position-1",
      orderId: originalOrder.orderId,
      quantity: "0.1",
      stopPrice: "95",
    },
  };
  const pendingApi = apiFixture({
    positions: [position],
    orders: [originalOrder, coreOrder],
  }).api;
  const pending = await createBroker(pendingApi).readPosition("BTCUSDT", {
    persistedPosition: pendingSnapshot,
  });
  assert.equal(pending.protectiveStops.core.orderId, coreOrder.orderId);
  assert.equal(pending.originalStop.orderId, originalOrder.orderId);
  assert.equal(pending.persistedSnapshot.originalStop.orderId, originalOrder.orderId);

  const residualPosition = { ...position, positionAmt: "0.02" };
  const resizedRunner = { ...runnerOrder, origQty: "0.02" };
  const residualSnapshot = {
    ...snapshot,
    quantity: "0.02",
    protectiveStops: { runner: snapshot.protectiveStops.runner },
  };
  const residualApi = apiFixture({
    positions: [residualPosition],
    orders: [resizedRunner],
  }).api;
  const residual = await createBroker(residualApi).readPosition("BTCUSDT", {
    persistedPosition: residualSnapshot,
  });
  assert.equal(residual.quantity, 0.02);
  assert.equal(residual.protectiveStops.core, undefined);
  assert.equal(residual.protectiveStops.runner.orderId, runnerOrder.orderId);
  assert.equal(residual.persistedSnapshot.protectiveStops.runner.quantity, "0.02");

  const foreignApi = apiFixture({
    positions: [position],
    orders: [coreOrder, runnerOrder, { ...runnerOrder, orderId: "foreign-stop" }],
  }).api;
  await assert.rejects(createBroker(foreignApi).readPosition("BTCUSDT", {
    persistedPosition: snapshot,
  }), /persisted_position_open_order_set_mismatch/);
  const mismatchedApi = apiFixture({
    positions: [position],
    orders: [coreOrder, { ...runnerOrder, stopPrice: "99" }],
  }).api;
  await assert.rejects(createBroker(mismatchedApi).readPosition("BTCUSDT", {
    persistedPosition: snapshot,
  }), /persisted_stop_raw_order_mismatch/);
});

test("readPosition consumes a fresh broker-issued raw account context once", async () => {
  const facts = splitReadContextFacts();
  const { broker, calls } = apiFixture({
    positions: [facts.position],
    orders: [facts.coreOrder, facts.runnerOrder],
  });
  const accountState = await broker.readAccountState();
  calls.length = 0;

  const result = await broker.readPosition("BTCUSDT", {
    accountStateContext: accountState,
    persistedPosition: facts.persistedPosition,
    allowProcessCache: false,
  });

  assert.equal(result.verified, true);
  assert.equal(result.protectiveStops.core.orderId, facts.coreOrder.orderId);
  assert.equal(result.protectiveStops.runner.orderId, facts.runnerOrder.orderId);
  assert.equal(calls.filter(([kind, symbol]) =>
    kind === "positions" && symbol === "BTCUSDT").length, 0);
  assert.equal(calls.filter(([kind, symbol]) =>
    kind === "openOrders" && symbol === "BTCUSDT").length, 0);
  assert.ok(calls.some(([kind]) => kind === "mark"),
    "the VST mark/environment read remains fresh");
  assert.ok(calls.some(([kind]) => kind === "contract"),
    "contract filters remain fresh");
  assert.ok(calls.some(([kind]) => kind === "getPositionMode"));
  assert.ok(calls.some(([kind]) => kind === "getMarginType"));
  assert.ok(calls.some(([kind]) => kind === "getLeverage"));

  await broker.readPosition("BTCUSDT", {
    accountStateContext: accountState,
    persistedPosition: facts.persistedPosition,
    allowProcessCache: false,
  });
  assert.equal(calls.filter(([kind, symbol]) =>
    kind === "positions" && symbol === "BTCUSDT").length, 1,
  "a repeated call falls back to a fresh scoped positions GET");
  assert.equal(calls.filter(([kind, symbol]) =>
    kind === "openOrders" && symbol === "BTCUSDT").length, 1,
  "a repeated call falls back to a fresh scoped open-orders GET");
});

test("readPosition falls back to scoped reads for cloned, changed, mismatched, or expired account context", async () => {
  const invalidators = [
    ["clone", (accountState) => structuredClone(accountState)],
    ["mutated", (accountState) => {
      accountState.openOrders[0].stopPrice = "96";
      return accountState;
    }],
    ["wrong account", (accountState) => {
      accountState.accountId = "another-account";
      return accountState;
    }],
    ["wrong environment", (accountState) => {
      accountState.environment = "mainnet";
      return accountState;
    }],
    ["changed property descriptor", (accountState) => {
      Object.defineProperty(accountState, "verified", { enumerable: false });
      return accountState;
    }],
  ];
  for (const [label, invalidate] of invalidators) {
    const facts = splitReadContextFacts();
    const { broker, calls } = apiFixture({
      positions: [facts.position],
      orders: [facts.coreOrder, facts.runnerOrder],
    });
    const accountState = invalidate(await broker.readAccountState());
    calls.length = 0;

    const result = await broker.readPosition("BTCUSDT", {
      accountStateContext: accountState,
      allowProcessCache: false,
    });

    assert.equal(result.verified, true, label);
    assert.equal(calls.filter(([kind, symbol]) =>
      kind === "positions" && symbol === "BTCUSDT").length, 1, label);
    assert.equal(calls.filter(([kind, symbol]) =>
      kind === "openOrders" && symbol === "BTCUSDT").length, 1, label);
  }

  const facts = splitReadContextFacts();
  const { broker, calls } = apiFixture({
    positions: [facts.position],
    orders: [facts.coreOrder, facts.runnerOrder],
  });
  const staleAccountState = await broker.readAccountState();
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  calls.length = 0;

  await broker.readPosition("BTCUSDT", {
    accountStateContext: staleAccountState,
    allowProcessCache: false,
  });

  assert.equal(calls.filter(([kind, symbol]) =>
    kind === "positions" && symbol === "BTCUSDT").length, 1,
  "a context older than two seconds falls back to a scoped positions GET");
  assert.equal(calls.filter(([kind, symbol]) =>
    kind === "openOrders" && symbol === "BTCUSDT").length, 1,
  "a context older than two seconds falls back to a scoped orders GET");
});

test("readPosition timestamps account context before delayed global account reads", async () => {
  const facts = splitReadContextFacts();
  const { api, broker, calls } = apiFixture({
    positions: [facts.position],
    orders: [facts.coreOrder, facts.runnerOrder],
  });
  const getPositions = api.getPositions.bind(api);
  const getOpenOrders = api.getOpenOrders.bind(api);
  const delay = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));
  api.getPositions = async (symbol) => {
    if (symbol === undefined) await delay(2_050);
    return await getPositions(symbol);
  };
  api.getOpenOrders = async (symbol) => {
    if (symbol === undefined) await delay(2_050);
    return await getOpenOrders(symbol);
  };

  const accountState = await broker.readAccountState();
  calls.length = 0;
  await broker.readPosition("BTCUSDT", {
    accountStateContext: accountState,
    persistedPosition: facts.persistedPosition,
    allowProcessCache: false,
  });

  assert.equal(calls.filter(([kind, symbol]) =>
    kind === "positions" && symbol === "BTCUSDT").length, 1,
  "time spent awaiting the account-wide GET is included in context age");
  assert.equal(calls.filter(([kind, symbol]) =>
    kind === "openOrders" && symbol === "BTCUSDT").length, 1);
});

test("readPosition re-reads scoped rows when awaited metadata makes context stale", async () => {
  const facts = splitReadContextFacts();
  const { api, broker, calls } = apiFixture({
    positions: [facts.position],
    orders: [facts.coreOrder, facts.runnerOrder],
  });
  const contract = api.contract.bind(api);
  api.contract = async (symbol) => {
    await new Promise((resolve) => setTimeout(resolve, 2_050));
    return await contract(symbol);
  };
  const accountState = await broker.readAccountState();
  calls.length = 0;

  const result = await broker.readPosition("BTCUSDT", {
    accountStateContext: accountState,
    persistedPosition: facts.persistedPosition,
    allowProcessCache: false,
  });

  assert.equal(result.verified, true);
  assert.equal(calls.filter(([kind, symbol]) =>
    kind === "positions" && symbol === "BTCUSDT").length, 1,
  "fresh scoped positions are fetched after slow metadata expires the context");
  assert.equal(calls.filter(([kind, symbol]) =>
    kind === "openOrders" && symbol === "BTCUSDT").length, 1,
  "fresh scoped orders are fetched after slow metadata expires the context");
});

test("readPosition context preserves raw zero-quantity SHORT rows and extra same-symbol orders", async () => {
  const facts = splitReadContextFacts();
  const zeroShort = {
    ...facts.position,
    positionSide: "SHORT",
    positionAmt: "0",
    positionId: "zero-short-position",
  };
  const { broker, calls } = apiFixture({
    positions: [facts.position, zeroShort],
    orders: [facts.coreOrder, facts.runnerOrder],
  });
  const accountState = await broker.readAccountState();
  calls.length = 0;

  await assert.rejects(broker.readPosition("BTCUSDT", {
    accountStateContext: accountState,
    allowProcessCache: false,
  }), /position_state_ambiguous/);
  assert.equal(calls.filter(([kind, symbol]) =>
    kind === "positions" && symbol === "BTCUSDT").length, 0,
  "the private context retains zero-quantity SHORT rows for the same ambiguity check");
  assert.equal(calls.filter(([kind, symbol]) =>
    kind === "openOrders" && symbol === "BTCUSDT").length, 0);

  const extraOrder = {
    ...facts.coreOrder,
    orderId: "unrecognized-same-symbol-order",
    type: "LIMIT",
  };
  const extraOrderFixture = apiFixture({
    positions: [facts.position],
    orders: [facts.coreOrder, facts.runnerOrder, extraOrder],
  });
  const extraAccountState = await extraOrderFixture.broker.readAccountState();
  extraOrderFixture.calls.length = 0;
  await assert.rejects(extraOrderFixture.broker.readPosition("BTCUSDT", {
    accountStateContext: extraAccountState,
    persistedPosition: facts.persistedPosition,
    allowProcessCache: false,
  }), /persisted_position_open_order_set_mismatch/);
  assert.equal(extraOrderFixture.calls.filter(([kind, symbol]) =>
    kind === "positions" && symbol === "BTCUSDT").length, 0);
  assert.equal(extraOrderFixture.calls.filter(([kind, symbol]) =>
    kind === "openOrders" && symbol === "BTCUSDT").length, 0);
});

test("readPosition context cannot be reused across symbols or repeated reads", async () => {
  const btc = splitReadContextFacts("BTC-USDT", "btc-context");
  const eth = splitReadContextFacts("ETH-USDT", "eth-context");
  const { broker, calls } = apiFixture({
    positions: [btc.position, eth.position],
    orders: [btc.coreOrder, btc.runnerOrder, eth.coreOrder, eth.runnerOrder],
    canarySymbols: ["BTCUSDT", "ETHUSDT"],
  });
  const accountState = await broker.readAccountState();
  calls.length = 0;

  await broker.readPosition("BTCUSDT", {
    accountStateContext: accountState,
    allowProcessCache: false,
  });
  await broker.readPosition("ETHUSDT", {
    accountStateContext: accountState,
    allowProcessCache: false,
  });
  await broker.readPosition("BTCUSDT", {
    accountStateContext: accountState,
    allowProcessCache: false,
  });

  assert.equal(calls.filter(([kind, symbol]) =>
    kind === "positions" && symbol === "BTCUSDT").length, 1,
  "the context is consumed by the first symbol read and cannot be replayed");
  assert.equal(calls.filter(([kind, symbol]) =>
    kind === "openOrders" && symbol === "BTCUSDT").length, 1);
  assert.equal(calls.filter(([kind, symbol]) =>
    kind === "positions" && symbol === "ETHUSDT").length, 1,
  "a second position gets its own scoped read rather than inheriting context");
  assert.equal(calls.filter(([kind, symbol]) =>
    kind === "openOrders" && symbol === "ETHUSDT").length, 1);
});

test("split stop requests fail closed on baseline mismatch and stale runner mark", async () => {
  const position = {
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: "0.1",
    avgPrice: "100",
    positionId: "position-1",
  };
  const originalStop = {
    symbol: "BTC-USDT",
    orderId: "original-signal-stop",
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionId: "position-1",
    origQty: "0.1",
    stopPrice: "95",
    workingType: "MARK_PRICE",
    mainOrderId: "entry-order-1",
  };
  const existingCoreStop = {
    ...originalStop,
    orderId: "split-core-stop",
    origQty: "0.08",
    mainOrderId: "entry-order-1",
  };
  const { broker, calls } = apiFixture({
    positions: [position],
    orders: [originalStop, existingCoreStop],
    markPrice: "99",
  });
  await assert.rejects(broker.performIntent({
    clientOrderId: "worker-split-wrong-baseline",
    phase: "split_core_stop",
    request: impulseSplitRequest({ baselineOpenOrderIds: [] }),
  }), /baseline_open_order_ids_changed/);
  const runnerRequest = impulseSplitRequest({
    operation: "split_runner_stop",
    baselineOpenOrderIds: ["original-signal-stop", "split-core-stop"],
    coreStop: {
      tranche: "core",
      orderId: "split-core-stop",
      quantity: "0.08",
      stopPrice: "95",
    },
  });
  await assert.rejects(broker.performIntent({
    clientOrderId: "worker-split-runner-below-be",
    phase: "split_runner_stop",
    request: runnerRequest,
  }), /fresh_mark_above_entry/);
  assert.equal(calls.some(([name]) => name === "splitStop"), false);
});

test("split mutations require a durable intent timestamp before any API call", async () => {
  const { broker, calls } = apiFixture();
  const request = impulseSplitRequest({ operation: "split_core_stop" });
  delete request.intentCreatedAt;
  await assert.rejects(
    broker.performIntent({
      clientOrderId: "worker-missing-split-intent-time",
      phase: "split_core_stop",
      request,
    }),
    /durable_intent_created_at_required/,
  );
  assert.equal(calls.length, 0);
});

test("ambiguous 500-row history is not used for split-operation recovery", async () => {
  const { broker, calls } = apiFixture({
    history: Array.from({ length: 500 }, () => ({
      symbol: "BTC-USDT",
      orderId: "duplicate-history-order",
      status: "NEW",
    })),
  });
  const evidence = await broker.reconcileIntent({
    clientOrderId: "worker-overflow-history",
    phase: "split_core_stop",
    request: impulseSplitRequest(),
  });
  assert.deepEqual(evidence, { verified: false, status: "unknown" });
  const historyQuery = calls.find(([name]) => name === "history");
  assert.ok(historyQuery);
  assert.ok(historyQuery[2].startTs >= now - 24 * 60 * 60_000);
});

test("ambiguous 500-row fills are not used for order evidence", async () => {
  const rawClientOrderId = "worker-overflow-fills";
  const exchangeClientOrderId =
    `vst-${createHash("sha256").update(rawClientOrderId).digest("hex").slice(0, 28)}`;
  const fills = Array.from({ length: 500 }, () => ({
    symbol: "BTC-USDT",
    orderId: "overflow-entry-order",
    side: "BUY",
    positionSide: "LONG",
    volume: "0.1",
    price: "100",
    filledTm: now,
  }));
  const { broker, calls } = apiFixture({
    history: [{
      symbol: "BTC-USDT",
      orderId: "overflow-entry-order",
      clientOrderId: exchangeClientOrderId,
      status: "FILLED",
      side: "BUY",
      type: "MARKET",
      executedQty: "0.1",
    }],
    fills,
  });
  const evidence = await broker.reconcileIntent({
    clientOrderId: rawClientOrderId,
    phase: "entry",
    request: {
      operation: "entry",
      entryOrderType: "MARKET",
      symbol: "BTCUSDT",
      environment: "vst",
      accountId: "test-vst-account",
      quantity: "0.1",
      signal: { signalAt: new Date(now).toISOString() },
    },
  });
  assert.deepEqual(evidence, { verified: false, status: "unknown" });
  assert.ok(calls.some(([name, , range]) =>
    name === "fills" && range.orderId === "overflow-entry-order"));
});

test("a split-stop acknowledgement is reconstructed from exchange state after broker restart", async () => {
  const position = {
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: "0.1",
    avgPrice: "100",
    positionId: "position-1",
  };
  const originalStop = {
    symbol: "BTC-USDT",
    orderId: "original-signal-stop",
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionId: "position-1",
    origQty: "0.1",
    stopPrice: "95",
    workingType: "MARK_PRICE",
    mainOrderId: "entry-order-1",
  };
  const { broker, api, calls } = apiFixture({
    positions: [position],
    orders: [originalStop],
    splitStopVerified: false,
  });
  const request = impulseSplitRequest();
  await assert.rejects(broker.performIntent({
    clientOrderId: "worker-unverified-split",
    phase: "split_core_stop",
    request,
  }), /split_stop_adapter_proof_missing/);
  const restartedBroker = createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    sleep: async () => {},
    stopBufferRate: 0.005,
  });
  const evidence = await restartedBroker.reconcileIntent({
    clientOrderId: "worker-unverified-split",
    phase: "split_core_stop",
    request,
  });
  assert.equal(evidence.verified, true);
  assert.equal(evidence.stop.orderId, "split-core-stop");
  assert.equal(calls.some(([name]) => name === "splitStop"), true);
});

function splitStopWithoutHistoryFixture(clock) {
  const position = {
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: "0.1",
    avgPrice: "100",
    positionId: "position-1",
  };
  const original = {
    symbol: "BTC-USDT",
    orderId: "original-signal-stop",
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionId: "position-1",
    origQty: "0.1",
    stopPrice: "95",
    workingType: "MARK_PRICE",
    mainOrderId: "entry-order-1",
    time: now - 1_000,
  };
  const newlyPlaced = {
    ...original,
    orderId: "split-core-stop",
    origQty: "0.08",
    time: now,
  };
  const orders = [original, newlyPlaced];
  const { api, calls } = apiFixture({
    positions: [position],
    orders,
    history: [],
    clock,
    quoteTimestamp: now,
  });
  api.getVstMarkPrice = async (symbol) => ({
    symbol: `${symbol.slice(0, -4)}-USDT`,
    markPrice: "101",
    timestamp: Number(clock()),
  });
  const createBroker = () => createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock,
    sleep: async () => {},
    stopBufferRate: 0.005,
  });
  return { api, calls, orders, positions: [position], createBroker };
}

function kiiSplitStopRecoveryFixture({ clock, history = [] }) {
  const positionId = "2105662971440005121";
  const originalStopId = "2105662972415795200";
  const coreStopId = "2105663921788116992";
  const position = {
    symbol: "KII-USDT",
    positionSide: "LONG",
    positionAmt: "102868.0",
    avgPrice: "0.09002",
    positionID: positionId,
  };
  const originalStop = {
    symbol: "KII-USDT",
    orderId: originalStopId,
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionID: positionId,
    origQty: "102868.0",
    executedQty: "0.0",
    stopPrice: "0.08262",
    workingType: "MARK_PRICE",
    closePosition: "false",
    mainOrderId: "",
    time: now - 20_000,
  };
  const coreStop = {
    symbol: "KII-USDT",
    orderId: coreStopId,
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionID: positionId,
    origQty: "82294.4",
    executedQty: "0.0",
    stopPrice: "0.08262",
    workingType: "MARK_PRICE",
    closePosition: "false",
    mainOrderId: "",
    time: now,
  };
  const { api, calls } = apiFixture({
    positions: [position],
    orders: [originalStop, coreStop],
    history,
    clock,
    quoteTimestamp: clock,
  });
  const request = {
    ...impulseSplitRequest(),
    symbol: "KIIUSDT",
    accountId: "test-vst-account",
    intentCreatedAt: now - 5_000,
    positionId,
    originalStopOrderId: originalStopId,
    entryOrderId: "2105662971293204481",
    totalQuantity: "102868",
    coreQuantity: "82294.4",
    runnerQuantity: "20573.6",
    signalStopPrice: "0.08262",
    baselineOpenOrderIds: [originalStopId],
    createdAt: now - 20_000,
    signal: {
      ...impulseSplitRequest().signal,
      symbol: "KIIUSDT",
      stopLoss: "0.08262",
      signalAt: new Date(now - 20_000).toISOString(),
    },
  };
  const createBroker = () => createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["KIIUSDT"],
    clock,
    sleep: async () => {},
    stopBufferRate: 0.005,
  });
  return {
    api, calls, position, originalStop, coreStop, request, createBroker,
  };
}

test("split-stop reconciliation without NEW history requires separate exact reads thirty seconds apart", async () => {
  let currentTime = now;
  let sleepCalls = 0;
  const { api, calls } = splitStopWithoutHistoryFixture(() => currentTime);
  const broker = createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => currentTime,
    sleep: async (milliseconds) => {
      sleepCalls += 1;
      currentTime += milliseconds;
    },
    stopBufferRate: 0.005,
  });
  const intent = {
    clientOrderId: "worker-split-core-no-history",
    phase: "split_core_stop",
    request: impulseSplitRequest(),
  };
  const first = await broker.reconcileIntent(intent);
  assert.equal(first.verified, false);
  assert.equal(first.status, "unknown");
  assert.equal(currentTime, now);
  assert.equal(calls.filter(([name]) => name === "openOrders").length, 1);
  assert.equal(sleepCalls, 0);
  currentTime += 30_000;
  const evidence = await broker.reconcileIntent(intent);
  assert.equal(evidence.verified, true);
  assert.equal(evidence.stop.orderId, "split-core-stop");
  assert.ok(currentTime - now >= 30_000);
  assert.ok(calls.filter(([name]) => name === "openOrders").length >= 3);
  assert.equal(calls.some(([name]) => name === "splitStop"), false);
});

test("KII split-stop recovery advances only after two exact read-only snapshots when allOrders is empty", async () => {
  let currentTime = 1_790_864_374_955;
  const { api, calls, coreStop, request, createBroker } =
    kiiSplitStopRecoveryFixture({ clock: () => currentTime });
  const broker = createBroker();
  const intent = {
    clientOrderId: "worker-kii-core-no-history",
    phase: "split_core_stop",
    request,
  };

  const first = await broker.reconcileIntent(intent);
  assert.deepEqual(first, { verified: false, status: "unknown" });
  assert.equal(calls.filter(([name]) => name === "openOrders").length, 1);
  assert.equal(calls.some(([name]) =>
    ["splitStop", "cancelOriginal", "cancelOriginalAfterRunnerFill"].includes(name)), false);

  currentTime += 30_000;
  const recovered = await broker.reconcileIntent(intent);
  assert.equal(recovered.verified, true);
  assert.equal(recovered.stop.orderId, coreStop.orderId);
  assert.equal(recovered.position.positionId, request.positionId);
  assert.equal(Number(recovered.position.quantity), 102868);
  assert.ok(calls.filter(([name]) => name === "openOrders").length >= 3);
  assert.equal(calls.some(([name]) =>
    ["splitStop", "cancelOriginal", "cancelOriginalAfterRunnerFill"].includes(name)), false);
});

test("active split-stop history positionID zero is corroborated only by its exact live open stop", async () => {
  let currentTime = now;
  const baseline = kiiSplitStopRecoveryFixture({ clock: () => currentTime });
  const { coreStop, request, createBroker } = kiiSplitStopRecoveryFixture({
    clock: () => currentTime,
    history: [{ ...baseline.coreStop, positionID: 0 }],
  });
  const evidence = await createBroker().reconcileIntent({
    clientOrderId: "worker-kii-core-zero-position-history",
    phase: "split_core_stop",
    request,
  });
  assert.equal(evidence.verified, true);
  assert.equal(evidence.stop.orderId, coreStop.orderId);
});

test("zero-position active split-stop history with mismatched evidence stays unknown", async () => {
  const mutations = [
    ["conflicting ID aliases", (row) => { row.orderID = "different-core-stop"; }],
    ["status", (row) => { row.status = "CANCELED"; }],
    ["wrong nonzero position", (row) => { row.positionID = "different-position"; }],
    ["position alias", (row) => { row.positionId = "different-position"; }],
    ["wrong nonempty parent", (row) => { row.mainOrderId = "foreign-entry"; }],
    ["conflicting parent aliases", (row) => {
      row.mainOrderId = "2105662971293204481";
      row.parentOrderId = "foreign-entry";
    }],
    ["quantity", (row) => { row.origQty = "82294.3"; }],
    ["trigger", (row) => { row.stopPrice = "0.08263"; }],
    ["type", (row) => { row.type = "TAKE_PROFIT_MARKET"; }],
    ["working type", (row) => { row.workingType = "CONTRACT_PRICE"; }],
    ["execution", (row) => { row.executedQty = "0.1"; }],
  ];
  for (const [label, mutate] of mutations) {
    let currentTime = now;
    const base = kiiSplitStopRecoveryFixture({ clock: () => currentTime });
    const badHistory = { ...base.coreStop, positionID: 0 };
    mutate(badHistory);
    const { calls, request, createBroker } = kiiSplitStopRecoveryFixture({
      clock: () => currentTime,
      history: [badHistory],
    });
    const broker = createBroker();
    const intent = {
      clientOrderId: `worker-kii-core-zero-position-${label.replaceAll(" ", "-")}`,
      phase: "split_core_stop",
      request,
    };
    const first = await broker.reconcileIntent(intent);
    assert.equal(first.verified, false, `${label} mismatch must not verify`);
    currentTime += 30_000;
    const second = await broker.reconcileIntent(intent);
    assert.deepEqual(second, { verified: false, status: "unknown" },
      `${label} mismatch must remain unknown`);
    assert.equal(calls.some(([name]) =>
      ["splitStop", "cancelOriginal", "cancelOriginalAfterRunnerFill"].includes(name)), false);
  }
});

test("split-stop observations under thirty seconds apart cannot verify", async () => {
  let currentTime = now;
  const { api, calls, createBroker } = splitStopWithoutHistoryFixture(() => currentTime);
  const broker = createBroker();
  const intent = {
    clientOrderId: "worker-split-core-early-second-tick",
    phase: "split_core_stop",
    request: impulseSplitRequest(),
  };
  assert.equal((await broker.reconcileIntent(intent)).verified, false);
  currentTime += 29_999;
  const early = await broker.reconcileIntent(intent);
  assert.equal(early.status, "unknown");
  assert.equal(early.verified, false);
  assert.equal(calls.filter(([name]) => name === "openOrders").length, 2);
  currentTime += 1;
  assert.equal((await broker.reconcileIntent(intent)).verified, true);
});

test("runner-stop history-missing proof also requires two separate exact ticks", async () => {
  let currentTime = now;
  const { orders, createBroker } = splitStopWithoutHistoryFixture(() => currentTime);
  const coreStop = {
    symbol: "BTC-USDT",
    orderId: "split-core-stop",
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionId: "position-1",
    origQty: "0.08",
    stopPrice: "95",
    workingType: "MARK_PRICE",
    mainOrderId: "entry-order-1",
    time: now,
  };
  const runnerStop = {
    ...coreStop,
    orderId: "split-runner-stop",
    origQty: "0.02",
    stopPrice: "100",
  };
  orders.push(coreStop);
  orders[1] = runnerStop;
  const intent = {
    clientOrderId: "worker-split-runner-no-history",
    phase: "split_runner_stop",
    request: impulseSplitRequest({
      operation: "split_runner_stop",
      baselineOpenOrderIds: ["original-signal-stop", "split-core-stop"],
      coreStop: {
        tranche: "core",
        orderId: "split-core-stop",
        quantity: "0.08",
        stopPrice: "95",
      },
    }),
  };
  const broker = createBroker();
  assert.equal((await broker.reconcileIntent(intent)).status, "unknown");
  currentTime += 30_000;
  const evidence = await broker.reconcileIntent(intent);
  assert.equal(evidence.verified, true);
  assert.equal(evidence.stop.orderId, "split-runner-stop");
});

test("dynamic position fields do not invalidate an otherwise exact split-stop signature", async () => {
  let currentTime = now;
  const { api, orders, positions, createBroker } =
    splitStopWithoutHistoryFixture(() => currentTime);
  const broker = createBroker();
  const intent = {
    clientOrderId: "worker-split-core-dynamic-position-fields",
    phase: "split_core_stop",
    request: impulseSplitRequest(),
  };
  assert.equal((await broker.reconcileIntent(intent)).verified, false);
  currentTime += 30_000;
  Object.assign(positions[0], {
    unrealizedProfit: "4.25",
    isolatedMargin: "12.50",
    updateTime: currentTime,
  });
  Object.assign(orders[0], {
    margin: "12.50",
    updateTime: currentTime,
    parentOrderId: "",
  });
  const evidence = await broker.reconcileIntent(intent);
  assert.equal(evidence.verified, true);
  assert.equal(evidence.stop.orderId, "split-core-stop");
});

test("changed candidate invalidates the prior split-stop observation", async () => {
  let currentTime = now;
  const { orders, createBroker } = splitStopWithoutHistoryFixture(() => currentTime);
  const broker = createBroker();
  const intent = {
    clientOrderId: "worker-split-core-changed-candidate",
    phase: "split_core_stop",
    request: impulseSplitRequest(),
  };
  assert.equal((await broker.reconcileIntent(intent)).verified, false);
  currentTime += 30_000;
  orders[1] = { ...orders[1], orderId: "replacement-core-stop" };
  assert.equal((await broker.reconcileIntent(intent)).verified, false);
  currentTime += 1;
  assert.equal((await broker.reconcileIntent(intent)).verified, false);
  currentTime += 30_000;
  const verified = await broker.reconcileIntent(intent);
  assert.equal(verified.verified, true);
  assert.equal(verified.stop.orderId, "replacement-core-stop");
});

test("changed split-stop quantity, trigger, or candidate ID cannot verify on the second tick", async () => {
  for (const [label, mutate] of [
    ["quantity", (order) => { order.origQty = "0.07"; }],
    ["trigger", (order) => { order.stopPrice = "94"; }],
    ["candidate-id", (order) => { order.orderId = "different-core-stop"; }],
  ]) {
    let currentTime = now;
    const { orders, createBroker } =
      splitStopWithoutHistoryFixture(() => currentTime);
    const broker = createBroker();
    const intent = {
      clientOrderId: `worker-split-core-changed-${label}`,
      phase: "split_core_stop",
      request: impulseSplitRequest(),
    };
    assert.equal((await broker.reconcileIntent(intent)).verified, false);
    currentTime += 30_000;
    mutate(orders[1]);
    const changed = await broker.reconcileIntent(intent);
    assert.equal(changed.verified, false);
    assert.equal(changed.status, "unknown");
  }
});

test("a failed split-stop snapshot clears its previous observation", async () => {
  let currentTime = now;
  const { api, createBroker } = splitStopWithoutHistoryFixture(() => currentTime);
  const broker = createBroker();
  const intent = {
    clientOrderId: "worker-split-core-failed-read",
    phase: "split_core_stop",
    request: impulseSplitRequest(),
  };
  assert.equal((await broker.reconcileIntent(intent)).verified, false);
  currentTime += 30_000;
  const readPositions = api.getPositions;
  api.getPositions = async () => { throw new Error("position read failed"); };
  assert.equal((await broker.reconcileIntent(intent)).status, "unknown");
  api.getPositions = readPositions;
  currentTime += 1;
  assert.equal((await broker.reconcileIntent(intent)).verified, false);
  currentTime += 30_000;
  assert.equal((await broker.reconcileIntent(intent)).verified, true);
});

test("wrong or duplicate split-stop history clears a pending two-tick observation", async () => {
  for (const historyMode of ["wrong", "duplicate"]) {
    let currentTime = now;
    let historyOverride = null;
    const { api, createBroker } =
      splitStopWithoutHistoryFixture(() => currentTime);
    const readHistory = api.queryOrderHistory;
    api.queryOrderHistory = async (...args) =>
      historyOverride ?? await readHistory(...args);
    const broker = createBroker();
    const intent = {
      clientOrderId: `worker-split-core-${historyMode}-history`,
      phase: "split_core_stop",
      request: impulseSplitRequest(),
    };
    assert.equal((await broker.reconcileIntent(intent)).verified, false);
    const candidate = {
      symbol: "BTC-USDT",
      orderId: "split-core-stop",
      type: "STOP_MARKET",
      status: "NEW",
      side: "SELL",
      positionSide: "LONG",
      positionId: "position-1",
      origQty: "0.08",
      stopPrice: historyMode === "wrong" ? "94" : "95",
      workingType: "MARK_PRICE",
      mainOrderId: "entry-order-1",
      time: now,
    };
    historyOverride = historyMode === "wrong"
      ? [candidate]
      : [{ ...candidate, stopPrice: "95" }, { ...candidate, stopPrice: "95" }];
    currentTime += 30_000;
    assert.equal((await broker.reconcileIntent(intent)).verified, false);
    historyOverride = null;
    currentTime += 1;
    assert.equal((await broker.reconcileIntent(intent)).verified, false);
    currentTime += 30_000;
    assert.equal((await broker.reconcileIntent(intent)).verified, true);
  }
});

test("unrelated same-symbol history does not bypass or block the two exact snapshots", async () => {
  let currentTime = now;
  let historyOverride = null;
  const { api, createBroker } =
    splitStopWithoutHistoryFixture(() => currentTime);
  const readHistory = api.queryOrderHistory;
  api.queryOrderHistory = async (...args) =>
    historyOverride ?? await readHistory(...args);
  historyOverride = [{
    symbol: "BTC-USDT",
    orderId: "unrelated-market-order",
    type: "MARKET",
    status: "FILLED",
    side: "BUY",
    positionSide: "LONG",
    origQty: "0.01",
    executedQty: "0.01",
    time: now,
  }];
  const broker = createBroker();
  const intent = {
    clientOrderId: "worker-split-core-unrelated-history",
    phase: "split_core_stop",
    request: impulseSplitRequest(),
  };
  const first = await broker.reconcileIntent(intent);
  assert.equal(first.verified, false);
  assert.equal(first.status, "unknown");
  currentTime += 30_000;
  const second = await broker.reconcileIntent(intent);
  assert.equal(second.verified, true);
  assert.equal(second.stop.orderId, "split-core-stop");
});

test("conflicting history for the live split-stop candidate fails closed", async () => {
  let currentTime = now;
  let historyOverride = null;
  const { api, createBroker } =
    splitStopWithoutHistoryFixture(() => currentTime);
  const readHistory = api.queryOrderHistory;
  api.queryOrderHistory = async (...args) =>
    historyOverride ?? await readHistory(...args);
  const broker = createBroker();
  const intent = {
    clientOrderId: "worker-split-core-conflicting-history",
    phase: "split_core_stop",
    request: impulseSplitRequest(),
  };
  assert.equal((await broker.reconcileIntent(intent)).verified, false);
  historyOverride = [{
    symbol: "BTC-USDT",
    orderId: "split-core-stop",
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionId: "position-1",
    origQty: "0.07",
    stopPrice: "95",
    workingType: "MARK_PRICE",
    mainOrderId: "entry-order-1",
    time: now,
  }];
  currentTime += 30_000;
  const conflicting = await broker.reconcileIntent(intent);
  assert.equal(conflicting.verified, false);
  assert.equal(conflicting.status, "unknown");
});

test("a new broker cannot reuse an unverified split-stop observation", async () => {
  let currentTime = now;
  const { createBroker } = splitStopWithoutHistoryFixture(() => currentTime);
  const intent = {
    clientOrderId: "worker-split-core-new-broker",
    phase: "split_core_stop",
    request: impulseSplitRequest(),
  };
  const firstBroker = createBroker();
  assert.equal((await firstBroker.reconcileIntent(intent)).verified, false);
  currentTime += 30_000;
  const restartedBroker = createBroker();
  assert.equal((await restartedBroker.reconcileIntent(intent)).verified, false);
  currentTime += 30_000;
  const verified = await restartedBroker.reconcileIntent(intent);
  assert.equal(verified.verified, true);
});

test("overlapping split-stop reconciliations cannot share an in-flight observation", async () => {
  let currentTime = now;
  const { api, createBroker } = splitStopWithoutHistoryFixture(() => currentTime);
  const readHistory = api.queryOrderHistory;
  let releaseHistory;
  let historyCalls = 0;
  const historyGate = new Promise((resolve) => { releaseHistory = resolve; });
  api.queryOrderHistory = async (...args) => {
    historyCalls += 1;
    await historyGate;
    return readHistory(...args);
  };
  const broker = createBroker();
  const intent = {
    clientOrderId: "worker-split-core-concurrent",
    phase: "split_core_stop",
    request: impulseSplitRequest(),
  };
  const pending = broker.reconcileIntent(intent);
  await new Promise((resolve) => setImmediate(resolve));
  const concurrent = await broker.reconcileIntent(intent);
  assert.equal(concurrent.verified, false);
  assert.equal(historyCalls, 1);
  releaseHistory();
  assert.equal((await pending).verified, false);
  currentTime += 30_000;
  assert.equal((await broker.reconcileIntent(intent)).verified, true);
});

test("split-stop observations expire, restart on clock regression, and evict oldest beyond 256", async () => {
  let currentTime = now;
  const { createBroker } = splitStopWithoutHistoryFixture(() => currentTime);
  const broker = createBroker();
  const expiryIntent = {
    clientOrderId: "worker-split-core-expiry",
    phase: "split_core_stop",
    request: impulseSplitRequest(),
  };
  assert.equal((await broker.reconcileIntent(expiryIntent)).verified, false);
  currentTime += 10 * 60_000;
  assert.equal((await broker.reconcileIntent(expiryIntent)).verified, false);
  currentTime += 30_000;
  assert.equal((await broker.reconcileIntent(expiryIntent)).verified, true);

  currentTime = now + 30_000;
  const regressingIntent = {
    clientOrderId: "worker-split-core-regressing-clock",
    phase: "split_core_stop",
    request: impulseSplitRequest(),
  };
  assert.equal((await broker.reconcileIntent(regressingIntent)).verified, false);
  currentTime = now + 10_000;
  assert.equal((await broker.reconcileIntent(regressingIntent)).verified, false);
  currentTime += 30_000;
  assert.equal((await broker.reconcileIntent(regressingIntent)).verified, true);

  currentTime = now;
  const intents = Array.from({ length: 257 }, (_, index) => ({
    clientOrderId: `worker-split-core-eviction-${index}`,
    phase: "split_core_stop",
    request: impulseSplitRequest(),
  }));
  for (const intent of intents) {
    assert.equal((await broker.reconcileIntent(intent)).verified, false);
  }
  currentTime += 30_000;
  assert.equal((await broker.reconcileIntent(intents[0])).verified, false);
  assert.equal((await broker.reconcileIntent(intents[256])).verified, true);
});

test("partial-close and cleanup reconciliation recover from a new broker using fills and history", async () => {
  const position = {
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: "0.1",
    avgPrice: "100",
    positionId: "position-1",
  };
  const coreStop = {
    tranche: "core",
    orderId: "split-core-stop",
    quantity: "0.08",
    stopPrice: "95",
  };
  const runnerStop = {
    tranche: "runner",
    orderId: "split-runner-stop",
    quantity: "0.02",
    stopPrice: "100",
  };
  const openStops = [
    {
      symbol: "BTC-USDT",
      orderId: coreStop.orderId,
      type: "STOP_MARKET",
      status: "NEW",
      side: "SELL",
      positionSide: "LONG",
      positionId: "position-1",
      origQty: "0.08",
      stopPrice: "95",
      workingType: "MARK_PRICE",
      mainOrderId: "entry-order-1",
    },
    {
      symbol: "BTC-USDT",
      orderId: runnerStop.orderId,
      type: "STOP_MARKET",
      status: "NEW",
      side: "SELL",
      positionSide: "LONG",
      positionId: "position-1",
      origQty: "0.02",
      stopPrice: "100",
      workingType: "MARK_PRICE",
      mainOrderId: "entry-order-1",
    },
  ];
  const { api, broker, calls } = apiFixture({
    positions: [position],
    orders: openStops,
  });
  const priorPosition = {
    verified: true,
    environment: "vst",
    accountId: "test-vst-account",
    symbol: "BTCUSDT",
    positionId: "position-1",
    quantity: "0.1",
    protectiveStops: {
      core: {
        verified: true,
        tranche: "core",
        orderId: coreStop.orderId,
        positionId: "position-1",
        quantity: "0.08",
        stopPrice: "95",
      },
      runner: {
        verified: true,
        tranche: "runner",
        orderId: runnerStop.orderId,
        positionId: "position-1",
        quantity: "0.02",
        stopPrice: "100",
      },
    },
  };
  const closeRequest = {
    ...impulseSplitRequest({
      operation: "close_leg",
      baselineOpenOrderIds: ["split-core-stop", "split-runner-stop"],
      coreStop,
      runnerStop,
      priorPosition: {
        status: "open",
        persistedPosition: priorPosition,
        persistedSnapshot: priorPosition,
      },
      persistedPosition: priorPosition,
    }),
    leg: "core",
    quantity: "0.08",
    previousQuantity: "0.1",
    exchangeAutoResizeAware: true,
  };
  const conflictingRequest = {
    ...closeRequest,
    persistedPosition: { ...priorPosition, quantity: "0.09" },
  };
  await assert.rejects(
    broker.performIntent({
      clientOrderId: "worker-conflicting-position-snapshots",
      phase: "close_core",
      request: conflictingRequest,
    }),
    /persisted_position_snapshot_conflict/,
  );
  assert.equal(calls.filter(([name]) => name === "splitClose").length, 0);
  await broker.performIntent({
    clientOrderId: "worker-split-close-crash",
    phase: "close_core",
    request: closeRequest,
  });
  const closeMutationCount = calls.filter(([name]) => name === "splitClose").length;
  const restartedCloseBroker = createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    sleep: async () => {},
    stopBufferRate: 0.005,
  });
  const closeEvidence = await restartedCloseBroker.reconcileIntent({
    clientOrderId: "worker-split-close-crash",
    phase: "close_core",
    request: closeRequest,
  });
  assert.equal(closeEvidence.verified, true);
  assert.equal(closeEvidence.exchangeOrderId, "split-close-order");
  assert.equal(closeEvidence.executedQuantity, "0.08");
  assert.equal(closeEvidence.position.quantity, 0.02);
  assert.equal(closeEvidence.autoResize.retainedStopOrderId, runnerStop.orderId);
  assert.equal(calls.filter(([name]) => name === "splitClose").length, closeMutationCount);

  const cleanupRequest = {
    ...impulseSplitRequest({
      operation: "cancel_split_stop",
      baselineOpenOrderIds: ["split-core-stop", "split-runner-stop"],
      coreStop,
      runnerStop,
      persistedPosition: closeEvidence.position.persistedSnapshot,
    }),
    leg: "core",
    remainingQuantity: "0.02",
  };
  const restartedCleanupBroker = createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    sleep: async () => {},
    stopBufferRate: 0.005,
  });
  await restartedCleanupBroker.performIntent({
    clientOrderId: "worker-split-cleanup-crash",
    phase: "cancel_split_stop",
    request: cleanupRequest,
  });
  const cleanupMutationCount = calls.filter(([name]) => name === "cleanupSplitStop").length;
  const reconciledCleanupBroker = createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    sleep: async () => {},
    stopBufferRate: 0.005,
  });
  const cleanupEvidence = await reconciledCleanupBroker.reconcileIntent({
    clientOrderId: "worker-split-cleanup-crash",
    phase: "cancel_split_stop",
    request: cleanupRequest,
  });
  assert.equal(cleanupEvidence.verified, true);
  assert.equal(cleanupEvidence.position.quantity, 0.02);
  assert.equal(cleanupEvidence.protectiveStops.runner.orderId, runnerStop.orderId);
  assert.equal(calls.filter(([name]) => name === "cleanupSplitStop").length,
    cleanupMutationCount);
});

test("triggered-runner cancellation reconciles after broker restart without a second DELETE", async () => {
  const scenario = triggeredRunnerCancelFixture();
  await scenario.broker.performIntent({
    clientOrderId: scenario.intentId,
    phase: "cancel_original_after_runner_fill",
    request: scenario.request,
  });
  const adapterCall = scenario.calls.find(
    ([name]) => name === "cancelOriginalAfterRunnerFill",
  );
  assert.ok(adapterCall);
  assert.equal(adapterCall[1].cancellationIntentId, scenario.intentId);
  assert.equal(adapterCall[1].runnerStopOrderId, "runner-stop");
  assert.equal(adapterCall[1].runnerChildOrderId, "runner-child");
  assert.equal(adapterCall[1].originalStopOrderId, "original-stop");
  assert.equal(adapterCall[1].coreStopOrderId, "core-stop");
  assert.equal(adapterCall[1].totalQuantity, "0.1");
  assert.equal(adapterCall[1].remainingQuantity, "0.08");
  assert.equal(adapterCall[1].runnerFillAt, now);

  // A restarted broker has no in-memory mutation proof. It settles the
  // durable intent from signed reads and must never invoke cancellation again.
  const restartedBroker = createVstBroker({
    api: scenario.api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    stopBufferRate: 0.005,
  });
  await assert.rejects(restartedBroker.performIntent({
    clientOrderId: scenario.intentId,
    phase: "cancel_original_after_runner_fill",
    request: scenario.request,
  }), /already_submitted_never_retry/);
  const evidence = await restartedBroker.reconcileIntent({
    clientOrderId: scenario.intentId,
    phase: "cancel_original_after_runner_fill",
    request: scenario.request,
  });
  assert.equal(evidence.verified, true, JSON.stringify(evidence));
  assert.equal(evidence.status, "filled");
  assert.equal(evidence.canceledOriginalStopOrderId, "original-stop");
  assert.equal(evidence.runnerStopOrderId, "runner-stop");
  assert.equal(evidence.runnerChildOrderId, "runner-child");
  assert.equal(evidence.position.positionId, "position-1");
  assert.equal(evidence.position.quantity, 0.08);
  const fillQuery = scenario.calls.find(([name, , range]) =>
    name === "fills" && range?.currency === "VST" && !range?.orderId);
  assert.equal(fillQuery[2].startTs, now - 1);
  assert.equal(scenario.calls.filter(
    ([name]) => name === "cancelOriginalAfterRunnerFill",
  ).length, 1);
  assert.equal(scenario.calls.some(([name]) =>
    name === "delete" || name === "DELETE"), false);
});

test("triggered-runner reconciliation includes the exclusive fill boundary only within 23 hours", async () => {
  const maxHistoryWindowMs = 23 * 60 * 60 * 1000;
  const withinBoundary = triggeredRunnerCancelFixture(
    "durable-runner-cancel-boundary", "boundary",
  );
  withinBoundary.request.priorPosition.split.runnerCleanup.fill.at =
    new Date(now - maxHistoryWindowMs + 1).toISOString();
  await withinBoundary.broker.performIntent({
    clientOrderId: withinBoundary.intentId,
    phase: "cancel_original_after_runner_fill",
    request: withinBoundary.request,
  });
  const restartedBroker = createVstBroker({
    api: withinBoundary.api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    stopBufferRate: 0.005,
  });
  const evidence = await restartedBroker.reconcileIntent({
    clientOrderId: withinBoundary.intentId,
    phase: "cancel_original_after_runner_fill",
    request: withinBoundary.request,
  });
  assert.equal(evidence.verified, true, JSON.stringify(evidence));
  const fillQuery = withinBoundary.calls.find(([name, , range]) =>
    name === "fills" && range?.currency === "VST" && !range?.orderId);
  assert.equal(fillQuery[2].startTs, now - maxHistoryWindowMs);
  assert.equal(fillQuery[2].endTs - fillQuery[2].startTs, maxHistoryWindowMs);

  const outsideBoundary = triggeredRunnerCancelFixture(
    "durable-runner-cancel-outside-boundary", "outside-boundary",
  );
  outsideBoundary.request.priorPosition.split.runnerCleanup.fill.at =
    new Date(now - maxHistoryWindowMs).toISOString();
  const rejected = await outsideBoundary.broker.reconcileIntent({
    clientOrderId: outsideBoundary.intentId,
    phase: "cancel_original_after_runner_fill",
    request: outsideBoundary.request,
  });
  assert.deepEqual(rejected, { verified: false, status: "unknown" });
  assert.equal(outsideBoundary.calls.some(([name]) => name === "fills"), false);
  assert.equal(outsideBoundary.calls.some(([name]) =>
    name === "cancelOriginalAfterRunnerFill"), false);
});

test("triggered-runner cancellation reconciliation rejects foreign orders and invalid intent IDs", async () => {
  const scenario = triggeredRunnerCancelFixture("durable-runner-cancel-foreign", "foreign");
  const invalidRequest = { ...scenario.request, intentId: "different-durable-id" };
  await assert.rejects(scenario.broker.performIntent({
    clientOrderId: scenario.intentId,
    phase: "cancel_original_after_runner_fill",
    request: invalidRequest,
  }), /intent_identity_invalid/);
  assert.equal(scenario.calls.some(
    ([name]) => name === "cancelOriginalAfterRunnerFill",
  ), false);

  await scenario.broker.performIntent({
    clientOrderId: scenario.intentId,
    phase: "cancel_original_after_runner_fill",
    request: scenario.request,
  });
  // Keep the exact core stop from the fixture while adding an unexplained
  // order to prove reconciliation fails closed.
  const originalGetOrders = scenario.api.getOpenOrders;
  scenario.api.getOpenOrders = async (symbol) => {
    const prior = await originalGetOrders(symbol);
    return [...prior, {
      symbol: "BTC-USDT",
      orderId: "foreign-order",
      type: "LIMIT",
      status: "NEW",
      side: "BUY",
    }];
  };
  const restartedBroker = createVstBroker({
    api: scenario.api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    stopBufferRate: 0.005,
  });
  const evidence = await restartedBroker.reconcileIntent({
    clientOrderId: scenario.intentId,
    phase: "cancel_original_after_runner_fill",
    request: scenario.request,
  });
  assert.deepEqual(evidence, { verified: false, status: "unknown" });
  assert.equal(scenario.calls.filter(
    ([name]) => name === "cancelOriginalAfterRunnerFill",
  ).length, 1);
});

test("triggered-runner cancellation reconciliation rejects conflicting parent and child aliases", async () => {
  const scenario = triggeredRunnerCancelFixture("durable-runner-cancel-conflict", "conflict");
  await scenario.broker.performIntent({
    clientOrderId: scenario.intentId,
    phase: "cancel_original_after_runner_fill",
    request: scenario.request,
  });
  const originalQueryOrder = scenario.api.queryOrder;
  scenario.api.queryOrder = async (symbol, identifier) => {
    if (identifier?.orderId === scenario.request.runnerStopOrderId) {
      return {
        ...(await originalQueryOrder(symbol, identifier)),
        orderID: scenario.request.runnerStopOrderId,
      };
    }
    return originalQueryOrder(symbol, identifier);
  };
  const restartedBroker = createVstBroker({
    api: scenario.api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    stopBufferRate: 0.005,
  });
  const evidence = await restartedBroker.reconcileIntent({
    clientOrderId: scenario.intentId,
    phase: "cancel_original_after_runner_fill",
    request: scenario.request,
  });
  assert.deepEqual(evidence, { verified: false, status: "unknown" });
  assert.equal(scenario.calls.filter(
    ([name]) => name === "cancelOriginalAfterRunnerFill",
  ).length, 1);
});

test("triggered-runner reconciliation accepts absent fill position ID but rejects conflicts", async () => {
  const scenario = triggeredRunnerCancelFixture(
    "durable-runner-cancel-fill-position", "fill-position",
  );
  await scenario.broker.performIntent({
    clientOrderId: scenario.intentId,
    phase: "cancel_original_after_runner_fill",
    request: scenario.request,
  });
  const queryFills = scenario.api.queryFills;
  scenario.api.queryFills = async (...args) =>
    (await queryFills(...args)).map((fill) => ({
      ...fill,
      positionId: "position-1",
      positionID: "foreign-position",
    }));
  const restartedBroker = createVstBroker({
    api: scenario.api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    stopBufferRate: 0.005,
  });
  const evidence = await restartedBroker.reconcileIntent({
    clientOrderId: scenario.intentId,
    phase: "cancel_original_after_runner_fill",
    request: scenario.request,
  });
  assert.deepEqual(evidence, { verified: false, status: "unknown" });
});

function splitUpgradeState(total = "0.1") {
  const position = {
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: total,
    avgPrice: "100",
    positionId: "position-1",
  };
  const core = {
    symbol: "BTC-USDT",
    orderId: "core-stop-before-upgrade",
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionId: "position-1",
    origQty: "0.08",
    stopPrice: "95",
    workingType: "MARK_PRICE",
  };
  const runner = {
    ...core,
    orderId: "runner-stop-before-upgrade",
    origQty: "0.02",
    stopPrice: "100",
  };
  return { position, core, runner };
}

function splitRaiseRequest(operation = "split_raise_stop_place", overrides = {}) {
  return {
    operation,
    environment: "vst",
    accountId: "test-vst-account",
    intentCreatedAt: now,
    symbol: "BTCUSDT",
    positionId: "position-1",
    totalQuantity: "0.1",
    leg: "core",
    oldStop: {
      tranche: "core",
      orderId: "core-stop-before-upgrade",
      quantity: "0.08",
      stopPrice: "95",
    },
    otherStop: {
      tranche: "runner",
      orderId: "runner-stop-before-upgrade",
      quantity: "0.02",
      stopPrice: "100",
    },
    newStopPrice: "96",
    upgradeIntentId: "durable-upgrade-1",
    ...overrides,
  };
}

test("split stop upgrade place and cancel reconcile on fresh broker instances", async () => {
  const state = splitUpgradeState();
  const { api, broker, calls } = apiFixture({
    positions: [state.position],
    orders: [state.core, state.runner],
  });
  const placeRequest = splitRaiseRequest();
  await broker.performIntent({
    clientOrderId: "worker-split-upgrade-place",
    phase: "split_raise_stop_place",
    request: placeRequest,
  });
  const placeMutationCount = calls.filter(([name]) => name === "splitRaisePlace").length;
  const placedStop = calls.find(([name]) => name === "splitRaisePlace")[1];
  const placeEvidence = await createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    stopBufferRate: 0.005,
  }).reconcileIntent({
    clientOrderId: "worker-split-upgrade-place",
    phase: "split_raise_stop_place",
    request: placeRequest,
  });
  assert.equal(placeEvidence.verified, true);
  assert.equal(placeEvidence.newStop.orderId, "split-core-raised");
  assert.equal(placeEvidence.newStop.clientOrderId, placedStop.clientOrderId);
  assert.equal(placeEvidence.otherStop.orderId, state.runner.orderId);
  assert.equal(calls.filter(([name]) => name === "splitRaisePlace").length,
    placeMutationCount);

  const cancelRequest = splitRaiseRequest("split_raise_stop_cancel", {
    newStop: {
      tranche: "core",
      orderId: "split-core-raised",
      quantity: "0.08",
      stopPrice: "96",
      clientOrderId: placedStop.clientOrderId,
    },
  });
  await broker.performIntent({
    clientOrderId: "worker-split-upgrade-cancel",
    phase: "split_raise_stop_cancel",
    request: cancelRequest,
  });
  const cancelMutationCount = calls.filter(([name]) => name === "splitRaiseCancel").length;
  const cancelEvidence = await createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    stopBufferRate: 0.005,
  }).reconcileIntent({
    clientOrderId: "worker-split-upgrade-cancel",
    phase: "split_raise_stop_cancel",
    request: cancelRequest,
  });
  assert.equal(cancelEvidence.verified, true);
  assert.equal(cancelEvidence.canceledStopOrderId, state.core.orderId);
  assert.equal(cancelEvidence.protectiveStops.core.orderId, "split-core-raised");
  assert.equal(cancelEvidence.protectiveStops.runner.orderId, state.runner.orderId);
  assert.equal(calls.filter(([name]) => name === "splitRaiseCancel").length,
    cancelMutationCount);
});

test("active split-stop upgrade query positionID zero is corroborated by the exact current open stop", async () => {
  const state = splitUpgradeState();
  const { api, broker, calls } = apiFixture({
    positions: [state.position],
    orders: [state.core, state.runner],
  });
  const request = splitRaiseRequest();
  await broker.performIntent({
    clientOrderId: "worker-split-upgrade-zero-position-query",
    phase: "split_raise_stop_place",
    request,
  });
  const placedStop = calls.find(([name]) => name === "splitRaisePlace")[1];
  const mutationCount = calls.filter(([name]) => name === "splitRaisePlace").length;
  const getOpenOrders = api.getOpenOrders;
  api.getOpenOrders = async (symbol) => (await getOpenOrders(symbol)).map((row) =>
    row.orderId === "split-core-raised" ? { ...row, executedQty: "0.0" } : row);
  const queryOrder = api.queryOrder;
  api.queryOrder = async (symbol, identifier) => {
    const row = await queryOrder(symbol, identifier);
    return identifier?.clientOrderId === placedStop.clientOrderId
      ? { ...row, positionId: 0, executedQty: "0.0", closePosition: "" }
      : row;
  };

  const evidence = await createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    stopBufferRate: 0.005,
  }).reconcileIntent({
    clientOrderId: "worker-split-upgrade-zero-position-query",
    phase: "split_raise_stop_place",
    request,
  });

  assert.equal(evidence.verified, true);
  assert.equal(evidence.newStop.orderId, "split-core-raised");
  assert.equal(calls.filter(([name]) => name === "splitRaisePlace").length,
    mutationCount);
});

test("active split-stop upgrade query with positionID zero rejects invalid parent links", async () => {
  const mutations = [
    ["wrong nonempty parent", (row) => { row.mainOrderId = "foreign-entry"; }],
    ["conflicting parent aliases", (row) => {
      row.mainOrderId = "entry-order-1";
      row.parentOrderId = "foreign-entry";
    }],
  ];
  for (const [label, mutate] of mutations) {
    const state = splitUpgradeState();
    const { api, broker, calls } = apiFixture({
      positions: [state.position],
      orders: [state.core, state.runner],
    });
    const request = splitRaiseRequest("split_raise_stop_place", {
      entryOrderId: "entry-order-1",
    });
    const clientOrderId = `worker-split-upgrade-zero-parent-${label.replaceAll(" ", "-")}`;
    await broker.performIntent({
      clientOrderId,
      phase: "split_raise_stop_place",
      request,
    });
    const placedStop = calls.find(([name]) => name === "splitRaisePlace")[1];
    const mutationCount = calls.filter(([name]) => name === "splitRaisePlace").length;
    const getOpenOrders = api.getOpenOrders;
    api.getOpenOrders = async (symbol) => (await getOpenOrders(symbol)).map((row) =>
      row.orderId === "split-core-raised" ? { ...row, executedQty: "0.0" } : row);
    const queryOrder = api.queryOrder;
    api.queryOrder = async (symbol, identifier) => {
      const row = await queryOrder(symbol, identifier);
      if (identifier?.clientOrderId !== placedStop.clientOrderId) return row;
      const sentinelQuery = {
        ...row,
        positionId: 0,
        executedQty: "0.0",
      };
      mutate(sentinelQuery);
      return sentinelQuery;
    };

    const evidence = await createVstBroker({
      api,
      accountId: "test-vst-account",
      canarySymbols: ["BTCUSDT"],
      clock: () => now,
      stopBufferRate: 0.005,
    }).reconcileIntent({
      clientOrderId,
      phase: "split_raise_stop_place",
      request,
    });

    assert.deepEqual(evidence, { verified: false, status: "unknown" }, label);
    assert.equal(calls.filter(([name]) => name === "splitRaisePlace").length,
      mutationCount);
  }
});

test("split stop upgrade without NEW history requires two exact snapshots thirty seconds apart", async () => {
  let currentTime = now;
  const state = splitUpgradeState();
  const { api, broker, calls } = apiFixture({
    positions: [state.position],
    orders: [state.core, state.runner],
    clock: () => currentTime,
    quoteTimestamp: () => currentTime,
    sleep: async (milliseconds) => { currentTime += milliseconds; },
  });
  const request = splitRaiseRequest();
  await broker.performIntent({
    clientOrderId: "worker-split-upgrade-no-history",
    phase: "split_raise_stop_place",
    request,
  });
  api.queryOrderHistory = async (symbol, range) => {
    calls.push(["history", symbol, range]);
    return [];
  };
  const mutationCount = calls.filter(([name]) => name === "splitRaisePlace").length;
  const evidence = await createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => currentTime,
    sleep: async (milliseconds) => { currentTime += milliseconds; },
    stopBufferRate: 0.005,
  }).reconcileIntent({
    clientOrderId: "worker-split-upgrade-no-history",
    phase: "split_raise_stop_place",
    request,
  });
  assert.equal(evidence.verified, true);
  assert.equal(evidence.newStop.orderId, "split-core-raised");
  assert.ok(currentTime - now >= 30_000);
  assert.equal(calls.filter(([name]) => name === "splitRaisePlace").length,
    mutationCount);
});

test("sole surviving split leg close reconciles exact fills and canceled stop after restart", async () => {
  const state = splitUpgradeState("0.02");
  const survivor = {
    ...state.runner,
    orderId: "surviving-runner-stop",
    origQty: "0.02",
    stopPrice: "100",
  };
  const { api, broker, calls } = apiFixture({
    positions: [state.position],
    orders: [survivor],
  });
  const request = {
    operation: "close_survivor",
    environment: "vst",
    accountId: "test-vst-account",
    intentCreatedAt: now,
    symbol: "BTCUSDT",
    positionId: "position-1",
    quantity: "0.02",
    stop: {
      tranche: "runner",
      orderId: survivor.orderId,
      quantity: "0.02",
      stopPrice: "100",
    },
    closeIntentId: "durable-survivor-close-1",
  };
  await broker.performIntent({
    clientOrderId: "worker-close-survivor",
    phase: "close_survivor",
    request,
  });
  const mutationCount = calls.filter(([name]) => name === "closeSurvivor").length;
  const evidence = await createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    stopBufferRate: 0.005,
  }).reconcileIntent({
    clientOrderId: "worker-close-survivor",
    phase: "close_survivor",
    request,
  });
  assert.equal(evidence.verified, true);
  assert.equal(evidence.status, "filled");
  assert.equal(evidence.closedQuantity, "0.02");
  assert.equal(evidence.position.quantity, 0);
  assert.equal(evidence.canceledStopOrderId, survivor.orderId);
  assert.equal(evidence.noOpenStops, true);
  assert.equal(calls.filter(([name]) => name === "closeSurvivor").length, mutationCount);
});

function fullSplitStops() {
  return {
    core: {
      symbol: "BTC-USDT",
      orderId: "split-core-stop",
      type: "STOP_MARKET",
      status: "NEW",
      side: "SELL",
      positionSide: "LONG",
      positionId: "position-1",
      origQty: "0.08",
      stopPrice: "95",
      workingType: "MARK_PRICE",
    },
    runner: {
      symbol: "BTC-USDT",
      orderId: "split-runner-stop",
      type: "STOP_MARKET",
      status: "NEW",
      side: "SELL",
      positionSide: "LONG",
      positionId: "position-1",
      origQty: "0.02",
      stopPrice: "100",
      workingType: "MARK_PRICE",
    },
  };
}

function closeSplitAllRequest(stops = fullSplitStops()) {
  return {
    operation: "close_split_all",
    environment: "vst",
    accountId: "test-vst-account",
    intentCreatedAt: now,
    symbol: "BTCUSDT",
    positionId: "position-1",
    totalQuantity: "0.1",
    coreStop: {
      tranche: "core",
      orderId: stops.core.orderId,
      quantity: "0.08",
      stopPrice: "95",
    },
    runnerStop: {
      tranche: "runner",
      orderId: stops.runner.orderId,
      quantity: "0.02",
      stopPrice: "100",
    },
    closeIntentId: "durable-full-split-close-1",
  };
}

function preRunnerSplitCloseRequest(stops = fullSplitStops()) {
  return {
    operation: "close_pre_runner_split",
    environment: "vst",
    accountId: "test-vst-account",
    intentCreatedAt: now,
    symbol: "BTCUSDT",
    positionId: "position-1",
    totalQuantity: "0.1",
    originalStop: {
      tranche: "original",
      orderId: "original-attached-stop",
      quantity: "0.1",
      stopPrice: "95",
      positionId: "position-1",
    },
    coreStop: {
      tranche: "core",
      orderId: stops.core.orderId,
      quantity: "0.08",
      stopPrice: "95",
      positionId: "position-1",
    },
    closeIntentId: "durable-pre-runner-close-1",
  };
}

test("full split close and one-at-a-time flat stop cleanup reconcile after restart", async () => {
  const stops = fullSplitStops();
  const position = {
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: "0.1",
    avgPrice: "100",
    positionId: "position-1",
  };
  const { api, broker, calls } = apiFixture({
    positions: [position],
    orders: [stops.core, stops.runner],
    history: [stops.core, stops.runner],
  });
  const closeRequest = closeSplitAllRequest(stops);
  await broker.performIntent({
    clientOrderId: "worker-close-split-all",
    phase: "close_split_all",
    request: closeRequest,
  });
  const closeMutationCount = calls.filter(([name]) => name === "closeSplitAll").length;
  const closeEvidence = await createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    stopBufferRate: 0.005,
  }).reconcileIntent({
    clientOrderId: "worker-close-split-all",
    phase: "close_split_all",
    request: closeRequest,
  });
  assert.equal(closeEvidence.verified, true);
  assert.equal(closeEvidence.flat, true);
  assert.equal(closeEvidence.closedQuantity, "0.1");
  assert.deepEqual(closeEvidence.remainingKnownStopOrderIds, [stops.runner.orderId]);
  assert.equal(closeEvidence.fullyCleaned, false);
  assert.equal(calls.filter(([name]) => name === "closeSplitAll").length,
    closeMutationCount);

  const cleanupRequest = {
    operation: "cancel_flat_split_stop",
    environment: "vst",
    accountId: "test-vst-account",
    intentCreatedAt: now,
    symbol: "BTCUSDT",
    positionId: "position-1",
    stopToCancel: {
      tranche: "runner",
      orderId: stops.runner.orderId,
      quantity: "0.02",
      stopPrice: "100",
    },
    knownRemainingStopOrderIds: [stops.runner.orderId],
    cancellationIntentId: "durable-flat-runner-cleanup-1",
  };
  await broker.performIntent({
    clientOrderId: "worker-clean-flat-runner",
    phase: "cancel_flat_split_stop",
    request: cleanupRequest,
  });
  const cleanupMutationCount = calls.filter(
    ([name]) => name === "cancelFlatSplitStop",
  ).length;
  const cleanupEvidence = await createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    stopBufferRate: 0.005,
  }).reconcileIntent({
    clientOrderId: "worker-clean-flat-runner",
    phase: "cancel_flat_split_stop",
    request: cleanupRequest,
  });
  assert.equal(cleanupEvidence.verified, true);
  assert.equal(cleanupEvidence.flat, true);
  assert.deepEqual(cleanupEvidence.remainingKnownStopOrderIds, []);
  assert.equal(calls.filter(([name]) => name === "cancelFlatSplitStop").length,
    cleanupMutationCount);
});

test("pre-runner split close reconciles an ambiguous response on a fresh broker and preserves known stops", async () => {
  const split = fullSplitStops();
  const originalStop = {
    ...split.core,
    orderId: "original-attached-stop",
    origQty: "0.1",
    stopPrice: "95",
  };
  const coreStop = split.core;
  const position = {
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: "0.1",
    avgPrice: "100",
    positionId: "position-1",
  };
  const orders = [originalStop, coreStop];
  const { api, broker, calls } = apiFixture({
    positions: [position],
    orders,
    history: [originalStop, coreStop],
    ambiguousPreRunnerClose: true,
  });
  const request = preRunnerSplitCloseRequest({
    core: { ...coreStop, orderId: "split-core-stop" },
  });
  await assert.rejects(
    broker.performIntent({
      clientOrderId: "worker-close-pre-runner",
      phase: "close_pre_runner_split",
      request,
    }),
    /simulated_lost_pre_runner_close_acknowledgement/,
  );
  assert.equal(calls.filter(([name]) => name === "closePreRunnerSplit").length, 1);
  assert.equal(calls.some(([name]) => name === "close"), false);
  assert.equal(position.positionAmt, "0");
  assert.deepEqual(orders.map((row) => row.orderId), [
    "original-attached-stop", "split-core-stop",
  ]);

  const evidence = await createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    stopBufferRate: 0.005,
  }).reconcileIntent({
    clientOrderId: "worker-close-pre-runner",
    phase: "close_pre_runner_split",
    request,
  });
  assert.equal(evidence.verified, true);
  assert.equal(evidence.status, "filled");
  assert.equal(evidence.closedQuantity, "0.1");
  assert.equal(evidence.position.quantity, 0);
  assert.equal(evidence.flat, true);
  assert.deepEqual(evidence.remainingKnownStopOrderIds, [
    "original-attached-stop", "split-core-stop",
  ]);
  assert.equal(evidence.fullyCleaned, false);
  assert.equal(calls.filter(([name]) => name === "closePreRunnerSplit").length, 1);

  const cleanupRequest = {
    operation: "cancel_flat_split_stop",
    environment: "vst",
    accountId: "test-vst-account",
    intentCreatedAt: now,
    symbol: "BTCUSDT",
    positionId: "position-1",
    stopToCancel: {
      orderId: "original-attached-stop",
      quantity: "0.1",
      stopPrice: "95",
    },
    knownRemainingStopOrderIds: evidence.remainingKnownStopOrderIds,
    cancellationIntentId: "durable-pre-runner-original-cleanup",
  };
  await broker.performIntent({
    clientOrderId: "worker-clean-pre-runner-original",
    phase: "cancel_flat_split_stop",
    request: cleanupRequest,
  });
  const cleanupEvidence = await createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    stopBufferRate: 0.005,
  }).reconcileIntent({
    clientOrderId: "worker-clean-pre-runner-original",
    phase: "cancel_flat_split_stop",
    request: cleanupRequest,
  });
  assert.equal(cleanupEvidence.verified, true);
  assert.deepEqual(cleanupEvidence.remainingKnownStopOrderIds, ["split-core-stop"]);
});

test("pre-runner close rejects unsafe known-stop IDs and reconciliation rejects foreign orders", async () => {
  const split = fullSplitStops();
  const originalStop = {
    ...split.core,
    orderId: "original-attached-stop",
    origQty: "0.1",
    stopPrice: "95",
  };
  const coreStop = split.core;
  const position = {
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: "0.1",
    avgPrice: "100",
    positionId: "position-1",
  };
  const orders = [originalStop, coreStop];
  const { api, broker, calls } = apiFixture({
    positions: [position],
    orders,
    history: [originalStop, coreStop],
    ambiguousPreRunnerClose: true,
  });
  const request = preRunnerSplitCloseRequest({
    core: { ...coreStop, orderId: "split-core-stop" },
  });
  const duplicateStopRequest = {
    ...request,
    coreStop: { ...request.coreStop, orderId: request.originalStop.orderId },
  };
  await assert.rejects(
    broker.performIntent({
      clientOrderId: "worker-pre-runner-duplicate-stop",
      phase: "close_pre_runner_split",
      request: duplicateStopRequest,
    }),
    /bingx_vst_pre_runner_split_close_request_invalid/,
  );
  assert.equal(calls.filter(([name]) => name === "closePreRunnerSplit").length, 0);

  const unsafeAdapter = apiFixture();
  unsafeAdapter.api.closeVstAutomatedPreRunnerSplit = async () => ({
    verified: true,
    flat: true,
    remainingKnownStopOrderIds: ["external-stop-id"],
  });
  await assert.rejects(
    unsafeAdapter.broker.performIntent({
      clientOrderId: "worker-pre-runner-unsafe-adapter-id",
      phase: "close_pre_runner_split",
      request,
    }),
    /bingx_vst_pre_runner_split_close_adapter_result_unverified/,
  );
  assert.equal(unsafeAdapter.calls.some(([name]) => name === "close"), false);

  await assert.rejects(
    broker.performIntent({
      clientOrderId: "worker-close-pre-runner-foreign-order",
      phase: "close_pre_runner_split",
      request,
    }),
    /simulated_lost_pre_runner_close_acknowledgement/,
  );
  const originalGetOrders = api.getOpenOrders;
  api.getOpenOrders = async (symbol) => [
    ...(await originalGetOrders(symbol)),
    {
      symbol: "BTC-USDT",
      orderId: "foreign-open-order",
      type: "LIMIT",
      status: "NEW",
      side: "BUY",
    },
  ];
  const evidence = await createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    stopBufferRate: 0.005,
  }).reconcileIntent({
    clientOrderId: "worker-close-pre-runner-foreign-order",
    phase: "close_pre_runner_split",
    request,
  });
  assert.deepEqual(evidence, { verified: false, status: "unknown" });
  assert.equal(calls.filter(([name]) => name === "closePreRunnerSplit").length, 1);
});

test("full split close is fully cleaned only when no known stops remain", async () => {
  const stops = fullSplitStops();
  const position = {
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: "0.1",
    avgPrice: "100",
    positionId: "position-1",
  };
  const { api, broker, calls } = apiFixture({
    positions: [position],
    orders: [stops.core, stops.runner],
    history: [stops.core, stops.runner],
    fullSplitRemainingIds: [],
  });
  const request = closeSplitAllRequest(stops);
  await broker.performIntent({
    clientOrderId: "worker-close-split-all-clean",
    phase: "close_split_all",
    request,
  });
  const mutationCount = calls.filter(([name]) => name === "closeSplitAll").length;
  const evidence = await createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    stopBufferRate: 0.005,
  }).reconcileIntent({
    clientOrderId: "worker-close-split-all-clean",
    phase: "close_split_all",
    request,
  });
  assert.equal(evidence.verified, true);
  assert.deepEqual(evidence.remainingKnownStopOrderIds, []);
  assert.equal(evidence.fullyCleaned, true);
  assert.equal(calls.filter(([name]) => name === "closeSplitAll").length, mutationCount);
});

test("full split close and flat-stop cleanup remain unknown on foreign orders", async () => {
  const stops = fullSplitStops();
  const position = {
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: "0.1",
    avgPrice: "100",
    positionId: "position-1",
  };
  const { api, broker, calls } = apiFixture({
    positions: [position],
    orders: [stops.core, stops.runner],
    history: [stops.core, stops.runner],
  });
  const closeRequest = closeSplitAllRequest(stops);
  await broker.performIntent({
    clientOrderId: "worker-close-split-foreign",
    phase: "close_split_all",
    request: closeRequest,
  });
  const closeCount = calls.filter(([name]) => name === "closeSplitAll").length;
  const originalGetOrders = api.getOpenOrders;
  api.getOpenOrders = async (symbol) => [
    ...(await originalGetOrders(symbol)),
    {
      symbol: "BTC-USDT",
      orderId: "foreign-open-order",
      type: "LIMIT",
      status: "NEW",
      side: "BUY",
    },
  ];
  const closeEvidence = await createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    stopBufferRate: 0.005,
  }).reconcileIntent({
    clientOrderId: "worker-close-split-foreign",
    phase: "close_split_all",
    request: closeRequest,
  });
  assert.deepEqual(closeEvidence, { verified: false, status: "unknown" });
  assert.equal(calls.filter(([name]) => name === "closeSplitAll").length, closeCount);

  api.getOpenOrders = originalGetOrders;
  const cleanupRequest = {
    operation: "cancel_flat_split_stop",
    environment: "vst",
    accountId: "test-vst-account",
    intentCreatedAt: now,
    symbol: "BTCUSDT",
    positionId: "position-1",
    stopToCancel: {
      tranche: "runner",
      orderId: stops.runner.orderId,
      quantity: "0.02",
      stopPrice: "100",
    },
    knownRemainingStopOrderIds: [stops.runner.orderId],
    cancellationIntentId: "durable-flat-runner-cleanup-foreign",
  };
  await broker.performIntent({
    clientOrderId: "worker-clean-flat-runner-foreign",
    phase: "cancel_flat_split_stop",
    request: cleanupRequest,
  });
  const cleanupCount = calls.filter(
    ([name]) => name === "cancelFlatSplitStop",
  ).length;
  api.getOpenOrders = async (symbol) => [
    ...(await originalGetOrders(symbol)),
    {
      symbol: "BTC-USDT",
      orderId: "foreign-open-order",
      type: "LIMIT",
      status: "NEW",
      side: "BUY",
    },
  ];
  const cleanupEvidence = await createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    stopBufferRate: 0.005,
  }).reconcileIntent({
    clientOrderId: "worker-clean-flat-runner-foreign",
    phase: "cancel_flat_split_stop",
    request: cleanupRequest,
  });
  assert.deepEqual(cleanupEvidence, { verified: false, status: "unknown" });
  assert.equal(calls.filter(([name]) => name === "cancelFlatSplitStop").length,
    cleanupCount);
});

function originalStopRefusalRunnerFillFixture({ clock = () => now } = {}) {
  const positionId = "position-1";
  const entryOrderId = "entry-order-1";
  const originalStopId = "original-signal-stop";
  const coreStopId = "split-core-stop";
  const runnerStopId = "split-runner-stop";
  const runnerChildId = "split-runner-child";
  const positions = [{
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: "0.08",
    avgPrice: "100",
    positionId,
  }];
  const executionZero = {
    executedQty: "0",
    cumExecQty: "0",
  };
  const orders = [
    {
      symbol: "BTC-USDT",
      orderId: originalStopId,
      type: "STOP_MARKET",
      status: "NEW",
      side: "SELL",
      positionSide: "LONG",
      positionId,
      origQty: "0.08",
      stopPrice: "95",
      workingType: "MARK_PRICE",
      mainOrderId: entryOrderId,
      ...executionZero,
    },
    {
      symbol: "BTC-USDT",
      orderId: coreStopId,
      type: "STOP_MARKET",
      status: "NEW",
      side: "SELL",
      positionSide: "LONG",
      positionId,
      origQty: "0.08",
      stopPrice: "95",
      workingType: "MARK_PRICE",
      mainOrderId: entryOrderId,
      ...executionZero,
    },
  ];
  const queriedOrders = {
    [runnerStopId]: {
      symbol: "BTC-USDT",
      orderId: runnerChildId,
      type: "STOP_MARKET",
      status: "FILLED",
      side: "SELL",
      positionSide: "LONG",
      positionId,
      origQty: "0.02",
      executedQty: "0.02",
      stopPrice: "100",
      workingType: "MARK_PRICE",
      parentOrderId: runnerStopId,
    },
  };
  const fill = {
    symbol: "BTC-USDT",
    orderId: runnerChildId,
    triggerOrderId: runnerStopId,
    side: "SELL",
    positionSide: "LONG",
    volume: "0.02",
    price: "100",
    commission: "0.0001",
    commissionAsset: "VST",
    filledTm: now - 500,
  };
  const recoveryFills = [fill];
  const history = [{
    symbol: "BTC-USDT",
    orderId: runnerChildId,
    triggerOrderId: runnerStopId,
    type: "STOP_MARKET",
    status: "FILLED",
    side: "SELL",
    positionSide: "LONG",
    positionId,
    origQty: "0.02",
    executedQty: "0.02",
    stopPrice: "100",
    workingType: "MARK_PRICE",
    time: now - 500,
  }];
  const { api, broker, calls } = apiFixture({
    positions,
    orders,
    queriedOrders,
    fills: recoveryFills,
    history,
    filterFillsByTime: true,
    clock,
  });
  const coreStop = {
    tranche: "core",
    orderId: coreStopId,
    quantity: "0.08",
    stopPrice: "95",
  };
  const runnerStop = {
    tranche: "runner",
    orderId: runnerStopId,
    quantity: "0.02",
    stopPrice: "100",
  };
  const request = {
    ...impulseSplitRequest({
      operation: "cancel_original_stop",
      baselineOpenOrderIds: [originalStopId, coreStopId, runnerStopId],
      coreStop,
      runnerStop,
    }),
    intentCreatedAt: now - 1_000,
  };
  const persistedPosition = {
    status: "closing",
    sourceSignalId: "signal-impulse-1",
    environment: "vst",
    accountId: "test-vst-account",
    symbol: "BTCUSDT",
    positionId,
    quantity: "0.1",
    split: {
      stage: "cancel_original_pending",
      positionId,
      originalStopOrderId: originalStopId,
      entryOrderId,
      totalQuantity: "0.1",
      coreQuantity: "0.08",
      runnerQuantity: "0.02",
      signalStopPrice: "95",
      breakEvenPrice: "100",
      actualEntryBreakEvenPrice: "100",
      coreStop,
      runnerStop,
      baselineOpenOrderIds: [originalStopId, coreStopId, runnerStopId],
    },
  };
  return {
    api, broker, calls, positions, orders, queriedOrders, fills: recoveryFills, history,
    request, persistedPosition, originalStopId, coreStopId, runnerStopId,
    runnerChildId,
  };
}

function paceRunnerRecoveryFixture(fixture, clockState, { afterRequest } = {}) {
  const requestStarts = [];
  const sleepDurations = [];
  const readMethods = new Set([
    "queryOrder", "queryOrderHistory", "queryFills",
    "getPositions", "getOpenOrders", "contract",
    "getPositionMode", "getMarginType", "getLeverage",
  ]);
  const pacer = createBingXOutboundPacer({
    gapMs: 1_100,
    clock: () => clockState.value,
    sleep: async (duration) => {
      sleepDurations.push(duration);
      clockState.value += duration;
    },
  });
  const api = new Proxy(fixture.api, {
    get(target, property) {
      const method = target[property];
      if (typeof method !== "function") return method;
      if (!readMethods.has(property)) return method.bind(target);
      return async (...args) => {
        const startedAt = await pacer.waitForSlot();
        const event = { method: String(property), args, startedAt };
        requestStarts.push(event);
        const result = await method.apply(target, args);
        clockState.value += 5;
        await afterRequest?.(event, clockState);
        event.finishedAt = clockState.value;
        return result;
      };
    },
  });
  fixture.broker = createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => clockState.value,
    sleep: async () => {},
    stopBufferRate: 0.005,
  });
  return { ...fixture, clockState, requestStarts, sleepDurations };
}

function runRunnerRecovery(fixture, kind) {
  const helper = kind === "sent"
    ? fixture.broker.readSentOriginalStopCancellationRunnerFillEvidence
    : fixture.broker.readOriginalStopRefusalRunnerFillEvidence;
  return helper({
    clientOrderId: "worker-cancel-original",
    request: fixture.request,
    persistedPosition: fixture.persistedPosition,
  });
}

function makePacedRunnerRecoveryFixture(kind, { afterRequest } = {}) {
  const clockState = { value: now };
  const clock = () => clockState.value;
  const fixture = kind === "sent"
    ? sentOriginalStopCancellationRunnerFillFixture({ clock })
    : originalStopRefusalRunnerFillFixture({ clock });
  return paceRunnerRecoveryFixture(fixture, clockState, { afterRequest });
}

test("read-only original-stop refusal recovery proves an exact runner fill and 80% residual", async () => {
  const fixture = originalStopRefusalRunnerFillFixture();
  const evidence = await fixture.broker.readOriginalStopRefusalRunnerFillEvidence({
    clientOrderId: "worker-cancel-original",
    request: fixture.request,
    persistedPosition: fixture.persistedPosition,
  });
  assert.equal(evidence.verified, true);
  assert.equal(evidence.outcome, "confirmed_original_stop_cancel_runner_fill");
  assert.equal(evidence.runnerFillRecovery, true);
  assert.equal(evidence.requestStartedAtMs, now);
  assert.equal(Object.hasOwn(evidence, "openStops"), false,
    "the worker must not require a field omitted by the broker contract");
  assert.equal(Number.isSafeInteger(evidence.requestStartedAtMs), true);
  assert.equal(evidence.position.verified, true);
  assert.equal(typeof evidence.position.quantity, "number");
  assert.equal(evidence.position.quantity, 0.08);
  assert.equal(evidence.position.positionId, "position-1");
  assert.equal(evidence.originalStop.orderId, fixture.originalStopId);
  assert.equal(evidence.originalStop.status, "NEW");
  assert.deepEqual(evidence.originalStop.executionProof, {
    orderId: fixture.originalStopId,
    executedQty: "0",
    cumExecQty: "0",
  });
  assert.equal(typeof evidence.originalStop.origQty, "string");
  assert.equal(typeof evidence.coreStop.origQty, "string");
  assert.equal(typeof evidence.runnerStop.origQty, "string");
  assert.equal(typeof evidence.runnerStop.executedQty, "string");
  assert.equal(evidence.coreStop.orderId, fixture.coreStopId);
  assert.equal(evidence.runnerStop.orderId, fixture.runnerStopId);
  assert.equal(evidence.runnerStop.childOrderId, fixture.runnerChildId);
  assert.equal(evidence.runnerStop.status, "FILLED");
  assert.deepEqual(evidence.fill, {
    orderId: fixture.runnerChildId,
    triggerOrderId: fixture.runnerStopId,
    quantity: "0.02",
    price: "100",
    fee: { asset: "VST", amount: "0.0001" },
    at: new Date(now - 500).toISOString(),
  });
  assert.equal(typeof evidence.fill.quantity, "string");
  assert.equal(typeof evidence.fill.price, "string");
  assert.equal(typeof evidence.fill.fee.amount, "string");
  assert.equal(typeof evidence.fill.at, "string");
  assert.equal(fixture.calls.some(([name]) =>
    ["entry", "splitStop", "splitRaisePlace", "splitRaiseCancel",
      "cancelOriginal", "close", "closeSplitAll"].includes(name)), false);
});

test("original-stop runner recovery corroborates native zero-position queries and ignores an untriggered entry", async () => {
  const fixture = originalStopRefusalRunnerFillFixture();
  for (const row of fixture.orders) {
    fixture.queriedOrders[row.orderId] = { ...row, positionId: 0 };
  }
  fixture.fills.unshift({
    symbol: "BTC-USDT", orderId: "entry-order-1", triggerOrderId: 0,
    type: "MARKET", side: "BUY", positionSide: "LONG", volume: "0.1",
    price: "100", commission: "-0.001", currency: "USDT",
    filledTm: now - 900,
  });
  const runnerFill = fixture.fills[1];
  runnerFill.commission = "-0.0001";
  delete runnerFill.commissionAsset;
  runnerFill.currency = "USDT";
  for (const row of [fixture.queriedOrders[fixture.runnerStopId], fixture.history[0]]) {
    row.positionId = 0;
  }
  const evidence = await runRunnerRecovery(fixture, "refusal");
  assert.equal(evidence.verified, true);
  assert.equal(evidence.position.quantity, 0.08);
  assert.equal(evidence.fill.orderId, fixture.runnerChildId);
  assert.deepEqual(evidence.fill.fee, { asset: "USDT", amount: "-0.0001" });
  assert.equal(evidence.originalStop.origQty, "0.08");
  assert.equal(fixture.calls.some(([name]) =>
    ["cancelOriginal", "close", "entry", "splitStop"].includes(name)), false);
});

test("native runner recovery refuses uncorroborated identities and malformed trigger sentinels", async () => {
  for (const mutate of [
    (fixture) => { fixture.queriedOrders[fixture.originalStopId] = {
      ...fixture.orders[0], positionId: 0, stopPrice: "94",
    }; },
    (fixture) => { fixture.queriedOrders[fixture.coreStopId] = {
      ...fixture.orders[1], positionId: 0, executedQty: "0.001",
    }; },
    (fixture) => { fixture.queriedOrders[fixture.originalStopId] = {
      ...fixture.orders[0], positionId: 0, positionID: "foreign-position",
    }; },
    (fixture) => { fixture.fills.unshift({
      symbol: "BTC-USDT", orderId: "entry-order-1", triggerOrderId: 0,
      triggerOrderID: fixture.runnerStopId, type: "MARKET",
      side: "BUY", positionSide: "LONG",
    }); },
    (fixture) => { fixture.fills[0].triggerOrderId = 0; },
    (fixture) => { fixture.fills[0].triggerOrderId = 123; },
    (fixture) => { fixture.orders.push({ ...fixture.orders[0] }); },
  ]) {
    const fixture = originalStopRefusalRunnerFillFixture();
    mutate(fixture);
    const evidence = await runRunnerRecovery(fixture, "refusal");
    assert.equal(evidence.verified, false);
    assert.equal(evidence.status, "unknown");
    assert.equal(fixture.calls.some(([name]) =>
      ["cancelOriginal", "close", "entry", "splitStop"].includes(name)), false);
  }
});

test("read-only original-stop refusal recovery rejects ambiguous fill and stop proofs", async () => {
  const invalidEvidenceCases = [
    ["wrong fill quantity", ({ fills }) => { fills[0].volume = "0.01"; }],
    ["unlinked fill", ({ fills, runnerStopId }) => {
      fills[0].triggerOrderId = `${runnerStopId}-other`;
    }],
    ["missing fill fee", ({ fills }) => { delete fills[0].commission; }],
    ["duplicate child history", ({ history }) => { history.push({ ...history[0] }); }],
    ["nonzero original execution", ({ orders }) => {
      orders[0].cumExecQty = "0.001";
    }],
    ["missing core execution proof", ({ orders }) => {
      delete orders[1].executedQty;
      delete orders[1].cumExecQty;
    }],
  ];
  for (const [label, mutate] of invalidEvidenceCases) {
    const fixture = originalStopRefusalRunnerFillFixture();
    mutate(fixture);
    const evidence = await fixture.broker.readOriginalStopRefusalRunnerFillEvidence({
      clientOrderId: "worker-cancel-original",
      request: fixture.request,
      persistedPosition: fixture.persistedPosition,
    });
    assert.equal(evidence.verified, false, label);
    assert.equal(evidence.status, "unknown", label);
    assert.equal(fixture.calls.some(([name]) =>
      ["entry", "splitStop", "splitRaisePlace", "splitRaiseCancel",
        "cancelOriginal", "close", "closeSplitAll"].includes(name)), false, label);
  }
});

function sentOriginalStopCancellationRunnerFillFixture({
  clock = () => now,
  originalStopQuantity = "0.1",
  originalStopQuantityAlias,
} = {}) {
  const fixture = originalStopRefusalRunnerFillFixture({ clock });
  fixture.orders.splice(0, 1);
  const canceledOriginal = {
    symbol: "BTC-USDT",
    orderId: fixture.originalStopId,
    type: "STOP_MARKET",
    status: "CANCELED",
    side: "SELL",
    positionSide: "LONG",
    positionId: "position-1",
    origQty: originalStopQuantity,
    ...(originalStopQuantityAlias === undefined
      ? {} : { quantity: originalStopQuantityAlias }),
    stopPrice: "95",
    workingType: "MARK_PRICE",
    mainOrderId: "entry-order-1",
    executedQty: "0",
    cumExecQty: "0",
    time: now - 500,
  };
  fixture.queriedOrders[fixture.originalStopId] = { ...canceledOriginal };
  fixture.history.push({ ...canceledOriginal });
  return fixture;
}

test("read-only sent original-stop cancellation recovery proves canceled original and runner fill", async () => {
  const fixture = sentOriginalStopCancellationRunnerFillFixture();
  const evidence =
    await fixture.broker.readSentOriginalStopCancellationRunnerFillEvidence({
      clientOrderId: "worker-cancel-original",
      request: fixture.request,
      persistedPosition: fixture.persistedPosition,
    });
  assert.equal(evidence.verified, true);
  assert.equal(evidence.outcome,
    "confirmed_sent_original_stop_cancel_runner_fill");
  assert.equal(evidence.originalCancellationConfirmed, true);
  assert.equal(evidence.runnerFillRecovery, true);
  assert.equal(evidence.requestStartedAtMs, now);
  assert.equal(evidence.originalStop.status, "CANCELED");
  assert.equal(evidence.originalStop.orderId, fixture.originalStopId);
  assert.equal(evidence.originalStop.origQty, "0.1");
  assert.equal(evidence.originalStopQuantityBasis, "entry_total");
  assert.deepEqual(evidence.originalStop.executionProof, {
    orderId: fixture.originalStopId,
    executedQty: "0",
    cumExecQty: "0",
  });
  assert.equal(evidence.position.verified, true);
  assert.equal(evidence.position.quantity, 0.08);
  assert.equal(evidence.coreStop.orderId, fixture.coreStopId);
  assert.equal(evidence.runnerStop.orderId, fixture.runnerStopId);
  assert.equal(evidence.runnerStop.childOrderId, fixture.runnerChildId);
  assert.equal(evidence.fill.orderId, fixture.runnerChildId);
  assert.equal(evidence.fill.triggerOrderId, fixture.runnerStopId);
  assert.deepEqual(
    await fixture.broker.readOriginalStopRefusalRunnerFillEvidence({
      clientOrderId: "worker-cancel-original",
      request: fixture.request,
      persistedPosition: fixture.persistedPosition,
    }),
    { verified: false, status: "unknown" },
    "the distinct sent-DELETE proof must not loosen the strict no-send proof",
  );
  assert.equal(fixture.calls.some(([name]) =>
    ["entry", "splitStop", "splitRaisePlace", "splitRaiseCancel",
      "cancelOriginal", "close", "closeSplitAll"].includes(name)), false);
});

test("sent original-stop cancellation accepts the corroborated 80% resized history basis", async () => {
  const fixture = sentOriginalStopCancellationRunnerFillFixture({
    originalStopQuantity: "0.08",
    originalStopQuantityAlias: "0.08",
  });
  const evidence =
    await fixture.broker.readSentOriginalStopCancellationRunnerFillEvidence({
      clientOrderId: "worker-cancel-original",
      request: fixture.request,
      persistedPosition: fixture.persistedPosition,
    });
  assert.equal(evidence.verified, true);
  assert.equal(evidence.outcome,
    "confirmed_sent_original_stop_cancel_runner_fill");
  assert.equal(evidence.originalStopQuantityBasis, "post_runner_residual");
  assert.equal(evidence.originalStop.origQty, "0.08");
  assert.equal(evidence.originalStop.quantity, "0.08");
  assert.equal(evidence.position.quantity, 0.08);
  assert.equal(evidence.coreStop.orderId, fixture.coreStopId);
});

test("sent original-stop cancellation runner-fill recovery fails closed on noncanonical evidence", async () => {
  const invalidEvidenceCases = [
    ["original still NEW", (fixture) => {
      fixture.queriedOrders[fixture.originalStopId].status = "NEW";
      fixture.history.at(-1).status = "NEW";
    }],
    ["original executed nonzero", (fixture) => {
      fixture.queriedOrders[fixture.originalStopId].executedQty = "0.001";
      fixture.history.at(-1).executedQty = "0.001";
    }],
    ["wrong 40% original quantity", (fixture) => {
      fixture.queriedOrders[fixture.originalStopId].origQty = "0.04";
      fixture.queriedOrders[fixture.originalStopId].quantity = "0.04";
      fixture.history.at(-1).origQty = "0.04";
      fixture.history.at(-1).quantity = "0.04";
    }],
    ["contradictory original quantity aliases", (fixture) => {
      fixture.queriedOrders[fixture.originalStopId].quantity = "0.08";
      fixture.history.at(-1).quantity = "0.08";
    }],
    ["query and history quantity bases disagree", (fixture) => {
      fixture.history.at(-1).origQty = "0.08";
      fixture.history.at(-1).quantity = "0.08";
    }],
    ["missing original cancellation history", (fixture) => {
      fixture.history.pop();
    }],
    ["extra original remains active", (fixture) => {
      fixture.orders.push({ ...fixture.history.at(-1), status: "NEW" });
    }],
    ["position became flat", (fixture) => {
      fixture.positions[0].positionAmt = "0";
    }],
    ["runner fill missing fee", (fixture) => {
      delete fixture.fills[0].commission;
    }],
    ["unlinked runner fill", (fixture) => {
      fixture.fills[0].triggerOrderId = "other-runner-stop";
    }],
  ];
  for (const [label, mutate] of invalidEvidenceCases) {
    const fixture = sentOriginalStopCancellationRunnerFillFixture();
    mutate(fixture);
    const evidence =
      await fixture.broker.readSentOriginalStopCancellationRunnerFillEvidence({
        clientOrderId: "worker-cancel-original",
        request: fixture.request,
        persistedPosition: fixture.persistedPosition,
      });
    assert.equal(evidence.verified, false, label);
    assert.equal(evidence.status, "unknown", label);
    assert.equal(fixture.calls.some(([name]) =>
      ["entry", "splitStop", "splitRaisePlace", "splitRaiseCancel",
        "cancelOriginal", "close", "closeSplitAll"].includes(name)), false, label);
  }
});

test("both runner-fill readers accept paced history beyond two seconds and anchor the final account pair", async () => {
  for (const kind of ["no-send", "sent"]) {
    const fixture = makePacedRunnerRecoveryFixture(kind);
    const evidence = await runRunnerRecovery(fixture, kind);
    assert.equal(evidence.verified, true, kind);
    assert.equal(evidence.requestStartedAtMs > now + 2_000, true, kind);
    assert.equal(evidence.requestStartedAtMs - now <= 30_000, true, kind);

    const historyReads = fixture.requestStarts.filter((event) =>
      ["queryOrder", "queryOrderHistory", "queryFills"].includes(event.method));
    assert.ok(historyReads.length >= 3, `${kind}: historical reads were paced`);
    const latestHistoryCompletion = Math.max(...historyReads.map((event) =>
      event.finishedAt));
    assert.ok(evidence.requestStartedAtMs >= latestHistoryCompletion,
      `${kind}: account-pair timestamp follows history verification`);

    const finalPair = fixture.requestStarts.filter((event) =>
      ["getPositions", "getOpenOrders"].includes(event.method) &&
      event.args.length === 0);
    assert.equal(finalPair.length, 2, `${kind}: final global account pair observed`);
    assert.deepEqual(fixture.requestStarts.slice(-2), finalPair,
      `${kind}: no exchange read follows the final account pair`);
    const finalPairStartedAt = Math.min(...finalPair.map((event) =>
      event.startedAt));
    const finalPairCompletedAt = Math.max(...finalPair.map((event) =>
      event.finishedAt));
    assert.ok(finalPairStartedAt >= evidence.requestStartedAtMs,
      `${kind}: requestStartedAtMs anchors the final fresh account pair`);
    assert.equal(finalPairCompletedAt - evidence.requestStartedAtMs, 2_200,
      `${kind}: paced final account pair completion age`);
    assert.ok(finalPairCompletedAt - evidence.requestStartedAtMs <= 5_000,
      `${kind}: final account pair itself remains within the CAS age budget`);
    const gaps = fixture.requestStarts.slice(1).map((event, index) =>
      event.startedAt - fixture.requestStarts[index].startedAt);
    assert.ok(gaps.every((gap) => gap >= 1_100),
      `${kind}: every mocked exchange GET uses the real VST pacer gap`);
    assert.equal(fixture.requestStarts.length, 16,
      `${kind}: expected number of paced read calls`);
    assert.equal(fixture.clockState.value - evidence.requestStartedAtMs, 2_200,
      `${kind}: normal paced completion is consumable by the worker/store 5s CAS`);
    assert.equal(fixture.calls.some(([name]) =>
      ["entry", "splitStop", "splitRaisePlace", "splitRaiseCancel",
        "cancelOriginal", "close", "closeSplitAll"].includes(name)), false);
  }
});

test("both runner-fill readers defer history proofs over 30 seconds or on a backward clock", async () => {
  for (const kind of ["no-send", "sent"]) {
    const tooOld = makePacedRunnerRecoveryFixture(kind, {
      afterRequest: (event, clockState) => {
        if (event.method === "queryOrderHistory") {
          clockState.value = now + 30_001;
        }
      },
    });
    const expiredEvidence = await runRunnerRecovery(tooOld, kind);
    assert.equal(expiredEvidence.verified, false, `${kind}: stale history`);
    assert.equal(expiredEvidence.status, "unknown", `${kind}: stale history`);
    assert.equal(tooOld.requestStarts.some((event) =>
      ["getPositions", "getOpenOrders"].includes(event.method) &&
      event.args.length === 0), false,
    `${kind}: expired history is rejected before the final account pair`);
    assert.equal(tooOld.calls.some(([name]) =>
      ["entry", "splitStop", "splitRaisePlace", "splitRaiseCancel",
        "cancelOriginal", "close", "closeSplitAll"].includes(name)), false,
    `${kind}: stale history performs no mutation`);

    let scopedOpenOrderReads = 0;
    const backwards = makePacedRunnerRecoveryFixture(kind, {
      afterRequest: (event, clockState) => {
        if (event.method === "getOpenOrders" &&
            event.args[0] === "BTCUSDT") {
          scopedOpenOrderReads += 1;
          if (scopedOpenOrderReads === (kind === "sent" ? 2 : 3)) {
            clockState.value = now - 1;
          }
        }
      },
    });
    const backwardsEvidence = await runRunnerRecovery(backwards, kind);
    assert.equal(backwardsEvidence.verified, false, `${kind}: backward clock`);
    assert.equal(backwardsEvidence.status, "unknown", `${kind}: backward clock`);
    assert.equal(backwards.requestStarts.some((event) =>
      ["getPositions", "getOpenOrders"].includes(event.method) &&
      event.args.length === 0), false,
    `${kind}: backward clock is rejected before the final account pair`);
    assert.equal(backwards.calls.some(([name]) =>
      ["entry", "splitStop", "splitRaisePlace", "splitRaiseCancel",
        "cancelOriginal", "close", "closeSplitAll"].includes(name)), false,
    `${kind}: backward clock performs no mutation`);
  }
});

test("both runner-fill readers defer when the final account pair takes over five seconds", async () => {
  for (const kind of ["no-send", "sent"]) {
    const fixture = makePacedRunnerRecoveryFixture(kind, {
      afterRequest: (event, clockState) => {
        if (event.method === "getOpenOrders" && event.args.length === 0) {
          clockState.value += 5_001;
        }
      },
    });
    const evidence = await runRunnerRecovery(fixture, kind);
    assert.deepEqual(evidence, { verified: false, status: "unknown" }, kind);
    assert.deepEqual(fixture.requestStarts.slice(-2).map((event) =>
      event.method).sort(), ["getOpenOrders", "getPositions"], kind);
    assert.equal(fixture.calls.some(([name]) =>
      ["entry", "splitStop", "splitRaisePlace", "splitRaiseCancel",
        "cancelOriginal", "close", "closeSplitAll"].includes(name)), false, kind);
  }
});