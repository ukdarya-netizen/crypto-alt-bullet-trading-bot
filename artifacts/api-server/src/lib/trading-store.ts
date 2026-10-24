import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { and, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  bingxRealTestSelectionTable,
  bingxRealTestWebhookOrderTable,
  db,
  tradingAuditEventsTable,
  tradingControlsTable,
  tradingSignalsTable,
} from "@workspace/db";
import {
  decidePaperIntake,
  PAPER_AUTO_EXIT_PATTERNS,
  PAPER_MAX_NOTIONAL_USDT,
  type PaperIntakeInput,
} from "./paper-intent";
import { approvedPatternIds, signalEligibility } from "./signal-eligibility";
import {
  BINGX_REAL_TEST_MARGIN_MODE,
  BINGX_REAL_TEST_MARGIN_USDT,
  resolveFirstCandidate,
} from "./bingx-real-test-selection";

export type SignalInput = {
  sourceSignalId: string;
  confirmationStatus: "candidate" | "confirmed";
  patternId: string;
  patternStatus: "approved" | "experimental";
  symbol: string;
  side: "buy" | "sell";
  orderType: "market" | "limit";
  quantity: string;
  limitPrice?: string;
  stopLoss?: string;
  takeProfit?: string;
  reduceOnly: boolean;
  payload?: Record<string, unknown>;
};

export type SignalIntentInput = PaperIntakeInput & {
  confirmationStatus: "confirmed";
  patternStatus: "approved";
};

function realTestCandidateIneligibility(input: SignalIntentInput): string | null {
  const allowed = new Set(
    [...approvedPatternIds(process.env.TRADING_APPROVED_PATTERN_IDS)]
      .filter((patternId) => PAPER_AUTO_EXIT_PATTERNS.has(patternId)),
  );
  const classificationError = signalEligibility(input, allowed);
  if (classificationError) return classificationError;

  // Test selection is independent of whether PAPER is currently accepting
  // entries. Reuse only its immutable signal/rules/age/size validation.
  return decidePaperIntake(input, {
    mode: "paper",
    acceptingNewEntries: true,
    killSwitchActive: false,
  }).errorCode;
}

async function recordRealTestWebhookIntake(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  signalId: string,
  input: SignalIntentInput,
) {
  // A new schema must never take down the existing PAPER webhook during a
  // staggered deployment. No selector tables means no REAL selection.
  const availability = await tx.execute(sql<{ ready: boolean }>`
    SELECT to_regclass('public.bingx_real_test_selection') IS NOT NULL
       AND to_regclass('public.bingx_real_test_webhook_order') IS NOT NULL AS ready
  `);
  if (availability.rows[0]?.ready !== true) {
    console.error("BingX one-shot selector schema unavailable; REAL selection is disabled");
    return;
  }
  const [ordered] = await tx.insert(bingxRealTestWebhookOrderTable)
    .values({ signalId }).returning({ sequence: bingxRealTestWebhookOrderTable.sequence });
  if (!ordered) throw new Error("Webhook intake sequence could not be persisted.");

  const [selection] = await tx.select().from(bingxRealTestSelectionTable)
    .where(eq(bingxRealTestSelectionTable.id, 1)).for("update");
  if (!selection || selection.state !== "armed" ||
      ordered.sequence <= selection.armedAfterSequence) return;

  const reason = realTestCandidateIneligibility(input);
  const resolvedAt = new Date();
  const outcome = resolveFirstCandidate({
    state: selection.state as "disarmed" | "armed" | "claimed" | "failed",
    marginMode: BINGX_REAL_TEST_MARGIN_MODE,
    testMarginUsdt: BINGX_REAL_TEST_MARGIN_USDT,
    armedAfterSequence: selection.armedAfterSequence,
    firstCandidateSequence: selection.firstCandidateSequence,
    firstCandidateSignalId: selection.firstCandidateSignalId,
    outcomeReason: selection.outcomeReason,
    armedAt: selection.armedAt,
    resolvedAt: selection.resolvedAt,
  }, ordered.sequence, signalId, reason, resolvedAt);
  if (outcome.state === selection.state) return;
  const updated = await tx.update(bingxRealTestSelectionTable).set({
    state: outcome.state,
    firstCandidateSequence: outcome.firstCandidateSequence,
    firstCandidateSignalId: outcome.firstCandidateSignalId,
    outcomeReason: outcome.outcomeReason,
    resolvedAt: outcome.resolvedAt,
    updatedAt: resolvedAt,
  }).where(eq(bingxRealTestSelectionTable.id, 1))
    .returning({ state: bingxRealTestSelectionTable.state });
  if (updated.length !== 1) throw new Error("One-shot selector outcome could not be committed.");
}

