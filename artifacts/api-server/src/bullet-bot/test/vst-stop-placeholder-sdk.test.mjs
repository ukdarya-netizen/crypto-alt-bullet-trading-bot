import assert from "node:assert/strict";
import test from "node:test";
import {
  createBingXLiveApi,
  createBingXOutboundPacer,
} from "../bingx-live-api.mjs";

const ORDER_PATH = "/openApi/swap/v2/trade/order";
const OPEN_ORDERS_PATH = "/openApi/swap/v2/trade/openOrders";
const POSITION_ID = "2105271515231551489";
const OLD_STOP_ID = "2105952049086160892";
const NEW_STOP_ID = "2105952049086160896";
const ENTRY_ID = "2105271515231551000";
const QUANTITY = "18850.91";
const NEW_PRICE = "0.4915";

function createNativeSdk({
  queryTransform = (order) => order,
  losePostReply = false,
  postResponse,
  openOrderTransform = (order) => order,
  extraOpenOrders = [],
  replacementIds = [NEW_STOP_ID],
  standaloneOldStop = false,
} = {}) {
  let now = 1_700_000_000_000;
  const calls = [];
  const position = {
    symbol: "RE-USDT",
    positionSide: "LONG",
    positionAmt: QUANTITY,
    positionID: POSITION_ID,
  };
  const oldStop = {
    symbol: "RE-USDT",
    orderID: OLD_STOP_ID,
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    positionID: POSITION_ID,
    origQty: QUANTITY,
    stopPrice: "0.4408",
    workingType: "MARK_PRICE",
    mainOrderId: standaloneOldStop ? "" : ENTRY_ID,
    ...(standaloneOldStop ? { clientOrderId: "" } : {}),
    executedQty: "0",
  };
  let orders = [oldStop];
  let newOrder;
  let replacementIndex = 0;
  const canceledOrders = [];
  const fetchImpl = async (urlText, options) => {
    const url = new URL(urlText);
    calls.push({ url, options });
    let data;
    if (url.pathname === "/openApi/swap/v1/positionSide/dual") {
      data = { dualSidePosition: true };
    } else if (url.pathname === "/openApi/swap/v2/trade/marginType") {
      data = { marginType: "ISOLATED" };
    } else if (url.pathname === "/openApi/swap/v2/trade/leverage") {
      data = {
        longLeverage: 10, shortLeverage: 25, maxPositionLongVal: "1000000",
      };
    } else if (url.pathname === "/openApi/swap/v2/user/positions") {
      data = [position];
    } else if (url.pathname === OPEN_ORDERS_PATH) {
      data = [
        ...orders.map(openOrderTransform),
        ...(newOrder ? extraOpenOrders : []),
      ];
    } else if (url.pathname === "/openApi/swap/v2/quote/contracts") {
      data = [{
        symbol: "RE-USDT", status: 1, currency: "USDT", apiStateOpen: "true",
        quantityPrecision: 2, pricePrecision: 4, tradeMinQuantity: "0.01",
        tradeMinUSDT: "5", maxLongLeverage: "10", maxShortLeverage: "75",
      }];
    } else if (url.pathname === "/openApi/swap/v2/quote/premiumIndex") {
      data = { symbol: "RE-USDT", markPrice: "0.6", time: now };
    } else if (url.pathname === ORDER_PATH && options.method === "POST") {
      const replacementId = replacementIds[replacementIndex++];
      newOrder = {
        symbol: "RE-USDT",
        orderID: replacementId,
        type: url.searchParams.get("type"),
        status: "NEW",
        side: url.searchParams.get("side"),
        positionSide: url.searchParams.get("positionSide"),
        positionID: POSITION_ID,
        origQty: url.searchParams.get("quantity"),
        stopPrice: url.searchParams.get("stopPrice"),
        workingType: url.searchParams.get("workingType"),
        mainOrderId: "",
        clientOrderId: "",
        executedQty: "0",
        time: url.searchParams.get("timestamp"),
      };
      orders.push(newOrder);
      if (losePostReply) throw new Error("lost POST reply");
      data = postResponse ?? { orderID: replacementId };
    } else if (url.pathname === ORDER_PATH && options.method === "GET") {
      const id = url.searchParams.get("orderId");
      const queried = orders.find((order) => order.orderID === id);
      data = queried ? queryTransform({ ...queried }) : null;
    } else if (url.pathname === ORDER_PATH && options.method === "DELETE") {
      const id = url.searchParams.get("orderId");
      const canceled = orders.find((order) => order.orderID === id);
      if (canceled) canceledOrders.push({ ...canceled, status: "CANCELED" });
      orders = orders.filter((order) => order.orderID !== id);
      data = {};
    } else {
      throw new Error(`Unexpected native SDK request ${options.method} ${url.pathname}`);
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, data }),
    };
  };
  const api = createBingXLiveApi({
    environment: "vst",
    fetchImpl,
    clock: () => now,
    sleep: async (ms) => { now += ms; },
    requestPacer: createBingXOutboundPacer({
      gapMs: 1_100,
      clock: () => now,
      sleep: async (ms) => { now += ms; },
    }),
    credentials: () => ({ key: "test-key", secret: "test-secret" }),
    writePermission: () => true,
  });
  return {
    api, calls, canceledOrders,
    get orders() { return orders; },
  };
}

