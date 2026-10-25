import { validateSourceAction } from "./source-position-control.mjs";
const POSITION_SYNC_URL = "https://crypto-alt-bullet.replit.app/api/trading/position-sync";
const MAX_PAGES = 100;
const MAX_ITEMS = 10_000;
const MAX_AS_OF_AGE_MS = 5 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 30 * 1_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 10_000;
const MAX_RETRY_AFTER_MS = 5 * 60 * 1_000;
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_TRANSPORT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETDOWN", "ENETUNREACH",
  "EHOSTUNREACH", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
]);

export class BulletPositionSyncError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BulletPositionSyncError";
    this.code = code;
    Object.assign(this, details);
  }
}

function withAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("request_timeout"));
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("request_timeout"));
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then((value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

function makeDeadlineSignal(signal, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 ||
      timeoutMs > DEFAULT_TOTAL_TIMEOUT_MS) {
    fail("invalid_timeout", "Position sync timeout must be an integer from 1 to 10000");
  }
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

function fail(code, message) {
  throw new BulletPositionSyncError(code, message);
}

function remainingDeadlineMs(startedAt, timeoutMs) {
  return Math.max(0, timeoutMs - (performance.now() - startedAt));
}

function retryAfterMilliseconds(response, clock) {
  let header;
  try {
    header = response?.headers?.get?.("retry-after");
  } catch {
    return null;
  }
  if (typeof header !== "string" || header.trim() === "") return null;
  const value = header.trim();
  let delay;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    delay = Number(value) * 1_000;
  } else {
    const date = Date.parse(value);
    let nowValue;
    try {
      nowValue = clock();
    } catch {
      return null;
    }
    const now = nowValue instanceof Date ? nowValue.getTime() : Number(nowValue);
    if (!Number.isFinite(date) || !Number.isFinite(now)) return null;
    delay = date - now;
  }
  if (!Number.isFinite(delay) || delay < 0) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.floor(delay));
}

function transportFailureIsTransient(error) {
  const code = typeof error?.code === "string"
    ? error.code
    : typeof error?.cause?.code === "string" ? error.cause.code : "";
  return (!code && error instanceof TypeError) || TRANSIENT_TRANSPORT_CODES.has(code);
}

function withPageDetails(error, pageNumber, attempts, failureStage, httpStatus) {
  if (error instanceof BulletPositionSyncError) {
    if (error.pageNumber === undefined) error.pageNumber = pageNumber;
    if (error.attempts === undefined) error.attempts = attempts;
    if (error.failureStage === undefined) error.failureStage = failureStage;
    if (httpStatus !== undefined && error.httpStatus === undefined) error.httpStatus = httpStatus;
  }
  return error;
}

function parseAsOf(value) {
  if (typeof value !== "string" || value.length === 0) {
    fail("invalid_response", "Position sync response has an invalid asOf timestamp");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    fail("invalid_response", "Position sync response has an invalid asOf timestamp");
  }
  return parsed;
}

function isClockFresh(asOf, clock) {
  const nowValue = clock();
  const now = nowValue instanceof Date ? nowValue.getTime() : Number(nowValue);
  if (!Number.isFinite(now)) {
    fail("invalid_clock", "Position sync clock returned an invalid time");
  }
  if (asOf > now + MAX_FUTURE_SKEW_MS || now - asOf > MAX_AS_OF_AGE_MS) {
    fail("stale_response", "Position sync response is outside the freshness window");
  }
}

function validateCursor(value) {
  if (value === null) return null;
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "string" && value.length === 0) ||
    (typeof value === "number" && !Number.isSafeInteger(value))
  ) {
    fail("invalid_response", "Position sync response has an invalid nextAfterId cursor");
  }
  return value;
}

function cursorProgresses(previous, next) {
  if (previous === null) return true;
  if (typeof previous === "number" && typeof next === "number") return next > previous;

  const previousText = String(previous);
  const nextText = String(next);
  if (/^-?\d+$/.test(previousText) && /^-?\d+$/.test(nextText)) {
    try {
      return BigInt(nextText) > BigInt(previousText);
    } catch {
      return false;
    }
  }
  return nextText > previousText;
}

