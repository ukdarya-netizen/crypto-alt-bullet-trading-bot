import { createHash } from "node:crypto";

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
  ) : value;

// Only immutable exchange/protection identity, not phase timestamps, market
// observations or the old snapshot's incidental bookkeeping.
export function preRunnerCloseIdentity(request) {
  const identity = Object.fromEntries([
    "operation", "sourceSignalId", "environment", "accountId", "symbol",
    "positionId", "totalQuantity", "originalStop", "coreStop", "closeReason",
  ].map((key) => [key, request?.[key]]));
  return createHash("sha256").update(JSON.stringify(canonical(identity))).digest("hex");
}

export function evaluatePreRunnerCloseRetry(request, attempts, nowMs) {
  const fingerprint = preRunnerCloseIdentity(request);
  let failures = 0, lastFailureAt = null;
  for (const intent of attempts) {
    if (preRunnerCloseIdentity(intent.request) !== fingerprint) continue;
    if (intent.state !== "failed" ||
        intent.outcome?.reason !== "close_pre_runner_split_abandoned_confirmed_still_open") break;
    failures++;
    if (lastFailureAt === null) lastFailureAt = Date.parse(intent.updatedAt);
  }
  if (failures >= 3) return { allowed: false, limitReached: true, failures,
    fingerprint, reason: "pre_runner_close_retry_limit_reached" };
  const delayMs = failures === 2 ? 15 * 60_000 : failures === 1 ? 5 * 60_000 : 0;
  if (failures && (!Number.isFinite(lastFailureAt) || !Number.isFinite(nowMs) ||
      nowMs < lastFailureAt || nowMs - lastFailureAt < delayMs)) {
    return { allowed: false, limitReached: false, failures, fingerprint,
      reason: "pre_runner_close_retry_backoff", retryAfterMs: delayMs };
  }
  return { allowed: true, failures, fingerprint };
}