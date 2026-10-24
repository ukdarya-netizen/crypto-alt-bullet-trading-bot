import assert from "node:assert/strict";
import test from "node:test";
import { compareExactDecimals, exactDecimalParts } from "../vst-exact-decimal.mjs";

test("recovery decimals compare numeric and padded provider aliases exactly", () => {
  for (const value of [7498.5, "7498.50", "07498.500"]) {
    assert.equal(compareExactDecimals(value, "7498.5"), 0);
  }
  assert.equal(compareExactDecimals("0.6140", 0.614), 0);
  assert.equal(compareExactDecimals("9007199254740993", "9007199254740992"), 1);
  assert.equal(compareExactDecimals("0.49150000000000005", "0.4915"), 1);
});

test("recovery decimal parts preserve split quantity sums and supported exponents", () => {
  assert.deepEqual(exactDecimalParts("5998.80"), { units: 59988n, scale: 1 });
  assert.deepEqual(exactDecimalParts("1499.70"), { units: 14997n, scale: 1 });
  assert.equal(compareExactDecimals("1.4997e3", "1499.7"), 0);
  assert.equal(compareExactDecimals("1e-30", `0.${"0".repeat(29)}1`), 0);
  assert.equal(compareExactDecimals("0e30", 0), 0);
});

test("malformed or unsupported recovery decimals are not guessed or rounded", () => {
  for (const value of [
    undefined, null, true, {}, "", " ", "-1", "0x10",
    "NaN", "Infinity", NaN, Infinity, "1e31", "1e-31",
    `0.${"0".repeat(30)}1`,
  ]) {
    assert.equal(exactDecimalParts(value), null);
    assert.equal(compareExactDecimals(value, 0), null);
  }
});