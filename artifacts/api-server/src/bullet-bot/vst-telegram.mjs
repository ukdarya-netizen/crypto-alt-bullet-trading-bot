import {
  validateTelegramCredentials, postTelegramMessage, redactTelegramError,
} from "./telegram-client.mjs";
import { isSafeTickErrorSummary } from "./vst-tick-watchdog.mjs";
import { vstReadIncidentKey } from "./vst-diagnostics.mjs";
import {
  isSafeVstClientOrderId, isSafeVstExchangeOrderId,
} from "./vst-intent-diagnostics.mjs";

// Exchange-confirmed VST events are delivered independently of the trading worker.
// A crash between Telegram accepting a message and the DB acknowledgement can
// produce a duplicate; it must never make the trade itself fail or be replayed.
// Operational VST events are delivered independently of the trading worker.
// Internal queue telemetry is explicitly excluded from the Telegram outbox
// drain below and must never be treated as a user-facing notification.
// FAILURE_EVENT_KINDS below only decides whether a "Причина:" line is shown.
const FAILURE_EVENT_KINDS = [
  "vst_worker_error", "vst_signal_rejected", "vst_margin_top_up_unconfirmed",
  "vst_action_unresolved",
];
// Only fixed, reviewed explanations are sent; arbitrary broker exceptions
// stay in the ledger rather than being forwarded to Telegram.
const FAILURE_REASONS = new Map([
  ["Stop loss exceeds contract price precision", "точность стопа не соответствовала контракту"],
  ["VST mark is not corroborated by a fresh quote",
    "цена маркировки и свежая котировка BingX VST расходятся более чем на 0,5%"],
  ["VST quote moved beyond the permitted price-move limit",
    "текущая цена ушла слишком далеко от цены сигнала"],
  ["vst_margin_topup_lifecycle_not_verified",
    "для указанного стопа нужна дополнительная маржа, которую нельзя безопасно внести до открытия позиции"],
  ["preexisting_exchange_position_or_order",
    "на счёте уже есть позиция или заявка; новый вход заблокирован"],
  ["vst_order_rejected", "биржа отклонила заявку; исполнение не подтверждено"],
  ["vst_margin_top_up_state_not_verified",
    "результат добавления маржи не подтверждён; проверьте позицию и стоп на бирже"],
  ["vst_margin_top_up_not_confirmed",
    "добавление маржи не подтверждено; проверьте позицию и стоп на бирже"],
  ["bingx_vst_invalid_margin_top_up_isolated_margin_before",
    "биржа отклонила довнесение маржи для изолированной позиции; позиция и стоп требуют ручной проверки"],
  ["exchange_state_not_verified", "биржа не подтвердила исход операции; результат неизвестен"],
  ["raise_stop_equal_price_noop_confirmed", "цена уже установленного стопа совпала с рассчитанной; повторный ордер не нужен"],
  ["action_fill_unconfirmed", "исполнение операции не подтверждено биржей"],
  ["entry_verification_abandoned_confirmed_open_unprotected",
    "исполнение входа подтверждено, позиция ОТКРЫТА на бирже, но защитный стоп не подтверждён и НЕ будет выставлен автоматически -- бот больше не трогает эту позицию, нужна ручная проверка на BingX VST"],
  ["entry_abandoned_confirmed_flat_account",
    "по этому символу не найдены открытая позиция и активные заявки; это не означает, что баланс счёта нулевой"],
]);
// The three literal reasons above cover "entry"; the same abandon logic
// (vst-worker.mjs FLAT_ACCOUNT_ABANDON_OPERATIONS / CLOSE_ABANDON_OPERATIONS)
// applies to several other operations with a reason built from the
// operation name plus one of these exact suffixes. Enumerating every
// operation x suffix combination as its own reviewed FAILURE_REASONS
// literal would silently miss any operation added to those sets later;
// matching the suffix instead stays accurate for all of them without
// ever fabricating a claim past what the underlying evidence check
// (evaluateCloseAbandonEvidence / confirmedFlatAccount) already proved.
const ABANDON_FLAT_ACCOUNT_SUFFIX = "_abandoned_confirmed_flat_account";
const ABANDON_STILL_OPEN_SUFFIX = "_abandoned_confirmed_still_open";
const ABANDON_UNCONFIRMED_OUTCOME_SUFFIX = "_abandoned_unconfirmed_outcome";

function operationPrefix(reason, suffix) {
  return reason.endsWith(suffix) ? reason.slice(0, -suffix.length) : null;
}

// Only reached when FAILURE_REASONS has no exact literal for this reason
// (entry's own three reasons above are matched there first). Returns null
// -- never a guess -- for anything that isn't one of these reviewed
// abandon-outcome shapes, so an unrelated future reason still falls back
// to the generic "see the log" wording rather than a mismatched label.
function describeAbandonReason(reason) {
  if (typeof reason !== "string" || reason === "") return null;
  const flatOp = operationPrefix(reason, ABANDON_FLAT_ACCOUNT_SUFFIX);
  if (flatOp !== null) {
    const opText = OPERATION_TEXT.get(flatOp);
    return `по этому символу не найдены открытая позиция и активные заявки — ${opText ? `операция «${opText}»` : "операция"} больше не нужна; баланс счёта этим сообщением не оценивается`;
  }
  const stillOpenOp = operationPrefix(reason, ABANDON_STILL_OPEN_SUFFIX);
  if (stillOpenOp !== null) {
    const opText = OPERATION_TEXT.get(stillOpenOp);
    return `попытка${opText ? ` (${opText})` : ""} не подтвердилась, позиция осталась открытой без изменений; бот повторит действие при следующей проверке`;
  }
  const unconfirmedOp = operationPrefix(reason, ABANDON_UNCONFIRMED_OUTCOME_SUFFIX);
  if (unconfirmedOp !== null) {
    const opText = OPERATION_TEXT.get(unconfirmedOp);
    return `исход операции${opText ? ` «${opText}»` : ""} не подтверждён и не опровергнут; позиция переведена в статус ручной проверки, автоматические действия по ней остановлены`;
  }
  return null;
}
// Only the reasons evaluateVstPolicy actually emits get a distinct label;
// any other/future reason falls back to the generic wording below rather
// than silently mislabeling a stop raise this map doesn't know about yet.
const RAISE_STOP_REASON_TEXT = new Map([
  ["breakeven_stop", "стоп переведён в безубыток"],
  ["protected_profit_floor", "стоп поднят до защищённого уровня прибыли"],
  ["percentage_point_trailing_stop", "стоп подтянут трейлингом за ценой"],
  ["runner_percentage_point_trailing_stop", "стоп раннера подтянут трейлингом за ценой"],
]);
const OPERATION_TEXT = new Map([
  ["entry", "открытие позиции"],
  ["raise_stop", "перенос стопа"],
  ["cancel_original_stop", "отмена исходного общего стопа"],
  ["set_runner_break_even", "перенос стопа раннера"],
  ["close_leg", "закрытие части позиции"],
  ["close_pre_runner_split", "закрытие позиции до настройки runner"],
  ["split_core_stop", "настройка стопа основной части split"],
  ["split_runner_stop", "настройка стопа runner-части split"],
  ["margin_top_up", "довнесение маржи"],
  ["prepare_margin_mode", "подготовка изолированного режима маржи"],
  ["set_isolated_leverage", "настройка плеча"],
]);
const SIGNAL_STATUS_TEXT = new Map([
  ["pending", "в очереди"],
  ["planning", "планируется"],
  ["opening", "открывается"],
  ["open", "открыта"],
  ["closed", "закрыта"],
  ["rejected", "отклонён"],
  ["error", "ошибка"],
  ["unsupported", "не поддерживается"],
  ["unknown", "требует проверки"],
]);
const LOCK_NAMESPACE = 4_348_997;
const LOCK_ID = 1;

