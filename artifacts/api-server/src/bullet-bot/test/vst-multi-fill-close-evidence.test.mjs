import assert from "node:assert/strict";
import test from "node:test";
import {
  assertHistoricalFillCoverage, deriveVstExchangeClientOrderId,
  verifyHistoricalCloseEvidence,
} from "../vst-historical-close-evidence.mjs";
import { verifyVstMultiFillCloseEvidence } from "../vst-multi-fill-close-evidence.mjs";
import { fillHistoryDigest } from "../bingx-fill-history.mjs";

const now = 1_790_705_000_000;
const entryAt = now - 60_000;
const symbol = "USUSDT";
const exchangeSymbol = "US-USDT";
const accountId = "vst-multi-test";
const signalId = "multi-fill-signal";
const positionId = "position-multi-1";
const entryId = "entry-order-1";
const closeClientId = "close-intent-multi";
const expectedMarketClientId = deriveVstExchangeClientOrderId(closeClientId);
const endpoint = "/openApi/swap/v2/trade/fillHistory";
const hash = "b".repeat(64);

function fill({ id, order, side, time, qty, price, pnl = "0" }) {
  return {
    symbol: exchangeSymbol,
    orderId: order,
    tradeId: id,
    side,
    positionSide: "LONG",
    positionID: positionId,
    filledTime: time,
    qty,
    price,
    commission: "-0.01",
    commissionAsset: "VST",
    realisedPNL: pnl,
  };
}

