import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatVstTradeOutcome,
  vstTradeOutcome,
  TECHNICAL_TELEGRAM_ALERTS_ENABLED,
} from "../telegram-trade-outcomes.mjs";
import { createVstTelegramNotifier } from "../vst-telegram.mjs";

const event = (kind, extra = {}) => ({ kind, symbol: "WOOUSDT", ...extra });

test("Telegram has exactly four concise trade outcome messages", () => {
  for (const [row, text] of [
    [event("vst_entry_verified"), "Позиция открыта."],
    [event("vst_entry_margin_top_up_pending"), "Позиция открыта."],
    [event("vst_signal_rejected"), "Позиция не открыта.\nПричина: причина не указана"],
    [event("vst_worker_error", {
      detail: { reason: "entry_unverified_symbol_flat_after_timeout" },
    }), "Позиция не открыта.\nПричина: ордер не исполнен, позиции на бирже нет"],
    [event("vst_action_reconciled", {
      request: { operation: "close_leg", nextPolicy: { status: "closed" } },
    }), "Позиция зафиксирована."],
    [event("source_exit_completed", { detail: { outcome: "closed" } }),
      "Позиция зафиксирована."],
    [event("vst_triggered_stop_verified"), "Сработал стоп-лосс."],
    [event("source_exit_completed", {
      detail: { outcome: "closed", detail: { closureOrigin: "already_committed_protective_stop" } },
    }), "Сработал стоп-лосс."],
  ]) {
    assert.equal(formatVstTradeOutcome(row), `BingX VST · WOOUSDT\n${text}`);
  }
});

test("pending, technical and unknown events cannot masquerade as trade outcomes", () => {
  assert.equal(TECHNICAL_TELEGRAM_ALERTS_ENABLED, false);
  for (const kind of [
    "vst_margin_mode_preparation_verified", "vst_margin_top_up_verified",
    "vst_margin_top_up_funded_but_unsafe", "vst_margin_top_up_unconfirmed",
    "vst_stop_protection_degraded", "vst_position_management_diagnostic",
    "vst_pre_runner_close_retry_limit", "vst_action_unresolved",
    "vst_worker_error", "vst_signal_status_changed", "future_event",
  ]) {
    const row = event(kind, {
      detail: { reason: "entry_result_not_verified", operation: "entry" },
    });
    assert.equal(vstTradeOutcome(row), null, kind);
    assert.equal(formatVstTradeOutcome(row), null, kind);
  }
  assert.equal(formatVstTradeOutcome(event("vst_entry_verified", { symbol: null })), null);
  assert.equal(vstTradeOutcome(event("vst_worker_error", {
    detail: { reason: "entry_abandoned_confirmed_flat_account" },
  })), null, "flat now does not prove entry never filled");
  assert.equal(vstTradeOutcome(event("source_exit_completed", {
    detail: { outcome: "cancelled_unentered" },
  })), null, "no confirmed entry is not proof of no execution");
  assert.equal(vstTradeOutcome(event("vst_action_reconciled", {
    request: { operation: "close_leg", nextPolicy: { status: "open" } },
  })), null, "a partial fill must not be described as a full close");
  assert.equal(vstTradeOutcome(event("vst_impulse_triggered_stop_verified", {
    detail: { residualQuantity: 12 },
  })), null);
});

test("confirmed close paths are covered without calling a market close a stop loss", () => {
  for (const kind of [
    "vst_impulse_sole_split_leg_closed", "vst_impulse_full_split_position_closed",
    "vst_impulse_flat_close_cleanup_pending", "vst_source_exit_closed",
    "vst_source_exit_flat_cleanup_pending", "exchange_history_provenance",
  ]) assert.equal(vstTradeOutcome(event(kind)), "closed", kind);
  assert.equal(vstTradeOutcome(event("vst_protected_strategy_exit_verified", {
    request: { nextPolicy: { status: "closed" } },
  })), "closed");
});

