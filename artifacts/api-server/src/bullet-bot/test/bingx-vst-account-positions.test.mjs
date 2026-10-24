import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeBingXVstAccountBalance,
  readBingXVstAccountPositions,
} from "../bingx-vst-account-positions.mjs";

test("VST balance is read from the VST asset row, not USDT", () => {
  assert.deepEqual(normalizeBingXVstAccountBalance([
    { asset: "USDT", balance: "999999" },
    { asset: "VST", balance: "100000", equity: "100250.5", availableMargin: "98000", unrealizedProfit: "250.5" },
  ]), {
    walletBalanceUsdt: "100000",
    equityUsdt: "100250.5",
    availableMarginUsdt: "98000",
    unrealizedPnlUsdt: "250.5",
  });
  assert.equal(normalizeBingXVstAccountBalance([{ asset: "USDT", balance: "100" }]), null);
  assert.equal(normalizeBingXVstAccountBalance([]), null);
  assert.equal(normalizeBingXVstAccountBalance([
    { asset: "VST", balance: "1" }, { asset: "VST", balance: "2" },
  ]), null);
});

test("reads VST positions and balance independently, mirroring the mainnet reader", async () => {
  let positionCalls = 0;
  let balanceCalls = 0;
  const result = await readBingXVstAccountPositions({
    accountConfigured: true,
    clock: () => Date.parse("2026-09-28T06:00:00.000Z"),
    exchange: {
      getPositions: async () => {
        positionCalls++;
        return [
          {
            symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.1",
            avgPrice: "60000", markPrice: "60500", unrealizedProfit: "50",
            initialMargin: "600", isolated: true, leverage: 10,
          },
        ];
      },
      getBalance: async () => {
        balanceCalls++;
        return [{ asset: "VST", balance: "10000", equity: "10050", availableMargin: "9400", unrealizedProfit: "50" }];
      },
    },
  });
  assert.equal(positionCalls, 1);
  assert.equal(balanceCalls, 1);
  assert.equal(result.status, "available");
  assert.equal(result.observedAt, "2026-09-28T06:00:00.000Z");
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].symbol, "BTC-USDT");
  assert.equal(result.positions[0].roePercent, "8.3333");
  assert.equal(result.accountStatus, "available");
  assert.deepEqual(result.account, {
    walletBalanceUsdt: "10000", equityUsdt: "10050",
    availableMarginUsdt: "9400", unrealizedPnlUsdt: "50",
  });
});

test("unconfigured VST account alias makes no read request", async () => {
  let calls = 0;
  const result = await readBingXVstAccountPositions({
    accountConfigured: false,
    exchange: {
      getPositions: () => { calls++; throw new Error("must not request"); },
      getBalance: () => { calls++; throw new Error("must not request"); },
    },
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.accountStatus, "unavailable");
  assert.equal(result.account, null);
  assert.equal(calls, 0);
});

test("a failed VST position read does not hide the independently received balance", async () => {
  const result = await readBingXVstAccountPositions({
    accountConfigured: true,
    exchange: {
      getPositions: async () => { throw new Error("positions unavailable"); },
      getBalance: async () => [{ asset: "VST", balance: "10000" }],
    },
  });
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.positions, []);
  assert.equal(result.accountStatus, "available");
  assert.equal(result.account.walletBalanceUsdt, "10000");
});

test("a failed VST balance read does not hide a successful position snapshot", async () => {
  const result = await readBingXVstAccountPositions({
    accountConfigured: true,
    exchange: {
      getPositions: async () => [{ symbol: "ETH-USDT", positionSide: "SHORT", positionAmt: "1" }],
      getBalance: async () => { throw new Error("balance unavailable"); },
    },
  });
  assert.equal(result.status, "available");
  assert.equal(result.positions.length, 1);
  assert.equal(result.accountStatus, "unavailable");
  assert.equal(result.account, null);
});
