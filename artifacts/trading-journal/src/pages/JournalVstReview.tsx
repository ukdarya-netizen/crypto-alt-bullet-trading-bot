import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, RefreshCw } from "lucide-react";
import {
  useGetJournalVstReview, getGetJournalVstReviewQueryKey,
  useResolveJournalVstReviewClosed, useResolveJournalVstReviewOpen,
  useCloseJournalVstReviewNow, useConfirmJournalVstReviewOpenNow,
  useResolveJournalVstReviewMarginTopUpKeepOpen,
  useResolveJournalVstReviewPreRunnerClose,
  useGetJournalVstReviewMarginTopUpCheck,
  getGetJournalVstReviewMarginTopUpCheckQueryKey,
  useCloseJournalVstReviewMarginTopUpNow,
  getGetJournalVstPositionsQueryKey,
} from "@workspace/api-client-react";
import type {
  JournalVstReviewPositionsPositionsItem,
  JournalVstReviewPositionsMarginTopUpPendingItem,
  JournalVstReviewLegacyPreRunnerCloseIntent,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate, formatNumber } from "@/lib/utils";
import { PreRunnerCloseHistory } from "@/components/PreRunnerCloseHistory";

const DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,15})(\.[0-9]{1,12})?$/;

function number(value: string | null, digits = 4): string {
  if (value === null) return "—";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? formatNumber(parsed, digits) : "—";
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium">{children}</label>;
}

