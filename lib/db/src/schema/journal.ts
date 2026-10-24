import {
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { tradingOrdersTable } from "./trading";

// Reconciliation (not the browser) owns economic fields. The owner may edit
// only notes and tags. Nullable fields mean "not verified", never zero.
export const journalTradeDetailsTable = pgTable("journal_trade_details", {
  orderId: uuid("order_id")
    .primaryKey()
    .references(() => tradingOrdersTable.id),
  environment: text("environment").notNull().default("paper"),
  instrumentType: text("instrument_type"),
  leverage: numeric("leverage", { precision: 16, scale: 4 }),
  markPrice: numeric("mark_price", { precision: 28, scale: 12 }),
  markAt: timestamp("mark_at", { withTimezone: true }),
  exitPrice: numeric("exit_price", { precision: 28, scale: 12 }),
  exitAt: timestamp("exit_at", { withTimezone: true }),
  entryFee: numeric("entry_fee", { precision: 28, scale: 12 }),
  exitFee: numeric("exit_fee", { precision: 28, scale: 12 }),
  funding: numeric("funding", { precision: 28, scale: 12 }),
  notes: text("notes").notNull().default(""),
  tags: text("tags").array().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});