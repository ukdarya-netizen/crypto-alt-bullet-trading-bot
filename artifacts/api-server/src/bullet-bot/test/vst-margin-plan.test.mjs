import test from "node:test";
import assert from "node:assert/strict";
import { calculateVstMarginTopUp } from "../vst-margin-plan.mjs";

const grt = {
  quantity: "339778", stopLoss: "0.02591", avgPrice: "0.0287",
  liquidationPrice: "0.02609", minIncreaseMargin: "292.52",
  pricePrecision: 5, availableMargin: "95732.0667",
};

test("live GRT-sized margin plan honors BingX's minimum above the entry estimate", () => {
  const plan = calculateVstMarginTopUp(grt);
  assert.equal(plan.amount, "292.53");
  assert.equal(plan.minimum, 292.52);
  assert.ok(Number(plan.amount) > 140.51);
});

test("the live liquidation/stop gap, not a preset amount, determines margin", () => {
  const plan = calculateVstMarginTopUp({
    ...grt, liquidationPrice: "0.027", minIncreaseMargin: "0.01",
  });
  assert.ok(Number(plan.amount) > 400);
});

test("safe liquidation needs no extra margin; insufficient balance fails closed", () => {
  assert.equal(calculateVstMarginTopUp({
    ...grt, liquidationPrice: "0.025",
  }).amount, null);
  assert.throws(() => calculateVstMarginTopUp({
    ...grt, availableMargin: "200",
  }), /exceeds verified available VST/);
  assert.throws(() => calculateVstMarginTopUp({
    ...grt, minIncreaseMargin: undefined,
  }), /minimum margin increase is unavailable/);
});