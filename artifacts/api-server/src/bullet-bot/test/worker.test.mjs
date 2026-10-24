import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createWorker } from "../worker.mjs";
import {
  PAPER_TAKER_FEE_RATE,
  paperFeeModel,
  paperFillCosts,
} from "../paper-fees.mjs";

const sample = JSON.parse(
  await readFile(
    new URL("./fixtures/impulse-buy-sample.json", import.meta.url),
    "utf8",
  ),
);
test("PAPER fixed five-percent take closes all once, including fees, with no partial", async () => {
  const h = harness(sample, undefined, undefined, 100, undefined,
    { strategyAuthority: "source", exitStrategy: "full_take_5pct" });
  await h.worker.tick();
  const initial = h.positions.get(sample.sourceSignalId);
  assert.equal(initial.runnerOpen, false);
  h.setPrice(initial.entryPrice * 1.0499);
  await h.worker.tick();
  assert.equal(h.positions.get(sample.sourceSignalId).status, "open");
  h.setPrice(initial.entryPrice * 1.05);
  h.setBidPrice(initial.entryPrice * 1.0498);
  await h.worker.tick();
  const closed = h.positions.get(sample.sourceSignalId);
  const exits = closed.paperFills.filter(fill => fill.type === "exit");
  assert.equal(closed.status, "closed");
  assert.equal(exits.length, 1);
  assert.equal(exits[0].quantity, initial.remainingQty);
  assert.equal(exits[0].reason, "fixed_price_take_profit_5pct");
  assert.ok(exits[0].feeUsdt > 0);
  assert.equal(h.account().reservedUsdt, 0);
  const balance = h.account();
  await h.worker.tick();
  assert.deepEqual(h.account(), balance);
});

function harness(signal = sample, validateOrder = async () => true, capQuantity, initialFreeUsdt = 100, feeReader, options = {}) {
  let now = Date.parse(signal.signalAt) + 30_000;
  let price = Number(signal.referencePrice);
  let lastPrice = null;
  let bidPrice;
  let markPrice = null;
  let markFailure = false;
  let fundingNextTime = null;
  let fundingIntervalHours = 8;
  let fundingRecords = [];
  let fundingFailure = false;
  let fundingHistoryObserver = () => {};
  let historicalRows = [];
  let fundingHistoryCalls = 0;
  let failNextSettlement = false;
  let simulatedSettlementFailures = 0;
  const rows = new Map();
  const positions = new Map();
  const events = [];
  let freeUsdt = initialFreeUsdt;
  let reservedUsdt = 0;
  let totalRealized = 0;
  const store = {
    withLeaderLock: async (cb) => cb(),
    getPending: async () =>
      [...rows.values()].find((row) => ["pending", "opening"].includes(row.status)) ?? null,
    setSignalStatus: async (id, status, reason) => {
      Object.assign(rows.get(id), { status, reason });
    },
    listOpenPositions: async () =>
      [...positions.values()]
        .filter((snapshot) => snapshot.status === "open")
        .map((snapshot) => ({ sourceSignalId: snapshot.sourceSignalId, snapshot })),
    listPaperFundingCandidates: async (timestamp = now, limit = 1) =>
      [...positions.values()]
        .filter((snapshot) => {
          if (!["open", "closed"].includes(snapshot.status)) return false;
          const attempt = Date.parse(snapshot.fundingHistoryAttemptAt ?? "");
          if (Number.isFinite(attempt) && timestamp - attempt < 5 * 60_000) return false;
          if (snapshot.fundingStatus === "legacy_unknown") {
            return snapshot.status === "open" &&
              snapshot.quantity === snapshot.remainingQty &&
              events.some((event) => event.id === snapshot.sourceSignalId && event.kind === "paper_entry") &&
              !events.some((event) => event.id === snapshot.sourceSignalId && event.kind.startsWith("paper_close_"));
          }
          if (!Array.isArray(snapshot.paperFills) || snapshot.paperFills.length === 0) return false;
          return snapshot.fundingStatus === "incomplete" ||
            (Number.isSafeInteger(Number(snapshot.fundingNextFundingTime)) &&
             Number(snapshot.fundingNextFundingTime) <= timestamp);
        })
        .sort((a, b) =>
          (Date.parse(a.fundingHistoryAttemptAt ?? "") || 0) -
          (Date.parse(b.fundingHistoryAttemptAt ?? "") || 0))
        .slice(0, limit)
        .map((snapshot) => ({ sourceSignalId: snapshot.sourceSignalId, status: snapshot.status, snapshot })),
    openPaperPosition: async (position) => {
      if (positions.has(position.sourceSignalId)) return { kind: "duplicate" };
      const model = position.feeModel ?? paperFeeModel();
      const costs = paperFillCosts(position.entryPrice, position.quantity, model.rate);
      const margin = Number(position.marginHeldUsd ?? 10);
      if (freeUsdt < margin + costs.feeUsdt) return { kind: "insufficient" };
      const savedPosition = {
        ...position,
        realizedPnlUsdt: -costs.feeUsdt,
        grossRealizedPnlUsdt: 0,
        feesPaidUsdt: costs.feeUsdt,
        feeModel: model,
        paperFills: [{
          type: "entry",
          price: position.entryPrice,
          quantity: position.quantity,
          notionalUsdt: costs.notionalUsdt,
          feeUsdt: costs.feeUsdt,
          feeRate: model.rate,
          feeModelVersion: model.version,
          feeTierVerified: model.accountTierVerified,
          feeCheckedAt: model.checkedAt,
          feeSource: model.source,
          feeScheduleUrl: paperFeeModel().scheduleUrl,
          executionType: "simulated_market_taker",
          reason: "market_entry",
          occurredAt: position.entryAt,
        }],
      };
      freeUsdt -= margin + costs.feeUsdt;
      reservedUsdt += margin;
      totalRealized -= costs.feeUsdt;
      positions.set(position.sourceSignalId, savedPosition);
      return { kind: "opened", position: savedPosition };
    },
    topUpPaperPosition: async (prior, next, amount, auditEvent = null) => {
      const current = positions.get(prior.sourceSignalId);
      if (
        !current ||
        current.marginHeldUsd !== prior.marginHeldUsd ||
        current.realizedPnlUsdt !== prior.realizedPnlUsdt ||
        current.status !== prior.status
      ) return { kind: "stale" };
      if (freeUsdt < amount) return { kind: "insufficient" };
      freeUsdt -= amount;
      reservedUsdt += amount;
      positions.set(next.sourceSignalId, next);
      if (auditEvent) {
        events.push({
          id: next.sourceSignalId,
          kind: auditEvent.kind,
          detail: auditEvent.detail,
        });
      }
      return { kind: "topped_up", position: next };
    },
    settlePaperPosition: async (prior, next, { events: auditEvents = [] } = {}) => {
      if (failNextSettlement) {
        failNextSettlement = false;
        simulatedSettlementFailures += 1;
        throw new Error("simulated settlement failure");
      }
      const current = positions.get(prior.sourceSignalId);
      if (
        current.marginHeldUsd !== prior.marginHeldUsd ||
        current.realizedPnlUsdt !== prior.realizedPnlUsdt ||
        (current.feesPaidUsdt ?? 0) !== (prior.feesPaidUsdt ?? 0) ||
        (current.fundingPaidUsdt ?? 0) !== (prior.fundingPaidUsdt ?? 0) ||
        JSON.stringify((current.fundingSettlements ?? [])
          .filter((settlement) => settlement.status === "applied" || settlement.status === "not_held")
          .map((settlement) => Number(settlement.fundingTime)).sort((a, b) => a - b)) !==
          JSON.stringify((prior.fundingSettlements ?? [])
            .filter((settlement) => settlement.status === "applied" || settlement.status === "not_held")
            .map((settlement) => Number(settlement.fundingTime)).sort((a, b) => a - b)) ||
        current.status !== prior.status
      ) return { kind: "stale" };
      const released = prior.marginHeldUsd - next.marginHeldUsd;
      const pnl = next.realizedPnlUsdt - prior.realizedPnlUsdt;
      freeUsdt += released + pnl;
      reservedUsdt -= released;
      totalRealized += pnl;
      positions.set(next.sourceSignalId, next);
      if (next.status === "closed") {
        Object.assign(rows.get(next.sourceSignalId), { status: "closed", reason: null });
      }
      for (const event of auditEvents) {
        events.push({
          id: next.sourceSignalId,
          kind: event.kind,
          detail: event.detail,
        });
      }
      return { kind: "settled" };
    },
    recordEvent: async (id, kind, detail) => events.push({ id, kind, detail }),
    getLegacyFundingEntry: async (id) => {
      const entries = events.filter((event) => event.id === id && event.kind === "paper_entry");
      return entries.length === 1 &&
        !events.some((event) => event.id === id && event.kind.startsWith("paper_close_"))
        ? { detail: entries[0].detail, created_at: new Date(
          Date.parse(positions.get(id).entryAt) + 200,
        ) }
        : null;
    },
  };
  rows.set(signal.sourceSignalId, {
    sourceSignalId: signal.sourceSignalId,
    body: structuredClone(signal),
    status: "pending",
  });
  const exchange = {
    validateOrder,
    ticker: async () => ({
      ask1Price: String(price),
      lastPrice: lastPrice ?? String(price),
      quoteAt: options.strategyAuthority === "source" ? new Date(now).toISOString() : undefined,
      bid1Price: bidPrice === undefined
        ? lastPrice ?? String(price)
        : bidPrice === null
          ? null
          : String(bidPrice),
    }),
    premiumIndex: async () => {
      if (markFailure) throw new Error("mark unavailable");
      return {
        symbol: signal.symbol,
        markPrice: String(markPrice ?? price),
        nextFundingTime: fundingNextTime ?? now + 8 * 60 * 60_000,
        fundingIntervalHours,
        observedAt: new Date(now).toISOString(),
        source: "BingX public swap premiumIndex",
      };
    },
    fundingHistory: async (_symbol, { startTime, endTime }) => {
      fundingHistoryCalls += 1;
      fundingHistoryObserver(positions.get(signal.sourceSignalId) ?? null);
      if (fundingFailure) throw new Error("funding history unavailable");
      return fundingRecords.filter(
        (record) => record.fundingTime >= startTime && record.fundingTime <= endTime,
      );
    },
    historicalKlines: async () => historicalRows,
    ...(capQuantity ? { capQuantity } : {}),
  };
  const worker = createWorker({ store, exchange, feeReader, clock: () => now, ...options });
  return {
    worker,
    store,
    rows,
    positions,
    events,
    account: () => ({ freeUsdt, reservedUsdt, totalRealized }),
    setFreeUsdt: (next) => { freeUsdt = next; },
    setPrice: (next) => { price = next; },
    setLastPrice: (next) => { lastPrice = next; },
    setBidPrice: (next) => { bidPrice = next; },
    setNow: (next) => { now = next; },
    setMarkPrice: (next) => { markPrice = next; },
    setMarkFailure: (next) => { markFailure = next; },
    setFundingNextTime: (next) => { fundingNextTime = next; },
    setFundingIntervalHours: (next) => { fundingIntervalHours = next; },
    setFundingRecords: (next) => { fundingRecords = next; },
    setFundingFailure: (next) => { fundingFailure = next; },
    setFundingHistoryObserver: (observer) => { fundingHistoryObserver = observer; },
    setHistoricalRows: (next) => { historicalRows = next; },
    fundingHistoryCalls: () => fundingHistoryCalls,
    failNextSettlement: () => { failNextSettlement = true; },
    simulatedSettlementFailures: () => simulatedSettlementFailures,
    setHeldMargin: (id, marginHeldUsd) => {
      const current = positions.get(id);
      const delta = marginHeldUsd - current.marginHeldUsd;
      freeUsdt -= delta;
      reservedUsdt += delta;
      positions.set(id, { ...current, marginHeldUsd });
    },
    makeLegacy: (id) => {
      const current = positions.get(id);
      freeUsdt += current.feesPaidUsdt;
      totalRealized += current.feesPaidUsdt;
      const legacy = {
        ...current,
        realizedPnlUsdt: current.grossRealizedPnlUsdt,
      };
      delete legacy.grossRealizedPnlUsdt;
      delete legacy.feesPaidUsdt;
      delete legacy.feeModel;
      delete legacy.paperFills;
      positions.set(id, legacy);
    },
  };
}

