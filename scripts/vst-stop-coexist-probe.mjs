#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createBingXLiveApi,
  VST_BTC_HEDGE_LONG10_SHORT75_PROBE,
} from "../artifacts/api-server/src/bullet-bot/bingx-live-api.mjs";

const HOST = "https://open-api-vst.bingx.com";
const ORDER_PATH = "/openApi/swap/v2/trade/order";
const SYMBOL = "BTCUSDT";
const API_SYMBOL = "BTC-USDT";
const MAX_QUOTE_AGE_MS = 10_000;
const MIN_NO_FILL_ARCHIVE_HISTORY_MS = 2 * 60_000;
const LEGACY_ATTEMPT_TIMESTAMP_GRACE_MS = 30_000;
const MIN_RECEIVE_WINDOW_MS = 5_000;
const NO_FILL_ARCHIVE_OBSERVATION_DELAY_MS = 10_000;
const ALLOWED_ENTRY_PRE_SIGN_REASONS = new Set([
  "final_balance_unavailable",
  "final_balance_invalid",
  "final_preflight_unavailable",
  "final_preflight_blocked",
  "final_budget_exceeded",
  "final_quote_unavailable_or_stale",
  "final_quote_out_of_bounds",
]);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_STATE_PATH = resolve(ROOT, ".local/vst-stop-coexist-state.json");
export const SHARED_VST_BTC_LOCK = resolve(ROOT, ".local/vst-btc-operations.lock");
const SAFETY_LIMITATIONS = Object.freeze([
  "The additional STOP_MARKET carries no exchange-bound positionId or clientOrderId; an observed NEW order and coexistence snapshot do not guarantee linkage, uninterrupted protection, or future coexistence.",
  "No automatic replacement is attempted. Any ambiguous add-stop response requires read-only investigate-stop and explicit operator emergency-close if needed.",
  "This probe does not change leverage or margin settings. An operator must use a separately reviewed VST preparation/restoration procedure; HEDGE isolated LONG 10x / SHORT 75x must already be verified before entry.",
]);

const READ_PATHS = new Map([
  ["/openApi/swap/v3/user/balance", []],
  ["/openApi/swap/v2/user/positions", ["symbol"]],
  ["/openApi/swap/v1/positionSide/dual", []],
  ["/openApi/swap/v2/quote/contracts", ["symbol"]],
  ["/openApi/swap/v1/maintMarginRatio", ["symbol"]],
  ["/openApi/swap/v2/user/commissionRate", ["symbol"]],
  ["/openApi/swap/v2/quote/premiumIndex", ["symbol"]],
  ["/openApi/swap/v2/trade/leverage", ["symbol"]],
  ["/openApi/swap/v2/trade/marginType", ["symbol"]],
  ["/openApi/swap/v2/trade/openOrders", ["symbol"]],
  ["/openApi/swap/v2/trade/order", ["symbol", "clientOrderId", "orderId"]],
  ["/openApi/swap/v2/trade/allOrders", ["symbol", "startTime", "endTime", "limit"]],
  ["/openApi/swap/v2/trade/allFillOrders", [
    "symbol", "tradingUnit", "startTs", "endTs", "orderId", "currency",
  ]],
]);
const TICKER_PATH = "/openApi/swap/v2/quote/ticker";
const SIGNED = ["recvWindow", "timestamp", "signature"];

function decimalParts(value, name = "decimal") {
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`invalid_${name}`);
  const fraction = match[2] ?? "";
  return { units: BigInt(`${match[1]}${fraction}`), scale: 10n ** BigInt(fraction.length) };
}

export function sameDecimal(left, right) {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = a.scale > b.scale ? a.scale : b.scale;
  return a.units * (scale / a.scale) === b.units * (scale / b.scale);
}

function compareDecimal(left, right) {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = a.scale > b.scale ? a.scale : b.scale;
  const aa = a.units * (scale / a.scale);
  const bb = b.units * (scale / b.scale);
  return aa < bb ? -1 : aa > bb ? 1 : 0;
}

