import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  createBingXLiveApi,
  createBingXOutboundPacer,
} from "../bingx-live-api.mjs";

const BASE_URL = "https://open-api-vst.bingx.com";
const ORDER_PATH = "/openApi/swap/v2/trade/order";
const BALANCE_PATH = "/openApi/swap/v3/user/balance";

function fixture({
  responses = {},
  fetchImpl,
  permission = false,
  onTransientGetDiagnostic,
} = {}) {
  let now = 1_700_000_000_000;
  const sleeps = [];
  const calls = [];
  const queues = new Map(
    Object.entries(responses).map(([key, values]) => [key, [...values]]),
  );
  const clock = () => now++;
  const sleep = async (ms) => {
    sleeps.push(ms);
    now += ms;
  };
  const transport = fetchImpl ?? (async (rawUrl, options) => {
    const url = new URL(rawUrl);
    calls.push({ url, options });
    assert.equal(url.origin, BASE_URL);
    assert.equal(options.headers["X-BX-APIKEY"], "test-key");
    const signingText = [...url.searchParams.entries()]
      .filter(([key]) => key !== "signature")
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, value]) => `${key}=${value}`)
      .join("&");
    assert.equal(
      url.searchParams.get("signature"),
      createHmac("sha256", "test-secret").update(signingText).digest("hex"),
    );

    const key = `${options.method} ${url.pathname}`;
    const queued = queues.get(key);
    const next = queued?.shift();
    if (next instanceof Error) throw next;
    const response = next ?? { code: 0, data: [] };
    if (response?.readError instanceof Error) {
      return {
        ok: true,
        status: 200,
        text: async () => { throw response.readError; },
      };
    }
    return new Response(
      typeof response === "string" ? response : JSON.stringify(response),
      { status: response?.httpStatus ?? 200 },
    );
  });
  const api = createBingXLiveApi({
    environment: "vst",
    fetchImpl: transport,
    clock,
    sleep,
    random: () => 0.5,
    requestPacer: createBingXOutboundPacer({ gapMs: 0, clock, sleep }),
    credentials: () => ({ key: "test-key", secret: "test-secret" }),
    writePermission: async () => permission,
    onTransientGetDiagnostic,
  });
  return { api, calls, sleeps };
}

function callsFor(calls, method, path) {
  return calls.filter(({ url, options }) =>
    options.method === method && url.pathname === path);
}

