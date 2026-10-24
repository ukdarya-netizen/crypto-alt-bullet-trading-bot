import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createBingXLivePreflight } from "../bingx-live-preflight.mjs";

const paths = [
  "/openApi/swap/v3/user/balance",
  "/openApi/swap/v2/user/positions",
  "/openApi/swap/v1/positionSide/dual",
  "/openApi/swap/v2/trade/openOrders",
];

function fixture(payloads) {
  const calls = [];
  const preflight = createBingXLivePreflight({
    clock: () => 1700000000000,
    credentials: () => ({ key: "fixture-key", secret: "fixture-secret" }),
    sleep: async () => {},
    fetchImpl: async (raw, options) => {
      const url = new URL(raw);
      calls.push(url.pathname);
      assert.equal(url.origin, "https://open-api.bingx.com");
      assert.equal(url.pathname, paths[calls.length - 1]);
      assert.equal(options.method, "GET");
      assert.equal(options.headers["X-BX-APIKEY"], "fixture-key");
      const symbol = url.searchParams.get("symbol");
      const query = `recvWindow=5000&${symbol ? `symbol=${symbol}&` : ""}timestamp=1700000000000`;
      assert.equal(url.searchParams.get("signature"), createHmac("sha256", "fixture-secret")
        .update(query).digest("hex"));
      const payload = payloads[calls.length - 1];
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  });
  return { preflight, calls };
}

test("read-only checks never grant live readiness or return private balance", async () => {
  const { preflight, calls } = fixture([
    { code: 0, data: [{ asset: "USDT", availableMargin: "143.25", userId: "private" }] },
    { code: 0, data: [] },
    { code: 0, data: { dualSidePosition: false } },
  ]);
  const result = await preflight();
  assert.deepEqual(calls, paths.slice(0, 3));
  assert.deepEqual(result.checks, {
    initialMargin: true, flatAccount: true, oneWayMode: true,
  });
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blockers, [
    "execution_disabled", "stop_and_exit_unverified", "margin_topup_unverified",
  ]);
  assert.equal(JSON.stringify(result).includes("143.25"), false);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("insufficient margin blocks while shared-account positions and hedge mode are informational", async () => {
  const { preflight } = fixture([
    { code: 0, data: [{ asset: "USDT", availableMargin: "9.99" }] },
    { code: 0, data: [{ positionAmt: "0.1", symbol: "BTC-USDT" }] },
    { code: 0, data: { dualSidePosition: true } },
  ]);
  const result = await preflight();
  assert.deepEqual(result.checks, {
    initialMargin: false, flatAccount: false, oneWayMode: false,
  });
  assert.ok(result.blockers.includes("initial_margin_unverified"));
  assert.ok(!result.blockers.includes("existing_or_unknown_positions"));
  assert.ok(!result.blockers.includes("hedge_mode"));
  assert.deepEqual(result.notices, ["existing_positions_or_unknown", "hedge_mode"]);
});

test("a position with an unknown amount is not mistaken for a flat account", async () => {
  const { preflight } = fixture([
    { code: 0, data: [{ asset: "USDT", availableMargin: "50" }] },
    { code: 0, data: [{ symbol: "BTC-USDT", positionAmt: null }] },
    { code: 0, data: { dualSidePosition: false } },
  ]);
  const result = await preflight();
  assert.equal(result.checks.flatAccount, false);
  assert.ok(!result.blockers.includes("existing_or_unknown_positions"));
  assert.ok(result.notices.includes("existing_positions_or_unknown"));
});

test("accepts only literal string booleans returned by the live mode endpoint", async () => {
  const { preflight } = fixture([
    { code: 0, data: [{ asset: "USDT", availableMargin: "50" }] },
    { code: 0, data: [] },
    { code: 0, data: { dualSidePosition: "false" } },
  ]);
  assert.equal((await preflight()).checks.oneWayMode, true);

  const unknown = fixture([
    { code: 0, data: [{ asset: "USDT", availableMargin: "50" }] },
    { code: 0, data: [] },
    { code: 0, data: { dualSidePosition: "0" } },
  ]);
  assert.equal((await unknown.preflight()).status, "unavailable");
});

test("missing keys or exchange failures fail closed without leaking response text", async () => {
  const missing = createBingXLivePreflight({
    credentials: () => ({}),
    fetchImpl: () => { throw new Error("must not reach exchange"); },
  });
  assert.ok((await missing()).blockers.includes("credentials_missing"));

  const rejected = fixture([{ code: 100001, msg: "account private text" }]);
  const result = await rejected.preflight();
  assert.equal(result.status, "unavailable");
  assert.deepEqual(rejected.calls, paths.slice(0, 1));
  assert.ok(result.blockers.includes("account_check_unavailable"));
  assert.equal(JSON.stringify(result).includes("account private text"), false);
});

test("symbol check clears a target symbol while preserving unrelated shared-account positions", async () => {
  const { preflight, calls } = fixture([
    { code: 0, data: [{ asset: "USDT", availableMargin: "143.25" }] },
    { code: 0, data: [{ symbol: "ETH-USDT", positionAmt: "-0.25" }] },
    { code: 0, data: { dualSidePosition: true } },
    { code: 0, data: [] },
  ]);

  const result = await preflight({ symbol: "BTCUSDT" });
  assert.deepEqual(calls, paths);
  assert.deepEqual(result.symbolCheck, {
    symbol: "BTCUSDT", symbolClear: true, positionSide: "LONG", reason: null,
  });
  assert.equal(result.checks.flatAccount, false);
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blockers, [
    "execution_disabled", "stop_and_exit_unverified", "margin_topup_unverified",
  ]);
});

test("same-symbol pending orders and invalid canonical symbols remain blocked", async () => {
  const conflict = fixture([
    { code: 0, data: [{ asset: "USDT", availableMargin: "143.25" }] },
    { code: 0, data: [{ symbol: "ETH-USDT", positionAmt: "0" }] },
    { code: 0, data: { dualSidePosition: false } },
    { code: 0, data: [{ symbol: "BTC-USDT", orderId: "private-order-id" }] },
  ]);
  const result = await conflict.preflight({ symbol: "BTCUSDT" });
  assert.deepEqual(result.symbolCheck, {
    symbol: "BTCUSDT", symbolClear: false, positionSide: null, reason: "existing_order",
  });
  assert.ok(result.blockers.includes("symbol_conflict_or_unknown"));
  assert.equal(JSON.stringify(result).includes("private-order-id"), false);

  const invalid = fixture([]);
  const invalidResult = await invalid.preflight({ symbol: "btc-usdt" });
  assert.equal(invalidResult.status, "blocked");
  assert.ok(invalidResult.blockers.includes("invalid_symbol"));
  assert.deepEqual(invalid.calls, []);
});

test("unavailable symbol-order read fails closed with explicit symbol check", async () => {
  const { preflight } = fixture([
    { code: 0, data: [{ asset: "USDT", availableMargin: "143.25" }] },
    { code: 0, data: [{ symbol: "ETH-USDT", positionAmt: "0" }] },
    { code: 0, data: { dualSidePosition: false } },
    { code: 100001, msg: "private order text" },
  ]);
  const result = await preflight({ symbol: "BTCUSDT" });
  assert.equal(result.status, "unavailable");
  assert.ok(result.blockers.includes("symbol_check_unavailable"));
  assert.deepEqual(result.symbolCheck, {
    symbol: "BTCUSDT", symbolClear: false, positionSide: null, reason: "exchange_state_unknown",
  });
  assert.equal(JSON.stringify(result).includes("private order text"), false);
});