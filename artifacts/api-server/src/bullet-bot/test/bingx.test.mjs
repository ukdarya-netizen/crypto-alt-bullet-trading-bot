import assert from "node:assert/strict";
import { test } from "node:test";
import { BingXApiError, createBingX } from "../bingx.mjs";

const contract = {
  symbol: "BTC-USDT", status: 1, currency: "USDT",
  apiStateOpen: "true", quantityPrecision: 4, pricePrecision: 1,
  tradeMinQuantity: 0.0001, tradeMinUSDT: 2,
};
const ticker = {
  symbol: "BTC-USDT", lastPrice: "83935.0", askPrice: "83951.3",
  bidPrice: "83951.1", closeTime: 1790352232000,
};
const signal = {
  symbol: "BTCUSDT", quantity: "0.00119425",
  referencePrice: "83734.5", stopLoss: "82897.2",
};

function fixture({ marketContract = contract, marketTicker = ticker, httpStatus = 200, code = 0 } = {}) {
  let now = 1790352232000;
  const calls = [];
  const sleeps = [];
  const api = createBingX({
    clock: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
    fetchImpl: async (url) => {
      calls.push(new URL(url));
      return new Response(JSON.stringify({
        code, msg: "", data: url.pathname.endsWith("contracts")
          ? [marketContract] : marketTicker,
      }), { status: httpStatus });
    },
  });
  return { api, calls, sleeps, advance: (ms) => { now += ms; } };
}

test("maps Bullet symbols to BingX, validates the contract and rounds quantity down", async () => {
  const { api, calls, sleeps } = fixture();
  const result = await api.validateOrder(signal);
  assert.equal(result.quantity, "0.0011");
  assert.equal(result.stopLoss, "82897.2");
  assert.equal(result.minNotional, 2);
  assert.equal(api.capQuantity(result, "84000"), "0.0011");
  const quote = await api.ticker("BTCUSDT");
  assert.deepEqual(quote, {
    symbol: "BTCUSDT", lastPrice: "83935.0",
    ask1Price: "83951.3", bid1Price: "83951.1",
    quoteAt: new Date(ticker.closeTime).toISOString(),
  });
  assert.deepEqual(calls.map((url) => url.pathname), [
    "/openApi/swap/v2/quote/contracts", "/openApi/swap/v2/quote/ticker",
  ]);
  assert.equal(calls[0].searchParams.get("symbol"), "BTC-USDT");
  assert.ok(calls.every((url) => url.searchParams.has("timestamp")));
  assert.deepEqual(sleeps, [1100]);
  await api.instrument("BTCUSDT");
  assert.equal(calls.length, 2, "metadata is cached, but ticker prices are not");
});

test("rejects missing/closed contracts and unsuitable sizes; tightens an unaligned long stop", async () => {
  const a = fixture({ marketContract: { ...contract, apiStateOpen: "false" } });
  await assert.rejects(a.api.validateOrder(signal), /not an active/);
  const b = fixture();
  await assert.rejects(b.api.validateOrder({ ...signal, quantity: "0.0000999" }), /below minimum/);
  assert.equal((await b.api.validateOrder({ ...signal, stopLoss: "82897.23" })).stopLoss, "82897.3");
  await assert.rejects(b.api.validateOrder({
    ...signal, stopLoss: "83734.48",
  }), /stop would not be below entry/);
  await assert.rejects(b.api.validateOrder({ ...signal, quantity: "2e-4" }), /plain decimal/);
});

test("normalizes the received TAO-sized PAPER order to BingX precision without extra risk", async () => {
  const api = fixture({ marketContract: {
    ...contract, symbol: "TAO-USDT", quantityPrecision: 5, pricePrecision: 2,
    tradeMinQuantity: 0.00655,
  } }).api;
  const result = await api.validateOrder({
    symbol: "TAOUSDT", quantity: "0.32946758",
    referencePrice: "303.52", stopLoss: "273.168",
  });
  assert.equal(result.quantity, "0.32946");
  assert.equal(result.stopLoss, "273.17");
  const reduced = api.capQuantity(result, "305");
  assert.ok(Number(reduced) <= Number(result.quantity));
  assert.ok(Number(reduced) * 305 <= 100);
  assert.ok(/^\d+\.\d{1,5}$/.test(reduced));
});

test("rejects a stale quote and a nonzero BingX API code without falling back to another feed", async () => {
  const stale = fixture({ marketTicker: { ...ticker, closeTime: ticker.closeTime - 90_000 } });
  await assert.rejects(stale.api.ticker("BTCUSDT"), /stale/);
  const failed = fixture({ code: 100400 });
  await assert.rejects(failed.api.instrument("BTCUSDT"), (error) =>
    error instanceof BingXApiError && error.code === 100400);
  const blocked = fixture({ httpStatus: 403 });
  await assert.rejects(blocked.api.ticker("BTCUSDT"), (error) =>
    error instanceof BingXApiError && error.httpStatus === 403);
});

