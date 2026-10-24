import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { safeTickErrorSummary } from "./vst-tick-watchdog.mjs";
import { reviewedVstStopEvidence } from "./vst-stop-evidence.mjs";
import { reviewedVstProofEvidence } from "./vst-proof-evidence.mjs";

// Provider contract-shape monitoring lives separately in vst-contract-drift.mjs.
// Do not attach raw GET bodies to conflicting-intent/error diagnostics.
// This is observability only: no requests, retries, state transitions or trade
// decisions belong here. In particular, never serialize the original error.
const contexts = new AsyncLocalStorage();
const resultDiagnostics = new WeakMap();
const errorDiagnostics = new WeakMap();
const repeats = new Map();
const MAX_KEYS = 256;
const REPEAT_MS = 60_000;
const classes = new Set(["Error", "TypeError", "RangeError", "ReferenceError",
  "SyntaxError", "BingXLiveApiError", "BingXApiError", "BulletPositionSyncError"]);
const stages = new Set(["worker_tick", "bot_runtime", "api_call", "broker_read",
  "sourceExits", "capabilities", "failedEntryRecovery", "reconciliation",
  "accountRead", "positionManagement", "pendingCandidateScan", "entry",
  "position_read", "stop_read", "entry_proof", "notification"]);
const operations = new Set(["entry", "raise_stop", "close_leg", "read_position",
  "read_stop", "read_market_mark", "read_account", "reconcile", "manage_position",
  "source_exit", "cancel_original_stop", "close_pre_runner_split",
  "split_core_stop", "split_runner_stop", "margin_top_up", "notify"]);
const transports = new Set(["pre_transport", "request_transport", "response_read",
  "response_parse", "exchange_response", "transport", "response_json",
  "response_validation", "request", "response", "unknown", "network_request",
  "network_response_read", "pre-sign"]);
const endpoints = new Set([
  "/openApi/swap/v3/user/balance", "/openApi/swap/v2/user/positions",
  "/openApi/swap/v1/positionSide/dual", "/openApi/swap/v2/quote/contracts",
  "/openApi/swap/v1/maintMarginRatio", "/openApi/swap/v2/quote/premiumIndex",
  "/openApi/swap/v2/user/income", "/openApi/swap/v2/user/commissionRate",
  "/openApi/swap/v2/trade/leverage", "/openApi/swap/v2/trade/marginType",
  "/openApi/swap/v2/trade/order", "/openApi/swap/v2/trade/openOrders",
  "/openApi/swap/v2/trade/allOrders", "/openApi/swap/v2/trade/forceOrders",
  "/openApi/swap/v2/trade/allFillOrders", "/openApi/swap/v2/trade/fillHistory",
  "/openApi/swap/v2/trade/positionMargin", "/openApi/swap/v1/positionMargin/history",
]);
const apiMethods = new Set([
  "preflight", "contract", "getRiskTiers", "getFeeRate", "getFunding", "getBalance",
  "getPositions", "getPositionMarginHistory", "getOpenOrders", "getPositionMode",
  "getLeverage", "getMarginType", "placeLong", "placeVstBoundedLong",
  "placeVstOnePercentBoundedLong", "placeVstAutomatedLong", "getVstMarkPrice",
  "placeVstAdditionalLongStop", "upgradeVstLongStop", "placeVstVirtualSplitLongStop",
  "cancelVstAttachedLongStopAfterSplit", "closeVstVirtualSplitTranche",
  "cancelVstSplitStopAfterPartial", "placeVstAutomatedVirtualSplitLongStop",
  "cancelVstAutomatedAttachedLongStopAfterSplit", "closeVstAutomatedSplitTranche",
  "cancelVstAutomatedSplitStopAfterPartial", "cancelVstAutomatedOriginalAfterTriggeredRunner",
  "placeVstAutomatedSplitLegStopUpgrade", "cancelVstAutomatedSplitLegStopUpgrade",
  "closeVstAutomatedSoleSplitLeg", "closeVstAutomatedFullSplitPosition",
  "closeVstAutomatedPreRunnerSplit", "cancelVstAutomatedKnownStopWhenFlat",
  "cancelVstProtectiveStopOnlyWhenFlat", "discoverVstAutomatedLongStop",
  "queryOrder", "queryOrderHistory", "queryFundingSettlements", "queryClosedTradeIncome",
  "queryForcedOrders", "queryFills", "queryCompleteFillHistory",
  "reconcilePositionAndStop", "assessProtectiveStopAmendment", "discoverAttachedStop",
  "auditProtectiveStopCoverage", "canVerifyAttachedProtectionOnEntry",
  "addIsolatedMargin", "addVstIsolatedLongMargin", "closeLong", "emergencyCloseVstLong",
  "setVstLongLeverage10", "setVstLeverage", "setVstIsolatedMarginForFlatSymbol",
  "cancelVstOrder",
]);
const preSignReasons = new Set(["signal_expired", "final_balance_unavailable",
  "final_balance_invalid", "final_preflight_unavailable", "final_preflight_blocked",
  "final_budget_exceeded", "final_quote_unavailable_or_stale", "final_quote_out_of_bounds"]);