function sameDecimal(left: string | null | undefined, right: string | null | undefined) {
  if (left == null || right == null) return left == null && right == null;
  return new Decimal(left).eq(new Decimal(right));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function ensureTradingControls() {
  await db
    .insert(tradingControlsTable)
    .values({ id: 1 })
    .onConflictDoNothing({ target: tradingControlsTable.id });

  const [controls] = await db
    .select()
    .from(tradingControlsTable)
    .where(eq(tradingControlsTable.id, 1))
    .limit(1);

  if (!controls) {
    throw new Error("Trading controls row could not be initialized.");
  }

  return controls;
}

export async function getTradingStatus() {
  const controls = await ensureTradingControls();
  const [queue] = await db
    .select({ value: count() })
    .from(tradingSignalsTable)
    .where(
      and(
        eq(tradingSignalsTable.status, "pending"),
        eq(tradingSignalsTable.reduceOnly, false),
      ),
    );

  const heartbeatAge = controls.workerHeartbeatAt
    ? Date.now() - controls.workerHeartbeatAt.getTime()
    : Number.POSITIVE_INFINITY;

  return {
    mode: controls.mode as "paper" | "testnet",
    acceptingNewEntries: controls.acceptingNewEntries,
    killSwitchActive: controls.killSwitchActive,
    maxNotionalPerOrder: controls.maxNotionalPerOrder,
    queueDepth: queue?.value ?? 0,
    workerOnline: heartbeatAge < 20_000,
    workerHeartbeatAt: controls.workerHeartbeatAt ?? null,
    exchangeConnected: controls.mode === "paper" || (controls.mode === "testnet" && controls.exchangeConnected && heartbeatAge < 20_000),
    lastReconciledAt: controls.lastReconciledAt ?? null,
  };
}

export async function setPaperEntriesEnabled(enabled: boolean) {
  await ensureTradingControls();
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(tradingControlsTable)
      .where(eq(tradingControlsTable.id, 1)).for("update");
    if (current?.mode !== "paper") throw new Error("Paper mode is required.");
    if (enabled && current.acceptingNewEntries && !current.killSwitchActive) {
      if (new Decimal(current.maxNotionalPerOrder).eq(PAPER_MAX_NOTIONAL_USDT)) return;
      await tx.update(tradingControlsTable).set({
        maxNotionalPerOrder: PAPER_MAX_NOTIONAL_USDT, updatedAt: new Date(),
      }).where(eq(tradingControlsTable.id, 1));
      return;
    }

    // Never resume queued paper entries from a previous activation. Holding
    // the controls lock also fences intake and paper finalization.
    const cancelled = await tx.update(tradingSignalsTable).set({
      status: "rejected",
      errorCode: "PAPER_ENTRIES_PAUSED",
      errorMessage: "Unfilled paper entry discarded when execution controls changed.",
      processedAt: new Date(),
      leaseUntil: null,
      updatedAt: new Date(),
    }).where(and(
      inArray(tradingSignalsTable.status, ["pending", "processing"]),
      isNotNull(tradingSignalsTable.signalAt),
    )).returning({ id: tradingSignalsTable.id });
    if (cancelled.length) {
      await tx.insert(tradingAuditEventsTable).values(cancelled.map(({ id }) => ({
        signalId: id,
        eventType: "signal_rejected",
        message: "Unfilled paper entry discarded when execution controls changed.",
        details: { errorCode: "PAPER_ENTRIES_PAUSED" },
      })));
    }
    if (enabled) {
      const [queued] = await tx.select({ value: count() }).from(tradingSignalsTable)
        .where(inArray(tradingSignalsTable.status, ["pending", "processing"]));
      if (queued?.value) {
        throw new Error("Pending signals must be resolved before paper entries can be enabled.");
      }
    }
    await tx.update(tradingControlsTable)
      .set({
        acceptingNewEntries: enabled,
        killSwitchActive: !enabled,
        ...(enabled ? { maxNotionalPerOrder: PAPER_MAX_NOTIONAL_USDT } : {}),
        updatedAt: new Date(),
      })
      .where(eq(tradingControlsTable.id, 1));
  });
  return getTradingStatus();
}

