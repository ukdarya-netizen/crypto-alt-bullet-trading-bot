import assert from "node:assert/strict";
import test from "node:test";
import { createVstBroker } from "../vst-broker.mjs";
import { createBingXOutboundPacer } from "../bingx-live-api.mjs";

const initialTime = 1_700_000_000_000;

function capabilityFixture({
  paced = false, failBalanceOnce = false, settingsReadDelayMs = 0,
  quoteResponseDelayMs = 0,
} = {}) {
  let now = initialTime;
  let balanceFailures = failBalanceOnce ? 1 : 0;
  let longLeverage = 10;
  let concurrentSettingsReads = 0;
  let maxConcurrentSettingsReads = 0;
  let positions = [];
  let orders = [];
  const calls = [];
  const pacer = paced
    ? createBingXOutboundPacer({
      gapMs: 1_100,
      clock: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    })
    : null;
  const read = (name, callback) => async (...args) => {
    const startedAt = pacer ? await pacer.waitForSlot() : now;
    calls.push({ name, args, startedAt });
    return callback(...args, startedAt);
  };
  const api = {
    getVstMarkPrice: read("mark", async (symbol, startedAt) => {
      if (quoteResponseDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        now += quoteResponseDelayMs;
      }
      return {
        symbol: `${symbol.slice(0, -4)}-USDT`,
        markPrice: "100",
        timestamp: startedAt,
      };
    }),
    getBalance: read("balance", async () => {
      if (balanceFailures > 0) {
        balanceFailures -= 1;
        throw new Error("balance read rejected");
      }
      return [{ asset: "VST", balance: "1000", availableMargin: "1000" }];
    }),
    getPositions: read("positions", async () => positions),
    getOpenOrders: read("openOrders", async () => orders),
    getPositionMode: read("positionMode", async () => "HEDGE"),
    getMarginType: read("marginType", async () => {
      concurrentSettingsReads += 1;
      maxConcurrentSettingsReads = Math.max(
        maxConcurrentSettingsReads, concurrentSettingsReads,
      );
      try {
        if (settingsReadDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, settingsReadDelayMs));
        }
        return "ISOLATED";
      } finally {
        concurrentSettingsReads -= 1;
      }
    }),
    getLeverage: read("leverage", async () => ({
      longLeverage, shortLeverage: 3, maxPositionLongVal: 1_000_000,
    })),
    contract: read("contract", async (symbol) => ({
      symbol: `${symbol.slice(0, -4)}-USDT`, quantityPrecision: 4,
      pricePrecision: 1, minQuantity: 0.001, minNotional: 5, maxLeverage: 10,
    })),
    getRiskTiers: read("riskTiers", async () => [
      { maxNotional: 100_000, maintenanceMarginRate: 0.005 },
    ]),
    getFeeRate: read("feeRate", async () => ({ maker: 0.0002, taker: 0.0005 })),
    getFunding: read("funding", async () => ({ rate: 0, nextFundingTime: now + 60_000 })),
    queryOrder: read("queryOrder", async () => null),
    queryOrderHistory: read("history", async () => []),
    queryFills: read("fills", async () => []),
    setVstLongLeverage10: async () => {},
    placeVstAutomatedLong: async () => {},
    upgradeVstLongStop: async () => {},
    closeLong: async () => {},
  };
  const broker = createVstBroker({
    api,
    accountId: "test-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => now,
    stopBufferRate: 0.005,
  });
  return {
    broker,
    calls,
    api,
    get now() { return now; },
    get maxConcurrentSettingsReads() { return maxConcurrentSettingsReads; },
    setAccountState(nextPositions, nextOrders = []) {
      positions = nextPositions;
      orders = nextOrders;
    },
    setNow(next) { now = next; },
    setLongLeverage(next) { longLeverage = next; },
  };
}

test("lookup support reuse never caches current account exposure or settings and expires", async () => {
  const f = capabilityFixture();
  await f.broker.getCapabilities();
  const count = (name) => f.calls.filter((call) => call.name === name).length;
  assert.equal(count("history"), 1);
  assert.equal(count("fills"), 1);
  await f.broker.getCapabilities();
  assert.equal(count("history"), 1);
  assert.equal(count("fills"), 1);
  for (const name of ["balance", "positions", "openOrders",
    "positionMode", "marginType", "leverage"]) {
    assert.equal(count(name), 2, `${name} must remain a new native read`);
  }
  f.setNow(initialTime + 180_000);
  await f.broker.getCapabilities();
  assert.equal(count("history"), 2);
  assert.equal(count("fills"), 2);
  f.setNow(initialTime);
  await f.broker.getCapabilities();
  assert.equal(count("history"), 3, "clock rollback cannot keep a protocol probe alive");
});

test("a failed account read invalidates reusable lookup support rather than hiding the error", async () => {
  const f = capabilityFixture();
  await f.broker.getCapabilities();
  f.api.getBalance = async () => { throw new Error("account read unavailable"); };
  await assert.rejects(f.broker.getCapabilities(), /account read unavailable/);
  f.api.getBalance = async () => [{ asset: "VST", balance: "1000", availableMargin: "1000" }];
  await f.broker.getCapabilities();
  assert.equal(f.calls.filter(({ name }) => name === "history").length, 2);
});

