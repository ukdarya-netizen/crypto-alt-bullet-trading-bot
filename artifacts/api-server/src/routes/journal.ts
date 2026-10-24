import { getAuth } from "@clerk/express";
import { Router, type IRouter } from "express";
import {
  ClosePaperTradeBody,
  ClosePaperTradeParams,
  ClosePaperTradeResponse,
  GetJournalBingxConnectionResponse,
  GetJournalBingxLivePreflightQueryParams,
  GetJournalBingxLivePreflightResponse,
  GetJournalBingxPositionsResponse,
  GetJournalAccessResponse,
  GetJournalBotResponse,
  GetJournalVstPositionsResponse,
  GetJournalVstReviewResponse,
  ResolveJournalVstReviewMarginTopUpKeepOpenParams,
  ResolveJournalVstReviewMarginTopUpKeepOpenBody,
  ResolveJournalVstReviewMarginTopUpKeepOpenResponse,
  GetJournalVstReviewMarginTopUpCheckParams,
  GetJournalVstReviewMarginTopUpCheckResponse,
  CloseJournalVstReviewNowParams,
  CloseJournalVstReviewNowResponse,
  CloseJournalVstReviewMarginTopUpNowParams,
  CloseJournalVstReviewMarginTopUpNowResponse,
  ConfirmJournalVstReviewOpenNowParams,
  ConfirmJournalVstReviewOpenNowResponse,
  GetJournalOverviewResponse,
  GetJournalStrategyHistoryResponse,
  GetJournalTradeParams,
  GetJournalTradeResponse,
  ListJournalTradesQueryParams,
  ListJournalTradesResponse,
  UpdateJournalTradeNotesBody,
  UpdateJournalTradeNotesParams,
  UpdateJournalTradeNotesResponse,
} from "@workspace/api-zod";
import { pool as dbPool } from "@workspace/db";
// @ts-expect-error The shared PAPER store is JavaScript and intentionally remains in the bot module.
import { createStore } from "../bullet-bot/store.mjs";
// @ts-expect-error The VST store is JavaScript and intentionally remains in the bot module.
import { createVstStore } from "../bullet-bot/vst-store.mjs";
import {
  closeVstReviewPositionNow, resolveVstReviewOwnerAttestedClosed,
  resolveLegacyPreRunnerClose,
  confirmVstReviewPositionStillOpenNow,
  resolveVstReviewMarginTopUpKeepOpenNow, readVstReviewMarginTopUpMarginNow,
  closeVstReviewMarginTopUpPositionNow,
} from "../bullet-bot/bot-runtime.mjs";
import { createJournalVstReviewClosedHandler } from "./journal-vst-review-close-handler";
import { createJournalVstReviewPreRunnerHandler } from "./journal-vst-review-pre-runner-handler";
import { createJournalVstReviewOpenHandler } from "./journal-vst-review-open-handler";
import { vstPositionPriceAudit } from "../bullet-bot/vst-price-audit.mjs";
// @ts-expect-error The read-only BingX credential probe is JavaScript.
import { probeBingXConnection } from "../bullet-bot/bingx-connection.mjs";
// @ts-expect-error The read-only live preflight is JavaScript.
import { probeBingXLivePreflight } from "../bullet-bot/bingx-live-preflight.mjs";
// @ts-expect-error The read-only account position adapter is JavaScript.
import { readBingXAccountPositions, readBingXAccountClosedTrades } from "../bullet-bot/bingx-account-positions.mjs";
// @ts-expect-error The read-only VST account position adapter is JavaScript.
import { readBingXVstAccountPositions } from "../bullet-bot/bingx-vst-account-positions.mjs";
import {
  getJournalTrade,
  journalOverview,
  listJournalTrades,
  saveJournalNotes,
} from "../lib/journal";
import { paperPositionMarket } from "../lib/paper-position-market";
import { paperAccountEquity } from "../lib/paper-account-equity";
import { journalStrategyHistory } from "../lib/strategy-history";
import { auditLiveFunding } from "../lib/live-funding-audit";
import { paperPositionMargin } from "../lib/paper-position-margin";
// @ts-expect-error Read-only VST ledger queue projection is JavaScript.
import { readVstEntryQueue } from "../lib/vst-entry-queue.mjs";
import { createJournalVstEntryQueueHandler } from "./journal-vst-entry-queue-handler";
import { createJournalBotHealthHandler } from "./journal-bot-health-handler";
import { buildBotHealth, createLedgerHealthReader } from "../lib/bot-health";
import { getBotRuntimeHealth } from "../bullet-bot/bot-health-runtime.mjs";
import { listSourceCommands } from "../bullet-bot/bot-runtime.mjs";
import { GetJournalSourceCommandsResponse } from "@workspace/api-zod";
import { closePaperPosition, PaperCloseError } from "../lib/manual-paper-close";
// @ts-expect-error Runtime-only worker health state, without exchange credentials.
import { getSourceSyncStatus } from "../bullet-bot/source-sync-status.mjs";
import {
  requireJournalOwner,
  requireJournalSession,
} from "../middlewares/journalAccess";

