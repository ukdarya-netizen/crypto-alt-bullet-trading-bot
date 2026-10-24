import Decimal from "decimal.js";
import { db, journalTradeDetailsTable, tradingOrdersTable, tradingSignalsTable } from "@workspace/db";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { PAPER_POSITION_RESERVE_USDT, PAPER_STARTING_DEPOSIT_USDT } from "./paper-intent";

type Order = typeof tradingOrdersTable.$inferSelect;
type Details = typeof journalTradeDetailsTable.$inferSelect | null;
type Signal = typeof tradingSignalsTable.$inferSelect;

function toDecimal(value: string | null | undefined): Decimal | null {
  if (!value) return null;
  try {
    const number = new Decimal(value);
    return number.isFinite() && number.greaterThan(0) ? number : null;
  } catch {
    return null;
  }
}

function money(value: Decimal | null): string | null {
  return value?.toDecimalPlaces(8).toFixed(8) ?? null;
}

type JournalRow = { order: Order; detail: Details; signal: Signal };

export function mapJournalTrade(order: Order, detail: Details, signal: Signal, paperExits: JournalRow[] = []) {
  const entry = toDecimal(order.averagePrice);
  const originalQuantity = toDecimal(order.filledQuantity);
  const paper = order.status === "simulated_filled";
  // A paper exit is valid only when the executor has durably linked it to
  // this entry. Notes and manually populated detail fields cannot close it.
  const linked = paper ? paperExits.filter(({ order: close, signal: closeSignal }) =>
    close.paperEntryOrderId === order.id && close.status === "simulated_filled" &&
    closeSignal.reduceOnly && close.symbol === order.symbol && close.side !== order.side &&
    toDecimal(close.filledQuantity) && toDecimal(close.averagePrice)) : [];
  const closedQuantity = linked.reduce((sum, { order: close }) =>
    sum.plus(close.filledQuantity!), new Decimal(0));
  const validPaperClose = Boolean(originalQuantity && closedQuantity.lte(originalQuantity));
  const quantity = paper && validPaperClose && originalQuantity
    ? originalQuantity.minus(closedQuantity) : originalQuantity;
  const paperExitValue = linked.reduce((sum, { order: close }) =>
    sum.plus(new Decimal(close.filledQuantity!).mul(close.averagePrice!)), new Decimal(0));
  const paperExit = validPaperClose && closedQuantity.gt(0)
    ? paperExitValue.div(closedQuantity) : null;
  const exit = paper ? paperExit : toDecimal(detail?.exitPrice);
  const mark = toDecimal(detail?.markPrice);
  const leverage = toDecimal(detail?.leverage);
  const entryFee = detail?.entryFee === null || detail?.entryFee === undefined
    ? null : new Decimal(detail.entryFee);
  const exitFee = detail?.exitFee === null || detail?.exitFee === undefined
    ? null : new Decimal(detail.exitFee);
  const funding = detail?.funding === null || detail?.funding === undefined
    ? null : new Decimal(detail.funding);

  // Non-paper fills must never be presented as PAPER just because their
  // exchange details are not available yet (including after a manual close).
  const environment = paper ? "paper"
    : detail?.environment === "live" ? "live" : "testnet";
  const closureUnverified = !paper && (order.status === "closure_unverified" ||
    order.protectionStatus === "reconciliation_required");
  const isClosed = paper
    ? Boolean(validPaperClose && originalQuantity && closedQuantity.eq(originalQuantity) && paperExit)
    : !closureUnverified && Boolean(detail?.exitAt && exit);
  const linear = detail?.instrumentType === "linear" && order.symbol.endsWith("USDT");
  const direction = order.side === "buy" ? new Decimal(1) : new Decimal(-1);
  const gross = linear && isClosed && entry && exit && quantity
    ? exit.minus(entry).mul(quantity).mul(direction)
    : null;
  const paperGross = paper && order.symbol.endsWith("USDT") && entry && validPaperClose &&
    closedQuantity.gt(0)
    ? linked.reduce((sum, { order: close }) => sum.plus(
      new Decimal(close.averagePrice!).minus(entry).mul(close.filledQuantity!).mul(direction),
    ), new Decimal(0)) : null;
  const net = gross && entryFee && exitFee && funding
    ? gross.minus(entryFee).minus(exitFee).minus(funding)
    : null;
  const notional = linear && entry && quantity ? entry.mul(quantity) : null;
  const roi = net && leverage && notional && !notional.isZero()
    ? net.div(notional.div(leverage)).mul(100)
    : null;
  const freshMark = detail?.markAt && Date.now() - detail.markAt.getTime() < 120_000;
  const unrealized = linear && !isClosed && !closureUnverified && environment !== "paper" &&
    freshMark && mark && entry && quantity
    ? mark.minus(entry).mul(quantity).mul(direction)
    : null;

  return {
    id: order.id,
    sourceSignalId: signal.sourceSignalId,
    exchangeOrderId: order.exchangeOrderId,
    symbol: order.symbol,
    side: order.side === "buy" ? "buy" as const : "sell" as const,
    status: isClosed ? "closed" as const : "open" as const,
    environment,
    quantity: (isClosed ? originalQuantity : quantity)?.toString() ?? order.filledQuantity ?? order.quantity,
    entryAt: order.createdAt,
    exitAt: paper ? (paperExit ? linked.reduce<Date>((latest, row) =>
      row.order.createdAt > latest ? row.order.createdAt : latest, linked[0].order.createdAt) : null)
      : closureUnverified ? null : detail?.exitAt ?? null,
    entryPrice: order.averagePrice,
    exitPrice: paper ? paperExit?.toString() ?? null : closureUnverified ? null : detail?.exitPrice ?? null,
    markPrice: closureUnverified ? null : detail?.markPrice ?? null,
    markAt: closureUnverified ? null : detail?.markAt ?? null,
    leverage: detail?.leverage ?? null,
    entryFee: detail?.entryFee ?? null,
    exitFee: detail?.exitFee ?? null,
    funding: detail?.funding ?? null,
    grossPnl: environment === "paper" ? money(paperGross) : money(gross),
    netPnl: environment === "paper" ? null : money(net),
    roiPercent: environment === "paper" ? null : money(roi),
    unrealizedPnl: money(unrealized),
    notional: money(notional),
    currency: order.symbol.endsWith("USDT") ? "USDT" : "unknown",
    calculationStatus: environment === "paper"
      ? "paper" as const
      : closureUnverified ? "incomplete" as const : net ? "verified" as const : "incomplete" as const,
    notes: detail?.notes ?? "",
    tags: detail?.tags ?? [],
    stopLoss: order.stopLoss,
    takeProfit: order.takeProfit,
    protectionStatus: environment === "paper"
      ? order.rawResponse?.impulseExitBlocked === true ? "paper_auto_exit_blocked" : "simulated"
      : order.protectionStatus,
  };
}

