-- Technical health checkpoint only. Provision via the normal schema publication
-- step (Drizzle model: lib/db/src/schema/bot-health.ts), never runtime DDL.
-- No signals, trading events, orders, or trade-outbox rows are created.
CREATE TABLE IF NOT EXISTS bot_health_incidents (
  key text PRIMARY KEY,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);