// Pure statistics for the overview page. No fetching, no formatting side
// effects. A trade whose result the ledger cannot prove (pnl === null) is
// counted separately and never treated as zero.

export type PeriodId = "7d" | "30d" | "90d" | "all";

export const PERIODS: ReadonlyArray<{ id: PeriodId; label: string; days: number | null }> = [
  { id: "7d", label: "7 дней", days: 7 },
  { id: "30d", label: "30 дней", days: 30 },
  { id: "90d", label: "90 дней", days: 90 },
  { id: "all", label: "Всё время", days: null },
];

export type ResultTrade = {
  id: string;
  symbol: string;
  patternId: string | null;
  closedAt: string;
  pnlUsdt: number | null;
  roePercent: number | null;
  closeReason?: string | null;
};

export type Summary = {
  trades: number;
  counted: number;
  unknown: number;
  wins: number;
  losses: number;
  breakeven: number;
  netUsdt: number;
  grossProfitUsdt: number;
  grossLossUsdt: number;
  winRate: number | null;
  profitFactor: number | null;
  avgUsdt: number | null;
  avgRoePercent: number | null;
  avgWinUsdt: number | null;
  avgLossUsdt: number | null;
  best: ResultTrade | null;
  worst: ResultTrade | null;
  maxDrawdownUsdt: number;
};

// Results within ±0.000001 USDT are break-even, not wins or losses.
const EPSILON = 1e-6;

export function periodStart(period: PeriodId, now: number): number | null {
  const days = PERIODS.find((item) => item.id === period)?.days ?? null;
  return days === null ? null : now - days * 24 * 60 * 60 * 1000;
}

export function inPeriod<T extends { closedAt: string }>(trades: T[], period: PeriodId, now: number): T[] {
  const start = periodStart(period, now);
  if (start === null) return trades;
  return trades.filter((trade) => {
    const at = Date.parse(trade.closedAt);
    return Number.isFinite(at) && at >= start;
  });
}

function byTime(a: ResultTrade, b: ResultTrade) {
  return Date.parse(a.closedAt) - Date.parse(b.closedAt) || a.id.localeCompare(b.id);
}

export function summarize(trades: ResultTrade[]): Summary {
  const counted = trades.filter((trade) => trade.pnlUsdt !== null && Number.isFinite(trade.pnlUsdt));
  const wins = counted.filter((trade) => trade.pnlUsdt! > EPSILON);
  const losses = counted.filter((trade) => trade.pnlUsdt! < -EPSILON);
  const grossProfitUsdt = wins.reduce((sum, trade) => sum + trade.pnlUsdt!, 0);
  const grossLossUsdt = losses.reduce((sum, trade) => sum + trade.pnlUsdt!, 0);
  const netUsdt = counted.reduce((sum, trade) => sum + trade.pnlUsdt!, 0);
  const roes = counted.map((trade) => trade.roePercent).filter((value): value is number =>
    value !== null && Number.isFinite(value));
  let peak = 0;
  let equity = 0;
  let maxDrawdownUsdt = 0;
  for (const trade of [...counted].sort(byTime)) {
    equity += trade.pnlUsdt!;
    peak = Math.max(peak, equity);
    maxDrawdownUsdt = Math.max(maxDrawdownUsdt, peak - equity);
  }
  const decided = wins.length + losses.length;
  return {
    trades: trades.length,
    counted: counted.length,
    unknown: trades.length - counted.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: counted.length - decided,
    netUsdt,
    grossProfitUsdt,
    grossLossUsdt,
    winRate: decided ? wins.length / decided * 100 : null,
    profitFactor: grossLossUsdt < -EPSILON ? grossProfitUsdt / Math.abs(grossLossUsdt)
      : grossProfitUsdt > EPSILON ? Infinity : null,
    avgUsdt: counted.length ? netUsdt / counted.length : null,
    avgRoePercent: roes.length ? roes.reduce((a, b) => a + b, 0) / roes.length : null,
    avgWinUsdt: wins.length ? grossProfitUsdt / wins.length : null,
    avgLossUsdt: losses.length ? grossLossUsdt / losses.length : null,
    best: counted.length ? counted.reduce((a, b) => (b.pnlUsdt! > a.pnlUsdt! ? b : a)) : null,
    worst: counted.length ? counted.reduce((a, b) => (b.pnlUsdt! < a.pnlUsdt! ? b : a)) : null,
    maxDrawdownUsdt,
  };
}

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Samara", year: "numeric", month: "2-digit", day: "2-digit",
});

