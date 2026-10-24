import assert from "node:assert/strict";
import { test } from "node:test";
import { GetJournalBotResponse, GetJournalVstEntryQueueResponse, GetJournalStrategyHistoryResponse, GetJournalVstPositionsResponse } from "@workspace/api-zod";

test("VST journal contract separates verified floor and requested profit protection", () => {
  const parsed = GetJournalVstPositionsResponse.shape.positions.element.parse({
    sourceSignalId: "test", symbol: "BTWUSDT", status: "open",
    updatedAt: "2026-10-04T12:31:16.332Z", entryPrice: "0.9986",
    signalReferencePrice: null, planningQuotePrice: null,
    planningQuoteObservedAt: null, planningPriceDeviationPct: null,
    entryFillAt: null, actualFillDeviationPct: null, remainingQty: "9051",
    stopPrice: "1.0486", currentPrice: null, unrealizedPnlUsdt: null,
    roePercent: null, exchangeQuantity: null, sourceMismatch: false,
    protectionStatus: "protected_degraded", deferredStopPrice: "1.0534",
    protectionObservedAt: "2026-10-04T12:31:16.332Z",
  });
  assert.equal(parsed.stopPrice, "1.0486");
  assert.equal(parsed.deferredStopPrice, "1.0534");
  assert.equal(parsed.protectionStatus, "protected_degraded");
  assert.equal(parsed.currentPrice, null, "a historical floor is not a current market read");
});

test("generated strategy history accepts all four PAPER scenario IDs", () => {
  const scenarioId = GetJournalStrategyHistoryResponse.shape.trades.element
    .shape.scenarios.element.shape.strategyId;
  for (const id of [1, 2, 3, 4]) assert.equal(scenarioId.safeParse(id).success, true);
  for (const id of [0, 5]) assert.equal(scenarioId.safeParse(id).success, false);
});

test("generated PAPER funding settlement count rejects negative values", () => {
  const countSchema =
    GetJournalBotResponse.shape.paperEquity.shape.fundingUnverifiedPositions
      .element.shape.verifiedSettlements;

  assert.equal(countSchema.safeParse(-1).success, false);
  assert.equal(countSchema.safeParse(0).success, true);
  assert.equal(countSchema.safeParse(1).success, true);
  assert.equal(countSchema.safeParse(0.5).success, false);
});

test("generated VST queue contract preserves unknown times and excludes payload fields", () => {
  const result = GetJournalVstEntryQueueResponse.parse({
    asOf: "2026-10-02T12:00:00.000Z",
    total: 1,
    hasMore: false,
    entries: [{
      sourceSignalId: "queue-test",
      symbol: "BTC-USDT",
      status: "pending",
      receivedAt: null,
      updatedAt: null,
      queueWaitMs: null,
      prepareMs: null,
      executeMs: null,
      stage: "queued",
      stageConfirmedAt: null,
      deferReason: null,
      body: { secret: "must-not-leave-the-server" },
    }],
  });
  assert.equal(result.entries[0].receivedAt, null);
  assert.equal(result.entries[0].queueWaitMs, null);
  assert.equal("body" in result.entries[0], false);
  assert.equal(GetJournalVstEntryQueueResponse.safeParse({
    ...result, entries: [{ ...result.entries[0], receivedAt: "invalid-time" }],
  }).success, false);
});