test("reset maintenance retains fresh PAPER entries instead of rejecting them", async () => {
  let paused = true;
  const h = harness(sample, undefined, undefined, 100, undefined, {
    strategyAuthority: "source", exitStrategy: "full_take_5pct",
    entryGuard: async () => paused ? "maintenance" : false,
  });
  await h.worker.tick();
  assert.equal(h.positions.size, 0);
  assert.equal(h.rows.get(sample.sourceSignalId).status, "pending");
  paused = false;
  await h.worker.tick();
  assert.equal(h.positions.get(sample.sourceSignalId).status, "open");
});
test("PAPER follows an explicit stop and full close without an autonomous take", async () => {
  const h = harness(sample, undefined, undefined, 100, undefined, { strategyAuthority: "source" });
  await h.worker.tick();
  const lookupPosition = async (_mode, id) => {
    const snapshot = h.positions.get(id);
    return snapshot ? { sourceSignalId: id, symbol: snapshot.symbol, status: snapshot.status, snapshot } : null;
  };
  const initial = h.positions.get(sample.sourceSignalId);
  assert.ok(initial);
  h.setPrice(Number(initial.entryPrice) * 1.2);
  h.setBidPrice(Number(initial.entryPrice) * 1.2);
  const base = { commandId: "paper-stop-cmd", sourceSignalId: sample.sourceSignalId,
    symbol: sample.symbol, sequence: 1, occurredAt: sample.signalAt, reason: "source_stop" };
  const stopPrice = String(Number(initial.stopPrice) * 1.01);
  const stop = await h.worker.executeSourceCommand({ ...base, type: "move_stop", stopPrice }, { lookupPosition });
  assert.equal(stop.status, "executed", JSON.stringify(stop));
  assert.equal(h.positions.get(sample.sourceSignalId).stopPrice, Number(stopPrice));
  assert.equal(h.positions.get(sample.sourceSignalId).remainingQty, initial.remainingQty);
  const close = { ...base, commandId: "paper-close-cmd", sequence: 2, type: "close" };
  const result = await h.worker.executeSourceCommand(close, { lookupPosition });
  assert.equal(result.status, "executed", JSON.stringify(result));
  assert.equal(h.positions.get(sample.sourceSignalId).status, "closed");
  const settled = h.account();
  assert.equal((await h.worker.executeSourceCommand(close, { lookupPosition })).status, "already_closed");
  assert.deepEqual(h.account(), settled);
});

test("paper entry persists and retry cannot create another position", async () => {
  const h = harness();
  await h.worker.tick();
  assert.equal(h.rows.get(sample.sourceSignalId).status, "open");
  assert.equal(h.positions.size, 1);
  assert.deepEqual(h.positions.get(sample.sourceSignalId).marketQuote, {
    price: String(Number(sample.referencePrice)),
    at: new Date(Date.parse(sample.signalAt) + 30_000).toISOString(),
    source: "BingX public swap ticker",
  });
  assert.equal(h.events.filter((e) => e.kind === "paper_entry").length, 1);
  await h.worker.tick();
  assert.equal(h.events.filter((e) => e.kind === "paper_entry").length, 1);
  const entry = h.positions.get(sample.sourceSignalId).paperFills[0];
  const entryFee = paperFillCosts(entry.price, entry.quantity).feeUsdt;
  assert.deepEqual(h.account(), {
    freeUsdt: 90 - entryFee, reservedUsdt: 10, totalRealized: -entryFee,
  });
  assert.equal(h.positions.get(sample.sourceSignalId).realizedPnlUsdt, -entryFee);
  assert.equal(h.positions.get(sample.sourceSignalId).grossRealizedPnlUsdt, 0);
  assert.equal(h.positions.get(sample.sourceSignalId).feesPaidUsdt, entryFee);
  assert.equal(h.positions.get(sample.sourceSignalId).feeModel.accountTierVerified, false);
  assert.deepEqual(h.positions.get(sample.sourceSignalId).marketMark, {
    price: String(Number(sample.referencePrice)),
    at: new Date(Date.parse(sample.signalAt) + 30_000).toISOString(),
    source: "BingX public swap premiumIndex",
  });
  assert.equal(h.positions.get(sample.sourceSignalId).fundingStatus, "current");
  assert.equal(h.positions.get(sample.sourceSignalId).fundingPaidUsdt, 0);
});