const router: IRouter = Router();
type BulletPaperStore = {
  getPaperDashboardSnapshot: () => Promise<{
    paperAccount: {
      initialUsdt: number;
      freeUsdt: number;
      reservedUsdt: number;
      realizedPnlUsdt: number;
    };
    fundingHealth: {
      incompleteCount: number;
      legacyUnknownCount: number;
      verifiedSettlementCount: number;
      verifiedNetCostUsdt: string;
      unverifiedPositions: Array<{
        symbol: string;
        fromAt: string | null;
        status: string;
        verifiedSettlements: number;
        verifiedFundingTimes: number[];
      }>;
    };
    positions: Array<{
      sourceSignalId: string;
      snapshot: Record<string, unknown>;
      status: string;
      updatedAt: Date | string;
    }>;
    recentClosedPositions: Array<{
      sourceSignalId: string;
      snapshot: Record<string, unknown>;
      status: string;
      updatedAt: Date | string;
    }>;
  }>;
  getPaperAccount: () => Promise<{
    initialUsdt: number;
    freeUsdt: number;
    reservedUsdt: number;
    realizedPnlUsdt: number;
  }>;
  getPaperFundingHealth: () => Promise<{
    incompleteCount: number;
    legacyUnknownCount: number;
  }>;
  listRecent: (limit: number) => Promise<Array<{
    sourceSignalId: string;
    body: unknown;
    bodyHash: unknown;
    status: string;
    reason: string | null;
    receivedAt: Date | string;
    updatedAt: Date | string;
  }>>;
  listOpenPositions: () => Promise<Array<{
    sourceSignalId: string;
    snapshot: Record<string, unknown>;
    status: string;
    updatedAt: Date | string;
  }>>;
  listClosedPaperPositions: (limit: number) => Promise<Array<{
    sourceSignalId: string;
    snapshot: Record<string, unknown>;
    status: string;
    updatedAt: Date | string;
  }>>;
  getMissedSourceSignalsSummary: (limit?: number) => Promise<{
    count: number;
    items: Array<{
      sourceSignalId: string;
      detectedAt: Date | string;
      symbol?: string | null;
      sourceStatus?: string | null;
      botEnqueuedAt?: string | null;
    }>;
  }>;
};
const bulletPaperStore = (createStore as (pool: typeof dbPool) => BulletPaperStore)(dbPool);
type VstStore = {
  listRecentClosedPositions: (limit: number) => Promise<Array<{
    sourceSignalId: string;
    symbol: string;
    status: string;
    snapshot: Record<string, unknown>;
    updatedAt: Date | string;
  }>>;
  listErrorPositions: () => Promise<Array<{
    sourceSignalId: string;
    symbol: string;
    status: string;
    snapshot: Record<string, unknown>;
    updatedAt: Date | string;
    signalReason: string | null;
  }>>;
  resolvePositionAsClosed: (sourceSignalId: string, input: {
    fill: {
      price: string; quantity: string; at: string; exchangeOrderId: string;
      fee: { asset: string; amount: string };
    };
    resolvedBy: string;
    note: string | null;
  }) => Promise<{ sourceSignalId: string; symbol: string; status: string; updatedAt: Date | string }>;
  resolvePositionAsStillOpen: (sourceSignalId: string, input: {
    remainingQty: string; resolvedBy: string; note: string | null;
  }) => Promise<{ sourceSignalId: string; symbol: string; status: string; updatedAt: Date | string }>;
  listMarginTopUpPendingPositions: () => Promise<Array<{
    sourceSignalId: string;
    symbol: string;
    status: string;
    snapshot: Record<string, unknown>;
    updatedAt: Date | string;
    signalReason: string | null;
  }>>;
  resolveMarginTopUpKeepOpen: (sourceSignalId: string, input: {
    resolvedBy: string; note: string | null;
  }) => Promise<{ sourceSignalId: string; symbol: string; status: string; updatedAt: Date | string }>;
  listUnresolvedIntents: () => Promise<Array<{
    sourceSignalId: string;
    phase: string;
    clientOrderId: string;
    request: unknown;
    state: string;
    outcome: unknown;
    createdAt: Date | string;
    updatedAt: Date | string;
  }>>;
  listLegacyPreRunnerCloseReviews: VstStore["listUnresolvedIntents"];
};
const vstStore = (createVstStore as (pool: typeof dbPool) => VstStore)(dbPool);

