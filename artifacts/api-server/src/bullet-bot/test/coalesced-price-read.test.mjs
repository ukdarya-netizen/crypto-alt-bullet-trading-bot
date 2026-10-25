import test from "node:test";
import assert from "node:assert/strict";
import { createCoalescedPriceRead } from "../coalesced-price-read.mjs";
import { createBingXLiveApi } from "../bingx-live-api.mjs";

test("concurrent public price consumers share only the running request", async () => {
  let now = 10_000;
  let reads = 0;
  let release;
  const read = createCoalescedPriceRead({
    clock: () => now, sleep: async ms => { now += ms; }, minGapMs: 2_000,
    read: () => { reads++; return new Promise(resolve => { release = resolve; }); },
  });
  const first = read();
  const joined = read();
  assert.equal(first, joined);
  await Promise.resolve();
  assert.equal(reads, 1);
  release([{ timestamp: now, price: 100 }]);
  await first;
  now += 2_000;
  const next = read();
  assert.notEqual(first, next, "completed market data must not become a cache");
  await Promise.resolve();
  assert.equal(reads, 2);
  release([]);
  await next;
});

test("a read inside the public price floor waits instead of becoming a transport error", async () => {
  let now = 10_000;
  const starts = [];
  const read = createCoalescedPriceRead({
    clock: () => now, sleep: async ms => { now += ms; }, minGapMs: 2_000,
    read: async () => { starts.push(now); return []; },
  });
  await read();
  now += 500;
  await read();
  assert.deepEqual(starts, [10_000, 12_000]);
});

test("failed public reads release single-flight state without returning old quotes", async () => {
  let now = 10_000;
  let reads = 0;
  const read = createCoalescedPriceRead({
    clock: () => now, sleep: async ms => { now += ms; }, minGapMs: 2_000,
    read: async () => { if (++reads === 1) throw Error("provider down"); return []; },
  });
  await assert.rejects(read(), /provider down/);
  assert.deepEqual(await read(), []);
  assert.equal(reads, 2);
  assert.equal(now, 12_000);
  now = 1;
  await assert.rejects(read(), /clock moved backwards/);
});

test("native bulk quotes join requests but still reject stale/missing provider time and mainnet", async () => {
  let now = 1_800_000_000_000;
  let requests = 0;
  const api = createBingXLiveApi({
    environment: "vst", clock: () => now, sleep: async ms => { now += ms; },
    fetchImpl: async (_url, options) => {
      assert.equal(options.method, "GET");
      requests++;
      return new Response(JSON.stringify({ code: 0, data: [
        { symbol: "BTC-USDT", lastPrice: "105", time: now },
        { symbol: "ETH-USDT", lastPrice: "205", time: now },
        { symbol: "BABY-USDT", lastPrice: "1", time: now - 10_001 },
        { symbol: "WOO-USDT", lastPrice: "1" },
      ] }));
    },
  });
  const [btc, eth] = await Promise.all([
    api.getVstLastPrices(["BTCUSDT", "BABYUSDT", "WOOUSDT"]),
    api.getVstLastPrices(["ETHUSDT"]),
  ]);
  assert.equal(requests, 1);
  assert.deepEqual(btc.map(row => row.symbol), ["BTC-USDT"]);
  assert.deepEqual(eth.map(row => row.symbol), ["ETH-USDT"]);
  await api.getVstLastPrices(["BTCUSDT"]);
  assert.equal(requests, 2);
  await assert.rejects(createBingXLiveApi({ environment: "mainnet" })
    .getVstLastPrices(["BTCUSDT"]), /outside VST/);
});
