import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  assertHistoricalFillCoverage, deriveVstExchangeClientOrderId,
  verifyHistoricalCloseEvidence,
  isVerifiedEntryCloseCandidate,
} from "../vst-historical-close-evidence.mjs";
import { createVstBroker } from "../vst-broker.mjs";
import { createVstStore } from "../vst-store.mjs";
import { fillHistoryDigest } from "../bingx-fill-history.mjs";

const now = 1_790_705_000_000;
const entryAt = 1_790_694_867_000;
const closeAt = 1_790_704_263_000;
const entryOrderId = "2104952955909177345";
const closeOrderId = "2104992365002358785";
const positionId = "2104952956043395073";
const sourceSignalId = "cab-signal-15406";
const accountId = "vst-account-test";
const symbol = "USUSDT";
const clientOrderId = "parentvst-d1b31f6ce22894ecddd77fbd4b86dc";
const exchangeClientOrderId = deriveVstExchangeClientOrderId(clientOrderId);
const fillHistoryEndpoint = "/openApi/swap/v2/trade/fillHistory";
const snapshotHash = "a".repeat(64);

function fillTimeWithOffset(time) {
  return new Date(time + 8 * 60 * 60 * 1000).toISOString().replace(".000Z", "+08:00");
}

function fixture() {
  const quantity = "486594.7";
  const price = "0.020162";
  const closePrice = "0.018875";
  const candidate = {
    sourceSignalId,
    symbol,
    status: "error",
    signalStatus: "unknown",
    signalReason: "entry_verification_abandoned_confirmed_open_unprotected",
    updatedAt: new Date(now - 100_000).toISOString(),
    positionVersion: new Date(now - 100_000).toISOString()
      .replace(".000Z", ".000000Z"),
    snapshot: {
      environment: "vst",
      accountId,
      symbol,
      status: "error",
      exchangePositionId: positionId,
      verifiedFill: { price, quantity, at: entryAt },
      remainingQty: quantity,
      marginTopUp: {
        status: "failed",
        failureReason: "margin_top_up_abandoned_confirmed_not_applied",
      },
    },
    entryIntent: {
      sourceSignalId,
      phase: "market-entry",
      clientOrderId,
      request: {
        environment: "vst",
        accountId,
        symbol,
        operation: "entry",
        entryOrderType: "LIMIT",
      },
      state: "reconciled",
      exchangeOrderId: entryOrderId,
      outcome: { status: "filled", fillPrice: price, fillQuantity: quantity },
      createdAt: new Date(entryAt),
      updatedAt: new Date(entryAt),
    },
  };
  const entryOrder = {
    symbol: "US-USDT",
    orderId: entryOrderId,
    clientOrderId: exchangeClientOrderId,
    status: "FILLED",
    side: "BUY",
    positionSide: "LONG",
    type: "LIMIT",
    time: entryAt,
    updateTime: entryAt,
    positionID: positionId,
    origQty: quantity,
    executedQty: quantity,
    avgPrice: price,
  };
  const closeOrder = {
    symbol: "US-USDT",
    orderId: closeOrderId,
    clientOrderId: "",
    status: "FILLED",
    side: "SELL",
    positionSide: "LONG",
    type: "MARKET",
    reduceOnly: true,
    time: closeAt,
    updateTime: closeAt,
    positionID: positionId,
    origQty: quantity,
    executedQty: quantity,
    avgPrice: closePrice,
  };
  const fills = [
    {
      symbol: "US-USDT", orderId: entryOrderId, side: "BUY",
      tradeId: "entry-trade", positionSide: "LONG",
      filledTime: fillTimeWithOffset(entryAt),
      qty: quantity, price, commission: "-0.09", currency: "USDT",
      commissionAsset: "VST", realisedPNL: "0",
      clientOrderID: "",
    },
    {
      symbol: "US-USDT", orderId: closeOrderId, side: "SELL",
      tradeId: "close-trade", positionSide: "LONG",
      filledTime: fillTimeWithOffset(closeAt),
      qty: quantity, price: closePrice, commission: "-0.08", currency: "USDT",
      commissionAsset: "VST", realisedPNL: "-626.34076770",
      clientOrderID: "",
    },
  ];
  const coverage = [{
    verified: true,
    endpoint: fillHistoryEndpoint,
    currency: "USDT",
    startTs: entryAt - 60_000,
    endTs: now,
    rawCount: 2,
    pageSize: 1_000,
    passes: 2,
    terminalPage: 2,
    snapshotSha256: snapshotHash,
    observedAt: new Date(now).toISOString(),
  }];
  const freshPositions = [{ symbol: "US-USDT", positionAmt: "0", positionSide: "LONG" }];
  const freshOpenOrders = [];
  const verify = (overrides = {}) => verifyHistoricalCloseEvidence({
    candidate,
    entryOrder,
    closeOrder,
    fills,
    coverage,
    coverageEndTs: now,
    freshPositions,
    freshOpenOrders,
    expectedExchangeClientOrderId: exchangeClientOrderId,
    accountId,
    observedAtMs: now,
    nowMs: now,
    ...overrides,
  });
  return {
    candidate, entryOrder, closeOrder, fills, coverage, freshPositions, freshOpenOrders,
    verify, quantity, price, closePrice,
  };
}

function canonicalArchiveJson(value) {
  if (Array.isArray(value)) return value.map(canonicalArchiveJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort()
      .map((key) => [key, canonicalArchiveJson(value[key])]));
  }
  return value;
}

function archivedEvidence(data) {
  const fills = structuredClone(data.fills);
  fills[0].tradeId = "100000000000000001";
  fills[1].tradeId = "100000000000000002";
  const coverage = [{
    ...structuredClone(data.coverage[0]),
    snapshotSha256: fillHistoryDigest(fills),
  }];
  const archiveWindows = [{
    environment: "vst",
    accountId,
    currency: "USDT",
    archivedAt: new Date(now).toISOString(),
    coverage: coverage[0],
    rawFills: fills,
    orders: [data.entryOrder, data.closeOrder],
  }];
  return data.verify({ fills, coverage, archiveWindows });
}