function positiveText(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const text = String(value);
  return text.trim() && Number.isFinite(Number(text)) && Number(text) > 0 ? text : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

router.use("/journal", requireJournalSession);

router.get("/journal/access", (req, res) => {
  const configured = Boolean(process.env.JOURNAL_OWNER_USER_ID);
  res.setHeader("Cache-Control", "no-store");
  res.json(GetJournalAccessResponse.parse({
    configured,
    authorized: configured && getAuth(req).userId === process.env.JOURNAL_OWNER_USER_ID,
  }));
});

router.use("/journal", requireJournalOwner);
router.get("/journal/source-commands", async (_req, res) => {
  try {
    res.json(GetJournalSourceCommandsResponse.parse({ commands: await listSourceCommands() }));
  } catch {
    res.status(503).json({ error: { code: "command_inbox_unavailable" } });
  }
});

const readHealthLedger = createLedgerHealthReader(dbPool);
router.get("/journal/bot-health", createJournalBotHealthHandler(async () =>
  buildBotHealth(getBotRuntimeHealth(), await readHealthLedger(), {
    production: process.env.NODE_ENV === "production",
  })));

router.get("/journal/vst-entry-queue",
  createJournalVstEntryQueueHandler(() => readVstEntryQueue(dbPool)));

router.get("/journal/overview", async (_req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  res.json(GetJournalOverviewResponse.parse(await journalOverview()));
});

router.get("/journal/bot", async (_req, res): Promise<void> => {
  const [dashboard, recentSignals, missedSourceSignals] = await Promise.all([
    bulletPaperStore.getPaperDashboardSnapshot(),
    bulletPaperStore.listRecent(50),
    bulletPaperStore.getMissedSourceSignalsSummary(),
  ]);
  const { paperAccount, fundingHealth, positions, recentClosedPositions } = dashboard;
  res.setHeader("Cache-Control", "no-store");
  const marketObservedAt = Date.now();
  const markedPositions = positions.map((position) => ({
    ...position,
    market: paperPositionMarket(position.snapshot, marketObservedAt),
    marginRisk: paperPositionMargin(position.snapshot),
  }));
  res.json(GetJournalBotResponse.parse({
    source: "BingX",
    mode: "paper",
    sourceSync: getSourceSyncStatus(),
    missedSourceSignals,
    paperAccount,
    paperEquity: paperAccountEquity(paperAccount, markedPositions, fundingHealth),
    signals: recentSignals.map(({ body: _body, bodyHash: _bodyHash, ...signal }) => signal),
    positions: markedPositions,
    recentClosedPositions,
  }));
});

router.get("/journal/vst-positions", async (_req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const [dbResult, live, recentClosed] = await Promise.all([
    dbPool.query(
      `SELECT source_signal_id, symbol, status, snapshot, updated_at
       FROM vst_positions
       WHERE status IN ('open', 'closing', 'unknown')
       ORDER BY updated_at DESC, source_signal_id
       LIMIT 100`,
    ),
    readBingXVstAccountPositions().catch(() => ({
      status: "unavailable", observedAt: null, positions: [],
      accountStatus: "unavailable", accountObservedAt: null, account: null,
    })),
    vstStore.listRecentClosedPositions(20),
  ]);
  // The worker's preexisting-position guard is scoped per symbol, not
  // whole-account: many symbols can each carry their own independent
  // exchange-open VST position concurrently. Only the SAME symbol is ever
  // limited to one exchange-open position at a time.
  const liveBySymbol = new Map(
    (live.positions ?? [])
      .filter((position: { symbol: string }) => /^[A-Z0-9]+USDT$/.test(position.symbol.replace("-", "")))
      .map((position: { symbol: string }) => [position.symbol.replace("-", ""), position]),
  );
  res.json(GetJournalVstPositionsResponse.parse({
    environment: "vst",
    source: "vst_ledger",
    exchangeVerification: "requested",
    positionsStatus: live.status,
    observedAt: live.observedAt,
    accountStatus: live.accountStatus,
    accountObservedAt: live.accountObservedAt,
    account: live.account,
    positions: dbResult.rows.map((row: {
      source_signal_id: string; symbol: string; status: string;
      snapshot: unknown; updated_at: Date | string;
    }) => {
      const snapshot = record(row.snapshot);
      const stops = Array.isArray(snapshot.protectiveStops) ? snapshot.protectiveStops : [];
      const degradation = record(snapshot.protectionDegradation);
      const verifiedCore = record(record(snapshot.verifiedProtectiveStops).core);
      const matched = liveBySymbol.get(row.symbol) as {
        markPrice: string | null; unrealizedPnlUsdt: string | null;
        roePercent: string | null; size: string;
      } | undefined;
      return {
        sourceSignalId: row.source_signal_id,
        symbol: row.symbol,
        status: row.status,
        updatedAt: new Date(row.updated_at).toISOString(),
        entryPrice: positiveText(record(snapshot.verifiedFill).price ?? snapshot.entryPrice),
        ...vstPositionPriceAudit(snapshot),
        remainingQty: positiveText(snapshot.remainingQty),
        stopPrice: verifiedCore.verified === true ? positiveText(verifiedCore.stopPrice)
          : stops.length === 1 ? positiveText(record(stops[0]).stopPrice) : null,
        protectionStatus: degradation.version === 1 ? String(degradation.status) : null,
        deferredStopPrice: degradation.version === 1 ? positiveText(degradation.requestedStopPrice) : null,
        protectionObservedAt: degradation.version === 1 &&
          Number.isSafeInteger(degradation.protectionObservedAt)
          ? new Date(Number(degradation.protectionObservedAt)).toISOString() : null,
        currentPrice: matched ? positiveText(matched.markPrice) : null,
        unrealizedPnlUsdt: matched ? matched.unrealizedPnlUsdt : null,
        roePercent: matched ? matched.roePercent : null,
        exchangeQuantity: matched ? positiveText(matched.size) : null,
        // A fresh exchange read with no matching position is real evidence the
        // ledger is behind; it is surfaced, not silently applied. The ledger
        // status is left for the worker's own fill-verified reconciliation.
        sourceMismatch: live.status === "available" && !matched &&
          (row.status === "open" || row.status === "closing"),
      };
    }),
    // Raw snapshot passthrough, same as JournalBot.recentClosedPositions:
    // closeFill/lastCloseFill/manualResolution are read directly by the
    // client rather than re-parsed here, so no close economics are
    // recomputed or fabricated in this route.
    recentClosedPositions: recentClosed.map((position: {
      sourceSignalId: string; symbol: string; status: string;
      snapshot: unknown; updatedAt: Date | string;
    }) => ({
      sourceSignalId: position.sourceSignalId,
      symbol: position.symbol,
      status: position.status,
      snapshot: record(position.snapshot),
      updatedAt: new Date(position.updatedAt).toISOString(),
    })),
  }));
});

router.get("/journal/vst-review", async (_req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const [positions, marginTopUpPending, unresolvedIntents, reviewHistory] = await Promise.all([
    vstStore.listErrorPositions(),
    vstStore.listMarginTopUpPendingPositions(),
    vstStore.listUnresolvedIntents(),
    vstStore.listLegacyPreRunnerCloseReviews(),
  ]);
  res.json(GetJournalVstReviewResponse.parse({
    positions: positions.map((position) => {
      const snapshot = record(position.snapshot);
      const stops = Array.isArray(snapshot.protectiveStops) ? snapshot.protectiveStops : [];
      return {
        sourceSignalId: position.sourceSignalId,
        symbol: position.symbol,
        updatedAt: new Date(position.updatedAt).toISOString(),
        reason: position.signalReason,
        entryPrice: positiveText(record(snapshot.verifiedFill).price),
        remainingQty: positiveText(snapshot.remainingQty),
        stopPrice: stops.length === 1 ? positiveText(record(stops[0]).stopPrice) : null,
      };
    }),
    marginTopUpPending: marginTopUpPending.map((position: {
      sourceSignalId: string; symbol: string; updatedAt: Date | string;
      signalReason: string | null; snapshot: unknown;
    }) => {
      const snapshot = record(position.snapshot);
      const marginTopUp = record(snapshot.marginTopUp);
      return {
        sourceSignalId: position.sourceSignalId,
        symbol: position.symbol,
        updatedAt: new Date(position.updatedAt).toISOString(),
        reason: position.signalReason,
        entryPrice: positiveText(snapshot.entryPrice),
        stopPrice: positiveText(snapshot.stopPrice),
        topUpAmount: positiveText(marginTopUp.amount),
      };
    }),
    legacyPreRunnerCloseHistory: reviewHistory.map((intent) => {
      const review = record(record(intent.outcome).ownerPreRunnerCloseReview);
      return {
        clientOrderId: intent.clientOrderId,
        sourceSignalId: intent.sourceSignalId,
        symbol: record(intent.request).symbol,
        timestamp: new Date(intent.createdAt).toISOString(),
        checkedAt: review.checkedAt,
        resolvedBy: review.resolvedBy,
        outcome: review.outcome,
        note: review.note ?? null,
        originalOutcome: review.originalOutcome ?? null,
        evidence: review.evidence,
      };
    }),
    // Unknown close intents are surfaced independently of ledger status: a
    // position may not be in error even while this operation blocks the bot.
    legacyPreRunnerCloseIntents: unresolvedIntents
      .filter((intent) => intent.state === "unknown" &&
        record(intent.request).operation === "close_pre_runner_split")
      .map((intent) => {
        const request = record(intent.request);
        const outcome = record(intent.outcome);
        return {
          clientOrderId: intent.clientOrderId,
          sourceSignalId: intent.sourceSignalId,
          symbol: request.symbol,
          reason: typeof outcome.reason === "string" ? outcome.reason
            : typeof outcome.error === "string" ? outcome.error : null,
          timestamp: new Date(intent.createdAt).toISOString(),
        };
      }),
  }));
});

router.post(
  "/journal/vst-review/:sourceSignalId/resolve-pre-runner-close",
  createJournalVstReviewPreRunnerHandler({
    resolveLegacyClose: resolveLegacyPreRunnerClose,
    getResolvedBy: (req) => getAuth(req).userId!,
  }),
);

router.post("/journal/vst-review/:sourceSignalId/resolve-closed",
  createJournalVstReviewClosedHandler({
    resolveClosed: resolveVstReviewOwnerAttestedClosed,
    getResolvedBy: (req) => getAuth(req).userId!,
  }));

router.get(
  "/journal/vst-review/:sourceSignalId/margin-top-up-check",
  async (req, res): Promise<void> => {
    const params = GetJournalVstReviewMarginTopUpCheckParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "INVALID_VST_REVIEW_RESOLUTION_REQUEST" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    try {
      const outcome = await readVstReviewMarginTopUpMarginNow(params.data.sourceSignalId);
      if (outcome.kind === "ok") {
        res.json(GetJournalVstReviewMarginTopUpCheckResponse.parse({
          outcome: "ok",
          symbol: outcome.symbol,
          isolatedMargin: outcome.isolatedMargin,
          expectedIsolatedMarginBefore: outcome.expectedIsolatedMarginBefore,
          expectedIsolatedMarginAfter: outcome.expectedIsolatedMarginAfter,
          observedAt: outcome.observedAt,
        }));
        return;
      }
      if (outcome.kind === "not_found") {
        res.status(404).json({ error: "VST_POSITION_NOT_FOUND" });
        return;
      }
      // "ok" requires complete history with no ManualMarginAddition plus
      // verified position protection. The returned margin field is BingX
      // initialMargin (the entry baseline), not current funded collateral and
      // not evidence that this bot's individual POST was the source. Any
      // positive or incomplete history remains a non-"ok" outcome.
      res.json(GetJournalVstReviewMarginTopUpCheckResponse.parse({
        outcome: outcome.kind === "position_not_found_on_exchange"
          ? "position_not_found_on_exchange"
          : outcome.kind === "read_unavailable"
            ? "read_unavailable"
            : "unavailable",
        symbol: null,
        isolatedMargin: null,
        expectedIsolatedMarginBefore: null,
        expectedIsolatedMarginAfter: null,
        observedAt: null,
      }));
    } catch (error) {
      if (error instanceof Error && error.message === "vst_worker_not_active") {
        res.status(409).json({ error: "VST_WORKER_NOT_ACTIVE" });
        return;
      }
      throw error;
    }
  },
);

router.post(
  "/journal/vst-review/:sourceSignalId/resolve-margin-top-up-keep-open",
  async (req, res): Promise<void> => {
    const params = ResolveJournalVstReviewMarginTopUpKeepOpenParams.safeParse(req.params);
    const body = ResolveJournalVstReviewMarginTopUpKeepOpenBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "INVALID_VST_REVIEW_RESOLUTION_REQUEST" });
      return;
    }
    try {
      // Never accepts the owner's "margin not added" claim on its own: a
      // fresh, read-only BingX check requires complete adjustment history
      // without a margin addition, plus verified live protection. Since the
      // history has no operation ID, it never claims the bot POST's origin.
      const outcome = await resolveVstReviewMarginTopUpKeepOpenNow(
        params.data.sourceSignalId,
        getAuth(req).userId!,
        body.data.note ?? null,
      );
      res.setHeader("Cache-Control", "no-store");
      if (outcome.kind === "resolved") {
        const resolved = outcome.position;
        res.json(ResolveJournalVstReviewMarginTopUpKeepOpenResponse.parse({
          sourceSignalId: resolved.sourceSignalId,
          symbol: resolved.symbol,
          status: resolved.status,
          updatedAt: resolved.updatedAt,
        }));
        return;
      }
      if (outcome.kind === "not_found") {
        res.status(404).json({ error: "VST_POSITION_NOT_FOUND" });
        return;
      }
      if (outcome.kind === "mismatch_margin_was_added") {
        res.status(409).json({
          error: "VST_MARGIN_TOP_UP_ALREADY_ADDED",
          observedIsolatedMargin: outcome.observedIsolatedMargin,
        });
        return;
      }
      if (outcome.kind === "mismatch_unexpected_margin") {
        res.status(409).json({
          error: "VST_MARGIN_TOP_UP_MARGIN_MISMATCH",
          observedIsolatedMargin: outcome.observedIsolatedMargin,
        });
        return;
      }
      if (outcome.kind === "position_not_found_on_exchange") {
        res.status(409).json({ error: "VST_MARGIN_TOP_UP_POSITION_NOT_FOUND_ON_EXCHANGE" });
        return;
      }
      if (outcome.kind === "read_unavailable") {
        res.status(409).json({ error: "VST_MARGIN_TOP_UP_CHECK_UNAVAILABLE" });
        return;
      }
      // "blocked" / "resolve_failed": the corroboration itself never wrote
      // anything to the ledger either way, so this is always safe to retry.
      res.status(409).json({ error: "VST_POSITION_NOT_AWAITING_REVIEW", reason: outcome.reason ?? outcome.error ?? outcome.kind });
    } catch (error) {
      if (error instanceof Error && error.message === "vst_worker_not_active") {
        res.status(409).json({ error: "VST_WORKER_NOT_ACTIVE" });
        return;
      }
      if (error instanceof TypeError) {
        res.status(400).json({ error: "INVALID_VST_REVIEW_RESOLUTION_REQUEST" });
        return;
      }
      throw error;
    }
  },
);

