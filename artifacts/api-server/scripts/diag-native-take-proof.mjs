// Read-only diagnostic (GET only, VST): why did proveNativeTakeFill not prove a
// native +5% take fill? Replays its checks step by step and prints each one.
// Usage (from artifacts/api-server, with the production VST BingX secrets):
//   node scripts/diag-native-take-proof.mjs NOTUSDT 2114830379713650688 23116726 2114830085031723009 1793049823414 2114830085789409280:23116726:0.0003372
// args: symbol takeOrderId quantity positionId bindingCreatedAtMs [stopOrderId:qty:stopPrice ...]
import { createBingXLiveApi } from "../src/bullet-bot/bingx-live-api.mjs";
import { proveNativeTakeFill } from "../src/bullet-bot/native-full-take.mjs";

const [symbol, orderId, quantity, positionId, createdAt, ...stopArgs] = process.argv.slice(2);
if (!symbol || !orderId || !quantity || !positionId || !createdAt) {
  console.error("usage: symbol takeOrderId quantity positionId bindingCreatedAtMs [stopOrderId:qty:stopPrice ...]");
  process.exit(2);
}
const api = createBingXLiveApi({ environment: "vst", writePermission: () => false });
const binding = { symbol, orderId, quantity, positionId, createdAt: Number(createdAt) };
const stops = stopArgs.map((s) => { const [o, q, p] = s.split(":"); return { orderId: o, quantity: q, stopPrice: p, type: "STOP_MARKET" }; });
const now = Date.now();
const show = (label, value) => console.log(`--- ${label}\n${JSON.stringify(value, (k, v) => (typeof v === "bigint" ? String(v) : v), 1)}`);
const step = async (label, fn) => { try { const v = await fn(); show(label, v); return v; } catch (e) { show(`${label} ERROR`, String(e?.message ?? e)); return undefined; } };

const parent = await step("queryOrder(takeOrderId)", () => api.queryOrder(symbol, { orderId }));
const positions = await step("getPositions", () => api.getPositions(symbol));
const orders = await step("getOpenOrders", () => api.getOpenOrders(symbol));
const fills = await step("queryFills(requireComplete, USDT)", () => api.queryFills(symbol, {
  startTs: Math.max(1, binding.createdAt - 60_000, now - 86_400_000), endTs: now, currency: "USDT", requireComplete: true,
}));
if (parent) {
  show("parent field types", Object.fromEntries(["orderId", "orderID", "triggerOrderId", "positionId", "positionID", "status", "type", "symbol", "side", "positionSide", "executedQty"].map((k) => [k, parent[k] === undefined ? "undefined" : `${typeof parent[k]}:${parent[k]}`])));
}
if (Array.isArray(fills)) {
  const linked = fills.filter((f) => String(f.triggerOrderId ?? f.triggerOrderID ?? "") === orderId);
  show("linked fills (triggerOrderId == take)", linked.map((f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, `${typeof v}:${v}`]))));
  const childId = linked[0]?.orderId ?? linked[0]?.orderID;
  if (childId != null) await step("queryOrder(childOrderId)", () => api.queryOrder(symbol, { orderId: String(childId) }));
}
await step("proveNativeTakeFill result", () => proveNativeTakeFill(api, binding, stops, now));
