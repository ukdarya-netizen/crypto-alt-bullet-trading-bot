import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeBingXAccountBalance,
  normalizeBingXAccountPositions,
  readBingXAccountPositions,
} from "../bingx-account-positions.mjs";

test("reads account balance and positions separately without exposing unrelated exchange fields", async () => {
  let positionCalls = 0;
  let balanceCalls = 0;
  const result = await readBingXAccountPositions({
    credentialsConfigured: true,
    clock: () => Date.parse("2026-09-25T12:00:00.000Z"),
    exchange: {
      getPositions: async () => {
        positionCalls++;
        return [
          {
            symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "0.25",
            avgPrice: "60000.5", markPrice: "60110", unrealizedProfit: "27.375",
            initialMargin: "1500", isolated: true, leverage: 10,
            createTime: 1790337600000, positionId: "private-id",
            riskRate: "secret-or-unrequested",
          },
          {
            symbol: "ETH-USDT", positionSide: "SHORT", positionAmt: "1",
            avgPrice: "3300", markPrice: "", unrealizedProfit: null,
            liquidationPrice: 0, isolated: false,
          },
          { symbol: "SOL-USDT", positionSide: "LONG", positionAmt: "0" },
        ];
      },
      getBalance: async () => {
        balanceCalls++;
        return [{
          asset: "USDT", balance: "100", equity: "103.5", availableMargin: "56.02",
          unrealizedProfit: "3.5", accountId: "private", riskRate: "unrequested",
        }];
      },
      placeLong: () => { throw new Error("must not trade"); },
    },
  });
  assert.equal(positionCalls, 1);
  assert.equal(balanceCalls, 1);
  assert.equal(result.status, "available");
  assert.equal(result.observedAt, "2026-09-25T12:00:00.000Z");
  assert.equal(result.positions.length, 2);
  assert.deepEqual(result.positions[0], {
    symbol: "BTC-USDT", side: "LONG", size: "0.25",
    entryPrice: "60000.5", markPrice: "60110", unrealizedPnlUsdt: "27.375",
    roePercent: "1.825",
    stopPrice: null, liquidationPrice: null, marginUsdt: "1500",
    leverage: 10, marginMode: "ISOLATED", openedAt: "2026-09-25T12:00:00.000Z",
  });
  assert.equal(result.positions[1].side, "SHORT");
  assert.equal(result.positions[1].markPrice, null);
  assert.equal(result.positions[1].unrealizedPnlUsdt, null);
  assert.equal(result.positions[1].roePercent, null);
  assert.equal(result.positions[1].liquidationPrice, null);
  assert.equal(result.accountStatus, "available");
  assert.equal(result.accountSource, "BingX mainnet swap account-wide USDT balance");
  assert.equal(result.accountObservedAt, "2026-09-25T12:00:00.000Z");
  assert.deepEqual(result.account, {
    walletBalanceUsdt: "100",
    equityUsdt: "103.5",
    availableMarginUsdt: "56.02",
    unrealizedPnlUsdt: "3.5",
  });
  assert.equal(JSON.stringify(result).includes("private-id"), false);
  assert.equal(JSON.stringify(result).includes("secret-or-unrequested"), false);
  assert.equal(JSON.stringify(result).includes("accountId"), false);
  assert.equal(JSON.stringify(result).includes("unrequested"), false);
});

test("REAL ROE uses only exchange PnL and positive position margin", () => {
  const positions = normalizeBingXAccountPositions([
    { symbol: "EIGEN-USDT", positionAmt: "2", unrealizedProfit: "-2.5", initialMargin: "10" },
    { symbol: "ETH-USDT", positionAmt: "1", unrealizedProfit: "0", initialMargin: "10" },
    { symbol: "SOL-USDT", positionAmt: "1", unrealizedProfit: "3", initialMargin: "0" },
    { symbol: "BTC-USDT", positionAmt: "1", unrealizedProfit: null, initialMargin: "12" },
  ]);
  assert.deepEqual(positions.map((position) => position.roePercent), ["-25", "0", null, null]);
});

