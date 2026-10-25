// Coalesce only a currently running public bulk quote request. Never keep a
// completed price snapshot: each consumer must still validate provider time.
export function createCoalescedPriceRead({ read, clock, sleep, minGapMs }) {
  let inFlight = null;
  let lastStartedAt = null;
  return function readPrices() {
    if (inFlight) return inFlight;
    const work = Promise.resolve().then(async () => {
      const now = Number(clock());
      if (lastStartedAt !== null) {
        const elapsed = now - lastStartedAt;
        if (!Number.isFinite(elapsed) || elapsed < 0) {
          throw new Error("Price read clock moved backwards");
        }
        if (elapsed < minGapMs) await sleep(minGapMs - elapsed);
      }
      lastStartedAt = Number(clock());
      return read();
    });
    inFlight = work;
    void work.finally(() => {
      if (inFlight === work) inFlight = null;
    }).catch(() => {});
    return work;
  };
}
