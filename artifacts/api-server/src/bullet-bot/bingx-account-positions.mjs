import { createBingXLiveApi, positionInitialMargin } from "./bingx-live-api.mjs";

const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const SYMBOL = /^[A-Z0-9]+-[A-Z0-9]+$/;

function exchangeDecimal(value, { positive = false, nonnegative = false } = {}) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  if (!DECIMAL.test(text)) return null;
  const number = Number(text);
  if (!Number.isFinite(number) || (positive && number <= 0) ||
      (nonnegative && number < 0)) return null;
  return text;
}

function exchangeTime(value) {
  if ((typeof value !== "string" && typeof value !== "number") ||
      !/^\d{13}$/.test(String(value))) return null;
  const timestamp = Number(value);
  const date = new Date(timestamp);
  return Number.isSafeInteger(timestamp) && timestamp > 0 &&
    Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function normalizeBingXAccountPositions(rows) {
  if (!Array.isArray(rows)) throw new TypeError("BingX positions response is not a list");
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row) ||
        typeof row.symbol !== "string" || !SYMBOL.test(row.symbol)) {
      throw new TypeError("BingX position has an invalid symbol");
    }
    const amount = exchangeDecimal(row.positionAmt);
    if (amount === null) throw new TypeError("BingX position has an invalid amount");
    const signedAmount = Number(amount);
    if (signedAmount === 0) return [];

    const side = row.positionSide === "LONG" || row.positionSide === "SHORT"
      ? row.positionSide
      : row.positionSide === "BOTH" || row.positionSide == null
        ? signedAmount > 0 ? "LONG" : "SHORT"
        : null;
    const leverage = Number(row.leverage);
    const unrealizedPnlUsdt = exchangeDecimal(row.unrealizedProfit);
    // BingX's documented field here is "initialMargin" (see positionInitialMargin's
    // doc comment in bingx-live-api.mjs) -- there is no "margin" field on this
    // endpoint. Reading row.margin directly was silently picking up an unrelated
    // (much smaller, or undefined) value, which inflated the displayed ROE far
    // beyond the real PnL/margin ratio for REAL and VST live positions alike.
    const marginUsdt = exchangeDecimal(positionInitialMargin(row), { nonnegative: true });
    const margin = marginUsdt === null ? NaN : Number(marginUsdt);
    const pnl = unrealizedPnlUsdt === null ? NaN : Number(unrealizedPnlUsdt);
    const roe = margin > 0 && Number.isFinite(pnl) ? pnl / margin * 100 : NaN;
    return [{
      symbol: row.symbol,
      side,
      size: amount.startsWith("-") ? amount.slice(1) : amount,
      entryPrice: exchangeDecimal(row.avgPrice, { positive: true }),
      markPrice: exchangeDecimal(row.markPrice, { positive: true }),
      // Exchange-reported, never derived from the PAPER quote or entry price.
      unrealizedPnlUsdt,
      roePercent: Number.isFinite(roe) ? String(Number(roe.toFixed(4))) : null,
      // A position field alone does not prove an active protective order.
      // Until an order-side read can unambiguously verify it, leave it unknown.
      stopPrice: null,
      liquidationPrice: exchangeDecimal(row.liquidationPrice, { positive: true }),
      marginUsdt,
      leverage: Number.isFinite(leverage) && row.leverage !== null &&
        row.leverage !== undefined && row.leverage !== "" && leverage > 0 ? leverage : null,
      marginMode: row.isolated === true ? "ISOLATED"
        : row.isolated === false ? "CROSSED" : null,
      openedAt: exchangeTime(row.createTime),
    }];
  });
}

function balanceRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.balance)) return value.balance;
  if (value?.balance && typeof value.balance === "object" &&
      !Array.isArray(value.balance)) return [value.balance];
  return [];
}

export function normalizeBingXAccountBalance(value) {
  const usdt = balanceRows(value).filter((row) =>
    row && typeof row === "object" && !Array.isArray(row) && row.asset === "USDT");
  if (usdt.length !== 1) return null;
  const row = usdt[0];
  return {
    // Copy only documented numeric facts from BingX. Never derive one from another.
    walletBalanceUsdt: exchangeDecimal(row.balance, { nonnegative: true }),
    equityUsdt: exchangeDecimal(row.equity, { nonnegative: true }),
    availableMarginUsdt: exchangeDecimal(row.availableMargin, { nonnegative: true }),
    unrealizedPnlUsdt: exchangeDecimal(row.unrealizedProfit),
  };
}

function receivedAt(clock) {
  const observedAt = new Date(clock());
  if (!Number.isFinite(observedAt.getTime())) throw new TypeError("Invalid observation time");
  return observedAt.toISOString();
}