function numeric(value) {
  const text = String(value ?? "");
  return /^\d{1,16}(?:\.\d{1,12})?$/.test(text) ? text : null;
}

function signedPercent(value) {
  const parsed = Number(value);
  return value !== null && value !== undefined && Number.isFinite(parsed)
    ? `${parsed > 0 ? "+" : ""}${parsed.toFixed(4)}%` : null;
}

export function formatVstTelegramEvent(event) {
  const hasSignalSymbol = /^[A-Z0-9]{1,20}USDT$/.test(event.symbol ?? "");
  if (!hasSignalSymbol) {
    const timestamp = new Date(event.createdAt);
    return [
      "BingX VST · системное событие без сигнала",
      "Событие записано в журнал VST; подробности доступны владельцу в журнале.",
      Number.isFinite(timestamp.getTime()) ? `Событие: ${timestamp.toISOString()}` : null,
    ].filter(Boolean).join("\n");
  }
  const symbol = event.symbol;
  const details = event.detail ?? {};
  const outcome = event.outcome ?? {};
  const operation = event.request?.operation ?? outcome.operation;
  const qty = numeric(details.fillQuantity ?? details.quantity ?? details.totalQuantity ??
    details.fill?.quantity ?? outcome.fill?.quantity ??
    (event.kind === "vst_stop_protection_adopted" ? details.adoptedProtection?.quantity : undefined));
  const price = numeric(details.fillPrice ?? details.fill?.price ?? outcome.fill?.price);
  const stopPrice = numeric(event.request?.stopPrice ?? details.stopPrice ?? details.initialStop ??
    (event.kind === "vst_stop_protection_adopted" ? details.adoptedProtection?.stopPrice : undefined));
  const isVerifiedEntry = [
    "vst_entry_verified",
    "vst_entry_margin_top_up_pending",
    "vst_impulse_entry_margin_top_up_pending",
    "vst_impulse_entry_verified_split_pending",
  ].includes(event.kind);
  const raiseReasonText = RAISE_STOP_REASON_TEXT.get(event.request?.reason);
  let action;
  switch (event.kind) {
    case "vst_pre_runner_close_retry_limit":
      action = "Автоповторы закрытия остановлены после 3 подтверждённых неудач при неизменных позиции и стопах. Позиция не считается закрытой; нужна проверка владельца";
      break;
    case "vst_position_management_diagnostic":
      action = details.scope === "symbol"
        ? "Ошибка проверки этой позиции изолирована по символу. Полная безопасная диагностика сохранена; остальные символы могут обрабатываться"
        : "Ошибка ведения позиции: обработка остановлена, так как безопасность локального продолжения не доказана. Полная безопасная диагностика сохранена";
      break;
    case "vst_entry_verified":
      action = "Открыта позиция (вход и защитный стоп подтверждены BingX VST)";
      break;
    case "vst_entry_margin_top_up_pending":
    case "vst_impulse_entry_margin_top_up_pending":
      action = "Позиция ОТКРЫТА на BingX VST: вход и исходный стоп подтверждены; дополнительная маржа ещё НЕ подтверждена. До её добавления ликвидация может опередить стоп";
      break;
    case "vst_margin_top_up_verified":
      action = "В истории BingX VST наблюдается уникальная запись добавления маржи; биржа не позволяет определить, отправил ли именно бот POST или это было отдельное ручное действие. Защита позиции проверена как безопасная; не отправляйте повторную заявку";
      break;
    case "vst_margin_top_up_funded_but_unsafe":
      action = "В истории BingX VST наблюдается уникальная запись добавления маржи, но безопасность защиты позиции не подтверждена. Биржа не позволяет определить, отправил ли именно бот POST или это было отдельное ручное действие. Не отправляйте повторную заявку; вручную проверьте позицию и стоп на BingX";
      break;
    case "vst_impulse_entry_verified_split_pending":
      action = "Позиция ОТКРЫТА на BingX VST; настройка защиты частей ещё продолжается";
      break;
    case "vst_impulse_split_phase_verified":
      action = details.stage === "complete"
        ? "Изменена защита позиции: стопы обеих частей подтверждены"
        : "Подтверждён этап настройки защитных стопов";
      break;
    case "vst_action_reconciled":
      if (operation === "close_leg") {
        const closedFully = event.request?.nextPolicy?.status === "closed";
        action = event.request?.reason === "runner_max_age_expiry"
          ? "Раннер закрыт на BingX VST по истечении максимального срока удержания"
          : closedFully
            ? "Позиция закрыта на BingX VST" : "Часть позиции закрыта на BingX VST";
      } else if (operation === "raise_stop" || operation === "set_runner_break_even") {
        action = raiseReasonText
          ? `Защитный стоп позиции изменён на BingX VST (${raiseReasonText})`
          : "Изменён защитный стоп позиции на BingX VST";
      } else {
        action = "Изменение позиции подтверждено BingX VST";
      }
      break;
    case "vst_original_stop_cancel_pre_mutation_read_refused":
      action = "Обработка отмены исходного общего стопа восстановлена: исходная отмена не отправлялась, защитные стопы подтверждены. Следующая операция требует свежих проверок";
      break;
    case "vst_raise_stop_pre_upgrade_refusal_confirmed":
      action = "Обработка переноса стопа восстановлена: отказ произошёл до изменения на бирже; открытая позиция и действующий стоп подтверждены. Новое изменение требует свежих проверок";
      break;
    case "vst_raise_stop_refusal_settled_after_closed_fill":
      action = "Зависшая проверка переноса стопа завершена после подтверждённого закрытия биржевым стопом; исходный перенос не отправлялся, результат закрытия сохранён";
      break;
    case "vst_triggered_stop_verified":
      action = "Позиция закрыта защитным стопом на BingX VST";
      break;
    case "vst_impulse_triggered_stop_verified":
      action = numeric(details.residualQuantity) && Number(details.residualQuantity) > 0
        ? "Часть позиции закрыта защитным стопом на BingX VST"
        : "Позиция закрыта защитным стопом на BingX VST";
      break;
    case "vst_impulse_runner_fill_cleanup_pending":
      action = details.originalCancellationConfirmed === true
        ? "Исполнение стопа раннера учтено; отмена исходного общего стопа подтверждена, остаток позиции защищён подтверждённым стопом ядра; очистка завершена"
        : "Исполнение стопа раннера учтено; защита остатка и отмена исходного общего стопа требуют свежей проверки";
      break;
    case "vst_impulse_partial_close_cleanup_pending":
      action = "Часть позиции закрыта; проверка защиты остатка продолжается";
      break;
    case "vst_impulse_runner_cleanup_completed":
    case "vst_impulse_split_cleanup_verified":
      action = "Защита оставшейся части позиции проверена";
      break;
    case "vst_impulse_sole_split_leg_closed":
    case "vst_impulse_full_split_position_closed":
      action = "Позиция закрыта на BingX VST";
      break;
    case "vst_impulse_flat_close_cleanup_pending":
      action = "Позиция закрыта; отмена оставшихся стоп-заявок продолжается";
      break;
    case "vst_impulse_flat_stops_cleaned":
      action = "После закрытия позиции оставшиеся стоп-заявки отменены";
      break;
    case "vst_impulse_split_stop_upgrade_completed":
    case "vst_impulse_sole_core_stop_raised":
      action = raiseReasonText
        ? `Защитный стоп позиции повышен на BingX VST (${raiseReasonText})`
        : "Защитный стоп позиции повышен на BingX VST";
      break;
    case "vst_worker_error":
      action = "Ошибка обработки сигнала. Эта ошибка сама по себе не доказывает ни исполнения, ни отсутствия сделки; проверьте позицию и заявки на BingX VST";
      break;
    case "vst_signal_rejected":
      action = "Сигнал отклонён. Открытие позиции НЕ подтверждено";
      break;
    case "vst_margin_top_up_unconfirmed":
      action = details.uncertainty?.classification === "known_uncertainty"
        ? "Вход подтверждён, добавление маржи НЕ подтверждено. Повторный POST запрещён; бот проверяет полную историю корректировок и защиту этой позиции. Другие инструменты продолжают работать."
        : "Вход подтверждён, но добавление маржи НЕ подтверждено. Проверьте позицию и стоп на BingX VST; бот остановил новые действия";
      break;
    case "vst_raise_stop_equal_price_noop_confirmed":
      action = details.noWriteConfirmed === true && details.outcome === "equal_price_noop"
        ? "Лишний перенос стопа завершён без отправки ордера: нужная цена уже была установлена. Свежая проверка подтвердила неизменную позицию и тот же активный стоп. Новый перенос или исполнение ордера этим событием не подтверждаются."
        : "Получено событие проверки лишнего переноса стопа; результат требует проверки в журнале.";
      break;
    case "vst_stop_protection_adopted":
      action = "Восстановлен учёт действующего защитного стопа по свежим данным BingX VST. Позиция остаётся открытой. Повторный ордер или отмена стопа не отправлялись; исполнение исходного переноса не приписывается этой операции";
      break;
    case "vst_stop_protection_degraded":
      action = `Действующий защитный стоп ${details.verifiedStopPrice ?? "—"} независимо подтверждён. Усиление до ${details.requestedStopPrice ?? "—"} отложено: исходный POST остаётся неизвестным. Ожидание снято атомарно, повторные стопы, отмены и добавления маржи запрещены; мониторинг и другие инструменты продолжают работать.`;
      break;
    case "vst_stop_degraded_protection_observed":
      action = "Запрошенная усиленная защита теперь независимо подтверждена на BingX VST. Это наблюдение действующего стопа, а не доказательство исполнения исходного POST. Изоляция неподтверждённых записей сохраняется; ордера не повторялись и стопы не отменялись.";
      break;
    case "vst_action_unresolved": {
      const opText = OPERATION_TEXT.get(details.operation) ?? details.operation;
      action = details.uncertainty?.classification === "known_uncertainty"
        ? `Известная неопределённость BingX VST (${opText ?? "операция"}). Бот изолировал неподтверждённые эффекты и продолжает ограниченные проверки; повторная отправка не разрешена. Источник сигнала не является доказательством биржевого исполнения.`
        : opText
        ? `Действие на BingX VST не подтверждено (${opText}). Сигнал помечен как «неизвестно»; проверьте позицию и заявки на бирже вручную`
        : "Действие на BingX VST не подтверждено. Сигнал помечен как «неизвестно»; проверьте позицию и заявки на бирже вручную";
      break;
    }
    case "vst_signal_status_changed": {
      const from = SIGNAL_STATUS_TEXT.get(details.from) ?? details.from ?? "неизвестно";
      const to = SIGNAL_STATUS_TEXT.get(details.to) ?? details.to ?? "неизвестно";
      action = `Статус сигнала изменён: ${from} → ${to}`;
      break;
    }
    case "exchange_history_provenance":
      action = "Позиция ЗАКРЫТА. Полный вход и выход подтверждены историей BingX; закрытие восстановлено в журнале. Повторная заявка на закрытие не нужна.";
      break;
    case "source_exit_completed":
      action = details.closureOrigin === "already_committed_exchange_history"
        ? "Команда сигнального бота завершена: позиция уже подтверждённо закрыта на BingX. Новых торговых заявок не отправлялось."
        : "Сверка команды сигнального бота завершена; результат сохранён в журнале.";
      break;
    // Every other recorded event still reaches the owner instead of being
    // silently dropped -- this bot must never process a signal without a
    // Telegram trace, even for a kind this formatter has no dedicated,
    // reviewed wording for yet.
    default:
      action = `Событие BingX VST: ${String(event.kind).replace(/^vst_/, "").replace(/_/g, " ")}`;
      break;
  }
  const timestamp = new Date(event.createdAt);
  const hasReason = typeof details.reason === "string" && details.reason !== "";
  return [
    `BingX VST · ${symbol}`,
    action,
    (FAILURE_EVENT_KINDS.includes(event.kind) || hasReason)
      ? `Причина: ${FAILURE_REASONS.get(details.reason) ?? describeAbandonReason(details.reason) ?? "подробности в журнале VST"}`
      : null,
    qty ? `Количество: ${qty}` : null,
    price ? `Цена исполнения: ${price}` : null,
    isVerifiedEntry && numeric(details.signalReferencePrice)
      ? `Цена сигнала: ${numeric(details.signalReferencePrice)}` : null,
    isVerifiedEntry && numeric(details.planningQuotePrice)
      ? `Котировка для расчёта: ${numeric(details.planningQuotePrice)}${
          typeof details.planningQuoteObservedAt === "string"
            ? ` · ${details.planningQuoteObservedAt}` : ""
        }` : null,
    isVerifiedEntry && signedPercent(details.signalPriceDeviationPct)
      ? `Отклонение котировки от сигнала: ${signedPercent(details.signalPriceDeviationPct)}` : null,
    isVerifiedEntry && typeof details.verifiedFillAt === "string"
      ? `Время исполнения: ${details.verifiedFillAt}` : null,
    isVerifiedEntry && signedPercent(details.actualFillDeviationPct)
      ? `Отклонение подтверждённого исполнения от сигнала: ${signedPercent(details.actualFillDeviationPct)}` : null,
    isVerifiedEntry ? "MARKET не гарантирует верхнюю цену исполнения." : null,
    stopPrice ? `Стоп: ${stopPrice}` : null,
    Number.isFinite(timestamp.getTime()) ? `Событие: ${timestamp.toISOString()}` : null,
  ].filter(Boolean).join("\n");
}

