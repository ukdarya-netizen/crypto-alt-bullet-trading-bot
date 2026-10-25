// Read-only observations, not authorization to trade or proof of global absence.
// Only objects built here may enter logs; never serialize an exchange payload.
const reviewed = new WeakSet();
const enums = {
  type: new Set(["STOP_MARKET", "STOP", "MARKET", "LIMIT", "TAKE_PROFIT_MARKET"]),
  status: new Set(["NEW", "PENDING", "FILLED", "PARTIALLY_FILLED", "CANCELED",
    "CANCELLED", "REJECTED", "EXPIRED"]),
  side: new Set(["SELL", "BUY"]),
  positionSide: new Set(["LONG", "SHORT", "BOTH"]),
  workingType: new Set(["MARK_PRICE", "CONTRACT_PRICE", "LAST_PRICE"]),
};
function field(value, key) {
  try { return value?.[key]; } catch { return undefined; }
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function finish(value) {
  freeze(value);
  reviewed.add(value);
  return value;
}
function id(value) {
  return typeof value === "string" && /^\d{1,40}$/.test(value) ? value : undefined;
}
function decimal(value) {
  const text = typeof value === "number" && Number.isFinite(value)
    ? String(value) : value;
  return typeof text === "string" && text.length <= 64 &&
    /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d{1,3})?$/.test(text) &&
    Number.isFinite(Number(text)) ? text : undefined;
}
function symbol(value) {
  return typeof value === "string" && /^[A-Z0-9]{1,24}-?USDT$/.test(value)
    ? value : undefined;
}
function safeRecord(raw) {
  const out = {};
  for (const key of ["orderId", "positionId"]) {
    const value = id(field(raw, key));
    if (value !== undefined) out[key] = value;
  }
  for (const key of ["quantity", "stopPrice"]) {
    const value = decimal(field(raw, key));
    if (value !== undefined) out[key] = value;
  }
  const name = symbol(field(raw, "symbol"));
  if (name) out.symbol = name;
  for (const [key, allowed] of Object.entries(enums)) {
    const value = field(raw, key);
    if (allowed.has(value)) out[key] = value;
  }
  return out;
}
function tryRead(reader, raw) {
  try { return reader(raw); } catch { return undefined; }
}

export function reviewedVstStopEvidence(value) {
  try { return reviewed.has(value) ? value : undefined; } catch { return undefined; }
}

