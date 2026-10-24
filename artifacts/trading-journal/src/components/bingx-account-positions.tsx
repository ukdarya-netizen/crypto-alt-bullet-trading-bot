import {
  getGetJournalBingxPositionsQueryKey,
  useGetJournalBingxPositions,
} from "@workspace/api-client-react";
import type { BingXAccountPosition, BingXAccountPositions } from "@workspace/api-client-react";
import { useEffect, useState } from "react";
import { AlertTriangle, Clock3, Database, LockKeyhole, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate, formatNumber } from "@/lib/utils";
import { sortPositionsNewestFirst } from "@/lib/position-order";

function decimal(value: string | null | undefined, unit = "") {
  return value === null || value === undefined || value.trim() === ""
    ? "Не указано"
    : `${value}${unit ? ` ${unit}` : ""}`;
}

function AccountMetric({ label, value, detail, testId }: {
  label: string;
  value: string;
  detail?: string;
  testId?: string;
}) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-all font-mono text-sm font-semibold tabular-nums">{value}</dd>
      {detail && <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{detail}</p>}
    </div>
  );
}

function money(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim() === "") return "Не указано";
  const amount = Number(value);
  return Number.isFinite(amount) ? `${formatNumber(amount, 2)} USDT` : "Не указано";
}

function freshObservation(value: string | null | undefined, now: number): boolean {
  const observed = value ? Date.parse(value) : NaN;
  return Number.isFinite(observed) && now - observed >= -5_000 && now - observed <= 90_000;
}

function AccountBalance({ data, now }: { data: BingXAccountPositions; now: number }) {
  const account = data.accountStatus === "available" ? data.account : null;
  const fresh = freshObservation(data.accountObservedAt, now);
  return (
    <CardContent className="border-b border-amber-500/25 bg-amber-500/[.025] px-4 py-4 sm:px-5" data-testid="section-bingx-account-balance">
      <p className="font-mono text-[10px] uppercase tracking-[.16em] text-amber-300">Весь счёт BingX · USDT · только чтение</p>
      {account && !fresh ? (
        <p className="mt-2 text-xs text-amber-300" role="status" data-testid="status-bingx-account-balance-stale">
          Последний снимок баланса{data.accountObservedAt ? ` от ${formatDate(data.accountObservedAt)}` : ""} устарел. Текущая стоимость счёта неизвестна; дождитесь нового чтения BingX.
        </p>
      ) : account ? (
        <>
          <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
            <div className="min-w-0 border border-amber-500/35 bg-amber-500/[.055] p-4">
              <p className="font-mono text-[10px] uppercase tracking-[.15em] text-amber-300">Текущая стоимость REAL-счёта</p>
              <p className="mt-2 font-mono text-3xl font-bold tracking-tight tabular-nums sm:text-4xl" data-testid="value-bingx-account-equity">
                {money(account.equityUsdt)}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {data.accountObservedAt ? `Снимок ${formatDate(data.accountObservedAt)}` : "Время снимка неизвестно"}
              </p>
              <div className="mt-4 border-t border-amber-500/20 pt-3">
                <AccountMetric label="Баланс кошелька · без открытого PnL" value={money(account.walletBalanceUsdt)} testId="value-bingx-account-wallet" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="border border-border p-3">
                <AccountMetric label="Изменение от старта" value="—" detail="Начальный баланс не записан" />
              </div>
              <div className="border border-border p-3">
                <AccountMetric label="Открытый результат" value={money(account.unrealizedPnlUsdt)} testId="value-bingx-account-unrealized" />
              </div>
            </div>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-amber-500/20 pt-4 sm:grid-cols-4">
            <AccountMetric label="Начальный" value="—" />
            <AccountMetric label="Доступно" value={money(account.availableMarginUsdt)} detail="Маржа биржи" testId="value-bingx-account-available" />
            <AccountMetric label="Зарезервировано" value="—" />
            <AccountMetric label="Реализованный PnL" value="—" />
          </dl>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Весь счёт BingX, не бот. Баланс и позиции считываются отдельно.
          </p>
        </>
      ) : (
        <p className="mt-2 text-xs text-amber-300" role="status" data-testid="status-bingx-account-balance-unavailable">
          {data.accountStatus === "not_configured"
            ? "Чтение баланса BingX не настроено; неизвестное значение не считается нулём."
            : "Баланс BingX пока недоступен; данные PAPER не подставляются вместо реального счёта."}
        </p>
      )}
    </CardContent>
  );
}