test("wide PAPER stop reserves only its exact modeled margin shortfall", async () => {
  const wideStopSignal = { ...sample, stopLoss: "0.0048" };
  const h = harness(wideStopSignal);
  await h.worker.tick();
  const position = h.positions.get(sample.sourceSignalId);
  assert.equal(h.rows.get(sample.sourceSignalId).status, "open");
  assert.ok(position.marginHeldUsd > 10);
  assert.equal(position.paperMargin.status, "buffered");
  assert.equal(
    Number((position.marginHeldUsd - 10).toFixed(8)),
    position.paperMargin.addedMarginUsdt,
  );
  assert.equal(position.paperMargin.stopBufferUsdt, 0);
  assert.equal(h.account().reservedUsdt, position.marginHeldUsd);
  assert.ok(Math.abs(
    h.account().freeUsdt - (100 - position.marginHeldUsd - position.feesPaidUsdt),
  ) < 0.00000001);
});

test("PAPER entry with an unaffordable modeled stop reserve is rejected atomically", async () => {
  const wideStopSignal = { ...sample, stopLoss: "0.0048" };
  const h = harness(wideStopSignal, async () => true, undefined, 10.1);
  await h.worker.tick();
  assert.equal(h.positions.size, 0);
  assert.equal(h.rows.get(sample.sourceSignalId).status, "rejected");
  assert.equal(h.rows.get(sample.sourceSignalId).reason, "insufficient_free_paper_balance");
  assert.deepEqual(h.account(), {
    freeUsdt: 10.1, reservedUsdt: 0, totalRealized: 0,
  });
  // A Telegram notifier drains this event kind (see paper-telegram.mjs) --
  // without it, an owner watching only Telegram never learns a signal was
  // rejected for lack of balance.
  const rejectionEvent = h.events.find(
    (event) => event.kind === "paper_rejected_insufficient_balance",
  );
  assert.ok(rejectionEvent, "expected a paper_rejected_insufficient_balance event");
  assert.equal(rejectionEvent.id, sample.sourceSignalId);
  assert.equal(rejectionEvent.detail.symbol, sample.symbol);
  assert.ok(rejectionEvent.detail.requiredUsdt > 0);
});

test("a recordEvent failure on an insufficient-balance rejection does not flip the signal to error", async () => {
  const wideStopSignal = { ...sample, stopLoss: "0.0048" };
  const h = harness(wideStopSignal, async () => true, undefined, 10.1);
  const originalRecordEvent = h.store.recordEvent;
  h.store.recordEvent = async (id, kind, detail) => {
    if (kind === "paper_rejected_insufficient_balance") {
      throw new Error("simulated telegram-event recording failure");
    }
    return originalRecordEvent(id, kind, detail);
  };
  await h.worker.tick();
  assert.equal(h.rows.get(sample.sourceSignalId).status, "rejected");
  assert.equal(h.rows.get(sample.sourceSignalId).reason, "insufficient_free_paper_balance");
});

test("a signal rejected for insufficient balance is never retried once capital frees up", async () => {
  // Policy decision (2026-09-29): balance-rejected signals stay rejected
  // forever, even after other positions close and free up capital. A delayed
  // retry would fill at a fresh quote potentially hours/days after
  // signal.signalAt, divorced from the SIGNAL_TTL_MS freshness guarantee and
  // no longer comparable to the source's own trade. See worker.mjs.
  const wideStopSignal = { ...sample, stopLoss: "0.0048" };
  const h = harness(wideStopSignal, async () => true, undefined, 10.1);
  await h.worker.tick();
  assert.equal(h.rows.get(sample.sourceSignalId).status, "rejected");
  assert.equal(h.rows.get(sample.sourceSignalId).reason, "insufficient_free_paper_balance");
  assert.equal(h.positions.size, 0);

  // Capital frees up well beyond what the original entry needed.
  h.setFreeUsdt(1000);
  await h.worker.tick();

  assert.equal(h.rows.get(sample.sourceSignalId).status, "rejected");
  assert.equal(h.rows.get(sample.sourceSignalId).reason, "insufficient_free_paper_balance");
  assert.equal(h.positions.size, 0, "a rejected signal must never be reopened once balance frees up");
});

test("legacy PAPER margin is topped up prospectively and audited once", async () => {
  const h = harness();
  await h.worker.tick();
  const legacy = h.positions.get(sample.sourceSignalId);
  legacy.stopPrice = 0.0048;
  delete legacy.paperMargin;
  h.positions.set(sample.sourceSignalId, legacy);
  const realizedBefore = h.account().totalRealized;
  await h.worker.tick();

  const updated = h.positions.get(sample.sourceSignalId);
  assert.ok(updated.marginHeldUsd > 10);
  assert.equal(updated.paperMargin.status, "buffered");
  assert.equal(updated.paperMargin.topUps.length, 1);
  assert.equal(updated.paperMargin.topUps[0].source, "paper_free_balance");
  assert.equal(h.account().reservedUsdt, updated.marginHeldUsd);
  assert.equal(h.account().totalRealized, realizedBefore);
  assert.equal(h.events.filter((event) => event.kind === "paper_margin_top_up").length, 1);
  await h.worker.tick();
  assert.equal(h.events.filter((event) => event.kind === "paper_margin_top_up").length, 1);
});

test("failed settlement after a top-up keeps the old stop until audited retry", async () => {
  const h = harness();
  await h.worker.tick();
  const id = sample.sourceSignalId;
  const opened = h.positions.get(id);
  const priorStop = opened.entryPrice * 0.8;
  const priorPeak = opened.peakPct;
  const legacy = {
    ...opened,
    stopPrice: priorStop,
    paperExitPolicy: {
      ...opened.paperExitPolicy,
      firstTargetExecuted: true,
      secondTargetExecuted: true,
    },
  };
  delete legacy.paperMargin;
  h.positions.set(id, legacy);
  h.setHeldMargin(id, 1);
  h.setPrice(legacy.entryPrice * 1.2);
  h.failNextSettlement();

  await h.worker.tick();

  assert.equal(h.simulatedSettlementFailures(), 1);
  const afterFailedSettlement = h.positions.get(id);
  assert.equal(afterFailedSettlement.stopPrice, priorStop);
  assert.equal(afterFailedSettlement.peakPct, priorPeak);
  assert.equal(
    afterFailedSettlement.marginHeldUsd,
    1 + afterFailedSettlement.paperMargin.topUps[0].amountUsdt,
  );
  assert.equal(afterFailedSettlement.paperMargin.topUps.length, 1);
  assert.equal(h.events.filter((event) => event.kind === "paper_margin_top_up").length, 1);
  assert.equal(h.events.filter((event) => event.kind === "paper_raise_stop").length, 0);

  await h.worker.tick();

  const retried = h.positions.get(id);
  assert.ok(retried.stopPrice > priorStop);
  assert.ok(retried.peakPct > priorPeak);
  assert.equal(retried.paperMargin.topUps.length, 1);
  assert.equal(h.events.filter((event) => event.kind === "paper_margin_top_up").length, 1);
  assert.equal(h.events.filter((event) => event.kind === "paper_raise_stop").length, 1);
});

