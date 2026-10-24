import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPaperTelegramNotifier,
  formatPaperTelegramEvent,
} from "../paper-telegram.mjs";

function event(kind, extra = {}) {
  return {
    kind, detail: { symbol: "ETHUSDT", requiredUsdt: 12.34 },
    sourceSignalId: "sig-1", createdAt: "2026-09-29T08:00:00Z", ...extra,
  };
}

test("formats an insufficient-balance rejection with symbol, amount, and signal id", () => {
  const text = formatPaperTelegramEvent(event("paper_rejected_insufficient_balance"));
  assert.match(text, /^PAPER · ETHUSDT\n/);
  assert.match(text, /не хватило свободного баланса PAPER-кошелька/);
  assert.match(text, /Требовалось: 12\.34 USDT/);
  assert.match(text, /Сигнал: sig-1/);
  assert.match(text, /Событие: 2026-09-29T08:00:00\.000Z/);
});

test("falls back to a generic message instead of dropping an unlisted event kind", () => {
  const generic = formatPaperTelegramEvent(event("paper_something_future", {
    detail: { symbol: "BTCUSDT" },
  }));
  assert.match(generic, /^PAPER · BTCUSDT\n/);
  assert.match(generic, /something future/);
});

test("omits the amount line when requiredUsdt is missing or non-positive", () => {
  const text = formatPaperTelegramEvent(event("paper_rejected_insufficient_balance", {
    detail: { symbol: "ETHUSDT" },
  }));
  assert.doesNotMatch(text, /Требовалось/);
});

test("acknowledges only after Telegram accepts; failed sends remain retryable", async () => {
  const calls = [];
  const row = {
    id: "9", source_signal_id: "sig-2", kind: "paper_rejected_insufficient_balance",
    detail: { symbol: "SOLUSDT", requiredUsdt: 15 }, created_at: new Date("2026-09-29T09:00:00Z"),
  };
  const pool = {
    async connect() {
      return {
        async query(sql, args) {
          calls.push({ sql, args });
          if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
          if (sql.includes("pg_advisory_unlock")) return { rows: [{ released: true }] };
          if (sql.includes("FROM btb_events")) return { rows: [row] };
          return { rows: [{ released: true }] };
        },
        release() { calls.push({ released: true }); },
      };
    },
  };
  const failing = createPaperTelegramNotifier({
    pool, token: "123:TEST_TOKEN", chatId: "-123",
    fetcher: async (_url, options) => {
      assert.equal(JSON.parse(options.body).chat_id, "-123");
      return { ok: false, status: 429 };
    },
  });
  await assert.rejects(failing.tick(), /HTTP 429/);
  assert.equal(calls.some((call) => call.sql?.includes("SET telegram_sent_at")), false);
  assert.equal(calls.at(-1).released, true);

  const sent = createPaperTelegramNotifier({
    pool, token: "123:TEST_TOKEN", chatId: "-123",
    fetcher: async () => ({ ok: true, json: async () => ({ ok: true }) }),
  });
  await sent.tick();
  const ack = calls.find((call) => call.sql?.includes("SET telegram_sent_at"));
  assert.deepEqual(ack.args, ["9"]);
  const select = calls.find((call) => call.sql?.includes("FROM btb_events"));
  assert.match(select.sql, /WHERE telegram_sent_at IS NULL AND kind = ANY\(\$1::text\[\]\)/);
  assert.deepEqual(select.args, [["paper_rejected_insufficient_balance"]]);
});

test("an unrelated historical btb_events kind is never selected", async () => {
  // btb_events already holds a long pre-existing history (paper_entry,
  // paper_close_partial, ...) with telegram_sent_at left NULL. The notifier
  // must never drain those -- only the explicitly allow-listed kind.
  const calls = [];
  const pool = {
    async connect() {
      return {
        async query(sql, args) {
          calls.push({ sql, args });
          if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
          if (sql.includes("pg_advisory_unlock")) return { rows: [{ released: true }] };
          if (sql.includes("FROM btb_events")) {
            assert.deepEqual(args, [["paper_rejected_insufficient_balance"]]);
            return { rows: [] };
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const notifier = createPaperTelegramNotifier({
    pool, token: "123:TEST_TOKEN", chatId: "-123",
    fetcher: async () => { throw new Error("must not send"); },
  });
  await notifier.tick();
  assert.equal(calls.some((call) => call.sql?.includes("SET telegram_sent_at")), false);
});

test("rejects malformed Telegram credentials", () => {
  assert.throws(() => createPaperTelegramNotifier({
    pool: { connect: async () => ({}) }, token: "bad", chatId: "-123",
  }), /TELEGRAM_BOT_TOKEN/);
  assert.throws(() => createPaperTelegramNotifier({
    pool: { connect: async () => ({}) }, token: "123:TEST_TOKEN", chatId: "not-a-number",
  }), /TELEGRAM_CHAT_ID/);
});
