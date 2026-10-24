const SOURCE_SIGNAL_ID = /^cab-signal-[1-9]\d{0,17}$/;
const MODES = new Set(["paper", "vst", "both"]);
const OUTCOMES = new Set([
  "unauthorized",
  "rejected",
  "accepted",
  "duplicate",
  "conflict",
  "storage_failure",
  "both_received",
  "partial_dual_write",
  "dual_write_failed",
]);
const STORE_STATES = new Set(["received", "conflict", "failed"]);
const REJECTION_FIELDS = new Map([
  ["unauthorized", new Set([undefined])],
  ["invalid_json", new Set(["body"])],
  ["request_too_large", new Set(["body"])],
  ["invalid_payload", new Set(["body"])],
  ["invalid_signal_id", new Set(["sourceSignalId"])],
  ["unconfirmed_signal", new Set(["confirmationStatus"])],
  ["pattern_not_approved", new Set(["patternId"])],
  ["invalid_pattern_id", new Set(["patternId"])],
  ["invalid_timestamp", new Set(["signalAt"])],
  ["expired_or_future_signal", new Set(["signalAt"])],
  ["signal_predates_vst_enable", new Set(["signalAt"])],
  ["invalid_symbol", new Set(["symbol"])],
  ["unsupported_order", new Set(["orderType"])],
  ["invalid_number", new Set(["quantity", "referencePrice", "limitPrice", "stopLoss"])],
  ["invalid_entry_or_stop", new Set(["stopLoss"])],
  ["unsupported_plan", new Set(["payload"])],
  ["unsupported_exit_rules", new Set(["payload.exitRules"])],
  ["unsupported_ladder", new Set(["payload.exitRules"])],
  ["unsupported_runner", new Set(["payload.exitRules.runner"])],
  ["unexpected_runner", new Set(["payload.exitRules.runner"])],
  ["source_signal_id_conflict", new Set(["sourceSignalId"])],
  ["storage_unavailable", new Set([undefined])],
]);

export function validatedIngressSourceSignalId(value) {
  return typeof value === "string" && value.length <= 64 && SOURCE_SIGNAL_ID.test(value)
    ? value
    : undefined;
}

/** Build a deliberately narrow log record; request data and exception text never pass through. */
export function createIngressAuditEvent({
  mode,
  status,
  outcome,
  sourceSignalId,
  rejectionCode,
  rejectionField,
  stores,
  duplicate,
}) {
  const event = {
    type: "bot_signal_ingress",
    mode: MODES.has(mode) ? mode : "unknown",
    status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500,
    outcome: OUTCOMES.has(outcome) ? outcome : "rejected",
  };
  const safeId = validatedIngressSourceSignalId(sourceSignalId);
  if (safeId) event.sourceSignalId = safeId;

  const permittedFields = REJECTION_FIELDS.get(rejectionCode);
  if (permittedFields?.has(rejectionField)) {
    event.rejection = {
      code: rejectionCode,
      ...(rejectionField ? { field: rejectionField } : {}),
    };
  } else if (rejectionCode === "storage_unavailable") {
    event.rejection = { code: "storage_unavailable" };
  }

  if (stores && typeof stores === "object") {
    const safeStores = {};
    for (const name of ["vst", "paper"]) {
      if (STORE_STATES.has(stores[name])) safeStores[name] = stores[name];
    }
    if (Object.keys(safeStores).length) event.stores = safeStores;
  }
  if (typeof duplicate === "boolean") event.duplicate = duplicate;
  return event;
}