test("validated premium-index mark is separate from executable ticker fills", async () => {
  const h = harness();
  h.setMarkPrice(Number(sample.referencePrice) * 1.01);
  await h.worker.tick();
  const position = h.positions.get(sample.sourceSignalId);
  assert.equal(position.entryPrice, Number(sample.referencePrice));
  assert.equal(position.marketMark.price, String(Number(sample.referencePrice) * 1.01));
  assert.notEqual(position.marketMark.price, String(position.entryPrice));

  const unavailable = harness();
  unavailable.setMarkFailure(true);
  await unavailable.worker.tick();
  const noMark = unavailable.positions.get(sample.sourceSignalId);
  assert.equal(noMark.marketMark, null);
  assert.equal(noMark.marketMarkStatus, "unavailable");
  assert.equal(noMark.fundingStatus, "incomplete");
});
test("invalid public lastPrice does not replace the last atomically saved PAPER quote", async () => {
  const h = harness();
  await h.worker.tick();
  const saved = h.positions.get(sample.sourceSignalId).marketQuote;
  h.setLastPrice("not-a-price");
  await h.worker.tick();
  assert.deepEqual(h.positions.get(sample.sourceSignalId).marketQuote, saved);
});
test("BingX quantity and protective stop normalization reach the PAPER position and event", async () => {
  const h = harness(sample, async () => ({
    quantity: "16570.0", stopLoss: "0.00544", minNotional: 2,
  }));
  await h.worker.tick();
  assert.equal(h.rows.get(sample.sourceSignalId).status, "open");
  assert.equal(h.positions.get(sample.sourceSignalId).quantity, 16570);
  assert.equal(h.positions.get(sample.sourceSignalId).stopPrice, 0.00544);
  assert.equal(h.events.find((e) => e.kind === "paper_entry").detail.source, "BingX");
  assert.equal(h.events.find((e) => e.kind === "paper_entry").detail.requestedQuantity, sample.quantity);
  assert.equal(h.events.find((e) => e.kind === "paper_entry").detail.requestedStopLoss, sample.stopLoss);
});
test("PAPER entry fails closed if a normalized quantity would exceed the sender's request", async () => {
  const h = harness(sample, async () => ({ quantity: String(Number(sample.quantity) * 2) }));
  await h.worker.tick();
  assert.equal(h.positions.size, 0);
  assert.equal(h.rows.get(sample.sourceSignalId).status, "rejected");
});
test("PAPER entry rejects a quote-capped size below the BingX contract minimum", async () => {
  const h = harness(sample, async () => ({
    quantity: "16570", minNotional: 2, instrument: { minQuantity: 16570 },
  }), () => "16569.9");
  await h.worker.tick();
  assert.equal(h.rows.get(sample.sourceSignalId).status, "rejected");
  assert.equal(h.rows.get(sample.sourceSignalId).reason, "bingx_min_quantity_at_entry");
  assert.equal(h.positions.size, 0);
});

test("PAPER rejects unsplittable ordinary and Impulse entries before reserving wallet funds", async () => {
  const ordinarySignal = structuredClone(sample);
  ordinarySignal.sourceSignalId = "cab-signal-10537";
  ordinarySignal.patternId = "balanced_grind";
  ordinarySignal.quantity = "3";
  delete ordinarySignal.payload.exitRules.runner;
  const impulseSignal = structuredClone(sample);
  impulseSignal.sourceSignalId = "cab-signal-10538";
  impulseSignal.quantity = "3";

  for (const signal of [ordinarySignal, impulseSignal]) {
    const h = harness(
      signal,
      async () => ({
        quantity: "3",
        instrument: { quantityPrecision: 0 },
      }),
    );
    await h.worker.tick();
    assert.equal(h.rows.get(signal.sourceSignalId).status, "rejected");
    assert.equal(
      h.rows.get(signal.sourceSignalId).reason,
      "paper_allocation_unsplittable_at_contract_precision",
    );
    assert.equal(h.positions.size, 0);
    assert.equal(h.account().freeUsdt, 100);
    assert.equal(h.account().reservedUsdt, 0);
    assert.equal(h.events.some((event) => event.kind === "paper_entry"), false);
  }
});

test("PAPER rejects BTC Impulse before reserving funds with a runner-specific reason", async () => {
  const btcSignal = structuredClone(sample);
  btcSignal.sourceSignalId = "cab-signal-10539";
  btcSignal.symbol = "BTCUSDT";
  btcSignal.patternId = "impulse_buy";
  const rules = btcSignal.payload.exitRules;
  delete rules.runner;
  rules.firstTargetPct = 1;
  rules.breakevenAtPct = 1;
  rules.protectedProfitAtPct = 0;
  rules.protectedProfitPct = 0;
  rules.trailingActivationPct = 2;
  rules.trailingGapPercentagePoints = 1;
  rules.progressMilestoneIntervalPct = 1;

  const h = harness(btcSignal);
  await h.worker.tick();

  assert.equal(h.rows.get(btcSignal.sourceSignalId).status, "rejected");
  assert.equal(
    h.rows.get(btcSignal.sourceSignalId).reason,
    "strategy4_paper_impulse_btc_runner_unsupported",
  );
  assert.equal(h.positions.size, 0);
  assert.equal(h.account().freeUsdt, 100);
  assert.equal(h.account().reservedUsdt, 0);
  assert.equal(h.events.some((event) => event.kind === "paper_entry"), false);
});

test("legacy unsplittable Impulse stop closes all and releases reserved PAPER margin", async () => {
  const signal = structuredClone(sample);
  signal.quantity = "5";
  const h = harness(
    signal,
    async () => ({
      quantity: "5",
      instrument: { quantityPrecision: 0 },
    }),
  );
  await h.worker.tick();
  const id = signal.sourceSignalId;
  const legacy = { ...h.positions.get(id) };
  delete legacy.paperExitPolicy;
  legacy.quantity = 3;
  legacy.remainingQty = 3;
  legacy.coreQty = 3;
  legacy.runnerQty = 0;
  legacy.paperQuantityPrecision = 0;
  legacy.coreOpen = true;
  legacy.runnerOpen = false;
  legacy.paperFills = legacy.paperFills.map((fill) =>
    fill.type === "entry" ? { ...fill, quantity: 3 } : fill);
  h.positions.set(id, legacy);

  h.setPrice(legacy.entryPrice * 0.8);
  await h.worker.tick();

  const closed = h.positions.get(id);
  assert.equal(closed.status, "closed");
  assert.equal(closed.remainingQty, 0);
  assert.equal(closed.runnerOpen, false);
  assert.equal(closed.marginHeldUsd, 0);
  assert.equal(closed.paperFills.filter((fill) => fill.type === "exit").length, 1);
  assert.equal(closed.paperFills.at(-1).quantity, 3);
  assert.equal(closed.paperFills.at(-1).reason, "legacy_unsplittable_protective_stop");
  assert.equal(h.account().reservedUsdt, 0);
  assert.equal(h.rows.get(id).status, "closed");
  assert.equal(h.events.some((event) =>
    event.kind === "paper_close_core" ||
    event.detail?.quantity === 0), false);
});

test("Strategy 4 PAPER ladder books three distinct partial-exit fills at +5/+10/+15", async () => {
  const signal = structuredClone(sample);
  signal.patternId = "balanced_grind";
  delete signal.payload.exitRules.runner;
  const h = harness(signal);
  await h.worker.tick();
  const entry = Number(signal.referencePrice);
  const initial = h.positions.get(signal.sourceSignalId);

  h.setPrice(entry * 1.05);
  await h.worker.tick();
  const afterFirst = h.positions.get(signal.sourceSignalId);
  assert.equal(afterFirst.status, "open");
  assert.equal(afterFirst.paperFills[1].reason, "strategy4_first_target_partial");
  assert.ok(Math.abs(
    afterFirst.paperFills[1].quantity - Number(signal.quantity) * 0.25,
  ) < 0.00000002);
  assert.equal(afterFirst.marginHeldUsd, Number(
    (initial.marginHeldUsd * afterFirst.remainingQty / initial.remainingQty).toFixed(8),
  ));
  assert.equal(h.account().reservedUsdt, afterFirst.marginHeldUsd);
  assert.equal(h.events.filter((event) => event.kind === "paper_close_partial").length, 1);

  h.setPrice(entry * 1.10);
  await h.worker.tick();
  const afterSecond = h.positions.get(signal.sourceSignalId);
  assert.equal(afterSecond.status, "open");
  assert.equal(afterSecond.paperFills[2].reason, "strategy4_second_target_partial");
  assert.ok(Math.abs(
    afterSecond.paperFills[2].quantity - Number(signal.quantity) * 0.25,
  ) < 0.00000002);
  assert.equal(afterSecond.marginHeldUsd, Number(
    (afterFirst.marginHeldUsd * afterSecond.remainingQty / afterFirst.remainingQty).toFixed(8),
  ));
  assert.equal(h.account().reservedUsdt, afterSecond.marginHeldUsd);
  assert.equal(h.events.filter((event) => event.kind === "paper_close_partial").length, 2);
  assert.deepEqual(
    h.events.filter((event) => event.kind === "paper_close_partial")
      .map((event) => event.detail.reason),
    ["strategy4_first_target_partial", "strategy4_second_target_partial"],
  );

  h.setPrice(entry * 1.15);
  await h.worker.tick();
  const closed = h.positions.get(signal.sourceSignalId);
  assert.equal(closed.status, "closed");
  assert.equal(closed.remainingQty, 0);
  assert.equal(closed.paperFills[3].reason, "strategy4_final_target_close");
  assert.ok(Math.abs(
    closed.paperFills[3].quantity - Number(signal.quantity) * 0.5,
  ) < 0.00000002);
  assert.ok(closed.realizedPnlUsdt > 0);
  assert.equal(closed.paperFills.filter((fill) => fill.type === "exit").length, 3);
});

