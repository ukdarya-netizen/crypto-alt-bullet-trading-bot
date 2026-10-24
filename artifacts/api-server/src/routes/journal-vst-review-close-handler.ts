import type { Request, RequestHandler } from "express";
import {
  ResolveJournalVstReviewClosedBody,
  ResolveJournalVstReviewClosedParams,
  ResolveJournalVstReviewClosedResponse,
} from "@workspace/api-zod";

type OwnerAttestedCloseInput = {
  fill: {
    price: string;
    quantity: string;
    at: string;
    exchangeOrderId: string;
    fee: { asset: string; amount: string };
  };
  resolvedBy: string;
  note: string | null;
};

export type JournalVstReviewCloseHandlerDependencies = {
  resolveClosed: (
    sourceSignalId: string,
    input: OwnerAttestedCloseInput,
  ) => Promise<unknown>;
  getResolvedBy: (request: Request) => string;
};

function blockedResponse(kind: string | undefined): {
  status: number;
  error: string;
} {
  switch (kind) {
    case "position_open":
      return { status: 409, error: "VST_REVIEW_POSITION_NOT_FLAT" };
    case "orders_open":
      return { status: 409, error: "VST_REVIEW_ORDERS_REMAIN" };
    case "account_mismatch":
      return { status: 409, error: "VST_REVIEW_ACCOUNT_MISMATCH" };
    case "not_reviewable":
      return { status: 409, error: "VST_POSITION_NOT_AWAITING_REVIEW" };
    case "not_found":
      return { status: 404, error: "VST_POSITION_NOT_FOUND" };
    case "exchange_unavailable":
    case "exchange_unverified":
    case "busy":
    default:
      return { status: 503, error: "VST_REVIEW_EXCHANGE_CHECK_UNAVAILABLE" };
  }
}

export function createJournalVstReviewClosedHandler({
  resolveClosed,
  getResolvedBy,
}: JournalVstReviewCloseHandlerDependencies): RequestHandler {
  return async (req, res): Promise<void> => {
    const params = ResolveJournalVstReviewClosedParams.safeParse(req.params);
    const body = ResolveJournalVstReviewClosedBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "INVALID_VST_REVIEW_RESOLUTION_REQUEST" });
      return;
    }
    try {
      const result = await resolveClosed(params.data.sourceSignalId, {
        fill: {
          price: body.data.fill.price,
          quantity: body.data.fill.quantity,
          at: body.data.fill.at.toISOString(),
          exchangeOrderId: body.data.fill.exchangeOrderId,
          fee: body.data.fill.fee,
        },
        resolvedBy: getResolvedBy(req),
        note: body.data.note ?? null,
      }) as {
        kind?: string;
        position?: {
          sourceSignalId: string;
          symbol: string;
          status: string;
          updatedAt: Date | string;
        };
      } | null;

      if (result?.kind !== "closed" && result?.kind !== "already_closed") {
        const mapped = blockedResponse(result?.kind);
        res.status(mapped.status).json({ error: mapped.error });
        return;
      }

      res.setHeader("Cache-Control", "no-store");
      res.json(ResolveJournalVstReviewClosedResponse.parse({
        sourceSignalId: result.position?.sourceSignalId,
        symbol: result.position?.symbol,
        status: result.position?.status,
        updatedAt: result.position?.updatedAt,
      }));
    } catch (error) {
      if (error instanceof Error && error.message === "vst_legacy_pre_runner_close_review_required") {
        res.status(409).json({ error: "VST_LEGACY_CLOSE_REVIEW_REQUIRED" });
        return;
      }
      if (error instanceof Error && error.message === "vst_worker_not_active") {
        res.status(503).json({ error: "VST_REVIEW_EXCHANGE_CHECK_UNAVAILABLE" });
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
      if (error instanceof Error && error.message === "vst_manual_close_quantity_mismatch") {
        res.status(409).json({ error: "VST_REVIEW_QUANTITY_MISMATCH" });
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