const checks = new Set(["entry_parent", "entry_history", "fills", "position_row",
  "position_settings", "protective_stop", "position_binding", "stop_history",
  "ownership", "flatness", "quantity", "market_mark", "account_snapshot"]);
const refusalReasons = new Set(["entry_proof_missing", "entry_proof_unverified",
  "entry_fills_unverified", "entry_history_window_unavailable", "position_unverified",
  "stop_unverified", "position_identity_mismatch", "quantity_mismatch",
  "invalid_response", "exchange_read_unavailable", "position_proof_unverified",
  "stop_proof_unverified", "market_mark_unverified", "account_proof_unverified",
  "worker_unknown", "unclassified_refusal"]);
// Reviewed control-flow refusals, not raw exchange text. Keep source exit
// barriers identifiable even when other symbols continue during this tick.
for (const reason of [
  "source_exit_same_symbol_intent_unresolved",
  "source_exit_waiting_for_entry_reconciliation",
  "source_exit_exact_position_identity_mismatch",
  "source_exit_position_provenance_changed",
  "source_exit_position_has_different_request",
  "source_exit_request_provenance_changed",
  "source_exit_position_not_in_ledger",
  "source_exit_entered_position_ledger_missing",
  "source_exit_position_ledger_unavailable",
  "source_exit_entry_identity_unavailable",
  "source_exit_native_entry_proof_unavailable",
  "source_exit_native_entry_proof_mismatch",
  "source_exit_account_snapshot_not_verified",
  "source_exit_exchange_position_read_not_verified",
  "source_exit_protective_stop_ownership_not_verified",
  "source_exit_known_protective_stop_record_invalid",
  "source_exit_no_known_protective_stops",
  "source_exit_vst_account_not_verified",
  "source_exit_verified_close_capability_unavailable",
  "source_exit_prior_mutation_failed_no_replay",
  "source_exit_waiting_for_tick_mutation_boundary",
  "source_exit_reconciliation_pending",
  "source_review_no_exit",
  "source_control_read_unavailable",
]) refusalReasons.add(reason);
const locations = new Set(["bingx-live-api.mjs", "vst-broker.mjs", "vst-worker.mjs",
  "vst-store.mjs", "bot-runtime.mjs", "vst-impulse-split-state.mjs",
  "vst-active-stop-corroboration.mjs", "bingx-fill-history.mjs",
  "source-position-sync.mjs"]);
