#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BingXLiveApiError,
  createBingXLiveApi,
  VST_BTC_HEDGE_LONG10_SHORT75_PROBE,
} from "../artifacts/api-server/src/bullet-bot/bingx-live-api.mjs";

const HOST = "https://open-api-vst.bingx.com";
const ORDER_PATH = "/openApi/swap/v2/trade/order";
const SYMBOL = "BTCUSDT";
const API_SYMBOL = "BTC-USDT";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, ".local/vst-btc-virtual-split-stop-state.json");
const LOCK_PATH = resolve(ROOT, ".local/vst-btc-operations.lock");
const SIGNED = ["recvWindow", "timestamp", "signature"];
const NO_FILL_ARCHIVE_MIN_SNAPSHOT_INTERVAL_MS = 30_000;
const SPLIT_RECONCILE_MIN_SNAPSHOT_INTERVAL_MS = 30_000;
const PATHS = new Map([
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

function decimal(value, label = "decimal") {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match) throw new Error(`invalid_${label}`);
  const fraction = match[2] ?? "";
  return { units: BigInt(match[1] + fraction), scale: 10n ** BigInt(fraction.length) };
}

export function sameDecimal(left, right) {
  const a = decimal(left);
  const b = decimal(right);
  const scale = a.scale > b.scale ? a.scale : b.scale;
  return a.units * (scale / a.scale) === b.units * (scale / b.scale);
}

function sameDecimalOrFalse(left, right) {
  try { return sameDecimal(left, right); } catch { return false; }
}

function subtractDecimals(left, right) {
  const a = decimal(left);
  const b = decimal(right);
  const scale = a.scale > b.scale ? a.scale : b.scale;
  const units = a.units * (scale / a.scale) - b.units * (scale / b.scale);
  if (units < 0n) throw new Error("negative_decimal_subtraction");
  const whole = units / scale;
  const fraction = String(units % scale).padStart(String(scale).length - 1, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function sumDecimals(values) {
  let result = "0";
  for (const value of values) {
    const a = decimal(result);
    const b = decimal(value);
    const scale = a.scale > b.scale ? a.scale : b.scale;
    const units = a.units * (scale / a.scale) + b.units * (scale / b.scale);
    const whole = units / scale;
    const fraction = String(units % scale).padStart(String(scale).length - 1, "0")
      .replace(/0+$/, "");
    result = fraction ? `${whole}.${fraction}` : String(whole);
  }
  return result;
}

function compareDecimal(left, right) {
  const a = decimal(left);
  const b = decimal(right);
  const scale = a.scale > b.scale ? a.scale : b.scale;
  const x = a.units * (scale / a.scale);
  const y = b.units * (scale / b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

function exactId(row) {
  const candidates = ["orderID", "orderId"].filter((key) =>
    row?.[key] !== undefined && row[key] !== null).map((key) => {
    const value = row[key];
    return typeof value === "string" && value.trim() ? value
      : Number.isSafeInteger(value) ? String(value) : null;
  });
  return candidates.length && candidates.every(Boolean) &&
    new Set(candidates).size === 1 ? candidates[0] : null;
}

function exactStringId(row, keys = ["orderID", "orderId"]) {
  const values = keys.filter((key) =>
    row?.[key] !== undefined && row[key] !== null).map((key) => row[key]);
  if (!values.length || values.some((value) =>
    typeof value !== "string" || value.trim() === "")) return null;
  return new Set(values).size === 1 ? values[0] : null;
}

function positionId(row) {
  const values = ["positionId", "positionID"].filter((key) =>
    row?.[key] !== undefined && row[key] !== null).map((key) => {
    const value = row[key];
    return typeof value === "string" && value.trim() ? value
      : Number.isSafeInteger(value) ? String(value) : null;
  });
  return values.length && values.every(Boolean) && new Set(values).size === 1
    ? values[0] : null;
}

function orderCreatedAt(order) {
  const values = ["time", "createTime", "createdTime"].filter((key) =>
    order?.[key] !== undefined && order[key] !== null && order[key] !== "");
  if (!values.length) return null;
  const timestamps = values.map((key) => {
    const value = order[key];
    if ((typeof value !== "string" && typeof value !== "number") ||
        !/^\d+$/.test(String(value))) return null;
    const raw = Number(value);
    if (!Number.isSafeInteger(raw) || raw <= 0) return null;
    const timestamp = raw < 100_000_000_000 ? raw * 1000 : raw;
    return Number.isSafeInteger(timestamp) ? timestamp : null;
  });
  return timestamps.every((timestamp) => timestamp !== null) &&
    new Set(timestamps).size === 1 ? timestamps[0] : null;
}

function randomClientId(prefix) {
  const token = randomUUID().replaceAll("-", "").slice(0, 24);
  const label = String(prefix).replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 7).replace(/_+$/, "") || "id";
  return `${label}_${token}`;
}

function validateStop(order, { id, posId, quantity, price, parentId }) {
  if (exactId(order) !== id || order?.symbol !== API_SYMBOL ||
      order?.type !== "STOP_MARKET" || order?.status !== "NEW" ||
      order?.side !== "SELL" || order?.positionSide !== "LONG" ||
      order?.workingType !== "MARK_PRICE" || positionId(order) !== posId ||
      !sameDecimal(order.origQty, quantity) || !sameDecimal(order.stopPrice, price)) {
    return false;
  }
  if (parentId) {
    const parents = [order.mainOrderId, order.parentOrderId]
      .filter((item) => item !== undefined && item !== null && item !== "")
      .map(String);
    if (parents.some((parent) => parent !== parentId)) return false;
  }
  return true;
}

function oneLong(positions) {
  if (!Array.isArray(positions) || positions.some((row) =>
    !row || typeof row.symbol !== "string")) throw new Error("positions_unverified");
  const btc = positions.filter((row) => row.symbol === API_SYMBOL);
  const active = btc.filter((row) => Number(row.positionAmt) !== 0);
  if (active.length !== 1 || active[0].positionSide !== "LONG" ||
      !/^\d+(?:\.\d+)?$/.test(String(active[0].positionAmt)) ||
      !positionId(active[0])) throw new Error("exact_hedge_long_position_unverified");
  return active[0];
}

function exactHistoryRow(history, id) {
  const rows = Array.isArray(history) ? history : history?.orders;
  if (!Array.isArray(rows)) throw new Error("order_history_unavailable");
  const matches = rows.filter((row) => exactId(row) === id);
  if (matches.length !== 1) throw new Error("exact_order_history_id_unverified");
  return matches[0];
}

function trancheSizes(quantity, places) {
  const parsed = decimal(quantity);
  const precisionScale = 10n ** BigInt(places);
  if (parsed.units * precisionScale % parsed.scale !== 0n) {
    throw new Error("entry_quantity_exceeds_contract_precision");
  }
  const units = parsed.units * precisionScale / parsed.scale;
  if (units * 80n % 100n !== 0n) {
    throw new Error("quantity_cannot_be_exactly_split_80_20_at_contract_precision");
  }
  const coreUnits = units * 80n / 100n;
  const runnerUnits = units - coreUnits;
  if (coreUnits === 0n || runnerUnits === 0n) {
    throw new Error("quantity_too_small_for_80_20_split");
  }
  const format = (number) => {
    const whole = number / precisionScale;
    const fraction = String(number % precisionScale).padStart(places, "0")
      .replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : String(whole);
  };
  return { core: format(coreUnits), runner: format(runnerUnits) };
}

async function saveState(path, state, { exclusive = false } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (exclusive) {
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    return;
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, path);
}

async function loadState(path) {
  let state;
  try { state = JSON.parse(await readFile(path, "utf8")); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("state_unreadable_or_invalid");
  }
  if (state?.environment !== "vst" || state?.symbol !== SYMBOL) {
    throw new Error("state_invalid_or_not_vst_btc");
  }
  return state;
}

export function createVstGuardedFetch(fetchImpl, {
  stage = "read-only", expected = {}, onDiagnostic,
} = {}) {
  let writeCount = 0;
  const guardedRequest = async (input, init = {}) => {
    const url = new URL(input);
    const method = String(init.method ?? "GET").toUpperCase();
    if (url.protocol !== "https:" || url.origin !== HOST || url.username || url.password) {
      throw new Error("VST host isolation rejected request");
    }
    if (method === "GET") {
      if (url.pathname === "/openApi/swap/v2/quote/ticker") {
        if (url.searchParams.getAll("symbol").length !== 1 ||
            url.searchParams.get("symbol") !== API_SYMBOL ||
            [...url.searchParams.keys()].some((key) => key !== "symbol")) {
          throw new Error("VST ticker read guard rejected request");
        }
        const ticker = await fetchImpl(input, { ...init, redirect: "error" });
        if (ticker?.redirected) throw new Error("VST redirect rejected");
        return ticker;
      }
      const permitted = PATHS.get(url.pathname);
      const allowed = permitted;
      const broadPositionsRead = url.pathname === "/openApi/swap/v2/user/positions";
      const needsSymbol = allowed?.includes("symbol") && !broadPositionsRead;
      if (!allowed || (needsSymbol
          ? url.searchParams.getAll("symbol").length !== 1 ||
            url.searchParams.get("symbol") !== API_SYMBOL
          : !broadPositionsRead && url.searchParams.has("symbol")) ||
          broadPositionsRead && url.searchParams.has("symbol") &&
            (url.searchParams.getAll("symbol").length !== 1 ||
              url.searchParams.get("symbol") !== API_SYMBOL) ||
          [...url.searchParams.keys()].some((key) =>
            ![...allowed, ...SIGNED].includes(key)) ||
          SIGNED.some((key) => url.searchParams.getAll(key).length !== 1) ||
          url.searchParams.get("recvWindow") !== "5000" ||
          !/^\d+$/.test(url.searchParams.get("timestamp") ?? "") ||
          !/^[0-9a-f]{64}$/.test(url.searchParams.get("signature") ?? "")) {
        throw new Error("VST signed read guard rejected request");
      }
    } else {
      const expectedMethod = stage === "cancel-original" || stage === "cleanup-flat-stop" ||
        stage === "partial-close" && expected.phase === "cleanup" ? "DELETE" : "POST";
      const maxWrites = stage === "partial-close" ? 2 : 1;
      const expectedKeys = expectedMethod === "DELETE"
        ? ["symbol", "orderId"]
        : ["symbol", "side", "positionSide", "type", "quantity", "price",
          "timeInForce", "stopLoss", "stopPrice", "workingType", "clientOrderId"];
      if (writeCount >= maxWrites || method !== expectedMethod || url.pathname !== ORDER_PATH ||
          url.searchParams.get("symbol") !== API_SYMBOL ||
          (method === "POST" && url.searchParams.get("positionSide") !== "LONG") ||
          [...url.searchParams.keys()].some((key) =>
            ![...expectedKeys, ...SIGNED].includes(key)) ||
          SIGNED.some((key) => url.searchParams.getAll(key).length !== 1) ||
          expectedKeys.some((key) => url.searchParams.has(key) &&
            url.searchParams.getAll(key).length !== 1) ||
          url.searchParams.get("recvWindow") !== "5000" ||
          !/^\d+$/.test(url.searchParams.get("timestamp") ?? "") ||
          !/^[0-9a-f]{64}$/.test(url.searchParams.get("signature") ?? "")) {
        throw new Error("VST single-write guard rejected request");
      }
      const params = url.searchParams;
      const stageValid = stage === "entry"
        ? method === "POST" && params.get("side") === "BUY" &&
          params.get("type") === "LIMIT" && params.get("timeInForce") === "FOK" &&
          params.get("clientOrderId") === expected.clientOrderId &&
          sameDecimal(params.get("quantity"), expected.quantity) &&
          sameDecimal(params.get("price"), expected.price) &&
          JSON.parse(params.get("stopLoss") ?? "{}").type === "STOP_MARKET" &&
          sameDecimal(String(JSON.parse(params.get("stopLoss")).stopPrice), expected.stopPrice)
        : ["split-core", "split-runner"].includes(stage)
          ? method === "POST" && params.get("side") === "SELL" &&
            params.get("type") === "STOP_MARKET" &&
            params.get("workingType") === "MARK_PRICE" &&
            sameDecimal(params.get("quantity"), expected.quantity) &&
            sameDecimal(params.get("stopPrice"), expected.stopPrice) &&
            !params.has("clientOrderId")
          : stage === "cancel-original"
            ? method === "DELETE" && params.get("orderId") === expected.originalStopOrderId
            : stage === "cleanup-flat-stop"
              ? method === "DELETE" && params.get("orderId") === expected.orderId
            : stage === "emergency-close"
              ? method === "POST" && params.get("side") === "SELL" &&
                params.get("type") === "MARKET" &&
                params.get("clientOrderId") === expected.clientOrderId &&
                sameDecimal(params.get("quantity"), expected.quantity)
              : stage === "partial-close" && expected.phase === "market"
                ? method === "POST" && params.get("side") === "SELL" &&
                  params.get("type") === "MARKET" &&
                  params.get("clientOrderId") === expected.clientOrderId &&
                  sameDecimal(params.get("quantity"), expected.quantity)
                : stage === "partial-close" && expected.phase === "cleanup"
                  ? method === "DELETE" && params.get("orderId") === expected.stopOrderId
              : false;
      if (!stageValid) throw new Error("VST write parameter guard rejected request");
      writeCount += 1;
    }
    try {
      const response = await fetchImpl(input, { ...init, redirect: "error" });
      if (response?.redirected) throw new Error("VST redirect rejected");
      return response;
    } catch (error) {
      if (method !== "GET") throw new Error("VST write result unknown; do not retry");
      throw error;
    }
  };
  const guarded = async (input, init = {}) => {
    const method = String(init.method ?? "GET").toUpperCase();
    let path = "<invalid-url>";
    try {
      path = new URL(input).pathname;
    } catch {}
    try {
      return await guardedRequest(input, init);
    } catch (error) {
      if (typeof onDiagnostic === "function") {
        const safeMethod = /^(GET|POST|DELETE|PUT|PATCH)$/.test(method)
          ? method : "UNKNOWN";
        const errorName = typeof error?.name === "string" &&
          /^[A-Za-z][A-Za-z0-9]*$/.test(error.name) ? error.name : "Error";
        try { onDiagnostic({ method: safeMethod, path, errorName }); } catch {}
      }
      throw error;
    }
  };
  guarded.authorize = (values) => Object.assign(expected, values);
  return guarded;
}

export async function runProbe({
  command, api, statePath = STATE_PATH, quantity, maxPrice, stopPrice,
  tranche, orderId, operatorConfirmed = false, authorize,
}) {
  if (command === "status") return (await loadState(statePath)) ?? {
    environment: "vst", symbol: SYMBOL, status: "no_probe_state",
  };
  if (!operatorConfirmed && ["enter", "split-core", "split-runner",
    "cancel-original", "partial-close", "cleanup-partial-stop", "cleanup-flat-stop",
    "emergency-close"].includes(command)) {
    throw new Error("explicit_vst_operator_confirmation_required");
  }
  let state = await loadState(statePath);
  if (command === "enter") {
    if (state) throw new Error("existing_state_blocks_new_entry");
    if (!/^\d+(?:\.\d+)?$/.test(String(quantity)) ||
        !/^\d+(?:\.\d+)?$/.test(String(maxPrice)) ||
        !/^\d+(?:\.\d+)?$/.test(String(stopPrice))) {
      throw new Error("quantity_max_price_and_exact_signal_stop_required");
    }
    const filters = await api.contract(SYMBOL);
    const fractionLength = (value) => String(value).split(".")[1]?.length ?? 0;
    if (fractionLength(quantity) > filters.quantityPrecision ||
        fractionLength(maxPrice) > filters.pricePrecision ||
        fractionLength(stopPrice) > filters.pricePrecision ||
        Number(quantity) <= 0 || Number(maxPrice) <= 0 || Number(stopPrice) <= 0) {
      throw new Error("entry_values_must_be_positive_and_within_contract_precision");
    }
    const plannedTranches = trancheSizes(String(quantity), filters.quantityPrecision);
    if (Number(plannedTranches.core) < Number(filters.minQuantity) ||
        Number(plannedTranches.runner) < Number(filters.minQuantity)) {
      throw new Error("80_20_tranche_below_contract_minimum");
    }
    const id = randomClientId("vsplit_entry");
    state = {
      version: 1, environment: "vst", symbol: SYMBOL, createdAt: Date.now(),
      status: "entry_intent_persisted",
      entry: {
        clientOrderId: id, quantity: String(quantity), maxPrice: String(maxPrice),
        signalStopPrice: String(stopPrice), quantityPrecision: filters.quantityPrecision,
        pricePrecision: filters.pricePrecision,
        positionMode: "HEDGE", marginMode: "ISOLATED",
        leverageLong: 10, leverageShort: 75,
        maximumInitialMarginFractionOfTotalVst: "0.01",
        initialMarginFormula: "entry notional / 10",
      },
    };
    await saveState(statePath, state, { exclusive: true });
    try {
      authorize?.({
        clientOrderId: id, quantity: String(quantity),
        price: String(maxPrice), stopPrice: String(stopPrice),
      });
      const response = await api.placeVstOnePercentBoundedLong({
        symbol: SYMBOL, quantity: String(quantity), maxPrice: String(maxPrice),
        stopLoss: String(stopPrice), clientOrderId: id,
        probePolicy: VST_BTC_HEDGE_LONG10_SHORT75_PROBE,
      });
      state.entry.responseOrderId = exactId(response);
      state.status = "entry_response_received_reconciling";
      await saveState(statePath, state);
      const history = await api.queryOrderHistory(SYMBOL, {
        startTs: Math.max(1, state.createdAt - 60_000), endTs: Date.now(),
      });
      const rows = Array.isArray(history) ? history : history?.orders;
      const entries = rows?.filter((row) =>
        [row.clientOrderId, row.clientOrderID].includes(id)) ?? [];
      if (entries.length !== 1) throw new Error("entry_history_client_identity_unverified");
      const order = entries[0];
      const orderId = exactId(order);
      if (!orderId || order.symbol !== API_SYMBOL || order.status !== "FILLED" ||
          order.side !== "BUY" || order.positionSide !== "LONG" ||
          !sameDecimal(order.origQty, quantity) || !sameDecimal(order.executedQty, quantity)) {
        throw new Error("entry_order_not_exactly_filled");
      }
      if (state.entry.responseOrderId && state.entry.responseOrderId !== orderId) {
        throw new Error("entry_response_and_history_order_ids_disagree");
      }
      const fills = await api.queryFills(SYMBOL, {
        startTs: Math.max(1, state.createdAt - 60_000), endTs: Date.now(),
        orderId, currency: "VST",
      });
      if (!Array.isArray(fills) || !fills.length ||
          fills.some((fill) => exactId(fill) !== orderId || fill.symbol !== API_SYMBOL ||
            fill.side !== "BUY")) throw new Error("entry_fills_unverified");
      const filledQuantity = sumDecimals(fills.map((fill) =>
        fill.qty ?? fill.quantity ?? fill.volume));
      if (!sameDecimal(filledQuantity, quantity)) throw new Error("entry_fill_quantity_mismatch");
      const [positions, orders] = await Promise.all([
        api.getPositions(SYMBOL), api.getOpenOrders(SYMBOL),
      ]);
      const position = oneLong(positions);
      const idPos = positionId(position);
      if (!sameDecimal(position.positionAmt, quantity)) {
        throw new Error("entry_position_quantity_mismatch");
      }
      state.entry.orderId = orderId;
      state.entry.positionId = idPos;
      state.entry.actualEntryPrice = String(order.avgPrice ?? order.averagePrice ?? "");
      state.entry.fillsVerified = true;
      state.entry.positionVerified = true;
      state.status = "entry_position_known_stop_unknown";
      await saveState(statePath, state);
      const attached = orders.filter((row) =>
        row.type === "STOP_MARKET" && row.side === "SELL" && row.status === "NEW");
      const stopId = attached.length === 1 ? exactId(attached[0]) : null;
      if (!sameDecimal(position.positionAmt, quantity) || !stopId || orders.length !== 1 ||
          !validateStop(attached[0], {
            id: stopId, posId: idPos, quantity, price: stopPrice, parentId: orderId,
          })) throw new Error("initial_full_size_signal_stop_not_verified");
      const average = state.entry.actualEntryPrice;
      if (!/^\d+(?:\.\d+)?$/.test(average) || Number(average) <= 0) {
        throw new Error("actual_entry_average_price_unverified");
      }
      state.entry.stopOrderId = stopId;
      state.entry.initialMarginMaximumVst = "1% total VST balance at 10x";
      state.entry.attachedFullStopVerified = true;
      state.status = "entry_verified_full_attached_stop";
      await saveState(statePath, state);
      return state;
    } catch (error) {
      if (error instanceof BingXLiveApiError &&
          error.code === "INVALID_CLIENT_ORDER_ID" &&
          error.transportStage === "pre-sign") {
        state.entry.postAttemptEvidence = {
          status: "signed_post_not_attempted",
          source: "typed_adapter_pre_sign_validation",
          code: error.code,
          recordedAt: Date.now(),
        };
      }
      state.status = state.entry.positionId && state.entry.positionVerified
        ? "entry_position_known_stop_unknown" : "entry_unknown_halt_no_retry";
      state.error = String(error?.message ?? "unknown").slice(0, 180);
      await saveState(statePath, state);
      return state;
    }
  }
  if (!state) throw new Error("no_probe_state");

  if (command === "archive-no-fill") {
    if (state.status === "archived_no_fill") {
      const snapshots = state.entry?.noFillArchive?.snapshots;
      const archivedProofIsComplete = Array.isArray(snapshots) && snapshots.length === 2 &&
        snapshots.every((snapshot) => snapshot?.verified === true &&
          snapshot.historyIdentityComplete === true &&
          snapshot.matchingEntryRows === 0 && snapshot.fillRows === 0 &&
          snapshot.btcPositionsFlat === true && snapshot.openOrderRows === 0) &&
        snapshots[1].observedAt - snapshots[0].observedAt >=
          NO_FILL_ARCHIVE_MIN_SNAPSHOT_INTERVAL_MS;
      if (!archivedProofIsComplete) {
        throw new Error("archive_no_fill_persisted_proof_incomplete");
      }
      const archivePath = `${statePath}.archive-no-fill-${Date.now()}-${randomUUID()}`;
      await rename(statePath, archivePath);
      return { ...state, archivePath };
    }
    if (![
      "entry_intent_persisted", "entry_unknown_halt_no_retry",
      "entry_response_received_reconciling", "entry_reconciliation_incomplete",
    ].includes(state.status) || !state.entry?.clientOrderId) {
      throw new Error("archive_no_fill_requires_unresolved_entry_intent");
    }
    const startTs = Math.max(1, state.createdAt - 60_000);
    const observedAt = Date.now();
    const [history, fills, positions, orders] = await Promise.all([
      api.queryOrderHistory(SYMBOL, { startTs, endTs: observedAt }),
      api.queryFills(SYMBOL, {
        startTs, endTs: observedAt, currency: "VST",
      }),
      api.getPositions(SYMBOL),
      api.getOpenOrders(SYMBOL),
    ]);
    const historyRows = Array.isArray(history) ? history : history?.orders;
    const matchingEntries = Array.isArray(historyRows)
      ? historyRows.filter((row) =>
        [row?.clientOrderId, row?.clientOrderID].includes(state.entry.clientOrderId))
      : null;
    const historyIdentityComplete = Array.isArray(historyRows) &&
      historyRows.every((row) => row && typeof row.symbol === "string" &&
        (row.symbol !== API_SYMBOL ||
          [row.clientOrderId, row.clientOrderID].some((id) =>
            typeof id === "string" && id.length > 0)));
    const validPositionRows = Array.isArray(positions) &&
      positions.every((row) => row && typeof row.symbol === "string");
    const btcPositions = validPositionRows
      ? positions.filter((row) => row.symbol === API_SYMBOL) : null;
    const positionsFlat = btcPositions !== null && btcPositions.every((row) =>
      /^-?\d+(?:\.\d+)?$/.test(String(row.positionAmt)) &&
      Number(row.positionAmt) === 0);
    const verifiedSnapshot = Array.isArray(historyRows) && historyIdentityComplete &&
      matchingEntries?.length === 0 && Array.isArray(fills) && fills.length === 0 &&
      validPositionRows && positionsFlat && Array.isArray(orders) && orders.length === 0;
    const observation = {
      observedAt, startTs,
      historyRows: Array.isArray(historyRows) ? historyRows.length : null,
      historyIdentityComplete,
      matchingEntryRows: matchingEntries?.length ?? null,
      fillRows: Array.isArray(fills) ? fills.length : null,
      btcPositionRows: btcPositions?.length ?? null,
      btcPositionsFlat: positionsFlat,
      btcPositionSnapshot: btcPositions?.map((row) => ({
        positionId: positionId(row), positionSide: row.positionSide ?? null,
        positionAmt: String(row.positionAmt),
      })) ?? null,
      openOrderRows: Array.isArray(orders) ? orders.length : null,
      openOrderIds: Array.isArray(orders) ? orders.map(exactId) : null,
      verified: verifiedSnapshot,
    };
    const noFillArchive = state.entry.noFillArchive ?? {
      originalStatus: state.status, snapshots: [],
    };
    if (!Array.isArray(noFillArchive.snapshots)) {
      throw new Error("archive_no_fill_snapshot_state_invalid");
    }
    if (!verifiedSnapshot) {
      noFillArchive.snapshots = [];
      noFillArchive.status = "proof_incomplete_retry_read_only";
      noFillArchive.lastObservation = observation;
      state.entry.noFillArchive = noFillArchive;
      await saveState(statePath, state);
      return state;
    }
    const previous = noFillArchive.snapshots.find((snapshot) =>
      snapshot?.verified === true && snapshot.matchingEntryRows === 0 &&
      snapshot.fillRows === 0 && snapshot.btcPositionsFlat === true &&
      snapshot.openOrderRows === 0);
    noFillArchive.lastObservation = observation;
    if (previous && observedAt - previous.observedAt >=
        NO_FILL_ARCHIVE_MIN_SNAPSHOT_INTERVAL_MS) {
      noFillArchive.snapshots = [previous, observation];
      noFillArchive.status = "verified_two_delayed_no_fill_snapshots";
      noFillArchive.proofMethod = noFillArchive.originalStatus === "entry_unknown_halt_no_retry" &&
          state.entry.postAttemptEvidence?.status === "signed_post_not_attempted"
        ? "typed_pre_sign_rejection_and_two_delayed_no_fill_snapshots"
        : "two_delayed_complete_no_fill_snapshots";
      noFillArchive.minimumSnapshotIntervalMs = NO_FILL_ARCHIVE_MIN_SNAPSHOT_INTERVAL_MS;
      state.entry.noFillArchive = noFillArchive;
      state.status = "archived_no_fill";
      await saveState(statePath, state);
      const archivePath = `${statePath}.archive-no-fill-${observedAt}-${randomUUID()}`;
      await rename(statePath, archivePath);
      return { ...state, archivePath };
    }
    noFillArchive.snapshots = previous ? [previous] : [observation];
    noFillArchive.status = "second_delayed_snapshot_required";
    noFillArchive.minimumSnapshotIntervalMs = NO_FILL_ARCHIVE_MIN_SNAPSHOT_INTERVAL_MS;
    state.entry.noFillArchive = noFillArchive;
    await saveState(statePath, state);
    return state;
  }

  if (command === "reconcile-split") {
    const role = tranche;
    if (!["core", "runner"].includes(role) ||
        ![
          `${role}_stop_unknown_halt_no_retry`,
          `${role}_stop_submitting_no_retry`,
        ].includes(state.status) || !state[role]) {
      throw new Error("split_reconcile_requires_persisted_unknown_tranche_intent");
    }
    const sizes = trancheSizes(state.entry.quantity, state.entry.quantityPrecision);
    const expectedQuantity = sizes[role];
    const expectedPrice = role === "core"
      ? state.entry.signalStopPrice : state.entry.actualEntryPrice;
    if (!sameDecimal(state[role].quantity, expectedQuantity) ||
        !sameDecimal(state[role].stopPrice, expectedPrice)) {
      state[role].observation = "persisted_split_intent_does_not_match_exact_tranche_policy";
      await saveState(statePath, state);
      return state;
    }
    if (state[role].reconciliationBlocked) {
      state[role].observation = "reconciliation_identity_conflict_requires_manual_review";
      await saveState(statePath, state);
      return state;
    }
    const persistedSnapshots = state[role].reconciliationSnapshots;
    const priorSnapshotIsValid = (snapshot) => snapshot?.verified === true &&
      Number.isSafeInteger(snapshot.observedAt) &&
      Number.isSafeInteger(snapshot.candidateCreatedAt) &&
      typeof snapshot.candidateOrderId === "string" &&
      typeof snapshot.originalStopOrderId === "string" &&
      typeof snapshot.positionId === "string" && typeof snapshot.positionQuantity === "string" &&
      Array.isArray(snapshot.openOrderIds) &&
      snapshot.openOrderIds.every((id) => typeof id === "string" && id.length > 0);
    if (persistedSnapshots !== undefined &&
        (!Array.isArray(persistedSnapshots) || persistedSnapshots.length > 1 ||
         persistedSnapshots.length === 1 && !priorSnapshotIsValid(persistedSnapshots[0]))) {
      state[role].reconciliationBlocked = true;
      state[role].observation = "persisted_reconciliation_snapshot_invalid";
      await saveState(statePath, state);
      return state;
    }
    const [positions, orders] = await Promise.all([
      api.getPositions(SYMBOL), api.getOpenOrders(SYMBOL),
    ]);
    const previous = persistedSnapshots?.[0] ?? null;
    const blockReconciliation = (reason) => {
      state[role].reconciliationBlocked = true;
      state[role].observation = reason;
      state[role].reconciliationSnapshots = [];
    };
    let position;
    try { position = oneLong(positions); } catch {
      if (previous) blockReconciliation("position_exposure_changed_after_first_snapshot");
      else state[role].observation = "single_btc_long_position_unverified";
      await saveState(statePath, state);
      return state;
    }
    if (positionId(position) !== state.entry.positionId ||
        !sameDecimal(position.positionAmt, state.entry.quantity)) {
      blockReconciliation("position_identity_or_quantity_changed");
      await saveState(statePath, state);
      return state;
    }
    if (!Array.isArray(orders) || !Number.isSafeInteger(state[role].startedAt)) {
      if (previous) blockReconciliation("open_order_snapshot_invalid_after_first_snapshot");
      else state[role].observation = "open_order_snapshot_or_persisted_start_time_invalid";
      await saveState(statePath, state);
      return state;
    }

    const orderIds = orders.map(exactId);
    if (orderIds.some((id) => !id) || new Set(orderIds).size !== orderIds.length) {
      blockReconciliation("open_order_ids_missing_or_duplicated");
      await saveState(statePath, state);
      return state;
    }
    const originalRows = orders.filter((row) =>
      exactId(row) === state.entry.stopOrderId);
    if (originalRows.length !== 1 || !validateStop(originalRows[0], {
      id: state.entry.stopOrderId, posId: state.entry.positionId,
      quantity: state.entry.quantity, price: state.entry.signalStopPrice,
      parentId: state.entry.orderId,
    })) {
      blockReconciliation("original_full_size_stop_missing_or_changed");
      await saveState(statePath, state);
      return state;
    }

    const knownOtherRole = role === "runner" ? state.core : null;
    const otherRows = knownOtherRole
      ? orders.filter((row) => exactId(row) === knownOtherRole.orderId) : [];
    if (role === "runner" &&
        (!knownOtherRole?.orderId || otherRows.length !== 1 ||
         !validateStop(otherRows[0], {
           id: knownOtherRole.orderId, posId: state.entry.positionId,
           quantity: knownOtherRole.quantity, price: knownOtherRole.stopPrice,
         }))) {
      blockReconciliation("previous_core_stop_missing_or_changed");
      await saveState(statePath, state);
      return state;
    }

    const expectedOrderCount = role === "core" ? 2 : 3;
    if (orders.length !== expectedOrderCount) {
      blockReconciliation("foreign_or_duplicate_open_orders_present");
      await saveState(statePath, state);
      return state;
    }
    const candidateRows = orders.filter((row) =>
      exactId(row) !== state.entry.stopOrderId &&
      (!knownOtherRole || exactId(row) !== knownOtherRole.orderId) &&
      validateStop(row, {
        id: exactId(row), posId: state.entry.positionId,
        quantity: expectedQuantity, price: expectedPrice,
      }) && orderCreatedAt(row) > state[role].startedAt);
    if (candidateRows.length !== 1) {
      if (candidateRows.length > 1) {
        blockReconciliation("multiple_exact_new_stop_ids_ambiguous");
      } else if (previous) {
        blockReconciliation("candidate_stop_changed_or_disappeared_after_first_snapshot");
      } else {
        state[role].observation = "no_exact_new_stop_in_open_orders";
      }
      await saveState(statePath, state);
      return state;
    }
    const candidate = candidateRows[0];
    const snapshot = {
      verified: true, observedAt: Date.now(),
      positionId: positionId(position), positionQuantity: String(position.positionAmt),
      originalStopOrderId: state.entry.stopOrderId,
      candidateOrderId: exactId(candidate),
      candidateCreatedAt: orderCreatedAt(candidate),
      openOrderIds: orderIds.slice().sort(),
    };
    if (role === "runner") {
      snapshot.coreOrderId = state.core.orderId;
    }
    if (previous) {
      const sameSnapshot = previous.candidateOrderId === snapshot.candidateOrderId &&
        previous.positionId === snapshot.positionId &&
        sameDecimal(previous.positionQuantity, snapshot.positionQuantity) &&
        previous.originalStopOrderId === snapshot.originalStopOrderId &&
        previous.candidateCreatedAt === snapshot.candidateCreatedAt &&
        JSON.stringify(previous.openOrderIds) === JSON.stringify(snapshot.openOrderIds) &&
        (role !== "runner" || previous.coreOrderId === snapshot.coreOrderId);
      if (!sameSnapshot) {
        blockReconciliation("open_order_or_position_identity_changed_between_snapshots");
        await saveState(statePath, state);
        return state;
      }
      if (snapshot.observedAt - previous.observedAt <
          SPLIT_RECONCILE_MIN_SNAPSHOT_INTERVAL_MS) {
        state[role].observation = "exact_open_orders_and_position_snapshot_waiting_spacing";
        await saveState(statePath, state);
        return state;
      }
      state[role].orderId = snapshot.candidateOrderId;
      state[role].status = "independently_verified_open_and_spaced_snapshots";
      state[role].verifiedAt = snapshot.observedAt;
      state[role].reconciledAfterAmbiguousResponse = true;
      state[role].verificationMethod = "two_spaced_exact_open_orders_and_position_snapshots";
      state[role].reconciliationSnapshots = [previous, snapshot];
      state[role].observation = "exact_stop_verified_by_two_spaced_open_order_snapshots";
      state.status = role === "core"
        ? "core_stop_verified_original_still_active"
        : "both_replacement_stops_verified_original_still_active";
      await saveState(statePath, state);
      return state;
    }
    state[role].reconciliationSnapshots = [snapshot];
    state[role].observation = "exact_open_orders_and_position_snapshot_1_of_2";
    await saveState(statePath, state);
    return state;
  }

  if (command === "reconcile-cancel-original") {
    if (![
      "original_stop_cancel_submitting_no_retry",
      "original_stop_cancel_unknown_halt_no_retry",
    ].includes(state.status) || !state.originalStopCancellation) {
      throw new Error("original_cancel_reconcile_requires_persisted_delete_intent");
    }
    const [positions, orders, coreHistory, runnerHistory, original, fills] = await Promise.all([
      api.getPositions(SYMBOL), api.getOpenOrders(SYMBOL),
      api.queryOrderHistory(SYMBOL, {
        startTs: Math.max(1, state.core.startedAt - 60_000),
        endTs: Date.now(),
      }),
      api.queryOrderHistory(SYMBOL, {
        startTs: Math.max(1, state.runner.startedAt - 60_000),
        endTs: Date.now(),
      }),
      api.queryOrder(SYMBOL, { orderId: state.entry.stopOrderId }),
      api.queryFills(SYMBOL, {
        startTs: 1, endTs: Date.now(),
        orderId: state.entry.stopOrderId, currency: "VST",
      }),
    ]);
    const expectedTranches = trancheSizes(
      state.entry.quantity, state.entry.quantityPrecision,
    );
    if (!sameDecimal(state.core?.quantity, expectedTranches.core) ||
        !sameDecimal(state.core?.stopPrice, state.entry.signalStopPrice) ||
        !sameDecimal(state.runner?.quantity, expectedTranches.runner) ||
        !sameDecimal(state.runner?.stopPrice, state.entry.actualEntryPrice)) {
      state.originalStopCancellation.status = "unknown_halt_no_retry";
      state.originalStopCancellation.observation =
        "persisted_replacement_intents_do_not_match_exact_split_policy";
      state.status = "original_stop_cancel_unknown_halt_no_retry";
      await saveState(statePath, state);
      return state;
    }
    const coreHistoryRows = Array.isArray(coreHistory)
      ? coreHistory : coreHistory?.orders;
    const runnerHistoryRows = Array.isArray(runnerHistory)
      ? runnerHistory : runnerHistory?.orders;
    const replacementMatches = [state.core, state.runner].map((expected) =>
      orders.filter((row) => exactId(row) === expected?.orderId));
    const replacementHistoryVerified = [state.core, state.runner].every((expected) => {
      const source = expected === state.core ? coreHistoryRows : runnerHistoryRows;
      const matches = source?.filter((row) =>
        exactId(row) === expected?.orderId) ?? [];
      return matches.length === 1 && matches[0].symbol === API_SYMBOL &&
        matches[0].type === "STOP_MARKET" && matches[0].status === "NEW" &&
        matches[0].side === "SELL" && matches[0].positionSide === "LONG" &&
        matches[0].workingType === "MARK_PRICE" &&
        sameDecimal(matches[0].origQty, expected.quantity) &&
        sameDecimal(matches[0].stopPrice, expected.stopPrice);
    });
    const replacementsOpen = [state.core, state.runner].every((expected, index) =>
      replacementMatches[index].length === 1 && validateStop(
        replacementMatches[index][0], {
          id: expected.orderId, posId: state.entry.positionId,
          quantity: expected.quantity, price: expected.stopPrice,
        },
      ));
    const position = oneLong(positions);
    const originalOpen = orders.filter((row) =>
      exactId(row) === state.entry.stopOrderId);
    const originalCanceled = original &&
      exactId(original) === state.entry.stopOrderId &&
      ["CANCELED", "CANCELLED"].includes(original.status);
    const originalStillOpen = originalOpen.length === 1 &&
      validateStop(originalOpen[0], {
        id: state.entry.stopOrderId, posId: state.entry.positionId,
        quantity: state.entry.quantity, price: state.entry.signalStopPrice,
        parentId: state.entry.orderId,
      }) && original?.status === "NEW";
    const originalHasNoFills = Array.isArray(fills) && fills.length === 0 &&
      (original?.executedQty === undefined || sameDecimal(original.executedQty, "0"));
    const commonEvidence = positionId(position) === state.entry.positionId &&
      sameDecimal(position.positionAmt, state.entry.quantity) &&
      orders.length === 2 + Number(originalStillOpen) &&
      replacementsOpen && replacementHistoryVerified && originalHasNoFills;
    if (commonEvidence && originalCanceled && !originalStillOpen) {
      state.originalStopCancellation.status = "canceled_no_fills_verified";
      state.originalStopCancellation.reconciledAfterAmbiguousResponse = true;
      state.status = "split_stops_active_original_canceled";
    } else {
      state.originalStopCancellation.status = "unknown_halt_no_retry";
      state.originalStopCancellation.observation = commonEvidence && originalStillOpen
        ? "original_stop_still_open_delete_not_retried"
        : "cancel_outcome_not_uniquely_verified";
      state.status = "original_stop_cancel_unknown_halt_no_retry";
    }
    await saveState(statePath, state);
    return state;
  }

  if (command === "reconcile-entry") {
    if (!["entry_intent_persisted", "entry_unknown_halt_no_retry",
      "entry_response_received_reconciling", "entry_reconciliation_incomplete",
      "entry_position_known_stop_unknown"].includes(state.status)) {
      throw new Error("entry_reconcile_requires_persisted_entry_intent");
    }
    const history = await api.queryOrderHistory(SYMBOL, {
      startTs: Math.max(1, state.createdAt - 60_000), endTs: Date.now(),
    });
    const rows = Array.isArray(history) ? history : history?.orders;
    const matches = rows?.filter((row) =>
      [row.clientOrderId, row.clientOrderID].includes(state.entry.clientOrderId)) ?? [];
    const order = matches.length === 1 ? matches[0] : null;
    const orderId = exactId(order);
    let exactFillVerified = false;
    let reason = matches.length === 1
      ? "entry_order_not_exact_full_fill"
      : "entry_history_identity_missing_or_nonunique";
    if (orderId && (!state.entry.responseOrderId ||
        state.entry.responseOrderId === orderId) &&
        order.symbol === API_SYMBOL && order.side === "BUY" &&
        order.positionSide === "LONG" && order.status === "FILLED" &&
        sameDecimal(order.origQty, state.entry.quantity) &&
        sameDecimal(order.executedQty, state.entry.quantity)) {
      const fills = await api.queryFills(SYMBOL, {
        startTs: Math.max(1, state.createdAt - 60_000), endTs: Date.now(),
        orderId, currency: "VST",
      });
      exactFillVerified = Array.isArray(fills) && fills.length > 0 &&
        fills.every((fill) => fill.symbol === API_SYMBOL &&
          exactId(fill) === orderId && fill.side === "BUY") &&
        sameDecimal(sumDecimals(fills.map((fill) =>
          fill.qty ?? fill.quantity ?? fill.volume)), state.entry.quantity);
      reason = exactFillVerified
        ? "exact_entry_history_fills_and_position_verified"
        : "entry_fills_not_yet_exact";
    }

    const [positions, orders] = await Promise.all([
      api.getPositions(SYMBOL), api.getOpenOrders(SYMBOL),
    ]);
    let position = null;
    try { position = oneLong(positions); } catch {}
    if (!position) {
      state.entry.reconciliation = reason === "exact_entry_history_fills_and_position_verified"
        ? "exact_entry_fills_verified_but_position_not_currently_open"
        : `${reason};position_or_fill_evidence_delayed`;
      state.status = "entry_reconciliation_incomplete";
      await saveState(statePath, state);
      return state;
    }

    const actualQuantity = String(position.positionAmt);
    const exactFullQuantity = sameDecimal(actualQuantity, state.entry.quantity);
    state.entry.positionId = positionId(position);
    state.entry.currentQuantity = actualQuantity;
    state.entry.positionVerified = true;
    if (orderId) state.entry.orderId = orderId;
    if (exactFillVerified && order) {
      state.entry.fillsVerified = true;
      state.entry.actualEntryPrice = String(order.avgPrice ?? order.averagePrice ?? "");
    }
    const stopCandidates = Array.isArray(orders) ? orders.filter((row) =>
      row.type === "STOP_MARKET" && row.status === "NEW" && row.side === "SELL" &&
      row.positionSide === "LONG" && row.workingType === "MARK_PRICE" &&
      positionId(row) === state.entry.positionId &&
      sameDecimal(row.origQty, actualQuantity) &&
      sameDecimal(row.stopPrice, state.entry.signalStopPrice)) : [];
    const protectedPosition = Array.isArray(orders) && orders.length === 1 &&
      stopCandidates.length === 1 && exactId(stopCandidates[0]) !== null &&
      validateStop(stopCandidates[0], {
        id: exactId(stopCandidates[0]), posId: state.entry.positionId,
        quantity: actualQuantity, price: state.entry.signalStopPrice,
        parentId: orderId,
      });
    if (protectedPosition) {
      state.entry.stopOrderId = exactId(stopCandidates[0]);
      state.entry.protectiveStopVerified = true;
      state.entry.attachedFullStopVerified = exactFillVerified && exactFullQuantity;
    } else {
      state.entry.protectiveStopVerified = false;
    }
    if (exactFillVerified && exactFullQuantity &&
        /^\d+(?:\.\d+)?$/.test(state.entry.actualEntryPrice) &&
        Number(state.entry.actualEntryPrice) > 0 && protectedPosition) {
      state.status = "entry_verified_full_attached_stop";
      state.entry.reconciliation = "exact_entry_fills_position_and_attached_stop_verified";
    } else {
      state.status = "entry_position_known_stop_unknown";
      state.entry.reconciliation = protectedPosition
        ? "position_and_full_protective_stop_known_entry_or_fill_history_pending"
        : "position_known_protection_or_entry_history_unverified";
    }
    await saveState(statePath, state);
    return state;
  }

  if (command === "split-core" || command === "split-runner") {
    const role = command === "split-core" ? "core" : "runner";
    const requiredStatus = role === "core"
      ? "entry_verified_full_attached_stop" : "core_stop_verified_original_still_active";
    if (state.status !== requiredStatus) throw new Error("split_stage_status_not_retryable");
    const sizes = trancheSizes(state.entry.quantity, state.entry.quantityPrecision);
    const trancheQuantity = sizes[role];
    const trigger = role === "core"
      ? state.entry.signalStopPrice : state.entry.actualEntryPrice;
    const market = await api.getVstMarkPrice(SYMBOL);
    const time = Number(market.timestamp);
    const normalized = time > 0 && time < 100_000_000_000 ? time * 1000 : time;
    const freshMark = Number.isFinite(Number(market.markPrice)) &&
      Number(market.markPrice) > 0 && Number.isSafeInteger(normalized) &&
      Date.now() - normalized <= 10_000 && normalized <= Date.now() + 2_000;
    if (!freshMark || compareDecimal(trigger, String(market.markPrice)) >= 0) {
      state.status = role === "runner"
        ? "split_blocked_be_not_below_fresh_mark"
        : "split_blocked_signal_stop_not_below_fresh_mark";
      state.splitBlockReason = role === "runner"
        ? "runner_break_even_not_below_fresh_mark"
        : "core_signal_stop_not_below_fresh_mark";
      await saveState(statePath, state);
      return state;
    }
    const position = oneLong(await api.getPositions(SYMBOL));
    if (positionId(position) !== state.entry.positionId ||
        !sameDecimal(position.positionAmt, state.entry.quantity)) {
      throw new Error("split_requires_original_exact_position");
    }
    const existing = role === "runner" ? [{
      orderId: state.core.orderId, quantity: sizes.core,
      stopPrice: state.entry.signalStopPrice, tranche: "core",
    }] : [];
    const intent = {
      role, quantity: trancheQuantity, stopPrice: trigger,
      startedAt: Date.now(), status: "persisted_no_retry",
    };
    state[role] = intent;
    state.status = role === "core" ? "core_stop_submitting_no_retry"
      : "runner_stop_submitting_no_retry";
    await saveState(statePath, state);
    try {
      authorize?.({ quantity: trancheQuantity, stopPrice: trigger });
      const response = await api.placeVstVirtualSplitLongStop({
        symbol: SYMBOL, quantity: trancheQuantity, stopPrice: trigger,
        positionId: state.entry.positionId,
        originalStopOrderId: state.entry.stopOrderId,
        originalStopPrice: state.entry.signalStopPrice,
        entryOrderId: state.entry.orderId, totalQuantity: state.entry.quantity, tranche: role,
        breakEvenPrice: state.entry.actualEntryPrice,
        existingReplacementStops: existing,
      });
      const id = exactId(response);
      if (!id || id === state.entry.stopOrderId || existing.some((stop) => stop.orderId === id)) {
        throw new Error("replacement_stop_response_id_invalid");
      }
      const [positions, orders, history] = await Promise.all([
        api.getPositions(SYMBOL),
        api.getOpenOrders(SYMBOL),
        api.queryOrderHistory(SYMBOL, {
          startTs: Math.max(1, intent.startedAt - 60_000), endTs: Date.now(),
        }),
      ]);
      const openMatches = orders.filter((row) => exactId(row) === id);
      const historyOrder = exactHistoryRow(history, id);
      const activePosition = oneLong(positions);
      const expectedStops = [
        {
          id: state.entry.stopOrderId, quantity: state.entry.quantity,
          price: state.entry.signalStopPrice, parentId: state.entry.orderId,
        },
        ...existing.map((stop) => ({
          id: stop.orderId, quantity: stop.quantity, price: stop.stopPrice,
          parentId: state.entry.orderId,
        })),
        { id, quantity: trancheQuantity, price: trigger },
      ];
      if (!sameDecimal(activePosition.positionAmt, state.entry.quantity) ||
          positionId(activePosition) !== state.entry.positionId ||
          orders.length !== expectedStops.length ||
          expectedStops.some((expectedStop) => {
            const matching = orders.filter((row) => exactId(row) === expectedStop.id);
            return matching.length !== 1 || !validateStop(matching[0], {
              id: expectedStop.id, posId: state.entry.positionId,
              quantity: expectedStop.quantity, price: expectedStop.price,
              parentId: expectedStop.parentId,
            });
          }) ||
          openMatches.length !== 1 ||
          !validateStop(openMatches[0], {
            id, posId: state.entry.positionId, quantity: trancheQuantity, price: trigger,
          }) ||
          !validateStop({ ...historyOrder, status: openMatches[0].status }, {
            id, posId: state.entry.positionId, quantity: trancheQuantity, price: trigger,
          }) || historyOrder.symbol !== API_SYMBOL ||
          historyOrder.type !== "STOP_MARKET" || historyOrder.side !== "SELL" ||
          !sameDecimal(historyOrder.origQty, trancheQuantity) ||
          !sameDecimal(historyOrder.stopPrice, trigger)) {
        throw new Error("replacement_stop_open_order_and_history_verification_failed");
      }
      intent.orderId = id;
      intent.status = "independently_verified_open_and_history";
      intent.verifiedAt = Date.now();
      state.status = role === "core" ? "core_stop_verified_original_still_active"
        : "both_replacement_stops_verified_original_still_active";
      await saveState(statePath, state);
      return state;
    } catch (error) {
      intent.status = "unknown_halt_no_retry";
      intent.error = String(error?.message ?? "unknown").slice(0, 180);
      state.status = role === "core" ? "core_stop_unknown_halt_no_retry"
        : "runner_stop_unknown_halt_no_retry";
      await saveState(statePath, state);
      return state;
    }
  }

  if (command === "cancel-original") {
    if (state.status !== "both_replacement_stops_verified_original_still_active" ||
        !["independently_verified_open_and_history",
          "independently_verified_open_and_spaced_snapshots"].includes(state.core?.status) ||
        !["independently_verified_open_and_history",
          "independently_verified_open_and_spaced_snapshots"].includes(state.runner?.status)) {
      throw new Error("original_stop_cancel_requires_both_replacements_independently_verified");
    }
    // BingX VST does not include active NEW STOP_MARKET orders in order
    // history. Both replacements have already been independently identified
    // in two delayed open-order/position snapshots; require them to remain
    // exact and active at the moment of cancellation instead.
    const [positions, orders] = await Promise.all([
      api.getPositions(SYMBOL), api.getOpenOrders(SYMBOL),
    ]);
    const position = oneLong(positions);
    if (!sameDecimal(position.positionAmt, state.entry.quantity) ||
        positionId(position) !== state.entry.positionId || !Array.isArray(orders) ||
        orders.length !== 3 ||
        !orders.some((row) => validateStop(row, {
          id: state.entry.stopOrderId, posId: state.entry.positionId,
          quantity: state.entry.quantity, price: state.entry.signalStopPrice,
          parentId: state.entry.orderId,
        })) ||
        !orders.some((row) => validateStop(row, {
          id: state.core.orderId, posId: state.entry.positionId,
          quantity: state.core.quantity, price: state.core.stopPrice,
        })) ||
        !orders.some((row) => validateStop(row, {
          id: state.runner.orderId, posId: state.entry.positionId,
          quantity: state.runner.quantity, price: state.runner.stopPrice,
        }))) {
      throw new Error("original_stop_cancel_prewrite_independent_evidence_failed");
    }
    state.originalStopCancellation = {
      intentId: randomClientId("vsplit_cancel"), status: "persisted_no_retry",
      startedAt: Date.now(), orderId: state.entry.stopOrderId,
    };
    state.status = "original_stop_cancel_submitting_no_retry";
    await saveState(statePath, state);
    try {
      authorize?.({ originalStopOrderId: state.entry.stopOrderId });
      const result = await api.cancelVstAttachedLongStopAfterSplit({
        symbol: SYMBOL, originalStopOrderId: state.entry.stopOrderId,
        originalStopPrice: state.entry.signalStopPrice,
        positionId: state.entry.positionId, entryOrderId: state.entry.orderId,
        totalQuantity: state.entry.quantity,
        replacementStops: [
          { orderId: state.core.orderId, quantity: state.core.quantity,
            stopPrice: state.core.stopPrice, tranche: "core" },
          { orderId: state.runner.orderId, quantity: state.runner.quantity,
            stopPrice: state.runner.stopPrice, tranche: "runner" },
        ],
        breakEvenPrice: state.entry.actualEntryPrice,
      });
      state.originalStopCancellation.status = "canceled_no_fills_verified";
      state.originalStopCancellation.exchangeStatus = result.status;
      state.status = "split_stops_active_original_canceled";
      await saveState(statePath, state);
    } catch (error) {
      state.originalStopCancellation.status = "unknown_halt_no_retry";
      state.originalStopCancellation.error = String(error?.message ?? "unknown").slice(0, 180);
      state.status = "original_stop_cancel_unknown_halt_no_retry";
      await saveState(statePath, state);
    }
    return state;
  }

  if (command === "partial-close") {
    if (state.status !== "split_stops_active_original_canceled" ||
        !["core", "runner"].includes(tranche)) {
      throw new Error("partial_close_requires_verified_split_stops_and_core_or_runner_choice");
    }
    const closedRole = tranche;
    const retainedRole = closedRole === "core" ? "runner" : "core";
    const closed = state[closedRole];
    const retained = state[retainedRole];
    const sizes = trancheSizes(state.entry.quantity, state.entry.quantityPrecision);
    const expectedRemaining = sizes[retainedRole];
    const before = oneLong(await api.getPositions(SYMBOL));
    if (positionId(before) !== state.entry.positionId ||
        !sameDecimal(before.positionAmt, state.entry.quantity)) {
      throw new Error("partial_close_requires_original_verified_position");
    }
    const close = {
      role: closedRole, clientOrderId: randomClientId(`vsplit_${closedRole}_close`),
      quantity: sizes[closedRole], remainingQuantity: expectedRemaining,
      startedAt: Date.now(), status: "market_intent_persisted_no_retry",
    };
    state.partialClose = close;
    state.status = `${closedRole}_partial_close_submitting_no_retry`;
    await saveState(statePath, state);
    try {
      authorize?.({
        phase: "market", clientOrderId: close.clientOrderId,
        quantity: close.quantity,
      });
      const response = await api.closeVstVirtualSplitTranche({
        symbol: SYMBOL, quantity: close.quantity, totalQuantity: state.entry.quantity,
        positionId: state.entry.positionId, clientOrderId: close.clientOrderId,
        tranche: closedRole,
        signalStopPrice: state.entry.signalStopPrice,
        breakEvenPrice: state.entry.actualEntryPrice,
        trancheStop: {
          orderId: closed.orderId, quantity: closed.quantity, stopPrice: closed.stopPrice,
        },
        retainedStop: {
          orderId: retained.orderId, quantity: retained.quantity,
          stopPrice: retained.stopPrice,
        },
      });
      close.responseOrderId = exactId(response);
      const history = await api.queryOrderHistory(SYMBOL, {
        startTs: Math.max(1, close.startedAt - 60_000), endTs: Date.now(),
      });
      const historyRows = Array.isArray(history) ? history : history?.orders;
      const matches = historyRows?.filter((row) =>
        [row.clientOrderId, row.clientOrderID].includes(close.clientOrderId)) ?? [];
      if (matches.length !== 1) throw new Error("partial_close_history_identity_unverified");
      const order = matches[0];
      const id = exactId(order);
      if (!id || close.responseOrderId && close.responseOrderId !== id ||
          order.symbol !== API_SYMBOL || order.side !== "SELL" ||
          order.positionSide !== "LONG" || order.type !== "MARKET" ||
          order.status !== "FILLED" || !sameDecimal(order.origQty, close.quantity) ||
          !sameDecimal(order.executedQty, close.quantity)) {
        throw new Error("partial_close_not_exactly_filled");
      }
      const fills = await api.queryFills(SYMBOL, {
        startTs: Math.max(1, close.startedAt - 60_000), endTs: Date.now(),
        orderId: id, currency: "VST",
      });
      if (!Array.isArray(fills) || !fills.length ||
          fills.some((fill) => fill.symbol !== API_SYMBOL || exactId(fill) !== id ||
            fill.side !== "SELL") ||
          !sameDecimal(sumDecimals(fills.map((fill) =>
            fill.qty ?? fill.quantity ?? fill.volume)), close.quantity)) {
        throw new Error("partial_close_fills_not_exact");
      }
      const [positions, orders] = await Promise.all([
        api.getPositions(SYMBOL), api.getOpenOrders(SYMBOL),
      ]);
      const after = oneLong(positions);
      if (positionId(after) !== state.entry.positionId ||
          !sameDecimal(after.positionAmt, expectedRemaining) || orders.length !== 2 ||
          !orders.some((row) => validateStop(row, {
            id: retained.orderId, posId: state.entry.positionId,
            quantity: expectedRemaining, price: retained.stopPrice,
          }))) throw new Error("partial_close_remaining_position_or_retained_stop_unverified");
      close.orderId = id;
      close.status = "market_fill_and_remaining_stop_verified";
      close.remainingPositionVerified = true;
      state.entry.currentQuantity = expectedRemaining;
      await saveState(statePath, state);

      close.cancelIntent = {
        stopOrderId: closed.orderId, status: "persisted_no_retry", startedAt: Date.now(),
      };
      state.status = `${closedRole}_partial_close_cleanup_submitting_no_retry`;
      await saveState(statePath, state);
      authorize?.({ phase: "cleanup", stopOrderId: closed.orderId });
      const cleanup = await api.cancelVstSplitStopAfterPartial({
        symbol: SYMBOL,
        stopToCancel: {
          orderId: closed.orderId, quantity: closed.quantity,
          stopPrice: closed.stopPrice,
        },
        retainedStop: {
          orderId: retained.orderId, quantity: expectedRemaining,
          stopPrice: retained.stopPrice,
        },
        remainingQuantity: expectedRemaining, positionId: state.entry.positionId,
        tranche: closedRole,
        signalStopPrice: state.entry.signalStopPrice,
        breakEvenPrice: state.entry.actualEntryPrice,
      });
      close.cancelIntent.status = "canceled_no_fills_verified";
      close.cancelIntent.exchangeStatus = cleanup.status;
      close.retainedStopVerified = true;
      state.status = `${closedRole}_partial_close_verified_remaining_${retainedRole}_protected`;
      await saveState(statePath, state);
    } catch (error) {
      close.status = "unknown_halt_no_retry";
      close.error = String(error?.message ?? "unknown").slice(0, 180);
      state.status = `${closedRole}_partial_close_unknown_halt_no_retry`;
      await saveState(statePath, state);
    }
    return state;
  }

  if (command === "reconcile-triggered-runner") {
    if (state.emergencyClose ||
        !state.runner || !state.core || !state.entry?.positionId ||
        typeof state.runner.orderId !== "string" ||
        typeof state.core.orderId !== "string" ||
        typeof state.entry.stopOrderId !== "string" ||
        !Number.isSafeInteger(state.runner.startedAt)) {
      throw new Error("triggered_runner_reconcile_requires_persisted_exact_stop_intents");
    }
    const runnerId = state.runner.orderId;
    const coreId = state.core.orderId;
    const originalId = state.entry.stopOrderId;
    const expected = trancheSizes(state.entry.quantity, state.entry.quantityPrecision);
    if (!sameDecimal(state.runner.quantity, expected.runner) ||
        !sameDecimal(state.core.quantity, expected.core) ||
        !sameDecimal(state.runner.stopPrice, state.entry.actualEntryPrice) ||
        !sameDecimal(state.core.stopPrice, state.entry.signalStopPrice)) {
      throw new Error("triggered_runner_persisted_split_intents_not_exact");
    }
    const priorQuantity = state.triggeredRunner?.priorQuantity ??
      state.entry.currentQuantity ?? state.entry.quantity;
    if (!sameDecimal(priorQuantity, state.entry.quantity)) {
      throw new Error("triggered_runner_prior_position_quantity_not_exact");
    }
    const residualQuantity = subtractDecimals(priorQuantity, state.runner.quantity);
    const failReconciliation = async (reason) => {
      state.triggeredRunner = {
        ...state.triggeredRunner,
        status: "reconciliation_incomplete",
        priorQuantity: String(priorQuantity),
        runnerOrderId: runnerId,
        observation: reason,
      };
      state.status = "runner_trigger_reconciliation_incomplete";
      await saveState(statePath, state);
      return state;
    };
    const startTs = Math.max(1, state.runner.startedAt - 60_000);
    const [runnerOrder, fills, positions, orders] = await Promise.all([
      api.queryOrder(SYMBOL, { orderId: runnerId }),
      api.queryFills(SYMBOL, {
        startTs, endTs: Date.now(), currency: "VST",
      }),
      api.getPositions(SYMBOL), api.getOpenOrders(SYMBOL),
    ]);
    if (!runnerOrder || runnerOrder.symbol !== API_SYMBOL ||
        runnerOrder.type !== "STOP_MARKET" ||
        runnerOrder.status !== "FILLED" || runnerOrder.side !== "SELL" ||
        runnerOrder.positionSide !== undefined && runnerOrder.positionSide !== "LONG" ||
        runnerOrder.workingType !== undefined &&
          runnerOrder.workingType !== "MARK_PRICE" ||
        !sameDecimalOrFalse(runnerOrder.origQty, state.runner.quantity) ||
        !sameDecimalOrFalse(runnerOrder.executedQty, state.runner.quantity)) {
      return failReconciliation("exact_runner_stop_not_confirmed_filled");
    }
    if (!Array.isArray(fills)) {
      return failReconciliation("runner_trigger_fill_query_unavailable");
    }
    const triggerIdKeys = ["triggerOrderId", "triggerOrderID"];
    const malformedTriggerIds = fills.some((fill) =>
      triggerIdKeys.some((key) => fill?.[key] !== undefined && fill[key] !== null) &&
      exactStringId(fill, triggerIdKeys) === null);
    if (malformedTriggerIds) {
      return failReconciliation("runner_fill_trigger_order_id_not_exact_string");
    }
    const triggeredFills = fills.filter((fill) =>
      exactStringId(fill, triggerIdKeys) === runnerId);
    if (triggeredFills.length !== 1) {
      return failReconciliation("runner_trigger_id_did_not_match_one_fill");
    }
    const fill = triggeredFills[0];
    const childFillId = exactStringId(fill);
    const queriedOrderId = exactStringId(runnerOrder);
    const directParentLookup = queriedOrderId === runnerId;
    const triggeredChildLookup = Boolean(childFillId) &&
      queriedOrderId === childFillId && childFillId !== runnerId;
    const identifiersAreExpectedOrZero = (row, { allowZero = false } = {}) => {
      const values = ["positionId", "positionID"].filter((key) =>
        row?.[key] !== undefined && row[key] !== null).map((key) => row[key]);
      if (!values.length) return true;
      if (values.every((value) => typeof value === "string" &&
          value === state.entry.positionId)) return true;
      return allowZero && values.every((value) => value === "0" || value === 0);
    };
    if ((!directParentLookup && !triggeredChildLookup) ||
        directParentLookup &&
          (runnerOrder.positionSide !== "LONG" ||
            runnerOrder.workingType !== "MARK_PRICE") ||
        !identifiersAreExpectedOrZero(runnerOrder, {
          allowZero: triggeredChildLookup,
        })) {
      return failReconciliation("runner_order_query_id_not_parent_or_exact_trigger_child");
    }
    const fillQuantity = fill.qty ?? fill.quantity ?? fill.volume;
    const fillPrice = fill.price ?? fill.tradePrice ?? fill.fillPrice;
    const feeAmount = fill.commission ?? fill.fee ?? fill.commissionAmount ?? fill.feeAmount;
    // VST fill rows use currency rather than a separate commissionAsset.
    const feeAsset = fill.commissionAsset ?? fill.feeAsset ?? fill.feeCurrency ?? fill.currency;
    if (!childFillId || fill.symbol !== API_SYMBOL || fill.side !== "SELL" ||
        fill.positionSide !== undefined && fill.positionSide !== "LONG" ||
        !identifiersAreExpectedOrZero(fill, { allowZero: true }) ||
        !sameDecimalOrFalse(fillQuantity, state.runner.quantity) ||
        !/^\d+(?:\.\d+)?$/.test(String(fillPrice)) ||
        !/^-?\d+(?:\.\d+)?$/.test(String(feeAmount)) ||
        typeof feeAsset !== "string" || !feeAsset) {
      return failReconciliation("runner_child_fill_or_fee_fields_not_exact");
    }
    let position;
    try { position = oneLong(positions); } catch {
      return failReconciliation("triggered_runner_residual_long_unverified");
    }
    if (positionId(position) !== state.entry.positionId ||
        !sameDecimalOrFalse(position.positionAmt, residualQuantity) ||
        !Array.isArray(orders)) {
      return failReconciliation("triggered_runner_position_delta_not_exact");
    }
    const orderIds = orders.map(exactId);
    if (orders.length !== 2 || orderIds.some((id) => !id) ||
        new Set(orderIds).size !== 2 || !orderIds.includes(coreId) ||
        !orderIds.includes(originalId)) {
      return failReconciliation("triggered_runner_residual_has_foreign_or_missing_stops");
    }
    const original = orders.filter((row) => exactId(row) === originalId);
    const core = orders.filter((row) => exactId(row) === coreId);
    const stopMatches = (row, expectedStop) => {
      try { return validateStop(row, expectedStop); } catch { return false; }
    };
    if (original.length !== 1 || core.length !== 1 ||
        !stopMatches(original[0], {
          id: originalId, posId: state.entry.positionId,
          quantity: residualQuantity, price: state.entry.signalStopPrice,
          parentId: state.entry.orderId,
        }) ||
        !stopMatches(core[0], {
          id: coreId, posId: state.entry.positionId,
          quantity: residualQuantity, price: state.core.stopPrice,
        })) {
      return failReconciliation("triggered_runner_core_or_original_stop_not_exactly_resized");
    }

    const actualFill = {
      orderId: childFillId, triggerOrderId: runnerId,
      symbol: fill.symbol, side: fill.side, quantity: String(fillQuantity),
      price: String(fillPrice), feeAmount: String(feeAmount), feeAsset,
      ...(orderCreatedAt(fill) ? { time: orderCreatedAt(fill) } : {}),
    };
    state.triggeredRunner = {
      status: "triggered_runner_fill_and_residual_protection_verified",
      runnerOrderId: runnerId, childFill: actualFill,
      priorQuantity: String(priorQuantity), fillQuantity: String(fillQuantity),
      residualQuantity, remainingQuantity: residualQuantity,
      positionId: state.entry.positionId,
      coreStopOrderId: coreId, originalStopOrderId: originalId,
      coreAndOriginalStopsRemainOpen: true,
      verifiedAt: Date.now(),
    };
    state.runner.status = "filled_triggered_verified";
    state.runner.triggeredFill = actualFill;
    state.entry.currentQuantity = residualQuantity;
    state.entry.positionVerified = true;
    state.status = "runner_triggered_residual_protected_emergency_close_available";
    await saveState(statePath, state);
    return state;
  }

  if (command === "emergency-close") {
    if (!state.entry.positionId && [
      "entry_intent_persisted", "entry_response_received_reconciling",
      "entry_reconciliation_incomplete", "entry_unknown_halt_no_retry",
    ].includes(state.status)) {
      const [positions, orders] = await Promise.all([
        api.getPositions(SYMBOL), api.getOpenOrders(SYMBOL),
      ]);
      const discovered = oneLong(positions);
      const discoveredId = positionId(discovered);
      const discoveredQuantity = String(discovered.positionAmt);
      const protective = Array.isArray(orders) && orders.length === 1 &&
        exactId(orders[0]) !== null && validateStop(orders[0], {
          id: exactId(orders[0]), posId: discoveredId,
          quantity: discoveredQuantity, price: state.entry.signalStopPrice,
          parentId: state.entry.orderId,
        });
      if (!protective) {
        throw new Error("uncertain_entry_emergency_close_requires_exact_protected_long");
      }
      state.entry.positionId = discoveredId;
      state.entry.currentQuantity = discoveredQuantity;
      state.entry.stopOrderId = exactId(orders[0]);
      state.entry.positionVerified = true;
      state.entry.emergencyDiscoveredProtectedPosition = true;
      state.status = "entry_position_known_stop_unknown";
      await saveState(statePath, state);
    }
    const canClose = ["entry_intent_persisted", "entry_response_received_reconciling",
      "entry_reconciliation_incomplete", "entry_verified_full_attached_stop",
      "split_blocked_be_not_below_fresh_mark",
      "split_blocked_signal_stop_not_below_fresh_mark",
      "entry_position_known_stop_unknown",
      "core_stop_verified_original_still_active", "both_replacement_stops_verified_original_still_active",
      "runner_triggered_residual_protected_emergency_close_available",
      "split_stops_active_original_canceled", "core_stop_unknown_halt_no_retry",
      "runner_stop_unknown_halt_no_retry", "original_stop_cancel_unknown_halt_no_retry",
      "entry_unknown_halt_no_retry"].includes(state.status) ||
      String(state.status).includes("_partial_close_verified_remaining_") ||
      Boolean(state.partialClose) && String(state.status).includes("_partial_close_");
    const positionQuantity = state.entry.currentQuantity ??
      (state.partialClose?.remainingPositionVerified
        ? state.partialClose.remainingQuantity : state.entry.quantity);
    const triggeredRunnerReady =
      state.status === "runner_triggered_residual_protected_emergency_close_available" &&
      state.triggeredRunner?.status ===
        "triggered_runner_fill_and_residual_protection_verified" &&
      state.triggeredRunner.positionId === state.entry.positionId &&
      state.triggeredRunner.remainingQuantity === positionQuantity &&
      state.triggeredRunner.runnerOrderId === state.runner?.orderId;
    if (!canClose || !state.entry.positionId || !positionQuantity ||
        state.status === "runner_triggered_residual_protected_emergency_close_available" &&
          !triggeredRunnerReady) {
      throw new Error("emergency_close_requires_known_persisted_position");
    }
    let position;
    if (triggeredRunnerReady) {
      const [positions, orders] = await Promise.all([
        api.getPositions(SYMBOL), api.getOpenOrders(SYMBOL),
      ]);
      try { position = oneLong(positions); } catch {
        throw new Error("emergency_close_triggered_runner_residual_unverified");
      }
      const originalId = state.triggeredRunner.originalStopOrderId;
      const coreId = state.triggeredRunner.coreStopOrderId;
      const original = Array.isArray(orders)
        ? orders.filter((row) => exactId(row) === originalId) : [];
      const core = Array.isArray(orders)
        ? orders.filter((row) => exactId(row) === coreId) : [];
      const stopMatches = (row, expected) => {
        try { return validateStop(row, expected); } catch { return false; }
      };
      if (positionId(position) !== state.entry.positionId ||
          !sameDecimalOrFalse(position.positionAmt, positionQuantity) ||
          !Array.isArray(orders) || orders.length !== 2 ||
          original.length !== 1 || core.length !== 1 ||
          !stopMatches(original[0], {
            id: originalId, posId: state.entry.positionId,
            quantity: positionQuantity, price: state.entry.signalStopPrice,
            parentId: state.entry.orderId,
          }) || !stopMatches(core[0], {
            id: coreId, posId: state.entry.positionId,
            quantity: positionQuantity, price: state.core.stopPrice,
          })) {
        throw new Error("emergency_close_triggered_runner_residual_or_protection_changed");
      }
    } else {
      position = oneLong(await api.getPositions(SYMBOL));
    }
    if (positionId(position) !== state.entry.positionId ||
        !sameDecimal(position.positionAmt, positionQuantity)) {
      throw new Error("emergency_close_known_position_does_not_match");
    }
    const close = {
      clientOrderId: randomClientId("vsplit_emergency"),
      quantity: String(position.positionAmt), positionId: state.entry.positionId,
      startedAt: Date.now(),
      status: "intent_persisted_no_retry",
    };
    state.emergencyClose = close;
    state.status = "emergency_close_submitting_no_retry";
    await saveState(statePath, state);
    try {
      authorize?.({ clientOrderId: close.clientOrderId, quantity: close.quantity });
      const response = triggeredRunnerReady
        ? await api.emergencyCloseVstLong({
            symbol: SYMBOL,
            quantity: close.quantity,
            clientOrderId: close.clientOrderId,
            expectedPositionId: state.entry.positionId,
          })
        : await api.closeLong(
            SYMBOL, close.quantity, close.clientOrderId, state.entry.positionId,
            { probePolicy: VST_BTC_HEDGE_LONG10_SHORT75_PROBE },
          );
      close.orderId = exactId(response);
      close.status = "submitted_reconcile_required";
      state.status = "emergency_close_submitted_reconcile_required";
    } catch (error) {
      close.status = "unknown_halt_no_retry";
      close.error = String(error?.message ?? "unknown").slice(0, 180);
      state.status = "emergency_close_unknown_halt_no_retry";
    }
    await saveState(statePath, state);
    return state;
  }

  if (command === "reconcile-close") {
    if (!state.emergencyClose || ![
      "emergency_close_submitting_no_retry",
      "emergency_close_submitted_reconcile_required", "emergency_close_unknown_halt_no_retry",
      "emergency_close_flat_or_orders_unverified",
      "emergency_close_cleanup_unknown_halt_no_retry",
      "emergency_close_reconciliation_incomplete",
    ].includes(state.status)) throw new Error("close_reconcile_requires_persisted_close_intent");
    if (state.triggeredRunner && (
      state.triggeredRunner.status !== "triggered_runner_fill_and_residual_protection_verified" ||
      state.triggeredRunner.runnerOrderId !== state.runner?.orderId ||
      state.triggeredRunner.positionId !== state.entry.positionId ||
      !sameDecimalOrFalse(state.emergencyClose.quantity,
        state.triggeredRunner.remainingQuantity) ||
      state.emergencyClose.positionId !== state.entry.positionId ||
      exactStringId(state.triggeredRunner.childFill) !==
        state.triggeredRunner.childFill?.orderId ||
      exactStringId(state.triggeredRunner.childFill, ["triggerOrderId"]) !==
        state.triggeredRunner.runnerOrderId
    )) {
      state.emergencyClose.reconciliation = "triggered_runner_child_fill_binding_unverified";
      state.status = "emergency_close_reconciliation_incomplete";
      await saveState(statePath, state);
      return state;
    }
    const start = Math.max(1, state.emergencyClose.startedAt - 60_000);
    const [history, positions, orders] = await Promise.all([
      api.queryOrderHistory(SYMBOL, { startTs: start, endTs: Date.now() }),
      api.getPositions(SYMBOL), api.getOpenOrders(SYMBOL),
    ]);
    const rows = Array.isArray(history) ? history : history?.orders;
    const matched = rows?.filter((row) =>
      [row.clientOrderId, row.clientOrderID].includes(state.emergencyClose.clientOrderId)) ?? [];
    if (matched.length !== 1) {
      state.emergencyClose.reconciliation = "exact_close_history_not_verified";
      state.status = "emergency_close_reconciliation_incomplete";
      await saveState(statePath, state);
      return state;
    }
    const closeOrder = matched[0];
    const id = exactId(closeOrder);
    if (!id || state.emergencyClose.orderId &&
        state.emergencyClose.orderId !== id ||
        closeOrder.symbol !== API_SYMBOL || closeOrder.side !== "SELL" ||
        closeOrder.positionSide !== "LONG" || closeOrder.type !== "MARKET" ||
        closeOrder.status !== "FILLED" ||
        !sameDecimal(closeOrder.origQty, state.emergencyClose.quantity) ||
        !sameDecimal(closeOrder.executedQty, state.emergencyClose.quantity)) {
      state.emergencyClose.reconciliation = "exact_full_close_order_not_yet_verified";
      state.status = "emergency_close_reconciliation_incomplete";
      await saveState(statePath, state);
      return state;
    }
    const fills = await api.queryFills(SYMBOL, {
      startTs: start, endTs: Date.now(), orderId: id, currency: "VST",
    });
    if (!Array.isArray(fills) || !fills.length ||
        fills.some((fill) => exactId(fill) !== id || fill.side !== "SELL" ||
          fill.symbol !== API_SYMBOL) ||
        !sameDecimal(sumDecimals(fills.map((fill) =>
          fill.qty ?? fill.quantity ?? fill.volume)), state.emergencyClose.quantity)) {
      state.emergencyClose.reconciliation = "exact_close_fills_not_yet_verified";
      state.status = "emergency_close_reconciliation_incomplete";
      await saveState(statePath, state);
      return state;
    }
    if (!Array.isArray(positions) || !Array.isArray(orders) ||
        positions.some((row) => !row || typeof row.symbol !== "string")) {
      state.emergencyClose.reconciliation = "position_or_open_order_snapshot_unavailable";
      state.status = "emergency_close_reconciliation_incomplete";
      await saveState(statePath, state);
      return state;
    }
    const btcPositions = positions.filter((row) => row.symbol === API_SYMBOL);
    const flat = btcPositions.every((row) =>
      /^-?\d+(?:\.\d+)?$/.test(String(row.positionAmt)) && Number(row.positionAmt) === 0);
    if (!flat || orders.length !== 0) {
      state.emergencyClose.reconciliation = "filled_but_flat_or_no_orders_not_verified";
      state.status = "emergency_close_flat_or_orders_unverified";
    } else {
      state.emergencyClose.orderId = id;
      state.emergencyClose.reconciliation = {
        status: "verified_flat_no_open_orders_fills",
        fillCount: fills.length, flatPositionRows: btcPositions.length,
        openOrderCount: 0, observedAt: Date.now(),
      };
      state.status = "emergency_close_verified_flat_no_orders_fills";
    }
    await saveState(statePath, state);
    return state;
  }

  if (command === "archive-closed") {
    if (state.status !== "emergency_close_verified_flat_no_orders_fills" ||
        state.emergencyClose?.reconciliation?.status !==
          "verified_flat_no_open_orders_fills") {
      throw new Error("archive_requires_independently_reconciled_emergency_close");
    }
    const positions = await api.getPositions(SYMBOL);
    if (!Array.isArray(positions) || positions.some((row) =>
      !row || typeof row.symbol !== "string" || row.symbol === API_SYMBOL &&
      (!/^-?\d+(?:\.\d+)?$/.test(String(row.positionAmt)) ||
       Number(row.positionAmt) !== 0))) {
      throw new Error("archive_fresh_flat_btc_snapshot_failed");
    }
    const orders = await api.getOpenOrders(SYMBOL);
    if (!Array.isArray(orders) || orders.length !== 0) {
      throw new Error("archive_fresh_no_open_orders_snapshot_failed");
    }
    const archivePath = `${statePath}.archive-${Date.now()}-${randomUUID()}`;
    await rename(statePath, archivePath);
    return { ...state, status: "archived_closed", archivePath };
  }

  if (command === "reconcile-partial-close") {
    const close = state.partialClose;
    if (!close || !["core", "runner"].includes(close.role) ||
        !["unknown_halt_no_retry", "market_intent_persisted_no_retry",
          "market_fill_and_remaining_stop_verified",
          "market_fill_and_position_verified_protection_missing"].includes(close.status)) {
      throw new Error("partial_close_reconcile_requires_persisted_market_intent");
    }
    const sizes = trancheSizes(state.entry.quantity, state.entry.quantityPrecision);
    const retainedRole = close.role === "core" ? "runner" : "core";
    if (!sameDecimal(close.quantity, sizes[close.role])) {
      close.reconciliation = "persisted_partial_quantity_does_not_match_exact_tranche";
      state.status = `${close.role}_partial_close_unknown_halt_no_retry`;
      await saveState(statePath, state);
      return state;
    }
    const expectedRemaining = sizes[retainedRole];
    const [history, positions, orders] = await Promise.all([
      api.queryOrderHistory(SYMBOL, {
        startTs: Math.max(1, close.startedAt - 60_000), endTs: Date.now(),
      }),
      api.getPositions(SYMBOL),
      api.getOpenOrders(SYMBOL),
    ]);
    const rows = Array.isArray(history) ? history : history?.orders;
    const matches = rows?.filter((row) =>
      [row.clientOrderId, row.clientOrderID].includes(close.clientOrderId)) ?? [];
    if (matches.length !== 1) {
      close.reconciliation = "partial_market_order_not_uniquely_found";
      state.status = `${close.role}_partial_close_unknown_halt_no_retry`;
      await saveState(statePath, state);
      return state;
    }
    const order = matches[0];
    const id = exactId(order);
    if (!id || close.responseOrderId && close.responseOrderId !== id ||
        order.symbol !== API_SYMBOL || order.side !== "SELL" ||
        order.positionSide !== "LONG" || order.type !== "MARKET" ||
        order.status !== "FILLED" || !sameDecimal(order.origQty, close.quantity) ||
        !sameDecimal(order.executedQty, close.quantity)) {
      close.reconciliation = "partial_market_order_not_exactly_filled";
      state.status = `${close.role}_partial_close_unknown_halt_no_retry`;
      await saveState(statePath, state);
      return state;
    }
    const fillRows = await api.queryFills(SYMBOL, {
      startTs: Math.max(1, close.startedAt - 60_000), endTs: Date.now(),
      orderId: id, currency: "VST",
    });
    if (!Array.isArray(fillRows) || !fillRows.length ||
        fillRows.some((fill) => fill.symbol !== API_SYMBOL ||
          exactId(fill) !== id || fill.side !== "SELL") ||
        !sameDecimal(sumDecimals(fillRows.map((fill) =>
          fill.qty ?? fill.quantity ?? fill.volume)), close.quantity)) {
      close.reconciliation = "partial_market_fills_not_yet_exact";
      state.status = `${close.role}_partial_close_unknown_halt_no_retry`;
      await saveState(statePath, state);
      return state;
    }
    let position;
    try { position = oneLong(positions); } catch {
      close.reconciliation = "exact_partial_fill_verified_but_no_single_open_long_position";
      state.status = `${close.role}_partial_close_position_unverified_emergency_manual_review`;
      await saveState(statePath, state);
      return state;
    }
    const retained = state[retainedRole];
    if (positionId(position) !== state.entry.positionId) {
      close.reconciliation = "exact_partial_fill_position_id_does_not_match";
      state.status = `${close.role}_partial_close_position_unverified_emergency_manual_review`;
      await saveState(statePath, state);
      return state;
    }
    const observedRemaining = String(position.positionAmt);
    close.orderId = id;
    close.positionId = positionId(position);
    close.remainingQuantity = observedRemaining;
    close.remainingPositionVerified = true;
    close.remainingPositionObservedAt = Date.now();
    close.reconciliation = "exact_partial_fill_and_live_position_identity_and_quantity_verified";
    state.entry.currentQuantity = observedRemaining;
    await saveState(statePath, state);
    const retainedStopVerified = Array.isArray(orders) &&
      orders.filter((row) => exactId(row) === retained.orderId).length === 1 &&
      orders.some((row) => validateStop(row, {
        id: retained.orderId, posId: state.entry.positionId,
        quantity: observedRemaining, price: retained.stopPrice,
      }));
    if (!sameDecimal(observedRemaining, expectedRemaining) || !retainedStopVerified) {
      close.status = "market_fill_and_position_verified_protection_missing";
      close.protectionReconciliation = !sameDecimal(observedRemaining, expectedRemaining)
        ? "observed_residual_quantity_differs_from_planned_tranche"
        : "retained_protective_stop_missing_or_not_exact";
      state.status = `${close.role}_partial_close_residual_unprotected_emergency_required`;
      await saveState(statePath, state);
      return state;
    }
    close.reconciliation =
      "exact_partial_fill_and_live_position_and_retained_stop_verified";
    if (!close.cancelIntent) {
      const closedStop = orders.filter((row) => exactId(row) === state[close.role].orderId);
      if (orders.length !== 2 || closedStop.length !== 1 ||
          !validateStop(closedStop[0], {
            id: state[close.role].orderId, posId: state.entry.positionId,
            quantity: state[close.role].quantity, price: state[close.role].stopPrice,
          })) {
        close.status = "market_fill_and_position_verified_protection_missing";
        close.protectionReconciliation = "exited_or_unexpected_open_stop_set";
        state.status = `${close.role}_partial_close_residual_unprotected_emergency_required`;
        await saveState(statePath, state);
        return state;
      }
      close.status = "market_fill_and_remaining_stop_verified";
      state.status = `${close.role}_partial_close_cleanup_ready`;
      await saveState(statePath, state);
      return state;
    }

    const [stopOrder, stopFills] = await Promise.all([
      api.queryOrder(SYMBOL, { orderId: state[close.role].orderId }),
      api.queryFills(SYMBOL, {
        startTs: Math.max(1, close.cancelIntent.startedAt - 60_000),
        endTs: Date.now(), orderId: state[close.role].orderId, currency: "VST",
      }),
    ]);
    const canceled = stopOrder &&
      exactId(stopOrder) === state[close.role].orderId &&
      ["CANCELED", "CANCELLED"].includes(stopOrder.status);
    const retainedOnly = orders.length === 1 &&
      validateStop(orders[0], {
        id: retained.orderId, posId: state.entry.positionId,
        quantity: expectedRemaining, price: retained.stopPrice,
      });
    const noStopFills = Array.isArray(stopFills) && stopFills.length === 0 &&
      (stopOrder.executedQty === undefined || sameDecimal(stopOrder.executedQty, "0"));
    if (canceled && retainedOnly && noStopFills) {
      close.cancelIntent.status = "canceled_no_fills_verified";
      close.cancelIntent.reconciledAfterAmbiguousResponse = true;
      close.status = "market_fill_and_remaining_stop_verified";
      close.retainedStopVerified = true;
      state.status = `${close.role}_partial_close_verified_remaining_${retainedRole}_protected`;
    } else {
      close.cancelIntent.status = "unknown_halt_no_retry";
      close.cancelIntent.observation = "partial_stop_delete_not_uniquely_verified";
      close.status = "unknown_halt_no_retry";
      state.status = `${close.role}_partial_close_cleanup_unknown_halt_no_retry`;
    }
    await saveState(statePath, state);
    return state;
  }

  if (command === "cleanup-partial-stop") {
    const close = state.partialClose;
    if (!close || !["core", "runner"].includes(close.role) ||
        close.status !== "market_fill_and_remaining_stop_verified" ||
        close.cancelIntent ||
        state.status !== `${close.role}_partial_close_cleanup_ready`) {
      throw new Error("partial_stop_cleanup_requires_reconciled_market_fill_without_prior_delete_intent");
    }
    const closedRole = close.role;
    const retainedRole = closedRole === "core" ? "runner" : "core";
    const closed = state[closedRole];
    const retained = state[retainedRole];
    const remainingQuantity = close.remainingQuantity;
    const [position, orders] = await Promise.all([
      api.getPositions(SYMBOL), api.getOpenOrders(SYMBOL),
    ]);
    const activePosition = oneLong(position);
    if (positionId(activePosition) !== state.entry.positionId ||
        !sameDecimal(activePosition.positionAmt, remainingQuantity) ||
        orders.length !== 2 ||
        !orders.some((row) => validateStop(row, {
          id: closed.orderId, posId: state.entry.positionId,
          quantity: closed.quantity, price: closed.stopPrice,
        })) ||
        !orders.some((row) => validateStop(row, {
          id: retained.orderId, posId: state.entry.positionId,
          quantity: remainingQuantity, price: retained.stopPrice,
        }))) {
      throw new Error("partial_stop_cleanup_prewrite_state_not_exact");
    }
    close.cancelIntent = {
      stopOrderId: closed.orderId, status: "persisted_no_retry", startedAt: Date.now(),
    };
    state.status = `${closedRole}_partial_close_cleanup_submitting_no_retry`;
    await saveState(statePath, state);
    try {
      authorize?.({ phase: "cleanup", stopOrderId: closed.orderId });
      const cleanup = await api.cancelVstSplitStopAfterPartial({
        symbol: SYMBOL,
        stopToCancel: {
          orderId: closed.orderId, quantity: closed.quantity,
          stopPrice: closed.stopPrice,
        },
        retainedStop: {
          orderId: retained.orderId, quantity: remainingQuantity,
          stopPrice: retained.stopPrice,
        },
        remainingQuantity, positionId: state.entry.positionId, tranche: closedRole,
        signalStopPrice: state.entry.signalStopPrice,
        breakEvenPrice: state.entry.actualEntryPrice,
      });
      close.cancelIntent.status = "canceled_no_fills_verified";
      close.cancelIntent.exchangeStatus = cleanup.status;
      close.retainedStopVerified = true;
      state.status = `${closedRole}_partial_close_verified_remaining_${retainedRole}_protected`;
    } catch (error) {
      close.cancelIntent.status = "unknown_halt_no_retry";
      close.cancelIntent.error = String(error?.message ?? "unknown").slice(0, 180);
      close.status = "unknown_halt_no_retry";
      state.status = `${closedRole}_partial_close_cleanup_unknown_halt_no_retry`;
    }
    await saveState(statePath, state);
    return state;
  }

  if (command === "reconcile-flat-stop") {
    const intent = state.flatStopCleanup?.[orderId];
    const knownIds = [
      state.entry.stopOrderId, state.core?.orderId, state.runner?.orderId,
    ].filter(Boolean);
    if (!state.emergencyClose || !intent || !knownIds.includes(orderId)) {
      throw new Error("flat_stop_reconcile_requires_persisted_known_delete_intent");
    }
    const [positions, orders, queried, fills] = await Promise.all([
      api.getPositions(SYMBOL), api.getOpenOrders(SYMBOL),
      api.queryOrder(SYMBOL, { orderId }),
      api.queryFills(SYMBOL, {
        startTs: Math.max(1, intent.startedAt - 60_000), endTs: Date.now(),
        orderId, currency: "VST",
      }),
    ]);
    const flat = Array.isArray(positions) && positions.every((row) =>
      row && typeof row.symbol === "string" && (row.symbol !== API_SYMBOL ||
        /^-?\d+(?:\.\d+)?$/.test(String(row.positionAmt)) &&
        Number(row.positionAmt) === 0));
    const remaining = Array.isArray(orders)
      ? orders.filter((row) => exactId(row) === orderId) : [];
    const canceled = queried && exactId(queried) === orderId &&
      ["CANCELED", "CANCELLED"].includes(queried.status);
    const noFills = Array.isArray(fills) && fills.length === 0 &&
      (queried?.executedQty === undefined || sameDecimal(queried.executedQty, "0"));
    if (flat && canceled && remaining.length === 0 && noFills) {
      intent.status = "canceled_no_fills_verified";
      intent.reconciledAfterAmbiguousResponse = true;
      intent.exchangeStatus = queried.status;
    } else {
      intent.status = "unknown_halt_no_retry";
      intent.observation = flat && remaining.length === 1 &&
        queried?.status === "NEW" ? "stop_still_open_delete_not_retried"
          : "flat_stop_delete_outcome_not_uniquely_verified";
      state.status = "emergency_close_cleanup_unknown_halt_no_retry";
    }
    await saveState(statePath, state);
    return state;
  }

  if (command === "cleanup-flat-stop") {
    const closeStatus = state.status;
    if (!state.emergencyClose || ![
      "emergency_close_flat_or_orders_unverified", "emergency_close_unknown_halt_no_retry",
      "emergency_close_cleanup_unknown_halt_no_retry",
    ].includes(closeStatus)) {
      throw new Error("flat_stop_cleanup_requires_emergency_close_reconciliation");
    }
    const knownIds = [
      state.entry.stopOrderId, state.core?.orderId, state.runner?.orderId,
    ].filter(Boolean);
    if (!orderId || !knownIds.includes(orderId)) {
      throw new Error("flat_stop_cleanup_order_id_must_be_persisted_known_stop");
    }
    state.flatStopCleanup ??= {};
    const existing = state.flatStopCleanup[orderId];
    if (existing) throw new Error("flat_stop_cleanup_intent_already_exists_no_retry");
    const intent = {
      orderId, startedAt: Date.now(), status: "persisted_no_retry",
    };
    state.flatStopCleanup[orderId] = intent;
    await saveState(statePath, state);
    try {
      authorize?.({ orderId });
      const result = await api.cancelVstProtectiveStopOnlyWhenFlat({
        symbol: SYMBOL, orderId, knownStopOrderIds: knownIds,
      });
      intent.status = "canceled_no_fills_verified";
      intent.exchangeStatus = result.status;
      await saveState(statePath, state);
    } catch (error) {
      intent.status = "unknown_halt_no_retry";
      intent.error = String(error?.message ?? "unknown").slice(0, 180);
      state.status = "emergency_close_cleanup_unknown_halt_no_retry";
      await saveState(statePath, state);
    }
    return state;
  }
  throw new Error("invalid_command");
}

export async function runCli(argv, dependencies = {}) {
  const [command, ...args] = argv;
  const flags = new Set();
  const values = {};
  for (let i = 0; i < args.length; i += 1) {
    const item = args[i];
    if (item === "--quantity" || item === "--max-price" ||
        item === "--stop-price" || item === "--tranche") {
      const key = item === "--tranche" ? "tranche" : item.slice(2).replaceAll("-", "");
      if (values[key] !== undefined || !args[i + 1]) throw new Error("invalid_arguments");
      values[key] = args[++i];
      if (item === "--tranche" && !["core", "runner"].includes(values[key])) {
        throw new Error("invalid_tranche");
      }
    } else if ([
      "--confirm-vst-only", "--confirm-entry", "--confirm-core-stop",
      "--confirm-runner-stop", "--confirm-cancel-original",
      "--confirm-partial-close", "--confirm-partial-stop-cleanup",
      "--confirm-emergency-close",
      "--confirm-flat-stop-cleanup",
    ].includes(item)) {
      if (flags.has(item)) throw new Error("invalid_arguments");
      flags.add(item);
    }
    else if (item === "--order-id") {
      if (values.orderId !== undefined || !args[i + 1]) throw new Error("invalid_arguments");
      values.orderId = args[++i];
    }
    else throw new Error("invalid_arguments");
  }
  const mutating = ["enter", "split-core", "split-runner", "cancel-original", "partial-close",
    "cleanup-partial-stop", "cleanup-flat-stop",
    "emergency-close"].includes(command);
  const permittedValues = {
    enter: ["quantity", "maxprice", "stopprice"],
    "partial-close": ["tranche"],
    "cleanup-partial-stop": [],
    "cleanup-flat-stop": ["orderId"],
    "reconcile-flat-stop": ["orderId"],
    "reconcile-split": ["tranche"],
    "reconcile-partial-close": ["tranche"],
  }[command] ?? [];
  if (Object.keys(values).some((name) => !permittedValues.includes(name))) {
    throw new Error("invalid_arguments");
  }
  const stageConfirmation = {
    enter: "--confirm-entry",
    "split-core": "--confirm-core-stop",
    "split-runner": "--confirm-runner-stop",
    "cancel-original": "--confirm-cancel-original",
    "partial-close": "--confirm-partial-close",
    "cleanup-partial-stop": "--confirm-partial-stop-cleanup",
    "cleanup-flat-stop": "--confirm-flat-stop-cleanup",
    "emergency-close": "--confirm-emergency-close",
  }[command];
  const stageConfirmations = [...flags].filter((flag) => flag !== "--confirm-vst-only");
  if (stageConfirmations.some((flag) => flag !== stageConfirmation) ||
      !mutating && flags.size > 0) throw new Error("invalid_arguments");
  if (mutating && (!flags.has("--confirm-vst-only") ||
      !flags.has(stageConfirmation))) throw new Error("confirmation_required");
  const stage = command === "enter" ? "entry"
    : command === "split-core" ? "split-core"
      : command === "split-runner" ? "split-runner"
        : command === "cancel-original" ? "cancel-original"
          : command === "partial-close" ? "partial-close"
            : command === "cleanup-partial-stop" ? "partial-close"
            : command === "cleanup-flat-stop" ? "cleanup-flat-stop"
              : command === "emergency-close" ? "emergency-close" : "read-only";
  let api = dependencies.api;
  let guardedFetch;
  if (!api) {
    guardedFetch = createVstGuardedFetch(dependencies.fetchImpl ?? globalThis.fetch, {
      stage, expected: {},
      onDiagnostic: ({ method, path, errorName }) => {
        console.error(JSON.stringify({ method, path, errorName }));
      },
    });
    api = createBingXLiveApi({
      environment: "vst",
      fetchImpl: guardedFetch,
      writePermission: ({ path, method }) =>
        path === ORDER_PATH &&
        (["cancel-original", "cleanup-flat-stop"].includes(stage)
          ? method === "DELETE"
          : stage === "partial-close" ? ["POST", "DELETE"].includes(method)
            : method === "POST"),
    });
  }
  let release;
  await mkdir(dirname(LOCK_PATH), { recursive: true });
  const handle = await open(LOCK_PATH, "wx", 0o600).catch(() => {
    throw new Error("vst_btc_operations_busy_or_locked");
  });
  release = async () => {
    await handle.close().catch(() => {});
    await unlink(LOCK_PATH).catch(() => {});
  };
  try {
    return await runProbe({
      command, api, statePath: dependencies.statePath ?? STATE_PATH,
      quantity: values.quantity, maxPrice: values.maxprice, stopPrice: values.stopprice,
      tranche: values.tranche,
      orderId: values.orderId,
      operatorConfirmed: flags.has("--confirm-vst-only") &&
        Boolean(stageConfirmation && flags.has(stageConfirmation)),
      authorize: guardedFetch?.authorize,
    });
  } finally {
    await release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error?.message ?? "probe_failed");
      process.exitCode = 1;
    });
}