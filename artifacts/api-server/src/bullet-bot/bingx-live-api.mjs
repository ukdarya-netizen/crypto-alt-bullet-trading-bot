import { createHmac } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createCoalescedPriceRead } from "./coalesced-price-read.mjs";
import { createVstEndpointPacer } from "./vst-endpoint-pacer.mjs";
import { refreshVstEntrySizing } from "./vst-fresh-entry-sizing.mjs";
import { OWNER_POSITION_PROFILE, allocationBudget, normalizePositionProfile } from "./vst-position-profile.mjs";
import {
  instrumentVstApi, noteVstApiDiagnosticRequest, recordVstDiagnostic,
} from "./vst-diagnostics.mjs";
import {
  collectCompleteFillHistory, COMPLETE_FILL_HISTORY_PATH,
} from "./bingx-fill-history.mjs";
import { corroborateVstActiveStopPosition } from "./vst-active-stop-corroboration.mjs";
import { validateProtectedExit } from "./vst-protected-exit.mjs";

// Deliberately isolated from the PAPER/runtime modules. Nothing imports or
// activates this client automatically; write access requires an injected
// permission capability on every individual request.
const ORIGINS = Object.freeze({
  mainnet: "https://open-api.bingx.com",
  vst: "https://open-api-vst.bingx.com",
});
const TIMEOUT_MS = 10_000;
const MAINNET_REQUEST_GAP_MS = 600;
// Keep a small margin above the required one-second interval for the final
// timestamp/signature computation between a reservation and transport start.
const VST_REQUEST_GAP_MS = 1_100;
const RECV_WINDOW = 5000;
const RETRYABLE_GET_ERROR_CODE = 100410;
const RETRYABLE_VST_BUSY_ERROR_CODE = 109500;
const MAX_RETRYABLE_GET_ATTEMPTS = 2;
const MAX_TIMESTAMP_INVALID_GET_ATTEMPTS = 3;
const MAX_UNCORROBORATED_MARK_PAIR_RETRIES = 1;
const RETRYABLE_GET_BACKOFF_MS = 1_100;
const TRANSIENT_VST_GET_BACKOFF_MS = 2_000;
const RATE_LIMIT_COOLDOWN_MS = 5_000;
const RATE_LIMIT_JITTER_MS = 500;
const VST_TICKER_PATH = "/openApi/swap/v2/quote/ticker";
const LAST_PRICE_MIN_GAP_MS = 2_000;
const VST_BOOK_TICKER_PATH = "/openApi/swap/v2/quote/bookTicker";
const VST_PRE_SIGN_MAX_PACING_DELAY_MS = 2_000;
const VST_ORDER_HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const VST_RUNNER_FILL_HISTORY_MAX_AGE_MS = 23 * 60 * 60 * 1000;
const VST_SIGNAL_MAX_AGE_MS = 10 * 60 * 1000;
const VST_SIGNAL_FUTURE_TOLERANCE_MS = 30 * 1000;
const ALLOWED_VST_PRE_SIGN_REASONS = new Set([
  "signal_expired",
  "final_balance_unavailable",
  "final_balance_invalid",
  "final_preflight_unavailable",
  "final_preflight_blocked",
  "final_budget_exceeded",
  "final_quote_unavailable_or_stale",
  "final_quote_out_of_bounds",
  "final_sizing_persistence_failed",
  "final_pre_sign_pacing_expired",
]);
export const VST_BTC_HEDGE_LONG10_SHORT75_PROBE = "vst-btc-hedge-long10-short75";
export const VST_AUTOMATED_LONG_POLICY = "vst-automated-long-1pct";
const NUMERIC_IDENTIFIER_FIELDS = new Set([
  "orderId", "orderID", "mainOrderId", "parentOrderId", "positionId", "positionID",
  "triggerOrderId", "triggerOrderID",
  "tradeId", "tradeID", "id", "fillId", "fillID", "tranId",
]);
const PATH = Object.freeze({
  balance: "/openApi/swap/v3/user/balance",
  positions: "/openApi/swap/v2/user/positions",
  positionMode: "/openApi/swap/v1/positionSide/dual",
  contracts: "/openApi/swap/v2/quote/contracts",
  riskTiers: "/openApi/swap/v1/maintMarginRatio",
  funding: "/openApi/swap/v2/quote/premiumIndex",
  income: "/openApi/swap/v2/user/income",
  fees: "/openApi/swap/v2/user/commissionRate",
  leverage: "/openApi/swap/v2/trade/leverage",
  marginType: "/openApi/swap/v2/trade/marginType",
  order: "/openApi/swap/v2/trade/order",
  orderQuery: "/openApi/swap/v2/trade/order",
  openOrders: "/openApi/swap/v2/trade/openOrders",
  allOrders: "/openApi/swap/v2/trade/allOrders",
  forceOrders: "/openApi/swap/v2/trade/forceOrders",
  fills: "/openApi/swap/v2/trade/allFillOrders",
  completeFills: COMPLETE_FILL_HISTORY_PATH,
  positionMargin: "/openApi/swap/v2/trade/positionMargin",
  positionMarginHistory: "/openApi/swap/v1/positionMargin/history",
});

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TERMINAL_SOURCE_EXIT_STATUSES = new Set([
  "profit", "stop_loss", "bu_stop", "breakeven", "expired",
]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sourceExitUpdateTimestampValid(evidence, reason) {
  if (evidence?.sourceUpdatedAt === null) {
    const price = evidence.sourceExitPrice;
    const positiveExitPrice = typeof price === "string"
      ? /^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(price) &&
        Number.isFinite(Number(price)) && Number(price) > 0
      : typeof price === "number" && Number.isFinite(price) && price > 0;
    return reason === "source_closed" &&
      TERMINAL_SOURCE_EXIT_STATUSES.has(evidence.sourceStatus) &&
      typeof evidence.sourceClosedAt === "string" &&
      Number.isFinite(Date.parse(evidence.sourceClosedAt)) &&
      (positiveExitPrice || evidence.sourceAction === "close" && price === null);
  }
  return typeof evidence?.sourceUpdatedAt === "string" &&
    Number.isFinite(Date.parse(evidence.sourceUpdatedAt));
}

/**
 * Serializes request-start reservations without holding a slot while the
 * request (or a beforeSign callback containing nested reads) is in flight.
 */
export function createBingXOutboundPacer({
  gapMs = VST_REQUEST_GAP_MS,
  clock = Date.now,
  sleep = defaultSleep,
} = {}) {
  if (!Number.isFinite(gapMs) || gapMs < 0) {
    throw new TypeError("gapMs must be a non-negative finite number");
  }
  if (typeof clock !== "function" || typeof sleep !== "function") {
    throw new TypeError("clock and sleep must be functions");
  }

  let nextRequestAt = 0;
  let logicalNow = 0;
  const pending = [];
  let draining = false;

  const currentTime = () => {
    const now = Number(clock());
    if (!Number.isFinite(now)) throw new TypeError("clock must return a finite number");
    logicalNow = Math.max(logicalNow, now);
    return logicalNow;
  };

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (pending.length) {
        const now = currentTime();
        const slot = Math.max(now, nextRequestAt);
        if (slot > now) {
          await sleep(slot - now);
          logicalNow = Math.max(logicalNow, slot);
          continue;
        }
        const startedAt = currentTime();
        if (startedAt < nextRequestAt) continue;
        // Choose only when the slot is actually available. A mutation whose
        // final checks just completed must not wait behind background reads.
        // Never bypass the shared spacing or an exchange-imposed cooldown.
        const priorityIndex = pending.findIndex(item => item.priority);
        const [item] = pending.splice(priorityIndex < 0 ? 0 : priorityIndex, 1);
        nextRequestAt = currentTime() + gapMs;
        item.resolve(startedAt);
        // Let the selected caller sign/start transport before advancing a
        // fake clock or sleeping on behalf of the next queued request.
        await Promise.resolve();
      }
    } catch (error) {
      for (const item of pending.splice(0)) item.reject(error);
    } finally {
      draining = false;
    }
  }

  function waitForSlot({ priority = false } = {}) {
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject, priority: priority === true });
      void drain();
    });
  }

  return Object.freeze({
    waitForSlot,
    deferFor(ms) {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new TypeError("cooldown must be a non-negative finite number");
      }
      nextRequestAt = Math.max(nextRequestAt, currentTime() + ms);
    },
  });
}

// All default VST clients in this process share a single outbound budget.
// Tests inject their own fake-clock pacer to keep test state isolated.
const defaultVstOutboundPacer = createVstEndpointPacer();

function rateLimitJitter(random) {
  let sample;
  try { sample = Number(random()); } catch { return 0; }
  if (!Number.isFinite(sample)) return 0;
  return Math.floor(Math.min(1, Math.max(0, sample)) * RATE_LIMIT_JITTER_MS);
}

// BingX code 109418 is undocumented in BingX's published error-code
// reference, but live confirmation against the real quote/contracts and
// maintMarginRatio endpoints (2026-09-28) proves its exact meaning: BingX
// returns it with `msg: "<SYMBOL> is offline currently,all validted symbols
// in api:/openApi/swap/v2/quote/contracts, please verify it"` when the
// requested contract is not currently tradeable. This is a legitimate,
// symbol-specific rejection, not a malformed request or a transient/rate
// limit condition -- it sits numerically between 109417 ("pre-launch
// status") and 109420 ("no position exists"), both also symbol/position
// status codes.
export const BINGX_SYMBOL_OFFLINE_CODE = 109418;

export class BingXLiveApiError extends Error {
  constructor(message, {
    httpStatus, code, exchangeMessage, transportStage, preSignReason, endpoint, method,
  } = {}) {
    super(message);
    this.name = "BingXLiveApiError";
    this.httpStatus = httpStatus;
    this.code = code;
    this.exchangeMessage = exchangeMessage;
    this.transportStage = transportStage;
    this.endpoint = endpoint;
    this.method = method;
    this.symbolOffline = code === BINGX_SYMBOL_OFFLINE_CODE;
    this.preSignReason = ALLOWED_VST_PRE_SIGN_REASONS.has(preSignReason)
      ? preSignReason : undefined;
  }
}

function setOriginalStopCancellationProvenance(error, mutationRequestSent) {
  if (!(error instanceof Error)) return error;
  error.mutationProvenance = Object.freeze({
    operation: "cancel_original_stop",
    mutationMethod: "DELETE",
    mutationEndpoint: PATH.order,
    mutationRequestSent,
    phase: mutationRequestSent ? "mutation_transport_started" : "pre_mutation_read",
  });
  return error;
}

function setPreRunnerCloseNoMutationProvenance(error) {
  if (!(error instanceof Error)) return error;
  error.mutationProvenance = Object.freeze({
    operation: "close_pre_runner_split",
    boundary: "before_transport",
    noMutationSubmitted: true,
  });
  return error;
}

function setPreRunnerCloseMutationSentProvenance(error) {
  if (!(error instanceof Error)) return error;
  error.mutationProvenance = Object.freeze({
    operation: "close_pre_runner_split",
    boundary: "after_transport_started",
    mutationSubmitted: true,
  });
  return error;
}

// Lets callers outside this module classify "the exchange has this contract
// offline right now" as an explicit, expected rejection instead of an
// opaque worker error, without coupling them to BingX's raw numeric code.
export function isSymbolOfflineError(error) {
  return error instanceof BingXLiveApiError && error.symbolOffline === true;
}

// A `code !== 0` response body means BingX's server fully received, parsed,
// and synchronously declined this specific request (invalid parameters, a
// risk/position limit, insufficient balance, an offline symbol, etc.)
// *before* anything was mutated. A failed beforeSign callback also happens
// before fetch is called and is definitively not a submitted order. A dropped
// connection or timeout after transport begins remains ambiguous. This is
// deliberately independent of the specific numeric exchange code.
export function isDefiniteExchangeRejection(error) {
  return error instanceof BingXLiveApiError &&
    (error.transportStage === "exchange_response" ||
     error.transportStage === "pre_transport" &&
       ALLOWED_VST_PRE_SIGN_REASONS.has(error.preSignReason));
}

function symbolName(symbol) {
  if (typeof symbol !== "string" || !/^[A-Z0-9]+USDT$/.test(symbol)) {
    throw new TypeError("Invalid USDT perpetual symbol");
  }
  return `${symbol.slice(0, -4)}-USDT`;
}

function positive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new BingXLiveApiError(`BingX returned invalid ${name}`);
  }
  return number;
}

// BingX's documented swap v2 positions response names this field
// "initialMargin" (its own doc describes it tersely as just "margin"); no
// endpoint has ever been observed to return a field literally named
// "isolatedMargin". The fallback exists only in case some other account
// mode or endpoint variant genuinely does return that name -- it must never
// become the primary source of truth again.
//
// This is the ONE shared definition of that field-name resolution. This bug
// (assuming "isolatedMargin" when BingX actually returns "initialMargin")
// was independently found and fixed three times in three files before this
// consolidation. Every BingX-reading code path must import this instead of
// keeping its own local candidate list, or the next new path will reinvent
// the same wrong assumption.
export function positionInitialMargin(position) {
  return position?.initialMargin ?? position?.isolatedMargin;
}

function strictNumeric(value, name, { allowNegative = false } = {}) {
  const text = typeof value === "string" ? value
    : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  const pattern = allowNegative ? /^-?\d+(?:\.\d+)?$/ : /^\d+(?:\.\d+)?$/;
  if (!pattern.test(text)) {
    throw new BingXLiveApiError(`BingX returned invalid ${name}`);
  }
  const number = Number(text);
  if (!Number.isFinite(number)) throw new BingXLiveApiError(`BingX returned invalid ${name}`);
  return number;
}

function orderIdentifier(value, name = "order ID") {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  throw new BingXLiveApiError(`BingX returned an invalid or non-lossless ${name}`);
}

function exactIntegerFromJsonNumber(source) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) return null;
  const [, sign, whole, fraction = "", exponentText = "0"] = match;
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return null;
  const digits = `${whole}${fraction}`;
  const scale = fraction.length - exponent;
  let integerDigits;
  if (scale <= 0) {
    integerDigits = `${digits}${"0".repeat(-scale)}`;
  } else {
    if (scale > digits.length ||
        !/^0*$/.test(digits.slice(digits.length - scale))) return null;
    integerDigits = digits.slice(0, digits.length - scale) || "0";
  }
  integerDigits = integerDigits.replace(/^0+(?=\d)/, "");
  return sign === "-" && integerDigits !== "0" ? `-${integerDigits}` : integerDigits;
}

function parseResponseJson(source) {
  let sourceContextAvailable = false;
  JSON.parse("0", (_key, _value, context) => {
    sourceContextAvailable = typeof context?.source === "string";
    return 0;
  });
  if (!sourceContextAvailable) {
    throw new BingXLiveApiError("Runtime does not support lossless BingX identifier parsing");
  }
  return JSON.parse(source, (key, value, context) => {
    if (!NUMERIC_IDENTIFIER_FIELDS.has(key) || typeof value !== "number") return value;
    const exact = exactIntegerFromJsonNumber(context?.source ?? "");
    if (exact === null) return Number.isSafeInteger(value) ? Number.NaN : value;
    return Number.isSafeInteger(value) ? value : exact;
  });
}

function orderIdentifierFrom(row, name = "order ID") {
  if (typeof row?.orderID === "string" && row.orderID.trim() !== "") {
    return row.orderID;
  }
  if (row?.orderId !== undefined && row.orderId !== null) {
    return orderIdentifier(row.orderId, name);
  }
  if (row?.orderID !== undefined && row.orderID !== null) {
    return orderIdentifier(row.orderID, name);
  }
  throw new BingXLiveApiError(`BingX returned an invalid or non-lossless ${name}`);
}

function exactOrderIdentifierFrom(row, name = "order ID") {
  if (!object(row)) {
    const error = new BingXLiveApiError(`BingX returned a missing or conflicting ${name}`);
    error.acknowledgementReason = "response_not_object";
    throw error;
  }
  const containers = [row];
  if (Object.hasOwn(row, "order")) {
    if (!object(row.order)) {
      const error = new BingXLiveApiError(`BingX returned a missing or conflicting ${name}`);
      error.acknowledgementReason = "nested_order_not_object";
      throw error;
    }
    containers.push(row.order);
  }
  const values = [];
  for (const container of containers) {
    for (const field of ["orderId", "orderID"]) {
      if (!Object.hasOwn(container, field)) continue;
      if (container[field] === null || container[field] === undefined) {
        const error = new BingXLiveApiError(`BingX returned a missing or conflicting ${name}`);
        error.acknowledgementReason = "null_alias";
        throw error;
      }
      try {
        values.push(orderIdentifier(container[field], name));
      } catch {
        const error = new BingXLiveApiError(`BingX returned a missing or conflicting ${name}`);
        error.acknowledgementReason = "invalid_identifier";
        throw error;
      }
    }
  }
  if (values.length === 0 || new Set(values).size !== 1) {
    const error = new BingXLiveApiError(`BingX returned a missing or conflicting ${name}`);
    error.acknowledgementReason = values.length === 0 ? "missing_id" : "conflicting_aliases";
    throw error;
  }
  return values[0];
}

function stopAcknowledgementDiagnostic(response, reason) {
  const responseType = response === null ? "null"
    : Array.isArray(response) ? "array"
    : typeof response;
  const flat = object(response) ? response : {};
  const nested = object(flat.order) ? flat.order : {};
  return Object.freeze({
    responseType: ["object", "array", "null", "string", "number", "boolean", "undefined"]
      .includes(responseType) ? responseType : "other",
    orderWrapper: !Object.hasOwn(flat, "order") ? "absent"
      : flat.order === null ? "null"
      : Array.isArray(flat.order) ? "array"
      : object(flat.order) ? "object" : "scalar",
    flatOrderIdPresent: Object.hasOwn(flat, "orderId"),
    flatOrderIDPresent: Object.hasOwn(flat, "orderID"),
    nestedOrderIdPresent: Object.hasOwn(nested, "orderId"),
    nestedOrderIDPresent: Object.hasOwn(nested, "orderID"),
    reason: new Set([
      "response_not_object", "nested_order_not_object", "null_alias",
      "invalid_identifier", "missing_id", "conflicting_aliases",
    ]).has(reason) ? reason : "invalid_identifier",
  });
}

function optionalOrderIdentifier(value, name = "order ID") {
  return value === undefined || value === null ? null : orderIdentifier(value, name);
}

function rows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.list)) return data.list;
  if (Array.isArray(data?.orders)) return data.orders;
  if (Array.isArray(data?.positions)) return data.positions;
  return [];
}

function decimalAtPrecision(value, places, name) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new BingXLiveApiError(`${name} must be a plain decimal string`);
  }
  const [, fraction = ""] = value.split(".");
  if (fraction.length > places) {
    throw new BingXLiveApiError(`${name} exceeds BingX contract precision`);
  }
  return value;
}

function floorQuantity(value, places) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new BingXLiveApiError("Quantity must be a plain decimal string");
  }
  const [whole, fraction = ""] = value.split(".");
  const text = places === 0
    ? whole
    : `${whole}.${fraction.padEnd(places, "0").slice(0, places)}`;
  return text.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function parseDecimal(value, name) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new BingXLiveApiError(`BingX returned invalid ${name}`);
  }
  const text = String(value);
  if (!/^\d+(?:\.\d+)?$/.test(text)) {
    throw new BingXLiveApiError(`BingX returned invalid ${name}`);
  }
  const [whole, fraction = ""] = text.split(".");
  return { units: BigInt(whole + fraction), scale: 10n ** BigInt(fraction.length) };
}

function sameDecimal(left, right) {
  const a = parseDecimal(String(left), "stop price");
  const b = parseDecimal(String(right), "stop price");
  const scale = a.scale > b.scale ? a.scale : b.scale;
  return a.units * (scale / a.scale) === b.units * (scale / b.scale);
}

function compareDecimals(left, right, name = "quantity") {
  const a = parseDecimal(String(left), name);
  const b = parseDecimal(String(right), name);
  const scale = a.scale > b.scale ? a.scale : b.scale;
  const leftUnits = a.units * (scale / a.scale);
  const rightUnits = b.units * (scale / b.scale);
  return leftUnits < rightUnits ? -1 : leftUnits > rightUnits ? 1 : 0;
}

function subtractDecimals(larger, smaller) {
  const a = parseDecimal(String(larger), "entry price");
  const b = parseDecimal(String(smaller), "stop price");
  const scale = a.scale > b.scale ? a.scale : b.scale;
  let units = a.units * (scale / a.scale) - b.units * (scale / b.scale);
  const whole = units / scale;
  let fraction = String(units % scale).padStart(String(scale).length - 1, "0");
  fraction = fraction.replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function addDecimals(left, right) {
  const a = parseDecimal(String(left), "quantity");
  const b = parseDecimal(String(right), "quantity");
  const scale = a.scale > b.scale ? a.scale : b.scale;
  const units = a.units * (scale / a.scale) + b.units * (scale / b.scale);
  const whole = units / scale;
  const fraction = String(units % scale).padStart(String(scale).length - 1, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function decimalIsRatio(part, total, numerator, denominator) {
  const a = parseDecimal(String(part), "split quantity");
  const b = parseDecimal(String(total), "position quantity");
  return a.units * b.scale * BigInt(denominator) ===
    b.units * a.scale * BigInt(numerator);
}

function flattenBalance(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.balance)) return data.balance;
  return data?.balance && typeof data.balance === "object" ? [data.balance] : [];
}

function validPositionAmount(position) {
  const amount = position?.positionAmt;
  return (typeof amount === "string" && amount.trim() !== "" ||
    typeof amount === "number") && Number.isFinite(Number(amount))
    ? Number(amount) : null;
}

export function createBingXLiveApi({
  environment = "mainnet",
  fetchImpl = globalThis.fetch,
  clock = Date.now,
  sleep = defaultSleep,
  requestPacer,
  random = Math.random,
  onRateLimitDiagnostic,
  onTransientGetDiagnostic,
  contractDriftMonitor,
  credentials = () => ({
    key: process.env.BINGX_API_KEY,
    secret: process.env.BINGX_API_SECRET,
  }),
  // A caller must explicitly inject and grant this capability. It defaults
  // closed; no environment variable or imported runtime state enables writes.
  writePermission = () => false,
  // Leverage, margin mode and per-trade allocation of the VST automated LONG
  // path. The owner's bot uses the default (isolated 10x, 1% of balance).
  positionProfile = OWNER_POSITION_PROFILE,
} = {}) {
  if (!Object.hasOwn(ORIGINS, environment)) {
    throw new TypeError('environment must be "mainnet" or "vst"');
  }
  const PROFILE = normalizePositionProfile(positionProfile);
  const PROFILE_LEVERAGE = PROFILE.leverage;
  const PROFILE_MARGIN = PROFILE.marginMode;
  const stopTransferContext = new AsyncLocalStorage();
  const preparationReadContext = new AsyncLocalStorage();
  const preparationReadPaths = new Set([
    PATH.contracts, PATH.positionMode, PATH.positions, PATH.openOrders,
    PATH.marginType, PATH.leverage,
  ]);
  async function withVstPreparationReads(symbol, run) {
    if (environment !== "vst" || typeof run !== "function") {
      throw new BingXLiveApiError("VST preparation read scope requires VST and a callback");
    }
    const context = { symbol: symbolName(symbol), reads: new Map(), disabled: false };
    return preparationReadContext.run(context, async () => {
      try { return await run(); }
      finally {
        context.disabled = true;
        context.reads.clear();
      }
    });
  }
  function reserveStopTransferKey(set, key) {
    set.add(key);
    const context = stopTransferContext.getStore();
    if (context) context.cleanups.push({
      stage: context.journal.getProgress().stage, release: () => set.delete(key),
    });
  }
  async function withStopTransferJournal(journal, run) {
    if (environment !== "vst" || typeof journal?.beforeMutation !== "function" ||
        typeof journal?.afterMutation !== "function" || typeof run !== "function") {
      throw new Error("stop_transfer_journal_required");
    }
    const context = { journal, cleanups: [] };
    return stopTransferContext.run(context, async () => {
      try { return await run(); }
      catch (error) {
        // Release only reservations made before an un-crossed durable boundary.
        // A sent or possibly sent mutation never qualifies for this cleanup.
        const stage = journal.getProgress().stage;
        for (const cleanup of context.cleanups) {
          if (cleanup.stage === stage) cleanup.release();
        }
        throw error;
      }
    });
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (typeof writePermission !== "function") {
    throw new TypeError("writePermission must be an injected function");
  }
  const hasInjectedTransportOrClock = fetchImpl !== globalThis.fetch ||
    clock !== Date.now || sleep !== defaultSleep;
  const outboundPacer = requestPacer ?? (environment === "vst"
    ? (hasInjectedTransportOrClock
      ? createBingXOutboundPacer({ gapMs: VST_REQUEST_GAP_MS, clock, sleep })
      : defaultVstOutboundPacer)
    : createBingXOutboundPacer({
        gapMs: MAINNET_REQUEST_GAP_MS, clock, sleep,
      }));
  if (typeof outboundPacer.waitForSlot !== "function" ||
      typeof outboundPacer.deferFor !== "function") {
    throw new TypeError("requestPacer must provide waitForSlot and deferFor");
  }
  if (typeof random !== "function") throw new TypeError("random must be a function");

  const submittedClientOrderIds = new Set();
  const submittedMarginOperationIds = new Set();
  const submittedVstStopIntents = new Set();
  const submittedVstStopUpgradeIntents = new Set();
  const submittedVstAdoptedStopRetirements = new Set();
  const submittedTriggeredRunnerCancellationIds = new Set();
  const submittedAutomatedFlatStopCancellationIds = new Set();
  const submittedVstIsolatedMarginSymbols = new Set();
  const submittedVstSourceExitRequestIds = new Set();
  const origin = ORIGINS[environment];
  const marginAsset = environment === "vst" ? "VST" : "USDT";

  function reportRateLimit(path, method, outcome) {
    const diagnostic = Object.freeze({
      endpoint: path,
      method,
      code: RETRYABLE_GET_ERROR_CODE,
      outcome,
    });
    try {
      if (typeof onRateLimitDiagnostic === "function") {
        onRateLimitDiagnostic(diagnostic);
      } else {
        process.stderr.write(`BingX rate limit: ${JSON.stringify(diagnostic)}\n`);
      }
    } catch {
      // Diagnostics must never change a fail-closed exchange result.
    }
  }

  function scheduleRateLimitDelay(path, method, attempt, attempts) {
    const jitter = rateLimitJitter(random);
    if (method === "GET" && attempt + 1 < attempts) {
      const waitMs = RETRYABLE_GET_BACKOFF_MS + jitter;
      outboundPacer.deferFor(waitMs);
      reportRateLimit(path, method, "retry_scheduled");
      return;
    }
    const waitMs = RATE_LIMIT_COOLDOWN_MS + jitter;
    outboundPacer.deferFor(waitMs);
    reportRateLimit(
      path,
      method,
      method === "GET" ? "retry_exhausted_cooldown" : "write_not_retried_cooldown",
    );
  }

  function reportTransientGet(path, outcome, reason, code) {
    const diagnostic = Object.freeze({
      endpoint: path,
      method: "GET",
      outcome,
      reason,
      ...(code !== undefined ? { code } : {}),
    });
    try {
      if (typeof onTransientGetDiagnostic === "function") {
        onTransientGetDiagnostic(diagnostic);
      } else {
        process.stderr.write(`BingX transient read: ${JSON.stringify(diagnostic)}\n`);
      }
    } catch {
      // Diagnostics must never change a fail-closed exchange result.
    }
  }

  function scheduleTransientVstGetRetry(path, reason, code) {
    const jitter = rateLimitJitter(random);
    outboundPacer.deferFor(TRANSIENT_VST_GET_BACKOFF_MS + jitter);
    reportTransientGet(path, "retry_scheduled", reason, code);
  }

  function canRetryTransientVstGet(method, attempt) {
    return environment === "vst" && method === "GET" &&
      attempt + 1 < MAX_RETRYABLE_GET_ATTEMPTS;
  }

  function validateProbePolicy(symbol, probePolicy) {
    if (probePolicy === undefined) return false;
    if (probePolicy !== VST_BTC_HEDGE_LONG10_SHORT75_PROBE) {
      throw new BingXLiveApiError("Unknown supervised VST BTC probe policy");
    }
    if (environment !== "vst" || symbolName(symbol) !== "BTC-USDT") {
      throw new BingXLiveApiError("VST BTC probe policy is only valid for VST BTC-USDT");
    }
    return true;
  }

  function requireProbePolicy(symbol, probePolicy) {
    if (!validateProbePolicy(symbol, probePolicy)) {
      throw new BingXLiveApiError("The supervised VST BTC HEDGE 10/75 probe policy is required");
    }
  }

  function validateAutomatedLongPolicy(symbol, policy) {
    if (policy === undefined) return false;
    if (policy !== VST_AUTOMATED_LONG_POLICY) {
      throw new BingXLiveApiError("Unknown VST automated LONG policy");
    }
    if (environment !== "vst") {
      throw new BingXLiveApiError("VST automated LONG policy is only valid on VST");
    }
    symbolName(symbol);
    return true;
  }

  function validateSourceExitCloseRequest(sourceExitRequest, {
    symbol, expectedPositionId,
  }) {
    const requestId = sourceExitRequest?.sourceExitRequestId;
    const sourceExit = sourceExitRequest?.sourceExit;
    const evidence = sourceExit?.evidence;
    const reason = sourceExitRequest?.reason;
    if (!object(sourceExitRequest) ||
        typeof requestId !== "string" || requestId.trim() === "" ||
        sourceExit?.stage !== "close" ||
        sourceExit?.requestId !== requestId ||
        typeof sourceExitRequest.sourceSignalId !== "string" ||
        sourceExitRequest.sourceSignalId.trim() === "" ||
        sourceExitRequest.symbol !== symbol ||
        !["source_withdrawal", "source_closed"].includes(reason) ||
        !object(evidence) ||
        evidence.sourceSignalId !== sourceExitRequest.sourceSignalId ||
        evidence.symbol !== symbol ||
        evidence.reason !== reason ||
        typeof evidence.asOf !== "string" || !Number.isFinite(Date.parse(evidence.asOf)) ||
        typeof evidence.observedAt !== "string" ||
          !Number.isFinite(Date.parse(evidence.observedAt)) ||
        typeof evidence.sourceStatus !== "string" ||
        !sourceExitUpdateTimestampValid(evidence, reason) ||
        !(evidence.sourceExitPrice === null ||
          typeof evidence.sourceExitPrice === "string" &&
            evidence.sourceExitPrice.trim() !== "" ||
          typeof evidence.sourceExitPrice === "number" &&
            Number.isFinite(evidence.sourceExitPrice)) ||
        !(evidence.sourceCancelReason === null ||
          typeof evidence.sourceCancelReason === "string") ||
        !(evidence.exitDecisionAt === null ||
          typeof evidence.exitDecisionAt === "string" &&
            Number.isFinite(Date.parse(evidence.exitDecisionAt))) ||
        !(evidence.sourceClosedAt === null ||
          typeof evidence.sourceClosedAt === "string" &&
            Number.isFinite(Date.parse(evidence.sourceClosedAt))) ||
        !Array.isArray(sourceExitRequest.ownedStops) ||
        sourceExitRequest.ownedStops.length === 0 ||
        typeof sourceExitRequest.entryOrderId !== "string" ||
        sourceExitRequest.entryOrderId.trim() === "") {
      throw new BingXLiveApiError("VST source-exit close request identity or evidence is invalid");
    }
    const stopIds = new Set();
    for (const stop of sourceExitRequest.ownedStops) {
      if (!object(stop) ||
          typeof stop.orderId !== "string" || stop.orderId.trim() === "" ||
          stop.positionId !== expectedPositionId ||
          !["core", "runner", "original", undefined].includes(stop.tranche)) {
        throw new BingXLiveApiError("VST source-exit protective-stop identity is invalid");
      }
      const quantity = parseDecimal(String(stop.quantity), "source_exit_stop_quantity");
      const stopPrice = parseDecimal(String(stop.stopPrice), "source_exit_stop_price");
      if (quantity.units <= 0n || stopPrice.units <= 0n ||
          stopIds.has(stop.orderId)) {
        throw new BingXLiveApiError("VST source-exit protective-stop set is invalid");
      }
      stopIds.add(stop.orderId);
    }
    return sourceExitRequest;
  }

  function verifySourceExitStops(orders, sourceExitRequest, {
    name, positionId: expectedPositionId,
  }) {
    const expectedStops = sourceExitRequest.ownedStops;
    if (!Array.isArray(orders) || orders.length !== expectedStops.length) {
      throw new BingXLiveApiError("VST source-exit close found foreign or missing open orders");
    }
    for (const expected of expectedStops) {
      const matches = orders.filter((order) => {
        try {
          return orderIdentifierFrom(order, "source-exit stop ID") === expected.orderId;
        } catch {
          return false;
        }
      });
      if (matches.length !== 1) {
        throw new BingXLiveApiError("VST source-exit protective stop is missing or ambiguous");
      }
      const order = matches[0];
      const parentValues = [order.mainOrderId, order.parentOrderId]
        .filter((value) => value !== undefined && value !== null && value !== "")
        .map((value) => orderIdentifier(value, "source-exit stop parent ID"));
      if (order.symbol !== name || order.type !== "STOP_MARKET" ||
          order.status !== "NEW" || order.side !== "SELL" ||
          order.positionSide !== "LONG" || order.workingType !== "MARK_PRICE" ||
          orderIdentifier(order.positionId ?? order.positionID,
            "source-exit stop position ID") !== expectedPositionId ||
          !sameDecimal(String(order.origQty ?? order.quantity),
            String(expected.quantity)) ||
          !sameDecimal(String(order.stopPrice), String(expected.stopPrice)) ||
          parentValues.some((parent) => parent !== sourceExitRequest.entryOrderId) ||
          new Set(parentValues).size > 1) {
        throw new BingXLiveApiError("VST source-exit protective stop does not match its owner");
      }
    }
  }

  // BingX error code 109418 is absent from BingX's published error-code
  // reference (openApi/swap common+futures list jumps 109417 "pre-launch
  // status" -> 109420 "no position exists"). Live confirmation against the
  // real quote/contracts and maintMarginRatio endpoints (2026-09-28, same
  // symbol -- ICP-USDT -- as the production failure this was investigated
  // from) proves it means the requested contract is currently offline for
  // trading. That is a legitimate, symbol-specific rejection, not a
  // malformed request: no automatic retry is added, because a delisted/
  // paused contract does not reliably relist within a bounded retry window,
  // and by the time it did the signal's reference price and stop would be
  // stale. `symbolOffline` and `exchangeMessage` above let callers (see
  // vst-broker.mjs readPlanningInputs) classify this as an explicit,
  // expected rejection instead of an opaque worker error.
  async function request(method, path, params = {}, options = {}) {
    const context = preparationReadContext.getStore();
    if (!context || context.disabled || method !== "GET" ||
        !preparationReadPaths.has(path) || Object.keys(options).length > 0 ||
        (params.symbol !== undefined && params.symbol !== context.symbol)) {
      return requestUncoalesced(method, path, params, options);
    }
    const key = JSON.stringify([path, Object.entries(params).sort()]);
    const now = Number(clock());
    let read = context.reads.get(key);
    let reused = true;
    // Include queueing and transport in the age, not just local receipt time.
    if (!read || !Number.isFinite(now) || now < read.startedAt ||
        now - read.startedAt > 10_000) {
      reused = false;
      read = { startedAt: now, promise: requestUncoalesced(method, path, params, options) };
      context.reads.set(key, read);
    }
    try {
      const value = await read.promise;
      const age = Number(clock()) - read.startedAt;
      if (!Number.isFinite(age) || age < 0 || age > 10_000) {
        context.reads.delete(key);
        // The first acquisition may still be usable by its own native
        // validator, but it must never become a reusable old snapshot.
        if (reused) return requestUncoalesced(method, path, params, options);
      }
      return structuredClone(value);
    } catch (error) {
      context.disabled = true;
      context.reads.clear();
      throw error;
    }
  }

  async function requestUncoalesced(method, path, params = {}, {
    beforeSign, beforeTransport, onTransportStart, exposeVstPreSignReason = false,
  } = {}) {
    const readContext = preparationReadContext.getStore();
    if (readContext && method !== "GET") {
      // Native stop writes can call this dispatcher directly. Invalidate at
      // the lowest boundary BEFORE signing, not just in the public wrapper.
      // Final guards and all post-write reads must acquire new evidence.
      readContext.disabled = true;
      readContext.reads.clear();
    }
    if (environment === "vst") noteVstApiDiagnosticRequest(method, path);
    const write = method !== "GET";
    if (!Object.values(PATH).includes(path)) {
      throw new BingXLiveApiError("Unsupported BingX API path");
    }
    if (write && !(await writePermission({ method, path }))) {
      throw new BingXLiveApiError("BingX live writes are disabled: explicit permission was not granted");
    }
    const { key, secret } = credentials() ?? {};
    if (!key || !secret) throw new BingXLiveApiError("BingX API credentials are missing");

    for (let attempt = 0;
      attempt < (write ? 1 : MAX_TIMESTAMP_INVALID_GET_ATTEMPTS);
      attempt += 1) {
      let beforeSignCompletedAt;
      if (beforeSign !== undefined) {
        if (typeof beforeSign !== "function") {
          throw new TypeError("beforeSign must be a function");
        }
        try {
          await beforeSign();
        } catch (error) {
          const wrapped = new BingXLiveApiError("BingX final pre-sign check failed", {
            transportStage: "pre_transport",
            ...(error instanceof BingXLiveApiError ? {
              ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
              ...(error.code !== undefined ? { code: error.code } : {}),
              ...(typeof error.exchangeMessage === "string" &&
                (Number(error.code) === 109400 &&
                 error.exchangeMessage.trim().toLowerCase() === "timestamp is invalid")
                ? { exchangeMessage: error.exchangeMessage.slice(0, 500) } : {}),
              ...(typeof error.endpoint === "string" ? { endpoint: error.endpoint } : {}),
              ...(typeof error.method === "string" ? { method: error.method } : {}),
            } : {}),
            ...(error?.preSignReason === "final_quote_unavailable_or_stale" &&
              error instanceof BingXLiveApiError
              ? {
                  ...(error.code !== undefined ? { code: error.code } : {}),
                  ...(typeof error.exchangeMessage === "string"
                    ? { exchangeMessage: error.exchangeMessage.slice(0, 500) } : {}),
                } : {}),
            ...(exposeVstPreSignReason &&
              ALLOWED_VST_PRE_SIGN_REASONS.has(error?.preSignReason)
              ? { preSignReason: error.preSignReason } : {}),
          });
          throw wrapped;
        }
        beforeSignCompletedAt = Number(clock());
      }

      // Any nested pre-sign reads use the same pacer independently. Reserve
      // the actual request's slot only after those reads, then timestamp and
      // sign immediately after the final wait.
      const transferJournal = write ? stopTransferContext.getStore()?.journal : null;
      if (transferJournal) {
        if (path !== PATH.order) throw new Error("stop_transfer_unexpected_mutation_endpoint");
        await transferJournal.beforeMutation({ method, params });
      }
      let query;
      let signature;
      try {
      await outboundPacer.waitForSlot({
        method, endpoint: path,
        priority: environment === "vst" && write && beforeSignCompletedAt !== undefined,
      });
      if (environment === "vst" && beforeSignCompletedAt !== undefined) {
        const pacingDelay = Number(clock()) - beforeSignCompletedAt;
        if (!Number.isFinite(pacingDelay) || pacingDelay < 0 ||
            pacingDelay > VST_PRE_SIGN_MAX_PACING_DELAY_MS) {
          throw new BingXLiveApiError(
            "VST final pre-sign checks expired while waiting for request pacing",
            {
              transportStage: "pre_transport",
              preSignReason: "final_pre_sign_pacing_expired",
            },
          );
        }
      }
      const values = {};
      for (const [name, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        if (typeof value === "object") throw new TypeError("BingX parameters must be scalar or pre-serialized JSON");
        values[name] = String(value);
      }
      values.recvWindow = String(RECV_WINDOW);
      // Recompute the timestamp and signature for each bounded GET retry.
      values.timestamp = String(clock());
      // BingX signs ASCII-key-sorted, unencoded values. Only the URL query
      // values are percent-encoded (notably the nested stopLoss JSON).
      const sorted = Object.entries(values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      const signingText = sorted.map(([name, value]) => `${name}=${value}`).join("&");
      query = new URLSearchParams(sorted).toString();
      signature = createHmac("sha256", secret).update(signingText).digest("hex");
      if (beforeTransport !== undefined) {
        if (typeof beforeTransport !== "function") {
          throw new TypeError("beforeTransport must be a function");
        }
        try {
          await beforeTransport(Number(values.timestamp));
        } catch (error) {
          throw new BingXLiveApiError("BingX request preparation failed", {
            transportStage: "pre_transport",
            ...(exposeVstPreSignReason &&
              ALLOWED_VST_PRE_SIGN_REASONS.has(error?.preSignReason)
              ? { preSignReason: error.preSignReason } : {}),
          });
        }
      }
      if (onTransportStart !== undefined) {
        if (typeof onTransportStart !== "function") {
          throw new TypeError("onTransportStart must be a function");
        }
        onTransportStart();
      }
      } catch (error) {
        if (transferJournal) await transferJournal.mutationNotSent({ method });
        throw error;
      }
      let response;
      try {
        response = await fetchImpl(`${origin}${path}?${query}&signature=${signature}`, {
          method,
          headers: {
            "X-BX-APIKEY": key,
            "X-SOURCE-KEY": "BX-AI-SKILL",
          },
          ...(environment === "vst" ? { redirect: "error" } : {}),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        const requestError = new BingXLiveApiError(
          `BingX ${write ? "private" : "read"} request failed at ${method} ${path}: ${
            error instanceof Error ? error.name : "network error"
          }`,
          {
            transportStage: "network_request",
            endpoint: path,
            method,
          },
        );
        if (canRetryTransientVstGet(method, attempt)) {
          scheduleTransientVstGetRetry(path, "network_request");
          continue;
        }
        throw requestError;
      }
      let responseText;
      try {
        responseText = await response.text();
      } catch (error) {
        const readError = new BingXLiveApiError(
          `BingX ${write ? "private" : "read"} response read failed at ${method} ${path}: ${
            error instanceof Error ? error.name : "network error"
          }`,
          {
            httpStatus: response.status,
            transportStage: "network_response_read",
            endpoint: path,
            method,
          },
        );
        if (canRetryTransientVstGet(method, attempt)) {
          scheduleTransientVstGetRetry(path, "network_response_read");
          continue;
        }
        throw readError;
      }
      let payload;
      try {
        payload = parseResponseJson(responseText);
      } catch (error) {
        if (error instanceof BingXLiveApiError) throw error;
        throw new BingXLiveApiError(`BingX returned invalid JSON from ${method} ${path}`, {
          httpStatus: response.status,
          transportStage: "response_parse",
          endpoint: path,
          method,
        });
      }
      if (!response.ok || payload?.code !== 0) {
        const exchangeMessage = typeof payload?.msg === "string" && payload.msg.trim() !== ""
          ? payload.msg.trim() : undefined;
        const timestampInvalid =
          method === "GET" &&
          Number(payload?.code) === 109400 &&
          typeof exchangeMessage === "string" &&
          exchangeMessage.toLowerCase() === "timestamp is invalid";
        if (timestampInvalid) {
          if (attempt + 1 < MAX_TIMESTAMP_INVALID_GET_ATTEMPTS) {
            scheduleTransientVstGetRetry(path, "timestamp_invalid", 109400);
            continue;
          }
          reportTransientGet(path, "retry_exhausted", "timestamp_invalid", 109400);
        }
        if (Number(payload?.code) === RETRYABLE_GET_ERROR_CODE) {
          scheduleRateLimitDelay(path, method, attempt, write ? 1 : MAX_RETRYABLE_GET_ATTEMPTS);
        }
        if (!write && Number(payload?.code) === RETRYABLE_GET_ERROR_CODE &&
            attempt + 1 < MAX_RETRYABLE_GET_ATTEMPTS) {
          continue;
        }
        if (Number(payload?.code) === RETRYABLE_VST_BUSY_ERROR_CODE &&
            canRetryTransientVstGet(method, attempt)) {
          scheduleTransientVstGetRetry(path, "exchange_busy", RETRYABLE_VST_BUSY_ERROR_CODE);
          continue;
        }
        // Always fold BingX's own `msg` into both the thrown message and the
        // structured detail. Several BingX codes (e.g. 109418) are not listed
        // in BingX's published error-code reference at all, so `msg` is often
        // the only way to tell a legitimate business-rule rejection apart from
        // a malformed request or a transient condition after the fact -- the
        // bare numeric code alone is not enough.
        const msg = exchangeMessage;
        throw new BingXLiveApiError(
          `BingX request failed (${method} ${path}, HTTP ${response.status}, code ${String(payload?.code ?? "unknown")}${
            msg ? `, msg: ${msg}` : ""
          })`,
          {
            httpStatus: response.status,
            code: payload?.code,
            ...(msg ? { exchangeMessage: msg } : {}),
            transportStage: "exchange_response",
            endpoint: path,
            method,
          },
        );
      }
      if (transferJournal) {
        let orderId;
        if (method === "POST") {
          try { orderId = exactOrderIdentifierFrom(payload.data, "protective stop response ID"); }
          catch { /* Native exact-ID discovery can acknowledge later; never invent an ID. */ }
        }
        await transferJournal.afterMutation({ method, orderId });
      }
      if (environment === "vst" && method === "GET" && contractDriftMonitor) {
        // Successful raw GET only, before normalization/refusal. Observation
        // failures are not trading/proof failures and may never change them.
        try { contractDriftMonitor.observe(path, payload.data, params); }
        catch { /* Observability is isolated from exchange proof. */ }
      }
      return payload.data;
    }
  }

  async function contract(symbol) {
    const name = symbolName(symbol);
    const data = await request("GET", PATH.contracts, { symbol: name });
    const row = rows(data).find((item) => item?.symbol === name);
    if (!row || row.status !== 1 || row.currency !== "USDT" ||
        row.apiStateOpen !== "true") {
      throw new BingXLiveApiError(`${name} is not an active API-tradeable USDT perpetual`);
    }
    const quantityPrecision = Number(row.quantityPrecision);
    const pricePrecision = Number(row.pricePrecision);
    if (!Number.isInteger(quantityPrecision) || quantityPrecision < 0 || quantityPrecision > 12 ||
        !Number.isInteger(pricePrecision) || pricePrecision < 0 || pricePrecision > 12) {
      throw new BingXLiveApiError(`BingX returned invalid precision for ${name}`);
    }
    const reportedMaxima = [row.maxLongLeverage, row.maxShortLeverage]
      .filter((value) => value !== undefined && value !== null && value !== "");
    const maximumValues = reportedMaxima.map(Number);
    if (maximumValues.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new BingXLiveApiError(`BingX returned invalid maximum leverage for ${name}`);
    }
    // Entry sizing is LONG-only: an advertised SHORT ceiling must not be used
    // as a proxy for the independently configured LONG ceiling.
    const maxLeverage = row.maxLongLeverage !== undefined &&
      row.maxLongLeverage !== null && row.maxLongLeverage !== ""
      ? Number(row.maxLongLeverage)
      : maximumValues.length ? Math.min(...maximumValues) : undefined;
    if (maxLeverage !== undefined && maxLeverage < 10) {
      throw new BingXLiveApiError(`${name} does not support leverage 10`);
    }
    return {
      symbol: name,
      quantityPrecision,
      pricePrecision,
      minQuantity: positive(row.tradeMinQuantity, "minimum quantity"),
      minNotional: positive(row.tradeMinUSDT, "minimum notional"),
      ...(maxLeverage !== undefined ? { maxLeverage } : {}),
    };
  }

  async function getRiskTiers(symbol) {
    const name = symbolName(symbol);
    const data = await request("GET", PATH.riskTiers, { symbol: name });
    const tiers = rows(data).filter((row) => row?.symbol == null || row.symbol === name)
      .map((row) => {
        try {
          const cap = strictNumeric(
            row.maxPositionVal ?? row.maxPosition, "risk tier maximum position",
          );
          const maintenanceMarginRate = strictNumeric(
            row.maintMarginRatio, "maintenance margin rate",
          );
          if (cap <= 0 || maintenanceMarginRate < 0 || maintenanceMarginRate >= 1) {
            throw new Error("risk tier out of range");
          }
          return { maxNotional: cap, maintenanceMarginRate };
        } catch {
          throw new BingXLiveApiError(`BingX risk tier data is incomplete for ${name}`);
        }
      })
      .sort((a, b) => a.maxNotional - b.maxNotional);
    if (!tiers.length) throw new BingXLiveApiError(`BingX returned no risk tiers for ${name}`);
    return tiers;
  }

  async function getFeeRate(symbol) {
    const data = await request("GET", PATH.fees, { symbol: symbolName(symbol) });
    const response = Array.isArray(data) ? data[0] : data;
    const row = response?.commission !== undefined
      ? response.commission : response;
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new BingXLiveApiError("BingX returned invalid commission data");
    }
    const maker = strictNumeric(row?.makerCommissionRate ?? row?.makerFeeRate, "maker commission rate");
    const taker = strictNumeric(row?.takerCommissionRate ?? row?.takerFeeRate, "taker commission rate");
    if (![maker, taker].every((value) => value >= 0 && value < 1)) {
      throw new BingXLiveApiError("BingX returned invalid commission rates");
    }
    return { maker, taker };
  }

  async function getFunding(symbol) {
    const name = symbolName(symbol);
    const data = await request("GET", PATH.funding, { symbol: name });
    const row = Array.isArray(data) ? data.find((item) => item?.symbol === name) : data;
    let rate;
    try {
      rate = strictNumeric(row?.lastFundingRate ?? row?.fundingRate, "funding rate", {
        allowNegative: true,
      });
    } catch {
      throw new BingXLiveApiError(`BingX returned invalid funding data for ${name}`);
    }
    if (row?.symbol !== name) {
      throw new BingXLiveApiError(`BingX returned invalid funding data for ${name}`);
    }
    return { rate, nextFundingTime: row.nextFundingTime ?? null };
  }

  async function getPositions(symbol) {
    const data = await request("GET", PATH.positions, symbol
      ? { symbol: symbolName(symbol) } : {});
    if (!Array.isArray(data)) throw new BingXLiveApiError("BingX returned invalid positions data");
    return data;
  }

  async function getBalance() {
    return request("GET", PATH.balance);
  }

  async function getOpenOrders(symbol) {
    const accountWide = symbol === undefined;
    const name = accountWide ? null : symbolName(symbol);
    const data = await request("GET", PATH.openOrders,
      accountWide ? {} : { symbol: name });
    if (accountWide) {
      let orders;
      if (Array.isArray(data)) {
        orders = data;
      } else if (data && typeof data === "object" && !Array.isArray(data) &&
          Object.keys(data).length === 1 && Object.hasOwn(data, "orders") &&
          Array.isArray(data.orders)) {
        orders = data.orders;
      } else {
        throw new BingXLiveApiError(
          "BingX returned invalid account-wide open orders data",
        );
      }
      const seenOrderIds = new Set();
      for (const order of orders) {
        if (!order || typeof order !== "object" || Array.isArray(order) ||
            typeof order.symbol !== "string" ||
            !/^[A-Z0-9]+-USDT$/.test(order.symbol)) {
          throw new BingXLiveApiError(
            "BingX returned invalid account-wide open orders data",
          );
        }
        let orderId;
        try {
          orderId = orderIdentifierFrom(order, "open order ID");
        } catch {
          throw new BingXLiveApiError(
            "BingX returned invalid account-wide open orders data",
          );
        }
        if (seenOrderIds.has(orderId)) {
          throw new BingXLiveApiError(
            "BingX returned duplicate account-wide open order IDs",
          );
        }
        seenOrderIds.add(orderId);
      }
      return orders;
    }
    const orders = Array.isArray(data) ? data : data?.orders;
    if (!Array.isArray(orders) || orders.some((order) =>
      !order || typeof order !== "object" || order.symbol !== name ||
      (() => {
        try {
          orderIdentifierFrom(order, "open order ID");
          return false;
        } catch {
          return true;
        }
      })())) {
      throw new BingXLiveApiError("BingX returned invalid open orders data");
    }
    return orders;
  }

  async function queryOrderHistory(symbol, { startTs, endTs } = {}) {
    const start = Number(startTs);
    const end = Number(endTs);
    const now = Number(clock());
    if (!Number.isSafeInteger(start) || start <= 0 ||
        !Number.isSafeInteger(end) || end < start ||
        !Number.isSafeInteger(now) || start < now - VST_ORDER_HISTORY_MAX_AGE_MS ||
        end > now + 2_000 || end - start > VST_ORDER_HISTORY_MAX_AGE_MS) {
      throw new TypeError(
        "order history requires a bounded recent millisecond intent window",
      );
    }
    const name = symbolName(symbol);
    const data = await request("GET", PATH.allOrders, {
      symbol: name,
      startTime: start,
      endTime: end,
      limit: 500,
    });
    const history = Array.isArray(data) ? data : data?.orders;
    if (!Array.isArray(history) || history.length >= 500 || history.some((order) => {
      if (!order || typeof order !== "object" || Array.isArray(order) ||
          order.symbol !== name) return true;
      const clientIds = [order.clientOrderId, order.clientOrderID]
        .filter((value) => value !== undefined && value !== null);
      return clientIds.length === 0 ||
        clientIds.some((value) => typeof value !== "string" ||
          (value.length === 0 && order.type !== "STOP_MARKET")) ||
        new Set(clientIds).size !== 1;
    })) {
      throw new BingXLiveApiError("BingX returned invalid order history data");
    }
    return history;
  }

  function validHistoryIntentCreatedAt(value) {
    const createdAt = Number(value);
    const now = Number(clock());
    if (!Number.isSafeInteger(createdAt) || createdAt <= 0 ||
        !Number.isSafeInteger(now) || createdAt > now + 2_000 ||
        now - createdAt > VST_ORDER_HISTORY_MAX_AGE_MS) {
      throw new BingXLiveApiError(
        "Exact order recovery requires a recent durable intent-created timestamp",
      );
    }
    return createdAt;
  }

  async function queryOrderByClientIdWithExactRecovery(symbol, clientOrderId, {
    knownOrderId, intentCreatedAt, label = "VST order",
  } = {}) {
    const clientIds = (row) => ["clientOrderId", "clientOrderID"]
      .filter((key) => row?.[key] !== undefined && row[key] !== null)
      .map((key) => row[key]);
    const exactClientId = (row) => {
      const values = clientIds(row);
      return values.length > 0 && values.every((value) =>
        typeof value === "string" && value === clientOrderId);
    };
    const hasId = (row) =>
      row?.orderId !== undefined && row.orderId !== null ||
      row?.orderID !== undefined && row.orderID !== null;
    const direct = await queryOrder(symbol, { clientOrderId });
    let orderId = null;
    if (hasId(direct)) {
      orderId = exactStringOrderId(direct);
      if (!orderId || !exactClientId(direct)) {
        throw new BingXLiveApiError(
          `${label} client-ID lookup returned a conflicting or non-lossless order ID`,
        );
      }
      if (knownOrderId !== undefined && knownOrderId !== null &&
          (typeof knownOrderId !== "string" || knownOrderId !== orderId)) {
        throw new BingXLiveApiError(
          `${label} client-ID and exact order-ID lookups conflict`,
        );
      }
    } else if (knownOrderId !== undefined && knownOrderId !== null) {
      if (typeof knownOrderId !== "string" || !knownOrderId) {
        throw new BingXLiveApiError(
          `${label} recovery refuses a non-string or unsafe immediate order ID`,
        );
      }
      orderId = knownOrderId;
    } else {
      const createdAt = validHistoryIntentCreatedAt(intentCreatedAt);
      const history = await queryOrderHistory(symbol, {
        startTs: Math.max(1, createdAt - 60_000),
        endTs: Math.max(1, Math.floor(clock())),
      });
      const matches = [];
      for (const row of history) {
        const ids = clientIds(row);
        const referencesClientId = ids.some((value) => value === clientOrderId);
        if (!referencesClientId) continue;
        if (!exactClientId(row)) {
          throw new BingXLiveApiError(
            `${label} order history contains a conflicting client-ID match`,
          );
        }
        const exactId = exactStringOrderId(row);
        if (!exactId) {
          throw new BingXLiveApiError(
            `${label} order history has no lossless string order ID`,
          );
        }
        matches.push(row);
      }
      if (matches.length !== 1) {
        throw new BingXLiveApiError(
          `${label} order history must contain exactly one recent client-ID match`,
        );
      }
      orderId = exactStringOrderId(matches[0]);
    }
    const queried = await queryOrder(symbol, { orderId });
    if (!queried || exactStringOrderId(queried) !== orderId ||
        queried.symbol !== symbolName(symbol) || !exactClientId(queried)) {
      throw new BingXLiveApiError(
        `${label} exact order-ID query does not independently confirm client-ID history`,
      );
    }
    return { orderId, order: queried };
  }

  // BingX income uses a capped, non-cursor list. Split saturated windows
  // rather than treating a truncated list as complete history.
  async function queryFundingSettlements(symbol, { startTs, endTs }) {
    const name = symbolName(symbol);
    if (!Number.isSafeInteger(startTs) || startTs <= 0 ||
        !Number.isSafeInteger(endTs) || endTs < startTs) {
      throw new TypeError("Funding interval must contain ordered millisecond timestamps");
    }
    const read = async (start, end) => {
      const data = await request("GET", PATH.income, {
        symbol: name, incomeType: "FUNDING_FEE",
        startTime: start, endTime: end, limit: 1000,
      });
      if (!Array.isArray(data)) throw new BingXLiveApiError("BingX returned invalid funding history");
      if (data.length >= 1000) {
        if (start === end) throw new BingXLiveApiError("Funding history saturated at one millisecond");
        const middle = start + Math.floor((end - start) / 2);
        return [...await read(start, middle), ...await read(middle + 1, end)];
      }
      return data.map((row) => {
        const time = row?.time;
        const rawAmount = row?.income;
        const amount = typeof rawAmount === "string" ? rawAmount : "";
        if (row?.symbol !== name || row?.incomeType !== "FUNDING_FEE" ||
            row?.asset !== "USDT" || !Number.isSafeInteger(time) ||
            time < start || time > end ||
            !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amount)) {
          throw new BingXLiveApiError("BingX returned invalid funding settlement");
        }
        return {
          transactionId: orderIdentifier(row.tranId, "funding transaction ID"),
          amountUsdt: amount,
          settledAt: new Date(time).toISOString(),
          time,
        };
      });
    };
    // Income history is retained for only three months. Refuse to certify
    // outside that horizon even if an old query happens to return an empty list.
    if (startTs < clock() - 89 * 24 * 60 * 60 * 1000) {
      throw new BingXLiveApiError("Funding interval exceeds private income retention");
    }
    const result = await read(startTs, endTs);
    const ids = new Set();
    for (const row of result) {
      if (ids.has(row.transactionId)) throw new BingXLiveApiError("Duplicate funding transaction in history");
      ids.add(row.transactionId);
    }
    return result;
  }

  // Account-wide realized-trade history for the REAL "recently closed"
  // journal view. Unlike queryFundingSettlements this deliberately omits a
  // symbol filter -- REAL has no ledger recording which symbols were ever
  // traded, so the whole account must be queried. Returns raw validated
  // income rows (REALIZED_PNL / INSURANCE_CLEAR / TRADING_FEE, among others);
  // the caller groups them by tradeId into closed-trade records. No price,
  // quantity, or margin field exists in this data -- never fabricate one.
  async function queryClosedTradeIncome({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 500) {
      throw new TypeError("queryClosedTradeIncome limit must be a positive integer up to 500");
    }
    const data = await request("GET", PATH.income, { limit });
    if (!Array.isArray(data)) {
      throw new BingXLiveApiError("BingX returned invalid income history data");
    }
    return data.map((row) => {
      const time = row?.time;
      const rawAmount = row?.income;
      const amount = typeof rawAmount === "string" ? rawAmount : "";
      if (!row || typeof row !== "object" || Array.isArray(row) ||
          typeof row.symbol !== "string" || !row.symbol ||
          typeof row.incomeType !== "string" || !row.incomeType ||
          row.asset !== "USDT" || !Number.isSafeInteger(time) || time <= 0 ||
          !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amount) ||
          typeof row.tradeId !== "string" || !row.tradeId) {
        throw new BingXLiveApiError("BingX returned an invalid income row");
      }
      return {
        symbol: row.symbol,
        incomeType: row.incomeType,
        amountUsdt: amount,
        info: typeof row.info === "string" ? row.info : null,
        tradeId: row.tradeId,
        time,
        occurredAt: new Date(time).toISOString(),
      };
    });
  }

  async function queryForcedOrders(symbol, { startTs, endTs }) {
    if (!Number.isSafeInteger(startTs) || startTs <= 0 ||
        !Number.isSafeInteger(endTs) || endTs < startTs) {
      throw new TypeError("Force-order interval must contain ordered millisecond timestamps");
    }
    const name = symbolName(symbol);
    const data = await request("GET", PATH.forceOrders, {
      symbol: name, startTime: startTs, endTime: endTs, limit: 100,
    });
    const result = Array.isArray(data) ? data : data?.orders;
    if (!Array.isArray(result) || result.length >= 100 ||
        result.some((row) => row?.symbol !== name)) {
      throw new BingXLiveApiError("BingX forced-order history is incomplete");
    }
    return result;
  }

  async function getPositionMode() {
    const data = await request("GET", PATH.positionMode);
    const dual = data?.dualSidePosition;
    if (dual !== true && dual !== false && dual !== "true" && dual !== "false") {
      throw new BingXLiveApiError("BingX position mode is unknown");
    }
    return dual === false || dual === "false" ? "ONE_WAY" : "HEDGE";
  }

  async function getLeverage(symbol) {
    const name = symbolName(symbol);
    const data = await request("GET", PATH.leverage, { symbol: name });
    const row = Array.isArray(data) ? data.find((item) => item?.symbol === name) : data;
    const longLeverage = Number(row?.longLeverage);
    const shortLeverage = Number(row?.shortLeverage);
    if ((row?.symbol !== undefined && row.symbol !== name) ||
        ![longLeverage, shortLeverage].every((value) =>
      Number.isFinite(value) && value > 0)) {
      throw new BingXLiveApiError(`BingX returned invalid leverage for ${name}`);
    }
    // BingX enforces a separate, tighter maximum position VALUE per symbol at
    // the currently configured leverage -- independent of, and often far
    // smaller than, the maintenance-margin risk tiers from getRiskTiers.
    // Submitting past it is a genuine exchange rejection (e.g. code 101209,
    // "the maximum position value for this leverage is X USDT"), so sizing
    // must be able to see and respect it before ever placing an order.
    const maxPositionLongVal = positive(row?.maxPositionLongVal, "maximum long position value");
    return { longLeverage, shortLeverage, maxPositionLongVal };
  }

  async function getMarginType(symbol) {
    const name = symbolName(symbol);
    const data = await request("GET", PATH.marginType, { symbol: name });
    const marginType = typeof data?.marginType === "string"
      ? data.marginType.toUpperCase() : null;
    if (marginType !== "ISOLATED" && marginType !== "CROSSED") {
      throw new BingXLiveApiError(`BingX returned invalid margin type for ${name}`);
    }
    return marginType;
  }

  async function preflight(symbol, {
    requiredMargin = 10, quantity, entryPrice, stopLoss, probePolicy,
    automatedLongPolicy, approvedTopUpMargin, refreshEntryPricing,
  } = {}) {
    const name = symbolName(symbol);
    const usesProbePolicy = validateProbePolicy(symbol, probePolicy);
    const usesAutomatedLongPolicy = validateAutomatedLongPolicy(symbol, automatedLongPolicy);
    if (usesProbePolicy && usesAutomatedLongPolicy) {
      throw new BingXLiveApiError("VST preflight policies are mutually exclusive");
    }
    let availableRequired = positive(requiredMargin, "required margin");
    if (approvedTopUpMargin !== undefined && approvedTopUpMargin !== null &&
        (!usesAutomatedLongPolicy || typeof approvedTopUpMargin !== "string" ||
         !/^\d+(?:\.\d+)?$/.test(approvedTopUpMargin))) {
      throw new BingXLiveApiError(
        "approvedTopUpMargin is valid only as an exact decimal for VST automated LONG",
      );
    }
    const approvedTopUpReserve = approvedTopUpMargin == null
      ? null
      : positive(approvedTopUpMargin, "approved VST top-up amount");
    const [balanceData, positions, openOrders, mode, filters, tiers, fees, funding, leverage, marginType] =
      await Promise.all([
        request("GET", PATH.balance),
        getPositions(),
        getOpenOrders(symbol),
        getPositionMode(),
        contract(symbol),
        getRiskTiers(symbol),
        getFeeRate(symbol),
        getFunding(symbol),
        getLeverage(symbol),
        getMarginType(symbol),
      ]);
    if (refreshEntryPricing !== undefined) {
      if (!usesAutomatedLongPolicy || environment !== "vst" ||
          typeof refreshEntryPricing !== "function") {
        throw new BingXLiveApiError("Fresh entry pricing requires the VST automated LONG policy");
      }
      const refreshed = await refreshEntryPricing({
        balanceData, filters, tiers, fees, funding, leverage,
      });
      quantity = refreshed.quantity;
      entryPrice = refreshed.maxEntryPrice;
      requiredMargin = refreshed.initialBudgetVst;
      availableRequired = positive(requiredMargin, "fresh required margin");
    }
    const marginBalances = flattenBalance(balanceData).filter((row) => row?.asset === marginAsset);
    let available = null;
    if (marginBalances.length === 1) {
      try {
        available = strictNumeric(
          marginBalances[0].availableMargin, `available ${marginAsset} margin`,
        );
      } catch {
        available = null;
      }
    }
    const symbolFlat = positions.every((position) => {
      if (position?.symbol !== name) return typeof position?.symbol === "string";
      const amount = validPositionAmount(position);
      const side = position.positionSide;
      return amount === 0 && (side === "BOTH" || side === "LONG" ||
        side === "SHORT" || side == null);
    });
    // The automated LONG path verifies this worker's own margin mode/leverage.
    const isolated = usesAutomatedLongPolicy
      ? marginType === PROFILE_MARGIN : marginType === "ISOLATED";
    const leverageOk = leverage.longLeverage === 10 && leverage.shortLeverage === 10;
    const probeLeverageOk = leverage.longLeverage === 10 && leverage.shortLeverage === 75;
    const automatedLongLeverageOk = leverage.longLeverage === PROFILE_LEVERAGE &&
      Number.isFinite(leverage.shortLeverage) && leverage.shortLeverage > 0;
    const supportedMode = mode === "ONE_WAY" || mode === "HEDGE";
    let risk = null;
    if (quantity !== undefined || entryPrice !== undefined || stopLoss !== undefined) {
      if (quantity === undefined || entryPrice === undefined || stopLoss === undefined) {
        throw new BingXLiveApiError("Quantity, entry price and stop loss must be supplied together");
      }
      risk = assessStopRisk({
        quantity, entryPrice, stopLoss, filters, tiers, fees, funding,
        requiredInitialMargin: availableRequired,
        ...(usesAutomatedLongPolicy
          ? { leverageValue: PROFILE_LEVERAGE, marginMode: PROFILE_MARGIN } : {}),
      });
    }
    const plannedTopUpUsd = risk?.plannedTopUpUsd ?? 0;
    const requiredTotalMargin = availableRequired +
      Math.max(plannedTopUpUsd, approvedTopUpReserve ?? 0);
    const marginOk = available !== null && available >= requiredTotalMargin;
    if (risk) {
      risk.funded = marginOk;
      risk.safe = risk.protectionAfterTopUp && marginOk && risk.withinInitialNotionalLimit;
    }
    const checks = {
      marginTypeIsolated: isolated,
      ...(usesProbePolicy
        ? {
          leverageLong10: leverage.longLeverage === 10,
          leverageShort75: leverage.shortLeverage === 75,
          leverageProbePolicy: probeLeverageOk,
          positionModeHedge: mode === "HEDGE",
          noPlannedTopUp: plannedTopUpUsd === 0,
        }
        : usesAutomatedLongPolicy
          ? {
            leverageLong10: leverage.longLeverage === PROFILE_LEVERAGE,
            leverageShortIndependentlyVerified: automatedLongLeverageOk,
          }
          : { leverage10: leverageOk }),
      positionModeSupported: supportedMode,
      symbolFlat,
      symbolOpenOrdersEmpty: openOrders.length === 0,
      initialMargin: marginOk,
      notionalWithinInitialMargin: risk ? risk.withinInitialNotionalLimit : null,
      contractValid: true,
      riskTiersAvailable: tiers.length > 0,
      feeRateAvailable: true,
      fundingAvailable: true,
      stopSafe: risk ? risk.safe : null,
    };
    const blockers = Object.entries(checks)
      .filter(([, ok]) => ok === false)
      .map(([key]) => key);
    return {
      status: blockers.length ? "blocked" : "ready",
      environment,
      symbol: name,
      positionMode: mode,
      ...(usesProbePolicy ? { probePolicy } : {}),
      ...(usesAutomatedLongPolicy ? { automatedLongPolicy } : {}),
      checks,
      blockers,
      ...(environment === "vst"
        ? { marginAsset, plannedTopUpMargin: plannedTopUpUsd }
        : { plannedTopUpUsd }),
      ...(approvedTopUpReserve !== null
        ? { approvedTopUpMargin: approvedTopUpReserve }
        : {}),
      requiredInitialMargin: availableRequired,
      requiredTotalMargin,
      ...(risk ? {
        stopRisk: environment === "vst"
          ? (({ plannedTopUpUsd: plannedTopUpMargin, ...riskInMarginUnits }) => ({
            ...riskInMarginUnits, plannedTopUpMargin, marginAsset,
          }))(risk)
          : risk,
      } : {}),
    };
  }

  function assessStopRisk({
    quantity, entryPrice, stopLoss, filters, tiers, fees, funding, requiredInitialMargin,
    leverageValue = 10, marginMode = "ISOLATED",
  }) {
    const qtyText = floorQuantity(quantity, filters.quantityPrecision);
    const qty = positive(qtyText, "quantity");
    decimalAtPrecision(entryPrice, filters.pricePrecision, "Entry price");
    decimalAtPrecision(stopLoss, filters.pricePrecision, "Stop loss");
    const entry = positive(entryPrice, "entry price");
    const stop = positive(stopLoss, "stop loss");
    if (stop >= entry) throw new BingXLiveApiError("Long stop loss must be below entry price");
    if (qty < filters.minQuantity || qty * entry < filters.minNotional) {
      throw new BingXLiveApiError("Order is below BingX contract minimums");
    }
    const notional = qty * entry;
    const withinInitialNotionalLimit = notional <= requiredInitialMargin * leverageValue;
    const tier = tiers.find((item) => notional <= item.maxNotional);
    if (!tier) throw new BingXLiveApiError("Order notional exceeds every BingX risk tier");

    // Linear isolated-margin estimate at 10x. Reserve taker fees for both
    // entry and exit, absolute funding, and a 0.5% price buffer.
    const fundingReserve = Math.abs(funding.rate);
    const roundTripFeeReserve = fees.taker * 2;
    const liquidationPrice = entry * (
      1 - 1 / leverageValue + tier.maintenanceMarginRate + roundTripFeeReserve + fundingReserve
    );
    const buffer = Math.max(entry * 0.005, 10 ** -filters.pricePrecision);
    const requiredStop = liquidationPrice + buffer;
    const rawExtra = Math.max(0, (requiredStop - stop) * qty);
    // Round the planned top-up upward to cents, then add one cent to preserve
    // the strict stop > liquidation+buffer inequality despite rounding.
    // Cross margin: the account backs the position; there is no isolated
    // position margin to top up and no per-position liquidation estimate.
    const cross = marginMode === "CROSSED";
    const plannedTopUpUsd = cross || stop > requiredStop
      ? 0
      : Math.ceil(rawExtra * 100) / 100 + 0.01;
    const fundedLiquidationPrice = liquidationPrice - plannedTopUpUsd / qty;
    const protectionAfterTopUp = cross || stop > fundedLiquidationPrice + buffer;
    return {
      safe: false,
      protectionAfterTopUp,
      funded: false,
      withinInitialNotionalLimit,
      entryPrice: entry,
      stopPrice: stop,
      exactStopDistance: subtractDecimals(entryPrice, stopLoss),
      estimatedLiquidationPrice: liquidationPrice,
      estimatedLiquidationPriceAfterTopUp: fundedLiquidationPrice,
      requiredStopMinimum: requiredStop,
      plannedTopUpUsd,
      notional,
      maintenanceMarginRate: tier.maintenanceMarginRate,
      takerFeeRate: fees.taker,
      roundTripFeeReserveRate: roundTripFeeReserve,
      fundingRate: funding.rate,
      leverage: leverageValue,
      ...(marginMode === "ISOLATED" ? {} : { marginMode }),
    };
  }

  async function placeLong({ symbol, quantity, entryPrice, stopLoss, clientOrderId }) {
    const name = symbolName(symbol);
    if (typeof clientOrderId !== "string" ||
        !/^[A-Za-z0-9_-]{1,32}$/.test(clientOrderId)) {
      throw new BingXLiveApiError(
        "A unique clientOrderId is required for duplicate-order protection",
        { code: "INVALID_CLIENT_ORDER_ID", transportStage: "pre-sign" },
      );
    }
    if (submittedClientOrderIds.has(clientOrderId)) {
      throw new BingXLiveApiError("clientOrderId was already submitted; reconcile before retrying");
    }
    const readiness = await preflight(symbol, { quantity, entryPrice, stopLoss });
    if (readiness.status !== "ready") {
      throw new BingXLiveApiError(`BingX order preflight blocked: ${readiness.blockers.join(",")}`);
    }
    const filters = await contract(symbol);
    const sizedQuantity = floorQuantity(quantity, filters.quantityPrecision);
    decimalAtPrecision(stopLoss, filters.pricePrecision, "Stop loss");
    const stop = Number(stopLoss);
    const params = {
      symbol: name,
      side: "BUY",
      positionSide: readiness.positionMode === "HEDGE" ? "LONG" : "BOTH",
      type: "MARKET",
      quantity: sizedQuantity,
      stopLoss: JSON.stringify({ type: "STOP_MARKET", stopPrice: stop }),
      clientOrderId,
    };
    // Reserve before the network call. An ambiguous timeout must be reconciled,
    // never blindly retried with another live order.
    submittedClientOrderIds.add(clientOrderId);
    const result = await request("POST", PATH.order, params);
    orderIdentifierFrom(result, "submitted order ID");
    return result;
  }

  async function placeVstBoundedLong({
    symbol, quantity, maxPrice, stopLoss, clientOrderId, onAttemptStarted,
  }) {
    const name = requireVstBtc(symbol);
    if (typeof clientOrderId !== "string" ||
        !/^[A-Za-z0-9_-]{1,32}$/.test(clientOrderId)) {
      throw new BingXLiveApiError(
        "A unique clientOrderId is required for duplicate-order protection",
        { code: "INVALID_CLIENT_ORDER_ID", transportStage: "pre-sign" },
      );
    }
    if (submittedClientOrderIds.has(clientOrderId)) {
      throw new BingXLiveApiError("clientOrderId was already submitted; reconcile before retrying");
    }
    const price = String(maxPrice);
    const filters = await contract(symbol);
    decimalAtPrecision(price, filters.pricePrecision, "Maximum entry price");
    const readiness = await preflight(symbol, {
      requiredMargin: 10, quantity, entryPrice: price, stopLoss,
    });
    const notional = positive(floorQuantity(quantity, filters.quantityPrecision), "quantity") *
      positive(price, "maximum entry price");
    if (notional > 100 || notional / 10 > 10) {
      throw new BingXLiveApiError("VST bounded entry exceeds 100 VST notional or 10 VST initial margin");
    }
    if (readiness.status !== "ready") {
      throw new BingXLiveApiError(`VST bounded entry preflight blocked: ${readiness.blockers.join(",")}`);
    }
    const sizedQuantity = floorQuantity(quantity, filters.quantityPrecision);
    decimalAtPrecision(stopLoss, filters.pricePrecision, "Stop loss");
    const params = {
      symbol: name,
      side: "BUY",
      positionSide: readiness.positionMode === "HEDGE" ? "LONG" : "BOTH",
      type: "LIMIT",
      quantity: sizedQuantity,
      price,
      timeInForce: "FOK",
      stopLoss: JSON.stringify({ type: "STOP_MARKET", stopPrice: Number(stopLoss) }),
      clientOrderId,
    };
    // Reserve before the network call. Reconcile ambiguous outcomes; never retry.
    submittedClientOrderIds.add(clientOrderId);
    const result = await request("POST", PATH.order, params, {
      ...(onAttemptStarted !== undefined ? { beforeTransport: onAttemptStarted } : {}),
    });
    orderIdentifierFrom(result, "submitted order ID");
    return result;
  }

  async function placeVstOnePercentBoundedLong({
    symbol, quantity, maxPrice, stopLoss, clientOrderId, probePolicy,
  }) {
    const name = requireVstBtc(symbol);
    requireProbePolicy(symbol, probePolicy);
    if (typeof clientOrderId !== "string" ||
        !/^[A-Za-z0-9_-]{1,32}$/.test(clientOrderId)) {
      throw new BingXLiveApiError(
        "A unique clientOrderId is required for duplicate-order protection",
        { code: "INVALID_CLIENT_ORDER_ID", transportStage: "pre-sign" },
      );
    }
    if (submittedClientOrderIds.has(clientOrderId)) {
      throw new BingXLiveApiError("clientOrderId was already submitted; reconcile before retrying");
    }
    const price = String(maxPrice);
    const filters = await contract(symbol);
    decimalAtPrecision(price, filters.pricePrecision, "Maximum entry price");
    const [balanceData, mode] = await Promise.all([getBalance(), getPositionMode()]);
    if (mode !== "HEDGE") {
      throw new BingXLiveApiError("VST supervised entry requires verified HEDGE mode");
    }
    const vstRows = flattenBalance(balanceData).filter((row) => row?.asset === "VST");
    if (vstRows.length !== 1) {
      throw new BingXLiveApiError("VST entry requires exactly one total VST balance row");
    }
    const totalBalance = strictNumeric(vstRows[0].balance, "total VST balance");
    const initialMarginBudget = totalBalance * 0.01;
    if (!Number.isFinite(initialMarginBudget) || initialMarginBudget <= 0) {
      throw new BingXLiveApiError("VST one-percent initial-margin budget is invalid");
    }
    const sizedQuantity = floorQuantity(quantity, filters.quantityPrecision);
    const notional = positive(sizedQuantity, "quantity") * positive(price, "maximum entry price");
    if (notional / 10 > initialMarginBudget) {
      throw new BingXLiveApiError("VST FOK entry exceeds one percent of the total VST balance");
    }
    const readiness = await preflight(symbol, {
      requiredMargin: initialMarginBudget,
      quantity: sizedQuantity,
      entryPrice: price,
      stopLoss,
      probePolicy,
    });
    if (readiness.status !== "ready" || readiness.positionMode !== "HEDGE" ||
        readiness.checks.marginTypeIsolated !== true ||
        readiness.checks.leverageProbePolicy !== true ||
        readiness.checks.leverageLong10 !== true ||
        readiness.checks.leverageShort75 !== true ||
        readiness.checks.positionModeHedge !== true ||
        readiness.checks.noPlannedTopUp !== true ||
        readiness.checks.symbolFlat !== true || readiness.checks.symbolOpenOrdersEmpty !== true ||
        readiness.stopRisk?.safe !== true ||
        Number(readiness.plannedTopUpMargin ?? 0) !== 0) {
      throw new BingXLiveApiError(
        `VST one-percent entry preflight blocked: ${readiness.blockers.join(",")}`,
      );
    }
    decimalAtPrecision(stopLoss, filters.pricePrecision, "Stop loss");
    const params = {
      symbol: name,
      side: "BUY",
      positionSide: "LONG",
      type: "LIMIT",
      quantity: sizedQuantity,
      price,
      timeInForce: "FOK",
      stopLoss: JSON.stringify({ type: "STOP_MARKET", stopPrice: Number(stopLoss) }),
      clientOrderId,
    };
    // Deliberately separate from the legacy 10 VST/100-notional operation.
    // Reserve this ID before transport so an unknown result cannot be retried.
    submittedClientOrderIds.add(clientOrderId);
    const result = await request("POST", PATH.order, params, {
      exposeVstPreSignReason: true,
      beforeSign: async () => {
        let finalBalanceData;
        try {
          finalBalanceData = await getBalance();
        } catch {
          throw new BingXLiveApiError("VST final balance read failed", {
            preSignReason: "final_balance_unavailable",
          });
        }
        const finalBalanceRows = flattenBalance(finalBalanceData)
          .filter((row) => row?.asset === "VST");
        if (finalBalanceRows.length !== 1) {
          throw new BingXLiveApiError("VST final balance row is invalid", {
            preSignReason: "final_balance_invalid",
          });
        }
        let finalBudget;
        try {
          finalBudget = strictNumeric(
            finalBalanceRows[0].balance, "final total VST balance",
          ) * 0.01;
          if (!Number.isFinite(finalBudget) || finalBudget <= 0) throw new Error("invalid");
        } catch {
          throw new BingXLiveApiError("VST final balance value is invalid", {
            preSignReason: "final_balance_invalid",
          });
        }
        if (positive(sizedQuantity, "quantity") * positive(price, "maximum entry price") / 10 >
            finalBudget) {
          throw new BingXLiveApiError("VST final entry exceeds the current initial-margin budget", {
            preSignReason: "final_budget_exceeded",
          });
        }
        let finalReadiness;
        try {
          finalReadiness = await preflight(symbol, {
            requiredMargin: finalBudget,
            quantity: sizedQuantity,
            entryPrice: price,
            stopLoss,
            probePolicy,
          });
        } catch {
          throw new BingXLiveApiError("VST final preflight read failed", {
            preSignReason: "final_preflight_unavailable",
          });
        }
        if (!finalReadiness || typeof finalReadiness !== "object" ||
            !finalReadiness.checks || typeof finalReadiness.checks !== "object" ||
            finalReadiness.status !== "ready" ||
            finalReadiness.checks.leverageProbePolicy !== true ||
            finalReadiness.checks.marginTypeIsolated !== true ||
            finalReadiness.checks.positionModeHedge !== true ||
            finalReadiness.checks.noPlannedTopUp !== true ||
            finalReadiness.checks.symbolFlat !== true ||
            finalReadiness.checks.symbolOpenOrdersEmpty !== true ||
            finalReadiness.stopRisk?.safe !== true ||
            Number(finalReadiness.plannedTopUpMargin ?? 0) !== 0) {
          throw new BingXLiveApiError("VST final entry state check blocked", {
            preSignReason: "final_preflight_blocked",
          });
        }
        let quote;
        try {
          quote = await getFreshVstAsk(symbol);
        } catch {
          throw new BingXLiveApiError("VST final quote unavailable or stale", {
            preSignReason: "final_quote_unavailable_or_stale",
          });
        }
        const tick = 10 ** -filters.pricePrecision;
        if (quote.ask > Number(price) ||
            Number(price) - quote.ask > quote.ask * 0.005 + tick) {
          throw new BingXLiveApiError("VST final ask is outside the bounded FOK price", {
            preSignReason: "final_quote_out_of_bounds",
          });
        }
      },
    });
    orderIdentifierFrom(result, "submitted order ID");
    return result;
  }

  async function placeVstAutomatedLong({
    symbol, quantity, maxPrice, stopLoss, clientOrderId,
    signalAt,
    approvedTopUpMargin = null,
    policy = VST_AUTOMATED_LONG_POLICY,
    refreshSizing = null, onReprice, onTransportReady, onEntryTiming,
  }) {
    const attemptStartedAtMs = Number(clock());
    let finalPriceStartedAtMs, finalPriceCompletedAtMs, checksCompletedAtMs;
    let freshnessExpired = false;
    const emitEntryTiming = (detail) => {
      if (typeof onEntryTiming !== "function") return;
      // Never await observability on the order's freshness-critical path.
      try {
        Promise.resolve(onEntryTiming({
          version: "entry-latency-v1", clientOrderId, attemptStartedAtMs, ...detail,
        })).catch((error) => {
          recordVstDiagnostic(error, { stage: "entry_latency_telemetry" });
        });
      } catch (error) {
        recordVstDiagnostic(error, { stage: "entry_latency_telemetry" });
      }
    };
    emitEntryTiming({ boundary: "started" });
    const name = symbolName(symbol);
    if (environment !== "vst") {
      throw new BingXLiveApiError("VST automated LONG entry is unavailable outside VST");
    }
    validateAutomatedLongPolicy(symbol, policy);
    if (typeof clientOrderId !== "string" ||
        !/^[A-Za-z0-9_-]{1,32}$/.test(clientOrderId)) {
      throw new BingXLiveApiError("A unique clientOrderId is required for duplicate-order protection");
    }
    if (submittedClientOrderIds.has(clientOrderId)) {
      throw new BingXLiveApiError("clientOrderId was already submitted; reconcile before retrying");
    }
    if (refreshSizing !== null && typeof onReprice !== "function") {
      throw new BingXLiveApiError("Fresh sizing requires durable intent repricing");
    }
    let price = String(maxPrice);
    const filters = await contract(symbol);
    decimalAtPrecision(price, filters.pricePrecision, "Maximum entry price");
    const [balanceData, mode] = await Promise.all([getBalance(), getPositionMode()]);
    if (mode !== "HEDGE") {
      throw new BingXLiveApiError("VST automated LONG entry requires verified HEDGE mode");
    }
    const vstRows = flattenBalance(balanceData).filter((row) => row?.asset === "VST");
    if (vstRows.length !== 1) {
      throw new BingXLiveApiError("VST entry requires exactly one total VST balance row");
    }
    const totalBalance = strictNumeric(vstRows[0].balance, "total VST balance");
    const initialMarginBudget = allocationBudget(PROFILE, totalBalance);
    if (!Number.isFinite(initialMarginBudget) || initialMarginBudget <= 0) {
      throw new BingXLiveApiError("VST one-percent initial-margin budget is invalid");
    }
    let sizedQuantity = floorQuantity(quantity, filters.quantityPrecision);
    let qty = positive(sizedQuantity, "quantity");
    const notional = qty * positive(price, "maximum entry price");
    if (refreshSizing === null && notional / PROFILE_LEVERAGE > initialMarginBudget) {
      throw new BingXLiveApiError("VST entry exceeds one percent of the total VST balance");
    }
    if (approvedTopUpMargin !== null &&
        (typeof approvedTopUpMargin !== "string" ||
         !/^\d+(?:\.\d+)?$/.test(approvedTopUpMargin))) {
      throw new BingXLiveApiError("approvedTopUpMargin must be an exact positive decimal string");
    }
    // This is an entry-time funding estimate, not an immutable ceiling. The
    // actual top-up is calculated after the filled position exists.
    if (approvedTopUpMargin !== null) {
      positive(approvedTopUpMargin, "estimated VST top-up amount");
    }
    const plannedTopUp = (state, context) => {
      if (!Object.hasOwn(state ?? {}, "plannedTopUpMargin") ||
          !Object.hasOwn(state?.stopRisk ?? {}, "plannedTopUpMargin") ||
          !(typeof state.plannedTopUpMargin === "string" ||
            typeof state.plannedTopUpMargin === "number") ||
          !(typeof state.stopRisk.plannedTopUpMargin === "string" ||
            typeof state.stopRisk.plannedTopUpMargin === "number")) {
        throw new BingXLiveApiError(`VST ${context} preflight has no consistent top-up amount`);
      }
      const planned = strictNumeric(String(state.plannedTopUpMargin), `${context} planned VST top-up`);
      const riskPlanned = strictNumeric(
        String(state.stopRisk.plannedTopUpMargin), `${context} risk planned VST top-up`,
      );
      if (planned !== riskPlanned) {
        throw new BingXLiveApiError(`VST ${context} preflight has no consistent top-up amount`);
      }
      return planned;
    };
    const safeReadiness = (state) => state?.status === "ready" &&
      state.positionMode === "HEDGE" &&
      state.checks?.marginTypeIsolated === true &&
      state.checks?.leverageLong10 === true &&
      state.checks?.leverageShortIndependentlyVerified === true &&
      state.checks?.positionModeSupported === true &&
      state.checks?.symbolFlat === true &&
      state.checks?.symbolOpenOrdersEmpty === true &&
      state.checks?.stopSafe === true &&
      state.stopRisk?.safe === true &&
      Number(state.stopRisk.plannedTopUpMargin) === Number(state.plannedTopUpMargin);
    // Run the complete native protection preflight once, immediately before
    // signing below. Do not cache a positive verdict across changing account
    // state or run the same expensive probe twice within one entry attempt.
    decimalAtPrecision(stopLoss, filters.pricePrecision, "Stop loss");
    const params = {
      symbol: name,
      side: "BUY",
      positionSide: "LONG",
      type: "MARKET",
      quantity: sizedQuantity,
      stopLoss: `{"type":"STOP_MARKET","stopPrice":${stopLoss}}`,
      clientOrderId,
    };
    // Reserve the identifier before transport. Any ambiguous POST stays unknown;
    // callers must reconcile rather than retry.
    submittedClientOrderIds.add(clientOrderId);
    let finalQuoteTimestamp;
    let refreshedSizing;
    let refreshedFilters;
    const result = await request("POST", PATH.order, params, {
      exposeVstPreSignReason: true,
      beforeSign: async () => {
        let latestBalanceData, latestMode;
        try {
          [latestBalanceData, latestMode] = await Promise.all([
            getBalance(), getPositionMode(),
          ]);
        } catch {
          throw new BingXLiveApiError("VST final balance or HEDGE mode unavailable", {
            preSignReason: "final_balance_unavailable",
          });
        }
        const latestRows = flattenBalance(latestBalanceData)
          .filter((row) => row?.asset === "VST");
        if (latestRows.length !== 1 || latestMode !== "HEDGE") {
          throw new BingXLiveApiError("VST final balance or HEDGE mode is unavailable", {
            preSignReason: "final_balance_invalid",
          });
        }
        let latestBudget = allocationBudget(
          PROFILE, strictNumeric(latestRows[0].balance, "final total VST balance"),
        );
        if (!Number.isFinite(latestBudget) || latestBudget <= 0) {
          throw new BingXLiveApiError("VST final one-percent initial-margin budget was exceeded", {
            preSignReason: "final_budget_exceeded",
          });
        }
        let finalReadiness;
        try {
          // The accepted market-entry ask is bounded by maxPrice. Assess risk
          // at that conservative upper bound before making the final quote
          // read, so the quote remains fresh through the paced POST start.
          finalReadiness = await preflight(symbol, {
            requiredMargin: latestBudget,
            quantity: sizedQuantity,
            entryPrice: price,
            stopLoss,
            automatedLongPolicy: policy,
            ...(refreshSizing !== null ? {
              refreshEntryPricing: async (snapshot) => {
                // All slow native reads are behind us. Price and size the
                // actual request together, then assess its risk on those same
                // independently read contract/account inputs.
                const quote = await getFreshVstAsk(symbol);
                refreshedSizing = refreshVstEntrySizing({
                  ...snapshot, symbol: name.replace("-", ""), stopLoss,
                  policy: refreshSizing, quote, nowMs: Number(clock()),
                  positionProfile: PROFILE,
                });
                refreshedFilters = snapshot.filters;
                return refreshedSizing;
              },
            } : {}),
          });
          plannedTopUp(finalReadiness, "final");
        } catch {
          throw new BingXLiveApiError("VST final LONG preflight unavailable", {
            preSignReason: "final_preflight_unavailable",
          });
        }
        if (!safeReadiness(finalReadiness)) {
          throw new BingXLiveApiError("VST final LONG protection preflight is blocked", {
            preSignReason: "final_preflight_blocked",
          });
        }
        if (refreshedSizing) {
          price = refreshedSizing.maxEntryPrice;
          sizedQuantity = refreshedSizing.quantity;
          qty = positive(sizedQuantity, "fresh quantity");
          latestBudget = refreshedSizing.initialBudgetVst;
          params.quantity = sizedQuantity;
          try {
            await onReprice({
              sizing: refreshedSizing, filters: refreshedFilters,
              finalQuote: {
                ask: refreshedSizing.quotePrice,
                timestamp: refreshedSizing.quoteObservedAtMs,
              },
              checkedAtMs: Number(clock()),
            });
          } catch {
            throw new BingXLiveApiError("VST fresh entry intent could not be persisted", {
              preSignReason: "final_sizing_persistence_failed",
            });
          }
        }
        let quote;
        finalPriceStartedAtMs = Number(clock());
        try {
          quote = await getFreshVstAsk(symbol);
        } catch (error) {
          const quoteError = new BingXLiveApiError("VST final ask unavailable", {
            preSignReason: "final_quote_unavailable_or_stale",
          });
          if (error instanceof BingXLiveApiError) {
            quoteError.code = error.code;
            quoteError.exchangeMessage = error.exchangeMessage;
          }
          throw quoteError;
        }
        finalPriceCompletedAtMs = Number(clock());
        finalQuoteTimestamp = quote.timestamp;
        if (quote.ask > Number(price)) {
          throw new BingXLiveApiError("VST final ask exceeds the maximum entry price", {
            preSignReason: "final_quote_out_of_bounds",
          });
        }
        if (qty * quote.ask / PROFILE_LEVERAGE > latestBudget) {
          throw new BingXLiveApiError("VST final one-percent initial-margin budget was exceeded", {
            preSignReason: "final_budget_exceeded",
          });
        }
        checksCompletedAtMs = Number(clock());
      },
      beforeTransport: async () => {
        const signalTime = Date.parse(signalAt);
        const now = Number(clock());
        if (!Number.isFinite(signalTime) || !Number.isFinite(now) ||
            now - signalTime > VST_SIGNAL_MAX_AGE_MS ||
            now - signalTime < -VST_SIGNAL_FUTURE_TOLERANCE_MS) {
          freshnessExpired = now - signalTime > VST_SIGNAL_MAX_AGE_MS;
          const error = new BingXLiveApiError("VST entry signal expired before submission", {
            preSignReason: "signal_expired",
          });
          throw error;
        }
        const quoteAge = now - Number(finalQuoteTimestamp);
        if (!Number.isFinite(quoteAge) || quoteAge < -2_000 || quoteAge > 10_000) {
          freshnessExpired = quoteAge > 10_000;
          throw new BingXLiveApiError("VST final ask became stale while waiting for request pacing", {
            preSignReason: "final_quote_unavailable_or_stale",
          });
        }
        if (refreshedSizing) {
          const sizingAgeAtSubmitMs = now - refreshedSizing.calculatedAtMs;
          if (!Number.isFinite(sizingAgeAtSubmitMs) || sizingAgeAtSubmitMs < 0 ||
              sizingAgeAtSubmitMs > refreshSizing.maxQuoteAgeMs) {
            freshnessExpired = sizingAgeAtSubmitMs > refreshSizing.maxQuoteAgeMs;
            throw new BingXLiveApiError("VST sizing became stale before submission", {
              preSignReason: "final_quote_unavailable_or_stale",
            });
          }
          if (now - refreshedSizing.quoteObservedAtMs > refreshSizing.maxQuoteAgeMs) {
            freshnessExpired = true;
            throw new BingXLiveApiError("VST sizing source quote became stale before submission", {
              preSignReason: "final_quote_unavailable_or_stale",
            });
          }
        }
      },
      onTransportStart: () => {
        const transportStartedAtMs = Number(clock());
        emitEntryTiming({
          boundary: "transport_started", transportStartedAtMs,
          finalPriceStartedAtMs, finalPriceCompletedAtMs, checksCompletedAtMs,
        });
        if (!refreshedSizing || typeof onTransportReady !== "function") return;
        const at = Number(clock());
        // Observability must not add another DB round trip between the
        // freshness guard and fetch. Record the actual transport boundary.
        Promise.resolve(onTransportReady({
          sizingAgeAtSubmitMs: at - refreshedSizing.calculatedAtMs,
          sizingQuoteAgeAtSubmitMs: at - refreshedSizing.quoteObservedAtMs,
          quoteAgeAtSubmitMs: at - Number(finalQuoteTimestamp),
          calculatedAtMs: refreshedSizing.calculatedAtMs, transportStartedAtMs: at,
        })).catch((error) => {
          recordVstDiagnostic(error, { stage: "entry_transport_telemetry", symbol: name });
        });
      },
    }).catch((error) => {
      if (error?.transportStage === "pre_transport") {
        emitEntryTiming({
          boundary: "refused_before_transport", refusedAtMs: Number(clock()),
          finalPriceStartedAtMs, finalPriceCompletedAtMs, checksCompletedAtMs,
          freshnessExpired: freshnessExpired ||
            error?.preSignReason === "final_pre_sign_pacing_expired",
          preSignReason: ALLOWED_VST_PRE_SIGN_REASONS.has(error?.preSignReason)
            ? error.preSignReason : null,
        });
      }
      throw error;
    });
    // VST MARKET acknowledgements can use data.order.orderId. Decode every
    // supplied alias losslessly and reject contradictions; this is only an
    // acknowledgement, not a fill or protective-stop proof.
    const exchangeOrderId = exactOrderIdentifierFrom(result, "submitted order ID");
    return { ...result, orderId: exchangeOrderId };
  }

  async function getVstOpenPositionMark(symbol) {
    return getVstMarkPrice(symbol, { openPosition: true });
  }

  async function getVstMarkPrice(symbol, { openPosition = false } = {}) {
    const name = symbolName(symbol);
    if (environment !== "vst") {
      throw new BingXLiveApiError("VST mark-price reads are unavailable outside VST");
    }
    let firstUncorroboratedRead;
    const pairEvidence = [];
    for (let attempt = 0; attempt <= MAX_UNCORROBORATED_MARK_PAIR_RETRIES; attempt += 1) {
      try {
        return await readVstMarkPricePair(symbol, attempt, openPosition);
      } catch (error) {
        if (error?.vstMarkPairEvidence) {
          pairEvidence.push(error.vstMarkPairEvidence);
        }
        const retryReason = error?.vstMarkPairRetryReason;
        if (typeof retryReason !== "string") {
          if (firstUncorroboratedRead) {
            attachFirstMarkReadDiagnostic(
              firstUncorroboratedRead, error, name, pairEvidence,
            );
          }
          throw error;
        }
        if (!firstUncorroboratedRead) firstUncorroboratedRead = { error, retryReason };
        if (attempt === MAX_UNCORROBORATED_MARK_PAIR_RETRIES) {
          attachFirstMarkReadDiagnostic(
            firstUncorroboratedRead, error, name, pairEvidence,
          );
          throw error;
        }
        // Retry only the complete readonly funding/ticker pair after a
        // freshness or corroboration refusal. No market mark is accepted from
        // a local clock fallback or from the failed pair.
        scheduleTransientVstGetRetry(PATH.funding, "mark_uncorroborated");
      }
    }
    throw new BingXLiveApiError("VST mark-price read failed");
  }

  function attachFirstMarkReadDiagnostic(firstFailure, finalError, symbol, pairEvidence) {
    const diagnostic = recordVstDiagnostic(firstFailure.error, {
      stage: "broker_read",
      operation: "read_market_mark",
      check: "market_mark",
      symbol,
    });
    if (finalError && typeof finalError === "object") {
      finalError.firstMarkReadFailure = Object.freeze({
        reason: firstFailure.retryReason === "mark_outside_fresh_quote"
          ? "market_mark_unverified" : "ticker_timestamp_unavailable",
        retryReason: firstFailure.retryReason,
        ref: diagnostic.ref,
      });
      if (pairEvidence.length > 0) {
        finalError.vstMarkEvidence = Object.freeze(pairEvidence.slice(0, 2));
      }
    }
  }

  async function readVstMarkPricePair(symbol, attempt, openPosition = false) {
    const name = symbolName(symbol);
    let fundingRequestStartedAt;
    // Start both public reads together so the shared pacer reserves adjacent
    // slots instead of allowing unrelated callers to split this market read.
    // Convert rejections to values immediately: an authoritative funding mark
    // does not depend on the ticker, but its rejected promise must be handled.
    const fundingOutcomePromise = request(
      "GET", PATH.funding, { symbol: name }, {
        onTransportStart: () => { fundingRequestStartedAt = Number(clock()); },
      },
    ).then(
      (data) => ({ data }),
      (error) => ({ error }),
    );
    // An open position needs valuation evidence, not a rolling 24h ticker.
    // Reserve the whole native proof before broker metadata/account reads
    // can enter the shared queue. Reserving only the secondary pair is late.
    let positionOutcomePromise = openPosition ? readVstPositionMarkRows(name) : undefined;
    const quoteOutcomePromise = (openPosition
      ? readFreshVstQuote(symbol, VST_BOOK_TICKER_PATH)
      : getFreshVstAsk(symbol)).then(
      (quote) => ({ quote }),
      (error) => ({ error }),
    );
    const fundingOutcome = await fundingOutcomePromise;
    const fundingReceivedAt = Number(clock());
    if (fundingOutcome.error) throw fundingOutcome.error;
    const data = fundingOutcome.data;
    const parsed = parseVstMarkPrice(data, name, fundingReceivedAt);
    const { markPrice, timestamp } = parsed;
    if (timestamp !== null) {
      const comparisonAt = Number(clock());
      const endAge = comparisonAt - timestamp;
      const fundingReadAge = comparisonAt - fundingRequestStartedAt;
      if (!Number.isFinite(endAge) || endAge < -2_000 || endAge > 10_000 ||
          !Number.isFinite(fundingReadAge) || fundingReadAge < 0 ||
          fundingReadAge > 10_000) {
        // The exchange time was fresh when its response arrived but aged out
        // before this pair could be accepted. Treat it like any other
        // uncorroborated pair rather than refreshing it with local receipt time.
        const retryable = new BingXLiveApiError("VST mark became stale before use");
        retryable.vstMarkPairRetryReason = "ticker_timestamp_unavailable";
        retryable.vstMarkPairEvidence = Object.freeze({
          attempt,
          predicate: "funding_timestamp_stale_at_pair_end",
          markPrice,
          exchangeMarkTimestamp: timestamp,
          exchangeTimestampStatus: parsed.timestampStatus,
          fundingResponseReceivedAt: fundingReceivedAt,
          fundingRequestStartedAt,
          fundingTimestampAgeAtPairEndMs: endAge,
          fundingReadAgeAtPairEndMs: fundingReadAge,
        });
        throw retryable;
      }
      return {
        symbol: name,
        markPrice,
        timestamp,
        timestampSource: parsed.timestampSource,
        markPriceSource: "premium_index",
      };
    }
    // VST may provide a missing, stale, or future funding timestamp. Those
    // values are not mark-tick evidence: only a fresh, matching ticker book
    // can corroborate the returned mark in that case.
    // Keep the received-at time separate from an exchange mark timestamp.
    // It is useful for bounded age checks downstream, but must not be
    // represented as though BingX supplied a mark update time.
    const rawTimestamp = parsed.rawTimestamp;
    // updateTime is the funding schedule update, not a mark tick. Corroborate
    // the received mark against an independently timestamped fresh ticker
    // instead of trusting an unusable funding timestamp as proof of freshness.
    //
    // The mark price is an index-derived value, not the local top-of-book, so
    // it legitimately sits anywhere inside the symbol's own current bid/ask
    // spread rather than pinned to the ask. A fixed 0.5%-from-ask band was
    // production's single most frequent VST rejection reason: live VST quotes
    // pulled on 2026-09-28 for the affected symbols (ARBUSDT -1.71%, QUSDT
    // -1.04%, COTIUSDT -0.68%, USELESSUSDT -0.62%, JASMYUSDT -0.56% mark-vs-ask)
    // showed the mark sitting inside a 1-3% bid/ask spread under ordinary
    // conditions, not during a price dislocation -- these low-liquidity VST
    // symbols simply carry a wider book than the fixed threshold assumed, so
    // every one of them was rejected outright regardless of market health.
    // Agreement with the book is sufficient corroboration, not necessary:
    // mark price is a valuation price and can legitimately be outside the
    // execution book. On disagreement, seek independent native mark evidence
    // rather than widening this buffer or substituting an execution price.
    const quoteOutcome = await quoteOutcomePromise;
    if (quoteOutcome.error) {
      const nativeMark = await corroborateVstPositionMark({
        name, markPrice, markPriceDecimal: parsed.markPriceDecimal,
        fundingReceivedAt, fundingRequestStartedAt,
        positionOutcomePromise,
      });
      if (nativeMark.proof) return nativeMark.proof;
      const error = quoteOutcome.error;
      error.vstMarkPairEvidence = Object.freeze({
        attempt,
        predicate: error.vstTickerEvidence?.predicate ?? "ticker_timestamp_unavailable",
        markPrice,
        exchangeMarkTimestamp: Number.isFinite(parsed.timestampMs)
          ? parsed.timestampMs : null,
        exchangeTimestampStatus: parsed.timestampStatus,
        fundingResponseReceivedAt: fundingReceivedAt,
        fundingRequestStartedAt,
        ...(error.vstTickerEvidence ?? {}),
        ...nativeMark.evidence,
      });
      // Non-retryable quote failures still retain the native valuation
      // corroboration outcome; no raw account response is attached.
      error.vstMarkEvidence = Object.freeze([error.vstMarkPairEvidence]);
      if (error?.message === "VST final quote is stale or invalid") {
        error.vstMarkPairRetryReason = "ticker_timestamp_unavailable";
      }
      throw error;
    }
    const quote = quoteOutcome.quote;
    const comparisonAt = Number(clock());
    const fundingEndAge = comparisonAt - fundingReceivedAt;
    const tickerEndAge = comparisonAt - quote.timestamp;
    const fundingReadAge = comparisonAt - fundingRequestStartedAt;
    const tickerReadAge = comparisonAt - quote.requestStartedAt;
    const readStartSeparation = Math.abs(
      fundingRequestStartedAt - quote.requestStartedAt,
    );
    if (![fundingEndAge, tickerEndAge, fundingReadAge, tickerReadAge,
      readStartSeparation].every(Number.isFinite) ||
        fundingEndAge < 0 || fundingEndAge > 10_000 ||
        tickerEndAge < -2_000 || tickerEndAge > 10_000 ||
        fundingReadAge < 0 || fundingReadAge > 10_000 ||
        tickerReadAge < 0 || tickerReadAge > 10_000 ||
        readStartSeparation > 10_000) {
      const retryable = new BingXLiveApiError(
        "VST mark or ticker became stale while reading the corroboration pair",
      );
      retryable.vstMarkPairRetryReason = "ticker_timestamp_unavailable";
      retryable.vstMarkPairEvidence = Object.freeze({
        attempt,
        predicate: "funding_to_ticker_window_exceeded",
        markPrice,
        exchangeMarkTimestamp: Number.isFinite(parsed.timestampMs)
          ? parsed.timestampMs : null,
        exchangeTimestampStatus: parsed.timestampStatus,
        fundingResponseReceivedAt: fundingReceivedAt,
        fundingRequestStartedAt,
        fundingToTickerReadAgeMs: Math.abs(
          quote.receivedAt - fundingReceivedAt,
        ),
        tickerObservedAt: quote.timestamp,
        tickerResponseReceivedAt: quote.receivedAt,
        tickerRequestStartedAt: quote.requestStartedAt,
        fundingAgeAtPairEndMs: fundingEndAge,
        tickerAgeAtPairEndMs: tickerEndAge,
        fundingReadAgeAtPairEndMs: fundingReadAge,
        tickerReadAgeAtPairEndMs: tickerReadAge,
        readStartSeparationMs: readStartSeparation,
        bid: quote.bid,
        ask: quote.ask,
      });
      throw retryable;
    }
    let corroboratingQuote = quote;
    let corroboratingSource = openPosition ? "book_ticker_bid_ask" : "ticker_bid_ask";
    const tickerBuffer = quote.ask * 0.001;
    if (!openPosition &&
        (markPrice < quote.bid - tickerBuffer || markPrice > quote.ask + tickerBuffer)) {
      // The 24-hour ticker can have a current closeTime but unchanged bid/ask
      // while the VST market moves. Check the dedicated native book endpoint,
      // not a wider price tolerance or a local timestamp substitute.
      // Reserve both secondary reads together. Awaiting the book before
      // enqueueing the signed position lets unrelated traffic split the proof
      // and consume its unchanged ten-second acquisition budget.
      const bookOutcomePromise = readFreshVstQuote(symbol, VST_BOOK_TICKER_PATH)
        .then((value) => ({ value }), (error) => ({ error }));
      positionOutcomePromise = readVstPositionMarkRows(name);
      try {
        const bookOutcome = await bookOutcomePromise;
        if (bookOutcome.error) throw bookOutcome.error;
        const book = bookOutcome.value;
        const end = Number(clock());
        const bookAge = end - book.timestamp;
        const markAge = end - fundingReceivedAt;
        const markReadAge = end - fundingRequestStartedAt;
        const bookReadAge = end - book.requestStartedAt;
        const separation = Math.abs(book.requestStartedAt - fundingRequestStartedAt);
        if ([bookAge, markAge, markReadAge, bookReadAge, separation].every(Number.isFinite) &&
            bookAge >= -2_000 && bookAge <= 10_000 &&
            markAge >= 0 && markAge <= 10_000 &&
            markReadAge >= 0 && markReadAge <= 10_000 &&
            bookReadAge >= 0 && bookReadAge <= 10_000 && separation <= 10_000) {
          corroboratingQuote = book;
          corroboratingSource = "book_ticker_bid_ask";
        }
      } catch {
        // An unavailable secondary read cannot certify anything. Preserve the
        // original fail-closed refusal and its bounded complete-pair retry.
      }
    }
    const bookBuffer = corroboratingQuote.ask * 0.001;
    if (markPrice >= corroboratingQuote.bid - bookBuffer &&
        markPrice <= corroboratingQuote.ask + bookBuffer &&
        corroboratingSource === "book_ticker_bid_ask") {
      return {
        symbol: name, markPrice, timestamp: fundingReceivedAt,
        timestampSource: "local_response_received",
        markPriceSource: "premium_index",
        markCorroboration: Object.freeze({
          source: corroboratingSource,
          observedAt: corroboratingQuote.timestamp,
          bid: corroboratingQuote.bid,
          ask: corroboratingQuote.ask,
          exchangeTimestamp: Number.isFinite(rawTimestamp) ? rawTimestamp : null,
        }),
        corroboratedByTickerAt: corroboratingQuote.timestamp,
      };
    }
    const buffer = quote.ask * 0.001;
    if (markPrice < quote.bid - buffer || markPrice > quote.ask + buffer) {
      const nativeMark = await corroborateVstPositionMark({
        name, markPrice, markPriceDecimal: parsed.markPriceDecimal,
        fundingReceivedAt, fundingRequestStartedAt,
        quote: corroboratingQuote, quoteSource: corroboratingSource,
        positionOutcomePromise,
      });
      if (nativeMark.proof) return nativeMark.proof;
      const lowerBound = quote.bid - buffer;
      const upperBound = quote.ask + buffer;
      const retryable = new BingXLiveApiError(
        "VST mark is not corroborated by a fresh quote",
      );
      retryable.vstMarkPairRetryReason = "mark_outside_fresh_quote";
      retryable.vstMarkPairEvidence = Object.freeze({
        attempt,
        predicate: markPrice < lowerBound
          ? "mark_below_bid_buffer" : "mark_above_ask_buffer",
        markPrice,
        exchangeMarkTimestamp: Number.isFinite(parsed.timestampMs)
          ? parsed.timestampMs : null,
        exchangeTimestampStatus: parsed.timestampStatus,
        fundingResponseReceivedAt: fundingReceivedAt,
        fundingRequestStartedAt,
        tickerObservedAt: quote.timestamp,
        tickerAgeAtComparisonMs: tickerEndAge,
        tickerRequestStartedAt: quote.requestStartedAt,
        tickerResponseReceivedAt: quote.receivedAt,
        fundingToTickerReadAgeMs: Math.abs(
          quote.receivedAt - fundingReceivedAt,
        ),
        bid: quote.bid,
        ask: quote.ask,
        buffer,
        lowerBound,
        upperBound,
        ...nativeMark.evidence,
      });
      throw retryable;
    }
    return {
      symbol: name, markPrice, timestamp: fundingReceivedAt,
      timestampSource: "local_response_received",
      markPriceSource: "premium_index",
      markCorroboration: Object.freeze({
        source: "ticker_bid_ask",
        observedAt: quote.timestamp,
        bid: quote.bid,
        ask: quote.ask,
        exchangeTimestamp: Number.isFinite(rawTimestamp) ? rawTimestamp : null,
      }),
      corroboratedByTickerAt: quote.timestamp,
    };
  }

  async function readVstPositionMarkRows(name) {
    let requestStartedAt;
    try {
      const rows = await request("GET", PATH.positions, { symbol: name }, {
        onTransportStart: () => { requestStartedAt = Number(clock()); },
      });
      return { rows, requestStartedAt, receivedAt: Number(clock()) };
    } catch (error) {
      // Eager secondary reads may not be needed if the book proves the mark.
      // Settle failures as values, never as unhandled rejected promises.
      return { error, requestStartedAt, receivedAt: Number(clock()) };
    }
  }

  async function corroborateVstPositionMark({
    name, markPrice, markPriceDecimal, fundingReceivedAt, fundingRequestStartedAt,
    quote, quoteSource, positionOutcomePromise,
  }) {
    // The signed position endpoint independently reports the mark used to
    // value an OPEN VST position. Never use its updateTime as a mark tick:
    // that field tracks position changes, not ongoing valuation updates.
    // These are bounded live reads, NOT cached position snapshots or a
    // fabricated exchange timestamp. Either exact agreement of both MARK
    // fields, or agreement of the position's explicit markPrice with a fresh
    // execution book, is required. Never substitute bid/ask/indexPrice.
    const evidence = { positionMarkReadStatus: "unavailable" };
    let requestStartedAt;
    try {
      const outcome = await (positionOutcomePromise ?? readVstPositionMarkRows(name));
      requestStartedAt = outcome.requestStartedAt;
      if (outcome.error) throw outcome.error;
      const { rows, receivedAt } = outcome;
      const comparisonAt = Number(clock());
      evidence.positionMarkRequestStartedAt = requestStartedAt;
      evidence.positionMarkResponseReceivedAt = receivedAt;
      const ages = [comparisonAt - fundingRequestStartedAt,
        comparisonAt - fundingReceivedAt, comparisonAt - requestStartedAt,
        comparisonAt - receivedAt];
      if (!ages.every((age) => Number.isFinite(age) && age >= 0 && age <= 10_000)) {
        evidence.positionMarkReadStatus = "expired";
        return { evidence };
      }
      if (!Array.isArray(rows)) {
        evidence.positionMarkReadStatus = "invalid";
        return { evidence };
      }
      const candidates = rows.filter((row) => row?.symbol === name &&
        strictNumeric(row.positionAmt, "position amount", { allowNegative: true }) !== 0);
      if (candidates.length !== 1) {
        evidence.positionMarkReadStatus = "invalid";
        return { evidence };
      }
      const row = candidates[0];
      const id = orderIdentifier(row.positionId ?? row.positionID, "position ID");
      const quantity = strictNumeric(row.positionAmt, "position amount");
      // Native VST positions report the margin asset VST, although their
      // contracts are USDT quoted. Some response versions report USDT.
      if (id === "0" || !["VST", "USDT"].includes(row.currency) ||
          row.positionSide !== "LONG" || quantity <= 0) {
        evidence.positionMarkReadStatus = "invalid";
        return { evidence };
      }
      const positionMarkPrice = strictNumeric(row.markPrice, "position mark price");
      evidence.positionMarkPrice = positionMarkPrice;
      const sameMark = positionMarkPrice > 0 &&
        sameDecimal(markPriceDecimal, String(row.markPrice));
      const quoteAges = quote
        ? [comparisonAt - quote.timestamp, comparisonAt - quote.requestStartedAt]
        : [];
      const positionMarkMatchesBook = positionMarkPrice > 0 && quote &&
        quoteSource === "book_ticker_bid_ask" &&
        quoteAges.every((age) => Number.isFinite(age)) &&
        quoteAges[0] >= -2_000 && quoteAges[0] <= 10_000 &&
        quoteAges[1] >= 0 && quoteAges[1] <= 10_000 &&
        positionMarkPrice >= quote.bid - quote.ask * 0.001 &&
        positionMarkPrice <= quote.ask + quote.ask * 0.001;
      if (!sameMark && !positionMarkMatchesBook) {
        evidence.positionMarkReadStatus = "mismatch";
        return { evidence };
      }
      evidence.positionMarkReadStatus = sameMark ? "matched" : "matched_book";
      return {
        evidence,
        proof: {
          symbol: name,
          markPrice: sameMark ? markPrice : positionMarkPrice,
          timestamp: sameMark ? fundingReceivedAt : receivedAt,
          timestampSource: "local_response_received",
          markPriceSource: sameMark ? "premium_index" : "open_position",
          markCorroboration: Object.freeze({
            source: sameMark ? "signed_open_position_mark" : "signed_position_mark_with_book",
            observedAt: receivedAt,
            requestStartedAt,
            positionMarkPrice,
            premiumIndexMarkPrice: markPrice,
            ...(!sameMark ? {
              quoteSource, quoteObservedAt: quote.timestamp,
              bid: quote.bid, ask: quote.ask,
            } : {}),
            // Both endpoints omit a mark update time; do not silently label
            // a local receipt or the position updateTime as exchange time.
            exchangeTimestamp: null,
          }),
        },
      };
    } catch (error) {
      if (error instanceof BingXLiveApiError && Number.isFinite(error.code)) {
        evidence.positionMarkErrorCode = error.code;
      } else if (requestStartedAt !== undefined) {
        evidence.positionMarkReadStatus = "invalid";
      }
      return { evidence };
    }
  }

  function parseVstMarkPrice(data, expectedSymbol, receivedAt) {
    const row = Array.isArray(data)
      ? data.find((item) => item?.symbol === expectedSymbol)
      : data;
    if (row?.symbol !== expectedSymbol) {
      throw new BingXLiveApiError("BingX returned a mismatched VST mark-price symbol");
    }
    // Deliberately read only BingX's explicit markPrice field. Funding rates,
    // index prices, and ticker prices are not substitutes for a market mark.
    const markPrice = strictNumeric(row.markPrice, "VST mark price");
    if (markPrice <= 0) {
      throw new BingXLiveApiError("BingX returned invalid VST mark price");
    }
    const timestampValue = row.time ?? row.timestamp ?? data?.time;
    const rawTimestamp = timestampValue === undefined || timestampValue === null ||
      timestampValue === "" ? NaN : Number(timestampValue);
    const timestamp = rawTimestamp > 0 && rawTimestamp < 100_000_000_000
      ? rawTimestamp * 1000 : rawTimestamp;
    const age = Number(receivedAt) - timestamp;
    if (Number.isSafeInteger(timestamp) && timestamp > 0 &&
        Number.isFinite(age) && age >= -2_000 && age <= 10_000) {
      return {
        markPrice,
        markPriceDecimal: String(row.markPrice),
        timestamp,
        timestampSource: "exchange_mark_time",
        rawTimestamp,
        timestampMs: timestamp,
        timestampStatus: "fresh",
      };
    }
    return {
      markPrice,
      markPriceDecimal: String(row.markPrice),
      timestamp: null,
      rawTimestamp,
      timestampMs: Number.isFinite(timestamp) ? timestamp : null,
      timestampStatus: timestampValue === undefined || timestampValue === null ||
        timestampValue === ""
        ? "missing"
        : !Number.isSafeInteger(timestamp) || timestamp <= 0
          ? "invalid"
          : age < -2_000 ? "future" : "stale",
    };
  }

  async function getFreshVstAsk(symbol) {
    return readFreshVstQuote(symbol, VST_TICKER_PATH);
  }

  // One public, read-only request for the last traded price of every VST
  // contract. Used only to observe the fixed +5% take between management
  // ticks; it never authorizes a write by itself. Rows without a fresh
  // exchange timestamp are dropped, never back-filled with the local clock.
  // Independent of the signed trading pacer. A timer racing another reader
  // waits/joins the in-flight read instead of reporting a fake transport fault.
  const readLastPriceRows = createCoalescedPriceRead({
    clock, sleep, minGapMs: LAST_PRICE_MIN_GAP_MS,
    read: async () => {
    let response;
    try {
      response = await fetchImpl(`${origin}${VST_TICKER_PATH}`,
        { method: "GET", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new BingXLiveApiError("VST last-price read failed", { transportStage: "pre_transport" });
    }
    let payload;
    try { payload = parseResponseJson(await response.text()); } catch {
      throw new BingXLiveApiError("VST last-price response is invalid", { transportStage: "pre_transport" });
    }
    if (!response.ok || response.redirected === true || Number(payload?.code) !== 0 ||
        !Array.isArray(payload?.data)) {
      throw new BingXLiveApiError("VST last-price read failed", {
        httpStatus: response?.status, code: payload?.code, transportStage: "exchange_response",
      });
    }
    return payload.data;
    },
  });
  async function getVstLastPrices(symbols) {
    if (environment !== "vst") {
      throw new BingXLiveApiError("VST last-price reads are unavailable outside VST");
    }
    const wanted = new Set((Array.isArray(symbols) ? symbols : []).map(symbolName));
    if (wanted.size === 0) return [];
    const rows = await readLastPriceRows();
    const receivedAt = Number(clock());
    const result = [];
    for (const row of rows) {
      if (!wanted.has(row?.symbol)) continue;
      let price;
      try { price = strictNumeric(row.lastPrice, "VST last price"); } catch { continue; }
      if (!(price > 0)) continue;
      const rawTime = Number(row.time ?? row.timestamp ?? row.closeTime);
      const timestamp = rawTime > 0 && rawTime < 100_000_000_000 ? rawTime * 1000 : rawTime;
      const age = receivedAt - timestamp;
      if (!Number.isSafeInteger(timestamp) || !Number.isFinite(age) ||
          age < -2_000 || age > 10_000) continue;
      result.push({ symbol: row.symbol, lastPrice: String(row.lastPrice),
        timestamp: Math.min(timestamp, receivedAt) });
    }
    return result;
  }

  async function readFreshVstQuote(symbol, quotePath) {
    const name = symbolName(symbol);
    if (environment !== "vst") {
      throw new BingXLiveApiError("VST quote reads are unavailable outside VST");
    }
    let payload;
    let response;
    let requestStartedAt;
    let responseReceivedAt;
    // The secondary book is one bounded extra read, not another retry loop
    // ahead of time-sensitive management. The outer mark pair owns retries.
    const maxAttempts = quotePath === VST_BOOK_TICKER_PATH ? 1 : MAX_RETRYABLE_GET_ATTEMPTS;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await outboundPacer.waitForSlot();
      requestStartedAt = Number(clock());
      try {
        response = await fetchImpl(
          `${origin}${quotePath}?symbol=${encodeURIComponent(name)}`,
          { method: "GET", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) },
        );
      } catch {
        if (attempt + 1 < maxAttempts) {
          scheduleTransientVstGetRetry(quotePath, "network_request");
          continue;
        }
        throw new BingXLiveApiError("VST final quote read failed", {
          transportStage: "pre_transport",
        });
      }
      let responseText;
      try {
        responseText = await response.text();
      } catch {
        if (attempt + 1 < maxAttempts) {
          scheduleTransientVstGetRetry(quotePath, "network_response_read");
          continue;
        }
        throw new BingXLiveApiError("VST final quote response is invalid", {
          transportStage: "pre_transport",
        });
      }
      try { payload = parseResponseJson(responseText); } catch {
        throw new BingXLiveApiError("VST final quote response is invalid", {
          transportStage: "pre_transport",
        });
      }
      if (Number(payload?.code) === RETRYABLE_GET_ERROR_CODE) {
        scheduleRateLimitDelay(
          quotePath, "GET", attempt, maxAttempts,
        );
        if (attempt + 1 < maxAttempts) continue;
      }
      if (Number(payload?.code) === RETRYABLE_VST_BUSY_ERROR_CODE &&
          attempt + 1 < maxAttempts) {
        scheduleTransientVstGetRetry(
          quotePath, "exchange_busy", RETRYABLE_VST_BUSY_ERROR_CODE,
        );
        continue;
      }
      break;
    }
    if (Number(payload?.code) !== 0) {
      const exchangeMessage = typeof payload?.msg === "string" && payload.msg.trim() !== ""
        ? payload.msg.trim().slice(0, 500) : undefined;
      throw new BingXLiveApiError(
        `VST final quote request failed (code ${String(payload?.code ?? "unknown")}${
          exchangeMessage ? `, msg: ${exchangeMessage}` : ""
        })`,
        {
          httpStatus: response?.status,
          code: payload?.code,
          ...(exchangeMessage ? { exchangeMessage } : {}),
          transportStage: "exchange_response",
        },
      );
    }
    if (!response.ok || response.redirected === true) {
      throw new BingXLiveApiError("VST final quote read failed", {
        httpStatus: response.status,
        transportStage: "pre_transport",
      });
    }
    const rows = quotePath === VST_BOOK_TICKER_PATH
      ? payload?.data?.book_ticker ?? payload?.data : payload?.data;
    const row = Array.isArray(rows)
      ? rows.find((item) => item?.symbol === name) : rows;
    if (row?.symbol !== name) {
      throw new BingXLiveApiError("VST quote symbol does not match the requested contract", {
        transportStage: "pre_transport",
      });
    }
    const ask = strictNumeric(row?.askPrice ?? row?.ask_price, "VST ask price");
    const bid = strictNumeric(row?.bidPrice ?? row?.bid_price, "VST bid price");
    const rawTime = Number(row?.time ?? row?.timestamp ?? row?.closeTime ?? payload?.time);
    const timestamp = rawTime > 0 && rawTime < 100_000_000_000 ? rawTime * 1000 : rawTime;
    responseReceivedAt = Number(clock());
    const age = responseReceivedAt - timestamp;
    if (!Number.isSafeInteger(timestamp) ||
        !Number.isFinite(age) || age < -2_000 || age > 10_000 || bid > ask) {
      const error = new BingXLiveApiError("VST final quote is stale or invalid", {
        transportStage: "pre_transport",
      });
      error.vstTickerEvidence = Object.freeze({
        predicate: !Number.isSafeInteger(timestamp) || timestamp <= 0 ||
          !Number.isFinite(age)
          ? "ticker_timestamp_invalid"
          : age < -2_000 ? "ticker_timestamp_future"
            : age > 10_000 ? "ticker_timestamp_stale" : "ticker_bid_above_ask",
        bid,
        ask,
        tickerObservedAt: Number.isFinite(timestamp) ? timestamp : null,
        tickerAgeAtReadMs: Number.isFinite(age) ? age : null,
      });
      throw error;
    }
    return { ask, bid, timestamp, requestStartedAt, receivedAt: responseReceivedAt };
  }

  async function placeVstAdditionalLongStop({
    symbol, quantity, stopPrice, positionId, previousStopOrderId, previousStopPrice,
    probePolicy,
  }) {
    const name = requireVstBtc(symbol);
    requireProbePolicy(symbol, probePolicy);
    if (typeof positionId !== "string" || !positionId ||
        typeof previousStopOrderId !== "string" || !previousStopOrderId) {
      throw new BingXLiveApiError("VST additional stop requires exact position and original stop IDs");
    }
    const intent = `${positionId}:${String(quantity)}:${String(stopPrice)}`;
    if (submittedVstStopIntents.has(intent)) {
      throw new BingXLiveApiError("VST additional stop intent was already submitted; reconcile, never retry");
    }
    const [mode, marginType, leverage, positions, orders, filters] = await Promise.all([
      getPositionMode(), getMarginType(symbol), getLeverage(symbol), getPositions(symbol),
      getOpenOrders(symbol), contract(symbol),
    ]);
    if (mode !== "HEDGE" || marginType !== "ISOLATED" ||
        leverage.longLeverage !== 10 || leverage.shortLeverage !== 75) {
      throw new BingXLiveApiError(
        "VST additional stop requires verified HEDGE isolated LONG 10x/SHORT 75x",
      );
    }
    const active = positions.filter((row) => row?.symbol === name &&
      validPositionAmount(row) !== 0);
    if (active.length !== 1 || active[0].positionSide !== "LONG" ||
        validPositionAmount(active[0]) === null ||
        !sameDecimal(String(active[0].positionAmt), String(quantity)) ||
        orderIdentifier(active[0].positionId ?? active[0].positionID, "position ID") !== positionId) {
      throw new BingXLiveApiError("VST additional stop requires the exact verified remaining long position");
    }
    const previous = orders.filter((order) =>
      orderIdentifierFrom(order, "open order ID") === previousStopOrderId);
    if (orders.length !== 1 || previous.length !== 1 || previous[0].symbol !== name ||
        previous[0].status !== "NEW" ||
        previous[0].type !== "STOP_MARKET" || previous[0].side !== "SELL" ||
        previous[0].positionSide !== "LONG" || previous[0].workingType !== "MARK_PRICE" ||
        orderIdentifier(previous[0].positionId ?? previous[0].positionID, "stop position ID") !== positionId ||
        !sameDecimal(String(previous[0].origQty), String(quantity)) ||
        !sameDecimal(String(previous[0].stopPrice), String(previousStopPrice))) {
      throw new BingXLiveApiError("VST original protective stop is not independently verified");
    }
    const size = floorQuantity(String(quantity), filters.quantityPrecision);
    const trigger = String(stopPrice);
    decimalAtPrecision(trigger, filters.pricePrecision, "Additional stop price");
    if (!sameDecimal(size, String(quantity)) ||
        compareDecimals(trigger, String(previousStopPrice), "additional stop price") <= 0) {
      throw new BingXLiveApiError("VST additional stop must be higher than the original stop");
    }
    reserveStopTransferKey(submittedVstStopIntents, intent);
    // BingX documentation does not allow clientOrderId on STOP_MARKET orders.
    return request("POST", PATH.order, {
      symbol: name,
      side: "SELL",
      positionSide: "LONG",
      type: "STOP_MARKET",
      quantity: size,
      stopPrice: trigger,
      workingType: "MARK_PRICE",
    }, {
      beforeSign: async () => {
        const [freshPositions, freshOrders, freshMode, freshMarginType, freshLeverage] =
          await Promise.all([
          getPositions(symbol), getOpenOrders(symbol),
          getPositionMode(), getMarginType(symbol), getLeverage(symbol),
        ]);
        const freshActive = freshPositions.filter((row) =>
          row?.symbol === name && validPositionAmount(row) !== 0);
        const freshOldStops = freshOrders.filter((order) =>
          orderIdentifierFrom(order, "open order ID") === previousStopOrderId);
        if (freshMode !== "HEDGE" || freshMarginType !== "ISOLATED" ||
            freshLeverage.longLeverage !== 10 || freshLeverage.shortLeverage !== 75 ||
            freshActive.length !== 1 ||
            freshActive[0].positionSide !== "LONG" ||
            !sameDecimal(String(freshActive[0].positionAmt), String(quantity)) ||
            orderIdentifier(
              freshActive[0].positionId ?? freshActive[0].positionID, "position ID",
            ) !== positionId ||
            freshOrders.length !== 1 || freshOldStops.length !== 1 ||
            freshOldStops[0].symbol !== name ||
            freshOldStops[0].status !== "NEW" ||
            freshOldStops[0].type !== "STOP_MARKET" ||
            freshOldStops[0].side !== "SELL" ||
            freshOldStops[0].positionSide !== "LONG" ||
            freshOldStops[0].workingType !== "MARK_PRICE" ||
            orderIdentifier(
              freshOldStops[0].positionId ?? freshOldStops[0].positionID,
              "original stop position ID",
            ) !== positionId ||
            !sameDecimal(String(freshOldStops[0].origQty), String(quantity)) ||
            !sameDecimal(String(freshOldStops[0].stopPrice), String(previousStopPrice))) {
          throw new BingXLiveApiError("VST additional stop final exposure/original-stop check failed");
        }
        const freshMarket = await getVstMarkPrice(symbol);
        const age = clock() - freshMarket.timestamp;
        if (age < -2_000 || age > 10_000 ||
            compareDecimals(trigger, String(freshMarket.markPrice), "additional stop price") >= 0) {
          throw new BingXLiveApiError("VST additional stop requires a fresh mark above its trigger");
        }
      },
    });
  }

  function requireVstHedgeLong10(mode, marginType, leverage, label) {
    if (environment !== "vst") {
      throw new BingXLiveApiError(`${label} is unavailable outside VST`);
    }
    if (mode !== "HEDGE" || marginType !== PROFILE_MARGIN ||
        leverage.longLeverage !== PROFILE_LEVERAGE ||
        !Number.isFinite(leverage.shortLeverage) || leverage.shortLeverage <= 0) {
      throw new BingXLiveApiError(
        `${label} requires HEDGE isolated LONG 10x and independently verified SHORT leverage`,
      );
    }
  }

  function exactVstLongPosition(positions, name, quantity, positionId) {
    const active = positions.filter((row) =>
      row?.symbol === name && validPositionAmount(row) !== 0);
    if (active.length !== 1 || active[0].positionSide !== "LONG" ||
        validPositionAmount(active[0]) === null ||
        !sameDecimal(String(active[0].positionAmt), String(quantity)) ||
        orderIdentifier(active[0].positionId ?? active[0].positionID, "position ID") !==
          positionId) {
      throw new BingXLiveApiError("VST operation requires the exact verified remaining LONG position");
    }
    return active[0];
  }

  function validateEmergencyVstLongExit({
    mode, marginType, positions, orders, name, positionId, quantity,
  }) {
    if (mode !== "HEDGE" || marginType !== PROFILE_MARGIN) {
      throw new BingXLiveApiError(
        "VST emergency LONG exit requires HEDGE mode and isolated margin",
      );
    }
    if (!Array.isArray(positions) || positions.some((row) =>
      !row || typeof row !== "object" || typeof row.symbol !== "string")) {
      throw new BingXLiveApiError("VST emergency exit received unidentified position data");
    }
    const symbolPositions = positions.filter((row) => row.symbol === name);
    const active = symbolPositions.filter((row) => validPositionAmount(row) !== 0);
    if (symbolPositions.some((row) => validPositionAmount(row) === null) ||
        active.length !== 1 || active[0].positionSide !== "LONG" ||
        !sameDecimal(String(active[0].positionAmt), quantity) ||
        orderIdentifier(
          active[0].positionId ?? active[0].positionID, "emergency exit position ID",
        ) !== positionId) {
      throw new BingXLiveApiError(
        "VST emergency exit requires the exact persisted LONG position and full residual quantity",
      );
    }
    if (!Array.isArray(orders)) {
      throw new BingXLiveApiError("VST emergency exit open orders are unavailable");
    }
    const stopIds = new Set();
    for (const order of orders) {
      const orderId = orderIdentifierFrom(order, "protective stop order ID");
      const closePosition = order?.closePosition === true ||
        order?.closePosition === "true";
      let quantityMatches = closePosition;
      try {
        if (!closePosition) quantityMatches = sameDecimal(order.origQty, quantity);
        if (strictNumeric(order.stopPrice, "protective stop price") <= 0) {
          quantityMatches = false;
        }
      } catch {
        quantityMatches = false;
      }
      if (stopIds.has(orderId) || !quantityMatches ||
          !exactVstLongStop(order, {
            name, orderId, positionId, quantity, stopPrice: String(order.stopPrice),
          })) {
        throw new BingXLiveApiError(
          "VST emergency exit permits only exact-position protective LONG stops",
        );
      }
      stopIds.add(orderId);
    }
  }

  function exactVstLongStop(order, {
    name, orderId, positionId, quantity, stopPrice, entryOrderId,
  }) {
    const closePosition = order?.closePosition === true || order?.closePosition === "true";
    if (!order || order.symbol !== name || order.status !== "NEW" ||
        order.type !== "STOP_MARKET" || order.side !== "SELL" ||
        order.positionSide !== "LONG" || order.workingType !== "MARK_PRICE" ||
        (!closePosition && !sameDecimal(order.origQty, quantity)) ||
        !sameDecimal(order.stopPrice, stopPrice) ||
        orderIdentifierFrom(order, "protective stop order ID") !== orderId ||
        orderIdentifier(order.positionId ?? order.positionID, "stop position ID") !== positionId) {
      return false;
    }
    const mainOrderParents = order.mainOrderId === ""
      ? [] : [order.mainOrderId];
    const parents = [...mainOrderParents, order.parentOrderId]
      .filter((value) => value !== undefined && value !== null)
      .map((value) => orderIdentifier(value, "stop parent order ID"));
    return (order.mainOrderId == null || order.mainOrderId === "" ||
      (entryOrderId != null &&
       orderIdentifier(order.mainOrderId, "stop parent order ID") === entryOrderId)) &&
      new Set(parents).size <= 1 &&
      (entryOrderId == null || parents.every((parent) => parent === entryOrderId));
  }

  function verifiedVstLongStop(orders, {
    name, positionId, quantity, stopPrice, entryOrderId,
  }) {
    if (!Array.isArray(orders) || orders.length !== 1) {
      throw new BingXLiveApiError("VST margin top-up protective stop is unavailable");
    }
    const matches = orders.filter((order) => {
      try {
        return exactVstLongStop(order, {
          name,
          orderId: orderIdentifierFrom(order, "protective stop order ID"),
          positionId,
          quantity,
          stopPrice,
          entryOrderId,
        });
      } catch {
        return false;
      }
    });
    if (matches.length !== 1) {
      throw new BingXLiveApiError(
        "VST margin top-up requires exactly one active stop for the exact LONG position",
      );
    }
    return matches[0];
  }

  function exactStringOrderId(order) {
    const ids = [order?.orderId, order?.orderID]
      .filter((value) => value !== undefined && value !== null);
    if (!ids.length || ids.some((value) =>
      typeof value !== "string" || value.trim() === "")) return null;
    return new Set(ids).size === 1 ? ids[0] : null;
  }

  function stopCreationTimestamp(order) {
    const values = [order?.time, order?.createTime, order?.createdTime]
      .filter((value) => value !== undefined && value !== null && value !== "");
    if (!values.length) return null;
    const timestamps = values.map((value) => {
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

  async function discoverVstUpgradeStop({
    symbol, name, positionId, quantity, stopPrice, previousStopPrice, parentId, previousStopOrderId,
    baselineOrderIds, submittedAt,
  }) {
    const [positions, orders] = await Promise.all([
      getPositions(symbol), getOpenOrders(symbol),
    ]);
    exactVstLongPosition(positions, name, quantity, positionId);
    if (orders.length !== 2) return null;
    const oldStops = orders.filter((order) =>
      orderIdentifierFrom(order, "open order ID") === previousStopOrderId);
    if (oldStops.length !== 1 ||
        !exactVstLongStop(oldStops[0], {
          name, orderId: previousStopOrderId, positionId, quantity,
          stopPrice: previousStopPrice, entryOrderId: parentId,
        })) return null;
    const candidates = orders.filter((order) => {
      const orderId = exactStringOrderId(order);
      if (orderId === null || baselineOrderIds.has(orderId) ||
          !stopParentLinkMatches(order, parentId, { requirePresent: true }) ||
          !exactVstLongStop(order, {
            name, orderId, positionId, quantity, stopPrice, entryOrderId: parentId,
          }) || !sameDecimal(order.origQty, quantity)) return false;
      const createdAt = stopCreationTimestamp(order);
      return createdAt !== null && createdAt >= submittedAt - 2_000 &&
        createdAt <= clock() + 2_000;
    });
    if (candidates.length !== 1) return null;
    return exactStringOrderId(candidates[0]);
  }

  function stopParentLinkMatches(order, entryOrderId, { requirePresent = false } = {}) {
    const values = [order?.mainOrderId, order?.parentOrderId]
      .filter((value) => value !== undefined && value !== null && value !== "");
    if (values.length === 0) return !requirePresent;
    if (typeof entryOrderId !== "string" || entryOrderId.trim() === "") return false;
    try {
      return values.every((value) =>
        orderIdentifier(value, "stop parent order ID") === entryOrderId);
    } catch {
      return false;
    }
  }

  async function upgradeVstLongStop({
    symbol, quantity, positionId, entryOrderId,
    previousStopOrderId, previousStopPrice, stopPrice,
    onSubmission,
  }) {
    const name = symbolName(symbol);
    if (environment !== "vst") {
      throw new BingXLiveApiError("VST stop upgrades are unavailable outside VST");
    }
    if (onSubmission !== undefined && typeof onSubmission !== "function") {
      throw new TypeError("VST stop upgrade submission callback must be a function");
    }
    if (typeof positionId !== "string" || !positionId ||
        typeof previousStopOrderId !== "string" || !previousStopOrderId) {
      throw new BingXLiveApiError("VST stop upgrade requires exact position and old-stop IDs");
    }
    const intent = `${name}:${positionId}:${previousStopOrderId}:${String(quantity)}:${String(stopPrice)}`;
    if (submittedVstStopUpgradeIntents.has(intent)) {
      throw new BingXLiveApiError("VST stop upgrade was already submitted; reconcile, never retry");
    }
    const parentId = optionalOrderIdentifier(entryOrderId, "entry order ID");
    const [mode, marginType, leverage, positions, orders, filters] = await Promise.all([
      getPositionMode(), getMarginType(symbol), getLeverage(symbol),
      getPositions(symbol), getOpenOrders(symbol), contract(symbol),
    ]);
    requireVstHedgeLong10(mode, marginType, leverage, "VST stop upgrade");
    exactVstLongPosition(positions, name, quantity, positionId);
    decimalAtPrecision(String(previousStopPrice), filters.pricePrecision, "Previous stop price");
    decimalAtPrecision(String(stopPrice), filters.pricePrecision, "New stop price");
    if (compareDecimals(String(stopPrice), String(previousStopPrice), "new stop price") <= 0) {
      const error = new BingXLiveApiError(
        "VST protective stop upgrades may only raise the stop",
      );
      error.mutationProvenance = Object.freeze({
        operation: "raise_stop",
        method: "POST",
        phase: "pre_mutation_guard",
        mutationRequestSent: false,
        reason: "non_increasing_stop",
      });
      throw error;
    }
    // Price is checked at the final pre-sign boundary below, after these
    // potentially slow metadata/ownership reads, not twice in succession.
    const oldStops = orders.filter((order) =>
      orderIdentifierFrom(order, "open order ID") === previousStopOrderId);
    if (orders.length !== 1 || oldStops.length !== 1 ||
        !exactVstLongStop(oldStops[0], {
          name, orderId: previousStopOrderId, positionId, quantity,
          stopPrice: String(previousStopPrice), entryOrderId: parentId,
        })) {
      throw new BingXLiveApiError("VST original protective stop is not independently verified");
    }
    const size = floorQuantity(String(quantity), filters.quantityPrecision);
    if (!sameDecimal(size, String(quantity))) {
      throw new BingXLiveApiError("VST stop quantity does not match contract precision");
    }
    reserveStopTransferKey(submittedVstStopUpgradeIntents, intent);
    const baselineOrderIds = new Set(orders.map((order) =>
      orderIdentifierFrom(order, "open order ID")));
    let submittedAt = null;
    const newOrder = await request("POST", PATH.order, {
      symbol: name,
      side: "SELL",
      positionSide: "LONG",
      type: "STOP_MARKET",
      quantity: size,
      stopPrice: String(stopPrice),
      workingType: "MARK_PRICE",
    }, {
      beforeSign: async () => {
        const [freshMode, freshMarginType, freshLeverage, freshPositions, freshOrders] =
          await Promise.all([
            getPositionMode(), getMarginType(symbol), getLeverage(symbol),
            getPositions(symbol), getOpenOrders(symbol),
          ]);
        requireVstHedgeLong10(freshMode, freshMarginType, freshLeverage, "VST stop upgrade");
        exactVstLongPosition(freshPositions, name, quantity, positionId);
        const freshOld = freshOrders.filter((order) =>
          orderIdentifierFrom(order, "open order ID") === previousStopOrderId);
        if (freshOrders.length !== 1 || freshOld.length !== 1 ||
            !exactVstLongStop(freshOld[0], {
              name, orderId: previousStopOrderId, positionId, quantity,
              stopPrice: String(previousStopPrice), entryOrderId: parentId,
            })) {
          throw new BingXLiveApiError("VST old stop changed before upgrade submission");
        }
        const freshMark = await getVstMarkPrice(symbol, { openPosition: true });
        if (compareDecimals(String(stopPrice), String(freshMark.markPrice), "new stop price") >= 0) {
          throw new BingXLiveApiError("VST new stop requires a fresh mark price above its trigger");
        }
      },
      beforeTransport: async (timestamp) => { submittedAt = timestamp; },
    });
    let newStopOrderId;
    let acknowledgementDiagnostic;
    try {
      newStopOrderId = exactOrderIdentifierFrom(
        newOrder, "new protective stop order ID",
      );
    } catch (error) {
      acknowledgementDiagnostic = stopAcknowledgementDiagnostic(
        newOrder, error?.acknowledgementReason,
      );
    }

    const verifyCoexistence = async () => {
      const [freshPositions, freshOrders] = await Promise.all([
        getPositions(symbol), getOpenOrders(symbol),
      ]);
      exactVstLongPosition(freshPositions, name, quantity, positionId);
      const byId = new Map(freshOrders.map((order) => [
        orderIdentifierFrom(order, "open order ID"), order,
      ]));
      if (freshOrders.length !== 2 || byId.size !== 2 ||
          !exactVstLongStop(byId.get(previousStopOrderId), {
            name, orderId: previousStopOrderId, positionId, quantity,
            stopPrice: String(previousStopPrice), entryOrderId: parentId,
          }) ||
          !exactVstLongStop(byId.get(newStopOrderId), {
            name, orderId: newStopOrderId, positionId, quantity,
            stopPrice: String(stopPrice), entryOrderId: parentId,
          })) {
        throw new BingXLiveApiError(
          "VST new stop is not independently verified while the original stop remains open",
        );
      }
      const freshNewStop = byId.get(newStopOrderId);
      const queriedNewStop = await queryOrder(symbol, { orderId: newStopOrderId });
      let verifiedQuery = queriedNewStop;
      try {
        if (!queriedNewStop ||
            exactOrderIdentifierFrom(queriedNewStop, "queried new protective stop ID") !==
              newStopOrderId ||
            exactOrderIdentifierFrom(freshNewStop, "open new protective stop ID") !==
              newStopOrderId) {
          throw new Error("conflicting or missing exact order identity");
        }
        const requireExactPositionAliases = (row) => {
          const supplied = ["positionId", "positionID"]
            .filter((field) => Object.hasOwn(row, field));
          return supplied.length > 0 && supplied.every((field) =>
            row[field] !== undefined && row[field] !== null &&
            orderIdentifier(row[field], "stop position ID") === positionId);
        };
        const executionIsZeroWhenPresent = (row) => {
          const supplied = [
            "executedQty", "executedQuantity", "cumExecQty", "filledQty",
          ].filter((field) => Object.hasOwn(row, field));
          return supplied.every((field) =>
            row[field] !== undefined && row[field] !== null &&
            compareDecimals(String(row[field]), "0", "stop executed quantity") === 0);
        };
        const queryPositionAliases = ["positionId", "positionID"]
          .filter((field) => Object.hasOwn(queriedNewStop, field))
          .map((field) => queriedNewStop[field]);
        const isZeroPositionPlaceholder = queryPositionAliases.length > 0 &&
          queryPositionAliases.every((value) => value === 0 || value === "0");
        if (isZeroPositionPlaceholder) {
          // A standalone previous stop may legitimately have no parent alias.
          // In that case the caller's persisted entry ID is the immutable
          // provenance, while the exact acknowledged replacement ID and the
          // independently fetched active-order/position rows corroborate the
          // new stop. Any supplied parent aliases must still agree.
          if (typeof parentId !== "string" || parentId.trim() === "" ||
              !stopParentLinkMatches(byId.get(previousStopOrderId), parentId) ||
              !stopParentLinkMatches(freshNewStop, parentId)) {
            throw new Error("stop entry parent provenance is missing or conflicts");
          }
          verifiedQuery = corroborateVstActiveStopPosition(
            queriedNewStop, freshNewStop, {
              orderId: newStopOrderId, positionId,
            },
          );
          if (!verifiedQuery) {
            throw new Error("zero position placeholder is not corroborated");
          }
        } else {
          if (!requireExactPositionAliases(queriedNewStop)) {
            throw new Error("queried stop position ID does not match");
          }
        }
        if (!requireExactPositionAliases(freshNewStop) ||
            !executionIsZeroWhenPresent(freshNewStop) ||
            !executionIsZeroWhenPresent(queriedNewStop) ||
            !sameDecimal(freshNewStop.origQty, quantity) ||
            !sameDecimal(queriedNewStop.origQty, quantity) ||
            !exactVstLongStop(verifiedQuery, {
              name, orderId: newStopOrderId, positionId, quantity,
              stopPrice, entryOrderId: parentId,
            })) {
          throw new Error("exact-ID query does not confirm the active stop");
        }
      } catch {
        throw new BingXLiveApiError(
          "VST new stop exact-ID query did not confirm its active open-order identity",
        );
      }
      return byId;
    };
    let coexistenceRefusal;
    try {
      if (newStopOrderId !== undefined && onSubmission) {
        await onSubmission({ exchangeOrderId: newStopOrderId });
      }
      if (newStopOrderId === undefined) {
        try {
          newStopOrderId = await discoverVstUpgradeStop({
            symbol, name, positionId, quantity: String(quantity),
            stopPrice: String(stopPrice), previousStopPrice: String(previousStopPrice),
            parentId, previousStopOrderId, baselineOrderIds, submittedAt,
          });
        } catch {
          newStopOrderId = null;
        }
        if (newStopOrderId === null) {
          const failure = new BingXLiveApiError(
            "VST stop upgrade response and snapshot discovery are ambiguous; old and new stop identities are unknown, and the original stop was not cancelled",
          );
          failure.detail = { acknowledgement: acknowledgementDiagnostic };
          throw failure;
        }
        if (onSubmission) await onSubmission({ exchangeOrderId: newStopOrderId });
      }
      // DELETE's pre-sign hook verifies coexistence independently by exact
      // IDs before any cancellation can reach transport. A second identical
      // read here only delays that stronger, later verification.
      await request("DELETE", PATH.order, {
        symbol: name, orderId: previousStopOrderId,
      }, {
        beforeSign: async () => {
          const [cancelMode, cancelMarginType, cancelLeverage] = await Promise.all([
            getPositionMode(), getMarginType(symbol), getLeverage(symbol),
          ]);
          requireVstHedgeLong10(
            cancelMode, cancelMarginType, cancelLeverage, "VST stop cancellation",
          );
          try {
            await verifyCoexistence();
          } catch (error) {
            // request() redacts pre-sign failures. Retain this known native
            // proof refusal for stop recovery diagnostics without treating
            // the attempted cancellation as an exchange write.
            coexistenceRefusal = error;
            throw error;
          }
        },
      });
      const [finalPositions, finalOrders] = await Promise.all([
        getPositions(symbol), getOpenOrders(symbol),
      ]);
      exactVstLongPosition(finalPositions, name, quantity, positionId);
      if (finalOrders.length !== 1 ||
          !exactVstLongStop(finalOrders[0], {
            name, orderId: newStopOrderId, positionId, quantity,
            stopPrice: String(stopPrice), entryOrderId: parentId,
          })) {
        throw new BingXLiveApiError(
          "VST post-cancel verification failed: the new stop does not prove remaining-position coverage",
        );
      }
    } catch (error) {
      const failure = coexistenceRefusal instanceof Error ? coexistenceRefusal
        : error instanceof Error ? error
        : new BingXLiveApiError("VST stop upgrade outcome is unverified");
      if (acknowledgementDiagnostic) {
        failure.detail = { acknowledgement: acknowledgementDiagnostic };
      }
      if (typeof newStopOrderId === "string") {
        failure.exchangeOrderId = newStopOrderId;
        failure.submittedExchangeOrderId = newStopOrderId;
      }
      failure.exchangeOrderVerified = false;
      failure.submissionState = "submitted";
      throw failure;
    }
    return {
      symbol: name,
      oldStopOrderId: previousStopOrderId,
      newStopOrderId,
      exchangeOrderId: newStopOrderId,
      stopPrice: String(stopPrice),
      quantity: String(quantity),
      verified: true,
      ...(acknowledgementDiagnostic
        ? { acknowledgementDiagnostic } : {}),
    };
  }

  async function retireVstAutomatedAdoptedStop({
    symbol, policy, positionId, entryOrderId, oldStopOrderId, oldStopPrice,
    newStopOrderId, stopPrice, quantity, cancellationIntentId,
  }) {
    const name = requireAutomatedSplitPolicy(
      symbol, policy, "VST adopted-stop retirement",
    );
    const required = [
      positionId, entryOrderId, oldStopOrderId, newStopOrderId, cancellationIntentId,
    ];
    if (required.some((value) => typeof value !== "string" || !value.trim()) ||
        oldStopOrderId === newStopOrderId ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(cancellationIntentId)) {
      throw new BingXLiveApiError(
        "VST adopted-stop retirement requires exact distinct stop IDs and a persisted cancellation intent",
      );
    }
    const oldId = orderIdentifier(oldStopOrderId, "old stop order ID");
    const newId = orderIdentifier(newStopOrderId, "adopted stop order ID");
    const intent = `${name}:${positionId}:${oldId}:${newId}:adopted-stop:${cancellationIntentId}`;
    if (submittedVstAdoptedStopRetirements.has(intent)) {
      throw new BingXLiveApiError(
        "VST adopted-stop retirement intent already used; reconcile, never retry",
      );
    }
    const [filters, mode, margin, leverage] = await Promise.all([
      contract(symbol), getPositionMode(), getMarginType(symbol), getLeverage(symbol),
    ]);
    requireVstHedgeLong10(mode, margin, leverage, "VST adopted-stop retirement");
    decimalAtPrecision(String(oldStopPrice), filters.pricePrecision, "Old stop price");
    decimalAtPrecision(String(stopPrice), filters.pricePrecision, "Adopted stop price");
    decimalAtPrecision(String(quantity), filters.quantityPrecision, "Position quantity");
    positive(String(oldStopPrice), "old stop price");
    positive(String(stopPrice), "adopted stop price");
    positive(String(quantity), "position quantity");

    const executionIsZeroWhenPresent = (row, { requireAny = false } = {}) => {
      const supplied = [
        "executedQty", "executedQuantity", "cumExecQty", "filledQty",
      ].filter((field) => Object.hasOwn(row, field));
      try {
        return (!requireAny || supplied.length > 0) &&
          supplied.every((field) => row[field] !== null && row[field] !== undefined &&
          compareDecimals(String(row[field]), "0", "stop executed quantity") === 0);
      } catch {
        return false;
      }
    };
    const positionAliasesMatch = (row, { allowZero = false } = {}) => {
      const supplied = ["positionId", "positionID"]
        .filter((field) => Object.hasOwn(row, field));
      if (supplied.length === 0 || supplied.some((field) =>
        row[field] === null || row[field] === undefined)) return false;
      if (allowZero && supplied.every((field) =>
        row[field] === 0 || row[field] === "0")) return "zero";
      try {
        return supplied.every((field) =>
          orderIdentifier(row[field], "stop position ID") === positionId);
      } catch {
        return false;
      }
    };
    const exactStop = (row, orderId, expectedPrice, status = "NEW") => {
      if (!object(row)) return false;
      try {
        return exactOrderIdentifierFrom(row, "protective stop order ID") === orderId &&
          row.symbol === name && row.status === status &&
          row.type === "STOP_MARKET" && row.side === "SELL" &&
          row.positionSide === "LONG" && row.workingType === "MARK_PRICE" &&
          sameDecimal(row.origQty, String(quantity)) &&
          sameDecimal(row.stopPrice, String(expectedPrice)) &&
          stopParentLinkMatches(row, entryOrderId) &&
          executionIsZeroWhenPresent(row);
      } catch {
        return false;
      }
    };
    const verifyQuery = async (orderId, expectedPrice, activeRow) => {
      const queried = await queryOrder(symbol, { orderId });
      const positionMatch = queried && positionAliasesMatch(queried, { allowZero: true });
      let verified = queried;
      if (positionMatch === "zero") {
        verified = corroborateVstActiveStopPosition(
          queried, activeRow, { orderId, positionId },
        );
      } else if (positionMatch !== true) {
        verified = null;
      }
      if (!verified || !exactStop(verified, orderId, expectedPrice) ||
          !positionAliasesMatch(verified)) {
        throw new BingXLiveApiError(
          "VST adopted-stop exact-ID query did not confirm the active stop",
        );
      }
      return verified;
    };
    const verifyPair = async () => {
      const [positions, orders] = await Promise.all([
        getPositions(symbol), getOpenOrders(symbol),
      ]);
      exactVstLongPosition(positions, name, quantity, positionId);
      if (orders.length !== 2) {
        throw new BingXLiveApiError(
          "VST adopted-stop retirement requires exactly the old and adopted stops",
        );
      }
      const byId = new Map();
      for (const row of orders) {
        const id = exactOrderIdentifierFrom(row, "open protective stop order ID");
        if (byId.has(id)) {
          throw new BingXLiveApiError("VST adopted-stop open order IDs are ambiguous");
        }
        byId.set(id, row);
      }
      const oldRow = byId.get(oldId);
      const newRow = byId.get(newId);
      if (byId.size !== 2 ||
          !exactStop(oldRow, oldId, oldStopPrice) ||
          !exactStop(newRow, newId, stopPrice) ||
          !positionAliasesMatch(oldRow) || !positionAliasesMatch(newRow)) {
        throw new BingXLiveApiError(
          "VST old and adopted stops are not both exact active protection for the position",
        );
      }
      await verifyQuery(oldId, oldStopPrice, oldRow);
      await verifyQuery(newId, stopPrice, newRow);
      return { oldRow, newRow };
    };

    // Reserve before the first DELETE attempt, including the asynchronous
    // verification window, so concurrent calls cannot race into two DELETEs.
    reserveStopTransferKey(submittedVstAdoptedStopRetirements, intent);
    let deleteStarted = false;
    try {
      await verifyPair();
      await request("DELETE", PATH.order, {
        symbol: name, orderId: oldId,
      }, {
        beforeSign: async () => {
          requireVstHedgeLong10(
            await getPositionMode(), await getMarginType(symbol),
            await getLeverage(symbol), "VST adopted-stop retirement",
          );
          await verifyPair();
        },
        onTransportStart: () => { deleteStarted = true; },
      });
      const [positions, remainingOrders, oldQuery] = await Promise.all([
        getPositions(symbol), getOpenOrders(symbol), queryOrder(symbol, { orderId: oldId }),
      ]);
      exactVstLongPosition(positions, name, quantity, positionId);
      if (remainingOrders.length !== 1 ||
          exactOrderIdentifierFrom(remainingOrders[0], "remaining protective stop ID") !== newId ||
          !exactStop(remainingOrders[0], newId, stopPrice) ||
          !positionAliasesMatch(remainingOrders[0]) ||
          !oldQuery ||
          exactOrderIdentifierFrom(oldQuery, "cancelled protective stop ID") !== oldId ||
          !["CANCELED", "CANCELLED"].includes(oldQuery.status) ||
          !exactStop(oldQuery, oldId, oldStopPrice, oldQuery.status) ||
          !positionAliasesMatch(oldQuery) ||
          !executionIsZeroWhenPresent(oldQuery, { requireAny: true })) {
        throw new BingXLiveApiError(
          "VST adopted-stop retirement final state is not verified",
        );
      }
      const newQuery = await queryOrder(symbol, { orderId: newId });
      const newPositionMatch = newQuery && positionAliasesMatch(newQuery, { allowZero: true });
      let verifiedNewQuery = newQuery;
      if (newPositionMatch === "zero") {
        verifiedNewQuery = corroborateVstActiveStopPosition(
          newQuery, remainingOrders[0], { orderId: newId, positionId },
        );
      } else if (newPositionMatch !== true) {
        verifiedNewQuery = null;
      }
      if (!verifiedNewQuery || !exactStop(verifiedNewQuery, newId, stopPrice) ||
          !positionAliasesMatch(verifiedNewQuery)) {
        throw new BingXLiveApiError(
          "VST adopted stop exact-ID query failed after old-stop cancellation",
        );
      }
      return {
        verified: true,
        status: "CANCELED",
        canceledStopOrderId: oldId,
        exchangeOrderId: oldId,
        newStopOrderId: newId,
        positionId,
        quantity: String(quantity),
        stopPrice: String(stopPrice),
      };
    } catch (error) {
      if (!deleteStarted) submittedVstAdoptedStopRetirements.delete(intent);
      if (deleteStarted) setOriginalStopCancellationProvenance(error, true);
      else setOriginalStopCancellationProvenance(error, false);
      throw error;
    }
  }

  async function placeVstVirtualSplitLongStop({
    symbol, quantity, stopPrice, positionId, originalStopOrderId,
    originalStopPrice, entryOrderId, totalQuantity, tranche,
    breakEvenPrice, existingReplacementStops = [],
  }) {
    const name = requireVstBtc(symbol);
    if (typeof positionId !== "string" || !positionId ||
        typeof originalStopOrderId !== "string" || !originalStopOrderId ||
        !["core", "runner"].includes(tranche) ||
        !Array.isArray(existingReplacementStops) || existingReplacementStops.length > 1) {
      throw new BingXLiveApiError("VST virtual split stop requires exact persisted stop identities");
    }
    const intent = `${name}:${positionId}:${originalStopOrderId}:${String(quantity)}:${String(stopPrice)}`;
    if (submittedVstStopIntents.has(intent)) {
      throw new BingXLiveApiError("VST virtual split stop intent was already submitted; reconcile, never retry");
    }
    const parentId = optionalOrderIdentifier(entryOrderId, "entry order ID");
    const [mode, marginType, leverage, positions, orders, filters, mark] = await Promise.all([
      getPositionMode(), getMarginType(symbol), getLeverage(symbol),
      getPositions(symbol), getOpenOrders(symbol), contract(symbol), getVstMarkPrice(symbol),
    ]);
    requireVstHedgeLong10(mode, marginType, leverage, "VST virtual split stop");
    const plannedExistingQuantity = existingReplacementStops.reduce(
      (sum, stop) => addDecimals(sum, String(stop.quantity)), "0",
    );
    const replacementTotal = addDecimals(String(quantity), plannedExistingQuantity);
    if (compareDecimals(replacementTotal, String(totalQuantity), "split replacement quantity") > 0) {
      throw new BingXLiveApiError("VST replacement stop quantities exceed the exact position size");
    }
    const ratio = tranche === "core" ? 80 : 20;
    if (!decimalIsRatio(String(quantity), String(totalQuantity), ratio, 100) ||
        (tranche === "core" &&
          !sameDecimal(String(stopPrice), String(originalStopPrice))) ||
        (tranche === "runner" &&
          !sameDecimal(String(stopPrice), String(breakEvenPrice))) ||
        (tranche === "core" && existingReplacementStops.length !== 0) ||
        (tranche === "runner" &&
          (existingReplacementStops.length !== 1 ||
           existingReplacementStops[0].tranche !== "core" ||
           !decimalIsRatio(String(existingReplacementStops[0].quantity),
             String(totalQuantity), 80, 100) ||
           !sameDecimal(String(existingReplacementStops[0].stopPrice),
             String(originalStopPrice)) ||
           !sameDecimal(replacementTotal, String(totalQuantity))))) {
      throw new BingXLiveApiError("VST stop tranche must be exactly the virtual 80/20 core or runner allocation");
    }
    exactVstLongPosition(positions, name, String(totalQuantity), positionId);
    const original = orders.find((order) =>
      orderIdentifierFrom(order, "open order ID") === originalStopOrderId);
    if (!original || !exactVstLongStop(original, {
      name, orderId: originalStopOrderId, positionId, quantity: totalQuantity,
      stopPrice: String(originalStopPrice), entryOrderId: parentId,
    })) {
      throw new BingXLiveApiError("VST original full-size attached stop is not verified");
    }
    const expectedExisting = existingReplacementStops.map((stop) => ({
      ...stop,
      orderId: orderIdentifier(stop.orderId, "replacement stop order ID"),
    }));
    if (orders.length !== expectedExisting.length + 1 ||
        expectedExisting.some((stop) => !exactVstLongStop(
          orders.find((order) => orderIdentifierFrom(order, "open order ID") === stop.orderId),
          {
            name, orderId: stop.orderId, positionId, quantity: String(stop.quantity),
            stopPrice: String(stop.stopPrice), entryOrderId: parentId,
          },
        ))) {
      throw new BingXLiveApiError("VST split stop precondition requires only exact expected open stops");
    }
    const size = floorQuantity(String(quantity), filters.quantityPrecision);
    decimalAtPrecision(String(stopPrice), filters.pricePrecision, "Split stop price");
    if (!sameDecimal(size, String(quantity)) ||
        positive(size, "split stop quantity") < filters.minQuantity ||
        positive(size, "split stop quantity") * positive(String(stopPrice), "split stop price") <
          filters.minNotional ||
        compareDecimals(String(stopPrice), String(originalStopPrice), "split stop price") < 0 ||
        compareDecimals(String(stopPrice), String(mark.markPrice), "split stop price") >= 0 ||
        expectedExisting.some((stop) => compareDecimals(
          String(stop.stopPrice), String(stopPrice), "split stop price",
        ) === 0 && sameDecimal(String(stop.quantity), size))) {
      throw new BingXLiveApiError("VST split stop must be exact precision, no lower than signal stop, and below fresh mark");
    }
    const verifyBeforeWrite = async () => {
      const [freshMode, freshMargin, freshLeverage, freshPositions, freshOrders, freshMark] =
        await Promise.all([
          getPositionMode(), getMarginType(symbol), getLeverage(symbol),
          getPositions(symbol), getOpenOrders(symbol), getVstMarkPrice(symbol),
        ]);
      requireVstHedgeLong10(freshMode, freshMargin, freshLeverage, "VST virtual split stop");
        const freshActive = exactVstLongPosition(freshPositions, name, totalQuantity, positionId);
      const freshOriginal = freshOrders.find((order) =>
        orderIdentifierFrom(order, "open order ID") === originalStopOrderId);
      if (!freshActive || freshOrders.length !== expectedExisting.length + 1 ||
          !exactVstLongStop(freshOriginal, {
            name, orderId: originalStopOrderId, positionId, quantity: totalQuantity,
            stopPrice: String(originalStopPrice), entryOrderId: parentId,
          }) ||
          expectedExisting.some((stop) => !exactVstLongStop(
            freshOrders.find((order) =>
              orderIdentifierFrom(order, "open order ID") === stop.orderId),
            {
              name, orderId: stop.orderId, positionId,
              quantity: String(stop.quantity), stopPrice: String(stop.stopPrice),
              entryOrderId: parentId,
            },
          )) ||
          compareDecimals(String(stopPrice), String(freshMark.markPrice), "split stop price") >= 0) {
        throw new BingXLiveApiError("VST virtual split stop final state check failed");
      }
    };
    reserveStopTransferKey(submittedVstStopIntents, intent);
    return request("POST", PATH.order, {
      symbol: name, side: "SELL", positionSide: "LONG", type: "STOP_MARKET",
      quantity: size, stopPrice: String(stopPrice), workingType: "MARK_PRICE",
    }, { beforeSign: verifyBeforeWrite });
  }

  async function cancelVstAttachedLongStopAfterSplit({
    symbol, originalStopOrderId, originalStopPrice, positionId, entryOrderId,
    totalQuantity, breakEvenPrice, replacementStops,
  }) {
    const name = requireVstBtc(symbol);
    if (typeof originalStopOrderId !== "string" || !originalStopOrderId ||
        typeof positionId !== "string" || !positionId ||
        !Array.isArray(replacementStops) || replacementStops.length !== 2) {
      throw new BingXLiveApiError("VST original-stop cancellation requires two exact verified split stops");
    }
    const cancelIntent = `${name}:${positionId}:${originalStopOrderId}:split-cancel`;
    if (submittedVstStopUpgradeIntents.has(cancelIntent)) {
      throw new BingXLiveApiError("VST original-stop cancellation already submitted; reconcile, never retry");
    }
    const parentId = optionalOrderIdentifier(entryOrderId, "entry order ID");
    const [positions, orders, original] = await Promise.all([
      getPositions(symbol), getOpenOrders(symbol),
      queryOrder(symbol, { orderId: originalStopOrderId }),
    ]);
    exactVstLongPosition(positions, name, String(totalQuantity), positionId);
    const matches = replacementStops.map((stop) => ({
      ...stop, orderId: orderIdentifier(stop.orderId, "replacement stop order ID"),
    }));
    const replacementQuantity = addDecimals(
      String(matches[0].quantity), String(matches[1].quantity),
    );
    const coreStops = matches.filter((stop) =>
      stop.tranche === "core" &&
      decimalIsRatio(String(stop.quantity), String(totalQuantity), 80, 100) &&
      sameDecimal(String(stop.stopPrice), String(originalStopPrice)));
    const runnerStops = matches.filter((stop) =>
      stop.tranche === "runner" &&
      decimalIsRatio(String(stop.quantity), String(totalQuantity), 20, 100) &&
      sameDecimal(String(stop.stopPrice), String(breakEvenPrice)));
    if (matches[0].orderId === matches[1].orderId ||
        !sameDecimal(replacementQuantity, String(totalQuantity)) ||
        coreStops.length !== 1 || runnerStops.length !== 1 ||
        !exactVstActiveStopQuery(original, orders, {
          name, orderId: originalStopOrderId, positionId, quantity: String(totalQuantity),
          stopPrice: String(originalStopPrice), entryOrderId: parentId,
        }, exactVstLongStop) ||
        orders.length !== 3 ||
        matches.some((stop) => !exactVstLongStop(
          orders.find((order) => orderIdentifierFrom(order, "open order ID") === stop.orderId),
          {
            name, orderId: stop.orderId, positionId, quantity: String(stop.quantity),
            stopPrice: String(stop.stopPrice), entryOrderId: parentId,
          },
        )) ||
        compareDecimals(String(matches[0].quantity), String(matches[1].quantity), "split quantity") === 0) {
      throw new BingXLiveApiError("VST original stop cannot be canceled before both replacement stops are independently active");
    }
    reserveStopTransferKey(submittedVstStopUpgradeIntents, cancelIntent);
    await request("DELETE", PATH.order, { symbol: name, orderId: originalStopOrderId }, {
      beforeSign: async () => {
        const [freshMode, freshMargin, freshLeverage, freshPositions, freshOrders,
          freshOriginal] = await Promise.all([
          getPositionMode(), getMarginType(symbol), getLeverage(symbol),
          getPositions(symbol), getOpenOrders(symbol),
          queryOrder(symbol, { orderId: originalStopOrderId }),
        ]);
        requireVstHedgeLong10(freshMode, freshMargin, freshLeverage,
          "VST original-stop cancellation");
        exactVstLongPosition(freshPositions, name, String(totalQuantity), positionId);
        if (freshOrders.length !== 3 ||
            !exactVstActiveStopQuery(freshOriginal, freshOrders, {
              name, orderId: originalStopOrderId, positionId,
              quantity: String(totalQuantity), stopPrice: String(originalStopPrice),
              entryOrderId: parentId,
            }, exactVstLongStop) ||
            matches.some((stop) => !exactVstLongStop(
              freshOrders.find((order) =>
                orderIdentifierFrom(order, "open order ID") === stop.orderId),
              {
                name, orderId: stop.orderId, positionId,
                quantity: String(stop.quantity), stopPrice: String(stop.stopPrice),
                entryOrderId: parentId,
              },
            ))) {
          throw new BingXLiveApiError("VST original-stop cancellation final pre-delete verification failed");
        }
      },
    });
    const [finalOrder, remainingOrders, fills, remainingPositions] = await Promise.all([
      queryOrder(symbol, { orderId: originalStopOrderId }),
      getOpenOrders(symbol),
      queryFills(symbol, {
        startTs: 1, endTs: Math.max(1, Math.floor(clock())),
        orderId: originalStopOrderId, currency: "VST",
      }),
      getPositions(symbol),
    ]);
    exactVstLongPosition(remainingPositions, name, String(totalQuantity), positionId);
    if (!finalOrder || orderIdentifierFrom(finalOrder) !== originalStopOrderId ||
        !["CANCELED", "CANCELLED"].includes(finalOrder.status) ||
        remainingOrders.length !== 2 ||
        matches.some((stop) => !exactVstLongStop(
          remainingOrders.find((order) => orderIdentifierFrom(order) === stop.orderId),
          {
            name, orderId: stop.orderId, positionId, quantity: String(stop.quantity),
            stopPrice: String(stop.stopPrice), entryOrderId: parentId,
          },
        )) ||
        !Array.isArray(fills) || fills.length !== 0 ||
        finalOrder.executedQty !== undefined && !sameDecimal(finalOrder.executedQty, "0")) {
      throw new BingXLiveApiError("VST original attached stop cancellation is not independently verified without fills");
    }
    return { status: finalOrder.status, order: finalOrder, replacementStops: matches };
  }

  async function closeVstVirtualSplitTranche({
    symbol, quantity, totalQuantity, positionId, clientOrderId, trancheStop,
    retainedStop, tranche, signalStopPrice, breakEvenPrice,
  }) {
    const name = requireVstBtc(symbol);
    if (typeof positionId !== "string" || !positionId ||
        typeof clientOrderId !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(clientOrderId) ||
        !trancheStop?.orderId || !retainedStop?.orderId ||
        trancheStop.orderId === retainedStop.orderId) {
      throw new BingXLiveApiError("VST split partial close requires exact tranche and retained-stop identities");
    }
    if (submittedClientOrderIds.has(clientOrderId)) {
      throw new BingXLiveApiError("VST split partial close ID already submitted; reconcile, never retry");
    }
    const [mode, marginType, leverage, positions, orders, filters] = await Promise.all([
      getPositionMode(), getMarginType(symbol), getLeverage(symbol),
      getPositions(symbol), getOpenOrders(symbol), contract(symbol),
    ]);
    requireVstHedgeLong10(mode, marginType, leverage, "VST split partial close");
    exactVstLongPosition(positions, name, String(totalQuantity), positionId);
    const checkStop = (expected) => exactVstLongStop(
      orders.find((order) =>
        orderIdentifierFrom(order, "open order ID") === expected.orderId),
      {
        name, orderId: expected.orderId, positionId,
        quantity: String(expected.quantity), stopPrice: String(expected.stopPrice),
      },
    );
    if (orders.length !== 2 || !checkStop(trancheStop) || !checkStop(retainedStop)) {
      throw new BingXLiveApiError("VST partial close requires exactly the two verified split stops");
    }
    const size = floorQuantity(String(quantity), filters.quantityPrecision);
    const retainedRoleRatio = tranche === "core" ? 20 : 80;
    const expectedClosedStopPrice = tranche === "core" ? signalStopPrice : breakEvenPrice;
    const expectedRetainedStopPrice = tranche === "core" ? breakEvenPrice : signalStopPrice;
    if (!sameDecimal(size, String(quantity)) ||
        positive(size, "partial close quantity") < filters.minQuantity ||
        !sameDecimal(size, String(trancheStop.quantity)) ||
        !["core", "runner"].includes(tranche) ||
        !decimalIsRatio(size, String(totalQuantity), tranche === "core" ? 80 : 20, 100) ||
        !decimalIsRatio(String(retainedStop.quantity), String(totalQuantity),
          retainedRoleRatio, 100) ||
        !sameDecimal(String(trancheStop.stopPrice), String(expectedClosedStopPrice)) ||
        !sameDecimal(String(retainedStop.stopPrice), String(expectedRetainedStopPrice)) ||
        !sameDecimal(addDecimals(size, String(retainedStop.quantity)), String(totalQuantity)) ||
        compareDecimals(String(totalQuantity), size, "partial close quantity") <= 0) {
      throw new BingXLiveApiError("VST partial close size must exactly equal its tranche and leave a position");
    }
    submittedClientOrderIds.add(clientOrderId);
    return request("POST", PATH.order, {
      symbol: name, side: "SELL", positionSide: "LONG", type: "MARKET",
      quantity: size, clientOrderId,
    }, {
      beforeSign: async () => {
        const [freshMode, freshMargin, freshLeverage, freshPositions, freshOrders] =
          await Promise.all([
            getPositionMode(), getMarginType(symbol), getLeverage(symbol),
            getPositions(symbol), getOpenOrders(symbol),
          ]);
        requireVstHedgeLong10(freshMode, freshMargin, freshLeverage, "VST split partial close");
        exactVstLongPosition(freshPositions, name, String(totalQuantity), positionId);
        const stillExact = (expected) => exactVstLongStop(
          freshOrders.find((order) =>
            orderIdentifierFrom(order, "open order ID") === expected.orderId),
          {
            name, orderId: expected.orderId, positionId,
            quantity: String(expected.quantity), stopPrice: String(expected.stopPrice),
          },
        );
        if (freshOrders.length !== 2 || !stillExact(trancheStop) || !stillExact(retainedStop)) {
          throw new BingXLiveApiError("VST split partial close final state changed before submission");
        }
      },
    });
  }

  async function cancelVstSplitStopAfterPartial({
    symbol, stopToCancel, retainedStop, remainingQuantity, positionId, tranche,
    signalStopPrice, breakEvenPrice,
  }) {
    const name = requireVstBtc(symbol);
    if (!positionId || !stopToCancel?.orderId || !retainedStop?.orderId ||
        stopToCancel.orderId === retainedStop.orderId) {
      throw new BingXLiveApiError("VST split-stop cleanup requires exact persisted stop IDs");
    }
    if (!["core", "runner"].includes(tranche) ||
        !decimalIsRatio(String(stopToCancel.quantity), addDecimals(
          String(stopToCancel.quantity), String(retainedStop.quantity),
        ), tranche === "core" ? 80 : 20, 100)) {
      throw new BingXLiveApiError("VST partial stop cleanup must identify the exact 80/20 tranche");
    }
    if (!decimalIsRatio(String(retainedStop.quantity), addDecimals(
      String(stopToCancel.quantity), String(retainedStop.quantity),
    ), tranche === "core" ? 20 : 80, 100) ||
        !sameDecimal(retainedStop.quantity, remainingQuantity) ||
        !sameDecimal(String(stopToCancel.stopPrice),
          String(tranche === "core" ? signalStopPrice : breakEvenPrice)) ||
        !sameDecimal(String(retainedStop.stopPrice),
          String(tranche === "core" ? breakEvenPrice : signalStopPrice))) {
      throw new BingXLiveApiError("VST partial cleanup retained stop must exactly cover the opposite tranche");
    }
    const intent = `${name}:${positionId}:${stopToCancel.orderId}:partial-cleanup`;
    if (submittedVstStopUpgradeIntents.has(intent)) {
      throw new BingXLiveApiError("VST split-stop cleanup already submitted; reconcile, never retry");
    }
    const [positions, orders] = await Promise.all([
      getPositions(symbol), getOpenOrders(symbol),
    ]);
    exactVstLongPosition(positions, name, String(remainingQuantity), positionId);
    const exact = (expected) => exactVstLongStop(
      orders.find((order) =>
        orderIdentifierFrom(order, "open order ID") === expected.orderId),
      {
        name, orderId: expected.orderId, positionId,
        quantity: String(expected.quantity), stopPrice: String(expected.stopPrice),
      },
    );
    if (orders.length !== 2 || !exact(stopToCancel) || !exact(retainedStop) ||
        !sameDecimal(retainedStop.quantity, remainingQuantity)) {
      throw new BingXLiveApiError("VST exited-tranche stop cleanup requires exact residual position and retained stop");
    }
    reserveStopTransferKey(submittedVstStopUpgradeIntents, intent);
    await request("DELETE", PATH.order, {
      symbol: name, orderId: stopToCancel.orderId,
    }, {
      beforeSign: async () => {
        const [freshMode, freshMargin, freshLeverage, freshPositions, freshOrders] =
          await Promise.all([
            getPositionMode(), getMarginType(symbol), getLeverage(symbol),
            getPositions(symbol), getOpenOrders(symbol),
          ]);
        requireVstHedgeLong10(freshMode, freshMargin, freshLeverage,
          "VST exited-tranche stop cleanup");
        exactVstLongPosition(freshPositions, name, String(remainingQuantity), positionId);
        const stillExact = (expected) => exactVstLongStop(
          freshOrders.find((order) =>
            orderIdentifierFrom(order, "open order ID") === expected.orderId),
          {
            name, orderId: expected.orderId, positionId,
            quantity: String(expected.quantity), stopPrice: String(expected.stopPrice),
          },
        );
        if (freshOrders.length !== 2 || !stillExact(stopToCancel) ||
            !stillExact(retainedStop) ||
            !sameDecimal(retainedStop.quantity, remainingQuantity)) {
          throw new BingXLiveApiError("VST exited-tranche stop final pre-delete verification failed");
        }
      },
    });
    const [finalOrder, remainingOrders, fills, finalPositions] = await Promise.all([
      queryOrder(symbol, { orderId: stopToCancel.orderId }),
      getOpenOrders(symbol),
      queryFills(symbol, {
        startTs: 1, endTs: Math.max(1, Math.floor(clock())),
        orderId: stopToCancel.orderId, currency: "VST",
      }),
      getPositions(symbol),
    ]);
    exactVstLongPosition(finalPositions, name, String(remainingQuantity), positionId);
    if (!finalOrder ||
        orderIdentifierFrom(finalOrder, "canceled split stop ID") !== stopToCancel.orderId ||
        !["CANCELED", "CANCELLED"].includes(finalOrder.status) ||
        !Array.isArray(fills) || fills.length !== 0 || remainingOrders.length !== 1 ||
        finalOrder.executedQty !== undefined &&
          !sameDecimal(finalOrder.executedQty, "0") ||
        !exactVstLongStop(remainingOrders[0], {
          name, orderId: retainedStop.orderId, positionId,
          quantity: String(retainedStop.quantity), stopPrice: String(retainedStop.stopPrice),
        })) {
      throw new BingXLiveApiError("VST partial-close stop cleanup or retained-stop verification failed");
    }
    return { status: finalOrder.status, retainedStop: remainingOrders[0] };
  }

  function requireAutomatedSplitPolicy(symbol, policy, operation) {
    if (policy !== VST_AUTOMATED_LONG_POLICY || environment !== "vst") {
      throw new BingXLiveApiError(
        `${operation} requires the VST automated LONG policy and VST environment`,
      );
    }
    return symbolName(symbol);
  }

  function freshVstMarkAbove(mark, trigger, label) {
    const age = clock() - Number(mark?.timestamp);
    if (!Number.isFinite(Number(mark?.markPrice)) ||
        Number(mark.markPrice) <= 0 || !Number.isFinite(age) ||
        age < -2_000 || age > 10_000 ||
        compareDecimals(String(trigger), String(mark.markPrice), `${label} mark`) >= 0) {
      throw new BingXLiveApiError(`${label} requires a fresh mark above its stop trigger`);
    }
  }

  function hasExplicitZeroExecutionQuantity(order) {
    const fields = ["executedQty", "executedQuantity", "cumExecQty", "filledQty"]
      .filter((key) => Object.hasOwn(order ?? {}, key));
    if (fields.length === 0) return false;
    try {
      return fields.every((key) =>
        order[key] !== undefined && order[key] !== null &&
        sameDecimal(order[key], "0"));
    } catch {
      return false;
    }
  }

  function exactAutomatedSplitStop(order, expected) {
    if (!order || order.closePosition === true || order.closePosition === "true" ||
        order.origQty === undefined || order.origQty === null ||
        !hasExplicitZeroExecutionQuantity(order) ||
        !sameDecimal(order.origQty, String(expected.quantity))) {
      return false;
    }
    return exactVstLongStop(order, expected);
  }

  function exactVstActiveStopQuery(row, openOrders, expected, validate) {
    try {
      if (!Array.isArray(openOrders)) return false;
      const orderIdAliases = (order) =>
        ["orderId", "orderID"].filter((key) =>
          Object.hasOwn(order ?? {}, key));
      const exactOrderAliases = (order) => {
        const keys = orderIdAliases(order);
        return keys.length > 0 && keys.every((key) =>
          order[key] !== undefined && order[key] !== null &&
          orderIdentifier(order[key], "active stop order ID") === expected.orderId);
      };
      const referencesExpectedOrder = (order) =>
        orderIdAliases(order).some((key) => {
          try {
            return order[key] !== undefined && order[key] !== null &&
              orderIdentifier(order[key], "active stop order ID") === expected.orderId;
          } catch {
            return false;
          }
        });
      const exactPositionAliases = (order) => {
        const keys = ["positionId", "positionID"]
          .filter((key) => Object.hasOwn(order ?? {}, key));
        return keys.length > 0 &&
          keys.every((key) => order[key] !== undefined && order[key] !== null &&
            orderIdentifier(order[key], "active stop position ID") === expected.positionId);
      };
      if (!exactOrderAliases(row)) return false;
      const independentlyOpen = openOrders.filter(referencesExpectedOrder);
      if (independentlyOpen.length !== 1 ||
          !exactOrderAliases(independentlyOpen[0]) ||
          !exactPositionAliases(independentlyOpen[0]) ||
          !validate(independentlyOpen[0], expected)) return false;
      if (exactPositionAliases(row) && validate(row, expected)) return true;
      if (environment !== "vst") return false;
      const corroborated = corroborateVstActiveStopPosition(row, independentlyOpen[0], {
        orderId: expected.orderId,
        positionId: expected.positionId,
      });
      return Boolean(corroborated && validate(corroborated, expected));
    } catch {
      return false;
    }
  }

  function validateAutomatedSplitStopSet({
    orders, name, positionId, parentId, totalQuantity, originalStopOrderId,
    originalStopPrice, replacementStops, includeOriginal = true,
  }) {
    if (!Array.isArray(orders) ||
        orders.length !== replacementStops.length + Number(includeOriginal) ||
        includeOriginal && !exactAutomatedSplitStop(
          orders.find((order) =>
            orderIdentifierFrom(order, "open order ID") === originalStopOrderId),
          {
            name, orderId: originalStopOrderId, positionId, quantity: totalQuantity,
            stopPrice: String(originalStopPrice), entryOrderId: parentId,
          },
        ) ||
        replacementStops.some((stop) => !exactAutomatedSplitStop(
          orders.find((order) =>
            orderIdentifierFrom(order, "open order ID") === stop.orderId),
          {
            name, orderId: stop.orderId, positionId,
            quantity: String(stop.quantity), stopPrice: String(stop.stopPrice),
            entryOrderId: parentId,
          },
        ))) {
      throw new BingXLiveApiError(
        "VST automated split requires only exact expected open protective stops",
      );
    }
  }

  async function placeVstAutomatedVirtualSplitLongStop({
    symbol, policy, quantity, stopPrice, positionId, originalStopOrderId,
    originalStopPrice, entryOrderId, totalQuantity, tranche, breakEvenPrice,
    existingReplacementStops = [],
  }) {
    const name = requireAutomatedSplitPolicy(
      symbol, policy, "VST automated split stop",
    );
    if (typeof positionId !== "string" || !positionId ||
        typeof originalStopOrderId !== "string" || !originalStopOrderId ||
        !["core", "runner"].includes(tranche) ||
        !Array.isArray(existingReplacementStops) ||
        existingReplacementStops.length > 1) {
      throw new BingXLiveApiError(
        "VST automated split stop requires exact persisted stop identities",
      );
    }
    const intent = `${name}:${positionId}:${originalStopOrderId}:${tranche}:${String(quantity)}:${String(stopPrice)}`;
    if (submittedVstStopIntents.has(intent)) {
      throw new BingXLiveApiError(
        "VST automated split stop intent was already submitted; reconcile, never retry",
      );
    }
    const parentId = optionalOrderIdentifier(entryOrderId, "entry order ID");
    const [mode, marginType, leverage, positions, orders, filters, mark] =
      await Promise.all([
        getPositionMode(), getMarginType(symbol), getLeverage(symbol),
        getPositions(symbol), getOpenOrders(symbol), contract(symbol),
        getVstMarkPrice(symbol),
      ]);
    requireVstHedgeLong10(mode, marginType, leverage, "VST automated split stop");
    exactVstLongPosition(positions, name, String(totalQuantity), positionId);
    const previous = existingReplacementStops.map((stop) => ({
      ...stop,
      orderId: orderIdentifier(stop.orderId, "replacement stop order ID"),
    }));
    const replacementTotal = previous.reduce(
      (sum, stop) => addDecimals(sum, String(stop.quantity)), String(quantity),
    );
    const ratio = tranche === "core" ? 80 : 20;
    if (!decimalIsRatio(String(quantity), String(totalQuantity), ratio, 100) ||
        compareDecimals(replacementTotal, String(totalQuantity),
          "split replacement quantity") > 0 ||
        (tranche === "runner" &&
          !sameDecimal(replacementTotal, String(totalQuantity))) ||
        (tranche === "core" && previous.length !== 0) ||
        (tranche === "runner" &&
          (previous.length !== 1 || previous[0].tranche !== "core" ||
           !decimalIsRatio(String(previous[0].quantity), String(totalQuantity), 80, 100) ||
           !sameDecimal(String(previous[0].stopPrice), String(originalStopPrice)))) ||
        (tranche === "core" &&
          !sameDecimal(String(stopPrice), String(originalStopPrice))) ||
        (tranche === "runner" &&
          !sameDecimal(String(stopPrice), String(breakEvenPrice)))) {
      throw new BingXLiveApiError(
        "VST automated split quantities and triggers must exactly match the 80/20 policy",
      );
    }
    const original = orders.find((order) =>
      orderIdentifierFrom(order, "open order ID") === originalStopOrderId);
    if (!exactAutomatedSplitStop(original, {
      name, orderId: originalStopOrderId, positionId,
      quantity: String(totalQuantity), stopPrice: String(originalStopPrice),
      entryOrderId: parentId,
    })) {
      throw new BingXLiveApiError(
        "VST original full-size attached signal stop is not verified",
      );
    }
    validateAutomatedSplitStopSet({
      orders, name, positionId, parentId, totalQuantity,
      originalStopOrderId, originalStopPrice, replacementStops: previous,
    });
    const size = floorQuantity(String(quantity), filters.quantityPrecision);
    decimalAtPrecision(String(stopPrice), filters.pricePrecision, "Split stop price");
    if (!sameDecimal(size, String(quantity)) ||
        positive(size, "split stop quantity") < filters.minQuantity ||
        positive(size, "split stop quantity") * positive(String(stopPrice), "split stop price") <
          filters.minNotional ||
        compareDecimals(String(stopPrice), String(originalStopPrice), "split stop price") < 0) {
      throw new BingXLiveApiError(
        "VST automated split quantity or stop price violates contract precision/minimums",
      );
    }
    freshVstMarkAbove(mark, stopPrice, "VST automated split stop");
    const baselineIds = new Set(orders.map((order) =>
      orderIdentifierFrom(order, "open order ID")));
    submittedVstStopIntents.add(intent);
    const response = await request("POST", PATH.order, {
      symbol: name, side: "SELL", positionSide: "LONG", type: "STOP_MARKET",
      quantity: size, stopPrice: String(stopPrice), workingType: "MARK_PRICE",
    }, {
      beforeSign: async () => {
        const [freshMode, freshMargin, freshLeverage, freshPositions,
          freshOrders, freshMark] = await Promise.all([
          getPositionMode(), getMarginType(symbol), getLeverage(symbol),
          getPositions(symbol), getOpenOrders(symbol), getVstMarkPrice(symbol),
        ]);
        requireVstHedgeLong10(
          freshMode, freshMargin, freshLeverage, "VST automated split stop",
        );
        exactVstLongPosition(freshPositions, name, String(totalQuantity), positionId);
        validateAutomatedSplitStopSet({
          orders: freshOrders, name, positionId, parentId, totalQuantity,
          originalStopOrderId, originalStopPrice, replacementStops: previous,
        });
        freshVstMarkAbove(freshMark, stopPrice, "VST automated split stop");
      },
    });
    let newStopId = null;
    try {
      newStopId = orderIdentifierFrom(response, "new split stop order ID");
    } catch {
      // An ambiguous response is reconciled only from the exact open-order
      // snapshots below; no POST retry is permitted.
    }
    const expected = {
      tranche, orderId: newStopId, quantity: size, stopPrice: String(stopPrice),
    };
    const readExactSnapshot = async () => {
      const [freshPositions, freshOrders] = await Promise.all([
        getPositions(symbol), getOpenOrders(symbol),
      ]);
      exactVstLongPosition(freshPositions, name, String(totalQuantity), positionId);
      if (!Array.isArray(freshOrders) ||
          freshOrders.length !== previous.length + 2) {
        throw new BingXLiveApiError(
          "VST split stop open orders changed or contain foreign orders",
        );
      }
      const possible = freshOrders.filter((order) => {
        const id = exactStringOrderId(order);
        return id && !baselineIds.has(id) &&
          exactAutomatedSplitStop(order, {
            name, orderId: id, positionId, quantity: size,
            stopPrice: String(stopPrice), entryOrderId: parentId,
          }) && sameDecimal(order.origQty, size);
      });
      if (possible.length !== 1) {
        throw new BingXLiveApiError(
          "VST split stop candidate identity is missing or ambiguous",
        );
      }
      expected.orderId = exactStringOrderId(possible[0]);
      validateAutomatedSplitStopSet({
        orders: freshOrders, name, positionId, parentId, totalQuantity,
        originalStopOrderId, originalStopPrice,
        replacementStops: [...previous, expected],
      });
      if (newStopId && expected.orderId !== newStopId) {
        throw new BingXLiveApiError("VST split stop response ID conflicts with open orders");
      }
      return freshOrders;
    };
    const activeOrders = await readExactSnapshot();
    const queriedNewStop = await queryOrder(symbol, { orderId: expected.orderId });
    const queriedStopExpected = {
      name, orderId: expected.orderId, positionId, quantity: size,
      stopPrice: String(stopPrice), entryOrderId: parentId,
    };
    if (!exactVstActiveStopQuery(
      queriedNewStop, activeOrders, queriedStopExpected, exactAutomatedSplitStop,
    )) {
      throw new BingXLiveApiError(
        "VST split stop exact-ID query did not confirm its active open-order identity",
      );
    }
    return { symbol: name, ...expected, verified: true };
  }

  async function cancelVstAutomatedAttachedLongStopAfterSplit(args) {
    const attempt = {
      mutationTransportStarted: false,
      intent: undefined,
      provenanceEligible: true,
    };
    try {
      return await cancelVstAutomatedAttachedLongStopAfterSplitImpl(args, attempt);
    } catch (error) {
      if (!attempt.mutationTransportStarted && attempt.provenanceEligible) {
        if (attempt.intent !== undefined) {
          submittedVstStopUpgradeIntents.delete(attempt.intent);
        }
        setOriginalStopCancellationProvenance(error, false);
      } else if (attempt.mutationTransportStarted) {
        setOriginalStopCancellationProvenance(error, true);
      }
      throw error;
    }
  }

  async function cancelVstAutomatedAttachedLongStopAfterSplitImpl({
    symbol, policy, originalStopOrderId, originalStopPrice, positionId,
    entryOrderId, totalQuantity, breakEvenPrice, replacementStops,
  }, attempt) {
    const name = requireAutomatedSplitPolicy(
      symbol, policy, "VST automated original-stop cancellation",
    );
    if (!Array.isArray(replacementStops) || replacementStops.length !== 2 ||
        typeof positionId !== "string" || !positionId ||
        typeof originalStopOrderId !== "string" || !originalStopOrderId) {
      throw new BingXLiveApiError(
        "VST automated original-stop cancellation requires both exact replacement stops",
      );
    }
    const intent = `${name}:${positionId}:${originalStopOrderId}:automated-split-cancel`;
    attempt.intent = intent;
    if (submittedVstStopUpgradeIntents.has(intent)) {
      // A prior invocation may already have reached DELETE. Do not let this
      // duplicate-call refusal masquerade as proof about that earlier attempt.
      attempt.provenanceEligible = false;
      throw new BingXLiveApiError(
        "VST automated original-stop cancellation already submitted; reconcile, never retry",
      );
    }
    const parentId = optionalOrderIdentifier(entryOrderId, "entry order ID");
    const stops = replacementStops.map((stop) => ({
      ...stop, orderId: orderIdentifier(stop.orderId, "replacement stop order ID"),
    }));
    const core = stops.filter((stop) => stop.tranche === "core" &&
      decimalIsRatio(String(stop.quantity), String(totalQuantity), 80, 100) &&
      sameDecimal(String(stop.stopPrice), String(originalStopPrice)));
    const runner = stops.filter((stop) => stop.tranche === "runner" &&
      decimalIsRatio(String(stop.quantity), String(totalQuantity), 20, 100) &&
      sameDecimal(String(stop.stopPrice), String(breakEvenPrice)));
    if (core.length !== 1 || runner.length !== 1 ||
        core[0].orderId === runner[0].orderId ||
        !sameDecimal(addDecimals(String(core[0].quantity), String(runner[0].quantity)),
          String(totalQuantity))) {
      throw new BingXLiveApiError(
        "VST automated split stops do not exactly cover the 80/20 position",
      );
    }
    const verify = async () => {
      const [mode, margin, leverage, positions, orders] = await Promise.all([
        getPositionMode(), getMarginType(symbol), getLeverage(symbol),
        getPositions(symbol), getOpenOrders(symbol),
      ]);
      requireVstHedgeLong10(
        mode, margin, leverage, "VST automated original-stop cancellation",
      );
      exactVstLongPosition(positions, name, String(totalQuantity), positionId);
      validateAutomatedSplitStopSet({
        orders, name, positionId, parentId, totalQuantity, originalStopOrderId,
        originalStopPrice, replacementStops: stops,
      });
      return orders;
    };
    const original = await queryOrder(symbol, { orderId: originalStopOrderId });
    const activeOrders = await verify();
    if (!exactVstActiveStopQuery(original, activeOrders, {
      name, orderId: originalStopOrderId, positionId,
      quantity: String(totalQuantity), stopPrice: String(originalStopPrice),
      entryOrderId: parentId,
    }, exactAutomatedSplitStop)) {
      throw new BingXLiveApiError("VST attached signal stop is not exactly open");
    }
    const queriedStops = await Promise.all(stops.map((stop) =>
      queryOrder(symbol, { orderId: stop.orderId })));
    if (stops.some((stop, index) => !exactVstActiveStopQuery(
      queriedStops[index], activeOrders, {
        name, orderId: stop.orderId, positionId,
        quantity: String(stop.quantity), stopPrice: String(stop.stopPrice),
        entryOrderId: parentId,
      }, exactAutomatedSplitStop))) {
      throw new BingXLiveApiError(
        "VST replacement stop exact-ID queries did not confirm both active orders",
      );
    }
    reserveStopTransferKey(submittedVstStopUpgradeIntents, intent);
    await request("DELETE", PATH.order, {
      symbol: name, orderId: originalStopOrderId,
    }, {
      beforeSign: verify,
      onTransportStart: () => { attempt.mutationTransportStarted = true; },
    });
    const [final, remaining, fills, positions] = await Promise.all([
      queryOrder(symbol, { orderId: originalStopOrderId }),
      getOpenOrders(symbol),
      queryFills(symbol, {
        startTs: 1, endTs: Math.max(1, Math.floor(clock())),
        orderId: originalStopOrderId, currency: "VST",
      }),
      getPositions(symbol),
    ]);
    exactVstLongPosition(positions, name, String(totalQuantity), positionId);
    if (!final || orderIdentifierFrom(final) !== originalStopOrderId ||
        !["CANCELED", "CANCELLED"].includes(final.status) ||
        !Array.isArray(fills) || fills.length !== 0 ||
        final.executedQty !== undefined && !sameDecimal(final.executedQty, "0")) {
      throw new BingXLiveApiError(
        "VST original attached stop cancellation is ambiguous or has fills",
      );
    }
    validateAutomatedSplitStopSet({
      orders: remaining, name, positionId, parentId, totalQuantity,
      originalStopOrderId: "__canceled_original__", originalStopPrice,
      replacementStops: stops, includeOriginal: false,
    });
    return { status: final.status, order: final, replacementStops: stops };
  }

  async function closeVstAutomatedSplitTranche({
    symbol, policy, quantity, totalQuantity, positionId, clientOrderId,
    trancheStop, retainedStop, tranche, signalStopPrice, breakEvenPrice,
  }) {
    const name = requireAutomatedSplitPolicy(
      symbol, policy, "VST automated split partial close",
    );
    if (typeof positionId !== "string" || !positionId ||
        typeof clientOrderId !== "string" ||
        !/^[A-Za-z0-9_-]{1,32}$/.test(clientOrderId) ||
        !trancheStop?.orderId || !retainedStop?.orderId ||
        trancheStop.orderId === retainedStop.orderId ||
        !["core", "runner"].includes(tranche)) {
      throw new BingXLiveApiError(
        "VST automated partial close requires exact tranche, retained-stop and client IDs",
      );
    }
    if (submittedClientOrderIds.has(clientOrderId)) {
      throw new BingXLiveApiError(
        "VST automated split close ID already submitted; reconcile, never retry",
      );
    }
    const [mode, margin, leverage, positions, orders, filters] = await Promise.all([
      getPositionMode(), getMarginType(symbol), getLeverage(symbol),
      getPositions(symbol), getOpenOrders(symbol), contract(symbol),
    ]);
    requireVstHedgeLong10(mode, margin, leverage, "VST automated split partial close");
    exactVstLongPosition(positions, name, String(totalQuantity), positionId);
    const stopIsExact = (stop) => exactAutomatedSplitStop(
      orders.find((order) => orderIdentifierFrom(order, "open order ID") === stop.orderId),
      {
        name, orderId: stop.orderId, positionId,
        quantity: String(stop.quantity), stopPrice: String(stop.stopPrice),
      },
    );
    if (orders.length !== 2 || !stopIsExact(trancheStop) || !stopIsExact(retainedStop)) {
      throw new BingXLiveApiError(
        "VST automated partial close requires both exact active tranche stops and no foreign orders",
      );
    }
    const size = floorQuantity(String(quantity), filters.quantityPrecision);
    const closedRatio = tranche === "core" ? 80 : 20;
    const retainedRatio = tranche === "core" ? 20 : 80;
    const closedPrice = tranche === "core" ? signalStopPrice : breakEvenPrice;
    const retainedPrice = tranche === "core" ? breakEvenPrice : signalStopPrice;
    const remaining = subtractDecimals(String(totalQuantity), size);
    if (!sameDecimal(size, String(quantity)) ||
        positive(size, "partial close quantity") < filters.minQuantity ||
        positive(size, "partial close quantity") * positive(String(closedPrice), "stop price") <
          filters.minNotional ||
        !decimalIsRatio(size, String(totalQuantity), closedRatio, 100) ||
        !decimalIsRatio(String(retainedStop.quantity), String(totalQuantity), retainedRatio, 100) ||
        !sameDecimal(String(trancheStop.quantity), size) ||
        !sameDecimal(String(trancheStop.stopPrice), String(closedPrice)) ||
        !sameDecimal(String(retainedStop.stopPrice), String(retainedPrice)) ||
        !sameDecimal(String(retainedStop.quantity), remaining)) {
      throw new BingXLiveApiError(
        "VST automated close quantity and retained stop must exactly match its 80/20 remainder",
      );
    }
    submittedClientOrderIds.add(clientOrderId);
    const response = await request("POST", PATH.order, {
      symbol: name, side: "SELL", positionSide: "LONG", type: "MARKET",
      quantity: size, clientOrderId,
    }, {
      beforeSign: async () => {
        const [freshMode, freshMargin, freshLeverage, freshPositions, freshOrders] =
          await Promise.all([
            getPositionMode(), getMarginType(symbol), getLeverage(symbol),
            getPositions(symbol), getOpenOrders(symbol),
          ]);
        requireVstHedgeLong10(
          freshMode, freshMargin, freshLeverage, "VST automated split partial close",
        );
        exactVstLongPosition(freshPositions, name, String(totalQuantity), positionId);
        if (freshOrders.length !== 2 ||
            !exactAutomatedSplitStop(
              freshOrders.find((row) => orderIdentifierFrom(row) === trancheStop.orderId),
              { name, orderId: trancheStop.orderId, positionId,
                quantity: String(trancheStop.quantity), stopPrice: String(trancheStop.stopPrice) },
            ) ||
            !exactAutomatedSplitStop(
              freshOrders.find((row) => orderIdentifierFrom(row) === retainedStop.orderId),
              { name, orderId: retainedStop.orderId, positionId,
                quantity: String(retainedStop.quantity), stopPrice: String(retainedStop.stopPrice) },
            )) {
          throw new BingXLiveApiError(
            "VST automated split close final exact-stop check failed",
          );
        }
      },
    });
    const closeId = orderIdentifierFrom(response, "partial close order ID");
    const [finalOrder, fills, finalPositions, finalOrders] = await Promise.all([
      queryOrder(symbol, { orderId: closeId }),
      queryFills(symbol, {
        startTs: 1, endTs: Math.max(1, Math.floor(clock())),
        orderId: closeId, currency: "VST",
      }),
      getPositions(symbol), getOpenOrders(symbol),
    ]);
    exactVstLongPosition(finalPositions, name, remaining, positionId);
    const retainedActive = finalOrders.filter((row) =>
      orderIdentifierFrom(row, "open order ID") === retainedStop.orderId);
    if (!finalOrder || orderIdentifierFrom(finalOrder) !== closeId ||
        finalOrder.symbol !== name || finalOrder.side !== "SELL" ||
        finalOrder.positionSide !== "LONG" ||
        finalOrder.type !== "MARKET" ||
        finalOrder.status !== "FILLED" ||
        (finalOrder.clientOrderId ?? finalOrder.clientOrderID) !== clientOrderId ||
        !sameDecimal(finalOrder.origQty, size) ||
        !sameDecimal(finalOrder.executedQty, size) ||
        !Array.isArray(fills) || !fills.length ||
        fills.some((fill) => fill.symbol !== name ||
          orderIdentifierFrom(fill) !== closeId || fill.side !== "SELL") ||
        !sameDecimal(fills.slice(1).reduce((sum, fill) => addDecimals(
          sum, String(fill.qty ?? fill.quantity ?? fill.volume),
        ), String(fills[0].qty ?? fills[0].quantity ?? fills[0].volume)), size) ||
        finalOrders.length !== 2 ||
        retainedActive.length !== 1 ||
        !exactAutomatedSplitStop(retainedActive[0], {
          name, orderId: retainedStop.orderId, positionId,
          quantity: remaining, stopPrice: String(retainedPrice),
        }) ||
        !exactAutomatedSplitStop(
          finalOrders.find((row) =>
            orderIdentifierFrom(row, "open order ID") === trancheStop.orderId),
          {
            name, orderId: trancheStop.orderId, positionId,
            quantity: String(trancheStop.quantity), stopPrice: String(trancheStop.stopPrice),
          },
        )) {
      throw new BingXLiveApiError(
        "VST automated split close fill, remainder or retained-stop verification failed",
      );
    }
    return {
      symbol: name, orderId: closeId, status: finalOrder.status,
      executedQuantity: size, remainingQuantity: remaining,
      retainedStop: retainedActive[0], verified: true,
    };
  }

  async function cancelVstAutomatedSplitStopAfterPartial({
    symbol, policy, stopToCancel, retainedStop, remainingQuantity, positionId,
    tranche, signalStopPrice, breakEvenPrice,
  }) {
    const name = requireAutomatedSplitPolicy(
      symbol, policy, "VST automated exited-tranche stop cleanup",
    );
    if (typeof positionId !== "string" || !positionId ||
        !stopToCancel?.orderId || !retainedStop?.orderId ||
        stopToCancel.orderId === retainedStop.orderId ||
        !sameDecimal(String(retainedStop.quantity), String(remainingQuantity)) ||
        !["core", "runner"].includes(tranche)) {
      throw new BingXLiveApiError(
        "VST automated split cleanup requires exact exited and retained stop IDs",
      );
    }
    const originalTotal = addDecimals(
      String(stopToCancel.quantity), String(retainedStop.quantity),
    );
    const intent = `${name}:${positionId}:${stopToCancel.orderId}:automated-partial-cleanup`;
    if (submittedVstStopUpgradeIntents.has(intent)) {
      throw new BingXLiveApiError(
        "VST automated split cleanup already submitted; reconcile, never retry",
      );
    }
    const verify = async () => {
      const [mode, margin, leverage, positions, orders] = await Promise.all([
        getPositionMode(), getMarginType(symbol), getLeverage(symbol),
        getPositions(symbol), getOpenOrders(symbol),
      ]);
      requireVstHedgeLong10(
        mode, margin, leverage, "VST automated exited-tranche stop cleanup",
      );
      exactVstLongPosition(positions, name, String(remainingQuantity), positionId);
      const exact = (expected) => exactAutomatedSplitStop(
        orders.find((row) => orderIdentifierFrom(row, "open order ID") === expected.orderId),
        {
          name, orderId: expected.orderId, positionId,
          quantity: String(expected.quantity), stopPrice: String(expected.stopPrice),
        },
      );
      const cancelRatio = tranche === "core" ? 80 : 20;
      const retainRatio = tranche === "core" ? 20 : 80;
      const cancelPrice = tranche === "core" ? signalStopPrice : breakEvenPrice;
      const retainPrice = tranche === "core" ? breakEvenPrice : signalStopPrice;
      if (orders.length !== 2 || !exact(stopToCancel) || !exact(retainedStop) ||
          !decimalIsRatio(String(stopToCancel.quantity), originalTotal, cancelRatio, 100) ||
          !decimalIsRatio(String(retainedStop.quantity), originalTotal, retainRatio, 100) ||
          !sameDecimal(String(stopToCancel.stopPrice), String(cancelPrice)) ||
          !sameDecimal(String(retainedStop.stopPrice), String(retainPrice)) ||
          !sameDecimal(String(retainedStop.quantity), String(remainingQuantity))) {
        throw new BingXLiveApiError(
          "VST automated partial cleanup requires exact residual position and both split stops",
        );
      }
      return orders;
    };
    await verify();
    reserveStopTransferKey(submittedVstStopUpgradeIntents, intent);
    await request("DELETE", PATH.order, {
      symbol: name, orderId: stopToCancel.orderId,
    }, { beforeSign: verify });
    const [finalOrder, remainingOrders, fills, positions] = await Promise.all([
      queryOrder(symbol, { orderId: stopToCancel.orderId }),
      getOpenOrders(symbol),
      queryFills(symbol, {
        startTs: 1, endTs: Math.max(1, Math.floor(clock())),
        orderId: stopToCancel.orderId, currency: "VST",
      }),
      getPositions(symbol),
    ]);
    exactVstLongPosition(positions, name, String(remainingQuantity), positionId);
    if (!finalOrder ||
        orderIdentifierFrom(finalOrder, "canceled split stop ID") !== stopToCancel.orderId ||
        !["CANCELED", "CANCELLED"].includes(finalOrder.status) ||
        !Array.isArray(fills) || fills.length !== 0 ||
        finalOrder.executedQty !== undefined && !sameDecimal(finalOrder.executedQty, "0") ||
        remainingOrders.length !== 1 ||
        !exactAutomatedSplitStop(remainingOrders[0], {
          name, orderId: retainedStop.orderId, positionId,
          quantity: String(retainedStop.quantity), stopPrice: String(retainedStop.stopPrice),
        })) {
      throw new BingXLiveApiError(
        "VST automated partial-stop cleanup or retained stop is not verified",
      );
    }
    return { status: finalOrder.status, retainedStop: remainingOrders[0] };
  }

  async function cancelVstAutomatedOriginalAfterTriggeredRunner({
    symbol, policy, positionId, runnerStopOrderId, runnerChildOrderId,
    originalStopOrderId, coreStopOrderId, totalQuantity, remainingQuantity,
    signalStopPrice, breakEvenPrice, cancellationIntentId, runnerFillAt,
  }) {
    const name = requireAutomatedSplitPolicy(
      symbol, policy, "VST triggered-runner original-stop cancellation",
    );
    const requiredIds = [
      positionId, runnerStopOrderId, runnerChildOrderId,
      originalStopOrderId, coreStopOrderId, cancellationIntentId,
    ];
    if (requiredIds.some((value) => typeof value !== "string" || !value.trim()) ||
        new Set([runnerStopOrderId, runnerChildOrderId, originalStopOrderId, coreStopOrderId])
          .size !== 4 ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(cancellationIntentId)) {
      throw new BingXLiveApiError(
        "VST triggered-runner cleanup requires exact stop/child IDs and a persisted cancellation intent",
      );
    }
    const parsedRunnerFillAt = typeof runnerFillAt === "string"
      ? Date.parse(runnerFillAt) : Number(runnerFillAt);
    const runnerFillStartTs = Number.isSafeInteger(parsedRunnerFillAt) &&
      parsedRunnerFillAt > 0 ? parsedRunnerFillAt : null;
    const runnerFillQueryStartTs = runnerFillStartTs === null
      ? null : runnerFillStartTs - 1;
    const runnerFillQueryRange = () => {
      const endTs = Math.max(1, Math.floor(clock()));
      if (runnerFillQueryStartTs === null || runnerFillQueryStartTs < 1 ||
          !Number.isSafeInteger(endTs) || endTs < runnerFillQueryStartTs ||
          runnerFillStartTs > endTs + 2_000 ||
          endTs - runnerFillQueryStartTs > VST_RUNNER_FILL_HISTORY_MAX_AGE_MS) {
        throw new BingXLiveApiError(
          "VST triggered-runner cleanup requires a recent persisted runner fill timestamp",
        );
      }
      return { startTs: runnerFillQueryStartTs, endTs };
    };
    runnerFillQueryRange();
    const runnerQuantity = subtractDecimals(String(totalQuantity), String(remainingQuantity));
    const intent = `${name}:${positionId}:${originalStopOrderId}:triggered-runner:${cancellationIntentId}`;
    const cancelIdentity = `${name}:${positionId}:${originalStopOrderId}:${runnerStopOrderId}:triggered-runner`;
    if (submittedVstStopUpgradeIntents.has(intent) ||
        submittedTriggeredRunnerCancellationIds.has(cancelIdentity)) {
      throw new BingXLiveApiError(
        "VST triggered-runner cancellation intent already used; reconcile, never retry",
      );
    }
    const [filters, mode, margin, leverage] = await Promise.all([
      contract(symbol), getPositionMode(), getMarginType(symbol), getLeverage(symbol),
    ]);
    requireVstHedgeLong10(
      mode, margin, leverage, "VST triggered-runner original-stop cancellation",
    );
    decimalAtPrecision(String(totalQuantity), filters.quantityPrecision, "Position quantity");
    decimalAtPrecision(String(remainingQuantity), filters.quantityPrecision, "Residual quantity");
    decimalAtPrecision(String(runnerQuantity), filters.quantityPrecision, "Runner fill quantity");
    decimalAtPrecision(String(signalStopPrice), filters.pricePrecision, "Signal stop price");
    decimalAtPrecision(String(breakEvenPrice), filters.pricePrecision, "Runner break-even price");
    if (!decimalIsRatio(String(runnerQuantity), String(totalQuantity), 20, 100) ||
        !decimalIsRatio(String(remainingQuantity), String(totalQuantity), 80, 100) ||
        positive(runnerQuantity, "runner fill quantity") < filters.minQuantity ||
        positive(String(remainingQuantity), "residual quantity") < filters.minQuantity ||
        positive(String(remainingQuantity), "residual quantity") *
          positive(String(signalStopPrice), "signal stop price") < filters.minNotional) {
      throw new BingXLiveApiError(
        "VST triggered-runner quantities must be exact contract-valid 20/80 amounts",
      );
    }

    const exactStringFieldId = (row, keys) => {
      const values = keys.filter((key) =>
        row?.[key] !== undefined && row[key] !== null).map((key) => row[key]);
      return values.length && values.every((value) =>
        typeof value === "string" && value.trim() !== "") &&
        new Set(values).size === 1 ? values[0] : null;
    };
    const positionIdMatches = (row, allowZero = false, allowMissing = false) => {
      const values = ["positionId", "positionID"].filter((key) =>
        row?.[key] !== undefined && row[key] !== null).map((key) => row[key]);
      if (!values.length) return allowMissing;
      return values.every((value) => typeof value === "string" && value === positionId) ||
        allowZero && values.every((value) => value === "0" || value === 0);
    };
    const exactRunnerOrderQuantity = (row) => {
      const quantities = ["origQty", "qty", "quantity"].filter((key) =>
        row?.[key] !== undefined && row[key] !== null).map((key) => row[key]);
      const executed = ["executedQty", "executedQuantity"].filter((key) =>
        row?.[key] !== undefined && row[key] !== null).map((key) => row[key]);
      return quantities.length > 0 && executed.length > 0 &&
        quantities.every((value) => sameDecimal(value, runnerQuantity)) &&
        executed.every((value) => sameDecimal(value, runnerQuantity));
    };
    const validateEvidence = async () => {
      const runnerFillRange = runnerFillQueryRange();
      const [freshMode, freshMargin, freshLeverage, positions, orders,
        runnerOrder, childOrder, fills] = await Promise.all([
        getPositionMode(), getMarginType(symbol), getLeverage(symbol),
        getPositions(symbol), getOpenOrders(symbol),
        queryOrder(symbol, { orderId: runnerStopOrderId }),
        queryOrder(symbol, { orderId: runnerChildOrderId }),
        queryFills(symbol, {
          ...runnerFillRange,
          currency: "VST",
        }),
      ]);
      requireVstHedgeLong10(
        freshMode, freshMargin, freshLeverage,
        "VST triggered-runner original-stop cancellation",
      );
      exactVstLongPosition(positions, name, String(remainingQuantity), positionId);
      if (!Array.isArray(orders) || orders.length !== 2) {
        throw new BingXLiveApiError(
          "VST triggered-runner recovery requires only the original and core stops",
        );
      }
      const original = orders.find((row) =>
        orderIdentifierFrom(row, "open order ID") === originalStopOrderId);
      const core = orders.find((row) =>
        orderIdentifierFrom(row, "open order ID") === coreStopOrderId);
      const exactResidualStop = (row, orderId, parentId) =>
        exactAutomatedSplitStop(row, {
          name, orderId, positionId, quantity: String(remainingQuantity),
          stopPrice: String(signalStopPrice), ...(parentId ? { entryOrderId: parentId } : {}),
        });
      if (!exactResidualStop(original, originalStopOrderId) ||
          !exactResidualStop(core, coreStopOrderId)) {
        throw new BingXLiveApiError(
          "VST triggered-runner recovery requires exact NEW residual signal-stop coverage",
        );
      }
      const runnerOrderId = runnerOrder && exactStringOrderId(runnerOrder);
      if (!runnerOrder || ![runnerStopOrderId, runnerChildOrderId].includes(runnerOrderId) ||
          runnerOrder.symbol !== name || runnerOrder.type !== "STOP_MARKET" ||
          runnerOrder.status !== "FILLED" || runnerOrder.side !== "SELL" ||
          runnerOrder.positionSide !== "LONG" ||
          runnerOrder.workingType !== "MARK_PRICE" ||
          !exactRunnerOrderQuantity(runnerOrder) ||
          !sameDecimal(runnerOrder.stopPrice, String(breakEvenPrice)) ||
          !positionIdMatches(runnerOrder, true)) {
        throw new BingXLiveApiError(
          "VST runner parent order is not an exact verified 20% BE stop fill",
        );
      }
      if (!childOrder || exactStringOrderId(childOrder) !== runnerChildOrderId ||
          childOrder.symbol !== name || childOrder.type !== "STOP_MARKET" ||
          childOrder.status !== "FILLED" || childOrder.side !== "SELL" ||
          childOrder.positionSide !== undefined && childOrder.positionSide !== "LONG" ||
          childOrder.workingType !== undefined &&
            childOrder.workingType !== "MARK_PRICE" ||
          !exactRunnerOrderQuantity(childOrder) ||
          !positionIdMatches(childOrder)) {
        throw new BingXLiveApiError(
          "VST runner child order history is not an exact lossless fill",
        );
      }
      if (!Array.isArray(fills)) {
        throw new BingXLiveApiError("VST runner fill history is unavailable");
      }
      const triggerKeys = ["triggerOrderId", "triggerOrderID"];
      if (fills.some((fill) => triggerKeys.some((key) =>
        fill?.[key] !== undefined && fill[key] !== null) &&
        exactStringFieldId(fill, triggerKeys) === null)) {
        throw new BingXLiveApiError("VST runner fill trigger identity is lossy or conflicting");
      }
      const linkedFills = fills.filter((fill) =>
        exactStringFieldId(fill, triggerKeys) === runnerStopOrderId);
      if (linkedFills.length !== 1) {
        throw new BingXLiveApiError(
          "VST runner fill history does not uniquely link to its exact parent stop",
        );
      }
      const fill = linkedFills[0];
      const fillQuantity = fill.qty ?? fill.quantity ?? fill.volume;
      const fillPrice = fill.price ?? fill.tradePrice ?? fill.fillPrice;
      const fee = fill.commission ?? fill.fee ?? fill.commissionAmount ?? fill.feeAmount;
      const feeAsset = fill.commissionAsset ?? fill.feeAsset ??
        fill.feeCurrency ?? fill.currency;
      if (exactStringOrderId(fill) !== runnerChildOrderId ||
          fill.symbol !== name || fill.side !== "SELL" ||
          fill.positionSide !== undefined && fill.positionSide !== "LONG" ||
          !positionIdMatches(fill, true, true) ||
          !sameDecimal(fillQuantity, runnerQuantity) ||
          !/^\d+(?:\.\d+)?$/.test(String(fillPrice)) ||
          !/^-?\d+(?:\.\d+)?$/.test(String(fee)) ||
          typeof feeAsset !== "string" || feeAsset.length === 0) {
        throw new BingXLiveApiError(
          "VST runner child fill is incomplete or does not exactly match the 20% close",
        );
      }
      return { fill, runnerOrder, childOrder };
    };

    await validateEvidence();
    // cancellationIntentId is the caller's durable, pre-DELETE intent. Reserve
    // it locally before any write and never retry after an unknown outcome.
    reserveStopTransferKey(submittedVstStopUpgradeIntents, intent);
    submittedTriggeredRunnerCancellationIds.add(cancelIdentity);
    await request("DELETE", PATH.order, {
      symbol: name, orderId: originalStopOrderId,
    }, { beforeSign: validateEvidence });
    const [finalOriginal, remainingOrders, cancelFills, finalPositions] =
      await Promise.all([
        queryOrder(symbol, { orderId: originalStopOrderId }),
        getOpenOrders(symbol),
        queryFills(symbol, {
          ...runnerFillQueryRange(),
          orderId: originalStopOrderId, currency: "VST",
        }),
        getPositions(symbol),
      ]);
    exactVstLongPosition(finalPositions, name, String(remainingQuantity), positionId);
    if (!finalOriginal || exactStringOrderId(finalOriginal) !== originalStopOrderId ||
        !["CANCELED", "CANCELLED"].includes(finalOriginal.status) ||
        !Array.isArray(cancelFills) || cancelFills.length !== 0 ||
        finalOriginal.executedQty !== undefined &&
          !sameDecimal(finalOriginal.executedQty, "0") ||
        remainingOrders.length !== 1 ||
        !exactAutomatedSplitStop(remainingOrders[0], {
          name, orderId: coreStopOrderId, positionId,
          quantity: String(remainingQuantity), stopPrice: String(signalStopPrice),
        })) {
      throw new BingXLiveApiError(
        "VST triggered-runner original cancellation or sole core-stop coverage is unverified",
      );
    }
    return {
      symbol: name, status: finalOriginal.status,
      canceledOriginalStopOrderId: originalStopOrderId,
      coreStopOrderId, positionId,
      remainingQuantity: String(remainingQuantity),
      runnerChildOrderId, cancellationIntentId, verified: true,
    };
  }

  async function placeVstAutomatedSplitLegStopUpgrade({
    symbol, policy, positionId, totalQuantity, leg, oldStop, otherStop,
    newStopPrice, clientOrderId, upgradeIntentId, entryOrderId, intentCreatedAt,
  }) {
    const name = requireAutomatedSplitPolicy(
      symbol, policy, "VST automated split-leg stop upgrade",
    );
    if (typeof positionId !== "string" || !positionId ||
        !["core", "runner"].includes(leg) ||
        typeof oldStop?.orderId !== "string" || !oldStop.orderId ||
        typeof otherStop?.orderId !== "string" || !otherStop.orderId ||
        oldStop.orderId === otherStop.orderId ||
        oldStop.tranche !== leg ||
        otherStop.tranche !== (leg === "core" ? "runner" : "core") ||
        typeof clientOrderId !== "string" ||
        !/^[A-Za-z0-9_-]{1,32}$/.test(clientOrderId) ||
        typeof upgradeIntentId !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(upgradeIntentId)) {
      throw new BingXLiveApiError(
        "VST stop upgrade requires exact leg IDs, unique client ID and durable phase intent",
      );
    }
    const intent = `${name}:${positionId}:${leg}:${oldStop.orderId}:${upgradeIntentId}`;
    if (submittedVstStopUpgradeIntents.has(intent) ||
        submittedClientOrderIds.has(clientOrderId)) {
      throw new BingXLiveApiError(
        "VST split-leg stop upgrade intent already submitted; reconcile, never retry",
      );
    }
    const priorClientOrder = await queryOrder(symbol, { clientOrderId });
    const priorHasId = priorClientOrder?.orderId !== undefined &&
      priorClientOrder.orderId !== null ||
      priorClientOrder?.orderID !== undefined && priorClientOrder.orderID !== null;
    if (priorHasId && exactStringOrderId(priorClientOrder) === null) {
      throw new BingXLiveApiError(
        "VST upgrade refuses a non-lossless prior client-ID order",
      );
    }
    if (priorHasId) {
      throw new BingXLiveApiError(
        "VST upgrade clientOrderId already exists; reconcile exact order before proceeding",
      );
    }
    const recoveryCreatedAt = validHistoryIntentCreatedAt(intentCreatedAt ?? clock());
    const parentId = optionalOrderIdentifier(entryOrderId, "entry order ID");
    const [filters, mode, margin, leverage, positions, orders, mark] =
      await Promise.all([
        contract(symbol), getPositionMode(), getMarginType(symbol), getLeverage(symbol),
        getPositions(symbol), getOpenOrders(symbol), getVstMarkPrice(symbol),
      ]);
    requireVstHedgeLong10(mode, margin, leverage, "VST automated split-leg stop upgrade");
    exactVstLongPosition(positions, name, String(totalQuantity), positionId);
    const ratio = leg === "core" ? 80 : 20;
    const otherRatio = leg === "core" ? 20 : 80;
    if (!decimalIsRatio(String(oldStop.quantity), String(totalQuantity), ratio, 100) ||
        !decimalIsRatio(String(otherStop.quantity), String(totalQuantity), otherRatio, 100) ||
        !sameDecimal(addDecimals(String(oldStop.quantity), String(otherStop.quantity)),
          String(totalQuantity))) {
      throw new BingXLiveApiError(
        "VST split-leg upgrade requires exact existing 80/20 position coverage",
      );
    }
    const oldPrice = String(oldStop.stopPrice);
    const nextPrice = String(newStopPrice);
    const size = String(oldStop.quantity);
    decimalAtPrecision(size, filters.quantityPrecision, "Upgraded stop quantity");
    decimalAtPrecision(nextPrice, filters.pricePrecision, "Upgraded stop price");
    if (!sameDecimal(floorQuantity(size, filters.quantityPrecision), size) ||
        positive(size, "upgraded stop quantity") < filters.minQuantity ||
        positive(size, "upgraded stop quantity") * positive(nextPrice, "upgraded stop price") <
          filters.minNotional ||
        compareDecimals(nextPrice, oldPrice, "upgraded stop price") <= 0) {
      throw new BingXLiveApiError(
        "VST split-leg upgrade must preserve exact quantity and strictly raise a contract-valid stop",
      );
    }
    freshVstMarkAbove(mark, nextPrice, "VST split-leg stop upgrade");
    const exactClientOrderId = (order) => {
      const values = ["clientOrderId", "clientOrderID"].filter((key) =>
        order?.[key] !== undefined && order[key] !== null).map((key) => order[key]);
      return values.length > 0 && values.every((value) =>
        typeof value === "string" && value === clientOrderId);
    };
    const exactStop = (order, descriptor) => exactAutomatedSplitStop(order, {
      name, orderId: descriptor.orderId, positionId,
      quantity: String(descriptor.quantity), stopPrice: String(descriptor.stopPrice),
      ...(parentId ? { entryOrderId: parentId } : {}),
    });
    const verifyActivePair = async () => {
      const [freshMode, freshMargin, freshLeverage, freshPositions,
        freshOrders, freshMark, oldFills, otherFills, oldOrder, otherOrder] =
        await Promise.all([
          getPositionMode(), getMarginType(symbol), getLeverage(symbol),
          getPositions(symbol), getOpenOrders(symbol), getVstMarkPrice(symbol),
          queryFills(symbol, {
            startTs: 1, endTs: Math.max(1, Math.floor(clock())),
            orderId: oldStop.orderId, currency: "VST",
          }),
          queryFills(symbol, {
            startTs: 1, endTs: Math.max(1, Math.floor(clock())),
            orderId: otherStop.orderId, currency: "VST",
          }),
          queryOrder(symbol, { orderId: oldStop.orderId }),
          queryOrder(symbol, { orderId: otherStop.orderId }),
        ]);
      requireVstHedgeLong10(
        freshMode, freshMargin, freshLeverage, "VST automated split-leg stop upgrade",
      );
      exactVstLongPosition(freshPositions, name, String(totalQuantity), positionId);
      freshVstMarkAbove(freshMark, nextPrice, "VST split-leg stop upgrade");
      if (!Array.isArray(freshOrders) || freshOrders.length !== 2 ||
          !Array.isArray(oldFills) || oldFills.length !== 0 ||
          !Array.isArray(otherFills) || otherFills.length !== 0 ||
          !exactVstActiveStopQuery(oldOrder, freshOrders, {
            name, orderId: oldStop.orderId, positionId,
            quantity: String(oldStop.quantity), stopPrice: String(oldStop.stopPrice),
            ...(parentId ? { entryOrderId: parentId } : {}),
          }, exactAutomatedSplitStop) ||
          !exactVstActiveStopQuery(otherOrder, freshOrders, {
            name, orderId: otherStop.orderId, positionId,
            quantity: String(otherStop.quantity), stopPrice: String(otherStop.stopPrice),
            ...(parentId ? { entryOrderId: parentId } : {}),
          }, exactAutomatedSplitStop) ||
          freshOrders.filter((row) =>
            orderIdentifierFrom(row, "open stop ID") === oldStop.orderId).length !== 1 ||
          freshOrders.filter((row) =>
            orderIdentifierFrom(row, "open stop ID") === otherStop.orderId).length !== 1 ||
          !exactStop(freshOrders.find((row) =>
            orderIdentifierFrom(row, "open stop ID") === oldStop.orderId), oldStop) ||
          !exactStop(freshOrders.find((row) =>
            orderIdentifierFrom(row, "open stop ID") === otherStop.orderId), otherStop)) {
        throw new BingXLiveApiError(
          "VST split-leg upgrade blocked: both exact original protections and zero fills are required",
        );
      }
    };
    await verifyActivePair();
    reserveStopTransferKey(submittedVstStopUpgradeIntents, intent);
    reserveStopTransferKey(submittedClientOrderIds, clientOrderId);
    const baselineIds = new Set(orders.map((row) =>
      orderIdentifierFrom(row, "open order ID")));
    const response = await request("POST", PATH.order, {
      symbol: name, side: "SELL", positionSide: "LONG", type: "STOP_MARKET",
      quantity: size, stopPrice: nextPrice, workingType: "MARK_PRICE", clientOrderId,
    }, { beforeSign: verifyActivePair });
    const responseHasId = response?.orderId !== undefined && response.orderId !== null ||
      response?.orderID !== undefined && response.orderID !== null;
    const responseId = exactStringOrderId(response);
    if (responseHasId && responseId === null) {
      throw new BingXLiveApiError(
        "VST upgrade response contains a non-lossless order ID; old stops remain active",
      );
    }
    const [freshPositions, freshOrders] = await Promise.all([
      getPositions(symbol), getOpenOrders(symbol),
    ]);
    exactVstLongPosition(freshPositions, name, String(totalQuantity), positionId);
    const candidates = freshOrders.filter((row) =>
      exactStringOrderId(row) && !baselineIds.has(exactStringOrderId(row)) &&
      exactClientOrderId(row) &&
      exactStop(row, {
        orderId: exactStringOrderId(row), quantity: size, stopPrice: nextPrice,
      }));
    const candidateId = candidates.length === 1 ? exactStringOrderId(candidates[0]) : null;
    const resolved = await queryOrderByClientIdWithExactRecovery(symbol, clientOrderId, {
      ...(candidateId ? { knownOrderId: candidateId } : {}),
      intentCreatedAt: recoveryCreatedAt,
      label: "VST split-leg upgrade",
    });
    const verifiedOrder = resolved.order;
    const newFills = await queryFills(symbol, {
      startTs: 1, endTs: Math.max(1, Math.floor(clock())),
      orderId: resolved.orderId, currency: "VST",
    });
    if (!Array.isArray(newFills) || newFills.length !== 0 ||
        freshOrders.length !== 3 || candidates.length !== 1 ||
        !exactStop(freshOrders.find((row) =>
          orderIdentifierFrom(row, "open order ID") === oldStop.orderId), oldStop) ||
        !exactStop(freshOrders.find((row) =>
          orderIdentifierFrom(row, "open order ID") === otherStop.orderId), otherStop) ||
        resolved.orderId !== candidateId ||
        (responseId && responseId !== candidateId) ||
        !exactClientOrderId(verifiedOrder) ||
        !exactVstActiveStopQuery(verifiedOrder, freshOrders, {
          name, orderId: exactStringOrderId(candidates[0]), positionId,
          quantity: size, stopPrice: nextPrice,
          ...(parentId ? { entryOrderId: parentId } : {}),
        }, exactAutomatedSplitStop)) {
      throw new BingXLiveApiError(
        "VST stop upgrade POST is uncertain; old and other stops remain untouched, reconcile exact client ID",
      );
    }
    return {
      symbol: name, positionId, totalQuantity: String(totalQuantity), leg,
      oldStop: { ...oldStop }, newStop: {
        tranche: leg, orderId: exactStringOrderId(candidates[0]),
        quantity: size, stopPrice: nextPrice, clientOrderId,
      },
      otherStop: { ...otherStop }, clientOrderId, upgradeIntentId,
      intentCreatedAt: recoveryCreatedAt, verified: true,
    };
  }

  async function cancelVstAutomatedSplitLegStopUpgrade({
    symbol, policy, positionId, totalQuantity, leg, oldStop, newStop,
    otherStop, clientOrderId, upgradeIntentId, entryOrderId,
  }) {
    const name = requireAutomatedSplitPolicy(
      symbol, policy, "VST automated split-leg old-stop cancellation",
    );
    if (typeof positionId !== "string" || !positionId ||
        !["core", "runner"].includes(leg) ||
        oldStop?.tranche !== leg || newStop?.tranche !== leg ||
        otherStop?.tranche !== (leg === "core" ? "runner" : "core") ||
        typeof oldStop?.orderId !== "string" || !oldStop.orderId ||
        typeof newStop?.orderId !== "string" || !newStop.orderId ||
        typeof otherStop?.orderId !== "string" || !otherStop.orderId ||
        new Set([oldStop.orderId, newStop.orderId, otherStop.orderId]).size !== 3 ||
        typeof clientOrderId !== "string" ||
        !/^[A-Za-z0-9_-]{1,32}$/.test(clientOrderId) ||
        newStop.clientOrderId !== clientOrderId ||
        typeof upgradeIntentId !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(upgradeIntentId)) {
      throw new BingXLiveApiError(
        "VST old-stop cancellation requires the exact persisted two-phase upgrade evidence",
      );
    }
    const intent = `${name}:${positionId}:${leg}:${oldStop.orderId}:${upgradeIntentId}:cancel`;
    if (submittedVstStopUpgradeIntents.has(intent)) {
      throw new BingXLiveApiError(
        "VST old-stop cancellation already submitted; reconcile, never retry",
      );
    }
    const exactClientOrderId = (order) => {
      const values = ["clientOrderId", "clientOrderID"].filter((key) =>
        order?.[key] !== undefined && order[key] !== null).map((key) => order[key]);
      return values.length > 0 && values.every((value) =>
        typeof value === "string" && value === clientOrderId);
    };
    const parentId = optionalOrderIdentifier(entryOrderId, "entry order ID");
    const exactStop = (order, descriptor) => exactAutomatedSplitStop(order, {
      name, orderId: descriptor.orderId, positionId,
      quantity: String(descriptor.quantity), stopPrice: String(descriptor.stopPrice),
      ...(parentId ? { entryOrderId: parentId } : {}),
    });
    const verifyBeforeCancel = async () => {
      const [mode, margin, leverage, positions, orders, oldOrder, newOrder,
        otherOrder, oldFills, newFills, otherFills] = await Promise.all([
        getPositionMode(), getMarginType(symbol), getLeverage(symbol),
        getPositions(symbol), getOpenOrders(symbol),
        queryOrder(symbol, { orderId: oldStop.orderId }),
        queryOrder(symbol, { orderId: newStop.orderId }),
        queryOrder(symbol, { orderId: otherStop.orderId }),
        queryFills(symbol, {
          startTs: 1, endTs: Math.max(1, Math.floor(clock())),
          orderId: oldStop.orderId, currency: "VST",
        }),
        queryFills(symbol, {
          startTs: 1, endTs: Math.max(1, Math.floor(clock())),
          orderId: newStop.orderId, currency: "VST",
        }),
        queryFills(symbol, {
          startTs: 1, endTs: Math.max(1, Math.floor(clock())),
          orderId: otherStop.orderId, currency: "VST",
        }),
      ]);
      requireVstHedgeLong10(
        mode, margin, leverage, "VST automated split-leg old-stop cancellation",
      );
      exactVstLongPosition(positions, name, String(totalQuantity), positionId);
      const ratio = leg === "core" ? 80 : 20;
      const otherRatio = leg === "core" ? 20 : 80;
      if (!decimalIsRatio(String(oldStop.quantity), String(totalQuantity), ratio, 100) ||
          !decimalIsRatio(String(newStop.quantity), String(totalQuantity), ratio, 100) ||
          !decimalIsRatio(String(otherStop.quantity), String(totalQuantity), otherRatio, 100) ||
          !sameDecimal(String(oldStop.quantity), String(newStop.quantity)) ||
          compareDecimals(String(newStop.stopPrice), String(oldStop.stopPrice)) <= 0 ||
          !sameDecimal(addDecimals(String(newStop.quantity), String(otherStop.quantity)),
            String(totalQuantity)) ||
          !Array.isArray(orders) || orders.length !== 3 ||
          ![oldFills, newFills, otherFills].every((fills) =>
            Array.isArray(fills) && fills.length === 0) ||
          !exactVstActiveStopQuery(oldOrder, orders, {
            name, orderId: oldStop.orderId, positionId,
            quantity: String(oldStop.quantity), stopPrice: String(oldStop.stopPrice),
            ...(parentId ? { entryOrderId: parentId } : {}),
          }, exactAutomatedSplitStop) ||
          !exactVstActiveStopQuery(newOrder, orders, {
            name, orderId: newStop.orderId, positionId,
            quantity: String(newStop.quantity), stopPrice: String(newStop.stopPrice),
            ...(parentId ? { entryOrderId: parentId } : {}),
          }, exactAutomatedSplitStop) ||
          !exactVstActiveStopQuery(otherOrder, orders, {
            name, orderId: otherStop.orderId, positionId,
            quantity: String(otherStop.quantity), stopPrice: String(otherStop.stopPrice),
            ...(parentId ? { entryOrderId: parentId } : {}),
          }, exactAutomatedSplitStop) ||
          !exactClientOrderId(newOrder) ||
          !orders.every((row) => [
            oldStop.orderId, newStop.orderId, otherStop.orderId,
          ].includes(orderIdentifierFrom(row, "open stop ID"))) ||
          ![oldStop, newStop, otherStop].every((stop) =>
            orders.filter((row) => orderIdentifierFrom(row, "open stop ID") === stop.orderId)
              .length === 1 &&
            exactStop(orders.find((row) =>
              orderIdentifierFrom(row, "open stop ID") === stop.orderId), stop))) {
        throw new BingXLiveApiError(
          "VST old stop remains active: exact new leg and other protection, same position and no fills are required",
        );
      }
    };
    await verifyBeforeCancel();
    reserveStopTransferKey(submittedVstStopUpgradeIntents, intent);
    await request("DELETE", PATH.order, {
      symbol: name, orderId: oldStop.orderId,
    }, { beforeSign: verifyBeforeCancel });
    const [finalOld, remainingOrders, cancelFills, positions] = await Promise.all([
      queryOrder(symbol, { orderId: oldStop.orderId }),
      getOpenOrders(symbol),
      queryFills(symbol, {
        startTs: 1, endTs: Math.max(1, Math.floor(clock())),
        orderId: oldStop.orderId, currency: "VST",
      }),
      getPositions(symbol),
    ]);
    exactVstLongPosition(positions, name, String(totalQuantity), positionId);
    if (!finalOld || orderIdentifierFrom(finalOld) !== oldStop.orderId ||
        !["CANCELED", "CANCELLED"].includes(finalOld.status) ||
        !Array.isArray(cancelFills) || cancelFills.length !== 0 ||
        finalOld.executedQty !== undefined && !sameDecimal(finalOld.executedQty, "0") ||
        remainingOrders.length !== 2 ||
        ![newStop, otherStop].every((stop) =>
          remainingOrders.filter((row) =>
            orderIdentifierFrom(row, "open stop ID") === stop.orderId).length === 1 &&
          exactStop(remainingOrders.find((row) =>
            orderIdentifierFrom(row, "open stop ID") === stop.orderId), stop))) {
      throw new BingXLiveApiError(
        "VST old-stop cancellation is ambiguous or final upgraded protection is not exact",
      );
    }
    return {
      symbol: name, status: finalOld.status, canceledStopOrderId: oldStop.orderId,
      activeUpgradedStop: newStop, activeOtherStop: otherStop,
      positionId, quantity: String(totalQuantity), upgradeIntentId, verified: true,
    };
  }

  async function closeVstAutomatedSoleSplitLeg({
    symbol, policy, positionId, quantity, stop, clientOrderId, closeIntentId,
    intentCreatedAt,
  }) {
    const name = requireAutomatedSplitPolicy(
      symbol, policy, "VST automated sole split-leg close",
    );
    if (typeof positionId !== "string" || !positionId ||
        !["core", "runner"].includes(stop?.tranche) ||
        typeof stop?.orderId !== "string" || !stop.orderId ||
        typeof clientOrderId !== "string" ||
        !/^[A-Za-z0-9_-]{1,32}$/.test(clientOrderId) ||
        typeof closeIntentId !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(closeIntentId)) {
      throw new BingXLiveApiError(
        "VST sole-leg close requires exact position/stop IDs and unique durable close intent",
      );
    }
    const intent = `${name}:${positionId}:${stop.orderId}:sole-leg-close:${closeIntentId}`;
    const closeIdentity = `${name}:${positionId}:${stop.orderId}:sole-leg-close`;
    if (submittedVstStopUpgradeIntents.has(intent) ||
        submittedTriggeredRunnerCancellationIds.has(closeIdentity) ||
        submittedClientOrderIds.has(clientOrderId)) {
      throw new BingXLiveApiError(
        "VST sole-leg close intent already submitted; reconcile, never retry",
      );
    }
    const priorClientOrder = await queryOrder(symbol, { clientOrderId });
    const priorHasId = priorClientOrder?.orderId !== undefined &&
      priorClientOrder.orderId !== null ||
      priorClientOrder?.orderID !== undefined && priorClientOrder.orderID !== null;
    if (priorHasId && exactStringOrderId(priorClientOrder) === null) {
      throw new BingXLiveApiError(
        "VST sole-leg close refuses a non-lossless prior client-ID order",
      );
    }
    if (priorHasId) {
      throw new BingXLiveApiError(
        "VST sole-leg close clientOrderId already exists; reconcile before any MARKET submission",
      );
    }
    const recoveryCreatedAt = validHistoryIntentCreatedAt(intentCreatedAt ?? clock());
    const exactClientOrderId = (order) => {
      const values = ["clientOrderId", "clientOrderID"].filter((key) =>
        order?.[key] !== undefined && order[key] !== null).map((key) => order[key]);
      return values.length > 0 && values.every((value) =>
        typeof value === "string" && value === clientOrderId);
    };
    const [filters, mode, margin, leverage, positions, orders] = await Promise.all([
      contract(symbol), getPositionMode(), getMarginType(symbol), getLeverage(symbol),
      getPositions(symbol), getOpenOrders(symbol),
    ]);
    requireVstHedgeLong10(mode, margin, leverage, "VST automated sole split-leg close");
    exactVstLongPosition(positions, name, String(quantity), positionId);
    const size = floorQuantity(String(quantity), filters.quantityPrecision);
    if (!sameDecimal(size, String(quantity)) ||
        positive(size, "sole-leg close quantity") < filters.minQuantity ||
        positive(size, "sole-leg close quantity") *
          positive(String(stop.stopPrice), "sole-leg stop price") < filters.minNotional ||
        !exactAutomatedSplitStop(orders[0], {
          name, orderId: stop.orderId, positionId,
          quantity: size, stopPrice: String(stop.stopPrice),
        }) || orders.length !== 1) {
      throw new BingXLiveApiError(
        "VST sole-leg close requires the exact full-position quantity and one exact protective stop",
      );
    }
    decimalAtPrecision(String(stop.stopPrice), filters.pricePrecision, "Sole-leg stop price");
    const preflight = async () => {
      const [freshMode, freshMargin, freshLeverage, freshPositions, freshOrders, freshStopFills] =
        await Promise.all([
          getPositionMode(), getMarginType(symbol), getLeverage(symbol),
          getPositions(symbol), getOpenOrders(symbol),
          queryFills(symbol, {
            startTs: 1, endTs: Math.max(1, Math.floor(clock())),
            orderId: stop.orderId, currency: "VST",
          }),
        ]);
      requireVstHedgeLong10(
        freshMode, freshMargin, freshLeverage, "VST automated sole split-leg close",
      );
      exactVstLongPosition(freshPositions, name, size, positionId);
      if (!Array.isArray(freshOrders) || freshOrders.length !== 1 ||
          !exactAutomatedSplitStop(freshOrders[0], {
            name, orderId: stop.orderId, positionId,
            quantity: size, stopPrice: String(stop.stopPrice),
          }) || !Array.isArray(freshStopFills) || freshStopFills.length !== 0) {
        throw new BingXLiveApiError(
          "VST sole-leg close blocked: exact remaining stop and no stop fills are required",
        );
      }
    };
    await preflight();
    submittedVstStopUpgradeIntents.add(intent);
    submittedTriggeredRunnerCancellationIds.add(closeIdentity);
    submittedClientOrderIds.add(clientOrderId);
    const response = await request("POST", PATH.order, {
      symbol: name, side: "SELL", positionSide: "LONG", type: "MARKET",
      quantity: size, clientOrderId,
    }, { beforeSign: preflight });
    const responseHasId = response?.orderId !== undefined && response.orderId !== null ||
      response?.orderID !== undefined && response.orderID !== null;
    const responseId = exactStringOrderId(response);
    if (responseHasId && responseId === null) {
      throw new BingXLiveApiError(
        "VST sole-leg MARKET response contains a non-lossless order ID; reconcile manually",
      );
    }
    const resolvedMarketOrder = await queryOrderByClientIdWithExactRecovery(
      symbol, clientOrderId, {
        ...(responseId ? { knownOrderId: responseId } : {}),
        intentCreatedAt: recoveryCreatedAt, label: "VST sole-leg MARKET close",
      },
    );
    let closeOrderId = resolvedMarketOrder.orderId;
    const marketOrder = resolvedMarketOrder.order;
    if (!marketOrder || exactStringOrderId(marketOrder) === null ||
        marketOrder.symbol !== name || marketOrder.type !== "MARKET" ||
        marketOrder.status !== "FILLED" || marketOrder.side !== "SELL" ||
        marketOrder.positionSide !== "LONG" ||
        !exactClientOrderId(marketOrder) ||
        !sameDecimal(marketOrder.origQty, size) ||
        !sameDecimal(marketOrder.executedQty, size)) {
      throw new BingXLiveApiError(
        "VST sole-leg MARKET close is uncertain or not exactly FILLED; stop remains untouched",
      );
    }
    closeOrderId = exactStringOrderId(marketOrder);
    const fills = await queryFills(symbol, {
      startTs: 1, endTs: Math.max(1, Math.floor(clock())),
      orderId: closeOrderId, currency: "VST",
    });
    const fillIds = fills.map((fill) => {
      const keys = ["tradeId", "tradeID", "fillId", "fillID", "id"];
      const values = keys.filter((key) =>
        fill?.[key] !== undefined && fill[key] !== null).map((key) => fill[key]);
      return values.length && values.every((value) =>
        typeof value === "string" && value.trim() !== "") &&
        new Set(values).size === 1 ? values[0] : null;
    });
    const fillQuantity = fills.reduce((sum, fill) =>
      addDecimals(sum, String(fill.qty ?? fill.quantity ?? fill.volume)), "0");
    const feeRows = fills.map((fill, index) => ({
      fillId: fillIds[index],
      amount: fill.commission ?? fill.fee ?? fill.commissionAmount ?? fill.feeAmount,
      asset: fill.commissionAsset ?? fill.feeAsset ?? fill.feeCurrency ?? fill.currency,
    }));
    if (!Array.isArray(fills) || !fills.length ||
        fillIds.some((id) => !id) || new Set(fillIds).size !== fillIds.length ||
        fills.some((fill) => fill.symbol !== name ||
          exactStringOrderId(fill) !== closeOrderId || fill.side !== "SELL" ||
          fill.positionSide !== undefined && fill.positionSide !== "LONG" ||
          !/^\d+(?:\.\d+)?$/.test(String(fill.price ?? fill.tradePrice ?? fill.fillPrice)) ||
          !/^-?\d+(?:\.\d+)?$/.test(String(
            fill.commission ?? fill.fee ?? fill.commissionAmount ?? fill.feeAmount,
          )) ||
          typeof (fill.commissionAsset ?? fill.feeAsset ??
            fill.feeCurrency ?? fill.currency) !== "string" ||
          !(fill.commissionAsset ?? fill.feeAsset ?? fill.feeCurrency ?? fill.currency)) ||
        !sameDecimal(fillQuantity, size)) {
      throw new BingXLiveApiError(
        "VST sole-leg MARKET fill quantities or independently reported fees are incomplete",
      );
    }
    const [afterPositions, afterOrders] = await Promise.all([
      getPositions(symbol), getOpenOrders(symbol),
    ]);
    requireFlatSymbol(afterPositions, name);
    const [currentStop] = afterOrders;
    const stopQuery = await queryOrder(symbol, { orderId: stop.orderId });
    const stopAlreadyCanceled = afterOrders.length === 0 &&
      stopQuery?.symbol === name && orderIdentifierFrom(stopQuery) === stop.orderId &&
      ["CANCELED", "CANCELLED"].includes(stopQuery.status) &&
      stopQuery.type === "STOP_MARKET" && stopQuery.side === "SELL" &&
      stopQuery.positionSide === "LONG" && stopQuery.workingType === "MARK_PRICE" &&
      sameDecimal(stopQuery.origQty, size) &&
      sameDecimal(stopQuery.stopPrice, String(stop.stopPrice)) &&
      orderIdentifier(stopQuery.positionId ?? stopQuery.positionID, "stop position ID") ===
        positionId &&
      (stopQuery.executedQty === undefined ||
        sameDecimal(stopQuery.executedQty, "0"));
    if (!stopAlreadyCanceled && (afterOrders.length !== 1 ||
        !exactAutomatedSplitStop(currentStop, {
          name, orderId: stop.orderId, positionId,
          quantity: size, stopPrice: String(stop.stopPrice),
        }) || !exactVstActiveStopQuery(stopQuery, afterOrders, {
          name, orderId: stop.orderId, positionId,
          quantity: size, stopPrice: String(stop.stopPrice),
        }, exactAutomatedSplitStop))) {
      throw new BingXLiveApiError(
        "VST MARKET fill is verified but flat-position stop cleanup is blocked by changed protection state",
      );
    }
    const flatAndExactStop = async () => {
      const [freshPositions, freshOrders, queriedStop] = await Promise.all([
        getPositions(symbol), getOpenOrders(symbol),
        queryOrder(symbol, { orderId: stop.orderId }),
      ]);
      requireFlatSymbol(freshPositions, name);
      const freshStopFills = await queryFills(symbol, {
        startTs: 1, endTs: Math.max(1, Math.floor(clock())),
        orderId: stop.orderId, currency: "VST",
      });
      if (freshOrders.length !== 1 || !Array.isArray(freshStopFills) ||
          freshStopFills.length !== 0 ||
          !exactAutomatedSplitStop(freshOrders[0], {
            name, orderId: stop.orderId, positionId,
            quantity: size, stopPrice: String(stop.stopPrice),
          }) || !exactVstActiveStopQuery(queriedStop, freshOrders, {
            name, orderId: stop.orderId, positionId,
            quantity: size, stopPrice: String(stop.stopPrice),
          }, exactAutomatedSplitStop)) {
        throw new BingXLiveApiError(
          "VST protective stop will not be canceled unless the exact position is flat",
        );
      }
    };
    const stopFills = await queryFills(symbol, {
      startTs: 1, endTs: Math.max(1, Math.floor(clock())),
      orderId: stop.orderId, currency: "VST",
    });
    if (!Array.isArray(stopFills) || stopFills.length !== 0) {
      throw new BingXLiveApiError(
        "VST MARKET close is verified but stop cleanup is blocked by stop fill evidence",
      );
    }
    if (!stopAlreadyCanceled) {
      await request("DELETE", PATH.order, {
        symbol: name, orderId: stop.orderId,
      }, { beforeSign: flatAndExactStop });
    }
    const [finalClose, finalStop, finalOrders, finalStopFills, finalPositions] =
      await Promise.all([
        queryOrder(symbol, { orderId: closeOrderId }),
        queryOrder(symbol, { orderId: stop.orderId }),
        getOpenOrders(symbol),
        queryFills(symbol, {
          startTs: 1, endTs: Math.max(1, Math.floor(clock())),
          orderId: stop.orderId, currency: "VST",
        }),
        getPositions(symbol),
      ]);
    requireFlatSymbol(finalPositions, name);
    if (!finalClose || exactStringOrderId(finalClose) !== closeOrderId ||
        finalClose.status !== "FILLED" ||
        !exactClientOrderId(finalClose) ||
        !sameDecimal(finalClose.origQty, size) ||
        !sameDecimal(finalClose.executedQty, size) ||
        !finalStop || exactStringOrderId(finalStop) !== stop.orderId ||
        !["CANCELED", "CANCELLED"].includes(finalStop.status) ||
        finalStop.executedQty !== undefined && !sameDecimal(finalStop.executedQty, "0") ||
        !Array.isArray(finalStopFills) || finalStopFills.length !== 0 ||
        finalOrders.length !== 0) {
      throw new BingXLiveApiError(
        "VST sole-leg close or flat/no-stop final recovery evidence is incomplete",
      );
    }
    return {
      symbol: name, positionId, closedQuantity: size, closeOrderId,
      clientOrderId, closeIntentId, intentCreatedAt: recoveryCreatedAt,
      fills, fees: feeRows,
      canceledStopOrderId: stop.orderId, status: finalClose.status,
      flat: true, noOpenStops: true, verified: true,
    };
  }

  async function closeVstAutomatedFullSplitPosition({
    symbol, policy, positionId, totalQuantity, coreStop, runnerStop,
    clientOrderId, closeIntentId, intentCreatedAt,
  }) {
    const name = requireAutomatedSplitPolicy(
      symbol, policy, "VST automated full split-position close",
    );
    if (typeof positionId !== "string" || !positionId ||
        typeof coreStop?.orderId !== "string" || !coreStop.orderId ||
        typeof runnerStop?.orderId !== "string" || !runnerStop.orderId ||
        coreStop.orderId === runnerStop.orderId ||
        typeof clientOrderId !== "string" ||
        !/^[A-Za-z0-9_-]{1,32}$/.test(clientOrderId) ||
        typeof closeIntentId !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(closeIntentId)) {
      throw new BingXLiveApiError(
        "VST full split close requires exact persisted position/stops and unique durable close intent",
      );
    }
    const intent = `${name}:${positionId}:full-split-close:${closeIntentId}`;
    const closeIdentity = `${name}:${positionId}:full-split-close`;
    if (submittedVstStopUpgradeIntents.has(intent) ||
        submittedTriggeredRunnerCancellationIds.has(closeIdentity) ||
        submittedClientOrderIds.has(clientOrderId)) {
      throw new BingXLiveApiError(
        "VST full split close intent already submitted; reconcile, never retry",
      );
    }
    const priorClientOrder = await queryOrder(symbol, { clientOrderId });
    const priorHasId = priorClientOrder?.orderId !== undefined &&
      priorClientOrder.orderId !== null ||
      priorClientOrder?.orderID !== undefined && priorClientOrder.orderID !== null;
    if (priorHasId && exactStringOrderId(priorClientOrder) === null) {
      throw new BingXLiveApiError(
        "VST full split close refuses a non-lossless prior client-ID order",
      );
    }
    if (priorHasId) {
      throw new BingXLiveApiError(
        "VST full split close clientOrderId already exists; reconcile before MARKET submission",
      );
    }
    const recoveryCreatedAt = validHistoryIntentCreatedAt(intentCreatedAt ?? clock());
    const stops = [coreStop, runnerStop];
    const [filters, mode, margin, leverage, positions, orders] = await Promise.all([
      contract(symbol), getPositionMode(), getMarginType(symbol), getLeverage(symbol),
      getPositions(symbol), getOpenOrders(symbol),
    ]);
    requireVstHedgeLong10(mode, margin, leverage, "VST automated full split close");
    exactVstLongPosition(positions, name, String(totalQuantity), positionId);
    const size = floorQuantity(String(totalQuantity), filters.quantityPrecision);
    if (!sameDecimal(size, String(totalQuantity)) ||
        positive(size, "full split close quantity") < filters.minQuantity) {
      throw new BingXLiveApiError(
        "VST full split close quantity is not exact contract precision or minimum size",
      );
    }
    const exactStop = (row, stop) => exactAutomatedSplitStop(row, {
      name, orderId: stop.orderId, positionId,
      quantity: String(stop.quantity), stopPrice: String(stop.stopPrice),
    });
    if (!decimalIsRatio(String(coreStop.quantity), size, 80, 100) ||
        !decimalIsRatio(String(runnerStop.quantity), size, 20, 100) ||
        !sameDecimal(addDecimals(String(coreStop.quantity), String(runnerStop.quantity)), size) ||
        stops.some((stop) => !["core", "runner"].includes(stop.tranche)) ||
        coreStop.tranche !== "core" || runnerStop.tranche !== "runner" ||
        orders.length !== 2 ||
        stops.some((stop) => orders.filter((row) =>
          orderIdentifierFrom(row, "open split stop ID") === stop.orderId).length !== 1 ||
          !exactStop(orders.find((row) =>
            orderIdentifierFrom(row, "open split stop ID") === stop.orderId), stop))) {
      throw new BingXLiveApiError(
        "VST full split close requires exact 80/20 active stops and no foreign orders",
      );
    }
    const verifyBeforeMarket = async () => {
      const [freshMode, freshMargin, freshLeverage, freshPositions, freshOrders,
        coreFills, runnerFills] = await Promise.all([
        getPositionMode(), getMarginType(symbol), getLeverage(symbol),
        getPositions(symbol), getOpenOrders(symbol),
        queryFills(symbol, {
          startTs: 1, endTs: Math.max(1, Math.floor(clock())),
          orderId: coreStop.orderId, currency: "VST",
        }),
        queryFills(symbol, {
          startTs: 1, endTs: Math.max(1, Math.floor(clock())),
          orderId: runnerStop.orderId, currency: "VST",
        }),
      ]);
      requireVstHedgeLong10(
        freshMode, freshMargin, freshLeverage, "VST automated full split close",
      );
      exactVstLongPosition(freshPositions, name, size, positionId);
      if (freshOrders.length !== 2 ||
          ![coreFills, runnerFills].every((fills) =>
            Array.isArray(fills) && fills.length === 0) ||
          stops.some((stop) => freshOrders.filter((row) =>
            orderIdentifierFrom(row, "open split stop ID") === stop.orderId).length !== 1 ||
            !exactStop(freshOrders.find((row) =>
              orderIdentifierFrom(row, "open split stop ID") === stop.orderId), stop))) {
        throw new BingXLiveApiError(
          "VST full split close blocked: exact full position, both stops, and zero stop fills are required",
        );
      }
    };
    await verifyBeforeMarket();
    submittedVstStopUpgradeIntents.add(intent);
    submittedTriggeredRunnerCancellationIds.add(closeIdentity);
    submittedClientOrderIds.add(clientOrderId);
    const response = await request("POST", PATH.order, {
      symbol: name, side: "SELL", positionSide: "LONG", type: "MARKET",
      quantity: size, clientOrderId,
    }, { beforeSign: verifyBeforeMarket });
    const responseHasId = response?.orderId !== undefined && response.orderId !== null ||
      response?.orderID !== undefined && response.orderID !== null;
    const responseId = exactStringOrderId(response);
    if (responseHasId && responseId === null) {
      throw new BingXLiveApiError(
        "VST full split MARKET response contains a non-lossless order ID; reconcile manually",
      );
    }
    const resolvedMarketOrder = await queryOrderByClientIdWithExactRecovery(
      symbol, clientOrderId, {
        ...(responseId ? { knownOrderId: responseId } : {}),
        intentCreatedAt: recoveryCreatedAt, label: "VST full split MARKET close",
      },
    );
    let closeOrderId = resolvedMarketOrder.orderId;
    const marketOrder = resolvedMarketOrder.order;
    const exactClientOrderId = (row) => {
      const values = ["clientOrderId", "clientOrderID"].filter((key) =>
        row?.[key] !== undefined && row[key] !== null).map((key) => row[key]);
      return values.length > 0 && values.every((value) =>
        typeof value === "string" && value === clientOrderId);
    };
    if (!marketOrder || exactStringOrderId(marketOrder) === null ||
        closeOrderId && exactStringOrderId(marketOrder) !== closeOrderId ||
        marketOrder.symbol !== name || marketOrder.type !== "MARKET" ||
        marketOrder.status !== "FILLED" || marketOrder.side !== "SELL" ||
        marketOrder.positionSide !== "LONG" || !exactClientOrderId(marketOrder) ||
        !sameDecimal(marketOrder.origQty, size) ||
        !sameDecimal(marketOrder.executedQty, size)) {
      throw new BingXLiveApiError(
        "VST full split MARKET close is uncertain or not exactly FILLED; protective stops remain untouched",
      );
    }
    closeOrderId = exactStringOrderId(marketOrder);
    const fills = await queryFills(symbol, {
      startTs: 1, endTs: Math.max(1, Math.floor(clock())),
      orderId: closeOrderId, currency: "VST",
    });
    const fillId = (fill) => {
      const keys = ["tradeId", "tradeID", "fillId", "fillID", "id"];
      const values = keys.filter((key) =>
        fill?.[key] !== undefined && fill[key] !== null).map((key) => fill[key]);
      return values.length && values.every((value) =>
        typeof value === "string" && value.trim() !== "") &&
        new Set(values).size === 1 ? values[0] : null;
    };
    const fillIds = fills.map(fillId);
    const filledQuantity = fills.reduce((sum, fill) =>
      addDecimals(sum, String(fill.qty ?? fill.quantity ?? fill.volume)), "0");
    const fees = fills.map((fill, index) => ({
      fillId: fillIds[index],
      amount: fill.commission ?? fill.fee ?? fill.commissionAmount ?? fill.feeAmount,
      asset: fill.commissionAsset ?? fill.feeAsset ?? fill.feeCurrency ?? fill.currency,
    }));
    if (!Array.isArray(fills) || !fills.length ||
        fillIds.some((id) => !id) || new Set(fillIds).size !== fillIds.length ||
        fills.some((fill) => fill.symbol !== name ||
          exactStringOrderId(fill) !== closeOrderId || fill.side !== "SELL" ||
          fill.positionSide !== undefined && fill.positionSide !== "LONG" ||
          !/^\d+(?:\.\d+)?$/.test(String(fill.price ?? fill.tradePrice ?? fill.fillPrice)) ||
          !/^-?\d+(?:\.\d+)?$/.test(String(
            fill.commission ?? fill.fee ?? fill.commissionAmount ?? fill.feeAmount,
          )) ||
          typeof (fill.commissionAsset ?? fill.feeAsset ??
            fill.feeCurrency ?? fill.currency) !== "string" ||
          !(fill.commissionAsset ?? fill.feeAsset ?? fill.feeCurrency ?? fill.currency)) ||
        !sameDecimal(filledQuantity, size)) {
      throw new BingXLiveApiError(
        "VST full split MARKET fill quantities or independently reported fees are incomplete",
      );
    }
    const [flatPositions, openAfterClose] = await Promise.all([
      getPositions(symbol), getOpenOrders(symbol),
    ]);
    requireFlatSymbol(flatPositions, name);
    const stopIds = new Set(stops.map((stop) => stop.orderId));
    if (!Array.isArray(openAfterClose) ||
        openAfterClose.some((order) =>
          !stopIds.has(orderIdentifierFrom(order, "remaining known stop ID")))) {
      throw new BingXLiveApiError(
        "VST full split close is filled and flat, but a foreign open order blocks stop recovery",
      );
    }
    const finalStops = await Promise.all(stops.map(async (stop) => {
      const [queried, stopFills] = await Promise.all([
        queryOrder(symbol, { orderId: stop.orderId }),
        queryFills(symbol, {
          startTs: 1, endTs: Math.max(1, Math.floor(clock())),
          orderId: stop.orderId, currency: "VST",
        }),
      ]);
      const activeRows = openAfterClose.filter((row) =>
        orderIdentifierFrom(row, "open split stop ID") === stop.orderId);
      if (!Array.isArray(stopFills) || stopFills.length !== 0 ||
          activeRows.length > 1 ||
          activeRows.length === 1 &&
            (!exactStop(activeRows[0], stop) ||
              !exactVstActiveStopQuery(queried, openAfterClose, {
                name, orderId: stop.orderId, positionId,
                quantity: String(stop.quantity), stopPrice: String(stop.stopPrice),
              }, exactAutomatedSplitStop)) ||
          activeRows.length === 0 &&
            (!queried || exactStringOrderId(queried) !== stop.orderId ||
              !["CANCELED", "CANCELLED"].includes(queried.status) ||
              queried.symbol !== name || queried.type !== "STOP_MARKET" ||
              queried.side !== "SELL" || queried.positionSide !== "LONG" ||
              queried.workingType !== "MARK_PRICE" ||
              !sameDecimal(queried.origQty, String(stop.quantity)) ||
              !sameDecimal(queried.stopPrice, String(stop.stopPrice)) ||
              orderIdentifier(queried.positionId ?? queried.positionID, "stop position ID") !==
                positionId ||
              queried.executedQty !== undefined &&
                !sameDecimal(queried.executedQty, "0"))) {
        throw new BingXLiveApiError(
          "VST full split close cannot establish exact active-or-canceled stop recovery evidence",
        );
      }
      return { stop, queried, active: activeRows.length === 1 };
    }));
    const remainingKnownStopOrderIds = finalStops.filter((item) => item.active)
      .map((item) => item.stop.orderId);
    const [finalClose, finalCloseFills, finalPositions, finalOrders] = await Promise.all([
      queryOrder(symbol, { orderId: closeOrderId }),
      queryFills(symbol, {
        startTs: 1, endTs: Math.max(1, Math.floor(clock())),
        orderId: closeOrderId, currency: "VST",
      }),
      getPositions(symbol), getOpenOrders(symbol),
    ]);
    requireFlatSymbol(finalPositions, name);
    if (!finalClose || exactStringOrderId(finalClose) !== closeOrderId ||
        finalClose.status !== "FILLED" || !exactClientOrderId(finalClose) ||
        !sameDecimal(finalClose.origQty, size) ||
        !sameDecimal(finalClose.executedQty, size) ||
        !Array.isArray(finalCloseFills) || finalCloseFills.length !== fills.length ||
        finalCloseFills.some((fill) => !fillIds.includes(fillId(fill))) ||
        finalOrders.some((row) => !stopIds.has(orderIdentifierFrom(row, "final known stop ID"))) ||
        new Set(finalOrders.map((row) =>
          orderIdentifierFrom(row, "final known stop ID"))).size !== finalOrders.length ||
        JSON.stringify(finalOrders.map((row) =>
          orderIdentifierFrom(row, "final known stop ID")).sort()) !==
          JSON.stringify(remainingKnownStopOrderIds.slice().sort()) ||
        finalOrders.some((row) => {
          const stop = stops.find((item) =>
            item.orderId === orderIdentifierFrom(row, "final known stop ID"));
          return !stop || !exactStop(row, stop);
        })) {
      throw new BingXLiveApiError(
        "VST full split close final MARKET fill or flat-position evidence changed",
      );
    }
    return {
      symbol: name, positionId, closedQuantity: size, closeOrderId, clientOrderId,
      closeIntentId, intentCreatedAt: recoveryCreatedAt, fills, fees, flat: true,
      remainingKnownStopOrderIds,
      fullyCleaned: remainingKnownStopOrderIds.length === 0,
      stopCleanupRequired: remainingKnownStopOrderIds.length > 0,
      verified: true,
    };
  }

  async function closeVstAutomatedPreRunnerSplit({
    symbol, policy, positionId, totalQuantity, originalStop, coreStop,
    clientOrderId, closeIntentId, intentCreatedAt,
  }) {
    const name = requireAutomatedSplitPolicy(
      symbol, policy, "VST automated pre-runner split close",
    );
    if (typeof positionId !== "string" || !positionId ||
        typeof originalStop?.orderId !== "string" || !originalStop.orderId ||
        typeof coreStop?.orderId !== "string" || !coreStop.orderId ||
        originalStop.orderId === coreStop.orderId ||
        typeof clientOrderId !== "string" ||
        !/^[A-Za-z0-9_-]{1,32}$/.test(clientOrderId) ||
        typeof closeIntentId !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(closeIntentId)) {
      throw new BingXLiveApiError(
        "VST pre-runner close requires exact persisted position/stops and unique durable close intent",
      );
    }
    const intent = `${name}:${positionId}:pre-runner-split-close:${closeIntentId}`;
    const closeIdentity = `${name}:${positionId}:pre-runner-split-close`;
    if (submittedVstStopUpgradeIntents.has(intent) ||
        submittedTriggeredRunnerCancellationIds.has(closeIdentity) ||
        submittedClientOrderIds.has(clientOrderId)) {
      throw new BingXLiveApiError(
        "VST pre-runner close intent already submitted; reconcile, never retry",
      );
    }
    let marketMutationStarted = false;
    let priorClientOrder;
    try {
      priorClientOrder = await queryOrder(symbol, { clientOrderId });
    } catch (error) {
      setPreRunnerCloseNoMutationProvenance(error);
      throw error;
    }
    const priorHasId = priorClientOrder?.orderId !== undefined &&
      priorClientOrder.orderId !== null ||
      priorClientOrder?.orderID !== undefined && priorClientOrder.orderID !== null;
    if (priorHasId && exactStringOrderId(priorClientOrder) === null) {
      throw new BingXLiveApiError(
        "VST pre-runner close refuses a non-lossless prior client-ID order",
      );
    }
    if (priorHasId) {
      throw new BingXLiveApiError(
        "VST pre-runner close clientOrderId already exists; reconcile before MARKET submission",
      );
    }
    let recoveryCreatedAt;
    let stops;
    let size;
    let exactStop;
    let verifyBeforeMarket;
    const linkedStopEntryParentId = (row) => {
      try {
        const values = [row?.mainOrderId, row?.parentOrderId]
          .filter((value) => value !== undefined && value !== null && value !== "");
        if (!values.length) return null;
        const ids = values.map((value) =>
          orderIdentifier(value, "active stop entry parent ID"));
        return new Set(ids).size === 1 ? ids[0] : null;
      } catch {
        return null;
      }
    };
    try {
      recoveryCreatedAt = validHistoryIntentCreatedAt(intentCreatedAt ?? clock());
      stops = [originalStop, coreStop];
      const [filters, mode, margin, leverage, positions, orders] = await Promise.all([
        contract(symbol), getPositionMode(), getMarginType(symbol), getLeverage(symbol),
        getPositions(symbol), getOpenOrders(symbol),
      ]);
      requireVstHedgeLong10(mode, margin, leverage, "VST automated pre-runner split close");
      exactVstLongPosition(positions, name, String(totalQuantity), positionId);
      size = floorQuantity(String(totalQuantity), filters.quantityPrecision);
      if (!sameDecimal(size, String(totalQuantity)) ||
          positive(size, "pre-runner close quantity") < filters.minQuantity ||
          typeof originalStop.quantity !== "string" && typeof originalStop.quantity !== "number" ||
          typeof coreStop.quantity !== "string" && typeof coreStop.quantity !== "number" ||
          !sameDecimal(String(originalStop.quantity), size) ||
          !decimalIsRatio(String(coreStop.quantity), size, 80, 100) ||
          !sameDecimal(String(originalStop.stopPrice), String(coreStop.stopPrice))) {
        throw new BingXLiveApiError(
          "VST pre-runner close requires exact full-size and 80% core stop descriptors at one signal trigger",
        );
      }
      decimalAtPrecision(String(originalStop.stopPrice), filters.pricePrecision,
        "Pre-runner signal stop price");
      exactStop = (row, stop, quantity) =>
        exactStringOrderId(row) === stop.orderId &&
        exactAutomatedSplitStop(row, {
          name, orderId: stop.orderId, positionId,
          quantity, stopPrice: String(originalStop.stopPrice),
        });
      if (!Array.isArray(orders) || orders.length !== 2 ||
          !exactStop(orders.find((row) => exactStringOrderId(row) === originalStop.orderId),
            originalStop, size) ||
          !exactStop(orders.find((row) => exactStringOrderId(row) === coreStop.orderId),
            coreStop, String(coreStop.quantity))) {
        throw new BingXLiveApiError(
          "VST pre-runner close requires only the exact full signal stop and same-trigger 80% core stop",
        );
      }
      verifyBeforeMarket = async () => {
        const [freshMode, freshMargin, freshLeverage, freshPositions, freshOrders,
          originalFills, coreFills] = await Promise.all([
          getPositionMode(), getMarginType(symbol), getLeverage(symbol),
          getPositions(symbol), getOpenOrders(symbol),
          queryFills(symbol, {
            startTs: 1, endTs: Math.max(1, Math.floor(clock())),
            orderId: originalStop.orderId, currency: "VST",
          }),
          queryFills(symbol, {
            startTs: 1, endTs: Math.max(1, Math.floor(clock())),
            orderId: coreStop.orderId, currency: "VST",
          }),
        ]);
        requireVstHedgeLong10(
          freshMode, freshMargin, freshLeverage, "VST automated pre-runner split close",
        );
        exactVstLongPosition(freshPositions, name, size, positionId);
        if (!Array.isArray(freshOrders) || freshOrders.length !== 2 ||
            !Array.isArray(originalFills) || originalFills.length !== 0 ||
            !Array.isArray(coreFills) || coreFills.length !== 0 ||
            !exactStop(
              freshOrders.find((row) => exactStringOrderId(row) === originalStop.orderId),
              originalStop, size,
            ) ||
            !exactStop(
              freshOrders.find((row) => exactStringOrderId(row) === coreStop.orderId),
              coreStop, String(coreStop.quantity),
            )) {
          throw new BingXLiveApiError(
            "VST pre-runner close blocked: exact unchanged LONG position, both signal stops, and zero fills are required",
          );
        }
      };
      await verifyBeforeMarket();
    } catch (error) {
      setPreRunnerCloseNoMutationProvenance(error);
      throw error;
    }

    submittedVstStopUpgradeIntents.add(intent);
    submittedTriggeredRunnerCancellationIds.add(closeIdentity);
    submittedClientOrderIds.add(clientOrderId);
    let response;
    try {
      response = await request("POST", PATH.order, {
        symbol: name, side: "SELL", positionSide: "LONG", type: "MARKET",
        quantity: size, clientOrderId,
      }, {
        beforeSign: verifyBeforeMarket,
        onTransportStart: () => { marketMutationStarted = true; },
      });
    } catch (error) {
      if (!marketMutationStarted) {
        submittedVstStopUpgradeIntents.delete(intent);
        submittedTriggeredRunnerCancellationIds.delete(closeIdentity);
        submittedClientOrderIds.delete(clientOrderId);
        setPreRunnerCloseNoMutationProvenance(error);
      } else {
        setPreRunnerCloseMutationSentProvenance(error);
      }
      throw error;
    }
    try {
    const responseHasId = response?.orderId !== undefined && response.orderId !== null ||
      response?.orderID !== undefined && response.orderID !== null;
    const responseId = exactStringOrderId(response);
    if (responseHasId && responseId === null) {
      throw new BingXLiveApiError(
        "VST pre-runner MARKET response contains a non-lossless order ID; reconcile manually",
      );
    }
    const resolvedMarketOrder = await queryOrderByClientIdWithExactRecovery(
      symbol, clientOrderId, {
        ...(responseId ? { knownOrderId: responseId } : {}),
        intentCreatedAt: recoveryCreatedAt, label: "VST pre-runner MARKET close",
      },
    );
    const closeOrderId = resolvedMarketOrder.orderId;
    const marketOrder = resolvedMarketOrder.order;
    const exactClientOrderId = (row) => {
      const values = ["clientOrderId", "clientOrderID"].filter((key) =>
        row?.[key] !== undefined && row[key] !== null).map((key) => row[key]);
      return values.length > 0 && values.every((value) =>
        typeof value === "string" && value === clientOrderId);
    };
    if (!marketOrder || exactStringOrderId(marketOrder) !== closeOrderId ||
        marketOrder.symbol !== name || marketOrder.type !== "MARKET" ||
        marketOrder.status !== "FILLED" || marketOrder.side !== "SELL" ||
        marketOrder.positionSide !== "LONG" || !exactClientOrderId(marketOrder) ||
        !sameDecimal(marketOrder.origQty, size) ||
        !sameDecimal(marketOrder.executedQty, size)) {
      throw new BingXLiveApiError(
        "VST pre-runner MARKET close is uncertain or not exactly FILLED; both stops remain untouched",
      );
    }
    const fills = await queryFills(symbol, {
      startTs: 1, endTs: Math.max(1, Math.floor(clock())),
      orderId: closeOrderId, currency: "VST",
    });
    const fillId = (fill) => {
      const keys = ["tradeId", "tradeID", "fillId", "fillID", "id"];
      const values = keys.filter((key) =>
        fill?.[key] !== undefined && fill[key] !== null).map((key) => fill[key]);
      return values.length && values.every((value) =>
        typeof value === "string" && value.trim() !== "") &&
        new Set(values).size === 1 ? values[0] : null;
    };
    const fillIds = fills.map(fillId);
    const filledQuantity = fills.reduce((sum, fill) =>
      addDecimals(sum, String(fill.qty ?? fill.quantity ?? fill.volume)), "0");
    const fees = fills.map((fill, index) => ({
      fillId: fillIds[index],
      amount: fill.commission ?? fill.fee ?? fill.commissionAmount ?? fill.feeAmount,
      asset: fill.commissionAsset ?? fill.feeAsset ?? fill.feeCurrency ?? fill.currency,
    }));
    const closeFillById = new Map(fills.map((fill, index) => [fillIds[index], fill]));
    if (!Array.isArray(fills) || !fills.length ||
        fillIds.some((id) => !id) || new Set(fillIds).size !== fillIds.length ||
        fills.some((fill) => fill.symbol !== name ||
          exactStringOrderId(fill) !== closeOrderId || fill.side !== "SELL" ||
          fill.positionSide !== undefined && fill.positionSide !== "LONG" ||
          !/^\d+(?:\.\d+)?$/.test(String(fill.price ?? fill.tradePrice ?? fill.fillPrice)) ||
          !/^-?\d+(?:\.\d+)?$/.test(String(
            fill.commission ?? fill.fee ?? fill.commissionAmount ?? fill.feeAmount,
          )) ||
          typeof (fill.commissionAsset ?? fill.feeAsset ??
            fill.feeCurrency ?? fill.currency) !== "string" ||
          !(fill.commissionAsset ?? fill.feeAsset ?? fill.feeCurrency ?? fill.currency)) ||
        !sameDecimal(filledQuantity, size)) {
      throw new BingXLiveApiError(
        "VST pre-runner MARKET fill quantities or independently reported fees are incomplete",
      );
    }
    const isExactNumericOrderNotFound = (error) =>
      error instanceof BingXLiveApiError &&
      error.transportStage === "exchange_response" &&
      error.method === "GET" &&
      error.endpoint === PATH.orderQuery &&
      error.httpStatus === 200 &&
      error.code === 109421 &&
      error.exchangeMessage === "order not exist";
    const [flatPositions, openAfterClose] = await Promise.all([
      getPositions(symbol), getOpenOrders(symbol),
    ]);
    requireFlatSymbol(flatPositions, name);
    const stopIds = new Set(stops.map((stop) => stop.orderId));
    if (!Array.isArray(openAfterClose) ||
        openAfterClose.some((order) =>
          !stopIds.has(exactStringOrderId(order)))) {
      throw new BingXLiveApiError(
        "VST pre-runner close is filled and flat, but a foreign open order blocks known-stop recovery",
      );
    }
    const finalStops = await Promise.all(stops.map(async (stop) => {
      const quantity = stop === originalStop ? size : String(coreStop.quantity);
      let queried;
      let numericNotFound = false;
      try {
        queried = await queryOrder(symbol, { orderId: stop.orderId });
      } catch (error) {
        if (!isExactNumericOrderNotFound(error)) throw error;
        numericNotFound = true;
      }
      const stopFills = await queryFills(symbol, {
        startTs: 1, endTs: Math.max(1, Math.floor(clock())),
        orderId: stop.orderId, currency: "VST",
      });
      const activeRows = openAfterClose.filter((row) =>
        exactStringOrderId(row) === stop.orderId);
      let activeOrderProvenByFreshRead = false;
      let entryParentId;
      if (numericNotFound) {
        // Some VST conditional orders remain visible in a complete fresh
        // openOrders snapshot after BingX has already dropped their
        // per-order numeric lookup. Treat that error as evidence only after
        // independently proving the close, flatness, exact stop ownership,
        // and the stop's filled entry parent; never infer cancellation from
        // a missing numeric lookup alone.
        const [freshClose, freshCloseFills, freshPositions, freshOrders] =
          await Promise.all([
            queryOrder(symbol, { orderId: closeOrderId }),
            queryFills(symbol, {
              startTs: 1, endTs: Math.max(1, Math.floor(clock())),
              orderId: closeOrderId, currency: "VST",
            }),
            getPositions(symbol),
            getOpenOrders(symbol),
          ]);
        requireFlatSymbol(freshPositions, name);
        const freshCloseFillIds = Array.isArray(freshCloseFills)
          ? freshCloseFills.map(fillId) : [];
        const freshCloseFilledQuantity = Array.isArray(freshCloseFills)
          ? freshCloseFills.reduce((sum, fill) =>
            addDecimals(sum, String(fill.qty ?? fill.quantity ?? fill.volume)), "0")
          : "0";
        if (!freshClose ||
            exactStringOrderId(freshClose) !== closeOrderId ||
            freshClose.symbol !== name ||
            freshClose.type !== "MARKET" ||
            freshClose.status !== "FILLED" ||
            freshClose.side !== "SELL" ||
            freshClose.positionSide !== "LONG" ||
            !exactClientOrderId(freshClose) ||
            !sameDecimal(freshClose.origQty, size) ||
            !sameDecimal(freshClose.executedQty, size) ||
            !Array.isArray(freshCloseFills) ||
            freshCloseFills.length !== fills.length ||
            freshCloseFillIds.some((id) => !id || !fillIds.includes(id)) ||
            new Set(freshCloseFillIds).size !== freshCloseFillIds.length ||
            new Set(freshCloseFillIds).size !== fillIds.length ||
            freshCloseFills.some((fill) => fill.symbol !== name ||
              exactStringOrderId(fill) !== closeOrderId ||
              fill.side !== "SELL" ||
              fill.positionSide !== undefined && fill.positionSide !== "LONG" ||
              !/^\d+(?:\.\d+)?$/.test(String(
                fill.price ?? fill.tradePrice ?? fill.fillPrice,
              )) ||
              !/^-?\d+(?:\.\d+)?$/.test(String(
                fill.commission ?? fill.fee ?? fill.commissionAmount ?? fill.feeAmount,
              )) ||
              typeof (fill.commissionAsset ?? fill.feeAsset ??
                fill.feeCurrency ?? fill.currency) !== "string" ||
              !(fill.commissionAsset ?? fill.feeAsset ??
                fill.feeCurrency ?? fill.currency) ||
              !closeFillById.has(fillId(fill)) ||
              !sameDecimal(
                String(fill.qty ?? fill.quantity ?? fill.volume),
                String(closeFillById.get(fillId(fill)).qty ??
                  closeFillById.get(fillId(fill)).quantity ??
                  closeFillById.get(fillId(fill)).volume),
              ) ||
              !sameDecimal(
                String(fill.price ?? fill.tradePrice ?? fill.fillPrice),
                String(closeFillById.get(fillId(fill)).price ??
                  closeFillById.get(fillId(fill)).tradePrice ??
                  closeFillById.get(fillId(fill)).fillPrice),
              ) ||
              !sameDecimal(
                String(fill.commission ?? fill.fee ??
                  fill.commissionAmount ?? fill.feeAmount),
                String(closeFillById.get(fillId(fill)).commission ??
                  closeFillById.get(fillId(fill)).fee ??
                  closeFillById.get(fillId(fill)).commissionAmount ??
                  closeFillById.get(fillId(fill)).feeAmount),
              ) ||
              (fill.commissionAsset ?? fill.feeAsset ??
                fill.feeCurrency ?? fill.currency) !==
                  (closeFillById.get(fillId(fill)).commissionAsset ??
                    closeFillById.get(fillId(fill)).feeAsset ??
                    closeFillById.get(fillId(fill)).feeCurrency ??
                    closeFillById.get(fillId(fill)).currency)) ||
            !sameDecimal(freshCloseFilledQuantity, size) ||
            !Array.isArray(freshOrders) ||
            freshOrders.length === 0 ||
            freshOrders.length > stops.length ||
            new Set(freshOrders.map((row) => exactStringOrderId(row))).size !==
              freshOrders.length ||
            freshOrders.some((row) => {
              const known = stops.find((item) =>
                item.orderId === exactStringOrderId(row));
              return !known ||
                !exactStop(
                  row, known, known === originalStop ? size : String(coreStop.quantity),
                );
            })) {
          throw new BingXLiveApiError(
            "VST pre-runner close cannot corroborate the filled close and exact flat owned stops after numeric lookup refusal",
          );
        }
        const currentRows = freshOrders.filter((row) =>
          exactStringOrderId(row) === stop.orderId);
        if (currentRows.length !== 1) {
          throw new BingXLiveApiError(
            "VST pre-runner numeric stop lookup refusal did not match one fresh active owned stop",
          );
        }
        const parentIds = freshOrders.map(linkedStopEntryParentId);
        if (parentIds.some((id) => id === null) ||
            new Set(parentIds).size !== 1) {
          throw new BingXLiveApiError(
            "VST pre-runner numeric stop lookup refusal lacks one consistent linked entry parent",
          );
        }
        entryParentId = parentIds[0];
        const entryOrder = await queryOrder(symbol, { orderId: entryParentId });
        const reportedEntryPositionId = entryOrder?.positionId ?? entryOrder?.positionID;
        if (!entryOrder ||
            exactStringOrderId(entryOrder) !== entryParentId ||
            entryOrder.symbol !== name ||
            entryOrder.type !== "MARKET" ||
            entryOrder.status !== "FILLED" ||
            entryOrder.side !== "BUY" ||
            entryOrder.positionSide !== "LONG" ||
            !sameDecimal(entryOrder.origQty, size) ||
            !sameDecimal(entryOrder.executedQty, size) ||
            reportedEntryPositionId !== undefined &&
              reportedEntryPositionId !== null &&
              orderIdentifier(reportedEntryPositionId, "entry position ID") !== positionId) {
          throw new BingXLiveApiError(
            "VST pre-runner numeric stop lookup refusal lacks its exact filled LONG entry parent",
          );
        }
        activeOrderProvenByFreshRead = true;
      }
      const canceledStopIsExact = queried &&
        exactStringOrderId(queried) === stop.orderId &&
        ["CANCELED", "CANCELLED"].includes(queried.status) &&
        queried.symbol === name && queried.type === "STOP_MARKET" &&
        queried.side === "SELL" && queried.positionSide === "LONG" &&
        queried.workingType === "MARK_PRICE" &&
        sameDecimal(queried.origQty, quantity) &&
        sameDecimal(queried.stopPrice, String(originalStop.stopPrice)) &&
        orderIdentifier(queried.positionId ?? queried.positionID, "stop position ID") ===
          positionId &&
        (queried.executedQty === undefined || sameDecimal(queried.executedQty, "0"));
      if (!Array.isArray(stopFills) || stopFills.length !== 0 ||
          activeRows.length > 1 ||
          activeRows.length === 1 && !exactStop(activeRows[0], stop, quantity) ||
          activeRows.length === 1 && !activeOrderProvenByFreshRead &&
            !exactVstActiveStopQuery(queried, openAfterClose, {
            name, orderId: stop.orderId, positionId,
            quantity, stopPrice: String(originalStop.stopPrice),
          }, exactAutomatedSplitStop) ||
          activeRows.length === 0 && !canceledStopIsExact ||
          numericNotFound && activeRows.length !== 1) {
        throw new BingXLiveApiError(
          "VST pre-runner close cannot establish exact active-or-canceled stop recovery evidence",
        );
      }
      return {
        stop, active: activeRows.length === 1,
        ...(activeOrderProvenByFreshRead ? { entryParentId } : {}),
      };
    }));
    const remainingKnownStopOrderIds = finalStops.filter((row) => row.active)
      .map((row) => row.stop.orderId);
    const verifiedEntryParents = new Map(finalStops
      .filter((row) => row.entryParentId)
      .map((row) => [row.stop.orderId, row.entryParentId]));
    const [finalClose, finalCloseFills, finalPositions, finalOrders] = await Promise.all([
      queryOrder(symbol, { orderId: closeOrderId }),
      queryFills(symbol, {
        startTs: 1, endTs: Math.max(1, Math.floor(clock())),
        orderId: closeOrderId, currency: "VST",
      }),
      getPositions(symbol), getOpenOrders(symbol),
    ]);
    requireFlatSymbol(finalPositions, name);
    if (!finalClose || exactStringOrderId(finalClose) !== closeOrderId ||
        finalClose.status !== "FILLED" || !exactClientOrderId(finalClose) ||
        !sameDecimal(finalClose.origQty, size) ||
        !sameDecimal(finalClose.executedQty, size) ||
        !Array.isArray(finalCloseFills) || finalCloseFills.length !== fills.length ||
        finalCloseFills.some((fill) => !fillIds.includes(fillId(fill))) ||
        finalOrders.some((row) => !stopIds.has(exactStringOrderId(row))) ||
        new Set(finalOrders.map((row) => exactStringOrderId(row))).size !== finalOrders.length ||
        JSON.stringify(finalOrders.map((row) => exactStringOrderId(row)).sort()) !==
          JSON.stringify(remainingKnownStopOrderIds.slice().sort()) ||
        finalOrders.some((row) => {
           const orderId = exactStringOrderId(row);
           const stop = stops.find((item) => item.orderId === orderId);
          return !stop || !exactStop(
            row, stop, stop === originalStop ? size : String(coreStop.quantity),
           ) || verifiedEntryParents.has(orderId) &&
             linkedStopEntryParentId(row) !== verifiedEntryParents.get(orderId);
        })) {
      throw new BingXLiveApiError(
        "VST pre-runner close final MARKET fill or flat-position evidence changed",
      );
    }
    return {
      symbol: name, positionId, closedQuantity: size, closeOrderId, clientOrderId,
      closeIntentId, intentCreatedAt: recoveryCreatedAt, fills, fees, flat: true,
      originalStopOrderId: originalStop.orderId, coreStopOrderId: coreStop.orderId,
      remainingKnownStopOrderIds,
      fullyCleaned: remainingKnownStopOrderIds.length === 0,
      stopCleanupRequired: remainingKnownStopOrderIds.length > 0,
      verified: true,
    };
    } catch (error) {
      if (marketMutationStarted) setPreRunnerCloseMutationSentProvenance(error);
      throw error;
    }
  }

  async function cancelVstAutomatedKnownStopWhenFlat({
    symbol, policy, positionId, stopToCancel, knownRemainingStopOrderIds,
    cancellationIntentId, entryOrderId,
  }) {
    const name = requireAutomatedSplitPolicy(
      symbol, policy, "VST automated known-stop flat cleanup",
    );
    if (typeof positionId !== "string" || !positionId ||
        typeof stopToCancel?.orderId !== "string" || !stopToCancel.orderId ||
        !Array.isArray(knownRemainingStopOrderIds) ||
        !knownRemainingStopOrderIds.length ||
        knownRemainingStopOrderIds.some((id) => typeof id !== "string" || !id) ||
        new Set(knownRemainingStopOrderIds).size !== knownRemainingStopOrderIds.length ||
        !knownRemainingStopOrderIds.includes(stopToCancel.orderId) ||
        typeof cancellationIntentId !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(cancellationIntentId) ||
        entryOrderId !== undefined &&
          (typeof entryOrderId !== "string" || !entryOrderId.trim())) {
      throw new BingXLiveApiError(
        "VST flat-stop cleanup requires exact persisted target/known IDs and cancellation intent",
      );
    }
    const intent = `${name}:${positionId}:${stopToCancel.orderId}:flat-known-stop:${cancellationIntentId}`;
    if (submittedVstStopUpgradeIntents.has(intent) ||
        submittedAutomatedFlatStopCancellationIds.has(`${name}:${positionId}:${stopToCancel.orderId}`)) {
      throw new BingXLiveApiError(
        "VST known-stop cancellation already submitted; reconcile, never retry",
      );
    }
    const allowedIds = new Set(knownRemainingStopOrderIds);
    const exactEntryParent = (row) => {
      try {
        const parents = [row?.mainOrderId, row?.parentOrderId]
          .filter((value) => value !== undefined && value !== null && value !== "")
          .map((value) => orderIdentifier(value, "known stop parent ID"));
        return new Set(parents).size <= 1 &&
          (entryOrderId === undefined
            ? parents.length === 0
            : parents.length > 0 && parents.every((parent) => parent === entryOrderId));
      } catch {
        return false;
      }
    };
    const activeKnownStopMatches = (row, id) => {
      try {
        return exactAutomatedSplitStop(row, {
          name, orderId: id, positionId,
          quantity: String(row.origQty), stopPrice: String(row.stopPrice),
          entryOrderId,
        }) && exactEntryParent(row);
      } catch {
        return false;
      }
    };
    const canceledKnownStopMatches = (row, id) => {
      try {
        return row?.symbol === name && exactStringOrderId(row) === id &&
          ["CANCELED", "CANCELLED"].includes(row.status) &&
          row.type === "STOP_MARKET" && row.side === "SELL" &&
          row.positionSide === "LONG" && row.workingType === "MARK_PRICE" &&
          row.closePosition !== true && row.closePosition !== "true" &&
          row.origQty !== undefined && row.origQty !== null &&
          positive(String(row.origQty), "known stop quantity") > 0 &&
          positive(String(row.stopPrice), "known stop price") > 0 &&
          orderIdentifier(row.positionId ?? row.positionID, "stop position ID") === positionId &&
          exactEntryParent(row) &&
          (row.executedQty === undefined || sameDecimal(row.executedQty, "0"));
      } catch {
        return false;
      }
    };
    const verifyFlatKnownSet = async ({ requireTargetOpen = false } = {}) => {
      const [mode, margin, leverage, positions, orders, queriedRows, fillsByStop] =
        await Promise.all([
          getPositionMode(), getMarginType(symbol), getLeverage(symbol),
          getPositions(symbol), getOpenOrders(symbol),
          Promise.all(knownRemainingStopOrderIds.map((id) =>
            queryOrder(symbol, { orderId: id }))),
          Promise.all(knownRemainingStopOrderIds.map((id) =>
            queryFills(symbol, {
              startTs: 1, endTs: Math.max(1, Math.floor(clock())),
              orderId: id, currency: "VST",
            }))),
        ]);
      requireVstHedgeLong10(
        mode, margin, leverage, "VST automated known-stop flat cleanup",
      );
      requireFlatSymbol(positions, name);
      if (!Array.isArray(orders) ||
          orders.some((row) => !allowedIds.has(orderIdentifierFrom(row, "known stop ID"))) ||
          new Set(orders.map((row) => orderIdentifierFrom(row, "known stop ID"))).size !==
            orders.length ||
          !fillsByStop.every((fills) => Array.isArray(fills) && fills.length === 0)) {
        throw new BingXLiveApiError(
          "VST flat stop cleanup blocked by foreign orders, duplicate IDs, or stop fills",
        );
      }
      for (let index = 0; index < knownRemainingStopOrderIds.length; index += 1) {
        const id = knownRemainingStopOrderIds[index];
        const openMatches = orders.filter((row) =>
          orderIdentifierFrom(row, "known stop ID") === id);
        if (openMatches.length === 1) {
          if (!activeKnownStopMatches(openMatches[0], id) ||
              !exactVstActiveStopQuery(queriedRows[index], orders, {
                name, orderId: id, positionId,
                quantity: String(openMatches[0].origQty),
                stopPrice: String(openMatches[0].stopPrice),
                entryOrderId,
              }, exactAutomatedSplitStop)) {
            throw new BingXLiveApiError(
              "VST flat cleanup cannot verify a known open protective stop",
            );
          }
        } else if (openMatches.length === 0) {
          if (!canceledKnownStopMatches(queriedRows[index], id)) {
            throw new BingXLiveApiError(
              "VST flat cleanup lacks canceled-order evidence for an absent known stop",
            );
          }
        } else {
          throw new BingXLiveApiError("VST flat cleanup found duplicate known stop IDs");
        }
      }
      const targetIndex = knownRemainingStopOrderIds.indexOf(stopToCancel.orderId);
      const targetOpen = orders.filter((row) =>
        orderIdentifierFrom(row, "target known stop ID") === stopToCancel.orderId);
      if (requireTargetOpen && (targetOpen.length !== 1 ||
          !exactAutomatedSplitStop(targetOpen[0], {
            name, orderId: stopToCancel.orderId, positionId,
            quantity: String(stopToCancel.quantity), stopPrice: String(stopToCancel.stopPrice),
             entryOrderId,
          }) || !exactVstActiveStopQuery(queriedRows[targetIndex], orders, {
            name, orderId: stopToCancel.orderId, positionId,
            quantity: String(stopToCancel.quantity), stopPrice: String(stopToCancel.stopPrice),
             entryOrderId,
          }, exactAutomatedSplitStop))) {
        throw new BingXLiveApiError(
          "VST flat cleanup will cancel only the exact independently verified open stop",
        );
      }
      if (!requireTargetOpen && targetOpen.length !== 0) {
        throw new BingXLiveApiError(
          "VST requested known stop remains open after cancellation",
        );
      }
      return { orders, queriedRows };
    };
    await verifyFlatKnownSet({ requireTargetOpen: true });
    submittedVstStopUpgradeIntents.add(intent);
    submittedAutomatedFlatStopCancellationIds.add(
      `${name}:${positionId}:${stopToCancel.orderId}`,
    );
    await request("DELETE", PATH.order, {
      symbol: name, orderId: stopToCancel.orderId,
    }, { beforeSign: () => verifyFlatKnownSet({ requireTargetOpen: true }) });
    const finalState = await verifyFlatKnownSet();
    const finalOrders = finalState.orders;
    const remainingKnownStopOrderIds = finalOrders.map((row) =>
      orderIdentifierFrom(row, "remaining known stop ID"));
    const targetFinalOrder = finalState.queriedRows[
      knownRemainingStopOrderIds.indexOf(stopToCancel.orderId)];
    return {
      symbol: name, positionId, status: targetFinalOrder.status,
      canceledStopOrderId: stopToCancel.orderId,
      cancellationIntentId, knownRemainingStopOrderIds: [...knownRemainingStopOrderIds],
      remainingKnownStopOrderIds, flat: true, verified: true,
    };
  }

  async function cancelVstProtectiveStopOnlyWhenFlat({
    symbol, orderId, knownStopOrderIds,
  }) {
    const name = requireVstBtc(symbol);
    const exactStopId = orderIdentifier(orderId, "flat-position protective stop ID");
    if (!Array.isArray(knownStopOrderIds) || !knownStopOrderIds.length ||
        knownStopOrderIds.some((id) => typeof id !== "string" || !id) ||
        new Set(knownStopOrderIds).size !== knownStopOrderIds.length ||
        !knownStopOrderIds.includes(exactStopId)) {
      throw new BingXLiveApiError("VST flat cleanup requires the persisted set of known protective stop IDs");
    }
    const allowedIds = new Set(knownStopOrderIds);
    const onlyKnownStops = (orders) => Array.isArray(orders) && orders.every((order) =>
      allowedIds.has(orderIdentifierFrom(order, "open protective stop ID")) &&
      order.type === "STOP_MARKET" && order.side === "SELL" &&
      order.positionSide === "LONG" && order.status === "NEW");
    const intent = `${name}:${exactStopId}:flat-cleanup`;
    if (submittedVstStopUpgradeIntents.has(intent)) {
      throw new BingXLiveApiError("VST flat stop cleanup already submitted; reconcile, never retry");
    }
    const [positions, orders] = await Promise.all([
      getPositions(symbol), getOpenOrders(symbol),
    ]);
    requireFlatSymbol(positions, name);
    const matches = orders.filter((order) =>
      orderIdentifierFrom(order, "open order ID") === exactStopId);
    if (!onlyKnownStops(orders) || matches.length !== 1 ||
        matches[0].type !== "STOP_MARKET" || matches[0].side !== "SELL" ||
        matches[0].positionSide !== "LONG" || matches[0].status !== "NEW") {
      throw new BingXLiveApiError("VST flat cleanup permits only the exact remaining BTC protective stop");
    }
    const queried = await queryOrder(symbol, { orderId: exactStopId });
    if (!queried || orderIdentifierFrom(queried) !== exactStopId ||
        queried.status !== "NEW" || queried.type !== "STOP_MARKET" ||
        queried.side !== "SELL" || queried.positionSide !== "LONG") {
      throw new BingXLiveApiError("VST flat protective stop identity is not verified");
    }
    submittedVstStopUpgradeIntents.add(intent);
    await request("DELETE", PATH.order, { symbol: name, orderId: exactStopId }, {
      beforeSign: async () => {
        const [freshPositions, freshOrders] = await Promise.all([
          getPositions(symbol), getOpenOrders(symbol),
        ]);
        requireFlatSymbol(freshPositions, name);
        const current = freshOrders.filter((order) =>
          orderIdentifierFrom(order, "open order ID") === exactStopId);
        if (!onlyKnownStops(freshOrders) || current.length !== 1) {
          throw new BingXLiveApiError("VST flat stop cleanup final pre-delete state changed");
        }
      },
    });
    const [finalOrder, remainingOrders, fills] = await Promise.all([
      queryOrder(symbol, { orderId: exactStopId }),
      getOpenOrders(symbol),
      queryFills(symbol, {
        startTs: 1, endTs: Math.max(1, Math.floor(clock())),
        orderId: exactStopId, currency: "VST",
      }),
    ]);
    if (!finalOrder || orderIdentifierFrom(finalOrder) !== exactStopId ||
        !["CANCELED", "CANCELLED"].includes(finalOrder.status) ||
        !onlyKnownStops(remainingOrders) ||
        remainingOrders.some((order) => orderIdentifierFrom(order) === exactStopId) ||
        !Array.isArray(fills) || fills.length !== 0 ||
        finalOrder.executedQty !== undefined &&
          !sameDecimal(finalOrder.executedQty, "0")) {
      throw new BingXLiveApiError("VST flat protective stop cancellation is not independently verified");
    }
    return { status: finalOrder.status, order: finalOrder };
  }

  async function discoverVstAutomatedLongStop({
    symbol, quantity, positionId, entryOrderId, expectedStopPrice,
    policy = VST_AUTOMATED_LONG_POLICY,
  }) {
    const name = symbolName(symbol);
    validateAutomatedLongPolicy(symbol, policy);
    if (typeof positionId !== "string" || !positionId) {
      throw new BingXLiveApiError("VST stop discovery requires an exact position ID");
    }
    const [mode, marginType, leverage, positions, orders, filters] = await Promise.all([
      getPositionMode(), getMarginType(symbol), getLeverage(symbol),
      getPositions(symbol), getOpenOrders(symbol), contract(symbol),
    ]);
    requireVstHedgeLong10(mode, marginType, leverage, "VST protective-stop discovery");
    exactVstLongPosition(positions, name, quantity, positionId);
    decimalAtPrecision(String(expectedStopPrice), filters.pricePrecision, "Expected stop loss");
    const entryId = orderIdentifier(entryOrderId, "entry order ID");
    if (orders.length !== 1 ||
        !exactVstLongStop(orders[0], {
          name,
          orderId: orderIdentifierFrom(orders[0], "protective stop order ID"),
          positionId,
          quantity,
          stopPrice: String(expectedStopPrice),
          entryOrderId: entryId,
        })) {
      throw new BingXLiveApiError(
        "VST attached stop is not an independently identified exact open protective order",
      );
    }
    return {
      verified: true,
      symbol: name,
      stopOrderId: orderIdentifierFrom(orders[0], "protective stop order ID"),
      entryOrderId: entryId,
      positionId,
      positionSide: "LONG",
      expectedStopPrice: String(expectedStopPrice),
      expectedQuantity: String(quantity),
    };
  }

  async function queryOrder(symbol, identifier) {
    const byId = identifier !== null && typeof identifier === "object"
      ? identifier : { orderId: identifier };
    const hasOrderId = (byId.orderID !== undefined && byId.orderID !== null) ||
      (byId.orderId !== undefined && byId.orderId !== null);
    const hasClientId = typeof byId.clientOrderId === "string" && byId.clientOrderId !== "";
    if (hasOrderId === hasClientId) {
      throw new TypeError("Provide exactly one of orderId or clientOrderId");
    }
    const requestedOrderId = hasOrderId
      ? orderIdentifierFrom({ orderID: byId.orderID, orderId: byId.orderId }, "query order ID")
      : null;
    let data;
    try {
      data = await request("GET", PATH.orderQuery, {
        symbol: symbolName(symbol),
        ...(hasOrderId
          ? { orderId: requestedOrderId }
          : { clientOrderId: byId.clientOrderId }),
      });
    } catch (error) {
      if (!hasOrderId &&
          error instanceof BingXLiveApiError &&
          error.transportStage === "exchange_response" &&
          error.method === "GET" &&
          error.endpoint === PATH.orderQuery &&
          error.httpStatus === 200 &&
          error.code === 109421 &&
          error.exchangeMessage === "order not exist") {
        return null;
      }
      throw error;
    }
    if (data?.order !== undefined &&
        (!data.order || typeof data.order !== "object" || Array.isArray(data.order))) {
      throw new BingXLiveApiError("BingX returned invalid nested order data");
    }
    const result = data?.order ?? data;
    if (result?.orderID != null || result?.orderId != null) {
      orderIdentifierFrom(result, "queried order ID");
    }
    return result;
  }

  async function queryFills(symbol, {
    startTs, endTs, orderId, currency, requireComplete = false,
  } = {}) {
    const start = Number(startTs);
    const end = Number(endTs);
    if (!Number.isSafeInteger(start) || start <= 0 ||
        !Number.isSafeInteger(end) || end < start) {
      throw new TypeError("startTs and endTs must be ordered millisecond timestamps");
    }
    if (typeof currency !== "string" || !/^[A-Z0-9]{2,12}$/.test(currency)) {
      throw new TypeError("currency is required for BingX fill queries");
    }
    if (typeof requireComplete !== "boolean") {
      throw new TypeError("requireComplete must be a boolean");
    }
    if (requireComplete) {
      if (orderId != null) {
        throw new BingXLiveApiError("Complete fill history cannot be order-filtered");
      }
      return (await queryCompleteFillHistory(symbol, { startTs, endTs, currency })).fills;
    }
    const expectedOrderId = optionalOrderIdentifier(orderId, "fill query order ID");
    const name = symbolName(symbol);
    const data = await request("GET", PATH.fills, {
      symbol: name,
      tradingUnit: "COIN",
      startTs: start,
      endTs: end,
      orderId,
      currency,
    });
    const fills = Array.isArray(data) ? data
      : data && Object.hasOwn(data, "fill_orders") ? data.fill_orders : data?.orders;
    if (!Array.isArray(fills) || fills.some((fill) => {
      if (!fill || typeof fill !== "object" || Array.isArray(fill) ||
          typeof fill.symbol !== "string") return true;
      try {
        orderIdentifierFrom(fill, "fill order ID");
        return false;
      } catch {
        return true;
      }
    })) {
      throw new BingXLiveApiError("BingX returned an invalid fill list");
    }
    // The currency-scoped history can contain other symbols on a shared
    // account. Select the requested symbol/order locally; the executor then
    // cross-checks every returned fill against the expected order and side.
    return fills.filter((fill) => fill.symbol === name &&
      (expectedOrderId == null ||
        orderIdentifierFrom(fill, "fill order ID") === expectedOrderId));
  }

  async function queryCompleteFillHistory(symbol, options = {}) {
    if (environment !== "vst") {
      throw new BingXLiveApiError("Complete fill history is only verified for VST");
    }
    const name = symbolName(symbol);
    const result = await collectCompleteFillHistory({
      ...options,
      clock,
      readPage: (params) => request("GET", COMPLETE_FILL_HISTORY_PATH, params),
    });
    // Completeness is checked currency-wide, never after symbol filtering.
    return {
      ...result,
      rawFills: result.fills,
      fills: result.fills.filter((row) => row.symbol === name),
    };
  }

  async function reconcilePositionAndStop(symbol, {
    expectedStopPrice, orderId, clientOrderId, stopOrderId, expectedQuantity,
  } = {}) {
    const name = symbolName(symbol);
    const positions = await getPositions(symbol);
    const position = positions.find((row) => row?.symbol === name &&
      (row.positionSide === "BOTH" || row.positionSide === "LONG" || row.positionSide == null) &&
      validPositionAmount(row) !== 0);
    let attachedConfigured = false;
    let stopEvidence = "no_open_position";
    if (position) {
      stopEvidence = "unverified";
      if (expectedStopPrice !== undefined && (orderId != null || clientOrderId != null)) {
        // The filled parent can echo its original stop configuration even
        // after that stop is cancelled. This is NOT active protection proof.
        const order = await queryOrder(symbol, {
          ...(orderId != null ? { orderId } : {}),
          ...(clientOrderId != null ? { clientOrderId } : {}),
        });
        const attached = order?.stopLoss;
        let stopData = attached;
        if (typeof attached === "string") {
          try { stopData = JSON.parse(attached); } catch { stopData = null; }
        }
        const filters = await contract(symbol);
        decimalAtPrecision(expectedStopPrice, filters.pricePrecision, "Expected stop loss");
        if (stopData && typeof stopData === "object" &&
            Number(stopData.stopPrice) > 0 &&
            sameDecimal(stopData.stopPrice, expectedStopPrice)) {
          attachedConfigured = true;
          stopEvidence = "order_query_attached_stop_unverified";
        }
      }
    }
    // The attached stop's parent-order echo is only configuration history.
    // An independently identified, currently open stop can be verified.
    const audit = position && stopOrderId != null && expectedQuantity != null &&
      expectedStopPrice != null
      ? await assessProtectiveStopAmendment(symbol, {
        stopOrderId, entryOrderId: orderId, expectedStopPrice, expectedQuantity,
      })
      : null;
    const stopVerified = audit?.existingStopVerified === true;
    if (stopVerified) stopEvidence = "active_open_protective_order";
    return {
      symbol: name,
      positionOpen: Boolean(position),
      positionAmount: position ? String(position.positionAmt) : "0",
      stopCount: stopVerified ? 1 : 0,
      stopProtected: !position || stopVerified,
      expectedStopMatches: stopVerified,
      attachedConfigured,
      stopEvidence,
      stopPrice: stopVerified ? expectedStopPrice : null,
      ...(stopVerified ? { protectiveStopOrderId: String(stopOrderId) } : {}),
    };
  }

  // Read-only audit for a proposed stop move. An attached stop echoed by the
  // filled entry order is NOT evidence that its separate protective order is
  // still open. The stop's own order ID must have been durably identified.
  async function assessProtectiveStopAmendment(symbol, {
    stopOrderId, entryOrderId, expectedStopPrice, expectedQuantity, nextStopPrice,
  } = {}) {
    const name = symbolName(symbol);
    const blocked = (reason, existingStopVerified = false) => ({
      safeToAmend: false, reason, existingStopVerified,
    });
    const [mode, positions, orders] = await Promise.all([
      getPositionMode(), getPositions(symbol), getOpenOrders(symbol),
    ]);
    const side = mode === "HEDGE" ? "LONG" : "BOTH";
    const sameSymbol = positions.filter((row) => row?.symbol === name);
    const active = sameSymbol.filter((row) => validPositionAmount(row) !== 0);
    if (sameSymbol.some((row) => validPositionAmount(row) === null) ||
        active.length !== 1 || active[0].positionSide !== side ||
        validPositionAmount(active[0]) <= 0) {
      return blocked("position_missing_or_ambiguous");
    }
    try {
      if (strictNumeric(expectedQuantity, "expected position quantity") <= 0 ||
          !sameDecimal(active[0].positionAmt, expectedQuantity)) {
        return blocked("position_size_mismatch");
      }
    } catch {
      return blocked("position_size_mismatch");
    }
    if (orders.length === 0) return blocked("protective_order_missing");
    let expectedStopId;
    try {
      expectedStopId = optionalOrderIdentifier(stopOrderId, "protective order ID");
    } catch {
      return blocked("protective_order_identity_missing");
    }
    if (expectedStopId === null) return blocked("protective_order_identity_missing");
    const matches = orders.filter((row) =>
      orderIdentifierFrom(row, "open order ID") === expectedStopId);
    if (matches.length !== 1) return blocked("protective_order_missing_or_ambiguous");
    if (orders.length !== 1) return blocked("conflicting_same_symbol_orders");
    const stop = matches[0];
    try {
      if (stop.symbol !== name || stop.status !== "NEW" ||
          stop.type !== "STOP_MARKET" || stop.side !== "SELL" ||
          stop.positionSide !== side || stop.workingType !== "MARK_PRICE" ||
          (stop.closePosition !== true && stop.closePosition !== "true" &&
           stop.reduceOnly !== true && stop.reduceOnly !== "true") ||
           (entryOrderId != null && stop.mainOrderId != null &&
            orderIdentifier(stop.mainOrderId, "parent order ID") !==
              orderIdentifier(entryOrderId, "entry order ID")) ||
          (active[0].positionId != null && stop.positionID != null &&
           orderIdentifier(active[0].positionId, "position ID") !==
             orderIdentifier(stop.positionID, "stop position ID")) ||
          !sameDecimal(stop.origQty, expectedQuantity) ||
          !sameDecimal(stop.stopPrice, expectedStopPrice) ||
          (nextStopPrice !== undefined &&
           strictNumeric(nextStopPrice, "new stop price") <=
             strictNumeric(expectedStopPrice, "current stop price"))) {
        return blocked("protective_order_mismatch");
      }
    } catch {
      return blocked("protective_order_mismatch");
    }
    // BingX's documented amend endpoint changes quantity only. Its
    // cancelReplace endpoint can report cancelResult=SUCCESS together with
    // newOrderResult=FAILED; it does not guarantee continuous protection.
    // https://github.com/BingX-API/api-ai-skills/blob/main/skills/swap-trade/api-reference.md#vi-order-modification-and-replacement
    return blocked("replacement_could_leave_position_unprotected", true);
  }

  async function discoverAttachedStop(symbol, {
    entryOrderId, expectedStopPrice, expectedQuantity,
  } = {}) {
    const name = symbolName(symbol);
    const [mode, positions, orders, filters] = await Promise.all([
      getPositionMode(), getPositions(symbol), getOpenOrders(symbol), contract(symbol),
    ]);
    if (mode !== "ONE_WAY" && mode !== "HEDGE") {
      throw new BingXLiveApiError("BingX position mode is unknown");
    }
    decimalAtPrecision(expectedStopPrice, filters.pricePrecision, "Expected stop loss");
    const quantity = positive(expectedQuantity, "expected position quantity");
    const entryId = optionalOrderIdentifier(entryOrderId, "entry order ID");
    const expectedSide = mode === "HEDGE" ? "LONG" : "BOTH";
    const symbolPositions = positions.filter((row) => row?.symbol === name);
    const activePositions = symbolPositions.filter((row) => validPositionAmount(row) !== 0);
    const matchingPosition = activePositions.length === 1 &&
      (activePositions[0].positionSide === expectedSide ||
        (mode === "ONE_WAY" && activePositions[0].positionSide == null))
      ? activePositions[0] : null;
    if (symbolPositions.some((row) => validPositionAmount(row) === null) ||
        activePositions.length !== 1 || !matchingPosition ||
        validPositionAmount(matchingPosition) <= 0 ||
        !sameDecimal(matchingPosition.positionAmt, expectedQuantity)) {
      throw new BingXLiveApiError("BingX long position is missing, ambiguous, or does not match expected quantity");
    }
    if (orders.length !== 1) {
      throw new BingXLiveApiError(orders.length
        ? "Conflicting open orders prevent protective stop discovery"
        : "No independently open protective stop was found");
    }

    const stop = orders[0];
    const parentIds = [stop.mainOrderId, stop.parentOrderId]
      .filter((value) => value !== undefined && value !== null)
      .map((value) => orderIdentifier(value, "parent order ID"));
    if (new Set(parentIds).size > 1 ||
        (entryId !== null && parentIds.some((parentId) => parentId !== entryId))) {
      throw new BingXLiveApiError("Open protective stop does not match the filled entry order");
    }
    const closePosition = stop.closePosition === true || stop.closePosition === "true";
    try {
      if (stop.status !== "NEW" || stop.type !== "STOP_MARKET" ||
          stop.side !== "SELL" || stop.positionSide !== expectedSide ||
          (matchingPosition.positionId != null && stop.positionID != null &&
           orderIdentifier(matchingPosition.positionId, "position ID") !==
             orderIdentifier(stop.positionID, "stop position ID")) ||
          (!closePosition && !sameDecimal(stop.origQty, expectedQuantity)) ||
          !sameDecimal(stop.stopPrice, expectedStopPrice)) {
        throw new BingXLiveApiError("Open order does not exactly protect the long position");
      }
    } catch (error) {
      if (error instanceof BingXLiveApiError) throw error;
      throw new BingXLiveApiError("Open order does not exactly protect the long position");
    }
    const stopOrderId = orderIdentifierFrom(stop, "protective stop order ID");
    return {
      verified: true,
      symbol: name,
      stopOrderId,
      ...(entryId !== null ? { entryOrderId: entryId } : {}),
      positionSide: expectedSide,
      expectedStopPrice: String(expectedStopPrice),
      expectedQuantity: String(expectedQuantity),
      closePosition,
    };
  }

  // Read-only proof for partial exits: BingX STOP_MARKET closePosition=true
  // closes the whole remaining position. A parent-order stopLoss echo is not
  // evidence that this independently identified order is still working.
  async function auditProtectiveStopCoverage(symbol, {
    stopOrderId, expectedStopPrice, expectedQuantity, entryOrderId,
  } = {}) {
    const name = symbolName(symbol);
    const blocked = (reason) => ({
      verified: false,
      stopProtected: false,
      closePosition: false,
      canCoverRemainingQuantity: false,
      reason,
    });
    let expectedStopId;
    let entryId;
    try {
      expectedStopId = optionalOrderIdentifier(stopOrderId, "protective stop order ID");
      entryId = optionalOrderIdentifier(entryOrderId, "entry order ID");
    } catch {
      return blocked("protective_order_identity_invalid");
    }
    if (expectedStopId === null) return blocked("protective_order_identity_missing");

    const [mode, positions, orders, filters] = await Promise.all([
      getPositionMode(), getPositions(symbol), getOpenOrders(symbol), contract(symbol),
    ]);
    if (mode !== "ONE_WAY" && mode !== "HEDGE") {
      return blocked("position_mode_unknown");
    }
    const expectedSide = mode === "HEDGE" ? "LONG" : "BOTH";
    const symbolPositions = positions.filter((row) => row?.symbol === name);
    const activePositions = symbolPositions.filter((row) => validPositionAmount(row) !== 0);
    const position = activePositions.length === 1 ? activePositions[0] : null;
    if (symbolPositions.some((row) => validPositionAmount(row) === null) ||
        !position || position.positionSide !== expectedSide ||
        validPositionAmount(position) <= 0) {
      return blocked("position_missing_or_ambiguous");
    }
    let remainingQuantity;
    try {
      remainingQuantity = String(position.positionAmt);
      if (compareDecimals(remainingQuantity, "0", "remaining position quantity") <= 0 ||
          (expectedQuantity !== undefined &&
           compareDecimals(remainingQuantity, expectedQuantity, "expected position quantity") !== 0)) {
        return blocked("position_size_mismatch");
      }
      if (expectedStopPrice === undefined) return blocked("expected_stop_price_missing");
      decimalAtPrecision(expectedStopPrice, filters.pricePrecision, "Expected stop loss");
    } catch {
      return blocked("position_size_or_stop_price_invalid");
    }
    if (orders.length !== 1) {
      return blocked(orders.length ? "conflicting_same_symbol_orders" : "protective_order_missing");
    }
    let stop;
    try {
      const matches = orders.filter((row) => {
        const aliases = [row.orderId, row.orderID]
          .filter((value) => value !== undefined && value !== null)
          .map((value) => orderIdentifier(value, "open order ID"));
        if (!aliases.length || new Set(aliases).size !== 1) {
          throw new BingXLiveApiError("BingX returned an ambiguous open order ID");
        }
        return aliases[0] === expectedStopId;
      });
      if (matches.length !== 1) return blocked("protective_order_missing_or_ambiguous");
      stop = matches[0];
    } catch {
      return blocked("protective_order_identity_invalid");
    }
    try {
      const stopParentIds = [stop.mainOrderId, stop.parentOrderId]
        .filter((value) => value !== undefined && value !== null)
        .map((value) => orderIdentifier(value, "parent order ID"));
      const closePosition = stop.closePosition === true || stop.closePosition === "true";
      const coveredByFixedQuantity = !closePosition &&
        sameDecimal(stop.origQty, remainingQuantity);
      if (new Set(stopParentIds).size > 1 ||
          (entryId !== null && stopParentIds.some((id) => id !== entryId)) ||
          (position.positionId != null && stop.positionID != null &&
           orderIdentifier(position.positionId, "position ID") !==
             orderIdentifier(stop.positionID, "stop position ID")) ||
          stop.symbol !== name || stop.status !== "NEW" ||
          stop.type !== "STOP_MARKET" || stop.side !== "SELL" ||
          stop.positionSide !== expectedSide || stop.workingType !== "MARK_PRICE" ||
          !sameDecimal(stop.stopPrice, expectedStopPrice) ||
          (!closePosition && !coveredByFixedQuantity)) {
        return blocked("protective_order_mismatch");
      }
      const protectiveStopOrderId = orderIdentifierFrom(stop, "protective stop order ID");
      return {
        verified: true,
        stopProtected: true,
        protectiveStopOrderId,
        closePosition,
        canCoverRemainingQuantity: true,
        remainingQuantity,
        expectedStopPrice: String(expectedStopPrice),
        positionSide: expectedSide,
        ...(entryId !== null ? { entryOrderId: entryId } : {}),
      };
    } catch {
      return blocked("protective_order_mismatch");
    }
  }

  async function addIsolatedMargin(symbol, amount, clientOperationID) {
    const name = symbolName(symbol);
    const [marginType, leverage, mode, positions] = await Promise.all([
      getMarginType(symbol), getLeverage(symbol), getPositionMode(), getPositions(symbol),
    ]);
    if (marginType !== "ISOLATED" || leverage.longLeverage !== 10 ||
        leverage.shortLeverage !== 10) {
      throw new BingXLiveApiError("BingX margin add requires exchange-verified isolated 10x settings");
    }
    if (!positions.some((position) => position?.symbol === name &&
        (position.positionSide === (mode === "HEDGE" ? "LONG" : "BOTH") ||
          (mode === "ONE_WAY" && position.positionSide == null)) &&
        validPositionAmount(position) !== null && validPositionAmount(position) > 0)) {
      throw new BingXLiveApiError("BingX margin add requires a verified open long position");
    }
    if (typeof clientOperationID !== "string" ||
        !/^[A-Za-z0-9_-]{1,32}$/.test(clientOperationID)) {
      throw new BingXLiveApiError("A unique clientOperationID is required for margin-add duplicate protection");
    }
    if (submittedMarginOperationIds.has(clientOperationID)) {
      throw new BingXLiveApiError("clientOperationID was already submitted; reconcile before retrying");
    }
    const value = positive(amount, "margin amount");
    submittedMarginOperationIds.add(clientOperationID);
    return request("POST", PATH.positionMargin, {
      symbol: name, amount: value, type: 1,
      ...(mode === "HEDGE" ? { positionSide: "LONG" } : {}),
    });
  }

  async function getPositionMarginHistory(symbol, positionId, { startTime, endTime, pageIndex = 1, pageSize = 100 }) {
    if (typeof positionId !== "string" || !/^\d+$/.test(positionId) ||
        !Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime) ||
        startTime <= 0 || endTime < startTime ||
        !Number.isSafeInteger(pageIndex) || pageIndex < 1 ||
        !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new TypeError("Valid position ID and bounded margin history interval/page are required");
    }
    const data = await request("GET", PATH.positionMarginHistory, {
      symbol: symbolName(symbol), positionId, startTime, endTime, pageIndex, pageSize,
    });
    // The VST host uses `records`; the public reference calls this `list`.
    const records = data?.records ?? data?.list;
    if (!Number.isSafeInteger(Number(data?.total)) || Number(data.total) < 0 ||
        !Array.isArray(records) || records.length > pageSize ||
        Number(data.total) < records.length) {
      throw new BingXLiveApiError("BingX returned invalid margin adjustment history");
    }
    return { total: Number(data.total), records };
  }

  async function addVstIsolatedLongMargin({
    symbol, amount, clientOperationId, quantity, positionId, entryOrderId, stopLoss,
    policy = VST_AUTOMATED_LONG_POLICY,
  }) {
    const name = symbolName(symbol);
    if (!validateAutomatedLongPolicy(symbol, policy)) {
      throw new BingXLiveApiError("VST automated LONG policy is required for margin top-up");
    }
    if (typeof positionId !== "string" || !positionId ||
        typeof entryOrderId !== "string" || !entryOrderId ||
        typeof clientOperationId !== "string" ||
        !/^[A-Za-z0-9_-]{1,32}$/.test(clientOperationId)) {
      throw new BingXLiveApiError(
        "VST margin top-up requires exact entry and position identities and a unique operation ID",
      );
    }
    if (PROFILE_MARGIN !== "ISOLATED") {
      throw new BingXLiveApiError("VST margin top-up exists only for isolated margin");
    }
    const value = positive(amount, "margin amount");
    const [mode, marginType, leverage, positions, orders] = await Promise.all([
      getPositionMode(), getMarginType(symbol), getLeverage(symbol), getPositions(symbol),
      getOpenOrders(symbol),
    ]);
    requireVstHedgeLong10(mode, marginType, leverage, "VST margin top-up");
    const balanceRows = flattenBalance(await getBalance()).filter((row) => row?.asset === "VST");
    if (balanceRows.length !== 1 ||
        strictNumeric(balanceRows[0].availableMargin, "available VST margin") < value) {
      throw new BingXLiveApiError("VST margin top-up exceeds verified available VST balance");
    }
    const originalPosition = exactVstLongPosition(positions, name, quantity, positionId);
    const beforeMargin = strictNumeric(
      positionInitialMargin(originalPosition), "position isolated margin",
    );
    const originalStop = verifiedVstLongStop(orders, {
      name, positionId, quantity, stopPrice: String(stopLoss), entryOrderId,
    });
    const originalStopId = orderIdentifierFrom(originalStop, "protective stop order ID");
    if (submittedMarginOperationIds.has(clientOperationId)) {
      throw new BingXLiveApiError("clientOperationId was already submitted; reconcile before retrying");
    }
    submittedMarginOperationIds.add(clientOperationId);
    await request("POST", PATH.positionMargin, {
      symbol: name,
      amount: value,
      type: 1,
      positionSide: "LONG",
    }, {
      beforeSign: async () => {
        const [
          freshMode, freshMarginType, freshLeverage, freshPositions, freshBalance, freshOrders,
        ] =
          await Promise.all([
            getPositionMode(), getMarginType(symbol), getLeverage(symbol), getPositions(symbol),
            getBalance(), getOpenOrders(symbol),
          ]);
        requireVstHedgeLong10(freshMode, freshMarginType, freshLeverage, "VST margin top-up");
        const freshBalanceRows = flattenBalance(freshBalance)
          .filter((row) => row?.asset === "VST");
        if (freshBalanceRows.length !== 1 ||
            strictNumeric(freshBalanceRows[0].availableMargin, "available VST margin") < value) {
          throw new BingXLiveApiError("VST available balance changed before margin top-up");
        }
        const fresh = exactVstLongPosition(freshPositions, name, quantity, positionId);
        if (strictNumeric(positionInitialMargin(fresh), "position isolated margin") !== beforeMargin) {
          throw new BingXLiveApiError("VST position margin changed before top-up submission");
        }
        const freshStop = verifiedVstLongStop(freshOrders, {
          name, positionId, quantity, stopPrice: String(stopLoss), entryOrderId,
        });
        if (orderIdentifierFrom(freshStop, "protective stop order ID") !== originalStopId) {
          throw new BingXLiveApiError("VST protective stop changed before top-up submission");
        }
      },
    });
    const [
      verifiedMode, verifiedMarginType, verifiedLeverage, verifiedPositions, verifiedOrders,
    ] =
      await Promise.all([
        getPositionMode(), getMarginType(symbol), getLeverage(symbol), getPositions(symbol),
        getOpenOrders(symbol),
      ]);
    requireVstHedgeLong10(
      verifiedMode, verifiedMarginType, verifiedLeverage, "VST margin top-up verification",
    );
    const verifiedPosition = exactVstLongPosition(
      verifiedPositions, name, quantity, positionId,
    );
    // initialMargin remains the entry margin after a VST top-up. Never infer
    // an unapplied write from it; the broker will verify the separate,
    // asynchronously populated position-margin adjustment history.
    const verifiedStop = verifiedVstLongStop(verifiedOrders, {
      name, positionId, quantity, stopPrice: String(stopLoss), entryOrderId,
    });
    return {
      symbol: name,
      positionId,
      positionSide: "LONG",
      amount: value,
      isolatedMarginBefore: beforeMargin,
      isolatedMarginAfter: null,
      marginDelta: null,
      protectiveStop: {
        orderId: orderIdentifierFrom(verifiedStop, "protective stop order ID"),
        positionId,
        quantity: String(verifiedStop.origQty ?? verifiedStop.quantity),
        stopPrice: String(verifiedStop.stopPrice),
        status: verifiedStop.status,
        workingType: verifiedStop.workingType,
      },
      verified: false,
      submitted: true,
    };
  }

  async function closeLong(
    symbol, quantity, clientOrderId, expectedPositionId,
    { probePolicy, automatedLongPolicy, sourceExitRequest, protectedExit } = {},
  ) {
    const name = symbolName(symbol);
    const isSourceExitClose = sourceExitRequest !== undefined;
    const guardedStops = isSourceExitClose || protectedExit !== undefined;
    if (protectedExit !== undefined) {
      if (isSourceExitClose || automatedLongPolicy === undefined ||
          expectedPositionId === undefined) {
        throw new BingXLiveApiError("VST protected strategy exit requires its own exact LONG policy");
      }
      validateProtectedExit(protectedExit, {
        symbol, positionId: expectedPositionId, quantity,
      });
    }
    const stopRequest = sourceExitRequest ?? protectedExit;
    if (expectedPositionId !== undefined) {
      if (typeof expectedPositionId !== "string" || !expectedPositionId) {
        throw new BingXLiveApiError("A verified position ID is required for this VST close");
      }
      if (automatedLongPolicy !== undefined) {
        validateAutomatedLongPolicy(symbol, automatedLongPolicy);
        if (probePolicy !== undefined) {
          throw new BingXLiveApiError("VST close policies are mutually exclusive");
        }
      } else {
        requireVstBtc(symbol);
        requireProbePolicy(symbol, probePolicy);
      }
    } else if (probePolicy !== undefined) {
      validateProbePolicy(symbol, probePolicy);
      throw new BingXLiveApiError("The VST BTC probe policy requires an exact expected position ID");
    } else if (automatedLongPolicy !== undefined) {
      validateAutomatedLongPolicy(symbol, automatedLongPolicy);
      throw new BingXLiveApiError("VST automated close requires an exact expected position ID");
    }
    if (isSourceExitClose) {
      if (automatedLongPolicy === undefined || expectedPositionId === undefined) {
        throw new BingXLiveApiError(
          "VST source-exit close requires the automated LONG policy and exact position ID",
        );
      }
      validateSourceExitCloseRequest(sourceExitRequest, {
        symbol, expectedPositionId,
      });
      if (typeof clientOrderId !== "string" ||
          !/^[A-Za-z0-9_-]{1,32}$/.test(clientOrderId)) {
        throw new BingXLiveApiError(
          "VST source-exit close requires a guarded client order ID",
        );
      }
      if (submittedVstSourceExitRequestIds.has(sourceExitRequest.sourceExitRequestId)) {
        throw new BingXLiveApiError(
          "VST source-exit request was already submitted; reconcile, never retry",
        );
      }
    }
    if (clientOrderId !== undefined &&
        (typeof clientOrderId !== "string" ||
         !/^[A-Za-z0-9_-]{1,32}$/.test(clientOrderId))) {
      throw new BingXLiveApiError("clientOrderId must be a stable 1-32 character identifier");
    }
    if (clientOrderId !== undefined && submittedClientOrderIds.has(clientOrderId)) {
      throw new BingXLiveApiError("clientOrderId was already submitted; reconcile before retrying");
    }
    const [mode, marginType] = await Promise.all([
      getPositionMode(), getMarginType(symbol),
    ]);
    const leverage = expectedPositionId === undefined ? null : await getLeverage(symbol);
    const expectedExitMargin = automatedLongPolicy !== undefined ? PROFILE_MARGIN : "ISOLATED";
    if (marginType !== expectedExitMargin) {
      throw new BingXLiveApiError("BingX exit requires exchange-verified isolated margin");
    }
    if (expectedPositionId !== undefined) {
      if (automatedLongPolicy !== undefined) {
        requireVstHedgeLong10(mode, marginType, leverage, "VST automated close");
      } else if (mode !== "HEDGE" || leverage.longLeverage !== 10 ||
          leverage.shortLeverage !== 75) {
        throw new BingXLiveApiError(
          "Verified VST close requires HEDGE isolated LONG 10x/SHORT 75x",
        );
      }
    }
    const filters = await contract(symbol);
    const size = floorQuantity(quantity, filters.quantityPrecision);
    if (positive(size, "exit quantity") < filters.minQuantity) {
      throw new BingXLiveApiError("Exit quantity is below BingX contract minimum");
    }
    if (guardedStops && !sameDecimal(size, quantity)) {
      throw new BingXLiveApiError(
        "VST source-exit close requires the exact full remaining contract quantity",
      );
    }
    const [positions, initialOrders] = await Promise.all([
      getPositions(symbol),
      guardedStops ? getOpenOrders(symbol) : Promise.resolve(null),
    ]);
    const symbolPositions = positions.filter((row) => row?.symbol === name);
    const activePositions = symbolPositions.filter((row) => validPositionAmount(row) !== 0);
    const positionSide = mode === "HEDGE" ? "LONG" : "BOTH";
    const eligiblePositions = activePositions.filter((row) =>
      row.positionSide === positionSide ||
      (mode === "ONE_WAY" && row.positionSide == null));
    if (symbolPositions.some((row) => validPositionAmount(row) === null) ||
        activePositions.some((row) =>
          row.positionSide === "SHORT" || !eligiblePositions.includes(row)) ||
        activePositions.length !== 1 || eligiblePositions.length !== 1 ||
        compareDecimals(eligiblePositions[0].positionAmt, size, "exit quantity") < 0 ||
        (expectedPositionId !== undefined &&
          (compareDecimals(eligiblePositions[0].positionAmt, size, "exit quantity") !== 0 ||
           orderIdentifier(
             eligiblePositions[0].positionId ?? eligiblePositions[0].positionID, "position ID",
           ) !== expectedPositionId))) {
      throw new BingXLiveApiError("No unambiguous long exposure for this close");
    }
    if (guardedStops) {
      verifySourceExitStops(initialOrders, stopRequest, {
        name, positionId: expectedPositionId,
      });
    }
    if (clientOrderId !== undefined) submittedClientOrderIds.add(clientOrderId);
    if (isSourceExitClose) {
      submittedVstSourceExitRequestIds.add(sourceExitRequest.sourceExitRequestId);
    }
    return request("POST", PATH.order, {
      symbol: name,
      side: "SELL",
      positionSide: mode === "HEDGE" ? "LONG" : "BOTH",
      type: "MARKET",
      quantity: size,
      ...(mode === "ONE_WAY" ? { reduceOnly: "true" } : {}),
      ...(clientOrderId !== undefined ? { clientOrderId } : {}),
    }, expectedPositionId === undefined ? {} : {
      beforeSign: async () => {
        const [freshMode, freshMarginType, freshLeverage, freshPositions, freshOrders] =
          await Promise.all([
            getPositionMode(), getMarginType(symbol), getLeverage(symbol), getPositions(symbol),
            guardedStops ? getOpenOrders(symbol) : Promise.resolve(null),
          ]);
        const freshActive = freshPositions.filter((row) =>
          row?.symbol === name && validPositionAmount(row) !== 0);
        if (automatedLongPolicy !== undefined) {
          requireVstHedgeLong10(
            freshMode, freshMarginType, freshLeverage, "VST automated close",
          );
        } else if (freshMode !== "HEDGE" || freshMarginType !== "ISOLATED" ||
            freshLeverage.longLeverage !== 10 || freshLeverage.shortLeverage !== 75) {
          throw new BingXLiveApiError(
            "Verified VST close final position/settings check failed",
          );
        }
        if (freshMode !== "HEDGE" || freshMarginType !== expectedExitMargin ||
            freshActive.length !== 1 || freshActive[0].positionSide !== "LONG" ||
            compareDecimals(freshActive[0].positionAmt, size, "exit quantity") !== 0 ||
            orderIdentifier(
              freshActive[0].positionId ?? freshActive[0].positionID, "position ID",
            ) !== expectedPositionId) {
          throw new BingXLiveApiError(
            "Verified VST close final position/settings check failed",
          );
        }
        if (guardedStops) {
          verifySourceExitStops(freshOrders, stopRequest, {
            name, positionId: expectedPositionId,
          });
        }
      },
    });
  }

  async function emergencyCloseVstLong({
    symbol, quantity, clientOrderId, expectedPositionId,
  }) {
    const name = requireVstBtc(symbol);
    if (typeof expectedPositionId !== "string" || !expectedPositionId) {
      throw new BingXLiveApiError("VST emergency exit requires an exact persisted position ID");
    }
    if (typeof quantity !== "string" || !/^\d+(?:\.\d+)?$/.test(quantity)) {
      throw new BingXLiveApiError("VST emergency exit quantity must be an exact decimal string");
    }
    if (typeof clientOrderId !== "string" ||
        !/^[A-Za-z0-9_-]{1,32}$/.test(clientOrderId)) {
      throw new BingXLiveApiError("VST emergency exit requires a stable client order ID");
    }
    if (submittedClientOrderIds.has(clientOrderId)) {
      throw new BingXLiveApiError("clientOrderId was already submitted; reconcile before retrying");
    }
    const filters = await contract(symbol);
    const size = floorQuantity(quantity, filters.quantityPrecision);
    if (!sameDecimal(size, quantity) ||
        positive(size, "emergency exit quantity") < filters.minQuantity) {
      throw new BingXLiveApiError(
        "VST emergency exit must use the exact contract-precision residual quantity",
      );
    }
    const [mode, marginType, positions, orders] = await Promise.all([
      getPositionMode(), getMarginType(symbol), getPositions(symbol), getOpenOrders(symbol),
    ]);
    validateEmergencyVstLongExit({
      mode, marginType, positions, orders, name,
      positionId: expectedPositionId, quantity: size,
    });
    submittedClientOrderIds.add(clientOrderId);
    return request("POST", PATH.order, {
      symbol: name,
      side: "SELL",
      positionSide: "LONG",
      type: "MARKET",
      quantity: size,
      clientOrderId,
    }, {
      beforeSign: async () => {
        const [freshMode, freshMarginType, freshPositions, freshOrders] = await Promise.all([
          getPositionMode(), getMarginType(symbol), getPositions(symbol), getOpenOrders(symbol),
        ]);
        validateEmergencyVstLongExit({
          mode: freshMode, marginType: freshMarginType,
          positions: freshPositions, orders: freshOrders, name,
          positionId: expectedPositionId, quantity: size,
        });
      },
    });
  }

  function requireVstBtc(symbol) {
    if (environment !== "vst") {
      throw new BingXLiveApiError("VST test operations are unavailable outside the VST environment");
    }
    if (symbol !== "BTCUSDT") {
      throw new BingXLiveApiError("VST test operations are restricted to BTCUSDT");
    }
    return symbolName(symbol);
  }

  function requireFlatSymbol(positions, name) {
    if (positions.some((position) => !position || typeof position !== "object" ||
        typeof position.symbol !== "string")) {
      throw new BingXLiveApiError("VST test operation received an unidentified position row");
    }
    const sameSymbol = positions.filter((position) => position?.symbol === name);
    if (sameSymbol.some((position) => {
      const amount = validPositionAmount(position);
      return amount !== 0 ||
        !["BOTH", "LONG", "SHORT"].includes(position.positionSide);
    })) {
      throw new BingXLiveApiError("VST test operation requires a verified flat BTCUSDT position");
    }
  }

  async function setVstLongLeverage10(symbol) {
    if (environment !== "vst") {
      throw new BingXLiveApiError("VST LONG leverage preparation is unavailable outside VST");
    }
    const name = symbolName(symbol);
    const [filters, positions, orders, marginType, mode, current] = await Promise.all([
      contract(symbol),
      getPositions(symbol),
      getOpenOrders(symbol),
      getMarginType(symbol),
      getPositionMode(),
      getLeverage(symbol),
    ]);
    if (filters.symbol !== name) {
      throw new BingXLiveApiError("VST LONG leverage requires validated contract metadata for this symbol");
    }
    if (mode !== "HEDGE") {
      throw new BingXLiveApiError("VST LONG leverage preparation requires HEDGE mode");
    }
    if (marginType !== PROFILE_MARGIN) {
      throw new BingXLiveApiError("VST LONG leverage preparation requires isolated margin");
    }
    requireFlatSymbolFor(symbol, positions, name);
    if (orders.length !== 0) {
      throw new BingXLiveApiError(`VST LONG leverage preparation requires no ${symbol} open orders`);
    }
    const originalShortLeverage = current.shortLeverage;
    if (current.longLeverage === PROFILE_LEVERAGE) {
      // Idempotent already-configured path: the GET above independently reads
      // both sides; no write is needed and the SHORT value remains untouched.
      return {
        symbol: name,
        positionMode: mode,
        marginType,
        longLeverage: PROFILE_LEVERAGE,
        shortLeverage: originalShortLeverage,
        changed: false,
        verified: true,
      };
    }
    await request("POST", PATH.leverage, {
      symbol: name, leverage: PROFILE_LEVERAGE, side: "LONG",
    }, {
      beforeSign: async () => {
        const [freshPositions, freshOrders, freshMarginType, freshMode, freshLeverage] =
          await Promise.all([
            getPositions(symbol), getOpenOrders(symbol), getMarginType(symbol),
            getPositionMode(), getLeverage(symbol),
          ]);
        if (freshMode !== "HEDGE" || freshMarginType !== PROFILE_MARGIN) {
          throw new BingXLiveApiError("VST LONG leverage final HEDGE/isolated check failed");
        }
        requireFlatSymbolFor(symbol, freshPositions, name);
        if (freshOrders.length !== 0 ||
            freshLeverage.longLeverage !== current.longLeverage ||
            freshLeverage.shortLeverage !== originalShortLeverage) {
          throw new BingXLiveApiError(
            "VST LONG leverage settings or flat/no-order state changed before write",
          );
        }
      },
    });
    const verified = await getLeverage(symbol);
    if (verified.longLeverage !== PROFILE_LEVERAGE ||
        verified.shortLeverage !== originalShortLeverage) {
      throw new BingXLiveApiError(
        "VST LONG leverage write failed independent LONG/SHORT read-after-write verification",
      );
    }
    return {
      symbol: name,
      positionMode: mode,
      marginType,
      longLeverage: verified.longLeverage,
      shortLeverage: verified.shortLeverage,
      changed: true,
      verified: true,
    };
  }

  function requireFlatSymbolFor(symbol, positions, name) {
    if (positions.some((position) => !position || typeof position !== "object" ||
        typeof position.symbol !== "string")) {
      throw new BingXLiveApiError("VST leverage preparation received an unidentified position row");
    }
    const sameSymbol = positions.filter((position) => position.symbol === name);
    if (sameSymbol.some((position) => {
      const amount = validPositionAmount(position);
      return amount === null || amount !== 0 ||
        !["BOTH", "LONG", "SHORT"].includes(position.positionSide);
    })) {
      throw new BingXLiveApiError(`VST LONG leverage preparation requires flat ${symbol}`);
    }
  }

  async function setVstLeverage(symbol, leverage, side) {
    const name = requireVstBtc(symbol);
    if (leverage !== 10 && leverage !== 75) {
      throw new BingXLiveApiError("VST test leverage must be 10 or the prior 75 for restoration");
    }
    if (side !== "LONG" && side !== "SHORT") {
      throw new BingXLiveApiError("VST test leverage side must be LONG or SHORT");
    }

    const [positions, orders, marginType, mode, currentLeverage] = await Promise.all([
      getPositions(symbol), getOpenOrders(symbol), getMarginType(symbol), getPositionMode(),
      getLeverage(symbol),
    ]);
    requireFlatSymbol(positions, name);
    if (orders.length !== 0) {
      throw new BingXLiveApiError("VST test leverage requires no BTCUSDT open orders");
    }
    if (marginType !== "ISOLATED") {
      throw new BingXLiveApiError("VST test leverage requires exchange-verified isolated margin");
    }
    if (mode !== "HEDGE" && mode !== "ONE_WAY") {
      throw new BingXLiveApiError("VST test leverage requires a known position mode");
    }

    const requestSide = mode === "HEDGE" ? side : "BOTH";
    const priorValue = leverage === 10 ? 75 : 10;
    if (requestSide === "BOTH") {
      if (currentLeverage.longLeverage !== priorValue ||
          currentLeverage.shortLeverage !== priorValue) {
        throw new BingXLiveApiError(
          `VST test leverage transition requires both settings to be ${priorValue}x first`,
        );
      }
    } else if (currentLeverage[requestSide === "LONG" ? "longLeverage" : "shortLeverage"] !==
        priorValue) {
      throw new BingXLiveApiError(
        `VST test leverage transition requires the ${requestSide} setting to be ${priorValue}x first`,
      );
    }
    await request("POST", PATH.leverage, {
      symbol: name, leverage, side: requestSide,
    });
    const verified = await getLeverage(symbol);
    const verifiedLeverage = requestSide === "LONG"
      ? verified.longLeverage : requestSide === "SHORT"
        ? verified.shortLeverage : null;
    if ((verifiedLeverage !== null && verifiedLeverage !== leverage) ||
        (requestSide === "BOTH" &&
         (verified.longLeverage !== leverage || verified.shortLeverage !== leverage))) {
      throw new BingXLiveApiError("VST test leverage write could not be verified by GET");
    }
    return { symbol: name, leverage, side: requestSide, verified };
  }

  async function setVstIsolatedMarginForFlatSymbol(symbol) {
    if (environment !== "vst") {
      throw new BingXLiveApiError(
        "VST isolated-margin preparation is unavailable outside VST",
      );
    }
    const name = symbolName(symbol);
    const [mode, positions, orders, marginType, filters, quote] = await Promise.all([
      getPositionMode(), getPositions(), getOpenOrders(), getMarginType(symbol),
      contract(symbol), getVstMarkPrice(symbol),
    ]);
    if (mode !== "HEDGE") {
      throw new BingXLiveApiError(
        "VST isolated-margin preparation requires HEDGE position mode",
      );
    }
    // Scoped to THIS symbol only, matching every other guard in the
    // multi-symbol design (vst-broker.mjs's performIntentUnclassified already
    // checks prepare_margin_mode this way). A different symbol's open
    // position -- e.g. another trade the bot is actively managing -- is
    // independent exposure, never evidence this symbol's margin-mode prep is
    // unsafe. Checking the whole account here would mean no second symbol
    // could ever onboard into isolated margin while any position is open,
    // permanently blocking concurrent multi-symbol trading.
    if (!Array.isArray(positions) || !Array.isArray(orders)) {
      throw new BingXLiveApiError(
        "VST isolated-margin preparation requires a valid account state read",
      );
    }
    if (positions.some((position) => position && typeof position === "object" &&
        position.symbol === name && validPositionAmount(position) !== 0)) {
      throw new BingXLiveApiError(
        `VST isolated-margin preparation requires ${name} to be flat`,
      );
    }
    if (orders.some((order) => order?.symbol === name)) {
      throw new BingXLiveApiError(
        `VST isolated-margin preparation requires no open orders for ${name}`,
      );
    }
    if (marginType !== "CROSSED" && marginType !== "ISOLATED") {
      throw new BingXLiveApiError(
        `VST isolated-margin preparation found unsupported margin type for ${name}`,
      );
    }
    const quoteAge = clock() - Number(quote?.timestamp);
    if (quote?.symbol !== name || !Number.isFinite(Number(quote?.markPrice)) ||
        Number(quote.markPrice) <= 0 || !Number.isFinite(quoteAge) ||
        quoteAge < -2_000 || quoteAge > 10_000 || filters?.symbol !== name) {
      throw new BingXLiveApiError(
        `VST isolated-margin preparation requires a fresh ${name} contract quote`,
      );
    }

    // Target is this worker's margin mode (ISOLATED for the owner).
    if (marginType !== PROFILE_MARGIN) {
      if (submittedVstIsolatedMarginSymbols.has(name)) {
        throw new BingXLiveApiError(
          `VST isolated-margin POST for ${name} was already submitted; reconcile read-only`,
        );
      }
      await request("POST", PATH.marginType, {
        symbol: name, marginType: PROFILE_MARGIN,
      }, {
        beforeSign: async () => {
          if (submittedVstIsolatedMarginSymbols.has(name)) {
            throw new BingXLiveApiError(
              `VST isolated-margin POST for ${name} was already submitted; reconcile read-only`,
            );
          }
          // The initial snapshot is only planning evidence. Recheck the
          // symbol-specific safety conditions after any queued pacing or
          // rate-limit delay, immediately before reserving/signing this POST.
          const [freshMode, freshPositions, freshOrders, freshMarginType] =
            await Promise.all([
              getPositionMode(), getPositions(), getOpenOrders(),
              getMarginType(symbol),
            ]);
          if (freshMode !== "HEDGE") {
            throw new BingXLiveApiError(
              "VST isolated-margin preparation requires HEDGE position mode",
            );
          }
          if (!Array.isArray(freshPositions) ||
              freshPositions.some((position) => position &&
                typeof position === "object" && position.symbol === name &&
                validPositionAmount(position) !== 0)) {
            throw new BingXLiveApiError(
              `VST isolated-margin preparation requires ${name} to be flat`,
            );
          }
          if (!Array.isArray(freshOrders) ||
              freshOrders.some((order) => order?.symbol === name)) {
            throw new BingXLiveApiError(
              `VST isolated-margin preparation requires no open orders for ${name}`,
            );
          }
          if (freshMarginType === PROFILE_MARGIN) {
            throw new BingXLiveApiError(
              `VST isolated-margin state for ${name} changed before submission`,
            );
          }
          submittedVstIsolatedMarginSymbols.add(name);
        },
      });
    }

    const [verifiedMode, verifiedMarginType, finalPositions, finalOrders] =
      await Promise.all([
        getPositionMode(), getMarginType(symbol), getPositions(), getOpenOrders(),
      ]);
    if (verifiedMode !== "HEDGE" || verifiedMarginType !== PROFILE_MARGIN ||
        !Array.isArray(finalPositions) || !Array.isArray(finalOrders) ||
        finalPositions.some((position) => position && typeof position === "object" &&
          position.symbol === name && validPositionAmount(position) !== 0) ||
        finalOrders.some((order) => order?.symbol === name)) {
      throw new BingXLiveApiError(
        `VST isolated-margin transition for ${name} failed final flatness verification`,
      );
    }
    return {
      verified: true,
      symbol: name,
      priorMarginType: marginType,
      marginType: verifiedMarginType,
      changed: marginType !== PROFILE_MARGIN,
      positionMode: verifiedMode,
      positionsFlat: true,
      openOrdersEmpty: true,
      contractVerified: true,
      markPrice: String(quote.markPrice),
      quoteTimestamp: quote.timestamp,
    };
  }

  async function cancelVstOrder(symbol, identifier) {
    const name = requireVstBtc(symbol);
    const byId = identifier !== null && typeof identifier === "object"
      ? identifier : { orderId: identifier };
    const hasOrderId = byId.orderId !== undefined && byId.orderId !== null;
    const hasClientId = typeof byId.clientOrderId === "string" &&
      byId.clientOrderId.trim() !== "";
    if (hasOrderId === hasClientId ||
        (hasClientId && Object.keys(byId).some((key) => key !== "clientOrderId")) ||
        (hasOrderId && Object.keys(byId).some((key) => key !== "orderId"))) {
      throw new TypeError("Provide exactly one exact orderId or clientOrderId");
    }
    const exactOrderId = hasOrderId
      ? orderIdentifier(byId.orderId, "VST cancellation order ID") : null;
    const exactClientId = hasClientId ? byId.clientOrderId : null;
    const matchesIdentifier = (order) => {
      if (exactClientId !== null) return order.clientOrderId === exactClientId;
      const orderId = orderIdentifierFrom(order, "open order ID");
      if (order.orderId != null && order.orderID != null &&
          orderIdentifier(order.orderId, "open order ID") !==
            orderIdentifier(order.orderID, "open order ID")) {
        throw new BingXLiveApiError("BingX open order contains conflicting order IDs");
      }
      return orderId === exactOrderId;
    };
    const requireCancelable = (order) => {
      const protectiveFields = [
        "stopPrice", "triggerPrice", "stopLoss", "takeProfit", "mainOrderId",
        "parentOrderId", "closePosition", "reduceOnly",
      ];
      if (order.symbol !== name || order.status !== "NEW" || order.type !== "LIMIT" ||
          protectiveFields.some((key) => order[key] !== undefined &&
            order[key] !== null && order[key] !== false && order[key] !== "")) {
        throw new BingXLiveApiError(
          "VST cancellation only permits an identified plain LIMIT order, never a protective order",
        );
      }
    };

    const [positions, orders] = await Promise.all([
      getPositions(symbol), getOpenOrders(symbol),
    ]);
    requireFlatSymbol(positions, name);
    const identified = orders.filter(matchesIdentifier);
    if (identified.length !== 1) {
      throw new BingXLiveApiError("VST cancellation requires exactly one matching open order");
    }
    const openOrder = identified[0];
    requireCancelable(openOrder);

    const queried = await queryOrder(symbol, exactClientId !== null
      ? { clientOrderId: exactClientId } : { orderId: exactOrderId });
    if (!queried || queried.symbol !== name || queried.status !== "NEW" ||
        !matchesIdentifier(queried)) {
      throw new BingXLiveApiError("VST cancellation order identity is not verified as open");
    }
    const deleteParams = {
      symbol: name,
      ...(exactClientId !== null
        ? { clientOrderId: exactClientId } : { orderId: exactOrderId }),
    };
    await request("DELETE", PATH.order, deleteParams);

    const [finalOrder, remainingOrders, fills] = await Promise.all([
      queryOrder(symbol, exactClientId !== null
        ? { clientOrderId: exactClientId } : { orderId: exactOrderId }),
      getOpenOrders(symbol),
      queryFills(symbol, {
        startTs: 1,
        endTs: Math.max(1, Math.floor(clock())),
        orderId: exactOrderId ?? openOrder.orderId ?? openOrder.orderID,
        currency: "USDT",
      }),
    ]);
    if (!finalOrder || finalOrder.symbol !== name ||
        !["CANCELED", "CANCELLED"].includes(finalOrder.status) ||
        !matchesIdentifier(finalOrder) ||
        remainingOrders.some(matchesIdentifier) || fills.length !== 0) {
      throw new BingXLiveApiError("VST cancellation final state is not verified as cancelled with no fills");
    }
    for (const field of ["executedQty", "cumExecQty", "filledQty"]) {
      if (finalOrder[field] !== undefined &&
          strictNumeric(finalOrder[field], `final order ${field}`) !== 0) {
        throw new BingXLiveApiError("VST cancellation final order reports fills");
      }
    }
    return { symbol: name, status: finalOrder.status, order: finalOrder, fills };
  }

  return Object.freeze(instrumentVstApi({
    withStopTransferJournal,
    withVstPreparationReads,
    preflight,
    contract,
    getRiskTiers,
    getFeeRate,
    getFunding,
    getBalance,
    getPositions,
    getPositionMarginHistory,
    getOpenOrders,
    getPositionMode,
    getLeverage,
    getMarginType,
    placeLong,
    placeVstBoundedLong,
    placeVstOnePercentBoundedLong,
    placeVstAutomatedLong,
    getVstMarkPrice,
    getVstOpenPositionMark,
    getVstLastPrices,
    placeVstAdditionalLongStop,
    upgradeVstLongStop,
    placeVstVirtualSplitLongStop,
    cancelVstAttachedLongStopAfterSplit,
    closeVstVirtualSplitTranche,
    cancelVstSplitStopAfterPartial,
    placeVstAutomatedVirtualSplitLongStop,
    cancelVstAutomatedAttachedLongStopAfterSplit,
    closeVstAutomatedSplitTranche,
    cancelVstAutomatedSplitStopAfterPartial,
    cancelVstAutomatedOriginalAfterTriggeredRunner,
    placeVstAutomatedSplitLegStopUpgrade,
    cancelVstAutomatedSplitLegStopUpgrade,
    closeVstAutomatedSoleSplitLeg,
    closeVstAutomatedFullSplitPosition,
    closeVstAutomatedPreRunnerSplit,
    cancelVstAutomatedKnownStopWhenFlat,
    cancelVstProtectiveStopOnlyWhenFlat,
    discoverVstAutomatedLongStop,
    queryOrder,
    retireVstAutomatedAdoptedStop,
    queryOrderHistory,
    queryFundingSettlements,
    queryClosedTradeIncome,
    queryForcedOrders,
    queryFills,
    queryCompleteFillHistory,
    // allFillOrders remains non-proof; only the bounded recent fillHistory
    // snapshot collector establishes completeness, and only on VST.
    supportsCompleteFillHistory: environment === "vst",
    reconcilePositionAndStop,
    assessProtectiveStopAmendment,
    discoverAttachedStop,
    auditProtectiveStopCoverage,
    // Attached stop creation has no documented, durable child-order ID in
    // the entry response. Do not expose live entries before it can be proven.
    canVerifyAttachedProtectionOnEntry: async () => false,
    addIsolatedMargin,
    addVstIsolatedLongMargin,
    closeLong,
    emergencyCloseVstLong,
    setVstLongLeverage10,
    setVstLeverage,
    setVstIsolatedMarginForFlatSymbol,
    positionProfile: PROFILE,
    cancelVstOrder,
  }, environment));
}