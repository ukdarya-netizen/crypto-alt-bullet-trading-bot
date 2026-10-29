// Tables and columns the bot creates itself (CREATE ... IF NOT EXISTS / ADD
// COLUMN IF NOT EXISTS). Ensured at every start, in EVERY environment
// (owner 2026-10-29): Replit's publish compares the development database
// with production and offered to DROP whatever existed only in production.
// Creating them in development too keeps both identical. Idempotent.
import { ensureSubscribersTable } from "./subscriber-trading.mjs";
import { ensureOwnerStrategyTable } from "./owner-trading-strategy.mjs";
import { ensureStrategyPaperTable } from "./strategy-paper.mjs";

export async function ensureRuntimeTables(pool) {
  await ensureSubscribersTable(pool);
  await ensureOwnerStrategyTable(pool);
  await ensureStrategyPaperTable(pool);
}
