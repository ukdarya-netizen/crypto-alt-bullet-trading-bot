// Reviewed observations only. No raw payloads, client IDs, account IDs or messages.
const reviewed = new WeakSet();
const sources = new Set(["triggered_stop_proof", "order_reconciliation_proof",
  "split_preflight", "historical_close_proof", "broker_position_rows", "broker_validation"]);
const validationFields = new Set([
  "position_quantity", "position_amount", "position_id", "order_id",
  "position_margin", "stop_price", "stop_quantity", "mark_price", "fill_id",
  "fill_price", "fill_quantity", "executed_quantity", "requested_quantity",
  "entry_quantity", "entry_fill_quantity", "entry_expected_quantity", "entry_position_id",
  "entry_order_id", "entry_executed_quantity", "entry_original_quantity",
  "triggered_stop_quantity", "triggered_previous_quantity", "triggered_stop_price",
  "triggered_order_stop_price", "triggered_order_quantity", "triggered_stop_position_identity",
  "triggered_stop_parent_identity", "triggered_child_order_quantity",
  "triggered_child_position_identity", "triggered_child_parent_identity",
  "triggered_child_stop_price", "triggered_fill_quantity", "triggered_fill_price",
  "triggered_fill_fee", "triggered_position_quantity", "triggered_open_stop_quantity",
  "triggered_open_stop_price", "triggered_expected_open_stop_quantity",
  "triggered_expected_open_stop_price", "triggered_open_stop_parent_id",
  "position_average_price", "protective_stop_quantity", "protective_stop_price",
  "stop_executed_quantity", "stop_parent_order_id", "original_stop_order_id",
  "original_stop_snapshot_id", "original_stop_snapshot_position_id",
  "original_stop_snapshot_quantity", "original_stop_snapshot_price",
  "original_stop_quantity", "original_stop_price", "current_position_quantity",
  "expected_remaining_quantity", "impulse_active_position_quantity",
  "impulse_protective_stop_price", "impulse_protective_stop_quantity",
  "impulse_stop_parent_id", "survivor_expected_price", "survivor_expected_quantity",
  "survivor_stop_price", "survivor_stop_quantity", "survivor_stop_executed",
]);
for (const tranche of ["core", "runner"]) {
  for (const suffix of ["persisted_stop_price", "persisted_stop_quantity",
    "snapshot_position_id", "snapshot_stop_id", "snapshot_stop_quantity",
    "snapshot_stop_price", "stop_quantity", "quantity", "stop_price",
    "expected_stop_price", "stop_order_id"]) {
    validationFields.add(`${tranche}_${suffix}`);
  }
  for (const suffix of ["stop_quantity", "stop_price"]) {
    validationFields.add(`pre_runner_split_${tranche}_${suffix}`);
  }
}
const conditions = new Set([
  "request_identity", "quantity_bounds", "clock", "queried_stop_fields",
  "child_identity", "stop_details", "order_quantity", "fill_trigger_aliases",
  "linked_fill_count", "linked_fill_identity", "child_order_fields", "child_quantity",
  "child_details", "fill_quantity_presence", "fill_quantity_aliases",
  "fill_price_presence", "fill_price_aliases", "fill_quantity", "fill_fee_fields",
  "fill_fee_aliases", "fill_time", "nonnegative_position", "flat_after_stop",
  "residual_presence", "residual_identity_quantity", "surviving_stop_count",
  "surviving_stop_fields", "surviving_stop_execution", "surviving_stop_identity_set",
  "read_or_validation_exception", "history_window", "history_found", "order_fields",
  "fills_shape", "terminal_without_fill", "fill_summary", "fill_totals",
  "position_shape", "entry_position", "entry_protection", "close_residual",
  "split_preflight", "historical_close_probe", "decimal_validation",
  "identifier_validation", "identifier_aliases", "position_rows",
]);
const kinds = {};
for (const name of [
  "positionValid", "stopFactsValid", "openOrderIdsMatch", "accountMatches",
  "environmentMatches", "originalStopVerified", "coreVerified", "runnerVerified",
  "positionVerified", "positionIdPresent", "stopOrderIdPresent", "startTimeValid",
  "queryCapability", "clockValid", "orderFound", "fillsBounded", "positionsArray",
  "ordersArray", "childIdentityValid", "childDiffersFromStop", "parentIdsMatch",
  "positionIdsMatch", "positionAliasesAgree", "parentAliasesAgree", "triggerAliasesAgree",
  "childIdsMatch", "childFillUnique", "quantityAliasesAgree", "priceAliasesAgree",
  "feeAliasesAgree", "feeAssetAliasesAgree", "feeAssetsValid", "timesAgree",
  "fillWithinWindow", "stopIsNotTriggeredOrder", "stopIdUnique", "expectedStopFound",
  "executionZero", "allExpectedStopsFound", "historyWindowAvailable", "historyFound",
  "orderTypeValid", "fillIdentitiesMatch", "fillSummaryPresent", "fillFeePresent",
  "sourceSnapshotValid", "numericValid", "identifierPresent", "identifierAliasesAgree",
  "entryPriceWithinTick", "evidenceVerified", "sourceSignalIdPresent", "clientOrderIdMatches",
  "pricePrecisionValid", "shortPositionPresent", "invalidPositionQuantityPresent",
]) kinds[name] = "boolean";
for (const name of [
  "leverage", "quantity", "positionQuantity", "remainingQuantity", "previousQuantity",
  "coreQuantity", "runnerQuantity", "coreStopPrice", "runnerStopPrice",
  "originalStopQuantity", "originalStopPrice", "openOrderCount", "expectedOpenOrderCount",
  "stopQuantity", "stopPrice", "orderQuantity", "filledQuantity", "executedQuantity",
  "requestedQuantity", "fillPrice", "fillFee", "positionAveragePrice",
  "fillCount", "linkedFillCount", "activePositionCount", "rowIndex", "startTime",
  "endTime", "clockTime", "numericValue", "identityCount", "quantityAliasCount",
  "priceAliasCount", "feeAliasCount", "feeAssetAliasCount", "timeAliasCount",
  "historyCount", "matchingHistoryCount",
  "matchingPositionCount", "pricePrecision",
]) kinds[name] = "decimal";
for (const name of [
  "positionId", "orderId", "coreOrderId", "corePositionId", "runnerOrderId",
  "runnerPositionId", "originalOrderId", "originalPositionId", "childOrderId",
  "parentOrderId", "stopOrderId", "fillOrderId", "identifierValue",
]) kinds[name] = "id";
for (const name of ["currentOrderIds", "expectedOrderIds", "positionIds",
  "parentOrderIds", "identifierAliases"]) kinds[name] = "idList";
