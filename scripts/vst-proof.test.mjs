import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createExclusiveProofState,
  createGuardedFetch,
  archiveClosedAttempt,
  archiveUnknownEntryNoFill,
  computeFokPriceCap,
  computeExactQuarterQuantity,
  computeQuarterableQuantity,
  inspectStatus,
  readFreshVstAsk,
  runCli,
  runMarginTopUpObservation,
  verifyEntry,
  verifyEmergencyClose,
  verifyPartialClose,
  verifyPartialObservationEntry,
  verifyMarginTopUpObservation,
  verifyUnknownEntryNoFillForArchive,
} from "./vst-proof.mjs";

test("VST fetch wrapper rejects non-VST origins, including HTTPS mainnet", async () => {
  const calls = [];
  const guarded = createGuardedFetch(async (...args) => {
    calls.push(args);
    return new Response("ok");
  });
  await assert.rejects(
    guarded("https://open-api.bingx.com/openApi/swap/v2/user/positions", { method: "GET" }),
    /host isolation/,
  );
  await assert.rejects(
    guarded("http://open-api-vst.bingx.com/openApi/swap/v2/user/positions", { method: "GET" }),
    /host isolation/,
  );
  assert.equal(calls.length, 0);
});

test("all VST requests force redirect:error and reject redirected responses", async () => {
  let receivedRedirectMode;
  const guarded = createGuardedFetch(async (_url, init) => {
    receivedRedirectMode = init.redirect;
    return new Response("ok");
  });
  await guarded("https://open-api-vst.bingx.com/any/read", { method: "GET", redirect: "follow" });
  assert.equal(receivedRedirectMode, "error");

  const redirected = createGuardedFetch(async () => ({ ok: true, redirected: true }));
  await assert.rejects(
    redirected("https://open-api-vst.bingx.com/any/read", { method: "GET" }),
    /redirect rejected/,
  );
});

test("ticker closeTime is accepted as a fresh quote timestamp with a bounded future skew", async () => {
  const now = 1_700_000_000_000;
  const tickerResponse = (data) => ({
    ok: true,
    async json() { return { code: 0, data: { symbol: "BTC-USDT", askPrice: "65000", ...data } }; },
  });
  const fresh = await readFreshVstAsk(async () => tickerResponse({
    closeTime: now - 273,
  }), now);
  assert.equal(fresh.ask, 65000);
  assert.equal(fresh.timestamp, now - 273);
  assert.equal(fresh.ageMs, 273);

  await assert.rejects(
    readFreshVstAsk(async () => tickerResponse({ closeTime: now - 10_001 }), now),
    /ticker_stale_or_invalid/,
  );
  await assert.rejects(
    readFreshVstAsk(async () => tickerResponse({ closeTime: now + 2_001 }), now),
    /ticker_stale_or_invalid/,
  );
  const smallFutureSkew = await readFreshVstAsk(async () => tickerResponse({
    closeTime: now + 1_000,
  }), now);
  assert.equal(smallFutureSkew.ageMs, 0);
  assert.equal(smallFutureSkew.futureSkewMs, 1_000);
});

test("FOK entry cap is at most 0.5% above the ask and rejects an unrepresentable ask", () => {
  const cap = computeFokPriceCap(65_000, 1);
  assert.equal(cap, "65325.0");
  assert.ok(Number(cap) >= 65_000);
  assert.ok(Number(cap) <= 65_000 * 1.005 + Number.EPSILON * 65_000);
  assert.throws(() => computeFokPriceCap(1.0009, 2), /invalid_fok_price_cap/);
});

test("new VST entry size is the largest <=100 notional quantity with exact quarters", () => {
  const quantity = computeQuarterableQuantity(100 / 84_500, 4);
  assert.equal(quantity, "0.0008");
  assert.ok(Number(quantity) <= 100 / 84_500);
  assert.equal(computeExactQuarterQuantity(quantity, 4), "0.0002");
  assert.throws(() => computeExactQuarterQuantity("0.0011", 4),
    /quarter_quantity_unrepresentable/);
  assert.throws(() => computeExactQuarterQuantity("0.0008", 3),
    /invalid_position_quantity_precision/);
});

test("VST entry guard requires one exact price-bounded LIMIT FOK POST", async () => {
  let calls = 0;
  const methods = [];
  const clientOrderId = "ve_test-stable-client-id";
  const guarded = createGuardedFetch(async (_input, init) => {
    calls += 1;
    methods.push(init.method);
    if (init.method === "GET") {
      return Response.json({
        code: 0,
        data: { symbol: "BTC-USDT", askPrice: "100.9", closeTime: Date.now() },
      });
    }
    return new Response("ok");
  }, { stage: "entry", clientOrderId });
  guarded.setExpectedEntryPrice("101.0", 1);
  const url = new URL("https://open-api-vst.bingx.com/openApi/swap/v2/trade/order");
  for (const [key, value] of Object.entries({
    symbol: "BTC-USDT", side: "BUY", positionSide: "BOTH", type: "LIMIT", quantity: "0.001",
    price: "101.0", timeInForce: "FOK",
    clientOrderId, stopLoss: '{"type":"STOP_MARKET","stopPrice":1}',
    recvWindow: "5000", timestamp: "1700000000000", signature: "a".repeat(64),
  })) url.searchParams.set(key, value);
  const request = () => guarded(url, { method: "POST" });
  await request();
  await assert.rejects(request, /write guard/);
  assert.equal(calls, 2);
  assert.deepEqual(methods, ["GET", "POST"]);

  for (const [key, value] of [
    ["type", "MARKET"],
    ["price", "102.0"],
    ["timeInForce", "GTC"],
  ]) {
    const bad = createGuardedFetch(async () => { calls += 1; return new Response("ok"); }, {
      stage: "entry", clientOrderId: `${clientOrderId}_${key}`,
    });
     bad.setExpectedEntryPrice("101.0", 1);
    const invalid = new URL("https://open-api-vst.bingx.com/openApi/swap/v2/trade/order");
    for (const [param, item] of url.searchParams) invalid.searchParams.set(param, item);
    invalid.searchParams.set("clientOrderId", `${clientOrderId}_${key}`);
    invalid.searchParams.set(key, value);
    await assert.rejects(bad(invalid, { method: "POST" }), /write guard/);
  }
  const missingFok = createGuardedFetch(async () => { calls += 1; return new Response("ok"); }, {
    stage: "entry", clientOrderId: `${clientOrderId}_missing`,
  });
  missingFok.setExpectedEntryPrice("101.0", 1);
  const withoutFok = new URL(url);
  withoutFok.searchParams.set("clientOrderId", `${clientOrderId}_missing`);
  withoutFok.searchParams.delete("timeInForce");
  await assert.rejects(missingFok(withoutFok, { method: "POST" }), /write guard/);
  const missingPrice = createGuardedFetch(async () => { calls += 1; return new Response("ok"); }, {
    stage: "entry", clientOrderId: `${clientOrderId}_price`,
  });
  missingPrice.setExpectedEntryPrice("101.0", 1);
  const withoutPrice = new URL(url);
  withoutPrice.searchParams.set("clientOrderId", `${clientOrderId}_price`);
  withoutPrice.searchParams.delete("price");
  await assert.rejects(missingPrice(withoutPrice, { method: "POST" }), /write guard/);
  const missingStop = createGuardedFetch(async () => { calls += 1; return new Response("ok"); }, {
    stage: "entry", clientOrderId: `${clientOrderId}_stop`,
  });
  missingStop.setExpectedEntryPrice("101.0", 1);
  const withoutStop = new URL(url);
  withoutStop.searchParams.set("clientOrderId", `${clientOrderId}_stop`);
  withoutStop.searchParams.delete("stopLoss");
  await assert.rejects(missingStop(withoutStop, { method: "POST" }), /write guard/);
  assert.equal(calls, 2);
});

