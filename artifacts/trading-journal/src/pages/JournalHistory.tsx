import { useListJournalTrades, getListJournalTradesQueryKey } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/error-state";
import { Link } from "wouter";
import { History } from "lucide-react";
import SignalInbox from "./SignalInbox";

export default function JournalHistory() {
  const { data, isLoading, error } = useListJournalTrades(
    { status: 'closed', limit: 100 },
    { query: { queryKey: getListJournalTradesQueryKey({ status: 'closed', limit: 100 }), refetchInterval: 15000 } }
  );

  return (
    <div className="page-frame space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <h1 className="text-2xl font-bold tracking-tight uppercase flex items-center gap-3">
          <History className="w-6 h-6 text-primary" />
          История сделок
        </h1>
        <Badge variant="outline" className="uppercase tracking-wider font-mono">
          {data?.trades?.length || 0} Закрытых
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">Старые закрытые записи · не история активного PAPER-бота.</p>

      {isLoading ? (
        <div className="space-y-2">
          {[1,2,3,4].map(i => <Skeleton key={i} className="h-16 w-full rounded-none" />)}
        </div>
      ) : error ? (
        <ErrorState message="Не удалось загрузить историю" />
      ) : !data?.trades?.length ? (
        <div className="border border-dashed border-border p-12 text-center text-muted-foreground">
          <p className="uppercase tracking-widest text-sm">История пуста</p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[100px] uppercase text-xs">Символ</TableHead>
                <TableHead className="uppercase text-xs">Тип</TableHead>
                <TableHead className="uppercase text-xs">Вход / Выход</TableHead>
                <TableHead className="uppercase text-xs">Размер</TableHead>
                <TableHead className="uppercase text-xs">Статус</TableHead>
                <TableHead className="text-right uppercase text-xs">Результат</TableHead>
                <TableHead className="w-[50px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.trades.map((trade) => {
                 const isLong = trade.side === "buy";
                  const pnl = trade.environment === "paper" ? trade.grossPnl : trade.netPnl;
                  const pnlNum = pnl !== null ? parseFloat(pnl) : null;
                 
                 return (
                   <TableRow key={trade.id} className="group">
                     <TableCell className="font-bold font-mono text-sm">{trade.symbol}</TableCell>
                     <TableCell>
                       <div className="flex flex-col gap-1 items-start">
                         <span className={`text-xs font-bold uppercase tracking-wider ${isLong ? 'text-success' : 'text-destructive'}`}>
                           {isLong ? 'LONG' : 'SHORT'}
                         </span>
                         {trade.environment === 'paper' && <Badge variant="paper" className="text-[10px] px-1 py-0 h-4">PAPER</Badge>}
                       </div>
                     </TableCell>
                     <TableCell className="font-mono text-sm">
                       <div className="text-muted-foreground">En: {trade.entryPrice ? formatNumber(trade.entryPrice, 4) : "—"}</div>
                       <div>Ex: {trade.exitPrice ? formatNumber(trade.exitPrice, 4) : "—"}</div>
                     </TableCell>
                     <TableCell className="font-mono text-sm">{formatNumber(trade.quantity, 4)}</TableCell>
                     <TableCell>
                       <Badge variant={trade.calculationStatus === 'verified' ? 'success' : 'secondary'} className="text-[10px] uppercase font-mono tracking-wider">
                         {trade.calculationStatus}
                       </Badge>
                     </TableCell>
                     <TableCell className="text-right font-mono text-sm font-medium">
                       {pnlNum !== null ? (
                         <span className={pnlNum > 0 ? "text-success" : pnlNum < 0 ? "text-destructive" : ""}>
                           {formatCurrency(pnlNum, trade.currency)}
                            {trade.environment === "paper" && <span className="block text-[10px] text-muted-foreground">Валовой PAPER</span>}
                         </span>
                       ) : "—"}
                     </TableCell>
                     <TableCell className="text-right">
                       <Link href={`/journal/trades/${trade.id}`} data-testid={`link-history-trade-${trade.id}`} className="text-xs uppercase font-medium text-primary hover:underline">
                         Детали
                       </Link>
                     </TableCell>
                   </TableRow>
                 );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      <details className="border border-border bg-card/60 p-4">
        <summary className="cursor-pointer text-sm font-semibold" data-testid="toggle-history-signals">Сигналы и техническая история</summary>
        <div className="mt-4 border-t border-border pt-4"><SignalInbox /></div>
      </details>
    </div>
  );
}
