import { Router, type IRouter } from "express";
import Decimal from "decimal.js";
import { decidePaperIntake, PAPER_AUTO_EXIT_PATTERNS } from "../lib/paper-intent";
import {
  EnqueueTradingSignalBody,
  EnqueueTradingSignalResponse,
  GetTradingStatusResponse,
  ListTradingSignalsQueryParams,
  ListTradingSignalsResponse,
  UpdateTradingControlsBody,
  UpdateTradingControlsResponse,
} from "@workspace/api-zod";
import { requireTradingToken } from "../lib/trading-auth";
import { approvedPatternIds, signalEligibility } from "../lib/signal-eligibility";
import { toTradingSignal } from "../lib/trading-mappers";
import { requireJournalOwner, requireJournalSession } from "../middlewares/journalAccess";
import {
  enqueueSignalIntent,
  getTradingStatus,
  listSignals,
  setPaperEntriesEnabled,
  updateTradingControls,
} from "../lib/trading-store";

const router: IRouter = Router();

router.get("/trading/status", requireJournalSession, requireJournalOwner, async (_req, res) => {
  res.json(GetTradingStatusResponse.parse(await getTradingStatus()));
});

router.get("/trading/signals", requireJournalSession, requireJournalOwner, async (req, res) => {
  const query = ListTradingSignalsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({
      error: "INVALID_QUERY",
      issues: query.error.issues,
    });
    return;
  }

  const { rows, hasMore } = await listSignals(query.data.limit, query.data.offset);
  const response = ListTradingSignalsResponse.parse({
    signals: rows.map(toTradingSignal),
    hasMore,
  });
  res.setHeader("Cache-Control", "no-store");
  res.json(response);
});

router.post("/trading/paper/start", requireJournalSession, requireJournalOwner, async (_req, res) => {
  try {
    res.json(GetTradingStatusResponse.parse(await setPaperEntriesEnabled(true)));
  } catch (error) {
    res.status(403).json({ error: "PAPER_MODE_REQUIRED", message: error instanceof Error ? error.message : "Paper mode required." });
  }
});

router.post("/trading/paper/stop", requireJournalSession, requireJournalOwner, async (_req, res) => {
  try {
    res.json(GetTradingStatusResponse.parse(await setPaperEntriesEnabled(false)));
  } catch (error) {
    res.status(403).json({ error: "PAPER_MODE_REQUIRED", message: error instanceof Error ? error.message : "Paper mode required." });
  }
});