test("Strategy 4 PAPER Impulse closes runner independently and takes two core tranches", async () => {
  const h = harness();
  await h.worker.tick();
  const initial = h.positions.get(sample.sourceSignalId);
  const entry = initial.entryPrice;
  assert.equal(initial.paperExitPolicy.version, "owner_strategy_4_v1");
  assert.ok(
    Math.abs(initial.runnerQty / initial.quantity - 0.2) < 0.000001,
    `runner=${initial.runnerQty}, quantity=${initial.quantity}, precision=${initial.paperQuantityPrecision}`,
  );
  assert.equal(initial.runnerStopPrice, entry);

  h.setPrice(entry * 0.99);
  await h.worker.tick();
  const runnerStopped = h.positions.get(sample.sourceSignalId);
  assert.equal(runnerStopped.status, "open");
  assert.equal(runnerStopped.coreOpen, true);
  assert.equal(runnerStopped.runnerOpen, false);
  assert.equal(runnerStopped.paperFills.at(-1).reason, "runner_stop");
  assert.ok(Math.abs(
    runnerStopped.paperFills.at(-1).quantity - initial.quantity * 0.2,
  ) < 0.00000002);
  assert.equal(h.rows.get(sample.sourceSignalId).status, "open");

  const noTargetH = harness();
  await noTargetH.worker.tick();
  noTargetH.setPrice(entry * 1.16);
  await noTargetH.worker.tick();
  const aboveTargets = noTargetH.positions.get(sample.sourceSignalId);
  assert.deepEqual(aboveTargets.paperFills.filter((fill) => fill.type === "exit")
    .map((fill) => fill.reason), [
      "strategy4_impulse_first_target_partial",
      "strategy4_impulse_second_target_partial",
    ]);
  assert.ok(aboveTargets.remainingQty < Number(sample.quantity));
  assert.equal(noTargetH.account().reservedUsdt, aboveTargets.marginHeldUsd);
  assert.equal(aboveTargets.runnerOpen, true);
});

test("Strategy 4 core trailing stop is raised and closes only the core tranche", async () => {
  const h = harness();
  await h.worker.tick();
  const initial = h.positions.get(sample.sourceSignalId);
  const entry = initial.entryPrice;

  h.setPrice(entry * 1.2);
  await h.worker.tick();
  const trailed = h.positions.get(sample.sourceSignalId);
  assert.ok(Math.abs(trailed.stopPrice - entry * 1.1) < 1e-10);
  assert.equal(
    h.events.filter((event) => event.kind === "paper_raise_stop").at(-1).detail.reason,
    "percentage_point_trailing_stop",
  );

  h.setPrice(entry * 1.09);
  await h.worker.tick();
  const afterCoreStop = h.positions.get(sample.sourceSignalId);
  assert.equal(afterCoreStop.status, "open");
  assert.equal(afterCoreStop.coreOpen, false);
  assert.equal(afterCoreStop.runnerOpen, true);
  assert.equal(afterCoreStop.paperFills.at(-1).reason, "core_protective_stop");
  assert.equal(
    h.events.filter((event) => event.kind === "paper_close_core").length,
    1,
  );
  assert.equal(h.rows.get(sample.sourceSignalId).status, "open");
});

test("Strategy 4 runner trailing stop closes runner once after core protection", async () => {
  const h = harness();
  await h.worker.tick();
  const initial = h.positions.get(sample.sourceSignalId);
  const entry = initial.entryPrice;

  h.setPrice(entry * 1.35);
  await h.worker.tick();
  const trailed = h.positions.get(sample.sourceSignalId);
  assert.ok(Math.abs(trailed.runnerStopPrice - entry * 1.05) < 1e-10);
  assert.equal(
    h.events.filter((event) =>
      event.kind === "paper_raise_stop" &&
      event.detail.reason === "runner_percentage_point_trailing_stop").length,
    1,
  );

  h.setPrice(entry * 1.2);
  await h.worker.tick();
  const coreClosed = h.positions.get(sample.sourceSignalId);
  assert.equal(coreClosed.coreOpen, false);
  assert.equal(coreClosed.runnerOpen, true);
  assert.equal(coreClosed.status, "open");

  h.setPrice(entry * 1.04);
  await h.worker.tick();
  const closed = h.positions.get(sample.sourceSignalId);
  assert.equal(closed.status, "closed");
  assert.equal(closed.runnerOpen, false);
  assert.equal(closed.paperFills.at(-1).reason, "runner_stop");
  assert.equal(h.rows.get(sample.sourceSignalId).status, "closed");
  assert.equal(h.events.filter((event) => event.kind === "paper_close_runner").length, 1);
  const eventsAfterClose = h.events.length;
  const walletAfterClose = h.account();
  await h.worker.tick();
  assert.equal(h.events.length, eventsAfterClose);
  assert.deepEqual(h.account(), walletAfterClose);
});
test("stale queued event cannot open a position", async () => {
  const h = harness();
  h.setNow(Date.parse(sample.signalAt) + 11 * 60_000);
  await h.worker.tick();
  assert.equal(h.rows.get(sample.sourceSignalId).status, "rejected");
  assert.equal(h.positions.size, 0);
});
test("PAPER entry refuses an unfunded notional after price drift", async () => {
  const h = harness();
  h.setPrice(Number(sample.referencePrice) * 1.05);
  await h.worker.tick();
  assert.equal(h.rows.get(sample.sourceSignalId).status, "rejected");
  assert.equal(h.positions.size, 0);
  assert.deepEqual(h.account(), {
    freeUsdt: 100, reservedUsdt: 0, totalRealized: 0,
  });
});

test("entry fee can make the fixed-margin PAPER entry unaffordable", async () => {
  const h = harness(sample, async () => true, undefined, 10.01);
  await h.worker.tick();
  assert.equal(h.positions.size, 0);
  assert.equal(h.rows.get(sample.sourceSignalId).status, "rejected");
  assert.equal(h.rows.get(sample.sourceSignalId).reason, "insufficient_free_paper_balance");
  assert.deepEqual(h.account(), {
    freeUsdt: 10.01, reservedUsdt: 0, totalRealized: 0,
  });
});

test("bid below target quote sets partial-exit PnL and taker fee from the bid fill", async () => {
  const signal = structuredClone(sample);
  signal.patternId = "balanced_grind";
  delete signal.payload.exitRules.runner;
  const h = harness(signal);
  await h.worker.tick();
  const entry = Number(signal.referencePrice);
  h.setPrice(entry * 1.05);
  h.setBidPrice(entry * 1.02);
  await h.worker.tick();

  const position = h.positions.get(signal.sourceSignalId);
  const firstTargetFill = position.paperFills[1];
  assert.equal(firstTargetFill.reason, "strategy4_first_target_partial");
  assert.equal(firstTargetFill.triggerPrice, entry * 1.05);
  assert.equal(firstTargetFill.fillPrice, entry * 1.02);
  assert.equal(firstTargetFill.fillPriceSource, "BingX public swap ticker bid1Price");
  assert.equal(firstTargetFill.feeUsdt,
    paperFillCosts(entry * 1.02, firstTargetFill.quantity).feeUsdt);
  const triggeredGross = position.paperFills
    .filter((fill) => fill.type === "exit")
    .reduce((sum, fill) => sum + fill.quantity * (fill.triggerPrice - entry), 0);
  assert.ok(position.grossRealizedPnlUsdt < triggeredGross);
  assert.equal(
    h.events.find((event) => event.kind === "paper_close_partial").detail.fillPrice,
    entry * 1.02,
  );
});