test("historical close evidence requires exact entry, close, fills, costs, position and fresh flat reads", () => {
  const data = fixture();
  const proof = data.verify();
  assert.equal(proof.verified, true);
  assert.equal(proof.entryOrderId, entryOrderId);
  assert.equal(proof.closeOrderId, closeOrderId);
  assert.equal(proof.entryOrder.orderId, entryOrderId);
  assert.equal(proof.closeOrder.orderId, closeOrderId);
  assert.equal(proof.observedAtMs, now);
  assert.deepEqual(proof.freshOpenOrders, []);
  assert.equal(proof.positionId, positionId);
  assert.deepEqual(proof.closeFill.fee, { asset: "VST", amount: "-0.08" });
  assert.deepEqual(proof.entryFill.fee, { asset: "VST", amount: "-0.09" });
  assert.equal(proof.closeFill.realisedPnl, "-626.34076770");
  assert.equal(proof.closeFill.realisedPnlAsset, "USDT");
  assert.equal(proof.closeFill.realisedPnlProvenance,
    "bingx_fill_history.realisedPNL");
  assert.deepEqual(proof.coverage, data.coverage);
  assert.equal(proof.clientIdAttribution.kind, "broker_transformed_client_id");
  assert.equal(proof.flatCheck.positionQuantity, "0");
  assert.equal(proof.flatCheck.openOrderCount, 0);
});

test("historical close evidence refuses changed position, symbol, order IDs, quantities and times", () => {
  const data = fixture();
  const changedPosition = structuredClone(data.closeOrder);
  changedPosition.positionID = "other-position";
  assert.throws(() => data.verify({ closeOrder: changedPosition }),
    /close_order_mismatch/);

  const wrongSymbol = structuredClone(data.fills);
  wrongSymbol[1].symbol = "OTHER-USDT";
  assert.throws(() => data.verify({ fills: wrongSymbol }), /fill_symbol_mismatch/);

  const wrongOrder = structuredClone(data.fills);
  wrongOrder[1].orderId = "foreign-order";
  assert.throws(() => data.verify({ fills: wrongOrder }),
    /fills_do_not_match_entry_and_close/);

  const wrongQuantity = structuredClone(data.fills);
  wrongQuantity[1].qty = "486594.6";
  assert.throws(() => data.verify({ fills: wrongQuantity }),
    /close_order_mismatch|close_order_quantity_mismatch/);

  const wrongTimestamp = structuredClone(data.fills);
  wrongTimestamp[1].filledTime = fillTimeWithOffset(entryAt - 1);
  assert.throws(() => data.verify({ fills: wrongTimestamp }),
    /fill_timestamp_mismatch/);
});

test("historical close evidence refuses non-flat/open-order, stale-read and unknown close cost evidence", () => {
  const data = fixture();
  assert.throws(() => data.verify({
    freshPositions: [{ symbol: "US-USDT", positionAmt: "0.01" }],
  }), /symbol_not_flat/);
  assert.throws(() => data.verify({
    freshOpenOrders: [{ symbol: "US-USDT", orderId: "stop" }],
  }), /symbol_not_flat/);
  assert.throws(() => data.verify({ observedAtMs: now - 30_001 }),
    /flat_read_stale_or_unverified/);

  const unknownFee = structuredClone(data.fills);
  delete unknownFee[1].commission;
  assert.throws(() => data.verify({ fills: unknownFee }), /close_fee_invalid/);
  const unknownRealisedPnl = structuredClone(data.fills);
  delete unknownRealisedPnl[1].realisedPNL;
  assert.throws(() => data.verify({ fills: unknownRealisedPnl }),
    /close_realised_pnl_invalid/);

  const saturated = structuredClone(data.coverage);
  saturated[0].rawCount = 1_000;
  assert.throws(() => data.verify({ coverage: saturated }),
    /fill_coverage_unverified/);
  const missingTerminalPage = structuredClone(data.coverage);
  missingTerminalPage[0].terminalPage = 1;
  assert.throws(() => data.verify({ coverage: missingTerminalPage }),
    /fill_coverage_unverified/);
});

test("historical fill coverage age override is bounded and defaults to the flat-read limit", () => {
  const data = fixture();
  const coverageEndTs = now - 30_500;
  const delayedCoverage = data.coverage.map((snapshot) => ({
    ...snapshot,
    endTs: coverageEndTs,
    observedAt: new Date(now - 30_001).toISOString(),
  }));
  const proof = {
    coverage: delayedCoverage,
    coverageEndTs,
    fills: data.fills,
    requiredStartBeforeMs: entryAt - 30_000,
    requiredEndAtLeastMs: coverageEndTs,
    freshReadAtMs: now,
    nowMs: now,
  };
  assert.throws(() => assertHistoricalFillCoverage(proof),
    /fill_coverage_unverified/,
    "callers retain the original MAX_FLAT_READ_AGE_MS default");
  assert.deepEqual(
    assertHistoricalFillCoverage({ ...proof, maxSnapshotAgeMs: 120_000 }),
    { startTs: entryAt - 60_000, endTs: coverageEndTs },
  );
  assert.throws(() => assertHistoricalFillCoverage({
    ...proof, maxSnapshotAgeMs: 120_001,
  }), /fill_coverage_unverified/);

  const olderThanBudget = delayedCoverage.map((snapshot) => ({
    ...snapshot,
    endTs: now - 120_500,
    observedAt: new Date(now - 120_001).toISOString(),
  }));
  assert.throws(() => assertHistoricalFillCoverage({
    ...proof,
    coverage: olderThanBudget,
    coverageEndTs: now - 120_500,
    requiredEndAtLeastMs: now - 120_500,
    maxSnapshotAgeMs: 120_000,
  }), /fill_coverage_unverified/,
    "snapshots older than the hard 120-second budget still fail closed");
});

test("parent/child client ID mismatch is explicit and only accepted with exact saved order and verified entry fill", () => {
  const data = fixture();
  const mismatched = structuredClone(data.entryOrder);
  mismatched.clientOrderId = "different-child-id";
  const proof = data.verify({ entryOrder: mismatched });
  assert.equal(proof.clientIdAttribution.kind,
    "saved_exchange_order_id_and_verified_entry_fill");
  assert.equal(proof.clientIdAttribution.exchangeOrderId, entryOrderId);

  const wrongSavedId = structuredClone(data.candidate);
  wrongSavedId.entryIntent.exchangeOrderId = "unrelated-order";
  assert.throws(() => verifyHistoricalCloseEvidence({
    candidate: wrongSavedId,
    entryOrder: data.entryOrder,
    closeOrder: data.closeOrder,
    fills: data.fills,
    freshPositions: data.freshPositions,
    freshOpenOrders: data.freshOpenOrders,
    expectedExchangeClientOrderId: exchangeClientOrderId,
    accountId,
    observedAtMs: now,
    nowMs: now,
  }), /order_id_mismatch/);
});

