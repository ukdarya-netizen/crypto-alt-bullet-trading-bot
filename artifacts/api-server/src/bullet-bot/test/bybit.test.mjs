import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  BybitApiError,
  UnknownOrderOutcomeError,
  createBybit,
} from "../bybit.mjs";

const instrumentRow = {
  symbol: "WAXPUSDT",
  status: "Trading",
  contractType: "LinearPerpetual",
  baseCoin: "WAXP",
  quoteCoin: "USDT",
  settleCoin: "USDT",
  lotSizeFilter: {
    minOrderQty: "1",
    maxMktOrderQty: "1000000",
    qtyStep: "1",
    minNotionalValue: "5",
  },
  priceFilter: { tickSize: "0.000001" },
};

function envelope(result, retCode = 0, retMsg = "OK") {
  return { retCode, retMsg, result, time: 1_700_000_000_000 };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function createFetch(routes = {}) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    const record = { url: parsed, options };
    requests.push(record);
    const route = routes[`${options.method} ${parsed.pathname}`];
    if (!route) {
      throw new Error(`Unexpected mock request ${options.method} ${parsed.pathname}`);
    }
    return typeof route === "function" ? route(record) : jsonResponse(route);
  };
  return { fetchImpl, requests };
}

function makeClient(routes, credentials = true) {
  const mock = createFetch(routes);
  const client = createBybit({
    apiKey: credentials ? "test-key" : undefined,
    apiSecret: credentials ? "test-secret" : undefined,
    baseUrl: "https://api-testnet.bybit.com",
    fetchImpl: mock.fetchImpl,
    clock: () => 1_700_000_000_000,
  });
  return { client, ...mock };
}

function signal(overrides = {}) {
  return {
    sourceSignalId: "cab-signal-777",
    confirmationStatus: "confirmed",
    patternId: "balanced_grind",
    patternStatus: "approved",
    symbol: "WAXPUSDT",
    signalAt: "2026-09-25T10:00:00.000Z",
    referencePrice: "0.006000",
    side: "buy",
    orderType: "market",
    quantity: "1000",
    limitPrice: "0.006000",
    stopLoss: "0.005400",
    reduceOnly: false,
    payload: {
      source: "CryptoAltBullet",
      rulesVersion: "bullet-long-exits-v2",
      marginMode: "isolated",
      initialMarginUsd: "10",
      leverage: 10,
      exitRules: { noFixedTakeProfit: true },
    },
    ...overrides,
  };
}

const instrumentResponse = envelope({ list: [instrumentRow] });

test("uses the public ticker and normalizes a live Bybit quote", async () => {
  const { client, requests } = makeClient({
    "GET /v5/market/tickers": envelope({
      list: [
        {
          symbol: "WAXPUSDT",
          lastPrice: "0.006123",
          markPrice: "0.006121",
          bid1Price: "0.006120",
          ask1Price: "0.006124",
          ts: "1700000000000",
        },
      ],
    }),
  });

  assert.deepEqual(await client.ticker("WAXPUSDT"), {
    symbol: "WAXPUSDT",
    lastPrice: "0.006123",
    markPrice: "0.006121",
    bid1Price: "0.006120",
    ask1Price: "0.006124",
    updatedAt: "1700000000000",
  });
  assert.equal(requests[0].options.headers["X-BAPI-API-KEY"], undefined);
  assert.equal(requests[0].url.searchParams.get("category"), "linear");
});

test("rejects an inactive or non-USDT/non-linear instrument", async () => {
  const { client } = makeClient({
    "GET /v5/market/instruments-info": envelope({
      list: [{ ...instrumentRow, contractType: "LinearFutures" }],
    }),
  });
  await assert.rejects(
    client.instrument("WAXPUSDT"),
    /not an active USDT-settled linear perpetual/,
  );
});

test("signed requests use V5 timestamp, receive window and HMAC signature", async () => {
  const { client, requests } = makeClient({
    "GET /v5/position/list": envelope({ list: [] }),
  });
  assert.deepEqual(await client.getPosition("WAXPUSDT"), []);

  const { options, url } = requests[0];
  const headers = options.headers;
  const queryString = url.search.slice(1);
  const expected = createHmac("sha256", "test-secret")
    .update(
      `${headers["X-BAPI-TIMESTAMP"]}test-key${headers["X-BAPI-RECV-WINDOW"]}${queryString}`,
    )
    .digest("hex");
  assert.equal(headers["X-BAPI-SIGN"], expected);
  assert.equal(headers["X-BAPI-SIGN-TYPE"], "2");
  assert.equal(headers["X-BAPI-TIMESTAMP"], "1700000000000");
  assert.equal(headers["X-BAPI-RECV-WINDOW"], "5000");
});