function ClosedForm({ sourceSignalId, remainingQty, onDone }: {
  sourceSignalId: string; remainingQty: string | null; onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const resolveClosed = useResolveJournalVstReviewClosed();
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [at, setAt] = useState("");
  const [exchangeOrderId, setExchangeOrderId] = useState("");
  const [feeAsset, setFeeAsset] = useState("");
  const [feeAmount, setFeeAmount] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: getGetJournalVstReviewQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetJournalVstPositionsQueryKey() });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!DECIMAL_PATTERN.test(price) || Number(price) <= 0) {
      setError("Введите положительную цену закрытия — ровно ту, что показывает BingX.");
      return;
    }
    if (!DECIMAL_PATTERN.test(quantity) || Number(quantity) <= 0) {
      setError("Введите положительное закрытое количество.");
      return;
    }
    const atDate = at ? new Date(at) : null;
    if (!atDate || Number.isNaN(atDate.getTime())) {
      setError("Укажите время закрытия на бирже.");
      return;
    }
    if (!exchangeOrderId.trim()) {
      setError("Укажите ID ордера закрытия с BingX.");
      return;
    }
    if (!feeAsset.trim()) {
      setError("Укажите актив комиссии, как на BingX (например, USDT или VST).");
      return;
    }
    if (!DECIMAL_PATTERN.test(feeAmount.trim())) {
      setError("Введите комиссию закрытия, как на BingX (0, если комиссия не взималась).");
      return;
    }
    setError("");
    resolveClosed.mutate({
      sourceSignalId,
      data: {
        fill: {
          price, quantity, at: atDate.toISOString(), exchangeOrderId: exchangeOrderId.trim(),
          fee: { asset: feeAsset.trim(), amount: feeAmount.trim() },
        },
        note: note.trim() || null,
      },
    }, {
      onSuccess: () => { invalidate(); onDone(); },
      onError: (failure) => {
        const code = (failure as { data?: { error?: string } }).data?.error;
        const messages: Record<string, string> = {
          VST_REVIEW_QUANTITY_MISMATCH:
            "Объём исполнения не совпадает с учтённым остатком. Журнал не изменён; проверьте все исполнения BingX и не подставляйте выдуманный объём.",
          VST_REVIEW_POSITION_NOT_FLAT:
            "BingX всё ещё показывает открытую позицию по этому инструменту. Журнал не закрыт, защита позиции не отключена.",
          VST_REVIEW_ORDERS_REMAIN:
            "На BingX остались открытые ордера по этому инструменту. Журнал не изменён; проверьте их отдельно. Бот не отменял ордера.",
          VST_REVIEW_ACCOUNT_MISMATCH:
            "Снимок получен не для того VST-счёта или инструмента, что записаны в позиции. Журнал не изменён; требуется ручная проверка.",
          VST_REVIEW_EXCHANGE_CHECK_UNAVAILABLE:
            "Не удалось получить свежий подтверждённый снимок BingX VST (возможно, биржа недоступна или цикл занят). Журнал не изменён. Повторите позже; без проверки отсутствия позиции закрыть запись нельзя.",
        };
        setError(messages[code ?? ""] ??
          "Не удалось сохранить подтверждение. Проверьте актуальный статус ниже и повторите при необходимости.");
        invalidate();
      },
    });
  }

  return (
    <form onSubmit={handleSubmit} className="mt-3 space-y-3 border-t border-border pt-3" aria-label="Подтвердить закрытие на BingX">
      <p className="text-xs text-muted-foreground">
        Введите факты закрытия, которые вы видите на BingX. Ничего не подставляется автоматически и не рассчитывается заново.
        Один ордер должен закрывать весь учтённый остаток: {remainingQty ?? "остаток не сохранён"}.
        Если закрытие было несколькими ордерами, эта форма не может подтвердить их одним исполнением.
        Исполнение остаётся подтверждённым владельцем, а не сверенным с историей ордеров. Перед записью сервер заново проверит VST-счёт, позицию и ордера; при ошибке чтения ничего не закроет. Биржевые ордера эта форма не отправляет и не отменяет.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <FieldLabel htmlFor={`price-${sourceSignalId}`}>Цена закрытия</FieldLabel>
          <Input id={`price-${sourceSignalId}`} inputMode="decimal" required value={price}
            onChange={(event) => setPrice(event.target.value)} placeholder="Например, 22.71" />
        </div>
        <div>
          <FieldLabel htmlFor={`qty-${sourceSignalId}`}>Закрытое количество</FieldLabel>
          <Input id={`qty-${sourceSignalId}`} inputMode="decimal" required value={quantity}
            onChange={(event) => setQuantity(event.target.value)} placeholder="Например, 12" />
        </div>
        <div>
          <FieldLabel htmlFor={`at-${sourceSignalId}`}>Время закрытия</FieldLabel>
          <Input id={`at-${sourceSignalId}`} type="datetime-local" required value={at}
            onChange={(event) => setAt(event.target.value)} />
        </div>
        <div>
          <FieldLabel htmlFor={`oid-${sourceSignalId}`}>ID ордера закрытия на BingX</FieldLabel>
          <Input id={`oid-${sourceSignalId}`} required value={exchangeOrderId}
            onChange={(event) => setExchangeOrderId(event.target.value)} placeholder="Например, 1988374652" />
        </div>
        <div>
          <FieldLabel htmlFor={`fee-asset-${sourceSignalId}`}>Актив комиссии</FieldLabel>
          <Input id={`fee-asset-${sourceSignalId}`} required value={feeAsset}
            onChange={(event) => setFeeAsset(event.target.value)} placeholder="Например, USDT или VST" />
        </div>
        <div>
          <FieldLabel htmlFor={`fee-${sourceSignalId}`}>Комиссия закрытия</FieldLabel>
          <Input id={`fee-${sourceSignalId}`} inputMode="decimal" required value={feeAmount}
            onChange={(event) => setFeeAmount(event.target.value)} placeholder="Например, 0.05 или 0" />
        </div>
      </div>
      <div>
        <FieldLabel htmlFor={`note-closed-${sourceSignalId}`}>Заметка (необязательно)</FieldLabel>
        <Textarea id={`note-closed-${sourceSignalId}`} rows={2} value={note}
          onChange={(event) => setNote(event.target.value)} />
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={resolveClosed.isPending || !remainingQty} data-testid={`button-confirm-closed-${sourceSignalId}`}>
          Подтвердить закрытие
        </Button>
        <Button type="button" variant="ghost" disabled={resolveClosed.isPending} onClick={onDone}>
          Отмена
        </Button>
      </div>
    </form>
  );
}

