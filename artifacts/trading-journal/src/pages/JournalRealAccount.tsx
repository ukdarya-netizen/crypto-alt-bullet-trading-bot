import { BingxAccountPositions } from "@/components/bingx-account-positions";
import { BingxApiIndicator } from "@/components/bingx-api-indicator";
import { HistoricalCascadePreparation } from "@/components/historical-cascade-preparation";

export default function JournalRealAccount() {
  return (
    <section className="page-frame mx-auto max-w-6xl space-y-5" aria-label="Реальный счёт BingX" data-testid="page-real-account">
      <BingxApiIndicator />
      <div className="paper-surface border-b border-border pb-4">
        <p className="font-mono text-[10px] uppercase tracking-[.22em] text-amber-300">BingX / mainnet / account-wide</p>
        <h1 className="mt-1 text-xl font-bold uppercase tracking-tight">Реальный счёт BingX</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Баланс и позиции всего подключённого счёта. Отдельно от PAPER; данные обновляются автоматически.
        </p>
        <div className="mt-4 border-l-2 border-amber-500/60 bg-amber-500/[.04] px-3 py-2 text-xs text-muted-foreground" role="status" data-testid="real-exit-plan-status">
          <span className="font-semibold text-amber-300">План REAL, не биржевое исполнение.</span>{" "}
          Для Balanced Grind и Liquidation Cascade предусмотрены 25% на +5%, 25% на +10% и остаток на +15% цены.
          Для Impulse Buy — 25% на +5%, 25% на +10%, затем защитный трейлинг core и отдельного runner.
          Для Price-Led Momentum — защита и трейлинг без автоматического частичного тейка.
          Реальные частичные выходы и перенос стопов пока заблокированы: сохранение защиты остатка не подтверждено на BingX.
          Позиции счёта ниже не привязаны к сигналам бота.
        </div>
      </div>
      <HistoricalCascadePreparation />
      <BingxAccountPositions />
    </section>
  );
}