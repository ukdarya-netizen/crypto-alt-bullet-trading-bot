import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createStopTransferJournal } from "../stop-transfer-journal.mjs";
import {
  createBingXLiveApi,
  createBingXOutboundPacer,
  isDefiniteExchangeRejection,
  VST_AUTOMATED_LONG_POLICY,
  VST_BTC_HEDGE_LONG10_SHORT75_PROBE,
} from "../bingx-live-api.mjs";
import { sizeVstLongTrade } from "../vst-sizing.mjs";
import { createVstBroker } from "../vst-broker.mjs";
import { createVstWorker } from "../vst-worker.mjs";
import { createVstEndpointPacer } from "../vst-endpoint-pacer.mjs";

const orderPath = "/openApi/swap/v2/trade/order";
const leveragePath = "/openApi/swap/v2/trade/leverage";
const validSignalAt = "2023-11-14T22:13:20.000Z";

function freshEntryAttempt(extra = {}) {
  return {
    symbol: "DOGEUSDT", signalAt: validSignalAt, quantity: "1",
    maxPrice: "100.0", stopLoss: "98.0", clientOrderId: "fresh_sizing_test",
    refreshSizing: {
      maxSlippageBps: 20, maxQuoteAgeMs: 10000,
      expectedPrice: "100", quantityUnitMultiple: 1,
    },
    ...extra,
  };
}

function endpointPacedFixture(options = {}) {
  const timeState = { now: 1700000000000 };
  return fixture({
    ...options,
    timeState,
    requestPacer: createVstEndpointPacer({
      clock: () => timeState.now,
      sleep: async (ms) => { timeState.now += ms; },
    }),
  });
}

test("endpoint-paced native entry retains the attached exact stop and one-shot transport", async () => {
  for (const failEntryPost of [false, true]) {
    const f = endpointPacedFixture({
      symbol: "DOGE-USDT", dualSidePosition: true,
      longLeverage: 10, shortLeverage: 3, failEntryPost,
    });
    const request = freshEntryAttempt({ onReprice: async () => {} });
    if (failEntryPost) await assert.rejects(f.api.placeVstAutomatedLong(request), /request failed/);
    else await f.api.placeVstAutomatedLong(request);
    await assert.rejects(f.api.placeVstAutomatedLong(request), /already submitted/);
    const writes = f.calls.filter(({ url, options }) =>
      url.pathname === orderPath && options.method === "POST");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].url.searchParams.get("type"), "MARKET");
    assert.deepEqual(JSON.parse(writes[0].url.searchParams.get("stopLoss")), {
      type: "STOP_MARKET", stopPrice: 98,
    });
  }
});

test("endpoint-paced margin addition still checks protection before and after its single POST", async () => {
  const position = {
    symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
    positionId: "position-margin", isolatedMargin: "10",
  };
  const stop = {
    symbol: "BTC-USDT", orderId: "margin-stop", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "position-margin",
    mainOrderId: "entry-margin", origQty: "0.1", stopPrice: "90.0",
    workingType: "MARK_PRICE",
  };
  const f = endpointPacedFixture({
    dualSidePosition: true, longLeverage: 10, shortLeverage: 7,
    positions: [position], orders: [stop],
  });
  const request = {
    symbol: "BTCUSDT", amount: "2.5", quantity: "0.1",
    positionId: "position-margin", entryOrderId: "entry-margin", stopLoss: "90.0",
    clientOperationId: "paced-margin-1",
  };
  const result = await f.api.addVstIsolatedLongMargin(request);
  assert.equal(result.submitted, true);
  assert.equal(result.verified, false, "a POST acknowledgement is not confirmed funding");
  assert.equal(result.protectiveStop.orderId, "margin-stop");
  await assert.rejects(f.api.addVstIsolatedLongMargin(request), /already submitted/);
  const posts = f.calls.filter(({ url, options }) =>
    url.pathname.endsWith("/positionMargin") && options.method === "POST");
  assert.equal(posts.length, 1);
  assert.ok(f.calls.some(({ url, options, startedAt }) =>
    url.pathname.endsWith("/openOrders") && options.method === "GET" &&
    startedAt < posts[0].startedAt));
  assert.ok(f.calls.some(({ url, options, startedAt }) =>
    url.pathname.endsWith("/openOrders") && options.method === "GET" &&
    startedAt > posts[0].startedAt));
});

