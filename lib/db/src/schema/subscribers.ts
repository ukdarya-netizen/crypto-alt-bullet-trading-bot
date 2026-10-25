import { boolean, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

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
