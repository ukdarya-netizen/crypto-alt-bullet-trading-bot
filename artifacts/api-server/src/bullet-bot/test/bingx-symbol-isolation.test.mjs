import assert from "node:assert/strict";
import test from "node:test";
import { assessBingXSymbolIsolation } from "../bingx-symbol-isolation.mjs";

const symbol = "BTCUSDT";

test("same-symbol nonzero position prevents symbol isolation", () => {
  assert.deepEqual(
    assessBingXSymbolIsolation(
      symbol,
      [{ symbol: "BTC-USDT", positionAmt: "0.01" }],
      [],
      false,
    ),
    { symbolClear: false, positionSide: null, reason: "existing_position" },
  );
});

test("same-symbol open order prevents symbol isolation", () => {
  assert.deepEqual(
    assessBingXSymbolIsolation(
      symbol,
      [],
      [{ symbol: "BTC-USDT", orderId: "private-order-id" }],
      false,
    ),
    { symbolClear: false, positionSide: null, reason: "existing_order" },
  );
});

test("unknown exchange state fails closed", () => {
  assert.deepEqual(
    assessBingXSymbolIsolation(symbol, [{ symbol: "BTC-USDT" }], [], false),
    { symbolClear: false, positionSide: null, reason: "exchange_state_unknown" },
  );
  assert.deepEqual(
    assessBingXSymbolIsolation(symbol, [], null, false),
    { symbolClear: false, positionSide: null, reason: "exchange_state_unknown" },
  );
});

test("unrelated positions are allowed for a hedge-mode symbol check", () => {
  assert.deepEqual(
    assessBingXSymbolIsolation(
      symbol,
      [{ symbol: "ETH-USDT", positionAmt: "-0.25" }],
      [],
      true,
    ),
    { symbolClear: true, positionSide: "LONG", reason: null },
  );
});
