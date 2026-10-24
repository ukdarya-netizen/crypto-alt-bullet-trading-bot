// Shared low-level Telegram delivery helpers. Kept free of any bot-specific
// (PAPER vs VST) formatting or event-selection logic so both notifiers can
// depend on the exact same validation and error-redaction behavior.

export function validateTelegramCredentials(token, chatId) {
  if (typeof token !== "string" || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("TELEGRAM_BOT_TOKEN has an invalid format");
  }
  if (typeof chatId !== "string" || !/^-?\d{1,20}$/.test(chatId)) {
    throw new Error("TELEGRAM_CHAT_ID must be a numeric Telegram chat ID");
  }
}

export async function postTelegramMessage({ token, chatId, text, fetcher }) {
  const response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Telegram sendMessage HTTP ${response.status}`);
  const body = await response.json();
  if (body?.ok !== true) throw new Error("Telegram sendMessage was not accepted");
}

// Never log Telegram's URL or response; the URL contains the bot token.
export function redactTelegramError(error) {
  return error instanceof Error
    ? error.message.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[redacted]")
    : "Telegram delivery failed";
}
