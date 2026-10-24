import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createVstTelegramNotifier,
  formatVstTelegramEvent,
  formatVstBlockedAlert,
  createVstBlockedAlerter,
  formatSourceDiscrepancyAlert,
  createSourceDiscrepancyAlerter,
  formatSourceSyncLivenessAlert,
  createSourceSyncLivenessAlerter,
  isUserFacingVstEvent,
} from "../vst-telegram.mjs";

test("unlinked stop protection adoption does not claim a successful write or replay", () => {
  const text = formatVstTelegramEvent({
    kind: "vst_stop_protection_adopted", symbol: "VVVUSDT",
    detail: { adoptedProtection: { quantity: 340.9732, stopPrice: 26.665 } },
  });
  assert.match(text, /Восстановлен учёт действующего защитного стопа/);
  assert.match(text, /исполнение исходного переноса не приписывается этой операции/);
  assert.match(text, /Повторный ордер или отмена стопа не отправлялись/);
  assert.match(text, /26\.665/);
  assert.match(text, /340\.9732/);
  assert.doesNotMatch(text, /Стоп перенесён|Позиция закрыта/);
});
import { safeTickErrorSummary } from "../vst-tick-watchdog.mjs";

test("OFC non-execution proof reports a resolved non-entry, not a manual-check alarm", () => {
  const text = formatVstTelegramEvent(event("vst_worker_error", {
    symbol: "OFCUSDT",
    detail: { reason: "entry_unverified_symbol_flat_after_timeout" },
  }));
  assert.match(text, /Вход не состоялся/);
  assert.match(text, /проверены заявка, история сделок, позиции и активные ордера/);
  assert.match(text, /повторного входа не будет/);
  assert.match(text, /Ваших действий не требуется/);
  assert.doesNotMatch(text, /Ошибка обработки|проверьте|не доказывает|Причина:|журнал/i);
  const uncertain = formatVstTelegramEvent(event("vst_worker_error", {
    detail: { reason: "exchange_state_not_verified" },
  }));
  assert.match(uncertain, /Проверьте позицию/);
  assert.doesNotMatch(uncertain, /Вход не состоялся|Ваших действий не требуется/);
});

test("source close messages distinguish cancellation, exchange closure and unknown outcome", () => {
  const cancelled = formatVstTelegramEvent(event("source_exit_completed", {
    detail: { outcome: "cancelled_unentered", reason: "source_closed" },
  }));
  assert.match(cancelled, /Подтверждённого входа нет; новый вход отменён/);
  assert.match(cancelled, /Ордер на закрытие не отправлялся/);
  assert.doesNotMatch(cancelled, /Позиция закрыта|Причина:|журнал|source exit/);
  const closed = formatVstTelegramEvent(event("source_exit_completed", {
    detail: { outcome: "closed", reason: "source_closed" },
  }));
  assert.match(closed, /Позиция закрыта на BingX VST по команде сигнального бота/);
  const historical = formatVstTelegramEvent(event("source_exit_completed", {
    detail: { outcome: "closed", detail: { closureOrigin: "already_committed_exchange_history" } },
  }));
  assert.match(historical, /уже подтверждённо закрыта/);
  assert.match(historical, /Новых торговых заявок не отправлялось/);
  const unknown = formatVstTelegramEvent(event("source_exit_completed", {
    detail: { outcome: "future-outcome", reason: "private-token-do-not-send" },
  }));
  assert.match(unknown, /Закрытие позиции не подтверждено/);
  assert.doesNotMatch(unknown, /private-token|журнал/);
  assert.equal(isUserFacingVstEvent({ kind: "vst_source_exit_unentered" }), false);
  assert.equal(isUserFacingVstEvent({
    kind: "source_exit_completed", detail: { outcome: "closed" },
  }), true);
});

test("temporary market-read alert describes a data refusal, not a missing stop or manual intervention", () => {
  const text = formatVstBlockedAlert({
    reason: "managed_position_read_unavailable", scope: "symbol",
    symbol: "AVAXUSDT", operation: "read_market_mark", blockedForMs: 26 * 60_000, count: 1,
    diagnostic: { schemaVersion: 1, symbol: "AVAXUSDT", reason: "market_mark_unverified" },
  });
  assert.match(text, /свежие данные не подтверждены/);
  assert.match(text, /mark price не прошла проверку/);
  assert.match(text, /бот повторяет проверку/);
  assert.match(text, /не подтверждённая потеря стопа/);
  assert.match(text, /Инструментов с неподтверждёнными данными: 1/);
  assert.doesNotMatch(text, /Незавершённых действий/);
  assert.doesNotMatch(text, /требует вмешательства|не удаётся обработать уже/);
  const foreign = formatVstBlockedAlert({
    reason: "managed_position_read_unavailable", scope: "symbol",
    symbol: "BTCUSDT", blockedForMs: 60_000,
    diagnostic: { schemaVersion: 1, symbol: "AVAXUSDT", reason: "market_mark_unverified" },
  });
  assert.doesNotMatch(foreign, /mark price/);
});

test("equal-price recovery notification never claims a new stop submission or fill", () => {
  const text = formatVstTelegramEvent(event("vst_raise_stop_equal_price_noop_confirmed", {
    detail: { outcome: "equal_price_noop", noWriteConfirmed: true },
  }));
  assert.match(text, /без отправки ордера/);
  assert.match(text, /тот же активный стоп/);
  assert.match(text, /исполнение ордера этим событием не подтверждаются/);
  const incomplete = formatVstTelegramEvent(event("vst_raise_stop_equal_price_noop_confirmed"));
  assert.doesNotMatch(incomplete, /Свежая проверка подтвердила/);
});

function event(kind, extra = {}) {
  return {
    kind, symbol: "ETHUSDT", detail: {}, outcome: { verified: true },
    createdAt: "2026-09-27T08:00:00Z", ...extra,
  };
}

test("formats only confirmed position actions and does not claim split protection is complete", () => {
  assert.match(formatVstTelegramEvent(event("vst_entry_verified", {
    detail: { fillPrice: 2000, fillQuantity: 0.01 },
  })), /Открыта позиция.*подтверждены BingX VST/);
  assert.match(formatVstTelegramEvent(event("vst_entry_margin_top_up_pending")),
    /ликвидация может опередить стоп/);
  assert.match(formatVstTelegramEvent(event("vst_entry_margin_top_up_pending")),
    /Позиция ОТКРЫТА на BingX VST/);
  assert.match(formatVstTelegramEvent(event("vst_impulse_entry_margin_top_up_pending")),
    /Позиция ОТКРЫТА на BingX VST.*дополнительная маржа ещё НЕ подтверждена/);
  const verifiedTopUp = formatVstTelegramEvent(event("vst_margin_top_up_verified"));
  assert.match(verifiedTopUp, /В истории BingX VST наблюдается уникальная запись добавления маржи/);
  assert.match(verifiedTopUp, /биржа не позволяет определить, отправил ли именно бот POST/);
  assert.match(verifiedTopUp, /Защита позиции проверена как безопасная/);
  assert.match(formatVstTelegramEvent(event("vst_margin_top_up_funded_but_unsafe", {
    detail: { protectionVerified: false },
  })), /безопасность защиты позиции не подтверждена[\s\S]*Не отправляйте повторную заявку/);
  assert.match(formatVstTelegramEvent(event("vst_margin_top_up_unconfirmed", {
    detail: { reason: "vst_margin_top_up_not_confirmed" },
  })), /Вход подтверждён, но добавление маржи НЕ подтверждено/);
  assert.match(formatVstTelegramEvent(event("vst_impulse_entry_verified_split_pending")),
    /Позиция ОТКРЫТА на BingX VST.*настройка защиты частей ещё продолжается/);
  assert.match(formatVstTelegramEvent(event("vst_action_reconciled", {
    request: { operation: "close_leg", nextPolicy: { status: "open" } },
  })), /Часть позиции закрыта/);
  assert.match(formatVstTelegramEvent(event("vst_action_reconciled", {
    request: { operation: "raise_stop" },
  })), /Изменён защитный стоп/);
  assert.match(formatVstTelegramEvent(event("vst_impulse_full_split_position_closed")),
    /Позиция закрыта/);
  assert.match(formatVstTelegramEvent(event("vst_signal_rejected")),
    /Открытие позиции НЕ подтверждено/);
  assert.match(formatVstTelegramEvent(event("vst_worker_error", {
    detail: { reason: "Stop loss exceeds contract price precision" },
  })), /Причина: точность стопа не соответствовала контракту/);
  assert.match(formatVstTelegramEvent(event("vst_signal_rejected", {
    detail: { reason: "vst_margin_topup_lifecycle_not_verified" },
  })), /нельзя безопасно внести до открытия позиции/);
  assert.match(formatVstTelegramEvent(event("vst_worker_error", {
    detail: { reason: "VST mark is not corroborated by a fresh quote" },
  })), /расходятся более чем на 0,5%/);
  assert.match(formatVstTelegramEvent(event("vst_worker_error", {
    detail: { reason: "VST quote moved beyond the permitted price-move limit" },
  })), /слишком далеко от цены сигнала/);
  assert.doesNotMatch(formatVstTelegramEvent(event("vst_worker_error", {
    detail: { reason: "untrusted <script>alert(1)</script>" },
  })), /<script>/);
});

