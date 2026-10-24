import { getJournalBot } from "@workspace/api-client-react";
import { ArrowDownRight, ArrowUpRight, RefreshCw, Wallet } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, formatNumber } from "@/lib/utils";

type Bot = Awaited<ReturnType<typeof getJournalBot>>;
type PaperEquityWalletProps = {
  account: Bot["paperAccount"];
  equity: Bot["paperEquity"];
  now: number;
  isRefreshing: boolean;
  onRefresh: () => void;
};

function SignedValue({ value, testId }: { value: string | null; testId: string }) {
  const amount = value === null ? null : Number(value);
  const valid = amount !== null && Number.isFinite(amount);
  return (
    <span
      data-testid={testId}
      className={`font-mono font-semibold tabular-nums ${
        valid && amount > 0 ? "text-success" : valid && amount < 0 ? "text-destructive" : "text-foreground"
      }`}
    >
      {valid ? `${amount > 0 ? "+" : ""}${formatNumber(amount, 2)} USDT` : "—"}
    </span>
  );
}

function WalletValue({ label, value }: { label: string; value: number }) {
  const positive = label === "Реализованный PnL" && value > 0;
  const negative = label === "Реализованный PnL" && value < 0;
  return (
    <div data-testid={`wallet-value-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-1 font-mono text-lg font-semibold tabular-nums ${positive ? "text-success" : negative ? "text-destructive" : ""}`}>
        {positive && <ArrowUpRight className="mr-1 inline h-3 w-3" aria-hidden="true" />}
        {negative && <ArrowDownRight className="mr-1 inline h-3 w-3" aria-hidden="true" />}
        {formatNumber(value, 2)} USDT
      </p>
    </div>
  );
}

export function PaperEquityWallet({
  account, equity, now, isRefreshing, onRefresh,
}: PaperEquityWalletProps) {
  const oldestQuoteTime = equity.oldestQuoteAt ? Date.parse(equity.oldestQuoteAt) : NaN;
  const hasFreshQuote = equity.quoteStatus === "fresh" &&
    Number.isFinite(oldestQuoteTime) &&
    now - oldestQuoteTime >= -5_000 && now - oldestQuoteTime <= 90_000;
  const quotesUsable = equity.quoteStatus === "no_position" || hasFreshQuote;
  const confirmed = quotesUsable && equity.fundingStatus === "current" &&
    equity.equityUsdt !== null && Number.isFinite(Number(equity.equityUsdt));
  const provisional = quotesUsable && equity.fundingStatus === "incomplete" &&
    equity.provisionalEquityUsdt !== null && Number.isFinite(Number(equity.provisionalEquityUsdt));
  const shownEquity = confirmed ? equity.equityUsdt : provisional ? equity.provisionalEquityUsdt : null;
  const shownChange = confirmed ? equity.changeUsdt : provisional ? equity.provisionalChangeUsdt : null;
  const shownChangePercent = confirmed ? equity.changePercent : provisional ? equity.provisionalChangePercent : null;
  const shownOpenPnl = confirmed ? equity.unrealizedPnlUsdt : provisional ? equity.provisionalUnrealizedPnlUsdt : null;
  const quoteMessage = provisional
    ? "Предварительная оценка · funding не полностью сверен"
    : confirmed && equity.quoteStatus === "no_position"
      ? "Нет открытых позиций · учтён результат закрытых PAPER-сделок"
      : confirmed
        ? `По свежим котировкам BingX (mark/last) · самая ранняя ${formatDate(equity.oldestQuoteAt!)}`
        : equity.quoteStatus === "unavailable"
          ? "Нет достоверной цены для всех открытых позиций; стоимость счёта с открытым PnL неизвестна"
          : equity.quoteStatus === "stale" || !hasFreshQuote
            ? "Котировка устарела; стоимость счёта с открытым PnL неизвестна"
            : "Оценка недоступна";

  return (
    <Card className="paper-surface overflow-hidden rounded-none border-primary/40" data-testid="section-paper-wallet">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 border-b border-primary/20 pb-3">
        <CardTitle className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <Wallet className="h-4 w-4 text-primary" aria-hidden="true" />
          Кошелёк PAPER · USDT
        </CardTitle>
        <button
          type="button"
          onClick={onRefresh}
          disabled={isRefreshing}
          className="inline-flex items-center gap-1.5 border border-border bg-secondary/50 px-2.5 py-1 font-mono text-[11px] text-foreground transition-colors hover:border-primary/50 hover:text-primary disabled:cursor-wait disabled:opacity-50"
          aria-label="Обновить оценку PAPER-счёта"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} aria-hidden="true" />
          {isRefreshing ? "Обновление…" : "Обновить"}
        </button>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <div className="min-w-0 border border-primary/35 bg-primary/[.055] p-4">
            <p className="font-mono text-[10px] uppercase tracking-[.15em] text-primary">
              {provisional ? "Предварительная стоимость PAPER-счёта" : "Текущая оценка PAPER-счёта"}
            </p>
            <p
              className="mt-2 font-mono text-3xl font-bold tracking-tight tabular-nums sm:text-4xl"
              data-testid="wallet-current-equity"
              aria-live="polite"
            >
              {shownEquity !== null ? `${formatNumber(Number(shownEquity), 2)} USDT` : "—"}
            </p>
            <p className={`mt-2 text-xs ${confirmed ? "text-muted-foreground" : "text-amber-300"}`}
              data-testid="wallet-equity-status">
              {quoteMessage}
            </p>
            <div className="mt-4 border-t border-primary/20 pt-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Баланс PAPER-кошелька · без открытого PnL</p>
              <p className="mt-1 font-mono text-lg font-semibold tabular-nums" data-testid="wallet-cash-balance">
                {Number.isFinite(Number(equity.walletUsdt))
                  ? `${formatNumber(Number(equity.walletUsdt), 2)} USDT`
                  : "—"}
              </p>
              <p className="mt-1 text-[10px] text-muted-foreground">Свободно + зарезервировано; перевод маржи между ними не меняет этот баланс.</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="border border-border p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Изменение от старта</p>
              <p className="mt-2 text-base sm:text-lg">
                <SignedValue value={shownChange} testId="wallet-equity-change" />
              </p>
              <p className="mt-1 font-mono text-xs text-muted-foreground" data-testid="wallet-equity-percent">
                {shownChangePercent !== null && Number.isFinite(Number(shownChangePercent))
                  ? `${Number(shownChangePercent) > 0 ? "+" : ""}${formatNumber(Number(shownChangePercent), 2)}%`
                  : "—"}
              </p>
            </div>
            <div className="border border-border p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Открытый результат</p>
              <p className="mt-2 text-base sm:text-lg">
                <SignedValue value={shownOpenPnl} testId="wallet-open-pnl" />
              </p>
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                {equity.quoteStatus === "no_position" ? "Нет открытых позиций" : "Нереализованный PnL · до будущего закрытия"}
              </p>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-4">
          <WalletValue label="Начальный" value={account.initialUsdt} />
          <WalletValue label="Доступно" value={account.freeUsdt} />
          <WalletValue label="Зарезервировано" value={account.reservedUsdt} />
          <WalletValue label="Реализованный PnL" value={account.realizedPnlUsdt} />
        </div>
        <p className="text-[11px] text-muted-foreground">PAPER — симуляция, не баланс BingX.</p>
      </CardContent>
    </Card>
  );
}