export function samaraDay(iso: string): string | null {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? dayFormatter.format(new Date(at)) : null;
}

export type DailyPoint = { day: string; pnl: number; cumulative: number; trades: number };

// One point per calendar day (Samara time) between the first and last close,
// including quiet days, so the curve's time axis is honest.
export function dailySeries(trades: ResultTrade[]): DailyPoint[] {
  const byDay = new Map<string, { pnl: number; trades: number }>();
  for (const trade of trades) {
    if (trade.pnlUsdt === null || !Number.isFinite(trade.pnlUsdt)) continue;
    const day = samaraDay(trade.closedAt);
    if (!day) continue;
    const entry = byDay.get(day) ?? { pnl: 0, trades: 0 };
    entry.pnl += trade.pnlUsdt;
    entry.trades += 1;
    byDay.set(day, entry);
  }
  const days = [...byDay.keys()].sort();
  if (!days.length) return [];
  const result: DailyPoint[] = [];
  let cumulative = 0;
  const end = Date.parse(`${days.at(-1)}T00:00:00Z`);
  for (let at = Date.parse(`${days[0]}T00:00:00Z`); at <= end; at += 86_400_000) {
    const day = new Date(at).toISOString().slice(0, 10);
    const entry = byDay.get(day) ?? { pnl: 0, trades: 0 };
    cumulative += entry.pnl;
    result.push({ day, pnl: round(entry.pnl), cumulative: round(cumulative), trades: entry.trades });
  }
  return result;
}

export function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    groups.set(name, [...(groups.get(name) ?? []), item]);
  }
  return groups;
}

function round(value: number) {
  return Number(value.toFixed(6));
}

export const PATTERN_NAMES: Record<string, string> = {
  liquidation_cascade: "Liquidation Cascade",
  balanced_grind: "Balanced Grind",
  impulse_buy: "Impulse Buy",
  price_led_momentum: "Price-Led Momentum",
};

export function patternName(id: string | null): string {
  if (!id) return "Без паттерна";
  return PATTERN_NAMES[id] ?? id.replaceAll("_", " ");
}

// Groups of VST close reasons the owner actually cares about.
export function closeReasonGroup(reason: string | null | undefined): { id: string; label: string } {
  switch (reason) {
    case "fixed_price_take_profit_5pct":
      return { id: "take5", label: "Тейк +5%" };
    case "protective_stop":
    case "breakeven_stop":
    case "runner_stop":
    case "percentage_point_trailing_stop":
    case "protected_profit_floor":
    case "runner_break_even_unavailable_at_or_below_entry":
      return { id: "stop", label: "Стоп-лосс" };
    case "source_closed":
    case "source_command_close":
    case "source_withdrawal":
      return { id: "source", label: "Закрыто по сигналу AltBullet" };
    case "manual_owner_resolution":
      return { id: "manual", label: "Закрыто вручную" };
    case "exchange_history_provenance":
      return { id: "history", label: "Восстановлено по истории биржи" };
    default:
      return { id: "other", label: "Другое" };
  }
}

export function formatUsdt(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const fixed = Math.abs(value) < 0.005 && value !== 0 ? value.toFixed(4) : value.toFixed(digits);
  return `${value > 0 ? "+" : ""}${fixed.replace(".", ",")}`;
}

export function formatPercent(value: number | null | undefined, digits = 1, signed = true): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${signed && value > 0 ? "+" : ""}${value.toFixed(digits).replace(".", ",")}%`;
}

export function formatFactor(value: number | null): string {
  if (value === null) return "—";
  if (value === Infinity) return "∞";
  return value.toFixed(2).replace(".", ",");
}

export function toneClass(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || Math.abs(value) < EPSILON) {
    return "text-foreground";
  }
  return value > 0 ? "text-success" : "text-destructive";
}
