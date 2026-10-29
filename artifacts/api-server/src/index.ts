import app from "./app";
import { logger } from "./lib/logger";
import { startBotWorker, stopBotWorker } from "./bullet-bot/bot-runtime.mjs";
import { auditLiveFunding } from "./lib/live-funding-audit";
import { pool } from "@workspace/db";
// @ts-expect-error JavaScript module of the bot.
import { ensureRuntimeTables } from "./bullet-bot/runtime-tables.mjs";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

// Same tables in development and production (see runtime-tables.mjs).
void ensureRuntimeTables(pool).catch((err: unknown) => {
  logger.error({ err }, "Runtime tables could not be ensured");
});

void startBotWorker().catch((err: unknown) => {
  // "both" carries the same live-exchange VST risk as exclusive VST mode: a
  // startup failure must not leave the HTTP ingest endpoint accepting
  // signals into vst_signals with no tick loop running to manage them.
  if (process.env.BULLET_VST_MODE === "vst" || process.env.BULLET_VST_MODE === "both") {
    logger.fatal({ err }, "Bullet VST worker could not start");
    process.exit(1);
  }
  logger.error({ err }, "Bullet PAPER worker could not start");
});

// Accounting only: no write permission is supplied to the BingX adapter.
// The shared LIVE advisory lock prevents overlapping audits or live execution.
const auditFunding = async () => {
  try {
    const results = await auditLiveFunding();
    for (const result of results ?? []) {
      if (result.status === "incomplete") {
        logger.warn({ signalId: result.signalId, reason: result.reason },
          "LIVE funding remains unverified");
      }
    }
  } catch (err) {
    logger.warn({ err }, "LIVE funding audit unavailable");
  }
};
void auditFunding();
setInterval(() => { void auditFunding(); }, 15 * 60 * 1000).unref();

// The published VM runs only the API service. Start its durable queue worker
// in the same process; development already has a separate worker workflow.
const shutdown = () => {
  server.close();
  void stopBotWorker().then(() => {
    logger.info("Trading worker drained before shutdown");
  }).catch((err: unknown) => {
    logger.error({ err }, "Trading worker shutdown failed");
  });
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
if (process.env.NODE_ENV === "production") {
  void import("./worker").catch((err: unknown) => {
    logger.fatal({ err }, "Trading worker could not start");
    process.exit(1);
  });
}