test("VST entry guard refuses POST for stale, adverse, over-cap, or redirected final ticker", async () => {
  const orderUrl = new URL("https://open-api-vst.bingx.com/openApi/swap/v2/trade/order");
  for (const [key, value] of Object.entries({
    symbol: "BTC-USDT",
    side: "BUY",
    positionSide: "BOTH",
    type: "LIMIT",
    quantity: "0.001",
    price: "101.0",
    timeInForce: "FOK",
    clientOrderId: "ve_final-quote-check",
    stopLoss: '{"type":"STOP_MARKET","stopPrice":98}',
    recvWindow: "5000",
    timestamp: String(Date.now()),
    signature: "b".repeat(64),
  })) orderUrl.searchParams.set(key, value);

  const fixtures = [
    { askPrice: "100.9", closeTime: Date.now() - 10_001 },
    { askPrice: "101.1", closeTime: Date.now() },
    { askPrice: "100.0", closeTime: Date.now() },
  ];
  for (const fixture of fixtures) {
    let postCount = 0;
    const guarded = createGuardedFetch(async (_input, init) => {
      assert.equal(init.redirect, "error");
      if (init.method === "POST") {
        postCount += 1;
        return new Response("unexpected POST");
      }
      return Response.json({ code: 0, data: { symbol: "BTC-USDT", ...fixture } });
    }, { stage: "entry", clientOrderId: "ve_final-quote-check" });
    guarded.setExpectedEntryPrice("101.0", 1);
    guarded.setWriteNotAfter(Date.now() + 60_000);
    await assert.rejects(guarded(orderUrl, { method: "POST" }), /stale|ask outside/);
    assert.equal(postCount, 0);
  }

  let redirectedPostCount = 0;
  const redirected = createGuardedFetch(async (_input, init) => {
    assert.equal(init.redirect, "error");
    if (init.method === "POST") redirectedPostCount += 1;
    throw new Error("mock redirect");
  }, { stage: "entry", clientOrderId: "ve_final-quote-check" });
  redirected.setExpectedEntryPrice("101.0", 1);
  redirected.setWriteNotAfter(Date.now() + 60_000);
  await assert.rejects(redirected(orderUrl, { method: "POST" }), /ticker request or redirect/);
  assert.equal(redirectedPostCount, 0);
});

test("entry stage cannot issue DELETE, different route, side, symbol, or client ID", async () => {
  let calls = 0;
  const guarded = createGuardedFetch(async () => {
    calls += 1;
    return new Response("ok");
  }, { stage: "entry", clientOrderId: "ve_expected" });
  for (const [path, params] of [
    ["/openApi/swap/v2/trade/order", { symbol: "BTC-USDT", side: "SELL", clientOrderId: "ve_expected" }],
    ["/openApi/swap/v2/trade/order", { symbol: "ETH-USDT", side: "BUY", clientOrderId: "ve_expected" }],
    ["/openApi/swap/v2/trade/order", { symbol: "BTC-USDT", side: "BUY", clientOrderId: "ve_other" }],
    ["/openApi/swap/v2/trade/openOrders", { symbol: "BTC-USDT", side: "BUY", clientOrderId: "ve_expected" }],
  ]) {
    const url = new URL(`https://open-api-vst.bingx.com${path}`);
    for (const [key, value] of Object.entries({ type: "MARKET", quantity: "1", ...params })) {
      url.searchParams.set(key, value);
    }
    await assert.rejects(guarded(url, { method: "POST" }), /write guard/);
  }
  const del = new URL("https://open-api-vst.bingx.com/openApi/swap/v2/trade/order");
  await assert.rejects(guarded(del, { method: "DELETE" }), /write guard/);
  assert.equal(calls, 0);
});