test("source lifecycle liveness alerts are bounded, useful, and recover explicitly", async () => {
  const warning = formatSourceSyncLivenessAlert({
    kind: "stale", severity: "warning", staleForMs: 181_000,
  });
  assert.match(warning, /Источник сигналов/);
  assert.match(warning, /более 3 мин/);
  assert.match(warning, /PAPER\/VST/);
  assert.match(formatSourceSyncLivenessAlert({ kind: "recovered" }), /синхронизация восстановлена/);

  const messages = [];
  const alerter = createSourceSyncLivenessAlerter({
    token: "123:TEST_TOKEN",
    chatId: "-123",
    fetcher: async (_url, options) => {
      messages.push(JSON.parse(options.body).text);
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  await alerter.send({ kind: "stale", staleForMs: 60_000 });
  await alerter.send({ kind: "recovered", staleForMs: 1_000 });
  assert.equal(messages.length, 2);
  assert.match(messages[0], /синхронизация задерживается/);
  assert.match(messages[1], /синхронизация восстановлена/);
  assert.doesNotMatch(messages.join("\n"), /TEST_TOKEN|api\.telegram\.org/);
});

test("Telegram exposes the newly reviewed BingX 109400 code without provider details", () => {
  const error = new Error("private BingX response apiKey=secret");
  error.name = "BingXLiveApiError";
  error.code = 109400;
  const summary = safeTickErrorSummary(error);
  const message = formatVstBlockedAlert({
    reason: "vst_worker_error",
    blockedForMs: 60_000,
    errorSummary: summary,
  });
  assert.match(message, /BingX error code 109400/);
  assert.doesNotMatch(message, /Details withheld|apiKey=secret|private BingX response/);
});

test("verified MARKET entry alerts distinguish planning quote from actual fill deviation", () => {
  const message = formatVstTelegramEvent(event("vst_entry_verified", {
    detail: {
      fillPrice: "99",
      signalReferencePrice: "100",
      planningQuotePrice: "102",
      planningQuoteObservedAt: "2026-09-27T07:59:59.000Z",
      signalPriceDeviationPct: 2,
      verifiedFillPrice: "99",
      verifiedFillAt: "2026-09-27T08:00:00.000Z",
      actualFillDeviationPct: -1,
    },
  }));
  assert.match(message, /Цена сигнала: 100/);
  assert.match(message, /Котировка для расчёта: 102 · 2026-09-27T07:59:59\.000Z/);
  assert.match(message, /Отклонение котировки от сигнала: \+2\.0000%/);
  assert.match(message, /Время исполнения: 2026-09-27T08:00:00\.000Z/);
  assert.match(message, /Отклонение подтверждённого исполнения от сигнала: -1\.0000%/);
  assert.match(message, /MARKET не гарантирует верхнюю цену исполнения/);
});

test("unreviewed event kinds do not produce meaningless Telegram messages", () => {
  const generic = formatVstTelegramEvent(event("vst_symbol_currently_offline"));
  assert.equal(generic, null);
  assert.equal(isUserFacingVstEvent({ kind: "vst_symbol_currently_offline" }), false);

  const withReason = formatVstTelegramEvent(event("vst_order_rejected", {
    detail: { reason: "some_future_broker_reason" },
  }));
  assert.equal(withReason, null);
});

test("signal-less events use a generic message without exposing kind or private details", () => {
  for (const kind of ["vst_worker_error", "future_kind_with_private_data"]) {
    const message = formatVstTelegramEvent(event(kind, {
      symbol: null,
      detail: { reason: "database-password-do-not-send" },
      request: { apiSecret: "secret-do-not-send" },
      outcome: { accountId: "private-account-id" },
    }));
    assert.match(message, /^BingX VST · системное событие без сигнала/);
    assert.match(message, /Не удалось определить инструмент/);
    assert.doesNotMatch(message,
      /database-password|secret-do-not-send|private-account-id|future_kind/);
  }
});

test("formats a signal status change with Russian status labels", () => {
  const changed = formatVstTelegramEvent(event("vst_signal_status_changed", {
    detail: { from: "planning", to: "rejected", reason: "policy_rejected" }, outcome: {},
  }));
  assert.match(changed, /Статус сигнала изменён: планируется → отклонён/);
  assert.match(changed, /Причина: сигнал не прошёл проверку торговых правил/);

  const unknownStatus = formatVstTelegramEvent(event("vst_signal_status_changed", {
    detail: { from: "pending", to: "some_future_status" }, outcome: {},
  }));
  assert.match(unknownStatus, /Статус сигнала изменён: в очереди → some_future_status/);
});

test("names the specific stop-raise reason and shows the resulting stop price", () => {
  assert.match(formatVstTelegramEvent(event("vst_action_reconciled", {
    request: { operation: "raise_stop", reason: "breakeven_stop", stopPrice: 2010.5 },
  })), /стоп позиции изменён на BingX VST \(стоп переведён в безубыток\)[\s\S]*Стоп: 2010.5/);
  assert.match(formatVstTelegramEvent(event("vst_action_reconciled", {
    request: { operation: "raise_stop", reason: "protected_profit_floor", stopPrice: 2050 },
  })), /защищённого уровня прибыли/);
  assert.match(formatVstTelegramEvent(event("vst_action_reconciled", {
    request: { operation: "raise_stop", reason: "percentage_point_trailing_stop" },
  })), /трейлингом за ценой/);
  // An unrecognized/absent reason must fall back to the pre-existing generic
  // wording rather than showing a blank or broken parenthetical.
  const noReason = formatVstTelegramEvent(event("vst_action_reconciled", {
    request: { operation: "raise_stop" },
  }));
  assert.match(noReason, /^Изменён защитный стоп позиции на BingX VST$/m);
  assert.doesNotMatch(noReason, /\(/);
  assert.match(formatVstTelegramEvent(event("vst_impulse_sole_core_stop_raised", {
    request: { operation: "raise_stop", reason: "breakeven_stop" },
    detail: { stopPrice: 1999.1 },
  })), /повышен на BingX VST \(стоп переведён в безубыток\)[\s\S]*Стоп: 1999.1/);
});

test("names the specific abandon outcome instead of the generic unconfirmed-execution wording", () => {
  // Real incident: the fill was confirmed (position open), but the stop was
  // never confirmed. The old generic vst_worker_error wording claimed
  // execution itself was unconfirmed, which was wrong and understated the
  // actual risk (an open, unprotected position).
  const openUnprotected = formatVstTelegramEvent(event("vst_worker_error", {
    detail: { reason: "entry_verification_abandoned_confirmed_open_unprotected" },
  }));
  assert.match(openUnprotected, /позиция ОТКРЫТА на бирже/);
  assert.match(openUnprotected, /защитный стоп не подтверждён и НЕ будет выставлен автоматически/);

  // Current symbol flatness is not a zero wallet balance or proof that an
  // entry never executed historically. Keep those claims separate.
  const flatEntry = formatVstTelegramEvent(event("vst_worker_error", {
    detail: { reason: "entry_abandoned_confirmed_flat_account" },
  }));
  assert.match(flatEntry, /по этому символу не найдены открытая позиция и активные заявки/);
  assert.match(flatEntry, /это не означает, что баланс счёта нулевой/);
  assert.doesNotMatch(flatEntry, /счёт подтверждён пустым|вход не был исполнен/);
  assert.doesNotMatch(flatEntry, /ОТКРЫТА/);
});

test("derives an accurate abandon message for any operation sharing the same suffix", () => {
  // These exact strings are not literals in FAILURE_REASONS -- they exercise
  // the suffix-matching fallback so any operation added to
  // FLAT_ACCOUNT_ABANDON_OPERATIONS / CLOSE_ABANDON_OPERATIONS in
  // vst-worker.mjs gets accurate wording without a matching code change here.
  const flatOther = formatVstTelegramEvent(event("vst_worker_error", {
    detail: { reason: "raise_stop_abandoned_confirmed_flat_account" },
  }));
  assert.match(flatOther, /по этому символу не найдены открытая позиция и активные заявки/);
  assert.match(flatOther, /баланс счёта этим сообщением не оценивается/);
  assert.doesNotMatch(flatOther, /счёт подтверждён пустым/);
  assert.match(flatOther, /перенос стопа/);

  const stillOpen = formatVstTelegramEvent(event("vst_worker_error", {
    detail: { reason: "close_leg_abandoned_confirmed_still_open" },
  }));
  assert.match(stillOpen, /позиция осталась открытой без изменений/);
  assert.match(stillOpen, /закрытие части позиции/);

  const unconfirmedOutcome = formatVstTelegramEvent(event("vst_worker_error", {
    detail: { reason: "close_leg_abandoned_unconfirmed_outcome" },
  }));
  assert.match(unconfirmedOutcome, /статус ручной проверки/);
  assert.match(unconfirmedOutcome, /закрытие части позиции/);

  // An operation this formatter has no OPERATION_TEXT label for still gets
  // the accurate structural claim, just without the parenthetical name.
  const unknownOperation = formatVstTelegramEvent(event("vst_worker_error", {
    detail: { reason: "some_future_op_abandoned_confirmed_still_open" },
  }));
  assert.match(unknownOperation, /позиция осталась открытой без изменений/);
});

test("distinguishes a runner max-age close from an ordinary partial close", () => {
  assert.match(formatVstTelegramEvent(event("vst_action_reconciled", {
    request: { operation: "close_leg", reason: "runner_max_age_expiry", nextPolicy: { status: "open" } },
  })), /истечении максимального срока удержания/);
  const ordinary = formatVstTelegramEvent(event("vst_action_reconciled", {
    request: { operation: "close_leg", nextPolicy: { status: "open" } },
  }));
  assert.match(ordinary, /^Часть позиции закрыта на BingX VST$/m);
});

test("formats an unresolved/ambiguous action with its operation and reason", () => {
  const pendingEntry = formatVstTelegramEvent(event("vst_action_unresolved", {
    symbol: "WOOUSDT",
    detail: { reason: "entry_result_not_verified", operation: "entry" },
    createdAt: "2026-10-24T15:59:47.411Z",
  }));
  assert.match(pendingEntry, /Вход пока не подтверждён\. Бот сверяет заявку с биржей/);
  assert.match(pendingEntry, /Повторный ордер не отправляется/);
  assert.doesNotMatch(pendingEntry, /не распознана|вручную|Причина:|открыта|не состоялся/);
  const withOp = formatVstTelegramEvent(event("vst_action_unresolved", {
    detail: { reason: "exchange_state_not_verified", operation: "raise_stop" },
  }));
  assert.match(withOp, /не подтверждено \(перенос стопа\)/);
  assert.match(withOp, /Причина: биржа не подтвердила исход операции/);
  const unknownOp = formatVstTelegramEvent(event("vst_action_unresolved", {
    detail: { reason: "action_fill_unconfirmed" },
  }));
  assert.match(unknownOp, /^BingX VST · ETHUSDT\nДействие на BingX VST не подтверждено\. /);
  assert.match(unknownOp, /исполнение операции не подтверждено биржей/);
});

test("unresolved action alerts identify the precise intent and separate symbol/account counts", () => {
  const alert = formatVstBlockedAlert({
    reason: "unresolved_vst_order_intents",
    blockedForMs: 6 * 60_000,
    scope: "symbol",
    sourceSignalId: "cab-signal-101",
    symbol: "AKTUSDT",
    operation: "cancel_original_stop",
    phase: "impulse-cancel_original_stop",
    state: "unknown",
    clientOrderId: "vst-client-101",
    exchangeOrderId: "501",
    count: 1,
    symbolUnresolvedCount: 1,
    accountUnresolvedCount: 3,
    recoveryDeferredReason: "original_stop_cancel_position_changed",
    originalDiagnostic: {
      errorClass: "BingXLiveApiError",
      reason: "exchange_provider_error",
      code: "109400",
      providerReason: "timestamp_invalid",
      method: "GET",
      endpoint: "/openApi/swap/v2/trade/leverage",
      httpStatus: 200,
    },
    lastAttemptAt: "2026-09-27T08:00:00.000Z",
    lastAttemptAgeMs: 120_000,
  });
  assert.match(alert, /отмена исходного общего стопа/);
  assert.match(alert, /Этап: impulse-cancel_original_stop/);
  assert.match(alert, /Состояние действия: unknown/);
  assert.match(alert, /Незавершённых действий по AKTUSDT: 1/);
  assert.match(alert, /Всего незавершённых действий на счёте: 3/);
  assert.match(alert, /код BingX 109400/);
  assert.match(alert, /GET \/openApi\/swap\/v2\/trade\/leverage · HTTP 200/);
  assert.match(alert, /Сверка отложена:/);
  assert.doesNotMatch(alert, /Незавершённых действий: 3/);
  assert.doesNotMatch(alert, /нет позиции|заявка не отправлялась/);

  const runner = formatVstBlockedAlert({
    reason: "unresolved_vst_order_intents",
    blockedForMs: 60_000,
    symbol: "KIIUSDT",
    operation: "close_pre_runner_split",
    phase: "impulse-runner-breakeven-abort-1790873680714",
    state: "unknown",
    symbolUnresolvedCount: 1,
    accountUnresolvedCount: 3,
    originalDiagnostic: {
      errorClass: "BingXLiveApiError",
      reason: "exchange_provider_error",
      code: "109421",
      providerReason: "order_not_found",
      method: "GET",
      endpoint: "/openApi/swap/v2/trade/order",
      httpStatus: 200,
    },
  });
  assert.match(runner, /закрытие позиции до настройки runner/);
  assert.match(runner, /Этап: impulse-runner-breakeven-abort-1790873680714/);
  assert.match(runner, /код BingX 109421/);
  assert.doesNotMatch(runner, /Незавершённых действий: 3/);

  const unknownOperation = formatVstBlockedAlert({
    reason: "unresolved_vst_order_intents",
    blockedForMs: 1,
    operation: "future_safe_action",
  });
  assert.match(unknownOperation, /Операция: технический код future_safe_action/);
});

test("unresolved alert identifiers and original diagnostic reject hostile strings", () => {
  const alert = formatVstBlockedAlert({
    reason: "unresolved_vst_order_intents",
    blockedForMs: 1,
    symbol: "AKTUSDT",
    sourceSignalId: "cab-signal-1\nTOKEN",
    operation: "close_leg\nTOKEN",
    phase: "safe-phase\nTOKEN",
    state: "unknown",
    clientOrderId: "id TOKEN",
    exchangeOrderId: "exchange-id",
    originalDiagnostic: {
      errorClass: "Error",
      reason: "internal_exception",
      code: "109400\nTOKEN",
      endpoint: "/openApi/swap/v2/trade/order?signature=TOKEN",
      method: "POST",
    },
  });
  assert.doesNotMatch(alert, /Этап:|Операция:/);
  assert.doesNotMatch(alert, /ID действия:|ID биржевой заявки:/);
  assert.doesNotMatch(alert, /TOKEN|signature=|cab-signal-1/);
});

test("new unresolved-action proof deferrals have fixed Russian explanations only", () => {
  const cases = [
    ["close_pre_runner_split_mutation_provenance_missing", /нет проверенного доказательства/],
    ["close_pre_runner_split_current_proof_mismatch", /свежая проверка позиции или защитных стопов/],
    ["unresolved_intent_reconciliation_read_failed", /не удалось выполнить свежие чтения биржи/],
    ["unresolved_intent_evidence_unverified", /доказательств недостаточно/],
  ];
  for (const [recoveryDeferredReason, expected] of cases) {
    const message = formatVstBlockedAlert({
      reason: "unresolved_vst_order_intents",
      blockedForMs: 6 * 60_000,
      symbol: "KIIUSDT",
      operation: "close_pre_runner_split",
      recoveryDeferredReason,
    });
    assert.match(message, expected);
    assert.doesNotMatch(message, new RegExp(recoveryDeferredReason));
  }
  const unknown = formatVstBlockedAlert({
    reason: "unresolved_vst_order_intents",
    blockedForMs: 6 * 60_000,
    recoveryDeferredReason: "arbitrary-provider-message SECRET",
  });
  assert.doesNotMatch(unknown, /SECRET|arbitrary-provider-message/);
});

test("formats original-stop cancellation recovery without claiming a cancel, close, or automatic retry", () => {
  const message = formatVstTelegramEvent(event(
    "vst_original_stop_cancel_pre_mutation_read_refused",
    {
      detail: {
        operation: "cancel_original_stop",
        outcome: "pre_mutation_read_refused",
        canceled: false,
        mutationRequestSent: false,
      },
      request: { operation: "cancel_original_stop" },
    },
  ));
  assert.match(message, /Обработка отмены исходного общего стопа восстановлена/);
  assert.match(message, /исходная отмена не отправлялась/);
  assert.match(message, /защитные стопы подтверждены/);
  assert.match(message, /следующая операция требует свежих проверок/i);
  assert.doesNotMatch(message, /стоп отменён|позиция закрыта|отмена выполнена|повтор будет выполнен автоматически/);

  const raiseStopRecovery = formatVstTelegramEvent(event(
    "vst_raise_stop_pre_upgrade_refusal_confirmed",
    {
      detail: {
        operation: "raise_stop",
        outcome: "failed_before_adapter",
        noWriteConfirmed: true,
      },
      request: { operation: "raise_stop" },
    },
  ));
  assert.match(raiseStopRecovery, /отказ произошёл до изменения на бирже/);
  assert.match(raiseStopRecovery, /открытая позиция и действующий стоп подтверждены/);
  assert.match(raiseStopRecovery, /Новое изменение требует свежих проверок/);
  assert.doesNotMatch(raiseStopRecovery, /позиция закрыта|повтор будет выполнен автоматически/);

  const settledAfterStopFill = formatVstTelegramEvent(event(
    "vst_raise_stop_refusal_settled_after_closed_fill",
    {
      detail: {
        outcome: "raise_stop_refusal_retired_after_committed_close",
        stopOrderId: "private-stop-id",
      },
      request: { operation: "raise_stop" },
    },
  ));
  assert.match(settledAfterStopFill,
    /Зависшая проверка переноса стопа завершена после подтверждённого закрытия биржевым стопом/);
  assert.match(settledAfterStopFill, /исходный перенос не отправлялся/);
  assert.match(settledAfterStopFill, /результат закрытия сохранён/);
  assert.doesNotMatch(settledAfterStopFill,
    /позиция осталась открытой|действующий стоп подтверждён|повтор будет выполнен автоматически|private-stop-id/);

  const runnerFillCleanup = formatVstTelegramEvent(event(
    "vst_impulse_runner_fill_cleanup_pending",
    {
      detail: {
        runnerStopOrderId: "runner-stop",
        originalStopOrderId: "original-stop",
        remainingQuantity: "0.8",
      },
    },
  ));
  assert.match(runnerFillCleanup, /Исполнение стопа раннера учтено/);
  assert.match(runnerFillCleanup, /защита остатка и отмена исходного общего стопа требуют свежей проверки/);
  assert.doesNotMatch(runnerFillCleanup,
    /отмена исходного общего стопа подтверждена|остаток позиции защищён подтверждённым/);

  const sentCancelCleanup = formatVstTelegramEvent(event(
    "vst_impulse_runner_fill_cleanup_pending",
    {
      detail: {
        originalCancellationConfirmed: true,
        remainingQuantity: "0.8",
      },
    },
  ));
  assert.match(sentCancelCleanup, /отмена исходного общего стопа подтверждена/);
  assert.match(sentCancelCleanup, /остаток позиции защищён подтверждённым стопом ядра/);
  assert.match(sentCancelCleanup, /очистка завершена/);
  assert.doesNotMatch(sentCancelCleanup, /отмена исходного общего стопа требуют свежей проверки/);
});

test("acknowledges only after Telegram accepts; failed sends remain retryable", async () => {
  const calls = [];
  const row = {
    id: "14", kind: "vst_entry_verified", detail: { fillPrice: 42 },
    body: { symbol: "BTCUSDT" }, request: { operation: "entry" },
    outcome: { verified: true }, created_at: new Date("2026-09-27T08:00:00Z"),
  };
  const pool = {
    async connect() {
      return {
        async query(sql, args) {
          calls.push({ sql, args });
          if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
          if (sql.includes("pg_advisory_unlock")) return { rows: [{ released: true }] };
          if (sql.includes("FROM vst_events e")) return { rows: [row] };
          return { rows: [{ released: true }] };
        },
        release() { calls.push({ released: true }); },
      };
    },
  };
  const notifier = createVstTelegramNotifier({
    pool, token: "123:TEST_TOKEN", chatId: "-123",
    fetcher: async (_url, options) => {
      assert.equal(JSON.parse(options.body).chat_id, "-123");
      return { ok: false, status: 429 };
    },
  });
  await assert.rejects(notifier.tick(), /HTTP 429/);
  assert.equal(calls.some((call) => call.sql?.includes("SET telegram_sent_at")), false);
  assert.equal(calls.at(-1).released, true);

  const sent = createVstTelegramNotifier({
    pool, token: "123:TEST_TOKEN", chatId: "-123",
    fetcher: async () => ({ ok: true, json: async () => ({ ok: true }) }),
  });
  await sent.tick();
  const ack = calls.find((call) => call.sql?.includes("SET telegram_sent_at"));
  assert.deepEqual(ack.args, ["14"]);
  const select = calls.find((call) => call.sql?.includes("FROM vst_events e"));
  assert.match(select.sql, /LEFT JOIN vst_order_intents/);
  assert.match(select.sql, /WHERE e\.telegram_sent_at IS NULL[\s\S]+ORDER BY CASE WHEN e\.kind IN[\s\S]+e\.id LIMIT 5/);
  // No kind allowlist and no intent-state gating -- every unsent row is a
  // delivery candidate, regardless of kind or of the linked intent's state.
  // i.request/i.outcome are still selected (the formatter uses them) but
  // must not appear in a WHERE-clause gating condition.
  assert.doesNotMatch(select.sql.split("ORDER BY")[0], /e\.kind\s+IN|i\.state/);
  assert.doesNotMatch(select.sql, /i\.state/);
  assert.deepEqual(select.args, [[]]);
});

test("Telegram acknowledges top-up bookkeeping without sending it", async () => {
  const calls = [];
  const sentMessages = [];
  const row = {
    id: "margin-top-up-verified-1",
    kind: "vst_margin_top_up_verified",
    detail: {
      amount: "5.25",
      marginDelta: "5.25",
      protectionVerified: true,
    },
    body: { symbol: "BTCUSDT" },
    request: { operation: "margin_top_up" },
    outcome: {
      verified: true,
      marginHistory: {
        source: "bingx_position_margin_history",
        attribution: "unique_exchange_adjustment_without_operation_id",
      },
    },
    created_at: new Date("2026-09-27T08:00:00Z"),
  };
  const pool = {
    async connect() {
      return {
        async query(sql, args) {
          calls.push({ sql, args });
          if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
          if (sql.includes("pg_advisory_unlock")) return { rows: [{ released: true }] };
          if (sql.includes("FROM vst_events e")) return { rows: [row] };
          if (sql.includes("SET telegram_sent_at")) return { rows: [] };
          throw new Error("unexpected SQL");
        },
        release() {},
      };
    },
  };
  const notifier = createVstTelegramNotifier({
    pool, token: "123:TEST_TOKEN", chatId: "-123",
    fetcher: async (_url, options) => {
      sentMessages.push(JSON.parse(options.body).text);
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });

  await notifier.tick();

  assert.equal(sentMessages.length, 0);
  assert.deepEqual(calls.find((call) =>
    call.sql?.includes("SET telegram_sent_at")).args, ["margin-top-up-verified-1"]);
});

test("the outbox skips technical rows and sends a concise trade outcome once", async () => {
  const calls = [];
  const sentIds = new Set();
  const sentMessages = [];
  const rows = [
    {
      id: "12", kind: "vst_worker_error",
      detail: { reason: "private-provider-message-must-not-leak" },
      body: null, request: { apiSecret: "private-secret" },
      outcome: { accountId: "private-account" },
      created_at: new Date("2026-09-27T08:00:00Z"),
    },
    {
      id: "13", kind: "future_kind",
      detail: { reason: "other-private-message" },
      body: null, request: null, outcome: null,
      created_at: new Date("2026-09-27T08:01:00Z"),
    },
    {
      id: "14", kind: "vst_entry_verified", detail: { fillPrice: 42 },
      body: { symbol: "BTCUSDT" }, request: { operation: "entry" },
      outcome: { verified: true },
      created_at: new Date("2026-09-27T08:02:00Z"),
    },
  ];
  const pool = {
    async connect() {
      return {
        async query(sql, args) {
          calls.push({ sql, args });
          if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
          if (sql.includes("pg_advisory_unlock")) return { rows: [{ released: true }] };
          if (sql.includes("FROM vst_events e")) {
            assert.match(sql, /LEFT JOIN vst_signals s ON s\.source_signal_id = e\.source_signal_id/);
            return { rows: rows.filter((row) => !sentIds.has(row.id)) };
          }
          if (sql.includes("SET telegram_sent_at")) {
            sentIds.add(args[0]);
            return { rows: [] };
          }
          throw new Error("unexpected SQL");
        },
        release() {},
      };
    },
  };
  const notifier = createVstTelegramNotifier({
    pool, token: "123:TEST_TOKEN", chatId: "-123",
    fetcher: async (_url, options) => {
      sentMessages.push(JSON.parse(options.body).text);
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });

  await notifier.tick();
  assert.deepEqual([...sentIds], ["12", "13", "14"]);
  assert.deepEqual(sentMessages, ["BingX VST · BTCUSDT\nПозиция открыта."]);
  await notifier.tick();
  assert.equal(sentMessages.length, 1, "accepted events are not resent");
  assert.equal(calls.filter((call) => call.sql?.includes("SET telegram_sent_at")).length, 3);
});

test("a failed oldest event cools down independently and is retried after newer events", async () => {
  const calls = [];
  const sentIds = new Set();
  const rows = ["14", "15", "16"].map((id) => ({
    id, source_signal_id: `signal-${id}`, kind: "vst_signal_rejected", detail: {},
    body: { symbol: { "14": "BTCUSDT", "15": "ETHUSDT", "16": "DOGEUSDT" }[id] },
    request: null, outcome: null,
    created_at: new Date("2026-09-27T08:00:00Z"),
  }));
  const pool = {
    async connect() {
      return {
        async query(sql, args) {
          if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
          if (sql.includes("pg_advisory_unlock")) return { rows: [{ released: true }] };
          if (sql.includes("FROM vst_events e")) {
            return { rows: rows.filter((row) => !sentIds.has(row.id)) };
          }
          if (sql.includes("SET telegram_sent_at")) {
            sentIds.add(args[0]);
            return { rows: [] };
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  let now = Date.now();
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    let olderAttempts = 0;
    const notifier = createVstTelegramNotifier({
      pool, token: "123:TEST_TOKEN", chatId: "-123",
      fetcher: async (_url, options) => {
        const text = JSON.parse(options.body).text;
        calls.push(text);
        if (text.includes("BTCUSDT") && olderAttempts++ === 0) {
          return { ok: false, status: 503 };
        }
        return { ok: true, json: async () => ({ ok: true }) };
      },
    });

    await assert.rejects(notifier.tick(), /HTTP 503/);
    assert.equal(calls.length, 2, "the newer event is attempted despite the oldest failure");
    assert.match(calls[0], /BTCUSDT/);
    assert.match(calls[1], /ETHUSDT/);
    assert.deepEqual([...sentIds], ["15"]);

    await notifier.tick();
    assert.equal(calls.length, 3, "only one successful delivery is made per tick");
    assert.match(calls[2], /DOGEUSDT/);
    now += 60_001;
    await notifier.tick();
    assert.equal(calls.length, 4);
    assert.match(calls[3], /BTCUSDT/);
    assert.deepEqual([...sentIds], ["15", "16", "14"]);
  } finally {
    Date.now = originalNow;
  }
});

test("a confirmed VST opening is delivered before an older non-entry backlog", async () => {
  const sentIds = new Set();
  const sentMessages = [];
  const rows = [
    {
      id: "14", kind: "vst_worker_error", detail: {},
      body: { symbol: "ETHUSDT" }, request: null, outcome: null,
      created_at: new Date("2026-09-27T08:00:00Z"),
    },
    {
      id: "15", kind: "vst_entry_margin_top_up_pending", detail: { fillQuantity: "12" },
      body: { symbol: "ETHUSDT" }, request: { operation: "entry" }, outcome: null,
      created_at: new Date("2026-09-27T08:01:00Z"),
    },
  ];
  const pool = {
    async connect() {
      return {
        async query(sql, args) {
          if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
          if (sql.includes("pg_advisory_unlock")) return { rows: [{ released: true }] };
          if (sql.includes("FROM vst_events e")) {
            assert.match(sql, /ORDER BY CASE WHEN e\.kind IN \([\s\S]*'vst_entry_verified'[\s\S]*'vst_entry_margin_top_up_pending'[\s\S]*'vst_impulse_entry_margin_top_up_pending'[\s\S]*'vst_impulse_entry_verified_split_pending'[\s\S]*\) THEN 0 ELSE 1 END, e\.id LIMIT 5/);
            return { rows: rows.filter((row) => !sentIds.has(row.id)).reverse() };
          }
          if (sql.includes("SET telegram_sent_at")) {
            sentIds.add(args[0]);
            return { rows: [] };
          }
          throw new Error("unexpected SQL");
        },
        release() {},
      };
    },
  };
  const notifier = createVstTelegramNotifier({
    pool, token: "123:TEST_TOKEN", chatId: "-123",
    fetcher: async (_url, options) => {
      sentMessages.push(JSON.parse(options.body).text);
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  await notifier.tick();
  assert.deepEqual([...sentIds], ["15"]);
  assert.equal(sentMessages[0], "BingX VST · ETHUSDT\nПозиция открыта.");
  await notifier.tick();
  assert.deepEqual([...sentIds], ["15", "14"]);
});

test("acknowledges an unreviewed event without sending a generic alert", async () => {
  const calls = [];
  const rows = [
    {
      id: "40", kind: "vst_symbol_currently_offline", detail: {},
      body: { symbol: "DOGEUSDT" }, request: null, outcome: null,
      created_at: new Date("2026-09-28T08:00:00Z"),
    },
  ];
  const pool = {
    async connect() {
      return {
        async query(sql, args) {
          calls.push({ sql, args });
          if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
          if (sql.includes("pg_advisory_unlock")) return { rows: [{ released: true }] };
          if (sql.includes("FROM vst_events e")) return { rows: rows.splice(0, 1) };
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const notifier = createVstTelegramNotifier({
    pool, token: "123:TEST_TOKEN", chatId: "-123",
    fetcher: async () => {
      assert.fail("an unreviewed event must remain in the ledger, not Telegram");
    },
  });
  await notifier.tick();
  const ack = calls.find((call) => call.sql?.includes("SET telegram_sent_at"));
  assert.deepEqual(ack.args, ["40"]);
});

test("entry queue telemetry is explicitly excluded from Telegram delivery", async () => {
  const calls = [];
  const rows = [
    {
      id: "50", kind: "vst_entry_queue_telemetry",
      detail: { event: "preparing" }, body: { symbol: "DOGEUSDT" },
      request: null, outcome: null, created_at: new Date(),
    },
    {
      id: "51", kind: "vst_signal_rejected", detail: {},
      body: { symbol: "DOGEUSDT" }, request: null, outcome: null,
      created_at: new Date(),
    },
  ];
  const pool = {
    async connect() {
      return {
        async query(sql, args) {
          calls.push({ sql, args });
          if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
          if (sql.includes("pg_advisory_unlock")) return { rows: [{ released: true }] };
          if (sql.includes("FROM vst_events e")) {
            assert.match(sql, /e\.kind <> 'vst_entry_queue_telemetry'/);
            return { rows: rows.filter((row) =>
              row.kind !== "vst_entry_queue_telemetry") };
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const sent = [];
  const notifier = createVstTelegramNotifier({
    pool, token: "123:TEST_TOKEN", chatId: "-123",
    fetcher: async (_url, options) => {
      sent.push(JSON.parse(options.body).text);
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  await notifier.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0], "BingX VST · DOGEUSDT\nПозиция не открыта.\nПричина: причина не указана");
  assert.deepEqual(
    calls.filter(({ sql }) => sql.includes("SET telegram_sent_at"))
      .map(({ args }) => args[0]),
    ["51"],
  );
});

test("formats a blocked-pipeline alert with a known reason, count, and rounded duration", () => {
  const text = formatVstBlockedAlert({
    reason: "unresolved_vst_order_intents",
    blockedForMs: 7 * 60_000 + 10_000,
    count: 2,
  });
  assert.match(text, /остановлено/);
  assert.match(text, /заблокирован уже 7 мин/);
  assert.match(text, /незавершённое действие бота/);
  assert.match(text, /Незавершённых действий: 2/);
  assert.doesNotMatch(text, /Сигнал:/);
});

test("formats a long-running single-flight tick as delayed work, not a stopped pipeline", () => {
  const text = formatVstBlockedAlert({
    reason: "vst_worker_tick_stalled",
    blockedForMs: 2 * 60_000 + 25_000,
  });

  assert.match(text, /BingX VST · торговый цикл выполняется дольше обычного/);
  assert.match(text, /Текущий цикл идёт уже 2 мин/);
  assert.match(text, /Новые сигналы ждут его завершения и пока не рассмотрены/);
  assert.match(text, /это не означает, что бот полностью остановился/);
  assert.match(text, /проверьте позиции и активные стоп-заявки на BingX/);
  assert.match(text, /защита этим уведомлением не подтверждается/);
  assert.doesNotMatch(text, /исполнение сигналов остановлено|Конвейер заблокирован/);
});

test("formats a worker exception without claiming that positions or stops are protected", () => {
  const text = formatVstBlockedAlert({
    reason: "vst_worker_error",
    errorSummary: safeTickErrorSummary(
      new TypeError("Unsupported VST policy version or pattern"),
    ),
  });
  assert.match(text, /BingX VST · ошибка торгового цикла/);
  assert.match(text, /Обработка цикла завершилась ошибкой/);
  assert.match(text, /состояние позиций и защитных стопов этим уведомлением не подтверждается/);
  assert.match(text, /Ошибка: TypeError: Unsupported VST policy version or pattern/);
  assert.doesNotMatch(text, /позиция защищена|стоп подтверждён/);

  const unsafe = formatVstBlockedAlert({
    reason: "vst_worker_error",
    errorSummary: 'Error: {"apiKey":"short-secret","balance":"123.45"}',
  });
  assert.doesNotMatch(unsafe, /short-secret|123\.45|apiKey/);
  assert.doesNotMatch(unsafe, /Ошибка:/);
});

test("formats prolonged pending-signal waits without claiming an entry was submitted", () => {
  const text = formatVstBlockedAlert({
    reason: "pending_vst_signals_waiting",
    blockedForMs: 6 * 60_000,
    count: 3,
    sourceSignalId: "cab-signal-pending",
    symbol: "ETHUSDT",
  });
  assert.match(text, /сигналы ожидают проверки/);
  assert.match(text, /Сигналы ждут уже 6 мин/);
  assert.match(text, /входы по ним не отправлялись/);
  assert.match(text, /Ожидающих сигналов: 3/);
  assert.match(text, /Инструмент: ETHUSDT/);
  assert.doesNotMatch(text, /исполнение сигналов остановлено/);
});

test("blocked-pipeline alert includes the source signal and falls back for an unrecognized reason", () => {
  const withSignal = formatVstBlockedAlert({
    reason: "vst_margin_top_up_requires_verified_reconciliation",
    blockedForMs: 5 * 60_000,
    sourceSignalId: "sig-77",
  });
  assert.match(withSignal, /пополнение маржи ещё не подтверждено/);
  assert.match(withSignal, /Сигнал: sig-77/);
  assert.doesNotMatch(withSignal, /Незавершённых действий/);

  const withSymbol = formatVstBlockedAlert({
    reason: "unresolved_vst_order_intents",
    blockedForMs: 6 * 60_000,
    count: 1,
    sourceSignalId: "cab-signal-13570",
    symbol: "ENSUSDT",
    operation: "entry",
  });
  assert.match(withSymbol, /Инструмент: ENSUSDT/);
  assert.match(withSymbol, /Операция: открытие позиции/);
  const unresolvedEntry = formatVstBlockedAlert({
    reason: "unresolved_vst_order_intents", blockedForMs: 6 * 60_000,
    symbol: "BENUSDT", operation: "entry", entryNotSubmitted: true,
  });
  assert.doesNotMatch(unresolvedEntry, /вход не был отправлен на биржу/);
  assert.match(unresolvedEntry, /исход требует сверки/);
  // Invalid symbols are dropped. A valid technical operation code remains
  // explicit rather than disappearing from the alert.
  const rejectsBadFields = formatVstBlockedAlert({
    reason: "unresolved_vst_order_intents", blockedForMs: 60_000,
    symbol: "<script>", operation: "some_future_op",
  });
  assert.doesNotMatch(rejectsBadFields, /Инструмент:/);
  assert.match(rejectsBadFields, /Операция: технический код some_future_op/);

  const unknown = formatVstBlockedAlert({ reason: "some_future_reason", blockedForMs: 90_000 });
  assert.match(unknown, /заблокирован уже 2 мин/);
  assert.match(unknown, /безопасность VST не подтверждена/);
  assert.doesNotMatch(unknown, /some_future_reason/);

  const missing = formatVstBlockedAlert({ blockedForMs: 0 });
  assert.match(missing, /заблокирован уже 1 мин/);
  assert.match(missing, /безопасность VST не подтверждена/);
  assert.doesNotMatch(missing, /unknown_reason/);
});

test("blocked alert labels original-stop cancellation and uses only reviewed recovery explanations", () => {
  const known = formatVstBlockedAlert({
    reason: "unresolved_vst_order_intents",
    blockedForMs: 6 * 60_000,
    symbol: "ETHUSDT",
    operation: "cancel_original_stop",
    recoveryDeferredReason: "original_stop_cancel_pre_read_proof_unavailable",
  });
  assert.match(known, /Операция: отмена исходного общего стопа/);
  assert.match(known, /Сверка отложена: не удалось получить полное свежее подтверждение позиции и защитных стопов/);

  const unknown = formatVstBlockedAlert({
    reason: "unresolved_vst_order_intents",
    blockedForMs: 6 * 60_000,
    operation: "cancel_original_stop",
    recoveryDeferredReason: "BingX provider failure apiKey=private-secret",
  });
  assert.match(unknown, /Операция: отмена исходного общего стопа/);
  assert.doesNotMatch(unknown, /BingX provider failure|apiKey|private-secret|Сверка отложена:/);
});

test("a symbol-scoped block says other instruments keep trading, not that the whole pipeline stopped", () => {
  const stuckIntent = formatVstBlockedAlert({
    reason: "unresolved_vst_order_intents",
    blockedForMs: 6 * 60_000,
    count: 1,
    sourceSignalId: "cab-signal-15406",
    symbol: "USUSDT",
    operation: "margin_top_up",
  });
  assert.match(stuckIntent, /USUSDT требует вмешательства/);
  assert.match(stuckIntent, /Эта проблема не блокирует другие инструменты/);
  assert.doesNotMatch(stuckIntent, /исполнение сигналов остановлено/);
  assert.doesNotMatch(stuckIntent, /Конвейер заблокирован/);

  const stuckMarginTopUp = formatVstBlockedAlert({
    reason: "vst_margin_top_up_requires_verified_reconciliation",
    blockedForMs: 66 * 60_000,
    sourceSignalId: "cab-signal-15406",
    symbol: "USUSDT",
    operation: "margin_top_up",
  });
  assert.match(stuckMarginTopUp, /USUSDT требует вмешательства/);
  assert.match(stuckMarginTopUp, /Эта проблема не блокирует другие инструменты/);
  assert.doesNotMatch(stuckMarginTopUp, /Конвейер заблокирован/);

  // No identifiable symbol at all still means every symbol is genuinely
  // stopped -- the original, unscoped wording must still be used.
  const genuinelyGlobal = formatVstBlockedAlert({
    reason: "unresolved_vst_order_intents",
    blockedForMs: 6 * 60_000,
    count: 1,
  });
  assert.match(genuinelyGlobal, /исполнение сигналов остановлено/);
  assert.match(genuinelyGlobal, /Конвейер заблокирован уже 6 мин\. и не обрабатывает новые сигналы/);
});

test("explicit local scope describes a pre-runner problem without claiming global halt", () => {
  const text = formatVstBlockedAlert({
    reason: "impulse_full_split_close_requires_reconciliation",
    scope: "symbol",
    symbol: "KIIUSDT",
    sourceSignalId: "signal-fixture",
    blockedForMs: 8 * 60_000,
    operation: "close_pre_runner_split",
  });
  assert.match(text, /KIIUSDT требует вмешательства/);
  assert.match(text, /Эта проблема не блокирует другие инструменты/);
  assert.match(text, /повторная отправка без подтверждения запрещена/);
  assert.doesNotMatch(text, /исполнение сигналов остановлено|Конвейер заблокирован/);
});

test("account scope and missing or invalid symbols never claim local isolation", () => {
  for (const info of [
    { scope: "account", symbol: "KIIUSDT" },
    { scope: "symbol" },
    { scope: "symbol", symbol: "KIIUSDT\nunsafe" },
    { symbol: "KIIUSDT", reason: "impulse_full_split_close_requires_reconciliation" },
  ]) {
    const text = formatVstBlockedAlert({
      reason: "unresolved_vst_order_intents",
      blockedForMs: 6 * 60_000,
      ...info,
    });
    assert.match(text, /исполнение сигналов остановлено/);
    assert.doesNotMatch(text, /Эта проблема не блокирует другие инструменты/);
    assert.doesNotMatch(text, /unsafe/);
  }
});

test("blocked alerter sends to the configured chat and redacts the token on failure", async () => {
  const calls = [];
  const failing = createVstBlockedAlerter({
    token: "123:TEST_TOKEN", chatId: "-987",
    fetcher: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: false, status: 500 };
    },
  });
  await assert.rejects(
    failing.send({ reason: "unresolved_vst_order_intents", blockedForMs: 6 * 60_000 }),
    (error) => {
      assert.match(error.message, /HTTP 500/);
      assert.doesNotMatch(error.message, /123:TEST_TOKEN/);
      return true;
    },
  );
  assert.equal(calls[0].url, "https://api.telegram.org/bot123:TEST_TOKEN/sendMessage");
  assert.equal(calls[0].body.chat_id, "-987");
  assert.match(calls[0].body.text, /исполнение сигналов остановлено/);

  const sent = createVstBlockedAlerter({
    token: "123:TEST_TOKEN", chatId: "-987",
    fetcher: async () => ({ ok: true, json: async () => ({ ok: true }) }),
  });
  await sent.send({ reason: "unresolved_vst_order_intents", blockedForMs: 6 * 60_000 });
});

test("blocked alerter rejects malformed Telegram credentials", () => {
  assert.throws(() => createVstBlockedAlerter({ token: "not-a-token", chatId: "-1" }),
    /TELEGRAM_BOT_TOKEN/);
  assert.throws(() => createVstBlockedAlerter({ token: "123:abc", chatId: "not-numeric" }),
    /TELEGRAM_CHAT_ID/);
});

test("formats a source-discrepancy alert for each known kind", () => {
  const closed = formatSourceDiscrepancyAlert([
    { ledger: "vst", sourceSignalId: "sig-1", localSymbol: "BTCUSDT", kind: "source_closed_while_local_active" },
  ]);
  assert.match(closed, /^BingX · расхождение с источником сигналов/);
  assert.match(closed, /VST · BTCUSDT \(sig-1\)/);
  assert.match(closed, /источник \(Bullet\) подтвердил закрытие сигнала, а локальная запись ещё не закрыта/);
  assert.match(closed, /VST: бот должен закрыть остаток после проверки биржевой позиции/);
  assert.match(closed, /До подтверждения исполнения локальная запись не помечается закрытой/);

  const idMismatch = formatSourceDiscrepancyAlert([
    { ledger: "real", sourceSignalId: "sig-2", localSymbol: "ETHUSDT", kind: "source_signal_id_mismatch" },
  ]);
  assert.match(idMismatch, /REAL · ETHUSDT \(sig-2\)/);
  assert.match(idMismatch, /сигнал источника не совпадает по id с локальной позицией/);

  const symbolMismatch = formatSourceDiscrepancyAlert([
    { ledger: "vst", sourceSignalId: "sig-3", localSymbol: "ADAUSDT", kind: "symbol_mismatch" },
  ]);
  assert.match(symbolMismatch, /символ источника не совпадает с локальной позицией/);

  // An unlisted kind must still reach the owner instead of being dropped or
  // rendered blank.
  const unknownKind = formatSourceDiscrepancyAlert([
    { ledger: "vst", sourceSignalId: "sig-4", localSymbol: "SOLUSDT", kind: "some_future_kind" },
  ]);
  assert.match(unknownKind, /some_future_kind/);

  // A missing symbol or ledger label must not throw or render "undefined".
  const missingSymbol = formatSourceDiscrepancyAlert([
    { ledger: "unknown-ledger", sourceSignalId: "sig-5", kind: "symbol_mismatch" },
  ]);
  assert.match(missingSymbol, /unknown-ledger · \? \(sig-5\)/);
  assert.doesNotMatch(missingSymbol, /undefined/);
});

test("source alerts carry current snapshot facts without generic availability or publishing advice", () => {
  const text = formatSourceDiscrepancyAlert([{
    ledger: "vst", sourceSignalId: "cab-signal-17327", localSymbol: "CTUSDT",
    kind: "symbol_mismatch", sourceSymbol: "OTHERUSDT",
    localStatus: "open", sourceAction: "hold", sourceStatus: "active",
    sourceUpdatedAt: "2026-10-05T04:47:57.129Z",
    sourceAsOf: "2026-10-05T05:46:45.206Z", observedAt: "2026-10-05T05:46:45.348Z",
  }]);
  assert.match(text, /Источник: hold \/ active/);
  assert.match(text, /Локальная запись: open/);
  assert.match(text, /Символ источника: OTHERUSDT; локальный: CTUSDT/);
  assert.match(text, /Данные источника на: 2026-10-05T05:46:45.206Z/);
  assert.match(text, /Сверка: 2026-10-05T05:46:45.348Z/);
  assert.doesNotMatch(text, /Проверьте доступность|публикаци|позиция остаётся открытой/);
});

test("permanent poll alerts distinguish authorization from a missing or invalid action contract", () => {
  const base = { ledger: "source", kind: "source_contract_unavailable", observedAt: "2026-10-05T05:46:45.348Z" };
  for (const httpStatus of [401, 403]) {
    const text = formatSourceDiscrepancyAlert([{ ...base, httpStatus }]);
    assert.match(text, new RegExp(`HTTP ${httpStatus}`));
    assert.match(text, /авторизацию x-trading-token/);
    assert.doesNotMatch(text, /публикаци|версию источника|не опубликовал/);
  }
  const missing = formatSourceDiscrepancyAlert([{ ...base, failureCode: "source_action_contract_not_published" }]);
  assert.match(missing, /отсутствует обязательный sourceAction/);
  assert.doesNotMatch(missing, /отказал в доступе/);
  const invalid = formatSourceDiscrepancyAlert([{ ...base, failureCode: "invalid_source_action" }]);
  assert.match(invalid, /недопустимый sourceAction/);
  assert.doesNotMatch(invalid, /отказал в доступе|не опубликовал/);
});

test("batches multiple discrepancies into a single alert message", () => {
  const text = formatSourceDiscrepancyAlert([
    { ledger: "vst", sourceSignalId: "sig-1", localSymbol: "BTCUSDT", kind: "source_closed_while_local_active" },
    { ledger: "real", sourceSignalId: "sig-2", localSymbol: "ETHUSDT", kind: "symbol_mismatch" },
  ]);
  assert.match(text, /VST · BTCUSDT \(sig-1\)/);
  assert.match(text, /REAL · ETHUSDT \(sig-2\)/);
  // Exactly one trailer, not one per item.
  assert.equal((text.match(/Требуется ручная проверка позиции\./g) ?? []).length, 1);
});

test("source-discrepancy alerter rejects malformed Telegram credentials", () => {
  assert.throws(() => createSourceDiscrepancyAlerter({ token: "not-a-token", chatId: "-1" }),
    /TELEGRAM_BOT_TOKEN/);
  assert.throws(() => createSourceDiscrepancyAlerter({ token: "123:abc", chatId: "not-numeric" }),
    /TELEGRAM_CHAT_ID/);
});

test("source-discrepancy alerter sends batched items and redacts the token on failure", async () => {
  const calls = [];
  const failing = createSourceDiscrepancyAlerter({
    token: "123:TEST_TOKEN", chatId: "-987",
    fetcher: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: false, status: 500 };
    },
  });
  await assert.rejects(
    failing.send([{ ledger: "vst", sourceSignalId: "sig-1", localSymbol: "BTCUSDT", kind: "symbol_mismatch" }]),
    (error) => {
      assert.match(error.message, /HTTP 500/);
      assert.doesNotMatch(error.message, /123:TEST_TOKEN/);
      return true;
    },
  );
  assert.equal(calls[0].url, "https://api.telegram.org/bot123:TEST_TOKEN/sendMessage");
  assert.equal(calls[0].body.chat_id, "-987");
  assert.match(calls[0].body.text, /расхождение с источником сигналов/);

  const sentCalls = [];
  const sent = createSourceDiscrepancyAlerter({
    token: "123:TEST_TOKEN", chatId: "-987",
    fetcher: async (_url, options) => {
      sentCalls.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  await sent.send([{ ledger: "vst", sourceSignalId: "sig-1", localSymbol: "BTCUSDT", kind: "symbol_mismatch" }]);
  assert.equal(sentCalls.length, 1);
});

test("source-discrepancy alerter never calls Telegram for an empty batch", async () => {
  let called = false;
  const alerter = createSourceDiscrepancyAlerter({
    token: "123:TEST_TOKEN", chatId: "-987",
    fetcher: async () => { called = true; return { ok: true, json: async () => ({ ok: true }) }; },
  });
  await alerter.send([]);
  assert.equal(called, false);
  await alerter.send(undefined);
  assert.equal(called, false);
});
test("internal lifecycle noise is acknowledged silently and repeats are posted once", async () => {
  const sentIds = new Set();
  const sent = [];
  const rows = [
    { id: "59", kind: "vst_margin_mode_preparation_verified", source_signal_id: "woo",
      detail: { status: "filled", verified: true, operation: "prepare_margin_mode",
        marginMode: "ISOLATED", accountFlat: true, noOpenOrders: true, positionMode: "HEDGE" },
      body: { symbol: "WOOUSDT" }, request: null, outcome: null,
      created_at: new Date("2026-10-24T15:57:33.506Z") },
    { id: "60", kind: "vst_signal_status_changed", source_signal_id: "s1",
      detail: { from: "pending", to: "rejected" }, body: { symbol: "DOGEUSDT" },
      request: null, outcome: null, created_at: new Date() },
    { id: "61", kind: "vst_position_management_diagnostic", source_signal_id: "s1",
      detail: { scope: "symbol" }, body: { symbol: "DOGEUSDT" },
      request: null, outcome: null, created_at: new Date() },
    { id: "62", kind: "vst_signal_rejected", source_signal_id: "s1",
      detail: { reason: "signal_expired_before_entry_reservation" },
      body: { symbol: "DOGEUSDT" }, request: null, outcome: null, created_at: new Date() },
    { id: "63", kind: "vst_signal_rejected", source_signal_id: "s1",
      detail: { reason: "signal_expired_before_entry_reservation" },
      body: { symbol: "DOGEUSDT" }, request: null, outcome: null, created_at: new Date() },
  ];
  const pool = {
    async connect() {
      return {
        async query(sql, args) {
          if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
          if (sql.includes("pg_advisory_unlock")) return { rows: [{ released: true }] };
          if (sql.includes("FROM vst_events e")) {
            return { rows: rows.filter((row) => !sentIds.has(row.id)) };
          }
          if (sql.includes("SET telegram_sent_at")) {
            sentIds.add(args[0]);
            return { rows: [] };
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const notifier = createVstTelegramNotifier({
    pool, token: "123:TEST_TOKEN", chatId: "-123",
    fetcher: async (_url, options) => {
      sent.push(JSON.parse(options.body).text);
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  await notifier.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0], "BingX VST · DOGEUSDT\nПозиция не открыта.\nПричина: сигнал устарел до входа");
  assert.deepEqual([...sentIds], ["59", "60", "61", "62"]);
  await notifier.tick();
  assert.equal(sent.length, 1, "the identical repeat is not posted again");
  assert.deepEqual([...sentIds], ["59", "60", "61", "62", "63"]);
});

test("only final trade outcomes are user-facing; technical risks stay in the journal", () => {
  for (const kind of [
    "vst_entry_verified", "vst_signal_rejected", "vst_triggered_stop_verified",
    "exchange_history_provenance",
  ]) {
    assert.equal(isUserFacingVstEvent({ kind }), true, kind);
    assert.equal(typeof formatVstTelegramEvent(event(kind)), "string", kind);
  }
  for (const operation of ["raise_stop", "set_runner_break_even", "prepare_margin_mode"]) {
    assert.equal(isUserFacingVstEvent({
      kind: "vst_action_reconciled", request: { operation },
    }), false, operation);
  }
  assert.equal(isUserFacingVstEvent({
    kind: "vst_action_reconciled",
    request: { operation: "close_leg", nextPolicy: { status: "closed" } },
  }), true);
});
