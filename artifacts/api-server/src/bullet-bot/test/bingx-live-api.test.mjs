import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  createBingXLiveApi,
  createBingXOutboundPacer,
} from "../bingx-live-api.mjs";

const contract = {
  symbol: "BTC-USDT",
  status: 1,
  currency: "USDT",
  apiStateOpen: "true",
  quantityPrecision: 3,
  pricePrecision: 1,
  tradeMinQuantity: "0.001",
  tradeMinUSDT: "5",
  maxLongLeverage: 20,
  maxShortLeverage: 20,
};

function fixture({
  environment = "mainnet",
  origin,
  permission = false,
  positions = [],
  openOrders = [],
  openOrdersError = null,
  marginType = "ISOLATED",
  longLeverage = 10,
  shortLeverage = 10,
  maxPositionLongVal = "5000",
  dualSidePosition = false,
  attachedStop = true,
  invalidFills = false,
  fillData = null,
  submissionData = null,
  queryData = null,
  rawResponses = {},
  responseSequences = {},
  responseTransform,
  fetchErrors = {},
  clock = () => 1700000000000,
  sleep = async () => {},
  requestPacer,
  random = () => 0,
  onRateLimitDiagnostic,
  onTransientGetDiagnostic,
  onFetchStart,
  beforeResponse,
  riskTierData = [{ symbol: "BTC-USDT", maxPosition: "100000", maintMarginRatio: "0.005" }],
  availableMargin = "100",
  balanceAsset,
  feeData = { makerCommissionRate: "0.0002", takerCommissionRate: "0.0005" },
  contractData,
} = {}) {
  const calls = [];
  const state = { positions };
  const responseSequenceIndexes = new Map();
  const marginAsset = environment === "vst" ? "VST" : "USDT";
  const reportedBalanceAsset = balanceAsset ?? marginAsset;
  const contracts = contractData ?? [contract];
  const fetchImpl = async (raw, options) => {
    const url = new URL(raw);
    calls.push({ url, options });
    onFetchStart?.({ url, options, startedAt: Number(clock()) });
    await beforeResponse?.({ url, options });
    const responseKey = `${options.method} ${url.pathname}`;
    if (fetchErrors[responseKey]) throw fetchErrors[responseKey];
    if (url.pathname === "/openApi/swap/v2/quote/ticker" &&
        options.method === "GET") {
      const responseSequence = responseSequences[responseKey];
      if (Array.isArray(responseSequence) && responseSequence.length > 0) {
        const responseIndex = responseSequenceIndexes.get(responseKey) ?? 0;
        responseSequenceIndexes.set(responseKey, responseIndex + 1);
        const responseBody = responseSequence[Math.min(
          responseIndex, responseSequence.length - 1,
        )];
        if (responseBody instanceof Error) throw responseBody;
        return new Response(typeof responseBody === "string"
          ? responseBody : JSON.stringify(responseBody), { status: 200 });
      }
      const data = {
        symbol: "BTC-USDT", askPrice: "100", bidPrice: "99.9",
        time: Number(clock()),
      };
      const responseData = responseTransform?.({
        url, options, data, now: Number(clock()),
      }) ?? data;
      return new Response(JSON.stringify({
        code: 0,
        data: responseData,
      }), { status: 200 });
    }
    assert.equal(url.origin, environment === "vst"
      ? "https://open-api-vst.bingx.com" : "https://open-api.bingx.com");
    assert.equal(options.headers["X-BX-APIKEY"], "mock-key");
    const signatureInput = [...url.searchParams.entries()]
      .filter(([key]) => key !== "signature")
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, value]) => `${key}=${value}`)
      .join("&");
    assert.equal(url.searchParams.get("signature"), createHmac("sha256", "mock-secret")
      .update(signatureInput).digest("hex"));
    const data = (() => {
      switch (url.pathname) {
        case "/openApi/swap/v3/user/balance":
          return [{ asset: reportedBalanceAsset, availableMargin, accountId: "private" }];
        case "/openApi/swap/v2/user/positions":
          return state.positions;
        case "/openApi/swap/v2/trade/openOrders":
          if (openOrdersError) throw openOrdersError;
          return openOrders;
        case "/openApi/swap/v1/positionSide/dual":
          return { dualSidePosition };
        case "/openApi/swap/v2/quote/contracts":
          return contracts;
        case "/openApi/swap/v1/maintMarginRatio":
          return riskTierData;
        case "/openApi/swap/v2/quote/premiumIndex":
          return {
            symbol: "BTC-USDT", lastFundingRate: "0.0001", markPrice: "100",
            time: 0, nextFundingTime: 1700000000000,
          };
        case "/openApi/swap/v2/user/commissionRate":
          return feeData;
        case "/openApi/swap/v2/trade/leverage":
          return { symbol: "BTC-USDT", longLeverage, shortLeverage, maxPositionLongVal };
        case "/openApi/swap/v2/trade/order":
          return options.method === "GET"
            ? queryData ?? {
              orderId: 43, status: "FILLED",
              ...(attachedStop ? { stopLoss: '{"type":"STOP_MARKET","stopPrice":95}' } : {}),
            }
            : submissionData ?? {
            orderId: 43, status: "FILLED",
            ...(attachedStop ? { stopLoss: '{"type":"STOP_MARKET","stopPrice":95}' } : {}),
          };
        case "/openApi/swap/v2/trade/allFillOrders":
          return invalidFills
            ? { unexpected: [] }
            : fillData ?? [{ symbol: "BTC-USDT", orderId: 43, qty: "1", price: "100" }];
        case "/openApi/swap/v2/trade/marginType":
          return { symbol: "BTC-USDT", marginType };
        case "/openApi/swap/v2/trade/positionMargin":
          return { success: true };
        default:
          throw new Error(`Unexpected mocked path: ${url.pathname}`);
      }
    })();
    const responseData = responseTransform?.({
      url, options, data, now: Number(clock()),
    }) ?? data;
    const responseSequence = responseSequences[responseKey];
    if (Array.isArray(responseSequence) && responseSequence.length > 0) {
      const responseIndex = responseSequenceIndexes.get(responseKey) ?? 0;
      responseSequenceIndexes.set(responseKey, responseIndex + 1);
      const responseBody = responseSequence[Math.min(responseIndex, responseSequence.length - 1)];
      if (responseBody instanceof Error) throw responseBody;
      return new Response(typeof responseBody === "string"
        ? responseBody : JSON.stringify(responseBody), { status: 200 });
    }
    const rawData = rawResponses[responseKey];
    return new Response(rawData === undefined
      ? JSON.stringify({ code: 0, data: responseData })
      : `{"code":0,"data":${rawData}}`, { status: 200 });
  };
  const api = createBingXLiveApi({
    environment,
    origin,
    fetchImpl,
    clock,
    sleep,
    requestPacer: requestPacer ?? createBingXOutboundPacer({
      gapMs: 0, clock, sleep,
    }),
    random,
    onRateLimitDiagnostic,
    onTransientGetDiagnostic,
    credentials: () => ({ key: "mock-key", secret: "mock-secret" }),
    writePermission: async () => permission,
  });
  return { api, calls, state };
}

test("signed GET retries one retry-safe 100410 response with a fresh signature", async () => {
  let now = 1700000000000;
  const sleeps = [];
  const { api, calls } = fixture({
    responseSequences: {
      "GET /openApi/swap/v3/user/balance": [
        { code: 100410, msg: "temporarily busy" },
        { code: 0, data: [{ asset: "USDT", availableMargin: "100", accountId: "private" }] },
      ],
    },
    clock: () => now++,
    sleep: async (ms) => sleeps.push(ms),
  });

  const balance = await api.getBalance();
  const attempts = calls.filter(({ url }) => url.pathname === "/openApi/swap/v3/user/balance");
  assert.equal(balance[0].availableMargin, "100");
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every(({ options }) => options.method === "GET"));
  assert.notEqual(
    attempts[0].url.searchParams.get("timestamp"),
    attempts[1].url.searchParams.get("timestamp"),
  );
  assert.notEqual(
    attempts[0].url.searchParams.get("signature"),
    attempts[1].url.searchParams.get("signature"),
  );
  assert.ok(sleeps.some((ms) => ms >= 1000));
});

