import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createWorker } from "../worker.mjs";
import { initialPosition } from "../engine.mjs";
import { paperFeeModel, paperFillCosts } from "../paper-fees.mjs";
import { buildSourceExitEvidence } from "../source-exit-evidence.mjs";

const sample = JSON.parse(
  await readFile(new URL("./fixtures/impulse-buy-sample.json", import.meta.url), "utf8"),
);

function harness() {
  const now = Date.parse(sample.signalAt) + 60_000;
  const entryPrice = 0.006;
  const quantity = 100;
  const feeModel = paperFeeModel(new Date(now).toISOString());
  const entryCosts = paperFillCosts(entryPrice, quantity, feeModel.rate);
  const position = {
    ...initialPosition(sample, {
      price: entryPrice,
      quantity,
      at: new Date(now - 10_000).toISOString(),
      mode: "paper",
      quantityPrecision: 2,
    }),
    marginHeldUsd: 10,
    realizedPnlUsdt: -entryCosts.feeUsdt,
    grossRealizedPnlUsdt: 0,
    feesPaidUsdt: entryCosts.feeUsdt,
    feeModel,
    paperFills: [{
      type: "entry",
      price: entryPrice,
      quantity,
      feeUsdt: entryCosts.feeUsdt,
      occurredAt: new Date(now - 10_000).toISOString(),
    }],
    paperMargin: { status: "verified" },
    fundingStatus: "current",
    fundingSettlements: [],
  };
  const events = [];
  let stored = position;
  let quoteCalls = 0;
  let lockCalls = 0;
  const missedSignalIds = [];
  const missingSignalCandidates = [];
  let quoteAt = new Date(now).toISOString();
  let sourceExitRequest = null;
  let nextSourceExitRequestId = 1;
  const store = {
    withLeaderLock: async (callback) => {
      lockCalls += 1;
      return callback();
    },
    listOpenPositions: async () => stored.status === "open"
      ? [{ sourceSignalId: stored.sourceSignalId, snapshot: stored }]
      : [],
    findMissingSourceSignalIds: async (sourceSignalIds) => {
      missingSignalCandidates.push(...sourceSignalIds);
      return [];
    },
    recordMissedSourceSignal: async (sourceSignalId) => {
      missedSignalIds.push(sourceSignalId);
      return false;
    },
    getPending: async () => null,
    queueSourceExitRequests: async ({ asOf, positions, observedAt }) => {
      if (sourceExitRequest) return [sourceExitRequest];
      if (stored.status !== "open") return [];
      const source = positions.get(stored.sourceSignalId);
      const evidence = buildSourceExitEvidence(source, {
        sourceSignalId: stored.sourceSignalId,
        symbol: stored.symbol,
        entryAt: stored.entryAt,
        signalAt: source?.signalAt ?? stored.signalAt,
        asOf,
        observedAt,
      });
      if (!evidence) return [];
      sourceExitRequest = {
        id: nextSourceExitRequestId++,
        sourceSignalId: stored.sourceSignalId,
        evidence,
        finished: false,
      };
      return [sourceExitRequest];
    },
    listPendingSourceExitRequests: async ({ sourceSignalId }) =>
      sourceExitRequest &&
      sourceExitRequest.sourceSignalId === sourceSignalId &&
      !sourceExitRequest.finished
        ? [sourceExitRequest]
        : [],
    settlePaperPosition: async (previous, next, options = {}) => {
      if (stored !== previous) return { kind: "stale" };
      assert.equal(options.closeSignal, next.status === "closed");
      stored = next;
      if (options.sourceExitRequestId !== undefined) {
        assert.equal(options.sourceExitRequestId, sourceExitRequest?.id);
        sourceExitRequest.finished = true;
      }
      events.push(...(options.events ?? []).map((event) => ({
        id: next.sourceSignalId,
        ...event,
      })));
      return { kind: "settled", position: stored };
    },
  };
  const exchange = {
    ticker: async () => {
      quoteCalls += 1;
      return {
        lastPrice: "0.0062",
        bid1Price: "0.0061",
        quoteAt,
      };
    },
  };
  return {
    worker: createWorker({ store, exchange, clock: () => now }),
    restartWorker: () => createWorker({ store, exchange, clock: () => now }),
    position,
    events,
    getStored: () => stored,
    setStored: (next) => { stored = next; },
    quoteCalls: () => quoteCalls,
    missedSignalIds,
    missingSignalCandidates,
    setQuoteAt: (next) => { quoteAt = next; },
    lockCalls: () => lockCalls,
    sourceExitRequest: () => sourceExitRequest,
    now,
  };
}