test("funding quantity after the first Strategy 4 target is the remaining position", async () => {
  const signal = structuredClone(sample);
  signal.patternId = "balanced_grind";
  delete signal.payload.exitRules.runner;
  const h = harness(signal);
  await h.worker.tick();
  const entry = h.positions.get(signal.sourceSignalId);
  const fundingAt = entry.fundingNextFundingTime;
  h.setPrice(entry.entryPrice * 1.05);
  await h.worker.tick();
  const afterTarget = h.positions.get(signal.sourceSignalId);
  assert.equal(afterTarget.paperFills.filter((fill) => fill.type === "exit").length, 1);
  assert.ok(Math.abs(afterTarget.remainingQty - Number(signal.quantity) * 0.75) < 0.00000002);

  h.setNow(fundingAt + 30_000);
  h.setFundingNextTime(fundingAt + 8 * 60 * 60_000);
  h.setMarkPrice(entry.entryPrice);
  h.setFundingRecords([{ fundingRate: "0.001", fundingTime: fundingAt }]);
  await h.worker.tick();

  const funded = h.positions.get(signal.sourceSignalId);
  const settlement = funded.fundingSettlements.at(-1);
  assert.equal(settlement.status, "applied");
  assert.ok(Math.abs(settlement.quantity - afterTarget.remainingQty) < 0.00000002);
  assert.ok(Math.abs(
    funded.fundingPaidUsdt -
      Number((afterTarget.remainingQty * entry.entryPrice * 0.001).toFixed(8)),
  ) < 0.00000002);
});

test("PAPER worker checks the fee again at exit without repricing the entry", async () => {
  const signal = structuredClone(sample);
  signal.patternId = "balanced_grind";
  delete signal.payload.exitRules.runner;
  let timestamp = Date.parse(sample.signalAt) + 30_000;
  let rate = 0.00035;
  let calls = 0;
  const feeReader = async (symbol) => {
    assert.equal(symbol, signal.symbol);
    calls += 1;
    return {
      ...paperFeeModel(new Date(timestamp).toISOString()),
      version: "bingx-perpetual-personal-taker-v1",
      rate,
      source: "BingX private swap commissionRate GET",
      accountTierVerified: true,
    };
  };
  const h = harness(signal, async () => true, undefined, 100, feeReader);
  await h.worker.tick();
  const entryFill = h.positions.get(signal.sourceSignalId).paperFills[0];
  assert.equal(entryFill.feeRate, 0.00035);
  rate = 0.0002;
  timestamp += 1000;
  h.setNow(timestamp);
  const entry = Number(signal.referencePrice);
  h.setPrice(entry * 1.05);
  await h.worker.tick();
  assert.equal(calls, 2);
  const position = h.positions.get(signal.sourceSignalId);
  const exitFill = position.paperFills[1];
  assert.equal(calls, 2);
  assert.equal(exitFill.feeRate, 0.0002);
  assert.equal(exitFill.feeUsdt, paperFillCosts(exitFill.price, exitFill.quantity, 0.0002).feeUsdt);
  assert.equal(position.paperFills[0].feeUsdt, entryFill.feeUsdt);
  assert.equal(position.paperFills[0].feeRate, 0.00035);
  assert.equal(exitFill.feeCheckedAt, new Date(timestamp).toISOString());
  await h.worker.tick();
  assert.equal(calls, 2);
});

test("a closing trigger without a validated bid cannot settle the PAPER position", async () => {
  const signal = structuredClone(sample);
  signal.patternId = "balanced_grind";
  delete signal.payload.exitRules.runner;
  const h = harness(signal);
  await h.worker.tick();
  const entry = Number(signal.referencePrice);
  h.setPrice(entry * 1.05);
  h.setBidPrice(null);
  const before = structuredClone(h.positions.get(signal.sourceSignalId));
  const balanceBefore = h.account();
  await h.worker.tick();
  assert.deepEqual(h.positions.get(signal.sourceSignalId), before);
  assert.deepEqual(h.account(), balanceBefore);
});

test("legacy positions pay only future simulated exit fees", async () => {
  const h = harness();
  await h.worker.tick();
  const legacy = h.positions.get(sample.sourceSignalId);
  legacy.paperExitPolicy = {
    ...legacy.paperExitPolicy,
    version: "owner_25_25_50_v1",
    targetPct: legacy.rules.firstTargetPct,
    firstTargetPct: legacy.rules.firstTargetPct,
    secondTargetPct: legacy.rules.firstTargetPct,
    status: "active",
  };
  legacy.coreQty = Number((legacy.quantity * 0.75).toPrecision(14));
  legacy.runnerQty = Number((legacy.quantity * 0.25).toPrecision(14));
  legacy.runnerOpen = false;
  legacy.runnerStopPrice = null;
  h.positions.set(sample.sourceSignalId, legacy);
  h.makeLegacy(sample.sourceSignalId);
  const entry = Number(sample.referencePrice);
  h.setPrice(entry * 1.16);
  await h.worker.tick();
  h.setPrice(entry * 1.05);
  await h.worker.tick();

  const position = h.positions.get(sample.sourceSignalId);
  const exits = position.paperFills.filter((fill) => fill.type === "exit");
  const exitFee = exits.reduce(
    (sum, exit) => sum + paperFillCosts(exit.fillPrice, exit.quantity).feeUsdt,
    0,
  );
  assert.equal(exits.length, 3);
  assert.deepEqual(exits.slice(0, 2).map((fill) => fill.reason), [
    "first_target_partial",
    "second_target_partial",
  ]);
  assert.equal(position.feesPaidUsdt, exitFee);
  assert.equal(
    position.grossRealizedPnlUsdt,
    Number(exits.reduce(
      (sum, exit) => sum + exit.quantity * (exit.fillPrice - entry),
      0,
    ).toFixed(8)),
  );
  assert.equal(position.realizedPnlUsdt, position.grossRealizedPnlUsdt - exitFee);
});

test("existing Impulse PAPER records one +5% and one +10% exit only on new eligible quotes", async () => {
  const h = harness();
  await h.worker.tick();
  const id = sample.sourceSignalId;
  const initial = structuredClone(h.positions.get(id));
  const legacy = {
    ...initial,
    peakPct: 6.4985,
    stopPrice: initial.entryPrice,
    milestones: { ...initial.milestones, breakevenReached: true },
    coreQty: initial.quantity * 0.75,
    runnerQty: initial.quantity * 0.25,
    runnerOpen: false,
    runnerStopPrice: null,
    paperExitPolicy: {
      ...initial.paperExitPolicy,
      version: "owner_25_25_50_v1",
      status: "prospective",
      targetPct: 10,
      firstTargetPct: 10,
      secondTargetPct: 10,
      firstTargetExecuted: false,
      secondTargetExecuted: false,
    },
  };
  h.positions.set(id, legacy);
  h.setPrice(initial.entryPrice * 1.0493);
  await h.worker.tick();
  const adopted = h.positions.get(id);
  assert.equal(adopted.paperExitPolicy.firstTargetPct, 5);
  assert.equal(adopted.paperFills.filter((fill) => fill.type === "exit").length, 0);
  assert.equal(adopted.marginHeldUsd, initial.marginHeldUsd);

  h.setPrice(initial.entryPrice * 1.051);
  h.setBidPrice(initial.entryPrice * 1.049);
  await h.worker.tick();
  const first = h.positions.get(id);
  const firstExit = first.paperFills.filter((fill) => fill.type === "exit");
  assert.equal(firstExit.length, 1);
  assert.equal(firstExit[0].reason, "first_target_partial");
  assert.ok(firstExit[0].fillPrice < firstExit[0].triggerPrice);
  assert.equal(first.runnerQty, legacy.runnerQty);
  assert.equal(first.stopPrice, initial.entryPrice);
  assert.ok(first.marginHeldUsd < adopted.marginHeldUsd);
  assert.equal(h.account().reservedUsdt, first.marginHeldUsd);

  h.setBidPrice(undefined);
  h.setPrice(initial.entryPrice * 1.101);
  await h.worker.tick();
  const second = h.positions.get(id);
  const exits = second.paperFills.filter((fill) => fill.type === "exit");
  assert.deepEqual(exits.map((fill) => fill.reason), [
    "first_target_partial", "second_target_partial",
  ]);
  assert.ok(second.marginHeldUsd < first.marginHeldUsd);
  assert.equal(h.account().reservedUsdt, second.marginHeldUsd);
  assert.equal(second.runnerQty, legacy.runnerQty);
  await h.worker.tick();
  assert.equal(h.positions.get(id).paperFills.filter((fill) => fill.type === "exit").length, 2);
});

