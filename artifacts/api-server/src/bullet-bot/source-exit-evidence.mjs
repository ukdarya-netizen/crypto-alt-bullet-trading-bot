const MAX_FUTURE_SKEW_MS = 30_000;
const MAX_SNAPSHOT_AGE_MS = 60_000;
const SOURCE_CLOSURE_STATUSES = new Set([
  "cancelled",
  "profit",
  "stop_loss",
  "bu_stop",
  "breakeven",
  "expired",
]);
const SOURCE_STATUSES = new Set([
  ...SOURCE_CLOSURE_STATUSES,
  "reclassified",
]);

// Owner-approved cancellation is an instruction to exit our matching lifecycle,
// not proof that either the source or the exchange has already filled a close.
export function isSourceCancellation(source) {
  return source?.sourceStatus === "cancelled" && source.sourceAction === "review";
}

// PAPER stores evidence directly; VST nests it under detail.evidence.
// Arguments are internal SQL column expressions, never request data.
export function sourceExitRequestPredicate(detail, evidence = detail) {
  return `((${detail}->>'reason' = 'source_closed'
    AND ${evidence}->>'sourceStatus' IN ('profit', 'stop_loss', 'bu_stop', 'breakeven', 'expired'))
    OR (${detail}->>'reason' = 'source_withdrawal'
      AND ${evidence}->>'sourceStatus' = 'cancelled'
      AND ${evidence}->>'sourceAction' = 'review'))`;
}

function timestamp(value) {
  if (value instanceof Date) {
    const parsed = value.getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && Number.isFinite(new Date(value).getTime())
      ? value
      : null;
  }
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableTimestamp(value) {
  if (value === null || value === undefined) return { valid: true, value: null };
  const parsed = timestamp(value);
  return parsed === null
    ? { valid: false, value: null }
    : { valid: true, value: new Date(parsed).toISOString() };
}

function positivePrice(value) {
  if (typeof value !== "string" && typeof value !== "number") return false;
  if (
    typeof value === "string" &&
    !/^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)
  ) return false;
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

/**
 * Builds the narrowly-scoped evidence which authorizes a source-directed
 * executor exit. A source withdrawal is an exit decision, not a claim that the
 * source position filled at any particular price.
 *
 * @param {object} source A position from a complete source-position snapshot.
 * @param {{
 *   sourceSignalId: string,
 *   symbol: string,
 *   entryAt?: string | Date | number | null,
 *   signalAt?: string | Date | number | null,
 *   asOf: string | Date | number,
 *   observedAt?: string | Date | number,
 * }} options
 * @returns {Readonly<{
 *   sourceSignalId: string,
 *   symbol: string,
 *   reason: "source_withdrawal" | "source_closed",
 *   sourceStatus: string,
 *   sourceUpdatedAt: string | null,
 *   sourceClosedAt: string | null,
 *   sourceExitPrice: string | number | null,
 *   sourceCancelReason: string | null,
 *   exitDecisionAt: string,
 *   asOf: string,
 *   observedAt: string,
 * }> | null}
 */
export function buildSourceExitEvidence(source, {
  sourceSignalId,
  symbol,
  entryAt,
  signalAt,
  asOf,
  observedAt = Date.now(),
} = {}) {
  if (
    source === null ||
    typeof source !== "object" ||
    Array.isArray(source) ||
    typeof sourceSignalId !== "string" ||
    sourceSignalId.length === 0 ||
    typeof symbol !== "string" ||
    symbol.length === 0 ||
    source.sourceSignalId !== sourceSignalId ||
    source.symbol !== symbol ||
    !SOURCE_STATUSES.has(source.sourceStatus)
  ) return null;
  const cancellation = isSourceCancellation(source);
  if (!cancellation && source.sourceAction !== undefined &&
      (source.sourceAction !== "close" ||
       !["profit", "stop_loss", "bu_stop", "breakeven", "expired"].includes(source.sourceStatus))) return null;

  const asOfMs = timestamp(asOf);
  const observedAtMs = timestamp(observedAt);
  if (asOfMs === null || observedAtMs === null) return null;
  if (
    asOfMs > observedAtMs + MAX_FUTURE_SKEW_MS ||
    observedAtMs - asOfMs > MAX_SNAPSHOT_AGE_MS
  ) return null;

  const updated = nullableTimestamp(source.sourceUpdatedAt);
  const closed = nullableTimestamp(source.sourceClosedAt);
  if (!updated.valid || !closed.valid) return null;

  let reason;
  let decisionAtMs;
  if (source.sourceStatus === "reclassified" || cancellation) {
    // Reclassification is the explicitly approved withdrawal decision. Even
    // when source closure data is also present, that data remains provenance
    // rather than changing the nature of this decision.
    if (updated.value === null) return null;
    reason = "source_withdrawal";
    decisionAtMs = timestamp(updated.value);
  } else {
    if (
      !SOURCE_CLOSURE_STATUSES.has(source.sourceStatus) ||
      closed.value === null ||
      (source.sourceAction !== "close" && !positivePrice(source.sourceExitPrice))
    ) return null;
    reason = "source_closed";
    decisionAtMs = timestamp(closed.value);
  }
  if (decisionAtMs === null) return null;

  let entryAtMs = null;
  let signalAtMs = null;
  if (entryAt !== null && entryAt !== undefined) {
    entryAtMs = timestamp(entryAt);
    if (entryAtMs === null) return null;
  }
  if (signalAt !== null && signalAt !== undefined) {
    signalAtMs = timestamp(signalAt);
    if (signalAtMs === null) return null;
  }
  const minimumDecisionAt = entryAtMs ?? signalAtMs;
  if (minimumDecisionAt !== null && decisionAtMs < minimumDecisionAt) return null;

  if (
    decisionAtMs > asOfMs + MAX_FUTURE_SKEW_MS ||
    decisionAtMs > observedAtMs + MAX_FUTURE_SKEW_MS
  ) return null;

  if (
    source.sourceExitPrice !== null &&
    source.sourceExitPrice !== undefined &&
    !positivePrice(source.sourceExitPrice)
  ) return null;
  if (
    source.sourceCancelReason !== null &&
    source.sourceCancelReason !== undefined &&
    typeof source.sourceCancelReason !== "string"
  ) return null;

  return Object.freeze({
    sourceSignalId,
    symbol,
    ...(source.sourceAction === "close" || cancellation ? { sourceAction: source.sourceAction } : {}),
    reason,
    sourceStatus: source.sourceStatus,
    sourceUpdatedAt: updated.value,
    sourceClosedAt: closed.value,
    sourceExitPrice: source.sourceExitPrice ?? null,
    sourceCancelReason: source.sourceCancelReason ?? null,
    exitDecisionAt: new Date(decisionAtMs).toISOString(),
    asOf: new Date(asOfMs).toISOString(),
    observedAt: new Date(observedAtMs).toISOString(),
  });
}