function upgradeRequest(onSubmission = async () => {}) {
  return {
    symbol: "REUSDT",
    quantity: QUANTITY,
    positionId: POSITION_ID,
    entryOrderId: ENTRY_ID,
    previousStopOrderId: OLD_STOP_ID,
    previousStopPrice: "0.4408",
    stopPrice: NEW_PRICE,
    onSubmission,
  };
}

test("native VST stop upgrade accepts only an exact zero-position query corroborated by its linked active stop", async () => {
  for (const queryPosition of [POSITION_ID, 0, "0"]) {
    const sdk = createNativeSdk({
      queryTransform: (order) => ({ ...order, positionID: queryPosition }),
    });
    const submissions = [];
    const result = await sdk.api.upgradeVstLongStop(upgradeRequest(async (row) => {
      submissions.push(row.exchangeOrderId);
      assert.equal(sdk.calls.filter(({ url, options }) =>
        url.pathname === ORDER_PATH && options.method === "POST").length, 1);
      assert.equal(sdk.calls.some(({ url, options }) =>
        url.pathname === ORDER_PATH && options.method === "GET" &&
        url.searchParams.get("orderId") === NEW_STOP_ID), false,
      "submission identity must be persisted before exact-ID verification");
    }));
    assert.equal(result.verified, true);
    assert.equal(result.exchangeOrderId, NEW_STOP_ID);
    assert.deepEqual(submissions, [NEW_STOP_ID]);
    assert.deepEqual(sdk.orders.map((order) => order.orderID), [NEW_STOP_ID]);
    assert.deepEqual(sdk.canceledOrders.map((order) => [order.orderID, order.status]), [
      [OLD_STOP_ID, "CANCELED"],
    ]);
    assert.equal(sdk.calls.filter(({ url, options }) =>
      url.pathname === ORDER_PATH && options.method === "POST").length, 1);
    assert.equal(sdk.calls.filter(({ url, options }) =>
      url.pathname === ORDER_PATH && options.method === "GET" &&
      url.searchParams.get("orderId") === NEW_STOP_ID).length, 1,
    "exact-ID query belongs to the final cancellation guard");
    assert.equal(sdk.calls.some(({ url, options }) =>
      url.pathname === ORDER_PATH && options.method === "DELETE" &&
      url.searchParams.get("orderId") === OLD_STOP_ID), true);
  }
});

test("successive native stop raises accept standalone parent aliases and cancel only after zero-position corroboration", async () => {
  const secondStopId = "2105952049086160900";
  const sdk = createNativeSdk({
    queryTransform: (order) => ({ ...order, positionID: 0 }),
    replacementIds: [NEW_STOP_ID, secondStopId],
    standaloneOldStop: true,
  });
  const first = await sdk.api.upgradeVstLongStop(upgradeRequest());
  assert.equal(first.verified, true);
  assert.deepEqual(sdk.orders.map((order) => order.orderID), [NEW_STOP_ID]);
  assert.deepEqual(sdk.canceledOrders.map((order) => order.orderID), [OLD_STOP_ID]);

  const secondRequest = upgradeRequest();
  secondRequest.previousStopOrderId = NEW_STOP_ID;
  secondRequest.previousStopPrice = NEW_PRICE;
  secondRequest.stopPrice = "0.52";
  const second = await sdk.api.upgradeVstLongStop(secondRequest);
  assert.equal(second.verified, true);
  assert.equal(second.newStopOrderId, secondStopId);
  assert.deepEqual(sdk.orders.map((order) => order.orderID), [secondStopId]);
  assert.deepEqual(sdk.canceledOrders.map((order) => order.orderID), [
    OLD_STOP_ID, NEW_STOP_ID,
  ]);
  assert.equal(sdk.calls.filter(({ url, options }) =>
    url.pathname === ORDER_PATH && options.method === "POST").length, 2);
  for (const id of [NEW_STOP_ID, secondStopId]) {
    assert.equal(sdk.calls.filter(({ url, options }) =>
      url.pathname === ORDER_PATH && options.method === "GET" &&
      url.searchParams.get("orderId") === id).length, 1,
    "each successive raise independently verifies its replacement once before cancellation");
  }
  assert.deepEqual(sdk.canceledOrders.map((order) => order.status), [
    "CANCELED", "CANCELED",
  ]);
});

