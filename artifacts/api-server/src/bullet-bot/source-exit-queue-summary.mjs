const OPERATIONAL_FAILURES = new Set([
  "source_exit_queue_error",
  "source_exit_evidence_error",
]);
const MAX_REASON_BUCKETS = 16;

export function isSourceExitOperationalFailure(item) {
  return OPERATIONAL_FAILURES.has(item?.reason);
}

// Only bounded static reason codes enter logs. Never include raw source
// evidence, exchange responses, exception details, or account identifiers.
export function summarizeSourceExitQueue(result) {
  const rejected = Array.isArray(result?.rejected) ? result.rejected : [];
  const reasons = new Map();
  let other = 0;
  for (const item of rejected) {
    const reason = typeof item?.reason === "string" &&
        /^[a-z][a-z0-9_]{0,79}$/.test(item.reason)
      ? item.reason : "unclassified_rejection";
    if (reasons.has(reason) || reasons.size < MAX_REASON_BUCKETS) {
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    } else {
      other += 1;
    }
  }
  if (other) reasons.set("other_rejections",
    (reasons.get("other_rejections") ?? 0) + other);
  return {
    queued: Array.isArray(result?.queued) ? result.queued.length : 0,
    refreshed: Array.isArray(result?.refreshed) ? result.refreshed.length : 0,
    rejected: rejected.length,
    errors: rejected.filter(isSourceExitOperationalFailure).length,
    rejectedByReason: Object.fromEntries([...reasons].sort(([a], [b]) =>
      a.localeCompare(b))),
  };
}