test("REAL remaining size and margin follow each exchange snapshot after a partial close", () => {
  const before = normalizeBingXAccountPositions([
    { symbol: "BTC-USDT", positionAmt: "1", initialMargin: "10", unrealizedProfit: "1" },
  ])[0];
  const after = normalizeBingXAccountPositions([
    { symbol: "BTC-USDT", positionAmt: "0.75", initialMargin: "7.5", unrealizedProfit: "0.75" },
  ])[0];
  assert.equal(before.marginUsdt, "10");
  assert.equal(after.size, "0.75");
  assert.equal(after.marginUsdt, "7.5");
  assert.equal(after.roePercent, "10");
});

test("account balance only exposes strict exchange-reported USDT decimals and leaves missing fields null", () => {
  assert.deepEqual(normalizeBingXAccountBalance([
    { asset: "USDT", balance: "100" },
  ]), {
    walletBalanceUsdt: "100",
    equityUsdt: null,
    availableMarginUsdt: null,
    unrealizedPnlUsdt: null,
  });
  assert.deepEqual(normalizeBingXAccountBalance([
    {
      asset: "USDT", balance: "100.00", equity: "invalid", availableMargin: "56",
      unrealizedProfit: "-2.5",
    },
    { asset: "BTC", balance: "999", equity: "999" },
  ]), {
    walletBalanceUsdt: "100.00",
    equityUsdt: null,
    availableMarginUsdt: "56",
    unrealizedPnlUsdt: "-2.5",
  });
  assert.deepEqual(normalizeBingXAccountBalance([
    { asset: "USDT", balance: "1e3", equity: "-1", availableMargin: "Infinity", unrealizedProfit: "NaN" },
  ]), {
    walletBalanceUsdt: null, equityUsdt: null, availableMarginUsdt: null,
    unrealizedPnlUsdt: null,
  });
  assert.equal(normalizeBingXAccountBalance([]), null);
  assert.equal(normalizeBingXAccountBalance([
    { asset: "USDT", balance: "1" }, { asset: "USDT", balance: "2" },
  ]), null);
});

test("failed balance read does not hide a successful position snapshot", async () => {
  const result = await readBingXAccountPositions({
    credentialsConfigured: true,
    exchange: {
      getPositions: async () => [{ symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "1" }],
      getBalance: async () => { throw new Error("private balance unavailable"); },
    },
  });
  assert.equal(result.status, "available");
  assert.equal(result.positions.length, 1);
  assert.equal(result.accountStatus, "unavailable");
  assert.equal(result.accountObservedAt, null);
  assert.equal(result.account, null);
});