function sourceSnapshot(h, entries, asOf = h.now) {
  return h.worker.syncSourcePositions(
    new Map(entries),
    { asOf: new Date(asOf).toISOString() },
  );
}

test("source terminal closure settles the full PAPER remainder at a fresh BingX bid", async () => {
  const h = harness();
  const result = await sourceSnapshot(h, [[
    sample.sourceSignalId,
    {
      sourceSignalId: sample.sourceSignalId,
      symbol: sample.symbol,
      sourceStatus: "profit",
      sourceClosedAt: new Date(h.now - 1_000).toISOString(),
      sourceExitPrice: "0.005",
      sourceCancelReason: "closed by source",
    },
  ]]);

  const closed = h.getStored();
  assert.equal(h.lockCalls(), 1);
  assert.equal(h.quoteCalls(), 1);
  assert.equal(result[0].kind, "closed");
  assert.equal(closed.status, "closed");
  assert.equal(closed.remainingQty, 0);
  assert.equal(closed.paperFills.at(-1).quantity, h.position.remainingQty);
  assert.equal(closed.paperFills.at(-1).fillPrice, 0.0061);
  assert.notEqual(closed.paperFills.at(-1).fillPrice, 0.005);
  assert.equal(closed.paperFills.at(-1).reason, "source_bullet_closed");
  assert.equal(closed.sourceClosure.sourceStatus, "profit");
  assert.equal(closed.sourceClosure.sourceClosedAt, new Date(h.now - 1_000).toISOString());
  assert.equal(closed.sourceClosure.sourceCancelReason, "closed by source");
  const closeEvent = h.events.find((event) => event.kind === "paper_close_all");
  assert.equal(closeEvent.detail.reason, "source_bullet_closed");
  assert.equal(closeEvent.detail.sourceClosure.sourceStatus, "profit");
  assert.equal(closeEvent.detail.sourceClosure.sourceCancelReason, "closed by source");

  await sourceSnapshot(h, [[
    sample.sourceSignalId,
    {
      sourceSignalId: sample.sourceSignalId,
      symbol: sample.symbol,
      sourceStatus: "cancelled",
      sourceClosedAt: new Date(h.now - 500).toISOString(),
      sourceExitPrice: "0.005",
      sourceCancelReason: "source cancelled",
    },
  ]]);
  assert.equal(h.quoteCalls(), 1, "a closed position must not be settled again");
  assert.equal(h.events.filter((event) => event.kind === "paper_close_all").length, 1);
});

test("PAPER retains the source hold floor and reached milestone without reading a fill quote", async () => {
  const h = harness();
  const hold = {
    sourceSignalId: sample.sourceSignalId, symbol: sample.symbol,
    sourceAction: "hold", sourceStatus: "active", sourceUpdatedAt: new Date(h.now).toISOString(),
    sourceTrailingStopLevel: 0.008, sourceLastMilestone: 10,
  };
  await sourceSnapshot(h, new Map([[sample.sourceSignalId, hold]]));
  await sourceSnapshot(h, new Map([[sample.sourceSignalId, {
    ...hold, sourceTrailingStopLevel: 0.007, sourceLastMilestone: 5,
  }]]));
  assert.equal(h.getStored().sourceObservation.sourceTrailingStopLevel, 0.008);
  assert.equal(h.getStored().sourceObservation.sourceLastMilestone, 10);
  assert.equal(h.getStored().status, "open");
  assert.equal(h.quoteCalls(), 0);
});

