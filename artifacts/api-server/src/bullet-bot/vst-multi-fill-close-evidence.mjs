import { createHash } from "node:crypto";

const SYMBOL_PATTERN = /^[A-Z0-9]{1,20}USDT$/;
const MAX_AGE = 30_000;
const FUTURE_TOLERANCE = 2_000;

function fail(reason) {
  throw new Error(`vst_historical_close_${reason}`);
}

function id(value, label) {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  fail(`${label}_invalid`);
}

function idAliases(row, keys, label, required = true) {
  const values = keys.filter((key) => row?.[key] !== undefined && row[key] !== null)
    .map((key) => id(row[key], label));
  if (values.length === 0 && !required) return null;
  if (values.length === 0 || new Set(values).size !== 1) fail(`${label}_invalid`);
  return values[0];
}

function triggerOrderId(row, label) {
  const values = ["triggerOrderId", "triggerOrderID"]
    .filter((key) => row?.[key] !== undefined && row[key] !== null)
    .map((key) => id(row[key], label));
  if (values.length === 0) return null;
  if (new Set(values).size !== 1) fail(`${label}_invalid`);
  return values[0] === "0" ? null : values[0];
}

function orderId(row, label) {
  return idAliases(row, ["orderId", "orderID"], label);
}

function decimal(value, label, signed = false) {
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (!(signed ? /^[+-]?\d+(?:\.\d+)?$/ : /^\d+(?:\.\d+)?$/).test(text)) {
    fail(`${label}_invalid`);
  }
  const unsigned = text.replace(/^[+-]/, "");
  const [whole, fraction = ""] = unsigned.split(".");
  if (fraction.length > 30) fail(`${label}_invalid`);
  const amount = BigInt(`${whole}${fraction}`) * (text.startsWith("-") ? -1n : 1n);
  if (!signed && amount <= 0n) fail(`${label}_invalid`);
  return { amount, scale: fraction.length, text };
}

function align(a, b) {
  const scale = Math.max(a.scale, b.scale);
  return [a.amount * 10n ** BigInt(scale - a.scale),
    b.amount * 10n ** BigInt(scale - b.scale), scale];
}

function equalDecimal(a, b) {
  const [left, right] = align(a, b);
  return left === right;
}

function addDecimal(a, b) {
  const [left, right, scale] = align(a, b);
  return { amount: left + right, scale };
}

function formatDecimal(value, minScale = 0) {
  let { amount, scale } = value;
  if (scale < minScale) {
    amount *= 10n ** BigInt(minScale - scale);
    scale = minScale;
  }
  const negative = amount < 0n;
  let digits = (negative ? -amount : amount).toString().padStart(scale + 1, "0");
  if (scale) {
    digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, "");
  }
  if (digits === "") digits = "0";
  return `${negative ? "-" : ""}${digits}`;
}

function sum(values) {
  return values.reduce((total, value) => addDecimal(total, value), { amount: 0n, scale: 0 });
}

function omitUndefined(value) {
  if (Array.isArray(value)) return value.map(omitUndefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, omitUndefined(item)]));
  }
  return value;
}

function weightedPrice(rows) {
  const quantityScale = Math.max(...rows.map((row) =>
    decimal(row.quantity, "fill_quantity").scale));
  const priceScale = Math.max(...rows.map((row) =>
    decimal(row.price, "fill_price").scale));
  let numerator = 0n;
  let denominator = 0n;
  for (const row of rows) {
    const qty = decimal(row.quantity, "fill_quantity");
    const price = decimal(row.price, "fill_price");
    const q = qty.amount * 10n ** BigInt(quantityScale - qty.scale);
    const p = price.amount * 10n ** BigInt(priceScale - price.scale);
    numerator += q * p;
    denominator += q;
  }
  const quotient = numerator * 10n ** 24n / denominator;
  return formatDecimal({ amount: quotient, scale: priceScale + 24 });
}

function exactAverageMatches(rows, target) {
  const qtyScale = Math.max(...rows.map((row) => decimal(row.quantity, "fill_quantity").scale));
  const priceScale = Math.max(...rows.map((row) => decimal(row.price, "fill_price").scale));
  let qtyTotal = 0n;
  let valueTotal = 0n;
  for (const row of rows) {
    const qty = decimal(row.quantity, "fill_quantity");
    const price = decimal(row.price, "fill_price");
    const q = qty.amount * 10n ** BigInt(qtyScale - qty.scale);
    const p = price.amount * 10n ** BigInt(priceScale - price.scale);
    qtyTotal += q;
    valueTotal += q * p;
  }
  const average = decimal(target, "stored_entry_price");
  const targetProduct = { amount: qtyTotal * average.amount, scale: qtyScale + average.scale };
  const expectedValue = { amount: valueTotal, scale: qtyScale + priceScale };
  const [expectedValueAligned, targetProductAligned] = align(expectedValue, targetProduct);
  return expectedValueAligned === targetProductAligned;
}