test("simultaneous identical capability reads coalesce only in flight and preserve native pacing", async () => {
  const fixture = capabilityFixture({ paced: true });
  const [first, simultaneous] = await Promise.all([
    fixture.broker.getCapabilities(),
    fixture.broker.getCapabilities(),
  ]);

  assert.equal(first.verified, true);
  assert.equal(simultaneous.verified, true);
  assert.equal(fixture.calls.filter(({ name }) => name === "positions").length, 1);
  assert.equal(fixture.calls.filter(({ name }) => name === "openOrders").length, 1);
  assert.equal(fixture.calls.filter(({ name }) => name === "balance").length, 1);
  assert.equal(fixture.calls.length, 8);
  const starts = fixture.calls.map(({ startedAt }) => startedAt).sort((a, b) => a - b);
  for (let index = 1; index < starts.length; index += 1) {
    assert.ok(starts[index] - starts[index - 1] >= 1_100);
  }
  assert.ok(fixture.now > initialTime);

  const later = await fixture.broker.getCapabilities();
  assert.equal(later.verified, true);
  assert.equal(fixture.calls.filter(({ name }) => name === "positions").length, 2);
  assert.equal(fixture.calls.filter(({ name }) => name === "openOrders").length, 2);
  assert.equal(fixture.calls.filter(({ name }) => name === "balance").length, 2);
  assert.equal(fixture.calls.length, 14,
    "the later pass reuses protocol support only, not current account reads");
});

test("rejected in-flight reads are removed and never become a positive cache entry", async () => {
  const fixture = capabilityFixture({ failBalanceOnce: true });
  const results = await Promise.allSettled([
    fixture.broker.getCapabilities(),
    fixture.broker.getCapabilities(),
  ]);
  assert.deepEqual(results.map(({ status }) => status), ["rejected", "rejected"]);
  assert.equal(fixture.calls.filter(({ name }) => name === "balance").length, 1);

  const recovered = await fixture.broker.getCapabilities();
  assert.equal(recovered.verified, true);
  assert.equal(fixture.calls.filter(({ name }) => name === "balance").length, 2);
});

test("capability symbol reads are bounded while covering every active symbol", async () => {
  const fixture = capabilityFixture({ settingsReadDelayMs: 5 });
  fixture.setAccountState(["BTC", "ETH", "SOL", "XRP", "ADA"].map((coin) => ({
    symbol: `${coin}-USDT`, positionSide: "LONG", positionAmt: "0.1",
    avgPrice: "100", positionId: `position-${coin}`,
  })));

  const capabilities = await fixture.broker.getCapabilities();

  assert.equal(capabilities.verified, true);
  assert.equal(fixture.calls.filter(({ name }) => name === "marginType").length, 5);
  assert.equal(fixture.calls.filter(({ name }) => name === "leverage").length, 5);
  assert.ok(fixture.maxConcurrentSettingsReads <= 3);
});

test("three paced planning producers defer balance and raw quotes until metadata is finished", async () => {
  const fixture = capabilityFixture({ paced: true });
  const beganAt = fixture.now;
  const inputs = await Promise.all(["BTCUSDT", "ETHUSDT", "SOLUSDT"].map((symbol) =>
    fixture.broker.readPlanningInputs({ symbol })));

  const priceCalls = fixture.calls.filter(({ name }) => name === "mark");
  const nonPriceCalls = fixture.calls.filter(({ name }) =>
    ["contract", "feeRate", "funding", "riskTiers", "positionMode",
      "marginType", "leverage"].includes(name));
  assert.equal(priceCalls.length, 3);
  assert.equal(nonPriceCalls.length, 19);
  assert.ok(Math.max(...nonPriceCalls.map(({ startedAt }) => startedAt)) <=
    Math.min(...priceCalls.map(({ startedAt }) => startedAt)));
  assert.ok(inputs.every((input) =>
    input.quote.price === 100 &&
    input.risk.takerFeeRate > 0 &&
    input.risk.maintenanceMarginRate > 0));
  assert.ok(inputs.every((input) => fixture.now - input.quote.observedAtMs <= 10_000));
  assert.ok(fixture.calls.filter(({ name }) => name === "balance").length <= 3);
  assert.ok(fixture.now - beganAt <= 25_300);
});

test("a genuinely delayed last-stage quote still fails the unchanged freshness limit", async () => {
  const fixture = capabilityFixture({
    paced: true,
    quoteResponseDelayMs: 10_001,
  });
  await assert.rejects(
    fixture.broker.readPlanningInputs({ symbol: "BTCUSDT" }),
    /bingx_vst_quote_stale_or_invalid/,
  );
  assert.equal(fixture.calls.filter(({ name }) => name === "mark").length, 1);
  assert.ok(fixture.calls.find(({ name }) => name === "mark").startedAt >
    Math.max(...fixture.calls.filter(({ name }) =>
      ["contract", "feeRate", "funding", "riskTiers", "positionMode",
        "marginType", "leverage"].includes(name))
      .map(({ startedAt }) => startedAt)));
});

