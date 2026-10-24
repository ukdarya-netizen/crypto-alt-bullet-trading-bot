import { buildVstDiagnostic } from "./vst-diagnostics.mjs";
import { classifyVstUncertainty } from "./vst-uncertainty.mjs";

const SAFE_STATES = new Set(["prepared", "submitted", "unknown"]);
const SAFE_METHODS = new Set(["GET", "POST", "DELETE", "PUT"]);
const SAFE_ENDPOINTS = new Set([
  "/openApi/swap/v2/trade/leverage",
  "/openApi/swap/v2/trade/order",
  "/openApi/swap/v2/trade/marginType",
]);
const SAFE_ERROR_CLASSES = new Set([
  "Error", "TypeError", "RangeError", "BingXLiveApiError", "BingXApiError",
]);
const SAFE_OPERATION = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_CLIENT_ORDER_ID = /^vst-[A-Za-z0-9_-]{1,96}$/;
const SAFE_EXCHANGE_ORDER_ID = /^\d{1,32}$/;
const SAFE_SIGNAL_ID = /^cab-signal-\d{1,16}$/;
const SAFE_SYMBOL = /^[A-Z0-9]{1,20}USDT$/;
const SAFE_REF = /^[a-f0-9]{12}$/;

function safeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function pick(value, predicate) {
  return predicate(value) ? value : undefined;
}

function safeOriginalDiagnostic(intent) {
  const outcome = intent?.outcome?.originalSubmissionOutcome ?? intent?.outcome ?? {};
  const persisted = outcome.originalDiagnostic ?? outcome.submissionDiagnostic ?? {};
  const name = pick(outcome.submissionError ?? outcome.error ?? persisted.errorClass,
    (value) => SAFE_ERROR_CLASSES.has(value)) ?? "Error";
  const rawMessage = outcome.submissionErrorMessage ?? outcome.errorMessage ?? persisted.message ??
    (outcome.reason === "bingx_vst_entry_history_fills_unverified"
      ? outcome.reason : "");
  const originalProvenanceAvailable =
    (typeof rawMessage === "string" && rawMessage.length > 0) ||
    SAFE_REF.test(persisted.ref ?? "") ||
    outcome.submissionCode !== undefined || persisted.code !== undefined;
  const error = new Error(typeof rawMessage === "string" ? rawMessage : "");
  error.name = name;
  const method = pick(persisted.method ?? outcome.submissionMethod,
    (value) => SAFE_METHODS.has(value));
  const endpoint = pick(persisted.endpoint ?? outcome.submissionEndpoint,
    (value) => SAFE_ENDPOINTS.has(value));
  const status = persisted.httpStatus ?? outcome.submissionHttpStatus;
  const code = persisted.code ?? outcome.submissionCode;
  if (method) error.method = method;
  if (endpoint) error.endpoint = endpoint;
  if (Number.isInteger(status) && status >= 100 && status <= 599) error.httpStatus = status;
  if ((Number.isSafeInteger(code) && code >= 0 && code <= 999999) ||
      (typeof code === "string" && /^\d{1,6}$/.test(code))) error.code = code;
  const providerMessage = outcome.submissionExchangeMessage ?? persisted.exchangeMessage ??
    (persisted.providerReason === "timestamp_invalid" || Number(code) === 109400
      ? "timestamp is invalid" :
      persisted.providerReason === "order_not_found" ? "order not exist" :
        persisted.providerReason === "position_not_found" || Number(code) === 109421
          ? "order not exist" : undefined);
  if (providerMessage === "timestamp is invalid" ||
      providerMessage === "order not exist" ||
      providerMessage === "position not exist") {
    error.exchangeMessage = providerMessage;
  }
  const recorded = buildVstDiagnostic(error, {
    stage: "reconciliation",
    operation: intent?.request?.operation,
    symbol: intent?.request?.symbol,
    sourceSignalId: intent?.sourceSignalId,
  });
  return {
    errorClass: recorded.errorClass,
    reason: originalProvenanceAvailable
      ? recorded.reason : "submission_provenance_unavailable",
    ...(outcome.reason === "bingx_vst_entry_history_fills_unverified"
      ? { reviewedReason: "bingx_vst_entry_history_fills_unverified" } : {}),
    ...(recorded.code ? { code: recorded.code } : {}),
    ...(recorded.providerReason ? { providerReason: recorded.providerReason } : {}),
    ...(recorded.method ?? recorded.requestMethod
      ? { method: recorded.method ?? recorded.requestMethod } : {}),
    ...(recorded.endpoint ?? recorded.requestEndpoint
      ? { endpoint: recorded.endpoint ?? recorded.requestEndpoint } : {}),
    ...(recorded.httpStatus ? { httpStatus: recorded.httpStatus } : {}),
    ...(recorded.ref ? { ref: recorded.ref } : {}),
    ...(SAFE_REF.test(persisted.ref ?? "")
      ? { persistedRef: persisted.ref } : {}),
  };
}

