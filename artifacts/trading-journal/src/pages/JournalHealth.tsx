import { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { getGetJournalBotHealthQueryKey, useGetJournalBotHealth } from "@workspace/api-client-react";
import type { BotHealthCheck, BotHealthMetric, BotHealthPolicy, JournalBotHealth } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/utils";
import { SourceCommandStatus } from "@/components/SourceCommandStatus";

type Status = "healthy" | "degraded" | "critical" | "unknown" | "paused";
const STATUS_LABEL: Record<Status, string> = {
  healthy: "В норме", degraded: "Есть замечания", critical: "Критично", unknown: "Неизвестно", paused: "На паузе",
};
const STATUS_CLASS: Record<Status, string> = {
  healthy: "border-success/60 text-success",
  degraded: "border-amber-400/60 text-amber-300",
  critical: "border-destructive/70 text-destructive",
  unknown: "border-border text-muted-foreground",
  paused: "border-border text-foreground",
};

export function fmtDuration(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v < 0) return "неизвестно";
  if (v < 1000) return `${Math.round(v)} мс`;
  const s = v / 1000;
  if (s < 60) return `${Number.isInteger(s) ? s : s.toFixed(1)} с`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return r ? `${m} мин ${r} с` : `${m} мин`;
}
function fmtValue(v: number | null, unit: BotHealthMetric["unit"]): string {
  if (v === null || !Number.isFinite(v)) return "неизвестно";
  if (unit === "ms") return fmtDuration(v);
  if (unit === "http") return v === 0 ? "нет ответа (0)" : `HTTP ${v}`;
  return String(v);
}
function fmtNormal(v: number | null, unit: BotHealthMetric["unit"]): string {
  if (v === null) return "порог не задан";
  if (unit === "ms") return `норма до ${fmtDuration(v)}`;
  if (unit === "http") return `норма HTTP ${v}`;
  return `норма до ${v}`;
}
function when(v: string | null): string {
  if (!v || !Number.isFinite(Date.parse(v))) return "неизвестно";
  return formatDate(v);
}
function normStatus(s: string): Status {
  return (["healthy", "degraded", "critical", "unknown", "paused"] as const).includes(s as Status) ? (s as Status) : "unknown";
}
function Badge({ status, testId }: { status: Status; testId?: string }) {
  return <span data-testid={testId} className={`inline-block border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase ${STATUS_CLASS[status]}`}>{STATUS_LABEL[status]}</span>;
}

function MetricCell({ m, checkKey }: { m: BotHealthMetric; checkKey: string }) {
  const over = m.value !== null && m.normalMax !== null && m.unit !== "http" && m.value > m.normalMax;
  return (
    <div className="min-w-0" data-testid={`metric-${checkKey}-${m.key}`}>
      <p className="position-book-label">{m.label}</p>
      <p className={`position-book-value mt-1 ${over ? "text-amber-300" : ""}`}>{fmtValue(m.value, m.unit)}</p>
      <p className="text-[11px] text-muted-foreground">{fmtNormal(m.normalMax, m.unit)}{over ? " · выше нормы" : ""}</p>
    </div>
  );
}

