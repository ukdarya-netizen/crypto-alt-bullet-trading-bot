import { useListJournalTrades, getListJournalTradesQueryKey } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/error-state";
import { Link } from "wouter";
import { sortPositionsNewestFirst } from "@/lib/position-order";
import { List } from "lucide-react";

export default function JournalOpen() {
  const { data, isLoading, error } = useListJournalTrades(
    { status: 'open', limit: 100 },
    { query: { queryKey: getListJournalTradesQueryKey({ status: 'open', limit: 100 }), refetchInterval: 15000 } }
  );

  return (
    <div className="page-frame space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <h1 className="text-2xl font-bold tracking-tight uppercase flex items-center gap-3">
          <List className="w-6 h-6 text-primary" />
          Старые открытые записи
        </h1>
        <Badge variant="outline" className="uppercase tracking-wider font-mono">
          {data?.trades?.length || 0} legacy-позиций
        </Badge>
      </div>
       <p className="text-xs text-muted-foreground">Отдельный старый журнал. Текущие PAPER-позиции — <Link href="/journal" className="text-primary underline" data-testid="link-current-paper">на вкладке PAPER</Link>.</p>

      {isLoading ? (
        <div className="space-y-2">
          {[1,2,3].map(i => <Skeleton key={i} className="h-16 w-full rounded-none" />)}
        </div>
      ) : error ? (
        <ErrorState message="Не удалось загрузить открытые позиции" />
      ) : !data?.trades?.length ? (
        <div className="space-y-4">
          <div className="border border-dashed border-border p-6 text-center text-muted-foreground">
            <p className="text-sm font-medium">В старом журнале открытых сделок нет.</p>
             <p className="mt-1 text-xs">Текущие позиции смотрите во вкладках PAPER, REAL и VST.</p>
          </div>
        </div>
      ) : (
         <div className="overflow-x-auto border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[100px] uppercase text-xs">Символ</TableHead>
                <TableHead className="uppercase text-xs">Тип</TableHead>
                <TableHead className="uppercase text-xs">Размер</TableHead>
                <TableHead className="uppercase text-xs">Вход</TableHead>
                 <TableHead className="uppercase text-xs">Марк</TableHead>
                <TableHead className="w-[50px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortPositionsNewestFirst(
                data.trades,
                (trade) => trade.entryAt,
                (trade) => String(trade.id),
              ).map((trade) => {
                 const isLong = trade.side === "buy";
                 
                 return (
                   <TableRow key={trade.id} className="group">
                      <TableCell className="font-bold font-mono text-sm">
                        {trade.symbol}
                         {trade.environment === "paper" && trade.protectionStatus === "paper_auto_exit_blocked" && <p role="alert" className="mt-1 text-xs text-destructive">Автовыход остановлен · закройте вручную</p>}
                      </TableCell>
                     <TableCell>
                       <div className="flex flex-col gap-1 items-start">
                         <span className={`text-xs font-bold uppercase tracking-wider ${isLong ? 'text-success' : 'text-destructive'}`}>
                           {isLong ? 'LONG' : 'SHORT'}
                         </span>
                         {trade.environment === 'paper' && <Badge variant="paper" className="text-[10px] px-1 py-0 h-4">PAPER</Badge>}
                       </div>
                     </TableCell>
                     <TableCell className="font-mono text-sm">{formatNumber(trade.quantity, 4)}</TableCell>
                     <TableCell className="font-mono text-sm">
                       {trade.entryPrice ? formatNumber(trade.entryPrice, 4) : "—"}
                     </TableCell>
                     <TableCell className="font-mono text-sm">{trade.markPrice ? formatNumber(trade.markPrice, 4) : "—"}</TableCell>
                     <TableCell className="text-right">
                       <Link href={`/journal/trades/${trade.id}`} className="text-xs uppercase font-medium text-primary hover:underline">
                          {trade.environment === "paper" ? "Закрыть PAPER / детали"
                            : trade.protectionStatus === "reconciliation_required" ? "Сверить закрытие / детали"
                            : trade.environment === "testnet" ? "Закрыть на Bybit / детали" : "Детали"}
                       </Link>
                     </TableCell>
                   </TableRow>
                 );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