router.post(
  "/journal/vst-review/:sourceSignalId/resolve-open",
  createJournalVstReviewOpenHandler({
    listUnresolvedIntents: () => vstStore.listUnresolvedIntents(),
    resolveStillOpen: (sourceSignalId, input) =>
      vstStore.resolvePositionAsStillOpen(sourceSignalId, input),
    getResolvedBy: (req) => getAuth(req).userId!,
  }),
);

router.post(
  "/journal/vst-review/:sourceSignalId/close-now",
  async (req, res): Promise<void> => {
    const params = CloseJournalVstReviewNowParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "INVALID_VST_REVIEW_RESOLUTION_REQUEST" });
      return;
    }
    try {
      const result = await closeVstReviewPositionNow(
        params.data.sourceSignalId,
        getAuth(req).userId!,
      );
      res.setHeader("Cache-Control", "no-store");
      if (result.kind === "closed") {
        res.json(CloseJournalVstReviewNowResponse.parse({
          outcome: "closed",
          sourceSignalId: result.position.sourceSignalId,
          symbol: result.position.symbol,
          status: result.position.status,
          updatedAt: result.position.updatedAt,
        }));
        return;
      }
      if (result.kind === "already_flat") {
        res.json(CloseJournalVstReviewNowResponse.parse({ outcome: "already_flat" }));
        return;
      }
      if (result.kind === "not_found") {
        res.status(404).json({ error: "VST_POSITION_NOT_FOUND" });
        return;
      }
      // blocked / read_unavailable / pending_reconciliation / unverified /
      // closed_but_unrecorded: the attempt could not be safely completed or
      // confirmed this time. Never reported as "closed" -- nothing here is
      // allowed to fabricate a close the exchange did not verify.
      res.json(CloseJournalVstReviewNowResponse.parse({
        outcome: "not_confirmed",
        reason: result.reason ?? result.kind,
      }));
    } catch (error) {
      if (error instanceof Error && error.message === "vst_worker_not_active") {
        res.status(409).json({ error: "VST_WORKER_NOT_ACTIVE" });
        return;
      }
      throw error;
    }
  },
);