export async function enqueueSignal(input: SignalInput) {
  const id = randomUUID();
  return db.transaction(async (tx) => {
  const [inserted] = await tx
    .insert(tradingSignalsTable)
    .values({
      id,
      sourceSignalId: input.sourceSignalId,
      confirmationStatus: input.confirmationStatus,
      patternId: input.patternId,
      patternStatus: input.patternStatus,
      symbol: input.symbol,
      side: input.side,
      orderType: input.orderType,
      quantity: input.quantity,
      limitPrice: input.limitPrice,
      stopLoss: input.stopLoss,
      takeProfit: input.takeProfit,
      reduceOnly: input.reduceOnly,
      rawPayload: input.payload,
    })
    .onConflictDoNothing({ target: tradingSignalsTable.sourceSignalId })
    .returning();

  if (inserted) {
    await tx.insert(tradingAuditEventsTable).values({
      signalId: inserted.id,
      eventType: "signal_enqueued",
      message: "Signal accepted into the durable queue.",
      details: { sourceSignalId: inserted.sourceSignalId },
    });
    return { signal: inserted, duplicate: false, conflict: false };
  }

  const [existing] = await tx
    .select()
    .from(tradingSignalsTable)
    .where(eq(tradingSignalsTable.sourceSignalId, input.sourceSignalId))
    .limit(1);

  if (!existing) {
    throw new Error("Signal insert conflicted but the existing row was not found.");
  }

  const conflict =
    existing.confirmationStatus !== input.confirmationStatus ||
    existing.patternId !== input.patternId ||
    existing.patternStatus !== input.patternStatus ||
    existing.symbol !== input.symbol ||
    existing.side !== input.side ||
    existing.orderType !== input.orderType ||
    !sameDecimal(existing.quantity, input.quantity) ||
    !sameDecimal(existing.limitPrice, input.limitPrice) ||
    !sameDecimal(existing.stopLoss, input.stopLoss) ||
    !sameDecimal(existing.takeProfit, input.takeProfit) ||
    existing.reduceOnly !== input.reduceOnly ||
    canonicalJson(existing.rawPayload ?? null) !== canonicalJson(input.payload ?? null);

  if (conflict) {
    await tx.insert(tradingAuditEventsTable).values({
      signalId: existing.id,
      eventType: "idempotency_conflict",
      message: "A signal ID was reused with a different payload. Existing signal was not changed.",
    });
  }

  return { signal: existing, duplicate: true, conflict };
  });
}

