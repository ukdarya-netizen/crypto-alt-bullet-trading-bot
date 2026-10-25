import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

export * from "./schema";

/**
 * A pool whose every connection sees ONLY one subscriber schema (no public
 * fallback), so the unmodified VST ledger code reads and writes that
 * subscriber's own tables.
 */
export function createSubscriberSchemaPool(schemaName: string, max = 4): pg.Pool {
  if (!/^sub_[0-9]{1,9}$/.test(schemaName)) throw new Error("invalid subscriber schema name");
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    max,
    options: `-c search_path=${schemaName}`,
  });
}
export { inspectVstFillArchiveSchema } from "./vst-fill-archive-schema.mjs";