router.post(
  "/journal/vst-review/:sourceSignalId/close-margin-top-up-now",
  async (req, res): Promise<void> => {
    const params = CloseJournalVstReviewMarginTopUpNowParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "INVALID_VST_REVIEW_RESOLUTION_REQUEST" });
      return;
    }
    try {
      const result = await closeVstReviewMarginTopUpPositionNow(
        params.data.sourceSignalId,
        getAuth(req).userId!,
      );
      res.setHeader("Cache-Control", "no-store");
      if (result.kind === "closed") {
        res.json(CloseJournalVstReviewMarginTopUpNowResponse.parse({
          outcome: "closed",
          sourceSignalId: result.position.sourceSignalId,
          symbol: result.position.symbol,
          status: result.position.status,
          updatedAt: result.position.updatedAt,
        }));
        return;
      }
      if (result.kind === "already_flat") {
        res.json(CloseJournalVstReviewMarginTopUpNowResponse.parse({ outcome: "already_flat" }));
        return;
      }
      if (result.kind === "not_found") {
        res.status(404).json({ error: "VST_POSITION_NOT_FOUND" });
        return;
      }
      // blocked / read_unavailable / pending_reconciliation / unverified /
      // closed_but_unrecorded: the attempt could not be safely completed or
      // confirmed this time. Never reported as "closed" -- nothing here is
      // allowed to fabricate a close the exchange did not verify.
      res.json(CloseJournalVstReviewMarginTopUpNowResponse.parse({
        outcome: "not_confirmed",
        reason: result.reason ?? result.kind,
      }));
    } catch (error) {
      if (error instanceof Error && error.message === "vst_worker_not_active") {
        res.status(409).json({ error: "VST_WORKER_NOT_ACTIVE" });
        return;
      }
      throw error;
    }
  },
);

