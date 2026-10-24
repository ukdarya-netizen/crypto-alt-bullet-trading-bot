import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, historicalCascadeSelectionTable, pool } from "@workspace/db";
import { sql } from "drizzle-orm";

export const HISTORICAL_CASCADE_MARGIN_MODE = "isolated" as const;
export const HISTORICAL_CASCADE_TOTAL_MARGIN_USDT = "15" as const;

export type HistoricalCascadeState =
  | "disarmed"
  | "claimed"
  | "cancelled"
  | "entry_intent_reserved"
  | "attempted";

export type HistoricalCascadeSelection = {
  state: HistoricalCascadeState;
  sourceSignalId: string | null;
  symbol: string | null;
  marginMode: typeof HISTORICAL_CASCADE_MARGIN_MODE;
  totalMarginUsdt: typeof HISTORICAL_CASCADE_TOTAL_MARGIN_USDT;
  selectedAt: Date | null;
  cancelledAt: Date | null;
  entryIntentReservedAt: Date | null;
  attemptStartedAt: Date | null;
  updatedAt: Date | null;
};

export type HistoricalCascadeCandidate = {
  sourceSignalId: string;
  symbol: string;
  signalAt: string | null;
  historicalPaperOutcome: "rejected_insufficient_free_paper_balance" | "closed";
};

export type HistoricalPaperSignalRow = {
  source_signal_id: string;
  body: unknown;
  body_hash: string;
  status: string;
  reason: string | null;
  position_status: string | null;
  position_mode: string | null;
  position_updated_at: Date | string | null;
};

function canonicalizeSignal(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeSignal);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalizeSignal(child)]),
    );
  }
  return value;
}

/**
 * Historical intake records are trusted only when their persisted body hash,
 * source signal identity, confirmed/approved classification, and Bullet source
 * metadata still agree. Rejected insufficient-balance records have no PAPER
 * position and are valid historical candidates; closed PAPER records remain
 * eligible too.
 */
export function eligibleHistoricalCascadeCandidate(
  row: HistoricalPaperSignalRow,
): HistoricalCascadeCandidate | null {
  if (!row || typeof row !== "object" || !/^[a-f0-9]{64}$/.test(row.body_hash)) return null;
  const body = row.body && typeof row.body === "object" && !Array.isArray(row.body)
    ? row.body as Record<string, unknown>
    : null;
  if (!body) return null;

  const canonicalBody = JSON.stringify(canonicalizeSignal(body));
  if (createHash("sha256").update(canonicalBody).digest("hex") !== row.body_hash) return null;

  const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
    ? body.payload as Record<string, unknown>
    : null;
  if (body.sourceSignalId !== row.source_signal_id ||
      !/^cab-signal-[1-9]\d*$/.test(row.source_signal_id) ||
      body.confirmationStatus !== "confirmed" ||
      body.patternId !== "liquidation_cascade" ||
      body.patternStatus !== "approved" ||
      body.side !== "buy" ||
      body.orderType !== "market" ||
      body.reduceOnly !== false ||
      !payload ||
      payload.source !== "CryptoAltBullet" ||
      payload.rulesVersion !== "bullet-long-exits-v2" ||
      payload.marginMode !== "isolated" ||
      payload.initialMarginUsd !== "10" ||
      payload.leverage !== 10) return null;

  const symbol = body.symbol;
  const signalAt = body.signalAt;
  if (typeof symbol !== "string" || !/^[A-Z0-9]{1,20}USDT$/.test(symbol) ||
      typeof signalAt !== "string" || !/Z$/.test(signalAt) ||
      !Number.isFinite(Date.parse(signalAt))) return null;

  const rejectedForBalance = row.status === "rejected" &&
    row.reason === "insufficient_free_paper_balance" &&
    row.position_status === null;
  const closedPaper = row.status === "closed" &&
    row.position_status === "closed" &&
    (row.position_mode === null || row.position_mode === "paper");
  if (!rejectedForBalance && !closedPaper) return null;

  return {
    sourceSignalId: row.source_signal_id,
    symbol,
    signalAt,
    historicalPaperOutcome: rejectedForBalance
      ? "rejected_insufficient_free_paper_balance"
      : "closed",
  };
}