test("validates timestamped public mark, signed funding history and historical closes", async () => {
  let now = 1790352232000;
  const calls = [];
  const rows = {
    "/openApi/swap/v2/quote/premiumIndex": [{
      symbol: "BTC-USDT",
      markPrice: "83920.25",
      indexPrice: "83917.5",
      lastFundingRate: "-0.0001",
      nextFundingTime: 1790380800000,
      fundingIntervalHours: 8,
    }],
    "/openApi/swap/v2/quote/fundingRate": [
      {
        symbol: "BTC-USDT", fundingRate: "-0.0001",
        fundingTime: 1790000000000, markPrice: "84057.9",
      },
      {
        symbol: "BTC-USDT", fundingRate: "0.0002",
        fundingTime: 1790100000000, markPrice: "84057.9",
      },
    ],
    "/openApi/swap/v2/quote/klines": [
      { time: 1790000000000, close: "83912.2" },
    ],
  };
  const api = createBingX({
    clock: () => now,
    sleep: async (ms) => { now += ms; },
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      calls.push(parsed);
      return new Response(JSON.stringify({
        code: 0,
        data: rows[parsed.pathname],
      }));
    },
  });

  const mark = await api.premiumIndex("BTCUSDT");
  assert.deepEqual(mark, {
    symbol: "BTCUSDT",
    markPrice: "83920.25",
    indexPrice: "83917.5",
    lastFundingRate: "-0.0001",
    nextFundingTime: 1790380800000,
    fundingIntervalHours: 8,
    observedAt: new Date(now).toISOString(),
    source: "BingX public swap premiumIndex",
  });
  const history = await api.fundingHistory("BTCUSDT", {
    startTime: 1790000000000,
    endTime: 1790100000000,
    limit: 20,
  });
  assert.deepEqual(history, [
    {
      symbol: "BTCUSDT",
      fundingRate: "-0.0001",
      fundingTime: 1790000000000,
      markPrice: "84057.9",
    },
    {
      symbol: "BTCUSDT",
      fundingRate: "0.0002",
      fundingTime: 1790100000000,
      markPrice: "84057.9",
    },
  ]);
  const klines = await api.historicalKlines("BTCUSDT", {
    startTime: 1790000000000,
    endTime: 1790000060000,
    limit: 10,
  });
  assert.equal(klines[0].close, "83912.2");
  assert.equal(klines[0].source, "BingX public 1m last-trade kline close");
  assert.deepEqual(calls.map((url) => url.pathname), [
    "/openApi/swap/v2/quote/premiumIndex",
    "/openApi/swap/v2/quote/fundingRate",
    "/openApi/swap/v2/quote/klines",
  ]);
  assert.ok(calls.every((url) => url.searchParams.get("symbol") === "BTC-USDT"));
  assert.equal(calls[1].searchParams.get("startTime"), "1790000000000");
  assert.equal(calls[1].searchParams.get("endTime"), "1790100000000");
  assert.equal(calls[1].searchParams.get("limit"), "20");
  assert.equal(calls[2].searchParams.get("interval"), "1m");
  assert.deepEqual([calls[1], calls[2]].map((url) => url.searchParams.get("timestamp")), [
    String(now - 1100),
    String(now),
  ]);
});

test("rejects malformed mark, funding rates, history bounds, and kline timestamps", async () => {
  let now = 1790352232000;
  let responseData = [{
    symbol: "BTC-USDT",
    markPrice: "83920.25",
    indexPrice: "83917.5",
    lastFundingRate: "NaN",
    nextFundingTime: 1790380800000,
  }];
  const api = createBingX({
    clock: () => now,
    sleep: async (ms) => { now += ms; },
    fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: responseData })),
  });
  await assert.rejects(api.premiumIndex("BTCUSDT"), /invalid premium index/);
  await assert.rejects(api.fundingHistory("BTCUSDT", {
    startTime: 5, endTime: 5, limit: 1000,
  }), /valid millisecond bounds/);
  await assert.rejects(api.historicalKlines("BTCUSDT", {
    startTime: 1, endTime: 2, limit: 101,
  }), /limit 1\.\.100/);

  responseData = [{ symbol: "BTC-USDT", fundingRate: "not-a-rate", fundingTime: 1790000000000 }];
  await assert.rejects(api.fundingHistory("BTCUSDT", {
    startTime: 1790000000000, endTime: 1790000000001, limit: 5,
  }), /invalid funding history/);
  responseData = [{
    symbol: "BTC-USDT",
    markPrice: "83920.25",
    indexPrice: "83917.5",
    lastFundingRate: "0.0001",
    nextFundingTime: 1790380800000,
    fundingIntervalHours: "8",
  }];
  const markWithoutValidCadence = await api.premiumIndex("BTCUSDT");
  assert.equal(markWithoutValidCadence.fundingIntervalHours, null);
  responseData = [{
    symbol: "BTC-USDT", fundingRate: "0.0001",
    fundingTime: 1790000000000, markPrice: "not-a-price",
  }];
  const historyWithoutValidMark = await api.fundingHistory("BTCUSDT", {
    startTime: 1790000000000, endTime: 1790000000001, limit: 5,
  });
  assert.equal(historyWithoutValidMark[0].markPrice, null);
});

test("serializes premium and funding-history requests through the public 1.1s limiter", async () => {
  let now = 1790352232000;
  const fetchTimes = [];
  const api = createBingX({
    clock: () => now,
    sleep: async (ms) => { now += ms; },
    fetchImpl: async (url) => {
      fetchTimes.push(now);
      const isMark = new URL(url).pathname.endsWith("premiumIndex");
      return new Response(JSON.stringify({
        code: 0,
        data: isMark
          ? [{
            symbol: "BTC-USDT", markPrice: "100", indexPrice: "100",
            lastFundingRate: "0.0001", nextFundingTime: now + 1000,
          }]
          : [],
      }));
    },
  });
  await Promise.all([
    api.premiumIndex("BTCUSDT"),
    api.fundingHistory("BTCUSDT", { startTime: now - 1000, endTime: now, limit: 1 }),
  ]);
  assert.equal(fetchTimes.length, 2);
  assert.ok(Math.abs(fetchTimes[0] - fetchTimes[1]) >= 1100);
});