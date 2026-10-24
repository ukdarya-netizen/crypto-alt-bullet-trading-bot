import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createBingXLiveApi, createBingXOutboundPacer } from "../../bingx-live-api.mjs";

export const EPOCH = Date.parse("2026-10-24T00:00:00Z");
export const ORDER = "/openApi/swap/v2/trade/order";
export const BALANCE = "/openApi/swap/v3/user/balance";

// No wall-clock sleeps, environment credentials, sockets or runtime imports.
// Advance only after all runnable promise continuations have settled, so a
// selected caller really starts transport before the next simulated slot.
export function mixedLoadHarness({ ambiguous = [], staleQuote = false } = {}) {
  let now = EPOCH;
  const timers = [];
  const context = new AsyncLocalStorage();
  const requests = [];
  const reservations = [];
  const cooldowns = [];
  const contractFailures = [];
  const positions = ["BTC-USDT", "ETH-USDT"].map((symbol, i) => ({
    symbol, positionId: String(100 + i), positionSide: "LONG",
    positionAmt: "1", avgPrice: "100", initialMargin: "10",
    liquidationPrice: "80", leverage: 10, marginType: "ISOLATED",
  }));
  const orders = positions.map((position, i) => ({
    symbol: position.symbol, positionId: position.positionId,
    orderId: String(200 + i), status: "NEW", type: "STOP_MARKET",
    side: "SELL", positionSide: "LONG", origQty: "1", executedQty: "0",
    stopPrice: "95", workingType: "MARK_PRICE", closePosition: "false",
  }));
  const historicalOrder = {
    symbol: "XRP-USDT", orderId: "90071992547409931234", positionID: "998",
    status: "FILLED", type: "MARKET", side: "BUY", positionSide: "LONG",
    origQty: "1", executedQty: "1", avgPrice: "100",
    time: EPOCH - 61000, updateTime: EPOCH - 60000,
  };
  orders.push(historicalOrder);
  const archivedFill = {
    symbol: historicalOrder.symbol, orderId: historicalOrder.orderId,
    tradeId: "90071992547409931235", side: "BUY", positionSide: "LONG",
    filledTime: new Date(EPOCH - 60000).toISOString(), qty: "1", price: "100",
    commission: "-0.01", currency: "USDT", commissionAsset: "VST",
    realisedPNL: "0", clientOrderID: "",
  };
  const sleep = ms => new Promise(resolve => timers.push({ at: now + ms, resolve }));
  const pacer = createBingXOutboundPacer({ clock: () => now, sleep });
  const hooks = { onPriority: null, rateLimit: null };
  const requestPacer = {
    async waitForSlot(options = {}) {
      const row = {
        role: context.getStore(), priority: options.priority === true, queuedAt: now,
      };
      reservations.push(row);
      if (row.priority) await hooks.onPriority?.(row);
      row.selectedAt = await pacer.waitForSlot(options);
      return row.selectedAt;
    },
    deferFor(ms) {
      cooldowns.push({ at: now, until: now + ms });
      pacer.deferFor(ms);
    },
  };
  const reply = (data, status = 200, code = 0) => ({
    ok: status >= 200 && status < 300, status,
    text: async () => JSON.stringify({ code, msg: code ? "rate limited" : "", data }),
  });
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://open-api-vst.bingx.com");
    if (url.searchParams.has("signature")) {
      assert.equal(options.headers["X-BX-APIKEY"], "local-test-key");
      assert.equal(Number(url.searchParams.get("timestamp")), now,
        "signature timestamp must be acquired at transport, not while queued");
    }
    const role = context.getStore();
    const symbol = url.searchParams.get("symbol");
    requests.push({ role, at: now, path: url.pathname, method: options.method,
      symbol, params: Object.fromEntries(url.searchParams) });
    if (await hooks.rateLimit?.({ role, url, options })) return reply(null, 429, 100410);
    let data;
    switch (url.pathname) {
      case BALANCE:
        data = [{ asset: "VST", balance: "1000", availableMargin: "1000" }];
        break;
      case "/openApi/swap/v1/positionSide/dual":
        data = { dualSidePosition: true };
        break;
      case "/openApi/swap/v2/user/positions":
        data = positions.filter(row => !symbol || row.symbol === symbol);
        break;
      case "/openApi/swap/v2/trade/openOrders":
        data = orders.filter(row => row.status === "NEW" && (!symbol || row.symbol === symbol));
        break;
      case "/openApi/swap/v2/trade/allOrders":
        data = [];
        break;
      case "/openApi/swap/v2/trade/allFillOrders":
        data = [];
        break;
      case "/openApi/swap/v2/trade/marginType":
        assert.equal(options.method, "GET");
        data = { marginType: "ISOLATED" };
        break;
      case "/openApi/swap/v2/trade/leverage":
        data = { symbol, longLeverage: 10, shortLeverage: 75,
          maxPositionLongVal: "1000000" };
        break;
      case "/openApi/swap/v2/quote/contracts":
        data = ["BTC-USDT", "ETH-USDT", "DOGE-USDT", "SOL-USDT", "XRP-USDT"].map(name => ({
          symbol: name, status: 1, currency: "USDT", apiStateOpen: "true",
          quantityPrecision: 4, pricePrecision: 1, tradeMinQuantity: "0.001",
          tradeMinUSDT: "5", maxLongLeverage: "10", maxShortLeverage: "75",
        }));
        break;
      case "/openApi/swap/v1/maintMarginRatio":
        data = [{ symbol, maxPosition: "100000", maintMarginRatio: "0.005" }];
        break;
      case "/openApi/swap/v2/user/commissionRate":
        data = { makerCommissionRate: "0.0002", takerCommissionRate: "0.0005" };
        break;
      case "/openApi/swap/v2/quote/premiumIndex":
        data = { symbol, markPrice: "100", lastFundingRate: "0.0001", time: now };
        break;
      case "/openApi/swap/v2/quote/ticker":
      case "/openApi/swap/v2/quote/bookTicker":
        data = { symbol, askPrice: "100", bidPrice: "99.9",
          time: staleQuote ? now - 10001 : now };
        break;
      case "/openApi/swap/v2/trade/fillHistory":
        data = {
          fill_history_orders: url.searchParams.get("pageIndex") === "1" ? [archivedFill] : [],
          total: url.searchParams.get("pageIndex") === "1" ? 1 : 0,
        };
        break;
      case ORDER:
        if (options.method === "GET") {
          data = orders.find(row => row.orderId === url.searchParams.get("orderId") ||
            row.clientOrderId && row.clientOrderId === url.searchParams.get("clientOrderId"));
          data ??= null;
          break;
        }
        if (options.method === "DELETE") {
          const stop = orders.find(row => row.orderId === url.searchParams.get("orderId"));
          assert.ok(stop, "only an existing stop may be cancelled");
          stop.status = "CANCELED";
          data = { orderId: stop.orderId };
          break;
        }
        assert.equal(options.method, "POST", "unexpected mutation");
        if (url.searchParams.get("type") === "STOP_MARKET") {
          data = { orderId: "300" };
          orders.push({
            ...orders.find(row => row.symbol === symbol),
            ...data, stopPrice: url.searchParams.get("stopPrice"),
          });
        } else {
          data = { orderId: `market-${symbol}` };
          if (url.searchParams.get("side") === "SELL") {
            positions.find(row => row.symbol === symbol).positionAmt = "0";
          }
          orders.push({ ...data, symbol, status: "FILLED", type: "MARKET",
            side: url.searchParams.get("side"),
            clientOrderId: url.searchParams.get("clientOrderId") });
        }
        if (ambiguous.includes(role)) throw new Error("local exchange applied POST; response lost");
        break;
      default:
        assert.fail(`unhandled local exchange endpoint ${url.pathname}`);
    }
    // Snapshot at acquisition, never hand mutable fake venue state to a client.
    return reply(structuredClone(data));
  };
  const guardedFetch = async (...args) => {
    try { return await fetchImpl(...args); }
    catch (error) {
      // Native retries intentionally wrap transport errors. A missing fake
      // endpoint must never turn into a passing negative/fail-closed test.
      if (error instanceof assert.AssertionError) contractFailures.push(error);
      throw error;
    }
  };
  const apis = new Map();
  function api(role) {
    if (!apis.has(role)) apis.set(role, createBingXLiveApi({
      environment: "vst", fetchImpl: guardedFetch, clock: () => now, sleep, requestPacer,
      random: () => 0,
      credentials: () => ({ key: "local-test-key", secret: "local-test-secret" }),
      writePermission: () => true,
    }));
    return apis.get(role);
  }
  const run = (role, fn) => context.run(role, () => fn(api(role)));
  async function drain(promise) {
    let settled = false;
    const result = Promise.resolve(promise).finally(() => { settled = true; });
    // Attach immediately: expected rejected operations must not become
    // unhandled rejections while the controlled clock is being driven.
    result.catch(() => {});
    for (let step = 0; !settled && step < 10000; step++) {
      await new Promise(resolve => setImmediate(resolve));
      if (settled) break;
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift();
      assert.ok(next, "unfinished mixed workload must have a scheduled wakeup");
      now = Math.max(now, next.at);
      next.resolve();
    }
    assert.ok(settled, "mixed workload has a finite request/time bound");
    if (contractFailures.length) throw contractFailures[0];
    return result;
  }
  return {
    api, run, drain, requests, reservations, cooldowns, hooks, positions, orders,
    restartClient: role => apis.delete(role),
    clock: () => now,
  };
}

