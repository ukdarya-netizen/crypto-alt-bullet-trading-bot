import { safeVstEntryDeferReason } from "./safe-reasons.mjs";

/**
 * Coordinates a bounded cohort of VST candidates. Planning is read-only and
 * parallel; callbacks that can reserve durable work or mutate the exchange are
 * always run sequentially.
 */
export async function coordinateVstEntryBatch({
  candidates,
  maxEntries = 1,
  budgetMs = 10_000,
  now = () => performance.now(),
  wallClock = Date.now,
  prepare,
  execute,
  onTiming,
  onPreparationStart,
  onPreparationComplete,
  onDeferred,
}) {
  if (!Array.isArray(candidates) || !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 || maxEntries > 3 ||
      !Number.isFinite(budgetMs) || budgetMs <= 0 ||
      typeof prepare !== "function" || typeof execute !== "function") {
    throw new TypeError("invalid_vst_entry_batch_configuration");
  }
  const cohort = candidates.slice(0, maxEntries);
  const startedAt = now();
  const notify = (callback, value) => {
    try {
      Promise.resolve(callback?.(value)).catch(() => {});
    } catch {}
  };
  const prepared = await Promise.all(cohort.map(async (candidate) => {
    const prepareStartedAt = now();
    notify(onPreparationStart, {
      sourceSignalId: candidate?.sourceSignalId,
    });
    try {
      const hint = await prepare(candidate);
      const prepareMs = Math.max(0, now() - prepareStartedAt);
      notify(onPreparationComplete, {
        sourceSignalId: candidate?.sourceSignalId,
        prepareMs: Math.round(prepareMs),
        prepared: true,
      });
      return {
        candidate,
        hint,
        prepareMs,
      };
    } catch (error) {
      const prepareMs = Math.max(0, now() - prepareStartedAt);
      notify(onPreparationComplete, {
        sourceSignalId: candidate?.sourceSignalId,
        prepareMs: Math.round(prepareMs),
        prepared: false,
      });
      return {
        candidate,
        error,
        prepareMs,
      };
    }
  }));
  // Parallel preparation is read-only and can be slow under venue load. It
  // does not consume the mutation burst budget: at least the queue head gets
  // an execution attempt after those hints complete.
  const executionStartedAt = now();
  const results = [];
  let deferredReason = "prior_entry_attempt_stopped";
  for (const item of prepared) {
    if (results.length > 0 &&
        now() - executionStartedAt >= budgetMs) {
      deferredReason = "batch_execution_budget_exceeded";
      break;
    }
    const executeStartedAt = now();
    const executionWallMs = Number(wallClock());
    const receivedAt = item.candidate?.receivedAt;
    const receivedAtMs = typeof receivedAt === "number"
      ? receivedAt : receivedAt instanceof Date
        ? receivedAt.getTime()
        : typeof receivedAt === "string" ? Date.parse(receivedAt) : NaN;
    const queueWaitMs = Number.isFinite(receivedAtMs) &&
      receivedAtMs > 0 && Number.isFinite(executionWallMs) &&
      executionWallMs >= receivedAtMs
      ? Math.round(executionWallMs - receivedAtMs) : null;
    let stopAfterTiming = false;
    let deferredReasonForNext = null;
    let timingDeferReason = null;
    try {
      const result = await execute(item.candidate, item.hint, item.error);
      results.push(result);
      stopAfterTiming = result?.batchStop === true;
      if (stopAfterTiming || result?.kind === "waiting" ||
          result?.kind === "unknown") {
        timingDeferReason = safeVstEntryDeferReason(
          result?.reason, "entry_attempt_stopped",
        );
        deferredReasonForNext = timingDeferReason;
      }
    } catch {
      // Keep the error message out of telemetry and stop after an unexpected
      // execution failure because the durable phase boundary may be unclear.
      results.push({ kind: "error", reason: "vst_entry_batch_execution_failed" });
      stopAfterTiming = true;
      deferredReasonForNext = "vst_entry_batch_execution_failed";
      timingDeferReason = deferredReasonForNext;
    }
    try {
      await onTiming?.({
        sourceSignalId: item.candidate?.sourceSignalId,
        prepareMs: Math.round(item.prepareMs),
        executeMs: Math.round(Math.max(0, now() - executeStartedAt)),
        batchWaitMs: Math.round(Math.max(0, executeStartedAt - startedAt)),
        // Unknown receipt time is not zero waiting time. Do not label only
        // this cohort's preparation as the signal's entire ingress queue age.
        queueWaitMs,
        prepared: item.error === undefined,
        ...(timingDeferReason ? { deferReason: timingDeferReason } : {}),
      });
    } catch {}
    if (stopAfterTiming) {
      deferredReason = deferredReasonForNext ?? "entry_attempt_stopped";
      break;
    }
  }
  for (const item of prepared.slice(results.length)) {
    notify(onDeferred, {
      sourceSignalId: item.candidate?.sourceSignalId,
      prepareMs: Math.round(item.prepareMs),
      prepared: item.error === undefined,
      deferReason: deferredReason,
    });
  }
  return {
    results,
    processed: results.length,
    deferred: Math.max(0, prepared.length - results.length),
    elapsedMs: Math.max(0, now() - startedAt),
    preparationMs: Math.max(0, executionStartedAt - startedAt),
    executionMs: Math.max(0, now() - executionStartedAt),
  };
}