test("normalizes the wallet balance and returns matched orders for reconciliation", async () => {
  const { client } = makeClient({
    "GET /v5/account/wallet-balance": envelope({
      list: [
        {
          accountType: "UNIFIED",
          totalEquity: "120.00",
          totalWalletBalance: "100.00",
          totalAvailableBalance: "80.00",
          coin: [
            {
              coin: "USDT",
              walletBalance: "100.00",
              equity: "120.00",
              availableToWithdraw: "80.00",
            },
          ],
        },
      ],
    }),
    "GET /v5/order/realtime": envelope({
      list: [
        {
          orderId: "exchange-order-1",
          orderLinkId: "cab-777-entry",
          symbol: "WAXPUSDT",
          side: "Buy",
          orderType: "Market",
          qty: "1000",
          leavesQty: "0",
          cumExecQty: "1000",
          avgPrice: "0.00601",
          orderStatus: "Filled",
          reduceOnly: false,
          createdTime: "1700000000000",
          updatedTime: "1700000000001",
        },
      ],
    }),
  });

  const balance = await client.walletBalance();
  assert.equal(balance.accountType, "UNIFIED");
  assert.equal(balance.totalAvailableBalance, "80.00");
  assert.equal(balance.usdt.equity, "120.00");

  const order = await client.getOrder("cab-777-entry");
  assert.equal(order.orderId, "exchange-order-1");
  assert.equal(order.cumExecQty, "1000");
  assert.equal(order.orderStatus, "Filled");
});

test("validates exact exchange quantity and stop-price increments", async () => {
  const { client } = makeClient({
    "GET /v5/market/instruments-info": instrumentResponse,
  });

  const validated = await client.validateOrder(signal());
  assert.equal(validated.instrument.qtyStep, "1");
  assert.equal(validated.instrument.tickSize, "0.000001");
  assert.equal(validated.notional, "6");

  await assert.rejects(
    client.validateOrder(signal({ quantity: "1000.5" })),
    /not an exact multiple/,
  );
  await assert.rejects(
    client.validateOrder(signal({ quantity: "500" })),
    /below Bybit minNotionalValue/,
  );
  await assert.rejects(
    client.validateOrder(signal({ stopLoss: "0.0054001" })),
    /not aligned to Bybit tickSize/,
  );
  await assert.rejects(
    client.validateOrder(signal({ payload: { marginMode: "cross" } })),
    /isolated margin, 10x leverage/,
  );
});

test("market entry configures isolated 10x first and includes full-position stopLoss", async () => {
  const { client, requests } = makeClient({
    "GET /v5/market/instruments-info": instrumentResponse,
    "POST /v5/account/set-margin-mode": envelope({}),
    "POST /v5/position/set-leverage": envelope({}),
    "POST /v5/order/create": envelope({
      orderId: "exchange-order-1",
      orderLinkId: "cab-777-entry",
      createdTime: "1700000000000",
    }),
  });

  const result = await client.openProtected(signal(), {
    orderLinkId: "cab-777-entry",
  });

  assert.equal(result.status, "accepted_not_filled");
  assert.equal(result.orderId, "exchange-order-1");
  assert.equal(requests[0].url.pathname, "/v5/market/instruments-info");
  assert.equal(requests[1].url.pathname, "/v5/account/set-margin-mode");
  assert.equal(
    JSON.parse(requests[1].options.body).setMarginMode,
    "ISOLATED_MARGIN",
  );
  assert.equal(requests[2].url.pathname, "/v5/position/set-leverage");
  const leverageBody = JSON.parse(requests[2].options.body);
  assert.equal(leverageBody.buyLeverage, "10");
  assert.equal(leverageBody.sellLeverage, "10");

  const orderRequest = requests[3];
  assert.equal(orderRequest.url.pathname, "/v5/order/create");
  const body = JSON.parse(orderRequest.options.body);
  assert.equal(body.side, "Buy");
  assert.equal(body.orderType, "Market");
  assert.equal(body.qty, "1000");
  assert.equal(body.stopLoss, "0.005400");
  assert.equal(body.tpslMode, "Full");
  assert.equal(body.slTriggerBy, "MarkPrice");
  assert.equal(body.slOrderType, "Market");
  assert.equal(body.reduceOnly, false);
  assert.equal("takeProfit" in body, false);
});