test("WOO lifecycle sends an opening and final result, never margin or reconciliation text", async () => {
  const rows = [
    event("vst_margin_mode_preparation_verified"),
    event("vst_action_unresolved", { detail: { reason: "entry_result_not_verified", operation: "entry" } }),
    event("vst_entry_margin_top_up_pending"),
    event("vst_margin_top_up_verified"),
    event("vst_entry_verified"),
    event("vst_action_reconciled", { request: { operation: "raise_stop" } }),
    event("vst_source_exit_closed"),
    event("source_exit_completed", { detail: { outcome: "closed" } }),
  ].map((row, index) => ({
    ...row, id: String(index), source_signal_id: "woo-test",
    body: { symbol: row.symbol }, created_at: new Date(),
  }));
  const acknowledged = new Set();
  const messages = [];
  const pool = {
    async connect() {
      return {
        async query(sql, params) {
          if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
          if (sql.includes("pg_advisory_unlock")) return { rows: [{ released: true }] };
          if (sql.includes("FROM vst_events e")) return {
            rows: rows.filter(row => !acknowledged.has(row.id)),
          };
          if (sql.includes("FROM vst_events prior")) return {
            rows: rows.filter(row => acknowledged.has(row.id) &&
              row.source_signal_id === params[0] && Number(row.id) < Number(params[1])),
          };
          if (sql.includes("SET telegram_sent_at")) {
            acknowledged.add(params[0]);
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
      messages.push(JSON.parse(options.body).text);
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  for (let index = 0; index < 4; index++) await notifier.tick();
  assert.deepEqual(messages, [
    "BingX VST · WOOUSDT\nПозиция открыта.",
    "BingX VST · WOOUSDT\nПозиция зафиксирована.",
  ]);
  assert.equal(acknowledged.size, rows.length);
});

test("not-opened message always carries a readable reason", () => {
  const text = (reason, kind = "vst_signal_rejected", extra = {}) =>
    formatVstTradeOutcome(event(kind, { detail: { reason, ...extra } }));
  assert.equal(text("insufficient_available_vst,below_minimum_notional"),
    "BingX VST · WOOUSDT\nПозиция не открыта.\nПричина: недостаточно свободных VST; сумма меньше минимальной");
  assert.equal(text("vst_symbol_currently_offline:paused"),
    "BingX VST · WOOUSDT\nПозиция не открыта.\nПричина: монета сейчас недоступна на BingX VST");
  assert.equal(text("some_new_code"),
    "BingX VST · WOOUSDT\nПозиция не открыта.\nПричина: some_new_code");
  assert.equal(text("vst_order_rejected", "vst_worker_error", { operation: "entry" }),
    "BingX VST · WOOUSDT\nПозиция не открыта.\nПричина: биржа отклонила ордер");
  assert.equal(vstTradeOutcome(event("vst_worker_error", {
    detail: { reason: "vst_order_rejected", operation: "close_leg" },
  })), null, "a rejected close is not a rejected entry");
});

test("a touched +5% take that is not closed gets two distinct, once-only notices", () => {
  const detail = { entryPrice: "0.009989999999999999", observedPrice: "0.01053",
    reason: "source_exit_same_symbol_intent_unresolved" };
  assert.equal(formatVstTradeOutcome(event("vst_full_take_close_delayed", { detail })),
    "BingX VST · WOOUSDT\nЦена достигла +5%, но позиция ещё не закрыта. Бот продолжает закрывать её. Стоп-лосс на бирже сохраняется.\n" +
    "Вход 0.00999 · цена 0.01053\nПричина: по монете не завершена предыдущая операция, бот сверяет её с биржей");
  const stuck = formatVstTradeOutcome(event("vst_full_take_close_stuck", {
    detail: { ...detail, reason: "full_take_close_not_attempted" } }));
  assert.match(stuck, /Закройте её вручную на BingX VST/);
  assert.match(stuck, /Причина: цикл бота ещё не дошёл до закрытия/);
  assert.notEqual(vstTradeOutcome(event("vst_full_take_close_delayed")),
    vstTradeOutcome(event("vst_full_take_close_stuck")), "separate repeat keys");
  assert.equal(vstTradeOutcome(event("vst_full_take_touched")), null, "a touch alone is not posted");
});

test("a restart does not repeat an opening already posted for the same signal", async () => {
  const rows = [
    event("vst_entry_margin_top_up_pending"),
    event("vst_entry_verified"),
  ].map((row, index) => ({
    ...row, id: String(index + 1), source_signal_id: "id-signal",
    body: { symbol: row.symbol }, created_at: new Date(),
  }));
  const acknowledged = new Set();
  const messages = [];
  const pool = {
    async connect() {
      return {
        async query(sql, params) {
          if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
          if (sql.includes("pg_advisory_unlock")) return { rows: [{ released: true }] };
          if (sql.includes("FROM vst_events prior")) return {
            rows: rows.filter(row => acknowledged.has(row.id) &&
              row.source_signal_id === params[0] && Number(row.id) < Number(params[1])),
          };
          if (sql.includes("FROM vst_events e")) return {
            rows: rows.filter(row => !acknowledged.has(row.id)),
          };
          if (sql.includes("SET telegram_sent_at")) { acknowledged.add(params[0]); return { rows: [] }; }
          throw new Error("unexpected SQL");
        },
        release() {},
      };
    },
  };
  const make = () => createVstTelegramNotifier({
    pool, token: "123:TEST_TOKEN", chatId: "-123",
    fetcher: async (_url, options) => {
      messages.push(JSON.parse(options.body).text);
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  await make().tick();
  await make().tick(); // a fresh notifier = a restart; its memory is empty
  assert.deepEqual(messages, ["BingX VST · WOOUSDT\nПозиция открыта."]);
  assert.equal(acknowledged.size, 2);
});

test("a quarantined position is reported once in plain text", () => {
  assert.equal(formatVstTradeOutcome(event("vst_position_management_quarantined", { detail: { diagnosticRef: "x" } })),
    "BingX VST · WOOUSDT\nБот не может сопровождать эту позицию из-за ошибки. Стоп-лосс на бирже стоит, тейк +5% отслеживается. Новые сигналы по другим монетам открываются.");
});

test("a position verified flat outside the bot is reported once, not also as a bot close", () => {
  assert.equal(formatVstTradeOutcome(event("vst_external_close_verified", { detail: { observations: 3 } })),
    "BingX VST · WOOUSDT\nПозиции больше нет на бирже (закрыта вручную или вне бота). Бот это проверил и снял её с сопровождения.");
  assert.equal(vstTradeOutcome(event("source_exit_completed", {
    detail: { outcome: "closed", detail: { closureOrigin: "external_close_verified_flat" } },
  })), null);
});
