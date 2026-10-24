import { useListTradingSignals, getListTradingSignalsQueryKey } from "@workspace/api-client-react";
import { formatDate, formatNumber } from "@/lib/utils";
import { useState } from "react";

const pageSize = 20;

const statusLabels: Record<string, string> = {
  awaiting_rules: "Ожидает правил",
  pending: "В очереди",
  processing: "Обрабатывается",
  executed: "Бумажный ордер создан",
  rejected: "Отклонён",
  failed: "Ошибка",
};

const reasonLabels: Record<string, string> = {
  PAPER_PATTERN_UNSUPPORTED: "Шаблон сигнала не поддерживается",
  PAPER_MODE_INACTIVE: "Бумажный режим выключен",
  PAPER_ENTRIES_PAUSED: "Открытие новых позиций приостановлено",
  PAPER_SIGNAL_OUTSIDE_WINDOW: "Сигнал вне допустимого временного окна",
  PAPER_INTENT_UNREPRESENTABLE: "Сигнал нельзя представить как бумажный ордер",
  PAPER_INSUFFICIENT_FUNDS: "Недостаточно средств для открытия позиции",
};

export default function SignalInbox() {
  const [page, setPage] = useState(0);
  const params = { limit: pageSize, offset: page * pageSize };
  const { data, isLoading, error } = useListTradingSignals(params, {
    query: {
      queryKey: getListTradingSignalsQueryKey(params),
      refetchInterval: 15000,
    },
  });

  return (
    <section className="border border-border bg-card" aria-label="Полученные сигналы">
      <div className="border-b border-border p-4 sm:p-5">
        <h2 className="text-lg font-bold">Полученные и неоткрытые сигналы</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          При нехватке средств сигнал сохраняется как неоткрытый. После закрытия позиции старые сигналы не исполняются повторно.
        </p>
      </div>
      {isLoading ? (
        <p className="p-5 text-sm text-muted-foreground">Загрузка сигналов…</p>
      ) : error ? (
        <p className="p-5 text-sm text-destructive">Не удалось загрузить сигналы.</p>
      ) : !data?.signals.length && page === 0 ? (
        <p className="p-5 text-sm text-muted-foreground">Подтверждённых сигналов пока нет.</p>
      ) : (
        <>
          <div className="divide-y divide-border">
          {data?.signals.map((signal) => (
            <div key={signal.id} className="flex flex-wrap items-start justify-between gap-2 p-4 sm:px-5">
              <div className="min-w-0">
                <div className="font-semibold">{signal.symbol}</div>
                <div className="break-all text-xs text-muted-foreground">
                  {signal.sourceSignalId} · {formatDate(signal.signalAt ?? signal.createdAt)}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {signal.patternId?.replaceAll("_", " ") ?? "Без паттерна"}
                  {signal.referencePrice ? ` · цена сигнала ${formatNumber(signal.referencePrice, 4)}` : ""}
                </div>
                {signal.patternId === "owner_manual_close" && (
                  <p className="mt-1 text-xs text-muted-foreground">Ручное закрытие бумажной позиции</p>
                )}
                {signal.errorCode && (
                  <p className="mt-2 max-w-2xl text-xs text-muted-foreground" role="status">
                    {reasonLabels[signal.errorCode] ?? "Не удалось обработать сигнал. Подробности недоступны."}
                  </p>
                )}
              </div>
              <span className="border border-border bg-secondary px-2 py-1 text-xs font-medium">
                {signal.patternId === "owner_manual_close" ? "Ручное закрытие PAPER"
                  : signal.errorCode === "PAPER_INSUFFICIENT_FUNDS"
                  ? "Не открыта · недостаточно средств"
                  : statusLabels[signal.status] ?? "Статус сигнала обновлён"}
              </span>
            </div>
          ))}
          </div>
          <div className="flex items-center justify-between gap-4 border-t border-border p-4 text-xs">
            <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)}
              className="disabled:opacity-40 hover:underline">Новые</button>
            <span>Страница {page + 1}</span>
            <button type="button" disabled={!data?.hasMore} onClick={() => setPage((p) => p + 1)}
              className="disabled:opacity-40 hover:underline">Ранее</button>
          </div>
        </>
      )}
    </section>
  );
}