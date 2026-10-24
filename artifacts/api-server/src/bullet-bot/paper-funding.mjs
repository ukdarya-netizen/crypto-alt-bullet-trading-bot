const FUNDING_TIME_TOLERANCE_MS = 5 * 60_000;
const MARK_TIME_TOLERANCE_MS = 90_000;

const millis = (value) => {
  const time = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

const positive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

function validatedFundingMarkPrice(value) {
  if (
    typeof value !== "string" ||
    !/^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)
  ) return null;
  return positive(value);
}

export function inferFundingInterval(history) {
  if (!Array.isArray(history)) return null;
  const times = [...new Set(history
    .map((record) => Number(record?.fundingTime))
    .filter((time) => Number.isSafeInteger(time) && time > 0))]
    .sort((a, b) => a - b)
    .slice(-6);
  if (times.length < 3) return null;
  const intervals = times.slice(1).map((time, index) => time - times[index]);
  if (intervals.some((interval) => interval < 30 * 60_000 || interval > 24 * 60 * 60_000)) {
    return null;
  }
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return intervals.every((interval) =>
    Math.abs(interval - median) <= Math.max(FUNDING_TIME_TOLERANCE_MS, median * 0.1))
    ? median
    : null;
}

export function fundingIntervalFromHours(hours) {
  if (typeof hours !== "number" || !Number.isFinite(hours)) return null;
  const intervalMs = hours * 60 * 60_000;
  return Number.isSafeInteger(intervalMs) && intervalMs >= 30 * 60_000 && intervalMs <= 24 * 60 * 60_000
    ? intervalMs
    : null;
}

function settlementQuantity(position, settlementAt) {
  if (!Array.isArray(position.paperFills) || position.paperFills.length === 0) {
    return { quantity: null, reason: "fill_history_unavailable" };
  }
  const entryAt = millis(position.entryAt);
  if (entryAt === null || settlementAt <= entryAt) {
    return { quantity: null, reason: "settlement_entry_time_ambiguous" };
  }
  const entries = position.paperFills.filter((fill) => fill?.type === "entry");
  if (entries.length !== 1) {
    return { quantity: null, reason: "entry_fill_history_invalid" };
  }
  const entry = entries[0];
  const entryQuantity = positive(entry.quantity);
  const storedEntryAt = millis(entry.occurredAt);
  if (entryQuantity === null || storedEntryAt === null || storedEntryAt !== entryAt) {
    return { quantity: null, reason: "entry_fill_history_invalid" };
  }

  let quantity = entryQuantity;
  for (const fill of position.paperFills) {
    if (fill?.type !== "exit") continue;
    const fillAt = millis(fill.occurredAt);
    const closedQuantity = positive(fill.quantity);
    if (fillAt === null || closedQuantity === null) {
      return { quantity: null, reason: "exit_fill_history_invalid" };
    }
    if (fillAt === settlementAt) {
      return { quantity: null, reason: "settlement_close_time_ambiguous" };
    }
    // A close at the settlement instant cannot reliably establish whether it
    // happened just before or just after the exchange's funding cut-off.
    if (fillAt < settlementAt) quantity -= closedQuantity;
  }
  if (!Number.isFinite(quantity) || quantity < -1e-10 || quantity > entryQuantity) {
    return { quantity: null, reason: "fill_history_quantity_inconsistent" };
  }
  return { quantity: Math.max(0, quantity), reason: null };
}

function settlementPrice(position, fundingTime) {
  const mark = position.marketMark;
  const markAt = millis(mark?.at);
  const markPrice = positive(mark?.price);
  if (
    markPrice !== null &&
    mark?.source === "BingX public swap premiumIndex" &&
    markAt !== null &&
    Math.abs(markAt - fundingTime) <= MARK_TIME_TOLERANCE_MS
  ) {
    return {
      price: markPrice,
      source: "BingX public premiumIndex mark near funding time",
      observedAt: new Date(markAt).toISOString(),
      estimation: "near_settlement_mark",
    };
  }
  return null;
}

function fundingHistorySettlementPrice(record, fundingTime) {
  const price = validatedFundingMarkPrice(record?.markPrice);
  if (price === null) return null;
  return {
    price,
    source: "BingX public swap fundingRate markPrice",
    observedAt: new Date(fundingTime).toISOString(),
    estimation: "validated_funding_history_mark",
  };
}

/**
 * Apply only verified exchange funding-rate records. `historicalPrice` must
 * be a 1m historical candle close around the settlement; current ticker prices
 * are intentionally never accepted here.
 */
