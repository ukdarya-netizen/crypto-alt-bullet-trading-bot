import { createHmac, createHash } from "node:crypto";

// Deliberately not configurable: this adapter must never reach mainnet.
const BASE_URL = "https://api-testnet.bybit.com";
const RECV_WINDOW = "5000";

type Envelope<T> = { retCode: number; retMsg: string; result: T };
export type BybitOrder = {
  orderId: string;
  orderLinkId: string;
  symbol: string;
  orderStatus: string;
  qty: string;
  cumExecQty: string;
  avgPrice: string;
  stopLoss: string;
  takeProfit: string;
  reduceOnly: boolean;
};
export type BybitPosition = {
  symbol: string;
  side: string;
  size: string;
  stopLoss: string;
  takeProfit: string;
  positionIdx: number;
};

export function clientOrderId(signalId: string) {
  // Bybit orderLinkId max 36 chars; reserve room for a deterministic -close ID.
  return `ts-${createHash("sha256").update(signalId).digest("hex").slice(0, 24)}`;
}

export function testnetConfigured() {
  return Boolean(process.env.BYBIT_TESTNET_API_KEY && process.env.BYBIT_TESTNET_API_SECRET);
}

async function request<T>(method: "GET" | "POST", path: string, params: Record<string, unknown>): Promise<T> {
  const key = process.env.BYBIT_TESTNET_API_KEY;
  const secret = process.env.BYBIT_TESTNET_API_SECRET;
  if (!key || !secret) throw new Error("Bybit Testnet credentials are missing.");
  const payload = method === "GET"
    ? new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString()
    : JSON.stringify(params);
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}${key}${RECV_WINDOW}${payload}`).digest("hex");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${BASE_URL}${path}${method === "GET" ? `?${payload}` : ""}`, {
      method,
      headers: {
        "X-BAPI-API-KEY": key,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": RECV_WINDOW,
        "X-BAPI-SIGN": signature,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      body: method === "POST" ? payload : undefined,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Bybit Testnet HTTP ${response.status}`);
    const data = await response.json() as Envelope<T>;
    if (data.retCode !== 0) throw new Error(`Bybit Testnet ${data.retCode}: ${data.retMsg}`);
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

export async function findOrder(symbol: string, linkId: string): Promise<BybitOrder | null> {
  const args = { category: "linear", symbol, orderLinkId: linkId };
  const current = await request<{ list: BybitOrder[] }>("GET", "/v5/order/realtime", args);
  if (current.list.length) return current.list[0];
  const history = await request<{ list: BybitOrder[] }>("GET", "/v5/order/history", args);
  return history.list[0] ?? null;
}

export async function listPositions(): Promise<BybitPosition[]> {
  const result = await request<{ list: BybitPosition[]; nextPageCursor?: string }>(
    "GET", "/v5/position/list", { category: "linear", settleCoin: "USDT", limit: 200 },
  );
  if (result.nextPageCursor) throw new Error("Position list was truncated; reconciliation stopped.");
  return result.list.filter((position) => Number(position.size) > 0);
}

export async function listOpenOrders(symbol: string): Promise<BybitOrder[]> {
  const result = await request<{ list: BybitOrder[]; nextPageCursor?: string }>(
    "GET", "/v5/order/realtime", { category: "linear", symbol, openOnly: 0, limit: 50 },
  );
  if (result.nextPageCursor) throw new Error("Open order list was truncated; execution stopped.");
  return result.list;
}

export async function marketReferencePrice(symbol: string, side: string): Promise<number> {
  const result = await request<{ list: { ask1Price: string; bid1Price: string }[] }>(
    "GET", "/v5/market/tickers", { category: "linear", symbol },
  );
  const price = Number(side === "buy" ? result.list[0]?.ask1Price : result.list[0]?.bid1Price);
  if (!Number.isFinite(price) || price <= 0) throw new Error("Bybit ticker has no valid executable price.");
  return price;
}

export async function placeOrder(input: {
  symbol: string; side: string; orderType: string; quantity: string;
  limitPrice: string | null; stopLoss: string | null; takeProfit: string | null;
  reduceOnly: boolean; linkId: string;
}) {
  return request<{ orderId: string; orderLinkId: string }>("POST", "/v5/order/create", {
    category: "linear",
    symbol: input.symbol,
    side: input.side === "buy" ? "Buy" : "Sell",
    orderType: input.orderType === "limit" ? "Limit" : "Market",
    qty: input.quantity,
    ...(input.orderType === "limit" ? { price: input.limitPrice, timeInForce: "GTC" } : {}),
    ...(input.orderType === "market" ? {
      slippageToleranceType: "Percent", slippageTolerance: "0.5",
    } : {}),
    reduceOnly: input.reduceOnly,
    orderLinkId: input.linkId,
    positionIdx: 0,
    ...(input.reduceOnly ? {} : {
      stopLoss: input.stopLoss,
      ...(input.takeProfit ? { takeProfit: input.takeProfit } : {}),
      tpslMode: "Full",
      slOrderType: "Market",
      tpOrderType: "Market",
    }),
  });
}

export async function cancelOrder(symbol: string, linkId: string) {
  await request("POST", "/v5/order/cancel", { category: "linear", symbol, orderLinkId: linkId });
}

export async function emergencyClose(symbol: string, side: string, size: string, linkId: string) {
  await request("POST", "/v5/order/create", {
    category: "linear", symbol, side: side === "Buy" ? "Sell" : "Buy",
    orderType: "Market", qty: size, reduceOnly: true, positionIdx: 0,
    orderLinkId: `${linkId}-close`,
  });
}

export function levelsMatch(actual: { stopLoss: string; takeProfit: string }, expected: { stopLoss: string | null; takeProfit: string | null }) {
  return (!expected.stopLoss || Number(actual.stopLoss) === Number(expected.stopLoss)) &&
    (!expected.takeProfit || Number(actual.takeProfit) === Number(expected.takeProfit));
}