export function transitionHistoricalCascade(
  selection: HistoricalCascadeSelection,
  action: "select" | "cancel" | "reserve-entry" | "start-attempt",
  at: Date,
  candidate?: Pick<HistoricalCascadeCandidate, "sourceSignalId" | "symbol">,
): HistoricalCascadeSelection {
  if (action === "select") {
    if (selection.state !== "disarmed") {
      throw new Error(`Historical liquidation_cascade selection is one-shot and is already ${selection.state}.`);
    }
    if (!candidate?.sourceSignalId || !/^[A-Z0-9]{1,24}USDT$/.test(candidate.symbol)) {
      throw new Error("A verified historical liquidation_cascade candidate is required.");
    }
    return {
      ...selection,
      state: "claimed",
      sourceSignalId: candidate.sourceSignalId,
      symbol: candidate.symbol,
      selectedAt: at,
      updatedAt: at,
    };
  }

  if (action === "cancel") {
    if (selection.state === "cancelled") return selection;
    if (selection.state === "entry_intent_reserved" || selection.state === "attempted") {
      throw new Error("Cancellation is not allowed after entry intent reservation.");
    }
    if (selection.state !== "claimed") {
      throw new Error("There is no claimed historical candidate to cancel.");
    }
    return { ...selection, state: "cancelled", cancelledAt: at, updatedAt: at };
  }

  if (action === "reserve-entry") {
    if (selection.state === "entry_intent_reserved") return selection;
    if (selection.state !== "claimed") {
      throw new Error(`Entry intent cannot be reserved from ${selection.state}.`);
    }
    return {
      ...selection,
      state: "entry_intent_reserved",
      entryIntentReservedAt: at,
      updatedAt: at,
    };
  }

  if (selection.state === "attempted") return selection;
  if (selection.state !== "entry_intent_reserved") {
    throw new Error(`An entry attempt cannot start from ${selection.state}.`);
  }
  return { ...selection, state: "attempted", attemptStartedAt: at, updatedAt: at };
}

