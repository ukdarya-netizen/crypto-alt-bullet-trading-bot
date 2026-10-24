import { useState } from "react";
import { Link } from "wouter";
import {
  getGetJournalStrategyHistoryQueryKey,
  getJournalStrategyHistory,
  useGetJournalStrategyHistory,
} from "@workspace/api-client-react";
import { ErrorState } from "@/components/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@/lib/utils";
import {
  exitRule, knownPatterns, ruleLabel, strategyDefinitions, type StrategyId,
} from "./strategy-definitions";
import { returnFor } from "./strategy-returns";

type Trade = Awaited<ReturnType<typeof getJournalStrategyHistory>>["trades"][number];
type History = Awaited<ReturnType<typeof getJournalStrategyHistory>>;

const samaraMonth = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Samara",
  year: "numeric",
  month: "2-digit",
});

function monthOf(trade: Trade): string {
  const timestamp = trade.status === "closed" ? trade.closedAt : trade.entryAt;
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return "unknown";
  const parts = samaraMonth.formatToParts(new Date(timestamp));
  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}`;
}

function monthLabel(month: string) {
  if (month === "unknown") return "Дата не подтверждена";
  return new Date(`${month}-01T00:00:00.000Z`).toLocaleDateString("ru-RU", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function signed(value: number) {
  return `${value > 0 ? "+" : ""}${formatNumber(value, 2)}`;
}

function percentLabel(value: number | null | undefined) {
  return value == null ? "—" : `${signed(value)}%`;
}

type Scenario = Trade["scenarios"][number];
function scenarioFor(trade: Trade, id: StrategyId): Scenario | undefined {
  return trade.environment === "paper" ? trade.scenarios.find((item) => item.strategyId === id) : undefined;
}

function scenarioTotals(trades: Trade[], id: StrategyId, depositText: string | null) {
  const observed = trades.map((trade) => scenarioFor(trade, id))
    .filter((item): item is Scenario => item !== undefined);
  const closed = observed.filter((item) => item.status === "closed" && item.profitUsdt !== null);
  const incomplete = observed.length - closed.length;
  const profit = closed.reduce((sum, item) => sum + Number(item.profitUsdt), 0);
  const deposit = Number(depositText);
  return {
    closed: closed.length,
    incomplete,
    profit,
    percent: closed.length && incomplete === 0 && depositText !== null && deposit > 0
      ? profit / deposit * 100 : null,
  };
}

function scenarioMonth(scenario: Scenario | undefined, trade: Trade) {
  const timestamp = scenario?.closedAt ?? trade.entryAt;
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return "unknown";
  const parts = samaraMonth.formatToParts(new Date(timestamp));
  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}`;
}

