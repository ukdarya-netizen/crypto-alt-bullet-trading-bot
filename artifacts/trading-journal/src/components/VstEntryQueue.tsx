import { AlertTriangle, RefreshCw } from "lucide-react";
import { getGetJournalVstEntryQueueQueryKey, useGetJournalVstEntryQueue } from "@workspace/api-client-react";
import type { JournalVstEntryQueueItem } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/utils";

const STAGE_LABELS: Record<string, string> = {
  queued: "В очереди", preparing: "Подготовка", prepared: "Подготовлен",
  executing: "Начата обработка входа", preparation_failed: "Подготовка не завершена",
};
const PHASE_LABELS: Record<string, string> = {
  "isolated-margin-mode": "Изолированная маржа",
  "isolated-leverage-10": "Плечо 10×",
  "market-entry": "Рыночный вход",
};
const INTENT_LABELS: Record<string, string> = {
  prepared: "намерение записано", submitted: "отправлено, ожидает проверки",
  unknown: "результат не подтверждён", reconciled: "результат проверен",
  failed: "не выполнено",
};
const REASON_LABELS: Record<string, string> = {
  batch_execution_budget_exceeded: "Исчерпано время пакета; продолжение на следующем проходе",
  prior_entry_attempt_stopped: "Предыдущий вход остановил пакет",
  entry_attempt_stopped: "Вход требует проверки перед продолжением",
  vst_entry_batch_execution_failed: "Ошибка обработки входа",
  entry_batch_planning_read_failed: "Не удалось прочитать данные для подготовки",
  source_exit_queue_unavailable: "Не удалось проверить очередь выходов",
  source_exit_priority_before_entry_batch_phase: "Сначала выполняются выходы",
  source_exit_priority_before_impulse_split: "Выход имеет приоритет перед разделением Impulse",
  vst_entry_batch_global_account_read_failed: "Не удалось проверить состояние счёта",
  vst_entry_batch_global_protection_not_verified: "Защита счёта не подтверждена",
  vst_entry_batch_available_margin_unverified_or_reserved: "Доступная маржа не подтверждена или зарезервирована",
  broker_interface_unavailable: "Подключение к бирже недоступно",
  capability_read_failed: "Не удалось проверить возможности биржи",
  wrong_exchange_environment: "Не подтверждена среда VST",
  capabilities_unverified: "Возможности биржи не подтверждены",
  protective_capabilities_missing: "Защитные операции недоступны",
  broker_interface_incomplete: "Подключение к бирже неполное",
  account_state_unverified: "Состояние счёта не подтверждено",
  account_state_not_verified: "Состояние счёта не подтверждено",
  verified_mutation_capabilities_unavailable: "Разрешение биржевых операций не подтверждено",
  isolated_margin_preparation_rejected: "Подготовка изолированной маржи отклонена",
  leverage_intent_requires_reconciliation: "Изменение плеча требует сверки",
  isolated_10x_not_confirmed: "Изолированное плечо 10× не подтверждено",
  entry_intent_requires_reconciliation: "Вход требует сверки",
  entry_result_not_verified: "Результат входа не подтверждён",
  entry_fill_unconfirmed: "Исполнение входа не подтверждено",
  entry_rejected_by_vst_venue: "Биржа VST отклонила вход",
  entry_or_post_fill_margin_state_not_verified: "Вход или маржа после входа не подтверждены",
  vst_margin_top_up_follow_up_prepared: "Требуется проверка добавления маржи",
  impulse_split_ledger_read_unavailable: "Не удалось прочитать состояние разделения Impulse",
  impulse_post_entry_split_state_unverified: "Разделение Impulse после входа не подтверждено",
  impulse_split_position_status_changed: "Состояние позиции Impulse изменилось",
  impulse_split_state_changed_between_verified_phases: "Состояние Impulse изменилось между этапами",
  impulse_core_split_pending: "Ожидается разделение основной части Impulse",
  not_a_fresh_approved_v2_long: "Сигнал не соответствует условиям свежего подтверждённого входа",
  invalid_canonical_vst_symbol: "Символ VST не прошёл проверку",
};
const known = (map: Record<string, string>, code: string) =>
  map[code] ?? `Неизвестный код: ${code}`;
function stageLabel(code: string): string {
  const [phase, state] = code.split(":");
  return PHASE_LABELS[phase] && INTENT_LABELS[state]
    ? `${PHASE_LABELS[phase]} · ${INTENT_LABELS[state]}`
    : known(STAGE_LABELS, code);
}
function ms(v: number | null): string {
  if (v === null || !Number.isFinite(v) || v < 0) return "Неизвестно";
  if (v < 1000) return `${Math.round(v)} мс`;
  const s = v / 1000;
  if (s < 60) return `${s.toFixed(1)} с`;
  const m = Math.floor(s / 60);
  return `${m} мин ${Math.round(s - m * 60)} с`;
}
function when(v: string | null): string {
  if (!v || !Number.isFinite(Date.parse(v))) return "Неизвестно";
  return formatDate(v);
}