test("missing, open, reclassified, mismatched, or invalid source data never closes PAPER", async () => {
  const invalidItems = [
    null,
    { sourceSignalId: sample.sourceSignalId, symbol: sample.symbol, sourceStatus: "active" },
    { sourceSignalId: sample.sourceSignalId, symbol: sample.symbol, sourceStatus: "in_run" },
    {
      sourceSignalId: sample.sourceSignalId,
      symbol: sample.symbol,
      sourceStatus: "reclassified",
      sourceClosedAt: new Date().toISOString(),
      sourceExitPrice: "0.006",
    },
    {
      sourceSignalId: "another-signal",
      symbol: sample.symbol,
      sourceStatus: "cancelled",
      sourceClosedAt: new Date().toISOString(),
      sourceExitPrice: "0.006",
    },
    {
      sourceSignalId: sample.sourceSignalId,
      symbol: "OTHERUSDT",
      sourceStatus: "cancelled",
      sourceClosedAt: new Date().toISOString(),
      sourceExitPrice: "0.006",
    },
    {
      sourceSignalId: sample.sourceSignalId,
      symbol: sample.symbol,
      sourceStatus: "cancelled",
      sourceClosedAt: "not-a-date",
      sourceExitPrice: "0.006",
    },
    {
      sourceSignalId: sample.sourceSignalId,
      symbol: sample.symbol,
      sourceStatus: "cancelled",
      sourceClosedAt: new Date().toISOString(),
      sourceExitPrice: "0",
    },
  ];
  for (const item of invalidItems) {
    const h = harness();
    const map = item === null
      ? new Map()
      : new Map([[sample.sourceSignalId, item]]);
    await sourceSnapshot(h, map);
    assert.equal(h.getStored().status, "open");
    assert.equal(h.quoteCalls(), 0);
    if (item === null) {
      assert.equal(h.events.length, 1);
      assert.equal(h.events[0].kind, "paper_source_observation");
      assert.equal(h.events[0].detail.sourceObservation.sourceAction, "unknown");
    } else assert.equal(h.events.length, 0);
  }

  for (const invalidSnapshot of [
    { ...harness().position, entryAt: "not-a-date" },
    { ...harness().position, remainingQty: 0 },
    { ...harness().position, remainingQty: "not-a-quantity" },
  ]) {
    const h = harness();
    h.setStored(invalidSnapshot);
    await sourceSnapshot(h, [[
      sample.sourceSignalId,
      {
        sourceSignalId: sample.sourceSignalId,
        symbol: sample.symbol,
        sourceStatus: "cancelled",
        sourceClosedAt: new Date(h.now - 1_000).toISOString(),
        sourceExitPrice: "0.006",
      },
    ]]);
    assert.equal(h.getStored().status, "open");
    assert.equal(h.quoteCalls(), 0);
  }

  for (const sourceClosedAt of [
    new Date(harness().now - 11_000).toISOString(),
    new Date(harness().now + 31_000).toISOString(),
  ]) {
    const h = harness();
    await sourceSnapshot(h, [[
      sample.sourceSignalId,
      {
        sourceSignalId: sample.sourceSignalId,
        symbol: sample.symbol,
        sourceStatus: "cancelled",
        sourceClosedAt,
        sourceExitPrice: "0.006",
      },
    ]]);
    assert.equal(h.getStored().status, "open");
    assert.equal(h.quoteCalls(), 0);
  }
});