function StillOpenForm({ sourceSignalId, onDone }: { sourceSignalId: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const resolveOpen = useResolveJournalVstReviewOpen();
  const [remainingQty, setRemainingQty] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: getGetJournalVstReviewQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetJournalVstPositionsQueryKey() });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!DECIMAL_PATTERN.test(remainingQty) || Number(remainingQty) <= 0) {
      setError("Введите положительное открытое количество, как на BingX. Если позиции больше нет, используйте форму «Закрыта на BingX» выше.");
      return;
    }
    setError("");
    resolveOpen.mutate({
      sourceSignalId,
      data: { remainingQty, note: note.trim() || null },
    }, {
      onSuccess: () => { invalidate(); onDone(); },
      onError: () => {
        setError("Не удалось сохранить подтверждение. Проверьте актуальный статус ниже и повторите при необходимости.");
        invalidate();
      },
    });
  }

  return (
    <form onSubmit={handleSubmit} className="mt-3 space-y-3 border-t border-border pt-3" aria-label="Подтвердить, что позиция всё ещё открыта">
      <p className="text-xs text-muted-foreground">
        Укажите текущее открытое количество, которое вы видите на BingX. Позиция вернётся под автоматическое управление.
        Если позиция уже закрыта, заполните форму «Закрыта на BingX» вместо этой.
      </p>
      <div>
        <FieldLabel htmlFor={`remaining-${sourceSignalId}`}>Открытое количество сейчас</FieldLabel>
        <Input id={`remaining-${sourceSignalId}`} inputMode="decimal" required value={remainingQty}
          onChange={(event) => setRemainingQty(event.target.value)} placeholder="Например, 12" className="max-w-xs" />
      </div>
      <div>
        <FieldLabel htmlFor={`note-open-${sourceSignalId}`}>Заметка (необязательно)</FieldLabel>
        <Textarea id={`note-open-${sourceSignalId}`} rows={2} value={note}
          onChange={(event) => setNote(event.target.value)} />
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={resolveOpen.isPending} data-testid={`button-confirm-open-${sourceSignalId}`}>
          Подтвердить, что открыта
        </Button>
        <Button type="button" variant="ghost" disabled={resolveOpen.isPending} onClick={onDone}>
          Отмена
        </Button>
      </div>
    </form>
  );
}

const CLOSE_NOW_REASON_MESSAGES: Record<string, string> = {
  closed_but_unrecorded:
    "Биржа подтвердила закрытие, но сохранить результат в журнале не удалось. Новая заявка на биржу отправлена не будет — нажмите «Закрыть сейчас» ещё раз, чтобы бот повторил только сохранение уже подтверждённого результата.",
};

function closeNowReasonMessage(reason: string | null | undefined): string {
  if (reason && CLOSE_NOW_REASON_MESSAGES[reason]) return CLOSE_NOW_REASON_MESSAGES[reason];
  const detail = reason ? ` (причина: ${reason})` : "";
  return `Бот не смог безопасно подтвердить закрытие${detail}. На бирже ничего не изменено без проверки — попробуйте ещё раз или введите данные вручную ниже.`;
}

