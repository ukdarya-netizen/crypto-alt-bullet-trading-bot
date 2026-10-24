import { getGetJournalOverviewQueryKey, useGetJournalOverview } from "@workspace/api-client-react";
import { Wallet } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/utils";

export default function PaperDepositBalance() {
  const { data, isLoading, error } = useGetJournalOverview({
    query: { queryKey: getGetJournalOverviewQueryKey(), refetchInterval: 15000 }
  });

  return (
    <Card className="paper-surface rounded-none border-primary/40 bg-card">
      <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div className="flex items-start gap-3">
          <div className="border border-primary/30 bg-primary/10 p-2 text-primary">
            <Wallet className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wider">Legacy-журнал · депозит симулятора</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Начальный депозит: {formatCurrency(data?.paperInitialDeposit ?? "100", "USD")}
            </p>
          </div>
        </div>
        <div className="sm:text-right" aria-live="polite">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Расчётный баланс</p>
          {isLoading ? (
            <Skeleton className="mt-2 h-9 w-36 sm:ml-auto" />
          ) : error || !data ? (
            <p className="mt-1 text-sm text-destructive">Баланс недоступен</p>
          ) : (
            <>
              <p className="mt-1 font-mono text-3xl font-bold tracking-tight">
                {formatCurrency(data.paperDepositBalance, "USD")}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Занято открытыми: {formatCurrency(data.paperReserved, "USD")} · Свободно: {formatCurrency(data.paperAvailable, "USD")}
              </p>
            </>
          )}
        </div>
        <p className="text-xs text-muted-foreground sm:max-w-48">
          Прежний бумажный учёт записанных сделок, не кошелёк активного Bullet PAPER-бота. Валовой результат без комиссий и открытого PnL; не биржевой баланс.
        </p>
      </CardContent>
    </Card>
  );
}