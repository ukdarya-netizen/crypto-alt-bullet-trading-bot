import { createHmac } from "node:crypto";

// A deliberately narrow, read-only credential check. Never use these
// credentials in the PAPER executor or return a balance to the browser.
const BALANCE_URL = "https://open-api.bingx.com/openApi/swap/v3/user/balance";

export function createBingXConnectionProbe({
  fetchImpl = globalThis.fetch,
  clock = Date.now,
  credentials = () => ({
    key: process.env.BINGX_API_KEY,
    secret: process.env.BINGX_API_SECRET,
  }),
} = {}) {
  return async function probeBingXConnection() {
    const { key, secret } = credentials();
    if (!key || !secret) {
      return { status: "not_configured", environment: "mainnet", checkedAt: null, httpStatus: null };
    }

    const checkedAt = new Date(clock()).toISOString();
    const params = `recvWindow=5000&timestamp=${clock()}`;
    const signature = createHmac("sha256", secret).update(params).digest("hex");
    const url = `${BALANCE_URL}?${params}&signature=${signature}`;

    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { "X-BX-APIKEY": key, "X-SOURCE-KEY": "BX-AI-SKILL" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return { status: "unavailable", environment: "mainnet", checkedAt, httpStatus: null };
    }

    if (!response.ok) {
      // Do not log or forward exchange/edge responses: they may contain
      // account details, echoed request parameters, or other sensitive text.
      return { status: "unavailable", environment: "mainnet", checkedAt, httpStatus: response.status };
    }

    let result;
    try {
      result = await response.json();
    } catch {
      return { status: "unavailable", environment: "mainnet", checkedAt, httpStatus: response.status };
    }

    return {
      status: result?.code === 0 ? "connected" : "exchange_rejected",
      environment: "mainnet",
      checkedAt,
      httpStatus: response.status,
    };
  };
}

export const probeBingXConnection = createBingXConnectionProbe();