const BLOCKED_REASONS = new Map([
  ["vst_worker_tick_stalled",
    "текущий одиночный цикл ещё выполняется; проверьте позиции и активные стоп-заявки на BingX — защита этим уведомлением не подтверждается"],
  ["vst_worker_error",
    "цикл завершился с ошибкой; состояние позиций и защитных стопов этим уведомлением не подтверждается — проверьте их на BingX VST"],
  ["impulse_full_split_close_requires_reconciliation",
    "результат закрытия перед настройкой runner требует сверки с биржей; повторная отправка без подтверждения запрещена"],
  ["managed_position_read_unavailable",
    "не удалось получить или подтвердить свежие данные биржи; действие по этому инструменту отложено до следующей проверки. Это не доказывает отсутствие позиции или стопа"],
  ["impulse_split_ledger_read_unavailable",
    "не удалось прочитать сохранённое состояние split-защиты; продолжение настройки отложено"],
  ["close_pre_runner_split_pre_transport_refusal_confirmed_still_open",
    "закрытие не отправлялось; свежая проверка подтвердила неизменную позицию и защитные стопы"],
  ["pending_vst_signals_waiting",
    "безопасная проверка возможностей VST не завершена; входы по ожидающим сигналам не отправлялись"],
  ["unresolved_vst_order_intents",
    "есть незавершённое действие бота; его исход требует сверки с BingX VST"],
  ["vst_margin_top_up_requires_verified_reconciliation",
    "пополнение маржи ещё не подтверждено биржей"],
  ["unsupported_vst_broker_capabilities_unverified_or_wrong_environment",
    "биржа сообщает неожиданное окружение, или возможности VST не подтверждены"],
  ["position_management_unsupported_or_unverified",
    "открытая позиция VST требует ручной проверки -- бот не может подтвердить её состояние на бирже"],
]);