test("expired with confirmed closure settles PAPER at a fresh local bid and preserves source exit price", async () => {
  const h = harness();
  const sourceExitPrice = "0.005";
  const sourceClosedAt = new Date(h.now - 1_000).toISOString();
  const result = await sourceSnapshot(h, [[sample.sourceSignalId, {
    sourceSignalId: sample.sourceSignalId,
    symbol: sample.symbol,
    sourceStatus: "expired",
    sourceUpdatedAt: sourceClosedAt,
    sourceClosedAt,
    sourceExitPrice,
    sourcePnlPercent: "2.3",
  }]]);

  const closed = h.getStored();
  assert.equal(result[0].kind, "closed");
  assert.equal(closed.status, "closed");
  assert.equal(closed.remainingQty, 0);
  assert.equal(h.quoteCalls(), 1);
  assert.equal(closed.paperFills.at(-1).fillPrice, 0.0061);
  assert.notEqual(closed.paperFills.at(-1).fillPrice, Number(sourceExitPrice));
  assert.equal(closed.paperFills.at(-1).reason, "source_bullet_closed");
  assert.equal(closed.sourceClosure.sourceStatus, "expired");
  assert.equal(closed.sourceClosure.sourceExitPrice, sourceExitPrice);
  assert.equal(closed.sourceClosure.sourceClosedAt, sourceClosedAt);
  const closeEvent = h.events.find((event) => event.kind === "paper_close_all");
  assert.equal(closeEvent.detail.fillPrice, 0.0061);
  assert.equal(closeEvent.detail.sourceClosure.sourceExitPrice, sourceExitPrice);
});

test("expired without closure evidence remains open and never backfills a PAPER position", async () => {
  const h = harness();
  const before = h.getStored();
  const expiredSource = {
    sourceSignalId: sample.sourceSignalId,
    symbol: sample.symbol,
    sourceStatus: "expired",
    sourceUpdatedAt: new Date(h.now - 1_000).toISOString(),
    sourceClosedAt: null,
    sourceExitPrice: null,
  };

  await sourceSnapshot(h, [[sample.sourceSignalId, expiredSource]]);
  assert.equal(h.getStored(), before);
  assert.equal(h.getStored().status, "open");
  assert.equal(h.quoteCalls(), 0, "expired is not an instruction to simulate a close");
  assert.equal(h.events.length, 0);
  assert.deepEqual(h.missedSignalIds, [], "expired sources are not eligible for missed-signal backfill");
  assert.deepEqual(h.missingSignalCandidates, []);

  h.setStored({ ...before, status: "closed" });
  await sourceSnapshot(h, [["expired-only", {
    ...expiredSource,
    sourceSignalId: "expired-only",
  }]]);
  assert.equal(h.getStored().status, "closed");
  assert.equal(h.quoteCalls(), 0);
  assert.deepEqual(h.missedSignalIds, [], "an expired-only snapshot does not create a source entry");
  assert.deepEqual(h.missingSignalCandidates, []);
});

test("a reclassified signal closes PAPER as a withdrawal without source fill evidence", async () => {
  const h = harness();
  const sourceUpdatedAt = new Date(h.now - 1_000).toISOString();
  const result = await sourceSnapshot(h, [[
    sample.sourceSignalId,
    {
      sourceSignalId: sample.sourceSignalId,
      symbol: sample.symbol,
      sourceStatus: "reclassified",
      sourceUpdatedAt,
      sourceClosedAt: null,
      sourceExitPrice: null,
      sourceCancelReason: "lc_no_lower_ob_moved_to_wait",
    },
  ]]);
  assert.equal(result[0]?.kind, "closed");
  assert.equal(h.getStored().status, "closed");
  assert.equal(h.getStored().paperFills.at(-1).fillPrice, 0.0061);
  assert.equal(h.getStored().paperFills.at(-1).reason, "source_bullet_withdrawn");
  assert.equal(h.getStored().sourceWithdrawal.reason, "source_withdrawal");
  assert.equal(h.getStored().sourceWithdrawal.sourceClosedAt, null);
  assert.equal(h.getStored().sourceWithdrawal.sourceExitPrice, null);
  assert.equal(h.getStored().sourceWithdrawal.sourceCancelReason, "lc_no_lower_ob_moved_to_wait");
  assert.equal(h.getStored().sourceClosure, undefined);
});

