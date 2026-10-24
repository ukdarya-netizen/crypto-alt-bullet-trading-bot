import assert from "node:assert/strict";
import test from "node:test";
import { createBingXLiveApi } from "../bingx-live-api.mjs";
import { reconcileLiveFunding } from "../live-funding.mjs";

const now = Date.parse("2026-09-27T18:00:00Z");
const start = now - 3 * 86_400_000;
const end = start + 2 * 60 * 60 * 1000;
const at = (time) => new Date(time).toISOString();
const candidate = {
  signal_id: "own", symbol: "BTCUSDT",
  snapshot: {
    mode: "live", fundingIsolationAtEntry: true,
    fundingIsolationStartedAt: at(start - 500),
  },
  unresolved: 0,
  client_ids: ["own-entry", "own-exit"],
  fills: [
    { side: "BUY", phase: "entry", state: "reconciled", quantity: "1",
      clientOrderId: "own-entry", filledAt: at(start) },
    { side: "SELL", phase: "exit", state: "reconciled", quantity: "1",
      clientOrderId: "own-exit", filledAt: at(end) },
  ],
};

function setup({ orders = [
  { clientOrderId: "own-entry", executedQty: "1" },
  { clientOrderId: "own-exit", executedQty: "1" },
], settlements = [] } = {}) {
  const saved = [];
  let covered = 0;
  const store = {
    listFundingCandidates: async () => covered ? [] : [candidate],
    recordFunding: async (row) => { saved.push(row); },
    certifyFundingCoverage: async () => { covered++; },
  };
  const exchange = {
    queryOrderHistory: async () => orders,
    queryForcedOrders: async () => [],
    queryFundingSettlements: async () => settlements,
  };
  return { store, exchange, saved, get covered() { return covered; } };
}

test("certifies complete zero-funding history and does not repeat coverage", async () => {
  const state = setup();
  assert.equal((await reconcileLiveFunding({ ...state, account: "owner", clock: () => now }))[0].status, "verified");
  assert.equal(state.covered, 1);
  assert.deepEqual(await reconcileLiveFunding({ ...state, account: "owner", clock: () => now }), []);
});

test("persists all signed exchange funding before certifying", async () => {
  const state = setup({ settlements: [
    { transactionId: "a", amountUsdt: "-0.012", settledAt: at(start + 100), time: start + 100 },
    { transactionId: "b", amountUsdt: "0.008", settledAt: at(start + 200), time: start + 200 },
  ] });
  assert.equal((await reconcileLiveFunding({ ...state, account: "owner", clock: () => now }))[0].status, "verified");
  assert.deepEqual(state.saved.map((row) => row.amountUsdt), ["-0.012", "0.008"]);
  assert.equal(state.covered, 1);
});

test("foreign filled orders or incomplete exchange history cannot certify", async () => {
  for (const orders of [
    [{ clientOrderId: "foreign", executedQty: "0.3" }],
    [{ clientOrderId: "own-entry", executedQty: "1" }],
  ]) {
    const state = setup({ orders });
    assert.equal((await reconcileLiveFunding({ ...state, account: "owner", clock: () => now }))[0].status, "incomplete");
    assert.equal(state.covered, 0);
  }
});

test("unproven entry isolation, forced orders, and failed writes leave coverage unset", async () => {
  const unproven = setup();
  unproven.store.listFundingCandidates = async () => [{
    ...candidate, snapshot: { mode: "live" },
  }];
  assert.equal((await reconcileLiveFunding({ ...unproven, account: "owner", clock: () => now }))[0].status, "incomplete");
  assert.equal(unproven.covered, 0);

  const forced = setup();
  forced.exchange.queryForcedOrders = async () => [{ symbol: "BTC-USDT" }];
  assert.equal((await reconcileLiveFunding({ ...forced, account: "owner", clock: () => now }))[0].status, "incomplete");
  assert.equal(forced.covered, 0);

  const failure = setup({ settlements: [
    { transactionId: "a", amountUsdt: "0.01", settledAt: at(start + 100), time: start + 100 },
  ] });
  failure.store.recordFunding = async () => { throw new Error("storage unavailable"); };
  assert.equal((await reconcileLiveFunding({ ...failure, account: "owner", clock: () => now }))[0].status, "incomplete");
  assert.equal(failure.covered, 0);
});

test("signed income reader splits saturated pages and refuses malformed exchange rows", async () => {
  const calls = [];
  const exchange = createBingXLiveApi({
    fetchImpl: async (raw) => {
      const url = new URL(raw);
      calls.push(url);
      const left = Number(url.searchParams.get("startTime"));
      const right = Number(url.searchParams.get("endTime"));
      const data = left === start && right === end
        ? Array.from({ length: 1000 }, (_, i) => ({
          symbol: "BTC-USDT", incomeType: "FUNDING_FEE", asset: "USDT",
          income: "0.1", time: start, tranId: String(i),
        }))
        : [{ symbol: "BTC-USDT", incomeType: "FUNDING_FEE", asset: "USDT",
          income: "-0.0001", time: left, tranId: String(left) }];
      return new Response(JSON.stringify({ code: 0, data }));
    },
    credentials: () => ({ key: "test", secret: "test" }),
    clock: () => now, sleep: async () => {},
  });
  const rows = await exchange.queryFundingSettlements("BTCUSDT", { startTs: start, endTs: end });
  assert.equal(rows.length, 2);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((url) => url.pathname === "/openApi/swap/v2/user/income" &&
    url.searchParams.get("incomeType") === "FUNDING_FEE"));
});

test("funding reader rejects a misleading empty envelope and out-of-window settlement", async () => {
  for (const data of [{ list: [] }, [{
    symbol: "BTC-USDT", incomeType: "FUNDING_FEE", asset: "USDT",
    income: "1", time: end + 1, tranId: "a",
  }]]) {
    const exchange = createBingXLiveApi({
      fetchImpl: async () => new Response(JSON.stringify({ code: 0, data })),
      credentials: () => ({ key: "test", secret: "test" }),
      clock: () => now, sleep: async () => {},
    });
    await assert.rejects(exchange.queryFundingSettlements("BTCUSDT", {
      startTs: start, endTs: end,
    }), /invalid funding/);
  }
});