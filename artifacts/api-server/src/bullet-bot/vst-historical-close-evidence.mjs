import { createHash } from "node:crypto";
import { verifyVstMultiFillCloseEvidence } from "./vst-multi-fill-close-evidence.mjs";
import { assertArchiveCoverage } from "./vst-fill-archive.mjs";

const SYMBOL_PATTERN = /^[A-Z0-9]{1,20}USDT$/;
const MAX_FLAT_READ_AGE_MS = 30_000;
const FUTURE_CLOCK_TOLERANCE_MS = 2_000;
const MAX_FILL_HISTORY_WINDOW_MS = 23 * 60 * 60 * 1000;
const MAX_FILL_HISTORY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const COMPLETE_FILL_HISTORY_ENDPOINT = "/openApi/swap/v2/trade/fillHistory";
const MAX_COMPLETE_FILL_HISTORY_ROWS = 1_000;

function fail(reason) {
  throw new Error(`vst_historical_close_${reason}`);
}

function symbolName(symbol) {
  if (typeof symbol !== "string" || !SYMBOL_PATTERN.test(symbol)) {
    fail("symbol_invalid");
  }
  return `${symbol.slice(0, -4)}-USDT`;
}

function identifier(value, label) {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  fail(`${label}_invalid`);
}

function orderId(row, label) {
  const ids = [row?.orderId, row?.orderID]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => identifier(value, label));
  if (ids.length === 0 || new Set(ids).size !== 1) fail(`${label}_invalid`);
  return ids[0];
}

function tradeId(row, label) {
  const ids = [row?.tradeId, row?.tradeID]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => identifier(value, label));
  if (ids.length === 0 || new Set(ids).size !== 1) fail(`${label}_invalid`);
  return ids[0];
}

function decimal(value, label, { signed = false } = {}) {
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const pattern = signed ? /^[+-]?\d+(?:\.\d+)?$/ : /^\d+(?:\.\d+)?$/;
  if (!pattern.test(text)) fail(`${label}_invalid`);
  const negative = text.startsWith("-");
  const unsigned = text.replace(/^[+-]/, "");
  const [whole, fraction = ""] = unsigned.split(".");
  if (fraction.length > 30) fail(`${label}_invalid`);
  return {
    amount: BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n),
    scale: fraction.length,
    text,
  };
}

function decimalAtScale(value, scale) {
  return value.amount * (10n ** BigInt(scale - value.scale));
}

function sameDecimal(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return decimalAtScale(left, scale) === decimalAtScale(right, scale);
}

function numberText(value, label, { signed = false } = {}) {
  const result = decimal(value, label, { signed });
  if (result.amount <= 0n && !signed || result.amount === 0n) fail(`${label}_invalid`);
  return result.text;
}

function millis(value) {
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const normalized = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
  return Number.isSafeInteger(normalized) ? normalized : null;
}

function orderTimestamp(order, label, preferUpdate = false) {
  const value = preferUpdate
    ? order?.updateTime ?? order?.time ?? order?.createdAt ??
      order?.transactTime ?? order?.timestamp
    : order?.time ?? order?.createdAt ?? order?.transactTime ??
      order?.timestamp ?? order?.updateTime;
  const time = millis(value);
  if (time === null) fail(`${label}_timestamp_invalid`);
  return time;
}

function fillTimestamp(fill) {
  const time = millis(fill?.filledTm ?? fill?.filledTime ?? fill?.time ??
    fill?.timestamp ?? fill?.tradeTime);
  if (time === null) fail("fill_timestamp_invalid");
  return time;
}

function quantity(fill, label) {
  return numberText(fill?.qty ?? fill?.quantity ?? fill?.volume, label);
}

function price(fill, label) {
  return numberText(fill?.price, label);
}

function realisedPnl(fill) {
  return decimal(fill?.realisedPNL, "close_realised_pnl", { signed: true }).text;
}

function clientOrderId(row) {
  const values = [row?.clientOrderId, row?.clientOrderID]
    .filter((value) => value !== undefined && value !== null);
  return values.length > 0 && values.every((value) => typeof value === "string") &&
    new Set(values).size === 1 ? values[0] : null;
}