const POSITION_FIELDS = [
  "sourceSignalId",
  "signalAt",
  "botEnqueuedAt",
  "symbol",
  "initialStopPrice",
  "sourceStatus",
  "sourceAction",
  "sourceUpdatedAt",
  "sourceClosedAt",
  "sourceEntryPrice",
  "sourceExitPrice",
  "sourcePnlPercent",
  "sourcePeakPrice",
  "sourceStopLossPrice",
  "sourceTrailingStopLevel",
  "sourceLastMilestone",
  "sourceCancelReason",
];
const SOURCE_STATUSES = new Set([
  "active",
  "in_run",
  "expired",
  "cancelled",
  "reclassified",
  "profit",
  "stop_loss",
  "bu_stop",
  "breakeven",
  "unknown",
]);
const TERMINAL_STATUSES = new Set(["cancelled", "profit", "stop_loss", "bu_stop"]);

function sourceSignalKey(id) {
  if (typeof id === "string" && id.length > 0) return id;
  if (typeof id === "number" && Number.isSafeInteger(id)) return String(id);
  fail("invalid_response", "Position sync response contains a position with an invalid sourceSignalId");
}

function nullableTimestamp(value, field, required = false) {
  if (value === null && !required) return;
  if (typeof value !== "string" || value.length === 0 || !Number.isFinite(Date.parse(value))) {
    fail("invalid_response", `Position sync response contains an invalid ${field}`);
  }
}

function nullableNumber(value, field, { positive = false } = {}) {
  if (value === null) return null;
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || (positive && parsed <= 0)) {
    fail("invalid_response", `Position sync response contains an invalid ${field}`);
  }
  return parsed;
}

function validatePosition(position) {
  if (position === null || typeof position !== "object" || Array.isArray(position)) {
    fail("invalid_response", "Position sync response contains an invalid position");
  }
  if (POSITION_FIELDS.some((field) => field !== "sourceAction" && !Object.hasOwn(position, field))) {
    fail("invalid_response", "Position sync response is missing source position fields");
  }
  const id = sourceSignalKey(position.sourceSignalId);
  const status = position.sourceStatus;
  // Observed producer contract: a delivered card can have no lifecycle status
  // and explicitly say "unknown". Preserve that null; it is neither inactive
  // nor closed. No other action or unrecognized status gets this exception.
  const explicitUnknownStatus = status === null && position.sourceAction === "unknown";
  if (!SOURCE_STATUSES.has(status) && !explicitUnknownStatus) {
    fail("invalid_source_status", "Position sync response contains an unsupported source status");
  }
  if (typeof position.symbol !== "string" || position.symbol.length === 0) {
    fail("invalid_response", "Position sync response contains an invalid symbol");
  }

  nullableTimestamp(position.signalAt, "signalAt", true);
  nullableTimestamp(position.botEnqueuedAt, "botEnqueuedAt");
  nullableTimestamp(position.sourceUpdatedAt, "sourceUpdatedAt");
  nullableTimestamp(position.sourceClosedAt, "sourceClosedAt");
  for (const field of ["initialStopPrice", "sourceEntryPrice", "sourceExitPrice", "sourcePeakPrice", "sourceStopLossPrice"]) {
    nullableNumber(position[field], field, { positive: true });
  }
  nullableNumber(position.sourcePnlPercent, "sourcePnlPercent");
  nullableNumber(position.sourceTrailingStopLevel, "sourceTrailingStopLevel", { positive: true });
  if (position.sourceLastMilestone !== null &&
      typeof position.sourceLastMilestone !== "string" &&
      typeof position.sourceLastMilestone !== "number") {
    fail("invalid_response", "Position sync response contains an invalid sourceLastMilestone");
  }
  if (position.sourceCancelReason !== null && typeof position.sourceCancelReason !== "string") {
    fail("invalid_response", "Position sync response contains an invalid sourceCancelReason");
  }

  if (Object.hasOwn(position, "sourceAction") && !validateSourceAction(position)) {
    fail("invalid_source_action", "Position sync response contains an inconsistent sourceAction");
  }
  const hasClosure = position.sourceClosedAt !== null &&
    nullableNumber(position.sourceExitPrice, "sourceExitPrice", { positive: true }) !== null &&
    TERMINAL_STATUSES.has(status);
  if (!Object.hasOwn(position, "sourceAction") && TERMINAL_STATUSES.has(status) && !hasClosure) {
    fail("invalid_response", "Terminal source positions require sourceClosedAt and a valid sourceExitPrice");
  }
  return [id, position];
}