test("legacy open 20% Impulse runner is labeled and never expanded or backfilled", async () => {
  const h = harness();
  await h.worker.tick();
  const id = sample.sourceSignalId;
  const legacy = { ...h.positions.get(id) };
  delete legacy.paperExitPolicy;
  legacy.coreOpen = false;
  legacy.runnerOpen = true;
  legacy.coreQty = 0;
  legacy.runnerQty = Number(legacy.quantity) * 0.2;
  legacy.remainingQty = legacy.runnerQty;
  legacy.runnerStopPrice = legacy.entryPrice;
  h.positions.set(id, legacy);
  const originalFillCount = legacy.paperFills.length;

  h.setPrice(legacy.entryPrice * 1.16);
  await h.worker.tick();

  const adopted = h.positions.get(id);
  assert.equal(adopted.remainingQty, legacy.remainingQty);
  assert.equal(adopted.runnerQty, legacy.runnerQty);
  assert.equal(adopted.paperFills.length, originalFillCount);
  assert.equal(adopted.paperExitPolicy.status, "legacy_runner_split");
  assert.equal(adopted.paperExitPolicy.legacyRunnerFraction, 0.2);
  assert.equal(adopted.paperFills.some((fill) =>
    fill.reason === "first_target_partial" ||
    fill.reason === "second_target_partial"), false);
});

test("funding history is charged once using the mark near settlement and backfilled atomically", async () => {
  const h = harness();
  await h.worker.tick();
  const entry = h.positions.get(sample.sourceSignalId);
  const expectedFundingTime = entry.fundingNextFundingTime;
  h.setPrice(entry.entryPrice * 1.02);
  h.setBidPrice(entry.entryPrice * 1.02);
  h.setNow(expectedFundingTime + 30_000);
  h.setFundingNextTime(expectedFundingTime + 8 * 60 * 60_000);
  h.setMarkPrice(entry.entryPrice);
  h.setFundingRecords([{
    fundingRate: "0.001",
    fundingTime: expectedFundingTime,
  }]);
  const before = h.account();
  await h.worker.tick();

  const position = h.positions.get(sample.sourceSignalId);
  const settlement = position.fundingSettlements[0];
  const expectedCost = Number((entry.quantity * entry.entryPrice * 0.001).toFixed(8));
  assert.equal(position.fundingStatus, "current");
  assert.equal(position.fundingPaidUsdt, expectedCost);
  assert.equal(position.realizedPnlUsdt, Number((before.totalRealized - expectedCost).toFixed(8)));
  assert.equal(settlement.status, "applied");
  assert.equal(settlement.priceSource, "BingX public premiumIndex mark near funding time");
  assert.equal(settlement.settlementPrice, entry.entryPrice);
  assert.equal(h.account().totalRealized, position.realizedPnlUsdt);
  assert.equal(h.events.filter((event) => event.kind === "paper_funding_settlement").length, 1);

  const calls = h.fundingHistoryCalls();
  await h.worker.tick();
  assert.equal(h.positions.get(sample.sourceSignalId).fundingPaidUsdt, expectedCost);
  assert.equal(h.account().totalRealized, position.realizedPnlUsdt);
  assert.equal(h.fundingHistoryCalls(), calls, "the next funding interval is not queried every 3s");
});

test("legacy entry proof applies observed funding once but never certifies missing intervals", async () => {
  const h = harness();
  await h.worker.tick();
  h.makeLegacy(sample.sourceSignalId);
  const position = h.positions.get(sample.sourceSignalId);
  h.setPrice(position.entryPrice * 1.02);
  h.setBidPrice(position.entryPrice * 1.02);
  position.fundingStatus = "legacy_unknown";
  delete position.fundingPaidUsdt;
  delete position.fundingSettlements;
  delete position.fundingNextFundingTime;
  const fundingTime = Date.parse(position.entryAt) + 4 * 60 * 60_000;
  h.setFundingRecords([{
    fundingTime, fundingRate: "0.001", markPrice: "100",
  }]);
  h.setNow(fundingTime + 30_000);
  h.setFundingNextTime(fundingTime + 4 * 60 * 60_000);
  const before = h.account().totalRealized;
  await h.worker.tick();
  const first = h.positions.get(sample.sourceSignalId);
  const debit = Number((position.quantity * 100 * 0.001).toFixed(8));
  assert.equal(first.fundingStatus, "legacy_unknown");
  assert.equal(first.fundingPaidUsdt, debit);
  assert.equal(first.fundingSettlements.length, 1);
  assert.equal(first.paperFills, undefined);
  assert.equal(h.account().totalRealized, Number((before - debit).toFixed(8)));

  h.setNow(fundingTime + 6 * 60_000);
  await h.worker.tick();
  assert.equal(h.positions.get(sample.sourceSignalId).fundingPaidUsdt, debit);
  assert.equal(h.account().totalRealized, Number((before - debit).toFixed(8)));

  const secondTime = fundingTime + 4 * 60 * 60_000;
  h.setFundingRecords([
    { fundingTime, fundingRate: "0.001", markPrice: "100" },
    { fundingTime: secondTime, fundingRate: "-0.002", markPrice: "101" },
  ]);
  h.setNow(secondTime + 30_000);
  h.setFundingNextTime(secondTime + 4 * 60 * 60_000);
  await h.worker.tick();
  const recovered = h.positions.get(sample.sourceSignalId);
  assert.equal(recovered.fundingStatus, "legacy_unknown");
  assert.equal(recovered.fundingSettlements.length, 2);
  assert.equal(recovered.fundingPaidUsdt, Number(
    (debit - position.quantity * 101 * 0.002).toFixed(8),
  ));
});

test("legacy funding is not applied without its original entry proof", async () => {
  const h = harness();
  await h.worker.tick();
  h.makeLegacy(sample.sourceSignalId);
  const position = h.positions.get(sample.sourceSignalId);
  h.setPrice(position.entryPrice * 1.02);
  h.setBidPrice(position.entryPrice * 1.02);
  position.fundingStatus = "legacy_unknown";
  h.events.splice(h.events.findIndex((event) => event.kind === "paper_entry"), 1);
  const before = h.account().totalRealized;
  h.setFundingRecords([{
    fundingTime: Date.parse(position.entryAt) + 4 * 60 * 60_000,
    fundingRate: "0.001", markPrice: "100",
  }]);
  h.setNow(Date.parse(position.entryAt) + 5 * 60 * 60_000);
  await h.worker.tick();
  assert.equal(h.account().totalRealized, before);
  assert.equal(h.positions.get(sample.sourceSignalId).fundingStatus, "legacy_unknown");
});

test("verified premium next time cannot skip an inferred funding boundary", async () => {
  const h = harness();
  await h.worker.tick();
  const entry = h.positions.get(sample.sourceSignalId);
  const firstFundingTime = entry.fundingNextFundingTime;
  const nextBoundary = firstFundingTime + 8 * 60 * 60_000;
  h.setNow(firstFundingTime + 60_000);
  h.setFundingNextTime(firstFundingTime + 16 * 60 * 60_000);
  h.setFundingRecords([{
    fundingRate: "0.001",
    fundingTime: firstFundingTime,
    markPrice: "84057.9",
  }]);
  await h.worker.tick();

  let position = h.positions.get(sample.sourceSignalId);
  assert.equal(position.fundingNextFundingTime, nextBoundary);
  assert.equal(position.fundingStatus, "current");
  assert.equal(position.fundingSettlements[0].priceSource, "BingX public swap fundingRate markPrice");

  h.setNow(nextBoundary + 60_000);
  h.setFundingNextTime(firstFundingTime + 16 * 60 * 60_000);
  h.setFundingRecords([{
    fundingRate: "0.001",
    fundingTime: firstFundingTime,
    markPrice: "84057.9",
  }, {
    fundingRate: "-0.001",
    fundingTime: nextBoundary,
    markPrice: "84057.9",
  }]);
  await h.worker.tick();
  position = h.positions.get(sample.sourceSignalId);
  assert.equal(position.fundingSettlements.length, 2);
  assert.equal(position.fundingSettlements[1].fundingTime, nextBoundary);
  assert.equal(position.fundingNextFundingTime, firstFundingTime + 16 * 60 * 60_000);
});

