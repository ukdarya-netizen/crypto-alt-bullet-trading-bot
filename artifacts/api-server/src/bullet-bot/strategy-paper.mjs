// Background PAPER per strategy (owner 2026-10-28): every CAB signal the bot
// received is also "traded" on paper by each exit — follow CAB, full take
// +5 / +8 / +10 % — so the journal shows what each strategy earns to the
// deposit, whatever the real bot managed to open.
//
// Source of truth is CAB's own position snapshot (read every minute by the
// bot): entry, peak, exit price and status of each tracked signal.
//  - follow CAB: CAB's exit price;
//  - take N %: N % if CAB's peak reached entry × (1 + N %) — the peak is
//    always observed before the close, so the take came first — else CAB's
//    exit price (CAB's stop/close applies until the take);
//  - BTC follows CAB under every strategy.
// Fee 0.1 % per round trip. To the deposit: price % × 10x leverage × 1 % of
// the balance as margin = price % × 0.1 (no compounding).
// Known simplification: Impulse Buy is valued at CAB's final exit (the
// runner's), not the 80/20 core/runner mix.

export const PAPER_FEE_PCT = 0.1;
export const PAPER_LEVERAGE = 10;
export const PAPER_ALLOCATION_PCT = 1;
export const PAPER_EXITS = Object.freeze({ follow_cab: null, take5: 5, take8: 8, take10: 10 });
// Only the 4 patterns the bot trades; retired patterns (PLM, BA, ...) that
// are still in CAB's snapshot are counted separately and left out.
export const PAPER_PATTERNS = Object.freeze([
  "stealth_breakout", "neon_support_bounce", "impulse_buy", "liquidation_cascade",
]);
const CLOSED = new Set(["profit", "stop_loss", "bu_stop", "breakeven", "cancelled", "expired"]);
const OPEN = new Set(["active", "in_run"]);

const DDL = `CREATE TABLE IF NOT EXISTS strategy_paper_trades (
  source_signal_id text PRIMARY KEY,
  symbol text NOT NULL,
  pattern_id text,
  signal_at timestamp with time zone,
  entry_price numeric,
  peak_price numeric,
  exit_price numeric,
  source_status text,
  closed_at timestamp with time zone,
  first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
)`;
const ensured = new WeakMap();
export function ensureStrategyPaperTable(pool) {
  let pending = ensured.get(pool);
  if (!pending) {
    pending = pool.query(DDL).then(() => true);
    pending.catch(() => ensured.delete(pool));
    ensured.set(pool, pending);
  }
  return pending;
}

const num = (v) => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Upserts CAB's latest state of every signal the owner's bot received.
 * `positions` is the complete snapshot Map (sourceSignalId -> position).
 * A closed row is never reopened or changed.
 */
export async function recordStrategyPaperSnapshot(pool, positions) {
  if (!(positions instanceof Map) || positions.size === 0) return 0;
  await ensureStrategyPaperTable(pool);
  const ids = [...positions.keys()].map(String);
  const { rows } = await pool.query(
    `SELECT source_signal_id, body->>'patternId' AS pattern_id
       FROM vst_signals WHERE source_signal_id = ANY($1::text[])`, [ids]);
  let written = 0;
  for (const row of rows) {
    const p = positions.get(row.source_signal_id);
    if (!p) continue;
    const status = p.sourceStatus ?? null;
    const closed = CLOSED.has(status) && num(p.sourceExitPrice) !== null;
    const result = await pool.query(
      `INSERT INTO strategy_paper_trades (source_signal_id, symbol, pattern_id, signal_at,
         entry_price, peak_price, exit_price, source_status, closed_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (source_signal_id) DO UPDATE SET
         entry_price = COALESCE(strategy_paper_trades.entry_price, EXCLUDED.entry_price),
         peak_price = GREATEST(COALESCE(strategy_paper_trades.peak_price, 0), COALESCE(EXCLUDED.peak_price, 0)),
         exit_price = EXCLUDED.exit_price, source_status = EXCLUDED.source_status,
         closed_at = EXCLUDED.closed_at, updated_at = now()
       WHERE strategy_paper_trades.closed_at IS NULL`,
      [row.source_signal_id, String(p.symbol).replace(/-/g, "").toUpperCase(), row.pattern_id ?? null,
        p.signalAt ?? null, num(p.sourceEntryPrice), num(p.sourcePeakPrice),
        closed ? num(p.sourceExitPrice) : null, status,
        closed ? (p.sourceClosedAt ?? new Date().toISOString()) : null],
    );
    written += result.rowCount ?? 0;
  }
  return written;
}

