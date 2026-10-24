import Decimal from "decimal.js";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Read-only exchange audit. A fund-flow record has no documented position ID.
 * Only a symbol exclusively traded by this bot throughout the entire interval
 * may be attributed; missing/saturated order history leaves coverage unset.
 */
export async function reconcileLiveFunding({
  store, exchange, account, environment = "mainnet", clock = Date.now,
}) {
  if (environment !== "mainnet") throw new TypeError("REAL funding requires mainnet");
  const candidates = await store.listFundingCandidates(account, environment);
  const results = [];
  for (const candidate of candidates) {
    try {
      const fills = candidate.fills;
      const ids = new Set(candidate.client_ids);
      if (candidate.snapshot?.fundingIsolationAtEntry !== true ||
          candidate.snapshot?.mode !== "live" || candidate.snapshot?.externalClose === true ||
          candidate.unresolved !== 0 || !Array.isArray(fills) || fills.length < 2 ||
          ids.size === 0 || !Array.isArray(candidate.client_ids) ||
          fills.some((fill) => fill.state !== "reconciled" ||
            !ids.has(fill.clientOrderId) ||
            !["BUY", "SELL"].includes(fill.side) ||
            !Number.isFinite(Number(fill.quantity)) || Number(fill.quantity) <= 0 ||
            !Number.isSafeInteger(Date.parse(fill.filledAt)))) {
        results.push({ signalId: candidate.signal_id, status: "incomplete" });
        continue;
      }
      const buys = fills.filter((fill) => fill.side === "BUY");
      const sells = fills.filter((fill) => fill.side === "SELL");
      const quantity = (rows) => rows.reduce((sum, fill) => sum.plus(fill.quantity), new Decimal(0));
      const start = Math.min(...buys.map((fill) => Date.parse(fill.filledAt)));
      const end = Math.max(...sells.map((fill) => Date.parse(fill.filledAt)));
      const isolationStart = Date.parse(candidate.snapshot.fundingIsolationStartedAt);
      if (!buys.length || !sells.length || !quantity(buys).eq(quantity(sells)) ||
          !fills.every((fill) => Date.parse(fill.filledAt) >= start &&
            Date.parse(fill.filledAt) <= end) ||
          !Number.isSafeInteger(isolationStart) || isolationStart <= 0 ||
          isolationStart > start || start <= 0 || end <= start ||
          end > clock() - DAY || isolationStart < clock() - 89 * DAY) {
        results.push({ signalId: candidate.signal_id, status: "incomplete" });
        continue;
      }
      const observedClients = new Set();
      for (let from = isolationStart; from <= end; from += DAY) {
        const orders = await exchange.queryOrderHistory(candidate.symbol, {
          startTs: from, endTs: Math.min(end, from + DAY - 1),
        });
        const forced = await exchange.queryForcedOrders(candidate.symbol, {
          startTs: from, endTs: Math.min(end, from + DAY - 1),
        });
        if (!Array.isArray(forced) || forced.length !== 0) {
          throw new Error("Forced same-symbol liquidation history is not empty");
        }
        if (!Array.isArray(orders)) throw new Error("Order history is incomplete");
        for (const order of orders) {
          const clientId = order.clientOrderId ?? order.clientOrderID;
          if (ids.has(clientId)) {
            observedClients.add(clientId);
          } else {
            // An unrelated same-symbol order may have executed even if it
            // ended canceled/expired. Missing execution facts fail closed.
            const executed = Number(order.executedQty);
            if (!Number.isFinite(executed) || executed !== 0) {
              throw new Error("Other same-symbol exchange exposure is possible");
            }
          }
        }
      }
      // Require at least an own entry and exit in the exchange's order list,
      // not merely an empty response that looks like exclusive history.
      if (!fills.some((fill) => fill.side === "BUY" &&
            fill.phase === "entry" && observedClients.has(fill.clientOrderId)) ||
          !fills.some((fill) => fill.side === "SELL" &&
            fill.phase !== "external" && observedClients.has(fill.clientOrderId)) ||
          fills.some((fill) => !observedClients.has(fill.clientOrderId))) {
        throw new Error("Own entry/exit exchange order history is missing");
      }
      const settlements = await exchange.queryFundingSettlements(candidate.symbol, {
        startTs: start, endTs: end,
      });
      for (const settlement of settlements) {
        if (settlement.time <= start || settlement.time >= end) {
          throw new Error("Funding at the entry/exit boundary is ambiguous");
        }
      }
      for (const settlement of settlements) {
        await store.recordFunding({
          account, environment, signalId: candidate.signal_id, ...settlement,
        });
      }
      await store.certifyFundingCoverage({
        account, environment, signalId: candidate.signal_id,
        coveredThrough: new Date(end).toISOString(),
      });
      results.push({ signalId: candidate.signal_id, status: "verified" });
    } catch (error) {
      results.push({
        signalId: candidate.signal_id, status: "incomplete",
        reason: error instanceof Error ? error.message : "Funding audit failed",
      });
    }
  }
  return results;
}