function commission(fill, label) {
  if (fill?.commissionAsset !== "VST") {
    fail(`${label}_fee_asset_unknown`);
  }
  const amount = decimal(fill?.commission ?? fill?.fee ??
    fill?.commissionAmount ?? fill?.feeAmount, `${label}_fee`, { signed: true });
  return { asset: "VST", amount: amount.text };
}

/**
 * Validate the adapter's repeated, terminal-page proof and the full contiguous
 * set of fixed history windows. Kept shared with the store so a caller cannot
 * bypass completeness checks by constructing evidence without the verifier.
 */
export function assertHistoricalFillCoverage({
  coverage,
  coverageEndTs,
  fills,
  requiredStartBeforeMs,
  requiredEndAtLeastMs,
  freshReadAtMs,
  nowMs,
  maxSnapshotAgeMs = MAX_FLAT_READ_AGE_MS,
  archiveWindows,
  accountId,
}) {
  if (!Array.isArray(coverage) || coverage.length === 0 ||
      !Array.isArray(fills) ||
      !Number.isSafeInteger(coverageEndTs) || coverageEndTs <= 0 ||
      !Number.isSafeInteger(requiredStartBeforeMs) || requiredStartBeforeMs <= 0 ||
      !Number.isSafeInteger(requiredEndAtLeastMs) || requiredEndAtLeastMs <= 0 ||
      !Number.isSafeInteger(freshReadAtMs) || freshReadAtMs <= 0 ||
      !Number.isSafeInteger(nowMs) || nowMs <= 0 ||
      !Number.isSafeInteger(maxSnapshotAgeMs) || maxSnapshotAgeMs <= 0 ||
      maxSnapshotAgeMs > 120_000) {
    fail("fill_coverage_unverified");
  }

  let previousEndTs = null;
  let previousObservedAt = null;
  let targetFillCount = 0;
  let firstStartTs = null;
  const archival = Array.isArray(archiveWindows) && archiveWindows.length > 0;
  if (archival) assertArchiveCoverage({ archiveWindows, coverage, fills, accountId });
  for (const snapshot of coverage) {
    const startTs = snapshot?.startTs;
    const endTs = snapshot?.endTs;
    const observedAt = millis(snapshot?.observedAt);
    const archived = archival && archiveWindows.some((w) =>
      w.coverage.startTs === startTs && w.coverage.endTs === endTs &&
      w.coverage.snapshotSha256 === snapshot.snapshotSha256 &&
      w.coverage.observedAt === snapshot.observedAt);
    if (snapshot?.verified !== true ||
        snapshot?.endpoint !== COMPLETE_FILL_HISTORY_ENDPOINT ||
        !Number.isSafeInteger(startTs) || startTs <= 0 ||
        !Number.isSafeInteger(endTs) || endTs < startTs ||
        endTs - startTs > MAX_FILL_HISTORY_WINDOW_MS ||
        !Number.isSafeInteger(snapshot?.rawCount) || snapshot.rawCount < 0 ||
        snapshot.rawCount >= MAX_COMPLETE_FILL_HISTORY_ROWS ||
        snapshot?.currency !== "USDT" || snapshot?.pageSize !== 1_000 ||
        typeof snapshot?.snapshotSha256 !== "string" ||
        !/^[a-f0-9]{64}$/i.test(snapshot.snapshotSha256) ||
        snapshot?.passes !== 2 || snapshot?.terminalPage !== 2 ||
        observedAt === null ||
        observedAt > nowMs + FUTURE_CLOCK_TOLERANCE_MS ||
         !archived && nowMs - observedAt > maxSnapshotAgeMs ||
        observedAt > freshReadAtMs + FUTURE_CLOCK_TOLERANCE_MS ||
        previousEndTs !== null && startTs !== previousEndTs ||
        !archival && previousObservedAt !== null && observedAt < previousObservedAt) {
      fail("fill_coverage_unverified");
    }
    if (firstStartTs === null) firstStartTs = startTs;
    targetFillCount = fills.filter((fill) => {
      const time = fillTimestamp(fill);
      return time > startTs && time <= endTs;
    }).length;
    if (snapshot.rawCount < targetFillCount) fail("fill_coverage_unverified");
    previousEndTs = endTs;
    previousObservedAt = observedAt;
  }

  if (coverageEndTs !== previousEndTs ||
      coverageEndTs !== coverage.at(-1)?.endTs ||
      coverageEndTs < requiredEndAtLeastMs ||
      coverageEndTs > nowMs + FUTURE_CLOCK_TOLERANCE_MS ||
      firstStartTs >= requiredStartBeforeMs ||
      !archival && coverageEndTs - firstStartTs > MAX_FILL_HISTORY_LOOKBACK_MS) {
    fail("fill_coverage_window_invalid");
  }
  for (const fill of fills) {
    const time = fillTimestamp(fill);
    if (time <= firstStartTs || time > coverageEndTs) {
      fail("fill_outside_complete_window");
    }
  }
  return { startTs: firstStartTs, endTs: coverageEndTs };
}

