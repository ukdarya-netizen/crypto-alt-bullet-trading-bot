import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/subscriber-api";

type Stats = { trades: number; wins: number; winRatePct: number | null; avgTradePct: number | null; depositPct: number };
type ExitId = "follow_cab" | "take5" | "take8" | "take10";
type Paper = {
  days: number | null; signalsFrom: string | null; signalsTo: string | null;
  openTrades: number; otherPatternsExcluded: number;
  exits: Record<ExitId, Stats>;
  byPattern: Record<string, Record<ExitId, Stats>>;
  selection?: Record<ExitId, Stats>;
};

const EXITS: { id: ExitId; name: string; short: string }[] = [
  { id: "follow_cab", name: "1. Полностью как CAB", short: "Как CAB" },
  { id: "take5", name: "2. Фиксация на +5%", short: "+5%" },
  { id: "take8", name: "3. Фиксация на +8%", short: "+8%" },
  { id: "take10", name: "4. Фиксация на +10%", short: "+10%" },
];
const PATTERNS: [string, string][] = [
  ["stealth_breakout", "Stealth Breakout"],
  ["neon_support_bounce", "ABNeon Support"],
  ["impulse_buy", "Impulse Buy"],
  ["liquidation_cascade", "Liquidation Cascade"],
];
const PERIODS: { id: string; label: string }[] = [
  { id: "7", label: "7 дней" }, { id: "30", label: "30 дней" }, { id: "90", label: "90 дней" },
  { id: "all", label: "Всё время" },
];

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2).replace(".", ",")}%`;
const tone = (v: number | null | undefined) =>
  v === null || v === undefined || v === 0 ? "text-foreground" : v > 0 ? "text-success" : "text-destructive";
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

/**
 * Background PAPER of every strategy on every CAB signal: % to the deposit
 * (10x, 1 % of the balance per trade, no compounding). `endpoint` is the
 * owner's or the subscriber's route; `patterns` adds the "by patterns" sum.
 */
export function StrategyPaperPanel({ endpoint, patterns = [], days }: {
  endpoint: string; patterns?: string[];
  /** Controlled by the page's own period switch (null = all time); omit for the built-in switch. */
  days?: number | null;
}) {
  const [own, setPeriod] = useState("30");
  const controlled = days !== undefined;
  const period = controlled ? (days === null ? "all" : String(days)) : own;
  const params = new URLSearchParams();
  if (period !== "all") params.set("days", period);
  if (patterns.length) params.set("patterns", patterns.join(","));
  const query = useQuery({
    queryKey: ["strategy-paper", endpoint, period, patterns.join(",")],
    queryFn: () => api<Paper>(`${endpoint}${params.toString() ? `?${params.toString()}` : ""}`),
    refetchInterval: 60_000,
  });
  const d = query.data;
  const closed = d ? d.exits.follow_cab.trades : 0;
  return (
    <div className="space-y-4" data-testid="strategy-paper">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-base font-bold">Сколько заработала бы каждая стратегия</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Результат в % к депозиту, если бы бот торговал все сигналы CAB этой стратегией.
          </p>
        </div>
        {!controlled && <div className="flex border border-border text-sm">
          {PERIODS.map((p) => (
            <button key={p.id} type="button" onClick={() => setPeriod(p.id)}
              className={`px-3 py-1.5 ${period === p.id ? "bg-primary/15 font-semibold text-primary" : "text-muted-foreground"}`}>
              {p.label}
            </button>
          ))}
        </div>}
      </div>

      {!d ? (
        <p className="text-sm text-muted-foreground">{query.error ? "Не удалось загрузить" : "Загрузка…"}</p>
      ) : (
        <>
          <p className="text-sm">
            {closed
              ? <>Сигналы с <b>{day(d.signalsFrom)}</b> по <b>{day(d.signalsTo)}</b> · закрыто сделок: <b>{closed}</b></>
              : "За этот период закрытых сделок нет"}
            {d.openTrades ? <> · ещё открыто: <b>{d.openTrades}</b></> : null}
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            {EXITS.map((e) => {
              const s = d.exits[e.id];
              return (
                <div key={e.id} className="border border-border bg-background/40 p-4">
                  <p className="text-sm font-semibold">{e.name}</p>
                  <p className={`mt-1 text-3xl font-bold tabular-nums ${tone(s.depositPct)}`}>{pct(s.depositPct)}</p>
                  <p className="text-xs text-muted-foreground">к депозиту</p>
                  <p className="mt-2 text-sm">
                    {s.trades} сделок · в плюс {s.winRatePct === null ? "—" : `${String(s.winRatePct).replace(".", ",")}%`}
                    {" · "}средняя сделка <span className={tone(s.avgTradePct)}>{pct(s.avgTradePct)}</span> цены
                  </p>
                </div>
              );
            })}
          </div>

          <div>
            <h4 className="text-sm font-bold">5. По паттернам — % к депозиту</h4>
            <p className="mt-1 text-sm text-muted-foreground">
              Стратегия 5 — сумма выбранных паттернов в нужном столбце.
            </p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Паттерн</th>
                    <th className="py-2 pr-3 font-medium">Сделок</th>
                    {EXITS.map((e) => <th key={e.id} className="py-2 pr-3 font-medium">{e.short}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {PATTERNS.map(([id, name]) => {
                    const row = d.byPattern[id];
                    return (
                      <tr key={id} className="border-b border-border/60">
                        <td className="py-2 pr-3 font-semibold">{name}</td>
                        <td className="py-2 pr-3">{row?.follow_cab.trades ?? 0}</td>
                        {EXITS.map((e) => {
                          const v = row?.[e.id].trades ? row[e.id].depositPct : null;
                          return <td key={e.id} className={`py-2 pr-3 font-semibold tabular-nums ${tone(v)}`}>{pct(v)}</td>;
                        })}
                      </tr>
                    );
                  })}
                  {d.selection && (
                    <tr className="bg-primary/5">
                      <td className="py-2 pr-3 font-bold">Мои паттерны</td>
                      <td className="py-2 pr-3">{d.selection.follow_cab.trades}</td>
                      {EXITS.map((e) => {
                        const v = d.selection![e.id].depositPct;
                        return <td key={e.id} className={`py-2 pr-3 font-bold tabular-nums ${tone(v)}`}>{pct(v)}</td>;
                      })}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <details className="text-sm">
            <summary className="cursor-pointer font-semibold">Как это считается</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
              <li>Берётся каждый закрытый сигнал CAB по 4 паттернам — как будто бот его открыл, даже если на самом деле не открыл.</li>
              <li>Размер сделки: 1% депозита маржи при плече 10x. Значит, +1% цены = +0,1% к депозиту. Сделки просто складываются, без сложного процента.</li>
              <li>«Как CAB» — вход и выход ровно по CAB.</li>
              <li>«+5 / +8 / +10%» — если цена после входа дошла до цели, сделка фиксируется на цели; если нет — закрывается там же, где её закрыл CAB.</li>
              <li>BTC при любой стратегии считается как CAB. Комиссия 0,1% на сделку.</li>
              <li>Impulse Buy считается по итоговому выходу CAB, без деления на 80/20.</li>
              {d.otherPatternsExcluded > 0 && <li>Старые паттерны не учитываются (сделок: {d.otherPatternsExcluded}).</li>}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