export function buildVstUnresolvedIntentDiagnostic(intent, {
  symbolUnresolvedCount,
  accountUnresolvedCount,
  recoveryDeferredReason,
  recoveryDeferredDiagnosticRef,
  lastAttemptAt,
  now = Date.now(),
} = {}) {
  const operation = pick(intent?.request?.operation,
    (value) => typeof value === "string" && SAFE_OPERATION.test(value));
  const sourceSignalId = pick(intent?.sourceSignalId,
    (value) => typeof value === "string" && SAFE_SIGNAL_ID.test(value));
  const symbol = pick(intent?.request?.symbol,
    (value) => typeof value === "string" && SAFE_SYMBOL.test(value));
  const phase = pick(intent?.phase,
    (value) => typeof value === "string" && /^[a-z][a-z0-9_-]{0,95}$/.test(value));
  const state = pick(intent?.state, (value) => SAFE_STATES.has(value));
  const clientOrderId = pick(intent?.clientOrderId,
    (value) => typeof value === "string" && SAFE_CLIENT_ORDER_ID.test(value));
  const exchangeOrderId = pick(intent?.exchangeOrderId,
    (value) => typeof value === "string" && SAFE_EXCHANGE_ORDER_ID.test(value));
  const deferred = pick(recoveryDeferredReason,
    (value) => typeof value === "string" && SAFE_OPERATION.test(value));
  const deferredRef = pick(recoveryDeferredDiagnosticRef,
    (value) => typeof value === "string" && SAFE_REF.test(value));
  const attemptAt = safeDate(lastAttemptAt ?? intent?.lastAttemptAt ??
    intent?.outcome?.lastAttemptAt ?? intent?.outcome?.attemptAt);
  const ageMs = attemptAt ? Math.max(0, now - Date.parse(attemptAt)) : undefined;
  const uncertainty = classifyVstUncertainty(intent);
  return {
    kind: "unresolved_vst_action",
    classification: uncertainty.classification,
    mutationAttribution: uncertainty.mutationAttribution,
    safeOutcome: uncertainty.safeOutcome,
    writeRetryAuthorized: false,
    currentReadRefusal: intent?.outcome?.uncertainty?.currentReadRefusal ?? null,
    readAttempts: intent?.outcome?.uncertaintyRead?.totalAttempts ?? 0,
    ...(sourceSignalId ? { sourceSignalId } : {}),
    ...(symbol ? { symbol } : {}),
    ...(operation ? { operation } : {}),
    ...(phase ? { phase } : {}),
    ...(state ? { state } : {}),
    ...(clientOrderId ? { clientOrderId } : {}),
    ...(exchangeOrderId ? { exchangeOrderId } : {}),
    originalDiagnostic: safeOriginalDiagnostic(intent),
    ...(deferred ? { recoveryDeferredReason: deferred } : {}),
    ...(deferredRef ? { recoveryDeferredDiagnosticRef: deferredRef } : {}),
    ...(attemptAt ? { lastAttemptAt: attemptAt, lastAttemptAgeMs: ageMs } : {}),
    symbolUnresolvedCount: Number.isSafeInteger(symbolUnresolvedCount) &&
      symbolUnresolvedCount >= 0 ? symbolUnresolvedCount : 0,
    accountUnresolvedCount: Number.isSafeInteger(accountUnresolvedCount) &&
      accountUnresolvedCount >= 0 ? accountUnresolvedCount : 0,
  };
}

export function unresolvedIntentDiagnosticSignature(diagnostic) {
  const original = diagnostic.originalDiagnostic ?? {};
  return JSON.stringify([
    diagnostic.sourceSignalId, diagnostic.symbol, diagnostic.operation,
    diagnostic.phase, diagnostic.state, diagnostic.clientOrderId,
    diagnostic.exchangeOrderId, original.errorClass, original.reason,
    original.code, original.providerReason, original.method, original.endpoint,
    original.httpStatus, original.persistedRef, original.reviewedReason,
    diagnostic.recoveryDeferredReason, diagnostic.recoveryDeferredDiagnosticRef,
  ]);
}

export function logVstUnresolvedIntentDiagnostic(diagnostic, logger = console) {
  try {
    logger.warn(`Bullet VST unresolved action: ${JSON.stringify(diagnostic)}`);
  } catch {
    // Observability must never interrupt the trading tick.
  }
}

export const isSafeVstClientOrderId = (value) =>
  SAFE_CLIENT_ORDER_ID.test(value ?? "");
export const isSafeVstExchangeOrderId = (value) =>
  SAFE_EXCHANGE_ORDER_ID.test(value ?? "");