function fixture(mode = "partial-market") {
  const entryOrder = {
    symbol: exchangeSymbol, orderId: entryId, status: "FILLED",
    side: "BUY", positionSide: "LONG", type: "LIMIT",
    time: entryAt - 1_000, updateTime: entryAt + 1_000,
    positionID: positionId, executedQty: "10", avgPrice: "106",
  };
  const candidate = {
    sourceSignalId: signalId,
    symbol,
    status: "closing",
    ownerPreRunnerCloseReview: true,
    snapshot: {
      environment: "vst", accountId, symbol, exchangePositionId: positionId,
      verifiedFill: { price: "106", quantity: "10", at: entryAt },
      remainingQty: "10",
      split: {
        stage: "runner_pending", positionId, totalQuantity: "10",
        originalStopOrderId: "original-stop",
        signalStopPrice: "95",
        coreStop: { orderId: "core-stop", quantity: "6", stopPrice: "95" },
      },
    },
    entryIntent: {
      sourceSignalId: signalId, phase: "market-entry", state: "reconciled",
      exchangeOrderId: entryId,
      request: { environment: "vst", accountId, symbol, operation: "entry" },
    },
    closeIntent: {
      sourceSignalId: signalId, clientOrderId: closeClientId,
      phase: "pre-runner-close", state: "unknown",
      request: {
        operation: "close_pre_runner_split", sourceSignalId: signalId,
        environment: "vst", accountId, symbol, closeIntentId: closeClientId,
        positionId, totalQuantity: "10",
        originalStop: { orderId: "original-stop", quantity: "10", stopPrice: "95" },
        coreStop: { orderId: "core-stop", quantity: "6", stopPrice: "95" },
      },
    },
  };
  const entryFills = [
    fill({ id: "entry-fill-a", order: entryId, side: "BUY", time: entryAt, qty: "4", price: "100" }),
    fill({ id: "entry-fill-b", order: entryId, side: "BUY", time: entryAt + 1, qty: "6", price: "110" }),
  ];
  let stopOrders = [
    {
      symbol: exchangeSymbol, orderId: "original-stop", status: "FILLED",
      side: "SELL", positionSide: "LONG", type: "STOP_MARKET",
      workingType: "MARK_PRICE", positionID: positionId, mainOrderId: entryId,
      stopPrice: "95",
    },
    {
      symbol: exchangeSymbol, orderId: "core-stop", status: "FILLED",
      side: "SELL", positionSide: "LONG", type: "STOP_MARKET",
      workingType: "MARK_PRICE", positionID: positionId, mainOrderId: entryId,
      stopPrice: "95",
    },
  ];
  let closeOrders;
  let closingFills;
  if (mode === "partial-market") {
    const child = {
      symbol: exchangeSymbol, orderId: "core-child", status: "CANCELED",
      side: "SELL", positionSide: "LONG", type: "STOP_MARKET",
      time: entryAt + 10, updateTime: entryAt + 20,
      positionID: positionId, executedQty: "6", avgPrice: "120",
      triggerOrderId: "core-stop", mainOrderId: entryId, stopPrice: "95",
    };
    stopOrders[1].childOrderId = "core-child";
    stopOrders = [stopOrders[1]];
    const market = {
      symbol: exchangeSymbol, orderId: "market-close", clientOrderId: expectedMarketClientId,
      status: "FILLED", side: "SELL", positionSide: "LONG", type: "MARKET",
      reduceOnly: true, time: entryAt + 30, updateTime: entryAt + 40,
      positionID: positionId, executedQty: "4", avgPrice: "115",
    };
    closeOrders = [child, market];
    closingFills = [
      fill({ id: "stop-fill", order: "core-child", side: "SELL", time: entryAt + 15,
        qty: "6", price: "120", pnl: "84" }),
      fill({ id: "market-fill", order: "market-close", side: "SELL", time: entryAt + 35,
        qty: "4", price: "115", pnl: "36" }),
    ];
  } else if (mode === "market-only") {
    closeOrders = [{
      symbol: exchangeSymbol, orderId: "market-close", clientOrderId: expectedMarketClientId,
      status: "FILLED", side: "SELL", positionSide: "LONG", type: "MARKET",
      reduceOnly: true, time: entryAt + 30, updateTime: entryAt + 40,
      positionID: positionId, executedQty: "10", origQty: "10", avgPrice: "118",
    }];
    stopOrders = [];
    closingFills = [
      fill({ id: "market-fill-a", order: "market-close", side: "SELL", time: entryAt + 33,
        qty: "4", price: "115", pnl: "36" }),
      fill({ id: "market-fill-b", order: "market-close", side: "SELL", time: entryAt + 35,
        qty: "6", price: "120", pnl: "84" }),
    ];
  } else {
    candidate.snapshot.split.coreStop.quantity = "4";
    candidate.closeIntent.request.coreStop.quantity = "4";
    stopOrders[1].childOrderId = "core-child";
    stopOrders[0].childOrderId = "original-child";
    closeOrders = [
      {
        symbol: exchangeSymbol, orderId: "original-child", status: "FILLED",
        side: "SELL", positionSide: "LONG", type: "STOP_MARKET",
        time: entryAt + 10, updateTime: entryAt + 20,
        positionID: positionId, executedQty: "6", avgPrice: "120",
        triggerOrderId: "original-stop", mainOrderId: entryId, stopPrice: "95",
      },
      {
        symbol: exchangeSymbol, orderId: "core-child", status: "FILLED",
        side: "SELL", positionSide: "LONG", type: "STOP_MARKET",
        time: entryAt + 30, updateTime: entryAt + 40,
        positionID: positionId, executedQty: "4", avgPrice: "115",
        triggerOrderId: "core-stop", mainOrderId: entryId, stopPrice: "95",
      },
    ];
    closingFills = [
      fill({ id: "original-fill", order: "original-child", side: "SELL", time: entryAt + 15,
        qty: "6", price: "120", pnl: "84" }),
      fill({ id: "core-fill", order: "core-child", side: "SELL", time: entryAt + 35,
        qty: "4", price: "115", pnl: "36" }),
    ];
  }
  const fills = [...entryFills, ...closingFills];
  const coverage = [{
    verified: true, endpoint, currency: "USDT", startTs: entryAt - 1_000,
    endTs: now, rawCount: fills.length, pageSize: 1_000, passes: 2,
    terminalPage: 2, snapshotSha256: hash, observedAt: new Date(now).toISOString(),
  }];
  const args = {
    candidate, entryOrder, closeOrders, stopOrders, fills, coverage, coverageEndTs: now,
    freshPositions: [{ symbol: exchangeSymbol, positionAmt: "0", positionSide: "LONG" }],
    freshOpenOrders: [], expectedExchangeClientOrderId: "entry-client",
    expectedCloseExchangeClientOrderId: expectedMarketClientId,
    accountId, observedAtMs: now, nowMs: now,
  };
  return {
    args,
    verify(overrides = {}) {
      return verifyHistoricalCloseEvidence({ ...args, ...overrides });
    },
    verifyV2(overrides = {}) {
      return verifyVstMultiFillCloseEvidence({ ...args, ...overrides }, {
        assertHistoricalFillCoverage,
      });
    },
  };
}

