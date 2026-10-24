import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// This is a separate LIVE execution ledger. It deliberately has no relation to
// the PAPER ledger, and no PAPER records should be copied into these tables.
export const botLiveControlTable = pgTable("btb_live_control", {
  singleton: boolean("singleton").primaryKey().default(true),
  killSwitchOn: boolean("kill_switch_on").notNull().default(true),
  blockedReason: text("blocked_reason").notNull().default("Live execution is disabled by default"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("btb_live_control_singleton_check", sql`${table.singleton} = true`),
]);

export const botLiveBaselineTable = pgTable("btb_live_baseline", {
  accountId: text("account_id").notNull(),
  environment: text("environment").notNull(),
  initialUsdt: numeric("initial_usdt", { precision: 30, scale: 12 }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.accountId, table.environment] }),
  check("btb_live_baseline_positive", sql`${table.initialUsdt} > 0`),
]);

export const botLiveAllocationsTable = pgTable("btb_live_allocations", {
  accountId: text("account_id").notNull(),
  environment: text("environment").notNull(),
  signalId: text("signal_id").notNull(),
  initialMarginUsdt: numeric("initial_margin_usdt", { precision: 30, scale: 12 }).notNull(),
  initialDepositUsdt: numeric("initial_deposit_usdt", { precision: 30, scale: 12 }).notNull(),
  allocatedPercent: numeric("allocated_percent", { precision: 30, scale: 12 }).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.accountId, table.environment, table.signalId] }),
  check("btb_live_allocations_margin_positive", sql`${table.initialMarginUsdt} > 0`),
  check("btb_live_allocations_deposit_positive", sql`${table.initialDepositUsdt} > 0`),
  foreignKey({
    name: "btb_live_allocations_signal_fk",
    columns: [table.accountId, table.environment, table.signalId],
    foreignColumns: [botLiveSignalsTable.accountId, botLiveSignalsTable.environment, botLiveSignalsTable.signalId],
  }),
]);

export const botLiveFundingTable = pgTable("btb_live_funding", {
  accountId: text("account_id").notNull(),
  environment: text("environment").notNull(),
  signalId: text("signal_id").notNull(),
  exchangeTransactionId: text("exchange_transaction_id").notNull(),
  amountUsdt: numeric("amount_usdt", { precision: 30, scale: 12 }).notNull(),
  settledAt: timestamp("settled_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.accountId, table.environment, table.exchangeTransactionId] }),
  foreignKey({
    name: "btb_live_funding_signal_fk",
    columns: [table.accountId, table.environment, table.signalId],
    foreignColumns: [botLiveSignalsTable.accountId, botLiveSignalsTable.environment, botLiveSignalsTable.signalId],
  }),
]);

export const botLiveFundingCoverageTable = pgTable("btb_live_funding_coverage", {
  accountId: text("account_id").notNull(),
  environment: text("environment").notNull(),
  signalId: text("signal_id").notNull(),
  coveredThrough: timestamp("covered_through", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.accountId, table.environment, table.signalId] }),
  foreignKey({
    name: "btb_live_funding_coverage_signal_fk",
    columns: [table.accountId, table.environment, table.signalId],
    foreignColumns: [botLiveSignalsTable.accountId, botLiveSignalsTable.environment, botLiveSignalsTable.signalId],
  }),
]);

export const botLiveSignalsTable = pgTable("btb_live_signals", {
  accountId: text("account_id").notNull(),
  environment: text("environment").notNull(),
  signalId: text("signal_id").notNull(),
  body: jsonb("body").notNull(),
  bodyHash: text("body_hash").notNull(),
  status: text("status").notNull().default("received"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.accountId, table.environment, table.signalId] }),
  check("btb_live_signals_status_check", sql`${table.status} IN ('received', 'planned', 'rejected')`),
  index("btb_live_signals_account_received_idx")
    .on(table.accountId, table.environment, table.receivedAt.desc()),
]);

