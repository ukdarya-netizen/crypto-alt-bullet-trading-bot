import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Technical incident checkpoint only: no signal/order/trade-outbox linkage.
export const botHealthIncidentsTable = pgTable("bot_health_incidents", {
  key: text("key").primaryKey(),
  state: jsonb("state").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const insertBotHealthIncidentSchema = createInsertSchema(botHealthIncidentsTable);
export type InsertBotHealthIncident = z.infer<typeof insertBotHealthIncidentSchema>;
export type BotHealthIncident = typeof botHealthIncidentsTable.$inferSelect;