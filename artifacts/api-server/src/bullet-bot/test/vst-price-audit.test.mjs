import assert from "node:assert/strict";
import test from "node:test";
import { vstPositionPriceAudit } from "../vst-price-audit.mjs";

test("VST price audit exposes separate planning and verified-fill prices and times", () => {
  const quoteAt = Date.parse("2026-10-02T00:00:01.000Z");
  const fillAt = "2026-10-02T00:00:02.000Z";
  assert.deepEqual(vstPositionPriceAudit({
    sizing: {
      signalReferencePrice: 100,
      quotePrice: 102,
      quoteObservedAtMs: quoteAt,
      signalPriceDeviationPct: 2,
    },
    verifiedFill: { price: 103, at: fillAt },
    priceAudit: {
      signalReferencePrice: "100",
      planningQuotePrice: "102",
      planningQuoteObservedAt: new Date(quoteAt).toISOString(),
      planningPriceDeviationPct: 2,
      verifiedFillPrice: "103",
      verifiedFillAt: fillAt,
      actualFillDeviationPct: 3,
    },
  }), {
    signalReferencePrice: "100",
    planningQuotePrice: "102",
    planningQuoteObservedAt: new Date(quoteAt).toISOString(),
    planningPriceDeviationPct: 2,
    entryFillAt: fillAt,
    actualFillDeviationPct: 3,
  });
});

test("legacy snapshots retain planning audit but never invent an actual fill deviation", () => {
  assert.deepEqual(vstPositionPriceAudit({
    sizing: {
      signalReferencePrice: 90,
      quotePrice: 100,
      quoteObservedAtMs: Date.parse("2026-10-02T00:00:01.000Z"),
      signalPriceDeviationPct: 11.111111,
    },
    verifiedFill: { price: 101, at: Date.parse("2026-10-02T00:00:02.000Z") },
  }), {
    signalReferencePrice: "90",
    planningQuotePrice: "100",
    planningQuoteObservedAt: "2026-10-02T00:00:01.000Z",
    planningPriceDeviationPct: 11.111111,
    entryFillAt: "2026-10-02T00:00:02.000Z",
    actualFillDeviationPct: null,
  });
});