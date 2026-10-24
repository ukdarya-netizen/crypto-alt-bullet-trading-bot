export type VstPositionPriceAudit = {
  signalReferencePrice: string | null;
  planningQuotePrice: string | null;
  planningQuoteObservedAt: string | null;
  planningPriceDeviationPct: number | null;
  entryFillAt: string | null;
  actualFillDeviationPct: number | null;
};

export function vstPositionPriceAudit(
  snapshot: unknown,
): VstPositionPriceAudit;