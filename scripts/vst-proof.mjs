#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBingXLiveApi } from "../artifacts/api-server/src/bullet-bot/bingx-live-api.mjs";

const HOST = "https://open-api-vst.bingx.com";
const ORDER_PATH = "/openApi/swap/v2/trade/order";
const POSITION_MARGIN_PATH = "/openApi/swap/v2/trade/positionMargin";
const SYMBOL = "BTCUSDT";
const API_SYMBOL = "BTC-USDT";
const TOPUP_STOP_ORDER_ID = "2104112180806377472";
const TOPUP_POSITION_QUANTITY = "0.0006";
const TOPUP_STOP_PRICE = "83246.7";
const TOPUP_AMOUNT = "2";
const TOPUP_MARGIN_DRIFT_TOLERANCE = 0.2;
const MAX_TICKER_AGE_MS = 10_000;
const MAX_TICKER_FUTURE_SKEW_MS = 2_000;
const MAX_ENTRY_PLAN_AGE_MS = 60_000;
// VST-only operator reconciliation, never used to authorize a REAL retry.
// Allow exchange history to settle beyond the 5-second receive window before
// checking two independent snapshots of orders, fills and account exposure.
const MIN_ARCHIVE_HISTORY_MS = 2 * 60_000;
const LEGACY_ATTEMPT_TIMESTAMP_GRACE_MS = 30_000;
const MIN_RECV_WINDOW_ELAPSED_MS = 5_000;
const ARCHIVE_OBSERVATION_DELAY_MS = 1_000;
const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(WORKSPACE_ROOT, ".local/vst-proof-state.json");
export const SHARED_VST_BTC_LOCK = resolve(
  WORKSPACE_ROOT, ".local/vst-btc-operations.lock",
);

export function createGuardedFetch(fetchImpl, {
  stage, clientOrderId, expectedQuantity, expectedPositionSide,
} = {}) {
  let writeUsed = false;
  let writeNotAfter = Number.POSITIVE_INFINITY;
  let expectedEntryPrice = null;
  let entryPricePrecision = null;
  const guarded = async (input, init = {}) => {
    const url = new URL(input);
    const method = String(init.method ?? "GET").toUpperCase();
    if (url.origin !== HOST || url.protocol !== "https:") {
      throw new Error("VST host isolation rejected request");
    }
    if (method !== "GET") {
      if (stage === "margin-topup") {
        const requiredParams = [
          "symbol", "amount", "type", "positionSide", "recvWindow", "timestamp", "signature",
        ];
        const validWrite = !writeUsed && method === "POST" &&
          url.pathname === POSITION_MARGIN_PATH &&
          url.searchParams.get("symbol") === API_SYMBOL &&
          url.searchParams.get("amount") === TOPUP_AMOUNT &&
          url.searchParams.get("type") === "1" &&
          url.searchParams.get("positionSide") === "LONG" &&
          /^[0-9a-f]{64}$/.test(url.searchParams.get("signature") ?? "") &&
          /^\d+$/.test(url.searchParams.get("timestamp") ?? "") &&
          url.searchParams.get("recvWindow") === "5000" &&
          [...url.searchParams.keys()].every((key) => requiredParams.includes(key)) &&
          requiredParams.every((key) => url.searchParams.getAll(key).length === 1);
        if (!validWrite) throw new Error("VST margin write guard rejected request");
        // Consume permission before transport: a timeout is never retried.
        writeUsed = true;
      } else {
      const expectedSide = stage === "entry" ? "BUY"
        : ["emergency-close", "partial-close"].includes(stage) ? "SELL" : null;
      const requiredParams = [
        "symbol", "side", "positionSide", "type", "quantity", "clientOrderId",
        "recvWindow", "timestamp", "signature",
        ...(stage === "entry" ? ["price", "timeInForce", "stopLoss"] : []),
      ];
      const permittedParams = new Set([
        ...requiredParams,
        ...(stage === "emergency-close" || stage === "partial-close" ? ["reduceOnly"] : []),
      ]);
      let stopLossValid = stage !== "entry";
      if (stage === "entry") {
        try {
          const stopLoss = JSON.parse(url.searchParams.get("stopLoss"));
          stopLossValid = stopLoss?.type === "STOP_MARKET" &&
            Number.isFinite(Number(stopLoss.stopPrice)) && Number(stopLoss.stopPrice) > 0;
        } catch { stopLossValid = false; }
      }
      const validWrite = !writeUsed && method === "POST" && url.pathname === ORDER_PATH &&
        expectedSide !== null && url.searchParams.get("symbol") === API_SYMBOL &&
        url.searchParams.get("side") === expectedSide &&
        ["BOTH", "LONG"].includes(url.searchParams.get("positionSide")) &&
        (expectedPositionSide === undefined ||
          url.searchParams.get("positionSide") === expectedPositionSide) &&
        url.searchParams.get("type") === (stage === "entry" ? "LIMIT" : "MARKET") &&
        (expectedQuantity === undefined ||
          sameDecimal(url.searchParams.get("quantity"), expectedQuantity, "write_quantity")) &&
        (stage !== "entry" ||
          (url.searchParams.get("timeInForce") === "FOK" &&
           /^\d+(?:\.\d+)?$/.test(url.searchParams.get("price") ?? "") &&
           expectedEntryPrice !== null &&
           url.searchParams.get("price") === expectedEntryPrice)) &&
        url.searchParams.get("clientOrderId") === clientOrderId &&
        /^[0-9a-f]{64}$/.test(url.searchParams.get("signature") ?? "") &&
        /^\d+$/.test(url.searchParams.get("timestamp") ?? "") &&
        url.searchParams.get("recvWindow") === "5000" &&
        /^\d+(?:\.\d+)?$/.test(url.searchParams.get("quantity") ?? "") &&
        stopLossValid &&
        (stage !== "entry" || !url.searchParams.has("reduceOnly")) &&
        (stage !== "emergency-close" && stage !== "partial-close" ||
          !url.searchParams.has("reduceOnly") ||
          url.searchParams.get("reduceOnly") === "true") &&
        [...url.searchParams.keys()].every((key) => permittedParams.has(key)) &&
        [...permittedParams].every((key) => url.searchParams.getAll(key).length <= 1) &&
        requiredParams.every((key) => url.searchParams.has(key));
      if (!validWrite) throw new Error("VST write guard rejected request");
      if (Date.now() > writeNotAfter) throw new Error("VST write guard rejected stale plan");
      if (stage === "entry") {
        if (expectedEntryPrice === null || entryPricePrecision === null) {
          throw new Error("VST write guard lacks entry price bounds");
        }
        // API preflight GETs finish before this wrapper sees the only POST.
        // Refresh ask immediately before sending that signed order request.
        writeUsed = true;
        const quote = await readFreshVstAsk(async (tickerUrl, tickerOptions) => {
          const tickerTarget = new URL(tickerUrl);
          if (tickerTarget.origin !== HOST || tickerTarget.protocol !== "https:") {
            throw new Error("VST ticker host isolation rejected request");
          }
          let tickerResponse;
          try {
            tickerResponse = await fetchImpl(tickerUrl, {
              ...tickerOptions,
              redirect: "error",
            });
          } catch {
            throw new Error("VST ticker request or redirect rejected");
          }
          if (tickerResponse?.redirected === true) {
            throw new Error("VST ticker redirect rejected");
          }
          return tickerResponse;
        });
        const exactLimitPrice = Number(expectedEntryPrice);
        const roundingTick = 10 ** -entryPricePrecision;
        if (quote.ask > exactLimitPrice ||
            exactLimitPrice - quote.ask > quote.ask * 0.005 + roundingTick) {
          throw new Error("VST fresh ask outside FOK price bounds");
        }
      }
      // Consume permission before the network call: a timeout is never retried.
      writeUsed = true;
      }
    }
    let response;
    try {
      response = await fetchImpl(input, { ...init, redirect: "error" });
    } catch {
      throw new Error("VST fetch failed or redirect rejected");
    }
    if (response?.redirected === true) {
      throw new Error("VST redirect rejected");
    }
    return response;
  };
  guarded.setWriteNotAfter = (deadline) => { writeNotAfter = deadline; };
  guarded.setExpectedEntryPrice = (price, precision = 0) => {
    expectedEntryPrice = String(price);
    entryPricePrecision = precision;
  };
  return guarded;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = new Set(rest);
  const allowed = new Set([
    "--confirm-vst-only", "--confirm-archive-no-fill", "--confirm-archive-closed",
  ]);
  let quantity;
  let amount;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--quantity") {
      quantity = rest[index + 1];
      if (!quantity || quantity.startsWith("--")) throw new Error("invalid_arguments");
      index += 1;
      continue;
    }
    if (token === "--amount") {
      if (amount !== undefined) throw new Error("invalid_arguments");
      amount = rest[index + 1];
      if (!amount || amount.startsWith("--")) throw new Error("invalid_arguments");
      index += 1;
      continue;
    }
    if (!allowed.has(token)) throw new Error("invalid_arguments");
  }
  if (options.has("--confirm-vst-only") && ![
    "enter", "emergency-close", "archive-no-fill", "archive-closed", "partial-observe",
    "topup-observe",
  ].includes(command)) {
    throw new Error("invalid_arguments");
  }
  if (options.has("--confirm-archive-no-fill") && command !== "archive-no-fill") {
    throw new Error("invalid_arguments");
  }
  if (options.has("--confirm-archive-closed") && command !== "archive-closed") {
    throw new Error("invalid_arguments");
  }
  if ((command === "enter" || command === "emergency-close") &&
      !options.has("--confirm-vst-only")) throw new Error("confirmation_required");
  if (command === "archive-no-fill" &&
      (!options.has("--confirm-vst-only") || !options.has("--confirm-archive-no-fill"))) {
    throw new Error("confirmation_required");
  }
  if (command === "archive-closed" &&
      (!options.has("--confirm-vst-only") || !options.has("--confirm-archive-closed"))) {
    throw new Error("confirmation_required");
  }
  if (["emergency-close", "partial-observe"].includes(command) &&
      (typeof quantity !== "string" || !/^\d+(?:\.\d+)?$/.test(quantity))) {
    throw new Error("exact_quantity_required");
  }
  if (command === "partial-observe" && !options.has("--confirm-vst-only")) {
    throw new Error("confirmation_required");
  }
  if (command === "topup-observe" && !options.has("--confirm-vst-only")) {
    throw new Error("confirmation_required");
  }
  if (command === "topup-observe" && amount !== TOPUP_AMOUNT) {
    throw new Error("exact_topup_amount_required");
  }
  if (command !== "preview" && command !== "enter" && command !== "status" &&
      command !== "emergency-close" && command !== "archive-no-fill" &&
      command !== "archive-closed" && command !== "partial-observe" &&
      command !== "topup-observe") {
    throw new Error("invalid_command");
  }
  if (!["emergency-close", "partial-observe"].includes(command) &&
      quantity !== undefined) throw new Error("invalid_arguments");
  if (command !== "topup-observe" && amount !== undefined) throw new Error("invalid_arguments");
  return { command, quantity, amount };
}