function Row({ e, i }: { e: JournalVstEntryQueueItem; i: number }) {
  const cells: [string, string][] = [
    ["Получен", when(e.receivedAt)], ["Ожидание в очереди", ms(e.queueWaitMs)],
    ["Подготовка (последняя)", ms(e.prepareMs)], ["Попытка входа (последняя)", ms(e.executeMs)],
  ];
  return (
    <article className="position-book-row px-4 py-4 sm:px-5" data-testid={`card-vst-queue-${i}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-all font-mono text-base font-bold" data-testid={`text-vst-queue-symbol-${i}`}>{e.symbol ?? "Неизвестно"}</h3>
          <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{e.sourceSignalId}</p>
        </div>
        <div className="sm:text-right">
          <span className="border border-border px-1.5 py-0.5 font-mono text-[10px] font-bold" data-testid={`badge-vst-queue-stage-${i}`}>{stageLabel(e.stage)}</span>
          <p className="mt-1 text-xs text-muted-foreground">Зафиксировано: {when(e.stageConfirmedAt)}</p>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-3 border-t border-border/70 pt-3 sm:grid-cols-4">
        {cells.map(([l, v]) => <div key={l} className="min-w-0"><p className="position-book-label">{l}</p><p className="position-book-value mt-1" data-testid={`value-vst-queue-${l}-${i}`}>{v}</p></div>)}
      </div>
      {e.deferReason && (
        <p className="mt-3 text-xs text-muted-foreground" data-testid={`text-vst-queue-defer-${i}`}>
          Причина отсрочки: <span className="font-semibold text-foreground">{known(REASON_LABELS, e.deferReason)}</span>
        </p>
      )}
    </article>
  );
}

export function VstEntryQueue() {
  const q = useGetJournalVstEntryQueue({ query: { queryKey: getGetJournalVstEntryQueueQueryKey(), refetchInterval: 10000 } });
  const { data, isLoading, error, refetch, isFetching } = q;
  const retry = <button type="button" onClick={() => { void refetch(); }} className="mt-3 inline-flex items-center gap-2 border border-border px-3 py-2 text-xs font-bold uppercase hover:bg-secondary" data-testid="button-retry-vst-queue"><RefreshCw className="h-3.5 w-3.5" /> Повторить</button>;
  return (
    <section className="position-book" data-testid="section-vst-entry-queue">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
        <h2 className="text-sm font-bold uppercase tracking-wider">Очередь входов бота {data && <span className="ml-1 font-mono text-muted-foreground">{data.total}</span>}</h2>
        {data && <span className="text-xs text-muted-foreground" data-testid="text-vst-queue-asof">Состояние на {when(data.asOf)}{isFetching ? " · обновление" : ""}</span>}
      </div>
      <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground sm:px-5" data-testid="note-vst-queue">
        Это принятые ботом сигналы, а не карточки ACTIVE источника и не позиции биржи. Тайминги — измерения бота, не подтверждение исполнения на бирже. Выходы обрабатываются раньше входов.
      </p>
      {isLoading ? (
        <div className="space-y-3 border-t border-border p-5" role="status" data-testid="status-vst-queue-loading"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
      ) : !data ? (
        <div className="border-t border-border p-5" role="alert" data-testid="status-vst-queue-error">
          <p className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4 text-destructive" /> Очередь не удалось загрузить. Это не значит, что она пуста.</p>{retry}
        </div>
      ) : (
        <>
          {error && (
            <div className="border-t border-border bg-destructive/10 px-4 py-2 text-xs sm:px-5" role="alert" data-testid="status-vst-queue-stale">
              Не удалось обновить очередь — показаны данные на {when(data.asOf)}; они могли устареть. {retry}
            </div>
          )}
          {data.entries.length === 0 ? (
            <div className="border-t border-border px-5 py-10 text-center" data-testid="empty-vst-queue">
              <p className="font-medium">{data.total === 0 ? "В очереди входов сейчас ничего нет" : `Список пуст, но всего в очереди ${data.total}`}</p>
            </div>
          ) : data.entries.map((e, i) => <Row key={`${e.sourceSignalId}-${i}`} e={e} i={i} />)}
          {(data.hasMore || data.total > data.entries.length) && (
            <p className="border-t border-border px-4 py-2 text-xs font-semibold sm:px-5" data-testid="note-vst-queue-truncated">
              Показаны первые {data.entries.length} из {data.total}. Остальные записи не отображаются.
            </p>
          )}
        </>
      )}
    </section>
  );
}