router.post(
  "/journal/vst-review/:sourceSignalId/confirm-open-now",
  async (req, res): Promise<void> => {
    const params = ConfirmJournalVstReviewOpenNowParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "INVALID_VST_REVIEW_RESOLUTION_REQUEST" });
      return;
    }
    try {
      const result = await confirmVstReviewPositionStillOpenNow(
        params.data.sourceSignalId,
        getAuth(req).userId!,
      );
      res.setHeader("Cache-Control", "no-store");
      if (result.kind === "confirmed_open") {
        res.json(ConfirmJournalVstReviewOpenNowResponse.parse({
          outcome: "confirmed_open",
          sourceSignalId: result.position.sourceSignalId,
          symbol: result.position.symbol,
          status: result.position.status,
          updatedAt: result.position.updatedAt,
        }));
        return;
      }
      if (result.kind === "already_flat") {
        res.json(ConfirmJournalVstReviewOpenNowResponse.parse({ outcome: "already_flat" }));
        return;
      }
      if (result.kind === "not_found") {
        res.status(404).json({ error: "VST_POSITION_NOT_FOUND" });
        return;
      }
      // blocked / read_unavailable / resolve_failed: the read could not be
      // safely completed or trusted this time. Never reported as
      // "confirmed_open" -- nothing here is allowed to fabricate a quantity
      // the exchange did not actually report.
      res.json(ConfirmJournalVstReviewOpenNowResponse.parse({
        outcome: "not_confirmed",
        reason: result.reason ?? result.kind,
      }));
    } catch (error) {
      if (error instanceof Error && error.message === "vst_worker_not_active") {
        res.status(409).json({ error: "VST_WORKER_NOT_ACTIVE" });
        return;
      }
      throw error;
    }
  },
);

