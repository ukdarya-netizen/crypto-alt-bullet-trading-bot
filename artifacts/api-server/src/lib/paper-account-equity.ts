import Decimal from "decimal.js";
import type { PaperPositionMarket } from "./paper-position-market";

const PreciseDecimal = Decimal.clone({ precision: 40 });
const SIGNED_DECIMAL_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

type PaperAccount = {
  initialUsdt: number;
  freeUsdt: number;
  reservedUsdt: number;
  realizedPnlUsdt: number;
};

type FundingHealth = {
  incompleteCount: number;
  legacyUnknownCount: number;
  verifiedSettlementCount?: number;
  verifiedNetCostUsdt?: string;
  unverifiedPositions?: Array<{
    symbol: string;
    fromAt: string | null;
    status: string;
    verifiedSettlements: number;
    verifiedFundingTimes: number[];
  }>;
};

export type PaperAccountEquity = {
  status: "fresh" | "no_position" | "stale" | "unavailable" | "funding_incomplete";
  walletUsdt: string;
  equityUsdt: string | null;
  unrealizedPnlUsdt: string | null;
  changeUsdt: string | null;
  changePercent: string | null;
  oldestQuoteAt: string | null;
  fundingStatus: "current" | "incomplete";
  fundingIncompleteCount: number;
  fundingLegacyUnknownCount: number;
  fundingVerifiedSettlementCount: number;
  fundingVerifiedNetCostUsdt: string;
  fundingUnverifiedPositions: Array<{
    symbol: string;
    fromAt: string | null;
    status: string;
    verifiedSettlements: number;
    verifiedFundingTimes: number[];
  }>;
  quoteStatus: "fresh" | "stale" | "unavailable" | "no_position";
  provisionalEquityUsdt: string | null;
  provisionalUnrealizedPnlUsdt: string | null;
  provisionalChangeUsdt: string | null;
  provisionalChangePercent: string | null;
};

function money(value: number): Decimal {
  if (!Number.isFinite(value)) throw new TypeError("PAPER wallet amount must be finite");
  return new PreciseDecimal(value);
}

function decimalText(value: Decimal): string {
  return value.isZero() ? "0" : value.toString();
}

function validPnl(value: string | null): Decimal | null {
  if (typeof value !== "string" || !SIGNED_DECIMAL_TEXT.test(value)) return null;
  try {
    const parsed = new PreciseDecimal(value);
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

/** Display estimate only. A missing quote never silently becomes zero PnL. */
export function paperAccountEquity(
  account: PaperAccount,
  positions: Array<{ market: PaperPositionMarket; snapshot?: Record<string, unknown> }>,
  fundingHealth: FundingHealth = { incompleteCount: 0, legacyUnknownCount: 0 },
): PaperAccountEquity {
  const initial = money(account.initialUsdt);
  const wallet = money(account.freeUsdt).plus(money(account.reservedUsdt));
  const walletUsdt = decimalText(wallet);
  const oldestQuoteAt = positions.length > 0 &&
    positions.every(({ market }) => market.quoteAt !== null)
    ? positions.reduce((oldest, { market }) =>
      market.quoteAt! < oldest ? market.quoteAt! : oldest, positions[0].market.quoteAt!)
    : null;
  const pnlValues = positions.map(({ market }) => validPnl(market.unrealizedPnlUsdt));
  const unavailable = positions.some(({ market }, index) =>
    (market.quoteStatus !== "fresh" && market.quoteStatus !== "stale") ||
    (market.quoteStatus === "fresh" &&
      (pnlValues[index] === null || market.quoteAt === null)));
  const stale = positions.some(({ market }) => market.quoteStatus === "stale");
  const quoteStatus: PaperAccountEquity["quoteStatus"] =
    positions.length === 0 ? "no_position"
      : unavailable ? "unavailable" : stale ? "stale" : "fresh";
  const observedIncompleteCount = positions.filter(({ snapshot }) =>
    snapshot !== undefined && snapshot.fundingStatus === "incomplete").length;
  const observedLegacyUnknownCount = positions.filter(({ snapshot }) =>
    snapshot !== undefined && snapshot.fundingStatus !== "incomplete" &&
    snapshot.fundingStatus !== "current").length;
  const fundingIncompleteCount = Math.max(fundingHealth.incompleteCount, observedIncompleteCount);
  const fundingLegacyUnknownCount = Math.max(
    fundingHealth.legacyUnknownCount,
    observedLegacyUnknownCount,
  );
  const fundingVerifiedSettlementCount = fundingHealth.verifiedSettlementCount ?? 0;
  const fundingVerifiedNetCostUsdt = fundingHealth.verifiedNetCostUsdt ?? "0";
  const fundingUnverifiedPositions = fundingHealth.unverifiedPositions ?? [];
  const fundingIncomplete = positions.some(({ snapshot }) =>
    snapshot !== undefined && snapshot.fundingStatus !== "current") ||
    fundingIncompleteCount > 0 || fundingLegacyUnknownCount > 0;
  const fundingStatus = fundingIncomplete ? "incomplete" : "current";
  const status: PaperAccountEquity["status"] =
    fundingIncomplete ? "funding_incomplete"
      : quoteStatus === "no_position" ? "no_position" : quoteStatus;

  if (quoteStatus !== "fresh" && quoteStatus !== "no_position") {
    return {
      status, walletUsdt, equityUsdt: null, unrealizedPnlUsdt: null,
      changeUsdt: null, changePercent: null, oldestQuoteAt,
      fundingStatus, fundingIncompleteCount, fundingLegacyUnknownCount,
      fundingVerifiedSettlementCount, fundingVerifiedNetCostUsdt, fundingUnverifiedPositions, quoteStatus,
      provisionalEquityUsdt: null, provisionalUnrealizedPnlUsdt: null,
      provisionalChangeUsdt: null, provisionalChangePercent: null,
    };
  }

  const unrealized = positions.reduce(
    (total, _position, index) => total.plus(pnlValues[index]!),
    new PreciseDecimal(0),
  );
  const equity = wallet.plus(unrealized);
  const change = equity.minus(initial);
  return {
    status,
    walletUsdt,
    equityUsdt: fundingIncomplete ? null : decimalText(equity),
    unrealizedPnlUsdt: fundingIncomplete ? null : decimalText(unrealized),
    changeUsdt: fundingIncomplete ? null : decimalText(change),
    changePercent: !fundingIncomplete && initial.gt(0)
      ? decimalText(change.div(initial).times(100).toDecimalPlaces(6))
      : null,
    oldestQuoteAt,
    fundingStatus, fundingIncompleteCount, fundingLegacyUnknownCount,
    fundingVerifiedSettlementCount, fundingVerifiedNetCostUsdt, fundingUnverifiedPositions, quoteStatus,
    provisionalEquityUsdt: decimalText(equity),
    provisionalUnrealizedPnlUsdt: decimalText(unrealized),
    provisionalChangeUsdt: decimalText(change),
    provisionalChangePercent: initial.gt(0)
      ? decimalText(change.div(initial).times(100).toDecimalPlaces(6))
      : null,
  };
}