import {
  validateTelegramCredentials, postTelegramMessage, redactTelegramError,
} from "./telegram-client.mjs";

// Unlike vst-telegram.mjs's notifier, this is deliberately an allowlist, not
// an unrestricted drain of every btb_events kind. btb_events already holds a
// long PAPER history (paper_entry, paper_close_partial, paper_raise_stop,
// funding settlements, ...) recorded long before telegram_sent_at existed.
// Draining every NULL row unrestricted would replay that entire backlog to
// Telegram the first time this notifier runs. Extend this list deliberately
// -- one reviewed kind at a time -- if another PAPER event should reach
// Telegram; never widen it to a catch-all without also backfilling
// telegram_sent_at on the existing historical rows.
const PAPER_TELEGRAM_EVENT_KINDS = ["paper_rejected_insufficient_balance"];

const LOCK_NAMESPACE = 4_348_998;
const LOCK_ID = 1;

export function formatPaperTelegramEvent(event) {
  const detail = event.detail ?? {};
  const symbol = /^[A-Z0-9]{1,20}USDT$/.test(detail.symbol ?? "") ? detail.symbol : null;
  const requiredUsdt = Number(detail.requiredUsdt);
  const timestamp = new Date(event.createdAt);
  let action;
  switch (event.kind) {
    case "paper_rejected_insufficient_balance":
      action = "Сигнал отклонён: не хватило свободного баланса PAPER-кошелька для открытия позиции";
      break;
    // Unreachable while PAPER_TELEGRAM_EVENT_KINDS only lists the kind
    // above; kept so a future added kind never falls through silently.
    default:
      action = `Событие PAPER: ${String(event.kind).replace(/^paper_/, "").replace(/_/g, " ")}`;
      break;
  }
  return [
    `PAPER${symbol ? ` · ${symbol}` : ""}`,
    action,
    Number.isFinite(requiredUsdt) && requiredUsdt > 0 ? `Требовалось: ${requiredUsdt} USDT` : null,
    event.sourceSignalId ? `Сигнал: ${event.sourceSignalId}` : null,
    Number.isFinite(timestamp.getTime()) ? `Событие: ${timestamp.toISOString()}` : null,
  ].filter(Boolean).join("\n");
}

// Durable per-event queue, mirroring createVstTelegramNotifier in
// vst-telegram.mjs: a crash between Telegram accepting the message and the
// telegram_sent_at write can resend once, but can never lose the
// notification, which a fire-and-forget send at rejection time could.
export function createPaperTelegramNotifier({ pool, token, chatId, fetcher = fetch }) {
  if (!pool || typeof pool.connect !== "function") throw new Error("Telegram notifier needs a DB pool");
  validateTelegramCredentials(token, chatId);
  let retryAfter = 0;
  return {
    async tick() {
      if (Date.now() < retryAfter) return;
      const client = await pool.connect();
      let locked = false;
      let destroyClient = false;
      try {
        const lock = await client.query(
          "SELECT pg_try_advisory_lock($1, $2) AS acquired",
          [LOCK_NAMESPACE, LOCK_ID],
        );
        locked = lock.rows[0]?.acquired === true;
        if (!locked) return;
        const result = await client.query(
          `SELECT id, source_signal_id, kind, detail, created_at
           FROM btb_events
           WHERE telegram_sent_at IS NULL AND kind = ANY($1::text[])
           ORDER BY id LIMIT 1`,
          [PAPER_TELEGRAM_EVENT_KINDS],
        );
        const row = result.rows[0];
        if (!row) return;
        const message = formatPaperTelegramEvent({
          kind: row.kind,
          detail: row.detail,
          sourceSignalId: row.source_signal_id,
          createdAt: row.created_at,
        });
        await postTelegramMessage({ token, chatId, text: message, fetcher });
        await client.query(
          "UPDATE btb_events SET telegram_sent_at = now() WHERE id = $1 AND telegram_sent_at IS NULL",
          [row.id],
        );
      } catch (error) {
        retryAfter = Date.now() + 60_000;
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
