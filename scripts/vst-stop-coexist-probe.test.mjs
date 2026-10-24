import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createBingXLiveApi,
  VST_BTC_HEDGE_LONG10_SHORT75_PROBE,
} from
  "../artifacts/api-server/src/bullet-bot/bingx-live-api.mjs";
import {
  createGuardedFetch,
  persistState,
  runCli,
  runProbe,
  SHARED_VST_BTC_LOCK,
  verifyStopCoexistence,
} from "./vst-stop-coexist-probe.mjs";
import { SHARED_VST_BTC_LOCK as previousProofLock } from "./vst-proof.mjs";

const host = "https://open-api-vst.bingx.com";
const orderPath = "/openApi/swap/v2/trade/order";
const stateBase = {
  environment: "vst",
  symbol: "BTCUSDT",
  entry: {
    positionId: "position-1",
    quantity: "0.1",
    stopOrderId: "old-stop",
    stopPrice: "90",
  },
  addStop: { stopPrice: "95" },
};

test("the coexistence probe and prior VST proof script share the BTC VST operation lock", () => {
  assert.equal(SHARED_VST_BTC_LOCK, previousProofLock);
  assert.match(SHARED_VST_BTC_LOCK, /\.local\/vst-btc-operations\.lock$/);
});

function signedOrder(values) {
  const url = new URL(`${host}${orderPath}`);
  for (const [key, value] of Object.entries({
    ...values,
    recvWindow: "5000",
    timestamp: String(Date.now()),
    signature: "a".repeat(64),
  })) url.searchParams.set(key, value);
  return url;
}

test("stop probe fetch guard enforces exact VST host, signed reads, and one exact POST", async () => {
  let posts = 0;
  let deletes = 0;
  const guard = createGuardedFetch(async (_url, init) => {
    if (init.method === "POST") posts += 1;
    if (init.method === "DELETE") deletes += 1;
    return new Response("ok");
  }, {
    stage: "add-stop",
    expectedQuantity: "0.1",
    expectedStopPrice: "95",
  });
  await assert.rejects(guard("https://open-api.bingx.com/read", { method: "GET" }),
    /host isolation/);
  await assert.rejects(guard(`${host}/not-allowlisted`, { method: "GET" }),
    /read path guard/);
  const stop = signedOrder({
    symbol: "BTC-USDT", side: "SELL", positionSide: "LONG",
    type: "STOP_MARKET", quantity: "0.1", stopPrice: "95", workingType: "MARK_PRICE",
  });
  await guard(stop, { method: "POST" });
  await assert.rejects(guard(stop, { method: "POST" }), /write guard/);
  await assert.rejects(guard(stop, { method: "DELETE" }), /write guard/);
  assert.equal(posts, 1);
  assert.equal(deletes, 0);
});

test("unknown VST stop response consumes the one-write capability", async () => {
  let calls = 0;
  const guard = createGuardedFetch(async () => {
    calls += 1;
    throw new Error("mock timeout");
  }, {
    stage: "add-stop",
    expectedQuantity: "0.1",
    expectedStopPrice: "95",
  });
  const stop = signedOrder({
    symbol: "BTC-USDT", side: "SELL", positionSide: "LONG",
    type: "STOP_MARKET", quantity: "0.1", stopPrice: "95", workingType: "MARK_PRICE",
  });
  await assert.rejects(guard(stop, { method: "POST" }), /result unknown/);
  await assert.rejects(guard(stop, { method: "POST" }), /write guard/);
  assert.equal(calls, 1);
});

test("entry guard accepts only a bounded LIMIT FOK with a fresh signature timestamp", async () => {
  let posts = 0;
  const guard = createGuardedFetch(async (raw, init) => {
    if (init.method === "POST") {
      posts += 1;
      return new Response("ok");
    }
    throw new Error("unexpected read");
  }, { stage: "entry" });
  guard.authorize({
    clientOrderId: "vse_guard",
    expectedQuantity: "0.1",
    expectedPrice: "100.5",
    expectedPricePrecision: 1,
    expectedEntryStop: "98.4",
  });
  const order = signedOrder({
    symbol: "BTC-USDT", side: "BUY", positionSide: "LONG", type: "LIMIT",
    quantity: "0.1", price: "100.5", timeInForce: "FOK",
    stopLoss: '{"type":"STOP_MARKET","stopPrice":98.4}', clientOrderId: "vse_guard",
  });
  await guard(order, { method: "POST" });
  await assert.rejects(guard(order, { method: "POST" }), /write guard/);
  assert.equal(posts, 1);

  const staleGuard = createGuardedFetch(async () => {
    throw new Error("stale signed request reached transport");
  }, { stage: "entry" });
  staleGuard.authorize({
    clientOrderId: "vse_stale",
    expectedQuantity: "0.1",
    expectedPrice: "100.5",
    expectedPricePrecision: 1,
    expectedEntryStop: "98.4",
  });
  const staleOrder = signedOrder({
    symbol: "BTC-USDT", side: "BUY", positionSide: "LONG", type: "LIMIT",
    quantity: "0.1", price: "100.5", timeInForce: "FOK",
    stopLoss: '{"type":"STOP_MARKET","stopPrice":98.4}', clientOrderId: "vse_stale",
  });
  staleOrder.searchParams.set("timestamp", String(Date.now() - 5_000));
  await assert.rejects(staleGuard(staleOrder, { method: "POST" }), /write guard/);
});

test("coexistence requires both exact NEW stops on the exact position and quantity", () => {
  const stop = (orderId, price) => ({
    symbol: "BTC-USDT",
    orderId,
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionId: "position-1",
    origQty: "0.1",
    executedQty: "0",
    stopPrice: price,
    workingType: "MARK_PRICE",
  });
  const position = {
    symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
    positionId: "position-1",
  };
  const orders = [stop("old-stop", "90"), stop("new-stop", "95")];
  assert.equal(verifyStopCoexistence({
    orders, position, state: stateBase, newStopId: "new-stop",
  }), true);
  for (const bad of [
    [stop("old-stop", "90"), { ...stop("new-stop", "95"), status: "CANCELED" }],
    [stop("old-stop", "90"), { ...stop("new-stop", "95"), positionId: "other" }],
    [stop("old-stop", "90"), { ...stop("new-stop", "95"), origQty: "0.09" }],
    [stop("old-stop", "90")],
  ]) {
    assert.equal(verifyStopCoexistence({
      orders: bad, position, state: stateBase, newStopId: "new-stop",
    }), false);
  }
});

function freshTickerFetch() {
  return async (url, init) => {
    assert.equal(new URL(url).origin, host);
    assert.equal(init.method, "GET");
    return Response.json({
      code: 0,
      data: { symbol: "BTC-USDT", askPrice: "100", time: Date.now() },
    });
  };
}