test("verified reconciled-entry outcome and snapshot entryAt corroborate legacy snapshots without verifiedFill", () => {
  const data = fixture();
  delete data.candidate.snapshot.verifiedFill;
  data.candidate.snapshot.entryAt = new Date(entryAt).toISOString();
  data.candidate.entryIntent.outcome = {
    status: "filled",
    verified: true,
    fillPrice: data.price,
    fillQuantity: data.quantity,
  };
  assert.equal(data.verify().verified, true);
});

function confirmedEntryFixture(status = "unknown") {
  const data = fixture();
  Object.assign(data.candidate, {
    status, signalStatus: status,
    signalReason: status === "unknown" ? "triggered_stop_reconciliation_unknown" : null,
  });
  Object.assign(data.candidate.snapshot, {
    sourceSignalId, status, patternId: "liquidation_cascade",
    coreOpen: true, runnerOpen: false,
    entryOrderId, entryAt: new Date(entryAt).toISOString(),
    marginTopUp: { status: "verified" },
  });
  Object.assign(data.candidate.entryIntent.outcome, {
    verified: true, positionId,
  });
  return data;
}

test("confirmed ordinary open/unknown entries require full exchange close evidence, not a source close action", () => {
  for (const status of ["open", "unknown"]) {
    const data = confirmedEntryFixture(status);
    data.candidate.snapshot.sourceControl = {
      sourceAction: "review", sourceStatus: "reclassified",
    };
    assert.equal(isVerifiedEntryCloseCandidate(data.candidate), true);
    assert.equal(data.verify().verified, true);
    assert.throws(() => data.verify({ fills: [data.fills[0]] }),
      /fills_incomplete_or_foreign/);
    assert.throws(() => data.verify({
      freshOpenOrders: [{ symbol: "US-USDT", orderId: "9001" }],
    }), /symbol_not_flat/);
    assert.throws(() => data.verify({ coverage: [] }),
      /fill_coverage_unverified/);
  }
});

test("ordinary history eligibility rejects ambiguous entries, changed ownership and split/partial lifecycles", () => {
  for (const change of [
    (c) => { c.entryIntent.state = "unknown"; },
    (c) => { c.entryIntent.state = "failed"; },
    (c) => { c.entryIntent.outcome.verified = false; },
    (c) => { c.entryIntent.outcome.positionId = "9999"; },
    (c) => { c.snapshot.entryOrderId = "9999"; },
    (c) => { c.snapshot.sourceSignalId = "cab-signal-other"; },
    (c) => { c.snapshot.patternId = "impulse_buy"; },
    (c) => { c.snapshot.split = { stage: "core_verified" }; },
    (c) => { c.snapshot.protectedExit = { stage: "core_verified" }; },
    (c) => { c.snapshot.runnerOpen = true; },
    (c) => { c.snapshot.manualResolution = { outcome: "still_open" }; },
    (c) => { c.signalStatus = "error"; },
  ]) {
    const data = confirmedEntryFixture();
    change(data.candidate);
    assert.equal(isVerifiedEntryCloseCandidate(data.candidate), false);
    assert.throws(() => data.verify(), /candidate_ineligible|candidate_has_other_attribution/);
  }
  const partial = confirmedEntryFixture();
  partial.candidate.snapshot.remainingQty = "1";
  assert.throws(() => partial.verify(), /stored_entry_remaining_quantity_mismatch/);
});

test("stored numeric roundoff is corroborated without changing native fill prices or admitting a tick difference", async () => {
  const data = confirmedEntryFixture();
  data.candidate.snapshot.verifiedFill.price = 0.22390000000000002;
  data.candidate.entryIntent.outcome.fillPrice = 0.22390000000000002;
  data.entryOrder.avgPrice = "0.2239";
  data.fills[0].price = "0.2239";
  const evidence = data.verify();
  assert.equal(evidence.entryFill.price, "0.2239");
  assert.equal(evidence.entryPriceCorroboration.kind, "stored_number_roundoff");
  const pool = storePool({ candidate: data.candidate });
  const result = await createVstStore(pool).reconcileHistoricalClose(
    data.candidate, evidence, { nowMs: now, clock: () => now },
  );
  assert.equal(result.kind, "reconciled");
  assert.equal(result.position.snapshot.exchangeHistoryProvenance.entryFill.price, "0.2239");
  assert.equal(result.position.snapshot.exchangeHistoryProvenance.entryPriceCorroboration.recordedPrice,
    0.22390000000000002);
  for (const changed of ["0.22390000000000002", 0.22391, 0.2239000001]) {
    data.candidate.snapshot.verifiedFill.price = changed;
    assert.throws(() => data.verify(), /entry_fill_does_not_match_verified_entry/);
  }
});

test("exact filled stop child can close an ordinary ledger without being mislabeled a manual exit", async () => {
  const data = confirmedEntryFixture();
  data.closeOrder.type = "STOP_MARKET";
  data.closeOrder.triggerOrderId = "2107854569962299392";
  data.fills[1].type = "STOP_MARKET";
  const evidence = data.verify();
  const pool = storePool({ candidate: data.candidate });
  const result = await createVstStore(pool).reconcileHistoricalClose(
    data.candidate, evidence, { nowMs: now, clock: () => now },
  );
  assert.equal(result.kind, "reconciled");
  assert.equal(result.position.snapshot.exchangeHistoryProvenance.closeOrderType, "STOP_MARKET");
  assert.equal(result.position.snapshot.exchangeHistoryProvenance.closeTriggerOrderId,
    "2107854569962299392");
  assert.equal(result.position.snapshot.manualResolution, undefined);
  assert.equal(result.position.snapshot.externalClose, undefined);
  delete data.closeOrder.triggerOrderId;
  assert.throws(() => data.verify(), /close_trigger_order_id/);
  data.closeOrder.triggerOrderId = "2107854569962299392";
  data.closeOrder.executedQty = "1";
  assert.throws(() => data.verify(), /close_order_quantity_mismatch/);
});

