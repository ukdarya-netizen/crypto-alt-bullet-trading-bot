import type { JournalVstReviewPreRunnerCloseHistoryItem } from "@workspace/api-client-react";
import { formatDate } from "@/lib/utils";

export function PreRunnerCloseHistory({ items }: {
  items: JournalVstReviewPreRunnerCloseHistoryItem[];
}) {
  return (
    <section id="runner-close-history" className="space-y-3" data-testid="runner-close-history">
      <h2 className="text-sm font-bold uppercase tracking-wide">История решений по старым закрытиям runner</h2>
      <p className="text-xs text-muted-foreground">
        Сохранённые проверки владельца, новые сверху. Это не текущий статус BingX.
        Решение владельца и снятие неопределённости в журнале не доказывают, что исходный POST
        на биржу не отправлялся. Просмотр истории не отправляет и не отменяет заявки.
      </p>
      {items.length === 0 && (
        <p className="border border-border bg-card p-4 text-sm text-muted-foreground" data-testid="runner-close-history-empty">
          Сохранённых решений пока нет.
        </p>
      )}
      {items.map((item) => {
        const original = item.originalOutcome;
        const error = [original?.reason, original?.error, original?.errorMessage].filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        ).join(" / ");
        const observedAt = item.evidence.observedAt;
        const coverage = Array.isArray(item.evidence.coverage) ? item.evidence.coverage : [];
        return (
          <article key={item.clientOrderId} className="border border-border bg-card p-4"
            data-testid={`runner-close-history-${item.clientOrderId}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">{item.symbol}</h3>
              <span className="text-xs font-semibold">
                {item.outcome === "closed" ? "Закрытие подтверждено" : "Позиция оставалась открытой"}
              </span>
            </div>
            <dl className="mt-3 grid gap-2 text-xs">
              <div><dt className="text-muted-foreground">Дата решения</dt><dd>{formatDate(item.checkedAt)}</dd></div>
              <div><dt className="text-muted-foreground">Владелец</dt><dd className="break-all">{item.resolvedBy}</dd></div>
              <div><dt className="text-muted-foreground">Исходная попытка</dt><dd>{formatDate(item.timestamp)}</dd></div>
              <div><dt className="text-muted-foreground">Исходная ошибка</dt><dd className="break-all">{error || "Текст ошибки не сохранён — см. исходный результат ниже."}</dd></div>
              <div><dt className="text-muted-foreground">Наблюдение биржи</dt><dd>{typeof observedAt === "string" ? formatDate(observedAt) : "Время не указано"}</dd></div>
              <div><dt className="text-muted-foreground">Сигнал / заявка</dt><dd className="break-all">{item.sourceSignalId} / {item.clientOrderId}</dd></div>
              {item.note && <div><dt className="text-muted-foreground">Примечание владельца</dt><dd className="whitespace-pre-wrap break-words">{item.note}</dd></div>}
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">
              {item.outcome === "open"
                ? "Граница доказательств: на момент проверки подтверждены сохранённые количество позиции и собственные стопы. Это не подтверждение отсутствия прежней отправки заявки и не гарантия, что позиция открыта сейчас."
                : "Граница доказательств: закрытие принято по сохранённым исполнениям и проверке отсутствия позиции и открытых заявок. Полнота истории относится только к проверенному окну и условиям в доказательствах ниже; за их пределами ничего не утверждается."}
            </p>
            {item.outcome === "closed" && (
              <div className="mt-2 text-xs text-muted-foreground">
                <p className="font-semibold">Проверенные окна истории исполнений</p>
                {coverage.length === 0 && <p>Границы окна не сохранены; более широкий период не подтверждён.</p>}
                {coverage.map((window, index) => {
                  const row = typeof window === "object" && window !== null
                    ? window as Record<string, unknown> : {};
                  const date = (value: unknown) => typeof value === "number" && Number.isFinite(value) &&
                    Math.abs(value) <= 8.64e15 ? formatDate(new Date(value).toISOString()) : "не указано";
                  return (
                    <p key={index}>
                      {date(row.startTs)} — {date(row.endTs)};
                      {" "}записей: {typeof row.rawCount === "number" ? row.rawCount : "не указано"};
                      {" "}проверено: {row.verified === true ? "да" : "не подтверждено"}.
                    </p>
                  );
                })}
              </div>
            )}
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer font-semibold">Исходный результат и сохранённые доказательства (границы, исполнения, стопы)</summary>
              <p className="mt-2 text-muted-foreground">Отсутствующие поля и границы не восстанавливаются из текущих данных.</p>
              <h4 className="mt-2 font-semibold">Исходный результат</h4>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(item.originalOutcome, null, 2)}</pre>
              <h4 className="mt-2 font-semibold">Доказательства на дату решения</h4>
              <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(item.evidence, null, 2)}</pre>
            </details>
          </article>
        );
      })}
    </section>
  );
}