function CloseNowButton({
  sourceSignalId, onAlreadyFlat,
}: { sourceSignalId: string; onAlreadyFlat: () => void }) {
  const queryClient = useQueryClient();
  const closeNow = useCloseJournalVstReviewNow();
  const [message, setMessage] = useState<{ tone: "success" | "info" | "error"; text: string } | null>(null);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: getGetJournalVstReviewQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetJournalVstPositionsQueryKey() });
  }

  function handleClick() {
    setMessage(null);
    closeNow.mutate({ sourceSignalId }, {
      onSuccess: (data) => {
        if (data.outcome === "closed") {
          setMessage({ tone: "success", text: "Готово: бот выставил рыночную заявку на BingX и подтвердил закрытие по данным биржи." });
          invalidate();
          return;
        }
        if (data.outcome === "already_flat") {
          setMessage({ tone: "info", text: "На BingX по этому символу уже нет открытой позиции — бот не отправлял заявок. Подтвердите закрытие вручную ниже." });
          onAlreadyFlat();
          return;
        }
        setMessage({ tone: "error", text: closeNowReasonMessage(data.reason) });
      },
      onError: () => {
        setMessage({ tone: "error", text: "Не удалось выполнить закрытие. Попробуйте ещё раз или введите данные вручную ниже." });
      },
    });
  }

  return (
    <div>
      <Button type="button" onClick={handleClick} disabled={closeNow.isPending}
        data-testid={`button-close-now-${sourceSignalId}`}>
        {closeNow.isPending ? "Закрываем…" : "Закрыть сейчас"}
      </Button>
      {message && (
        <p role="status" className={`mt-2 max-w-md text-xs ${message.tone === "error" ? "text-destructive" : "text-muted-foreground"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}

function confirmOpenReasonMessage(reason: string | null | undefined): string {
  const detail = reason ? ` (причина: ${reason})` : "";
  return `Бот не смог безопасно прочитать позицию на BingX${detail}. Ничего не изменено — попробуйте ещё раз или введите открытое количество вручную ниже.`;
}

function ConfirmOpenNowButton({
  sourceSignalId, onAlreadyFlat,
}: { sourceSignalId: string; onAlreadyFlat: () => void }) {
  const queryClient = useQueryClient();
  const confirmOpenNow = useConfirmJournalVstReviewOpenNow();
  const [message, setMessage] = useState<{ tone: "success" | "info" | "error"; text: string } | null>(null);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: getGetJournalVstReviewQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetJournalVstPositionsQueryKey() });
  }

  function handleClick() {
    setMessage(null);
    confirmOpenNow.mutate({ sourceSignalId }, {
      onSuccess: (data) => {
        if (data.outcome === "confirmed_open") {
          setMessage({ tone: "success", text: "Готово: бот прочитал позицию на BingX и подтвердил, что она всё ещё открыта тем количеством, которое показывает биржа." });
          invalidate();
          return;
        }
        if (data.outcome === "already_flat") {
          setMessage({ tone: "info", text: "На BingX по этому символу уже нет открытой позиции — количество не подтверждено. Подтвердите закрытие вместо этого." });
          onAlreadyFlat();
          return;
        }
        setMessage({ tone: "error", text: confirmOpenReasonMessage(data.reason) });
      },
      onError: () => {
        setMessage({ tone: "error", text: "Не удалось выполнить проверку. Попробуйте ещё раз или введите количество вручную ниже." });
      },
    });
  }

  return (
    <div>
      <Button type="button" variant="outline" onClick={handleClick} disabled={confirmOpenNow.isPending}
        data-testid={`button-confirm-open-now-${sourceSignalId}`}>
        {confirmOpenNow.isPending ? "Проверяем…" : "Всё ещё открыта"}
      </Button>
      {message && (
        <p role="status" className={`mt-2 max-w-md text-xs ${message.tone === "error" ? "text-destructive" : "text-muted-foreground"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}

function ReviewCard({ position }: { position: JournalVstReviewPositionsPositionsItem }) {
  const [activeForm, setActiveForm] = useState<null | "closed" | "open">(null);
  return (
    <article className="border border-destructive/40 bg-card p-4" data-testid={`review-position-${position.sourceSignalId}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-muted-foreground">{position.sourceSignalId}</p>
          <p className="mt-0.5 text-lg font-bold">{position.symbol}</p>
        </div>
        <p className="text-xs text-muted-foreground">{formatDate(position.updatedAt)}</p>
      </div>
      {position.reason && <p className="mt-2 text-xs text-destructive">Причина остановки: {position.reason}</p>}
      <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
        <div><dt className="text-xs text-muted-foreground">Цена входа</dt><dd className="font-mono">{number(position.entryPrice)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Последний остаток</dt><dd className="font-mono">{number(position.remainingQty)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Стоп</dt><dd className="font-mono">{number(position.stopPrice)}</dd></div>
      </dl>
      {activeForm === null && (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-start gap-2">
            <CloseNowButton sourceSignalId={position.sourceSignalId} onAlreadyFlat={() => setActiveForm("closed")} />
            <ConfirmOpenNowButton sourceSignalId={position.sourceSignalId} onAlreadyFlat={() => setActiveForm("closed")} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setActiveForm("closed")}
              data-testid={`button-open-closed-form-${position.sourceSignalId}`}>
              Ввести данные закрытия вручную
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setActiveForm("open")}
              data-testid={`button-open-still-open-form-${position.sourceSignalId}`}>
              Ввести открытое количество вручную
            </Button>
          </div>
        </div>
      )}
      {activeForm === "closed" && <ClosedForm sourceSignalId={position.sourceSignalId} remainingQty={position.remainingQty} onDone={() => setActiveForm(null)} />}
      {activeForm === "open" && <StillOpenForm sourceSignalId={position.sourceSignalId} onDone={() => setActiveForm(null)} />}
    </article>
  );
}

function LegacyPreRunnerCloseCard({ intent }: { intent: JournalVstReviewLegacyPreRunnerCloseIntent }) {
  const queryClient = useQueryClient();
  const resolve = useResolveJournalVstReviewPreRunnerClose();
  const [clientOrderId, setClientOrderId] = useState(intent.clientOrderId);
  const [confirmation, setConfirmation] = useState(false);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: getGetJournalVstReviewQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetJournalVstPositionsQueryKey() });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (clientOrderId.trim() !== intent.clientOrderId) {
      setMessage({ tone: "error", text: "Введите точный clientOrderId исходной неоднозначной операции." });
      return;
    }
    if (!confirmation) {
      setMessage({ tone: "error", text: "Сначала подтвердите проверку на BingX и понимание последствий." });
      return;
    }
    setMessage(null);
    resolve.mutate({
      sourceSignalId: intent.sourceSignalId,
      data: { clientOrderId: clientOrderId.trim(), confirmation: true, note: note.trim() || null },
    }, {
      onSuccess: (result) => {
        setMessage({
          tone: "success",
          text: result.outcome === "replayed"
            ? "Это решение уже было сохранено ранее; запись журнала обновлена."
            : "Старая неоднозначная операция разрешена. Исходный ордер не повторялся.",
        });
        invalidate();
      },
      onError: (failure) => {
        const data = (failure as { data?: { error?: string; reason?: string } }).data;
        const detail = data?.reason ?? data?.error;
        setMessage({
          tone: "error",
          text: detail
            ? `Решение отклонено (${detail}). Ничего не повторялось и защитные ордера не отменялись.`
            : "Не удалось разрешить старую операцию. Проверьте актуальный статус и повторите только после проверки BingX.",
        });
        invalidate();
      },
    });
  }

  return (
    <article className="border border-destructive/50 bg-card p-4" data-testid={`review-legacy-pre-runner-close-${intent.sourceSignalId}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-muted-foreground">{intent.sourceSignalId}</p>
          <p className="mt-0.5 text-lg font-bold">{intent.symbol}</p>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">clientOrderId: {intent.clientOrderId}</p>
        </div>
        <p className="text-xs text-muted-foreground">{formatDate(intent.timestamp)}</p>
      </div>
      <p className="mt-3 text-sm font-semibold text-destructive">
        Результат старой MARKET-заявки неизвестен. Это НЕ доказывает, что заявка не была отправлена.
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Причина: {intent.reason ?? "неизвестна"}. До решения проверьте BingX напрямую: позиция либо осталась без изменений
        и оба бот-стопа на месте, либо позиция закрыта с полным набором подтверждённых исполнений.
        Если нельзя подтвердить один из этих вариантов, не подтверждайте решение.
      </p>
      <form onSubmit={handleSubmit} className="mt-3 space-y-3 border-t border-border pt-3">
        <div>
          <FieldLabel htmlFor={`legacy-client-order-${intent.sourceSignalId}`}>Точный clientOrderId исходной операции</FieldLabel>
          <Input id={`legacy-client-order-${intent.sourceSignalId}`} required value={clientOrderId}
            onChange={(event) => setClientOrderId(event.target.value)} />
        </div>
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" className="mt-0.5" checked={confirmation}
            onChange={(event) => setConfirmation(event.target.checked)}
            data-testid={`checkbox-confirm-legacy-pre-runner-close-${intent.sourceSignalId}`} />
          <span>
            Я проверил(а) на BingX один из указанных выше вариантов. Понимаю: решение не повторяет исходный MARKET-ордер
            и не отменяет стопы; после него может возобновиться обычное автоматическое управление и может появиться
            новая операция, но исходная заявка не отправляется повторно.
          </span>
        </label>
        <div>
          <FieldLabel htmlFor={`legacy-close-note-${intent.sourceSignalId}`}>Заметка (необязательно)</FieldLabel>
          <Textarea id={`legacy-close-note-${intent.sourceSignalId}`} rows={2} value={note}
            onChange={(event) => setNote(event.target.value)} />
        </div>
        {message && (
          <p role={message.tone === "error" ? "alert" : "status"}
            className={`text-sm ${message.tone === "error" ? "text-destructive" : "text-muted-foreground"}`}>
            {message.text}
          </p>
        )}
        <Button type="submit" disabled={resolve.isPending || !confirmation || clientOrderId.trim() !== intent.clientOrderId}
          data-testid={`button-resolve-legacy-pre-runner-close-${intent.sourceSignalId}`}>
          {resolve.isPending ? "Сохраняем…" : "Разрешить старую операцию"}
        </Button>
      </form>
    </article>
  );
}

const MARGIN_TOP_UP_ERROR_MESSAGES: Record<string, string> = {
  VST_MARGIN_TOP_UP_ALREADY_ADDED:
    "История BingX содержит добавление маржи. Она не позволяет установить, было ли это действие бота или отдельное ручное действие. Ничего не изменено; не повторяйте заявку.",
  VST_MARGIN_TOP_UP_MARGIN_MISMATCH:
    "Полная история BingX не позволяет доказать отсутствие пополнения. Значение initialMargin остаётся исходной величиной и не показывает последующие пополнения. Ничего не изменено.",
  VST_MARGIN_TOP_UP_POSITION_NOT_FOUND_ON_EXCHANGE:
    "На BingX не найдено позиции, которую можно однозначно сопоставить с этой записью — возможно, она уже закрыта. Используйте форму «Закрыта на BingX» вместо этой.",
  VST_MARGIN_TOP_UP_CHECK_UNAVAILABLE:
    "Не удалось выполнить автоматическую проверку на BingX. Ничего не изменено — попробуйте ещё раз.",
  VST_WORKER_NOT_ACTIVE:
    "Бот сейчас не активен, автоматическая проверка недоступна. Попробуйте ещё раз позже.",
  VST_POSITION_NOT_AWAITING_REVIEW:
    "Позиция больше не ожидает этого решения. Проверьте актуальный статус ниже.",
};

function marginTopUpErrorMessage(errorCode: unknown): string {
  if (typeof errorCode === "string" && MARGIN_TOP_UP_ERROR_MESSAGES[errorCode]) {
    return MARGIN_TOP_UP_ERROR_MESSAGES[errorCode];
  }
  return "Не удалось сохранить подтверждение. Проверьте актуальный статус ниже и повторите при необходимости.";
}

function MarginTopUpKeepOpenForm({ sourceSignalId, onDone }: { sourceSignalId: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const resolve = useResolveJournalVstReviewMarginTopUpKeepOpen();
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: getGetJournalVstReviewQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetJournalVstPositionsQueryKey() });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    resolve.mutate({
      sourceSignalId,
      data: { note: note.trim() || null },
    }, {
      onSuccess: () => { invalidate(); onDone(); },
      onError: (mutationError) => {
        const data = (mutationError as unknown as { data?: { error?: unknown } } | undefined)?.data;
        setError(marginTopUpErrorMessage(data?.error));
        invalidate();
      },
    });
  }

  return (
    <form onSubmit={handleSubmit} className="mt-3 space-y-3 border-t border-border pt-3" aria-label="Подтвердить, что маржа не добавлена">
      <p className="text-xs text-muted-foreground">
        Сервер заново проверит на BingX полную историю добавлений, позицию, исходный стоп и запас до ликвидации.
        Если история содержит добавление или любое чтение неполно, решение будет отклонено. BingX не связывает запись
        истории с конкретным POST; эта форма не отправляет и не повторяет заявку, а обновляет только статус журнала.
      </p>
      <div>
        <FieldLabel htmlFor={`note-margin-${sourceSignalId}`}>Заметка (необязательно)</FieldLabel>
        <Textarea id={`note-margin-${sourceSignalId}`} rows={2} value={note}
          onChange={(event) => setNote(event.target.value)} />
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={resolve.isPending} data-testid={`button-confirm-margin-keep-open-${sourceSignalId}`}>
          Подтвердить: маржа не добавлена, оставить открытой
        </Button>
        <Button type="button" variant="ghost" disabled={resolve.isPending} onClick={onDone}>
          Отмена
        </Button>
      </div>
    </form>
  );
}

function closeMarginTopUpNowReasonMessage(reason: string | null | undefined): string {
  if (reason && CLOSE_NOW_REASON_MESSAGES[reason]) return CLOSE_NOW_REASON_MESSAGES[reason];
  const detail = reason ? ` (причина: ${reason})` : "";
  return `Бот не смог безопасно подтвердить закрытие${detail}. На бирже ничего не изменено без проверки — попробуйте ещё раз.`;
}

const MARGIN_TOP_UP_CHECK_MESSAGES: Record<string, string> = {
  position_not_found_on_exchange: "На BingX сейчас нет соответствующей позиции по этому символу и ID.",
  read_unavailable: "Не удалось прочитать BingX. Проверку можно запросить ещё раз вручную.",
  unavailable: "Полная история BingX не доказывает, было ли пополнение. Текущий initialMargin — только величина при входе; он не подтверждает ни наличие маржи после пополнения, ни отправку заявки ботом.",
};

function MarginTopUpLiveCheck({ sourceSignalId }: { sourceSignalId: string }) {
  const { data, isError, isFetching, refetch } = useGetJournalVstReviewMarginTopUpCheck(
    sourceSignalId,
    {
      query: {
        queryKey: getGetJournalVstReviewMarginTopUpCheckQueryKey(sourceSignalId),
        enabled: false,
        refetchInterval: false,
        retry: false,
      },
    },
  );

  return (
    <div className="mt-3 space-y-2" data-testid={`margin-top-up-check-${sourceSignalId}`}>
      <Button type="button" variant="outline" size="sm" disabled={isFetching}
        onClick={() => { void refetch(); }}
        data-testid={`button-check-margin-top-up-${sourceSignalId}`}>
        {isFetching ? "Читаем BingX…" : "Проверить историю на BingX"}
      </Button>
      {isError && (
        <p className="text-xs text-muted-foreground" data-testid={`margin-top-up-check-error-${sourceSignalId}`}>
          Не удалось выполнить проверку. Никакие заявки не отправлялись; повторите её вручную позже.
        </p>
      )}
      {!isError && data?.outcome !== "ok" && (
        <p className="text-xs text-muted-foreground" data-testid={`margin-top-up-check-${data?.outcome ?? "not-requested"}-${sourceSignalId}`}>
          {data
            ? MARGIN_TOP_UP_CHECK_MESSAGES[data.outcome] ?? MARGIN_TOP_UP_CHECK_MESSAGES.unavailable
            : "Проверка не запрашивалась. Эта кнопка выполняет только чтение; решение перед сохранением проверяется заново."}
        </p>
      )}
      {!isError && data?.outcome === "ok" && (
        <div
          className="border border-border bg-muted/40 p-2 text-sm"
          data-testid={`margin-top-up-check-ok-${sourceSignalId}`}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Начальная маржа при открытии (BingX initialMargin){isFetching ? " (обновляется…)" : ""}
            </p>
            <p className="font-mono font-semibold" data-testid={`margin-top-up-observed-${sourceSignalId}`}>
              {number(data.isolatedMargin)}
            </p>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Это исходный baseline, а не текущая сумма обеспечения: BingX initialMargin не увеличивается после добавления маржи.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Полная история BingX не содержит добавления с момента намерения; исходный стоп и запас до ликвидации подтверждены.
            Эта проверка не доказывает, кто инициировал POST.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Проверено: {formatDate(data.observedAt)}
          </p>
        </div>
      )}
    </div>
  );
}

function MarginTopUpReviewCard({ position }: { position: JournalVstReviewPositionsMarginTopUpPendingItem }) {
  const [formOpen, setFormOpen] = useState(false);
  return (
    <article className="border border-destructive/40 bg-card p-4" data-testid={`review-margin-top-up-${position.sourceSignalId}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-muted-foreground">{position.sourceSignalId}</p>
          <p className="mt-0.5 text-lg font-bold">{position.symbol}</p>
        </div>
        <p className="text-xs text-muted-foreground">{formatDate(position.updatedAt)}</p>
      </div>
      <p className="mt-2 text-xs text-destructive">
        В журнале позиция отмечена открытой, но факт пополнения маржи не подтверждён. Сверьте фактическую позицию и
        активный стоп на BingX; работа по этому символу остаётся заблокированной до разрешения спорной операции.
        Независимые символы обрабатываются отдельно
        {position.reason ? ` (причина: ${position.reason})` : ""}.
      </p>
      <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
        <div><dt className="text-xs text-muted-foreground">Цена входа</dt><dd className="font-mono">{number(position.entryPrice)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Стоп</dt><dd className="font-mono">{number(position.stopPrice)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Планировалось добавить</dt><dd className="font-mono">{number(position.topUpAmount)}</dd></div>
      </dl>
      <MarginTopUpLiveCheck sourceSignalId={position.sourceSignalId} />
      {!formOpen && (
        <div className="mt-3 flex flex-wrap items-start gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setFormOpen(true)}
            data-testid={`button-open-margin-keep-open-form-${position.sourceSignalId}`}>
            Проверил(а) на BingX — маржа не добавлена
          </Button>
          <CloseMarginTopUpNowButton sourceSignalId={position.sourceSignalId} />
        </div>
      )}
      {formOpen && <MarginTopUpKeepOpenForm sourceSignalId={position.sourceSignalId} onDone={() => setFormOpen(false)} />}
    </article>
  );
}

export default function JournalVstReview() {
  const { data, isLoading, error, refetch } = useGetJournalVstReview({
    query: { queryKey: getGetJournalVstReviewQueryKey(), refetchInterval: 15000 },
  });
  const legacyReviewSignalIds = new Set(
    data?.legacyPreRunnerCloseIntents.map(intent => intent.sourceSignalId) ?? [],
  );
  const ordinaryReviewPositions = data?.positions.filter(
    position => !legacyReviewSignalIds.has(position.sourceSignalId),
  ) ?? [];

  return (
    <div className="page-frame mx-auto max-w-3xl space-y-5" data-testid="page-vst-review">
      <div className="border-b border-border pb-4">
        <Link href="/journal/vst" className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Назад к VST
        </Link>
        <p className="position-book-label mt-2">VST / Ручной разбор</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Позиции, ожидающие решения</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Автоматика остановлена для этих позиций после неподтверждённой попытки закрытия. Проверьте BingX напрямую и
          подтвердите, что действительно произошло — ничего не подставляется автоматически.
        </p>
        <a href="#runner-close-history" className="mt-3 inline-block text-xs font-semibold underline">
          История решений по старым закрытиям runner
        </a>
      </div>
      {isLoading && (
        <div className="space-y-3" role="status" data-testid="status-vst-review-loading">
          <Skeleton className="h-32 w-full rounded-none" />
        </div>
      )}
      {!isLoading && (error || !data) && (
        <div className="border border-border bg-card p-5" role="status" data-testid="status-vst-review-unavailable">
          <p className="font-semibold">Не удалось загрузить список</p>
          <button type="button" onClick={() => { void refetch(); }}
            className="mt-4 inline-flex items-center gap-2 border border-border px-3 py-2 text-xs font-bold uppercase hover:bg-secondary">
            <RefreshCw className="h-3.5 w-3.5" /> Повторить
          </button>
        </div>
      )}
      {!isLoading && data && data.positions.length === 0 && data.marginTopUpPending.length === 0 &&
        data.legacyPreRunnerCloseIntents.length === 0 && (
        <div className="border border-border bg-card p-5 text-sm text-muted-foreground" data-testid="status-vst-review-empty">
          Нет позиций, ожидающих ручного решения.
        </div>
      )}
      {!isLoading && data && data.legacyPreRunnerCloseIntents.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Старые неизвестные закрытия runner</h2>
          {data.legacyPreRunnerCloseIntents.map((intent) => (
            <LegacyPreRunnerCloseCard key={intent.clientOrderId} intent={intent} />
          ))}
        </div>
      )}
      {!isLoading && data && data.marginTopUpPending.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Не подтверждено пополнение маржи</h2>
          {data.marginTopUpPending.map((position) => (
            <MarginTopUpReviewCard key={position.sourceSignalId} position={position} />
          ))}
        </div>
      )}
      {!isLoading && data && ordinaryReviewPositions.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Неоднозначное закрытие</h2>
          {ordinaryReviewPositions.map((position) => <ReviewCard key={position.sourceSignalId} position={position} />)}
        </div>
      )}
      {!isLoading && !error && data && <PreRunnerCloseHistory items={data.legacyPreRunnerCloseHistory} />}
    </div>
  );
}

function CloseMarginTopUpNowButton({ sourceSignalId }: { sourceSignalId: string }) {
  const queryClient = useQueryClient();
  const closeNow = useCloseJournalVstReviewMarginTopUpNow();
  const [message, setMessage] = useState<{ tone: "success" | "info" | "error"; text: string } | null>(null);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: getGetJournalVstReviewQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetJournalVstPositionsQueryKey() });
  }

  function handleClick() {
    setMessage(null);
    closeNow.mutate({ sourceSignalId }, {
      onSuccess: (data) => {
        if (data.outcome === "closed") {
          setMessage({ tone: "success", text: "Готово: бот выставил рыночную заявку на BingX, подтвердил закрытие по данным биржи и снял блокировку с остальной торговли." });
          invalidate();
          return;
        }
        if (data.outcome === "already_flat") {
          setMessage({ tone: "info", text: "На BingX по этому символу уже нет открытой позиции — бот не отправлял заявок. Обновите страницу: запись должна перейти в обычную сверку." });
          invalidate();
          return;
        }
        setMessage({ tone: "error", text: closeMarginTopUpNowReasonMessage(data.reason) });
      },
      onError: () => {
        setMessage({ tone: "error", text: "Не удалось выполнить закрытие. Попробуйте ещё раз." });
      },
    });
  }

  return (
    <div>
      <Button type="button" variant="destructive" onClick={handleClick} disabled={closeNow.isPending}
        data-testid={`button-close-margin-top-up-now-${sourceSignalId}`}>
        {closeNow.isPending ? "Закрываем…" : "Закрыть сейчас"}
      </Button>
      {message && (
        <p role="status" className={`mt-2 max-w-md text-xs ${message.tone === "error" ? "text-destructive" : "text-muted-foreground"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