function validateContract(contract, nativeSymbol) {
  if (contract === undefined) return null;
  if (!contract || typeof contract !== "object" || Array.isArray(contract) ||
      contract.symbol !== nativeSymbol ||
      !Number.isInteger(contract.pricePrecision) ||
      contract.pricePrecision < 0 || contract.pricePrecision > 12) {
    fail("contract_price_precision_invalid");
  }
  return contract;
}

function roundedVwapUnits(rows, precision) {
  const quantityScale = Math.max(...rows.map((row) =>
    decimal(row.quantity, "fill_quantity").scale));
  const priceScale = Math.max(...rows.map((row) =>
    decimal(row.price, "fill_price").scale));
  let numerator = 0n;
  let denominator = 0n;
  for (const row of rows) {
    const qty = decimal(row.quantity, "fill_quantity");
    const price = decimal(row.price, "fill_price");
    const q = qty.amount * 10n ** BigInt(quantityScale - qty.scale);
    const p = price.amount * 10n ** BigInt(priceScale - price.scale);
    numerator += q * p;
    denominator += q;
  }
  const scaledNumerator = numerator * 10n ** BigInt(precision);
  const scaledDenominator = denominator * 10n ** BigInt(priceScale);
  let units = scaledNumerator / scaledDenominator;
  if ((scaledNumerator % scaledDenominator) * 2n >= scaledDenominator) units += 1n;
  return units;
}

function averageMatches(rows, target, contract) {
  if (exactAverageMatches(rows, target)) return true;
  if (!contract) return false;
  const parsedTarget = decimal(target, "reported_average_price");
  const precision = Math.max(contract.pricePrecision, parsedTarget.scale);
  const roundedUnits = roundedVwapUnits(rows, precision);
  const reportedUnits = parsedTarget.amount * 10n ** BigInt(precision - parsedTarget.scale);
  return roundedUnits === reportedUnits;
}

function verifyReportedAverage(rows, target, contract, label, orderId) {
  if (!averageMatches(rows, target, contract)) fail(`${label}_price_mismatch`);
  const reported = decimal(target, `${label}_average_price`);
  if (!contract) {
    return {
      orderId,
      reportedAverage: reported.text,
      mode: "exact_rational",
    };
  }
  const precision = Math.max(contract.pricePrecision, reported.scale);
  return {
    orderId,
    reportedAverage: reported.text,
    mode: "contract_precision_nearest_half_up",
    contractPricePrecision: contract.pricePrecision,
    effectivePrecision: precision,
    roundedVwap: formatDecimal({
      amount: roundedVwapUnits(rows, precision),
      scale: precision,
    }),
  };
}

function millis(value) {
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const normalized = number < 100_000_000_000 ? number * 1000 : number;
  return Number.isSafeInteger(normalized) ? normalized : null;
}

function fillTime(fill) {
  const time = millis(fill?.filledTm ?? fill?.filledTime ?? fill?.time ??
    fill?.timestamp ?? fill?.tradeTime);
  if (time === null) fail("fill_timestamp_invalid");
  return time;
}

function orderTime(order, preferUpdate = false) {
  const value = preferUpdate
    ? order?.updateTime ?? order?.time ?? order?.createdAt ?? order?.transactTime ?? order?.timestamp
    : order?.time ?? order?.createdAt ?? order?.transactTime ?? order?.timestamp ?? order?.updateTime;
  const time = millis(value);
  if (time === null) fail("order_timestamp_invalid");
  return time;
}

function quantity(row) {
  const values = ["qty", "quantity", "volume"]
    .filter((key) => row?.[key] !== undefined && row[key] !== null)
    .map((key) => decimal(row[key], "fill_quantity"));
  if (!values.length) fail("fill_quantity_invalid");
  if (values.some((value) => !equalDecimal(value, values[0]))) {
    fail("fill_quantity_alias_mismatch");
  }
  return values[0].text;
}

function fillPrice(row) {
  const values = ["price", "fillPrice", "executionPrice", "avgPrice"]
    .filter((key) => row?.[key] !== undefined && row[key] !== null)
    .map((key) => decimal(row[key], "fill_price"));
  if (!values.length) fail("fill_price_invalid");
  if (values.some((value) => !equalDecimal(value, values[0]))) {
    fail("fill_price_alias_mismatch");
  }
  return values[0].text;
}

function orderAverage(order, label) {
  const values = ["avgPrice", "averagePrice"]
    .filter((key) => order?.[key] !== undefined && order[key] !== null)
    .map((key) => decimal(order[key], `${label}_average_price`));
  if (!values.length) return null;
  if (values.some((value) => !equalDecimal(value, values[0]))) {
    fail(`${label}_average_price_alias_mismatch`);
  }
  return values[0].text;
}