router.get("/journal/strategy-history", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const audit = await auditLiveFunding();
    for (const result of audit ?? []) {
      if (result.status === "incomplete") {
        req.log.warn({ signalId: result.signalId, reason: result.reason },
          "LIVE funding remains unverified");
      }
    }
  } catch (error) {
    // The journal still shows incomplete accounting; never infer zero funding
    // from a failed private read.
    req.log.warn({ err: error }, "LIVE funding audit unavailable");
  }
  res.json(GetJournalStrategyHistoryResponse.parse(await journalStrategyHistory()));
});

router.get("/journal/bingx-connection", async (_req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  res.json(GetJournalBingxConnectionResponse.parse(await probeBingXConnection()));
});

router.get("/journal/bingx-live-preflight", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const parsed = GetJournalBingxLivePreflightQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "INVALID_SYMBOL" });
    return;
  }
  const status = await probeBingXLivePreflight({ symbol: parsed.data.symbol });
  res.json(GetJournalBingxLivePreflightResponse.parse(status));
});

router.get("/journal/bingx-positions", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  // Positions/account and closed-trade history are independent BingX reads;
  // a failure in one must not erase the other.
  const closedTrades = await readBingXAccountClosedTrades().catch(() => ({
    status: "unavailable" as const,
    source: "BingX private income history" as const,
    observedAt: null,
    trades: [],
  }));
  try {
    res.json(GetJournalBingxPositionsResponse.parse({
      ...await readBingXAccountPositions(),
      recentClosedTrades: closedTrades,
    }));
  } catch (error) {
    req.log.warn(
      { errorType: error instanceof Error ? error.name : "UnknownError" },
      "BingX account positions unavailable",
    );
    res.json(GetJournalBingxPositionsResponse.parse({
      status: "unavailable",
      environment: "mainnet",
      source: "BingX private swap positions",
      observedAt: null,
      positions: [],
      accountStatus: "unavailable",
      accountSource: "BingX mainnet swap account-wide USDT balance",
      accountObservedAt: null,
      account: null,
      recentClosedTrades: closedTrades,
    }));
  }
});