for (const name of ["quantityValues", "priceValues", "feeValues", "fillTimes"]) kinds[name] = "decimalList";
for (const name of ["symbol", "fillSymbol"]) kinds[name] = "symbol";
const enums = {
  side: ["Buy", "Sell", "BUY", "SELL"],
  positionSide: ["LONG", "SHORT", "BOTH"],
  marginMode: ["ISOLATED", "CROSS", "CROSSED"],
  orderStatus: ["NEW", "FILLED", "PENDING", "PARTIALLY_FILLED", "CANCELED",
    "CANCELLED", "REJECTED", "EXPIRED"],
  orderType: ["MARKET", "LIMIT", "STOP", "STOP_MARKET", "TAKE_PROFIT_MARKET"],
  workingType: ["MARK_PRICE", "CONTRACT_PRICE", "LAST_PRICE"],
  timeInForce: ["FOK", "IOC", "GTC", "POST_ONLY"],
  quantityAlias: ["origQty", "quantity", "executedQty", "cumExecQty", "filledQty"],
  numericRequirement: ["positive_decimal", "nonnegative_decimal", "signed_decimal",
    "signed_nonzero_decimal"],
  validationRule: ["numeric_format", "not_finite_or_unsafe_number", "nonfinite_or_sign",
    "decimal_scale_exceeds_30", "zero_or_sign", "empty_or_unsafe_identifier"],
};
for (const name of Object.keys(enums)) kinds[name] = "enum";

