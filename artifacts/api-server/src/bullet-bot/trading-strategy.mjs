// Trading strategies (owner 2026-10-28) for the owner's bot and every
// subscriber:
//   follow_cab — the bot does everything as CAB (AltBullet) says: CAB's stop,
//                CAB's protection and CAB's close; no rules of its own;
//   take5 / take8 / take10 — the whole position is closed at +5 / +8 / +10 %
//                price movement from the entry (CAB's stop and CAB's close
//                still apply until then);
//   patterns   — only 1, 2 or 3 of the 4 patterns are traded, with an exit
//                chosen separately (follow_cab / take5 / take8 / take10).
// BTC always follows CAB: it has its own ladder in CAB and a fixed +5/+8/+10 %
// take would contradict it.
import { isFullTakeStrategy } from "./fixed-price-take-profit.mjs";

export const TRADE_PATTERNS = Object.freeze([
  "stealth_breakout", "neon_support_bounce", "impulse_buy", "liquidation_cascade",
]);
export const TRADE_PATTERN_LABELS = Object.freeze({
  stealth_breakout: "Stealth Breakout",
  neon_support_bounce: "ABNeon Support",
  impulse_buy: "Impulse Buy",
  liquidation_cascade: "Liquidation Cascade",
});

export const EXIT_CHOICES = Object.freeze({
  follow_cab: { label: "Как CAB", exitStrategy: "source" },
  take5: { label: "Полная фиксация на +5%", exitStrategy: "full_take_5pct" },
  take8: { label: "Полная фиксация на +8%", exitStrategy: "full_take_8pct" },
  take10: { label: "Полная фиксация на +10%", exitStrategy: "full_take_10pct" },
});

export const TRADING_STRATEGIES = Object.freeze({
  follow_cab: { label: "Полностью следовать за ботом", available: true },
  take5: { label: "Полная фиксация на +5%", available: true },
  take8: { label: "Полная фиксация на +8%", available: true },
  take10: { label: "Полная фиксация на +10%", available: true },
  patterns: { label: "По паттернам", available: true },
});

export function isBtcSymbol(symbol) {
  return symbol === "BTCUSDT" || symbol === "BTC-USDT";
}

/** Normalizes a stored pattern list ("a,b" text or array) to a sorted array. */
export function parsePatterns(value) {
  const list = Array.isArray(value) ? value
    : typeof value === "string" ? value.split(",") : [];
  return [...new Set(list.map((v) => String(v).trim()).filter(Boolean))].sort();
}

/**
 * Validates a strategy choice and returns how the executor applies it:
 * { exitStrategy, allowedPatterns: Set|null }. Throws a TypeError with a
 * machine-readable message on an invalid choice.
 */
export function resolveTradingStrategy({ strategy, patternExit = null, patterns = null } = {}) {
  if (!Object.hasOwn(TRADING_STRATEGIES, strategy ?? "")) throw new TypeError("unknown_strategy");
  if (strategy !== "patterns") {
    return Object.freeze({ strategy, exitStrategy: EXIT_CHOICES[strategy].exitStrategy,
      allowedPatterns: null });
  }
  if (!Object.hasOwn(EXIT_CHOICES, patternExit ?? "")) throw new TypeError("pattern_exit_required");
  const list = parsePatterns(patterns);
  if (list.length < 1 || list.length > 3 || list.some((p) => !TRADE_PATTERNS.includes(p)))
    throw new TypeError("patterns_must_be_1_to_3_of_4");
  return Object.freeze({ strategy, exitStrategy: EXIT_CHOICES[patternExit].exitStrategy,
    patternExit, patterns: list, allowedPatterns: new Set(list) });
}

/** The exit strategy actually pinned on a new position for this symbol. */
export function entryExitStrategy(exitStrategy, symbol) {
  if (isBtcSymbol(symbol)) return "source";
  return exitStrategy === "source" || isFullTakeStrategy(exitStrategy) ? exitStrategy : "source";
}

/** Human-readable one-line description (journal / cabinet). */
export function describeTradingStrategy(resolved) {
  if (!resolved) return "—";
  if (resolved.strategy !== "patterns") return TRADING_STRATEGIES[resolved.strategy].label;
  return `По паттернам: ${resolved.patterns.map((p) => TRADE_PATTERN_LABELS[p]).join(", ")} · ` +
    EXIT_CHOICES[resolved.patternExit].label;
}