test("failed position read does not hide the independently received account balance", async () => {
  const result = await readBingXAccountPositions({
    credentialsConfigured: true,
    clock: () => Date.parse("2026-09-25T12:00:00.000Z"),
    exchange: {
      getPositions: async () => { throw new Error("positions unavailable"); },
      getBalance: async () => [{ asset: "USDT", balance: "100" }],
    },
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.observedAt, null);
  assert.deepEqual(result.positions, []);
  assert.equal(result.accountStatus, "available");
  assert.equal(result.accountObservedAt, "2026-09-25T12:00:00.000Z");
  assert.equal(result.account.walletBalanceUsdt, "100");
});

test("each successful read is timestamped when its own validated response completes", async () => {
  let now = Date.parse("2026-09-25T12:00:00.000Z");
  let resolveBalance;
  let signalPositionStamped;
  const balanceResponse = new Promise((resolve) => { resolveBalance = resolve; });
  const positionStamped = new Promise((resolve) => { signalPositionStamped = resolve; });
  let clockCalls = 0;
  const resultPromise = readBingXAccountPositions({
    credentialsConfigured: true,
    clock: () => {
      clockCalls++;
      if (clockCalls === 1) signalPositionStamped();
      return now;
    },
    exchange: {
      getPositions: async () => [{ symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "1" }],
      getBalance: () => balanceResponse,
    },
  });

  await positionStamped;
  assert.equal(clockCalls, 1);
  now += 60_000;
  resolveBalance([{ asset: "USDT", balance: "100" }]);
  const result = await resultPromise;

  assert.equal(result.observedAt, "2026-09-25T12:00:00.000Z");
  assert.equal(result.accountObservedAt, "2026-09-25T12:01:00.000Z");
});

test("a delayed position response does not make the earlier balance snapshot appear newer", async () => {
  let now = Date.parse("2026-09-25T12:00:00.000Z");
  let resolvePositions;
  let signalBalanceStamped;
  const positionResponse = new Promise((resolve) => { resolvePositions = resolve; });
  const balanceStamped = new Promise((resolve) => { signalBalanceStamped = resolve; });
  let clockCalls = 0;
  const resultPromise = readBingXAccountPositions({
    credentialsConfigured: true,
    clock: () => {
      clockCalls++;
      if (clockCalls === 1) signalBalanceStamped();
      return now;
    },
    exchange: {
      getPositions: () => positionResponse,
      getBalance: async () => [{ asset: "USDT", balance: "100" }],
    },
  });

  await balanceStamped;
  assert.equal(clockCalls, 1);
  now += 60_000;
  resolvePositions([{ symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "1" }]);
  const result = await resultPromise;

  assert.equal(result.accountObservedAt, "2026-09-25T12:00:00.000Z");
  assert.equal(result.observedAt, "2026-09-25T12:01:00.000Z");
});

test("a delayed balance failure keeps its timestamp null and does not refresh the earlier positions snapshot", async () => {
  let now = Date.parse("2026-09-25T12:00:00.000Z");
  let rejectBalance;
  let signalPositionStamped;
  const balanceResponse = new Promise((_resolve, reject) => { rejectBalance = reject; });
  const positionStamped = new Promise((resolve) => { signalPositionStamped = resolve; });
  const resultPromise = readBingXAccountPositions({
    credentialsConfigured: true,
    clock: () => {
      signalPositionStamped();
      return now;
    },
    exchange: {
      getPositions: async () => [{ symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "1" }],
      getBalance: () => balanceResponse,
    },
  });

  await positionStamped;
  now += 120_000;
  rejectBalance(new Error("delayed balance failure"));
  const result = await resultPromise;

  assert.equal(result.status, "available");
  assert.equal(result.observedAt, "2026-09-25T12:00:00.000Z");
  assert.equal(result.accountStatus, "unavailable");
  assert.equal(result.accountObservedAt, null);
  assert.equal(result.account, null);
});

test("keeps a reported zero PnL but does not invent one for a missing field", () => {
  const positions = normalizeBingXAccountPositions([
    { symbol: "BTC-USDT", positionSide: "BOTH", positionAmt: "-2", unrealizedProfit: "0" },
    { symbol: "BTC-USDT", positionSide: "LONG", positionAmt: "1" },
  ]);
  assert.equal(positions[0].side, "SHORT");
  assert.equal(positions[0].size, "2");
  assert.equal(positions[0].unrealizedPnlUsdt, "0");
  assert.equal(positions[1].unrealizedPnlUsdt, null);
  assert.equal(positions[1].entryPrice, null);
});

test("invalid exchange amounts fail instead of appearing as an empty account", () => {
  assert.throws(
    () => normalizeBingXAccountPositions([{ symbol: "BTC-USDT", positionAmt: "NaN" }]),
    /invalid amount/,
  );
  assert.throws(() => normalizeBingXAccountPositions({ positions: [] }), /not a list/);
});

test("unconfigured credentials do not make even a read request", async () => {
  let balanceCalls = 0;
  const result = await readBingXAccountPositions({
    credentialsConfigured: false,
    exchange: {
      getPositions: () => { throw new Error("must not request"); },
      getBalance: () => { balanceCalls++; throw new Error("must not request"); },
    },
  });
  assert.equal(result.status, "not_configured");
  assert.equal(result.observedAt, null);
  assert.deepEqual(result.positions, []);
  assert.equal(result.accountStatus, "not_configured");
  assert.equal(result.accountObservedAt, null);
  assert.equal(result.account, null);
  assert.equal(balanceCalls, 0);
});