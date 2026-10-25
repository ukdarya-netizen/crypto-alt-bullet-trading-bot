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
  if (event.kind === "vst_worker_error" && detail.reason === "vst_order_rejected" &&
      detail.operation === "entry") return "not_opened";
  if (event.kind === "vst_position_management_quarantined") return "unmanaged";
  if (event.kind === "vst_full_take_close_delayed") return "take_delayed";
  if (event.kind === "vst_full_take_close_stuck") return "take_stuck";
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
  unmanaged: "Бот не может сопровождать эту позицию из-за ошибки. Стоп-лосс на бирже стоит, тейк +5% отслеживается. Новые сигналы по другим монетам открываются.",
  take_delayed: "Цена достигла +5%, но позиция ещё не закрыта. Бот продолжает закрывать её. Стоп-лосс на бирже сохраняется.",
  take_stuck: "Позиция не закрыта через 15 минут после достижения +5%. Закройте её вручную на BingX VST. Стоп-лосс на бирже сохраняется.",
};

const TAKE_CLOSE_REASONS = [
  [/^full_take_close_not_attempted$/, "цикл бота ещё не дошёл до закрытия (бот занят или перезапускается)"],
  [/same_symbol_intent_unresolved|waiting_for_entry_reconciliation|prerequisite/, "по монете не завершена предыдущая операция, бот сверяет её с биржей"],
  [/close_reconciliation_pending|acted|full_take_close_attempted/, "ордер на закрытие отправлен, ждём подтверждения биржи"],
  [/account_not_verified|capabilit|account_snapshot/, "биржа не подтвердила состояние счёта"],
  [/mark|quote|price/, "нет свежей цены с биржи"],
  [/tick_mutation_boundary/, "в этом цикле уже была операция, закрытие в следующем"],
  [/ledger|identity|provenance|different_request|not_in_ledger/, "данные позиции в боте не совпали с биржей, нужна проверка"],
  [/exception|unknown/, "ошибка при закрытии, бот повторяет попытку"],
  [/source_exit_blocked_for_symbol/, "закрытие по монете временно заблокировано другой операцией"],
];

export function takeCloseReasonText(reason) {
  if (typeof reason !== "string" || !reason) return "причина не указана";
  for (const [pattern, text] of TAKE_CLOSE_REASONS) if (pattern.test(reason)) return text;
  return reason.replace(/[^A-Za-z0-9_:,.\- ]/g, "").slice(0, 120) || "причина не указана";
}

const NOT_OPENED_REASONS = [
  [/^signal_expired/, "сигнал устарел до входа"],
  [/^source_withdrawn|^source_entry_cancelled/, "сигнал отменён источником"],
  [/^not_a_fresh_approved_v2_long$/, "сигнал не прошёл проверку (не свежий лонг)"],
  [/^invalid_canonical_vst_symbol$/, "монета не торгуется на BingX VST"],
  [/^vst_symbol_currently_offline/, "монета сейчас недоступна на BingX VST"],
  [/^preexisting_exchange_position_or_order$/, "по монете уже есть позиция или ордер на бирже"],
  [/^vst_margin_mode_state_not_verified_or_preparable$/, "не удалось подтвердить изолированную маржу"],
  [/^vst_order_rejected$/, "биржа отклонила ордер"],
  [/^entry_unverified_symbol_flat_after_timeout$/, "ордер не исполнен, позиции на бирже нет"],
  [/^unsupported_vst_protective_capabilities/, "биржа не подтвердила нужные функции защиты"],
];
const SIZING_REASONS = {
  below_minimum_quantity: "объём меньше минимального",
  below_minimum_notional: "сумма меньше минимальной",
  initial_margin_exceeds_one_percent_budget: "маржа больше лимита 1%",
  insufficient_available_vst: "недостаточно свободных VST",
  exceeds_leverage_position_cap: "превышен лимит позиции для плеча",
};

export function notOpenedReasonText(reason) {
  if (typeof reason !== "string" || !reason) return "причина не указана";
  const parts = reason.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length && parts.every((part) => SIZING_REASONS[part])) {
    return parts.map((part) => SIZING_REASONS[part]).join("; ");
  }
  for (const [pattern, text] of NOT_OPENED_REASONS) {
    if (pattern.test(reason)) return text;
  }
  // Unmapped codes are shown as-is (plain ASCII), never hidden.
  return reason.replace(/[^A-Za-z0-9_:,.\- ]/g, "").slice(0, 120) || "причина не указана";
}

export function formatVstTradeOutcome(event) {
  const outcome = vstTradeOutcome(event);
  const symbol = event?.symbol ?? event?.body?.symbol;
  if (!outcome || !/^[A-Z0-9]{1,20}USDT$/.test(symbol ?? "")) return null;
  const lines = [`BingX VST · ${symbol}`, OUTCOME_TEXT[outcome]];
  if (outcome === "not_opened") {
    lines.push(`Причина: ${notOpenedReasonText(event?.detail?.reason)}`);
  }
  if (outcome === "take_delayed" || outcome === "take_stuck") {
    const detail = event?.detail ?? {};
    if (detail.entryPrice && detail.observedPrice) {
      const short = (value) => String(Number(Number(value).toPrecision(6)));
      lines.push(`Вход ${short(detail.entryPrice)} · цена ${short(detail.observedPrice)}`);
    }
    lines.push(`Причина: ${takeCloseReasonText(detail.reason)}`);
  }
  return lines.join("\n");
}
