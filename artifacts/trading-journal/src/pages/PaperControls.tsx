import { useQueryClient } from "@tanstack/react-query";
import {
  getGetTradingStatusQueryKey,
  useGetTradingStatus,
  useStartPaperTrading,
  useStopPaperTrading,
} from "@workspace/api-client-react";

export default function PaperControls() {
  const queryClient = useQueryClient();
  const queryKey = getGetTradingStatusQueryKey();
  const { data: status, isLoading, error } = useGetTradingStatus({
    query: { queryKey, refetchInterval: 10000 },
  });
  const start = useStartPaperTrading({
    mutation: { onSuccess: (next) => queryClient.setQueryData(queryKey, next) },
  });
  const stop = useStopPaperTrading({
    mutation: { onSuccess: (next) => queryClient.setQueryData(queryKey, next) },
  });
  const active = status?.mode === "paper" && status.acceptingNewEntries && !status.killSwitchActive;
  const busy = start.isPending || stop.isPending;

  return (
    <section className="border border-border bg-card p-4 sm:p-5" aria-label="Бумажная торговля">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold">Бумажные сделки · только LONG</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Только подтверждённые сигналы Bullet с полным планом: 10 USDT начальной маржи при 10×, размер и стоп — из сигнала.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            PAPER поддерживает четыре паттерна: Liquidation Cascade, Impulse Buy, Price Led Momentum и Balanced Grind. Нужны свежий сигнал с полным поддерживаемым планом и разрешение владельца; биржевые ордера не отправляются.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Приостановка отменит ещё не исполненные бумажные входы; при повторном включении они не возобновятся.
          </p>
        </div>
        {status?.mode === "paper" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => active ? stop.mutate() : start.mutate()}
            className={`min-h-11 px-4 text-sm font-semibold disabled:opacity-50 ${active
              ? "border border-border bg-background text-foreground"
              : "bg-primary text-primary-foreground"}`}
          >
            {busy ? "Сохраняю…" : active ? "Приостановить" : "Включить бумажные сделки"}
          </button>
        )}
      </div>
      {isLoading ? (
        <p className="mt-3 text-xs text-muted-foreground">Проверка режима…</p>
      ) : error ? (
        <p className="mt-3 text-xs text-destructive">Не удалось проверить режим торговли.</p>
      ) : status?.mode !== "paper" ? (
        <p className="mt-3 text-xs text-destructive">Режим testnet: бумажные сделки недоступны.</p>
      ) : (
        <p className="mt-3 text-xs font-medium">
          {active ? "Режим включён: PAPER-вход разрешён для четырёх паттернов при совпадении формата сигнала." : "Бумажные входы выключены. Старые сигналы не исполняются."}
        </p>
      )}
      {(start.isError || stop.isError) && (
        <p className="mt-2 text-xs text-destructive">Не удалось изменить режим. Попробуйте ещё раз.</p>
      )}
    </section>
  );
}