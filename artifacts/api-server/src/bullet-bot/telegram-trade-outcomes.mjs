// Owner policy: Telegram reports trade outcomes only. Diagnostics, watchdogs,
// margin operations and intermediate reconciliation remain in logs/the journal.
export const TECHNICAL_TELEGRAM_ALERTS_ENABLED = false;

const ENTRY_KINDS = new Set([
  "vst_entry_verified",
  "vst_entry_margin_top_up_pending",
  "vst_impulse_entry_margin_top_up_pending",
  "vst_impulse_entry_verified_split_pending",
]);

function confirmedCloseOutcome(event) {
  const detail = event.detail ?? {};
  const evidence = detail.sourceEvidence ?? detail.evidence ??
    detail.detail?.sourceEvidence ?? event.request?.sourceExit?.evidence ??
    event.request?.nextPolicy?.sourceExitEvidence ?? event.outcome?.sourceEvidence;
  if (evidence?.sourceStatus === "cancelled") return "cancelled";
  if (evidence?.rule === "full_take_5pct" ||
      evidence?.reason === "fixed_price_take_profit_5pct") return "take";
  return "closed";
}

// Operations that run before any coin is bought. Their terminal failure
// means the signal was never opened and must reach Telegram.
const PRE_ENTRY_OPERATIONS = new Set(["entry", "prepare_margin_mode", "set_isolated_leverage"]);
const PRE_ENTRY_FAILURES = /^(prepare_margin_mode|set_isolated_leverage)_abandoned_confirmed_flat_account$|^isolated_margin_preparation_(failed|rejected)$/;

export function vstTradeOutcome(event) {
  if (!event) return null;
  const detail = event.detail ?? {};
  if (ENTRY_KINDS.has(event.kind)) return "opened";
  if (event.kind === "vst_signal_rejected") return "not_opened";
  if (event.kind === "vst_worker_error" &&
      detail.reason === "entry_unverified_symbol_flat_after_timeout") return "not_opened";
  if (event.kind === "vst_worker_error" && detail.reason === "vst_order_rejected" &&
      PRE_ENTRY_OPERATIONS.has(detail.operation)) return "not_opened";
  if (event.kind === "vst_worker_error" && PRE_ENTRY_FAILURES.test(detail.reason ?? "")) {
    return "not_opened";
  }
  if (event.kind === "vst_worker_error" && detail.stage === "before_entry") return "not_opened";
  if (event.kind === "vst_position_management_quarantined") return "unmanaged";
  if (event.kind === "vst_external_close_verified") {
    return detail.takeAttribution?.cause === "native_take_profit" ? "take" : "closed_external";
  }
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
  ].includes(event.kind)) return confirmedCloseOutcome(event);
  if (event.kind === "vst_protected_strategy_exit_verified") {
    return event.request?.nextPolicy?.status === "closed" ? confirmedCloseOutcome(event) : null;
  }
  if (event.kind === "vst_action_reconciled") {
    const operation = event.request?.operation ?? event.outcome?.operation;
    return operation === "close_leg" && event.request?.nextPolicy?.status === "closed"
      ? confirmedCloseOutcome(event) : null;
  }
  if (event.kind === "exchange_history_provenance") return confirmedCloseOutcome(event);
  if (event.kind === "source_exit_completed" && detail.outcome === "closed") {
    const origin = detail.detail?.closureOrigin ?? detail.closureOrigin;
    if (origin === "external_close_verified_flat") return null; // reported by its own event
    return origin === "already_committed_protective_stop" ? "stop" : confirmedCloseOutcome(event);
  }
  // Unknown or pending is not equivalent to "not opened". Do not report an
  // execution result until the worker has proved one.
  return null;
}

const OUTCOME_TEXT = {
  opened: "Позиция открыта.",
  not_opened: "Позиция не открыта.",
  closed: "Позиция закрыта.",
  cancelled: "Позиция закрыта: сигнал отменён.",
  take: "Позиция зафиксирована: тейк +5%.",
  stop: "Сработал стоп-лосс.",
  closed_external: "Позиция закрыта. Причина закрытия не подтверждена.",
  unmanaged: "Бот не может сопровождать эту позицию из-за ошибки. Стоп-лосс на бирже стоит, тейк +5% отслеживается. Новые сигналы по другим монетам открываются.",
  take_delayed: "Цена достигла +5%, но позиция ещё не закрыта. Бот продолжает закрывать её. Стоп-лосс на бирже сохраняется.",
  take_stuck: "Позиция не закрыта через 15 минут после достижения +5%. Закройте её вручную на BingX VST. Стоп-лосс на бирже сохраняется.",
};

const TAKE_CLOSE_REASONS = [
  [/^native_take_/, "тейк на бирже исполнен, бот подтверждает закрытие"],
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
  [/100410/, "BingX временно ограничил частые запросы (лимит API биржи)"],
  [/^signal_expired/, "сигнал устарел до входа"],
  [/^source_withdrawn|^source_entry_cancelled/, "сигнал отменён источником"],
  [/^not_a_fresh_approved_v2_long$/, "сигнал не прошёл проверку (не свежий лонг)"],
  [/^invalid_canonical_vst_symbol$/, "монета не торгуется на BingX VST"],
  [/^vst_symbol_currently_offline/, "монета сейчас недоступна на BingX VST"],
  [/^preexisting_exchange_position_or_order$/, "по монете уже есть позиция или ордер на бирже"],
  [/^vst_margin_mode_state_not_verified_or_preparable$/, "не удалось подтвердить изолированную маржу"],
  [/^vst_order_rejected$/, "биржа отклонила ордер"],
  [/^prepare_margin_mode_|^isolated_margin_preparation_/, "не удалось переключить маржу монеты на изолированную"],
  [/^set_isolated_leverage_/, "не удалось выставить плечо по монете"],
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

const BLOCKED_BY_TEXT = {
  capability_read_failed: "BingX не подтвердил состояние счёта (ошибка чтения биржи)",
  worker_error: "ошибка в цикле бота",
  account_state_not_verified: "BingX не подтвердил состояние счёта",
  verified_mutation_capabilities_unavailable: "BingX не подтвердил состояние счёта",
  source_exit_queue_unavailable: "очередь закрытий недоступна",
  unresolved_vst_order_intents: "по прошлой сделке не завершена сверка с биржей",
  entry_market_mark_not_corroborated: "маркировочная цена VST расходилась с ценой в стакане",
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
    const blocked = BLOCKED_BY_TEXT[event?.detail?.blockedBy];
    if (blocked) lines.push(`Бот не мог начать вход: ${blocked}`);
    const exchangeText = event?.detail?.errorMessage;
    if (typeof exchangeText === "string" && exchangeText.trim()) {
      const clean = exchangeText.replace(/[^\p{L}\p{N}_:,.()·\- ]/gu, "").trim().slice(0, 200);
      if (clean) lines.push(`Ответ: ${clean}`);
    }
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
