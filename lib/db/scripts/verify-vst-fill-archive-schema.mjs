import pg from "pg";
import { inspectVstFillArchiveSchema } from "../src/vst-fill-archive-schema.mjs";

if (!process.env.DATABASE_URL) {
  process.stderr.write("VST fill archive schema verification failed: DATABASE_URL is not configured\n");
  process.exitCode = 1;
} else {
  const { Pool } = pg;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const readiness = await inspectVstFillArchiveSchema(pool);
    if (!readiness.ready) {
      process.stderr.write(
        `VST fill archive schema verification failed; missing or misresolved: ${readiness.missing.join(", ")}\n`,
      );
      process.exitCode = 1;
    } else {
      process.stdout.write("VST fill archive schema verification passed (both tables and required columns are ready)\n");
    }
  } catch (error) {
    const sqlState = typeof error?.code === "string" ? ` (SQLSTATE ${error.code})` : "";
    process.stderr.write(
      `VST fill archive schema verification failed: read-only database check${sqlState}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}