test("lifecycle v2 aggregates multiple entry and exit fills by exact quantity-weighted VWAP", () => {
  const { verify } = fixture();
  const proof = verify();
  assert.equal(proof.lifecycleVersion, 2);
  assert.equal(proof.entryFills.length, 2);
  assert.equal(proof.closeFills.length, 2);
  assert.equal(proof.entryFill.quantity, "10");
  assert.equal(proof.entryFill.price, "106");
  assert.equal(proof.entryFill.fee.amount, "-0.02");
  assert.equal(proof.closeFill.quantity, "10");
  assert.equal(proof.closeFill.price, "118");
  assert.equal(proof.closeFill.fee.amount, "-0.02");
  assert.equal(proof.closeFill.realisedPnl, "120");
  assert.equal(proof.closeFill.realisedPnlProvenance, "bingx_fill_history.realisedPNL");
  assert.deepEqual(proof.closeOrderIds, ["core-child", "market-close"]);
});

test("a fully stop-closed position needs no MARKET order", () => {
  const proof = fixture("both-stops").verify();
  assert.equal(proof.lifecycleVersion, 2);
  assert.equal(proof.closeOrderIds.length, 2);
  assert.equal(proof.closeFill.quantity, "10");
});

test("runner exits require the same exact persisted descriptor in request and snapshot", () => {
  const data = fixture();
  const stop = data.args.candidate.closeIntent.request.coreStop;
  data.args.candidate.closeIntent.request.runnerStop = { ...stop, orderId: "runner-stop" };
  data.args.candidate.snapshot.split.runnerStop = { ...stop, orderId: "runner-stop" };
  data.args.stopOrders[0].orderId = "runner-stop";
  data.args.closeOrders[0].triggerOrderId = "runner-stop";
  assert.equal(data.verify().verified, true);
  delete data.args.candidate.closeIntent.request.runnerStop;
  assert.throws(() => data.verify(), /stop_metadata_incomplete/);
  delete data.args.candidate.snapshot.split.runnerStop;
  assert.throws(() => data.verify(), /stop_parent_foreign/);
});

test("multi-fill MARKET-only close needs no queried unused stop parents", () => {
  const proof = fixture("market-only").verify();
  assert.equal(proof.closeFill.quantity, "10");
  assert.deepEqual(proof.stopOrders, []);
  assert.equal(proof.closeFills.length, 2);
});

test("non-terminating VWAP is deterministic and each native realised-PnL string is preserved", () => {
  const data = fixture("market-only");
  const candidate = data.args.candidate;
  candidate.snapshot.verifiedFill.quantity = "3";
  candidate.snapshot.remainingQty = "3";
  candidate.snapshot.split.totalQuantity = "3";
  candidate.snapshot.split.coreStop.quantity = "2";
  candidate.closeIntent.request.totalQuantity = "3";
  candidate.closeIntent.request.originalStop.quantity = "3";
  candidate.closeIntent.request.coreStop.quantity = "2";
  data.args.entryOrder.executedQty = "3";
  data.args.entryOrder.origQty = "3";
  data.args.entryOrder.avgPrice = "106";
  data.args.fills[0].qty = "1";
  data.args.fills[0].price = "106";
  data.args.fills[1].qty = "2";
  data.args.fills[1].price = "106";
  data.args.closeOrders[0].executedQty = "3";
  data.args.closeOrders[0].origQty = "3";
  delete data.args.closeOrders[0].avgPrice;
  data.args.fills[2].qty = "1";
  data.args.fills[2].price = "1";
  data.args.fills[2].realisedPNL = "-0.0400";
  data.args.fills[3].qty = "2";
  data.args.fills[3].price = "2";
  data.args.fills[3].realisedPNL = "0.0500";

  const proof = data.verify();
  assert.match(proof.closeFill.price, /^1\.6\d{23,24}$/);
  assert.equal(proof.closeFills[0].realisedPnl, "-0.0400");
  assert.equal(proof.closeFills[1].realisedPnl, "0.0500");
  assert.equal(proof.closeFill.realisedPnl, "0.01");
});