function PatternHistory({ pattern, name, trades, history, strategyId }: {
  pattern: string;
  name: string;
  trades: Trade[];
  history: History;
  strategyId: StrategyId;
}) {
  const actual = strategyId === 4;
  const rule = exitRule(strategyId, pattern);
  const months = new Map<string, Trade[]>();
  for (const trade of trades) {
    const month = monthOf(trade);
    months.set(month, [...(months.get(month) ?? []), trade]);
  }
  const confirmedHere = trades.filter((trade) => trade.executedStrategyId === strategyId);
  const paper = actual ? returnFor(confirmedHere, "paper", history.paperInitialDepositUsdt) : null;
  const real = actual ? returnFor(trades, "live", history.realInitialDepositUsdt) : null;
  const scenarios = trades.filter((trade) => trade.environment === "paper");
  const modeled = scenarioTotals(scenarios, strategyId, history.paperInitialDepositUsdt);
  const scenarioMonths = new Map<string, Trade[]>();
  for (const trade of scenarios) {
    const month = scenarioMonth(scenarioFor(trade, strategyId), trade);
    scenarioMonths.set(month, [...(scenarioMonths.get(month) ?? []), trade]);
  }

  return (
    <details className="group border border-border bg-card/60" data-testid={`strategy-${strategyId}-pattern-${pattern}`}>
      <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-3 p-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        <span className="min-w-0">
          <span className="block text-sm font-bold">{name}</span>
          <span className="block break-all font-mono text-[10px] text-muted-foreground">{pattern}</span>
          <span className="mt-1 block text-xs text-muted-foreground">
             {trades.length} входов · {scenarios.length} PAPER для сравнения
          </span>
        </span>
        <span className="shrink-0 text-right text-xs">
          {actual ? (
            <>
              <span className="block font-mono text-primary">PAPER {percentLabel(paper?.percent)}</span>
              <span className="block font-mono text-muted-foreground">REAL {percentLabel(real?.percent)}</span>
            </>
          ) : (
            <span className="block font-mono text-muted-foreground">
              {modeled?.closed ? `Сценарий: ${signed(modeled.profit)} USDT · ${percentLabel(modeled.percent)} от депозита` : "Сценарий: нет завершённых наблюдений"}
              {modeled?.incomplete ? ` · ${modeled.incomplete} неполных` : ""}
            </span>
          )}
          <span className="mt-1 block text-muted-foreground group-open:hidden">Подробнее</span>
          <span className="mt-1 hidden text-muted-foreground group-open:block">Свернуть</span>
        </span>
      </summary>
      <div className="space-y-5 border-t border-border p-4">
        <p className="text-xs text-muted-foreground">{ruleLabel(rule, pattern)}</p>
        {actual && <p className="text-xs text-muted-foreground">PAPER на выделенное: {percentLabel(paper?.tradePercent)} · REAL на выделенное: {percentLabel(real?.tradePercent)} · сценарная модель: {modeled?.closed ? `${signed(modeled.profit)} USDT / ${percentLabel(modeled.percent)}` : "нет завершённых наблюдений"}</p>}
        <div className="space-y-2 border-b border-border pb-4 text-xs">
            <p className="font-semibold">Сценарная модель PAPER · не реальные исполнения</p>
            <p>{modeled?.closed ? `${signed(modeled.profit)} USDT по ${modeled.closed} завершённым сценариям` : "Завершённых сценариев пока нет"} · от исходного депозита: {percentLabel(modeled?.percent)}.
              {modeled?.incomplete ? ` ${modeled.incomplete} наблюдений не завершены — общий итог неполный.` : ""}
              {" "}Старые сигналы и REAL не моделируются.
            </p>
            {[...scenarioMonths.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([month, entries]) => {
              const totals = scenarioTotals(entries, strategyId, history.paperInitialDepositUsdt);
              return (
                <div key={month} className="border border-border p-2">
                  <p className="font-semibold">{monthLabel(month)} · {totals.closed} завершено · {totals.incomplete} неполно</p>
                  <p className="font-mono">{totals.closed ? `${signed(totals.profit)} USDT` : "—"} · {percentLabel(totals.percent)} от исходного депозита</p>
                  {entries.map((trade) => {
                    const scenario = scenarioFor(trade, strategyId);
                    if (!scenario || scenario.status === "unobserved") {
                      return <div key={trade.id} className="mt-2 border-t border-border pt-2">
                        <p>{trade.symbol} · вход PAPER учтён · нет наблюдений для этой стратегии</p>
                        <p className="text-muted-foreground">Итог: —. Сделка не исключена из списка; исторический сценарий не восстанавливается.</p>
                      </div>;
                    }
                    return <div key={trade.id} className="mt-2 border-t border-border pt-2">
                      <p>{trade.symbol} · {scenario.status === "closed" ? "модель завершена" : "модель неполная / открыта"}</p>
                      <p>Итог: {scenario.profitUsdt === null ? "—" : `${signed(Number(scenario.profitUsdt))} USDT`} · {scenario.profitPercent === null ? "—" : `${signed(Number(scenario.profitPercent))}%`} от исходного депозита · исходная доля сделки {scenario.allocatedPercent === null ? "—" : `${formatNumber(Number(scenario.allocatedPercent), 2)}%`}</p>
                      <p>Закрытые части (до издержек): {scenario.grossUsdt === null ? "—" : `${signed(Number(scenario.grossUsdt))} USDT`}; оценка комиссий: {scenario.estimatedCostUsdt === null ? "—" : `${formatNumber(Number(scenario.estimatedCostUsdt), 4)} USDT`}</p>
                      {scenario.exits.map((exit, index) => <p key={index} className="font-mono text-muted-foreground">Часть {exit.quantity} × {exit.price} · {signed(Number(exit.grossUsdt))} USDT · {exit.reason}</p>)}
                    </div>;
                  })}
                </div>
              );
            })}
        </div>
        {months.size === 0 ? (
          <p className="text-xs text-muted-foreground">Исполненных сделок этого паттерна пока нет.</p>
        ) : [...months.entries()].sort(([a], [b]) =>
          a === "unknown" ? 1 : b === "unknown" ? -1 : b.localeCompare(a)
        ).map(([month, monthTrades]) => {
          const monthConfirmed = monthTrades.filter((trade) => trade.executedStrategyId === strategyId);
          const monthPaper = actual ? returnFor(monthConfirmed, "paper", history.paperInitialDepositUsdt) : null;
          const monthReal = actual ? returnFor(monthTrades, "live", history.realInitialDepositUsdt) : null;
          return (
            <section key={month} className="space-y-3" aria-label={monthLabel(month)}>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
                <h3 className="text-xs font-bold uppercase tracking-wider">{monthLabel(month)}</h3>
                <span className="font-mono text-xs text-muted-foreground">
                  {actual
                    ? `PAPER: ${percentLabel(monthPaper?.tradePercent)} на выделенное → ${percentLabel(monthPaper?.percent)} от депозита · REAL: ${percentLabel(monthReal?.tradePercent)} → ${percentLabel(monthReal?.percent)}`
                    : "Фактическая доходность этой схемы: — (сценарии отдельно выше)"}
                </span>
              </div>
              <div className="space-y-2">
                {monthTrades.map((trade) => {
                  const executedHere = actual && (trade.executedStrategyId === strategyId ||
                    trade.environment === "live" && trade.accountingStatus === "verified");
                  return (
                  <div key={trade.id} className="grid gap-2 border border-border bg-background/40 p-3 text-xs sm:grid-cols-[1fr_auto]">
                    <div>
                      <p className="font-mono font-semibold">{trade.symbol} · {trade.environment.toUpperCase()}</p>
                      <p className="mt-1 text-muted-foreground">
                        {!executedHere ? "Историческая сделка бота · эта схема для неё не подтверждена" :
                          trade.status === "open" ? "Открыта · итоговый профит ещё неизвестен" :
                           trade.accountingStatus === "verified" ? trade.environment === "live"
                             ? "Закрыта · REAL-итог подтверждён (не приписан схеме 4)"
                             : "Закрыта · итог учтён" :
                            "Закрыта · итог не подтверждён полностью"}
                      </p>
                    </div>
                    <div className="space-y-1 font-mono sm:text-right">
                      <p>Профит: {!executedHere || trade.profitUsdt === null ? "—" : `${signed(Number(trade.profitUsdt))} USDT`}</p>
                      {!executedHere && trade.profitUsdt !== null && (
                        <p className="text-muted-foreground">
                          Прежняя схема PAPER: {signed(Number(trade.profitUsdt))} USDT (не входит в итог выбранной схемы)
                        </p>
                      )}
                      <p>Доходность на выделенную сумму: {!executedHere || trade.tradeProfitPercent === null ? "—" : `${signed(Number(trade.tradeProfitPercent))}%`}</p>
                      <p>Доходность от исходного депозита: {!executedHere || trade.profitPercent === null ? "—" : `${signed(Number(trade.profitPercent))}%`}</p>
                      <p>{executedHere ? "Первоначально выделено" : "Исходный вход: выделено"}: {trade.allocatedPercent === null ? "—" :
                        `${formatNumber(Number(trade.allocatedPercent), 2)}%${trade.allocatedUsdt === null ? "" : ` (${formatNumber(Number(trade.allocatedUsdt), 2)} USDT)`}`}</p>
                    </div>
                  </div>
                );})}
              </div>
            </section>
          );
        })}
      </div>
    </details>
  );
}