export const botLiveOrderIntentsTable = pgTable("btb_live_order_intents", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  accountId: text("account_id").notNull(),
  environment: text("environment").notNull(),
  signalId: text("signal_id").notNull(),
  phase: text("phase").notNull(),
  clientOrderId: text("client_order_id").notNull(),
  request: jsonb("request").notNull(),
  state: text("state").notNull().default("pending"),
  exchangeOrderId: text("exchange_order_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // Publish must create parent-key uniqueness before adding the composite
  // attempts/fills foreign keys on an existing production ledger.
  unique("btb_live_order_intents_scope_client_key")
    .on(table.accountId, table.environment, table.clientOrderId),
  // The composite constraint above already supplies the parent key.
  // Drizzle hides a standalone index referenced by a foreign key during
  // introspection and then tries to recreate it, aborting subsequent pushes.
  // Existing databases retain that historical index; do not drop or rebind it.
  uniqueIndex("btb_live_order_intents_client_id_global_uq")
    .on(table.clientOrderId),
  foreignKey({
    name: "btb_live_order_intents_signal_fk",
    columns: [table.accountId, table.environment, table.signalId],
    foreignColumns: [
      botLiveSignalsTable.accountId,
      botLiveSignalsTable.environment,
      botLiveSignalsTable.signalId,
    ],
  }),
  check("btb_live_order_intents_state_check", sql`${table.state} IN ('pending', 'submitted', 'unknown', 'reconciled')`),
  index("btb_live_order_intents_state_idx")
    .on(table.accountId, table.environment, table.state, table.createdAt),
]);

export const botLiveOrderAttemptsTable = pgTable("btb_live_order_attempts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  accountId: text("account_id").notNull(),
  environment: text("environment").notNull(),
  clientOrderId: text("client_order_id").notNull(),
  attemptNumber: numeric("attempt_number", { precision: 10, scale: 0 }).notNull(),
  state: text("state").notNull().default("started"),
  request: jsonb("request").notNull().default({}),
  response: jsonb("response").notNull().default({}),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (table) => [
  foreignKey({
    name: "btb_live_order_attempts_intent_fk",
    columns: [table.accountId, table.environment, table.clientOrderId],
    foreignColumns: [
      botLiveOrderIntentsTable.accountId,
      botLiveOrderIntentsTable.environment,
      botLiveOrderIntentsTable.clientOrderId,
    ],
  }),
  uniqueIndex("btb_live_order_attempts_number_uq")
    .on(table.accountId, table.environment, table.clientOrderId, table.attemptNumber),
  check("btb_live_order_attempts_state_check", sql`${table.state} IN ('started', 'pending', 'submitted', 'unknown', 'reconciled')`),
  index("btb_live_order_attempts_intent_idx")
    .on(table.accountId, table.environment, table.clientOrderId, table.startedAt),
]);

export const botLiveFillsTable = pgTable("btb_live_fills", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  accountId: text("account_id").notNull(),
  environment: text("environment").notNull(),
  exchangeFillId: text("exchange_fill_id").notNull(),
  clientOrderId: text("client_order_id").notNull(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),
  quantity: numeric("quantity", { precision: 30, scale: 12 }).notNull(),
  price: numeric("price", { precision: 30, scale: 12 }).notNull(),
  fee: numeric("fee", { precision: 30, scale: 12 }),
  feeAsset: text("fee_asset"),
  detail: jsonb("detail").notNull().default({}),
  filledAt: timestamp("filled_at", { withTimezone: true }),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("btb_live_fills_exchange_id_uq")
    .on(table.accountId, table.environment, table.exchangeFillId),
  foreignKey({
    name: "btb_live_fills_intent_fk",
    columns: [table.accountId, table.environment, table.clientOrderId],
    foreignColumns: [
      botLiveOrderIntentsTable.accountId,
      botLiveOrderIntentsTable.environment,
      botLiveOrderIntentsTable.clientOrderId,
    ],
  }),
  check("btb_live_fills_quantity_check", sql`${table.quantity} > 0`),
  check("btb_live_fills_price_check", sql`${table.price} > 0`),
  index("btb_live_fills_account_time_idx")
    .on(table.accountId, table.environment, table.filledAt.desc()),
]);

