import assert from "node:assert/strict";
import test from "node:test";
import { sizeVstLongTrade } from "../vst-sizing.mjs";
import {
  OWNER_POSITION_PROFILE, allocationBudget, normalizePositionProfile, positionMatchesProfile,
} from "../vst-position-profile.mjs";
import { createBingXLiveApi } from "../bingx-live-api.mjs";

const NOW = 1_800_000_000_000;
const base = {
  environment: "vst",
  symbol: "BTCUSDT",
  balanceSnapshot: { asset: "VST", balance: "10000", equity: "10000", availableMargin: "10000" },
  quote: { price: "100", observedAtMs: NOW - 1_000 },
  nowMs: NOW,
  maxQuoteAgeMs: 10_000,
  expectedPrice: "100",
  maxSlippageBps: 100,
  stopLoss: "80",
  filters: {
    symbol: "BTC-USDT", quantityPrecision: 3, pricePrecision: 2,
    minQuantity: "0.001", minNotional: "5", maxLeverage: 50,
  },
  takerFeeRate: "0.0005",
  fundingRate: 0,
  maintenanceMarginRate: "0.01",
  stopBufferRate: "0.005",
  tickSize: "0.01",
  maxPositionValue: "1000000",
};

test("owner profile is isolated 10x with 1% of balance", () => {
  assert.deepEqual(normalizePositionProfile(), OWNER_POSITION_PROFILE);
  assert.equal(allocationBudget(OWNER_POSITION_PROFILE, 10000), 100);
});

test("profile validation refuses unknown modes and out-of-range values", () => {
  const ok = { leverage: 5, marginMode: "CROSSED", allocation: { mode: "amount", value: 50 } };
  assert.doesNotThrow(() => normalizePositionProfile(ok));
  assert.throws(() => normalizePositionProfile({ ...ok, marginMode: "CROSS" }));
  assert.throws(() => normalizePositionProfile({ ...ok, leverage: 0 }));
  assert.throws(() => normalizePositionProfile({ ...ok, leverage: 2.5 }));
  assert.throws(() => normalizePositionProfile({ ...ok, allocation: { mode: "percent", value: 0 } }));
  assert.throws(() => normalizePositionProfile({ ...ok, allocation: { mode: "percent", value: 101 } }));
  assert.throws(() => normalizePositionProfile({ ...ok, allocation: { mode: "both", value: 1 } }));
});

test("fixed amount: initial margin is the amount, position = amount x leverage", () => {
  const result = sizeVstLongTrade({
    ...base,
    positionProfile: { leverage: 5, marginMode: "ISOLATED", allocation: { mode: "amount", value: 50 } },
  });
  assert.equal(result.status, "ready");
  assert.equal(result.initialBudgetVst, 50);
  assert.equal(result.leverage, 5);
  assert.equal(result.marginMode, "ISOLATED");
  assert.ok(result.initialMarginVst <= 50);
  assert.ok(result.entryNotionalVst <= 50 * 5);
  assert.ok(result.entryNotionalVst > 50 * 5 * 0.9);
});

test("percent of balance with higher leverage", () => {
  const result = sizeVstLongTrade({
    ...base,
    positionProfile: { leverage: 20, marginMode: "ISOLATED", allocation: { mode: "percent", value: 2.5 } },
  });
  assert.equal(result.status, "ready");
  assert.equal(result.initialBudgetVst, 250);
  assert.equal(result.leverage, 20);
  assert.ok(result.entryNotionalVst <= 250 * 20);
  // A 20% stop at 20x is beyond isolated liquidation: margin top-up is planned.
  assert.ok(result.plannedTopUpVst > 0);
});

test("cross margin never plans an isolated top-up", () => {
  const result = sizeVstLongTrade({
    ...base,
    positionProfile: { leverage: 20, marginMode: "CROSSED", allocation: { mode: "percent", value: 2.5 } },
  });
  assert.equal(result.status, "ready");
  assert.equal(result.marginMode, "CROSSED");
  assert.equal(result.plannedTopUpVst, 0);
});

test("amount larger than available margin is refused, not resized up", () => {
  const result = sizeVstLongTrade({
    ...base,
    balanceSnapshot: { ...base.balanceSnapshot, availableMargin: "40" },
    positionProfile: { leverage: 2, marginMode: "CROSSED", allocation: { mode: "amount", value: 100 } },
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.includes("insufficient_available_vst"));
});

test("contract max leverage below the chosen leverage blocks sizing", () => {
  assert.throws(() => sizeVstLongTrade({
    ...base,
    filters: { ...base.filters, maxLeverage: 10 },
    positionProfile: { leverage: 20, marginMode: "ISOLATED", allocation: { mode: "percent", value: 1 } },
  }), /leverage 20/);
});

test("position snapshots match only their own profile", () => {
  const cross = normalizePositionProfile({ leverage: 3, marginMode: "CROSSED", allocation: { mode: "percent", value: 1 } });
  assert.equal(positionMatchesProfile({ leverage: "3", marginMode: "CROSSED" }, cross), true);
  assert.equal(positionMatchesProfile({ leverage: 3, marginMode: "CROSS" }, cross), true);
  assert.equal(positionMatchesProfile({ leverage: 10, marginMode: "ISOLATED" }, cross), false);
  assert.equal(positionMatchesProfile({ leverage: 10, marginMode: "ISOLATED" }, OWNER_POSITION_PROFILE), true);
});

test("API client exposes its profile; owner default unchanged", () => {
  const owner = createBingXLiveApi({ environment: "vst", fetchImpl: async () => { throw new Error("no"); } });
  assert.deepEqual(owner.positionProfile, OWNER_POSITION_PROFILE);
  const sub = createBingXLiveApi({
    environment: "vst", fetchImpl: async () => { throw new Error("no"); },
    positionProfile: { leverage: 3, marginMode: "CROSSED", allocation: { mode: "amount", value: 25 } },
  });
  assert.equal(sub.positionProfile.leverage, 3);
  assert.equal(sub.positionProfile.marginMode, "CROSSED");
  assert.throws(() => createBingXLiveApi({ environment: "vst", positionProfile: { leverage: 3 } }));
});
