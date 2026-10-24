import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PAPER_ASSUMED_CLOSE_FEE_RATE,
  PAPER_ASSUMED_MAINTENANCE_RATE,
  PAPER_ASSUMED_SAFETY_RATE,
  PAPER_BASE_MARGIN_USDT,
  assessPaperMargin,
  paperMarginSnapshot,
  unverifiedPaperMargin,
} from "../paper-margin.mjs";

test("long-stop reserve includes loss, assumed maintenance, close fee, and safety", () => {
  const assessment = assessPaperMargin({
    entryPrice: 100,
    stopPrice: 90,
    remainingQty: 1,
    marginHeldUsdt: PAPER_BASE_MARGIN_USDT,
  });
  assert.equal(PAPER_ASSUMED_MAINTENANCE_RATE, 0.01);
  assert.equal(PAPER_ASSUMED_SAFETY_RATE, 0.01);
  assert.equal(PAPER_ASSUMED_CLOSE_FEE_RATE, 0.0005);
  assert.deepEqual(
    [
      assessment.lossAtStopUsdt,
      assessment.maintenanceReserveUsdt,
      assessment.modeledCloseFeeUsdt,
      assessment.safetyReserveUsdt,
      assessment.requiredMarginUsdt,
      assessment.topUpUsdt,
      assessment.status,
      assessment.stopPriceMovePct,
    ],
    [10, 0.9, 0.045, 0.9, 11.845, 1.845, "insufficient_funds", -10],
  );

  const topped = assessPaperMargin({
    entryPrice: 100,
    stopPrice: 90,
    remainingQty: 1,
    marginHeldUsdt: 11.845,
  });
  assert.equal(topped.status, "buffered");
  assert.equal(topped.stopBufferUsdt, 0);
  assert.equal(topped.topUpUsdt, 0);
});

test("margin shortfall and reserve are rounded upward to eight decimals", () => {
  const assessment = assessPaperMargin({
    entryPrice: "100.00000001",
    stopPrice: "90.00000001",
    remainingQty: "0.123456789",
    marginHeldUsdt: 0,
  });
  assert.equal(
    assessment.requiredMarginUsdt,
    Number(assessment.requiredMarginUsdt.toFixed(8)),
  );
  assert.ok(assessment.requiredMarginUsdt * 100_000_000 % 1 === 0);
  assert.equal(assessment.topUpUsdt, assessment.requiredMarginUsdt);
});

test("snapshots surface assumptions; legacy margin remains explicitly unverified", () => {
  const assessment = assessPaperMargin({
    entryPrice: 100,
    stopPrice: 95,
    remainingQty: 1,
    marginHeldUsdt: PAPER_BASE_MARGIN_USDT,
  });
  const snapshot = paperMarginSnapshot({
    assessment,
    assessedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(snapshot.status, "buffered");
  assert.equal(snapshot.stopRequiredMarginUsdt, assessment.requiredMarginUsdt);
  assert.equal(snapshot.maintenanceRateAssumed, 0.01);
  assert.deepEqual(unverifiedPaperMargin({
    assessedAt: "2026-01-01T00:00:00.000Z",
  }), {
    model: "isolated-stop-buffer-v1",
    baseMarginUsdt: 10,
    addedMarginUsdt: 0,
    stopRequiredMarginUsdt: null,
    stopBufferUsdt: null,
    topUpRequiredUsdt: null,
    status: "unverified",
    maintenanceRateAssumed: 0.01,
    safetyRateAssumed: 0.01,
    closeFeeRateAssumed: 0.0005,
    maintenanceTierVerified: false,
    liquidationEstimateGuaranteed: false,
    assumptionNote: "Maintenance and safety rates are assumptions; BingX symbol/tier liquidation terms are not confirmed.",
    assessedAt: "2026-01-01T00:00:00.000Z",
    topUps: [],
    reason: "legacy_margin_fields_unavailable",
  });
});