function CheckRow({ c, unverified }: { c: BotHealthCheck; unverified: boolean }) {
  const st = unverified && c.status === "healthy" ? "unknown" : normStatus(c.status);
  return (
    <article className="position-book-row px-4 py-4 sm:px-5" data-testid={`card-health-check-${c.key}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-sm font-bold">{c.title}</h3>
        <Badge status={st} testId={`badge-health-check-${c.key}`} />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{c.summary}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">Последний успех: {when(c.lastSuccessAt)}</p>
      {c.metrics.length === 0 ? (
        <p className="mt-3 border-t border-border/70 pt-3 text-xs text-muted-foreground">Измерений нет. Это не значит, что всё в порядке.</p>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-border/70 pt-3 sm:grid-cols-3">
          {c.metrics.map((m) => <MetricCell key={m.key} m={m} checkKey={c.key} />)}
        </div>
      )}
    </article>
  );
}

function PolicyBlock({ p }: { p: BotHealthPolicy }) {
  const rows = [
    `Источник старше ${fmtDuration(p.sourceFreshnessMs)} — только статус, без уведомления.`,
    `Предупреждение в Telegram: сбой источника дольше ${fmtDuration(p.sourceWarningAfterMs)} и не менее ${p.sourceWarningFailures} неудачных проверок подряд.`,
    `Критичный сигнал: источник недоступен дольше ${fmtDuration(p.sourceCriticalAfterMs)}. Зависший запрос к источнику критичен и без ${p.sourceWarningFailures} сбоев.`,
    `Незавершённый цикл VST требует проверки после ${fmtDuration(p.workerStallAfterMs)}. Ожидание в очереди входов дольше ${fmtDuration(p.queueWarningAfterMs)} или в очереди Telegram дольше ${fmtDuration(p.telegramWarningAfterMs)} отмечается как задержка, а не доказанный сбой. Прежние критические уведомления сохраняются.`,
    `Повтор одной и той же тревоги не чаще раза в ${fmtDuration(p.repeatMs)}. Повышение до критического уровня приходит отдельно.`,
    `Восстановление: ${fmtDuration(p.recoveryStableMs)} стабильности и ${p.recoverySuccesses} успешных снимка подряд. Сообщение о восстановлении приходит только если сама тревога была доставлена.`,
  ];
  return (
    <section className="position-book" data-testid="section-health-policy">
      <h2 className="px-4 py-3 text-sm font-bold uppercase tracking-wider sm:px-5">Когда бот пишет в Telegram</h2>
      <ul className="space-y-2 border-t border-border px-4 py-3 text-xs text-muted-foreground sm:px-5">
        {rows.map((r, i) => <li key={i}>{r}</li>)}
      </ul>
    </section>
  );
}

export interface JournalHealthViewProps {
  data: JournalBotHealth | undefined;
  isLoading: boolean;
  hasError: boolean;
  isFetching?: boolean;
  now: number;
  onRetry: () => void;
}

export function JournalHealthView({ data, isLoading, hasError, isFetching, now, onRetry }: JournalHealthViewProps) {
  const retry = <button type="button" onClick={onRetry} className="mt-3 inline-flex items-center gap-2 border border-border px-3 py-2 text-xs font-bold uppercase hover:bg-secondary" data-testid="button-retry-health"><RefreshCw className="h-3.5 w-3.5" /> Повторить</button>;
  let body;
  if (isLoading) {
    body = <div className="space-y-3 p-5" role="status" data-testid="status-health-loading"><Skeleton className="h-20 w-full" /><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div>;
  } else if (!data) {
    body = <div className="p-5" role="alert" data-testid="status-health-error"><p className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4 text-destructive" /> Здоровье бота не удалось загрузить. Состояние неизвестно, это не значит, что всё в порядке.</p>{retry}</div>;
  } else {
    const asOfMs = Date.parse(data.asOf);
    const age = Number.isFinite(asOfMs) ? Math.max(0, now - asOfMs) : null;
    const stale = hasError || age === null || asOfMs > now + 30_000 ||
      age > data.freshnessMs || data.checks.length === 0;
    const status: Status = stale ? "unknown" : normStatus(data.status);
    const preview = data.environment === "preview";
    const paused = normStatus(data.status) === "paused";
    body = (
      <>
        {stale && (
          <div className="bg-destructive/10 px-4 py-3 text-xs sm:px-5" role="alert" data-testid="status-health-stale">
            {hasError ? "Не удалось обновить данные. " : `Снимок старше ${fmtDuration(data.freshnessMs)}. `}
            Ниже последние известные данные на {when(data.asOf)}; они не проверены и могли устареть.
            {retry}
          </div>
        )}
        <div className="px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-center gap-3">
            <Badge status={status} testId="badge-health-status" />
            <span className="border border-border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase" data-testid="badge-health-env">{preview ? "Предпросмотр" : "Production"}</span>
            {stale && <span className="font-mono text-[10px] uppercase text-muted-foreground">не проверено</span>}
          </div>
           <p className="mt-3 text-sm" data-testid="text-health-summary">{stale ? "Последний известный вывод: " : ""}{data.summary}</p>
          <p className="mt-2 text-[11px] text-muted-foreground" data-testid="text-health-asof">
            Снимок: {when(data.asOf)}{age !== null ? ` (${fmtDuration(age)} назад)` : ""} · бот запущен: {when(data.startedAt)}{isFetching ? " · обновление" : ""}
          </p>
        </div>
        {(preview || paused) && (
          <p className="border-t border-border px-4 py-2 text-xs font-semibold sm:px-5" data-testid="note-health-preview">
            {preview ? "Это среда предпросмотра, а не рабочий production. " : ""}{paused ? "Бот на паузе. " : ""}Эти данные не показывают нормальную торговлю.
          </p>
        )}
        <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground sm:px-5" data-testid="note-health-readonly">
          Только локальная телеметрия бота, без запросов к бирже. Здоровье не доказывает ни исполнение ордеров, ни подтверждённые стопы.
        </p>
        {data.checks.length === 0
          ? <p className="border-t border-border px-5 py-8 text-center text-sm" data-testid="empty-health-checks">Проверки не переданы. Состояние компонентов неизвестно.</p>
          : data.checks.map((c) => <CheckRow key={c.key} c={c} unverified={stale} />)}
        <div className="border-t border-border px-4 py-3 sm:px-5" data-testid="section-health-incidents">
          <h2 className="text-sm font-bold uppercase tracking-wider">Инциденты</h2>
          {data.incidents.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">Открытых инцидентов в снимке нет{stale ? " (снимок не проверен)" : ""}.</p>
          ) : data.incidents.map((i, n) => (
            <p key={`${i.component}-${n}`} className="mt-2 text-xs" data-testid={`row-health-incident-${n}`}>
              <span className="font-bold">{i.component}</span> · {i.severity === "critical" ? "критично" : "предупреждение"} · с {when(i.startedAt)} · {i.alertedAt ? `уведомление доставлено ${when(i.alertedAt)}` : "уведомление не доставлялось"}{i.recoverySince ? ` · восстановление с ${when(i.recoverySince)}` : ""}
            </p>
          ))}
        </div>
      </>
    );
  }
  return (
    <div className="mx-auto max-w-5xl space-y-5" data-testid="page-bot-health">
      <header>
        <h1 className="text-xl font-bold uppercase tracking-tight">Bot Health</h1>
        <p className="mt-1 text-sm text-muted-foreground">Здоровье бота и границы нормальной работы</p>
      </header>
      <section className="position-book">{body}</section>
      {data && <PolicyBlock p={data.policy} />}
    </div>
  );
}

export default function JournalHealth() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  const q = useGetJournalBotHealth({
    query: { queryKey: getGetJournalBotHealthQueryKey(), refetchInterval: 10000, refetchOnMount: "always", staleTime: 5000 },
  });
  return <>
    <JournalHealthView data={q.data} isLoading={q.isLoading} hasError={Boolean(q.error)} isFetching={q.isFetching} now={now} onRetry={() => { void q.refetch(); }} />
    <SourceCommandStatus />
  </>;
}
