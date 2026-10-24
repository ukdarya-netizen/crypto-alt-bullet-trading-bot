import { createHash } from "node:crypto";

const VST_TICK_BLOCKED_AFTER_MS = 2 * 60_000;
const VST_TICK_ALERT_REPEAT_MS = 30 * 60_000;

const SAFE_ERROR_CLASS_NAMES = new Set([
  "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError",
  "BingXLiveApiError", "BingXApiError", "BulletPositionSyncError",
]);
const SAFE_ERROR_MESSAGES = new Map([
  ["Unsupported VST policy version or pattern",
    "Unsupported VST policy version or pattern"],
  ["VST policy must be open", "VST policy must be open"],
  ["VST policy requires a fresh confirmed LONG market signal",
    "VST policy requires a fresh confirmed LONG market signal"],
  ["VST mark is not corroborated by a fresh quote",
    "VST mark is not corroborated by a fresh quote"],
]);
const SAFE_BINGX_ERROR_CODES = new Set(["100410", "109400", "109418", "109500"]);
const ERROR_FINGERPRINT_LENGTH = 12;
const MAX_ERROR_FINGERPRINT_INPUT_LENGTH = 2_048;
const SAFE_TICK_ERROR_SUMMARY_RE =
  /^(?:Error|TypeError|RangeError|ReferenceError|SyntaxError|BingXLiveApiError|BingXApiError|BulletPositionSyncError): (?:Unsupported VST policy version or pattern|VST policy must be open|VST policy requires a fresh confirmed LONG market signal|VST mark is not corroborated by a fresh quote|BingX error code (?:100410|109400|109418|109500)|Details withheld) \[ref:[a-f0-9]{12}\]$/;

function safeErrorClass(error) {
  if (!(error instanceof Error)) return "Error";
  return SAFE_ERROR_CLASS_NAMES.has(error.name) ? error.name : "Error";
}

function numericBingXErrorCode(code) {
  const text = typeof code === "number" && Number.isSafeInteger(code)
    ? String(code)
    : typeof code === "string" && /^\d{1,6}$/.test(code) ? code : null;
  return text && SAFE_BINGX_ERROR_CODES.has(text) ? text : null;
}

function errorFingerprint(error) {
  const name = typeof error?.name === "string" ? error.name : "";
  const message = typeof error?.message === "string" ? error.message : "";
  const code = typeof error?.code === "string" || typeof error?.code === "number"
    ? error.code : "";
  const input = JSON.stringify([name, code, message])
    .slice(0, MAX_ERROR_FINGERPRINT_INPUT_LENGTH);
  return createHash("sha256").update(input).digest("hex")
    .slice(0, ERROR_FINGERPRINT_LENGTH);
}

export function safeTickErrorSummary(error) {
  const errorClass = safeErrorClass(error);
  const message = typeof error?.message === "string" ? error.message : "";
  const reviewedMessage = SAFE_ERROR_MESSAGES.get(message);
  const code = numericBingXErrorCode(error?.code);
  const publicDetail = reviewedMessage ??
    (code ? `BingX error code ${code}` : "Details withheld");
  return `${errorClass}: ${publicDetail} [ref:${errorFingerprint(error)}]`;
}

export function isSafeTickErrorSummary(summary) {
  return typeof summary === "string" &&
    SAFE_TICK_ERROR_SUMMARY_RE.test(summary);
}

// Observe an in-flight tick without ever ending it or releasing the
// single-flight guard. A stalled tick cannot safely be followed by a
// second, concurrent trading tick.
export function createVstTickLivenessWatchdog({
  blockedAlerter,
  now = Date.now,
  blockedAfterMs = VST_TICK_BLOCKED_AFTER_MS,
  repeatAfterMs = VST_TICK_ALERT_REPEAT_MS,
  diagnoseError,
  onAlertError = (error) => {
    process.stderr.write(`Bullet VST blocked-alert failed: ${safeTickErrorSummary(error)}\n`);
  },
} = {}) {
  let inFlightSince = null;
  let lastAlertAt = null;
  const lastErrorAlertAt = new Map();
  const maxRememberedErrors = 100;

  return {
    begin() {
      inFlightSince = now();
    },
    complete() {
      inFlightSince = null;
    },
    reportError(error) {
      if (!blockedAlerter) return false;
      let diagnosticRef;
      try { diagnosticRef = diagnoseError?.(error)?.ref; } catch {}
      const errorSummary = safeTickErrorSummary(error);
      const checkedAt = now();
      const lastSentAt = lastErrorAlertAt.get(errorSummary);
      if (lastSentAt !== undefined && checkedAt - lastSentAt < repeatAfterMs) {
        return false;
      }

      // This throttle is independent of stalled-cycle alerts: one recurring
      // error cannot suppress either a different error or a slow-cycle alert.
      lastErrorAlertAt.delete(errorSummary);
      lastErrorAlertAt.set(errorSummary, checkedAt);
      if (lastErrorAlertAt.size > maxRememberedErrors) {
        lastErrorAlertAt.delete(lastErrorAlertAt.keys().next().value);
      }
      void Promise.resolve().then(() => blockedAlerter.send({
        reason: "vst_worker_error",
        errorSummary,
        ...(typeof diagnosticRef === "string" && /^[a-f0-9]{12}$/.test(diagnosticRef)
          ? { diagnosticRef } : {}),
      })).catch(onAlertError);
      return true;
    },
    check() {
      if (inFlightSince === null || !blockedAlerter) return false;
      const checkedAt = now();
      const blockedForMs = checkedAt - inFlightSince;
      if (blockedForMs < blockedAfterMs ||
          (lastAlertAt !== null && checkedAt - lastAlertAt < repeatAfterMs)) {
        return false;
      }

      lastAlertAt = checkedAt;
      void blockedAlerter.send({
        reason: "vst_worker_tick_stalled",
        blockedForMs,
      }).catch(onAlertError);
      return true;
    },
  };
}