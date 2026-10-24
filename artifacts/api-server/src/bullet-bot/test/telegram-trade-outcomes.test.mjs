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
    [event("vst_signal_rejected"), "Позиция не открыта."],
    [event("vst_worker_error", {
      detail: { reason: "entry_unverified_symbol_flat_after_timeout" },
    }), "Позиция не открыта."],
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