function validateEnvelope(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    fail("incomplete_response", "Position sync returned an incomplete response");
  }
  if (!Object.hasOwn(payload, "asOf") || !Object.hasOwn(payload, "nextAfterId") ||
      !Array.isArray(payload.positions)) {
    fail("incomplete_response", "Position sync returned an incomplete response");
  }
  return payload;
}

/**
 * Reads the complete, fresh position snapshot from Bullet. This client never
 * mutates remote positions and deliberately omits unsupported `limit` and
 * `pageSize` query parameters. Returned positions are keyed by sourceSignalId.
 *
 * @param {{
 *   token: string,
 *   fetchImpl?: typeof fetch,
 *   clock?: () => number | Date,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   sleepImpl?: (milliseconds: number, options: { signal: AbortSignal }) => Promise<void>,
 * }} options
 * @returns {Promise<{ asOf: string, positions: Map<string, object> }>}
 */
export async function fetchBulletPositions({
  token,
  fetchImpl = globalThis.fetch,
  clock = Date.now,
  signal,
  timeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  requireSourceAction = false,
} = {}) {
  if (typeof token !== "string" || token.trim().length === 0) {
    fail("invalid_token", "A non-empty trading token is required");
  }
  if (typeof fetchImpl !== "function") {
    fail("fetch_unavailable", "A fetch implementation is required");
  }
  if (typeof clock !== "function") {
    fail("invalid_clock", "Position sync clock must be a function");
  }
  if (typeof sleepImpl !== "function") {
    fail("invalid_sleep", "Position sync sleep implementation must be a function");
  }
  if (signal !== undefined &&
      (typeof signal?.aborted !== "boolean" || typeof signal?.addEventListener !== "function")) {
    fail("invalid_signal", "Position sync signal must be an AbortSignal");
  }
  let deadlineSignal;
  try {
    deadlineSignal = makeDeadlineSignal(signal, timeoutMs);
  } catch (error) {
    if (error instanceof BulletPositionSyncError) throw error;
    fail("invalid_signal", "Position sync signal could not be combined with its deadline");
  }

  const deadlineStartedAt = performance.now();
  const readSweep = () => readSourceSweep({
    token, fetchImpl, clock, deadlineSignal, deadlineStartedAt, timeoutMs, sleepImpl,
  });
  const first = await readSweep();
  if (requireSourceAction && [...first.positions.values()].some(position => !validateSourceAction(position))) {
    fail("source_action_contract_not_published", "Position sync requires the published explicit-action contract");
  }
  if (first.sharedSnapshotTimestamp) {
    return { asOf: first.asOf, positions: first.positions };
  }
  // Both sweeps share the original ten-second deadline and independently
  // validate every page, cursor, field, duplicate and timestamp. An insertion,
  // deletion or lifecycle change refuses the entire acquisition, never a
  // partial snapshot. No remote timestamp is fabricated or refreshed locally.
  const second = await readSweep();
  if (requireSourceAction && [...second.positions.values()].some(position => !validateSourceAction(position))) {
    fail("source_action_contract_not_published", "Position sync requires the published explicit-action contract");
  }
  const fingerprint = (snapshot) => JSON.stringify(
    [...snapshot.positions].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([id, position]) => [id, POSITION_FIELDS.map((field) => position[field])]),
  );
  if (fingerprint(first) !== fingerprint(second)) {
    fail("incomplete_response", "Position sync changed between complete confirmation sweeps");
  }
  return { asOf: second.asOf, positions: second.positions };
}