router.post(
  "/trading/signals",
  requireTradingToken("ingest"),
  async (req, res) => {
    // Never log the token or raw payload. Rejected signals are not stored, so
    // these limited diagnostics are the only way to identify intake failures.
    const rejectLog = (code: string, details: Record<string, unknown> = {}) => {
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      req.log.warn({
        rejectCode: code,
        symbol: typeof body.symbol === "string" && /^[A-Z0-9]{1,24}$/.test(body.symbol) ? body.symbol : undefined,
        patternId: typeof body.patternId === "string" && /^[A-Za-z0-9_ -]{1,120}$/.test(body.patternId)
          ? body.patternId : undefined,
        ...details,
      }, "Trading signal rejected at intake");
    };
    const fields = new Set(["sourceSignalId", "confirmationStatus", "patternId",
      "patternStatus", "symbol", "signalAt", "referencePrice", "side", "orderType",
      "quantity", "limitPrice", "stopLoss", "reduceOnly", "payload"]);
    if (req.body && typeof req.body === "object" && !Array.isArray(req.body) &&
        Object.keys(req.body).some((key) => !fields.has(key))) {
      rejectLog("EXECUTION_FIELDS_NOT_ACCEPTED", {
        unexpectedFields: Object.keys(req.body).filter((key) => !fields.has(key) && /^[A-Za-z0-9_]{1,80}$/.test(key)).slice(0, 20),
      });
      res.status(400).json({
        error: "EXECUTION_FIELDS_NOT_ACCEPTED",
        message: "Only documented relay signal fields are accepted.",
      });
      return;
    }
    const body = EnqueueTradingSignalBody.safeParse(req.body);
    if (!body.success) {
      rejectLog("INVALID_SIGNAL", {
        issues: body.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })).slice(0, 20),
      });
      res.status(400).json({
        error: "INVALID_SIGNAL",
        issues: body.error.issues,
      });
      return;
    }

    const allowlist = approvedPatternIds(process.env.TRADING_APPROVED_PATTERN_IDS);
    if (allowlist.size === 0) {
      rejectLog("PATTERN_ALLOWLIST_NOT_CONFIGURED");
      res.status(503).json({
        error: "PATTERN_ALLOWLIST_NOT_CONFIGURED",
        message: "Signal intake is disabled until approved pattern IDs are configured.",
      });
      return;
    }
    const eligibility = signalEligibility(body.data, new Set(
      [...allowlist].filter((id) => PAPER_AUTO_EXIT_PATTERNS.has(id)),
    ));
    if (eligibility) {
      rejectLog(eligibility);
      res.status(422).json({
        error: eligibility,
        message: "Only confirmed signals from approved, allowlisted patterns are accepted.",
      });
      return;
    }

    const price = new Decimal(body.data.referencePrice);
    if (!price.isFinite() || !price.gt(0) ||
        price.decimalPlaces() > 12 || price.gte("1e16")) {
      rejectLog("INVALID_REFERENCE_PRICE");
      res.status(400).json({ error: "INVALID_REFERENCE_PRICE" });
      return;
    }
    // Validate the strategy even when PAPER is stopped. Never persist a
    // downgraded entry that might later be interpreted as executable.
    const checked = decidePaperIntake({
      ...body.data, payload: req.body.payload,
    }, { mode: "paper", acceptingNewEntries: true, killSwitchActive: false });
    if (checked.errorCode && checked.errorCode !== "PAPER_SIGNAL_OUTSIDE_WINDOW") {
      rejectLog(checked.errorCode);
      res.status(422).json({ error: checked.errorCode, message: checked.errorMessage });
      return;
    }
    if (typeof req.body?.signalAt !== "string" ||
        !/Z$/.test(req.body.signalAt) ||
        !Number.isFinite(body.data.signalAt.getTime())) {
      rejectLog("INVALID_SIGNAL_TIME");
      res.status(400).json({ error: "INVALID_SIGNAL_TIME" });
      return;
    }
    const result = await enqueueSignalIntent({
      ...body.data,
      confirmationStatus: "confirmed",
      patternStatus: "approved",
      signalAt: body.data.signalAt,
    });
    if (result.conflict) {
      rejectLog("IDEMPOTENCY_CONFLICT");
      res.status(409).json({
        error: "IDEMPOTENCY_CONFLICT",
        message:
          "sourceSignalId already exists with different signal details.",
      });
      return;
    }

    const response = EnqueueTradingSignalResponse.parse({
      accepted: true,
      duplicate: result.duplicate,
      signal: toTradingSignal(result.signal),
    });
    res.status(202).json(response);
  },
);

router.post(
  "/trading/controls",
  requireTradingToken("control"),
  async (req, res) => {
    const body = UpdateTradingControlsBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        error: "INVALID_CONTROLS",
        issues: body.error.issues,
      });
      return;
    }

    if (
      body.data.maxNotionalPerOrder !== undefined &&
      Number(body.data.maxNotionalPerOrder) <= 0
    ) {
      res.status(400).json({
        error: "INVALID_MAX_NOTIONAL",
        message: "maxNotionalPerOrder must be greater than zero.",
      });
      return;
    }

    try {
      const status = await updateTradingControls(body.data);
      res.json(UpdateTradingControlsResponse.parse(status));
    } catch (error) {
      res.status(400).json({
        error: "UNSAFE_CONTROL_CHANGE",
        message: error instanceof Error ? error.message : "Control update failed.",
      });
    }
  },
);

export default router;
