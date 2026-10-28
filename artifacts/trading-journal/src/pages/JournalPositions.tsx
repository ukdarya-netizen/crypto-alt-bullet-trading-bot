import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowUpRight, ChevronDown, RefreshCw } from "lucide-react";
import {
  getGetJournalBotQueryKey, getGetJournalBingxPositionsQueryKey, getGetJournalVstPositionsQueryKey,
  getGetJournalVstReviewQueryKey,
  useGetJournalBot, useGetJournalBingxPositions, useGetJournalVstPositions, useGetJournalVstReview,
} from "@workspace/api-client-react";
import type { BingXAccountPosition, BingXAccountRecentClosedTradesTradesItem, JournalBotPositionsItem, JournalBotRecentClosedPositionsItem, JournalVstPositionsPositionsItem, JournalVstPositionsRecentClosedPositionsItem } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate, formatNumber } from "@/lib/utils";
import { sortPositionsNewestFirst } from "@/lib/position-order";
import { VstEntryQueue } from "@/components/VstEntryQueue";
import { exchangeHistoryClosedAccounting } from "./vst-closed-history";

type Mode = "paper" | "real" | "vst";
type Position = {
  id: string;
  symbol: string;
  side: string;
  size: string;
  entry: string;
  current: string;
  pnl: string | null;
  stop: string;
  status: string;
  details: { label: string; value: string }[];
};