test("a VST entry requests priority only after fresh checks and persists sizing before transport", async () => {
  const slots = [];
  const measurements = [];
  let repriced = false;
  const f = fixture({
    symbol: "DOGE-USDT", dualSidePosition: true, longLeverage: 10, shortLeverage: 3,
    requestPacer: {
      deferFor() {},
      async waitForSlot(options) {
        slots.push(options);
        if (options?.priority) assert.equal(repriced, true);
      },
    },
  });
  await f.api.placeVstAutomatedLong(freshEntryAttempt({
    onReprice: async () => { repriced = true; },
    onEntryTiming: (detail) => { measurements.push(detail); },
  }));
  assert.deepEqual(measurements.map((d) => d.boundary), ["started", "transport_started"]);
  assert.equal(measurements[1].version, "entry-latency-v1");
  assert.ok(measurements[1].transportStartedAtMs >= measurements[1].checksCompletedAtMs);
  assert.equal(slots.filter(slot => slot?.priority).length, 1);
  assert.equal(f.calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST").length, 1);
});

test("pacing expiry is a proven no-transport refusal, with no POST or automatic resubmission", async () => {
  const measurements = [];
  const time = { now: 1700000000000 };
  const f = fixture({
    symbol: "DOGE-USDT", dualSidePosition: true, longLeverage: 10, shortLeverage: 3,
    timeState: time,
    requestPacer: {
      deferFor() {},
      async waitForSlot(options) {
        if (options?.priority) time.now += 2001;
      },
    },
  });
  let transportCalls = 0;
  const attempt = freshEntryAttempt({
    onReprice: async () => {},
    onTransportReady: async () => { transportCalls++; },
    onEntryTiming: (detail) => { measurements.push(detail); },
  });
  await assert.rejects(f.api.placeVstAutomatedLong(attempt), error => {
    assert.equal(error.transportStage, "pre_transport");
    assert.equal(error.preSignReason, "final_pre_sign_pacing_expired");
    assert.equal(isDefiniteExchangeRejection(error), true);
    return true;
  });
  assert.equal(transportCalls, 0);
  assert.deepEqual(measurements.map((d) => d.boundary), ["started", "refused_before_transport"]);
  assert.equal(measurements[1].preSignReason, "final_pre_sign_pacing_expired");
  assert.equal(measurements[1].refusedAtMs - measurements[1].checksCompletedAtMs, 2001);
  assert.equal(f.calls.some(({ options }) => options.method === "POST"), false);
  await assert.rejects(f.api.placeVstAutomatedLong(attempt), /already submitted/);
});

test("failed or unfinished latency writes never block or repeat the native order", async () => {
  for (const onEntryTiming of [
    () => { throw new Error("telemetry write failed"); },
    () => Promise.reject(new Error("telemetry unavailable")),
    () => new Promise(() => {}),
  ]) {
    const f = fixture({
      symbol: "DOGE-USDT", dualSidePosition: true, longLeverage: 10, shortLeverage: 3,
    });
    await f.api.placeVstAutomatedLong(freshEntryAttempt({
      onReprice: async () => {}, onEntryTiming,
    }));
    assert.equal(f.calls.filter(({ url, options }) =>
      url.pathname === orderPath && options.method === "POST").length, 1);
  }
});

test("native fresh sizing shrinks quantity after drift, persists before POST, and keeps a single risk preflight", async () => {
  const f = fixture({
    symbol: "DOGE-USDT", dualSidePosition: true, longLeverage: 10, shortLeverage: 3,
    ticker: { askPrice: "110", bidPrice: "109.9", time: 1700000000000 },
  });
  let fresh, transport;
  await f.api.placeVstAutomatedLong(freshEntryAttempt({
    onReprice: async (data) => {
      fresh = data.sizing;
      assert.equal(f.calls.some(({ url, options }) =>
        url.pathname === orderPath && options.method === "POST"), false);
    },
    onTransportReady: async (data) => { transport = data; },
  }));
  assert.ok(Number(fresh.quantity) < 1);
  assert.equal(fresh.stopLoss, "98");
  assert.equal(fresh.initialBudgetVst, 10);
  assert.equal(fresh.maxSlippageBps, 20);
  assert.ok(fresh.initialMarginVst <= 10);
  assert.ok(fresh.plannedTopUpVst > 0);
  const post = f.calls.find(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST");
  assert.equal(post.url.searchParams.get("quantity"), fresh.quantity);
  assert.equal(post.url.searchParams.get("type"), "MARKET");
  assert.equal(f.calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/user/commissionRate").length, 1);
  assert.equal(f.calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v1/maintMarginRatio").length, 1);
  assert.ok(transport.sizingAgeAtSubmitMs <= 10000);
});

test("native fresh sizing refuses every persistence failure before the order POST", async () => {
  const f = fixture({
    symbol: "DOGE-USDT", dualSidePosition: true, longLeverage: 10, shortLeverage: 3,
  });
  await assert.rejects(f.api.placeVstAutomatedLong(freshEntryAttempt({
    onReprice: async () => { throw new Error("CAS conflict"); },
  })), (error) => error.preSignReason === "final_sizing_persistence_failed");
  assert.equal(f.calls.some(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST"), false);
});

test("fresh sizing still rejects drift beyond the new 20bps bound after durable reprice", async () => {
  const f = fixture({
    symbol: "DOGE-USDT", dualSidePosition: true, longLeverage: 10, shortLeverage: 3,
    tickerByRead: [
      { askPrice: "110", bidPrice: "109.9", time: 1700000000000 },
      { askPrice: "111", bidPrice: "110.9", time: 1700000000000 },
    ],
  });
  let persisted = false;
  await assert.rejects(f.api.placeVstAutomatedLong(freshEntryAttempt({
    onReprice: async () => { persisted = true; },
  })), (error) => error.preSignReason === "final_quote_out_of_bounds");
  assert.equal(persisted, true);
  assert.equal(f.calls.some(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST"), false);
});

test("fresh sizing does not bypass foreign exposure or a changed short leverage/protection verdict", async () => {
  const f = fixture({
    symbol: "DOGE-USDT", dualSidePosition: true, longLeverage: 10, shortLeverage: 3,
    positions: [{ symbol: "DOGE-USDT", positionAmt: "1", positionSide: "LONG" }],
  });
  let persisted = false;
  await assert.rejects(f.api.placeVstAutomatedLong(freshEntryAttempt({
    onReprice: async () => { persisted = true; },
  })), (error) => error.preSignReason === "final_preflight_blocked");
  assert.equal(persisted, false);
  assert.equal(f.calls.some(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST"), false);
});

test("slow durable persistence cannot turn a fresh calculation into a stale MARKET submission", async () => {
  const time = { now: 1700000000000 };
  const f = fixture({
    symbol: "DOGE-USDT", dualSidePosition: true, longLeverage: 10, shortLeverage: 3,
    timeState: time,
  });
  await assert.rejects(f.api.placeVstAutomatedLong(freshEntryAttempt({
    onReprice: async () => { time.now += 11000; },
  })), (error) => error.preSignReason === "final_quote_unavailable_or_stale");
  assert.equal(f.calls.some(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST"), false);
});
const stopExecutionQuantityFields = [
  "executedQty", "executedQuantity", "cumExecQty", "filledQty",
];

function withActiveStopExecutionProof(order) {
  if (order?.type === "STOP_MARKET" && order.status === "NEW" &&
      !stopExecutionQuantityFields.some((key) => Object.hasOwn(order, key))) {
    return { ...order, executedQty: "0" };
  }
  return order;
}

function fixture({
  environment = "vst",
  permission = true,
  dualSidePosition = false,
  marginType = "ISOLATED",
  positions = [],
  orders = [],
  openOrdersResponse,
  longLeverage = 75,
  shortLeverage = 75,
  maxPositionLongVal = "1000000",
  shortLeverageAfterWrite,
  identifiedOrder,
  ordersById = {},
  fills = [],
  fillResponse,
  rawFillResponseText,
  orderHistory = [],
  orderHistoryResponse,
  failEntryPost = false,
  failStopPostAfterApply = false,
  failMarketPostAfterApply = false,
  failMarginTypePostAfterApply = false,
  failMarginTypePostBeforeApply = false,
  dropClientOrderQueries = false,
  totalVstBalance = "1000",
  balanceByRead = [],
  feeRatesByRead = [],
  fundingRatesByRead = [],
  responseSequences = {},
  responseOverrides = [],
  failReads = [],
  ticker = { askPrice: "100", bidPrice: "99.9", time: 1700000000000 },
  bookTicker,
  tickerByRead = [],
  tickerResponseCode = 0,
  tickerErrorMessage,
  advanceClockOnTickerReadMs = 0,
  advanceClockOnBookReadMs = 0,
  symbol = "BTC-USDT",
  quantityPrecision = 4,
  pricePrecision = 1,
  markSymbol = symbol,
  markPrice = "100",
  markTimestamp = 1700000000000,
  stopPostResponse,
  stopOrderIdOverride,
  stopCreationTime = 1700000000000,
  activeStopQueryTransform,
  duplicateStopOnPost = false,
  includeStopInHistory = false,
  stopPostResponses = [],
  simulateMarketClose = false,
  autoCancelStopsOnMarket = false,
  marketPostResponse = { orderId: "market-close" },
  marketFillRows,
  markPricesByRead = [],
  advanceClockOnSleep = false,
  failDeleteAfterApply = false,
  filterFillsByTime = false,
  redirectPostTo,
  timeState,
  requestPacer,
  random = () => 0,
  onRateLimitDiagnostic,
  normalizeActiveStopExecutionQty = true,
  beforeFetch,
} = {}) {
  const calls = [];
  const time = timeState ?? { now: 1700000000000 };
  let stopPostCount = 0;
  const state = {
    positions: positions.map((row) => ({ ...row })),
    orders: orders.map((row) => normalizeActiveStopExecutionQty
      ? withActiveStopExecutionProof({ ...row }) : { ...row }),
    openOrdersResponse,
    longLeverage,
    shortLeverage,
    maxPositionLongVal,
    shortLeverageAfterWrite,
    marginType,
    marginTypePostCount: 0,
    failMarginTypePostAfterApply,
    failMarginTypePostBeforeApply,
    identifiedOrder: identifiedOrder ?? null,
    ordersById: { ...ordersById },
    fills: fills.map((row) => ({ ...row })),
    fillResponse,
    rawFillResponseText,
    orderHistory: orderHistory.map((row) => ({ ...row })),
    orderHistoryResponse,
    failStopPostAfterApply,
    failMarketPostAfterApply,
    dropClientOrderQueries,
    totalVstBalance,
    balanceByRead,
    feeRatesByRead,
    fundingRatesByRead,
    responseSequences,
    responseOverrides: responseOverrides.map((override) => ({
      ...override, remaining: override.remaining ?? 1,
    })),
    failReads,
    readCounts: new Map(),
    ticker,
    bookTicker,
    tickerByRead,
    symbol,
    markSymbol,
    markPrice,
    markTimestamp,
    stopPostResponse,
    stopOrderIdOverride,
    activeStopQueryTransform,
    stopCreationTime,
    duplicateStopOnPost,
    includeStopInHistory,
    stopPostResponses,
    simulateMarketClose,
    autoCancelStopsOnMarket,
    marketPostResponse,
    marketFillRows,
    markPricesByRead,
    failDeleteAfterApply,
    filterFillsByTime,
  };
  const fetchImpl = async (raw, options) => {
    const url = new URL(raw);
    calls.push({
      url, options, startedAt: time.now,
      ordersAtCall: state.orders.map((order) => ({ ...order })),
      positionsAtCall: state.positions.map((position) => ({ ...position })),
    });
    await beforeFetch?.(url, options, time);
    if (redirectPostTo && url.pathname === orderPath && options.method === "POST" &&
        url.searchParams.get("type") === "STOP_MARKET") {
      if (options.redirect === "error") throw new TypeError("redirect blocked");
      calls.push({
        url: new URL(redirectPostTo),
        options: { ...options, method: "GET" },
      });
      throw new Error("mock followed a redirect");
    }
    assert.equal(url.origin, environment === "vst"
      ? "https://open-api-vst.bingx.com" : "https://open-api.bingx.com");
    const path = url.pathname;
    const occurrence = (state.readCounts.get(path) ?? 0) + 1;
    state.readCounts.set(path, occurrence);
    const shouldFailRead = options.method === "GET" && state.failReads.some((failure) =>
      failure.path === path && failure.occurrence === occurrence);
    let responseCode = shouldFailRead ? 100001 : 0;
    let data = {};
    if (shouldFailRead) {
      data = {};
    } else if (url.pathname === "/openApi/swap/v2/quote/bookTicker") {
      data = { book_ticker: state.bookTicker };
      time.now += advanceClockOnBookReadMs;
    } else if (url.pathname === "/openApi/swap/v2/quote/ticker") {
      time.now += advanceClockOnTickerReadMs;
      responseCode = shouldFailRead ? 100001 : tickerResponseCode;
      data = {
        symbol: state.symbol,
        ...(state.tickerByRead[occurrence - 1] ?? state.ticker),
        ...(advanceClockOnTickerReadMs > 0 ? { time: time.now } : {}),
      };
    } else if (url.pathname === "/openApi/swap/v2/user/positions") {
      data = state.positions;
    } else if (url.pathname === "/openApi/swap/v2/trade/openOrders") {
      data = state.openOrdersResponse === undefined
        ? state.orders : state.openOrdersResponse;
    } else if (url.pathname === "/openApi/swap/v1/positionSide/dual") {
      data = { dualSidePosition };
    } else if (url.pathname === "/openApi/swap/v2/trade/marginType" &&
        options.method === "GET") {
      data = { marginType: state.marginType };
    } else if (url.pathname === "/openApi/swap/v2/trade/marginType" &&
        options.method === "POST") {
      state.marginTypePostCount += 1;
      if (!state.failMarginTypePostBeforeApply) {
        state.marginType = url.searchParams.get("marginType");
      }
      if (state.failMarginTypePostAfterApply) {
        throw new Error("simulated ambiguous margin-type response");
      }
      if (state.failMarginTypePostBeforeApply) {
        throw new Error("simulated ambiguous margin-type response");
      }
    } else if (url.pathname === "/openApi/swap/v3/user/balance") {
      data = state.balanceByRead[occurrence - 1] ?? [{
        asset: environment === "vst" ? "VST" : "USDT",
        balance: state.totalVstBalance, availableMargin: "20",
      }];
    } else if (url.pathname === "/openApi/swap/v2/quote/contracts") {
      data = [{
        symbol: state.symbol, status: 1, currency: "USDT", apiStateOpen: "true",
        quantityPrecision, pricePrecision, tradeMinQuantity: "0.001",
        tradeMinUSDT: "5", maxLongLeverage: "10", maxShortLeverage: "75",
      }];
    } else if (url.pathname === "/openApi/swap/v1/maintMarginRatio") {
      data = [{ symbol: state.symbol, maxPosition: "100000", maintMarginRatio: "0.005" }];
    } else if (url.pathname === "/openApi/swap/v2/user/commissionRate") {
      data = state.feeRatesByRead[occurrence - 1] ?? {
        makerCommissionRate: "0.0002", takerCommissionRate: "0.0005",
      };
    } else if (url.pathname === "/openApi/swap/v2/quote/premiumIndex") {
      const markRead = state.readCounts.get(path) ?? 0;
      const fundingRate = state.fundingRatesByRead[markRead - 1] ?? "0.0001";
      data = {
        symbol: state.markSymbol, lastFundingRate: fundingRate,
        markPrice: state.markPricesByRead[markRead - 1] ?? state.markPrice,
        time: advanceClockOnSleep ? Math.max(state.markTimestamp, time.now) : state.markTimestamp,
      };
    } else if (url.pathname === leveragePath && options.method === "GET") {
      data = {
        symbol: state.symbol,
        longLeverage: state.longLeverage,
        shortLeverage: state.shortLeverage,
        maxPositionLongVal: state.maxPositionLongVal,
      };
    } else if (url.pathname === leveragePath && options.method === "POST") {
      const leverage = Number(url.searchParams.get("leverage"));
      const side = url.searchParams.get("side");
      if (side === "BOTH" || side === "LONG") state.longLeverage = leverage;
      if (side === "BOTH" || side === "SHORT") state.shortLeverage = leverage;
      if (side === "LONG" && state.shortLeverageAfterWrite !== undefined) {
        state.shortLeverage = state.shortLeverageAfterWrite;
      }
    } else if (url.pathname === orderPath && options.method === "POST") {
      if (url.searchParams.get("type") === "STOP_MARKET") {
        stopPostCount += 1;
        const stopId = state.stopOrderIdOverride ??
          (stopPostCount === 1 ? "new-stop" : `new-stop-${stopPostCount}`);
        const newStop = {
          symbol: state.symbol,
          orderId: stopId,
          type: "STOP_MARKET",
          status: "NEW",
          side: url.searchParams.get("side"),
          positionSide: url.searchParams.get("positionSide"),
          positionId: state.positions.find((position) =>
            Number(position.positionAmt) !== 0)?.positionId,
          origQty: url.searchParams.get("quantity"),
          stopPrice: url.searchParams.get("stopPrice"),
          workingType: url.searchParams.get("workingType"),
          closePosition: "false",
          mainOrderId: "",
          clientOrderId: url.searchParams.get("clientOrderId"),
          executedQty: "0",
          time: state.stopCreationTime,
        };
        state.orders.push(newStop);
        if (state.includeStopInHistory) state.orderHistory.push({ ...newStop });
        if (state.duplicateStopOnPost) {
          state.orders.push({ ...newStop, orderId: "duplicate-new-stop" });
        }
        data = state.stopPostResponses[stopPostCount - 1] ??
          state.stopPostResponse ?? { orderId: stopId };
        if (state.failStopPostAfterApply) {
          throw new Error("simulated ambiguous stop POST response");
        }
      } else if (url.searchParams.get("type") === "MARKET" &&
          state.simulateMarketClose) {
        const orderId = state.marketPostResponse.orderId ?? "market-close";
        const quantity = url.searchParams.get("quantity");
        const position = state.positions.find((row) =>
          row.symbol === state.symbol && row.positionSide === "LONG");
        if (position) position.positionAmt = String(Number(position.positionAmt) - Number(quantity));
        state.identifiedOrder = {
          symbol: state.symbol, orderId, type: "MARKET", status: "FILLED",
          side: "SELL", positionSide: "LONG", origQty: quantity,
          executedQty: quantity,
          clientOrderId: url.searchParams.get("clientOrderId"),
          reduceOnly: url.searchParams.get("reduceOnly") === "true",
        };
        state.ordersById[orderId] = state.identifiedOrder;
        state.fills.push(...(state.marketFillRows ?? [{
          symbol: state.symbol, orderId, tradeId: "market-fill-1",
          side: "SELL", positionSide: "LONG", qty: quantity, price: "100",
          commission: "0.01", commissionAsset: "VST",
        }]));
        if (autoCancelStopsOnMarket &&
            Number(position?.positionAmt ?? 0) === 0) {
          const canceledStops = state.orders.filter((order) =>
            order.type === "STOP_MARKET");
          state.orders = state.orders.filter((order) =>
            order.type !== "STOP_MARKET");
          for (const stop of canceledStops) {
            state.ordersById[stop.orderId ?? stop.orderID] = {
              ...stop, status: "CANCELED", executedQty: "0",
            };
          }
        }
        data = state.marketPostResponse;
        if (state.failMarketPostAfterApply) {
          throw new Error("simulated ambiguous MARKET POST response");
        }
      } else {
        if (failEntryPost) throw new Error("simulated ambiguous network failure");
        data = { orderId: "submitted-1" };
      }
    } else if (url.pathname === orderPath && options.method === "GET") {
      const queriedId = url.searchParams.get("orderId");
      const queriedClientId = url.searchParams.get("clientOrderId");
      data = queriedClientId && state.dropClientOrderQueries
        ? null : queriedClientId
        ? state.orders.find((order) =>
          (order.clientOrderId ?? order.clientOrderID) === queriedClientId) ??
          Object.values(state.ordersById).find((order) =>
            (order?.clientOrderId ?? order?.clientOrderID) === queriedClientId) ??
          (state.identifiedOrder &&
            (state.identifiedOrder.clientOrderId ?? state.identifiedOrder.clientOrderID) ===
              queriedClientId ? state.identifiedOrder : null)
        : state.orders.find((order) =>
          String(order.orderId ?? order.orderID) === queriedId) ??
          state.ordersById[queriedId] ??
          (state.identifiedOrder &&
            String(state.identifiedOrder.orderId ?? state.identifiedOrder.orderID) === queriedId
            ? state.identifiedOrder : null);
      if (!queriedClientId && data?.status === "NEW" &&
          data?.type === "STOP_MARKET" && state.activeStopQueryTransform) {
        data = state.activeStopQueryTransform({ ...data });
      }
    } else if (url.pathname === orderPath && options.method === "DELETE") {
      const deletedId = url.searchParams.get("orderId");
      const match = state.orders.find((order) =>
        String(order.orderId ?? order.orderID) === deletedId);
      if (match) {
        state.orders = state.orders.filter((order) => order !== match);
        state.identifiedOrder = { ...match, status: "CANCELED" };
        state.ordersById[deletedId] = state.identifiedOrder;
        if (state.failDeleteAfterApply) throw new Error("simulated ambiguous DELETE response");
      } else {
        if (state.identifiedOrder) state.identifiedOrder.status = "CANCELED";
        state.orders = [];
      }
    } else if (url.pathname === "/openApi/swap/v2/trade/positionMargin" &&
        options.method === "POST") {
      const position = state.positions.find((row) =>
        row.positionSide === "LONG" && Number(row.positionAmt) !== 0);
      if (position) {
        position.isolatedMargin = String(
          Number(position.isolatedMargin ?? 0) + Number(url.searchParams.get("amount")),
        );
      }
    } else if (url.pathname === "/openApi/swap/v2/trade/allFillOrders") {
      if (state.rawFillResponseText !== undefined) {
        return new Response(state.rawFillResponseText, { status: 200 });
      }
      const startTs = Number(url.searchParams.get("startTs"));
      const endTs = Number(url.searchParams.get("endTs"));
      data = state.fillResponse === undefined
        ? state.fills.filter((fill) => {
          if (!state.filterFillsByTime) return true;
          const rawTime = fill.filledTm ?? fill.filledTime ?? fill.time ??
            fill.timestamp ?? fill.tradeTime;
          const numeric = Number(rawTime);
          const at = Number.isFinite(numeric)
            ? numeric < 100_000_000_000 ? numeric * 1000 : numeric
            : typeof rawTime === "string" ? Date.parse(rawTime) : null;
          return !Number.isSafeInteger(at) || at >= startTs && at <= endTs;
        })
        : state.fillResponse;
    } else if (url.pathname === "/openApi/swap/v2/trade/allOrders") {
      data = state.orderHistoryResponse === undefined
        ? state.orderHistory : state.orderHistoryResponse;
    } else {
      throw new Error(`Unexpected mocked request ${options.method} ${url.pathname}`);
    }
    const requestOverride = state.responseOverrides.find((override) =>
      override?.path === path &&
      override.method === options.method &&
      override.remaining > 0 &&
      (override.orderId === undefined ||
        override.orderId === url.searchParams.get("orderId")));
    if (requestOverride) requestOverride.remaining -= 1;
    const scriptedResponse = requestOverride?.response ??
      state.responseSequences[path]?.[occurrence - 1];
    if (scriptedResponse) {
      responseCode = scriptedResponse.code ?? responseCode;
      if (Object.hasOwn(scriptedResponse, "data")) data = scriptedResponse.data;
    }
    if (normalizeActiveStopExecutionQty &&
        (path === orderPath || path === "/openApi/swap/v2/trade/openOrders") &&
        options.method === "GET") {
      data = Array.isArray(data)
        ? data.map(withActiveStopExecutionProof)
        : withActiveStopExecutionProof(data);
    }
    return new Response(JSON.stringify({
      code: responseCode,
      ...(scriptedResponse?.msg
        ? { msg: scriptedResponse.msg }
        : tickerErrorMessage ? { msg: tickerErrorMessage } : {}),
      data,
    }), { status: 200 });
  };
  const api = createBingXLiveApi({
    environment,
    fetchImpl,
    clock: () => time.now,
    sleep: async (ms) => {
      if (advanceClockOnSleep) time.now += ms;
    },
    requestPacer: requestPacer ?? createBingXOutboundPacer({
      gapMs: 0,
      clock: () => time.now,
      sleep: async (ms) => { time.now += ms; },
    }),
    random,
    onRateLimitDiagnostic,
    credentials: () => ({ key: "mock-key", secret: "mock-secret" }),
    writePermission: async () => permission,
  });
  return { api, calls, state, time };
}

test("account-wide open orders uses a signed no-symbol GET and validates all rows", async () => {
  const allOrders = [
    { symbol: "BTC-USDT", orderId: "btc-order" },
    { symbol: "DOGE-USDT", orderID: "doge-order" },
  ];
  const { api, calls } = fixture({ orders: allOrders });
  assert.deepEqual(await api.getOpenOrders(), allOrders);
  assert.equal(calls.length, 1);
  const [{ url, options }] = calls;
  assert.equal(options.method, "GET");
  assert.equal(url.origin, "https://open-api-vst.bingx.com");
  assert.equal(url.pathname, "/openApi/swap/v2/trade/openOrders");
  assert.equal(url.searchParams.has("symbol"), false);
  assert.deepEqual([...url.searchParams.keys()].sort(),
    ["recvWindow", "signature", "timestamp"]);
  assert.equal(options.headers["X-BX-APIKEY"], "mock-key");

  const wrapped = fixture({
    openOrdersResponse: { orders: allOrders },
  });
  assert.deepEqual(await wrapped.api.getOpenOrders(), allOrders);
  assert.equal(wrapped.calls[0].url.searchParams.has("symbol"), false);

  for (const [label, response] of [
    ["null response", null],
    ["non-array response", "not-an-array"],
    ["unexpected wrapper key", { orders: allOrders, extra: true }],
    ["non-array wrapped orders", { orders: "not-an-array" }],
    ["missing symbol", [{ orderId: "missing-symbol" }]],
    ["noncanonical symbol", [{ symbol: "doge-USDT", orderId: "bad-symbol" }]],
    ["duplicate IDs", [
      { symbol: "BTC-USDT", orderId: "duplicate" },
      { symbol: "DOGE-USDT", orderId: "duplicate" },
    ]],
    ["missing ID", [{ symbol: "BTC-USDT" }]],
  ]) {
    const malformed = fixture({ openOrdersResponse: response });
    await assert.rejects(malformed.api.getOpenOrders(), undefined, label);
    assert.equal(malformed.calls.length, 1);
    assert.equal(malformed.calls[0].url.searchParams.has("symbol"), false);
    assert.equal(malformed.calls.some(({ options: callOptions }) =>
      callOptions.method !== "GET"), false);
  }

  const exchangeError = fixture({
    failReads: [{
      path: "/openApi/swap/v2/trade/openOrders",
      occurrence: 1,
    }],
  });
  await assert.rejects(exchangeError.api.getOpenOrders(), /request failed/);
  assert.equal(exchangeError.calls.length, 1);
  assert.equal(exchangeError.calls[0].options.method, "GET");
  assert.equal(exchangeError.calls[0].url.searchParams.has("symbol"), false);

  const scoped = fixture({
    openOrdersResponse: { orders: [{ symbol: "BTC-USDT", orderId: "scoped-order" }] },
  });
  assert.equal((await scoped.api.getOpenOrders("BTCUSDT"))[0].orderId, "scoped-order");
  assert.equal(scoped.calls[0].url.searchParams.get("symbol"), "BTC-USDT");
});

test("VST isolated margin requires HEDGE and account-wide flatness before a verified transition", async () => {
  const switched = fixture({
    symbol: "ETH-USDT", dualSidePosition: true, marginType: "CROSSED",
  });
  const proof = await switched.api.setVstIsolatedMarginForFlatSymbol("ETHUSDT");
  assert.equal(proof.verified, true);
  assert.equal(proof.symbol, "ETH-USDT");
  assert.equal(proof.priorMarginType, "CROSSED");
  assert.equal(proof.marginType, "ISOLATED");
  assert.equal(proof.changed, true);
  assert.equal(proof.positionMode, "HEDGE");
  assert.equal(proof.positionsFlat, true);
  assert.equal(proof.openOrdersEmpty, true);
  assert.equal(proof.contractVerified, true);
  assert.equal(proof.markPrice, "100");
  assert.equal(switched.state.marginType, "ISOLATED");
  assert.equal(switched.state.marginTypePostCount, 1);
  const marginPost = switched.calls.find(({ url, options }) =>
    url.pathname.endsWith("/marginType") && options.method === "POST");
  assert.ok(marginPost);
  assert.equal(marginPost.url.origin, "https://open-api-vst.bingx.com");
  assert.equal(marginPost.url.searchParams.get("symbol"), "ETH-USDT");
  assert.equal(marginPost.url.searchParams.get("marginType"), "ISOLATED");
  const marginPostIndex = switched.calls.indexOf(marginPost);
  assert.ok(switched.calls.slice(marginPostIndex + 1).some(({ url, options }) =>
    url.pathname.endsWith("/marginType") && options.method === "GET" &&
    url.searchParams.get("symbol") === "ETH-USDT"));
  assert.ok(switched.calls.filter(({ url }) =>
    url.pathname.endsWith("/positions") || url.pathname.endsWith("/openOrders"))
    .every(({ url }) => url.searchParams.has("symbol") === false));
  assert.ok(switched.calls.every(({ url }) =>
    url.origin === "https://open-api-vst.bingx.com"));
  assert.ok(switched.calls.some(({ url }) =>
    url.pathname.endsWith("/contracts") &&
    url.searchParams.get("symbol") === "ETH-USDT"));
  assert.ok(switched.calls.some(({ url }) =>
    url.pathname.endsWith("/premiumIndex") &&
    url.searchParams.get("symbol") === "ETH-USDT"));

  const alreadyIsolated = fixture({
    symbol: "ETH-USDT", dualSidePosition: true, marginType: "ISOLATED",
  });
  const unchanged = await alreadyIsolated.api.setVstIsolatedMarginForFlatSymbol("ETHUSDT");
  assert.equal(unchanged.verified, true);
  assert.equal(unchanged.changed, false);
  assert.equal(alreadyIsolated.state.marginTypePostCount, 0);

  for (const [label, overrides, message] of [
    ["target position", {
      positions: [{
        symbol: "ETH-USDT", positionSide: "LONG", positionAmt: "0.01",
      }],
    }, /ETH-USDT to be flat/],
    ["target order", {
      orders: [{ symbol: "ETH-USDT", orderId: "eth-open" }],
    }, /no open orders for ETH-USDT/],
  ]) {
    const blocked = fixture({
      ...overrides, symbol: "ETH-USDT", dualSidePosition: true, marginType: "CROSSED",
    });
    await assert.rejects(
      blocked.api.setVstIsolatedMarginForFlatSymbol("ETHUSDT"), message, label,
    );
    assert.equal(blocked.state.marginTypePostCount, 0);
  }

  // A DIFFERENT symbol's open position or order is independent exposure --
  // e.g. another trade the bot is actively managing -- and must never block
  // preparing isolated margin for THIS symbol. Requiring the whole account
  // flat would mean only one symbol could ever be open at a time.
  for (const [label, overrides] of [
    ["foreign position", {
      positions: [{
        symbol: "DOGE-USDT", positionSide: "LONG", positionAmt: "1",
      }],
    }],
    ["foreign order", {
      orders: [{ symbol: "BTC-USDT", orderId: "btc-open" }],
    }],
  ]) {
    const unblocked = fixture({
      ...overrides, symbol: "ETH-USDT", dualSidePosition: true, marginType: "CROSSED",
    });
    const proof = await unblocked.api.setVstIsolatedMarginForFlatSymbol("ETHUSDT");
    assert.equal(proof.verified, true, label);
    assert.equal(unblocked.state.marginTypePostCount, 1, label);
  }

  const oneWay = fixture({
    symbol: "ETH-USDT", dualSidePosition: false, marginType: "CROSSED",
  });
  await assert.rejects(
    oneWay.api.setVstIsolatedMarginForFlatSymbol("ETHUSDT"), /requires HEDGE/,
  );
  assert.equal(oneWay.state.marginTypePostCount, 0);

  const unknown = fixture({
    symbol: "ETH-USDT", dualSidePosition: true, marginType: "CROSSED",
    failMarginTypePostBeforeApply: true,
  });
  // A failed switch is re-read and retried (margin type is idempotent state,
  // not an order); after three verified-unapplied attempts it fails loudly.
  await assert.rejects(
    unknown.api.setVstIsolatedMarginForFlatSymbol("ETHUSDT"), /failed after retries/,
  );
  assert.equal(unknown.state.marginType, "CROSSED");
  assert.equal(unknown.state.marginTypePostCount, 3);
  assert.equal(unknown.calls.filter(({ url, options }) =>
    url.pathname.endsWith("/marginType") && options.method === "POST").length, 3);

  const appliedUnknown = fixture({
    symbol: "ETH-USDT", dualSidePosition: true, marginType: "CROSSED",
    failMarginTypePostAfterApply: true,
  });
  // The POST errored after applying: the re-read sees ISOLATED and succeeds.
  const applied = await appliedUnknown.api.setVstIsolatedMarginForFlatSymbol("ETHUSDT");
  assert.equal(applied.marginType, "ISOLATED");
  assert.equal(await appliedUnknown.api.getMarginType("ETHUSDT"), "ISOLATED");
  assert.equal(appliedUnknown.state.marginTypePostCount, 1);

  const mainnet = fixture({
    environment: "mainnet", symbol: "ETH-USDT", dualSidePosition: true,
    marginType: "CROSSED",
  });
  await assert.rejects(
    mainnet.api.setVstIsolatedMarginForFlatSymbol("ETHUSDT"), /unavailable outside VST/,
  );
  assert.equal(mainnet.calls.length, 0);
});

test("VST isolated-margin POST rechecks flatness after a HEDGE-read cooldown", async () => {
  const timeState = { now: 1700000000000 };
  let stateRef;
  let cooldownStarted = false;
  let positionAppeared = false;
  const requestPacer = createBingXOutboundPacer({
    gapMs: 1100,
    clock: () => timeState.now,
    sleep: async (ms) => {
      await new Promise((resolve) => setImmediate(resolve));
      timeState.now += ms;
      if (cooldownStarted && !positionAppeared) {
        stateRef.state.positions.push({
          symbol: "ETH-USDT", positionSide: "LONG", positionAmt: "0.01",
        });
        positionAppeared = true;
      }
    },
  });
  const guarded = fixture({
    symbol: "ETH-USDT",
    dualSidePosition: true,
    marginType: "CROSSED",
    timeState,
    requestPacer,
    advanceClockOnSleep: true,
    responseSequences: {
      "/openApi/swap/v1/positionSide/dual": [
        { code: 0 },
        { code: 100410, msg: "mode read rate limited" },
        { code: 0 },
      ],
    },
    onRateLimitDiagnostic: ({ outcome }) => {
      if (outcome === "retry_scheduled") cooldownStarted = true;
    },
  });
  stateRef = guarded;

  await assert.rejects(
    guarded.api.setVstIsolatedMarginForFlatSymbol("ETHUSDT"),
    (error) => error.transportStage === "pre_transport",
  );
  assert.equal(cooldownStarted, true);
  assert.equal(positionAppeared, true);
  assert.ok(guarded.calls.some(({ url, options, positionsAtCall }) =>
    url.pathname.endsWith("/positions") && options.method === "GET" &&
    positionsAtCall.some((position) =>
      position.symbol === "ETH-USDT" && Number(position.positionAmt) !== 0)));
  assert.equal(guarded.state.marginTypePostCount, 0);
  assert.equal(guarded.calls.filter(({ url, options }) =>
    url.pathname.endsWith("/marginType") && options.method === "POST").length, 0);
});

test("VST leverage writes only 10x/75x and maps hedge side versus one-way BOTH", async () => {
  const oneWay = fixture();
  const result = await oneWay.api.setVstLeverage("BTCUSDT", 10, "LONG");
  assert.equal(result.side, "BOTH");
  assert.deepEqual(
    oneWay.calls.find(({ url, options }) =>
      url.pathname === leveragePath && options.method === "POST")
      .url.searchParams.get("side"),
    "BOTH",
  );
  assert.deepEqual(result.verified,
    { longLeverage: 10, shortLeverage: 10, maxPositionLongVal: 1_000_000 });
  assert.equal(oneWay.calls.at(-1).options.method, "GET");

  const hedge = fixture({ dualSidePosition: true });
  const hedgeResult = await hedge.api.setVstLeverage("BTCUSDT", 10, "LONG");
  const write = hedge.calls.find(({ url, options }) =>
    url.pathname === leveragePath && options.method === "POST");
  assert.equal(write.url.searchParams.get("side"), "LONG");
  assert.equal(hedgeResult.verified.longLeverage, 10);
  assert.equal(hedgeResult.verified.shortLeverage, 75);

  const restore = fixture({ longLeverage: 10, shortLeverage: 10 });
  await restore.api.setVstLeverage("BTCUSDT", 75, "SHORT");
  assert.equal(restore.state.longLeverage, 75);
  assert.equal(restore.state.shortLeverage, 75);
});

test("general VST LONG leverage preparation sets LONG 10 idempotently and preserves independently read SHORT", async () => {
  const prep = fixture({
    symbol: "DOGE-USDT",
    dualSidePosition: true,
    longLeverage: 3,
    shortLeverage: 7,
  });
  const changed = await prep.api.setVstLongLeverage10("DOGEUSDT");
  assert.deepEqual(changed, {
    symbol: "DOGE-USDT",
    positionMode: "HEDGE",
    marginType: "ISOLATED",
    longLeverage: 10,
    shortLeverage: 7,
    changed: true,
    verified: true,
  });
  const write = prep.calls.find(({ url, options }) =>
    url.pathname === leveragePath && options.method === "POST");
  assert.equal(write.url.searchParams.get("symbol"), "DOGE-USDT");
  assert.equal(write.url.searchParams.get("leverage"), "10");
  assert.equal(write.url.searchParams.get("side"), "LONG");
  assert.equal(prep.state.shortLeverage, 7);

  const idempotent = await prep.api.setVstLongLeverage10("DOGEUSDT");
  assert.equal(idempotent.changed, false);
  assert.equal(idempotent.shortLeverage, 7);
  assert.equal(prep.calls.filter(({ url, options }) =>
    url.pathname === leveragePath && options.method === "POST").length, 1);

  const driftedShort = fixture({
    symbol: "DOGE-USDT", dualSidePosition: true, longLeverage: 3,
    shortLeverage: 7, shortLeverageAfterWrite: 8,
  });
  await assert.rejects(
    driftedShort.api.setVstLongLeverage10("DOGEUSDT"),
    /independent LONG\/SHORT read-after-write/,
  );
  assert.equal(driftedShort.state.longLeverage, 10);
  assert.equal(driftedShort.state.shortLeverage, 8);
});

test("general VST LONG leverage preparation is VST-only and requires HEDGE, isolated, flat/no-orders", async () => {
  const mainnet = fixture({ environment: "mainnet" });
  await assert.rejects(mainnet.api.setVstLongLeverage10("BTCUSDT"), /outside VST/);
  assert.equal(mainnet.calls.length, 0);

  const invalidSymbol = fixture();
  await assert.rejects(invalidSymbol.api.setVstLongLeverage10("bad-symbol"), /Invalid USDT/);
  assert.equal(invalidSymbol.calls.length, 0);

  for (const options of [
    { dualSidePosition: false },
    { dualSidePosition: true, marginType: "CROSSED" },
    {
      dualSidePosition: true,
      positions: [{ symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.01" }],
    },
    {
      dualSidePosition: true,
      orders: [{ symbol: "BTC-USDT", orderId: "open-order", type: "LIMIT", status: "NEW" }],
    },
  ]) {
    const blocked = fixture({ longLeverage: 3, shortLeverage: 7, ...options });
    await assert.rejects(blocked.api.setVstLongLeverage10("BTCUSDT"), /requires/);
    assert.equal(blocked.calls.some(({ options: call }) => call.method === "POST"), false);
  }
});

test("VST leverage fails closed outside VST, outside BTC, and on unsafe preflight", async () => {
  const mainnet = fixture({ environment: "mainnet" });
  await assert.rejects(
    mainnet.api.setVstLeverage("BTCUSDT", 10, "LONG"), /outside the VST environment/,
  );
  assert.equal(mainnet.calls.length, 0);

  const wrongSymbol = fixture();
  await assert.rejects(
    wrongSymbol.api.setVstLeverage("ETHUSDT", 10, "LONG"), /restricted to BTCUSDT/,
  );
  assert.equal(wrongSymbol.calls.length, 0);

  for (const options of [
    { marginType: "CROSSED" },
    { positions: [{ symbol: "BTC-USDT", positionSide: "BOTH", positionAmt: "0.01" }] },
    { positions: [{ symbol: "BTC-USDT", positionSide: "UNKNOWN", positionAmt: "0" }] },
    { orders: [{ symbol: "BTC-USDT", orderId: 1 }] },
  ]) {
    const blocked = fixture(options);
    await assert.rejects(
      blocked.api.setVstLeverage("BTCUSDT", 10, "LONG"), /requires/,
    );
    assert.equal(blocked.calls.some(({ options: request }) =>
      request.method !== "GET"), false);
  }

  const restricted = fixture();
  await assert.rejects(
    restricted.api.setVstLeverage("BTCUSDT", 20, "LONG"), /must be 10 or the prior 75/,
  );
  await assert.rejects(
    restricted.api.setVstLeverage("BTCUSDT", 10, "BOTH"), /side must be LONG or SHORT/,
  );
  assert.equal(restricted.calls.length, 0);

  const permissionDenied = fixture({ permission: false });
  await assert.rejects(
    permissionDenied.api.setVstLeverage("BTCUSDT", 10, "LONG"), /explicit permission/,
  );
  assert.equal(permissionDenied.calls.some(({ options }) =>
    options.method !== "GET"), false);
});

test("VST cancellation requires an identified plain order and verifies cancelled/no-fill final state", async () => {
  const openOrder = {
    symbol: "BTC-USDT",
    orderId: "order-123",
    clientOrderId: "client-123",
    type: "LIMIT",
    status: "NEW",
  };
  const { api, calls } = fixture({
    orders: [openOrder],
    identifiedOrder: { ...openOrder },
  });
  const result = await api.cancelVstOrder("BTCUSDT", { clientOrderId: "client-123" });
  const deletion = calls.find(({ options }) => options.method === "DELETE");
  assert.ok(deletion);
  assert.equal(deletion.url.pathname, orderPath);
  assert.equal(deletion.url.searchParams.get("clientOrderId"), "client-123");
  assert.equal(deletion.url.searchParams.has("orderId"), false);
  assert.equal(result.status, "CANCELED");
  assert.deepEqual(result.fills, []);
  assert.ok(calls.filter(({ options }) => options.method !== "GET")
    .every(({ options }) => options.method === "DELETE"));
});

test("VST cancellation never deletes attached stops, unidentified orders, positions, or mainnet orders", async () => {
  const protective = {
    symbol: "BTC-USDT", orderId: 9, clientOrderId: "stop-9",
    type: "STOP_MARKET", status: "NEW",
  };
  const stop = fixture({
    orders: [protective], identifiedOrder: { ...protective },
  });
  await assert.rejects(
    stop.api.cancelVstOrder("BTCUSDT", 9), /never a protective order/,
  );
  assert.equal(stop.calls.some(({ options }) => options.method === "DELETE"), false);

  const occupied = fixture({
    positions: [{ symbol: "BTC-USDT", positionSide: "BOTH", positionAmt: "1" }],
    orders: [{ symbol: "BTC-USDT", orderId: 10, type: "LIMIT", status: "NEW" }],
    identifiedOrder: { symbol: "BTC-USDT", orderId: 10, type: "LIMIT", status: "NEW" },
  });
  await assert.rejects(occupied.api.cancelVstOrder("BTCUSDT", 10), /flat BTCUSDT/);
  assert.equal(occupied.calls.some(({ options }) => options.method === "DELETE"), false);

  const mainnet = fixture({
    environment: "mainnet",
    orders: [{ symbol: "BTC-USDT", orderId: 10, type: "LIMIT", status: "NEW" }],
  });
  await assert.rejects(mainnet.api.cancelVstOrder("BTCUSDT", 10), /outside the VST environment/);
  assert.equal(mainnet.calls.length, 0);
});

test("VST cancellation reports a failed no-fills verification after DELETE", async () => {
  const openOrder = {
    symbol: "BTC-USDT", orderId: 12, clientOrderId: "client-12",
    type: "LIMIT", status: "NEW",
  };
  const { api, calls } = fixture({
    orders: [openOrder],
    identifiedOrder: { ...openOrder },
    fills: [{ symbol: "BTC-USDT", orderId: 12, qty: "0.1", price: "100" }],
  });
  await assert.rejects(
    api.cancelVstOrder("BTCUSDT", 12), /cancelled with no fills/,
  );
  assert.equal(calls.some(({ options }) => options.method === "DELETE"), true);
});

test("VST bounded long posts a price-capped LIMIT FOK with attached stop", async () => {
  const { api, calls } = fixture({ longLeverage: 10, shortLeverage: 10 });
  let startedAt;
  await api.placeVstBoundedLong({
    symbol: "BTCUSDT", quantity: "0.0015", maxPrice: "65300.0",
    stopLoss: "64000.0", clientOrderId: "ve_bounded-1",
    onAttemptStarted: async (timestamp) => { startedAt = timestamp; },
  });
  assert.equal(startedAt, 1700000000000);
  const entry = calls.find(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST");
  assert.ok(entry);
  assert.equal(entry.url.origin, "https://open-api-vst.bingx.com");
  assert.equal(entry.url.searchParams.get("type"), "LIMIT");
  assert.equal(entry.url.searchParams.get("price"), "65300.0");
  assert.equal(entry.url.searchParams.get("timeInForce"), "FOK");
  assert.deepEqual(JSON.parse(entry.url.searchParams.get("stopLoss")), {
    type: "STOP_MARKET", stopPrice: 64000,
  });
  assert.equal(entry.url.searchParams.get("clientOrderId"), "ve_bounded-1");
});

test("bounded BTC bracket probe uses explicit LONG10 SHORT75 policy without relaxing its ten-VST cap", async () => {
  const { api, calls } = fixture({
    dualSidePosition: true, longLeverage: 10, shortLeverage: 75,
  });
  await api.placeVstBoundedLong({
    symbol: "BTCUSDT", quantity: "0.001", maxPrice: "65300.0",
    stopLoss: "64000.0", clientOrderId: "bracket-policy",
    probePolicy: VST_BTC_HEDGE_LONG10_SHORT75_PROBE,
  });
  assert.equal(calls.filter(({ options }) => options.method === "POST").length, 1);
  const oversized = fixture({
    dualSidePosition: true, longLeverage: 10, shortLeverage: 75,
  });
  await assert.rejects(oversized.api.placeVstBoundedLong({
    symbol: "BTCUSDT", quantity: "0.002", maxPrice: "65300.0",
    stopLoss: "64000.0", clientOrderId: "bracket-policy-cap",
    probePolicy: VST_BTC_HEDGE_LONG10_SHORT75_PROBE,
  }), /exceeds 100 VST notional/);
  assert.equal(oversized.calls.some(({ options }) => options.method === "POST"), false);
});

test("bounded entry accepts BingX nested acknowledgement and rejects conflicting IDs without replay", async () => {
  for (const conflict of [false, true]) {
    const f = fixture({ longLeverage: 10, shortLeverage: 10,
      responseOverrides: [{ path: orderPath, method: "POST", response: { data: {
        ...(conflict ? { orderId: "999" } : {}),
        order: { orderId: "2114291121333993473", orderID: "2114291121333993473" },
      } } }],
    });
    const request = {
      symbol: "BTCUSDT", quantity: "0.001", maxPrice: "65300.0",
      stopLoss: "64000.0", clientOrderId: `nested-bounded-${conflict}`,
    };
    if (conflict) await assert.rejects(f.api.placeVstBoundedLong(request), /conflicting/);
    else await f.api.placeVstBoundedLong(request);
    await assert.rejects(f.api.placeVstBoundedLong(request), /already submitted/);
    assert.equal(f.calls.filter(({ options }) => options.method === "POST").length, 1);
  }
});

test("bounded VST entry rejects unsafe state, >100 notional, mainnet, and wrong symbol", async () => {
  for (const options of [
    { marginType: "CROSSED" },
    { positions: [{ symbol: "BTC-USDT", positionSide: "BOTH", positionAmt: "0.001" }] },
    { orders: [{ symbol: "BTC-USDT", orderId: 3 }] },
    { longLeverage: 75, shortLeverage: 75 },
  ]) {
    const blocked = fixture(options);
    await assert.rejects(blocked.api.placeVstBoundedLong({
      symbol: "BTCUSDT", quantity: "0.001", maxPrice: "65300.0",
      stopLoss: "64000.0", clientOrderId: "ve_blocked",
    }), /preflight blocked/);
    assert.equal(blocked.calls.some(({ options: request }) =>
      request.method === "POST"), false);
  }
  const oversized = fixture({ longLeverage: 10, shortLeverage: 10 });
  await assert.rejects(oversized.api.placeVstBoundedLong({
    symbol: "BTCUSDT", quantity: "0.002", maxPrice: "65300.0",
    stopLoss: "64000.0", clientOrderId: "ve_over",
  }), /100 VST/);
  assert.equal(oversized.calls.some(({ options }) => options.method === "POST"), false);

  const mainnet = fixture({ environment: "mainnet" });
  await assert.rejects(mainnet.api.placeVstBoundedLong({
    symbol: "BTCUSDT", quantity: "0.001", maxPrice: "65300.0",
    stopLoss: "64000.0", clientOrderId: "ve_mainnet",
  }), /outside the VST environment/);
  const wrongSymbol = fixture();
  await assert.rejects(wrongSymbol.api.placeVstBoundedLong({
    symbol: "ETHUSDT", quantity: "0.001", maxPrice: "65300.0",
    stopLoss: "64000.0", clientOrderId: "ve_eth",
  }), /restricted to BTCUSDT/);
  assert.equal(mainnet.calls.length + wrongSymbol.calls.length, 0);
});

test("bounded VST entry reserves its deterministic client ID before an ambiguous POST", async () => {
  const broken = fixture({
    longLeverage: 10, shortLeverage: 10, failEntryPost: true,
  });
  await assert.rejects(broken.api.placeVstBoundedLong({
    symbol: "BTCUSDT", quantity: "0.0015", maxPrice: "65300.0",
    stopLoss: "64000.0", clientOrderId: "ve_reserved",
  }), /request failed/);
  await assert.rejects(broken.api.placeVstBoundedLong({
    symbol: "BTCUSDT", quantity: "0.0015", maxPrice: "65300.0",
    stopLoss: "64000.0", clientOrderId: "ve_reserved",
  }), /already submitted/);
});

test("separate supervised VST FOK entry caps initial margin at 1% and requires HEDGE 10/75", async () => {
  const allowed = fixture({ dualSidePosition: true, longLeverage: 10, shortLeverage: 75 });
  await allowed.api.placeVstOnePercentBoundedLong({
    symbol: "BTCUSDT", quantity: "1", maxPrice: "100.0",
    stopLoss: "98.0", clientOrderId: "vse_one-percent",
    probePolicy: VST_BTC_HEDGE_LONG10_SHORT75_PROBE,
  });
  const entry = allowed.calls.find(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST");
  assert.ok(entry);
  assert.equal(entry.url.searchParams.get("positionSide"), "LONG");
  assert.equal(entry.url.searchParams.get("type"), "LIMIT");
  assert.equal(entry.url.searchParams.get("timeInForce"), "FOK");
  assert.equal(entry.url.searchParams.get("quantity"), "1");
  assert.equal(entry.url.searchParams.get("clientOrderId"), "vse_one-percent");
  const tickerIndex = allowed.calls.findIndex(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/ticker");
  const writeIndex = allowed.calls.findIndex(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST");
  assert.ok(tickerIndex >= 0 && tickerIndex < writeIndex);

  const aboveBudget = fixture({
    dualSidePosition: true, longLeverage: 10, shortLeverage: 75,
  });
  await assert.rejects(aboveBudget.api.placeVstOnePercentBoundedLong({
    symbol: "BTCUSDT", quantity: "1.01", maxPrice: "100.0",
    stopLoss: "98.0", clientOrderId: "vse_over-budget",
    probePolicy: VST_BTC_HEDGE_LONG10_SHORT75_PROBE,
  }), /one percent/);
  assert.equal(aboveBudget.calls.some(({ options }) => options.method === "POST"), false);

  const oneWay = fixture({ longLeverage: 10, shortLeverage: 75 });
  await assert.rejects(oneWay.api.placeVstOnePercentBoundedLong({
    symbol: "BTCUSDT", quantity: "1", maxPrice: "100.0",
    stopLoss: "98.0", clientOrderId: "vse_one-way",
    probePolicy: VST_BTC_HEDGE_LONG10_SHORT75_PROBE,
  }), /HEDGE/);
  assert.equal(oneWay.calls.some(({ options }) => options.method === "POST"), false);

  const adverseAsk = fixture({
    dualSidePosition: true, longLeverage: 10, shortLeverage: 75,
    ticker: { askPrice: "101", bidPrice: "100.9", time: 1700000000000 },
  });
  await assert.rejects(adverseAsk.api.placeVstOnePercentBoundedLong({
    symbol: "BTCUSDT", quantity: "1", maxPrice: "100.0",
    stopLoss: "98.0", clientOrderId: "vse_adverse",
    probePolicy: VST_BTC_HEDGE_LONG10_SHORT75_PROBE,
  }), /pre-sign check failed/);
  assert.equal(adverseAsk.calls.some(({ options }) => options.method === "POST"), false);

  const staleQuote = fixture({
    dualSidePosition: true, longLeverage: 10, shortLeverage: 75,
    ticker: { askPrice: "100", bidPrice: "99.9", time: 1699999989000 },
  });
  await assert.rejects(staleQuote.api.placeVstOnePercentBoundedLong({
    symbol: "BTCUSDT", quantity: "1", maxPrice: "100.0",
    stopLoss: "98.0", clientOrderId: "vse_stale-quote",
    probePolicy: VST_BTC_HEDGE_LONG10_SHORT75_PROBE,
  }), /pre-sign check failed/);
  assert.equal(staleQuote.calls.some(({ options }) => options.method === "POST"), false);
});

test("one-percent VST final pre-sign diagnostics are categorical and never POST on failed checks", async () => {
  const balancePath = "/openApi/swap/v3/user/balance";
  const positionsPath = "/openApi/swap/v2/user/positions";
  const attempt = (clientOrderId) => ({
    symbol: "BTCUSDT",
    quantity: "1",
    maxPrice: "100.0",
    stopLoss: "98.0",
    clientOrderId,
    probePolicy: VST_BTC_HEDGE_LONG10_SHORT75_PROBE,
  });
  const cases = [
    {
      reason: "final_balance_unavailable",
      options: { failReads: [{ path: balancePath, occurrence: 3 }] },
    },
    {
      reason: "final_balance_invalid",
      options: { balanceByRead: [undefined, undefined, []] },
    },
    {
      reason: "final_preflight_unavailable",
      options: { failReads: [{ path: positionsPath, occurrence: 2 }] },
    },
    {
      reason: "final_preflight_blocked",
      options: {
        balanceByRead: [
          undefined, undefined, undefined,
          [{ asset: "VST", balance: "1000", availableMargin: "1" }],
        ],
      },
    },
    {
      reason: "final_budget_exceeded",
      options: {
        balanceByRead: [undefined, undefined, [
          { asset: "VST", balance: "900", availableMargin: "20" },
        ]],
      },
    },
    {
      reason: "final_quote_unavailable_or_stale",
      options: { ticker: { askPrice: "100", bidPrice: "99.9", time: 1699999989000 } },
    },
    {
      reason: "final_quote_out_of_bounds",
      options: { ticker: { askPrice: "101", bidPrice: "100.9", time: 1700000000000 } },
    },
  ];

  for (const [index, scenario] of cases.entries()) {
    const { api, calls } = fixture({
      dualSidePosition: true,
      longLeverage: 10,
      shortLeverage: 75,
      ...scenario.options,
    });
    await assert.rejects(api.placeVstOnePercentBoundedLong(attempt(`vse_diag-${index}`)), (error) => {
      assert.equal(error.message, "BingX final pre-sign check failed");
      assert.equal(error.transportStage, "pre_transport");
      assert.equal(error.preSignReason, scenario.reason);
      const diagnostic = JSON.stringify(error);
      assert.equal(diagnostic.includes("1000"), false);
      assert.equal(diagnostic.includes("100.0"), false);
      return true;
    });
    assert.equal(calls.some(({ options }) => options.method === "POST"), false);
  }
});

test("VST management corroborates a moving mark with the native book when the 24h ticker lags", async () => {
  const f = fixture({
    symbol: "BTW-USDT",
    markTimestamp: 0,
    markPrice: "1.0503",
    ticker: { askPrice: "1.0367", bidPrice: "1.0350", time: 1700000000000 },
    bookTicker: {
      symbol: "BTW-USDT", ask_price: 1.0520, bid_price: 1.0480,
      time: 1700000000000, lastUpdateId: 161546128,
    },
  });
  const mark = await f.api.getVstMarkPrice("BTWUSDT");
  assert.equal(mark.markPrice, 1.0503);
  assert.equal(mark.markCorroboration.source, "book_ticker_bid_ask");
  assert.equal(mark.markCorroboration.bid, 1.048);
  assert.equal(mark.markCorroboration.ask, 1.052);
  assert.equal(mark.timestampSource, "local_response_received");
  assert.ok(f.calls.some(({ url }) => url.pathname.endsWith("/bookTicker")));
  assert.equal(f.calls.some(({ options }) => options.method !== "GET"), false);
});

const markedVstPosition = {
  symbol: "BTW-USDT", positionId: "9007199254740993123",
  positionSide: "LONG", positionAmt: "10", currency: "VST",
  markPrice: "1.158100",
  // A position last changed hours ago can still have a current valuation.
  // This is deliberately NOT treated as a mark-price update timestamp.
  updateTime: 1699990000000,
};

function outsideBookMarkFixture(overrides = {}) {
  return fixture({
    symbol: "BTW-USDT", markTimestamp: 0, markPrice: "1.1581",
    ticker: { askPrice: "1.1510", bidPrice: "1.1492", time: 1700000000000 },
    bookTicker: {
      symbol: "BTW-USDT", ask_price: 1.1510, bid_price: 1.1492,
      time: 1700000000000,
    },
    positions: [markedVstPosition],
    ...overrides,
  });
}

test("secondary book and signed mark reserve one cohort before either response completes", async () => {
  let releaseBook;
  const bookPending = new Promise((resolve) => { releaseBook = resolve; });
  let bookStarted = false;
  const f = outsideBookMarkFixture({
    positions: [{ ...markedVstPosition, markPrice: "1.1500" }],
    beforeFetch: async (url, options, time) => {
      assert.equal(options.method, "GET");
      if (url.pathname === "/openApi/swap/v2/quote/bookTicker") {
        bookStarted = true;
        await bookPending;
      }
      if (url.pathname === "/openApi/swap/v2/user/positions") {
        assert.equal(bookStarted, true, "signed proof must be enqueued before awaiting the book");
        time.now += 6_000;
        releaseBook();
      }
    },
  });
  const result = await f.api.getVstMarkPrice("BTWUSDT");
  assert.equal(result.markPrice, 1.15);
  assert.equal(result.markPriceSource, "open_position");
  assert.equal(result.markCorroboration.source, "signed_position_mark_with_book");
  assert.equal(f.calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/user/positions").length, 1);
  assert.ok(f.calls.every(({ options }) => options.method === "GET"));
});

test("the full paced broker acquires an open-position mark before metadata splits its proof", async () => {
  const time = { now: 1700000000000 };
  const f = outsideBookMarkFixture({
    timeState: time, dualSidePosition: true, longLeverage: 10,
    requestPacer: createBingXOutboundPacer({
      gapMs: 1100, clock: () => time.now,
      sleep: async (ms) => { time.now += ms; },
    }),
    positions: [{
      ...markedVstPosition, markPrice: "1.1500", avgPrice: "1.12",
      initialMargin: "1.12", liquidationPrice: "1.0",
      leverage: 10, marginType: "ISOLATED",
    }],
    orders: [{
      symbol: "BTW-USDT", orderId: "native-stop",
      positionId: markedVstPosition.positionId, type: "STOP_MARKET",
      status: "NEW", side: "SELL", positionSide: "LONG",
      origQty: "10", stopPrice: "1.0486", workingType: "MARK_PRICE",
    }],
    beforeFetch: async (url) => {
      if (url.pathname.endsWith("/bookTicker")) {
        f.state.bookTicker = {
          symbol: "BTW-USDT", ask_price: 1.151, bid_price: 1.1492, time: time.now,
        };
      }
    },
  });
  const broker = createVstBroker({
    api: f.api, accountId: "paced-native-account", canarySymbols: ["BTWUSDT"],
    clock: () => time.now, sleep: async () => {}, stopBufferRate: 0.005,
  });
  const position = await broker.readPosition("BTWUSDT", { allowProcessCache: false });
  assert.equal(position.verified, true);
  const mark = await broker.readMarketMark("BTWUSDT", { positionRead: position });
  assert.equal(mark.verified, true);
  assert.equal(Number(mark.price), 1.15);
  const pricePaths = f.calls.filter(({ url }) =>
    url.pathname.endsWith("/premiumIndex") || url.pathname.endsWith("/bookTicker") ||
    url.pathname.endsWith("/ticker"));
  assert.equal(pricePaths.filter(({ url }) => url.pathname.endsWith("/premiumIndex")).length, 1);
  assert.equal(pricePaths.filter(({ url }) => url.pathname.endsWith("/bookTicker")).length, 1);
  assert.equal(pricePaths.filter(({ url }) => url.pathname.endsWith("/ticker")).length, 0);
  assert.ok(f.calls.every(({ options }) => options.method === "GET"));
  assert.ok(time.now - 1700000000000 <= 10_000,
    `complete broker cohort took ${time.now - 1700000000000}ms`);
});

test("early open-position corroboration still refuses evidence older than ten seconds", async () => {
  const f = outsideBookMarkFixture({
    advanceClockOnBookReadMs: 10_001,
    positions: [{ ...markedVstPosition, markPrice: "1.2000" }],
  });
  await assert.rejects(f.api.getVstOpenPositionMark("BTWUSDT"), (error) => {
    assert.equal(error.message, "VST final quote is stale or invalid");
    assert.ok(error.vstMarkEvidence.every((pair) =>
      pair.positionMarkReadStatus === "expired"));
    return true;
  });
  assert.ok(f.calls.every(({ options }) => options.method === "GET"));
});

test("a VST valuation mark outside both execution books is corroborated by the live signed position mark", async () => {
  for (const markPrice of ["1.1581", "1.1400", "0.00000001"]) {
    const f = outsideBookMarkFixture({
      markPrice, positions: [{ ...markedVstPosition, markPrice }],
    });
    const result = await f.api.getVstMarkPrice("BTWUSDT");
    assert.equal(result.markPrice, Number(markPrice));
    assert.equal(result.markCorroboration.source, "signed_open_position_mark");
    assert.equal(result.timestampSource, "local_response_received");
    assert.equal(result.markCorroboration.exchangeTimestamp, null);
    assert.notEqual(result.timestamp, markedVstPosition.updateTime);
    const read = f.calls.find(({ url }) => url.pathname.endsWith("/user/positions"));
    assert.equal(read.url.searchParams.get("symbol"), "BTW-USDT");
    assert.ok(read.url.searchParams.has("signature"));
    assert.equal(read.url.origin, "https://open-api-vst.bingx.com");
    assert.equal(f.calls.filter(({ url }) => url.pathname.endsWith("/premiumIndex")).length, 1);
    assert.equal(f.calls.some(({ options }) => options.method !== "GET"), false);
  }
});

test("native position mark corroboration does not depend on an available execution ticker", async () => {
  const f = outsideBookMarkFixture({ tickerResponseCode: 109500 });
  const result = await f.api.getVstMarkPrice("BTWUSDT");
  assert.equal(result.markCorroboration.source, "signed_open_position_mark");
  assert.equal(result.markPrice, 1.1581);
  assert.equal(f.calls.some(({ options }) => options.method !== "GET"), false);
});

test("disagreeing premium index cannot stall a position whose own native mark is corroborated by the fresh book", async () => {
  for (const currency of ["VST", "USDT"]) {
    const f = outsideBookMarkFixture({
      positions: [{ ...markedVstPosition, markPrice: "1.1510", currency }],
    });
    const result = await f.api.getVstMarkPrice("BTWUSDT");
    assert.equal(result.markPrice, 1.151);
    assert.equal(result.markPriceSource, "open_position");
    assert.equal(result.markCorroboration.source, "signed_position_mark_with_book");
    assert.equal(result.markCorroboration.positionMarkPrice, 1.151);
    assert.equal(result.markCorroboration.premiumIndexMarkPrice, 1.1581);
    assert.equal(result.markCorroboration.quoteSource, "book_ticker_bid_ask");
    assert.equal(result.markCorroboration.exchangeTimestamp, null);
    assert.equal(f.calls.some(({ options }) => options.method !== "GET"), false);
  }
});

test("changing mark source requires a fresh native book, not just the rolling ticker", async () => {
  for (const bookTicker of [
    undefined,
    { symbol: "BTW-USDT", ask_price: 1.151, bid_price: 1.1492, time: 1699999989000 },
    { symbol: "BTC-USDT", ask_price: 1.151, bid_price: 1.1492, time: 1700000000000 },
    { symbol: "BTW-USDT", ask_price: 1.13, bid_price: 1.12, time: 1700000000000 },
  ]) {
    const f = outsideBookMarkFixture({
      bookTicker, positions: [{ ...markedVstPosition, markPrice: "1.1510" }],
    });
    await assert.rejects(f.api.getVstMarkPrice("BTWUSDT"), /not corroborated/);
    assert.equal(f.calls.some(({ options }) => options.method !== "GET"), false);
  }
});

test("flat, wrong, ambiguous or malformed native positions cannot certify a VST mark", async () => {
  for (const positions of [
    [],
    [{ ...markedVstPosition, positionAmt: "0" }],
    [{ ...markedVstPosition, symbol: "BTC-USDT" }],
    [markedVstPosition, { ...markedVstPosition, positionId: "another" }],
    [{ ...markedVstPosition, positionSide: "SHORT" }],
    [{ ...markedVstPosition, positionAmt: "-10" }],
    [{ ...markedVstPosition, positionId: "0" }],
    [{ ...markedVstPosition, positionId: undefined }],
    [{ ...markedVstPosition, currency: "BTC" }],
    [{ ...markedVstPosition, markPrice: undefined }],
    [{ ...markedVstPosition, markPrice: "0" }],
    [{ ...markedVstPosition, markPrice: "NaN" }],
    [{ ...markedVstPosition, markPrice: "1.158100000000001" }],
    // Do not read execution/index prices instead of the explicit native mark.
    [{ ...markedVstPosition, markPrice: undefined, price: "1.1510", indexPrice: "1.1510" }],
  ]) {
    const f = outsideBookMarkFixture({ positions });
    await assert.rejects(f.api.getVstMarkPrice("BTWUSDT"),
      /not corroborated by a fresh quote/, JSON.stringify(positions));
    assert.equal(f.calls.some(({ options }) => options.method !== "GET"), false);
  }
});

test("native position reads cannot extend the original mark acquisition window", async () => {
  const time = { now: 1700000000000 };
  const f = outsideBookMarkFixture({
    timeState: time,
    requestPacer: { deferFor() {}, async waitForSlot() {
      // Funding, ticker, book, then the native corroboration request.
      this.reads = (this.reads ?? 0) + 1;
      // First pair uses ticker + book before its position read; the second
      // pair's now-stale ticker goes directly to its position read.
      if (this.reads === 4 || this.reads === 7) time.now += 11000;
    } },
  });
  await assert.rejects(f.api.getVstMarkPrice("BTWUSDT"), (error) => {
    assert.ok(error.vstMarkEvidence.some((row) => row.positionMarkReadStatus === "expired"));
    return true;
  });
  assert.equal(f.calls.some(({ options }) => options.method !== "GET"), false);
});

test("an expired corroboration may retry only a newly acquired complete readonly pair", async () => {
  const time = { now: 1700000000000 };
  const f = outsideBookMarkFixture({
    timeState: time,
    requestPacer: { deferFor() {}, async waitForSlot() {
      this.reads = (this.reads ?? 0) + 1;
      if (this.reads === 4) time.now += 11000;
    } },
  });
  const result = await f.api.getVstMarkPrice("BTWUSDT");
  assert.equal(result.timestamp, 1700000011000);
  assert.equal(result.markCorroboration.source, "signed_open_position_mark");
  assert.equal(f.calls.filter(({ url }) => url.pathname.endsWith("/premiumIndex")).length, 2);
  assert.equal(f.calls.some(({ options }) => options.method !== "GET"), false);
});

test("native mark read failures retain provider diagnosis and never certify price agreement", async () => {
  const f = outsideBookMarkFixture({
    responseSequences: {
      "/openApi/swap/v2/user/positions": [
        { code: 100001, data: [] }, { code: 100001, data: [] },
      ],
    },
  });
  await assert.rejects(f.api.getVstMarkPrice("BTWUSDT"), (error) => {
    assert.equal(error.vstMarkEvidence[0].positionMarkReadStatus, "unavailable");
    assert.equal(error.vstMarkEvidence[0].positionMarkErrorCode, 100001);
    return true;
  });
});

test("secondary VST book evidence never bypasses symbol, freshness, spread or price checks", async () => {
  const book = {
    symbol: "BTW-USDT", ask_price: 1.052, bid_price: 1.048, time: 1700000000000,
  };
  for (const invalid of [
    { ...book, symbol: "BTC-USDT" },
    { ...book, time: 1699999989000 },
    { ...book, time: 1700000060000 },
    { ...book, time: undefined },
    { ...book, bid_price: 1.06 },
    { ...book, ask_price: 1.04, bid_price: 1.039 },
  ]) {
    const f = fixture({
      symbol: "BTW-USDT", markTimestamp: 0, markPrice: "1.0503",
      ticker: { askPrice: "1.0367", bidPrice: "1.0350", time: 1700000000000 },
      bookTicker: invalid,
    });
    await assert.rejects(f.api.getVstMarkPrice("BTWUSDT"),
      /not corroborated by a fresh quote/, JSON.stringify(invalid));
    assert.equal(f.calls.some(({ options }) => options.method !== "GET"), false);
  }
});

test("a fresh secondary book cannot revive a funding mark that aged out during its transport", async () => {
  const f = fixture({
    symbol: "BTW-USDT", markTimestamp: 0, markPrice: "1.0503",
    ticker: { askPrice: "1.0367", bidPrice: "1.0350", time: 1700000000000 },
    bookTicker: {
      symbol: "BTW-USDT", ask_price: 1.052, bid_price: 1.048, time: 1700000015000,
    },
    advanceClockOnBookReadMs: 15000,
  });
  await assert.rejects(f.api.getVstMarkPrice("BTWUSDT"), /stale or invalid|not corroborated/);
  assert.equal(f.calls.some(({ options }) => options.method !== "GET"), false);
});

test("VST mark and fresh-ticker reads support non-BTC contracts and reject mismatched or stale symbols", async () => {
  const doge = fixture({ symbol: "DOGE-USDT" });
  const mark = await doge.api.getVstMarkPrice("DOGEUSDT");
  assert.equal(mark.symbol, "DOGE-USDT");
  assert.equal(mark.markPrice, 100);
  const markRead = doge.calls.find(({ url }) =>
    url.pathname.endsWith("/premiumIndex"));
  assert.equal(markRead.url.searchParams.get("symbol"), "DOGE-USDT");

  const corroborated = fixture({
    symbol: "DOGE-USDT",
    markTimestamp: 0,
    advanceClockOnTickerReadMs: 1000,
    ticker: { askPrice: "100", bidPrice: "99.9", time: 1700000000000 },
  });
  const fallbackMark = await corroborated.api.getVstMarkPrice("DOGEUSDT");
  assert.equal(fallbackMark.symbol, "DOGE-USDT");
  // The concurrent ticker transport advances this fixture's clock before the
  // funding promise settles; the timestamp remains a local receipt, not a
  // fabricated exchange mark update.
  assert.equal(fallbackMark.timestamp, 1700000001000);
  assert.equal(fallbackMark.corroboratedByTickerAt, 1700000001000);
  const tickerRead = corroborated.calls.find(({ url }) =>
    url.pathname.endsWith("/ticker"));
  assert.equal(tickerRead.url.searchParams.get("symbol"), "DOGE-USDT");

  const wrongMark = fixture({ symbol: "DOGE-USDT", markSymbol: "BTC-USDT" });
  await assert.rejects(
    wrongMark.api.getVstMarkPrice("DOGEUSDT"), /mismatched VST mark-price symbol/,
  );
  assert.equal(wrongMark.calls.some(({ url }) => url.pathname.endsWith("/ticker")), true);
  assert.equal(wrongMark.calls.some(({ options }) => options?.method === "POST"), false);

  const wrongQuote = fixture({
    symbol: "DOGE-USDT",
    markTimestamp: 0,
    ticker: {
      symbol: "BTC-USDT", askPrice: "100", bidPrice: "99.9", time: 1700000000000,
    },
  });
  await assert.rejects(
    wrongQuote.api.getVstMarkPrice("DOGEUSDT"), /quote symbol does not match/,
  );
  const staleQuote = fixture({
    symbol: "DOGE-USDT",
    markTimestamp: 0,
    ticker: { askPrice: "100", bidPrice: "99.9", time: 1699999989000 },
  });
  await assert.rejects(
    staleQuote.api.getVstMarkPrice("DOGEUSDT"), /stale or invalid/,
  );
  const crossedQuote = fixture({
    symbol: "DOGE-USDT",
    markTimestamp: 0,
    ticker: { askPrice: "100", bidPrice: "100.5", time: 1700000000000 },
  });
  await assert.rejects(
    crossedQuote.api.getVstMarkPrice("DOGEUSDT"), /stale or invalid/,
  );

  // A wide, illiquid bid/ask spread is normal on low-volume VST symbols and
  // must not be mistaken for a stale or bogus mark: any mark inside the
  // book -- even several percent away from the ask -- is corroborated.
  const wideSpread = fixture({
    symbol: "DOGE-USDT",
    markTimestamp: 0,
    markPrice: "97",
    ticker: { askPrice: "100", bidPrice: "96", time: 1700000000000 },
  });
  const wideSpreadMark = await wideSpread.api.getVstMarkPrice("DOGEUSDT");
  assert.equal(wideSpreadMark.markPrice, 97);

  // A mark outside the live book entirely (beyond the small cross-read
  // buffer) is still rejected as uncorroborated.
  const outsideBook = fixture({
    symbol: "DOGE-USDT",
    markTimestamp: 0,
    markPrice: "95",
    ticker: { askPrice: "100", bidPrice: "96", time: 1700000000000 },
  });
  await assert.rejects(
    outsideBook.api.getVstMarkPrice("DOGEUSDT"), /not corroborated by a fresh quote/,
  );
});

test("VST MARKET acknowledgements recognize lossless flat and nested IDs without extra POSTs", async () => {
  const id = "9007199254740993123";
  for (const data of [
    { orderId: id }, { orderID: id }, { order: { orderId: id } },
    { order: { orderID: id } }, { orderId: id, order: { orderID: id } },
  ]) {
    const f = fixture({
      symbol: "DOGE-USDT", longLeverage: 10, dualSidePosition: true,
      responseOverrides: [{ path: orderPath, method: "POST", remaining: 1,
        response: { code: 0, data } }],
    });
    const result = await f.api.placeVstAutomatedLong({
      symbol: "DOGEUSDT", signalAt: validSignalAt, quantity: "1",
      maxPrice: "100.0", stopLoss: "98.0", clientOrderId: "nested_market",
    });
    assert.equal(result.orderId, id);
    assert.equal(f.calls.filter(({ url, options }) =>
      url.pathname === orderPath && options.method === "POST").length, 1);
  }
});

test("ambiguous VST MARKET acknowledgements retain no-replay protection", async () => {
  for (const data of [
    { orderId: "a", order: { orderId: "b" } },
    { order: { orderId: null } }, { order: {} }, { order: null },
  ]) {
    const f = fixture({
      symbol: "DOGE-USDT", longLeverage: 10, dualSidePosition: true,
      responseOverrides: [{ path: orderPath, method: "POST", remaining: 1,
        response: { code: 0, data } }],
    });
    const attempt = {
      symbol: "DOGEUSDT", signalAt: validSignalAt, quantity: "1",
      maxPrice: "100.0", stopLoss: "98.0", clientOrderId: "ambiguous_nested_market",
    };
    await assert.rejects(f.api.placeVstAutomatedLong(attempt), /missing or conflicting/);
    await assert.rejects(f.api.placeVstAutomatedLong(attempt), /already submitted/);
    assert.equal(f.calls.filter(({ url, options }) =>
      url.pathname === orderPath && options.method === "POST").length, 1);
  }
});

test("preparation read scope removes duplicates but retains native final and post-write guards", async () => {
  const time = { now: 1700000000000 };
  const f = fixture({ symbol: "DOGE-USDT", longLeverage: 75, shortLeverage: 3,
    dualSidePosition: true, timeState: time,
    requestPacer: { deferFor() {}, async waitForSlot() { time.now += 1100; } },
  });
  await f.api.withVstPreparationReads("DOGEUSDT", async () => {
    await Promise.all([
      f.api.getPositionMode(), f.api.getMarginType("DOGEUSDT"),
      f.api.getLeverage("DOGEUSDT"), f.api.getPositions("DOGEUSDT"),
      f.api.getOpenOrders("DOGEUSDT"),
    ]);
    const result = await f.api.setVstLongLeverage10("DOGEUSDT");
    assert.equal(result.longLeverage, 10);
    assert.equal(result.shortLeverage, 3);
    assert.equal(result.verified, true);
  });
  const count = (path) => f.calls.filter(({ url, options }) =>
    url.pathname === path && options.method === "GET").length;
  assert.equal(count("/openApi/swap/v1/positionSide/dual"), 2);
  assert.equal(count("/openApi/swap/v2/trade/marginType"), 2);
  assert.equal(count(leveragePath), 3);
  // A later operation has no reusable exchange snapshots.
  await f.api.getLeverage("DOGEUSDT");
  assert.equal(count(leveragePath), 4);
});

test("preparation final guard refuses an exposure that appears after the reused initial cohort", async () => {
  const f = fixture({ symbol: "DOGE-USDT", longLeverage: 75, dualSidePosition: true,
    responseOverrides: [{
      path: "/openApi/swap/v2/user/positions", method: "GET", remaining: 1,
      response: { code: 0, data: [] },
    }],
  });
  await f.api.withVstPreparationReads("DOGEUSDT", async () => {
    await f.api.getPositions("DOGEUSDT");
    // The native initial read uses the genuine first cohort. Its mandatory
    // final guard must see this later exposure and must not issue a POST.
    f.state.positions = [{
      symbol: "DOGE-USDT", positionId: "other-position",
      positionSide: "LONG", positionAmt: "1",
    }];
    await assert.rejects(f.api.setVstLongLeverage10("DOGEUSDT"), /final pre-sign check failed/);
  });
  assert.equal(f.calls.some(({ options }) => options.method !== "GET"), false);
});

test("preparation read scopes isolate symbols, callers and returned mutable rows", async () => {
  const f = fixture({ symbol: "DOGE-USDT" });
  await f.api.withVstPreparationReads("DOGEUSDT", async () => {
    const first = await f.api.getPositions();
    first.push({ injected: true });
    assert.deepEqual(await f.api.getPositions(), []);
    await f.api.getPositions("ETHUSDT");
    await f.api.getPositions("ETHUSDT");
  });
  await f.api.withVstPreparationReads("DOGEUSDT", () => f.api.getPositions());
  assert.equal(f.calls.filter(({ url }) => url.pathname.endsWith("/user/positions")).length, 4);
});

test("preparation reuse expires with pacing age, clock rollback and scope completion", async () => {
  const time = { now: 1700000000000 };
  const f = fixture({ symbol: "DOGE-USDT", timeState: time });
  const count = () => f.calls.filter(({ url }) => url.pathname === leveragePath).length;
  await f.api.withVstPreparationReads("DOGEUSDT", async () => {
    await f.api.getLeverage("DOGEUSDT");
    await f.api.getLeverage("DOGEUSDT");
    assert.equal(count(), 1);
    time.now += 10001;
    await f.api.getLeverage("DOGEUSDT");
    assert.equal(count(), 2);
    time.now -= 1;
    await f.api.getLeverage("DOGEUSDT");
    assert.equal(count(), 3);
  });
  await f.api.getLeverage("DOGEUSDT");
  assert.equal(count(), 4);
});

test("preparation scope never caches trading prices or a failed native read", async () => {
  const f = fixture({ symbol: "DOGE-USDT",
    responseSequences: { [leveragePath]: [{ code: 100001 }, { code: 0 }] },
  });
  await f.api.withVstPreparationReads("DOGEUSDT", async () => {
    await assert.rejects(f.api.getLeverage("DOGEUSDT"));
    await f.api.getLeverage("DOGEUSDT");
    await f.api.getLeverage("DOGEUSDT");
    await f.api.getVstMarkPrice("DOGEUSDT");
    await f.api.getVstMarkPrice("DOGEUSDT");
  });
  assert.equal(f.calls.filter(({ url }) => url.pathname === leveragePath).length, 3);
  assert.equal(f.calls.filter(({ url }) => url.pathname.endsWith("/premiumIndex")).length, 2);
});

test("automated VST LONG entry submits a protected MARKET order with the exact signal stop", async () => {
  const { api, calls } = fixture({
    symbol: "DOGE-USDT",
    dualSidePosition: true,
    longLeverage: 10,
    shortLeverage: 3,
  });
  await api.placeVstAutomatedLong({
    symbol: "DOGEUSDT",
    signalAt: validSignalAt,
    quantity: "1",
    maxPrice: "100.0",
    stopLoss: "98.0",
    clientOrderId: "vsa_entry-1",
    policy: VST_AUTOMATED_LONG_POLICY,
  });
  const entry = calls.find(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST");
  assert.ok(entry);
  assert.equal(entry.url.origin, "https://open-api-vst.bingx.com");
  assert.equal(entry.url.searchParams.get("symbol"), "DOGE-USDT");
  assert.equal(entry.url.searchParams.get("positionSide"), "LONG");
  assert.equal(entry.url.searchParams.get("type"), "MARKET");
  assert.equal(entry.url.searchParams.has("price"), false);
  assert.equal(entry.url.searchParams.has("timeInForce"), false);
  assert.equal(entry.url.searchParams.get("quantity"), "1");
  assert.deepEqual(JSON.parse(entry.url.searchParams.get("stopLoss")), {
    type: "STOP_MARKET", stopPrice: 98,
  });
  assert.ok(calls.some(({ url, options }) =>
    url.pathname === leveragePath && options.method === "GET"));

  const ambiguous = fixture({
    symbol: "DOGE-USDT", dualSidePosition: true, longLeverage: 10,
    shortLeverage: 3, failEntryPost: true,
  });
  const attempt = {
    symbol: "DOGEUSDT", quantity: "1", maxPrice: "100.0",
    stopLoss: "98.0", clientOrderId: "vsa_unknown", signalAt: validSignalAt,
  };
  await assert.rejects(ambiguous.api.placeVstAutomatedLong(attempt), /request failed/);
  await assert.rejects(
    ambiguous.api.placeVstAutomatedLong(attempt), /already submitted/,
  );
  assert.equal(ambiguous.calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST").length, 1);

  const overBudget = fixture({
    symbol: "DOGE-USDT", dualSidePosition: true, longLeverage: 10, shortLeverage: 3,
  });
  await assert.rejects(overBudget.api.placeVstAutomatedLong({
    symbol: "DOGEUSDT", quantity: "1.01", maxPrice: "100.0",
    stopLoss: "98.0", clientOrderId: "vsa_over", signalAt: validSignalAt,
  }), /one percent/);
  assert.equal(overBudget.calls.some(({ options }) => options.method === "POST"), false);

  const wrongMode = fixture({ symbol: "DOGE-USDT", longLeverage: 10, shortLeverage: 3 });
  await assert.rejects(wrongMode.api.placeVstAutomatedLong({
    symbol: "DOGEUSDT", quantity: "1", maxPrice: "100.0",
    stopLoss: "98.0", clientOrderId: "vsa_one-way", signalAt: validSignalAt,
  }), /HEDGE/);
  assert.equal(wrongMode.calls.some(({ options }) => options.method === "POST"), false);

  const mainnet = fixture({ environment: "mainnet" });
  await assert.rejects(mainnet.api.placeVstAutomatedLong({
    symbol: "BTCUSDT", quantity: "0.01", maxPrice: "100.0",
    stopLoss: "98.0", clientOrderId: "vsa_mainnet", signalAt: validSignalAt,
  }), /outside VST/);
  assert.equal(mainnet.calls.length, 0);
});

test("automated entry signs only after the final shared-pacer wait and fresh pre-sign quote", async () => {
  const timeState = { now: 1700000000000 };
  const requestPacer = createBingXOutboundPacer({
    gapMs: 1000,
    clock: () => timeState.now,
    sleep: async (ms) => { timeState.now += ms; },
  });
  const { api, calls } = fixture({
    timeState,
    requestPacer,
    advanceClockOnSleep: true,
    advanceClockOnTickerReadMs: 1,
    symbol: "DOGE-USDT",
    dualSidePosition: true,
    longLeverage: 10,
    shortLeverage: 3,
  });
  await api.placeVstAutomatedLong({
    symbol: "DOGEUSDT",
    signalAt: new Date(timeState.now).toISOString(),
    quantity: "1",
    maxPrice: "100.0",
    stopLoss: "98.0",
    clientOrderId: "vsa_pacer_before_sign",
    policy: VST_AUTOMATED_LONG_POLICY,
  });

  const entryIndex = calls.findIndex(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST");
  assert.notEqual(entryIndex, -1);
  const finalTicker = [...calls.slice(0, entryIndex)].reverse().find(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/ticker");
  assert.ok(finalTicker, "final market quote is read before entry");
  const entry = calls[entryIndex];
  assert.ok(entry.startedAt - finalTicker.startedAt >= 1000,
    "nested beforeSign quote does not reserve or consume the signed POST's slot");
  assert.equal(Number(entry.url.searchParams.get("timestamp")), entry.startedAt,
    "signature timestamp is generated after the final pacer wait");
});

test("automated VST LONG rejects expired signals immediately before signing", async () => {
  const expired = fixture({
    symbol: "DOGE-USDT",
    dualSidePosition: true,
    longLeverage: 10,
    shortLeverage: 3,
  });
  await assert.rejects(expired.api.placeVstAutomatedLong({
    symbol: "DOGEUSDT",
    signalAt: new Date(1700000000000 - 10 * 60_000 - 1).toISOString(),
    quantity: "1",
    maxPrice: "100.0",
    stopLoss: "98.0",
    clientOrderId: "vsa_expired",
  }), (error) => error.preSignReason === "signal_expired" &&
    error.transportStage === "pre_transport");
  assert.equal(expired.calls.some(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST"), false);
});

test("VST final ticker error envelope is rejected before data and retains provider details", async () => {
  const rejectedQuote = fixture({
    symbol: "DOGE-USDT",
    dualSidePosition: true,
    longLeverage: 10,
    shortLeverage: 3,
    tickerResponseCode: 109418,
    tickerErrorMessage: "DOGE-USDT is offline currently",
    ticker: null,
  });
  await assert.rejects(rejectedQuote.api.placeVstAutomatedLong({
    symbol: "DOGEUSDT",
    signalAt: validSignalAt,
    quantity: "1",
    maxPrice: "100.0",
    stopLoss: "98.0",
    clientOrderId: "vsa_ticker-error",
  }), (error) => error.code === 109418 &&
    error.exchangeMessage === "DOGE-USDT is offline currently" &&
    error.preSignReason === "final_quote_unavailable_or_stale");
  assert.equal(rejectedQuote.calls.some(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST"), false);
});

test("automated VST LONG accepts affordable top-up risk but blocks an unaffordable final risk", async () => {
  const initiallyPositiveRisk = fixture({
    symbol: "DOGE-USDT",
    dualSidePosition: true,
    longLeverage: 10,
    shortLeverage: 3,
    fundingRatesByRead: ["0.08"],
  });
  await initiallyPositiveRisk.api.placeVstAutomatedLong({
    symbol: "DOGEUSDT",
    signalAt: validSignalAt,
    quantity: "1",
    maxPrice: "100.0",
    stopLoss: "98.0",
    clientOrderId: "vsa_initial-risk",
  });
  assert.equal(initiallyPositiveRisk.calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST").length, 1);
  assert.equal(initiallyPositiveRisk.calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/user/commissionRate").length, 1,
  "complete fee/risk preflight runs only once, just before signing");

  const balanceAfterReadiness = [{ asset: "VST", balance: "1200", availableMargin: "20" }];
  const changedRisk = fixture({
    symbol: "DOGE-USDT",
    dualSidePosition: true,
    longLeverage: 10,
    shortLeverage: 3,
    balanceByRead: [
      undefined, balanceAfterReadiness,
    ],
    // The only full preflight is now the final one. Present the adverse risk
    // at that read rather than requiring a redundant earlier preflight.
    feeRatesByRead: [
      { makerCommissionRate: "0.0002", takerCommissionRate: "0.04" },
    ],
    fundingRatesByRead: ["0.08"],
    markPricesByRead: ["99"],
    tickerByRead: [{ askPrice: "99.8", bidPrice: "99.7", time: 1700000000000 }],
  });
  await assert.rejects(changedRisk.api.placeVstAutomatedLong({
    symbol: "DOGEUSDT",
    signalAt: validSignalAt,
    quantity: "1",
    maxPrice: "100.0",
    stopLoss: "98.0",
    clientOrderId: "vsa_changed-risk",
  }), (error) => error.message === "BingX final pre-sign check failed" &&
    error.preSignReason === "final_preflight_blocked" &&
    error.transportStage === "pre_transport");
  assert.equal(changedRisk.calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST").length, 0);
  assert.equal(changedRisk.calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/user/commissionRate").length, 1);
  assert.equal(changedRisk.calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/premiumIndex").length, 1);
});

test("automated VST LONG treats the planning top-up as an estimate, not a fixed ceiling", async () => {
  const makeRisk = () => fixture({
    symbol: "DOGE-USDT",
    dualSidePosition: true,
    longLeverage: 10,
    shortLeverage: 3,
    fundingRatesByRead: ["0.0001", "0.0001"],
  });
  const unapproved = makeRisk();
  await unapproved.api.placeVstAutomatedLong({
    symbol: "DOGEUSDT", signalAt: validSignalAt, quantity: "1", maxPrice: "100.0",
    stopLoss: "85.0", clientOrderId: "vsa_topup_missing",
  });
  assert.equal(unapproved.calls.some(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST"), true);

  const mismatched = makeRisk();
  await mismatched.api.placeVstAutomatedLong({
    symbol: "DOGEUSDT", signalAt: validSignalAt, quantity: "1", maxPrice: "100.0",
    stopLoss: "85.0", clientOrderId: "vsa_topup_wrong", approvedTopUpMargin: "0.01",
  });
  assert.equal(mismatched.calls.some(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST"), true);

  const approved = makeRisk();
  const expected = await approved.api.preflight("DOGEUSDT", {
    requiredMargin: 10,
    quantity: "1",
    entryPrice: "100.0",
    stopLoss: "85.0",
    automatedLongPolicy: VST_AUTOMATED_LONG_POLICY,
  });
  assert.equal(expected.status, "ready");
  assert.ok(expected.plannedTopUpMargin > 0);
  await approved.api.placeVstAutomatedLong({
    symbol: "DOGEUSDT", signalAt: validSignalAt, quantity: "1", maxPrice: "100.0",
    stopLoss: "85.0", clientOrderId: "vsa_topup_approved",
    approvedTopUpMargin: String(expected.plannedTopUpMargin),
  });
  const entry = approved.calls.find(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST");
  assert.ok(entry);
  assert.equal(entry.url.searchParams.get("type"), "MARKET");
  assert.equal(entry.url.searchParams.has("price"), false);
  assert.equal(entry.url.searchParams.has("timeInForce"), false);
  assert.deepEqual(JSON.parse(entry.url.searchParams.get("stopLoss")), {
    type: "STOP_MARKET", stopPrice: 85,
  });

  const changedRisk = makeRisk();
  const expectedChanged = await changedRisk.api.preflight("DOGEUSDT", {
    requiredMargin: 10, quantity: "1", entryPrice: "100.0", stopLoss: "85.0",
    automatedLongPolicy: VST_AUTOMATED_LONG_POLICY,
  });
  changedRisk.state.fundingRatesByRead = ["0.0001", "0.001"];
  changedRisk.state.readCounts.set("/openApi/swap/v2/quote/premiumIndex", 0);
  await changedRisk.api.placeVstAutomatedLong({
    symbol: "DOGEUSDT", signalAt: validSignalAt, quantity: "1", maxPrice: "100.0",
    stopLoss: "85.0", clientOrderId: "vsa_topup_changed",
    approvedTopUpMargin: String(expectedChanged.plannedTopUpMargin),
  });
  assert.equal(changedRisk.calls.some(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST"), true);

  const reducedRisk = fixture({
    symbol: "DOGE-USDT",
    dualSidePosition: true,
    longLeverage: 10,
    shortLeverage: 3,
    fundingRatesByRead: ["0.01"],
  });
  const reducedPlan = await reducedRisk.api.preflight("DOGEUSDT", {
    requiredMargin: 10, quantity: "1", entryPrice: "100.0", stopLoss: "91.8",
    automatedLongPolicy: VST_AUTOMATED_LONG_POLICY,
  });
  assert.ok(reducedPlan.plannedTopUpMargin > 0);
  reducedRisk.state.fundingRatesByRead = ["0.01", "0"];
  reducedRisk.state.readCounts.set("/openApi/swap/v2/quote/premiumIndex", 0);
  await reducedRisk.api.placeVstAutomatedLong({
    symbol: "DOGEUSDT", signalAt: validSignalAt, quantity: "1", maxPrice: "100.0",
    stopLoss: "91.8", clientOrderId: "vsa_topup_reduced_risk",
    approvedTopUpMargin: String(reducedPlan.plannedTopUpMargin),
  });
  assert.ok(reducedRisk.calls.some(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST" &&
    url.searchParams.get("type") === "MARKET"),
  "a decrease to zero risk does not invalidate the previously approved top-up");
});

test("signed nonzero-funding deep-stop plan is accepted by the real VST entry adapter", async () => {
  const { api, calls } = fixture({
    symbol: "DOGE-USDT",
    dualSidePosition: true,
    longLeverage: 10,
    shortLeverage: 3,
    fundingRatesByRead: ["0.0001", "0.0001"],
  });
  const symbol = "DOGEUSDT";
  const [balanceSnapshot, mark, filters, fees, funding, tiers, leverage] = await Promise.all([
    api.getBalance(),
    api.getVstMarkPrice(symbol),
    api.contract(symbol),
    api.getFeeRate(symbol),
    api.getFunding(symbol),
    api.getRiskTiers(symbol),
    api.getLeverage(symbol),
  ]);
  const sizing = sizeVstLongTrade({
    environment: "vst",
    symbol,
    balanceSnapshot,
    quote: { price: mark.markPrice, observedAtMs: mark.timestamp },
    nowMs: mark.timestamp,
    maxQuoteAgeMs: 10_000,
    expectedPrice: "100",
    maxPriceMoveBps: 500,
    maxSlippageBps: 50,
    stopLoss: "85.0",
    filters,
    takerFeeRate: fees.taker,
    fundingRate: funding.rate,
    maintenanceMarginRate: tiers[0].maintenanceMarginRate,
    stopBufferRate: 0.005,
    tickSize: 10 ** -filters.pricePrecision,
    maxPositionValue: leverage.maxPositionLongVal,
  });
  assert.equal(funding.rate, 0.0001);
  assert.equal(sizing.status, "ready");
  assert.equal(sizing.fundingRate, funding.rate);
  assert.ok(sizing.plannedTopUpVst > 0);
  const adapterPlan = await api.preflight(symbol, {
    requiredMargin: sizing.initialBudgetVst,
    quantity: sizing.quantity,
    entryPrice: sizing.maxEntryPrice,
    stopLoss: sizing.stopLoss,
    automatedLongPolicy: VST_AUTOMATED_LONG_POLICY,
  });
  assert.equal(adapterPlan.status, "ready");
  assert.equal(adapterPlan.plannedTopUpMargin, sizing.plannedTopUpVst);

  await api.placeVstAutomatedLong({
    symbol,
    signalAt: validSignalAt,
    quantity: sizing.quantity,
    maxPrice: sizing.maxEntryPrice,
    stopLoss: sizing.stopLoss,
    clientOrderId: "vsa_planner_funding_topup",
    approvedTopUpMargin: String(sizing.plannedTopUpVst),
  });

  const entry = calls.find(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST" &&
      url.searchParams.get("type") === "MARKET");
  assert.ok(entry, "planner-approved top-up reaches the protected MARKET entry");
  assert.equal(entry.url.searchParams.get("quantity"), sizing.quantity);
  assert.deepEqual(JSON.parse(entry.url.searchParams.get("stopLoss")), {
    type: "STOP_MARKET", stopPrice: Number(sizing.stopLoss),
  });
  assert.ok(calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/premiumIndex").length >= 4,
  "signed funding reads are included in initial and final preflight");
});

test("VST automated stop upgrade verifies coexistence before cancel and verifies exact new coverage afterward", async () => {
  const oldStop = {
    symbol: "BTC-USDT", orderId: "old-stop", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "position-upgrade",
    origQty: "0.1", stopPrice: "90.0", workingType: "MARK_PRICE", mainOrderId: "",
  };
  const { api, calls, state } = fixture({
    dualSidePosition: true,
    longLeverage: 10,
    shortLeverage: 25,
    positions: [{
      symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
      positionId: "position-upgrade",
    }],
    orders: [oldStop],
    stopPostResponse: { order: { orderId: "new-stop" } },
  });
  const discovered = await api.discoverVstAutomatedLongStop({
    symbol: "BTCUSDT", quantity: "0.1", positionId: "position-upgrade",
    entryOrderId: "entry-1", expectedStopPrice: "90.0",
  });
  assert.equal(discovered.verified, true);
  assert.equal(discovered.stopOrderId, "old-stop");
  let submissionReadState;
  const result = await api.upgradeVstLongStop({
    symbol: "BTCUSDT", quantity: "0.1", positionId: "position-upgrade",
    entryOrderId: "entry-1", previousStopOrderId: "old-stop",
    previousStopPrice: "90.0", stopPrice: "95.0",
    onSubmission: async ({ exchangeOrderId }) => {
      submissionReadState = {
        exchangeOrderId,
        openOrdersReadCount: calls.filter(({ url, options }) =>
          url.pathname.endsWith("/openOrders") && options.method === "GET").length,
      };
    },
  });
  assert.equal(result.verified, true);
  assert.equal(result.newStopOrderId, "new-stop");
  assert.equal(result.exchangeOrderId, "new-stop");
  assert.deepEqual(submissionReadState, {
    exchangeOrderId: "new-stop",
    openOrdersReadCount: 3,
  }, "durable submission callback runs after POST ID capture and before verification reads");
  assert.deepEqual(state.orders.map((order) => order.orderId), ["new-stop"]);
  const postIndex = calls.findIndex(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST" &&
    url.searchParams.get("type") === "STOP_MARKET");
  const deleteIndex = calls.findIndex(({ url, options }) =>
    url.pathname === orderPath && options.method === "DELETE");
  assert.ok(postIndex >= 0 && deleteIndex > postIndex);
  assert.equal(calls[deleteIndex].url.searchParams.get("orderId"), "old-stop");
  const openOrderReadsBeforeDelete = calls.slice(postIndex + 1, deleteIndex)
    .filter(({ url, options }) =>
      url.pathname.endsWith("/openOrders") && options.method === "GET");
  assert.ok(openOrderReadsBeforeDelete.length >= 1);
  assert.ok(openOrderReadsBeforeDelete.some(({ ordersAtCall }) =>
    ordersAtCall.length === 2 &&
    ordersAtCall.some((order) => order.orderId === "old-stop") &&
    ordersAtCall.some((order) => order.orderId === "new-stop")));

  const wrongParent = fixture({
    dualSidePosition: true,
    longLeverage: 10,
    shortLeverage: 25,
    positions: [{
      symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
      positionId: "position-upgrade",
    }],
    orders: [{ ...oldStop, mainOrderId: "different-entry" }],
  });
  await assert.rejects(wrongParent.api.upgradeVstLongStop({
    symbol: "BTCUSDT", quantity: "0.1", positionId: "position-upgrade",
    entryOrderId: "entry-1", previousStopOrderId: "old-stop",
    previousStopPrice: "90.0", stopPrice: "95.0",
  }), (error) => {
    assert.match(error.message, /original protective stop is not independently verified/);
    assert.equal(error.exchangeOrderId, undefined,
      "pre-POST refusals must not claim a native submission ID");
    return true;
  });
  assert.equal(wrongParent.calls.some(({ options }) => options.method === "POST"), false);

  const mainnet = fixture({ environment: "mainnet" });
  await assert.rejects(mainnet.api.upgradeVstLongStop({
    symbol: "BTCUSDT", quantity: "0.1", positionId: "position",
    previousStopOrderId: "old", previousStopPrice: "90", stopPrice: "95",
  }), /outside VST/);
  assert.equal(mainnet.calls.length, 0);
});

test("paced native stop upgrade keeps final guards and coverage without duplicate quote/coexistence reads", async () => {
  const time = { now: 1700000000000 };
  const f = fixture({
    timeState: time, dualSidePosition: true, longLeverage: 10,
    requestPacer: createBingXOutboundPacer({
      gapMs: 1100, clock: () => time.now,
      sleep: async (ms) => { time.now += ms; },
    }),
    markTimestamp: 0,
    advanceClockOnTickerReadMs: 1,
    positions: [{
      symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
      positionId: "paced-position", markPrice: "100", currency: "VST",
    }],
    orders: [{
      symbol: "BTC-USDT", orderId: "old-paced-stop", type: "STOP_MARKET",
      status: "NEW", side: "SELL", positionSide: "LONG",
      positionId: "paced-position", origQty: "0.1", stopPrice: "90",
      workingType: "MARK_PRICE",
    }],
    stopOrderIdOverride: "new-paced-stop",
    stopPostResponse: { order: { orderId: "new-paced-stop" } },
  });
  const result = await f.api.upgradeVstLongStop({
    symbol: "BTCUSDT", quantity: "0.1", positionId: "paced-position",
    entryOrderId: "entry-paced", previousStopOrderId: "old-paced-stop",
    previousStopPrice: "90", stopPrice: "95",
  });
  assert.equal(result.verified, true);
  const post = f.calls.findIndex(({ options }) => options.method === "POST");
  const cancel = f.calls.findIndex(({ options }) => options.method === "DELETE");
  assert.ok(post >= 0 && cancel > post);
  assert.equal(f.calls.filter(({ url }) => url.pathname.endsWith("/premiumIndex")).length, 1,
    "the single mark read belongs to the final submission guard");
  const beforeCancel = f.calls.slice(post + 1, cancel);
  assert.equal(beforeCancel.filter(({ url }) => url.pathname.endsWith("/openOrders")).length, 1);
  assert.ok(beforeCancel.some(({ ordersAtCall }) =>
    ordersAtCall.length === 2 &&
    ordersAtCall.some(({ orderId }) => orderId === "old-paced-stop") &&
    ordersAtCall.some(({ orderId }) => orderId === "new-paced-stop")));
  assert.deepEqual(f.state.orders.map(({ orderId }) => orderId), ["new-paced-stop"]);
  assert.ok(time.now - 1700000000000 <= 32_000,
    `bounded paced native protocol took ${time.now - 1700000000000}ms`);
});

function journalUpgradeFixture({ failStopPostAfterApply = false } = {}) {
  const f = fixture({
    dualSidePosition: true, longLeverage: 10,
    positions: [{ symbol: "BTC-USDT", positionSide: "LONG",
      positionAmt: "0.1", positionId: "journal-position" }],
    orders: [{ symbol: "BTC-USDT", orderId: "1001", type: "STOP_MARKET",
      status: "NEW", side: "SELL", positionSide: "LONG", positionId: "journal-position",
      origQty: "0.1", stopPrice: "90", workingType: "MARK_PRICE" }],
    stopOrderIdOverride: "1002", stopPostResponse: { order: { orderId: "1002" } },
    failStopPostAfterApply,
  });
  const args = { symbol: "BTCUSDT", quantity: "0.1", positionId: "journal-position",
    entryOrderId: "999", previousStopOrderId: "1001", previousStopPrice: "90", stopPrice: "95" };
  return { ...f, args };
}

test("a stop preflight scope removes repeated initial native reads but not the final write guard", async () => {
  const time = { now: 1700000000000 };
  const f = fixture({
    timeState: time, dualSidePosition: true, longLeverage: 10,
    requestPacer: createBingXOutboundPacer({
      gapMs: 1100, clock: () => time.now,
      sleep: async (ms) => { time.now += ms; },
    }),
    positions: [{
      symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
      positionId: "scope-position", markPrice: "100", currency: "VST",
    }],
    orders: [{
      symbol: "BTC-USDT", orderId: "scope-old", type: "STOP_MARKET",
      status: "NEW", side: "SELL", positionSide: "LONG",
      positionId: "scope-position", origQty: "0.1", stopPrice: "90",
      workingType: "MARK_PRICE",
    }],
    stopPostResponse: { orderId: "scope-new" }, stopOrderIdOverride: "scope-new",
  });
  await f.api.withVstPreparationReads("BTCUSDT", async () => {
    await Promise.all([
      f.api.getPositionMode(), f.api.getMarginType("BTCUSDT"),
      f.api.getLeverage("BTCUSDT"), f.api.getPositions("BTCUSDT"),
      f.api.getOpenOrders("BTCUSDT"), f.api.contract("BTCUSDT"),
    ]);
    const preflightEnd = f.calls.length;
    await f.api.upgradeVstLongStop({
      symbol: "BTCUSDT", quantity: "0.1", positionId: "scope-position",
      entryOrderId: "scope-entry", previousStopOrderId: "scope-old",
      previousStopPrice: "90", stopPrice: "95", operationId: "scoped-upgrade",
    });
    const post = f.calls.findIndex(({ options }) => options.method === "POST");
    const beforePost = f.calls.slice(preflightEnd, post);
    // These are the fresh beforeSign reads. The repeated initial native
    // cohort has used the private preflight, not added another five GETs.
    for (const suffix of ["/positions", "/openOrders", "/leverage", "/marginType", "/positionSide/dual"]) {
      assert.equal(beforePost.filter(({ url }) => url.pathname.endsWith(suffix)).length,
        suffix === "/positions" ? 2 : 1, suffix);
    }
  });
  assert.deepEqual(f.state.orders.map(({ orderId }) => orderId), ["scope-new"]);
  assert.ok(time.now - 1700000000000 <= 34_000,
    `paced preflight + native transfer took ${time.now - 1700000000000}ms`);
});

test("a cached stop preflight never hides exposure changed before the final POST guard", async () => {
  const f = journalUpgradeFixture();
  await assert.rejects(f.api.withVstPreparationReads("BTCUSDT", async () => {
    await Promise.all([f.api.getPositions("BTCUSDT"), f.api.getOpenOrders("BTCUSDT")]);
    f.state.positions[0].positionAmt = "0.2";
    await f.api.upgradeVstLongStop({
      symbol: "BTCUSDT", quantity: "0.1", positionId: "journal-position",
      previousStopOrderId: "1001", previousStopPrice: "90",
      stopPrice: "95", operationId: "changed-after-preflight",
    });
  }), /final pre-sign check failed/);
  assert.ok(f.calls.every(({ options }) => options.method === "GET"));
});

test("native stop transfer journals each boundary before its transport and saves the POST ID before any DELETE", async () => {
  const f = journalUpgradeFixture();
  const phases = [];
  const journal = createStopTransferJournal({
    request: { operation: "raise_stop", symbol: "BTCUSDT", stopTransferProtocol: 1 },
    async persist(expected, progress) {
      phases.push(progress.stage);
      const posts = f.calls.filter(c => c.options.method === "POST").length;
      const deletes = f.calls.filter(c => c.options.method === "DELETE").length;
      if (progress.stage === "post_started") assert.equal(posts, 0);
      if (progress.stage === "post_acknowledged") {
        assert.equal(posts, 1);
        assert.equal(progress.newStopOrderId, "1002");
        assert.equal(deletes, 0);
      }
      if (progress.stage === "cancel_started") assert.equal(deletes, 0);
      return true;
    },
  });
  const result = await f.api.withStopTransferJournal(journal, () => f.api.upgradeVstLongStop(f.args));
  assert.equal(result.verified, true);
  assert.deepEqual(phases, ["post_started", "post_acknowledged", "cancel_started", "cancel_acknowledged"]);
  assert.deepEqual(f.state.orders.map(o => o.orderId), ["1002"]);
});

test("lost native POST response retains old protection and cannot trigger DELETE or POST retry", async () => {
  const f = journalUpgradeFixture({ failStopPostAfterApply: true });
  const journal = createStopTransferJournal({
    request: { operation: "raise_stop", symbol: "BTCUSDT", stopTransferProtocol: 1 },
    persist: async () => true,
  });
  await assert.rejects(f.api.withStopTransferJournal(journal, () => f.api.upgradeVstLongStop(f.args)));
  assert.equal(journal.getProgress().stage, "post_started");
  assert.deepEqual(f.state.orders.map(o => o.orderId), ["1001", "1002"]);
  assert.equal(f.calls.filter(c => c.options.method === "DELETE").length, 0);
  await assert.rejects(f.api.withStopTransferJournal(journal, () => f.api.upgradeVstLongStop(f.args)));
  assert.equal(f.calls.filter(c => c.options.method === "POST").length, 1);
});

test("failed durable acknowledgement prevents cancellation despite a successful replacement POST", async () => {
  const f = journalUpgradeFixture();
  const journal = createStopTransferJournal({
    request: { operation: "raise_stop", symbol: "BTCUSDT", stopTransferProtocol: 1 },
    persist: async (expected, next) => next.stage !== "post_acknowledged",
  });
  await assert.rejects(f.api.withStopTransferJournal(journal, () => f.api.upgradeVstLongStop(f.args)));
  assert.deepEqual(f.state.orders.map(o => o.orderId), ["1001", "1002"]);
  assert.equal(f.calls.filter(c => c.options.method === "DELETE").length, 0);
});

test("failed pre-POST persistence releases only the unsent reservation so a guarded first attempt remains possible", async () => {
  const f = journalUpgradeFixture();
  const request = { operation: "raise_stop", symbol: "BTCUSDT", stopTransferProtocol: 1 };
  const failed = createStopTransferJournal({ request, persist: async () => false });
  await assert.rejects(f.api.withStopTransferJournal(failed, () => f.api.upgradeVstLongStop(f.args)));
  assert.equal(f.calls.filter(c => c.options.method !== "GET").length, 0);
  const fresh = createStopTransferJournal({ request, persist: async () => true });
  const result = await f.api.withStopTransferJournal(fresh, () => f.api.upgradeVstLongStop(f.args));
  assert.equal(result.verified, true);
  assert.equal(f.calls.filter(c => c.options.method === "POST").length, 1);
});

test("VST equal-price native stop upgrade is rejected with explicit pre-mutation provenance", async () => {
  const oldStop = {
    symbol: "BTC-USDT", orderId: "old-stop", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "position-upgrade",
    origQty: "0.1", stopPrice: "90.0", workingType: "MARK_PRICE", mainOrderId: "",
  };
  const { api, calls } = fixture({
    dualSidePosition: true,
    longLeverage: 10,
    shortLeverage: 25,
    positions: [{
      symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
      positionId: "position-upgrade",
    }],
    orders: [oldStop],
  });

  await assert.rejects(api.upgradeVstLongStop({
    symbol: "BTCUSDT", quantity: "0.1", positionId: "position-upgrade",
    entryOrderId: "entry-1", previousStopOrderId: "old-stop",
    previousStopPrice: "90.0", stopPrice: "90.0",
  }), (error) => {
    assert.equal(error.message, "VST protective stop upgrades may only raise the stop");
    assert.deepEqual(error.mutationProvenance, {
      operation: "raise_stop",
      method: "POST",
      phase: "pre_mutation_guard",
      mutationRequestSent: false,
      reason: "non_increasing_stop",
    });
    assert.equal(Object.isFrozen(error.mutationProvenance), true);
    return true;
  });
  assert.equal(calls.some(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST"), false);
});

test("unverified replacement stop retains its exact POST ID and is never cancelled or reposted", async () => {
  const oldStop = {
    symbol: "BTC-USDT", orderId: "old-stop", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "position-upgrade",
    origQty: "0.1", stopPrice: "90.0", workingType: "MARK_PRICE", mainOrderId: "",
  };
  const postedStop = {
    symbol: "BTC-USDT", orderId: "native-new-stop-id",
    type: "STOP_MARKET", status: "NEW", side: "SELL", positionSide: "LONG",
    positionId: "position-upgrade", origQty: "0.1", stopPrice: "95.0",
    workingType: "MARK_PRICE", mainOrderId: "", clientOrderId: "",
    executedQty: "0", time: 1700000000000,
  };
  const uncorroboratedOpenStop = { ...postedStop, stopPrice: "94.0" };
  const { api, calls, state } = fixture({
    dualSidePosition: true,
    longLeverage: 10,
    shortLeverage: 25,
    positions: [{
      symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
      positionId: "position-upgrade",
    }],
    orders: [oldStop],
    stopOrderIdOverride: "native-new-stop-id",
    stopPostResponse: { orderId: "native-new-stop-id" },
    responseSequences: {
      "/openApi/swap/v2/trade/openOrders": [
        { code: 0, data: [oldStop] },
        { code: 0, data: [oldStop] },
        { code: 0, data: [oldStop, uncorroboratedOpenStop] },
      ],
    },
  });
  const request = {
    symbol: "BTCUSDT", quantity: "0.1", positionId: "position-upgrade",
    entryOrderId: "entry-1", previousStopOrderId: "old-stop",
    previousStopPrice: "90.0", stopPrice: "95.0",
    onSubmission: async ({ exchangeOrderId }) => {
      assert.equal(exchangeOrderId, "native-new-stop-id");
    },
  };

  await assert.rejects(api.upgradeVstLongStop(request), (error) => {
    assert.match(error.message, /new stop is not independently verified/);
    assert.equal(error.exchangeOrderId, "native-new-stop-id");
    assert.equal(error.submittedExchangeOrderId, "native-new-stop-id");
    assert.equal(error.exchangeOrderVerified, false);
    assert.equal(error.submissionState, "submitted");
    return true;
  });
  assert.deepEqual(state.orders.map((order) => order.orderId), [
    "old-stop", "native-new-stop-id",
  ]);
  assert.equal(calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST" &&
    url.searchParams.get("type") === "STOP_MARKET").length, 1);
  assert.equal(calls.some(({ url, options }) =>
    url.pathname === orderPath && options.method === "DELETE"), false);

  await assert.rejects(api.upgradeVstLongStop(request), /already submitted; reconcile, never retry/);
  assert.equal(calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST" &&
    url.searchParams.get("type") === "STOP_MARKET").length, 1);
});

test("submission callback failure retains the POST ID and blocks verification retry or repost", async () => {
  const oldStop = {
    symbol: "BTC-USDT", orderId: "old-stop", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "position-upgrade",
    origQty: "0.1", stopPrice: "90.0", workingType: "MARK_PRICE", mainOrderId: "",
  };
  const { api, calls } = fixture({
    dualSidePosition: true,
    longLeverage: 10,
    shortLeverage: 25,
    positions: [{
      symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
      positionId: "position-upgrade",
    }],
    orders: [oldStop],
    stopOrderIdOverride: "callback-new-stop",
    stopPostResponse: { orderId: "callback-new-stop" },
  });
  const request = {
    symbol: "BTCUSDT", quantity: "0.1", positionId: "position-upgrade",
    entryOrderId: "entry-1", previousStopOrderId: "old-stop",
    previousStopPrice: "90.0", stopPrice: "95.0",
    onSubmission: async () => { throw new Error("durable store callback failed"); },
  };
  await assert.rejects(api.upgradeVstLongStop(request), (error) => {
    assert.equal(error.message, "durable store callback failed");
    assert.equal(error.exchangeOrderId, "callback-new-stop");
    assert.equal(error.submittedExchangeOrderId, "callback-new-stop");
    assert.equal(error.exchangeOrderVerified, false);
    return true;
  });
  assert.equal(calls.filter(({ url, options }) =>
    url.pathname === "/openApi/swap/v2/trade/openOrders" &&
    options.method === "GET").length, 2,
  "callback failure precedes any post-submission verification read");
  assert.equal(calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST" &&
    url.searchParams.get("type") === "STOP_MARKET").length, 1);
  assert.equal(calls.some(({ url, options }) =>
    url.pathname === orderPath && options.method === "DELETE"), false);
  await assert.rejects(api.upgradeVstLongStop(request), /already submitted; reconcile, never retry/);
  assert.equal(calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST" &&
    url.searchParams.get("type") === "STOP_MARKET").length, 1);
});

test("VST stop upgrade recovers a lossy immediate ID only from an explicitly parent-linked stop", async () => {
  const oldStop = {
    symbol: "BTC-USDT", orderId: "old-stop", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "position-upgrade",
    origQty: "0.1", stopPrice: "90.0", workingType: "MARK_PRICE",
    mainOrderId: "entry-1",
  };
  const recovered = fixture({
    dualSidePosition: true, longLeverage: 10, shortLeverage: 25,
    positions: [{
      symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
      positionId: "position-upgrade",
    }],
    orders: [oldStop],
    // This recorded numeric ID is fractional and therefore cannot be treated
    // as a lossless exchange order identifier.
    stopPostResponse: { orderId: 1234567890123456.5 },
    // Snapshot-only identity recovery requires an explicit parent link; the
    // signed POST response itself did not provide an exact ID.
    responseSequences: {
      "/openApi/swap/v2/trade/openOrders": [
        { code: 0, data: [oldStop] },
        { code: 0, data: [oldStop] },
        { code: 0, data: [oldStop, {
          symbol: "BTC-USDT", orderId: "new-stop", type: "STOP_MARKET",
          status: "NEW", side: "SELL", positionSide: "LONG",
          positionId: "position-upgrade", origQty: "0.1", stopPrice: "95.0",
          workingType: "MARK_PRICE", mainOrderId: "entry-1", executedQty: "0",
          time: 1700000000000,
        }] },
      ],
    },
  });
  const result = await recovered.api.upgradeVstLongStop({
    symbol: "BTCUSDT", quantity: "0.1", positionId: "position-upgrade",
    entryOrderId: "entry-1", previousStopOrderId: "old-stop",
    previousStopPrice: "90.0", stopPrice: "95.0",
  });
  assert.equal(result.newStopOrderId, "new-stop");
  assert.equal(result.verified, true);
  assert.deepEqual(recovered.state.orders.map((order) => order.orderId), ["new-stop"]);
  assert.ok(recovered.calls.every(({ options }) => options.redirect === "error"));

  const unlinked = fixture({
    dualSidePosition: true, longLeverage: 10, shortLeverage: 25,
    positions: [{
      symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
      positionId: "position-upgrade",
    }],
    orders: [oldStop],
    stopPostResponse: { orderId: 1234567890123456.5 },
  });
  const unlinkedRequest = {
    symbol: "BTCUSDT", quantity: "0.1", positionId: "position-upgrade",
    entryOrderId: "entry-1", previousStopOrderId: "old-stop",
    previousStopPrice: "90.0", stopPrice: "95.0",
  };
  await assert.rejects(
    unlinked.api.upgradeVstLongStop(unlinkedRequest),
    /old and new stop identities are unknown.*original stop was not cancelled/,
  );
  assert.deepEqual(unlinked.state.orders.map((order) => order.orderId), [
    "old-stop", "new-stop",
  ]);
  assert.equal(unlinked.calls.some(({ options }) => options.method === "DELETE"), false);
  await assert.rejects(
    unlinked.api.upgradeVstLongStop(unlinkedRequest),
    /already submitted; reconcile, never retry/,
  );
  assert.equal(unlinked.calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST" &&
    url.searchParams.get("type") === "STOP_MARKET").length, 1);

  const ambiguous = fixture({
    dualSidePosition: true, longLeverage: 10, shortLeverage: 25,
    positions: [{
      symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
      positionId: "position-upgrade",
    }],
    orders: [oldStop],
    stopPostResponse: {},
    duplicateStopOnPost: true,
  });
  await assert.rejects(ambiguous.api.upgradeVstLongStop({
    symbol: "BTCUSDT", quantity: "0.1", positionId: "position-upgrade",
    entryOrderId: "entry-1", previousStopOrderId: "old-stop",
    previousStopPrice: "90.0", stopPrice: "95.0",
  }), /old and new stop identities are unknown.*original stop was not cancelled/);
  assert.deepEqual(ambiguous.state.orders.map((order) => order.orderId), [
    "old-stop", "new-stop", "duplicate-new-stop",
  ]);
  assert.equal(ambiguous.calls.some(({ options }) => options.method === "DELETE"), false);
});

test("stop-upgrade acknowledgement parsing is lossless, shape-diagnostic, and never invents IDs", async () => {
  const oldStop = {
    symbol: "BTC-USDT", orderId: "old-stop", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "position-upgrade",
    origQty: "0.1", stopPrice: "90.0", workingType: "MARK_PRICE", mainOrderId: "",
  };
  const makeApi = (stopPostResponse) => fixture({
    dualSidePosition: true, longLeverage: 10, shortLeverage: 25,
    positions: [{
      symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
      positionId: "position-upgrade",
    }],
    orders: [oldStop],
    stopPostResponse,
  });
  const request = {
    symbol: "BTCUSDT", quantity: "0.1", positionId: "position-upgrade",
    entryOrderId: "entry-1", previousStopOrderId: "old-stop",
    previousStopPrice: "90.0", stopPrice: "95.0",
  };

  const zero = makeApi({ order: { orderId: 0 } });
  let zeroAcknowledgement;
  await assert.rejects(zero.api.upgradeVstLongStop({
    ...request,
    onSubmission: async ({ exchangeOrderId }) => { zeroAcknowledgement = exchangeOrderId; },
  }), (error) => {
    assert.equal(error.exchangeOrderId, "0");
    assert.equal(error.submittedExchangeOrderId, "0");
    return true;
  });
  assert.equal(zeroAcknowledgement, "0",
    "a literal zero ID is preserved as an exact acknowledgement, not treated as missing");
  assert.equal(zero.calls.some(({ url, options }) =>
    url.pathname === orderPath && options.method === "DELETE"), false);

  for (const [label, response, reason] of [
    ["conflicting flat and nested aliases", {
      orderId: "flat-id", order: { orderID: "nested-id" }, apiKey: "never expose",
    }, "conflicting_aliases"],
    ["null nested alias", {
      order: { orderId: null }, apiKey: "never expose",
    }, "null_alias"],
    ["missing identifier", {
      order: {}, apiKey: "never expose",
    }, "missing_id"],
    ["malformed nested wrapper", {
      order: null, apiKey: "never expose",
    }, "nested_order_not_object"],
    ["fractional unsafe number", {
      order: { orderId: 1234567890123456.5 }, apiKey: "never expose",
    }, "invalid_identifier"],
  ]) {
    const ambiguous = makeApi(response);
    let callbackCount = 0;
    await assert.rejects(ambiguous.api.upgradeVstLongStop({
      ...request,
      onSubmission: async () => { callbackCount += 1; },
    }), (error) => {
      assert.match(error.message, /old and new stop identities are unknown/);
      assert.deepEqual(error.detail?.acknowledgement, {
        responseType: "object",
        orderWrapper: Object.hasOwn(response, "order")
          ? response.order === null ? "null" : "object"
          : "absent",
        flatOrderIdPresent: Object.hasOwn(response, "orderId"),
        flatOrderIDPresent: Object.hasOwn(response, "orderID"),
        nestedOrderIdPresent: response.order !== null &&
          typeof response.order === "object" && Object.hasOwn(response.order, "orderId"),
        nestedOrderIDPresent: response.order !== null &&
          typeof response.order === "object" && Object.hasOwn(response.order, "orderID"),
        reason,
      });
      assert.equal(JSON.stringify(error.detail).includes("never expose"), false);
      assert.equal(error.exchangeOrderId, undefined,
        "invalid acknowledgement and unlinked discovery do not fabricate an ID");
      return true;
    }, label);
    assert.equal(callbackCount, 0, label);
    assert.equal(ambiguous.calls.filter(({ url, options }) =>
      url.pathname === orderPath && options.method === "POST" &&
      url.searchParams.get("type") === "STOP_MARKET").length, 1, label);
    assert.equal(ambiguous.calls.some(({ url, options }) =>
      url.pathname === orderPath && options.method === "DELETE"), false, label);
  }
});

test("VST adopted-stop retirement verifies both protections, cancels only old ID, and never repeats DELETE", async () => {
  const oldStop = {
    symbol: "BTC-USDT", orderId: "adopt-old", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "adopt-position",
    origQty: "0.1", stopPrice: "90.0", workingType: "MARK_PRICE", mainOrderId: "",
  };
  const newStop = {
    symbol: "BTC-USDT", orderId: "adopt-new", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "adopt-position",
    origQty: "0.1", stopPrice: "95.0", workingType: "MARK_PRICE", mainOrderId: "",
  };
  const params = {
    symbol: "BTCUSDT", policy: VST_AUTOMATED_LONG_POLICY,
    positionId: "adopt-position", entryOrderId: "entry-adopt",
    oldStopOrderId: "adopt-old", oldStopPrice: "90.0",
    newStopOrderId: "adopt-new", stopPrice: "95.0", quantity: "0.1",
    cancellationIntentId: "adopt-retire-once",
  };
  const makeRetirement = (overrides = {}) => fixture({
    dualSidePosition: true, marginType: "ISOLATED",
    longLeverage: 10, shortLeverage: 75,
    positions: [{
      symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
      positionId: "adopt-position",
    }],
    orders: [oldStop, newStop],
    activeStopQueryTransform: (order) => ({ ...order, positionId: 0 }),
    ...overrides,
  });

  const retired = makeRetirement();
  const result = await retired.api.retireVstAutomatedAdoptedStop(params);
  assert.deepEqual(result, {
    verified: true, status: "CANCELED",
    canceledStopOrderId: "adopt-old", exchangeOrderId: "adopt-old",
    newStopOrderId: "adopt-new", positionId: "adopt-position",
    quantity: "0.1", stopPrice: "95.0",
  });
  assert.deepEqual(retired.state.orders.map((order) => order.orderId), ["adopt-new"]);
  const deletes = retired.calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "DELETE");
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].url.searchParams.get("orderId"), "adopt-old");
  assert.equal(retired.calls.some(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST"), false);

  for (const [label, overrides] of [
    ["wrong position quantity", {
      positions: [{
        symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.2",
        positionId: "adopt-position",
      }],
    }],
    ["conflicting parent", {
      orders: [oldStop, { ...newStop, parentOrderId: "wrong-entry" }],
    }],
    ["nonzero execution", {
      orders: [oldStop, { ...newStop, executedQty: "0.01" }],
    }],
    ["extra active order", { orders: [oldStop, newStop, { ...newStop, orderId: "third" }] }],
    ["wrong margin mode", { marginType: "CROSSED" }],
    ["wrong hedge mode", { dualSidePosition: false }],
  ]) {
    const blocked = makeRetirement(overrides);
    await assert.rejects(blocked.api.retireVstAutomatedAdoptedStop(params), undefined, label);
    assert.equal(blocked.calls.some(({ url, options }) =>
      url.pathname === orderPath && options.method === "DELETE"), false, label);
  }

  const failedAfterDelete = makeRetirement({
    responseSequences: {
      "/openApi/swap/v2/trade/openOrders": [
        { code: 0, data: [oldStop, newStop] },
        { code: 0, data: [oldStop, newStop] },
        { code: 0, data: [oldStop, newStop] },
      ],
    },
  });
  await assert.rejects(
    failedAfterDelete.api.retireVstAutomatedAdoptedStop(params),
    /final state is not verified/,
  );
  assert.equal(failedAfterDelete.calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "DELETE").length, 1);
  await assert.rejects(
    failedAfterDelete.api.retireVstAutomatedAdoptedStop(params),
    /intent already used; reconcile, never retry/,
  );
  assert.equal(failedAfterDelete.calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "DELETE").length, 1);
});

test("VST signed POSTs reject redirects before credentials can reach another origin", async () => {
  const oldStop = {
    symbol: "BTC-USDT", orderId: "old-stop", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "position-upgrade",
    origQty: "0.1", stopPrice: "90.0", workingType: "MARK_PRICE",
  };
  for (const redirectPostTo of [
    "https://open-api.bingx.com/openApi/swap/v2/trade/order",
    "https://attacker.example/collect",
  ]) {
    const blocked = fixture({
      dualSidePosition: true, longLeverage: 10, shortLeverage: 25,
      positions: [{
        symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
        positionId: "position-upgrade",
      }],
      orders: [oldStop],
      redirectPostTo,
    });
    await assert.rejects(blocked.api.upgradeVstLongStop({
      symbol: "BTCUSDT", quantity: "0.1", positionId: "position-upgrade",
      entryOrderId: "entry-1", previousStopOrderId: "old-stop",
      previousStopPrice: "90.0", stopPrice: "95.0",
    }), /request failed/);
    assert.ok(blocked.calls.every(({ url }) =>
      url.origin === "https://open-api-vst.bingx.com"));
    const write = blocked.calls.find(({ url, options }) =>
      url.pathname === orderPath && options.method === "POST");
    assert.ok(write);
    assert.equal(write.options.redirect, "error");
    assert.ok(write.options.headers["X-BX-APIKEY"]);
    assert.equal(blocked.calls.some(({ url }) => url.href === redirectPostTo), false);
    assert.deepEqual(blocked.state.orders.map((order) => order.orderId), ["old-stop"]);
    assert.equal(blocked.calls.some(({ options }) => options.method === "DELETE"), false);
  }
});

test("VST automated margin top-up submits once without falsely confirming entry margin; close uses exact MARKET quantity", async () => {
  const position = {
    symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
    positionId: "position-margin", isolatedMargin: "10",
  };
  const stop = {
    symbol: "BTC-USDT", orderId: "margin-stop", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "position-margin",
    mainOrderId: "entry-margin", origQty: "0.1", stopPrice: "90.0",
    workingType: "MARK_PRICE",
  };
  const { api, calls } = fixture({
    dualSidePosition: true,
    longLeverage: 10,
    shortLeverage: 7,
    positions: [position],
    orders: [stop],
  });
  const topup = await api.addVstIsolatedLongMargin({
    symbol: "BTCUSDT", amount: "2.5", quantity: "0.1",
    positionId: "position-margin", entryOrderId: "entry-margin", stopLoss: "90.0",
    clientOperationId: "vsa-margin-1",
  });
  assert.equal(topup.verified, false);
  assert.equal(topup.submitted, true);
  assert.equal(topup.isolatedMarginAfter, null);
  assert.equal(topup.marginDelta, null);
  assert.deepEqual(topup.protectiveStop, {
    orderId: "margin-stop", positionId: "position-margin", quantity: "0.1",
    stopPrice: "90.0", status: "NEW", workingType: "MARK_PRICE",
  });
  const marginWrite = calls.find(({ url, options }) =>
    url.pathname.endsWith("/positionMargin") && options.method === "POST");
  assert.equal(marginWrite.url.searchParams.get("positionSide"), "LONG");
  assert.equal(marginWrite.url.searchParams.get("type"), "1");

  const missingStop = fixture({
    dualSidePosition: true,
    longLeverage: 10,
    shortLeverage: 7,
    positions: [{ ...position }],
  });
  await assert.rejects(missingStop.api.addVstIsolatedLongMargin({
    symbol: "BTCUSDT", amount: "2.5", quantity: "0.1",
    positionId: "position-margin", entryOrderId: "entry-margin", stopLoss: "90.0",
    clientOperationId: "vsa-margin-no-stop",
  }), /protective stop/);
  assert.equal(missingStop.calls.some(({ url, options }) =>
    url.pathname.endsWith("/positionMargin") && options.method === "POST"), false);

  await api.closeLong("BTCUSDT", "0.1", "vsa-close-1", "position-margin", {
    automatedLongPolicy: VST_AUTOMATED_LONG_POLICY,
  });
  const close = calls.find(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST" &&
    url.searchParams.get("side") === "SELL");
  assert.equal(close.url.searchParams.get("type"), "MARKET");
  assert.equal(close.url.searchParams.get("positionSide"), "LONG");
  assert.equal(close.url.searchParams.get("quantity"), "0.1");
  assert.equal(close.url.searchParams.get("clientOrderId"), "vsa-close-1");

  const mainnet = fixture({ environment: "mainnet" });
  await assert.rejects(mainnet.api.addVstIsolatedLongMargin({
    symbol: "BTCUSDT", amount: "1", quantity: "0.1",
    positionId: "position", entryOrderId: "entry", stopLoss: "90",
    clientOperationId: "vsa-mainnet",
  }), /only valid on VST/);
  assert.equal(mainnet.calls.length, 0);
});

test("VST emergency close reduces only the exact full residual without leverage-pair reads", async () => {
  const protectiveStop = {
    symbol: "BTC-USDT", orderId: "emergency-stop", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "position-emergency",
    origQty: "0.1", stopPrice: "90.0", workingType: "MARK_PRICE",
  };
  const emergency = fixture({
    dualSidePosition: true,
    longLeverage: 4,
    shortLeverage: 31,
    positions: [{
      symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
      positionId: "position-emergency",
    }],
    orders: [protectiveStop],
  });
  const response = await emergency.api.emergencyCloseVstLong({
    symbol: "BTCUSDT", quantity: "0.1", clientOrderId: "vst_emergency-1",
    expectedPositionId: "position-emergency",
  });
  assert.equal(response.orderId, "submitted-1");
  const close = emergency.calls.find(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST");
  assert.equal(close.url.searchParams.get("side"), "SELL");
  assert.equal(close.url.searchParams.get("positionSide"), "LONG");
  assert.equal(close.url.searchParams.get("type"), "MARKET");
  assert.equal(close.url.searchParams.get("quantity"), "0.1");
  assert.equal(close.url.searchParams.get("clientOrderId"), "vst_emergency-1");
  assert.equal(emergency.calls.some(({ url }) => url.pathname === leveragePath), false);
  await assert.rejects(emergency.api.emergencyCloseVstLong({
    symbol: "BTCUSDT", quantity: "0.1", clientOrderId: "vst_emergency-1",
    expectedPositionId: "position-emergency",
  }), /already submitted/);
  assert.equal(emergency.calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST").length, 1);

  const blockedCases = [
    {
      positions: [{
        symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
        positionId: "different-position",
      }],
      orders: [],
      quantity: "0.1",
      expectedPositionId: "position-emergency",
    },
    {
      positions: [{
        symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.11",
        positionId: "position-emergency",
      }],
      orders: [],
      quantity: "0.1",
      expectedPositionId: "position-emergency",
    },
    {
      positions: [
        {
          symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
          positionId: "position-emergency",
        },
        {
          symbol: "BTC-USDT", positionSide: "SHORT", positionAmt: "0.01",
          positionId: "other-short",
        },
      ],
      orders: [],
      quantity: "0.1",
      expectedPositionId: "position-emergency",
    },
    {
      positions: [{
        symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
        positionId: "position-emergency",
      }],
      orders: [{
        symbol: "BTC-USDT", orderId: "unrelated-order", type: "LIMIT",
        side: "SELL", positionSide: "LONG", status: "NEW",
      }],
      quantity: "0.1",
      expectedPositionId: "position-emergency",
    },
  ];
  for (const [index, scenario] of blockedCases.entries()) {
    const blocked = fixture({ dualSidePosition: true, ...scenario });
    await assert.rejects(blocked.api.emergencyCloseVstLong({
      symbol: "BTCUSDT",
      quantity: scenario.quantity,
      clientOrderId: `vst_emergency-blocked-${index}`,
      expectedPositionId: scenario.expectedPositionId,
    }));
    assert.equal(blocked.calls.some(({ url, options }) =>
      url.pathname === orderPath && options.method === "POST"), false);
  }
  const mainnet = fixture({ environment: "mainnet" });
  await assert.rejects(mainnet.api.emergencyCloseVstLong({
    symbol: "BTCUSDT", quantity: "0.1", clientOrderId: "vst_emergency-mainnet",
    expectedPositionId: "position-emergency",
  }), /outside the VST environment/);
  assert.equal(mainnet.calls.length, 0);
});

test("VST BTC probe preflight accepts only HEDGE LONG10/SHORT75 and rejects mainnet option", async () => {
  const accepted = fixture({
    dualSidePosition: true, longLeverage: 10, shortLeverage: 75,
  });
  const ready = await accepted.api.preflight("BTCUSDT", {
    probePolicy: VST_BTC_HEDGE_LONG10_SHORT75_PROBE,
  });
  assert.equal(ready.status, "ready");
  assert.deepEqual({
    long10: ready.checks.leverageLong10,
    short75: ready.checks.leverageShort75,
    isolated: ready.checks.marginTypeIsolated,
    hedge: ready.checks.positionModeHedge,
    noTopUp: ready.checks.noPlannedTopUp,
  }, { long10: true, short75: true, isolated: true, hedge: true, noTopUp: true });

  for (const [longLeverage, shortLeverage] of [[10, 10], [75, 10], [75, 75]]) {
    const drift = fixture({ dualSidePosition: true, longLeverage, shortLeverage });
    const blocked = await drift.api.preflight("BTCUSDT", {
      probePolicy: VST_BTC_HEDGE_LONG10_SHORT75_PROBE,
    });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.checks.leverageProbePolicy, false);
    assert.ok(blocked.blockers.includes("leverageProbePolicy"));
  }

  const noProbeOptIn = await accepted.api.preflight("BTCUSDT");
  assert.equal(noProbeOptIn.checks.leverage10, false);
  const mainnetGeneric = fixture({
    environment: "mainnet", dualSidePosition: true, longLeverage: 10, shortLeverage: 10,
  });
  const genericReady = await mainnetGeneric.api.preflight("BTCUSDT");
  assert.equal(genericReady.checks.leverage10, true);

  const mainnet = fixture({
    environment: "mainnet", dualSidePosition: true, longLeverage: 10, shortLeverage: 10,
  });
  await assert.rejects(mainnet.api.preflight("BTCUSDT", {
    probePolicy: VST_BTC_HEDGE_LONG10_SHORT75_PROBE,
  }), /only valid for VST BTC-USDT/);
  assert.equal(mainnet.calls.length, 0);
});

test("additional VST STOP_MARKET uses no client ID and preserves the original stop", async () => {
  const original = {
    symbol: "BTC-USDT", orderId: "old-stop", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "position-1",
    origQty: "0.1", stopPrice: "90.0", workingType: "MARK_PRICE",
  };
  const apiFixture = fixture({
    dualSidePosition: true,
    longLeverage: 10,
    shortLeverage: 75,
    positions: [{
      symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
      positionId: "position-1",
    }],
    orders: [original],
  });
  await apiFixture.api.placeVstAdditionalLongStop({
    symbol: "BTCUSDT", quantity: "0.1", stopPrice: "95.0",
    positionId: "position-1", previousStopOrderId: "old-stop",
    previousStopPrice: "90.0",
    probePolicy: VST_BTC_HEDGE_LONG10_SHORT75_PROBE,
  });
  const writes = apiFixture.calls.filter(({ options }) => options.method !== "GET");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url.searchParams.get("type"), "STOP_MARKET");
  assert.equal(writes[0].url.searchParams.get("side"), "SELL");
  assert.equal(writes[0].url.searchParams.get("positionSide"), "LONG");
  assert.equal(writes[0].url.searchParams.get("quantity"), "0.1");
  assert.equal(writes[0].url.searchParams.get("stopPrice"), "95.0");
  assert.equal(writes[0].url.searchParams.has("clientOrderId"), false);
  await assert.rejects(apiFixture.api.placeVstAdditionalLongStop({
    symbol: "BTCUSDT", quantity: "0.1", stopPrice: "95.0",
    positionId: "position-1", previousStopOrderId: "old-stop",
    previousStopPrice: "90.0",
    probePolicy: VST_BTC_HEDGE_LONG10_SHORT75_PROBE,
  }), /already submitted/);
  assert.equal(apiFixture.calls.filter(({ options }) => options.method !== "GET").length, 1);

  const mainnet = fixture({ environment: "mainnet" });
  await assert.rejects(mainnet.api.placeVstAdditionalLongStop({
    symbol: "BTCUSDT", quantity: "0.1", stopPrice: "95.0",
    positionId: "position-1", previousStopOrderId: "old-stop",
    previousStopPrice: "90.0",
  }), /outside the VST environment/);
  assert.equal(mainnet.calls.length, 0);

  const drifted = fixture({
    dualSidePosition: true, longLeverage: 10, shortLeverage: 10,
    positions: [{
      symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
      positionId: "position-drift",
    }],
    orders: [{ ...original, positionId: "position-drift" }],
  });
  await assert.rejects(drifted.api.placeVstAdditionalLongStop({
    symbol: "BTCUSDT", quantity: "0.1", stopPrice: "95.0",
    positionId: "position-drift", previousStopOrderId: "old-stop",
    previousStopPrice: "90.0",
    probePolicy: VST_BTC_HEDGE_LONG10_SHORT75_PROBE,
  }), /LONG 10x\/SHORT 75x/);
  assert.equal(drifted.calls.some(({ options }) => options.method === "POST"), false);
});

test("supervised VST closeLong requires exact position and HEDGE 10/75 probe policy", async () => {
  const position = {
    symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
    positionId: "position-close",
  };
  const valid = fixture({
    dualSidePosition: true,
    longLeverage: 10,
    shortLeverage: 75,
    positions: [position],
  });
  await valid.api.closeLong("BTCUSDT", "0.1", "vsc_exact-close", "position-close", {
    probePolicy: VST_BTC_HEDGE_LONG10_SHORT75_PROBE,
  });
  const write = valid.calls.find(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST");
  assert.equal(write.url.searchParams.get("positionSide"), "LONG");
  assert.equal(write.url.searchParams.get("quantity"), "0.1");
  assert.equal(write.url.searchParams.get("clientOrderId"), "vsc_exact-close");

  const leverageDrift = fixture({
    dualSidePosition: true,
    longLeverage: 10,
    shortLeverage: 10,
    positions: [position],
  });
  await assert.rejects(leverageDrift.api.closeLong(
    "BTCUSDT", "0.1", "vsc_drifted-close", "position-close", {
      probePolicy: VST_BTC_HEDGE_LONG10_SHORT75_PROBE,
    },
  ), /LONG 10x\/SHORT 75x/);
  assert.equal(leverageDrift.calls.some(({ options }) => options.method === "POST"), false);

  const changedSize = fixture({
    dualSidePosition: true,
    longLeverage: 10,
    shortLeverage: 75,
    positions: [{ ...position, positionAmt: "0.2" }],
  });
  await assert.rejects(
    changedSize.api.closeLong("BTCUSDT", "0.1", "vsc_wrong-size", "position-close", {
      probePolicy: VST_BTC_HEDGE_LONG10_SHORT75_PROBE,
    }),
    /No unambiguous long exposure/,
  );
  assert.equal(changedSize.calls.some(({ options }) => options.method === "POST"), false);
});

test("degraded strategy exit rechecks the complete owned stop cohort before the native MARKET POST", async () => {
  const position = {
    symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
    positionId: "protected-position", leverage: 10, marginMode: "ISOLATED",
  };
  const stop = {
    symbol: "BTC-USDT", orderId: "protected-stop", positionId: position.positionId,
    type: "STOP_MARKET", status: "NEW", side: "SELL", positionSide: "LONG",
    origQty: "0.1", stopPrice: "95.0", workingType: "MARK_PRICE", executedQty: "0",
  };
  const exit = {
    version: 1, sourceSignalId: "protected-signal", originalClientOrderId: "ambiguous-stop",
    symbol: "BTCUSDT", positionId: position.positionId, entryOrderId: "protected-entry",
    quantity: "0.1", reason: "percentage_point_trailing_stop", price: "100",
    observedAt: validSignalAt,
    ownedStops: [{ orderId: stop.orderId, positionId: position.positionId,
      quantity: "0.1", stopPrice: "95", tranche: "core" }],
  };
  const make = overrides => fixture({
    dualSidePosition: true, longLeverage: 10, shortLeverage: 3,
    positions: [position], orders: [stop], simulateMarketClose: true, ...overrides,
  });
  const close = (f, evidence = exit) => f.api.closeLong(
    "BTCUSDT", "0.1", "protected-exit-client", position.positionId,
    { automatedLongPolicy: VST_AUTOMATED_LONG_POLICY, protectedExit: evidence },
  );
  const valid = make();
  await close(valid);
  assert.equal(valid.calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST").length, 1);
  for (const overrides of [
    { orders: [stop, { ...stop, orderId: "foreign-stop" }] },
    { orders: [{ ...stop, orderId: "replacement-not-proven" }] },
    { orders: [{ ...stop, origQty: "0.09" }] },
    { orders: [{ ...stop, mainOrderId: "foreign-entry" }] },
    { positions: [{ ...position, positionId: "foreign-position" }] },
    { positions: [{ ...position, positionAmt: "0.09" }] },
  ]) {
    const unsafe = make(overrides);
    await assert.rejects(close(unsafe));
    assert.equal(unsafe.calls.some(({ options }) => options.method === "POST"), false);
  }
  let orderReads = 0, raced;
  raced = make({ beforeFetch: async url => {
    if (url.pathname.endsWith("/openOrders") && ++orderReads === 2) {
      raced.state.orders.push({ ...stop, orderId: "late-foreign-stop" });
    }
  } });
  await assert.rejects(close(raced), /final pre-sign check failed/);
  assert.equal(raced.calls.some(({ options }) => options.method === "POST"), false);
});

test("native VST source exit closes the exact remaining LONG without mark/quote corroboration", async () => {
  const stop = {
    symbol: "BTC-USDT",
    orderId: "source-exit-stop",
    mainOrderId: "source-exit-entry",
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionId: "source-exit-position",
    origQty: "0.1",
    executedQty: "0",
    stopPrice: "95",
    workingType: "MARK_PRICE",
  };
  const openLong = {
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: "0.1",
    avgPrice: "100",
    positionId: "source-exit-position",
  };
  const sourceEvidence = {
    sourceSignalId: "source-signal-1",
    symbol: "BTCUSDT",
    reason: "source_withdrawal",
    asOf: validSignalAt,
    observedAt: validSignalAt,
    sourceStatus: "cancelled",
    sourceUpdatedAt: validSignalAt,
    sourceClosedAt: null,
    sourceExitPrice: "1",
    sourceCancelReason: null,
    exitDecisionAt: null,
  };
  const makeNativeSourceExit = (options = {}) => {
    const native = fixture({
      dualSidePosition: true,
      longLeverage: 10,
      shortLeverage: 75,
      positions: [openLong],
      orders: [stop],
      markTimestamp: 0,
      markPrice: "90",
      ticker: { askPrice: "100", bidPrice: "99.9", time: 1700000000000 },
      simulateMarketClose: true,
      autoCancelStopsOnMarket: true,
      marketFillRows: [{
        symbol: "BTC-USDT",
        orderId: "market-close",
        tradeId: "source-exit-fill-1",
        side: "SELL",
        positionSide: "LONG",
        qty: "0.1",
        price: "100",
        filledTm: 1700000000000,
        commission: "0.01",
        commissionAsset: "VST",
      }],
      ...options,
    });
    const broker = createVstBroker({
      api: native.api,
      accountId: "native-vst-account",
      canarySymbols: ["BTCUSDT"],
      clock: () => native.time.now,
      stopBufferRate: 0.005,
    });
    const request = {
      operation: "close_leg",
      sourceSignalId: sourceEvidence.sourceSignalId,
      symbol: "BTCUSDT",
      environment: "vst",
      accountId: "native-vst-account",
      intentCreatedAt: native.time.now,
      positionId: "source-exit-position",
      quantity: "0.1",
      previousQuantity: "0.1",
      reason: sourceEvidence.reason,
      signal: { sourceSignalId: sourceEvidence.sourceSignalId, patternId: "source_exit" },
      priorPosition: {
        sourceSignalId: sourceEvidence.sourceSignalId,
        symbol: "BTCUSDT",
        environment: "vst",
        accountId: "native-vst-account",
        exchangePositionId: "source-exit-position",
        entryOrderId: "source-exit-entry",
        sourceExitEvidence: sourceEvidence,
        sourceExitRequestId: "source-exit-request-1",
      },
      ownedStops: [{
        orderId: stop.orderId,
        positionId: stop.positionId,
        quantity: stop.origQty,
        stopPrice: stop.stopPrice,
        tranche: "original",
      }],
      sourceExitRequestId: "source-exit-request-1",
      sourceExit: {
        stage: "close",
        requestId: "source-exit-request-1",
        evidence: sourceEvidence,
      },
    };
    return {
      ...native,
      broker,
      intent: {
        clientOrderId: "worker-source-exit-client",
        phase: "source-exit-native-regression",
        request,
      },
    };
  };

  const successful = makeNativeSourceExit();
  const capabilities = await successful.broker.getCapabilities();
  assert.equal(capabilities.verified, true);
  assert.ok(capabilities.features.includes("verified_exact_full_position_close"));
  assert.equal(successful.calls.some(({ url }) =>
    url.pathname.endsWith("/premiumIndex") || url.pathname.endsWith("/ticker")), false);
  await successful.broker.performIntent(successful.intent);
  const closePost = successful.calls.find(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST" &&
    url.searchParams.get("type") === "MARKET");
  assert.ok(closePost);
  assert.equal(closePost.url.origin, "https://open-api-vst.bingx.com");
  assert.equal(closePost.url.searchParams.get("symbol"), "BTC-USDT");
  assert.equal(closePost.url.searchParams.get("side"), "SELL");
  assert.equal(closePost.url.searchParams.get("positionSide"), "LONG");
  assert.equal(closePost.url.searchParams.get("quantity"), "0.1");
  assert.equal(closePost.url.searchParams.get("price"), null);
  assert.equal(closePost.url.searchParams.get("clientOrderId").startsWith("vst-"), true);
  assert.equal(successful.state.positions[0].positionAmt, "0");
  const evidence = await successful.broker.reconcileIntent(successful.intent);
  assert.equal(evidence.verified, true);
  assert.equal(evidence.status, "filled");
  assert.equal(evidence.position.quantity, 0);
  assert.equal(evidence.position.verified, true);
  assert.equal(evidence.fill.quantity, 0.1);
  assert.equal(evidence.fill.price, 100);
  assert.equal(evidence.fill.fees[0].currency, "VST");
  assert.equal(successful.calls.some(({ url }) =>
    url.pathname.endsWith("/premiumIndex") || url.pathname.endsWith("/ticker")), false);
  assert.equal(successful.calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST").length, 1);

  for (const status of ["profit", "breakeven", "expired"]) {
  const terminalClosed = makeNativeSourceExit();
  const closedEvidence = {
    ...sourceEvidence,
    reason: "source_closed",
    sourceAction: "close",
    sourceStatus: status,
    sourceUpdatedAt: null,
    sourceClosedAt: validSignalAt,
    sourceExitPrice: status === "profit" ? "105" : null,
    exitDecisionAt: validSignalAt,
  };
  terminalClosed.intent.request.reason = closedEvidence.reason;
  terminalClosed.intent.request.sourceExit.evidence = closedEvidence;
  terminalClosed.intent.request.priorPosition.sourceExitEvidence = closedEvidence;
  await terminalClosed.broker.performIntent(terminalClosed.intent);
  assert.equal(terminalClosed.calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST").length, 1);
  const terminalFill = await terminalClosed.broker.reconcileIntent(terminalClosed.intent);
  assert.equal(terminalFill.position.quantity, 0);
  assert.equal(terminalFill.fill.quantity, 0.1);
  assert.equal(terminalFill.fill.price, 100);
  }

  const withdrawalWithoutUpdate = makeNativeSourceExit();
  const invalidWithdrawalEvidence = {
    ...sourceEvidence,
    sourceUpdatedAt: null,
  };
  withdrawalWithoutUpdate.intent.request.sourceExit.evidence =
    invalidWithdrawalEvidence;
  withdrawalWithoutUpdate.intent.request.priorPosition.sourceExitEvidence =
    invalidWithdrawalEvidence;
  await assert.rejects(
    withdrawalWithoutUpdate.broker.performIntent(withdrawalWithoutUpdate.intent),
    /source_exit_close_request_identity_or_evidence_invalid/,
  );
  assert.equal(withdrawalWithoutUpdate.calls.filter(({ options }) =>
    options.method === "POST").length, 0);
  const invalidNativeEvidence = {
    sourceExitRequestId: withdrawalWithoutUpdate.intent.request.sourceExitRequestId,
    sourceExit: withdrawalWithoutUpdate.intent.request.sourceExit,
    sourceSignalId: sourceEvidence.sourceSignalId,
    symbol: "BTCUSDT",
    reason: "source_withdrawal",
    ownedStops: withdrawalWithoutUpdate.intent.request.ownedStops,
    entryOrderId: "source-exit-entry",
  };
  await assert.rejects(
    withdrawalWithoutUpdate.api.closeLong(
      "BTCUSDT",
      "0.1",
      "vst-direct-invalid-withdrawal",
      "source-exit-position",
      {
        automatedLongPolicy: VST_AUTOMATED_LONG_POLICY,
        sourceExitRequest: invalidNativeEvidence,
      },
    ),
    /source-exit close request identity or evidence is invalid/,
  );
  assert.equal(withdrawalWithoutUpdate.calls.filter(({ options }) =>
    options.method === "POST").length, 0);

  const closedWithoutClosureEvidence = makeNativeSourceExit();
  const invalidClosedEvidence = {
    ...sourceEvidence,
    reason: "source_closed",
    sourceStatus: "profit",
    sourceUpdatedAt: null,
    sourceClosedAt: null,
    sourceExitPrice: null,
  };
  closedWithoutClosureEvidence.intent.request.reason = invalidClosedEvidence.reason;
  closedWithoutClosureEvidence.intent.request.sourceExit.evidence = invalidClosedEvidence;
  closedWithoutClosureEvidence.intent.request.priorPosition.sourceExitEvidence =
    invalidClosedEvidence;
  await assert.rejects(
    closedWithoutClosureEvidence.api.closeLong(
      "BTCUSDT",
      "0.1",
      "vst-direct-invalid-closed",
      "source-exit-position",
      {
        automatedLongPolicy: VST_AUTOMATED_LONG_POLICY,
        sourceExitRequest: {
          sourceExitRequestId:
            closedWithoutClosureEvidence.intent.request.sourceExitRequestId,
          sourceExit: closedWithoutClosureEvidence.intent.request.sourceExit,
          sourceSignalId: sourceEvidence.sourceSignalId,
          symbol: "BTCUSDT",
          reason: "source_closed",
          ownedStops: closedWithoutClosureEvidence.intent.request.ownedStops,
          entryOrderId: "source-exit-entry",
        },
      },
    ),
    /source-exit close request identity or evidence is invalid/,
  );
  assert.equal(closedWithoutClosureEvidence.calls.filter(({ options }) =>
    options.method === "POST").length, 0);

  const workerScenario = makeNativeSourceExit({
    autoCancelStopsOnMarket: false,
  });
  const workerEntryClientOrderId = "source-entry-client";
  const workerEntryExchangeClientOrderId = `vst-${createHash("sha256")
    .update(workerEntryClientOrderId).digest("hex").slice(0, 28)}`;
  const workerEntryIntentCreatedAt = Date.parse(validSignalAt) - 1_000;
  const workerEntrySignal = {
    sourceSignalId: sourceEvidence.sourceSignalId,
    symbol: sourceEvidence.symbol,
    orderType: "market",
    side: "buy",
    patternId: "impulse_buy",
  };
  const workerEvidence = {
    ...sourceEvidence,
    reason: "source_closed",
    sourceStatus: "profit",
    sourceUpdatedAt: null,
    sourceClosedAt: validSignalAt,
    sourceExitPrice: "105",
    exitDecisionAt: validSignalAt,
  };
  const workerSnapshot = {
    sourceSignalId: workerEvidence.sourceSignalId,
    symbol: workerEvidence.symbol,
    patternId: "impulse_buy",
    environment: "vst",
    accountId: "native-vst-account",
    status: "open",
    exchangePositionId: "source-exit-position",
    entryOrderId: "source-exit-entry",
    entryClientOrderId: workerEntryClientOrderId,
    entryOrderType: "MARKET",
    entryAt: validSignalAt,
    entryPrice: "100",
    quantity: "0.1",
    remainingQty: "0.1",
    signalSnapshot: workerEntrySignal,
    sizing: { environment: "vst", quantity: "0.1" },
    verifiedFill: { price: "100", quantity: "0.1", at: validSignalAt },
    persistedPosition: {
      verified: true,
      environment: "vst",
      accountId: "native-vst-account",
      symbol: sourceEvidence.symbol,
      positionId: "source-exit-position",
      quantity: "0.1",
      protectiveStops: {},
      originalStop: {
        verified: true,
        orderId: stop.orderId,
        positionId: "source-exit-position",
        quantity: "0.1",
        stopPrice: "95",
      },
    },
  };
  const queuedSourceExit = {
    requestId: "source-exit-request-1",
    sourceSignalId: workerEvidence.sourceSignalId,
    symbol: workerEvidence.symbol,
    reason: workerEvidence.reason,
    asOf: workerEvidence.asOf,
    observedAt: workerEvidence.observedAt,
    evidence: workerEvidence,
  };
  const workerData = {
    intents: [{
      sourceSignalId: sourceEvidence.sourceSignalId,
      phase: "market-entry",
      clientOrderId: workerEntryClientOrderId,
      state: "reconciled",
      request: {
        operation: "entry",
        entryOrderType: "MARKET",
        symbol: sourceEvidence.symbol,
        environment: "vst",
        accountId: "native-vst-account",
        intentCreatedAt: workerEntryIntentCreatedAt,
        quantity: "0.1",
        sizing: { environment: "vst", quantity: "0.1" },
        signal: workerEntrySignal,
      },
      exchangeOrderId: "source-exit-entry",
      outcome: {
        status: "filled",
        verified: true,
        operation: "entry",
        positionId: "source-exit-position",
        entryOrderId: "source-exit-entry",
        totalQuantity: "0.1",
        coreQuantity: "0.08",
        runnerQuantity: "0.02",
        splitStage: "complete",
      },
    }],
    positions: [{
      sourceSignalId: sourceEvidence.sourceSignalId,
      symbol: workerEvidence.symbol,
      status: "open",
      snapshot: workerSnapshot,
    }],
    sourceExitRequests: [{ ...queuedSourceExit, state: "pending" }],
  };
  workerScenario.state.orderHistory.push({
    symbol: "BTC-USDT",
    orderId: "source-exit-entry",
    clientOrderId: workerEntryExchangeClientOrderId,
    status: "FILLED",
    side: "BUY",
    positionSide: "LONG",
    type: "MARKET",
    positionId: "source-exit-position",
    origQty: "0.1",
    executedQty: "0.1",
    avgPrice: "100",
    time: Date.parse(validSignalAt),
    updateTime: Date.parse(validSignalAt),
  });
  workerScenario.state.ordersById["source-exit-entry"] =
    workerScenario.state.orderHistory.at(-1);
  workerScenario.state.fills.push({
    symbol: "BTC-USDT",
    orderId: "source-exit-entry",
    tradeId: "worker-entry-fill-1",
    side: "BUY",
    positionSide: "LONG",
    qty: "0.1",
    price: "100",
    filledTm: Date.parse(validSignalAt),
    commission: "0",
    commissionAsset: "VST",
  });
  const workerStore = {
    async withLeaderLock(callback) { return callback(); },
    async getPending() { return null; },
    async queueSourceExitRequests({ positions = [], asOf, observedAt }) {
      for (const position of positions) {
        const request = position?.sourceExitRequest;
        if (!request || workerData.sourceExitRequests.some((row) =>
          row.requestId === request.requestId)) continue;
        workerData.sourceExitRequests.push({
          ...request, asOf, observedAt, state: "pending",
        });
      }
    },
    async listPendingSourceExitRequests() {
      return workerData.sourceExitRequests
        .filter((row) => row.state === "pending")
        .map(({ state: _state, ...row }) => structuredClone(row));
    },
    async listOpenPositions() {
      return workerData.positions.filter((row) =>
        ["open", "closing", "unknown"].includes(row.status));
    },
    async getPosition(sourceSignalId) {
      return workerData.positions.find((row) =>
        row.sourceSignalId === sourceSignalId) ?? null;
    },
    async listUnresolvedIntents() {
      return workerData.intents.filter((row) =>
        ["prepared", "submitted", "unknown"].includes(row.state));
    },
    async getIntent(sourceSignalId, phase) {
      return workerData.intents.find((row) =>
        row.sourceSignalId === sourceSignalId && row.phase === phase) ?? null;
    },
    async reserveIntent(intent) {
      const existing = await this.getIntent(intent.sourceSignalId, intent.phase);
      if (existing) return { kind: "existing", intent: existing };
      const row = { ...intent, state: "prepared" };
      workerData.intents.push(row);
      return { kind: "new", intent: row };
    },
    async markIntent(clientOrderId, state, detail = {}) {
      const intent = workerData.intents.find((row) =>
        row.clientOrderId === clientOrderId);
      assert.ok(intent);
      Object.assign(intent, { state, detail });
    },
    async commitVerifiedIntent(commit) {
      const intent = workerData.intents.find((row) =>
        row.clientOrderId === commit.clientOrderId);
      assert.ok(intent);
      Object.assign(intent, {
        state: "reconciled",
        exchangeOrderId: commit.exchangeOrderId,
        detail: { outcome: commit.outcome },
      });
      const next = {
        sourceSignalId: commit.sourceSignalId,
        symbol: commit.position.symbol,
        status: commit.position.status,
        snapshot: commit.position,
      };
      workerData.positions[0] = next;
    },
    async setSignalStatus(_sourceSignalId, status, reason = null) {
      workerData.status = status;
      workerData.reason = reason;
    },
    async upsertPosition(position) {
      workerData.positions[0] = {
        sourceSignalId: position.sourceSignalId,
        symbol: position.symbol,
        status: position.status,
        snapshot: position,
      };
    },
    async recordEvent() {},
    async finishSourceExitRequest(requestId, result) {
      const row = workerData.sourceExitRequests.find((item) =>
        item.requestId === requestId);
      if (row) Object.assign(row, { state: "finished", result });
    },
    async hasPendingSourceExitRequest(sourceSignalId) {
      return workerData.sourceExitRequests.some((row) =>
        row.state === "pending" && row.sourceSignalId === sourceSignalId);
    },
  };
  const sourceCloseCapabilities = await workerScenario.broker.getCapabilities();
  const strategyOnlyCapabilities = new Set([
    "guarded_long10_leverage_preparation",
    "atomic_protected_market_entry",
    "verified_core_stop_state",
    "verified_exact_full_position_close",
    "impulse_runner_stop_and_partial_close",
  ]);
  const sourceExitBroker = {
    ...workerScenario.broker,
    async getCapabilities() {
      const capabilities = await workerScenario.broker.getCapabilities();
      return {
        ...capabilities,
        features: capabilities.features.filter((feature) =>
          !strategyOnlyCapabilities.has(feature)),
      };
    },
  };
  const worker = createVstWorker({
    store: workerStore,
    broker: sourceExitBroker,
    clock: () => workerScenario.time.now,
    sizingLimits: { environment: "vst" },
    sourceExitsEnabled: true,
  });
  const oldPausedState = process.env.BULLET_VST_PAUSED;
  process.env.BULLET_VST_PAUSED = "0";
  let workerResult;
  let workerCleanupResult;
  let cleanupCapabilities;
  try {
    workerResult = await worker.runOnce();
    cleanupCapabilities = await workerScenario.broker.getCapabilities();
    workerCleanupResult = await worker.runOnce();
  } finally {
    if (oldPausedState === undefined) delete process.env.BULLET_VST_PAUSED;
    else process.env.BULLET_VST_PAUSED = oldPausedState;
  }
  assert.equal(workerResult.kind, "acted", JSON.stringify(workerResult));
  assert.equal(workerResult.operation, "source_exit_close");
  assert.equal(sourceCloseCapabilities.features.includes(
    "verified_exact_source_full_position_close"), true);
  assert.equal(sourceCloseCapabilities.features.includes(
    "verified_exact_full_position_close"), true);
  assert.ok(cleanupCapabilities.features.includes("verified_source_flat_stop_cleanup"));
  assert.equal(workerCleanupResult.kind, "acted", JSON.stringify(workerCleanupResult));
  assert.equal(workerCleanupResult.operation, "source_exit_stop_cleanup");
  assert.equal(workerScenario.state.positions[0].positionAmt, "0");
  assert.equal(workerScenario.state.orders.length, 0);
  assert.equal(workerData.intents.length, 3);
  assert.equal(workerData.intents.filter((intent) =>
    intent.phase !== "market-entry").length, 2);
  assert.equal(workerData.intents.every((intent) =>
    intent.state === "reconciled"), true);
  assert.equal(workerData.sourceExitRequests[0].state, "finished");
  assert.equal(workerScenario.calls.some(({ url }) =>
    url.pathname.endsWith("/premiumIndex") || url.pathname.endsWith("/ticker")), false);
  const workerClosePost = workerScenario.calls.find(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST");
  assert.ok(workerClosePost);
  assert.equal(workerClosePost.url.searchParams.get("symbol"), "BTC-USDT");
  assert.equal(workerClosePost.url.searchParams.get("quantity"), "0.1");
  assert.equal(workerClosePost.url.searchParams.get("price"), null);
  assert.equal(workerScenario.calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST").length, 1);

  const cleanupScenario = makeNativeSourceExit({
    autoCancelStopsOnMarket: false,
  });
  await cleanupScenario.broker.performIntent(cleanupScenario.intent);
  const cleanupPrior = {
    ...cleanupScenario.intent.request.priorPosition,
    status: "closing",
    sourceExitEvidence: sourceEvidence,
    sourceExitRequestId: "source-exit-request-1",
    sourceExitCleanup: {
      requestId: "source-exit-request-1",
      remainingKnownStopOrderIds: [stop.orderId],
    },
    split: {
      stage: "flat_cleanup_pending",
      positionId: "source-exit-position",
      entryOrderId: cleanupScenario.intent.request.priorPosition.entryOrderId,
      remainingKnownStopOrderIds: [stop.orderId],
      flatCleanupStops: [{
        orderId: stop.orderId,
        positionId: "source-exit-position",
        quantity: "0.1",
        stopPrice: "95",
      }],
    },
  };
  await cleanupScenario.broker.performIntent({
    clientOrderId: "worker-source-exit-stop-cleanup",
    phase: "source-exit-cleanup-native-regression",
    request: {
      operation: "cancel_flat_split_stop",
      intentCreatedAt: cleanupScenario.time.now,
      sourceSignalId: sourceEvidence.sourceSignalId,
      symbol: sourceEvidence.symbol,
      environment: "vst",
      accountId: "native-vst-account",
      positionId: "source-exit-position",
      stopToCancel: {
        orderId: stop.orderId,
        quantity: "0.1",
        stopPrice: "95",
      },
      knownRemainingStopOrderIds: [stop.orderId],
      cancellationIntentId: "source-exit-cleanup-native-1",
      priorPosition: cleanupPrior,
      sourceExit: {
        stage: "cleanup",
        requestId: "source-exit-request-1",
        evidence: sourceEvidence,
      },
    },
  });
  assert.equal(cleanupScenario.state.orders.length, 0);
  assert.equal(cleanupScenario.calls.some(({ url }) =>
    url.pathname.endsWith("/premiumIndex") || url.pathname.endsWith("/ticker")), false);

  const rejectWithoutWrite = async (options, alterRequest, expectedMessage) => {
    const scenario = makeNativeSourceExit(options);
    if (alterRequest) alterRequest(scenario.intent.request);
    await assert.rejects(
      scenario.broker.performIntent(scenario.intent),
      expectedMessage,
    );
    assert.equal(scenario.calls.filter(({ options: callOptions }) =>
      callOptions.method === "POST").length, 0);
  };
  await rejectWithoutWrite(
    { positions: [{ ...openLong, positionId: "other-position" }] },
    null,
    /source_exit_exchange_position_or_stops_unverified/,
  );
  await rejectWithoutWrite(
    {
      orders: [stop, {
        ...stop,
        orderId: "foreign-stop",
        positionId: "foreign-position",
      }],
    },
    null,
    /source_exit_exchange_position_or_stops_unverified/,
  );
  await rejectWithoutWrite(
    {},
    (request) => { request.accountId = "another-vst-account"; },
    /intent_account_or_environment_mismatch/,
  );

  const sourceLess = makeNativeSourceExit();
  sourceLess.intent.request = {
    operation: "close_leg",
    symbol: "BTCUSDT",
    environment: "vst",
    accountId: "native-vst-account",
    intentCreatedAt: sourceLess.time.now,
    quantity: "0.1",
    previousQuantity: "0.1",
  };
  await assert.rejects(
    sourceLess.broker.performIntent(sourceLess.intent),
    /not corroborated by a fresh quote/,
  );
  assert.equal(sourceLess.calls.filter(({ options: callOptions }) =>
    callOptions.method === "POST").length, 0);

  const unknownTransport = makeNativeSourceExit({ failMarketPostAfterApply: true });
  await assert.rejects(
    unknownTransport.broker.performIntent(unknownTransport.intent),
    /request failed/,
  );
  await assert.rejects(
    unknownTransport.broker.performIntent(unknownTransport.intent),
    /already_submitted_never_retry/,
  );
  assert.equal(unknownTransport.calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST").length, 1);
});

test("allFillOrders accepts fill_orders arrays for VST and USDT", async () => {
  const query = { startTs: 1699999999000, endTs: 1700000000000 };
  for (const { environment, currency } of [
    { environment: "vst", currency: "VST" },
    { environment: "mainnet", currency: "USDT" },
  ]) {
    const empty = fixture({ environment, fillResponse: { fill_orders: [] } });
    assert.deepEqual(await empty.api.queryFills("BTCUSDT", { ...query, currency }), []);

    const nonempty = fixture({
      environment,
      fillResponse: {
        fill_orders: [{ symbol: "BTC-USDT", orderId: 43, qty: "1", price: "100" }],
      },
    });
    assert.deepEqual(await nonempty.api.queryFills("BTCUSDT", { ...query, currency }), [
      { symbol: "BTC-USDT", orderId: 43, qty: "1", price: "100" },
    ]);
  }
});

test("queryFills preserves raw lossless trigger order IDs in both field variants", async () => {
  const exactTriggerId = "2104158374836396032";
  const fillOrderId = "2104158803529302017";
  const rawFillResponseText = '{"code":0,"data":{"fill_orders":[' +
    '{"symbol":"BTC-USDT","orderId":2104158803529302017,' +
    '"triggerOrderId":2104158374836396032,"volume":"0.0219"},' +
    '{"symbol":"BTC-USDT","orderId":2104158803529302017,' +
    '"triggerOrderID":2104158374836396032,"volume":"0.0219"}]}}';
  const raw = fixture({ rawFillResponseText });
  const fills = await raw.api.queryFills("BTCUSDT", {
    startTs: 1700000000000, endTs: 1700000000000,
    orderId: fillOrderId, currency: "VST",
  });
  assert.equal(fills.length, 2);
  assert.equal(fills[0].orderId, fillOrderId);
  assert.equal(fills[0].triggerOrderId, exactTriggerId);
  assert.equal(typeof fills[0].triggerOrderId, "string");
  assert.equal(fills[1].triggerOrderID, exactTriggerId);
  assert.equal(typeof fills[1].triggerOrderID, "string");
  assert.equal(fills[0].volume, "0.0219");
});

test("allFillOrders cannot provide complete history; strict requests use only fillHistory", async () => {
  const targetFills = [
    { symbol: "BTC-USDT", orderId: "entry-fill-order", qty: "1", price: "100" },
    { symbol: "BTC-USDT", orderId: "close-fill-order", qty: "1", price: "101" },
  ];
  const foreignFills = Array.from({ length: 498 }, (_, index) => ({
    symbol: `ALT${index}-USDT`,
    orderId: `foreign-fill-${index}`,
    qty: "1",
    price: "100",
  }));
  const rawFillResponse = [...targetFills, ...foreignFills];
  const request = {
    startTs: 1699999999000,
    endTs: 1700000000000,
    currency: "VST",
  };
  const { api, calls } = fixture({
    fillResponse: { fill_orders: rawFillResponse },
  });
  assert.equal(api.supportsCompleteFillHistory, true);
  // Existing callers retain their historical symbol filtering behavior.
  assert.deepEqual(await api.queryFills("BTCUSDT", request), targetFills);
  // Even though the 500 currency-wide raw rows would filter down to two, the
  // proof path refuses to query them while endpoint completeness is unknown.
  const legacyCallCount = calls.length;
  await assert.rejects(
    api.queryFills("BTCUSDT", { ...request, requireComplete: true }),
    /currency_invalid/,
  );
  assert.equal(calls.length, legacyCallCount);

  const atBoundary = fixture({
    fillResponse: { fill_orders: [...targetFills, ...foreignFills.slice(0, 98)] },
  });
  await assert.rejects(
    atBoundary.api.queryFills("BTCUSDT", { ...request, requireComplete: true }),
    /currency_invalid/,
  );
  assert.equal(atBoundary.calls.length, 0);

  const terminalSecondPage = fixture({
    fillResponse: {
      fill_orders: targetFills,
      currentPage: 2,
      totalPages: 2,
    },
  });
  await assert.rejects(
    terminalSecondPage.api.queryFills("BTCUSDT", {
      ...request, requireComplete: true,
    }),
    /currency_invalid/,
  );
  assert.equal(terminalSecondPage.calls.length, 0);
});

test("allFillOrders rejects non-array fill_orders and preserves the legacy orders array", async () => {
  const query = {
    startTs: 1699999999000,
    endTs: 1700000000000,
    currency: "VST",
  };
  for (const fillResponse of [
    { fill_orders: {} },
    { fill_orders: "not-an-array" },
    { fill_orders: null, orders: [] },
  ]) {
    await assert.rejects(
      fixture({ fillResponse }).api.queryFills("BTCUSDT", query),
      /invalid fill list/,
    );
  }

  const legacy = fixture({
    fillResponse: {
      orders: [{ symbol: "BTC-USDT", orderId: 43, qty: "1", price: "100" }],
    },
  });
  assert.equal((await legacy.api.queryFills("BTCUSDT", {
    ...query, currency: "USDT",
  })).length, 1);
});

test("queryOrderHistory uses signed GET with a strict array and preserves environment isolation", async () => {
  const startTs = 1699999000000;
  const endTs = 1700000000000;
  const item = { symbol: "BTC-USDT", clientOrderId: "ve_history", orderId: "42" };
  for (const environment of ["vst", "mainnet"]) {
    const history = fixture({ environment, orderHistory: [item] });
    assert.deepEqual(await history.api.queryOrderHistory("BTCUSDT", { startTs, endTs }), [item]);
    const call = history.calls[0];
    assert.equal(call.options.method, "GET");
    assert.equal(call.url.pathname, "/openApi/swap/v2/trade/allOrders");
    assert.equal(call.url.searchParams.get("symbol"), "BTC-USDT");
    assert.equal(call.url.searchParams.get("startTime"), String(startTs));
    assert.equal(call.url.searchParams.get("endTime"), String(endTs));
    assert.equal(call.url.searchParams.get("limit"), "500");
    assert.equal(call.url.origin, environment === "vst"
      ? "https://open-api-vst.bingx.com" : "https://open-api.bingx.com");
  }

  assert.deepEqual(
    await fixture({ orderHistoryResponse: { orders: [item] } }).api
      .queryOrderHistory("BTCUSDT", { startTs, endTs }),
    [item],
  );
  const attachedChild = { symbol: "BTC-USDT", clientOrderId: "", type: "STOP_MARKET" };
  assert.deepEqual(
    await fixture({ orderHistoryResponse: { orders: [attachedChild] } }).api
      .queryOrderHistory("BTCUSDT", { startTs, endTs }),
    [attachedChild],
  );
  // Orders placed by hand (no client ID) are left out, never fail the read.
  for (const manual of [
    { symbol: "BTC-USDT", clientOrderId: "", type: "MARKET" },
    { symbol: "BTC-USDT" },
    { symbol: "BTC-USDT", clientOrderId: null, clientOrderID: "", type: "LIMIT" },
  ]) {
    assert.deepEqual(
      await fixture({ orderHistoryResponse: { orders: [manual, item] } }).api
        .queryOrderHistory("BTCUSDT", { startTs, endTs }),
      [item],
    );
  }
  for (const orderHistoryResponse of [
    { data: [] },
    [{ symbol: "ETH-USDT", clientOrderId: "ve_history" }],
    [{ symbol: "BTC-USDT", clientOrderId: "one", clientOrderID: "two" }],
    Array.from({ length: 500 }, (_, index) => ({
      symbol: "BTC-USDT", clientOrderId: `history-${index}`,
    })),
  ]) {
    await assert.rejects(
      fixture({ orderHistoryResponse }).api.queryOrderHistory("BTCUSDT", { startTs, endTs }),
      /invalid order history/,
    );
  }
  await assert.rejects(
    fixture({ orderHistory: [item] }).api.queryOrderHistory("BTCUSDT", {
      startTs: 1, endTs,
    }),
    /bounded recent/,
  );
});

test("automated symbol split enforces VST policy, LONG10 and fresh mark before stop submission", async () => {
  const original = {
    symbol: "DOGE-USDT", orderId: "signal-stop", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "doge-position",
    origQty: "10", stopPrice: "98", workingType: "MARK_PRICE", mainOrderId: "entry-doge",
  };
  const base = {
    symbol: "DOGE-USDT", dualSidePosition: true, longLeverage: 10, shortLeverage: 4,
    positions: [{
      symbol: "DOGE-USDT", positionSide: "LONG", positionAmt: "10",
      positionId: "doge-position",
    }], orders: [original],
  };
  const args = {
    symbol: "DOGEUSDT", policy: VST_AUTOMATED_LONG_POLICY, quantity: "8",
    stopPrice: "98", positionId: "doge-position", originalStopOrderId: "signal-stop",
    originalStopPrice: "98", entryOrderId: "entry-doge", totalQuantity: "10",
    tranche: "core", breakEvenPrice: "100",
  };
  const mainnet = fixture({ ...base, environment: "mainnet" });
  await assert.rejects(
    mainnet.api.placeVstAutomatedVirtualSplitLongStop(args), /VST automated LONG policy/,
  );
  assert.equal(mainnet.calls.length, 0);
  const noPolicy = fixture(base);
  await assert.rejects(noPolicy.api.placeVstAutomatedVirtualSplitLongStop({
    ...args, policy: undefined,
  }), /VST automated LONG policy/);
  assert.equal(noPolicy.calls.length, 0);
  const wrongLeverage = fixture({ ...base, longLeverage: 9 });
  await assert.rejects(
    wrongLeverage.api.placeVstAutomatedVirtualSplitLongStop(args), /LONG 10x/,
  );
  assert.equal(wrongLeverage.calls.some(({ options }) => options.method === "POST"), false);
  const triggered = fixture({
    ...base, markPrice: "110", markPricesByRead: ["110", "98"],
  });
  await assert.rejects(
    triggered.api.placeVstAutomatedVirtualSplitLongStop(args), /final pre-sign check failed/,
  );
  assert.equal(triggered.calls.some(({ options }) => options.method === "POST"), false);
});

test("VST active stop zero-position query sentinel is corroborated only by exact open-order evidence", async () => {
  const positionId = "2105662971440005121";
  const newOrderId = "2105663921788116992";
  const original = {
    symbol: "DOGE-USDT", orderId: "2105662972415795200",
    type: "STOP_MARKET", status: "NEW", side: "SELL",
    positionSide: "LONG", positionId, origQty: "102868.0",
    stopPrice: "0.08262", workingType: "MARK_PRICE",
    mainOrderId: "", executedQty: "0.0",
  };
  const base = {
    symbol: "DOGE-USDT", dualSidePosition: true,
    longLeverage: 10, shortLeverage: 4,
    quantityPrecision: 1, pricePrecision: 5, markPrice: "0.1",
    positions: [{
      symbol: "DOGE-USDT", positionSide: "LONG",
      positionAmt: "102868.0", positionId,
    }],
    orders: [original],
    stopOrderIdOverride: newOrderId,
    stopPostResponse: { orderId: newOrderId },
    activeStopQueryTransform: (row) => {
      delete row.positionId;
      row.positionID = 0;
      row.closePosition = "";
      return row;
    },
  };
  const args = {
    symbol: "DOGEUSDT", policy: VST_AUTOMATED_LONG_POLICY,
    quantity: "82294.4", stopPrice: "0.08262",
    positionId, originalStopOrderId: original.orderId,
    originalStopPrice: "0.08262", entryOrderId: "entry-doge",
    totalQuantity: "102868.0", tranche: "core", breakEvenPrice: "0.1",
  };

  const success = fixture(base);
  const result = await success.api.placeVstAutomatedVirtualSplitLongStop(args);
  assert.equal(result.orderId, newOrderId);
  assert.equal(result.verified, true);
  assert.equal(success.state.orders.length, 2);
  assert.equal(success.calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST" &&
    url.searchParams.get("type") === "STOP_MARKET").length, 1);
  assert.equal(success.calls.some(({ options }) => options.method === "DELETE"), false);
  assert.ok(success.calls.some(({ url, options }) =>
    url.pathname === orderPath && options.method === "GET" &&
    url.searchParams.get("orderId") === newOrderId));

  const mismatch = fixture({
    ...base,
    activeStopQueryTransform: (row) => {
      delete row.positionId;
      row.positionID = 0;
      row.closePosition = "";
      row.stopPrice = "0.08263";
      return row;
    },
  });
  await assert.rejects(
    mismatch.api.placeVstAutomatedVirtualSplitLongStop(args),
    /exact-ID query did not confirm its active open-order identity/,
  );
  await assert.rejects(
    mismatch.api.placeVstAutomatedVirtualSplitLongStop(args),
    /already submitted; reconcile, never retry/,
  );
  assert.equal(mismatch.calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST" &&
    url.searchParams.get("type") === "STOP_MARKET").length, 1);
  assert.equal(mismatch.calls.some(({ options }) => options.method === "DELETE"), false);

  const mixedAliases = fixture({
    ...base,
    activeStopQueryTransform: (row) => {
      row.positionID = 0;
      row.closePosition = "";
      return row;
    },
  });
  await assert.rejects(
    mixedAliases.api.placeVstAutomatedVirtualSplitLongStop(args),
    /exact-ID query did not confirm its active open-order identity/,
  );
  assert.equal(mixedAliases.calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST" &&
    url.searchParams.get("type") === "STOP_MARKET").length, 1);
  assert.equal(mixedAliases.calls.some(({ options }) => options.method === "DELETE"), false);

  const conflictingOrderAliases = fixture({
    ...base,
    activeStopQueryTransform: (row) => {
      const exactOrderId = String(row.orderID ?? row.orderId);
      row.orderID = exactOrderId;
      row.orderId = "conflicting-order";
      return row;
    },
  });
  await assert.rejects(
    conflictingOrderAliases.api.placeVstAutomatedVirtualSplitLongStop(args),
    /exact-ID query did not confirm its active open-order identity/,
  );
  assert.equal(conflictingOrderAliases.calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST" &&
    url.searchParams.get("type") === "STOP_MARKET").length, 1);
  assert.equal(
    conflictingOrderAliases.calls.some(({ options }) => options.method === "DELETE"),
    false,
  );
});

test("automated split runner refuses a shrunk position or any extra stop before POST", async () => {
  const original = {
    symbol: "DOGE-USDT", orderId: "signal-stop", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "doge-position",
    origQty: "10", stopPrice: "98", workingType: "MARK_PRICE", mainOrderId: "entry-doge",
  };
  const core = {
    symbol: "DOGE-USDT", orderId: "core-80", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "doge-position",
    origQty: "8", stopPrice: "98", workingType: "MARK_PRICE", mainOrderId: "entry-doge",
  };
  const position = {
    symbol: "DOGE-USDT", positionSide: "LONG", positionAmt: "10",
    positionId: "doge-position",
  };
  const base = {
    symbol: "DOGE-USDT", dualSidePosition: true, longLeverage: 10, shortLeverage: 4,
    markPrice: "110", positions: [position], orders: [original, core],
  };
  const args = {
    symbol: "DOGEUSDT", policy: VST_AUTOMATED_LONG_POLICY,
    positionId: "doge-position", originalStopOrderId: "signal-stop",
    originalStopPrice: "98", entryOrderId: "entry-doge", totalQuantity: "10",
    quantity: "2", stopPrice: "100", tranche: "runner", breakEvenPrice: "100",
    existingReplacementStops: [{
      tranche: "core", orderId: "core-80", quantity: "8", stopPrice: "98",
    }],
  };

  // The original read is still full size; the separate final pre-sign read
  // observes that a prior 20% close shrank the position to the 80% core.
  const shrunkBeforePost = fixture({
    ...base,
    responseSequences: {
      "/openApi/swap/v2/user/positions": [
        { data: [position] },
        { data: [{ ...position, positionAmt: "8" }] },
      ],
    },
  });
  await assert.rejects(
    shrunkBeforePost.api.placeVstAutomatedVirtualSplitLongStop(args),
    /final pre-sign check failed/,
  );
  assert.equal(shrunkBeforePost.calls.filter(({ url }) =>
    url.pathname === orderPath && url.searchParams.get("type") === "STOP_MARKET").length, 0);
  assert.ok(shrunkBeforePost.calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/user/positions").length >= 2);
  assert.equal(shrunkBeforePost.calls.some(({ options }) =>
    options.method === "DELETE"), false);

  // Even a same-spec duplicate of the approved core stop is not a valid
  // baseline. Reject before submission rather than adding another full-size
  // stop or trying to repair/cancel an exchange order.
  const extraStop = { ...core, orderId: "unapproved-extra-core" };
  const extraOpenOrder = fixture({
    ...base,
    responseSequences: {
      "/openApi/swap/v2/trade/openOrders": [
        { data: [original, core] },
        { data: [original, core, extraStop] },
      ],
    },
  });
  await assert.rejects(
    extraOpenOrder.api.placeVstAutomatedVirtualSplitLongStop(args),
    /final pre-sign check failed/,
  );
  assert.equal(extraOpenOrder.calls.filter(({ url }) =>
    url.pathname === orderPath && url.searchParams.get("type") === "STOP_MARKET").length, 0);
  assert.ok(extraOpenOrder.calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/trade/openOrders").length >= 2);
  assert.equal(extraOpenOrder.calls.some(({ options }) =>
    options.method === "DELETE"), false);
});

test("automated symbol 80/20 split keeps signal protection through stop verification, cancel and close", async () => {
  const original = {
    symbol: "DOGE-USDT", orderId: "signal-stop", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "doge-position",
    origQty: "10", stopPrice: "98", workingType: "MARK_PRICE", mainOrderId: "entry-doge",
  };
  const { api, calls, state } = fixture({
    symbol: "DOGE-USDT", dualSidePosition: true, longLeverage: 10, shortLeverage: 4,
    markPrice: "110",
    advanceClockOnSleep: true, stopPostResponse: {}, simulateMarketClose: true,
    positions: [{
      symbol: "DOGE-USDT", positionSide: "LONG", positionAmt: "10",
      positionId: "doge-position",
    }], orders: [original],
  });
  const base = {
    symbol: "DOGEUSDT", policy: VST_AUTOMATED_LONG_POLICY,
    positionId: "doge-position", originalStopOrderId: "signal-stop",
    originalStopPrice: "98", entryOrderId: "entry-doge", totalQuantity: "10",
    breakEvenPrice: "100",
  };
  const core = await api.placeVstAutomatedVirtualSplitLongStop({
    ...base, quantity: "8", stopPrice: "98", tranche: "core",
  });
  const runner = await api.placeVstAutomatedVirtualSplitLongStop({
    ...base, quantity: "2", stopPrice: "100", tranche: "runner",
    existingReplacementStops: [core],
  });
  assert.equal(state.orders.length, 3);
  const result = await api.cancelVstAutomatedAttachedLongStopAfterSplit({
    ...base, replacementStops: [core, runner],
  });
  assert.equal(result.status, "CANCELED");
  assert.deepEqual(state.orders.map((row) => row.orderId).sort(), ["new-stop", "new-stop-2"]);
  const close = await api.closeVstAutomatedSplitTranche({
    symbol: "DOGEUSDT", policy: VST_AUTOMATED_LONG_POLICY, quantity: "8",
    totalQuantity: "10", positionId: "doge-position", clientOrderId: "vsa-doge-core",
    trancheStop: core, retainedStop: runner, tranche: "core",
    signalStopPrice: "98", breakEvenPrice: "100",
  });
  assert.equal(close.verified, true);
  assert.equal(close.remainingQuantity, "2");
  assert.equal(close.retainedStop.orderId, runner.orderId);
  const marketPost = calls.find(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST" &&
    url.searchParams.get("type") === "MARKET");
  assert.equal(marketPost.url.searchParams.get("clientOrderId"), "vsa-doge-core");
  assert.equal(marketPost.url.searchParams.get("positionSide"), "LONG");
  const cleanup = await api.cancelVstAutomatedSplitStopAfterPartial({
    symbol: "DOGEUSDT", policy: VST_AUTOMATED_LONG_POLICY, stopToCancel: core,
    retainedStop: runner, remainingQuantity: "2", positionId: "doge-position",
    tranche: "core", signalStopPrice: "98", breakEvenPrice: "100",
  });
  assert.equal(cleanup.status, "CANCELED");
  assert.deepEqual(state.orders.map((row) => row.orderId), [runner.orderId]);
  assert.ok(calls.every(({ options }) => options.redirect === "error"));
});

test("pre-DELETE timestamp refusal proves no cancellation and releases the local reservation", async () => {
  const original = {
    symbol: "DOGE-USDT", orderId: "signal-stop", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "doge-position",
    origQty: "10", stopPrice: "98", workingType: "MARK_PRICE", mainOrderId: "entry-doge",
  };
  const core = {
    symbol: "DOGE-USDT", orderId: "core-80", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "doge-position",
    origQty: "8", stopPrice: "98", workingType: "MARK_PRICE", mainOrderId: "entry-doge",
  };
  const runner = {
    symbol: "DOGE-USDT", orderId: "runner-20", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "doge-position",
    origQty: "2", stopPrice: "100", workingType: "MARK_PRICE", mainOrderId: "entry-doge",
  };
  const leverageRead = {
    symbol: "DOGE-USDT", longLeverage: 10, shortLeverage: 4,
    maxPositionLongVal: "1000000",
  };
  const leverageResponses = [
    { code: 0, data: leverageRead },
    { code: 109400, msg: "timestamp is invalid" },
    { code: 109400, msg: "timestamp is invalid" },
    { code: 109400, msg: "timestamp is invalid" },
  ];
  const { api, calls } = fixture({
    symbol: "DOGE-USDT",
    dualSidePosition: true,
    longLeverage: 10,
    shortLeverage: 4,
    positions: [{
      symbol: "DOGE-USDT", positionSide: "LONG", positionAmt: "10",
      positionId: "doge-position",
    }],
    orders: [original, core, runner],
    responseSequences: {
      [leveragePath]: leverageResponses,
    },
  });
  const args = {
    symbol: "DOGEUSDT", policy: VST_AUTOMATED_LONG_POLICY,
    originalStopOrderId: "signal-stop", originalStopPrice: "98",
    positionId: "doge-position", entryOrderId: "entry-doge", totalQuantity: "10",
    breakEvenPrice: "100",
    replacementStops: [
      { tranche: "core", orderId: "core-80", quantity: "8", stopPrice: "98" },
      { tranche: "runner", orderId: "runner-20", quantity: "2", stopPrice: "100" },
    ],
  };

  await assert.rejects(api.cancelVstAutomatedAttachedLongStopAfterSplit(args), (error) => {
    assert.equal(error.code, 109400, `${error.name}: ${error.message}`);
    assert.equal(error.method, "GET");
    assert.equal(error.endpoint, leveragePath);
    assert.equal(error.exchangeMessage, "timestamp is invalid");
    assert.deepEqual(error.mutationProvenance, {
      operation: "cancel_original_stop",
      mutationMethod: "DELETE",
      mutationEndpoint: orderPath,
      mutationRequestSent: false,
      phase: "pre_mutation_read",
    });
    return true;
  });
  assert.equal(calls.some(({ url, options }) =>
    url.pathname === orderPath && options.method === "DELETE"), false);
  assert.deepEqual(calls.slice(0, 4).map(({ url }) =>
    url.searchParams.get("timestamp")).every(Boolean), true);

  // Other exchange text from a nested pre-sign read is not copied into this
  // categorical wrapper, while the source code/method/endpoint stay useful.
  leverageResponses[5] = {
    code: 109418, msg: "unreviewed exchange text must not be persisted",
  };
  await assert.rejects(api.cancelVstAutomatedAttachedLongStopAfterSplit(args), (error) => {
    assert.equal(error.code, 109418);
    assert.equal(error.method, "GET");
    assert.equal(error.endpoint, leveragePath);
    assert.equal(error.exchangeMessage, undefined);
    assert.equal(error.message.includes("unreviewed exchange text"), false);
    assert.equal(error.mutationProvenance.mutationRequestSent, false);
    return true;
  });
  delete leverageResponses[5];

  // The pre-sign read refusal released the adapter's in-memory intent guard.
  const result = await api.cancelVstAutomatedAttachedLongStopAfterSplit(args);
  assert.equal(result.status, "CANCELED");
  assert.equal(calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "DELETE").length, 1);
});

test("automated original-stop cancellation requires exact explicit zero execution quantities", async () => {
  const openOrdersPath = "/openApi/swap/v2/trade/openOrders";
  const original = {
    symbol: "DOGE-USDT", orderId: "signal-stop", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "doge-position",
    origQty: "10", executedQty: "0.000", stopPrice: "98",
    workingType: "MARK_PRICE", mainOrderId: "entry-doge",
  };
  const core = {
    symbol: "DOGE-USDT", orderId: "core-80", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "doge-position",
    origQty: "8", executedQty: "0.000", stopPrice: "98",
    workingType: "MARK_PRICE", mainOrderId: "entry-doge",
  };
  const runner = {
    symbol: "DOGE-USDT", orderId: "runner-20", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "doge-position",
    origQty: "2", executedQty: "0.000", stopPrice: "100",
    workingType: "MARK_PRICE", mainOrderId: "entry-doge",
  };
  const validOrders = [original, core, runner];
  const args = {
    symbol: "DOGEUSDT", policy: VST_AUTOMATED_LONG_POLICY,
    originalStopOrderId: "signal-stop", originalStopPrice: "98",
    positionId: "doge-position", entryOrderId: "entry-doge", totalQuantity: "10",
    breakEvenPrice: "100",
    replacementStops: [
      { tranche: "core", orderId: "core-80", quantity: "8", stopPrice: "98" },
      { tranche: "runner", orderId: "runner-20", quantity: "2", stopPrice: "100" },
    ],
  };
  const makeFixture = (orders, extra = {}) => fixture({
    symbol: "DOGE-USDT",
    dualSidePosition: true,
    longLeverage: 10,
    shortLeverage: 4,
    positions: [{
      symbol: "DOGE-USDT", positionSide: "LONG", positionAmt: "10",
      positionId: "doge-position",
    }],
    orders,
    normalizeActiveStopExecutionQty: false,
    ...extra,
  });
  const mutations = [
    ...validOrders.flatMap((_row, rowIndex) => [
      {
        label: `missing row ${rowIndex}`,
        rowIndex,
        mutate: (row) => {
          for (const field of stopExecutionQuantityFields) delete row[field];
        },
      },
      {
        label: `nonzero exact decimal row ${rowIndex}`,
        rowIndex,
        mutate: (row) => {
          row.executedQty =
            "0.000000000000000000000000000000000000000000000000000001";
        },
      },
    ]),
    {
      label: "malformed execution quantity",
      mutate: (row) => { row.executedQty = "0.0.0"; },
      rowIndex: 1,
    },
    {
      label: "conflicting execution aliases",
      mutate: (row) => { row.cumExecQty = "1"; },
      rowIndex: 2,
    },
  ];
  for (const mutation of mutations) {
    const mutated = validOrders.map((row) => ({ ...row }));
    mutation.mutate(mutated[mutation.rowIndex]);
    const { api, calls } = makeFixture(mutated);
    await assert.rejects(api.cancelVstAutomatedAttachedLongStopAfterSplit(args),
      (error) => {
        assert.deepEqual(error.mutationProvenance, {
          operation: "cancel_original_stop",
          mutationMethod: "DELETE",
          mutationEndpoint: orderPath,
          mutationRequestSent: false,
          phase: "pre_mutation_read",
        }, mutation.label);
        return true;
      });
    assert.equal(calls.filter(({ url }) => url.pathname === openOrdersPath).length,
      1, mutation.label);
    assert.equal(calls.some(({ url, options }) =>
      url.pathname === orderPath && ["POST", "DELETE"].includes(options.method)),
    false, mutation.label);
  }

  // Execution evidence is checked again in beforeSign, after the first valid
  // snapshot and exact-ID reads, immediately before DELETE may start.
  const nonzeroRunner = validOrders.map((row) => ({ ...row }));
  nonzeroRunner[2].executedQty = "0.000000000000000000000000000000000000000000000000000001";
  const finalRead = makeFixture(validOrders, {
    responseSequences: {
      [openOrdersPath]: [
        { data: validOrders },
        { data: nonzeroRunner },
      ],
    },
  });
  await assert.rejects(finalRead.api.cancelVstAutomatedAttachedLongStopAfterSplit(args),
    (error) => {
      assert.deepEqual(error.mutationProvenance, {
        operation: "cancel_original_stop",
        mutationMethod: "DELETE",
        mutationEndpoint: orderPath,
        mutationRequestSent: false,
        phase: "pre_mutation_read",
      });
      return true;
    });
  assert.equal(finalRead.calls.filter(({ url }) =>
    url.pathname === openOrdersPath).length, 2);
  assert.equal(finalRead.calls.some(({ url, options }) =>
    url.pathname === orderPath && ["POST", "DELETE"].includes(options.method)), false);

  // Reviewed explicit aliases are accepted if they independently parse to
  // exact zero; no floating-point coercion is involved.
  const aliasOrders = validOrders.map((row) => ({ ...row }));
  delete aliasOrders[1].executedQty;
  aliasOrders[1].executedQuantity = "0.000";
  delete aliasOrders[2].executedQty;
  aliasOrders[2].cumExecQty = "0";
  const aliasProof = makeFixture(aliasOrders);
  const result = await aliasProof.api.cancelVstAutomatedAttachedLongStopAfterSplit(args);
  assert.equal(result.status, "CANCELED");
  assert.equal(aliasProof.calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "DELETE").length, 1);
});

test("post-DELETE failures never carry a no-send proof or permit local replay", async () => {
  const original = {
    symbol: "DOGE-USDT", orderId: "signal-stop", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "doge-position",
    origQty: "10", stopPrice: "98", workingType: "MARK_PRICE", mainOrderId: "entry-doge",
  };
  const core = {
    symbol: "DOGE-USDT", orderId: "core-80", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "doge-position",
    origQty: "8", stopPrice: "98", workingType: "MARK_PRICE", mainOrderId: "entry-doge",
  };
  const runner = {
    symbol: "DOGE-USDT", orderId: "runner-20", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "doge-position",
    origQty: "2", stopPrice: "100", workingType: "MARK_PRICE", mainOrderId: "entry-doge",
  };
  const { api, calls } = fixture({
    symbol: "DOGE-USDT",
    dualSidePosition: true,
    longLeverage: 10,
    shortLeverage: 4,
    positions: [{
      symbol: "DOGE-USDT", positionSide: "LONG", positionAmt: "10",
      positionId: "doge-position",
    }],
    orders: [original, core, runner],
    failDeleteAfterApply: true,
  });
  const args = {
    symbol: "DOGEUSDT", policy: VST_AUTOMATED_LONG_POLICY,
    originalStopOrderId: "signal-stop", originalStopPrice: "98",
    positionId: "doge-position", entryOrderId: "entry-doge", totalQuantity: "10",
    breakEvenPrice: "100",
    replacementStops: [
      { tranche: "core", orderId: "core-80", quantity: "8", stopPrice: "98" },
      { tranche: "runner", orderId: "runner-20", quantity: "2", stopPrice: "100" },
    ],
  };

  await assert.rejects(api.cancelVstAutomatedAttachedLongStopAfterSplit(args), (error) => {
    assert.equal(error.transportStage, "network_request", `${error.name}: ${error.message}`);
    assert.deepEqual(error.mutationProvenance, {
      operation: "cancel_original_stop",
      mutationMethod: "DELETE",
      mutationEndpoint: orderPath,
      mutationRequestSent: true,
      phase: "mutation_transport_started",
    });
    return true;
  });
  await assert.rejects(
    api.cancelVstAutomatedAttachedLongStopAfterSplit(args),
    /already submitted; reconcile, never retry/,
  );
  assert.equal(calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "DELETE").length, 1);
});

test("automated symbol split halt-on-ambiguity never retries or removes signal stop", async () => {
  const original = {
    symbol: "DOGE-USDT", orderId: "signal-stop", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "doge-position",
    origQty: "10", stopPrice: "98", workingType: "MARK_PRICE",
  };
  const { api, calls, state } = fixture({
    symbol: "DOGE-USDT", dualSidePosition: true, longLeverage: 10, shortLeverage: 4,
    advanceClockOnSleep: true, stopPostResponse: {}, duplicateStopOnPost: true,
    positions: [{
      symbol: "DOGE-USDT", positionSide: "LONG", positionAmt: "10",
      positionId: "doge-position",
    }], orders: [original],
  });
  const args = {
    symbol: "DOGEUSDT", policy: VST_AUTOMATED_LONG_POLICY, quantity: "8",
    stopPrice: "98", positionId: "doge-position", originalStopOrderId: "signal-stop",
    originalStopPrice: "98", totalQuantity: "10", tranche: "core",
    breakEvenPrice: "100",
  };
  await assert.rejects(api.placeVstAutomatedVirtualSplitLongStop(args), /foreign orders|ambiguous/);
  await assert.rejects(api.placeVstAutomatedVirtualSplitLongStop(args), /already submitted/);
  assert.equal(calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST").length, 1);
  assert.equal(calls.some(({ options }) => options.method === "DELETE"), false);
  assert.ok(state.orders.some((row) => row.orderId === "signal-stop"));
});

test("triggered runner recovery requires exact child fill linkage and cancels only resized original", async () => {
  const original = {
    symbol: "DOGE-USDT", orderId: "original-80", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "doge-position",
    origQty: "8", stopPrice: "98", workingType: "MARK_PRICE",
  };
  const core = {
    symbol: "DOGE-USDT", orderId: "core-80", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "doge-position",
    origQty: "8", stopPrice: "98", workingType: "MARK_PRICE",
  };
  const runner = {
    symbol: "DOGE-USDT", orderId: "runner-child", type: "STOP_MARKET", status: "FILLED",
    side: "SELL", positionSide: "LONG", positionID: 0,
    qty: "2", executedQty: "2", stopPrice: "100", workingType: "MARK_PRICE", mainOrderId: "",
  };
  const child = {
    symbol: "DOGE-USDT", orderId: "runner-child", type: "STOP_MARKET", status: "FILLED",
    side: "SELL", positionSide: "LONG", positionId: "doge-position",
    origQty: "2", executedQty: "2", stopPrice: "100", workingType: "MARK_PRICE",
  };
  const runnerFill = {
    symbol: "DOGE-USDT", orderId: "runner-child", triggerOrderId: "runner-20",
    side: "SELL", positionSide: "LONG", qty: "2", price: "100",
    filledTm: 1700000000000,
    commission: "0.01", commissionAsset: "VST",
  };
  const staleBuyFill = {
    symbol: "DOGE-USDT", orderId: "old-entry", triggerOrderId: 0,
    side: "BUY", positionSide: "LONG", qty: "10", price: "100",
    filledTm: 1600000000000, commission: "0.01", commissionAsset: "VST",
  };
  const runnerHistory = { ...runner, clientOrderId: "" };
  const base = {
    symbol: "DOGE-USDT", dualSidePosition: true, longLeverage: 10, shortLeverage: 3,
    filterFillsByTime: true,
    positions: [{
      symbol: "DOGE-USDT", positionSide: "LONG", positionAmt: "8",
      positionId: "doge-position",
    }],
    orders: [original, core],
    ordersById: { "runner-20": runner, "runner-child": child },
    fills: [runnerFill, staleBuyFill], orderHistory: [runnerHistory],
  };
  const args = {
    symbol: "DOGEUSDT", policy: VST_AUTOMATED_LONG_POLICY,
    positionId: "doge-position", runnerStopOrderId: "runner-20",
    runnerChildOrderId: "runner-child", originalStopOrderId: "original-80",
    coreStopOrderId: "core-80", totalQuantity: "10", remainingQuantity: "8",
    signalStopPrice: "98", breakEvenPrice: "100",
    cancellationIntentId: "persisted-runner-recovery-1",
    runnerFillAt: 1700000000000,
  };
  const recovered = fixture(base);
  const result = await recovered.api.cancelVstAutomatedOriginalAfterTriggeredRunner(args);
  assert.equal(result.verified, true);
  assert.equal(result.status, "CANCELED");
  assert.equal(result.coreStopOrderId, "core-80");
  assert.deepEqual(recovered.state.orders.map((row) => row.orderId), ["core-80"]);
  const deletion = recovered.calls.find(({ url, options }) => options.method === "DELETE");
  assert.equal(deletion.url.searchParams.get("orderId"), "original-80");
  const fillRead = recovered.calls.find(({ url }) =>
    url.pathname === "/openApi/swap/v2/trade/allFillOrders");
  assert.equal(Number(fillRead.url.searchParams.get("startTs")), 1699999999999);
  assert.ok(recovered.calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/trade/allFillOrders")
  .every(({ url }) => Number(url.searchParams.get("startTs")) === 1699999999999));
  assert.equal(recovered.calls.every(({ url }) =>
    url.origin === "https://open-api-vst.bingx.com"), true);

  const outsideFillWindow = fixture(base);
  await assert.rejects(
    outsideFillWindow.api.cancelVstAutomatedOriginalAfterTriggeredRunner({
      ...args,
      runnerFillAt: 1700000000000 - 23 * 60 * 60 * 1000,
    }),
    /recent persisted runner fill timestamp/,
  );
  assert.equal(outsideFillWindow.calls.some(({ url, options }) =>
    url.pathname === "/openApi/swap/v2/trade/allFillOrders" ||
    options.method === "DELETE"), false);

  const mismatch = fixture({
    ...base, fills: [{ ...runnerFill, triggerOrderId: "different-runner" }],
  });
  await assert.rejects(
    mismatch.api.cancelVstAutomatedOriginalAfterTriggeredRunner(args),
    /does not uniquely link/,
  );
  assert.equal(mismatch.calls.some(({ options }) => options.method === "DELETE"), false);

  const conflictingParentChild = fixture({
    ...base,
    ordersById: {
      ...base.ordersById,
      "runner-20": { ...runner, orderID: "runner-20" },
    },
  });
  await assert.rejects(
    conflictingParentChild.api.cancelVstAutomatedOriginalAfterTriggeredRunner(args),
    /parent order|identity|order ID/i,
  );
  assert.equal(conflictingParentChild.calls.some(
    ({ options }) => options.method === "DELETE",
  ), false);

  const conflictingFillPosition = fixture({
    ...base,
    fills: [{
      ...runnerFill, positionId: "doge-position", positionID: "other-position",
    }, staleBuyFill],
  });
  await assert.rejects(
    conflictingFillPosition.api.cancelVstAutomatedOriginalAfterTriggeredRunner(args),
    /incomplete|exactly match/i,
  );
  assert.equal(conflictingFillPosition.calls.some(
    ({ options }) => options.method === "DELETE",
  ), false);

  const unavailableHistory = fixture({ ...base, orderHistory: [] });
  const recoveryWithoutHistory =
    await unavailableHistory.api.cancelVstAutomatedOriginalAfterTriggeredRunner(args);
  assert.equal(recoveryWithoutHistory.verified, true);
  assert.equal(unavailableHistory.calls.some(({ url }) =>
    url.pathname === "/openApi/swap/v2/trade/allOrders"), false);

  const foreignOrder = fixture({
    ...base,
    orders: [...base.orders, {
      symbol: "DOGE-USDT", orderId: "foreign", type: "LIMIT", status: "NEW",
    }],
  });
  await assert.rejects(
    foreignOrder.api.cancelVstAutomatedOriginalAfterTriggeredRunner(args),
    /only the original and core stops/,
  );
  assert.equal(foreignOrder.calls.some(({ options }) => options.method === "DELETE"), false);

  const mainnet = fixture({ ...base, environment: "mainnet" });
  await assert.rejects(
    mainnet.api.cancelVstAutomatedOriginalAfterTriggeredRunner(args), /VST automated LONG policy/,
  );
  assert.equal(mainnet.calls.length, 0);

  const ambiguousDelete = fixture({ ...base, failDeleteAfterApply: true });
  await assert.rejects(
    ambiguousDelete.api.cancelVstAutomatedOriginalAfterTriggeredRunner(args), /request failed/,
  );
  await assert.rejects(
    ambiguousDelete.api.cancelVstAutomatedOriginalAfterTriggeredRunner(args), /already used/,
  );
  assert.equal(ambiguousDelete.calls.filter(({ options }) =>
    options.method === "DELETE").length, 1);
});

test("automated split-leg stop upgrade preserves both protections across its two durable phases", async () => {
  const core = {
    symbol: "DOGE-USDT", orderId: "core-80", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "doge-position",
    origQty: "8", stopPrice: "98", workingType: "MARK_PRICE",
  };
  const runner = {
    symbol: "DOGE-USDT", orderId: "runner-20", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "doge-position",
    origQty: "2", stopPrice: "100", workingType: "MARK_PRICE",
  };
  const base = {
    symbol: "DOGE-USDT", dualSidePosition: true, longLeverage: 10, shortLeverage: 4,
    markPrice: "110",
    positions: [{
      symbol: "DOGE-USDT", positionSide: "LONG", positionAmt: "10",
      positionId: "doge-position",
    }],
    orders: [core, runner],
  };
  const args = {
    symbol: "DOGEUSDT", policy: VST_AUTOMATED_LONG_POLICY,
    positionId: "doge-position", totalQuantity: "10", leg: "runner",
    oldStop: { tranche: "runner", orderId: "runner-20", quantity: "2", stopPrice: "100" },
    otherStop: { tranche: "core", orderId: "core-80", quantity: "8", stopPrice: "98" },
    newStopPrice: "105", clientOrderId: "vsa-doge-runner-upgrade",
    upgradeIntentId: "persisted-runner-upgrade-1",
  };
  const { api, calls, state } = fixture({ ...base, stopPostResponse: {} });
  const phaseOne = await api.placeVstAutomatedSplitLegStopUpgrade(args);
  assert.equal(phaseOne.verified, true);
  assert.equal(phaseOne.newStop.quantity, "2");
  assert.equal(phaseOne.newStop.stopPrice, "105");
  assert.equal(state.orders.length, 3);
  const post = calls.find(({ options, url }) =>
    options.method === "POST" && url.searchParams.get("type") === "STOP_MARKET");
  assert.equal(post.url.searchParams.get("clientOrderId"), args.clientOrderId);
  assert.deepEqual(post.ordersAtCall.map((row) => row.orderId).sort(),
    ["core-80", "runner-20"]);
  const phaseTwo = await api.cancelVstAutomatedSplitLegStopUpgrade({
    ...args, newStop: phaseOne.newStop,
  });
  assert.equal(phaseTwo.verified, true);
  assert.equal(phaseTwo.canceledStopOrderId, "runner-20");
  assert.deepEqual(state.orders.map((row) => row.orderId).sort(),
    ["core-80", phaseOne.newStop.orderId]);
  const deletion = calls.find(({ options, url }) =>
    options.method === "DELETE" && url.searchParams.has("orderId"));
  assert.equal(deletion.url.searchParams.get("orderId"), "runner-20");
  assert.ok(calls.every(({ url }) => url.origin === "https://open-api-vst.bingx.com"));

  const ambiguous = fixture({ ...base, failStopPostAfterApply: true });
  await assert.rejects(
    ambiguous.api.placeVstAutomatedSplitLegStopUpgrade(args), /request failed/,
  );
  await assert.rejects(
    ambiguous.api.placeVstAutomatedSplitLegStopUpgrade(args), /already submitted/,
  );
  assert.equal(ambiguous.calls.some(({ options }) => options.method === "DELETE"), false);
  assert.ok(ambiguous.state.orders.some((row) => row.orderId === "runner-20"));

  const crossedMark = fixture({ ...base, markPrice: "104" });
  await assert.rejects(
    crossedMark.api.placeVstAutomatedSplitLegStopUpgrade(args), /fresh mark above/,
  );
  assert.equal(crossedMark.calls.some(({ options }) => options.method === "POST"), false);

  const missingNewProof = fixture({
    ...base, stopPostResponse: {}, duplicateStopOnPost: true,
  });
  await assert.rejects(
    missingNewProof.api.placeVstAutomatedSplitLegStopUpgrade(args),
    /POST is uncertain/,
  );
  assert.ok(missingNewProof.state.orders.some((row) => row.orderId === "runner-20"));

  const ambiguousCancel = fixture({ ...base, failDeleteAfterApply: true });
  const cancelPhaseOne = await ambiguousCancel.api.placeVstAutomatedSplitLegStopUpgrade(args);
  const cancelArgs = { ...args, newStop: cancelPhaseOne.newStop };
  await assert.rejects(
    ambiguousCancel.api.cancelVstAutomatedSplitLegStopUpgrade(cancelArgs), /request failed/,
  );
  await assert.rejects(
    ambiguousCancel.api.cancelVstAutomatedSplitLegStopUpgrade(cancelArgs), /already submitted/,
  );
  assert.equal(ambiguousCancel.calls.filter(({ options }) =>
    options.method === "DELETE").length, 1);

  const mainnet = fixture({ ...base, environment: "mainnet" });
  await assert.rejects(
    mainnet.api.placeVstAutomatedSplitLegStopUpgrade(args), /VST automated LONG policy/,
  );
  assert.equal(mainnet.calls.length, 0);
});

test("automated sole split leg closes by exact MARKET fill and fees, then removes stop only while flat", async () => {
  const stop = {
    tranche: "core", symbol: "DOGE-USDT", orderId: "last-core-stop",
    type: "STOP_MARKET", status: "NEW", side: "SELL", positionSide: "LONG",
    positionId: "doge-position", origQty: "2", stopPrice: "105",
    workingType: "MARK_PRICE",
  };
  const base = {
    symbol: "DOGE-USDT", dualSidePosition: true, longLeverage: 10, shortLeverage: 4,
    simulateMarketClose: true,
    positions: [{
      symbol: "DOGE-USDT", positionSide: "LONG", positionAmt: "2",
      positionId: "doge-position",
    }],
    orders: [stop],
  };
  const args = {
    symbol: "DOGEUSDT", policy: VST_AUTOMATED_LONG_POLICY,
    positionId: "doge-position", quantity: "2", stop,
    clientOrderId: "vsa-doge-last-core-close",
    closeIntentId: "persisted-last-core-close-1",
  };
  const { api, calls, state } = fixture(base);
  const result = await api.closeVstAutomatedSoleSplitLeg(args);
  assert.equal(result.verified, true);
  assert.equal(result.flat, true);
  assert.equal(result.noOpenStops, true);
  assert.equal(result.fees.length, 1);
  assert.equal(result.fees[0].amount, "0.01");
  assert.equal(result.fees[0].asset, "VST");
  assert.equal(state.positions[0].positionAmt, "0");
  assert.equal(state.orders.length, 0);
  const market = calls.find(({ options, url }) =>
    options.method === "POST" && url.searchParams.get("type") === "MARKET");
  assert.equal(market.url.searchParams.get("quantity"), "2");
  assert.equal(market.url.searchParams.get("positionSide"), "LONG");
  assert.equal(market.url.searchParams.has("reduceOnly"), false);
  assert.equal(market.url.searchParams.get("clientOrderId"), args.clientOrderId);
  const deletes = calls.filter(({ options }) => options.method === "DELETE");
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].url.searchParams.get("orderId"), stop.orderId);
  assert.ok(calls.every(({ url }) => url.origin === "https://open-api-vst.bingx.com"));

  const mainnet = fixture({ ...base, environment: "mainnet" });
  await assert.rejects(
    mainnet.api.closeVstAutomatedSoleSplitLeg(args), /VST automated LONG policy/,
  );
  assert.equal(mainnet.calls.length, 0);

  const badFees = fixture({
    ...base,
    marketFillRows: [{
      symbol: "DOGE-USDT", orderId: "market-close", tradeId: "fee-less",
      side: "SELL", positionSide: "LONG", qty: "2", price: "100",
    }],
  });
  await assert.rejects(
    badFees.api.closeVstAutomatedSoleSplitLeg(args), /fees are incomplete/,
  );
  assert.equal(badFees.calls.some(({ options }) => options.method === "DELETE"), false);
  assert.ok(badFees.state.orders.some((row) => row.orderId === stop.orderId));

  const foreign = fixture({
    ...base,
    orders: [stop, {
      symbol: "DOGE-USDT", orderId: "foreign-order", type: "LIMIT", status: "NEW",
    }],
  });
  await assert.rejects(
    foreign.api.closeVstAutomatedSoleSplitLeg(args), /one exact protective stop/,
  );
  assert.equal(foreign.calls.some(({ options }) =>
    options.method === "POST" && new URLSearchParams(options.body ?? "").get("type") === "MARKET"),
  false);
});

test("automated full split emergency close omits reduceOnly and returns exact lingering known stops", async () => {
  const core = {
    tranche: "core", symbol: "DOGE-USDT", orderId: "core-full-stop",
    type: "STOP_MARKET", status: "NEW", side: "SELL", positionSide: "LONG",
    positionId: "doge-position", origQty: "8", stopPrice: "98",
    workingType: "MARK_PRICE",
  };
  const runner = {
    tranche: "runner", symbol: "DOGE-USDT", orderId: "runner-full-stop",
    type: "STOP_MARKET", status: "NEW", side: "SELL", positionSide: "LONG",
    positionId: "doge-position", origQty: "2", stopPrice: "100",
    workingType: "MARK_PRICE",
  };
  const base = {
    symbol: "DOGE-USDT", dualSidePosition: true, longLeverage: 10, shortLeverage: 4,
    positions: [{
      symbol: "DOGE-USDT", positionSide: "LONG", positionAmt: "10",
      positionId: "doge-position",
    }],
    orders: [core, runner],
    simulateMarketClose: true,
  };
  const args = {
    symbol: "DOGEUSDT", policy: VST_AUTOMATED_LONG_POLICY,
    positionId: "doge-position", totalQuantity: "10",
    coreStop: { tranche: "core", orderId: core.orderId, quantity: "8", stopPrice: "98" },
    runnerStop: {
      tranche: "runner", orderId: runner.orderId, quantity: "2", stopPrice: "100",
    },
    clientOrderId: "vsa-doge-full-close-1",
    closeIntentId: "persisted-full-close-1",
  };
  const lingering = fixture(base);
  const result = await lingering.api.closeVstAutomatedFullSplitPosition(args);
  assert.equal(result.verified, true);
  assert.equal(result.flat, true);
  assert.equal(result.fullyCleaned, false);
  assert.deepEqual(result.remainingKnownStopOrderIds, [core.orderId, runner.orderId]);
  assert.deepEqual(lingering.calls.filter(({ options }) => options.method === "DELETE"), []);
  const market = lingering.calls.find(({ options, url }) =>
    options.method === "POST" && url.searchParams.get("type") === "MARKET");
  assert.equal(market.url.searchParams.has("reduceOnly"), false);
  assert.equal(market.url.searchParams.get("quantity"), "10");
  assert.equal(market.url.searchParams.get("positionSide"), "LONG");
  assert.equal(market.url.searchParams.get("clientOrderId"), args.clientOrderId);

  const autoCanceled = fixture({ ...base, autoCancelStopsOnMarket: true });
  const cleaned = await autoCanceled.api.closeVstAutomatedFullSplitPosition(args);
  assert.equal(cleaned.fullyCleaned, true);
  assert.deepEqual(cleaned.remainingKnownStopOrderIds, []);
  assert.equal(autoCanceled.state.orders.length, 0);
  assert.equal(autoCanceled.calls.filter(({ options }) =>
    options.method === "DELETE").length, 0);

  const historyFallback = fixture({
    ...base, marketPostResponse: {}, dropClientOrderQueries: true,
    orderHistory: [{
      symbol: "DOGE-USDT", orderId: "market-close",
      clientOrderId: args.clientOrderId, type: "MARKET", status: "FILLED",
    }],
  });
  const historyResult = await historyFallback.api.closeVstAutomatedFullSplitPosition({
    ...args, intentCreatedAt: 1700000000000,
  });
  assert.equal(historyResult.closeOrderId, "market-close");
  assert.equal(historyResult.fills[0].orderId, "market-close");
  const historyCall = historyFallback.calls.find(({ url }) =>
    url.pathname === "/openApi/swap/v2/trade/allOrders");
  assert.equal(historyCall.url.searchParams.get("startTime"), "1699999940000");
  assert.ok(historyCall.url.searchParams.get("startTime") > "1");

  const ambiguousHistory = fixture({
    ...base, marketPostResponse: {}, dropClientOrderQueries: true,
    orderHistory: [
      {
        symbol: "DOGE-USDT", orderId: "market-close",
        clientOrderId: args.clientOrderId, type: "MARKET", status: "FILLED",
      },
      {
        symbol: "DOGE-USDT", orderId: "market-close-2",
        clientOrderId: args.clientOrderId, type: "MARKET", status: "FILLED",
      },
    ],
  });
  await assert.rejects(
    ambiguousHistory.api.closeVstAutomatedFullSplitPosition({
      ...args, intentCreatedAt: 1700000000000,
    }), /exactly one recent client-ID match/,
  );

  const denseHistory = fixture({
    ...base, marketPostResponse: {}, dropClientOrderQueries: true,
    orderHistory: Array.from({ length: 500 }, (_, index) => ({
      symbol: "DOGE-USDT", orderId: `order-${index}`,
      clientOrderId: `other-${index}`, type: "MARKET", status: "FILLED",
    })),
  });
  await assert.rejects(
    denseHistory.api.closeVstAutomatedFullSplitPosition({
      ...args, intentCreatedAt: 1700000000000,
    }), /invalid order history/,
  );

  const numericResponse = fixture({
    ...base, marketPostResponse: { orderId: 23 },
    dropClientOrderQueries: true,
    orderHistory: [{
      symbol: "DOGE-USDT", orderId: "23",
      clientOrderId: args.clientOrderId, type: "MARKET", status: "FILLED",
    }],
  });
  await assert.rejects(
    numericResponse.api.closeVstAutomatedFullSplitPosition({
      ...args, intentCreatedAt: 1700000000000,
    }), /non-lossless order ID/,
  );

  const uncertain = fixture({ ...base, failMarketPostAfterApply: true });
  await assert.rejects(
    uncertain.api.closeVstAutomatedFullSplitPosition(args), /request failed/,
  );
  await assert.rejects(
    uncertain.api.closeVstAutomatedFullSplitPosition(args), /already submitted/,
  );
  assert.equal(uncertain.calls.filter(({ options, url }) =>
    options.method === "POST" && url.searchParams.get("type") === "MARKET").length, 1);
  assert.equal(uncertain.calls.some(({ options }) => options.method === "DELETE"), false);

  const missingFees = fixture({
    ...base,
    marketFillRows: [{
      symbol: "DOGE-USDT", orderId: "market-close", tradeId: "fee-less-full-close",
      side: "SELL", positionSide: "LONG", qty: "10", price: "100",
    }],
  });
  await assert.rejects(
    missingFees.api.closeVstAutomatedFullSplitPosition(args), /fees are incomplete/,
  );
  assert.equal(missingFees.calls.some(({ options }) => options.method === "DELETE"), false);
  assert.deepEqual(missingFees.state.orders.map((row) => row.orderId).sort(),
    [core.orderId, runner.orderId]);

  const foreignBeforeClose = fixture({
    ...base,
    orders: [...base.orders, {
      symbol: "DOGE-USDT", orderId: "untracked-before-close",
      type: "LIMIT", status: "NEW",
    }],
  });
  await assert.rejects(
    foreignBeforeClose.api.closeVstAutomatedFullSplitPosition(args),
    /exact 80\/20 active stops/,
  );
  assert.equal(foreignBeforeClose.calls.some(({ options, url }) =>
    options.method === "POST" && url.searchParams.get("type") === "MARKET"), false);

  const mainnet = fixture({ ...base, environment: "mainnet" });
  await assert.rejects(
    mainnet.api.closeVstAutomatedFullSplitPosition(args), /VST automated LONG policy/,
  );
  assert.equal(mainnet.calls.length, 0);
});

test("pre-runner VST abort closes with original full and same-trigger core stops only", async () => {
  const originalStop = {
    symbol: "DOGE-USDT", orderId: "original-signal-stop",
    type: "STOP_MARKET", status: "NEW", side: "SELL", positionSide: "LONG",
    positionId: "doge-position", origQty: "10", stopPrice: "98",
    workingType: "MARK_PRICE",
  };
  const coreStop = {
    symbol: "DOGE-USDT", orderId: "core-80-stop",
    type: "STOP_MARKET", status: "NEW", side: "SELL", positionSide: "LONG",
    positionId: "doge-position", origQty: "8", stopPrice: "98",
    workingType: "MARK_PRICE",
  };
  const base = {
    symbol: "DOGE-USDT", dualSidePosition: true, marginType: "ISOLATED",
    longLeverage: 10, shortLeverage: 4,
    positions: [{
      symbol: "DOGE-USDT", positionSide: "LONG", positionAmt: "10",
      positionId: "doge-position",
    }],
    orders: [originalStop, coreStop],
    simulateMarketClose: true,
  };
  const args = {
    symbol: "DOGEUSDT", policy: VST_AUTOMATED_LONG_POLICY,
    positionId: "doge-position", totalQuantity: "10",
    originalStop: {
      orderId: originalStop.orderId, quantity: "10", stopPrice: "98",
    },
    coreStop: {
      orderId: coreStop.orderId, quantity: "8", stopPrice: "98",
    },
    clientOrderId: "vsa-doge-pre-runner-close",
    closeIntentId: "persisted-pre-runner-close-1",
  };

  const lingering = fixture(base);
  const result = await lingering.api.closeVstAutomatedPreRunnerSplit(args);
  assert.equal(result.verified, true);
  assert.equal(result.flat, true);
  assert.equal(result.fullyCleaned, false);
  assert.equal(result.stopCleanupRequired, true);
  assert.deepEqual(result.remainingKnownStopOrderIds,
    [originalStop.orderId, coreStop.orderId]);
  assert.equal(result.fees.length, 1);
  assert.equal(result.fees[0].amount, "0.01");
  assert.equal(lingering.state.positions[0].positionAmt, "0");
  assert.deepEqual(lingering.state.orders.map((row) => row.orderId).sort(),
    [originalStop.orderId, coreStop.orderId].sort());
  assert.equal(lingering.calls.filter(({ options }) => options.method === "DELETE").length, 0);
  const market = lingering.calls.find(({ options, url }) =>
    options.method === "POST" && url.searchParams.get("type") === "MARKET");
  assert.equal(market.url.searchParams.get("quantity"), "10");
  assert.equal(market.url.searchParams.get("positionSide"), "LONG");
  assert.equal(market.url.searchParams.has("reduceOnly"), false);
  assert.equal(market.url.searchParams.get("clientOrderId"), args.clientOrderId);

  const providerAbsent = fixture({
    ...base,
    responseSequences: {
      [orderPath]: [{ code: 109421, msg: "order not exist", data: {} }],
    },
  });
  const providerAbsentResult =
    await providerAbsent.api.closeVstAutomatedPreRunnerSplit(args);
  assert.equal(providerAbsentResult.verified, true);
  assert.equal(providerAbsentResult.flat, true);
  assert.equal(providerAbsent.state.positions[0].positionAmt, "0");
  const firstClientOrderLookup = providerAbsent.calls.find(({ options, url }) =>
    options.method === "GET" && url.pathname === orderPath &&
    url.searchParams.has("clientOrderId"));
  assert.equal(firstClientOrderLookup.url.searchParams.get("clientOrderId"),
    args.clientOrderId);
  assert.equal(providerAbsent.calls.indexOf(firstClientOrderLookup) <
    providerAbsent.calls.findIndex(({ options, url }) =>
      options.method === "POST" && url.searchParams.get("type") === "MARKET"), true);
  assert.equal(providerAbsent.calls.filter(({ options, url }) =>
    options.method === "POST" && url.searchParams.get("type") === "MARKET").length, 1);
  assert.equal(providerAbsent.calls.filter(({ options }) =>
    options.method === "DELETE").length, 0);

  const unexpectedClientLookup = fixture({
    ...base,
    responseSequences: {
      [orderPath]: [{ code: 109422, msg: "order not exist", data: {} }],
    },
  });
  await assert.rejects(
    unexpectedClientLookup.api.closeVstAutomatedPreRunnerSplit(args),
    (error) => {
      assert.match(error.message, /code 109422/);
      assert.deepEqual(error.mutationProvenance, {
        operation: "close_pre_runner_split",
        boundary: "before_transport",
        noMutationSubmitted: true,
      });
      return true;
    },
  );
  assert.equal(unexpectedClientLookup.calls.filter(({ options, url }) =>
    options.method === "POST" && url.searchParams.get("type") === "MARKET").length, 0);
  assert.equal(unexpectedClientLookup.calls.some(({ options }) =>
    options.method === "DELETE"), false);

  const initialPreflightReadFailure = fixture({
    ...base,
    failReads: [{
      path: "/openApi/swap/v1/positionSide/dual",
      occurrence: 1,
    }],
  });
  await assert.rejects(
    initialPreflightReadFailure.api.closeVstAutomatedPreRunnerSplit(args),
    (error) => {
      assert.deepEqual(error.mutationProvenance, {
        operation: "close_pre_runner_split",
        boundary: "before_transport",
        noMutationSubmitted: true,
      });
      return true;
    },
  );
  assert.equal(initialPreflightReadFailure.calls.some(({ options }) =>
    options.method === "POST" || options.method === "DELETE"), false);
  const retriedAfterReadFailure =
    await initialPreflightReadFailure.api.closeVstAutomatedPreRunnerSplit(args);
  assert.equal(retriedAfterReadFailure.verified, true);
  assert.equal(initialPreflightReadFailure.calls.filter(({ options, url }) =>
    options.method === "POST" && url.searchParams.get("type") === "MARKET").length, 1);

  const beforeSignReadFailure = fixture({
    ...base,
    failReads: [{
      path: "/openApi/swap/v1/positionSide/dual",
      occurrence: 2,
    }],
  });
  await assert.rejects(
    beforeSignReadFailure.api.closeVstAutomatedPreRunnerSplit(args),
    (error) => {
      assert.deepEqual(error.mutationProvenance, {
        operation: "close_pre_runner_split",
        boundary: "before_transport",
        noMutationSubmitted: true,
      });
      return true;
    },
  );
  assert.equal(beforeSignReadFailure.calls.some(({ options }) =>
    options.method === "POST" || options.method === "DELETE"), false);
  const retriedAfterBeforeSignReadFailure =
    await beforeSignReadFailure.api.closeVstAutomatedPreRunnerSplit(args);
  assert.equal(retriedAfterBeforeSignReadFailure.verified, true);
  assert.equal(beforeSignReadFailure.calls.filter(({ options, url }) =>
    options.method === "POST" && url.searchParams.get("type") === "MARKET").length, 1);

  const timestampLookupFailure = fixture({
    ...base,
    responseSequences: {
      [orderPath]: Array.from({ length: 3 }, () => ({
        code: 109400, msg: "timestamp is invalid", data: {},
      })),
    },
  });
  await assert.rejects(
    timestampLookupFailure.api.closeVstAutomatedPreRunnerSplit(args),
    (error) => {
      assert.match(error.message, /timestamp is invalid/);
      assert.deepEqual(error.mutationProvenance, {
        operation: "close_pre_runner_split",
        boundary: "before_transport",
        noMutationSubmitted: true,
      });
      return true;
    },
  );
  assert.equal(timestampLookupFailure.calls.filter(({ options, url }) =>
    options.method === "POST" && url.searchParams.get("type") === "MARKET").length, 0);
  assert.equal(timestampLookupFailure.calls.some(({ options }) =>
    options.method === "DELETE"), false);

  const exactIdMissing = fixture({
    ...base,
    responseSequences: {
      [orderPath]: [{ code: 109421, msg: "order not exist", data: {} }],
    },
  });
  await assert.rejects(
    exactIdMissing.api.queryOrder("DOGEUSDT", { orderId: "missing-market-order" }),
    /code 109421/,
  );
  assert.equal(exactIdMissing.calls.some(({ options }) => options.method !== "GET"), false);

  const ambiguous = fixture({ ...base, failMarketPostAfterApply: true });
  await assert.rejects(
    ambiguous.api.closeVstAutomatedPreRunnerSplit(args),
    (error) => {
      assert.match(error.message, /request failed/);
      assert.deepEqual(error.mutationProvenance, {
        operation: "close_pre_runner_split",
        boundary: "after_transport_started",
        mutationSubmitted: true,
      });
      return true;
    },
  );
  await assert.rejects(
    ambiguous.api.closeVstAutomatedPreRunnerSplit(args), /already submitted/,
  );
  assert.equal(ambiguous.calls.filter(({ options, url }) =>
    options.method === "POST" && url.searchParams.get("type") === "MARKET").length, 1);
  assert.equal(ambiguous.calls.filter(({ options }) => options.method === "DELETE").length, 0);
  const recoveredAfterRestart = fixture({
    ...base, identifiedOrder: ambiguous.state.identifiedOrder,
  });
  await assert.rejects(
    recoveredAfterRestart.api.closeVstAutomatedPreRunnerSplit(args),
    (error) => {
      assert.match(error.message, /already exists; reconcile/);
      assert.equal(error.mutationProvenance, undefined);
      return true;
    },
  );
  assert.equal(recoveredAfterRestart.calls.filter(({ options, url }) =>
    options.method === "POST" && url.searchParams.get("type") === "MARKET").length, 0);

  const postTransportReadFailure = fixture({
    ...base,
    failReads: [{ path: orderPath, occurrence: 3 }],
  });
  await assert.rejects(
    postTransportReadFailure.api.closeVstAutomatedPreRunnerSplit(args),
    (error) => {
      assert.deepEqual(error.mutationProvenance, {
        operation: "close_pre_runner_split",
        boundary: "after_transport_started",
        mutationSubmitted: true,
      });
      return true;
    },
  );
  assert.equal(postTransportReadFailure.calls.filter(({ options, url }) =>
    options.method === "POST" && url.searchParams.get("type") === "MARKET").length, 1);
  assert.equal(postTransportReadFailure.state.positions[0].positionAmt, "0");
  assert.equal(postTransportReadFailure.calls.filter(({ options }) =>
    options.method === "DELETE").length, 0);

  const foreign = fixture({
    ...base,
    orders: [...base.orders, {
      symbol: "DOGE-USDT", orderId: "foreign-order", type: "LIMIT", status: "NEW",
    }],
  });
  await assert.rejects(
    foreign.api.closeVstAutomatedPreRunnerSplit(args), /only the exact full signal stop/,
  );
  assert.equal(foreign.calls.filter(({ options, url }) =>
    options.method === "POST" && url.searchParams.get("type") === "MARKET").length, 0);

  const mainnet = fixture({ ...base, environment: "mainnet" });
  await assert.rejects(
    mainnet.api.closeVstAutomatedPreRunnerSplit(args), /VST automated LONG policy/,
  );
  assert.equal(mainnet.calls.length, 0);
});

test("pre-runner cleanup recovers an exact active stop only after fresh close, flatness, and entry-link proof", async () => {
  const entryOrderId = "doge-entry-market";
  const originalStop = {
    symbol: "DOGE-USDT", orderId: "original-linked-stop",
    parentOrderId: entryOrderId,
    type: "STOP_MARKET", status: "NEW", side: "SELL", positionSide: "LONG",
    positionId: "doge-linked-position", origQty: "10", stopPrice: "98",
    workingType: "MARK_PRICE",
  };
  const coreStop = {
    symbol: "DOGE-USDT", orderId: "core-linked-stop",
    parentOrderId: entryOrderId,
    type: "STOP_MARKET", status: "NEW", side: "SELL", positionSide: "LONG",
    positionId: "doge-linked-position", origQty: "8", stopPrice: "98",
    workingType: "MARK_PRICE",
  };
  const entryOrder = {
    symbol: "DOGE-USDT", orderId: entryOrderId, type: "MARKET",
    status: "FILLED", side: "BUY", positionSide: "LONG",
    origQty: "10", executedQty: "10",
  };
  const base = {
    symbol: "DOGE-USDT",
    positions: [{
      symbol: "DOGE-USDT", positionSide: "LONG", positionAmt: "10",
      positionId: "doge-linked-position",
    }],
    orders: [originalStop, coreStop],
    ordersById: { [entryOrderId]: entryOrder },
    dualSidePosition: true, marginType: "ISOLATED",
    longLeverage: 10, shortLeverage: 4,
    simulateMarketClose: true,
  };
  const closeArgs = {
    symbol: "DOGEUSDT", policy: VST_AUTOMATED_LONG_POLICY,
    positionId: "doge-linked-position", totalQuantity: "10",
    originalStop: {
      orderId: originalStop.orderId, quantity: "10", stopPrice: "98",
    },
    coreStop: {
      orderId: coreStop.orderId, quantity: "8", stopPrice: "98",
    },
    clientOrderId: "doge-pre-runner-flat-close",
    closeIntentId: "persisted-pre-runner-flat-close",
  };
  const numericMissingResponses = (overrides = {}) => ({
    ...base,
    ...overrides,
    responseOverrides: [
      {
        path: orderPath, method: "GET", orderId: originalStop.orderId,
        response: { code: 109421, msg: "order not exist", data: {} },
      },
      ...(overrides.responseOverrides ?? []),
    ],
  });

  const activeMissing = fixture(numericMissingResponses());
  const result = await activeMissing.api.closeVstAutomatedPreRunnerSplit(closeArgs);
  assert.equal(result.verified, true);
  assert.equal(result.flat, true);
  assert.deepEqual(result.remainingKnownStopOrderIds.sort(),
    [originalStop.orderId, coreStop.orderId].sort());
  const marketIndex = activeMissing.calls.findIndex(({ url, options }) =>
    url.pathname === orderPath && options.method === "POST" &&
    url.searchParams.get("type") === "MARKET");
  const numericOriginalStopReadIndex = activeMissing.calls.findIndex(({ url, options }) =>
    url.pathname === orderPath && options.method === "GET" &&
    url.searchParams.get("orderId") === originalStop.orderId);
  assert.ok(marketIndex >= 0 && numericOriginalStopReadIndex > marketIndex,
    "exercise numeric stop lookup only after the close order is fully submitted");
  assert.equal(activeMissing.calls.some(({ options }) => options.method === "DELETE"), false);

  const firstDeleteArgs = {
    symbol: "DOGEUSDT", policy: VST_AUTOMATED_LONG_POLICY,
    positionId: closeArgs.positionId,
    stopToCancel: {
      orderId: originalStop.orderId, quantity: "10", stopPrice: "98",
    },
    knownRemainingStopOrderIds: result.remainingKnownStopOrderIds,
    cancellationIntentId: "cleanup-linked-original",
    entryOrderId,
  };
  const closeFillIndex = activeMissing.calls.findIndex(({ url, options }) =>
    url.pathname === "/openApi/swap/v2/trade/allFillOrders" &&
    options.method === "GET" &&
    url.searchParams.get("orderId") === result.closeOrderId);
  const cancellation = await activeMissing.api.cancelVstAutomatedKnownStopWhenFlat(
    firstDeleteArgs,
  );
  assert.equal(cancellation.verified, true);
  assert.equal(cancellation.flat, true);
  const deleteIndex = activeMissing.calls.findIndex(({ url, options }) =>
    url.pathname === orderPath && options.method === "DELETE");
  assert.ok(closeFillIndex >= 0 && deleteIndex > closeFillIndex,
    "verify the complete close fill before canceling a linked active stop");
  assert.equal(activeMissing.calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "DELETE" &&
    url.searchParams.get("orderId") === originalStop.orderId).length, 1);

  for (const [label, overrides] of [
    ["entry links disagree", {
      orders: [originalStop, { ...coreStop, parentOrderId: "different-entry-parent" }],
    }],
    ["entry link is missing", {
      orders: [
        originalStop,
        Object.fromEntries(Object.entries(coreStop).filter(([key]) => key !== "parentOrderId")),
      ],
    }],
  ]) {
    const conflicting = fixture(numericMissingResponses(overrides));
    await assert.rejects(
      conflicting.api.closeVstAutomatedPreRunnerSplit(closeArgs),
      /one consistent linked entry parent/,
      label,
    );
    assert.equal(conflicting.calls.some(({ options }) => options.method === "DELETE"), false);
  }

  const missingFromOpenOrders = fixture(numericMissingResponses({
    autoCancelStopsOnMarket: true,
    responseOverrides: [{
      path: orderPath, method: "GET", orderId: coreStop.orderId,
      response: { code: 109421, msg: "order not exist", data: {} },
    }],
  }));
  await assert.rejects(
    missingFromOpenOrders.api.closeVstAutomatedPreRunnerSplit(closeArgs),
    /cannot corroborate the filled close and exact flat owned stops/,
  );
  assert.equal(missingFromOpenOrders.calls.some(({ options }) =>
    options.method === "DELETE"), false);

  const freshForeignOrder = fixture(numericMissingResponses({
    responseSequences: {
      "/openApi/swap/v2/trade/openOrders": [
        {}, {}, {}, {},
        { data: [...base.orders, {
          symbol: "DOGE-USDT", orderId: "foreign-after-close",
          type: "LIMIT", status: "NEW",
        }] },
      ],
    },
  }));
  await assert.rejects(
    freshForeignOrder.api.closeVstAutomatedPreRunnerSplit(closeArgs),
    /cannot corroborate the filled close and exact flat owned stops/,
  );
  assert.equal(freshForeignOrder.calls.some(({ options }) => options.method === "DELETE"), false);

  const incompleteCloseFills = fixture({
    ...base,
    marketFillRows: [{
      symbol: "DOGE-USDT", orderId: "market-close",
      tradeId: "incomplete-close-fill", side: "SELL",
      positionSide: "LONG", qty: "9", price: "100",
      commission: "0.01", commissionAsset: "VST",
    }],
  });
  await assert.rejects(
    incompleteCloseFills.api.closeVstAutomatedPreRunnerSplit(closeArgs),
    /fill quantities or independently reported fees are incomplete/,
  );
  assert.equal(incompleteCloseFills.calls.some(({ options }) => options.method === "DELETE"), false);

  const differentNumericError = fixture({
    ...base,
    responseOverrides: [{
      path: orderPath, method: "GET", orderId: originalStop.orderId,
      response: { code: 109422, msg: "order not exist", data: {} },
    }],
  });
  await assert.rejects(
    differentNumericError.api.closeVstAutomatedPreRunnerSplit(closeArgs),
    /code 109422/,
  );
  assert.equal(differentNumericError.calls.some(({ options }) => options.method === "DELETE"), false);

  const newPosition = fixture(numericMissingResponses({
    responseSequences: {
      "/openApi/swap/v2/user/positions": [
        {}, {}, {}, {},
        { data: [{
          symbol: "DOGE-USDT", positionSide: "LONG",
          positionAmt: "1", positionId: "new-doge-position",
        }] },
      ],
    },
  }));
  await assert.rejects(
    newPosition.api.closeVstAutomatedPreRunnerSplit(closeArgs),
    /verified flat/,
  );
  assert.equal(newPosition.calls.some(({ options }) => options.method === "DELETE"), false);

  const postCancelReadFailure = fixture(numericMissingResponses({
    failReads: [{
      path: "/openApi/swap/v2/user/positions",
      occurrence: 9,
    }],
  }));
  const cleanupEvidence = await postCancelReadFailure.api.closeVstAutomatedPreRunnerSplit(
    closeArgs,
  );
  await assert.rejects(
    postCancelReadFailure.api.cancelVstAutomatedKnownStopWhenFlat({
      ...firstDeleteArgs,
      knownRemainingStopOrderIds: cleanupEvidence.remainingKnownStopOrderIds,
      cancellationIntentId: "cleanup-post-cancel-read-failure",
    }),
    /request failed/,
  );
  assert.equal(postCancelReadFailure.calls.filter(({ url, options }) =>
    url.pathname === orderPath && options.method === "DELETE").length, 1);
  await assert.rejects(
    postCancelReadFailure.api.cancelVstAutomatedKnownStopWhenFlat({
      ...firstDeleteArgs,
      knownRemainingStopOrderIds: cleanupEvidence.remainingKnownStopOrderIds,
      cancellationIntentId: "cleanup-post-cancel-read-failure",
    }),
    /already submitted/,
  );
});

test("known flat-stop cancellation requires persisted identity proof and never repeats uncertain DELETE", async () => {
  const core = {
    symbol: "DOGE-USDT", orderId: "known-core-stop", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "doge-position",
    origQty: "8", stopPrice: "98", workingType: "MARK_PRICE",
  };
  const runner = {
    symbol: "DOGE-USDT", orderId: "known-runner-stop", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "doge-position",
    origQty: "2", stopPrice: "100", workingType: "MARK_PRICE",
  };
  const flat = [{
    symbol: "DOGE-USDT", positionSide: "LONG", positionAmt: "0",
    positionId: "doge-position",
  }];
  const args = {
    symbol: "DOGEUSDT", policy: VST_AUTOMATED_LONG_POLICY,
    positionId: "doge-position",
    stopToCancel: {
      tranche: "core", orderId: core.orderId, quantity: "8", stopPrice: "98",
    },
    knownRemainingStopOrderIds: [core.orderId, runner.orderId],
    cancellationIntentId: "persisted-flat-cleanup-1",
  };
  const recoveredAfterRestart = fixture({
    symbol: "DOGE-USDT", dualSidePosition: true, longLeverage: 10, shortLeverage: 4,
    positions: flat, orders: [core, runner],
  });
  const result = await recoveredAfterRestart.api.cancelVstAutomatedKnownStopWhenFlat(args);
  assert.equal(result.verified, true);
  assert.deepEqual(result.remainingKnownStopOrderIds, [runner.orderId]);
  const deleted = recoveredAfterRestart.calls.find(({ options }) => options.method === "DELETE");
  assert.equal(deleted.url.searchParams.get("orderId"), core.orderId);

  const unknown = fixture({
    symbol: "DOGE-USDT", dualSidePosition: true, longLeverage: 10, shortLeverage: 4,
    positions: flat, orders: [core],
  });
  await assert.rejects(
    unknown.api.cancelVstAutomatedKnownStopWhenFlat({
      ...args, knownRemainingStopOrderIds: ["not-a-known-exchange-stop"],
    }), /exact persisted target\/known IDs/,
  );
  assert.equal(unknown.calls.some(({ options }) => options.method === "DELETE"), false);

  const foreign = fixture({
    symbol: "DOGE-USDT", dualSidePosition: true, longLeverage: 10, shortLeverage: 4,
    positions: flat,
    orders: [core, {
      symbol: "DOGE-USDT", orderId: "untracked-foreign", type: "LIMIT", status: "NEW",
    }],
  });
  await assert.rejects(
    foreign.api.cancelVstAutomatedKnownStopWhenFlat(args), /foreign orders/,
  );
  assert.equal(foreign.calls.some(({ options }) => options.method === "DELETE"), false);

  const ambiguousDelete = fixture({
    symbol: "DOGE-USDT", dualSidePosition: true, longLeverage: 10, shortLeverage: 4,
    positions: flat, orders: [core, runner], failDeleteAfterApply: true,
  });
  await assert.rejects(
    ambiguousDelete.api.cancelVstAutomatedKnownStopWhenFlat(args), /request failed/,
  );
  await assert.rejects(
    ambiguousDelete.api.cancelVstAutomatedKnownStopWhenFlat(args), /already submitted/,
  );
  assert.equal(ambiguousDelete.calls.filter(({ options }) =>
    options.method === "DELETE").length, 1);

  const mainnet = fixture({
    ...{
      symbol: "DOGE-USDT", dualSidePosition: true, longLeverage: 10, shortLeverage: 4,
      positions: flat, orders: [core],
    },
    environment: "mainnet",
  });
  await assert.rejects(
    mainnet.api.cancelVstAutomatedKnownStopWhenFlat(args), /VST automated LONG policy/,
  );
  assert.equal(mainnet.calls.length, 0);
});