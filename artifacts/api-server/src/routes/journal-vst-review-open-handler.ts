import type { Request, RequestHandler } from "express";
import {
  ResolveJournalVstReviewOpenBody,
  ResolveJournalVstReviewOpenParams,
  ResolveJournalVstReviewOpenResponse,
} from "@workspace/api-zod";

type UnresolvedIntent = {
  sourceSignalId: string;
  state: string;
  request: unknown;
};

export type JournalVstReviewOpenHandlerDependencies = {
  listUnresolvedIntents: () => Promise<UnresolvedIntent[]>;
  resolveStillOpen: (
    sourceSignalId: string,
    input: { remainingQty: string; resolvedBy: string; note: string | null },
  ) => Promise<{
    sourceSignalId: string;
    symbol: string;
    status: string;
    updatedAt: Date | string;
  }>;
  getResolvedBy: (request: Request) => string;
};

function isUnknownPreRunnerCloseIntent(intent: UnresolvedIntent, sourceSignalId: string): boolean {
  const request = intent.request && typeof intent.request === "object" && !Array.isArray(intent.request)
    ? intent.request as Record<string, unknown>
    : {};
  return intent.sourceSignalId === sourceSignalId &&
    intent.state === "unknown" &&
    request.operation === "close_pre_runner_split";
}

export function createJournalVstReviewOpenHandler({
  listUnresolvedIntents,
  resolveStillOpen,
  getResolvedBy,
}: JournalVstReviewOpenHandlerDependencies): RequestHandler {
  return async (req, res): Promise<void> => {
    const params = ResolveJournalVstReviewOpenParams.safeParse(req.params);
    const body = ResolveJournalVstReviewOpenBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "INVALID_VST_REVIEW_RESOLUTION_REQUEST" });
      return;
    }
    const intents = await listUnresolvedIntents();
    if (intents.some((intent) => isUnknownPreRunnerCloseIntent(intent, params.data.sourceSignalId))) {
      res.status(409).json({ error: "VST_LEGACY_CLOSE_REVIEW_REQUIRED" });
      return;
    }
    try {
      const resolved = await resolveStillOpen(params.data.sourceSignalId, {
        remainingQty: body.data.remainingQty,
        resolvedBy: getResolvedBy(req),
        note: body.data.note ?? null,
      });
      res.setHeader("Cache-Control", "no-store");
      res.json(ResolveJournalVstReviewOpenResponse.parse({
        sourceSignalId: resolved.sourceSignalId,
        symbol: resolved.symbol,
        status: resolved.status,
        updatedAt: resolved.updatedAt,
      }));
    } catch (error) {
      if (error instanceof Error && error.message === "vst_legacy_pre_runner_close_review_required") {
        res.status(409).json({ error: "VST_LEGACY_CLOSE_REVIEW_REQUIRED" });
        return;
      }
      if (error instanceof Error && error.message === "vst_position_not_found") {
        res.status(404).json({ error: "VST_POSITION_NOT_FOUND" });
        return;
      }
      if (error instanceof Error && error.message === "vst_position_not_in_error_status") {
        res.status(409).json({ error: "VST_POSITION_NOT_AWAITING_REVIEW" });
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