function field(value, key) {
  try { return value?.[key]; } catch { return undefined; }
}
function valueState(value, kind, name) {
  if (value === undefined) return { state: "missing" };
  if (value === null) return { state: "null" };
  if (kind.endsWith("List")) {
    if (!Array.isArray(value)) return { state: "not_array" };
    const items = value.slice(0, 16).map((item) =>
      valueState(item, kind === "idList" ? "id" : "decimal", name));
    return { state: items.some((item) => item.value === undefined) ? "contains_invalid_or_redacted_values" : "available",
      value: items.map((item) => item.value ?? null),
      itemStates: items.map((item) => item.state), count: value.length };
  }
  if (kind === "boolean") return typeof value === "boolean"
    ? { state: "available", value } : { state: "not_boolean" };
  if (kind === "id") {
    const text = typeof value === "number" && Number.isSafeInteger(value)
      ? String(value) : value;
    return typeof text === "string" && /^\d{1,40}$/.test(text)
      ? { state: "available", value: text } : { state: "invalid_or_redacted_identifier" };
  }
  if (kind === "decimal") {
    const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
    return typeof text === "string" && text.length <= 64 &&
      /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d{1,3})?$/.test(text) && Number.isFinite(Number(text))
      ? { state: "available", value: text } : { state: "not_finite_decimal" };
  }
  if (kind === "symbol") return typeof value === "string" &&
    /^[A-Z0-9]{1,24}-?USDT$/.test(value) ? { state: "available", value }
    : { state: "invalid_or_redacted_symbol" };
  return enums[name]?.includes(value) ? { state: "available", value }
    : { state: "unrecognized_or_redacted_enum" };
}
function finish(value) {
  const freeze = (item) => {
    if (item && typeof item === "object") {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(value);
  reviewed.add(value);
  return value;
}
export function reviewedVstProofEvidence(value) {
  try { return reviewed.has(value) ? value : undefined; } catch { return undefined; }
}
export function buildVstProofEvidence(input = {}) {
  try {
    const source = field(input, "source");
    const condition = field(input, "condition");
    const checks = [];
    for (const [name, kind] of Object.entries(kinds)) {
      const raw = field(field(input, "checks"), name);
      if (!raw) continue;
      const expected = valueState(field(raw, "expected"), kind, name);
      const actual = valueState(field(raw, "actual"), kind, name);
      const matches = field(raw, "matches");
      checks.push({
        field: name, matches: field(raw, "applicable") === false ? "not_applicable"
          : typeof matches === "boolean" ? matches : "unreadable",
        expectedState: expected.state, actualState: actual.state,
        ...(expected.value !== undefined ? { expected: expected.value } : {}),
        ...(actual.value !== undefined ? { actual: actual.value } : {}),
        ...(actual.itemStates ? { actualItemStates: actual.itemStates, actualCount: actual.count } : {}),
        ...(expected.itemStates ? { expectedItemStates: expected.itemStates, expectedCount: expected.count } : {}),
      });
    }
    const failedChecks = checks.filter((check) => check.matches !== true &&
      check.matches !== "not_applicable").map((check) => check.field);
    return finish({
      source: sources.has(source) ? source : "broker_validation",
      coverage: source === "order_reconciliation_proof" || source === "triggered_stop_proof" ||
        source === "historical_close_proof" ? "queried_rows_and_interval_only" : "local_checks_only",
      ...(conditions.has(condition) ? { condition } : {}),
      ...(validationFields.has(field(input, "validationField"))
        ? { validationField: field(input, "validationField") } : {}),
      verdict: checks.length === 0 ? "no_reviewed_values_available"
        : failedChecks.length ? "proof_checks_failed" : "proof_checks_passed",
      checks, failedChecks,
    });
  } catch {
    return finish({ source: "broker_validation", coverage: "local_checks_only",
      verdict: "evidence_inspection_unavailable", checks: [], failedChecks: [] });
  }
}