const reviewedMessages = new Map([
  ["VST mark is not corroborated by a fresh quote", "market_mark_unverified"],
  ["VST mark became stale while waiting for fresh ticker corroboration", "market_mark_unverified"],
  ["VST mark became stale before use", "market_mark_unverified"],
  ["VST mark or ticker became stale while reading the corroboration pair", "market_mark_unverified"],
  ["VST final quote is stale or invalid", "market_mark_unverified"],
  ["VST protective stop upgrades may only raise the stop", "stop_upgrade_not_increasing"],
  ["bingx_vst_entry_history_fills_unverified", "entry_fills_unverified"],
  ["BingX API credentials are missing", "credentials_unavailable"],
  ["Unsupported BingX API path", "unsupported_api_path"],
  ["VST policy must be open", "policy_not_open"],
  ["Unsupported VST policy version or pattern", "unsupported_policy"],
  ["VST policy requires a fresh confirmed LONG market signal", "signal_unverified"],
]);
const reviewedFields = new Set(["position quantity", "position amount",
  "position margin", "initial margin", "initialMargin", "mark price", "markPrice",
  "entry price", "avgPrice", "average price", "liquidation price",
  "liquidationPrice", "stop price", "stopPrice", "balance", "available margin",
  "total VST balance", "quantity", "price", "long leverage", "longLeverage",
  "funding rate", "fundingRate", "executed quantity", "executedQty",
  "entry_order_id", "entry_position_id", "entry_expected_quantity",
  "entry_executed_quantity", "entry_original_quantity", "entry_fill_quantity",
  "position isolated margin", "VST mark price", "VST ask price", "VST bid price",
  "protective stop price", "available VST margin", "final total VST balance",
  "order ID", "position ID", "maker commission rate", "taker commission rate"]);

function field(object, key) {
  try { return object?.[key]; } catch { return undefined; }
}

function safeContext(input) {
  const out = {};
  for (const [key, allowlist] of [["stage", stages], ["operation", operations],
    ["check", checks], ["apiMethod", apiMethods]]) {
    const value = field(input, key);
    if (allowlist.has(value)) out[key] = value;
  }
  const symbol = field(input, "symbol");
  if (typeof symbol === "string" && /^[A-Z0-9]{1,24}-?USDT$/.test(symbol)) {
    out.symbol = symbol.replace("-USDT", "USDT");
  }
  const signal = field(input, "sourceSignalId");
  if (typeof signal === "string" && /^cab-signal-\d{1,16}$/.test(signal)) {
    out.sourceSignalId = signal;
  }
  const tick = field(input, "tickId");
  if (typeof tick === "string" && /^vst-tick-[a-f0-9-]{1,40}$/.test(tick)) {
    out.tickId = tick;
  }
  return out;
}

function origin(error) {
  const stack = field(error, "stack");
  if (typeof stack !== "string") return undefined;
  for (const line of stack.split("\n").slice(1, 15)) {
    const match = /(?:\/|\\)([a-z0-9-]+\.mjs):(\d{1,6}):(\d{1,6})(?:\)|$)/.exec(line);
    if (match && locations.has(match[1])) {
      return `${match[1]}:${match[2]}:${match[3]}`;
    }
  }
  return undefined;
}

function errorRef(error) {
  try {
    return /\[ref:([a-f0-9]{12})\]$/.exec(safeTickErrorSummary(error))?.[1];
  } catch {
    return createHash("sha256").update("unreadable_error").digest("hex").slice(0, 12);
  }
}

export function withVstDiagnosticContext(context, callback) {
  return contexts.run({ ...contexts.getStore(), ...safeContext(context) }, callback);
}

// Track only method/path, never params, headers, responses, signatures or URLs.
// It describes request context, NOT evidence that transport or a write started.
export function noteVstApiDiagnosticRequest(method, endpoint) {
  try {
    const context = contexts.getStore();
    if (context && ["GET", "POST", "DELETE", "PUT"].includes(method) &&
        endpoints.has(endpoint)) {
      if (context.requestEndpoint && (context.requestEndpoint !== endpoint ||
          context.requestMethod !== method)) {
        context.requestContextAmbiguous = true;
      }
      context.requestMethod = method;
      context.requestEndpoint = endpoint;
    }
  } catch {}
}

