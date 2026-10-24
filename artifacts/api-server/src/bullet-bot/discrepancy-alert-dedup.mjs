// Extracted from bot-runtime.mjs's syncSource loop so the dedup/recovery
// behavior for REAL/VST source-discrepancy Telegram alerts can be unit
// tested without a DB pool, timers, or the rest of startBotWorker.
//
// Contract: a given (ledger, sourceSignalId, kind) discrepancy alerts once,
// is not repeated on every subsequent sync pass while it remains proven, and
// re-alerts if it resolves (drops out of the proven set) and later recurs.

export function provenKey(item) {
  return `${item.ledger}:${item.sourceSignalId}:${item.kind}`;
}

// Mutates `alerted` in place: forgets any previously alerted key that is no
// longer present in this pass's proven discrepancies, so a later recurrence
// of the same (ledger, sourceSignalId, kind) is treated as new rather than
// staying permanently suppressed. Returns the items from this pass that
// have not already been alerted (and does NOT add them -- callers must call
// markDiscrepanciesAlerted only after the alert actually sends, so a failed
// send remains retryable on the next pass).
export function selectNewlyProvenDiscrepancies(alerted, proven) {
  const stillProven = new Set(proven.map(provenKey));
  for (const key of alerted) {
    if (!stillProven.has(key)) alerted.delete(key);
  }
  return proven.filter((item) => !alerted.has(provenKey(item)));
}

export function markDiscrepanciesAlerted(alerted, items) {
  for (const item of items) alerted.add(provenKey(item));
}
