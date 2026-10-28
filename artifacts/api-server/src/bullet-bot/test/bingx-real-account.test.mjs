import assert from "node:assert/strict";
import test from "node:test";
import {
  REAL_ACCOUNT_CAPABILITY, createBingXLiveApi, createBingXOutboundPacer,
  realAccountData, realAccountParams,
} from "../bingx-live-api.mjs";

function client({ account, data }) {
  const calls = [];
  const api = createBingXLiveApi({
    environment: "vst",
    account,
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data }) };
    },
    requestPacer: createBingXOutboundPacer({ gapMs: 0, clock: Date.now, sleep: async () => {} }),
    credentials: () => ({ key: "mock-key", secret: "mock-secret" }),
  });
  return { api, calls };
}

test("real account: mainnet host, USDT balance read as the executor's margin asset", async () => {
  const { api, calls } = client({ account: REAL_ACCOUNT_CAPABILITY,
    data: { balance: { asset: "USDT", availableMargin: "42" } } });
  const balance = await api.getBalance();
  assert.equal(calls[0].url.origin, "https://open-api.bingx.com");
  assert.equal(JSON.stringify(balance).includes('"asset":"VST"'), true);
});

test("demo account is unchanged: VST host, no translation", async () => {
  const { api, calls } = client({ account: undefined,
    data: { balance: { asset: "VST", availableMargin: "42" } } });
  const balance = await api.getBalance();
  assert.equal(calls[0].url.origin, "https://open-api-vst.bingx.com");
  assert.equal(JSON.stringify(balance).includes('"asset":"VST"'), true);
});

test("only the exact capability object switches to the real account", () => {
  assert.throws(() => createBingXLiveApi({ environment: "vst", account: { realAccount: "bingx-usdt-perpetual" } }));
  assert.throws(() => createBingXLiveApi({ environment: "vst", account: "real" }));
  assert.throws(() => createBingXLiveApi({ environment: "mainnet", account: REAL_ACCOUNT_CAPABILITY }));
});

test("translation touches only the margin-asset fields", () => {
  assert.deepEqual(realAccountParams({ symbol: "X-USDT", currency: "VST" }), { symbol: "X-USDT", currency: "USDT" });
  assert.deepEqual(realAccountParams({ currency: "USDT" }), { currency: "USDT" });
  const fills = realAccountData("/openApi/swap/v2/trade/allFillOrders",
    { fill_orders: [{ commissionAsset: "USDT", currency: "USDT", realisedPnlAsset: "USDT", symbol: "X-USDT" }] });
  assert.deepEqual(fills.fill_orders[0],
    { commissionAsset: "VST", currency: "USDT", realisedPnlAsset: "USDT", symbol: "X-USDT" });
  const contracts = [{ symbol: "X-USDT", currency: "USDT", asset: "USDT" }];
  assert.deepEqual(realAccountData("/openApi/swap/v2/quote/contracts", contracts), contracts);
  assert.deepEqual(realAccountData("/openApi/swap/v2/user/income", [{ asset: "USDT" }]), [{ asset: "USDT" }]);
  assert.deepEqual(realAccountData("/openApi/swap/v3/user/balance", [{ asset: "USDT" }, { asset: "BTC" }]),
    [{ asset: "VST" }, { asset: "BTC" }]);
});