function finalPreSignDenialFixture() {
  const calls = [];
  let balanceReads = 0;
  const transport = async (raw, options) => {
    const url = new URL(raw);
    calls.push({ path: url.pathname, method: options.method });
    if (options.method === "POST") {
      return Response.json({ code: 0, data: { orderId: "should-not-post" } });
    }
    let data;
    if (url.pathname === "/openApi/swap/v2/quote/ticker") {
      data = { symbol: "BTC-USDT", askPrice: "100", time: Date.now() };
    } else if (url.pathname === "/openApi/swap/v3/user/balance") {
      balanceReads += 1;
      data = [{
        asset: "VST",
        balance: "100",
        availableMargin: balanceReads === 6 ? "0" : "100",
      }];
    } else if (url.pathname === "/openApi/swap/v2/user/positions") {
      data = [];
    } else if (url.pathname === "/openApi/swap/v2/trade/openOrders") {
      data = [];
    } else if (url.pathname === "/openApi/swap/v1/positionSide/dual") {
      data = { dualSidePosition: true };
    } else if (url.pathname === "/openApi/swap/v2/trade/marginType") {
      data = { marginType: "ISOLATED" };
    } else if (url.pathname === "/openApi/swap/v2/trade/leverage") {
      data = {
        symbol: "BTC-USDT", longLeverage: 10, shortLeverage: 75,
        maxPositionLongVal: "100000",
      };
    } else if (url.pathname === "/openApi/swap/v2/quote/contracts") {
      data = [{
        symbol: "BTC-USDT", status: 1, currency: "USDT", apiStateOpen: "true",
        quantityPrecision: 4, pricePrecision: 1, tradeMinQuantity: "0.001",
        tradeMinUSDT: "5", maxLongLeverage: "10", maxShortLeverage: "75",
      }];
    } else if (url.pathname === "/openApi/swap/v1/maintMarginRatio") {
      data = [{ symbol: "BTC-USDT", maxPosition: "100000", maintMarginRatio: "0.005" }];
    } else if (url.pathname === "/openApi/swap/v2/user/commissionRate") {
      data = { makerCommissionRate: "0.0002", takerCommissionRate: "0.0005" };
    } else if (url.pathname === "/openApi/swap/v2/quote/premiumIndex") {
      data = {
        symbol: "BTC-USDT", lastFundingRate: "0.0001",
        markPrice: "100", time: Date.now(),
      };
    } else {
      throw new Error(`Unexpected mocked request ${options.method} ${url.pathname}`);
    }
    return Response.json({ code: 0, data });
  };
  const guardedFetch = createGuardedFetch(transport, { stage: "entry" });
  const api = createBingXLiveApi({
    environment: "vst",
    fetchImpl: guardedFetch,
    credentials: () => ({ key: "mock-key", secret: "mock-secret" }),
    writePermission: ({ method, path }) =>
      method === "POST" && path === orderPath,
    sleep: async () => {},
  });
  return { api, guardedFetch, calls, get balanceReads() { return balanceReads; } };
}

function entryApi({ mode = "HEDGE", preflightStatus = "ready", unknown = false } = {}) {
  let written = 0;
  let live = false;
  let submittedClientId;
  const api = {
    async contract() {
      return {
        symbol: "BTC-USDT", quantityPrecision: 4, pricePrecision: 1,
        minQuantity: 0.001, minNotional: 5,
      };
    },
    async getBalance() {
      return [{ asset: "VST", balance: "100", availableMargin: "100" }];
    },
    async getPositionMode() { return mode; },
    async getMarginType() { return "ISOLATED"; },
    async getLeverage() { return { longLeverage: 10, shortLeverage: 75 }; },
    async getPositions() {
      return live ? [{
        symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.0995",
        positionId: "position-entry",
      }] : [];
    },
    async getOpenOrders() {
      return live ? [{
        symbol: "BTC-USDT", orderId: "stop-old", type: "STOP_MARKET", status: "NEW",
        side: "SELL", positionSide: "LONG", positionId: "position-entry",
        origQty: "0.0995", executedQty: "0",
        stopPrice: "98.4", workingType: "MARK_PRICE",
      }] : [];
    },
    async preflight(symbol, options) {
      assert.equal(symbol, "BTCUSDT");
      assert.equal(options.probePolicy, VST_BTC_HEDGE_LONG10_SHORT75_PROBE);
      return {
        status: preflightStatus,
        positionMode: mode,
        blockers: preflightStatus === "ready" ? [] : ["blocked_fixture"],
        checks: {
          marginTypeIsolated: true, leverageProbePolicy: true, leverageLong10: true,
          leverageShort75: true, positionModeHedge: true, noPlannedTopUp: true,
          symbolFlat: true, symbolOpenOrdersEmpty: true,
        },
        plannedTopUpMargin: 0,
        stopRisk: { safe: preflightStatus === "ready" },
      };
    },
    async placeVstOnePercentBoundedLong(args) {
      written += 1;
      assert.ok(args.quantity);
      assert.equal(args.probePolicy, VST_BTC_HEDGE_LONG10_SHORT75_PROBE);
      submittedClientId = args.clientOrderId;
      if (unknown) throw new Error("simulated timeout");
      live = true;
      return { orderId: "entry-order" };
    },
    async queryOrderHistory() {
      return [{
        symbol: "BTC-USDT", orderId: "entry-order", clientOrderId: submittedClientId,
        side: "BUY", positionSide: "LONG", status: "FILLED",
        origQty: "0.0995", executedQty: "0.0995",
      }];
    },
    async queryFills(_symbol, { currency }) {
      assert.equal(currency, "VST");
      return [{
        symbol: "BTC-USDT", orderId: "entry-order", side: "BUY", qty: "0.0995",
      }];
    },
  };
  return { api, get writes() { return written; } };
}