function PositionRow({ position, index }: { position: BingXAccountPosition; index: number }) {
  const pnl = position.unrealizedPnlUsdt;
  const roe = position.roePercent;
  const size = Number(position.size);
  const mark = position.markPrice === null ? NaN : Number(position.markPrice);
  const notional = size > 0 && mark > 0 && Number.isFinite(size * mark) ? size * mark : null;
  const margin = position.marginUsdt === null ? NaN : Number(position.marginUsdt);
  const entry = position.entryPrice === null ? NaN : Number(position.entryPrice);
  const confirmedStop = position.stopPrice === null ? NaN : Number(position.stopPrice);
  // The API leaves stopPrice null unless it can verify a protective order.
  const stopProtected = entry > 0 && confirmedStop > 0 &&
    (position.side === "LONG" ? confirmedStop >= entry :
      position.side === "SHORT" && confirmedStop <= entry);
  const incomplete = position.side === null
    || [position.entryPrice, position.markPrice, position.unrealizedPnlUsdt, position.marginUsdt].some((value) => value === null || value.trim() === "")
    || position.leverage === null || position.marginMode === null;
  const numericPnl = pnl === null || pnl.trim() === "" ? null : Number(pnl);
  const pnlTone = numericPnl !== null && Number.isFinite(numericPnl)
    ? numericPnl > 0 ? "text-success" : numericPnl < 0 ? "text-destructive" : ""
    : "";
  const sideTone = position.side === "LONG"
    ? "border-success/35 bg-success/[.08] text-success"
    : position.side === "SHORT"
      ? "border-destructive/35 bg-destructive/[.08] text-destructive"
      : "border-border bg-secondary text-muted-foreground";

  return (
    <article className="px-4 py-5 sm:px-5" data-testid={`card-bingx-account-position-${index}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="break-all font-mono text-lg font-bold tracking-tight" data-testid={`text-bingx-symbol-${index}`}>
              {position.symbol || "Символ не указан"}
            </h4>
            <span className={`border px-2 py-0.5 font-mono text-[10px] font-bold uppercase ${sideTone}`}>
              {position.side ?? "Сторона неизвестна"}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground" data-testid={`text-bingx-pattern-${index}`}>
            Паттерн: не подтверждён
          </p>
          <p className="mt-1 font-mono text-[10px] text-muted-foreground">
            {position.marginMode ?? "Режим маржи неизвестен"} · {position.leverage === null ? "Плечо неизвестно" : `${position.leverage}×`}
          </p>
        </div>
        <div className="min-w-[150px] sm:text-right" data-testid={`value-bingx-pnl-${index}`}>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Нереализованный PnL</p>
          <p className={`mt-1 font-mono text-xl font-semibold leading-none tabular-nums ${pnlTone}`}>
            {pnl === null || pnl.trim() === "" ? "—" : `${numericPnl !== null && numericPnl > 0 ? "+" : ""}${formatNumber(Number(pnl), 2)} USDT`}
          </p>
          <p className="mt-1 font-mono text-xs text-muted-foreground" data-testid={`value-bingx-roe-${index}`}>
            ROE (до закрытия) {roe === null ? "—" : `${Number(roe) > 0 ? "+" : ""}${formatNumber(Number(roe), 2)}%`}
          </p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border/80 pt-3">
        <div data-testid={`value-bingx-margin-current-${index}`}>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Маржа в позиции сейчас</p>
          <p className="mt-1 font-mono text-base font-semibold tabular-nums">
            {Number.isFinite(margin) && margin >= 0 ? `${formatNumber(margin, 4)} USDT` : "—"}
          </p>
          <p className="text-[10px] text-muted-foreground">По последнему снимку BingX</p>
        </div>
        <div data-testid={`value-bingx-notional-current-${index}`}>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Номинал остатка</p>
          <p className="mt-1 font-mono text-base font-semibold tabular-nums">
            {notional === null ? "—" : `${formatNumber(notional, 2)} USDT`}
          </p>
          <p className="text-[10px] text-muted-foreground">Размер × mark, не маржа</p>
        </div>
      </div>
      <p className="mt-3 text-xs text-muted-foreground" data-testid={`status-bingx-five-percent-${index}`}>
        Частичные REAL-тейки: снимок счёта не подтверждает исполнение или связь позиции с ботом.
        {" "}<span className={stopProtected ? "text-success" : ""} data-testid={`status-bingx-protected-stop-${index}`}>
          Стоп в БУ: {stopProtected
            ? "подтверждённый стоп у цены входа или лучше (до комиссий)."
            : "не подтверждён биржевым ордером."}
        </span>
      </p>

      {incomplete && (
        <p className="mt-4 flex items-start gap-2 border-l-2 border-amber-500/60 bg-amber-500/[.04] px-3 py-2 text-xs text-muted-foreground" role="status" data-testid={`status-bingx-position-incomplete-${index}`}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden="true" />
          Данные этой позиции неполные. Неуказанные значения не принимаются за ноль; неизвестный стоп не означает, что стоп-ордера нет.
        </p>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4 border-t border-border/80 pt-4 sm:grid-cols-3 lg:grid-cols-4">
        <AccountMetric label="Остаток" value={decimal(position.size)} testId={`value-bingx-size-${index}`} />
        <AccountMetric label="Цена входа" value={decimal(position.entryPrice, "USDT")} testId={`value-bingx-entry-${index}`} />
        <AccountMetric label="Mark price" value={decimal(position.markPrice, "USDT")} detail="Время котировки биржей не передано" testId={`value-bingx-mark-${index}`} />
        <AccountMetric label="Стоп" value={position.stopPrice === null || position.stopPrice.trim() === "" ? "Неизвестен" : `${position.stopPrice} USDT`} detail="Нет данных о стопе ≠ стоп отсутствует" testId={`value-bingx-stop-${index}`} />
        <AccountMetric label="Ликвидация" value={decimal(position.liquidationPrice, "USDT")} testId={`value-bingx-liquidation-${index}`} />
        <AccountMetric label="Маржа" value={decimal(position.marginUsdt, "USDT")} detail="ROE = PnL / маржа биржи" testId={`value-bingx-margin-${index}`} />
        <AccountMetric label="Режим / плечо" value={`${position.marginMode ?? "Неизвестен"} / ${position.leverage === null ? "неизвестно" : `${position.leverage}×`}`} testId={`value-bingx-leverage-${index}`} />
        <AccountMetric label="Открыта" value={position.openedAt ? formatDate(position.openedAt) : "Не указано"} testId={`value-bingx-opened-${index}`} />
      </dl>
    </article>
  );
}

export function BingxAccountPositions() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(interval);
  }, []);
  const { data, isLoading, error } = useGetJournalBingxPositions({
    query: {
      queryKey: getGetJournalBingxPositionsQueryKey(),
      refetchInterval: 30000,
    },
  });

  const available = !error && data?.status === "available" &&
    freshObservation(data.observedAt, now);

  return (
    <Card className="paper-surface overflow-hidden rounded-none border-amber-500/45" data-testid="section-bingx-account-positions" aria-label="Реальный счёт и позиции BingX">
      <CardHeader className="border-b border-amber-500/25 bg-amber-500/[.045] px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[.2em] text-amber-300">Account / BingX mainnet / read only</p>
            <CardTitle className="mt-1 text-base font-bold uppercase tracking-wide">Реальный баланс и позиции счёта BingX</CardTitle>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Отдельные данные приватного счёта, не PAPER. Позиции принадлежат счёту; их происхождение и связь с ботом здесь не установлены.
            </p>
          </div>
          <span className="flex items-center gap-1.5 border border-amber-500/40 bg-amber-500/[.08] px-2 py-1 font-mono text-[10px] font-bold uppercase text-amber-200" data-testid="status-bingx-account-readonly">
            <LockKeyhole className="h-3 w-3" aria-hidden="true" />
            Счёт · только чтение
          </span>
        </div>
      </CardHeader>

      {!isLoading && !error && data && <AccountBalance data={data} now={now} />}

      {isLoading ? (
        <CardContent className="space-y-3 px-4 py-5 sm:px-5" role="status" data-testid="status-bingx-positions-loading">
          <p className="text-xs text-muted-foreground">Считываются позиции счёта BingX…</p>
          <Skeleton className="h-6 w-1/3 rounded-none" />
          <Skeleton className="h-16 w-full rounded-none" />
        </CardContent>
      ) : error || !data ? (
        <CardContent className="flex gap-3 px-4 py-5 text-sm sm:px-5" role="status" data-testid="status-bingx-positions-error">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
          <div>
            <p className="font-semibold">Не удалось получить позиции счёта</p>
            <p className="mt-1 text-xs text-muted-foreground">Состояние реальной экспозиции неизвестно. PAPER-позиции не заменяют данные счёта. Повторная проверка выполняется автоматически.</p>
          </div>
        </CardContent>
      ) : !available ? (
        <CardContent className="flex gap-3 px-4 py-5 text-sm sm:px-5" role="status" data-testid="status-bingx-positions-unavailable">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
          <div>
            <p className="font-semibold">{data.status === "not_configured" ? "Доступ к позициям не настроен"
              : data.status === "available" ? "Снимок позиций устарел" : "Позиции счёта недоступны"}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {data.status === "not_configured" ? "Ключи BingX не настроены. Наличие или отсутствие реальных позиций неизвестно."
                : data.status === "available"
                  ? `Последний ответ${data.observedAt ? ` от ${formatDate(data.observedAt)}` : ""} больше не подтверждает текущую экспозицию. Ожидаем обновления.`
                  : "Запрос к BingX не дал доступных данных. Наличие или отсутствие реальных позиций неизвестно."}
            </p>
          </div>
        </CardContent>
      ) : data.positions.length === 0 ? (
        <CardContent className="flex gap-3 px-4 py-6 sm:px-5" role="status" data-testid="empty-bingx-account-positions">
          <Database className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold">В ответе BingX открытых позиций нет</p>
            <p className="mt-1 text-xs text-muted-foreground">Это результат последнего чтения счёта, не подтверждение постоянного отсутствия экспозиции.</p>
          </div>
        </CardContent>
      ) : (
        <div className="divide-y divide-border">
          <div className="flex items-center gap-2 px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground sm:px-5" data-testid="status-bingx-positions-count">
            <ShieldCheck className="h-3.5 w-3.5 text-amber-300" aria-hidden="true" />
            Получено позиций счёта: {data.positions.length}
          </div>
          {sortPositionsNewestFirst(
            data.positions,
            (position) => position.openedAt,
            (position) => `${position.symbol}:${position.side ?? ""}`,
          ).map((position, index) => <PositionRow key={`${position.symbol}-${position.side}-${index}`} position={position} index={index} />)}
        </div>
      )}

      <CardContent className="border-t border-amber-500/20 bg-secondary/20 px-4 py-3 text-[11px] leading-relaxed text-muted-foreground sm:px-5">
        <p className="flex items-center gap-1.5" data-testid="text-bingx-observed-at">
          <Clock3 className="h-3 w-3 shrink-0" aria-hidden="true" />
          {available && data.observedAt ? `Ответ получен сервером: ${formatDate(data.observedAt)}` : "Время получения ответа сервером неизвестно"}
          {" · "}обновление каждые 30 секунд.
        </p>
        <p className="mt-1">Источник: BingX private swap positions · mainnet. Время получения ответа не является временем биржевой котировки. Неизвестный стоп не означает отсутствие стоп-ордера. Просмотр счёта не включает реальную торговлю и не связывает эти позиции с PAPER-ботом.</p>
      </CardContent>
    </Card>
  );
}