test("VST signed GET retries one documented 109500 response with a fresh signature", async () => {
  const diagnostics = [];
  const { api, calls, sleeps } = fixture({
    responses: {
      [`GET ${BALANCE_PATH}`]: [
        { code: 109500, msg: "system busy" },
        { code: 0, data: [{ asset: "VST", availableMargin: "100" }] },
      ],
    },
    onTransientGetDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  const balance = await api.getBalance();
  const attempts = callsFor(calls, "GET", BALANCE_PATH);
  assert.equal(balance[0].asset, "VST");
  assert.equal(attempts.length, 2);
  assert.notEqual(
    attempts[0].url.searchParams.get("timestamp"),
    attempts[1].url.searchParams.get("timestamp"),
  );
  assert.notEqual(
    attempts[0].url.searchParams.get("signature"),
    attempts[1].url.searchParams.get("signature"),
  );
  assert.ok(sleeps.some((ms) => ms >= 2_000 && ms <= 2_500));
  assert.deepEqual(diagnostics, [{
    endpoint: BALANCE_PATH,
    method: "GET",
    outcome: "retry_scheduled",
    reason: "exchange_busy",
    code: 109500,
  }]);
});

test("repeated 109500 stops after one retry and preserves safe error context", async () => {
  const diagnostics = [];
  const { api, calls } = fixture({
    responses: {
      [`GET ${BALANCE_PATH}`]: [
        { code: 109500, msg: "first busy response" },
        { code: 109500, msg: "still busy" },
      ],
    },
    onTransientGetDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  await assert.rejects(api.getBalance(), (error) =>
    error.code === 109500 &&
    error.exchangeMessage === "still busy" &&
    error.endpoint === BALANCE_PATH &&
    error.method === "GET" &&
    error.transportStage === "exchange_response" &&
    error.message.includes(BALANCE_PATH));
  assert.equal(callsFor(calls, "GET", BALANCE_PATH).length, 2);
  assert.equal(diagnostics.length, 1);
  assert.equal(JSON.stringify(diagnostics).includes("signature"), false);
});

test("VST signed GET retries a timed-out network request once", async () => {
  const diagnostics = [];
  const { api, calls, sleeps } = fixture({
    responses: {
      [`GET ${BALANCE_PATH}`]: [
        new DOMException("timed out", "TimeoutError"),
        { code: 0, data: [{ asset: "VST" }] },
      ],
    },
    onTransientGetDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  assert.equal((await api.getBalance())[0].asset, "VST");
  const attempts = callsFor(calls, "GET", BALANCE_PATH);
  assert.equal(attempts.length, 2);
  assert.notEqual(
    attempts[0].url.searchParams.get("signature"),
    attempts[1].url.searchParams.get("signature"),
  );
  assert.ok(sleeps.some((ms) => ms >= 2_000));
  assert.equal(diagnostics[0].reason, "network_request");
});

test("VST signed GET retries a transient response-body read failure once", async () => {
  const diagnostics = [];
  const { api, calls } = fixture({
    responses: {
      [`GET ${BALANCE_PATH}`]: [
        { readError: new TypeError("socket closed while reading response") },
        { code: 0, data: [{ asset: "VST" }] },
      ],
    },
    onTransientGetDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  assert.equal((await api.getBalance())[0].asset, "VST");
  assert.equal(callsFor(calls, "GET", BALANCE_PATH).length, 2);
  assert.equal(diagnostics[0].reason, "network_response_read");
});

test("unrelated exchange business errors are not retried", async () => {
  const { api, calls } = fixture({
    responses: {
      [`GET ${BALANCE_PATH}`]: [
        { code: 109418, msg: "symbol offline" },
      ],
    },
  });

  await assert.rejects(api.getBalance(), (error) =>
    error.code === 109418 &&
    error.exchangeMessage === "symbol offline" &&
    error.endpoint === BALANCE_PATH);
  assert.equal(callsFor(calls, "GET", BALANCE_PATH).length, 1);
});

test("POST 109500 is not retried", async () => {
  const postKey = `POST ${"/openApi/swap/v2/trade/positionMargin"}`;
  const { api, calls } = fixture({
    permission: true,
    responses: {
      [`GET ${"/openApi/swap/v2/trade/marginType"}`]: [
        { code: 0, data: { marginType: "ISOLATED" } },
      ],
      [`GET ${"/openApi/swap/v2/trade/leverage"}`]: [
        { code: 0, data: {
          symbol: "BTC-USDT",
          longLeverage: 10,
          shortLeverage: 10,
          maxPositionLongVal: "10000",
        } },
      ],
      [`GET ${"/openApi/swap/v1/positionSide/dual"}`]: [
        { code: 0, data: { dualSidePosition: false } },
      ],
      [`GET ${"/openApi/swap/v2/user/positions"}`]: [
        { code: 0, data: [{
          symbol: "BTC-USDT", positionSide: "BOTH", positionAmt: "1",
        }] },
      ],
      [postKey]: [{ code: 109500, msg: "system busy" }],
    },
  });

  await assert.rejects(
    api.addIsolatedMargin("BTCUSDT", "1", "margin-operation-1"),
    (error) => error.code === 109500 && error.method === "POST",
  );
  assert.equal(callsFor(calls, "POST", "/openApi/swap/v2/trade/positionMargin").length, 1);
});

test("DELETE transport failure is not retried", async () => {
  const deletePath = ORDER_PATH;
  const { api, calls } = fixture({
    permission: true,
    responses: {
      [`GET ${"/openApi/swap/v2/user/positions"}`]: [
        { code: 0, data: [] },
      ],
      [`GET ${"/openApi/swap/v2/trade/openOrders"}`]: [
        { code: 0, data: [{
          symbol: "BTC-USDT",
          orderId: "123",
          status: "NEW",
          type: "LIMIT",
        }] },
      ],
      [`GET ${deletePath}`]: [
        { code: 0, data: {
          symbol: "BTC-USDT", orderId: "123", status: "NEW",
        } },
      ],
      [`DELETE ${deletePath}`]: [
        new TypeError("network unavailable"),
      ],
    },
  });

  await assert.rejects(api.cancelVstOrder("BTCUSDT", "123"), (error) =>
    error.transportStage === "network_request" &&
    error.endpoint === deletePath &&
    error.method === "DELETE");
  assert.equal(callsFor(calls, "DELETE", deletePath).length, 1);
});