router.get("/journal/trades", async (req, res): Promise<void> => {
  const parsed = ListJournalTradesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "INVALID_QUERY" });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.json(ListJournalTradesResponse.parse({
    trades: await listJournalTrades(parsed.data.status, parsed.data.limit),
  }));
});

router.get("/journal/trades/:id", async (req, res): Promise<void> => {
  const params = ClosePaperTradeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "INVALID_TRADE_ID" });
    return;
  }
    const trade = await getJournalTrade(params.data.id);
  if (!trade) {
    res.status(404).json({ error: "TRADE_NOT_FOUND" });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.json(GetJournalTradeResponse.parse(trade));
});

router.post("/journal/trades/:id/paper-close", async (req, res): Promise<void> => {
  const params = ClosePaperTradeParams.safeParse(req.params);
  const body = ClosePaperTradeBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "INVALID_PAPER_CLOSE_REQUEST" });
    return;
  }
  try {
    await closePaperPosition(
      params.data.id, body.data.exitPrice, body.data.requestId, getAuth(req).userId!,
    );
    const trade = await getJournalTrade(params.data.id);
    if (!trade) throw new Error("Closed paper trade could not be reloaded.");
    res.setHeader("Cache-Control", "no-store");
    res.json(ClosePaperTradeResponse.parse(trade));
  } catch (error) {
    if (error instanceof PaperCloseError) {
      res.status(error.status).json({ error: error.code });
      return;
    }
    throw error;
  }
});

export default router;