function reviewedMarkEvidence(value) {
  if (!Array.isArray(value)) return undefined;
  const predicates = new Set([
    "ticker_timestamp_unavailable", "funding_to_ticker_window_exceeded",
    "mark_below_bid_buffer", "mark_above_ask_buffer",
    "ticker_timestamp_stale", "ticker_timestamp_future", "ticker_timestamp_invalid",
    "funding_timestamp_stale_at_pair_end",
  ]);
  const timestampStatuses = new Set(["missing", "invalid", "stale", "future", "fresh"]);
  const numericFields = [
    "markPrice", "exchangeMarkTimestamp", "fundingResponseReceivedAt",
    "tickerObservedAt", "tickerAgeAtComparisonMs", "fundingToTickerReadAgeMs",
    "bid", "ask", "buffer", "lowerBound", "upperBound", "tickerAgeMs",
    "tickerResponseReceivedAt",
    "fundingRequestStartedAt", "tickerRequestStartedAt",
    "fundingTimestampAgeAtPairEndMs", "fundingAgeAtPairEndMs",
    "tickerAgeAtPairEndMs", "fundingReadAgeAtPairEndMs",
    "tickerReadAgeAtPairEndMs", "readStartSeparationMs",
    "positionMarkPrice", "positionMarkRequestStartedAt",
    "positionMarkResponseReceivedAt", "positionMarkErrorCode",
  ];
  const rows = value.slice(0, 2).flatMap((row) => {
    const predicate = field(row, "predicate");
    if (!predicates.has(predicate)) return [];
    const safe = { predicate };
    const attempt = field(row, "attempt");
    if (attempt === 0 || attempt === 1) safe.attempt = attempt;
    const timestampStatus = field(row, "exchangeTimestampStatus");
    if (timestampStatuses.has(timestampStatus)) safe.exchangeTimestampStatus = timestampStatus;
    const positionMarkStatus = field(row, "positionMarkReadStatus");
    if (["unavailable", "invalid", "expired", "mismatch", "matched", "matched_book"].includes(positionMarkStatus)) {
      safe.positionMarkReadStatus = positionMarkStatus;
    }
    for (const key of numericFields) {
      const number = field(row, key);
      if (typeof number === "number" && Number.isFinite(number)) safe[key] = number;
    }
    return [Object.freeze(safe)];
  });
  return rows.length ? Object.freeze(rows) : undefined;
}