test("broker obtains bounded fill reads and exact order reads without any exchange writes", async () => {
  const data = fixture();
  const olderEntryAt = entryAt - 26 * 60 * 60 * 1000;
  data.candidate.snapshot.verifiedFill.at = olderEntryAt;
  delete data.candidate.snapshot.exchangePositionId;
  data.entryOrder.time = olderEntryAt - 10_000;
  data.entryOrder.updateTime = olderEntryAt;
  data.fills[0].filledTime = fillTimeWithOffset(olderEntryAt);
  const calls = [];
  let apiNow = now;
  let delayFlatRead = false;
  const api = {
    getVstMarkPrice: async () => ({ symbol: "US-USDT", markPrice: "1", timestamp: now }),
    placeVstAutomatedLong: async () => { throw new Error("unexpected write"); },
    upgradeVstLongStop: async () => { throw new Error("unexpected write"); },
    closeLong: async () => { throw new Error("unexpected write"); },
    getBalance: async () => [],
    getPositions: async (requestedSymbol) => {
      calls.push(["positions", requestedSymbol]);
      if (delayFlatRead) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        apiNow = now + 31_000;
      }
      return data.freshPositions;
    },
    getOpenOrders: async (requestedSymbol) => {
      calls.push(["openOrders", requestedSymbol]);
      return data.freshOpenOrders;
    },
    getPositionMode: async () => "HEDGE",
    getMarginType: async () => "ISOLATED",
    getLeverage: async () => ({ longLeverage: 10, shortLeverage: 10 }),
    contract: async () => ({}),
    getRiskTiers: async () => [],
    getFeeRate: async () => ({}),
    getFunding: async () => ({}),
    queryOrderHistory: async () => { throw new Error("history path must not be used"); },
    queryOrder: async (requestedSymbol, params) => {
      calls.push(["order", requestedSymbol, params]);
      return params.orderId === entryOrderId ? data.entryOrder : data.closeOrder;
    },
    queryFills: async () => { throw new Error("strict history must not use queryFills"); },
    supportsCompleteFillHistory: true,
    queryCompleteFillHistory: async (requestedSymbol, params) => {
      calls.push(["fills", requestedSymbol, params]);
      const windowFills = data.fills.filter((fill) => {
        const time = Date.parse(fill.filledTime);
        return time > params.startTs && time <= params.endTs;
      });
      return {
        fills: windowFills,
        coverage: {
          verified: true,
          endpoint: fillHistoryEndpoint,
          currency: "USDT",
          startTs: params.startTs,
          endTs: params.endTs,
          rawCount: windowFills.length,
          pageSize: 1_000,
          passes: 2,
          terminalPage: 2,
          snapshotSha256: snapshotHash,
          observedAt: new Date(apiNow).toISOString(),
        },
      };
    },
    setVstLongLeverage10: async () => { throw new Error("unexpected write"); },
  };
  const broker = createVstBroker({
    api,
    accountId,
    canarySymbols: ["USUSDT"],
    clock: () => apiNow,
    stopBufferRate: 0.01,
  });
  assert.equal(broker.supportsHistoricalCloseProof, true);
  const proof = await broker.readHistoricalErrorClose(data.candidate);
  assert.equal(proof.verified, true);
  assert.equal(proof.positionId, positionId);
  assert.deepEqual(proof.entryIntent, data.candidate.entryIntent);
  assert.equal(proof.entryOrder.orderId, entryOrderId);
  assert.equal(proof.closeOrder.orderId, closeOrderId);
  assert.equal(calls.filter(([kind]) => kind === "fills").length, 2);
  const fillRanges = calls.filter(([kind]) => kind === "fills").map(([, , range]) => range);
  assert.equal(fillRanges[0].startTs, olderEntryAt - 70_000);
  assert.equal(fillRanges[0].endTs - fillRanges[0].startTs, 23 * 60 * 60 * 1000);
  assert.equal(fillRanges[1].startTs, fillRanges[0].endTs);
  assert.equal(fillRanges[1].endTs, now);
  assert.ok(fillRanges.every((range) => range.currency === "USDT" &&
    range.endTs - range.startTs <= 23 * 60 * 60 * 1000));
  assert.equal(calls.filter(([kind]) => kind === "order").length, 2);
  assert.equal(calls.some(([kind]) => kind === "history"), false);

  // The exact same native protocol must also admit an ordinary confirmed
  // entry that became unknown after an external close.
  const ordinary = confirmedEntryFixture();
  ordinary.candidate.snapshot.verifiedFill.at = olderEntryAt;
  ordinary.candidate.snapshot.entryAt = new Date(olderEntryAt).toISOString();
  assert.equal((await broker.readHistoricalErrorClose(ordinary.candidate)).verified, true);
  ordinary.candidate.entryIntent.state = "unknown";
  await assert.rejects(broker.readHistoricalErrorClose(ordinary.candidate),
    /candidate_ineligible/);

  const closeClientOrderId = "pre-runner-review-close-intent";
  data.closeOrder.clientOrderId =
    deriveVstExchangeClientOrderId(closeClientOrderId);
  const ownerSnapshot = structuredClone(data.candidate.snapshot);
  ownerSnapshot.exchangePositionId = positionId;
  ownerSnapshot.split = {
    stage: "runner_pending",
    positionId,
    totalQuantity: data.quantity,
    originalStopOrderId: "owner-original-stop",
    signalStopPrice: "0.019",
    coreStop: {
      orderId: "owner-core-stop",
      quantity: "389275.76",
      stopPrice: "0.019",
    },
  };
  const ownerReviewCandidate = {
    ...structuredClone(data.candidate),
    status: "closing",
    snapshot: ownerSnapshot,
    ownerPreRunnerCloseReview: true,
    closeIntent: {
      sourceSignalId,
      phase: "impulse-runner-breakeven-abort-1790704999000",
      clientOrderId: closeClientOrderId,
      state: "unknown",
      request: {
        operation: "close_pre_runner_split",
        sourceSignalId,
        symbol,
        accountId,
        environment: "vst",
        closeIntentId: closeClientOrderId,
        positionId,
        totalQuantity: data.quantity,
        originalStop: {
          orderId: "owner-original-stop",
          quantity: data.quantity,
          stopPrice: "0.019",
        },
        coreStop: {
          orderId: "owner-core-stop",
          quantity: "389275.76",
          stopPrice: "0.019",
        },
      },
    },
  };
  const ownerReviewProof = await broker.readHistoricalErrorClose(
    ownerReviewCandidate,
  );
  assert.equal(ownerReviewProof.verified, true);
  assert.equal(ownerReviewProof.flatCheck.openOrderCount, 0);
  assert.equal(ownerReviewProof.closeOrderId, closeOrderId);

  delayFlatRead = true;
  const slowBroker = createVstBroker({
    api,
    accountId,
    canarySymbols: ["USUSDT"],
    clock: () => apiNow,
    stopBufferRate: 0.01,
  });
  await assert.rejects(
    slowBroker.readHistoricalErrorClose(data.candidate),
    /flat_read_stale_or_unverified/,
  );

  const unsupportedBroker = createVstBroker({
    api: { ...api, supportsCompleteFillHistory: false },
    accountId,
    canarySymbols: ["USUSDT"],
    clock: () => apiNow,
    stopBufferRate: 0.01,
  });
  assert.equal(unsupportedBroker.supportsHistoricalCloseProof, false);
  const callsBeforeUnsupportedProof = calls.length;
  await assert.rejects(
    unsupportedBroker.readHistoricalErrorClose(data.candidate),
    /fill_completeness_unsupported/,
  );
  assert.equal(calls.length, callsBeforeUnsupportedProof);
});

