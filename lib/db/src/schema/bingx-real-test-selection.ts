import {
  bigint,
  bigserial,
  check,
  integer,
  numeric,
  pgTable,
  timestamp,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tradingSignalsTable } from "./trading";

/**
 * One durable, default-disarmed selection gate for the narrowly-scoped
 * sender-webhook test. Absence of its singleton row also means disarmed.
 */
export const bingxRealTestSelectionTable = pgTable(
  "bingx_real_test_selection",
  {
    id: integer("id").primaryKey().default(1),
    state: text("state").notNull().default("disarmed"),
    marginMode: text("margin_mode").notNull().default("isolated"),
    testMarginUsdt: numeric("test_margin_usdt", { precision: 10, scale: 2 })
      .notNull().default("15.00"),
    armedAfterSequence: bigint("armed_after_sequence", { mode: "number" }).notNull().default(0),
    firstCandidateSequence: bigint("first_candidate_sequence", { mode: "number" }),
    firstCandidateSignalId: uuid("first_candidate_signal_id")
      .references(() => tradingSignalsTable.id),
    outcomeReason: text("outcome_reason"),
    armedAt: timestamp("armed_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    singleton: check("bingx_real_test_selection_singleton_check", sql`${table.id} = 1`),
    stateCheck: check(
      "bingx_real_test_selection_state_check",
      sql`${table.state} IN ('disarmed', 'armed', 'claimed', 'failed')`,
    ),
    isolatedOnly: check(
      "bingx_real_test_selection_margin_mode_check",
      sql`${table.marginMode} = 'isolated'`,
    ),
    fixedTestMargin: check(
      "bingx_real_test_selection_margin_amount_check",
      sql`${table.testMarginUsdt} = 15`,
    ),
  }),
);

/**
 * Monotonic order of newly inserted records through enqueueSignalIntent.
 * That intake path and the explicit arm operation both hold the trading
 * controls row lock, making the sequence an authoritative boundary for this
 * one restricted source. Other signal writers are intentionally excluded.
 */
export const bingxRealTestWebhookOrderTable = pgTable("bingx_real_test_webhook_order", {
  sequence: bigserial("sequence", { mode: "number" }).primaryKey(),
  signalId: uuid("signal_id").notNull().unique()
    .references(() => tradingSignalsTable.id, { onDelete: "cascade" }),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
});