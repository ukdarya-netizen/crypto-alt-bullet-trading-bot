import { createHash } from "node:crypto";
import { createVstBroker } from "../../vst-broker.mjs";

export function nativeDegradedBroker(fixture, initialNow) {
  const request = structuredClone(fixture.intent.request);
  const proof = request.entryProof;
  const prior = request.priorPosition;
  const old = prior.verifiedProtectiveStops.core;
  const name = request.symbol.replace(/USDT$/, "-USDT");
  const state = {
    now: initialNow, calls: [], mutations: 0,
    position: {
      symbol: name, positionSide: "LONG", positionAmt: String(request.quantity),
      avgPrice: String(prior.entryPrice), positionId: request.positionId,
      leverage: 10, marginMode: "ISOLATED",
    },
    stop: {
      symbol: name, orderId: old.orderId, type: "STOP_MARKET", status: "NEW",
      side: "SELL", positionSide: "LONG", positionId: request.positionId,
      origQty: String(request.quantity), stopPrice: String(old.stopPrice),
      workingType: "MARK_PRICE", executedQty: "0",
    },
    mode: "HEDGE", marginMode: "ISOLATED", longLeverage: 10,
    readOutage: false, onRead: null,
  };
  const entry = {
    symbol: name, orderId: proof.entryOrderId,
    clientOrderId: `vst-${createHash("sha256").update(proof.entryClientOrderId).digest("hex").slice(0, 28)}`,
    status: "FILLED", side: "BUY", positionSide: "LONG", type: "MARKET",
    executedQty: String(proof.quantity), positionId: proof.positionId,
  };
  const fills = [{
    symbol: name, orderId: proof.entryOrderId, side: "BUY", positionSide: "LONG",
    volume: String(proof.quantity), price: String(prior.entryPrice),
    filledTm: Date.parse(prior.entryAt),
  }];
  const read = name => {
    state.calls.push(name);
    state.onRead?.(name, state);
    if (state.readOutage) throw new Error("native GET unavailable");
  };
  const mutation = async () => { state.mutations++; throw new Error("test forbids exchange mutations"); };
  const api = {
    async queryOrder(_symbol, identifier) {
      read("queryOrder");
      if (identifier.orderId === proof.entryOrderId) return structuredClone(entry);
      if (identifier.orderId === state.stop.orderId) return structuredClone(state.stop);
      const historical = state.historicalStops?.find(s => s.orderId === identifier.orderId);
      if (historical) return structuredClone(historical);
      return null;
    },
    async queryOrderHistory() { read("queryOrderHistory"); return [structuredClone(entry)]; },
    async queryFills() { read("queryFills"); return structuredClone(fills); },
    async getPositions() { read("getPositions"); return [structuredClone(state.position)]; },
    async getOpenOrders() { read("getOpenOrders"); return structuredClone(state.orders ?? [state.stop]); },
    async getPositionMode() { read("getPositionMode"); return state.mode; },
    async getMarginType() { read("getMarginType"); return state.marginMode; },
    async getLeverage() { read("getLeverage"); return { longLeverage: state.longLeverage }; },
    async getVstMarkPrice() { return { symbol: name, markPrice: String(prior.entryPrice), timestamp: state.now }; },
    async getBalance() { return [{ asset: "VST", balance: "100000" }]; },
    async contract() { return { symbol: name, pricePrecision: 4 }; },
    async getRiskTiers() { return []; },
    async getFeeRate() { return { maker: 0, taker: 0 }; },
    async getFunding() { return { rate: 0, nextFundingTime: state.now + 60_000 }; },
    placeVstAutomatedLong: mutation, upgradeVstLongStop: mutation,
    closeLong: mutation, addIsolatedMargin: mutation, setVstLongLeverage10: mutation,
  };
  const broker = createVstBroker({
    api, accountId: request.accountId, canarySymbols: [request.symbol],
    clock: () => state.now, stopBufferRate: 0.005,
  });
  return { broker, api, state, request, entry, fills };
}