function stopPriceOf(order, label) {
  const values = ["stopPrice", "triggerPrice"]
    .filter((key) => order?.[key] !== undefined && order[key] !== null)
    .map((key) => decimal(order[key], label));
  if (!values.length) fail(`${label}_invalid`);
  if (values.some((value) => !equalDecimal(value, values[0]))) {
    fail(`${label}_alias_mismatch`);
  }
  return values[0];
}

function fillFee(fill, label) {
  if (fill?.commissionAsset !== "VST") fail(`${label}_fee_asset_unknown`);
  const amount = decimal(fill.commission ?? fill.fee ?? fill.commissionAmount ?? fill.feeAmount,
    `${label}_fee`, true);
  return { asset: "VST", amount: formatDecimal(amount) };
}

function clientOrderId(row) {
  return idAliases(row, ["clientOrderId", "clientOrderID"], "client_order_id", false);
}

function deriveClientId(saved) {
  return `vst-${createHash("sha256").update(saved).digest("hex").slice(0, 28)}`;
}

function normalizeFill(fill, label, positionId) {
  const q = String(quantity(fill) ?? "");
  const p = String(fillPrice(fill));
  decimal(q, `${label}_fill_quantity`);
  decimal(p, `${label}_fill_price`);
  const time = fillTime(fill);
  const fee = fillFee(fill, label);
  const result = {
    exchangeFillId: idAliases(fill, ["tradeId", "tradeID"], "fill_trade_id"),
    exchangeOrderId: orderId(fill, "fill_order_id"),
    positionId: idAliases(fill, ["positionId", "positionID"], "fill_position_id", false) ?? positionId,
    quantity: q,
    price: p,
    at: new Date(time).toISOString(),
    fee,
    _time: time,
  };
  if (label === "close") {
    result.realisedPnl = decimal(fill.realisedPNL, "close_realised_pnl", true).text;
    result.realisedPnlAsset = "USDT";
    result.realisedPnlProvenance = "bingx_fill_history.realisedPNL";
  }
  return result;
}

function orderExecuted(order, label) {
  // Deliberately do not infer execution from origQty/requested quantity.
  const values = ["executedQty", "cumExecQty", "filledQty"]
    .filter((key) => order?.[key] !== undefined && order[key] !== null)
    .map((key) => decimal(order[key], `${label}_quantity`));
  if (!values.length) fail(`${label}_quantity_mismatch`);
  if (values.some((value) => !equalDecimal(value, values[0]))) {
    fail(`${label}_quantity_alias_mismatch`);
  }
  return values[0];
}

function validateOriginalQuantity(order, executed, label, status) {
  const values = ["origQty", "quantity"]
    .filter((key) => order?.[key] !== undefined && order[key] !== null)
    .map((key) => decimal(order[key], `${label}_orig_quantity`));
  if (!values.length) return;
  if (values.some((value) => !equalDecimal(value, values[0]))) {
    fail(`${label}_orig_quantity_alias_mismatch`);
  }
  const [original, actual] = align(values[0], executed);
  if (original < actual || status === "FILLED" && original !== actual) {
    fail(`${label}_orig_quantity_mismatch`);
  }
}

function orderPosition(order, label) {
  return idAliases(order, ["positionId", "positionID"], label);
}

function reduceOnly(order) {
  return order?.reduceOnly === true ||
    typeof order?.reduceOnly === "string" && order.reduceOnly.toLowerCase() === "true";
}

function persistedStops(candidate) {
  const request = candidate.closeIntent.request;
  const split = candidate.snapshot.split ?? {};
  const descriptors = [];
  for (const [key, snapshotKey] of [
    ["originalStop", "originalStop"], ["coreStop", "coreStop"], ["runnerStop", "runnerStop"],
  ]) {
    const requested = request[key];
    let saved = split[snapshotKey];
    if (key === "originalStop" && saved === undefined &&
        split.originalStopOrderId !== undefined && split.totalQuantity !== undefined &&
        split.signalStopPrice !== undefined) {
      saved = {
        orderId: split.originalStopOrderId,
        quantity: split.totalQuantity,
        stopPrice: split.signalStopPrice,
      };
    }
    if (requested === undefined && saved === undefined) continue;
    if (!requested || !saved) fail("stop_metadata_incomplete");
    const requestedId = id(requested.orderId, "stop_order_id");
    const savedId = id(saved.orderId, "stop_order_id");
    if (requestedId !== savedId) fail("stop_metadata_mismatch");
    for (const field of ["quantity", "stopPrice"]) {
      if (requested[field] === undefined || saved[field] === undefined ||
          !equalDecimal(decimal(requested[field], `stored_stop_${field}`),
            decimal(saved[field], `snapshot_stop_${field}`))) {
        fail("stop_metadata_mismatch");
      }
    }
    descriptors.push({
      id: requestedId,
      quantity: String(requested.quantity),
      stopPrice: String(requested.stopPrice),
    });
  }
  if (!descriptors.length) fail("stop_metadata_missing");
  if (new Set(descriptors.map((item) => item.id)).size !== descriptors.length) {
    fail("stop_metadata_mismatch");
  }
  return descriptors;
}