export function buildVstDiagnostic(error, context = {}) {
  const safe = { schemaVersion: 1, ref: errorRef(error),
    ...safeContext(contexts.getStore()), ...safeContext(context) };
  const name = field(error, "name");
  safe.errorClass = classes.has(name) ? name : "Error";
  if (!classes.has(name)) safe.errorClassReviewed = false;
  const method = field(error, "method");
  const endpoint = field(error, "endpoint");
  if (["GET", "POST", "DELETE", "PUT"].includes(method)) safe.method = method;
  // Only the path grammar is allowed, never a hostname, query or signed URL.
  if (endpoints.has(endpoint)) safe.endpoint = endpoint;
  const requestContext = contexts.getStore();
  if (requestContext?.requestContextAmbiguous === true) {
    safe.requestContextAmbiguous = true;
  } else if (endpoints.has(requestContext?.requestEndpoint)) {
    safe.requestEndpoint = requestContext.requestEndpoint;
    safe.requestMethod = requestContext.requestMethod;
  }
  const transport = field(error, "transportStage");
  if (transports.has(transport)) safe.transportStage = transport;
  const status = field(error, "httpStatus");
  if (Number.isInteger(status) && status >= 100 && status <= 599) safe.httpStatus = status;
  const rawCode = field(error, "code");
  if ((typeof rawCode === "number" && Number.isSafeInteger(rawCode) && rawCode >= 0 &&
       rawCode <= 999999) ||
      typeof rawCode === "string" && /^\d{1,6}$/.test(rawCode)) {
    safe.code = String(rawCode);
  }
  const message = field(error, "message");
  safe.reason = reviewedMessages.get(message) ??
    (safe.code !== undefined ? "exchange_provider_error" :
      safe.transportStage ? "exchange_transport_error" : "internal_exception");
  if (typeof message === "string" && message.startsWith("BingX returned ")) {
    safe.reason = "invalid_exchange_response";
    const label = /^BingX returned (?:an? )?(?:invalid(?: or non-lossless)?|non-lossless) (.+)$/.exec(message)?.[1];
    if (reviewedFields.has(label)) safe.validationField = label;
    if (/^BingX returned invalid margin type for [A-Z0-9]{1,20}-USDT$/.test(message)) {
      safe.validationField = "marginType";
    }
  }
  const preSignReason = field(error, "preSignReason");
  if (preSignReasons.has(preSignReason)) safe.preSignReason = preSignReason;
  const provenance = field(error, "mutationProvenance");
  if (field(provenance, "operation") === "cancel_original_stop" &&
      field(provenance, "mutationMethod") === "DELETE" &&
      field(provenance, "mutationEndpoint") === "/openApi/swap/v2/trade/order" &&
      typeof field(provenance, "mutationRequestSent") === "boolean" &&
      ["pre_mutation_read", "mutation_transport_started"].includes(field(provenance, "phase"))) {
    safe.mutationRequestSent = field(provenance, "mutationRequestSent");
    safe.mutationPhase = field(provenance, "phase");
  }
  const provider = field(error, "exchangeMessage");
  if (provider === "timestamp is invalid") safe.providerReason = "timestamp_invalid";
  if (provider === "order not exist") safe.providerReason = "order_not_found";
  if (provider === "position not exist") safe.providerReason = "position_not_found";
  const location = origin(error);
  if (location) safe.origin = location;
  const frames = field(error, "stack");
  if (typeof frames === "string") {
    const callerFrames = frames.split("\n").slice(1, 12).flatMap((line) => {
      const match = /(?:\/|\\)([a-z0-9-]+\.mjs):(\d{1,6}):(\d{1,6})(?:\)|$)/.exec(line);
      return match && locations.has(match[1]) ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
    }).slice(0, 5);
    if (callerFrames.length) safe.callerFrames = callerFrames;
  }
  const stopEvidence = reviewedVstStopEvidence(field(context, "stopEvidence"));
  if (stopEvidence) safe.stopEvidence = stopEvidence;
  const proofEvidence = reviewedVstProofEvidence(field(context, "proofEvidence"));
  if (proofEvidence) safe.proofEvidence = proofEvidence;
  const markEvidence = reviewedMarkEvidence(field(error, "vstMarkEvidence"));
  if (markEvidence) safe.markEvidence = markEvidence;
  return Object.freeze(safe);
}

function emit(diagnostic) {
  try {
    const now = Date.now();
    const key = JSON.stringify([diagnostic.ref, diagnostic.stage,
      diagnostic.operation, diagnostic.apiMethod, diagnostic.symbol, diagnostic.sourceSignalId,
      diagnostic.method, diagnostic.endpoint, diagnostic.stopEvidence, diagnostic.proofEvidence,
      diagnostic.callerFrames]);
    const prior = repeats.get(key);
    if (prior && now >= prior.at && now - prior.at < REPEAT_MS) {
      prior.suppressed += 1;
      return;
    }
    repeats.delete(key);
    repeats.set(key, { at: now, suppressed: 0 });
    if (repeats.size > MAX_KEYS) repeats.delete(repeats.keys().next().value);
    const output = diagnostic.level === "info" ? process.stdout : process.stderr;
    output.write(`Bullet VST diagnostic: ${JSON.stringify({
      at: new Date(now).toISOString(), ...diagnostic,
      ...(prior?.suppressed ? { suppressedRepeats: prior.suppressed } : {}),
    })}\n`);
  } catch {
    // Logging must not alter an exchange result, a trading decision, or a retry.
  }
}