test("partial-close guard is VST-only, exact, redirect-blocked, and one-write", async () => {
  let posts = 0;
  const guarded = createGuardedFetch(async (_url, init) => {
    assert.equal(init.redirect, "error");
    if (init.method === "POST") posts += 1;
    return new Response("ok");
  }, {
    stage: "partial-close",
    clientOrderId: "vp_single-partial",
    expectedQuantity: "0.0005",
    expectedPositionSide: "BOTH",
  });
  const target = new URL("https://open-api-vst.bingx.com/openApi/swap/v2/trade/order");
  for (const [key, value] of Object.entries({
    symbol: "BTC-USDT", side: "SELL", positionSide: "BOTH", type: "MARKET",
    quantity: "0.0005", clientOrderId: "vp_single-partial",
    recvWindow: "5000", timestamp: "1700000000000", signature: "c".repeat(64),
  })) target.searchParams.set(key, value);
  await guarded(target, { method: "POST" });
  await assert.rejects(guarded(target, { method: "POST" }), /write guard/);
  assert.equal(posts, 1);

  for (const [origin, patch] of [
    ["https://open-api.bingx.com", {}],
    ["https://open-api-vst.bingx.com", { quantity: "0.0004" }],
    ["https://open-api-vst.bingx.com", { side: "BUY" }],
    ["https://open-api-vst.bingx.com", { unexpected: "true" }],
  ]) {
    const bad = createGuardedFetch(async () => {
      throw new Error("invalid write reached transport");
    }, {
      stage: "partial-close",
      clientOrderId: "vp_guard-test",
      expectedQuantity: "0.0005",
      expectedPositionSide: "BOTH",
    });
    const invalid = new URL(target);
    invalid.hostname = origin.includes("open-api.bingx.com")
      ? "open-api.bingx.com" : "open-api-vst.bingx.com";
    for (const [key, value] of Object.entries(patch)) invalid.searchParams.set(key, value);
    await assert.rejects(bad(invalid, { method: "POST" }));
  }
});