test("invalid HEDGE/preflight blocks entry before any write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-stop-probe-"));
  const statePath = join(directory, "state.json");
  try {
    const blocked = entryApi({ mode: "ONE_WAY" });
    await assert.rejects(runProbe({
      command: "enter", api: blocked.api, fetchImpl: freshTickerFetch(), statePath,
    }), /entry_preflight_requires/);
    assert.equal(blocked.writes, 0);
    await assert.rejects(readFile(statePath, "utf8"), { code: "ENOENT" });

    const preflightBlocked = entryApi({ preflightStatus: "blocked" });
    await assert.rejects(runProbe({
      command: "enter", api: preflightBlocked.api,
      fetchImpl: freshTickerFetch(), statePath,
    }), /entry_preflight_blocked/);
    assert.equal(preflightBlocked.writes, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown entry result is durably halted and cannot create a duplicate write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-stop-unknown-"));
  const statePath = join(directory, "state.json");
  try {
    const fixture = entryApi({ unknown: true });
    const result = await runProbe({
      command: "enter", api: fixture.api, fetchImpl: freshTickerFetch(), statePath,
    });
    assert.equal(result.status, "entry_unknown_halt_no_retry");
    assert.equal(fixture.writes, 1);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.status, "entry_unknown_halt_no_retry");
    await assert.rejects(runProbe({
      command: "enter", api: fixture.api, fetchImpl: freshTickerFetch(), statePath,
    }), /existing_state_blocks_new_entry/);
    assert.equal(fixture.writes, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("final adapter pre-sign denial persists only its categorical reason and never POSTs or retries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-final-pre-sign-denial-"));
  const statePath = join(directory, "state.json");
  const fixture = finalPreSignDenialFixture();
  try {
    const result = await runProbe({
      command: "enter",
      api: fixture.api,
      fetchImpl: fixture.guardedFetch,
      statePath,
    });
    assert.equal(result.status, "entry_unknown_halt_no_retry");
    assert.equal(result.entry.preSignReason, "final_preflight_blocked");
    assert.equal(fixture.balanceReads, 6);
    assert.equal(fixture.calls.some((call) => call.method === "POST"), false);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.status, "entry_unknown_halt_no_retry");
    assert.equal(saved.entry.preSignReason, "final_preflight_blocked");
    assert.equal(saved.error, "BingX final pre-sign check failed");
    assert.equal(JSON.stringify(saved).includes("availableMargin"), false);
    await assert.rejects(runProbe({
      command: "enter",
      api: fixture.api,
      fetchImpl: fixture.guardedFetch,
      statePath,
    }), /existing_state_blocks_new_entry/);
    assert.equal(fixture.calls.some((call) => call.method === "POST"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function addStopApi({ unknown = false, unknownAfterSubmit = false } = {}) {
  let writes = 0;
  let submitted = false;
  const position = {
    symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
    positionId: "position-1",
  };
  const oldStop = {
    symbol: "BTC-USDT", orderId: "old-stop", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "LONG", positionId: "position-1",
    origQty: "0.1", executedQty: "0", stopPrice: "90", workingType: "MARK_PRICE",
  };
  const newStop = {
    ...oldStop, orderId: "new-stop", stopPrice: "95",
  };
  return {
    get writes() { return writes; },
    api: {
      async getPositions() { return [position]; },
      async getOpenOrders() { return submitted ? [oldStop, newStop] : [oldStop]; },
      async getPositionMode() { return "HEDGE"; },
      async getMarginType() { return "ISOLATED"; },
      async getLeverage() { return { longLeverage: 10, shortLeverage: 75 }; },
      async getVstMarkPrice() { return { markPrice: 100, timestamp: Date.now() }; },
      async placeVstAdditionalLongStop(args) {
        writes += 1;
        assert.equal(args.probePolicy, VST_BTC_HEDGE_LONG10_SHORT75_PROBE);
        assert.equal(args.positionId, "position-1");
        assert.equal(args.quantity, "0.1");
        if (unknown && !unknownAfterSubmit) throw new Error("mock timeout");
        submitted = true;
        if (unknown) throw new Error("mock timeout after transport");
        return { orderId: "new-stop" };
      },
      async queryOrderHistory() { return []; },
    },
  };
}

test("add-stop stage persists intent, never cancels, and verifies both stops remain NEW", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-stop-coexist-"));
  const statePath = join(directory, "state.json");
  const state = {
    environment: "vst",
    symbol: "BTCUSDT",
    createdAt: Date.now(),
    status: "entry_verified",
    entry: {
      positionId: "position-1", quantity: "0.1", stopOrderId: "old-stop",
      stopPrice: "90", positionMode: "HEDGE",
    },
  };
  try {
    await persistState(statePath, state, { exclusive: true });
    const fixture = addStopApi();
    const result = await runProbe({
      command: "add-stop", stopPrice: "95", api: fixture.api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    });
    assert.equal(result.status, "both_stops_observed_new_once_linkage_risk_remains");
    assert.equal(fixture.writes, 1);
    const stored = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(stored.addStop.orderId, "new-stop");
    assert.equal(stored.addStop.status, "both_observed_new_one_snapshot");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown add-stop result persists a no-retry halt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-stop-unknown-"));
  const statePath = join(directory, "state.json");
  const initial = {
    environment: "vst", symbol: "BTCUSDT", createdAt: Date.now(),
    status: "entry_verified",
    entry: {
      positionId: "position-1", quantity: "0.1", stopOrderId: "old-stop",
      stopPrice: "90", positionMode: "HEDGE",
    },
  };
  try {
    await persistState(statePath, initial, { exclusive: true });
    const fixture = addStopApi({ unknown: true });
    const result = await runProbe({
      command: "add-stop", stopPrice: "95", api: fixture.api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    });
    assert.equal(result.status, "add_stop_unknown_halt_no_retry");
    assert.equal(fixture.writes, 1);
    await assert.rejects(runProbe({
      command: "add-stop", stopPrice: "95", api: fixture.api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    }), /add_stop_requires_verified_entry/);
    assert.equal(fixture.writes, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown add-stop is read-only investigable and remains permanently non-retryable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-stop-investigate-"));
  const statePath = join(directory, "state.json");
  const initial = {
    environment: "vst", symbol: "BTCUSDT", createdAt: Date.now(),
    status: "entry_verified",
    entry: {
      positionId: "position-1", quantity: "0.1", verifiedPositionQuantity: "0.1",
      stopOrderId: "old-stop", stopPrice: "90", positionMode: "HEDGE",
    },
  };
  try {
    await persistState(statePath, initial, { exclusive: true });
    const fixture = addStopApi({ unknown: true, unknownAfterSubmit: true });
    const timedOut = await runProbe({
      command: "add-stop", stopPrice: "95", api: fixture.api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    });
    assert.equal(timedOut.status, "add_stop_unknown_halt_no_retry");
    const investigated = await runProbe({
      command: "investigate-stop", api: fixture.api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    });
    assert.equal(investigated.status, "add_stop_unknown_halt_no_retry");
    assert.equal(
      investigated.additionalStop.observation.status,
      "both_stops_visible_new_at_observation",
    );
    assert.equal(fixture.writes, 1);
    await assert.rejects(runProbe({
      command: "add-stop", stopPrice: "95", api: fixture.api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    }), /add_stop_requires_verified_entry/);
    assert.equal(fixture.writes, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("emergency-close closes only its persisted exact HEDGE position and verifies flat/no orders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-stop-close-"));
  const statePath = join(directory, "state.json");
  const initial = {
    environment: "vst", symbol: "BTCUSDT", createdAt: Date.now(),
    status: "both_stops_observed_new_once_linkage_risk_remains",
    entry: {
      positionId: "position-1", quantity: "0.1", stopOrderId: "old-stop",
      stopPrice: "90", positionMode: "HEDGE",
    },
  };
  let closed = false;
  let closeWrites = 0;
  const api = {
    async getPositions() {
      return closed ? [{
        symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0",
        positionId: "position-1",
      }] : [{
        symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
        positionId: "position-1",
      }];
    },
    async getMarginType() { return "ISOLATED"; },
    async getPositionMode() { return "HEDGE"; },
    async getLeverage() { throw new Error("emergency exit must not require leverage reads"); },
    async emergencyCloseVstLong({ symbol, quantity, clientOrderId: id, expectedPositionId }) {
      closeWrites += 1;
      assert.equal(symbol, "BTCUSDT");
      assert.equal(quantity, "0.1");
      assert.equal(expectedPositionId, "position-1");
      const saved = JSON.parse(await readFile(statePath, "utf8"));
      assert.equal(saved.status, "emergency_close_submitting");
      assert.equal(saved.emergencyClose.clientOrderId, id);
      closed = true;
      return { orderId: "close-order" };
    },
    async queryOrder() {
      return {
        symbol: "BTC-USDT", orderId: "close-order", side: "SELL",
        positionSide: "LONG", status: "FILLED", origQty: "0.1", executedQty: "0.1",
      };
    },
    async queryFills(_symbol, { currency }) {
      assert.equal(currency, "VST");
      return [{
        symbol: "BTC-USDT", orderId: "close-order", side: "SELL", qty: "0.1",
      }];
    },
    async getOpenOrders() { return []; },
  };
  try {
    await persistState(statePath, initial, { exclusive: true });
    const result = await runProbe({
      command: "emergency-close", api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    });
    assert.equal(result.status, "emergency_close_verified_flat");
    assert.equal(closeWrites, 1);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.emergencyClose.quantity, "0.1");
    assert.equal(saved.status, "emergency_close_verified_flat");
    await assert.rejects(runProbe({
      command: "emergency-close", api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    }), /emergency_close_requires_persisted_verified_position_identity/);
    assert.equal(closeWrites, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("emergency-close refuses mismatched persisted position ID or residual quantity before writing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-stop-close-mismatch-"));
  const statePath = join(directory, "state.json");
  const initial = {
    environment: "vst", symbol: "BTCUSDT", createdAt: Date.now(),
    status: "both_stops_observed_new_once_linkage_risk_remains",
    entry: {
      positionId: "position-expected", quantity: "0.1", stopOrderId: "old-stop",
      stopPrice: "90", positionMode: "HEDGE",
    },
  };
  let writes = 0;
  try {
    await persistState(statePath, initial, { exclusive: true });
    for (const position of [
      {
        symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
        positionId: "position-different",
      },
      {
        symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.09",
        positionId: "position-expected",
      },
    ]) {
      const api = {
        async getPositions() { return [position]; },
        async getMarginType() { return "ISOLATED"; },
        async getPositionMode() { return "HEDGE"; },
        async getLeverage() { throw new Error("emergency exit must not require leverage reads"); },
        async emergencyCloseVstLong() { writes += 1; },
      };
      await assert.rejects(runProbe({
        command: "emergency-close", api,
        fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
      }), /emergency_close_exact_position_preflight_failed/);
      assert.equal(writes, 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("read-only entry reconciliation persists exact position evidence despite missing child-stop read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-entry-reconcile-"));
  const statePath = join(directory, "state.json");
  let active = false;
  let clientId;
  let closed = false;
  let entryWrites = 0;
  let closeWrites = 0;
  const api = {
    async contract() {
      return {
        symbol: "BTC-USDT", quantityPrecision: 4, pricePrecision: 1,
        minQuantity: 0.001, minNotional: 5,
      };
    },
    async getBalance() {
      return [{ asset: "VST", balance: "100", availableMargin: "100" }];
    },
    async getPositionMode() { return "HEDGE"; },
    async getMarginType() { return "ISOLATED"; },
    async getLeverage() { return { longLeverage: 10, shortLeverage: 75 }; },
    async getPositions() {
      if (closed) return [{
        symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0",
        positionId: "position-recovered",
      }];
      return active ? [{
        symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.0995",
        positionId: "position-recovered",
      }] : [];
    },
    async getOpenOrders() {
      if (active && !closed) throw new Error("child stop read timeout");
      return [];
    },
    async preflight(symbol, options) {
      assert.equal(symbol, "BTCUSDT");
      assert.equal(options.probePolicy, VST_BTC_HEDGE_LONG10_SHORT75_PROBE);
      return {
        status: "ready", positionMode: "HEDGE", blockers: [],
        checks: {
          marginTypeIsolated: true, leverageProbePolicy: true, leverageLong10: true,
          leverageShort75: true, positionModeHedge: true, noPlannedTopUp: true,
          symbolFlat: true, symbolOpenOrdersEmpty: true,
        },
        plannedTopUpMargin: 0, stopRisk: { safe: true },
      };
    },
    async placeVstOnePercentBoundedLong(args) {
      entryWrites += 1;
      assert.equal(args.probePolicy, VST_BTC_HEDGE_LONG10_SHORT75_PROBE);
      clientId = args.clientOrderId;
      active = true;
      throw new Error("timeout after exchange accepted entry");
    },
    async queryOrderHistory() {
      return [{
        symbol: "BTC-USDT", clientOrderId: clientId, orderId: "entry-recovered",
        side: "BUY", positionSide: "LONG", status: "FILLED",
        origQty: "0.0995", executedQty: "0.0995",
      }];
    },
    async queryFills(_symbol, { currency }) {
      assert.equal(currency, "VST");
      return [{
        symbol: "BTC-USDT", orderId: "entry-recovered", side: "BUY", qty: "0.0995",
      }];
    },
    async emergencyCloseVstLong({
      symbol, quantity, clientOrderId: closeId, expectedPositionId,
    }) {
      closeWrites += 1;
      assert.equal(symbol, "BTCUSDT");
      assert.equal(quantity, "0.0995");
      assert.equal(expectedPositionId, "position-recovered");
      const reserved = JSON.parse(await readFile(statePath, "utf8"));
      assert.equal(reserved.status, "emergency_close_submitting");
      assert.equal(reserved.emergencyClose.clientOrderId, closeId);
      closed = true;
      return { orderId: "close-recovered" };
    },
    async queryOrder(_symbol, identifier) {
      assert.equal(identifier.orderId, "close-recovered");
      return {
        symbol: "BTC-USDT", orderId: "close-recovered", side: "SELL",
        positionSide: "LONG", status: "FILLED",
        origQty: "0.0995", executedQty: "0.0995",
      };
    },
  };
  try {
    const entered = await runProbe({
      command: "enter", api, fetchImpl: freshTickerFetch(), statePath,
    });
    assert.equal(entered.status, "entry_unknown_halt_no_retry");
    assert.equal(entryWrites, 1);

    const recovered = await runProbe({
      command: "reconcile-entry", api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    });
    assert.equal(recovered.status, "entry_position_reconciled_stop_unknown");
    assert.equal(recovered.entry.positionId, "position-recovered");
    assert.equal(recovered.recovery.quantity, "0.0995");
    assert.match(recovered.recovery.attachedStopObservation, /open_order_read_failed/);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.entry.positionId, "position-recovered");
    assert.equal(saved.entry.verifiedPositionQuantity, "0.0995");

    api.getOpenOrders = async () => [];
    api.getLeverage = async () => {
      throw new Error("emergency exit must not require leverage reads");
    };
    api.queryFills = async (_symbol, { currency }) => {
      assert.equal(currency, "VST");
      return [{
        symbol: "BTC-USDT", orderId: "close-recovered", side: "SELL", qty: "0.0995",
      }];
    };
    const closedResult = await runProbe({
      command: "emergency-close", api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    });
    assert.equal(closedResult.status, "emergency_close_verified_flat");
    assert.equal(entryWrites, 1);
    assert.equal(closeWrites, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function unknownCloseState() {
  const createdAt = Date.now() - 120_000;
  return {
    version: 1,
    environment: "vst",
    symbol: "BTCUSDT",
    createdAt,
    status: "emergency_close_unknown_halt_no_retry",
    entry: {
      clientOrderId: "vse_persisted-entry",
      orderId: "entry-exact-9",
      positionId: "position-before-close",
      quantity: "0.1155",
      verifiedPositionQuantity: "0.1155",
      stopOrderId: "original-stop",
      stopPrice: "90.0",
      positionMode: "HEDGE",
      reconciliation: {
        status: "verified_position_and_visible_stop",
        positionId: "position-before-close",
        quantity: "0.1155",
        fillsVerified: true,
        orderHistoryVerified: true,
        positionVerified: true,
        attachedStopObservation: "visible_new_matching_position",
      },
    },
    emergencyClose: {
      clientOrderId: "vsc_persisted-close",
      quantity: "0.1155",
      positionId: "position-before-close",
      startedAt: createdAt + 30_000,
    },
  };
}

function closeHistoryOrder(clientOrderId) {
  return {
    symbol: "BTC-USDT",
    orderId: "close-exact-17",
    clientOrderId,
    side: "SELL",
    positionSide: "LONG",
    type: "MARKET",
    status: "FILLED",
    origQty: "0.1155",
    executedQty: "0.1155",
    positionId: "position-before-close",
  };
}

function closeReconcileApi({
  history,
  positions = [],
  failFills = false,
  stopStatus = "CANCELED",
  omitStopPositionId = false,
  stopPositionId = "position-before-close",
} = {}) {
  let closeWrites = 0;
  const stop = {
    symbol: "BTC-USDT",
    orderId: "original-stop",
    type: "STOP_MARKET",
    status: stopStatus,
    side: "SELL",
    positionSide: "LONG",
    origQty: "0.1155",
    executedQty: "0",
    stopPrice: "90.0",
    workingType: "MARK_PRICE",
  };
  if (!omitStopPositionId) stop.positionId = stopPositionId;
  const close = closeHistoryOrder("vsc_persisted-close");
  return {
    get closeWrites() { return closeWrites; },
    api: {
      async getPositions() { return positions; },
      async getOpenOrders() { return []; },
      async queryOrderHistory() { return history ?? [close]; },
      async queryOrder(_symbol, identifier) {
        if (identifier.orderId === "original-stop") return stop;
        if (identifier.orderId === "close-exact-17") return close;
        throw new Error("unexpected_order_lookup");
      },
      async queryFills(_symbol, { orderId, currency }) {
        assert.equal(currency, "VST");
        if (failFills) throw new Error("fills read unavailable");
        if (orderId === "original-stop") return [];
        if (orderId === "close-exact-17") return [
          {
            symbol: "BTC-USDT", orderId, side: "SELL", qty: "0.05",
            positionId: "position-before-close",
          },
          {
            symbol: "BTC-USDT", orderId, side: "SELL", qty: "0.0655",
            positionId: "position-before-close",
          },
        ];
        throw new Error("unexpected_fill_lookup");
      },
      async closeLong() { closeWrites += 1; throw new Error("must remain read-only"); },
    },
  };
}

test("rounded close response reconciles only from exact history/fills and two delayed flat snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-close-reconcile-"));
  const statePath = join(directory, "state.json");
  let closed = false;
  let closeWrites = 0;
  let submittedCloseClientId;
  const historyReadAt = [];
  const initial = {
    ...unknownCloseState(),
    status: "entry_verified",
  };
  const closeOrder = closeHistoryOrder("unused-until-submission");
  const stop = {
    symbol: "BTC-USDT", orderId: "original-stop", type: "STOP_MARKET",
    status: "CANCELED", side: "SELL", positionSide: "LONG",
    positionId: "position-before-close", origQty: "0.1155",
    executedQty: "0", stopPrice: "90.0", workingType: "MARK_PRICE",
  };
  const api = {
    async getPositions() {
      return closed ? [] : [{
        symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1155",
        positionId: "position-before-close",
      }];
    },
    async getOpenOrders() { return []; },
    async getPositionMode() { return "HEDGE"; },
    async getMarginType() { return "ISOLATED"; },
    async getLeverage() { return { longLeverage: 10, shortLeverage: 75 }; },
    async emergencyCloseVstLong({
      symbol, quantity, clientOrderId: clientId, expectedPositionId,
    }) {
      closeWrites += 1;
      assert.equal(symbol, "BTCUSDT");
      assert.equal(quantity, "0.1155");
      assert.equal(expectedPositionId, "position-before-close");
      submittedCloseClientId = clientId;
      closed = true;
      // Simulate the rounded/non-lossless write response that caused the
      // original close stage to halt without a retry.
      return { orderId: 9007199254740993 };
    },
    async queryOrderHistory(_symbol, { startTs, endTs }) {
      historyReadAt.push(Date.now());
      assert.ok(startTs <= Date.now());
      assert.ok(endTs >= startTs);
      return [{
        ...closeOrder,
        clientOrderId: submittedCloseClientId,
      }];
    },
    async queryOrder(_symbol, identifier) {
      if (identifier.orderId === "original-stop") return stop;
      if (identifier.orderId === "close-exact-17") return {
        ...closeOrder, clientOrderId: submittedCloseClientId,
      };
      throw new Error("unexpected_order_lookup");
    },
    async queryFills(_symbol, { orderId, currency }) {
      assert.equal(currency, "VST");
      if (orderId === "original-stop") return [];
      if (orderId === "close-exact-17") return [
        { symbol: "BTC-USDT", orderId, side: "SELL", qty: "0.05" },
        { symbol: "BTC-USDT", orderId, side: "SELL", qty: "0.0655" },
      ];
      throw new Error("unexpected_fill_lookup");
    },
  };
  try {
    await persistState(statePath, initial, { exclusive: true });
    const unknown = await runProbe({
      command: "emergency-close", api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    });
    assert.equal(unknown.status, "emergency_close_unknown_halt_no_retry");
    assert.equal(closeWrites, 1);
    const reconciled = await runProbe({
      command: "reconcile-close", api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    });
    assert.equal(reconciled.status, "emergency_close_verified_closed");
    assert.equal(reconciled.emergencyClose.orderId, "close-exact-17");
    assert.equal(reconciled.emergencyClose.reconciliation.status, "verified_closed");
    assert.ok(reconciled.emergencyClose.reconciliation.separationMs >= 10_000);
    assert.equal(historyReadAt.length, 2);
    assert.ok(historyReadAt[1] - historyReadAt[0] >= 10_000);
    assert.equal(closeWrites, 1);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.status, "emergency_close_verified_closed");
    assert.equal(saved.emergencyClose.reconciliation.status, "verified_closed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CANCELLED original stop without positionId requires the persisted exact NEW-stop linkage proof", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-close-stop-no-position-id-"));
  const statePath = join(directory, "state.json");
  try {
    await persistState(statePath, unknownCloseState(), { exclusive: true });
    const fixture = closeReconcileApi({
      stopStatus: "CANCELLED",
      omitStopPositionId: true,
    });
    const reconciled = await runProbe({
      command: "reconcile-close", api: fixture.api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    });
    assert.equal(reconciled.status, "emergency_close_verified_closed");
    assert.equal(reconciled.emergencyClose.reconciliation.status, "verified_closed");
    assert.equal(fixture.closeWrites, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("close reconciliation rejects unrelated sells, residual positions, and read failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-close-reconcile-reject-"));
  const statePath = join(directory, "state.json");
  try {
    const unrelated = closeReconcileApi({
      history: [{
        ...closeHistoryOrder("some-other-close"),
        orderId: "unrelated-sell",
      }],
    });
    await persistState(statePath, unknownCloseState());
    await assert.rejects(runProbe({
      command: "reconcile-close", api: unrelated.api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    }), /close_reconcile_close_client_id_not_unique_in_history/);
    assert.equal(unrelated.closeWrites, 0);
    let saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.status, "emergency_close_unknown_halt_no_retry");
    assert.equal(saved.emergencyClose.reconciliation.status, "rejected");

    const residual = closeReconcileApi({
      positions: [{
        symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.001",
        positionId: "position-before-close",
      }],
    });
    await persistState(statePath, unknownCloseState());
    await assert.rejects(runProbe({
      command: "reconcile-close", api: residual.api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    }), /close_reconcile_residual_or_ambiguous_btc_position/);
    assert.equal(residual.closeWrites, 0);

    const unreadable = closeReconcileApi({ failFills: true });
    await persistState(statePath, unknownCloseState());
    await assert.rejects(runProbe({
      command: "reconcile-close", api: unreadable.api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    }), /fills read unavailable/);
    saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.status, "emergency_close_unknown_halt_no_retry");
    assert.equal(unreadable.closeWrites, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("absent or mismatched stop position IDs do not pass without exact persisted linkage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-close-stop-linkage-reject-"));
  const statePath = join(directory, "state.json");
  try {
    const noPersistedProof = unknownCloseState();
    delete noPersistedProof.entry.reconciliation;
    const cases = [
      {
        state: noPersistedProof,
        api: closeReconcileApi({
          stopStatus: "CANCELLED",
          omitStopPositionId: true,
        }).api,
      },
      {
        state: unknownCloseState(),
        api: closeReconcileApi({
          stopStatus: "CANCELLED",
          stopPositionId: "different-position",
        }).api,
      },
    ];
    for (const { state, api } of cases) {
      await persistState(statePath, state);
      await assert.rejects(runProbe({
        command: "reconcile-close", api,
        fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
      }), /close_reconcile_original_stop_not_canceled_without_fills/);
      const saved = JSON.parse(await readFile(statePath, "utf8"));
      assert.equal(saved.status, "emergency_close_unknown_halt_no_retry");
      assert.equal(saved.emergencyClose.reconciliation.status, "rejected");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function reconciledEntryState() {
  const state = unknownCloseState();
  delete state.emergencyClose;
  state.status = "entry_position_reconciled_stop_unknown";
  state.entry.reconciliation.orderId = "entry-exact-9";
  return state;
}

function activeOriginalStop(overrides = {}) {
  return {
    symbol: "BTC-USDT",
    orderId: "original-stop",
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionId: "position-before-close",
    origQty: "0.1155",
    executedQty: "0",
    stopPrice: "90.0",
    workingType: "MARK_PRICE",
    ...overrides,
  };
}

function entryProtectionApi({ positions, orders } = {}) {
  let writes = 0;
  let positionReads = 0;
  let orderReads = 0;
  const positionRows = positions ?? [{
    symbol: "BTC-USDT",
    positionSide: "LONG",
    positionAmt: "0.1155",
    positionId: "position-before-close",
  }];
  const orderRows = orders ?? [activeOriginalStop()];
  return {
    get writes() { return writes; },
    get positionReads() { return positionReads; },
    get orderReads() { return orderReads; },
    api: {
      async getPositions() { positionReads += 1; return positionRows; },
      async getOpenOrders() {
        orderReads += 1;
        return typeof orderRows === "function" ? orderRows(orderReads) : orderRows;
      },
      async placeVstAdditionalLongStop() { writes += 1; },
      async closeLong() { writes += 1; },
    },
  };
}

function unknownEntryState({ createdAt = Date.now() - 30_000 } = {}) {
  return {
    version: 1,
    environment: "vst",
    symbol: "BTCUSDT",
    createdAt,
    status: "entry_unknown_halt_no_retry",
    entry: {
      clientOrderId: "vse_unknown-entry",
      quantity: "0.1155",
      maxEntryPrice: "100.0",
      stopPrice: "90.0",
      positionMode: "HEDGE",
    },
  };
}

function noFillArchiveApi({
  orderLookups,
  histories,
  vstFills,
  usdtFills,
  positions,
  orders,
  failHistory,
} = {}) {
  const counts = {
    orderLookups: 0, histories: 0, vstFills: 0, usdtFills: 0,
    positions: 0, orders: 0, writes: 0,
  };
  const valueAt = (values, index, fallback = []) => {
    if (values === undefined) return fallback;
    const value = values[Math.min(index, values.length - 1)];
    if (value instanceof Error) throw value;
    return value;
  };
  const api = {
    async queryOrder(_symbol, identifier) {
      counts.orderLookups += 1;
      assert.equal(identifier.clientOrderId, "vse_unknown-entry");
      const result = valueAt(orderLookups, counts.orderLookups - 1, null);
      if (result !== null) return result;
      const notFound = new Error("BingX request failed");
      notFound.code = 109421;
      notFound.transportStage = "exchange_response";
      throw notFound;
    },
    async getPositions() {
      counts.positions += 1;
      return valueAt(positions, counts.positions - 1);
    },
    async getOpenOrders() {
      counts.orders += 1;
      return valueAt(orders, counts.orders - 1);
    },
    async queryOrderHistory(_symbol, range) {
      counts.histories += 1;
      assert.ok(range.startTs < Date.now());
      assert.ok(range.endTs >= range.startTs);
      if (failHistory) throw new Error("history read failed");
      return valueAt(histories, counts.histories - 1);
    },
    async queryFills(_symbol, { currency, startTs, endTs }) {
      assert.ok(startTs < Date.now());
      assert.ok(endTs >= startTs);
      if (currency === "VST") {
        counts.vstFills += 1;
        return valueAt(vstFills, counts.vstFills - 1);
      }
      assert.equal(currency, "USDT");
      counts.usdtFills += 1;
      return valueAt(usdtFills, counts.usdtFills - 1);
    },
    async placeVstOnePercentBoundedLong() { counts.writes += 1; },
    async closeLong() { counts.writes += 1; },
  };
  return { api, counts };
}

test("reconcile-entry rejects a conflicting explicit parent ID on the initially visible stop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-entry-parent-initial-"));
  const statePath = join(directory, "state.json");
  let writes = 0;
  const api = {
    async queryOrderHistory() {
      return [{
        symbol: "BTC-USDT", orderId: "entry-exact-9",
        clientOrderId: "vse_unknown-entry", side: "BUY", positionSide: "LONG",
        status: "FILLED", origQty: "0.1155", executedQty: "0.1155",
      }];
    },
    async queryFills(_symbol, { currency }) {
      assert.equal(currency, "VST");
      return [{
        symbol: "BTC-USDT", orderId: "entry-exact-9", side: "BUY", qty: "0.1155",
      }];
    },
    async getPositions() {
      return [{
        symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1155",
        positionId: "position-before-close",
      }];
    },
    async getOpenOrders() {
      return [activeOriginalStop({ parentOrderId: "different-entry-order" })];
    },
    async placeVstOnePercentBoundedLong() { writes += 1; },
    async closeLong() { writes += 1; },
  };
  try {
    await persistState(statePath, unknownEntryState(), { exclusive: true });
    const result = await runProbe({
      command: "reconcile-entry", api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    });
    assert.equal(result.status, "entry_position_reconciled_stop_unknown");
    assert.equal(result.entry.originalStopOrderId, null);
    assert.equal(result.recovery.attachedStopObservation,
      "missing_mismatched_or_competing_btc_orders");
    assert.equal(writes, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("confirm-entry-protection requires two delayed exact position and same-stop reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-entry-protection-confirm-"));
  const statePath = join(directory, "state.json");
  const fixture = entryProtectionApi();
  try {
    await persistState(statePath, reconciledEntryState(), { exclusive: true });
    const confirmed = await runProbe({
      command: "confirm-entry-protection", api: fixture.api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    });
    assert.equal(confirmed.status, "entry_verified");
    assert.equal(confirmed.entryProtectionConfirmation.status, "verified");
    assert.equal(confirmed.entryProtectionConfirmation.firstSnapshot.stopOrderId, "original-stop");
    assert.equal(confirmed.entryProtectionConfirmation.secondSnapshot.stopOrderId, "original-stop");
    assert.ok(confirmed.entryProtectionConfirmation.separationMs >= 10_000);
    assert.equal(fixture.positionReads, 2);
    assert.equal(fixture.orderReads, 2);
    assert.equal(fixture.writes, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("both delayed entry-protection snapshots reject conflicting explicit parent IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-entry-parent-confirm-"));
  const statePath = join(directory, "state.json");
  try {
    const firstMismatch = entryProtectionApi({
      orders: () => [activeOriginalStop({ mainOrderId: "other-entry" })],
    });
    await persistState(statePath, reconciledEntryState(), { exclusive: true });
    await assert.rejects(runProbe({
      command: "confirm-entry-protection", api: firstMismatch.api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    }), /entry_protection_exact_stop_not_active_or_competing_order_present/);
    assert.equal(firstMismatch.orderReads, 1);
    assert.equal(firstMismatch.writes, 0);

    const secondMismatch = entryProtectionApi({
      orders: (read) => [activeOriginalStop(
        read === 1 ? {} : { parentOrderId: "different-entry" },
      )],
    });
    await persistState(statePath, reconciledEntryState());
    await assert.rejects(runProbe({
      command: "confirm-entry-protection", api: secondMismatch.api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    }), /entry_protection_exact_stop_not_active_or_competing_order_present/);
    assert.equal(secondMismatch.orderReads, 2);
    assert.equal(secondMismatch.writes, 0);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.status, "entry_position_reconciled_stop_unknown");
    assert.equal(saved.entry.reconciliation.status, "verified_position_and_visible_stop");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("entry protection confirmation rejects changed position/stop, old or missing IDs, closed state, and unknown entry write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-entry-protection-reject-"));
  const statePath = join(directory, "state.json");
  try {
    const cases = [
      {
        state: reconciledEntryState(),
        fixture: entryProtectionApi({
          positions: [{
            symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1155",
            positionId: "different-position",
          }],
        }),
        error: /entry_protection_position_changed_or_ambiguous/,
      },
      {
        state: reconciledEntryState(),
        fixture: entryProtectionApi({
          positions: [{
            symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1145",
            positionId: "position-before-close",
          }],
        }),
        error: /entry_protection_position_changed_or_ambiguous/,
      },
      {
        state: reconciledEntryState(),
        fixture: entryProtectionApi({ orders: [activeOriginalStop({ stopPrice: "89.9" })] }),
        error: /entry_protection_exact_stop_not_active/,
      },
      {
        state: reconciledEntryState(),
        fixture: entryProtectionApi({ orders: [activeOriginalStop({ orderId: "old-stop-id" })] }),
        error: /entry_protection_exact_stop_not_active/,
      },
      {
        state: (() => {
          const state = reconciledEntryState();
          delete state.entry.stopOrderId;
          return state;
        })(),
        fixture: entryProtectionApi(),
        error: /entry_protection_requires_persisted_exact_entry/,
      },
      {
        state: (() => {
          const state = reconciledEntryState();
          state.status = "emergency_close_verified_closed";
          return state;
        })(),
        fixture: entryProtectionApi(),
        error: /entry_protection_requires_persisted_exact_entry/,
      },
      {
        state: (() => {
          const state = reconciledEntryState();
          state.status = "entry_unknown_halt_no_retry";
          return state;
        })(),
        fixture: entryProtectionApi(),
        error: /entry_protection_requires_persisted_exact_entry/,
      },
    ];
    for (const { state, fixture, error } of cases) {
      await persistState(statePath, state);
      await assert.rejects(runProbe({
        command: "confirm-entry-protection", api: fixture.api,
        fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
      }), error);
      const saved = JSON.parse(await readFile(statePath, "utf8"));
      assert.equal(saved.status, state.status);
      if (state.status === "entry_position_reconciled_stop_unknown") {
        assert.equal(saved.entry.reconciliation.status, "verified_position_and_visible_stop");
      }
      assert.equal(fixture.writes, 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function verifiedClosedState() {
  const state = unknownCloseState();
  const observedAt = Date.now() - 30_000;
  state.status = "emergency_close_verified_closed";
  state.emergencyClose.orderId = "close-exact-17";
  const snapshot = (time) => ({
    observedAt: time,
    orderId: "close-exact-17",
    positionId: "position-before-close",
    quantity: "0.1155",
    closeFillsVerified: true,
    originalStopId: "original-stop",
    originalStopCanceledNoFills: true,
    flatBtcPositionRows: 0,
    openOrdersEmpty: true,
  });
  state.emergencyClose.reconciliation = {
    status: "verified_closed",
    firstSnapshot: snapshot(observedAt),
    secondSnapshot: snapshot(observedAt + 10_001),
    separationMs: 10_001,
  };
  return state;
}

test("archive-closed requires persisted close proof plus fresh delayed flat/no-order reads and preserves audit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-archive-closed-"));
  const statePath = join(directory, "state.json");
  const readTimes = [];
  let writes = 0;
  const api = {
    async getPositions() { readTimes.push(Date.now()); return []; },
    async getOpenOrders() { return []; },
    async closeLong() { writes += 1; },
    async placeVstAdditionalLongStop() { writes += 1; },
  };
  try {
    await persistState(statePath, verifiedClosedState(), { exclusive: true });
    const archived = await runProbe({
      command: "archive-closed", api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    });
    assert.equal(archived.status, "archived_closed");
    assert.ok(archived.archivePath);
    assert.ok(readTimes.length >= 2);
    assert.ok(readTimes[1] - readTimes[0] >= 10_000);
    assert.equal(writes, 0);
    const audit = JSON.parse(await readFile(archived.archivePath, "utf8"));
    assert.equal(audit.status, "emergency_close_verified_closed");
    assert.equal(audit.entry.clientOrderId, "vse_persisted-entry");
    assert.equal(audit.emergencyClose.clientOrderId, "vsc_persisted-close");
    assert.equal(audit.archiveClosed.status, "verified");
    assert.equal(audit.archiveClosed.firstSnapshot.openOrdersEmpty, true);
    assert.equal(audit.archiveClosed.secondSnapshot.openOrdersEmpty, true);
    assert.equal((await runProbe({
      command: "status", api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    })).status, "no_probe_state");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("archive-closed rejects an unverified or nonterminal close without exchange reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-archive-closed-reject-"));
  const statePath = join(directory, "state.json");
  let reads = 0;
  const api = {
    async getPositions() { reads += 1; return []; },
    async getOpenOrders() { reads += 1; return []; },
  };
  try {
    const unverified = verifiedClosedState();
    unverified.emergencyClose.reconciliation.secondSnapshot.orderId = "different-close";
    await persistState(statePath, unverified, { exclusive: true });
    await assert.rejects(runProbe({
      command: "archive-closed", api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    }), /archive_closed_requires_exact_persisted_two_snapshot_close_proof/);
    assert.equal(reads, 0);
    const unknown = verifiedClosedState();
    unknown.status = "emergency_close_unknown_halt_no_retry";
    await persistState(statePath, unknown);
    await assert.rejects(runProbe({
      command: "archive-closed", api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    }), /archive_closed_requires_exact_persisted_two_snapshot_close_proof/);
    assert.equal(reads, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("archive-closed rejects residual BTC exposure in the second fresh snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-archive-closed-residual-"));
  const statePath = join(directory, "state.json");
  let positionReads = 0;
  let writes = 0;
  const api = {
    async getPositions() {
      positionReads += 1;
      return positionReads === 1 ? [] : [{
        symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.0001",
        positionId: "unexpected-residual",
      }];
    },
    async getOpenOrders() { return []; },
    async closeLong() { writes += 1; },
    async placeVstAdditionalLongStop() { writes += 1; },
  };
  try {
    await persistState(statePath, verifiedClosedState(), { exclusive: true });
    await assert.rejects(runProbe({
      command: "archive-closed", api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    }), /archive_closed_rejected:close_reconcile_residual_or_ambiguous_btc_position/);
    assert.equal(positionReads, 2);
    assert.equal(writes, 0);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.status, "emergency_close_verified_closed");
    assert.equal(saved.archiveClosed.status, "rejected");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("operator-confirmed archive-no-fill waits, verifies both fill currencies, and archives intent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-archive-no-fill-"));
  const statePath = join(directory, "state.json");
  const attemptStartedAt = Date.now() - 150_500;
  const fixture = noFillArchiveApi();
  try {
    await persistState(statePath, unknownEntryState({ createdAt: attemptStartedAt }), {
      exclusive: true,
    });
    const archived = await runProbe({
      command: "archive-no-fill",
      operatorConfirmed: true,
      api: fixture.api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); },
      statePath,
    });
    assert.equal(archived.status, "archived_no_fill_operator_verified");
    assert.equal(archived.noFillArchive.status, "verified");
    assert.ok(archived.noFillArchive.separationMs >= 10_000);
    assert.equal(fixture.counts.orderLookups, 2);
    assert.equal(fixture.counts.histories, 2);
    assert.equal(fixture.counts.vstFills, 2);
    assert.equal(fixture.counts.usdtFills, 2);
    assert.equal(fixture.counts.positions, 4);
    assert.equal(fixture.counts.orders, 4);
    assert.equal(fixture.counts.writes, 0);
    const audit = JSON.parse(await readFile(archived.archivePath, "utf8"));
    assert.equal(audit.status, "archived_no_fill_operator_verified");
    assert.equal(audit.entry.clientOrderId, "vse_unknown-entry");
    assert.equal(audit.entry.noFillArchive.firstObservation.clientOrderId,
      "vse_unknown-entry");
    assert.equal((await runProbe({
      command: "status", api: fixture.api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); }, statePath,
    })).status, "no_probe_state");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("archive-no-fill requires operator confirmation and a full two-minute history window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-archive-no-fill-early-"));
  const statePath = join(directory, "state.json");
  const fixture = noFillArchiveApi();
  try {
    await persistState(statePath, unknownEntryState(), { exclusive: true });
    await assert.rejects(runProbe({
      command: "archive-no-fill", api: fixture.api, statePath,
    }), /confirmation_required/);
    await assert.rejects(runCli(["archive-no-fill"], {
      api: fixture.api, statePath,
    }), /confirmation_required/);
    await assert.rejects(runProbe({
      command: "archive-no-fill", operatorConfirmed: true,
      api: fixture.api, statePath,
    }), /archive_no_fill_history_window_too_short/);
    assert.deepEqual(fixture.counts, {
      orderLookups: 0, histories: 0, vstFills: 0, usdtFills: 0,
      positions: 0, orders: 0, writes: 0,
    });
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).status,
      "entry_unknown_halt_no_retry");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("archive-no-fill rejects delayed order, history, fill, or position evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-archive-no-fill-late-"));
  const statePath = join(directory, "state.json");
  const clientOrderId = "vse_unknown-entry";
  const lateOrder = {
    symbol: "BTC-USDT", orderId: "late-entry-order", clientOrderId,
    side: "BUY", positionSide: "LONG", type: "LIMIT", status: "FILLED",
    origQty: "0.1155", executedQty: "0.1155",
  };
  const cases = [
    {
      fixture: noFillArchiveApi({ orderLookups: [null, lateOrder] }),
      error: /archive_no_fill_rejected:archive_no_fill_order_lookup_found/,
    },
    {
      fixture: noFillArchiveApi({ histories: [[], [lateOrder]] }),
      error: /archive_no_fill_rejected:archive_no_fill_client_order_id_found/,
    },
    {
      fixture: noFillArchiveApi({
        vstFills: [[], [{
          symbol: "BTC-USDT", orderId: "late-entry-order", side: "BUY", qty: "0.1155",
        }]],
      }),
      error: /archive_no_fill_rejected:archive_no_fill_btc_fills_found_or_unknown/,
    },
    {
      fixture: noFillArchiveApi({
        positions: [[], [], [], [{
          symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1155",
          positionId: "late-position",
        }]],
      }),
      error: /archive_no_fill_rejected:close_reconcile_residual_or_ambiguous_btc_position/,
    },
  ];
  try {
    for (const { fixture, error } of cases) {
      await persistState(statePath, unknownEntryState({
        createdAt: Date.now() - 150_500,
      }));
      await assert.rejects(runProbe({
        command: "archive-no-fill", operatorConfirmed: true,
        api: fixture.api,
        fetchImpl: async () => { throw new Error("unexpected fetch"); },
        statePath,
      }), error);
      const saved = JSON.parse(await readFile(statePath, "utf8"));
      assert.equal(saved.status, "entry_unknown_halt_no_retry");
      assert.equal(saved.entry.noFillArchive.status, "rejected");
      assert.equal(fixture.counts.writes, 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("archive-no-fill preserves unknown intent and rejects every evidence read error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vst-archive-no-fill-read-error-"));
  const statePath = join(directory, "state.json");
  const fixture = noFillArchiveApi({ failHistory: true });
  try {
    await persistState(statePath, unknownEntryState({
      createdAt: Date.now() - 150_500,
    }), { exclusive: true });
    await assert.rejects(runProbe({
      command: "archive-no-fill", operatorConfirmed: true,
      api: fixture.api,
      fetchImpl: async () => { throw new Error("unexpected fetch"); },
      statePath,
    }), /archive_no_fill_rejected:history read failed/);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.status, "entry_unknown_halt_no_retry");
    assert.equal(saved.entry.clientOrderId, "vse_unknown-entry");
    assert.equal(saved.entry.noFillArchive.status, "rejected");
    assert.equal(fixture.counts.writes, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});