import { Router, type IRouter } from "express";
import {
  cancelHistoricalCascadeSelection,
  getHistoricalCascadeSelection,
  listHistoricalCascadeCandidates,
  selectHistoricalCascadeCandidate,
} from "../lib/historical-cascade-selection";
import { requireJournalOwner, requireJournalSession } from "../middlewares/journalAccess";

const router: IRouter = Router();
const ownerOnly = [requireJournalSession, requireJournalOwner] as const;

router.get("/journal/historical-cascade-selection", ...ownerOnly, async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await getHistoricalCascadeSelection());
});

router.get("/journal/historical-cascade-candidates", ...ownerOnly, async (_req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json({ candidates: await listHistoricalCascadeCandidates() });
  } catch (error) {
    res.status(503).json({
      error: "HISTORICAL_CANDIDATES_UNAVAILABLE",
      message: error instanceof Error ? error.message : "Historical PAPER records are unavailable.",
    });
  }
});

router.post("/journal/historical-cascade-selection", ...ownerOnly, async (req, res) => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
      Object.keys(req.body).some((key) => key !== "sourceSignalId") ||
      typeof req.body.sourceSignalId !== "string" || req.body.sourceSignalId.trim() === "") {
    res.status(400).json({ error: "INVALID_CANDIDATE", message: "sourceSignalId is required." });
    return;
  }
  try {
    res.status(201).json(await selectHistoricalCascadeCandidate(req.body.sourceSignalId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Historical candidate could not be selected.";
    const status = message.includes("one-shot") ? 409 :
      message.includes("not an eligible historical") ? 422 : 503;
    res.status(status).json({ error: "HISTORICAL_CANDIDATE_SELECTION_FAILED", message });
  }
});

router.post("/journal/historical-cascade-selection/cancel", ...ownerOnly, async (_req, res) => {
  try {
    res.json(await cancelHistoricalCascadeSelection());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Historical candidate could not be cancelled.";
    const status = message.includes("after entry intent") ? 409 :
      message.includes("no claimed") ? 404 : 409;
    res.status(status).json({ error: "HISTORICAL_CANDIDATE_CANCELLATION_FAILED", message });
  }
});

export default router;