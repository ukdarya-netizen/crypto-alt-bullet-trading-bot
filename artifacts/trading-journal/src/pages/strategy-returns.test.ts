import assert from "node:assert/strict";
import { test } from "node:test";
import { returnFor } from "./strategy-returns";

const verified = {
  environment: "paper" as const,
  status: "closed" as const,
  accountingStatus: "verified" as const,
  profitUsdt: "5",
  allocatedUsdt: "10",
};

test("a closed PAPER trade with incomplete funding suppresses the whole month/pattern", () => {
  const incomplete = { ...verified, accountingStatus: "incomplete" as const, profitUsdt: null };
  assert.deepEqual(returnFor([verified], "paper", "100"), {
    percent: 5, tradePercent: 50,
  });
  assert.equal(returnFor([verified, incomplete], "paper", "100"), null);
  assert.deepEqual(returnFor([verified, { ...incomplete, status: "open" as const }], "paper", "100"), {
    percent: 5, tradePercent: 50,
  });
});

test("REAL totals include verified closures only, never an incomplete or external result", () => {
  const live = { ...verified, environment: "live" as const };
  assert.deepEqual(returnFor([live, { ...live, accountingStatus: "incomplete", profitUsdt: null }],
    "live", "100"), { percent: 5, tradePercent: 50 });
  assert.equal(returnFor([{ ...live, accountingStatus: "incomplete", profitUsdt: null }],
    "live", "100"), null);
});