// Only fixed explanations for worker-reviewed recovery statuses are shown.
// In particular, never forward provider or database text from this field.
const RECOVERY_DEFERRED_REASON_TEXT = new Map([
  ["close_pre_runner_split_mutation_provenance_missing",
    "нет проверенного доказательства, что биржевое изменение до этого не отправлялось; повтор запрещён до безопасной сверки"],
  ["close_pre_runner_split_current_proof_mismatch",
    "свежая проверка позиции или защитных стопов не совпала с ожидаемым состоянием; закрытие отложено"],
  ["unresolved_intent_reconciliation_read_failed",
    "не удалось выполнить свежие чтения биржи для сверки незавершённого действия"],
  ["unresolved_intent_evidence_unverified",
    "имеющихся доказательств недостаточно, чтобы подтвердить исход действия или безопасно повторить его"],
  ["raise_stop_position_read_unavailable",
    "не удалось прочитать сохранённое состояние позиции для проверки переноса стопа"],
  ["raise_stop_persisted_position_changed",
    "сохранённое состояние позиции изменилось; проверка переноса стопа отложена"],
  ["raise_stop_entry_proof_not_linked_or_fresh",
    "не удалось подтвердить свежую связь исполнения входа с позицией"],
  ["raise_stop_entry_proof_read_unavailable",
    "не удалось прочитать подтверждение исполнения входа"],
  ["raise_stop_entry_proof_mismatch",
    "подтверждение исполнения входа не совпало с ожидаемой позицией"],
  ["raise_stop_position_snapshot_mismatch",
    "данные позиции не совпали с сохранённым снимком"],
  ["raise_stop_old_stop_snapshot_mismatch",
    "исходный защитный стоп не совпал с сохранённым состоянием"],
  ["raise_stop_read_only_proof_budget_exceeded",
    "превышен лимит времени свежей проверки переноса стопа"],
  ["raise_stop_account_state_unavailable",
    "не удалось прочитать состояние счёта для проверки переноса стопа"],
  ["raise_stop_account_state_unverified",
    "состояние счёта не подтверждено для проверки переноса стопа"],
  ["raise_stop_account_position_mismatch",
    "позиция на счёте не совпала с ожидаемой позицией"],
  ["raise_stop_old_stop_exchange_state_mismatch",
    "текущее состояние позиции или исходного стопа на бирже не совпало с ожидаемым"],
  ["raise_stop_recovery_compare_and_set_changed",
    "сохранённое состояние изменилось до записи результата сверки"],
  ["raise_stop_recovery_store_unavailable",
    "не удалось сохранить результат сверки переноса стопа"],
  ["original_stop_cancel_pre_read_proof_unavailable",
    "не удалось получить полное свежее подтверждение позиции и защитных стопов"],
  ["original_stop_cancel_position_changed",
    "состояние позиции изменилось во время проверки отмены исходного стопа"],
  ["original_stop_cancel_stops_changed",
    "состав или состояние защитных стопов изменилось во время проверки"],
  ["original_stop_cancel_read_only_budget_exceeded",
    "превышен лимит времени свежей проверки отмены исходного стопа"],
  ["original_stop_cancel_recovery_compare_and_set_changed",
    "сохранённое состояние изменилось до записи результата восстановления отмены"],
  ["original_stop_cancel_recovery_store_unavailable",
    "не удалось сохранить результат восстановления отмены исходного стопа"],
]);

