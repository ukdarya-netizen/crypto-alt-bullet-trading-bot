import { createBingXLiveApi } from "./bingx-live-api.mjs";
import { normalizeBingXAccountPositions } from "./bingx-account-positions.mjs";

const DECIMAL = /^-?\d+(?:\.\d+)?$/;

function exchangeDecimal(value, { nonnegative = false } = {}) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  if (!DECIMAL.test(text)) return null;
  const number = Number(text);
  if (!Number.isFinite(number) || (nonnegative && number < 0)) return null;
  return text;
}

function balanceRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.balance)) return value.balance;
  if (value?.balance && typeof value.balance === "object" &&
      !Array.isArray(value.balance)) return [value.balance];
  return [];
}

/**
 * The VST wallet asset is reported as "VST", not "USDT", even though every
 * VST contract is USDT-quoted. Filtering for the wrong asset here would
 * silently report "no balance" forever.
 */
export function normalizeBingXVstAccountBalance(value) {
  const vst = balanceRows(value).filter((row) =>
    row && typeof row === "object" && !Array.isArray(row) && row.asset === "VST");
  if (vst.length !== 1) return null;
  const row = vst[0];
  return {
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

/**
 * Read-only, account-wide BingX VST demo-trading positions and balance.
 * Deliberately mirrors readBingXAccountPositions (mainnet) but targets the
 * VST host. Never places, cancels, or amends anything; only signed GETs.
 */
export async function readBingXVstAccountPositions({
  exchange = createBingXLiveApi({ environment: "vst" }),
  clock = Date.now,
  accountConfigured = Boolean(process.env.BULLET_VST_ACCOUNT_ALIAS),
} = {}) {
  if (!accountConfigured) {
    return {
      status: "unavailable",
      observedAt: null,
      positions: [],
      accountStatus: "unavailable",
      accountObservedAt: null,
      account: null,
    };
  }
  const [positionsResult, balanceResult] = await Promise.allSettled([
    (async () => {
      const raw = await exchange.getPositions();
      const positions = normalizeBingXAccountPositions(raw);
      return { positions, observedAt: receivedAt(clock) };
    })(),
    (async () => {
      const raw = await exchange.getBalance();
      const account = normalizeBingXVstAccountBalance(raw);
      if (account === null) throw new TypeError("BingX VST returned no unique VST account balance");
      return { account, observedAt: receivedAt(clock) };
    })(),
  ]);
  const positionsAvailable = positionsResult.status === "fulfilled";
  const accountAvailable = balanceResult.status === "fulfilled";
  return {
    status: positionsAvailable ? "available" : "unavailable",
    observedAt: positionsAvailable ? positionsResult.value.observedAt : null,
    positions: positionsAvailable ? positionsResult.value.positions : [],
    accountStatus: accountAvailable ? "available" : "unavailable",
    accountObservedAt: accountAvailable ? balanceResult.value.observedAt : null,
    account: accountAvailable ? balanceResult.value.account : null,
  };
}
