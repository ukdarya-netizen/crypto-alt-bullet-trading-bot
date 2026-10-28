import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { StrategyPaperPanel } from "@/components/strategy-paper-panel";
import { api } from "@/lib/subscriber-api";
import {
  Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  getGetJournalStrategyHistoryQueryKey,
  getJournalStrategyHistory,
  getGetJournalVstPerformanceQueryKey,
  getGetJournalVstPositionsQueryKey,
  useGetJournalStrategyHistory,
  useGetJournalVstPerformance,
  useGetJournalVstPositions,
} from "@workspace/api-client-react";
import { ChevronDown, Crown } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PERIODS, closeReasonGroup, dailySeries, formatFactor, formatPercent, formatUsdt, groupBy, inPeriod,
  patternName, summarize, toneClass, type DailyPoint, type PeriodId, type ResultTrade, type Summary,
} from "@/lib/performance";
import { knownPatterns, strategyDefinitions, type StrategyId } from "./strategy-definitions";

// ---------------------------------------------------------------------------
// One page, one question per block:
//   1. How much did I make (USDT and % of deposit)?   -> hero
//   2. How did it go over time?                        -> one chart
//   3. What worked and what did not?                   -> one ranked table
// Everything else is folded under "Подробнее".
// ---------------------------------------------------------------------------

type View = "vst" | "paper";
const PERIOD_KEY = "cab-overview-period";
const VIEW_KEY = "cab-overview-view";

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    if (value && (allowed as readonly string[]).includes(value)) return value as T;
  } catch {}
  return fallback;
}
function store(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch {}
}