function readFailureMeaning(diagnostic) {
  if (diagnostic?.schemaVersion !== 1) return null;
  const meanings = {
    market_mark_unverified: "текущая mark price не прошла проверку свежести или согласованности с котировками; бот не использует неподтверждённую цену",
    exchange_transport_error: "не удалось получить ответ биржи; новое состояние по этому чтению не подтверждено",
    exchange_provider_error: "биржа вернула ошибку при чтении данных; новое состояние по этому чтению не подтверждено",
    invalid_exchange_response: "ответ биржи не прошёл проверку данных; новое состояние по этому чтению не подтверждено",
  };
  return Object.hasOwn(meanings, diagnostic.reason) ? meanings[diagnostic.reason] : null;
}

export function formatVstReadIncidentAlert(info) {
  const safeSymbols = (values) => Array.isArray(values)
    ? [...new Set(values.filter((value) =>
      typeof value === "string" && /^[A-Z0-9]{1,24}USDT$/.test(value)))].sort()
    : [];
  const symbols = safeSymbols(info.symbols);
  const active = safeSymbols(info.activeSymbols);
  const diagnostic = vstReadIncidentKey(info.diagnostic, {
    reason: "managed_position_read_unavailable", scope: "symbol",
    operation: info.diagnostic?.operation,
    symbol: info.diagnostic?.symbol,
  }) ? info.diagnostic : null;
  const refs = Array.isArray(info.diagnosticRefs) ? info.diagnosticRefs
    .filter((ref) => typeof ref === "string" && /^[a-f0-9]{12}$/.test(ref)).slice(0, 20) : [];
  const minutes = Number.isFinite(info.blockedForMs)
    ? Math.max(0, Math.floor(info.blockedForMs / 60_000)) : 0;
  const count = Number.isSafeInteger(info.occurrences) && info.occurrences > 0
    ? info.occurrences : 0;
  return [
    info.incidentStatus === "recovered"
      ? "BingX VST · чтение восстановлено"
      : info.incidentStatus === "changed"
      ? "BingX VST · причина сбоя чтения изменилась"
      : info.incidentStatus === "summary"
      ? "BingX VST · сводка повторного сбоя чтения"
      : "BingX VST · одинаковый сбой чтения",
    info.incidentStatus === "recovered"
      ? "Ранее неудавшиеся чтения снова проходят проверку. Это не подтверждает исполнение каких-либо ордеров."
      : info.incidentStatus === "changed"
      ? "Прежний сбой больше не наблюдается в текущих проверках, но восстановление не подтверждено. Новые и критичные причины предупреждаются отдельно."
      : "Объединены только одинаковые подтверждённые причины ошибки чтения. Неопределённые ордера и проблемы защиты предупреждаются отдельно.",
    `Длительность: ${minutes} мин.; наблюдений сбоя: ${count}; повторов: ${Math.max(0, count - 1)}.`,
    symbols.length ? `Затронутые инструменты: ${symbols.join(", ")}` : null,
    active.length ? `Сбой чтения сохраняется: ${active.join(", ")}` : null,
    diagnostic ? `Класс: ${diagnostic.errorClass}; этап: ${diagnostic.stage}; проверка: ${diagnostic.check}` : null,
    diagnostic ? `API: ${diagnostic.apiMethod}; GET ${diagnostic.endpoint ?? diagnostic.requestEndpoint}` : null,
    diagnostic ? `Причина: ${readFailureMeaning(diagnostic) ?? "данные биржи не прошли проверку; подробности по ссылке диагностики"}${diagnostic.validationField ? `; поле: ${diagnostic.validationField}` : ""}` : null,
    info.incidentStatus !== "recovered"
      ? "Из-за этого чтения не выполняется зависящее от него действие. Сообщение не доказывает исчезновение стопа или закрытие позиции; бот повторяет безопасные проверки, а не неопределённые ордера."
      : null,
    refs.length ? `Диагностика: ${refs.map((ref) => `[ref:${ref}]`).join(", ")}` : null,
    "Сводка меняет только уведомления; торговые ограничения и проверки сохранены.",
  ].filter(Boolean).join("\n");
}