test("every later capability assessment re-reads account exposure and missing stops fail closed", async () => {
  const fixture = capabilityFixture();
  const flat = await fixture.broker.getCapabilities();
  assert.ok(flat.features.includes("atomic_protected_market_entry"));

  fixture.setAccountState([{
    symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
    avgPrice: "100", positionId: "position-btc",
  }]);
  const missingStop = await fixture.broker.getCapabilities();
  assert.ok(!missingStop.features.includes("atomic_protected_market_entry"));
  assert.ok(!missingStop.features.includes("verified_exact_full_position_close"));

  fixture.setAccountState([
    { symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
      avgPrice: "100", positionId: "position-btc" },
    { symbol: "ETH-USDT", positionSide: "SHORT", positionAmt: "-0.2",
      avgPrice: "2000", positionId: "position-eth" },
  ]);
  const foreignExposure = await fixture.broker.getCapabilities();
  assert.ok(!foreignExposure.features.includes("atomic_protected_market_entry"));
  assert.ok(!foreignExposure.features.includes("verified_exact_full_position_close"));

  assert.equal(fixture.calls.filter(({ name }) => name === "positions").length, 3);
  assert.equal(fixture.calls.filter(({ name }) => name === "openOrders").length, 3);
});

test("position environment quote is forwarded once only by its authentic account-bound snapshot", async () => {
  const fixture = capabilityFixture();
  const position = await fixture.broker.readPosition("BTCUSDT");
  assert.equal(position.verified, true);
  assert.equal(position.environment, "vst");
  assert.equal(position.accountId, "test-vst-account");
  const mark = await fixture.broker.readMarketMark("BTCUSDT", {
    positionRead: position,
  });
  assert.equal(mark.verified, true);
  assert.equal(mark.price, 100);
  assert.equal(fixture.calls.filter(({ name }) => name === "mark").length, 1,
    "position environment check and market mark share one fresh native quote");

  await fixture.broker.readMarketMark("BTCUSDT", { positionRead: position });
  assert.equal(fixture.calls.filter(({ name }) => name === "mark").length, 2,
    "a successfully consumed proof is never reusable");
});

test("stale, wrong-symbol, wrong-account, and forged position proofs fall back to fresh native quotes", async () => {
  const fixture = capabilityFixture();
  const stale = await fixture.broker.readPosition("BTCUSDT");
  fixture.setNow(initialTime + 10_001);
  await fixture.broker.readMarketMark("BTCUSDT", { positionRead: stale });
  assert.equal(fixture.calls.filter(({ name }) => name === "mark").length, 2);

  fixture.setNow(initialTime + 10_002);
  const wrongSymbol = await fixture.broker.readPosition("BTCUSDT");
  await fixture.broker.readMarketMark("ETHUSDT", { positionRead: wrongSymbol });
  assert.equal(fixture.calls.filter(({ name }) => name === "mark").length, 4);

  fixture.setNow(initialTime + 10_003);
  const wrongAccount = await fixture.broker.readPosition("BTCUSDT");
  const otherAccountBroker = createVstBroker({
    api: fixture.api,
    accountId: "other-vst-account",
    canarySymbols: ["BTCUSDT"],
    clock: () => fixture.now,
    stopBufferRate: 0.005,
  });
  await otherAccountBroker.readMarketMark("BTCUSDT", { positionRead: wrongAccount });
  assert.equal(fixture.calls.filter(({ name }) => name === "mark").length, 6);

  fixture.setNow(initialTime + 10_004);
  const authentic = await fixture.broker.readPosition("BTCUSDT");
  await fixture.broker.readMarketMark("BTCUSDT", {
    positionRead: { ...authentic },
  });
  assert.equal(fixture.calls.filter(({ name }) => name === "mark").length, 8);
});

test("mutation boundaries and clock rollback invalidate one-operation market proofs", async () => {
  const fixture = capabilityFixture();
  const beforeMutation = await fixture.broker.readPosition("BTCUSDT");
  fixture.setLongLeverage(5);
  await fixture.broker.performIntent({
    clientOrderId: "test-market-proof-mutation",
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
  const afterMutationCount = fixture.calls.filter(({ name }) => name === "mark").length;
  await fixture.broker.readMarketMark("BTCUSDT", { positionRead: beforeMutation });
  assert.equal(fixture.calls.filter(({ name }) => name === "mark").length,
    afterMutationCount + 1);

  const beforeRollback = await fixture.broker.readPosition("BTCUSDT");
  fixture.setNow(initialTime - 1);
  const afterRollbackCount = fixture.calls.filter(({ name }) => name === "mark").length;
  await fixture.broker.readMarketMark("BTCUSDT", { positionRead: beforeRollback });
  assert.equal(fixture.calls.filter(({ name }) => name === "mark").length,
    afterRollbackCount + 1);
});
