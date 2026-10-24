import { useQueryClient } from "@tanstack/react-query";
import {
  getGetJournalHistoricalCascadeSelectionQueryKey,
  getListJournalHistoricalCascadeCandidatesQueryKey,
  useCancelJournalHistoricalCascadeSelection,
  useGetJournalHistoricalCascadeSelection,
  useListJournalHistoricalCascadeCandidates,
  useSelectJournalHistoricalCascadeCandidate,
} from "@workspace/api-client-react";
import type { HistoricalCascadeSelection } from "@workspace/api-client-react";
import { AlertTriangle, Clock3, History, LockKeyhole } from "lucide-react";
import { formatDate } from "@/lib/utils";

const stateLabels: Record<HistoricalCascadeSelection["state"], string> = {
  disarmed: "Не выбрано",
  claimed: "Подготовка заявлена",
  cancelled: "Подготовка отменена",
  entry_intent_reserved: "Намерение входа зарезервировано",
  attempted: "Попытка отмечена",
};

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === "object" && "message" in data &&
        typeof (data as { message?: unknown }).message === "string") {
      return (data as { message: string }).message;
    }
  }
  return fallback;
}

function observedTime(value: string | null): string {
  return value && Number.isFinite(Date.parse(value)) ? formatDate(value) : "не указано";
}

