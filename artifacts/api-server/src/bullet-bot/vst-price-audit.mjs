function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function positiveText(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? String(value) : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) ? number : null;
}

function timestamp(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return null;
}

export function vstPositionPriceAudit(snapshotValue) {
  const snapshot = record(snapshotValue);
  const audit = record(snapshot.priceAudit);
  const sizing = record(snapshot.sizing);
  const fill = record(snapshot.verifiedFill);
  return {
    signalReferencePrice: positiveText(
      audit.signalReferencePrice ?? sizing.signalReferencePrice,
    ),
    planningQuotePrice: positiveText(audit.planningQuotePrice ?? sizing.quotePrice),
    planningQuoteObservedAt: timestamp(
      audit.planningQuoteObservedAt ?? sizing.quoteObservedAtMs,
    ),
    planningPriceDeviationPct: finiteNumber(
      audit.planningPriceDeviationPct ?? sizing.signalPriceDeviationPct,
    ),
    entryFillAt: timestamp(audit.verifiedFillAt ?? fill.at),
    // Deliberately do not derive this for historical fills: only the
    // verified-entry snapshot can establish which immutable source reference
    // and exchange fill were compared at the time.
    actualFillDeviationPct: finiteNumber(audit.actualFillDeviationPct),
  };
}