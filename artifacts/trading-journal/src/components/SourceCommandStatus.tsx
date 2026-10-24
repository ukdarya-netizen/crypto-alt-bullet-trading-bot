import { getGetJournalSourceCommandsQueryKey, useGetJournalSourceCommands } from "@workspace/api-client-react";
import { formatDate } from "@/lib/utils";

const statusLabels: Record<string, string> = {
  pending: "Ожидает исполнения", executed: "Исполнено", already_closed: "Уже закрыта",
  rejected: "Отклонено", superseded: "Заменено новой командой",
};
const actionLabels: Record<string, string> = {
  close: "Закрыть полностью", move_stop: "Переставить стоп", cancel_entry: "Отменить вход",
};

export function SourceCommandStatus() {
  const query = useGetJournalSourceCommands({
    query: { queryKey: getGetJournalSourceCommandsQueryKey(), refetchInterval: 10_000, staleTime: 5_000 },
  });
  return <section className="border border-border bg-card mt-5" data-testid="source-command-status">
    <div className="border-b border-border p-4">
      <h2 className="font-semibold">Команды сигнального бота</h2>
      <p className="text-sm text-muted-foreground mt-1">
        Получение команды не означает её исполнение. PAPER — симуляция, VST — подтверждение биржи.
      </p>
    </div>
    {query.isLoading ? <p className="p-4 text-sm">Загрузка команд…</p>
      : query.error ? <div className="p-4 text-sm" role="alert">
        Не удалось получить статусы. Это не означает, что команд нет.
        <button className="ml-3 underline" onClick={() => void query.refetch()}>Повторить</button>
      </div>
      : !query.data?.commands.length ? <p className="p-4 text-sm text-muted-foreground">
        Прямых команд пока не получено. Сверка GET продолжает работать отдельно.
      </p>
      : <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-border text-muted-foreground">
            <tr>{["Получено", "Инструмент / сигнал", "Команда", "Подтверждение"].map(label =>
              <th key={label} className="p-3 font-medium">{label}</th>)}</tr>
          </thead>
          <tbody>{query.data.commands.map(command => <tr key={command.commandId} className="border-b border-border last:border-0">
            <td className="p-3 whitespace-nowrap">{formatDate(command.receivedAt)}</td>
            <td className="p-3"><strong>{command.symbol}</strong><div className="text-muted-foreground">{command.sourceSignalId}</div></td>
            <td className="p-3">{actionLabels[command.type]}{command.stopPrice ? `: ${command.stopPrice}` : ""}
              <div className="text-muted-foreground break-all">{command.commandId} · #{command.sequence}</div>
            </td>
            <td className="p-3">{command.deliveries.map(delivery => <div key={delivery.mode} className="mb-1">
              <span className={delivery.status === "pending" || delivery.status === "rejected" ? "text-amber-300" : ""}>
                {delivery.mode.toUpperCase()}: {statusLabels[delivery.status]}
              </span>
              {delivery.lastError && <div className="text-muted-foreground break-all">{delivery.lastError}</div>}
              {delivery.attempts > 0 && <div className="text-muted-foreground">Попыток: {delivery.attempts}</div>}
            </div>)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
  </section>;
}
