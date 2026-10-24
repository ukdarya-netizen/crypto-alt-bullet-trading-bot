// Classification is reporting, never permission to resubmit a mutation.
export const VST_UNCERTAINTY_OPERATIONS = Object.freeze([
  "entry", "raise_stop", "cancel_original_stop", "margin_top_up",
  "close_pre_runner_split", "source_exit",
]);

const outcomes = Object.freeze({
  entry: "isolate_entry_exposure_read_only",
  raise_stop: "verify_protection_or_quarantine_transfer",
  cancel_original_stop: "retain_replacement_reconcile_exact_predecessor",
  margin_top_up: "quarantine_additions_observe_complete_adjustment_history",
  close_pre_runner_split: "retain_legs_reconcile_exact_close",
  source_exit: "retain_source_decision_reconcile_exchange_fills",
});

export function uncertaintyOperation(intent) {
  if (intent?.phase?.startsWith("source-exit") ||
      intent?.request?.sourceExit) return "source_exit";
  const op = intent?.request?.operation;
  return VST_UNCERTAINTY_OPERATIONS.includes(op) ? op : null;
}

export function classifyVstUncertainty(intent, refusal = "independent_evidence_unavailable") {
  const operation = uncertaintyOperation(intent);
  const original = intent?.outcome?.originalSubmissionOutcome ?? intent?.outcome ?? {};
  const transfer = intent?.outcome?.stopTransfer;
  // This tag is only descriptive. Every write still needs its own native proof adapter.
  const noSend = transfer?.version === 1 && transfer.stage === "prepared";
  return {
    version: 1, operation,
    classification: operation ? "known_uncertainty" : "unclassified",
    mutationAttribution: noSend ? "prepared_not_sent" : "unknown_potentially_sent",
    acknowledgedOrderId: intent?.exchangeOrderId ?? transfer?.newStopOrderId ?? null,
    originalSubmissionOutcome: original,
    currentReadRefusal: refusal,
    safeOutcome: outcomes[operation] ?? "isolate_and_escalate",
    automaticOwnerApprovalRequired: !operation,
    writeRetryAuthorized: false,
  };
}

// One read episode is bounded; exhaustion schedules a new read-only episode.
// It NEVER means the earlier write failed. Claim this durably before reading.
export function nextUncertaintyRead(intent, now) {
  if (!uncertaintyOperation(intent) ||
      (!["submitted", "unknown"].includes(intent.state) &&
        !(intent.state === "failed" && intent.outcome?.reason === "raise_stop_protected_degraded")) ||
      !Number.isSafeInteger(now) || now <= 0) return null;
  const previous = intent.outcome?.uncertaintyRead ?? {};
  if (Number(previous.nextReadAt) > now) return null;
  const previousAttempts = Number.isSafeInteger(previous.attempts) ? previous.attempts : 0;
  const attempts = previousAttempts >= 4 ? 1 : previousAttempts + 1;
  const delay = attempts === 4 ? 300_000 : Math.min(60_000, 5_000 * 2 ** (attempts - 1));
  return {
    version: 1, attempts, totalAttempts: (Number(previous.totalAttempts) || 0) + 1,
    lastReadAt: now, nextReadAt: now + delay,
    budgetExhausted: attempts === 4,
    writeRetryAuthorized: false,
  };
}

export function protectedDegradedMarker(intent, protection, observedAt) {
  return {
    version: 1, status: "protected_degraded",
    originalClientOrderId: intent.clientOrderId, originalPhase: intent.phase,
    originalExecution: "unknown_unproven", originalWriteAttributed: false,
    requestedStopPrice: String(intent.request.stopPrice),
    currentProtection: protection, protectionObservedAt: observedAt,
    // Quarantine survives active-queue retirement and process restart.
    quarantinedEffects: ["stop_post", "stop_delete", "margin_post", "strategy_close"],
    safeActions: ["native_reads", "exact_triggered_fill_reconciliation"],
  };
}

export function uncertaintyEvidenceKeys(outcome) {
  return Object.keys(outcome).filter(key =>
    !["uncertainty", "uncertaintyRead", "originalSubmissionOutcome"].includes(key));
}

// The caller supplies read-only, operation-specific proof adapters. This
// dispatcher does not catch a mutation and never produces a write permission.
export async function reconcileVstUncertaintyEvidence(intent, adapters) {
  const operation = uncertaintyOperation(intent);
  const adapter = adapters[operation];
  if (typeof adapter !== "function") {
    return { verified: false, status: "unknown", refusal: "unclassified_operation" };
  }
  return await adapter({
    clientOrderId: intent.clientOrderId, phase: intent.phase, request: intent.request,
    // An acknowledged native ID must not be replaced by approximate discovery.
    ...(intent.exchangeOrderId ? { exchangeOrderId: intent.exchangeOrderId } : {}),
  });
}