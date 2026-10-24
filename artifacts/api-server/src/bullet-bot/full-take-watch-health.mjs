// Health of the +5% take watcher. When BingX prices cannot be read for
// thresholdMs while full-take positions are open, the owner gets ONE plain
// text notice (the exchange stop-loss still protects every position), and
// one "restored" notice when reading works again. Never more than that.
export const FULL_TAKE_WATCH_OUTAGE_TEXT =
  "BingX VST · бот не получает цены с биржи больше 2 минут.\n" +
  "Тейк +5% сейчас не отслеживается. Стоп-лоссы на бирже действуют.\n" +
  "Бот продолжает попытки; при восстановлении придёт сообщение.";
export const FULL_TAKE_WATCH_RESTORED_TEXT =
  "BingX VST · цены с биржи снова поступают. Отслеживание тейка +5% восстановлено.";

export function createFullTakeWatchHealth({ send, now = Date.now, thresholdMs = 120_000 }) {
  let failingSince = null;
  let alerted = false;
  const deliver = async (text) => {
    try { await send(text); return true; } catch { return false; }
  };
  return {
    async success() {
      failingSince = null;
      if (alerted && await deliver(FULL_TAKE_WATCH_RESTORED_TEXT)) alerted = false;
    },
    async failure() {
      const at = Number(now());
      failingSince ??= at;
      if (!alerted && at - failingSince >= thresholdMs &&
          await deliver(FULL_TAKE_WATCH_OUTAGE_TEXT)) alerted = true;
    },
    state: () => ({ failingSince, alerted }),
  };
}