export function recordVstDiagnostic(error, context = {}) {
  try {
    // Preserve the failing API's reviewed context through broker/worker catches.
    // Outer catches do not know which GET in a composite read actually failed.
    const inherited = errorDiagnostics.get(error);
    const diagnostic = Object.freeze({
      ...buildVstDiagnostic(error, context), ...inherited,
      ...safeContext(context),
      // Add outer local checks without replacing the inner API's precise cause.
      ...(!inherited?.proofEvidence && reviewedVstProofEvidence(field(context, "proofEvidence"))
        ? { proofEvidence: reviewedVstProofEvidence(field(context, "proofEvidence")) } : {}),
    });
    if (error && typeof error === "object") errorDiagnostics.set(error, diagnostic);
    emit(diagnostic);
    return diagnostic;
  } catch { return Object.freeze({ schemaVersion: 1, ref: "000000000000",
    errorClass: "Error", reason: "diagnostic_unavailable" }); }
}

// Correlate reviewed read failures, not a provider code, free text, or ref.
// Ref can contain symbol-dependent text and remains a log link only.
export function vstReadIncidentKey(diagnostic, info) {
  if (info?.reason !== "managed_position_read_unavailable" ||
      info?.scope !== "symbol" ||
      !["read_position", "read_market_mark"].includes(info?.operation) ||
      diagnostic?.schemaVersion !== 1 ||
      !/^[a-f0-9]{12}$/.test(diagnostic?.ref ?? "") ||
      typeof info?.symbol !== "string" ||
      !/^[A-Z0-9]{1,24}USDT$/.test(info.symbol) ||
      diagnostic?.symbol !== info.symbol ||
      diagnostic?.errorClassReviewed === false ||
      diagnostic?.stage !== "positionManagement" ||
      !["read_position", "read_market_mark"].includes(diagnostic?.operation) ||
      !["position_row", "market_mark"].includes(diagnostic?.check) ||
      diagnostic?.mutationPhase !== undefined ||
      diagnostic?.requestContextAmbiguous === true) return null;
  const method = diagnostic.method ?? diagnostic.requestMethod;
  const endpoint = diagnostic.endpoint ?? diagnostic.requestEndpoint;
  const readEndpoints = {
    getPositions: "/openApi/swap/v2/user/positions",
    getVstMarkPrice: "/openApi/swap/v2/quote/premiumIndex",
    getLeverage: "/openApi/swap/v2/trade/leverage",
    getMarginType: "/openApi/swap/v2/trade/marginType",
  };
  if (method !== "GET" || !endpoint ||
      readEndpoints[diagnostic.apiMethod] !== endpoint ||
      (diagnostic.requestMethod && diagnostic.requestMethod !== "GET") ||
      (diagnostic.requestEndpoint && diagnostic.requestEndpoint !== endpoint) ||
      !classes.has(diagnostic.errorClass)) return null;
  const readValidationFields = {
    getPositions: new Set(["position quantity", "position amount", "position margin",
      "initial margin", "initialMargin", "mark price", "markPrice", "entry price",
      "avgPrice", "average price", "liquidation price", "liquidationPrice",
      "position isolated margin", "marginType"]),
    getVstMarkPrice: new Set(["mark price", "markPrice", "VST mark price"]),
    getLeverage: new Set(["long leverage", "longLeverage"]),
    getMarginType: new Set(["marginType"]),
  };
  const validation = diagnostic.reason === "invalid_exchange_response" &&
    readValidationFields[diagnostic.apiMethod]?.has(diagnostic.validationField);
  const transport = diagnostic.reason === "exchange_transport_error" &&
    ["network_request", "network_response_read", "request_transport",
      "response_read", "response_parse", "response_json"].includes(diagnostic.transportStage);
  const provider = diagnostic.reason === "exchange_provider_error" &&
    diagnostic.providerReason === "timestamp_invalid";
  if (!validation && !transport && !provider) return null;
  return JSON.stringify(["symbol_read_only", diagnostic.errorClass,
    diagnostic.stage, diagnostic.operation, diagnostic.apiMethod, method,
    endpoint, diagnostic.check, diagnostic.reason,
    diagnostic.validationField ?? null, diagnostic.transportStage ?? null,
    diagnostic.providerReason ?? null, diagnostic.code ?? null,
    diagnostic.httpStatus ?? null]);
}