// Groups raw income rows by tradeId into closed-trade records for the REAL
// "recently closed" journal view. A trade only counts as a close when it has
// a REALIZED_PNL or INSURANCE_CLEAR row; the matching "Position closing fee"
// TRADING_FEE row (same tradeId) supplies the fee when present. BingX's
// income history never reports entry/close price, quantity, or margin for a
// closed trade -- those fields stay null rather than being estimated.
export function groupBingXClosedTrades(rows, { limit = 10 } = {}) {
  if (!Array.isArray(rows)) throw new TypeError("BingX income rows must be a list");
  const byTrade = new Map();
  for (const row of rows) {
    const existing = byTrade.get(row.tradeId) ?? { symbol: row.symbol, time: 0 };
    existing.time = Math.max(existing.time, row.time);
    if (row.incomeType === "REALIZED_PNL" || row.incomeType === "INSURANCE_CLEAR") {
      existing.pnlUsdt = exchangeDecimal(row.amountUsdt);
      existing.liquidation = row.incomeType === "INSURANCE_CLEAR";
    } else if (row.incomeType === "TRADING_FEE" && row.info === "Position closing fee") {
      existing.feeUsdt = exchangeDecimal(row.amountUsdt);
    }
    byTrade.set(row.tradeId, existing);
  }
  return [...byTrade.entries()]
    .filter(([, entry]) => entry.pnlUsdt !== undefined && entry.pnlUsdt !== null)
    .map(([tradeId, entry]) => ({
      tradeId,
      symbol: entry.symbol,
      closedAt: new Date(entry.time).toISOString(),
      pnlUsdt: entry.pnlUsdt,
      feeUsdt: entry.feeUsdt ?? null,
      liquidation: entry.liquidation === true,
    }))
    .sort((a, b) => b.closedAt.localeCompare(a.closedAt))
    .slice(0, limit);
}

export async function readBingXAccountClosedTrades({
  exchange = createBingXLiveApi(),
  clock = Date.now,
  credentialsConfigured = Boolean(process.env.BINGX_API_KEY && process.env.BINGX_API_SECRET),
} = {}) {
  const base = { source: "BingX private income history" };
  if (!credentialsConfigured) {
    return { ...base, status: "not_configured", observedAt: null, trades: [] };
  }
  try {
    const rows = await exchange.queryClosedTradeIncome({ limit: 200 });
    const trades = groupBingXClosedTrades(rows, { limit: 10 });
    return { ...base, status: "available", observedAt: receivedAt(clock), trades };
  } catch {
    return { ...base, status: "unavailable", observedAt: null, trades: [] };
  }
}

export async function readBingXAccountPositions({
  exchange = createBingXLiveApi(),
  clock = Date.now,
  credentialsConfigured = Boolean(process.env.BINGX_API_KEY && process.env.BINGX_API_SECRET),
} = {}) {
  const base = {
    environment: "mainnet",
    source: "BingX private swap positions",
  };
  if (!credentialsConfigured) {
    return {
      ...base,
      status: "not_configured",
      observedAt: null,
      positions: [],
      accountStatus: "not_configured",
      accountSource: "BingX mainnet swap account-wide USDT balance",
      accountObservedAt: null,
      account: null,
    };
  }
  // This client defaults to denied write permission. Only signed GETs are called.
  // A failed balance read must not erase a successful position snapshot, or vice versa.
  const [positionsResult, balanceResult] = await Promise.allSettled([
    (async () => {
      const raw = await exchange.getPositions();
      const positions = normalizeBingXAccountPositions(raw);
      return { positions, observedAt: receivedAt(clock) };
    })(),
    (async () => {
      if (typeof exchange.getBalance !== "function") {
        throw new TypeError("BingX account balance read is unavailable");
      }
      const raw = await exchange.getBalance();
      const account = normalizeBingXAccountBalance(raw);
      if (account === null) throw new TypeError("BingX returned no unique USDT account balance");
      return { account, observedAt: receivedAt(clock) };
    })(),
  ]);
  const positionsAvailable = positionsResult.status === "fulfilled";
  const accountAvailable = balanceResult.status === "fulfilled";
  return {
    ...base,
    status: positionsAvailable ? "available" : "unavailable",
    observedAt: positionsAvailable ? positionsResult.value.observedAt : null,
    positions: positionsAvailable ? positionsResult.value.positions : [],
    accountStatus: accountAvailable ? "available" : "unavailable",
    accountSource: "BingX mainnet swap account-wide USDT balance",
    accountObservedAt: accountAvailable ? balanceResult.value.observedAt : null,
    account: accountAvailable ? balanceResult.value.account : null,
  };
}