test("missed history is explicit and retried with a historical candle, not today's quote", async () => {
  const h = harness();
  await h.worker.tick();
  const entry = h.positions.get(sample.sourceSignalId);
  const expectedFundingTime = entry.fundingNextFundingTime;
  h.setPrice(entry.entryPrice * 1.02);
  h.setBidPrice(entry.entryPrice * 1.02);
  h.setNow(expectedFundingTime + 30_000);
  h.setFundingNextTime(expectedFundingTime + 8 * 60 * 60_000);
  h.setMarkPrice(900);
  const before = h.account();
  await h.worker.tick();
  const incomplete = h.positions.get(sample.sourceSignalId);
  assert.equal(incomplete.fundingStatus, "incomplete");
  assert.equal(incomplete.fundingPaidUsdt, 0);
  assert.equal(h.account().totalRealized, before.totalRealized);
  assert.equal(incomplete.fundingNextFundingTime, expectedFundingTime);

  h.setFundingRecords([{
    fundingRate: "-0.001",
    fundingTime: expectedFundingTime,
  }]);
  h.setHistoricalRows([{
    time: expectedFundingTime - 60_000,
    close: "105",
  }]);
  h.setNow(expectedFundingTime + 5 * 60_000 + 30_001);
  await h.worker.tick();

  const recovered = h.positions.get(sample.sourceSignalId);
  assert.equal(recovered.fundingStatus, "current", JSON.stringify(recovered.fundingSettlements));
  assert.equal(recovered.fundingPaidUsdt, Number((-recovered.quantity * 105 * 0.001).toFixed(8)));
  assert.equal(recovered.fundingSettlements[0].priceSource, "BingX public 1m last-trade kline close");
  assert.equal(recovered.fundingSettlements[0].priceEstimation, "last_trade_kline_close_proxy");
  assert.equal(recovered.fundingSettlements[0].settlementPrice, 105);
  assert.equal(h.account().totalRealized, recovered.realizedPnlUsdt);
});

test("funding API failure does not block close and closed funding backfill credits once", async () => {
  const h = harness();
  await h.worker.tick();
  const position = h.positions.get(sample.sourceSignalId);
  h.setNow(position.fundingNextFundingTime + 30_000);
  h.setFundingNextTime(position.fundingNextFundingTime + 8 * 60 * 60_000);
  h.setFundingFailure(true);
  h.setPrice(position.stopPrice * 0.99);
  let positionWhenFundingWasRequested = null;
  h.setFundingHistoryObserver((snapshot) => {
    positionWhenFundingWasRequested = snapshot;
  });
  await h.worker.tick();
  const closed = h.positions.get(sample.sourceSignalId);
  assert.equal(closed.status, "closed");
  assert.equal(positionWhenFundingWasRequested.status, "closed");
  assert.equal(closed.fundingStatus, "incomplete");
  assert.equal(closed.remainingQty, 0);
  assert.equal(closed.fundingPaidUsdt, 0);
  assert.equal(h.account().reservedUsdt, 0);

  h.setFundingFailure(false);
  h.setFundingRecords([{
    fundingRate: "-0.001",
    fundingTime: position.fundingNextFundingTime,
    markPrice: "105",
  }]);
  h.setNow(position.fundingNextFundingTime + 5 * 60_000 + 30_001);
  const historyCalls = h.fundingHistoryCalls();
  await h.worker.tick();

  const recovered = h.positions.get(sample.sourceSignalId);
  const expectedCredit = Number((position.quantity * 105 * 0.001).toFixed(8));
  assert.equal(recovered.status, "closed");
  assert.equal(recovered.fundingStatus, "current");
  assert.equal(recovered.fundingPaidUsdt, -expectedCredit);
  assert.equal(recovered.realizedPnlUsdt, Number((closed.realizedPnlUsdt + expectedCredit).toFixed(8)));
  assert.equal(h.account().totalRealized, recovered.realizedPnlUsdt);
  assert.ok(h.fundingHistoryCalls() > historyCalls);

  const realized = h.account().totalRealized;
  const calls = h.fundingHistoryCalls();
  await h.worker.tick();
  assert.equal(h.positions.get(sample.sourceSignalId).fundingPaidUsdt, -expectedCredit);
  assert.equal(h.account().totalRealized, realized);
  assert.equal(h.fundingHistoryCalls(), calls);
});

test("Strategy 4 Impulse core has no four-day expiry and runner expires after 120 hours", async () => {
  const h = harness();
  await h.worker.tick();
  const entry = h.positions.get(sample.sourceSignalId).entryPrice;
  h.setPrice(entry * 1.02);
  h.setBidPrice(entry * 1.02);
  h.setNow(Date.parse(sample.signalAt) + 4 * 24 * 60 * 60_000 + 60_000);
  await h.worker.tick();
  assert.equal(h.positions.get(sample.sourceSignalId).status, "open");
  assert.equal(h.positions.get(sample.sourceSignalId).coreOpen, true);
  assert.equal(
    h.positions.get(sample.sourceSignalId).runnerOpen,
    true,
    JSON.stringify(h.positions.get(sample.sourceSignalId)),
  );
  h.setNow(Date.parse(sample.signalAt) + 5 * 24 * 60 * 60_000 + 60_000);
  await h.worker.tick();
  assert.equal(h.positions.get(sample.sourceSignalId).status, "open");
  assert.equal(h.positions.get(sample.sourceSignalId).coreOpen, true);
  assert.equal(h.positions.get(sample.sourceSignalId).runnerOpen, false);
  assert.equal(h.positions.get(sample.sourceSignalId).paperFills.at(-1).reason,
    "runner_max_age_expiry");
  assert.equal(h.events.filter((event) =>
    event.kind === "paper_close_runner" &&
    event.detail.reason === "runner_max_age_expiry").length, 1);
  const expiryEventCount = h.events.length;
  await h.worker.tick();
  assert.equal(h.events.length, expiryEventCount);
});

test("worker settles coincident Strategy 4 core stop and runner expiry in one tick", async () => {
  const h = harness();
  await h.worker.tick();
  const initial = h.positions.get(sample.sourceSignalId);
  const entry = initial.entryPrice;
  initial.stopPrice = entry * 1.05;
  h.positions.set(sample.sourceSignalId, initial);
  h.setPrice(entry * 1.04);
  h.setBidPrice(entry * 1.04);
  h.setNow(Date.parse(initial.entryAt) + 120 * 60 * 60_000);

  await h.worker.tick();

  const closed = h.positions.get(sample.sourceSignalId);
  const exits = closed.paperFills.filter((fill) => fill.type === "exit");
  assert.equal(closed.status, "closed");
  assert.deepEqual(exits.slice(-2).map(({ reason }) => reason), [
    "core_protective_stop",
    "runner_max_age_expiry",
  ]);
  assert.ok(Math.abs(exits.at(-2).quantity - initial.coreQty) < 0.00000002);
  assert.ok(Math.abs(exits.at(-1).quantity - initial.runnerQty) < 0.00000002);
  assert.equal(h.rows.get(sample.sourceSignalId).status, "closed");
  assert.equal(h.account().reservedUsdt, 0);
});

test("worker advances reduced Strategy 4 core stop on the runner-only 120-hour expiry quote", async () => {
  const h = harness();
  await h.worker.tick();
  const initial = h.positions.get(sample.sourceSignalId);
  const entry = initial.entryPrice;
  h.setPrice(entry * 1.4);
  h.setBidPrice(entry * 1.4);
  h.setNow(Date.parse(initial.entryAt) + 120 * 60 * 60_000);

  await h.worker.tick();

  const afterExpiry = h.positions.get(sample.sourceSignalId);
  assert.equal(afterExpiry.status, "open");
  assert.equal(afterExpiry.coreOpen, true);
  assert.equal(afterExpiry.runnerOpen, false);
  assert.deepEqual(afterExpiry.paperFills.filter((fill) => fill.type === "exit")
    .map((fill) => fill.reason), [
      "runner_max_age_expiry",
      "strategy4_impulse_first_target_partial",
      "strategy4_impulse_second_target_partial",
    ]);
  assert.equal(afterExpiry.paperFills[1].quantity, initial.runnerQty);
  assert.ok(Math.abs(afterExpiry.stopPrice - entry * 1.3) < 1e-10);
  assert.ok(Math.abs(afterExpiry.remainingQty - (initial.coreQty -
    2 * afterExpiry.paperFills[2].quantity)) < 0.00000002);
});

test("live mode fails closed even when an adapter exists", () => {
  const h = harness();
  assert.throws(
    () => createWorker({ store: {}, exchange: {}, mode: "live" }),
    /PAPER_ONLY_SIGNAL/,
  );
});