test("durable exclusive state reservation blocks a second submission after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-proof-"));
  const statePath = join(directory, "vst-proof-state.json");
  const state = {
    version: 1,
    environment: "vst",
    symbol: "BTCUSDT",
    status: "entry_submitting",
    entry: { clientOrderId: "ve_persisted-once" },
  };
  try {
    await createExclusiveProofState(statePath, state);
    // A fresh process has no in-memory duplicate set; exclusive durable
    // reservation still prevents recreating an intent or posting again.
    await assert.rejects(createExclusiveProofState(statePath, state), { code: "EEXIST" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("partial SELL intent is durably fenced before a second partial can be reserved", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-partial-intent-"));
  const statePath = join(directory, "vst-proof-state.json");
  const state = {
    version: 1,
    environment: "vst",
    symbol: "BTCUSDT",
    status: "partial_observation_submitting",
    entry: { clientOrderId: "ve_partial" },
    partialObservation: {
      clientOrderId: "vp_persisted-once",
      quantity: "0.0005",
      originalQuantity: "0.001",
      stopOrderId: "stop-1",
    },
  };
  try {
    await createExclusiveProofState(statePath, state);
    await assert.rejects(createExclusiveProofState(statePath, {
      ...state,
      partialObservation: { ...state.partialObservation, clientOrderId: "vp_retry" },
    }), { code: "EEXIST" });
    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(persisted.partialObservation.clientOrderId, "vp_persisted-once");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function entryProofApi({
  order = {},
  position = {},
  fill = {},
  stop = {},
  coverage = {},
} = {}) {
  const entryOrder = {
    symbol: "BTC-USDT",
    clientOrderId: "ve_test",
    orderId: "entry-1",
    side: "BUY",
    positionSide: "BOTH",
    status: "FILLED",
    type: "LIMIT",
    timeInForce: "FOK",
    price: "100",
    origQty: "0.001",
    executedQty: "0.001",
    ...order,
  };
  const activePosition = {
    symbol: "BTC-USDT",
    positionSide: "BOTH",
    positionAmt: "0.001",
    positionId: "position-1",
    ...position,
  };
  const entryFill = {
    symbol: "BTC-USDT",
    orderId: "entry-1",
    side: "BUY",
    positionSide: "BOTH",
    qty: "0.001",
    ...fill,
  };
  const activeStop = {
    symbol: "BTC-USDT",
    orderId: "stop-1",
    mainOrderId: "entry-1",
    positionID: "position-1",
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "BOTH",
    origQty: "0.001",
    stopPrice: "98",
    workingType: "MARK_PRICE",
    closePosition: false,
    ...stop,
  };
  return {
    async queryOrder() { return entryOrder; },
    async queryOrderHistory() { return [entryOrder]; },
    async getPositions() { return [activePosition]; },
    async queryFills() { return [entryFill]; },
    async discoverAttachedStop() { return { verified: true, stopOrderId: "stop-1" }; },
    async getOpenOrders() { return [activeStop]; },
    async auditProtectiveStopCoverage() {
      return {
        verified: true,
        stopProtected: true,
        protectiveStopOrderId: "stop-1",
        ...coverage,
      };
    },
  };
}

const entryState = {
  createdAt: 1_700_000_000_000,
  entry: {
    clientOrderId: "ve_test",
    quantity: "0.001",
    entryPrice: "100",
    stopLoss: "98",
    positionMode: "ONE_WAY",
  },
};

test("entry proof rejects false-positive order identity, fills, stop linkage, and coverage", async () => {
  const good = await verifyEntry(entryProofApi(), entryState);
  assert.equal(good.protected, true);
  assert.equal(good.protectiveStopOrderId, "stop-1");
  for (const api of [
    entryProofApi({ order: { clientOrderId: "ve_other" } }),
    entryProofApi({ order: { side: "SELL" } }),
    entryProofApi({ order: { type: "MARKET" } }),
    entryProofApi({ order: { timeInForce: "GTC" } }),
    entryProofApi({ order: { price: "101" } }),
    entryProofApi({ order: { status: "PARTIALLY_FILLED" } }),
    entryProofApi({ order: { executedQty: "0.0005" } }),
    entryProofApi({ fill: { side: "SELL" } }),
    entryProofApi({
      stop: {
        mainOrderId: undefined, parentOrderId: undefined,
        positionID: undefined, positionId: undefined,
      },
    }),
    entryProofApi({ stop: { positionID: "other-position" } }),
    entryProofApi({ stop: { workingType: "CONTRACT_PRICE" } }),
    entryProofApi({ coverage: { verified: false, stopProtected: false } }),
  ]) {
    const proof = await verifyEntry(api, entryState);
    assert.equal(proof.protected, false);
  }
});

test("entry reconciliation uses exact history after recognized order-not-found drift", async () => {
  const api = entryProofApi({
    fill: {
      qty: undefined,
      quantity: undefined,
      volume: "0.001",
      clientOrderID: "",
    },
    stop: {
      mainOrderId: "",
      parentOrderId: "",
      closePosition: "false",
    },
  });
  const historyCalls = [];
  api.queryOrder = async () => {
    const error = new Error("order not exist");
    error.code = 109421;
    error.transportStage = "exchange_response";
    throw error;
  };
  api.queryOrderHistory = async (...args) => {
    historyCalls.push(args);
    return { orders: [{
      symbol: "BTC-USDT", clientOrderId: "ve_test", orderId: "entry-1",
      side: "BUY", positionSide: "BOTH", status: "FILLED", type: "LIMIT",
      timeInForce: "FOK", price: "100", origQty: "0.001", executedQty: "0.001",
    }] };
  };
  const proof = await verifyEntry(api, entryState);
  assert.equal(proof.protected, true);
  assert.equal(proof.closePosition, false);
  assert.equal(proof.dynamicRemainingCoverageProven, false);
  assert.equal(historyCalls.length, 1);

  for (const historyOrder of [
    { clientOrderId: "ve_other" },
    { symbol: "ETH-USDT" },
    { side: "SELL" },
    { status: "NEW" },
    { origQty: "0.002" },
    { executedQty: "0.0005" },
  ]) {
    const badApi = entryProofApi();
    badApi.queryOrder = async () => {
      const error = new Error("order not exist");
      error.code = "109421";
      error.transportStage = "exchange_response";
      throw error;
    };
    badApi.queryOrderHistory = async () => [{
      symbol: "BTC-USDT", clientOrderId: "ve_test", orderId: "entry-1",
      side: "BUY", positionSide: "BOTH", status: "FILLED", type: "LIMIT",
      timeInForce: "FOK", price: "100", origQty: "0.001", executedQty: "0.001",
      ...historyOrder,
    }];
    await assert.rejects(verifyEntry(badApi, entryState));
  }

  for (const fill of [
    { volume: "0.001", clientOrderID: "ve_other" },
    { volume: "0.0009", clientOrderID: "" },
  ]) {
    const badApi = entryProofApi({ fill: { qty: undefined, volume: "0.001", ...fill } });
    const rejected = await verifyEntry(badApi, entryState);
    assert.notEqual(rejected.protected, true);
  }
});

test("emergency close is read-only reconcilable from exact history and order-ID fills", async () => {
  const closeState = {
    status: "emergency_close_unknown_halt_no_retry",
    createdAt: 1_700_000_000_000,
    entry: { positionMode: "ONE_WAY" },
    emergencyClose: {
      clientOrderId: "vc_test",
      quantity: "0.001",
      recordedAt: 1_700_000_000_000,
    },
  };
  const api = {
    async queryOrder() {
      const error = new Error("order not exist");
      error.code = 109421;
      error.transportStage = "exchange_response";
      throw error;
    },
    async queryOrderHistory() {
      return { orders: [{
        symbol: "BTC-USDT", clientOrderID: "vc_test", orderID: "close-1",
        side: "SELL", positionSide: "BOTH", status: "FILLED", type: "MARKET",
        origQty: "0.001", executedQty: "0.001",
      }] };
    },
    async getPositions() { return [{ symbol: "BTC-USDT", positionSide: "BOTH", positionAmt: "0" }]; },
    async getOpenOrders() { return []; },
    async queryFills() {
      return [{
        symbol: "BTC-USDT", orderId: "close-1", side: "SELL",
        volume: "0.001", clientOrderID: "",
      }];
    },
  };
  const proof = await verifyEmergencyClose(api, closeState);
  assert.equal(proof.verified, true);
  const status = await inspectStatus(closeState, api);
  assert.equal(status.status, "closed_verified");
  assert.equal(status.flatVerified, true);

  const mismatchedFill = await verifyEmergencyClose({
    ...api,
    async queryFills() {
      return [{ symbol: "BTC-USDT", orderId: "close-1", side: "SELL",
        volume: "0.001", clientOrderID: "someone-else" }];
    },
  }, closeState);
  assert.equal(mismatchedFill.verified, false);
  const unavailable = await verifyEmergencyClose({
    ...api,
    async queryOrderHistory() { throw new Error("history unavailable"); },
  }, closeState);
  assert.equal(unavailable.verified, false);
});

test("partial-close reconciliation reports resized, oversized, or disappeared child stop", async () => {
  const state = {
    createdAt: 1_700_000_000_000,
    entry: { positionMode: "ONE_WAY" },
    partialObservation: {
      clientOrderId: "vp_partial",
      quantity: "0.0004",
      originalQuantity: "0.001",
      stopOrderId: "stop-old",
      positionId: "position-partial",
      stopPrice: "98",
      positionMode: "ONE_WAY",
      recordedAt: 1_700_000_000_000,
    },
  };
  const base = {
    async queryOrder() {
      return {
        symbol: "BTC-USDT", clientOrderId: "vp_partial", orderId: "partial-sell",
        side: "SELL", positionSide: "BOTH", status: "FILLED", type: "MARKET",
        origQty: "0.0004", executedQty: "0.0004",
      };
    },
    async queryFills(_symbol, query) {
      assert.equal(query.currency, "USDT");
      return [{ symbol: "BTC-USDT", orderId: "partial-sell", side: "SELL", qty: "0.0004" }];
    },
    async getPositions() {
      return [{
        symbol: "BTC-USDT", positionSide: "BOTH", positionAmt: "0.0006",
        positionId: "position-partial",
      }];
    },
    async queryOrderHistory() { return []; },
    async getOpenOrders() {
      return [{
        symbol: "BTC-USDT", orderId: "stop-old", type: "STOP_MARKET",
        status: "NEW", side: "SELL", positionSide: "BOTH",
        positionId: "position-partial", origQty: "0.0006",
        stopPrice: "98", workingType: "MARK_PRICE", closePosition: false,
      }];
    },
  };
  const resized = await verifyPartialClose(base, state);
  assert.equal(resized.verified, true);
  assert.equal(resized.protected, false);
  assert.equal(resized.stopObservation, "auto_resized_to_remaining");

  const oversized = await verifyPartialClose({
    ...base,
    async getOpenOrders() {
      return [{
        symbol: "BTC-USDT", orderId: "stop-old", type: "STOP_MARKET",
        status: "NEW", side: "SELL", positionSide: "BOTH",
        positionId: "position-partial", origQty: "0.001",
        stopPrice: "98", workingType: "MARK_PRICE", closePosition: false,
      }];
    },
  }, state);
  assert.equal(oversized.stopObservation, "still_oversized");
  assert.equal(oversized.emergencyCloseUrgency, true);
  assert.equal(oversized.protected, false);

  const disappeared = await verifyPartialClose({
    ...base,
    async getOpenOrders() { return []; },
    async queryOrderHistory() {
      return [{
        symbol: "BTC-USDT", orderId: "stop-old", type: "STOP_MARKET",
        status: "CANCELED", origQty: "0.001",
      }];
    },
  }, state);
  assert.equal(disappeared.stopObservation, "disappeared_or_auto_canceled");
  assert.equal(disappeared.emergencyCloseUrgency, true);

  const competingOrders = await verifyPartialClose({
    ...base,
    async getOpenOrders() {
      return [{
        symbol: "BTC-USDT", orderId: "stop-old", type: "STOP_MARKET",
        status: "NEW", side: "SELL", positionSide: "BOTH",
        positionId: "position-partial", origQty: "0.0006",
        stopPrice: "98", workingType: "MARK_PRICE", closePosition: false,
      }, {
        symbol: "BTC-USDT", orderId: "unrelated-order", type: "LIMIT",
        status: "NEW", side: "SELL", positionSide: "BOTH",
      }];
    },
  }, state);
  assert.equal(competingOrders.verified, false);
  assert.equal(competingOrders.stopObservation, "competing_or_unverified_open_orders");
  assert.equal(competingOrders.emergencyCloseUrgency, true);
});

test("partial preflight verifies independently filled entry and uses USDT fill history", async () => {
  const entryState = {
    createdAt: 1_700_000_000_000,
    entry: {
      clientOrderId: "ve_quarter",
      quantity: "0.0008",
      entryPrice: "84500",
      stopLoss: "82810",
      positionMode: "ONE_WAY",
      initialMarginEstimate: 6.76,
    },
  };
  const stop = {
    symbol: "BTC-USDT", orderId: "quarter-stop", positionId: "quarter-position",
    type: "STOP_MARKET", status: "NEW", side: "SELL", positionSide: "BOTH",
    origQty: "0.0008", stopPrice: "82810", closePosition: false,
    workingType: "MARK_PRICE",
  };
  let requestedCurrency;
  const api = {
    async queryOrder() {
      return {
        symbol: "BTC-USDT", clientOrderId: "ve_quarter", orderId: "quarter-entry",
        side: "BUY", positionSide: "BOTH", status: "FILLED", type: "LIMIT",
        timeInForce: "FOK", price: "84500", origQty: "0.0008", executedQty: "0.0008",
      };
    },
    async getPositions() {
      return [{
        symbol: "BTC-USDT", positionSide: "BOTH", positionAmt: "0.0008",
        positionId: "quarter-position",
      }];
    },
    async getOpenOrders() { return [stop]; },
    async getPositionMode() { return "ONE_WAY"; },
    async getMarginType() { return "ISOLATED"; },
    async getLeverage() { return { longLeverage: 10, shortLeverage: 10 }; },
    async queryFills(_symbol, query) {
      requestedCurrency = query.currency;
      return [{
        symbol: "BTC-USDT", orderId: "quarter-entry", side: "BUY", qty: "0.0008",
      }];
    },
  };
  const verified = await verifyPartialObservationEntry(api, entryState, 84_500);
  assert.equal(verified.stopOrderId, "quarter-stop");
  assert.equal(verified.currentQuantity, "0.0008");
  assert.equal(requestedCurrency, "USDT");
});

function topupState() {
  return {
    version: 1,
    environment: "vst",
    symbol: "BTCUSDT",
    status: "partial_observation_resized",
    createdAt: 1_700_000_000_000,
    entry: { initialMarginEstimate: 6.76, positionMode: "HEDGE" },
    partialObservation: {
      stopOrderId: "2104112180806377472",
      positionId: "position-2104",
      stopPrice: "83246.7",
      proof: {
        verified: true,
        remainingPositionVerified: true,
        expectedRemainingQuantity: "0.0006",
        stopOrderId: "2104112180806377472",
        stopObservation: "auto_resized_to_remaining",
      },
    },
  };
}

function topupApi({ position = {}, stop = {}, orders } = {}) {
  const livePosition = {
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: "0.0006",
    positionId: "position-2104",
    margin: "5.0653",
    ...position,
  };
  const liveStop = {
    symbol: "BTC-USDT",
    orderId: "2104112180806377472",
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionId: "position-2104",
    origQty: "0.0006",
    stopPrice: "83246.7",
    workingType: "MARK_PRICE",
    closePosition: false,
    ...stop,
  };
  return {
    livePosition,
    liveStop,
    async getPositions() { return [livePosition]; },
    async getOpenOrders() { return orders ?? [liveStop]; },
    async getPositionMode() { return "HEDGE"; },
    async getMarginType() { return "ISOLATED"; },
    async getLeverage() { return { longLeverage: 10, shortLeverage: 10 }; },
    async getBalance() {
      return [{ asset: "VST", availableMargin: "12.5" }];
    },
    async addIsolatedMargin() {
      livePosition.margin = "7.0733";
      return { code: 0 };
    },
  };
}

test("margin top-up observation requires exact current LONG, isolated-10 and linked stop", async () => {
  const state = topupState();
  const verified = await verifyMarginTopUpObservation(topupApi(), state);
  assert.equal(verified.margin, "5.0653");
  assert.equal(verified.quantity, "0.0006");
  assert.equal(verified.stopOrderId, "2104112180806377472");

  for (const api of [
    topupApi({ position: { positionAmt: "0.0005" } }),
    topupApi({ position: { positionSide: "BOTH" } }),
    topupApi({ position: { positionId: "another-position" } }),
    topupApi({ position: { margin: undefined } }),
    topupApi({ stop: { orderId: "another-stop" } }),
    topupApi({ stop: { positionId: "another-position" } }),
    topupApi({ stop: { origQty: "0.0008" } }),
    topupApi({ stop: { stopPrice: "83246.6" } }),
    topupApi({ stop: { status: "CANCELED" } }),
    topupApi({ stop: { closePosition: true } }),
    topupApi({ orders: [
      topupApi().liveStop,
      { symbol: "BTC-USDT", orderId: "competing", type: "LIMIT" },
    ] }),
    { ...topupApi(), async getMarginType() { return "CROSSED"; } },
    { ...topupApi(), async getLeverage() { return { longLeverage: 9, shortLeverage: 10 }; } },
  ]) {
    await assert.rejects(verifyMarginTopUpObservation(api, state));
  }
});

test("margin top-up persists one local intent before mock POST and verifies exact increase", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-margin-topup-"));
  const statePath = join(directory, "vst-proof-state.json");
  const state = topupState();
  const api = topupApi();
  let postCount = 0;
  api.addIsolatedMargin = async (symbol, amount, operationId) => {
    postCount += 1;
    assert.equal(symbol, "BTCUSDT");
    assert.equal(amount, "2");
    assert.match(operationId, /^vmt_[A-Za-z0-9]+$/);
    const reserved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(reserved.status, "margin_topup_submitting");
    assert.equal(reserved.marginTopUp.clientOperationID, operationId);
    assert.equal(reserved.marginTopUp.transportIdempotency, false);
    api.livePosition.margin = "7.0733";
    return { accepted: true };
  };
  try {
    const result = await runMarginTopUpObservation({
      api, state, statePath, amount: "2", operatorConfirmed: true,
    });
    assert.equal(postCount, 1);
    assert.equal(result.status, "margin_topup_verified");
    assert.equal(result.marginAfter, "7.0733");
    assert.equal(result.observedMarginDelta, 2.008);
    assert.equal(result.marginChangeApproximate, true);
    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(persisted.marginTopUp.status, "verified");
    assert.equal(persisted.marginTopUp.amount, "2");
    await assert.rejects(runMarginTopUpObservation({
      api, state: persisted, statePath, amount: "2", operatorConfirmed: true,
    }), /topup_requires_partial_observation_resized_state/);
    assert.equal(postCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("margin top-up accepts only the bounded approximate market-margin drift", async () => {
  for (const [delta, after] of [
    [1.8, "6.8653"],
    [2.2, "7.2653"],
  ]) {
    const directory = await mkdtemp(join(tmpdir(), "vst-margin-drift-"));
    const api = topupApi();
    api.addIsolatedMargin = async () => { api.livePosition.margin = after; };
    try {
      const result = await runMarginTopUpObservation({
        api,
        state: topupState(),
        statePath: join(directory, "state.json"),
        amount: "2",
        operatorConfirmed: true,
      });
      assert.equal(result.status, "margin_topup_verified");
      assert.equal(result.observedMarginDelta, delta);
      assert.equal(result.marginChangeApproximate, true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("margin top-up fails closed on balance and initial/total margin caps", async () => {
  for (const [state, api, expected] of [
    [topupState(), {
      ...topupApi(),
      async getBalance() { return [{ asset: "VST", availableMargin: "1.99" }]; },
    }, /topup_insufficient_available_vst/],
    [{ ...topupState(), entry: { initialMarginEstimate: 10.01 } },
      topupApi(), /topup_requires_partial_observation_resized_state/],
    [topupState(), topupApi({ position: { margin: "12.81" } }),
      /topup_margin_over_15_vst/],
  ]) {
    let posts = 0;
    api.addIsolatedMargin = async () => { posts += 1; };
    const directory = await mkdtemp(join(tmpdir(), "vst-margin-topup-blocked-"));
    try {
      await assert.rejects(runMarginTopUpObservation({
        api, state, statePath: join(directory, "state.json"), amount: "2",
        operatorConfirmed: true,
      }), expected);
      assert.equal(posts, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("margin top-up reports unknown and fences retries after any post-state mismatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-margin-topup-unknown-"));
  const statePath = join(directory, "vst-proof-state.json");
  const state = topupState();
  const api = topupApi();
  let posts = 0;
  api.addIsolatedMargin = async () => {
    posts += 1;
    api.livePosition.margin = "6.8";
  };
  try {
    const result = await runMarginTopUpObservation({
      api, state, statePath, amount: "2", operatorConfirmed: true,
    });
    assert.equal(result.status, "margin_topup_unknown_halt_no_retry");
    assert.match(result.instruction, /emergency-close remains available/);
    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(persisted.marginTopUp.status, "unknown");
    await assert.rejects(runMarginTopUpObservation({
      api, state: persisted, statePath, amount: "2", operatorConfirmed: true,
    }), /topup_requires_partial_observation_resized_state/);
    assert.equal(posts, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("top-up write guard permits only one exact VST position-margin POST", async () => {
  const makeUrl = (patch = {}) => {
    const url = new URL("https://open-api-vst.bingx.com/openApi/swap/v2/trade/positionMargin");
    for (const [key, value] of Object.entries({
      symbol: "BTC-USDT", amount: "2", type: "1", positionSide: "LONG",
      recvWindow: "5000", timestamp: String(Date.now()), signature: "d".repeat(64),
      ...patch,
    })) url.searchParams.set(key, value);
    return url;
  };
  let posts = 0;
  const guarded = createGuardedFetch(async (_url, init) => {
    assert.equal(init.redirect, "error");
    posts += 1;
    return Response.json({ code: 0 });
  }, { stage: "margin-topup" });
  await guarded(makeUrl(), { method: "POST" });
  await assert.rejects(guarded(makeUrl(), { method: "POST" }), /margin write guard/);
  assert.equal(posts, 1);

  for (const [url, method] of [
    [makeUrl({ amount: "3" }), "POST"],
    [makeUrl({ positionSide: "SHORT" }), "POST"],
    [makeUrl({ side: "LONG" }), "POST"],
    [makeUrl({ type: "2" }), "POST"],
    [makeUrl({ symbol: "ETH-USDT" }), "POST"],
    [makeUrl({ surprise: "1" }), "POST"],
    [(() => { const url = makeUrl(); url.searchParams.append("amount", "2"); return url; })(), "POST"],
    [(() => { const url = makeUrl(); url.searchParams.delete("signature"); return url; })(), "POST"],
    [new URL(makeUrl().href.replace("open-api-vst", "open-api")), "POST"],
    [new URL("https://open-api-vst.bingx.com/openApi/swap/v2/trade/order"), "POST"],
    [makeUrl(), "DELETE"],
  ]) {
    const rejectGuard = createGuardedFetch(async () => {
      throw new Error("invalid request reached transport");
    }, { stage: "margin-topup" });
    await assert.rejects(rejectGuard(url, { method }), /margin write guard|host isolation/);
  }

  const redirected = createGuardedFetch(async (_url, init) => {
    assert.equal(init.redirect, "error");
    return { ok: true, redirected: true };
  }, { stage: "margin-topup" });
  await assert.rejects(redirected(makeUrl(), { method: "POST" }), /redirect rejected/);

  let failedTransportCalls = 0;
  const failedOnce = createGuardedFetch(async () => {
    failedTransportCalls += 1;
    throw new Error("mock timeout");
  }, { stage: "margin-topup" });
  await assert.rejects(failedOnce(makeUrl(), { method: "POST" }), /fetch failed/);
  await assert.rejects(failedOnce(makeUrl(), { method: "POST" }), /margin write guard/);
  assert.equal(failedTransportCalls, 1);
});

test("top-up CLI requires explicit VST confirmation and exactly the approved amount", async () => {
  await assert.rejects(runCli(["topup-observe", "--amount", "2"]),
    /confirmation_required/);
  await assert.rejects(runCli(["topup-observe", "--confirm-vst-only"]),
    /exact_topup_amount_required/);
  await assert.rejects(runCli([
    "topup-observe", "--confirm-vst-only", "--amount", "2.01",
  ]), /exact_topup_amount_required/);
  await assert.rejects(runCli([
    "topup-observe", "--confirm-vst-only", "--amount", "2", "--amount", "2",
  ]), /invalid_arguments/);
  await assert.rejects(runCli([
    "topup-observe", "--confirm-vst-only", "--amount", "2", "--quantity", "0.0002",
  ]), /invalid_arguments/);
});

test("closed-attempt archive requires explicit confirmation and verified close proof", async () => {
  await assert.rejects(runCli(["archive-closed"]), /confirmation_required/);
  await assert.rejects(
    runCli(["archive-closed", "--confirm-vst-only"]), /confirmation_required/,
  );
  await assert.rejects(
    runCli(["partial-observe", "--quantity", "0.0005"]), /confirmation_required/,
  );
  const directory = await mkdtemp(join(tmpdir(), "vst-archive-closed-"));
  const statePath = join(directory, "vst-proof-state.json");
  const state = {
    version: 1,
    environment: "vst",
    symbol: "BTCUSDT",
    createdAt: 1_700_000_000_000,
    status: "closed_verified",
    entry: { positionMode: "ONE_WAY" },
    emergencyClose: {
      clientOrderId: "vc_closed",
      quantity: "0.001",
      recordedAt: 1_700_000_000_000,
      positionMode: "ONE_WAY",
    },
  };
  const api = {
    async queryOrder() {
      return {
        symbol: "BTC-USDT", clientOrderId: "vc_closed", orderId: "close-closed",
        side: "SELL", positionSide: "BOTH", status: "FILLED", type: "MARKET",
        origQty: "0.001", executedQty: "0.001",
      };
    },
    async getPositions() {
      return [{ symbol: "BTC-USDT", positionSide: "BOTH", positionAmt: "0" }];
    },
    async getOpenOrders() { return []; },
    async queryFills() {
      return [{ symbol: "BTC-USDT", orderId: "close-closed", side: "SELL", qty: "0.001" }];
    },
  };
  try {
    await createExclusiveProofState(statePath, state);
    await assert.rejects(archiveClosedAttempt({
      api, state, statePath,
    }), /confirmation_required/);
    const archived = await archiveClosedAttempt({
      api, state, statePath, operatorConfirmed: true,
    });
    assert.equal(archived.status, "archived_closed_verified");
    assert.equal(archived.flatVerified, true);
    const archivedState = JSON.parse(await readFile(archived.archivePath, "utf8"));
    assert.equal(archivedState.archiveClosed.proof.verified, true);
    await assert.rejects(readFile(statePath, "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FOK expired or canceled entry is terminal only with independent no-fill exchange proof", async () => {
  for (const status of ["EXPIRED", "CANCELED"]) {
    const order = {
      symbol: "BTC-USDT", clientOrderId: "ve_test", orderId: "entry-1",
      side: "BUY", positionSide: "BOTH", type: "LIMIT", timeInForce: "FOK",
      price: "100", status, origQty: "0.001", executedQty: "0",
    };
    const api = {
      async queryOrder() { return order; },
      async getPositions() { return []; },
      async getOpenOrders() { return []; },
      async queryFills() { return []; },
    };
    const proof = await verifyEntry(api, entryState);
    assert.equal(proof.status, "entry_no_fill_verified");
    assert.equal(proof.noFill, true);
    const reconciled = await inspectStatus({
      ...entryState, status: "entry_unknown_halt_no_retry",
    }, api);
    assert.equal(reconciled.status, "entry_no_fill_verified");
    assert.equal(reconciled.noFillVerified, true);
  }

  const partial = {
    symbol: "BTC-USDT", clientOrderId: "ve_test", orderId: "entry-1",
    side: "BUY", positionSide: "BOTH", type: "LIMIT", timeInForce: "FOK",
    price: "100", status: "EXPIRED", origQty: "0.001", executedQty: "0.0005",
  };
  const partiallyFilled = await verifyEntry({
    async queryOrder() { return partial; },
    async getPositions() { return []; },
    async getOpenOrders() { return []; },
    async queryFills() {
      return [{ symbol: "BTC-USDT", orderId: "entry-1", side: "BUY", qty: "0.0005" }];
    },
  }, entryState);
  assert.notEqual(partiallyFilled.status, "entry_no_fill_verified");

  const stillOpen = await verifyEntry({
    async queryOrder() {
      return { ...partial, executedQty: "0", status: "CANCELED" };
    },
    async getPositions() { return []; },
    async getOpenOrders() { return [{ symbol: "BTC-USDT", orderId: "unrelated" }]; },
    async queryFills() { return []; },
  }, entryState);
  assert.notEqual(stillOpen.status, "entry_no_fill_verified");
});

test("unresolved entry and close status never upgrades without independent proof", async () => {
  let orderQueries = 0;
  const readOnlyApi = {
    async getPositions() {
      return [{
        symbol: "BTC-USDT", positionSide: "BOTH", positionAmt: "0.001",
      }];
    },
    async getOpenOrders() { return []; },
    async queryOrder() {
      orderQueries += 1;
      throw new Error("exchange order lookup unavailable");
    },
  };
  for (const state of [
    {
      status: "entry_unknown_halt_no_retry",
      entry: {
        clientOrderId: "ve_unknown",
        lastError: {
          code: "api_key=do-not-show",
          transportStage: "x-bx-apikey:do-not-show",
        },
      },
    },
    {
      status: "emergency_close_unknown_halt_no_retry",
      entry: { clientOrderId: "ve_known" },
      emergencyClose: { clientOrderId: "vc_unknown" },
    },
  ]) {
    const result = await inspectStatus(state, readOnlyApi);
    assert.equal(result.protected, false);
    assert.notEqual(result.status, "protected");
    if (state.status === "entry_unknown_halt_no_retry") {
      assert.deepEqual(result.lastEntryDiagnostic, {
        code: "unclassified",
        transportStage: "unknown",
      });
    }
  }
  assert.equal(orderQueries, 1);
});

test("operator archive requires explicit flags and preserves two-observation proof", async () => {
  await assert.rejects(runCli(["archive-no-fill"]), /confirmation_required/);
  await assert.rejects(
    runCli(["archive-no-fill", "--confirm-vst-only"]), /confirmation_required/,
  );
  const directory = await mkdtemp(join(tmpdir(), "vst-archive-"));
  const statePath = join(directory, "vst-proof-state.json");
  const attemptStartedAt = 1_700_000_000_000;
  let now = attemptStartedAt + 46 * 60_000;
  const state = {
    version: 1,
    environment: "vst",
    symbol: "BTCUSDT",
    createdAt: attemptStartedAt,
    status: "entry_unknown_halt_no_retry",
    entry: {
      clientOrderId: "ve_archive-test",
      attemptStartedAt,
      lastError: { code: "unclassified", transportStage: "network_request" },
    },
  };
  const api = {
    async getPositions() { return []; },
    async getOpenOrders() { return []; },
    async queryOrder() {
      const error = new Error("sanitized API error");
      error.code = 109421;
      error.transportStage = "exchange_response";
      throw error;
    },
    async queryOrderHistory(_symbol, query) {
      assert.equal(query.startTs, attemptStartedAt);
      assert.equal(query.endTs, now);
      return [];
    },
    async queryFills(_symbol, query) {
      assert.equal(query.startTs, attemptStartedAt);
      assert.equal(query.endTs, now);
      assert.ok(["VST", "USDT"].includes(query.currency));
      return [];
    },
  };
  try {
    await createExclusiveProofState(statePath, state);
    await assert.rejects(
      archiveUnknownEntryNoFill({ api, state, statePath }), /confirmation_required/,
    );
    const result = await archiveUnknownEntryNoFill({
      api,
      state,
      statePath,
      clock: () => now,
      sleep: async (ms) => { now += ms; },
      operatorConfirmed: true,
    });
    assert.equal(result.status, "archived_no_fill_operator_verified");
    assert.equal(result.evidencePreserved, true);
    assert.equal(result.observationCount, 2);
    await assert.rejects(readFile(statePath, "utf8"));
    const archived = JSON.parse(await readFile(result.archivePath, "utf8"));
    assert.equal(archived.status, "archived_no_fill_operator_verified");
    assert.equal(archived.archiveNoFill.operatorConfirmed, true);
    assert.equal(archived.archiveNoFill.proof.observationCount, 2);
    assert.equal(archived.archiveNoFill.proof.observations[0].flatBtc, true);
    assert.equal(
      archived.archiveNoFill.proof.observations[1].signedOrderLookupNotFoundCode,
      "109421",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown entry archive fails closed on unavailable or incomplete evidence", async () => {
  const attemptStartedAt = 1_700_000_000_000;
  const state = {
    environment: "vst",
    symbol: "BTCUSDT",
    createdAt: attemptStartedAt,
    status: "entry_unknown_halt_no_retry",
    entry: { clientOrderId: "ve_archive-test", attemptStartedAt },
  };
  let now = attemptStartedAt + 46 * 60_000;
  const base = {
    async getPositions() { return []; },
    async getOpenOrders() { return []; },
    async queryOrder() {
      const error = new Error("not found");
      error.code = 109421;
      error.transportStage = "exchange_response";
      throw error;
    },
    async queryOrderHistory() { return []; },
    async queryFills() { return []; },
  };
  const options = {
    clock: () => now,
    sleep: async (ms) => { now += ms; },
  };
  await assert.rejects(
    verifyUnknownEntryNoFillForArchive({ ...base, queryOrderHistory: undefined }, state, options),
    /archive_evidence_unavailable/,
  );
  await assert.rejects(
    verifyUnknownEntryNoFillForArchive({
      ...base,
      async queryOrder() {
        const error = new Error("not found");
        error.code = 109421;
        error.transportStage = "network_request";
        throw error;
      },
    }, state, options),
    /archive_order_lookup_not_found_unrecognized/,
  );
  await assert.rejects(
    verifyUnknownEntryNoFillForArchive({
      ...base,
      async queryOrderHistory() {
        return [{ symbol: "BTC-USDT", clientOrderId: "ve_archive-test" }];
      },
    }, state, options),
    /archive_client_order_id_found/,
  );
  await assert.rejects(
    verifyUnknownEntryNoFillForArchive({
      ...base,
      async queryFills() { return [{ symbol: "BTC-USDT" }]; },
    }, state, options),
    /archive_btc_fills_found_or_unknown/,
  );
  await assert.rejects(
    verifyUnknownEntryNoFillForArchive(base, {
      ...state, entry: { ...state.entry, attemptStartedAt: now - 60_000 },
    }, options),
    /archive_history_window_too_short/,
  );
  const legacyProof = await verifyUnknownEntryNoFillForArchive(base, {
    ...state,
    entry: { clientOrderId: "ve_archive-test" },
  }, options);
  assert.equal(
    legacyProof.attemptTimestampSource,
    "durable_entry_intent_with_safety_grace",
  );
});

test("status without proof state still performs read-only exchange inspection", async () => {
  const exchange = await inspectStatus(null, {
    async getPositions() { return []; },
    async getOpenOrders() { return []; },
  });
  assert.equal(exchange.status, "no_vst_proof_state");
  assert.deepEqual(exchange.exchange, {
    hasBtcPosition: false,
    positionAmbiguous: false,
    hasOpenOrders: false,
    openOrderCount: 0,
  });
});