test("create-order timeout is marked as unknown and carries the reconciliation ID", async () => {
  const mock = createFetch({
    "GET /v5/market/instruments-info": instrumentResponse,
    "POST /v5/account/set-margin-mode": envelope({}),
    "POST /v5/position/set-leverage": envelope({}),
    "POST /v5/order/create": () => {
      throw new Error("socket timed out after request dispatch");
    },
  });
  const client = createBybit({
    apiKey: "test-key",
    apiSecret: "test-secret",
    fetchImpl: mock.fetchImpl,
    clock: () => 1_700_000_000_000,
  });

  await assert.rejects(
    client.openProtected(signal(), { orderLinkId: "cab-777-entry" }),
    (error) =>
      error instanceof UnknownOrderOutcomeError &&
      error.orderLinkId === "cab-777-entry",
  );
});

test("definitive exchange rejection is surfaced without converting it to unknown", async () => {
  const { client } = makeClient({
    "GET /v5/market/instruments-info": instrumentResponse,
    "POST /v5/account/set-margin-mode": envelope({}),
    "POST /v5/position/set-leverage": envelope({}),
    "POST /v5/order/create": () =>
      jsonResponse(envelope({}, 110007, "abnormal price")),
  });

  await assert.rejects(
    client.openProtected(signal(), { orderLinkId: "cab-777-entry" }),
    (error) =>
      error instanceof BybitApiError &&
      !(error instanceof UnknownOrderOutcomeError) &&
      error.retCode === 110007,
  );
});

test("already-set isolated margin mode and 10x leverage are safe idempotent responses", async () => {
  const { client } = makeClient({
    "POST /v5/account/set-margin-mode": () =>
      jsonResponse(envelope({}, 110026, "mode has not been modified")),
    "POST /v5/position/set-leverage": () =>
      jsonResponse(envelope({}, 110043, "leverage has not been modified")),
  });

  assert.equal(
    (await client.setMarginMode()).setMarginMode,
    "ISOLATED_MARGIN",
  );
  assert.equal((await client.setLeverage("WAXPUSDT", 10)).leverage, "10");
});

test("stop updates, reduce-only closes, and margin additions use dedicated endpoints", async () => {
  const { client, requests } = makeClient({
    "GET /v5/market/instruments-info": instrumentResponse,
    "POST /v5/position/trading-stop": envelope({}),
    "POST /v5/order/create": envelope({
      orderId: "exchange-close-1",
      orderLinkId: "cab-777-close",
    }),
    "POST /v5/position/add-margin": envelope({}),
  });

  await client.updateStop("WAXPUSDT", "0.005500");
  const close = await client.closeReduceOnly("WAXPUSDT", "1000", {
    orderLinkId: "cab-777-close",
  });
  await client.addMargin("WAXPUSDT", "2.50");

  assert.equal(close.status, "accepted_not_filled");
  const stopRequest = requests.find((request) =>
    request.url.pathname === "/v5/position/trading-stop"
  );
  const closeRequest = requests.find(
    (request) =>
      request.url.pathname === "/v5/order/create" &&
      JSON.parse(request.options.body).reduceOnly === true,
  );
  const marginRequest = requests.find(
    (request) => request.url.pathname === "/v5/position/add-margin",
  );
  assert.equal(JSON.parse(stopRequest.options.body).stopLoss, "0.005500");
  assert.equal(JSON.parse(closeRequest.options.body).reduceOnly, true);
  assert.equal(JSON.parse(closeRequest.options.body).closeOnTrigger, true);
  assert.equal(JSON.parse(marginRequest.options.body).margin, "2.50");
});

test("private API calls fail before network access when credentials are absent", async () => {
  const { client, requests } = makeClient(
    { "GET /v5/position/list": envelope({ list: [] }) },
    false,
  );
  await assert.rejects(client.getPosition("WAXPUSDT"), /API_KEY and BYBIT_API_SECRET/);
  assert.equal(requests.length, 0);
});