test("signed GET stops after the bounded retry budget for persistent 100410", async () => {
  let now = 1700000000000;
  const sleeps = [];
  const diagnostics = [];
  const { api, calls } = fixture({
    responseSequences: {
      "GET /openApi/swap/v3/user/balance": [
        { code: 100410, msg: "Request rate limit exceeded" },
      ],
    },
    clock: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    onRateLimitDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  await assert.rejects(api.getBalance(), (error) =>
    error.code === 100410 && error.exchangeMessage === "Request rate limit exceeded");
  assert.equal(calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v3/user/balance").length, 2);
  assert.ok(sleeps.some((ms) => ms >= 1000));
  assert.deepEqual(diagnostics.map(({ outcome }) => outcome), [
    "retry_scheduled", "retry_exhausted_cooldown",
  ]);
  assert.equal(diagnostics[0].endpoint, "/openApi/swap/v3/user/balance");
  assert.equal(diagnostics[0].method, "GET");
  assert.equal(diagnostics[0].code, 100410);
  assert.deepEqual(Object.keys(diagnostics[0]).sort(),
    ["code", "endpoint", "method", "outcome"]);
  assert.equal(JSON.stringify(diagnostics).includes("signature"), false);
});

test("signed GET retries only the exact 109400 timestamp refusal with a fresh signature", async () => {
  let now = 1700000000000;
  const sleeps = [];
  const diagnostics = [];
  const { api, calls } = fixture({
    responseSequences: {
      "GET /openApi/swap/v3/user/balance": [
        { code: 109400, msg: "timestamp is invalid" },
        { code: 0, data: [{ asset: "USDT", availableMargin: "100", accountId: "private" }] },
      ],
    },
    clock: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    onTransientGetDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  const balance = await api.getBalance();
  const attempts = calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v3/user/balance");
  assert.equal(balance[0].availableMargin, "100");
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every(({ options }) => options.method === "GET"));
  assert.notEqual(
    attempts[0].url.searchParams.get("timestamp"),
    attempts[1].url.searchParams.get("timestamp"),
  );
  assert.notEqual(
    attempts[0].url.searchParams.get("signature"),
    attempts[1].url.searchParams.get("signature"),
  );
  assert.ok(sleeps.some((ms) => ms >= 1000));
  assert.deepEqual(diagnostics.map(({ reason, outcome }) => [reason, outcome]), [
    ["timestamp_invalid", "retry_scheduled"],
  ]);
  assert.equal(JSON.stringify(diagnostics).includes("signature"), false);
});

test("signed GET timestamp refusals exhaust exactly two retries and retain safe diagnostics", async () => {
  let now = 1700000000000;
  const diagnostics = [];
  const { api, calls } = fixture({
    responseSequences: {
      "GET /openApi/swap/v3/user/balance": [
        { code: 109400, msg: "timestamp is invalid" },
      ],
    },
    clock: () => now,
    sleep: async (ms) => { now += ms; },
    onTransientGetDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  await assert.rejects(api.getBalance(), (error) =>
    error.code === 109400 && error.exchangeMessage === "timestamp is invalid");
  const attempts = calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v3/user/balance");
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every(({ options }) => options.method === "GET"));
  assert.equal(new Set(attempts.map(({ url }) =>
    url.searchParams.get("timestamp"))).size, 3);
  assert.deepEqual(diagnostics.map(({ reason, outcome }) => [reason, outcome]), [
    ["timestamp_invalid", "retry_scheduled"],
    ["timestamp_invalid", "retry_scheduled"],
    ["timestamp_invalid", "retry_exhausted"],
  ]);
  assert.equal(JSON.stringify(diagnostics).includes("mock-secret"), false);
  assert.equal(JSON.stringify(diagnostics).includes("signature"), false);
});

test("109400 timestamp retry is restricted to exact GET refusals and never retries writes", async (t) => {
  await t.test("other GET message is not retryable", async () => {
    const { api, calls } = fixture({
      responseSequences: {
        "GET /openApi/swap/v3/user/balance": [
          { code: 109400, msg: "parameter is invalid" },
        ],
      },
    });
    await assert.rejects(api.getBalance(), (error) =>
      error.code === 109400 && error.exchangeMessage === "parameter is invalid");
    assert.equal(calls.filter(({ url }) =>
      url.pathname === "/openApi/swap/v3/user/balance").length, 1);
  });

  await t.test("POST timestamp refusal is not retried", async () => {
    const { api, calls } = fixture({
      permission: true,
      responseSequences: {
        "POST /openApi/swap/v2/trade/order": [
          { code: 109400, msg: "timestamp is invalid" },
        ],
      },
    });
    await assert.rejects(api.placeLong({
      symbol: "BTCUSDT", quantity: "1", entryPrice: "100", stopLoss: "95",
      clientOrderId: "timestamp-post-no-retry",
    }), (error) => error.code === 109400);
    assert.equal(calls.filter(({ url, options }) =>
      url.pathname === "/openApi/swap/v2/trade/order" &&
      options.method === "POST").length, 1);
  });
});

test("VST signed reads, public ticker, and separate clients share the same request pacing", async () => {
  let now = 1700000000000;
  const starts = [];
  const requestPacer = createBingXOutboundPacer({
    gapMs: 1000,
    clock: () => now,
    sleep: async (ms) => {
      await new Promise((resolve) => setImmediate(resolve));
      now += ms;
    },
  });
  const first = fixture({
    environment: "vst",
    clock: () => now,
    requestPacer,
    onFetchStart: (request) => starts.push(request),
  });
  const second = fixture({
    environment: "vst",
    clock: () => now,
    requestPacer,
    onFetchStart: (request) => starts.push(request),
  });

  await Promise.all([
    first.api.getBalance(),
    second.api.getVstMarkPrice("BTCUSDT"),
    first.api.getBalance(),
  ]);

  const transportStarts = starts.map(({ startedAt }) => startedAt).sort((a, b) => a - b);
  assert.ok(transportStarts.length >= 4);
  for (let index = 1; index < transportStarts.length; index += 1) {
    assert.ok(transportStarts[index] - transportStarts[index - 1] >= 1000,
      JSON.stringify(transportStarts));
  }
  assert.ok(starts.some(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/ticker"));
  assert.ok(starts.some(({ url }) =>
    url.pathname === "/openApi/swap/v3/user/balance"));
  assert.ok(starts.every(({ url }) =>
    url.origin === "https://open-api-vst.bingx.com"));
});

test("VST public ticker backs off on 100410 and preserves the final exchange error", async () => {
  let now = 1700000000000;
  const starts = [];
  const diagnostics = [];
  const { api, calls } = fixture({
    environment: "vst",
    clock: () => now,
    sleep: async (ms) => { now += ms; },
    onFetchStart: (request) => starts.push(request),
    onRateLimitDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    responseSequences: {
      "GET /openApi/swap/v2/quote/ticker": [
        { code: 100410, msg: "ticker rate limited" },
        { code: 0, data: {
          symbol: "BTC-USDT", askPrice: "100", bidPrice: "99.9", time: 1700000000000,
        } },
      ],
    },
  });

  const mark = await api.getVstMarkPrice("BTCUSDT");
  const tickerCalls = calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/ticker");
  assert.equal(mark.markPrice, 100);
  assert.equal(tickerCalls.length, 2);
  assert.ok(tickerCalls[1] && starts.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/ticker")[1].startedAt -
    starts.filter(({ url }) =>
      url.pathname === "/openApi/swap/v2/quote/ticker")[0].startedAt >= 1000);
  assert.deepEqual(diagnostics.map(({ outcome }) => outcome), ["retry_scheduled"]);
  assert.equal(diagnostics[0].endpoint, "/openApi/swap/v2/quote/ticker");
  assert.equal(diagnostics[0].method, "GET");
  assert.equal(calls.some(({ options }) => options.method !== "GET"), false);
});

test("VST mark corroboration retries a classified readonly ticker-busy response only", async () => {
  let now = 1700000000000;
  const diagnostics = [];
  const { api, calls } = fixture({
    environment: "vst",
    clock: () => now,
    sleep: async (ms) => { now += ms; },
    onTransientGetDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    responseSequences: {
      "GET /openApi/swap/v2/quote/ticker": [
        { code: 109500, msg: "temporarily busy" },
        { code: 0, data: {
          symbol: "BTC-USDT", askPrice: "100", bidPrice: "99.9", time: now,
        } },
      ],
    },
  });

  const mark = await api.getVstMarkPrice("BTCUSDT");
  assert.equal(mark.markPrice, 100);
  assert.equal(calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/ticker").length, 2);
  assert.deepEqual(diagnostics.map(({ outcome, reason }) => [outcome, reason]), [
    ["retry_scheduled", "exchange_busy"],
  ]);
  assert.equal(calls.every(({ options }) => options.method === "GET"), true);
});

test("VST mark rereads funding and ticker after an uncorroborated mark but never accepts the failed pair", async () => {
  let now = 1700000000000;
  const diagnostics = [];
  const { api, calls } = fixture({
    environment: "vst",
    clock: () => now,
    sleep: async (ms) => { now += ms; },
    onTransientGetDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    responseSequences: {
      "GET /openApi/swap/v2/quote/ticker": [
        { code: 0, data: {
          symbol: "BTC-USDT", askPrice: "91", bidPrice: "90", time: now,
        } },
        { code: 0, data: {
          symbol: "BTC-USDT", askPrice: "100", bidPrice: "99.9", time: now,
        } },
      ],
    },
  });

  const mark = await api.getVstMarkPrice("BTCUSDT");
  assert.equal(mark.markPrice, 100);
  assert.equal(calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/premiumIndex").length, 2);
  assert.equal(calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/ticker").length, 2);
  assert.deepEqual(diagnostics.map(({ reason }) => reason), ["mark_uncorroborated"]);
  assert.equal(calls.every(({ options }) => options.method === "GET"), true);
});

test("VST parses the explicit markPrice from a native-shaped premiumIndex response", async () => {
  const now = 1700000000000;
  const { api } = fixture({
    environment: "vst",
    clock: () => now,
    responseSequences: {
      "GET /openApi/swap/v2/quote/premiumIndex": [{
        code: 0,
        data: {
          symbol: "AVAX-USDT",
          lastFundingRate: "0.0001",
          indexPrice: "35.99",
          markPrice: "36.01",
          time: now,
          nextFundingTime: now + 60_000,
        },
      }],
    },
  });

  const mark = await api.getVstMarkPrice("AVAXUSDT");
  assert.equal(mark.symbol, "AVAX-USDT");
  assert.equal(mark.markPrice, 36.01);
  assert.equal(mark.timestamp, now);
  assert.equal(mark.timestampSource, "exchange_mark_time");
  assert.equal(mark.markPriceSource, "premium_index");
  assert.equal(mark.markCorroboration, undefined);
});

test("VST stale or future premiumIndex times require fresh bid/ask corroboration and expose provenance", async () => {
  for (const [label, exchangeTime] of [
    ["stale", 1699999980000],
    ["future", 1700000030000],
  ]) {
    let now = 1700000000000;
    const { api, calls } = fixture({
      environment: "vst",
      clock: () => now,
      sleep: async (ms) => { now += ms; },
      responseSequences: {
        "GET /openApi/swap/v2/quote/premiumIndex": [{
          code: 0,
          data: {
            symbol: "AVAX-USDT",
            markPrice: "36.01",
            time: exchangeTime,
          },
        }],
        "GET /openApi/swap/v2/quote/ticker": [{
          code: 0,
          data: {
            symbol: "AVAX-USDT",
            askPrice: "36.05",
            bidPrice: "36.00",
            time: now,
          },
        }],
      },
    });

    const mark = await api.getVstMarkPrice("AVAXUSDT");
    assert.equal(mark.symbol, "AVAX-USDT", label);
    assert.equal(mark.markPrice, 36.01, label);
    assert.equal(mark.timestamp, now, label);
    assert.equal(mark.timestampSource, "local_response_received", label);
    assert.equal(mark.markPriceSource, "premium_index", label);
    assert.deepEqual(mark.markCorroboration, {
      source: "ticker_bid_ask",
      observedAt: now,
      bid: 36,
      ask: 36.05,
      exchangeTimestamp: exchangeTime,
    }, label);
    assert.equal(calls.filter(({ url }) =>
      url.pathname === "/openApi/swap/v2/quote/ticker").length, 1, label);
  }
});

test("VST premiumIndex transport faults retry only the bounded read and preserve mark provenance", async () => {
  let now = 1700000000000;
  const diagnostics = [];
  const { api, calls } = fixture({
    environment: "vst",
    clock: () => now,
    sleep: async (ms) => { now += ms; },
    onTransientGetDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    responseSequences: {
      "GET /openApi/swap/v2/quote/premiumIndex": [
        new TypeError("simulated read-only transport fault"),
        {
          code: 0,
          data: {
            symbol: "AVAX-USDT",
            markPrice: "36.01",
            time: now,
          },
        },
      ],
    },
  });

  const mark = await api.getVstMarkPrice("AVAXUSDT");
  assert.equal(mark.markPrice, 36.01);
  assert.equal(mark.timestampSource, "exchange_mark_time");
  assert.equal(calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/premiumIndex").length, 2);
  assert.deepEqual(diagnostics.map(({ outcome, reason }) => [outcome, reason]), [
    ["retry_scheduled", "network_request"],
  ]);
  assert.equal(calls.every(({ options }) => options.method === "GET"), true);
});

test("VST premiumIndex refuses wrong symbols and never substitutes funding or index prices", async () => {
  const { api, calls } = fixture({
    environment: "vst",
    responseSequences: {
      "GET /openApi/swap/v2/quote/premiumIndex": [{
        code: 0,
        data: {
          symbol: "BTC-USDT",
          lastFundingRate: "36.01",
          indexPrice: "36.01",
          time: 1700000000000,
        },
      }],
    },
  });

  await assert.rejects(api.getVstMarkPrice("AVAXUSDT"), /mismatched VST mark-price symbol/);
  assert.equal(calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/premiumIndex").length, 1);
  assert.equal(calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/ticker").length, 1);
});

test("VST premiumIndex requires explicit markPrice even when the symbol matches", async () => {
  const { api, calls } = fixture({
    environment: "vst",
    responseSequences: {
      "GET /openApi/swap/v2/quote/premiumIndex": [{
        code: 0,
        data: {
          symbol: "AVAX-USDT",
          lastFundingRate: "36.01",
          indexPrice: "36.01",
          time: 1700000000000,
        },
      }],
    },
  });

  await assert.rejects(api.getVstMarkPrice("AVAXUSDT"), /invalid VST mark price/);
  assert.equal(calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/premiumIndex").length, 1);
  assert.equal(calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/ticker").length, 1);
});

test("repeated uncorroborated mark failure stays unknown and retains the first read diagnostic ref", async () => {
  let now = 1700000000000;
  const { api, calls } = fixture({
    environment: "vst",
    clock: () => now,
    sleep: async (ms) => { now += ms; },
    responseSequences: {
      "GET /openApi/swap/v2/quote/ticker": [
        { code: 0, data: {
          symbol: "BTC-USDT", askPrice: "91", bidPrice: "90", time: now,
        } },
      ],
    },
  });

  await assert.rejects(api.getVstMarkPrice("BTCUSDT"), (error) => {
    assert.equal(error.message, "VST mark is not corroborated by a fresh quote");
    assert.equal(error.firstMarkReadFailure?.reason, "market_mark_unverified");
    assert.equal(error.firstMarkReadFailure?.retryReason, "mark_outside_fresh_quote");
    assert.match(error.firstMarkReadFailure?.ref ?? "", /^[a-f0-9]{12}$/);
    assert.equal(error.vstMarkEvidence?.length, 2);
    for (const [attempt, evidence] of error.vstMarkEvidence.entries()) {
      assert.equal(evidence.attempt, attempt);
      assert.equal(evidence.predicate, "mark_above_ask_buffer");
      assert.equal(evidence.markPrice, 100);
      assert.equal(evidence.bid, 90);
      assert.equal(evidence.ask, 91);
      assert.equal(evidence.lowerBound, 89.909);
      assert.equal(evidence.upperBound, 91.091);
      assert.equal(evidence.exchangeTimestampStatus, "invalid");
      assert.equal(evidence.tickerObservedAt, 1700000000000);
      assert.equal(evidence.tickerAgeAtComparisonMs, attempt * 2000);
      assert.equal(evidence.fundingToTickerReadAgeMs, 0);
    }
    return true;
  });
  assert.equal(calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/premiumIndex").length, 2);
  assert.equal(calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/ticker").length, 2);
  assert.equal(calls.every(({ options }) => options.method === "GET"), true);
});

test("VST marks retry stale ticker proof and report its numeric failed freshness predicate", async () => {
  let now = 1700000000000;
  const { api, calls } = fixture({
    environment: "vst",
    clock: () => now,
    sleep: async (ms) => { now += ms; },
    responseSequences: {
      "GET /openApi/swap/v2/quote/premiumIndex": [{
        code: 0,
        data: { symbol: "BTC-USDT", markPrice: "100", time: 0 },
      }],
      "GET /openApi/swap/v2/quote/ticker": [{
        code: 0,
        data: {
          symbol: "BTC-USDT",
          askPrice: "100",
          bidPrice: "99.9",
          time: 1699999988000,
        },
      }],
    },
  });

  await assert.rejects(api.getVstMarkPrice("BTCUSDT"), (error) => {
    assert.equal(error.firstMarkReadFailure?.reason, "ticker_timestamp_unavailable");
    assert.equal(error.vstMarkEvidence?.length, 2);
    for (const [attempt, evidence] of error.vstMarkEvidence.entries()) {
      assert.equal(evidence.predicate, "ticker_timestamp_stale");
      assert.equal(evidence.markPrice, 100);
      assert.equal(evidence.bid, 99.9);
      assert.equal(evidence.ask, 100);
      assert.equal(evidence.tickerObservedAt, 1699999988000);
      assert.equal(evidence.tickerAgeAtReadMs, 12000 + attempt * 2000);
    }
    return true;
  });
  assert.equal(calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/premiumIndex").length, 2);
  assert.equal(calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/ticker").length, 2);
});

test("VST mark without an exchange timestamp retries the complete pair after quote-corroboration expiry", async () => {
  let now = 1700000000000;
  let fundingResponses = 0;
  const { api, calls } = fixture({
    environment: "vst",
    clock: () => now,
    beforeResponse: async ({ url }) => {
      if (url.pathname === "/openApi/swap/v2/quote/premiumIndex" &&
          fundingResponses++ === 0) {
        // Let the paired ticker finish first, then age that book past the
        // unchanged 10-second bound before the mark response completes.
        await new Promise((resolve) => setImmediate(resolve));
        now += 10_001;
      }
    },
  });

  const mark = await api.getVstMarkPrice("BTCUSDT");
  assert.equal(mark.markPrice, 100);
  assert.equal(calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/premiumIndex").length, 2);
  assert.equal(calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/ticker").length, 2);
});

test("VST mark and ticker are co-enqueued, and unused ticker rejection cannot discard a fresh mark", async () => {
  let now = 1700000000000;
  const starts = [];
  let releaseTicker;
  const tickerBlocked = new Promise((resolve) => { releaseTicker = resolve; });
  const { api, calls } = fixture({
    environment: "vst",
    clock: () => now,
    onFetchStart: (request) => starts.push(request),
    beforeResponse: async ({ url }) => {
      if (url.pathname === "/openApi/swap/v2/quote/ticker") {
        await tickerBlocked;
      }
    },
    fetchErrors: {
      "GET /openApi/swap/v2/quote/ticker": new TypeError("ticker unavailable"),
    },
    responseSequences: {
      "GET /openApi/swap/v2/quote/premiumIndex": [{
        code: 0,
        data: {
          symbol: "BTC-USDT", lastFundingRate: "0.0001", markPrice: "100",
          time: now,
        },
      }],
    },
  });

  const mark = await api.getVstMarkPrice("BTCUSDT");
  assert.equal(mark.markPrice, 100);
  assert.equal(mark.timestampSource, "exchange_mark_time");
  const fundingStart = starts.find(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/premiumIndex");
  const tickerStart = starts.find(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/ticker");
  assert.ok(fundingStart && tickerStart, "both reads should have started");
  assert.equal(calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/premiumIndex").length, 1);
  assert.equal(calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/ticker").length, 1);
  releaseTicker();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/ticker").length, 2);
});

test("VST missing-timestamp pair tolerates reverse completion only while both reads remain fresh", async () => {
  let now = 1700000000000;
  let fundingResponses = 0;
  const { api, calls } = fixture({
    environment: "vst",
    clock: () => now,
    beforeResponse: async ({ url }) => {
      if (url.pathname === "/openApi/swap/v2/quote/premiumIndex" &&
          fundingResponses++ === 0) {
        await new Promise((resolve) => setImmediate(resolve));
        now += 500;
      }
    },
    responseSequences: {
      "GET /openApi/swap/v2/quote/premiumIndex": [{
        code: 0,
        data: { symbol: "BTC-USDT", markPrice: "100", time: 0 },
      }],
    },
  });

  const mark = await api.getVstMarkPrice("BTCUSDT");
  assert.equal(mark.markPrice, 100);
  assert.equal(mark.timestampSource, "local_response_received");
  assert.equal(mark.markCorroboration.source, "ticker_bid_ask");
  assert.equal(calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/premiumIndex").length, 1);
  assert.equal(calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/ticker").length, 1);
});

test("VST concurrent pair slots stay adjacent under unrelated shared-pacer contention", async () => {
  let now = 1700000000000;
  const marketStart = now;
  const starts = [];
  const requestPacer = createBingXOutboundPacer({
    gapMs: 1100,
    clock: () => now,
    sleep: async (ms) => {
      await new Promise((resolve) => setImmediate(resolve));
      now += ms;
    },
  });
  const { api } = fixture({
    environment: "vst",
    clock: () => now,
    requestPacer,
    onFetchStart: (request) => starts.push(request),
    responseTransform: ({ url, data, now: observedAt }) => {
      const movingMark = 100 + (observedAt - marketStart) / 100_000;
      if (url.pathname === "/openApi/swap/v2/quote/premiumIndex") {
        return { ...data, markPrice: String(movingMark), time: 0 };
      }
      if (url.pathname === "/openApi/swap/v2/quote/ticker") {
        const movingBook = 100 + (observedAt - marketStart) / 100_000;
        return {
          ...data,
          bidPrice: String(movingBook - 0.05),
          askPrice: String(movingBook + 0.05),
          time: observedAt,
        };
      }
      return data;
    },
  });
  const markPromise = api.getVstMarkPrice("BTCUSDT");
  const unrelatedPromise = api.getBalance();
  const mark = await markPromise;
  await unrelatedPromise;

  assert.equal(mark.markPrice, 100);
  assert.equal(mark.markCorroboration.source, "ticker_bid_ask");
  assert.ok(mark.markCorroboration.bid > 99.9);
  const pairStarts = starts.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/premiumIndex" ||
    url.pathname === "/openApi/swap/v2/quote/ticker");
  assert.equal(pairStarts.length, 2);
  const times = pairStarts.map(({ startedAt }) => startedAt).sort((a, b) => a - b);
  assert.ok(times[1] - times[0] <= 2200, JSON.stringify(times));
  const balanceStart = starts.find(({ url }) =>
    url.pathname === "/openApi/swap/v3/user/balance");
  assert.ok(balanceStart);
  assert.ok(balanceStart.startedAt >= times[1]);
});

test("persistent VST ticker 100410 remains an exchange response, not a pre-transport failure", async () => {
  let now = 1700000000000;
  const diagnostics = [];
  const { api, calls } = fixture({
    environment: "vst",
    clock: () => now,
    sleep: async (ms) => { now += ms; },
    onRateLimitDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    responseSequences: {
      "GET /openApi/swap/v2/quote/ticker": [
        { code: 100410, msg: "ticker rate limit persists" },
      ],
    },
  });

  await assert.rejects(api.getVstMarkPrice("BTCUSDT"), (error) =>
    error.code === 100410 &&
    error.exchangeMessage === "ticker rate limit persists" &&
    error.transportStage === "exchange_response");
  assert.equal(calls.filter(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/ticker").length, 2);
  assert.deepEqual(diagnostics.map(({ outcome }) => outcome), [
    "retry_scheduled", "retry_exhausted_cooldown",
  ]);
  assert.equal(calls.some(({ options }) => options.method !== "GET"), false);
});

test("POST is never retried when BingX responds with 100410", async () => {
  const diagnostics = [];
  const { api, calls } = fixture({
    permission: true,
    onRateLimitDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    responseSequences: {
      "POST /openApi/swap/v2/trade/order": [
        { code: 100410, msg: "temporarily busy" },
      ],
    },
  });

  await assert.rejects(api.placeLong({
    symbol: "BTCUSDT", quantity: "1", entryPrice: "100", stopLoss: "95",
    clientOrderId: "busy-post-no-retry",
  }), (error) => error.code === 100410);
  assert.equal(calls.filter(({ url, options }) =>
    url.pathname === "/openApi/swap/v2/trade/order" && options.method === "POST").length, 1);
  assert.deepEqual(diagnostics.map(({ outcome }) => outcome), [
    "write_not_retried_cooldown",
  ]);
  assert.equal(diagnostics[0].method, "POST");
  assert.equal(diagnostics[0].code, 100410);
});

test("unrelated BingX GET errors and network failures are not retried", async (t) => {
  await t.test("unrelated exchange code", async () => {
    const { api, calls } = fixture({
      responseSequences: {
        "GET /openApi/swap/v3/user/balance": [
          { code: 109418, msg: "symbol offline" },
        ],
      },
    });

    await assert.rejects(api.getBalance(), (error) => error.code === 109418);
    assert.equal(calls.filter(({ url }) =>
      url.pathname === "/openApi/swap/v3/user/balance").length, 1);
  });

  await t.test("network failure", async () => {
    const { api, calls } = fixture({
      fetchErrors: {
        "GET /openApi/swap/v3/user/balance": new Error("network unavailable"),
      },
    });

    await assert.rejects(api.getBalance(), /request failed/);
    assert.equal(calls.filter(({ url }) =>
      url.pathname === "/openApi/swap/v3/user/balance").length, 1);
  });
});

test("default permission denies every live write while signed GET remains mockable", async () => {
  const { api, calls } = fixture({
    positions: [{ symbol: "BTC-USDT", positionSide: "BOTH", positionAmt: "1" }],
  });
  assert.equal((await api.contract("BTCUSDT")).symbol, "BTC-USDT");
  await assert.rejects(api.closeLong("BTCUSDT", "1"), /explicit permission/);
  assert.equal(calls.some(({ options }) => options.method !== "GET"), false);
});

test("a long exit refuses cross margin before any live order submission", async () => {
  const { api, calls } = fixture({
    permission: true,
    marginType: "CROSSED",
    positions: [{ symbol: "BTC-USDT", positionSide: "BOTH", positionAmt: "1" }],
  });
  await assert.rejects(api.closeLong("BTCUSDT", "1"), /isolated margin/);
  assert.equal(calls.every(({ options }) => options.method === "GET"), true);
});

test("account balance uses the signed read-only balance endpoint without enabling writes", async () => {
  const { api, calls } = fixture({ availableMargin: "56.02" });
  const balance = await api.getBalance();
  assert.deepEqual(balance, [{
    asset: "USDT", availableMargin: "56.02", accountId: "private",
  }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/openApi/swap/v3/user/balance");
  assert.equal(calls[0].options.method, "GET");
  await assert.rejects(api.placeLong({
    symbol: "BTCUSDT", quantity: "1", entryPrice: "100", stopLoss: "95",
    clientOrderId: "read-only-balance-test",
  }), /explicit permission/);
  assert.equal(calls.some(({ options }) => options.method !== "GET"), false);
});

test("strict preflight verifies exchange-reported isolated margin, both 10x settings, one-way flat account, and safe stop", async () => {
  const { api, calls } = fixture();
  const ready = await api.preflight("BTCUSDT", {
    quantity: "1", entryPrice: "100", stopLoss: "95",
  });
  assert.equal(ready.status, "ready");
  assert.deepEqual(ready.blockers, []);
  assert.equal(ready.stopRisk.exactStopDistance, "5");
  assert.ok(ready.stopRisk.estimatedLiquidationPrice < 95);
  assert.equal(calls.every(({ options }) => options.method === "GET"), true);
});

test("VST environment uses only the fixed VST host and VST account asset for read-only preflight", async () => {
  const { api, calls } = fixture({ environment: "vst", availableMargin: "100" });
  const ready = await api.preflight("BTCUSDT", {
    quantity: "1", entryPrice: "100", stopLoss: "95",
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.environment, "vst");
  assert.equal(ready.marginAsset, "VST");
  assert.equal(ready.stopRisk.marginAsset, "VST");
  assert.equal(Object.hasOwn(ready.stopRisk, "plannedTopUpUsd"), false);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(({ url, options }) =>
    url.origin === "https://open-api-vst.bingx.com" && options.method === "GET"));
  assert.equal(calls.some(({ url }) => url.origin === "https://open-api.bingx.com"), false);
});

test("VST stop-risk collateral calculations report VST-denominated top-up units", async () => {
  const { api, calls } = fixture({
    environment: "vst",
    availableMargin: "10.90",
  });
  const plan = await api.preflight("BTCUSDT", {
    quantity: "1", entryPrice: "100", stopLoss: "90.4",
  });
  assert.equal(plan.status, "ready");
  assert.ok(plan.plannedTopUpMargin > 0);
  assert.equal(Object.hasOwn(plan, "plannedTopUpUsd"), false);
  assert.equal(plan.requiredTotalMargin, 10 + plan.plannedTopUpMargin);
  assert.equal(plan.stopRisk.plannedTopUpMargin, plan.plannedTopUpMargin);
  assert.equal(plan.stopRisk.marginAsset, "VST");
  assert.equal(plan.stopRisk.safe, true);
  assert.ok(calls.every(({ options }) => options.method === "GET"));
});

test("VST preflight accepts the USDT-quoted contract and requires a VST account balance", async () => {
  const { api, calls } = fixture({ environment: "vst" });
  const ready = await api.preflight("BTCUSDT");
  assert.equal(ready.status, "ready");
  assert.equal(ready.marginAsset, "VST");
  assert.equal(calls.some(({ url }) =>
    url.pathname === "/openApi/swap/v2/quote/contracts"), true);

  await assert.rejects(fixture({
    environment: "vst",
    contractData: [{ ...contract, currency: "VST" }],
  }).api.preflight("BTCUSDT"), /USDT perpetual/);

  const wrongBalance = await fixture({
    environment: "vst",
    balanceAsset: "USDT",
  }).api.preflight("BTCUSDT");
  assert.equal(wrongBalance.environment, "vst");
  assert.equal(wrongBalance.status, "blocked");
  assert.equal(wrongBalance.checks.initialMargin, false);
});

test("VST origin cannot be caller-selected and stays read-only without injected write permission", async () => {
  assert.throws(() => createBingXLiveApi({
    environment: "https://open-api.bingx.com",
    fetchImpl: async () => { throw new Error("unexpected network request"); },
  }), /environment must be/);

  const { api, calls } = fixture({
    environment: "vst", origin: "https://open-api.bingx.com",
  });
  await api.getBalance();
  assert.ok(calls.every(({ url, options }) =>
    url.origin === "https://open-api-vst.bingx.com" && options.method === "GET"));
  assert.equal(calls.some(({ options }) => options.method !== "GET"), false);
});

test("risk tiers and commission rates accept current BingX shapes and legacy flat field names", async () => {
  const current = fixture({
    riskTierData: [{
      symbol: "BTC-USDT", maxPositionVal: "100000", maintMarginRatio: "0.005",
    }],
    feeData: {
      commission: { makerCommissionRate: 0.0002, takerCommissionRate: 0.0005 },
    },
  });
  assert.deepEqual(await current.api.getRiskTiers("BTCUSDT"), [{
    maxNotional: 100000, maintenanceMarginRate: 0.005,
  }]);
  assert.deepEqual(await current.api.getFeeRate("BTCUSDT"), {
    maker: 0.0002, taker: 0.0005,
  });
  assert.equal((await current.api.preflight("BTCUSDT")).status, "ready");

  const legacy = fixture({
    riskTierData: [{ symbol: "BTC-USDT", maxPosition: "100000", maintMarginRatio: "0.005" }],
    feeData: { makerCommissionRate: "0.0002", takerCommissionRate: "0.0005" },
  });
  assert.deepEqual(await legacy.api.getRiskTiers("BTCUSDT"), [{
    maxNotional: 100000, maintenanceMarginRate: 0.005,
  }]);
  assert.deepEqual(await legacy.api.getFeeRate("BTCUSDT"), {
    maker: 0.0002, taker: 0.0005,
  });
});

test("malformed current commission and risk-tier fields fail closed without top-level fallback", async () => {
  await assert.rejects(fixture({
    feeData: {
      makerCommissionRate: "0.0002",
      takerCommissionRate: "0.0005",
      commission: { makerCommissionRate: "", takerCommissionRate: "0.0005" },
    },
  }).api.getFeeRate("BTCUSDT"), /invalid maker commission rate/);
  await assert.rejects(fixture({
    riskTierData: [{
      symbol: "BTC-USDT", maxPositionVal: "not-a-number",
      maxPosition: "100000", maintMarginRatio: "0.005",
    }],
  }).api.getRiskTiers("BTCUSDT"), /risk tier data is incomplete/);
  await assert.rejects(fixture({ maxPositionLongVal: null }).api.getLeverage("BTCUSDT"),
    /invalid maximum long position value/);
  await assert.rejects(fixture({ maxPositionLongVal: "0" }).api.getLeverage("BTCUSDT"),
    /invalid maximum long position value/);
});

test("getLeverage surfaces the exchange's per-leverage maximum position value", async () => {
  const { api } = fixture({ maxPositionLongVal: "5000.000" });
  assert.deepEqual(await api.getLeverage("BTCUSDT"), {
    longLeverage: 10, shortLeverage: 10, maxPositionLongVal: 5000,
  });
});

test("failed exchange settings, occupied symbol, or open orders prevent order writes", async () => {
  for (const options of [
    { marginType: "CROSSED" },
    { longLeverage: 10, shortLeverage: 9 },
    { positions: [{ symbol: "BTC-USDT", positionAmt: "0.01" }] },
    { openOrders: [{ symbol: "BTC-USDT", orderId: 42 }] },
  ]) {
    const { api, calls } = fixture({ permission: true, ...options });
    await assert.rejects(api.placeLong({
      symbol: "BTCUSDT", quantity: "1", entryPrice: "100",
      stopLoss: "95", clientOrderId: `guard-${calls.length}`,
    }), /preflight blocked/);
    assert.equal(calls.some(({ options: request }) => request.method !== "GET"), false);
  }
});

test("hedge account keeps other symbols untouched and sends LONG only on a clear target symbol", async () => {
  const { api, calls, state } = fixture({
    permission: true,
    dualSidePosition: true,
    positions: [{ symbol: "ETH-USDT", positionSide: "LONG", positionAmt: "2" }],
  });
  const assessment = await api.preflight("BTCUSDT", {
    quantity: "1", entryPrice: "100", stopLoss: "95",
  });
  assert.equal(assessment.status, "ready");
  assert.equal(assessment.positionMode, "HEDGE");
  await api.placeLong({
    symbol: "BTCUSDT", quantity: "1", entryPrice: "100",
    stopLoss: "95", clientOrderId: "hedge-signal-1",
  });
  const entry = calls.find(({ url, options }) =>
    url.pathname.endsWith("/trade/order") && options.method === "POST");
  assert.equal(entry.url.searchParams.get("positionSide"), "LONG");
  state.positions.push({ symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "1" });
  await api.closeLong("BTCUSDT", "1", "hedge-exit-1");
  const exit = calls.filter(({ url, options }) =>
    url.pathname.endsWith("/trade/order") && options.method === "POST").at(-1);
  assert.equal(exit.url.searchParams.get("positionSide"), "LONG");
  assert.equal(exit.url.searchParams.has("reduceOnly"), false);
  assert.equal(exit.url.searchParams.get("clientOrderId"), "hedge-exit-1");
  assert.equal(state.positions[0].positionAmt, "2");
  assert.equal(calls.some(({ url, options }) =>
    options.method === "POST" && (url.pathname.endsWith("/marginType") ||
      url.pathname.endsWith("/leverage"))), false);
});

test("long entry attaches a numeric stopLoss JSON and protects against duplicate retries", async () => {
  const { api, calls } = fixture({ permission: true });
  const result = await api.placeLong({
    symbol: "BTCUSDT",
    quantity: "1.2349",
    entryPrice: "70",
    stopLoss: "66",
    clientOrderId: "signal-123",
  });
  assert.equal(result.orderId, 43);
  const orderCall = calls.find(({ url, options }) =>
    url.pathname.endsWith("/trade/order") && options.method === "POST");
  assert.equal(orderCall.url.searchParams.get("quantity"), "1.234");
  assert.deepEqual(JSON.parse(orderCall.url.searchParams.get("stopLoss")), {
    type: "STOP_MARKET", stopPrice: 66,
  });
  assert.equal(orderCall.url.searchParams.get("positionSide"), "BOTH");
  assert.equal(orderCall.url.searchParams.get("clientOrderId"), "signal-123");
  await assert.rejects(api.placeLong({
    symbol: "BTCUSDT", quantity: "1", entryPrice: "70",
    stopLoss: "66", clientOrderId: "signal-123",
  }), /already submitted/);
  await assert.rejects(api.placeLong({
    symbol: "BTCUSDT", quantity: "1", entryPrice: "70",
    stopLoss: "66.01", clientOrderId: "signal-124",
  }), /exceeds BingX contract precision/);
});

test("raw unsafe order IDs remain exact and adjacent IDs stay distinct across reads and writes", async () => {
  const first = "9007199254740992";
  const second = "9007199254740993";
  const opened = fixture({
    rawResponses: {
      "GET /openApi/swap/v2/trade/openOrders":
        `[{"symbol":"BTC-USDT","orderId":${first}},{"symbol":"BTC-USDT","orderID":${second}}]`,
    },
  });
  const orders = await opened.api.getOpenOrders("BTCUSDT");
  assert.deepEqual(orders.map((order) => order.orderId ?? order.orderID), [first, second]);

  const { api, calls } = fixture({
    permission: true,
    rawResponses: {
      "POST /openApi/swap/v2/trade/order": `{"orderId":${second},"status":"FILLED"}`,
      "GET /openApi/swap/v2/trade/order":
        `{"orderId":${second},"memo":"quoted \\"orderId\\":${first}"}`,
    },
  });
  const submitted = await api.placeLong({
    symbol: "BTCUSDT", quantity: "1", entryPrice: "100", stopLoss: "95",
    clientOrderId: "raw-unsafe-id-test",
  });
  assert.equal(submitted.orderId, second);

  const queried = await api.queryOrder("BTCUSDT", { orderId: first });
  assert.equal(queried.orderId, second);
  assert.equal(queried.memo, `quoted "orderId":${first}`);
  const queryCall = calls.find(({ url, options }) =>
    url.pathname.endsWith("/trade/order") && options.method === "GET");
  assert.equal(queryCall.url.searchParams.get("orderId"), first);
});

test("raw adjacent unsafe fill trade IDs remain distinct across supported ID fields", async () => {
  const first = "9007199254740992";
  const second = "9007199254740993";
  const { api } = fixture({
    rawResponses: {
      "GET /openApi/swap/v2/trade/allFillOrders":
        `[{"symbol":"BTC-USDT","orderId":43,"tradeId":${first},"id":${first},` +
        `"fillId":${first},"qty":"1","price":"100"},` +
        `{"symbol":"BTC-USDT","orderId":43,"tradeID":${second},"id":${second},` +
        `"fillID":${second},"qty":"1","price":"100"}]`,
    },
  });
  const fills = await api.queryFills("BTCUSDT", {
    startTs: 1699999999000,
    endTs: 1700000000000,
    currency: "USDT",
  });
  assert.deepEqual(fills.map((fill) => fill.tradeId ?? fill.tradeID), [first, second]);
  assert.deepEqual(fills.map((fill) => fill.id), [first, second]);
  assert.deepEqual(fills.map((fill) => fill.fillId ?? fill.fillID), [first, second]);
});

test("unsafe JavaScript numeric ID inputs remain rejected by strict query checks", async () => {
  const { api, calls } = fixture();
  await assert.rejects(api.queryOrder("BTCUSDT", 9007199254740992), /query order ID/);
  await assert.rejects(api.queryFills("BTCUSDT", {
    startTs: 1699999999000, endTs: 1700000000000,
    orderId: 9007199254740992, currency: "USDT",
  }), /fill query order ID/);
  assert.equal(calls.length, 0);
});

test("protective stop identity preserves unsafe numeric-only open orders", async () => {
  const exact = "9007199254740993";
  const stop = {
    symbol: "BTC-USDT", orderId: 9007199254740992, orderID: exact,
    mainOrderId: "43", type: "STOP_MARKET", status: "NEW", side: "SELL",
    positionSide: "BOTH", origQty: "1", stopPrice: "95", closePosition: true,
    workingType: "MARK_PRICE",
  };
  const safe = fixture({
    positions: [{ symbol: "BTC-USDT", positionAmt: "1", positionSide: "BOTH" }],
    openOrders: [stop],
  });
  const proof = await safe.api.reconcilePositionAndStop("BTCUSDT", {
    orderId: 43, stopOrderId: exact, expectedStopPrice: "95", expectedQuantity: "1",
  });
  assert.equal(proof.stopProtected, true);
  assert.equal(proof.protectiveStopOrderId, exact);

  const unsafe = fixture({
    positions: [{ symbol: "BTC-USDT", positionAmt: "1", positionSide: "BOTH" }],
    openOrders: [{ ...stop, orderID: undefined }],
  });
  const unsafeProof = await unsafe.api.assessProtectiveStopAmendment("BTCUSDT", {
    stopOrderId: "9007199254740992", expectedStopPrice: "95", expectedQuantity: "1",
  });
  assert.equal(unsafeProof.existingStopVerified, true);
});

test("contract maxima may be absent but preflight still requires exchange-verified 10x", async () => {
  const { maxLongLeverage: _long, maxShortLeverage: _short, ...contractWithoutMaxima } = contract;
  const { api } = fixture({ contractData: [contractWithoutMaxima] });
  const filters = await api.contract("BTCUSDT");
  assert.equal(Object.hasOwn(filters, "maxLeverage"), false);
  assert.equal((await api.preflight("BTCUSDT")).status, "ready");
  assert.equal(
    (await fixture({ contractData: [contractWithoutMaxima], longLeverage: 9 }).api
      .preflight("BTCUSDT")).checks.leverage10,
    false,
  );
});

test("read-only protective stop discovery returns a lossless exact ID only for one matching open stop", async () => {
  const stopId = "9007199254740993";
  const { api, calls } = fixture({
    positions: [{ symbol: "BTC-USDT", positionAmt: "1", positionSide: "BOTH" }],
    rawResponses: {
      "GET /openApi/swap/v2/trade/openOrders":
        `[{"symbol":"BTC-USDT","orderId":${stopId},"mainOrderId":43,` +
        `"type":"STOP_MARKET","status":"NEW","side":"SELL","positionSide":"BOTH",` +
        `"origQty":"1","stopPrice":"95","closePosition":false}]`,
    },
  });
  const discovered = await api.discoverAttachedStop("BTCUSDT", {
    entryOrderId: 43, expectedStopPrice: "95", expectedQuantity: "1",
  });
  assert.equal(discovered.verified, true);
  assert.equal(discovered.stopOrderId, stopId);
  assert.equal(calls.every(({ options }) => options.method === "GET"), true);
});

test("stop discovery accepts closePosition coverage but rejects missing, ambiguous, or mismatched stops", async () => {
  const base = {
    symbol: "BTC-USDT", orderId: 52, mainOrderId: 43,
    type: "STOP_MARKET", status: "NEW", side: "SELL", positionSide: "BOTH",
    origQty: "0", stopPrice: "95", closePosition: true,
  };
  const discover = async ({ openOrders = [base], positions, entryOrderId = 43 } = {}) => {
    const { api, calls } = fixture({
      openOrders,
      positions: positions ?? [{ symbol: "BTC-USDT", positionAmt: "1", positionSide: "BOTH" }],
    });
    const result = api.discoverAttachedStop("BTCUSDT", {
      entryOrderId, expectedStopPrice: "95", expectedQuantity: "1",
    });
    return { result, calls };
  };
  const success = await discover();
  assert.equal((await success.result).stopOrderId, "52");
  assert.ok(success.calls.every(({ options }) => options.method === "GET"));
  for (const scenario of [
    { openOrders: [] },
    { openOrders: [base, { ...base, orderId: 53 }] },
    { openOrders: [{ ...base, parentOrderId: 44 }] },
    { openOrders: [{ ...base, side: "BUY" }] },
    { openOrders: [{ ...base, stopPrice: "94" }] },
    { openOrders: [{ ...base, closePosition: false, origQty: "0.5" }] },
    { positions: [{ symbol: "BTC-USDT", positionAmt: "0.5", positionSide: "BOTH" }] },
  ]) {
    const { result } = await discover(scenario);
    await assert.rejects(result, /stop|position|order/i);
  }
});

test("risk estimate plans collateral when the untopped stop distance is unsafe", async () => {
  const { api } = fixture({ permission: true });
  const blocked = await api.preflight("BTCUSDT", {
    quantity: "1", entryPrice: "100", stopLoss: "90",
  });
  assert.equal(blocked.status, "ready");
  assert.equal(blocked.checks.stopSafe, true);
  assert.ok(blocked.plannedTopUpUsd > 0);
  assert.ok(blocked.stopRisk.estimatedLiquidationPriceAfterTopUp + 0.5 < 90);
});

test("pre-entry top-up plan funds a stop below untopped liquidation and blocks when available USDT is insufficient", async () => {
  const funded = fixture({ availableMargin: "10.90" });
  const plan = await funded.api.preflight("BTCUSDT", {
    quantity: "1",
    entryPrice: "100",
    stopLoss: "90.4",
  });
  assert.equal(plan.status, "ready");
  assert.ok(plan.stopRisk.estimatedLiquidationPrice > 90.4,
    "unfunded liquidation estimate is above the stop");
  assert.ok(plan.plannedTopUpUsd > 0);
  assert.equal(plan.plannedTopUpUsd, plan.stopRisk.plannedTopUpUsd);
  assert.equal(plan.stopRisk.safe, true);
  assert.equal(plan.checks.stopSafe, true);
  assert.ok(plan.stopRisk.estimatedLiquidationPriceAfterTopUp + 0.5 < 90.4);
  assert.equal(plan.requiredTotalMargin, 10 + plan.plannedTopUpUsd);
  assert.equal(funded.calls.every(({ options }) => options.method === "GET"), true);

  const short = fixture({ availableMargin: "10.50" });
  const blocked = await short.api.preflight("BTCUSDT", {
    quantity: "1",
    entryPrice: "100",
    stopLoss: "90.4",
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.checks.initialMargin, false);
  assert.equal(blocked.checks.stopSafe, false);
});

test("initial 10x margin caps notional at $100 and malformed fees or prices fail closed", async () => {
  const oversized = await fixture().api.preflight("BTCUSDT", {
    quantity: "1.01",
    entryPrice: "100",
    stopLoss: "95",
  });
  assert.equal(oversized.status, "blocked");
  assert.equal(oversized.checks.notionalWithinInitialMargin, false);

  await assert.rejects(fixture({ feeData: {
    makerCommissionRate: "0.0002", takerCommissionRate: "",
  } }).api.preflight("BTCUSDT"), /invalid taker commission rate/);

  await assert.rejects(fixture().api.preflight("BTCUSDT", {
    quantity: "1",
    entryPrice: "1e2",
    stopLoss: "95",
  }), /plain decimal/);
});

test("unknown maintenance-tier response shape fails closed", async () => {
  const { api, calls } = fixture({
    permission: true,
    riskTierData: [{ symbol: "BTC-USDT", tier: 1 }],
  });
  await assert.rejects(api.preflight("BTCUSDT"), /risk tier data is incomplete/);
  assert.equal(calls.some(({ options }) => options.method !== "GET"), false);
});

test("stop reconciliation fails closed when order query has no attached stop", async () => {
  const { api, state } = fixture({ attachedStop: false });
  state.positions = [{ symbol: "BTC-USDT", positionAmt: "1", positionSide: "BOTH" }];
  const missing = await api.reconcilePositionAndStop("BTCUSDT", {
    expectedStopPrice: "95", orderId: 43,
  });
  assert.equal(missing.stopProtected, false);
  assert.equal(missing.stopEvidence, "unverified");
});

test("parent order echo is only configuration history, not proof of a live stop", async () => {
  const { api } = fixture({
    positions: [{ symbol: "BTC-USDT", positionAmt: "1", positionSide: "BOTH" }],
    openOrders: [],
  });
  const proof = await api.reconcilePositionAndStop("BTCUSDT", {
    expectedStopPrice: "95", orderId: 43,
  });
  assert.equal(proof.attachedConfigured, true);
  assert.equal(proof.stopProtected, false);
  assert.equal(proof.expectedStopMatches, false);
  assert.equal(proof.stopCount, 0);
  assert.equal(proof.stopPrice, null);
  assert.equal(proof.stopEvidence, "order_query_attached_stop_unverified");
});

test("only an identified active order matching position and stop verifies protection", async () => {
  const { api } = fixture({
    positions: [{ symbol: "BTC-USDT", positionAmt: "1", positionSide: "BOTH" }],
    openOrders: [{
      symbol: "BTC-USDT", orderId: 52, mainOrderId: 43,
      type: "STOP_MARKET", status: "NEW", side: "SELL", positionSide: "BOTH",
      origQty: "1", stopPrice: "95", closePosition: true, workingType: "MARK_PRICE",
    }],
  });
  const proof = await api.reconcilePositionAndStop("BTCUSDT", {
    orderId: 43, stopOrderId: 52, expectedStopPrice: "95", expectedQuantity: "1",
  });
  assert.equal(proof.stopProtected, true);
  assert.equal(proof.expectedStopMatches, true);
  assert.equal(proof.protectiveStopOrderId, "52");
  assert.equal(proof.stopEvidence, "active_open_protective_order");
  assert.equal(await api.canVerifyAttachedProtectionOnEntry(), false);
});

test("a fully matched active stop stays untouched because cancelReplace can lose protection", async () => {
  const stop = {
    symbol: "BTC-USDT", orderId: 52, mainOrderId: 43,
    type: "STOP_MARKET", status: "NEW", side: "SELL", positionSide: "BOTH",
    origQty: "1", stopPrice: "95", closePosition: true, workingType: "MARK_PRICE",
  };
  const { api, calls } = fixture({
    positions: [{ symbol: "BTC-USDT", positionAmt: "1", positionSide: "BOTH" }],
    openOrders: [stop],
  });
  const options = {
    stopOrderId: 52, entryOrderId: 43,
    expectedStopPrice: "95", expectedQuantity: "1", nextStopPrice: "100",
  };
  const first = await api.assessProtectiveStopAmendment("BTCUSDT", options);
  const repeated = await api.assessProtectiveStopAmendment("BTCUSDT", options);
  assert.deepEqual(first, {
    safeToAmend: false, reason: "replacement_could_leave_position_unprotected",
    existingStopVerified: true,
  });
  assert.deepEqual(repeated, first);
  assert.ok(calls.every(({ options: request }) => request.method === "GET"));
});

test("exact adjacent position identities cannot falsely match the protective stop", async () => {
  const { api, calls } = fixture({
    positions: [{
      symbol: "BTC-USDT", positionAmt: "1", positionSide: "BOTH",
      positionId: "9007199254740992",
    }],
    rawResponses: {
      "GET /openApi/swap/v2/trade/openOrders":
        '[{"symbol":"BTC-USDT","orderId":52,"mainOrderId":43,' +
        '"positionID":9007199254740993,"type":"STOP_MARKET","status":"NEW",' +
        '"side":"SELL","positionSide":"BOTH","origQty":"1","stopPrice":"95",' +
        '"closePosition":true,"workingType":"MARK_PRICE"}]',
    },
  });
  const result = await api.assessProtectiveStopAmendment("BTCUSDT", {
    stopOrderId: 52, entryOrderId: 43,
    expectedStopPrice: "95", expectedQuantity: "1", nextStopPrice: "100",
  });
  assert.deepEqual(result, {
    safeToAmend: false, reason: "protective_order_mismatch",
    existingStopVerified: false,
  });
  assert.ok(calls.every(({ options: request }) => request.method === "GET"));
});

test("raw adjacent parent and position IDs are distinct during protective-stop matching", async () => {
  const first = "9007199254740992";
  const second = "9007199254740993";
  const audit = async ({ parentId = second, stopPositionId = second } = {}) => {
    const { api } = fixture({
      rawResponses: {
        "GET /openApi/swap/v2/user/positions":
          `[{"symbol":"BTC-USDT","positionAmt":"1","positionSide":"BOTH","positionId":${second}}]`,
        "GET /openApi/swap/v2/trade/openOrders":
          `[{"symbol":"BTC-USDT","orderId":52,"mainOrderId":${parentId},` +
          `"positionID":${stopPositionId},"type":"STOP_MARKET","status":"NEW",` +
          `"side":"SELL","positionSide":"BOTH","origQty":"1","stopPrice":"95",` +
          `"closePosition":true,"workingType":"MARK_PRICE"}]`,
      },
    });
    return api.assessProtectiveStopAmendment("BTCUSDT", {
      stopOrderId: 52,
      entryOrderId: second,
      expectedStopPrice: "95",
      expectedQuantity: "1",
    });
  };

  assert.deepEqual(await audit({ parentId: first }), {
    safeToAmend: false, reason: "protective_order_mismatch", existingStopVerified: false,
  });
  assert.deepEqual(await audit({ stopPositionId: first }), {
    safeToAmend: false, reason: "protective_order_mismatch", existingStopVerified: false,
  });
  assert.deepEqual(await audit(), {
    safeToAmend: false,
    reason: "replacement_could_leave_position_unprotected",
    existingStopVerified: true,
  });
});

test("stop amendment audit blocks missing identity, vanished stop, conflicts, mismatched side and size", async () => {
  const base = {
    symbol: "BTC-USDT", orderId: 52, type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", origQty: "1", stopPrice: "95",
    closePosition: true, workingType: "MARK_PRICE",
  };
  const position = { symbol: "BTC-USDT", positionAmt: "1", positionSide: "LONG" };
  const options = {
    stopOrderId: 52, expectedStopPrice: "95",
    expectedQuantity: "1", nextStopPrice: "100",
  };
  const scenarios = [
    { openOrders: [], reason: "protective_order_missing" },
    { openOrders: [base], options: { ...options, stopOrderId: undefined },
      reason: "protective_order_identity_missing" },
    { openOrders: [base, { ...base, orderId: 53 }],
      reason: "conflicting_same_symbol_orders" },
    { openOrders: [{ ...base, positionSide: "SHORT" }],
      reason: "protective_order_mismatch" },
    { openOrders: [{ ...base, origQty: "0.5" }],
      reason: "protective_order_mismatch" },
    { openOrders: [{ ...base, stopPrice: "94" }],
      reason: "protective_order_mismatch" },
    { openOrders: [base], positions: [{ ...position, positionAmt: "0.5" }],
      reason: "position_size_mismatch" },
    { openOrders: [base], positions: [position, { ...position, positionSide: "SHORT" }],
      reason: "position_missing_or_ambiguous" },
  ];
  for (const scenario of scenarios) {
    const { api, calls } = fixture({
      dualSidePosition: true,
      positions: scenario.positions ?? [position],
      openOrders: scenario.openOrders,
    });
    const result = await api.assessProtectiveStopAmendment(
      "BTCUSDT", scenario.options ?? options,
    );
    assert.equal(result.reason, scenario.reason);
    assert.equal(result.existingStopVerified, false);
    assert.ok(calls.every(({ options: request }) => request.method === "GET"));
  }
});

test("partial-exit coverage audit proves an identified open full-position closePosition stop", async () => {
  const stopId = "9007199254740993";
  const base = {
    symbol: "BTC-USDT", orderId: 52, type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "BOTH", origQty: "0", stopPrice: "95.0",
    closePosition: true, workingType: "MARK_PRICE", mainOrderId: 43,
  };
  const audit = (options = {}) => {
    const { api, calls } = fixture({
      positions: [{ symbol: "BTC-USDT", positionAmt: "0.750", positionSide: "BOTH" }],
      rawResponses: {
        "GET /openApi/swap/v2/trade/openOrders": options.rawOrders ??
          `[${JSON.stringify({ ...base, orderId: stopId })}]`,
      },
      ...(options.openOrders ? { openOrders: options.openOrders } : {}),
    });
    return {
      result: api.auditProtectiveStopCoverage("BTCUSDT", {
        stopOrderId: Object.hasOwn(options, "stopOrderId") ? options.stopOrderId : stopId,
        expectedStopPrice: options.expectedStopPrice ?? "95",
        expectedQuantity: options.expectedQuantity ?? "0.75",
        ...(options.entryOrderId === undefined ? { entryOrderId: 43 } : {
          entryOrderId: options.entryOrderId,
        }),
      }),
      calls,
    };
  };

  const verified = await audit();
  assert.deepEqual(await verified.result, {
    verified: true,
    stopProtected: true,
    protectiveStopOrderId: stopId,
    closePosition: true,
    canCoverRemainingQuantity: true,
    remainingQuantity: "0.750",
    expectedStopPrice: "95",
    positionSide: "BOTH",
    entryOrderId: "43",
  });
  assert.ok(verified.calls.every(({ options: request }) => request.method === "GET"));

  const fixed = await audit({
    stopOrderId: 52,
    rawOrders: '[{"symbol":"BTC-USDT","orderId":52,"type":"STOP_MARKET",' +
      '"status":"NEW","side":"SELL","positionSide":"BOTH","origQty":"0.750",' +
      '"stopPrice":"95","closePosition":false,"workingType":"MARK_PRICE","mainOrderId":43}]',
  });
  assert.equal((await fixed.result).verified, true);
  assert.equal((await fixed.result).closePosition, false);
  assert.equal((await fixed.result).canCoverRemainingQuantity, true);

  for (const scenario of [
    { stopOrderId: undefined, reason: "protective_order_identity_missing" },
    { stopOrderId: "52", expectedQuantity: "0.7500001", reason: "position_size_mismatch" },
    { rawOrders: "[]", reason: "protective_order_missing" },
    {
      rawOrders: `[${JSON.stringify({ ...base, orderId: 52 })},` +
        `${JSON.stringify({ ...base, orderId: 53 })}]`,
      reason: "conflicting_same_symbol_orders",
    },
    {
      stopOrderId: 52,
      rawOrders: `[${JSON.stringify({ ...base, orderId: 52, closePosition: false, origQty: "0.749999" })}]`,
      reason: "protective_order_mismatch",
    },
    {
      stopOrderId: 52,
      rawOrders: `[${JSON.stringify({ ...base, orderId: 52, workingType: "CONTRACT_PRICE" })}]`,
      reason: "protective_order_mismatch",
    },
    {
      stopOrderId: 52,
      rawOrders: `[${JSON.stringify({ ...base, orderId: 52, side: "BUY" })}]`,
      reason: "protective_order_mismatch",
    },
    {
      stopOrderId: 52,
      rawOrders: `[${JSON.stringify({ ...base, orderId: 52, stopPrice: "95.00000000000001" })}]`,
      reason: "protective_order_mismatch",
    },
    {
      stopOrderId: 52,
      rawOrders: `[${JSON.stringify({ ...base, orderId: 52, mainOrderId: 44 })}]`,
      entryOrderId: 43,
      reason: "protective_order_mismatch",
    },
    {
      rawOrders: `[${JSON.stringify({ ...base, orderId: 52, orderID: 53 })}]`,
      stopOrderId: 53,
      reason: "protective_order_identity_invalid",
    },
  ]) {
    const checked = await audit(scenario);
    const result = await checked.result;
    assert.equal(result.verified, false, scenario.reason);
    assert.equal(result.canCoverRemainingQuantity, false, scenario.reason);
    assert.equal(result.reason, scenario.reason);
    assert.ok(checked.calls.every(({ options: request }) => request.method === "GET"));
  }
});

test("coverage audit fails closed for absent or ambiguous order identifiers and exact numeric mismatches", async () => {
  const { api: noIdApi, calls: noIdCalls } = fixture({
    positions: [{ symbol: "BTC-USDT", positionAmt: "1", positionSide: "BOTH" }],
  });
  const noId = await noIdApi.auditProtectiveStopCoverage("BTCUSDT", {
    expectedStopPrice: "95", expectedQuantity: "1",
  });
  assert.equal(noId.reason, "protective_order_identity_missing");
  assert.equal(noIdCalls.length, 0);

  const unsafeId = "9007199254740993";
  const base = {
    symbol: "BTC-USDT", orderId: unsafeId, type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "BOTH", origQty: "1", stopPrice: "95",
    closePosition: false, workingType: "MARK_PRICE",
  };
  const response = await fixture({
    positions: [{ symbol: "BTC-USDT", positionAmt: "1.0000000000000001", positionSide: "BOTH" }],
    rawResponses: {
      "GET /openApi/swap/v2/trade/openOrders":
        `[{"symbol":"BTC-USDT","orderId":${unsafeId},"type":"STOP_MARKET","status":"NEW",` +
        '"side":"SELL","positionSide":"BOTH","origQty":"1","stopPrice":"95",' +
        '"closePosition":false,"workingType":"MARK_PRICE"}]',
    },
  });
  const precisionMismatch = await response.api.auditProtectiveStopCoverage("BTCUSDT", {
    stopOrderId: unsafeId, expectedStopPrice: "95", expectedQuantity: "1.0000000000000001",
  });
  assert.equal(precisionMismatch.verified, false);
  assert.equal(precisionMismatch.reason, "protective_order_mismatch");

  const ambiguous = fixture({
    positions: [{ symbol: "BTC-USDT", positionAmt: "1", positionSide: "BOTH" }],
    openOrders: [base, { ...base }],
  });
  const ambiguousResult = await ambiguous.api.auditProtectiveStopCoverage("BTCUSDT", {
    stopOrderId: unsafeId, expectedStopPrice: "95", expectedQuantity: "1",
  });
  assert.equal(ambiguousResult.verified, false);
  assert.equal(ambiguousResult.reason, "conflicting_same_symbol_orders");

  const missingExchangeId = fixture({
    positions: [{ symbol: "BTC-USDT", positionAmt: "1", positionSide: "BOTH" }],
    rawResponses: {
      "GET /openApi/swap/v2/trade/openOrders":
        '[{"symbol":"BTC-USDT","type":"STOP_MARKET","status":"NEW","side":"SELL",' +
        '"positionSide":"BOTH","origQty":"1","stopPrice":"95","closePosition":true,' +
        '"workingType":"MARK_PRICE"}]',
    },
  });
  await assert.rejects(missingExchangeId.api.auditProtectiveStopCoverage("BTCUSDT", {
    stopOrderId: 52, expectedStopPrice: "95", expectedQuantity: "1",
  }), /invalid open orders data/);
  assert.ok(missingExchangeId.calls.every(({ options: request }) => request.method === "GET"));
});

test("a timed-out protection read never submits or retries a trading operation", async () => {
  const { api, calls } = fixture({
    dualSidePosition: true,
    positions: [{ symbol: "BTC-USDT", positionAmt: "1", positionSide: "LONG" }],
    openOrdersError: new Error("timeout"),
  });
  await assert.rejects(api.assessProtectiveStopAmendment("BTCUSDT", {
    stopOrderId: 52, expectedStopPrice: "95",
    expectedQuantity: "1", nextStopPrice: "100",
  }), /read request failed/);
  assert.ok(calls.every(({ options }) => options.method === "GET"));
});

test("order/fill reads, unverified attached-stop echo, margin add, and reduce-only exit", async () => {
  const { api, calls, state } = fixture({ permission: true });
  assert.equal((await api.queryOrder("BTCUSDT", 43)).orderId, 43);
  assert.equal((await api.queryOrder("BTCUSDT", { clientOrderId: "signal-123" })).orderId, 43);
  const fills = await api.queryFills("BTCUSDT", {
    startTs: 1699999999000,
    endTs: 1700000000000,
    orderId: 43,
    currency: "USDT",
  });
  assert.equal(fills.length, 1);
  const fillCall = calls.find(({ url }) => url.pathname.endsWith("/allFillOrders"));
  assert.equal(fillCall.url.searchParams.get("tradingUnit"), "COIN");
  assert.equal(fillCall.url.searchParams.get("startTs"), "1699999999000");
  assert.equal(fillCall.url.searchParams.get("endTs"), "1700000000000");
  assert.equal(fillCall.url.searchParams.get("orderId"), "43");
  assert.equal(fillCall.url.searchParams.get("currency"), "USDT");
  state.positions = [{ symbol: "BTC-USDT", positionAmt: "1", positionSide: "BOTH" }];
  const unverified = await api.reconcilePositionAndStop("BTCUSDT");
  assert.equal(unverified.stopProtected, false);
  const reconciled = await api.reconcilePositionAndStop("BTCUSDT", {
    expectedStopPrice: "95", orderId: 43,
  });
  assert.equal(reconciled.positionOpen, true);
  assert.equal(reconciled.stopProtected, false);
  assert.equal(reconciled.stopCount, 0);
  assert.equal(reconciled.attachedConfigured, true);

  await api.addIsolatedMargin("BTCUSDT", "2.5", "margin-signal-1");
  await assert.rejects(
    api.addIsolatedMargin("BTCUSDT", "2.5", "margin-signal-1"),
    /already submitted/,
  );
  await api.closeLong("BTCUSDT", "0.5");
  const writes = calls.filter(({ options }) => options.method === "POST");
  const margin = writes.find(({ url }) => url.pathname.endsWith("/positionMargin"));
  assert.equal(margin.url.searchParams.get("type"), "1");
  assert.equal(margin.url.searchParams.get("positionSide"), null);
  assert.equal(margin.url.searchParams.get("side"), null);
  const close = writes.find(({ url }) =>
    url.pathname.endsWith("/trade/order") &&
    url.searchParams.get("side") === "SELL");
  assert.equal(close.url.searchParams.get("reduceOnly"), "true");
  assert.equal(close.url.searchParams.get("positionSide"), "BOTH");
  assert.equal(writes.some(({ url }) => url.pathname.endsWith("/marginType") ||
    url.pathname.endsWith("/leverage")), false);
});

test("VST hedge margin add signs exact BTC LONG parameters without a remote operation ID", async () => {
  const { api, calls } = fixture({
    environment: "vst",
    permission: true,
    dualSidePosition: true,
    positions: [{
      symbol: "BTC-USDT", positionAmt: "0.0006", positionSide: "LONG",
    }],
  });
  await api.addIsolatedMargin("BTCUSDT", "2", "vmt_local-reservation");
  const request = calls.find(({ url, options }) =>
    options.method === "POST" && url.pathname.endsWith("/positionMargin"));
  assert.ok(request);
  assert.equal(request.url.searchParams.get("symbol"), "BTC-USDT");
  assert.equal(request.url.searchParams.get("amount"), "2");
  assert.equal(request.url.searchParams.get("type"), "1");
  assert.equal(request.url.searchParams.get("positionSide"), "LONG");
  assert.equal(request.url.searchParams.has("side"), false);
  assert.equal(request.url.searchParams.has("clientOperationID"), false);
  assert.deepEqual(
    [...request.url.searchParams.keys()].sort(),
    ["amount", "positionSide", "recvWindow", "signature", "symbol", "timestamp", "type"],
  );
});

test("closeLong sends stable optional client IDs and prevents duplicate close submissions", async () => {
  const { api, calls } = fixture({
    permission: true,
    positions: [{ symbol: "BTC-USDT", positionAmt: "1", positionSide: "BOTH" }],
  });
  await api.closeLong("BTCUSDT", "0.5", "exit-signal-1");
  await assert.rejects(api.closeLong("BTCUSDT", "0.5", "exit-signal-1"), /already submitted/);
  const close = calls.find(({ url, options }) =>
    url.pathname.endsWith("/trade/order") && options.method === "POST");
  assert.equal(close.url.searchParams.get("clientOrderId"), "exit-signal-1");
  assert.equal(close.url.searchParams.get("reduceOnly"), "true");
});

test("hedge close requires one verified LONG position and does not submit on ambiguous exposure", async () => {
  for (const positions of [
    [],
    [{ symbol: "BTC-USDT", positionAmt: "1", positionSide: "BOTH" }],
    [
      { symbol: "BTC-USDT", positionAmt: "1", positionSide: "LONG" },
      { symbol: "BTC-USDT", positionAmt: "1", positionSide: "LONG" },
    ],
  ]) {
    const { api, calls } = fixture({
      permission: true, dualSidePosition: true, positions,
    });
    await assert.rejects(api.closeLong("BTCUSDT", "0.5"), /No unambiguous long exposure/);
    assert.equal(calls.some(({ options }) => options.method === "POST"), false);
  }
});

test("fills require documented query fields and reject unexpected response shapes", async () => {
  const valid = fixture();
  await assert.rejects(valid.api.queryFills("BTCUSDT", {
    startTs: 1700000000000,
    endTs: 1699999999000,
    currency: "USDT",
  }), /ordered millisecond timestamps/);
  const invalid = fixture({ invalidFills: true }).api;
  await assert.rejects(invalid.queryFills("BTCUSDT", {
    startTs: 1699999999000,
    endTs: 1700000000000,
    currency: "USDT",
  }), /invalid fill list/);
});

test("an undocumented exchange error code carries BingX's own message instead of just the bare code", async () => {
  const api = createBingXLiveApi({
    environment: "mainnet",
    fetchImpl: async () => new Response(
      JSON.stringify({ code: 109418, msg: "some未曾記錄的 rejection text", data: null }),
      { status: 200 },
    ),
    clock: () => 1700000000000,
    sleep: async () => {},
    credentials: () => ({ key: "mock-key", secret: "mock-secret" }),
    writePermission: async () => false,
  });
  await assert.rejects(
    api.contract("BTCUSDT"),
    (error) => {
      assert.equal(error.code, 109418);
      assert.equal(error.exchangeMessage, "some未曾記錄的 rejection text");
      assert.match(error.message, /code 109418, msg: some未曾記錄的 rejection text/);
      return true;
    },
  );
});

test("currency-wide fill history excludes other symbols and unrelated order IDs", async () => {
  const { api } = fixture({
    fillData: [
      { symbol: "ETH-USDT", orderId: 12, qty: "1", price: "100" },
      { symbol: "BTC-USDT", orderId: 43, qty: "1", price: "100" },
      { symbol: "BTC-USDT", orderId: 44, qty: "2", price: "99" },
    ],
  });
  const query = { startTs: 1699999999000, endTs: 1700000000000, currency: "USDT" };
  assert.deepEqual((await api.queryFills("BTCUSDT", { ...query, orderId: 43 }))
    .map((fill) => fill.orderId), [43]);
  assert.deepEqual((await api.queryFills("BTCUSDT", query))
    .map((fill) => fill.orderId), [43, 44]);
});