export const entry = (api, overrides = {}) => api.placeVstAutomatedLong({
  symbol: "DOGEUSDT", quantity: "1", maxPrice: "100.0", stopLoss: "98.0",
  clientOrderId: "mixed-entry", signalAt: new Date(EPOCH).toISOString(),
  ...overrides,
});

export const raiseStop = api => api.upgradeVstLongStop({
  symbol: "BTCUSDT", quantity: "1", positionId: "100",
  previousStopOrderId: "200", previousStopPrice: "95", stopPrice: "98",
});

export const close = (api, sourcePosition = {}) => api.closeLong(
  "ETHUSDT", "1", "mixed-close", "101", {
    automatedLongPolicy: "vst-automated-long-1pct",
    sourceExitRequest: {
      sourceExitRequestId: "local-source-exit", sourceSignalId: "source-closed",
      symbol: "ETHUSDT", reason: "source_closed", entryOrderId: "entry-ETH",
      ownedStops: [{
        orderId: "201", positionId: "101", quantity: "1", stopPrice: "95",
      }],
      sourceExit: {
        stage: "close", requestId: "local-source-exit",
        evidence: {
          sourceSignalId: "source-closed", symbol: "ETHUSDT", reason: "source_closed",
          asOf: new Date(EPOCH).toISOString(), observedAt: new Date(EPOCH).toISOString(),
          sourceStatus: sourcePosition.sourceStatus ?? "profit",
          sourceUpdatedAt: sourcePosition.sourceUpdatedAt ?? new Date(EPOCH).toISOString(),
          sourceClosedAt: sourcePosition.sourceClosedAt ?? new Date(EPOCH).toISOString(),
          sourceExitPrice: sourcePosition.sourceExitPrice ?? 105,
          sourceCancelReason: null, exitDecisionAt: null,
        },
      },
    },
  },
);

export function assertSharedBudget(f) {
  for (let i = 1; i < f.requests.length; i++) {
    assert.ok(f.requests[i].at - f.requests[i - 1].at >= 1100,
      `shared request gap: ${JSON.stringify(f.requests.slice(i - 1, i + 1))}`);
  }
  for (const cooldown of f.cooldowns) {
    assert.equal(f.requests.some(row => row.at > cooldown.at && row.at < cooldown.until),
      false, "no role may bypass the exchange cooldown");
  }
}