test("native price precision accepts rounded averages, records the contract, and rejects a one-tick error", () => {
  const data = fixture("market-only");
  const candidate = data.args.candidate;
  candidate.snapshot.verifiedFill = { ...candidate.snapshot.verifiedFill, price: "1.67", quantity: "3" };
  candidate.snapshot.remainingQty = "3";
  candidate.snapshot.split.totalQuantity = "3";
  candidate.snapshot.split.coreStop.quantity = "2";
  candidate.closeIntent.request.totalQuantity = "3";
  candidate.closeIntent.request.originalStop.quantity = "3";
  candidate.closeIntent.request.coreStop.quantity = "2";
  data.args.entryOrder.executedQty = "3";
  data.args.entryOrder.origQty = "3";
  data.args.entryOrder.avgPrice = "1.67";
  data.args.fills[0].qty = "1";
  data.args.fills[0].price = "1";
  data.args.fills[1].qty = "2";
  data.args.fills[1].price = "2";
  data.args.closeOrders[0].executedQty = "3";
  data.args.closeOrders[0].origQty = "3";
  data.args.closeOrders[0].avgPrice = "1.67";
  data.args.fills[2].qty = "1";
  data.args.fills[2].price = "1";
  data.args.fills[3].qty = "2";
  data.args.fills[3].price = "2";
  const contract = { symbol: exchangeSymbol, pricePrecision: 2, tickSize: "0.01" };
  const proof = data.verifyV2({ contract });
  assert.equal(proof.contract.tickSize, "0.01");
  assert.equal(proof.priceRounding.contractPricePrecision, 2);
  assert.equal(proof.priceRounding.comparisons[0].mode,
    "contract_precision_nearest_half_up");
  assert.equal(proof.closeFill.price, "1.666666666666666666666666");

  assert.throws(() => data.verifyV2({
    contract,
    closeOrders: [{ ...data.args.closeOrders[0], avgPrice: "1.68" }],
  }), /close_order_price_mismatch/);
  assert.throws(() => data.verifyV2({
    contract: { ...contract, symbol: "OTHER-USDT" },
  }), /contract_price_precision_invalid/);
  assert.throws(() => data.verifyV2({
    contract: { ...contract, pricePrecision: 13 },
  }), /contract_price_precision_invalid/);
});

test("lifecycle rejects foreign stop children, missing parent, duplicate fills and aliases", () => {
  const base = fixture();
  const foreign = structuredClone(base.args.closeOrders);
  foreign[0].triggerOrderId = "foreign-stop";
  assert.throws(() => base.verify({ closeOrders: foreign }), /stop_child_mismatch/);

  assert.throws(() => base.verify({ stopOrders: [] }), /stop_child_mismatch/);
  assert.throws(() => base.verify({
    stopOrders: [...base.args.stopOrders, { ...base.args.stopOrders[0], orderId: "foreign-stop" }],
  }), /stop_parent_foreign/);

  const duplicate = structuredClone(base.args.fills);
  duplicate[3].tradeID = duplicate[2].tradeId;
  duplicate[3].tradeId = duplicate[2].tradeId;
  assert.throws(() => base.verify({ fills: duplicate }), /duplicate_trade_fills/);

  const aliasConflict = structuredClone(base.args.fills);
  aliasConflict[3].tradeID = "conflicting-trade";
  assert.throws(() => base.verify({ fills: aliasConflict }), /fill_trade_id_invalid/);

  const alias = structuredClone(base.args.fills);
  alias[3].orderID = "other-order";
  assert.throws(() => base.verify({ fills: alias }), /fill_order_id_invalid/);
});

