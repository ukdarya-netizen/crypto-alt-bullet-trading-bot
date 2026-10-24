import { desc, eq } from "drizzle-orm";
import {
  bingxRealTestSelectionTable,
  bingxRealTestWebhookOrderTable,
  db,
  tradingControlsTable,
} from "@workspace/db";

export const BINGX_REAL_TEST_MARGIN_MODE = "isolated" as const;
export const BINGX_REAL_TEST_MARGIN_USDT = "15" as const;

export type BingxRealTestSelection = {
  state: "disarmed" | "armed" | "claimed" | "failed";
  marginMode: typeof BINGX_REAL_TEST_MARGIN_MODE;
  testMarginUsdt: typeof BINGX_REAL_TEST_MARGIN_USDT;
  armedAfterSequence: number;
  firstCandidateSequence: number | null;
  firstCandidateSignalId: string | null;
  outcomeReason: string | null;
  armedAt: Date | null;
  resolvedAt: Date | null;
};

export function resolveFirstCandidate(
  selection: BingxRealTestSelection,
  sequence: number,
  signalId: string,
  ineligibilityReason: string | null,
  resolvedAt: Date,
): BingxRealTestSelection {
  if (selection.state !== "armed" || sequence <= selection.armedAfterSequence) return selection;
  return {
    ...selection,
    state: ineligibilityReason ? "failed" : "claimed",
    firstCandidateSequence: sequence,
    firstCandidateSignalId: signalId,
    outcomeReason: ineligibilityReason,
    resolvedAt,
  };
}

function mapSelection(row?: typeof bingxRealTestSelectionTable.$inferSelect): BingxRealTestSelection {
  return {
    state: (row?.state ?? "disarmed") as BingxRealTestSelection["state"],
    marginMode: BINGX_REAL_TEST_MARGIN_MODE,
    testMarginUsdt: BINGX_REAL_TEST_MARGIN_USDT,
    armedAfterSequence: row?.armedAfterSequence ?? 0,
    firstCandidateSequence: row?.firstCandidateSequence ?? null,
    firstCandidateSignalId: row?.firstCandidateSignalId ?? null,
    outcomeReason: row?.outcomeReason ?? null,
    armedAt: row?.armedAt ?? null,
    resolvedAt: row?.resolvedAt ?? null,
  };
}

export async function getBingxRealTestSelection(): Promise<BingxRealTestSelection> {
  const [row] = await db.select().from(bingxRealTestSelectionTable)
    .where(eq(bingxRealTestSelectionTable.id, 1)).limit(1);
  return mapSelection(row);
}

/**
 * Explicitly arms once. Both arming and enqueueSignalIntent lock
 * trading_controls first; that shared row lock linearizes the arm boundary
 * against every sender-webhook insert covered by this selector.
 */
export async function armBingxRealTestSignalSelection(): Promise<BingxRealTestSelection> {
  return db.transaction(async (tx) => {
    await tx.insert(tradingControlsTable).values({ id: 1 })
      .onConflictDoNothing({ target: tradingControlsTable.id });
    const [controls] = await tx.select().from(tradingControlsTable)
      .where(eq(tradingControlsTable.id, 1)).for("update");
    if (!controls) throw new Error("Trading controls are unavailable; selector remains disarmed.");

    const [existing] = await tx.select().from(bingxRealTestSelectionTable)
      .where(eq(bingxRealTestSelectionTable.id, 1)).for("update");
    if (existing && existing.state !== "disarmed") {
      throw new Error(`BingX REAL test selector cannot be armed from ${existing.state}.`);
    }

    // Inserts on the webhook path use this same controls lock before assigning
    // their sequence, so no covered intake can sit uncommitted across boundary
    // capture. Sequence gaps from rolled-back transactions are harmless.
    const [latest] = await tx.select({ sequence: bingxRealTestWebhookOrderTable.sequence })
      .from(bingxRealTestWebhookOrderTable)
      .orderBy(desc(bingxRealTestWebhookOrderTable.sequence))
      .limit(1);
    const armedAfterSequence = latest?.sequence ?? 0;
    const now = new Date();

    if (!existing) {
      await tx.insert(bingxRealTestSelectionTable).values({
        id: 1,
        state: "armed",
        marginMode: BINGX_REAL_TEST_MARGIN_MODE,
        testMarginUsdt: BINGX_REAL_TEST_MARGIN_USDT,
        armedAfterSequence,
        armedAt: now,
        updatedAt: now,
      });
    } else {
      await tx.update(bingxRealTestSelectionTable).set({
        state: "armed",
        marginMode: BINGX_REAL_TEST_MARGIN_MODE,
        testMarginUsdt: BINGX_REAL_TEST_MARGIN_USDT,
        armedAfterSequence,
        firstCandidateSequence: null,
        firstCandidateSignalId: null,
        outcomeReason: null,
        armedAt: now,
        resolvedAt: null,
        updatedAt: now,
      }).where(eq(bingxRealTestSelectionTable.id, 1));
    }
    return mapSelection({
      ...(existing ?? {
        id: 1,
        state: "disarmed",
        marginMode: BINGX_REAL_TEST_MARGIN_MODE,
        testMarginUsdt: BINGX_REAL_TEST_MARGIN_USDT,
        armedAfterSequence: 0,
        firstCandidateSequence: null,
        firstCandidateSignalId: null,
        outcomeReason: null,
        armedAt: null,
        resolvedAt: null,
        updatedAt: now,
      }),
      state: "armed",
      marginMode: BINGX_REAL_TEST_MARGIN_MODE,
      testMarginUsdt: BINGX_REAL_TEST_MARGIN_USDT,
      armedAfterSequence,
      firstCandidateSequence: null,
      firstCandidateSignalId: null,
      outcomeReason: null,
      armedAt: now,
      resolvedAt: null,
      updatedAt: now,
    });
  });
}