export async function enqueueSignalIntent(input: SignalIntentInput) {
  return db.transaction(async (tx) => {
    const [controls] = await tx.select().from(tradingControlsTable)
      .where(eq(tradingControlsTable.id, 1)).for("update");
    const decision = decidePaperIntake(input, controls);
    const paper = decision.intent;
    const reasonCode = decision.errorCode;
    const reasonMessage = decision.errorMessage;
    const [inserted] = await tx.insert(tradingSignalsTable).values({
      id: randomUUID(),
      sourceSignalId: input.sourceSignalId,
      confirmationStatus: input.confirmationStatus,
      patternId: input.patternId,
      patternStatus: input.patternStatus,
      symbol: input.symbol,
      signalAt: input.signalAt,
      referencePrice: input.referencePrice,
      ...(paper ?? {}),
       rawPayload: { ...input.payload, ...(paper ? { relayContractVerified: true } : {}), relay: {
        side: input.side, orderType: input.orderType, quantity: input.quantity,
        limitPrice: input.limitPrice, stopLoss: input.stopLoss,
        reduceOnly: input.reduceOnly,
      } },
      status: paper ? "pending" : "awaiting_rules",
      errorCode: reasonCode,
      errorMessage: reasonMessage,
    }).onConflictDoNothing({ target: tradingSignalsTable.sourceSignalId }).returning();

    if (inserted) {
      await recordRealTestWebhookIntake(tx, inserted.id, input);
      await tx.insert(tradingAuditEventsTable).values({
        signalId: inserted.id,
        eventType: "signal_received",
        message: paper
          ? "Fresh LONG signal queued for paper-only simulation at its reference price."
          : "Signal received; no paper order queued. See the stored reason code.",
        details: {
          sourceSignalId: inserted.sourceSignalId,
          paperQueued: Boolean(paper),
          reasonCode,
        },
      });
      return { signal: inserted, duplicate: false, conflict: false };
    }

    const [existing] = await tx.select().from(tradingSignalsTable)
      .where(eq(tradingSignalsTable.sourceSignalId, input.sourceSignalId)).limit(1);
    if (!existing) throw new Error("Signal insert conflicted but the existing row was not found.");

    const conflict = existing.confirmationStatus !== input.confirmationStatus ||
      existing.patternId !== input.patternId ||
      existing.patternStatus !== input.patternStatus ||
      existing.symbol !== input.symbol ||
      existing.signalAt?.getTime() !== input.signalAt.getTime() ||
      !sameDecimal(existing.referencePrice, input.referencePrice) ||
       canonicalJson(existing.rawPayload ?? null) !== canonicalJson({ ...input.payload,
         ...(paper ? { relayContractVerified: true } : {}), relay: {
        side: input.side, orderType: input.orderType, quantity: input.quantity,
        limitPrice: input.limitPrice, stopLoss: input.stopLoss,
        reduceOnly: input.reduceOnly,
      } });

    if (conflict) {
      await tx.insert(tradingAuditEventsTable).values({
        signalId: existing.id,
        eventType: "idempotency_conflict",
        message: "A signal ID was reused with different intake details. Existing signal was not changed.",
      });
    }
    return { signal: existing, duplicate: true, conflict };
  });
}

export async function listSignals(limit: number, offset = 0) {
  const rows = await db
    .select()
    .from(tradingSignalsTable)
    .orderBy(desc(tradingSignalsTable.createdAt), desc(tradingSignalsTable.id))
    .offset(offset)
    .limit(limit + 1);
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

export async function updateTradingControls(input: {
  mode?: "paper" | "testnet";
  acceptingNewEntries?: boolean;
  killSwitchActive?: boolean;
  maxNotionalPerOrder?: string;
}) {
  await ensureTradingControls();
  await db.transaction(async (tx) => {
  const [current] = await tx.select().from(tradingControlsTable)
    .where(eq(tradingControlsTable.id, 1)).for("update");
  if (!current) throw new Error("Trading controls are unavailable.");
  if (input.mode === "testnet") {
    if (!process.env.BYBIT_TESTNET_API_KEY || !process.env.BYBIT_TESTNET_API_SECRET) {
      throw new Error("Bybit Testnet credentials must be configured in Replit Secrets.");
    }
    if (current.acceptingNewEntries || !current.killSwitchActive) {
      throw new Error("Pause entries and enable the kill switch before changing to testnet.");
    }
    const [queued] = await tx.select({ value: count() }).from(tradingSignalsTable)
      .where(inArray(tradingSignalsTable.status, ["pending", "processing"]));
    if (queued?.value) throw new Error("Drain or reject queued paper signals before changing execution mode.");
  }
  if (input.mode === "paper" && current.mode === "testnet") {
    throw new Error("Switching away from testnet is disabled while exchange orders may require reconciliation.");
  }
  if (current.mode === "testnet" && input.acceptingNewEntries === true &&
      (!current.exchangeConnected || !current.lastReconciledAt ||
        Date.now() - current.lastReconciledAt.getTime() > 20_000)) {
    throw new Error("Wait for a fresh successful Bybit Testnet reconciliation before enabling entries.");
  }

  await tx
    .update(tradingControlsTable)
    .set({
      ...(input.mode === undefined ? {} : { mode: input.mode, exchangeConnected: false, lastReconciledAt: null }),
      ...(input.acceptingNewEntries === undefined
        ? {}
        : { acceptingNewEntries: input.acceptingNewEntries }),
      ...(input.killSwitchActive === undefined
        ? {}
        : { killSwitchActive: input.killSwitchActive }),
      ...(input.maxNotionalPerOrder === undefined
        ? {}
        : { maxNotionalPerOrder: input.maxNotionalPerOrder }),
      updatedAt: new Date(),
    })
    .where(eq(tradingControlsTable.id, 1));
  });

  return getTradingStatus();
}
