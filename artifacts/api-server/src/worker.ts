import { db, pool, tradingControlsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./lib/logger";
import { ensureTradingControls } from "./lib/trading-store";
import {
  claimNextSignal,
  finalizePaperSignal,
  recordPaperFailure,
} from "./lib/paper-executor";
import { processPaperExits } from "./lib/paper-exits";
// @ts-expect-error JavaScript module of the bot.
import { ensureRuntimeTables } from "./bullet-bot/runtime-tables.mjs";

// The development workflow runs only this worker: keep the development
// database's bot-created tables identical to production (runtime-tables.mjs).
void ensureRuntimeTables(pool).catch((err: unknown) => {
  logger.error({ err }, "Runtime tables could not be ensured");
});

const pollIntervalMs = 1_500;
const paperExitIntervalMs = 10_000;
let shuttingDown = false;
let lastPaperExit = 0;
let warnedTestnetDisabled = false;

async function heartbeat() {
  await ensureTradingControls();
  await db.update(tradingControlsTable)
    .set({ workerHeartbeatAt: new Date(), updatedAt: new Date() })
    .where(eq(tradingControlsTable.id, 1));
}

async function processOne() {
  const controls = await ensureTradingControls();
  await heartbeat();
  // This executor is retained for historical PAPER positions only. The
  // active Bullet bot uses BingX market data; no legacy Bybit order path runs.
  if (controls.mode !== "paper") {
    if (!warnedTestnetDisabled) {
      warnedTestnetDisabled = true;
      logger.warn({ mode: controls.mode }, "Legacy exchange execution is disabled");
    }
    return;
  }
  if (Date.now() - lastPaperExit >= paperExitIntervalMs) {
    lastPaperExit = Date.now();
    try {
      // Continue monitoring existing positions even when new entries are paused.
      await processPaperExits();
    } catch (error) {
      logger.warn({ err: error }, "Paper exits skipped: quote or protection state unavailable");
    }
  }
  if (controls.killSwitchActive || !controls.acceptingNewEntries) return;

  const signal = await claimNextSignal();
  if (!signal) return;
  try {
    const outcome = await finalizePaperSignal(signal);
    logger.info({ signalId: signal.id, attempt: signal.attempts, outcome }, "Paper signal processed");
  } catch (error) {
    logger.error({ err: error, signalId: signal.id }, "Signal execution failed");
    await recordPaperFailure(signal, error);
  }
}

async function run() {
  logger.info({ mode: "legacy paper only", pollIntervalMs, failClosed: true }, "Trading worker started");
  while (!shuttingDown) {
    try {
      await processOne();
    } catch (error) {
      logger.error({ err: error }, "Trading worker loop failed");
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  await pool.end();
  logger.info("Trading worker stopped");
}

function requestShutdown(signal: string) {
  logger.info({ signal }, "Trading worker shutdown requested");
  shuttingDown = true;
}
process.on("SIGTERM", () => requestShutdown("SIGTERM"));
process.on("SIGINT", () => requestShutdown("SIGINT"));
run().catch((error) => {
  logger.fatal({ err: error }, "Trading worker failed to start");
  process.exit(1);
});