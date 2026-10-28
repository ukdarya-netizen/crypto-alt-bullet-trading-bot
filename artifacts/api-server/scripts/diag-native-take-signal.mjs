// Read-only diagnostic (DB SELECT + exchange GET only, VST): for each source
// signal, loads its latest native +5% take intent and position snapshot, then
// replays the native take checks step by step and prints raw exchange rows:
//  - entry check of native.create (entry order avgPrice vs binding.entryPrice);
//  - proveNativeTakeFill (parent order, positions, open orders, fills, result).
// Usage (from artifacts/api-server, production DATABASE_URL + VST BingX secrets):
//   node scripts/diag-native-take-signal.mjs cab-signal-19959 cab-signal-19949
import { pool } from "@workspace/db";
import { createBingXLiveApi } from "../src/bullet-bot/bingx-live-api.mjs";
import { proveNativeTakeFill, nativeStopBindings } from "../src/bullet-bot/native-full-take.mjs";

const ids = process.argv.slice(2);
if (!ids.length) {
  console.error("usage: node scripts/diag-native-take-signal.mjs <sourceSignalId> [...]");
  process.exit(2);
}
const api = createBingXLiveApi({ environment: "vst", writePermission: () => false });
const json = (v) => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? String(x) : x), 1);
const show = (label, value) => console.log(`--- ${label}\n${json(value)}`);
const step = async (label, fn) => {
  try { const v = await fn(); show(label, v); return v; }
  catch (e) { show(`${label} ERROR`, String(e?.message ?? e)); return undefined; }
};

for (const sourceSignalId of ids) {
  console.log(`\n========== ${sourceSignalId}`);
  const intent = (await pool.query(
    `SELECT phase, client_order_id, request, state, exchange_order_id, outcome,
            created_at::text, updated_at::text
       FROM vst_order_intents
      WHERE source_signal_id = $1 AND phase LIKE 'native-full-take-%'
      ORDER BY id DESC LIMIT 1`, [sourceSignalId])).rows[0];
  const position = (await pool.query(
    `SELECT symbol, status, snapshot, updated_at::text
       FROM vst_positions WHERE source_signal_id = $1`, [sourceSignalId])).rows[0];
  show("intent (DB)", intent ?? null);
  show("position (DB)", position ? { ...position, snapshot: {
    entryPrice: position.snapshot?.entryPrice, remainingQty: position.snapshot?.remainingQty,
    exchangePositionId: position.snapshot?.exchangePositionId,
    entryOrderId: position.snapshot?.entryOrderId,
    verifiedProtectiveStops: position.snapshot?.verifiedProtectiveStops,
    coreStopOrderId: position.snapshot?.coreStopOrderId, stopPrice: position.snapshot?.stopPrice,
  } } : null);
  if (!intent || !position) continue;
  const binding = { ...intent.request.binding,
    ...(intent.exchange_order_id ? { orderId: intent.exchange_order_id } : {}) };
  const stops = nativeStopBindings(position.snapshot);
  show("binding", binding);
  show("stops", stops);
  const symbol = binding.symbol;
  const entry = await step("queryOrder(entryOrderId)", () =>
    api.queryOrder(symbol, { orderId: binding.entryOrderId }));
  if (entry) show("entry avgPrice vs binding.entryPrice", {
    exchangeAvgPrice: `${typeof entry.avgPrice}:${entry.avgPrice}`,
    bindingEntryPrice: `${typeof binding.entryPrice}:${binding.entryPrice}`,
    snapshotEntryPrice: position.snapshot?.entryPrice,
  });
  if (!binding.orderId) continue;
  const now = Date.now();
  const parent = await step("queryOrder(takeOrderId)", () => api.queryOrder(symbol, { orderId: binding.orderId }));
  if (parent) show("parent field types", Object.fromEntries(["orderId", "triggerOrderId", "clientOrderId",
    "positionId", "status", "type", "side", "positionSide", "executedQty", "avgPrice"]
    .map((k) => [k, parent[k] === undefined ? "undefined" : `${typeof parent[k]}:${parent[k]}`])));
  await step("getPositions", () => api.getPositions(symbol));
  await step("getOpenOrders", () => api.getOpenOrders(symbol));
  const fills = await step("queryFills(requireComplete, USDT)", () => api.queryFills(symbol, {
    startTs: Math.max(1, Number(binding.createdAt) - 60_000, now - 86_400_000), endTs: now,
    currency: "USDT", requireComplete: true,
  }));
  if (Array.isArray(fills)) show("fills of parent order id", fills.filter((f) =>
    String(f.orderId ?? f.orderID ?? "") === String(parent?.orderId ?? "")));
  await step("proveNativeTakeFill result", () => proveNativeTakeFill(api, binding, stops, now));
}
await pool.end();