export function formatVstBlockedAlert({
  reason, blockedForMs, count, sourceSignalId, symbol, operation,
  entryNotSubmitted = false, errorSummary, recoveryDeferredReason, scope,
  diagnosticRef, phase, state, clientOrderId, exchangeOrderId,
  originalDiagnostic, symbolUnresolvedCount, accountUnresolvedCount,
  lastAttemptAt, lastAttemptAgeMs, diagnostic,
}) {
  const minutes = Math.max(1, Math.round(Number(blockedForMs) / 60_000));
  const safeReason = typeof reason === "string" && reason ? reason : "unknown_reason";
  const pendingSignalsWaiting = safeReason === "pending_vst_signals_waiting";
  const longRunningTick = safeReason === "vst_worker_tick_stalled";
  const workerError = safeReason === "vst_worker_error";
  const readFailure = safeReason === "managed_position_read_unavailable";
  // A rejection marker alone does not prove that an exchange write was never
  // attempted. Keep the unresolved-intent wording neutral in all cases.
  const explanation = BLOCKED_REASONS.get(safeReason) ??
    "безопасность VST не подтверждена; подробности в журнале";
  const safeSymbol = /^[A-Z0-9]{1,20}USDT$/.test(symbol ?? "") ? symbol : null;
  const safeOperation = typeof operation === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/.test(operation) ? operation : null;
  const opText = OPERATION_TEXT.get(safeOperation) ?? null;
  const safePhase = typeof phase === "string" &&
    /^[a-z][a-z0-9_-]{0,95}$/.test(phase) ? phase : null;
  const safeState = ["prepared", "submitted", "unknown"].includes(state) ? state : null;
  const safeSignalId = safeReason === "unresolved_vst_order_intents"
    ? typeof sourceSignalId === "string" && /^cab-signal-\d{1,16}$/.test(sourceSignalId)
      ? sourceSignalId : null
    : typeof sourceSignalId === "string" ? sourceSignalId : null;
  const safeClientOrderId = isSafeVstClientOrderId(clientOrderId) ? clientOrderId : null;
  const safeExchangeOrderId = isSafeVstExchangeOrderId(exchangeOrderId) ? exchangeOrderId : null;
  const safeOriginal = originalDiagnostic &&
    ["Error", "TypeError", "RangeError", "BingXLiveApiError", "BingXApiError"]
      .includes(originalDiagnostic.errorClass) &&
    ["exchange_provider_error", "invalid_exchange_response", "internal_exception",
      "exchange_transport_error", "entry_fills_unverified",
      "submission_provenance_unavailable"].includes(originalDiagnostic.reason)
    ? originalDiagnostic : null;
  const originalReasonText = safeOriginal?.reason === "submission_provenance_unavailable"
    ? "исходная ошибка не сохранена; её причину нельзя установить по этой записи"
    : safeOriginal?.code === "109400"
    ? "код BingX 109400: биржа отклонила запрос из-за некорректной временной метки"
    : safeOriginal?.code === "109421"
      ? "код BingX 109421: биржа не нашла заявку"
      : safeOriginal?.reviewedReason === "bingx_vst_entry_history_fills_unverified" ||
        safeOriginal?.reason === "entry_fills_unverified"
        ? "bingx_vst_entry_history_fills_unverified"
        : safeOriginal?.providerReason === "timestamp_invalid"
          ? "биржа сообщила: некорректная временная метка"
          : safeOriginal?.providerReason === "order_not_found"
            ? "биржа сообщила: заявка не найдена"
            : safeOriginal?.providerReason === "position_not_found"
              ? "биржа сообщила: позиция не найдена" : null;
  const originalApiText = safeOriginal &&
    ["GET", "POST", "DELETE", "PUT"].includes(safeOriginal.method) &&
    typeof safeOriginal.endpoint === "string" &&
    /^\/openApi\/swap\/v[123]\/[a-zA-Z0-9/]+$/.test(safeOriginal.endpoint)
    ? `${safeOriginal.method} ${safeOriginal.endpoint}${safeOriginal.httpStatus ? ` · HTTP ${safeOriginal.httpStatus}` : ""}`
    : null;
  // Explicit scope reflects the worker's isolation boundary. Keep legacy
  // unresolved-intent alerts compatible, but a symbol alone is not proof of
  // local scope and must never override an account-wide safety incident.
  const scopedToSymbol = Boolean(safeSymbol) &&
    (scope === "symbol" ||
      (scope === undefined &&
        (safeReason === "unresolved_vst_order_intents" ||
          safeReason === "vst_margin_top_up_requires_verified_reconciliation")));
  const safeWorkerErrorSummary = isSafeTickErrorSummary(errorSummary)
    ? errorSummary : null;
  const readMeaning = readFailure && diagnostic?.symbol === safeSymbol
    ? readFailureMeaning(diagnostic) : null;
  const recoveryDeferredText =
    RECOVERY_DEFERRED_REASON_TEXT.get(recoveryDeferredReason) ?? null;
  return [
    workerError
      ? "BingX VST · ошибка торгового цикла"
      : pendingSignalsWaiting
      ? "BingX VST · сигналы ожидают проверки"
      : readFailure && scopedToSymbol
      ? `BingX VST · ${safeSymbol}: свежие данные не подтверждены`
      : scopedToSymbol
      ? `BingX VST · ${safeSymbol} требует вмешательства`
      : longRunningTick
      ? "BingX VST · торговый цикл выполняется дольше обычного"
      : "BingX VST · исполнение сигналов остановлено",
    workerError
      ? "Обработка цикла завершилась ошибкой; проверьте позицию и заявки на бирже вручную."
      : pendingSignalsWaiting
      ? `Сигналы ждут уже ${minutes} мин.; входы по ним не отправлялись.`
      : readFailure && scopedToSymbol
      ? `Неудачные проверки ${safeSymbol} наблюдаются ${minutes} мин. Зависящее от этих данных действие отложено; бот повторяет проверку. Другие инструменты обрабатываются при успешных проверках счёта.`
      : scopedToSymbol
      ? `${safeSymbol} не удаётся обработать уже ${minutes} мин. Эта проблема не блокирует другие инструменты; их обработка продолжается при успешных проверках счёта.`
      : longRunningTick
      ? `Текущий цикл идёт уже ${minutes} мин. Новые сигналы ждут его завершения и пока не рассмотрены; это не означает, что бот полностью остановился.`
      : `Конвейер заблокирован уже ${minutes} мин. и не обрабатывает новые сигналы`,
    `Причина: ${readMeaning ?? explanation}`,
    readFailure ? "Это сбой получения или проверки данных, а не подтверждённая потеря стопа и не доказательство отправки ордера." : null,
    recoveryDeferredText ? `Сверка отложена: ${recoveryDeferredText}` : null,
    workerError && safeWorkerErrorSummary
      ? `Ошибка: ${safeWorkerErrorSummary}` : null,
    safeReason === "unresolved_vst_order_intents" &&
      Number.isSafeInteger(symbolUnresolvedCount) && symbolUnresolvedCount > 0
      ? `Незавершённых действий по ${safeSymbol ?? "инструменту"}: ${symbolUnresolvedCount}`
      : null,
    safeReason === "unresolved_vst_order_intents" &&
      Number.isSafeInteger(accountUnresolvedCount) && accountUnresolvedCount > 0
      ? `Всего незавершённых действий на счёте: ${accountUnresolvedCount}`
      : Number.isFinite(count) && count > 0
      ? pendingSignalsWaiting
        ? `Ожидающих сигналов: ${count}`
        : readFailure
        ? `Инструментов с неподтверждёнными данными: ${count}`
        : `Незавершённых действий: ${count}`
      : null,
    safeSignalId ? `Сигнал: ${safeSignalId}` : null,
    safeSymbol ? `Инструмент: ${safeSymbol}` : null,
    opText ? `Операция: ${opText}` : null,
    !opText && safeReason === "unresolved_vst_order_intents" && safeOperation
      ? `Операция: технический код ${safeOperation}` : null,
    safePhase ? `Этап: ${safePhase}` : null,
    safeState ? `Состояние действия: ${safeState}` : null,
    safeClientOrderId ? `ID действия: ${safeClientOrderId}` : null,
    safeExchangeOrderId ? `ID биржевой заявки: ${safeExchangeOrderId}` : null,
    originalReasonText ? `Первоначальная причина: ${originalReasonText}` : null,
    originalApiText ? `Исходный запрос: ${originalApiText}` : null,
    typeof lastAttemptAt === "string" && Number.isFinite(Date.parse(lastAttemptAt))
      ? `Последняя попытка: ${new Date(lastAttemptAt).toISOString()}${
          Number.isFinite(lastAttemptAgeMs)
            ? ` · ${Math.floor(Math.max(0, lastAttemptAgeMs) / 60_000)} мин. назад` : ""
        }` : null,
    typeof diagnosticRef === "string" && /^[a-f0-9]{12}$/.test(diagnosticRef)
      ? `Диагностика: [ref:${diagnosticRef}]` : null,
  ].filter(Boolean).join("\n");
}

