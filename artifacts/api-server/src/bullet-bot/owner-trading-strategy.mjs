// The owner's own trading strategy (owner 2026-10-28). One row, created by
// itself (no drizzle push). Default: take5 — what the owner's bot did before.
// The running worker reads the cached value for every NEW entry; open
// positions keep the strategy they were opened with.
import { resolveTradingStrategy } from "./trading-strategy.mjs";

const DDL = `CREATE TABLE IF NOT EXISTS owner_trading_strategy (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  strategy text NOT NULL DEFAULT 'take5',
  pattern_exit text,
  patterns text,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
)`;
const DEFAULT = Object.freeze({ strategy: "take5", patternExit: null, patterns: null });
const ensured = new WeakMap();

export function ensureOwnerStrategyTable(pool) {
  let pending = ensured.get(pool);
  if (!pending) {
    pending = pool.query(DDL).then(() => true);
    pending.catch(() => ensured.delete(pool));
    ensured.set(pool, pending);
  }
  return pending;
}

export async function loadOwnerStrategy(pool) {
  await ensureOwnerStrategyTable(pool);
  const { rows } = await pool.query(
    "SELECT strategy, pattern_exit, patterns, updated_at FROM owner_trading_strategy WHERE id = 1");
  const row = rows[0];
  const choice = row
    ? { strategy: row.strategy, patternExit: row.pattern_exit, patterns: row.patterns }
    : DEFAULT;
  return { ...resolveTradingStrategy(choice), updatedAt: row?.updated_at ?? null };
}

/** Validates and saves; returns the resolved strategy. */
export async function saveOwnerStrategy(pool, choice) {
  const resolved = resolveTradingStrategy(choice);
  await ensureOwnerStrategyTable(pool);
  await pool.query(
    `INSERT INTO owner_trading_strategy (id, strategy, pattern_exit, patterns, updated_at)
     VALUES (1, $1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE SET strategy = EXCLUDED.strategy,
       pattern_exit = EXCLUDED.pattern_exit, patterns = EXCLUDED.patterns, updated_at = now()`,
    [resolved.strategy, resolved.patternExit ?? null, resolved.patterns?.join(",") ?? null],
  );
  return resolved;
}

/**
 * Cached owner strategy for the running worker, refreshed every `refreshMs`.
 * A failed read keeps the last known value (the default before the first one).
 */
export function createOwnerStrategyHolder(pool, { refreshMs = 15_000,
  log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  let current = resolveTradingStrategy(DEFAULT);
  let timer = null;
  async function refresh() {
    try {
      const next = await loadOwnerStrategy(pool);
      if (next.strategy !== current.strategy || next.exitStrategy !== current.exitStrategy ||
          (next.patterns ?? []).join(",") !== (current.patterns ?? []).join(",")) {
        log(`Owner trading strategy: ${next.strategy} (exit ${next.exitStrategy}` +
          `${next.patterns ? `, patterns ${next.patterns.join(",")}` : ""})`);
      }
      current = next;
    } catch (error) {
      log(`Owner trading strategy read failed: ${error instanceof Error ? error.message : "error"}`);
    }
    return current;
  }
  return {
    refresh,
    start() {
      if (timer) return;
      void refresh();
      timer = setInterval(() => void refresh(), refreshMs);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    exitStrategy: () => current.exitStrategy,
    allowedPatterns: () => current.allowedPatterns,
    current: () => current,
  };
}