test("four provider-shaped null-close reclassifications exit PAPER at the fresh bid", async () => {
  for (const optionalFields of [
    {},
    { sourcePnlPercent: "0" },
    { sourcePeakPrice: "0.0061" },
    { sourceEntryPrice: null },
  ]) {
    const h = harness();
    const result = await sourceSnapshot(h, [[sample.sourceSignalId, {
      sourceSignalId: sample.sourceSignalId,
      signalAt: sample.signalAt,
      botEnqueuedAt: sample.signalAt,
      symbol: sample.symbol,
      initialStopPrice: "0.0055522",
      sourceStatus: "reclassified",
      sourceUpdatedAt: new Date(h.now - 1_000).toISOString(),
      sourceClosedAt: null,
      sourceEntryPrice: "0.006035",
      sourceExitPrice: null,
      sourcePnlPercent: null,
      sourcePeakPrice: null,
      sourceStopLossPrice: null,
      sourceTrailingStopLevel: null,
      sourceLastMilestone: null,
      sourceCancelReason: "lc_no_lower_ob_moved_to_wait",
      ...optionalFields,
    }]]);

    const closed = h.getStored();
    assert.equal(result[0].kind, "closed");
    assert.equal(closed.status, "closed");
    assert.equal(closed.paperFills.at(-1).fillPrice, 0.0061);
    assert.notEqual(closed.paperFills.at(-1).fillPrice, Number(closed.sourceWithdrawal.sourceExitPrice));
    assert.equal(closed.paperFills.at(-1).reason, "source_bullet_withdrawn");
    assert.equal(closed.sourceWithdrawal.sourceClosedAt, null);
    assert.equal(closed.sourceWithdrawal.sourceExitPrice, null);
  }
});

test("durable withdrawal survives quote failure, a later active snapshot, and worker restart", async () => {
  const h = harness();
  const withdrawal = {
    sourceSignalId: sample.sourceSignalId,
    signalAt: sample.signalAt,
    symbol: sample.symbol,
    sourceStatus: "reclassified",
    sourceUpdatedAt: new Date(h.now - 1_000).toISOString(),
    sourceClosedAt: null,
    sourceExitPrice: null,
    sourceCancelReason: "lc_no_lower_ob_moved_to_wait",
  };
  h.setQuoteAt(null);
  const first = await sourceSnapshot(h, [[sample.sourceSignalId, withdrawal]]);
  assert.equal(first[0].kind, "error");
  assert.equal(h.getStored().status, "open");
  assert.equal(h.sourceExitRequest().finished, false);

  const activeSnapshot = {
    ...withdrawal,
    sourceStatus: "active",
    sourceUpdatedAt: new Date(h.now).toISOString(),
    sourceCancelReason: null,
  };
  const second = await sourceSnapshot(h, [[sample.sourceSignalId, activeSnapshot]]);
  assert.equal(second[0].kind, "error");
  assert.equal(h.getStored().status, "open");
  assert.equal(h.sourceExitRequest().evidence.reason, "source_withdrawal");
  assert.equal(h.sourceExitRequest().evidence.sourceCancelReason, "lc_no_lower_ob_moved_to_wait");

  h.setQuoteAt(new Date(h.now).toISOString());
  await h.restartWorker().tick();
  assert.equal(h.getStored().status, "closed");
  assert.equal(h.getStored().paperFills.at(-1).fillPrice, 0.0061);
  assert.equal(h.getStored().paperFills.at(-1).reason, "source_bullet_withdrawn");
  assert.equal(h.sourceExitRequest().finished, true);
  const quotesAfterClose = h.quoteCalls();
  await h.restartWorker().tick();
  assert.equal(h.quoteCalls(), quotesAfterClose, "a completed request is idempotent");
  assert.equal(h.events.filter((event) => event.kind === "paper_close_all").length, 1);
});