function mapSelection(
  row?: typeof historicalCascadeSelectionTable.$inferSelect,
): HistoricalCascadeSelection {
  return {
    state: (row?.state ?? "disarmed") as HistoricalCascadeState,
    sourceSignalId: row?.sourceSignalId ?? null,
    symbol: row?.symbol ?? null,
    marginMode: HISTORICAL_CASCADE_MARGIN_MODE,
    totalMarginUsdt: HISTORICAL_CASCADE_TOTAL_MARGIN_USDT,
    selectedAt: row?.selectedAt ?? null,
    cancelledAt: row?.cancelledAt ?? null,
    entryIntentReservedAt: row?.entryIntentReservedAt ?? null,
    attemptStartedAt: row?.attemptStartedAt ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

const HISTORICAL_CANDIDATES_QUERY = sql<{
  source_signal_id: string;
  body: unknown;
  body_hash: string;
  status: string;
  reason: string | null;
  position_status: string | null;
  position_mode: string | null;
  position_updated_at: Date | string | null;
}>`
  SELECT s.source_signal_id, s.body, s.body_hash, s.status, s.reason,
         p.status AS position_status,
         CASE WHEN p.source_signal_id IS NULL THEN NULL
              ELSE COALESCE(p.snapshot->>'mode', 'paper') END AS position_mode,
         p.updated_at AS position_updated_at
  FROM btb_signals s
  LEFT JOIN btb_positions p ON p.source_signal_id = s.source_signal_id
  WHERE ((s.status = 'rejected'
          AND s.reason = 'insufficient_free_paper_balance'
          AND p.source_signal_id IS NULL)
         OR (s.status = 'closed' AND p.status = 'closed'
             AND COALESCE(p.snapshot->>'mode', 'paper') = 'paper'))
    AND s.body->>'patternId' = 'liquidation_cascade'
  ORDER BY p.updated_at DESC NULLS LAST, s.received_at DESC, s.source_signal_id
  LIMIT 500
`;

async function assertHistoricalPaperSchema(): Promise<void> {
  const result = await pool.query<{ ready: boolean }>(
    `SELECT to_regclass('public.btb_signals') IS NOT NULL
       AND to_regclass('public.btb_positions') IS NOT NULL AS ready`,
  );
  if (result.rows[0]?.ready !== true) {
    throw new Error("Historical PAPER records are unavailable; no candidate can be selected.");
  }
}

export async function listHistoricalCascadeCandidates(): Promise<HistoricalCascadeCandidate[]> {
  await assertHistoricalPaperSchema();
  const result = await db.execute(HISTORICAL_CANDIDATES_QUERY);
  const rows = result.rows as unknown as HistoricalPaperSignalRow[];
  return rows.map(eligibleHistoricalCascadeCandidate)
    .filter((candidate): candidate is HistoricalCascadeCandidate => candidate !== null);
}

export async function getHistoricalCascadeSelection(): Promise<HistoricalCascadeSelection> {
  const [row] = await db.select().from(historicalCascadeSelectionTable)
    .where(eq(historicalCascadeSelectionTable.id, 1)).limit(1);
  return mapSelection(row);
}

/**
 * Selection consumes the one-shot record inside the same transaction that
 * locks its singleton row. The historical PAPER tables are read only here.
 */
export async function selectHistoricalCascadeCandidate(
  sourceSignalId: string,
): Promise<HistoricalCascadeSelection> {
  await assertHistoricalPaperSchema();
  return db.transaction(async (tx) => {
    await tx.insert(historicalCascadeSelectionTable).values({ id: 1 })
      .onConflictDoNothing({ target: historicalCascadeSelectionTable.id });
    const [row] = await tx.select().from(historicalCascadeSelectionTable)
      .where(eq(historicalCascadeSelectionTable.id, 1)).for("update");
    if (!row) throw new Error("Historical candidate selection state is unavailable.");
    if (row.state !== "disarmed") {
      throw new Error(`Historical liquidation_cascade selection is one-shot and is already ${row.state}.`);
    }

    const candidateQuery = sql<HistoricalPaperSignalRow>`
      SELECT s.source_signal_id, s.body, s.body_hash, s.status, s.reason,
             p.status AS position_status,
             CASE WHEN p.source_signal_id IS NULL THEN NULL
                  ELSE COALESCE(p.snapshot->>'mode', 'paper') END AS position_mode,
             p.updated_at AS position_updated_at
      FROM btb_signals s
      LEFT JOIN btb_positions p ON p.source_signal_id = s.source_signal_id
      WHERE s.source_signal_id = ${sourceSignalId}
        AND s.body->>'patternId' = 'liquidation_cascade'
        AND ((s.status = 'rejected'
              AND s.reason = 'insufficient_free_paper_balance'
              AND p.source_signal_id IS NULL)
             OR (s.status = 'closed' AND p.status = 'closed'
                 AND COALESCE(p.snapshot->>'mode', 'paper') = 'paper'))
      LIMIT 1
    `;
    const result = await tx.execute(candidateQuery);
    const historicalCandidate = result.rows[0] as unknown as HistoricalPaperSignalRow | undefined;
    const candidate = historicalCandidate && eligibleHistoricalCascadeCandidate(historicalCandidate);
    if (!candidate) {
      throw new Error("Candidate is not an eligible historical PAPER liquidation_cascade record.");
    }
    const now = new Date();
    const selected = transitionHistoricalCascade(mapSelection(row), "select", now, {
      sourceSignalId: candidate.sourceSignalId,
      symbol: candidate.symbol,
    });
    const [updated] = await tx.update(historicalCascadeSelectionTable).set({
      state: selected.state,
      sourceSignalId: selected.sourceSignalId,
      symbol: selected.symbol,
      selectedAt: selected.selectedAt,
      updatedAt: now,
    }).where(and(
      eq(historicalCascadeSelectionTable.id, 1),
      eq(historicalCascadeSelectionTable.state, "disarmed"),
    )).returning();
    if (!updated) throw new Error("Historical candidate claim was concurrently consumed.");
    return mapSelection(updated);
  });
}

export async function cancelHistoricalCascadeSelection(): Promise<HistoricalCascadeSelection> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(historicalCascadeSelectionTable)
      .where(eq(historicalCascadeSelectionTable.id, 1)).for("update");
    if (!row) throw new Error("There is no claimed historical candidate to cancel.");
    if (row.state === "cancelled") return mapSelection(row);
    const now = new Date();
    const cancelled = transitionHistoricalCascade(mapSelection(row), "cancel", now);
    const [updated] = await tx.update(historicalCascadeSelectionTable).set({
      state: cancelled.state,
      cancelledAt: cancelled.cancelledAt,
      updatedAt: now,
    }).where(and(
      eq(historicalCascadeSelectionTable.id, 1),
      eq(historicalCascadeSelectionTable.state, "claimed"),
    )).returning();
    if (!updated) throw new Error("Historical selection changed while cancellation was being committed.");
    return mapSelection(updated);
  });
}

