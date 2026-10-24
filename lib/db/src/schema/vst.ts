import { sql } from "drizzle-orm";
import {
  bigserial,
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Independently provisioned VST ledger. Keep this separate from the btb_* ledgers.
export const vstSignalsTable = pgTable("vst_signals", {
  sourceSignalId: text("source_signal_id").primaryKey(),
  body: jsonb("body").notNull(),
  bodyHash: text("body_hash").notNull(),
  status: text("status").notNull().default("pending"),
  reason: text("reason"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check(
    "vst_signals_status_check",
    sql`${table.status} IN ('pending', 'planning', 'opening', 'open', 'closed', 'rejected', 'error', 'unsupported', 'unknown')`,
  ),
  index("vst_signals_pending_idx")
    .on(table.receivedAt, table.sourceSignalId)
    .where(sql`${table.status} IN ('pending', 'planning', 'opening')`),
]);

export const vstPositionsTable = pgTable("vst_positions", {
  sourceSignalId: text("source_signal_id").primaryKey(),
  symbol: text("symbol").notNull(),
  status: text("status").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check(
    "vst_positions_status_check",
    sql`${table.status} IN ('open', 'closing', 'closed', 'error', 'unknown')`,
  ),
  foreignKey({
    name: "vst_positions_source_signal_id_fkey",
    columns: [table.sourceSignalId],
    foreignColumns: [vstSignalsTable.sourceSignalId],
  }),
  index("vst_positions_open_idx")
    .on(table.updatedAt, table.sourceSignalId)
    .where(sql`${table.status} IN ('open', 'closing', 'unknown')`),
]);

export const vstOrderIntentsTable = pgTable("vst_order_intents", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  sourceSignalId: text("source_signal_id").notNull(),
  phase: text("phase").notNull(),
  clientOrderId: text("client_order_id").notNull(),
  request: jsonb("request").notNull(),
  state: text("state").notNull().default("prepared"),
  exchangeOrderId: text("exchange_order_id"),
  outcome: jsonb("outcome"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check(
    "vst_order_intents_state_check",
    sql`${table.state} IN ('prepared', 'submitted', 'unknown', 'reconciled', 'failed')`,
  ),
  foreignKey({
    name: "vst_order_intents_source_signal_id_fkey",
    columns: [table.sourceSignalId],
    foreignColumns: [vstSignalsTable.sourceSignalId],
  }),
  unique("vst_order_intents_client_order_id_key").on(table.clientOrderId),
  unique("vst_order_intents_source_signal_id_phase_key").on(table.sourceSignalId, table.phase),
  index("vst_order_intents_unresolved_idx")
    .on(table.createdAt, table.sourceSignalId)
    .where(sql`${table.state} IN ('prepared', 'submitted', 'unknown')`),
]);

export const vstEventsTable = pgTable("vst_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  sourceSignalId: text("source_signal_id"),
  clientOrderId: text("client_order_id"),
  kind: text("kind").notNull(),
  detail: jsonb("detail").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  telegramSentAt: timestamp("telegram_sent_at", { withTimezone: true }),
}, (table) => [
  foreignKey({
    name: "vst_events_source_signal_id_fkey",
    columns: [table.sourceSignalId],
    foreignColumns: [vstSignalsTable.sourceSignalId],
  }),
  index("vst_events_signal_idx")
    .on(table.sourceSignalId, table.createdAt.desc()),
  index("vst_events_queue_latest_idx")
    .on(table.sourceSignalId, table.id.desc())
    .where(sql`${table.kind} = 'vst_entry_queue_telemetry'`),
  index("vst_events_queue_timing_idx")
    .on(table.sourceSignalId, table.id.desc())
    .where(sql`${table.kind} = 'vst_entry_queue_telemetry' AND ${table.detail}->>'event' = 'timing'`),
]);

// Mutable internal measurements, never exchange evidence or Telegram events.
export const vstEntryQueueSnapshotsTable = pgTable("vst_entry_queue_snapshots", {
  sourceSignalId: text("source_signal_id").notNull(),
  slot: text("slot").notNull(),
  detail: jsonb("detail").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, (table) => [
  primaryKey({ name: "vst_entry_queue_snapshots_pkey", columns: [table.sourceSignalId, table.slot] }),
  foreignKey({
    name: "vst_entry_queue_snapshots_source_signal_id_fkey",
    columns: [table.sourceSignalId],
    foreignColumns: [vstSignalsTable.sourceSignalId],
  }),
  check("vst_entry_queue_snapshots_slot_check", sql`${table.slot} IN ('latest', 'timing')`),
]);

// Immutable, account-scoped captures of complete currency-wide VST fill
// history. Every observation is retained, including repeated fixed snapshots.
export const vstFillArchiveWindowsTable = pgTable("vst_fill_archive_windows", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  environment: text("environment").notNull().default("vst"),
  accountId: text("account_id").notNull(),
  currency: text("currency").notNull(),
  startTs: bigint("start_ts", { mode: "number" }).notNull(),
  endTs: bigint("end_ts", { mode: "number" }).notNull(),
  windowHash: text("window_hash").notNull(),
  archiveWindow: jsonb("archive_window").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
  invalidationReason: text("invalidation_reason"),
}, (table) => [
  check("vst_fill_archive_windows_environment_check", sql`${table.environment} = 'vst'`),
  check("vst_fill_archive_windows_currency_check", sql`${table.currency} = 'USDT'`),
  check("vst_fill_archive_windows_bounds_check", sql`${table.startTs} > 0 AND ${table.endTs} >= ${table.startTs}`),
  uniqueIndex("vst_fill_archive_windows_observation_idx").on(
    table.environment, table.accountId, table.currency, table.startTs,
    table.endTs, table.windowHash, table.observedAt,
  ),
  index("vst_fill_archive_windows_scope_range_idx")
    .on(table.accountId, table.currency, table.startTs, table.endTs),
]);

// One immutable canonical source row per trade identity, shared by overlapping
// archive windows so consistency checks do not scan all historical snapshots.
export const vstFillArchiveFillsTable = pgTable("vst_fill_archive_fills", {
  environment: text("environment").notNull().default("vst"),
  accountId: text("account_id").notNull(),
  currency: text("currency").notNull().default("USDT"),
  symbol: text("symbol").notNull(),
  tradeId: text("trade_id").notNull(),
  rawFill: jsonb("raw_fill").notNull(),
}, (table) => [
  check("vst_fill_archive_fills_environment_check", sql`${table.environment} = 'vst'`),
  check("vst_fill_archive_fills_currency_check", sql`${table.currency} = 'USDT'`),
  check("vst_fill_archive_fills_symbol_check", sql`${table.symbol} ~ '^[A-Z0-9]+-USDT$'`),
  unique("vst_fill_archive_fills_identity_key").on(
    table.environment, table.accountId, table.currency, table.symbol, table.tradeId,
  ),
]);