export function HistoricalCascadePreparation() {
  const queryClient = useQueryClient();
  const selectionKey = getGetJournalHistoricalCascadeSelectionQueryKey();
  const candidatesKey = getListJournalHistoricalCascadeCandidatesQueryKey();
  const selection = useGetJournalHistoricalCascadeSelection({
    query: { queryKey: selectionKey, refetchOnMount: "always", refetchInterval: 15000 },
  });
  const candidates = useListJournalHistoricalCascadeCandidates({
    query: { queryKey: candidatesKey, refetchOnMount: "always", refetchInterval: 60000 },
  });
  const selectCandidate = useSelectJournalHistoricalCascadeCandidate({
    mutation: {
      onSuccess: async (next) => {
        queryClient.setQueryData(selectionKey, next);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: selectionKey }),
          queryClient.invalidateQueries({ queryKey: candidatesKey }),
        ]);
      },
    },
  });
  const cancelSelection = useCancelJournalHistoricalCascadeSelection({
    mutation: {
      onSuccess: async (next) => {
        queryClient.setQueryData(selectionKey, next);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: selectionKey }),
          queryClient.invalidateQueries({ queryKey: candidatesKey }),
        ]);
      },
    },
  });

  const current = selection.data;
  const canSelect = current?.state === "disarmed";
  const busy = selectCandidate.isPending || cancelSelection.isPending;
  const handleSelect = (sourceSignalId: string, symbol: string) => {
    if (!window.confirm(
      `Подтвердите одноразовую подготовку исторического сигнала ${sourceSignalId} (${symbol}). Это только durable claim; реальный ордер не будет отправлен.`,
    )) return;
    selectCandidate.mutate({ data: { sourceSignalId } });
  };
  const handleCancel = () => {
    if (!window.confirm("Отменить заявленную подготовку? После резервирования намерения входа отмена недоступна.")) return;
    cancelSelection.mutate();
  };

  return (
    <section
      className="paper-surface overflow-hidden border border-primary/30 bg-card"
      aria-label="Подготовка исторического Liquidation Cascade"
      data-testid="section-historical-cascade-preparation"
    >
      <div className="border-b border-primary/20 bg-primary/[.04] px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[.18em] text-primary">
              <History className="h-3.5 w-3.5" aria-hidden="true" />
              Историческая подготовка · ограниченный выбор
            </p>
            <h2 className="mt-1 text-base font-bold uppercase tracking-wide">Liquidation Cascade · исторический сигнал</h2>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
              Выбор только закрепляет один подходящий исторический PAPER-сигнал для подготовки. Это не live trade: реальный ордер не отправляется, кнопки запуска нет. Тейки, БУ, трейлинг, маржа и аварийный выход требуют отдельной проверки на бирже до включения REAL.
            </p>
          </div>
          <span className="flex items-center gap-1.5 border border-primary/30 bg-background/60 px-2 py-1 font-mono text-[10px] font-bold uppercase text-primary" data-testid="badge-historical-cascade-preparation-only">
            <LockKeyhole className="h-3 w-3" aria-hidden="true" />
            Только подготовка
          </span>
        </div>
      </div>

      {selection.isLoading ? (
        <div className="px-4 py-4 text-xs text-muted-foreground" role="status" data-testid="status-historical-cascade-selection-loading">
          Загрузка сохранённого состояния…
        </div>
      ) : selection.error || !current ? (
        <div className="flex gap-2 px-4 py-4 text-xs text-destructive" role="alert" data-testid="status-historical-cascade-selection-error">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{errorMessage(selection.error, "Не удалось получить durable состояние выбора. Выбор и отмена сейчас недоступны.")}</span>
        </div>
      ) : (
        <div className="border-b border-border px-4 py-3 sm:px-5" data-testid="status-historical-cascade-selection">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold">
              Состояние: <span className={current.state === "claimed" ? "text-amber-300" : "text-foreground"}>{stateLabels[current.state] ?? current.state}</span>
            </p>
            <p className="font-mono text-[10px] text-muted-foreground">
              Лимит: {current.totalMarginUsdt} USDT · {current.marginMode}
            </p>
          </div>
          {current.sourceSignalId && (
            <p className="mt-1 break-all font-mono text-xs" data-testid="text-historical-cascade-selected-source">
              {current.sourceSignalId}{current.symbol ? ` · ${current.symbol}` : ""}
            </p>
          )}
          <p className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground" data-testid="text-historical-cascade-selection-updated">
            <Clock3 className="h-3 w-3" aria-hidden="true" />
            Обновлено: {observedTime(current.updatedAt)}{current.selectedAt ? ` · выбрано: ${observedTime(current.selectedAt)}` : ""}
            {current.cancelledAt ? ` · отменено: ${observedTime(current.cancelledAt)}` : ""}
          </p>
          {current.state === "claimed" && (
            <button
              type="button"
              disabled={busy}
              onClick={handleCancel}
              data-testid="button-cancel-historical-cascade-selection"
              className="mt-3 min-h-10 border border-border px-3 py-2 text-xs font-semibold hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {cancelSelection.isPending ? "Отмена…" : "Отменить заявленную подготовку"}
            </button>
          )}
        </div>
      )}

      {(selectCandidate.error || cancelSelection.error) && (
        <p className="border-b border-destructive/25 bg-destructive/[.04] px-4 py-3 text-xs text-destructive" role="alert" data-testid="status-historical-cascade-mutation-error">
          {errorMessage(selectCandidate.error ?? cancelSelection.error, "Не удалось изменить выбор. Обновите состояние и повторите попытку.")}
        </p>
      )}

      <div className="px-4 py-4 sm:px-5">
        <h3 className="text-xs font-bold uppercase tracking-wider">Кандидаты из истории PAPER</h3>
        {candidates.isLoading ? (
          <p className="mt-2 text-xs text-muted-foreground" role="status" data-testid="status-historical-cascade-candidates-loading">Загрузка исторических кандидатов…</p>
        ) : candidates.error || !candidates.data ? (
          <p className="mt-2 text-xs text-destructive" role="alert" data-testid="status-historical-cascade-candidates-error">
            {errorMessage(candidates.error, "Не удалось загрузить кандидатов. Исторические записи сейчас недоступны.")}
          </p>
        ) : candidates.data.candidates.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground" role="status" data-testid="empty-historical-cascade-candidates">
            Подходящих исторических PAPER-сигналов нет.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-border border-y border-border">
            {candidates.data.candidates.map((candidate) => (
              <li key={candidate.sourceSignalId} className="flex flex-wrap items-center justify-between gap-3 py-3" data-testid={`row-historical-cascade-candidate-${candidate.sourceSignalId}`}>
                <div className="min-w-0">
                  <p className="break-all font-mono text-xs font-semibold">{candidate.sourceSignalId} · {candidate.symbol}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    PAPER: {candidate.historicalPaperOutcome === "closed" ? "закрыта" : "отклонён по свободному PAPER-балансу"}
                    {" · "}{observedTime(candidate.signalAt)}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={!canSelect || busy || selection.isLoading || Boolean(selection.error)}
                  onClick={() => handleSelect(candidate.sourceSignalId, candidate.symbol)}
                  data-testid={`button-select-historical-cascade-${candidate.sourceSignalId}`}
                  className="min-h-10 shrink-0 border border-primary/40 px-3 py-2 text-xs font-semibold text-primary hover:bg-primary/[.08] disabled:cursor-not-allowed disabled:border-border disabled:text-muted-foreground disabled:opacity-60"
                >
                  {selectCandidate.isPending && selectCandidate.variables?.data.sourceSignalId === candidate.sourceSignalId
                    ? "Сохраняю…" : "Выбрать для подготовки"}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
          Одноразовое durable-состояние сохраняется на сервере и показывается после перезагрузки. Отмена доступна только в состоянии «заявлена»; выбор не запускает сделку и не подтверждает возможность безопасного исполнения.
        </p>
      </div>
    </section>
  );
}