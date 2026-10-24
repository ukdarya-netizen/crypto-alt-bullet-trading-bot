import { createHmac } from "node:crypto";
import { assessBingXSymbolIsolation } from "./bingx-symbol-isolation.mjs";

// This module is deliberately read-only. It must not expose account details or
// be used as proof that live order placement, stops, or margin top-ups are safe.
const ORIGIN = "https://open-api.bingx.com";
const PATHS = [
  "/openApi/swap/v3/user/balance",
  "/openApi/swap/v2/user/positions",
  "/openApi/swap/v1/positionSide/dual",
  "/openApi/swap/v2/trade/openOrders",
];
const GAP_MS = 600;
const SYMBOL = /^[A-Z0-9]{2,20}USDT$/;

export function createBingXLivePreflight({
  fetchImpl = globalThis.fetch,
  clock = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  credentials = () => ({
    key: process.env.BINGX_API_KEY,
    secret: process.env.BINGX_API_SECRET,
  }),
} = {}) {
  return async function preflight({ symbol } = {}) {
    const checks = { initialMargin: null, flatAccount: null, oneWayMode: null };
    const blockers = ["execution_disabled", "stop_and_exit_unverified", "margin_topup_unverified"];
    const notices = [];
    let symbolCheck = null;
    const checkedAt = new Date(clock()).toISOString();
    if (symbol !== undefined && (typeof symbol !== "string" || !SYMBOL.test(symbol))) {
      return {
        status: "blocked", environment: "mainnet", checkedAt, checks, notices, symbolCheck,
        blockers: [...blockers, "invalid_symbol"],
      };
    }
    const { key, secret } = credentials();
    if (!key || !secret) {
      return {
        status: "blocked", environment: "mainnet", checkedAt, checks, notices, symbolCheck,
        blockers: [...blockers, "credentials_missing"],
      };
    }

    async function read(path, extra = "") {
      // Only hardcoded GET paths are accepted; no trade or account write can
      // happen through this client. Exchange responses are never forwarded.
      if (!PATHS.includes(path)) throw new Error("Unsupported read-only path");
      const query = `recvWindow=5000&${extra ? `symbol=${encodeURIComponent(extra)}&` : ""}timestamp=${clock()}`;
      const signature = createHmac("sha256", secret).update(query).digest("hex");
      try {
        const response = await fetchImpl(`${ORIGIN}${path}?${query}&signature=${signature}`, {
          method: "GET",
          headers: { "X-BX-APIKEY": key, "X-SOURCE-KEY": "BX-AI-SKILL" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) return null;
        const payload = await response.json();
        return payload?.code === 0 ? payload.data : null;
      } catch {
        return null;
      }
    }

    const balance = await read(PATHS[0]);
    if (balance === null) {
      return {
        status: "unavailable", environment: "mainnet", checkedAt, checks, notices, symbolCheck,
        blockers: [...blockers, "account_check_unavailable"],
      };
    }
    const accounts = Array.isArray(balance) ? balance
      : Array.isArray(balance?.balance) ? balance.balance
      : balance?.balance && typeof balance.balance === "object" ? [balance.balance]
      : [];
    const usdt = accounts.filter((item) => item?.asset === "USDT");
    const available = usdt.length === 1 ? Number(usdt[0].availableMargin) : NaN;
    checks.initialMargin = Number.isFinite(available) && available >= 10;
    if (!checks.initialMargin) blockers.push("initial_margin_unverified");

    await sleep(GAP_MS);
    const positions = await read(PATHS[1]);
    if (!Array.isArray(positions)) {
      return {
        status: "unavailable", environment: "mainnet", checkedAt, checks, notices, symbolCheck,
        blockers: [...blockers, "account_check_unavailable"],
      };
    }
    checks.flatAccount = positions.every((position) => {
      const amount = position?.positionAmt;
      return (typeof amount === "string" && amount.trim() !== "" ||
        typeof amount === "number") &&
        Number.isFinite(Number(amount)) && Number(amount) === 0;
    });
    if (!checks.flatAccount) notices.push("existing_positions_or_unknown");

    await sleep(GAP_MS);
    const positionMode = await read(PATHS[2]);
    // The official table calls this a boolean; the live API also returns the
    // literal strings "true"/"false". Reject any other coercible value.
    const dual = positionMode?.dualSidePosition;
    if (dual !== true && dual !== false && dual !== "true" && dual !== "false") {
      return {
        status: "unavailable", environment: "mainnet", checkedAt, checks, notices, symbolCheck,
        blockers: [...blockers, "account_check_unavailable"],
      };
    }
    checks.oneWayMode = dual === false || dual === "false";
    if (!checks.oneWayMode) notices.push("hedge_mode");

    if (symbol !== undefined) {
      await sleep(GAP_MS);
      const venueSymbol = `${symbol.slice(0, -4)}-USDT`;
      const openOrders = await read(PATHS[3], venueSymbol);
      const assessment = assessBingXSymbolIsolation(symbol, positions, openOrders, dual);
      symbolCheck = {
        symbol,
        symbolClear: assessment.symbolClear,
        positionSide: assessment.positionSide,
        reason: assessment.reason,
      };
      if (!Array.isArray(openOrders)) {
        return {
          status: "unavailable", environment: "mainnet", checkedAt, checks, notices, symbolCheck,
          blockers: [...blockers, "symbol_check_unavailable"],
        };
      }
      if (!assessment.symbolClear) blockers.push("symbol_conflict_or_unknown");
    }
    return { status: "blocked", environment: "mainnet", checkedAt, checks, notices, symbolCheck, blockers };
  };
}

export const probeBingXLivePreflight = createBingXLivePreflight();