function verifyFlatAndCoverage(args, helpers, name, entryTime, lastFillTime) {
  const { freshPositions, freshOpenOrders, observedAtMs, nowMs, coverage } = args;
  if (!Array.isArray(freshPositions) || !Array.isArray(freshOpenOrders) ||
      !Number.isSafeInteger(nowMs) || nowMs <= 0 ||
      !Number.isSafeInteger(observedAtMs) || observedAtMs <= 0 ||
      observedAtMs > nowMs + FUTURE_TOLERANCE || nowMs - observedAtMs > MAX_AGE) {
    fail("flat_read_stale_or_unverified");
  }
  if (freshPositions.some((row) => row?.symbol !== name) ||
      freshOpenOrders.some((row) => row?.symbol !== name)) fail("flat_read_symbol_mismatch");
  if (freshPositions.some((row) => {
    const text = String(row?.positionAmt ?? "");
    if (!/^-?\d+(?:\.\d+)?$/.test(text)) fail("flat_position_read_invalid");
    return decimal(text, "flat_position_quantity", true).amount !== 0n;
  }) || freshOpenOrders.length) fail("symbol_not_flat");
  helpers.assertHistoricalFillCoverage({
    coverage: args.coverage,
    coverageEndTs: args.coverageEndTs,
    fills: args.fills,
    requiredStartBeforeMs: entryTime,
    requiredEndAtLeastMs: lastFillTime,
    freshReadAtMs: observedAtMs,
    nowMs,
    archiveWindows: args.archiveWindows,
    accountId: args.accountId,
  });
}

/**
 * Pure lifecycle v2 validator. It receives only exact read results; the second
 * argument is the historical module's shared strict coverage assertion.
 */
