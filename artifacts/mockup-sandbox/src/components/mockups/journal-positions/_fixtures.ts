const observedAt = () => new Date().toISOString();
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export type JournalBotPositionsItem = {
  sourceSignalId: string;
  status: string;
  snapshot: {
    symbol: string;
    side: string;
    remainingQty: string;
    quantity: string;
    entryPrice: string;
    entryAt: string;
    stopPrice: string;
    runnerOpen: boolean;
    coreOpen: boolean;
    runnerStopPrice: string | null;
    marginHeldUsd: string;
  };
  market: {
    quoteStatus: string;
    quoteAt: string;
    quotePrice: string;
    unrealizedPnlUsdt: string;
    priceBasis: string;
  };
  marginRisk: { stopPriceUsed: string | null };
};

export type BingXAccountPosition = {
  symbol: string;
  side: "LONG" | "SHORT" | null;
  size: string;
  entryPrice: string | null;
  markPrice: string | null;
  unrealizedPnlUsdt: string | null;
  stopPrice: string | null;
  liquidationPrice: string | null;
  marginUsdt: string | null;
  leverage: number | null;
  marginMode: string | null;
  openedAt: string | null;
};

export type JournalVstPositionsPositionsItem = {
  sourceSignalId: string;
  symbol: string;
  remainingQty: string;
  entryPrice: string;
  stopPrice: string;
  status: string;
  updatedAt: string;
};

const paperData = {
  sourceSync: { state: "ok", checkedAt: observedAt(), lastSuccessAt: observedAt(), reason: null },
  paperEquity: { walletUsdt: "2500.00", equityUsdt: "2527.84", status: "fresh" },
  positions: [
    {
      sourceSignalId: "sig-paper-btc-2406",
      status: "open",
      snapshot: {
        symbol: "BTC-USDT", side: "LONG", remainingQty: "0.018500", quantity: "0.025000",
        entryPrice: "64210.5000", entryAt: minutesAgo(42), stopPrice: "63580.0000",
        runnerOpen: false, coreOpen: true, runnerStopPrice: null, marginHeldUsd: "118.7884",
      },
      market: {
        quoteStatus: "fresh", quoteAt: observedAt(), quotePrice: "64842.0000",
        unrealizedPnlUsdt: "11.6839", priceBasis: "BingX mark",
      },
      marginRisk: { stopPriceUsed: null },
    },
    {
      sourceSignalId: "sig-paper-eth-9172",
      status: "closing",
      snapshot: {
        symbol: "ETH-USDT", side: "SHORT", remainingQty: "0.420000", quantity: "0.420000",
        entryPrice: "3492.8000", entryAt: minutesAgo(126), stopPrice: "3560.0000",
        runnerOpen: false, coreOpen: true, runnerStopPrice: null, marginHeldUsd: "146.6976",
      },
      market: {
        quoteStatus: "fresh", quoteAt: observedAt(), quotePrice: "3468.2000",
        unrealizedPnlUsdt: "10.3320", priceBasis: "BingX mark",
      },
      marginRisk: { stopPriceUsed: null },
    },
  ] satisfies JournalBotPositionsItem[],
};

const bingxData = {
  status: "available",
  observedAt: observedAt(),
  positions: [
    {
      symbol: "BTC-USDT", side: "LONG", size: "0.025000", entryPrice: "64210.5000",
      markPrice: "64842.0000", unrealizedPnlUsdt: "15.7875", stopPrice: null,
      liquidationPrice: "58120.0000", marginUsdt: "642.1050", leverage: 10,
      marginMode: "ISOLATED", openedAt: minutesAgo(83),
    },
    {
      symbol: "ETH-USDT", side: "SHORT", size: "0.650000", entryPrice: "3510.2000",
      markPrice: "3468.2000", unrealizedPnlUsdt: "27.3000", stopPrice: "3592.0000",
      liquidationPrice: "3974.5000", marginUsdt: "227.1630", leverage: 10,
      marginMode: "CROSSED", openedAt: minutesAgo(29),
    },
  ] satisfies BingXAccountPosition[],
  accountStatus: "available",
  accountObservedAt: observedAt(),
  account: { equityUsdt: "10043.09" },
};

const vstData = {
  source: "vst_ledger",
  exchangeVerification: "not_requested",
  positions: [
    {
      sourceSignalId: "sig-vst-sol-3815", symbol: "SOL-USDT", remainingQty: "12.500000",
      entryPrice: "142.6800", stopPrice: "138.2000", status: "open", updatedAt: minutesAgo(18),
    },
    {
      sourceSignalId: "sig-vst-xrp-6684", symbol: "XRP-USDT", remainingQty: "840.000000",
      entryPrice: "2.4810", stopPrice: "2.4050", status: "closing", updatedAt: minutesAgo(57),
    },
  ] satisfies JournalVstPositionsPositionsItem[],
};

export const getGetJournalBotQueryKey = () => ["mock-journal-bot"] as const;
export const getGetJournalBingxPositionsQueryKey = () => ["mock-bingx-positions"] as const;
export const getGetJournalVstPositionsQueryKey = () => ["mock-vst-positions"] as const;

export function useGetJournalBot(_options?: unknown) {
  const now = observedAt();
  return {
    data: {
      ...paperData,
      sourceSync: { ...paperData.sourceSync, checkedAt: now },
      positions: paperData.positions.map((position) => ({
        ...position,
        market: { ...position.market, quoteAt: now },
      })),
    },
    isLoading: false,
    error: null,
    refetch: async () => undefined,
  };
}

export function useGetJournalBingxPositions(_options?: unknown) {
  const now = observedAt();
  return {
    data: { ...bingxData, observedAt: now, accountObservedAt: now },
    isLoading: false,
    error: null,
    refetch: async () => undefined,
  };
}

export function useGetJournalVstPositions(_options?: unknown) {
  return { data: vstData, isLoading: false, error: null, refetch: async () => undefined };
}