import type { Request, RequestHandler } from "express";
import {
  ResolveJournalVstReviewPreRunnerCloseBody,
  ResolveJournalVstReviewPreRunnerCloseParams,
  ResolveJournalVstReviewPreRunnerCloseResponse,
} from "@workspace/api-zod";

type LegacyPreRunnerCloseInput = {
  clientOrderId: string;
  confirmation: true;
  resolvedBy: string;
  note: string | null;
};

type LegacyPreRunnerCloseOutcome = {
  kind: string;
  reason?: string;
  position?: {
    sourceSignalId: string;
    symbol: string;
    status: string;
    updatedAt: Date | string;
  };
};

export type JournalVstReviewPreRunnerHandlerDependencies = {
  resolveLegacyClose: (
    sourceSignalId: string,
    input: LegacyPreRunnerCloseInput,
  ) => Promise<LegacyPreRunnerCloseOutcome>;
  getResolvedBy: (request: Request) => string;
};

export function createJournalVstReviewPreRunnerHandler({
  resolveLegacyClose,
  getResolvedBy,
}: JournalVstReviewPreRunnerHandlerDependencies): RequestHandler {
  return async (req, res): Promise<void> => {
    const params = ResolveJournalVstReviewPreRunnerCloseParams.safeParse(req.params);
    const body = ResolveJournalVstReviewPreRunnerCloseBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "INVALID_VST_REVIEW_RESOLUTION_REQUEST" });
      return;
    }
    try {
      const outcome = await resolveLegacyClose(params.data.sourceSignalId, {
        clientOrderId: body.data.clientOrderId,
        confirmation: body.data.confirmation,
        resolvedBy: getResolvedBy(req),
        note: body.data.note ?? null,
      });
      res.setHeader("Cache-Control", "no-store");
      if (outcome.kind === "resolved" || outcome.kind === "replayed") {
        res.json(ResolveJournalVstReviewPreRunnerCloseResponse.parse({
          outcome: outcome.kind,
          position: outcome.position,
        }));
        return;
      }
      if (outcome.kind === "not_found") {
        res.status(404).json({ error: "VST_LEGACY_CLOSE_INTENT_NOT_FOUND" });
        return;
      }
      if (outcome.kind === "busy" ||
          (typeof outcome.reason === "string" && outcome.reason.includes("busy"))) {
        res.status(503).json({ error: "VST_WORKER_BUSY", reason: outcome.reason ?? outcome.kind });
        return;
      }
      res.status(409).json({
        error: "VST_LEGACY_CLOSE_RESOLUTION_REFUSED",
        reason: outcome.reason ?? outcome.kind,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "vst_worker_not_active") {
        res.status(503).json({ error: "VST_WORKER_NOT_ACTIVE" });
        return;
      }
      if (error instanceof TypeError) {
        res.status(400).json({ error: "INVALID_VST_REVIEW_RESOLUTION_REQUEST" });
        return;
      }
      throw error;
    }
  };
}