async function journalRows() {
  const query = db
    .select({
      order: tradingOrdersTable,
      detail: journalTradeDetailsTable,
      signal: tradingSignalsTable,
    })
    .from(tradingOrdersTable)
    .innerJoin(tradingSignalsTable, eq(tradingOrdersTable.signalId, tradingSignalsTable.id))
    .leftJoin(journalTradeDetailsTable, eq(tradingOrdersTable.id, journalTradeDetailsTable.orderId))
    .where(and(
      isNotNull(tradingOrdersTable.filledQuantity),
      isNotNull(tradingOrdersTable.averagePrice),
    ))
    .orderBy(desc(tradingOrdersTable.createdAt));
  const rows = await query;
  return mapJournalRows(rows);
}

export function mapJournalRows(rows: JournalRow[]) {
  const exits = new Map<string, JournalRow[]>();
  for (const row of rows) {
    if (row.order.paperEntryOrderId && row.signal.reduceOnly) {
      const group = exits.get(row.order.paperEntryOrderId) ?? [];
      group.push(row);
      exits.set(row.order.paperEntryOrderId, group);
    }
  }
  return rows
    .filter(({ order, signal }) =>
      !(signal.reduceOnly && order.status === "simulated_filled") &&
      Boolean(toDecimal(order.filledQuantity) && toDecimal(order.averagePrice)))
    .map(({ order, detail, signal }) =>
      mapJournalTrade(order, detail, signal, exits.get(order.id)));
}