function number(value: unknown, digits = 4): string {
  if (value === null || value === undefined || value === "") return "—";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? formatNumber(parsed, digits) : "—";
}
function price(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return "—";
  const magnitude = Math.abs(parsed);
  const digits = magnitude >= 100 ? 2 : magnitude >= 1 ? 4
    : magnitude >= 0.01 ? 6 : magnitude >= 0.0001 ? 8 : 10;
  return formatNumber(parsed, digits);
}
function signedPercent(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? `${parsed > 0 ? "+" : ""}${formatNumber(parsed, 4)}%`
    : "—";
}
function text(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "—";
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function feeText(fee: unknown): string | null {
  const f = record(fee);
  const amount = number(f.amount, 6);
  const asset = typeof f.asset === "string" && f.asset.trim() ? f.asset : null;
  if (amount === "—" || !asset) return null;
  return `${amount} ${asset}`;
}
// Machine-readable closeReason literals the VST worker/policy actually emit
// (see vst-policy.mjs / vst-worker.mjs). Not schema-enumerated, so an
// unrecognized value still renders as its raw string rather than "—".
const VST_CLOSE_REASON_LABELS: Record<string, string> = {
  protective_stop: "Сработал защитный стоп",
  runner_stop: "Сработал стоп раннера",
  runner_max_age_expiry: "Раннер закрыт по истечении времени",
  percentage_point_trailing_stop: "Сработал трейлинг-стоп",
  protected_profit_floor: "Зафиксирована защищённая прибыль",
  breakeven_stop: "Сработал стоп в безубыток",
  runner_break_even_unavailable_at_or_below_entry: "Раннер закрыт: безубыток недостижим",
  external_close_verified_flat: "Закрыта вне бота (на бирже позиции нет, проверено)",
  fixed_price_take_profit_5pct: "Тейк +5%",
  fixed_price_take_profit_8pct: "Тейк +8%",
  fixed_price_take_profit_10pct: "Тейк +10%",
};
function vstCloseReasonLabel(reason: unknown, hasTriggeredStop: boolean): string {
  if (typeof reason === "string" && reason.trim()) {
    return VST_CLOSE_REASON_LABELS[reason] ?? reason;
  }
  return hasTriggeredStop ? "Стоп исполнен на бирже (подтверждено)" : "Закрыта автоматически";
}
// Machine-readable exit-fill reason literals the PAPER engine actually emits
// (see engine.mjs). Not schema-enumerated, so an unrecognized value still
// renders as its raw (underscore-stripped) string rather than "—".
const PAPER_CLOSE_REASON_LABELS: Record<string, string> = {
  protective_stop: "Сработал защитный стоп",
  legacy_unsplittable_protective_stop: "Сработал защитный стоп (старый неделимый размер)",
  runner_stop: "Сработал стоп раннера",
  runner_breakeven_emergency_stop: "Раннер закрыт аварийным стопом в безубыток",
  runner_max_age_expiry: "Раннер закрыт по истечении времени",
  legacy_unsplittable_max_watch_expiry: "Закрыта по истечении срока наблюдения (старый неделимый размер)",
  max_watch_expiry: "Закрыта по истечении срока наблюдения",
  close_runner: "Раннер закрыт",
  close_core: "Основная часть закрыта",
};
function paperCloseReasonLabel(reason: unknown): string {
  if (typeof reason === "string" && reason.trim()) {
    return PAPER_CLOSE_REASON_LABELS[reason] ?? reason.replaceAll("_", " ");
  }
  return "Закрыта автоматически";
}
function fresh(value: string | null | undefined, now: number): boolean {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) && now - time >= -5000 && now - time <= 90000;
}
function pnlText(value: string | null, roePercent?: string | null): string | null {
  if (value === null || value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const base = `${n > 0 ? "+" : ""}${formatNumber(n, 2)} USDT`;
  const roe = roePercent !== undefined && roePercent !== null ? Number(roePercent) : NaN;
  return Number.isFinite(roe) ? `${base} (${roe > 0 ? "+" : ""}${formatNumber(roe, 2)}%)` : base;
}
function paperPosition(position: JournalBotPositionsItem, now: number): Position {
  const s = position.snapshot;
  const quoteFresh = position.market.quoteStatus === "fresh" && fresh(position.market.quoteAt, now);
  const runnerOnly = s.runnerOpen === true && s.coreOpen === false;
  const stop = runnerOnly ? position.marginRisk.stopPriceUsed ?? s.runnerStopPrice : s.stopPrice;
  return {
    id: position.sourceSignalId,
    symbol: text(s.symbol),
    side: typeof s.side === "string" ? s.side.toUpperCase() : "LONG",
    size: number(s.remainingQty ?? s.quantity, 6),
    entry: price(s.entryPrice),
    current: quoteFresh ? price(position.market.quotePrice) : "—",
    pnl: quoteFresh ? pnlText(position.market.unrealizedPnlUsdt, position.market.roePercent) : null,
    stop: price(stop),
    status: position.status === "closing" ? "Закрывается" : "Открыта",
    details: [
      { label: "Сигнал", value: position.sourceSignalId },
      { label: "Котировка", value: quoteFresh ? `${position.market.priceBasis} · ${formatDate(position.market.quoteAt!)}` : "Нет свежей котировки" },
      { label: "Открыта", value: typeof s.entryAt === "string" ? formatDate(s.entryAt) : "—" },
      { label: "Маржа PAPER", value: `${number(s.marginHeldUsd, 4)} USDT` },
      { label: "Источник", value: "Симуляция бота; стоп не является биржевым ордером" },
    ],
  };
}
function realPosition(position: BingXAccountPosition, index: number, available: boolean): Position {
  return {
    id: `${position.symbol}-${position.side}-${index}`,
    symbol: position.symbol || "—",
    side: position.side ?? "—",
    size: number(position.size, 6),
    entry: price(position.entryPrice),
    current: available ? price(position.markPrice) : "—",
    pnl: available ? pnlText(position.unrealizedPnlUsdt, position.roePercent) : null,
    stop: price(position.stopPrice),
    status: "Открыта",
    details: [
      { label: "Маржа", value: `${number(position.marginUsdt, 4)} USDT` },
      { label: "Режим / плечо", value: `${position.marginMode ?? "—"} / ${position.leverage ?? "—"}×` },
      { label: "Ликвидация", value: price(position.liquidationPrice) },
      { label: "Открыта", value: position.openedAt ? formatDate(position.openedAt) : "—" },
      { label: "Источник", value: "Весь счёт BingX; связь с ботом не установлена. Неизвестный стоп не означает отсутствие ордера." },
    ],
  };
}
function vstPosition(position: JournalVstPositionsPositionsItem): Position {
  const hasLiveRead = position.currentPrice !== null;
  const status = position.sourceMismatch
    ? "Биржа не подтверждает"
    : position.protectionStatus === "protected_degraded" ? "Защита есть · усиление отложено"
      : position.protectionStatus === "protection_observed_attribution_unknown" ? "Усиленная защита подтверждена · POST неизвестен"
      : position.status === "open" ? "Открыта"
      : position.status === "closing" ? "Закрывается" : "Неизвестно";
  return {
    id: position.sourceSignalId,
    symbol: position.symbol || "—",
    side: "—",
    size: number(position.exchangeQuantity ?? position.remainingQty, 6),
    entry: price(position.entryPrice),
    current: hasLiveRead ? price(position.currentPrice) : "—",
    pnl: hasLiveRead ? pnlText(position.unrealizedPnlUsdt, position.roePercent) : null,
    stop: price(position.stopPrice),
    status,
    details: [
      ...(position.protectionStatus ? [
        { label: "Подтверждённый защитный стоп", value: price(position.stopPrice) },
        { label: position.protectionStatus === "protected_degraded"
          ? "Запрошенная защита прибыли (не подтверждена)" : "Запрошенный уровень (наблюдается на бирже)",
          value: price(position.deferredStopPrice) },
        { label: "Защита проверена", value: position.protectionObservedAt ? formatDate(position.protectionObservedAt) : "—" },
        { label: "Ограничения", value: "Биржевые записи изолированы; мониторинг продолжается. Исходный POST остаётся неизвестным." },
      ] : []),
      { label: "Сигнал", value: position.sourceSignalId },
      { label: "Запись обновлена", value: formatDate(position.updatedAt) },
      { label: "Цена сигнала (источник)", value: price(position.signalReferencePrice) },
      {
        label: "Котировка для расчёта",
        value: position.planningQuotePrice
          ? `${price(position.planningQuotePrice)}${position.planningQuoteObservedAt
            ? ` · ${formatDate(position.planningQuoteObservedAt)}` : ""}`
          : "—",
      },
      {
        label: "Отклонение котировки от сигнала",
        value: signedPercent(position.planningPriceDeviationPct),
      },
      {
        label: "Подтверждённое исполнение BingX",
        value: position.entryFillAt
          ? `${price(position.entryPrice)} · ${formatDate(position.entryFillAt)}`
          : price(position.entryPrice),
      },
      {
        label: "Отклонение исполнения от сигнала",
        value: signedPercent(position.actualFillDeviationPct),
      },
      ...(position.sourceMismatch ? [{
        label: "Расхождение",
        value: "Свежее чтение BingX VST не увидело эту позицию по символу. Запись в леджере не изменена автоматически — нужна ручная сверка.",
      }] : []),
      {
        label: "Источник",
        value: hasLiveRead
          ? "BingX VST (демо-счёт), свежее чтение биржи"
          : "VST ledger; свежее чтение биржи недоступно, показан только сохранённый снимок",
      },
    ],
  };
}

type ClosedPosition = {
  id: string;
  symbol: string;
  closedAt: string | null;
  isManual: boolean;
  kindLabel?: string;
  reasonLabel: string;
  resultLabel?: string;
  resultNote?: string;
  fillPrice: string;
  fillQuantity: string;
  sourceReferencePrice: string | null;
  planningQuotePrice: string | null;
  planningQuoteObservedAt: string | null;
  planningPriceDeviationPct: string;
  entryPrice: string;
  entryFillAt: string | null;
  actualFillDeviationPct: string;
  fee: string | null;
  exchangeOrderId: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  note: string | null;
  pnlUsdt: number | null;
  roePercent: number | null;
  exchangeHistoryAccounting?: {
    grossPnlUsdt: number | null;
    knownFeeExpenseUsdt: number | null;
    knownAfterFeesUsdt: number | null;
    feeAsset: "VST" | "USDT" | null;
  };
};
// Combined "+12.34 USDT (+45.6%)" result text, reusing the same formatting
// as open positions so closed and open PnL read the same way at a glance.
function resultText(pnlUsdt: number | null, roePercent: number | null): string {
  if (pnlUsdt === null) return "—";
  return pnlText(String(pnlUsdt), roePercent !== null ? String(roePercent) : null) ?? "—";
}
// "чтобы не вглядываться": color is the primary signal, not the sign character.
function pnlColorClass(pnlUsdt: number | null): string {
  if (pnlUsdt === null || pnlUsdt === 0) return "";
  return pnlUsdt > 0 ? "text-success" : "text-destructive";
}
function pnlBarClass(pnlUsdt: number | null): string {
  if (pnlUsdt === null || pnlUsdt === 0) return "bg-muted-foreground/40";
  return pnlUsdt > 0 ? "bg-success" : "bg-destructive";
}
function isoTime(value: unknown): string | null {
  const milliseconds = typeof value === "number"
    ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(milliseconds) && milliseconds > 0
    ? new Date(milliseconds).toISOString() : null;
}
// Reads only fields already stored on the snapshot. Exchange-history repairs
// use their two actual fills and signed commissions; other close paths retain
// their established fee handling. manualResolution can also record an earlier
// "still_open" review outcome, so only outcome === "closed" counts as manual.
function vstClosedPosition(position: JournalVstPositionsRecentClosedPositionsItem): ClosedPosition {
  const snapshot = record(position.snapshot);
  const priceAudit = record(snapshot.priceAudit);
  const sizing = record(snapshot.sizing);
  const sourceSignal = record(snapshot.signalSnapshot);
  const verifiedFill = record(snapshot.verifiedFill);
  const entryIntent = record(snapshot.entryIntent);
  const reconciledEntryOutcome = record(
    snapshot.reconciledEntryOutcome ?? snapshot.reconciledOutcome ??
    snapshot.entryOutcome ?? entryIntent.outcome,
  );
  const manualResolution = record(snapshot.manualResolution);
  const isManual = manualResolution.outcome === "closed";
  const historyAccounting = exchangeHistoryClosedAccounting(
    snapshot,
    position.updatedAt,
  );
  const provenance = record(snapshot.exchangeHistoryProvenance);
  const historyCloseFill = record(provenance.closeFill);
  const fill = historyAccounting
    ? historyCloseFill
    : record(snapshot.closeFill ?? snapshot.lastCloseFill);
  const hasTriggeredStop = Object.keys(record(snapshot.triggeredStop)).length > 0;
  const closeReason = historyAccounting ? "exchange_history_provenance"
    : isManual ? "manual_owner_resolution"
    : typeof snapshot.closeReason === "string" ? snapshot.closeReason : null;
  const closedAt = historyAccounting?.closedAt ??
    (typeof snapshot.closedAt === "string" ? snapshot.closedAt
      : typeof fill.at === "string" ? fill.at : position.updatedAt);
  // VST only ever opens long positions at fixed 10x isolated leverage (see
  // vst-worker.mjs). Existing close paths keep their former result calculation;
  // exchange-history repairs instead expose the known result after both actual
  // commissions while explicitly leaving unverified funding out of the claim.
  const VST_LEVERAGE = 10;
  const entryPrice = Number(
    historyAccounting?.entryPrice ?? verifiedFill.price ??
    reconciledEntryOutcome.fillPrice ?? reconciledEntryOutcome.price ?? snapshot.entryPrice,
  );
  const closePrice = Number(fill.price);
  const quantity = Number(fill.quantity);
  const feeAmount = Number(record(fill.fee ?? fill.fees).amount);
  const hasPnlInputs = Number.isFinite(entryPrice) && entryPrice > 0 &&
    Number.isFinite(closePrice) && closePrice > 0 &&
    Number.isFinite(quantity) && quantity > 0;
  const legacyPnlUsdt = hasPnlInputs
    ? Number(((closePrice - entryPrice) * quantity - (Number.isFinite(feeAmount) ? feeAmount : 0)).toFixed(8))
    : null;
  const pnlUsdt = historyAccounting
    ? historyAccounting.knownAfterFeesUsdt
    : legacyPnlUsdt;
  const margin = hasPnlInputs ? (entryPrice * quantity) / VST_LEVERAGE : null;
  const roePercent = !historyAccounting && pnlUsdt !== null && margin !== null && margin > 0
    ? Number(((pnlUsdt / margin) * 100).toFixed(2))
    : null;
  const historyFee = historyAccounting
    ? [
        feeText({ amount: historyAccounting.entryCommissionUsdt, asset: historyAccounting.feeAsset }),
        feeText({ amount: historyAccounting.closeCommissionUsdt, asset: historyAccounting.feeAsset }),
      ].map((fee, index) => fee ? `${index === 0 ? "вход" : "выход"}: ${fee}` : null)
        .filter((fee): fee is string => fee !== null).join(" · ") || null
    : null;
  return {
    id: position.sourceSignalId,
    symbol: position.symbol || "—",
    closedAt,
    isManual,
    kindLabel: historyAccounting ? "История биржи" : undefined,
    reasonLabel: historyAccounting ? "Закрыта по истории биржи"
      : isManual ? "Ручное решение владельца" : vstCloseReasonLabel(closeReason, hasTriggeredStop),
    resultLabel: historyAccounting ? "Известно после комиссий" : undefined,
    resultNote: historyAccounting
      ? "Funding не подтверждён; комиссии VST показаны отдельно без пересчёта в USDT. Это не итоговый net PnL."
      : undefined,
    fillPrice: price(fill.price),
    fillQuantity: number(fill.quantity, 6),
    sourceReferencePrice: price(
      priceAudit.signalReferencePrice ?? sourceSignal.referencePrice ?? sizing.signalReferencePrice,
    ),
    planningQuotePrice: price(priceAudit.planningQuotePrice ?? sizing.quotePrice),
    planningQuoteObservedAt: isoTime(
      priceAudit.planningQuoteObservedAt ?? sizing.quoteObservedAtMs,
    ),
    planningPriceDeviationPct: signedPercent(
      priceAudit.planningPriceDeviationPct ?? sizing.signalPriceDeviationPct,
    ),
    entryPrice: price(historyAccounting?.entryPrice ?? verifiedFill.price ??
      reconciledEntryOutcome.fillPrice ?? reconciledEntryOutcome.price ?? snapshot.entryPrice),
    entryFillAt: isoTime(historyAccounting?.entryFillAt ??
      priceAudit.verifiedFillAt ?? verifiedFill.at ??
      reconciledEntryOutcome.at ?? reconciledEntryOutcome.fillAt),
    actualFillDeviationPct: signedPercent(priceAudit.actualFillDeviationPct),
    fee: historyAccounting ? historyFee : feeText(fill.fee ?? fill.fees),
    exchangeOrderId: typeof fill.exchangeOrderId === "string" ? fill.exchangeOrderId
      : typeof fill.orderId === "string" ? fill.orderId : null,
    resolvedBy: isManual && typeof manualResolution.resolvedBy === "string" ? manualResolution.resolvedBy : null,
    resolvedAt: isManual && typeof manualResolution.resolvedAt === "string" ? manualResolution.resolvedAt : null,
    note: isManual && typeof manualResolution.note === "string" && manualResolution.note.trim() ? manualResolution.note : null,
    pnlUsdt,
    roePercent,
    exchangeHistoryAccounting: historyAccounting ? {
      grossPnlUsdt: historyAccounting.grossPnlUsdt,
      knownFeeExpenseUsdt: historyAccounting.knownFeeExpenseUsdt,
      knownAfterFeesUsdt: historyAccounting.knownAfterFeesUsdt,
      feeAsset: historyAccounting.feeAsset,
    } : undefined,
  };
}

// PAPER positions have no exchange order or manual-resolution concept, so the
// fourth grid cell shows realized PnL instead of an exchange order id.
function paperClosedPosition(position: JournalBotRecentClosedPositionsItem): ClosedPosition {
  const snapshot = record(position.snapshot);
  const fills = Array.isArray(snapshot.paperFills)
    ? snapshot.paperFills.map(record).filter((fill) => fill.type === "exit")
    : [];
  const lastExit = fills.at(-1) ?? {};
  const realizedPnl = Number(snapshot.realizedPnlUsdt);
  const pnlUsdt = Number.isFinite(realizedPnl) ? realizedPnl : null;
  // marginHeldUsd is reset to 0 once the position is fully closed; the margin
  // actually at risk is the base reservation plus any stop-buffer top-ups
  // recorded while it was open (see openPaperPosition/paper-margin in
  // store.mjs), which is what ROE is measured against.
  const paperMargin = record(snapshot.paperMargin);
  const baseMargin = Number(paperMargin.baseMarginUsdt);
  const addedMargin = Number(paperMargin.addedMarginUsdt);
  const margin = Number.isFinite(baseMargin)
    ? baseMargin + (Number.isFinite(addedMargin) ? addedMargin : 0)
    : null;
  const roePercent = pnlUsdt !== null && margin !== null && margin > 0
    ? Number(((pnlUsdt / margin) * 100).toFixed(2))
    : null;
  return {
    id: position.sourceSignalId,
    symbol: text(snapshot.symbol),
    closedAt: typeof position.updatedAt === "string" ? position.updatedAt : String(position.updatedAt),
    isManual: false,
    reasonLabel: paperCloseReasonLabel(lastExit.reason),
    fillPrice: price(lastExit.fillPrice ?? lastExit.price),
    fillQuantity: number(lastExit.quantity, 6),
    sourceReferencePrice: null,
    planningQuotePrice: null,
    planningQuoteObservedAt: null,
    planningPriceDeviationPct: "—",
    entryPrice: "—",
    entryFillAt: null,
    actualFillDeviationPct: "—",
    fee: feeText({ amount: lastExit.feeUsdt, asset: "USDT" }),
    exchangeOrderId: null,
    resolvedBy: null,
    resolvedAt: null,
    note: null,
    pnlUsdt,
    roePercent,
  };
}

// REAL has no ledger, so closes come straight from BingX's own income
// history (REALIZED_PNL / INSURANCE_CLEAR + matching closing-fee row). That
// history never reports fill price, quantity, or margin for a trade, so
// those cells stay "—" here and ROE% is left unavailable rather than guessed.
function realClosedPosition(trade: BingXAccountRecentClosedTradesTradesItem): ClosedPosition {
  const pnlUsdt = Number(trade.pnlUsdt);
  return {
    id: trade.tradeId,
    symbol: trade.symbol,
    closedAt: trade.closedAt,
    isManual: false,
    reasonLabel: trade.liquidation ? "Принудительная ликвидация" : "Закрыта на бирже",
    fillPrice: "—",
    fillQuantity: "—",
    sourceReferencePrice: null,
    planningQuotePrice: null,
    planningQuoteObservedAt: null,
    planningPriceDeviationPct: "—",
    entryPrice: "—",
    entryFillAt: null,
    actualFillDeviationPct: "—",
    fee: feeText({ amount: trade.feeUsdt, asset: "USDT" }),
    exchangeOrderId: trade.tradeId,
    resolvedBy: null,
    resolvedAt: null,
    note: null,
    pnlUsdt: Number.isFinite(pnlUsdt) ? pnlUsdt : null,
    roePercent: null,
  };
}

function ClosedPositionList({ mode, positions, empty }: { mode: Mode; positions: ClosedPosition[]; empty: string }) {
  return (
    <section className="position-book" data-testid={`section-${mode}-closed-positions`}>
      <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
        <h2 className="text-sm font-bold uppercase tracking-wider">Недавно закрытые <span className="ml-1 font-mono text-muted-foreground">{positions.length}</span></h2>
      </div>
      {positions.length === 0 ? (
        <div className="border-t border-border px-5 py-12 text-center" data-testid={`empty-${mode}-closed-positions`}>
          <p className="font-medium">{empty}</p>
        </div>
      ) : positions.map((position, index) => (
        <article key={`${position.id}-${index}`} className="position-book-row px-4 py-4 sm:px-5" data-testid={`card-${mode}-closed-position-${index}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className={`h-8 w-1 shrink-0 rounded-sm ${pnlBarClass(position.pnlUsdt)}`} />
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="break-all font-mono text-base font-bold tracking-tight sm:text-lg" data-testid={`text-${mode}-closed-symbol-${index}`}>{position.symbol}</h3>
                  <span
                    className={`border px-1.5 py-0.5 font-mono text-[10px] font-bold ${position.isManual ? "border-primary/40 text-primary" : "border-border text-muted-foreground"}`}
                    data-testid={`badge-${mode}-closed-kind-${index}`}
                  >
                    {position.kindLabel ?? (position.isManual ? "Ручное решение" : "Автоматически")}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground" data-testid={`text-${mode}-closed-reason-${index}`}>{position.reasonLabel}</p>
              </div>
            </div>
            <div className="sm:text-right" data-testid={`value-${mode}-closed-pnl-${index}`}>
              <p className="position-book-label">{position.resultLabel ?? "Результат · PnL и ROE"}</p>
              <p className={`position-book-value mt-1 text-base font-bold ${pnlColorClass(position.pnlUsdt)}`}>
                {resultText(position.pnlUsdt, position.roePercent)}
              </p>
              {position.resultNote && (
                <p className="mt-1 max-w-sm text-xs text-muted-foreground" data-testid={`note-${mode}-closed-accounting-${index}`}>
                  {position.resultNote}
                </p>
              )}
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3 border-t border-border/70 pt-3 sm:grid-cols-4">
            {[
              ["Цена закрытия", position.fillPrice], ["Объём", position.fillQuantity],
              ["Комиссия", position.fee ?? "—"],
              ["Закрыта", position.closedAt ? formatDate(position.closedAt) : "—"],
              ...(mode !== "paper" ? [["Ордер биржи", position.exchangeOrderId ?? "—"]] : []),
            ].map(([label, value]) => <div key={label} className="min-w-0"><p className="position-book-label">{label}</p><p className="position-book-value mt-1 break-all" data-testid={`value-${mode}-closed-${label}-${index}`}>{value}</p></div>)}
          </div>
          {mode === "vst" && (
            <dl className="mt-3 grid gap-3 border-t border-border/70 pt-3 text-xs sm:grid-cols-2">
              {position.exchangeHistoryAccounting && (
                <>
                  <div className="min-w-0"><dt className="position-book-label">Валовой результат</dt><dd className="mt-1 break-all font-mono" data-testid={`value-vst-closed-gross-result-${index}`}>{position.exchangeHistoryAccounting.grossPnlUsdt === null ? "—" : `${number(position.exchangeHistoryAccounting.grossPnlUsdt, 6)} USDT`}</dd></div>
                  <div className="min-w-0"><dt className="position-book-label">Расходы на комиссии входа и выхода</dt><dd className="mt-1 break-all font-mono" data-testid={`value-vst-closed-known-fees-${index}`}>{position.exchangeHistoryAccounting.knownFeeExpenseUsdt === null ? "—" : `${number(position.exchangeHistoryAccounting.knownFeeExpenseUsdt, 6)} ${position.exchangeHistoryAccounting.feeAsset ?? ""}`}</dd></div>
                  <div className="min-w-0"><dt className="position-book-label">Известно после комиссий (не net PnL)</dt><dd className="mt-1 break-all font-mono" data-testid={`value-vst-closed-after-fees-${index}`}>{position.exchangeHistoryAccounting.knownAfterFeesUsdt === null ? "—" : `${number(position.exchangeHistoryAccounting.knownAfterFeesUsdt, 6)} USDT`}</dd></div>
                  <div className="min-w-0 sm:col-span-2"><dt className="position-book-label">Funding</dt><dd className="mt-1 break-all font-mono" data-testid={`value-vst-closed-funding-status-${index}`}>Не проверен — результат после комиссий не является итоговым PnL.</dd></div>
                </>
              )}
              <div className="min-w-0"><dt className="position-book-label">Цена сигнала (источник)</dt><dd className="mt-1 break-all font-mono" data-testid={`value-vst-closed-source-reference-${index}`}>{position.sourceReferencePrice ?? "—"}</dd></div>
              <div className="min-w-0"><dt className="position-book-label">Котировка для расчёта</dt><dd className="mt-1 break-all font-mono" data-testid={`value-vst-closed-planning-quote-${index}`}>{position.planningQuotePrice ? `${position.planningQuotePrice}${position.planningQuoteObservedAt ? ` · ${formatDate(position.planningQuoteObservedAt)}` : ""}` : "—"}</dd></div>
              <div className="min-w-0"><dt className="position-book-label">Отклонение котировки от сигнала</dt><dd className="mt-1 break-all font-mono" data-testid={`value-vst-closed-planning-deviation-${index}`}>{position.planningPriceDeviationPct}</dd></div>
              <div className="min-w-0"><dt className="position-book-label">Подтверждённое исполнение BingX</dt><dd className="mt-1 break-all font-mono" data-testid={`value-vst-closed-entry-fill-${index}`}>{position.entryFillAt ? `${position.entryPrice} · ${formatDate(position.entryFillAt)}` : position.entryPrice}</dd></div>
              <div className="min-w-0 sm:col-span-2"><dt className="position-book-label">Отклонение исполнения от сигнала</dt><dd className="mt-1 break-all font-mono" data-testid={`value-vst-closed-actual-deviation-${index}`}>{position.actualFillDeviationPct}</dd></div>
            </dl>
          )}
          {position.isManual && (
            <details className="mt-3 border-t border-border/70 pt-2 text-xs">
              <summary className="flex w-fit items-center gap-1.5 py-1 text-muted-foreground hover:text-foreground" data-testid={`toggle-${mode}-closed-details-${index}`}>
                Детали ручного решения <ChevronDown className="position-chevron h-3.5 w-3.5" />
              </summary>
              <dl className="grid gap-3 pb-2 pt-3 sm:grid-cols-2">
                <div className="min-w-0"><dt className="position-book-label">Кем подтверждено</dt><dd className="mt-1 break-all font-mono text-xs" data-testid={`value-${mode}-closed-resolved-by-${index}`}>{position.resolvedBy ?? "—"}</dd></div>
                <div className="min-w-0"><dt className="position-book-label">Когда подтверждено</dt><dd className="mt-1 break-all font-mono text-xs">{position.resolvedAt ? formatDate(position.resolvedAt) : "—"}</dd></div>
                <div className="min-w-0 sm:col-span-2"><dt className="position-book-label">Комментарий</dt><dd className="mt-1 break-all font-mono text-xs" data-testid={`value-${mode}-closed-note-${index}`}>{position.note ?? "—"}</dd></div>
              </dl>
            </details>
          )}
        </article>
      ))}
    </section>
  );
}

function PositionList({ positions, mode, empty, note }: { positions: Position[]; mode: Mode; empty: string; note?: string }) {
  return (
    <section className="position-book" data-testid={`section-${mode}-positions`}>
      <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
        <h2 className="text-sm font-bold uppercase tracking-wider">Открытые позиции <span className="ml-1 font-mono text-muted-foreground">{positions.length}</span></h2>
        <span className="position-book-label">15 сек · автообновление</span>
      </div>
      {note && <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground sm:px-5" data-testid={`note-${mode}-positions`}>{note}</p>}
      {positions.length === 0 ? (
        <div className="border-t border-border px-5 py-12 text-center" data-testid={`empty-${mode}-positions`}>
          <p className="font-medium">{empty}</p>
          <p className="mt-1 text-xs text-muted-foreground">Данные этого режима не заменяются данными другого счёта.</p>
        </div>
      ) : positions.map((position, index) => (
        <article key={`${position.id}-${index}`} className="position-book-row px-4 py-4 sm:px-5" data-testid={`card-${mode}-position-${index}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className={`h-8 w-0.5 shrink-0 ${position.side === "SHORT" ? "bg-destructive" : "bg-primary"}`} />
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="break-all font-mono text-base font-bold tracking-tight sm:text-lg" data-testid={`text-${mode}-symbol-${index}`}>{position.symbol}</h3>
                  <span className={`border px-1.5 py-0.5 font-mono text-[10px] font-bold ${position.side === "SHORT" ? "border-destructive/40 text-destructive" : position.side === "—" ? "border-border text-muted-foreground" : "border-success/40 text-success"}`}>{position.side === "—" ? "Сторона —" : position.side}</span>
                  <span className="border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{position.status}</span>
                </div>
              </div>
            </div>
            <div className="sm:text-right" data-testid={`value-${mode}-pnl-${index}`}>
              <p className="position-book-label">Открытый PnL</p>
              <p className={`position-book-value mt-1 text-base font-bold ${position.pnl?.startsWith("+") ? "text-success" : position.pnl?.startsWith("-") ? "text-destructive" : ""}`}>{position.pnl ?? "—"}</p>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3 border-t border-border/70 pt-3 sm:grid-cols-4">
            {[
              ["Размер", position.size], ["Вход", position.entry],
              ["Текущая цена", position.current],
              ["Стоп", position.stop],
            ].map(([label, value]) => <div key={label} className="min-w-0"><p className="position-book-label">{label}</p><p className="position-book-value mt-1 break-all" data-testid={`value-${mode}-${label}-${index}`}>{value}</p></div>)}
          </div>
          <details className="mt-3 border-t border-border/70 pt-2 text-xs">
            <summary className="flex w-fit items-center gap-1.5 py-1 text-muted-foreground hover:text-foreground" data-testid={`toggle-${mode}-details-${index}`}>
              Детали <ChevronDown className="position-chevron h-3.5 w-3.5" />
            </summary>
            <dl className="grid gap-3 pb-2 pt-3 sm:grid-cols-2">
              {position.details.map(({ label, value }) => <div key={label} className="min-w-0"><dt className="position-book-label">{label}</dt><dd className="mt-1 break-all font-mono text-xs" data-testid={`detail-${mode}-${index}-${label.replaceAll(/\s+/g, "-")}`}>{value}</dd></div>)}
            </dl>
          </details>
        </article>
      ))}
    </section>
  );
}

function Loading({ mode }: { mode: Mode }) {
  return <div className="position-book space-y-3 p-5" role="status" data-testid={`status-${mode}-loading`}>
    <Skeleton className="h-5 w-36 rounded-none" /><Skeleton className="h-24 w-full rounded-none" /><Skeleton className="h-24 w-full rounded-none" />
  </div>;
}
function Problem({ mode, title, retry }: { mode: Mode; title: string; retry: () => void }) {
  return <div className="position-book p-5" role="status" data-testid={`status-${mode}-unavailable`}>
    <p className="font-semibold">{title}</p>
    <p className="mt-1 text-xs text-muted-foreground">Текущее состояние неизвестно. Данные других режимов не подставляются.</p>
    <button type="button" onClick={retry} className="mt-4 inline-flex items-center gap-2 border border-border px-3 py-2 text-xs font-bold uppercase hover:bg-secondary" data-testid={`button-retry-${mode}`}><RefreshCw className="h-3.5 w-3.5" /> Повторить</button>
  </div>;
}
function PaperBook({ now }: { now: number }) {
  const { data, isLoading, error, refetch } = useGetJournalBot({ query: { queryKey: getGetJournalBotQueryKey(), refetchInterval: 15000 } });
  if (isLoading) return <Loading mode="paper" />;
  if (error || !data) return <Problem mode="paper" title="PAPER-бот недоступен" retry={() => { void refetch(); }} />;
  const positions = sortPositionsNewestFirst(data.positions.filter(p => p.status !== "closed"), p => typeof p.snapshot.entryAt === "string" ? p.snapshot.entryAt : null, p => p.sourceSignalId);
  const sourcePollingDisabled = data.sourceSync.reason === "source_sync_disabled_outside_production";
  const sourceStale = data.sourceSync.state === "ok" &&
    (!data.sourceSync.lastSuccessAt || now - Date.parse(data.sourceSync.lastSuccessAt) > 60_000);
  const sourceProblem = (data.sourceSync.state === "error" && !sourcePollingDisabled) || sourceStale;
  return <>
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 border px-3 py-2 text-xs ${sourceProblem ? "border-destructive/40 text-destructive" : sourcePollingDisabled || data.sourceSync.state === "pending" ? "border-border text-muted-foreground" : "border-success/40 text-success"}`} role="status" data-testid="status-paper-source-sync">
      <span className="font-semibold">{sourcePollingDisabled ? "Источник · автоопрос отключён в предпросмотре" : sourceStale ? "Источник · проверка задерживается" : data.sourceSync.state === "ok" ? "Источник · синхронизирован" : data.sourceSync.state === "error" ? "Источник · ошибка синхронизации" : "Источник · проверка ожидается"}</span>
      <span className="text-muted-foreground">
        {sourcePollingDisabled
          ? "Предпросмотр не дублирует автоматические запросы опубликованного бота."
          : data.sourceSync.state === "ok"
          ? `Проверка: ${data.sourceSync.checkedAt ? formatDate(data.sourceSync.checkedAt) : "время неизвестно"}`
          : `Последняя успешная: ${data.sourceSync.lastSuccessAt ? formatDate(data.sourceSync.lastSuccessAt) : "нет данных"}`}
      </span>
      {!sourcePollingDisabled && data.sourceSync.state === "error" && data.sourceSync.reason && <details className="w-full text-muted-foreground"><summary className="w-fit cursor-pointer underline underline-offset-2" data-testid="toggle-paper-sync-reason">Причина</summary><p className="mt-1 break-words">{data.sourceSync.reason}</p></details>}
      <p className="w-full text-muted-foreground" data-testid="note-paper-source-sync-scope">«Синхронизирован» значит, что последняя проверка источника прошла успешно — это не означает, что состояния совпадают. PAPER закрывает позиции по своим правилам и котировкам (безубыток, тейк-профит, трейлинг) и может закрыть сделку раньше, чем это отразится у источника; несколько дней разницы — не ошибка.</p>
    </div>
    {data.missedSourceSignals.count > 0 && <div className="border border-destructive/40 px-3 py-2 text-xs text-destructive" role="status" data-testid="status-missed-source-signals">
      <span className="font-semibold">Пропущено сигналов источника: {data.missedSourceSignals.count}</span>
      <p className="mt-1 text-muted-foreground">Источник считает их активными, но они не поступили в этот бот ни в каком виде (не открыты и не отклонены) — PAPER-позиции по ним не открывались задним числом.</p>
      <details className="mt-1">
        <summary className="w-fit cursor-pointer underline underline-offset-2" data-testid="toggle-missed-source-signals">Список ({Math.min(data.missedSourceSignals.items.length, 100)})</summary>
        <ul className="mt-1 space-y-0.5 font-mono">
          {data.missedSourceSignals.items.map((item) => (
            <li key={item.sourceSignalId} className="break-all">
              {item.sourceSignalId}{item.symbol ? ` · ${item.symbol}` : ""}{item.sourceStatus ? ` · ${item.sourceStatus}` : ""} · обнаружено {formatDate(item.detectedAt)}
            </li>
          ))}
        </ul>
      </details>
    </div>}
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="border border-border bg-card px-4 py-3"><p className="position-book-label">PAPER кошелёк · симуляция</p><p className="mt-1 font-mono text-xl font-bold">{number(data.paperEquity.walletUsdt, 2)} USDT</p></div>
      <div className="border border-border bg-card px-4 py-3"><p className="position-book-label">Стоимость · при подтверждённых данных</p><p className="mt-1 font-mono text-xl font-bold">{(data.paperEquity.status === "fresh" || data.paperEquity.status === "no_position") && data.paperEquity.equityUsdt !== null ? `${number(data.paperEquity.equityUsdt, 2)} USDT` : "—"}</p></div>
    </div>
    <PositionList
      mode="paper"
      positions={positions.map(p => paperPosition(p, now))}
      empty="Нет открытых PAPER-позиций"
      note="Число открытых здесь позиций отражает только PAPER: бот закрывает их по собственным правилам и котировкам, не дожидаясь исхода сделки у источника — эта же сделка может ещё числиться активной у источника, и наоборот."
    />
    <Link href="/journal/open" className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline" data-testid="link-paper-legacy-close">Старые открытые записи и ручное PAPER-закрытие <ArrowUpRight className="h-3.5 w-3.5" /></Link>
    <ClosedPositionList
      mode="paper"
      positions={sortPositionsNewestFirst(data.recentClosedPositions, p => p.updatedAt, p => p.sourceSignalId).map(paperClosedPosition)}
      empty="Закрытых PAPER-позиций пока нет"
    />
  </>;
}
function RealBook({ now }: { now: number }) {
  const { data, isLoading, error, refetch } = useGetJournalBingxPositions({ query: { queryKey: getGetJournalBingxPositionsQueryKey(), refetchInterval: 15000 } });
  if (isLoading) return <Loading mode="real" />;
  if (error || !data) return <Problem mode="real" title="Не удалось прочитать счёт BingX" retry={() => { void refetch(); }} />;
  const available = data.status === "available" && fresh(data.observedAt, now);
  if (!available) return <Problem mode="real" title={data.status === "not_configured" ? "Доступ к BingX не настроен" : data.status === "available" ? "Снимок позиций устарел" : "Позиции BingX недоступны"} retry={() => { void refetch(); }} />;
  const accountFresh = data.accountStatus === "available" && fresh(data.accountObservedAt, now);
  return <>
    <div className="border border-amber-500/30 bg-card px-4 py-3">
      <p className="position-book-label">Весь REAL-счёт · equity USDT</p>
      <p className="mt-1 font-mono text-xl font-bold" data-testid="value-real-equity">{accountFresh && data.account?.equityUsdt != null ? `${number(data.account.equityUsdt, 2)} USDT` : "—"}</p>
      {!accountFresh && <p className="mt-1 text-xs text-muted-foreground">Свежий баланс недоступен</p>}
    </div>
    <PositionList mode="real" positions={sortPositionsNewestFirst(data.positions, p => p.openedAt, p => `${p.symbol}:${p.side}`).map((p, i) => realPosition(p, i, available))} empty="В последнем чтении BingX позиций нет" />
    <p className="text-xs text-muted-foreground">Снимок сервера: {data.observedAt ? formatDate(data.observedAt) : "—"} · Время биржевой котировки не передано.</p>
    <ClosedPositionList
      mode="real"
      positions={data.recentClosedTrades.status === "available"
        ? sortPositionsNewestFirst(data.recentClosedTrades.trades, t => t.closedAt, t => t.tradeId).map(realClosedPosition)
        : []}
      empty={data.recentClosedTrades.status === "available" ? "Закрытых REAL-позиций пока нет" : "История закрытых REAL-сделок недоступна"}
    />
  </>;
}
function VstBook({ now }: { now: number }) {
  const { data, isLoading, error, refetch } = useGetJournalVstPositions({ query: { queryKey: getGetJournalVstPositionsQueryKey(), refetchInterval: 15000 } });
  const { data: reviewData } = useGetJournalVstReview({ query: { queryKey: getGetJournalVstReviewQueryKey(), refetchInterval: 15000 } });
  const reviewCount = reviewData ? new Set([
    ...reviewData.positions.map(position => position.sourceSignalId),
    ...reviewData.marginTopUpPending.map(position => position.sourceSignalId),
    ...reviewData.legacyPreRunnerCloseIntents.map(intent => intent.sourceSignalId),
  ]).size : 0;
  if (isLoading) return <Loading mode="vst" />;
  if (error || !data) return <Problem mode="vst" title="VST ledger недоступен" retry={() => { void refetch(); }} />;
  if (data.source !== "vst_ledger" || data.exchangeVerification !== "requested") return <Problem mode="vst" title="Неожиданный источник VST" retry={() => { void refetch(); }} />;
  const accountFresh = data.accountStatus === "available" && fresh(data.accountObservedAt, now);
  const positionsFresh = data.positionsStatus === "available" && fresh(data.observedAt, now);
  const mismatchCount = data.positions.filter(p => p.sourceMismatch).length;
  return <>
    {reviewCount > 0 && (
      <Link href="/journal/vst-review" className="flex items-center justify-between gap-2 border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-semibold text-destructive hover:bg-destructive/20" data-testid="link-vst-review">
        {reviewCount === 1 ? "1 позиция ожидает ручного решения" : `${reviewCount} позиции ожидают ручного решения`}
        <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
      </Link>
    )}
    <div className={`border px-4 py-3 ${mismatchCount > 0 ? "border-destructive/40 bg-card" : "border-border bg-card"}`}>
      <p className="position-book-label">VST демо-счёт · equity</p>
      <p className="mt-1 font-mono text-xl font-bold" data-testid="value-vst-equity">{accountFresh && data.account?.equityUsdt != null ? `${number(data.account.equityUsdt, 2)} USDT` : "—"}</p>
      {!accountFresh && <p className="mt-1 text-xs text-muted-foreground">Свежий баланс недоступен</p>}
      {mismatchCount > 0 && (
        <p className="mt-1 text-xs font-semibold text-destructive" data-testid="status-vst-mismatch">
          {mismatchCount === 1 ? "1 позиция не подтверждена биржей" : `${mismatchCount} позиции не подтверждены биржей`}
        </p>
      )}
    </div>
    <VstEntryQueue />
    <PositionList mode="vst" positions={sortPositionsNewestFirst(data.positions, p => p.updatedAt, p => p.sourceSignalId).map(vstPosition)} empty="В VST ledger открытых записей нет" />
    <p className="text-xs text-muted-foreground" data-testid="note-vst-market-entry-price">
      Вход VST отправляется как MARKET: биржа не гарантирует верхнюю цену исполнения. Котировка для расчёта и подтверждённая цена исполнения показаны отдельно.
    </p>
    <p className="text-xs text-muted-foreground">
      {positionsFresh
        ? `Снимок биржи: ${data.observedAt ? formatDate(data.observedAt) : "—"}`
        : "Свежее чтение позиций BingX VST недоступно — показан только сохранённый снимок ledger."}
    </p>
    <ClosedPositionList
      mode="vst"
      positions={sortPositionsNewestFirst(data.recentClosedPositions, p => p.updatedAt, p => p.sourceSignalId).map(vstClosedPosition)}
      empty="Закрытых VST-позиций пока нет"
    />
  </>;
}

export default function JournalPositions({ mode }: { mode: Mode }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);
  const title = { paper: "PAPER", real: "REAL", vst: "VST" }[mode];
  const subtitle = { paper: "Симуляция бота · не биржевые позиции", real: "Весь счёт BingX · только чтение", vst: "VST ledger · без свежей проверки биржи" }[mode];
  return <div className="page-frame mx-auto max-w-5xl space-y-5" data-testid={`page-${mode}-positions`}>
    <div className="border-b border-border pb-4">
      <p className="position-book-label">Позиции / {title}</p>
      <h1 className="mt-1 text-2xl font-bold tracking-tight">{title} <span className="font-normal text-muted-foreground">/ Позиции</span></h1>
      <p className="mt-1 text-xs text-muted-foreground" data-testid={`status-${mode}-source`}>{subtitle}</p>
    </div>
    {mode === "paper" ? <PaperBook now={now} /> : mode === "real" ? <RealBook now={now} /> : <VstBook now={now} />}
  </div>;
}