test("v2 validates decimal and execution aliases plus numeric-zero trigger sentinels", () => {
  const base = fixture();
  const qtyAlias = structuredClone(base.args.fills);
  qtyAlias[0].quantity = "5";
  assert.throws(() => base.verify({ fills: qtyAlias }), /fill_quantity_alias_mismatch/);

  const priceAlias = structuredClone(base.args.fills);
  priceAlias[0].fillPrice = "101";
  assert.throws(() => base.verify({ fills: priceAlias }), /fill_price_alias_mismatch/);

  const execAlias = structuredClone(base.args.closeOrders);
  execAlias[0].cumExecQty = "5";
  assert.throws(() => base.verify({ closeOrders: execAlias }), /close_order_quantity_alias_mismatch/);

  const averageAlias = structuredClone(base.args.closeOrders);
  averageAlias[0].averagePrice = "121";
  assert.throws(() => base.verify({ closeOrders: averageAlias }),
    /close_order_average_price_alias_mismatch/);

  const wrongFillTrigger = structuredClone(base.args.fills);
  wrongFillTrigger[3].triggerOrderId = "foreign-stop";
  assert.throws(() => base.verify({ fills: wrongFillTrigger }), /fill_trigger_order_mismatch/);

  const zeroMarketTrigger = structuredClone(base.args.closeOrders);
  zeroMarketTrigger[1].triggerOrderId = 0;
  assert.equal(base.verify({ closeOrders: zeroMarketTrigger }).verified, true);
  for (const zero of [0, "0"]) {
    const nativeFills = structuredClone(base.args.fills);
    // BingX includes this sentinel on ordinary entry fills too, not just
    // MARKET exit orders. It does not identify a conditional parent.
    for (const fill of nativeFills.slice(0, 2)) {
      fill.triggerOrderId = zero;
      fill.triggerOrderID = zero;
    }
    assert.equal(base.verify({ fills: nativeFills }).verified, true);
  }
  const foreignEntryTrigger = structuredClone(base.args.fills);
  foreignEntryTrigger[0].triggerOrderId = "foreign-entry-trigger";
  assert.throws(() => base.verify({ fills: foreignEntryTrigger }),
    /fill_trigger_order_mismatch/);
  const conflictingEntryTrigger = structuredClone(base.args.fills);
  conflictingEntryTrigger[0].triggerOrderId = 0;
  conflictingEntryTrigger[0].triggerOrderID = "foreign-entry-trigger";
  assert.throws(() => base.verify({ fills: conflictingEntryTrigger }),
    /fill_trigger_order_id_invalid/);
  const conflictingTrigger = structuredClone(base.args.closeOrders);
  conflictingTrigger[0].triggerOrderID = "0";
  assert.throws(() => base.verify({ closeOrders: conflictingTrigger }),
    /stop_trigger_order_id_invalid/);
});

test("lifecycle rejects incorrect time, quantities, oversell and per-order execution totals", () => {
  const base = fixture();
  const staleTime = structuredClone(base.args.fills);
  staleTime[3].filledTime = entryAt - 1;
  assert.throws(() => base.verify({ fills: staleTime }), /fill_timestamp_mismatch|close_fills_missing_or_early/);

  const wrongQty = structuredClone(base.args.fills);
  wrongQty[3].qty = "3";
  assert.throws(() => base.verify({ fills: wrongQty }), /close_order_quantity_mismatch|close_quantity_incomplete/);

  const oversell = structuredClone(base.args.fills);
  oversell[2].qty = "11";
  assert.throws(() => base.verify({ fills: oversell }), /close_order_quantity_mismatch|close_quantity_oversold/);

  const wrongExecuted = structuredClone(base.args.closeOrders);
  wrongExecuted[0].executedQty = "5";
  assert.throws(() => base.verify({ closeOrders: wrongExecuted }), /close_order_quantity_mismatch/);
});

test("lifecycle requires fresh unsaturated coverage, native PnL, and signed VST fees", () => {
  const base = fixture();
  assert.throws(() => base.verify({ observedAtMs: now - 30_001 }), /flat_read_stale_or_unverified/);
  const saturated = structuredClone(base.args.coverage);
  saturated[0].rawCount = 1_000;
  assert.throws(() => base.verify({ coverage: saturated }), /fill_coverage_unverified/);

  const noPnl = structuredClone(base.args.fills);
  delete noPnl.at(-1).realisedPNL;
  assert.throws(() => base.verify({ fills: noPnl }), /close_realised_pnl_invalid/);
  const noFee = structuredClone(base.args.fills);
  noFee.at(-1).commissionAsset = "USDT";
  assert.throws(() => base.verify({ fills: noFee }), /close_fee_asset_unknown/);
});

