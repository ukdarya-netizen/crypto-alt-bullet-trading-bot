import { OWNER_POSITION_PROFILE, allocationBudget, isOwnerProfile, normalizePositionProfile } from "./vst-position-profile.mjs";
import { createHash } from "node:crypto";
import { directCloseEvidenceValid } from "./source-command-contract.mjs";
import { FULL_TAKE_REASON, fullTakeEvidenceValid } from "./fixed-price-take-profit.mjs";
import {
  archiveOrderId, archiveParentIds, validateArchiveWindow, selectArchiveChain,
  FILL_ARCHIVE_RETENTION_MS, freezeArchiveWindow, archiveParentLookupMatches,
  archiveParentLookupMatchesChild,
} from "./vst-fill-archive.mjs";
import {
  VST_AUTOMATED_LONG_POLICY, isSymbolOfflineError, isDefiniteExchangeRejection, positionInitialMargin,
} from "./bingx-live-api.mjs";
import { calculateVstMarginTopUp } from "./vst-margin-plan.mjs";
import {
  deriveVstExchangeClientOrderId, verifyHistoricalCloseEvidence,
  isVerifiedEntryCloseCandidate,
} from "./vst-historical-close-evidence.mjs";
import { corroborateVstActiveStopPosition } from "./vst-active-stop-corroboration.mjs";
import {
  attachVstResultDiagnostic,
  recordVstDiagnostic,
  recordVstRefusal,
  recordVstStopObservation,
} from "./vst-diagnostics.mjs";
import { buildVstStopEvidence } from "./vst-stop-evidence.mjs";
import { buildVstProofEvidence } from "./vst-proof-evidence.mjs";
import { validateProtectedExit } from "./vst-protected-exit.mjs";
import { createNativeTakeManager, proveNativeTakeFill } from "./native-full-take.mjs";

const evidencePair = (expected, actual, matches = expected === actual) =>
  ({ expected, actual, matches });
const apiMarketProofGenerations = new WeakMap();
function evidenceMatches(callback) {
  try { return callback(); } catch { return "unreadable"; }
}
function evidenceDecimalMatches(left, right) {
  // Do not invoke trading validators while preparing a log (or emit new errors).
  return evidenceMatches(() => {
    const parse = (value) => {
      const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
      if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) throw new Error("unreadable_decimal");
      const [whole, fraction = ""] = text.replace(/^[+-]/, "").split(".");
      if (fraction.length > 30) throw new Error("unreadable_decimal");
      return { scale: fraction.length, amount: BigInt(`${whole}${fraction}`) *
        (text.startsWith("-") ? -1n : 1n) };
    };
    return sameDecimal(parse(left), parse(right));
  });
}

function recordProofResult(result, { source, condition, symbol, sourceSignalId, check, operation = "reconcile" }, inspect, error) {
  try {
    let values = {};
    try { values = typeof inspect === "function" ? inspect() : inspect ?? {}; } catch {}
    const context = {
      stage: "broker_read", operation, check, symbol, sourceSignalId,
      proofEvidence: buildVstProofEvidence({ source, condition, checks: values }),
    };
    const diagnostic = error ? recordVstDiagnostic(error, context)
      : recordVstRefusal(check === "protective_stop" ? "stop_proof_unverified"
        : "position_proof_unverified", context);
    return attachVstResultDiagnostic(result, diagnostic);
  } catch { return result; }
}

function invalidPrimitiveError(value, label, { allowZero = false, signed = false,
  identifier = false, violation = "numeric_format" } = {}) {
  const error = new Error(`bingx_vst_${identifier ? "unidentified" : "invalid"}_${label}`);
  try {
    recordVstDiagnostic(error, {
      proofEvidence: buildVstProofEvidence({
        source: "broker_validation",
        condition: identifier ? "identifier_validation" : "decimal_validation",
        validationField: label,
        checks: identifier ? {
          identifierValue: evidencePair(undefined, value, false),
          identifierPresent: evidencePair(true, false),
          validationRule: evidencePair(undefined, "empty_or_unsafe_identifier", true),
        } : {
          numericValue: evidencePair(undefined, value, false),
          numericValid: evidencePair(true, false),
          numericRequirement: evidencePair(undefined, signed
            ? allowZero ? "signed_decimal" : "signed_nonzero_decimal"
            : allowZero ? "nonnegative_decimal" : "positive_decimal", true),
          validationRule: evidencePair(undefined, violation, true),
        },
      }),
    });
  } catch {}
  return error;
}

const submittedTriggeredRunnerCancellationIntents = new Set();
const submittedTriggeredRunnerCancellationIdentities = new Set();
// BingX rejects a window that was exactly 24h old when the API checks its
// clock a few milliseconds after the caller calculated startTs.
const MAX_HISTORY_WINDOW_MS = 23 * 60 * 60 * 1000;
const SOURCE_ENTRY_MAX_FILL_WINDOW_MS = 10 * 60 * 1000;
const SOURCE_ENTRY_FILL_END_PADDING_MS = 30_000;
const SOURCE_ENTRY_HISTORY_MAX_AGE_MS = FILL_ARCHIVE_RETENTION_MS;
const MAX_UNPAGINATED_ROWS = 500;
const POSITION_ACCOUNT_STATE_CONTEXT_MAX_AGE_MS = 2_000;
// Immutable history uses several paced reads. The last account-wide pair must
// still be fresh enough for the worker/store CAS; native-write limits stay intact.
const RUNNER_FILL_RECOVERY_HISTORY_MAX_DURATION_MS = 30_000;
const RUNNER_FILL_RECOVERY_FINAL_PAIR_MAX_DURATION_MS = 5_000;
const SOURCE_EXIT_PROOF_MAX_DURATION_MS = 120_000;
const SOURCE_EXIT_FINAL_PAIR_MAX_DURATION_MS = 5_000;
const ORIGINAL_STOP_CANCEL_ENDPOINT = "/openApi/swap/v2/trade/order";
function proofRefusal(reason, check, symbol, sourceSignalId) {
  const diagnostic = recordVstRefusal(reason, {
    stage: "entry_proof", operation: "entry", check, symbol, sourceSignalId,
  });
  return attachVstResultDiagnostic({ verified: false, status: "unknown" }, diagnostic);
}
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

function setOriginalStopCancellationProvenance(error, mutationRequestSent) {
  if (!(error instanceof Error)) return error;
  error.mutationProvenance = Object.freeze({
    operation: "cancel_original_stop",
    mutationMethod: "DELETE",
    mutationEndpoint: ORIGINAL_STOP_CANCEL_ENDPOINT,
    mutationRequestSent,
    phase: mutationRequestSent ? "mutation_transport_started" : "pre_mutation_read",
  });
  return error;
}

function hasProvenOriginalStopCancelNoSend(error) {
  const provenance = error?.mutationProvenance;
  return provenance?.operation === "cancel_original_stop" &&
    provenance.mutationMethod === "DELETE" &&
    provenance.mutationEndpoint === ORIGINAL_STOP_CANCEL_ENDPOINT &&
    provenance.mutationRequestSent === false &&
    provenance.phase === "pre_mutation_read";
}

function validAccountAlias(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function finitePositive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw invalidPrimitiveError(value, label, { violation: "nonfinite_or_sign" });
  }
  return number;
}

function strictNumber(value, label, { allowZero = false } = {}) {
  const text = typeof value === "string" || typeof value === "number"
    ? String(value) : "";
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw invalidPrimitiveError(value, label, { allowZero });
  const number = Number(text);
  if (!Number.isFinite(number) || (!allowZero && number <= 0) ||
      (allowZero && number < 0)) {
    throw invalidPrimitiveError(value, label, { allowZero, violation: "nonfinite_or_sign" });
  }
  return number;
}

function exactDecimal(value, label, { allowZero = false, signed = false } = {}) {
  if (typeof value === "number" &&
      (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) {
    throw invalidPrimitiveError(value, label, { allowZero, signed, violation: "not_finite_or_unsafe_number" });
  }
  const text = typeof value === "string" || typeof value === "number"
    ? String(value) : "";
  const pattern = signed ? /^[+-]?\d+(?:\.\d+)?$/ : /^\d+(?:\.\d+)?$/;
  if (!pattern.test(text)) throw invalidPrimitiveError(value, label, { allowZero, signed });
  const negative = text.startsWith("-");
  const unsigned = text.replace(/^[+-]/, "");
  const [whole, fraction = ""] = unsigned.split(".");
  if (fraction.length > 30) throw invalidPrimitiveError(value, label, {
    allowZero, signed, violation: "decimal_scale_exceeds_30",
  });
  const scale = fraction.length;
  const amount = BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n);
  if (!signed && (amount < 0n || amount === 0n && !allowZero) ||
      signed && amount === 0n && !allowZero) {
    throw invalidPrimitiveError(value, label, { allowZero, signed, violation: "zero_or_sign" });
  }
  return { amount, scale };
}

function decimalAtScale(value, scale) {
  return value.amount * (10n ** BigInt(scale - value.scale));
}

function sameDecimal(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return decimalAtScale(left, scale) === decimalAtScale(right, scale);
}

function compareDecimal(left, right) {
  const scale = Math.max(left.scale, right.scale);
  const a = decimalAtScale(left, scale);
  const b = decimalAtScale(right, scale);
  return a < b ? -1 : a > b ? 1 : 0;
}

function subtractDecimal(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return { amount: decimalAtScale(left, scale) - decimalAtScale(right, scale), scale };
}

function withinHalfStoredUnit(value, baseline) {
  const scale = Math.max(value.scale, baseline.scale) + 1;
  const difference = decimalAtScale(value, scale) - decimalAtScale(baseline, scale);
  const absoluteDifference = difference < 0n ? -difference : difference;
  const halfUnit = 5n * (10n ** BigInt(scale - baseline.scale - 1));
  return absoluteDifference <= halfUnit;
}

function decimalText(value) {
  return formatSignedDecimal(value.amount, value.scale);
}

function exactIdentifier(value, label) {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  throw invalidPrimitiveError(value, label, { identifier: true });
}

function symbolName(symbol) {
  if (typeof symbol !== "string" || !/^[A-Z0-9]{1,20}USDT$/.test(symbol)) {
    throw new TypeError("A canonical USDT perpetual symbol is required");
  }
  return `${symbol.slice(0, -4)}-USDT`;
}

function rowIdentifier(row, fields, label) {
  const values = fields.map((field) => row?.[field])
    .filter((value) => value !== undefined && value !== null)
    .map((value) => exactIdentifier(value, label));
  if (values.length === 0 || new Set(values).size !== 1) {
    const error = new Error(`bingx_vst_${label}_missing_or_conflicting`);
    try {
      recordVstDiagnostic(error, {
        proofEvidence: buildVstProofEvidence({
          source: "broker_validation", condition: "identifier_aliases",
          validationField: label,
          checks: {
            identifierAliases: evidencePair(undefined, values, false),
            identifierPresent: evidencePair(true, values.length > 0),
            identifierAliasesAgree: evidencePair(true, new Set(values).size === 1),
          },
        }),
      });
    } catch {}
    throw error;
  }
  return values[0];
}

function orderId(order) {
  return rowIdentifier(order, ["orderId", "orderID"], "order_id");
}

function positionId(position) {
  return rowIdentifier(position, ["positionId", "positionID"], "position_id");
}

const EXECUTION_QUANTITY_ALIASES = Object.freeze([
  "executedQty", "executedQuantity", "cumExecQty", "filledQty",
]);

function explicitZeroExecutionProof(row, expectedOrderId) {
  try {
    if (!object(row) || orderId(row) !== expectedOrderId ||
        !Object.hasOwn(row, "executedQty")) return null;
    const proof = { orderId: expectedOrderId };
    for (const field of EXECUTION_QUANTITY_ALIASES) {
      if (!Object.hasOwn(row, field)) continue;
      const value = row[field];
      if (value === undefined || value === null ||
          !sameDecimal(exactDecimal(value, "stop_executed_quantity", {
            allowZero: true,
          }), exactDecimal("0", "zero", { allowZero: true }))) return null;
      proof[field] = value;
    }
    return Object.hasOwn(proof, "executedQty") ? proof : null;
  } catch {
    return null;
  }
}

function asMillis(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const milliseconds = number < 100_000_000_000 ? number * 1000 : number;
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function normalizeClientOrderId(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("A stable clientOrderId is required");
  }
  // BingX accepts at most 32 characters; worker IDs are 34 characters.
  // Hashing the full ID preserves deterministic identity without truncation.
  return `vst-${createHash("sha256").update(value).digest("hex").slice(0, 28)}`;
}

function closeEnough(left, right, relativeBase = right) {
  return Math.abs(Number(left) - Number(right)) <= Math.max(1e-10, Math.abs(Number(relativeBase)) * 1e-8);
}

function fillQty(fill) {
  return strictNumber(fill.qty ?? fill.quantity ?? fill.volume, "fill_quantity");
}

function fillPrice(fill) {
  return strictNumber(fill.price, "fill_price");
}

function fillTime(fill) {
  const value = fill.filledTm ?? fill.filledTime ?? fill.time ??
    fill.timestamp ?? fill.tradeTime;
  const numericTime = asMillis(value);
  if (numericTime !== null) return numericTime;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function commissionParts(value) {
  const text = typeof value === "string" || typeof value === "number"
    ? String(value) : "";
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(Number(text))) {
    throw new Error("bingx_vst_invalid_fill_commission");
  }
  const negative = text.startsWith("-");
  const unsigned = text.replace(/^[+-]/, "");
  const [whole, fraction = ""] = unsigned.split(".");
  if (fraction.length > 30) throw new Error("bingx_vst_invalid_fill_commission");
  const magnitude = BigInt(`${whole}${fraction}`);
  return { value: negative ? -magnitude : magnitude, scale: fraction.length };
}

function commissionAsset(fill) {
  const assets = [fill.currency, fill.commissionAsset]
    .filter((value) => value !== undefined && value !== null);
  if (assets.length === 0 || assets.some((value) =>
    typeof value !== "string" || !/^[A-Z0-9]{2,12}$/.test(value)) ||
      new Set(assets).size !== 1) {
    throw new Error("bingx_vst_fill_commission_asset_unverified");
  }
  return assets[0];
}

function formatSignedDecimal(value, scale) {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  if (scale === 0) return `${negative ? "-" : ""}${digits}`;
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function aggregateCommissions(entries) {
  const byAsset = new Map();
  for (const { asset, parts } of entries) {
    const group = byAsset.get(asset) ?? [];
    group.push(parts);
    byAsset.set(asset, group);
  }
  return [...byAsset].map(([currency, values]) => {
    const scale = Math.max(...values.map(({ scale: itemScale }) => itemScale));
    const amount = values.reduce((sum, parts) =>
      sum + parts.value * (10n ** BigInt(scale - parts.scale)), 0n);
    return { currency, amount: formatSignedDecimal(amount, scale) };
  });
}

function orderClientId(row) {
  const ids = [row?.clientOrderId, row?.clientOrderID]
    .filter((value) => value !== undefined && value !== null);
  return ids.length > 0 && ids.every((value) => typeof value === "string") &&
    new Set(ids).size === 1 ? ids[0] : null;
}

function createPositionSnapshot({
  symbol, accountId, mode, marginMode, leverage, row, orders, persistedStopsByPosition,
  verifiedPersistedStops, verifiedOriginalStop, pricePrecision, evidenceSource,
}) {
  const amount = row ? strictNumber(row.positionAmt, "position_quantity", { allowZero: true }) : 0;
  const activeStops = orders.filter((item) =>
    item?.type === "STOP_MARKET" && item?.status === "NEW" &&
    item?.side === "SELL" && item?.positionSide === "LONG");
  const stops = {};
  if (!verifiedPersistedStops && row && amount > 0 &&
      orders.length === 1 && activeStops.length === 1) {
    const stop = activeStops[0];
    const stopPositionId = positionId(stop);
    const currentPositionId = positionId(row);
    const stopQuantity = strictNumber(stop.origQty ?? stop.quantity, "protective_stop_quantity");
    if (stop.symbol === symbolName(symbol) && stopPositionId === currentPositionId &&
        closeEnough(stopQuantity, amount, amount)) {
      stops.core = {
        verified: true,
        stopPrice: strictNumber(stop.stopPrice, "protective_stop_price"),
        quantity: stopQuantity,
        orderId: orderId(stop),
        positionId: currentPositionId,
      };
    }
  }
  if (verifiedPersistedStops) {
    for (const tranche of ["core", "runner"]) {
      const stop = verifiedPersistedStops[tranche];
      if (!stop) continue;
      stops[tranche] = {
        verified: true,
        stopPrice: strictNumber(stop.stopPrice, `${tranche}_persisted_stop_price`),
        quantity: strictNumber(stop.quantity, `${tranche}_persisted_stop_quantity`),
        orderId: stop.orderId,
        positionId: positionId(row),
      };
    }
  }
  const persistedStops = verifiedPersistedStops
    ? null
    : persistedStopsByPosition.get(row ? positionId(row) : "");
  if (row && amount > 0 && persistedStops) {
    for (const tranche of ["core", "runner"]) {
      const id = persistedStops[tranche];
      if (!id) continue;
      const expectedStop = typeof id === "string" ? { orderId: id } : id;
      const matches = activeStops.filter((item) => {
        try {
          return orderId(item) === expectedStop.orderId &&
            positionId(item) === positionId(row) &&
            item.symbol === symbolName(symbol) &&
            (expectedStop.quantity === undefined ||
              closeEnough(strictNumber(item.origQty ?? item.quantity,
                "protective_stop_quantity"), expectedStop.quantity,
              expectedStop.quantity)) &&
            (expectedStop.stopPrice === undefined ||
              closeEnough(strictNumber(item.stopPrice, "protective_stop_price"),
                expectedStop.stopPrice, expectedStop.stopPrice));
        } catch {
          return false;
        }
      });
      if (matches.length !== 1) {
        continue;
      }
      const stop = matches[0];
      stops[tranche] = {
        verified: true,
        stopPrice: strictNumber(stop.stopPrice, "protective_stop_price"),
        quantity: strictNumber(stop.origQty ?? stop.quantity, "protective_stop_quantity"),
        orderId: expectedStop.orderId,
        positionId: positionId(row),
      };
    }
  }
  const expectedStops = {
    ...(verifiedPersistedStops ?? persistedStops ?? (
      row && amount > 0 ? { core: { quantity: amount } } : {})),
    ...(verifiedOriginalStop ? { original: verifiedOriginalStop } : {}),
  };
  // An original-only snapshot is a valid split staging state, not a failed stop.
  if (verifiedOriginalStop && Object.keys(stops).length === 0) delete expectedStops.core;
  const stopEvidence = buildVstStopEvidence({
    symbol, row, orders, source: evidenceSource, expectedStops,
    verifiedStops: stops, verifiedOriginalStop, readOrderId: orderId,
    readPositionId: positionId, compareDecimal: closeEnough,
    ...(!verifiedPersistedStops && !persistedStops && row && amount > 0
      ? { expectedOpenOrderCount: 1 } : {}),
  });
  const context = { stage: "broker_read", operation: "read_position",
    check: "protective_stop", symbol, stopEvidence };
  const stopDiagnostic = !["stop_verified", "original_stop_verified",
    "position_not_present_in_response"].includes(stopEvidence.verdict)
    ? recordVstRefusal("stop_unverified", context)
    : (recordVstStopObservation(context), undefined);
  const snapshotStops = {};
  if (row && amount > 0) {
    for (const tranche of ["core", "runner"]) {
      const stop = stops[tranche];
      if (!stop) continue;
      const raw = orders.find((item) => orderId(item) === stop.orderId);
      if (!raw) continue;
      snapshotStops[tranche] = {
        verified: true,
        tranche,
        orderId: stop.orderId,
        positionId: positionId(row),
        quantity: String(raw.origQty ?? raw.quantity),
        stopPrice: String(raw.stopPrice),
      };
    }
  }
  const persistedSnapshot = row && amount > 0 ? {
    verified: true,
    environment: "vst",
    accountId,
    symbol,
    positionId: positionId(row),
    quantity: String(row.positionAmt),
    protectiveStops: snapshotStops,
    ...(verifiedOriginalStop ? {
      originalStop: {
        verified: true,
        positionId: positionId(row),
        ...verifiedOriginalStop,
      },
    } : {}),
  } : null;
  const snapshot = {
    verified: true,
    environment: "vst",
    accountId,
    symbol,
    side: "Buy",
    quantity: amount,
    avgPrice: row && amount > 0
      ? strictNumber(row.avgPrice ?? row.entryPrice, "position_average_price")
      : 0,
    leverage: Number(leverage.longLeverage),
    marginMode,
    positionMode: mode,
    pricePrecision,
    ...(row && amount > 0
          ? { positionId: positionId(row) }
      : {}),
    protectiveStops: stops,
    ...(verifiedOriginalStop ? {
      originalStop: {
        verified: true,
        positionId: positionId(row),
        ...verifiedOriginalStop,
      },
    } : {}),
    ...(persistedSnapshot ? { persistedSnapshot } : {}),
  };
  return stopDiagnostic
    ? attachVstResultDiagnostic(snapshot, stopDiagnostic) : snapshot;
}

/**
 * Adapt the explicitly injected BingX API client to createVstWorker's broker
 * contract. The adapter accepts only an API client created with environment
 * "vst"; signed reads and guarded VST mutation methods are required. This
 * bridge does not construct credentials, clients, or network access itself.
 */
export function createVstBroker({
  api,
  accountId,
  canarySymbols,
  clock = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  stopBufferRate,
  maxHistoryAgeMs = 10 * 60_000,
  fillArchiveStore,
}) {
  const nativeApi = api;
  let nativeEvidenceStore = fillArchiveStore;
  // Explicit stop-proof view, not a filtered public exchange API. It excludes
  // only exact acknowledged and journalled takes verified on this native read.
  if (typeof api?.getProtectionOrders === "function")
    api = { ...api, getOpenOrders: async (symbol) => {
      if (nativeApi.nativeFullTake && typeof nativeEvidenceStore?.listNativeTakeIntents === "function")
        nativeApi.nativeFullTake.restore(await nativeEvidenceStore.listNativeTakeIntents());
      return nativeApi.getProtectionOrders(symbol);
    } };
  if (!api || typeof api.getVstMarkPrice !== "function" ||
      typeof api.placeVstAutomatedLong !== "function" ||
      typeof api.upgradeVstLongStop !== "function" ||
      typeof api.closeLong !== "function") {
    throw new TypeError("A BingX API client with VST read and write methods is required");
  }
  if (!validAccountAlias(accountId)) {
    throw new TypeError("accountId must be a stable operator-assigned VST account alias");
  }
  // Leverage and margin mode every position of this broker must have. Taken
  // from the API client so both layers always agree (owner: isolated 10x).
  const PROFILE = normalizePositionProfile(api.positionProfile ?? OWNER_POSITION_PROFILE);
  const PROFILE_LEVERAGE = PROFILE.leverage;
  const PROFILE_MARGIN = PROFILE.marginMode;
  const profileMarginIs = (value) => {
    const mode = String(value ?? "").toUpperCase();
    return (mode === "CROSS" ? "CROSSED" : mode) === PROFILE_MARGIN;
  };
  const supportsHistoricalCloseProof = api.supportsCompleteFillHistory === true
    ? true
    : api.supportsCompleteFillHistory === false ? false : undefined;
  if (!Array.isArray(canarySymbols) || canarySymbols.length === 0 ||
      canarySymbols.length > 8) {
    throw new TypeError("A small explicit VST canary symbol list is required");
  }
  let marketProofGeneration = apiMarketProofGenerations.get(api);
  if (!marketProofGeneration) {
    marketProofGeneration = { value: 0 };
    apiMarketProofGenerations.set(api, marketProofGeneration);
  }
  const startupSymbols = [...new Set(canarySymbols)];
  startupSymbols.forEach(symbolName);
  if (startupSymbols.length !== canarySymbols.length) {
    throw new TypeError("The VST canary symbol list must not contain duplicates");
  }
  const buffer = Number(stopBufferRate);
  if (!Number.isFinite(buffer) || buffer <= 0 || buffer >= 1) {
    throw new TypeError("A positive stopBufferRate below 1 must be configured explicitly");
  }
  if (!Number.isSafeInteger(maxHistoryAgeMs) || maxHistoryAgeMs <= 0) {
    throw new TypeError("maxHistoryAgeMs must be a positive safe integer");
  }
  for (const method of [
    "getBalance", "getPositions", "getOpenOrders", "getPositionMode",
    "getMarginType", "getLeverage", "contract", "getRiskTiers", "getFeeRate",
    "getFunding", "queryOrder",
    "queryOrderHistory", "queryFills",
    "setVstLongLeverage10",
  ]) {
    if (typeof api[method] !== "function") {
      throw new TypeError(`BingX VST API is missing ${method}`);
    }
  }

  const apiIntentIds = new Map();
  // Share only the lifetime of an identical signed read already in flight.
  // There is deliberately no completed-result cache: account state and mutable
  // settings are re-read for every later assessment/tick.
  const inFlightReads = new Map();
  async function readCoalescedInScope(scope, method, ...args) {
    const key = canonicalJsonStringify([scope, method, args]);
    let pending = inFlightReads.get(key);
    if (!pending) {
      pending = Promise.resolve().then(() => api[method](...args));
      inFlightReads.set(key, pending);
      void pending.finally(() => {
        if (inFlightReads.get(key) === pending) inFlightReads.delete(key);
      }).catch(() => {});
    }
    return pending;
  }
  async function readCoalesced(method, ...args) {
    return readCoalescedInScope("shared", method, ...args);
  }
  async function mapWithConcurrency(values, limit, callback) {
    const results = new Array(values.length);
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(limit, values.length) },
      async () => {
        while (nextIndex < values.length) {
          const index = nextIndex++;
          results[index] = await callback(values[index], index);
        }
      },
    );
    await Promise.all(workers);
    return results;
  }
  const sourceExitReadToken = Symbol("validated-source-exit-reconciliation");
  const accountStateReadContexts = new WeakMap();
  // Private evidence from the exact read that produced a normalized snapshot.
  // This is not a cross-operation cache and cannot be supplied by a caller.
  const positionRawReadEvidence = new WeakMap();
  let successfulLookupProbe = null;
  const lookupProbeTtlMs = 3 * 60_000;
  // Native environment quotes may be forwarded only by the exact immutable-
  // by-ownership snapshot returned from one verified position read. The
  // generation makes every outstanding proof unusable across a mutation.
  const positionMarketProofs = new WeakMap();
  let positionReadOperationId = 0;
  const splitStopObservations = new Map();
  const splitStopReconciliationInFlight = new Set();
  const splitStopObservationTtlMs = 10 * 60_000;
  const splitStopObservationLimit = 256;
  // These IDs are learned only from the explicitly persisted intent contract
  // or an adapter result which has independently verified exchange state.
  const splitStopIdsByPosition = new Map();
  const impulseAdapterMethods = [
    "placeVstAutomatedVirtualSplitLongStop",
    "cancelVstAutomatedAttachedLongStopAfterSplit",
    "closeVstAutomatedSplitTranche",
    "cancelVstAutomatedSplitStopAfterPartial",
    "placeVstAutomatedSplitLegStopUpgrade",
    "cancelVstAutomatedSplitLegStopUpgrade",
    "closeVstAutomatedSoleSplitLeg",
    "closeVstAutomatedFullSplitPosition",
    "closeVstAutomatedPreRunnerSplit",
    "cancelVstAutomatedKnownStopWhenFlat",
    "cancelVstAutomatedOriginalAfterTriggeredRunner",
  ];
  const hasIsolatedMarginPreparation =
    typeof api.setVstIsolatedMarginForFlatSymbol === "function";

  function canonicalJsonStringify(value) {
    const canonicalize = (item) => {
      if (Array.isArray(item)) return item.map(canonicalize);
      if (!object(item)) return item;
      return Object.fromEntries(Object.keys(item).sort().map((key) =>
        [key, canonicalize(item[key])]));
    };
    return JSON.stringify(canonicalize(value));
  }

  function splitStopObservationKey(clientOrderId, request) {
    if (typeof clientOrderId !== "string" || clientOrderId.trim() === "") return null;
    const canonicalRequest = canonicalJsonStringify(request);
    if (typeof canonicalRequest !== "string") return null;
    return JSON.stringify([accountId, "vst", clientOrderId, canonicalRequest]);
  }

  function pruneSplitStopObservations(now) {
    for (const [key, observation] of splitStopObservations) {
      if (!Number.isSafeInteger(now) || now <= 0 ||
          now < observation.observedAt ||
          now - observation.observedAt >= splitStopObservationTtlMs) {
        splitStopObservations.delete(key);
      }
    }
  }

  function rememberSplitStopObservation(key, signature, observedAt) {
    splitStopObservations.delete(key);
    splitStopObservations.set(key, { signature, observedAt });
    while (splitStopObservations.size > splitStopObservationLimit) {
      splitStopObservations.delete(splitStopObservations.keys().next().value);
    }
  }

  function assertSymbol(symbol) {
    return symbolName(symbol);
  }

  function invalidatePositionMarketProofs() {
    marketProofGeneration.value += 1;
  }

  async function performMutation(method, ...args) {
    invalidatePositionMarketProofs();
    successfulLookupProbe = null;
    capabilitySettingsMemo.clear();
    return api[method](...args);
  }

  // Capability-probe-only memo of per-symbol margin type + leverage, kept
  // ONLY for symbols already verified ISOLATED + LONG 10x. Without it every
  // tick re-read both settings for every open symbol (2 signed calls each
  // behind the 1.1 s VST pacer): ~8 s per tick with 1 position, ~27 s with
  // 10, so +5% takes and fresh entries waited behind the reads. Balance,
  // positions, open orders and position mode are still read every time; any
  // mutation clears the memo; every entry/leverage/margin operation re-reads
  // its own settings before signing.
  const capabilitySettingsMemo = new Map();
  const capabilitySettingsMemoTtlMs = 60_000;
  // Exchange-side, per-request failures of a settings READ: rate limit
  // (100410), VST busy (109500), transport/timeouts. Never a local bug.
  function isTransientSymbolSettingsError(error) {
    const code = Number(error?.code);
    if (code === 100410 || code === 109500) return true;
    return error?.name === "BingXLiveApiError" &&
      ["exchange_response", "network_request", "pre_transport"].includes(error?.transportStage);
  }

  async function readCapabilitySymbolSettings(symbol, now) {
    const cached = capabilitySettingsMemo.get(symbol);
    if (cached && Number.isFinite(now) && now >= cached.at &&
        now - cached.at < capabilitySettingsMemoTtlMs) {
      return { symbol, marginMode: cached.marginMode, leverage: cached.leverage };
    }
    const [marginMode, leverage] = await Promise.all([
      readCoalesced("getMarginType", symbol),
      readCoalesced("getLeverage", symbol),
    ]);
    if (marginMode === PROFILE_MARGIN && Number(leverage?.longLeverage) === PROFILE_LEVERAGE &&
        Number.isFinite(now)) {
      capabilitySettingsMemo.set(symbol, { at: now, marginMode, leverage });
    } else {
      capabilitySettingsMemo.delete(symbol);
    }
    return { symbol, marginMode, leverage };
  }


  function reportOperationTiming(startedAt, context) {
    try {
      const elapsedMs = Math.round(performance.now() - startedAt);
      if (elapsedMs >= 5_000) {
        console.log(`Bullet VST operation timing: ${JSON.stringify({ ...context, elapsedMs })}`);
      }
    } catch {
      // Observability cannot affect position protection or intent outcomes.
    }
  }

  function missingImpulseAdapterMethods() {
    return impulseAdapterMethods.filter((method) => typeof api[method] !== "function");
  }

  async function assertVstEnvironment(symbol, { openPosition = false } = {}) {
    const name = assertSymbol(symbol);
    const quote = openPosition && typeof api.getVstOpenPositionMark === "function"
      ? await api.getVstOpenPositionMark(symbol)
      : await api.getVstMarkPrice(symbol);
    const observedAt = asMillis(quote?.timestamp);
    const now = Number(clock());
    if (quote?.symbol !== name || observedAt === null ||
        !Number.isSafeInteger(now) || now <= 0 || observedAt > now ||
        now - observedAt > 10_000) {
      throw new Error("bingx_vst_environment_or_fresh_exchange_read_unverified");
    }
    let price;
    try { price = finitePositive(quote.markPrice, "mark_price"); }
    catch { return null; }
    return { symbol: name, observedAt, price, environment: "vst", accountId };
  }

  function exactMarginTopUpStop(orders, {
    symbol, positionId: expectedPositionId, quantity, stopLoss, entryOrderId,
  }) {
    if (!Array.isArray(orders) || orders.length !== 1) return null;
    const order = orders[0];
    try {
      if (order?.symbol !== symbol || order.status !== "NEW" ||
          order.type !== "STOP_MARKET" || order.side !== "SELL" ||
          order.positionSide !== "LONG" || order.workingType !== "MARK_PRICE" ||
          !sameDecimal(exactDecimal(order.origQty ?? order.quantity,
            "margin_top_up_stop_quantity"), exactDecimal(quantity,
            "margin_top_up_expected_quantity")) ||
          !sameDecimal(exactDecimal(order.stopPrice, "margin_top_up_stop_price"),
            exactDecimal(stopLoss, "margin_top_up_signal_stop")) ||
          positionId(order) !== expectedPositionId) {
        return null;
      }
      const parent = order.mainOrderId ?? order.parentOrderId;
      if (parent !== undefined && parent !== null && parent !== "" &&
          exactIdentifier(parent, "margin_top_up_stop_entry_id") !== entryOrderId) {
        return null;
      }
      return {
        orderId: orderId(order),
        positionId: expectedPositionId,
        quantity: String(order.origQty ?? order.quantity),
        stopPrice: String(order.stopPrice),
        status: order.status,
        workingType: order.workingType,
      };
    } catch {
      return null;
    }
  }

  async function readMarginTopUpBaseline(request) {
    const {
      symbol, positionId: expectedPositionId, quantity, stopLoss, entryOrderId,
    } = request ?? {};
    if (request?.environment !== "vst" || request?.accountId !== accountId) {
      throw new Error("bingx_vst_margin_top_up_baseline_account_mismatch");
    }
    const name = assertSymbol(symbol);
    const expectedId = exactIdentifier(expectedPositionId, "margin_top_up_expected_position_id");
    const entryId = exactIdentifier(entryOrderId, "margin_top_up_entry_order_id");
    await assertVstEnvironment(symbol);
    const [settings, rows, orders, accountRows] = await Promise.all([
      readSettings(symbol),
      api.getPositions(symbol),
      api.getOpenOrders(symbol),
      readGlobalAccountRows(),
    ]);
    if (settings.mode !== "HEDGE" || settings.marginMode !== PROFILE_MARGIN ||
        Number(settings.leverage.longLeverage) !== PROFILE_LEVERAGE ||
        !Number.isFinite(Number(settings.leverage.shortLeverage)) ||
        Number(settings.leverage.shortLeverage) <= 0 ||
        !Array.isArray(rows) || !Array.isArray(orders)) {
      throw new Error("bingx_vst_margin_top_up_baseline_settings_or_reads_unverified");
    }
    const active = rows.filter((row) => row?.symbol === name &&
      strictNumber(row.positionAmt, "margin_top_up_position_quantity",
        { allowZero: true }) !== 0);
    if (active.length !== 1 || active[0].positionSide !== "LONG" ||
        positionId(active[0]) !== expectedId ||
        !sameDecimal(exactDecimal(active[0].positionAmt, "margin_top_up_position_quantity"),
          exactDecimal(quantity, "margin_top_up_expected_quantity"))) {
      throw new Error("bingx_vst_margin_top_up_baseline_position_mismatch");
    }
    // Cross-checks the symbol-scoped read (`rows`) against a fresh global
    // read (`accountRows`) for internal consistency. Other symbols may
    // legitimately have their own independent positions/orders now -- this
    // no longer requires the WHOLE account to expose only this symbol.
    const verifiedActiveForSymbol = accountRows.positions.filter((row) =>
      row?.symbol === name &&
      strictNumber(row.positionAmt, "margin_top_up_account_position_quantity",
        { allowZero: true }) !== 0);
    const activeOrdersForSymbol = accountRows.openOrders.filter((row) => row?.symbol === name);
    if (verifiedActiveForSymbol.length !== 1) {
      throw new Error("bingx_vst_margin_top_up_baseline_symbol_exposure_unverified");
    }
    const stop = exactMarginTopUpStop(orders, {
      symbol: name,
      positionId: expectedId,
      quantity,
      stopLoss,
      entryOrderId: entryId,
    });
    if (!stop || activeOrdersForSymbol.length !== 1 ||
        !exactMarginTopUpStop(activeOrdersForSymbol, {
          symbol: name, positionId: expectedId, quantity, stopLoss, entryOrderId: entryId,
        })) {
      throw new Error("bingx_vst_margin_top_up_baseline_protective_stop_unverified");
    }
    return {
      verified: true,
      environment: "vst",
      accountId,
      symbol,
      positionId: expectedId,
      quantity: String(active[0].positionAmt),
      entryOrderId: entryId,
      isolatedMarginBefore: decimalText(exactDecimal(positionInitialMargin(active[0]),
        "margin_top_up_isolated_margin_before")),
      protectiveStop: stop,
    };
  }

  async function readMarginTopUpPlan(request) {
    const baseline = await readMarginTopUpBaseline(request);
    const [positions, balance, contract] = await Promise.all([
      api.getPositions(request.symbol), api.getBalance(), api.contract(request.symbol),
    ]);
    const name = symbolName(request.symbol);
    const matching = positions.filter((row) => row?.symbol === name &&
      Number(row.positionAmt) !== 0);
    const balanceRows = Array.isArray(balance) ? balance
      : Array.isArray(balance?.balance) ? balance.balance
        : object(balance?.balance) ? [balance.balance]
          : object(balance) && Object.hasOwn(balance, "asset") ? [balance] : [];
    if (matching.length !== 1 || matching[0].positionSide !== "LONG" ||
        positionId(matching[0]) !== baseline.positionId ||
        !sameDecimal(exactDecimal(matching[0].positionAmt, "plan_quantity"),
          exactDecimal(baseline.quantity, "baseline_quantity")) ||
        !sameDecimal(exactDecimal(positionInitialMargin(matching[0]), "plan_margin"),
          exactDecimal(baseline.isolatedMarginBefore, "baseline_margin")) ||
        balanceRows.filter((row) => row?.asset === "VST").length !== 1 ||
        contract?.symbol !== name) {
      throw new Error("bingx_vst_margin_top_up_plan_snapshot_changed");
    }
    const availableMargin = balanceRows.find((row) => row.asset === "VST").availableMargin;
    const plan = calculateVstMarginTopUp({
      quantity: baseline.quantity,
      stopLoss: request.stopLoss,
      avgPrice: matching[0].avgPrice,
      liquidationPrice: matching[0].liquidationPrice,
      minIncreaseMargin: matching[0].minIncreaseMargin,
      pricePrecision: contract.pricePrecision,
      availableMargin,
    });
    return { ...baseline, ...plan };
  }

  async function readMarginTopUpProtection(request) {
    const baseline = await readMarginTopUpBaseline(request);
    const [positions, contract] = await Promise.all([
      api.getPositions(request.symbol), api.contract(request.symbol),
    ]);
    const name = symbolName(request.symbol);
    const matching = positions.filter((row) => row?.symbol === name &&
      Number(row.positionAmt) !== 0);
    if (matching.length !== 1 || matching[0].positionSide !== "LONG" ||
        positionId(matching[0]) !== baseline.positionId ||
        !sameDecimal(exactDecimal(matching[0].positionAmt, "protection_quantity"),
          exactDecimal(baseline.quantity, "baseline_quantity")) ||
        !sameDecimal(exactDecimal(positionInitialMargin(matching[0]), "protection_margin"),
          exactDecimal(baseline.isolatedMarginBefore, "baseline_margin")) ||
        contract?.symbol !== name ||
        !Number.isSafeInteger(contract.pricePrecision) ||
        contract.pricePrecision < 0 || contract.pricePrecision > 12) {
      throw new Error("bingx_vst_margin_top_up_post_funding_snapshot_changed");
    }
    const avgPrice = strictNumber(matching[0].avgPrice, "post_funding_avg_price");
    const liquidationPrice = strictNumber(
      matching[0].liquidationPrice, "post_funding_liquidation_price",
    );
    const stopPrice = strictNumber(request.stopLoss, "post_funding_stop_price");
    const buffer = Math.max(avgPrice * 0.005, 10 ** -contract.pricePrecision);
    return {
      verified: true, positionId: baseline.positionId,
      isolatedMargin: baseline.isolatedMarginBefore,
      protectiveStop: baseline.protectiveStop,
      liquidationPrice,
      buffer,
      safe: liquidationPrice + buffer < stopPrice,
    };
  }

  // A deliberately minimal, tolerant, read-only companion to
  // readMarginTopUpBaseline: it exists only to corroborate (or refute) an
  // owner's claim that a stuck margin top-up did NOT land, so it must not
  // fail merely because something else about the position moved on since
  // the original top-up attempt (e.g. a later stop replacement). It proves
  // exactly one thing -- the CURRENT isolated margin on the SAME identified
  // position -- and leaves every other verdict to the caller.
  async function readMarginTopUpMargin(request) {
    const { symbol, positionId: expectedPositionId } = request ?? {};
    if (request?.environment !== "vst" || request?.accountId !== accountId) {
      throw new Error("bingx_vst_margin_top_up_margin_check_account_mismatch");
    }
    const name = assertSymbol(symbol);
    const expectedId = exactIdentifier(
      expectedPositionId, "margin_top_up_check_expected_position_id",
    );
    await assertVstEnvironment(symbol);
    const rows = await api.getPositions(symbol);
    if (!Array.isArray(rows)) {
      throw new Error("bingx_vst_margin_top_up_margin_check_positions_unverified");
    }
    const active = rows.filter((row) => row?.symbol === name &&
      strictNumber(row.positionAmt, "margin_top_up_check_position_quantity",
        { allowZero: true }) !== 0);
    if (active.length !== 1 || active[0].positionSide !== "LONG" ||
        positionId(active[0]) !== expectedId) {
      // Not proof of anything about margin -- the caller must treat this as
      // its own distinct outcome (the position it was told to check no
      // longer unambiguously exists), never silently folded into either the
      // "not added" or "added" verdict.
      return { verified: false };
    }
    return {
      verified: true,
      environment: "vst",
      accountId,
      symbol,
      positionId: expectedId,
      quantity: String(active[0].positionAmt),
      isolatedMargin: decimalText(exactDecimal(positionInitialMargin(active[0]),
        "margin_top_up_check_isolated_margin")),
    };
  }

  async function readCompleteMarginTopUpHistory(symbol, positionId, startTime, endTime) {
    if (typeof api.getPositionMarginHistory !== "function") {
      throw new Error("bingx_vst_margin_history_unavailable");
    }
    const pageSize = 100;
    // Each page is a rate-limited exchange request. Three pages keep a
    // reconciliation read bounded while still covering ordinary histories;
    // larger ranges fail closed rather than tying up a worker for minutes.
    const maxPages = 3;
    const first = await api.getPositionMarginHistory(symbol, positionId, {
      startTime, endTime, pageIndex: 1, pageSize,
    });
    if (!Number.isSafeInteger(first?.total) || first.total < 0 ||
        !Array.isArray(first.records) || first.records.length > pageSize ||
        first.records.length !== Math.min(first.total, pageSize) ||
        first.total > pageSize * maxPages) {
      throw new Error("bingx_vst_margin_history_incomplete");
    }
    const records = [...first.records];
    const pages = Math.ceil(first.total / pageSize);
    for (let pageIndex = 2; pageIndex <= pages; pageIndex += 1) {
      const page = await api.getPositionMarginHistory(symbol, positionId, {
        startTime, endTime, pageIndex, pageSize,
      });
      const expectedLength = Math.min(pageSize, first.total - records.length);
      if (!Number.isSafeInteger(page?.total) || page.total !== first.total ||
          !Array.isArray(page.records) || page.records.length !== expectedLength) {
        throw new Error("bingx_vst_margin_history_incomplete");
      }
      records.push(...page.records);
    }
    if (records.length !== first.total) {
      throw new Error("bingx_vst_margin_history_incomplete");
    }
    return records;
  }

  async function verifyMarginTopUpNotAdded(request) {
    const expectedBefore = exactDecimal(
      request?.expectedIsolatedMarginBefore, "margin_top_up_expected_margin_before",
    );
    const intentAt = Number(request?.intentCreatedAt) ||
      Date.parse(request?.intentCreatedAt);
    const now = Number(clock());
    if (!Number.isSafeInteger(intentAt) || intentAt <= 0 ||
        !Number.isSafeInteger(now) || now < intentAt) {
      throw new Error("bingx_vst_margin_history_window_invalid");
    }
    const protection = await readMarginTopUpProtection(request);
    if (protection?.verified !== true ||
        protection.positionId !== request.positionId ||
        !sameDecimal(exactDecimal(protection.isolatedMargin,
          "margin_top_up_entry_margin"), expectedBefore) ||
        protection.protectiveStop?.orderId !== request.stopOrderId ||
        protection.protectiveStop?.status !== "NEW" ||
        protection.protectiveStop?.workingType !== "MARK_PRICE") {
      return { verified: false, status: "unknown" };
    }
    if (protection.safe !== true) {
      return {
        verified: false,
        status: "unsafe_protection",
        liquidationPrice: protection.liquidationPrice,
        requiredBuffer: protection.buffer,
      };
    }
    const records = await readCompleteMarginTopUpHistory(
      request.symbol, protection.positionId, intentAt, now,
    );
    for (const row of records) {
      try {
        if (row?.symbol !== symbolName(request.symbol) ||
            exactIdentifier(row.positionId, "margin_history_position_id") !==
              protection.positionId ||
            !Number.isSafeInteger(row.time) || row.time < intentAt || row.time > now) {
          return { verified: false, status: "unknown" };
        }
      } catch {
        return { verified: false, status: "unknown" };
      }
    }
    const additions = records.filter((row) =>
      row.changeReason === "ManualMarginAddition");
    if (additions.length > 0) {
      return { verified: false, status: "addition_found", additions: additions.length };
    }
    return {
      verified: true,
      status: "not_added",
      symbol: request.symbol,
      positionId: protection.positionId,
      isolatedMargin: protection.isolatedMargin,
      protectiveStop: protection.protectiveStop,
      liquidationPrice: protection.liquidationPrice,
      requiredBuffer: protection.buffer,
      safe: true,
      history: { source: "bingx_position_margin_history", total: records.length },
    };
  }

  function linkedId(clientOrderId) {
    return normalizeClientOrderId(clientOrderId);
  }

  function historyRange({ request, phase, now, signalTime }) {
    const candidateSignalTime = Date.parse(signalTime ?? "");
    const phaseTimestamp = Number(String(phase).split("-").at(-2));
    const startCandidate = Number.isFinite(candidateSignalTime)
      ? candidateSignalTime - 30_000
      : Number.isSafeInteger(phaseTimestamp) && phaseTimestamp > 0
        ? phaseTimestamp - 30_000 : now - maxHistoryAgeMs;
    return {
      startTs: Math.max(1, Math.floor(now - MAX_HISTORY_WINDOW_MS),
        Math.floor(Math.min(startCandidate, now))),
      endTs: Math.max(1, Math.floor(now)),
    };
  }

  function intentRange(request, now) {
    const raw = request?.intentCreatedAt;
    const parsed = asMillis(raw) ??
      (typeof raw === "string" ? Date.parse(raw) : null);
    if (!Number.isSafeInteger(parsed) || parsed <= 0 ||
        !Number.isSafeInteger(now) || now <= 0 || parsed > now + 2_000) {
      return null;
    }
    const endTs = Math.floor(now);
    const startTs = Math.max(
      1,
      Math.floor(now - MAX_HISTORY_WINDOW_MS),
      Math.floor(Math.min(parsed, now) - 30_000),
    );
    if (endTs < startTs || endTs - startTs > MAX_HISTORY_WINDOW_MS) return null;
    return {
      startTs,
      endTs,
      intentAt: Math.floor(Math.min(parsed, now)),
      coversIntent: now - parsed <= MAX_HISTORY_WINDOW_MS,
    };
  }

  function entryIntentRange(request, rawClientOrderId, expectedPositionId, now) {
    const snapshots = [
      request,
      request?.nextPosition,
      request?.priorPosition,
      request?.persistedPosition,
      request?.persistedSnapshot,
      request?.marginTopUp,
      request?.nextPosition?.marginTopUp,
      request?.priorPosition?.marginTopUp,
      request?.priorPosition?.persistedPosition,
      request?.priorPosition?.persistedSnapshot,
      request?.nextPosition?.persistedPosition,
      request?.nextPosition?.persistedSnapshot,
      request?.signal,
      request?.entryProof,
    ].filter(object);
    const declaredClientIds = snapshots
      .filter((snapshot) => Object.hasOwn(snapshot, "entryClientOrderId"))
      .map((snapshot) => snapshot.entryClientOrderId);
    if (declaredClientIds.some((clientId) =>
      typeof clientId !== "string" || clientId !== rawClientOrderId)) {
      throw new Error("bingx_vst_entry_identity_metadata_unverified");
    }
    const matchingSnapshots = snapshots.filter((snapshot) =>
      snapshot.entryClientOrderId === rawClientOrderId);
    if (matchingSnapshots.length === 0) {
      throw new Error("bingx_vst_entry_identity_metadata_unverified");
    }
    const entryTimes = [];
    const durableOrderIds = [];
    // A historical parent ID may be persisted with the margin-top-up record
    // rather than copied onto the position snapshot. It is only eligible when
    // the same request carries the durable entry client ID; conflicts across
    // all available snapshots still fail closed below.
    const entryMetadataSnapshots = [
      ...matchingSnapshots,
      ...snapshots.filter((snapshot) =>
        !matchingSnapshots.includes(snapshot) &&
        snapshot.entryOrderId !== undefined && snapshot.entryOrderId !== null &&
        (snapshot === request?.marginTopUp ||
         snapshot === request?.nextPosition?.marginTopUp ||
         snapshot === request?.priorPosition?.marginTopUp)),
    ];
    for (const snapshot of entryMetadataSnapshots) {
      if (Object.hasOwn(snapshot, "entryAt")) {
        const raw = snapshot.entryAt;
        const parsed = asMillis(raw) ??
          (typeof raw === "string" &&
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)
            ? Date.parse(raw) : null);
        if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > now ||
            now - parsed > SOURCE_ENTRY_HISTORY_MAX_AGE_MS) {
          throw new Error("bingx_vst_entry_intent_time_unverified");
        }
        entryTimes.push(parsed);
      }
      if (snapshot.entryOrderId !== undefined && snapshot.entryOrderId !== null) {
        try {
          durableOrderIds.push(exactIdentifier(
            snapshot.entryOrderId, "entry_order_id",
          ));
        } catch {
          throw new Error("bingx_vst_entry_order_id_mismatch");
        }
      }
    }
    const uniqueEntryTimes = [...new Set(entryTimes)];
    const uniqueOrderIds = [...new Set(durableOrderIds)];
    const entryProof = request.entryProof ?? {
      entryClientOrderId: rawClientOrderId,
      entryOrderId: uniqueOrderIds.length === 1 ? uniqueOrderIds[0] : undefined,
      positionId: expectedPositionId,
      intentCreatedAt: uniqueEntryTimes.length === 1
        ? uniqueEntryTimes[0] : undefined,
      quantity: matchingSnapshots.map((snapshot) => snapshot.entryQuantity)
        .find((value) => value !== undefined && value !== null),
      entryOrderType: matchingSnapshots.map((snapshot) => snapshot.entryOrderType)
        .find((value) => value !== undefined && value !== null),
    };
    let proofOrderId;
    let proofPositionId;
    let proofQuantity;
    try {
      proofOrderId = exactIdentifier(entryProof?.entryOrderId, "entry_order_id");
      proofPositionId = exactIdentifier(entryProof?.positionId, "entry_position_id");
      proofQuantity = exactDecimal(entryProof?.quantity, "entry_quantity");
    } catch {
      throw new Error("bingx_vst_entry_identity_metadata_unverified");
    }
    const proofIntentAt = asMillis(entryProof?.intentCreatedAt) ??
      (typeof entryProof?.intentCreatedAt === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
          .test(entryProof.intentCreatedAt)
        ? Date.parse(entryProof.intentCreatedAt) : null);
    const declaredPositionIds = matchingSnapshots.flatMap((snapshot) =>
      [snapshot.exchangePositionId, snapshot.positionId]
        .filter((value) => value !== undefined && value !== null)
        .map((value) => exactIdentifier(value, "entry_position_id")));
    const declaredEntryTypes = matchingSnapshots
      .map((snapshot) => snapshot.entryOrderType)
      .filter((value) => value !== undefined && value !== null);
    const declaredEntryQuantities = matchingSnapshots
      .map((snapshot) => snapshot.entryQuantity)
      .filter((value) => value !== undefined && value !== null);
    if (uniqueEntryTimes.length > 1 || uniqueOrderIds.length > 1 ||
        proofPositionId !== expectedPositionId ||
        entryProof?.entryClientOrderId !== rawClientOrderId ||
        typeof entryProof?.entryOrderType !== "string" ||
        declaredPositionIds.some((id) => id !== proofPositionId) ||
        declaredEntryTypes.some((type) => type !== entryProof.entryOrderType) ||
        declaredEntryQuantities.some((quantity) =>
          !sameDecimal(
            exactDecimal(quantity, "entry_quantity"),
            proofQuantity,
          )) ||
        uniqueOrderIds.some((id) => id !== proofOrderId) ||
        request.entryOrderId !== undefined &&
          exactIdentifier(request.entryOrderId, "entry_order_id") !== proofOrderId ||
        !Number.isSafeInteger(proofIntentAt) || proofIntentAt <= 0 ||
        proofIntentAt > now) {
      throw new Error("bingx_vst_entry_identity_metadata_unverified");
    }
    const savedEntryAt = uniqueEntryTimes.length === 1 ? uniqueEntryTimes[0] : null;
    if (now - proofIntentAt > SOURCE_ENTRY_HISTORY_MAX_AGE_MS ||
        savedEntryAt !== null &&
          (savedEntryAt < proofIntentAt || savedEntryAt > now ||
           savedEntryAt - proofIntentAt >
             SOURCE_ENTRY_MAX_FILL_WINDOW_MS ||
           now - savedEntryAt > SOURCE_ENTRY_HISTORY_MAX_AGE_MS)) {
      throw new Error("bingx_vst_entry_intent_time_unverified");
    }
    // Order/fill history is anchored to the original entry chronology, never
    // to a later raise-stop/close intent. Keep each exchange query narrow and
    // within the existing retention window.
    const startTs = Math.max(1, proofIntentAt - 30_000);
    const endTs = Math.min(now, savedEntryAt !== null
      ? savedEntryAt + SOURCE_ENTRY_FILL_END_PADDING_MS
      : proofIntentAt + SOURCE_ENTRY_MAX_FILL_WINDOW_MS +
        SOURCE_ENTRY_FILL_END_PADDING_MS);
    if (endTs < startTs ||
        now - startTs > SOURCE_ENTRY_HISTORY_MAX_AGE_MS ||
        endTs - startTs >
          SOURCE_ENTRY_MAX_FILL_WINDOW_MS + SOURCE_ENTRY_FILL_END_PADDING_MS + 30_000) {
      throw new Error("bingx_vst_entry_intent_time_unverified");
    }
    return {
      range: { startTs, endTs },
      exchangeOrderId: proofOrderId,
      positionId: proofPositionId,
      entryOrderType: entryProof.entryOrderType,
      quantity: entryProof.quantity,
      entryAt: savedEntryAt,
    };
  }

  function boundedRows(rows) {
    return Array.isArray(rows) && rows.length < MAX_UNPAGINATED_ROWS;
  }

  // Read-only proof that an ambiguous MARKET entry never executed: BingX
  // answers "order not exist" for its exact client ID, the symbol's order
  // history has no row with that ID, the symbol has no fill at all since the
  // intent was created, and the symbol has no position and no open order.
  // Any read failure or any doubt returns false (the intent stays isolated).
  const ENTRY_NOT_EXECUTED_MIN_AGE_MS = 10 * 60_000;
  async function proveEntryNotExecuted({ clientOrderId, request } = {}) {
    try {
      if (request?.operation !== "entry" || request?.environment !== "vst" ||
          request?.accountId !== accountId) return false;
      const symbol = request.symbol;
      const name = assertSymbol(symbol);
      const createdAt = asMillis(request.intentCreatedAt);
      const now = Number(clock());
      if (createdAt === null || !Number.isSafeInteger(now) ||
          now - createdAt < ENTRY_NOT_EXECUTED_MIN_AGE_MS ||
          now - createdAt > MAX_HISTORY_WINDOW_MS) return false;
      const exchangeClientId = linkedId(clientOrderId);
      const range = { startTs: Math.max(1, createdAt - 60_000), endTs: now };
      const [queried, history, usdtFills, vstFills, positions, orders] =
        await Promise.all([
          api.queryOrder(symbol, { clientOrderId: exchangeClientId }),
          api.queryOrderHistory(symbol, range),
          api.queryFills(symbol, { ...range, currency: "USDT" }),
          api.queryFills(symbol, { ...range, currency: "VST" }),
          api.getPositions(symbol),
          api.getOpenOrders(symbol),
        ]);
      if (queried !== null && queried !== undefined) return false;
      if (![history, usdtFills, vstFills, positions, orders].every(boundedRows)) {
        return false;
      }
      if (history.some((row) => orderClientId(row) === exchangeClientId)) return false;
      if ([...usdtFills, ...vstFills].some((fill) =>
        fill?.symbol === undefined || fill.symbol === name)) return false;
      if (positions.some((row) => row?.symbol === name &&
          Number(row.positionAmt ?? row.positionAmount ?? row.quantity) !== 0)) return false;
      if (orders.some((row) => row?.symbol === name)) return false;
      return true;
    } catch {
      return false;
    }
  }

  async function findHistoryOrder(symbol, exchangeClientId, range) {
    const name = symbolName(symbol);
    const history = await api.queryOrderHistory(symbol, range);
    if (!boundedRows(history)) return recordProofResult(null, {
      source: "order_reconciliation_proof", condition: "fills_shape", symbol, check: "entry_history",
    }, () => ({
      fillsBounded: evidencePair(true, false),
      historyCount: evidencePair(undefined, Array.isArray(history) ? history.length : undefined, true),
      startTime: evidencePair(undefined, range?.startTs, true), endTime: evidencePair(undefined, range?.endTs, true),
    }));
    const matches = history.filter((row) =>
      row?.symbol === name && orderClientId(row) === exchangeClientId);
    if (matches.length !== 1) return recordProofResult(null, {
      source: "order_reconciliation_proof", condition: "history_found", symbol, check: "entry_history",
    }, () => ({
      matchingHistoryCount: evidencePair(1, matches.length, false),
      historyCount: evidencePair(undefined, history.length, true),
      startTime: evidencePair(undefined, range?.startTs, true), endTime: evidencePair(undefined, range?.endTs, true),
    }));
    try {
      return { order: matches[0], exchangeOrderId: orderId(matches[0]) };
    } catch (error) {
      return recordProofResult(null, {
        source: "order_reconciliation_proof", condition: "identifier_validation", symbol, check: "entry_history",
      }, () => ({ identifierAliases: evidencePair(undefined,
        [matches[0]?.orderId, matches[0]?.orderID], false) }), error);
    }
  }

  async function findIntentOrder(
    symbol, exchangeClientId, range, rawClientOrderId, expectedOrderId,
  ) {
    const name = symbolName(symbol);
    const historyNow = Number(clock());
    const skipUnsupportedHistory = expectedOrderId !== undefined &&
      Number.isSafeInteger(range?.startTs) &&
      Number.isSafeInteger(historyNow) &&
      range.startTs < historyNow - MAX_HISTORY_WINDOW_MS;
    const defer = (condition, inspect, error) => recordProofResult(null, {
      source: "order_reconciliation_proof", condition, symbol, check: "entry_history",
    }, inspect, error);
    let history;
    if (skipUnsupportedHistory) {
      // Old entry ranges are outside native order-history retention. When the
      // persisted exact parent is available, read it directly rather than
      // issuing a predictably rejected history request first.
      history = [];
    } else {
      try {
        history = await api.queryOrderHistory(symbol, range);
      } catch {
        // Exact-parent GET below is an independent, source-safe recovery path.
      }
    }
    if (history !== undefined && !boundedRows(history)) return defer("fills_shape", () => ({
      fillsBounded: evidencePair(true, false),
      historyCount: evidencePair(undefined, Array.isArray(history) ? history.length : undefined, true),
    }));
    const matches = Array.isArray(history) ? history.filter((row) =>
      row?.symbol === name && orderClientId(row) === exchangeClientId &&
      (expectedOrderId === undefined || orderId(row) === expectedOrderId)) : [];
    if (expectedOrderId !== undefined && Array.isArray(history) &&
        history.some((row) =>
          row?.symbol === name && orderClientId(row) === exchangeClientId &&
          orderId(row) !== expectedOrderId)) return defer("child_identity", () => ({
        orderId: evidencePair(expectedOrderId, undefined, false),
      }));
    if (matches.length > 1) return defer("history_found", () => ({
      matchingHistoryCount: evidencePair(1, matches.length, false),
      historyCount: evidencePair(undefined, history.length, true),
      startTime: evidencePair(undefined, range.startTs, true), endTime: evidencePair(undefined, range.endTs, true),
    }));
    let queried = null;
    let clientLookupFailed = false;
    if (!skipUnsupportedHistory) {
      try {
        queried = await api.queryOrder(symbol, { clientOrderId: exchangeClientId });
      } catch {
        clientLookupFailed = true;
      }
    }
    if (queried && (queried.symbol !== name ||
        orderClientId(queried) !== exchangeClientId)) return defer("order_fields", () => ({
          symbol: evidencePair(name, queried.symbol),
          clientOrderIdMatches: evidencePair(true, orderClientId(queried) === exchangeClientId),
        }));
    if (matches.length === 1) {
      try {
        const exchangeOrderId = orderId(matches[0]);
        if (queried && expectedOrderId !== undefined &&
            orderId(queried) !== exchangeOrderId) return defer("child_identity", () => ({
          orderId: evidencePair(exchangeOrderId, orderId(queried), false),
        }));
        return { order: matches[0], exchangeOrderId };
      } catch (error) {
        return defer("identifier_validation", () => ({
          identifierAliases: evidencePair(undefined, [matches[0]?.orderId, matches[0]?.orderID], false),
        }), error);
      }
    }
    if (queried) {
      try {
        if (expectedOrderId !== undefined &&
            orderId(queried) !== expectedOrderId) return defer("child_identity", () => ({
          orderId: evidencePair(expectedOrderId, orderId(queried), false),
        }));
        return { order: queried, exchangeOrderId: orderId(queried) };
      } catch (error) {
        return defer("identifier_validation", () => ({
          identifierAliases: evidencePair(undefined, [queried?.orderId, queried?.orderID], false),
        }), error);
      }
    }
    // Client-ID GETs are known to miss old BingX parents. A failed/missing
    // client lookup is inconclusive; use only the independently persisted
    // exact parent ID, then validate every returned identity field.
    if (expectedOrderId === undefined) return defer("history_found", () => ({
      orderFound: evidencePair(true, false), matchingHistoryCount: evidencePair(1, matches.length, false),
      historyCount: evidencePair(undefined,
        Array.isArray(history) ? history.length : undefined, true),
      startTime: evidencePair(undefined, range.startTs, true),
      endTime: evidencePair(undefined, range.endTs, true),
      clientLookupFailed: evidencePair(false, clientLookupFailed),
    }));
    let exact;
    try {
      exact = await api.queryOrder(symbol, { orderId: expectedOrderId });
    } catch (error) {
      return defer("history_found", () => ({
        orderFound: evidencePair(true, false),
        matchingHistoryCount: evidencePair(1, matches.length, false),
        historyCount: evidencePair(undefined,
          Array.isArray(history) ? history.length : undefined, true),
        startTime: evidencePair(undefined, range.startTs, true),
        endTime: evidencePair(undefined, range.endTs, true),
        clientLookupFailed: evidencePair(false, clientLookupFailed),
      }), error);
    }
    if (!exact) return defer("history_found", () => ({
      orderFound: evidencePair(true, false), matchingHistoryCount: evidencePair(1, matches.length, false),
      historyCount: evidencePair(undefined,
        Array.isArray(history) ? history.length : undefined, true),
      startTime: evidencePair(undefined, range.startTs, true),
      endTime: evidencePair(undefined, range.endTs, true),
      clientLookupFailed: evidencePair(false, clientLookupFailed),
    }));
    try {
      const returnedClientIds = [exact.clientOrderId, exact.clientOrderID]
        .filter((value) => value !== undefined && value !== null);
      const returnedClientId = orderClientId(exact);
      if (exact.symbol !== name || orderId(exact) !== expectedOrderId ||
          returnedClientIds.length > 0 &&
            (returnedClientId === null ||
             returnedClientId !== exchangeClientId &&
             returnedClientId !== rawClientOrderId)) {
        return defer("order_fields", () => ({
          symbol: evidencePair(name, exact.symbol),
          orderId: evidencePair(expectedOrderId, orderId(exact)),
          clientOrderIdMatches: evidencePair(true,
            returnedClientIds.length === 0 ||
            returnedClientId === exchangeClientId ||
            returnedClientId === rawClientOrderId),
        }));
      }
      return { order: exact, exchangeOrderId: expectedOrderId };
    } catch (error) {
      return defer("identifier_validation", () => ({
        identifierAliases: evidencePair(undefined, [exact?.orderId, exact?.orderID], false),
      }), error);
    }
  }

  function summarizeFills(
    fills, {
      symbol, exchangeOrderId, side, requireFees = false,
    },
  ) {
    if (!Array.isArray(fills) || fills.length === 0) return null;
    let totalQuantity = 0;
    let totalValue = 0;
    let fillAt = Number.POSITIVE_INFINITY;
    const commissions = [];
    const seenFills = new Map();
    for (const fill of fills) {
      if (fill?.symbol !== symbolName(symbol) || orderId(fill) !== exchangeOrderId ||
          String(fill.side ?? "").toUpperCase() !== side ||
          String(fill.positionSide ?? "") !== "LONG") {
        return null;
      }
      const quantity = fillQty(fill);
      const price = fillPrice(fill);
      const time = fillTime(fill);
      const asset = requireFees ? commissionAsset(fill) : null;
      const commission = requireFees ? commissionParts(fill.commission) : null;
      const signature = JSON.stringify({
        symbol: fill.symbol,
        orderId: orderId(fill),
        side: String(fill.side ?? "").toUpperCase(),
        positionSide: String(fill.positionSide ?? ""),
        quantity,
        price,
        time,
        ...(requireFees ? {
          commission: String(fill.commission),
          currency: asset,
        } : {}),
      });
      const rawFillId = fill.tradeId ?? fill.tradeID ?? fill.fillId ?? fill.fillID ?? fill.id;
      const fillKey = rawFillId !== undefined && rawFillId !== null &&
        String(rawFillId).trim() !== ""
        ? `id:${exactIdentifier(rawFillId, "fill_id")}` : `row:${signature}`;
      if (seenFills.has(fillKey)) {
        if (seenFills.get(fillKey) !== signature) return null;
        continue;
      }
      seenFills.set(fillKey, signature);
      totalQuantity += quantity;
      totalValue += quantity * price;
      if (time !== null) {
        fillAt = Math.min(fillAt, time);
      }
      if (requireFees) commissions.push({ asset, parts: commission });
    }
    if (!Number.isFinite(fillAt) || totalQuantity <= 0) return null;
    return {
      quantity: totalQuantity,
      price: totalValue / totalQuantity,
      at: new Date(fillAt).toISOString(),
      ...(requireFees ? { fees: aggregateCommissions(commissions) } : {}),
    };
  }

  async function verifyEntryIdentityAndFills({
    symbol, rawClientOrderId, expectedPositionId, request,
  }) {
    if (typeof rawClientOrderId !== "string" || rawClientOrderId.length === 0) {
      throw new Error("bingx_vst_entry_history_client_id_missing");
    }
    const exchangeClientId = linkedId(rawClientOrderId);
    const now = Number(clock());
    if (!Number.isSafeInteger(now) || now <= 0) {
      throw new Error("bingx_vst_clock_invalid");
    }
    const entryMetadata = entryIntentRange(
      request, rawClientOrderId, expectedPositionId, now,
    );
    const range = entryMetadata.range;
    const entry = await findIntentOrder(
      symbol, exchangeClientId, range, rawClientOrderId,
      entryMetadata.exchangeOrderId,
    );
    const entryOrderType = request.entryOrderType ??
      request.nextPosition?.entryOrderType ??
      request.priorPosition?.entryOrderType ??
      request.persistedPosition?.entryOrderType ??
      entryMetadata.entryOrderType ??
      // Historic positions were entered by FOK before the MARKET rollout.
      "LIMIT";
    if (!entry || entry.order.status !== "FILLED" ||
        String(entry.order.side ?? "").toUpperCase() !== "BUY" ||
        !["MARKET", "LIMIT"].includes(entryOrderType) ||
        entry.order.type !== entryOrderType ||
        entryOrderType === "LIMIT" &&
          entry.order.timeInForce !== undefined && entry.order.timeInForce !== null &&
          entry.order.timeInForce !== "FOK") {
      throw new Error("bingx_vst_entry_history_unverified");
    }
    if (request.entryOrderId !== undefined &&
        exactIdentifier(request.entryOrderId, "entry_order_id") !== entry.exchangeOrderId) {
      throw new Error("bingx_vst_entry_order_id_mismatch");
    }
    if (entryMetadata.exchangeOrderId !== entry.exchangeOrderId ||
        positionId(entry.order) !== entryMetadata.positionId) {
      throw new Error("bingx_vst_entry_order_id_mismatch");
    }
    const fills = await api.queryFills(symbol, {
      ...range,
      orderId: entry.exchangeOrderId,
      currency: "USDT",
    });
    if (!boundedRows(fills) || fills.some((fill) => {
      const filledAt = fillTime(fill);
      return fill?.symbol !== symbolName(symbol) ||
        orderId(fill) !== entry.exchangeOrderId ||
        filledAt === null || filledAt < range.startTs || filledAt > range.endTs;
    })) {
      throw new Error("bingx_vst_entry_fills_unverified");
    }
    const fill = summarizeFills(fills, {
      symbol,
      exchangeOrderId: entry.exchangeOrderId,
      side: "BUY",
    });
    const executedValue = entry.order.executedQty ??
      entry.order.cumExecQty ?? entry.order.filledQty;
    const executed = executedValue === undefined || executedValue === null
      ? null
      : exactDecimal(executedValue, "entry_executed_quantity", { allowZero: true });
    const expectedEntryQuantity = request.entryQuantity ??
      request.nextPosition?.entryQuantity ?? entryMetadata.quantity;
    if (!fill || executed === null ||
        entryMetadata.entryAt !== null &&
          Math.abs(Date.parse(fill.at) - entryMetadata.entryAt) >
            SOURCE_ENTRY_FILL_END_PADDING_MS ||
        !sameDecimal(exactDecimal(fill.quantity, "entry_fill_quantity"), executed) ||
        expectedEntryQuantity !== undefined &&
          !sameDecimal(exactDecimal(fill.quantity, "entry_fill_quantity"),
            exactDecimal(expectedEntryQuantity, "expected_entry_quantity"))) {
      const error = new Error("bingx_vst_entry_history_fills_unverified");
      error.preSignReason =
        "bingx_vst_raise_stop_entry_fill_proof_refused_before_upgrade";
      throw error;
    }
    return { exchangeOrderId: entry.exchangeOrderId, fill };
  }

  async function verifyEntryOrderProof({
    clientOrderId, request, expectedPositionId, expectedOrderId, expectedQuantity,
  }) {
    try {
      if (request?.operation !== "entry" ||
          typeof clientOrderId !== "string" || clientOrderId.trim() === "" ||
          typeof expectedPositionId !== "string" || expectedPositionId.trim() === "" ||
          typeof expectedOrderId !== "string" || expectedOrderId.trim() === "") {
        return proofRefusal("entry_proof_missing", "entry_parent",
          request?.symbol, request?.sourceSignalId);
      }
      const result = await verifyEntryIdentityAndFills({
        symbol: request.symbol,
        rawClientOrderId: clientOrderId,
        expectedPositionId,
        request: {
          ...request,
          entryProof: {
            entryClientOrderId: clientOrderId,
            entryOrderId: expectedOrderId,
            positionId: expectedPositionId,
            intentCreatedAt: request.intentCreatedAt,
            quantity: expectedQuantity,
            entryOrderType: request.entryOrderType ?? "LIMIT",
          },
        },
      });
      if (result.exchangeOrderId !== expectedOrderId ||
          !sameDecimal(
            exactDecimal(result.fill.quantity, "entry_fill_quantity"),
            exactDecimal(expectedQuantity, "entry_expected_quantity"),
          )) {
        return proofRefusal("entry_fills_unverified", "fills",
          request?.symbol, request?.sourceSignalId);
      }
      return {
        verified: true,
        status: "filled",
        exchangeOrderId: result.exchangeOrderId,
        positionId: expectedPositionId,
        fill: result.fill,
      };
    } catch (error) {
      const diagnostic = recordVstDiagnostic(error, {
        stage: "entry_proof", operation: "entry", check: "entry_history",
        symbol: request?.symbol,
      });
      return attachVstResultDiagnostic(
        { verified: false, status: "unknown" }, diagnostic,
      );
    }
  }

  async function verifySourceExitEntryProof({
    clientOrderId, request, expectedPositionId, expectedOrderId, expectedQuantity,
    expectedEntryAt, entryOrderType,
  }) {
    try {
      if (request?.operation !== "entry" ||
          typeof clientOrderId !== "string" || clientOrderId.trim() === "" ||
          typeof expectedPositionId !== "string" || expectedPositionId.trim() === "" ||
          typeof expectedOrderId !== "string" || expectedOrderId.trim() === "") {
        return proofRefusal("entry_proof_missing", "entry_parent",
          request?.symbol, request?.sourceSignalId);
      }
      const now = Number(clock());
      const intentAt = asMillis(request.intentCreatedAt) ??
        (typeof request.intentCreatedAt === "string"
          ? Date.parse(request.intentCreatedAt) : null);
      const savedEntryAt = expectedEntryAt === undefined ||
          expectedEntryAt === null
        ? null
        : asMillis(expectedEntryAt) ??
          (typeof expectedEntryAt === "string"
            ? Date.parse(expectedEntryAt) : null);
      if (!Number.isSafeInteger(now) || now <= 0 ||
          !Number.isSafeInteger(intentAt) || intentAt <= 0 || intentAt > now ||
          savedEntryAt !== null &&
            (!Number.isSafeInteger(savedEntryAt) || savedEntryAt < intentAt ||
             savedEntryAt > now ||
             savedEntryAt - intentAt > SOURCE_ENTRY_MAX_FILL_WINDOW_MS)) {
        return proofRefusal("entry_history_window_unavailable", "entry_history",
          request?.symbol, request?.sourceSignalId);
      }
      const endTs = Math.min(
        now,
        (savedEntryAt ?? intentAt + SOURCE_ENTRY_MAX_FILL_WINDOW_MS) +
          SOURCE_ENTRY_FILL_END_PADDING_MS,
      );
      if (endTs < intentAt ||
          endTs - intentAt >
            SOURCE_ENTRY_MAX_FILL_WINDOW_MS + SOURCE_ENTRY_FILL_END_PADDING_MS) {
        return proofRefusal("entry_history_window_unavailable", "entry_history",
          request?.symbol, request?.sourceSignalId);
      }
      const normalizedClientOrderId = linkedId(clientOrderId);
      const exactOrderId = exactIdentifier(expectedOrderId, "entry_order_id");
      const exactPositionId = exactIdentifier(
        expectedPositionId, "entry_position_id",
      );
      const expectedQty = exactDecimal(expectedQuantity, "entry_expected_quantity");
      const order = await api.queryOrder(request.symbol, {
        orderId: exactOrderId,
      });
      if (!object(order) || order.symbol !== symbolName(request.symbol) ||
          orderId(order) !== exactOrderId ||
          positionId(order) !== exactPositionId ||
          order.status !== "FILLED" ||
          String(order.side ?? "").toUpperCase() !== "BUY" ||
          order.positionSide !== "LONG" ||
          !["MARKET", "LIMIT"].includes(order.type) ||
          entryOrderType !== undefined && order.type !== entryOrderType ||
          request.entryOrderType !== undefined &&
            order.type !== request.entryOrderType ||
          request.priorPosition?.entryOrderType !== undefined &&
            order.type !== request.priorPosition.entryOrderType ||
          request.persistedPosition?.entryOrderType !== undefined &&
            order.type !== request.persistedPosition.entryOrderType ||
          order.type === "LIMIT" &&
            order.timeInForce !== undefined && order.timeInForce !== null &&
            order.timeInForce !== "FOK") {
        return proofRefusal("entry_proof_unverified", "entry_history",
          request?.symbol, request?.sourceSignalId);
      }
      const returnedClientOrderIds = [
        order.clientOrderId, order.clientOrderID,
      ].filter((value) => value !== undefined && value !== null);
      const returnedClientOrderId = returnedClientOrderIds[0];
      if (returnedClientOrderIds.some((value) =>
        typeof value !== "string" || value !== returnedClientOrderId) ||
          returnedClientOrderId !== undefined &&
            returnedClientOrderId !== normalizedClientOrderId &&
            returnedClientOrderId !== clientOrderId) {
        return proofRefusal("entry_proof_unverified", "entry_parent",
          request?.symbol, request?.sourceSignalId);
      }
      const executedValue = order.executedQty ?? order.executedQuantity ??
        order.cumExecQty ?? order.filledQty;
      if (executedValue === undefined || executedValue === null ||
          !sameDecimal(exactDecimal(executedValue, "entry_executed_quantity"),
            expectedQty) ||
          order.origQty !== undefined && order.origQty !== null &&
            !sameDecimal(exactDecimal(order.origQty, "entry_original_quantity"),
              expectedQty)) {
        return proofRefusal("entry_fills_unverified", "fills",
          request?.symbol, request?.sourceSignalId);
      }
      const fills = await api.queryFills(request.symbol, {
        startTs: intentAt,
        endTs,
        orderId: exactOrderId,
        currency: "USDT",
      });
      if (!boundedRows(fills) || fills.some((fill) => {
        const filledAt = fillTime(fill);
        const fillPositionIds = [fill?.positionId, fill?.positionID]
          .filter((value) => value !== undefined && value !== null);
        return fill?.symbol !== symbolName(request.symbol) ||
          orderId(fill) !== exactOrderId ||
          String(fill.side ?? "").toUpperCase() !== "BUY" ||
          fill.positionSide !== "LONG" ||
          filledAt === null || filledAt < intentAt || filledAt > endTs ||
          fillPositionIds.some((value) =>
            exactIdentifier(value, "entry_fill_position_id") !== exactPositionId);
      })) {
        return proofRefusal("entry_fills_unverified", "fills",
          request?.symbol, request?.sourceSignalId);
      }
      const fill = summarizeFills(fills, {
        symbol: request.symbol,
        exchangeOrderId: exactOrderId,
        side: "BUY",
      });
      if (!fill ||
          !sameDecimal(exactDecimal(fill.quantity, "entry_fill_quantity"),
            expectedQty) ||
          !sameDecimal(exactDecimal(fill.quantity, "entry_fill_quantity"),
            exactDecimal(executedValue, "entry_executed_quantity"))) {
        return proofRefusal("entry_fills_unverified", "fills",
          request?.symbol, request?.sourceSignalId);
      }
      return {
        verified: true,
        status: "filled",
        exchangeOrderId: exactOrderId,
        positionId: exactPositionId,
        entryOrderType: order.type,
        fill,
      };
    } catch (error) {
      const diagnostic = recordVstDiagnostic(error, {
        stage: "entry_proof", operation: "entry", check: "entry_history",
        symbol: request?.symbol,
      });
      return attachVstResultDiagnostic(
        { verified: false, status: "unknown" }, diagnostic,
      );
    }
  }

  async function verifyPreRunnerOpenForSourceExit({ request, entryProof }) {
    const unknown = { verified: false, status: "unknown" };
    const refuseDuration = (proofDurationMs, finalPairDurationMs) =>
      recordProofResult(unknown, {
        source: "order_reconciliation_proof",
        condition: "clock",
        symbol: request?.symbol,
        sourceSignalId: request?.sourceSignalId,
        check: "position",
      }, () => ({
        clockValid: evidencePair(true,
          Number.isSafeInteger(proofDurationMs) &&
            proofDurationMs >= 0 &&
            proofDurationMs <= SOURCE_EXIT_PROOF_MAX_DURATION_MS &&
            Number.isSafeInteger(finalPairDurationMs) &&
            finalPairDurationMs >= 0 &&
            finalPairDurationMs <= SOURCE_EXIT_FINAL_PAIR_MAX_DURATION_MS),
        endTime: evidencePair(SOURCE_EXIT_PROOF_MAX_DURATION_MS,
          Number.isSafeInteger(proofDurationMs) ? proofDurationMs : "unreadable",
          Number.isSafeInteger(proofDurationMs) &&
            proofDurationMs <= SOURCE_EXIT_PROOF_MAX_DURATION_MS),
        startTime: evidencePair(SOURCE_EXIT_FINAL_PAIR_MAX_DURATION_MS,
          Number.isSafeInteger(finalPairDurationMs)
            ? finalPairDurationMs : "unreadable",
          Number.isSafeInteger(finalPairDurationMs) &&
            finalPairDurationMs <= SOURCE_EXIT_FINAL_PAIR_MAX_DURATION_MS),
      }));
    try {
      const symbol = request?.symbol;
      const name = symbolName(symbol);
      const rawEntryClientId = entryProof?.entryClientOrderId;
      const expectedEntryOrderId = exactIdentifier(
        entryProof?.entryOrderId, "pre_runner_entry_order_id",
      );
      const expectedPositionId = exactIdentifier(
        entryProof?.positionId, "pre_runner_position_id",
      );
      const total = exactDecimal(request?.totalQuantity,
        "pre_runner_source_exit_total_quantity");
      const entryQuantity = exactDecimal(entryProof?.quantity,
        "pre_runner_entry_quantity");
      const original = request?.originalStop;
      const core = request?.coreStop;
      const originalId = exactIdentifier(original?.orderId,
        "pre_runner_source_exit_original_stop_id");
      const coreId = exactIdentifier(core?.orderId,
        "pre_runner_source_exit_core_stop_id");
      const persistedSplit = request?.priorPosition?.split;
      const signalStopPrice = exactDecimal(
        request?.signalStopPrice ?? request?.priorPosition?.signalStopPrice ??
          persistedSplit?.signalStopPrice,
        "pre_runner_source_exit_signal_stop_price");
      const intentAt = asMillis(entryProof?.intentCreatedAt) ??
        (typeof entryProof?.intentCreatedAt === "string"
          ? Date.parse(entryProof.intentCreatedAt) : null);
      const proofCutoff = Number(clock());
      if (request?.operation !== "close_pre_runner_split" ||
          request?.environment !== "vst" || request?.accountId !== accountId ||
          request?.sourceExit !== undefined ||
          typeof request?.sourceSignalId !== "string" ||
          request.sourceSignalId.trim() === "" ||
          persistedSplit?.stage !== "runner_pending" ||
          request?.priorPosition?.sourceSignalId !== request.sourceSignalId ||
          request?.priorPosition?.symbol !== symbol ||
          request?.priorPosition?.accountId !== accountId ||
          request?.priorPosition?.environment !== "vst" ||
          request?.priorPosition?.patternId !== "impulse_buy" ||
          request?.priorPosition?.exchangePositionId !== expectedPositionId ||
          request?.priorPosition?.entryOrderId !== expectedEntryOrderId ||
          request?.priorPosition?.entryClientOrderId !== rawEntryClientId ||
          request?.priorPosition?.entryOrderType !== entryProof?.entryOrderType ||
          !sameDecimal(exactDecimal(request?.priorPosition?.verifiedFill?.quantity,
            "pre_runner_persisted_verified_fill_quantity"), entryQuantity) ||
          ["quantity", "totalQuantity", "remainingQty"].some((field) =>
            request?.priorPosition?.[field] !== undefined &&
            !sameDecimal(exactDecimal(request.priorPosition[field],
              `pre_runner_persisted_${field}`), entryQuantity)) ||
          persistedSplit?.entryOrderId !== expectedEntryOrderId ||
          persistedSplit?.positionId !== expectedPositionId ||
          persistedSplit?.originalStopOrderId !== originalId ||
          persistedSplit?.coreStop?.orderId !== coreId ||
          !sameDecimal(exactDecimal(persistedSplit?.totalQuantity,
            "pre_runner_persisted_split_quantity"), total) ||
          !sameDecimal(exactDecimal(persistedSplit?.signalStopPrice,
            "pre_runner_persisted_signal_stop_price"), signalStopPrice) ||
          request?.priorPosition?.signalStopPrice !== undefined &&
            !sameDecimal(exactDecimal(request.priorPosition.signalStopPrice,
              "pre_runner_source_exit_position_signal_stop_price"),
            signalStopPrice) ||
          request?.priorPosition?.signalSnapshot?.stopLoss !== undefined &&
            !sameDecimal(exactDecimal(request.priorPosition.signalSnapshot.stopLoss,
              "pre_runner_source_exit_signal_snapshot_stop_loss"),
            signalStopPrice) ||
          !sameDecimal(exactDecimal(persistedSplit?.coreStop?.quantity,
            "pre_runner_persisted_core_quantity"),
          exactDecimal(core?.quantity, "pre_runner_source_exit_core_quantity")) ||
          !sameDecimal(exactDecimal(persistedSplit?.coreStop?.stopPrice,
            "pre_runner_persisted_core_stop_price"), signalStopPrice) ||
          request?.signal?.stopLoss !== undefined &&
            !sameDecimal(exactDecimal(request.signal.stopLoss,
              "pre_runner_signal_stop_loss"), signalStopPrice) ||
          request?.positionId !== expectedPositionId ||
          typeof request?.closeIntentId !== "string" ||
          request.closeIntentId.trim() === "" ||
          typeof rawEntryClientId !== "string" || rawEntryClientId.trim() === "" ||
          !Number.isSafeInteger(proofCutoff) || proofCutoff <= 0 ||
          !Number.isSafeInteger(intentAt) || intentAt <= 0 ||
          intentAt > proofCutoff ||
          proofCutoff - intentAt > SOURCE_ENTRY_HISTORY_MAX_AGE_MS ||
          !sameDecimal(total, entryQuantity) ||
          !sameDecimal(exactDecimal(original?.quantity,
            "pre_runner_source_exit_original_quantity"), total) ||
          decimalAtScale(exactDecimal(core?.quantity,
            "pre_runner_source_exit_core_quantity"),
          Math.max(total.scale, exactDecimal(core.quantity,
            "pre_runner_source_exit_core_quantity").scale)) * 100n !==
            decimalAtScale(total,
              Math.max(total.scale, exactDecimal(core.quantity,
                "pre_runner_source_exit_core_quantity").scale)) * 80n ||
          originalId === coreId || originalId === expectedEntryOrderId ||
          coreId === expectedEntryOrderId ||
          !sameDecimal(exactDecimal(original?.stopPrice,
            "pre_runner_source_exit_original_stop_price"), signalStopPrice) ||
          !sameDecimal(exactDecimal(core?.stopPrice,
            "pre_runner_source_exit_core_stop_price"), signalStopPrice) ||
          [original, core].some((stop, index) =>
            stop?.positionId !== undefined &&
              exactIdentifier(stop.positionId,
                "pre_runner_source_exit_stop_position_id") !== expectedPositionId ||
            stop?.symbol !== undefined && stop.symbol !== name ||
            stop?.tranche !== undefined &&
              stop.tranche !== (index === 0 ? "original" : "core")) ||
          entryProof?.entryOrderType !== "MARKET" &&
            entryProof?.entryOrderType !== "LIMIT" ||
          request?.entryOrderId !== undefined &&
            exactIdentifier(request.entryOrderId,
              "pre_runner_source_exit_entry_order_id") !== expectedEntryOrderId) {
        return unknown;
      }
      const startTs = Math.max(1, Math.floor(intentAt - 30_001));
      if (proofCutoff - startTs > SOURCE_ENTRY_HISTORY_MAX_AGE_MS ||
          typeof api.queryCompleteFillHistory !== "function") return unknown;
      const entryVerification = await verifyEntryIdentityAndFills({
        symbol,
        rawClientOrderId: rawEntryClientId,
        expectedPositionId,
        request: {
          ...request,
          entryProof,
          entryOrderType: entryProof.entryOrderType,
          entryQuantity: entryProof.quantity,
        },
      });
      if (entryVerification.exchangeOrderId !== expectedEntryOrderId ||
          !sameDecimal(exactDecimal(entryVerification.fill.quantity,
            "pre_runner_entry_verified_fill_quantity"), total)) return unknown;
      const entryOrder = await api.queryOrder(symbol, {
        orderId: expectedEntryOrderId,
      });
      const entryParentPositionId = entryOrder && positionId(entryOrder);
      const entryParentClientIds = [
        entryOrder?.clientOrderId, entryOrder?.clientOrderID,
      ].filter((value) => value !== undefined && value !== null);
      if (!object(entryOrder) || entryOrder.symbol !== name ||
          orderId(entryOrder) !== expectedEntryOrderId ||
          entryParentPositionId !== expectedPositionId ||
          entryOrder.status !== "FILLED" ||
          String(entryOrder.side ?? "").toUpperCase() !== "BUY" ||
          String(entryOrder.positionSide ?? "") !== "LONG" ||
          entryOrder.type !== entryProof.entryOrderType ||
          entryParentClientIds.some((value) =>
            value !== rawEntryClientId && value !== linkedId(rawEntryClientId)) ||
          !sameDecimal(exactDecimal(entryOrder.executedQty ??
            entryOrder.executedQuantity ?? entryOrder.cumExecQty ??
            entryOrder.filledQty, "pre_runner_parent_executed_quantity"),
          total) ||
          entryOrder.origQty !== undefined && entryOrder.origQty !== null &&
            !sameDecimal(exactDecimal(entryOrder.origQty,
              "pre_runner_parent_original_quantity"), total)) return unknown;

      const closeOrder = await api.queryOrder(symbol, {
        clientOrderId: linkedId(request.closeIntentId),
      });
      if (closeOrder !== null) return unknown;

      const completeHistory = [];
      const historyCoverage = [];
      for (let windowStart = startTs; windowStart < proofCutoff;) {
        const windowEnd = Math.min(proofCutoff,
          windowStart + MAX_HISTORY_WINDOW_MS);
        const first = await api.queryCompleteFillHistory(symbol, {
          startTs: windowStart, endTs: windowEnd, currency: "USDT",
        });
        const rawRows = first?.rawFills;
        const validCoverage = (result) => result?.coverage?.verified === true &&
          result.coverage.endpoint ===
            "/openApi/swap/v2/trade/fillHistory" &&
          result.coverage.currency === "USDT" &&
          result.coverage.startTs === windowStart &&
          result.coverage.endTs === windowEnd &&
          result.coverage.pageSize === 1_000 &&
          result.coverage.passes === 2 &&
          result.coverage.terminalPage === 2 &&
          /^[a-f0-9]{64}$/i.test(result.coverage.snapshotSha256 ?? "") &&
          typeof result.coverage.observedAt === "string" &&
          Number.isFinite(Date.parse(result.coverage.observedAt)) &&
          Array.isArray(result.rawFills) &&
          result.rawFills.length < 1_000 &&
          result.coverage.rawCount === result.rawFills.length &&
          Array.isArray(result.fills) &&
          JSON.stringify(result.fills) === JSON.stringify(result.rawFills
            .filter((fill) => fill?.symbol === name));
        if (!validCoverage(first)) return unknown;
        completeHistory.push(...rawRows);
        historyCoverage.push(first.coverage);
        windowStart = windowEnd;
      }
      const lifecycleRows = completeHistory.filter((fill) =>
        fill?.symbol === name || (() => {
          try { return orderId(fill) === expectedEntryOrderId; }
          catch { return false; }
        })());
      if (lifecycleRows.length === 0 || lifecycleRows.some((fill) =>
        fill?.symbol !== name || orderId(fill) !== expectedEntryOrderId ||
        String(fill.side ?? "").toUpperCase() !== "BUY" ||
        String(fill.positionSide ?? "") !== "LONG" ||
        [fill.positionId, fill.positionID]
          .filter((value) => value !== undefined && value !== null)
          .some((value) => exactIdentifier(value,
            "pre_runner_lifecycle_fill_position_id") !== expectedPositionId))) {
        return unknown;
      }
      let sumAmount = 0n;
      let sumScale = 0;
      for (const fill of lifecycleRows) {
        const quantity = exactDecimal(fillQty(fill),
          "pre_runner_lifecycle_fill_quantity");
        if (quantity.scale > sumScale) {
          sumAmount *= 10n ** BigInt(quantity.scale - sumScale);
          sumScale = quantity.scale;
        }
        sumAmount += quantity.amount * 10n ** BigInt(sumScale - quantity.scale);
      }
      if (!sameDecimal({ amount: sumAmount, scale: sumScale }, total)) return unknown;

      const contract = await api.contract(symbol);
      const pricePrecision = Number(contract?.pricePrecision);
      if (!Number.isSafeInteger(pricePrecision) || pricePrecision < 0 ||
          pricePrecision > 12) return unknown;
      const tick = 10 ** -pricePrecision;
      const tickSizeText = pricePrecision === 0
        ? "1" : `0.${"0".repeat(pricePrecision - 1)}1`;
      const queriedPositionIdentity = (row) => positionId(row);
      let stopRefusal = null;
      const refuseStopEvidence = (queried, active) => {
        const parents = (row) => [
          row?.mainOrderId, row?.mainOrderID,
          row?.parentOrderId, row?.parentOrderID,
        ].filter((value) => value !== undefined && value !== null && value !== "");
        const parentsMatch = (row) => parents(row).every((value) => {
          try {
            return exactIdentifier(value,
              "pre_runner_diagnostic_parent_id") === expectedEntryOrderId;
          } catch { return false; }
        });
        stopRefusal = recordProofResult(unknown, {
          source: "order_reconciliation_proof",
          condition: "stop_details",
          symbol,
          sourceSignalId: request.sourceSignalId,
          check: "protective_stop",
        }, () => ({
          parentAliasesAgree: evidencePair(true,
            parentsMatch(queried) && parentsMatch(active)),
          positionIdsMatch: evidencePair(true,
            evidenceMatches(() => positionId(active) === expectedPositionId &&
              ["0", expectedPositionId].includes(positionId(queried)))),
          executionZero: evidencePair(true,
            explicitZeroExecutionProof(queried, orderId(queried)) !== null &&
              explicitZeroExecutionProof(active, orderId(active)) !== null),
        }));
      };
      const checkStop = (queried, openRows, stopRequest, stopId, stopQuantity) => {
        const queryPositionId = queriedPositionIdentity(queried);
        const parentFields = [
          queried?.mainOrderId, queried?.mainOrderID,
          queried?.parentOrderId, queried?.parentOrderID,
        ].filter((value) => value !== undefined && value !== null && value !== "");
        const openMatches = openRows.filter((row) => orderId(row) === stopId);
        if (!object(queried) || queried.symbol !== name || orderId(queried) !== stopId ||
            ![expectedPositionId, "0"].includes(queryPositionId) ||
            queried.type !== "STOP_MARKET" || queried.status !== "NEW" ||
            queried.side !== "SELL" || queried.positionSide !== "LONG" ||
            queried.workingType !== "MARK_PRICE" ||
            !sameDecimal(exactDecimal(queried.origQty ?? queried.quantity,
              "pre_runner_queried_stop_quantity"), stopQuantity) ||
            !sameDecimal(exactDecimal(queried.stopPrice,
              "pre_runner_queried_stop_price"),
            exactDecimal(stopRequest.stopPrice,
              "pre_runner_requested_stop_price")) ||
            parentFields.some((id) =>
              exactIdentifier(id, "pre_runner_stop_parent_id") !==
                expectedEntryOrderId) ||
            explicitZeroExecutionProof(queried, stopId) === null ||
            openMatches.length !== 1) {
          refuseStopEvidence(queried, openMatches[0]);
          return null;
        }
        const active = openMatches[0];
        const activeParents = [
          active.mainOrderId, active.mainOrderID,
          active.parentOrderId, active.parentOrderID,
        ].filter((value) => value !== undefined && value !== null && value !== "");
        if (active.symbol !== name || active.type !== "STOP_MARKET" ||
            active.status !== "NEW" || active.side !== "SELL" ||
            active.positionSide !== "LONG" || active.workingType !== "MARK_PRICE" ||
            positionId(active) !== expectedPositionId ||
            !sameDecimal(exactDecimal(active.origQty ?? active.quantity,
              "pre_runner_active_stop_quantity"), stopQuantity) ||
            !sameDecimal(exactDecimal(active.stopPrice,
              "pre_runner_active_stop_price"),
            exactDecimal(stopRequest.stopPrice,
              "pre_runner_requested_active_stop_price")) ||
            activeParents.some((id) =>
              exactIdentifier(id, "pre_runner_active_stop_parent_id") !==
                expectedEntryOrderId) ||
            explicitZeroExecutionProof(active, stopId) === null) {
          refuseStopEvidence(queried, active);
          return null;
        }
        return {
          orderId: stopId,
          positionId: expectedPositionId,
          quantity: decimalText(stopQuantity),
          stopPrice: decimalText(exactDecimal(stopRequest.stopPrice,
            "pre_runner_output_stop_price")),
        };
      };
      const coreQuantity = exactDecimal(core.quantity,
        "pre_runner_core_output_quantity");
      let priorEssential = null;
      const takeSnapshot = async () => {
        const [positions, openOrders, mode, marginType, leverage,
          queriedOriginal, queriedCore] = await Promise.all([
          api.getPositions(symbol), api.getOpenOrders(symbol),
          api.getPositionMode(), api.getMarginType(symbol), api.getLeverage(symbol),
          api.queryOrder(symbol, { orderId: originalId }),
          api.queryOrder(symbol, { orderId: coreId }),
        ]);
        const activePositions = positions.filter((row) =>
          row?.symbol === name && Number(row.positionAmt) !== 0);
        const position = activePositions.length === 1 &&
          activePositions[0].positionSide === "LONG" &&
          positionId(activePositions[0]) === expectedPositionId &&
          sameDecimal(exactDecimal(activePositions[0].positionAmt,
            "pre_runner_position_quantity"), total)
          ? activePositions[0] : null;
        const symbolOrders = openOrders.filter((row) => row?.symbol === name);
        if (!position || mode !== "HEDGE" ||
            !profileMarginIs(marginType) ||
            Number(leverage?.longLeverage) !== PROFILE_LEVERAGE || symbolOrders.length !== 2) return null;
        const originalStop = checkStop(queriedOriginal, symbolOrders, original,
          originalId, total);
        const coreStop = checkStop(queriedCore, symbolOrders, core, coreId,
          coreQuantity);
        if (!originalStop || !coreStop ||
            new Set([originalStop.orderId, coreStop.orderId]).size !== 2) return null;
        const avgPrice = strictNumber(position.avgPrice ?? position.entryPrice,
          "pre_runner_position_average_price");
        if (Math.abs(avgPrice - entryVerification.fill.price) >
            tick + Math.max(Number.EPSILON *
              Math.max(avgPrice, entryVerification.fill.price) * 4, 1e-15)) return null;
        const essential = {
          positionId: expectedPositionId,
          quantity: decimalText(exactDecimal(position.positionAmt,
            "pre_runner_snapshot_quantity")),
          avgPrice,
          mode,
          marginType: String(marginType).toUpperCase(),
          leverage: Number(leverage.longLeverage),
          stops: [originalStop, coreStop],
        };
        if (priorEssential && (
          priorEssential.positionId !== essential.positionId ||
          priorEssential.quantity !== essential.quantity ||
          priorEssential.avgPrice !== essential.avgPrice ||
          priorEssential.mode !== essential.mode ||
          priorEssential.marginType !== essential.marginType ||
          priorEssential.leverage !== essential.leverage ||
          JSON.stringify(priorEssential.stops) !== JSON.stringify(essential.stops)
        )) return null;
        priorEssential = essential;
        return { essential, originalStop, coreStop };
      };
      const firstSnapshot = await takeSnapshot();
      const secondSnapshot = firstSnapshot && await takeSnapshot();
      if (!firstSnapshot || !secondSnapshot) return stopRefusal ?? unknown;
      const finalPairStartedAtMs = Number(clock());
      if (!Number.isSafeInteger(finalPairStartedAtMs) || finalPairStartedAtMs <= 0) {
        return refuseDuration(null, null);
      }
      const [finalPositions, finalOrders] = await Promise.all([
        api.getPositions(symbol), api.getOpenOrders(symbol),
      ]);
      const finalPairEndedAtMs = Number(clock());
      const finalPairDurationMs = finalPairEndedAtMs - finalPairStartedAtMs;
      if (!Number.isSafeInteger(finalPairEndedAtMs) ||
          finalPairDurationMs < 0 ||
          finalPairDurationMs > SOURCE_EXIT_FINAL_PAIR_MAX_DURATION_MS) {
        return refuseDuration(
          finalPairEndedAtMs - proofCutoff, finalPairDurationMs,
        );
      }
      const durationAtPairEndMs = finalPairEndedAtMs - proofCutoff;
      if (durationAtPairEndMs < 0 ||
          durationAtPairEndMs > SOURCE_EXIT_PROOF_MAX_DURATION_MS) {
        return refuseDuration(durationAtPairEndMs, finalPairDurationMs);
      }
      const finalPositionRows = finalPositions.filter((row) =>
        row?.symbol === name && Number(row.positionAmt) !== 0);
      const finalOrderRows = finalOrders.filter((row) => row?.symbol === name);
      const finalOrderFactsValid = finalOrderRows.length === 2 &&
        finalOrderRows.every((row) => {
          try {
            const finalId = orderId(row);
            const expected = finalId === originalId ? original
              : finalId === coreId ? core : null;
            const expectedQuantity = finalId === originalId ? total
              : finalId === coreId ? coreQuantity : null;
            const parents = [
              row.mainOrderId, row.mainOrderID,
              row.parentOrderId, row.parentOrderID,
            ].filter((value) => value !== undefined && value !== null && value !== "");
            return expected && row.type === "STOP_MARKET" &&
              row.status === "NEW" && row.side === "SELL" &&
              row.positionSide === "LONG" && row.workingType === "MARK_PRICE" &&
              positionId(row) === expectedPositionId &&
              sameDecimal(exactDecimal(row.origQty ?? row.quantity,
                "pre_runner_final_order_quantity"), expectedQuantity) &&
              sameDecimal(exactDecimal(row.stopPrice,
                "pre_runner_final_order_price"),
              exactDecimal(expected.stopPrice, "pre_runner_final_expected_price")) &&
              parents.every((parent) =>
                exactIdentifier(parent, "pre_runner_final_order_parent") ===
                  expectedEntryOrderId) &&
              explicitZeroExecutionProof(row, orderId(row)) !== null;
          } catch {
            return false;
          }
        });
      if (finalPositionRows.length !== 1 || finalOrderRows.length !== 2 ||
          finalPositionRows[0].positionSide !== "LONG" ||
          positionId(finalPositionRows[0]) !== expectedPositionId ||
          !sameDecimal(exactDecimal(finalPositionRows[0].positionAmt,
            "pre_runner_final_position_quantity"), total) ||
          Math.abs(strictNumber(finalPositionRows[0].avgPrice ??
            finalPositionRows[0].entryPrice,
          "pre_runner_final_position_average_price") -
            secondSnapshot.essential.avgPrice) > tick ||
          !finalOrderFactsValid) return unknown;
      const observedAtMs = Number(clock());
      const proofDurationMs = observedAtMs - proofCutoff;
      if (!Number.isSafeInteger(observedAtMs) || proofDurationMs < 0 ||
          proofDurationMs > SOURCE_EXIT_PROOF_MAX_DURATION_MS) {
        return refuseDuration(proofDurationMs, finalPairDurationMs);
      }
      return {
        verified: true,
        environment: "vst",
        accountId,
        symbol,
        positionId: expectedPositionId,
        quantity: String(request.totalQuantity),
        stops: [secondSnapshot.originalStop, secondSnapshot.coreStop],
        entryOrder,
        entryProof: { ...entryProof },
        positionAveragePrice: String(finalPositionRows[0].avgPrice ??
          finalPositionRows[0].entryPrice),
        entryPriceTickSize: tickSizeText,
        historyCoverage,
        coverageEndTs: proofCutoff,
        entryFills: lifecycleRows,
        observedAt: new Date(observedAtMs).toISOString(),
      };
    } catch {
      return unknown;
    }
  }

  async function readSettings(symbol) {
    assertSymbol(symbol);
    const [mode, marginMode, leverage] = await Promise.all([
      api.getPositionMode(),
      api.getMarginType(symbol),
      api.getLeverage(symbol),
    ]);
    return { mode, marginMode, leverage };
  }

  async function readPlanningSettings(symbol) {
    assertSymbol(symbol);
    const [mode, marginMode, leverage] = await Promise.all([
      readCoalesced("getPositionMode"),
      readCoalesced("getMarginType", symbol),
      readCoalesced("getLeverage", symbol),
    ]);
    return { mode, marginMode, leverage };
  }

  function exchangeCanonicalSymbol(value, label) {
    if (typeof value !== "string" || !/^[A-Z0-9]{1,20}-USDT$/.test(value)) {
      throw new Error(`bingx_vst_invalid_${label}_symbol`);
    }
    return symbolName(`${value.slice(0, -5)}USDT`);
  }

  function validateAccountPositions(rows) {
    if (!Array.isArray(rows)) throw new Error("bingx_vst_account_positions_unverified");
    for (const row of rows) {
      if (!object(row)) throw new Error("bingx_vst_account_position_row_unverified");
      exchangeCanonicalSymbol(row.symbol, "account_position");
      const amount = typeof row.positionAmt === "string" ||
        typeof row.positionAmt === "number" ? String(row.positionAmt) : "";
      if (!/^-?\d+(?:\.\d+)?$/.test(amount) || !Number.isFinite(Number(amount))) {
        throw new Error("bingx_vst_invalid_account_position_quantity");
      }
      positionId(row);
    }
    return rows;
  }

  function validateAccountOrders(rows) {
    if (!Array.isArray(rows)) throw new Error("bingx_vst_account_orders_unverified");
    const ids = new Set();
    for (const row of rows) {
      if (!object(row)) throw new Error("bingx_vst_account_order_row_unverified");
      exchangeCanonicalSymbol(row.symbol, "account_order");
      const id = orderId(row);
      if (ids.has(id)) throw new Error("bingx_vst_account_order_ids_ambiguous");
      ids.add(id);
    }
    return rows;
  }

  async function readGlobalAccountRows() {
    const [positions, orders] = await Promise.all([
      api.getPositions(),
      api.getOpenOrders(),
    ]);
    return {
      positions: validateAccountPositions(positions),
      openOrders: validateAccountOrders(orders),
    };
  }

  function snapshotStopRecord(snapshot, tranche, expectedPositionId) {
    const supplied = snapshot?.protectiveStops?.[tranche];
    if (!object(supplied) || supplied.verified !== true ||
        supplied.positionId === undefined ||
        exactIdentifier(supplied.positionId, `${tranche}_snapshot_position_id`) !==
          expectedPositionId ||
        supplied.tranche !== undefined && supplied.tranche !== tranche) {
      throw new Error(`bingx_vst_${tranche}_persisted_stop_snapshot_unverified`);
    }
    return {
      tranche,
      orderId: exactIdentifier(supplied.orderId, `${tranche}_snapshot_stop_id`),
      quantity: decimalText(exactDecimal(supplied.quantity,
        `${tranche}_snapshot_stop_quantity`)),
      stopPrice: decimalText(exactDecimal(supplied.stopPrice,
        `${tranche}_snapshot_stop_price`)),
    };
  }

  function validatePersistedPosition(snapshot, symbol, row, orders) {
    if (snapshot === undefined) return null;
    if (object(snapshot?.persistedSnapshot)) snapshot = snapshot.persistedSnapshot;
    const name = symbolName(symbol);
    if (!object(snapshot) || snapshot.verified !== true ||
        snapshot.environment !== "vst" || snapshot.accountId !== accountId ||
        snapshot.symbol !== symbol ||
        !Array.isArray(orders) ||
        !row ||
        exactIdentifier(snapshot.positionId, "persisted_position_id") !== positionId(row) ||
        !sameDecimal(exactDecimal(snapshot.quantity, "persisted_position_quantity"),
          exactDecimal(row.positionAmt, "current_position_quantity"))) {
      throw new Error("bingx_vst_persisted_position_snapshot_mismatch");
    }
    const suppliedStops = snapshot.protectiveStops;
    if (!object(suppliedStops) ||
        Object.keys(suppliedStops).some((tranche) => !["core", "runner"].includes(tranche))) {
      throw new Error("bingx_vst_persisted_position_stops_missing_or_ambiguous");
    }
    const expectedStops = {};
    for (const tranche of ["core", "runner"]) {
      if (suppliedStops[tranche] === undefined) continue;
      expectedStops[tranche] = snapshotStopRecord(snapshot, tranche, positionId(row));
    }
    let originalStop = null;
    if (snapshot.originalStop !== undefined) {
      const supplied = snapshot.originalStop;
      if (!object(supplied) || supplied.verified !== true ||
          exactIdentifier(supplied.positionId, "original_stop_snapshot_position_id") !==
            positionId(row)) {
        throw new Error("bingx_vst_persisted_original_stop_snapshot_unverified");
      }
      originalStop = {
        orderId: exactIdentifier(supplied.orderId, "original_stop_snapshot_id"),
        quantity: decimalText(exactDecimal(supplied.quantity,
          "original_stop_snapshot_quantity")),
        stopPrice: decimalText(exactDecimal(supplied.stopPrice,
          "original_stop_snapshot_price")),
      };
    }
    const records = [...Object.values(expectedStops), ...(originalStop ? [originalStop] : [])];
    if (records.length === 0 ||
        new Set(records.map((stop) => stop.orderId)).size !== records.length ||
        orders.length !== records.length) {
      throw new Error("bingx_vst_persisted_position_open_order_set_mismatch");
    }
    const matchedIds = new Set();
    for (const tranche of ["core", "runner"]) {
      const expected = expectedStops[tranche];
      if (!expected) continue;
      const matches = orders.filter((order) => {
        try {
          return orderId(order) === expected.orderId;
        } catch {
          return false;
        }
      });
      if (matches.length !== 1) {
        throw new Error("bingx_vst_persisted_stop_order_missing_or_ambiguous");
      }
      const order = matches[0];
      if (order?.symbol !== name ||
          order?.type !== "STOP_MARKET" || order?.status !== "NEW" ||
          order?.side !== "SELL" || order?.positionSide !== "LONG" ||
          order?.workingType !== "MARK_PRICE" ||
          positionId(order) !== positionId(row) ||
          !sameDecimal(exactDecimal(order.origQty ?? order.quantity,
            "persisted_open_stop_quantity"),
          exactDecimal(expected.quantity, "persisted_expected_stop_quantity")) ||
          !sameDecimal(exactDecimal(order.stopPrice, "persisted_open_stop_price"),
            exactDecimal(expected.stopPrice, "persisted_expected_stop_price"))) {
        throw new Error("bingx_vst_persisted_stop_raw_order_mismatch");
      }
      matchedIds.add(expected.orderId);
    }
    if (originalStop) {
      const matches = orders.filter((order) => {
        try {
          return orderId(order) === originalStop.orderId;
        } catch {
          return false;
        }
      });
      if (matches.length !== 1) {
        throw new Error("bingx_vst_persisted_original_stop_missing_or_ambiguous");
      }
      const order = matches[0];
      if (order?.symbol !== name ||
          order?.type !== "STOP_MARKET" || order?.status !== "NEW" ||
          order?.side !== "SELL" || order?.positionSide !== "LONG" ||
          order?.workingType !== "MARK_PRICE" ||
          positionId(order) !== positionId(row) ||
          !sameDecimal(exactDecimal(order.origQty ?? order.quantity,
            "persisted_original_stop_quantity"),
          exactDecimal(originalStop.quantity, "persisted_expected_original_quantity")) ||
          !sameDecimal(exactDecimal(order.stopPrice, "persisted_original_stop_price"),
            exactDecimal(originalStop.stopPrice, "persisted_expected_original_price"))) {
        throw new Error("bingx_vst_persisted_original_stop_raw_order_mismatch");
      }
      matchedIds.add(originalStop.orderId);
    }
    if (orders.some((order) => !matchedIds.has(orderId(order)))) {
      throw new Error("bingx_vst_persisted_position_contains_foreign_open_orders");
    }
    return { stops: expectedStops, originalStop };
  }

  function positionSnapshotFromRequest(request) {
    const unwrap = (value) => {
      let snapshot = value;
      if (object(snapshot?.persistedPosition)) snapshot = snapshot.persistedPosition;
      if (object(snapshot?.persistedSnapshot)) snapshot = snapshot.persistedSnapshot;
      return snapshot;
    };
    const candidates = [
      request?.persistedPosition,
      request?.priorPosition?.persistedPosition,
      request?.priorPosition?.persistedSnapshot,
      object(request?.priorPosition) && request.priorPosition.verified === true &&
        !object(request.priorPosition.persistedPosition) &&
        !object(request.priorPosition.persistedSnapshot)
        ? request.priorPosition : undefined,
      request?.persistedSnapshot,
      request?.position?.persistedPosition,
      request?.position?.persistedSnapshot,
      object(request?.position) && request.position.verified === true &&
        object(request.position.protectiveStops) &&
        !object(request.position.persistedPosition) &&
        !object(request.position.persistedSnapshot)
        ? request.position : undefined,
    ].filter((candidate) => candidate !== undefined && candidate !== null)
      .map(unwrap);
    const verified = candidates.filter((candidate) =>
      object(candidate) && candidate.verified === true);
    if (candidates.some((candidate) => !object(candidate) ||
        candidate.verified !== true)) {
      throw new Error("bingx_vst_persisted_position_snapshot_unverified");
    }
    if (verified.length === 0) return null;
    const canonical = (value, path = []) => {
      if (Array.isArray(value)) return value.map((item, index) =>
        canonical(item, [...path, String(index)]));
      if (!object(value)) return value;
      return Object.fromEntries(Object.keys(value)
        .filter((key) => !(path.length === 1 && path[0] === "originalStop" &&
          key === "tranche"))
        .sort().map((key) => [key, canonical(value[key], [...path, key])]));
    };
    const first = JSON.stringify(canonical(verified[0]));
    if (verified.slice(1).some((candidate) =>
      JSON.stringify(canonical(candidate)) !== first)) {
      throw new Error("bingx_vst_persisted_position_snapshot_conflict");
    }
    return request?.persistedPosition !== undefined
      ? unwrap(request.persistedPosition)
      : verified[0];
  }

  function buildRequestPositionSnapshot(request, {
    positionId: expectedPositionId,
    quantity,
    stops,
    originalStop,
  }) {
    const persisted = positionSnapshotFromRequest(request);
    if (persisted !== null) return persisted;
    return {
      verified: true,
      environment: "vst",
      accountId,
      symbol: request.symbol,
      positionId: expectedPositionId,
      quantity,
      protectiveStops: Object.fromEntries(Object.entries(stops).map(([tranche, stop]) => [
        tranche,
        {
          verified: true,
          tranche,
          positionId: expectedPositionId,
          orderId: stop.orderId,
          quantity: stop.quantity,
          stopPrice: stop.stopPrice,
        },
      ])),
      ...(originalStop ? {
        originalStop: {
          verified: true,
          positionId: expectedPositionId,
          orderId: originalStop.orderId,
          quantity: originalStop.quantity,
          stopPrice: originalStop.stopPrice,
        },
      } : {}),
    };
  }

  function splitRequestPositionSnapshot(request, details) {
    if (request.operation === "cancel_split_stop") {
      return splitPostClosePositionSnapshot(request, details, {
        closedTranche: request.leg,
        remainingQuantity: request.remainingQuantity,
        allowAlreadyResidual: true,
      });
    }
    let stops;
    if (request.operation === "split_core_stop") {
      stops = {
        core: {
          orderId: details.originalStopOrderId,
          quantity: details.totalQuantity,
          stopPrice: details.signalStopPrice,
        },
      };
    } else if (request.operation === "split_runner_stop") {
      stops = { core: stopRecord(request, "core", details) };
    } else if (request.operation === "cancel_original_stop") {
      stops = {
        core: stopRecord(request, "core", details),
        runner: stopRecord(request, "runner", details),
      };
    } else {
      stops = {
        core: stopRecord(request, "core", details),
        runner: stopRecord(request, "runner", details),
      };
    }
    return buildRequestPositionSnapshot(request, {
      positionId: details.positionId,
      quantity: details.totalQuantity,
      stops,
      originalStop: ["split_runner_stop", "cancel_original_stop"].includes(
        request.operation,
      ) ? {
        orderId: details.originalStopOrderId,
        quantity: details.totalQuantity,
        stopPrice: details.signalStopPrice,
      } : null,
    });
  }

  async function readPositionRows(symbol, {
    persistedPosition, allowProcessCache = true, accountStateContext,
    sourceExitReadAuthorization,
  } = {}) {
    const operationId = ++positionReadOperationId;
    const name = assertSymbol(symbol);
    const skipVstMarketRead = sourceExitReadAuthorization === sourceExitReadToken;
    const reusableAccountState = consumeAccountStateReadContext(
      accountStateContext, symbol,
    );
    const readScopedRows = () => Promise.all([
      Promise.resolve().then(() => api.getPositions(symbol)),
      Promise.resolve().then(() => api.getOpenOrders(symbol)),
    ]);
    // Observe both groups immediately. Awaiting metadata first leaves a fast
    // scoped rejection unhandled, or abandons it when metadata rejects first.
    // Deferring invocation also converts synchronous adapter throws into
    // handled rejections without leaving already-started siblings unobserved.
    const [[environmentQuote, filters, settings], scopedRows] = await Promise.all([
      Promise.all([
        skipVstMarketRead
          ? Promise.resolve(null)
          : Promise.resolve().then(() => assertVstEnvironment(symbol, { openPosition: true })),
        Promise.resolve().then(() => api.contract(symbol)),
        Promise.resolve().then(() => readSettings(symbol)),
      ]),
      reusableAccountState ? null : readScopedRows(),
    ]);
    // Metadata and quote reads above may themselves be slow. Recheck the
    // original request-start timestamp immediately before touching cached raw
    // account rows, otherwise a context that expired while they were awaited
    // could still be used as position evidence.
    const contextStillFresh = reusableAccountState &&
      isCurrentAccountStateReadContext(reusableAccountState);
    const [positionRows, openOrderRows] = contextStillFresh
      ? [reusableAccountState.positions, reusableAccountState.openOrders]
      : scopedRows ?? await readScopedRows();
    const rows = contextStillFresh
      ? positionRows.filter((row) => row?.symbol === name)
      : positionRows;
    const orders = contextStillFresh
      ? openOrderRows.filter((order) => order?.symbol === name)
      : openOrderRows;
    if (filters?.symbol !== name || !Array.isArray(rows) || !Array.isArray(orders) ||
        !Number.isSafeInteger(filters.pricePrecision) ||
        filters.pricePrecision < 0 || filters.pricePrecision > 12) {
      const error = new Error("bingx_vst_position_or_open_orders_unverified");
      recordProofResult(undefined, {
        source: "broker_position_rows", condition: "position_rows", symbol,
        operation: "read_position", check: "position_row",
      }, () => ({
        symbol: evidencePair(name, filters.symbol),
        positionsArray: evidencePair(true, Array.isArray(rows)),
        ordersArray: evidencePair(true, Array.isArray(orders)),
        pricePrecision: evidencePair(undefined, filters.pricePrecision, true),
        pricePrecisionValid: evidencePair(true, Number.isSafeInteger(filters.pricePrecision) &&
          filters.pricePrecision >= 0 && filters.pricePrecision <= 12),
      }), error);
      throw error;
    }
    const matching = rows.filter((row) => row?.symbol === name &&
      (row.positionSide === "LONG" || row.positionSide === "BOTH" ||
       row.positionSide == null) &&
      strictNumber(row.positionAmt, "position_quantity", { allowZero: true }) !== 0);
    const ambiguous = rows.some((row) => row?.symbol === name &&
      (row.positionSide === "SHORT" ||
       !Number.isFinite(Number(row.positionAmt))));
    if (ambiguous || matching.length > 1) {
      const error = new Error("bingx_vst_position_state_ambiguous");
      recordProofResult(undefined, {
        source: "broker_position_rows", condition: "position_rows", symbol,
        operation: "read_position", check: "position_row",
      }, () => ({
        matchingPositionCount: evidencePair(1, matching.length, matching.length <= 1),
        shortPositionPresent: evidencePair(false, rows.some((item) => item?.symbol === name && item.positionSide === "SHORT")),
        invalidPositionQuantityPresent: evidencePair(false, rows.some((item) =>
          item?.symbol === name && !Number.isFinite(Number(item.positionAmt)))),
      }), error);
      throw error;
    }
    const row = matching[0] ?? null;
    if (row && settings.mode === "HEDGE" && row.positionSide !== "LONG") {
      const error = new Error("bingx_vst_position_side_unverified");
      recordProofResult(undefined, {
        source: "broker_position_rows", condition: "position_rows", symbol,
        operation: "read_position", check: "position_row",
      }, () => ({ positionSide: evidencePair("LONG", row.positionSide) }), error);
      throw error;
    }
    let verifiedPersistedPosition;
    try {
      verifiedPersistedPosition = validatePersistedPosition(
        persistedPosition, symbol, row, orders,
      );
      const snapshot = createPositionSnapshot({
        symbol, accountId, mode: settings.mode, marginMode: settings.marginMode,
        leverage: settings.leverage, row, orders,
        persistedStopsByPosition: allowProcessCache ? splitStopIdsByPosition : new Map(),
        verifiedPersistedStops: verifiedPersistedPosition?.stops ?? null,
        verifiedOriginalStop: verifiedPersistedPosition?.originalStop ?? null,
        pricePrecision: filters.pricePrecision,
        evidenceSource: contextStillFresh ? "account_open_orders_filtered" : "symbol_open_orders",
      });
      if (environmentQuote && snapshot?.verified === true &&
          snapshot.environment === "vst" && snapshot.accountId === accountId &&
          snapshot.symbol === symbol) {
        positionMarketProofs.set(snapshot, {
          ...environmentQuote,
          snapshotSymbol: symbol,
          operationId,
          generation: marketProofGeneration.value,
        });
      }
      positionRawReadEvidence.set(snapshot, {
        rows: structuredClone(rows),
        orders: structuredClone(orders),
        settings: structuredClone(settings),
      });
      return snapshot;
    } catch (error) {
      try {
      const saved = object(persistedPosition?.persistedSnapshot)
        ? persistedPosition.persistedSnapshot : persistedPosition;
      recordVstDiagnostic(error, {
        stage: "broker_read", operation: "read_position", check: "protective_stop", symbol,
        stopEvidence: buildVstStopEvidence({
          symbol, row, orders, expectedStops: {
            ...(saved ? saved.protectiveStops : { core: { quantity: row?.positionAmt } }),
            ...(saved?.originalStop ? { original: saved.originalStop } : {}),
          },
          requireMarkPrice: saved !== undefined, readOrderId: orderId, readPositionId: positionId,
          expectedOpenOrderCount: saved ? ["core", "runner"].filter((leg) =>
            saved?.protectiveStops?.[leg]).length + (saved?.originalStop ? 1 : 0) : 1,
          source: contextStillFresh ? "account_open_orders_filtered" : "symbol_open_orders",
          compareDecimal: saved ? (left, right) => sameDecimal(
            exactDecimal(left, "diagnostic_actual"), exactDecimal(right, "diagnostic_expected"))
            : closeEnough,
        }),
      });
      } catch {
        // Diagnostic-only inspection must never replace the original exception.
      }
      throw error;
    }
  }

  async function readPosition(symbol, options) {
    const startedAt = performance.now();
    try { return await readPositionRows(symbol, options); }
    catch (error) {
      recordVstDiagnostic(error, {
        stage: "broker_read", operation: "read_position", symbol,
        stopEvidence: buildVstStopEvidence({ source: "broker_snapshot", readFailed: true }),
      });
      throw error;
    } finally {
      reportOperationTiming(startedAt, { operation: "read_position", symbol });
    }
  }

  function splitIntentDetails(request) {
    const sourceSignalId = exactIdentifier(request?.sourceSignalId, "source_signal_id");
    const signal = request?.signal;
    const position = request?.position;
    const totalQuantity = exactDecimal(request?.totalQuantity, "split_total_quantity");
    const coreQuantity = exactDecimal(request?.coreQuantity, "split_core_quantity");
    const runnerQuantity = exactDecimal(request?.runnerQuantity, "split_runner_quantity");
    const signalStopPrice = exactDecimal(request?.signalStopPrice, "split_signal_stop_price");
    const breakEvenPrice = exactDecimal(request?.breakEvenPrice, "split_break_even_price");
    const actualEntryBreakEvenPrice = exactDecimal(
      request?.actualEntryBreakEvenPrice, "actual_entry_break_even_price",
    );
    const quantityPrecision = request?.quantityPrecision;
    const pricePrecision = request?.pricePrecision;
    const candidateCreatedAt = asMillis(request?.createdAt) ??
      (typeof request?.createdAt === "string" ? Date.parse(request.createdAt) : null);
    const createdAt = Number.isSafeInteger(candidateCreatedAt) && candidateCreatedAt > 0
      ? candidateCreatedAt : null;
    const baselineOpenOrderIds = request?.baselineOpenOrderIds;
    const positionIdValue = exactIdentifier(request?.positionId, "position_id");
    const originalStopOrderId = exactIdentifier(
      request?.originalStopOrderId, "original_stop_order_id",
    );
    const entryOrderId = exactIdentifier(request?.entryOrderId, "entry_order_id");
    if (!object(signal) || (signal.sourceSignalId !== undefined &&
        signal.sourceSignalId !== sourceSignalId) ||
        signal.symbol !== request.symbol ||
        !sameDecimal(exactDecimal(signal.stopLoss, "signal_stop_loss"), signalStopPrice) ||
        !sameDecimal(actualEntryBreakEvenPrice, breakEvenPrice) ||
        position !== undefined && (!object(position) || position.positionId !== positionIdValue) ||
        !Number.isSafeInteger(quantityPrecision) || quantityPrecision < 0 ||
        !Number.isSafeInteger(pricePrecision) || pricePrecision < 0 ||
        createdAt === null ||
        !Array.isArray(baselineOpenOrderIds) ||
        baselineOpenOrderIds.some((id) => typeof id !== "string" || id.trim() === "") ||
        new Set(baselineOpenOrderIds).size !== baselineOpenOrderIds.length ||
        !sameDecimal(exactDecimal(decimalText({
          amount: decimalAtScale(coreQuantity, Math.max(coreQuantity.scale, runnerQuantity.scale)) +
            decimalAtScale(runnerQuantity, Math.max(coreQuantity.scale, runnerQuantity.scale)),
          scale: Math.max(coreQuantity.scale, runnerQuantity.scale),
        }), "split_tranche_total"), totalQuantity) ||
        Number(request.createdAt) > 0 && createdAt > Number(clock()) + 2_000) {
      throw new Error("bingx_vst_split_intent_contract_incomplete_or_conflicting");
    }
    return {
      sourceSignalId,
      signal,
      positionId: positionIdValue,
      originalStopOrderId,
      entryOrderId,
      totalQuantity: decimalText(totalQuantity),
      coreQuantity: decimalText(coreQuantity),
      runnerQuantity: decimalText(runnerQuantity),
      signalStopPrice: decimalText(signalStopPrice),
      breakEvenPrice: decimalText(breakEvenPrice),
      actualEntryBreakEvenPrice: decimalText(actualEntryBreakEvenPrice),
      quantityPrecision,
      pricePrecision,
      baselineOpenOrderIds: [...baselineOpenOrderIds].sort(),
      createdAt,
    };
  }

  function stopRecord(request, tranche, details) {
    const supplied = request?.[`${tranche}Stop`];
    if (!object(supplied) ||
        supplied.tranche !== tranche ||
        !sameDecimal(exactDecimal(supplied.quantity, `${tranche}_stop_quantity`),
          exactDecimal(details[`${tranche}Quantity`], `${tranche}_quantity`)) ||
        !sameDecimal(exactDecimal(supplied.stopPrice, `${tranche}_stop_price`),
          exactDecimal(tranche === "core" ? details.signalStopPrice : details.breakEvenPrice,
            `${tranche}_expected_stop_price`))) {
      throw new Error(`bingx_vst_${tranche}_stop_identity_incomplete`);
    }
    return {
      tranche,
      orderId: exactIdentifier(supplied.orderId, `${tranche}_stop_order_id`),
      quantity: String(supplied.quantity),
      stopPrice: String(supplied.stopPrice),
    };
  }

  function splitPostClosePositionSnapshot(request, details, {
    closedTranche = request.leg,
    remainingQuantity = request.remainingQuantity,
    allowAlreadyResidual = false,
  } = {}) {
    if (!["core", "runner"].includes(closedTranche)) {
      throw new Error("bingx_vst_split_post_close_tranche_invalid");
    }
    const residual = decimalText(exactDecimal(
      remainingQuantity, "split_post_close_remaining_quantity",
    ));
    const prior = positionSnapshotFromRequest(request);
    if (!object(prior) || prior.verified !== true ||
        prior.environment !== "vst" || prior.accountId !== accountId ||
        prior.symbol !== request.symbol ||
        exactIdentifier(prior.positionId, "split_prior_position_id") !== details.positionId) {
      throw new Error("bingx_vst_split_prior_position_snapshot_missing_or_mismatched");
    }
    const priorQuantity = decimalText(exactDecimal(
      prior.quantity, "split_prior_position_quantity",
    ));
    const retainedTranche = closedTranche === "core" ? "runner" : "core";
    const closedStop = stopRecord(request, closedTranche, details);
    const retainedStop = stopRecord(request, retainedTranche, details);
    const expectedPriorStops = {
      core: stopRecord(request, "core", details),
      runner: stopRecord(request, "runner", details),
    };
    const validateStops = (suppliedStops, expected) => {
      if (!object(suppliedStops) ||
          Object.keys(suppliedStops).length !== 2 ||
          !["core", "runner"].every((tranche) => {
            try {
              const actual = snapshotStopRecord(prior, tranche, details.positionId);
              const wanted = expected[tranche];
              return actual.orderId === wanted.orderId &&
                sameDecimal(exactDecimal(actual.quantity, "split_prior_stop_quantity"),
                  exactDecimal(wanted.quantity, "split_expected_prior_stop_quantity")) &&
                sameDecimal(exactDecimal(actual.stopPrice, "split_prior_stop_price"),
                  exactDecimal(wanted.stopPrice, "split_expected_prior_stop_price"));
            } catch {
              return false;
            }
          })) {
        throw new Error("bingx_vst_split_prior_stop_snapshot_mismatch");
      }
    };
    const postStops = {
      [closedTranche]: {
        ...closedStop,
        verified: true,
        positionId: details.positionId,
      },
      [retainedTranche]: {
        ...retainedStop,
        quantity: residual,
        verified: true,
        positionId: details.positionId,
      },
    };
    if (sameDecimal(exactDecimal(priorQuantity, "split_prior_quantity"),
        exactDecimal(details.totalQuantity, "split_total_quantity"))) {
      if (prior.originalStop !== undefined) {
        throw new Error("bingx_vst_split_prior_snapshot_has_original_stop");
      }
      validateStops(prior.protectiveStops, expectedPriorStops);
      return {
        verified: true,
        environment: "vst",
        accountId,
        symbol: request.symbol,
        positionId: details.positionId,
        quantity: residual,
        protectiveStops: postStops,
      };
    }
    if (!allowAlreadyResidual ||
        !sameDecimal(exactDecimal(priorQuantity, "split_prior_quantity"),
          exactDecimal(residual, "split_expected_residual_quantity"))) {
      throw new Error("bingx_vst_split_prior_position_quantity_mismatch");
    }
    validateStops(prior.protectiveStops, postStops);
    if (prior.originalStop !== undefined) {
      throw new Error("bingx_vst_split_residual_snapshot_has_original_stop");
    }
    return prior;
  }

  function registerSplitStop(positionIdValue, tranche, stop) {
    const current = splitStopIdsByPosition.get(positionIdValue) ?? {};
    current[tranche] = typeof stop === "string" ? { orderId: stop } : { ...stop };
    splitStopIdsByPosition.set(positionIdValue, current);
  }

  function exactOpenSplitStop(order, {
    symbol, positionId: expectedPositionId, entryOrderId, id, quantity, stopPrice,
  }) {
    try {
      const parents = [order?.mainOrderId, order?.parentOrderId]
        .filter((value) => value !== undefined && value !== null && value !== "")
        .map((value) => exactIdentifier(value, "stop_parent_order_id"));
      return order?.symbol === symbolName(symbol) &&
        order?.type === "STOP_MARKET" && order?.status === "NEW" &&
        order?.side === "SELL" && order?.positionSide === "LONG" &&
        order?.workingType === "MARK_PRICE" &&
        orderId(order) === id && positionId(order) === expectedPositionId &&
        sameDecimal(exactDecimal(order.origQty, "split_open_stop_quantity"),
          exactDecimal(quantity, "split_expected_stop_quantity")) &&
        sameDecimal(exactDecimal(order.stopPrice, "split_open_stop_price"),
          exactDecimal(stopPrice, "split_expected_stop_price")) &&
        new Set(parents).size <= 1 && parents.every((parent) => parent === entryOrderId);
    } catch {
      return false;
    }
  }

  async function verifySplitPosition(details, request) {
    const position = await readPosition(details.signal.symbol, {
      persistedPosition: splitRequestPositionSnapshot(request, details),
      allowProcessCache: false,
    });
    if (!position.positionId || position.positionId !== details.positionId ||
        !closeEnough(position.quantity, details.totalQuantity, details.totalQuantity)) {
      throw new Error("bingx_vst_split_position_identity_or_quantity_unverified");
    }
    return position;
  }

  async function performSplitStop({ clientOrderId, request, tranche }) {
    if (typeof api.placeVstAutomatedVirtualSplitLongStop !== "function") {
      throw new Error("bingx_vst_split_stop_adapter_method_unavailable");
    }
    const details = splitIntentDetails(request);
    const expectedBaseline = (await api.getOpenOrders(request.symbol))
      .map((row) => orderId(row)).sort();
    if (JSON.stringify(expectedBaseline) !== JSON.stringify(details.baselineOpenOrderIds)) {
      throw new Error("bingx_vst_split_baseline_open_order_ids_changed");
    }
    const position = await verifySplitPosition(details, request);
    const quantity = tranche === "core" ? details.coreQuantity : details.runnerQuantity;
    const stopPrice = tranche === "core" ? details.signalStopPrice : details.breakEvenPrice;
    const previous = tranche === "runner"
      ? [stopRecord(request, "core", details)] : [];
    if (tranche === "runner") {
      const mark = await api.getVstMarkPrice(request.symbol);
      const observedAt = asMillis(mark?.timestamp);
      const now = Number(clock());
      if (mark?.symbol !== symbolName(request.symbol) || observedAt === null ||
          !Number.isSafeInteger(now) || observedAt > now || now - observedAt > 10_000 ||
          compareDecimal(exactDecimal(mark.markPrice, "runner_mark_price"),
            exactDecimal(details.breakEvenPrice, "runner_break_even_price")) <= 0) {
        throw new Error("bingx_vst_runner_be_requires_fresh_mark_above_entry");
      }
    }
    const result = await performMutation("placeVstAutomatedVirtualSplitLongStop", {
      symbol: request.symbol,
      policy: VST_AUTOMATED_LONG_POLICY,
      quantity,
      stopPrice,
      positionId: details.positionId,
      originalStopOrderId: details.originalStopOrderId,
      originalStopPrice: details.signalStopPrice,
      entryOrderId: details.entryOrderId,
      totalQuantity: details.totalQuantity,
      tranche,
      breakEvenPrice: details.breakEvenPrice,
      existingReplacementStops: previous,
      baselineOpenOrderIds: details.baselineOpenOrderIds,
      createdAt: details.createdAt,
      quantityPrecision: details.quantityPrecision,
      pricePrecision: details.pricePrecision,
      sourceSignalId: details.sourceSignalId,
      signal: details.signal,
    });
    // The adapter returns only after independent NEW-history evidence or its
    // two spaced exact position/open-order snapshots. A transport/POST echo is
    // not sufficient and is intentionally not cached as proof.
    if (result?.verified !== true || result.tranche !== tranche ||
        typeof result.orderId !== "string" || result.orderId.trim() === "" ||
        result.symbol !== symbolName(request.symbol)) {
      throw new Error("bingx_vst_split_stop_adapter_proof_missing");
    }
    const stop = { tranche, orderId: result.orderId, quantity, stopPrice };
    registerSplitStop(position.positionId, tranche, stop);
    return;
  }

  async function performCancelOriginalStop({
    clientOrderId, request, mutationContext,
  }) {
    let details;
    let coreStop;
    let runnerStop;
    let current;
    try {
      if (typeof api.cancelVstAutomatedAttachedLongStopAfterSplit !== "function") {
        throw new Error("bingx_vst_split_cancel_adapter_method_unavailable");
      }
      details = splitIntentDetails(request);
      coreStop = stopRecord(request, "core", details);
      runnerStop = stopRecord(request, "runner", details);
      if (coreStop.orderId === runnerStop.orderId) {
        throw new Error("bingx_vst_split_stop_ids_must_be_distinct");
      }
      current = await verifySplitPosition(details, request);
      const orders = await api.getOpenOrders(request.symbol);
      if (JSON.stringify(orders.map((row) => orderId(row)).sort()) !==
          JSON.stringify(details.baselineOpenOrderIds)) {
        throw new Error("bingx_vst_split_cancel_baseline_changed");
      }
    } catch (error) {
      setOriginalStopCancellationProvenance(error, false);
      throw error;
    }
    // From this call onward the adapter's own phase proof is authoritative.
    // If an injected/older adapter has no provenance, fail closed as possibly
    // submitted rather than claiming that DELETE was never sent.
    mutationContext.requestMayHaveBeenSent = true;
    const result = await performMutation("cancelVstAutomatedAttachedLongStopAfterSplit", {
      symbol: request.symbol,
      policy: VST_AUTOMATED_LONG_POLICY,
      originalStopOrderId: details.originalStopOrderId,
      originalStopPrice: details.signalStopPrice,
      positionId: details.positionId,
      entryOrderId: details.entryOrderId,
      totalQuantity: details.totalQuantity,
      breakEvenPrice: details.breakEvenPrice,
      replacementStops: [coreStop, runnerStop],
      sourceSignalId: details.sourceSignalId,
      signal: details.signal,
      baselineOpenOrderIds: details.baselineOpenOrderIds,
      createdAt: details.createdAt,
    });
    if (!result || !["CANCELED", "CANCELLED"].includes(
      String(result.status ?? "").toUpperCase(),
    )) {
      throw new Error("bingx_vst_original_stop_cancel_proof_missing");
    }
    registerSplitStop(current.positionId, "core", coreStop);
    registerSplitStop(current.positionId, "runner", runnerStop);
  }

  async function performSplitPartialClose({ clientOrderId, exchangeClientId, request }) {
    if (typeof api.closeVstAutomatedSplitTranche !== "function") {
      throw new Error("bingx_vst_split_close_adapter_method_unavailable");
    }
    const details = splitIntentDetails(request);
    const tranche = request.leg;
    if (!["core", "runner"].includes(tranche) ||
        request.exchangeAutoResizeAware !== true) {
      throw new Error("bingx_vst_partial_close_requires_exact_leg_and_auto_resize_awareness");
    }
    const trancheStop = stopRecord(request, tranche, details);
    const retainedTranche = tranche === "core" ? "runner" : "core";
    const retainedStop = stopRecord(request, retainedTranche, details);
    if (trancheStop.orderId === retainedStop.orderId) {
      throw new Error("bingx_vst_split_stop_ids_must_be_distinct");
    }
    const priorPosition = positionSnapshotFromRequest(request);
    if (!priorPosition) {
      throw new Error("bingx_vst_split_close_prior_position_snapshot_required");
    }
    const verifiedPosition = await readPosition(request.symbol, {
      persistedPosition: priorPosition,
      allowProcessCache: false,
    });
    if (verifiedPosition.positionId !== details.positionId ||
        !sameDecimal(exactDecimal(verifiedPosition.quantity,
          "split_close_prior_position_quantity"),
        exactDecimal(details.totalQuantity, "split_close_expected_total"))) {
      throw new Error("bingx_vst_split_close_prior_position_mismatch");
    }
    const orders = await api.getOpenOrders(request.symbol);
    if (!Array.isArray(orders) ||
        JSON.stringify(orders.map((row) => orderId(row)).sort()) !==
          JSON.stringify(details.baselineOpenOrderIds)) {
      throw new Error("bingx_vst_partial_close_baseline_open_order_ids_changed");
    }
    const quantity = tranche === "core" ? details.coreQuantity : details.runnerQuantity;
    if (!sameDecimal(exactDecimal(request.quantity, "partial_close_quantity"),
        exactDecimal(quantity, "partial_close_tranche_quantity"))) {
      throw new Error("bingx_vst_partial_close_quantity_not_exact_leg");
    }
    const result = await performMutation("closeVstAutomatedSplitTranche", {
      symbol: request.symbol,
      policy: VST_AUTOMATED_LONG_POLICY,
      quantity,
      totalQuantity: details.totalQuantity,
      positionId: details.positionId,
      clientOrderId: exchangeClientId,
      trancheStop,
      retainedStop,
      tranche,
      signalStopPrice: details.signalStopPrice,
      breakEvenPrice: details.breakEvenPrice,
      sourceSignalId: details.sourceSignalId,
      signal: details.signal,
      baselineOpenOrderIds: details.baselineOpenOrderIds,
      createdAt: details.createdAt,
      quantityPrecision: details.quantityPrecision,
      pricePrecision: details.pricePrecision,
      exchangeAutoResizeAware: true,
    });
    const expectedRemaining = decimalText(subtractDecimal(
      exactDecimal(details.totalQuantity, "split_total_quantity"),
      exactDecimal(quantity, "partial_close_quantity"),
    ));
    if (result?.verified !== true || result.status !== "FILLED" ||
        result.orderId === undefined ||
        !sameDecimal(exactDecimal(result.executedQuantity, "partial_close_executed_quantity"),
          exactDecimal(quantity, "partial_close_quantity")) ||
        !sameDecimal(exactDecimal(result.remainingQuantity,
          "partial_close_remaining_quantity"),
        exactDecimal(expectedRemaining, "expected_remaining_quantity")) ||
        !object(result.retainedStop) ||
        orderId(result.retainedStop) !== retainedStop.orderId ||
        !sameDecimal(exactDecimal(result.retainedStop.origQty ??
          result.retainedStop.quantity, "adapter_retained_stop_quantity"),
        exactDecimal(expectedRemaining, "expected_remaining_quantity"))) {
      throw new Error("bingx_vst_partial_close_adapter_proof_missing");
    }
    registerSplitStop(details.positionId, tranche, trancheStop);
    registerSplitStop(details.positionId, retainedTranche, retainedStop);
  }

  async function performSplitStopCleanup({ clientOrderId, request }) {
    if (typeof api.cancelVstAutomatedSplitStopAfterPartial !== "function") {
      throw new Error("bingx_vst_split_cleanup_adapter_method_unavailable");
    }
    const details = splitIntentDetails(request);
    const tranche = request.leg;
    if (!["core", "runner"].includes(tranche)) {
      throw new Error("bingx_vst_split_cleanup_requires_exact_leg");
    }
    const stopToCancel = stopRecord(request, tranche, details);
    const retainedStop = stopRecord(request, tranche === "core" ? "runner" : "core", details);
    const remainingQuantity = exactDecimal(
      request.remainingQuantity, "split_cleanup_remaining_quantity",
    );
    const currentOrders = await api.getOpenOrders(request.symbol);
    const currentPosition = await readPosition(request.symbol, {
      persistedPosition: splitRequestPositionSnapshot(request, details),
      allowProcessCache: false,
    });
    if (!Array.isArray(currentOrders) ||
        JSON.stringify(currentOrders.map((row) => orderId(row)).sort()) !==
          JSON.stringify(details.baselineOpenOrderIds) ||
        currentPosition.positionId !== details.positionId ||
        !sameDecimal(exactDecimal(currentPosition.quantity, "cleanup_position_quantity"),
          remainingQuantity)) {
      throw new Error("bingx_vst_split_cleanup_baseline_or_position_changed");
    }
    const result = await performMutation("cancelVstAutomatedSplitStopAfterPartial", {
      symbol: request.symbol,
      policy: VST_AUTOMATED_LONG_POLICY,
      stopToCancel,
      retainedStop,
      remainingQuantity: decimalText(remainingQuantity),
      positionId: details.positionId,
      tranche,
      signalStopPrice: details.signalStopPrice,
      breakEvenPrice: details.breakEvenPrice,
      sourceSignalId: details.sourceSignalId,
      signal: details.signal,
      baselineOpenOrderIds: details.baselineOpenOrderIds,
      createdAt: details.createdAt,
    });
    if (!result || !["CANCELED", "CANCELLED"].includes(
      String(result.status ?? "").toUpperCase(),
    )) {
      throw new Error("bingx_vst_split_cleanup_adapter_proof_missing");
    }
    registerSplitStop(details.positionId,
      tranche === "core" ? "runner" : "core", retainedStop);
  }

  async function splitOperationEvidence({ clientOrderId, request }) {
    const unknown = { verified: false, status: "unknown" };
    const needsTwoTickProof = request?.operation === "split_core_stop" ||
      request?.operation === "split_runner_stop";
    let proofKey = null;
    let proofLockHeld = false;
    let retainObservation = false;
    try {
      if (needsTwoTickProof) {
        proofKey = splitStopObservationKey(clientOrderId, request);
        if (!proofKey || splitStopReconciliationInFlight.has(proofKey)) return unknown;
        splitStopReconciliationInFlight.add(proofKey);
        proofLockHeld = true;
      }
      const details = splitIntentDetails(request);
      const name = assertSymbol(request.symbol);
      const now = Number(clock());
      if (needsTwoTickProof) pruneSplitStopObservations(now);
      const range = intentRange(request, now);
      if (!Number.isSafeInteger(now) || now <= 0 ||
          !range ||
          typeof api.queryOrderHistory !== "function" ||
          typeof api.queryOrder !== "function" ||
          typeof api.queryFills !== "function") return unknown;
      const history = await api.queryOrderHistory(request.symbol, range);
      const historyRows = Array.isArray(history) ? history : history?.orders;
      if (!boundedRows(historyRows)) return unknown;

      const strictId = (row, fields) => {
        const values = fields.filter((field) =>
          row?.[field] !== undefined && row[field] !== null).map((field) => row[field]);
        return values.length > 0 &&
          values.every((value) => typeof value === "string" && value.trim() !== "") &&
          new Set(values).size === 1 ? values[0] : null;
      };
      const historyById = (id) => historyRows.filter((row) =>
        strictId(row, ["orderId", "orderID"]) === id);
      const historyMentionsId = (id) => historyRows.some((row) =>
        ["orderId", "orderID"].some((field) => {
          const value = row?.[field];
          return value === id || typeof value === "number" &&
            Number.isSafeInteger(value) && String(value) === id;
        }));
      const currentOrderIds = (orders) => {
        if (!Array.isArray(orders)) return null;
        try {
          const ids = orders.map((row) => strictId(row, ["orderId", "orderID"]));
          return ids.some((id) => id === null) || new Set(ids).size !== ids.length
            ? null : ids.sort();
        } catch {
          return null;
        }
      };
      const exactStopIdentity = (row, {
        id, quantity, stopPrice, status = "NEW",
      }) => {
        try {
          const parentIds = [row?.mainOrderId, row?.parentOrderId]
            .filter((value) => value !== undefined && value !== null && value !== "")
            .map((value) => exactIdentifier(value, "split_stop_parent_id"));
          return row?.symbol === name && row?.type === "STOP_MARKET" &&
            row?.status === status && row?.side === "SELL" &&
            row?.positionSide === "LONG" && row?.workingType === "MARK_PRICE" &&
            strictId(row, ["orderId", "orderID"]) === id &&
            strictId(row, ["positionId", "positionID"]) === details.positionId &&
            sameDecimal(exactDecimal(row.origQty, "split_order_quantity"),
              exactDecimal(quantity, "split_expected_quantity")) &&
            sameDecimal(exactDecimal(row.stopPrice, "split_order_stop_price"),
              exactDecimal(stopPrice, "split_expected_stop_price")) &&
            new Set(parentIds).size <= 1 &&
            parentIds.every((parent) => parent === details.entryOrderId);
        } catch {
          return false;
        }
      };
      const orderTime = (row) => {
        for (const value of [row?.time, row?.createTime, row?.createdTime, row?.orderTime]) {
          const millis = asMillis(value) ??
            (typeof value === "string" ? Date.parse(value) : null);
          if (Number.isSafeInteger(millis) && millis > 0) return millis;
        }
        return null;
      };
      const exactPosition = (positions, quantity) => {
        if (!Array.isArray(positions)) return null;
        const active = positions.filter((row) =>
          row?.symbol === name &&
          strictNumber(row.positionAmt, "split_position_quantity", { allowZero: true }) !== 0);
        if (active.length !== 1 || active[0].positionSide !== "LONG" ||
            positionId(active[0]) !== details.positionId ||
            !sameDecimal(exactDecimal(active[0].positionAmt, "split_position_quantity"),
              exactDecimal(quantity, "split_expected_position_quantity"))) return null;
        return active[0];
      };
      const exactOpenIds = (orders, expected) => {
        const ids = currentOrderIds(orders);
        return ids !== null &&
          JSON.stringify(ids) === JSON.stringify([...expected].sort());
      };
      const hasZeroPositionId = (row) => ["positionId", "positionID"].some(
        (field) => row?.[field] === 0 || row?.[field] === "0");
      const exactHistoryTerminal = async (id, expected) => {
        const matches = historyById(id);
        const queried = await api.queryOrder(request.symbol, { orderId: id });
        if (matches.length > 1) return false;
        const check = (row) => exactStopIdentity(row, {
          ...expected, status: row?.status,
        }) && ["CANCELED", "CANCELLED"].includes(String(row?.status ?? "").toUpperCase()) &&
          row.executedQty !== undefined && row.executedQty !== null &&
          sameDecimal(exactDecimal(row.executedQty, "split_canceled_executed_quantity",
            { allowZero: true }),
          exactDecimal("0", "zero", { allowZero: true }));
        return Boolean(queried) && check(queried) &&
          strictId(queried, ["orderId", "orderID"]) === id &&
          (matches.length === 0 || check(matches[0]));
      };
      const noFills = async (id) => {
        const fills = await api.queryFills(request.symbol, {
          startTs: range.startTs,
          endTs: range.endTs,
          orderId: id,
          currency: "VST",
        });
        const queried = await api.queryOrder(request.symbol, { orderId: id });
        const executedZero = queried?.executedQty !== undefined &&
          queried?.executedQty !== null &&
          sameDecimal(exactDecimal(queried.executedQty,
            "split_no_fills_executed_quantity", { allowZero: true }),
          exactDecimal("0", "zero", { allowZero: true }));
        const unexecutedOpen = queried?.status === "NEW" &&
          (queried.executedQty === undefined || queried.executedQty === null);
        return boundedRows(fills) && fills.length === 0 &&
          (executedZero || unexecutedOpen);
      };
      const enrichPosition = async (quantity, protectiveStops, originalStop = null) => {
        const position = await readPosition(request.symbol, {
          persistedPosition: {
            verified: true,
            environment: "vst",
            accountId,
            symbol: request.symbol,
            positionId: details.positionId,
            quantity,
            protectiveStops,
            ...(originalStop ? { originalStop: {
              verified: true,
              positionId: details.positionId,
              ...originalStop,
            } } : {}),
          },
        });
        if (position.positionId !== details.positionId ||
            !sameDecimal(exactDecimal(position.quantity, "split_snapshot_quantity"),
              exactDecimal(quantity, "split_expected_quantity"))) return null;
        position.protectiveStops = protectiveStops;
        return position;
      };

      if (request.operation === "split_core_stop" ||
          request.operation === "split_runner_stop") {
        const tranche = request.operation === "split_core_stop" ? "core" : "runner";
        const requestedStop = request[`${tranche}Stop`];
        const trancheQuantity = tranche === "core" ? details.coreQuantity : details.runnerQuantity;
        const tranchePrice = tranche === "core" ? details.signalStopPrice : details.breakEvenPrice;
        const suppliedStopId = object(requestedStop)
          ? exactIdentifier(requestedStop.orderId, `${tranche}_stop_order_id`) : null;
        const baselineIds = details.baselineOpenOrderIds;
        const expectedOrderIds = (candidateId) => [...baselineIds, candidateId].sort();
        const original = {
          id: details.originalStopOrderId,
          quantity: details.totalQuantity,
          stopPrice: details.signalStopPrice,
        };
        const priorStops = tranche === "runner"
          ? [original, stopRecord(request, "core", details)]
          : [original];
        const stateIsExact = (positions, orders, candidateId) => {
          if (!exactPosition(positions, details.totalQuantity) ||
              !exactOpenIds(orders, expectedOrderIds(candidateId))) return false;
          const baseline = orders.filter((row) =>
            details.baselineOpenOrderIds.includes(strictId(row, ["orderId", "orderID"])));
          if (baseline.length !== baselineIds.length ||
              !priorStops.every((expected) => baseline.filter((row) =>
                exactStopIdentity(row, {
                  id: expected.orderId ?? expected.id,
                  quantity: expected.quantity,
                  stopPrice: expected.stopPrice,
                })).length === 1)) return false;
          const candidate = orders.filter((row) =>
            exactStopIdentity(row, {
              id: candidateId, quantity: trancheQuantity, stopPrice: tranchePrice,
            }) && (orderTime(row) ?? 0) >= details.createdAt &&
            (orderTime(row) ?? Number.POSITIVE_INFINITY) <= now + 2_000);
          return candidate.length === 1 &&
            !baselineIds.includes(candidateId) &&
            (!suppliedStopId || candidateId === suppliedStopId);
        };
        if (tranche === "runner") {
          // The STOP_MARKET can trigger after the adapter's open-order
          // snapshot but before its exact-ID lookup. In that race the parent
          // may no longer appear in open orders or order history; the fill
          // identifies its trigger ID and queryOrder(parentId) can resolve to
          // the exchange's filled child. Reuse the dedicated triggered-stop
          // observer, then independently require the precise 80/20 residual
          // and both surviving protective stops before returning recovery
          // evidence. This is read-only and never retries the placement POST.
          const fills = await api.queryFills(request.symbol, {
            startTs: range.startTs,
            endTs: range.endTs,
            currency: "VST",
          });
          if (!boundedRows(fills)) return unknown;
          const candidateParents = new Set();
          for (const fill of fills) {
            const triggerId = strictId(fill, ["triggerOrderId", "triggerOrderID"]);
            if (!triggerId || baselineIds.includes(triggerId) ||
                fill.symbol !== name || String(fill.side ?? "").toUpperCase() !== "SELL" ||
                fill.positionSide !== "LONG") continue;
            const quantityValues = [fill.qty, fill.quantity, fill.volume]
              .filter((value) => value !== undefined && value !== null);
            if (quantityValues.length === 0) continue;
            try {
              if (quantityValues.some((value) =>
                !sameDecimal(exactDecimal(value, "runner_fill_candidate_quantity"),
                  exactDecimal(trancheQuantity, "runner_expected_fill_quantity")))) {
                continue;
              }
              const at = fillTime({ time: fill.filledTm ?? fill.filledTime ??
                fill.time ?? fill.timestamp ?? fill.tradeTime });
              if (at === null || at < range.intentAt || at > now) continue;
              candidateParents.add(triggerId);
            } catch {
              return unknown;
            }
          }
          if (candidateParents.size === 1) {
            const [parentStopId] = candidateParents;
            const observed = await observeTriggeredStop({
              symbol: request.symbol,
              positionId: details.positionId,
              stopOrderId: parentStopId,
              stopQuantity: trancheQuantity,
              stopPrice: tranchePrice,
              previousQuantity: details.totalQuantity,
              // The split snapshot may predate the runner POST by hours.
              // Earlier entry fills can contain BingX's numeric sentinel
              // triggerOrderId: 0; they are unrelated to this runner attempt.
              startedAt: range.intentAt,
              requireStopDetails: true,
              expectedParentEntryOrderId: details.entryOrderId,
            });
            const expectedRemaining = decimalText(subtractDecimal(
              exactDecimal(details.totalQuantity, "runner_recovery_total_quantity"),
              exactDecimal(trancheQuantity, "runner_recovery_runner_quantity"),
            ));
            const originalExpected = {
              id: details.originalStopOrderId,
              quantity: expectedRemaining,
              stopPrice: details.signalStopPrice,
            };
            const core = stopRecord(request, "core", details);
            const activeStops = observed?.openStops;
            const exactSurvivor = (stop, expected) =>
              object(stop) && stop.orderId === expected.id &&
              stop.positionId === details.positionId &&
              sameDecimal(exactDecimal(stop.quantity, "runner_residual_stop_quantity"),
                exactDecimal(expected.quantity, "runner_expected_residual_stop_quantity")) &&
              sameDecimal(exactDecimal(stop.stopPrice, "runner_residual_stop_price"),
                exactDecimal(expected.stopPrice, "runner_expected_residual_stop_price"));
            if (observed?.verified !== true || observed.status !== "filled") {
              return {
                ...unknown,
                reason: "runner_fill_recovery_triggered_stop_not_verified",
              };
            }
            if (observed?.verified === true && observed.status === "filled" &&
                observed.parentStopId === parentStopId &&
                observed.parentStopPrice === tranchePrice &&
                observed.residualPosition?.verified === true &&
                observed.residualPosition.positionId === details.positionId &&
                sameDecimal(exactDecimal(observed.residualPosition.quantity,
                  "runner_recovery_residual_quantity"),
                exactDecimal(expectedRemaining, "runner_expected_remaining_quantity")) &&
                Array.isArray(activeStops) && activeStops.length === 2 &&
                new Set(activeStops.map((stop) => stop?.orderId)).size === 2 &&
                exactSurvivor(activeStops.find((stop) =>
                  stop?.orderId === details.originalStopOrderId), originalExpected) &&
                exactSurvivor(activeStops.find((stop) =>
                  stop?.orderId === core.orderId), {
                  id: core.orderId,
                  quantity: expectedRemaining,
                  stopPrice: details.signalStopPrice,
                })) {
              const childHistory = historyById(observed.childOrderId);
              if (childHistory.length !== 1) return unknown;
              const childRow = childHistory[0];
              const childTriggerId = strictId(childRow, [
                "triggerOrderId", "triggerOrderID",
              ]);
              const childPositionIds = ["positionId", "positionID"]
                .filter((field) => childRow[field] !== undefined &&
                  childRow[field] !== null && childRow[field] !== 0 &&
                  childRow[field] !== "0")
                .map((field) => exactIdentifier(childRow[field],
                  "runner_child_history_position_id"));
              const childHistoryQuantityFields = [
                "origQty", "quantity", "executedQty", "cumExecQty", "filledQty",
              ].filter((field) => childRow[field] !== undefined &&
                childRow[field] !== null);
              if (strictId(childRow, ["orderId", "orderID"]) !== observed.childOrderId ||
                  childTriggerId !== parentStopId ||
                  childRow.symbol !== name || childRow.type !== "STOP_MARKET" ||
                  String(childRow.status ?? "").toUpperCase() !== "FILLED" ||
                  String(childRow.side ?? "").toUpperCase() !== "SELL" ||
                  childRow.positionSide !== "LONG" ||
                  childRow.workingType !== undefined &&
                    childRow.workingType !== "MARK_PRICE" ||
                  new Set(childPositionIds).size > 1 ||
                  childPositionIds.some((id) => id !== details.positionId) ||
                  childHistoryQuantityFields.length === 0 ||
                  childHistoryQuantityFields.some((field) =>
                    !sameDecimal(exactDecimal(childRow[field],
                      "runner_child_history_quantity"),
                    exactDecimal(trancheQuantity, "runner_expected_child_quantity"))) ||
                  !sameDecimal(exactDecimal(childRow.stopPrice,
                    "runner_child_history_stop_price"),
                  exactDecimal(tranchePrice, "runner_expected_child_stop_price")) ||
                  (orderTime(childRow) ?? 0) < range.intentAt ||
                  (orderTime(childRow) ?? Number.POSITIVE_INFINITY) > now) return unknown;
              const stops = {
                core: {
                  verified: true,
                  orderId: core.orderId,
                  positionId: details.positionId,
                  quantity: expectedRemaining,
                  stopPrice: details.signalStopPrice,
                },
              };
              const position = await enrichPosition(expectedRemaining, stops, {
                orderId: details.originalStopOrderId,
                quantity: expectedRemaining,
                stopPrice: details.signalStopPrice,
              });
              if (position) {
                return {
                  verified: true,
                  status: "filled",
                  runnerFillRecovery: true,
                  parentStopId,
                  parentStopPrice: tranchePrice,
                  childOrderId: observed.childOrderId,
                  fill: observed.fill,
                  residualPosition: observed.residualPosition,
                  openStops: activeStops,
                  position,
                  exchangeOrderId: observed.childOrderId,
                };
              }
              return {
                ...unknown,
                reason: "runner_fill_recovery_residual_position_not_verified",
              };
            }
            return {
              ...unknown,
              reason: "runner_fill_recovery_exchange_residual_not_exact",
            };
          }
        }
        if (baselineIds.length === 0) return unknown;
        const recentNewHistory = historyRows.filter((row) => {
          const id = strictId(row, ["orderId", "orderID"]);
          return id !== null && !baselineIds.includes(id) &&
            (orderTime(row) ?? 0) >= details.createdAt &&
            (orderTime(row) ?? Number.POSITIVE_INFINITY) <= now + 2_000;
        });
        const newHistory = recentNewHistory.filter((row) => {
          const id = strictId(row, ["orderId", "orderID"]);
          return exactStopIdentity(row, {
            id, quantity: trancheQuantity, stopPrice: tranchePrice,
          });
        });
        if (newHistory.length > 1) return unknown;
        const zeroPositionHistory = newHistory.length === 0
          ? recentNewHistory.filter(hasZeroPositionId) : [];
        if (zeroPositionHistory.length > 1) return unknown;
        const corroborationHistory = zeroPositionHistory.length === 1
          ? zeroPositionHistory[0] : null;
        let candidateId = newHistory.length === 1
          ? strictId(newHistory[0], ["orderId", "orderID"])
          : corroborationHistory
            ? strictId(corroborationHistory, ["orderId", "orderID"]) : null;
        let snapshot;
        if (candidateId) {
          if (historyById(candidateId).length !== 1) return unknown;
          await assertVstEnvironment(request.symbol);
          const [positions, orders] = await Promise.all([
            api.getPositions(request.symbol), api.getOpenOrders(request.symbol),
          ]);
          if (!stateIsExact(positions, orders, candidateId)) return unknown;
          if (corroborationHistory) {
            const openRow = orders.find((row) =>
              strictId(row, ["orderId", "orderID"]) === candidateId);
            const corroborated = corroborateVstActiveStopPosition(
              corroborationHistory,
              openRow,
              { orderId: candidateId, positionId: details.positionId },
            );
            if (!corroborated || !exactStopIdentity(corroborated, {
              id: candidateId,
              quantity: trancheQuantity,
              stopPrice: tranchePrice,
            })) return unknown;
          }
          snapshot = { positions, orders };
        } else {
          const readExactStopState = async () => {
            await assertVstEnvironment(request.symbol);
            const [positions, orders] = await Promise.all([
              api.getPositions(request.symbol), api.getOpenOrders(request.symbol),
            ]);
            if (!Array.isArray(orders)) return null;
            const ids = currentOrderIds(orders);
            if (ids === null) return null;
            const addedIds = ids.filter((id) => !baselineIds.includes(id));
            if (addedIds.length !== 1 || !stateIsExact(positions, orders, addedIds[0])) {
              return null;
            }
            if (historyMentionsId(addedIds[0])) return null;
            return {
              positions,
              orders,
              candidateId: addedIds[0],
              signature: canonicalJsonStringify({
                position: positions.filter((row) => row?.symbol === name &&
                  row.positionSide === "LONG" &&
                  positionId(row) === details.positionId).map((row) => ({
                  symbol: row.symbol,
                  positionSide: row.positionSide,
                  positionId: positionId(row),
                  quantity: decimalText(exactDecimal(row.positionAmt,
                    "split_signature_position_quantity")),
                })),
                orders: orders.map((row) => ({
                  symbol: row.symbol,
                  id: strictId(row, ["orderId", "orderID"]),
                  positionId: strictId(row, ["positionId", "positionID"]),
                  quantity: decimalText(exactDecimal(row.origQty,
                    "split_signature_order_quantity")),
                  stopPrice: decimalText(exactDecimal(row.stopPrice,
                    "split_signature_stop_price")),
                  status: row.status,
                  type: row.type,
                  side: row.side,
                  positionSide: row.positionSide,
                  workingType: row.workingType,
                  mainOrderId: row.mainOrderId || null,
                  parentOrderId: row.parentOrderId || null,
                })).sort((a, b) => a.id.localeCompare(b.id)),
              }),
            };
          };
          const currentSnapshot = await readExactStopState();
          if (!currentSnapshot) return unknown;
          const observedAt = Number(clock());
          if (!Number.isSafeInteger(observedAt) || observedAt <= 0) return unknown;
          const previous = splitStopObservations.get(proofKey);
          if (!previous) {
            rememberSplitStopObservation(proofKey, currentSnapshot.signature, observedAt);
            retainObservation = true;
            return unknown;
          }
          const elapsed = observedAt - previous.observedAt;
          if (elapsed < 0 || elapsed >= splitStopObservationTtlMs) {
            rememberSplitStopObservation(proofKey, currentSnapshot.signature, observedAt);
            retainObservation = true;
            return unknown;
          }
          if (currentSnapshot.signature !== previous.signature) return unknown;
          if (elapsed < 30_000) {
            retainObservation = true;
            return unknown;
          }
          candidateId = currentSnapshot.candidateId;
          snapshot = currentSnapshot;
        }
        const stop = {
          verified: true,
          orderId: candidateId,
          positionId: details.positionId,
          quantity: trancheQuantity,
          stopPrice: tranchePrice,
        };
        const stops = tranche === "core"
          ? { core: stop }
          : {
            core: {
              verified: true,
              orderId: stopRecord(request, "core", details).orderId,
              positionId: details.positionId,
              quantity: details.coreQuantity,
              stopPrice: details.signalStopPrice,
            },
            runner: stop,
          };
        const position = await enrichPosition(details.totalQuantity, stops, {
          orderId: details.originalStopOrderId,
          quantity: details.totalQuantity,
          stopPrice: details.signalStopPrice,
        });
        if (!position) return unknown;
        return {
          verified: true,
          status: "filled",
          position,
          protectiveStops: stops,
          stop,
          exchangeOrderId: candidateId,
        };
      }

      const [positions, orders] = await Promise.all([
        api.getPositions(request.symbol),
        api.getOpenOrders(request.symbol),
      ]);
      if (!Array.isArray(orders)) return unknown;
      const ids = currentOrderIds(orders);
      if (ids === null) return unknown;

      if (request.operation === "cancel_original_stop") {
        const core = stopRecord(request, "core", details);
        const runner = stopRecord(request, "runner", details);
        const original = {
          id: details.originalStopOrderId,
          quantity: details.totalQuantity,
          stopPrice: details.signalStopPrice,
        };
        if (!exactOpenIds(details.baselineOpenOrderIds.map((id) => ({ orderId: id })),
          [details.originalStopOrderId, core.orderId, runner.orderId])) return unknown;
        const canceled = await exactHistoryTerminal(
          details.originalStopOrderId, original,
        ) && await noFills(details.originalStopOrderId);
        if (!canceled || !exactPosition(positions, details.totalQuantity)) return unknown;
        if (
            !exactOpenIds(orders, [core.orderId, runner.orderId]) ||
            orders.filter((row) => exactStopIdentity(row, {
              ...core, id: core.orderId,
            })).length !== 1 ||
            orders.filter((row) => exactStopIdentity(row, {
              ...runner, id: runner.orderId,
            })).length !== 1) {
          return unknown;
        }
        const stops = {
          core: { verified: true, ...core, positionId: details.positionId },
          runner: { verified: true, ...runner, positionId: details.positionId },
        };
        const position = await enrichPosition(details.totalQuantity, stops);
        return position ? {
          verified: true, status: "filled", position, protectiveStops: stops,
        } : unknown;
      }

      if (request.operation === "cancel_split_stop") {
        const tranche = request.leg;
        if (!["core", "runner"].includes(tranche)) return unknown;
        const stopToCancel = stopRecord(request, tranche, details);
        const retainedStop = stopRecord(request, tranche === "core" ? "runner" : "core",
          details);
        const remaining = decimalText(exactDecimal(
          request.remainingQuantity, "split_cleanup_remaining_quantity",
        ));
        if (!exactOpenIds(details.baselineOpenOrderIds.map((id) => ({ orderId: id })),
          [stopToCancel.orderId, retainedStop.orderId])) return unknown;
        const canceled = await exactHistoryTerminal(stopToCancel.orderId, {
          id: stopToCancel.orderId,
          quantity: stopToCancel.quantity,
          stopPrice: stopToCancel.stopPrice,
        }) && await noFills(stopToCancel.orderId);
        if (!canceled || !exactPosition(positions, remaining) ||
            !exactOpenIds(orders, [retainedStop.orderId]) ||
            orders.filter((row) => exactStopIdentity(row, {
              id: retainedStop.orderId,
              quantity: remaining,
              stopPrice: retainedStop.stopPrice,
            })).length !== 1) return unknown;
        const role = tranche === "core" ? "runner" : "core";
        const stops = {
          [role]: {
            verified: true,
            orderId: retainedStop.orderId,
            positionId: details.positionId,
            quantity: remaining,
            stopPrice: retainedStop.stopPrice,
          },
        };
        const position = await enrichPosition(remaining, stops);
        return position ? {
          verified: true, status: "filled", position, protectiveStops: stops,
        } : unknown;
      }
      return unknown;
    } catch {
      return unknown;
    } finally {
      if (proofLockHeld) {
        if (!retainObservation) splitStopObservations.delete(proofKey);
        splitStopReconciliationInFlight.delete(proofKey);
      }
    }
  }

  async function splitPartialCloseEvidence({ clientOrderId, phase, request }) {
    const unknown = { verified: false, status: "unknown" };
    try {
      const details = splitIntentDetails(request);
      const tranche = request.leg;
      if (!["core", "runner"].includes(tranche) ||
          request.exchangeAutoResizeAware !== true) return unknown;
      const closedStop = stopRecord(request, tranche, details);
      const retainedTranche = tranche === "core" ? "runner" : "core";
      const retainedStop = stopRecord(request, retainedTranche, details);
      const closeQuantity = tranche === "core"
        ? details.coreQuantity : details.runnerQuantity;
      if (!sameDecimal(exactDecimal(request.quantity, "split_close_quantity"),
          exactDecimal(closeQuantity, "split_close_expected_quantity"))) return unknown;
      const expectedRemaining = decimalText(subtractDecimal(
        exactDecimal(details.totalQuantity, "split_close_total_quantity"),
        exactDecimal(closeQuantity, "split_close_tranche_quantity"),
      ));
      const now = Number(clock());
      const closeRange = intentRange(request, now);
      if (!closeRange) return unknown;
      const postCloseSnapshot = splitPostClosePositionSnapshot(request, details, {
        closedTranche: tranche,
        remainingQuantity: expectedRemaining,
      });
      const evidence = await orderEvidence({
        clientOrderId,
        phase,
        request,
        persistedPosition: postCloseSnapshot,
        historyWindow: closeRange,
      });
      if (evidence?.verified !== true || evidence.status !== "filled" ||
          !evidence.position ||
          evidence.position.positionId !== details.positionId ||
          !sameDecimal(exactDecimal(evidence.position.quantity,
            "split_close_residual_position"),
          exactDecimal(expectedRemaining, "split_close_expected_residual"))) return unknown;
      const closeHistory = await findIntentOrder(
        request.symbol, linkedId(clientOrderId), closeRange,
      );
      if (!closeHistory ||
          closeHistory.order.status !== "FILLED" ||
          closeHistory.order.symbol !== symbolName(request.symbol) ||
          String(closeHistory.order.side ?? "").toUpperCase() !== "SELL" ||
          closeHistory.order.type !== "MARKET" ||
          String(closeHistory.order.positionSide ?? "") !== "LONG" ||
          orderClientId(closeHistory.order) !== linkedId(clientOrderId) ||
          !sameDecimal(exactDecimal(closeHistory.order.origQty,
            "split_close_history_quantity"),
          exactDecimal(closeQuantity, "split_close_expected_quantity")) ||
          !sameDecimal(exactDecimal(closeHistory.order.executedQty,
            "split_close_history_executed"),
          exactDecimal(closeQuantity, "split_close_expected_execution"))) return unknown;
      const fillRows = await api.queryFills(request.symbol, {
        ...closeRange,
        orderId: closeHistory.exchangeOrderId,
        currency: "VST",
      });
      if (!boundedRows(fillRows) || fillRows.length === 0) return unknown;
      const strictId = (row, fields) => {
        const values = fields.filter((field) =>
          row?.[field] !== undefined && row[field] !== null).map((field) => row[field]);
        return values.length > 0 &&
          values.every((value) => typeof value === "string" && value.trim() !== "") &&
          new Set(values).size === 1 ? values[0] : null;
      };
      let fillScale = 0;
      let fillAmount = 0n;
      const seenFillIds = new Set();
      const seenFillSignatures = new Set();
      for (const fill of fillRows) {
        if (fill?.symbol !== symbolName(request.symbol) ||
            strictId(fill, ["orderId", "orderID"]) !== closeHistory.exchangeOrderId ||
            String(fill.side ?? "").toUpperCase() !== "SELL" ||
            String(fill.positionSide ?? "") !== "LONG") return unknown;
        const quantities = [fill.qty, fill.quantity, fill.volume]
          .filter((value) => value !== undefined && value !== null)
          .map((value) => exactDecimal(value, "split_close_fill_quantity"));
        if (quantities.length === 0 ||
            quantities.some((value) => !sameDecimal(value, quantities[0]))) return unknown;
        const rawFillIds = [fill.tradeId, fill.tradeID, fill.fillId, fill.fillID, fill.id]
          .filter((value) => value !== undefined && value !== null);
        const fillIdentity = rawFillIds.length > 0
          ? rawFillIds.map((value) => exactIdentifier(value, "split_close_fill_id")).join("|")
          : JSON.stringify({
            quantity: decimalText(quantities[0]),
            price: fill.price,
            time: fillTime(fill),
            commission: fill.commission,
            currency: fill.currency ?? fill.commissionAsset,
          });
        const fillIdentitySet = rawFillIds.length > 0
          ? new Set(rawFillIds.map((value) => exactIdentifier(value, "split_close_fill_id")))
          : null;
        if (fillIdentitySet && fillIdentitySet.size !== 1 ||
            seenFillIds.has(fillIdentity) || seenFillSignatures.has(fillIdentity)) {
          return unknown;
        }
        seenFillIds.add(fillIdentity);
        seenFillSignatures.add(fillIdentity);
        const scale = Math.max(fillScale, quantities[0].scale);
        fillAmount = fillAmount * (10n ** BigInt(scale - fillScale)) +
          quantities[0].amount * (10n ** BigInt(scale - quantities[0].scale));
        fillScale = scale;
      }
      const exactFillTotal = { amount: fillAmount, scale: fillScale };
      if (!sameDecimal(exactFillTotal, exactDecimal(closeQuantity,
        "split_close_exact_fill_total"))) return unknown;
      // Validate prices, timestamps and fee asset/amount for every child fill.
      const exactFillSummary = summarizeFills(fillRows, {
        symbol: request.symbol,
        exchangeOrderId: closeHistory.exchangeOrderId,
        side: "SELL",
        requireFees: true,
      });
      if (!exactFillSummary) return unknown;
      const orders = await api.getOpenOrders(request.symbol);
      const orderIds = Array.isArray(orders)
        ? orders.map((row) => strictId(row, ["orderId", "orderID"])) : [];
      if (!Array.isArray(orders) || orderIds.some((id) => id === null) ||
          new Set(orderIds).size !== orderIds.length ||
          JSON.stringify(orderIds.sort()) !==
            JSON.stringify(details.baselineOpenOrderIds)) return unknown;
      const expectedRetained = {
        id: retainedStop.orderId,
        quantity: expectedRemaining,
        stopPrice: retainedStop.stopPrice,
      };
      if (orders.length !== 2 ||
          orders.filter((row) => exactOpenSplitStop(row, {
            symbol: request.symbol, positionId: details.positionId,
            entryOrderId: details.entryOrderId,
            id: closedStop.orderId,
            quantity: closedStop.quantity,
            stopPrice: closedStop.stopPrice,
          })).length !== 1 ||
          orders.filter((row) => exactOpenSplitStop(row, {
            symbol: request.symbol, positionId: details.positionId,
            entryOrderId: details.entryOrderId,
            id: expectedRetained.id,
            quantity: expectedRetained.quantity,
            stopPrice: expectedRetained.stopPrice,
          })).length !== 1) return unknown;
      const stops = {
        [tranche]: {
          verified: true,
          orderId: closedStop.orderId,
          positionId: details.positionId,
          quantity: closedStop.quantity,
          stopPrice: closedStop.stopPrice,
        },
        [retainedTranche]: {
          verified: true,
          orderId: retainedStop.orderId,
          positionId: details.positionId,
          quantity: expectedRemaining,
          stopPrice: retainedStop.stopPrice,
        },
      };
      evidence.position.protectiveStops = stops;
      evidence.exchangeOrderId = closeHistory.exchangeOrderId;
      evidence.executedQuantity = closeQuantity;
      return {
        ...evidence,
        position: evidence.position,
        protectiveStops: stops,
        autoResize: {
          awarenessRequired: true,
          retainedStopOrderId: retainedStop.orderId,
          observedQuantity: expectedRemaining,
        },
      };
    } catch {
      return unknown;
    }
  }

  function strictExchangeId(row, fields, label) {
    const values = fields.filter((field) =>
      row?.[field] !== undefined && row[field] !== null).map((field) => row[field]);
    if (values.length === 0 ||
        values.some((value) => typeof value !== "string" || value.trim() === "") ||
        new Set(values).size !== 1) {
      throw new Error(`bingx_vst_${label}_missing_or_conflicting`);
    }
    return values[0];
  }

  function splitLegUpgradeDetails(request, clientOrderId, cancelPhase = false) {
    const positionIdValue = strictExchangeId(
      { positionId: request?.positionId }, ["positionId"], "position_id",
    );
    const leg = request?.leg;
    const total = exactDecimal(request?.totalQuantity, "split_upgrade_total_quantity");
    const upgradeIntentId = request?.upgradeIntentId;
    const oldStop = request?.oldStop;
    const otherStop = request?.otherStop;
    const oldQuantity = exactDecimal(oldStop?.quantity, "split_upgrade_old_quantity");
    const otherQuantity = exactDecimal(otherStop?.quantity, "split_upgrade_other_quantity");
    const ratioScale = Math.max(total.scale, oldQuantity.scale, otherQuantity.scale);
    if (!["core", "runner"].includes(leg) ||
        !object(oldStop) || !object(otherStop) ||
        oldStop.tranche !== leg ||
        otherStop.tranche !== (leg === "core" ? "runner" : "core") ||
        typeof upgradeIntentId !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(upgradeIntentId) ||
        decimalAtScale(oldQuantity, ratioScale) * 100n !==
          decimalAtScale(total, ratioScale) * BigInt(leg === "core" ? 80 : 20) ||
        decimalAtScale(otherQuantity, ratioScale) * 100n !==
          decimalAtScale(total, ratioScale) * BigInt(leg === "core" ? 20 : 80) ||
        !sameDecimal(subtractDecimal(total, oldQuantity), otherQuantity)) {
      throw new Error("bingx_vst_split_upgrade_request_contract_invalid");
    }
    const oldStopRecord = {
      tranche: leg,
      orderId: strictExchangeId(oldStop, ["orderId", "orderID"], "old_stop_order_id"),
      quantity: decimalText(oldQuantity),
      stopPrice: decimalText(exactDecimal(oldStop.stopPrice, "split_upgrade_old_stop_price")),
    };
    const otherStopRecord = {
      tranche: otherStop.tranche,
      orderId: strictExchangeId(otherStop, ["orderId", "orderID"], "other_stop_order_id"),
      quantity: decimalText(otherQuantity),
      stopPrice: decimalText(exactDecimal(otherStop.stopPrice,
        "split_upgrade_other_stop_price")),
    };
    const newStopPrice = decimalText(exactDecimal(
      request?.newStopPrice ?? request?.newStop?.stopPrice,
      "split_upgrade_new_stop_price",
    ));
    if (oldStopRecord.orderId === otherStopRecord.orderId ||
        compareDecimal(exactDecimal(newStopPrice, "split_upgrade_new_stop_price"),
          exactDecimal(oldStopRecord.stopPrice, "split_upgrade_old_stop_price")) <= 0) {
      throw new Error("bingx_vst_split_upgrade_stop_prices_or_ids_invalid");
    }
    let newStopRecord = null;
    let exchangeClientOrderId;
    if (cancelPhase) {
      const supplied = request?.newStop;
      if (!object(supplied) || supplied.tranche !== leg ||
          !sameDecimal(exactDecimal(supplied.quantity, "split_upgrade_new_quantity"),
            exactDecimal(oldStopRecord.quantity, "split_upgrade_expected_new_quantity")) ||
          !sameDecimal(exactDecimal(supplied.stopPrice, "split_upgrade_new_stop_price"),
            exactDecimal(newStopPrice, "split_upgrade_expected_new_price"))) {
        throw new Error("bingx_vst_split_upgrade_new_stop_contract_invalid");
      }
      newStopRecord = {
        tranche: leg,
        orderId: strictExchangeId(supplied, ["orderId", "orderID"],
          "new_stop_order_id"),
        quantity: decimalText(exactDecimal(supplied.quantity, "split_upgrade_new_quantity")),
        stopPrice: decimalText(exactDecimal(supplied.stopPrice,
          "split_upgrade_new_stop_price")),
        clientOrderId: strictExchangeId(supplied, ["clientOrderId", "clientOrderID"],
          "new_stop_client_order_id"),
      };
      if (!/^vst-[a-f0-9]{28}$/.test(newStopRecord.clientOrderId)) {
        throw new Error("bingx_vst_split_upgrade_client_order_id_invalid");
      }
      exchangeClientOrderId = newStopRecord.clientOrderId;
    } else {
      if (typeof clientOrderId !== "string" || clientOrderId.trim() === "") {
        throw new Error("bingx_vst_split_upgrade_worker_client_id_missing");
      }
      exchangeClientOrderId = linkedId(clientOrderId);
      newStopRecord = {
        tranche: leg,
        quantity: oldStopRecord.quantity,
        stopPrice: newStopPrice,
        clientOrderId: exchangeClientOrderId,
      };
    }
    const stopIds = [oldStopRecord.orderId, otherStopRecord.orderId,
      ...(cancelPhase ? [newStopRecord.orderId] : [])];
    if (new Set(stopIds).size !== stopIds.length ||
        request?.entryOrderId !== undefined && request.entryOrderId !== null &&
          (typeof request.entryOrderId !== "string" || request.entryOrderId.trim() === "")) {
      throw new Error("bingx_vst_split_upgrade_stop_identity_invalid");
    }
    return {
      symbol: request.symbol,
      positionId: positionIdValue,
      totalQuantity: decimalText(total),
      leg,
      oldStop: oldStopRecord,
      otherStop: otherStopRecord,
      newStop: newStopRecord,
      newStopPrice,
      exchangeClientOrderId,
      upgradeIntentId,
      ...(request.entryOrderId ? { entryOrderId: request.entryOrderId } : {}),
      identity: `${request.symbol}:${positionIdValue}:${leg}:${oldStopRecord.orderId}:${upgradeIntentId}`,
    };
  }

  function soleSplitLegCloseDetails(request, clientOrderId) {
    const positionIdValue = strictExchangeId(
      { positionId: request?.positionId }, ["positionId"], "position_id",
    );
    const stop = request?.stop;
    const quantity = exactDecimal(request?.quantity, "sole_split_close_quantity");
    const closeIntentId = request?.closeIntentId;
    if (!object(stop) || !["core", "runner"].includes(stop.tranche) ||
        typeof closeIntentId !== "string" ||
        !sameDecimal(quantity, exactDecimal(stop.quantity, "sole_split_stop_quantity")) ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(closeIntentId) ||
        typeof clientOrderId !== "string" || clientOrderId.trim() === "") {
      throw new Error("bingx_vst_sole_split_close_request_invalid");
    }
    return {
      symbol: request.symbol,
      positionId: positionIdValue,
      quantity: decimalText(quantity),
      stop: {
        tranche: stop.tranche,
        orderId: strictExchangeId(stop, ["orderId", "orderID"],
          "sole_split_stop_order_id"),
        quantity: decimalText(exactDecimal(stop.quantity, "sole_split_stop_quantity")),
        stopPrice: decimalText(exactDecimal(stop.stopPrice, "sole_split_stop_price")),
      },
      closeIntentId,
      exchangeClientOrderId: linkedId(clientOrderId),
    };
  }

  function exactCommissionedFillSummary(fills, {
    symbol, exchangeOrderId, side, expectedQuantity,
  }) {
    if (!Array.isArray(fills) || fills.length === 0) return null;
    let total = { amount: 0n, scale: 0 };
    const fillIds = new Set();
    const signatures = new Set();
    const normalized = [];
    for (const fill of fills) {
      if (fill?.symbol !== symbolName(symbol) ||
          strictExchangeId(fill, ["orderId", "orderID"], "fill_order_id") !== exchangeOrderId ||
          fill.side !== side ||
          fill.positionSide !== undefined && fill.positionSide !== null &&
            fill.positionSide !== "LONG") return null;
      const quantities = [fill.qty, fill.quantity, fill.volume]
        .filter((value) => value !== undefined && value !== null)
        .map((value) => exactDecimal(value, "split_fill_quantity"));
      if (quantities.length === 0 ||
          quantities.some((value) => !sameDecimal(value, quantities[0]))) return null;
      const idFields = ["tradeId", "tradeID", "fillId", "fillID", "id"];
      const ids = idFields.filter((field) => fill[field] !== undefined && fill[field] !== null)
        .map((field) => fill[field]);
      const fillId = ids.length > 0
        ? strictExchangeId(fill, idFields, "fill_id") : null;
      const commission = fill.commission ?? fill.fee ??
        fill.commissionAmount ?? fill.feeAmount;
      const asset = fill.commissionAsset ?? fill.feeAsset ??
        fill.feeCurrency ?? fill.currency;
      const price = fill.price ?? fill.tradePrice ?? fill.fillPrice;
      const normalizedFill = {
        ...fill,
        price,
        commission,
        currency: asset,
      };
      const signature = JSON.stringify({
        quantity: decimalText(quantities[0]),
        price,
        time: fillTime(fill),
        commission: String(commission),
        asset,
      });
      const identity = fillId ?? signature;
      if (fillId && fillIds.has(fillId) || signatures.has(signature)) return null;
      if (fillId) fillIds.add(fillId);
      signatures.add(signature);
      const scale = Math.max(total.scale, quantities[0].scale);
      total = {
        amount: decimalAtScale(total, scale) +
          decimalAtScale(quantities[0], scale),
        scale,
      };
      normalized.push(normalizedFill);
      if (!identity) return null;
    }
    if (!sameDecimal(total, exactDecimal(expectedQuantity, "split_expected_fill_quantity"))) {
      return null;
    }
    return summarizeFills(normalized, {
      symbol, exchangeOrderId, side, requireFees: true,
    });
  }

  async function splitLegUpgradeEvidence({ request, clientOrderId, cancelPhase, exchangeOrderId }) {
    const unknown = { verified: false, status: "unknown" };
    try {
      const details = splitLegUpgradeDetails(request, clientOrderId, cancelPhase);
      const name = assertSymbol(details.symbol);
      const now = Number(clock());
      const range = intentRange(request, now);
      if (!Number.isSafeInteger(now) || now <= 0 ||
          !range ||
          typeof api.queryOrderHistory !== "function" ||
          typeof api.queryOrder !== "function" || typeof api.queryFills !== "function") {
        return unknown;
      }
      const positionsMatch = (positions) => {
        if (!Array.isArray(positions)) return false;
        const active = positions.filter((row) =>
          row?.symbol === name &&
          strictNumber(row.positionAmt, "split_raise_position_quantity",
            { allowZero: true }) !== 0);
        return active.length === 1 && active[0].positionSide === "LONG" &&
          positionId(active[0]) === details.positionId &&
          sameDecimal(exactDecimal(active[0].positionAmt,
            "split_raise_position_quantity"),
          exactDecimal(details.totalQuantity, "split_raise_total_quantity"));
      };
      const isOpenStop = (row, descriptor, status = "NEW") =>
        row?.status === status && exactOpenSplitStop(row, {
          symbol: details.symbol,
          positionId: details.positionId,
          entryOrderId: details.entryOrderId,
          id: descriptor.orderId,
          quantity: descriptor.quantity,
          stopPrice: descriptor.stopPrice,
        });
      const exactClient = (row) => {
        if (!cancelPhase && request.stopTransferProtocol === 1 &&
            typeof exchangeOrderId === "string" && /^[1-9]\d*$/.test(exchangeOrderId)) {
          const supplied = [row?.clientOrderId, row?.clientOrderID, row?.clientOid]
            .filter(value => value !== undefined && value !== null && value !== "");
          return orderId(row) === exchangeOrderId &&
            supplied.every(value => value === details.exchangeClientOrderId);
        }
        return orderClientId(row) === details.exchangeClientOrderId;
      };
      const orderIds = (orders) => {
        if (!Array.isArray(orders)) return null;
        try {
          const ids = orders.map((row) =>
            strictExchangeId(row, ["orderId", "orderID"], "open_order_id"));
          return new Set(ids).size === ids.length ? ids.sort() : null;
        } catch {
          return null;
        }
      };
      const noFills = async (id) => {
        const rows = await api.queryFills(details.symbol, {
          startTs: range.startTs, endTs: range.endTs, orderId: id, currency: "VST",
        });
        const queried = await api.queryOrder(details.symbol, { orderId: id });
        const executedZero = queried?.executedQty !== undefined &&
          queried?.executedQty !== null &&
          sameDecimal(exactDecimal(queried.executedQty,
            "split_upgrade_no_fills_executed", { allowZero: true }),
          exactDecimal("0", "zero", { allowZero: true }));
        const unexecutedOpen = queried?.status === "NEW" &&
          (queried.executedQty === undefined || queried.executedQty === null);
        return boundedRows(rows) && rows.length === 0 &&
          (executedZero || unexecutedOpen);
      };
      const history = await api.queryOrderHistory(details.symbol, range);
      const historyRows = Array.isArray(history) ? history : history?.orders;
      if (!boundedRows(historyRows)) return unknown;

      if (!cancelPhase) {
        const historyLinked = historyRows.filter((row) =>
          orderClientId(row) === details.exchangeClientOrderId);
        if (historyLinked.length > 1 ||
            historyLinked.length === 1 && historyLinked[0].status !== "NEW") return unknown;
        const readExactSnapshot = async () => {
          await assertVstEnvironment(details.symbol);
          const [positions, orders] = await Promise.all([
            api.getPositions(details.symbol), api.getOpenOrders(details.symbol),
          ]);
          const ids = orderIds(orders);
          if (ids === null || !positionsMatch(positions)) return null;
          const baselineIds = [details.oldStop.orderId, details.otherStop.orderId].sort();
          const added = ids.filter((id) => !baselineIds.includes(id));
          if (added.length !== 1) return null;
          const candidateId = added[0];
          const candidate = orders.find((row) =>
            strictExchangeId(row, ["orderId", "orderID"], "upgrade_candidate_order_id") ===
              candidateId);
          const newStop = {
            tranche: details.leg,
            orderId: candidateId,
            quantity: details.oldStop.quantity,
            stopPrice: details.newStopPrice,
          };
          if (ids.length !== 3 ||
              JSON.stringify(ids) !== JSON.stringify([
                details.oldStop.orderId, details.otherStop.orderId, candidateId,
              ].sort()) ||
              orders.filter((row) => isOpenStop(row, details.oldStop)).length !== 1 ||
              orders.filter((row) => isOpenStop(row, details.otherStop)).length !== 1 ||
              !isOpenStop(candidate, newStop) || !exactClient(candidate)) return null;
          const [oldFills, otherFills, newFills] = await Promise.all([
            noFills(details.oldStop.orderId),
            noFills(details.otherStop.orderId),
            noFills(candidateId),
          ]);
          if (!oldFills || !otherFills || !newFills) return null;
          const queried = await api.queryOrder(details.symbol, {
            clientOrderId: details.exchangeClientOrderId,
          });
          const corroboratedActiveQuery = queried &&
            corroborateVstActiveStopPosition(queried, candidate, {
              orderId: candidateId,
              positionId: details.positionId,
            });
          const exactQueriedStop = queried && (
            isOpenStop(queried, newStop) ||
            corroboratedActiveQuery && isOpenStop(corroboratedActiveQuery, newStop)
          );
          if (!queried ||
              strictExchangeId(queried, ["orderId", "orderID"],
            "upgrade_query_order_id") !== candidateId ||
              !exactQueriedStop ||
              !exactClient(queried)) return null;
          return {
            candidateId,
            newStop,
            positions,
            orders,
            signature: JSON.stringify({
              position: positions.filter((row) => row?.symbol === name &&
                row.positionSide === "LONG" && positionId(row) === details.positionId),
              orders: orders.map((row) => ({
                id: strictExchangeId(row, ["orderId", "orderID"], "snapshot_order_id"),
                clientOrderId: orderClientId(row),
                positionId: positionId(row),
                quantity: row.origQty,
                stopPrice: row.stopPrice,
                status: row.status,
                type: row.type,
                side: row.side,
                positionSide: row.positionSide,
                workingType: row.workingType,
                time: row.time ?? row.createTime ?? row.createdTime ?? null,
                mainOrderId: row.mainOrderId ?? null,
                parentOrderId: row.parentOrderId ?? null,
              })).sort((left, right) => left.id.localeCompare(right.id)),
            }),
          };
        };

        let snapshot;
        if (historyLinked.length === 1) {
          const candidateId = strictExchangeId(historyLinked[0],
            ["orderId", "orderID"], "upgrade_history_order_id");
          const expectedHistoryStop = {
            tranche: details.leg,
            orderId: candidateId,
            quantity: details.oldStop.quantity,
            stopPrice: details.newStopPrice,
          };
          if (candidateId === details.oldStop.orderId ||
              candidateId === details.otherStop.orderId ||
              !isOpenStop(historyLinked[0], expectedHistoryStop) ||
              !exactClient(historyLinked[0])) return unknown;
          snapshot = await readExactSnapshot();
          if (!snapshot || snapshot.candidateId !== candidateId) return unknown;
        } else {
          const first = await readExactSnapshot();
          if (!first) return unknown;
          const firstAt = Number(clock());
          if (!Number.isSafeInteger(firstAt) || firstAt <= 0) return unknown;
          const elapsed = Number(clock()) - firstAt;
          await sleep(Math.max(0, 30_000 - elapsed));
          const second = await readExactSnapshot();
          const secondAt = Number(clock());
          if (!second || secondAt - firstAt < 30_000 ||
              second.candidateId !== first.candidateId ||
              second.signature !== first.signature) return unknown;
          snapshot = second;
        }
        const newStop = {
          ...snapshot.newStop,
          verified: true,
          positionId: details.positionId,
          clientOrderId: details.exchangeClientOrderId,
        };
        const otherStop = {
          ...details.otherStop,
          verified: true,
          positionId: details.positionId,
        };
        const stops = {
          [details.leg]: newStop,
          [details.otherStop.tranche]: otherStop,
        };
        const position = await readPosition(details.symbol);
        if (position.positionId !== details.positionId ||
            !sameDecimal(exactDecimal(position.quantity, "split_raise_final_quantity"),
              exactDecimal(details.totalQuantity, "split_raise_expected_quantity"))) {
          return unknown;
        }
        position.protectiveStops = stops;
        return {
          verified: true, status: "filled", position, protectiveStops: stops,
          oldStop: details.oldStop, newStop, otherStop,
          exchangeOrderId: snapshot.candidateId,
          clientOrderId: details.exchangeClientOrderId,
          upgradeIntentId: details.upgradeIntentId,
        };
      }

      const oldHistory = historyRows.filter((row) =>
        strictExchangeId(row, ["orderId", "orderID"], "old_stop_history_id") ===
          details.oldStop.orderId);
      const oldQuery = await api.queryOrder(details.symbol, {
        orderId: details.oldStop.orderId,
      });
      const canceledStop = (row) => row &&
        strictExchangeId(row, ["orderId", "orderID"], "canceled_old_stop_id") ===
          details.oldStop.orderId &&
        row.symbol === name && row.type === "STOP_MARKET" &&
        ["CANCELED", "CANCELLED"].includes(String(row.status ?? "").toUpperCase()) &&
        row.side === "SELL" && row.positionSide === "LONG" &&
        row.workingType === "MARK_PRICE" &&
        positionId(row) === details.positionId &&
        sameDecimal(exactDecimal(row.origQty, "split_upgrade_canceled_quantity"),
          exactDecimal(details.oldStop.quantity, "split_upgrade_expected_old_quantity")) &&
        sameDecimal(exactDecimal(row.stopPrice, "split_upgrade_canceled_price"),
          exactDecimal(details.oldStop.stopPrice, "split_upgrade_expected_old_price")) &&
        (row.executedQty === undefined || row.executedQty === null ||
          sameDecimal(exactDecimal(row.executedQty, "split_upgrade_canceled_executed",
            { allowZero: true }), exactDecimal("0", "zero", { allowZero: true })));
      if (oldHistory.length > 1 ||
          oldHistory.length === 1 && !canceledStop(oldHistory[0]) ||
          !canceledStop(oldQuery) || !await noFills(details.oldStop.orderId)) return unknown;
      await assertVstEnvironment(details.symbol);
      const [positions, orders] = await Promise.all([
        api.getPositions(details.symbol), api.getOpenOrders(details.symbol),
      ]);
      if (!positionsMatch(positions) ||
          JSON.stringify(orderIds(orders)) !== JSON.stringify([
            details.newStop.orderId, details.otherStop.orderId,
          ].sort()) ||
          orders.filter((row) => isOpenStop(row, details.newStop)).length !== 1 ||
          orders.filter((row) => isOpenStop(row, details.otherStop)).length !== 1 ||
          !exactClient(orders.find((row) => orderClientId(row) ===
            details.exchangeClientOrderId)) ||
          !await noFills(details.newStop.orderId) ||
          !await noFills(details.otherStop.orderId)) return unknown;
      const stops = {
        [details.leg]: {
          ...details.newStop, verified: true, positionId: details.positionId,
        },
        [details.otherStop.tranche]: {
          ...details.otherStop, verified: true, positionId: details.positionId,
        },
      };
      const position = await readPosition(details.symbol);
      if (position.positionId !== details.positionId ||
          !sameDecimal(exactDecimal(position.quantity, "split_raise_final_quantity"),
            exactDecimal(details.totalQuantity, "split_raise_expected_quantity"))) {
        return unknown;
      }
      position.protectiveStops = stops;
      return {
        verified: true, status: "filled", position, protectiveStops: stops,
        canceledStopOrderId: details.oldStop.orderId,
        newStop: details.newStop, otherStop: details.otherStop,
        upgradeIntentId: details.upgradeIntentId,
      };
    } catch {
      return unknown;
    }
  }

  async function soleSplitLegCloseEvidence({ request, clientOrderId, phase }) {
    const unknown = { verified: false, status: "unknown" };
    try {
      const details = soleSplitLegCloseDetails(request, clientOrderId);
      const name = assertSymbol(details.symbol);
      const now = Number(clock());
      const range = intentRange(request, now);
      if (!Number.isSafeInteger(now) || now <= 0 || !range) return unknown;
      await assertVstEnvironment(details.symbol);
      const history = await api.queryOrderHistory(details.symbol, range);
      const historyRows = Array.isArray(history) ? history : history?.orders;
      if (!boundedRows(historyRows)) return unknown;
      const closeMatch = await findIntentOrder(
        details.symbol, details.exchangeClientOrderId, range,
      );
      if (!closeMatch) return unknown;
      const close = closeMatch.order;
      const closeOrderId = strictExchangeId(close, ["orderId", "orderID"],
        "sole_split_close_order_id");
      const closeMatches = (row) => row &&
        strictExchangeId(row, ["orderId", "orderID"], "sole_split_close_query_id") ===
          closeOrderId &&
        row.symbol === name && row.type === "MARKET" && row.status === "FILLED" &&
        row.side === "SELL" && row.positionSide === "LONG" &&
        orderClientId(row) === details.exchangeClientOrderId &&
        sameDecimal(exactDecimal(row.origQty, "sole_split_close_order_quantity"),
          exactDecimal(details.quantity, "sole_split_expected_quantity")) &&
        sameDecimal(exactDecimal(row.executedQty, "sole_split_close_executed_quantity"),
          exactDecimal(details.quantity, "sole_split_expected_execution"));
      const queriedClose = await api.queryOrder(details.symbol, {
        clientOrderId: details.exchangeClientOrderId,
      });
      if (!closeMatches(close) || !closeMatches(queriedClose)) return unknown;
      const fillRows = await api.queryFills(details.symbol, {
        startTs: range.startTs, endTs: range.endTs,
        orderId: closeOrderId, currency: "VST",
      });
      if (!boundedRows(fillRows)) return unknown;
      const fill = exactCommissionedFillSummary(fillRows, {
        symbol: details.symbol,
        exchangeOrderId: closeOrderId,
        side: "SELL",
        expectedQuantity: details.quantity,
      });
      if (!fill) return unknown;

      const stopHistory = historyRows.filter((row) =>
        strictExchangeId(row, ["orderId", "orderID"], "survivor_stop_history_id") ===
          details.stop.orderId);
      const [stopOrder, stopFills, positions, orders] = await Promise.all([
        api.queryOrder(details.symbol, { orderId: details.stop.orderId }),
        api.queryFills(details.symbol, {
          startTs: range.startTs, endTs: range.endTs,
          orderId: details.stop.orderId, currency: "VST",
        }),
        api.getPositions(details.symbol),
        api.getOpenOrders(details.symbol),
      ]);
      const canceledStop = (row) => row &&
        strictExchangeId(row, ["orderId", "orderID"], "survivor_stop_id") ===
          details.stop.orderId &&
        row.symbol === name && row.type === "STOP_MARKET" &&
        ["CANCELED", "CANCELLED"].includes(String(row.status ?? "").toUpperCase()) &&
        row.side === "SELL" && row.positionSide === "LONG" &&
        row.workingType === "MARK_PRICE" &&
        positionId(row) === details.positionId &&
        sameDecimal(exactDecimal(row.origQty, "survivor_stop_quantity"),
          exactDecimal(details.stop.quantity, "survivor_expected_quantity")) &&
        sameDecimal(exactDecimal(row.stopPrice, "survivor_stop_price"),
          exactDecimal(details.stop.stopPrice, "survivor_expected_price")) &&
        (row.executedQty === undefined || row.executedQty === null ||
          sameDecimal(exactDecimal(row.executedQty, "survivor_stop_executed",
            { allowZero: true }), exactDecimal("0", "zero", { allowZero: true })));
      if (stopHistory.length > 1 ||
          stopHistory.length === 1 && !canceledStop(stopHistory[0]) ||
          !canceledStop(stopOrder) || !boundedRows(stopFills) || stopFills.length !== 0 ||
          !Array.isArray(orders) || orders.length !== 0 || !Array.isArray(positions) ||
          positions.some((row) => row?.symbol === name &&
            strictNumber(row.positionAmt, "sole_split_close_flat_position", {
              allowZero: true,
            }) !== 0)) return unknown;
      const position = await readPosition(details.symbol);
      if (position.quantity !== 0) return unknown;
      return {
        verified: true, status: "filled", position,
        exchangeOrderId: closeOrderId,
        clientOrderId: details.exchangeClientOrderId,
        closeIntentId: details.closeIntentId,
        closedQuantity: details.quantity,
        fill,
        canceledStopOrderId: details.stop.orderId,
        flat: true,
        noOpenStops: true,
      };
    } catch {
      return unknown;
    }
  }

  function fullSplitCloseDetails(request, clientOrderId) {
    const positionIdValue = strictExchangeId(
      { positionId: request?.positionId }, ["positionId"], "full_split_position_id",
    );
    const total = exactDecimal(request?.totalQuantity, "full_split_total_quantity");
    const closeIntentId = request?.closeIntentId;
    const coreStop = request?.coreStop;
    const runnerStop = request?.runnerStop;
    const coreQuantity = exactDecimal(coreStop?.quantity, "full_split_core_quantity");
    const runnerQuantity = exactDecimal(runnerStop?.quantity, "full_split_runner_quantity");
    const scale = Math.max(total.scale, coreQuantity.scale, runnerQuantity.scale);
    if (typeof closeIntentId !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(closeIntentId) ||
        typeof clientOrderId !== "string" || clientOrderId.trim() === "" ||
        !object(coreStop) || !object(runnerStop) ||
        coreStop.tranche !== "core" || runnerStop.tranche !== "runner" ||
        decimalAtScale(coreQuantity, scale) * 100n !==
          decimalAtScale(total, scale) * 80n ||
        decimalAtScale(runnerQuantity, scale) * 100n !==
          decimalAtScale(total, scale) * 20n ||
        !sameDecimal(subtractDecimal(total, coreQuantity), runnerQuantity)) {
      throw new Error("bingx_vst_full_split_close_request_invalid");
    }
    const stops = [
      {
        tranche: "core",
        orderId: strictExchangeId(coreStop, ["orderId", "orderID"],
          "full_split_core_stop_id"),
        quantity: decimalText(coreQuantity),
        stopPrice: decimalText(exactDecimal(coreStop.stopPrice,
          "full_split_core_stop_price")),
      },
      {
        tranche: "runner",
        orderId: strictExchangeId(runnerStop, ["orderId", "orderID"],
          "full_split_runner_stop_id"),
        quantity: decimalText(runnerQuantity),
        stopPrice: decimalText(exactDecimal(runnerStop.stopPrice,
          "full_split_runner_stop_price")),
      },
    ];
    if (new Set(stops.map((stop) => stop.orderId)).size !== 2) {
      throw new Error("bingx_vst_full_split_stop_ids_ambiguous");
    }
    return {
      symbol: request.symbol,
      positionId: positionIdValue,
      totalQuantity: decimalText(total),
      coreStop: stops[0],
      runnerStop: stops[1],
      stops,
      closeIntentId,
      exchangeClientOrderId: linkedId(clientOrderId),
    };
  }

  function preRunnerSplitCloseDetails(request, clientOrderId) {
    const positionIdValue = strictExchangeId(
      { positionId: request?.positionId },
      ["positionId"],
      "pre_runner_split_position_id",
    );
    const total = exactDecimal(request?.totalQuantity,
      "pre_runner_split_total_quantity");
    const closeIntentId = request?.closeIntentId;
    const originalStopRequest = request?.originalStop;
    const coreStopRequest = request?.coreStop;
    const stops = [
      { tranche: "original", request: originalStopRequest },
      { tranche: "core", request: coreStopRequest },
    ].map(({ tranche, request: stopRequest }) => {
      if (!object(stopRequest) ||
          stopRequest.tranche !== undefined && stopRequest.tranche !== tranche ||
          stopRequest.positionId !== undefined &&
            exactIdentifier(stopRequest.positionId,
              "pre_runner_split_stop_position_id") !== positionIdValue ||
          stopRequest.symbol !== undefined &&
            stopRequest.symbol !== symbolName(request.symbol)) {
        throw new Error("bingx_vst_pre_runner_split_stop_record_invalid");
      }
      const quantity = exactDecimal(stopRequest.quantity,
        `pre_runner_split_${tranche}_stop_quantity`);
      const stopPrice = exactDecimal(stopRequest.stopPrice,
        `pre_runner_split_${tranche}_stop_price`);
      if (quantity.amount <= 0n || stopPrice.amount <= 0n) {
        throw new Error("bingx_vst_pre_runner_split_stop_record_invalid");
      }
      return {
        tranche,
        orderId: strictExchangeId(stopRequest, ["orderId", "orderID"],
          `pre_runner_split_${tranche}_stop_id`),
        quantity: decimalText(quantity),
        stopPrice: decimalText(stopPrice),
      };
    });
    const [originalStop, coreStop] = stops;
    const scale = Math.max(total.scale,
      exactDecimal(originalStop.quantity, "pre_runner_original_quantity").scale,
      exactDecimal(coreStop.quantity, "pre_runner_core_quantity").scale);
    if (!sameDecimal(exactDecimal(originalStop.quantity,
      "pre_runner_original_quantity"), total) ||
        decimalAtScale(exactDecimal(coreStop.quantity, "pre_runner_core_quantity"),
          scale) * 100n !== decimalAtScale(total, scale) * 80n ||
        originalStop.orderId === coreStop.orderId ||
        typeof closeIntentId !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(closeIntentId) ||
        typeof clientOrderId !== "string" || clientOrderId.trim() === "" ||
        closeIntentId === linkedId(clientOrderId)) {
      throw new Error("bingx_vst_pre_runner_split_close_request_invalid");
    }
    return {
      symbol: request.symbol,
      positionId: positionIdValue,
      totalQuantity: decimalText(total),
      originalStop,
      coreStop,
      stops,
      closeIntentId,
      exchangeClientOrderId: linkedId(clientOrderId),
    };
  }

  function flatSplitStopCleanupDetails(request) {
    const positionIdValue = strictExchangeId(
      { positionId: request?.positionId }, ["positionId"], "flat_split_position_id",
    );
    const stopToCancel = request?.stopToCancel;
    const ids = request?.knownRemainingStopOrderIds;
    const cancellationIntentId = request?.cancellationIntentId;
    const priorEntryOrderId = request?.priorPosition?.entryOrderId;
    const splitEntryOrderId = request?.priorPosition?.split?.entryOrderId;
    const entryOrderId = priorEntryOrderId ?? splitEntryOrderId;
    if (!object(stopToCancel) ||
        !Array.isArray(ids) || ids.length < 1 || ids.length > 2 ||
        ids.some((id) => typeof id !== "string" || id.trim() === "") ||
        new Set(ids).size !== ids.length ||
        typeof cancellationIntentId !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(cancellationIntentId) ||
        priorEntryOrderId !== undefined && splitEntryOrderId !== undefined &&
          priorEntryOrderId !== splitEntryOrderId) {
      throw new Error("bingx_vst_flat_split_cleanup_request_invalid");
    }
    const validatedEntryOrderId = entryOrderId === undefined ? undefined
      : strictExchangeId({ entryOrderId }, ["entryOrderId"],
        "flat_split_entry_order_id");
    const stop = {
      ...(stopToCancel.tranche ? { tranche: stopToCancel.tranche } : {}),
      orderId: strictExchangeId(stopToCancel, ["orderId", "orderID"],
        "flat_split_target_stop_id"),
      quantity: decimalText(exactDecimal(stopToCancel.quantity,
        "flat_split_target_stop_quantity")),
      stopPrice: decimalText(exactDecimal(stopToCancel.stopPrice,
        "flat_split_target_stop_price")),
    };
    if (stopToCancel.tranche !== undefined &&
        !["core", "runner"].includes(stopToCancel.tranche) ||
        !ids.includes(stop.orderId)) {
      throw new Error("bingx_vst_flat_split_target_stop_not_in_known_set");
    }
    return {
      symbol: request.symbol,
      positionId: positionIdValue,
      stopToCancel: stop,
      knownRemainingStopOrderIds: [...ids],
      cancellationIntentId,
      ...(validatedEntryOrderId ? { entryOrderId: validatedEntryOrderId } : {}),
    };
  }

  function exactFlatStopOrder(row, {
    symbol, positionId: expectedPositionId, stop, entryOrderId, status = "NEW",
  }) {
    try {
      const parents = [row?.mainOrderId, row?.parentOrderId]
        .filter((value) => value !== undefined && value !== null && value !== "")
        .map((value) => exactIdentifier(value, "flat_split_stop_parent_id"));
      return row?.symbol === symbolName(symbol) &&
        strictExchangeId(row, ["orderId", "orderID"], "flat_split_order_id") ===
          stop.orderId &&
        row.type === "STOP_MARKET" && row.status === status &&
        row.side === "SELL" && row.positionSide === "LONG" &&
        row.workingType === "MARK_PRICE" &&
        positionId(row) === expectedPositionId &&
        row.closePosition !== true && row.closePosition !== "true" &&
        finitePositive(row.origQty, "flat_split_stop_quantity") > 0 &&
        finitePositive(row.stopPrice, "flat_split_stop_price") > 0 &&
        new Set(parents).size <= 1 &&
        (entryOrderId === undefined ||
          parents.length > 0 && parents.every((parent) => parent === entryOrderId)) &&
        (!stop.quantity || sameDecimal(exactDecimal(row.origQty,
          "flat_split_exact_stop_quantity"),
        exactDecimal(stop.quantity, "flat_split_expected_stop_quantity"))) &&
        (!stop.stopPrice || sameDecimal(exactDecimal(row.stopPrice,
          "flat_split_exact_stop_price"),
        exactDecimal(stop.stopPrice, "flat_split_expected_stop_price")));
    } catch {
      return false;
    }
  }

  function canceledFlatStopOrder(row, {
    symbol, positionId: expectedPositionId, stop, entryOrderId,
  }) {
    return ["CANCELED", "CANCELLED"].some((status) =>
      exactFlatStopOrder(row, {
        symbol, positionId: expectedPositionId, stop, entryOrderId, status,
      })) &&
      row.executedQty !== undefined && row.executedQty !== null &&
      sameDecimal(exactDecimal(row.executedQty, "flat_split_stop_executed",
        { allowZero: true }), exactDecimal("0", "flat_split_zero", { allowZero: true }));
  }

  function flatPositionRows(positions, symbol) {
    if (!Array.isArray(positions)) return false;
    return positions.every((row) => {
      if (!object(row) || typeof row.symbol !== "string") return false;
      if (row.symbol !== symbolName(symbol)) return true;
      return ["BOTH", "LONG", "SHORT"].includes(row.positionSide) &&
        strictNumber(row.positionAmt, "flat_split_position_quantity", {
          allowZero: true,
        }) === 0;
    });
  }

  async function closeSplitAllEvidence({ request, clientOrderId }) {
    const unknown = { verified: false, status: "unknown" };
    try {
      const details = fullSplitCloseDetails(request, clientOrderId);
      const name = assertSymbol(details.symbol);
      const now = Number(clock());
      const range = intentRange(request, now);
      if (!Number.isSafeInteger(now) || now <= 0 || !range) return unknown;
      await assertVstEnvironment(details.symbol);
      const history = await api.queryOrderHistory(details.symbol, range);
      const historyRows = Array.isArray(history) ? history : history?.orders;
      if (!boundedRows(historyRows)) return unknown;
      const closeMatch = await findIntentOrder(
        details.symbol, details.exchangeClientOrderId, range,
      );
      if (!closeMatch) return unknown;
      const closeHistory = closeMatch.order;
      const closeOrderId = strictExchangeId(closeHistory,
        ["orderId", "orderID"], "full_split_close_history_id");
      const closeMatches = (row) => row &&
        strictExchangeId(row, ["orderId", "orderID"], "full_split_close_order_id") ===
          closeOrderId &&
        row.symbol === name && row.type === "MARKET" && row.status === "FILLED" &&
        row.side === "SELL" && row.positionSide === "LONG" &&
        orderClientId(row) === details.exchangeClientOrderId &&
        row.reduceOnly !== false && row.reduceOnly !== "false" &&
        sameDecimal(exactDecimal(row.origQty, "full_split_close_order_quantity"),
          exactDecimal(details.totalQuantity, "full_split_expected_quantity")) &&
        sameDecimal(exactDecimal(row.executedQty, "full_split_close_executed_quantity"),
          exactDecimal(details.totalQuantity, "full_split_expected_execution"));
      const queriedClose = await api.queryOrder(details.symbol, {
        clientOrderId: details.exchangeClientOrderId,
      });
      if (!closeMatches(closeHistory) || !closeMatches(queriedClose)) return unknown;
      const fills = await api.queryFills(details.symbol, {
        startTs: range.startTs, endTs: range.endTs,
        orderId: closeOrderId, currency: "VST",
      });
      if (!boundedRows(fills)) return unknown;
      const fill = exactCommissionedFillSummary(fills, {
        symbol: details.symbol,
        exchangeOrderId: closeOrderId,
        side: "SELL",
        expectedQuantity: details.totalQuantity,
      });
      if (!fill) return unknown;

      const stopIds = details.stops.map((stop) => stop.orderId);
      const [positions, orders, queriedStops, stopFills] = await Promise.all([
        api.getPositions(details.symbol),
        api.getOpenOrders(details.symbol),
        Promise.all(details.stops.map((stop) =>
          api.queryOrder(details.symbol, { orderId: stop.orderId }))),
        Promise.all(details.stops.map((stop) =>
          api.queryFills(details.symbol, {
            startTs: range.startTs, endTs: range.endTs,
            orderId: stop.orderId, currency: "VST",
          }))),
      ]);
      if (!flatPositionRows(positions, details.symbol) ||
          !Array.isArray(orders) ||
          !stopFills.every((rows) => boundedRows(rows) && rows.length === 0)) {
        return unknown;
      }
      const openIds = orders.map((row) =>
        strictExchangeId(row, ["orderId", "orderID"], "full_split_open_stop_id"));
      if (new Set(openIds).size !== openIds.length ||
          openIds.some((id) => !stopIds.includes(id))) return unknown;
      const remainingKnownStopOrderIds = [];
      for (let index = 0; index < details.stops.length; index += 1) {
        const stop = details.stops[index];
        const activeRows = orders.filter((row) =>
          strictExchangeId(row, ["orderId", "orderID"], "full_split_open_stop_id") ===
            stop.orderId);
        const queried = queriedStops[index];
        if (activeRows.length === 1) {
          if (!exactFlatStopOrder(activeRows[0], {
            symbol: details.symbol, positionId: details.positionId, stop,
          }) || !exactFlatStopOrder(queried, {
            symbol: details.symbol, positionId: details.positionId, stop,
          })) return unknown;
          remainingKnownStopOrderIds.push(stop.orderId);
        } else if (activeRows.length === 0) {
          if (!canceledFlatStopOrder(queried, {
            symbol: details.symbol, positionId: details.positionId, stop,
          })) return unknown;
        } else {
          return unknown;
        }
      }
      const position = await readPosition(details.symbol);
      if (position.quantity !== 0) return unknown;
      return {
        verified: true,
        status: "filled",
        position,
        positionId: details.positionId,
        exchangeOrderId: closeOrderId,
        clientOrderId: details.exchangeClientOrderId,
        closeIntentId: details.closeIntentId,
        closedQuantity: details.totalQuantity,
        fill,
        flat: true,
        remainingKnownStopOrderIds,
        fullyCleaned: remainingKnownStopOrderIds.length === 0,
      };
    } catch {
      return unknown;
    }
  }

  async function closePreRunnerSplitEvidence({ request, clientOrderId }) {
    const unknown = { verified: false, status: "unknown" };
    try {
      const details = preRunnerSplitCloseDetails(request, clientOrderId);
      const name = assertSymbol(details.symbol);
      const now = Number(clock());
      const range = intentRange(request, now);
      if (!Number.isSafeInteger(now) || now <= 0 || !range) return unknown;
      await assertVstEnvironment(details.symbol);
      const history = await api.queryOrderHistory(details.symbol, range);
      const historyRows = Array.isArray(history) ? history : history?.orders;
      if (!boundedRows(historyRows)) return unknown;
      const closeMatch = await findIntentOrder(
        details.symbol, details.exchangeClientOrderId, range,
      );
      if (!closeMatch) return unknown;
      const closeHistory = closeMatch.order;
      const closeOrderId = strictExchangeId(closeHistory,
        ["orderId", "orderID"], "pre_runner_close_history_id");
      const closeMatches = (row) => row &&
        strictExchangeId(row, ["orderId", "orderID"], "pre_runner_close_order_id") ===
          closeOrderId &&
        row.symbol === name && row.type === "MARKET" && row.status === "FILLED" &&
        row.side === "SELL" && row.positionSide === "LONG" &&
        orderClientId(row) === details.exchangeClientOrderId &&
        row.reduceOnly !== false && row.reduceOnly !== "false" &&
        sameDecimal(exactDecimal(row.origQty, "pre_runner_close_order_quantity"),
          exactDecimal(details.totalQuantity, "pre_runner_expected_quantity")) &&
        sameDecimal(exactDecimal(row.executedQty,
          "pre_runner_close_executed_quantity"),
        exactDecimal(details.totalQuantity, "pre_runner_expected_execution"));
      const queriedClose = await api.queryOrder(details.symbol, {
        clientOrderId: details.exchangeClientOrderId,
      });
      if (!closeMatches(closeHistory) || !closeMatches(queriedClose)) return unknown;
      const fills = await api.queryFills(details.symbol, {
        startTs: range.startTs,
        endTs: range.endTs,
        orderId: closeOrderId,
        currency: "VST",
      });
      if (!boundedRows(fills)) return unknown;
      const fill = exactCommissionedFillSummary(fills, {
        symbol: details.symbol,
        exchangeOrderId: closeOrderId,
        side: "SELL",
        expectedQuantity: details.totalQuantity,
      });
      if (!fill) return unknown;

      const stopIds = details.stops.map((stop) => stop.orderId);
      const [positions, orders, queriedStops, stopFills] = await Promise.all([
        api.getPositions(details.symbol),
        api.getOpenOrders(details.symbol),
        Promise.all(details.stops.map((stop) =>
          api.queryOrder(details.symbol, { orderId: stop.orderId }))),
        Promise.all(details.stops.map((stop) =>
          api.queryFills(details.symbol, {
            startTs: range.startTs,
            endTs: range.endTs,
            orderId: stop.orderId,
            currency: "VST",
          }))),
      ]);
      if (!flatPositionRows(positions, details.symbol) ||
          !Array.isArray(orders) ||
          !stopFills.every((rows) => boundedRows(rows) && rows.length === 0)) {
        return unknown;
      }
      const openIds = orders.map((row) =>
        strictExchangeId(row, ["orderId", "orderID"], "pre_runner_open_stop_id"));
      if (new Set(openIds).size !== openIds.length ||
          openIds.some((id) => !stopIds.includes(id))) return unknown;
      const remainingKnownStopOrderIds = [];
      for (let index = 0; index < details.stops.length; index += 1) {
        const stop = details.stops[index];
        const activeRows = orders.filter((row) =>
          strictExchangeId(row, ["orderId", "orderID"], "pre_runner_open_stop_id") ===
          stop.orderId);
        const queried = queriedStops[index];
        if (activeRows.length === 1) {
          if (!exactFlatStopOrder(activeRows[0], {
            symbol: details.symbol,
            positionId: details.positionId,
            stop,
          }) || !exactFlatStopOrder(queried, {
            symbol: details.symbol,
            positionId: details.positionId,
            stop,
          })) return unknown;
          remainingKnownStopOrderIds.push(stop.orderId);
        } else if (activeRows.length === 0) {
          if (!canceledFlatStopOrder(queried, {
            symbol: details.symbol,
            positionId: details.positionId,
            stop,
          })) return unknown;
        } else {
          return unknown;
        }
      }
      const position = await readPosition(details.symbol);
      if (position.quantity !== 0) return unknown;
      return {
        verified: true,
        status: "filled",
        position,
        positionId: details.positionId,
        exchangeOrderId: closeOrderId,
        clientOrderId: details.exchangeClientOrderId,
        closeIntentId: details.closeIntentId,
        closedQuantity: details.totalQuantity,
        fill,
        flat: true,
        remainingKnownStopOrderIds,
        fullyCleaned: remainingKnownStopOrderIds.length === 0,
      };
    } catch {
      return unknown;
    }
  }

  async function cancelFlatSplitStopEvidence({ request }) {
    const unknown = { verified: false, status: "unknown" };
    try {
      const details = flatSplitStopCleanupDetails(request);
      const sourceExitCleanup = sourceExitCleanupDetails(request);
      const name = assertSymbol(details.symbol);
      const now = Number(clock());
      const range = intentRange(request, now);
      if (!Number.isSafeInteger(now) || now <= 0 || !range) return unknown;
      if (!sourceExitCleanup) await assertVstEnvironment(details.symbol);
      const [positions, orders, queriedStops, fillsByStop] = await Promise.all([
        api.getPositions(details.symbol),
        api.getOpenOrders(details.symbol),
        Promise.all(details.knownRemainingStopOrderIds.map((id) =>
          api.queryOrder(details.symbol, { orderId: id }))),
        Promise.all(details.knownRemainingStopOrderIds.map((id) =>
          api.queryFills(details.symbol, {
            startTs: range.startTs, endTs: range.endTs,
            orderId: id, currency: "VST",
          }))),
      ]);
      if (!flatPositionRows(positions, details.symbol) ||
          !Array.isArray(orders) ||
          !fillsByStop.every((rows) => boundedRows(rows) && rows.length === 0)) {
        return unknown;
      }
      const openIds = orders.map((row) =>
        strictExchangeId(row, ["orderId", "orderID"], "flat_split_open_stop_id"));
      if (new Set(openIds).size !== openIds.length ||
          openIds.some((id) =>
            !details.knownRemainingStopOrderIds.includes(id) ||
            id === details.stopToCancel.orderId)) return unknown;
      const remainingKnownStopOrderIds = [];
      for (let index = 0; index < details.knownRemainingStopOrderIds.length; index += 1) {
        const id = details.knownRemainingStopOrderIds[index];
        const queried = queriedStops[index];
        const activeRows = orders.filter((row) =>
          strictExchangeId(row, ["orderId", "orderID"], "flat_split_open_stop_id") === id);
        if (id === details.stopToCancel.orderId) {
          if (activeRows.length !== 0 ||
              !canceledFlatStopOrder(queried, {
                symbol: details.symbol, positionId: details.positionId,
                stop: details.stopToCancel,
                entryOrderId: details.entryOrderId,
              })) return unknown;
        } else if (activeRows.length === 1) {
          if (!exactFlatStopOrder(activeRows[0], {
            symbol: details.symbol, positionId: details.positionId,
            stop: { orderId: id },
            entryOrderId: details.entryOrderId,
          }) || !exactFlatStopOrder(queried, {
            symbol: details.symbol, positionId: details.positionId,
            stop: { orderId: id },
            entryOrderId: details.entryOrderId,
          })) return unknown;
          remainingKnownStopOrderIds.push(id);
        } else if (activeRows.length === 0) {
          if (!canceledFlatStopOrder(queried, {
            symbol: details.symbol, positionId: details.positionId,
            stop: { orderId: id },
            entryOrderId: details.entryOrderId,
          })) return unknown;
        } else {
          return unknown;
        }
      }
      return {
        verified: true,
        status: "canceled",
        positionId: details.positionId,
        flat: true,
        canceledStopOrderId: details.stopToCancel.orderId,
        cancellationIntentId: details.cancellationIntentId,
        knownRemainingStopOrderIds: details.knownRemainingStopOrderIds,
        remainingKnownStopOrderIds,
      };
    } catch {
      return unknown;
    }
  }

  function triggeredRunnerCancellationDetails(request, clientOrderId) {
    const ids = [
      "positionId", "runnerStopOrderId", "runnerChildOrderId",
      "originalStopOrderId", "coreStopOrderId", "intentId",
    ];
    const values = Object.fromEntries(ids.map((key) => [
      key, exactIdentifier(request?.[key], key),
    ]));
    if (typeof clientOrderId !== "string" || values.intentId !== clientOrderId ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(values.intentId) ||
        new Set([
          values.runnerStopOrderId, values.runnerChildOrderId,
          values.originalStopOrderId, values.coreStopOrderId,
        ]).size !== 4 ||
        request?.cancellationIntentId !== undefined &&
          request.cancellationIntentId !== values.intentId) {
      throw new Error("bingx_vst_triggered_runner_cancel_intent_identity_invalid");
    }
    const total = exactDecimal(request?.totalQuantity, "runner_cancel_total_quantity");
    const remaining = exactDecimal(request?.remainingQuantity, "runner_cancel_remaining_quantity");
    const signalStopPrice = exactDecimal(request?.signalStopPrice, "runner_cancel_signal_stop");
    const breakEvenPrice = exactDecimal(request?.breakEvenPrice, "runner_cancel_break_even");
    const runner = subtractDecimal(total, remaining);
    const rawRunnerFillAt = request?.priorPosition?.split?.runnerCleanup?.fill?.at;
    const parsedRunnerFillAt = asMillis(rawRunnerFillAt) ??
      (typeof rawRunnerFillAt === "string" ? Date.parse(rawRunnerFillAt) : null);
    const scale = Math.max(total.scale, runner.scale);
    if (runner.amount <= 0n || remaining.amount <= 0n ||
        decimalAtScale(runner, scale) * 100n !== decimalAtScale(total, scale) * 20n ||
        decimalAtScale(remaining, scale) * 100n !== decimalAtScale(total, scale) * 80n ||
        !Number.isSafeInteger(parsedRunnerFillAt) || parsedRunnerFillAt <= 0 ||
        request?.operation !== "cancel_original_after_runner_fill") {
      throw new Error("bingx_vst_triggered_runner_cancel_quantities_invalid");
    }
    return {
      ...values,
      symbol: request.symbol,
      totalQuantity: decimalText(total),
      remainingQuantity: decimalText(remaining),
      runnerQuantity: decimalText(runner),
      signalStopPrice: decimalText(signalStopPrice),
      breakEvenPrice: decimalText(breakEvenPrice),
      runnerFillAt: parsedRunnerFillAt,
      intentIdentity: `${request.symbol}:${values.positionId}:${values.runnerStopOrderId}:${values.runnerChildOrderId}:${values.originalStopOrderId}`,
    };
  }

  async function triggeredRunnerCancellationEvidence(request, details) {
    const unknown = { verified: false, status: "unknown" };
    try {
      const name = assertSymbol(request.symbol);
      await assertVstEnvironment(request.symbol);
      const range = intentRange(request, Number(clock()));
      if (!range) return unknown;
      const now = Number(clock());
      const runnerFillRange = {
        startTs: details.runnerFillAt - 1,
        endTs: Math.floor(now),
      };
      if (!Number.isSafeInteger(now) || now <= 0 ||
          !Number.isSafeInteger(runnerFillRange.startTs) ||
          runnerFillRange.startTs <= 0 ||
          runnerFillRange.startTs > runnerFillRange.endTs + 2_000 ||
          runnerFillRange.endTs - runnerFillRange.startTs > MAX_HISTORY_WINDOW_MS) {
        return unknown;
      }
      const [positions, orders, originalOrder, originalHistory, originalFills,
        runnerStop, runnerChild, allFills] = await Promise.all([
        api.getPositions(request.symbol),
        api.getOpenOrders(request.symbol),
        api.queryOrder(request.symbol, { orderId: details.originalStopOrderId }),
        api.queryOrderHistory(request.symbol, range),
        api.queryFills(request.symbol, {
          ...runnerFillRange,
          orderId: details.originalStopOrderId, currency: "VST",
        }),
        api.queryOrder(request.symbol, { orderId: details.runnerStopOrderId }),
        api.queryOrder(request.symbol, { orderId: details.runnerChildOrderId }),
        api.queryFills(request.symbol, {
          ...runnerFillRange,
          currency: "VST",
        }),
      ]);
      if (!Array.isArray(positions) || !Array.isArray(orders) || orders.length !== 1 ||
          !boundedRows(originalFills) || originalFills.length !== 0 ||
          !boundedRows(allFills)) return unknown;

      const strictId = (row, fields) => {
        const values = fields.filter((field) =>
          row?.[field] !== undefined && row[field] !== null).map((field) => row[field]);
        return values.length > 0 &&
          values.every((value) => typeof value === "string" && value.trim() !== "") &&
          new Set(values).size === 1 ? values[0] : null;
      };
      const historyRows = Array.isArray(originalHistory)
        ? originalHistory : originalHistory?.orders;
      if (!boundedRows(historyRows)) return unknown;
      const originalHistoryMatches = Array.isArray(historyRows)
        ? historyRows.filter((row) =>
          strictId(row, ["orderId", "orderID"]) === details.originalStopOrderId)
        : [];
      const exactTerminalOriginal = (row) =>
        row && strictId(row, ["orderId", "orderID"]) === details.originalStopOrderId &&
        row.symbol === name && row.type === "STOP_MARKET" &&
        ["CANCELED", "CANCELLED"].includes(String(row.status ?? "").toUpperCase()) &&
        row.executedQty !== undefined && row.executedQty !== null &&
        sameDecimal(exactDecimal(row.executedQty, "canceled_original_executed",
          { allowZero: true }), exactDecimal("0", "zero", { allowZero: true }));
      if (!exactTerminalOriginal(originalOrder) ||
          originalHistoryMatches.length > 1 ||
          originalHistoryMatches.length === 1 &&
            !exactTerminalOriginal(originalHistoryMatches[0])) return unknown;
      for (const row of [originalOrder,
        ...(originalHistoryMatches.length === 1 ? [originalHistoryMatches[0]] : [])]) {
        const originalPositionId = strictId(row, ["positionId", "positionID"]);
        if (row.side !== "SELL" || row.positionSide !== "LONG" ||
            originalPositionId !== details.positionId ||
            !sameDecimal(exactDecimal(row.origQty, "canceled_original_quantity"),
              exactDecimal(details.remainingQuantity, "canceled_original_residual")) ||
            !sameDecimal(exactDecimal(row.stopPrice, "canceled_original_stop_price"),
              exactDecimal(details.signalStopPrice, "canceled_original_signal_stop")) ||
            row.executedQty !== undefined && !sameDecimal(
              exactDecimal(row.executedQty, "canceled_original_executed", { allowZero: true }),
              exactDecimal("0", "zero", { allowZero: true }),
            )) return unknown;
      }

      const activePositions = positions.filter((row) =>
        row?.symbol === name &&
        strictNumber(row.positionAmt, "runner_cancel_position_quantity", {
          allowZero: true,
        }) !== 0);
      if (activePositions.length !== 1 ||
          activePositions[0].positionSide !== "LONG" ||
          exactIdentifier(activePositions[0].positionId ?? activePositions[0].positionID,
            "position_id") !== details.positionId ||
          !sameDecimal(exactDecimal(activePositions[0].positionAmt,
            "runner_cancel_residual_position"),
          exactDecimal(details.remainingQuantity, "runner_cancel_expected_residual"))) {
        return unknown;
      }
      const core = orders[0];
      if (strictId(core, ["orderId", "orderID"]) !== details.coreStopOrderId ||
          core.symbol !== name || core.type !== "STOP_MARKET" || core.status !== "NEW" ||
          core.side !== "SELL" || core.positionSide !== "LONG" ||
          strictId(core, ["positionId", "positionID"]) !== details.positionId ||
          core.workingType !== "MARK_PRICE" ||
          !sameDecimal(exactDecimal(core.origQty, "runner_cancel_core_quantity"),
            exactDecimal(details.remainingQuantity, "runner_cancel_expected_core")) ||
          !sameDecimal(exactDecimal(core.stopPrice, "runner_cancel_core_stop"),
            exactDecimal(details.signalStopPrice, "runner_cancel_expected_signal_stop"))) {
        return unknown;
      }

      const runnerQuantity = exactDecimal(details.runnerQuantity, "runner_cancel_fill_quantity");
      const orderPositionMatches = (row, allowZero = false, allowMissing = false) => {
        const values = ["positionId", "positionID"].filter((field) =>
          row?.[field] !== undefined && row[field] !== null).map((field) => row[field]);
        if (!values.length) return allowMissing;
        return values.every((value) => typeof value === "string" && value === details.positionId) ||
          allowZero && values.every((value) => value === "0" || value === 0);
      };
      const exactRunnerOrder = (row, ids, allowZeroPositionId = false) =>
        row && ids.includes(strictId(row, ["orderId", "orderID"])) &&
        row.symbol === name && row.type === "STOP_MARKET" &&
        String(row.status ?? "").toUpperCase() === "FILLED" &&
        String(row.side ?? "").toUpperCase() === "SELL" &&
        (row.positionSide === undefined || row.positionSide === null ||
          row.positionSide === "LONG") &&
        orderPositionMatches(row, allowZeroPositionId) &&
        ["origQty", "qty", "quantity"].some((field) =>
          row[field] !== undefined && row[field] !== null) &&
        ["origQty", "qty", "quantity"].filter((field) =>
          row[field] !== undefined && row[field] !== null).every((field) =>
          sameDecimal(exactDecimal(row[field], "runner_cancel_order_quantity"),
            runnerQuantity)) &&
        ["executedQty", "executedQuantity"].some((field) =>
          row[field] !== undefined && row[field] !== null) &&
        ["executedQty", "executedQuantity"].filter((field) =>
          row[field] !== undefined && row[field] !== null).every((field) =>
          sameDecimal(exactDecimal(row[field],
            "runner_cancel_order_executed_quantity"), runnerQuantity));
      if (!exactRunnerOrder(runnerStop,
        [details.runnerStopOrderId, details.runnerChildOrderId], true) ||
          !sameDecimal(exactDecimal(runnerStop.stopPrice, "runner_cancel_runner_stop"),
            exactDecimal(details.breakEvenPrice, "runner_cancel_expected_be")) ||
          !exactRunnerOrder(runnerChild, [details.runnerChildOrderId])) return unknown;

      const triggerFields = ["triggerOrderId", "triggerOrderID"];
      const childFields = ["orderId", "orderID"];
      for (const fill of allFills) {
        const hasTrigger = triggerFields.some((field) =>
          fill?.[field] !== undefined && fill[field] !== null);
        if (hasTrigger && strictId(fill, triggerFields) === null) return unknown;
      }
      const linked = allFills.filter((fill) =>
        strictId(fill, triggerFields) === details.runnerStopOrderId);
      if (linked.length !== 1 ||
          strictId(linked[0], childFields) !== details.runnerChildOrderId ||
          linked[0].symbol !== name || String(linked[0].side ?? "").toUpperCase() !== "SELL" ||
          !orderPositionMatches(linked[0], true, true) ||
          linked[0].positionSide !== undefined &&
            linked[0].positionSide !== null && linked[0].positionSide !== "LONG") {
        return unknown;
      }
      const fillQtyValues = [linked[0].qty, linked[0].quantity, linked[0].volume]
        .filter((value) => value !== undefined && value !== null);
      if (fillQtyValues.length === 0 ||
          fillQtyValues.some((value) => !sameDecimal(
            exactDecimal(value, "runner_cancel_fill_quantity"), runnerQuantity,
          )) ||
          allFills.filter((fill) =>
            strictId(fill, childFields) === details.runnerChildOrderId).length !== 1) {
        return unknown;
      }
      return {
        verified: true,
        status: "filled",
        position: await readPosition(request.symbol, {
          persistedPosition: {
            verified: true,
            environment: "vst",
            accountId,
            symbol: request.symbol,
            positionId: details.positionId,
            quantity: details.remainingQuantity,
            protectiveStops: {
              core: {
                verified: true,
                tranche: "core",
                orderId: details.coreStopOrderId,
                positionId: details.positionId,
                quantity: details.remainingQuantity,
                stopPrice: details.signalStopPrice,
              },
            },
          },
        }),
        protectiveStops: {
          core: {
            verified: true,
            orderId: details.coreStopOrderId,
            positionId: details.positionId,
            quantity: details.remainingQuantity,
            stopPrice: details.signalStopPrice,
          },
        },
        canceledOriginalStopOrderId: details.originalStopOrderId,
        runnerStopOrderId: details.runnerStopOrderId,
        runnerChildOrderId: details.runnerChildOrderId,
        cancellationIntentId: details.intentId,
      };
    } catch (error) {
      return { ...unknown, reason: error instanceof Error ? error.message : "invalid_evidence" };
    }
  }

  async function performCancelOriginalAfterRunnerFill({ clientOrderId, request }) {
    if (typeof api.cancelVstAutomatedOriginalAfterTriggeredRunner !== "function") {
      throw new Error("bingx_vst_triggered_runner_cancel_adapter_method_unavailable");
    }
    const details = triggeredRunnerCancellationDetails(request, clientOrderId);
    const durableIntentKey = `${accountId}:${details.intentId}`;
    const cancellationIdentityKey = `${accountId}:${details.intentIdentity}`;
    if (submittedTriggeredRunnerCancellationIntents.has(durableIntentKey) ||
        submittedTriggeredRunnerCancellationIdentities.has(cancellationIdentityKey)) {
      throw new Error("bingx_vst_triggered_runner_cancel_already_submitted_never_retry");
    }
    // Reserve both the caller's durable ID and the semantic stop identity
    // before entering the adapter mutation boundary. Any throw remains
    // ambiguous and must be reconciled, never retried.
    submittedTriggeredRunnerCancellationIntents.add(durableIntentKey);
    submittedTriggeredRunnerCancellationIdentities.add(cancellationIdentityKey);
    apiIntentIds.set(linkedId(clientOrderId), {
      phase: "cancel_original_after_runner_fill",
      status: "submitted",
    });
    const result = await performMutation("cancelVstAutomatedOriginalAfterTriggeredRunner", {
      symbol: request.symbol,
      policy: VST_AUTOMATED_LONG_POLICY,
      positionId: details.positionId,
      runnerStopOrderId: details.runnerStopOrderId,
      runnerChildOrderId: details.runnerChildOrderId,
      runnerFillAt: details.runnerFillAt,
      originalStopOrderId: details.originalStopOrderId,
      coreStopOrderId: details.coreStopOrderId,
      totalQuantity: details.totalQuantity,
      remainingQuantity: details.remainingQuantity,
      signalStopPrice: details.signalStopPrice,
      breakEvenPrice: details.breakEvenPrice,
      cancellationIntentId: details.intentId,
    });
    if (result?.verified !== true ||
        result.symbol !== symbolName(request.symbol) ||
        !["CANCELED", "CANCELLED"].includes(String(result.status ?? "").toUpperCase()) ||
        result.positionId !== details.positionId ||
        result.canceledOriginalStopOrderId !== details.originalStopOrderId ||
        result.coreStopOrderId !== details.coreStopOrderId ||
        result.runnerChildOrderId !== details.runnerChildOrderId ||
        result.cancellationIntentId !== details.intentId ||
        !sameDecimal(exactDecimal(result.remainingQuantity,
          "runner_cancel_adapter_remaining_quantity"),
        exactDecimal(details.remainingQuantity, "runner_cancel_expected_remaining"))) {
      throw new Error("bingx_vst_triggered_runner_cancel_adapter_proof_missing");
    }
  }

  async function observeTriggeredStop({
    symbol, positionId: expectedPositionId, stopOrderId, stopQuantity,
    stopPrice, previousQuantity, startedAt, requireStopDetails = false,
    expectedParentEntryOrderId = null, expectedOpenStops = null,
  }) {
    const unknown = { verified: false, status: "unknown" };
    const refuse = (condition, inspect, error) => recordProofResult(unknown, {
      source: "triggered_stop_proof", condition, symbol, check: "protective_stop",
    }, inspect, error);
    try {
      const name = assertSymbol(symbol);
      if (typeof expectedPositionId !== "string" || expectedPositionId.trim() === "" ||
          typeof stopOrderId !== "string" || stopOrderId.trim() === "" ||
          typeof startedAt !== "number" || !Number.isSafeInteger(startedAt) ||
          startedAt <= 0 || typeof api.queryOrder !== "function") {
        return refuse("request_identity", () => ({
          positionIdPresent: evidencePair(true, typeof expectedPositionId === "string" && expectedPositionId.trim() !== ""),
          stopOrderIdPresent: evidencePair(true, typeof stopOrderId === "string" && stopOrderId.trim() !== ""),
          startTimeValid: evidencePair(true, typeof startedAt === "number" && Number.isSafeInteger(startedAt) && startedAt > 0),
          startTime: evidencePair(undefined, startedAt, true),
          queryCapability: evidencePair(true, typeof api.queryOrder === "function"),
        }));
      }
      const expectedStopQuantity = exactDecimal(stopQuantity, "triggered_stop_quantity");
      const priorQuantity = exactDecimal(previousQuantity, "triggered_previous_quantity");
      const expectedStopPrice = exactDecimal(stopPrice, "triggered_stop_price");
      if (compareDecimal(expectedStopQuantity, priorQuantity) > 0) return refuse("quantity_bounds", () => ({
        stopQuantity: evidencePair(previousQuantity, stopQuantity, false),
        previousQuantity: evidencePair(undefined, previousQuantity, true),
      }));
      const residualDecimal = subtractDecimal(priorQuantity, expectedStopQuantity);
      if (residualDecimal.amount < 0n) return refuse("quantity_bounds", () => ({
        remainingQuantity: evidencePair("0", decimalText(residualDecimal), false),
      }));
      const residualQuantity = decimalText(residualDecimal);
      const now = Number(clock());
      if (!Number.isSafeInteger(now) || now < startedAt) return refuse("clock", () => ({
        clockValid: evidencePair(true, Number.isSafeInteger(now) && now >= startedAt),
        clockTime: evidencePair(undefined, now, true),
        startTime: evidencePair(undefined, startedAt, true),
      }));

      await assertVstEnvironment(symbol);
      const [queriedOrder, fills, positions, orders] = await Promise.all([
        api.queryOrder(symbol, { orderId: stopOrderId }),
        api.queryFills(symbol, {
          startTs: Math.max(1, Math.floor(now - MAX_HISTORY_WINDOW_MS),
            startedAt - 60_000),
          endTs: now,
          currency: "VST",
        }),
        api.getPositions(symbol),
        api.getOpenOrders(symbol),
      ]);
      if (!object(queriedOrder) || queriedOrder.symbol !== name ||
          String(queriedOrder.status ?? "").toUpperCase() !== "FILLED" ||
          queriedOrder.type !== "STOP_MARKET" ||
          String(queriedOrder.side ?? "").toUpperCase() !== "SELL" ||
          queriedOrder.positionSide !== undefined &&
            queriedOrder.positionSide !== null && queriedOrder.positionSide !== "LONG" ||
          !boundedRows(fills) || !Array.isArray(positions) || !Array.isArray(orders)) {
        return refuse("queried_stop_fields", () => ({
          orderFound: evidencePair(true, object(queriedOrder)),
          symbol: evidencePair(name, queriedOrder?.symbol),
          orderStatus: evidencePair("FILLED", String(queriedOrder?.status ?? "").toUpperCase()),
          orderType: evidencePair("STOP_MARKET", queriedOrder?.type),
          side: evidencePair("SELL", String(queriedOrder?.side ?? "").toUpperCase()),
          positionSide: evidencePair("LONG", queriedOrder?.positionSide,
            queriedOrder?.positionSide == null || queriedOrder.positionSide === "LONG"),
          fillsBounded: evidencePair(true, boundedRows(fills)),
          fillCount: evidencePair(undefined, Array.isArray(fills) ? fills.length : undefined, true),
          positionsArray: evidencePair(true, Array.isArray(positions)),
          ordersArray: evidencePair(true, Array.isArray(orders)),
        }));
      }

      const exactStringFields = (row, fields) => {
        const values = fields.filter((field) => row?.[field] !== undefined &&
          row[field] !== null).map((field) => row[field]);
        if (values.length === 0 || values.some((value) =>
          typeof value !== "string" || value.trim() === "") ||
          new Set(values).size !== 1) return null;
        return values[0];
      };
      const queriedChildId = exactStringFields(queriedOrder, ["orderId", "orderID"]);
      if (!queriedChildId || queriedChildId === stopOrderId && !requireStopDetails) {
        return refuse("child_identity", () => ({
          childIdentityValid: evidencePair(true, !!queriedChildId),
          childDiffersFromStop: evidencePair(true, queriedChildId !== stopOrderId || requireStopDetails),
          childOrderId: evidencePair(undefined, queriedChildId, !!queriedChildId),
          stopOrderId: evidencePair(undefined, stopOrderId, true),
        }));
      }
      if (requireStopDetails) {
        const queriedPositionValues = ["positionId", "positionID"]
          .filter((field) => queriedOrder[field] !== undefined &&
            queriedOrder[field] !== null && queriedOrder[field] !== 0 &&
            queriedOrder[field] !== "0")
          .map((field) => exactIdentifier(queriedOrder[field],
            "triggered_stop_position_identity"));
        const parentIds = [queriedOrder.mainOrderId, queriedOrder.parentOrderId]
          .filter((value) => value !== undefined && value !== null && value !== "")
          .map((value) => exactIdentifier(value, "triggered_stop_parent_identity"));
        const expectedLinkedOrderId = queriedChildId === stopOrderId
          ? expectedParentEntryOrderId : stopOrderId;
        if (new Set(queriedPositionValues).size > 1 ||
            queriedPositionValues.some((id) => id !== expectedPositionId) ||
            queriedOrder.positionSide !== "LONG" ||
            queriedOrder.workingType !== "MARK_PRICE" ||
            !sameDecimal(exactDecimal(queriedOrder.stopPrice,
              "triggered_order_stop_price"), expectedStopPrice) ||
            new Set(parentIds).size > 1 ||
            parentIds.some((id) => id !== expectedLinkedOrderId)) return refuse("stop_details", () => ({
              positionAliasesAgree: evidencePair(true, new Set(queriedPositionValues).size <= 1),
              positionIds: evidencePair([expectedPositionId], queriedPositionValues,
                queriedPositionValues.every((id) => id === expectedPositionId)),
              positionSide: evidencePair("LONG", queriedOrder.positionSide),
              workingType: evidencePair("MARK_PRICE", queriedOrder.workingType),
              stopPrice: evidencePair(stopPrice, queriedOrder.stopPrice,
                evidenceDecimalMatches(queriedOrder.stopPrice, stopPrice)),
              parentAliasesAgree: evidencePair(true, new Set(parentIds).size <= 1),
              parentOrderIds: evidencePair([expectedLinkedOrderId], parentIds,
                parentIds.every((id) => id === expectedLinkedOrderId)),
            }));
      }

      for (const field of ["origQty", "quantity", "executedQty", "cumExecQty", "filledQty"]) {
        if (queriedOrder[field] === undefined || queriedOrder[field] === null) continue;
        const amount = exactDecimal(queriedOrder[field], "triggered_order_quantity");
        if (!sameDecimal(amount, expectedStopQuantity)) return refuse("order_quantity", () => ({
          quantityAlias: evidencePair(field, field),
          orderQuantity: evidencePair(stopQuantity, queriedOrder[field], false),
        }));
      }

      const fillTriggerId = (fill) => exactStringFields(fill, [
        "triggerOrderId", "triggerOrderID",
      ]);
      const fillChildId = (fill) => exactStringFields(fill, ["orderId", "orderID"]);
      // A malformed or conflicting trigger ID anywhere in the read makes the
      // fill set ambiguous; numeric IDs are intentionally never coerced.
      for (const fill of fills) {
        const triggerValues = ["triggerOrderId", "triggerOrderID"]
          .filter((field) => fill?.[field] !== undefined && fill[field] !== null)
          .map((field) => fill[field]);
        // Native VST history includes the unrelated entry with a numeric zero
        // trigger sentinel. It is not a malformed stop ID and cannot count as
        // runner evidence. Nonzero numeric/conflicting IDs remain fail-closed.
        const untriggeredEntry = triggerValues.length > 0 &&
          triggerValues.every((value) => value === 0 || value === "0") &&
          fill.symbol === name && fill.side === "BUY" &&
          fill.positionSide === "LONG" && ["MARKET", "LIMIT"].includes(fill.type) &&
          fillChildId(fill) !== null && fillChildId(fill) !== queriedChildId &&
          fillChildId(fill) !== stopOrderId;
        if (untriggeredEntry) continue;
        const hasTriggerId = ["triggerOrderId", "triggerOrderID"].some((field) =>
          fill?.[field] !== undefined && fill[field] !== null);
        if (hasTriggerId && !fillTriggerId(fill)) return refuse("fill_trigger_aliases", () => ({
          triggerAliasesAgree: evidencePair(true, false),
          identifierAliases: evidencePair([stopOrderId],
            [fill?.triggerOrderId, fill?.triggerOrderID], false),
          rowIndex: evidencePair(undefined, fills.indexOf(fill), true),
        }));
      }
      const linkedFills = fills.filter((fill) => fillTriggerId(fill) === stopOrderId);
      if (linkedFills.length !== 1) return refuse("linked_fill_count", () => ({
        linkedFillCount: evidencePair(1, linkedFills.length, false),
        fillCount: evidencePair(undefined, fills.length, true),
        stopOrderId: evidencePair(undefined, stopOrderId, true),
      }));
      const fill = linkedFills[0];
      const childOrderId = fillChildId(fill);
      if (!childOrderId ||
          queriedChildId !== stopOrderId && childOrderId !== queriedChildId ||
          fills.filter((row) => fillChildId(row) === childOrderId).length !== 1 ||
          fill.symbol !== name || String(fill.side ?? "").toUpperCase() !== "SELL" ||
          fill.positionSide !== "LONG") {
        return refuse("linked_fill_identity", () => ({
          childIdentityValid: evidencePair(true, !!childOrderId),
          childIdsMatch: evidencePair(true, queriedChildId === stopOrderId || childOrderId === queriedChildId),
          childOrderId: evidencePair(queriedChildId, childOrderId, queriedChildId === stopOrderId || childOrderId === queriedChildId),
          childFillUnique: evidencePair(true, fills.filter((row) => fillChildId(row) === childOrderId).length === 1),
          fillSymbol: evidencePair(name, fill.symbol),
          side: evidencePair("SELL", String(fill.side ?? "").toUpperCase()),
          positionSide: evidencePair("LONG", fill.positionSide),
        }));
      }
      if (queriedChildId === stopOrderId) {
        const queriedChild = await api.queryOrder(symbol, { orderId: childOrderId });
        if (!object(queriedChild) ||
            exactStringFields(queriedChild, ["orderId", "orderID"]) !== childOrderId ||
            queriedChild.symbol !== name ||
            String(queriedChild.status ?? "").toUpperCase() !== "FILLED" ||
            queriedChild.type !== "STOP_MARKET" ||
            String(queriedChild.side ?? "").toUpperCase() !== "SELL" ||
            queriedChild.positionSide !== "LONG") return refuse("child_order_fields", () => ({
              orderFound: evidencePair(true, object(queriedChild)),
              childOrderId: evidencePair(childOrderId, exactStringFields(queriedChild, ["orderId", "orderID"])),
              symbol: evidencePair(name, queriedChild?.symbol),
              orderStatus: evidencePair("FILLED", String(queriedChild?.status ?? "").toUpperCase()),
              orderType: evidencePair("STOP_MARKET", queriedChild?.type),
              side: evidencePair("SELL", String(queriedChild?.side ?? "").toUpperCase()),
              positionSide: evidencePair("LONG", queriedChild?.positionSide),
            }));
        for (const field of ["origQty", "quantity", "executedQty", "cumExecQty", "filledQty"]) {
          if (queriedChild[field] === undefined || queriedChild[field] === null) continue;
          if (!sameDecimal(exactDecimal(queriedChild[field],
             "triggered_child_order_quantity"), expectedStopQuantity)) return refuse("child_quantity", () => ({
               quantityAlias: evidencePair(field, field),
               orderQuantity: evidencePair(stopQuantity, queriedChild[field], false),
             }));
        }
        const childPositionIds = ["positionId", "positionID"]
          .filter((field) => queriedChild[field] !== undefined &&
            queriedChild[field] !== null && queriedChild[field] !== 0 &&
            queriedChild[field] !== "0")
          .map((field) => exactIdentifier(queriedChild[field],
            "triggered_child_position_identity"));
        const childParentIds = [queriedChild.mainOrderId, queriedChild.parentOrderId]
          .filter((value) => value !== undefined && value !== null && value !== "")
          .map((value) => exactIdentifier(value, "triggered_child_parent_identity"));
        if (new Set(childPositionIds).size > 1 ||
            childPositionIds.some((id) => id !== expectedPositionId) ||
            new Set(childParentIds).size > 1 ||
            childParentIds.some((id) => id !== stopOrderId) ||
            queriedChild.workingType !== undefined &&
              queriedChild.workingType !== "MARK_PRICE" ||
            queriedChild.stopPrice !== undefined &&
              !sameDecimal(exactDecimal(queriedChild.stopPrice,
                "triggered_child_stop_price"), expectedStopPrice)) return refuse("child_details", () => ({
                  positionAliasesAgree: evidencePair(true, new Set(childPositionIds).size <= 1),
                  positionIds: evidencePair([expectedPositionId], childPositionIds,
                    childPositionIds.every((id) => id === expectedPositionId)),
                  parentAliasesAgree: evidencePair(true, new Set(childParentIds).size <= 1),
                  parentOrderIds: evidencePair([stopOrderId], childParentIds,
                    childParentIds.every((id) => id === stopOrderId)),
                  workingType: evidencePair("MARK_PRICE", queriedChild.workingType,
                    queriedChild.workingType === undefined || queriedChild.workingType === "MARK_PRICE"),
                  stopPrice: evidencePair(stopPrice, queriedChild.stopPrice,
                    queriedChild.stopPrice === undefined || evidenceDecimalMatches(queriedChild.stopPrice, stopPrice)),
                }));
      }

      const quantityValues = [fill.qty, fill.quantity, fill.volume]
        .filter((value) => value !== undefined && value !== null);
      if (quantityValues.length === 0) return refuse("fill_quantity_presence", () => ({
        quantityAliasCount: evidencePair(1, quantityValues.length, false),
      }));
      const quantities = quantityValues.map((value) =>
        exactDecimal(value, "triggered_fill_quantity"));
      if (quantities.some((quantity) => !sameDecimal(quantity, quantities[0]))) {
        return refuse("fill_quantity_aliases", () => ({
          quantityAliasesAgree: evidencePair(true, false),
          quantityValues: evidencePair([stopQuantity], quantityValues, false),
        }));
      }
      const fillQuantity = quantities[0];
      const priceValues = [fill.price, fill.tradePrice, fill.fillPrice]
        .filter((value) => value !== undefined && value !== null);
      if (priceValues.length === 0) return refuse("fill_price_presence", () => ({
        priceAliasCount: evidencePair(1, priceValues.length, false),
      }));
      const fillPrices = priceValues.map((value) =>
        exactDecimal(value, "triggered_fill_price"));
      if (fillPrices.some((price) => !sameDecimal(price, fillPrices[0]))) return refuse("fill_price_aliases", () => ({
        priceAliasesAgree: evidencePair(true, false), priceValues: evidencePair(undefined, priceValues, false),
      }));
      if (!sameDecimal(fillQuantity, expectedStopQuantity)) return refuse("fill_quantity", () => ({
        filledQuantity: evidencePair(stopQuantity, decimalText(fillQuantity), false),
      }));

      const feeValues = [
        fill.commission, fill.fee, fill.commissionAmount, fill.feeAmount,
      ].filter((value) => value !== undefined && value !== null);
      const feeAssetValues = [
        fill.commissionAsset, fill.feeAsset, fill.feeCurrency, fill.currency,
      ].filter((value) => value !== undefined && value !== null);
      if (feeValues.length === 0 || feeAssetValues.length === 0 ||
          feeAssetValues.some((asset) => typeof asset !== "string" ||
            !/^[A-Z0-9]{2,12}$/.test(asset)) ||
          new Set(feeAssetValues).size !== 1) return refuse("fill_fee_fields", () => ({
            feeAliasCount: evidencePair(1, feeValues.length, feeValues.length > 0),
            feeAssetAliasCount: evidencePair(1, feeAssetValues.length, feeAssetValues.length > 0),
            feeAssetsValid: evidencePair(true, feeAssetValues.every((asset) =>
              typeof asset === "string" && /^[A-Z0-9]{2,12}$/.test(asset))),
            feeAssetAliasesAgree: evidencePair(true, new Set(feeAssetValues).size === 1),
          }));
      const fees = feeValues.map((value) =>
        exactDecimal(value, "triggered_fill_fee", { allowZero: true, signed: true }));
      if (fees.some((fee) => !sameDecimal(fee, fees[0]))) return refuse("fill_fee_aliases", () => ({
        feeAliasesAgree: evidencePair(true, false), feeValues: evidencePair(undefined, feeValues, false),
      }));

      const timeFields = [
        fill.filledTm, fill.filledTime, fill.time, fill.timestamp, fill.tradeTime,
      ].filter((value) => value !== undefined && value !== null);
      const times = timeFields.map((value) => fillTime({ time: value }));
      if (times.length === 0 || times.some((time) => time === null) ||
          new Set(times).size !== 1 || times[0] < startedAt || times[0] > now) {
        return refuse("fill_time", () => ({
          timeAliasCount: evidencePair(1, times.length, times.length > 0),
          timesAgree: evidencePair(true, times.every((time) => time !== null) && new Set(times).size === 1),
          fillTimes: evidencePair(undefined, times, false),
          fillWithinWindow: evidencePair(true, times[0] >= startedAt && times[0] <= now),
          startTime: evidencePair(undefined, startedAt, true),
          endTime: evidencePair(undefined, now, true),
        }));
      }

      const activePositions = [];
      for (const row of positions) {
        if (row?.symbol !== name) continue;
        const amount = exactDecimal(row.positionAmt, "triggered_position_quantity", {
          allowZero: true, signed: true,
        });
        if (amount.amount < 0n) return refuse("nonnegative_position", () => ({
          positionQuantity: evidencePair("0", row.positionAmt, false),
          rowIndex: evidencePair(undefined, positions.indexOf(row), true),
        }));
        if (amount.amount > 0n) activePositions.push({ row, amount });
      }
      let residualPosition;
      let survivingStops = [];
      if (residualDecimal.amount === 0n) {
        if (activePositions.length !== 0 || orders.length !== 0) return refuse("flat_after_stop", () => ({
          activePositionCount: evidencePair(0, activePositions.length),
          openOrderCount: evidencePair(0, orders.length),
        }));
        residualPosition = {
          verified: true,
          positionId: expectedPositionId,
          quantity: "0",
        };
      } else {
        if (activePositions.length !== 1 || orders.length === 0) return refuse("residual_presence", () => ({
          activePositionCount: evidencePair(1, activePositions.length),
          openOrderCount: evidencePair(1, orders.length, orders.length > 0),
          remainingQuantity: evidencePair(undefined, residualQuantity, true),
        }));
        const current = activePositions[0];
        if (current.row.positionSide !== "LONG" ||
            positionId(current.row) !== expectedPositionId ||
            !sameDecimal(current.amount, residualDecimal)) return refuse("residual_identity_quantity", () => ({
              positionSide: evidencePair("LONG", current.row.positionSide),
              positionId: evidencePair(expectedPositionId, positionId(current.row)),
              positionQuantity: evidencePair(residualQuantity, current.row.positionAmt,
                sameDecimal(current.amount, residualDecimal)),
            }));
        const seenStopIds = new Set();
        if (expectedOpenStops !== null &&
            (!Array.isArray(expectedOpenStops) ||
             orders.length !== expectedOpenStops.length)) return refuse("surviving_stop_count", () => ({
               ordersArray: evidencePair(true, Array.isArray(expectedOpenStops)),
               openOrderCount: evidencePair(expectedOpenStops?.length, orders.length),
             }));
        for (const order of orders) {
          const orderPositionId = positionId(order);
          const id = orderId(order);
          const expected = expectedOpenStops === null ? null
            : expectedOpenStops.find((stop) => stop?.orderId === id);
          const amount = exactDecimal(order.origQty ?? order.quantity,
            "triggered_open_stop_quantity");
          const price = exactDecimal(order.stopPrice, "triggered_open_stop_price");
          if (order.symbol !== name || order.type !== "STOP_MARKET" ||
              order.status !== "NEW" || order.side !== "SELL" ||
              order.positionSide !== "LONG" || orderPositionId !== expectedPositionId ||
              id === stopOrderId || seenStopIds.has(id) ||
              expectedOpenStops === null && !sameDecimal(amount, residualDecimal) ||
              expectedOpenStops !== null && (!expected ||
                !sameDecimal(amount, exactDecimal(expected.quantity,
                  "triggered_expected_open_stop_quantity")) ||
                !sameDecimal(price, exactDecimal(expected.stopPrice,
                  "triggered_expected_open_stop_price")))) return refuse("surviving_stop_fields", () => ({
                    symbol: evidencePair(name, order.symbol), orderType: evidencePair("STOP_MARKET", order.type),
                    orderStatus: evidencePair("NEW", order.status), side: evidencePair("SELL", order.side),
                    positionSide: evidencePair("LONG", order.positionSide),
                    positionId: evidencePair(expectedPositionId, orderPositionId),
                    stopIsNotTriggeredOrder: evidencePair(true, id !== stopOrderId),
                    stopIdUnique: evidencePair(true, !seenStopIds.has(id)),
                    expectedStopFound: evidencePair(true, expectedOpenStops === null || !!expected),
                    orderId: evidencePair(expected?.orderId, id, expectedOpenStops === null || !!expected),
                    stopQuantity: evidencePair(expected?.quantity ?? residualQuantity, decimalText(amount),
                      expectedOpenStops === null ? sameDecimal(amount, residualDecimal)
                        : !!expected && evidenceDecimalMatches(decimalText(amount), expected.quantity)),
                    stopPrice: evidencePair(expected?.stopPrice, decimalText(price),
                      expectedOpenStops === null || !!expected &&
                        evidenceDecimalMatches(decimalText(price), expected.stopPrice)),
                  }));
          if (expected) {
            const executionProof = explicitZeroExecutionProof(order, id);
            if (!executionProof ||
                expected.parentOrderId !== undefined &&
                  ![order.mainOrderId, order.mainOrderID,
                    order.parentOrderId, order.parentOrderID]
                    .filter((value) => value !== undefined &&
                      value !== null && value !== "")
                    .every((value) => {
                      try {
                        return exactIdentifier(value,
                          "triggered_open_stop_parent_id") === expected.parentOrderId;
                      } catch {
                        return false;
                      }
                    })) return refuse("surviving_stop_execution", () => ({
                      executionZero: evidencePair(true, !!executionProof),
                      parentOrderId: evidencePair(expected.parentOrderId,
                        order.mainOrderId ?? order.mainOrderID ?? order.parentOrderId ?? order.parentOrderID,
                        expected.parentOrderId === undefined || [order.mainOrderId, order.mainOrderID,
                          order.parentOrderId, order.parentOrderID].filter((value) => value != null && value !== "")
                          .every((value) => typeof value === "string" && value === expected.parentOrderId ||
                            typeof value === "number" && Number.isSafeInteger(value) &&
                            String(value) === expected.parentOrderId)),
                      orderId: evidencePair(expected.orderId, id),
                    }));
          }
          seenStopIds.add(id);
          survivingStops.push({
            orderId: id,
            positionId: orderPositionId,
            quantity: decimalText(amount),
            stopPrice: decimalText(price),
            ...(expected ? {
              executionProof: explicitZeroExecutionProof(order, id),
            } : {}),
          });
        }
        if (expectedOpenStops !== null &&
            expectedOpenStops.some((stop) => !seenStopIds.has(stop?.orderId))) {
          return refuse("surviving_stop_identity_set", () => ({
            allExpectedStopsFound: evidencePair(true, false),
            currentOrderIds: evidencePair(expectedOpenStops.map((stop) => stop?.orderId), [...seenStopIds], false),
          }));
        }
        residualPosition = {
          verified: true,
          positionId: expectedPositionId,
          quantity: residualQuantity,
        };
      }

      return {
        verified: true,
        status: "filled",
        parentStopId: stopOrderId,
        parentStopPrice: decimalText(expectedStopPrice),
        childOrderId,
        fill: {
          orderId: childOrderId,
          triggerOrderId: stopOrderId,
          quantity: decimalText(fillQuantity),
          price: decimalText(fillPrices[0]),
          fee: {
            asset: feeAssetValues[0],
            amount: decimalText(fees[0]),
          },
          at: new Date(times[0]).toISOString(),
        },
        residualPosition,
        openStops: survivingStops,
      };
    } catch (error) {
      return refuse("read_or_validation_exception", {}, error);
    }
  }

  async function readOriginalStopRefusalRunnerFillEvidence({
    clientOrderId, request, persistedPosition,
  }) {
    const unknown = { verified: false, status: "unknown" };
    try {
      if (typeof clientOrderId !== "string" || clientOrderId.trim() === "" ||
          !object(request) || request.operation !== "cancel_original_stop" ||
          !object(persistedPosition) ||
          typeof api.queryOrderHistory !== "function") return unknown;
      const details = splitIntentDetails(request);
      const name = assertSymbol(request.symbol);
      const now = Number(clock());
      const range = intentRange(request, now);
      if (!range || !Number.isSafeInteger(now) || now <= 0 ||
          !range.coversIntent || !Array.isArray(persistedPosition.split?.baselineOpenOrderIds)) {
        return unknown;
      }
      const split = persistedPosition.split;
      const persistedPositionIds = [
        persistedPosition.positionId,
        persistedPosition.exchangePositionId,
      ].filter((value) => value !== undefined && value !== null)
        .map((value) => exactIdentifier(value, "persisted_position_id"));
      const persistedOriginalId = exactIdentifier(
        split.originalStopOrderId, "persisted_original_stop_id",
      );
      const persistedCoreId = exactIdentifier(
        split.coreStop?.orderId, "persisted_core_stop_id",
      );
      const persistedRunnerId = exactIdentifier(
        split.runnerStop?.orderId, "persisted_runner_stop_id",
      );
      const original = {
        id: details.originalStopOrderId,
        quantity: details.coreQuantity,
        stopPrice: details.signalStopPrice,
      };
      const core = stopRecord(request, "core", details);
      const runner = stopRecord(request, "runner", details);
      const exactDecimalAliasesMatch = (row, keys, expected, label) => {
        const values = keys.filter((field) =>
          row?.[field] !== undefined && row[field] !== null)
          .map((field) => exactDecimal(row[field], label));
        return values.length > 0 &&
          values.every((value) => sameDecimal(value, exactDecimal(expected, label)));
      };
      const baselineIds = split.baselineOpenOrderIds
        .map((id) => exactIdentifier(id, "persisted_split_stop_id"));
      const expectedIds = [
        details.originalStopOrderId, core.orderId, runner.orderId,
      ].sort();
      const total = exactDecimal(details.totalQuantity,
        "runner_recovery_total_quantity");
      const coreAmount = exactDecimal(details.coreQuantity,
        "runner_recovery_core_quantity");
      const runnerAmount = exactDecimal(details.runnerQuantity,
        "runner_recovery_runner_quantity");
      const combinedScale = Math.max(total.scale, coreAmount.scale, runnerAmount.scale);
      const isExactEightyTwenty =
        decimalAtScale(coreAmount, combinedScale) * 5n ===
          decimalAtScale(total, combinedScale) * 4n &&
        decimalAtScale(runnerAmount, combinedScale) * 5n ===
          decimalAtScale(total, combinedScale) &&
        decimalAtScale(coreAmount, combinedScale) +
          decimalAtScale(runnerAmount, combinedScale) ===
            decimalAtScale(total, combinedScale);
      const persistedQuantity = persistedPosition.remainingQty ??
        persistedPosition.quantity;
      if (!["open", "closing"].includes(persistedPosition.status) ||
          persistedPosition.sourceSignalId !== details.sourceSignalId ||
          persistedPosition.environment !== "vst" ||
          persistedPosition.accountId !== accountId ||
          persistedPosition.symbol !== request.symbol ||
          split.stage !== "cancel_original_pending" ||
          persistedPositionIds.length === 0 ||
          persistedPositionIds.some((id) => id !== details.positionId) ||
          persistedOriginalId !== details.originalStopOrderId ||
          persistedCoreId !== core.orderId ||
          persistedRunnerId !== runner.orderId ||
          !sameDecimal(exactDecimal(persistedQuantity,
            "persisted_runner_recovery_total_quantity"), total) ||
          !sameDecimal(exactDecimal(split.totalQuantity,
            "persisted_runner_recovery_split_total"), total) ||
          !sameDecimal(exactDecimal(split.coreQuantity,
            "persisted_runner_recovery_split_core"), coreAmount) ||
          !sameDecimal(exactDecimal(split.runnerQuantity,
            "persisted_runner_recovery_split_runner"), runnerAmount) ||
          !sameDecimal(exactDecimal(split.signalStopPrice,
            "persisted_runner_recovery_signal_stop"),
          exactDecimal(details.signalStopPrice, "runner_recovery_signal_stop")) ||
          !sameDecimal(exactDecimal(split.coreStop.quantity,
            "persisted_runner_recovery_core_stop_quantity"), coreAmount) ||
          !sameDecimal(exactDecimal(split.coreStop.stopPrice,
            "persisted_runner_recovery_core_stop_price"),
          exactDecimal(details.signalStopPrice, "runner_recovery_signal_stop")) ||
          !sameDecimal(exactDecimal(split.runnerStop.quantity,
            "persisted_runner_recovery_runner_stop_quantity"), runnerAmount) ||
          !sameDecimal(exactDecimal(split.runnerStop.stopPrice,
            "persisted_runner_recovery_runner_stop_price"),
          exactDecimal(details.breakEvenPrice, "runner_recovery_break_even")) ||
          !isExactEightyTwenty ||
          JSON.stringify(baselineIds.sort()) !== JSON.stringify(expectedIds)) {
        return unknown;
      }

      const expectedRemaining = decimalText(subtractDecimal(total, runnerAmount));
      const originalParentIds = [
        split.originalStop?.mainOrderId,
        split.originalStop?.mainOrderID,
        split.originalStop?.parentOrderId,
        split.originalStop?.parentOrderID,
      ].filter((value) => value !== undefined && value !== null && value !== "")
        .map((value) => exactIdentifier(value, "persisted_original_stop_parent"));
      if (originalParentIds.some((id) => id !== details.entryOrderId)) return unknown;
      const expectedOpenStops = [
        {
          orderId: original.id,
          quantity: expectedRemaining,
          stopPrice: original.stopPrice,
          parentOrderId: details.entryOrderId,
        },
        {
          orderId: core.orderId,
          quantity: expectedRemaining,
          stopPrice: core.stopPrice,
          parentOrderId: details.entryOrderId,
        },
      ];
      const exactCurrentStop = (row, expected) => {
        const executionProof = explicitZeroExecutionProof(row, expected.orderId);
        const parentFields = [
          "mainOrderId", "mainOrderID", "parentOrderId", "parentOrderID",
        ].filter((field) => row?.[field] !== undefined &&
          row[field] !== null && row[field] !== "");
        const parents = parentFields.map((field) =>
          exactIdentifier(row[field], "runner_recovery_stop_parent"));
        return row?.symbol === name && row?.type === "STOP_MARKET" &&
          row?.status === "NEW" && row?.side === "SELL" &&
          row?.positionSide === "LONG" && row?.workingType === "MARK_PRICE" &&
          positionId(row) === details.positionId && executionProof !== null &&
          exactDecimalAliasesMatch(row, ["origQty", "quantity"], expected.quantity,
            "runner_recovery_active_stop_quantity") &&
          sameDecimal(exactDecimal(row.stopPrice,
            "runner_recovery_active_stop_price"),
          exactDecimal(expected.stopPrice, "runner_recovery_expected_stop_price")) &&
          parents.every((parent) => parent === details.entryOrderId)
          ? executionProof : null;
      };
      const [rawQueriedOriginal, rawQueriedCore, corroboratingOrders] = await Promise.all([
        api.queryOrder(request.symbol, { orderId: original.id }),
        api.queryOrder(request.symbol, { orderId: core.orderId }),
        api.getOpenOrders(request.symbol),
      ]);
      if (!Array.isArray(corroboratingOrders)) return unknown;
      const corroboratedQuery = (queried, expected) => {
        const matches = corroboratingOrders.filter((row) =>
          orderId(row) === expected.orderId);
        if (matches.length !== 1) return null;
        // Zero position IDs are an exchange query representation, not proof
        // of ownership. Resolve them only against an independent exact active
        // order; never infer linkage from the persisted snapshot alone.
        return corroborateVstActiveStopPosition(queried, matches[0], {
          orderId: expected.orderId, positionId: details.positionId,
        }) ?? queried;
      };
      const queriedOriginal = corroboratedQuery(rawQueriedOriginal, expectedOpenStops[0]);
      const queriedCore = corroboratedQuery(rawQueriedCore, expectedOpenStops[1]);
      const queriedOriginalExecutionProof =
        exactCurrentStop(queriedOriginal, expectedOpenStops[0]);
      const queriedCoreExecutionProof =
        exactCurrentStop(queriedCore, expectedOpenStops[1]);
      if (!queriedOriginalExecutionProof || !queriedCoreExecutionProof) {
        return unknown;
      }
      const observed = await observeTriggeredStop({
        symbol: request.symbol,
        positionId: details.positionId,
        stopOrderId: runner.orderId,
        stopQuantity: details.runnerQuantity,
        stopPrice: details.breakEvenPrice,
        previousQuantity: details.totalQuantity,
        startedAt: range.intentAt,
        requireStopDetails: true,
        expectedParentEntryOrderId: details.entryOrderId,
        expectedOpenStops,
      });
      if (observed?.verified !== true || observed.status !== "filled" ||
          observed.parentStopId !== runner.orderId ||
          observed.parentStopPrice !== details.breakEvenPrice ||
          observed.residualPosition?.verified !== true ||
          observed.residualPosition.positionId !== details.positionId ||
          !sameDecimal(exactDecimal(observed.residualPosition.quantity,
            "runner_recovery_observed_residual"), coreAmount) ||
          observed.fill?.triggerOrderId !== runner.orderId ||
          observed.fill?.orderId !== observed.childOrderId ||
          !sameDecimal(exactDecimal(observed.fill?.quantity,
            "runner_recovery_observed_fill_quantity"), runnerAmount)) {
        return unknown;
      }

      const history = await api.queryOrderHistory(request.symbol, range);
      const historyRows = Array.isArray(history) ? history : history?.orders;
      if (!boundedRows(historyRows)) return unknown;
      const strictId = (row, fields) => {
        const values = fields.filter((field) =>
          row?.[field] !== undefined && row[field] !== null).map((field) => row[field]);
        return values.length > 0 &&
          values.every((value) => typeof value === "string" && value.trim() !== "") &&
          new Set(values).size === 1 ? values[0] : null;
      };
      const childHistory = historyRows.filter((row) =>
        strictId(row, ["orderId", "orderID"]) === observed.childOrderId);
      if (childHistory.length !== 1) return unknown;
      const childRow = childHistory[0];
      const childTriggerId = strictId(childRow, ["triggerOrderId", "triggerOrderID"]);
      const childPositionIds = ["positionId", "positionID"]
        .filter((field) => childRow[field] !== undefined &&
          childRow[field] !== null && childRow[field] !== 0 && childRow[field] !== "0")
        .map((field) => exactIdentifier(childRow[field],
          "runner_child_history_position_id"));
      const childQuantityFields = [
        "origQty", "quantity", "executedQty", "cumExecQty", "filledQty",
      ].filter((field) => childRow[field] !== undefined && childRow[field] !== null);
      const historyTime = [childRow.time, childRow.createTime,
        childRow.createdTime, childRow.orderTime].map((value) =>
        asMillis(value) ?? (typeof value === "string" ? Date.parse(value) : null))
        .find((value) => Number.isSafeInteger(value) && value > 0) ?? null;
      if (strictId(childRow, ["orderId", "orderID"]) !== observed.childOrderId ||
          childTriggerId !== runner.orderId || childRow.symbol !== name ||
          childRow.type !== "STOP_MARKET" ||
          String(childRow.status ?? "").toUpperCase() !== "FILLED" ||
          String(childRow.side ?? "").toUpperCase() !== "SELL" ||
          childRow.positionSide !== "LONG" ||
          childRow.workingType !== undefined &&
            childRow.workingType !== "MARK_PRICE" ||
          new Set(childPositionIds).size > 1 ||
          childPositionIds.some((id) => id !== details.positionId) ||
          childQuantityFields.length === 0 ||
          !exactDecimalAliasesMatch(childRow, childQuantityFields, details.runnerQuantity,
            "runner_child_history_quantity") ||
          !sameDecimal(exactDecimal(childRow.stopPrice,
            "runner_child_history_stop_price"),
          exactDecimal(details.breakEvenPrice, "runner_child_expected_stop_price")) ||
          historyTime === null || historyTime < range.intentAt || historyTime > now) {
        return unknown;
      }

      const residualSnapshot = {
        verified: true,
        environment: "vst",
        accountId,
        symbol: request.symbol,
        positionId: details.positionId,
        quantity: expectedRemaining,
        protectiveStops: {
          core: {
            verified: true,
            tranche: "core",
            orderId: core.orderId,
            positionId: details.positionId,
            quantity: expectedRemaining,
            stopPrice: core.stopPrice,
          },
        },
        originalStop: {
          verified: true,
          positionId: details.positionId,
          orderId: original.id,
          quantity: expectedRemaining,
          stopPrice: original.stopPrice,
        },
      };
      const position = await readPosition(request.symbol, {
        persistedPosition: residualSnapshot,
        allowProcessCache: false,
      });
      if (position?.verified !== true || position.symbol !== request.symbol ||
          position.positionId !== details.positionId ||
          !sameDecimal(exactDecimal(position.quantity,
            "runner_recovery_final_position_snapshot"), coreAmount) ||
          position.side !== "Buy" || Number(position.leverage) !== PROFILE_LEVERAGE ||
          position.marginMode !== PROFILE_MARGIN) return unknown;

      // All per-order, history, fill, scoped position, and metadata reads are
      // complete. This timestamp anchors the final global account pair below.
      const requestStartedAtMs = Number(clock());
      if (!Number.isSafeInteger(requestStartedAtMs) ||
          requestStartedAtMs <= 0 || requestStartedAtMs < now ||
          requestStartedAtMs - now > RUNNER_FILL_RECOVERY_HISTORY_MAX_DURATION_MS) {
        return unknown;
      }
      const accountState = await readAccountState();
      const finalPairCompletedAtMs = Number(clock());
      if (!Number.isSafeInteger(finalPairCompletedAtMs) ||
          finalPairCompletedAtMs < requestStartedAtMs ||
          finalPairCompletedAtMs - requestStartedAtMs >
            RUNNER_FILL_RECOVERY_FINAL_PAIR_MAX_DURATION_MS) return unknown;
      if (!object(accountState) || accountState.verified !== true ||
          accountState.environment !== "vst" || accountState.accountId !== accountId ||
          !Array.isArray(accountState.positions) ||
          !Array.isArray(accountState.openOrders)) return unknown;
      const currentPositions = accountState.positions.filter((row) =>
        row?.symbol === name);
      const currentOrders = accountState.openOrders.filter((row) =>
        row?.symbol === name);
      if (currentPositions.length !== 1 || currentOrders.length !== 2) return unknown;
      const currentPosition = currentPositions[0];
      if (currentPosition.positionSide !== "LONG" ||
          positionId(currentPosition) !== details.positionId ||
          !sameDecimal(exactDecimal(currentPosition.positionAmt,
            "runner_recovery_final_position"), coreAmount)) return unknown;
      const currentOriginal = currentOrders.find((row) => {
        try {
          return orderId(row) === original.id;
        } catch {
          return false;
        }
      });
      const currentCore = currentOrders.find((row) => {
        try {
          return orderId(row) === core.orderId;
        } catch {
          return false;
        }
      });
      const originalExecutionProof = currentOriginal &&
        exactCurrentStop(currentOriginal, expectedOpenStops[0]);
      const coreExecutionProof = currentCore &&
        exactCurrentStop(currentCore, expectedOpenStops[1]);
      if (!originalExecutionProof || !coreExecutionProof ||
          !exactCurrentStop(queriedOriginal, expectedOpenStops[0]) ||
          !exactCurrentStop(queriedCore, expectedOpenStops[1])) return unknown;
      return {
        verified: true,
        outcome: "confirmed_original_stop_cancel_runner_fill",
        status: "filled",
        runnerFillRecovery: true,
        requestStartedAtMs,
        fill: observed.fill,
        position,
        originalStop: {
          ...currentOriginal,
          verified: true,
          executionProof: originalExecutionProof,
        },
        coreStop: {
          ...currentCore,
          verified: true,
          executionProof: coreExecutionProof,
        },
        runnerStop: {
          verified: true,
          symbol: name,
          orderId: runner.orderId,
          childOrderId: observed.childOrderId,
          positionId: details.positionId,
          type: "STOP_MARKET",
          status: "FILLED",
          side: "SELL",
          positionSide: "LONG",
          origQty: details.runnerQuantity,
          executedQty: details.runnerQuantity,
          stopPrice: details.breakEvenPrice,
          workingType: "MARK_PRICE",
        },
      };
    } catch {
      return unknown;
    }
  }

  async function readSentOriginalStopCancellationRunnerFillEvidence({
    clientOrderId, request, persistedPosition,
  }) {
    const unknown = { verified: false, status: "unknown" };
    try {
      if (typeof clientOrderId !== "string" || clientOrderId.trim() === "" ||
          !object(request) || request.operation !== "cancel_original_stop" ||
          !object(persistedPosition) ||
          typeof api.queryOrder !== "function" ||
          typeof api.queryOrderHistory !== "function" ||
          typeof api.queryFills !== "function") return unknown;
      const details = splitIntentDetails(request);
      const name = assertSymbol(request.symbol);
      const now = Number(clock());
      const range = intentRange(request, now);
      if (!range || !range.coversIntent || !Number.isSafeInteger(now) || now <= 0) {
        return unknown;
      }
      const split = persistedPosition.split;
      const core = stopRecord(request, "core", details);
      const runner = stopRecord(request, "runner", details);
      const persistedPositionIds = [
        persistedPosition.positionId,
        persistedPosition.exchangePositionId,
      ].filter((value) => value !== undefined && value !== null)
        .map((value) => exactIdentifier(value, "persisted_position_id"));
      const baselineIds = Array.isArray(split?.baselineOpenOrderIds)
        ? split.baselineOpenOrderIds.map((id) =>
          exactIdentifier(id, "persisted_split_stop_id")) : [];
      const expectedIds = [
        details.originalStopOrderId, core.orderId, runner.orderId,
      ].sort();
      const total = exactDecimal(details.totalQuantity,
        "sent_runner_recovery_total_quantity");
      const coreAmount = exactDecimal(details.coreQuantity,
        "sent_runner_recovery_core_quantity");
      const runnerAmount = exactDecimal(details.runnerQuantity,
        "sent_runner_recovery_runner_quantity");
      const combinedScale = Math.max(total.scale, coreAmount.scale, runnerAmount.scale);
      const exactEightyTwenty =
        decimalAtScale(coreAmount, combinedScale) * 5n ===
          decimalAtScale(total, combinedScale) * 4n &&
        decimalAtScale(runnerAmount, combinedScale) * 5n ===
          decimalAtScale(total, combinedScale) &&
        decimalAtScale(coreAmount, combinedScale) +
          decimalAtScale(runnerAmount, combinedScale) ===
            decimalAtScale(total, combinedScale);
      const persistedQuantity = persistedPosition.remainingQty ??
        persistedPosition.quantity;
      if (!object(split) || !["open", "closing"].includes(persistedPosition.status) ||
          persistedPosition.sourceSignalId !== details.sourceSignalId ||
          persistedPosition.environment !== "vst" ||
          persistedPosition.accountId !== accountId ||
          persistedPosition.symbol !== request.symbol ||
          split.stage !== "cancel_original_pending" ||
          persistedPositionIds.length === 0 ||
          persistedPositionIds.some((id) => id !== details.positionId) ||
          exactIdentifier(split.originalStopOrderId,
            "persisted_original_stop_id") !== details.originalStopOrderId ||
          exactIdentifier(split.coreStop?.orderId,
            "persisted_core_stop_id") !== core.orderId ||
          exactIdentifier(split.runnerStop?.orderId,
            "persisted_runner_stop_id") !== runner.orderId ||
          !sameDecimal(exactDecimal(persistedQuantity,
            "persisted_sent_runner_recovery_total"), total) ||
          !sameDecimal(exactDecimal(split.totalQuantity,
            "persisted_sent_runner_recovery_split_total"), total) ||
          !sameDecimal(exactDecimal(split.coreQuantity,
            "persisted_sent_runner_recovery_split_core"), coreAmount) ||
          !sameDecimal(exactDecimal(split.runnerQuantity,
            "persisted_sent_runner_recovery_split_runner"), runnerAmount) ||
          !sameDecimal(exactDecimal(split.signalStopPrice,
            "persisted_sent_runner_recovery_signal_stop"),
          exactDecimal(details.signalStopPrice, "sent_runner_recovery_signal_stop")) ||
          !sameDecimal(exactDecimal(split.coreStop?.quantity,
            "persisted_sent_runner_recovery_core_stop_quantity"), coreAmount) ||
          !sameDecimal(exactDecimal(split.coreStop?.stopPrice,
            "persisted_sent_runner_recovery_core_stop_price"),
          exactDecimal(details.signalStopPrice, "sent_runner_recovery_signal_stop")) ||
          !sameDecimal(exactDecimal(split.runnerStop?.quantity,
            "persisted_sent_runner_recovery_runner_stop_quantity"), runnerAmount) ||
          !sameDecimal(exactDecimal(split.runnerStop?.stopPrice,
            "persisted_sent_runner_recovery_runner_stop_price"),
          exactDecimal(details.breakEvenPrice, "sent_runner_recovery_break_even")) ||
          !exactEightyTwenty ||
          JSON.stringify(baselineIds.sort()) !== JSON.stringify(expectedIds)) {
        return unknown;
      }

      const strictId = (row, fields) => {
        const values = fields.filter((field) =>
          row?.[field] !== undefined && row[field] !== null).map((field) => row[field]);
        return values.length > 0 &&
          values.every((value) => typeof value === "string" && value.trim() !== "") &&
          new Set(values).size === 1 ? values[0] : null;
      };
      const exactDecimalAliasesMatch = (row, keys, expected, label) => {
        const values = keys.filter((field) =>
          row?.[field] !== undefined && row[field] !== null)
          .map((field) => exactDecimal(row[field], label));
        return values.length > 0 &&
          values.every((value) => sameDecimal(value, exactDecimal(expected, label)));
      };
      const exactEntryParent = (row, label, { require = true } = {}) => {
        const fields = [
          "mainOrderId", "mainOrderID", "parentOrderId", "parentOrderID",
        ].filter((field) => row?.[field] !== undefined &&
          row[field] !== null && row[field] !== "");
        const parents = fields.map((field) =>
          exactIdentifier(row[field], label));
        return (!require || parents.length > 0) &&
          parents.every((parent) => parent === details.entryOrderId);
      };
      const [queriedOriginal, historyResult, originalFills] = await Promise.all([
        api.queryOrder(request.symbol, { orderId: details.originalStopOrderId }),
        api.queryOrderHistory(request.symbol, range),
        api.queryFills(request.symbol, {
          startTs: range.startTs,
          endTs: range.endTs,
          orderId: details.originalStopOrderId,
          currency: "VST",
        }),
      ]);
      const historyRows = Array.isArray(historyResult)
        ? historyResult : historyResult?.orders;
      if (!boundedRows(historyRows) || !boundedRows(originalFills) ||
          originalFills.length !== 0) return unknown;
      const originalHistoryMatches = historyRows.filter((row) =>
        strictId(row, ["orderId", "orderID"]) === details.originalStopOrderId);
      if (originalHistoryMatches.length !== 1) return unknown;
      const originalHistory = originalHistoryMatches[0];
      const expectedRemaining = decimalText(subtractDecimal(total, runnerAmount));
      const originalQuantityBasis = (row) => {
        const fields = ["origQty", "quantity"].filter((field) =>
          row?.[field] !== undefined && row[field] !== null);
        if (fields.length === 0) return null;
        const values = fields.map((field) => exactDecimal(row[field],
          "sent_original_stop_quantity"));
        const matchesTotal = values.every((value) =>
          sameDecimal(value, total));
        const matchesResidual = values.every((value) =>
          sameDecimal(value, exactDecimal(expectedRemaining,
            "sent_original_stop_residual_quantity")));
        if (matchesTotal === matchesResidual) return null;
        return matchesTotal ? "entry_total" : "post_runner_residual";
      };
      const exactCanceledOriginal = (row) => {
        const executionProof = explicitZeroExecutionProof(
          row, details.originalStopOrderId,
        );
        const quantityBasis = originalQuantityBasis(row);
        const isExactCanceledOriginal = object(row) && executionProof !== null &&
          row.symbol === name && row.type === "STOP_MARKET" &&
          ["CANCELED", "CANCELLED"].includes(
            String(row.status ?? "").toUpperCase(),
          ) &&
          row.side === "SELL" && row.positionSide === "LONG" &&
          row.workingType === "MARK_PRICE" &&
          strictId(row, ["positionId", "positionID"]) === details.positionId &&
          quantityBasis !== null &&
          sameDecimal(exactDecimal(row.stopPrice,
            "sent_original_stop_signal_price"),
          exactDecimal(details.signalStopPrice, "sent_expected_original_stop_price")) &&
          exactEntryParent(row, "sent_original_stop_entry_parent");
        return isExactCanceledOriginal
          ? { executionProof, quantityBasis } : null;
      };
      const queriedOriginalProof = exactCanceledOriginal(queriedOriginal);
      const originalHistoryProof = exactCanceledOriginal(originalHistory);
      if (!queriedOriginalProof || !originalHistoryProof ||
          queriedOriginalProof.quantityBasis !== originalHistoryProof.quantityBasis) {
        return unknown;
      }

      const expectedCore = {
        orderId: core.orderId,
        quantity: expectedRemaining,
        stopPrice: core.stopPrice,
        parentOrderId: details.entryOrderId,
      };
      const exactSentCore = (row) => {
        const executionProof = explicitZeroExecutionProof(row, core.orderId);
        return row?.symbol === name && row?.type === "STOP_MARKET" &&
          row?.status === "NEW" && row?.side === "SELL" &&
          row?.positionSide === "LONG" && row?.workingType === "MARK_PRICE" &&
          positionId(row) === details.positionId && executionProof !== null &&
          exactDecimalAliasesMatch(row, ["origQty", "quantity"],
            expectedRemaining, "sent_runner_recovery_core_quantity") &&
          sameDecimal(exactDecimal(row.stopPrice,
            "sent_runner_recovery_core_stop_price"),
          exactDecimal(details.signalStopPrice, "sent_runner_expected_core_stop")) &&
          exactEntryParent(row, "sent_runner_recovery_core_parent",
            { require: false })
          ? executionProof : null;
      };
      const queriedCore = await api.queryOrder(request.symbol, {
        orderId: core.orderId,
      });
      if (!exactSentCore(queriedCore)) return unknown;
      const observed = await observeTriggeredStop({
        symbol: request.symbol,
        positionId: details.positionId,
        stopOrderId: runner.orderId,
        stopQuantity: details.runnerQuantity,
        stopPrice: details.breakEvenPrice,
        previousQuantity: details.totalQuantity,
        startedAt: range.intentAt,
        requireStopDetails: true,
        expectedParentEntryOrderId: details.entryOrderId,
        expectedOpenStops: [expectedCore],
      });
      if (observed?.verified !== true || observed.status !== "filled" ||
          observed.parentStopId !== runner.orderId ||
          observed.parentStopPrice !== details.breakEvenPrice ||
          observed.residualPosition?.verified !== true ||
          observed.residualPosition.positionId !== details.positionId ||
          !sameDecimal(exactDecimal(observed.residualPosition.quantity,
            "sent_runner_recovery_observed_residual"), coreAmount) ||
          observed.fill?.triggerOrderId !== runner.orderId ||
          observed.fill?.orderId !== observed.childOrderId ||
          !sameDecimal(exactDecimal(observed.fill?.quantity,
            "sent_runner_recovery_observed_fill_quantity"), runnerAmount)) {
        return unknown;
      }
      const childHistoryMatches = historyRows.filter((row) =>
        strictId(row, ["orderId", "orderID"]) === observed.childOrderId);
      if (childHistoryMatches.length !== 1) return unknown;
      const childHistory = childHistoryMatches[0];
      const childPositionIds = ["positionId", "positionID"]
        .filter((field) => childHistory[field] !== undefined &&
          childHistory[field] !== null && childHistory[field] !== 0 &&
          childHistory[field] !== "0")
        .map((field) => exactIdentifier(childHistory[field],
          "sent_runner_child_history_position_id"));
      const childQuantityFields = [
        "origQty", "quantity", "executedQty", "cumExecQty", "filledQty",
      ].filter((field) =>
        childHistory[field] !== undefined && childHistory[field] !== null);
      const childTimeFields = [
        childHistory.time, childHistory.createTime,
        childHistory.createdTime, childHistory.orderTime,
      ].filter((value) => value !== undefined && value !== null);
      const childTimes = childTimeFields.map((value) =>
        asMillis(value) ?? (typeof value === "string" ? Date.parse(value) : null));
      if (strictId(childHistory, ["orderId", "orderID"]) !== observed.childOrderId ||
          strictId(childHistory, ["triggerOrderId", "triggerOrderID"]) !== runner.orderId ||
          childHistory.symbol !== name || childHistory.type !== "STOP_MARKET" ||
          String(childHistory.status ?? "").toUpperCase() !== "FILLED" ||
          String(childHistory.side ?? "").toUpperCase() !== "SELL" ||
          childHistory.positionSide !== "LONG" ||
          childHistory.workingType !== undefined &&
            childHistory.workingType !== "MARK_PRICE" ||
          new Set(childPositionIds).size > 1 ||
          childPositionIds.some((id) => id !== details.positionId) ||
          childQuantityFields.length === 0 ||
          !exactDecimalAliasesMatch(childHistory, childQuantityFields,
            details.runnerQuantity, "sent_runner_child_history_quantity") ||
          !sameDecimal(exactDecimal(childHistory.stopPrice,
            "sent_runner_child_history_stop_price"),
          exactDecimal(details.breakEvenPrice, "sent_runner_expected_stop_price")) ||
          childTimes.length === 0 ||
          childTimes.some((time) => !Number.isSafeInteger(time) ||
            time < range.intentAt || time > now) ||
          new Set(childTimes).size !== 1) return unknown;

      const residualSnapshot = {
        verified: true,
        environment: "vst",
        accountId,
        symbol: request.symbol,
        positionId: details.positionId,
        quantity: expectedRemaining,
        protectiveStops: {
          core: {
            verified: true,
            tranche: "core",
            orderId: core.orderId,
            positionId: details.positionId,
            quantity: expectedRemaining,
            stopPrice: core.stopPrice,
          },
        },
      };
      const position = await readPosition(request.symbol, {
        persistedPosition: residualSnapshot,
        allowProcessCache: false,
      });
      if (position?.verified !== true || position.symbol !== request.symbol ||
          position.positionId !== details.positionId ||
          !sameDecimal(exactDecimal(position.quantity,
            "sent_runner_recovery_final_position_snapshot"), coreAmount) ||
          position.side !== "Buy" || Number(position.leverage) !== PROFILE_LEVERAGE ||
          position.marginMode !== PROFILE_MARGIN) return unknown;

      // This timestamp anchors the final global account pair. All historical,
      // per-order, fill, scoped-position, and metadata reads are already done.
      const requestStartedAtMs = Number(clock());
      if (!Number.isSafeInteger(requestStartedAtMs) ||
          requestStartedAtMs <= 0 || requestStartedAtMs < now ||
          requestStartedAtMs - now > RUNNER_FILL_RECOVERY_HISTORY_MAX_DURATION_MS) {
        return unknown;
      }
      const accountState = await readAccountState();
      const finalPairCompletedAtMs = Number(clock());
      if (!Number.isSafeInteger(finalPairCompletedAtMs) ||
          finalPairCompletedAtMs < requestStartedAtMs ||
          finalPairCompletedAtMs - requestStartedAtMs >
            RUNNER_FILL_RECOVERY_FINAL_PAIR_MAX_DURATION_MS) return unknown;
      if (!object(accountState) || accountState.verified !== true ||
          accountState.environment !== "vst" || accountState.accountId !== accountId ||
          !Array.isArray(accountState.positions) ||
          !Array.isArray(accountState.openOrders)) return unknown;
      const currentPositions = accountState.positions.filter((row) =>
        row?.symbol === name);
      const currentOrders = accountState.openOrders.filter((row) =>
        row?.symbol === name);
      if (currentPositions.length !== 1 || currentOrders.length !== 1) return unknown;
      const currentPosition = currentPositions[0];
      if (currentPosition.positionSide !== "LONG" ||
          positionId(currentPosition) !== details.positionId ||
          !sameDecimal(exactDecimal(currentPosition.positionAmt,
            "sent_runner_recovery_final_position"), coreAmount)) return unknown;
      const currentCore = currentOrders[0];
      const coreExecutionProof = exactSentCore(currentCore);
      if (!coreExecutionProof || !exactSentCore(queriedCore)) return unknown;
      return {
        verified: true,
        outcome: "confirmed_sent_original_stop_cancel_runner_fill",
        status: "filled",
        originalCancellationConfirmed: true,
        runnerFillRecovery: true,
        requestStartedAtMs,
        fill: observed.fill,
        position,
        originalStop: {
          ...originalHistory,
          verified: true,
          executionProof: originalHistoryProof.executionProof,
        },
        originalStopQuantityBasis: originalHistoryProof.quantityBasis,
        coreStop: {
          ...currentCore,
          verified: true,
          executionProof: coreExecutionProof,
        },
        runnerStop: {
          verified: true,
          symbol: name,
          orderId: runner.orderId,
          childOrderId: observed.childOrderId,
          positionId: details.positionId,
          type: "STOP_MARKET",
          status: "FILLED",
          side: "SELL",
          positionSide: "LONG",
          origQty: details.runnerQuantity,
          executedQty: details.runnerQuantity,
          stopPrice: details.breakEvenPrice,
          workingType: "MARK_PRICE",
        },
      };
    } catch {
      return unknown;
    }
  }

  async function readPlanningInputs(signal) {
    const symbol = signal?.symbol;
    const name = assertSymbol(symbol);
    const impulsePlanning = signal?.patternId === "impulse_buy";
    if (impulsePlanning) {
      const missing = missingImpulseAdapterMethods();
      if (missing.length > 0) {
        throw new Error(`bingx_vst_impulse_adapters_unavailable:${missing.join(",")}`);
      }
    }
    let balanceSnapshot, filters, fees, funding, tiers, quote, settings;
    try {
      [
        filters, fees, funding, tiers, settings,
      ] = await Promise.all([
        readCoalesced("contract", symbol),
        readCoalesced("getFeeRate", symbol),
        readCoalesced("getFunding", symbol),
        readCoalesced("getRiskTiers", symbol),
        readPlanningSettings(symbol),
      ]);
      // Quotes are short-lived. Finish the slower mutable/filter reads before
      // reserving the final account/price requests so a shared native pacer
      // cannot leave this mark stale while the rest of the plan is collected.
      [balanceSnapshot, quote] = await Promise.all([
        readCoalescedInScope("planning-final", "getBalance"),
        api.getVstMarkPrice(symbol),
      ]);
    } catch (error) {
      // BingX code 109418 ("<symbol> is offline currently") is a legitimate,
      // symbol-specific rejection, not a worker bug or a transient failure --
      // see the comment above request() in bingx-live-api.mjs. Surface it as
      // its own recognizable condition so the caller can reject the signal
      // explicitly instead of recording an opaque generic error.
      if (isSymbolOfflineError(error)) {
        throw Object.assign(
          new Error(`bingx_vst_symbol_currently_offline:${name}`),
          { code: "vst_symbol_currently_offline", exchangeMessage: error.exchangeMessage },
        );
      }
      throw error;
    }
    if (!Array.isArray(tiers) || tiers.length === 0 ||
        filters?.symbol !== name ||
        !Number.isSafeInteger(filters.quantityPrecision) || filters.quantityPrecision < 0 ||
        !Number.isSafeInteger(filters.pricePrecision) || filters.pricePrecision < 0 ||
        quote?.symbol !== name) {
      throw new Error("bingx_vst_planning_reads_unverified");
    }
    const requiresIsolatedMarginPreparation = settings.marginMode !== PROFILE_MARGIN;
    // openSignal performs a fresh global account read AFTER planning and
    // checks this symbol for exposure immediately before any mutation.
    // Duplicating those same two signed reads here slowed every preparation
    // stage without improving the final safety gate.
    if (settings.mode !== "HEDGE" ||
        !["ISOLATED", "CROSSED"].includes(settings.marginMode) ||
        requiresIsolatedMarginPreparation &&
          typeof api.setVstIsolatedMarginForFlatSymbol !== "function") {
      throw new Error("bingx_vst_symbol_not_ready_flat_hedge_isolated");
    }
    if (Number(settings.leverage.longLeverage) !== PROFILE_LEVERAGE &&
        (!Number.isFinite(Number(settings.leverage.longLeverage)) ||
          Number(settings.leverage.longLeverage) <= 0 ||
          typeof api.setVstLongLeverage10 !== "function")) {
      throw new Error("bingx_vst_impulse_requires_long10_or_guarded_preparation");
    }
    let balanceRows;
    if (Array.isArray(balanceSnapshot)) balanceRows = balanceSnapshot;
    else if (Array.isArray(balanceSnapshot?.balance)) balanceRows = balanceSnapshot.balance;
    else if (object(balanceSnapshot?.balance)) balanceRows = [balanceSnapshot.balance];
    else if (object(balanceSnapshot) && Object.hasOwn(balanceSnapshot, "asset")) {
      balanceRows = [balanceSnapshot];
    } else {
      throw new Error("bingx_vst_total_balance_unavailable");
    }
    const vstBalances = balanceRows.filter((row) => row?.asset === "VST");
    if (vstBalances.length !== 1) {
      throw new Error("bingx_vst_total_balance_not_unique");
    }
    const totalVstBalance = strictNumber(vstBalances[0].balance, "total_vst_balance");
    const worstCaseNotional = isOwnerProfile(PROFILE)
      ? totalVstBalance * 0.01 * 10
      : allocationBudget(PROFILE, totalVstBalance) * PROFILE_LEVERAGE;
    if (!Number.isFinite(worstCaseNotional) || worstCaseNotional <= 0) {
      throw new Error("bingx_vst_worst_case_notional_invalid");
    }
    const normalizedTiers = tiers.map((tier) => {
      const maxNotional = strictNumber(tier?.maxNotional, "risk_tier_max_notional");
      const maintenanceMarginRate = strictNumber(
        tier?.maintenanceMarginRate, "maintenance_margin_rate", { allowZero: true },
      );
      if (maintenanceMarginRate >= 1) {
        throw new Error("bingx_vst_invalid_maintenance_margin_rate");
      }
      return { maxNotional, maintenanceMarginRate };
    });
    const applicableTier = normalizedTiers
      .filter((tier) => tier.maxNotional >= worstCaseNotional)
      .sort((left, right) => left.maxNotional - right.maxNotional)[0];
    if (!applicableTier) {
      throw new Error("bingx_vst_no_risk_tier_covers_worst_case_notional");
    }
    const quoteAt = asMillis(quote.timestamp);
    const now = Number(clock());
    if (quoteAt === null || !Number.isSafeInteger(now) || now <= 0 ||
        quoteAt > now || now - quoteAt > 10_000) {
      throw new Error("bingx_vst_quote_stale_or_invalid");
    }
    const maintenanceMarginRate = applicableTier.maintenanceMarginRate;
    const tickSize = 1 / (10 ** Number(filters.pricePrecision));
    return {
      balanceSnapshot,
      quote: { price: finitePositive(quote.markPrice, "quote_price"), observedAtMs: quoteAt },
      filters,
      marginMode: settings.marginMode,
      marginModeVerified: settings.marginMode === PROFILE_MARGIN,
      requiresIsolatedMarginPreparation,
      risk: {
        // The exchange's per-symbol maximum position value at the currently
        // configured leverage -- distinct from (and often smaller than) the
        // maintenance-margin risk tiers above. Re-verified here rather than
        // trusted from settings.leverage as-is, matching every other exchange
        // read on this path.
        maxPositionValue: strictNumber(
          settings.leverage?.maxPositionLongVal, "max_position_long_value",
        ),
        takerFeeRate: strictNumber(fees?.taker, "taker_fee_rate", { allowZero: true }),
        fundingRate: (() => {
          const text = String(funding?.rate ?? "");
          const rate = Number(text);
          if (!/^[+-]?\d+(?:\.\d+)?$/.test(text) ||
              !Number.isFinite(rate) || Math.abs(rate) >= 1) {
            throw new Error("bingx_vst_funding_rate_unverified");
          }
          return rate;
        })(),
        maintenanceMarginRate,
        stopBufferRate: Math.max(buffer, 0.005),
        tickSize,
      },
    };
  }

  async function readAccountState() {
    // Start the freshness clock before either global request begins. Measuring
    // only after the parallel pair resolves would erase their response time
    // and incorrectly make a slow snapshot look newly observed.
    const observedAt = Number(performance.now());
    const { positions, openOrders } = await readGlobalAccountRows();
    const openPositions = positions.filter((position) => {
      const amount = Number(position.positionAmt);
      return amount !== 0;
    });
    const accountState = {
      verified: true,
      environment: "vst",
      accountId,
      positions: openPositions,
      openOrders,
    };
    try {
      accountStateReadContexts.set(accountState, {
        environment: "vst",
        accountId,
        observedAt,
        publicSnapshot: structuredClone(accountState),
        positions: structuredClone(positions),
        openOrders: structuredClone(openOrders),
      });
    } catch {
      // This context is an optimization only. If the raw response cannot be
      // copied faithfully, readPosition falls back to its scoped exchange GETs.
    }
    return accountState;
  }

  function sameAccountStateSnapshot(actual, expected) {
    if (actual === expected) return true;
    if (actual === null || expected === null ||
        typeof actual !== typeof expected || typeof actual !== "object") {
      return false;
    }
    if (Array.isArray(actual) !== Array.isArray(expected) ||
        Array.isArray(expected) &&
          Object.getPrototypeOf(actual) !== Array.prototype ||
        !Array.isArray(expected) &&
          (Object.getPrototypeOf(actual) !== Object.prototype ||
           Object.getPrototypeOf(expected) !== Object.prototype)) {
      return false;
    }
    const actualKeys = Reflect.ownKeys(actual);
    const expectedKeys = Reflect.ownKeys(expected);
    if (actualKeys.length !== expectedKeys.length ||
        actualKeys.some((key) => !expectedKeys.includes(key))) {
      return false;
    }
    return expectedKeys.every((key) => {
      const actualDescriptor = Object.getOwnPropertyDescriptor(actual, key);
      const expectedDescriptor = Object.getOwnPropertyDescriptor(expected, key);
      if (!actualDescriptor || !expectedDescriptor ||
          actualDescriptor.enumerable !== expectedDescriptor.enumerable ||
          actualDescriptor.configurable !== expectedDescriptor.configurable) {
        return false;
      }
      if (Object.hasOwn(expectedDescriptor, "value")) {
        return Object.hasOwn(actualDescriptor, "value") &&
          actualDescriptor.writable === expectedDescriptor.writable &&
          sameAccountStateSnapshot(
            actualDescriptor.value, expectedDescriptor.value,
          );
      }
      return !Object.hasOwn(actualDescriptor, "value") &&
        actualDescriptor.get === expectedDescriptor.get &&
        actualDescriptor.set === expectedDescriptor.set;
    });
  }

  function consumeAccountStateReadContext(candidate, symbol) {
    if (!object(candidate)) return null;
    const context = accountStateReadContexts.get(candidate);
    if (!context) return null;
    accountStateReadContexts.delete(candidate);
    const observedAt = Number(context.observedAt);
    const ageMs = Number(performance.now()) - observedAt;
    let publicSnapshotMatches = false;
    try {
      publicSnapshotMatches = sameAccountStateSnapshot(
        candidate, context.publicSnapshot,
      );
    } catch {
      publicSnapshotMatches = false;
    }
    if (context.consumed === true) return null;
    context.consumed = true;
    if (context.environment !== "vst" || context.accountId !== accountId ||
        candidate.verified !== true || candidate.environment !== context.environment ||
        candidate.accountId !== context.accountId || !publicSnapshotMatches ||
        typeof symbol !== "string" || !/^[A-Z0-9]{1,20}USDT$/.test(symbol) ||
        !Number.isFinite(observedAt) || !Number.isFinite(ageMs) ||
        ageMs < 0 || ageMs > POSITION_ACCOUNT_STATE_CONTEXT_MAX_AGE_MS ||
        !Array.isArray(context.positions) || !Array.isArray(context.openOrders)) {
      return null;
    }
    try {
      validateAccountPositions(context.positions);
      validateAccountOrders(context.openOrders);
    } catch {
      return null;
    }
    return {
      positions: context.positions,
      openOrders: context.openOrders,
      observedAt,
    };
  }

  function isCurrentAccountStateReadContext(context) {
    const observedAt = Number(context?.observedAt);
    const ageMs = Number(performance.now()) - observedAt;
    return Number.isFinite(observedAt) && Number.isFinite(ageMs) &&
      ageMs >= 0 && ageMs <= POSITION_ACCOUNT_STATE_CONTEXT_MAX_AGE_MS;
  }

  // A one-shot, read-only verifier for an old error position. It deliberately
  // avoids recent order history (whose range is narrower): exact order GETs
  // establish each durable order ID, while complete currency-wide fill-history
  // snapshots are read in adjacent (start, end] windows no wider than the
  // existing 23-hour history guard. No DELETE/POST method is reachable here.
  async function captureFillArchiveWindow({ startTs, endTs, currency = "USDT" }) {
    if (supportsHistoricalCloseProof !== true ||
        typeof api.queryCompleteFillHistory !== "function" || currency !== "USDT") {
      throw new Error("bingx_vst_fill_archive_unsupported");
    }
    // The adapter keeps the complete currency-wide rows separate from its
    // legacy symbol-filtered result. Never substitute filtered fills here.
    const history = await api.queryCompleteFillHistory(startupSymbols[0], {
      startTs, endTs, currency,
    });
    if (!Array.isArray(history?.rawFills)) {
      throw new Error("bingx_vst_fill_archive_raw_snapshot_missing");
    }
    const orders = new Map();
    const parentOrderLookups = [];
    const readOrder = async (name, id, { childOrderId } = {}) => {
      const key = `${name}:${id}`;
      if (orders.has(key)) return orders.get(key);
      const priorLookup = parentOrderLookups.find((row) =>
        row.symbol === name && row.requestedOrderId === id);
      if (priorLookup) {
        if (archiveOrderId(priorLookup.response) !== childOrderId) {
          throw new Error("bingx_vst_fill_archive_parent_ambiguous");
        }
        return priorLookup.response;
      }
      const symbol = name.replace("-", "");
      const order = await api.queryOrder(symbol, { orderId: id });
      const lookup = { symbol: name, requestedOrderId: id, response: order };
      if (childOrderId && archiveParentLookupMatches(lookup, name, id) &&
          archiveOrderId(order) === childOrderId) {
        const savedChild = orders.get(`${name}:${childOrderId}`);
        if (!archiveParentLookupMatchesChild(lookup, savedChild)) {
          const error = new Error("bingx_vst_fill_archive_parent_response_conflict");
          error.archiveDiagnostic = {
            symbol: name, requestedOrderId: id, returnedOrderId: childOrderId,
            check: "parent_child_response_consistency",
            differingFields: [...new Set([
              ...Object.keys(savedChild ?? {}), ...Object.keys(order ?? {}),
            ])].filter((key) =>
              JSON.stringify(savedChild?.[key]) !== JSON.stringify(order?.[key])),
          };
          throw error;
        }
        parentOrderLookups.push(lookup);
        return order;
      }
      let actualOrderId = null;
      try { actualOrderId = archiveOrderId(order); } catch {}
      if (order?.symbol !== name || actualOrderId !== id) {
        const error = new Error("bingx_vst_fill_archive_order_unverified");
        error.archiveDiagnostic = {
          symbol: name, requestedOrderId: id,
          returnedSymbol: typeof order?.symbol === "string" ? order.symbol : null,
          returnedOrderId: actualOrderId,
          check: childOrderId ? "parent_order_identity" : "fill_order_identity",
        };
        throw error;
      }
      orders.set(key, order);
      return order;
    };
    for (const fill of history.rawFills) {
      const order = await readOrder(fill.symbol, archiveOrderId(fill));
      const parents = [...archiveParentIds(fill), ...archiveParentIds(order)];
      if (new Set(parents).size > 1) {
        throw new Error("bingx_vst_fill_archive_parent_ambiguous");
      }
      for (const parent of parents) await readOrder(fill.symbol, parent, {
        childOrderId: archiveOrderId(fill),
      });
    }
    return freezeArchiveWindow(validateArchiveWindow({
      environment: "vst", accountId, currency,
      coverage: history.coverage, rawFills: history.rawFills,
      orders: [...orders.values()], archivedAt: new Date(Number(clock())).toISOString(),
      ...(parentOrderLookups.length ? { parentOrderLookups } : {}),
    }, { accountId, currency }));
  }

  async function readHistoricalErrorClose(candidate) {
    if (supportsHistoricalCloseProof === false) {
      throw new Error("bingx_vst_historical_close_fill_completeness_unsupported");
    }
    if (typeof api.queryCompleteFillHistory !== "function") {
      throw new Error("bingx_vst_historical_close_fill_completeness_unsupported");
    }
    const snapshot = candidate?.snapshot;
    const intent = candidate?.entryIntent;
    const symbol = candidate?.symbol;
    const name = assertSymbol(symbol);
    const ownerPreRunnerReview = candidate?.ownerPreRunnerCloseReview === true;
    const closeIntent = candidate?.closeIntent;
    const ownerPreRunnerRequestValid = () => {
      if (!ownerPreRunnerReview) return true;
      const request = closeIntent?.request;
      const split = snapshot?.split;
      try {
        return split?.stage === "runner_pending" &&
          request?.sourceSignalId === candidate.sourceSignalId &&
          request?.environment === "vst" &&
          request?.accountId === accountId &&
          request?.symbol === symbol &&
          request?.positionId === snapshot.exchangePositionId &&
          request.positionId === split.positionId &&
          request?.closeIntentId === closeIntent.clientOrderId &&
          sameDecimal(exactDecimal(request.totalQuantity,
            "legacy_pre_runner_review_quantity"),
          exactDecimal(snapshot.remainingQty,
            "legacy_pre_runner_snapshot_quantity")) &&
          sameDecimal(exactDecimal(request.totalQuantity,
            "legacy_pre_runner_review_quantity"),
          exactDecimal(split.totalQuantity,
            "legacy_pre_runner_split_quantity")) &&
          request.originalStop?.orderId === split.originalStopOrderId &&
          sameDecimal(exactDecimal(request.originalStop.quantity,
            "legacy_pre_runner_original_quantity"),
          exactDecimal(request.totalQuantity,
            "legacy_pre_runner_total_quantity")) &&
          sameDecimal(exactDecimal(request.originalStop.stopPrice,
            "legacy_pre_runner_original_stop_price"),
          exactDecimal(split.signalStopPrice,
            "legacy_pre_runner_signal_stop")) &&
          request.coreStop?.orderId === split.coreStop?.orderId &&
          sameDecimal(exactDecimal(request.coreStop.quantity,
            "legacy_pre_runner_core_quantity"),
          exactDecimal(split.coreStop?.quantity,
            "legacy_pre_runner_saved_core_quantity")) &&
          sameDecimal(exactDecimal(request.coreStop.stopPrice,
            "legacy_pre_runner_core_stop_price"),
          exactDecimal(split.coreStop?.stopPrice,
            "legacy_pre_runner_saved_core_stop_price"));
      } catch {
        return false;
      }
    };
    if (!candidate ||
        !(candidate.status === "error" || isVerifiedEntryCloseCandidate(candidate) ||
          ownerPreRunnerReview &&
          ["open", "closing", "unknown"].includes(candidate.status)) ||
        snapshot?.environment !== "vst" || snapshot?.accountId !== accountId ||
        snapshot?.symbol !== symbol ||
        intent?.sourceSignalId !== candidate.sourceSignalId ||
        intent?.phase !== "market-entry" ||
        !["failed", "reconciled"].includes(intent?.state) ||
        intent?.request?.operation !== "entry" ||
        intent?.request?.environment !== "vst" ||
        intent?.request?.accountId !== accountId ||
        intent?.request?.symbol !== symbol ||
        intent?.exchangeOrderId == null ||
        snapshot.manualResolution ||
        ownerPreRunnerReview &&
          (closeIntent?.state !== "unknown" ||
           closeIntent?.request?.operation !== "close_pre_runner_split" ||
           closeIntent?.sourceSignalId !== candidate.sourceSignalId ||
           closeIntent?.request?.sourceSignalId !== candidate.sourceSignalId ||
           closeIntent?.request?.environment !== "vst" ||
           closeIntent?.request?.accountId !== accountId ||
           closeIntent?.request?.symbol !== symbol ||
           closeIntent?.request?.closeIntentId !== closeIntent?.clientOrderId ||
           !/^impulse-runner-breakeven-abort-\d+$/.test(closeIntent?.phase ?? "")) ||
        !ownerPreRunnerRequestValid()) {
      throw new Error("bingx_vst_historical_close_candidate_ineligible");
    }
    const savedEntryId = exactIdentifier(intent.exchangeOrderId,
      "historical_close_entry_order_id");
    const nowBefore = Number(clock());
    if (!Number.isSafeInteger(nowBefore) || nowBefore <= 0) {
      throw new Error("bingx_vst_historical_close_clock_invalid");
    }
    const savedEntryAt = asMillis(snapshot.entryAt ?? snapshot.verifiedFill?.at ??
      intent.request?.intentCreatedAt ?? intent.createdAt);
    const archiveWindowsAvailable = fillArchiveStore &&
      typeof fillArchiveStore.listFillArchiveWindows === "function" &&
      savedEntryAt !== null
      ? await fillArchiveStore.listFillArchiveWindows({
        accountId, currency: "USDT",
        startTs: Math.max(1, savedEntryAt - 60_000), endTs: nowBefore,
      }) : [];
    for (const window of archiveWindowsAvailable) validateArchiveWindow(window, { accountId });
    // Prefer current exact reads. Only a saved terminal execution may replace
    // an expired exact order GET; active-order snapshots are never flat proof.
    const readExactHistoricalOrder = async (id, { parentConfiguration = false } = {}) => {
      try {
        const current = await api.queryOrder(symbol, { orderId: id });
        if (current) return current;
      } catch (error) {
        if (!archiveWindowsAvailable.length) throw error;
      }
      const saved = archiveWindowsAvailable
        .slice().sort((a, b) => Date.parse(b.archivedAt) - Date.parse(a.archivedAt))
        .flatMap((w) => w.orders)
        .find((o) => o.symbol === name && archiveOrderId(o) === id &&
          (parentConfiguration ||
            ["FILLED", "CANCELED", "CANCELLED", "PARTIALLY_FILLED"]
              .includes(String(o.status).toUpperCase())));
      if (!saved) throw new Error("bingx_vst_historical_close_exact_order_unavailable");
      return saved;
    };
    const entryOrder = await readExactHistoricalOrder(savedEntryId);
    if (!entryOrder || entryOrder.symbol !== name ||
        orderId(entryOrder) !== savedEntryId) {
      throw new Error("bingx_vst_historical_close_entry_order_unverified");
    }
    const entryOrderAt = asMillis(
      entryOrder.time ?? entryOrder.createTime ?? entryOrder.timestamp,
    );
    if (entryOrderAt === null || entryOrderAt > nowBefore + 2_000) {
      throw new Error("bingx_vst_historical_close_entry_time_invalid");
    }
    const startTs = Math.max(1, Math.floor(entryOrderAt - 60_000));
    const archiveWindows = selectArchiveChain(archiveWindowsAvailable, {
      accountId, startTs, endTs: nowBefore,
    });
    const fills = [];
    const coverage = [];
    let windowStart = startTs;
    for (const window of archiveWindows) {
      fills.push(...window.rawFills.filter((row) => row.symbol === name));
      coverage.push(window.coverage);
      windowStart = window.coverage.endTs;
    }
    if (nowBefore - windowStart > FILL_ARCHIVE_RETENTION_MS) {
      throw new Error("bingx_vst_historical_close_archive_gap_or_history_too_old");
    }
    while (windowStart < nowBefore) {
      const windowEnd = Math.min(nowBefore, windowStart + MAX_HISTORY_WINDOW_MS);
      const history = await api.queryCompleteFillHistory(symbol, {
        startTs: windowStart,
        endTs: windowEnd,
        currency: "USDT",
      });
      if (!history || !Array.isArray(history.fills) || !history.coverage ||
          history.fills.length >= 1_000 ||
          history.coverage.startTs !== windowStart ||
          history.coverage.endTs !== windowEnd) {
        throw new Error("bingx_vst_historical_close_fill_window_unbounded");
      }
      fills.push(...history.fills);
      coverage.push(history.coverage);
      // fillHistory's start bound is exclusive: sharing the boundary places
      // every timestamp in exactly one window without a one-millisecond gap.
      windowStart = windowEnd;
    }
    if ((!ownerPreRunnerReview && fills.length !== 2) || fills.length < 2) {
      throw new Error("bingx_vst_historical_close_fill_history_ambiguous");
    }
    const entryFills = fills.filter((fill) => {
      try { return orderId(fill) === savedEntryId; } catch { return false; }
    });
    const closeIds = new Set(fills.map((fill) => orderId(fill)));
    if (entryFills.length === 0 ||
        (!ownerPreRunnerReview && (entryFills.length !== 1 || closeIds.size !== 2))) {
      throw new Error("bingx_vst_historical_close_order_fills_ambiguous");
    }
    const exitIds = [...closeIds].filter((id) => id !== savedEntryId).sort();
    if (!exitIds.length) throw new Error("bingx_vst_historical_close_order_id_missing");
    const closeOrders = [];
    for (const closeId of exitIds) {
      const queried = await readExactHistoricalOrder(closeId);
      if (!queried || queried.symbol !== name || orderId(queried) !== closeId) {
        throw new Error("bingx_vst_historical_close_close_order_unverified");
      }
      closeOrders.push(queried);
    }
    const stopOrders = [];
    if (ownerPreRunnerReview) {
      const parentIds = new Set();
      for (const order of closeOrders) {
        const linked = [order.triggerOrderId, order.triggerOrderID]
          .filter((id) => id !== undefined && id !== null && id !== "" &&
            id !== 0 && id !== "0")
          .map((id) => exactIdentifier(id, "historical_close_stop_parent_id"));
        for (const fill of fills.filter((row) => orderId(row) === orderId(order))) {
          linked.push(...[fill.triggerOrderId, fill.triggerOrderID]
            .filter((id) => id !== undefined && id !== null && id !== "" &&
              id !== 0 && id !== "0")
            .map((id) => exactIdentifier(id, "historical_close_stop_parent_id")));
        }
        if (new Set(linked).size > 1) {
          throw new Error("bingx_vst_historical_close_stop_parent_ambiguous");
        }
        if (linked.length) parentIds.add(linked[0]);
      }
      const ownedParentIds = new Set([
        snapshot.split?.originalStopOrderId, snapshot.split?.coreStop?.orderId,
        snapshot.split?.runnerStop?.orderId,
      ].filter((id) => typeof id === "string" && id !== ""));
      for (const parentId of [...parentIds].sort()) {
        if (!ownedParentIds.has(parentId)) {
          throw new Error("bingx_vst_historical_close_stop_parent_not_owned");
        }
        // Historical parent configuration is not evidence of an active stop.
        // Exact linked child fills + fresh flat/no-orders prove the exit;
        // the multi-fill verifier independently checks ownership and terms.
        const parent = await readExactHistoricalOrder(parentId, { parentConfiguration: true });
        if (!parent || parent.symbol !== name || orderId(parent) !== parentId) {
          throw new Error("bingx_vst_historical_close_stop_parent_unverified");
        }
        stopOrders.push(parent);
      }
    }
    const closeOrder = closeOrders[0];
    const multiFillReview = ownerPreRunnerReview &&
      (fills.length > 2 || stopOrders.length > 0);
    // Average-price rounding may only use exchange-read contract precision,
    // never a caller-selected tolerance. Read it before the final flat proof.
    const contract = multiFillReview ? await api.contract(symbol) : undefined;
    // The timestamp must conservatively represent when these independent
    // reads began, not when the slower response finished. Completion time is
    // checked separately so slow reads age out instead of looking fresh.
    const observedAtMs = Number(clock());
    const [freshPositions, freshOpenOrders] = await Promise.all([
      // Read the independently validated entire account. A symbol-filtered
      // openOrders response can drift even while the account endpoint works.
      // Never turn an invalid symbol response into an inferred empty array.
      api.getPositions(),
      api.getOpenOrders(),
    ]);
    const proofCompletedAtMs = Number(clock());
    const proof = verifyHistoricalCloseEvidence({
      candidate,
      entryOrder,
      closeOrder,
      ...(multiFillReview ? { closeOrders, stopOrders, contract } : {}),
      fills,
      coverage,
      coverageEndTs: nowBefore,
      ...(archiveWindows.length ? { archiveWindows } : {}),
      freshPositions,
      freshOpenOrders,
      expectedExchangeClientOrderId: deriveVstExchangeClientOrderId(intent.clientOrderId),
      ...(ownerPreRunnerReview ? {
        expectedCloseExchangeClientOrderId:
          deriveVstExchangeClientOrderId(closeIntent.clientOrderId),
      } : {}),
      accountId,
      observedAtMs,
      nowMs: proofCompletedAtMs,
    });
    return { ...proof, entryIntent: intent };
  }

  // Read-only last-trade observation for the fixed +5% take watcher. Returns
  // only rows whose exchange timestamp is fresh; never used for sizing.
  async function readLastPrices(symbols) {
    if (typeof api.getVstLastPrices !== "function") return [];
    const names = new Map();
    for (const symbol of Array.isArray(symbols) ? symbols : []) {
      names.set(assertSymbol(symbol), symbol);
    }
    if (names.size === 0) return [];
    const rows = await api.getVstLastPrices([...names.values()]);
    const now = Number(clock());
    const result = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const symbol = names.get(row?.symbol);
      const observedAt = asMillis(row?.timestamp);
      if (!symbol || observedAt === null || !Number.isSafeInteger(now) ||
          observedAt > now + 2_000 || now - observedAt > 10_000) continue;
      let price;
      try { price = finitePositive(row.lastPrice, "last_price"); } catch { continue; }
      result.push({ verified: true, symbol, price, priceDecimal: String(row.lastPrice),
        observedAt: new Date(Math.min(observedAt, now)).toISOString(), source: "last_trade" });
    }
    return result;
  }

  async function readMarketMark(symbol, { positionRead } = {}) {
    const name = assertSymbol(symbol);
    let provenQuote = null;
    if (object(positionRead)) {
      const proof = positionMarketProofs.get(positionRead);
      // Delete before validation so a stale, mismatched, or otherwise rejected
      // token can never be retried as a reusable market quote.
      positionMarketProofs.delete(positionRead);
      const now = Number(clock());
      if (proof && proof.generation === marketProofGeneration.value &&
          proof.operationId === positionReadOperationId &&
          proof.symbol === name && proof.environment === "vst" &&
          proof.accountId === accountId &&
          positionRead.verified === true &&
          positionRead.environment === proof.environment &&
          positionRead.accountId === proof.accountId &&
          positionRead.symbol === proof.snapshotSymbol &&
          Number.isSafeInteger(now) && now > 0 &&
          proof.observedAt <= now && now - proof.observedAt <= 10_000) {
        provenQuote = proof;
      }
    }
    const mark = provenQuote ?? (typeof api.getVstOpenPositionMark === "function"
      ? await api.getVstOpenPositionMark(symbol)
      : await api.getVstMarkPrice(symbol));
    const observedAt = provenQuote ? provenQuote.observedAt : asMillis(mark?.timestamp);
    const now = Number(clock());
    if ((provenQuote ? provenQuote.symbol : mark?.symbol) !== name ||
        observedAt === null ||
        !Number.isSafeInteger(now) || now <= 0 || observedAt > now ||
        now - observedAt > 10_000) {
      throw new Error("bingx_vst_mark_unverified");
    }
    return {
      verified: true,
      symbol,
      price: provenQuote ? provenQuote.price : finitePositive(mark.markPrice, "mark_price"),
      observedAt: new Date(observedAt).toISOString(),
    };
  }

  async function orderEvidence({
    clientOrderId, phase, request, persistedPosition, historyWindow,
  }) {
    const symbol = request?.symbol;
    const refuse = (condition, inspect, error) => recordProofResult(
      { verified: false, status: "unknown" }, {
        source: "order_reconciliation_proof", condition, symbol,
        sourceSignalId: request?.sourceSignalId, operation: request?.operation,
        check: condition === "entry_protection" ? "protective_stop" : "entry_history",
      }, inspect, error);
    assertSymbol(symbol);
    const exchangeClientId = linkedId(clientOrderId);
    const now = Number(clock());
    if (!Number.isSafeInteger(now) || now <= 0) {
      return refuse("clock", () => ({
        clockValid: evidencePair(true, Number.isSafeInteger(now) && now > 0),
        clockTime: evidencePair(undefined, now, true),
      }));
    }
    let historyOrder;
    const requiresIntentWindow = request?.operation === "close_leg";
    try {
      const range = historyWindow ??
        (requiresIntentWindow ? intentRange(request, now) : historyRange({
          request,
          phase,
          now,
          signalTime: request?.signal?.signalAt,
        }));
      if (!range) {
        return refuse("history_window", () => ({
          historyWindowAvailable: evidencePair(true, false),
          startTime: evidencePair(undefined, asMillis(request?.intentCreatedAt ?? request?.signal?.signalAt), true),
          endTime: evidencePair(undefined, now, true),
        }));
      }
      historyOrder = historyWindow || requiresIntentWindow
        ? await findIntentOrder(symbol, exchangeClientId, range)
        : await findHistoryOrder(symbol, exchangeClientId, range);
    } catch (error) {
      return refuse("read_or_validation_exception", {}, error);
    }
    if (!historyOrder) {
      return refuse("history_found", () => ({
        historyFound: evidencePair(true, false),
        endTime: evidencePair(undefined, now, true),
      }));
    }
    const { order, exchangeOrderId } = historyOrder;
    const terminal = String(order.status ?? "").toUpperCase();
    if (request.operation === "entry") {
      // Already submitted pre-upgrade FOK intents must still reconcile. Only
      // newly reserved requests explicitly marked MARKET can be submitted
      // under the new capability.
      const orderType = request.entryOrderType === "MARKET" ? "MARKET"
        : request.entryOrderType === undefined ? "LIMIT" : null;
      if (!orderType || String(order.side ?? "").toUpperCase() !== "BUY" ||
          order.type !== orderType ||
          orderType === "LIMIT" &&
            order.timeInForce !== undefined && order.timeInForce !== "FOK") {
        return refuse("order_fields", () => ({
          orderTypeValid: evidencePair(true, !!orderType),
          side: evidencePair("BUY", String(order.side ?? "").toUpperCase()),
          orderType: evidencePair(orderType, order.type),
          timeInForce: evidencePair("FOK", order.timeInForce,
            orderType !== "LIMIT" || order.timeInForce === undefined || order.timeInForce === "FOK"),
        }));
      }
    }
    if (request.operation === "close_leg" &&
        (String(order.side ?? "").toUpperCase() !== "SELL" || order.type !== "MARKET")) {
      return refuse("order_fields", () => ({
        side: evidencePair("SELL", String(order.side ?? "").toUpperCase()),
        orderType: evidencePair("MARKET", order.type),
      }));
    }
    let fills;
    try {
      const range = historyWindow ??
        (requiresIntentWindow ? intentRange(request, now) : historyRange({
          request,
          phase,
          now,
          signalTime: request?.signal?.signalAt,
        }));
      if (!range) return refuse("history_window", () => ({
        historyWindowAvailable: evidencePair(true, false),
        endTime: evidencePair(undefined, now, true),
      }));
      fills = await api.queryFills(symbol, {
        ...range,
        orderId: exchangeOrderId,
        currency: request?.operation === "close_leg" ? "VST" : "USDT",
      });
    } catch (error) {
      return refuse("read_or_validation_exception", {}, error);
    }
    let fillsMatchOrder;
    try {
      fillsMatchOrder = Array.isArray(fills) && fills.every((fill) =>
        fill?.symbol === symbolName(symbol) && orderId(fill) === exchangeOrderId);
    } catch (error) {
      recordProofResult({ verified: false, status: "unknown" }, {
        source: "order_reconciliation_proof", condition: "fills_shape", symbol,
        sourceSignalId: request?.sourceSignalId, operation: request?.operation, check: "fills",
      }, () => ({ fillIdentitiesMatch: evidencePair(true, false) }), error);
      fillsMatchOrder = false;
    }
    if (!fillsMatchOrder || !boundedRows(fills)) {
      return refuse("fills_shape", () => ({
        fillsBounded: evidencePair(true, boundedRows(fills)),
        fillIdentitiesMatch: evidencePair(true, fillsMatchOrder),
        fillCount: evidencePair(undefined, Array.isArray(fills) ? fills.length : undefined, true),
        orderId: evidencePair(undefined, exchangeOrderId, true),
        fillSymbol: evidencePair(symbolName(symbol),
          Array.isArray(fills) ? fills.find((row) => row?.symbol !== symbolName(symbol))?.symbol : undefined,
          Array.isArray(fills) && fills.every((row) => row?.symbol === symbolName(symbol))),
        currentOrderIds: evidencePair([exchangeOrderId],
          Array.isArray(fills) ? fills.map((row) => row?.orderId ?? row?.orderID) : undefined, fillsMatchOrder),
      }));
    }
    const executedValue = order.executedQty ?? order.cumExecQty ?? order.filledQty;
    let executed = null;
    try {
      if (executedValue !== undefined && executedValue !== null) {
        executed = strictNumber(executedValue, "executed_quantity", { allowZero: true });
      }
    } catch (error) {
      return refuse("decimal_validation", () => ({
        executedQuantity: evidencePair(undefined, executedValue, false),
      }), error);
    }
    if (["NEW", "PARTIALLY_FILLED", "PENDING", "OPEN"].includes(terminal)) {
      if (fills.length > 0 || executed !== null && executed !== 0) {
        return refuse("terminal_without_fill", () => ({
          orderStatus: evidencePair(undefined, terminal, true),
          fillCount: evidencePair(0, fills.length),
          executedQuantity: evidencePair(0, executed, executed === null || executed === 0),
        }));
      }
      return {
        verified: true, status: "working", exchangeOrderId,
      };
    }
    if (["REJECTED", "EXPIRED", "CANCELED", "CANCELLED"].includes(terminal)) {
      if ((executed === null || executed === 0) && fills.length === 0) {
        return {
          verified: true, status: "rejected", exchangeOrderId,
        };
      }
      return refuse("terminal_without_fill", () => ({
        orderStatus: evidencePair(undefined, terminal, true),
        fillCount: evidencePair(0, fills.length),
        executedQuantity: evidencePair(0, executed, executed === null || executed === 0),
      }));
    }
    if (terminal !== "FILLED") {
      return refuse("order_fields", () => ({
        orderStatus: evidencePair("FILLED", terminal),
      }));
    }
    const expectedSide = request.operation === "entry" ? "BUY"
      : request.operation === "close_leg" ? "SELL" : null;
    let fill;
    try {
      fill = expectedSide
        ? summarizeFills(fills, {
          symbol,
          exchangeOrderId,
          side: expectedSide,
          requireFees: request.operation === "close_leg",
        })
        : null;
    } catch (error) {
      return refuse("fill_summary", () => ({
        fillCount: evidencePair(undefined, fills.length, true),
      }), error);
    }
    if (!fill) {
      return refuse("fill_summary", () => ({
        fillSummaryPresent: evidencePair(true, false),
        fillCount: evidencePair(undefined, fills.length, true),
        side: evidencePair(undefined, expectedSide, !!expectedSide),
        // Presence is not completeness; the summarizer retains final authority.
        fillFeePresent: evidencePair(true, fills.every((row) =>
          [row?.commission, row?.fee, row?.commissionAmount, row?.feeAmount].some((value) => value != null)),
          request.operation !== "close_leg" || fills.every((row) =>
            [row?.commission, row?.fee, row?.commissionAmount, row?.feeAmount].some((value) => value != null))),
      }));
    }
    let requestedQuantity;
    try {
      requestedQuantity = strictNumber(request.quantity, "requested_quantity");
    } catch (error) {
      return refuse("decimal_validation", () => ({
        requestedQuantity: evidencePair(undefined, request.quantity, false),
      }), error);
    }
    if (executed !== null && !closeEnough(fill.quantity, executed, executed) ||
        !closeEnough(fill.quantity, requestedQuantity, requestedQuantity)) {
      return refuse("fill_totals", () => ({
        filledQuantity: evidencePair(requestedQuantity, fill.quantity,
          closeEnough(fill.quantity, requestedQuantity, requestedQuantity)),
        executedQuantity: evidencePair(fill.quantity, executed,
          executed === null || closeEnough(fill.quantity, executed, executed)),
        requestedQuantity: evidencePair(undefined, requestedQuantity, true),
      }));
    }
    const sourceExitDetails = sourceExitCloseDetails(request);
    let position;
    try {
      if (sourceExitDetails) {
        const accountRows = await readGlobalAccountRows();
        if (!verifySourceExitExchangeSnapshot(sourceExitDetails,
          accountRows.positions, accountRows.openOrders, {
            requireActivePosition: false,
          })) {
          return refuse("position_shape", () => ({
            sourceSnapshotValid: evidencePair(true, false),
            activePositionCount: evidencePair(undefined, accountRows.positions?.length, true),
            openOrderCount: evidencePair(undefined, accountRows.openOrders?.length, true),
            positionId: evidencePair(undefined, sourceExitDetails.positionId, true),
          }));
        }
      }
      position = await readPosition(symbol, {
        persistedPosition: sourceExitDetails ? undefined : persistedPosition,
        allowProcessCache: false,
        ...(sourceExitDetails
          ? { sourceExitReadAuthorization: sourceExitReadToken }
          : {}),
      });
    } catch (error) {
      return refuse("read_or_validation_exception", {}, error);
    }
    if (request.operation === "entry") {
      const stop = position.protectiveStops?.core;
      // BingX can report a rounded fill price and a truncated position
      // average (e.g. 0.02870 vs 0.02869 for a 5-decimal contract).
      // Identity, executed quantity, and the independently observed stop
      // still have to match; allow only one contract price tick here.
      const tick = 10 ** -position.pricePrecision;
      const entryPriceMatches = Number.isSafeInteger(position.pricePrecision) &&
        position.pricePrecision >= 0 && position.pricePrecision <= 12 &&
        Math.abs(position.avgPrice - fill.price) <=
          tick + Math.max(Number.EPSILON * Math.max(position.avgPrice, fill.price) * 4, 1e-15);
      if (!position.positionId ||
          !closeEnough(position.quantity, fill.quantity, fill.quantity) ||
          !entryPriceMatches) {
        return refuse("entry_position", () => ({
          positionIdPresent: evidencePair(true, !!position.positionId),
          positionId: evidencePair(undefined, position.positionId, !!position.positionId),
          positionQuantity: evidencePair(fill.quantity, position.quantity,
            closeEnough(position.quantity, fill.quantity, fill.quantity)),
          entryPriceWithinTick: evidencePair(true, entryPriceMatches),
          positionAveragePrice: evidencePair(fill.price, position.avgPrice, entryPriceMatches),
        }));
      }
      if (!stop?.verified || stop.positionId !== position.positionId ||
          !stop.orderId ||
          !closeEnough(stop.quantity, position.quantity, position.quantity) ||
          Number(stop.stopPrice) !== Number(request.stopLoss)) {
        return refuse("entry_protection", () => ({
          coreVerified: evidencePair(true, stop?.verified, !!stop?.verified),
          corePositionId: evidencePair(position.positionId, stop?.positionId),
          coreOrderId: evidencePair(undefined, stop?.orderId, !!stop?.orderId),
          coreQuantity: evidencePair(position.quantity, stop?.quantity,
            closeEnough(stop?.quantity, position.quantity, position.quantity)),
          coreStopPrice: evidencePair(request.stopLoss, stop?.stopPrice,
            Number(stop?.stopPrice) === Number(request.stopLoss)),
        }));
      }
    }
    if (request.operation === "close_leg") {
      const expectedRemaining = Number(request.previousQuantity) - fill.quantity;
      if (!closeEnough(position.quantity, expectedRemaining, request.previousQuantity)) {
        return refuse("close_residual", () => ({
          positionQuantity: evidencePair(expectedRemaining, position.quantity, false),
          previousQuantity: evidencePair(undefined, request.previousQuantity, true),
          filledQuantity: evidencePair(undefined, fill.quantity, true),
        }));
      }
    }
    return {
      verified: true,
      status: "filled",
      exchangeOrderId,
      fill,
      position,
      protectiveStops: position.protectiveStops,
    };
  }

  function sourceExitCloseDetails(request) {
    // Flat source-exit stop cleanup is a distinct cancellation protocol. Its
    // nested marker carries the same request/evidence lineage, but must not be
    // mistaken for the full-position close request handled below; cancellation
    // still follows its own exact-stop and flat-position guards.
    if (request?.operation === "cancel_flat_split_stop" &&
        request?.sourceExit?.stage === "cleanup") {
      return null;
    }
    const marked = request?.sourceExitRequestId !== undefined ||
      request?.sourceExit !== undefined ||
      request?.signal?.patternId === "source_exit";
    if (!marked) return null;
    const sourceExit = request?.sourceExit;
    const evidence = sourceExit?.evidence;
    const prior = request?.priorPosition;
    try {
      const positionIdValue = exactIdentifier(request?.positionId,
        "source_exit_position_id");
      const entryOrderId = exactIdentifier(
        prior?.entryOrderId ?? prior?.split?.entryOrderId,
        "source_exit_entry_order_id",
      );
      const quantity = exactDecimal(request?.quantity, "source_exit_quantity");
      const previousQuantity = exactDecimal(
        request?.previousQuantity, "source_exit_previous_quantity",
      );
      if (request?.operation !== "close_leg" ||
          request?.environment !== "vst" ||
          request?.signal?.patternId !== "source_exit" ||
          typeof request?.sourceSignalId !== "string" ||
          request.sourceSignalId.trim() === "" ||
          typeof request?.symbol !== "string" ||
          !/^[A-Z0-9]{1,20}USDT$/.test(request.symbol) ||
          typeof request?.sourceExitRequestId !== "string" ||
          request.sourceExitRequestId.trim() === "" ||
          sourceExit?.stage !== "close" ||
          sourceExit.requestId !== request.sourceExitRequestId ||
          typeof request?.reason !== "string" ||
          (!["source_withdrawal", "source_closed"].includes(request.reason) &&
            !(request.reason === FULL_TAKE_REASON && fullTakeEvidenceValid(
              evidence, request.sourceSignalId, request.symbol, request.sourceExitRequestId)) &&
            !(request.reason === "source_command_close" && directCloseEvidenceValid(
              evidence, request.sourceSignalId, request.symbol, request.sourceExitRequestId))) ||
          !object(evidence) ||
          evidence.sourceSignalId !== request.sourceSignalId ||
          evidence.symbol !== request.symbol ||
          evidence.reason !== request.reason ||
          typeof evidence.asOf !== "string" ||
            !Number.isFinite(Date.parse(evidence.asOf)) ||
          typeof evidence.observedAt !== "string" ||
            !Number.isFinite(Date.parse(evidence.observedAt)) ||
          typeof evidence.sourceStatus !== "string" ||
          !sourceExitUpdateTimestampValid(evidence, request.reason) ||
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
          !object(prior) ||
          prior.sourceSignalId !== request.sourceSignalId ||
          prior.symbol !== request.symbol ||
          prior.environment !== "vst" ||
          prior.accountId !== accountId ||
          prior.exchangePositionId !== positionIdValue ||
          request.accountId !== accountId ||
          !sameDecimal(quantity, previousQuantity) ||
          quantity.amount <= 0n ||
          canonicalJsonStringify(prior.sourceExitEvidence) !==
            canonicalJsonStringify(evidence) ||
          prior.sourceExitRequestId !== request.sourceExitRequestId ||
          !Array.isArray(request.ownedStops) || request.ownedStops.length === 0) {
        throw new Error("source_exit_close_request_identity_or_evidence_invalid");
      }
      const stops = request.ownedStops.map((stop) => {
        if (!object(stop) ||
            typeof stop.orderId !== "string" || stop.orderId.trim() === "" ||
            stop.positionId !== positionIdValue ||
            ![undefined, "core", "runner", "original"].includes(stop.tranche)) {
          throw new Error("source_exit_close_stop_identity_invalid");
        }
        const stopQuantity = exactDecimal(stop.quantity, "source_exit_stop_quantity");
        const stopPrice = exactDecimal(stop.stopPrice, "source_exit_stop_price");
        if (stopQuantity.amount <= 0n || stopPrice.amount <= 0n) {
          throw new Error("source_exit_close_stop_record_invalid");
        }
        return {
          orderId: stop.orderId,
          positionId: positionIdValue,
          quantity: decimalText(stopQuantity),
          stopPrice: decimalText(stopPrice),
          ...(stop.tranche ? { tranche: stop.tranche } : {}),
        };
      });
      if (new Set(stops.map((stop) => stop.orderId)).size !== stops.length) {
        throw new Error("source_exit_close_stop_ids_ambiguous");
      }
      return {
        sourceExitRequestId: request.sourceExitRequestId,
        sourceSignalId: request.sourceSignalId,
        sourceExit: {
          stage: "close",
          requestId: request.sourceExitRequestId,
          evidence,
        },
        symbol: request.symbol,
        reason: request.reason,
        positionId: positionIdValue,
        quantity: decimalText(quantity),
        entryOrderId,
        stops,
      };
    } catch (error) {
      throw new Error(error instanceof Error
        ? error.message : "source_exit_close_request_invalid");
    }
  }

  function sourceExitCleanupDetails(request) {
    if (request?.operation !== "cancel_flat_split_stop" ||
        request?.sourceExit?.stage !== "cleanup") {
      return null;
    }
    try {
      const details = flatSplitStopCleanupDetails(request);
      const sourceExit = request.sourceExit;
      const evidence = sourceExit.evidence;
      const prior = request.priorPosition;
      const cleanup = prior?.sourceExitCleanup;
      const split = prior?.split;
      const entryOrderId = exactIdentifier(
        prior?.entryOrderId, "source_exit_cleanup_entry_order_id",
      );
      if (!object(evidence) || !object(prior) || !object(cleanup) ||
          !object(split) ||
          typeof sourceExit.requestId !== "string" ||
          sourceExit.requestId.trim() === "" ||
          request.sourceExitRequestId !== undefined &&
            request.sourceExitRequestId !== sourceExit.requestId ||
          typeof request.sourceSignalId !== "string" ||
          request.sourceSignalId !== prior.sourceSignalId ||
          request.symbol !== prior.symbol ||
          request.environment !== "vst" || prior.environment !== "vst" ||
          request.accountId !== accountId || prior.accountId !== accountId ||
          request.positionId !== prior.exchangePositionId ||
          details.positionId !== prior.exchangePositionId ||
          details.entryOrderId !== entryOrderId ||
          split.entryOrderId !== entryOrderId ||
          prior.sourceExitRequestId !== sourceExit.requestId ||
          cleanup.requestId !== sourceExit.requestId ||
          split.stage !== "flat_cleanup_pending" ||
          split.positionId !== details.positionId ||
          evidence.sourceSignalId !== request.sourceSignalId ||
          evidence.symbol !== request.symbol ||
          (!["source_withdrawal", "source_closed"].includes(evidence.reason) &&
            !directCloseEvidenceValid(evidence, request.sourceSignalId, request.symbol,
              sourceExit.requestId)) ||
          (!["source_withdrawal", "source_closed"].includes(prior.sourceExitEvidence?.reason) &&
            !directCloseEvidenceValid(prior.sourceExitEvidence, request.sourceSignalId,
              request.symbol, sourceExit.requestId)) ||
          canonicalJsonStringify(prior.sourceExitEvidence) !==
            canonicalJsonStringify(evidence) ||
          typeof evidence.asOf !== "string" ||
            !Number.isFinite(Date.parse(evidence.asOf)) ||
          typeof evidence.observedAt !== "string" ||
            !Number.isFinite(Date.parse(evidence.observedAt)) ||
          typeof evidence.sourceStatus !== "string" ||
          !sourceExitUpdateTimestampValid(evidence, evidence.reason) ||
          !(evidence.sourceClosedAt === null ||
            typeof evidence.sourceClosedAt === "string" &&
              Number.isFinite(Date.parse(evidence.sourceClosedAt))) ||
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
          !Array.isArray(cleanup.remainingKnownStopOrderIds) ||
          !Array.isArray(split.remainingKnownStopOrderIds) ||
          !Array.isArray(split.flatCleanupStops)) {
        return null;
      }
      const expectedIds = details.knownRemainingStopOrderIds.slice().sort();
      if (canonicalJsonStringify(expectedIds) !==
            canonicalJsonStringify(cleanup.remainingKnownStopOrderIds.slice().sort()) ||
          canonicalJsonStringify(expectedIds) !==
            canonicalJsonStringify(split.remainingKnownStopOrderIds.slice().sort())) {
        return null;
      }
      const stops = split.flatCleanupStops.map((stop) => {
        if (!object(stop) ||
            typeof stop.orderId !== "string" ||
            stop.positionId !== details.positionId) {
          throw new Error("source_exit_cleanup_stop_identity_invalid");
        }
        const quantity = exactDecimal(stop.quantity, "source_exit_cleanup_stop_quantity");
        const stopPrice = exactDecimal(stop.stopPrice, "source_exit_cleanup_stop_price");
        if (quantity.amount <= 0n || stopPrice.amount <= 0n) {
          throw new Error("source_exit_cleanup_stop_record_invalid");
        }
        return {
          orderId: stop.orderId,
          positionId: details.positionId,
          quantity: decimalText(quantity),
          stopPrice: decimalText(stopPrice),
        };
      });
      if (new Set(stops.map((stop) => stop.orderId)).size !== stops.length ||
          canonicalJsonStringify(stops.map((stop) => stop.orderId).sort()) !==
            canonicalJsonStringify(expectedIds)) {
        return null;
      }
      const target = stops.find((stop) =>
        stop.orderId === details.stopToCancel.orderId);
      if (!target ||
          !sameDecimal(exactDecimal(target.quantity, "source_exit_cleanup_stop_quantity"),
            exactDecimal(details.stopToCancel.quantity,
              "source_exit_cleanup_target_quantity")) ||
          !sameDecimal(exactDecimal(target.stopPrice, "source_exit_cleanup_stop_price"),
            exactDecimal(details.stopToCancel.stopPrice,
              "source_exit_cleanup_target_price"))) {
        return null;
      }
      return {
        ...details,
        stops,
        requestId: sourceExit.requestId,
      };
    } catch {
      return null;
    }
  }

  function verifySourceExitCleanupSnapshot(details, positions, orders) {
    const name = symbolName(details.symbol);
    if (!Array.isArray(positions) || !Array.isArray(orders)) return false;
    const active = positions.filter((row) =>
      row?.symbol === name && Number(row.positionAmt) !== 0);
    if (active.length !== 0) return false;
    const symbolOrders = orders.filter((order) => order?.symbol === name);
    let ids;
    try {
      ids = symbolOrders.map((order) => orderId(order)).sort();
    } catch {
      return false;
    }
    const expectedIds = details.knownRemainingStopOrderIds.slice().sort();
    if (canonicalJsonStringify(ids) !== canonicalJsonStringify(expectedIds)) {
      return false;
    }
    return symbolOrders.every((order) => {
      const expected = details.stops.find((stop) => {
        try {
          return orderId(order) === stop.orderId;
        } catch {
          return false;
        }
      });
      return expected && exactFlatStopOrder(order, {
        symbol: details.symbol,
        positionId: details.positionId,
        stop: expected,
      });
    });
  }

  function verifySourceExitExchangeSnapshot(details, positions, orders, {
    requireActivePosition,
  }) {
    const name = symbolName(details.symbol);
    if (!Array.isArray(positions) || !Array.isArray(orders)) return false;
    const active = positions.filter((row) =>
      row?.symbol === name && Number(row.positionAmt) !== 0);
    if (requireActivePosition) {
      if (active.length !== 1 || active[0].positionSide !== "LONG" ||
          positionId(active[0]) !== details.positionId ||
          !sameDecimal(exactDecimal(active[0].positionAmt,
            "source_exit_exchange_quantity"),
          exactDecimal(details.quantity, "source_exit_requested_quantity"))) {
        return false;
      }
    } else if (active.length !== 0) {
      return false;
    }
    const symbolOrders = orders.filter((order) => order?.symbol === name);
    const expectedById = new Map(details.stops.map((stop) => [stop.orderId, stop]));
    if (symbolOrders.length > details.stops.length ||
        requireActivePosition && symbolOrders.length !== details.stops.length) {
      return false;
    }
    const seen = new Set();
    for (const order of symbolOrders) {
      try {
        const id = orderId(order);
        const expected = expectedById.get(id);
        const parents = [order.mainOrderId, order.parentOrderId]
          .filter((value) => value !== undefined && value !== null && value !== "")
          .map((value) => exactIdentifier(value, "source_exit_stop_parent_id"));
        if (!expected || seen.has(id) || order.type !== "STOP_MARKET" ||
            order.status !== "NEW" || order.side !== "SELL" ||
            order.positionSide !== "LONG" || order.workingType !== "MARK_PRICE" ||
            positionId(order) !== details.positionId ||
            !sameDecimal(exactDecimal(order.origQty ?? order.quantity,
              "source_exit_exchange_stop_quantity"),
            exactDecimal(expected.quantity, "source_exit_expected_stop_quantity")) ||
            !sameDecimal(exactDecimal(order.stopPrice,
              "source_exit_exchange_stop_price"),
            exactDecimal(expected.stopPrice, "source_exit_expected_stop_price")) ||
            parents.some((parent) => parent !== details.entryOrderId) ||
            new Set(parents).size > 1) {
          return false;
        }
        seen.add(id);
      } catch {
        return false;
      }
    }
    return requireActivePosition
      ? seen.size === details.stops.length
      : true;
  }

  async function reconcileRaiseStopByNativeId(request, exchangeOrderId) {
    const refuse = (condition, checks = {}, error) =>
      recordProofResult({ verified: false, status: "unknown" }, {
        source: "order_reconciliation_proof",
        condition,
        symbol: request?.symbol,
        sourceSignalId: request?.sourceSignalId,
        operation: "raise_stop",
        check: "protective_stop",
      }, () => checks, error);
    try {
      if (request?.leg !== "core") {
        return refuse("request_identity", {
          orderTypeValid: evidencePair(true, request?.leg === "core"),
        });
      }
      const persisted = positionSnapshotFromRequest(request);
      const prior = request?.priorPosition;
      const oldStop = prior?.verifiedProtectiveStops?.core;
      const proof = request?.entryProof;
      const quantity = decimalText(exactDecimal(
        request.quantity ?? request.previousQuantity, "raise_stop_expected_quantity",
      ));
      const expectedQuantity = exactDecimal(quantity, "raise_stop_expected_quantity");
      const priorQuantityValues = [
        prior?.quantity,
        prior?.remainingQty,
        prior?.coreQty,
        prior?.coreStopQuantity,
        oldStop?.quantity ?? oldStop?.origQty,
        request.quantity,
        request.previousQuantity,
      ].filter((value) => value !== undefined && value !== null);
      const consistentPriorQuantity = priorQuantityValues.length >= 4 &&
        priorQuantityValues.every((value) =>
          sameDecimal(exactDecimal(value, "raise_stop_prior_quantity"), expectedQuantity));
      const decimalAliasesAgree = (value, keys, expected) => {
        const values = keys.map((key) => value?.[key])
          .filter((item) => item !== undefined && item !== null);
        return values.length > 0 && values.every((item) =>
          sameDecimal(exactDecimal(item, "raise_stop_quantity_alias"),
            expected));
      };
      const aliasesAgree = (value, keys) => {
        const values = keys.map((key) => value?.[key])
          .filter((item) => item !== undefined && item !== null);
        return values.length > 0 && values.every((item) => String(item) === String(values[0]));
      };
      const nativeStopId = exactIdentifier(exchangeOrderId,
        "raise_stop_exchange_order_id");
      const context = persisted ?? (() => {
        const priorPositionIdValues = [
          prior?.exchangePositionId, prior?.positionId,
          prior?.coreStopPositionId, oldStop?.positionId, oldStop?.positionID,
          request?.positionId, proof?.positionId,
        ].filter((value) => value !== undefined && value !== null);
        const oldStopIds = [
          prior?.coreStopOrderId, oldStop?.orderId, oldStop?.orderID,
        ].filter((value) => value !== undefined && value !== null);
        const oldStopQuantity = oldStop?.quantity ?? oldStop?.origQty;
        const oldStopPrice = oldStop?.stopPrice;
        const previousStopPrices = [
          prior?.coreStopPrice, prior?.stopPrice, request?.previousStopPrice,
          oldStopPrice,
        ].filter((value) => value !== undefined && value !== null);
        const coherentPreviousStopPrice = previousStopPrices.length > 0 &&
          previousStopPrices.every((value) => sameDecimal(
            exactDecimal(value, "raise_stop_prior_price"),
            exactDecimal(oldStopPrice, "raise_stop_old_stop_price")));
        const sourceConsistent = typeof request?.sourceSignalId === "string" &&
          request.sourceSignalId.length > 0 &&
          prior?.sourceSignalId === request.sourceSignalId &&
          (proof?.sourceSignalId === undefined ||
            proof.sourceSignalId === request.sourceSignalId);
        const historicalPolicyVerified =
          object(prior) && prior.environment === "vst" &&
          prior.accountId === accountId && prior.symbol === request.symbol &&
          prior.status === "open" && prior.coreOpen === true &&
          prior.runnerOpen === false &&
          (prior.runnerQty === undefined || prior.runnerQty === null ||
            sameDecimal(exactDecimal(prior.runnerQty,
              "raise_stop_prior_runner_quantity", { allowZero: true }),
            exactDecimal("0", "raise_stop_zero", { allowZero: true }))) &&
          (prior.split == null ||
            prior.split.stage === "complete" &&
            prior.split.activeLegs?.length === 1 &&
            prior.split.activeLegs[0] === "core") &&
          prior.exchangePositionId !== undefined &&
          prior.exchangePositionId !== null &&
          prior.coreStopPositionId !== undefined &&
          prior.coreStopPositionId !== null &&
          object(oldStop) && oldStop.verified === true &&
          (oldStop.tranche === undefined || oldStop.tranche === "core") &&
          oldStopIds.length === 2 && new Set(oldStopIds.map(String)).size === 1 &&
          oldStopIds[0] === prior.coreStopOrderId &&
          priorPositionIdValues.length >= 4 &&
          new Set(priorPositionIdValues.map(String)).size === 1 &&
          sourceConsistent && consistentPriorQuantity &&
          decimalAliasesAgree(oldStop, ["quantity", "origQty"], expectedQuantity) &&
          coherentPreviousStopPrice &&
          aliasesAgree(prior, ["exchangePositionId", "positionId"]) &&
          aliasesAgree(oldStop, ["positionId", "positionID"]) &&
          aliasesAgree(oldStop, ["orderId", "orderID"]) &&
          sameDecimal(exactDecimal(oldStopQuantity,
            "raise_stop_old_stop_quantity"), expectedQuantity) &&
          oldStopPrice !== undefined &&
          compareDecimal(exactDecimal(request.stopPrice,
            "raise_stop_requested_price"), exactDecimal(oldStopPrice,
            "raise_stop_old_stop_price")) > 0 &&
          typeof proof?.entryClientOrderId === "string" &&
          proof.entryClientOrderId.length > 0 &&
          (request.entryClientOrderId === undefined ||
            request.entryClientOrderId === proof.entryClientOrderId) &&
          (request.entryOrderId === undefined ||
            exactIdentifier(request.entryOrderId, "raise_stop_entry_order_id") ===
              exactIdentifier(proof.entryOrderId, "raise_stop_entry_proof_order_id")) &&
          (request.entryQuantity === undefined ||
            sameDecimal(exactDecimal(request.entryQuantity,
              "raise_stop_entry_quantity"),
            exactDecimal(proof?.quantity, "raise_stop_entry_proof_quantity"))) &&
          (request.entryOrderType === undefined ||
            request.entryOrderType === proof.entryOrderType);
        if (!historicalPolicyVerified) return null;
        return {
          verified: true,
          environment: "vst",
          accountId,
          symbol: request.symbol,
          positionId: exactIdentifier(priorPositionIdValues[0],
            "raise_stop_context_position_id"),
          quantity,
          protectiveStops: {
            core: {
              verified: true,
              tranche: "core",
              positionId: exactIdentifier(priorPositionIdValues[0],
                "raise_stop_context_position_id"),
              orderId: exactIdentifier(oldStopIds[0],
                "raise_stop_old_stop_id"),
              quantity: String(oldStopQuantity),
              stopPrice: String(oldStopPrice),
            },
          },
        };
      })();
      if (!object(context) || context.verified !== true ||
          context.environment !== "vst" || context.accountId !== accountId ||
          context.symbol !== request.symbol ||
          request?.environment !== "vst" || request?.accountId !== accountId ||
          !validAccountAlias(request.accountId) ||
          !context.protectiveStops?.core?.verified ||
          !sameDecimal(exactDecimal(context.quantity, "raise_stop_context_quantity"),
            expectedQuantity) ||
          request.positionId !== context.positionId ||
          proof?.positionId !== context.positionId ||
          context.protectiveStops.core.positionId !== context.positionId ||
          !sameDecimal(exactDecimal(context.protectiveStops.core.quantity,
            "raise_stop_context_stop_quantity"), expectedQuantity) ||
          typeof request.stopPrice !== "string" && typeof request.stopPrice !== "number") {
        return refuse("request_identity", {
          sourceSnapshotValid: evidencePair(true, object(persisted)),
          positionIdsMatch: evidencePair(true, false),
          quantityAliasesAgree: evidencePair(true, false),
        });
      }
      const contextPositionId = exactIdentifier(context.positionId,
        "raise_stop_context_position_id");
      const name = symbolName(request.symbol);
      const oldStopId = exactIdentifier(
        context.protectiveStops.core.orderId, "raise_stop_old_stop_id",
      );
      const oldStopQuantity = exactDecimal(
        context.protectiveStops.core.quantity, "raise_stop_old_stop_quantity",
      );
      const oldStopPrice = exactDecimal(
        context.protectiveStops.core.stopPrice, "raise_stop_old_stop_price",
      );
      const requestedStopPrice = exactDecimal(
        request.stopPrice, "raise_stop_requested_price",
      );
      const [queriedStop, queriedOldStop] = await Promise.all([
        api.queryOrder(request.symbol, { orderId: nativeStopId }),
        api.queryOrder(request.symbol, { orderId: oldStopId }),
      ]);
      const aliases = (row, keys) => {
        if (keys.some((key) => Object.hasOwn(row ?? {}, key) &&
            (row[key] === undefined || row[key] === null))) return false;
        const values = keys.map((key) => row?.[key])
          .filter((value) => value !== undefined && value !== null);
        return values.length > 0 && values.every((value) => String(value) === String(values[0]));
      };
      const strictOrderQuantity = (row, label) => {
        if (["origQty", "quantity"].some((key) =>
          Object.hasOwn(row ?? {}, key) &&
          (row[key] === undefined || row[key] === null))) return false;
        const values = [row?.origQty, row?.quantity]
          .filter((value) => value !== undefined && value !== null);
        return values.length > 0 && values.every((value) =>
          sameDecimal(exactDecimal(value, label), expectedQuantity)) &&
          values.every((value) => sameDecimal(exactDecimal(value, label),
            exactDecimal(values[0], label)));
      };
      const strictExecutionZero = (row) =>
        Object.hasOwn(row ?? {}, "executedQty") &&
        row.executedQty !== undefined && row.executedQty !== null &&
        EXECUTION_QUANTITY_ALIASES.every((field) =>
          !Object.hasOwn(row, field) ||
          row[field] !== undefined && row[field] !== null &&
          sameDecimal(exactDecimal(row[field],
            "raise_stop_execution_quantity", { allowZero: true }),
          exactDecimal("0", "raise_stop_zero", { allowZero: true })));
      const strictActiveOrder = (row, allowUnavailablePositionId = false) => object(row) &&
        row.symbol === name && aliases(row, ["orderId", "orderID"]) &&
        orderId(row) === nativeStopId &&
        row.type === "STOP_MARKET" && row.status === "NEW" &&
        row.side === "SELL" && row.positionSide === "LONG" &&
        row.workingType === "MARK_PRICE" &&
        aliases(row, ["positionId", "positionID"]) &&
        (positionId(row) === contextPositionId ||
          allowUnavailablePositionId &&
            [row.positionId, row.positionID].filter((value) =>
              value !== undefined && value !== null)
              .every((value) => value === 0 || value === "0")) &&
        strictOrderQuantity(row, "raise_stop_active_quantity") &&
        row.stopPrice !== undefined &&
        compareDecimal(exactDecimal(row.stopPrice, "raise_stop_active_price"),
          requestedStopPrice) >= 0 &&
        strictExecutionZero(row) &&
        (() => {
          const parents = [
            row.mainOrderId, row.mainOrderID,
            row.parentOrderId, row.parentOrderID,
          ]
            .filter((value) => value !== undefined && value !== null && value !== "");
          return parents.every((value) =>
            exactIdentifier(value, "raise_stop_active_parent_id") ===
              exactIdentifier(proof.entryOrderId, "raise_stop_entry_proof_order_id")) &&
            new Set(parents.map(String)).size <= 1;
        })();
      const queryPositionIds = [
        queriedStop?.positionId, queriedStop?.positionID,
      ].filter((value) => value !== undefined && value !== null);
      const queryHasConcretePositionId = queryPositionIds.some((value) =>
        value !== 0 && value !== "0");
      if (!strictActiveOrder(queriedStop, true) ||
          queryHasConcretePositionId &&
            (new Set(queryPositionIds.map(String)).size !== 1 ||
             positionId(queriedStop) !== contextPositionId)) {
        return refuse("queried_stop_fields", {
          orderFound: evidencePair(true,
            object(queriedStop) &&
            aliases(queriedStop, ["orderId", "orderID"]) &&
            orderId(queriedStop) === nativeStopId),
          orderTypeValid: evidencePair(true, strictActiveOrder(queriedStop)),
          positionIdsMatch: evidencePair(true,
            !queryHasConcretePositionId ||
            queryPositionIds.every((value) => String(value) === contextPositionId)),
        });
      }
      // Historical policy dimensions establish what the old protection was;
      // only an exact, independently queried canceled parent may bridge to
      // the submitted stop found in the final fresh account pair.
      const oldExecutionZero = strictExecutionZero(queriedOldStop);
      const oldStatusCanceled = ["CANCELED", "CANCELLED"].includes(queriedOldStop?.status);
      const oldStopExact = object(queriedOldStop) && queriedOldStop.symbol === name &&
        aliases(queriedOldStop, ["orderId", "orderID"]) &&
        orderId(queriedOldStop) === oldStopId &&
        queriedOldStop.type === "STOP_MARKET" && queriedOldStop.side === "SELL" &&
        queriedOldStop.positionSide === "LONG" &&
        queriedOldStop.workingType === "MARK_PRICE" &&
        aliases(queriedOldStop, ["positionId", "positionID"]) &&
        positionId(queriedOldStop) === contextPositionId &&
        oldStatusCanceled && oldExecutionZero &&
        strictOrderQuantity(queriedOldStop,
          "raise_stop_old_lookup_quantity") &&
        sameDecimal(exactDecimal(queriedOldStop.origQty ?? queriedOldStop.quantity,
          "raise_stop_old_lookup_quantity"), oldStopQuantity) &&
        sameDecimal(exactDecimal(queriedOldStop.stopPrice,
          "raise_stop_old_lookup_price"), oldStopPrice);
      if (!oldStopExact) {
        return refuse("terminal_without_fill", {
          orderFound: evidencePair(true,
            object(queriedOldStop) &&
            aliases(queriedOldStop, ["orderId", "orderID"]) &&
            orderId(queriedOldStop) === oldStopId),
          executionZero: evidencePair(true, oldExecutionZero),
          orderTypeValid: evidencePair(true, oldStopExact),
        });
      }
      const rawClientOrderId = proof?.entryClientOrderId ??
        request.entryClientOrderId;
      const entry = await verifyEntryIdentityAndFills({
        symbol: request.symbol,
        rawClientOrderId,
        expectedPositionId: contextPositionId,
        request,
      });
      if (entry.exchangeOrderId !== proof?.entryOrderId ||
          !sameDecimal(exactDecimal(entry.fill.quantity,
            "raise_stop_entry_fill_quantity"),
          exactDecimal(proof?.quantity, "raise_stop_entry_proof_quantity"))) {
        return refuse("fill_summary", {
          fillIdentitiesMatch: evidencePair(true, false),
        });
      }
      // One new independent native snapshot supplies BOTH strict raw-row
      // checks and normalized settings/protection checks. Previously these
      // were two consecutive snapshots, duplicating five mutable reads.
      const finalPairStartedAt = Number(clock());
      if (!Number.isSafeInteger(finalPairStartedAt) || finalPairStartedAt <= 0) {
        return refuse("clock");
      }
      const verifiedPosition = await readPosition(request.symbol, {
        allowProcessCache: false,
      });
      const rawEvidence = positionRawReadEvidence.get(verifiedPosition);
      positionRawReadEvidence.delete(verifiedPosition);
      if (!rawEvidence) return refuse("native_snapshot_evidence_missing");
      const settings = rawEvidence.settings;
      const longLeverage = strictNumber(settings?.leverage?.longLeverage,
        "raise_stop_settings_long_leverage");
      if (settings?.mode !== "HEDGE" ||
          settings?.marginMode !== PROFILE_MARGIN ||
          longLeverage !== PROFILE_LEVERAGE) {
        return refuse("position_settings", {
          positionMode: evidencePair("HEDGE", settings?.mode),
          marginMode: evidencePair(PROFILE_MARGIN, settings?.marginMode),
          leverage: evidencePair(PROFILE_LEVERAGE, longLeverage),
        });
      }
      // The earlier native lookups and immutable history are not current
      // position/order evidence. Measure the new snapshot's real acquisition
      // time, not a timestamp assigned after its requests have completed.
      const { rows: positions, orders } = rawEvidence;
      const finalPairFinishedAt = Number(clock());
      if (!Number.isSafeInteger(finalPairFinishedAt) ||
          finalPairFinishedAt < finalPairStartedAt ||
          finalPairFinishedAt - finalPairStartedAt > 10_000) {
        return refuse("clock", {
          clockTime: evidencePair(10_000,
            Number.isSafeInteger(finalPairFinishedAt)
              ? finalPairFinishedAt - finalPairStartedAt : "unreadable"),
        });
      }
      const active = Array.isArray(positions) ? positions.filter((row) =>
        row?.symbol === name &&
        strictNumber(row.positionAmt, "raise_stop_position_quantity",
          { allowZero: true }) !== 0) : [];
      if (active.length !== 1 || active[0].positionSide !== "LONG" ||
          !aliases(active[0], ["positionId", "positionID"]) ||
          positionId(active[0]) !== contextPositionId ||
          !sameDecimal(exactDecimal(active[0].positionAmt,
            "raise_stop_position_quantity"),
          expectedQuantity) ||
          Object.hasOwn(active[0], "leverage") &&
            strictNumber(active[0].leverage,
              "raise_stop_native_position_leverage") !== PROFILE_LEVERAGE ||
          ["marginMode", "marginType"].some((field) =>
            Object.hasOwn(active[0], field) &&
            !profileMarginIs(active[0][field])) ||
          !Array.isArray(orders) || orders.length !== 1 ||
          !strictActiveOrder(orders?.[0])) {
        return refuse("position_shape", {
          activePositionCount: evidencePair(1, active.length),
          positionIdsMatch: evidencePair(true,
            active.length === 1 && active[0].positionSide === "LONG" &&
            aliases(active[0], ["positionId", "positionID"]) &&
            positionId(active[0]) === contextPositionId &&
            sameDecimal(exactDecimal(active[0].positionAmt,
              "raise_stop_position_quantity"), expectedQuantity)),
          openOrderCount: evidencePair(1,
            Array.isArray(orders) ? orders.length : "unreadable"),
          orderFound: evidencePair(true,
            Array.isArray(orders) && orders.length === 1 &&
            strictActiveOrder(orders[0])),
        });
      }
      const rawStop = orders[0];
      if (!sameDecimal(exactDecimal(queriedStop.stopPrice,
        "raise_stop_query_price"),
      exactDecimal(rawStop.stopPrice, "raise_stop_raw_price"))) {
        return refuse("queried_stop_fields", {
          priceAliasesAgree: evidencePair(true, false),
        });
      }
      // The raw identity checks and normalized protection must belong to that
      // same fresh read, never to a cached or caller-authored snapshot.
      const verifiedPositionAt = Number(clock());
      const verifiedCoreStop = verifiedPosition?.protectiveStops?.core;
      if (!Number.isSafeInteger(verifiedPositionAt) ||
          verifiedPosition?.verified !== true ||
          verifiedPosition.positionMode !== "HEDGE" ||
          verifiedPosition.marginMode !== PROFILE_MARGIN ||
          Number(verifiedPosition.leverage) !== PROFILE_LEVERAGE ||
          verifiedPosition.positionId !== contextPositionId ||
          !sameDecimal(exactDecimal(verifiedPosition.quantity,
            "raise_stop_verified_position_quantity"), expectedQuantity) ||
          verifiedCoreStop?.verified !== true ||
          verifiedCoreStop.orderId !== nativeStopId ||
          verifiedCoreStop.positionId !== contextPositionId ||
          !sameDecimal(exactDecimal(verifiedCoreStop.quantity,
            "raise_stop_verified_stop_quantity"), expectedQuantity) ||
          !sameDecimal(exactDecimal(verifiedCoreStop.stopPrice,
            "raise_stop_verified_stop_price"),
          exactDecimal(rawStop.stopPrice, "raise_stop_raw_price"))) {
        return refuse("position_settings_or_stop_changed", {
          positionSettingsValid: evidencePair(true,
            verifiedPosition?.verified === true &&
            verifiedPosition.positionMode === "HEDGE" &&
            verifiedPosition.marginMode === PROFILE_MARGIN &&
            Number(verifiedPosition.leverage) === PROFILE_LEVERAGE),
          positionIdentityMatches: evidencePair(contextPositionId,
            verifiedPosition?.positionId),
          stopIdentityMatches: evidencePair(nativeStopId,
            verifiedCoreStop?.orderId),
        });
      }
      const persistedPosition = {
        verified: true,
        environment: "vst",
        accountId,
        symbol: request.symbol,
        positionId: contextPositionId,
        quantity,
        protectiveStops: {
          core: {
            verified: true,
            tranche: "core",
            positionId: contextPositionId,
            orderId: nativeStopId,
            quantity: String(rawStop.origQty ?? rawStop.quantity),
            stopPrice: String(rawStop.stopPrice),
          },
        },
      };
      const position = {
        verified: true,
        symbol: request.symbol,
        side: "Buy",
        quantity: strictNumber(active[0].positionAmt,
          "raise_stop_position_quantity"),
        avgPrice: strictNumber(active[0].avgPrice ?? active[0].entryPrice,
          "raise_stop_average_price"),
        positionMode: settings.mode,
        positionId: contextPositionId,
        leverage: verifiedPosition.leverage,
        marginMode: verifiedPosition.marginMode,
        protectiveStops: persistedPosition.protectiveStops,
        persistedSnapshot: persistedPosition,
        currentProtectionObservedAt: verifiedPositionAt,
      };
      if (!sameDecimal(oldStopPrice, requestedStopPrice) &&
          compareDecimal(exactDecimal(rawStop.stopPrice,
            "raise_stop_final_price"), requestedStopPrice) < 0) {
        return refuse("stop_details", {
          stopPrice: evidencePair(request.stopPrice, rawStop.stopPrice),
        });
      }
      return {
        verified: true,
        status: "filled",
        exchangeOrderId: nativeStopId,
        position,
        protectiveStops: position.protectiveStops,
        currentProtectionObservedAt: verifiedPositionAt,
      };
    } catch (error) {
      return refuse("read_or_validation_exception", {
        evidenceVerified: evidencePair(true, false),
      }, error);
    }
  }

  async function proveAdoptedStopPair(request, {
    oldStop: oldSpec,
    adoptedStop: adoptedSpec,
    requireOldCanceled = false,
    requireCandidateTimestamp = false,
  }) {
    const failed = { verified: false, status: "unknown" };
    const name = symbolName(request.symbol);
    const positionValue = exactIdentifier(
      request.positionId ?? oldSpec?.positionId ?? adoptedSpec?.positionId,
      "adopted_stop_position_id",
    );
    const quantity = exactDecimal(
      request.quantity ?? request.previousQuantity ??
        adoptedSpec?.quantity ?? adoptedSpec?.origQty ?? oldSpec?.quantity ?? oldSpec?.origQty,
      "adopted_stop_quantity",
    );
    const oldId = exactIdentifier(oldSpec?.orderId ?? oldSpec?.orderID,
      "adopted_old_stop_id");
    const candidateId = exactIdentifier(adoptedSpec?.orderId ?? adoptedSpec?.orderID,
      "adopted_new_stop_id");
    const oldPrice = exactDecimal(oldSpec?.stopPrice, "adopted_old_stop_price");
    const candidatePrice = exactDecimal(adoptedSpec?.stopPrice,
      "adopted_new_stop_price");
    const proof = request.entryProof;
    const entryId = exactIdentifier(proof?.entryOrderId, "adopted_entry_order_id");
    const createdAt = Number(request.intentCreatedAt);
    const initialStartedAt = Number(clock());
    if (oldId === candidateId || !Number.isSafeInteger(initialStartedAt) ||
        requireCandidateTimestamp &&
          (!Number.isSafeInteger(createdAt) || createdAt <= 0 ||
           initialStartedAt < createdAt)) return failed;

    const aliasesAgree = (row, fields, { require = true } = {}) => {
      if (fields.some((field) => Object.hasOwn(row ?? {}, field) &&
          (row[field] === undefined || row[field] === null))) return false;
      const values = fields.map((field) => row?.[field])
        .filter((value) => value !== undefined && value !== null);
      return (!require || values.length > 0) &&
        values.every((value) => String(value) === String(values[0]));
    };
    const exactQty = (row) => {
      const fields = ["origQty", "quantity"];
      if (fields.some((field) => Object.hasOwn(row ?? {}, field) &&
          (row[field] === undefined || row[field] === null))) return false;
      const values = fields.map((field) => row?.[field])
        .filter((value) => value !== undefined && value !== null);
      return values.length > 0 && values.every((value) =>
        sameDecimal(exactDecimal(value, "adopted_stop_exchange_quantity"), quantity));
    };
    const zeroExecutions = (row) =>
      Object.hasOwn(row ?? {}, "executedQty") &&
      row.executedQty !== undefined && row.executedQty !== null &&
      ["executedQty", "cumExecQty", "dealSize", "filledQty", "executedQuantity"]
        .every((field) => !Object.hasOwn(row, field) ||
          row[field] !== undefined && row[field] !== null &&
          sameDecimal(exactDecimal(row[field], "adopted_stop_execution",
            { allowZero: true }), exactDecimal("0", "adopted_stop_zero",
            { allowZero: true })));
    const exactStop = (row, spec, id, price, status, { allowZeroPositionId = false } = {}) => {
      const positionAliases = [row?.positionId, row?.positionID]
        .filter((value) => value !== undefined && value !== null);
      const queryPositionIsZero = positionAliases.length > 0 &&
        positionAliases.every((value) => value === 0 || value === "0");
      const rowPositionMatches = allowZeroPositionId && queryPositionIsZero ||
        !queryPositionIsZero && positionId(row) === positionValue;
      if (!object(row) || row.symbol !== name ||
          !aliasesAgree(row, ["orderId", "orderID"]) || orderId(row) !== id ||
          row.type !== "STOP_MARKET" || row.status !== status ||
          row.side !== "SELL" || row.positionSide !== "LONG" ||
          row.workingType !== "MARK_PRICE" ||
          !aliasesAgree(row, ["positionId", "positionID"]) ||
          !rowPositionMatches || !exactQty(row) ||
          !sameDecimal(exactDecimal(row.stopPrice, "adopted_stop_exchange_price"), price) ||
          !zeroExecutions(row)) return false;
      const parents = [
        row.mainOrderId, row.mainOrderID, row.parentOrderId, row.parentOrderID,
      ].filter((value) => value !== undefined && value !== null && value !== "");
      if (parents.some((value) =>
        exactIdentifier(value, "adopted_stop_parent_id") !== entryId) ||
          new Set(parents.map(String)).size > 1) return false;
      if (requireCandidateTimestamp && spec === adoptedSpec) {
        const created = [row.time, row.createTime, row.createdTime, row.orderTime]
          .map(asMillis).find((value) => Number.isSafeInteger(value) && value > 0);
        if (!created || created < createdAt - 2_000 || created > createdAt + 60_000) {
          return false;
        }
      }
      return true;
    };
    const positionExact = (rows) => {
      if (!Array.isArray(rows)) return false;
      const active = rows.filter((row) => row?.symbol === name &&
        strictNumber(row.positionAmt, "adopted_stop_position_quantity",
          { allowZero: true }) !== 0);
      return active.length === 1 && active[0].positionSide === "LONG" &&
        aliasesAgree(active[0], ["positionId", "positionID"]) &&
        positionId(active[0]) === positionValue &&
        sameDecimal(exactDecimal(active[0].positionAmt,
          "adopted_stop_position_quantity"), quantity) &&
        (!Object.hasOwn(active[0], "leverage") ||
          strictNumber(active[0].leverage, "adopted_stop_leverage") === PROFILE_LEVERAGE) &&
        !["marginMode", "marginType"].some((field) =>
          Object.hasOwn(active[0], field) && !profileMarginIs(active[0][field]));
    };
    const [initialPositions, initialOrders] = await Promise.all([
      api.getPositions(request.symbol), api.getOpenOrders(request.symbol),
    ]);
    const initialFinishedAt = Number(clock());
    const wantedOldStatus = requireOldCanceled ? ["CANCELED", "CANCELLED"] : ["NEW"];
    const symbolOrders = Array.isArray(initialOrders)
      ? initialOrders.filter((row) => row?.symbol === name) : [];
    const expectedCount = requireOldCanceled ? 1 : 2;
    const oldPresent = requireOldCanceled
      ? !symbolOrders.some((row) => {
        try { return orderId(row) === oldId; } catch { return true; }
      })
      : symbolOrders.filter((row) => {
        try { return orderId(row) === oldId; } catch { return false; }
      }).length === 1;
    const candidatePresent = symbolOrders.filter((row) => {
      try { return orderId(row) === candidateId; } catch { return false; }
    }).length === 1;
    if (!Number.isSafeInteger(initialFinishedAt) ||
        initialFinishedAt < initialStartedAt ||
        initialFinishedAt - initialStartedAt > 10_000 ||
        !positionExact(initialPositions) || !Array.isArray(initialOrders) ||
        initialOrders.length !== expectedCount || symbolOrders.length !== expectedCount ||
        !candidatePresent || !oldPresent ||
        !symbolOrders.every((row) => exactStop(row,
          orderId(row) === candidateId ? adoptedSpec : oldSpec,
          orderId(row) === candidateId ? candidateId : oldId,
          orderId(row) === candidateId ? candidatePrice : oldPrice,
          orderId(row) === candidateId ? "NEW" : wantedOldStatus[0]))) {
      return failed;
    }
    const [queriedCandidate, queriedOld] = await Promise.all([
      api.queryOrder(request.symbol, { orderId: candidateId }),
      api.queryOrder(request.symbol, { orderId: oldId }),
    ]);
    const queryPositionMatches = (row) => {
      const ids = [row?.positionId, row?.positionID]
        .filter((value) => value !== undefined && value !== null);
      return ids.length > 0 && ids.every((value) =>
        value === 0 || value === "0" || String(value) === positionValue) &&
        (ids.some((value) => value !== 0 && value !== "0")
          ? new Set(ids.map(String)).size === 1 : true);
    };
    const oldQueryStatusOk = wantedOldStatus.includes(queriedOld?.status);
    if (!exactStop(queriedCandidate, adoptedSpec, candidateId, candidatePrice, "NEW",
          { allowZeroPositionId: true }) ||
        !queryPositionMatches(queriedCandidate) ||
        !exactStop(queriedOld, oldSpec, oldId, oldPrice,
          requireOldCanceled ? queriedOld?.status : wantedOldStatus[0],
          { allowZeroPositionId: true }) ||
        !queryPositionMatches(queriedOld) || !oldQueryStatusOk) return failed;

    const rawClientOrderId = request.entryClientOrderId ??
      proof?.entryClientOrderId ??
      request.nextPosition?.entryClientOrderId ??
      request.priorPosition?.entryClientOrderId;
    const entry = await verifyEntryIdentityAndFills({
      symbol: request.symbol,
      rawClientOrderId,
      expectedPositionId: positionValue,
      request,
    });
    if (entry.exchangeOrderId !== entryId ||
        !sameDecimal(exactDecimal(entry.fill.quantity, "adopted_entry_fill_quantity"),
          exactDecimal(proof.quantity, "adopted_entry_proof_quantity"))) return failed;
    const settings = await readSettings(request.symbol);
    const leverage = strictNumber(settings?.leverage?.longLeverage,
      "adopted_stop_settings_leverage");
    if (settings.mode !== "HEDGE" || settings.marginMode !== PROFILE_MARGIN ||
        leverage !== PROFILE_LEVERAGE) return failed;

    // A second fresh pair is the current-state anchor. Compare protection and
    // position identity facts, not mark/PnL/funding fields which legitimately
    // change while the position and its protection remain unchanged.
    const finalStartedAt = Number(clock());
    const [finalPositions, finalOrders] = await Promise.all([
      api.getPositions(request.symbol), api.getOpenOrders(request.symbol),
    ]);
    const finalFinishedAt = Number(clock());
    const proofSnapshot = (positions, orders) => {
      const project = (row, fields) => Object.fromEntries(fields
        .filter(field => Object.hasOwn(row, field))
        .map(field => [field, row[field]]));
      const positionFields = ["symbol", "positionId", "positionID",
        "positionSide", "positionAmt", "avgPrice", "entryPrice",
        "leverage", "marginMode", "marginType"];
      const stopFields = ["symbol", "orderId", "orderID", "positionId", "positionID",
        "positionSide", "side", "type", "status", "workingType", "origQty", "quantity",
        "stopPrice", ...EXECUTION_QUANTITY_ALIASES, "time", "createTime",
        "createdTime", "orderTime", "mainOrderId", "mainOrderID", "parentOrderId",
        "parentOrderID", "clientOrderId", "clientOrderID"];
      return canonicalJsonStringify({
        positions: positions.map(row => project(row, positionFields))
          .sort((a, b) => String(a.positionId ?? a.positionID)
            .localeCompare(String(b.positionId ?? b.positionID))),
        orders: orders.map(row => project(row, stopFields))
          .sort((a, b) => String(a.orderId ?? a.orderID)
            .localeCompare(String(b.orderId ?? b.orderID))),
      });
    };
    const sameSnapshot = Array.isArray(finalPositions) && Array.isArray(finalOrders) &&
      proofSnapshot(initialPositions, initialOrders) === proofSnapshot(finalPositions, finalOrders);
    if (!Number.isSafeInteger(finalStartedAt) ||
        !Number.isSafeInteger(finalFinishedAt) || finalFinishedAt < finalStartedAt ||
        finalFinishedAt - finalStartedAt > 10_000 ||
        !sameSnapshot || !positionExact(finalPositions)) return failed;
    const finalSymbolOrders = Array.isArray(finalOrders)
      ? finalOrders.filter((row) => row?.symbol === name) : [];
    if (!Array.isArray(finalOrders) || finalOrders.length !== expectedCount ||
        finalSymbolOrders.length !== expectedCount ||
        !finalSymbolOrders.every((row) => exactStop(row,
          orderId(row) === candidateId ? adoptedSpec : oldSpec,
          orderId(row) === candidateId ? candidateId : oldId,
          orderId(row) === candidateId ? candidatePrice : oldPrice,
          orderId(row) === candidateId ? "NEW" : wantedOldStatus[0]))) return failed;

    const core = {
      verified: true, tranche: "core", positionId: positionValue,
      orderId: candidateId, quantity: decimalText(quantity),
      stopPrice: decimalText(candidatePrice),
    };
    const position = {
      verified: true, symbol: request.symbol, side: "Buy",
      quantity: strictNumber(initialPositions.find((row) =>
        row?.symbol === name && Number(row.positionAmt) !== 0).positionAmt,
      "adopted_stop_position_quantity"),
      avgPrice: strictNumber(initialPositions.find((row) =>
        row?.symbol === name && Number(row.positionAmt) !== 0).avgPrice ??
        initialPositions.find((row) => row?.symbol === name &&
          Number(row.positionAmt) !== 0).entryPrice,
      "adopted_stop_average_price"),
      leverage, marginMode: settings.marginMode, positionMode: settings.mode,
      positionId: positionValue, protectiveStops: { core },
    };
    return {
      verified: true, status: "filled", exchangeOrderId: candidateId,
      position, protectiveStops: position.protectiveStops,
      currentProtectionObservedAt: finalFinishedAt,
      oldStopRetirement: {
        oldStop: {
          orderId: oldId, positionId: positionValue,
          quantity: decimalText(quantity), stopPrice: decimalText(oldPrice),
        },
        adoptedStop: {
          orderId: candidateId, positionId: positionValue,
          quantity: decimalText(quantity), stopPrice: decimalText(candidatePrice),
        },
      },
    };
  }

  function retirementSnapshotValid(request, clientOrderId, phase) {
    const prior = request?.priorPosition;
    const next = request?.nextPosition;
    const proof = request?.entryProof;
    const marker = prior?.pendingStopRetirement;
    const positionValue = request?.positionId;
    const oldStop = request?.oldStop;
    const adoptedStop = request?.adoptedStop;
    const priorCore = prior?.verifiedProtectiveStops?.core ??
      prior?.split?.coreStop;
    const nextCore = next?.verifiedProtectiveStops?.core ??
      next?.split?.coreStop;
    const eqId = (left, right, label) => left !== undefined && left !== null &&
      right !== undefined && right !== null &&
      exactIdentifier(left, label) === exactIdentifier(right, label);
    const eqDecimal = (left, right, label) => left !== undefined && left !== null &&
      right !== undefined && right !== null &&
      sameDecimal(exactDecimal(left, label), exactDecimal(right, label));
    const entryClientId = proof?.entryClientOrderId;
    const entryOrder = proof?.entryOrderId;
    const sourceSignalId = request?.sourceSignalId;
    const originalIntent = marker?.originalIntent;
    const expectedMarker = {
      oldStop,
      adoptedStop,
      entryProof: proof,
      originalIntent,
    };
    const currentAliasesAgree = (snapshot) => {
      const ids = [snapshot?.coreStopOrderId]
        .filter((value) => value !== undefined && value !== null);
      const positionIds = [
        snapshot?.exchangePositionId, snapshot?.positionId,
        snapshot?.coreStopPositionId,
      ]
        .filter((value) => value !== undefined && value !== null);
      const prices = [snapshot?.coreStopPrice]
        .filter((value) => value !== undefined && value !== null);
      const quantities = [
        snapshot?.coreStopQuantity, snapshot?.coreQty, snapshot?.remainingQty,
        snapshot?.quantity,
      ].filter((value) => value !== undefined && value !== null);
      return ids.every((value) => eqId(value, adoptedStop?.orderId,
        "retirement_core_stop_alias")) &&
        positionIds.every((value) => eqId(value, adoptedStop?.positionId,
          "retirement_core_position_alias")) &&
        prices.every((value) => eqDecimal(value, adoptedStop?.stopPrice,
          "retirement_core_price_alias")) &&
        quantities.every((value) => eqDecimal(value, request.quantity,
          "retirement_core_quantity_alias"));
    };
    return object(prior) && object(next) && object(proof) && object(oldStop) &&
      object(adoptedStop) && object(marker) &&
      Object.keys(marker).sort().join(",") ===
        "adoptedStop,entryProof,oldStop,originalIntent" &&
      object(originalIntent) &&
      Object.keys(originalIntent).sort().join(",") === "clientOrderId,phase" &&
      typeof originalIntent.clientOrderId === "string" &&
      originalIntent.clientOrderId.length > 0 &&
      typeof originalIntent.phase === "string" &&
      /^raise_stop-core-/.test(originalIntent.phase) &&
      canonicalJsonStringify(marker) === canonicalJsonStringify(expectedMarker) &&
      typeof clientOrderId === "string" && clientOrderId.length > 0 &&
      typeof phase === "string" && phase.length > 0 &&
      (request.originalIntent === undefined ||
        canonicalJsonStringify(request.originalIntent) ===
          canonicalJsonStringify(originalIntent)) &&
      request.environment === "vst" && request.accountId === accountId &&
      validAccountAlias(request.accountId) &&
      prior.environment === "vst" && prior.accountId === accountId &&
      prior.symbol === request.symbol && prior.status === "open" &&
      prior.coreOpen === true && prior.runnerOpen === false &&
      next.environment === "vst" && next.accountId === accountId &&
      next.symbol === request.symbol && next.status === "open" &&
      typeof sourceSignalId === "string" && sourceSignalId.length > 0 &&
      prior.sourceSignalId === sourceSignalId &&
      next.sourceSignalId === sourceSignalId &&
      (proof.sourceSignalId === undefined ||
        proof.sourceSignalId === sourceSignalId) &&
      eqId(positionValue, oldStop.positionId, "retirement_position_id") &&
      eqId(positionValue, adoptedStop.positionId, "retirement_position_id") &&
      eqId(positionValue, prior.exchangePositionId ?? prior.positionId,
        "retirement_prior_position_id") &&
      eqId(positionValue, next.exchangePositionId ?? next.positionId,
        "retirement_next_position_id") &&
      priorCore?.verified === true &&
      eqId(adoptedStop.orderId, priorCore.orderId,
        "retirement_prior_adopted_stop_id") &&
      eqId(positionValue, priorCore.positionId,
        "retirement_prior_stop_position_id") &&
      eqDecimal(adoptedStop.quantity, priorCore.quantity,
        "retirement_prior_stop_quantity") &&
      eqDecimal(adoptedStop.stopPrice, priorCore.stopPrice,
        "retirement_prior_stop_price") &&
      nextCore?.verified === true &&
      eqId(adoptedStop.orderId, nextCore.orderId,
        "retirement_next_stop_id") &&
      eqId(positionValue, nextCore.positionId,
        "retirement_next_stop_position_id") &&
      eqDecimal(adoptedStop.quantity, nextCore.quantity,
        "retirement_next_stop_quantity") &&
      eqDecimal(adoptedStop.stopPrice, nextCore.stopPrice,
        "retirement_next_stop_price") &&
      eqId(entryOrder, request.entryOrderId ?? entryOrder,
        "retirement_entry_order_id") &&
      typeof entryClientId === "string" && entryClientId.length > 0 &&
      (request.entryClientOrderId === undefined ||
        request.entryClientOrderId === entryClientId) &&
      (prior.entryClientOrderId === undefined ||
        prior.entryClientOrderId === entryClientId) &&
      (next.entryClientOrderId === undefined ||
        next.entryClientOrderId === entryClientId) &&
      (prior.entryOrderId === undefined ||
        eqId(prior.entryOrderId, entryOrder, "retirement_prior_entry_id")) &&
      (next.entryOrderId === undefined ||
        eqId(next.entryOrderId, entryOrder, "retirement_next_entry_id")) &&
      (request.entryQuantity === undefined ||
        eqDecimal(request.entryQuantity, proof.quantity,
          "retirement_entry_quantity")) &&
      (prior.entryQuantity === undefined ||
        eqDecimal(prior.entryQuantity, proof.quantity,
          "retirement_prior_entry_quantity")) &&
      (next.entryQuantity === undefined ||
        eqDecimal(next.entryQuantity, proof.quantity,
          "retirement_next_entry_quantity")) &&
      (request.entryOrderType === undefined ||
        request.entryOrderType === proof.entryOrderType) &&
      (prior.entryOrderType === undefined ||
        prior.entryOrderType === proof.entryOrderType) &&
      (next.entryOrderType === undefined ||
        next.entryOrderType === proof.entryOrderType) &&
      eqDecimal(request.quantity, oldStop.quantity,
        "retirement_old_stop_quantity") &&
      eqDecimal(request.quantity, adoptedStop.quantity,
        "retirement_adopted_stop_quantity") &&
      eqDecimal(request.quantity, prior.quantity ?? prior.remainingQty,
        "retirement_prior_quantity") &&
      eqDecimal(request.quantity, next.quantity ?? next.remainingQty,
        "retirement_next_quantity") &&
      eqDecimal(request.quantity, proof.quantity,
        "retirement_entry_proof_quantity") &&
      currentAliasesAgree(prior) && currentAliasesAgree(next);
  }

  // A separate read-only adoption path for an unlinked raise-stop. This proves
  // only that the requested protection is active now; it deliberately does
  // not claim that this intent created the order.
  async function verifyUnlinkedRaiseStopProtection({ request }) {
    try {
      if (request?.operation !== "raise_stop" || request?.leg !== "core" ||
          request.environment !== "vst" || request.accountId !== accountId ||
          !validAccountAlias(request.accountId)) {
        return { verified: false, status: "unknown" };
      }
      assertSymbol(request.symbol);
      const requestAt = Number(request.intentCreatedAt);
      const startedAt = Number(clock());
      if (!Number.isSafeInteger(requestAt) || requestAt <= 0 ||
          !Number.isSafeInteger(startedAt) || startedAt < requestAt) {
        return { verified: false, status: "unknown" };
      }
      const [positions, orders] = await Promise.all([
        api.getPositions(request.symbol),
        api.getOpenOrders(request.symbol),
      ]);
      const finishedAt = Number(clock());
      if (!Number.isSafeInteger(finishedAt) || finishedAt < startedAt ||
          finishedAt - startedAt > 10_000) {
        return { verified: false, status: "unknown" };
      }
      const name = symbolName(request.symbol);
      const positionIdValue = exactIdentifier(request.positionId,
        "unlinked_raise_stop_position_id");
      const quantity = exactDecimal(request.quantity,
        "unlinked_raise_stop_quantity");
      const requestedPrice = exactDecimal(request.stopPrice,
        "unlinked_raise_stop_price");
      const active = Array.isArray(positions) ? positions.filter((row) =>
        row?.symbol === name && strictNumber(row.positionAmt,
          "unlinked_raise_stop_position_quantity", { allowZero: true }) !== 0) : [];
      const sameAliases = (row, fields) => {
        const values = fields.map((field) => row?.[field])
          .filter((value) => value !== undefined && value !== null);
        return values.length > 0 &&
          values.every((value) => String(value) === String(values[0]));
      };
      if (active.length !== 1 || active[0].positionSide !== "LONG" ||
          !sameAliases(active[0], ["positionId", "positionID"]) ||
          positionId(active[0]) !== positionIdValue ||
          !sameDecimal(exactDecimal(active[0].positionAmt,
            "unlinked_raise_stop_position_quantity"), quantity) ||
          !Array.isArray(orders)) {
        return { verified: false, status: "unknown" };
      }
      if (orders.length === 2) {
        const prior = request.priorPosition;
        const old = prior?.verifiedProtectiveStops?.core;
        const oldIdValues = [prior?.coreStopOrderId, old?.orderId, old?.orderID]
          .filter((value) => value !== undefined && value !== null);
        const oldPositionValues = [
          prior?.exchangePositionId, prior?.positionId, prior?.coreStopPositionId,
          old?.positionId, old?.positionID,
        ].filter((value) => value !== undefined && value !== null);
        const oldQuantityValues = [
          prior?.quantity, prior?.remainingQty, prior?.coreQty, prior?.coreStopQuantity,
          old?.quantity, old?.origQty,
        ].filter((value) => value !== undefined && value !== null);
        const oldPriceValues = [prior?.coreStopPrice, prior?.stopPrice, old?.stopPrice]
          .filter((value) => value !== undefined && value !== null);
        const historicalIdentity = object(prior) &&
          prior.environment === "vst" && prior.accountId === accountId &&
          prior.symbol === request.symbol && prior.status === "open" &&
          prior.coreOpen === true && prior.runnerOpen === false &&
          object(old) && old.verified === true &&
          oldIdValues.length >= 2 &&
          new Set(oldIdValues.map(String)).size === 1 &&
          oldPositionValues.length >= 3 &&
          new Set(oldPositionValues.map(String)).size === 1 &&
          oldQuantityValues.length >= 4 &&
          oldQuantityValues.every((value) => sameDecimal(
            exactDecimal(value, "unlinked_old_stop_quantity"), quantity)) &&
          oldPriceValues.length >= 2 &&
          oldPriceValues.every((value) => sameDecimal(
            exactDecimal(value, "unlinked_old_stop_price"),
            exactDecimal(old.stopPrice, "unlinked_old_stop_price"))) &&
          sameDecimal(exactDecimal(old.quantity ?? old.origQty,
            "unlinked_old_stop_quantity"), quantity) &&
          exactIdentifier(oldPositionValues[0], "unlinked_old_position_id") ===
            positionIdValue;
        if (!historicalIdentity || orders.length !== 2) {
          return { verified: false, status: "unknown" };
        }
        const oldSpec = {
          orderId: exactIdentifier(oldIdValues[0], "unlinked_old_stop_id"),
          positionId: positionIdValue,
          quantity: decimalText(quantity),
          stopPrice: String(old.stopPrice),
        };
        const candidate = orders.find((row) => {
          try { return orderId(row) !== oldSpec.orderId; } catch { return false; }
        });
        if (!candidate) return { verified: false, status: "unknown" };
        const adoptedSpec = {
          orderId: orderId(candidate),
          positionId: positionIdValue,
          quantity: decimalText(quantity),
          stopPrice: String(request.stopPrice),
        };
        const evidence = await proveAdoptedStopPair(request, {
          oldStop: oldSpec,
          adoptedStop: adoptedSpec,
          requireCandidateTimestamp: true,
        });
        if (evidence.verified !== true ||
            evidence.exchangeOrderId !== adoptedSpec.orderId ||
            !sameDecimal(exactDecimal(evidence.protectiveStops?.core?.stopPrice,
              "unlinked_adopted_stop_price"), requestedPrice)) {
          return { verified: false, status: "unknown" };
        }
        return { ...evidence, currentProtectionOnly: true };
      }
      if (orders.length !== 1) return { verified: false, status: "unknown" };
      const candidate = orders[0];
      const candidateId = orderId(candidate);
      const candidatePositionIds = [candidate.positionId, candidate.positionID]
        .filter((value) => value !== undefined && value !== null);
      const candidateOrderIds = [candidate.orderId, candidate.orderID]
        .filter((value) => value !== undefined && value !== null);
      const parents = [
        candidate.mainOrderId, candidate.mainOrderID,
        candidate.parentOrderId, candidate.parentOrderID,
      ]
        .filter((value) => value !== undefined && value !== null && value !== "");
      const executionFields = ["executedQty", "cumExecQty", "dealSize",
        "filledQty", "executedQuantity"];
      const createdValue = [candidate.time, candidate.createTime,
        candidate.createdTime, candidate.orderTime]
        .map(asMillis).find((value) => Number.isSafeInteger(value) && value > 0);
      const entryProof = request.entryProof;
      const entryId = exactIdentifier(entryProof?.entryOrderId,
        "unlinked_raise_stop_entry_id");
      if (!candidateId || candidate.symbol !== name ||
          candidateOrderIds.length === 0 ||
          candidateOrderIds.some((value) => String(value) !== candidateId) ||
          candidate.type !== "STOP_MARKET" || candidate.status !== "NEW" ||
          candidate.side !== "SELL" || candidate.positionSide !== "LONG" ||
          candidate.workingType !== "MARK_PRICE" ||
          candidatePositionIds.length === 0 ||
          candidatePositionIds.some((value) => String(value) !== positionIdValue) ||
          !sameDecimal(exactDecimal(candidate.origQty ?? candidate.quantity,
            "unlinked_raise_stop_order_quantity"), quantity) ||
          !sameDecimal(exactDecimal(candidate.stopPrice,
            "unlinked_raise_stop_order_price"), requestedPrice) ||
          !Object.hasOwn(candidate, "executedQty") ||
          candidate.executedQty === undefined || candidate.executedQty === null ||
          executionFields.some((field) => Object.hasOwn(candidate, field) &&
            (candidate[field] === undefined || candidate[field] === null ||
             !sameDecimal(exactDecimal(candidate[field],
               "unlinked_raise_stop_execution", { allowZero: true }),
             exactDecimal("0", "unlinked_raise_stop_zero", { allowZero: true })))) ||
          !createdValue || createdValue < requestAt - 2_000 ||
          createdValue > requestAt + 60_000 ||
          parents.some((parent) =>
            exactIdentifier(parent, "unlinked_raise_stop_parent_id") !== entryId)) {
        return { verified: false, status: "unknown" };
      }
      const evidence = await reconcileRaiseStopByNativeId(request, candidateId);
      const stop = evidence?.protectiveStops?.core ??
        evidence?.position?.protectiveStops?.core;
      if (evidence?.verified !== true || evidence.status !== "filled" ||
          evidence.exchangeOrderId !== candidateId ||
          !stop?.verified || stop.orderId !== candidateId ||
          !sameDecimal(exactDecimal(stop.stopPrice,
            "unlinked_raise_stop_verified_price"), requestedPrice)) {
        return { verified: false, status: "unknown" };
      }
      return { ...evidence, currentProtectionOnly: true };
    } catch {
      return { verified: false, status: "unknown" };
    }
  }

  async function reconcileIntent({
    clientOrderId, phase, request, exchangeOrderId,
  }) {
    if (request?.environment !== "vst" || request?.accountId !== accountId ||
        !validAccountAlias(request.accountId)) {
      return { verified: false, status: "unknown" };
    }

    try {
      assertSymbol(request.symbol);
    } catch {
      return { verified: false, status: "unknown" };
    }
    if (request?.operation === "margin_top_up") {
      try {
        const amount = exactDecimal(request.amount, "margin_top_up_amount");
        const approvedAmount = exactDecimal(
          request.approvedTopUpMargin, "margin_top_up_approved_amount",
        );
        const expectedBefore = exactDecimal(
          request.expectedIsolatedMarginBefore, "margin_top_up_expected_margin_before",
        );
        if (!sameDecimal(amount, approvedAmount)) {
          return { verified: false, status: "unknown" };
        }
        const observation = await readMarginTopUpBaseline(request);
        // initialMargin is the original entry margin and DOES NOT change
        // after a real BingX VST isolated-margin addition. Only the separate
        // exchange adjustment history can corroborate a submitted POST.
        if (!sameDecimal(exactDecimal(observation.isolatedMarginBefore,
          "margin_top_up_entry_margin"), expectedBefore) ||
            typeof api.getPositionMarginHistory !== "function") {
          return { verified: false, status: "unknown" };
        }
        const intentAt = Number(request.intentCreatedAt) ||
          Date.parse(request.intentCreatedAt);
        const now = Number(clock());
        if (!Number.isSafeInteger(intentAt) || intentAt <= 0 ||
            !Number.isSafeInteger(now) || now < intentAt) {
          return { verified: false, status: "unknown" };
        }
        const endTime = now;
        const historyRecords = await readCompleteMarginTopUpHistory(
          request.symbol, observation.positionId, intentAt, endTime,
        );
        const additions = historyRecords.filter((row) =>
          row?.changeReason === "ManualMarginAddition");
        // The history has no client operation ID. Even a same-amount row is
        // ambiguous if another addition occurred in the same time window.
        if (additions.length !== 1) {
          return { verified: false, status: "unknown" };
        }
        const row = additions[0];
        const delta = exactDecimal(row.marginChange, "margin_history_change");
        const after = exactDecimal(row.marginAfterChange, "margin_history_after");
        const change = Number(decimalText(delta));
        if (row.symbol !== symbolName(request.symbol) ||
            exactIdentifier(row.positionId, "margin_history_position_id") !==
              observation.positionId ||
            !Number.isSafeInteger(row.time) || row.time < intentAt ||
            row.time > endTime || change <= 0 ||
            Math.abs(change - Number(decimalText(amount))) > 2e-8 ||
            Number(decimalText(after)) <= change) {
          return { verified: false, status: "unknown" };
        }
        const before = subtractDecimal(after, delta);
        // BingX's position endpoint exposes the original entry initialMargin
        // rounded to four decimals, while the adjustment history is more
        // precise. A uniquely matching amount alone cannot attribute this
        // row to the submitted intent: an independent same-sized manual
        // addition after an unexecuted POST would otherwise look identical.
        // Require the history-derived pre-adjustment balance to agree with
        // the persisted entry baseline within half of that baseline's last
        // stored precision unit.
        if (!withinHalfStoredUnit(before, expectedBefore)) {
          return { verified: false, status: "unknown" };
        }
        return {
          verified: true,
          status: "filled",
          symbol: request.symbol,
          positionId: observation.positionId,
          positionSide: "LONG",
          quantity: observation.quantity,
          amount: decimalText(amount),
          isolatedMarginBefore: decimalText(before),
          isolatedMarginAfter: decimalText(after),
          marginDelta: decimalText(delta),
          marginHistory: {
            source: "bingx_position_margin_history",
            changeReason: row.changeReason,
            attribution: "unique_exchange_adjustment_without_operation_id",
            positionId: observation.positionId,
            amount: decimalText(delta),
            time: row.time,
          },
          protectiveStop: observation.protectiveStop,
        };
      } catch {
        return { verified: false, status: "unknown" };
      }
    }
    if (request?.operation === "prepare_margin_mode") {
      try {
        const [mode, marginMode, accountRows] = await Promise.all([
          api.getPositionMode(),
          api.getMarginType(request.symbol),
          readGlobalAccountRows(),
        ]);
        const exchangeSymbolForPrep = symbolName(request.symbol);
        const flatWithoutOrders = accountRows.positions.every((row) =>
          row.symbol !== exchangeSymbolForPrep || Number(row.positionAmt) === 0) &&
          accountRows.openOrders.every((row) => row.symbol !== exchangeSymbolForPrep);
        const verified = mode === "HEDGE" && marginMode === PROFILE_MARGIN &&
          flatWithoutOrders;
        return {
          verified,
          status: verified ? "filled" : "unknown",
          marginMode,
        };
      } catch {
        return { verified: false, status: "unknown" };
      }
    }
    if (request?.operation === "set_isolated_leverage") {
      const settings = await readSettings(request.symbol);
      const position = await readPosition(request.symbol, {
        persistedPosition: positionSnapshotFromRequest(request) ?? undefined,
      });
      const verified = settings.marginMode === PROFILE_MARGIN &&
        settings.mode === "HEDGE" &&
        Number(settings.leverage.longLeverage) === PROFILE_LEVERAGE;
      return {
        verified,
        status: verified ? "filled" : "unknown",
        position,
      };
    }
    if (request?.operation === "raise_stop") {
      // A matching stop by price/quantity is not proof that this intent
      // submitted it. Only a durable exact native parent ID can reconcile a
      // raise-stop after the client-order-ID path is absent or ambiguous.
      if (exchangeOrderId === undefined || exchangeOrderId === null) {
        return recordProofResult({ verified: false, status: "unknown" }, {
          source: "order_reconciliation_proof",
          condition: "request_identity",
          symbol: request?.symbol,
          sourceSignalId: request?.sourceSignalId,
          operation: "raise_stop",
          check: "protective_stop",
        }, () => ({
          orderFound: evidencePair(true, false),
        }));
      }
      return reconcileRaiseStopByNativeId(request, exchangeOrderId);
    }
    if (request?.operation === "retire_adopted_stop") {
      try {
        if (!retirementSnapshotValid(request, clientOrderId, phase)) {
          return { verified: false, status: "unknown" };
        }
        const evidence = await proveAdoptedStopPair(request, {
          oldStop: request.oldStop,
          adoptedStop: request.adoptedStop,
          requireOldCanceled: true,
        });
        if (evidence.verified !== true) {
          return { verified: false, status: "unknown" };
        }
        const oldId = exactIdentifier(request.oldStop?.orderId,
          "retire_adopted_old_stop_id");
        return {
          verified: true,
          status: "filled",
          canceledStopOrderId: oldId,
          exchangeOrderId: oldId,
          position: evidence.position,
          protectiveStops: evidence.protectiveStops,
        };
      } catch {
        return { verified: false, status: "unknown" };
      }
    }
    if (request?.operation === "set_runner_break_even") {
      return { verified: false, status: "unknown" };
    }
    if (request?.operation === "cancel_original_after_runner_fill") {
      try {
        const details = triggeredRunnerCancellationDetails(request, clientOrderId);
        return await triggeredRunnerCancellationEvidence(request, details);
      } catch {
        return { verified: false, status: "unknown" };
      }
    }
    if (["split_core_stop", "split_runner_stop", "cancel_original_stop",
      "cancel_split_stop"].includes(request?.operation)) {
      return splitOperationEvidence({ clientOrderId, request });
    }
    if (request?.operation === "split_raise_stop_place") {
      return splitLegUpgradeEvidence({ request, clientOrderId, cancelPhase: false, exchangeOrderId });
    }
    if (request?.operation === "split_raise_stop_cancel") {
      return splitLegUpgradeEvidence({ request, clientOrderId, cancelPhase: true });
    }
    if (request?.operation === "close_survivor") {
      return soleSplitLegCloseEvidence({ request, clientOrderId, phase });
    }
    if (request?.operation === "close_split_all") {
      return closeSplitAllEvidence({ request, clientOrderId });
    }
    if (request?.operation === "close_pre_runner_split") {
      return closePreRunnerSplitEvidence({ request, clientOrderId });
    }
    if (request?.operation === "cancel_flat_split_stop") {
      return cancelFlatSplitStopEvidence({ request });
    }
    if (request?.operation === "close_leg" &&
        (request?.signal?.patternId === "impulse_buy" ||
         request?.totalQuantity !== undefined ||
         request?.coreQuantity !== undefined ||
         request?.runnerQuantity !== undefined ||
         request?.coreStop !== undefined ||
         request?.runnerStop !== undefined)) {
      return splitPartialCloseEvidence({ clientOrderId, phase, request });
    }
    return orderEvidence({ clientOrderId, phase, request });
  }

  async function performIntent(args) {
    const startedAt = performance.now();
    const mutationContext = { requestMayHaveBeenSent: false };
    try {
      const run = () => performIntentUnclassified({ ...args, mutationContext });
      const scopedRun = ["prepare_margin_mode", "set_isolated_leverage", "raise_stop"]
        .includes(args?.request?.operation) &&
        typeof api.withVstPreparationReads === "function"
        ? () => api.withVstPreparationReads(args.request.symbol, run)
        : run;
      if (args?.request?.stopTransferProtocol === 1) {
        if (typeof api.withStopTransferJournal !== "function" || !args.stopTransferJournal) {
          throw new Error("bingx_vst_durable_stop_transfer_unavailable");
        }
        return await api.withStopTransferJournal(args.stopTransferJournal, scopedRun);
      }
      return await scopedRun();
    } catch (error) {
      if (args?.request?.stopTransferProtocol === 1 &&
          args.stopTransferJournal?.getProgress().stage === "prepared") {
        apiIntentIds.delete(linkedId(args.clientOrderId));
      }
      if (args?.request?.operation === "cancel_original_stop") {
        if (!error?.mutationProvenance) {
          setOriginalStopCancellationProvenance(
            error, mutationContext.requestMayHaveBeenSent,
          );
        }
        if (hasProvenOriginalStopCancelNoSend(error)) {
          try {
            apiIntentIds.delete(linkedId(args.clientOrderId));
          } catch {
            // An invalid ID was never reserved, so there is nothing to release.
          }
        }
      }
      // Tag (never replace) so a caller that only knows the generic broker
      // contract -- not BingX's own error shapes -- can still tell a
      // synchronous, definitive exchange-side rejection apart from a
      // genuinely ambiguous transport failure.
      const preMutationReadRefusal = hasProvenOriginalStopCancelNoSend(error);
      const failedRequestWasRead = error?.method === "GET";
      if (error instanceof Error && isDefiniteExchangeRejection(error) &&
          !preMutationReadRefusal &&
          !(args?.request?.operation === "cancel_original_stop" && failedRequestWasRead)) {
        error.definiteRejection = true;
      }
      throw error;
    } finally {
      reportOperationTiming(startedAt, {
        operation: args?.request?.operation ?? "unknown",
        symbol: args?.request?.symbol,
        stage: "perform_intent",
      });
    }
  }

  async function performIntentUnclassified({
    clientOrderId, phase, request, mutationContext, onSubmission,
    onEntryReprice, onEntryTransportReady, onEntryTiming,
  }) {
    const symbol = request?.symbol;
    assertSymbol(symbol);
    if (onSubmission !== undefined && typeof onSubmission !== "function") {
      throw new TypeError("onSubmission must be a function");
    }
    if (request?.environment !== "vst" || request?.accountId !== accountId) {
      throw new Error("bingx_vst_intent_account_or_environment_mismatch");
    }
    if ([
      "prepare_margin_mode", "margin_top_up", "raise_stop", "close", "close_leg",
      "retire_adopted_stop",
      "close_survivor", "close_split_all",
      "close_pre_runner_split", "cancel_flat_split_stop", "split_core_stop",
      "split_runner_stop",
      "split_raise_stop_place", "split_raise_stop_cancel", "cancel_original_stop",
      "cancel_original_after_runner_fill", "cancel_split_stop",
    ].includes(request.operation) && !intentRange(request, Number(clock()))) {
      throw new Error("bingx_vst_durable_intent_created_at_required");
    }
    const sourceExitDetails = sourceExitCloseDetails(request);
    const sourceExitCleanup = sourceExitCleanupDetails(request);
    if (!sourceExitDetails && !sourceExitCleanup) {
      await assertVstEnvironment(symbol);
    }
    const exchangeClientId = linkedId(clientOrderId);
    if (apiIntentIds.has(exchangeClientId)) {
      throw new Error("bingx_vst_intent_already_submitted_never_retry");
    }
    // Every guard below is scoped to THIS symbol only. Many symbols can each
    // carry their own independent position/orders concurrently by design --
    // a DIFFERENT symbol's exposure is never evidence this symbol is unsafe.
    const accountRows = await readGlobalAccountRows();
    const exchangeSymbol = symbolName(symbol);
    const activeSymbolPositions = accountRows.positions.filter((row) =>
      row.symbol === exchangeSymbol && Number(row.positionAmt) !== 0);
    const symbolOpenOrders = accountRows.openOrders.filter((row) =>
      row.symbol === exchangeSymbol);
    if (sourceExitCleanup &&
        !verifySourceExitCleanupSnapshot(sourceExitCleanup,
          accountRows.positions, accountRows.openOrders)) {
      throw new Error("bingx_vst_source_exit_cleanup_position_or_stops_unverified");
    }
    if (request.operation === "entry") {
      if (activeSymbolPositions.length > 0 || symbolOpenOrders.length > 0) {
        throw new Error("bingx_vst_entry_requires_symbol_flat_and_no_open_orders");
      }
    } else if (request.operation === "set_isolated_leverage" ||
        request.operation === "prepare_margin_mode") {
      if (activeSymbolPositions.length > 0 || symbolOpenOrders.length > 0) {
        throw new Error("bingx_vst_symbol_preparation_requires_flat_symbol_and_no_open_orders");
      }
    }
    if (sourceExitDetails) {
      if (request.operation !== "close_leg" ||
          !verifySourceExitExchangeSnapshot(sourceExitDetails,
            accountRows.positions, accountRows.openOrders, {
              requireActivePosition: true,
            })) {
        throw new Error("bingx_vst_source_exit_exchange_position_or_stops_unverified");
      }
      apiIntentIds.set(exchangeClientId, { phase, status: "submitted" });
      await performMutation("closeLong",
        symbol,
        sourceExitDetails.quantity,
        exchangeClientId,
        sourceExitDetails.positionId,
        {
          automatedLongPolicy: VST_AUTOMATED_LONG_POLICY,
          sourceExitRequest: {
            sourceExitRequestId: sourceExitDetails.sourceExitRequestId,
            sourceExit: sourceExitDetails.sourceExit,
            sourceSignalId: sourceExitDetails.sourceSignalId,
            symbol: sourceExitDetails.symbol,
            reason: sourceExitDetails.reason,
            ownedStops: sourceExitDetails.stops,
            entryOrderId: sourceExitDetails.entryOrderId,
          },
        },
      );
      return;
    }
    // Management operations (raise_stop, close_leg, etc.) already only ever
    // read/write this one symbol's own position and orders -- no separate
    // foreign-symbol check is needed or meaningful once other symbols are
    // expected to carry their own independent exposure.

    if (request.operation === "prepare_margin_mode") {
      const [mode, marginMode] = await Promise.all([
        api.getPositionMode(),
        api.getMarginType(symbol),
      ]);
      if (mode !== "HEDGE" ||
          !["CROSSED", "ISOLATED"].includes(marginMode)) {
        throw new Error("bingx_vst_isolated_margin_preparation_requires_hedge_crossed_mode");
      }
      if (marginMode === PROFILE_MARGIN) return;
      if (typeof api.setVstIsolatedMarginForFlatSymbol !== "function") {
        throw new Error("bingx_vst_isolated_margin_preparation_adapter_unavailable");
      }
      apiIntentIds.set(exchangeClientId, { phase, status: "submitted" });
      await performMutation("setVstIsolatedMarginForFlatSymbol", symbol);
      return;
    }

    if (request.operation === "set_isolated_leverage") {
      const settings = await readSettings(symbol);
      if (settings.mode !== "HEDGE" || settings.marginMode !== PROFILE_MARGIN) {
        throw new Error("bingx_vst_hedge_isolated_margin_must_be_exchange_verified");
      }
      if (Number(settings.leverage.longLeverage) === PROFILE_LEVERAGE) return;
      await performMutation("setVstLongLeverage10", symbol);
      return;
    }

    if (request.operation === "entry") {
      if (request.entryOrderType !== "MARKET") {
        throw new Error("legacy_vst_entry_request_requires_reconciliation");
      }
      if (request.side !== "Buy" || request.marginMode !== PROFILE_MARGIN ||
          Number(request.leverage) !== PROFILE_LEVERAGE) {
        throw new Error("bingx_vst_entry_request_not_supported");
      }
      const settings = await readSettings(symbol);
      if (settings.mode !== "HEDGE" || settings.marginMode !== PROFILE_MARGIN ||
          Number(settings.leverage.longLeverage) !== PROFILE_LEVERAGE) {
        throw new Error("bingx_vst_entry_requires_verified_hedge_isolated_long10");
      }
      apiIntentIds.set(exchangeClientId, { phase, status: "submitted" });
      await performMutation("placeVstAutomatedLong", {
        symbol,
        quantity: String(request.quantity),
        maxPrice: String(request.maxEntryPrice),
        stopLoss: String(request.stopLoss),
        clientOrderId: exchangeClientId,
        signalAt: request.signal?.signalAt,
        approvedTopUpMargin: request.approvedTopUpMargin ?? null,
        policy: VST_AUTOMATED_LONG_POLICY,
        ...(request.entrySizingPolicy === "fresh-before-sign-v1" ? {
          refreshSizing: request.refreshSizing,
          onReprice: onEntryReprice,
          onTransportReady: onEntryTransportReady,
          onEntryTiming,
        } : {}),
      });
      return;
    }

    if (request.operation === "margin_top_up") {
      if (phase !== "margin-top-up" ||
          typeof api.addVstIsolatedLongMargin !== "function") {
        throw new Error("bingx_vst_margin_top_up_adapter_or_phase_unavailable");
      }
      const amount = exactDecimal(request.amount, "margin_top_up_amount");
      const approvedAmount = exactDecimal(
        request.approvedTopUpMargin, "margin_top_up_approved_amount",
      );
      const expectedBefore = exactDecimal(
        request.expectedIsolatedMarginBefore, "margin_top_up_expected_margin_before",
      );
      if (!sameDecimal(amount, approvedAmount) ||
          !exactIdentifier(request.positionId, "margin_top_up_position_id") ||
          !exactIdentifier(request.entryOrderId, "margin_top_up_entry_order_id")) {
        throw new Error("bingx_vst_margin_top_up_immutable_request_invalid");
      }
      const baseline = await readMarginTopUpBaseline(request);
      if (!sameDecimal(
        exactDecimal(baseline.isolatedMarginBefore, "margin_top_up_live_margin_before"),
        expectedBefore,
      ) || !sameDecimal(
        exactDecimal(baseline.quantity, "margin_top_up_live_quantity"),
        exactDecimal(request.quantity, "margin_top_up_request_quantity"),
      )) {
        throw new Error("bingx_vst_margin_top_up_baseline_changed_before_submission");
      }
      // initialMargin does not move after an addition. Guard a restarted
      // prepared intent against a prior, already-recorded adjustment.
      if (typeof api.getPositionMarginHistory !== "function") {
        throw new Error("bingx_vst_margin_history_required_before_submission");
      }
      const intentAt = Number(request.intentCreatedAt) ||
        Date.parse(request.intentCreatedAt);
      const current = Number(clock());
      if (!Number.isSafeInteger(intentAt) || intentAt <= 0 ||
          !Number.isSafeInteger(current) || current < intentAt) {
        throw new Error("bingx_vst_margin_history_window_invalid");
      }
      const prior = await api.getPositionMarginHistory(symbol, baseline.positionId, {
        startTime: intentAt, endTime: current, pageSize: 100,
      });
      if (!Number.isSafeInteger(prior?.total) || prior.total >= 100 ||
          !Array.isArray(prior.records) || prior.records.length !== prior.total ||
          prior.records.some((row) => row?.changeReason === "ManualMarginAddition")) {
        throw new Error("bingx_vst_margin_top_up_prior_addition_or_history_unverified");
      }
      apiIntentIds.set(exchangeClientId, { phase, status: "submitted" });
      await performMutation("addVstIsolatedLongMargin", {
        symbol,
        amount: decimalText(amount),
        clientOperationId: exchangeClientId,
        quantity: decimalText(exactDecimal(request.quantity, "margin_top_up_request_quantity")),
        positionId: baseline.positionId,
        entryOrderId: baseline.entryOrderId,
        stopLoss: String(request.stopLoss),
        policy: VST_AUTOMATED_LONG_POLICY,
      });
      return;
    }

    if (request.operation === "retire_adopted_stop") {
      const oldStop = request.oldStop;
      const adoptedStop = request.adoptedStop;
      const positionIdValue = exactIdentifier(
        request.positionId ?? oldStop?.positionId ?? adoptedStop?.positionId,
        "retire_adopted_position_id",
      );
      const quantity = exactDecimal(
        request.quantity ?? adoptedStop?.quantity ?? adoptedStop?.origQty,
        "retire_adopted_quantity",
      );
      const oldId = exactIdentifier(oldStop?.orderId, "retire_adopted_old_id");
      const adoptedId = exactIdentifier(adoptedStop?.orderId,
        "retire_adopted_new_id");
      const oldPrice = exactDecimal(oldStop?.stopPrice, "retire_adopted_old_price");
      const adoptedPrice = exactDecimal(adoptedStop?.stopPrice,
        "retire_adopted_new_price");
      if (typeof api.retireVstAutomatedAdoptedStop !== "function" ||
          !retirementSnapshotValid(request, clientOrderId, phase)) {
        throw new Error("bingx_vst_adopted_stop_retirement_request_unverified");
      }
      try {
        const evidence = await proveAdoptedStopPair(request, {
          oldStop: { ...oldStop, quantity: decimalText(quantity) },
          adoptedStop: { ...adoptedStop, quantity: decimalText(quantity) },
        });
        if (evidence.verified !== true ||
            evidence.protectiveStops?.core?.orderId !== adoptedId) {
          throw new Error("bingx_vst_adopted_stop_retirement_exchange_state_unverified");
        }
      } catch (error) {
        // This is the broker's read-only guard, before the native cancellation
        // adapter is invoked. It proves this attempt sent no DELETE.
        const failure = error instanceof Error ? error : new Error("retirement_pre_read_failed");
        failure.mutationProvenance = Object.freeze({
          operation: "cancel_original_stop", mutationMethod: "DELETE",
          mutationEndpoint: "/openApi/swap/v2/trade/order",
          mutationRequestSent: false, phase: "pre_mutation_read",
        });
        throw failure;
      }
      apiIntentIds.set(exchangeClientId, { phase, status: "submitted" });
      await performMutation("retireVstAutomatedAdoptedStop", {
        symbol,
        policy: VST_AUTOMATED_LONG_POLICY,
        positionId: positionIdValue,
        entryOrderId: exactIdentifier(request.entryProof.entryOrderId,
          "retire_adopted_entry_id"),
        oldStopOrderId: oldId,
        oldStopPrice: decimalText(oldPrice),
        newStopOrderId: adoptedId,
        stopPrice: decimalText(adoptedPrice),
        quantity: decimalText(quantity),
        cancellationIntentId: exchangeClientId,
      });
      return;
    }

    if (request.operation === "raise_stop") {
      if (request.leg !== "core") {
        throw new Error("bingx_vst_automated_runner_stop_upgrade_unsupported");
      }
      const rawEntryClientOrderId = request.nextPosition?.entryClientOrderId ??
        request.entryClientOrderId ?? request.signal?.entryClientOrderId;
      // Read immutable entry history before the time-sensitive preflight.
      // Otherwise history consumes its ten-second window and none of the
      // initial native checks can share that privately acquired cohort.
      // Legacy requests without an exact persisted ID keep the old ordering.
      const boundEntry = request.positionId !== undefined
        ? await verifyEntryIdentityAndFills({
          symbol,
          rawClientOrderId: rawEntryClientOrderId,
          expectedPositionId: exactIdentifier(request.positionId, "raise_stop_position_id"),
          request,
        })
        : null;
      const position = await readPosition(symbol, {
        persistedPosition: positionSnapshotFromRequest(request) ?? undefined,
        allowProcessCache: false,
      });
      const oldStop = position.protectiveStops?.core;
      if (!oldStop?.verified || !position.positionId ||
          !sameDecimal(exactDecimal(position.quantity, "raise_stop_position_quantity"),
            exactDecimal(request.previousQuantity, "raise_stop_previous_quantity")) ||
          !sameDecimal(exactDecimal(position.quantity, "raise_stop_position_quantity"),
            exactDecimal(request.quantity, "raise_stop_quantity")) ||
          request.positionId !== undefined &&
            exactIdentifier(request.positionId, "raise_stop_position_id") !== position.positionId) {
        throw new Error("bingx_vst_existing_core_stop_unverified");
      }
      const openOrders = await api.getOpenOrders(symbol);
      if (!Array.isArray(openOrders) || openOrders.length !== 1 ||
          openOrders.filter((order) => {
            try {
              return orderId(order) === oldStop.orderId &&
                order.symbol === symbolName(symbol) &&
                order.type === "STOP_MARKET" && order.status === "NEW" &&
                order.side === "SELL" && order.positionSide === "LONG" &&
                positionId(order) === position.positionId &&
                sameDecimal(exactDecimal(order.origQty ?? order.quantity,
                  "raise_stop_raw_quantity"),
                exactDecimal(position.quantity, "raise_stop_expected_quantity")) &&
                sameDecimal(exactDecimal(order.stopPrice, "raise_stop_raw_price"),
                  exactDecimal(oldStop.stopPrice, "raise_stop_expected_price"));
            } catch {
              return false;
            }
          }).length !== 1) {
        throw new Error("bingx_vst_raise_stop_requires_one_exact_core_stop");
      }
      const entry = boundEntry ?? await verifyEntryIdentityAndFills({
        symbol,
        rawClientOrderId: rawEntryClientOrderId,
        expectedPositionId: position.positionId,
        request,
      });
      apiIntentIds.set(exchangeClientId, { phase, status: "submitted" });
      const submission = await performMutation("upgradeVstLongStop", {
        symbol,
        quantity: String(request.quantity),
        positionId: position.positionId,
        entryOrderId: entry.exchangeOrderId,
        previousStopOrderId: oldStop.orderId,
        previousStopPrice: String(oldStop.stopPrice),
        stopPrice: String(request.stopPrice),
        ...(onSubmission ? { onSubmission } : {}),
      });
      const submittedId = submission?.exchangeOrderId ??
        submission?.newStopOrderId;
      return submittedId === undefined || submittedId === null
        ? undefined
        : { exchangeOrderId: exactIdentifier(
          submittedId, "raise_stop_exchange_order_id",
        ) };
    }

    if (request.operation === "split_core_stop" ||
        request.operation === "split_runner_stop") {
      apiIntentIds.set(exchangeClientId, { phase, status: "submitted" });
      await performSplitStop({
        clientOrderId,
        request,
        tranche: request.operation === "split_core_stop" ? "core" : "runner",
      });
      return;
    }

    if (request.operation === "split_raise_stop_place") {
      const details = splitLegUpgradeDetails(request, clientOrderId, false);
      if (typeof api.placeVstAutomatedSplitLegStopUpgrade !== "function") {
        throw new Error("bingx_vst_split_leg_stop_upgrade_adapter_unavailable");
      }
      apiIntentIds.set(exchangeClientId, { phase, status: "submitted" });
      const result = await performMutation("placeVstAutomatedSplitLegStopUpgrade", {
        symbol,
        policy: VST_AUTOMATED_LONG_POLICY,
        positionId: details.positionId,
        totalQuantity: details.totalQuantity,
        leg: details.leg,
        oldStop: details.oldStop,
        otherStop: details.otherStop,
        newStopPrice: details.newStopPrice,
        clientOrderId: details.exchangeClientOrderId,
        upgradeIntentId: details.upgradeIntentId,
        ...(details.entryOrderId ? { entryOrderId: details.entryOrderId } : {}),
      });
      const resultNewStopId = strictExchangeId(
        result?.newStop, ["orderId", "orderID"], "split_upgrade_result_order_id",
      );
      const resultOldStopId = strictExchangeId(
        result?.oldStop, ["orderId", "orderID"], "split_upgrade_result_old_stop_id",
      );
      const resultOtherStopId = strictExchangeId(
        result?.otherStop, ["orderId", "orderID"], "split_upgrade_result_other_stop_id",
      );
      if (result?.verified !== true ||
          result.symbol !== symbolName(symbol) ||
          result.positionId !== details.positionId ||
          result.leg !== details.leg ||
          resultOldStopId !== details.oldStop.orderId ||
          resultOtherStopId !== details.otherStop.orderId ||
          result.upgradeIntentId !== details.upgradeIntentId ||
          result.clientOrderId !== details.exchangeClientOrderId ||
          !sameDecimal(exactDecimal(result.totalQuantity,
            "split_upgrade_result_total_quantity"),
          exactDecimal(details.totalQuantity, "split_upgrade_expected_total_quantity")) ||
          resultNewStopId === details.oldStop.orderId ||
          resultNewStopId === details.otherStop.orderId ||
          strictExchangeId(result.newStop, ["clientOrderId", "clientOrderID"],
            "split_upgrade_result_client_order_id") !== details.exchangeClientOrderId ||
          result.newStop.tranche !== details.leg ||
          !sameDecimal(exactDecimal(result.newStop.quantity,
            "split_upgrade_result_quantity"),
          exactDecimal(details.oldStop.quantity, "split_upgrade_expected_quantity")) ||
          !sameDecimal(exactDecimal(result.newStop.stopPrice,
            "split_upgrade_result_price"),
          exactDecimal(details.newStopPrice, "split_upgrade_expected_price")) ||
          result.oldStop.tranche !== details.leg ||
          !sameDecimal(exactDecimal(result.oldStop.quantity,
            "split_upgrade_result_old_quantity"),
          exactDecimal(details.oldStop.quantity, "split_upgrade_expected_old_quantity")) ||
          !sameDecimal(exactDecimal(result.oldStop.stopPrice,
            "split_upgrade_result_old_price"),
          exactDecimal(details.oldStop.stopPrice, "split_upgrade_expected_old_price")) ||
          result.otherStop.tranche !== details.otherStop.tranche ||
          !sameDecimal(exactDecimal(result.otherStop.quantity,
            "split_upgrade_result_other_quantity"),
          exactDecimal(details.otherStop.quantity, "split_upgrade_expected_other_quantity")) ||
          !sameDecimal(exactDecimal(result.otherStop.stopPrice,
            "split_upgrade_result_other_price"),
          exactDecimal(details.otherStop.stopPrice, "split_upgrade_expected_other_price"))) {
        throw new Error("bingx_vst_split_leg_stop_upgrade_adapter_result_unverified");
      }
      return;
    }

    if (request.operation === "split_raise_stop_cancel") {
      const details = splitLegUpgradeDetails(request, clientOrderId, true);
      if (typeof api.cancelVstAutomatedSplitLegStopUpgrade !== "function") {
        throw new Error("bingx_vst_split_leg_stop_cancel_adapter_unavailable");
      }
      apiIntentIds.set(exchangeClientId, { phase, status: "submitted" });
      const result = await performMutation("cancelVstAutomatedSplitLegStopUpgrade", {
        symbol,
        policy: VST_AUTOMATED_LONG_POLICY,
        positionId: details.positionId,
        totalQuantity: details.totalQuantity,
        leg: details.leg,
        oldStop: details.oldStop,
        newStop: details.newStop,
        otherStop: details.otherStop,
        clientOrderId: details.exchangeClientOrderId,
        upgradeIntentId: details.upgradeIntentId,
        ...(details.entryOrderId ? { entryOrderId: details.entryOrderId } : {}),
      });
      const activeNewId = strictExchangeId(
        result?.activeUpgradedStop, ["orderId", "orderID"],
        "split_upgrade_cancel_active_new_id",
      );
      const activeOtherId = strictExchangeId(
        result?.activeOtherStop, ["orderId", "orderID"],
        "split_upgrade_cancel_active_other_id",
      );
      if (result?.verified !== true ||
          result.symbol !== symbolName(symbol) ||
          result.positionId !== details.positionId ||
          result.upgradeIntentId !== details.upgradeIntentId ||
          !["CANCELED", "CANCELLED"].includes(String(result.status ?? "").toUpperCase()) ||
          result.canceledStopOrderId !== details.oldStop.orderId ||
          !sameDecimal(exactDecimal(result.quantity, "split_upgrade_cancel_quantity"),
            exactDecimal(details.totalQuantity, "split_upgrade_expected_total")) ||
          activeNewId !== details.newStop.orderId ||
          result.activeUpgradedStop.tranche !== details.leg ||
          !sameDecimal(exactDecimal(result.activeUpgradedStop.quantity,
            "split_upgrade_cancel_active_new_quantity"),
          exactDecimal(details.newStop.quantity, "split_upgrade_expected_new_quantity")) ||
          !sameDecimal(exactDecimal(result.activeUpgradedStop.stopPrice,
            "split_upgrade_cancel_active_new_price"),
          exactDecimal(details.newStop.stopPrice, "split_upgrade_expected_new_price")) ||
          activeOtherId !== details.otherStop.orderId ||
          result.activeOtherStop.tranche !== details.otherStop.tranche ||
          !sameDecimal(exactDecimal(result.activeOtherStop.quantity,
            "split_upgrade_cancel_active_other_quantity"),
          exactDecimal(details.otherStop.quantity,
            "split_upgrade_expected_other_quantity")) ||
          !sameDecimal(exactDecimal(result.activeOtherStop.stopPrice,
            "split_upgrade_cancel_active_other_price"),
          exactDecimal(details.otherStop.stopPrice,
            "split_upgrade_expected_other_price"))) {
        throw new Error("bingx_vst_split_leg_stop_cancel_adapter_result_unverified");
      }
      return;
    }

    if (request.operation === "cancel_original_stop") {
      apiIntentIds.set(exchangeClientId, { phase, status: "submitted" });
      await performCancelOriginalStop({ clientOrderId, request, mutationContext });
      return;
    }

    if (request.operation === "cancel_original_after_runner_fill") {
      await performCancelOriginalAfterRunnerFill({ clientOrderId, request });
      return;
    }

    if (request.operation === "cancel_split_stop") {
      apiIntentIds.set(exchangeClientId, { phase, status: "submitted" });
      await performSplitStopCleanup({ clientOrderId, request });
      return;
    }

    if (request.operation === "close_leg") {
      if (request.signal?.patternId === "impulse_buy") {
        apiIntentIds.set(exchangeClientId, { phase, status: "submitted" });
        await performSplitPartialClose({
          clientOrderId,
          exchangeClientId,
          request,
        });
        return;
      }
      const position = await readPosition(symbol, {
        persistedPosition: positionSnapshotFromRequest(request) ?? undefined,
        allowProcessCache: false,
      });
      if (!position.positionId || !closeEnough(
        request.quantity, request.previousQuantity, request.previousQuantity,
      ) || !closeEnough(position.quantity, request.previousQuantity, request.previousQuantity) ||
          request.positionId !== undefined && request.positionId !== position.positionId) {
        throw new Error("bingx_vst_only_exact_whole_position_close_is_supported");
      }
      if (request.protectedExit) {
        const exit = validateProtectedExit(request.protectedExit, {
          symbol, positionId: position.positionId, quantity: request.quantity,
        });
        if (exit.sourceSignalId !== request.sourceSignalId ||
            request.priorPosition?.protectionDegradation?.originalClientOrderId !==
              exit.originalClientOrderId ||
            exit.reason !== request.reason || exit.entryOrderId !== request.entryOrderId) {
          throw new Error("bingx_vst_protected_exit_provenance_mismatch");
        }
        await verifyEntryIdentityAndFills({
          symbol, rawClientOrderId: request.entryClientOrderId,
          expectedPositionId: position.positionId, request,
        });
      }
      apiIntentIds.set(exchangeClientId, { phase, status: "submitted" });
      await performMutation("closeLong",
        symbol,
        String(request.quantity),
        exchangeClientId,
        position.positionId,
        { automatedLongPolicy: VST_AUTOMATED_LONG_POLICY,
          ...(request.protectedExit ? { protectedExit: request.protectedExit } : {}) },
      );
      return;
    }
    if (request.operation === "close_survivor") {
      const details = soleSplitLegCloseDetails(request, clientOrderId);
      if (typeof api.closeVstAutomatedSoleSplitLeg !== "function") {
        throw new Error("bingx_vst_sole_split_leg_close_adapter_unavailable");
      }
      apiIntentIds.set(exchangeClientId, { phase, status: "submitted" });
      const result = await performMutation("closeVstAutomatedSoleSplitLeg", {
        symbol,
        policy: VST_AUTOMATED_LONG_POLICY,
        positionId: details.positionId,
        quantity: details.quantity,
        stop: details.stop,
        clientOrderId: details.exchangeClientOrderId,
        closeIntentId: details.closeIntentId,
      });
      const fill = result?.verified === true
        ? exactCommissionedFillSummary(result.fills, {
          symbol,
          exchangeOrderId: result.closeOrderId,
          side: "SELL",
          expectedQuantity: details.quantity,
        }) : null;
      if (!fill ||
          result.symbol !== symbolName(symbol) ||
          result.positionId !== details.positionId ||
          result.clientOrderId !== details.exchangeClientOrderId ||
          result.closeIntentId !== details.closeIntentId ||
          !sameDecimal(exactDecimal(result.closedQuantity,
            "sole_split_close_result_quantity"),
          exactDecimal(details.quantity, "sole_split_close_expected_quantity")) ||
          result.canceledStopOrderId !== details.stop.orderId ||
          result.status !== "FILLED" ||
          result.flat !== true || result.noOpenStops !== true) {
        throw new Error("bingx_vst_sole_split_leg_close_adapter_result_unverified");
      }
      return;
    }
    if (request.operation === "close_split_all") {
      const details = fullSplitCloseDetails(request, clientOrderId);
      if (typeof api.closeVstAutomatedFullSplitPosition !== "function") {
        throw new Error("bingx_vst_full_split_close_adapter_unavailable");
      }
      apiIntentIds.set(exchangeClientId, { phase, status: "submitted" });
      const result = await performMutation("closeVstAutomatedFullSplitPosition", {
        symbol,
        policy: VST_AUTOMATED_LONG_POLICY,
        positionId: details.positionId,
        totalQuantity: details.totalQuantity,
        coreStop: details.coreStop,
        runnerStop: details.runnerStop,
        clientOrderId: details.exchangeClientOrderId,
        closeIntentId: details.closeIntentId,
      });
      const fill = result?.verified === true
        ? exactCommissionedFillSummary(result.fills, {
          symbol,
          exchangeOrderId: result.closeOrderId,
          side: "SELL",
          expectedQuantity: details.totalQuantity,
        }) : null;
      const remainingIds = result?.remainingKnownStopOrderIds;
      if (!fill ||
          result.symbol !== symbolName(symbol) ||
          result.positionId !== details.positionId ||
          result.clientOrderId !== details.exchangeClientOrderId ||
          result.closeIntentId !== details.closeIntentId ||
          !sameDecimal(exactDecimal(result.closedQuantity,
            "full_split_close_result_quantity"),
          exactDecimal(details.totalQuantity, "full_split_close_expected_quantity")) ||
          result.flat !== true ||
          !Array.isArray(remainingIds) || remainingIds.length > 2 ||
          remainingIds.some((id) => typeof id !== "string" ||
            !details.stops.some((stop) => stop.orderId === id)) ||
          new Set(remainingIds).size !== remainingIds.length ||
          result.fullyCleaned !== (remainingIds.length === 0) ||
          result.stopCleanupRequired !== (remainingIds.length > 0) ||
          !Array.isArray(result.fees) || result.fees.length !== result.fills.length) {
        throw new Error("bingx_vst_full_split_close_adapter_result_unverified");
      }
      return;
    }
    if (request.operation === "close_pre_runner_split") {
      const details = preRunnerSplitCloseDetails(request, clientOrderId);
      if (typeof api.closeVstAutomatedPreRunnerSplit !== "function") {
        throw new Error("bingx_vst_pre_runner_split_close_adapter_unavailable");
      }
      apiIntentIds.set(exchangeClientId, { phase, status: "submitted" });
      const result = await performMutation("closeVstAutomatedPreRunnerSplit", {
        symbol,
        policy: VST_AUTOMATED_LONG_POLICY,
        positionId: details.positionId,
        totalQuantity: details.totalQuantity,
        originalStop: details.originalStop,
        coreStop: details.coreStop,
        clientOrderId: details.exchangeClientOrderId,
        closeIntentId: details.closeIntentId,
      });
      const remainingIds = result?.remainingKnownStopOrderIds;
      if (result?.verified !== true ||
          result.flat !== true ||
          !Array.isArray(remainingIds) || remainingIds.length > details.stops.length ||
          remainingIds.some((id) => typeof id !== "string" ||
            !details.stops.some((stop) => stop.orderId === id)) ||
          new Set(remainingIds).size !== remainingIds.length ||
          result.symbol !== undefined && result.symbol !== symbolName(symbol) ||
          result.positionId !== undefined && result.positionId !== details.positionId ||
          result.clientOrderId !== undefined &&
            result.clientOrderId !== details.exchangeClientOrderId ||
          result.closeIntentId !== undefined &&
            result.closeIntentId !== details.closeIntentId) {
        throw new Error("bingx_vst_pre_runner_split_close_adapter_result_unverified");
      }
      return;
    }
    if (request.operation === "cancel_flat_split_stop") {
      const details = flatSplitStopCleanupDetails(request);
      if (typeof api.cancelVstAutomatedKnownStopWhenFlat !== "function") {
        throw new Error("bingx_vst_flat_split_cleanup_adapter_unavailable");
      }
      apiIntentIds.set(exchangeClientId, { phase, status: "submitted" });
      const result = await performMutation("cancelVstAutomatedKnownStopWhenFlat", {
        symbol,
        policy: VST_AUTOMATED_LONG_POLICY,
        positionId: details.positionId,
        stopToCancel: details.stopToCancel,
        knownRemainingStopOrderIds: details.knownRemainingStopOrderIds,
        cancellationIntentId: details.cancellationIntentId,
        ...(details.entryOrderId ? { entryOrderId: details.entryOrderId } : {}),
      });
      const remainingIds = result?.remainingKnownStopOrderIds;
      const knownIds = result?.knownRemainingStopOrderIds;
      if (result?.verified !== true ||
          result.symbol !== symbolName(symbol) ||
          result.positionId !== details.positionId ||
          result.cancellationIntentId !== details.cancellationIntentId ||
          result.canceledStopOrderId !== details.stopToCancel.orderId ||
          !["CANCELED", "CANCELLED"].includes(String(result.status ?? "").toUpperCase()) ||
          result.flat !== true ||
          !Array.isArray(knownIds) ||
          JSON.stringify(knownIds.slice().sort()) !==
            JSON.stringify(details.knownRemainingStopOrderIds.slice().sort()) ||
          !Array.isArray(remainingIds) ||
          remainingIds.some((id) => typeof id !== "string" ||
            !details.knownRemainingStopOrderIds.includes(id) ||
            id === details.stopToCancel.orderId) ||
          new Set(remainingIds).size !== remainingIds.length) {
        throw new Error("bingx_vst_flat_split_cleanup_adapter_result_unverified");
      }
      return;
    }
    throw new Error(`bingx_vst_unsupported_operation:${String(request.operation)}`);
  }

  async function verifyCurrentDegradedProtection({ request, progress, observedProtection = null }) {
    const failed = { verified: false, status: "unknown" };
    try {
      if (request?.operation !== "raise_stop" || request.environment !== "vst" ||
          request.accountId !== accountId || request.leg !== "core" ||
          (request.stopTransferProtocol != null &&
            !(request.stopTransferProtocol === 1 && progress?.version === 1 &&
              progress.stage === "post_started"))) return failed;
      const prior = request.priorPosition;
      const historicalStop = prior?.verifiedProtectiveStops?.core;
      const stop = observedProtection ?? historicalStop;
      const proof = request.entryProof;
      if (prior?.coreOpen !== true || prior.runnerOpen !== false || prior.split != null ||
          stop?.verified !== true || !object(proof) ||
          !sameDecimal(exactDecimal(stop.quantity, "degraded_stop_quantity"),
            exactDecimal(request.quantity, "degraded_request_quantity")) ||
          !sameDecimal(exactDecimal(prior.remainingQty, "degraded_remaining_quantity"),
            exactDecimal(request.quantity, "degraded_request_quantity")) ||
          compareDecimal(exactDecimal(request.stopPrice, "degraded_requested_price"),
            exactDecimal(historicalStop?.stopPrice, "degraded_floor_price")) <= 0) return failed;
      const startedAt = Number(clock());
      const entry = await verifyEntryIdentityAndFills({
        symbol: request.symbol, rawClientOrderId: proof.entryClientOrderId,
        expectedPositionId: request.positionId, request,
      });
      if (entry.exchangeOrderId !== proof.entryOrderId ||
          !sameDecimal(exactDecimal(entry.fill.quantity, "degraded_entry_fill_quantity"),
            exactDecimal(proof.quantity, "degraded_entry_proof_quantity"))) return failed;
      // Independent exact lookup AND native open-list linkage; query endpoints
      // may return positionID=0 but cannot override the live open-list identity.
      const exact = await api.queryOrder(request.symbol, { orderId: stop.orderId });
      const ids = [exact?.positionId, exact?.positionID].filter(v => v != null);
      const normalized = { ...exact, positionId: request.positionId, positionID: request.positionId };
      const unfilled = row => row?.executedQty != null &&
        ["executedQty", "cumExecQty", "dealSize", "filledQty", "executedQuantity"]
          .filter(key => Object.hasOwn(row, key))
          .every(key => row[key] != null && Number(row[key]) === 0);
      if (!ids.length || ids.some(v => String(v) !== "0" && String(v) !== request.positionId) ||
          !exactOpenSplitStop(normalized, {
            symbol: request.symbol, positionId: request.positionId,
            entryOrderId: proof.entryOrderId, id: stop.orderId,
            quantity: stop.quantity, stopPrice: stop.stopPrice,
          }) || !unfilled(exact)) return failed;
      // Two separately requested native cohorts, never the process cache.
      const baseline = observedProtection ? {
        ...request, priorPosition: {
          ...prior, stopPrice: Number(stop.stopPrice), coreStopPrice: Number(stop.stopPrice),
          coreStopOrderId: stop.orderId, coreStopQuantity: stop.quantity,
          verifiedProtectiveStops: { ...prior.verifiedProtectiveStops, core: stop },
        },
      } : request;
      for (let pass = 0; pass < 2; pass++) {
        if (!await verifyPreparedStopTransfer(baseline)) return failed;
        const orders = await api.getOpenOrders(request.symbol);
        if (orders.length !== 1 || !unfilled(orders[0]) ||
            orderId(orders[0]) !== stop.orderId) return failed;
      }
      const observedAt = Number(clock());
      if (observedAt < startedAt || observedAt - startedAt > 30_000) return failed;
      return {
        verified: true, status: "protected_degraded", currentProtectionOnly: true,
        currentProtectionObservedAt: observedAt,
        protectiveStops: { core: structuredClone(stop) },
      };
    } catch (error) {
      return attachVstResultDiagnostic(failed, recordVstDiagnostic(error, {
        stage: "reconciliation", operation: "raise_stop",
        check: "protective_stop", symbol: request?.symbol,
      }));
    }
  }

  async function verifyProtectedDegradedRaiseStop(input) {
    return verifyCurrentDegradedProtection(input);
  }

  async function verifyObservedDegradedProtection({ request, progress }) {
    try {
      const orders = await api.getOpenOrders(request.symbol);
      if (!Array.isArray(orders) || orders.length !== 1) return { verified: false, status: "unknown" };
      const candidate = orders[0];
      if (!sameDecimal(exactDecimal(candidate.stopPrice, "observed_degraded_stop_price"),
          exactDecimal(request.stopPrice, "observed_degraded_requested_price"))) {
        return { verified: false, status: "unknown" };
      }
      const observedProtection = {
        verified: true, tranche: "core", orderId: orderId(candidate),
        positionId: request.positionId, quantity: String(request.quantity),
        stopPrice: String(request.stopPrice),
      };
      const evidence = await verifyCurrentDegradedProtection({ request, progress, observedProtection });
      return evidence.verified === true ? {
        ...evidence, status: "filled", exchangeOrderId: observedProtection.orderId,
        observationOnly: true, originalWriteAttributed: false,
      } : evidence;
    } catch (error) {
      return attachVstResultDiagnostic({ verified: false, status: "unknown" },
        recordVstDiagnostic(error, {
          stage: "reconciliation", operation: "raise_stop", check: "protective_stop",
          symbol: request?.symbol,
        }));
    }
  }

  async function verifyPreparedStopTransfer(request) {
    const prior = request.priorPosition;
    if (!prior || prior.environment !== "vst" || prior.accountId !== accountId ||
        prior.exchangePositionId !== request.positionId) return false;
    const startedAt = Date.now();
    // No historical fill search is needed to prove this boundary: the journal
    // proves no write, while current native rows must prove unchanged protection.
    const [settings, positions, orders] = await Promise.all([
      readSettings(request.symbol), api.getPositions(request.symbol),
      api.getOpenOrders(request.symbol),
    ]);
    const name = assertSymbol(request.symbol);
    if (!Array.isArray(positions) || !Array.isArray(orders)) return false;
    const active = positions.filter(row => row.symbol === name &&
      strictNumber(row.positionAmt, "stop_transfer_position_quantity", { allowZero: true }) !== 0);
    const expected = Object.values(prior.verifiedProtectiveStops ?? {});
    return Date.now() - startedAt <= 10_000 && settings.mode === "HEDGE" &&
      settings.marginMode === PROFILE_MARGIN && Number(settings.leverage.longLeverage) === PROFILE_LEVERAGE &&
      active.length === 1 && active[0].positionSide === "LONG" &&
      [active[0].positionId, active[0].positionID].filter(v => v != null)
        .every(v => String(v) === prior.exchangePositionId) &&
      positionId(active[0]) === prior.exchangePositionId &&
      sameDecimal(exactDecimal(active[0].positionAmt, "stop_transfer_position_quantity"),
        exactDecimal(prior.remainingQty, "stop_transfer_remaining_quantity")) &&
      expected.length > 0 && orders.length === expected.length &&
      new Set(orders.map(row => orderId(row))).size === expected.length &&
      expected.every(stop => orders.some(row => row.status === "NEW" &&
        [row.positionId, row.positionID].filter(v => v != null)
          .every(v => String(v) === prior.exchangePositionId) &&
        [row.orderId, row.orderID].filter(v => v != null)
          .every(v => String(v) === stop.orderId) &&
        exactOpenSplitStop(row, {
          symbol: request.symbol, positionId: prior.exchangePositionId,
          entryOrderId: prior.entryOrderId ?? prior.split?.entryOrderId,
          id: stop.orderId, quantity: stop.quantity, stopPrice: stop.stopPrice,
        })));
  }

  async function resumeStopTransferCancellation({ intent, stopTransferJournal }) {
    const request = intent.request;
    const progress = stopTransferJournal.getProgress();
    if (request.operation !== "raise_stop" || request.stopTransferProtocol !== 1 ||
        progress.stage !== "post_acknowledged" ||
        progress.newStopOrderId !== intent.exchangeOrderId ||
        typeof api.withStopTransferJournal !== "function") {
      throw new Error("bingx_vst_stop_transfer_cancellation_resume_forbidden");
    }
    const old = request.priorPosition?.verifiedProtectiveStops?.[request.leg] ??
      request.priorPosition?.verifiedProtectiveStops?.core;
    const entry = request.entryProof?.entryOrderId;
    return api.withStopTransferJournal(stopTransferJournal, () =>
      performMutation("retireVstAutomatedAdoptedStop", {
        symbol: request.symbol, policy: VST_AUTOMATED_LONG_POLICY,
        positionId: request.positionId, entryOrderId: entry,
        oldStopOrderId: old?.orderId, oldStopPrice: String(old?.stopPrice),
        newStopOrderId: intent.exchangeOrderId, stopPrice: request.stopPrice,
        quantity: String(request.quantity), cancellationIntentId: intent.clientOrderId,
      }));
  }

  async function getCapabilities(recordTiming = () => {}) {
    try {
      return await assessCapabilities(recordTiming);
    } catch (error) {
      successfulLookupProbe = null;
      throw error;
    }
  }

  async function assessCapabilities(recordTiming) {
    let stageStarted = performance.now();
    const reportTiming = (name, started) => {
      // Diagnostics must not change the exchange safety decision.
      try { recordTiming(name, performance.now() - started); } catch {}
    };
    const historyWindowNow = Number(clock());
    if (!Number.isSafeInteger(historyWindowNow) || historyWindowNow <= 0) {
      throw new Error("bingx_vst_clock_invalid");
    }
    const [balance, rawPositions, rawOrders] = await Promise.all([
      readCoalesced("getBalance"),
      readCoalesced("getPositions"),
      readCoalesced("getOpenOrders"),
    ]);
    reportTiming("capabilityAccountSnapshot", stageStarted);
    const positions = validateAccountPositions(rawPositions);
    const accountOrders = validateAccountOrders(rawOrders);
    const activeExchangeNames = [...new Set(positions.filter((row) =>
      Number(row.positionAmt) !== 0).map((row) =>
      exchangeCanonicalSymbol(row.symbol, "active_position")))];
    const orderExchangeNames = [...new Set(accountOrders.map((row) =>
      exchangeCanonicalSymbol(row.symbol, "account_order")))];
    const probeNames = activeExchangeNames.length > 0
      ? activeExchangeNames
      : orderExchangeNames.length > 0 ? orderExchangeNames : startupSymbols.map(symbolName);
    const probeSymbols = probeNames.map((name) => name.replace("-", ""));
    const lookupSymbol = (activeExchangeNames[0] ?? orderExchangeNames[0] ??
      symbolName(startupSymbols[0])).replace("-", "");
    // Reuse only protocol availability, not historical rows or execution
    // proofs. Live account exposure/settings are ALWAYS read below; actual
    // actions independently query their exact native orders and fills.
    const probeAge = historyWindowNow - successfulLookupProbe?.observedAt;
    const reuseLookupProbe = successfulLookupProbe?.symbol === lookupSymbol &&
      Number.isFinite(probeAge) && probeAge >= 0 && probeAge < lookupProbeTtlMs;
    stageStarted = performance.now();
    // History is independent of per-symbol settings. Keep the capability
    // probe limited to account-wide safety and the mode/leverage settings
    // needed to verify each active (or residual-stop) symbol. Contract
    // filters, fees, risk tiers, and marks are read fresh for the actual
    // target signal by readPlanningInputs().
    const [recentHistory, recentFills, mode, symbolReads] = await Promise.all([
      reuseLookupProbe ? null : readCoalesced("queryOrderHistory", lookupSymbol, {
        startTs: Math.max(1, historyWindowNow - MAX_HISTORY_WINDOW_MS),
        endTs: historyWindowNow,
      }),
      reuseLookupProbe ? null : readCoalesced("queryFills", lookupSymbol, {
        startTs: Math.max(1, historyWindowNow - MAX_HISTORY_WINDOW_MS),
        endTs: historyWindowNow,
        currency: "USDT",
      }),
      // Position mode is account-wide, not per-symbol.
      readCoalesced("getPositionMode"),
      // One symbol's settings read failing (BingX 100410 rate limit on
      // marginType/leverage with several open positions, 2026-10-26) used to
      // fail the WHOLE capability check, so no signal could enter. Now only
      // that symbol is left unverified for this tick (unverifiedSymbols):
      // it is not managed/mutated until a later read proves its settings,
      // while every other symbol and new entries keep working.
      mapWithConcurrency(probeSymbols, 3, async (symbol) => {
        try {
          return await readCapabilitySymbolSettings(symbol, historyWindowNow);
        } catch (error) {
          if (!isTransientSymbolSettingsError(error)) throw error;
          return { symbol, marginMode: null, leverage: null, readFailed: true };
        }
      }),
    ]);
    reportTiming("capabilityHistoryAndSymbolReads", stageStarted);
    const settingsBySymbol = symbolReads.map(({ marginMode, leverage }) =>
      ({ mode, marginMode, leverage }));
    const balanceRows = Array.isArray(balance) ? balance
      : Array.isArray(balance?.balance) ? balance.balance
        : object(balance?.balance) ? [balance.balance] : [];
    if (balanceRows.filter((row) => row?.asset === "VST").length !== 1 ||
        (!reuseLookupProbe && (!boundedRows(recentHistory) || !boundedRows(recentFills)))) {
      throw new Error("bingx_vst_account_or_order_reads_unverified");
    }
    const accountFlatWithoutOrders = positions.every((row) =>
      Number(row.positionAmt) === 0) && accountOrders.length === 0;
    const canPrepareSettings = settingsBySymbol.some((settings, index) => {
      if (settings.mode !== "HEDGE" ||
          !["ISOLATED", "CROSSED"].includes(settings.marginMode)) return false;
      if (settings.marginMode !== PROFILE_MARGIN && !hasIsolatedMarginPreparation) return false;
      if (Number(settings.leverage?.longLeverage) === PROFILE_LEVERAGE) return true;
      return accountFlatWithoutOrders &&
        Number(settings.leverage?.longLeverage) > 0;
    });
    const canEnter = accountFlatWithoutOrders && canPrepareSettings;
    // Empty recent windows are valid: no prior trade is required for the
    // read-only history-to-ID/fills-by-ID protocol to be available.
    let hasVerifiedCompleteLookup = true;
    const sampleCandidates = (recentHistory ?? []).filter((row) =>
      typeof orderClientId(row) === "string" && orderClientId(row).length > 0);
    const sample = sampleCandidates.find((row) => {
      const executedValue = row.executedQty ?? row.cumExecQty ?? row.filledQty;
      return String(row.status ?? "").toUpperCase() === "FILLED" ||
        executedValue !== undefined && executedValue !== null &&
          Number.isFinite(Number(executedValue)) && Number(executedValue) > 0;
    }) ?? sampleCandidates[0];
    stageStarted = performance.now();
    if (sample) {
      hasVerifiedCompleteLookup = false;
      try {
        const sampleOrderId = orderId(sample);
        const executedValue = sample.executedQty ?? sample.cumExecQty ?? sample.filledQty;
        const executed = executedValue === undefined || executedValue === null
          ? 0 : strictNumber(executedValue, "capability_sample_executed_quantity", {
            allowZero: true,
          });
        const sampleStatus = String(sample.status ?? "").toUpperCase();
        const knownStatus = [
          "FILLED", "NEW", "PARTIALLY_FILLED", "PENDING", "OPEN",
          "REJECTED", "EXPIRED", "CANCELED", "CANCELLED",
        ].includes(sampleStatus);
        const requiresFills = sampleStatus === "FILLED" || executed > 0;
        let matchingFillCount = 0;
        let hasConsistentFillEvidence = true;
        if (requiresFills) {
          const currencyReads = await Promise.all(["VST", "USDT"].map((currency) =>
            readCoalesced("queryFills", lookupSymbol, {
              startTs: Math.max(1, historyWindowNow - MAX_HISTORY_WINDOW_MS),
              endTs: historyWindowNow,
              orderId: sampleOrderId,
              currency,
            })));
          if (!currencyReads.every(boundedRows)) {
            hasConsistentFillEvidence = false;
          } else {
            const byFillIdentity = new Map();
            for (const scopedFills of currencyReads) {
              for (const fill of scopedFills) {
                if (fill?.symbol !== symbolName(lookupSymbol) ||
                    orderId(fill) !== sampleOrderId) {
                  hasConsistentFillEvidence = false;
                  continue;
                }
                // BingX may return a USDT-denominated fill from either VST
                // or USDT currency-scoped queries. Trust exact fill identity
                // and matching contents, not equality with the query scope.
                const signature = JSON.stringify({
                  symbol: fill.symbol,
                  orderId: sampleOrderId,
                  quantity: String(fill.qty ?? fill.quantity ?? fill.volume ?? ""),
                  price: String(fill.price ?? fill.tradePrice ?? fill.fillPrice ?? ""),
                  time: String(fill.filledTm ?? fill.filledTime ??
                    fill.time ?? fill.timestamp ?? fill.tradeTime ?? ""),
                  side: String(fill.side ?? ""),
                  positionSide: String(fill.positionSide ?? ""),
                  commission: String(fill.commission ?? fill.fee ??
                    fill.commissionAmount ?? fill.feeAmount ?? ""),
                  currency: String(fill.currency ?? fill.commissionAsset ?? ""),
                });
                const rawFillId = fill.tradeId ?? fill.tradeID ??
                  fill.fillId ?? fill.fillID ?? fill.id;
                const identity = rawFillId === undefined || rawFillId === null ||
                  String(rawFillId).trim() === ""
                  ? `row:${signature}` : `id:${exactIdentifier(rawFillId,
                    "capability_sample_fill_id")}`;
                const existingSignature = byFillIdentity.get(identity);
                if (existingSignature !== undefined && existingSignature !== signature) {
                  hasConsistentFillEvidence = false;
                } else if (existingSignature === undefined) {
                  byFillIdentity.set(identity, signature);
                }
              }
            }
            matchingFillCount = byFillIdentity.size;
          }
        }
        hasVerifiedCompleteLookup = sample.symbol === symbolName(lookupSymbol) &&
          knownStatus && hasConsistentFillEvidence &&
          (!requiresFills || matchingFillCount > 0);
      } catch {
        hasVerifiedCompleteLookup = false;
      }
    }
    reportTiming("capabilityLookupSample", stageStarted);
    if (!reuseLookupProbe) {
      successfulLookupProbe = hasVerifiedCompleteLookup
        ? { symbol: lookupSymbol, observedAt: historyWindowNow } : null;
    }
    reportTiming(reuseLookupProbe
      ? "capabilityLookupProtocolReused" : "capabilityLookupProtocolRefreshed",
    performance.now());
    const missingImpulseAdapters = missingImpulseAdapterMethods();
    const verifiedActiveLongProtection = (symbol, rows, orders) => {
      try {
        const name = symbolName(symbol);
        const active = rows.filter((row) => row?.symbol === name &&
          Number(row.positionAmt) !== 0);
        if (active.length !== 1 || active[0].positionSide !== "LONG" ||
            !Array.isArray(orders) || orders.length === 0 || orders.length > 3) {
          return false;
        }
        const activePositionId = positionId(active[0]);
        const positionQuantity = exactDecimal(active[0].positionAmt,
          "impulse_active_position_quantity");
        let protectedQuantity = { amount: 0n, scale: 0 };
        const orderIds = new Set();
        const parentIds = new Set();
        for (const order of orders) {
          if (order?.symbol !== name || order.type !== "STOP_MARKET" ||
              order.status !== "NEW" || order.side !== "SELL" ||
              order.positionSide !== "LONG" || order.workingType !== "MARK_PRICE" ||
              positionId(order) !== activePositionId) return false;
          const id = orderId(order);
          if (orderIds.has(id)) return false;
          orderIds.add(id);
          const quantity = exactDecimal(order.origQty ?? order.quantity,
            "impulse_protective_stop_quantity");
          const stopPrice = exactDecimal(order.stopPrice, "impulse_protective_stop_price");
          if (quantity.amount <= 0n || stopPrice.amount <= 0n) return false;
          const scale = Math.max(protectedQuantity.scale, quantity.scale);
          protectedQuantity = {
            amount: decimalAtScale(protectedQuantity, scale) +
              decimalAtScale(quantity, scale),
            scale,
          };
          const parent = order.mainOrderId ?? order.parentOrderId;
          if (parent !== undefined && parent !== null && parent !== "") {
            parentIds.add(exactIdentifier(parent, "impulse_stop_parent_id"));
          }
        }
        return parentIds.size <= 1 &&
          compareDecimal(protectedQuantity, positionQuantity) >= 0;
      } catch {
        return false;
      }
    };
    const activePositions = positions.filter((row) => Number(row.positionAmt) !== 0);
    const activeSymbols = [...new Set(activePositions.map((row) =>
      exchangeCanonicalSymbol(row.symbol, "active_position").replace("-", "")))];
    const activeSymbolSet = new Set(activeSymbols.map(symbolName));
    const verifiedFlatCleanupOrders = (() => {
      if (activePositions.length !== 0 || accountOrders.length === 0 ||
          orderExchangeNames.length !== 1 || accountOrders.length > 3) {
        return false;
      }
      const expectedSymbol = orderExchangeNames[0];
      try {
        return accountOrders.every((order) => {
          if (order.symbol !== expectedSymbol || order.type !== "STOP_MARKET" ||
              order.status !== "NEW" || order.side !== "SELL" ||
              order.positionSide !== "LONG" || order.workingType !== "MARK_PRICE") {
            return false;
          }
          positionId(order);
          exactDecimal(order.origQty ?? order.quantity,
            "impulse_flat_cleanup_stop_quantity");
          exactDecimal(order.stopPrice, "impulse_flat_cleanup_stop_price");
          return true;
        });
      } catch {
        return false;
      }
    })();
    const activeManagementSymbols = [...new Set([
      ...activeSymbols,
      ...(verifiedFlatCleanupOrders
        ? orderExchangeNames.map((name) => name.replace("-", "")) : []),
    ])];
    const impulseAccountReady = activePositions.length === 0
      ? accountFlatWithoutOrders
        ? canEnter
        : verifiedFlatCleanupOrders && (() => {
          const symbol = orderExchangeNames[0].replace("-", "");
          const index = probeSymbols.indexOf(symbol);
          if (index < 0) return false;
          const settings = settingsBySymbol[index];
          return settings.mode === "HEDGE" && settings.marginMode === PROFILE_MARGIN &&
            Number(settings.leverage?.longLeverage) === PROFILE_LEVERAGE;
        })()
      // Many symbols can each carry their own independently verified
      // position concurrently -- every active symbol must pass this check
      // on its own filtered rows, but the ACCOUNT is no longer required to
      // hold only one active position/symbol in total.
      : activeSymbols.length > 0 &&
        activeSymbols.every((symbol) => {
        const index = probeSymbols.indexOf(symbol);
        if (index < 0) return false;
        const settings = settingsBySymbol[index];
        const symbolNameValue = symbolName(symbol);
        const matchingPositions = activePositions.filter((row) =>
          row.symbol === symbolNameValue);
        const matchingOrders = accountOrders.filter((row) =>
          row.symbol === symbolNameValue);
        return Number(settings.leverage?.longLeverage) === PROFILE_LEVERAGE &&
          settings.mode === "HEDGE" && settings.marginMode === PROFILE_MARGIN &&
          verifiedActiveLongProtection(symbol, matchingPositions, matchingOrders);
      }) && accountOrders.every((row) => activeSymbolSet.has(row.symbol));
    const canManageImpulse = missingImpulseAdapters.length === 0 &&
      hasVerifiedCompleteLookup && impulseAccountReady;
    // Symbol-scoped health: one deviating symbol (missing/extra stop, wrong
    // leverage, orphan order) must quarantine ONLY that symbol, never freeze
    // entries/stops/closes for every other symbol on the account. Each
    // mutation is re-verified against its own symbol's fresh rows before
    // signing (entry requires a flat symbol, management reads only its symbol).
    const unhealthyActiveSymbols = activeSymbols.filter((symbol) => {
      const index = probeSymbols.indexOf(symbol);
      if (index < 0) return true;
      const settings = settingsBySymbol[index];
      const name = symbolName(symbol);
      return !(Number(settings.leverage?.longLeverage) === PROFILE_LEVERAGE &&
        settings.mode === "HEDGE" && settings.marginMode === PROFILE_MARGIN &&
        verifiedActiveLongProtection(symbol,
          activePositions.filter((row) => row.symbol === name),
          accountOrders.filter((row) => row.symbol === name)));
    });
    const orphanOrderSymbols = activePositions.length === 0 && verifiedFlatCleanupOrders
      ? []
      : orderExchangeNames.filter((name) => !activeSymbolSet.has(name))
        .map((name) => name.replace("-", ""));
    const unverifiedSymbols = [...new Set([
      ...unhealthyActiveSymbols, ...orphanOrderSymbols,
    ])];
    const symbolScopedCoreReady = mode === "HEDGE" &&
      (activePositions.length > 0 || accountOrders.length > 0);
    const canManageCorePosition = canEnter ||
      activePositions.length > 0 && impulseAccountReady ||
      symbolScopedCoreReady;
    // Source exits have a narrower authorization path than strategy/core
    // management: advertise it from fresh symbol-scoped position, owned-stop,
    // and HEDGE/ISOLATED LONG 10x reads. Source lineage and exact stop IDs are
    // still checked against the durable request immediately before signing.
    const canVerifySourceFullPositionClose =
      typeof api.closeLong === "function" &&
      activeSymbols.some((symbol) => {
        const index = probeSymbols.indexOf(symbol);
        if (index < 0) return false;
        const settings = settingsBySymbol[index];
        const name = symbolName(symbol);
        const matchingPositions = activePositions.filter((row) =>
          row.symbol === name);
        const matchingOrders = accountOrders.filter((row) =>
          row.symbol === name);
        return Number(settings.leverage?.longLeverage) === PROFILE_LEVERAGE &&
          settings.mode === "HEDGE" && settings.marginMode === PROFILE_MARGIN &&
          verifiedActiveLongProtection(symbol, matchingPositions, matchingOrders);
      });
    // This only advertises that the current freshly-read VST account is in a
    // supported flat-stop-cleanup shape and the native adapter can perform the
    // cancellation. It does not authorize any order: performIntent still
    // requires source lineage, exact flatness, and exact owned-stop IDs.
    const canVerifySourceFlatStopCleanup = verifiedFlatCleanupOrders &&
      impulseAccountReady &&
      typeof api.cancelVstAutomatedKnownStopWhenFlat === "function";
    const impulseMissingReasons = [];
    if (missingImpulseAdapters.length > 0) {
      impulseMissingReasons.push(
        `Required automated VST adapter methods are unavailable: ${missingImpulseAdapters.join(", ")}.`,
      );
    }
    if (!canPrepareSettings || !impulseAccountReady) {
      impulseMissingReasons.push(
        "Fresh signed reads did not prove either a flat HEDGE/ISOLATED symbol safe for guarded LONG 10x preparation, or every active LONG 10x ISOLATED VST position protected only by matching stops with no foreign positions/orders.",
      );
    }
    if (!hasVerifiedCompleteLookup) {
      impulseMissingReasons.push(
        "The available history sample did not support a lossless order-ID-to-fills lookup required by split recovery.",
      );
    }
    const features = [
      "vst_only",
      "verified_position_state",
      ...(hasVerifiedCompleteLookup ? ["complete_order_lookup"] : []),
      ...(hasIsolatedMarginPreparation ? ["guarded_isolated_margin_preparation"] : []),
      ...(canManageCorePosition ? [
        "guarded_long10_leverage_preparation",
        "atomic_protected_market_entry",
        "verified_core_stop_state",
        "verified_exact_full_position_close",
      ] : []),
      ...(canVerifySourceFullPositionClose
        ? ["verified_exact_source_full_position_close"] : []),
      ...(canVerifySourceFlatStopCleanup
        ? ["verified_source_flat_stop_cleanup"] : []),
      ...(canManageImpulse ? ["impulse_runner_stop_and_partial_close"] : []),
    ];
    return {
      environment: "vst",
      verified: true,
      accountId,
      features,
      missingCapabilities: [
        ...(!canManageCorePosition ? [{
          capability: "guarded_long10_leverage_preparation",
          reason: "Fresh signed VST reads did not prove either LONG 10x already configured or a flat/no-order HEDGE isolated symbol that the guarded VST method can prepare.",
        }, {
          capability: "atomic_protected_market_entry",
          reason: "The account cannot safely enter until HEDGE isolated LONG 10x is already set or can be prepared by the guarded VST per-symbol leverage method.",
        }] : []),
        ...(!canManageCorePosition ? [{
          capability: "verified_core_stop_state",
          reason: "Core stop operations require LONG 10x to be verified or safely preparable in HEDGE isolated mode.",
        }, {
          capability: "verified_exact_full_position_close",
          reason: "Exact VST LONG closes require LONG 10x to be verified or safely preparable in HEDGE isolated mode.",
        }] : []),
        ...(!hasVerifiedCompleteLookup ? [{
          capability: "complete_order_lookup",
          reason: "The available history sample did not support a lossless order-ID-to-fills lookup.",
        }] : []),
        ...(!hasIsolatedMarginPreparation ? [{
          capability: "guarded_isolated_margin_preparation",
          reason: "The VST adapter does not provide the guarded flat-symbol isolated-margin preparation method.",
        }] : []),
        ...(!canManageImpulse ? [{
          capability: "impulse_runner_stop_and_partial_close",
          reason: impulseMissingReasons.join(" "),
        }] : []),
        ...(verifiedFlatCleanupOrders && !canVerifySourceFlatStopCleanup ? [{
          capability: "verified_source_flat_stop_cleanup",
          reason: "Fresh signed VST control reads did not prove safe LONG 10x HEDGE/ISOLATED settings or the native exact known-stop cancellation adapter is unavailable.",
        }] : []),
      ],
      unverifiedSymbols,
      evidence: {
        balanceAsset: "VST",
        signedOrderHistoryRead: true,
        signedFillHistoryRead: true,
        historyToIdFillQuerySampled: Boolean(sample),
        canarySymbols: startupSymbols,
        activeManagementSymbols,
        orderHistoryWindowEndMs: historyWindowNow,
      },
    };
  }

  return Object.freeze({
    ...(nativeApi.nativeFullTake ? {
      createNativeTakeProfitManager: (store, options = {}) => {
        nativeEvidenceStore = store;
        return createNativeTakeManager({
          api: nativeApi, store, clock, legacyExitStrategy: options.legacyExitStrategy,
          proveFill: (binding, stops) => proveNativeTakeFill(nativeApi, binding, stops, Number(clock())),
        });
      },
    } : {}),
    positionProfile: PROFILE,
    proveEntryNotExecuted,
    stopTransferJournalVersion: typeof api.withStopTransferJournal === "function" ? 1 : 0,
    verifyPreparedStopTransfer,
    verifyProtectedDegradedRaiseStop,
    verifyObservedDegradedProtection,
    resumeStopTransferCancellation,
    captureFillArchiveWindow,
    getCapabilities,
    readPlanningInputs,
    readAccountState,
    readHistoricalErrorClose,
    ...(supportsHistoricalCloseProof === undefined
      ? {} : { supportsHistoricalCloseProof }),
    readMarketMark,
    readLastPrices,
    readMarginTopUpBaseline,
    readMarginTopUpPlan,
    readMarginTopUpProtection,
    readMarginTopUpMargin,
    verifyMarginTopUpNotAdded,
    verifyEntryOrderProof,
    verifySourceExitEntryProof,
      verifyPreRunnerOpenForSourceExit,
    performIntent,
    reconcileIntent,
    verifyUnlinkedRaiseStopProtection,
    readPosition,
    observeTriggeredStop,
    readOriginalStopRefusalRunnerFillEvidence,
    readSentOriginalStopCancellationRunnerFillEvidence,
  });
}