export const botLivePositionSnapshotsTable = pgTable("btb_live_position_snapshots", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  accountId: text("account_id").notNull(),
  environment: text("environment").notNull(),
  signalId: text("signal_id").notNull(),
  symbol: text("symbol").notNull(),
  status: text("status").notNull().default("open"),
  quantity: numeric("quantity", { precision: 30, scale: 12 }).notNull(),
  entryPrice: numeric("entry_price", { precision: 30, scale: 12 }),
  markPrice: numeric("mark_price", { precision: 30, scale: 12 }),
  unrealizedPnl: numeric("unrealized_pnl", { precision: 30, scale: 12 }),
  snapshot: jsonb("snapshot").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("btb_live_position_snapshots_signal_uq")
    .on(table.accountId, table.environment, table.signalId),
  check("btb_live_position_snapshots_status_check", sql`${table.status} IN ('open', 'opening', 'closing', 'closed')`),
  index("btb_live_position_snapshots_account_symbol_time_idx")
    .on(table.accountId, table.environment, table.symbol, table.capturedAt.desc()),
]);

export const botLiveEventsTable = pgTable("btb_live_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  accountId: text("account_id"),
  environment: text("environment"),
  signalId: text("signal_id"),
  clientOrderId: text("client_order_id"),
  kind: text("kind").notNull(),
  detail: jsonb("detail").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("btb_live_events_scope_created_idx")
    .on(table.accountId, table.environment, table.createdAt.desc()),
  index("btb_live_events_signal_idx")
    .on(table.accountId, table.environment, table.signalId, table.createdAt.desc()),
]);

export const insertBotLiveControlSchema = createInsertSchema(botLiveControlTable);
export type InsertBotLiveControl = z.infer<typeof insertBotLiveControlSchema>;
export type BotLiveControl = typeof botLiveControlTable.$inferSelect;
export const insertBotLiveSignalSchema = createInsertSchema(botLiveSignalsTable);
export type InsertBotLiveSignal = z.infer<typeof insertBotLiveSignalSchema>;
export type BotLiveSignal = typeof botLiveSignalsTable.$inferSelect;
export const insertBotLiveOrderIntentSchema = createInsertSchema(botLiveOrderIntentsTable);
export type InsertBotLiveOrderIntent = z.infer<typeof insertBotLiveOrderIntentSchema>;
export type BotLiveOrderIntent = typeof botLiveOrderIntentsTable.$inferSelect;
export const insertBotLiveOrderAttemptSchema = createInsertSchema(botLiveOrderAttemptsTable);
export type InsertBotLiveOrderAttempt = z.infer<typeof insertBotLiveOrderAttemptSchema>;
export type BotLiveOrderAttempt = typeof botLiveOrderAttemptsTable.$inferSelect;
export const insertBotLiveFillSchema = createInsertSchema(botLiveFillsTable);
export type InsertBotLiveFill = z.infer<typeof insertBotLiveFillSchema>;
export type BotLiveFill = typeof botLiveFillsTable.$inferSelect;
export const insertBotLivePositionSnapshotSchema = createInsertSchema(botLivePositionSnapshotsTable);
export type InsertBotLivePositionSnapshot = z.infer<typeof insertBotLivePositionSnapshotSchema>;
export type BotLivePositionSnapshot = typeof botLivePositionSnapshotsTable.$inferSelect;
export const insertBotLiveEventSchema = createInsertSchema(botLiveEventsTable);
export type InsertBotLiveEvent = z.infer<typeof insertBotLiveEventSchema>;
export type BotLiveEvent = typeof botLiveEventsTable.$inferSelect;