// A direct, immediate alert for a stuck pipeline -- deliberately separate
// from createVstTelegramNotifier's durable per-event queue below. That queue
// requires every event to join to a real vst_signals row, which a
// worker-level "we've been blocked" condition does not have; and "blocked
// for N minutes" needs its own in-memory duration tracking regardless (see
// vst-worker.mjs), which the DB queue does not provide either. Losing an
// alert to a rare crash right at the threshold is an acceptable trade-off
// against the alternative this replaces: no notification at all.
export function createVstBlockedAlerter({ token, chatId, fetcher = fetch }) {
  validateTelegramCredentials(token, chatId);
  return {
    async send(info) {
      try {
        const text = info.reason === "vst_read_incident"
          ? formatVstReadIncidentAlert(info) : formatVstBlockedAlert(info);
        // Telegram's hard limit must not discard a large affected-symbol list.
        for (let offset = 0; offset < text.length; offset += 3900) {
          await postTelegramMessage({
            token, chatId, text: text.slice(offset, offset + 3900), fetcher,
          });
        }
      } catch (error) {
        throw new Error(redactTelegramError(error));
      }
    },
  };
}

export function createVstEntryHealthAlerter({ token, chatId, fetcher = fetch }) {
  validateTelegramCredentials(token, chatId);
  return {
    async send(info) {
      try {
        await postTelegramMessage({
          token, chatId, fetcher,
          text: `BingX VST · систематические отказы входа\n` +
            `Новый пересчёт сайзинга · последние 24 часа\n` +
            `final_quote_out_of_bounds: ${info.refusals}/${info.attempts} (${info.refusalPct}%)\n` +
            `Максимальное время от пересчёта до допуска к отправке: ${info.max_sizing_age_at_submit_ms ?? "нет данных"} мс\n` +
            `Проверьте задержку после пересчёта. Ценовой буфер автоматически не расширяется.`,
        });
      } catch (error) {
        throw new Error(redactTelegramError(error));
      }
    },
  };
}

const DISCREPANCY_LEDGER_LABEL = new Map([["vst", "VST"], ["real", "REAL"], ["source", "Источник"]]);
const DISCREPANCY_KIND_LABEL = new Map([
  ["source_closed_while_local_active",
    "источник (Bullet) подтвердил закрытие сигнала, а локальная запись ещё не закрыта"],
  ["source_signal_id_mismatch", "сигнал источника не совпадает по id с локальной позицией"],
  ["symbol_mismatch", "символ источника не совпадает с локальной позицией"],
  ["source_updated_at_stale", "дата последнего изменения записи отсутствует или старше 10 минут; сама по себе она не доказывает сбой опроса"],
  ["source_contract_unavailable", "не удалось получить корректный ответ position-sync"],
  ["source_action_review", "источник запросил проверку, а не закрытие"],
  ["source_action_unknown", "источник не определил действие; команда закрытия отсутствует"],
  ["source_missing", "в полном ответе источника нет записи с этим sourceSignalId; это не команда закрытия"],
  ["source_status_unverified", "состояние источника не подтверждает закрытие"],
]);

// Neither a source snapshot nor this alert is exchange fill evidence. VST
// closes through its guarded executor; REAL remains unauthorized.
export function formatSourceDiscrepancyAlert(items) {
  const lines = ["BingX · расхождение с источником сигналов"];
  for (const item of items) {
    const ledger = DISCREPANCY_LEDGER_LABEL.get(item.ledger) ?? item.ledger;
    let explanation = DISCREPANCY_KIND_LABEL.get(item.kind) ?? item.kind;
    if (item.kind === "source_contract_unavailable") {
      if ([401, 403].includes(item.httpStatus)) {
        explanation = `position-sync отказал в доступе: HTTP ${item.httpStatus}. Проверьте авторизацию x-trading-token; наличие старых входящих сигналов не подтверждает доступ к этому опросу.`;
      } else if (item.failureCode === "source_action_contract_not_published") {
        explanation = "в полученном ответе position-sync отсутствует обязательный sourceAction. Ответ не соответствует новому контракту; проверьте версию источника.";
      } else if (item.failureCode === "invalid_source_action") {
        explanation = "ответ position-sync содержит недопустимый sourceAction или несовместимые с ним статус/дату закрытия.";
      }
    }
    lines.push(
      item.ledger === "source" ? `${ledger} · position-sync` :
        `${ledger} · ${item.localSymbol ?? "?"} (${item.sourceSignalId})`,
      `  ${explanation}`,
    );
    if (item.sourceAction != null || item.sourceStatus != null) lines.push(
      `  Источник: ${item.sourceAction ?? "действие неизвестно"} / ${item.sourceStatus ?? "статус неизвестен"}`,
    );
    if (item.localStatus != null) lines.push(`  Локальная запись: ${item.localStatus}`);
    if (item.kind === "symbol_mismatch") lines.push(
      `  Символ источника: ${item.sourceSymbol ?? "не указан"}; локальный: ${item.localSymbol ?? "не указан"}`,
    );
    if (item.sourceReportedSignalId != null) lines.push(`  ID в ответе: ${item.sourceReportedSignalId}`);
    if (item.sourceClosedAt != null) lines.push(`  Источник указал закрытие: ${item.sourceClosedAt}`);
    if (item.sourceUpdatedAt != null) lines.push(`  Запись источника изменена: ${item.sourceUpdatedAt}`);
    if (item.sourceAsOf != null) lines.push(`  Данные источника на: ${item.sourceAsOf}`);
    if (item.observedAt != null) lines.push(`  Сверка: ${item.observedAt}`);
  }
  if (items.some(item => item.ledger === "real")) lines.push("REAL: Требуется ручная проверка позиции. Исполнение не разрешено.");
  else if (items.some(item => item.kind === "source_closed_while_local_active")) {
    lines.push("VST: бот должен закрыть остаток после проверки биржевой позиции. До подтверждения исполнения локальная запись не помечается закрытой.");
  } else if (items.some(item => ["source_signal_id_mismatch", "symbol_mismatch"].includes(item.kind))) {
    lines.push("Данные с несовпадающей идентичностью не используются для закрытия или переноса стопа.");
  }
  return lines.join("\n");
}