/** Price % of one closed paper trade under an exit (null when not valued). */
export function paperTradePct(row, exit) {
  const entry = num(row.entry_price), exitPrice = num(row.exit_price);
  if (entry === null || exitPrice === null) return null;
  const cab = (exitPrice / entry - 1) * 100 - PAPER_FEE_PCT;
  const take = PAPER_EXITS[exit];
  if (take === null || take === undefined) return cab;
  const btc = row.symbol === "BTCUSDT";
  const peak = num(row.peak_price);
  if (!btc && peak !== null && peak >= entry * (1 + take / 100)) return take - PAPER_FEE_PCT;
  return cab;
}

/** Deposit % of a price % (10x, 1 % of the balance as margin). */
export const depositPct = (pricePct) => pricePct * PAPER_LEVERAGE * PAPER_ALLOCATION_PCT / 100;

function emptyStats() { return { trades: 0, wins: 0, sumPricePct: 0, depositPct: 0 }; }
function add(stats, pct) {
  stats.trades += 1; if (pct > 0) stats.wins += 1;
  stats.sumPricePct += pct; stats.depositPct += depositPct(pct);
}
function finish(stats) {
  return { trades: stats.trades, wins: stats.wins,
    winRatePct: stats.trades ? Math.round(stats.wins / stats.trades * 1000) / 10 : null,
    avgTradePct: stats.trades ? Math.round(stats.sumPricePct / stats.trades * 100) / 100 : null,
    depositPct: Math.round(stats.depositPct * 100) / 100 };
}

/**
 * Aggregates closed rows: per exit overall, and per pattern × exit (for the
 * "by patterns" strategy, whose result is the sum of the chosen patterns).
 */
export function summarizeStrategyPaper(rows, { patterns = [], days = null, now = Date.now() } = {}) {
  const exits = Object.keys(PAPER_EXITS);
  const overall = Object.fromEntries(exits.map((e) => [e, emptyStats()]));
  const byPattern = {};
  const fromMs = Number.isFinite(days) && days > 0 ? now - days * 86_400_000 : null;
  let open = 0, otherPatterns = 0, from = null, to = null;
  for (const row of rows) {
    const pattern = row.pattern_id ?? "unknown";
    const signalMs = row.signal_at ? new Date(row.signal_at).getTime() : null;
    if (fromMs !== null && (signalMs === null || signalMs < fromMs)) continue;
    if (!PAPER_PATTERNS.includes(pattern)) { if (row.closed_at) otherPatterns += 1; continue; }
    if (OPEN.has(row.source_status) && !row.closed_at) { open += 1; continue; }
    if (!row.closed_at) continue;
    if (signalMs !== null) {
      if (from === null || signalMs < from) from = signalMs;
      if (to === null || signalMs > to) to = signalMs;
    }
    byPattern[pattern] ??= Object.fromEntries(exits.map((e) => [e, emptyStats()]));
    for (const exit of exits) {
      const pct = paperTradePct(row, exit);
      if (pct === null) continue;
      add(overall[exit], pct);
      add(byPattern[pattern][exit], pct);
    }
  }
  const out = {
    days: fromMs === null ? null : days,
    signalsFrom: from === null ? null : new Date(from).toISOString(),
    signalsTo: to === null ? null : new Date(to).toISOString(),
    openTrades: open, otherPatternsExcluded: otherPatterns,
    exits: Object.fromEntries(exits.map((e) => [e, finish(overall[e])])),
    byPattern: Object.fromEntries(Object.entries(byPattern).map(([p, s]) =>
      [p, Object.fromEntries(exits.map((e) => [e, finish(s[e])]))])),
  };
  if (patterns.length) {
    out.selection = Object.fromEntries(exits.map((e) => {
      const s = emptyStats();
      for (const p of patterns) {
        const st = byPattern[p]?.[e];
        if (!st) continue;
        s.trades += st.trades; s.wins += st.wins; s.sumPricePct += st.sumPricePct; s.depositPct += st.depositPct;
      }
      return [e, finish(s)];
    }));
  }
  return out;
}

export async function loadStrategyPaper(pool, options = {}) {
  await ensureStrategyPaperTable(pool);
  const { rows } = await pool.query(
    `SELECT source_signal_id, symbol, pattern_id, signal_at, entry_price, peak_price, exit_price,
            source_status, closed_at, first_seen_at FROM strategy_paper_trades`);
  return summarizeStrategyPaper(rows, options);
}
