/**
 * The normal PAPER ticker pass uses a non-blocking advisory lock. A source
 * reconciliation must wait for a free pass instead of silently treating a
 * busy lock as an empty result.
 */
export async function syncSourceWithLockRetry(
  worker, positions, { maxAttempts = 90, delayMs = 500, sleep = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)) } = {},
) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const outcomes = await worker.syncSourcePositions(positions);
    if (outcomes !== null) return outcomes;
    if (attempt + 1 < maxAttempts) await sleep(delayMs);
  }
  throw new Error("source_sync_lock_unavailable");
}