function floorAtPrecision(value, places) {
  if (!Number.isFinite(value) || value <= 0) throw new Error("invalid_price");
  const fixed = value.toFixed(Math.min(places + 4, 16));
  const [whole, fraction = ""] = fixed.split(".");
  const retained = places ? fraction.slice(0, places).padEnd(places, "0") : "";
  return places ? `${whole}.${retained}` : whole;
}

export function computeFokPriceCap(ask, pricePrecision) {
  if (!Number.isFinite(ask) || ask <= 0 ||
      !Number.isInteger(pricePrecision) || pricePrecision < 0 || pricePrecision > 12) {
    throw new Error("invalid_price");
  }
  const cap = floorAtPrecision(ask * 1.005, pricePrecision);
  if (Number(cap) < ask ||
      Number(cap) > ask * 1.005 + Number.EPSILON * ask) {
    throw new Error("invalid_fok_price_cap");
  }
  return cap;
}

function floorQuantityAtPrecision(value, places) {
  if (!Number.isFinite(value) || value <= 0) throw new Error("invalid_quantity");
  const fixed = value.toFixed(Math.min(places + 6, 16));
  const [whole, fraction = ""] = fixed.split(".");
  const retained = places ? fraction.slice(0, places).padEnd(places, "0") : "";
  const text = places ? `${whole}.${retained}` : whole;
  return text.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function quantityUnitsAtPrecision(value, places, name = "quantity") {
  const parts = decimalParts(value, name);
  const targetScale = 10n ** BigInt(places);
  if (parts.scale > targetScale) {
    const divisor = parts.scale / targetScale;
    if (parts.units % divisor !== 0n) throw new Error(`invalid_${name}_precision`);
    return parts.units / divisor;
  }
  return parts.units * (targetScale / parts.scale);
}

function formatQuantityUnits(units, places) {
  const scale = 10n ** BigInt(places);
  const whole = units / scale;
  const fraction = String(units % scale).padStart(places, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function computeQuarterableQuantity(maximumQuantity, quantityPrecision) {
  if (!Number.isInteger(quantityPrecision) || quantityPrecision < 0 ||
      quantityPrecision > 12) throw new Error("invalid_quantity_precision");
  const maximum = floorQuantityAtPrecision(maximumQuantity, quantityPrecision);
  const maxUnits = quantityUnitsAtPrecision(maximum, quantityPrecision);
  const quarterableUnits = maxUnits - (maxUnits % 4n);
  if (quarterableUnits <= 0n) throw new Error("quarterable_quantity_unavailable");
  return formatQuantityUnits(quarterableUnits, quantityPrecision);
}

export function computeExactQuarterQuantity(positionQuantity, quantityPrecision) {
  if (!Number.isInteger(quantityPrecision) || quantityPrecision < 0 ||
      quantityPrecision > 12) throw new Error("invalid_quantity_precision");
  const positionUnits = quantityUnitsAtPrecision(
    positionQuantity, quantityPrecision, "position_quantity",
  );
  if (positionUnits <= 0n || positionUnits % 4n !== 0n) {
    throw new Error("quarter_quantity_unrepresentable");
  }
  return formatQuantityUnits(positionUnits / 4n, quantityPrecision);
}

function normalizeTime(value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return null;
  return time < 100_000_000_000 ? time * 1000 : time;
}

export async function readFreshVstAsk(fetchImpl, now = Date.now()) {
  const response = await fetchImpl(
    `${HOST}/openApi/swap/v2/quote/ticker?symbol=${encodeURIComponent(API_SYMBOL)}`,
    { method: "GET" },
  );
  if (!response.ok) throw new Error("ticker_read_failed");
  const payload = await response.json();
  if (payload?.code !== 0) throw new Error("ticker_read_failed");
  const data = Array.isArray(payload.data)
    ? payload.data.find((row) => row?.symbol === API_SYMBOL) : payload.data;
  const ask = Number(data?.askPrice);
  const timestamp = normalizeTime(
    data?.time ?? data?.timestamp ?? data?.closeTime ?? payload?.time,
  );
  if (!Number.isFinite(ask) || ask <= 0 || timestamp === null ||
      timestamp > now + MAX_TICKER_FUTURE_SKEW_MS ||
      now - timestamp > MAX_TICKER_AGE_MS) {
    throw new Error("ticker_stale_or_invalid");
  }
  return {
    ask,
    timestamp,
    checkedAtMs: now,
    ageMs: Math.max(0, now - timestamp),
    futureSkewMs: Math.max(0, timestamp - now),
  };
}

function makeClientOrderId(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

async function acquireLock() {
  await mkdir(dirname(SHARED_VST_BTC_LOCK), { recursive: true });
  const lockPath = SHARED_VST_BTC_LOCK;
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch {
    throw new Error("state_busy_or_locked");
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  };
}

async function readState() {
  let content;
  try {
    content = await readFile(STATE_PATH, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("state_unreadable");
  }
  let state;
  try {
    state = JSON.parse(content);
  } catch {
    throw new Error("state_invalid");
  }
  if (state?.environment !== "vst" || state?.symbol !== SYMBOL) {
    throw new Error("state_invalid");
  }
  return state;
}

export async function createExclusiveProofState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function createState(state) {
  return createExclusiveProofState(STATE_PATH, state);
}

async function updateState(state) {
  const tempPath = `${STATE_PATH}.${randomUUID()}.tmp`;
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, STATE_PATH);
  const directory = await open(dirname(STATE_PATH), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

function makeApi(stage, clientOrderId, guardOptions = {}) {
  const fetchImpl = createGuardedFetch(globalThis.fetch, {
    stage, clientOrderId, ...guardOptions,
  });
  return {
    fetchImpl,
    api: createBingXLiveApi({
      environment: "vst",
      fetchImpl,
      writePermission: ({ method, path }) =>
        method === "POST" &&
        ((path === ORDER_PATH &&
          ["entry", "emergency-close", "partial-close"].includes(stage)) ||
         (path === POSITION_MARGIN_PATH && stage === "margin-topup")),
    }),
  };
}

function safeErrorCode(error) {
  const code = error?.code;
  if ((typeof code === "number" && Number.isSafeInteger(code) && code >= 0) ||
      (typeof code === "string" && /^\d{1,12}$/.test(code))) {
    return String(code);
  }
  return "unclassified";
}

function safeTransportStage(error) {
  return [
    "pre_transport", "network_request", "response_parse", "exchange_response",
  ].includes(error?.transportStage) ? error.transportStage : "unknown";
}

async function buildPlan(fetchImpl, api) {
  const [ticker, filters, mode] = await Promise.all([
    readFreshVstAsk(fetchImpl),
    api.contract(SYMBOL),
    api.getPositionMode(),
  ]);
  const entryPrice = computeFokPriceCap(ticker.ask, filters.pricePrecision);
  const quantity = computeQuarterableQuantity(
    100 / Number(entryPrice), filters.quantityPrecision,
  );
  const stopLoss = floorAtPrecision(
    Number(entryPrice) * 0.98, filters.pricePrecision,
  );
  const notional = Number(quantity) * Number(entryPrice);
  if (!quantity || notional > 100 || notional / 10 > 10 || Number(stopLoss) >= Number(entryPrice)) {
    throw new Error("plan_exceeds_vst_limits");
  }
  const preflight = await api.preflight(SYMBOL, {
    requiredMargin: 10,
    quantity,
    entryPrice,
    stopLoss,
  });
  const ageMs = Date.now() - ticker.timestamp;
  if (ageMs < -MAX_TICKER_FUTURE_SKEW_MS || ageMs > MAX_TICKER_AGE_MS) {
    throw new Error("ticker_stale_or_invalid");
  }
  return {
    ticker: { ...ticker, ageMs: Math.max(0, ageMs), futureSkewMs: Math.max(0, -ageMs) },
    filters,
    mode,
    quantity,
    entryPrice,
    stopLoss,
    notional,
    initialMarginEstimate: notional / 10,
    preflight,
  };
}

function safePlan(plan) {
  const planReady = plan.preflight.status === "ready" &&
    plan.preflight.stopRisk?.safe === true &&
    Number(plan.preflight.plannedTopUpMargin ?? 0) === 0 &&
    plan.notional <= 100 && plan.initialMarginEstimate <= 10;
  return {
    status: planReady ? "ready" : "blocked",
    environment: "vst",
    symbol: SYMBOL,
    ask: plan.ticker.ask,
    tickerAgeMs: plan.ticker.ageMs,
    quantity: plan.quantity,
    entryPrice: plan.entryPrice,
    estimatedNotionalAtMaxPrice: plan.notional,
    estimatedInitialMarginAtMaxPrice: plan.initialMarginEstimate,
    maxEntryPrice: plan.entryPrice,
    timeInForce: "FOK",
    fillNotionalCapped: true,
    stopLoss: plan.stopLoss,
    quantityPrecision: plan.filters.quantityPrecision,
    pricePrecision: plan.filters.pricePrecision,
    positionMode: plan.mode,
    checks: plan.preflight.checks,
    blockers: [
      ...plan.preflight.blockers,
      ...(plan.preflight.stopRisk?.safe !== true ? ["stop_not_verified_safe"] : []),
      ...(Number(plan.preflight.plannedTopUpMargin ?? 0) !== 0 ? ["unfunded_top_up_plan"] : []),
      ...(plan.notional > 100 ? ["estimated_notional_over_100_vst"] : []),
      ...(plan.initialMarginEstimate > 10 ? ["initial_margin_over_10_vst"] : []),
    ],
    stopRisk: plan.preflight.stopRisk ? {
      safe: plan.preflight.stopRisk.safe,
      protectionAfterTopUp: plan.preflight.stopRisk.protectionAfterTopUp,
      plannedTopUpMargin: plan.preflight.stopRisk.plannedTopUpMargin,
      marginAsset: "VST",
      withinInitialNotionalLimit: plan.preflight.stopRisk.withinInitialNotionalLimit,
    } : null,
  };
}

function exactId(order) {
  const aliases = [order?.orderID, order?.orderId]
    .filter((value) => value !== undefined && value !== null);
  const normalized = aliases.map((id) => {
    if (typeof id === "string" && id.trim()) return id;
    if (Number.isSafeInteger(id)) return String(id);
    return null;
  });
  return normalized.length && normalized.every(Boolean) &&
    new Set(normalized).size === 1 ? normalized[0] : null;
}

function positiveDecimal(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function decimalParts(value, name = "decimal") {
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`invalid_${name}`);
  const fraction = match[2] ?? "";
  return { units: BigInt(`${match[1]}${fraction}`), scale: 10n ** BigInt(fraction.length) };
}

function sameDecimal(left, right, name = "decimal") {
  const a = decimalParts(left, name);
  const b = decimalParts(right, name);
  const scale = a.scale > b.scale ? a.scale : b.scale;
  return a.units * (scale / a.scale) === b.units * (scale / b.scale);
}

function compareDecimal(left, right, name = "decimal") {
  const a = decimalParts(left, name);
  const b = decimalParts(right, name);
  const scale = a.scale > b.scale ? a.scale : b.scale;
  const leftUnits = a.units * (scale / a.scale);
  const rightUnits = b.units * (scale / b.scale);
  return leftUnits < rightUnits ? -1 : leftUnits > rightUnits ? 1 : 0;
}

function sumDecimals(values) {
  const parts = values.map((value) => decimalParts(value, "fill_quantity"));
  if (!parts.length) return "0";
  const scale = parts.reduce((largest, part) => part.scale > largest ? part.scale : largest, 1n);
  const units = parts.reduce((sum, part) => sum + part.units * (scale / part.scale), 0n);
  const precision = String(scale).length - 1;
  const whole = units / scale;
  const fraction = String(units % scale).padStart(precision, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function clientIdOf(order) {
  const aliases = [order?.clientOrderId, order?.clientOrderID]
    .filter((value) => value !== undefined && value !== null);
  return aliases.length && new Set(aliases).size === 1 ? aliases[0] : null;
}

function fillClientIdIsCompatible(fill, expectedClientId) {
  const aliases = [fill?.clientOrderId, fill?.clientOrderID]
    .filter((value) => value !== undefined && value !== null);
  if (aliases.some((value) => typeof value !== "string") ||
      new Set(aliases).size > 1) return false;
  return aliases.every((value) => value === "" || value === expectedClientId);
}

function fillQuantity(fill) {
  return fill?.qty ?? fill?.quantity ?? fill?.volume;
}

async function queryOrderOrHistory(api, {
  clientOrderId, startTs, side, quantity, positionSide,
}) {
  try {
    return await api.queryOrder(SYMBOL, { clientOrderId });
  } catch (error) {
    if ((error?.code !== 109421 && error?.code !== "109421") ||
        error?.transportStage !== "exchange_response") throw error;
  }
  if (typeof api.queryOrderHistory !== "function") {
    throw new Error("order_history_unavailable");
  }
  const history = await api.queryOrderHistory(SYMBOL, {
    startTs: Math.max(1, startTs - 60_000),
    endTs: Math.max(1, Date.now()),
  });
  const rows = Array.isArray(history) ? history
    : Array.isArray(history?.orders) ? history.orders : null;
  if (!rows) throw new Error("order_history_invalid");
  const matches = rows.filter((row) => clientIdOf(row) === clientOrderId);
  if (matches.length !== 1) throw new Error("order_history_identity_unverified");
  const order = matches[0];
  if (order.symbol !== API_SYMBOL || order.side !== side || order.status !== "FILLED" ||
      positionSide !== order.positionSide ||
      !exactId(order) || !sameDecimal(order.origQty, quantity, "order_quantity") ||
      !sameDecimal(order.executedQty, quantity, "executed_quantity")) {
    throw new Error("order_history_identity_unverified");
  }
  return order;
}

function orderPositionSide(mode) {
  return mode === "HEDGE" ? "LONG" : mode === "ONE_WAY" ? "BOTH" : null;
}

function exactPositionId(row) {
  const aliases = [row?.positionId, row?.positionID]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => {
      if (typeof value === "string" && value.trim()) return value;
      if (Number.isSafeInteger(value)) return String(value);
      return null;
    });
  return aliases.length && aliases.every(Boolean) && new Set(aliases).size === 1
    ? aliases[0] : null;
}

function positionsForSymbol(rows) {
  if (!Array.isArray(rows) || rows.some((row) =>
    !row || typeof row !== "object" || typeof row.symbol !== "string")) return null;
  try {
    return rows.filter((row) => row.symbol === API_SYMBOL)
      .map((row) => ({ row, amount: decimalParts(row.positionAmt, "position_amount") }));
  } catch {
    return null;
  }
}

function exactLivePosition(rows, side) {
  const parsed = positionsForSymbol(rows);
  if (!parsed) return null;
  const nonzero = parsed.filter(({ amount }) => amount.units !== 0n);
  if (nonzero.length !== 1) return null;
  const { row, amount } = nonzero[0];
  if (amount.units < 0n || row.positionSide !== side || !exactPositionId(row)) return null;
  return row;
}

function flatSymbolPositions(rows) {
  const parsed = positionsForSymbol(rows);
  return parsed !== null && parsed.every(({ amount }) => amount.units === 0n);
}

function safePositionOverview(rows) {
  const parsed = positionsForSymbol(rows);
  if (!parsed || parsed.some(({ row, amount }) =>
    amount.units < 0n ||
    !["BOTH", "LONG", "SHORT"].includes(row.positionSide))) return null;
  const active = parsed.filter(({ amount }) => amount.units !== 0n);
  return {
    hasPosition: active.length > 0,
    ambiguous: active.length > 1,
  };
}

async function readExchangeOverview(api) {
  const [positions, orders] = await Promise.all([
    api.getPositions(SYMBOL),
    api.getOpenOrders(SYMBOL),
  ]);
  const positionSummary = safePositionOverview(positions);
  if (!positionSummary || !Array.isArray(orders)) return null;
  return {
    hasBtcPosition: positionSummary.hasPosition,
    positionAmbiguous: positionSummary.ambiguous,
    hasOpenOrders: orders.length > 0,
    openOrderCount: orders.length,
  };
}

export async function verifyEntry(api, state) {
  const expectedSide = orderPositionSide(state.entry.positionMode);
  const order = await queryOrderOrHistory(api, {
    clientOrderId: state.entry.clientOrderId,
    startTs: state.entry.attemptStartedAt ?? state.createdAt,
    side: "BUY",
    quantity: state.entry.quantity,
    positionSide: expectedSide,
  });
  const orderId = exactId(order);
  const positions = await api.getPositions(SYMBOL);
  const position = exactLivePosition(positions, expectedSide);
  if (order && ["EXPIRED", "CANCELED", "CANCELLED"].includes(order.status)) {
    try {
      const [orders, fills] = await Promise.all([
        api.getOpenOrders(SYMBOL),
        orderId ? api.queryFills(SYMBOL, {
          startTs: Math.max(1, state.createdAt - 60_000),
          endTs: Math.max(1, Date.now()),
          orderId,
          currency: "USDT",
        }) : Promise.reject(new Error("missing_order_id")),
      ]);
      const flat = flatSymbolPositions(positions) &&
        safePositionOverview(positions)?.hasPosition === false;
      const noFill = ["executedQty", "cumExecQty", "filledQty"].every((field) =>
        order[field] === undefined || sameDecimal(order[field], "0", "executed_quantity"));
      if (order.symbol === API_SYMBOL &&
          clientIdOf(order) === state.entry.clientOrderId &&
          order.side === "BUY" && order.positionSide === expectedSide &&
          order.type === "LIMIT" && order.timeInForce === "FOK" &&
          sameDecimal(order.price, state.entry.entryPrice, "order_price") &&
          sameDecimal(order.origQty, state.entry.quantity, "order_quantity") &&
          noFill && flat && orders.length === 0 && fills.length === 0) {
        return {
          status: "entry_no_fill_verified",
          protected: false,
          noFill: true,
          orderFound: true,
          positionFound: false,
          noOpenOrders: true,
        };
      }
    } catch {
      // Incomplete exchange evidence is an unknown outcome and stays fenced.
    }
  }
  if (!order || order.symbol !== API_SYMBOL || clientIdOf(order) !== state.entry.clientOrderId ||
      order.side !== "BUY" || order.positionSide !== expectedSide || order.status !== "FILLED" ||
      order.type !== "LIMIT" || order.timeInForce !== "FOK" ||
      !sameDecimal(order.price, state.entry.entryPrice, "order_price") ||
      !orderId || !position || !sameDecimal(order.origQty, state.entry.quantity, "order_quantity") ||
      !sameDecimal(order.executedQty, state.entry.quantity, "executed_quantity")) {
    return {
      status: "unverified", protected: false, orderFound: Boolean(orderId),
      positionFound: Boolean(position),
    };
  }
  const quantity = String(position.positionAmt);
  if (!sameDecimal(quantity, state.entry.quantity, "position_quantity")) {
    return { status: "unverified", protected: false, orderFound: true, positionFound: true };
  }
  let fills = [];
  try {
    fills = await api.queryFills(SYMBOL, {
      startTs: Math.max(1, state.createdAt - 60_000),
      endTs: Math.max(1, Date.now()),
      orderId,
      currency: "USDT",
    });
  } catch {
    return { status: "unverified", protected: false, orderFound: true, positionFound: true };
  }
  const validFills = fills.filter((fill) => fill.symbol === API_SYMBOL &&
    fill.side === "BUY" && exactId(fill) === orderId &&
    (fill.positionSide === undefined || fill.positionSide === expectedSide) &&
    fillClientIdIsCompatible(fill, state.entry.clientOrderId) &&
    positiveDecimal(fillQuantity(fill)) !== null);
  if (!validFills.length || validFills.length !== fills.length ||
      !sameDecimal(sumDecimals(validFills.map((fill) =>
    fillQuantity(fill))), order.executedQty, "fill_total")) {
    return { status: "unverified", protected: false, orderFound: true, positionFound: true };
  }
  try {
    const discovered = await api.discoverAttachedStop(SYMBOL, {
      entryOrderId: orderId,
      expectedStopPrice: state.entry.stopLoss,
      expectedQuantity: quantity,
    });
    if (discovered.verified !== true || !discovered.stopOrderId) {
      throw new Error("stop_discovery_unverified");
    }
    const orders = await api.getOpenOrders(SYMBOL);
    const matches = orders.filter((row) => exactId(row) === discovered.stopOrderId);
    if (matches.length !== 1) throw new Error("stop_identity_ambiguous");
    const stop = matches[0];
    const parentAliases = [stop.mainOrderId, stop.parentOrderId]
      .filter((value) => value !== undefined && value !== null && value !== "");
    const parentIsConsistent = new Set(parentAliases.map(String)).size <= 1;
    const parentLinked = parentAliases.length === 0 ||
      String(parentAliases[0]) === orderId;
    const linkedByPosition = exactPositionId(stop) !== null &&
      exactPositionId(stop) === exactPositionId(position);
    if (!parentIsConsistent || !parentLinked || !linkedByPosition ||
        stop.symbol !== API_SYMBOL || stop.type !== "STOP_MARKET" ||
        stop.status !== "NEW" || stop.side !== "SELL" ||
        stop.positionSide !== expectedSide ||
        !sameDecimal(stop.origQty, quantity, "stop_quantity") ||
        !sameDecimal(stop.stopPrice, state.entry.stopLoss, "stop_price") ||
        !(stop.closePosition === false || stop.closePosition === "false") ||
        stop.workingType !== "MARK_PRICE") {
      throw new Error("stop_linkage_unverified");
    }
    const coverage = await api.auditProtectiveStopCoverage(SYMBOL, {
      stopOrderId: discovered.stopOrderId,
      entryOrderId: orderId,
      expectedStopPrice: state.entry.stopLoss,
      expectedQuantity: quantity,
    });
    if (coverage.verified !== true || coverage.stopProtected !== true ||
        coverage.protectiveStopOrderId !== discovered.stopOrderId) {
      throw new Error("stop_coverage_unverified");
    }
    return {
      status: "protected",
      protected: true,
      orderFound: true,
      positionFound: true,
      stopFound: true,
      protectiveStopOrderId: discovered.stopOrderId,
      closePosition: false,
      dynamicRemainingCoverageProven: false,
    };
  } catch {
    return { status: "halted_unprotected_or_unknown", protected: false, orderFound: true, positionFound: true, stopFound: false };
  }
}

export async function verifyEmergencyClose(api, state) {
  const close = state?.emergencyClose;
  const expectedSide = orderPositionSide(close?.positionMode ?? state?.entry?.positionMode);
  if (!close?.clientOrderId || !close.quantity || !expectedSide) {
    return { verified: false, flat: false, noOpenOrders: false, closeFillFound: false };
  }
  try {
    const [positions, orders, order] = await Promise.all([
      api.getPositions(SYMBOL),
      api.getOpenOrders(SYMBOL),
      queryOrderOrHistory(api, {
        clientOrderId: close.clientOrderId,
        startTs: close.recordedAt ?? state.createdAt,
        side: "SELL",
        quantity: close.quantity,
        positionSide: expectedSide,
      }),
    ]);
    const flat = flatSymbolPositions(positions) &&
      safePositionOverview(positions)?.hasPosition === false;
    const closeOrderId = exactId(order);
    let fillsVerified = false;
    if (closeOrderId && order?.symbol === API_SYMBOL &&
        clientIdOf(order) === close.clientOrderId && order.side === "SELL" &&
        order.positionSide === expectedSide && order.status === "FILLED" &&
        order.type === "MARKET" &&
        sameDecimal(order.origQty, close.quantity, "close_orig_quantity") &&
        sameDecimal(order.executedQty, close.quantity, "close_executed_quantity")) {
      const fills = await api.queryFills(SYMBOL, {
        startTs: Math.max(1, (close.recordedAt ?? state.createdAt) - 60_000),
        endTs: Math.max(1, Date.now()),
        orderId: closeOrderId,
        currency: "USDT",
      });
      const matchingFills = fills.filter((fill) =>
        fill.symbol === API_SYMBOL && fill.side === "SELL" &&
        exactId(fill) === closeOrderId &&
        (fill.positionSide === undefined || fill.positionSide === expectedSide) &&
        fillClientIdIsCompatible(fill, close.clientOrderId) &&
        positiveDecimal(fillQuantity(fill)) !== null);
      fillsVerified = matchingFills.length > 0 && matchingFills.length === fills.length &&
        sameDecimal(sumDecimals(matchingFills.map(fillQuantity)),
          close.quantity, "close_fill_total");
    }
    const noOpenOrders = Array.isArray(orders) && orders.length === 0;
    return {
      verified: flat && noOpenOrders && fillsVerified,
      flat,
      noOpenOrders,
      closeFillFound: fillsVerified,
    };
  } catch {
    return { verified: false, flat: false, noOpenOrders: false, closeFillFound: false };
  }
}

export async function verifyPartialObservationEntry(api, state, currentAsk) {
  const expectedSide = orderPositionSide(state?.entry?.positionMode);
  if (!expectedSide || !state?.entry?.clientOrderId) {
    throw new Error("partial_entry_intent_missing");
  }
  const order = await queryOrderOrHistory(api, {
    clientOrderId: state.entry.clientOrderId,
    startTs: state.entry.attemptStartedAt ?? state.createdAt,
    side: "BUY",
    quantity: state.entry.quantity,
    positionSide: expectedSide,
  });
  const orderId = exactId(order);
  const [positions, orders, mode, marginType, leverage] = await Promise.all([
    api.getPositions(SYMBOL),
    api.getOpenOrders(SYMBOL),
    api.getPositionMode(),
    api.getMarginType(SYMBOL),
    api.getLeverage(SYMBOL),
  ]);
  const position = exactLivePosition(positions, expectedSide);
  if (!orderId || order?.symbol !== API_SYMBOL ||
      clientIdOf(order) !== state.entry.clientOrderId ||
      order.side !== "BUY" || order.positionSide !== expectedSide ||
      order.status !== "FILLED" || order.type !== "LIMIT" ||
      (order.timeInForce !== undefined && order.timeInForce !== "FOK") ||
      !sameDecimal(order.price, state.entry.entryPrice, "entry_price") ||
      !sameDecimal(order.origQty, state.entry.quantity, "entry_quantity") ||
      !sameDecimal(order.executedQty, state.entry.quantity, "entry_fill_quantity") ||
      !position || mode !== state.entry.positionMode || marginType !== "ISOLATED" ||
      leverage?.longLeverage !== 10 || leverage?.shortLeverage !== 10) {
    throw new Error("partial_entry_or_margin_not_verified");
  }
  const currentQuantity = String(position.positionAmt);
  const fills = await api.queryFills(SYMBOL, {
    startTs: Math.max(1, state.createdAt - 60_000),
    endTs: Date.now(),
    orderId,
    currency: "USDT",
  });
  const matchingFills = fills.filter((fill) => fill.symbol === API_SYMBOL &&
    fill.side === "BUY" && exactId(fill) === orderId &&
    (fill.positionSide === undefined || fill.positionSide === expectedSide) &&
    fillClientIdIsCompatible(fill, state.entry.clientOrderId) &&
    positiveDecimal(fillQuantity(fill)) !== null);
  if (!Array.isArray(fills) || matchingFills.length !== fills.length ||
      !matchingFills.length ||
      !sameDecimal(sumDecimals(matchingFills.map(fillQuantity)),
        order.executedQty, "entry_fill_total")) {
    throw new Error("partial_entry_fill_history_unverified");
  }
  if (!Array.isArray(orders) || orders.length !== 1) {
    throw new Error("partial_other_orders_present");
  }
  const stop = orders[0];
  const stopId = exactId(stop);
  const parentAliases = [stop.mainOrderId, stop.parentOrderId]
    .filter((value) => value !== undefined && value !== null && value !== "");
  if (!stopId || stop.symbol !== API_SYMBOL || stop.type !== "STOP_MARKET" ||
      stop.status !== "NEW" || stop.side !== "SELL" ||
      stop.positionSide !== expectedSide ||
      !sameDecimal(stop.origQty, currentQuantity, "partial_original_stop_quantity") ||
      !sameDecimal(stop.stopPrice, state.entry.stopLoss, "partial_stop_price") ||
      !(stop.closePosition === false || stop.closePosition === "false") ||
      stop.workingType !== "MARK_PRICE" ||
      exactPositionId(stop) !== exactPositionId(position) ||
      (parentAliases.length > 0 &&
       (new Set(parentAliases.map(String)).size !== 1 ||
        String(parentAliases[0]) !== orderId))) {
    throw new Error("partial_static_stop_not_verified");
  }
  const estimatedMargin = Number(currentQuantity) * Number(currentAsk) / 10;
  if (!Number.isFinite(Number(currentAsk)) || Number(currentAsk) <= 0 ||
      !Number.isFinite(estimatedMargin) || estimatedMargin <= 0 || estimatedMargin > 15 ||
      (Number.isFinite(Number(state.entry.initialMarginEstimate)) &&
       Number(state.entry.initialMarginEstimate) > 15)) {
    throw new Error("partial_margin_over_15_vst");
  }
  return {
    orderId,
    position,
    positionId: exactPositionId(position),
    positionSide: expectedSide,
    currentQuantity,
    stopOrderId: stopId,
    stop,
    estimatedMargin,
  };
}

export async function verifyPartialClose(api, state) {
  const partial = state?.partialObservation;
  if (!partial?.clientOrderId || !partial.quantity || !partial.stopOrderId) {
    return {
      verified: false, remainingPositionVerified: false,
      stopObservation: "unknown", emergencyCloseUrgency: true,
    };
  }
  try {
    const expectedSide = orderPositionSide(partial.positionMode ?? state.entry?.positionMode);
    const order = await queryOrderOrHistory(api, {
      clientOrderId: partial.clientOrderId,
      startTs: partial.recordedAt ?? state.createdAt,
      side: "SELL",
      quantity: partial.quantity,
      positionSide: expectedSide,
    });
    const orderId = exactId(order);
    if (!orderId || order?.symbol !== API_SYMBOL ||
        clientIdOf(order) !== partial.clientOrderId ||
        order.side !== "SELL" || order.positionSide !== expectedSide ||
        order.status !== "FILLED" || order.type !== "MARKET" ||
        !sameDecimal(order.origQty, partial.quantity, "partial_close_orig_quantity") ||
        !sameDecimal(order.executedQty, partial.quantity, "partial_close_executed_quantity")) {
      throw new Error("partial_close_order_unverified");
    }
    const fills = await api.queryFills(SYMBOL, {
      startTs: Math.max(1, (partial.recordedAt ?? state.createdAt) - 60_000),
      endTs: Date.now(),
      orderId,
      currency: "USDT",
    });
    const matchingFills = fills.filter((fill) => fill.symbol === API_SYMBOL &&
      fill.side === "SELL" && exactId(fill) === orderId &&
      (fill.positionSide === undefined || fill.positionSide === expectedSide) &&
      fillClientIdIsCompatible(fill, partial.clientOrderId) &&
      positiveDecimal(fillQuantity(fill)) !== null);
    if (!Array.isArray(fills) || matchingFills.length !== fills.length ||
        !matchingFills.length ||
        !sameDecimal(sumDecimals(matchingFills.map(fillQuantity)),
          partial.quantity, "partial_close_fill_total")) {
      throw new Error("partial_close_fill_unverified");
    }
    const [positions, openOrders, history] = await Promise.all([
      api.getPositions(SYMBOL),
      api.getOpenOrders(SYMBOL),
      api.queryOrderHistory(SYMBOL, {
        startTs: Math.max(1, (partial.recordedAt ?? state.createdAt) - 60_000),
        endTs: Date.now(),
      }),
    ]);
    const remaining = decimalParts(partial.originalQuantity, "partial_original_quantity");
    const closed = decimalParts(partial.quantity, "partial_close_quantity");
    const scale = remaining.scale > closed.scale ? remaining.scale : closed.scale;
    const remainingUnits = remaining.units * (scale / remaining.scale) -
      closed.units * (scale / closed.scale);
    if (remainingUnits <= 0n) throw new Error("partial_remaining_quantity_invalid");
    const expectedRemaining = (() => {
      const precision = String(scale).length - 1;
      const whole = remainingUnits / scale;
      const fraction = String(remainingUnits % scale).padStart(precision, "0")
        .replace(/0+$/, "");
      return fraction ? `${whole}.${fraction}` : String(whole);
    })();
    const position = exactLivePosition(positions, expectedSide);
    const remainingPositionIdentityVerified = Boolean(position &&
      (!partial.positionId || exactPositionId(position) === partial.positionId));
    const openStopRows = openOrders.filter((row) =>
      exactId(row) === partial.stopOrderId);
    const historyRows = Array.isArray(history) ? history.filter((row) =>
      exactId(row) === partial.stopOrderId) : [];
    let stopObservation = "unknown";
    let stopStatus = null;
    let stopQuantity = null;
    if (!Array.isArray(openOrders)) {
      stopObservation = "competing_or_unverified_open_orders";
    } else if (openOrders.length === 1 && openStopRows.length === 1) {
      const oldStop = openStopRows[0];
      stopStatus = oldStop.status ?? null;
      stopQuantity = oldStop.origQty ?? null;
      const oldStopIdentityVerified = oldStop.symbol === API_SYMBOL &&
        oldStop.type === "STOP_MARKET" && oldStop.side === "SELL" &&
        oldStop.positionSide === expectedSide &&
        exactPositionId(oldStop) === partial.positionId &&
        sameDecimal(oldStop.stopPrice, partial.stopPrice, "partial_stop_price") &&
        oldStop.workingType === "MARK_PRICE" &&
        (oldStop.closePosition === false || oldStop.closePosition === "false");
      if (!oldStopIdentityVerified) {
        stopObservation = "old_stop_identity_unverified";
      } else if (oldStop.status === "NEW" &&
          sameDecimal(oldStop.origQty, expectedRemaining, "partial_stop_quantity")) {
        stopObservation = "auto_resized_to_remaining";
      } else if (oldStop.status === "NEW" &&
          compareDecimal(oldStop.origQty, expectedRemaining, "partial_stop_quantity") > 0) {
        stopObservation = "still_oversized";
      } else {
        stopObservation = "active_stop_quantity_or_status_unexpected";
      }
    } else if (openOrders.length === 0 && historyRows.length === 1) {
      stopStatus = historyRows[0].status ?? null;
      stopQuantity = historyRows[0].origQty ?? null;
      stopObservation = ["CANCELED", "CANCELLED", "EXPIRED"].includes(stopStatus)
        ? "disappeared_or_auto_canceled" : "not_open_stop_status_unverified";
    } else if (openOrders.length > 1) {
      stopObservation = "competing_or_unverified_open_orders";
    } else if (openStopRows.length > 1 || historyRows.length > 1) {
      stopObservation = "old_stop_identity_ambiguous";
    } else if (openOrders.length === 0 && openStopRows.length === 0 &&
        historyRows.length === 0) {
      stopObservation = "old_stop_disappeared_from_open_orders";
    } else {
      stopObservation = "competing_or_unverified_open_orders";
    }
    const remainingPositionVerified = Boolean(position && remainingPositionIdentityVerified &&
      sameDecimal(position.positionAmt, expectedRemaining, "partial_remaining_position"));
    const verified = remainingPositionVerified && stopObservation === "auto_resized_to_remaining";
    return {
      verified,
      closeOrderId: orderId,
      closeFillVerified: true,
      remainingPositionVerified,
      expectedRemainingQuantity: expectedRemaining,
      observedRemainingQuantity: position?.positionAmt ?? null,
      stopOrderId: partial.stopOrderId,
      stopStatus,
      stopQuantity,
      stopObservation,
      protected: false,
      emergencyCloseUrgency: !verified,
    };
  } catch {
    return {
      verified: false,
      closeFillVerified: false,
      remainingPositionVerified: false,
      stopObservation: "unknown",
      protected: false,
      emergencyCloseUrgency: true,
    };
  }
}

function availableVstBalance(data) {
  const rows = Array.isArray(data) ? data
    : Array.isArray(data?.balance) ? data.balance
      : data?.balance && typeof data.balance === "object" ? [data.balance] : [];
  const vstRows = rows.filter((row) => row?.asset === "VST");
  if (vstRows.length !== 1) throw new Error("topup_vst_balance_unverified");
  const available = positiveDecimal(vstRows[0].availableMargin);
  if (available === null) throw new Error("topup_vst_balance_unverified");
  return String(vstRows[0].availableMargin);
}

function validateTopupState(state) {
  const partial = state?.partialObservation;
  const proof = partial?.proof;
  const initialMargin = Number(state?.entry?.initialMarginEstimate);
  if (state?.environment !== "vst" || state?.symbol !== SYMBOL ||
      state?.status !== "partial_observation_resized" ||
      partial?.stopOrderId !== TOPUP_STOP_ORDER_ID ||
      partial?.positionId == null ||
      proof?.verified !== true ||
      proof?.stopObservation !== "auto_resized_to_remaining" ||
      proof?.remainingPositionVerified !== true ||
      proof?.stopOrderId !== TOPUP_STOP_ORDER_ID ||
      !sameDecimal(proof.expectedRemainingQuantity, TOPUP_POSITION_QUANTITY,
        "topup_expected_quantity") ||
      !sameDecimal(partial.stopPrice, TOPUP_STOP_PRICE, "topup_expected_stop_price") ||
      !Number.isFinite(initialMargin) || initialMargin <= 0 || initialMargin > 10 ||
      state.marginTopUp?.clientOperationID) {
    throw new Error("topup_requires_partial_observation_resized_state");
  }
}

export async function verifyMarginTopUpObservation(api, state) {
  validateTopupState(state);
  const [positions, orders, mode, marginType, leverage] = await Promise.all([
    api.getPositions(SYMBOL),
    api.getOpenOrders(SYMBOL),
    api.getPositionMode(),
    api.getMarginType(SYMBOL),
    api.getLeverage(SYMBOL),
  ]);
  const position = exactLivePosition(positions, "LONG");
  if (!position || mode !== "HEDGE" || marginType !== "ISOLATED" ||
      leverage?.longLeverage !== 10 || leverage?.shortLeverage !== 10 ||
      !sameDecimal(position.positionAmt, TOPUP_POSITION_QUANTITY, "topup_position_quantity") ||
      exactPositionId(position) !== String(state.partialObservation.positionId) ||
      !Array.isArray(orders) || orders.length !== 1) {
    throw new Error("topup_position_or_margin_settings_unverified");
  }
  const stop = orders[0];
  if (exactId(stop) !== TOPUP_STOP_ORDER_ID || stop.symbol !== API_SYMBOL ||
      stop.type !== "STOP_MARKET" || stop.status !== "NEW" ||
      stop.side !== "SELL" || stop.positionSide !== "LONG" ||
      exactPositionId(stop) !== exactPositionId(position) ||
      !sameDecimal(stop.origQty, TOPUP_POSITION_QUANTITY, "topup_stop_quantity") ||
      !sameDecimal(stop.stopPrice, TOPUP_STOP_PRICE, "topup_stop_price") ||
      !(stop.closePosition === false || stop.closePosition === "false") ||
      stop.workingType !== "MARK_PRICE") {
    throw new Error("topup_exact_stop_unverified");
  }
  const margin = positiveDecimal(position.margin);
  if (margin === null) throw new Error("topup_position_margin_unverified");
  return {
    position,
    stop,
    positionId: exactPositionId(position),
    stopOrderId: exactId(stop),
    quantity: String(position.positionAmt),
    margin: String(position.margin),
  };
}

export async function runMarginTopUpObservation({
  api, state, statePath = STATE_PATH, amount = TOPUP_AMOUNT, operatorConfirmed = false,
} = {}) {
  if (operatorConfirmed !== true) throw new Error("confirmation_required");
  if (amount !== TOPUP_AMOUNT) throw new Error("exact_topup_amount_required");
  validateTopupState(state);
  const before = await verifyMarginTopUpObservation(api, state);
  const balanceBefore = availableVstBalance(await api.getBalance());
  if (compareDecimal(balanceBefore, amount, "topup_available_vst") < 0) {
    throw new Error("topup_insufficient_available_vst");
  }
  const conservativeMarginAfter = sumDecimals([
    before.margin, amount, String(TOPUP_MARGIN_DRIFT_TOLERANCE),
  ]);
  if (compareDecimal(conservativeMarginAfter, "15", "topup_total_margin") > 0) {
    throw new Error("topup_margin_over_15_vst");
  }
  const clientOperationID = makeClientOrderId("vmt");
  state.status = "margin_topup_submitting";
  state.marginTopUp = {
    clientOperationID,
    amount,
    marginBefore: before.margin,
    marginField: "margin",
    marginChangeApproximate: true,
    conservativeMarginAfterEstimate: conservativeMarginAfter,
    recordedAt: Date.now(),
    status: "submitting",
    transportIdempotency: false,
  };
  await persistStateAt(statePath, state);

  try {
    await api.addIsolatedMargin(SYMBOL, amount, clientOperationID);
    const after = await verifyMarginTopUpObservation(api, {
      ...state,
      status: "partial_observation_resized",
      marginTopUp: undefined,
    });
    const observedMarginDelta = Number(
      (Number(after.margin) - Number(before.margin)).toFixed(8),
    );
    if (!Number.isFinite(observedMarginDelta) ||
        observedMarginDelta < Number(amount) - TOPUP_MARGIN_DRIFT_TOLERANCE ||
        observedMarginDelta > Number(amount) + TOPUP_MARGIN_DRIFT_TOLERANCE ||
        after.stopOrderId !== before.stopOrderId ||
        !sameDecimal(after.quantity, before.quantity, "topup_position_quantity") ||
        after.positionId !== before.positionId) {
      throw new Error("topup_post_state_mismatch");
    }
    state.status = "margin_topup_verified";
    state.marginTopUp.status = "verified";
    state.marginTopUp.marginAfter = after.margin;
    state.marginTopUp.observedMarginDelta = observedMarginDelta;
    state.marginTopUp.observedMarginDeltaApproximate = true;
    state.marginTopUp.stopOrderId = after.stopOrderId;
    await persistStateAt(statePath, state);
    return {
      status: state.status,
      symbol: SYMBOL,
      amount,
      marginBefore: before.margin,
      marginAfter: after.margin,
      observedMarginDelta,
      marginChangeApproximate: true,
      stopOrderId: after.stopOrderId,
      clientOperationID,
    };
  } catch {
    state.status = "margin_topup_unknown_halt_no_retry";
    state.marginTopUp.status = "unknown";
    await persistStateAt(statePath, state);
    return {
      status: state.status,
      symbol: SYMBOL,
      amount,
      marginBefore: before.margin,
      marginChangeApproximate: true,
      clientOperationID,
      instruction: "Do not retry; emergency-close remains available.",
    };
  }
}

async function preview() {
  const { api, fetchImpl } = makeApi("read-only");
  const plan = await buildPlan(fetchImpl, api);
  return safePlan(plan);
}

async function enter() {
  const releaseLock = await acquireLock();
  try {
    if (await readState()) throw new Error("existing_state_blocks_new_entry");
    const clientOrderId = makeClientOrderId("ve");
    const { api, fetchImpl } = makeApi("entry", clientOrderId);
    const plan = await buildPlan(fetchImpl, api);
    if (plan.preflight.status !== "ready" ||
        plan.preflight.stopRisk?.safe !== true ||
        Number(plan.preflight.plannedTopUpMargin ?? 0) !== 0 ||
        plan.notional > 100 ||
        plan.initialMarginEstimate > 10) {
      throw new Error("preflight_blocked");
    }
    fetchImpl.setExpectedEntryPrice(plan.entryPrice, plan.filters.pricePrecision);
    fetchImpl.setWriteNotAfter(plan.ticker.checkedAtMs + MAX_ENTRY_PLAN_AGE_MS);
    const state = {
      version: 1,
      environment: "vst",
      symbol: SYMBOL,
      createdAt: Date.now(),
      status: "entry_submitting",
      entry: {
        clientOrderId,
        quantity: plan.quantity,
        entryPrice: plan.entryPrice,
        stopLoss: plan.stopLoss,
        positionMode: plan.mode,
        initialMarginEstimate: plan.initialMarginEstimate,
      },
    };
    // Exclusive create and fsync complete before the only permitted POST.
    await createState(state);
    try {
      const response = await api.placeVstBoundedLong({
        symbol: SYMBOL,
        quantity: plan.quantity,
        maxPrice: plan.entryPrice,
        stopLoss: plan.stopLoss,
        clientOrderId,
        onAttemptStarted: async (timestamp) => {
          state.entry.attemptStartedAt = timestamp;
          await updateState(state);
        },
      });
      state.status = "entry_submitted_reconciling";
      state.entry.orderId = exactId(response);
      await updateState(state);
    } catch (error) {
      state.status = "entry_unknown_halt_no_retry";
      state.entry.lastError = {
        code: safeErrorCode(error),
        transportStage: safeTransportStage(error),
      };
      await updateState(state);
      try {
        const proof = await verifyEntry(api, state);
        if (proof.protected || proof.status === "entry_no_fill_verified") {
          state.status = proof.protected ? "protected" : "entry_no_fill_verified";
          state.proof = proof;
          await updateState(state);
          return {
            status: state.status,
            symbol: SYMBOL,
            protected: proof.protected,
            noFillVerified: proof.status === "entry_no_fill_verified",
            clientOrderId,
            stopIndependentlyVerified: proof.stopFound === true,
            closePosition: proof.closePosition ?? null,
            dynamicRemainingCoverageProven: proof.dynamicRemainingCoverageProven ?? false,
          };
        }
        state.proof = proof;
        await updateState(state);
      } catch {
        // The outcome remains unknown and fenced; never retry this client ID.
      }
      return {
        status: state.status,
        symbol: SYMBOL,
        protected: false,
        clientOrderId,
        instruction: "Do not retry; reconcile manually with read-only status.",
      };
    }
    try {
      const proof = await verifyEntry(api, state);
      state.status = proof.protected ? "protected"
        : proof.status === "entry_no_fill_verified" ? proof.status
          : "halted_unprotected_or_unknown";
      state.proof = proof;
      await updateState(state);
      return {
        status: state.status,
        symbol: SYMBOL,
        protected: proof.protected,
        clientOrderId,
        stopIndependentlyVerified: proof.stopFound === true,
        closePosition: proof.closePosition ?? null,
        dynamicRemainingCoverageProven: proof.dynamicRemainingCoverageProven ?? false,
      };
    } catch {
      state.status = "halted_unprotected_or_unknown";
      state.proof = { protected: false };
      await updateState(state);
      return { status: state.status, symbol: SYMBOL, protected: false, clientOrderId };
    }
  } finally {
    await releaseLock();
  }
}

export async function inspectStatus(state, api) {
  if (!state) {
    try {
      const exchange = await readExchangeOverview(api);
      return exchange
        ? { status: "no_vst_proof_state", environment: "vst", symbol: SYMBOL, protected: false, exchange }
        : { status: "exchange_state_unknown", environment: "vst", symbol: SYMBOL, protected: false };
    } catch {
      return { status: "exchange_state_unknown", environment: "vst", symbol: SYMBOL, protected: false };
    }
  }
  const base = {
    environment: "vst",
    symbol: SYMBOL,
    protected: false,
    entryIntentRecorded: Boolean(state.entry?.clientOrderId),
    emergencyCloseIntentRecorded: Boolean(state.emergencyClose?.clientOrderId),
    ...(state.entry?.lastError ? {
      lastEntryDiagnostic: {
        code: safeErrorCode(state.entry.lastError),
        transportStage: safeTransportStage(state.entry.lastError),
      },
    } : {}),
  };
  if (state.partialObservation?.clientOrderId &&
      !state.emergencyClose?.clientOrderId) {
    const proof = await verifyPartialClose(api, state);
    return {
      ...base,
      status: proof.verified ? "partial_observation_resized" : "partial_observation_unsafe",
      protected: false,
      partialObservationProof: proof,
      emergencyCloseUrgency: proof.emergencyCloseUrgency === true,
      instruction: proof.emergencyCloseUrgency
        ? "Position remains open; operator emergency-close is urgent."
        : "Partial-close behavior observed; position remains open for operator action.",
    };
  }
  if (state.status === "closed_verified") {
    try {
      const exchange = await readExchangeOverview(api);
      const verified = exchange !== null && !exchange.hasBtcPosition && !exchange.hasOpenOrders &&
        !exchange.positionAmbiguous;
      return {
        ...base,
        status: verified ? "closed_verified" : "closed_state_no_longer_verified",
        exchange: exchange ?? { state: "unknown" },
      };
    } catch {
      return { ...base, status: "closed_state_unknown", exchange: { state: "unknown" } };
    }
  }
  if (state.emergencyClose?.clientOrderId) {
    const proof = await verifyEmergencyClose(api, state);
    return {
      ...base,
      status: proof.verified ? "closed_verified" : "emergency_close_unresolved",
      protected: false,
      flatVerified: proof.verified,
      closeProof: proof,
    };
  }
  if (state.status === "entry_no_fill_verified" && state.entry?.clientOrderId) {
    try {
      const proof = await verifyEntry(api, state);
      const terminal = proof.status === "entry_no_fill_verified";
      return {
        ...base,
        status: terminal ? "entry_no_fill_verified" : "entry_intent_unresolved",
        protected: false,
        noFillVerified: terminal,
      };
    } catch {
      return { ...base, status: "entry_intent_unresolved", reconciliation: "unknown" };
    }
  }
  if (state.status !== "protected" || !state.entry?.clientOrderId) {
    try {
      if (state.entry?.clientOrderId) {
        const proof = await verifyEntry(api, state);
        if (proof.status === "entry_no_fill_verified") {
          return {
            ...base,
            status: "entry_no_fill_verified",
            protected: false,
            noFillVerified: true,
            entryProof: proof,
          };
        }
        if (proof.protected) {
          return {
            ...base,
            status: "protected",
            protected: true,
            independentActiveStopVerified: true,
            closePosition: proof.closePosition,
            dynamicRemainingCoverageProven: proof.dynamicRemainingCoverageProven,
            entryProof: proof,
          };
        }
      }
      const exchange = await readExchangeOverview(api);
      return {
        ...base,
        status: "entry_intent_unresolved",
        exchange: exchange ?? { state: "unknown" },
      };
    } catch {
      return { ...base, status: "entry_intent_unresolved", exchange: { state: "unknown" } };
    }
  }
  try {
    const proof = await verifyEntry(api, state);
    const stopVerified = proof.protected === true &&
      state.proof?.protectiveStopOrderId === proof.protectiveStopOrderId;
    return {
      ...base,
      status: stopVerified ? "protected" : "protected_state_no_longer_verified",
      protected: stopVerified,
      entryOrderFound: proof.orderFound,
      matchingPositionFound: proof.positionFound,
      independentActiveStopVerified: proof.stopFound === true,
      stopIdentityMatchesState: stopVerified,
      closePosition: proof.closePosition ?? null,
      dynamicRemainingCoverageProven: proof.dynamicRemainingCoverageProven ?? false,
    };
  } catch {
    return {
      ...base,
      status: "protected_state_no_longer_verified",
      protected: false,
      reconciliation: "unknown",
    };
  }
}

async function status() {
  const state = await readState();
  const { api } = makeApi("read-only");
  const result = await inspectStatus(state, api);
  if (state && result.entryProof &&
      ["protected", "entry_no_fill_verified"].includes(result.status)) {
    state.status = result.status;
    state.proof = result.entryProof;
    await updateState(state);
  } else if (state && result.status === "closed_verified" &&
      state.emergencyClose?.clientOrderId) {
    state.status = "closed_verified";
    state.emergencyClose.proof = result.closeProof;
    await updateState(state);
  }
  return result;
}

export async function verifyUnknownEntryNoFillForArchive(
  api,
  state,
  { clock = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
) {
  const hasRecordedAttemptTime = state?.entry?.attemptStartedAt !== undefined &&
    state?.entry?.attemptStartedAt !== null;
  const recordedAttemptStartedAt = Number(state?.entry?.attemptStartedAt);
  const hasPreciseAttemptTime = Number.isSafeInteger(recordedAttemptStartedAt) &&
    recordedAttemptStartedAt > 0;
  const attemptStartedAt = hasRecordedAttemptTime
    ? recordedAttemptStartedAt : Number(state?.createdAt);
  if (state?.environment !== "vst" || state?.symbol !== SYMBOL ||
      state?.status !== "entry_unknown_halt_no_retry" ||
      typeof state?.entry?.clientOrderId !== "string" ||
      (hasRecordedAttemptTime && !hasPreciseAttemptTime) ||
      !Number.isSafeInteger(attemptStartedAt) || attemptStartedAt <= 0) {
    throw new Error("archive_requires_unknown_entry_state");
  }
  const requiredHistoryMs = MIN_ARCHIVE_HISTORY_MS +
    (hasPreciseAttemptTime ? 0 : LEGACY_ATTEMPT_TIMESTAMP_GRACE_MS);
  const requiredMethods = [
    "getPositions", "getOpenOrders", "queryOrder", "queryOrderHistory", "queryFills",
  ];
  if (requiredMethods.some((name) => typeof api?.[name] !== "function")) {
    throw new Error("archive_evidence_unavailable");
  }
  if (clock() - attemptStartedAt < requiredHistoryMs) {
    throw new Error("archive_history_window_too_short");
  }
  if (clock() - attemptStartedAt < MIN_RECV_WINDOW_ELAPSED_MS) {
    await sleep(MIN_RECV_WINDOW_ELAPSED_MS - (clock() - attemptStartedAt));
  }
  if (clock() - attemptStartedAt < MIN_RECV_WINDOW_ELAPSED_MS) {
    throw new Error("archive_recv_window_not_elapsed");
  }

  const observe = async () => {
    let orderNotFound = false;
    try {
      const order = await api.queryOrder(SYMBOL, {
        clientOrderId: state.entry.clientOrderId,
      });
      if (order !== null && order !== undefined) {
        throw new Error("archive_order_lookup_not_absent");
      }
    } catch (error) {
      if (error?.code === 109421 || error?.code === "109421") {
        if (error?.transportStage !== "exchange_response") {
          throw new Error("archive_order_lookup_not_found_unrecognized");
        }
        orderNotFound = true;
      } else if (/^archive_/.test(error?.message ?? "")) {
        throw error;
      } else {
        throw new Error("archive_evidence_unavailable");
      }
    }
    if (!orderNotFound) throw new Error("archive_order_lookup_not_found_unrecognized");

    let positions;
    let openOrders;
    try {
      [positions, openOrders] = await Promise.all([
        api.getPositions(SYMBOL),
        api.getOpenOrders(SYMBOL),
      ]);
    } catch {
      throw new Error("archive_evidence_unavailable");
    }
    const initialPositionSummary = safePositionOverview(positions);
    if (!flatSymbolPositions(positions) ||
        initialPositionSummary?.hasPosition !== false ||
        initialPositionSummary?.ambiguous !== false ||
        !Array.isArray(openOrders) || openOrders.length !== 0) {
      throw new Error("archive_btc_not_flat_or_has_open_orders");
    }
    const endTs = clock();
    let history;
    let vstFills;
    let usdtFills;
    try {
      [history, vstFills, usdtFills] = await Promise.all([
        api.queryOrderHistory(SYMBOL, { startTs: attemptStartedAt, endTs }),
        api.queryFills(SYMBOL, {
          startTs: attemptStartedAt, endTs, currency: "VST",
        }),
        api.queryFills(SYMBOL, {
          startTs: attemptStartedAt, endTs, currency: "USDT",
        }),
      ]);
    } catch {
      throw new Error("archive_evidence_unavailable");
    }
    let finalPositions;
    let finalOrders;
    try {
      [finalPositions, finalOrders] = await Promise.all([
        api.getPositions(SYMBOL),
        api.getOpenOrders(SYMBOL),
      ]);
    } catch {
      throw new Error("archive_evidence_unavailable");
    }
    const finalPositionSummary = safePositionOverview(finalPositions);
    if (!flatSymbolPositions(finalPositions) ||
        finalPositionSummary?.hasPosition !== false ||
        finalPositionSummary?.ambiguous !== false ||
        !Array.isArray(finalOrders) || finalOrders.length !== 0) {
      throw new Error("archive_btc_not_flat_or_has_open_orders");
    }
    if (!Array.isArray(history) || history.some((row) =>
      !row || typeof row !== "object" || row.symbol !== API_SYMBOL ||
      typeof clientIdOf(row) !== "string")) {
      throw new Error("archive_order_history_invalid");
    }
    if (history.some((row) => clientIdOf(row) === state.entry.clientOrderId)) {
      throw new Error("archive_client_order_id_found");
    }
    if (!Array.isArray(vstFills) || !Array.isArray(usdtFills) ||
        vstFills.length !== 0 || usdtFills.length !== 0) {
      throw new Error("archive_btc_fills_found_or_unknown");
    }
    return {
      observedAt: clock(),
      allOrdersWindowEnd: endTs,
      flatBtc: true,
      noOpenOrders: true,
      clientOrderIdAbsentFromAllOrders: true,
      zeroBtcFillsVst: true,
      zeroBtcFillsUsdt: true,
      signedOrderLookupNotFoundCode: "109421",
    };
  };

  const observations = [await observe()];
  await sleep(ARCHIVE_OBSERVATION_DELAY_MS);
  observations.push(await observe());
  if (observations[1].observedAt - observations[0].observedAt <
      ARCHIVE_OBSERVATION_DELAY_MS) {
    throw new Error("archive_observations_too_close");
  }
  return {
    checkedAt: clock(),
    attemptStartedAt,
    attemptTimestampSource: hasPreciseAttemptTime
      ? "durable_pre_transport_marker" : "durable_entry_intent_with_safety_grace",
    allOrdersWindowStart: attemptStartedAt,
    allOrdersWindowEnd: observations[1].allOrdersWindowEnd,
    historyWindowMs: observations[1].allOrdersWindowEnd - attemptStartedAt,
    recvWindowElapsedMs: observations[1].observedAt - attemptStartedAt,
    observationCount: observations.length,
    observations,
  };
}

async function persistStateAt(path, state) {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function archiveUnknownEntryNoFill({
  api,
  state,
  statePath = STATE_PATH,
  clock = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  operatorConfirmed = false,
} = {}) {
  if (operatorConfirmed !== true) throw new Error("confirmation_required");
  const proof = await verifyUnknownEntryNoFillForArchive(api, state, { clock, sleep });
  const archivedAt = clock();
  const archiveStamp = new Date(archivedAt).toISOString().replaceAll(":", "-");
  const archivePath = `${statePath}.archive-${archiveStamp}-${randomUUID()}.json`;
  state.status = "archived_no_fill_operator_verified";
  state.archiveNoFill = {
    operatorConfirmed: true,
    proof,
  };
  await persistStateAt(statePath, state);
  await rename(statePath, archivePath);
  const directory = await open(dirname(statePath), "r");
  try { await directory.sync(); } finally { await directory.close(); }
  return {
    status: state.status,
    symbol: SYMBOL,
    archived: true,
    evidencePreserved: true,
    archivePath,
    observationCount: proof.observationCount,
  };
}

async function archiveNoFill() {
  const releaseLock = await acquireLock();
  try {
    const state = await readState();
    if (!state) throw new Error("archive_state_missing");
    const { api } = makeApi("read-only");
    return await archiveUnknownEntryNoFill({
      api,
      state,
      operatorConfirmed: true,
    });
  } finally {
    await releaseLock();
  }
}

export async function archiveClosedAttempt({
  api,
  state,
  statePath = STATE_PATH,
  operatorConfirmed = false,
} = {}) {
  if (operatorConfirmed !== true) throw new Error("confirmation_required");
  if (state?.environment !== "vst" || state?.symbol !== SYMBOL ||
      !state?.emergencyClose?.clientOrderId) {
    throw new Error("archive_requires_closed_attempt");
  }
  const proof = await verifyEmergencyClose(api, state);
  if (proof.verified !== true || proof.flat !== true ||
      proof.noOpenOrders !== true || proof.closeFillFound !== true) {
    throw new Error("archive_closed_evidence_unverified");
  }
  const archivedAt = Date.now();
  const archiveStamp = new Date(archivedAt).toISOString().replaceAll(":", "-");
  const archivePath = `${statePath}.archive-closed-${archiveStamp}-${randomUUID()}.json`;
  state.status = "archived_closed_verified";
  state.archiveClosed = {
    operatorConfirmed: true,
    archivedAt,
    proof,
  };
  await persistStateAt(statePath, state);
  await rename(statePath, archivePath);
  const directory = await open(dirname(statePath), "r");
  try { await directory.sync(); } finally { await directory.close(); }
  return {
    status: state.status,
    symbol: SYMBOL,
    archived: true,
    evidencePreserved: true,
    archivePath,
    flatVerified: true,
    noOpenOrders: true,
    closeFillFound: true,
  };
}

async function archiveClosed() {
  const releaseLock = await acquireLock();
  try {
    const state = await readState();
    if (!state) throw new Error("archive_state_missing");
    const { api } = makeApi("read-only");
    return await archiveClosedAttempt({
      api, state, operatorConfirmed: true,
    });
  } finally {
    await releaseLock();
  }
}

async function emergencyClose(quantity) {
  const releaseLock = await acquireLock();
  try {
    const state = await readState();
    if (!state || !state.entry?.clientOrderId ||
        state.status === "closed_verified" || state.emergencyClose?.clientOrderId) {
      throw new Error("no_closeable_state_or_close_already_reserved");
    }
    const clientOrderId = makeClientOrderId("vc");
    const { api } = makeApi("emergency-close", clientOrderId);
    const [mode, marginType, positions] = await Promise.all([
      api.getPositionMode(),
      api.getMarginType(SYMBOL),
      api.getPositions(SYMBOL),
    ]);
    const parsedPositions = positionsForSymbol(positions);
    const side = orderPositionSide(mode);
    const symbolRows = parsedPositions?.map(({ row, amount }) => ({ row, amount })) ?? null;
    const active = symbolRows?.filter(({ amount }) => amount.units !== 0n) ?? [];
    const rowsValid = symbolRows !== null && symbolRows.every(({ row, amount }) =>
      amount.units >= 0n && ["BOTH", "LONG", "SHORT"].includes(row.positionSide));
    if (marginType !== "ISOLATED" || !side || !rowsValid || active.length !== 1 ||
        active[0].row.positionSide !== side ||
        !sameDecimal(String(active[0].row.positionAmt), quantity, "close_quantity")) {
      throw new Error("exact_isolated_long_quantity_required");
    }
    state.status = "emergency_close_submitting";
    state.emergencyClose = {
      clientOrderId,
      quantity,
      recordedAt: Date.now(),
      positionMode: mode,
    };
    // Reserve durable close intent before the one and only SELL POST.
    await updateState(state);
    await releaseLock();
    try {
      const response = await api.closeLong(SYMBOL, quantity, clientOrderId);
      state.emergencyClose.orderId = exactId(response);
      state.status = "emergency_close_reconciling";
      await updateState(state);
    } catch {
      state.status = "emergency_close_unknown_halt_no_retry";
      await updateState(state);
      return {
        status: state.status,
        symbol: SYMBOL,
        flatVerified: false,
        clientOrderId,
        instruction: "Do not retry; reconcile manually with read-only status.",
      };
    }
    try {
      const proof = await verifyEmergencyClose(api, state);
      const flatVerified = proof.verified;
      state.status = flatVerified ? "closed_verified" : "emergency_close_unverified_halt";
      state.emergencyClose.proof = proof;
      await updateState(state);
      return {
        status: state.status,
        symbol: SYMBOL,
        flatVerified,
        noOpenOrders: proof.noOpenOrders,
        closeFillFound: proof.closeFillFound,
        clientOrderId,
      };
    } catch {
      state.status = "emergency_close_unverified_halt";
      state.emergencyClose.proof = { flat: false, noOpenOrders: false, closeFillFound: false };
      await updateState(state);
      return {
        status: state.status,
        symbol: SYMBOL,
        flatVerified: false,
        clientOrderId,
      };
    }
  } finally {
    await releaseLock();
  }
}

async function partialObserve(quantity) {
  const releaseLock = await acquireLock();
  try {
    const state = await readState();
    // A VST FOK can fill while its historical row omits timeInForce and its
    // fixed-quantity child stop cannot pass the REAL continuous-coverage audit.
    // Only the independent, live static-stop proof below may unlock this
    // explicitly confirmed virtual observation.
    if (!state || !["protected", "entry_unknown_halt_no_retry"].includes(state.status) ||
        !state.entry?.clientOrderId || state.partialObservation?.clientOrderId ||
        state.emergencyClose?.clientOrderId) {
      throw new Error("partial_requires_new_verified_entry");
    }
    const clientOrderId = makeClientOrderId("vp");
    const { api, fetchImpl } = makeApi("read-only");
    const currentQuote = await readFreshVstAsk(fetchImpl);
    const evidence = await verifyPartialObservationEntry(api, state, currentQuote.ask);
    const filters = await api.contract(SYMBOL);
    const exactQuarter = computeExactQuarterQuantity(
      evidence.currentQuantity, filters.quantityPrecision,
    );
    if (!sameDecimal(quantity, exactQuarter, "partial_quarter_quantity")) {
      throw new Error("exact_quarter_quantity_required");
    }
    quantityUnitsAtPrecision(quantity, filters.quantityPrecision, "partial_quantity");
    if (Number(quantity) < filters.minQuantity) {
      throw new Error("partial_quantity_invalid_for_contract");
    }
    const stateSnapshot = {
      ...state,
      status: "partial_observation_submitting",
      partialObservation: {
        clientOrderId,
        quantity,
        originalQuantity: evidence.currentQuantity,
        originalStopOrderId: evidence.stopOrderId,
        stopOrderId: evidence.stopOrderId,
        positionId: evidence.positionId,
        stopPrice: String(evidence.stop.stopPrice),
        positionMode: state.entry.positionMode,
        recordedAt: Date.now(),
        estimatedMargin: evidence.estimatedMargin,
        marginPriceReference: currentQuote.ask,
      },
    };
    Object.assign(state, stateSnapshot);
    await updateState(state);
    await releaseLock();
    const guardedApi = makeApi("partial-close", clientOrderId, {
      expectedQuantity: quantity,
      expectedPositionSide: evidence.positionSide,
    }).api;
    try {
      const response = await guardedApi.closeLong(SYMBOL, quantity, clientOrderId);
      state.partialObservation.orderId = exactId(response);
      state.status = "partial_observation_reconciling";
      await updateState(state);
    } catch (error) {
      state.status = "partial_observation_unknown_halt_no_retry";
      state.partialObservation.lastError = {
        code: safeErrorCode(error),
        transportStage: safeTransportStage(error),
      };
      await updateState(state);
      return {
        status: state.status,
        symbol: SYMBOL,
        protected: false,
        emergencyCloseUrgency: true,
        clientOrderId,
        instruction: "No retry. Position remains for urgent operator emergency-close.",
      };
    }
    const proof = await verifyPartialClose(guardedApi, state);
    state.partialObservation.proof = proof;
    state.status = proof.verified
      ? "partial_observation_resized" : "partial_observation_unsafe";
    await updateState(state);
    return {
      status: state.status,
      symbol: SYMBOL,
      protected: false,
      emergencyCloseUrgency: proof.emergencyCloseUrgency,
      stopObservation: proof.stopObservation,
      remainingPositionVerified: proof.remainingPositionVerified,
      expectedRemainingQuantity: proof.expectedRemainingQuantity ?? null,
      observedRemainingQuantity: proof.observedRemainingQuantity ?? null,
      clientOrderId,
      instruction: proof.emergencyCloseUrgency
        ? "Position remains open; operator emergency-close is urgent."
        : "Stop resize behavior observed; position remains open for operator action.",
    };
  } finally {
    await releaseLock();
  }
}

async function topupObserve(amount) {
  const releaseLock = await acquireLock();
  try {
    const state = await readState();
    if (!state) throw new Error("topup_state_missing");
    return await runMarginTopUpObservation({
      api: makeApi("margin-topup").api,
      state, statePath: STATE_PATH, amount, operatorConfirmed: true,
    });
  } finally {
    await releaseLock();
  }
}

export async function runCli(argv = process.argv.slice(2)) {
  const { command, quantity, amount } = parseArgs(argv);
  if (command === "preview") return preview();
  if (command === "enter") return enter();
  if (command === "status") return status();
  if (command === "archive-no-fill") return archiveNoFill();
  if (command === "archive-closed") return archiveClosed();
  if (command === "partial-observe") return partialObserve(quantity);
  if (command === "topup-observe") return topupObserve(amount);
  return emergencyClose(quantity);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    const reason = error instanceof Error && /^[a-z0-9_-]+$/.test(error.message)
      ? error.message : "operation_failed";
    process.stdout.write(`${JSON.stringify({ status: "error", reason })}\n`);
    process.exitCode = 1;
  });
}