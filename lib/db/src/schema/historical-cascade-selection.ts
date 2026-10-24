import { check, integer, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Durable, singleton one-shot gate for an owner-selected historical PAPER
 * liquidation_cascade record. The reference remains an opaque source ID; the
 * historical signal body (especially its price) is never copied into this
 * execution authorization record.
 */
export const historicalCascadeSelectionTable = pgTable(
  "historical_cascade_selection",
  {
    id: integer("id").primaryKey().default(1),
    state: text("state").notNull().default("disarmed"),
    sourceSignalId: text("source_signal_id"),
    symbol: text("symbol"),
    marginMode: text("margin_mode").notNull().default("isolated"),
    totalMarginUsdt: numeric("total_margin_usdt", { precision: 10, scale: 2 })
      .notNull().default("15.00"),
    selectedAt: timestamp("selected_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    entryIntentReservedAt: timestamp("entry_intent_reserved_at", { withTimezone: true }),
    attemptStartedAt: timestamp("attempt_started_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    singleton: check("historical_cascade_selection_singleton_check", sql`${table.id} = 1`),
    stateCheck: check(
      "historical_cascade_selection_state_check",
      sql`${table.state} IN ('disarmed', 'claimed', 'cancelled', 'entry_intent_reserved', 'attempted')`,
    ),
    isolatedOnly: check(
      "historical_cascade_selection_margin_mode_check",
      sql`${table.marginMode} = 'isolated'`,
    ),
    fixedMargin: check(
      "historical_cascade_selection_margin_amount_check",
      sql`${table.totalMarginUsdt} = 15`,
    ),
    candidateRequiredAfterClaim: check(
      "historical_cascade_selection_candidate_check",
      sql`(${table.state} = 'disarmed' AND ${table.sourceSignalId} IS NULL AND ${table.symbol} IS NULL)
        OR (${table.state} <> 'disarmed' AND ${table.sourceSignalId} IS NOT NULL AND ${table.symbol} IS NOT NULL)`,
    ),
  }),
);