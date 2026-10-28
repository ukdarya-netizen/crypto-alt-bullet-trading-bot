import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/subscriber-api";

type Stats = { trades: number; wins: number; winRatePct: number | null; avgTradePct: number | null; depositPct: number };
type ExitId = "follow_cab" | "take5" | "take8" | "take10";
type Paper = {
  since: string | null; openTrades: number;
  exits: Record<ExitId, Stats>;
  byPattern: Record<string, Record<ExitId, Stats>>;
  selection?: Record<ExitId, Stats>;
};

const EXITS: { id: ExitId; label: string }[] = [
  { id: "follow_cab", label: "1. Как CAB" },
  { id: "take5", label: "2. +5%" },
  { id: "take8", label: "3. +8%" },
  { id: "take10", label: "4. +10%" },
];
const PATTERNS: Record<string, string> = {
  stealth_breakout: "Stealth Breakout",
  neon_support_bounce: "ABNeon Support",
  impulse_buy: "Impulse Buy",
  liquidation_cascade: "Liquidation Cascade",
};

const pct = (v: number | null | undefined, sign = true) =>
  v === null || v === undefined ? "—" : `${sign && v > 0 ? "+" : ""}${v.toFixed(2)}%`;
const tone = (v: number | null | undefined) =>
  v === null || v === undefined || v === 0 ? "" : v > 0 ? "text-success" : "text-destructive";

/**
 * Background PAPER of every strategy on every CAB signal: % to the deposit
 * (10x, 1 % of the balance per trade, no compounding). `endpoint` is the
 * owner's or the subscriber's route; `patterns` adds the "by patterns" sum.
 */
export function StrategyPaperPanel({ endpoint, patterns = [] }: { endpoint: string; patterns?: string[] }) {
  const query = useQuery({
    queryKey: ["strategy-paper", endpoint, patterns.join(",")],
    queryFn: () => api<Paper>(`${endpoint}${patterns.length ? `?patterns=${patterns.join(",")}` : ""}`),
    refetchInterval: 60_000,
  });
  if (!query.data) {
    return <p className="text-xs text-muted-foreground">{query.error ? "Paper-статистику загрузить не удалось" : "Загрузка paper-статистики…"}</p>;
  }
  const d = query.data;
  const patternIds = Object.keys(d.byPattern).filter((p) => PATTERNS[p]);
  return (
    <div className="space-y-3" data-testid="strategy-paper">
      <div>
        <p className="text-sm font-semibold">Paper по стратегиям — % к депозиту</p>
        <p className="text-xs text-muted-foreground">
          Каждый сигнал CAB в фоне «торгуется» всеми выходами, независимо от того, открыл ли его бот.
          Сделка — 1% баланса маржи при 10x, без сложного процента, комиссия 0,1%.
          {d.since ? ` С ${new Date(d.since).toLocaleDateString("ru-RU")}.` : " Данные начнут копиться после деплоя."}
          {d.openTrades ? ` Открыто сейчас: ${d.openTrades}.` : ""}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-xs">
          <thead><tr className="text-left text-muted-foreground">
            <th className="py-1 pr-2 font-medium">Стратегия</th>
            <th className="py-1 pr-2 font-medium">Сделок</th>
            <th className="py-1 pr-2 font-medium">В плюс</th>
            <th className="py-1 pr-2 font-medium">Средняя сделка</th>
            <th className="py-1 font-medium">К депозиту</th>
          </tr></thead>
          <tbody>
            {EXITS.map((e) => {
              const s = d.exits[e.id];
              return <tr key={e.id} className="border-t border-border">
                <td className="py-1.5 pr-2 font-semibold">{e.label}</td>
                <td className="py-1.5 pr-2">{s.trades}</td>
                <td className="py-1.5 pr-2">{s.winRatePct === null ? "—" : `${s.winRatePct}%`}</td>
                <td className={`py-1.5 pr-2 ${tone(s.avgTradePct)}`}>{pct(s.avgTradePct)}</td>
                <td className={`py-1.5 font-bold ${tone(s.depositPct)}`}>{pct(s.depositPct)}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
      {patternIds.length > 0 && (
        <div className="overflow-x-auto">
          <p className="mb-1 text-xs font-semibold">5. По паттернам — % к депозиту по каждому паттерну и выходу</p>
          <table className="w-full min-w-[480px] text-xs">
            <thead><tr className="text-left text-muted-foreground">
              <th className="py-1 pr-2 font-medium">Паттерн</th>
              {EXITS.map((e) => <th key={e.id} className="py-1 pr-2 font-medium">{e.label.replace(/^\d\. /, "")}</th>)}
            </tr></thead>
            <tbody>
              {patternIds.map((p) => (
                <tr key={p} className="border-t border-border">
                  <td className="py-1.5 pr-2 font-semibold">{PATTERNS[p]} <span className="text-muted-foreground">({d.byPattern[p].follow_cab.trades})</span></td>
                  {EXITS.map((e) => {
                    const v = d.byPattern[p][e.id].depositPct;
                    return <td key={e.id} className={`py-1.5 pr-2 ${tone(v)}`}>{pct(v)}</td>;
                  })}
                </tr>
              ))}
              {d.selection && (
                <tr className="border-t-2 border-primary/50">
                  <td className="py-1.5 pr-2 font-bold">Выбранные паттерны</td>
                  {EXITS.map((e) => {
                    const v = d.selection![e.id].depositPct;
                    return <td key={e.id} className={`py-1.5 pr-2 font-bold ${tone(v)}`}>{pct(v)}</td>;
                  })}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