export function createSourceDiscrepancyAlerter({ token, chatId, fetcher = fetch }) {
  validateTelegramCredentials(token, chatId);
  return {
    async send(items) {
      if (!Array.isArray(items) || items.length === 0) return;
      try {
        await postTelegramMessage({
          token, chatId, text: formatSourceDiscrepancyAlert(items), fetcher,
        });
      } catch (error) {
        throw new Error(redactTelegramError(error));
      }
    },
  };
}

export function formatSourceSyncLivenessAlert({ kind, severity, staleForMs, failure } = {}) {
  const minutes = Math.max(1, Math.round(Number(staleForMs) / 60_000));
  if (kind === "recovered") {
    return [
      "Источник сигналов · синхронизация восстановлена",
      "Два свежих полных снимка поставлены в очередь с интервалом не менее 30 секунд.",
      "Исполнение закрытий PAPER/VST подтверждается отдельно.",
    ].join("\n");
  }
  return [
    severity === "critical"
      ? "Источник сигналов · критическая задержка синхронизации"
      : "Источник сигналов · синхронизация задерживается",
    `Не подтверждена свежесть полного снимка более ${minutes} мин.`,
    ...(Number.isSafeInteger(failure?.httpStatus) &&
        failure.httpStatus >= 400 && failure.httpStatus <= 599
      ? [`Источник вернул HTTP ${failure.httpStatus}${failure.httpStatus === 429
          ? " — ограничение частоты запросов" : ""}.`]
      : failure?.failureStage === "transport"
        ? ["Не удалось установить или завершить соединение с источником."]
        : failure?.failureStage === "body"
          ? ["Ответ источника не удалось прочитать как полный JSON-снимок."]
          : failure?.failureStage === "validation"
            ? ["Снимок источника не прошёл проверку полноты, формата или свежести."]
            : []),
    ...(Number.isSafeInteger(failure?.retryAfterMs) &&
        failure.retryAfterMs > 0 && failure.retryAfterMs <= 300_000
      ? [`Пауза, запрошенная источником: ${Math.ceil(failure.retryAfterMs / 1000)} сек.`]
      : []),
    "Автоматическое закрытие PAPER/VST по новым изменениям источника может задерживаться; проверьте состояние бота.",
  ].join("\n");
}

export function createSourceSyncLivenessAlerter({ token, chatId, fetcher = fetch }) {
  validateTelegramCredentials(token, chatId);
  return {
    async send(info) {
      try {
        await postTelegramMessage({
          token, chatId, text: formatSourceSyncLivenessAlert(info), fetcher,
        });
      } catch (error) {
        throw new Error(redactTelegramError(error));
      }
    },
  };
}

export function createVstTelegramNotifier({ pool, token, chatId, fetcher = fetch }) {
  if (!pool || typeof pool.connect !== "function") throw new Error("Telegram notifier needs a DB pool");
  validateTelegramCredentials(token, chatId);
  const retryAfterByEvent = new Map();
  return {
    async tick() {
      let client;
      try {
        client = await pool.connect();
      } catch (error) {
        throw new Error(redactTelegramError(error));
      }
      let locked = false;
      let destroyClient = false;
      try {
        const lock = await client.query(
          "SELECT pg_try_advisory_lock($1, $2) AS acquired",
          [LOCK_NAMESPACE, LOCK_ID],
        );
        locked = lock.rows[0]?.acquired === true;
        if (!locked) return;
        // Every user-facing event is delivered, regardless of intent state.
        // Internal queue telemetry is not a notification. Prioritize
        // exchange-confirmed entries so an open-position
        // alert cannot wait behind an older non-entry backlog. Read a page
        // so a temporarily failing event cannot hold every later event.
        const now = Date.now();
        const cooledDownIds = [];
        for (const [eventId, retryAt] of retryAfterByEvent) {
          if (retryAt <= now) retryAfterByEvent.delete(eventId);
          else cooledDownIds.push(eventId);
        }
        const result = await client.query(
          `SELECT e.id, e.kind, e.detail, e.created_at, s.body, i.request, i.outcome
           FROM vst_events e
           LEFT JOIN vst_signals s ON s.source_signal_id = e.source_signal_id
           LEFT JOIN vst_order_intents i ON i.client_order_id = e.client_order_id
           WHERE e.telegram_sent_at IS NULL
             AND e.kind <> 'vst_entry_queue_telemetry'
             AND e.kind <> 'source_position_control'
             AND e.id::text <> ALL($1::text[])
            ORDER BY CASE WHEN e.kind IN (
              'vst_entry_verified',
              'vst_entry_margin_top_up_pending',
              'vst_impulse_entry_margin_top_up_pending',
              'vst_impulse_entry_verified_split_pending'
            ) THEN 0 ELSE 1 END, e.id LIMIT 5`,
          [cooledDownIds],
        );
        let firstEventError;
        for (const row of result.rows) {
          const eventId = String(row.id);
          const retryAt = retryAfterByEvent.get(eventId);
          if (retryAt > Date.now()) continue;
          let message;
          try {
            message = formatVstTelegramEvent({
              kind: row.kind,
              detail: row.detail,
              outcome: row.outcome,
              request: row.request,
              symbol: row.body?.symbol,
              createdAt: row.created_at,
            });
            if (!message) throw new Error("Unrecognized VST Telegram event");
            await postTelegramMessage({ token, chatId, text: message, fetcher });
          } catch (error) {
            // This event remains unsent and may be retried after its cooldown;
            // continue so a bad Telegram response cannot block later events.
            retryAfterByEvent.set(eventId, Date.now() + 60_000);
            firstEventError ??= error;
            continue;
          }
          try {
            await client.query(
              "UPDATE vst_events SET telegram_sent_at = now() WHERE id = $1 AND telegram_sent_at IS NULL",
              [row.id],
            );
          } catch (error) {
            // Telegram may have accepted the message, so keep the event
            // unsent and cool it down to avoid an immediate duplicate. Stop
            // this tick because a failed DB acknowledgement makes further
            // delivery attempts ambiguous too.
            retryAfterByEvent.set(eventId, Date.now() + 60_000);
            throw error;
          }
          retryAfterByEvent.delete(eventId);
          // Keep the existing delivery pace: at most one accepted message
          // per tick, even when a backlog has built up.
          break;
        }
        if (firstEventError) throw firstEventError;
      } catch (error) {
        throw new Error(redactTelegramError(error));
      } finally {
        if (locked) {
          try {
            const result = await client.query(
              "SELECT pg_advisory_unlock($1, $2) AS released", [LOCK_NAMESPACE, LOCK_ID],
            );
            destroyClient = result.rows[0]?.released !== true;
          } catch {
            destroyClient = true;
          }
        }
        client.release(destroyClient);
      }
    },
  };
}