import { GetJournalVstEntryQueueResponse } from "@workspace/api-zod";
import type { RequestHandler } from "express";

export function createJournalVstEntryQueueHandler(
  readQueue: () => Promise<unknown>,
): RequestHandler {
  return async (_req, res): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(GetJournalVstEntryQueueResponse.parse(await readQueue()));
    } catch {
      res.status(503).json({ error: "VST_ENTRY_QUEUE_UNAVAILABLE" });
    }
  };
}