import {
  type AnyPgColumn,
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const tradingControlsTable = pgTable("trading_controls", {
  id: integer("id").primaryKey().default(1),
  mode: text("mode").notNull().default("paper"),
  acceptingNewEntries: boolean("accepting_new_entries").notNull().default(false),
  killSwitchActive: boolean("kill_switch_active").notNull().default(true),
  maxNotionalPerOrder: numeric("max_notional_per_order", {
    precision: 20,
    scale: 8,
  })
    .notNull()
    .default("100"),
  workerHeartbeatAt: timestamp("worker_heartbeat_at", {
    withTimezone: true,
  }),
  exchangeConnected: boolean("exchange_connected").notNull().default(false),
  lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
  ...timestamps,
});

export const tradingSignalsTable = pgTable(
  "trading_signals",
  {
    id: uuid("id").primaryKey(),
    sourceSignalId: text("source_signal_id").notNull(),
    confirmationStatus: text("confirmation_status"),
    patternId: text("pattern_id"),
    patternStatus: text("pattern_status"),
    symbol: text("symbol").notNull(),
    // Ingested intents remain unsized until exchange filters and the pattern's
    // protective rules have been configured. They cannot be claimed by a worker.
    signalAt: timestamp("signal_at", { withTimezone: true }),
    referencePrice: numeric("reference_price", { precision: 28, scale: 12 }),
    side: text("side"),
    orderType: text("order_type"),
    quantity: numeric("quantity", { precision: 28, scale: 12 }),
    limitPrice: numeric("limit_price", { precision: 28, scale: 12 }),
    stopLoss: numeric("stop_loss", { precision: 28, scale: 12 }),
    takeProfit: numeric("take_profit", { precision: 28, scale: 12 }),
    reduceOnly: boolean("reduce_only").notNull().default(false),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    sourceSignalIdUnique: uniqueIndex(
      "trading_signals_source_signal_id_unique",
    ).on(table.sourceSignalId),
  }),
);

export const tradingOrdersTable = pgTable("trading_orders", {
  id: uuid("id").primaryKey(),
  signalId: uuid("signal_id")
    .notNull()
    .references(() => tradingSignalsTable.id),
  // Only paper reduce-only fills reference the entry they reduce.
  paperEntryOrderId: uuid("paper_entry_order_id").references((): AnyPgColumn => tradingOrdersTable.id),
  exchangeOrderId: text("exchange_order_id"),
  clientOrderId: text("client_order_id"),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),
  orderType: text("order_type").notNull(),
  status: text("status").notNull(),
  quantity: numeric("quantity", { precision: 28, scale: 12 }).notNull(),
  filledQuantity: numeric("filled_quantity", {
    precision: 28,
    scale: 12,
  }),
  averagePrice: numeric("average_price", { precision: 28, scale: 12 }),
  protectionStatus: text("protection_status").notNull(),
  stopLoss: numeric("stop_loss", { precision: 28, scale: 12 }),
  takeProfit: numeric("take_profit", { precision: 28, scale: 12 }),
  rawResponse: jsonb("raw_response").$type<Record<string, unknown>>(),
  ...timestamps,
}, (table) => ({
  oneOrderPerSignal: uniqueIndex("trading_orders_signal_id_unique").on(table.signalId),
  clientOrderUnique: uniqueIndex("trading_orders_client_order_unique").on(table.clientOrderId),
}));

export const tradingAuditEventsTable = pgTable("trading_audit_events", {
  id: serial("id").primaryKey(),
  signalId: uuid("signal_id").references(() => tradingSignalsTable.id),
  eventType: text("event_type").notNull(),
  message: text("message").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});