function storePool({
  candidate,
  changeSnapshot = false,
  changePositionStatus = false,
  changeSignalStatus = false,
  changeSignalReason = false,
  changeEntryIntent = false,
  unresolvedIntent = false,
  onIntentLocks,
  archiveWindows = [],
  archiveRace,
} = {}) {
  const candidateQueries = [];
  const transactionQueries = [];
  const archiveQueries = [];
  const intentSerializationLocks = [];
  const persistedArchiveWindows = archiveWindows.map((window) => ({
    window_hash: createHash("sha256")
      .update(JSON.stringify(canonicalArchiveJson(window))).digest("hex"),
    archive_window: structuredClone(window),
    invalidated_at: null,
  }));
  let lateUnresolvedIntent = false;
  let position = {
    source_signal_id: sourceSignalId,
    symbol,
    status: candidate.status,
    snapshot: structuredClone(candidate.snapshot),
    updated_at: candidate.updatedAt,
  };
  let signal = {
    source_signal_id: sourceSignalId,
    status: candidate.signalStatus,
    reason: candidate.signalReason,
  };
  let entryIntent = structuredClone(candidate.entryIntent);
  let entryEventRows = [];
  const events = [];
  const tx = {
    async query(sql, params = []) {
      const text = sql.trim();
      transactionQueries.push({ sql: text, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("pg_advisory_xact_lock")) {
        if (params[0] === 4_348_998) {
          if (archiveRace === "invalidate") {
            for (const row of persistedArchiveWindows) {
              row.invalidated_at = new Date(now).toISOString();
            }
          } else if (archiveRace === "remove") {
            persistedArchiveWindows.splice(0, persistedArchiveWindows.length);
          }
        } else {
          intentSerializationLocks.push(params);
        }
        return { rowCount: 1, rows: [{ pg_advisory_xact_lock: null }] };
      }
      if (text.includes("FROM vst_fill_archive_windows")) {
        archiveQueries.push({ sql: text, params, source: "transaction" });
        const matches = persistedArchiveWindows.filter((row) =>
          row.invalidated_at === null &&
          row.archive_window.accountId === params[0] &&
          row.archive_window.currency === params[1] &&
          row.archive_window.coverage.startTs === params[2] &&
          row.archive_window.coverage.endTs === params[3] &&
          row.archive_window.archivedAt === params[4]);
        return {
          rowCount: matches.length,
          rows: matches.map(({ window_hash, archive_window }) => ({
            window_hash, archive_window,
          })),
        };
      }
      if (text.startsWith("SELECT status FROM vst_positions")) {
        return position
          ? { rowCount: 1, rows: [{ status: position.status }] }
          : { rowCount: 0, rows: [] };
      }
      if (text.startsWith("SELECT status FROM vst_signals")) {
        return signal
          ? { rowCount: 1, rows: [{ status: signal.status }] }
          : { rowCount: 0, rows: [] };
      }
      if (text.includes("FROM vst_order_intents") &&
          text.includes("phase = $2 FOR UPDATE")) {
        return entryIntent.phase === params[1]
          ? { rowCount: 1, rows: [{
              source_signal_id: entryIntent.sourceSignalId,
              phase: entryIntent.phase,
              client_order_id: entryIntent.clientOrderId,
              request: entryIntent.request,
              state: entryIntent.state,
              exchange_order_id: entryIntent.exchangeOrderId,
              outcome: entryIntent.outcome,
              created_at: entryIntent.createdAt,
              updated_at: entryIntent.updatedAt,
            }] }
          : { rowCount: 0, rows: [] };
      }
      if (text.includes("FROM vst_positions p") && text.includes("FOR UPDATE OF p, s")) {
        if (changeSnapshot) {
          position = { ...position, snapshot: { ...position.snapshot, lateChange: true } };
        }
        if (changePositionStatus) position = { ...position, status: "closed" };
        if (changeSignalStatus) signal = { ...signal, status: "closed" };
        if (changeSignalReason) signal = { ...signal, reason: "same-status-reason-transition" };
        return { rowCount: 1, rows: [{
          ...position,
          position_version: candidate.positionVersion,
          signal_status: signal.status,
          signal_reason: signal.reason,
        }] };
      }
      if (text.includes("FROM vst_events") &&
          text.includes("exchange_history_provenance")) {
        return { rowCount: entryEventRows.length, rows: entryEventRows };
      }
      if (text.includes("FROM vst_order_intents") &&
          text.includes("phase = 'market-entry'")) {
        if (changeEntryIntent) entryIntent = { ...entryIntent, state: "failed" };
        return { rowCount: 1, rows: [{
          source_signal_id: entryIntent.sourceSignalId,
          phase: entryIntent.phase,
          client_order_id: entryIntent.clientOrderId,
          request: entryIntent.request,
          state: entryIntent.state,
          exchange_order_id: entryIntent.exchangeOrderId,
          outcome: entryIntent.outcome,
          created_at: entryIntent.createdAt,
          updated_at: entryIntent.updatedAt,
        }] };
      }
      if (text.includes("FROM vst_order_intents") &&
          text.includes("state IN ('prepared', 'submitted', 'unknown')")) {
        onIntentLocks?.();
        return unresolvedIntent || lateUnresolvedIntent
          ? { rowCount: 1, rows: [{ phase: "close", state: "unknown" }] }
          : { rowCount: 0, rows: [] };
      }
      if (text.startsWith("INSERT INTO vst_order_intents")) {
        lateUnresolvedIntent = true;
        return { rowCount: 1, rows: [{
          source_signal_id: params[0],
          phase: params[1],
          client_order_id: params[2],
          request: JSON.parse(params[3]),
          state: "prepared",
          exchange_order_id: null,
          outcome: null,
          created_at: new Date(now),
          updated_at: new Date(now),
        }] };
      }
      if (text.startsWith("UPDATE vst_positions")) {
        position = {
          ...position,
          status: "closed",
          snapshot: JSON.parse(params[2]),
          updated_at: new Date(now).toISOString(),
        };
        return { rowCount: 1, rows: [position] };
      }
      if (text.startsWith("UPDATE vst_signals")) {
        signal = { ...signal, status: "closed" };
        return { rowCount: 1, rows: [{ source_signal_id: sourceSignalId }] };
      }
      if (text.startsWith("INSERT INTO vst_events")) {
        const event = { kind: "exchange_history_provenance", detail: JSON.parse(params[1]) };
        events.push(event);
        entryEventRows.push({ id: events.length });
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected mock SQL: ${text}`);
    },
    release() {},
  };
  return {
    candidateQueries,
    transactionQueries,
    archiveQueries,
    intentSerializationLocks,
    events,
    get persistedArchiveWindows() { return persistedArchiveWindows; },
    get lateUnresolvedIntent() { return lateUnresolvedIntent; },
    get position() { return position; },
    get signal() { return signal; },
    async connect() { return tx; },
    async query(sql, params = []) {
      if (sql.includes("FROM vst_fill_archive_windows")) {
        archiveQueries.push({ sql: sql.trim(), params, source: "pool" });
        const matches = persistedArchiveWindows.filter((row) =>
          row.invalidated_at === null &&
          row.archive_window.accountId === params[0] &&
          row.archive_window.currency === params[1] &&
          row.archive_window.coverage.startTs === params[2] &&
          row.archive_window.coverage.endTs === params[3] &&
          row.archive_window.archivedAt === params[4]);
        return {
          rowCount: matches.length,
          rows: matches.map(({ window_hash, archive_window }) => ({
            window_hash, archive_window,
          })),
        };
      }
      if (sql.includes("FROM vst_positions p") &&
          sql.includes("JOIN vst_order_intents i")) {
        candidateQueries.push({ sql, params });
        assert.match(sql, /p\.status = 'error'/);
        assert.match(sql, /i\.state IN \('failed', 'reconciled'\)/);
        assert.match(sql, /NOT EXISTS/);
        assert.ok(params[2] === 1 || params[2] === 2);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected pool SQL: ${sql}`);
    },
  };
}

test("store historical reconciliation atomically preserves history and is idempotent", async () => {
  const data = fixture();
  const evidence = data.verify();
  const pool = storePool({ candidate: data.candidate });
  const store = createVstStore(pool);
  const fixedClock = () => now;
  const result = await store.reconcileHistoricalClose(data.candidate, evidence, {
    nowMs: now, clock: fixedClock,
  });
  assert.equal(result.kind, "reconciled");
  assert.equal(result.position.status, "closed");
  assert.equal(result.position.snapshot.manualResolution, undefined);
  assert.equal(result.position.snapshot.closeReason, "exchange_history_provenance");
  assert.equal(result.position.snapshot.verifiedFill.price, data.price);
  assert.equal(result.position.snapshot.exchangeHistoryProvenance.entryFill.fee.asset, "VST");
  assert.equal(result.position.snapshot.exchangeHistoryProvenance.entryFill.fee.amount, "-0.09");
  assert.equal(result.position.snapshot.closeFill.fee.amount, "-0.08");
  assert.equal(result.position.snapshot.closeFill.realisedPnl, "-626.34076770");
  assert.equal(result.position.snapshot.closeFill.realisedPnlProvenance,
    "bingx_fill_history.realisedPNL");
  assert.deepEqual(result.position.snapshot.exchangeHistoryProvenance.coverage,
    evidence.coverage);
  assert.equal(result.position.snapshot.exchangeHistoryProvenance.coverageEndTs, now);
  assert.equal(pool.signal.status, "closed");
  assert.equal(pool.signal.reason, data.candidate.signalReason);
  assert.equal(pool.events.length, 1);
  assert.deepEqual(pool.intentSerializationLocks,
    [[4_348_997, sourceSignalId]]);
  const reconciliationLockIndex = pool.transactionQueries.findIndex(({ sql }) =>
    sql.includes("pg_advisory_xact_lock"));
  const positionRowLockIndex = pool.transactionQueries.findIndex(({ sql }) =>
    sql.includes("FOR UPDATE OF p, s"));
  assert.ok(reconciliationLockIndex >= 0 && reconciliationLockIndex < positionRowLockIndex);

  await assert.rejects(
    store.reserveIntent({
      sourceSignalId,
      phase: "late-close",
      clientOrderId: "late-close-client",
      request: {
        environment: "vst", accountId, symbol, operation: "close",
      },
    }),
    /closed source cannot reserve/,
    "a reservation queued behind historical reconciliation sees the closed state",
  );
  assert.equal(pool.intentSerializationLocks.length, 2);
  assert.ok(pool.intentSerializationLocks.every(([, lockedSignalId]) =>
    lockedSignalId === sourceSignalId));
  assert.equal(pool.transactionQueries.some(({ sql }) =>
    sql.startsWith("INSERT INTO vst_order_intents")), false);
  const replay = await store.reconcileHistoricalClose(data.candidate, evidence, {
    nowMs: now, clock: fixedClock,
  });
  assert.equal(replay.kind, "already_reconciled");
  assert.equal(pool.events.length, 1);
});

test("store closes confirmed unknown/open entries atomically and preserves the original warning provenance", async () => {
  for (const status of ["open", "unknown"]) {
    const data = confirmedEntryFixture(status);
    const evidence = data.verify();
    const pool = storePool({ candidate: data.candidate });
    const result = await createVstStore(pool).reconcileHistoricalClose(
      data.candidate, evidence, { nowMs: now, clock: () => now },
    );
    assert.equal(result.kind, "reconciled");
    assert.equal(result.position.status, "closed");
    assert.equal(pool.signal.status, "closed");
    assert.equal(result.position.snapshot.exchangeHistoryProvenance.previousSignalStatus, status);
    assert.equal(result.position.snapshot.exchangeHistoryProvenance.previousSignalReason,
      data.candidate.signalReason);
    assert.equal(result.position.snapshot.closeFill.realisedPnl, "-626.34076770");
    assert.equal(pool.events.length, 1);
    const update = pool.transactionQueries.find(({ sql }) =>
      sql.includes("UPDATE vst_positions") && sql.includes("status = 'closed'"));
    assert.match(update.sql, /status = \$4/);
    assert.equal(update.params[3], status);
    const unresolvedPool = storePool({
      candidate: data.candidate, unresolvedIntent: true,
    });
    const refused = await createVstStore(unresolvedPool).reconcileHistoricalClose(
      data.candidate, evidence, { nowMs: now, clock: () => now },
    );
    assert.equal(refused.kind, "protected_by_unresolved_intent");
    assert.equal(unresolvedPool.position.status, status);
  }
});

test("archived historical proof is revalidated under the archive lock before reconciliation writes", async () => {
  const data = fixture();
  const evidence = archivedEvidence(data);
  const [window] = evidence.archiveWindows;
  assert.equal(window.environment, "vst");
  assert.equal(window.accountId, accountId);
  assert.equal(window.currency, "USDT");
  assert.deepEqual(window.coverage, evidence.coverage[0]);
  assert.equal(window.coverage.snapshotSha256, fillHistoryDigest(window.rawFills));
  assert.ok(window.rawFills.every((fill) => /^\d+$/.test(fill.tradeId)));
  assert.deepEqual(window.orders.map((order) => order.orderId),
    [entryOrderId, closeOrderId]);

  const acceptedPool = storePool({
    candidate: data.candidate,
    archiveWindows: evidence.archiveWindows,
  });
  const accepted = await createVstStore(acceptedPool).reconcileHistoricalClose(
    data.candidate, evidence, { nowMs: now, clock: () => now },
  );
  assert.equal(accepted.kind, "reconciled");
  assert.deepEqual(
    accepted.position.snapshot.exchangeHistoryProvenance.archiveWindows,
    evidence.archiveWindows,
  );
  assert.equal(acceptedPool.events.length, 1);
  const archiveLockIndex = acceptedPool.transactionQueries.findIndex(({ sql, params }) =>
    sql.includes("pg_advisory_xact_lock") && params[0] === 4_348_998);
  const signalLockIndex = acceptedPool.transactionQueries.findIndex(({ sql, params }) =>
    sql.includes("pg_advisory_xact_lock") && params[0] === 4_348_997);
  assert.ok(archiveLockIndex >= 0 && archiveLockIndex < signalLockIndex);
  assert.equal(acceptedPool.archiveQueries.filter(({ source }) => source === "pool").length, 1,
    "the initially persisted proof is validated before entering the transaction");
  assert.equal(acceptedPool.archiveQueries.filter(({ source }) =>
    source === "transaction").length, 1,
  "the exact proof is checked again while holding the archive-scope lock");

  for (const archiveRace of ["invalidate", "remove"]) {
    const racedPool = storePool({
      candidate: data.candidate,
      archiveWindows: evidence.archiveWindows,
      archiveRace,
    });
    await assert.rejects(
      createVstStore(racedPool).reconcileHistoricalClose(
        data.candidate, evidence, { nowMs: now, clock: () => now },
      ),
      /vst_fill_archive_window_not_persisted/,
      `a proof invalidated or removed after pre-validation must be refused (${archiveRace})`,
    );
    assert.equal(racedPool.archiveQueries.filter(({ source }) => source === "pool").length, 1);
    assert.equal(racedPool.archiveQueries.filter(({ source }) =>
      source === "transaction").length, 1);
    assert.equal(racedPool.transactionQueries.some(({ sql }) =>
      sql.startsWith("UPDATE vst_positions") ||
      sql.startsWith("UPDATE vst_signals") ||
      sql.startsWith("INSERT INTO vst_events") ||
      sql.startsWith("INSERT INTO vst_fill_archive_fills")), false,
    "the rejected stale archive proof cannot write ledger, archive-fill or event rows");
    assert.equal(racedPool.events.length, 0);
    assert.equal(racedPool.position.status, "error");
    assert.equal(racedPool.signal.status, data.candidate.signalStatus);
  }
});

test("store historical reconciliation refuses stale CAS, unresolved intents and unknown costs", async () => {
  const data = fixture();
  const evidence = data.verify();
  const changedPool = storePool({ candidate: data.candidate, changeSnapshot: true });
  const changed = await createVstStore(changedPool)
    .reconcileHistoricalClose(data.candidate, evidence, { nowMs: now, clock: () => now });
  assert.equal(changed.kind, "precondition_changed");
  assert.equal(changedPool.events.length, 0);

  for (const race of [
    { changePositionStatus: true },
    { changeSignalStatus: true },
    { changeEntryIntent: true },
  ]) {
    const changedStatePool = storePool({ candidate: data.candidate, ...race });
    const changedState = await createVstStore(changedStatePool)
      .reconcileHistoricalClose(data.candidate, evidence, {
        nowMs: now, clock: () => now,
      });
    assert.equal(changedState.kind, "precondition_changed");
    assert.equal(changedStatePool.events.length, 0);
  }

  const changedReasonPool = storePool({
    candidate: data.candidate,
    changeSignalReason: true,
  });
  const changedReason = await createVstStore(changedReasonPool)
    .reconcileHistoricalClose(data.candidate, evidence, {
      nowMs: now, clock: () => now,
    });
  assert.equal(changedReason.kind, "precondition_changed",
    "same-status signal reason changes invalidate the historical-close CAS");
  assert.equal(changedReasonPool.signal.status, data.candidate.signalStatus);
  assert.equal(changedReasonPool.events.length, 0);

  const protectedPool = storePool({
    candidate: data.candidate,
  });
  const protectedStore = createVstStore(protectedPool);
  const lateReservation = await protectedStore.reserveIntent({
    sourceSignalId,
    phase: "late-close",
    clientOrderId: "late-close-client",
    request: {
      environment: "vst", accountId, symbol, operation: "close",
    },
  });
  assert.equal(lateReservation.kind, "new");
  const protectedResult = await protectedStore
    .reconcileHistoricalClose(data.candidate, evidence, { nowMs: now, clock: () => now });
  assert.equal(protectedResult.kind, "protected_by_unresolved_intent");
  assert.equal(protectedPool.lateUnresolvedIntent, true,
    "a new unknown close intent appears only after this candidate was selected");
  assert.deepEqual(protectedPool.intentSerializationLocks, [
    [4_348_997, sourceSignalId],
    [4_348_997, sourceSignalId],
  ]);
  assert.equal(protectedPool.events.length, 0);

  const missingCoverage = structuredClone(evidence);
  delete missingCoverage.coverage;
  await assert.rejects(
    createVstStore(storePool({ candidate: data.candidate }))
      .reconcileHistoricalClose(data.candidate, missingCoverage, {
        nowMs: now, clock: () => now,
      }),
    /proof_invalid/,
  );

  const unboundedCoverage = structuredClone(evidence);
  unboundedCoverage.coverage[0].rawCount = 1_000;
  await assert.rejects(
    createVstStore(storePool({ candidate: data.candidate }))
      .reconcileHistoricalClose(data.candidate, unboundedCoverage, {
        nowMs: now, clock: () => now,
      }),
    /fill_coverage_unverified/,
  );

  const unknownCost = structuredClone(evidence);
  delete unknownCost.closeFill.fee;
  await assert.rejects(
    createVstStore(storePool({ candidate: data.candidate }))
      .reconcileHistoricalClose(data.candidate, unknownCost, {
        nowMs: now, clock: () => now,
      }),
    /close_fee_unknown/,
  );

  const changedRealisedPnl = structuredClone(evidence);
  changedRealisedPnl.closeFill.realisedPnl = "-626.2473789";
  await assert.rejects(
    createVstStore(storePool({ candidate: data.candidate }))
      .reconcileHistoricalClose(data.candidate, changedRealisedPnl, {
        nowMs: now, clock: () => now,
      }),
    /raw_fill_realised_pnl_mismatch/,
  );

  const conflictingOptionalFillType = structuredClone(evidence);
  conflictingOptionalFillType.fills[1].type = "LIMIT";
  await assert.rejects(
    createVstStore(storePool({ candidate: data.candidate }))
      .reconcileHistoricalClose(data.candidate, conflictingOptionalFillType, {
        nowMs: now, clock: () => now,
      }),
    /raw_fill_mismatch/,
  );
});

test("store rechecks flat-read freshness after acquiring reconciliation locks", async () => {
  const data = fixture();
  const evidence = data.verify();
  let lockClock = now;
  const pool = storePool({
    candidate: data.candidate,
    onIntentLocks: () => { lockClock = now + 31_000; },
  });
  await assert.rejects(
    createVstStore(pool).reconcileHistoricalClose(data.candidate, evidence, {
      nowMs: now,
      clock: () => lockClock,
    }),
    /flat_read_stale_after_lock/,
  );
  assert.equal(pool.position.status, "error");
  assert.equal(pool.signal.status, data.candidate.signalStatus);
  assert.equal(pool.events.length, 0);
});

test("intent reservation takes the same per-signal advisory lock before insertion", async () => {
  const queries = [];
  const request = {
    environment: "vst", accountId, symbol, operation: "close",
  };
  const pool = {
    async query(sql) {
      throw new Error(`Unexpected pool SQL: ${sql}`);
    },
    async connect() {
      return {
        async query(sql, params = []) {
          const text = sql.trim();
          queries.push({ sql: text, params });
          if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) {
            return { rowCount: 0, rows: [] };
          }
          if (text.includes("pg_advisory_xact_lock")) {
            return { rowCount: 1, rows: [{ pg_advisory_xact_lock: null }] };
          }
          if (text.startsWith("SELECT status FROM vst_positions")) {
            return { rowCount: 0, rows: [] };
          }
          if (text.startsWith("SELECT status FROM vst_signals")) {
            return { rowCount: 1, rows: [{ status: "opening" }] };
          }
          if (text.includes("FROM vst_order_intents") &&
              text.includes("phase = $2 FOR UPDATE")) {
            return { rowCount: 0, rows: [] };
          }
          if (text.startsWith("INSERT INTO vst_order_intents")) {
            return { rowCount: 1, rows: [{
              source_signal_id: sourceSignalId,
              phase: "late-close",
              client_order_id: "serialized-close-client",
              request,
              state: "prepared",
              exchange_order_id: null,
              outcome: null,
              created_at: new Date(now),
              updated_at: new Date(now),
            }] };
          }
          throw new Error(`Unexpected mock SQL: ${text}`);
        },
        release() {},
      };
    },
  };

  const reserved = await createVstStore(pool).reserveIntent({
    sourceSignalId,
    phase: "late-close",
    clientOrderId: "serialized-close-client",
    request,
  });
  assert.equal(reserved.kind, "new");
  const lockIndex = queries.findIndex(({ sql }) => sql.includes("pg_advisory_xact_lock"));
  const firstRowLockIndex = queries.findIndex(({ sql }) => sql.includes("FOR UPDATE"));
  const insertIndex = queries.findIndex(({ sql }) =>
    sql.startsWith("INSERT INTO vst_order_intents"));
  assert.deepEqual(queries[lockIndex].params, [4_348_997, sourceSignalId]);
  assert.ok(lockIndex >= 0 && lockIndex < firstRowLockIndex);
  assert.ok(firstRowLockIndex < insertIndex);
});