function sumDecimals(values) {
  const parts = values.map((value) => decimalParts(value, "fill_quantity"));
  if (!parts.length) return "0";
  const scale = parts.reduce((max, item) => item.scale > max ? item.scale : max, 1n);
  const units = parts.reduce((sum, item) => sum + item.units * (scale / item.scale), 0n);
  const precision = String(scale).length - 1;
  const whole = units / scale;
  const fraction = String(units % scale).padStart(precision, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function exactId(row, fields = ["orderID", "orderId"]) {
  const values = fields.filter((key) => row?.[key] !== undefined && row[key] !== null)
    .map((key) => {
      const value = row[key];
      return typeof value === "string" && value.trim() ? value
        : Number.isSafeInteger(value) ? String(value) : null;
    });
  return values.length && values.every(Boolean) && new Set(values).size === 1
    ? values[0] : null;
}

function clientOrderId(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function clientIdOf(row) {
  const ids = [row?.clientOrderId, row?.clientOrderID]
    .filter((value) => value !== undefined && value !== null);
  return ids.length && ids.every((value) => typeof value === "string") &&
    new Set(ids).size === 1 ? ids[0] : null;
}

function explicitParentIdsMatch(order, expectedOrderId) {
  const rawIds = [order?.mainOrderId, order?.parentOrderId]
    .filter((id) => id !== undefined && id !== null && id !== "");
  const ids = rawIds.map((id) =>
    typeof id === "string" && id.trim() !== "" ? id
      : Number.isSafeInteger(id) ? String(id) : null);
  return ids.every((id) => id !== null && id === expectedOrderId);
}

function parseOptions(argv) {
  const [command, ...args] = argv;
  const allowed = new Set([
    "--confirm-vst-only", "--confirm-entry", "--confirm-add-stop",
    "--confirm-emergency-close", "--confirm-archive-no-fill", "--stop-price",
  ]);
  const flags = new Set();
  let stopPrice;
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === "--stop-price") {
      if (stopPrice !== undefined || !args[index + 1] ||
          !/^\d+(?:\.\d+)?$/.test(args[index + 1])) throw new Error("invalid_arguments");
      stopPrice = args[++index];
    } else if (allowed.has(item)) {
      if (flags.has(item)) throw new Error("invalid_arguments");
      flags.add(item);
    } else {
      throw new Error("invalid_arguments");
    }
  }
  const stageFlags = {
    enter: "--confirm-entry",
    "add-stop": "--confirm-add-stop",
    "emergency-close": "--confirm-emergency-close",
  };
  if (flags.has("--confirm-archive-no-fill") && command !== "archive-no-fill") {
    throw new Error("invalid_arguments");
  }
  if (flags.has("--confirm-vst-only") && ![
    "enter", "add-stop", "emergency-close", "archive-no-fill",
  ].includes(command)) {
    throw new Error("invalid_arguments");
  }
  if (stageFlags[command] && (!flags.has("--confirm-vst-only") ||
      !flags.has(stageFlags[command]))) throw new Error("confirmation_required");
  if (command === "archive-no-fill" &&
      (!flags.has("--confirm-vst-only") || !flags.has("--confirm-archive-no-fill"))) {
    throw new Error("confirmation_required");
  }
  if (![
    "preview", "status", "enter", "add-stop", "emergency-close",
    "reconcile-entry", "investigate-stop", "reconcile-close",
    "confirm-entry-protection", "archive-closed", "archive-no-fill",
  ].includes(command)) {
    throw new Error("invalid_command");
  }
  if ((command === "add-stop") !== (stopPrice !== undefined)) {
    throw new Error(command === "add-stop" ? "stop_price_required" : "invalid_arguments");
  }
  return {
    command,
    stopPrice,
    operatorConfirmed: command === "archive-no-fill" &&
      flags.has("--confirm-vst-only") && flags.has("--confirm-archive-no-fill"),
  };
}

export function createGuardedFetch(fetchImpl, options = {}) {
  const stage = options.stage ?? "read-only";
  let writeUsed = false;
  const guarded = async (input, init = {}) => {
    const url = new URL(input);
    const method = String(init.method ?? "GET").toUpperCase();
    if (url.protocol !== "https:" || url.origin !== HOST || url.username || url.password) {
      throw new Error("VST host isolation rejected request");
    }
    if (method === "GET") {
      if (url.pathname === TICKER_PATH) {
        if (url.searchParams.get("symbol") !== API_SYMBOL ||
            [...url.searchParams.keys()].some((key) => key !== "symbol") ||
            url.searchParams.getAll("symbol").length !== 1) {
          throw new Error("VST ticker read guard rejected request");
        }
      } else {
        const allowed = READ_PATHS.get(url.pathname);
        if (!allowed) throw new Error("VST read path guard rejected request");
        const permitted = new Set([...allowed, ...SIGNED]);
        const keys = [...url.searchParams.keys()];
        if (keys.some((key) => !permitted.has(key)) ||
            SIGNED.some((key) => url.searchParams.getAll(key).length !== 1) ||
            !/^\d+$/.test(url.searchParams.get("timestamp") ?? "") ||
            url.searchParams.get("recvWindow") !== "5000" ||
            !/^[0-9a-f]{64}$/.test(url.searchParams.get("signature") ?? "") ||
            allowed.some((key) => url.searchParams.getAll(key).length > 1)) {
          throw new Error("VST signed GET guard rejected request");
        }
      }
    } else {
      const signatureParams = [...SIGNED];
      const stageParams = {
        entry: [
          "symbol", "side", "positionSide", "type", "quantity", "price", "timeInForce",
          "stopLoss", "clientOrderId",
        ],
        "add-stop": [
          "symbol", "side", "positionSide", "type", "quantity", "stopPrice", "workingType",
        ],
        "emergency-close": [
          "symbol", "side", "positionSide", "type", "quantity", "clientOrderId",
        ],
      }[stage];
      const allowed = new Set([...(stageParams ?? []), ...signatureParams]);
      const required = [...(stageParams ?? []), ...signatureParams];
      const common = method === "POST" && url.pathname === ORDER_PATH && !writeUsed &&
        stageParams !== undefined && [...url.searchParams.keys()].every((key) => allowed.has(key)) &&
        required.every((key) => url.searchParams.getAll(key).length === 1) &&
        url.searchParams.get("symbol") === API_SYMBOL &&
        url.searchParams.get("positionSide") === "LONG" &&
        /^\d+(?:\.\d+)?$/.test(url.searchParams.get("quantity") ?? "") &&
        url.searchParams.get("recvWindow") === "5000" &&
        /^\d+$/.test(url.searchParams.get("timestamp") ?? "") &&
        Math.abs(Date.now() - Number(url.searchParams.get("timestamp"))) <= 2_000 &&
        /^[0-9a-f]{64}$/.test(url.searchParams.get("signature") ?? "");
      let valid = false;
      if (common && stage === "entry") {
        let stop;
        try { stop = JSON.parse(url.searchParams.get("stopLoss")); } catch {}
        valid = url.searchParams.get("side") === "BUY" &&
          url.searchParams.get("type") === "LIMIT" &&
          url.searchParams.get("timeInForce") === "FOK" &&
          url.searchParams.get("clientOrderId") === options.clientOrderId &&
          sameDecimal(url.searchParams.get("quantity"), options.expectedQuantity) &&
          sameDecimal(url.searchParams.get("price"), options.expectedPrice) &&
          stop?.type === "STOP_MARKET" && Number(stop.stopPrice) > 0 &&
          sameDecimal(String(stop.stopPrice), options.expectedEntryStop);
      } else if (common && stage === "add-stop") {
        valid = url.searchParams.get("side") === "SELL" &&
          url.searchParams.get("type") === "STOP_MARKET" &&
          url.searchParams.get("workingType") === "MARK_PRICE" &&
          url.searchParams.get("stopPrice") === options.expectedStopPrice &&
          sameDecimal(url.searchParams.get("quantity"), options.expectedQuantity) &&
          !url.searchParams.has("clientOrderId");
      } else if (common && stage === "emergency-close") {
        valid = url.searchParams.get("side") === "SELL" &&
          url.searchParams.get("type") === "MARKET" &&
          url.searchParams.get("clientOrderId") === options.clientOrderId &&
          sameDecimal(url.searchParams.get("quantity"), options.expectedQuantity) &&
          !url.searchParams.has("reduceOnly");
      }
      if (!valid) throw new Error("VST write guard rejected request");
      // Burn the stage permission before transport; ambiguous results are terminal.
      writeUsed = true;
      if (stage === "entry" && typeof options.onAttemptStarted === "function") {
        await options.onAttemptStarted(Number(url.searchParams.get("timestamp")));
      }
    }
    let response;
    try {
      response = await fetchImpl(input, { ...init, redirect: "error" });
    } catch {
      throw new Error(method === "GET" ? "VST read transport failed" : "VST write result unknown");
    }
    if (response?.redirected === true) throw new Error("VST redirect rejected");
    return response;
  };
  guarded.authorize = (values) => Object.assign(options, values);
  return guarded;
}

function marketTimestamp(value) {
  const time = Number(value);
  return Number.isFinite(time) && time > 0 ? (time < 100_000_000_000 ? time * 1000 : time) : null;
}

async function freshAsk(fetchImpl, now = Date.now()) {
  const response = await fetchImpl(
    `${HOST}${TICKER_PATH}?symbol=${encodeURIComponent(API_SYMBOL)}`, { method: "GET" },
  );
  if (!response.ok) throw new Error("ticker_read_failed");
  const payload = await response.json();
  const row = Array.isArray(payload?.data)
    ? payload.data.find((item) => item?.symbol === API_SYMBOL) : payload?.data;
  const ask = Number(row?.askPrice);
  const timestamp = marketTimestamp(row?.time ?? row?.timestamp ?? row?.closeTime ?? payload?.time);
  if (payload?.code !== 0 || !Number.isFinite(ask) || ask <= 0 || timestamp === null ||
      timestamp > now + 2_000 || now - timestamp > MAX_QUOTE_AGE_MS) {
    throw new Error("ticker_stale_or_invalid");
  }
  return { ask, timestamp };
}

function vstBalance(snapshot) {
  const rows = Array.isArray(snapshot) ? snapshot
    : Array.isArray(snapshot?.balance) ? snapshot.balance
      : snapshot?.balance && typeof snapshot.balance === "object" ? [snapshot.balance] : [];
  const matches = rows.filter((row) => row?.asset === "VST");
  if (matches.length !== 1) throw new Error("exactly_one_total_vst_balance_required");
  const balance = Number(matches[0].balance);
  if (!Number.isFinite(balance) || balance <= 0) throw new Error("invalid_total_vst_balance");
  return { balance, availableMargin: Number(matches[0].availableMargin) };
}

function floorQuantity(value, places) {
  const fixed = Number(value).toFixed(Math.min(places + 8, 16));
  const [whole, fraction = ""] = fixed.split(".");
  const retained = places ? fraction.slice(0, places).padEnd(places, "0") : "";
  return (places ? `${whole}.${retained}` : whole)
    .replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function ceilPrice(value, places) {
  const scale = 10 ** places;
  const result = Math.ceil(value * scale) / scale;
  return result.toFixed(places).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function posId(row) {
  return exactId(row, ["positionId", "positionID"]);
}

function oneLongPosition(positions) {
  if (!Array.isArray(positions) || positions.some((row) =>
    !row || typeof row.symbol !== "string")) throw new Error("positions_unverified");
  const btc = positions.filter((row) => row.symbol === API_SYMBOL);
  const active = btc.filter((row) => Number(row.positionAmt) !== 0);
  if (active.length !== 1 || active[0].positionSide !== "LONG" ||
      !/^\d+(?:\.\d+)?$/.test(String(active[0].positionAmt)) ||
      !posId(active[0])) throw new Error("exact_hedge_long_position_unverified");
  return active[0];
}

function verifyStop(order, { id, positionId, quantity, stopPrice }) {
  return exactId(order) === id && order.symbol === API_SYMBOL &&
    order.type === "STOP_MARKET" && order.status === "NEW" &&
    order.side === "SELL" && order.positionSide === "LONG" &&
    posId(order) === positionId &&
    sameDecimal(order.origQty, quantity) && sameDecimal(order.stopPrice, stopPrice) &&
    order.workingType === "MARK_PRICE";
}

export function verifyStopCoexistence({ orders, position, state, newStopId }) {
  if (!Array.isArray(orders) || orders.length !== 2 || !position ||
      posId(position) !== state.entry.positionId ||
      !sameDecimal(position.positionAmt, state.entry.quantity)) return false;
  if (newStopId === state.entry.stopOrderId) return false;
  const originals = orders.filter((row) => exactId(row) === state.entry.stopOrderId);
  const added = orders.filter((row) => exactId(row) === newStopId);
  return originals.length === 1 && added.length === 1 &&
    verifyStop(originals[0], {
      id: state.entry.stopOrderId, positionId: state.entry.positionId,
      quantity: state.entry.quantity, stopPrice: state.entry.stopPrice,
    }) &&
    verifyStop(added[0], {
      id: newStopId, positionId: state.entry.positionId,
      quantity: state.entry.quantity, stopPrice: state.addStop.stopPrice,
    });
}

async function syncDirectory(path) {
  const handle = await open(dirname(path), "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function persistState(path, state, { exclusive = false } = {}) {
  await mkdir(dirname(path), { recursive: true });
  if (exclusive) {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await syncDirectory(path);
    return;
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temp, path);
  await syncDirectory(path);
}

async function acquireLock() {
  await mkdir(dirname(SHARED_VST_BTC_LOCK), { recursive: true });
  const lockPath = SHARED_VST_BTC_LOCK;
  let handle;
  try { handle = await open(lockPath, "wx", 0o600); } catch {
    throw new Error("probe_state_busy_or_locked");
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  };
}

async function readState(path) {
  let parsed;
  try { parsed = JSON.parse(await readFile(path, "utf8")); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("state_unreadable_or_invalid");
  }
  if (parsed?.environment !== "vst" || parsed?.symbol !== SYMBOL) {
    throw new Error("state_invalid");
  }
  return parsed;
}

function makeApi(stage, guardOptions = {}, fetchImpl = globalThis.fetch) {
  const guardedFetch = createGuardedFetch(fetchImpl, { stage, ...guardOptions });
  const api = createBingXLiveApi({
    environment: "vst",
    fetchImpl: guardedFetch,
    writePermission: ({ method, path }) => method === "POST" &&
      path === ORDER_PATH && ["entry", "add-stop", "emergency-close"].includes(stage),
  });
  return { api, guardedFetch };
}

async function entryPlan(api, fetchImpl) {
  const [quote, filters, balanceSnapshot, mode, marginType, leverage, positions, orders] =
    await Promise.all([
      freshAsk(fetchImpl),
      api.contract(SYMBOL),
      api.getBalance(),
      api.getPositionMode(),
      api.getMarginType(SYMBOL),
      api.getLeverage(SYMBOL),
      api.getPositions(),
      api.getOpenOrders(SYMBOL),
    ]);
  const balance = vstBalance(balanceSnapshot);
  const btcPositionsUnambiguous = Array.isArray(positions) && positions.every((row) =>
    row && typeof row.symbol === "string" &&
    (row.symbol !== API_SYMBOL ||
      (/^-?\d+(?:\.\d+)?$/.test(String(row.positionAmt)) &&
       ["LONG", "SHORT", "BOTH"].includes(row.positionSide) &&
       Number(row.positionAmt) === 0)));
  if (mode !== "HEDGE" || marginType !== "ISOLATED" ||
       leverage.longLeverage !== 10 || leverage.shortLeverage !== 75 ||
      !btcPositionsUnambiguous || orders.length !== 0) {
    throw new Error("entry_preflight_requires_flat_btc_no_orders_hedge_isolated_long10_short75");
  }
  const price = ceilPrice(quote.ask * 1.005, filters.pricePrecision);
  const budget = balance.balance * 0.01;
  const quantity = floorQuantity(budget * 10 / Number(price), filters.quantityPrecision);
  if (Number(quantity) < filters.minQuantity ||
      Number(quantity) * Number(price) < filters.minNotional) {
    throw new Error("one_percent_vst_budget_below_contract_minimum");
  }
  const stopLoss = floorQuantity(Number(price) * 0.98, filters.pricePrecision);
  const preflight = await api.preflight(SYMBOL, {
    requiredMargin: budget, quantity, entryPrice: price, stopLoss,
    probePolicy: VST_BTC_HEDGE_LONG10_SHORT75_PROBE,
  });
  if (preflight.status !== "ready" || preflight.positionMode !== "HEDGE" ||
      preflight.checks.marginTypeIsolated !== true ||
      preflight.checks.leverageProbePolicy !== true ||
      preflight.checks.leverageLong10 !== true ||
      preflight.checks.leverageShort75 !== true ||
      preflight.checks.positionModeHedge !== true ||
      preflight.checks.symbolFlat !== true || preflight.checks.symbolOpenOrdersEmpty !== true ||
      preflight.stopRisk?.safe !== true ||
      preflight.checks.noPlannedTopUp !== true ||
      Number(preflight.plannedTopUpMargin ?? 0) !== 0 ||
      Number(quantity) * Number(price) / 10 > budget) {
    throw new Error(`entry_preflight_blocked:${(preflight.blockers ?? []).join(",")}`);
  }
  return {
    quote, filters, balance: balance.balance, budget, quantity, price, stopLoss, preflight,
  };
}

async function getEntryOrder(api, state) {
  const history = await api.queryOrderHistory(SYMBOL, {
    startTs: Math.max(1, state.createdAt - 60_000), endTs: Date.now(),
  });
  const rows = Array.isArray(history) ? history : history?.orders;
  if (!Array.isArray(rows)) throw new Error("entry_history_unavailable");
  const matches = rows.filter((row) => clientIdOf(row) === state.entry.clientOrderId);
  if (matches.length !== 1) throw new Error("entry_history_identity_unverified");
  return matches[0];
}

async function verifyEntryTradeEvidence(api, state) {
  const order = await getEntryOrder(api, state);
  const orderId = exactId(order);
  if (!orderId || order.symbol !== API_SYMBOL || order.side !== "BUY" ||
      order.positionSide !== "LONG" || order.status !== "FILLED" ||
      !sameDecimal(order.origQty, state.entry.quantity) ||
      !sameDecimal(order.executedQty, state.entry.quantity)) {
    throw new Error("entry_order_not_exactly_filled");
  }
  const fills = await api.queryFills(SYMBOL, {
    startTs: Math.max(1, state.createdAt - 60_000), endTs: Date.now(),
    orderId, currency: "VST",
  });
  if (!Array.isArray(fills) || !fills.length || fills.some((fill) =>
    fill.symbol !== API_SYMBOL || exactId(fill) !== orderId || fill.side !== "BUY" ||
    !/^\d+(?:\.\d+)?$/.test(String(fill.qty ?? fill.quantity ?? fill.volume)))) {
    throw new Error("entry_fills_unverified");
  }
  const fillSum = sumDecimals(fills.map((fill) =>
    fill.qty ?? fill.quantity ?? fill.volume));
  if (!sameDecimal(fillSum, state.entry.quantity)) throw new Error("entry_fill_quantity_mismatch");
  const position = oneLongPosition(await api.getPositions(SYMBOL));
  if (!sameDecimal(position.positionAmt, state.entry.quantity)) {
    throw new Error("entry_position_quantity_mismatch");
  }
  if (state.entry.orderId && state.entry.orderId !== orderId) {
    throw new Error("entry_response_order_identity_mismatch");
  }
  return {
    orderId,
    positionId: posId(position),
    quantity: String(position.positionAmt),
    fillsVerified: true,
    orderHistoryVerified: true,
    positionVerified: true,
  };
}

async function verifyEntry(api, state) {
  const tradeProof = await verifyEntryTradeEvidence(api, state);
  const orders = await api.getOpenOrders(SYMBOL);
  const stops = orders.filter((row) => row.type === "STOP_MARKET" && row.side === "SELL");
  if (orders.length !== 1 || stops.length !== 1 ||
      stops[0].status !== "NEW" || stops[0].positionSide !== "LONG" ||
      posId(stops[0]) !== tradeProof.positionId ||
      !sameDecimal(stops[0].origQty, tradeProof.quantity) ||
      !sameDecimal(stops[0].stopPrice, state.entry.stopPrice) ||
      stops[0].workingType !== "MARK_PRICE" ||
      !explicitParentIdsMatch(stops[0], tradeProof.orderId)) {
    throw new Error("attached_child_stop_unverified");
  }
  const stopOrderId = exactId(stops[0]);
  if (!stopOrderId) throw new Error("attached_child_stop_id_unverified");
  return {
    ...tradeProof,
    stopOrderId,
    childStopVerified: true,
  };
}

function verifyFlatBtcSnapshot(positions) {
  if (!Array.isArray(positions) || positions.some((row) =>
    !row || typeof row.symbol !== "string")) {
    throw new Error("close_reconcile_positions_unverified");
  }
  const btcPositions = positions.filter((row) => row.symbol === API_SYMBOL);
  for (const row of btcPositions) {
    if (!/^-?\d+(?:\.\d+)?$/.test(String(row.positionAmt)) ||
        !["LONG", "SHORT", "BOTH"].includes(row.positionSide) ||
        Number(row.positionAmt) !== 0) {
      throw new Error("close_reconcile_residual_or_ambiguous_btc_position");
    }
  }
  return btcPositions.length;
}

function persistedOriginalStopLinkage(state, stopId, positionId, quantity) {
  const entry = state.entry;
  const proof = entry?.reconciliation;
  if (entry?.stopOrderId !== stopId ||
      proof?.status !== "verified_position_and_visible_stop" ||
      proof?.attachedStopObservation !== "visible_new_matching_position" ||
      proof.positionId !== positionId || !sameDecimal(proof.quantity, quantity) ||
      !sameDecimal(entry.verifiedPositionQuantity ?? entry.quantity, quantity) ||
      !/^\d+(?:\.\d+)?$/.test(String(entry.stopPrice))) {
    return false;
  }
  if (!proof.attachedStopEvidence) {
    // Earlier durable states set this observation only after matching the
    // visible NEW stop to the persisted position identity, size, and price.
    return true;
  }
  const attached = proof.attachedStopEvidence;
  return attached.orderId === stopId && attached.positionId === positionId &&
    attached.status === "NEW" && attached.type === "STOP_MARKET" &&
    attached.side === "SELL" && attached.positionSide === "LONG" &&
    attached.workingType === "MARK_PRICE" &&
    sameDecimal(attached.quantity, quantity) &&
    sameDecimal(attached.stopPrice, entry.stopPrice);
}

function requirePersistedEntryProtectionEvidence(state) {
  const entry = state.entry;
  const proof = entry?.reconciliation;
  const quantity = entry?.verifiedPositionQuantity ?? proof?.quantity;
  if (state.status !== "entry_position_reconciled_stop_unknown" ||
      typeof entry?.clientOrderId !== "string" ||
      typeof entry.orderId !== "string" || !entry.orderId ||
      typeof entry.positionId !== "string" || !entry.positionId ||
      typeof entry.stopOrderId !== "string" || !entry.stopOrderId ||
      entry.positionMode !== "HEDGE" ||
      proof?.status !== "verified_position_and_visible_stop" ||
      proof.attachedStopObservation !== "visible_new_matching_position" ||
      proof.fillsVerified !== true || proof.orderHistoryVerified !== true ||
      proof.positionVerified !== true || proof.orderId !== entry.orderId ||
      proof.positionId !== entry.positionId || !quantity ||
      !sameDecimal(proof.quantity, quantity) ||
      !sameDecimal(entry.quantity, quantity) ||
      !persistedOriginalStopLinkage(state, entry.stopOrderId, entry.positionId, quantity)) {
    throw new Error("entry_protection_requires_persisted_exact_entry_and_visible_stop_evidence");
  }
  return { positionId: entry.positionId, stopId: entry.stopOrderId, quantity };
}

async function collectEntryProtectionSnapshot(api, state, expected) {
  const [positions, orders] = await Promise.all([
    api.getPositions(SYMBOL),
    api.getOpenOrders(SYMBOL),
  ]);
  const position = oneLongPosition(positions);
  if (posId(position) !== expected.positionId ||
      !sameDecimal(position.positionAmt, expected.quantity)) {
    throw new Error("entry_protection_position_changed_or_ambiguous");
  }
  if (!Array.isArray(orders) || orders.length !== 1 ||
      !verifyStop(orders[0], {
        id: expected.stopId,
        positionId: expected.positionId,
        quantity: expected.quantity,
        stopPrice: state.entry.stopPrice,
      }) || !explicitParentIdsMatch(orders[0], state.entry.orderId)) {
    throw new Error("entry_protection_exact_stop_not_active_or_competing_order_present");
  }
  return {
    observedAt: Date.now(),
    positionId: posId(position),
    quantity: String(position.positionAmt),
    stopOrderId: exactId(orders[0]),
    stopPrice: String(orders[0].stopPrice),
    status: orders[0].status,
    type: orders[0].type,
    side: orders[0].side,
    positionSide: orders[0].positionSide,
    workingType: orders[0].workingType,
    openOrderCount: orders.length,
  };
}

function requirePersistedCloseArchiveProof(state) {
  const close = state.emergencyClose;
  const proof = close?.reconciliation;
  const first = proof?.firstSnapshot;
  const second = proof?.secondSnapshot;
  const quantity = close?.quantity;
  if (state.status !== "emergency_close_verified_closed" ||
      proof?.status !== "verified_closed" ||
      typeof close?.clientOrderId !== "string" ||
      typeof close.orderId !== "string" || close.orderId !== first?.orderId ||
      close.orderId !== second?.orderId || !state.entry?.positionId ||
      close.positionId && close.positionId !== state.entry.positionId ||
      first?.positionId !== state.entry.positionId ||
      second?.positionId !== state.entry.positionId ||
      !quantity || !sameDecimal(first?.quantity, quantity) ||
      !sameDecimal(second?.quantity, quantity) ||
      first?.originalStopId !== state.entry.stopOrderId ||
      second?.originalStopId !== state.entry.stopOrderId ||
      first?.closeFillsVerified !== true || second?.closeFillsVerified !== true ||
      first?.originalStopCanceledNoFills !== true ||
      second?.originalStopCanceledNoFills !== true ||
      first?.flatBtcPositionRows !== 0 || second?.flatBtcPositionRows !== 0 ||
      first?.openOrdersEmpty !== true || second?.openOrdersEmpty !== true ||
      !Number.isFinite(Number(proof.separationMs)) ||
      Number(proof.separationMs) < 10_000 ||
      !Number.isSafeInteger(first?.observedAt) ||
      !Number.isSafeInteger(second?.observedAt) ||
      second.observedAt - first.observedAt < 10_000) {
    throw new Error("archive_closed_requires_exact_persisted_two_snapshot_close_proof");
  }
  return { orderId: close.orderId, positionId: state.entry.positionId, quantity };
}

function requireUnknownEntryForNoFillArchive(state, operatorConfirmed, now = Date.now()) {
  const recordedAttempt = state?.entry?.attemptStartedAt;
  const hasRecordedAttempt = recordedAttempt !== undefined && recordedAttempt !== null;
  const attemptStartedAt = hasRecordedAttempt ? Number(recordedAttempt) : Number(state?.createdAt);
  const proof = state?.entry?.reconciliation;
  const hasVerifiedEntryEvidence = state?.entry?.verifiedPositionQuantity !== undefined ||
    proof?.fillsVerified === true || proof?.orderHistoryVerified === true ||
    proof?.positionVerified === true || proof?.status?.startsWith("verified_position");
  if (operatorConfirmed !== true) throw new Error("confirmation_required");
  if (state?.environment !== "vst" || state?.symbol !== SYMBOL ||
      state?.status !== "entry_unknown_halt_no_retry" ||
      typeof state?.entry?.clientOrderId !== "string" ||
      !/^[A-Za-z0-9_-]{1,32}$/.test(state.entry.clientOrderId) ||
      (hasRecordedAttempt && (!Number.isSafeInteger(attemptStartedAt) ||
        attemptStartedAt <= 0)) ||
      !Number.isSafeInteger(attemptStartedAt) || attemptStartedAt <= 0 ||
      hasVerifiedEntryEvidence) {
    throw new Error("archive_no_fill_requires_unverified_persisted_entry_intent");
  }
  const requiredHistoryMs = MIN_NO_FILL_ARCHIVE_HISTORY_MS +
    (hasRecordedAttempt ? 0 : LEGACY_ATTEMPT_TIMESTAMP_GRACE_MS);
  if (now - attemptStartedAt < requiredHistoryMs) {
    throw new Error("archive_no_fill_history_window_too_short");
  }
  if (now - attemptStartedAt < MIN_RECEIVE_WINDOW_MS) {
    throw new Error("archive_no_fill_receive_window_not_elapsed");
  }
  return {
    attemptStartedAt,
    historyStartTs: Math.max(1, attemptStartedAt - 60_000),
    clientOrderId: state.entry.clientOrderId,
  };
}

async function collectNoFillArchiveObservation(api, state, evidence) {
  let orderNotFound = false;
  try {
    const order = await api.queryOrder(SYMBOL, {
      clientOrderId: evidence.clientOrderId,
    });
    if (order !== null && order !== undefined) {
      throw new Error("archive_no_fill_order_lookup_found");
    }
  } catch (error) {
    if (error?.code === 109421 || error?.code === "109421") {
      if (error?.transportStage !== "exchange_response") {
        throw new Error("archive_no_fill_order_not_found_unrecognized");
      }
      orderNotFound = true;
    } else if (/^archive_no_fill_/.test(error?.message ?? "")) {
      throw error;
    } else {
      throw new Error("archive_no_fill_evidence_unavailable");
    }
  }
  if (!orderNotFound) throw new Error("archive_no_fill_order_not_found_unrecognized");

  const [initialPositions, initialOrders] = await Promise.all([
    api.getPositions(SYMBOL),
    api.getOpenOrders(SYMBOL),
  ]);
  verifyFlatBtcSnapshot(initialPositions);
  if (!Array.isArray(initialOrders) || initialOrders.length !== 0) {
    throw new Error("archive_no_fill_btc_not_flat_or_has_open_orders");
  }

  const endTs = Date.now();
  const [history, vstFills, usdtFills] = await Promise.all([
    api.queryOrderHistory(SYMBOL, {
      startTs: evidence.historyStartTs,
      endTs,
    }),
    api.queryFills(SYMBOL, {
      startTs: evidence.historyStartTs, endTs, currency: "VST",
    }),
    api.queryFills(SYMBOL, {
      startTs: evidence.historyStartTs, endTs, currency: "USDT",
    }),
  ]);
  const historyRows = Array.isArray(history) ? history : history?.orders;
  if (!Array.isArray(historyRows) || historyRows.length >= 500 ||
      evidence.historyStartTs >= evidence.attemptStartedAt || historyRows.some((row) =>
    !row || typeof row !== "object" || Array.isArray(row) ||
    row.symbol !== API_SYMBOL || clientIdOf(row) === null)) {
    throw new Error("archive_no_fill_order_history_invalid");
  }
  if (historyRows.some((row) => clientIdOf(row) === evidence.clientOrderId)) {
    throw new Error("archive_no_fill_client_order_id_found");
  }
  if (!Array.isArray(vstFills) || !Array.isArray(usdtFills) ||
      vstFills.length !== 0 || usdtFills.length !== 0) {
    throw new Error("archive_no_fill_btc_fills_found_or_unknown");
  }

  const [finalPositions, finalOrders] = await Promise.all([
    api.getPositions(SYMBOL),
    api.getOpenOrders(SYMBOL),
  ]);
  verifyFlatBtcSnapshot(finalPositions);
  if (!Array.isArray(finalOrders) || finalOrders.length !== 0) {
    throw new Error("archive_no_fill_btc_not_flat_or_has_open_orders");
  }
  return {
    observedAt: Date.now(),
    attemptStartedAt: evidence.attemptStartedAt,
    allOrdersWindowStart: evidence.historyStartTs,
    allOrdersWindowEnd: endTs,
    clientOrderId: evidence.clientOrderId,
    signedOrderLookupNotFoundCode: "109421",
    clientOrderIdAbsentFromAllOrders: true,
    zeroBtcFillsVst: true,
    zeroBtcFillsUsdt: true,
    flatBtcBeforeAndAfterHistory: true,
    noOpenOrdersBeforeAndAfterHistory: true,
  };
}

async function collectCloseReconciliationSnapshot(api, state) {
  const close = state.emergencyClose;
  const positionId = state.entry?.positionId;
  const previousStopId = state.entry?.stopOrderId;
  const startedAt = Number(close?.startedAt);
  if (!positionId || (close?.positionId !== undefined && close.positionId !== positionId) ||
      typeof close?.clientOrderId !== "string" ||
      !/^[A-Za-z0-9_-]{1,32}$/.test(close.clientOrderId) ||
      !/^\d+(?:\.\d+)?$/.test(String(close.quantity)) ||
      !previousStopId || !Number.isSafeInteger(startedAt) || startedAt <= 0) {
    throw new Error("close_reconcile_persisted_identity_invalid");
  }
  const priorQuantity = state.entry.reconciliation?.quantity ??
    state.entry.verifiedPositionQuantity ?? state.entry.quantity;
  if (!priorQuantity || !sameDecimal(close.quantity, priorQuantity)) {
    throw new Error("close_reconcile_quantity_not_bound_to_verified_position");
  }

  const [history, positions, openOrders, previousStop, previousStopFills] =
    await Promise.all([
      api.queryOrderHistory(SYMBOL, {
        startTs: Math.max(1, startedAt - 60_000), endTs: Date.now(),
      }),
      api.getPositions(SYMBOL),
      api.getOpenOrders(SYMBOL),
      api.queryOrder(SYMBOL, { orderId: previousStopId }),
      api.queryFills(SYMBOL, {
        startTs: Math.max(1, state.createdAt - 60_000), endTs: Date.now(),
        orderId: previousStopId, currency: "VST",
      }),
    ]);
  const historyRows = Array.isArray(history) ? history : history?.orders;
  if (!Array.isArray(historyRows)) throw new Error("close_reconcile_history_invalid");
  const historyMatches = historyRows.filter((row) =>
    clientIdOf(row) === close.clientOrderId);
  if (historyMatches.length !== 1) {
    throw new Error("close_reconcile_close_client_id_not_unique_in_history");
  }
  const historyOrder = historyMatches[0];
  const orderId = exactId(historyOrder);
  if (!orderId || historyOrder.symbol !== API_SYMBOL ||
      historyOrder.clientOrderId !== undefined &&
        historyOrder.clientOrderId !== close.clientOrderId ||
      historyOrder.clientOrderID !== undefined &&
        historyOrder.clientOrderID !== close.clientOrderId ||
      historyOrder.side !== "SELL" || historyOrder.positionSide !== "LONG" ||
      historyOrder.type !== "MARKET" || historyOrder.status !== "FILLED" ||
      !sameDecimal(historyOrder.origQty, close.quantity) ||
      !sameDecimal(historyOrder.executedQty, close.quantity) ||
      state.emergencyClose.orderId && state.emergencyClose.orderId !== orderId) {
    throw new Error("close_reconcile_history_order_mismatch");
  }
  const historyPositionId = historyOrder.positionId ?? historyOrder.positionID;
  if (historyPositionId !== undefined && historyPositionId !== null &&
      posId(historyOrder) !== positionId) {
    throw new Error("close_reconcile_history_position_id_mismatch");
  }

  const [order, closeFills] = await Promise.all([
    api.queryOrder(SYMBOL, { orderId }),
    api.queryFills(SYMBOL, {
      startTs: Math.max(1, startedAt - 60_000), endTs: Date.now(),
      orderId, currency: "VST",
    }),
  ]);
  const orderPositionId = order?.positionId ?? order?.positionID;
  if (exactId(order) !== orderId || order.symbol !== API_SYMBOL ||
      order.side !== "SELL" || order.positionSide !== "LONG" ||
      order.type !== "MARKET" || order.status !== "FILLED" ||
      !sameDecimal(order.origQty, close.quantity) ||
      !sameDecimal(order.executedQty, close.quantity) ||
      (orderPositionId !== undefined && orderPositionId !== null &&
        posId(order) !== positionId)) {
    throw new Error("close_reconcile_exact_order_read_mismatch");
  }
  if (!Array.isArray(closeFills) || !closeFills.length || closeFills.some((fill) =>
    fill.symbol !== API_SYMBOL || exactId(fill) !== orderId || fill.side !== "SELL" ||
    !/^\d+(?:\.\d+)?$/.test(String(fill.qty ?? fill.quantity ?? fill.volume)) ||
    ((fill.positionId ?? fill.positionID) !== undefined &&
      (fill.positionId ?? fill.positionID) !== null &&
      posId(fill) !== positionId))) {
    throw new Error("close_reconcile_fills_unverified");
  }
  const fillQuantity = sumDecimals(closeFills.map((fill) =>
    fill.qty ?? fill.quantity ?? fill.volume));
  if (!sameDecimal(fillQuantity, close.quantity)) {
    throw new Error("close_reconcile_fill_quantity_mismatch");
  }

  const stopPositionId = previousStop?.positionId ?? previousStop?.positionID;
  const stopHasPositionId = stopPositionId !== undefined && stopPositionId !== null;
  if (exactId(previousStop) !== previousStopId ||
      previousStop.symbol !== API_SYMBOL || previousStop.type !== "STOP_MARKET" ||
      !["CANCELED", "CANCELLED"].includes(previousStop.status) ||
      previousStop.side !== "SELL" ||
      previousStop.positionSide !== "LONG" ||
      (stopHasPositionId
        ? posId(previousStop) !== positionId
        : !persistedOriginalStopLinkage(state, previousStopId, positionId, close.quantity)) ||
      !sameDecimal(previousStop.origQty, close.quantity) ||
      !sameDecimal(previousStop.executedQty, "0") ||
      !sameDecimal(previousStop.stopPrice, state.entry.stopPrice) ||
      previousStop.workingType !== "MARK_PRICE" ||
      !Array.isArray(previousStopFills) || previousStopFills.length !== 0) {
    throw new Error("close_reconcile_original_stop_not_canceled_without_fills");
  }
  const btcPositionCount = verifyFlatBtcSnapshot(positions);
  if (!Array.isArray(openOrders) || openOrders.length !== 0) {
    throw new Error("close_reconcile_open_orders_not_empty");
  }
  return {
    observedAt: Date.now(),
    orderId,
    positionId,
    quantity: close.quantity,
    closeFillsVerified: true,
    originalStopId: previousStopId,
    originalStopCanceledNoFills: true,
    flatBtcPositionRows: btcPositionCount,
    openOrdersEmpty: true,
  };
}

function safeSummary(state) {
  let instruction;
  if (["entry_unknown_halt_no_retry", "entry_submitting",
    "entry_submitted_verifying"].includes(state?.status)) {
    instruction = "Do not retry entry. Run read-only reconcile-entry; only an independently verified position can be explicitly emergency-closed.";
  } else if (state?.status === "entry_position_reconciled_stop_unknown") {
    instruction = "Do not retry entry. Run read-only confirm-entry-protection; if confirmation fails, emergency-close remains available for the exact persisted position.";
  } else if (state?.status === "entry_unknown_halt_no_retry") {
    instruction = "Do not retry entry. Run read-only reconcile-entry first; operator-confirmed archive-no-fill requires at least two minutes and independent history, fills, flat-position, and no-order evidence.";
  } else if (state?.status === "add_stop_unknown_halt_no_retry") {
    instruction = "Do not retry the add-stop. Run read-only investigate-stop; if the verified position remains open, explicitly use emergency-close.";
  } else if (state?.status === "emergency_close_unknown_halt_no_retry") {
    instruction = "Do not retry the close. Run read-only reconcile-close; it requires exact history/fills, canceled original stop, and two flat snapshots at least 10 seconds apart.";
  } else if (state?.status === "emergency_close_verified_closed") {
    instruction = "Before starting another proof, run read-only archive-closed; it requires the persisted two-snapshot close proof and fresh flat/no-order checks.";
  }
  return {
    environment: "vst",
    symbol: SYMBOL,
    status: state?.status ?? "no_probe_state",
    entry: state?.entry ? {
      clientOrderId: state.entry.clientOrderId,
      quantity: state.entry.quantity,
      initialMarginBudgetVst: state.entry.initialMarginBudgetVst,
      initialMarginEstimateVst: state.entry.initialMarginEstimateVst,
      orderId: state.entry.orderId ?? null,
      positionId: state.entry.positionId ?? null,
      originalStopOrderId: state.entry.stopOrderId ?? null,
      preSignReason: state.status === "entry_unknown_halt_no_retry" &&
        ALLOWED_ENTRY_PRE_SIGN_REASONS.has(state.entry.preSignReason)
        ? state.entry.preSignReason : null,
    } : null,
    additionalStop: state?.addStop ? {
      stopPrice: state.addStop.stopPrice,
      orderId: state.addStop.orderId ?? null,
      status: state.addStop.status,
      observation: state.addStop.observation ?? null,
    } : null,
    recovery: state?.entry?.reconciliation ? {
      status: state.entry.reconciliation.status,
      positionId: state.entry.reconciliation.positionId,
      quantity: state.entry.reconciliation.quantity,
      attachedStopObservation: state.entry.reconciliation.attachedStopObservation ?? null,
    } : null,
    entryProtectionConfirmation: state?.entry?.protectionConfirmation ?? null,
    noFillArchive: state?.entry?.noFillArchive ?? null,
    emergencyClose: state?.emergencyClose ? {
      clientOrderId: state.emergencyClose.clientOrderId,
      quantity: state.emergencyClose.quantity,
      positionId: state.emergencyClose.positionId ?? null,
      orderId: state.emergencyClose.orderId ?? null,
      reconciliation: state.emergencyClose.reconciliation ?? null,
    } : null,
    safetyLimitations: SAFETY_LIMITATIONS,
    instruction,
  };
}

async function runProbeUnlocked({
  command, stopPrice, api, fetchImpl, statePath = DEFAULT_STATE_PATH,
  operatorConfirmed = false,
}) {
  if (command === "status") return safeSummary(await readState(statePath));
  if (command === "preview") {
    const plan = await entryPlan(api, fetchImpl);
    return {
      status: "ready_for_operator_review",
      environment: "vst",
      symbol: SYMBOL,
      positionMode: "HEDGE",
      marginMode: "ISOLATED",
      leverage: { long: 10, short: 75 },
      balanceSnapshotVst: plan.balance,
      initialMarginBudgetVst: plan.budget,
      initialMarginEstimateVst: Number(plan.quantity) * Number(plan.price) / 10,
      quantity: plan.quantity,
      maxEntryPrice: plan.price,
      entryStop: plan.stopLoss,
      safetyLimitations: SAFETY_LIMITATIONS,
      noWrites: true,
    };
  }
  const state = await readState(statePath);
  if (!state && command !== "enter") throw new Error("no_probe_state");

  if (command === "reconcile-entry") {
    if (!["entry_unknown_halt_no_retry", "entry_submitting",
      "entry_submitted_verifying"].includes(state.status)) {
      throw new Error("entry_reconcile_requires_unknown_or_interrupted_entry");
    }
    let tradeProof;
    try {
      tradeProof = await verifyEntryTradeEvidence(api, state);
    } catch (error) {
      state.entry.reconciliation = {
        status: "no_verified_position_evidence",
        observedAt: Date.now(),
        reason: String(error?.message ?? "read_failed").slice(0, 160),
      };
      await persistState(statePath, state);
      return safeSummary(state);
    }
    state.entry.orderId = tradeProof.orderId;
    state.entry.positionId = tradeProof.positionId;
    state.entry.verifiedPositionQuantity = tradeProof.quantity;
    state.entry.reconciliation = {
      ...tradeProof,
      status: "verified_position_stop_unverified",
      observedAt: Date.now(),
      attachedStopObservation: "not_checked",
    };
    state.status = "entry_position_reconciled_stop_unknown";
    // Commit independently verified order/fill/position evidence before the
    // optional stop read so a stop endpoint failure cannot block exact close.
    await persistState(statePath, state);
    try {
      const orders = await api.getOpenOrders(SYMBOL);
      const candidates = orders.filter((row) =>
        row.type === "STOP_MARKET" && row.side === "SELL" &&
        row.status === "NEW" && row.positionSide === "LONG" &&
        posId(row) === tradeProof.positionId &&
        sameDecimal(row.origQty, tradeProof.quantity) &&
        sameDecimal(row.stopPrice, state.entry.stopPrice) &&
        row.workingType === "MARK_PRICE" &&
        explicitParentIdsMatch(row, tradeProof.orderId));
      if (orders.length === 1 && candidates.length === 1 && exactId(candidates[0])) {
        const stop = candidates[0];
        state.entry.stopOrderId = exactId(stop);
        state.entry.reconciliation.status = "verified_position_and_visible_stop";
        state.entry.reconciliation.attachedStopObservation = "visible_new_matching_position";
        state.entry.reconciliation.attachedStopEvidence = {
          orderId: state.entry.stopOrderId,
          positionId: posId(stop),
          status: stop.status,
          type: stop.type,
          side: stop.side,
          positionSide: stop.positionSide,
          workingType: stop.workingType,
          quantity: String(stop.origQty),
          stopPrice: String(stop.stopPrice),
          observedAt: Date.now(),
        };
      } else {
        state.entry.reconciliation.attachedStopObservation =
          orders.length === 0 ? "no_open_stop_observed"
            : "missing_mismatched_or_competing_btc_orders";
      }
    } catch (error) {
      state.entry.reconciliation.attachedStopObservation =
        `open_order_read_failed:${String(error?.message ?? "unknown").slice(0, 120)}`;
    }
    await persistState(statePath, state);
    return safeSummary(state);
  }

  if (command === "investigate-stop") {
    if (state.status !== "add_stop_unknown_halt_no_retry" || !state.addStop) {
      throw new Error("stop_investigation_requires_unknown_add_stop");
    }
    const [positionsResult, ordersResult, historyResult] = await Promise.allSettled([
      api.getPositions(SYMBOL),
      api.getOpenOrders(SYMBOL),
      api.queryOrderHistory(SYMBOL, {
        startTs: Math.max(1, state.addStop.startedAt - 60_000), endTs: Date.now(),
      }),
    ]);
    const observation = { observedAt: Date.now(), status: "incomplete_read_only_observation" };
    if (positionsResult.status === "fulfilled" && ordersResult.status === "fulfilled") {
      try {
        const position = oneLongPosition(positionsResult.value);
        const orders = ordersResult.value;
        observation.positionId = posId(position);
        observation.quantity = String(position.positionAmt);
        if (posId(position) !== state.entry.positionId ||
            !sameDecimal(position.positionAmt, state.entry.verifiedPositionQuantity ??
              state.entry.quantity)) {
          observation.status = "unexpected_position_or_quantity";
        } else if (!Array.isArray(orders)) {
          observation.status = "open_orders_invalid";
        } else {
          const candidates = orders.filter((row) =>
            row.type === "STOP_MARKET" && row.side === "SELL" &&
            row.positionSide === "LONG" && row.status === "NEW" &&
            posId(row) === state.entry.positionId &&
            sameDecimal(row.origQty, position.positionAmt) &&
            sameDecimal(row.stopPrice, state.addStop.stopPrice) &&
            row.workingType === "MARK_PRICE");
          const foundId = candidates.length === 1 ? exactId(candidates[0]) : null;
          if (orders.length === 2 && foundId &&
              verifyStopCoexistence({
                orders, position, state, newStopId: foundId,
              })) {
            state.addStop.orderId = foundId;
            observation.status = "both_stops_visible_new_at_observation";
            observation.originalStopId = state.entry.stopOrderId;
            observation.additionalStopId = foundId;
          } else if (orders.length === 1 &&
              exactId(orders[0]) === state.entry.stopOrderId) {
            observation.status = "original_only_add_stop_not_observed";
          } else {
            observation.status = "unexpected_or_ambiguous_btc_open_orders";
            observation.openOrderCount = orders.length;
          }
        }
      } catch (error) {
        observation.status = String(error?.message ?? "position_or_order_read_invalid")
          .slice(0, 160);
      }
    } else {
      observation.readErrors = {
        positions: positionsResult.status === "rejected"
          ? String(positionsResult.reason?.message ?? "failed").slice(0, 120) : undefined,
        openOrders: ordersResult.status === "rejected"
          ? String(ordersResult.reason?.message ?? "failed").slice(0, 120) : undefined,
      };
    }
    if (historyResult.status === "fulfilled") {
      const rows = Array.isArray(historyResult.value)
        ? historyResult.value : historyResult.value?.orders;
      try {
        observation.historyRead = Array.isArray(rows)
          ? { rowCount: rows.length, stopRows: rows.filter((row) =>
            row.type === "STOP_MARKET" && row.side === "SELL" &&
            sameDecimal(row.stopPrice, state.addStop.stopPrice)).length }
          : { invalid: true };
      } catch {
        observation.historyRead = { invalid: true };
      }
    } else {
      observation.historyRead = { failed: true };
    }
    state.addStop.observation = observation;
    // Investigation never converts an unknown write into a retryable intent.
    state.status = "add_stop_unknown_halt_no_retry";
    await persistState(statePath, state);
    return safeSummary(state);
  }

  if (command === "enter") {
    if (state) throw new Error("existing_state_blocks_new_entry");
    const plan = await entryPlan(api, fetchImpl);
    const id = clientOrderId("vse");
    const created = {
      version: 1,
      environment: "vst",
      symbol: SYMBOL,
      createdAt: Date.now(),
      status: "entry_submitting",
      entry: {
        clientOrderId: id,
        quantity: plan.quantity,
        maxEntryPrice: plan.price,
        stopPrice: plan.stopLoss,
        positionMode: "HEDGE",
        balanceSnapshotVst: plan.balance,
        initialMarginBudgetVst: plan.budget,
        initialMarginEstimateVst: Number(plan.quantity) * Number(plan.price) / 10,
      },
    };
    await persistState(statePath, created, { exclusive: true });
    try {
      fetchImpl?.authorize?.({
        clientOrderId: id,
        expectedQuantity: plan.quantity,
        expectedPrice: plan.price,
        expectedPricePrecision: plan.filters.pricePrecision,
        expectedEntryStop: plan.stopLoss,
        onAttemptStarted: async (timestamp) => {
          if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
            throw new Error("entry_attempt_timestamp_invalid");
          }
          created.entry.attemptStartedAt = timestamp;
          await persistState(statePath, created);
        },
      });
      const response = await api.placeVstOnePercentBoundedLong({
        symbol: SYMBOL, quantity: plan.quantity, maxPrice: plan.price,
        stopLoss: plan.stopLoss, clientOrderId: id,
        probePolicy: VST_BTC_HEDGE_LONG10_SHORT75_PROBE,
      });
      created.entry.orderId = exactId(response);
      created.status = "entry_submitted_verifying";
      await persistState(statePath, created);
      const proof = await verifyEntry(api, created);
      if (created.entry.orderId && created.entry.orderId !== proof.orderId) {
        throw new Error("entry_response_order_identity_mismatch");
      }
      Object.assign(created.entry, proof);
      created.status = "entry_verified";
      await persistState(statePath, created);
      return safeSummary(created);
    } catch (error) {
      created.status = "entry_unknown_halt_no_retry";
      created.error = String(error?.message ?? "unknown").slice(0, 180);
      if (error?.transportStage === "pre_transport" &&
          ALLOWED_ENTRY_PRE_SIGN_REASONS.has(error?.preSignReason)) {
        created.entry.preSignReason = error.preSignReason;
      }
      await persistState(statePath, created);
      return safeSummary(created);
    }
  }
  if (!state) throw new Error("no_probe_state");

  if (command === "archive-no-fill") {
    const evidence = requireUnknownEntryForNoFillArchive(
      state, operatorConfirmed, Date.now(),
    );
    let firstObservation;
    let secondObservation;
    let separatedBy;
    try {
      firstObservation = await collectNoFillArchiveObservation(api, state, evidence);
      state.entry.noFillArchive = {
        status: "first_observation_verified_waiting",
        operatorConfirmed: true,
        firstObservation,
        minimumObservationSeparationMs: NO_FILL_ARCHIVE_OBSERVATION_DELAY_MS,
      };
      await persistState(statePath, state);
      const delayStarted = performance.now();
      await delay(NO_FILL_ARCHIVE_OBSERVATION_DELAY_MS);
      separatedBy = performance.now() - delayStarted;
      if (separatedBy < NO_FILL_ARCHIVE_OBSERVATION_DELAY_MS) {
        throw new Error("archive_no_fill_observations_too_close");
      }
      secondObservation = await collectNoFillArchiveObservation(api, state, evidence);
      if (secondObservation.clientOrderId !== firstObservation.clientOrderId ||
          secondObservation.allOrdersWindowStart !== firstObservation.allOrdersWindowStart ||
          secondObservation.observedAt - firstObservation.observedAt <
            NO_FILL_ARCHIVE_OBSERVATION_DELAY_MS) {
        throw new Error("archive_no_fill_observations_disagree_or_too_close");
      }
    } catch (error) {
      state.entry.noFillArchive = {
        status: "rejected",
        operatorConfirmed: true,
        ...(firstObservation ? { firstObservation } : {}),
        observedAt: Date.now(),
        reason: String(error?.message ?? "read_failed").slice(0, 180),
      };
      await persistState(statePath, state);
      throw new Error(`archive_no_fill_rejected:${String(error?.message ?? "read_failed")}`);
    }
    state.status = "archived_no_fill_operator_verified";
    state.entry.noFillArchive = {
      status: "verified",
      operatorConfirmed: true,
      firstObservation,
      secondObservation,
      separationMs: Math.floor(separatedBy),
      attemptStartedAt: evidence.attemptStartedAt,
      historyWindowStart: evidence.historyStartTs,
    };
    await persistState(statePath, state);
    const archiveDirectory = `${statePath}.archive-no-fill-${Date.now()}-${randomUUID()}`;
    await mkdir(archiveDirectory);
    await syncDirectory(dirname(archiveDirectory));
    const archivePath = resolve(archiveDirectory, basename(statePath));
    await rename(statePath, archivePath);
    await syncDirectory(archiveDirectory);
    await syncDirectory(dirname(statePath));
    return { ...safeSummary(state), status: state.status, archivePath };
  }

  if (command === "confirm-entry-protection") {
    const expected = requirePersistedEntryProtectionEvidence(state);
    let firstSnapshot;
    try {
      firstSnapshot = await collectEntryProtectionSnapshot(api, state, expected);
      state.entry.protectionConfirmation = {
        status: "first_snapshot_verified_waiting",
        firstSnapshot,
        minimumSnapshotSeparationMs: 10_000,
      };
      await persistState(statePath, state);
      const delayStarted = performance.now();
      // Allow for millisecond clock granularity and scheduler jitter so a
      // nominal ten-second delay cannot fail the independent-snapshot gate.
      await delay(10_250);
      const separatedBy = performance.now() - delayStarted;
      if (separatedBy < 10_000) {
        throw new Error("entry_protection_second_snapshot_too_early");
      }
      const secondSnapshot = await collectEntryProtectionSnapshot(api, state, expected);
      if (secondSnapshot.positionId !== firstSnapshot.positionId ||
          !sameDecimal(secondSnapshot.quantity, firstSnapshot.quantity) ||
          secondSnapshot.stopOrderId !== firstSnapshot.stopOrderId ||
          secondSnapshot.stopPrice !== firstSnapshot.stopPrice) {
        throw new Error("entry_protection_independent_snapshots_disagree");
      }
      state.entry.protectionConfirmation = {
        status: "verified",
        firstSnapshot,
        secondSnapshot,
        separationMs: Math.floor(separatedBy),
      };
      state.status = "entry_verified";
      await persistState(statePath, state);
      return safeSummary(state);
    } catch (error) {
      state.entry.protectionConfirmation = {
        status: "rejected",
        ...(firstSnapshot ? { firstSnapshot } : {}),
        observedAt: Date.now(),
        reason: String(error?.message ?? "read_failed").slice(0, 180),
      };
      await persistState(statePath, state);
      throw new Error(`entry_protection_confirmation_rejected:${String(error?.message ?? "read_failed")}`);
    }
  }

  if (command === "archive-closed") {
    const closeProof = requirePersistedCloseArchiveProof(state);
    let firstSnapshot;
    let secondSnapshot;
    let separatedBy;
    try {
      const collect = async () => {
        const [positions, orders] = await Promise.all([
          api.getPositions(SYMBOL),
          api.getOpenOrders(SYMBOL),
        ]);
        const flatBtcPositionRows = verifyFlatBtcSnapshot(positions);
        if (!Array.isArray(orders) || orders.length !== 0) {
          throw new Error("archive_closed_btc_open_orders_not_empty");
        }
        return {
          observedAt: Date.now(),
          flatBtcPositionRows,
          openOrdersEmpty: true,
        };
      };
      firstSnapshot = await collect();
      state.archiveClosed = {
        status: "first_fresh_snapshot_verified_waiting",
        firstSnapshot,
        minimumSnapshotSeparationMs: 10_000,
      };
      await persistState(statePath, state);
      const delayStarted = performance.now();
      await delay(10_000);
      separatedBy = performance.now() - delayStarted;
      if (separatedBy < 10_000) {
        throw new Error("archive_closed_second_snapshot_too_early");
      }
      secondSnapshot = await collect();
    } catch (error) {
      state.archiveClosed = {
        status: "rejected",
        ...(firstSnapshot ? { firstSnapshot } : {}),
        observedAt: Date.now(),
        reason: String(error?.message ?? "read_failed").slice(0, 180),
      };
      await persistState(statePath, state);
      throw new Error(`archive_closed_rejected:${String(error?.message ?? "read_failed")}`);
    }
    state.archiveClosed = {
      status: "verified",
      closeClientOrderId: state.emergencyClose.clientOrderId,
      closeOrderId: closeProof.orderId,
      positionId: closeProof.positionId,
      quantity: closeProof.quantity,
      firstSnapshot,
      secondSnapshot,
      separationMs: Math.floor(separatedBy),
    };
    await persistState(statePath, state);
    const archiveDirectory = `${statePath}.archive-${Date.now()}-${randomUUID()}`;
    await mkdir(archiveDirectory);
    await syncDirectory(dirname(archiveDirectory));
    const archivePath = resolve(archiveDirectory, basename(statePath));
    await rename(statePath, archivePath);
    await syncDirectory(archiveDirectory);
    await syncDirectory(dirname(statePath));
    return { ...safeSummary(state), status: "archived_closed", archivePath };
  }

  if (command === "reconcile-close") {
    if (state.status !== "emergency_close_unknown_halt_no_retry" || !state.emergencyClose) {
      throw new Error("close_reconcile_requires_unknown_emergency_close");
    }
    let firstSnapshot;
    try {
      firstSnapshot = await collectCloseReconciliationSnapshot(api, state);
      state.emergencyClose.reconciliation = {
        status: "first_snapshot_verified_waiting",
        firstSnapshot,
        minimumSnapshotSeparationMs: 10_000,
      };
      await persistState(statePath, state);

      const delayStarted = performance.now();
      await delay(10_000);
      const separatedBy = performance.now() - delayStarted;
      if (separatedBy < 10_000) {
        throw new Error("close_reconcile_second_snapshot_too_early");
      }
      const secondSnapshot = await collectCloseReconciliationSnapshot(api, state);
      if (secondSnapshot.orderId !== firstSnapshot.orderId ||
          secondSnapshot.positionId !== firstSnapshot.positionId ||
          !sameDecimal(secondSnapshot.quantity, firstSnapshot.quantity) ||
          secondSnapshot.originalStopId !== firstSnapshot.originalStopId) {
        throw new Error("close_reconcile_independent_snapshots_disagree");
      }
      state.emergencyClose.orderId = secondSnapshot.orderId;
      state.emergencyClose.reconciliation = {
        status: "verified_closed",
        firstSnapshot,
        secondSnapshot,
        separationMs: Math.floor(separatedBy),
      };
      state.status = "emergency_close_verified_closed";
      await persistState(statePath, state);
      return safeSummary(state);
    } catch (error) {
      state.emergencyClose.reconciliation = {
        status: "rejected",
        ...(firstSnapshot ? { firstSnapshot } : {}),
        observedAt: Date.now(),
        reason: String(error?.message ?? "read_failed").slice(0, 180),
      };
      await persistState(statePath, state);
      throw new Error(`close_reconcile_rejected:${String(error?.message ?? "read_failed")}`);
    }
  }

  if (command === "add-stop") {
    if (state.status !== "entry_verified") {
      throw new Error("add_stop_requires_verified_entry; unknown stages are never retried");
    }
    const [positions, orders, market, marginType, leverage, mode] = await Promise.all([
      api.getPositions(SYMBOL), api.getOpenOrders(SYMBOL), api.getVstMarkPrice(SYMBOL),
      api.getMarginType(SYMBOL), api.getLeverage(SYMBOL), api.getPositionMode(),
    ]);
    const position = oneLongPosition(positions);
    const original = orders.filter((row) => exactId(row) === state.entry.stopOrderId);
    if (mode !== "HEDGE" || marginType !== "ISOLATED" ||
        leverage.longLeverage !== 10 || leverage.shortLeverage !== 75 ||
        posId(position) !== state.entry.positionId ||
        orders.length !== 1 || original.length !== 1 ||
        !verifyStop(original[0], {
          id: state.entry.stopOrderId, positionId: state.entry.positionId,
          quantity: position.positionAmt, stopPrice: state.entry.stopPrice,
        }) || !sameDecimal(position.positionAmt, state.entry.quantity)) {
      throw new Error("add_stop_preflight_position_or_original_stop_invalid");
    }
    const markTime = marketTimestamp(market.timestamp);
    if (!Number.isFinite(Number(market.markPrice)) || Number(market.markPrice) <= 0 ||
        markTime === null || Date.now() - markTime > MAX_QUOTE_AGE_MS ||
        markTime > Date.now() + 2_000 ||
        compareDecimal(stopPrice, state.entry.stopPrice) <= 0 ||
        compareDecimal(stopPrice, String(market.markPrice)) >= 0) {
      throw new Error("additional_stop_must_be_higher_than_original_and_below_fresh_mark");
    }
    const intent = clientOrderId("vss");
    state.status = "add_stop_submitting";
    state.addStop = {
      stopPrice,
      quantity: String(position.positionAmt),
      intentId: intent,
      status: "submitting",
      startedAt: Date.now(),
    };
    await persistState(statePath, state);
    try {
      fetchImpl?.authorize?.({
        expectedQuantity: String(position.positionAmt),
        expectedStopPrice: stopPrice,
        expectedPositionId: state.entry.positionId,
      });
      const response = await api.placeVstAdditionalLongStop({
        symbol: SYMBOL,
        quantity: String(position.positionAmt),
        stopPrice,
        positionId: state.entry.positionId,
        previousStopOrderId: state.entry.stopOrderId,
        previousStopPrice: state.entry.stopPrice,
        probePolicy: VST_BTC_HEDGE_LONG10_SHORT75_PROBE,
      });
      const newStopId = exactId(response);
      if (!newStopId) throw new Error("new_stop_response_id_unverified");
      state.addStop.orderId = newStopId;
      const [afterPositions, afterOrders] = await Promise.all([
        api.getPositions(SYMBOL), api.getOpenOrders(SYMBOL),
      ]);
      const afterPosition = oneLongPosition(afterPositions);
      if (!verifyStopCoexistence({
        orders: afterOrders, position: afterPosition, state, newStopId,
      })) throw new Error("stop_coexistence_not_verified");
      state.addStop.status = "both_observed_new_one_snapshot";
      state.status = "both_stops_observed_new_once_linkage_risk_remains";
      await persistState(statePath, state);
      return safeSummary(state);
    } catch (error) {
      state.addStop.status = "unknown_halt";
      state.addStop.error = String(error?.message ?? "unknown").slice(0, 180);
      state.status = "add_stop_unknown_halt_no_retry";
      await persistState(statePath, state);
      return safeSummary(state);
    }
  }

  if (command === "emergency-close") {
    const reconciledQuantity = state.entry?.reconciliation?.status?.startsWith("verified_position")
      ? state.entry.reconciliation.quantity : null;
    const verifiedQuantity = reconciledQuantity ??
      (["entry_verified", "both_stops_observed_new_once_linkage_risk_remains",
        "add_stop_unknown_halt_no_retry"]
        .includes(state.status) ? state.entry?.verifiedPositionQuantity ?? state.entry?.quantity : null);
    if (!state.entry?.positionId || !state.entry?.quantity ||
        !["entry_verified", "both_stops_observed_new_once_linkage_risk_remains",
          "add_stop_unknown_halt_no_retry",
          "entry_position_reconciled_stop_unknown"].includes(state.status) ||
        !verifiedQuantity) {
      throw new Error("emergency_close_requires_persisted_verified_position_identity");
    }
    const [positions, marginType, mode] = await Promise.all([
      api.getPositions(SYMBOL), api.getMarginType(SYMBOL), api.getPositionMode(),
    ]);
    const position = oneLongPosition(positions);
    if (posId(position) !== state.entry.positionId ||
        !sameDecimal(position.positionAmt, verifiedQuantity) ||
        mode !== "HEDGE" || marginType !== "ISOLATED") {
      throw new Error("emergency_close_exact_position_preflight_failed");
    }
    const quantity = String(position.positionAmt);
    const id = clientOrderId("vsc");
    state.status = "emergency_close_submitting";
    state.emergencyClose = {
      clientOrderId: id, quantity, positionId: state.entry.positionId, startedAt: Date.now(),
    };
    await persistState(statePath, state);
    try {
      fetchImpl?.authorize?.({ clientOrderId: id, expectedQuantity: quantity });
      const response = await api.emergencyCloseVstLong({
        symbol: SYMBOL,
        quantity,
        clientOrderId: id,
        expectedPositionId: state.entry.positionId,
      });
      const responseId = exactId(response);
      const order = responseId ? await api.queryOrder(SYMBOL, { orderId: responseId }) : null;
      const fills = responseId ? await api.queryFills(SYMBOL, {
        startTs: Math.max(1, state.emergencyClose.startedAt - 60_000),
        endTs: Date.now(), orderId: responseId, currency: "VST",
      }) : [];
      const [afterPositions, afterOrders] = await Promise.all([
        api.getPositions(SYMBOL), api.getOpenOrders(SYMBOL),
      ]);
      const btcPositions = afterPositions.filter((row) => row?.symbol === API_SYMBOL);
      const flat = btcPositions.every((row) => Number(row.positionAmt) === 0);
      const fillQuantity = sumDecimals(fills.map((fill) =>
        fill.qty ?? fill.quantity ?? fill.volume));
      if (!order || order.symbol !== API_SYMBOL || order.side !== "SELL" ||
          order.positionSide !== "LONG" || order.status !== "FILLED" ||
          !sameDecimal(order.origQty, quantity) || !sameDecimal(order.executedQty, quantity) ||
          !fills.length || fills.some((fill) => fill.symbol !== API_SYMBOL ||
            exactId(fill) !== responseId || fill.side !== "SELL") ||
          !sameDecimal(fillQuantity, quantity) || !flat || afterOrders.length !== 0) {
        throw new Error("emergency_close_independent_verification_failed");
      }
      state.emergencyClose.orderId = responseId;
      state.status = "emergency_close_verified_flat";
      await persistState(statePath, state);
      return safeSummary(state);
    } catch (error) {
      state.status = "emergency_close_unknown_halt_no_retry";
      state.emergencyClose.error = String(error?.message ?? "unknown").slice(0, 180);
      await persistState(statePath, state);
      return safeSummary(state);
    }
  }
  throw new Error("invalid_command");
}

export async function runProbe(args) {
  const release = await acquireLock();
  try {
    return await runProbeUnlocked(args);
  } finally {
    await release();
  }
}

export async function runCli(argv, dependencies = {}) {
  const options = parseOptions(argv);
  const stage = options.command === "enter" ? "entry"
    : options.command === "add-stop" ? "add-stop"
      : options.command === "emergency-close" ? "emergency-close" : "read-only";
  const { api, guardedFetch } = dependencies.api
    ? { api: dependencies.api, guardedFetch: dependencies.fetchImpl }
    : makeApi(stage, dependencies.guardOptions, dependencies.fetchImpl ?? globalThis.fetch);
  const result = await runProbe({
    command: options.command,
    stopPrice: options.stopPrice,
    api,
    fetchImpl: guardedFetch,
    statePath: dependencies.statePath ?? DEFAULT_STATE_PATH,
    operatorConfirmed: options.operatorConfirmed,
  });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    console.error(error?.message ?? "probe_failed");
    process.exitCode = 1;
  });
}