function recordedEntryFill(candidate) {
  const verified = candidate?.snapshot?.verifiedFill;
  if (verified && typeof verified === "object") return verified;
  const outcome = candidate?.entryIntent?.outcome;
  if (outcome?.status !== "filled" || outcome.verified !== true ||
      outcome.fillPrice === undefined || outcome.fillQuantity === undefined ||
      candidate?.snapshot?.entryAt === undefined) {
    return null;
  }
  return {
    price: outcome.fillPrice,
    quantity: outcome.fillQuantity,
    at: candidate.snapshot.entryAt,
  };
}

function positionAmount(position) {
  const text = typeof position?.positionAmt === "string" ||
    typeof position?.positionAmt === "number" ? String(position.positionAmt) : "";
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) fail("flat_position_read_invalid");
  return decimal(text, "flat_position_quantity", { signed: true });
}

/**
 * Verify a complete, read-only history proof for one previously tracked LONG.
 * This module never performs exchange calls or writes; it only validates the
 * exact order/fill and fresh-flat observations supplied by the broker adapter.
 */
// Ordinary confirmed entries can become unknown after an owner closes them.
// This eligibility is not close proof: the full lifecycle, exact orders,
// native costs, fresh flat reads and locked store guards remain mandatory.
export function isVerifiedEntryCloseCandidate(candidate) {
  const snapshot = candidate?.snapshot;
  const intent = candidate?.entryIntent;
  return Boolean(
    ["open", "unknown"].includes(candidate?.status) &&
    ["open", "unknown"].includes(candidate?.signalStatus) &&
    snapshot?.environment === "vst" &&
    snapshot?.symbol === candidate?.symbol &&
    snapshot?.sourceSignalId === candidate?.sourceSignalId &&
    snapshot?.coreOpen === true && snapshot?.runnerOpen === false &&
    (snapshot?.patternId !== "impulse_buy" || snapshot?.strategyAuthority === "source") &&
    !snapshot?.split && !snapshot?.protectedExit &&
    !snapshot?.manualResolution && !snapshot?.externalClose &&
    !snapshot?.exchangeExternalClose &&
    intent?.state === "reconciled" &&
    intent?.sourceSignalId === candidate?.sourceSignalId &&
    intent?.phase === "market-entry" &&
    intent?.request?.operation === "entry" &&
    intent?.request?.environment === "vst" &&
    intent?.request?.accountId === snapshot?.accountId &&
    intent?.request?.symbol === candidate?.symbol &&
    intent?.outcome?.status === "filled" &&
    intent?.outcome?.verified === true &&
    typeof intent?.exchangeOrderId === "string" &&
    intent.exchangeOrderId !== "" &&
    snapshot?.entryOrderId === intent.exchangeOrderId &&
    typeof snapshot?.exchangePositionId === "string" &&
    snapshot.exchangePositionId !== "" &&
    snapshot.exchangePositionId === intent?.outcome?.positionId
  );
}

