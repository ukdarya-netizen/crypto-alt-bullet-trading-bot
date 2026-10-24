import { GetJournalVstEntryQueueResponse } from "@workspace/api-zod";
import type { RequestHandler } from "express";

export function createJournalVstEntryQueueHandler(
  readQueue: () => Promise<unknown>,
  readLatency?: () => Promise<unknown>,
): RequestHandler {
  return async (_req, res): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const [queue, latency] = await Promise.all([readQueue(), readLatency?.()]);
      res.json(GetJournalVstEntryQueueResponse.parse({
        ...queue as object, ...(latency ? { latency } : {}),
      }));
    } catch {
      res.status(503).json({ error: "VST_ENTRY_QUEUE_UNAVAILABLE" });
    }
  };
}