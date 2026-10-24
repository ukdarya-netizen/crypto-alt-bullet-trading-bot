import { useMemo, useState, type ReactNode } from "react";
import { Link } from "wouter";
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
import { ArrowRight, Crown, Info } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PERIODS, closeReasonGroup, dailySeries, formatFactor, formatPercent, formatUsdt, groupBy, inPeriod,
  patternName, summarize, toneClass, type DailyPoint, type PeriodId, type ResultTrade, type Summary,
} from "@/lib/performance";
import { knownPatterns, strategyDefinitions, type StrategyId } from "./strategy-definitions";

const PERIOD_KEY = "cab-overview-period";

function readPeriod(): PeriodId {
  try {
    const value = window.localStorage.getItem(PERIOD_KEY);
    if (PERIODS.some((period) => period.id === value)) return value as PeriodId;
  } catch {}
  return "30d";
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

// ---------- building blocks ----------

function SectionTitle({ kicker, title, aside }: { kicker: string; title: string; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[.22em] text-primary">{kicker}</p>
        <h2 className="mt-1 text-lg font-bold">{title}</h2>
      </div>
      {aside}
    </div>
  );
}

function Kpi({ label, value, tone, hint, accent = false }: {
  label: string; value: ReactNode; tone?: string; hint?: ReactNode; accent?: boolean;
}) {
  return (
    <div className={`relative border bg-card p-4 ${accent ? "border-primary/40" : "border-border"}`}>
      {accent && <span className="absolute left-0 top-0 h-0.5 w-10 bg-primary" aria-hidden="true" />}
      <p className="text-[10px] font-bold uppercase tracking-[.14em] text-muted-foreground">{label}</p>
      <p className={`mt-2 text-2xl font-bold leading-none tabular ${tone ?? "text-foreground"}`}>{value}</p>
      {hint && <p className="mt-2 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function WinBar({ wins, losses }: { wins: number; losses: number }) {
  const total = wins + losses;
  if (!total) return <div className="h-1.5 w-full bg-muted" aria-hidden="true" />;
  return (
    <div className="flex h-1.5 w-full overflow-hidden bg-muted" aria-label={`${wins} в плюс, ${losses} в минус`}>
      <div className="bg-success" style={{ width: `${wins / total * 100}%` }} />
      <div className="bg-destructive" style={{ width: `${losses / total * 100}%` }} />
    </div>
  );
}

function ResultTile({ title, subtitle, summary, depositUsdt, badge, href, highlight = false }: {
  title: string; subtitle?: string; summary: Summary; depositUsdt?: number | null;
  badge?: ReactNode; href?: string; highlight?: boolean;
}) {
  const percentOfDeposit = depositUsdt && depositUsdt > 0 && summary.counted
    ? summary.netUsdt / depositUsdt * 100 : null;
  const body = (
    <div className={`flex h-full flex-col gap-3 border bg-card p-4 transition-colors ${
      highlight ? "border-success/50" : "border-border"} ${href ? "hover:border-primary/40" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold">{title}</p>
          {subtitle && <p className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</p>}
        </div>
        {badge}
      </div>
      <div>
        <p className={`text-2xl font-bold leading-none tabular ${toneClass(summary.counted ? summary.netUsdt : null)}`}>
          {summary.counted ? formatUsdt(summary.netUsdt) : "—"}
          <span className="ml-1 text-xs font-normal text-muted-foreground">USDT</span>
        </p>
        {percentOfDeposit !== null && (
          <p className={`mt-1 text-xs tabular ${toneClass(percentOfDeposit)}`}>{formatPercent(percentOfDeposit, 2)} от депозита</p>
        )}
      </div>
      <WinBar wins={summary.wins} losses={summary.losses} />
      <dl className="grid grid-cols-3 gap-2 text-[11px]">
        <div><dt className="text-muted-foreground">Сделок</dt><dd className="font-bold tabular">{summary.trades}</dd></div>
        <div><dt className="text-muted-foreground">Винрейт</dt><dd className="font-bold tabular">{formatPercent(summary.winRate, 0, false)}</dd></div>
        <div><dt className="text-muted-foreground">Ср. ROE</dt><dd className={`font-bold tabular ${toneClass(summary.avgRoePercent)}`}>{formatPercent(summary.avgRoePercent, 1)}</dd></div>
      </dl>
      {summary.unknown > 0 && (
        <p className="text-[11px] text-amber-300/90">{summary.unknown} без подтверждённого итога — не в сумме</p>
      )}
    </div>
  );
  return href ? <Link href={href} className="block h-full focus-visible:outline-2">{body}</Link> : body;
}

function PeriodSwitch({ value, onChange }: { value: PeriodId; onChange: (value: PeriodId) => void }) {
  return (
    <div role="radiogroup" aria-label="Период" className="grid grid-cols-4 border border-border bg-card p-1">
      {PERIODS.map((period) => (
        <button
          key={period.id}
          type="button"
          role="radio"
          aria-checked={value === period.id}
          onClick={() => onChange(period.id)}
          className={`min-h-9 px-3 text-xs font-bold transition-colors border ${
            value === period.id ? "border-primary/20 bg-primary/10 text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          {period.label}
        </button>
      ))}
    </div>
  );
}

function ProfitChart({ points, height = 260 }: { points: DailyPoint[]; height?: number }) {
  if (points.length === 0) {
    return <div className="grid place-items-center border border-dashed border-border text-sm text-muted-foreground" style={{ height }}>
      Нет закрытых сделок с подтверждённым итогом за период
    </div>;
  }
  return (
    <div style={{ height }} className="w-full" data-testid="profit-chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="day" tickFormatter={shortDay} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
            axisLine={{ stroke: "hsl(var(--border))" }} tickLine={false} minTickGap={18} />
          <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} axisLine={false} tickLine={false} width={52}
            tickFormatter={(value: number) => value.toFixed(Math.abs(value) < 10 ? 1 : 0)} />
          <ReferenceLine y={0} stroke="hsl(var(--muted-foreground) / .5)" />
          <Tooltip
            cursor={{ fill: "hsl(var(--primary) / .06)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const point = payload[0].payload as DailyPoint;
              return (
                <div className="border border-border bg-card px-3 py-2 text-xs shadow-lg">
                  <p className="font-bold">{shortDay(point.day)} · {point.trades} сделок</p>
                  <p className={toneClass(point.pnl)}>За день: {formatUsdt(point.pnl)} USDT</p>
                  <p className={toneClass(point.cumulative)}>Накопительно: {formatUsdt(point.cumulative)} USDT</p>
                </div>
              );
            }}
          />
          <Bar dataKey="pnl" name="За день" maxBarSize={18}>
            {points.map((point) => (
              <Cell key={point.day} fill={point.pnl >= 0 ? "hsl(var(--success) / .75)" : "hsl(var(--destructive) / .75)"} />
            ))}
          </Bar>
          <Line type="monotone" dataKey="cumulative" name="Накопительно" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-4 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 bg-primary" />Накопительная прибыль</span>
      <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 bg-success/75" />День в плюс</span>
      <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 bg-destructive/75" />День в минус</span>
    </div>
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

// ---------- page ----------

export default function JournalOverview() {
  const [period, setPeriodState] = useState<PeriodId>(readPeriod);
  const setPeriod = (value: PeriodId) => {
    setPeriodState(value);
    try { window.localStorage.setItem(PERIOD_KEY, value); } catch {}
  };
  const now = Date.now();

  const performance = useGetJournalVstPerformance({
    query: { queryKey: getGetJournalVstPerformanceQueryKey(), refetchInterval: 30_000 },
  });
  const positions = useGetJournalVstPositions({
    query: { queryKey: getGetJournalVstPositionsQueryKey(), refetchInterval: 15_000 },
  });
  const history = useGetJournalStrategyHistory({
    query: { queryKey: getGetJournalStrategyHistoryQueryKey(), refetchInterval: 60_000 },
  });

  const vstAll: ResultTrade[] = useMemo(() => (performance.data?.trades ?? []).map((trade) => ({
    id: trade.sourceSignalId, symbol: trade.symbol, patternId: trade.patternId, closedAt: trade.closedAt,
    pnlUsdt: trade.pnlUsdt, roePercent: trade.roePercent, closeReason: trade.closeReason,
  })), [performance.data]);
  const vst = inPeriod(vstAll, period, now);
  const vstSummary = summarize(vst);
  const vstSeries = dailySeries(vst);
  const vstByPattern = groupBy(vst, (trade) => trade.patternId ?? "none");
  const vstByReason = groupBy(vst, (trade) => closeReasonGroup(trade.closeReason).id);
  const patternIds = [
    ...knownPatterns.map((pattern) => pattern.id as string),
    ...[...vstByPattern.keys()].filter((id) => !knownPatterns.some((pattern) => pattern.id === id)),
  ];

  const open = positions.data?.positions ?? [];
  const unrealized = open.reduce((sum, position) =>
    sum + (position.unrealizedPnlUsdt !== null && Number.isFinite(Number(position.unrealizedPnlUsdt))
      ? Number(position.unrealizedPnlUsdt) : 0), 0);
  const equity = positions.data?.account?.equityUsdt ?? null;

  const deposit = history.data?.paperInitialDepositUsdt ? Number(history.data.paperInitialDepositUsdt) : null;
  const strategies = strategyDefinitions.map((strategy) => {
    const results = inPeriod(strategyResults(history.data?.trades ?? [], strategy.id), period, now);
    return { strategy, results, summary: summarize(results) };
  });
  const bestStrategy = strategies
    .filter((item) => item.summary.counted >= 3)
    .reduce<typeof strategies[number] | null>((best, item) =>
      !best || item.summary.netUsdt > best.summary.netUsdt ? item : best, null);
  const matrixMax = Math.max(1e-9, ...strategies.flatMap(({ results }) =>
    patternIds.map((id) => Math.abs(summarize(results.filter((trade) => (trade.patternId ?? "none") === id)).netUsdt))));
  const recent = [...vst].sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt)).slice(0, 8);

  return (
    <section className="page-frame mx-auto max-w-6xl space-y-10" aria-label="Обзор" data-testid="page-overview">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted-foreground">
          Итоги бота за выбранный период. Деньги — в USDT после комиссий; сделки без подтверждённого итога в сумму не входят.
        </p>
        <PeriodSwitch value={period} onChange={setPeriod} />
      </div>

      {/* ---------- VST ---------- */}
      <section className="space-y-5" aria-label="VST бот">
        <SectionTitle
          kicker="BingX VST · бот"
          title="Тейк +5% целиком · x10"
          aside={<Link href="/journal/vst" className="flex items-center gap-1 text-xs font-bold text-primary hover:underline">
            Позиции VST <ArrowRight className="h-3.5 w-3.5" /></Link>}
        />
        {performance.isLoading ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-24 rounded-none" />)}</div>
        ) : performance.error ? (
          <p className="border border-destructive/40 bg-destructive/10 p-4 text-sm">Не удалось загрузить статистику VST. Обновится автоматически.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="vst-kpis">
              <Kpi accent label="Прибыль за период" value={<>{formatUsdt(vstSummary.counted ? vstSummary.netUsdt : null)} <span className="text-xs font-normal text-muted-foreground">USDT</span></>}
                tone={toneClass(vstSummary.netUsdt)} hint={`${vstSummary.trades} закрытых сделок`} />
              <Kpi label="Винрейт" value={formatPercent(vstSummary.winRate, 0, false)}
                hint={<><span className="text-success">{vstSummary.wins} в плюс</span> · <span className="text-destructive">{vstSummary.losses} в минус</span></>} />
              <Kpi label="Средняя сделка" value={formatUsdt(vstSummary.avgUsdt)} tone={toneClass(vstSummary.avgUsdt)}
                hint={`ROE в среднем ${formatPercent(vstSummary.avgRoePercent)}`} />
              <Kpi label="Профит-фактор" value={formatFactor(vstSummary.profitFactor)}
                tone={vstSummary.profitFactor !== null && vstSummary.profitFactor >= 1 ? "text-success" : vstSummary.profitFactor !== null ? "text-destructive" : undefined}
                hint="прибыль ÷ убытки; выше 1 — в плюс" />
              <Kpi label="Открыто сейчас" value={positions.isLoading ? "…" : open.length}
                hint={<>нереализ.: <span className={toneClass(unrealized)}>{formatUsdt(unrealized)} USDT</span></>} />
              <Kpi label="Баланс VST" value={equity !== null ? Number(equity).toFixed(2).replace(".", ",") : "—"}
                hint="equity демо-счёта BingX" />
              <Kpi label="Лучшая сделка" value={formatUsdt(vstSummary.best?.pnlUsdt ?? null)} tone="text-success"
                hint={vstSummary.best ? `${vstSummary.best.symbol} · ${dateTime(vstSummary.best.closedAt)}` : "—"} />
              <Kpi label="Макс. просадка" value={vstSummary.maxDrawdownUsdt ? formatUsdt(-vstSummary.maxDrawdownUsdt) : "0"}
                tone={vstSummary.maxDrawdownUsdt ? "text-destructive" : undefined}
                hint={vstSummary.worst ? `худшая: ${vstSummary.worst.symbol} ${formatUsdt(vstSummary.worst.pnlUsdt)}` : "от пика накопленной прибыли"} />
            </div>

            <div className="border border-border bg-card p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-bold">Прибыль по дням</p>
                <Legend />
              </div>
              <ProfitChart points={vstSeries} />
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="vst-patterns">
              {patternIds.map((id) => (
                <ResultTile key={id} title={patternName(id === "none" ? null : id)} subtitle="паттерн AltBullet"
                  summary={summarize(vstByPattern.get(id) ?? [])} />
              ))}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="vst-reasons">
              {["take5", "stop", "source", "manual", "history", "other"]
                .filter((id) => vstByReason.has(id) || id === "take5" || id === "stop")
                .map((id) => {
                  const rows = vstByReason.get(id) ?? [];
                  const s = summarize(rows);
                  const label = rows[0] ? closeReasonGroup(rows[0].closeReason).label
                    : id === "take5" ? "Тейк +5%" : "Стоп-лосс";
                  return (
                    <div key={id} className="flex items-center justify-between gap-3 border border-border bg-card px-4 py-3">
                      <div>
                        <p className="text-xs font-bold">{label}</p>
                        <p className="text-[11px] text-muted-foreground">{s.trades} сделок · {vst.length ? Math.round(s.trades / vst.length * 100) : 0}%</p>
                      </div>
                      <p className={`text-base font-bold tabular ${toneClass(s.counted ? s.netUsdt : null)}`}>{s.counted ? formatUsdt(s.netUsdt) : "—"}</p>
                    </div>
                  );
                })}
            </div>

            <div className="border border-border bg-card">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <p className="text-sm font-bold">Последние закрытые</p>
                <Link href="/journal/vst" className="text-xs text-primary hover:underline">Все →</Link>
              </div>
              {recent.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted-foreground">За период закрытых сделок нет.</p>
              ) : (
                <ul>
                  {recent.map((trade) => (
                    <li key={trade.id} className="grid grid-cols-[1fr_auto] items-center gap-3 border-t border-border/70 px-4 py-2.5 first:border-t-0 sm:grid-cols-[150px_1fr_auto_auto]">
                      <span className="font-bold">{trade.symbol}</span>
                      <span className="hidden truncate text-xs text-muted-foreground sm:block">
                        {patternName(trade.patternId)} · {closeReasonGroup(trade.closeReason).label} · {dateTime(trade.closedAt)}
                      </span>
                      <span className={`hidden text-xs tabular sm:block ${toneClass(trade.roePercent)}`}>{formatPercent(trade.roePercent)}</span>
                      <span className={`text-right font-bold tabular ${toneClass(trade.pnlUsdt)}`}>{formatUsdt(trade.pnlUsdt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </section>

      {/* ---------- PAPER strategies ---------- */}
      <section className="space-y-5" aria-label="Стратегии PAPER">
        <SectionTitle
          kicker="PAPER · симуляция"
          title="Какая стратегия выхода прибыльнее"
          aside={<Link href="/journal/strategies" className="flex items-center gap-1 text-xs font-bold text-primary hover:underline">
            Подробно по стратегиям <ArrowRight className="h-3.5 w-3.5" /></Link>}
        />
        {history.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-48 rounded-none" />)}</div>
        ) : history.error ? (
          <p className="border border-destructive/40 bg-destructive/10 p-4 text-sm">Не удалось загрузить стратегии. Обновится автоматически.</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="strategy-tiles">
              {strategies.map(({ strategy, summary }) => (
                <ResultTile
                  key={strategy.id}
                  title={`${strategy.id}. ${strategy.name}`}
                  subtitle={strategy.actual ? "факт PAPER" : "сценарий на тех же входах"}
                  summary={summary}
                  depositUsdt={deposit}
                  href="/journal/strategies"
                  highlight={bestStrategy?.strategy.id === strategy.id}
                  badge={bestStrategy?.strategy.id === strategy.id
                    ? <span className="flex shrink-0 items-center gap-1 border border-success/40 bg-success/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-success"><Crown className="h-3 w-3" />лучшая</span>
                    : null}
                />
              ))}
            </div>

            <div className="overflow-x-auto border border-border bg-card" data-testid="strategy-matrix">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr>
                    <th className="px-4 py-3 text-left text-[10px] uppercase">Паттерн \ Стратегия</th>
                    {strategies.map(({ strategy }) => (
                      <th key={strategy.id} className="px-3 py-3 text-right text-[10px] uppercase">{strategy.id}. {strategy.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {patternIds.map((id) => {
                    const cells = strategies.map(({ strategy, results }) => ({
                      id: strategy.id,
                      summary: summarize(results.filter((trade) => (trade.patternId ?? "none") === id)),
                    }));
                    const top = cells.filter((cell) => cell.summary.counted)
                      .reduce<typeof cells[number] | null>((best, cell) => !best || cell.summary.netUsdt > best.summary.netUsdt ? cell : best, null);
                    return (
                      <tr key={id} className="border-t border-border">
                        <td className="px-4 py-3 font-bold">{patternName(id === "none" ? null : id)}</td>
                        {cells.map((cell) => {
                          const value = cell.summary.counted ? cell.summary.netUsdt : null;
                          const strength = value === null ? 0 : Math.min(1, Math.abs(value) / matrixMax);
                          const color = value === null ? "transparent" : value >= 0
                            ? `hsl(var(--success) / ${0.08 + strength * 0.32})` : `hsl(var(--destructive) / ${0.08 + strength * 0.32})`;
                          return (
                            <td key={cell.id} className="px-3 py-3 text-right" style={{ background: color }}>
                              <span className={`block font-bold tabular ${toneClass(value)}`}>
                                {value === null ? "—" : formatUsdt(value)}
                                {top?.id === cell.id && cells.filter((c) => c.summary.counted).length > 1 && <Crown className="ml-1 inline h-3 w-3 text-success" aria-label="лучшая для паттерна" />}
                              </span>
                              <span className="block text-[10px] text-muted-foreground tabular">
                                {cell.summary.trades} сд. · {formatPercent(cell.summary.winRate, 0, false)}
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Стратегия 4 — фактические PAPER-сделки бота. Стратегии 1–3 — расчёт по тем же входам с их правилами выхода (по наблюдаемым котировкам, комиссии учтены, funding нет).
              Корона — лучшая стратегия для паттерна; «лучшая» среди стратегий — с наибольшей прибылью при ≥3 сделках.
            </p>
          </>
        )}
      </section>
    </section>
  );
}