/**
 * Executor integration boundary. Call immediately before reserving its own
 * durable entry intent. This only consumes the selector; it never submits an
 * order or enables/constructs an executor.
 */
export async function reserveHistoricalCascadeEntryIntent(): Promise<{
  kind: "new" | "existing";
  selection: HistoricalCascadeSelection;
}> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(historicalCascadeSelectionTable)
      .where(eq(historicalCascadeSelectionTable.id, 1)).for("update");
    if (!row) throw new Error("No selected historical candidate exists.");
    if (row.state === "entry_intent_reserved") {
      return { kind: "existing", selection: mapSelection(row) };
    }
    const now = new Date();
    const reserved = transitionHistoricalCascade(mapSelection(row), "reserve-entry", now);
    const [updated] = await tx.update(historicalCascadeSelectionTable).set({
      state: reserved.state,
      entryIntentReservedAt: reserved.entryIntentReservedAt,
      updatedAt: now,
    }).where(and(
      eq(historicalCascadeSelectionTable.id, 1),
      eq(historicalCascadeSelectionTable.state, "claimed"),
    )).returning();
    if (!updated) throw new Error("Historical selection changed before entry intent reservation.");
    return { kind: "new", selection: mapSelection(updated) };
  });
}

/** Permanently records that an executor began its one permitted attempt. */
export async function markHistoricalCascadeAttemptStarted(): Promise<{
  kind: "new" | "existing";
  selection: HistoricalCascadeSelection;
}> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(historicalCascadeSelectionTable)
      .where(eq(historicalCascadeSelectionTable.id, 1)).for("update");
    if (!row) throw new Error("No selected historical candidate exists.");
    if (row.state === "attempted") {
      return { kind: "existing", selection: mapSelection(row) };
    }
    const now = new Date();
    const attempted = transitionHistoricalCascade(mapSelection(row), "start-attempt", now);
    const [updated] = await tx.update(historicalCascadeSelectionTable).set({
      state: attempted.state,
      attemptStartedAt: attempted.attemptStartedAt,
      updatedAt: now,
    }).where(and(
      eq(historicalCascadeSelectionTable.id, 1),
      eq(historicalCascadeSelectionTable.state, "entry_intent_reserved"),
    )).returning();
    if (!updated) throw new Error("Historical selection changed before attempt was recorded.");
    return { kind: "new", selection: mapSelection(updated) };
  });
}