export function corroborateHistoricalEntryPrice(recorded, native) {
  const stored = decimal(recorded, "stored_entry_price");
  const observed = decimal(native, "entry_fill_price");
  if (sameDecimal(stored, observed)) return { verified: true, kind: "exact_decimal" };
  // Older entry snapshots stored a JS-number weighted average. Only that
  // numeric representation can carry machine roundoff (e.g. 0.22390000000000002).
  // Native prices, string prices, quantities and costs remain exact. This is
  // a two-epsilon arithmetic bound, not a contract-tick or trading tolerance.
  const nativeNumber = Number(native);
  if (typeof recorded === "number" && Number.isFinite(recorded) &&
      Number.isFinite(nativeNumber) && recorded > 0 && nativeNumber > 0 &&
      Math.abs(recorded - nativeNumber) <=
        2 * Number.EPSILON * Math.max(recorded, nativeNumber)) {
    return { verified: true, kind: "stored_number_roundoff",
      recordedPrice: recorded, nativePrice: String(native), epsilonMultiple: 2 };
  }
  return { verified: false, kind: "price_mismatch" };
}

export function verifyHistoricalCloseEvidence({
  candidate,
  entryOrder,
  closeOrder,
  closeOrders,
  stopOrders,
  contract,
  fills,
  coverage,
  coverageEndTs,
  archiveWindows,
  freshPositions,
  freshOpenOrders,
  expectedExchangeClientOrderId,
  expectedCloseExchangeClientOrderId,
  accountId,
  observedAtMs,
  nowMs,
}) {
  const ownerPreRunnerReview = candidate?.ownerPreRunnerCloseReview === true;
  if (ownerPreRunnerReview &&
      (Array.isArray(fills) && fills.length > 2 ||
       closeOrders !== undefined || stopOrders !== undefined)) {
    return verifyVstMultiFillCloseEvidence({
      candidate,
      entryOrder,
      closeOrder,
      closeOrders: closeOrders ?? [],
      stopOrders: stopOrders ?? [],
      contract,
      fills,
      coverage,
      coverageEndTs,
      archiveWindows,
      freshPositions,
      freshOpenOrders,
      expectedExchangeClientOrderId,
      expectedCloseExchangeClientOrderId,
      accountId,
      observedAtMs,
      nowMs,
    }, { assertHistoricalFillCoverage });
  }
  if (!candidate ||
      !(candidate.status === "error" || isVerifiedEntryCloseCandidate(candidate) ||
        ownerPreRunnerReview &&
        ["open", "closing", "unknown"].includes(candidate.status)) ||
      candidate.snapshot?.environment !== "vst" ||
      candidate.snapshot?.accountId !== accountId ||
      candidate.snapshot?.symbol !== candidate.symbol ||
      candidate.entryIntent?.sourceSignalId !== candidate.sourceSignalId ||
      candidate.entryIntent?.phase !== "market-entry" ||
      !["failed", "reconciled"].includes(candidate.entryIntent?.state) ||
      candidate.entryIntent?.request?.operation !== "entry" ||
      candidate.entryIntent?.request?.environment !== "vst" ||
      candidate.entryIntent?.request?.accountId !== accountId ||
      candidate.entryIntent?.request?.symbol !== candidate.symbol ||
      candidate.entryIntent?.exchangeOrderId == null ||
      ownerPreRunnerReview &&
        (candidate.closeIntent?.state !== "unknown" ||
         candidate.closeIntent?.request?.operation !== "close_pre_runner_split" ||
         candidate.closeIntent?.sourceSignalId !== candidate.sourceSignalId ||
         candidate.closeIntent?.request?.sourceSignalId !== candidate.sourceSignalId ||
         candidate.closeIntent?.request?.environment !== "vst" ||
         candidate.closeIntent?.request?.symbol !== candidate.symbol ||
         candidate.closeIntent?.request?.accountId !== accountId ||
         typeof candidate.closeIntent?.clientOrderId !== "string" ||
         candidate.closeIntent?.request?.closeIntentId !==
           candidate.closeIntent?.clientOrderId)) {
    fail("candidate_ineligible");
  }
  if (candidate.snapshot.manualResolution ||
      candidate.snapshot.exchangeExternalClose ||
      candidate.snapshot.externalClose) {
    fail("candidate_has_other_attribution");
  }

  const name = symbolName(candidate.symbol);
  const closeType = String(closeOrder?.type ?? "").toUpperCase();
  const savedEntryId = identifier(candidate.entryIntent.exchangeOrderId, "entry_order_id");
  const entryId = orderId(entryOrder, "entry_order_id");
  const closeId = orderId(closeOrder, "close_order_id");
  if (entryId !== savedEntryId || closeId === entryId) fail("order_id_mismatch");
  if (!Array.isArray(fills) || fills.length !== 2) fail("fills_incomplete_or_foreign");
  if (!Array.isArray(freshPositions) || !Array.isArray(freshOpenOrders) ||
      !Number.isSafeInteger(nowMs) || nowMs <= 0 ||
      !Number.isSafeInteger(observedAtMs) || observedAtMs <= 0 ||
      observedAtMs > nowMs + FUTURE_CLOCK_TOLERANCE_MS ||
      nowMs - observedAtMs > MAX_FLAT_READ_AGE_MS) {
    fail("flat_read_stale_or_unverified");
  }
  if (freshPositions.some((row) => row?.symbol !== name) ||
      freshOpenOrders.some((row) => row?.symbol !== name)) {
    fail("flat_read_symbol_mismatch");
  }
  if (freshPositions.some((row) => positionAmount(row).amount !== 0n) ||
      freshOpenOrders.length !== 0) {
    fail("symbol_not_flat");
  }

  const storedEntry = recordedEntryFill(candidate);
  if (!storedEntry) fail("verified_entry_metadata_missing");
  const storedPrice = price(storedEntry, "stored_entry_price");
  const storedQuantity = quantity(storedEntry, "stored_entry_quantity");
  const storedAt = millis(storedEntry?.at);
  if (storedAt === null || storedAt > nowMs + FUTURE_CLOCK_TOLERANCE_MS) {
    fail("stored_entry_timestamp_invalid");
  }
  const remaining = candidate.snapshot.remainingQty;
  if (remaining === undefined ||
      !sameDecimal(decimal(remaining, "stored_remaining_quantity"),
        decimal(storedQuantity, "stored_entry_quantity"))) {
    fail("stored_entry_remaining_quantity_mismatch");
  }

  const entryStatus = String(entryOrder?.status ?? "").toUpperCase();
  const entryType = String(entryOrder?.type ?? "").toUpperCase();
  const requestedEntryType = candidate.entryIntent.request.entryOrderType;
  if (entryOrder?.symbol !== name || entryStatus !== "FILLED" ||
      String(entryOrder?.side ?? "").toUpperCase() !== "BUY" ||
      String(entryOrder?.positionSide ?? "").toUpperCase() !== "LONG" ||
      !["LIMIT", "MARKET"].includes(entryType) ||
      requestedEntryType !== undefined && requestedEntryType !== entryType) {
    fail("entry_order_mismatch");
  }
  const entryTime = orderTimestamp(entryOrder, "entry_order");
  const closeTime = orderTimestamp(closeOrder, "close_order", true);

  const byId = new Map();
  const tradeIds = new Set();
  for (const fill of fills) {
    if (fill?.symbol !== name) fail("fill_symbol_mismatch");
    const id = orderId(fill, "fill_order_id");
    const fillTradeId = tradeId(fill, "fill_trade_id");
    if (byId.has(id)) fail("duplicate_order_fills");
    if (tradeIds.has(fillTradeId)) fail("duplicate_trade_fills");
    byId.set(id, fill);
    tradeIds.add(fillTradeId);
  }
  if (byId.size !== 2 || !byId.has(entryId) || !byId.has(closeId)) {
    fail("fills_do_not_match_entry_and_close");
  }
  const entryFillRow = byId.get(entryId);
  const closeFillRow = byId.get(closeId);
  const entryFillTime = fillTimestamp(entryFillRow);
  const closeFillTime = fillTimestamp(closeFillRow);
  const startTs = Math.min(entryFillTime, closeFillTime);
  if (entryFillTime > nowMs + FUTURE_CLOCK_TOLERANCE_MS ||
      closeFillTime > nowMs + FUTURE_CLOCK_TOLERANCE_MS ||
      entryFillTime > closeFillTime ||
      entryTime > entryFillTime + FUTURE_CLOCK_TOLERANCE_MS ||
      closeTime < entryTime || closeTime > nowMs + FUTURE_CLOCK_TOLERANCE_MS ||
      closeFillTime < entryTime || closeFillTime > closeTime + FUTURE_CLOCK_TOLERANCE_MS ||
      entryFillTime > storedAt + 60_000 ||
      storedAt > closeFillTime + FUTURE_CLOCK_TOLERANCE_MS) {
    fail("fill_timestamp_mismatch");
  }
  assertHistoricalFillCoverage({
    coverage,
    coverageEndTs,
    fills,
    requiredStartBeforeMs: entryFillTime,
    requiredEndAtLeastMs: closeFillTime,
    freshReadAtMs: observedAtMs,
    nowMs,
    archiveWindows,
    accountId,
  });
  for (const fill of fills) {
    const time = fillTimestamp(fill);
    if (time < startTs || time > nowMs + FUTURE_CLOCK_TOLERANCE_MS) {
      fail("fill_outside_complete_window");
    }
  }

  const entryQty = quantity(entryFillRow, "entry_fill_quantity");
  const entryPrice = price(entryFillRow, "entry_fill_price");
  const entryPriceCorroboration = corroborateHistoricalEntryPrice(storedEntry.price, entryPrice);
  const closeQty = quantity(closeFillRow, "close_fill_quantity");
  const closePrice = price(closeFillRow, "close_fill_price");
  if (!sameDecimal(decimal(entryQty, "entry_fill_quantity"),
        decimal(storedQuantity, "stored_entry_quantity")) ||
      !entryPriceCorroboration.verified) {
    fail("entry_fill_does_not_match_verified_entry");
  }

  const entryExecuted = entryOrder.executedQty ?? entryOrder.cumExecQty ??
    entryOrder.filledQty ?? entryOrder.origQty ?? entryOrder.quantity;
  if (entryExecuted === undefined ||
      !sameDecimal(decimal(entryExecuted, "entry_order_quantity"),
        decimal(entryQty, "entry_fill_quantity"))) {
    fail("entry_order_quantity_mismatch");
  }
  const entryAverage = entryOrder.avgPrice ?? entryOrder.averagePrice;
  if (entryAverage === undefined ||
      !sameDecimal(decimal(entryAverage, "entry_order_average_price"),
        decimal(entryPrice, "entry_fill_price"))) {
    fail("entry_order_price_mismatch");
  }

  const closeStatus = String(closeOrder?.status ?? "").toUpperCase();
  const reduceOnly = closeOrder?.reduceOnly === true ||
    typeof closeOrder?.reduceOnly === "string" &&
      closeOrder.reduceOnly.toLowerCase() === "true";
  const entryPositionId = identifier(
    entryOrder.positionId ?? entryOrder.positionID, "entry_position_id",
  );
  const closePositionId = identifier(
    closeOrder.positionId ?? closeOrder.positionID, "close_position_id",
  );
  if (closeOrder?.symbol !== name || closeStatus !== "FILLED" ||
      String(closeOrder?.side ?? "").toUpperCase() !== "SELL" ||
      String(closeOrder?.positionSide ?? "").toUpperCase() !== "LONG" ||
      !(closeType === "MARKET" ||
        isVerifiedEntryCloseCandidate(candidate) && closeType === "STOP_MARKET" &&
        identifier(closeOrder?.triggerOrderId ?? closeOrder?.triggerOrderID,
          "close_trigger_order_id") !== "0") ||
      !reduceOnly || entryPositionId !== closePositionId ||
      candidate.snapshot.exchangePositionId !== undefined &&
        candidate.snapshot.exchangePositionId !== entryPositionId ||
      ownerPreRunnerReview &&
        (typeof expectedCloseExchangeClientOrderId !== "string" ||
         clientOrderId(closeOrder) !== expectedCloseExchangeClientOrderId) ||
      !sameDecimal(decimal(closeQty, "close_fill_quantity"),
        decimal(entryQty, "entry_fill_quantity"))) {
    fail("close_order_mismatch");
  }
  const closeExecuted = closeOrder.executedQty ?? closeOrder.cumExecQty ??
    closeOrder.filledQty ?? closeOrder.origQty ?? closeOrder.quantity;
  if (closeExecuted === undefined ||
      !sameDecimal(decimal(closeExecuted, "close_order_quantity"),
        decimal(closeQty, "close_fill_quantity"))) {
    fail("close_order_quantity_mismatch");
  }
  const closeAverage = closeOrder.avgPrice ?? closeOrder.averagePrice;
  if (closeAverage === undefined ||
      !sameDecimal(decimal(closeAverage, "close_order_average_price"),
        decimal(closePrice, "close_fill_price"))) {
    fail("close_order_price_mismatch");
  }

  const entryFee = commission(entryFillRow, "entry");
  const closeFee = commission(closeFillRow, "close");
  const observedClientId = clientOrderId(entryOrder);
  const derivedClientId = typeof expectedExchangeClientOrderId === "string"
    ? expectedExchangeClientOrderId : null;
  const transformedClientIdMatches = derivedClientId !== null &&
    observedClientId === derivedClientId;
  // Some persisted parent intents pre-date the adapter's child client-ID
  // transform. In that shape the exact durable exchange order ID plus the
  // exact recorded verified fill is the independent attribution; retain both
  // IDs and this explanation rather than silently ignoring the mismatch.
  const clientIdAttribution = transformedClientIdMatches
    ? {
        kind: "broker_transformed_client_id",
        savedClientOrderId: candidate.entryIntent.clientOrderId,
        expectedExchangeClientOrderId: derivedClientId,
        observedExchangeClientOrderId: observedClientId,
      }
    : {
        kind: "saved_exchange_order_id_and_verified_entry_fill",
        explanation: "The persisted parent intent ID and exchange child client ID differ; the exact saved exchange order ID and matching recorded verified entry fill corroborate the child order.",
        savedClientOrderId: candidate.entryIntent.clientOrderId,
        expectedExchangeClientOrderId: derivedClientId,
        observedExchangeClientOrderId: observedClientId,
        exchangeOrderId: entryId,
      };

  const entryFill = {
    exchangeOrderId: entryId,
    positionId: entryPositionId,
    price: entryPrice,
    quantity: entryQty,
    at: new Date(entryFillTime).toISOString(),
    fee: entryFee,
  };
  const closeFill = {
    exchangeOrderId: closeId,
    positionId: closePositionId,
    price: closePrice,
    quantity: closeQty,
    at: new Date(closeFillTime).toISOString(),
    fee: closeFee,
    realisedPnl: realisedPnl(closeFillRow),
    realisedPnlAsset: "USDT",
    realisedPnlProvenance: "bingx_fill_history.realisedPNL",
  };
  const flatCheck = {
    verified: true,
    environment: "vst",
    accountId,
    symbol: candidate.symbol,
    positionId: entryPositionId,
    positionQuantity: "0",
    openOrderCount: 0,
    observedAt: new Date(observedAtMs).toISOString(),
  };
  return {
    verified: true,
    environment: "vst",
    accountId,
    sourceSignalId: candidate.sourceSignalId,
    symbol: candidate.symbol,
    positionId: entryPositionId,
    entryOrderId: entryId,
    closeOrderId: closeId,
    entryOrder,
    closeOrder,
    entryFill,
    entryPriceCorroboration,
    closeFill,
    fills: [entryFillRow, closeFillRow],
    coverage,
    coverageEndTs,
    ...(archiveWindows?.length ? { archiveWindows } : {}),
    clientIdAttribution,
    flatCheck,
    observedAt: flatCheck.observedAt,
    observedAtMs,
    nowMs,
    freshPositions,
    freshOpenOrders,
  };
}

export function deriveVstExchangeClientOrderId(clientOrderId) {
  if (typeof clientOrderId !== "string" || clientOrderId.trim() === "") {
    fail("client_order_id_invalid");
  }
  return `vst-${createHash("sha256").update(clientOrderId).digest("hex").slice(0, 28)}`;
}