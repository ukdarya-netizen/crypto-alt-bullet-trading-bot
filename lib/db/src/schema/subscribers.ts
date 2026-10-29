import { boolean, integer, numeric, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * People who asked to use the trading bot (owner's family first). The owner
 * approves each request. API keys are stored only AES-256-GCM encrypted with
 * SUBSCRIBER_KEYS_SECRET and are never returned to any client.
 * Each approved subscriber trades in an isolated Postgres schema `sub_<id>`
 * with its own copy of the VST ledger tables.
 */
export const subscribersTable = pgTable("subscribers", {
  id: serial("id").primaryKey(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  email: text("email"),
  name: text("name"),
  /** pending | approved | rejected | blocked */
  status: text("status").notNull().default("pending"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decidedBy: text("decided_by"),
  /** take5 | classic | ladder | patterns */
  strategy: text("strategy"),
  apiKeyEncrypted: text("api_key_encrypted"),
  apiSecretEncrypted: text("api_secret_encrypted"),
  apiKeyLast4: text("api_key_last4"),
  apiKeyVerifiedAt: timestamp("api_key_verified_at", { withTimezone: true }),
  apiKeyError: text("api_key_error"),
  /** Per-trade size: "percent" of the total balance or a fixed "amount" (VST) of initial margin. */
  allocationMode: text("allocation_mode").notNull().default("percent"),
  allocationValue: numeric("allocation_value").notNull().default("1"),
  leverage: integer("leverage").notNull().default(10),
  /** ISOLATED | CROSSED */
  marginMode: text("margin_mode").notNull().default("ISOLATED"),
  /** Strategy "patterns": exit choice and 1-3 chosen patterns ("a,b"). */
  patternExit: text("pattern_exit"),
  patterns: text("patterns"),
  /** "vst" (demo) | "real" (real BingX account). */
  tradingAccount: text("trading_account").notNull().default("vst"),
  realAllowed: boolean("real_allowed").notNull().default(false),
  realKeyVerifiedAt: timestamp("real_key_verified_at", { withTimezone: true }),
  keyIsOwnerMain: boolean("key_is_owner_main").notNull().default(false),
  /** Last trading state announced in Telegram ("real:on", ...). */
  tradingNotice: text("trading_notice"),
  tradingEnabled: boolean("trading_enabled").notNull().default(false),
  /** Signals received before this instant are never traded for this subscriber. */
  tradingStartedAt: timestamp("trading_started_at", { withTimezone: true }),
  tradingStoppedAt: timestamp("trading_stopped_at", { withTimezone: true }),
  runtimeStatus: text("runtime_status"),
  runtimeReason: text("runtime_reason"),
  runtimeAt: timestamp("runtime_at", { withTimezone: true }),
  version: integer("version").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Subscriber = typeof subscribersTable.$inferSelect;