test("archived runner multi-fill proof retains exact numeric parent IDs and native costs beyond retention", () => {
  const data = fixture();
  const proofNow = now + 10 * 24 * 60 * 60 * 1000;
  const ids = new Map([
    ["position-multi-1", "9000000000000000001"],
    ["entry-order-1", "9000000000000000002"],
    ["original-stop", "9000000000000000003"],
    ["core-stop", "9000000000000000004"],
    ["core-child", "9000000000000000005"],
    ["market-close", "9000000000000000006"],
    ["entry-fill-a", "9000000000000000011"],
    ["entry-fill-b", "9000000000000000012"],
    ["stop-fill", "9000000000000000013"],
    ["market-fill", "9000000000000000014"],
  ]);
  const remap = (value) => {
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]));
    }
    return ids.get(value) ?? value;
  };
  Object.assign(data.args, remap(data.args));
  for (const row of data.args.fills) row.filledTime = new Date(row.filledTime).toISOString();

  const archivedStart = entryAt - 1_000;
  const archivedEnd = entryAt + 60_000;
  const archivedAt = archivedEnd + 1_000;
  const rawFills = structuredClone(data.args.fills);
  const originalStopId = ids.get("original-stop");
  const archivedOrders = [
    data.args.entryOrder,
    ...data.args.closeOrders,
    ...data.args.stopOrders,
    {
      symbol: exchangeSymbol,
      orderId: originalStopId,
      status: "CANCELED",
      side: "SELL",
      positionSide: "LONG",
      type: "STOP_MARKET",
      positionID: ids.get(positionId),
    },
  ];
  const archiveCoverage = {
    verified: true,
    endpoint,
    currency: "USDT",
    startTs: archivedStart,
    endTs: archivedEnd,
    rawCount: rawFills.length,
    pageSize: 1_000,
    passes: 2,
    terminalPage: 2,
    snapshotSha256: fillHistoryDigest(rawFills),
    observedAt: new Date(archivedAt).toISOString(),
  };
  const archiveWindow = {
    environment: "vst",
    accountId,
    currency: "USDT",
    coverage: archiveCoverage,
    rawFills,
    orders: archivedOrders,
    archivedAt: new Date(archivedAt).toISOString(),
  };
  const coverage = [archiveCoverage];
  for (let cursor = archivedEnd; cursor < proofNow;) {
    const endTs = Math.min(proofNow, cursor + 23 * 60 * 60 * 1000);
    coverage.push({
      verified: true,
      endpoint,
      currency: "USDT",
      startTs: cursor,
      endTs,
      rawCount: 0,
      pageSize: 1_000,
      passes: 2,
      terminalPage: 2,
      snapshotSha256: fillHistoryDigest([]),
      observedAt: new Date(proofNow).toISOString(),
    });
    cursor = endTs;
  }
  data.args.coverage = coverage;
  data.args.coverageEndTs = proofNow;
  data.args.archiveWindows = [archiveWindow];
  data.args.observedAtMs = proofNow;
  data.args.nowMs = proofNow;

  const proof = data.verify();
  assert.equal(proof.verified, true);
  assert.equal(proof.closeFill.fee.amount, "-0.02");
  assert.equal(proof.closeFill.realisedPnl, "120");
  assert.equal(proof.closeFill.realisedPnlProvenance,
    "bingx_fill_history.realisedPNL");
  assert.deepEqual(proof.closeFill.closeOrderIds, [
    ids.get("core-child"), ids.get("market-close"),
  ]);
  assert.equal(proof.stopOrders[0].orderId, ids.get("core-stop"));
  assert.equal(proof.closeOrders[0].triggerOrderId, ids.get("core-stop"));
  assert.deepEqual(proof.archiveWindows, [archiveWindow]);
  assert.equal(proof.coverage[0].snapshotSha256, fillHistoryDigest(rawFills));

  const missingParent = structuredClone(archiveWindow);
  missingParent.orders = missingParent.orders.filter((order) =>
    order.orderId !== ids.get("core-stop"));
  assert.throws(() => data.verify({ archiveWindows: [missingParent] }),
    /vst_fill_archive_parent_missing/);

  const wrongScope = structuredClone(archiveWindow);
  wrongScope.accountId = "different-vst-account";
  assert.throws(() => data.verify({ archiveWindows: [wrongScope] }),
    /vst_fill_archive_window_invalid/);

  assert.throws(() => data.verify({ observedAtMs: proofNow - 30_001 }),
    /flat_read_stale_or_unverified/);
});