export function verifyVstMultiFillCloseEvidence(args, { assertHistoricalFillCoverage }) {
  const {
    candidate, entryOrder, closeOrders, stopOrders, fills, accountId,
  } = args;
  const ownerReview = candidate?.ownerPreRunnerCloseReview === true;
  if (!ownerReview || !candidate ||
      !(candidate.status === "error" || ["open", "closing", "unknown"].includes(candidate.status)) ||
      candidate.snapshot?.environment !== "vst" || candidate.snapshot?.accountId !== accountId ||
      candidate.snapshot?.symbol !== candidate.symbol ||
      candidate.entryIntent?.sourceSignalId !== candidate.sourceSignalId ||
      candidate.entryIntent?.phase !== "market-entry" ||
      !["failed", "reconciled"].includes(candidate.entryIntent?.state) ||
      candidate.entryIntent?.request?.operation !== "entry" ||
      candidate.entryIntent?.request?.environment !== "vst" ||
      candidate.entryIntent?.request?.accountId !== accountId ||
      candidate.entryIntent?.request?.symbol !== candidate.symbol ||
      candidate.entryIntent?.exchangeOrderId == null ||
      candidate.closeIntent?.state !== "unknown" ||
      candidate.closeIntent?.request?.operation !== "close_pre_runner_split" ||
      candidate.closeIntent?.sourceSignalId !== candidate.sourceSignalId ||
      candidate.closeIntent?.request?.sourceSignalId !== candidate.sourceSignalId ||
      candidate.closeIntent?.request?.environment !== "vst" ||
      candidate.closeIntent?.request?.symbol !== candidate.symbol ||
      candidate.closeIntent?.request?.accountId !== accountId ||
      candidate.closeIntent?.request?.positionId !== candidate.snapshot?.exchangePositionId &&
        candidate.snapshot?.exchangePositionId !== undefined ||
      candidate.closeIntent?.request?.closeIntentId !== candidate.closeIntent?.clientOrderId) {
    fail("candidate_ineligible");
  }
  if (candidate.snapshot.manualResolution || candidate.snapshot.exchangeExternalClose ||
      candidate.snapshot.externalClose) fail("candidate_has_other_attribution");
  if (!Array.isArray(closeOrders) || !Array.isArray(stopOrders) || !Array.isArray(fills)) {
    fail("fills_incomplete_or_foreign");
  }
  if (typeof candidate.symbol !== "string" || !SYMBOL_PATTERN.test(candidate.symbol)) {
    fail("symbol_invalid");
  }
  const name = `${candidate.symbol.slice(0, -4)}-USDT`;
  const contract = validateContract(args.contract, name);
  const priceRoundingComparisons = [];
  const entryId = orderId(entryOrder, "entry_order_id");
  if (entryId !== id(candidate.entryIntent.exchangeOrderId, "entry_order_id")) {
    fail("order_id_mismatch");
  }
  const stored = candidate.snapshot.verifiedFill ??
    (candidate.entryIntent.outcome?.status === "filled" &&
      candidate.entryIntent.outcome?.verified === true
      ? { price: candidate.entryIntent.outcome.fillPrice,
        quantity: candidate.entryIntent.outcome.fillQuantity,
        at: candidate.snapshot.entryAt } : null);
  if (!stored) fail("verified_entry_metadata_missing");
  const recordedQty = decimal(stored.quantity, "stored_entry_quantity");
  const remaining = decimal(candidate.snapshot.remainingQty, "stored_remaining_quantity");
  if (!equalDecimal(recordedQty, remaining)) fail("stored_entry_remaining_quantity_mismatch");
  if (candidate.closeIntent?.request?.totalQuantity === undefined ||
      !equalDecimal(recordedQty,
        decimal(candidate.closeIntent.request.totalQuantity, "close_intent_quantity")) ||
      candidate.snapshot.split?.totalQuantity !== undefined &&
        !equalDecimal(recordedQty,
          decimal(candidate.snapshot.split.totalQuantity, "snapshot_split_quantity"))) {
    fail("close_intent_quantity_mismatch");
  }
  const storedAt = millis(stored.at);
  if (storedAt === null || storedAt > args.nowMs + FUTURE_TOLERANCE) {
    fail("stored_entry_timestamp_invalid");
  }
  const entryPositionId = orderPosition(entryOrder, "entry_position_id");
  if (candidate.closeIntent.request.positionId !== entryPositionId) {
    fail("close_intent_position_mismatch");
  }
  if (candidate.snapshot.exchangePositionId !== undefined &&
      candidate.snapshot.exchangePositionId !== entryPositionId) fail("entry_position_id_mismatch");
  if (entryOrder?.symbol !== name || String(entryOrder.status).toUpperCase() !== "FILLED" ||
      String(entryOrder.side).toUpperCase() !== "BUY" ||
      String(entryOrder.positionSide).toUpperCase() !== "LONG" ||
      !["LIMIT", "MARKET"].includes(String(entryOrder.type).toUpperCase()) ||
      candidate.entryIntent.request.entryOrderType !== undefined &&
        String(candidate.entryIntent.request.entryOrderType).toUpperCase() !==
          String(entryOrder.type).toUpperCase()) {
    fail("entry_order_mismatch");
  }
  const entryAt = orderTime(entryOrder);
  const descriptors = persistedStops(candidate);
  if (descriptors.some((item) => {
    const stopQty = decimal(item.quantity, "stored_stop_quantity");
    return align(stopQty, recordedQty)[0] > align(stopQty, recordedQty)[1];
  })) fail("stop_quantity_exceeds_position");
  const queriedStops = new Map();
  for (const parent of stopOrders) {
    if (parent?.symbol !== name) fail("stop_order_symbol_mismatch");
    const pid = orderId(parent, "stop_order_id");
    if (queriedStops.has(pid)) fail("duplicate_stop_order");
    queriedStops.set(pid, parent);
  }
  const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  if ([...queriedStops.keys()].some((pid) => !descriptorById.has(pid))) {
    fail("stop_parent_foreign");
  }
  const stopById = new Map();
  for (const [parentId, parent] of queriedStops) {
    const descriptor = descriptorById.get(parentId);
    const parentPos = orderPosition(parent, "stop_position_id");
    const parentMainId = idAliases(parent, ["mainOrderId", "mainOrderID"], "stop_main_order_id", false);
    const childId = idAliases(parent, ["childOrderId", "childOrderID"], "stop_child_order_id", false);
    const parentStatus = String(parent?.status ?? "").toUpperCase();
    if (!["NEW", "WORKING", "PARTIALLY_FILLED", "ACTIVE", "FILLED", "CANCELED",
      "CANCELLED", "EXPIRED"].includes(parentStatus) ||
        String(parent?.side ?? "").toUpperCase() !== "SELL" ||
        String(parent?.positionSide ?? "").toUpperCase() !== "LONG" ||
        String(parent?.type ?? "").toUpperCase() !== "STOP_MARKET" ||
        String(parent?.workingType ?? "").toUpperCase() !== "MARK_PRICE" ||
        parentMainId !== null && parentMainId !== entryId ||
        !equalDecimal(stopPriceOf(parent, "stop_order_price"),
          decimal(descriptor.stopPrice, "stored_stop_price"))) {
      fail("stop_parent_mismatch");
    }
    if (parentPos !== null && parentPos !== entryPositionId && parentPos !== "0") {
      fail("stop_position_id_mismatch");
    }
    stopById.set(parentId, { descriptor, parent, parentPos, childId, children: [] });
  }

  const allOrders = new Map([[entryId, { order: entryOrder, kind: "entry" }]]);
  const marketClientId = args.expectedCloseExchangeClientOrderId;
  const expectedMarketClientId = deriveClientId(candidate.closeIntent.clientOrderId);
  if (marketClientId !== undefined && marketClientId !== expectedMarketClientId) {
    fail("close_client_order_id_mismatch");
  }
  let marketCount = 0;
  for (const order of closeOrders) {
    if (order?.symbol !== name) fail("close_order_symbol_mismatch");
    const oid = orderId(order, "close_order_id");
    if (oid === entryId || allOrders.has(oid)) fail("duplicate_order_id");
    const type = String(order.type ?? "").toUpperCase();
    const pos = orderPosition(order, "close_position_id");
    const triggerId = triggerOrderId(order, "stop_trigger_order_id");
    const sideOk = String(order.side ?? "").toUpperCase() === "SELL" &&
      String(order.positionSide ?? "").toUpperCase() === "LONG";
    if (!sideOk || pos !== entryPositionId) fail("close_order_mismatch");
    if (type === "MARKET" && triggerId === null) {
      marketCount++;
      if (!reduceOnly(order) || clientOrderId(order) !== expectedMarketClientId) {
        fail("close_order_mismatch");
      }
    } else if (type === "STOP_MARKET" || type === "MARKET") {
      if (triggerId === null) fail("stop_child_mismatch");
      const linked = stopById.get(triggerId);
      const mainId = idAliases(order, ["mainOrderId", "mainOrderID"],
        "close_main_order_id", false);
      const parentId = idAliases(order, ["parentOrderId", "parentOrderID"],
        "close_parent_order_id", false);
      if (!linked || linked.childId !== null && linked.childId !== oid ||
          linked.parentPos === "0" && pos !== entryPositionId ||
          mainId !== null && mainId !== entryId ||
          parentId !== null && parentId !== triggerId ||
          !equalDecimal(stopPriceOf(order, "stop_child_price"),
            decimal(linked.descriptor.stopPrice, "stored_stop_price"))) {
        fail("stop_child_mismatch");
      }
      linked.children.push(order);
    } else {
      fail("close_order_type_mismatch");
    }
    allOrders.set(oid, {
      order,
      kind: type === "MARKET" && triggerId === null ? "market" : "stop",
      triggerId,
    });
  }
  if (marketCount > 1) fail("close_intent_order_ambiguous");
  const allFills = [];
  const tradeIds = new Set();
  const grouped = new Map();
  for (const raw of fills) {
    if (raw?.symbol !== name) fail("fill_symbol_mismatch");
    const trade = idAliases(raw, ["tradeId", "tradeID"], "fill_trade_id");
    if (tradeIds.has(trade)) fail("duplicate_trade_fills");
    tradeIds.add(trade);
    const oid = orderId(raw, "fill_order_id");
    const descriptor = allOrders.get(oid);
    if (!descriptor) fail("fills_do_not_match_owned_orders");
    const rawTrigger = triggerOrderId(raw, "fill_trigger_order_id");
    const hasRawTrigger = raw?.triggerOrderId !== undefined && raw.triggerOrderId !== null ||
      raw?.triggerOrderID !== undefined && raw.triggerOrderID !== null;
    if (hasRawTrigger && rawTrigger !== (descriptor.triggerId ?? null)) {
      fail("fill_trigger_order_mismatch");
    }
    const expectedSide = descriptor.kind === "entry" ? "BUY" : "SELL";
    if (String(raw.side ?? "").toUpperCase() !== expectedSide ||
        String(raw.positionSide ?? "").toUpperCase() !== "LONG") fail("fill_alias_mismatch");
    const fillPosition = idAliases(raw, ["positionId", "positionID"], "fill_position_id", false);
    if (fillPosition !== null && fillPosition !== entryPositionId) fail("fill_position_id_mismatch");
    const normalized = normalizeFill(raw, descriptor.kind === "entry" ? "entry" : "close",
      entryPositionId);
    normalized._raw = raw;
    allFills.push(normalized);
    if (!grouped.has(oid)) grouped.set(oid, []);
    grouped.get(oid).push(normalized);
  }
  if (allFills.some((fill) => fill._time > args.nowMs + FUTURE_TOLERANCE)) {
    fail("fill_timestamp_mismatch");
  }
  const entryFills = grouped.get(entryId) ?? [];
  if (!entryFills.length) fail("entry_fills_missing");
  if (entryFills.some((fill) => fill._time < entryAt - FUTURE_TOLERANCE ||
      fill._time > storedAt + 60_000)) fail("fill_timestamp_mismatch");
  const entryQty = sum(entryFills.map((fill) => decimal(fill.quantity, "entry_fill_quantity")));
  if (!equalDecimal(entryQty, recordedQty)) {
    fail("entry_fill_does_not_match_verified_entry");
  }
  const entryExecuted = orderExecuted(entryOrder, "entry_order");
  validateOriginalQuantity(entryOrder, entryExecuted, "entry_order", "FILLED");
  if (!equalDecimal(entryExecuted, entryQty)) {
    fail("entry_order_quantity_mismatch");
  }
  const entryPrice = weightedPrice(entryFills);
  const entryAverage = orderAverage(entryOrder, "entry_order");
  if (entryAverage === null) fail("entry_order_price_mismatch");
  priceRoundingComparisons.push(verifyReportedAverage(
    entryFills, stored.price, contract, "stored_entry", entryId,
  ));
  priceRoundingComparisons.push(verifyReportedAverage(
    entryFills, entryAverage, contract, "entry_order", entryId,
  ));
  const orderedFills = allFills.slice().sort((a, b) =>
    a._time - b._time ||
    (a.exchangeOrderId === entryId ? -1 : b.exchangeOrderId === entryId ? 1 : 0) ||
    a.exchangeFillId.localeCompare(b.exchangeFillId));
  if (orderedFills[0]?.exchangeOrderId !== entryId) fail("fill_timestamp_mismatch");
  const closeFills = orderedFills.filter((fill) => fill.exchangeOrderId !== entryId);
  if (!closeFills.length || closeFills.some((fill) => fill._time < entryAt)) {
    fail("close_fills_missing_or_early");
  }
  let balance = { amount: 0n, scale: 0 };
  for (const fill of orderedFills) {
    const qty = decimal(fill.quantity, "fill_quantity");
    if (fill.exchangeOrderId === entryId) {
      balance = addDecimal(balance, qty);
    } else {
      if (align(balance, qty)[0] < align(balance, qty)[1]) fail("close_quantity_oversold");
      balance = addDecimal(balance, { amount: -qty.amount, scale: qty.scale });
    }
  }
  if (balance.amount !== 0n) fail("close_quantity_incomplete");
  for (const [oid, { order, kind }] of allOrders) {
    if (kind === "entry") continue;
    const ownFills = grouped.get(oid) ?? [];
    const executed = orderExecuted(order, "close_order");
    const status = String(order.status ?? "").toUpperCase();
    validateOriginalQuantity(order, executed, "close_order", status);
    if (!ownFills.length || !equalDecimal(sum(ownFills.map((fill) =>
      decimal(fill.quantity, "close_fill_quantity"))), executed)) {
      fail("close_order_quantity_mismatch");
    }
    if (!["FILLED", "CANCELED", "CANCELLED", "PARTIALLY_FILLED"].includes(status)) {
      fail("close_order_status_invalid");
    }
    if ((status === "FILLED") && kind === "market" &&
        !equalDecimal(executed, sum(ownFills.map((fill) =>
          decimal(fill.quantity, "close_fill_quantity"))))) fail("close_order_quantity_mismatch");
    const own = grouped.get(oid) ?? [];
    const average = orderAverage(order, "close_order");
    if (average !== null && !exactAverageMatches(own, average)) {
      if (!averageMatches(own, average, contract)) fail("close_order_price_mismatch");
    }
    if (average !== null) {
      priceRoundingComparisons.push(verifyReportedAverage(
        own, average, contract, "close_order", oid,
      ));
    }
    const orderAt = orderTime(order);
    const updateAt = orderTime(order, true);
    if (orderAt > args.nowMs + FUTURE_TOLERANCE ||
        updateAt > args.nowMs + FUTURE_TOLERANCE ||
        own.some((fill) => fill._time < orderAt - FUTURE_TOLERANCE ||
          fill._time > updateAt + FUTURE_TOLERANCE)) fail("fill_timestamp_mismatch");
  }
  for (const linked of stopById.values()) {
    for (const child of linked.children) {
      const childFills = grouped.get(orderId(child, "close_order_id")) ?? [];
      if (childFills.length === 0) fail("stop_parent_without_executions");
      if (!equalDecimal(sum(childFills.map((fill) => decimal(fill.quantity, "close_fill_quantity"))),
        decimal(child.executedQty, "stop_child_quantity"))) fail("stop_child_quantity_mismatch");
    }
  }
  for (const [stopId, linked] of stopById) {
    if (linked.children.length === 0) fail("stop_parent_without_executions");
    if (linked.childId !== null &&
        (linked.children.length !== 1 ||
         orderId(linked.children[0], "close_order_id") !== linked.childId)) {
      fail("stop_child_mismatch");
    }
    if (linked.parentPos === "0" && linked.children.length === 0) {
      fail("stop_position_id_mismatch");
    }
    if (linked.children.length) {
      const childQty = sum(linked.children.flatMap((child) =>
        (grouped.get(orderId(child, "close_order_id")) ?? [])
          .map((fill) => decimal(fill.quantity, "close_fill_quantity"))));
      if (align(childQty, decimal(linked.descriptor.quantity, "stored_stop_quantity"))[0] >
          align(childQty, decimal(linked.descriptor.quantity, "stored_stop_quantity"))[1]) {
        fail("stop_child_quantity_exceeds_saved");
      }
      const parentExecKeys = ["executedQty", "cumExecQty", "filledQty"];
      if (parentExecKeys.some((key) => linked.parent[key] !== undefined)) {
        const parentExecuted = orderExecuted(linked.parent, "stop_parent");
        validateOriginalQuantity(linked.parent, parentExecuted, "stop_parent",
          String(linked.parent.status ?? "").toUpperCase());
        if (!equalDecimal(parentExecuted, childQty)) fail("stop_parent_quantity_mismatch");
      }
    }
    // Retain checked association in output without inventing ownership for parent.
    linked.parentId = stopId;
  }
  const entryFeeTotal = sum(entryFills.map((fill) => decimal(fill.fee.amount, "entry_fee", true)));
  const closeFeeTotal = sum(closeFills.map((fill) => decimal(fill.fee.amount, "close_fee", true)));
  const pnlTotal = sum(closeFills.map((fill) => decimal(fill.realisedPnl, "close_realised_pnl", true)));
  const closeQuantity = sum(closeFills.map((fill) => decimal(fill.quantity, "close_fill_quantity")));
  const closePrice = weightedPrice(closeFills);
  const finalFill = closeFills.at(-1);
  const finalOrderId = finalFill.exchangeOrderId;
  const closeOrder = closeOrders.find((order) => orderId(order, "close_order_id") === finalOrderId);
  const lastTime = closeFills.at(-1)._time;
  if (lastTime > args.nowMs + FUTURE_TOLERANCE || orderTime(closeOrder, true) < lastTime - FUTURE_TOLERANCE) {
    fail("fill_timestamp_mismatch");
  }
  if (entryFills.some((fill) => fill._time > lastTime) ||
      closeFills.some((fill) => fill._time > args.nowMs + FUTURE_TOLERANCE)) {
    fail("fill_timestamp_mismatch");
  }
  verifyFlatAndCoverage(args, { assertHistoricalFillCoverage }, name, entryFills[0]._time, lastTime);

  const clean = (fill) => {
    const { _time, _raw, ...result } = fill;
    return result;
  };
  const publicEntryFills = entryFills.map(clean);
  const publicCloseFills = closeFills.map(clean);
  const fee = (amount) => ({ asset: "VST", amount: formatDecimal(amount) });
  const entryFill = {
    exchangeOrderId: entryId,
    positionId: entryPositionId,
    price: entryPrice,
    quantity: formatDecimal(entryQty),
    at: publicEntryFills[0].at,
    fee: fee(entryFeeTotal),
  };
  const closeFill = {
    exchangeOrderId: finalOrderId,
    positionId: entryPositionId,
    price: closePrice,
    quantity: formatDecimal(closeQuantity),
    at: new Date(lastTime).toISOString(),
    fee: fee(closeFeeTotal),
    realisedPnl: formatDecimal(pnlTotal),
    realisedPnlAsset: "USDT",
    realisedPnlProvenance: "bingx_fill_history.realisedPNL",
    lifecycleVersion: 2,
    lifecycleProvenance: "vst_multi_fill_exit_aggregation",
    closeOrderIds: [...new Set(closeFills.map((fill) => fill.exchangeOrderId))],
  };
  const flatCheck = {
    verified: true, environment: "vst", accountId, symbol: candidate.symbol,
    positionId: entryPositionId, positionQuantity: "0", openOrderCount: 0,
    observedAt: new Date(args.observedAtMs).toISOString(),
  };
  return {
    verified: true,
    lifecycleVersion: 2,
    environment: "vst",
    accountId,
    sourceSignalId: candidate.sourceSignalId,
    symbol: candidate.symbol,
    positionId: entryPositionId,
    entryOrderId: entryId,
    closeOrderId: finalOrderId,
    entryOrder: omitUndefined(entryOrder),
    closeOrder: omitUndefined(closeOrder ?? closeOrders.at(-1)),
    entryFill,
    closeFill,
    fills: omitUndefined(fills),
    entryFills: publicEntryFills,
    closeFills: publicCloseFills,
    closeOrders: omitUndefined(closeOrders),
    stopOrders: omitUndefined(stopOrders),
    closeOrderIds: [...new Set(closeFills.map((fill) => fill.exchangeOrderId))],
    coverage: args.coverage,
    coverageEndTs: args.coverageEndTs,
    ...(args.archiveWindows?.length ? { archiveWindows: args.archiveWindows } : {}),
    clientIdAttribution: {
      kind: "derived_close_intent_id",
      savedClientOrderId: candidate.closeIntent.clientOrderId,
      expectedExchangeClientOrderId: expectedMarketClientId,
    },
    flatCheck,
    observedAt: flatCheck.observedAt,
    observedAtMs: args.observedAtMs,
    nowMs: args.nowMs,
    freshPositions: args.freshPositions,
    freshOpenOrders: args.freshOpenOrders,
    ...(contract ? { contract: omitUndefined(contract) } : {}),
    priceRounding: {
      rule: contract ? "nearest_half_up_at_max_contract_precision_and_reported_scale" :
        "exact_rational",
      contractPricePrecision: contract?.pricePrecision ?? null,
      comparisons: priceRoundingComparisons,
    },
  };
}