test("source-directed PAPER closure waits for an exchange-timestamped fresh bid", async () => {
  const source = (h) => new Map([[
    sample.sourceSignalId,
    {
      sourceSignalId: sample.sourceSignalId,
      symbol: sample.symbol,
      sourceStatus: "cancelled",
      sourceClosedAt: new Date(h.now - 1_000).toISOString(),
      sourceExitPrice: "0.005",
    },
  ]]);
  for (const quoteAt of [null, new Date(harness().now - 90_000).toISOString()]) {
    const h = harness();
    h.setQuoteAt(quoteAt);
    const result = await h.worker.syncSourcePositions(source(h), {
      asOf: new Date(h.now).toISOString(),
    });
    assert.equal(result[0]?.kind, "error");
    assert.equal(h.getStored().status, "open");
    assert.equal(h.events.filter((event) => event.kind === "paper_close_all").length, 0);
    assert.equal(h.sourceExitRequest()?.finished, false);
  }
});

test("syncSourcePositions requires the documented Map interface", async () => {
  const h = harness();
  await assert.rejects(
    h.worker.syncSourcePositions({ [sample.sourceSignalId]: {} }),
    /sourceMap must be a Map/,
  );
  assert.equal(h.getStored().status, "open");
});

test("stale reclassified source observations remain factual, bounded, and deduplicated", async () => {
  const h = harness();
  const sourceUpdatedAt = new Date(h.now - 2_000).toISOString();
  const source = {
    sourceSignalId: sample.sourceSignalId,
    symbol: sample.symbol,
    sourceStatus: "reclassified",
    sourceUpdatedAt,
    sourceCancelReason: "r".repeat(500),
  };
  const before = h.getStored();
  const staleAsOf = h.now - 61_000;
  await sourceSnapshot(h, [[sample.sourceSignalId, source]], staleAsOf);

  const observed = h.getStored();
  assert.equal(observed.status, "open");
  assert.equal(observed.remainingQty, before.remainingQty);
  assert.equal(observed.stopPrice, before.stopPrice);
  assert.equal(observed.realizedPnlUsdt, before.realizedPnlUsdt);
  assert.equal(observed.sourceObservation.status, "reclassified");
  assert.equal(observed.sourceObservation.sourceUpdatedAt, sourceUpdatedAt);
  assert.equal(observed.sourceObservation.sourceCancelReason.length, 300);
  assert.equal(observed.sourceObservation.observedAt, new Date(h.now).toISOString());
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].kind, "paper_source_observation");

  await sourceSnapshot(h, [[sample.sourceSignalId, {
    ...source,
    sourceCancelReason: "reason changed but source update did not",
  }]], staleAsOf);
  assert.equal(h.events.length, 1, "polls/reason-only changes do not create repeat events");
  assert.equal(h.getStored().sourceObservation.sourceCancelReason.length, 300);

  await sourceSnapshot(h, [[sample.sourceSignalId, {
    sourceSignalId: sample.sourceSignalId,
    symbol: sample.symbol,
    sourceStatus: "in_run",
    sourceUpdatedAt: new Date(h.now - 1_000).toISOString(),
    sourceCancelReason: null,
  }]], staleAsOf);
  assert.equal(h.getStored().status, "open");
  assert.equal(h.getStored().sourceObservation.status, "in_run");
  assert.equal(h.events.length, 2, "a return to active state is recorded as recovery");

  const fresh = harness();
  await sourceSnapshot(fresh, [[sample.sourceSignalId, {
    sourceSignalId: sample.sourceSignalId,
    symbol: sample.symbol,
    sourceStatus: "active",
    sourceUpdatedAt: new Date(fresh.now - 1_000).toISOString(),
    sourceCancelReason: null,
  }]]);
  assert.equal(fresh.getStored().sourceObservation, undefined);
  assert.equal(fresh.events.length, 0, "active sources are not recorded without recovery");
});