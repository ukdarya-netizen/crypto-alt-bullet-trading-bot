import type { tradingSignalsTable } from "@workspace/db";

type TradingSignalRow = typeof tradingSignalsTable.$inferSelect;

export function toTradingSignal(row: TradingSignalRow) {
  return {
    id: row.id,
    sourceSignalId: row.sourceSignalId,
    confirmationStatus: row.confirmationStatus as "confirmed" | null,
    patternId: row.patternId,
    patternStatus: row.patternStatus as "approved" | null,
    symbol: row.symbol,
    signalAt: row.signalAt ?? null,
    referencePrice: row.referencePrice ?? null,
    side: row.side as "buy" | "sell" | null,
    orderType: row.orderType as "market" | "limit" | null,
    quantity: row.quantity,
    limitPrice: row.limitPrice ?? null,
    stopLoss: row.stopLoss ?? null,
    takeProfit: row.takeProfit ?? null,
    reduceOnly: row.reduceOnly,
    status: row.status as
      | "awaiting_rules"
      | "pending"
      | "processing"
      | "executed"
      | "rejected"
      | "failed",
    attempts: row.attempts,
    errorCode: row.errorCode ?? null,
    errorMessage: row.errorMessage ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}