export async function reconcilePaperFunding(
  position,
  {
    history,
    now,
    historicalPrice,
    expectedFundingTime = null,
    expectedIntervalMs = null,
  },
) {
  const nowMs = millis(now);
  if (nowMs === null) throw new TypeError("Funding reconciliation requires a valid time");
  if (!Array.isArray(history)) {
    throw new TypeError("Funding history must be a validated rate array");
  }
  const previousSettlements = Array.isArray(position.fundingSettlements)
    ? position.fundingSettlements
    : [];
  const next = {
    ...position,
    fundingPaidUsdt: Number(position.fundingPaidUsdt ?? 0),
    fundingSettlements: [...previousSettlements],
    fundingStatus: "current",
  };
  const settledTimes = new Set(
    previousSettlements
      .filter((entry) => entry?.status === "applied" || entry?.status === "not_held")
      .map((entry) => Number(entry.fundingTime)),
  );
  const unresolved = new Map(
    previousSettlements
      .filter((entry) => entry?.status === "incomplete")
      .map((entry) => [Number(entry.fundingTime), entry]),
  );
  const records = [...history].sort((a, b) => a.fundingTime - b.fundingTime);
  let realizedDelta = 0;
  let unresolvedExpected = false;
  const expectedTime = Number(expectedFundingTime);
  const expectedDue = Number.isSafeInteger(expectedTime) && expectedTime > 0 && expectedTime <= nowMs;
  const expectedTimes = [];
  let cadenceUnknownGap = false;
  if (expectedDue) {
    expectedTimes.push(expectedTime);
    const interval = Number(expectedIntervalMs);
    if (Number.isSafeInteger(interval) && interval >= 30 * 60_000 && interval <= 24 * 60 * 60_000) {
      let nextExpected = expectedTime + interval;
      while (nextExpected <= nowMs && expectedTimes.length <= 1000) {
        expectedTimes.push(nextExpected);
        nextExpected += interval;
      }
    } else if (nowMs - expectedTime > 24 * 60 * 60_000) {
      // Without a validated interval sample, a multi-day outage cannot prove
      // that only the first known funding boundary was crossed.
      cadenceUnknownGap = true;
    }
  }
  const expectedMatched =
    !cadenceUnknownGap &&
    expectedTimes.length <= 1000 &&
    expectedTimes.every((time) => records.some(
      (record) => Math.abs(record.fundingTime - time) <= FUNDING_TIME_TOLERANCE_MS,
    ));

  for (const record of records) {
    if (!Number.isSafeInteger(record.fundingTime) || record.fundingTime > nowMs) {
      next.fundingStatus = "incomplete";
      continue;
    }
    const entryAt = millis(position.entryAt);
    if (entryAt === null || record.fundingTime <= entryAt) continue;
    if (settledTimes.has(record.fundingTime)) continue;

    const fundingRate = Number(record.fundingRate);
    if (!Number.isFinite(fundingRate) || Math.abs(fundingRate) >= 1) {
      next.fundingStatus = "incomplete";
      continue;
    }
    const held = settlementQuantity(position, record.fundingTime);
    const previousIndex = next.fundingSettlements.findIndex(
      (entry) => Number(entry.fundingTime) === record.fundingTime,
    );
    let settlement;
    if (held.reason || held.quantity === null) {
      unresolvedExpected = true;
      next.fundingStatus = "incomplete";
      settlement = {
        fundingTime: record.fundingTime,
        fundingRate: record.fundingRate,
        status: "incomplete",
        reason: held.reason ?? "quantity_unknown",
      };
    } else if (held.quantity === 0) {
      // Position was already closed before this exchange funding event.
      settledTimes.add(record.fundingTime);
      settlement = {
        fundingTime: record.fundingTime,
        fundingRate: record.fundingRate,
        quantity: 0,
        status: "not_held",
      };
    } else {
      let pricing = fundingHistorySettlementPrice(record, record.fundingTime);
      if (!pricing) pricing = settlementPrice(position, record.fundingTime);
      if (!pricing && typeof historicalPrice === "function") {
        try {
          pricing = await historicalPrice(record.fundingTime);
        } catch {
          pricing = null;
        }
      }
      const price = positive(pricing?.price);
      if (
        price === null ||
        !Number.isSafeInteger(millis(pricing?.observedAt)) ||
        Math.abs(millis(pricing.observedAt) - record.fundingTime) > MARK_TIME_TOLERANCE_MS ||
        typeof pricing?.source !== "string" ||
        typeof pricing?.estimation !== "string"
      ) {
        unresolvedExpected = true;
        next.fundingStatus = "incomplete";
        settlement = {
          fundingTime: record.fundingTime,
          fundingRate: record.fundingRate,
          quantity: held.quantity,
          status: "incomplete",
          reason: "historical_settlement_price_unavailable",
        };
      } else {
        // Positive funding is paid by a long; negative funding is received.
        const signedCost = Number(
          (held.quantity * price * fundingRate).toFixed(8),
        );
        if (!Number.isFinite(signedCost)) {
          unresolvedExpected = true;
          next.fundingStatus = "incomplete";
          settlement = {
            fundingTime: record.fundingTime,
            fundingRate: record.fundingRate,
            quantity: held.quantity,
            status: "incomplete",
            reason: "funding_cost_out_of_range",
          };
        } else {
        next.fundingPaidUsdt = Number(
          (next.fundingPaidUsdt + signedCost).toFixed(8),
        );
        realizedDelta -= signedCost;
        settledTimes.add(record.fundingTime);
        unresolved.delete(record.fundingTime);
        settlement = {
          fundingTime: record.fundingTime,
          fundingRate: record.fundingRate,
          quantity: held.quantity,
          settlementPrice: price,
          priceSource: pricing.source,
          priceEstimation: pricing.estimation,
          priceObservedAt: pricing.observedAt,
          signedCostUsdt: signedCost,
          status: "applied",
        };
        }
      }
    }
    if (previousIndex >= 0) {
      next.fundingSettlements[previousIndex] = settlement;
    } else {
      next.fundingSettlements.push(settlement);
    }
    if (settlement.status === "incomplete") {
      unresolved.set(record.fundingTime, settlement);
    } else {
      unresolved.delete(record.fundingTime);
    }
  }

  const expectedUnresolved = expectedDue && !expectedMatched;
  if (
    expectedUnresolved ||
    unresolvedExpected ||
    unresolved.size > 0
  ) {
    next.fundingStatus = "incomplete";
  }
  next.realizedPnlUsdt = Number(
    (Number(position.realizedPnlUsdt ?? 0) + realizedDelta).toFixed(8),
  );
  return {
    next,
    realizedDelta,
    expectedMatched,
    complete: next.fundingStatus === "current",
  };
}

export function fundingQuantityAt(position, fundingTime) {
  return settlementQuantity(position, fundingTime);
}