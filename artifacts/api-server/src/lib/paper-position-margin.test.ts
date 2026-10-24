import assert from "node:assert/strict";
import { test } from "node:test";
import { assessPaperMargin } from "../bullet-bot/paper-margin.mjs";
import { paperPositionMargin } from "./paper-position-margin";

const position = (stopPrice: number, marginHeldUsd = 10) => ({
  mode: "paper",
  entryPrice: 100,
  remainingQty: 1,
  stopPrice,
  marginHeldUsd,
});

test("the stop percentage is an unleveraged price move, not a margin percentage", () => {
  const assessment = paperPositionMargin(position(92));
  assert.equal(assessment.stopPercentFromEntry, "-8");
  assert.equal(assessment.stopLossUsdt, "8");
  assert.equal(assessment.stopLossPercentOfMargin, "80");
  assert.equal(assessment.requiredMarginUsdt, "9.886");
  // At 8% the $10 base covers the 1%+1%+fee cushion without a top-up.
  assert.equal(assessment.status, "estimated_buffer");
});

test("a ten-percent price stop on $100 notional needs more than $10 collateral", () => {
  const assessment = paperPositionMargin(position(90));
  assert.equal(assessment.status, "estimated_shortfall");
  assert.equal(assessment.requiredMarginUsdt, "11.845");
  assert.equal(assessment.additionalMarginNeededUsdt, "1.845");
  assert.ok(Number(assessment.estimatedLiquidationPrice) > 90);
});

test("a larger held PAPER margin changes ROE at stop and moves the estimated liquidation price", () => {
  const assessment = paperPositionMargin(position(90, 12));
  assert.equal(assessment.status, "estimated_buffer");
  assert.equal(assessment.stopLossPercentOfMargin, "83.33333333333333333333333333333333333333");
  assert.ok(Number(assessment.estimatedLiquidationPrice) < 90);
});

test("runner uses its own stop after core closes and missing old data stays unknown", () => {
  const runner = paperPositionMargin({
    ...position(75, 2),
    remainingQty: 0.2,
    coreOpen: false,
    runnerOpen: true,
    runnerStopPrice: 100,
  });
  assert.equal(runner.stopPercentFromEntry, "0");
  assert.equal(runner.status, "estimated_buffer");
  assert.equal(paperPositionMargin({ entryPrice: 100, stopPrice: 90 }).status, "unavailable");
});

test("API risk and worker use the same assessment and modeled close-fee rate", () => {
  for (const rate of [undefined, 0.0005, 0.001]) {
    const snapshot = {
      ...position(89, 10),
      ...(rate === undefined ? {} : { feeModel: { rate } }),
    };
    const api = paperPositionMargin(snapshot);
    const worker = assessPaperMargin({
      entryPrice: 100,
      stopPrice: 89,
      remainingQty: 1,
      marginHeldUsdt: 10,
      closeFeeRate: rate,
    });
    assert.equal(api.requiredMarginUsdt, String(worker.requiredMarginUsdt));
    assert.equal(api.additionalMarginNeededUsdt, String(worker.topUpUsdt));
    assert.equal(api.bufferAtStopUsdt, String(worker.stopBufferUsdt));
  }
});