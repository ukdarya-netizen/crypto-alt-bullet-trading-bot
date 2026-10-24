import "./_group.css";
import { useEffect, useState, type AnchorHTMLAttributes } from "react";
import { ArrowUpRight, ChevronDown, RefreshCw } from "lucide-react";
import {
  getGetJournalBotQueryKey, getGetJournalBingxPositionsQueryKey, getGetJournalVstPositionsQueryKey,
  useGetJournalBot, useGetJournalBingxPositions, useGetJournalVstPositions,
} from "./_fixtures";
import type { BingXAccountPosition, JournalBotPositionsItem, JournalVstPositionsPositionsItem } from "./_fixtures";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate, formatNumber } from "./_utils";
import { sortPositionsNewestFirst } from "./_utils";

type Mode = "paper" | "real" | "vst";
function Link({ href, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return <a href={href} {...props} onClick={(event) => { event.preventDefault(); onClick?.(event); }} />;
}
type Position = {
  id: string;
  symbol: string;
  side: string;
  size: string;
  entry: string;
  current: string;
  pnl: string | null;
  stop: string;
  status: string;
  details: { label: string; value: string }[];
};

function number(value: unknown, digits = 4): string {
  if (value === null || value === undefined || value === "") return "—";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? formatNumber(parsed, digits) : "—";
}
function text(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "—";
}
function fresh(value: string | null | undefined, now: number): boolean {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) && now - time >= -5000 && now - time <= 90000;
}
function pnlText(value: string | null): string | null {
  if (value === null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? `${n > 0 ? "+" : ""}${formatNumber(n, 2)} USDT` : null;
}
function paperPosition(position: JournalBotPositionsItem, now: number): Position {
  const s = position.snapshot;
  const quoteFresh = position.market.quoteStatus === "fresh" && fresh(position.market.quoteAt, now);
  const runnerOnly = s.runnerOpen === true && s.coreOpen === false;
  const stop = runnerOnly ? position.marginRisk.stopPriceUsed ?? s.runnerStopPrice : s.stopPrice;
  return {
    id: position.sourceSignalId,
    symbol: text(s.symbol),
    side: typeof s.side === "string" ? s.side.toUpperCase() : "LONG",
    size: number(s.remainingQty ?? s.quantity, 6),
    entry: number(s.entryPrice, 4),
    current: quoteFresh ? number(position.market.quotePrice, 4) : "—",
    pnl: quoteFresh ? pnlText(position.market.unrealizedPnlUsdt) : null,
    stop: number(stop, 4),
    status: position.status === "closing" ? "Закрывается" : "Открыта",
    details: [
      { label: "Сигнал", value: position.sourceSignalId },
      { label: "Котировка", value: quoteFresh ? `${position.market.priceBasis} · ${formatDate(position.market.quoteAt!)}` : "Нет свежей котировки" },
      { label: "Открыта", value: typeof s.entryAt === "string" ? formatDate(s.entryAt) : "—" },
      { label: "Маржа PAPER", value: `${number(s.marginHeldUsd, 4)} USDT` },
      { label: "Источник", value: "Симуляция бота; стоп не является биржевым ордером" },
    ],
  };
}
function realPosition(position: BingXAccountPosition, index: number, available: boolean): Position {
  return {
    id: `${position.symbol}-${position.side}-${index}`,
    symbol: position.symbol || "—",
    side: position.side ?? "—",
    size: number(position.size, 6),
    entry: number(position.entryPrice, 4),
    current: available ? number(position.markPrice, 4) : "—",
    pnl: available ? pnlText(position.unrealizedPnlUsdt) : null,
    stop: number(position.stopPrice, 4),
    status: "Открыта",
    details: [
      { label: "Маржа", value: `${number(position.marginUsdt, 4)} USDT` },
      { label: "Режим / плечо", value: `${position.marginMode ?? "—"} / ${position.leverage ?? "—"}×` },
      { label: "Ликвидация", value: number(position.liquidationPrice, 4) },
      { label: "Открыта", value: position.openedAt ? formatDate(position.openedAt) : "—" },
      { label: "Источник", value: "Весь счёт BingX; связь с ботом не установлена. Неизвестный стоп не означает отсутствие ордера." },
    ],
  };
}
function vstPosition(position: JournalVstPositionsPositionsItem): Position {
  return {
    id: position.sourceSignalId,
    symbol: position.symbol || "—",
    side: "—",
    size: number(position.remainingQty, 6),
    entry: number(position.entryPrice, 4),
    current: "—",
    pnl: null,
    stop: number(position.stopPrice, 4),
    status: position.status === "open" ? "Открыта" : position.status === "closing" ? "Закрывается" : "Неизвестно",
    details: [
      { label: "Сигнал", value: position.sourceSignalId },
      { label: "Запись обновлена", value: formatDate(position.updatedAt) },
      { label: "Источник", value: "VST ledger; биржевая позиция и маржа не проверялись при этом чтении" },
    ],
  };
}

function PositionList({ positions, mode, empty }: { positions: Position[]; mode: Mode; empty: string }) {
  return (
    <section className="position-book" data-testid={`section-${mode}-positions`}>
      <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
        <h2 className="text-sm font-bold uppercase tracking-wider">Открытые позиции <span className="ml-1 font-mono text-muted-foreground">{positions.length}</span></h2>
        <span className="position-book-label">15 сек · автообновление</span>
      </div>
      {positions.length === 0 ? (
        <div className="border-t border-border px-5 py-12 text-center" data-testid={`empty-${mode}-positions`}>
          <p className="font-medium">{empty}</p>
          <p className="mt-1 text-xs text-muted-foreground">Данные этого режима не заменяются данными другого счёта.</p>
        </div>
      ) : positions.map((position, index) => (
        <article key={`${position.id}-${index}`} className="position-book-row px-4 py-4 sm:px-5" data-testid={`card-${mode}-position-${index}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className={`h-8 w-0.5 shrink-0 ${position.side === "SHORT" ? "bg-destructive" : mode === "real" ? "bg-amber-400" : "bg-primary"}`} />
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="break-all font-mono text-base font-bold tracking-tight sm:text-lg" data-testid={`text-${mode}-symbol-${index}`}>{position.symbol}</h3>
                  <span className={`border px-1.5 py-0.5 font-mono text-[10px] font-bold ${position.side === "SHORT" ? "border-destructive/40 text-destructive" : position.side === "—" ? "border-border text-muted-foreground" : "border-success/40 text-success"}`}>{position.side === "—" ? "Сторона —" : position.side}</span>
                  <span className="border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{position.status}</span>
                </div>
              </div>
            </div>
            {mode !== "vst" && (
              <div className="sm:text-right" data-testid={`value-${mode}-pnl-${index}`}>
                <p className="position-book-label">Открытый PnL</p>
                <p className={`position-book-value mt-1 text-base font-bold ${position.pnl?.startsWith("+") ? "text-success" : position.pnl?.startsWith("-") ? "text-destructive" : ""}`}>{position.pnl ?? "—"}</p>
              </div>
            )}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3 border-t border-border/70 pt-3 sm:grid-cols-4">
            {[
              ["Размер", position.size], ["Вход", position.entry],
              [mode === "vst" ? "Текущая цена" : mode === "real" ? "Mark price" : "Котировка", position.current],
              ["Стоп", position.stop],
            ].map(([label, value]) => <div key={label} className="min-w-0"><p className="position-book-label">{label}</p><p className="position-book-value mt-1 break-all" data-testid={`value-${mode}-${label}-${index}`}>{value}</p></div>)}
          </div>
          <details className="mt-3 border-t border-border/70 pt-2 text-xs">
            <summary className="flex w-fit items-center gap-1.5 py-1 text-muted-foreground hover:text-foreground" data-testid={`toggle-${mode}-details-${index}`}>
              Детали <ChevronDown className="position-chevron h-3.5 w-3.5" />
            </summary>
            <dl className="grid gap-3 pb-2 pt-3 sm:grid-cols-2">
              {position.details.map(({ label, value }) => <div key={label} className="min-w-0"><dt className="position-book-label">{label}</dt><dd className="mt-1 break-all font-mono text-xs">{value}</dd></div>)}
            </dl>
          </details>
        </article>
      ))}
    </section>
  );
}

function Loading({ mode }: { mode: Mode }) {
  return <div className="position-book space-y-3 p-5" role="status" data-testid={`status-${mode}-loading`}>
    <Skeleton className="h-5 w-36 rounded-none" /><Skeleton className="h-24 w-full rounded-none" /><Skeleton className="h-24 w-full rounded-none" />
  </div>;
}
function Problem({ mode, title, retry }: { mode: Mode; title: string; retry: () => void }) {
  return <div className="position-book p-5" role="status" data-testid={`status-${mode}-unavailable`}>
    <p className="font-semibold">{title}</p>
    <p className="mt-1 text-xs text-muted-foreground">Текущее состояние неизвестно. Данные других режимов не подставляются.</p>
    <button type="button" onClick={retry} className="mt-4 inline-flex items-center gap-2 border border-border px-3 py-2 text-xs font-bold uppercase hover:bg-secondary" data-testid={`button-retry-${mode}`}><RefreshCw className="h-3.5 w-3.5" /> Повторить</button>
  </div>;
}
function PaperBook({ now }: { now: number }) {
  const { data, isLoading, error, refetch } = useGetJournalBot({ query: { queryKey: getGetJournalBotQueryKey(), refetchInterval: 15000 } });
  if (isLoading) return <Loading mode="paper" />;
  if (error || !data) return <Problem mode="paper" title="PAPER-бот недоступен" retry={() => { void refetch(); }} />;
  const positions = sortPositionsNewestFirst(data.positions.filter(p => p.status !== "closed"), p => typeof p.snapshot.entryAt === "string" ? p.snapshot.entryAt : null, p => p.sourceSignalId);
  return <>
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 border px-3 py-2 text-xs ${data.sourceSync.state === "error" ? "border-destructive/40 text-destructive" : data.sourceSync.state === "pending" ? "border-border text-muted-foreground" : "border-success/40 text-success"}`} role="status" data-testid="status-paper-source-sync">
      <span className="font-semibold">{data.sourceSync.state === "ok" ? "Источник · синхронизирован" : data.sourceSync.state === "error" ? "Источник · ошибка синхронизации" : "Источник · проверка ожидается"}</span>
      <span className="text-muted-foreground">
        {data.sourceSync.state === "ok"
          ? `Проверка: ${data.sourceSync.checkedAt ? formatDate(data.sourceSync.checkedAt) : "время неизвестно"}`
          : `Последняя успешная: ${data.sourceSync.lastSuccessAt ? formatDate(data.sourceSync.lastSuccessAt) : "нет данных"}`}
      </span>
      {data.sourceSync.state === "error" && data.sourceSync.reason && <details className="w-full text-muted-foreground"><summary className="w-fit cursor-pointer underline underline-offset-2" data-testid="toggle-paper-sync-reason">Причина</summary><p className="mt-1 break-words">{data.sourceSync.reason}</p></details>}
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="border border-border bg-card px-4 py-3"><p className="position-book-label">PAPER кошелёк · симуляция</p><p className="mt-1 font-mono text-xl font-bold">{number(data.paperEquity.walletUsdt, 2)} USDT</p></div>
      <div className="border border-border bg-card px-4 py-3"><p className="position-book-label">Стоимость · при подтверждённых данных</p><p className="mt-1 font-mono text-xl font-bold">{(data.paperEquity.status === "fresh" || data.paperEquity.status === "no_position") && data.paperEquity.equityUsdt !== null ? `${number(data.paperEquity.equityUsdt, 2)} USDT` : "—"}</p></div>
    </div>
    <PositionList mode="paper" positions={positions.map(p => paperPosition(p, now))} empty="Нет открытых PAPER-позиций" />
    <Link href="/journal/open" className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline" data-testid="link-paper-legacy-close">Старые открытые записи и ручное PAPER-закрытие <ArrowUpRight className="h-3.5 w-3.5" /></Link>
  </>;
}
function RealBook({ now }: { now: number }) {
  const { data, isLoading, error, refetch } = useGetJournalBingxPositions({ query: { queryKey: getGetJournalBingxPositionsQueryKey(), refetchInterval: 15000 } });
  if (isLoading) return <Loading mode="real" />;
  if (error || !data) return <Problem mode="real" title="Не удалось прочитать счёт BingX" retry={() => { void refetch(); }} />;
  const available = data.status === "available" && fresh(data.observedAt, now);
  if (!available) return <Problem mode="real" title={data.status === "not_configured" ? "Доступ к BingX не настроен" : data.status === "available" ? "Снимок позиций устарел" : "Позиции BingX недоступны"} retry={() => { void refetch(); }} />;
  const accountFresh = data.accountStatus === "available" && fresh(data.accountObservedAt, now);
  return <>
    <div className="border border-amber-500/30 bg-card px-4 py-3">
      <p className="position-book-label">Весь REAL-счёт · equity USDT</p>
      <p className="mt-1 font-mono text-xl font-bold" data-testid="value-real-equity">{accountFresh && data.account?.equityUsdt != null ? `${number(data.account.equityUsdt, 2)} USDT` : "—"}</p>
      {!accountFresh && <p className="mt-1 text-xs text-muted-foreground">Свежий баланс недоступен</p>}
    </div>
    <PositionList mode="real" positions={sortPositionsNewestFirst(data.positions, p => p.openedAt, p => `${p.symbol}:${p.side}`).map((p, i) => realPosition(p, i, available))} empty="В последнем чтении BingX позиций нет" />
    <p className="text-xs text-muted-foreground">Снимок сервера: {data.observedAt ? formatDate(data.observedAt) : "—"} · Время биржевой котировки не передано.</p>
  </>;
}
function VstBook() {
  const { data, isLoading, error, refetch } = useGetJournalVstPositions({ query: { queryKey: getGetJournalVstPositionsQueryKey(), refetchInterval: 15000 } });
  if (isLoading) return <Loading mode="vst" />;
  if (error || !data) return <Problem mode="vst" title="VST ledger недоступен" retry={() => { void refetch(); }} />;
  if (data.source !== "vst_ledger" || data.exchangeVerification !== "not_requested") return <Problem mode="vst" title="Неожиданный источник VST" retry={() => { void refetch(); }} />;
  return <>
    <PositionList mode="vst" positions={sortPositionsNewestFirst(data.positions, p => p.updatedAt, p => p.sourceSignalId).map(vstPosition)} empty="В VST ledger открытых записей нет" />
    <p className="text-xs text-muted-foreground">Только записи VST ledger. Текущая цена, PnL и маржа не подтверждены биржей.</p>
  </>;
}

export function JournalPositions({ mode }: { mode: Mode }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);
  const title = { paper: "PAPER", real: "REAL", vst: "VST" }[mode];
  const subtitle = { paper: "Симуляция бота · не биржевые позиции", real: "Весь счёт BingX · только чтение", vst: "VST ledger · без свежей проверки биржи" }[mode];
  return <div className="page-frame mx-auto max-w-5xl space-y-5" data-testid={`page-${mode}-positions`}>
    <div className="border-b border-border pb-4">
      <p className="position-book-label">Позиции / {title}</p>
      <h1 className="mt-1 text-2xl font-bold tracking-tight">{title} <span className="font-normal text-muted-foreground">/ Позиции</span></h1>
      <p className="mt-1 text-xs text-muted-foreground" data-testid={`status-${mode}-source`}>{subtitle}</p>
    </div>
    <nav className="flex gap-2 border-b border-border pb-3 text-xs font-bold uppercase" aria-label="Режим позиций">
      {(["paper", "real", "vst"] as const).map((bookMode) => (
        <a key={bookMode} href={`?mode=${bookMode}`} className={`border px-3 py-2 ${bookMode === mode ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}>
          {bookMode.toUpperCase()}
        </a>
      ))}
    </nav>
    {mode === "paper" ? <PaperBook now={now} /> : mode === "real" ? <RealBook now={now} /> : <VstBook />}
  </div>;
}