export function buildVstStopEvidence(input = {}) {
  try {
    const row = field(input, "row");
    const orders = field(input, "orders");
    const source = field(input, "source");
    const base = {
      source: ["symbol_open_orders", "account_open_orders_filtered",
        "broker_snapshot"].includes(source) ? source : "symbol_open_orders",
      coverage: "returned_open_orders_only",
    };
    if (!Array.isArray(orders)) {
      return finish({ ...base, readStatus: field(input, "readFailed") === true
        ? "failed" : "invalid", verdict: "cannot_determine_presence" });
    }
    const readId = field(input, "readOrderId") ??
      ((item) => field(item, "orderId") ?? field(item, "orderID"));
    const readPositionId = field(input, "readPositionId") ??
      ((item) => field(item, "positionId") ?? field(item, "positionID"));
    const compare = field(input, "compareDecimal") ??
      ((left, right) => Number.isFinite(Number(left)) &&
        Number.isFinite(Number(right)) && Number(left) === Number(right));
    const amount = field(row, "positionAmt");
    const positionPresent = !!row && Number.isFinite(Number(amount)) && Number(amount) > 0;
    const position = tryRead(readPositionId, row);
    const rawSymbol = field(input, "symbol");
    const name = typeof rawSymbol === "string"
      ? rawSymbol.replace(/USDT$/, "-USDT").replace("--", "-") : undefined;
    const active = orders.filter((item) => field(item, "type") === "STOP_MARKET" &&
      field(item, "status") === "NEW" && field(item, "side") === "SELL" &&
      field(item, "positionSide") === "LONG");
    const expected = field(input, "expectedStops");
    const legs = [];
    for (const tranche of ["core", "runner", "original"]) {
      const supplied = field(expected, tranche);
      if (!supplied) continue;
      const specification = typeof supplied === "string" ? { orderId: supplied } : supplied;
      const wanted = {
        symbol: name, positionId: position, type: "STOP_MARKET", status: "NEW",
        side: "SELL", positionSide: "LONG",
        orderId: field(specification, "orderId"),
        quantity: field(specification, "quantity"),
        stopPrice: field(specification, "stopPrice"),
        ...(field(input, "requireMarkPrice") === true ? { workingType: "MARK_PRICE" } : {}),
      };
      const exact = wanted.orderId === undefined ? active : orders.filter((item) =>
        tryRead(readId, item) === wanted.orderId);
      const candidates = exact.length > 0 ? exact : active.length > 0 ? active : orders;
      const observations = candidates.slice(0, 3).map((item) => {
        const actual = {
          symbol: field(item, "symbol"), orderId: tryRead(readId, item),
          positionId: tryRead(readPositionId, item),
          quantity: field(item, "origQty") ?? field(item, "quantity"),
          stopPrice: field(item, "stopPrice"),
          ...Object.fromEntries(Object.keys(enums).map((key) => [key, field(item, key)])),
        };
        const checks = {};
        for (const key of ["symbol", "orderId", "positionId", "quantity",
          "stopPrice", ...Object.keys(enums)]) {
          if (wanted[key] === undefined) continue;
          const match = actual[key] === undefined ? undefined :
            ["quantity", "stopPrice"].includes(key)
              ? tryRead(() => compare(actual[key], wanted[key]), null)
              : actual[key] === wanted[key];
          checks[key] = typeof match === "boolean" ? match : "unreadable";
        }
        const actualSafe = safeRecord(actual);
        return { actual: actualSafe, checks,
          actualValueStates: Object.fromEntries(Object.keys(checks).map((key) => [
            key, actual[key] === undefined ? "missing_or_unreadable"
              : actual[key] === null ? "null"
              : actualSafe[key] === undefined ? "invalid_or_redacted" : "available",
          ])),
          failedChecks: Object.keys(checks).filter((key) => checks[key] !== true) };
      });
      legs.push({
        tranche, expected: safeRecord(wanted),
        presence: exact.length === 0 ? "not_found_in_response" : "present_in_response",
        matchingIdentityCount: exact.length,
        candidatesShown: observations.length, candidateCount: candidates.length,
        observations,
      });
    }
    const verifiedCount = ["core", "runner"].filter((leg) =>
      field(field(input, "verifiedStops"), leg)?.verified === true).length;
    const originalVerified = !!field(input, "verifiedOriginalStop");
    const expectedOrderCount = field(input, "expectedOpenOrderCount");
    const orderCountMismatch = Number.isSafeInteger(expectedOrderCount) &&
      expectedOrderCount >= 0 && orders.length !== expectedOrderCount;
    const mismatch = legs.some((leg) => leg.presence === "present_in_response" &&
      leg.observations.some((observation) => observation.failedChecks.length > 0));
    const missing = legs.some((leg) => leg.presence === "not_found_in_response");
    const ambiguous = legs.some((leg) => leg.matchingIdentityCount > 1);
    return finish({
      ...base, readStatus: "succeeded", positionPresent,
      ...(id(position) ? { positionId: id(position) } : {}),
      ...(decimal(amount) !== undefined ? { positionQuantity: decimal(amount) } : {}),
      openOrderCount: orders.length, activeLongStopCount: active.length,
      ...(Number.isSafeInteger(expectedOrderCount) && expectedOrderCount >= 0
        ? { expectedOpenOrderCount: expectedOrderCount,
          openOrderCountMatches: !orderCountMismatch } : {}),
      verifiedStopCount: verifiedCount, originalStopVerified: originalVerified,
      verdict: !positionPresent ? "position_not_present_in_response" :
        originalVerified && verifiedCount === 0 &&
          legs.every((leg) => leg.tranche === "original") &&
          !missing && !mismatch && !ambiguous && !orderCountMismatch ? "original_stop_verified" :
        verifiedCount > 0 && !missing && !mismatch &&
          !ambiguous && !orderCountMismatch ? "stop_verified" :
        ambiguous ? "multiple_candidate_orders" :
        missing ? "expected_stop_not_found_in_response" :
        mismatch ? "stop_fields_mismatch" :
        orderCountMismatch ? "unexpected_open_order_count" : "stop_not_bound_to_expected_leg",
      expectedStops: legs,
    });
  } catch {
    return finish({ source: "broker_snapshot", coverage: "returned_open_orders_only",
      readStatus: "invalid", verdict: "cannot_determine_presence" });
  }
}

// These labels are the actual worker checks, not arbitrary field names or values.
export function buildVstPositionCheckEvidence(checks) {
  const labels = {
    positionVerified: "boolean", symbol: "symbol", side: "side",
    leverage: "decimal", marginMode: "marginMode", positionId: "id", quantity: "decimal",
    coreVerified: "boolean", coreOrderId: "id", corePositionId: "id", coreStopPrice: "decimal",
    coreExactQuantity: "decimal", runnerExactQuantity: "decimal",
    coreQuantity: "decimal", runnerVerified: "boolean", runnerStopPrice: "decimal",
    runnerQuantity: "decimal", runnerOrderId: "id", runnerPositionId: "id",
  };
  const safeValue = (value, kind) => {
    if (kind === "decimal") return decimal(value);
    if (kind === "id") return id(value);
    if (kind === "symbol") return symbol(value);
    if (kind === "boolean") return typeof value === "boolean" ? value : undefined;
    if (kind === "side") return ["Buy", "Sell"].includes(value) ? value : undefined;
    return ["ISOLATED", "CROSS", "CROSSED"].includes(value) ? value : undefined;
  };
  const observations = [];
  for (const [label, kind] of Object.entries(labels)) {
    const check = field(checks, label);
    if (!check) continue;
    const expected = safeValue(field(check, "expected"), kind);
    const actual = safeValue(field(check, "actual"), kind);
    const matches = field(check, "matches");
    observations.push({
      field: label, matches: typeof matches === "boolean" ? matches : "unreadable",
      ...(expected !== undefined ? { expected } : {}),
      ...(actual !== undefined ? { actual } : {}),
      expectedState: field(check, "expected") === undefined ? "missing_or_unreadable"
        : expected === undefined ? "invalid_or_redacted" : "available",
      actualState: field(check, "actual") === undefined ? "missing_or_unreadable"
        : actual === undefined ? "invalid_or_redacted" : "available",
    });
  }
  return finish({ source: "worker_position_check", readStatus: "succeeded",
    coverage: "broker_snapshot_only", verdict: "position_checks_failed",
    checks: observations,
    failedChecks: observations.filter((check) => check.matches !== true)
      .map((check) => check.field) });
}