test("historical close candidate listing is optional and limited to two", async () => {
  const pool = storePool({ candidate: fixture().candidate });
  const store = createVstStore(pool);
  assert.deepEqual(await store.listHistoricalCloseCandidates(), []);
  const cursor = {
    positionVersion: new Date(now - 20_000).toISOString().replace(".000Z", ".000000Z"),
    sourceSignalId: "prior-history-candidate",
  };
  assert.deepEqual(await store.listHistoricalCloseCandidates(1, { after: cursor }), []);
  assert.equal(pool.candidateQueries[1].params[0], cursor.positionVersion);
  assert.equal(pool.candidateQueries[1].params[1], cursor.sourceSignalId);
  assert.equal(pool.candidateQueries[1].params[2], 1);
  await assert.rejects(store.listHistoricalCloseCandidates(3),
    /candidate limit must be 1\.\.2/);
});

test("early flat-position scan excludes old failed-entry repairs so fresh entries retain priority", async () => {
  const data = confirmedEntryFixture();
  const pool = storePool({ candidate: data.candidate });
  await createVstStore(pool).listFlatPositionCloseCandidates();
  const query = pool.candidateQueries.at(-1);
  assert.equal(query.params[3], true);
  assert.match(query.sql, /NOT \$4::boolean OR p\.status IN \('open', 'unknown'\)/);
  assert.match(query.sql, /state IN \('prepared', 'submitted', 'unknown'\)/);
});