export async function listJournalTrades(status: "open" | "closed" | "all", limit: number) {
  const rows = await journalRows();
  return rows.filter((trade) => status === "all" || trade.status === status).slice(0, limit);
}

export async function journalOverview() {
  const trades = await journalRows();
  const verified = trades.filter((trade) => trade.status === "closed" && trade.netPnl !== null);
  const realized = verified.length
    ? money(verified.reduce((sum, trade) => sum.plus(trade.netPnl!), new Decimal(0)))
    : null;
  const paperInitialDeposit = new Decimal(PAPER_STARTING_DEPOSIT_USDT);
  const paperRealizedGrossPnl = trades
    .filter((trade) => trade.environment === "paper" && trade.grossPnl !== null && trade.currency === "USDT")
    .reduce((sum, trade) => sum.plus(trade.grossPnl!), new Decimal(0));
  const paperReserved = new Decimal(trades.filter((trade) =>
    trade.environment === "paper" && trade.status === "open").length).mul(PAPER_POSITION_RESERVE_USDT);
  const openMarks = trades.filter((trade) => trade.status === "open");
  const unrealized = openMarks.length && openMarks.every((trade) => trade.unrealizedPnl !== null)
    ? money(openMarks.reduce((sum, trade) => sum.plus(trade.unrealizedPnl!), new Decimal(0)))
    : null;

  return {
    openCount: trades.filter((trade) => trade.status === "open").length,
    closedCount: trades.filter((trade) => trade.status === "closed").length,
    paperCount: trades.filter((trade) => trade.environment === "paper").length,
    liveCount: trades.filter((trade) => trade.environment === "live").length,
    verifiedClosedCount: verified.length,
    realizedNetPnl: realized,
    openUnrealizedPnl: unrealized,
    paperInitialDeposit: money(paperInitialDeposit)!,
    paperRealizedGrossPnl: money(paperRealizedGrossPnl)!,
    paperDepositBalance: money(paperInitialDeposit.plus(paperRealizedGrossPnl))!,
    paperReserved: money(paperReserved)!,
    paperAvailable: money(paperInitialDeposit.plus(paperRealizedGrossPnl).minus(paperReserved))!,
    currency: "USDT",
    dataSource: "Записи исполнителя. Paper — симуляция; валовой результат рассчитан только по связанным входам и выходам. Чистый PnL и биржевые данные недоступны.",
  };
}

export async function getJournalTrade(id: string) {
  return (await journalRows()).find((trade) => trade.id === id) ?? null;
}

export async function saveJournalNotes(id: string, notes: string, tags: string[]) {
  const [order] = await db.select({ id: tradingOrdersTable.id })
    .from(tradingOrdersTable)
    .innerJoin(tradingSignalsTable, eq(tradingOrdersTable.signalId, tradingSignalsTable.id))
    .where(and(
      eq(tradingOrdersTable.id, id),
      eq(tradingSignalsTable.reduceOnly, false),
      isNotNull(tradingOrdersTable.filledQuantity),
      isNotNull(tradingOrdersTable.averagePrice),
    )).limit(1);
  if (!order) return null;

  await db.insert(journalTradeDetailsTable)
    .values({ orderId: id, notes, tags })
    .onConflictDoUpdate({
      target: journalTradeDetailsTable.orderId,
      set: { notes, tags, updatedAt: new Date() },
    });
  return getJournalTrade(id);
}