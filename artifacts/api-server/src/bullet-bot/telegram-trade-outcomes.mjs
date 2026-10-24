// Owner policy: Telegram reports trade outcomes only. Diagnostics, watchdogs,
// margin operations and intermediate reconciliation remain in logs/the journal.
export const TECHNICAL_TELEGRAM_ALERTS_ENABLED = false;

const ENTRY_KINDS = new Set([
  "vst_entry_verified",
  "vst_entry_margin_top_up_pending",
  "vst_impulse_entry_margin_top_up_pending",
  "vst_impulse_entry_verified_split_pending",
]);

export function vstTradeOutcome(event) {
  if (!event) return null;
  const detail = event.detail ?? {};
  if (ENTRY_KINDS.has(event.kind)) return "opened";
  if (event.kind === "vst_signal_rejected") return "not_opened";
  if (event.kind === "vst_worker_error" &&
      detail.reason === "entry_unverified_symbol_flat_after_timeout") return "not_opened";
  if (event.kind === "vst_triggered_stop_verified") return "stop";
  if (event.kind === "vst_impulse_triggered_stop_verified") {
    return Number(detail.residualQuantity ?? 0) === 0 ? "stop" : null;
  }
  if ([
    "vst_impulse_sole_split_leg_closed",
    "vst_impulse_full_split_position_closed",
    "vst_impulse_flat_close_cleanup_pending",
    "vst_source_exit_closed",
    "vst_source_exit_flat_cleanup_pending",
  ].includes(event.kind)) return "closed";
  if (event.kind === "vst_protected_strategy_exit_verified") {
    return event.request?.nextPolicy?.status === "closed" ? "closed" : null;
  }
  if (event.kind === "vst_action_reconciled") {
    const operation = event.request?.operation ?? event.outcome?.operation;
    return operation === "close_leg" && event.request?.nextPolicy?.status === "closed"
      ? "closed" : null;
  }
  if (event.kind === "exchange_history_provenance") return "closed";
  if (event.kind === "source_exit_completed" && detail.outcome === "closed") {
    const origin = detail.detail?.closureOrigin ?? detail.closureOrigin;
    return origin === "already_committed_protective_stop" ? "stop" : "closed";
  }
  // Unknown or pending is not equivalent to "not opened". Do not report an
  // execution result until the worker has proved one.
  return null;
}

const OUTCOME_TEXT = {
  opened: "Позиция открыта.",
  not_opened: "Позиция не открыта.",
  closed: "Позиция зафиксирована.",
  stop: "Сработал стоп-лосс.",
};

export function formatVstTradeOutcome(event) {
  const outcome = vstTradeOutcome(event);
  const symbol = event?.symbol ?? event?.body?.symbol;
  if (!outcome || !/^[A-Z0-9]{1,20}USDT$/.test(symbol ?? "")) return null;
  return `BingX VST · ${symbol}\n${OUTCOME_TEXT[outcome]}`;
}
