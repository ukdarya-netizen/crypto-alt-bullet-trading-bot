import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// Independent PAPER ledger within this project's PostgreSQL database.
// Never map these tables to the original receiver's trading_* tables.
export const botSignalsTable = pgTable("btb_signals", {
  sourceSignalId: text("source_signal_id").primaryKey(),
  body: jsonb("body").notNull(),
  bodyHash: text("body_hash").notNull(),
  status: text("status").notNull(),
  reason: text("reason"),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("btb_signals_status_check", sql`${table.status} IN ('pending', 'opening', 'open', 'closed', 'rejected', 'quarantined', 'error')`),
  index("btb_signals_worker_queue_idx")
    .on(table.status, table.receivedAt, table.sourceSignalId)
    .where(sql`${table.status} IN ('pending', 'opening')`),
]);

export const botPositionsTable = pgTable("btb_positions", {
  sourceSignalId: text("source_signal_id").primaryKey()
    .references(() => botSignalsTable.sourceSignalId),
  snapshot: jsonb("snapshot").notNull(),
  status: text("status").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("btb_positions_status_check", sql`${table.status} IN ('open', 'closing', 'closed', 'error')`),
  index("btb_positions_open_idx")
    .on(table.updatedAt, table.sourceSignalId)
    .where(sql`${table.status} IN ('open', 'closing')`),
]);

export const botEventsTable = pgTable("btb_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  sourceSignalId: text("source_signal_id"),
  kind: text("kind").notNull(),
  detail: jsonb("detail").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("btb_events_signal_created_idx")
    .on(table.sourceSignalId, table.createdAt.desc()),
]);

export const botPaperAccountTable = pgTable("btb_paper_account", {
  singleton: boolean("singleton").primaryKey().default(true),
  initialUsdt: numeric("initial_usdt", { precision: 24, scale: 8 }).notNull(),
  freeUsdt: numeric("free_usdt", { precision: 24, scale: 8 }).notNull(),
  reservedUsdt: numeric("reserved_usdt", { precision: 24, scale: 8 }).notNull(),
  realizedPnlUsdt: numeric("realized_pnl_usdt", { precision: 24, scale: 8 }).notNull().default("0"),
}, (table) => [
  check("btb_paper_account_singleton_check", sql`${table.singleton} = true`),
  check("btb_paper_account_initial_usdt_check", sql`${table.initialUsdt} >= 0`),
  check("btb_paper_account_reserved_usdt_check", sql`${table.reservedUsdt} >= 0`),
]);