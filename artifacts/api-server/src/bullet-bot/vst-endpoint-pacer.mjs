// BingX's IP policy group numbers are not requests/second. Account groups
// 2/3 were removed on 2025-12-16. Keep conservative per-endpoint UID limits
// and a process-wide ceiling rather than serializing every GET at 1.1 s.
// Source: BingX-API/api-ai-skills, skills/references/rate-limits.md,
// skills/swap-account/api-reference.md, skills/swap-trade/api-reference.md.
const READ_ENDPOINTS = new Set([
  "/openApi/swap/v3/user/balance",
  "/openApi/swap/v2/user/positions",
  "/openApi/swap/v1/positionSide/dual",
  "/openApi/swap/v2/trade/leverage",
  "/openApi/swap/v2/trade/marginType",
  "/openApi/swap/v2/trade/order",
  "/openApi/swap/v2/trade/openOrders",
  "/openApi/swap/v2/trade/allOrders",
  "/openApi/swap/v2/trade/allFillOrders",
  "/openApi/swap/v1/positionMargin/history",
  "/openApi/swap/v2/user/commissionRate",
  "/openApi/swap/v2/user/income",
]);

export function createVstEndpointPacer({
  clock = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const queue = [];
  // Opaque per-client identities, never API keys. Retain only callers with
  // queued work so short-lived subscriber clients cannot leak here.
  const callers = [];
  const endpointNext = new Map();
  let logicalNow = 0;
  let globalNext = 0;
  let mutationNext = 0;
  let cooldownUntil = 0;
  let draining = false;
  const now = () => {
    const value = Number(clock());
    if (!Number.isFinite(value)) throw new TypeError("clock must be finite");
    logicalNow = Math.max(logicalNow, value);
    return logicalNow;
  };
  const readyAt = (item) => Math.max(
    globalNext, cooldownUntil, endpointNext.get(item.key) ?? 0,
    item.mutation ? mutationNext : 0,
  );
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const time = now();
        const available = queue.filter((item) => readyAt(item) <= time);
        const priority = available.some((candidate) => candidate.priority);
        const candidates = priority ? available.filter((item) => item.priority) : available;
        const caller = callers.find((owner) => candidates.some((item) => item.caller === owner));
        const item = candidates.find((candidate) => candidate.caller === caller);
        if (!item) {
          const next = Math.min(...queue.map(readyAt));
          // Reconsider newly queued protective writes at least every 100 ms.
          const delay = Math.min(100, next - time);
          await sleep(delay);
          logicalNow = Math.max(logicalNow, time + delay);
          continue;
        }
        queue.splice(queue.indexOf(item), 1);
        callers.splice(callers.indexOf(item.caller), 1);
        if (queue.some((pending) => pending.caller === item.caller)) callers.push(item.caller);
        const start = now();
        globalNext = start + 300; // at most four starts in any one-second window
        endpointNext.set(item.key, start + (item.fastRead ? 600 : 1_100));
        if (item.mutation) mutationNext = start + 1_100;
        item.resolve(start);
        await Promise.resolve();
      }
    } catch (error) {
      for (const item of queue.splice(0)) item.reject(error);
      callers.length = 0;
    } finally {
      draining = false;
    }
  }
  return Object.freeze({
    waitForSlot({ method, endpoint, priority = false, caller = null } = {}) {
      const fastRead = method === "GET" && READ_ENDPOINTS.has(endpoint);
      // Unknown callers retain the legacy shared conservative lane.
      const key = fastRead ? `${method} ${endpoint}` : "conservative";
      return new Promise((resolve, reject) => {
        if (!callers.includes(caller)) callers.push(caller);
        queue.push({ key, fastRead, mutation: method !== "GET",
          priority: priority === true, caller, resolve, reject });
        void drain();
      });
    },
    deferFor(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new TypeError("invalid cooldown");
      cooldownUntil = Math.max(cooldownUntil, now() + ms);
    },
  });
}