async function readSourceSweep({
  token, fetchImpl, clock, deadlineSignal, deadlineStartedAt, timeoutMs, sleepImpl,
}) {
  const positions = new Map();
  let afterId = null;
  let snapshotAsOf = null;
  let snapshotTime = null;
  let sharedSnapshotTimestamp = true;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(POSITION_SYNC_URL);
    if (afterId !== null) url.searchParams.set("afterId", String(afterId));

    let payload;
    let pageAttempts = 0;
    let lastRetryAfterMs = null;
    let pageHttpStatus;
    while (pageAttempts < 2) {
      pageAttempts += 1;
      let response;
      try {
        response = await withAbort(fetchImpl(url, {
          method: "GET",
          headers: { "x-trading-token": token, accept: "application/json" },
          signal: deadlineSignal,
        }), deadlineSignal);
      } catch (cause) {
        if (deadlineSignal.aborted) {
          throw withPageDetails(new BulletPositionSyncError(
            "request_timeout", "Position sync exceeded its total request deadline",
          ), page + 1, pageAttempts, "transport");
        }
        if (pageAttempts < 2 && transportFailureIsTransient(cause) &&
            remainingDeadlineMs(deadlineStartedAt, timeoutMs) > 0) continue;
        throw new BulletPositionSyncError("request_failed", "Position sync request failed", {
          pageNumber: page + 1,
          attempts: pageAttempts,
          failureStage: "transport",
        });
      }

      const status = Number.isSafeInteger(response?.status) && response.status >= 100 && response.status <= 599
        ? response.status
        : undefined;
      pageHttpStatus = status;
      if (!response || response.ok !== true) {
        lastRetryAfterMs = retryAfterMilliseconds(response, clock) ?? lastRetryAfterMs;
        const retryable = status !== undefined && TRANSIENT_HTTP_STATUSES.has(status);
        const remaining = remainingDeadlineMs(deadlineStartedAt, timeoutMs);
        if (retryable && pageAttempts < 2 &&
            (lastRetryAfterMs === null || lastRetryAfterMs < remaining)) {
          if (lastRetryAfterMs > 0) {
            try {
              await withAbort(sleepImpl(lastRetryAfterMs, { signal: deadlineSignal }), deadlineSignal);
            } catch {
              throw withPageDetails(new BulletPositionSyncError(
                "request_timeout", "Position sync exceeded its total request deadline",
              ), page + 1, pageAttempts, "transport");
            }
          }
          if (remainingDeadlineMs(deadlineStartedAt, timeoutMs) > 0) continue;
        }
        throw new BulletPositionSyncError("request_failed", "Position sync request failed", {
          ...(status === undefined ? {} : { httpStatus: status }),
          ...(lastRetryAfterMs === null ? {} : { retryAfterMs: lastRetryAfterMs }),
          pageNumber: page + 1,
          attempts: pageAttempts,
          failureStage: "http",
        });
      }

      let body;
      try {
        body = await withAbort(response.json(), deadlineSignal);
      } catch (error) {
        if (deadlineSignal.aborted) {
          throw withPageDetails(new BulletPositionSyncError(
            "request_timeout", "Position sync exceeded its total request deadline",
          ), page + 1, pageAttempts, "body");
        }
        throw new BulletPositionSyncError("incomplete_response", "Position sync returned an unreadable response", {
          ...(status === undefined ? {} : { httpStatus: status }),
          pageNumber: page + 1,
          attempts: pageAttempts,
          failureStage: "body",
        });
      }
      try {
        payload = validateEnvelope(body);
      } catch (error) {
        throw withPageDetails(error, page + 1, pageAttempts, "validation", status);
      }
      break;
    }

    try {
      const pageAsOf = parseAsOf(payload.asOf);
      isClockFresh(pageAsOf, clock);
      if (snapshotTime === null) {
        snapshotTime = pageAsOf;
        snapshotAsOf = payload.asOf;
      } else if (pageAsOf !== snapshotTime) {
        // Bullet timestamps each page independently once history exceeds 200
        // records. This is not an atomic snapshot. Require a second complete,
        // identical sweep below instead of discarding it or trusting page one.
        sharedSnapshotTimestamp = false;
      }

      if (positions.size + payload.positions.length > MAX_ITEMS) {
        fail("limit_exceeded", "Position sync exceeded the maximum item count");
      }
      for (const position of payload.positions) {
        const [id, validated] = validatePosition(position);
        if (positions.has(id)) {
          fail("duplicate_id", "Position sync returned a duplicate position id");
        }
        positions.set(id, validated);
      }

      const nextAfterId = validateCursor(payload.nextAfterId);
      if (nextAfterId === null) {
        isClockFresh(snapshotTime, clock);
        return { asOf: snapshotAsOf, positions, sharedSnapshotTimestamp };
      }
      if (!cursorProgresses(afterId, nextAfterId)) {
        fail("cursor_stalled", "Position sync pagination cursor did not make monotonic progress");
      }
      if (payload.positions.length === 0) {
        fail("incomplete_response", "Position sync pagination returned an empty page with a continuation cursor");
      }
      afterId = nextAfterId;
    } catch (error) {
      throw withPageDetails(error, page + 1, pageAttempts, "validation", pageHttpStatus);
    }
  }

  fail("limit_exceeded", "Position sync exceeded the maximum page count");
}