function dateTime(iso: string | null) {
  if (!iso) return "—";
  const at = new Date(iso);
  return Number.isFinite(at.getTime())
    ? at.toLocaleString("ru-RU", { timeZone: "Europe/Samara", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "—";
}
function shortDay(day: string) {
  const [, month, date] = day.split("-");
  return `${date}.${month}`;
}
const money = (value: number | null | undefined) => (value == null || !Number.isFinite(value) ? "—" : formatUsdt(value));

// ---------- building blocks ----------

function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: ReadonlyArray<{ id: T; label: string }>; onChange: (value: T) => void; label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex border border-border bg-card p-1">
      {options.map((option) => (
        <button key={option.id} type="button" role="radio" aria-checked={value === option.id}
          onClick={() => onChange(option.id)}
          className={`min-h-10 flex-1 whitespace-nowrap px-3 text-xs font-bold transition-colors border ${
            value === option.id ? "border-primary/20 bg-primary/10 text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
          }`}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** The one number that answers "how much did I make". */
function Hero({ title, netUsdt, percent, percentLabel, counted, note }: {
  title: string; netUsdt: number | null; percent: number | null; percentLabel: string; counted: number; note?: ReactNode;
}) {
  const tone = toneClass(counted ? netUsdt : null);
  return (
    <div className="relative border border-border bg-card p-5 sm:p-6" data-testid="overview-hero">
      <span className="absolute left-0 top-0 h-0.5 w-16 bg-primary" aria-hidden="true" />
      <p className="text-xs font-bold uppercase tracking-[.16em] text-muted-foreground">{title}</p>
      <div className="mt-3 flex flex-wrap items-end gap-x-6 gap-y-2">
        <p className={`text-4xl font-bold leading-none tabular sm:text-5xl ${tone}`} data-testid="hero-percent">
          {counted ? formatPercent(percent, 2) : "—"}
        </p>
        <p className={`pb-1 text-xl font-bold tabular ${tone}`}>
          {counted ? money(netUsdt) : "—"} <span className="text-sm font-normal text-muted-foreground">USDT</span>
        </p>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{percentLabel}</p>
      {note && <p className="mt-1 text-xs text-amber-300/90">{note}</p>}
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: string }) {
  return (
    <div className="border border-border bg-card p-4">
      <p className="text-[11px] font-bold uppercase tracking-[.12em] text-muted-foreground">{label}</p>
      <p className={`mt-2 text-2xl font-bold leading-none tabular ${tone ?? "text-foreground"}`}>{value}</p>
      {hint && <p className="mt-2 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function WinRate({ summary }: { summary: Summary }) {
  return (
    <Stat label="Винрейт" value={formatPercent(summary.winRate, 0, false)}
      hint={<><span className="text-success">{summary.wins} в плюс</span> · <span className="text-destructive">{summary.losses} в минус</span></>} />
  );
}

function ProfitChart({ points }: { points: DailyPoint[] }) {
  if (points.length === 0) {
    return <div className="grid h-56 place-items-center border border-dashed border-border text-sm text-muted-foreground">
      За период нет закрытых сделок
    </div>;
  }
  return (
    <div className="h-64 w-full" data-testid="profit-chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="day" tickFormatter={shortDay} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
            axisLine={{ stroke: "hsl(var(--border))" }} tickLine={false} minTickGap={18} />
          <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} axisLine={false} tickLine={false} width={52}
            tickFormatter={(value: number) => value.toFixed(Math.abs(value) < 10 ? 1 : 0)} />
          <ReferenceLine y={0} stroke="hsl(var(--muted-foreground) / .5)" />
          <Tooltip cursor={{ fill: "hsl(var(--primary) / .06)" }} content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const point = payload[0].payload as DailyPoint;
            return (
              <div className="border border-border bg-card px-3 py-2 text-xs shadow-lg">
                <p className="font-bold">{shortDay(point.day)} · {point.trades} сделок</p>
                <p className={toneClass(point.pnl)}>За день: {formatUsdt(point.pnl)} USDT</p>
                <p className={toneClass(point.cumulative)}>Всего: {formatUsdt(point.cumulative)} USDT</p>
              </div>
            );
          }} />
          <Bar dataKey="pnl" maxBarSize={18}>
            {points.map((point) => (
              <Cell key={point.day} fill={point.pnl >= 0 ? "hsl(var(--success) / .75)" : "hsl(var(--destructive) / .75)"} />
            ))}
          </Bar>
          <Line type="monotone" dataKey="cumulative" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function ChartCard({ points }: { points: DailyPoint[] }) {
  return (
    <section className="border border-border bg-card p-4" aria-label="Прибыль по дням">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold">Прибыль по дням</h2>
        <div className="flex flex-wrap gap-4 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 bg-primary" />всего с начала периода</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 bg-success/75" />день в плюс</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 bg-destructive/75" />день в минус</span>
        </div>
      </div>
      <ProfitChart points={points} />
    </section>
  );
}

type Row = { id: string; name: ReactNode; summary: Summary; badge?: ReactNode };

/** Ranked table: the best row first, a profit bar in every row. */
function RankedTable({ title, rows, depositUsdt, emptyText, firstColumn }: {
  title: string; rows: Row[]; depositUsdt: number | null; emptyText: string; firstColumn: string;
}) {
  const ranked = [...rows].sort((a, b) =>
    (b.summary.counted ? b.summary.netUsdt : -Infinity) - (a.summary.counted ? a.summary.netUsdt : -Infinity));
  const max = Math.max(1e-9, ...ranked.map((row) => Math.abs(row.summary.netUsdt)));
  return (
    <section className="border border-border bg-card" aria-label={title}>
      <h2 className="border-b border-border px-4 py-3 text-sm font-bold">{title}</h2>
      {ranked.every((row) => row.summary.trades === 0) ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <>
        {/* Phone: one card per row, the same numbers without horizontal scroll. */}
        <ul className="sm:hidden">
          {ranked.map((row) => {
            const s = row.summary;
            const value = s.counted ? s.netUsdt : null;
            const pct = value !== null && depositUsdt && depositUsdt > 0 ? value / depositUsdt * 100 : null;
            return (
              <li key={row.id} className="border-t border-border px-4 py-3 first:border-t-0">
                <div className="flex items-start justify-between gap-3">
                  <span className="flex flex-wrap items-center gap-2 font-bold">{row.name}{row.badge}</span>
                  <span className={`shrink-0 font-bold tabular ${toneClass(value)}`}>{money(value)}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground tabular">
                  <span className={toneClass(pct)}>{formatPercent(pct, 2)} к депозиту</span> · винрейт {formatPercent(s.winRate, 0, false)} · {s.trades} сделок
                </p>
              </li>
            );
          })}
        </ul>
        <div className="hidden overflow-x-auto sm:block">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="text-[10px] uppercase">
                <th className="px-4 py-2 text-left">{firstColumn}</th>
                <th className="px-3 py-2 text-left">Прибыль</th>
                <th className="px-3 py-2 text-right">% к депозиту</th>
                <th className="px-3 py-2 text-right">Винрейт</th>
                <th className="px-4 py-2 text-right">Сделок</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((row) => {
                const s = row.summary;
                const value = s.counted ? s.netUsdt : null;
                const pct = value !== null && depositUsdt && depositUsdt > 0 ? value / depositUsdt * 100 : null;
                const width = value === null ? 0 : Math.max(2, Math.abs(value) / max * 100);
                return (
                  <tr key={row.id} className="border-t border-border">
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2 font-bold">{row.name}{row.badge}</span>
                    </td>
                    <td className="w-[38%] px-3 py-3">
                      <div className="flex items-center gap-3">
                        <span className={`w-20 shrink-0 font-bold tabular ${toneClass(value)}`}>{money(value)}</span>
                        <span className="h-2 flex-1 bg-muted">
                          <span className={`block h-2 ${value !== null && value < 0 ? "bg-destructive/80" : "bg-success/80"}`}
                            style={{ width: `${width}%` }} />
                        </span>
                      </div>
                    </td>
                    <td className={`px-3 py-3 text-right tabular ${toneClass(pct)}`}>{formatPercent(pct, 2)}</td>
                    <td className="px-3 py-3 text-right tabular">{formatPercent(s.winRate, 0, false)}</td>
                    <td className="px-4 py-3 text-right tabular text-muted-foreground">{s.trades}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
      )}
    </section>
  );
}

function More({ children }: { children: ReactNode }) {
  return (
    <details className="group border border-border bg-card">
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-bold">
        Подробнее
        <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-4 border-t border-border p-4">{children}</div>
    </details>
  );
}

// ---------- PAPER strategies ----------

type StrategyTrade = Awaited<ReturnType<typeof getJournalStrategyHistory>>["trades"][number];

function strategyResults(trades: StrategyTrade[], id: StrategyId): ResultTrade[] {
  const paper = trades.filter((trade) => trade.environment === "paper");
  if (id === 4) {
    return paper.filter((trade) => trade.executedStrategyId === 4 && trade.status === "closed")
      .map((trade) => ({
        id: trade.id, symbol: trade.symbol, patternId: trade.patternId,
        closedAt: trade.closedAt ?? trade.entryAt ?? "",
        pnlUsdt: trade.accountingStatus === "verified" && trade.profitUsdt !== null ? Number(trade.profitUsdt) : null,
        roePercent: trade.tradeProfitPercent !== null ? Number(trade.tradeProfitPercent) : null,
      }));
  }
  return paper.flatMap((trade) => {
    const scenario = trade.scenarios.find((item) => item.strategyId === id);
    if (!scenario || (scenario.status !== "closed" && scenario.status !== "incomplete")) return [];
    const pnl = scenario.status === "closed" && scenario.profitUsdt !== null ? Number(scenario.profitUsdt) : null;
    const share = scenario.allocatedPercent !== null ? Number(scenario.allocatedPercent) : null;
    const ofDeposit = scenario.profitPercent !== null ? Number(scenario.profitPercent) : null;
    return [{
      id: `${trade.id}:${id}`, symbol: trade.symbol, patternId: trade.patternId,
      closedAt: scenario.closedAt ?? trade.closedAt ?? trade.entryAt ?? "",
      pnlUsdt: pnl,
      roePercent: pnl !== null && share && ofDeposit !== null ? ofDeposit / share * 100 : null,
    }];
  });
}

// ---------- views ----------

function VstView({ period }: { period: PeriodId }) {
  const now = Date.now();
  const performance = useGetJournalVstPerformance({
    query: { queryKey: getGetJournalVstPerformanceQueryKey(), refetchInterval: 30_000 },
  });
  const positions = useGetJournalVstPositions({
    query: { queryKey: getGetJournalVstPositionsQueryKey(), refetchInterval: 15_000 },
  });
  const all: ResultTrade[] = useMemo(() => (performance.data?.trades ?? []).map((trade) => ({
    id: trade.sourceSignalId, symbol: trade.symbol, patternId: trade.patternId, closedAt: trade.closedAt,
    pnlUsdt: trade.pnlUsdt, roePercent: trade.roePercent, closeReason: trade.closeReason,
  })), [performance.data]);

  if (performance.isLoading) return <Skeleton className="h-96 w-full rounded-none" />;
  if (performance.error) {
    return <p className="border border-destructive/40 bg-destructive/10 p-4 text-sm">Не удалось загрузить статистику. Обновится автоматически.</p>;
  }

  const trades = inPeriod(all, period, now);
  const summary = summarize(trades);
  const wallet = positions.data?.account?.walletBalanceUsdt != null ? Number(positions.data.account.walletBalanceUsdt) : null;
  // Deposit at the start of the period = today's wallet minus what the
  // period's closed trades added (open positions are not in the wallet yet).
  const startDeposit = wallet !== null && Number.isFinite(wallet) ? wallet - (summary.counted ? summary.netUsdt : 0) : null;
  const percent = startDeposit && startDeposit > 0 && summary.counted ? summary.netUsdt / startDeposit * 100 : null;
  const open = positions.data?.positions ?? [];
  const unrealized = open.reduce((sum, position) =>
    sum + (position.unrealizedPnlUsdt !== null && Number.isFinite(Number(position.unrealizedPnlUsdt))
      ? Number(position.unrealizedPnlUsdt) : 0), 0);
  const byPattern = groupBy(trades, (trade) => trade.patternId ?? "none");
  const patternIds = [...new Set([...knownPatterns.map((pattern) => pattern.id as string), ...byPattern.keys()])];
  const byReason = groupBy(trades, (trade) => closeReasonGroup(trade.closeReason).id);
  const recent = [...trades].sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt)).slice(0, 10);

  return (
    <div className="space-y-5">
      <OwnerStrategyLine />
      <Hero
        title="Бот на BingX VST · прибыль за период"
        netUsdt={summary.netUsdt}
        percent={percent}
        counted={summary.counted}
        percentLabel={startDeposit !== null
          ? `к депозиту на начало периода: ${startDeposit.toFixed(2).replace(".", ",")} USDT`
          : "баланс демо-счёта пока недоступен — процент появится после чтения биржи"}
        note={summary.unknown > 0 ? `${summary.unknown} сделок без подтверждённого итога не учтены` : undefined}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <WinRate summary={summary} />
        <Stat label="Закрыто сделок" value={summary.trades} hint={`средняя: ${money(summary.avgUsdt)} USDT`} />
        <Stat label="Открыто сейчас" value={positions.isLoading ? "…" : open.length}
          hint={<>сейчас: <span className={toneClass(unrealized)}>{money(unrealized)} USDT</span></>} />
        <Stat label="Баланс счёта" value={wallet !== null ? wallet.toFixed(2).replace(".", ",") : "—"} hint="USDT, демо-счёт VST" />
      </div>

      <ChartCard points={dailySeries(trades)} />

      <RankedTable
        title="Какие паттерны принесли прибыль"
        firstColumn="Паттерн"
        depositUsdt={startDeposit}
        emptyText="За период закрытых сделок нет"
        rows={patternIds.map((id) => ({ id, name: patternName(id === "none" ? null : id), summary: summarize(byPattern.get(id) ?? []) }))}
      />

      <More>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Профит-фактор" value={formatFactor(summary.profitFactor)} hint="прибыль ÷ убытки, выше 1 — хорошо" />
          <Stat label="Средний ROE" value={formatPercent(summary.avgRoePercent)} tone={toneClass(summary.avgRoePercent)} hint="на маржу сделки, x10" />
          <Stat label="Лучшая сделка" value={money(summary.best?.pnlUsdt)} tone="text-success" hint={summary.best?.symbol ?? "—"} />
          <Stat label="Макс. просадка" value={summary.maxDrawdownUsdt ? money(-summary.maxDrawdownUsdt) : "0"}
            tone={summary.maxDrawdownUsdt ? "text-destructive" : undefined} hint="от пика накопленной прибыли" />
        </div>
        <div>
          <p className="mb-2 text-xs font-bold uppercase tracking-[.12em] text-muted-foreground">Чем закрывались сделки</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {[...byReason.entries()].sort((a, b) => b[1].length - a[1].length).map(([id, rows]) => {
              const s = summarize(rows);
              return (
                <div key={id} className="flex items-center justify-between border border-border px-3 py-2 text-sm">
                  <span>{closeReasonGroup(rows[0]!.closeReason).label} <span className="text-muted-foreground">· {s.trades}</span></span>
                  <span className={`font-bold tabular ${toneClass(s.counted ? s.netUsdt : null)}`}>{s.counted ? money(s.netUsdt) : "—"}</span>
                </div>
              );
            })}
          </div>
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-bold uppercase tracking-[.12em] text-muted-foreground">Последние сделки</p>
            <Link href="/journal/vst" className="text-xs text-primary hover:underline">Все позиции →</Link>
          </div>
          {recent.length === 0 ? <p className="text-sm text-muted-foreground">Нет</p> : (
            <ul className="border border-border">
              {recent.map((trade) => (
                <li key={trade.id} className="grid grid-cols-[1fr_auto] gap-3 border-t border-border/70 px-3 py-2 text-sm first:border-t-0">
                  <span className="min-w-0 truncate">
                    <b>{trade.symbol}</b> <span className="text-muted-foreground">· {closeReasonGroup(trade.closeReason).label} · {dateTime(trade.closedAt)}</span>
                  </span>
                  <span className={`font-bold tabular ${toneClass(trade.pnlUsdt)}`}>{money(trade.pnlUsdt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </More>
    </div>
  );
}

function LegacyPaperView({ period }: { period: PeriodId }) {
  const now = Date.now();
  const history = useGetJournalStrategyHistory({
    query: { queryKey: getGetJournalStrategyHistoryQueryKey(), refetchInterval: 60_000 },
  });
  if (history.isLoading) return <Skeleton className="h-96 w-full rounded-none" />;
  if (history.error) {
    return <p className="border border-destructive/40 bg-destructive/10 p-4 text-sm">Не удалось загрузить стратегии. Обновится автоматически.</p>;
  }
  const deposit = history.data?.paperInitialDepositUsdt ? Number(history.data.paperInitialDepositUsdt) : null;
  const strategies = strategyDefinitions.map((strategy) => {
    const results = inPeriod(strategyResults(history.data?.trades ?? [], strategy.id), period, now);
    return { strategy, results, summary: summarize(results) };
  });
  const best = strategies.filter((item) => item.summary.counted >= 3)
    .reduce<typeof strategies[number] | null>((top, item) => !top || item.summary.netUsdt > top.summary.netUsdt ? item : top, null);
  const actual = strategies.find((item) => item.strategy.actual)!;
  const patternIds = knownPatterns.map((pattern) => pattern.id as string);

  return (
    <div className="space-y-5">
      <Hero
        title={`PAPER · стратегия бота «${actual.strategy.name}» · прибыль за период`}
        netUsdt={actual.summary.netUsdt}
        percent={deposit && actual.summary.counted ? actual.summary.netUsdt / deposit * 100 : null}
        counted={actual.summary.counted}
        percentLabel={deposit ? `к депозиту PAPER ${deposit.toFixed(0)} USDT` : "депозит PAPER не задан"}
        note={best && best.strategy.id !== actual.strategy.id
          ? `Лучше за этот период было бы: «${best.strategy.name}» (${formatUsdt(best.summary.netUsdt)} USDT)` : undefined}
      />
      <ChartCard points={dailySeries(actual.results)} />
      <RankedTable
        title="Сравнение 4 стратегий выхода на одних и тех же входах"
        firstColumn="Стратегия"
        depositUsdt={deposit}
        emptyText="За период закрытых сделок нет"
        rows={strategies.map(({ strategy, summary }) => ({
          id: String(strategy.id),
          name: <>{strategy.id}. {strategy.name}{strategy.actual && <span className="text-[10px] font-normal text-muted-foreground">(бот)</span>}</>,
          summary,
          badge: best?.strategy.id === strategy.id
            ? <span className="flex items-center gap-1 border border-success/40 bg-success/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-success"><Crown className="h-3 w-3" />лучшая</span>
            : undefined,
        }))}
      />
      <More>
        <p className="text-xs text-muted-foreground">
          Прибыль в USDT по паттерну и стратегии. Зелёный — плюс, красный — минус. Стратегия 4 — реальные PAPER-сделки бота, 1–3 — расчёт тех же входов с другими правилами выхода.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm" data-testid="strategy-matrix">
            <thead>
              <tr className="text-[10px] uppercase">
                <th className="px-3 py-2 text-left">Паттерн</th>
                {strategies.map(({ strategy }) => <th key={strategy.id} className="px-3 py-2 text-right">{strategy.id}. {strategy.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {patternIds.map((id) => (
                <tr key={id} className="border-t border-border">
                  <td className="px-3 py-2 font-bold">{patternName(id)}</td>
                  {strategies.map(({ strategy, results }) => {
                    const s = summarize(results.filter((trade) => trade.patternId === id));
                    const value = s.counted ? s.netUsdt : null;
                    return (
                      <td key={strategy.id} className={`px-3 py-2 text-right font-bold tabular ${toneClass(value)}`}>
                        {money(value)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Link href="/journal/strategies" className="inline-block text-xs text-primary hover:underline">Правила стратегий и все сделки →</Link>
      </More>
    </div>
  );
}

/** The owner's current bot strategy, with a link to change it. */
function OwnerStrategyLine() {
  const query = useQuery({
    queryKey: ["owner-trading-strategy"],
    queryFn: () => api<{ strategyText: string }>("/journal/trading-strategy"),
  });
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border border-border bg-card px-4 py-3 text-sm" data-testid="owner-strategy-line">
      <span>Стратегия бота: <span className="font-semibold">{query.data?.strategyText ?? (query.error ? "не загрузилась" : "…")}</span></span>
      <Link href="/journal/strategies" className="text-xs text-primary hover:underline">Сменить стратегию →</Link>
    </div>
  );
}

/** Owner 2026-10-28: background PAPER of the 5 bot strategies (% to deposit). */
function PaperView({ period }: { period: PeriodId }) {
  const [archive, setArchive] = useState(false);
  return (
    <div className="space-y-5">
      <div className="border border-border bg-card p-4">
        <StrategyPaperPanel endpoint="/journal/strategy-paper" />
        <Link href="/journal/strategies" className="mt-3 inline-block text-xs text-primary hover:underline">Выбрать стратегию бота →</Link>
      </div>
      <button type="button" onClick={() => setArchive((v) => !v)}
        className="text-xs font-semibold text-muted-foreground underline">
        {archive ? "Скрыть архив" : "Архив: старые 4 схемы PAPER (до 28.10.2026)"}
      </button>
      {archive && <LegacyPaperView period={period} />}
    </div>
  );
}

export default function JournalOverview() {
  const [period, setPeriod] = useState<PeriodId>(() => readStored(PERIOD_KEY, PERIODS.map((p) => p.id), "30d"));
  const [view, setView] = useState<View>(() => readStored<View>(VIEW_KEY, ["vst", "paper"], "vst"));
  return (
    <section className="page-frame mx-auto max-w-5xl space-y-5" aria-label="Обзор" data-testid="page-overview">
      <div className="grid gap-2 sm:grid-cols-[auto_1fr] sm:items-center">
        <Segmented label="Счёт" value={view} onChange={(value) => { setView(value); store(VIEW_KEY, value); }}
          options={[{ id: "vst", label: "VST · бот" }, { id: "paper", label: "Стратегии · paper" }]} />
        <div className="sm:justify-self-end sm:w-[420px]">
          <Segmented label="Период" value={period} onChange={(value) => { setPeriod(value); store(PERIOD_KEY, value); }}
            options={PERIODS} />
        </div>
      </div>
      {view === "vst" ? <VstView period={period} /> : <PaperView period={period} />}
    </section>
  );
}
