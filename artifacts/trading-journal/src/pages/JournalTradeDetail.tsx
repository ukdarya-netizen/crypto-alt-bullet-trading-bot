import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, Link } from "wouter";
import { 
  useGetJournalTrade, 
  useClosePaperTrade,
  useUpdateJournalTradeNotes, 
  getGetJournalTradeQueryKey,
  getListJournalTradesQueryKey,
  getGetJournalOverviewQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Save, Loader2, Edit3 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatNumber, formatDate } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/error-state";

export default function JournalTradeDetail() {
  const params = useParams();
  const id = params.id as string;
  const queryClient = useQueryClient();
  
  const { data: trade, isLoading, error } = useGetJournalTrade(id, {
    query: { queryKey: getGetJournalTradeQueryKey(id), refetchInterval: 15000 }
  });

  const updateNotes = useUpdateJournalTradeNotes();
  const closePaper = useClosePaperTrade();

  const [notes, setNotes] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const initializedForId = useRef<string | null>(null);
  const closeRequestId = useRef<string | null>(null);
  const [showPaperClose, setShowPaperClose] = useState(false);
  const [exitPrice, setExitPrice] = useState("");
  const [closeError, setCloseError] = useState("");

  useEffect(() => {
    if (trade && initializedForId.current !== id) {
      initializedForId.current = id;
      setNotes(trade.notes || "");
      setTagsInput((trade.tags || []).join(", "));
    }
  }, [trade, id]);

  const mutateFnRef = useRef(updateNotes.mutate);
  mutateFnRef.current = updateNotes.mutate;

  const handleSave = useCallback(() => {
    setSaveMessage("");
    const tagsArray = tagsInput.split(",")
      .map(t => t.trim())
      .filter(t => t.length > 0)
      .filter((tag, index, all) => all.indexOf(tag) === index);
    if (notes.length > 5000 || tagsArray.length > 8 || tagsArray.some(tag => tag.length > 32)) {
      setSaveMessage("Заметка: максимум 5000 символов, до 8 тегов по 32 символа.");
      return;
    }

    mutateFnRef.current({
      id,
      data: { notes, tags: tagsArray }
    }, {
      onSuccess: (updatedTrade) => {
        // In-place cache update for this trade
        queryClient.setQueryData(getGetJournalTradeQueryKey(id), updatedTrade);
        // Invalidate lists and overview as requested
        queryClient.invalidateQueries({ queryKey: getListJournalTradesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetJournalOverviewQueryKey() });
        setSaveMessage("Сохранено");
      },
      onError: () => setSaveMessage("Не удалось сохранить заметку. Повторите попытку.")
    });
  }, [id, notes, tagsInput, queryClient]);

  const handlePaperClose = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,12})?$/.test(exitPrice) ||
        Number(exitPrice) <= 0) {
      setCloseError("Введите положительную цену симулированного закрытия.");
      return;
    }
    setCloseError("");
    closeRequestId.current ??= crypto.randomUUID();
    closePaper.mutate({
      id, data: { exitPrice, requestId: closeRequestId.current },
    }, {
      onSuccess: (updated) => {
        queryClient.setQueryData(getGetJournalTradeQueryKey(id), updated);
        queryClient.invalidateQueries({ queryKey: getListJournalTradesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetJournalOverviewQueryKey() });
        setShowPaperClose(false);
        setExitPrice("");
        closeRequestId.current = null;
      },
      onError: () => {
        setCloseError("Закрытие не подтверждено. Обновите страницу, чтобы проверить статус, или повторите с той же ценой.");
        queryClient.invalidateQueries({ queryKey: getGetJournalTradeQueryKey(id) });
        queryClient.invalidateQueries({ queryKey: getListJournalTradesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetJournalOverviewQueryKey() });
      },
    });
  };

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-4xl mx-auto">
         <Skeleton className="h-10 w-32 rounded-none" />
         <Skeleton className="h-64 w-full rounded-none" />
      </div>
    );
  }

  if (error || !trade) {
    return <ErrorState message="Сделка не найдена" />;
  }

  const isLong = trade.side === "buy";
  const displayedPnl = trade.environment === "paper" ? trade.grossPnl
    : trade.status === "closed" ? trade.netPnl : trade.unrealizedPnl;
  const pnlNum = displayedPnl !== null ? parseFloat(displayedPnl) : null;
  const pnlLabel = trade.environment === "paper" ? "Валовой PnL · PAPER"
    : trade.status === "closed" ? "Net PnL" : "Unrealized PnL";

  return (
    <div className="space-y-6 max-w-4xl mx-auto pb-12">
      <div>
        <Link href={`/journal/${trade.status === 'open' ? 'open' : 'history'}`} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors uppercase tracking-wider mb-4">
          <ArrowLeft className="w-4 h-4" /> Назад к списку
        </Link>
        
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border pb-4">
          <div className="flex items-center gap-4">
            <h1 className="text-3xl font-bold font-mono tracking-tight">{trade.symbol}</h1>
            <Badge className={`text-sm uppercase tracking-wider ${isLong ? 'bg-success text-success-foreground' : 'bg-destructive text-destructive-foreground'}`}>
              {isLong ? 'LONG' : 'SHORT'}
            </Badge>
            <Badge variant="outline" className="uppercase">{trade.status}</Badge>
            {trade.environment === 'paper' && <Badge variant="paper">PAPER</Badge>}
          </div>
          <div className="text-right">
             <div className="text-xs text-muted-foreground uppercase tracking-wider">{pnlLabel}</div>
             <div className={`text-2xl font-bold font-mono tracking-tight ${pnlNum !== null && pnlNum > 0 ? 'text-success' : pnlNum !== null && pnlNum < 0 ? 'text-destructive' : ''}`}>
               {pnlNum !== null ? formatCurrency(pnlNum, trade.currency) : "—"}
               {trade.roiPercent !== null && (
                 <span className="ml-2 text-sm opacity-80">
                   ({parseFloat(trade.roiPercent) > 0 ? '+' : ''}{formatNumber(trade.roiPercent, 2)}%)
                 </span>
               )}
             </div>
          </div>
        </div>
      </div>

      {trade.environment === "paper" && trade.protectionStatus === "paper_auto_exit_blocked" && (
        <section
          role="alert"
          data-testid="warning-paper-auto-exit-blocked"
          className="border-2 border-destructive bg-destructive/10 p-4 text-destructive sm:p-5"
          aria-label="Автоматическое сопровождение PAPER остановлено"
        >
          <h2 className="font-bold">Автоматическое сопровождение PAPER остановлено</h2>
          <p className="mt-1 text-sm font-medium">
            Если остаток позиции всё ещё открыт и это уместно, закройте его вручную. Не рассчитывайте на автоматический выход.
          </p>
        </section>
      )}

      {trade.status === "open" && trade.environment === "paper" && (
        <section className="border border-border bg-card p-5" aria-label="Ручное закрытие бумажной позиции">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="font-semibold">Ручное закрытие · PAPER</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Закроется весь остаток {formatNumber(trade.quantity, 4)} {trade.symbol}. Это только симуляция, не заявка на Bybit.
              </p>
            </div>
            {!showPaperClose && (
              <Button type="button" variant="outline" onClick={() => setShowPaperClose(true)}>
                Закрыть позицию вручную
              </Button>
            )}
          </div>
          {showPaperClose && (
            <form onSubmit={handlePaperClose} className="mt-4 space-y-3 border-t border-border pt-4">
              <label htmlFor="manual-paper-exit" className="block text-sm font-medium">
                Цена симулированного выхода
              </label>
              <Input id="manual-paper-exit" type="text" inputMode="decimal" required
                value={exitPrice} onChange={(event) => {
                  setExitPrice(event.target.value);
                  setCloseError("");
                  closeRequestId.current = null;
                }} placeholder="Введите цену" className="max-w-xs" />
              <p className="text-xs text-muted-foreground">
                Цена не подставляется автоматически и не подтверждается биржей. Результат будет валовым, без комиссий.
              </p>
              {closeError && <p role="alert" className="text-sm text-destructive">{closeError}</p>}
              <div className="flex gap-2">
                <Button type="submit" disabled={closePaper.isPending}>Подтвердить PAPER-закрытие</Button>
                <Button type="button" variant="ghost" disabled={closePaper.isPending}
                  onClick={() => { setShowPaperClose(false); setExitPrice(""); closeRequestId.current = null; setCloseError(""); }}>
                  Отмена
                </Button>
              </div>
            </form>
          )}
        </section>
      )}

      {trade.status === "open" && trade.environment === "testnet" && (
        <section className="border border-border bg-card p-5" aria-label="Ручное закрытие на Bybit">
          <h2 className="font-semibold">
            {trade.protectionStatus === "reconciliation_required"
              ? "Необходима сверка с Bybit"
              : "Закрыть вручную на Bybit Testnet"}
          </h2>
          {trade.protectionStatus === "reconciliation_required" ? (
            <p role="alert" className="mt-1 text-sm text-destructive">
              Позиция на Bybit не найдена после исполнения входа. Проверьте историю исполнений на бирже: дневник не подтверждает закрытие, цену выхода или PnL. Новые биржевые входы остановлены.
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              Закройте позицию на бирже. Пока исполнение закрытия не сверено с Bybit, дневник не показывает цену выхода или подтверждённый PnL.
            </p>
          )}
          <a href="https://testnet.bybit.com/" target="_blank" rel="noopener noreferrer"
            className="mt-3 inline-block text-sm font-medium text-primary underline">
            Открыть Bybit Testnet
          </a>
        </section>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="rounded-none border-border shadow-sm">
          <CardHeader className="pb-3 border-b border-border/50">
            <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">Исполнение</CardTitle>
          </CardHeader>
          <CardContent className="pt-4 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-muted-foreground uppercase mb-1">Размер позиции</div>
                <div className="font-mono text-base font-medium">{formatNumber(trade.quantity, 4)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground uppercase mb-1">Плечо</div>
                <div className="font-mono text-base font-medium">{trade.leverage ? `${trade.leverage}x` : "—"}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground uppercase mb-1">Цена входа</div>
                <div className="font-mono text-base font-medium">{trade.entryPrice ? formatNumber(trade.entryPrice, 4) : "—"}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{formatDate(trade.entryAt)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground uppercase mb-1">
                  {trade.status === "open" && trade.exitPrice
                    ? "Средняя цена закрытой части"
                    : trade.status === "closed" ? "Цена выхода" : "Цена выхода / Марк"}
                </div>
                <div className="font-mono text-base font-medium">
                  {trade.exitPrice ? formatNumber(trade.exitPrice, 4)
                    : trade.markPrice ? formatNumber(trade.markPrice, 4) : "—"}
                </div>
                {trade.exitAt && <div className="text-xs text-muted-foreground mt-0.5">{formatDate(trade.exitAt)}</div>}
                {!trade.exitAt && trade.markAt && <div className="text-xs text-muted-foreground mt-0.5">Обновлено: {formatDate(trade.markAt)}</div>}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-none border-border shadow-sm">
          <CardHeader className="pb-3 border-b border-border/50">
            <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">Финансы</CardTitle>
          </CardHeader>
          <CardContent className="pt-4 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              {trade.environment === "paper" && (
                <div className="col-span-2 text-xs text-muted-foreground">
                  PAPER — симуляция. Валовой результат связанной закрытой части: {trade.grossPnl !== null ? formatCurrency(trade.grossPnl, trade.currency) : "—"}. Комиссии и чистый результат не рассчитаны.
                </div>
              )}
              <div>
                <div className="text-xs text-muted-foreground uppercase mb-1">Комиссия входа</div>
                <div className="font-mono text-sm">{trade.entryFee ? formatCurrency(trade.entryFee, trade.currency) : "—"}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground uppercase mb-1">Комиссия выхода</div>
                <div className="font-mono text-sm">{trade.exitFee ? formatCurrency(trade.exitFee, trade.currency) : "—"}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground uppercase mb-1">Фандинг</div>
                <div className="font-mono text-sm">{trade.funding ? formatCurrency(trade.funding, trade.currency) : "—"}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground uppercase mb-1">Статус расчетов</div>
                <Badge variant={trade.calculationStatus === 'verified' ? 'success' : 'secondary'} className="text-[10px] uppercase mt-1">
                  {trade.calculationStatus}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-none border-border shadow-sm">
        <CardHeader className="pb-3 border-b border-border/50 flex flex-row justify-between items-center space-y-0">
          <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Edit3 className="w-4 h-4" /> Анализ и Заметки
          </CardTitle>
          <Button 
            size="sm" 
            onClick={handleSave} 
            disabled={updateNotes.isPending}
            className="h-8 rounded-none uppercase text-xs tracking-wider font-bold"
          >
            {updateNotes.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-2" /> : <Save className="w-3 h-3 mr-2" />}
            Сохранить
          </Button>
        </CardHeader>
        <CardContent className="pt-4 space-y-4">
          {saveMessage && <p role="status" className="text-xs text-muted-foreground">{saveMessage}</p>}
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase text-muted-foreground">Тэги (через запятую)</label>
            <Input 
              value={tagsInput} 
              onChange={(e) => setTagsInput(e.target.value)} 
              placeholder="ошибка, fomo, по тренду..."
              className="rounded-none font-mono text-sm"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase text-muted-foreground">Комментарий к сделке</label>
            <Textarea 
              value={notes} 
              onChange={(e) => setNotes(e.target.value)}
                maxLength={5000}
              placeholder="Почему был совершен вход? Какие ошибки допущены?"
              className="rounded-none min-h-[160px] font-sans text-sm resize-y"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
