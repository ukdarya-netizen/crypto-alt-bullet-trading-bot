import { integer, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Declared here so that every schema comparison (Replit publish, drizzle)
 * knows these tables exist. They are also created by the bot itself
 * (owner-trading-strategy.mjs / strategy-paper.mjs, CREATE TABLE IF NOT
 * EXISTS); the definitions must stay identical.
 */
export const ownerTradingStrategyTable = pgTable("owner_trading_strategy", {
  id: integer("id").primaryKey().default(1),
  strategy: text("strategy").notNull().default("take5"),
  patternExit: text("pattern_exit"),
  patterns: text("patterns"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const strategyPaperTradesTable = pgTable("strategy_paper_trades", {
  sourceSignalId: text("source_signal_id").primaryKey(),
  symbol: text("symbol").notNull(),
  patternId: text("pattern_id"),
  signalAt: timestamp("signal_at", { withTimezone: true }),
  entryPrice: numeric("entry_price"),
  peakPrice: numeric("peak_price"),
  exitPrice: numeric("exit_price"),
  sourceStatus: text("source_status"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