export default function JournalStrategies() {
  const [selectedStrategy, setSelectedStrategy] = useState<StrategyId>(4);
  const { data, isLoading, error } = useGetJournalStrategyHistory({
    query: {
      queryKey: getGetJournalStrategyHistoryQueryKey(),
      refetchInterval: 15_000,
      refetchOnMount: "always",
    },
  });
  const patterns = new Map<string, Trade[]>();
  for (const trade of data?.trades ?? []) {
    const name = trade.patternId || "Без паттерна";
    patterns.set(name, [...(patterns.get(name) ?? []), trade]);
  }
  const selected = strategyDefinitions.find((strategy) => strategy.id === selectedStrategy)!;
  const displayPatterns = [
    ...knownPatterns,
    ...[...patterns.keys()]
      .filter((id) => !knownPatterns.some((pattern) => pattern.id === id))
      .sort()
      .map((id) => ({ id, name: id })),
  ];

  return (
    <section className="page-frame mx-auto max-w-6xl space-y-6" aria-label="Стратегии" data-testid="page-strategies">
      <header className="border-b border-border pb-4">
        <p className="font-mono text-[10px] uppercase tracking-[.22em] text-primary">Bullet / стратегии</p>
        <h1 className="mt-1 text-2xl font-bold uppercase tracking-tight">Стратегии</h1>
      </header>
      <div className="grid gap-3 xl:grid-cols-2" role="group" aria-label="Стратегии и памятка по правилам">
        {strategyDefinitions.map((strategy) => (
          <div
            key={strategy.id}
            className={`border p-4 transition-colors ${
              selectedStrategy === strategy.id
                ? "border-primary bg-primary/10"
                : "border-border bg-card/60"
            }`}
          >
            <button
              type="button"
              data-testid={`select-strategy-${strategy.id}`}
              aria-pressed={selectedStrategy === strategy.id}
              aria-controls="strategy-details"
              onClick={() => setSelectedStrategy(strategy.id)}
              className="flex w-full items-start justify-between gap-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            >
              <span>
                <span className="block font-mono text-[10px] uppercase tracking-widest text-primary">
                  Стратегия {strategy.id} · {strategy.actual ? "PAPER для новых входов" : "сценарий PAPER"}
                </span>
                <span className="mt-1 block text-base font-bold text-foreground">{strategy.name}</span>
              </span>
              <span className="shrink-0 pt-1 text-xs text-muted-foreground">
                {selectedStrategy === strategy.id ? "Выбрана" : "Открыть ↓"}
              </span>
            </button>
            <details className="mt-3 border-t border-border pt-3" data-testid={`memo-strategy-${strategy.id}`}>
              <summary className="w-fit cursor-pointer text-xs font-semibold text-muted-foreground hover:text-foreground" data-testid={`toggle-strategy-memo-${strategy.id}`}>Правила и памятка</summary>
              <ul className="mt-2 list-disc space-y-2 pl-4 text-xs leading-relaxed text-foreground/85 marker:text-primary">
                {strategy.memo.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </details>
          </div>
        ))}
      </div>
      <div id="strategy-details" className="space-y-3 border border-border bg-card/60 p-4 sm:p-6">
        <p className="font-mono text-[10px] uppercase tracking-widest text-primary">
          Стратегия {selected.id} · {selected.actual ? "PAPER для новых входов" : "не исполняется целиком"}
        </p>
        <h2 className="text-lg font-bold uppercase">{selected.name}</h2>
        <p className="text-sm" data-testid="strategy-paper-deposit">
          Начальный депозит PAPER: {data?.paperInitialDepositUsdt
            ? `${formatNumber(Number(data.paperInitialDepositUsdt), 2)} USDT` : "—"}.
          {" "}Все вошедшие PAPER-сделки доступны в каждой из четырёх стратегий, включая открытые и убыточные.
        </p>
        <Link href="/journal" className="inline-block text-xs text-primary underline underline-offset-4">
          Открыть PAPER-позиции
        </Link>
        <details className="text-xs text-muted-foreground" data-testid="strategy-method">
          <summary className="w-fit cursor-pointer font-semibold hover:text-foreground" data-testid="toggle-strategy-method">О схеме и расчётах</summary>
          <p className="mt-3">{selected.summary}</p>
          <p className="mt-3 border-l-2 border-primary/60 pl-3">
          Доходность сделки = чистая прибыль ÷ первоначально выделенная сумма × 100%.
          Доходность от исходного депозита = доходность сделки × доля депозита, выделенная на сделку.
           Например: +2 USDT на 10 USDT из исходных 1 000 USDT — это +20% на сделку и +0,2% к депозиту.
          При частичном тейке прибыль закрытой части не исчезает, даже если остаток выйдет в БУ.
        </p>
          <p className="mt-3">
          {selected.actual
             ? "Фактические PAPER/REAL-итоги и независимая сценарная модель показаны отдельно. Фактические сделки сгруппированы по месяцу закрытия, открытые — по месяцу входа. REAL учитывается только после подтверждения собственных исполнений, комиссий и funding; сценарии никогда не запускают LIVE-исполнение."
             : "Ниже сценарии только новых PAPER-сигналов, отдельно от фактических результатов. Для старых сделок модель не строится."}
          {" "}Месяцы — по времени Самары.
        </p>
        </details>
      </div>

      {isLoading ? (
        <Skeleton className="h-72 w-full rounded-none" />
      ) : error || !data ? (
        <ErrorState message="Не удалось загрузить историю стратегий" />
      ) : patterns.size === 0 && selected.actual ? (
        <p className="border border-border bg-card/60 p-4 text-sm text-muted-foreground">
          У бота пока нет исполненных сделок.
        </p>
      ) : (
        <div className="space-y-3" data-testid="strategy-pattern-list">
          {displayPatterns.map(({ id, name }) => (
            <PatternHistory
              key={id}
              pattern={id}
              name={name}
              trades={patterns.get(id) ?? []}
              history={data}
              strategyId={selectedStrategy}
            />
          ))}
        </div>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="w-fit cursor-pointer font-semibold hover:text-foreground" data-testid="toggle-strategy-assumptions">Источники и ограничения расчётов</summary>
      {selected.actual ? (
        <p className="mt-3">
          Основа процента PAPER — первоначальный депозит бота
          {data?.paperInitialDepositUsdt ? ` (${formatNumber(Number(data.paperInitialDepositUsdt), 2)} USDT)` : ""}.
           REAL-исполнение схемы 4 не включено. Основа REAL — зафиксированный свободный баланс общего счёта
           {data?.realInitialDepositUsdt ? ` (${formatNumber(Number(data.realInitialDepositUsdt), 4)} USDT` : " (ещё не записан"}
           {data?.realBaselineAt ? ` на ${new Date(data.realBaselineAt).toLocaleString("ru-RU", { timeZone: "Europe/Samara" })})` : ")"}. Это выбранная исходная база, не бот-капитал.
           Неполные или внешние исполнения не входят в итог; отсутствие подтверждённой доходности показывается как «—».
          Старые PAPER-сделки другой версии правил не приписываются этой схеме; их результат остаётся в истории.
          {" "}Сценарии новых PAPER-сигналов основаны на наблюдаемых котировках BingX (lastPrice для целей и стопов, bid1Price для оценочного выхода); между наблюдениями порядок цены неизвестен.
          Комиссии оценены по ставке PAPER taker на входе для входа и выходов; funding исключён. Сценарные цифры не являются реальными исполнениями.
        </p>
      ) : (
        <p className="mt-3">
          Проценты фиксации относятся к исходному объёму позиции, а пороги +5/+10/+15% — к цене входа
          без умножения на плечо. Сценарии используют наблюдаемые воркером котировки BingX lastPrice для порядка целей и стопов,
          bid1Price для оценочной цены выхода; промежутки между наблюдениями неизвестны.
          Оценка комиссий — ставка PAPER taker на момент входа для входа и выходов; funding не включён.
          Это не биржевые исполнения, и результат может отличаться от реального.
        </p>
      )}
      </details>
    </section>
  );
}