test("native VST stop upgrade rejects conflicting or ambiguous placeholder evidence without cancelling original protection", async () => {
  const invalidCases = [
    {
      name: "wrong nonzero query position ID",
      queryTransform: (order) => ({ ...order, positionID: "wrong-position" }),
    },
    {
      name: "query identity conflict",
      queryTransform: (order) => ({ ...order, orderId: "different-stop-id" }),
    },
    {
      name: "query stop price mismatch",
      queryTransform: (order) => ({ ...order, positionID: 0, stopPrice: "0.4920" }),
    },
    {
      name: "query quantity mismatch",
      queryTransform: (order) => ({ ...order, positionID: 0, origQty: "18850.90" }),
    },
    {
      name: "query working type mismatch",
      queryTransform: (order) => ({ ...order, positionID: 0, workingType: "CONTRACT_PRICE" }),
    },
    {
      name: "wrong-side query stop",
      queryTransform: (order) => ({ ...order, positionID: 0, side: "BUY" }),
    },
    {
      name: "filled query stop",
      queryTransform: (order) => ({ ...order, positionID: 0, executedQty: "1" }),
    },
    {
      name: "conflicting nonempty entry parent",
      queryTransform: (order) => ({ ...order, positionID: 0 }),
      openOrderTransform: (order) => order.orderID === NEW_STOP_ID
        ? { ...order, mainOrderId: "other-entry" }
        : order,
    },
    {
      name: "multiple active stops",
      queryTransform: (order) => ({ ...order, positionID: 0 }),
      extraOpenOrders: [{
        symbol: "RE-USDT", orderID: "another-stop", type: "STOP_MARKET",
        status: "NEW", side: "SELL", positionSide: "LONG", positionID: POSITION_ID,
        origQty: QUANTITY, stopPrice: NEW_PRICE, workingType: "MARK_PRICE",
        mainOrderId: ENTRY_ID, executedQty: "0",
      }],
    },
  ];

  for (const invalidCase of invalidCases) {
    const sdk = createNativeSdk(invalidCase);
    await assert.rejects(
      sdk.api.upgradeVstLongStop(upgradeRequest()),
      /exact-ID query|not independently verified/,
      invalidCase.name,
    );
    assert.deepEqual(
      sdk.orders.map((order) => order.orderID),
      [OLD_STOP_ID, NEW_STOP_ID],
      `${invalidCase.name}: original stop must remain active`,
    );
    assert.equal(sdk.calls.some(({ url, options }) =>
      url.pathname === ORDER_PATH && options.method === "DELETE"), false,
    `${invalidCase.name}: old stop must not be cancelled`);
  }
});

test("lost native stop POST reply stays unknown, retains protection, and never reposts", async () => {
  const sdk = createNativeSdk({
    losePostReply: true,
  });
  const persistedIds = [];
  const request = upgradeRequest(async ({ exchangeOrderId }) => {
    persistedIds.push(exchangeOrderId);
  });

  await assert.rejects(sdk.api.upgradeVstLongStop(request), /request failed/);
  assert.deepEqual(persistedIds, []);
  assert.deepEqual(sdk.orders.map((order) => order.orderID), [OLD_STOP_ID, NEW_STOP_ID]);
  assert.deepEqual(sdk.canceledOrders, []);
  assert.equal(sdk.calls.filter(({ url, options }) =>
    url.pathname === ORDER_PATH && options.method === "POST").length, 1);
  assert.equal(sdk.calls.some(({ url, options }) =>
    url.pathname === ORDER_PATH && options.method === "DELETE"), false);
  await assert.rejects(
    sdk.api.upgradeVstLongStop(request),
    /already submitted; reconcile, never retry/,
  );
  assert.equal(sdk.calls.filter(({ url, options }) =>
    url.pathname === ORDER_PATH && options.method === "POST").length, 1);
});

test("invalid POST identity cannot adopt an unlinked matching standalone stop from open-order payload", async () => {
  const sdk = createNativeSdk({
    postResponse: { orderID: 1234567890123456.5 },
  });
  const submissions = [];
  const request = upgradeRequest(async ({ exchangeOrderId }) => {
    submissions.push(exchangeOrderId);
  });
  await assert.rejects(
    sdk.api.upgradeVstLongStop(request),
    /response and snapshot discovery are ambiguous/,
  );
  assert.deepEqual(submissions, []);
  assert.deepEqual(sdk.orders.map((order) => order.orderID), [OLD_STOP_ID, NEW_STOP_ID]);
  assert.deepEqual(sdk.canceledOrders, []);
  assert.equal(sdk.calls.some(({ url, options }) =>
    url.pathname === ORDER_PATH && options.method === "DELETE"), false);
  await assert.rejects(
    sdk.api.upgradeVstLongStop(request),
    /already submitted; reconcile, never retry/,
  );
  assert.equal(sdk.calls.filter(({ url, options }) =>
    url.pathname === ORDER_PATH && options.method === "POST").length, 1);
});