export function recordVstRefusal(reason, context = {}) {
  const reviewed = refusalReasons.has(reason) ? reason : "unclassified_refusal";
  const stopEvidence = reviewedVstStopEvidence(field(context, "stopEvidence"));
  const proofEvidence = reviewedVstProofEvidence(field(context, "proofEvidence"));
  // A shared refusal helper must not hide the actual branch that called it.
  const callerFrames = new Error().stack?.split("\n").slice(1, 12).flatMap((line) => {
    const match = /(?:\/|\\)([a-z0-9-]+\.mjs):(\d{1,6}):(\d{1,6})(?:\)|$)/.exec(line);
    return match && locations.has(match[1]) ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
  }).slice(0, 5);
  const diagnostic = Object.freeze({
    schemaVersion: 1,
    ref: createHash("sha256").update(JSON.stringify(["VstProofRefusal", reviewed,
      safeContext(context).check ?? ""])).digest("hex").slice(0, 12),
    ...safeContext(contexts.getStore()), ...safeContext(context),
    errorClass: "VstProofRefusal", reason: reviewed,
    ...(stopEvidence ? { stopEvidence } : {}),
    ...(proofEvidence ? { proofEvidence } : {}),
    ...(callerFrames?.length ? { callerFrames } : {}),
  });
  emit(diagnostic);
  return diagnostic;
}

export function recordVstStopObservation(context = {}) {
  const stopEvidence = reviewedVstStopEvidence(field(context, "stopEvidence"));
  if (!stopEvidence) return undefined;
  const diagnostic = Object.freeze({
    schemaVersion: 1,
    ref: createHash("sha256").update(JSON.stringify(["VstStopObservation",
      stopEvidence.verdict])).digest("hex").slice(0, 12),
    ...safeContext(contexts.getStore()), ...safeContext(context),
    errorClass: "VstStopObservation", level: "info",
    reason: stopEvidence.verdict, stopEvidence,
  });
  emit(diagnostic);
  return diagnostic;
}

// Keep observability out of broker DTOs, durable snapshots and replay equality.
export function attachVstResultDiagnostic(result, diagnostic) {
  try {
    if (result !== null && typeof result === "object" &&
        typeof diagnostic?.ref === "string" && /^[a-f0-9]{12}$/.test(diagnostic.ref)) {
      resultDiagnostics.set(result, diagnostic.ref);
    }
  } catch {}
  return result;
}

export function getVstResultDiagnosticRef(result) {
  try { return resultDiagnostics.get(result); } catch { return undefined; }
}

export function instrumentVstApi(api, environment) {
  if (environment !== "vst") return api;
  return Object.fromEntries(Object.entries(api).map(([name, value]) => {
    if (typeof value !== "function") return [name, value];
    return [name, async function (...args) {
      const symbol = typeof args[0] === "string" ? args[0] : field(args[0], "symbol");
      const context = { symbol, apiMethod: name,
        ...(contexts.getStore()?.stage ? {} : { stage: "api_call" }) };
      return withVstDiagnosticContext(context, async () => {
        delete contexts.getStore().requestMethod;
        delete contexts.getStore().requestEndpoint;
        delete contexts.getStore().requestContextAmbiguous;
        try { return await value(...args); }
        catch (error) {
          recordVstDiagnostic(error, context);
          throw error;
        }
      });
    }];
  }));
}