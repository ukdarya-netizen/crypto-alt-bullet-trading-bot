import { GetJournalBotHealthResponse } from "@workspace/api-zod";
import type { RequestHandler } from "express";

export function createJournalBotHealthHandler(
  readHealth: () => Promise<unknown>,
): RequestHandler {
  return async (_req, res): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(GetJournalBotHealthResponse.parse(await readHealth()));
    } catch {
      res.status(503).json({ error: "BOT_HEALTH_UNAVAILABLE" });
    }
  };
}