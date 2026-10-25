import { createHash, randomUUID } from "node:crypto";
import { classifyVstUncertainty, uncertaintyOperation, protectedDegradedMarker, uncertaintyEvidenceKeys, reconcileVstUncertaintyEvidence } from "./vst-uncertainty.mjs";
import {
  STOP_TRANSFER_PROTOCOL, isStopTransferOperation, createStopTransferJournal,
  matchesPreparedStopTransferPosition,
} from "./stop-transfer-journal.mjs";
import { readCommittedStopCloseProof, committedHistoricalCloseProof } from "./vst-source-exit-closed-proof.mjs";
import { validateSourceCommand, directCloseRequest } from "./source-command-contract.mjs";
import { isSourceCancellation } from "./source-exit-evidence.mjs";
import { buildVstPositionCheckEvidence } from "./vst-stop-evidence.mjs";
import { FILL_ARCHIVE_RETENTION_MS } from "./vst-fill-archive.mjs";
import {
  createVstPolicy,
  evaluateVstPolicy,
  VST_POLICY_VERSION,
} from "./vst-policy.mjs";
import { sizeVstLongTrade } from "./vst-sizing.mjs";
import { OWNER_POSITION_PROFILE, normalizePositionProfile } from "./vst-position-profile.mjs";

function marginModeIs(value, profile) {
  const mode = String(value ?? "").toUpperCase();
  return (mode === "CROSS" ? "CROSSED" : mode) === profile.marginMode;
}
import { safeTickErrorSummary } from "./vst-tick-watchdog.mjs";
import { createVstReadAlertAggregator, createVstReadRecoveryTracker } from "./vst-read-alerts.mjs";
import { compareExactDecimals, exactDecimalParts } from "./vst-exact-decimal.mjs";
import { buildVstProofEvidence } from "./vst-proof-evidence.mjs";
import {
  attachVstResultDiagnostic,
  getVstResultDiagnosticRef,
  recordVstDiagnostic,
  recordVstRefusal,
  withVstDiagnosticContext,
} from "./vst-diagnostics.mjs";
import {
  buildVstUnresolvedIntentDiagnostic,
  logVstUnresolvedIntentDiagnostic,
  unresolvedIntentDiagnosticSignature,
} from "./vst-intent-diagnostics.mjs";
import { coordinateVstEntryBatch } from "./vst-entry-batch/coordinator.mjs";
import { evaluatePreRunnerCloseRetry } from "./vst-close-retry-guard.mjs";
import { applySourceProtection, evaluateSourceFollower } from "./source-position-control.mjs";
import { isTradablePatternId } from "./pattern-eligibility.mjs";
import { FULL_TAKE_5PCT, FULL_TAKE_REASON, fullTakeRequest, fullTakeRequestId,
  fullTakeEvidenceValid, fullTakeRowFromTouch } from "./fixed-price-take-profit.mjs";

function safeVstProofEvidence(source, getChecks) {
  try {
    return buildVstProofEvidence({ source, checks: getChecks() });
  } catch {
    return undefined;
  }
}

const REQUIRED_CAPABILITIES = [
  "vst_only",
  "complete_order_lookup",
  "guarded_long10_leverage_preparation",
  "atomic_protected_market_entry",
  "verified_core_stop_state",
  "verified_exact_full_position_close",
  "verified_position_state",
];
const SOURCE_EXIT_READ_CAPABILITIES = [
  "vst_only",
  "complete_order_lookup",
  "verified_position_state",
];
const SAFE_DIAGNOSTIC_REASONS = new Set([
  "broker_interface_unavailable",
  "capability_read_failed",
  "wrong_exchange_environment",
  "capabilities_unverified",
  "protective_capabilities_missing",
  "broker_interface_incomplete",
  "account_state_unverified",
  "account_state_not_verified",
  "verified_mutation_capabilities_unavailable",
  "source_exit_row_preflight_error",
  "impulse_runner_be_requires_fresh_mark_above_entry",
  "impulse_policy_snapshot_recovery_not_versionless_impulse",
  "impulse_policy_snapshot_recovery_provenance_mismatch",
  "impulse_policy_snapshot_recovery_saved_rules_invalid",
  "impulse_policy_snapshot_recovery_saved_entry_mismatch",
  "impulse_policy_snapshot_recovery_split_mismatch",
  "impulse_policy_snapshot_recovery_live_legs_mismatch",
  "impulse_policy_snapshot_recovery_closed_leg_stop_mismatch",
  "impulse_policy_snapshot_recovery_active_stop_mismatch",
  "impulse_policy_snapshot_recovery_protective_stops_mismatch",
  "impulse_policy_snapshot_recovery_exit_state_invalid",
  "impulse_policy_snapshot_recovery_last_fill_mismatch",
  "impulse_policy_snapshot_recovery_exchange_state_unverified",
  "impulse_policy_snapshot_recovery_policy_evaluation_failed",
  "impulse_policy_snapshot_recovery_persist_failed",
  "position_policy_state_invalid",
  "verified_market_mark_unavailable",
  "verified_vst_account_identity_unavailable",
]);
const PENDING_CANDIDATE_PAGE_SIZE = 200;
const PENDING_CANDIDATE_DIAGNOSTIC_PAGE_THRESHOLD = 5;
const MAX_URGENT_INTENT_RECONCILIATIONS_PER_TICK = 2;
const MAX_POST_ENTRY_SPLIT_PHASES = 3;
const HISTORICAL_CLOSE_RETRY_BASE_MS = 15 * 60_000;
const HISTORICAL_CLOSE_RETRY_MAX_MS = 6 * 60 * 60_000;
// The account-wide snapshot is fetched before the position loop. It may be
// reused for the first ordinary, versioned impulse-position read only while
// it is still recent; position reads themselves can be slow, so action paths
// below refresh it again before relying on it after the read.
const POSITION_ACCOUNT_SNAPSHOT_MAX_AGE_MS = 2_000;
// Read-only legacy proof may require several signed GETs; this is a budget for
// the whole proof, not permission to use an old account snapshot. The exact
// account snapshot is the final exchange read and must still be fresh when its
// ledger CAS acquires the lock.
const RAISE_STOP_REFUSAL_READ_ONLY_BUDGET_MS = 30_000;
const READ_ONLY_RECOVERY_ACCOUNT_TO_LEDGER_MAX_AGE_MS = 5_000;
const EXECUTION_QUANTITY_ALIASES = Object.freeze([
  "executedQty", "executedQuantity", "cumExecQty", "filledQty",
]);
const ORIGINAL_STOP_CANCEL_PRE_READ_REFUSAL =
  "BingX request failed (GET /openApi/swap/v2/trade/leverage, HTTP 200, code 109400, msg: timestamp is invalid)";
const ORIGINAL_STOP_CANCEL_MUTATION_PROVENANCE = Object.freeze({
  operation: "cancel_original_stop",
  mutationMethod: "DELETE",
  mutationEndpoint: "/openApi/swap/v2/trade/order",
  mutationRequestSent: false,
  phase: "pre_mutation_read",
});
// Only exact, known BingX read routes may be included in worker diagnostics.
// A provider-supplied URL, query string, or unexpected route is never echoed.
const SAFE_BINGX_DIAGNOSTIC_GET_ENDPOINTS = new Set([
  "/openApi/swap/v3/user/balance",
  "/openApi/swap/v2/user/positions",
  "/openApi/swap/v1/positionSide/dual",
  "/openApi/swap/v2/quote/contracts",
  "/openApi/swap/v1/maintMarginRatio",
  "/openApi/swap/v2/quote/premiumIndex",
  "/openApi/swap/v2/user/income",
  "/openApi/swap/v2/user/commissionRate",
  "/openApi/swap/v2/trade/leverage",
  "/openApi/swap/v2/trade/marginType",
  "/openApi/swap/v2/trade/order",
  "/openApi/swap/v2/trade/openOrders",
  "/openApi/swap/v2/trade/allOrders",
  "/openApi/swap/v2/trade/forceOrders",
  "/openApi/swap/v2/trade/allFillOrders",
  "/openApi/swap/v2/trade/fillHistory",
  "/openApi/swap/v2/trade/positionMargin",
  "/openApi/swap/v1/positionMargin/history",
  "/openApi/swap/v2/quote/ticker",
]);
const POSITION_OBSERVATION_GET_ENDPOINTS = new Set([
  "/openApi/swap/v2/user/positions",
  "/openApi/swap/v2/trade/openOrders",
  "/openApi/swap/v2/quote/premiumIndex",
  "/openApi/swap/v2/quote/ticker",
]);
const TRANSIENT_POSITION_READ_CODES = new Set([
  "exchange_busy",
  "read_timeout",
  "readtimeout",
  "timeout",
  "etimedout",
  "econnreset",
  "econnaborted",
  "eai_again",
]);
const VALIDATED_POSITION_READ_FAILURES = new Set([
  "VST mark is not corroborated by a fresh quote",
  "VST mark became stale while waiting for fresh ticker corroboration",
  "VST mark became stale before use",
  "VST mark or ticker became stale while reading the corroboration pair",
  "bingx_vst_account_positions_unverified",
  "bingx_vst_account_position_row_unverified",
  "bingx_vst_invalid_account_position_quantity",
  "bingx_vst_account_orders_unverified",
  "bingx_vst_account_order_row_unverified",
  "bingx_vst_account_order_ids_ambiguous",
  "bingx_vst_position_or_open_orders_unverified",
  "bingx_vst_position_state_ambiguous",
  "bingx_vst_position_side_unverified",
  "bingx_vst_mark_unverified",
  "bingx_vst_invalid_mark_price",
]);

function safeBingXReadDiagnostic(error) {
  return error?.method === "GET" &&
      SAFE_BINGX_DIAGNOSTIC_GET_ENDPOINTS.has(error?.endpoint)
    ? { diagnosticMethod: "GET", diagnosticEndpoint: error.endpoint }
    : {};
}

function isBoundedPositionReadFailure(error) {
  if (error instanceof Error &&
      VALIDATED_POSITION_READ_FAILURES.has(error.message)) return true;
  if (error?.method !== "GET" ||
      !POSITION_OBSERVATION_GET_ENDPOINTS.has(error?.endpoint)) return false;
  const code = String(error.code ?? "").toLowerCase();
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const status = Number(error.status ?? error.statusCode ?? error.httpStatus);
  return error.retryable === true ||
    TRANSIENT_POSITION_READ_CODES.has(code) ||
    /exchange[\s_-]*busy|read[\s_-]*timeout|timed?\s*out/.test(message) ||
    status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599);
}

function exactOriginalStopCancelMutationProvenance(value) {
  if (!validObject(value) ||
      Object.keys(value).sort().join("|") !==
        "mutationEndpoint|mutationMethod|mutationRequestSent|operation|phase") {
    return null;
  }
  if (value.operation !== ORIGINAL_STOP_CANCEL_MUTATION_PROVENANCE.operation ||
      value.mutationMethod !== ORIGINAL_STOP_CANCEL_MUTATION_PROVENANCE.mutationMethod ||
      value.mutationEndpoint !== ORIGINAL_STOP_CANCEL_MUTATION_PROVENANCE.mutationEndpoint) {
    return null;
  }
  const exactNoSend = value.mutationRequestSent === false &&
    value.phase === "pre_mutation_read";
  const exactSent = value.mutationRequestSent === true &&
    value.phase === "mutation_transport_started";
  return exactNoSend || exactSent ? { ...value } : null;
}

function exactPreRunnerSplitCloseNoWriteProvenance(value) {
  if (!validObject(value) ||
      Object.keys(value).sort().join("|") !==
        "boundary|noMutationSubmitted|operation" ||
      value.operation !== "close_pre_runner_split" ||
      value.boundary !== "before_transport" ||
      value.noMutationSubmitted !== true) {
    return null;
  }
  return { ...value };
}

function exactPreRunnerSplitCloseMutationProvenance(value) {
  const noWrite = exactPreRunnerSplitCloseNoWriteProvenance(value);
  if (noWrite) return noWrite;
  if (!validObject(value) ||
      Object.keys(value).sort().join("|") !== "boundary|mutationSubmitted|operation" ||
      value.operation !== "close_pre_runner_split" ||
      value.boundary !== "after_transport_started" ||
      value.mutationSubmitted !== true) return null;
  return { ...value };
}

function exactOriginalStopCancelPreReadRefusal(intent) {
  const outcome = intent?.outcome;
  if (!validObject(outcome) || intent?.state !== "unknown" ||
      intent?.exchangeOrderId !== null ||
      intent.request?.operation !== "cancel_original_stop" ||
      intent.request?.environment !== "vst" ||
      intent.phase !== "impulse-cancel_original_stop" ||
      intent.clientOrderId !== orderId(intent.sourceSignalId, intent.phase)) {
    return false;
  }
  const keys = uncertaintyEvidenceKeys(outcome).sort().join("|");
  const provenance = exactOriginalStopCancelMutationProvenance(
    outcome.mutationProvenance,
  );
  const initialKeys = [
    "error|errorMessage|mutationProvenance",
    "definiteRejection|error|errorMessage|mutationProvenance",
  ];
  const normalizedKeys = [
    "mutationProvenance|reason|submissionError|submissionErrorMessage",
    "definiteRejection|mutationProvenance|reason|submissionError|submissionErrorMessage",
  ];
  const structuredInitial = provenance &&
    provenance.mutationRequestSent === false &&
    initialKeys.includes(keys) &&
    outcome.error === "BingXLiveApiError" &&
    (outcome.definiteRejection === undefined ||
      outcome.definiteRejection === true);
  const structuredNormalized = provenance &&
    provenance.mutationRequestSent === false &&
    normalizedKeys.includes(keys) &&
    outcome.reason === "exchange_state_not_verified" &&
    outcome.submissionError === "BingXLiveApiError" &&
    (outcome.definiteRejection === undefined ||
      outcome.definiteRejection === true);
  // The narrowly-scoped compatibility path is for the exact persisted
  // timestamp refusal from versions whose source always performed the
  // leverage GET before the cancel DELETE. A generic definite rejection or a
  // matching error string on another operation is never sufficient.
  const legacyKeys =
    "definiteRejection|reason|submissionError|submissionErrorMessage";
  const exactLegacyReadRefusal =
    !provenance && keys === legacyKeys &&
    outcome.reason === "exchange_state_not_verified" &&
    outcome.submissionError === "BingXLiveApiError" &&
    outcome.submissionErrorMessage === ORIGINAL_STOP_CANCEL_PRE_READ_REFUSAL &&
    outcome.definiteRejection === true;
  return Boolean(structuredInitial || structuredNormalized ||
    exactLegacyReadRefusal);
}

function exactOriginalStopCancelSentAmbiguous(intent) {
  const outcome = intent?.outcome;
  const provenance = exactOriginalStopCancelMutationProvenance(
    outcome?.mutationProvenance,
  );
  if (!validObject(outcome) ||
      !["submitted", "unknown"].includes(intent?.state) ||
      intent?.exchangeOrderId !== null ||
      intent.request?.operation !== "cancel_original_stop" ||
      intent.request?.environment !== "vst" ||
      intent.phase !== "impulse-cancel_original_stop" ||
      intent.clientOrderId !== orderId(intent.sourceSignalId, intent.phase)) {
    return false;
  }
  if (intent.state === "submitted") {
    return uncertaintyEvidenceKeys(outcome).join("|") === "phase" &&
      outcome.phase === "submission_started";
  }
  if (!provenance || provenance.mutationRequestSent !== true ||
      provenance.phase !== "mutation_transport_started" ||
      outcome.definiteRejection === true) {
    return false;
  }
  const keys = uncertaintyEvidenceKeys(outcome).sort().join("|");
  const structuredInitial = [
    "error|errorMessage|mutationProvenance",
  ].includes(keys) && outcome.error === "BingXLiveApiError";
  const structuredNormalized =
    keys === "mutationProvenance|reason|submissionError|submissionErrorMessage" &&
    outcome.reason === "exchange_state_not_verified" &&
    outcome.submissionError === "BingXLiveApiError";
  return Boolean(structuredInitial || structuredNormalized);
}

function reconciliationIntentKey(intent) {
  if (typeof intent?.clientOrderId === "string" &&
      intent.clientOrderId.trim() !== "") {
    return `client:${intent.clientOrderId}`;
  }
  return `phase:${String(intent?.phase ?? "")}:signal:${String(intent?.sourceSignalId ?? "")}`;
}

function rotateStableIntents(intents, cursor) {
  const ordered = [...intents].sort((left, right) =>
    reconciliationIntentKey(left).localeCompare(reconciliationIntentKey(right)));
  if (ordered.length < 2 || !cursor) return ordered;
  const currentIndex = ordered.findIndex((intent) =>
    reconciliationIntentKey(intent) === cursor);
  if (currentIndex >= 0) {
    return [...ordered.slice(currentIndex + 1), ...ordered.slice(0, currentIndex + 1)];
  }
  const nextIndex = ordered.findIndex((intent) =>
    reconciliationIntentKey(intent).localeCompare(cursor) > 0);
  return nextIndex < 0
    ? ordered
    : [...ordered.slice(nextIndex), ...ordered.slice(0, nextIndex)];
}

function isExposureCriticalIntent(intent) {
  // These intents affect an existing position, its protective orders, or an
  // entry whose fill may be live but whose protection has not been verified.
  // Unknown operations fail closed into this class; only explicitly
  // read-only/account-preparation work is allowed to wait behind them.
  const operation = intent?.request?.operation;
  return !["margin_top_up", "prepare_margin_mode", "set_isolated_leverage",
    "observe_triggered_stop"].includes(operation);
}

function validObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function closePolicyNumber(left, right) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) &&
    Math.abs(a - b) <= Math.max(1e-10, Math.max(Math.abs(a), Math.abs(b)) * 1e-8);
}

function orderedExactIds(value, expected) {
  return Array.isArray(value) && value.every((id) =>
    typeof id === "string" && id.trim() !== "") &&
    new Set(value).size === value.length &&
    JSON.stringify([...value].sort()) === JSON.stringify([...expected].sort());
}

function canonicalPolicyJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalPolicyJson).join(",")}]`;
  }
  if (validObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalPolicyJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Repair only the missing top-level policy fields on an existing impulse
 * position. The original confirmed signal and verified fill must reproduce
 * the saved nested entry policy, while the completed split corroborates the
 * current live-leg quantities and protective orders.
 */
export function restoreVersionlessImpulsePolicyState(snapshot, sourceSignalId) {
  const refused = (reason) => ({ ok: false, reason });
  if (!validObject(snapshot) || snapshot.version !== undefined ||
      snapshot.patternId !== "impulse_buy") {
    return refused("impulse_policy_snapshot_recovery_not_versionless_impulse");
  }
  const savedPolicy = snapshot.policy;
  const signal = snapshot.signalSnapshot;
  if (!validObject(savedPolicy) ||
      savedPolicy.version !== VST_POLICY_VERSION ||
      savedPolicy.patternId !== "impulse_buy" ||
      savedPolicy.status !== "open" ||
      !validObject(signal) ||
      typeof sourceSignalId !== "string" || sourceSignalId.trim() === "" ||
      snapshot.sourceSignalId !== sourceSignalId ||
      signal.sourceSignalId !== sourceSignalId ||
      snapshot.symbol !== signal.symbol ||
      snapshot.patternId !== signal.patternId ||
      savedPolicy.symbol !== snapshot.symbol) {
    return refused("impulse_policy_snapshot_recovery_provenance_mismatch");
  }

  let entryPolicy;
  try {
    entryPolicy = createVstPolicy({
      signal,
      fill: snapshot.verifiedFill,
    });
  } catch {
    return refused("impulse_policy_snapshot_recovery_saved_rules_invalid");
  }
  const sameIso = (left, right) => {
    const a = Date.parse(left);
    const b = Date.parse(right);
    return Number.isFinite(a) && Number.isFinite(b) && a === b;
  };
  const sameOptionalImmutableValue = (field, expected) => {
    if (snapshot[field] === undefined) return true;
    return typeof expected === "string"
      ? snapshot[field] === expected
      : closePolicyNumber(snapshot[field], expected);
  };
  const initialPolicyMatches = savedPolicy.version === entryPolicy.version &&
    savedPolicy.patternId === entryPolicy.patternId &&
    savedPolicy.symbol === entryPolicy.symbol &&
    closePolicyNumber(savedPolicy.entryPrice, entryPolicy.entryPrice) &&
    sameIso(savedPolicy.entryAt, entryPolicy.entryAt) &&
    sameIso(savedPolicy.signalAt, entryPolicy.signalAt) &&
    closePolicyNumber(savedPolicy.quantity, entryPolicy.quantity) &&
    closePolicyNumber(savedPolicy.quantity, snapshot.verifiedFill.quantity) &&
    closePolicyNumber(savedPolicy.entryPrice, snapshot.verifiedFill.price) &&
    Number(savedPolicy.stopPrice) >= Number(signal.stopLoss) &&
    closePolicyNumber(snapshot.signalStopPrice, signal.stopLoss) &&
    closePolicyNumber(snapshot.actualEntryBreakEvenPrice, entryPolicy.entryPrice) &&
    sameOptionalImmutableValue("symbol", entryPolicy.symbol) &&
    sameOptionalImmutableValue("patternId", entryPolicy.patternId) &&
    sameOptionalImmutableValue("entryPrice", entryPolicy.entryPrice) &&
    sameOptionalImmutableValue("entryAt", entryPolicy.entryAt) &&
    sameOptionalImmutableValue("signalAt", entryPolicy.signalAt) &&
    sameOptionalImmutableValue("quantity", entryPolicy.quantity);
  if (!initialPolicyMatches) {
    return refused("impulse_policy_snapshot_recovery_saved_entry_mismatch");
  }

  const split = snapshot.split;
  if (snapshot.status !== "open" || snapshot.executionStatus !== "open" ||
      !validObject(split) || split.stage !== "complete" ||
      split.runnerCleanup != null ||
      !closePolicyNumber(split.totalQuantity, entryPolicy.quantity) ||
      !closePolicyNumber(split.coreQuantity, entryPolicy.coreQty) ||
      !closePolicyNumber(split.runnerQuantity, entryPolicy.runnerQty) ||
      !closePolicyNumber(split.signalStopPrice, signal.stopLoss) ||
      !closePolicyNumber(split.breakEvenPrice, entryPolicy.entryPrice) ||
      split.positionId !== snapshot.exchangePositionId ||
      typeof snapshot.exchangePositionId !== "string" ||
      snapshot.exchangePositionId.trim() === "" ||
      snapshot.entryOrderId !== split.entryOrderId ||
      typeof split.entryOrderId !== "string" || split.entryOrderId.trim() === "") {
    return refused("impulse_policy_snapshot_recovery_split_mismatch");
  }

  const coreOpen = savedPolicy.coreOpen;
  const runnerOpen = savedPolicy.runnerOpen;
  const coreQty = Number(savedPolicy.coreQty);
  const runnerQty = Number(savedPolicy.runnerQty);
  const remainingQty = Number(savedPolicy.remainingQty);
  const activeLegs = [
    ...(coreOpen === true ? ["core"] : []),
    ...(runnerOpen === true ? ["runner"] : []),
  ];
  if (typeof coreOpen !== "boolean" || typeof runnerOpen !== "boolean" ||
      !closePolicyNumber(coreQty, savedPolicy.coreQty) ||
      !closePolicyNumber(runnerQty, savedPolicy.runnerQty) ||
      !closePolicyNumber(remainingQty, savedPolicy.remainingQty) ||
      !closePolicyNumber(coreQty + runnerQty, remainingQty) ||
      coreOpen !== (coreQty > 0) ||
      runnerOpen !== (runnerQty > 0) ||
      activeLegs.length === 0 ||
      !Array.isArray(split.activeLegs) ||
      JSON.stringify(split.activeLegs) !== JSON.stringify(activeLegs) ||
      snapshot.stopPrice !== undefined &&
        !closePolicyNumber(snapshot.stopPrice, savedPolicy.stopPrice) ||
      snapshot.coreOpen !== undefined && snapshot.coreOpen !== coreOpen ||
      snapshot.coreQty !== undefined && !closePolicyNumber(snapshot.coreQty, coreQty) ||
      snapshot.runnerOpen !== undefined && snapshot.runnerOpen !== runnerOpen ||
      snapshot.runnerQty !== undefined &&
        !closePolicyNumber(snapshot.runnerQty, runnerQty) ||
      snapshot.remainingQty !== undefined &&
        !closePolicyNumber(snapshot.remainingQty, remainingQty)) {
    return refused("impulse_policy_snapshot_recovery_live_legs_mismatch");
  }

  const activeStopIds = [];
  for (const [leg, isOpen, quantity, stop] of [
    ["core", coreOpen, coreQty, split.coreStop],
    ["runner", runnerOpen, runnerQty, split.runnerStop],
  ]) {
    const orderId = snapshot[`${leg}StopOrderId`];
    if (!isOpen) {
      if (stop !== null || orderId !== null) {
        return refused("impulse_policy_snapshot_recovery_closed_leg_stop_mismatch");
      }
      continue;
    }
    const expectedPrice = leg === "core"
      ? savedPolicy.stopPrice : savedPolicy.runnerStopPrice;
    if (leg === "runner" && snapshot.runnerStopPrice !== undefined &&
        !closePolicyNumber(snapshot.runnerStopPrice, expectedPrice)) {
      return refused("impulse_policy_snapshot_recovery_active_stop_mismatch");
    }
    if (!validObject(stop) ||
        typeof stop.orderId !== "string" || stop.orderId.trim() === "" ||
        stop.positionId !== snapshot.exchangePositionId ||
        stop.orderId !== orderId ||
        !closePolicyNumber(stop.quantity, quantity) ||
        !closePolicyNumber(stop.stopPrice, expectedPrice) ||
        !closePolicyNumber(snapshot[`${leg}StopQuantity`], quantity) ||
        snapshot[`${leg}StopPositionId`] !== snapshot.exchangePositionId) {
      return refused("impulse_policy_snapshot_recovery_active_stop_mismatch");
    }
    activeStopIds.push(stop.orderId);
  }
  if (!orderedExactIds(split.baselineOpenOrderIds, activeStopIds) ||
      !orderedExactIds(snapshot.baselineOpenOrderIds, activeStopIds) ||
      coreOpen && !closePolicyNumber(savedPolicy.stopPrice, split.coreStop.stopPrice) ||
      runnerOpen && !closePolicyNumber(savedPolicy.runnerStopPrice,
        split.runnerStop.stopPrice) ||
      !runnerOpen && savedPolicy.runnerStopPrice !== null &&
        !closePolicyNumber(savedPolicy.runnerStopPrice, split.breakEvenPrice)) {
    return refused("impulse_policy_snapshot_recovery_protective_stops_mismatch");
  }

  for (const field of ["peakPct", "runnerPeakPct"]) {
    if (snapshot[field] !== undefined &&
        (!Number.isFinite(Number(snapshot[field])) || Number(snapshot[field]) < 0) ||
        !Number.isFinite(Number(savedPolicy[field])) ||
        Number(savedPolicy[field]) < 0) {
      return refused("impulse_policy_snapshot_recovery_exit_state_invalid");
    }
  }
  if (snapshot.observationWindowNoted !== undefined &&
      typeof snapshot.observationWindowNoted !== "boolean" ||
      typeof savedPolicy.observationWindowNoted !== "boolean") {
    return refused("impulse_policy_snapshot_recovery_exit_state_invalid");
  }
  const observedAtValues = [snapshot.observedAt, savedPolicy.observedAt]
    .filter((value) => value !== undefined);
  if (observedAtValues.some((value) =>
    typeof value !== "string" || !Number.isFinite(Date.parse(value)))) {
    return refused("impulse_policy_snapshot_recovery_exit_state_invalid");
  }
  const observedAt = observedAtValues.sort((left, right) =>
    Date.parse(left) - Date.parse(right)).at(-1);
  if (snapshot.lastCloseFill !== undefined && savedPolicy.lastCloseFill !== undefined &&
      canonicalPolicyJson(snapshot.lastCloseFill) !==
        canonicalPolicyJson(savedPolicy.lastCloseFill)) {
    return refused("impulse_policy_snapshot_recovery_last_fill_mismatch");
  }

  const recovered = {
    ...snapshot,
    version: savedPolicy.version,
    patternId: savedPolicy.patternId,
    symbol: savedPolicy.symbol,
    status: snapshot.status,
    entryPrice: savedPolicy.entryPrice,
    entryAt: savedPolicy.entryAt,
    signalAt: savedPolicy.signalAt,
    quantity: savedPolicy.quantity,
    remainingQty,
    stopPrice: savedPolicy.stopPrice,
    peakPct: Math.max(Number(snapshot.peakPct ?? 0), Number(savedPolicy.peakPct)),
    coreQty,
    coreOpen,
    runnerQty,
    runnerOpen,
    runnerPeakPct: Math.max(
      Number(snapshot.runnerPeakPct ?? 0), Number(savedPolicy.runnerPeakPct),
    ),
    ...(observedAt === undefined ? {} : { observedAt }),
    observationWindowNoted: snapshot.observationWindowNoted === undefined
      ? savedPolicy.observationWindowNoted
      : snapshot.observationWindowNoted || savedPolicy.observationWindowNoted,
    runnerStopPrice: snapshot.runnerStopPrice === undefined
      ? savedPolicy.runnerStopPrice : snapshot.runnerStopPrice,
    lastCloseFill: snapshot.lastCloseFill === undefined
      ? savedPolicy.lastCloseFill : snapshot.lastCloseFill,
  };
  return { ok: true, snapshot: recovered };
}

function orderId(signalId, phase) {
  const digest = createHash("sha256").update(`${signalId}:${phase}`).digest("hex").slice(0, 30);
  return `vst-${digest}`;
}

function positive(value, name) {
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) throw new TypeError(`${name} must be positive and finite`);
  return result;
}

function isCanonicalVstSymbol(symbol) {
  if (typeof symbol !== "string") return false;
  const match = /^[A-Z0-9]{1,20}USDT/.exec(symbol);
  return match?.[0] === symbol;
}

// Shared symbol-identity key: exchange symbols may carry a dash
// ("ONDO-USDT") while internal/canonical symbols never do ("ONDOUSDT").
// Every per-symbol scoping check in this file compares through this key so
// a foreign symbol is never mistaken for -- or missed as -- the one a
// signal/intent/position actually names.
function normalizeSymbolKey(symbol) {
  return String(symbol ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

// An unresolved intent whose own request never names a symbol (e.g. a
// generic/systemic operation, or a malformed record) is ambiguous about
// which symbol it affects. Fail closed: treat it as blocking EVERY symbol,
// never silently scope it to none just because it doesn't match any one
// symbol's key by coincidence.
function intentBlocksSymbol(intent, symbolKey) {
  const intentSymbolKey = normalizeSymbolKey(intent?.request?.symbol);
  return !intentSymbolKey || intentSymbolKey === symbolKey;
}

function isFreshSignalAt(signalAt, now) {
  const signalTime = Date.parse(signalAt);
  return Number.isFinite(signalTime) &&
    Number.isFinite(now) &&
    now - signalTime <= 10 * 60_000 &&
    now - signalTime >= -30_000;
}

function hasConfirmedIsolatedMarginPreparation(evidence, profile = OWNER_POSITION_PROFILE) {
  return validObject(evidence) &&
    evidence.verified === true &&
    evidence.status === "filled" &&
    evidence.marginMode === profile.marginMode;
}

function decimalUnits(value, precision, name) {
  const text = typeof value === "string" || typeof value === "number"
    ? String(value) : "";
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new TypeError(`${name} must be a non-negative decimal`);
  const fraction = match[2] ?? "";
  if (fraction.length > precision &&
      /[1-9]/.test(fraction.slice(precision))) {
    throw new Error(`${name} exceeds exchange quantity precision`);
  }
  const kept = fraction.slice(0, precision).padEnd(precision, "0");
  return BigInt(match[1]) * (10n ** BigInt(precision)) +
    BigInt(kept || "0");
}

function formatDecimalUnits(units, precision) {
  const scale = 10n ** BigInt(precision);
  const whole = units / scale;
  const fraction = precision
    ? String(units % scale).padStart(precision, "0").replace(/0+$/, "")
    : "";
  return fraction ? `${whole}.${fraction}` : String(whole);
}

// A newly computed LONG protective stop (trailing raise, breakeven, etc.) is
// ordinary floating-point arithmetic and can carry more fractional digits
// than the exchange contract's price precision allows. Round it up (toward
// the entry price) to the exact tradable precision here, at the single point
// where every raise_stop action is read, so it is never submitted to
// bingx-live-api.mjs's decimalAtPrecision guard unrounded. Ceiling only ever
// tightens the stop; it never loosens the requested protection.
export function roundStopPriceUpToPrecision(rawPrice, pricePrecision, name) {
  const price = Number(rawPrice);
  if (!Number.isFinite(price) || price <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  if (!Number.isSafeInteger(pricePrecision) || pricePrecision < 0 || pricePrecision > 12) {
    throw new TypeError(`${name} precision must be an integer from 0 through 12`);
  }
  // Percentage-based stop math (priceForGain) is ordinary floating-point
  // arithmetic, so the result can carry binary noise past a double's
  // reliable ~15-17 significant digits (e.g. 100 * 1.14 -> ...00000001421).
  // toFixed rounds that noise away first so it is never mistaken for a
  // genuine sub-precision digit that would force an unnecessary ceiling.
  const fixedDigits = Math.min(Math.max(pricePrecision + 2, 10), 17);
  const [whole, fraction = ""] = price.toFixed(fixedDigits).split(".");
  const scale = 10n ** BigInt(pricePrecision);
  const kept = fraction.slice(0, pricePrecision).padEnd(pricePrecision, "0");
  const units = BigInt(whole) * scale + BigInt(kept || "0");
  const remainder = fraction.slice(pricePrecision).replace(/0+$/, "");
  const roundedUnits = remainder ? units + 1n : units;
  return formatDecimalUnits(roundedUnits, pricePrecision);
}

function exactImpulseSplit(quantity, filters, quotePrice) {
  const precision = filters?.quantityPrecision;
  if (!Number.isSafeInteger(precision) || precision < 0 || precision > 12) {
    throw new Error("impulse_split_quantity_precision_unverified");
  }
  if (!Number.isSafeInteger(filters.pricePrecision) ||
      filters.pricePrecision < 0 || filters.pricePrecision > 12) {
    throw new Error("impulse_split_price_precision_unverified");
  }
  const totalUnits = decimalUnits(quantity, precision, "impulse_total_quantity");
  if (totalUnits <= 0n || totalUnits % 5n !== 0n) {
    throw new Error("impulse_split_cannot_represent_exact_80_20");
  }
  const coreUnits = totalUnits * 4n / 5n;
  const runnerUnits = totalUnits / 5n;
  const coreQuantity = formatDecimalUnits(coreUnits, precision);
  const runnerQuantity = formatDecimalUnits(runnerUnits, precision);
  const minUnits = decimalUnits(filters.minQuantity, precision, "minimum_quantity");
  if (coreUnits < minUnits || runnerUnits < minUnits) {
    throw new Error("impulse_split_tranche_below_minimum_quantity");
  }
  const minNotional = Number(filters.minNotional);
  if (!Number.isFinite(minNotional) || minNotional <= 0 ||
      Number(coreQuantity) * Number(quotePrice) < minNotional ||
      Number(runnerQuantity) * Number(quotePrice) < minNotional) {
    throw new Error("impulse_split_tranche_below_minimum_notional");
  }
  return {
    totalQuantity: formatDecimalUnits(totalUnits, precision),
    coreQuantity,
    runnerQuantity,
    quantityPrecision: precision,
    pricePrecision: filters.pricePrecision,
    minQuantity: String(filters.minQuantity),
  };
}

function verifyBrokerReadShape(broker) {
  const requiredFunctions = [
    "getCapabilities",
    "readAccountState",
    "readMarketMark",
    "reconcileIntent",
    "readPosition",
  ];
  const missing = requiredFunctions.filter((name) => typeof broker?.[name] !== "function");
  if (missing.length) throw new Error(`unsupported_vst_broker_interface:${missing.join(",")}`);
}

function hasFlatSplitCleanupReadTrust(capabilities) {
  const requiredFeatures = ["vst_only", "complete_order_lookup", "verified_position_state"];
  return validObject(capabilities) &&
    capabilities.environment === "vst" &&
    capabilities.verified === true &&
    typeof capabilities.accountId === "string" &&
    capabilities.accountId.trim() !== "" &&
    Array.isArray(capabilities.features) &&
    requiredFeatures.every((feature) => capabilities.features.includes(feature));
}

// The broker advertises core capabilities account-wide but lists symbols
// whose own exchange rows are not verified (missing/extra stop, orphan order,
// wrong leverage). Only those symbols are quarantined from regular mutation.
function capabilityUnverifiedSymbol(capabilities, symbolKey) {
  const list = capabilities?.unverifiedSymbols;
  if (!Array.isArray(list) || !symbolKey) return false;
  return list.some((symbol) => normalizeSymbolKey(symbol) === symbolKey);
}

async function inspectCapabilities(
  broker, recordTiming = () => {}, requiredFeatures = REQUIRED_CAPABILITIES,
) {
  try {
    verifyBrokerReadShape(broker);
  } catch (error) {
    return {
      capabilities: null,
      mutationCapabilities: null,
      reason: error instanceof Error ? error.message : "unsupported_vst_broker_interface",
      diagnosticReason: "broker_interface_unavailable",
      safeForVstReads: false,
      explicitWrongEnvironment: false,
    };
  }
  let capabilities;
  try {
    capabilities = await broker.getCapabilities(recordTiming);
  } catch (error) {
    return {
      capabilities: null,
      mutationCapabilities: null,
      reason: error instanceof Error ? error.message : "vst_capabilities_temporarily_unavailable",
      diagnosticReason: "capability_read_failed",
      ...(typeof error?.exchangeMessage === "string" ? {
        diagnosticMessage: safeTickErrorSummary(error),
      } : {}),
      diagnosticCode: Number.isSafeInteger(error?.code) && error.code >= 0
        ? error.code
        : typeof error?.code === "string" && /^\d{3,6}$/.test(error.code)
          ? Number(error.code)
          : undefined,
      safeForVstReads: true,
      explicitWrongEnvironment: false,
    };
  }
  if (validObject(capabilities) &&
      capabilities.environment !== undefined &&
      capabilities.environment !== "vst") {
    return {
      capabilities: null,
      mutationCapabilities: null,
      reason: "unsupported_vst_broker_capabilities_unverified_or_wrong_environment",
      diagnosticReason: "wrong_exchange_environment",
      safeForVstReads: false,
      explicitWrongEnvironment: true,
    };
  }
  if (!validObject(capabilities) ||
      capabilities.environment !== "vst" ||
      capabilities.verified !== true ||
      typeof capabilities.accountId !== "string" ||
      capabilities.accountId.trim() === "") {
    return {
      capabilities: null,
      mutationCapabilities: null,
      reason: "unsupported_vst_broker_capabilities_unverified_or_wrong_environment",
      diagnosticReason: "capabilities_unverified",
      safeForVstReads: true,
      explicitWrongEnvironment: false,
    };
  }
  const missing = requiredFeatures.filter(
    (name) => !Array.isArray(capabilities.features) || !capabilities.features.includes(name),
  );
  if (missing.length) {
    return {
      capabilities,
      mutationCapabilities: null,
      reason: `unsupported_vst_protective_capabilities:${missing.join(",")}`,
      diagnosticReason: "protective_capabilities_missing",
      safeForVstReads: true,
      explicitWrongEnvironment: false,
    };
  }
  const missingMutationFunctions = ["readPlanningInputs", "performIntent"].filter(
    (name) => typeof broker?.[name] !== "function",
  );
  if (missingMutationFunctions.length) {
    return {
      capabilities,
      mutationCapabilities: null,
      reason: `unsupported_vst_broker_interface:${missingMutationFunctions.join(",")}`,
      diagnosticReason: "broker_interface_incomplete",
      safeForVstReads: true,
      explicitWrongEnvironment: false,
    };
  }
  return {
    capabilities,
    mutationCapabilities: capabilities,
    reason: null,
    diagnosticReason: null,
    safeForVstReads: true,
    explicitWrongEnvironment: false,
  };
}

function isUsableIntentEvidence(result) {
  return validObject(result) && result.verified === true &&
    ["filled", "canceled", "rejected", "working", "unknown"].includes(result.status);
}

// Every unresolved intent blocks ALL later pending signals (runOnce refuses
// to look at new signals while any intent is still unknown/prepared/submitted).
// An "entry" intent with no usable exchange evidence can never resolve on its
// own when the order never reached BingX -- there is nothing to find, so it
// would otherwise repeat the same unknown verdict forever and halt the whole
// pipeline permanently. Only abandon it once this much time has passed, to
// rule out exchange/API indexing lag rather than a genuinely missing order.
const ENTRY_ABANDON_AFTER_MS = 10 * 60 * 1000;

// When the submission itself failed with a synchronous, definitive exchange
// rejection (see isDefiniteExchangeRejection in bingx-live-api.mjs), there is
// no order that could still be indexing or settling somewhere on BingX's
// side -- the exchange already said, in the same HTTP response, that nothing
// was created. The long ENTRY_ABANDON_AFTER_MS wait exists to rule out
// exchange-side lag for a genuinely ambiguous submission (network/timeout
// failure); it buys nothing here and only leaves the signal stuck on
// "requires review" for minutes. Still require a fresh confirmedSymbolFlat
// read before abandoning -- never trust the error message alone -- just
// without an artificial wait first.
const ENTRY_ABANDON_AFTER_DEFINITE_REJECTION_MS = 3_000;

// Same escape hatch as entry, generalized: these operations all act on a
// position/order/margin state that may or may not still exist. If a fresh
// read confirms the WHOLE account is flat (no positions, no open orders),
// whatever this intent was trying to adjust is gone regardless of whether
// the intent itself ever applied -- giving up on it loses nothing. The
// engine allows at most one open VST position at a time (entry itself
// requires the whole account flat before ever submitting), so this global
// check is exact for "this intent's target is gone", not an approximation.
//
// Deliberately excluded: "close_leg", "close_survivor", "close_split_all",
// "close_pre_runner_split", and "observe_triggered_stop". For the close
// operations, a flat account is the expected SUCCESS signal, not proof the
// close never happened -- auto-abandoning them on that basis risks mistaking
// a real close for a failure and permanently losing its fill/PnL
// bookkeeping. They get their own criterion below (CLOSE_ABANDON_OPERATIONS)
// instead of reusing this flat-account check. "observe_triggered_stop" never
// reaches this branch -- it is resolved by its own dedicated self-healing
// evidence path.
const OPERATION_ABANDON_AFTER_MS = 10 * 60 * 1000;
const FLAT_ACCOUNT_ABANDON_OPERATIONS = new Set([
  "prepare_margin_mode",
  "set_isolated_leverage",
  "margin_top_up",
  "raise_stop",
  "set_runner_break_even",
  "cancel_original_after_runner_fill",
  "split_core_stop",
  "split_runner_stop",
  "cancel_original_stop",
  "cancel_split_stop",
  "cancel_flat_split_stop",
  "split_raise_stop_place",
  "split_raise_stop_cancel",
]);

// Close operations act on an existing position where "the account went
// flat" is the outcome we WANT, so it can never be used as proof the close
// never happened the way it proves that for the operations above. Instead,
// a stuck close intent is only ever resolved by a fresh, independent read
// (evaluateCloseAbandonEvidence) that lands in one of three outcomes:
//   (a) "confirmed_still_open" -- proves the position is still open at
//       EXACTLY its pre-close quantity: strong, specific evidence nothing
//       was closed, safe to give up on this attempt without any risk of
//       hiding a real fill; normal per-tick management is left untouched
//       and may retry the close later.
//   (b) "ambiguous" -- the read succeeded but cannot establish that (flat
//       account, mismatched quantity, or a suspicious resting order):
//       genuinely ambiguous, since a flat read here is exactly what a real
//       close would also look like with no verified fill/PnL to safely
//       commit. This never guesses "succeeded" or "failed": the intent
//       still resolves (so it stops blocking every later signal), but the
//       position is moved to the terminal "error" status so no further
//       automated action is taken on it either way, and the outcome is
//       recorded under a distinct reason so it surfaces for manual
//       reconciliation against the exchange instead of silently looking
//       like an ordinary resolved intent.
//   (c) "read_unavailable" -- the read itself failed or came back
//       unverified: silence, not evidence. Unlike (b), this leaves the
//       intent unresolved so the next tick tries the read again, rather
//       than letting a transient exchange/network outage permanently
//       retire a position that may still be open and unmanaged.
const CLOSE_ABANDON_OPERATIONS = new Set([
  "close_leg",
  "close_survivor",
  "close_split_all",
  "close_pre_runner_split",
]);
const RAISE_STOP_ENTRY_PROOF_REFUSAL =
  "bingx_vst_entry_history_fills_unverified";
const RAISE_STOP_ENTRY_PROOF_REFUSAL_PRE_SIGN =
  "bingx_vst_raise_stop_entry_fill_proof_refused_before_upgrade";
const RAISE_STOP_ENTRY_PROOF_REFUSAL_MESSAGE =
  `${RAISE_STOP_ENTRY_PROOF_REFUSAL} (${RAISE_STOP_ENTRY_PROOF_REFUSAL_PRE_SIGN})`;
const RAISE_STOP_EQUAL_PRICE_REJECTION_MESSAGE =
  "VST protective stop upgrades may only raise the stop";

function exactDecimalEqual(left, right) {
  return compareExactDecimals(left, right) === 0;
}

function timestampMillis(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
        .test(value)) {
    const parsed = Date.parse(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function sameTimestamp(left, right) {
  const a = timestampMillis(left);
  const b = timestampMillis(right);
  return a !== null && b !== null && a === b;
}

function exactRaiseStopRefusalOutcome(intent) {
  const outcome = intent?.outcome;
  if (!validObject(outcome)) return false;
  const keys = uncertaintyEvidenceKeys(outcome).sort();
  const phaseKnownToRunPreAdapterVerifier =
    /^raise_stop-core-\d+$/.test(String(intent?.phase ?? "")) ||
    /^impulse-sole-core-stop-\d+$/.test(String(intent?.phase ?? ""));
  if (intent?.state !== "unknown" ||
      intent?.exchangeOrderId !== null ||
      intent.request?.operation !== "raise_stop" ||
      intent.request?.leg !== "core" ||
      !phaseKnownToRunPreAdapterVerifier) {
    return false;
  }
  const explicitMarker = outcome.error === "Error" &&
    outcome.preSignReason ===
    RAISE_STOP_ENTRY_PROOF_REFUSAL_PRE_SIGN &&
    outcome.errorMessage === RAISE_STOP_ENTRY_PROOF_REFUSAL_MESSAGE &&
    JSON.stringify(keys) === JSON.stringify([
      "error", "errorMessage", "preSignReason",
    ]);
  const historicalLiteral = outcome.error === "Error" &&
    outcome.preSignReason === undefined &&
    intent.request?.entryProof === undefined &&
    outcome.errorMessage === RAISE_STOP_ENTRY_PROOF_REFUSAL &&
    JSON.stringify(keys) === JSON.stringify(["error", "errorMessage"]);
  const normalizedExplicitMarker =
    outcome.reason === "exchange_state_not_verified" &&
    outcome.submissionError === "Error" &&
    outcome.submissionErrorMessage === RAISE_STOP_ENTRY_PROOF_REFUSAL_MESSAGE &&
    outcome.preSignReason === RAISE_STOP_ENTRY_PROOF_REFUSAL_PRE_SIGN &&
    JSON.stringify(keys) === JSON.stringify([
      "preSignReason", "reason", "submissionError", "submissionErrorMessage",
    ]);
  const normalizedHistoricalLiteral =
    outcome.reason === "exchange_state_not_verified" &&
    outcome.submissionError === "Error" &&
    outcome.submissionErrorMessage === RAISE_STOP_ENTRY_PROOF_REFUSAL &&
    intent.request?.entryProof === undefined &&
    JSON.stringify(keys) === JSON.stringify([
      "reason", "submissionError", "submissionErrorMessage",
    ]);
  return explicitMarker || historicalLiteral ||
    normalizedExplicitMarker || normalizedHistoricalLiteral;
}

function exactRaiseStopEqualPriceRejectionOutcome(intent) {
  const outcome = intent?.outcome;
  const keys = validObject(outcome)
    ? uncertaintyEvidenceKeys(outcome).sort() : [];
  const legacyKeys = [
    "reason", "submissionError", "submissionErrorMessage",
  ];
  const strictNoWrite = outcome?.mutationProvenance;
  const explicitNoWrite =
    validObject(strictNoWrite) &&
    strictNoWrite.operation === "raise_stop" &&
    strictNoWrite.method === "POST" &&
    strictNoWrite.phase === "pre_mutation_guard" &&
    strictNoWrite.mutationRequestSent === false &&
    strictNoWrite.reason === "non_increasing_stop" &&
    JSON.stringify(Object.keys(strictNoWrite).sort()) === JSON.stringify([
      "method", "mutationRequestSent", "operation", "phase", "reason",
    ]) &&
    JSON.stringify(keys) === JSON.stringify([
      ...legacyKeys, "mutationProvenance",
    ].sort());
  const exactLegacy =
    JSON.stringify(keys) === JSON.stringify(legacyKeys);
  return intent?.state === "unknown" &&
    intent?.exchangeOrderId === null &&
    /^raise_stop-core-\d+$/.test(String(intent?.phase ?? "")) &&
    intent.request?.operation === "raise_stop" &&
    intent.request?.leg === "core" &&
    validObject(outcome) &&
    outcome.reason === "exchange_state_not_verified" &&
    outcome.submissionError === "BingXLiveApiError" &&
    outcome.submissionErrorMessage === RAISE_STOP_EQUAL_PRICE_REJECTION_MESSAGE &&
    (exactLegacy || explicitNoWrite);
}

const SAFE_RECOVERY_DEFERRED_REASONS = new Set([
  "raise_stop_position_read_unavailable",
  "raise_stop_persisted_position_changed",
  "raise_stop_entry_proof_not_linked_or_fresh",
  "raise_stop_entry_proof_read_unavailable",
  "raise_stop_entry_proof_mismatch",
  "raise_stop_position_snapshot_mismatch",
  "raise_stop_old_stop_snapshot_mismatch",
  "raise_stop_read_only_proof_budget_exceeded",
  "raise_stop_account_state_unavailable",
  "raise_stop_account_state_unverified",
  "raise_stop_account_position_mismatch",
  "raise_stop_old_stop_exchange_state_mismatch",
  "raise_stop_recovery_compare_and_set_changed",
  "raise_stop_recovery_store_unavailable",
  "original_stop_cancel_pre_read_proof_unavailable",
  "original_stop_cancel_position_changed",
  "original_stop_cancel_stops_changed",
  "original_stop_cancel_read_only_budget_exceeded",
  "original_stop_cancel_recovery_compare_and_set_changed",
  "original_stop_cancel_recovery_store_unavailable",
  "close_pre_runner_split_mutation_provenance_missing",
  "close_pre_runner_split_current_proof_mismatch",
  "unresolved_intent_reconciliation_read_failed",
  "unresolved_intent_evidence_unverified",
]);

// A "blocked" runOnce() result means new signals are not being looked at at
// all. That is invisible from the outside unless someone happens to check --
// the owner needs to hear about it directly. Wait past this threshold before
// alerting, to rule out an ordinary single-tick stall rather than a genuine
// stuck pipeline; once alerted, allow a repeat alert if the SAME continuous
// incident is still unresolved after this much longer, since a problem that
// outlives one notification is worth resurfacing rather than going silent.
const BLOCKED_ALERT_AFTER_MS = 5 * 60 * 1000;
const BLOCKED_ALERT_REPEAT_MS = 30 * 60 * 1000;

function checkEntryEvidence(signal, evidence, profile = OWNER_POSITION_PROFILE) {
  const PROFILE_LEVERAGE = profile.leverage;
  const profileMarginIs = (value) => marginModeIs(value, profile);
  const fill = evidence?.fill;
  const position = evidence?.position;
  if (!validObject(fill) || !validObject(position) ||
      position.symbol !== signal.symbol ||
      position.side !== "Buy" ||
      !profileMarginIs(position.marginMode) ||
      Number(position.leverage) !== PROFILE_LEVERAGE) {
    throw new Error("entry_fill_or_isolated_position_not_verified");
  }
  const fillPrice = positive(fill.price, "verified fill price");
  const fillQuantity = positive(fill.quantity, "verified fill quantity");
  // The exchange can round the fill and position average in opposite
  // directions at the contract's quoted precision. Keep this final worker
  // gate consistent with the broker's independently verified entry proof.
  const precision = position.pricePrecision;
  const tick = 10 ** -precision;
  const priceDifference = Math.abs(Number(position.avgPrice) - fillPrice);
  const priceMatches = priceDifference <= Math.max(1e-10, fillPrice * 1e-8) ||
    Number.isSafeInteger(precision) && precision >= 0 && precision <= 12 &&
    priceDifference <= tick + Math.max(Number.EPSILON *
      Math.max(Number(position.avgPrice), fillPrice) * 4, 1e-15);
  if (Math.abs(Number(position.quantity) - fillQuantity) > Math.max(1e-10, fillQuantity * 1e-8) ||
      !priceMatches) {
    throw new Error("exchange_position_does_not_match_confirmed_fill");
  }
  const coreStop = evidence.protectiveStops?.core;
  if (coreStop?.verified !== true ||
      Number(coreStop.stopPrice) !== Number(signal.stopLoss) ||
      Number(coreStop.quantity) + 1e-10 < fillQuantity) {
    throw new Error("exact_signal_initial_stop_not_verified");
  }
  if (typeof position.positionId !== "string" || position.positionId.trim() === "" ||
      typeof coreStop.orderId !== "string" || coreStop.orderId.trim() === "" ||
      typeof coreStop.positionId !== "string" ||
      coreStop.positionId !== position.positionId) {
    throw new Error("exact_signal_initial_stop_identity_not_verified");
  }
  return { price: fillPrice, quantity: fillQuantity, at: fill.at };
}

function entryPriceAudit(signal, sizing, fill) {
  const referencePrice = Number(sizing?.signalReferencePrice);
  const fillPrice = Number(fill?.price);
  if (!Number.isFinite(referencePrice) || referencePrice <= 0 ||
      !Number.isFinite(fillPrice) || fillPrice <= 0) {
    return null;
  }
  const quotePrice = Number(sizing?.quotePrice);
  const quoteObservedAtMs = Number(sizing?.quoteObservedAtMs);
  const planningDeviation = Number(sizing?.signalPriceDeviationPct);
  const actualDeviation = ((fillPrice - referencePrice) / referencePrice) * 100;
  if (!Number.isFinite(actualDeviation)) return null;
  return {
    signalReferencePrice: String(signal.referencePrice),
    signalAt: signal.signalAt,
    ...(Number.isFinite(quotePrice) && quotePrice > 0
      ? { planningQuotePrice: String(sizing.quotePrice) } : {}),
    ...(Number.isSafeInteger(quoteObservedAtMs) && quoteObservedAtMs > 0
      ? { planningQuoteObservedAt: new Date(quoteObservedAtMs).toISOString() } : {}),
    ...(Number.isFinite(planningDeviation)
      ? { planningPriceDeviationPct: planningDeviation } : {}),
    verifiedFillPrice: String(fill.price),
    verifiedFillAt: fill.at,
    actualFillDeviationPct: Number(actualDeviation.toFixed(6)),
  };
}

function marginTopUpEvidenceMatches(request, evidence) {
  if (!validObject(evidence) || evidence.verified !== true ||
      evidence.status !== "filled" ||
      evidence.symbol !== request.symbol ||
      evidence.positionId !== request.positionId ||
      evidence.positionSide !== "LONG" ||
      Math.abs(Number(evidence.quantity) - Number(request.quantity)) >
        Math.max(1e-10, Number(request.quantity) * 1e-8)) {
    return false;
  }
  const before = Number(evidence.isolatedMarginBefore);
  const after = Number(evidence.isolatedMarginAfter);
  const delta = Number(evidence.marginDelta);
  const amount = Number(request.amount);
  const expectedBefore = Number(request.expectedIsolatedMarginBefore);
  const intentAt = Number(request.intentCreatedAt) ||
    Date.parse(request.intentCreatedAt);
  const tolerance = Math.max(1e-8, amount * 1e-10);
  const stop = evidence.protectiveStop;
  return evidence.marginHistory?.source === "bingx_position_margin_history" &&
    evidence.marginHistory?.attribution ===
      "unique_exchange_adjustment_without_operation_id" &&
    evidence.marginHistory?.positionId === request.positionId &&
    evidence.marginHistory?.changeReason === "ManualMarginAddition" &&
    Number.isSafeInteger(evidence.marginHistory?.time) &&
    Number.isSafeInteger(intentAt) &&
    evidence.marginHistory.time >= intentAt &&
    Number.isFinite(before) && Number.isFinite(after) && Number.isFinite(delta) &&
    Number.isFinite(amount) && Number.isFinite(expectedBefore) && amount > 0 &&
    before > 0 &&
    Math.abs(after - (before + delta)) <= tolerance &&
    Math.abs((after - before) - delta) <= tolerance &&
    Math.abs(delta - amount) <= Math.max(2e-8, tolerance) &&
    validObject(stop) && stop.orderId === request.stopOrderId &&
    stop.positionId === request.positionId &&
    Math.abs(Number(stop.quantity) - Number(request.quantity)) <=
      Math.max(1e-10, Number(request.quantity) * 1e-8) &&
    Number(stop.stopPrice) === Number(request.stopLoss) &&
    stop.status === "NEW" && stop.workingType === "MARK_PRICE";
}

function checkActionEvidence(request, evidence, profile = OWNER_POSITION_PROFILE) {
  const PROFILE_LEVERAGE = profile.leverage;
  const profileMarginIs = (value) => marginModeIs(value, profile);
  if (!isUsableIntentEvidence(evidence) || evidence.status !== "filled") {
    throw new Error("exchange_action_not_confirmed");
  }
  const position = evidence.position;
  if (!validObject(position) || position.verified !== true ||
      position.symbol !== request.symbol) {
    throw new Error("exchange_position_reconciliation_failed");
  }
  if (request.operation === "raise_stop") {
    if (position.side !== "Buy" || Number(position.quantity) <= 0 ||
        Number(position.leverage) !== PROFILE_LEVERAGE || !profileMarginIs(position.marginMode)) {
      throw new Error("exchange_position_leverage_or_margin_mode_changed");
    }
    const stop = evidence.protectiveStops?.[request.leg];
    if (stop?.verified !== true ||
        Number(stop.stopPrice) < Number(request.stopPrice) ||
        Number(stop.quantity) + 1e-10 < Number(request.quantity)) {
      throw new Error("raised_protective_stop_not_verified");
    }
    if (typeof position.positionId !== "string" ||
        typeof stop.orderId !== "string" || stop.orderId.trim() === "" ||
        stop.positionId !== position.positionId) {
      throw new Error("raised_protective_stop_identity_not_verified");
    }
  } else if (request.operation === "close_leg") {
    const fill = evidence.fill;
    const feeValue = fill?.fees ?? fill?.fee ?? fill?.commission;
    const feeEvidencePresent = validObject(fill) &&
      (Object.hasOwn(fill, "fees") || Object.hasOwn(fill, "fee") ||
       Object.hasOwn(fill, "commission"));
    const feeValueValid = typeof feeValue === "number"
      ? Number.isFinite(feeValue)
      : typeof feeValue === "string"
        ? feeValue.trim() !== "" && Number.isFinite(Number(feeValue))
        : Array.isArray(feeValue) || validObject(feeValue);
    if (!validObject(fill) ||
        !Number.isFinite(Number(fill.price)) || Number(fill.price) <= 0 ||
        !Number.isFinite(Number(fill.quantity)) || Number(fill.quantity) <= 0 ||
        Math.abs(Number(fill.quantity) - Number(request.quantity)) >
          Math.max(1e-10, Number(request.quantity) * 1e-8) ||
        !Number.isFinite(Date.parse(fill.at))) {
      throw new Error("close_fill_price_quantity_time_not_verified");
    }
    if (!feeEvidencePresent || feeValue === null || feeValue === undefined || !feeValueValid) {
      throw new Error("close_fill_fees_not_verified");
    }
    const remainder = Number(position.quantity);
    const expected = Number(request.previousQuantity) - Number(request.quantity);
    if (!Number.isFinite(remainder) || remainder < 0 ||
        Math.abs(remainder - expected) > Math.max(1e-10, Number(request.previousQuantity) * 1e-8)) {
      throw new Error("reduce_only_fill_and_position_reconciliation_mismatch");
    }
    // A venue may represent a flat position as an absent row/side or a
    // zero-quantity snapshot. For a confirmed full close, flat is the expected
    // result—not a missing LONG position to be rejected as a mismatch.
    if (expected > Math.max(1e-10, Number(request.previousQuantity) * 1e-8) &&
        (position.side !== "Buy" || Number(position.leverage) !== PROFILE_LEVERAGE ||
         !profileMarginIs(position.marginMode))) {
      throw new Error("exchange_position_leverage_or_margin_mode_changed");
    }
    if (expected > Math.max(1e-10, Number(request.previousQuantity) * 1e-8)) {
      const stops = evidence.protectiveStops ?? position.protectiveStops ?? {};
      for (const leg of ["core", "runner"]) {
        const open = leg === "core" ? request.nextPolicy?.coreOpen : request.nextPolicy?.runnerOpen;
        if (!open) continue;
        const stop = stops[leg];
        const stopPrice = leg === "core"
          ? request.nextPolicy.stopPrice : request.nextPolicy.runnerStopPrice;
        const quantity = leg === "core"
          ? request.nextPolicy.coreQty : request.nextPolicy.runnerQty;
        if (stop?.verified !== true ||
            Number(stop.stopPrice) !== Number(stopPrice) ||
            Number(stop.quantity) + 1e-10 < Number(quantity) ||
            typeof stop.orderId !== "string" || stop.orderId.trim() === "" ||
            typeof stop.positionId !== "string" || stop.positionId.trim() === "") {
          throw new Error("residual_protective_stop_identity_not_verified");
        }
      }
    }
  } else if (request.operation === "set_runner_break_even") {
    if (position.side !== "Buy" || Number(position.quantity) <= 0 ||
        Number(position.leverage) !== PROFILE_LEVERAGE || !profileMarginIs(position.marginMode)) {
      throw new Error("exchange_position_leverage_or_margin_mode_changed");
    }
    const stop = evidence.protectiveStops?.runner;
    if (stop?.verified !== true ||
        Number(stop.stopPrice) !== Number(request.stopPrice) ||
        Number(stop.quantity) + 1e-10 < Number(request.quantity)) {
      throw new Error("impulse_runner_break_even_stop_not_verified");
    }
    if (typeof position.positionId !== "string" ||
        typeof stop.orderId !== "string" || stop.orderId.trim() === "" ||
        stop.positionId !== position.positionId) {
      throw new Error("impulse_runner_break_even_stop_identity_not_verified");
    }
  }
}

function closeFillSnapshot(evidence) {
  const fill = Object.fromEntries(
    Object.entries(evidence.fill).filter(([, value]) => value !== undefined),
  );
  const feesProvided = Object.hasOwn(fill, "fees") ||
    Object.hasOwn(fill, "fee") || Object.hasOwn(fill, "commission");
  return {
    ...fill,
    fees: fill.fees ?? fill.fee ?? fill.commission,
    feeEvidenceAvailable: feesProvided,
    exchangeOrderId: evidence.exchangeOrderId ?? null,
  };
}

function confirmedActionPosition(request, evidence) {
  const position = {
    ...(request.nextPosition ?? {
      sourceSignalId: request.sourceSignalId,
      symbol: request.symbol,
      status: request.nextPolicy?.status ?? "open",
      ...request.nextPolicy,
    }),
  };
  if (request.operation === "close_leg") {
    position.lastCloseFill = closeFillSnapshot(evidence);
    position.residualProtectiveStops = evidence.protectiveStops ??
      evidence.position.protectiveStops ?? {};
  } else if (request.operation === "raise_stop") {
    position.verifiedProtectiveStops = evidence.protectiveStops ??
      evidence.position.protectiveStops ?? {};
  }
  if (typeof evidence.position?.positionId === "string" &&
      evidence.position.positionId.trim() !== "") {
    position.exchangePositionId = evidence.position.positionId;
  }
  const stops = evidence.protectiveStops ?? evidence.position?.protectiveStops ?? {};
  const coreStop = stops.core;
  if (coreStop?.verified === true &&
      typeof coreStop.orderId === "string" && coreStop.orderId.trim() !== "" &&
      typeof coreStop.positionId === "string" && coreStop.positionId.trim() !== "" &&
      Number.isFinite(Number(coreStop.quantity)) && Number(coreStop.quantity) > 0) {
    position.coreStopOrderId = coreStop.orderId;
    position.coreStopQuantity = Number(coreStop.quantity);
    position.coreStopPositionId = coreStop.positionId;
    position.coreStopPrice = Number(coreStop.stopPrice);
    if (Number.isSafeInteger(request.stopStartedAt)) {
      position.coreStopStartedAt = request.stopStartedAt;
    }
  }
  if (request.operation === "raise_stop") {
    const raisedStop = stops[request.leg];
    if (raisedStop?.verified === true) {
      position.stopPrice = Number(raisedStop.stopPrice);
      position.verifiedProtectiveStops = { ...stops };
      if (request.leg === "core") {
        position.coreStopOrderId = raisedStop.orderId;
        position.coreStopPositionId = raisedStop.positionId;
        position.coreStopQuantity = Number(raisedStop.quantity);
        position.coreStopPrice = Number(raisedStop.stopPrice);
      }
    }
  }
  if (request.operation === "raise_stop" &&
      request.priorPosition?.patternId === "impulse_buy" &&
      request.priorPosition.strategyAuthority !== "source" &&
      request.priorPosition.coreOpen === true &&
      request.priorPosition.runnerOpen === false) {
    const split = position.split;
    const verifiedCoreStop = stops.core;
    if (!validObject(split) || split.stage !== "complete" ||
        verifiedCoreStop?.verified !== true ||
        verifiedCoreStop.positionId !== request.priorPosition.exchangePositionId ||
        typeof verifiedCoreStop.orderId !== "string" ||
        verifiedCoreStop.orderId.trim() === "" ||
        Number(verifiedCoreStop.quantity) !== Number(request.quantity) ||
        !Number.isFinite(Number(verifiedCoreStop.stopPrice)) ||
        Number(verifiedCoreStop.stopPrice) < Number(request.stopPrice)) {
      throw new Error("impulse_sole_core_stop_upgrade_evidence_not_verified");
    }
    const nextStop = {
      ...verifiedCoreStop,
      tranche: "core",
      quantity: String(verifiedCoreStop.quantity),
      stopPrice: String(verifiedCoreStop.stopPrice),
    };
    position.stopPrice = Number(verifiedCoreStop.stopPrice);
    position.split = {
      ...split,
      coreStop: nextStop,
      runnerStop: null,
      activeLegs: ["core"],
      baselineOpenOrderIds: [verifiedCoreStop.orderId],
    };
    position.baselineOpenOrderIds = [verifiedCoreStop.orderId];
    position.coreStopOrderId = verifiedCoreStop.orderId;
    position.coreStopPositionId = verifiedCoreStop.positionId;
    position.coreStopQuantity = Number(verifiedCoreStop.quantity);
    position.verifiedProtectiveStops = { core: nextStop };
  }
  return position;
}

/**
 * Build the isolated VST worker. No BingX adapter is implicitly selected and
 * no URL/network client is created here.
 *
 * Injected broker contract:
 * - getCapabilities() -> {environment:"vst", verified:true, accountId,
 *   features:[all REQUIRED_CAPABILITIES]}. These are verified account/venue
 *   facts, not caller assertions copied from configuration.
 * - readPlanningInputs(signal) -> {balanceSnapshot, quote:{price,observedAtMs},
 *   filters, marginMode, marginModeVerified, requiresIsolatedMarginPreparation,
 *   risk:{takerFeeRate,fundingRate,maintenanceMarginRate,stopBufferRate,tickSize}}.
 *   This and readAccountState/readMarketMark/readPosition(symbol, options)
 *   are strictly reads.
 * - readAccountState() -> {positions:[], openOrders:[]}; unexplained existing
 *   positions/orders fail closed before any entry.
 * - performIntent({clientOrderId, phase, request}) is the broker's sole
 *   mutation boundary. It must use VST/testnet only. Every call is preceded
 *   by a committed, unique intent and a durable submitted phase.
 * - reconcileIntent({clientOrderId,phase,request}) is read-only and returns
 *   {verified:true,status:"filled"|"working"|"rejected"|"unknown",fill?,
 *   position?,protectiveStops?}. A response acknowledgement is never a fill.
 * - readMarketMark(symbol), readPosition(symbol, {
 *   persistedPosition, allowProcessCache: false }) are read-only. Position
 *   snapshots include verified exchange position/protective-stop facts.
 * Missing or unverified protective capabilities keep queued signals pending
 * while read-only reconciliation and exposure checks continue where possible.
 * No mutation is attempted without the complete verified capability set.
 */
export function createVstWorker({
  store,
  broker,
  clock = Date.now,
  sizingLimits = {},
  sourceExitsEnabled = false,
  strategyAuthority = "policy",
  exitStrategy = "source",
  entryGuard,
  shouldYieldToUrgentWork,
  entryBatchSize = 1,
  entryBatchBudgetMs = 10_000,
  onBlocked,
  onTiming,
  // Leverage, margin mode and per-trade allocation of every position this
  // worker opens and manages. Owner: isolated 10x, 1% of balance.
  positionProfile = broker?.positionProfile ?? OWNER_POSITION_PROFILE,
}) {
  const PROFILE = normalizePositionProfile(positionProfile);
  const PROFILE_LEVERAGE = PROFILE.leverage;
  const PROFILE_MARGIN = PROFILE.marginMode;
  const profileMarginIs = (value) => marginModeIs(value, PROFILE);
  async function urgentWorkPending() {
    if (typeof shouldYieldToUrgentWork !== "function") return false;
    try { return await shouldYieldToUrgentWork() === true; }
    catch { return true; }
  }
  const urgentYield = () => ({ kind: "waiting", reason: "priority_work_queued" });
  let directCloseCompletion = null;
  // ---- Fixed +5% take: detection, durable latch, dedicated close lane and
  // escalation. Failure policy:
  //  * a touch is latched in memory, in the position snapshot and as an
  //    append-only vst_full_take_touched event (restart-safe);
  //  * every tick first tries the latched close through the same verified
  //    full-exit lane as an owner close command, independent of unrelated
  //    position work (margin top-up waits, stop raises, capability gaps);
  //  * the last reason the close did not complete is kept per position;
  //  * if the position is still open FULL_TAKE_DELAYED_MS after the touch,
  //    one Telegram notice is queued; after FULL_TAKE_STUCK_MS a second one
  //    asks for a manual close. Both are durable and sent once.
  // The exchange stop-loss is never touched by this path until the verified
  // close lane itself cleans up exact owned stops after a confirmed close.
  const FULL_TAKE_DELAYED_MS = 90_000;
  const FULL_TAKE_STUCK_MS = 15 * 60_000;
  // sourceSignalId -> evidence (bound to the exact entry via requestId).
  const fullTakeLatches = new Map();
  // sourceSignalId -> { lastReason, delayedSent, stuckSent }
  const fullTakeProgress = new Map();
  // A notice must not be raised before this process has tried to close
  // (e.g. right after a restart); a hung tick still escalates after grace.
  const fullTakeProcessStartedAt = Number(clock());
  const FULL_TAKE_STARTUP_GRACE_MS = 180_000;
  const fullTakeAttempted = new Set();

  function fullTakeProgressFor(sourceSignalId) {
    let progress = fullTakeProgress.get(sourceSignalId);
    if (!progress) {
      progress = { lastReason: null, delayedSent: false, stuckSent: false };
      fullTakeProgress.set(sourceSignalId, progress);
    }
    return progress;
  }

  function latchedFullTakeEvidence(record) {
    const state = record?.snapshot ?? {};
    const requestId = fullTakeRequestId(record?.sourceSignalId, state.entryPrice);
    for (const candidate of [fullTakeLatches.get(record?.sourceSignalId), state.fullTakeLatch]) {
      if (fullTakeEvidenceValid(candidate, record?.sourceSignalId, state.symbol, requestId)) {
        return candidate;
      }
    }
    return null;
  }

  function forgetClosedFullTakes(openRecords) {
    const openIds = new Set(openRecords.map((record) => record?.sourceSignalId));
    for (const id of [...fullTakeLatches.keys()]) if (!openIds.has(id)) fullTakeLatches.delete(id);
    for (const id of [...fullTakeProgress.keys()]) if (!openIds.has(id)) fullTakeProgress.delete(id);
  }

  // Restores latches and escalation flags from the append-only event ledger.
  async function loadDurableFullTakes(openRecords) {
    if (typeof store.listFullTakeEvents !== "function") return;
    let rows;
    try { rows = await store.listFullTakeEvents(); } catch (error) {
      recordVstDiagnostic(error, { stage: "fullTakeWatch", operation: "load_full_take_events" });
      return;
    }
    const byId = new Map(openRecords.map((record) => [record.sourceSignalId, record]));
    for (const row of Array.isArray(rows) ? rows : []) {
      const record = byId.get(row?.sourceSignalId);
      if (!record) continue;
      if (row.kind === "vst_full_take_close_delayed") fullTakeProgressFor(record.sourceSignalId).delayedSent = true;
      if (row.kind === "vst_full_take_close_stuck") fullTakeProgressFor(record.sourceSignalId).stuckSent = true;
      if (row.kind !== "vst_full_take_touched" || latchedFullTakeEvidence(record)) continue;
      const detail = row.detail ?? {};
      const rebuilt = fullTakeRowFromTouch({
        sourceSignalId: record.sourceSignalId, symbol: record.snapshot?.symbol,
        entryPrice: detail.entryPrice, observedPrice: detail.observedPrice,
        observedAt: detail.observedAt,
      });
      if (detail.symbol === record.snapshot?.symbol &&
          fullTakeEvidenceValid(rebuilt.evidence, record.sourceSignalId, record.snapshot?.symbol,
            fullTakeRequestId(record.sourceSignalId, record.snapshot?.entryPrice))) {
        fullTakeLatches.set(record.sourceSignalId, rebuilt.evidence);
      }
    }
  }

  // Every change of the reason a latched close did not complete is written
  // to the ledger (not Telegram) and the log, so a stuck take is diagnosable.
  async function noteFullTakeProgress(record, reason, extra = {}) {
    if (typeof reason !== "string" || !reason) return;
    const progress = fullTakeProgressFor(record.sourceSignalId);
    if (progress.lastReason === reason) return;
    progress.lastReason = reason;
    const detail = { symbol: record.snapshot?.symbol ?? record.symbol, reason,
      positionStatus: record.status ?? null,
      ...Object.fromEntries(Object.entries(extra).filter(([, v]) =>
        typeof v === "string" && /^[A-Za-z0-9_:.-]{1,160}$/.test(v))) };
    try { await store.recordEvent?.(record.sourceSignalId, "vst_full_take_close_progress", detail); }
    catch (error) {
      recordVstDiagnostic(error, { stage: "fullTakeExits", operation: "record_full_take_progress",
        symbol: detail.symbol, sourceSignalId: record.sourceSignalId });
    }
    try { process.stdout.write(`Bullet VST full-take close: ${JSON.stringify({ sourceSignalId: record.sourceSignalId, ...detail })}\n`); }
    catch {}
  }

  // Durable, once-only notices for a touched take that has not closed.
  async function escalateStalledFullTakes(openRecords) {
    const now = Number(clock());
    for (const record of openRecords) {
      if (record?.status === "closed") continue;
      const evidence = latchedFullTakeEvidence(record);
      if (!evidence) continue;
      const age = now - Date.parse(evidence.observedAt);
      if (!Number.isFinite(age)) continue;
      if (!fullTakeAttempted.has(record.sourceSignalId) &&
          now - fullTakeProcessStartedAt < FULL_TAKE_STARTUP_GRACE_MS) continue;
      const progress = fullTakeProgressFor(record.sourceSignalId);
      const stage = age >= FULL_TAKE_STUCK_MS && !progress.stuckSent ? "stuck"
        : age >= FULL_TAKE_DELAYED_MS && !progress.delayedSent && !progress.stuckSent ? "delayed"
          : null;
      if (!stage) continue;
      try {
        await store.recordEvent?.(record.sourceSignalId,
          stage === "stuck" ? "vst_full_take_close_stuck" : "vst_full_take_close_delayed", {
            symbol: record.snapshot?.symbol, entryPrice: evidence.entryPrice,
            observedPrice: evidence.observedPrice, observedAt: evidence.observedAt,
            ageSeconds: Math.round(age / 1000),
            reason: progress.lastReason ?? "full_take_close_not_attempted",
          });
        if (stage === "stuck") progress.stuckSent = true;
        progress.delayedSent = true;
      } catch (error) {
        recordVstDiagnostic(error, { stage: "fullTakeWatch", operation: "escalate_full_take",
          symbol: record.snapshot?.symbol, sourceSignalId: record.sourceSignalId });
      }
    }
  }

  // Runs on its own timer, independent of the (possibly slow or stuck) tick.
  // Read-only towards the exchange: one bulk last-price read. Returns the
  // number of new touches so the caller can wake the worker.
  async function observeFullTakePrices() {
    if (exitStrategy !== FULL_TAKE_5PCT || typeof store.listOpenPositions !== "function") return 0;
    const open = (await store.listOpenPositions()).filter((record) => record?.status !== "closed");
    forgetClosedFullTakes(open);
    await loadDurableFullTakes(open);
    let latched = 0;
    try {
      const records = open.filter((record) =>
        record?.status === "open" && Number(record.snapshot?.remainingQty) > 0 &&
        record.snapshot?.environment === "vst" &&
        typeof record.snapshot?.symbol === "string" &&
        !latchedFullTakeEvidence(record));
      if (records.length === 0 || typeof broker.readLastPrices !== "function") return 0;
      const quotes = await broker.readLastPrices([...new Set(records.map((r) => r.snapshot.symbol))]);
      const bySymbol = new Map((Array.isArray(quotes) ? quotes : []).map((q) => [q.symbol, q]));
      for (const record of records) {
        const quote = bySymbol.get(record.snapshot.symbol);
        if (!quote) continue;
        const row = fullTakeRequest({ ...record.snapshot, sourceSignalId: record.sourceSignalId },
          { ...quote, price: quote.priceDecimal ?? quote.price }, Number(clock()));
        if (!row) continue;
        fullTakeLatches.set(record.sourceSignalId, row.evidence);
        latched += 1;
        try {
          await store.recordEvent?.(record.sourceSignalId, "vst_full_take_touched", {
            symbol: record.snapshot.symbol, entryPrice: row.evidence.entryPrice,
            observedPrice: row.evidence.observedPrice, observedAt: row.evidence.observedAt,
            source: quote.source ?? "last_trade",
          });
          await store.latchFullTakeEvidence?.(record.sourceSignalId, row.evidence);
        } catch (error) {
          // The in-memory latch still closes the position on the next tick.
          recordVstDiagnostic(error, { stage: "fullTakeWatch", operation: "latch_full_take",
            symbol: record.snapshot.symbol, sourceSignalId: record.sourceSignalId });
        }
      }
      return latched;
    } finally {
      // Escalation must run even when the price read fails or the tick hangs.
      await escalateStalledFullTakes(open);
    }
  }

  // Tick-start lane: close every latched take through the verified full-exit
  // path. Returns an "acted" result after one exchange action so the tick
  // boundary (one mutation per tick) is preserved.
  // ---- Positions closed outside the bot (by hand on BingX, liquidation,
  // or an order whose outcome was lost). Proof required before the ledger is
  // changed: EXTERNAL_FLAT_MIN_OBSERVATIONS consecutive verified account
  // reads, spanning at least EXTERNAL_FLAT_MIN_SPAN_MS, each showing no
  // position and no open order for the symbol, and no write of this signal
  // in flight during the last EXTERNAL_FLAT_INFLIGHT_MS.
  const EXTERNAL_FLAT_MIN_OBSERVATIONS = 3;
  const EXTERNAL_FLAT_MIN_SPAN_MS = 3 * 60_000;
  const EXTERNAL_FLAT_INFLIGHT_MS = 5 * 60_000;
  const externalFlatObservations = new Map(); // sourceSignalId -> { first, last, count }

  async function reconcileExternallyFlatPositions(openPositions, accountState, unresolved) {
    if (typeof store.closeVerifiedFlatPosition !== "function") return null;
    const live = new Set(openPositions.map((record) => record?.sourceSignalId));
    for (const id of [...externalFlatObservations.keys()]) {
      if (!live.has(id)) externalFlatObservations.delete(id);
    }
    if (!validObject(accountState) || accountState.verified !== true ||
        accountState.environment !== "vst" || typeof accountState.accountId !== "string" ||
        !Array.isArray(accountState.positions) || !Array.isArray(accountState.openOrders)) {
      return null;
    }
    const now = Number(clock());
    for (const record of openPositions) {
      const state = record?.snapshot;
      if (!["open", "closing", "unknown"].includes(record?.status) ||
          state?.environment !== "vst" || state?.accountId !== accountState.accountId ||
          !isCanonicalVstSymbol(record.symbol)) continue;
      const symbolKey = normalizeSymbolKey(record.symbol);
      const flat = flatPositionFromAccountState(accountState, record.symbol) &&
        (symbolOrders(accountState, record.symbol) ?? [null]).length === 0;
      const inFlight = unresolved.some((intent) =>
        (intent.sourceSignalId === record.sourceSignalId || intentBlocksSymbol(intent, symbolKey)) &&
        ["prepared", "submitted"].includes(intent.state) &&
        now - new Date(intent.updatedAt ?? intent.createdAt ?? 0).getTime() < EXTERNAL_FLAT_INFLIGHT_MS);
      if (!flat || inFlight) {
        externalFlatObservations.delete(record.sourceSignalId);
        continue;
      }
      const prior = externalFlatObservations.get(record.sourceSignalId);
      const seen = prior ? { ...prior, last: now, count: prior.count + 1 } : { first: now, last: now, count: 1 };
      externalFlatObservations.set(record.sourceSignalId, seen);
      if (seen.count < EXTERNAL_FLAT_MIN_OBSERVATIONS || seen.last - seen.first < EXTERNAL_FLAT_MIN_SPAN_MS) continue;
      // Second, independent proof from the per-symbol position endpoint.
      let direct;
      try { direct = await broker.readPosition(record.symbol); } catch { continue; }
      if (direct?.verified !== true || direct.environment !== "vst" ||
          direct.accountId !== accountState.accountId || Number(direct.quantity) !== 0) {
        externalFlatObservations.delete(record.sourceSignalId);
        continue;
      }
      const closed = await store.closeVerifiedFlatPosition(record.sourceSignalId, {
        observation: {
          verified: true, environment: "vst", accountId: accountState.accountId,
          symbol: record.symbol, positionQuantity: "0", openOrderCount: 0,
          observations: seen.count,
          firstObservedAt: new Date(seen.first).toISOString(),
          lastObservedAt: new Date(seen.last).toISOString(),
        },
      });
      externalFlatObservations.delete(record.sourceSignalId);
      if (!closed) continue;
      fullTakeLatches.delete(record.sourceSignalId);
      fullTakeProgress.delete(record.sourceSignalId);
      managementFailures.delete(record.sourceSignalId);
      // A queued source exit for a position that is already gone is done.
      if (sourceExitsEnabled && typeof store.listPendingSourceExitRequests === "function") {
        try {
          const pending = await store.listPendingSourceExitRequests({ sourceSignalId: record.sourceSignalId });
          for (const row of Array.isArray(pending) ? pending : []) {
            await store.finishSourceExitRequest(row.requestId, {
              outcome: "closed", detail: { closureOrigin: "external_close_verified_flat" },
            });
          }
        } catch (error) {
          recordVstDiagnostic(error, { stage: "externalClose", operation: "finish_source_exit",
            symbol: record.symbol, sourceSignalId: record.sourceSignalId });
        }
      }
      try {
        process.stdout.write(`Bullet VST external close verified: ${JSON.stringify({
          sourceSignalId: record.sourceSignalId, symbol: record.symbol, previousStatus: record.status,
          observations: seen.count })}\n`);
      } catch {}
      return { kind: "acted", operation: "external_close_verified_flat",
        sourceSignalId: record.sourceSignalId, symbol: record.symbol };
    }
    return null;
  }

  const MANAGEMENT_FAILURE_QUARANTINE_REPEATS = 3;
  // sourceSignalId -> { ref, count, reported }
  const managementFailures = new Map();
  function noteManagementFailure(sourceSignalId, ref) {
    const prior = managementFailures.get(sourceSignalId);
    const next = prior?.ref === ref
      ? { ...prior, count: prior.count + 1 }
      : { ref, count: 1, reported: false };
    managementFailures.set(sourceSignalId, next);
    return next.count;
  }
  async function reportManagementQuarantine(record, ref) {
    const entry = managementFailures.get(record.sourceSignalId);
    if (!entry || entry.reported) return;
    entry.reported = true;
    try {
      await store.recordEvent?.(record.sourceSignalId, "vst_position_management_quarantined", {
        symbol: record.symbol, diagnosticRef: ref, repeats: entry.count,
      });
    } catch (error) {
      recordVstDiagnostic(error, { stage: "positionManagement", operation: "record_quarantine",
        symbol: record.symbol, sourceSignalId: record.sourceSignalId });
    }
    try {
      process.stdout.write(`Bullet VST position quarantined: ${JSON.stringify({
        sourceSignalId: record.sourceSignalId, symbol: record.symbol, diagnosticRef: ref })}\n`);
    } catch {}
  }

  const MANAGED_POSITIONS_PER_TICK_WHILE_ENTRY_WAITS = 2;
  let managementRotation = 0;
  async function freshEntryWaiting() {
    if (typeof store.getPending !== "function") return false;
    try {
      const next = await store.getPending();
      return Boolean(next) &&
        isFreshSignalAt(next.body?.signalAt, Number(clock()));
    } catch { return false; }
  }
  async function positionsToManageThisTick(openPositions) {
    if (openPositions.length <= MANAGED_POSITIONS_PER_TICK_WHILE_ENTRY_WAITS ||
        !(await freshEntryWaiting())) return openPositions;
    const start = managementRotation % openPositions.length;
    managementRotation = start + MANAGED_POSITIONS_PER_TICK_WHILE_ENTRY_WAITS;
    return Array.from({ length: MANAGED_POSITIONS_PER_TICK_WHILE_ENTRY_WAITS },
      (_, index) => openPositions[(start + index) % openPositions.length]);
  }

  async function processLatchedFullTakes(recordTiming = null) {
    if (exitStrategy !== FULL_TAKE_5PCT) return null;
    const startedAt = performance.now();
    try {
      const open = (await store.listOpenPositions()).filter((record) => record?.status !== "closed");
      forgetClosedFullTakes(open);
      await loadDurableFullTakes(open);
      let capabilities;
      for (const record of open) {
        const evidence = latchedFullTakeEvidence(record);
        if (!evidence) continue;
        // A close that cannot complete (e.g. the position was closed by hand
        // and needs owner review) is retried every 30s, not on every tick:
        // each attempt costs several paced exchange reads.
        const retryAt = fullTakeProgress.get(record.sourceSignalId)?.retryAt ?? 0;
        if (Number(clock()) < retryAt) continue;
        const symbol = record.snapshot?.symbol;
        fullTakeAttempted.add(record.sourceSignalId);
        if (sourceExitBlockedSymbols.has(normalizeSymbolKey(symbol))) {
          await noteFullTakeProgress(record, "source_exit_blocked_for_symbol",
            { blockingReason: sourceExitBlockedRows.get(normalizeSymbolKey(symbol))?.reason });
          continue;
        }
        if (capabilities === undefined) {
          try { capabilities = await broker.getCapabilities(); } catch { capabilities = null; }
        }
        if (!capabilities) {
          await noteFullTakeProgress(record, "source_exit_capabilities_unavailable");
          continue;
        }
        const requestId = fullTakeRequestId(record.sourceSignalId, record.snapshot?.entryPrice);
        const row = { requestId, sourceSignalId: record.sourceSignalId, symbol,
          reason: FULL_TAKE_REASON, asOf: evidence.asOf, observedAt: evidence.observedAt, evidence };
        let result;
        let completed = null;
        directCloseCompletion = { requestId, completed: null };
        try {
          result = await processSourceExitRequest(row, record, capabilities,
            sourceExitPrerequisiteAttemptsThisTick);
        } catch (error) {
          recordVstDiagnostic(error, { stage: "fullTakeExits", operation: "full_take_close",
            symbol, sourceSignalId: record.sourceSignalId });
          await noteFullTakeProgress(record, "full_take_close_exception",
            { error: error instanceof Error ? error.message.slice(0, 160) : undefined });
          if (exchangeActionAttemptedThisTick) throw error;
          continue;
        } finally {
          completed = directCloseCompletion?.completed ?? null;
          directCloseCompletion = null;
        }
        if (completed?.outcome === "closed") {
          fullTakeLatches.delete(record.sourceSignalId);
          fullTakeProgress.delete(record.sourceSignalId);
        } else {
          if (result?.kind !== "acted" && !exchangeActionAttemptedThisTick) {
            fullTakeProgressFor(record.sourceSignalId).retryAt = Number(clock()) + 30_000;
          }
          await noteFullTakeProgress(record,
            completed?.detail?.reason ?? result?.reason ?? result?.operation ?? result?.kind,
            { kind: result?.kind, operation: result?.operation,
              blockingSourceSignalId: result?.blockingSourceSignalId,
              blockingOperation: result?.blockingOperation ?? undefined,
              blockingClientOrderId: result?.blockingClientOrderId ?? undefined });
        }
        if (result?.kind === "acted" || exchangeActionAttemptedThisTick) {
          return result?.kind === "acted" ? result
            : { kind: "acted", operation: "full_take_close_attempted" };
        }
      }
      return null;
    } finally {
      if (typeof recordTiming === "function") {
        recordTiming("fullTakeExits", performance.now() - startedAt);
      }
    }
  }
  if (!["source", FULL_TAKE_5PCT].includes(exitStrategy)) throw new TypeError("Invalid exit strategy");
  if (!store) throw new TypeError("A separate VST store is required");
  if (!["policy", "source"].includes(strategyAuthority)) {
    throw new TypeError("VST strategyAuthority must be source or policy");
  }
  if (typeof store.withLeaderLock !== "function" ||
      typeof store.getPending !== "function" ||
      typeof store.reserveIntent !== "function" ||
      typeof store.listUnresolvedIntents !== "function" ||
      typeof store.getIntent !== "function") {
    throw new TypeError("VST store does not implement the required durable interface");
  }
  if (sourceExitsEnabled !== true && sourceExitsEnabled !== false) {
    throw new TypeError("sourceExitsEnabled must be an explicit boolean");
  }
  if (!Number.isSafeInteger(entryBatchSize) || entryBatchSize < 1 ||
      entryBatchSize > 3 || !Number.isFinite(entryBatchBudgetMs) ||
      entryBatchBudgetMs <= 0 || entryBatchBudgetMs > 30_000) {
    throw new TypeError("VST entry batch options must be bounded (size 1-3, budget <= 30000ms)");
  }
  if (sourceExitsEnabled && [
    "queueSourceExitRequests",
    "listPendingSourceExitRequests",
    "finishSourceExitRequest",
    "hasPendingSourceExitRequest",
    "getPosition",
  ].some((method) => typeof store[method] !== "function")) {
    throw new TypeError("VST source-exit store interface is incomplete");
  }
  if (sizingLimits.environment !== undefined && sizingLimits.environment !== "vst") {
    throw new Error("VST worker refuses every non-VST environment");
  }
  let exchangeActionAttemptedThisTick = false;
  let sourceExitBlockedSymbols = new Set();
  let sourceExitBlockedRows = new Map();
  let sourceExitPrerequisiteAttemptsThisTick = new Set();
  // Scheduling hint only, never exchange evidence. A normal management sweep
  // may hand its confirmed preparation to at most two subsequent fresh ticks.
  // Entry completion/error, a changed queue head, any refused tick, or restart
  // drops the hint and restores normal position-management priority.
  let preparedEntryContinuation = null;

  function rememberPreparedEntry(row, result, accountId, remaining = 2) {
    if (result?.kind === "prepared" && remaining > 0 &&
        ["isolated_margin_mode_confirmed", "isolated_leverage_confirmed"]
          .includes(result.reason)) {
      preparedEntryContinuation = {
        sourceSignalId: row.sourceSignalId,
        symbol: row.body?.symbol,
        accountId,
        remaining,
      };
    }
  }

  async function continuePreparedEntry(
    continuation, assessment, accountState, openPositions, unresolved,
    unresolvedMarginTopUpBySymbol, recordTiming,
  ) {
    if (!continuation || !assessment.mutationCapabilities ||
        exchangeActionAttemptedThisTick ||
        accountState?.verified !== true ||
        accountState.environment !== "vst" ||
        accountState.accountId !== continuation.accountId ||
        assessment.capabilities?.accountId !== continuation.accountId ||
        !Array.isArray(accountState.positions) ||
        !Array.isArray(accountState.openOrders)) return null;
    const symbolKey = normalizeSymbolKey(continuation.symbol);
    if (!symbolKey || sourceExitBlockedSymbols.has(symbolKey) ||
        unresolvedMarginTopUpBySymbol.has(symbolKey) ||
        unresolved.some((intent) => intentBlocksSymbol(intent, symbolKey)) ||
        openPositions.some((record) =>
          record.sourceSignalId === continuation.sourceSignalId ||
          normalizeSymbolKey(record.symbol) === symbolKey) ||
        accountState.positions.some((row) =>
          normalizeSymbolKey(row?.symbol) === symbolKey) ||
        accountState.openOrders.some((row) =>
          normalizeSymbolKey(row?.symbol) === symbolKey)) return null;
    // Respect the CURRENT priority head: never keep a private cross-tick cursor
    // that hides newly prioritized work or scan past the head using this hint.
    const row = await store.getPending();
    if (row?.sourceSignalId !== continuation.sourceSignalId ||
        normalizeSymbolKey(row.body?.symbol) !== symbolKey ||
        !["planning", "opening"].includes(row.status) ||
        !isFreshSignalAt(row.body?.signalAt, Number(clock()))) return null;
    if (sourceExitsEnabled &&
        await store.hasPendingSourceExitRequest(row.sourceSignalId)) return null;
    const started = performance.now();
    try {
      // Keep the unchanged fresh planning, exact-symbol account check, durable
      // intent, exchange preflight, and one-mutation-per-tick entry pipeline.
      const result = await openSignal(
        row, assessment.mutationCapabilities, assessment.capabilities,
      );
      rememberPreparedEntry(
        row, result, continuation.accountId, continuation.remaining - 1,
      );
      return result;
    } finally {
      recordTiming("entryPreparation", performance.now() - started);
      recordTiming("entryContinuation", performance.now() - started);
    }
  }

  async function prepareIntentRequest(signalId, phase, request) {
    const clientOrderId = orderId(signalId, phase);
    // Look up the intent for this (signal, phase) in ANY state, not only the
    // unresolved ones. A phase that already reconciled on an earlier tick
    // (e.g. isolated-leverage-10) is rebuilt from scratch on every re-entry
    // into this planning path; reusing only the unresolved list here would
    // stamp a brand-new intentCreatedAt onto that rebuilt request, and
    // reserveIntent would then reject it as conflicting with the persisted,
    // already-reconciled row even though every other field is identical.
    const existing = await store.getIntent(signalId, phase);
    if (existing && existing.clientOrderId === clientOrderId &&
        existing.sourceSignalId === signalId) {
      const priorTimestamp = existing.request?.intentCreatedAt;
      if (Number.isSafeInteger(priorTimestamp) && priorTimestamp > 0) {
        request.intentCreatedAt = priorTimestamp;
      } else {
        delete request.intentCreatedAt;
      }
      return request;
    }
    const intentCreatedAt = Number(clock());
    if (!Number.isSafeInteger(intentCreatedAt) || intentCreatedAt <= 0) {
      throw new Error("vst_intent_preparation_timestamp_invalid");
    }
    request.intentCreatedAt = intentCreatedAt;
    return request;
  }

  function safeStopAcknowledgement(value) {
    if (!validObject(value) ||
        !["object", "array", "null", "string", "number", "boolean", "undefined", "other"]
          .includes(value.responseType) ||
        !["absent", "null", "array", "object", "scalar"].includes(value.orderWrapper) ||
        !["response_not_object", "nested_order_not_object", "null_alias",
          "invalid_identifier", "missing_id", "conflicting_aliases"].includes(value.reason)) {
      return null;
    }
    const fields = ["flatOrderIdPresent", "flatOrderIDPresent",
      "nestedOrderIdPresent", "nestedOrderIDPresent"];
    if (fields.some(field => typeof value[field] !== "boolean")) return null;
    return {
      responseType: value.responseType, orderWrapper: value.orderWrapper,
      ...Object.fromEntries(fields.map(field => [field, value[field]])),
      reason: value.reason,
    };
  }

  async function reserveAndPerform(signalId, phase, request) {
    const journaled = isStopTransferOperation(request.operation) &&
      broker.stopTransferJournalVersion === STOP_TRANSFER_PROTOCOL &&
      typeof store.advanceStopTransfer === "function";
    if (journaled) request.stopTransferProtocol = STOP_TRANSFER_PROTOCOL;
    await prepareIntentRequest(signalId, phase, request);
    const clientOrderId = orderId(signalId, phase);
    if (request.operation === "entry") {
      const existing = await store.getIntent(signalId, phase);
      if (!existing && !isFreshSignalAt(request.signal?.signalAt, Number(clock()))) {
        const reason = "signal_expired_before_entry_reservation";
        await store.setSignalStatus(signalId, "rejected", reason);
        await store.recordEvent?.(signalId, "vst_signal_rejected", { reason });
        return { kind: "rejected", reason };
      }
    }
    const reservation = await store.reserveIntent({
      sourceSignalId: signalId, phase, clientOrderId, request,
    });
    if (reservation.kind !== "new") {
      return { kind: "existing", intent: reservation.intent, clientOrderId };
    }
    // Mark submitted before crossing the mutation boundary. A crash from this
    // point onward is ambiguous and can only be settled by exchange reads.
    await store.markIntent(clientOrderId, "submitted", { outcome: {
      phase: journaled ? "stop_transfer_preparing" : "submission_started",
      ...(journaled ? { stopTransfer: { version: STOP_TRANSFER_PROTOCOL, stage: "prepared" } } : {}),
    } });
    const stopTransferJournal = journaled ? createTransferJournal({
      clientOrderId, request,
    }) : null;
    let submittedExchangeOrderId;
    const normalizedSubmissionId = (value) => {
      if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
      return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
    };
    const onSubmission = async (submission) => {
      const exchangeOrderId = normalizedSubmissionId(submission?.exchangeOrderId);
      if (!exchangeOrderId) throw new Error("vst_submission_order_id_unverified");
      if (stopTransferJournal &&
          ["raise_stop", "split_raise_stop_place"].includes(request.operation)) {
        await stopTransferJournal.acknowledge(exchangeOrderId);
      }
      if (submittedExchangeOrderId === exchangeOrderId) return;
      if (submittedExchangeOrderId) {
        throw new Error("vst_submission_order_id_conflict");
      }
      // Set the local ID before persistence so an interrupted acknowledgement
      // write still carries it into the unknown outcome below.
      submittedExchangeOrderId = exchangeOrderId;
      await store.markIntent(clientOrderId, "submitted", {
        exchangeOrderId,
        outcome: { phase: "submission_response_received" },
      });
    };
    try {
      exchangeActionAttemptedThisTick = true;
      const submission = await broker.performIntent({
        clientOrderId, phase, request, onSubmission,
        ...(stopTransferJournal ? { stopTransferJournal } : {}),
        ...(request.operation === "entry" &&
            request.entrySizingPolicy === "fresh-before-sign-v1" ? {
          onEntryReprice: async ({ sizing, filters, finalQuote, checkedAtMs }) => {
            const next = {
              ...request, quantity: sizing.quantity, maxEntryPrice: sizing.maxEntryPrice,
              sizing,
              entryPricingTelemetry: {
                calculatedAtMs: sizing.calculatedAtMs, checkedAtMs,
                finalAsk: finalQuote.ask, finalQuoteAtMs: finalQuote.timestamp,
                maxSlippageBps: sizing.maxSlippageBps,
              },
            };
            if (Number(sizing.plannedTopUpVst) > 0) {
              next.approvedTopUpMargin = String(sizing.plannedTopUpVst);
            } else delete next.approvedTopUpMargin;
            if (request.impulseSplit) {
              next.impulseSplit = exactImpulseSplit(
                sizing.quantity, filters, sizing.quotePrice,
              );
              if (!next.impulseSplit) throw new Error("vst_fresh_impulse_split_unrepresentable");
            }
            if (typeof store.refreshPendingEntryIntent !== "function" ||
                !await store.refreshPendingEntryIntent({
                  clientOrderId, expectedRequest: request, request: next,
                })) {
              throw new Error("vst_fresh_entry_intent_persistence_failed");
            }
            // Reconciliation and finalizeEntry must use the persisted NEW
            // quantity, not the preliminary plan held by openSignal.
            Object.assign(request, next);
            if (!Object.hasOwn(next, "approvedTopUpMargin")) delete request.approvedTopUpMargin;
          },
          onEntryTransportReady: async (detail) => {
            await store.recordEvent?.(signalId, "vst_entry_queue_telemetry", {
              event: "entry_transport_ready", ...detail,
            });
          },
          onEntryTiming: async (detail) => {
            await store.recordEvent?.(signalId, "vst_entry_latency", {
              ...detail, clientOrderId,
            });
          },
        } : {}),
      });
      if (submission?.exchangeOrderId !== undefined) {
        await onSubmission(submission);
      }
    } catch (error) {
      if (!submittedExchangeOrderId) {
        submittedExchangeOrderId = normalizedSubmissionId(error?.exchangeOrderId) ??
          normalizedSubmissionId(stopTransferJournal?.getProgress().newStopOrderId) ?? undefined;
      }
      const retirementNoSend = request.operation === "retire_adopted_stop" &&
        exactOriginalStopCancelMutationProvenance(error?.mutationProvenance)
          ?.mutationRequestSent === false && !submittedExchangeOrderId;
      if (retirementNoSend) {
        await store.markIntent(clientOrderId, "failed", {
          outcome: {
            reason: "adopted_stop_retirement_not_sent",
            mutationProvenance: exactOriginalStopCancelMutationProvenance(error.mutationProvenance),
          },
        });
        return { kind: "observed", reason: "adopted_stop_retirement_not_sent", clientOrderId };
      }
      await store.markIntent(clientOrderId, "unknown", {
        ...(submittedExchangeOrderId ? {
          exchangeOrderId: submittedExchangeOrderId,
        } : {}),
        outcome: {
          error: error instanceof Error ? error.name : "UnknownError",
          // The reconciliation pass below overwrites this outcome as soon as
          // it runs; without carrying the message forward, the only trace of
          // why the exchange call was never confirmed as sent is this string.
          errorMessage: error instanceof Error
            ? `${error.message}${error.preSignReason ? ` (${error.preSignReason})` : ""}`
            : String(error),
          ...(error?.preSignReason ? { preSignReason: error.preSignReason } : {}),
          ...(request.operation === "raise_stop" &&
              safeStopAcknowledgement(error?.detail?.acknowledgement)
            ? { acknowledgement: safeStopAcknowledgement(error.detail.acknowledgement) }
            : {}),
          // Set only when the broker recognized a synchronous, definitive
          // exchange-side rejection (nothing was ever mutated) rather than a
          // genuinely ambiguous transport failure. reconcileOne uses this to
          // skip the long "maybe it's still settling" wait for entries that
          // can never resolve into a fill.
          ...(error?.definiteRejection === true ? { definiteRejection: true } : {}),
          ...(exactOriginalStopCancelMutationProvenance(
            error?.mutationProvenance,
          )
            ? {
                mutationProvenance:
                  exactOriginalStopCancelMutationProvenance(
                    error.mutationProvenance,
                  ),
              }
            : {}),
          ...(request.operation === "close_pre_runner_split" &&
              exactPreRunnerSplitCloseMutationProvenance(
                error?.mutationProvenance,
              )
            ? {
                mutationProvenance:
                  exactPreRunnerSplitCloseMutationProvenance(
                    error.mutationProvenance,
                  ),
              }
            : {}),
        },
      });
      return { kind: "unknown", clientOrderId };
    }
    return {
      kind: "submitted", clientOrderId,
      ...(submittedExchangeOrderId
        ? { exchangeOrderId: submittedExchangeOrderId } : {}),
    };
  }

  function createTransferJournal(intent) {
    return createStopTransferJournal({
      request: intent.request, progress: intent.outcome?.stopTransfer,
      persist: (expectedStage, progress, exchangeOrderId) => store.advanceStopTransfer({
        clientOrderId: intent.clientOrderId, request: intent.request,
        expectedStage, progress, exchangeOrderId,
      }),
    });
  }

  async function confirmedSymbolFlat(symbol) {
    let freshAccountState;
    try {
      freshAccountState = await broker.readAccountState();
    } catch {
      return false;
    }
    // Same bar the entry preflight itself requires before ever submitting: a
    // verified, completely flat SYMBOL (no position, no open order for this
    // symbol). Shared by every abandonment check below, entry included. A
    // different symbol's own position/orders are irrelevant here -- many
    // symbols now carry independent exposure concurrently by design, so only
    // this symbol's own rows may ever justify declaring it abandoned.
    if (!validObject(freshAccountState) || freshAccountState.verified !== true ||
        !Array.isArray(freshAccountState.positions) ||
        !Array.isArray(freshAccountState.openOrders)) {
      return false;
    }
    const key = normalizeSymbolKey(symbol);
    if (!key) return false;
    const hasSymbolPosition = freshAccountState.positions.some((row) =>
      normalizeSymbolKey(row?.symbol) === key);
    const hasSymbolOrder = freshAccountState.openOrders.some((row) =>
      normalizeSymbolKey(row?.symbol) === key);
    return !hasSymbolPosition && !hasSymbolOrder;
  }

  // The close-specific counterpart to confirmedSymbolFlat(): tries to prove
  // a close attempt did NOT execute by finding the position it targeted
  // still open, at EXACTLY the quantity it had before the close was
  // submitted. Matching on symbol + exact pre-close quantity is
  // deliberately strict -- a reduced (but nonzero) quantity would be
  // consistent with a partial fill and must not be waved through as "still
  // open, nothing happened". Every close request carries the pre-close
  // amount under one of these fields depending on operation: totalQuantity
  // for the two full-position closes, previousQuantity for close_leg,
  // quantity for close_survivor.
  //
  // An unchanged quantity snapshot is necessary but not sufficient: it is a
  // single moment-in-time read, not proof that nothing can still happen. A
  // still-resting order for this symbol -- most importantly the close order
  // itself, if the exchange has not yet finished resolving it -- could fill
  // moments later, and releasing the intent now would let normal position
  // management submit a SECOND close attempt, risking two orders in flight
  // and a later hidden fill from whichever one we stopped tracking. The
  // only resting order a genuinely untouched position is expected to carry
  // is its own protective stop (always type STOP_MARKET in this codebase;
  // close orders are always type MARKET). So any open order for this symbol
  // that is NOT a STOP_MARKET order means the close's fate is still
  // unproven, and this must not be treated as safe to retry.
  //
  // When the request identifies the exact exchange position it targeted
  // (positionId), the freshly observed position must be that SAME position,
  // not merely a coincidental same-symbol/same-quantity one. Not every
  // close request carries positionId (the plain, non-impulse close_leg path
  // does not), so this check is best-effort: applied when available, skipped
  // otherwise.
  //
  // Returns one of three outcomes, not a plain boolean, because "we could
  // not get a trustworthy read at all" (the API call threw, or came back
  // unverified/malformed) must be handled differently from "we got a
  // trustworthy read but it does not confirm the position is untouched":
  //   "confirmed_still_open" -- strong, specific evidence nothing was
  //     closed; safe to give up on this attempt alone without any risk of
  //     hiding a real fill.
  //   "ambiguous" -- the read succeeded but does not prove that (flat
  //     account, mismatched quantity/position, a suspicious resting order,
  //     or a malformed request field): genuinely inconclusive, since a flat
  //     read here is exactly what a real close would also look like with no
  //     verified fill/PnL to safely commit.
  //   "read_unavailable" -- the read itself could not be trusted. This is
  //     silence, not evidence -- most often a transient exchange/network
  //     hiccup. Treating silence the same as a confirmed-ambiguous read
  //     would let an ordinary outage permanently retire a position that may
  //     still be perfectly open and unmanaged, which is strictly worse than
  //     leaving the intent unresolved and retrying the read next tick.
  async function evaluateCloseAbandonEvidence(request) {
    let freshAccountState;
    try {
      freshAccountState = await broker.readAccountState();
    } catch {
      return { outcome: "read_unavailable" };
    }
    if (!validObject(freshAccountState) || freshAccountState.verified !== true ||
        !Array.isArray(freshAccountState.positions) ||
        !Array.isArray(freshAccountState.openOrders)) {
      return { outcome: "read_unavailable" };
    }
    const expectedQuantity = Number(
      request?.totalQuantity ?? request?.previousQuantity ?? request?.quantity,
    );
    if (!Number.isFinite(expectedQuantity) || expectedQuantity <= 0) {
      return { outcome: "ambiguous" };
    }
    const compactSymbol = String(request?.symbol ?? "")
      .replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (!compactSymbol) return { outcome: "ambiguous" };
    const matches = freshAccountState.positions.filter((row) =>
      typeof row?.symbol === "string" &&
      row.symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase() === compactSymbol);
    if (matches.length !== 1) return { outcome: "ambiguous" };
    const matchedPosition = matches[0];
    const expectedPositionId = request?.positionId;
    if (typeof expectedPositionId === "string" && expectedPositionId.trim() !== "") {
      const observedPositionIdValue = matchedPosition.positionId ?? matchedPosition.positionID;
      const observedPositionId = typeof observedPositionIdValue === "string"
        ? observedPositionIdValue
        : Number.isSafeInteger(observedPositionIdValue) ? String(observedPositionIdValue) : null;
      if (observedPositionId !== expectedPositionId) return { outcome: "ambiguous" };
    }
    const observedQuantity = Number(matchedPosition.positionAmt ?? matchedPosition.quantity);
    if (!Number.isFinite(observedQuantity) || observedQuantity !== expectedQuantity) {
      return { outcome: "ambiguous" };
    }
    const suspiciousOrder = freshAccountState.openOrders.some((row) =>
      typeof row?.symbol === "string" &&
      row.symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase() === compactSymbol &&
      row?.type !== "STOP_MARKET");
    if (suspiciousOrder) return { outcome: "ambiguous" };
    // matchedPosition is additive: existing callers only read `.outcome` and
    // are unaffected. Entry-abandon reuses it below to record the exchange's
    // own observed entry price on a confirmed-open position it can no longer
    // verify further, without re-deriving or fabricating that price.
    return { outcome: "confirmed_still_open", matchedPosition };
  }

  function exactExchangeIdentifier(value) {
    if (typeof value === "string" && value.trim() !== "") return value;
    return Number.isSafeInteger(value) ? String(value) : null;
  }

  function consistentExchangeIdentifier(row, ...keys) {
    const values = keys.map((key) => row?.[key])
      .filter((value) => value !== undefined && value !== null);
    if (values.length === 0) return null;
    const identifiers = values.map(exactExchangeIdentifier);
    return identifiers.some((value) => value === null) ||
        new Set(identifiers).size !== 1
      ? null : identifiers[0];
  }

  function consistentDecimalAliases(row, ...keys) {
    const values = keys.map((key) => row?.[key])
      .filter((value) => value !== undefined && value !== null);
    if (values.length === 0 || values.some((value) => !exactDecimalParts(value)) ||
        values.slice(1).some((value) => !exactDecimalEqual(value, values[0]))) {
      return null;
    }
    return values[0];
  }

  function explicitZeroExecutionProof(row, expectedOrderId) {
    if (!validObject(row) ||
        consistentExchangeIdentifier(row, "orderId", "orderID") !== expectedOrderId ||
        !Object.hasOwn(row, "executedQty")) {
      return null;
    }
    const proof = {
      orderId: expectedOrderId,
    };
    for (const key of EXECUTION_QUANTITY_ALIASES) {
      if (!Object.hasOwn(row, key)) continue;
      const value = row[key];
      if (value === undefined || value === null ||
          !exactDecimalEqual(value, "0")) {
        return null;
      }
      proof[key] = value;
    }
    return Object.hasOwn(proof, "executedQty") ? proof : null;
  }

  async function loadRaiseStopEntryProof(intent, expectedPositionId, baselineSnapshot) {
    if (typeof store.getIntent !== "function") return null;
    let entryIntent;
    try {
      entryIntent = await store.getIntent(intent.sourceSignalId, "market-entry");
    } catch {
      return null;
    }
    const request = intent.request;
    const entryRequest = entryIntent?.request;
    const outcome = entryIntent?.outcome;
    const exchangeOrderId = entryIntent?.exchangeOrderId;
    const snapshots = [
      request,
      request.entryProof,
      request.priorPosition,
      request.nextPosition,
      request.persistedPosition,
      request.persistedSnapshot,
      baselineSnapshot,
      request.priorPosition?.persistedPosition,
      request.priorPosition?.persistedSnapshot,
      request.nextPosition?.persistedPosition,
      request.nextPosition?.persistedSnapshot,
    ].filter(validObject);
    const clientIds = snapshots
      .filter((snapshot) => Object.hasOwn(snapshot, "entryClientOrderId"))
      .map((snapshot) => snapshot.entryClientOrderId);
    const orderIds = snapshots
      .filter((snapshot) => Object.hasOwn(snapshot, "entryOrderId") &&
        snapshot.entryOrderId !== undefined && snapshot.entryOrderId !== null)
      .map((snapshot) => snapshot.entryOrderId);
    const positionIds = snapshots
      .flatMap((snapshot) => [
        snapshot.exchangePositionId,
        snapshot.positionId,
      ].filter((value) => value !== undefined && value !== null)
        .map(exactExchangeIdentifier));
    const entryAtValues = snapshots
      .filter((snapshot) => Object.hasOwn(snapshot, "entryAt"))
      .map((snapshot) => snapshot.entryAt);
    const entryTypes = snapshots
      .map((snapshot) => snapshot.entryOrderType)
      .filter((value) => value !== undefined && value !== null);
    const entryClientOrderId = entryIntent?.clientOrderId;
    const entryOrderType = entryRequest?.entryOrderType ?? "LIMIT";
    const createdAt = entryRequest?.intentCreatedAt;
    const fillQuantity = outcome?.fillQuantity ?? outcome?.totalQuantity;
    const now = Number(clock());
    if (!Number.isSafeInteger(now) || now <= 0 ||
        entryIntent?.sourceSignalId !== intent.sourceSignalId ||
        entryIntent?.phase !== "market-entry" ||
        entryIntent?.state !== "reconciled" ||
        entryRequest?.operation !== "entry" ||
        entryRequest?.environment !== "vst" ||
        entryRequest?.accountId !== request.accountId ||
        entryRequest?.symbol !== request.symbol ||
        outcome?.verified !== true || outcome?.status !== "filled" ||
        typeof entryClientOrderId !== "string" || entryClientOrderId.trim() === "" ||
        typeof exchangeOrderId !== "string" || exchangeOrderId.trim() === "" ||
        typeof outcome.positionId !== "string" ||
        outcome.positionId !== expectedPositionId ||
        typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) ||
        createdAt <= 0 || createdAt > now ||
        now - createdAt > FILL_ARCHIVE_RETENTION_MS - 30_000 ||
        !["LIMIT", "MARKET"].includes(entryOrderType) ||
        entryRequest.entryOrderType !== undefined &&
          entryRequest.entryOrderType !== entryOrderType ||
        entryRequest.quantity === undefined ||
          !exactDecimalEqual(entryRequest.quantity, fillQuantity) ||
        !exactDecimalEqual(fillQuantity, entryRequest.quantity) ||
        entryIntent.clientOrderId !== entryClientOrderId ||
        clientIds.length === 0 ||
        clientIds.some((clientId) => clientId !== entryClientOrderId) ||
        orderIds.some((orderId) => orderId !== exchangeOrderId) ||
        positionIds.some((positionId) => positionId !== expectedPositionId) ||
        entryTypes.some((type) => type !== entryOrderType)) {
      return null;
    }
    for (const entryAt of entryAtValues) {
      const parsed = typeof entryAt === "number" ? entryAt
        : typeof entryAt === "string" &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
            .test(entryAt) ? Date.parse(entryAt) : NaN;
      if (!Number.isSafeInteger(parsed) || parsed <= 0 ||
          parsed > now || parsed < createdAt ||
          parsed - createdAt > 10 * 60_000 ||
          now - parsed > FILL_ARCHIVE_RETENTION_MS - 30_000) {
        return null;
      }
    }
    return {
      entryIntent: {
        sourceSignalId: entryIntent.sourceSignalId,
        phase: entryIntent.phase,
        clientOrderId: entryIntent.clientOrderId,
        state: entryIntent.state,
        request: entryIntent.request,
        exchangeOrderId: entryIntent.exchangeOrderId,
        outcome: entryIntent.outcome,
      },
      proof: {
        entryClientOrderId,
        entryOrderId: exchangeOrderId,
        positionId: outcome.positionId,
        entryOrderType,
        intentCreatedAt: createdAt,
        quantity: String(fillQuantity),
      },
    };
  }

  async function evaluateRaiseStopPreAdapterNoWriteRefusal(
    intent, recoveryKind = "entry-proof",
  ) {
    const request = intent?.request;
    const exactOutcome = recoveryKind === "equal-price-noop"
      ? exactRaiseStopEqualPriceRejectionOutcome(intent)
      : exactRaiseStopRefusalOutcome(intent);
    if (!exactOutcome) {
      return { outcome: "not_applicable" };
    }
    const readOnlyProofStartedAtMs = Number(clock());
    if (!Number.isSafeInteger(readOnlyProofStartedAtMs) ||
        readOnlyProofStartedAtMs <= 0) {
      return {
        outcome: "stale",
        deferredReason: "raise_stop_read_only_proof_budget_exceeded",
      };
    }
    if (typeof store.getPosition !== "function") {
      return {
        outcome: "read_unavailable",
        deferredReason: "raise_stop_position_read_unavailable",
      };
    }
    let positionRecord;
    try {
      positionRecord = await store.getPosition(intent.sourceSignalId);
    } catch {
      return {
        outcome: "read_unavailable",
        deferredReason: "raise_stop_position_read_unavailable",
      };
    }
    if (!validObject(positionRecord) || positionRecord.status !== "open" ||
        !validObject(positionRecord.snapshot) ||
        typeof positionRecord.updatedAt !== "string" ||
        positionRecord.snapshot.status !== "open" ||
        positionRecord.snapshot.sourceSignalId !== intent.sourceSignalId ||
        positionRecord.snapshot.environment !== "vst" ||
        positionRecord.snapshot.accountId !== request.accountId ||
        positionRecord.snapshot.symbol !== request.symbol ||
        positionRecord.snapshot.manualResolution != null ||
        positionRecord.snapshot.marginTopUp?.manualResolution != null) {
      return {
        outcome: "ambiguous",
        deferredReason: "raise_stop_persisted_position_changed",
      };
    }
    const baseline = positionRecord.snapshot;
    const baselinePositionId = consistentExchangeIdentifier(
      baseline, "exchangePositionId", "positionId",
    );
    const positionId = baselinePositionId;
    const baselineQuantity = baseline.remainingQty ?? baseline.quantity;
    if (!baselinePositionId || !exactDecimalParts(baselineQuantity) ||
        typeof broker.verifyEntryOrderProof !== "function") {
      return {
        outcome: "read_unavailable",
        deferredReason: "raise_stop_position_read_unavailable",
      };
    }
    const accountSymbolKey = (value) => {
      if (isCanonicalVstSymbol(value)) return value;
      const match = typeof value === "string"
        ? /^([A-Z0-9]{1,20})-USDT$/.exec(value) : null;
      return match ? `${match[1]}USDT` : null;
    };
    if (!isCanonicalVstSymbol(request.symbol)) {
      return {
        outcome: "ambiguous",
        deferredReason: "raise_stop_persisted_position_changed",
      };
    }
    const entry = await loadRaiseStopEntryProof(
      intent, baselinePositionId, baseline,
    );
    if (!entry) {
      return {
        outcome: "ambiguous",
        deferredReason: "raise_stop_entry_proof_not_linked_or_fresh",
      };
    }
    let entryEvidence;
    try {
      entryEvidence = await withVstDiagnosticContext({
        stage: "failedEntryRecovery", operation: "raise_stop",
        check: "entry_history", symbol: intent.request?.symbol,
        sourceSignalId: intent.sourceSignalId,
      }, () => broker.verifyEntryOrderProof({
        clientOrderId: entry.entryIntent.clientOrderId,
        request: entry.entryIntent.request,
        expectedPositionId: baselinePositionId,
        expectedOrderId: entry.entryIntent.exchangeOrderId,
        expectedQuantity: entry.proof.quantity,
      }));
    } catch (error) {
      const diagnostic = recordVstDiagnostic(error, {
        stage: "failedEntryRecovery", operation: "raise_stop",
        check: "entry_history", symbol: intent.request?.symbol,
        sourceSignalId: intent.sourceSignalId,
      });
      return {
        outcome: "read_unavailable",
        deferredReason: "raise_stop_entry_proof_read_unavailable",
        diagnosticRef: diagnostic.ref,
      };
    }
    if (!validObject(entryEvidence) || entryEvidence.verified !== true ||
        entryEvidence.status !== "filled" ||
        entryEvidence.exchangeOrderId !== entry.proof.entryOrderId ||
        entryEvidence.positionId !== baselinePositionId ||
        !exactDecimalEqual(entryEvidence.fill?.quantity, entry.proof.quantity)) {
      const inheritedRef = getVstResultDiagnosticRef(entryEvidence) ??
        (/^[a-f0-9]{12}$/.test(entryEvidence?.diagnosticRef ?? "")
          ? entryEvidence.diagnosticRef : undefined);
      const diagnostic = inheritedRef
        ? { ref: inheritedRef }
        : recordVstRefusal("entry_proof_unverified", {
            stage: "failedEntryRecovery", operation: "raise_stop",
            check: "entry_history", symbol: intent.request?.symbol,
            sourceSignalId: intent.sourceSignalId,
          });
      return {
        outcome: "ambiguous",
        deferredReason: "raise_stop_entry_proof_mismatch",
        diagnosticRef: diagnostic.ref,
      };
    }

    const corroboratingSnapshots = [
      baseline,
      request.entryProof,
      request.priorPosition,
      request.nextPosition,
      request.persistedPosition,
      request.persistedSnapshot,
      request.priorPosition?.persistedPosition,
      request.priorPosition?.persistedSnapshot,
      request.nextPosition?.persistedPosition,
      request.nextPosition?.persistedSnapshot,
    ].filter(validObject);
    const legacyNext = request.nextPosition;
    if (!validObject(legacyNext) ||
        legacyNext.entryClientOrderId !== entry.proof.entryClientOrderId ||
        consistentExchangeIdentifier(
          legacyNext, "exchangePositionId", "positionId",
        ) !== baselinePositionId ||
        !exactDecimalEqual(
          legacyNext.remainingQty ?? legacyNext.quantity, baselineQuantity,
        ) ||
        request.sourceSignalId !== undefined &&
          request.sourceSignalId !== intent.sourceSignalId ||
        request.positionId !== undefined &&
          exactExchangeIdentifier(request.positionId) !== baselinePositionId ||
        request.entryClientOrderId !== undefined &&
          request.entryClientOrderId !== entry.proof.entryClientOrderId ||
        request.entryOrderId !== undefined &&
          exactExchangeIdentifier(request.entryOrderId) !== entry.proof.entryOrderId ||
        !exactDecimalEqual(request.previousQuantity, baselineQuantity) ||
        !exactDecimalEqual(request.quantity, baselineQuantity)) {
      return {
        outcome: "ambiguous",
        deferredReason: "raise_stop_position_snapshot_mismatch",
      };
    }
    for (const snapshot of corroboratingSnapshots) {
      const snapshotPositionId = consistentExchangeIdentifier(
        snapshot, "exchangePositionId", "positionId",
      );
      const snapshotHasPositionId =
        snapshot.exchangePositionId !== undefined && snapshot.exchangePositionId !== null ||
        snapshot.positionId !== undefined && snapshot.positionId !== null;
      if (snapshot.sourceSignalId !== undefined &&
            snapshot.sourceSignalId !== intent.sourceSignalId ||
          snapshot.symbol !== undefined && snapshot.symbol !== request.symbol ||
          snapshotHasPositionId && snapshotPositionId !== baselinePositionId ||
          snapshot.entryClientOrderId !== undefined &&
            snapshot.entryClientOrderId !== entry.proof.entryClientOrderId ||
          snapshot.entryOrderId !== undefined &&
            exactExchangeIdentifier(snapshot.entryOrderId) !== entry.proof.entryOrderId ||
          snapshot.entryOrderType !== undefined &&
            snapshot.entryOrderType !== entry.proof.entryOrderType ||
          snapshot.environment !== undefined && snapshot.environment !== "vst" ||
          snapshot.accountId !== undefined && snapshot.accountId !== request.accountId ||
          snapshot.status !== undefined && snapshot.status !== "open" ||
          snapshot.remainingQty !== undefined &&
            !exactDecimalEqual(snapshot.remainingQty, baselineQuantity) ||
          (snapshot.remainingQty === undefined && snapshot.quantity !== undefined &&
            !exactDecimalEqual(snapshot.quantity, baselineQuantity)) ||
          snapshot.entryAt !== undefined && baseline.entryAt !== undefined &&
            !sameTimestamp(snapshot.entryAt, baseline.entryAt)) {
        return {
          outcome: "ambiguous",
          deferredReason: "raise_stop_position_snapshot_mismatch",
        };
      }
    }

    const baselineStops = [
      baseline.verifiedProtectiveStops?.core,
      baseline.protectiveStops?.core,
      baseline.split?.coreStop,
      baseline.coreStop,
    ].filter((stop) => validObject(stop) && stop.verified === true);
    const nextPositionStops = [
      legacyNext.verifiedProtectiveStops?.core,
      legacyNext.protectiveStops?.core,
      legacyNext.split?.coreStop,
      legacyNext.coreStop,
    ].filter(validObject);
    if (baselineStops.length === 0 || nextPositionStops.length === 0) {
      return {
        outcome: "ambiguous",
        deferredReason: "raise_stop_old_stop_snapshot_mismatch",
      };
    }
    const snapshots = [
      baseline,
      ...corroboratingSnapshots,
    ].filter(validObject);
    const stops = snapshots.flatMap((snapshot) => [
      snapshot.verifiedProtectiveStops?.core,
      snapshot.protectiveStops?.core,
      snapshot.split?.coreStop,
      snapshot.coreStop,
    ]).filter((stop) => validObject(stop) && stop.verified === true);
    const stopSignature = (stop) => ({
      orderId: consistentExchangeIdentifier(stop, "orderId", "orderID"),
      positionId: consistentExchangeIdentifier(stop, "positionId", "positionID"),
      quantity: consistentDecimalAliases(stop, "quantity", "origQty"),
      stopPrice: stop.stopPrice,
    });
    const firstStopSignature = stops.length ? stopSignature(stops[0]) : null;
    const nextStopSignatures = nextPositionStops.map(stopSignature);
    if (stops.length === 0 || stops.some((stop) => {
      const signature = stopSignature(stop);
      return signature.orderId !== firstStopSignature.orderId ||
        signature.positionId !== firstStopSignature.positionId ||
        !exactDecimalEqual(signature.quantity, firstStopSignature.quantity) ||
        !exactDecimalEqual(signature.stopPrice, firstStopSignature.stopPrice);
    }) || nextStopSignatures.some((signature) =>
      signature.orderId !== firstStopSignature.orderId ||
      signature.positionId !== firstStopSignature.positionId ||
      !exactDecimalEqual(signature.quantity, firstStopSignature.quantity) ||
      !exactDecimalEqual(signature.stopPrice, firstStopSignature.stopPrice))) {
      return {
        outcome: "ambiguous",
        deferredReason: "raise_stop_old_stop_snapshot_mismatch",
      };
    }
    const oldStop = stops[0];
    const oldStopOrderId = consistentExchangeIdentifier(
      oldStop, "orderId", "orderID",
    );
    const oldStopPositionId = consistentExchangeIdentifier(
      oldStop, "positionId", "positionID",
    );
    const durableOrderIds = [
      request.entryOrderId,
      ...snapshots.map((snapshot) => snapshot.entryOrderId),
    ].filter((value) => value !== undefined && value !== null)
      .map(exactExchangeIdentifier);
    const durablePositionIds = [
      request.positionId,
      ...snapshots.flatMap((snapshot) => [
        snapshot.exchangePositionId,
        snapshot.positionId,
      ]),
      entry.proof.positionId,
      oldStopPositionId,
    ].filter((value) => value !== undefined && value !== null)
      .map(exactExchangeIdentifier);
    const uniquePositionIds = [...new Set(durablePositionIds)];
    const quantity = request.previousQuantity;
    const targetQuantity = request.quantity;
    const accountStateReadStartedAtMs = Number(clock());
    if (!Number.isSafeInteger(accountStateReadStartedAtMs) ||
        accountStateReadStartedAtMs <= 0 ||
        accountStateReadStartedAtMs < readOnlyProofStartedAtMs) {
      return {
        outcome: "stale",
        deferredReason: "raise_stop_read_only_proof_budget_exceeded",
      };
    }
    let accountState;
    try {
      accountState = await broker.readAccountState();
    } catch {
      return {
        outcome: "read_unavailable",
        deferredReason: "raise_stop_account_state_unavailable",
      };
    }
    const accountStateReadCompletedAtMs = Number(clock());
    if (!Number.isSafeInteger(accountStateReadCompletedAtMs) ||
        accountStateReadCompletedAtMs < readOnlyProofStartedAtMs ||
        accountStateReadCompletedAtMs - readOnlyProofStartedAtMs >
          RAISE_STOP_REFUSAL_READ_ONLY_BUDGET_MS ||
        accountStateReadCompletedAtMs < accountStateReadStartedAtMs ||
        accountStateReadCompletedAtMs - accountStateReadStartedAtMs >
          READ_ONLY_RECOVERY_ACCOUNT_TO_LEDGER_MAX_AGE_MS) {
      return {
        outcome: "stale",
        deferredReason: "raise_stop_read_only_proof_budget_exceeded",
      };
    }
    if (!validObject(accountState) || accountState.verified !== true ||
        accountState.environment !== "vst" ||
        accountState.accountId !== request.accountId ||
        !Array.isArray(accountState.positions) ||
        !Array.isArray(accountState.openOrders) ||
        accountState.positions.some((row) => accountSymbolKey(row?.symbol) === null) ||
        accountState.openOrders.some((row) => accountSymbolKey(row?.symbol) === null)) {
      return {
        outcome: "read_unavailable",
        deferredReason: "raise_stop_account_state_unverified",
      };
    }
    const matchingPositions = accountState.positions.filter((row) =>
      accountSymbolKey(row.symbol) === request.symbol);
    if (matchingPositions.length !== 1) {
      return {
        outcome: "ambiguous",
        deferredReason: "raise_stop_account_position_mismatch",
      };
    }
    const position = matchingPositions[0];
    const accountPositionId = consistentExchangeIdentifier(
      position, "positionId", "positionID",
    );
    if (accountPositionId !== baselinePositionId) {
      return {
        outcome: "ambiguous",
        deferredReason: "raise_stop_account_position_mismatch",
      };
    }
    const observedQuantity = consistentDecimalAliases(
      position, "positionAmt", "quantity",
    );
    const targetStop = request.stopPrice;
    const oldStopPrice = oldStop.stopPrice;
    const oldStopQuantity = oldStop.quantity ?? oldStop.origQty;
    if (!oldStopOrderId || !oldStopPositionId ||
        durableOrderIds.some((id) => id !== entry.proof.entryOrderId) ||
        uniquePositionIds.length !== 1 ||
        uniquePositionIds[0] !== oldStopPositionId ||
        positionId !== oldStopPositionId ||
        accountPositionId !== oldStopPositionId ||
        position.positionSide !== "LONG" ||
        !exactDecimalParts(quantity) || !exactDecimalParts(targetQuantity) ||
        !exactDecimalParts(observedQuantity) || !exactDecimalParts(oldStopQuantity) ||
        !exactDecimalEqual(targetQuantity, quantity) ||
        !exactDecimalEqual(observedQuantity, quantity) ||
        !exactDecimalEqual(oldStopQuantity, quantity) ||
        compareExactDecimals(oldStopPrice, 0) !== 1 ||
        (recoveryKind === "equal-price-noop"
          ? compareExactDecimals(targetStop, oldStopPrice) !== 0
          : compareExactDecimals(targetStop, oldStopPrice) !== 1)) {
      return {
        outcome: "ambiguous",
        deferredReason: "raise_stop_old_stop_exchange_state_mismatch",
      };
    }
    const matchingOrders = accountState.openOrders.filter((row) =>
      accountSymbolKey(row.symbol) === request.symbol);
    if (matchingOrders.length !== 1) {
      return {
        outcome: "ambiguous",
        deferredReason: "raise_stop_old_stop_exchange_state_mismatch",
      };
    }
    const order = matchingOrders[0];
    const orderId = consistentExchangeIdentifier(order, "orderId", "orderID");
    const executionProof = explicitZeroExecutionProof(order, oldStopOrderId);
    const orderPositionId = consistentExchangeIdentifier(
      order, "positionId", "positionID",
    );
    const rawParentIds = [
      order.mainOrderId, order.mainOrderID,
      order.parentOrderId, order.parentOrderID,
    ].filter((value) =>
      value !== undefined && value !== null && value !== "");
    const parentIds = rawParentIds.map(exactExchangeIdentifier);
    if (orderId !== oldStopOrderId ||
        order.type !== "STOP_MARKET" || order.status !== "NEW" ||
        order.side !== "SELL" || order.positionSide !== "LONG" ||
        order.workingType !== "MARK_PRICE" ||
        orderPositionId !== oldStopPositionId ||
        !executionProof ||
        !exactDecimalEqual(
          consistentDecimalAliases(order, "origQty", "quantity"), quantity,
        ) ||
        !exactDecimalEqual(order.stopPrice, oldStopPrice) ||
        parentIds.some((parent) => parent === null) ||
        new Set(parentIds).size > 1 ||
        parentIds.some((parent) => parent !== entry.proof.entryOrderId)) {
      return {
        outcome: "ambiguous",
        deferredReason: "raise_stop_old_stop_exchange_state_mismatch",
      };
    }
    return {
      outcome: "confirmed_old_stop_unchanged",
      positionId: oldStopPositionId,
      quantity: String(quantity),
      stopOrderId: oldStopOrderId,
      stopPrice: String(oldStopPrice),
      entryIntent: entry.entryIntent,
      entryProof: entry.proof,
      executionProof,
      positionRecord,
      requestStartedAtMs: accountStateReadStartedAtMs,
    };
  }

  async function evaluateRaiseStopEntryProofRefusal(intent) {
    return evaluateRaiseStopPreAdapterNoWriteRefusal(intent, "entry-proof");
  }

  async function evaluateRaiseStopEqualPriceNoopRefusal(intent) {
    return evaluateRaiseStopPreAdapterNoWriteRefusal(intent, "equal-price-noop");
  }

  async function evaluateOriginalStopCancelPreReadRefusal(intent) {
    if (!exactOriginalStopCancelPreReadRefusal(intent)) {
      return { outcome: "not_applicable" };
    }
    const proofStartedAtMs = Number(clock());
    if (!Number.isSafeInteger(proofStartedAtMs) || proofStartedAtMs <= 0) {
      return {
        outcome: "stale",
        deferredReason: "original_stop_cancel_read_only_budget_exceeded",
      };
    }
    if (typeof store.getPosition !== "function" ||
        typeof broker.readAccountState !== "function" ||
        typeof broker.readPosition !== "function") {
      return {
        outcome: "read_unavailable",
        deferredReason: "original_stop_cancel_pre_read_proof_unavailable",
      };
    }
    let positionRecord;
    try {
      positionRecord = await store.getPosition(intent.sourceSignalId);
    } catch {
      return {
        outcome: "read_unavailable",
        deferredReason: "original_stop_cancel_pre_read_proof_unavailable",
      };
    }
    const baseline = positionRecord?.snapshot;
    const request = intent.request;
    const split = baseline?.split;
    const requestPrior = request?.priorPosition;
    const requestSplit = requestPrior?.split;
    const baselineHasPositionAlias =
      baseline?.exchangePositionId !== undefined &&
      baseline?.exchangePositionId !== null ||
      baseline?.positionId !== undefined && baseline?.positionId !== null;
    const requestHasPositionAlias =
      request?.positionId !== undefined && request?.positionId !== null;
    const positionId = exactExchangeIdentifier(split?.positionId);
    const snapshotPositionId = baselineHasPositionAlias
      ? consistentExchangeIdentifier(baseline, "exchangePositionId", "positionId")
      : positionId;
    const canonicalSymbol = baseline?.symbol;
    if (!validObject(positionRecord) ||
        !["closing", "open"].includes(positionRecord.status) ||
        !validObject(baseline) ||
        !["closing", "open"].includes(baseline.status) ||
        baseline.sourceSignalId !== intent.sourceSignalId ||
        baseline.environment !== "vst" ||
        baseline.accountId !== request.accountId ||
        baseline.symbol !== request.symbol ||
        baseline.manualResolution != null ||
        baseline.marginTopUp?.manualResolution != null ||
        !validObject(split) || split.stage !== "cancel_original_pending" ||
        !validObject(requestPrior) ||
        requestPrior.sourceSignalId !== intent.sourceSignalId ||
        requestPrior.environment !== "vst" ||
        requestPrior.accountId !== request.accountId ||
        requestPrior.symbol !== request.symbol ||
        !validObject(requestSplit) ||
        requestSplit.stage !== "cancel_original_pending" ||
        !positionId || snapshotPositionId !== positionId ||
        requestHasPositionAlias &&
          exactExchangeIdentifier(request.positionId) !== positionId ||
        !isCanonicalVstSymbol(canonicalSymbol) ||
        typeof positionRecord.updatedAt !== "string") {
      return {
        outcome: "ambiguous",
        deferredReason: "original_stop_cancel_position_changed",
      };
    }

    const original = split.originalStopOrderId;
    const core = split.coreStop;
    const runner = split.runnerStop;
    const requestCore = request.coreStop;
    const requestRunner = request.runnerStop;
    const originalId = exactExchangeIdentifier(original);
    const coreId = exactExchangeIdentifier(core?.orderId);
    const runnerId = exactExchangeIdentifier(runner?.orderId);
    const expectedIds = [originalId, coreId, runnerId];
    const baselineIds = split.baselineOpenOrderIds;
    const requestBaselineIds = request.baselineOpenOrderIds;
    const stopFactsMatch =
      expectedIds.every((id) => id !== null) &&
      new Set(expectedIds).size === 3 &&
      exactExchangeIdentifier(request.originalStopOrderId) === originalId &&
      exactExchangeIdentifier(requestCore?.orderId) === coreId &&
      exactExchangeIdentifier(requestRunner?.orderId) === runnerId &&
      exactExchangeIdentifier(requestSplit.originalStopOrderId) === originalId &&
      exactExchangeIdentifier(requestSplit.coreStop?.orderId) === coreId &&
      exactExchangeIdentifier(requestSplit.runnerStop?.orderId) === runnerId &&
      exactExchangeIdentifier(split.entryOrderId) ===
        exactExchangeIdentifier(request.entryOrderId) &&
      exactExchangeIdentifier(split.entryOrderId) !== null &&
      exactDecimalEqual(split.totalQuantity, request.totalQuantity) &&
      exactDecimalEqual(baseline.remainingQty ?? baseline.quantity,
        split.totalQuantity) &&
      exactDecimalEqual(request.totalQuantity, split.totalQuantity) &&
      exactDecimalEqual(core?.quantity, split.coreQuantity) &&
      exactDecimalEqual(request.coreQuantity, split.coreQuantity) &&
      exactDecimalEqual(runner?.quantity, split.runnerQuantity) &&
      exactDecimalEqual(request.runnerQuantity, split.runnerQuantity) &&
      exactDecimalEqual(core?.stopPrice, split.signalStopPrice) &&
      exactDecimalEqual(request.signalStopPrice, split.signalStopPrice) &&
      exactDecimalEqual(runner?.stopPrice, requestRunner?.stopPrice) &&
      Array.isArray(baselineIds) && baselineIds.length === 3 &&
      new Set(baselineIds.map(exactExchangeIdentifier)).size === 3 &&
      JSON.stringify(baselineIds.map(exactExchangeIdentifier).sort()) ===
        JSON.stringify(expectedIds.slice().sort()) &&
      Array.isArray(requestBaselineIds) && requestBaselineIds.length === 3 &&
      JSON.stringify(requestBaselineIds.map(exactExchangeIdentifier).sort()) ===
        JSON.stringify(expectedIds.slice().sort());
    if (!stopFactsMatch) {
      return {
        outcome: "ambiguous",
        deferredReason: "original_stop_cancel_stops_changed",
      };
    }

    const symbolKey = normalizeSymbolKey(canonicalSymbol);
    const accountSymbolKey = (value) => {
      if (isCanonicalVstSymbol(value)) return value;
      const match = typeof value === "string"
        ? /^([A-Z0-9]{1,20})-USDT$/.exec(value) : null;
      return match ? `${match[1]}USDT` : null;
    };
    let firstAccountState;
    let freshPosition;
    let finalAccountState;
    let pairedAccountReadStartedAtMs;
    let finalAccountReadStartedAtMs;
    try {
      pairedAccountReadStartedAtMs = Number(clock());
      if (!Number.isSafeInteger(pairedAccountReadStartedAtMs) ||
          pairedAccountReadStartedAtMs <= 0 ||
          pairedAccountReadStartedAtMs < proofStartedAtMs) {
        return {
          outcome: "stale",
          deferredReason: "original_stop_cancel_read_only_budget_exceeded",
        };
      }
      firstAccountState = await broker.readAccountState();
      if (!validObject(firstAccountState) || firstAccountState.verified !== true ||
          firstAccountState.environment !== "vst" ||
          firstAccountState.accountId !== request.accountId ||
          !Array.isArray(firstAccountState.positions) ||
          !Array.isArray(firstAccountState.openOrders)) {
        return {
          outcome: "read_unavailable",
          deferredReason: "original_stop_cancel_pre_read_proof_unavailable",
        };
      }
      // This branch only proves that the full position is unchanged. If the
      // independent runner-fill proof did not succeed and the account already
      // shows a residual, do not spend the fresh-pair budget on an impossible
      // full-position proof and then misreport the cause as a timing failure.
      const initialPositions = firstAccountState.positions.filter((row) =>
        normalizeSymbolKey(row?.symbol) === symbolKey);
      const initialPosition = initialPositions[0];
      const initialQuantity = consistentDecimalAliases(
        initialPosition, "positionAmt", "quantity",
      );
      if (initialPositions.length !== 1 ||
          initialPosition?.positionSide !== "LONG" ||
          consistentExchangeIdentifier(initialPosition, "positionId", "positionID") !==
            positionId ||
          !exactDecimalEqual(initialQuantity, split.totalQuantity)) {
        const diagnostic = recordVstRefusal("position_proof_unverified", {
          stage: "reconciliation", operation: "cancel_original_stop",
          symbol: canonicalSymbol, sourceSignalId: intent.sourceSignalId,
          check: "original_stop_cancel_unchanged_position",
          proofEvidence: safeVstProofEvidence("broker_position_rows", () => ({
            position_quantity: {
              expected: split.totalQuantity, actual: initialQuantity,
              matches: exactDecimalEqual(initialQuantity, split.totalQuantity),
            },
          })),
        });
        return {
          outcome: "ambiguous",
          deferredReason: "original_stop_cancel_position_changed",
          diagnosticRef: diagnostic?.ref,
        };
      }
      const persistedPosition = persistedSplitPosition(baseline, firstAccountState);
      freshPosition = await broker.readPosition(canonicalSymbol, {
        persistedPosition,
        allowProcessCache: false,
      });
      // The last signed exchange observation is deliberately after the
      // independent position read. Anchor the paired proof to the start of
      // the first account read so a slow first response cannot be hidden by
      // recording only the final response's completion time.
      finalAccountReadStartedAtMs = Number(clock());
      if (!Number.isSafeInteger(finalAccountReadStartedAtMs) ||
          finalAccountReadStartedAtMs < pairedAccountReadStartedAtMs) {
        return {
          outcome: "stale",
          deferredReason: "original_stop_cancel_read_only_budget_exceeded",
        };
      }
      finalAccountState = await broker.readAccountState();
    } catch {
      return {
        outcome: "read_unavailable",
        deferredReason: "original_stop_cancel_pre_read_proof_unavailable",
      };
    }
    const finalReadCompletedAtMs = Number(clock());
    if (!Number.isSafeInteger(finalReadCompletedAtMs) ||
        finalReadCompletedAtMs < proofStartedAtMs ||
        finalReadCompletedAtMs - proofStartedAtMs >
          RAISE_STOP_REFUSAL_READ_ONLY_BUDGET_MS ||
        finalReadCompletedAtMs < finalAccountReadStartedAtMs ||
        finalReadCompletedAtMs - pairedAccountReadStartedAtMs >
          READ_ONLY_RECOVERY_ACCOUNT_TO_LEDGER_MAX_AGE_MS) {
      return {
        outcome: "stale",
        deferredReason: "original_stop_cancel_read_only_budget_exceeded",
      };
    }
    if (!validObject(finalAccountState) ||
        finalAccountState.verified !== true ||
        finalAccountState.environment !== "vst" ||
        finalAccountState.accountId !== request.accountId ||
        !Array.isArray(finalAccountState.positions) ||
        !Array.isArray(finalAccountState.openOrders) ||
        finalAccountState.positions.some((row) =>
          accountSymbolKey(row?.symbol) === null) ||
        finalAccountState.openOrders.some((row) =>
          accountSymbolKey(row?.symbol) === null)) {
      return {
        outcome: "read_unavailable",
        deferredReason: "original_stop_cancel_pre_read_proof_unavailable",
      };
    }
    const accountPositions = finalAccountState.positions.filter((row) =>
      normalizeSymbolKey(row?.symbol) === symbolKey);
    const orders = finalAccountState.openOrders.filter((row) =>
      accountSymbolKey(row?.symbol) === canonicalSymbol);
    const accountPosition = accountPositions[0];
    const accountPositionId = consistentExchangeIdentifier(
      accountPosition, "positionId", "positionID",
    );
    const accountQuantity = consistentDecimalAliases(
      accountPosition, "positionAmt", "quantity",
    );
    const observedPositionId = exactExchangeIdentifier(freshPosition?.positionId);
    const observedQuantity = freshPosition?.quantity;
    const exactPosition =
      accountPositions.length === 1 &&
      accountPosition?.positionSide === "LONG" &&
      accountPositionId === positionId &&
      exactDecimalEqual(accountQuantity, split.totalQuantity) &&
      validObject(freshPosition) && freshPosition.verified === true &&
      freshPosition.symbol === canonicalSymbol &&
      observedPositionId === positionId &&
      exactDecimalEqual(observedQuantity, split.totalQuantity) &&
      freshPosition.side === "Buy" &&
      Number(freshPosition.leverage) === PROFILE_LEVERAGE &&
      profileMarginIs(freshPosition.marginMode);
    if (!exactPosition) {
      return {
        outcome: "ambiguous",
        deferredReason: "original_stop_cancel_position_changed",
      };
    }
    if (orders.length !== 3) {
      return {
        outcome: "ambiguous",
        deferredReason: "original_stop_cancel_stops_changed",
      };
    }
    const exactOrder = (expectedId, quantity, stopPrice) => {
      const matches = orders.filter((row) =>
        consistentExchangeIdentifier(row, "orderId", "orderID") === expectedId);
      if (matches.length !== 1) return null;
      const row = matches[0];
      const parentValues = [
        row.mainOrderId, row.mainOrderID,
        row.parentOrderId, row.parentOrderID,
      ].filter((value) =>
        value !== undefined && value !== null && value !== "");
      const parents = parentValues.map(exactExchangeIdentifier);
      const splitEntryId = exactExchangeIdentifier(split.entryOrderId);
      const executionProof = explicitZeroExecutionProof(row, expectedId);
      const exactStop =
        row.type === "STOP_MARKET" && row.status === "NEW" &&
        row.side === "SELL" && row.positionSide === "LONG" &&
        row.workingType === "MARK_PRICE" &&
        consistentExchangeIdentifier(row, "positionId", "positionID") === positionId &&
        executionProof !== null &&
        exactDecimalEqual(consistentDecimalAliases(row, "origQty", "quantity"),
          quantity) &&
        exactDecimalEqual(row.stopPrice, stopPrice) &&
        parents.every((parent) => parent !== null && parent === splitEntryId);
      return exactStop ? executionProof : null;
    };
    const stopExecutionProofs = [
      exactOrder(originalId, split.totalQuantity, split.signalStopPrice),
      exactOrder(coreId, split.coreQuantity, split.signalStopPrice),
      exactOrder(runnerId, split.runnerQuantity, runner.stopPrice),
    ];
    if (stopExecutionProofs.some((proof) => proof === null)) {
      return {
        outcome: "ambiguous",
        deferredReason: "original_stop_cancel_stops_changed",
      };
    }
    const retryPhase = "impulse-cancel_original_stop-retry-1";
    const recoveryPosition = {
      ...baseline,
      split: {
        ...split,
        cancelOriginalRecoveryPhase: retryPhase,
      },
    };
    return {
      outcome: "confirmed_original_stop_cancel_pre_read_refusal",
      positionRecord,
      recoveryPosition,
      retryPhase,
      accountState: finalAccountState,
      requestStartedAtMs: pairedAccountReadStartedAtMs,
      positionId,
      stopOrderIds: expectedIds,
      stopExecutionProofs,
    };
  }

  async function evaluateOriginalStopCancelRunnerFill(intent, {
    sentCancelConfirmed = false,
  } = {}) {
    const evidenceReader = sentCancelConfirmed
      ? broker.readSentOriginalStopCancellationRunnerFillEvidence
      : broker.readOriginalStopRefusalRunnerFillEvidence;
    if (typeof evidenceReader !== "function") {
      return { outcome: "unavailable" };
    }
    if (typeof store.getPosition !== "function") {
      return { outcome: "unavailable" };
    }
    let positionRecord;
    try {
      positionRecord = await store.getPosition(intent.sourceSignalId);
    } catch {
      return { outcome: "unavailable" };
    }
    const baseline = positionRecord?.snapshot;
    const request = intent.request;
    const split = baseline?.split;
    if (!validObject(positionRecord) ||
        !["open", "closing"].includes(positionRecord.status) ||
        !validObject(baseline) ||
        !["open", "closing"].includes(baseline.status) ||
        baseline.sourceSignalId !== intent.sourceSignalId ||
        baseline.environment !== "vst" ||
        baseline.accountId !== request.accountId ||
        baseline.symbol !== request.symbol ||
        baseline.manualResolution != null ||
        baseline.marginTopUp?.manualResolution != null ||
        !validObject(split) || split.stage !== "cancel_original_pending" ||
        !validObject(request.priorPosition) ||
        request.priorPosition.sourceSignalId !== intent.sourceSignalId ||
        request.priorPosition.split?.stage !== "cancel_original_pending" ||
        !isCanonicalVstSymbol(baseline.symbol)) {
      return { outcome: "unavailable" };
    }
    let proof;
    try {
      proof = await evidenceReader.call(broker, {
        clientOrderId: intent.clientOrderId,
        request,
        persistedPosition: baseline,
      });
    } catch (error) {
      recordVstDiagnostic(error, {
        stage: "reconciliation", operation: "cancel_original_stop",
        symbol: request.symbol, sourceSignalId: intent.sourceSignalId,
        check: "runner_fill_recovery_read",
      });
      return { outcome: "unavailable" };
    }
    if (proof?.verified !== true ||
        proof.outcome !== (sentCancelConfirmed
          ? "confirmed_sent_original_stop_cancel_runner_fill"
          : "confirmed_original_stop_cancel_runner_fill") ||
        proof.runnerFillRecovery !== true ||
        sentCancelConfirmed && proof.originalCancellationConfirmed !== true) {
      return { outcome: "unavailable" };
    }
    const positionId = exactExchangeIdentifier(split.positionId);
    const originalId = exactExchangeIdentifier(split.originalStopOrderId);
    const coreId = exactExchangeIdentifier(split.coreStop?.orderId);
    const runnerId = exactExchangeIdentifier(split.runnerStop?.orderId);
    const totalQuantity = split.totalQuantity;
    const coreQuantity = split.coreQuantity;
    const runnerQuantity = split.runnerQuantity;
    const signalStopPrice = split.signalStopPrice;
    const runnerStopPrice = split.actualEntryBreakEvenPrice ??
      split.breakEvenPrice ?? split.runnerStop?.stopPrice;
    const fill = proof.fill;
    const originalStop = proof.originalStop;
    const coreStop = proof.coreStop;
    const runnerStop = proof.runnerStop;
    const sameStopFacts = (stop, expectedId, quantity, stopPrice, status) =>
      validObject(stop) &&
      consistentExchangeIdentifier(stop, "orderId", "orderID") === expectedId &&
      consistentExchangeIdentifier(stop, "positionId", "positionID") === positionId &&
      normalizeSymbolKey(stop.symbol) === normalizeSymbolKey(baseline.symbol) &&
      String(stop.status ?? "").toUpperCase() === status &&
      exactDecimalEqual(consistentDecimalAliases(stop, "origQty", "quantity"),
        quantity) &&
      exactDecimalEqual(stop.stopPrice, stopPrice);
    const zeroProof = (stop, expectedId) =>
      explicitZeroExecutionProof(stop, expectedId) !== null;
    const fillAt = Date.parse(fill?.at ?? "");
    const now = Number(clock());
    const coreParts = exactDecimalParts(coreQuantity);
    const runnerParts = exactDecimalParts(runnerQuantity);
    const totalParts = exactDecimalParts(totalQuantity);
    const sumScale = coreParts && runnerParts && totalParts
      ? Math.max(coreParts.scale, runnerParts.scale, totalParts.scale) : null;
    const quantitiesSumToTotal = sumScale !== null &&
      coreParts.units * (10n ** BigInt(sumScale - coreParts.scale)) +
        runnerParts.units * (10n ** BigInt(sumScale - runnerParts.scale)) ===
      totalParts.units * (10n ** BigInt(sumScale - totalParts.scale));
    const coreIsEightyPercent = sumScale !== null &&
      coreParts.units * (10n ** BigInt(sumScale - coreParts.scale)) * 5n ===
        totalParts.units * (10n ** BigInt(sumScale - totalParts.scale)) * 4n;
    const runnerIsTwentyPercent = sumScale !== null &&
      runnerParts.units * (10n ** BigInt(sumScale - runnerParts.scale)) * 5n ===
        totalParts.units * (10n ** BigInt(sumScale - totalParts.scale));
    const aliasesMatchFill = validObject(runnerStop) &&
      EXECUTION_QUANTITY_ALIASES.filter((key) =>
        Object.hasOwn(runnerStop, key)).every((key) =>
        exactDecimalEqual(runnerStop[key], runnerQuantity)) &&
      (!Object.hasOwn(runnerStop, "executedQty") ||
        exactDecimalEqual(runnerStop.executedQty, runnerQuantity));
    const runnerChildId = consistentExchangeIdentifier(
      runnerStop, "childOrderId", "childOrderID",
    );
    const fillFee = fill?.fee;
    const originalQuantity = sentCancelConfirmed
      ? consistentDecimalAliases(originalStop, "origQty", "quantity")
      : coreQuantity;
    const originalQuantityIsAllowed = sentCancelConfirmed
      ? (proof.originalStopQuantityBasis === undefined
          ? exactDecimalEqual(originalQuantity, totalQuantity) ||
            exactDecimalEqual(originalQuantity, coreQuantity)
          : proof.originalStopQuantityBasis === "entry_total"
            ? exactDecimalEqual(originalQuantity, totalQuantity)
            : proof.originalStopQuantityBasis === "post_runner_residual" &&
              exactDecimalEqual(originalQuantity, coreQuantity))
      : exactDecimalEqual(originalQuantity, coreQuantity);
    const originalStatus = sentCancelConfirmed ? "CANCELED" : "NEW";
    const sentActiveStops = proof.openStops ?? proof.activeStops;
    const sentCoreOnly = !sentCancelConfirmed ||
      proof.originalCancellationConfirmed === true &&
      (sentActiveStops === undefined ||
        Array.isArray(sentActiveStops) && sentActiveStops.length === 1 &&
          sameStopFacts(sentActiveStops[0],
            coreId, coreQuantity, signalStopPrice, "NEW") &&
          zeroProof(sentActiveStops[0], coreId));
    const proofIsExact =
      Number.isSafeInteger(proof.requestStartedAtMs) &&
      proof.requestStartedAtMs > 0 &&
      Number.isSafeInteger(now) && now >= proof.requestStartedAtMs &&
      now - proof.requestStartedAtMs <=
        READ_ONLY_RECOVERY_ACCOUNT_TO_LEDGER_MAX_AGE_MS &&
      positionId !== null && originalId !== null && coreId !== null &&
      runnerId !== null && new Set([originalId, coreId, runnerId]).size === 3 &&
      exactDecimalParts(totalQuantity) &&
      exactDecimalParts(coreQuantity) && exactDecimalParts(runnerQuantity) &&
      quantitiesSumToTotal &&
      coreIsEightyPercent && runnerIsTwentyPercent &&
      exactDecimalParts(signalStopPrice) &&
      exactDecimalParts(runnerStopPrice) &&
      proof.position?.verified === true &&
      proof.position.symbol === baseline.symbol &&
      exactExchangeIdentifier(proof.position.positionId) === positionId &&
      exactDecimalEqual(proof.position.quantity, coreQuantity) &&
      proof.position.side === "Buy" &&
      Number(proof.position.leverage) === PROFILE_LEVERAGE &&
      profileMarginIs(proof.position.marginMode) &&
       originalStop?.verified === true &&
       coreStop?.verified === true &&
       runnerStop?.verified === true &&
        originalQuantityIsAllowed &&
       sameStopFacts(originalStop, originalId, originalQuantity,
         signalStopPrice, originalStatus) &&
      zeroProof(originalStop, originalId) &&
      sameStopFacts(coreStop, coreId, coreQuantity, signalStopPrice, "NEW") &&
      zeroProof(coreStop, coreId) &&
       sentCoreOnly &&
      sameStopFacts(runnerStop, runnerId, runnerQuantity, runnerStopPrice, "FILLED") &&
      exactDecimalEqual(runnerStop.executedQty, runnerQuantity) &&
      aliasesMatchFill &&
      typeof fill?.orderId === "string" && fill.orderId.trim() !== "" &&
      fill.orderId === runnerChildId &&
      fill.triggerOrderId === runnerId &&
      exactDecimalEqual(fill.quantity, runnerQuantity) &&
      exactDecimalParts(fill.price) && compareExactDecimals(fill.price, 0) === 1 &&
      Number.isSafeInteger(fillAt) && fillAt > 0 && fillAt <= now &&
      validObject(fillFee) && typeof fillFee.asset === "string" &&
      fillFee.asset.trim() !== "" &&
      (typeof fillFee.amount === "string" || typeof fillFee.amount === "number") &&
      String(fillFee.amount).trim() !== "" && Number.isFinite(Number(fillFee.amount));
    if (!proofIsExact) {
      return {
        outcome: "invalid",
        deferredReason: "original_stop_cancel_runner_fill_proof_mismatch",
      };
    }
    const expectedEntryOrderId = exactExchangeIdentifier(split.entryOrderId);
    for (const stop of [originalStop, coreStop]) {
      const parents = [
        stop.mainOrderId, stop.mainOrderID,
        stop.parentOrderId, stop.parentOrderID,
      ].filter((value) => value !== undefined && value !== null && value !== "");
      if (parents.some((parent) =>
        exactExchangeIdentifier(parent) !== expectedEntryOrderId)) {
        return {
          outcome: "invalid",
          deferredReason: "original_stop_cancel_runner_fill_proof_mismatch",
        };
      }
    }
    return {
      outcome: sentCancelConfirmed
        ? "confirmed_sent_original_stop_cancel_runner_fill"
        : "confirmed_original_stop_cancel_runner_fill",
      sentCancelConfirmed,
      positionRecord,
      proof,
      positionId,
      originalId,
      coreId,
      runnerId,
      totalQuantity: String(totalQuantity),
      coreQuantity: String(coreQuantity),
      runnerQuantity: String(runnerQuantity),
      signalStopPrice: String(signalStopPrice),
      runnerStopPrice: String(runnerStopPrice),
      fill,
    };
  }

  async function evaluateRaiseStopCommittedClose(intent) {
    if (typeof store.getPosition !== "function" ||
        typeof store.getIntent !== "function") {
      return { outcome: "unavailable" };
    }
    let positionRecord;
    try {
      positionRecord = await store.getPosition(intent.sourceSignalId);
    } catch {
      return { outcome: "unavailable" };
    }
    const snapshot = positionRecord?.snapshot;
    const prior = intent.request?.priorPosition;
    const priorStops = [
      prior?.verifiedProtectiveStops?.core,
      prior?.protectiveStops?.core,
      prior?.split?.coreStop,
      prior?.coreStop,
      intent.request?.oldStop,
    ].filter(validObject);
    const stopIds = priorStops.map((stop) =>
      consistentExchangeIdentifier(stop, "orderId", "orderID"));
    const stopId = stopIds[0];
    const quantity = intent.request.previousQuantity ?? intent.request.quantity;
    const stopPrice = priorStops[0]?.stopPrice;
    if (!validObject(positionRecord) || positionRecord.status !== "closed" ||
        !validObject(snapshot) || snapshot.status !== "closed" ||
        snapshot.sourceSignalId !== intent.sourceSignalId ||
        snapshot.environment !== "vst" ||
        snapshot.accountId !== intent.request.accountId ||
        snapshot.symbol !== intent.request.symbol ||
        snapshot.manualResolution != null ||
        !validObject(prior) || prior.status !== "open" ||
        prior.sourceSignalId !== intent.sourceSignalId ||
        prior.environment !== "vst" ||
        prior.accountId !== intent.request.accountId ||
        prior.symbol !== intent.request.symbol ||
        priorStops.length === 0 || !stopId ||
        stopIds.some((id) => id !== stopId) ||
        priorStops.some((stop) =>
          stop.verified !== true ||
          !exactDecimalEqual(stop.quantity ?? stop.origQty, quantity) ||
          !exactDecimalEqual(stop.stopPrice, stopPrice)) ||
        !Number.isSafeInteger(Date.parse(positionRecord.updatedAt))) {
      return { outcome: "unavailable" };
    }
    const positionId = consistentExchangeIdentifier(
      snapshot, "exchangePositionId", "positionId",
    );
    const priorPositionId = consistentExchangeIdentifier(
      prior, "exchangePositionId", "positionId",
    );
    const stopPositionIds = priorStops.map((stop) =>
      consistentExchangeIdentifier(stop, "positionId", "positionID"));
    const closePhase = `triggered-stop-${createHash("sha256")
      .update(stopId).digest("hex").slice(0, 24)}`;
    let closeIntent;
    try {
      closeIntent = await store.getIntent(intent.sourceSignalId, closePhase);
    } catch {
      return { outcome: "unavailable" };
    }
    const closeRequest = closeIntent?.request;
    const closeOutcome = closeIntent?.outcome;
    const fill = closeOutcome?.fill;
    const lastFill = snapshot.lastCloseFill;
    const fillAt = Date.parse(fill?.at ?? "");
    const feeMatches = validObject(fill?.fee) &&
      fill?.feeEvidenceAvailable === true &&
      typeof fill.fee.asset === "string" && fill.fee.asset.trim() !== "" &&
      (typeof fill.fee.amount === "string" ||
        typeof fill.fee.amount === "number") &&
      Number.isFinite(Number(fill.fee.amount)) &&
      lastFill?.feeEvidenceAvailable === true &&
      lastFill?.fee?.asset === fill.fee.asset &&
      exactDecimalEqual(lastFill?.fee?.amount, fill.fee.amount);
    const exactCommittedClose =
      closeIntent?.state === "reconciled" &&
      closeIntent.exchangeOrderId === fill?.orderId &&
      closeRequest?.operation === "observe_triggered_stop" &&
      closeRequest?.environment === "vst" &&
      closeRequest?.accountId === snapshot.accountId &&
      closeRequest?.symbol === snapshot.symbol &&
      exactExchangeIdentifier(closeRequest.positionId) === positionId &&
      exactExchangeIdentifier(closeRequest.stopOrderId) === stopId &&
      exactDecimalEqual(closeRequest.stopQuantity, quantity) &&
      exactDecimalEqual(closeRequest.stopPrice, stopPrice) &&
      closeOutcome?.verified === true &&
      closeOutcome.status === "filled" &&
      closeOutcome.operation === "observe_triggered_stop" &&
      exactExchangeIdentifier(closeOutcome.parentStopId) === stopId &&
      exactDecimalEqual(closeOutcome.parentStopPrice, stopPrice) &&
      closeOutcome.childOrderId === fill?.orderId &&
      fill?.triggerOrderId === stopId &&
      typeof fill?.orderId === "string" && fill.orderId.trim() !== "" &&
      exactDecimalEqual(fill.quantity, quantity) &&
      exactDecimalParts(fill.price) && compareExactDecimals(fill.price, 0) === 1 &&
      Number.isSafeInteger(fillAt) && fillAt > 0 &&
      closeOutcome.residualPosition?.verified === true &&
      exactExchangeIdentifier(closeOutcome.residualPosition.positionId) === positionId &&
      exactDecimalEqual(closeOutcome.residualPosition.quantity, 0) &&
      Array.isArray(closeOutcome.openStops) && closeOutcome.openStops.length === 0 &&
      exactDecimalEqual(snapshot.remainingQty, 0) &&
      exactDecimalEqual(lastFill?.quantity, quantity) &&
      exactDecimalEqual(lastFill?.price, fill.price) &&
      lastFill?.at === fill.at &&
      lastFill?.orderId === fill.orderId &&
      lastFill?.triggerOrderId === stopId &&
      snapshot.triggeredStop?.parentStopId === stopId &&
      exactDecimalEqual(snapshot.triggeredStop?.parentStopPrice, stopPrice) &&
      snapshot.triggeredStop?.childOrderId === fill.orderId &&
      feeMatches;
    if (!exactCommittedClose ||
        positionId !== priorPositionId ||
        stopPositionIds.some((id) => id !== positionId) ||
        !exactDecimalEqual(intent.request.previousQuantity, quantity) ||
        !exactDecimalEqual(intent.request.quantity, quantity) ||
        intent.request.accountId !== snapshot.accountId ||
        intent.request.symbol !== snapshot.symbol) {
      return { outcome: "unavailable" };
    }
    return {
      outcome: "confirmed_already_committed_close",
      positionRecord,
      closeIntent,
      stopId,
      closePhase,
      positionId,
      quantity: String(quantity),
      stopPrice: String(stopPrice),
    };
  }

  async function failPositionMarginTopUp(intent, reason) {
    // markIntent alone would leave the position record's own
    // marginTopUp.status stuck anything but "verified" forever, which
    // independently blocks runOnce via the unresolvedMarginTopUp gate below
    // regardless of intent state -- "unknown" would not clear it either,
    // since that status is already heavily used elsewhere in this file to
    // mean "ambiguous, position may still be genuinely open, keep watching",
    // which must keep blocking. This helper is only reached after
    // confirmedFlatAccount() has already proven no position exists on the
    // exchange at all, a strictly stronger and more specific fact, so it is
    // safe (and necessary, to actually clear the gate) to move the position
    // to the dedicated terminal "error" status instead: listOpenPositions()
    // excludes "error" entirely, so this record stops being reconciled,
    // gated on, or management-looped, without ever claiming a fabricated
    // close (no fill/PnL is recorded -- it simply stops being tracked as
    // open).
    const records = await store.listOpenPositions();
    const record = records.find((row) => row.sourceSignalId === intent.sourceSignalId);
    if (record) {
      await store.upsertPosition({
        ...record.snapshot,
        status: "error",
        marginTopUp: {
          ...record.snapshot.marginTopUp,
          status: "failed",
          failureReason: reason,
        },
      });
    }
  }

  function exactPreRunnerSplitCloseNoWriteIntent(intent) {
    const provenance = exactPreRunnerSplitCloseNoWriteProvenance(
      intent?.outcome?.mutationProvenance,
    );
    return Boolean(provenance &&
      intent?.state === "unknown" &&
      intent?.request?.operation === "close_pre_runner_split" &&
      intent.request.environment === "vst" &&
      !intent.request.sourceExit &&
      typeof intent.sourceSignalId === "string" &&
      /^impulse-runner-breakeven-abort-\d+$/.test(intent.phase ?? "") &&
      intent.clientOrderId === orderId(intent.sourceSignalId, intent.phase) &&
      intent.request.sourceSignalId === intent.sourceSignalId &&
      intent.request.closeIntentId === intent.clientOrderId &&
      validObject(intent.request.priorPosition) &&
      intent.request.priorPosition.sourceSignalId === intent.sourceSignalId &&
      intent.request.priorPosition.symbol === intent.request.symbol &&
      intent.request.priorPosition.split?.stage === "runner_pending");
  }

  async function provePreRunnerSplitCloseStillOpen(intent, { ownerReview = false } = {}) {
    const request = intent.request;
    let records;
    let accountState;
    let observedAt;
    try {
      records = await store.listOpenPositions();
      if (ownerReview && typeof store.listErrorPositions === "function") {
        records = [...records, ...await store.listErrorPositions()];
      }
      observedAt = Number(clock());
      accountState = await broker.readAccountState();
    } catch {
      return null;
    }
    const record = Array.isArray(records)
      ? records.find((row) => row.sourceSignalId === intent.sourceSignalId)
      : null;
    const state = record?.snapshot;
    const split = state?.split;
    if (!validObject(record) ||
        !(["open", "closing", "unknown"].includes(record.status) ||
          ownerReview && record.status === "error") ||
        !validObject(state) ||
        state.sourceSignalId !== intent.sourceSignalId ||
        state.symbol !== request.symbol ||
        state.environment !== "vst" ||
        state.accountId !== request.accountId ||
        state.patternId !== "impulse_buy" ||
        split?.stage !== "runner_pending" ||
        state.exchangePositionId !== request.positionId ||
        split.positionId !== request.positionId ||
        !exactDecimalEqual(split.totalQuantity, request.totalQuantity) ||
        request.originalStop?.orderId !== split.originalStopOrderId ||
        request.coreStop?.orderId !== split.coreStop?.orderId ||
        !exactDecimalEqual(request.originalStop?.quantity, split.totalQuantity) ||
        !exactDecimalEqual(request.originalStop?.stopPrice, split.signalStopPrice) ||
        !exactDecimalEqual(request.coreStop?.quantity, split.coreStop?.quantity) ||
        !exactDecimalEqual(request.coreStop?.stopPrice, split.coreStop?.stopPrice) ||
        !validObject(accountState) ||
        accountState.verified !== true ||
        accountState.environment !== "vst" ||
        accountState.accountId !== request.accountId ||
        !Array.isArray(accountState.positions) ||
        !Array.isArray(accountState.openOrders)) {
      return null;
    }
    const compactSymbol = normalizeSymbolKey(request.symbol);
    const exchangePositions = accountState.positions.filter((row) =>
      normalizeSymbolKey(row?.symbol) === compactSymbol);
    const quantity = Number(split.totalQuantity);
    const accountPosition = exchangePositions[0];
    const rawPositionId = accountPosition?.positionId ?? accountPosition?.positionID;
    const positionId = typeof rawPositionId === "string"
      ? rawPositionId
      : Number.isSafeInteger(rawPositionId) ? String(rawPositionId) : null;
    const accountQuantity = accountPosition?.positionAmt ?? accountPosition?.quantity;
    const rawSide = accountPosition?.positionSide ?? accountPosition?.side;
    if (exchangePositions.length !== 1 ||
        positionId !== request.positionId ||
        !exactDecimalEqual(accountQuantity, split.totalQuantity) ||
        (rawSide !== undefined && rawSide !== null &&
          !["LONG", "Buy"].includes(rawSide))) {
      return null;
    }
    const persistedPosition = persistedSplitPosition(state, accountState);
    if (!persistedPosition) return null;
    let exchangePosition;
    try {
      exchangePosition = await broker.readPosition(request.symbol, {
        persistedPosition,
        allowProcessCache: false,
      });
    } catch {
      return null;
    }
    const orders = symbolOrders(accountState, request.symbol);
    const expectedStops = [
      {
        tranche: "original",
        orderId: split.originalStopOrderId,
        positionId: split.positionId,
        quantity: split.totalQuantity,
        stopPrice: split.signalStopPrice,
      },
      split.coreStop,
    ];
    const expectedIds = expectedStops.map((stop) => stop?.orderId).sort();
    if (!validObject(exchangePosition) ||
        exchangePosition.verified !== true ||
        exchangePosition.symbol !== request.symbol ||
        exchangePosition.positionId !== request.positionId ||
        !exactDecimalEqual(exchangePosition.quantity, split.totalQuantity) ||
        exchangePosition.side !== "Buy" ||
        Number(exchangePosition.leverage) !== PROFILE_LEVERAGE ||
        !profileMarginIs(exchangePosition.marginMode) ||
        !Array.isArray(orders) ||
        orders.length !== 2 ||
        !expectedIds.every((id) => typeof id === "string" && id.trim() !== "") ||
        new Set(expectedIds).size !== 2 ||
        JSON.stringify(exactOrderIds(orders)?.sort()) !==
          JSON.stringify(expectedIds) ||
        !exactRawSplitStop(state, accountState, expectedStops[0]) ||
        !exactRawSplitStop(state, accountState, expectedStops[1])) {
      return null;
    }

    return {
      record,
      state,
      observedAt,
      evidence: {
        originalIntentOutcome: intent.outcome,
        position: {
          verified: true,
          symbol: request.symbol,
          positionId: request.positionId,
          quantity: String(quantity),
          side: "Buy",
        },
        protectiveStops: expectedStops.map((stop) => ({
          orderId: stop.orderId,
          positionId: stop.positionId,
          quantity: String(stop.quantity),
          stopPrice: String(stop.stopPrice),
        })),
      },
    };
  }

  async function recoverPreRunnerSplitCloseNoWrite(intent) {
    const request = intent.request;
    const proof = await provePreRunnerSplitCloseStillOpen(intent);
    if (!proof) return false;
    const { record, state } = proof;
    const reason = "close_pre_runner_split_pre_transport_refusal_confirmed_still_open";
    const recoveredPosition = { ...state, status: "closing" };
    // Restore the position's manageable ledger state only after a fresh full
    // position read and exact verification of both owned protection stops.
    // If the intent transition then fails, its unresolved row still blocks
    // this symbol and the next tick can repeat this read-only proof.
    await store.upsertPosition(recoveredPosition);
    await store.markIntent(intent.clientOrderId, "failed", {
      outcome: {
        reason,
        mutationProvenance:
          exactPreRunnerSplitCloseNoWriteProvenance(
            intent.outcome.mutationProvenance,
          ),
      },
    });
    await store.setSignalStatus(intent.sourceSignalId, "error", reason);
    await store.recordEvent?.(intent.sourceSignalId, "vst_worker_error", {
      reason,
      symbol: request.symbol,
      operation: request.operation,
    });
    return true;
  }

  async function adoptPreRunnerOpenForPendingSourceExit(intent) {
    // This is not a retry or a no-write inference. Only a separately confirmed
    // source exit may take over the independently proved current position.
    // Keep ordinary runner-abort recovery and known sent writes fail-closed.
    const request = intent?.request;
    if (!sourceExitsEnabled ||
        intent?.state !== "unknown" || intent.exchangeOrderId !== null ||
        request?.operation !== "close_pre_runner_split" ||
        request.environment !== "vst" || request.sourceExit ||
        intent.outcome?.mutationProvenance !== undefined ||
        !/^impulse-runner-breakeven-abort-\d+$/.test(intent.phase ?? "") ||
        intent.clientOrderId !== orderId(intent.sourceSignalId, intent.phase) ||
        request.sourceSignalId !== intent.sourceSignalId ||
        request.closeIntentId !== intent.clientOrderId ||
        typeof store.getPosition !== "function" ||
        typeof store.listPendingSourceExitRequests !== "function" ||
        typeof store.adoptPreRunnerOpenForSourceExit !== "function" ||
        typeof broker.verifyPreRunnerOpenForSourceExit !== "function") return false;
    try {
      const pending = await store.listPendingSourceExitRequests({
        sourceSignalId: intent.sourceSignalId,
      });
      const sourceExit = Array.isArray(pending)
        ? pending.find((row) => row.sourceSignalId === intent.sourceSignalId &&
          row.symbol === request.symbol && sourceExitRequestValid(row)) : null;
      if (!sourceExit) return false;
      const record = await store.getPosition(intent.sourceSignalId);
      const snapshot = record?.snapshot;
      if (!validObject(snapshot) ||
          !["open", "closing", "unknown"].includes(record.status) ||
          snapshot.sourceSignalId !== intent.sourceSignalId ||
          snapshot.environment !== "vst" || snapshot.accountId !== request.accountId ||
          snapshot.symbol !== request.symbol || record.symbol !== request.symbol ||
          snapshot.patternId !== "impulse_buy" ||
          snapshot.split?.stage !== "runner_pending" ||
          snapshot.exchangePositionId !== request.positionId ||
          snapshot.split.positionId !== request.positionId ||
          !exactDecimalEqual(snapshot.remainingQty, request.totalQuantity) ||
          !exactDecimalEqual(snapshot.split.totalQuantity, request.totalQuantity) ||
          snapshot.split.originalStopOrderId !== request.originalStop?.orderId ||
          snapshot.split.coreStop?.orderId !== request.coreStop?.orderId) return false;
      const binding = await loadRaiseStopEntryProof(intent, request.positionId, snapshot);
      if (!binding) return false;
      const evidence = await broker.verifyPreRunnerOpenForSourceExit({
        request, entryProof: binding.proof,
      });
      const observedAt = Date.parse(evidence?.observedAt);
      const now = Number(clock());
      if (evidence?.verified !== true ||
          evidence.environment !== "vst" || evidence.accountId !== request.accountId ||
          evidence.symbol !== request.symbol || evidence.positionId !== request.positionId ||
          !exactDecimalEqual(evidence.quantity, request.totalQuantity) ||
          !Number.isSafeInteger(observedAt) || !Number.isSafeInteger(now) ||
          observedAt > now || now - observedAt > 5_000) return false;
      const result = await store.adoptPreRunnerOpenForSourceExit({
        sourceSignalId: intent.sourceSignalId,
        clientOrderId: intent.clientOrderId,
        expectedIntent: intent,
        expectedPositionSnapshot: snapshot,
        expectedSourceExitRequest: sourceExit,
        evidence,
      });
      return result?.kind === "adopted";
    } catch (error) {
      recordVstDiagnostic(error, {
        stage: "reconciliation", operation: "close_pre_runner_split",
        symbol: request.symbol, sourceSignalId: intent.sourceSignalId,
        check: "source_exit_current_position_proof",
      });
      return false;
    }
  }

  async function assertRaiseStopPositionStillCurrent(intent, request) {
    const prior = request?.priorPosition;
    if (!validObject(prior) || prior.sourceSignalId !== intent.sourceSignalId ||
        prior.status !== "open" || prior.environment !== "vst" ||
        prior.accountId !== request.accountId || prior.symbol !== request.symbol ||
        consistentExchangeIdentifier(prior, "exchangePositionId", "positionId") !==
          exactExchangeIdentifier(request.positionId) ||
        !exactDecimalEqual(
          prior.remainingQty ?? prior.quantity, request.previousQuantity,
        )) {
      throw new Error("raise_stop_prior_position_not_verified");
    }
    if (typeof store.getPosition !== "function" ||
        typeof store.getIntent !== "function" ||
        typeof intent.phase !== "string") {
      throw new Error("raise_stop_atomic_recovery_context_unavailable");
    }
    const current = await store.getPosition(intent.sourceSignalId);
    const snapshot = current?.snapshot;
    const storedIntent = await store.getIntent(intent.sourceSignalId, intent.phase);
    const priorStop = prior.verifiedProtectiveStops?.[request.leg] ??
      prior.protectiveStops?.[request.leg] ??
      prior.split?.[`${request.leg}Stop`] ??
      prior[`${request.leg}Stop`] ?? {
        verified: true,
        orderId: prior[`${request.leg}StopOrderId`],
        positionId: prior[`${request.leg}StopPositionId`] ??
          prior.exchangePositionId,
        quantity: prior[`${request.leg}StopQuantity`] ??
          prior[`${request.leg}Qty`],
        stopPrice: prior[`${request.leg}StopPrice`] ?? prior.stopPrice,
      };
    const currentStop = snapshot?.verifiedProtectiveStops?.[request.leg] ??
      snapshot?.protectiveStops?.[request.leg] ??
      snapshot?.split?.[`${request.leg}Stop`] ??
      snapshot?.[`${request.leg}Stop`] ?? {
        verified: true,
        orderId: snapshot?.[`${request.leg}StopOrderId`],
        positionId: snapshot?.[`${request.leg}StopPositionId`] ??
          snapshot?.exchangePositionId,
        quantity: snapshot?.[`${request.leg}StopQuantity`] ??
          snapshot?.[`${request.leg}Qty`],
        stopPrice: snapshot?.[`${request.leg}StopPrice`] ??
          snapshot?.stopPrice,
      };
    const priorStopId = consistentExchangeIdentifier(priorStop, "orderId", "orderID") ??
      exactExchangeIdentifier(prior[`${request.leg}StopOrderId`]);
    const currentStopId =
      consistentExchangeIdentifier(currentStop, "orderId", "orderID") ??
      exactExchangeIdentifier(snapshot?.[`${request.leg}StopOrderId`]);
    const priorStopPrice = priorStop?.stopPrice ?? prior.stopPrice;
    const currentStopPrice = currentStop?.stopPrice ?? snapshot?.stopPrice;
    const immutableTextFields = [
      "patternId", "version", "entryClientOrderId", "entryOrderId",
      "entryOrderType", "entryAt", "signalAt",
    ];
    const immutableQuantityFields = [
      "entryPrice", "quantity", "coreQty", "runnerQty", "remainingQty",
      "stopPrice",
    ];
    const immutablePositionMatches = immutableTextFields.every((field) =>
      !Object.hasOwn(prior, field) || snapshot?.[field] === prior[field]) &&
      immutableQuantityFields.every((field) =>
        !Object.hasOwn(prior, field) ||
        (prior[field] === null
          ? snapshot?.[field] === prior[field]
          : exactDecimalEqual(snapshot?.[field], prior[field]))) &&
      ["coreOpen", "runnerOpen"].every((field) =>
        !Object.hasOwn(prior, field) || snapshot?.[field] === prior[field]);
    if (!validObject(current) ||
        !["open", "unknown"].includes(current.status) ||
        !validObject(snapshot) || snapshot.status !== current.status ||
        !immutablePositionMatches ||
        snapshot.sourceSignalId !== intent.sourceSignalId ||
        snapshot.environment !== "vst" ||
        snapshot.accountId !== request.accountId ||
        snapshot.symbol !== request.symbol ||
        consistentExchangeIdentifier(snapshot, "exchangePositionId", "positionId") !==
          exactExchangeIdentifier(request.positionId) ||
        !exactDecimalEqual(
          snapshot.remainingQty ?? snapshot.quantity, request.previousQuantity,
        ) ||
        !priorStopId || currentStopId !== priorStopId ||
        priorStop?.verified !== true || currentStop?.verified !== true ||
        exactExchangeIdentifier(priorStop.positionId) !==
          exactExchangeIdentifier(request.positionId) ||
        exactExchangeIdentifier(currentStop.positionId) !==
          exactExchangeIdentifier(request.positionId) ||
        !exactDecimalEqual(priorStop.quantity, request.previousQuantity) ||
        !exactDecimalEqual(currentStop.quantity, request.previousQuantity) ||
        !exactDecimalEqual(currentStopPrice, priorStopPrice) ||
        exactExchangeIdentifier(
          consistentExchangeIdentifier(snapshot, "exchangePositionId", "positionId"),
        ) !== exactExchangeIdentifier(request.positionId) ||
        snapshot.entryClientOrderId !== prior.entryClientOrderId ||
        snapshot.entryOrderId !== prior.entryOrderId ||
        snapshot.manualResolution != null ||
        snapshot.closeFill != null || snapshot.lastCloseFill != null ||
        snapshot.closedAt != null ||
        snapshot.marginTopUp?.manualResolution != null ||
        !validObject(storedIntent) ||
        storedIntent.clientOrderId !== intent.clientOrderId ||
        !["submitted", "unknown"].includes(storedIntent.state) ||
        exactExchangeIdentifier(storedIntent.exchangeOrderId) !==
          exactExchangeIdentifier(intent.exchangeOrderId) ||
        storedIntent.request?.operation !== "raise_stop" ||
        storedIntent.request?.sourceSignalId !== intent.sourceSignalId ||
        storedIntent.request?.positionId !== request.positionId ||
        storedIntent.request?.stopPrice !== request.stopPrice) {
      throw new Error("raise_stop_persisted_position_changed");
    }
    return current;
  }

  async function commitVerifiedRaiseStop(intent, request, evidence) {
    if (typeof store.commitVerifiedIntent !== "function") {
      throw new Error("raise_stop_atomic_commit_unavailable");
    }
    checkActionEvidence(request, evidence, PROFILE);
    const submittedOrderId = exactExchangeIdentifier(intent.exchangeOrderId);
    const position = evidence?.position;
    const stop = evidence?.protectiveStops?.[request.leg] ??
      position?.protectiveStops?.[request.leg];
    if (!submittedOrderId ||
        exactExchangeIdentifier(evidence?.exchangeOrderId) !== submittedOrderId ||
        exactExchangeIdentifier(position?.positionId) !==
          exactExchangeIdentifier(request.positionId) ||
        !exactDecimalEqual(position?.quantity, request.previousQuantity) ||
        stop?.verified !== true ||
        exactExchangeIdentifier(stop.orderId) !== submittedOrderId ||
        exactExchangeIdentifier(stop.positionId) !==
          exactExchangeIdentifier(request.positionId) ||
        !exactDecimalEqual(stop.quantity, request.quantity) ||
        compareExactDecimals(stop.stopPrice, request.stopPrice) < 0) {
      throw new Error("raise_stop_native_order_evidence_not_verified");
    }
    const expectedPosition = await assertRaiseStopPositionStillCurrent(intent, request);
    const entryBinding = await loadRaiseStopEntryProof(
      intent, request.positionId, expectedPosition.snapshot,
    );
    if (!entryBinding || !validObject(request.entryProof) ||
        canonicalPolicyJson(request.entryProof) !==
          canonicalPolicyJson(entryBinding.proof)) {
      throw new Error("raise_stop_original_entry_proof_not_verified");
    }
    const confirmed = confirmedActionPosition(request, evidence);
    const outcome = {
      status: "filled",
      verified: true,
      operation: "raise_stop",
      leg: request.leg,
      stop: {
        orderId: stop.orderId,
        positionId: stop.positionId,
        quantity: String(stop.quantity),
        stopPrice: String(stop.stopPrice),
      },
    };
    await store.commitVerifiedIntent({
      sourceSignalId: intent.sourceSignalId,
      clientOrderId: intent.clientOrderId,
      position: confirmed,
      signalStatus: "open",
      exchangeOrderId: submittedOrderId,
      outcome,
      eventKind: "vst_raise_stop_verified",
      expectedPositionSnapshot: expectedPosition.snapshot,
      expectedPositionUpdatedAt: expectedPosition.updatedAt,
      eventDetail: {
        leg: request.leg,
        orderId: stop.orderId,
        positionId: stop.positionId,
        quantity: String(stop.quantity),
        stopPrice: String(stop.stopPrice),
      },
    });
    return confirmed;
  }

  async function recoverUnlinkedRaiseStopProtection(intent, observedDegradedRecovery = false) {
    const request = intent?.request;
    // This legacy-only branch is deliberately narrower than ordinary
    // raise-stop reconciliation. Unsupported stores/brokers keep the intent
    // unresolved and use the existing read-only fallback unchanged.
    if (intent?.state !== (observedDegradedRecovery ? "failed" : "unknown") || intent.exchangeOrderId !== null ||
        request?.operation !== "raise_stop" || request.leg !== "core" ||
        !/^raise_stop-core-\d+(?:-\d+)?$/.test(intent.phase ?? "") ||
        intent.outcome?.reason !== (observedDegradedRecovery
          ? "raise_stop_protected_degraded" : "exchange_state_not_verified") ||
        typeof store.getPosition !== "function" ||
        typeof broker.verifyUnlinkedRaiseStopProtection !== "function" ||
        typeof store.adoptUnlinkedRaiseStopProtection !== "function") {
      return { kind: "not_applicable" };
    }
    const startedAt = Number(clock());
    if (!Number.isSafeInteger(startedAt) || startedAt <= 0) {
      return { kind: "unknown" };
    }
    let positionRecord;
    try {
      positionRecord = await store.getPosition(intent.sourceSignalId);
    } catch {
      return { kind: "unknown" };
    }
    const snapshot = positionRecord?.snapshot;
    const prior = request.priorPosition;
    const priorStop = prior?.verifiedProtectiveStops?.core;
    const snapshotStop = snapshot?.verifiedProtectiveStops?.core;
    const exactStopAliases = (stop) => validObject(stop) &&
      stop.verified === true && (stop.tranche === undefined || stop.tranche === "core") &&
      exactExchangeIdentifier(stop.orderId) === exactExchangeIdentifier(priorStop?.orderId) &&
      exactExchangeIdentifier(stop.positionId) === exactExchangeIdentifier(request.positionId) &&
      exactDecimalEqual(stop.quantity, request.previousQuantity) &&
      exactDecimalEqual(stop.stopPrice, priorStop.stopPrice);
    const priorQuantityMatches = [
      prior?.quantity, prior?.remainingQty, prior?.coreQty,
      prior?.coreStopQuantity, request.quantity, request.previousQuantity,
    ].filter((value) => value !== undefined && value !== null)
      .every((value) => exactDecimalEqual(value, request.previousQuantity));
    if (!validObject(positionRecord) ||
        !["unknown", "open"].includes(positionRecord.status) ||
        !validObject(snapshot) ||
        !["unknown", "open"].includes(snapshot.status) ||
        snapshot.sourceSignalId !== intent.sourceSignalId ||
        snapshot.environment !== "vst" || snapshot.accountId !== request.accountId ||
        snapshot.symbol !== request.symbol ||
        snapshot.manualResolution != null ||
        snapshot.marginTopUp?.manualResolution != null ||
        !validObject(prior) || prior.sourceSignalId !== intent.sourceSignalId ||
        prior.environment !== "vst" || prior.accountId !== request.accountId ||
        prior.symbol !== request.symbol || prior.coreOpen !== true ||
        prior.runnerOpen !== false || prior.split != null ||
        snapshot.split != null ||
        exactExchangeIdentifier(consistentExchangeIdentifier(
          snapshot, "exchangePositionId", "positionId",
        )) !== exactExchangeIdentifier(request.positionId) ||
        exactExchangeIdentifier(consistentExchangeIdentifier(
          prior, "exchangePositionId", "positionId",
        )) !== exactExchangeIdentifier(request.positionId) ||
        snapshot.entryClientOrderId !== request.entryClientOrderId ||
        prior.entryClientOrderId !== request.entryClientOrderId ||
        !exactStopAliases(snapshotStop) || !exactStopAliases(priorStop) ||
        !priorQuantityMatches ||
        !exactDecimalEqual(snapshot.remainingQty ?? snapshot.quantity,
          request.previousQuantity) ||
        !exactDecimalEqual(request.quantity, request.previousQuantity) ||
        compareExactDecimals(request.stopPrice, priorStop.stopPrice) <= 0 ||
        typeof positionRecord.updatedAt !== "string") {
      return { kind: "unknown" };
    }
    const entryBinding = await loadRaiseStopEntryProof(
      intent, request.positionId, snapshot,
    );
    if (!entryBinding || !validObject(request.entryProof) ||
        canonicalPolicyJson(entryBinding.proof) !==
          canonicalPolicyJson(request.entryProof)) {
      return { kind: "unknown" };
    }
    let evidence;
    let protectedDegraded = false;
    try {
      evidence = await withVstDiagnosticContext({
        stage: "protection_adoption", operation: "raise_stop",
        symbol: request.symbol, sourceSignalId: intent.sourceSignalId,
      }, () => observedDegradedRecovery
        ? typeof broker.verifyObservedDegradedProtection === "function"
          ? broker.verifyObservedDegradedProtection({ request, progress: intent.outcome?.stopTransfer })
          : { verified: false, status: "unknown" }
        : broker.verifyUnlinkedRaiseStopProtection({ request }));
    } catch {
      evidence = null;
    }
    const ambiguousStopPost = request.stopTransferProtocol == null ||
      (request.stopTransferProtocol === STOP_TRANSFER_PROTOCOL &&
        intent.outcome?.stopTransfer?.version === STOP_TRANSFER_PROTOCOL &&
        intent.outcome.stopTransfer.stage === "post_started");
    if (evidence?.verified !== true && !observedDegradedRecovery &&
        ambiguousStopPost &&
        typeof broker.verifyProtectedDegradedRaiseStop === "function") {
      try {
        evidence = await broker.verifyProtectedDegradedRaiseStop({
          request, progress: intent.outcome?.stopTransfer,
        });
        protectedDegraded = evidence?.verified === true &&
          evidence.status === "protected_degraded" && evidence.currentProtectionOnly === true;
      } catch {
        return { kind: "unknown" };
      }
    }
    const stop = evidence?.protectiveStops?.core ??
      evidence?.position?.protectiveStops?.core;
    const currentProtectionObservedAt = Number(evidence?.currentProtectionObservedAt);
    if (evidence?.verified !== true || evidence.currentProtectionOnly !== true ||
        evidence.status !== (protectedDegraded ? "protected_degraded" : "filled") ||
        !Number.isSafeInteger(currentProtectionObservedAt) ||
        currentProtectionObservedAt < startedAt ||
        !stop?.verified ||
        exactExchangeIdentifier(stop.positionId) !==
          exactExchangeIdentifier(request.positionId) ||
        !exactDecimalEqual(stop.quantity, request.quantity) ||
        !exactDecimalEqual(stop.stopPrice, protectedDegraded ? priorStop.stopPrice : request.stopPrice) ||
        (protectedDegraded && stop.orderId !== priorStop.orderId) ||
        !exactExchangeIdentifier(stop.orderId)) {
      return { kind: "unknown" };
    }
    const recoveredPosition = {
      ...structuredClone(snapshot),
      status: "open",
      stopPrice: Number(stop.stopPrice),
      coreStopOrderId: stop.orderId,
      coreStopPositionId: stop.positionId,
      coreStopQuantity: String(stop.quantity),
      coreStopPrice: Number(stop.stopPrice),
      verifiedProtectiveStops: {
        ...snapshot.verifiedProtectiveStops,
        core: {
          verified: true,
          tranche: "core",
          orderId: stop.orderId,
          positionId: stop.positionId,
          quantity: String(stop.quantity),
          stopPrice: String(stop.stopPrice),
        },
      },
    };
    const currentProtection = {
      orderId: stop.orderId, positionId: stop.positionId,
      quantity: String(stop.quantity), stopPrice: String(stop.stopPrice),
      status: "NEW", workingType: "MARK_PRICE",
    };
    if (protectedDegraded) {
      recoveredPosition.protectionDegradation = protectedDegradedMarker(
        intent, currentProtection, currentProtectionObservedAt,
      );
    }
    if (observedDegradedRecovery) {
      if (snapshot.protectionDegradation?.status !== "protected_degraded" ||
          snapshot.protectionDegradation.originalClientOrderId !== intent.clientOrderId ||
          evidence.oldStopRetirement != null) return { kind: "unknown" };
      recoveredPosition.protectionDegradation = {
        ...snapshot.protectionDegradation, status: "protection_observed_attribution_unknown",
        currentProtection, protectionObservedAt: currentProtectionObservedAt,
      };
    }
    const retirement = evidence.oldStopRetirement;
    if (retirement !== undefined) {
      const sameStop = (left, right) => validObject(left) && validObject(right) &&
        exactExchangeIdentifier(left.orderId) === exactExchangeIdentifier(right.orderId) &&
        exactExchangeIdentifier(left.positionId) === exactExchangeIdentifier(right.positionId) &&
        exactDecimalEqual(left.quantity, right.quantity) &&
        exactDecimalEqual(left.stopPrice, right.stopPrice);
      if (!validObject(retirement) ||
          !sameStop(retirement.oldStop, priorStop) ||
          !sameStop(retirement.adoptedStop, stop) ||
          retirement.oldStop.orderId === retirement.adoptedStop.orderId) {
        return { kind: "unknown" };
      }
      recoveredPosition.pendingStopRetirement = {
        ...structuredClone(retirement),
        entryProof: structuredClone(entryBinding.proof),
        originalIntent: { clientOrderId: intent.clientOrderId, phase: intent.phase },
      };
    }
    const settledAt = Number(clock());
    if (!Number.isSafeInteger(settledAt) ||
        settledAt < currentProtectionObservedAt ||
        settledAt - currentProtectionObservedAt >
          READ_ONLY_RECOVERY_ACCOUNT_TO_LEDGER_MAX_AGE_MS) {
      return { kind: "unknown" };
    }
    let settled;
    try {
      settled = await store.adoptUnlinkedRaiseStopProtection({
        sourceSignalId: intent.sourceSignalId,
        clientOrderId: intent.clientOrderId,
        phase: intent.phase,
        expectedRequest: request,
        expectedOutcome: intent.outcome,
        expectedPositionSnapshot: snapshot,
        expectedPositionUpdatedAt: positionRecord.updatedAt,
        expectedEntryIntent: entryBinding.entryIntent,
        entryProof: entryBinding.proof,
        currentProtection: {
          orderId: stop.orderId,
          positionId: stop.positionId,
          quantity: String(stop.quantity),
          stopPrice: String(stop.stopPrice),
          status: "NEW",
          workingType: "MARK_PRICE",
        },
        position: recoveredPosition,
        ...(retirement !== undefined ? { oldStopRetirement: retirement } : {}),
        requestStartedAtMs: currentProtectionObservedAt,
        maxEvidenceAgeMs: READ_ONLY_RECOVERY_ACCOUNT_TO_LEDGER_MAX_AGE_MS,
        clock: () => Number(clock()),
        protectedDegraded,
        observedDegradedRecovery,
        eventDetail: {
          operation: "raise_stop",
          adoptedProtection: {
            orderId: stop.orderId,
            positionId: stop.positionId,
            quantity: String(stop.quantity),
            stopPrice: String(stop.stopPrice),
            status: "NEW",
            workingType: "MARK_PRICE",
          },
          originalIntent: {
            clientOrderId: intent.clientOrderId,
            phase: intent.phase,
            execution: "unknown_unproven",
            priorOutcome: intent.outcome,
          },
          entryProof: entryBinding.proof,
          originalWriteAttributed: false,
          ...(protectedDegraded ? {
            protectionDegradation: recoveredPosition.protectionDegradation,
            requestedStopPrice: String(request.stopPrice),
            verifiedStopPrice: String(stop.stopPrice),
          } : {}),
          ...(retirement !== undefined ? { oldStopRetirement: retirement } : {}),
        },
      });
    } catch {
      return { kind: "unknown" };
    }
    if (settled?.kind !== "recovered" && settled?.kind !== "replayed") {
      return { kind: "unknown" };
    }
    deferredRecoveryReasonByIntent.delete(intent.clientOrderId);
    deferredRecoveryDiagnosticRefByIntent.delete(intent.clientOrderId);
    return {
      kind: "failed",
      reason: protectedDegraded ? "raise_stop_protected_degraded" : observedDegradedRecovery
        ? "raise_stop_degraded_protection_observed" : "raise_stop_unlinked_protection_adopted",
      unlinkedProtectionAdoptionBoundary: true,
    };
  }

  async function settleAdoptedStopRetirement(intent) {
    const request = intent.request;
    const record = await store.getPosition(intent.sourceSignalId);
    if (!record || record.status !== "open" ||
        canonicalPolicyJson(record.snapshot) !== canonicalPolicyJson(request.priorPosition)) {
      return { kind: "unknown", reason: "adopted_stop_retirement_position_changed" };
    }
    const binding = await loadRaiseStopEntryProof(intent, request.positionId, record.snapshot);
    if (!binding || canonicalPolicyJson(binding.proof) !== canonicalPolicyJson(request.entryProof)) {
      return { kind: "unknown", reason: "adopted_stop_retirement_entry_unverified" };
    }
    const evidence = await broker.reconcileIntent({
      clientOrderId: intent.clientOrderId, phase: intent.phase, request,
      exchangeOrderId: intent.exchangeOrderId,
    });
    const stop = evidence?.protectiveStops?.core ?? evidence?.position?.protectiveStops?.core;
    const expected = request.adoptedStop;
    if (evidence?.verified !== true || evidence.status !== "filled" ||
        evidence.exchangeOrderId !== request.oldStop?.orderId ||
        evidence.canceledStopOrderId !== request.oldStop.orderId ||
        !stop?.verified || stop.orderId !== expected?.orderId ||
        stop.positionId !== request.positionId ||
        !exactDecimalEqual(stop.quantity, expected.quantity) ||
        !exactDecimalEqual(stop.stopPrice, expected.stopPrice)) {
      return { kind: "unknown", reason: "adopted_stop_retirement_unverified" };
    }
    const nextPosition = structuredClone(request.priorPosition);
    delete nextPosition.pendingStopRetirement;
    if (canonicalPolicyJson(nextPosition) !== canonicalPolicyJson(request.nextPosition)) {
      return { kind: "unknown", reason: "adopted_stop_retirement_snapshot_mismatch" };
    }
    await store.commitVerifiedIntent({
      sourceSignalId: intent.sourceSignalId, clientOrderId: intent.clientOrderId,
      position: nextPosition, signalStatus: "open",
      exchangeOrderId: request.oldStop.orderId,
      expectedPositionSnapshot: record.snapshot,
      expectedPositionUpdatedAt: record.updatedAt,
      outcome: {
        operation: "retire_adopted_stop", verified: true, status: "filled",
        exchangeOrderId: request.oldStop.orderId,
        canceledStopOrderId: request.oldStop.orderId,
        adoptedStopOrderId: expected.orderId,
      },
      eventKind: "vst_adopted_stop_old_protection_retired",
      eventDetail: {
        canceledStopOrderId: request.oldStop.orderId,
        adoptedStopOrderId: expected.orderId,
        originalWriteAttributed: false,
      },
    });
    return { kind: "reconciled", reason: "adopted_stop_old_protection_retired" };
  }

  async function advanceAdoptedStopRetirement(record, capabilities, allowActions) {
    const state = record.snapshot;
    const pending = state.pendingStopRetirement;
    if (!validObject(pending) || !validObject(pending.oldStop) ||
        !validObject(pending.adoptedStop) || !validObject(pending.entryProof) ||
        typeof store.commitVerifiedIntent !== "function") {
      return { kind: "unknown", reason: "adopted_stop_retirement_context_invalid" };
    }
    const nextPosition = structuredClone(state);
    delete nextPosition.pendingStopRetirement;
    const basePhase = `retire-adopted-stop-${pending.adoptedStop.orderId}`;
    let phase = basePhase;
    const existing = await store.getIntent(record.sourceSignalId, basePhase);
    if (existing) {
      const noSend = existing.state === "failed" &&
        existing.outcome?.reason === "adopted_stop_retirement_not_sent" &&
        exactOriginalStopCancelMutationProvenance(existing.outcome?.mutationProvenance)
          ?.mutationRequestSent === false;
      if (!noSend) return await reconcileOne(existing, capabilities);
      // Never create another cancellation while an earlier retry is ambiguous.
      const unresolved = await store.listUnresolvedIntents();
      const outstanding = unresolved.find(row =>
        row.sourceSignalId === record.sourceSignalId &&
        row.request?.operation === "retire_adopted_stop");
      if (outstanding) return await reconcileOne(outstanding, capabilities);
      phase = `${basePhase}-retry-${Number(clock())}`;
    }
    if (!allowActions) return { kind: "observed", reason: "adopted_stop_retirement_pending" };
    const request = {
      operation: "retire_adopted_stop", sourceSignalId: record.sourceSignalId,
      environment: "vst", accountId: state.accountId, symbol: state.symbol,
      positionId: pending.adoptedStop.positionId,
      quantity: String(pending.adoptedStop.quantity),
      oldStop: structuredClone(pending.oldStop),
      adoptedStop: structuredClone(pending.adoptedStop),
      entryProof: structuredClone(pending.entryProof),
      entryClientOrderId: state.entryClientOrderId,
      entryOrderId: pending.entryProof.entryOrderId,
      priorPosition: structuredClone(state), nextPosition,
    };
    const result = await reserveAndPerform(record.sourceSignalId, phase, request);
    if (!["submitted", "existing"].includes(result.kind)) return result;
    const intent = await store.getIntent(record.sourceSignalId, phase);
    return intent ? await reconcileOne(intent, capabilities)
      : { kind: "unknown", reason: "adopted_stop_retirement_intent_missing" };
  }

  async function reconcileOne(intent, brokerCapabilities, allowMarginMutation = false) {
    const wasUnknown = intent.state === "unknown";
    if (intent.request?.operation === "observe_triggered_stop") {
      // Triggered-stop intents are settled by the dedicated read-only broker
      // evidence path, never by the ordinary action-intent reconciler.
      return { kind: "unresolved" };
    }
    const expectedAccountId = brokerCapabilities?.accountId ?? intent.request?.accountId;
    if (typeof expectedAccountId !== "string" || expectedAccountId.trim() === "" ||
        intent.request?.accountId !== expectedAccountId ||
        intent.request?.environment !== "vst") {
      await store.markIntent(intent.clientOrderId, "unknown", {
        outcome: { reason: "intent_account_or_environment_mismatch" },
      });
      if (intent.request?.operation === "margin_top_up") {
        await flagMarginTopUpUnconfirmed(
          intent, "vst_margin_top_up_account_or_environment_mismatch", wasUnknown,
        );
      }
      return { kind: "unknown" };
    }
    // Durable paced read episodes. Claiming permits reads only and does not
    // change submission state or erase exact acknowledgements.
    if (uncertaintyOperation(intent) && ["submitted", "unknown"].includes(intent.state) &&
        typeof store.claimUncertaintyRead === "function") {
      const claimed = await store.claimUncertaintyRead(intent, Number(clock()));
      if (!claimed) return { kind: "waiting", reason: "uncertainty_read_paced" };
      intent = claimed;
    }
    if (intent.request?.stopTransferProtocol === STOP_TRANSFER_PROTOCOL &&
        (intent.outcome?.stopTransfer?.version === STOP_TRANSFER_PROTOCOL &&
          intent.outcome.stopTransfer.stage === "prepared" ||
          intent.state === "prepared" && !intent.outcome?.stopTransfer) &&
        ["split_raise_stop_cancel", "retire_adopted_stop"].includes(intent.request.operation)) {
      const journal = createTransferJournal(intent);
      exchangeActionAttemptedThisTick = true;
      try {
        await broker.performIntent({
          clientOrderId: intent.clientOrderId, phase: intent.phase,
          request: intent.request, stopTransferJournal: journal,
        });
      } catch (error) {
        recordVstDiagnostic(error, { stage: "stop_transfer_first_cancellation" });
      }
      intent.outcome = { ...intent.outcome, stopTransfer: journal.getProgress() };
      if (intent.outcome.stopTransfer.stage === "prepared") {
        return { kind: "unresolved", exchangeMutationAttempted: true };
      }
      // Re-enter only after the first cancellation crossed its durable boundary.
      // The next pass can verify, never send a second DELETE.
      return {
        ...await reconcileOne(intent, brokerCapabilities, false),
        exchangeMutationAttempted: true,
      };
    }
    if (intent.request?.operation === "retire_adopted_stop") {
      // Dedicated settlement prevents the generic action fallback from
      // discarding the durable marker or misattributing the original POST.
      try {
        return await settleAdoptedStopRetirement(intent);
      } catch (error) {
        recordVstDiagnostic(error, {
          stage: "reconciliation", operation: "retire_adopted_stop",
          symbol: intent.request.symbol, sourceSignalId: intent.sourceSignalId,
        });
        return { kind: "unknown", reason: "adopted_stop_retirement_settlement_unavailable" };
      }
    }
    if (intent.request?.stopTransferProtocol === STOP_TRANSFER_PROTOCOL) {
      const progress = intent.outcome?.stopTransfer;
      if ((progress?.version === STOP_TRANSFER_PROTOCOL && progress.stage === "prepared" ||
          !progress && intent.state === "prepared") &&
          !intent.exchangeOrderId &&
          ["raise_stop", "split_raise_stop_place"].includes(intent.request.operation) &&
          typeof broker.verifyPreparedStopTransfer === "function" &&
          typeof store.settlePreparedStopTransfer === "function") {
        try {
          const expectedPosition = await store.getPosition(intent.sourceSignalId);
          const startedAt = Date.now();
          if (matchesPreparedStopTransferPosition(intent.request, expectedPosition?.snapshot) &&
              await broker.verifyPreparedStopTransfer(intent.request) &&
              Date.now() - startedAt <= 10_000 &&
              await store.settlePreparedStopTransfer({
                clientOrderId: intent.clientOrderId, request: intent.request, expectedPosition,
              })) {
            return { kind: "failed", reason: "stop_transfer_prepared_not_sent" };
          }
        } catch (error) {
          recordVstDiagnostic(error, { stage: "stop_transfer_prepared_recovery" });
        }
        return { kind: "unresolved" };
      }
      if (intent.request.operation === "raise_stop" &&
          progress?.version === STOP_TRANSFER_PROTOCOL && progress.stage === "post_acknowledged" &&
          progress.newStopOrderId === intent.exchangeOrderId &&
          typeof broker.resumeStopTransferCancellation === "function") {
        let mutationAttempted = false;
        try {
          let evidence = await broker.reconcileIntent({
            clientOrderId: intent.clientOrderId, phase: intent.phase,
            request: intent.request, exchangeOrderId: intent.exchangeOrderId,
          });
          if (!isUsableIntentEvidence(evidence)) {
            mutationAttempted = true;
            exchangeActionAttemptedThisTick = true;
            await broker.resumeStopTransferCancellation({
              intent, stopTransferJournal: createTransferJournal(intent),
            });
            evidence = await broker.reconcileIntent({
              clientOrderId: intent.clientOrderId, phase: intent.phase,
              request: intent.request, exchangeOrderId: intent.exchangeOrderId,
            });
          }
          checkActionEvidence(intent.request, evidence, PROFILE);
          await commitVerifiedRaiseStop(intent, intent.request, evidence);
          return { kind: "reconciled", exchangeMutationAttempted: mutationAttempted };
        } catch (error) {
          recordVstDiagnostic(error, { stage: "stop_transfer_cancellation_recovery" });
          return { kind: "unresolved", exchangeMutationAttempted: mutationAttempted };
        }
      }
    }
    if (exactRaiseStopEqualPriceRejectionOutcome(intent)) {
      const refusal = await evaluateRaiseStopEqualPriceNoopRefusal(intent);
      if (refusal.outcome !== "confirmed_old_stop_unchanged") {
        rememberRecoveryDeferredReason(
          intent, refusal.deferredReason ??
            "raise_stop_equal_price_noop_proof_not_verified",
          refusal.diagnosticRef,
        );
        return { kind: "unknown" };
      }
      if (typeof store.recoverRaiseStopEqualPriceNoop !== "function") {
        rememberRecoveryDeferredReason(
          intent, "raise_stop_equal_price_noop_store_unavailable",
        );
        return { kind: "unknown" };
      }
      let settled;
      try {
        settled = await store.recoverRaiseStopEqualPriceNoop({
          sourceSignalId: intent.sourceSignalId,
          clientOrderId: intent.clientOrderId,
          phase: intent.phase,
          expectedRequest: intent.request,
          expectedOutcome: intent.outcome,
          expectedPositionSnapshot: refusal.positionRecord.snapshot,
          expectedPositionUpdatedAt: refusal.positionRecord.updatedAt,
          expectedEntryIntent: refusal.entryIntent,
          entryProof: refusal.entryProof,
          requestStartedAtMs: refusal.requestStartedAtMs,
          maxEvidenceAgeMs: READ_ONLY_RECOVERY_ACCOUNT_TO_LEDGER_MAX_AGE_MS,
          clock: () => Number(clock()),
          oldPositionAndStop: {
            positionId: refusal.positionId,
            quantity: refusal.quantity,
            stopOrderId: refusal.stopOrderId,
            stopPrice: refusal.stopPrice,
            executionProof: refusal.executionProof,
          },
        });
      } catch {
        rememberRecoveryDeferredReason(
          intent, "raise_stop_equal_price_noop_store_unavailable",
        );
        return { kind: "unknown" };
      }
      if (settled?.kind === "recovered" || settled?.kind === "replayed") {
        deferredRecoveryReasonByIntent.delete(intent.clientOrderId);
        deferredRecoveryDiagnosticRefByIntent.delete(intent.clientOrderId);
        return {
          kind: "failed",
          reason: "raise_stop_equal_price_noop_retired",
          raiseStopEqualPriceNoopRecoveryBoundary: true,
        };
      }
      rememberRecoveryDeferredReason(
        intent, "raise_stop_equal_price_noop_compare_and_set_changed",
      );
      return { kind: "unknown" };
    }
    const adoptedProtection = await recoverUnlinkedRaiseStopProtection(intent);
    if (adoptedProtection.kind !== "not_applicable") return adoptedProtection;
    if (exactRaiseStopRefusalOutcome(intent)) {
      // Only this exact local pre-adapter refusal can enter the narrow
      // read-only proof path. Adapter errors and aliases remain unresolved.
      const committedClose = await evaluateRaiseStopCommittedClose(intent);
      if (committedClose.outcome === "confirmed_already_committed_close") {
        if (typeof store.settleRaiseStopRefusalAfterVerifiedClose !== "function") {
          rememberRecoveryDeferredReason(
            intent, "raise_stop_closed_fill_settlement_store_unavailable",
          );
          return { kind: "unknown" };
        }
        let settled;
        try {
          settled = await store.settleRaiseStopRefusalAfterVerifiedClose({
            sourceSignalId: intent.sourceSignalId,
            clientOrderId: intent.clientOrderId,
            phase: intent.phase,
            expectedRequest: intent.request,
            expectedOutcome: intent.outcome,
            expectedPositionSnapshot: committedClose.positionRecord.snapshot,
            expectedPositionUpdatedAt: committedClose.positionRecord.updatedAt,
            oldStopOrderId: committedClose.stopId,
            closePhase: committedClose.closePhase,
            closeIntent: committedClose.closeIntent,
          });
        } catch {
          settled = null;
        }
        if (settled?.kind === "recovered" || settled?.kind === "replayed") {
          return {
            kind: "failed",
            reason: "raise_stop_refusal_retired_after_committed_close",
            raiseStopClosedFillRecoveryBoundary: true,
          };
        }
        rememberRecoveryDeferredReason(
          intent, "raise_stop_closed_fill_settlement_compare_and_set_changed",
        );
        return { kind: "unknown" };
      }
      const refusal = await evaluateRaiseStopEntryProofRefusal(intent);
      if (refusal.outcome === "confirmed_old_stop_unchanged") {
        if (typeof store.recoverRaiseStopPreUpgradeRefusal !== "function") {
          rememberRecoveryDeferredReason(
            intent, "raise_stop_recovery_store_unavailable",
          );
          return { kind: "unknown" };
        }
        const positionRecord = refusal.positionRecord;
        let settled;
        try {
          settled = await store.recoverRaiseStopPreUpgradeRefusal({
            sourceSignalId: intent.sourceSignalId,
            clientOrderId: intent.clientOrderId,
            phase: intent.phase,
            expectedRequest: intent.request,
            expectedOutcome: intent.outcome,
            expectedPositionSnapshot: positionRecord.snapshot,
            expectedPositionUpdatedAt: positionRecord.updatedAt,
            expectedEntryIntent: refusal.entryIntent,
            entryProof: refusal.entryProof,
            requestStartedAtMs: refusal.requestStartedAtMs,
            maxEvidenceAgeMs: READ_ONLY_RECOVERY_ACCOUNT_TO_LEDGER_MAX_AGE_MS,
            clock: () => Number(clock()),
            oldPositionAndStop: {
              positionId: refusal.positionId,
              quantity: refusal.quantity,
              stopOrderId: refusal.stopOrderId,
              stopPrice: refusal.stopPrice,
              executionProof: refusal.executionProof,
            },
          });
        } catch {
          rememberRecoveryDeferredReason(
            intent, "raise_stop_recovery_store_unavailable",
          );
          return { kind: "unknown" };
        }
        if (settled?.kind === "recovered" || settled?.kind === "replayed") {
          deferredRecoveryReasonByIntent.delete(intent.clientOrderId);
          deferredRecoveryDiagnosticRefByIntent.delete(intent.clientOrderId);
          return {
            kind: "failed",
            reason: "raise_stop_entry_proof_refused_before_upgrade",
            raiseStopRefusalRecoveryBoundary: true,
          };
        }
        rememberRecoveryDeferredReason(
          intent, "raise_stop_recovery_compare_and_set_changed",
        );
        return { kind: "unknown" };
      }
      // A read outage or any stale, partial, or contradictory proof leaves
      // the ambiguous write intent untouched; never use ordinary recovery.
      rememberRecoveryDeferredReason(
        intent, refusal.deferredReason ??
          "raise_stop_entry_proof_not_linked_or_fresh", refusal.diagnosticRef,
      );
      return { kind: "unknown" };
    }
    const sentCancelRunnerFill = exactOriginalStopCancelSentAmbiguous(intent);
    if (exactOriginalStopCancelPreReadRefusal(intent) || sentCancelRunnerFill) {
      const runnerFill = await evaluateOriginalStopCancelRunnerFill(intent, {
        sentCancelConfirmed: sentCancelRunnerFill,
      });
      if (runnerFill.outcome ===
            "confirmed_original_stop_cancel_runner_fill" ||
          runnerFill.outcome ===
            "confirmed_sent_original_stop_cancel_runner_fill") {
        const baseline = runnerFill.positionRecord.snapshot;
        const proof = runnerFill.proof;
        const stop = {
          orderId: runnerFill.runnerId,
          quantity: runnerFill.runnerQuantity,
          stopPrice: runnerFill.runnerStopPrice,
        };
        const normalizedCore = {
          verified: true,
          orderId: runnerFill.coreId,
          positionId: runnerFill.positionId,
          quantity: runnerFill.coreQuantity,
          stopPrice: runnerFill.signalStopPrice,
        };
        const activeStops = (sentCancelRunnerFill
          ? [proof.coreStop]
          : [proof.originalStop, proof.coreStop]).map((row) => ({
          ...row,
          orderId: consistentExchangeIdentifier(row, "orderId", "orderID"),
          positionId: consistentExchangeIdentifier(row, "positionId", "positionID"),
          quantity: runnerFill.coreQuantity,
          stopPrice: runnerFill.signalStopPrice,
        }));
        const normalizedPosition = {
          ...proof.position,
          verified: true,
          symbol: baseline.symbol,
          positionId: runnerFill.positionId,
          quantity: runnerFill.coreQuantity,
          side: "Buy",
          leverage: PROFILE_LEVERAGE,
          marginMode: PROFILE_MARGIN,
          protectiveStops: { core: normalizedCore },
        };
        const evidence = {
          verified: true,
          status: "filled",
          runnerFillRecovery: true,
          parentStopId: runnerFill.runnerId,
          parentStopPrice: runnerFill.runnerStopPrice,
          childOrderId: runnerFill.fill.orderId,
          originalCancellationConfirmed:
            sentCancelRunnerFill && proof.originalCancellationConfirmed === true,
          fill: runnerFill.fill,
          residualPosition: {
            verified: true,
            positionId: runnerFill.positionId,
            quantity: runnerFill.coreQuantity,
          },
          openStops: activeStops,
          position: normalizedPosition,
        };
        const cleanupState = {
          ...baseline,
          quantity: runnerFill.totalQuantity,
          remainingQty: runnerFill.totalQuantity,
          coreQty: Number(runnerFill.coreQuantity),
          runnerQty: Number(runnerFill.runnerQuantity),
          stopPrice: Number(runnerFill.signalStopPrice),
          coreOpen: true,
          runnerOpen: true,
        };
        const originalCancelRecovery = {
          sourceSignalId: intent.sourceSignalId,
          oldCancelClientOrderId: intent.clientOrderId,
          oldCancelPhase: intent.phase,
          expectedRequest: intent.request,
          expectedOutcome: intent.outcome,
          expectedPositionSnapshot: baseline,
          expectedPositionUpdatedAt: runnerFill.positionRecord.updatedAt,
          requestStartedAtMs: proof.requestStartedAtMs,
          maxEvidenceAgeMs: READ_ONLY_RECOVERY_ACCOUNT_TO_LEDGER_MAX_AGE_MS,
          clock: () => Number(clock()),
          proof,
          recoveryMode: sentCancelRunnerFill
            ? "sent_cancel_confirmed"
            : "pre_delete_refusal",
          expectedOldIntentState: intent.state,
        };
        return await persistTriggeredRunnerCleanup(
          { sourceSignalId: intent.sourceSignalId },
          cleanupState,
          normalizedPosition,
          stop,
          normalizedCore,
          evidence,
          Number(runnerFill.coreQuantity),
          null,
          originalCancelRecovery,
        );
      }
      if (runnerFill.outcome === "invalid" || sentCancelRunnerFill) {
        rememberRecoveryDeferredReason(
          intent,
          runnerFill.deferredReason ??
            "original_stop_cancel_runner_fill_proof_mismatch",
        );
        return { kind: "unknown" };
      }
      const refusal = await evaluateOriginalStopCancelPreReadRefusal(intent);
      if (refusal.outcome === "confirmed_original_stop_cancel_pre_read_refusal") {
        if (typeof store.recoverPreDeleteOriginalStopCancel !== "function") {
          rememberRecoveryDeferredReason(
            intent, "original_stop_cancel_recovery_store_unavailable",
          );
          return { kind: "unknown" };
        }
        let settled;
        try {
          settled = await store.recoverPreDeleteOriginalStopCancel({
            sourceSignalId: intent.sourceSignalId,
            clientOrderId: intent.clientOrderId,
            phase: intent.phase,
            expectedRequest: intent.request,
            expectedOutcome: intent.outcome,
            expectedPositionSnapshot: refusal.positionRecord.snapshot,
            expectedPositionUpdatedAt: refusal.positionRecord.updatedAt,
            recoveryPosition: refusal.recoveryPosition,
            recoveryPhase: refusal.retryPhase,
            requestStartedAtMs: refusal.requestStartedAtMs,
            maxEvidenceAgeMs: READ_ONLY_RECOVERY_ACCOUNT_TO_LEDGER_MAX_AGE_MS,
            clock: () => Number(clock()),
            verifiedPositionAndStops: {
              positionId: refusal.positionId,
              stopOrderIds: refusal.stopOrderIds,
              stopExecutionProofs: refusal.stopExecutionProofs,
            },
          });
        } catch {
          rememberRecoveryDeferredReason(
            intent, "original_stop_cancel_recovery_store_unavailable",
          );
          return { kind: "unknown" };
        }
        if (settled?.kind === "recovered" || settled?.kind === "replayed") {
          deferredRecoveryReasonByIntent.delete(intent.clientOrderId);
          deferredRecoveryDiagnosticRefByIntent.delete(intent.clientOrderId);
          return {
            kind: "reconciled",
            originalStopCancelPreReadRecoveryBoundary: true,
          };
        }
        rememberRecoveryDeferredReason(
          intent, settled?.reason === "position_changed"
            ? "original_stop_cancel_recovery_compare_and_set_changed"
            : "original_stop_cancel_recovery_compare_and_set_changed",
        );
        return { kind: "unknown" };
      }
      rememberRecoveryDeferredReason(
        intent, refusal.deferredReason ??
          "original_stop_cancel_pre_read_proof_unavailable",
        refusal.diagnosticRef,
      );
      return { kind: "unknown" };
    }
    const runnerCancelRequest = intent.request;
    const runnerCleanup = runnerCancelRequest?.priorPosition?.split?.runnerCleanup;
    const firstRecoveryPhase = runnerCleanup?.childOrderId
      ? `impulse-runner-cancel-recovery-${runnerCleanup.childOrderId}` : null;
    const secondRecoveryPhase = runnerCleanup?.childOrderId
      ? `impulse-runner-cancel-recovery-2-${runnerCleanup.childOrderId}` : null;
    const firstPreTransportRefusal =
      intent.outcome?.submissionError === "BingXLiveApiError" &&
      intent.outcome?.submissionErrorMessage ===
        "VST runner parent order is not an exact verified 20% BE stop fill" &&
      intent.phase === `impulse-runner-cancel-original-${runnerCleanup?.childOrderId}` &&
      runnerCleanup?.recoveryPhase === undefined;
    const fillLinkRefusalMessage =
      "VST runner fill history does not uniquely link to its exact parent stop";
    const exclusiveBoundaryRefusal =
      (intent.outcome?.error === "BingXLiveApiError" &&
        intent.outcome?.errorMessage === fillLinkRefusalMessage ||
        intent.outcome?.submissionError === "BingXLiveApiError" &&
        intent.outcome?.submissionErrorMessage === fillLinkRefusalMessage) &&
      (intent.outcome?.error === undefined ||
        intent.outcome.error === "BingXLiveApiError" &&
        intent.outcome.errorMessage === fillLinkRefusalMessage) &&
      (intent.outcome?.submissionError === undefined ||
        intent.outcome.submissionError === "BingXLiveApiError" &&
        intent.outcome.submissionErrorMessage === fillLinkRefusalMessage) &&
      intent.phase === firstRecoveryPhase &&
      runnerCleanup?.recoveryPhase === firstRecoveryPhase;
    const recoveryAttempt = firstPreTransportRefusal ? 1
      : exclusiveBoundaryRefusal ? 2 : null;
    if (intent.state === "unknown" && recoveryAttempt !== null &&
        runnerCancelRequest?.operation === "cancel_original_after_runner_fill" &&
        validObject(runnerCleanup) &&
        runnerCleanup.stage === "cancel_original_pending" &&
        typeof runnerCleanup.childOrderId === "string" &&
        runnerCleanup.childOrderId.trim() !== "" &&
        intent.clientOrderId === orderId(intent.sourceSignalId, intent.phase) &&
        runnerCancelRequest.sourceSignalId === intent.sourceSignalId &&
        runnerCancelRequest.runnerChildOrderId === runnerCleanup.childOrderId &&
        runnerCancelRequest.positionId === runnerCancelRequest.priorPosition.exchangePositionId &&
        runnerCancelRequest.originalStopOrderId === runnerCleanup.originalStopOrderId &&
        runnerCancelRequest.coreStopOrderId === runnerCleanup.coreStopOrderId) {
      // Each exact adapter refusal is pre-DELETE. The second is the observed
      // exclusive fill-history lower bound, not an ambiguous transport error.
      // No third recovery exists; both require fresh full protection proof.
      if (typeof store.recoverPreTransportRunnerCancel !== "function") {
        return { kind: "unresolved" };
      }
      const fillAt = Date.parse(runnerCleanup.fill?.at);
      const now = Number(clock());
      if (!Number.isFinite(fillAt) || !Number.isFinite(now) ||
          fillAt > now || now - fillAt > 23 * 60 * 60_000 - 1) {
        return { kind: "unresolved" };
      }
      let freshAccountState;
      let freshPosition;
      let persistedRecord;
      try {
        freshAccountState = await broker.readAccountState();
        if (!validObject(freshAccountState) ||
            freshAccountState.verified !== true ||
            freshAccountState.environment !== "vst" ||
            freshAccountState.accountId !== expectedAccountId ||
            !Array.isArray(freshAccountState.positions) ||
            !Array.isArray(freshAccountState.openOrders)) {
          return { kind: "unresolved" };
        }
        persistedRecord = (await store.listOpenPositions()).find((row) =>
          row.sourceSignalId === intent.sourceSignalId);
        if (!validObject(persistedRecord?.snapshot) ||
            persistedRecord.snapshot.status === "unknown" ||
            persistedRecord.snapshot.split?.stage !== "runner_cleanup_pending" ||
            persistedRecord.snapshot.split?.runnerCleanup?.childOrderId !==
              runnerCleanup.childOrderId ||
            persistedRecord.snapshot.split.runnerCleanup.recoveryPhase !==
              (recoveryAttempt === 2 ? firstRecoveryPhase : undefined)) {
          return { kind: "unresolved" };
        }
        const currentPosition = persistedRecord.snapshot;
        const persistedPosition = persistedSplitPosition(currentPosition, freshAccountState);
        if (!persistedPosition) return { kind: "unresolved" };
        freshPosition = await broker.readPosition(currentPosition.symbol, {
          persistedPosition,
          allowProcessCache: false,
        });
        const sameSymbolKey = normalizeSymbolKey(currentPosition.symbol);
        const accountPositions = freshAccountState.positions.filter((row) =>
          normalizeSymbolKey(row?.symbol) === sameSymbolKey);
        const orders = symbolOrders(freshAccountState, currentPosition.symbol);
        const expectedOrderIds = [
          runnerCleanup.originalStopOrderId,
          runnerCleanup.coreStopOrderId,
        ];
        const expectedQuantity = Number(runnerCleanup.remainingQuantity);
        const expectedStopPrice = Number(currentPosition.stopPrice);
        const exactStop = (id) => exactRawSplitStop(currentPosition, freshAccountState, {
          orderId: id,
          quantity: expectedQuantity,
          stopPrice: expectedStopPrice,
        });
        const observedIds = Array.isArray(orders)
          ? orders.map((row) => row.orderId ?? row.orderID).sort()
          : null;
        if (persistedRecord.snapshot.sourceSignalId !== intent.sourceSignalId ||
            persistedRecord.snapshot.symbol !== runnerCancelRequest.symbol ||
            currentPosition.accountId !== expectedAccountId ||
            currentPosition.environment !== "vst" ||
            currentPosition.exchangePositionId !== runnerCancelRequest.positionId ||
            currentPosition.split.runnerCleanup.originalStopOrderId !==
              runnerCancelRequest.originalStopOrderId ||
            currentPosition.split.runnerCleanup.coreStopOrderId !==
              runnerCancelRequest.coreStopOrderId ||
            Number(runnerCancelRequest.signalStopPrice) !== expectedStopPrice ||
            Number(runnerCancelRequest.totalQuantity) !==
              Number(currentPosition.split.totalQuantity) ||
            accountPositions.length !== 1 ||
            accountPositions[0].positionSide !== "LONG" ||
            (accountPositions[0].positionId ?? accountPositions[0].positionID) !==
              currentPosition.exchangePositionId ||
            Number(accountPositions[0].positionAmt) !== expectedQuantity ||
            !validObject(freshPosition) || freshPosition.verified !== true ||
            freshPosition.symbol !== currentPosition.symbol ||
            freshPosition.positionId !== currentPosition.exchangePositionId ||
            Number(freshPosition.quantity) !== expectedQuantity ||
            freshPosition.side !== "Buy" || Number(freshPosition.leverage) !== PROFILE_LEVERAGE ||
            !profileMarginIs(freshPosition.marginMode) ||
            !Number.isFinite(expectedQuantity) || expectedQuantity <= 0 ||
            !Number.isFinite(expectedStopPrice) || expectedStopPrice <= 0 ||
            expectedOrderIds.some((id) => typeof id !== "string" || id.trim() === "") ||
            new Set(expectedOrderIds).size !== 2 ||
            JSON.stringify(observedIds) !== JSON.stringify([...expectedOrderIds].sort()) ||
            !exactStop(runnerCleanup.originalStopOrderId) ||
            !exactStop(runnerCleanup.coreStopOrderId)) {
          return { kind: "unresolved" };
        }
        const recoveryPhase = recoveryAttempt === 2
          ? secondRecoveryPhase : firstRecoveryPhase;
        const recoveryPosition = {
          ...currentPosition,
          status: "closing",
          split: {
            ...currentPosition.split,
            runnerCleanup: {
              ...currentPosition.split.runnerCleanup,
              recoveryPhase,
            },
          },
        };
        const recovery = await store.recoverPreTransportRunnerCancel({
          sourceSignalId: intent.sourceSignalId,
          clientOrderId: intent.clientOrderId,
          expectedRequest: intent.request,
          expectedSnapshot: currentPosition,
          recoveryPhase,
          recoveryPosition,
          recoveryAttempt,
        });
        return recovery?.kind === "recovered" || recovery?.kind === "replayed"
          ? { kind: "reconciled", readOnlyRecoveryBoundary: true }
          : { kind: "unresolved" };
      } catch {
        return { kind: "unresolved" };
      }
    }
    if (intent.phase === "manual_review_close_now") {
      // Reconciled ONLY through the exact same evidence-check-then-ledger-
      // write path closeErrorPositionNow itself uses (store.resolvePositionAsClosed
      // with owner-review provenance) -- never through the generic
      // upsertPosition/setSignalStatus fallback later in this function, which
      // would silently bypass that dedicated write path and its
      // manualResolution provenance marker. This lets a passive tick (not
      // just another owner click) make progress on a transient verification
      // failure, so one slow exchange read can never freeze every other
      // symbol's signals behind an intent nobody happens to retry by hand.
      const outcome = await reconcileManualReviewCloseNow(intent);
      return outcome.kind === "reconciled" ? { kind: "reconciled" } : { kind: "unresolved" };
    }
    if (intent.phase === "manual_review_margin_top_up_close_now") {
      // The margin-top-up-pending counterpart of the "manual_review_close_now"
      // handling above: reconciled ONLY through resolveMarginTopUpPositionAsClosed
      // (which also settles the stuck margin-top-up intent), never through the
      // generic close_leg fallback later in this function -- that fallback
      // would both drop the manualResolution provenance marker AND leave the
      // ORIGINAL margin-top-up intent unresolved, so a transient verification
      // or ledger-write failure here must resolve through the exact same path
      // a fresh owner click uses, not silently downgrade to the generic close.
      const outcome = await reconcileManualReviewCloseNow(intent, {
        resolvePosition: (signalId, args) => store.resolveMarginTopUpPositionAsClosed(signalId, args),
        closeNote: "Закрыто ботом автоматически (кнопка «Закрыть сейчас» — неподтверждённая маржа): рыночная заявка выставлена и подтверждена ботом по биржевым данным.",
      });
      return outcome.kind === "reconciled" ? { kind: "reconciled" } : { kind: "unresolved" };
    }
    if (intent.request?.operation === "margin_top_up" && intent.state === "prepared") {
      if (intent.phase !== "margin-top-up") {
        // Legacy recovery phases might already be prepared on a published
        // worker. Their earlier POST may have succeeded despite a false
        // initialMargin-based failure. Never let a later tick submit them.
        return { kind: "unresolved" };
      }
      if (!allowMarginMutation) return { kind: "unresolved" };
      // Entry commit inserts this prepared follow-up atomically. Marking it
      // submitted is the no-retry boundary: after that transition, a restart
      // can only reconcile reads and must never repeat the margin POST.
      if (typeof store.claimPreparedMarginAddition === "function") {
        if (!await store.claimPreparedMarginAddition(intent)) {
          return { kind: "waiting", reason: "margin_addition_already_claimed" };
        }
      } else {
        await store.markIntent(intent.clientOrderId, "submitted", {
          outcome: { phase: "submission_started" },
        });
      }
      try {
        exchangeActionAttemptedThisTick = true;
        await broker.performIntent({
          clientOrderId: intent.clientOrderId,
          phase: intent.phase,
          request: intent.request,
        });
      } catch (error) {
        const submission = {
          error: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : String(error),
        };
        await store.markIntent(intent.clientOrderId, "unknown", {
          outcome: submission,
        });
        intent.outcome = submission;
      }
    }
    let evidence;
    let reconciliationDiagnostic;
    try {
      evidence = await withVstDiagnosticContext({
        stage: "reconciliation", operation: intent.request?.operation,
        symbol: intent.request?.symbol, sourceSignalId: intent.sourceSignalId,
      }, () => uncertaintyOperation(intent)
        ? reconcileVstUncertaintyEvidence(intent, {
          entry: (input) => broker.reconcileIntent(input),
          raise_stop: (input) => broker.reconcileIntent(input),
          cancel_original_stop: (input) => broker.reconcileIntent(input),
          margin_top_up: (input) => broker.reconcileIntent(input),
          close_pre_runner_split: (input) => broker.reconcileIntent(input),
          source_exit: (input) => broker.reconcileIntent(input),
        })
        : broker.reconcileIntent({
          clientOrderId: intent.clientOrderId,
          phase: intent.phase,
          request: intent.request,
          ...(intent.request?.operation === "raise_stop" && intent.exchangeOrderId
            ? { exchangeOrderId: intent.exchangeOrderId } : {}),
        }));
    } catch (error) {
      reconciliationDiagnostic = recordVstDiagnostic(error, {
        stage: "reconciliation", operation: intent.request?.operation,
        symbol: intent.request?.symbol, sourceSignalId: intent.sourceSignalId,
        check: "intent_reconciliation_read",
      });
      evidence = { verified: false, status: "unknown" };
    }
    if (!isUsableIntentEvidence(evidence)) {
      // A historic GET rejection alone says nothing about whether an earlier
      // MARKET write crossed transport. Preserve the unresolved close rather
      // than treating "order not exist" as permission to submit it again.
      if (await adoptPreRunnerOpenForPendingSourceExit(intent)) {
        return { kind: "reconciled", reason: "pre_runner_open_adopted_for_source_exit" };
      }
      const missingCloseProvenance =
        intent.request?.operation === "close_pre_runner_split" &&
        !exactPreRunnerSplitCloseMutationProvenance(
          intent.outcome?.mutationProvenance,
        );
      rememberRecoveryDeferredReason(intent,
        reconciliationDiagnostic
          ? "unresolved_intent_reconciliation_read_failed"
          : missingCloseProvenance
            ? "close_pre_runner_split_mutation_provenance_missing"
            : "unresolved_intent_evidence_unverified",
        reconciliationDiagnostic?.ref ?? getVstResultDiagnosticRef(evidence));
      // markIntent replaces the outcome column wholesale. The original
      // submission failure (if any) came from reserveAndPerform's catch, or
      // an earlier pass through this same branch; carry it forward so this
      // generic verdict never erases the one clue that explains it.
      const priorError = intent.outcome?.submissionError ?? intent.outcome?.error;
      const priorErrorMessage =
        intent.outcome?.submissionErrorMessage ?? intent.outcome?.errorMessage;
      // Do not lose the proof of a no-POST failure when an exchange read is
      // temporarily unavailable. Otherwise the second tick falls back to
      // the full ambiguous-transport wait despite the original pre-sign
      // refusal never having crossed the mutation boundary.
      const definiteRejection = intent.outcome?.definiteRejection === true;
      const preSignReason = intent.outcome?.preSignReason;
      const mutationProvenance =
        exactOriginalStopCancelMutationProvenance(
          intent.outcome?.mutationProvenance,
        ) ??
        (intent.request?.operation === "close_pre_runner_split"
          ? exactPreRunnerSplitCloseMutationProvenance(
              intent.outcome?.mutationProvenance,
            )
          : null);
      const ambiguousEntryAge = Number(clock()) -
        Number(intent.request?.intentCreatedAt);
      if (intent.request?.operation === "entry" &&
          intent.outcome?.definiteRejection !== true &&
          Number.isFinite(ambiguousEntryAge) &&
          ambiguousEntryAge >= ENTRY_ABANDON_AFTER_MS &&
          typeof broker.proveEntryNotExecuted === "function" &&
          await broker.proveEntryNotExecuted({
            clientOrderId: intent.clientOrderId, request: intent.request,
          })) {
        // Flatness alone cannot retire a possibly sent entry. Only a fresh
        // read-only proof that the exact client order does not exist, has no
        // history row and no fill on the symbol since the intent, and the
        // symbol has no position/orders, retires it -- as an error, never
        // as a fill and never resubmitted. Left unknown it alerted every
        // 30 min forever and kept the symbol quarantined.
        const reason = "entry_unverified_symbol_flat_after_timeout";
        await store.markIntent(intent.clientOrderId, "failed", {
          outcome: {
            reason,
            ...(priorError ? { submissionError: priorError } : {}),
            ...(priorErrorMessage ? { submissionErrorMessage: priorErrorMessage } : {}),
          },
        });
        await store.setSignalStatus(intent.sourceSignalId, "error", reason);
        await store.recordEvent?.(intent.sourceSignalId, "vst_worker_error", { reason });
        return { kind: "failed" };
      }
      if (intent.request?.operation === "entry" &&
          intent.outcome?.definiteRejection === true) {
        // Only the already-classified explicit rejection retains this older
        // terminal-signal path; no expired signal is resubmitted.
        const age = Number(clock()) - Number(intent.request?.intentCreatedAt);
        const abandonAfterMs = intent.outcome?.definiteRejection === true
          ? ENTRY_ABANDON_AFTER_DEFINITE_REJECTION_MS
          : ENTRY_ABANDON_AFTER_MS;
        if (Number.isFinite(age) && age >= abandonAfterMs) {
          if (await confirmedSymbolFlat(intent.request?.symbol)) {
            const reason = "entry_abandoned_confirmed_flat_account";
            await store.markIntent(intent.clientOrderId, "failed", {
              outcome: {
                reason,
                ...(priorError ? { submissionError: priorError } : {}),
                ...(priorErrorMessage ? { submissionErrorMessage: priorErrorMessage } : {}),
              },
            });
            await store.setSignalStatus(intent.sourceSignalId, "error", reason);
            await store.recordEvent?.(intent.sourceSignalId, "vst_worker_error", { reason });
            return { kind: "failed" };
          }
          // Not flat: the fill genuinely happened, but entry evidence
          // (orderEvidence) requires an exact protective-stop match, and a
          // stop that failed to (re)arm after a margin top-up failure will
          // never satisfy that on its own. Left alone this retries
          // identically forever and, via listUnresolvedIntents, permanently
          // blocks every later signal behind it. One fresh, independent read
          // (the same check already trusted for close-abandon decisions)
          // confirms a real matching position before giving up -- this never
          // fabricates a stop or a verified margin state, only records the
          // confirmed request facts already on file plus what this read just
          // observed, and moves the position to "error" for manual review,
          // exactly like the ambiguous close-abandon case.
          const openEvidence = await evaluateCloseAbandonEvidence(intent.request);
          if (openEvidence.outcome === "confirmed_still_open") {
            const reason = "entry_verification_abandoned_confirmed_open_unprotected";
            const signal = intent.request.signal;
            const matchedPosition = openEvidence.matchedPosition;
            const entryPrice = Number(matchedPosition?.avgPrice ?? matchedPosition?.entryPrice);
            const quantity = Number(intent.request.quantity);
            await store.markIntent(intent.clientOrderId, "failed", {
              outcome: {
                reason,
                ...(priorError ? { submissionError: priorError } : {}),
                ...(priorErrorMessage ? { submissionErrorMessage: priorErrorMessage } : {}),
              },
            });
            try {
              // Best-effort: the intent is already marked "failed" above, so
              // the pipeline-unblocking outcome below does not depend on
              // this write succeeding. A malformed/unexpected request shape
              // must not resurrect the permanent-block this whole branch
              // exists to end.
              await store.upsertPosition({
                sourceSignalId: intent.sourceSignalId,
                symbol: intent.request.symbol,
                status: "error",
                patternId: signal?.patternId ?? null,
                environment: "vst",
                accountId: intent.request.accountId ?? null,
                marginMode: intent.request.marginMode ?? PROFILE_MARGIN,
                leverage: PROFILE_LEVERAGE,
                entryClientOrderId: intent.clientOrderId,
                signalAt: signal?.signalAt ?? null,
                signalSnapshot: signal ?? null,
                sizing: intent.request.sizing ?? null,
                quantity,
                remainingQty: quantity,
                // Both shapes are written deliberately: entryPrice is the
                // convention finalizeEntry's own successful-open snapshot
                // uses, while verifiedFill is what the vst-positions and
                // vst-review routes actually read for display. Neither is
                // fabricated -- both come from this same freshly observed
                // exchange fill price.
                ...(Number.isFinite(entryPrice) && entryPrice > 0
                  ? {
                      entryPrice,
                      verifiedFill: { price: entryPrice, quantity, at: Number(clock()) },
                    }
                  : {}),
                marginTopUp: {
                  status: "failed",
                  failureReason: reason,
                  ...(priorError ? { submissionError: priorError } : {}),
                },
              });
            } catch {}
            await store.setSignalStatus(intent.sourceSignalId, "error", reason);
            await store.recordEvent?.(intent.sourceSignalId, "vst_worker_error", { reason });
            return { kind: "failed" };
          }
        }
      } else if (FLAT_ACCOUNT_ABANDON_OPERATIONS.has(intent.request?.operation)) {
        const age = Number(clock()) - Number(intent.request?.intentCreatedAt);
        if (Number.isFinite(age) && age >= OPERATION_ABANDON_AFTER_MS) {
          const operation = intent.request.operation;
          // initialMargin is the original entry margin. It remains unchanged
          // after a successful BingX top-up. Only a confirmed flat position
          // permits abandoning an unresolved adjustment; never turn the
          // unchanged entry field into a false "not applied" verdict.
          if (await confirmedSymbolFlat(intent.request?.symbol)) {
            const reason = `${operation}_abandoned_confirmed_flat_account`;
            await store.markIntent(intent.clientOrderId, "failed", {
              outcome: {
                reason,
                ...(priorError ? { submissionError: priorError } : {}),
                ...(priorErrorMessage ? { submissionErrorMessage: priorErrorMessage } : {}),
              },
            });
            // margin_top_up keeps the same split status handling as every
            // other verdict for this operation elsewhere in this function:
            // the position's own marginTopUp.status (not a generic "error"
            // signal status) is what unblocks runOnce's separate
            // unresolvedMarginTopUp gate, and flagMarginTopUpUnconfirmed
            // already sets the signal to "unknown" for manual review.
            if (operation === "margin_top_up") {
              await failPositionMarginTopUp(intent, reason);
              await flagMarginTopUpUnconfirmed(intent, reason, wasUnknown);
            } else {
              await store.setSignalStatus(intent.sourceSignalId, "error", reason);
              await store.recordEvent?.(intent.sourceSignalId, "vst_worker_error", { reason });
            }
            return { kind: "failed" };
          }
        }
      } else if (intent.request?.operation === "close_pre_runner_split" &&
          exactPreRunnerSplitCloseNoWriteIntent(intent)) {
        if (await recoverPreRunnerSplitCloseNoWrite(intent)) {
          return {
            kind: "failed",
            preRunnerSplitCloseNoWriteBoundary: true,
          };
        }
      } else if (CLOSE_ABANDON_OPERATIONS.has(intent.request?.operation) &&
          !intent.request?.sourceExit &&
          intent.request.operation !== "close_pre_runner_split") {
        const age = Number(clock()) - Number(intent.request?.intentCreatedAt);
        if (Number.isFinite(age) && age >= OPERATION_ABANDON_AFTER_MS) {
          const operation = intent.request.operation;
          const evidence = await evaluateCloseAbandonEvidence(intent.request);
          if (evidence.outcome === "confirmed_still_open") {
            // Proven: this specific close attempt did not execute -- the
            // position still shows its exact pre-close quantity. Safe to
            // give up on this intent alone; nothing was lost, and normal
            // per-tick position management is untouched, so it may attempt
            // a fresh close later if the policy still calls for one.
            const reason = `${operation}_abandoned_confirmed_still_open`;
            await store.markIntent(intent.clientOrderId, "failed", {
              outcome: {
                reason,
                ...(priorError ? { submissionError: priorError } : {}),
                ...(priorErrorMessage ? { submissionErrorMessage: priorErrorMessage } : {}),
              },
            });
            await store.setSignalStatus(intent.sourceSignalId, "error", reason);
            await store.recordEvent?.(intent.sourceSignalId, "vst_worker_error", { reason });
            return { kind: "failed" };
          }
          if (evidence.outcome === "ambiguous") {
            // The read succeeded but does not prove the close never
            // happened: the account may be flat (this operation's own
            // success signal), the matching position may no longer match
            // the expected pre-close quantity, or a suspicious resting
            // order is present. None of that is safe grounds to claim the
            // close succeeded (no verified fill exists to commit) or that
            // it failed (would risk hiding a real close and leaving an
            // already-closed position tracked as open forever). Give up on
            // the INTENT so it stops blocking every later signal, but move
            // the position to the terminal "error" status so no further
            // automated action is taken on it either way, and record a
            // distinct reason so this surfaces for manual reconciliation
            // against the exchange instead of looking like an ordinary
            // resolved intent.
            const reason = `${operation}_abandoned_unconfirmed_outcome`;
            await store.markIntent(intent.clientOrderId, "failed", {
              outcome: {
                reason,
                ...(priorError ? { submissionError: priorError } : {}),
                ...(priorErrorMessage ? { submissionErrorMessage: priorErrorMessage } : {}),
              },
            });
            const records = await store.listOpenPositions();
            const record = records.find((row) => row.sourceSignalId === intent.sourceSignalId);
            if (record) {
              await store.upsertPosition({ ...record.snapshot, status: "error" });
            }
            await store.setSignalStatus(intent.sourceSignalId, "error", reason);
            await store.recordEvent?.(intent.sourceSignalId, "vst_worker_error", { reason });
            return { kind: "failed" };
          }
          // evidence.outcome === "read_unavailable": no trustworthy read
          // this tick, most likely a transient exchange/network hiccup --
          // silence, not evidence about the position. Do not spend this
          // intent's one give-up opportunity on silence, and do not touch
          // the position record. Fall through to the shared "not yet
          // resolved" handling below, exactly as if the abandon timer had
          // not elapsed yet, so the next tick gets a fresh chance to read
          // the account and either confirm, disprove, or abandon then.
        }
      }
      await store.markIntent(intent.clientOrderId, "unknown", {
        outcome: {
          reason: "exchange_state_not_verified",
          uncertainty: classifyVstUncertainty(intent,
            reconciliationDiagnostic ? "read_refused" : "independent_evidence_unavailable"),
          ...(safeStopAcknowledgement(intent.outcome?.acknowledgement)
            ? { acknowledgement: safeStopAcknowledgement(intent.outcome.acknowledgement) }
            : {}),
          ...(priorError ? { submissionError: priorError } : {}),
          ...(priorErrorMessage ? { submissionErrorMessage: priorErrorMessage } : {}),
          ...(definiteRejection ? { definiteRejection: true } : {}),
          ...(preSignReason ? { preSignReason } : {}),
          ...(mutationProvenance ? { mutationProvenance } : {}),
        },
      });
      if (intent.request?.operation === "margin_top_up") {
        await flagMarginTopUpUnconfirmed(
          intent, "vst_margin_top_up_state_not_verified", wasUnknown,
        );
      } else if (!wasUnknown) {
        // Tell the owner once, the first tick this specific intent becomes
        // ambiguous. A later tick that finds it still unresolved must not
        // repeat this -- wasUnknown (captured before this function mutated
        // anything) is exactly the guard already used for margin_top_up above.
        await store.setSignalStatus(intent.sourceSignalId, "unknown", "exchange_state_not_verified");
        await store.recordEvent?.(intent.sourceSignalId, "vst_action_unresolved",
          { reason: "exchange_state_not_verified", operation: uncertaintyOperation(intent) ?? intent.request?.operation ?? null,
            uncertainty: classifyVstUncertainty(intent) });
      }
      return { kind: "unknown" };
    }
    if (evidence.status === "working" || evidence.status === "unknown") {
      await store.markIntent(intent.clientOrderId, "unknown", {
        exchangeOrderId: evidence.exchangeOrderId ?? null,
        outcome: {
          status: evidence.status,
          ...(safeStopAcknowledgement(intent.outcome?.acknowledgement)
            ? { acknowledgement: safeStopAcknowledgement(intent.outcome.acknowledgement) }
            : {}),
          ...(intent.outcome?.submissionError || intent.outcome?.error
            ? { submissionError: intent.outcome.submissionError ?? intent.outcome.error } : {}),
          ...(intent.outcome?.submissionErrorMessage || intent.outcome?.errorMessage
            ? { submissionErrorMessage:
                intent.outcome.submissionErrorMessage ?? intent.outcome.errorMessage } : {}),
          ...(intent.outcome?.definiteRejection === true
            ? { definiteRejection: true } : {}),
          ...(intent.outcome?.preSignReason
            ? { preSignReason: intent.outcome.preSignReason } : {}),
          ...(exactOriginalStopCancelMutationProvenance(
            intent.outcome?.mutationProvenance,
          )
            ? {
                mutationProvenance:
                  exactOriginalStopCancelMutationProvenance(
                    intent.outcome.mutationProvenance,
                  ),
              }
            : {}),
          ...(intent.request?.operation === "close_pre_runner_split" &&
              exactPreRunnerSplitCloseNoWriteProvenance(
                intent.outcome?.mutationProvenance,
              )
            ? {
                mutationProvenance:
                  exactPreRunnerSplitCloseNoWriteProvenance(
                    intent.outcome.mutationProvenance,
                  ),
              }
            : {}),
        },
      });
      if (intent.request?.operation === "margin_top_up") {
        await flagMarginTopUpUnconfirmed(
          intent, "vst_margin_top_up_not_confirmed", wasUnknown,
        );
      } else if (!wasUnknown) {
        await store.setSignalStatus(intent.sourceSignalId, "unknown", "action_fill_unconfirmed");
        await store.recordEvent?.(intent.sourceSignalId, "vst_action_unresolved",
          { reason: "action_fill_unconfirmed", operation: intent.request?.operation ?? null });
      }
      return { kind: "unresolved" };
    }
    if (evidence.status === "rejected") {
      await store.markIntent(intent.clientOrderId, "failed", {
        exchangeOrderId: evidence.exchangeOrderId ?? null,
        outcome: { status: "rejected" },
      });
      if (intent.request?.operation === "margin_top_up") {
        const records = await store.listOpenPositions();
        const record = records.find((row) => row.sourceSignalId === intent.sourceSignalId);
        if (record) {
          await store.upsertPosition({
            ...record.snapshot,
            marginTopUp: {
              ...record.snapshot.marginTopUp,
              status: "failed",
              failureReason: "vst_margin_top_up_rejected",
            },
          });
        }
        await flagMarginTopUpUnconfirmed(
          intent, "vst_margin_top_up_rejected", wasUnknown,
        );
        return { kind: "failed" };
      }
      const reason = "vst_order_rejected";
      await store.setSignalStatus(intent.sourceSignalId, "error", reason);
      await store.recordEvent?.(intent.sourceSignalId, "vst_worker_error",
        { reason, operation: intent.request?.operation ?? null });
      return { kind: "failed" };
    }

    const request = intent.request;
    // Source-driven exits carry their own durable provenance and have stricter
    // fill/flatness/stop-cleanup settlement than an ordinary policy close.
    // Keep this ahead of the generic close_leg fallback: otherwise a restarted
    // source exit can be committed as a policy close and lose its evidence.
    if (request.sourceExit?.stage === "close") {
      try {
        await commitSourceExitClose(intent, request, evidence);
        return { kind: "reconciled", sourceExit: true };
      } catch (error) {
        const reason = error instanceof Error
          ? error.message : "source_exit_close_evidence_not_verified";
        await store.markIntent(intent.clientOrderId, "unknown", {
          exchangeOrderId: evidence.exchangeOrderId ?? null,
          outcome: { reason, sourceExitRequestId: request.sourceExit.requestId },
        });
        await store.setSignalStatus(intent.sourceSignalId, "unknown", reason);
        if (validObject(request.priorPosition)) {
          await store.upsertPosition({
            ...request.priorPosition,
            sourceExitEvidence: request.sourceExit.evidence,
            sourceExitRequestId: request.sourceExit.requestId,
            status: "unknown",
            sourceExitBlockReason: reason,
          });
        }
        return { kind: "unknown", reason };
      }
    }
    if (request.operation === "prepare_margin_mode") {
      try {
        if (request.targetMarginMode !== PROFILE_MARGIN ||
            request.expectedPositionMode !== "HEDGE" ||
            request.requiresFlatAccount !== true ||
            request.requiresNoOpenOrders !== true ||
            !hasConfirmedIsolatedMarginPreparation(evidence, PROFILE)) {
          throw new Error("isolated_margin_preparation_evidence_not_verified");
        }
        const outcome = {
          status: "filled",
          verified: true,
          operation: "prepare_margin_mode",
          positionMode: "HEDGE",
          marginMode: PROFILE_MARGIN,
          accountFlat: true,
          noOpenOrders: true,
        };
        await store.markIntent(intent.clientOrderId, "reconciled", {
          exchangeOrderId: evidence.exchangeOrderId ?? null,
          outcome,
        });
        const signalFresh = isFreshSignalAt(request.signalAt, Number(clock()));
        if (!signalFresh) {
          const reason = "signal_expired_during_margin_mode_preparation";
          await store.setSignalStatus(intent.sourceSignalId, "rejected", reason);
          await store.recordEvent?.(intent.sourceSignalId, "vst_signal_rejected", { reason });
          return { kind: "reconciled", signalExpired: true };
        }
        await store.setSignalStatus(intent.sourceSignalId, "planning");
        await store.recordEvent?.(
          intent.sourceSignalId,
          "vst_margin_mode_preparation_verified",
          outcome,
          intent.clientOrderId,
        );
        return { kind: "reconciled", signalExpired: false };
      } catch (error) {
        const reason = error instanceof Error
          ? error.message : "isolated_margin_preparation_evidence_not_verified";
        await store.markIntent(intent.clientOrderId, "unknown", {
          exchangeOrderId: evidence.exchangeOrderId ?? null,
          outcome: { reason },
        });
        await store.setSignalStatus(intent.sourceSignalId, "error", reason);
        await store.recordEvent?.(intent.sourceSignalId, "vst_worker_error", { reason });
        return { kind: "unknown" };
      }
    }
    if (request.operation === "margin_top_up") {
      try {
        await commitMarginTopUp(intent, evidence);
        return { kind: "reconciled" };
      } catch (error) {
        const reason = error instanceof Error
          ? error.message : "vst_margin_top_up_evidence_not_verified";
        await store.markIntent(intent.clientOrderId, "unknown", {
          exchangeOrderId: evidence.exchangeOrderId ?? null,
          outcome: { reason },
        });
        await flagMarginTopUpUnconfirmed(intent, reason, wasUnknown);
        return { kind: "unknown" };
      }
    }
    if (request.operation === "entry") {
      const finalized = await finalizeEntry(intent, evidence, {
        accountId: brokerCapabilities?.accountId ?? request.accountId,
      });
      return { kind: finalized ? "reconciled" : "unknown" };
    }
    if (["split_core_stop", "split_runner_stop", "cancel_original_stop"]
      .includes(request.operation)) {
      try {
        if (request.operation === "split_runner_stop" &&
            evidence.runnerFillRecovery === true) {
          return await reconcileUnknownRunnerStopFill(intent, evidence);
        }
        if (!validObject(request.priorPosition)) {
          throw new Error("impulse_split_prior_snapshot_missing");
        }
        const nextPosition = nextSplitPosition(
          request.priorPosition,
          request,
          evidence,
        );
        await commitImpulsePhase(intent, request, evidence, nextPosition);
        return { kind: "reconciled" };
      } catch (error) {
        const reason = error instanceof Error
          ? error.message : "impulse_split_phase_unverified";
        await store.markIntent(intent.clientOrderId, "unknown", {
          exchangeOrderId: evidence.exchangeOrderId ?? null,
          outcome: { reason },
        });
        await store.setSignalStatus(intent.sourceSignalId, "unknown", reason);
        if (validObject(request.priorPosition)) {
          await store.upsertPosition({
            ...request.priorPosition,
            sourceSignalId: intent.sourceSignalId,
            status: "unknown",
          });
        }
        return { kind: "unknown" };
      }
    }
    if (request.operation === "split_raise_stop_place") {
      try {
        if (!validObject(request.priorPosition)) {
          throw new Error("impulse_split_upgrade_prior_snapshot_missing");
        }
        await commitSplitUpgradePlace(intent, request, evidence);
        return { kind: "reconciled" };
      } catch (error) {
        const reason = error instanceof Error
          ? error.message : "impulse_split_upgrade_place_unverified";
        await store.markIntent(intent.clientOrderId, "unknown", {
          exchangeOrderId: evidence.exchangeOrderId ?? null,
          outcome: { reason },
        });
        await store.setSignalStatus(intent.sourceSignalId, "unknown", reason);
        if (validObject(request.priorPosition)) {
          await store.upsertPosition({
            ...request.priorPosition,
            sourceSignalId: intent.sourceSignalId,
            status: "unknown",
          });
        }
        return { kind: "unknown" };
      }
    }
    if (request.operation === "split_raise_stop_cancel") {
      try {
        if (!validObject(request.priorPosition)) {
          throw new Error("impulse_split_upgrade_cancel_prior_snapshot_missing");
        }
        await commitSplitUpgradeCancel(intent, request, evidence);
        return { kind: "reconciled" };
      } catch (error) {
        const reason = error instanceof Error
          ? error.message : "impulse_split_upgrade_cancel_unverified";
        await store.markIntent(intent.clientOrderId, "unknown", {
          exchangeOrderId: evidence.exchangeOrderId ?? null,
          outcome: { reason },
        });
        await store.setSignalStatus(intent.sourceSignalId, "unknown", reason);
        if (validObject(request.priorPosition)) {
          await store.upsertPosition({
            ...request.priorPosition,
            sourceSignalId: intent.sourceSignalId,
            status: "unknown",
          });
        }
        return { kind: "unknown" };
      }
    }
    if (request.operation === "close_survivor") {
      try {
        if (!validObject(request.priorPosition) ||
            request.closeIntentId !== intent.clientOrderId) {
          throw new Error("impulse_sole_leg_close_intent_contract_mismatch");
        }
        await commitSurvivorClose(intent, request, evidence);
        return { kind: "reconciled" };
      } catch (error) {
        const reason = error instanceof Error
          ? error.message : "impulse_sole_leg_close_unverified";
        await store.markIntent(intent.clientOrderId, "unknown", {
          exchangeOrderId: evidence.exchangeOrderId ?? null,
          outcome: { reason },
        });
        await store.setSignalStatus(intent.sourceSignalId, "unknown", reason);
        return { kind: "unknown" };
      }
    }
    if (request.operation === "close_split_all" ||
        request.operation === "close_pre_runner_split" ||
        request.operation === "close_leg" && request.fullSplitAbort === true) {
      try {
        if (!validObject(request.priorPosition) ||
            request.closeIntentId !== intent.clientOrderId) {
          throw new Error("impulse_full_split_close_intent_contract_mismatch");
        }
        await commitFullSplitExit(intent, request, evidence);
        return { kind: "reconciled" };
      } catch (error) {
        const reason = error instanceof Error
          ? error.message : "impulse_full_split_close_unverified";
        await store.markIntent(intent.clientOrderId, "unknown", {
          exchangeOrderId: evidence.exchangeOrderId ?? null,
          outcome: { reason },
        });
        await store.setSignalStatus(intent.sourceSignalId, "unknown", reason);
        await store.upsertPosition({
          ...request.priorPosition,
          sourceSignalId: intent.sourceSignalId,
          status: "unknown",
        });
        return { kind: "unknown" };
      }
    }
    if (request.operation === "cancel_flat_split_stop") {
      try {
        if (!validObject(request.priorPosition) ||
            request.cancellationIntentId !== intent.clientOrderId) {
          throw new Error("impulse_flat_stop_cancel_intent_contract_mismatch");
        }
        await commitFlatSplitStopCancellation(intent, request, evidence);
        return { kind: "reconciled" };
      } catch (error) {
        const reason = error instanceof Error
          ? error.message : "impulse_flat_stop_cancel_unverified";
        await store.markIntent(intent.clientOrderId, "unknown", {
          exchangeOrderId: evidence.exchangeOrderId ?? null,
          outcome: { reason },
        });
        await store.setSignalStatus(intent.sourceSignalId, "unknown", reason);
        return { kind: "unknown" };
      }
    }
    if (request.operation === "raise_stop" &&
        request.priorPosition?.patternId === "impulse_buy" &&
        request.priorPosition.coreOpen === true &&
        request.priorPosition.runnerOpen === false) {
      try {
        await commitSoleCoreStopUpgrade(intent, request, evidence);
        return { kind: "reconciled" };
      } catch (error) {
        const reason = error instanceof Error
          ? error.message : "impulse_sole_core_stop_upgrade_unverified";
        await store.markIntent(intent.clientOrderId, "unknown", {
          exchangeOrderId: evidence.exchangeOrderId ?? null,
          outcome: { reason },
        });
        return { kind: "unknown" };
      }
    }
    if (request.operation === "raise_stop") {
      try {
        await commitVerifiedRaiseStop(intent, request, evidence);
        return { kind: "reconciled" };
      } catch (error) {
        const reason = error instanceof Error
          ? error.message : "raise_stop_evidence_not_verified";
        await store.markIntent(intent.clientOrderId, "unknown", {
          exchangeOrderId: evidence.exchangeOrderId ?? intent.exchangeOrderId ?? null,
          outcome: { reason },
        });
        return { kind: "unknown", reason };
      }
    }
    if (request.operation === "cancel_original_after_runner_fill") {
      try {
        if (!validObject(request.priorPosition) ||
            request.intentId !== intent.clientOrderId) {
          throw new Error("impulse_runner_cleanup_intent_contract_mismatch");
        }
        await commitRunnerCleanup(intent, request, evidence);
        return { kind: "reconciled" };
      } catch (error) {
        const reason = error instanceof Error
          ? error.message : "impulse_runner_cleanup_unverified";
        await store.markIntent(intent.clientOrderId, "unknown", {
          exchangeOrderId: evidence.exchangeOrderId ?? null,
          outcome: { reason },
        });
        await store.setSignalStatus(intent.sourceSignalId, "unknown", reason);
        return { kind: "unknown" };
      }
    }
    if (request.operation === "close_leg" &&
        request.signal?.patternId === "impulse_buy") {
      try {
        checkActionEvidence(request, evidence, PROFILE);
        const remaining = Number(request.previousQuantity) - Number(request.quantity);
        const retainedLeg = request.leg === "core" ? "runner" : "core";
        const retained = request[`${retainedLeg}Stop`];
        if (request.exchangeAutoResizeAware !== true ||
            evidence.position.positionId !== request.positionId ||
            evidence.autoResize?.awarenessRequired !== true ||
            Math.abs(Number(evidence.autoResize.observedQuantity) - remaining) >
              Math.max(1e-10, Number(request.previousQuantity) * 1e-8) ||
            evidence.autoResize.retainedStopOrderId !== retained?.orderId ||
            !validObject(request.nextPosition?.pendingClose)) {
          throw new Error("impulse_partial_close_survivor_cleanup_not_verified");
        }
        await store.commitVerifiedIntent({
          sourceSignalId: intent.sourceSignalId,
          clientOrderId: intent.clientOrderId,
          position: confirmedActionPosition(request, evidence),
          signalStatus: "open",
          exchangeOrderId: evidence.exchangeOrderId ?? null,
          outcome: {
            status: "filled",
            verified: true,
            operation: request.operation,
            fill: closeFillSnapshot(evidence),
            autoResize: evidence.autoResize,
            cleanupStage: "cleanup_pending",
          },
          eventKind: "vst_impulse_partial_close_cleanup_pending",
          eventDetail: {
            leg: request.leg,
            quantity: request.quantity,
            remainingQuantity: evidence.autoResize.observedQuantity,
            retainedStopOrderId: evidence.autoResize.retainedStopOrderId,
          },
        });
        return { kind: "reconciled" };
      } catch (error) {
        const reason = error instanceof Error
          ? error.message : "impulse_partial_close_not_verified";
        await store.markIntent(intent.clientOrderId, "unknown", {
          exchangeOrderId: evidence.exchangeOrderId ?? null,
          outcome: { reason },
        });
        await store.setSignalStatus(intent.sourceSignalId, "unknown", reason);
        return { kind: "unknown" };
      }
    }
    if (request.operation === "cancel_split_stop") {
      try {
        const state = request.priorPosition;
        const split = state?.split;
        const closedLeg = request.leg;
        const retainedLeg = closedLeg === "core" ? "runner" : "core";
        const retainedExpected = split?.[`${retainedLeg}Stop`];
        const closedExpected = split?.[`${closedLeg}Stop`];
        const remaining = Number(request.remainingQuantity);
        const position = evidence?.position;
        const retained = evidence?.protectiveStops?.[retainedLeg];
        if (!validObject(state) || split?.stage !== "cleanup_pending" ||
            !validObject(evidence) || evidence.verified !== true ||
            evidence.status !== "filled" || !validObject(position) ||
            position.verified !== true || position.symbol !== request.symbol ||
            position.positionId !== request.positionId ||
            Number(position.quantity) !== remaining ||
            evidence.protectiveStops?.[closedLeg] !== undefined ||
            retained?.verified !== true || retained.orderId !== retainedExpected?.orderId ||
            retained.positionId !== request.positionId ||
            Number(retained.quantity) !== remaining ||
            Number(retained.stopPrice) !== Number(retainedExpected?.stopPrice)) {
          throw new Error("impulse_split_cleanup_exchange_evidence_not_verified");
        }
        const nextPolicy = {
          ...split.pendingClosePolicy, status: "open", remainingQty: remaining,
        };
        const completedSplit = { ...split };
        completedSplit.stage = "complete";
        completedSplit[`${closedLeg}Stop`] = null;
        completedSplit[`${retainedLeg}Stop`] = {
          ...retainedExpected, quantity: String(remaining),
        };
        completedSplit.activeLegs = [retainedLeg];
        completedSplit.baselineOpenOrderIds = [retainedExpected.orderId];
        delete completedSplit.cleanupLeg;
        delete completedSplit.cleanupRemainingQuantity;
        delete completedSplit.pendingClosePolicy;
        const nextPosition = {
          ...state,
          ...nextPolicy,
          status: "open",
          executionStatus: "open",
          split: completedSplit,
          pendingClose: null,
          baselineOpenOrderIds: [...completedSplit.baselineOpenOrderIds],
          coreStopOrderId: retainedLeg === "core" ? retainedExpected.orderId : null,
          coreStopPositionId: retainedLeg === "core" ? request.positionId : null,
          coreStopQuantity: retainedLeg === "core" ? remaining : 0,
          runnerStopOrderId: retainedLeg === "runner" ? retainedExpected.orderId : null,
          runnerStopPositionId: retainedLeg === "runner" ? request.positionId : null,
          runnerStopQuantity: retainedLeg === "runner" ? remaining : 0,
          verifiedProtectiveStops: {
            [retainedLeg]: {
              verified: true, ...completedSplit[`${retainedLeg}Stop`],
            },
          },
        };
        await store.commitVerifiedIntent({
          sourceSignalId: intent.sourceSignalId,
          clientOrderId: intent.clientOrderId,
          position: nextPosition,
          signalStatus: "open",
          exchangeOrderId: evidence.exchangeOrderId ?? null,
          outcome: {
            status: "filled", verified: true, operation: request.operation,
            canceledStopOrderId: closedExpected.orderId,
            retainedStopOrderId: retainedExpected.orderId,
            remainingQuantity: String(remaining), splitStage: "complete",
          },
          eventKind: "vst_impulse_split_cleanup_verified",
          eventDetail: {
            closedLeg, retainedLeg, canceledStopOrderId: closedExpected.orderId,
            retainedStopOrderId: retainedExpected.orderId,
            remainingQuantity: String(remaining),
          },
        });
        return { kind: "reconciled" };
      } catch (error) {
        const reason = error instanceof Error
          ? error.message : "impulse_split_cleanup_not_verified";
        await store.markIntent(intent.clientOrderId, "unknown", {
          exchangeOrderId: evidence.exchangeOrderId ?? null,
          outcome: { reason },
        });
        await store.setSignalStatus(intent.sourceSignalId, "unknown", reason);
        return { kind: "unknown" };
      }
    }
    try {
      checkActionEvidence(request, evidence, PROFILE);
      if (request.operation === "close_leg" &&
          request.signal?.patternId === "impulse_buy") {
        const remaining = Number(request.previousQuantity) - Number(request.quantity);
        const retainedLeg = request.leg === "core" ? "runner" : "core";
        const retained = request[`${retainedLeg}Stop`];
        if (request.exchangeAutoResizeAware !== true ||
            evidence.position.positionId !== request.positionId ||
            evidence.autoResize?.awarenessRequired !== true ||
            Math.abs(Number(evidence.autoResize.observedQuantity) - remaining) >
              Math.max(1e-10, Number(request.previousQuantity) * 1e-8) ||
            evidence.autoResize.retainedStopOrderId !== retained?.orderId ||
            !validObject(request.nextPosition?.pendingClose)) {
          throw new Error("impulse_partial_close_survivor_cleanup_not_verified");
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "exchange_action_state_not_verified";
      await store.markIntent(intent.clientOrderId, "unknown", {
        exchangeOrderId: evidence.exchangeOrderId ?? null,
        outcome: { reason },
      });
      await store.setSignalStatus(intent.sourceSignalId, "unknown", reason);
      return { kind: "unknown" };
    }
    if (request.nextPolicy) {
      if (request.protectedExit) {
        const prior = await store.getPosition(intent.sourceSignalId);
        if (JSON.stringify(prior?.snapshot) !== JSON.stringify(request.priorPosition) ||
            typeof store.commitVerifiedIntent !== "function") {
          throw new Error("protected_exit_position_changed_before_commit");
        }
        const account = await broker.readAccountState();
        const orders = symbolOrders(account, request.symbol);
        if (!account?.verified || account.environment !== "vst" ||
            account.accountId !== request.accountId ||
            !flatPositionFromAccountState(account, request.symbol) ||
            !Array.isArray(orders)) {
          throw new Error("protected_exit_flatness_not_verified");
        }
        const stops = request.protectedExit.ownedStops;
        const ids = exactOrderIds(orders);
        const remaining = stops.filter(stop => ids?.includes(stop.orderId));
        if (!ids || ids.length !== remaining.length ||
            !exactOwnedSourceExitStops(request.priorPosition, account, remaining)) {
          throw new Error("protected_exit_remaining_orders_not_owned");
        }
        const position = confirmedActionPosition(request, evidence);
        position.protectedExit = request.protectedExit;
        position.split = {
          ...(position.split ?? {}), positionId: request.positionId,
          entryOrderId: request.entryOrderId,
          stage: ids.length ? "flat_cleanup_pending" : "closed",
          remainingKnownStopOrderIds: ids,
          flatCleanupStops: remaining.map(stop => ({ ...stop, tranche: "core" })),
        };
        // Keep residual-stop work reachable by listOpenPositions. The fill and
        // zero remaining quantity are facts; "closing" denotes cleanup only.
        position.status = ids.length ? "closing" : "closed";
        await store.commitVerifiedIntent({
          sourceSignalId: intent.sourceSignalId, clientOrderId: intent.clientOrderId,
          position, signalStatus: position.status, exchangeOrderId: evidence.exchangeOrderId,
          expectedPositionSnapshot: prior.snapshot,
          expectedPositionUpdatedAt: prior.updatedAt,
          outcome: { status: "filled", verified: true, operation: "close_leg",
            fill: closeFillSnapshot(evidence), cleanupRequired: ids.length > 0 },
          eventKind: "vst_protected_strategy_exit_verified",
          eventDetail: { reason: request.reason, fill: closeFillSnapshot(evidence),
            originalClientOrderId: request.protectedExit.originalClientOrderId,
            remainingKnownStopOrderIds: ids },
        });
        return { kind: "reconciled", operation: "protected_strategy_exit" };
      }
      await store.upsertPosition(confirmedActionPosition(request, evidence));
      await store.setSignalStatus(
        intent.sourceSignalId,
        request.nextPolicy.status === "closed" ? "closed" : "open",
      );
    }
    await store.markIntent(intent.clientOrderId, "reconciled", {
      exchangeOrderId: evidence.exchangeOrderId ?? null,
      outcome: {
        status: "filled",
        verified: true,
        operation: request.operation,
        ...(request.operation === "close_leg"
          ? {
              fill: closeFillSnapshot(evidence),
              residualProtectiveStops: evidence.protectiveStops ??
                evidence.position.protectiveStops ?? {},
            }
          : {}),
      },
    });
    await store.recordEvent?.(intent.sourceSignalId, "vst_action_reconciled", {
      phase: intent.phase, operation: request.operation,
    }, intent.clientOrderId);
    return { kind: "reconciled" };
  }

  async function prepareMarginTopUpFollowUp(intent, request, evidence, fill, capabilities) {
    // Cross margin: the whole account backs the position; nothing to top up.
    if (PROFILE_MARGIN !== "ISOLATED") return null;
    if (typeof store.commitVerifiedIntent !== "function") {
      throw new Error("vst_margin_top_up_requires_atomic_entry_commit");
    }
    if (typeof broker.readMarginTopUpPlan !== "function") {
      throw new Error("vst_margin_top_up_live_plan_unavailable");
    }
    const position = evidence.position;
    const originalStop = evidence.protectiveStops?.core;
    const baseline = await broker.readMarginTopUpPlan({
      environment: "vst",
      accountId: capabilities.accountId,
      symbol: request.symbol,
      positionId: position.positionId,
      entryOrderId: evidence.exchangeOrderId,
      quantity: fill.quantity,
      stopLoss: request.signal.stopLoss,
    });
    if (!validObject(baseline) || baseline.verified !== true ||
        baseline.environment !== "vst" || baseline.accountId !== capabilities.accountId ||
        baseline.symbol !== request.symbol || baseline.positionId !== position.positionId ||
        baseline.entryOrderId !== evidence.exchangeOrderId ||
        Math.abs(Number(baseline.quantity) - Number(fill.quantity)) >
          Math.max(1e-10, Number(fill.quantity) * 1e-8) ||
        !Number.isFinite(Number(baseline.isolatedMarginBefore)) ||
        Number(baseline.isolatedMarginBefore) <= 0 ||
        !validObject(baseline.protectiveStop) ||
        baseline.protectiveStop.orderId !== originalStop?.orderId ||
        baseline.protectiveStop.positionId !== position.positionId ||
        Number(baseline.protectiveStop.stopPrice) !== Number(request.signal.stopLoss) ||
        Math.abs(Number(baseline.protectiveStop.quantity) - Number(fill.quantity)) >
          Math.max(1e-10, Number(fill.quantity) * 1e-8) ||
        baseline.protectiveStop.status !== "NEW" ||
        baseline.protectiveStop.workingType !== "MARK_PRICE") {
      throw new Error("vst_margin_top_up_baseline_or_original_stop_not_verified");
    }
    if (baseline.amount === null) return null;
    // The entry-time estimate is NOT an approval ceiling. BingX can demand
    // a larger minimum increment after the position exists, and its actual
    // liquidation price is authoritative. Persist the fresh amount before
    // crossing the one-shot exchange write boundary.
    const amount = positive(baseline.amount, "live protective margin amount");
    const approvedAmount = String(baseline.amount);
    const phase = "margin-top-up";
    const clientOrderId = orderId(intent.sourceSignalId, phase);
    const intentCreatedAt = Number(clock());
    if (!Number.isSafeInteger(intentCreatedAt) || intentCreatedAt <= 0) {
      throw new Error("vst_margin_top_up_intent_timestamp_invalid");
    }
    const topUpRequest = {
      operation: "margin_top_up",
      environment: "vst",
      accountId: capabilities.accountId,
      symbol: request.symbol,
      positionId: position.positionId,
      entryOrderId: evidence.exchangeOrderId,
      quantity: fill.quantity,
      stopLoss: request.signal.stopLoss,
      stopOrderId: originalStop.orderId,
      expectedIsolatedMarginBefore: String(baseline.isolatedMarginBefore),
      amount: approvedAmount,
      approvedTopUpMargin: approvedAmount,
      intentCreatedAt,
    };
    return {
      phase,
      clientOrderId,
      sourceSignalId: intent.sourceSignalId,
      request: topUpRequest,
      marker: {
        status: "pending",
        amount: approvedAmount,
        liquidationPriceBefore: baseline.liquidationBefore,
        minimumIncreaseMargin: baseline.minimum,
        requiredBuffer: baseline.buffer,
        expectedIsolatedMarginBefore: topUpRequest.expectedIsolatedMarginBefore,
        intentCreatedAt: topUpRequest.intentCreatedAt,
        quantity: topUpRequest.quantity,
        stopLoss: topUpRequest.stopLoss,
        positionId: position.positionId,
        entryOrderId: evidence.exchangeOrderId,
        stopOrderId: originalStop.orderId,
      },
    };
  }

  async function flagMarginTopUpUnconfirmed(
    intent,
    reason,
    wasUnknown = intent.state === "unknown",
  ) {
    await store.setSignalStatus(intent.sourceSignalId, "unknown", reason);
    if (!wasUnknown) {
      await store.recordEvent?.(
        intent.sourceSignalId,
        "vst_margin_top_up_unconfirmed",
        {
          reason,
          amount: intent.request?.amount ?? intent.request?.sizing?.plannedTopUpVst,
          positionId: intent.request?.positionId ?? null,
          entryOrderId: intent.request?.entryOrderId ?? null,
          submissionErrorMessage: (
            intent.outcome?.submissionErrorMessage ??
            intent.outcome?.errorMessage ?? null
          )?.slice(0, 500) ?? null,
          exchangePositionMayRemainOpen: true,
          uncertainty: classifyVstUncertainty(intent),
        },
      );
    }
  }

  async function commitMarginTopUp(intent, evidence, { recoverFailed = false } = {}) {
    const request = intent.request;
    if (!marginTopUpEvidenceMatches(request, evidence)) {
      throw new Error("vst_margin_top_up_delta_position_or_original_stop_not_verified");
    }
    // Margin delta by itself does not prove that liquidation moved below the
    // original stop. Read the exchange again before releasing position
    // management. A failed read is an unknown outcome, never a safe position.
    if (typeof broker.readMarginTopUpProtection !== "function") {
      throw new Error("vst_margin_top_up_post_funding_risk_read_unavailable");
    }
    const protection = await broker.readMarginTopUpProtection(request);
    if (protection?.verified !== true ||
        protection.positionId !== request.positionId ||
        protection.protectiveStop?.orderId !== request.stopOrderId ||
        protection.protectiveStop?.status !== "NEW") {
      throw new Error("vst_margin_top_up_post_funding_position_changed");
    }
    const riskSafe = protection.safe === true;
    const records = recoverFailed ? await store.listErrorPositions() : await store.listOpenPositions();
    const record = records.find((row) =>
      row.sourceSignalId === intent.sourceSignalId &&
      row.snapshot?.environment === "vst" &&
      row.snapshot?.accountId === request.accountId &&
      row.snapshot?.exchangePositionId === request.positionId);
    if (!record || (recoverFailed
      ? record.snapshot?.marginTopUp?.status !== "failed" ||
        record.snapshot.marginTopUp.failureReason !==
          "margin_top_up_abandoned_confirmed_not_applied" ||
        record.snapshot.marginTopUp.manualResolution
      : record.snapshot?.marginTopUp?.status !== "pending")) {
      throw new Error("vst_margin_top_up_pending_position_snapshot_not_found");
    }
    // The production store rejects undefined values rather than silently
    // dropping them as JSON.stringify would. A successful top-up must remove
    // a prior failure marker entirely, not persist it with value undefined.
    const { failureReason: _oldFailureReason, ...priorMarginTopUp } =
      record.snapshot.marginTopUp;
    const position = {
      ...record.snapshot,
      status: riskSafe ? "open" : "error",
      marginTopUp: {
        ...priorMarginTopUp,
        status: "verified",
        protectionStatus: riskSafe ? "liquidation_below_stop_buffer" : "unsafe_after_funding",
        liquidationPriceAfter: protection.liquidationPrice,
        isolatedMarginBefore: evidence.isolatedMarginBefore,
        isolatedMarginAfter: evidence.isolatedMarginAfter,
        marginDelta: evidence.marginDelta,
        marginHistory: evidence.marginHistory,
        attribution: evidence.marginHistory.attribution,
        verifiedAt: Number(clock()),
      },
    };
    const outcome = {
      status: "filled",
      verified: true,
      operation: "margin_top_up",
      symbol: evidence.symbol,
      positionId: evidence.positionId,
      quantity: String(evidence.quantity),
      amount: String(evidence.amount),
      isolatedMarginBefore: String(evidence.isolatedMarginBefore),
      isolatedMarginAfter: String(evidence.isolatedMarginAfter),
      marginDelta: String(evidence.marginDelta),
      marginHistory: evidence.marginHistory,
      attribution: evidence.marginHistory.attribution,
      protectiveStop: evidence.protectiveStop,
      liquidationPriceAfter: protection.liquidationPrice,
      protectionVerified: riskSafe,
    };
    const isImpulse = position.patternId === "impulse_buy" && strategyAuthority !== "source";
    return store.commitVerifiedIntent({
      sourceSignalId: intent.sourceSignalId,
      clientOrderId: intent.clientOrderId,
      position,
      signalStatus: riskSafe ? (isImpulse ? "opening" : "open") : "unknown",
      exchangeOrderId: evidence.exchangeOrderId ?? null,
      outcome,
      recoverFailedMarginTopUp: recoverFailed,
      eventKind: riskSafe
        ? "vst_margin_top_up_verified" : "vst_margin_top_up_funded_but_unsafe",
      eventDetail: {
        symbol: request.symbol,
        positionId: request.positionId,
        amount: request.amount,
        isolatedMarginBefore: outcome.isolatedMarginBefore,
        isolatedMarginAfter: outcome.isolatedMarginAfter,
        marginDelta: outcome.marginDelta,
        stopOrderId: request.stopOrderId,
        stopLoss: request.stopLoss,
        protectionVerified: riskSafe,
        liquidationPriceAfter: protection.liquidationPrice,
        requiredBuffer: protection.buffer,
      },
    });
  }

  async function finalizeEntry(intent, evidence, capabilities) {
    const request = intent.request;
    const signal = request.signal;
    if (signal.patternId === "impulse_buy" && strategyAuthority !== "source") {
      let verifiedFill;
      let split;
      let pendingPosition;
      let marginTopUp;
      let priceAudit;
      try {
        verifiedFill = checkEntryEvidence(signal, evidence, PROFILE);
        priceAudit = entryPriceAudit(signal, request.sizing, verifiedFill);
        marginTopUp = await prepareMarginTopUpFollowUp(
          intent, request, evidence, verifiedFill, capabilities,
        );
        split = request.impulseSplit;
        if (!validObject(split) ||
            decimalUnits(split.totalQuantity, split.quantityPrecision,
              "impulse_split_total_quantity") !==
              decimalUnits(verifiedFill.quantity, split.quantityPrecision,
                "impulse_fill_quantity") ||
            decimalUnits(evidence.position.quantity, split.quantityPrecision,
              "impulse_position_quantity") !==
              decimalUnits(split.totalQuantity, split.quantityPrecision,
                "impulse_split_total_quantity") ||
            decimalUnits(evidence.protectiveStops.core.quantity, split.quantityPrecision,
              "impulse_original_stop_quantity") !==
              decimalUnits(split.totalQuantity, split.quantityPrecision,
                "impulse_split_total_quantity") ||
            typeof evidence.exchangeOrderId !== "string" ||
            evidence.exchangeOrderId.trim() === "") {
          throw new Error("impulse_entry_or_exact_split_quantity_not_verified");
        }
        const policy = createVstPolicy({ signal, fill: verifiedFill });
        const createdAt = Number(clock());
        if (!Number.isSafeInteger(createdAt) || createdAt <= 0) {
          throw new Error("impulse_split_created_at_invalid");
        }
        const originalStop = evidence.protectiveStops.core;
        pendingPosition = {
          sourceSignalId: intent.sourceSignalId,
          symbol: signal.symbol,
          patternId: "impulse_buy",
          status: "closing",
          executionStatus: "impulse_split_core_pending",
          environment: "vst",
          accountId: capabilities.accountId,
          marginMode: PROFILE_MARGIN,
          leverage: PROFILE_LEVERAGE,
          entryOrderType: request.entryOrderType,
          entryClientOrderId: intent.clientOrderId,
          entryOrderId: evidence.exchangeOrderId,
          signalSnapshot: signal,
          exchangePositionId: evidence.position.positionId,
          verifiedFill,
          ...(priceAudit ? { priceAudit } : {}),
          sizing: request.sizing,
          ...(marginTopUp ? { marginTopUp: marginTopUp.marker } : {}),
          originalStopOrderId: originalStop.orderId,
          originalStopPositionId: originalStop.positionId,
          originalStopQuantity: Number(originalStop.quantity),
          signalStopPrice: String(signal.stopLoss),
          actualEntryBreakEvenPrice: String(verifiedFill.price),
          baselineOpenOrderIds: [originalStop.orderId],
          split: {
            stage: "core_pending",
            totalQuantity: split.totalQuantity,
            coreQuantity: split.coreQuantity,
            runnerQuantity: split.runnerQuantity,
            quantityPrecision: split.quantityPrecision,
            pricePrecision: split.pricePrecision,
            minQuantity: split.minQuantity,
            signalStopPrice: String(signal.stopLoss),
            breakEvenPrice: String(verifiedFill.price),
            actualEntryBreakEvenPrice: String(verifiedFill.price),
            positionId: evidence.position.positionId,
            entryOrderId: evidence.exchangeOrderId,
            originalStopOrderId: originalStop.orderId,
            baselineOpenOrderIds: [originalStop.orderId],
            createdAt,
            coreStop: null,
            runnerStop: null,
          },
          policy: {
            ...policy,
            coreQty: Number(split.coreQuantity),
            runnerQty: Number(split.runnerQuantity),
            runnerStopPrice: policy.runnerStopPrice,
          },
          version: policy.version,
          entryPrice: policy.entryPrice,
          entryAt: policy.entryAt,
          signalAt: policy.signalAt,
          quantity: policy.quantity,
          remainingQty: policy.remainingQty,
          stopPrice: policy.stopPrice,
          peakPct: policy.peakPct,
          coreQty: Number(split.coreQuantity),
          coreOpen: true,
          runnerQty: Number(split.runnerQuantity),
          runnerOpen: true,
          runnerStopPrice: policy.runnerStopPrice,
          runnerPeakPct: policy.runnerPeakPct,
          observationWindowNoted: policy.observationWindowNoted,
        };
        pendingPosition.persistedPosition = persistedSplitPosition(
          pendingPosition, await broker.readAccountState(),
        );
        if (!pendingPosition.persistedPosition) {
          throw new Error("impulse_entry_persisted_position_snapshot_not_verified");
        }
      } catch (error) {
        const reason = error instanceof Error
          ? error.message : "impulse_entry_or_split_contract_not_verified";
        const wasUnknown = intent.state === "unknown";
        await store.markIntent(intent.clientOrderId, "unknown", {
          exchangeOrderId: evidence.exchangeOrderId ?? null,
          outcome: { reason },
        });
        if (Number(request.sizing?.plannedTopUpVst) > 0) {
          await flagMarginTopUpUnconfirmed(intent, reason, wasUnknown);
        } else {
          await store.setSignalStatus(intent.sourceSignalId, "unknown", reason);
          await store.recordEvent?.(intent.sourceSignalId, "vst_worker_error", { reason });
        }
        return false;
      }
      const outcome = {
        status: "filled",
        verified: true,
        operation: "entry",
        positionId: evidence.position.positionId,
        entryOrderId: evidence.exchangeOrderId,
        originalStopOrderId: evidence.protectiveStops.core.orderId,
        totalQuantity: split.totalQuantity,
        coreQuantity: split.coreQuantity,
        runnerQuantity: split.runnerQuantity,
        splitStage: "core_pending",
      };
      if (typeof store.commitVerifiedIntent !== "function") {
        await store.markIntent(intent.clientOrderId, "unknown", {
          exchangeOrderId: evidence.exchangeOrderId ?? null,
          outcome: { reason: "impulse_atomic_split_ledger_unavailable" },
        });
        await store.setSignalStatus(
          intent.sourceSignalId, "unknown", "impulse_atomic_split_ledger_unavailable",
        );
        return false;
      }
      await store.commitVerifiedIntent({
        sourceSignalId: intent.sourceSignalId,
        clientOrderId: intent.clientOrderId,
        position: pendingPosition,
        signalStatus: "opening",
        exchangeOrderId: evidence.exchangeOrderId ?? null,
        outcome,
        eventKind: marginTopUp
          ? "vst_impulse_entry_margin_top_up_pending"
          : "vst_impulse_entry_verified_split_pending",
        eventDetail: {
          positionId: evidence.position.positionId,
          entryOrderId: evidence.exchangeOrderId,
          signalReferencePrice: request.sizing.signalReferencePrice,
          planningQuotePrice: request.sizing.quotePrice,
          planningQuoteObservedAt: priceAudit?.planningQuoteObservedAt ?? null,
          signalPriceDeviationPct: request.sizing.signalPriceDeviationPct,
          verifiedFillPrice: verifiedFill.price,
          verifiedFillAt: verifiedFill.at,
          actualFillDeviationPct: priceAudit?.actualFillDeviationPct ?? null,
          originalStopOrderId: evidence.protectiveStops.core.orderId,
          totalQuantity: split.totalQuantity,
          coreQuantity: split.coreQuantity,
          runnerQuantity: split.runnerQuantity,
          splitStage: "core_pending",
          ...(marginTopUp ? { marginTopUpVst: marginTopUp.marker.amount } : {}),
        },
        ...(marginTopUp ? {
          followUpIntent: {
            sourceSignalId: intent.sourceSignalId,
            phase: marginTopUp.phase,
            clientOrderId: marginTopUp.clientOrderId,
            request: marginTopUp.request,
          },
        } : {}),
      });
      return true;
    }
    let fill;
    let marginTopUp;
    try {
      fill = checkEntryEvidence(signal, evidence, PROFILE);
      marginTopUp = await prepareMarginTopUpFollowUp(
        intent, request, evidence, fill, capabilities,
      );
    } catch (error) {
      const reason = error instanceof Error
        ? error.message : "vst_margin_top_up_baseline_not_verified";
      const wasUnknown = intent.state === "unknown";
      await store.markIntent(intent.clientOrderId, "unknown", {
        exchangeOrderId: evidence.exchangeOrderId ?? null,
        outcome: { reason },
      });
      if (Number(request.sizing?.plannedTopUpVst) > 0) {
        await flagMarginTopUpUnconfirmed(intent, reason, wasUnknown);
      } else {
        await store.setSignalStatus(intent.sourceSignalId, "unknown", reason);
        await store.recordEvent?.(intent.sourceSignalId, "vst_worker_error", { reason });
      }
      return false;
    }
    const policy = createVstPolicy({ signal, fill });
    if (strategyAuthority === "source") {
      // The source supplied one position and its initial full-quantity stop,
      // not an independent 80/20 runner strategy.
      Object.assign(policy, { coreQty: Number(fill.quantity), coreOpen: true,
        runnerQty: 0, runnerOpen: false, runnerStopPrice: null });
    }
    const priceAudit = entryPriceAudit(signal, request.sizing, fill);
    const coreStop = evidence.protectiveStops.core;
    const position = {
      sourceSignalId: intent.sourceSignalId,
      symbol: signal.symbol,
      status: "open",
      ...policy,
      exchangePositionId: evidence.position.positionId,
      entryOrderId: evidence.exchangeOrderId,
      coreStopOrderId: coreStop.orderId,
      coreStopPositionId: coreStop.positionId,
      coreStopQuantity: Number(coreStop.quantity),
      coreStopStartedAt: Number(clock()),
      verifiedProtectiveStops: { core: coreStop },
      sizing: request.sizing,
      ...(priceAudit ? { priceAudit } : {}),
      ...(marginTopUp ? { marginTopUp: marginTopUp.marker } : {}),
      marginMode: PROFILE_MARGIN,
      leverage: PROFILE_LEVERAGE,
      environment: "vst",
      accountId: capabilities.accountId,
      entryOrderType: request.entryOrderType,
      entryClientOrderId: intent.clientOrderId,
      strategyAuthority,
    };
    const outcome = {
      status: "filled",
      verified: true,
      fillPrice: fill.price,
      fillQuantity: fill.quantity,
      positionId: evidence.position.positionId,
      stopOrderId: coreStop.orderId,
      stopQuantity: Number(coreStop.quantity),
    };
    const eventDetail = {
      fillPrice: fill.price,
      fillQuantity: fill.quantity,
      signalReferencePrice: request.sizing.signalReferencePrice,
      planningQuotePrice: request.sizing.quotePrice,
      planningQuoteObservedAt: priceAudit?.planningQuoteObservedAt ?? null,
      signalPriceDeviationPct: request.sizing.signalPriceDeviationPct,
      verifiedFillPrice: fill.price,
      verifiedFillAt: fill.at,
      actualFillDeviationPct: priceAudit?.actualFillDeviationPct ?? null,
      initialStop: signal.stopLoss,
      quantity: request.sizing.quantity,
      initialMarginVst: request.sizing.initialMarginVst,
      leverage: PROFILE_LEVERAGE,
      marginMode: PROFILE_MARGIN,
      environment: "vst",
    };
    if (typeof store.commitVerifiedIntent === "function") {
      await store.commitVerifiedIntent({
        sourceSignalId: intent.sourceSignalId,
        clientOrderId: intent.clientOrderId,
        position,
        signalStatus: marginTopUp ? "opening" : "open",
        exchangeOrderId: evidence.exchangeOrderId ?? null,
        outcome,
        eventKind: marginTopUp ? "vst_entry_margin_top_up_pending" : "vst_entry_verified",
        eventDetail,
        ...(marginTopUp ? {
          followUpIntent: {
            sourceSignalId: intent.sourceSignalId,
            phase: marginTopUp.phase,
            clientOrderId: marginTopUp.clientOrderId,
            request: marginTopUp.request,
          },
        } : {}),
      });
    } else {
      await store.upsertPosition(position);
      await store.markIntent(intent.clientOrderId, "reconciled", {
        exchangeOrderId: evidence.exchangeOrderId ?? null,
        outcome,
      });
      await store.setSignalStatus(intent.sourceSignalId, "open");
      await store.recordEvent?.(
        intent.sourceSignalId, "vst_entry_verified", eventDetail, intent.clientOrderId,
      );
    }
    return true;
  }

  let urgentReconciliationCursor = null;
  let routineReconciliationCursor = null;
  let preparedMarginReconciliationCursor = null;

  async function reconcileOutstanding(capabilities, allowMarginMutation = false) {
    const intents = await store.listUnresolvedIntents();
    let reconciledPreRunnerClose = false;
    let reconciledRunnerFillCleanup = false;
    let recoveredOriginalStopCancelRunnerFill = false;
    let recoveredPreTransportRunnerCancel = false;
    let recoveredPreRunnerSplitCloseNoWrite = false;
    let recoveredRaiseStopEntryProofRefusal = false;
    let recoveredRaiseStopCommittedClose = false;
    let adoptedUnlinkedRaiseStopProtection = false;
    let recoveredOriginalStopCancelPreReadRefusal = false;
    let reconciledMarginPreparation = false;
    let reconciledMarginTopUp = false;
    let expiredMarginPreparation = false;

    const observeTriggeredStopKey = (intent) =>
      intent?.request?.operation === "observe_triggered_stop";
    const eligibleIntents = intents.filter((intent) =>
      !observeTriggeredStopKey(intent) &&
      !sourceExitPrerequisiteAttemptsThisTick.has(
        reconciliationIntentKey(intent),
      ));
    const urgent = eligibleIntents.filter(isExposureCriticalIntent);
    const attemptedKeys = new Set();
    let marginMutationAttempted = false;
    let exchangeMutationAttempted = false;

    const recordResult = (intent, result) => {
      if (intent.request?.operation === "close_pre_runner_split" &&
          result.kind === "reconciled") {
        reconciledPreRunnerClose = true;
      }
      if (intent.request?.operation === "split_runner_stop" &&
          result.kind === "acted" && result.operation === "observe_triggered_stop" &&
          result.leg === "runner") {
        reconciledRunnerFillCleanup = true;
      }
      if (result?.originalStopCancelRunnerFillRecoveryBoundary === true) {
        reconciledRunnerFillCleanup = true;
        recoveredOriginalStopCancelRunnerFill = true;
      }
      if (result?.readOnlyRecoveryBoundary === true) {
        recoveredPreTransportRunnerCancel = true;
      }
      if (result?.raiseStopRefusalRecoveryBoundary === true) {
        recoveredRaiseStopEntryProofRefusal = true;
      }
      if (result?.raiseStopClosedFillRecoveryBoundary === true) {
        recoveredRaiseStopCommittedClose = true;
      }
      if (result?.unlinkedProtectionAdoptionBoundary === true) {
        adoptedUnlinkedRaiseStopProtection = true;
      }
      if (result?.originalStopCancelPreReadRecoveryBoundary === true) {
        recoveredOriginalStopCancelPreReadRefusal = true;
      }
      if (result?.preRunnerSplitCloseNoWriteBoundary === true) {
        recoveredPreRunnerSplitCloseNoWrite = true;
      }
      if (intent.request?.operation === "prepare_margin_mode" &&
          result.kind === "reconciled") {
        reconciledMarginPreparation = true;
        expiredMarginPreparation ||= result.signalExpired === true;
      }
      if (intent.request?.operation === "margin_top_up" &&
          result.kind === "reconciled") {
        reconciledMarginTopUp = true;
      }
    };

    const orderedUrgent = rotateStableIntents(
      urgent, urgentReconciliationCursor,
    );
    for (const urgentIntent of orderedUrgent.slice(
      0, MAX_URGENT_INTENT_RECONCILIATIONS_PER_TICK,
    )) {
      const key = reconciliationIntentKey(urgentIntent);
      urgentReconciliationCursor = key;
      attemptedKeys.add(key);
      const result = await reconcileOne(
        urgentIntent, capabilities, false,
      );
      recordResult(urgentIntent, result);
      // Reconciliation normally reads only, but if a future recovery path
      // reports that it attempted a venue mutation, stop here and make the
      // post-mutation account refresh a hard boundary for this tick.
      if (result?.exchangeMutationAttempted === true) {
        exchangeMutationAttempted = true;
        break;
      }
      if (recoveredPreTransportRunnerCancel ||
          recoveredPreRunnerSplitCloseNoWrite ||
          recoveredRaiseStopEntryProofRefusal ||
          recoveredRaiseStopCommittedClose ||
          adoptedUnlinkedRaiseStopProtection ||
          recoveredOriginalStopCancelPreReadRefusal ||
          recoveredOriginalStopCancelRunnerFill) break;
    }
    if (recoveredPreTransportRunnerCancel ||
        recoveredPreRunnerSplitCloseNoWrite ||
        recoveredRaiseStopEntryProofRefusal ||
        recoveredRaiseStopCommittedClose ||
        adoptedUnlinkedRaiseStopProtection ||
        recoveredOriginalStopCancelPreReadRefusal ||
        recoveredOriginalStopCancelRunnerFill) {
      const unresolved = await store.listUnresolvedIntents();
      return {
        unresolved,
        reconciledPreRunnerClose,
        reconciledRunnerFillCleanup,
        recoveredPreTransportRunnerCancel,
        recoveredPreRunnerSplitCloseNoWrite,
        recoveredRaiseStopEntryProofRefusal,
        recoveredRaiseStopCommittedClose,
        adoptedUnlinkedRaiseStopProtection,
        recoveredOriginalStopCancelPreReadRefusal,
        recoveredOriginalStopCancelRunnerFill,
        reconciledMarginPreparation,
        reconciledMarginTopUp,
        expiredMarginPreparation,
        marginMutationAttempted: false,
        exchangeMutationAttempted: false,
        deferredIntentCount: Math.max(0, unresolved.length -
          unresolved.filter((intent) => attemptedKeys.has(
            reconciliationIntentKey(intent),
          )).length),
      };
    }

    // Keep an unresolved critical order/stop on its own symbol fail-closed,
    // but never let a different symbol's intent globally suppress an
    // independently protected margin follow-up.
    const afterUrgent = await store.listUnresolvedIntents();
    const unresolvedUrgent = afterUrgent
      .filter((intent) => !observeTriggeredStopKey(intent) &&
        isExposureCriticalIntent(intent));
    const preparedMarginIntents = eligibleIntents.filter((intent) =>
      intent.request?.operation === "margin_top_up" &&
      intent.state === "prepared" &&
      !attemptedKeys.has(reconciliationIntentKey(intent)));
    const preparedMarginCanProceed = (intent) => allowMarginMutation &&
      !unresolvedUrgent.some((urgentIntent) => {
        const urgentSymbol = normalizeSymbolKey(urgentIntent.request?.symbol);
        const marginSymbol = normalizeSymbolKey(intent.request?.symbol);
        // An urgent intent without a symbol remains account-wide fail-closed.
        return !urgentSymbol || !marginSymbol || urgentSymbol === marginSymbol;
      });
    const eligiblePreparedMargins = preparedMarginIntents.filter(
      preparedMarginCanProceed,
    );
    const submittedOrUnknownMarginIntents = eligibleIntents.filter((intent) =>
      intent.request?.operation === "margin_top_up" &&
      ["submitted", "unknown"].includes(intent.state) &&
      !attemptedKeys.has(reconciliationIntentKey(intent)));
    const routine = eligibleIntents.filter((intent) =>
      !isExposureCriticalIntent(intent) &&
      intent.request?.operation !== "margin_top_up" &&
      !attemptedKeys.has(reconciliationIntentKey(intent)) &&
      intent.state !== "prepared");

    // A submitted/unknown margin intent gets its own rotating read slot on
    // every tick. A stream of newly prepared top-ups must not starve exchange
    // confirmation of already-open positions.
    if (!exchangeMutationAttempted && submittedOrUnknownMarginIntents.length) {
      const intent = rotateStableIntents(
        submittedOrUnknownMarginIntents, routineReconciliationCursor,
      )[0];
      const key = reconciliationIntentKey(intent);
      attemptedKeys.add(key);
      routineReconciliationCursor = key;
      const result = await reconcileOne(intent, capabilities, false);
      recordResult(intent, result);
      exchangeMutationAttempted ||= result?.exchangeMutationAttempted === true;
    }

    // Also service non-margin preparation/recovery reads when present. This
    // is a separate bounded slot so the mandatory margin-history pass above
    // cannot permanently starve them.
    const remainingRoutine = routine.filter((intent) =>
      !attemptedKeys.has(reconciliationIntentKey(intent)));
    if (!exchangeMutationAttempted && remainingRoutine.length) {
      const intent = rotateStableIntents(
        remainingRoutine, routineReconciliationCursor,
      )[0];
      const key = reconciliationIntentKey(intent);
      attemptedKeys.add(key);
      routineReconciliationCursor = key;
      const result = await reconcileOne(intent, capabilities, false);
      recordResult(intent, result);
      exchangeMutationAttempted ||= result?.exchangeMutationAttempted === true;
    }

    // A prepared top-up is the only write admitted in this bounded pass.
    // Existing urgent exposure on the same symbol (or an unscoped intent)
    // keeps that symbol fail-closed, but does not suppress an independent one.
    if (!exchangeMutationAttempted && eligiblePreparedMargins.length) {
      const intent = rotateStableIntents(
        eligiblePreparedMargins, preparedMarginReconciliationCursor,
      )[0];
      const key = reconciliationIntentKey(intent);
      attemptedKeys.add(key);
      preparedMarginReconciliationCursor = key;
      marginMutationAttempted = true;
      const result = await reconcileOne(intent, capabilities, true);
      recordResult(intent, result);
      exchangeMutationAttempted ||= result?.exchangeMutationAttempted === true;
    }
    const unresolved = await store.listUnresolvedIntents();
    return {
      unresolved,
      reconciledPreRunnerClose,
      reconciledRunnerFillCleanup,
      recoveredPreTransportRunnerCancel,
      recoveredPreRunnerSplitCloseNoWrite,
      recoveredRaiseStopEntryProofRefusal,
      recoveredOriginalStopCancelPreReadRefusal,
      reconciledMarginPreparation,
      reconciledMarginTopUp,
      expiredMarginPreparation,
      marginMutationAttempted,
      exchangeMutationAttempted,
      deferredIntentCount: Math.max(0, unresolved.length -
        unresolved.filter((intent) => attemptedKeys.has(
          reconciliationIntentKey(intent),
        )).length),
    };
  }

  async function resumeExchangeVerifiedFailedEntries() {
    if (typeof store.listRecoverableFailedEntries !== "function" ||
        typeof store.resumeVerifiedFailedEntry !== "function") return;
    const candidates = await store.listRecoverableFailedEntries();
    for (const intent of candidates) {
      // A retired entry is NEVER performed again. Read its exact original
      // client ID, fills, live position, and matching stop before changing
      // only the durable bookkeeping state. The ordinary reconciliation
      // pass then rechecks all evidence before committing it atomically.
      let evidence;
      try {
        evidence = await broker.reconcileIntent({
          clientOrderId: intent.clientOrderId,
          phase: intent.phase,
          request: intent.request,
        });
      } catch {
        continue;
      }
      if (evidence?.verified !== true || evidence.status !== "filled" ||
          !evidence.exchangeOrderId || !evidence.position?.positionId ||
          evidence.protectiveStops?.core?.verified !== true) continue;
      if (await store.resumeVerifiedFailedEntry(intent.clientOrderId)) return;
    }
  }

  async function prepareOneFailedMarginTopUpRecovery(capabilities) {
    if (typeof store.listRecoverableFailedMarginTopUps !== "function" ||
        typeof store.prepareFailedMarginTopUpRecovery !== "function" ||
        typeof broker.readMarginTopUpPlan !== "function") return;
    const candidates = [
      ...await store.listRecoverableFailedMarginTopUps(),
      ...(typeof store.listRecoverableFailedPermissionMarginTopUps === "function"
        ? await store.listRecoverableFailedPermissionMarginTopUps() : []),
    ];
    for (const record of candidates) {
      const original = record.failedIntent?.request;
      const permissionRecovery =
        record.recoveryPhase === "margin-top-up-permission-recovery";
      if (!original || original.accountId !== capabilities?.accountId ||
          original.environment !== "vst" ||
          (permissionRecovery && (
            record.failedIntent?.outcome?.reason !==
              "margin_top_up_abandoned_confirmed_not_applied" ||
            record.failedIntent?.outcome?.submissionErrorMessage !==
              "BingX live writes are disabled: explicit permission was not granted"
          )) ||
          record.snapshot?.marginTopUp?.manualResolution) continue;
      let plan;
      try {
        plan = await broker.readMarginTopUpPlan(original);
      } catch {
        // No mutation without a fresh, fully identified position, its
        // original stop, a liquidation price, exchange minimum, and balance.
        continue;
      }
      if (plan?.verified !== true || plan.accountId !== original.accountId ||
          plan.environment !== "vst" || plan.symbol !== original.symbol ||
          plan.positionId !== original.positionId ||
          plan.entryOrderId !== original.entryOrderId ||
          plan.protectiveStop?.orderId !== original.stopOrderId ||
          String(plan.quantity) !== String(original.quantity) ||
          Number(plan.protectiveStop.stopPrice) !== Number(original.stopLoss) ||
          plan.protectiveStop.status !== "NEW" ||
          plan.protectiveStop.workingType !== "MARK_PRICE" ||
          Number(plan.isolatedMarginBefore) !==
            Number(original.expectedIsolatedMarginBefore) ||
          !plan.amount) continue;
      const phase = permissionRecovery
        ? "margin-top-up-permission-recovery" : "margin-top-up-recovery";
      const clientOrderId = orderId(record.sourceSignalId, phase);
      const request = {
        ...original,
        amount: String(plan.amount),
        approvedTopUpMargin: String(plan.amount),
        intentCreatedAt: Number(clock()),
      };
      const { failureReason: _oldFailureReason, ...priorMarginTopUp } =
        record.snapshot.marginTopUp;
      const marker = {
        ...priorMarginTopUp,
        status: "pending",
        amount: String(plan.amount),
        liquidationPriceBefore: plan.liquidationBefore,
        minimumIncreaseMargin: plan.minimum,
        requiredBuffer: plan.buffer,
      };
      if (await store.prepareFailedMarginTopUpRecovery({
        sourceSignalId: record.sourceSignalId, clientOrderId, request, marker,
        recoveryPhase: phase,
      })) return;
    }
  }

  async function recoverOneSubmittedFailedMarginTopUp() {
    if (typeof store.listFailedSubmittedMarginTopUps !== "function") return false;
    for (const row of await store.listFailedSubmittedMarginTopUps()) {
      const intent = row.failedIntent;
      if (!intent || intent.request?.environment !== "vst" ||
          intent.request?.operation !== "margin_top_up") continue;
      // Strictly read-only until the original adjustment and its surviving
      // position/stop have been independently corroborated. Never create
      // another exchange intent or repeat the margin POST here.
      const evidence = await broker.reconcileIntent(intent);
      if (evidence?.verified !== true || evidence.status !== "filled" ||
          !marginTopUpEvidenceMatches(intent.request, evidence)) continue;
      try {
        await commitMarginTopUp(intent, evidence, { recoverFailed: true });
        return true;
      } catch {
        // Keep the terminal record available for another read-only check.
        // Never reinterpret a failed verification as permission to resend.
      }
    }
    return false;
  }

  async function openSignal(
    row, capabilities, readCapabilities = null, planningInputHint = null,
    batchExecution = false, batchBudget = null,
  ) {
    if (await urgentWorkPending()) return urgentYield();
    let signal = row.body;
    const entryBlock = typeof signal?.sourceSignalId === "string" && entryGuard
      ? await entryGuard(signal.sourceSignalId) : false;
    if (entryBlock === "maintenance") return { kind: "waiting", reason: "owner_reset_in_progress",
      sourceSignalId: signal.sourceSignalId, symbol: signal.symbol };
    if (entryBlock) {
      const prior = await store.getIntent(signal.sourceSignalId, "market-entry");
      if (!prior || prior.state === "failed") {
        await store.setSignalStatus(signal.sourceSignalId, "rejected", "source_entry_cancelled");
        return { kind: "rejected", reason: "source_entry_cancelled" };
      }
      return { kind: "waiting", reason: "source_command_entry_reconciliation_pending" };
    }
    const now = Number(clock());
    if (!validObject(signal) ||
        typeof signal.sourceSignalId !== "string" ||
        !isTradablePatternId(signal.patternId) ||
        signal.confirmationStatus !== "confirmed" ||
        signal.side !== "buy" ||
        signal.orderType !== "market" ||
        signal.payload?.rulesVersion !== "bullet-long-exits-v2" ||
        !isFreshSignalAt(signal.signalAt, now)) {
      const reason = "not_a_fresh_approved_v2_long";
      await store.setSignalStatus(row.sourceSignalId, "rejected", reason);
      await store.recordEvent?.(row.sourceSignalId, "vst_signal_rejected", { reason });
      return { kind: "rejected", reason };
    }
    if (!isCanonicalVstSymbol(signal.symbol)) {
      const reason = "invalid_canonical_vst_symbol";
      await store.setSignalStatus(signal.sourceSignalId, "rejected", reason);
      await store.recordEvent?.(signal.sourceSignalId, "vst_signal_rejected", { reason });
      return { kind: "rejected", reason };
    }
    if (signal.patternId === "impulse_buy" &&
        typeof store.commitVerifiedIntent !== "function") {
      const reason = "impulse_split_requires_atomic_verified_intent_commit";
      await store.setSignalStatus(signal.sourceSignalId, "rejected", reason);
      await store.recordEvent?.(signal.sourceSignalId, "vst_signal_rejected", { reason });
      return { kind: "rejected", reason };
    }
    const impulseCapability = capabilities.missingCapabilities?.find?.((item) =>
      item?.capability === "impulse_runner_stop_and_partial_close");
    if (signal.patternId === "impulse_buy" &&
        (impulseCapability ||
         !Array.isArray(capabilities.features) ||
         !capabilities.features.includes("impulse_runner_stop_and_partial_close"))) {
      const reason = "unsupported_vst_protective_capabilities:impulse_runner_stop_and_partial_close";
      await store.setSignalStatus(signal.sourceSignalId, "rejected", reason);
      await store.recordEvent?.(signal.sourceSignalId, "vst_signal_rejected", { reason });
      return { kind: "rejected", reason };
    }

    await store.setSignalStatus(signal.sourceSignalId, "planning");
    try {
      let input;
      try {
        input = planningInputHint ?? await broker.readPlanningInputs(signal);
      } catch (error) {
        if (error?.code === "vst_symbol_currently_offline") {
          const reason = error.exchangeMessage
            ? `vst_symbol_currently_offline:${error.exchangeMessage}`
            : "vst_symbol_currently_offline";
          await store.setSignalStatus(signal.sourceSignalId, "rejected", reason);
          await store.recordEvent?.(signal.sourceSignalId, "vst_signal_rejected", { reason });
          return { kind: "rejected", reason };
        }
        throw error;
      }
      const marginPreparationRequired =
        ["ISOLATED", "CROSSED"].includes(input?.marginMode) &&
        input.marginMode !== PROFILE_MARGIN &&
        input.marginModeVerified === false &&
        input.requiresIsolatedMarginPreparation === true;
      const alreadyIsolatedAndVerified =
        input?.marginMode === PROFILE_MARGIN &&
        input.marginModeVerified === true &&
        input.requiresIsolatedMarginPreparation === false;
      if (!marginPreparationRequired && !alreadyIsolatedAndVerified) {
        const reason = "vst_margin_mode_state_not_verified_or_preparable";
        await store.setSignalStatus(signal.sourceSignalId, "rejected", reason);
        await store.recordEvent?.(signal.sourceSignalId, "vst_signal_rejected", { reason });
        return { kind: "rejected", reason };
      }
      const limits = {
        environment: "vst",
        symbol: signal.symbol,
        balanceSnapshot: input.balanceSnapshot,
        quote: input.quote,
        // The signed planning reads happen after signal validation; using
        // that earlier clock would make a fresh exchange quote appear future.
        nowMs: Number(clock()),
        maxQuoteAgeMs: sizingLimits.maxQuoteAgeMs,
        expectedPrice: signal.referencePrice,
        maxSlippageBps: sizingLimits.maxSlippageBps,
        stopLoss: signal.stopLoss,
        filters: input.filters,
        takerFeeRate: input.risk?.takerFeeRate,
        fundingRate: input.risk?.fundingRate,
        maintenanceMarginRate: input.risk?.maintenanceMarginRate,
        stopBufferRate: input.risk?.stopBufferRate,
        tickSize: input.risk?.tickSize,
        maxPositionValue: input.risk?.maxPositionValue,
        quantityUnitMultiple: strategyAuthority !== "source" && signal.patternId === "impulse_buy" ? 5 : 1,
        positionProfile: PROFILE,
      };
      const sizing = sizeVstLongTrade(limits);
      // Keep the source signal immutable in the ledger, but carry the
      // executable, exchange-precision stop through every durable intent and
      // subsequent verification/policy path.
      signal = { ...signal, stopLoss: sizing.stopLoss };
      if (sizing.status !== "ready") {
        const reason = sizing.blockers.join(",");
        await store.setSignalStatus(signal.sourceSignalId, "rejected", reason);
        await store.recordEvent?.(signal.sourceSignalId, "vst_signal_rejected", { reason });
        return { kind: "rejected", reason };
      }
      let impulseSplit = null;
      if (strategyAuthority !== "source" && signal.patternId === "impulse_buy") {
        try {
          impulseSplit = exactImpulseSplit(
            sizing.quantity, input.filters, input.quote.price,
          );
        } catch (error) {
          const reason = error instanceof Error
            ? error.message : "impulse_split_sizing_not_verified";
          await store.setSignalStatus(signal.sourceSignalId, "rejected", reason);
          await store.recordEvent?.(signal.sourceSignalId, "vst_signal_rejected", { reason });
          return { kind: "rejected", reason };
        }
      }
      // The owner explicitly accepted the bounded VST-only risk between
      // protected entry and verified post-fill margin top-up. Keep the exact
      // signal stop and persist the follow-up intent atomically at fill commit.
      // Policy validation is deliberately performed before any broker write.
      createVstPolicy({
        signal,
        fill: { price: input.quote.price, quantity: sizing.quantity, at: new Date(now).toISOString() },
      });
      const accountState = await broker.readAccountState();
      if (!validObject(accountState) ||
          accountState.verified !== true ||
          batchExecution &&
            (accountState.environment !== "vst" ||
             accountState.accountId !== capabilities.accountId) ||
          !Array.isArray(accountState.positions) ||
          !Array.isArray(accountState.openOrders)) {
        throw new Error("account_state_not_verified");
      }
      // Scoped to THIS signal's own symbol: a different symbol's position or
      // order is independent exposure, not evidence this entry is unsafe.
      const entrySymbolKey = normalizeSymbolKey(signal.symbol);
      const entrySymbolHasExposure = accountState.positions.some((row) =>
        normalizeSymbolKey(row?.symbol) === entrySymbolKey) ||
        accountState.openOrders.some((row) => normalizeSymbolKey(row?.symbol) === entrySymbolKey);
      if (entrySymbolHasExposure) {
        const reason = "preexisting_exchange_position_or_order";
        await store.setSignalStatus(signal.sourceSignalId, "rejected", reason);
        await store.recordEvent?.(signal.sourceSignalId, "vst_signal_rejected", { reason });
        return { kind: "rejected", reason };
      }
      if (batchExecution) {
        const available = Number(sizing.availableMarginVst);
        const required = Number(sizing.requiredAvailableVst);
        const allocated = Number(sizing.allocatedMarginVst);
        if (!Number.isFinite(available) || available < 0 ||
            !Number.isFinite(required) || required <= 0 ||
            !Number.isFinite(allocated) || allocated <= 0 ||
            required < allocated ||
            !batchBudget || !Number.isFinite(batchBudget.reservedAvailableVst) ||
            batchBudget.reservedAvailableVst < 0 ||
            required > available - batchBudget.reservedAvailableVst) {
          await store.setSignalStatus(
            signal.sourceSignalId, "pending",
            "vst_entry_batch_available_margin_unverified_or_reserved",
          );
          return {
            kind: "waiting",
            reason: "vst_entry_batch_available_margin_unverified_or_reserved",
          };
        }
        // Reserve the exact sizing engine requirement (initial margin, top-up
        // and fee reserve) before any durable phase can cross a write boundary.
        batchBudget.reservedAvailableVst += required;
      }

      if (batchExecution && sourceExitsEnabled) {
        // Capabilities/planning/account reads can take many paced requests.
        // Recheck after those reads, not just before starting the phase.
        try {
          if ((await readPendingSourceExitRequests()).length) {
            return { kind: "waiting",
              reason: "source_exit_priority_before_entry_batch_phase" };
          }
        } catch {
          return { kind: "waiting", reason: "source_exit_queue_unavailable" };
        }
      }

      if (marginPreparationRequired) {
        if (await urgentWorkPending()) return urgentYield();
        const request = {
          operation: "prepare_margin_mode",
          accountId: capabilities.accountId,
          environment: "vst",
          symbol: signal.symbol,
          targetMarginMode: PROFILE_MARGIN,
          expectedPositionMode: "HEDGE",
          requiresFlatAccount: true,
          requiresNoOpenOrders: true,
          signalAt: signal.signalAt,
        };
        const preparation = await reserveAndPerform(
          signal.sourceSignalId, "isolated-margin-mode", request,
        );
        if (preparation.kind !== "submitted") {
          const reason = "isolated_margin_preparation_requires_reconciliation";
          await store.setSignalStatus(signal.sourceSignalId, "unknown", reason);
          return { kind: "unknown", reason };
        }
        let evidence;
        try {
          evidence = await broker.reconcileIntent({
            clientOrderId: preparation.clientOrderId,
            phase: "isolated-margin-mode",
            request,
          });
        } catch {
          evidence = { verified: false, status: "unknown" };
        }
        if (!hasConfirmedIsolatedMarginPreparation(evidence, PROFILE)) {
          if (validObject(evidence) && evidence.verified === true &&
              evidence.status === "rejected") {
            await store.markIntent(preparation.clientOrderId, "failed", {
              exchangeOrderId: evidence.exchangeOrderId ?? null,
              outcome: { status: "rejected" },
            });
            await store.setSignalStatus(
              signal.sourceSignalId, "error", "isolated_margin_preparation_rejected",
            );
            return { kind: "error", reason: "isolated_margin_preparation_rejected" };
          }
          const reason = "isolated_margin_preparation_evidence_not_verified";
          await store.markIntent(preparation.clientOrderId, "unknown", {
            exchangeOrderId: evidence?.exchangeOrderId ?? null,
            outcome: { reason },
          });
          await store.setSignalStatus(signal.sourceSignalId, "unknown", reason);
          return { kind: "unknown", reason };
        }
        const outcome = {
          status: "filled",
          verified: true,
          operation: "prepare_margin_mode",
          positionMode: "HEDGE",
          marginMode: PROFILE_MARGIN,
          accountFlat: true,
          noOpenOrders: true,
        };
        await store.markIntent(preparation.clientOrderId, "reconciled", {
          exchangeOrderId: evidence.exchangeOrderId ?? null,
          outcome,
        });
        await store.recordEvent?.(
          signal.sourceSignalId,
          "vst_margin_mode_preparation_verified",
          outcome,
          preparation.clientOrderId,
        );
        if (!isFreshSignalAt(signal.signalAt, Number(clock()))) {
          const reason = "signal_expired_during_margin_mode_preparation";
          await store.setSignalStatus(signal.sourceSignalId, "rejected", reason);
          await store.recordEvent?.(signal.sourceSignalId, "vst_signal_rejected", { reason });
          return { kind: "rejected", reason };
        }
        await store.setSignalStatus(signal.sourceSignalId, "planning");
        return { kind: "prepared", reason: "isolated_margin_mode_confirmed" };
      }

      if (await urgentWorkPending()) return urgentYield();
      const leverageRequest = {
        operation: "set_isolated_leverage",
        accountId: capabilities.accountId,
        symbol: signal.symbol,
        leverage: PROFILE_LEVERAGE,
        marginMode: PROFILE_MARGIN,
        environment: "vst",
      };
      const leverage = await reserveAndPerform(
        signal.sourceSignalId, "isolated-leverage-10", leverageRequest,
      );
      if (leverage.kind !== "submitted" &&
          !(leverage.kind === "existing" && leverage.intent?.state === "reconciled")) {
        await store.setSignalStatus(signal.sourceSignalId, "unknown", "leverage_intent_requires_reconciliation");
        return { kind: "unknown", reason: "leverage_intent_requires_reconciliation" };
      }
      const leverageEvidence = await broker.reconcileIntent({
        clientOrderId: leverage.clientOrderId,
        phase: "isolated-leverage-10",
        request: leverageRequest,
      });
      if (leverageEvidence?.verified !== true ||
          leverageEvidence.status !== "filled" ||
          !profileMarginIs(leverageEvidence.position?.marginMode) ||
          Number(leverageEvidence.position?.leverage) !== PROFILE_LEVERAGE) {
        await store.markIntent(leverage.clientOrderId, "unknown", {
          outcome: { reason: "isolated_10x_not_confirmed" },
        });
        await store.setSignalStatus(signal.sourceSignalId, "unknown", "isolated_10x_not_confirmed");
        return { kind: "unknown", reason: "isolated_10x_not_confirmed" };
      }
      if (leverage.kind === "submitted") {
        await store.markIntent(leverage.clientOrderId, "reconciled", {
          exchangeOrderId: leverageEvidence.exchangeOrderId ?? null,
          outcome: { verified: true, marginMode: PROFILE_MARGIN, leverage: PROFILE_LEVERAGE },
        });
        await store.setSignalStatus(signal.sourceSignalId, "planning");
        return { kind: "prepared", reason: "isolated_leverage_confirmed" };
      }

      if (await urgentWorkPending()) return urgentYield();
      const request = {
        operation: "entry",
        entryOrderType: "MARKET",
        accountId: capabilities.accountId,
        environment: "vst",
        symbol: signal.symbol,
        side: "Buy",
        quantity: sizing.quantity,
        maxEntryPrice: sizing.maxEntryPrice,
        entrySizingPolicy: "fresh-before-sign-v1",
        refreshSizing: {
          maxQuoteAgeMs: sizingLimits.maxQuoteAgeMs,
          maxSlippageBps: sizingLimits.maxSlippageBps,
          expectedPrice: signal.referencePrice,
          quantityUnitMultiple: signal.patternId === "impulse_buy" ? 5 : 1,
        },
        marginMode: PROFILE_MARGIN,
        leverage: PROFILE_LEVERAGE,
        stopLoss: signal.stopLoss,
        sizing,
        ...(Number(sizing.plannedTopUpVst) > 0
          ? { approvedTopUpMargin: String(sizing.plannedTopUpVst) }
          : {}),
        ...(impulseSplit ? { impulseSplit } : {}),
        signal,
      };
      await store.setSignalStatus(signal.sourceSignalId, "opening");
      const entry = await reserveAndPerform(signal.sourceSignalId, "market-entry", request);
      if (entry.kind === "rejected") {
        return { kind: "rejected", reason: entry.reason };
      }
      if (entry.kind !== "submitted") {
        await store.setSignalStatus(signal.sourceSignalId, "unknown", "entry_intent_requires_reconciliation");
        return { kind: "unknown", reason: "entry_intent_requires_reconciliation" };
      }
      const evidence = await broker.reconcileIntent({
        clientOrderId: entry.clientOrderId, phase: "market-entry", request,
      });
      if (!isUsableIntentEvidence(evidence)) {
        await store.markIntent(entry.clientOrderId, "unknown", {
          outcome: { reason: "entry_result_not_verified" },
        });
        await store.setSignalStatus(signal.sourceSignalId, "unknown", "entry_result_not_verified");
        // This is this intent's first-ever mark-unknown (it was just reserved
        // a few lines up), so there is no earlier notification to duplicate.
        await store.recordEvent?.(signal.sourceSignalId, "vst_action_unresolved",
          { reason: "entry_result_not_verified", operation: "entry" });
        return { kind: "unknown", reason: "entry_result_not_verified" };
      }
      if (evidence.status === "working" || evidence.status === "unknown") {
        await store.markIntent(entry.clientOrderId, "unknown", {
          exchangeOrderId: evidence.exchangeOrderId ?? null,
          outcome: { status: evidence.status },
        });
        await store.setSignalStatus(signal.sourceSignalId, "unknown", "entry_fill_unconfirmed");
        await store.recordEvent?.(signal.sourceSignalId, "vst_action_unresolved",
          { reason: "entry_fill_unconfirmed", operation: "entry" });
        return { kind: "unknown", reason: "entry_fill_unconfirmed" };
      }
      if (evidence.status === "rejected") {
        await store.markIntent(entry.clientOrderId, "failed", {
          exchangeOrderId: evidence.exchangeOrderId ?? null, outcome: { status: "rejected" },
        });
        await store.setSignalStatus(signal.sourceSignalId, "rejected", "entry_rejected_by_vst_venue");
        return { kind: "rejected", reason: "entry_rejected_by_vst_venue" };
      }
      const finalized = await finalizeEntry({
        sourceSignalId: signal.sourceSignalId,
        clientOrderId: entry.clientOrderId,
        phase: "market-entry",
        request,
      }, evidence, capabilities);
      if (!finalized) {
        return { kind: "unknown", reason: "entry_or_post_fill_margin_state_not_verified" };
      }
      if (await store.getIntent(signal.sourceSignalId, "margin-top-up")) {
        return { kind: "top_up_pending", reason: "vst_margin_top_up_follow_up_prepared" };
      }
      if (signal.patternId !== "impulse_buy" || strategyAuthority === "source") {
        return { kind: "opened" };
      }
      return await continueImpulseSplitPhases(
        signal.sourceSignalId,
        readCapabilities ?? capabilities,
        Boolean(capabilities),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 500) : "vst_execution_error";
      await store.setSignalStatus(signal.sourceSignalId, "error", reason);
      await store.recordEvent?.(signal.sourceSignalId, "vst_worker_error", { reason });
      return { kind: "error", reason };
    }
  }

  async function continueImpulseSplitPhases(
    sourceSignalId, capabilities, allowActions,
  ) {
    let lastOutcome = null;
    let expectedNextStage = null;
    // Keep the post-entry chain bounded to the three durable split phases.
    // Each advance performs a new account, exact-position, and stop preflight;
    // no exchange snapshot is reused across writes.
    for (let phase = 0; phase < MAX_POST_ENTRY_SPLIT_PHASES; phase += 1) {
      let record;
      try {
        const records = await store.listOpenPositions();
        record = records.find((row) => row.sourceSignalId === sourceSignalId);
      } catch {
        return {
          kind: "waiting",
          reason: "impulse_split_ledger_read_unavailable",
          sourceSignalId,
        };
      }
      if (!validObject(record?.snapshot) ||
          record.status === "unknown" ||
          record.snapshot.status === "unknown") {
        return {
          kind: "unknown",
          reason: "impulse_post_entry_split_state_unverified",
          sourceSignalId,
          symbol: record?.symbol,
        };
      }
      if (!["open", "opening", "closing"].includes(record.status)) {
        return lastOutcome ?? {
          kind: "waiting",
          reason: "impulse_split_position_status_changed",
          sourceSignalId,
          symbol: record.symbol,
        };
      }
      if (sourceExitsEnabled) {
        let sourceRequests;
        try {
          sourceRequests = await readPendingSourceExitRequests();
        } catch {
          return {
            kind: "waiting",
            reason: "source_exit_queue_unavailable",
            sourceSignalId,
            symbol: record.symbol,
          };
        }
        const symbolKey = normalizeSymbolKey(record.symbol);
        const relevantRequests = sourceRequests.filter((row) =>
          row?.sourceSignalId === sourceSignalId ||
          (symbolKey && normalizeSymbolKey(row?.symbol) === symbolKey));
        if (relevantRequests.length) {
          const sourceResult = await processPendingSourceExits(
            relevantRequests, capabilities,
          );
          return sourceResult ?? {
            kind: "waiting",
            reason: "source_exit_priority_before_impulse_split",
            sourceSignalId,
            symbol: record.symbol,
          };
        }
      }
      if (expectedNextStage &&
          record.snapshot.split?.stage !== expectedNextStage) {
        return {
          kind: "unknown",
          reason: "impulse_split_state_changed_between_verified_phases",
          sourceSignalId,
          symbol: record.symbol,
        };
      }
      if (!["core_pending", "runner_pending", "cancel_original_pending"]
        .includes(record.snapshot.split?.stage)) {
        return lastOutcome ?? {
          kind: "split_pending",
          reason: "impulse_core_split_pending",
          sourceSignalId,
          symbol: record.symbol,
        };
      }
      lastOutcome = await advanceImpulseSplit(
        record, record.snapshot, allowActions,
      );
      if (lastOutcome.kind !== "acted") {
        return {
          ...lastOutcome,
          sourceSignalId,
          symbol: record.symbol,
        };
      }
      expectedNextStage = lastOutcome.operation === "split_core_stop"
        ? "runner_pending"
        : lastOutcome.operation === "split_runner_stop"
          ? "cancel_original_pending"
          : lastOutcome.operation === "cancel_original_stop"
            ? "complete"
            : lastOutcome.operation === "close_pre_runner_split"
              ? "flat_cleanup_pending"
              : null;
    }
    return {
      ...(lastOutcome ?? { kind: "split_pending", reason: "impulse_core_split_pending" }),
      sourceSignalId,
    };
  }

  function intermediatePolicyAfterAction(state, action, observed) {
    const next = {
      ...state,
      observedAt: observed.observedAt,
      peakPct: observed.peakPct,
      runnerPeakPct: observed.runnerPeakPct,
      observationWindowNoted: observed.observationWindowNoted,
    };
    if (action.type === "raise_stop") {
      if (action.leg === "runner") next.runnerStopPrice = action.stopPrice;
      else next.stopPrice = action.stopPrice;
      return next;
    }
    if (action.type === "close_core") {
      next.coreOpen = false;
      next.coreQty = 0;
    } else if (action.type === "close_runner") {
      next.runnerOpen = false;
      next.runnerQty = 0;
    } else {
      throw new Error(`unsupported_vst_policy_action:${action.type}`);
    }
    next.remainingQty = Math.max(0, Number(state.remainingQty) - Number(action.quantity));
    if (next.remainingQty <= 1e-10) {
      next.remainingQty = 0;
      next.status = "closed";
    }
    return next;
  }

  async function reconcileTriggeredStop(record, state) {
    let evidence = null;
    const unknown = async (
      reason = "triggered_stop_reconciliation_unknown", existingDiagnostic,
    ) => {
      let diagnostic = existingDiagnostic;
      if (!diagnostic) {
        const proofEvidence = safeVstProofEvidence("triggered_stop_proof", () => ({
          positionValid: {
            expected: true,
            actual: evidence?.residualPosition?.verified === true,
            matches: evidence?.residualPosition?.verified === true,
          },
          stopFactsValid: {
            expected: true,
            actual: evidence?.verified === true && evidence?.status === "filled",
            matches: evidence?.verified === true && evidence?.status === "filled",
          },
          evidenceVerified: {
            expected: true, actual: evidence?.verified,
            matches: evidence?.verified === true,
          },
          orderStatus: {
            expected: "FILLED",
            actual: evidence?.status === "filled" ? "FILLED" : evidence?.status,
            matches: evidence?.status === "filled",
          },
          stopOrderId: {
            expected: state.coreStopOrderId, actual: evidence?.parentStopId,
            matches: evidence?.parentStopId === state.coreStopOrderId,
          },
          stopPrice: {
            expected: state.stopPrice, actual: evidence?.parentStopPrice,
            matches: Number(evidence?.parentStopPrice) === Number(state.stopPrice),
          },
          childOrderId: {
            expected: evidence?.childOrderId, actual: evidence?.fill?.orderId,
            matches: typeof evidence?.childOrderId === "string" &&
              evidence?.fill?.orderId === evidence.childOrderId,
          },
          fillOrderId: {
            expected: evidence?.childOrderId, actual: evidence?.fill?.orderId,
            matches: typeof evidence?.childOrderId === "string" &&
              evidence?.fill?.orderId === evidence.childOrderId,
          },
          parentOrderId: {
            expected: state.coreStopOrderId, actual: evidence?.fill?.triggerOrderId,
            matches: evidence?.fill?.triggerOrderId === state.coreStopOrderId,
          },
          filledQuantity: {
            expected: state.coreStopQuantity, actual: evidence?.fill?.quantity,
            matches: Number(evidence?.fill?.quantity) === Number(state.coreStopQuantity),
          },
          fillPrice: {
            expected: 0, actual: evidence?.fill?.price,
            matches: Number.isFinite(Number(evidence?.fill?.price)) &&
              Number(evidence?.fill?.price) > 0,
          },
          timesAgree: {
            expected: true,
            actual: Number.isFinite(Date.parse(evidence?.fill?.at)),
            matches: Number.isFinite(Date.parse(evidence?.fill?.at)),
          },
          feeAssetsValid: {
            expected: true,
            actual: typeof evidence?.fill?.fee?.asset === "string" &&
              evidence.fill.fee.asset.trim() !== "",
            matches: typeof evidence?.fill?.fee?.asset === "string" &&
              evidence.fill.fee.asset.trim() !== "",
          },
          fillFee: {
            expected: 0, actual: evidence?.fill?.fee?.amount,
            matches: Number.isFinite(Number(evidence?.fill?.fee?.amount)),
          },
          positionId: {
            expected: state.exchangePositionId,
            actual: evidence?.residualPosition?.positionId,
            matches: evidence?.residualPosition?.positionId === state.exchangePositionId,
          },
          coreVerified: {
            expected: true, actual: evidence?.verified,
            matches: evidence?.verified === true,
          },
          coreOrderId: {
            expected: state.coreStopOrderId, actual: evidence?.parentStopId,
            matches: evidence?.parentStopId === state.coreStopOrderId,
          },
          coreQuantity: {
            expected: state.coreStopQuantity, actual: evidence?.fill?.quantity,
            matches: Number(evidence?.fill?.quantity) === Number(state.coreStopQuantity),
          },
          coreStopPrice: {
            expected: state.stopPrice, actual: evidence?.parentStopPrice,
            matches: Number(evidence?.parentStopPrice) === Number(state.stopPrice),
          },
          remainingQuantity: {
            expected: 0, actual: evidence?.residualPosition?.quantity,
            matches: Number(evidence?.residualPosition?.quantity) === 0,
          },
          openOrderCount: {
            expected: 0, actual: evidence?.openStops?.length,
            matches: Array.isArray(evidence?.openStops) && evidence.openStops.length === 0,
          },
        }));
        diagnostic = recordVstRefusal("stop_unverified", {
          stage: "positionManagement", operation: "read_position",
          check: "protective_stop", symbol: state.symbol,
          sourceSignalId: record.sourceSignalId,
          ...(proofEvidence ? { proofEvidence } : {}),
        });
      }
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      await store.upsertPosition({
        ...state, sourceSignalId: record.sourceSignalId, status: "unknown",
      });
      return attachVstResultDiagnostic({ kind: "unknown", reason }, diagnostic);
    };
    if (state.patternId === "impulse_buy" ||
        !new Set(["liquidation_cascade", "balanced_grind", "price_led_momentum"])
          .has(state.patternId) ||
        typeof broker.observeTriggeredStop !== "function" ||
        typeof state.exchangePositionId !== "string" ||
        typeof state.coreStopOrderId !== "string" ||
        !Number.isSafeInteger(state.coreStopStartedAt)) {
      return await unknown();
    }
    const stopQuantity = Number(state.coreStopQuantity);
    const stopPrice = Number(state.stopPrice);
    if (!Number.isFinite(stopQuantity) || stopQuantity <= 0 ||
        !Number.isFinite(stopPrice) || stopPrice <= 0 ||
        Math.abs(stopQuantity - Number(state.remainingQty)) >
          Math.max(1e-10, Number(state.quantity) * 1e-8)) {
      return await unknown();
    }
    try {
      evidence = await broker.observeTriggeredStop({
        symbol: state.symbol,
        positionId: state.exchangePositionId,
        stopOrderId: state.coreStopOrderId,
        stopQuantity,
        stopPrice,
        previousQuantity: Number(state.remainingQty),
        startedAt: state.coreStopStartedAt,
      });
    } catch (error) {
      const proofEvidence = safeVstProofEvidence("triggered_stop_proof", () => ({
        positionValid: { expected: true, actual: false, matches: false },
        stopFactsValid: { expected: true, actual: false, matches: false },
        evidenceVerified: { expected: true, actual: false, matches: false },
        orderStatus: { expected: "FILLED", actual: undefined, matches: false },
        stopOrderId: {
          expected: state.coreStopOrderId, actual: undefined, matches: false,
        },
        stopPrice: { expected: state.stopPrice, actual: undefined, matches: false },
        childOrderId: { expected: undefined, actual: undefined, matches: false },
        fillOrderId: { expected: undefined, actual: undefined, matches: false },
        parentOrderId: {
          expected: state.coreStopOrderId, actual: undefined, matches: false,
        },
        filledQuantity: {
          expected: state.coreStopQuantity, actual: undefined, matches: false,
        },
        fillPrice: { expected: 0, actual: undefined, matches: false },
        timesAgree: { expected: true, actual: false, matches: false },
        feeAssetsValid: { expected: true, actual: false, matches: false },
        fillFee: { expected: 0, actual: undefined, matches: false },
        positionId: {
          expected: state.exchangePositionId, actual: undefined, matches: false,
        },
        coreVerified: { expected: true, actual: false, matches: false },
        coreOrderId: {
          expected: state.coreStopOrderId, actual: undefined, matches: false,
        },
        coreQuantity: {
          expected: state.coreStopQuantity, actual: undefined, matches: false,
        },
        coreStopPrice: {
          expected: state.stopPrice, actual: undefined, matches: false,
        },
        remainingQuantity: {
          expected: 0, actual: undefined, matches: false,
        },
        openOrderCount: { expected: 0, actual: undefined, matches: false },
      }));
      const diagnostic = recordVstDiagnostic(error, {
        stage: "positionManagement", operation: "read_position",
        check: "protective_stop", symbol: state.symbol,
        sourceSignalId: record.sourceSignalId,
        ...(proofEvidence ? { proofEvidence } : {}),
      });
      evidence = null;
      return await unknown("triggered_stop_reconciliation_unknown", diagnostic);
    }
    const fill = evidence?.fill;
    const fee = fill?.fee;
    const residual = evidence?.residualPosition;
    const fullOrdinaryStopFill = validObject(evidence) &&
      evidence.verified === true && evidence.status === "filled" &&
      evidence.parentStopId === state.coreStopOrderId &&
      Number(evidence.parentStopPrice) === stopPrice &&
      typeof evidence.childOrderId === "string" && evidence.childOrderId.trim() !== "" &&
      validObject(fill) && fill.orderId === evidence.childOrderId &&
      fill.triggerOrderId === state.coreStopOrderId &&
      Number(fill.quantity) === stopQuantity &&
      Number.isFinite(Number(fill.price)) && Number(fill.price) > 0 &&
      Number.isFinite(Date.parse(fill.at)) &&
      validObject(fee) && typeof fee.asset === "string" &&
      fee.asset.trim() !== "" && Number.isFinite(Number(fee.amount)) &&
      validObject(residual) && residual.verified === true &&
      residual.positionId === state.exchangePositionId &&
      Number(residual.quantity) === 0 &&
      Array.isArray(evidence.openStops) && evidence.openStops.length === 0 &&
      Math.abs(Number(state.remainingQty) - stopQuantity) <=
        Math.max(1e-10, Number(state.quantity) * 1e-8);
    if (!fullOrdinaryStopFill) return await unknown();
    if (typeof store.commitVerifiedIntent !== "function") {
      return await unknown("atomic_triggered_stop_commit_unavailable");
    }

    const nextPolicy = {
      ...state,
      status: "closed",
      coreOpen: false,
      coreQty: 0,
      remainingQty: 0,
      lastCloseFill: {
        price: Number(fill.price),
        quantity: Number(fill.quantity),
        at: fill.at,
        orderId: fill.orderId,
        triggerOrderId: fill.triggerOrderId,
        fee: { asset: fee.asset, amount: fee.amount },
        fees: { asset: fee.asset, amount: fee.amount },
        feeEvidenceAvailable: true,
        exchangeOrderId: evidence.childOrderId,
      },
      residualProtectiveStops: {},
      triggeredStop: {
        parentStopId: evidence.parentStopId,
        parentStopPrice: evidence.parentStopPrice,
        childOrderId: evidence.childOrderId,
      },
    };
    const stopDigest = createHash("sha256")
      .update(state.coreStopOrderId).digest("hex").slice(0, 24);
    const phase = `triggered-stop-${stopDigest}`;
    const syntheticClientOrderId = orderId(record.sourceSignalId, phase);
    const request = {
      operation: "observe_triggered_stop",
      environment: "vst",
      accountId: state.accountId,
      symbol: state.symbol,
      positionId: state.exchangePositionId,
      stopOrderId: state.coreStopOrderId,
      stopQuantity,
      stopPrice,
    };
    await prepareIntentRequest(record.sourceSignalId, phase, request);
    const reservation = await store.reserveIntent({
      sourceSignalId: record.sourceSignalId,
      phase,
      clientOrderId: syntheticClientOrderId,
      request,
    });
    if (reservation.kind !== "new" &&
        reservation.intent?.clientOrderId !== syntheticClientOrderId) {
      return await unknown("triggered_stop_intent_identity_mismatch");
    }
    const position = {
      ...nextPolicy,
      sourceSignalId: record.sourceSignalId,
      symbol: state.symbol,
      status: "closed",
      sizing: state.sizing,
      marginMode: PROFILE_MARGIN,
      leverage: PROFILE_LEVERAGE,
      environment: "vst",
      accountId: state.accountId,
      entryClientOrderId: state.entryClientOrderId,
    };
    const outcome = {
      status: "filled",
      verified: true,
      operation: "observe_triggered_stop",
      parentStopId: evidence.parentStopId,
      parentStopPrice: evidence.parentStopPrice,
      childOrderId: evidence.childOrderId,
      fill: nextPolicy.lastCloseFill,
      residualPosition: evidence.residualPosition,
      openStops: evidence.openStops,
    };
    await store.commitVerifiedIntent({
      sourceSignalId: record.sourceSignalId,
      clientOrderId: syntheticClientOrderId,
      position,
      signalStatus: "closed",
      exchangeOrderId: evidence.childOrderId,
      outcome,
      eventKind: "vst_triggered_stop_verified",
      eventDetail: {
        positionId: state.exchangePositionId,
        stopOrderId: state.coreStopOrderId,
        fill: nextPolicy.lastCloseFill,
      },
    });
    return { kind: "acted", operation: "observe_triggered_stop", leg: "core" };
  }

  async function persistTriggeredRunnerCleanup(record, state, exchangePosition,
    stop, otherStop, evidence, expectedRemaining, resolvingIntent = null,
    originalCancelRecovery = null) {
    const unknown = async (reason) => {
      if (originalCancelRecovery) return { kind: "unknown", reason };
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      await store.upsertPosition({
        ...state, sourceSignalId: record.sourceSignalId, status: "unknown",
      });
      return { kind: "unknown", reason };
    };
    const fill = evidence?.fill;
    const fee = fill?.fee;
    const originalStopOrderId = state.originalStopOrderId ??
      state.split?.originalStopOrderId;
    const coreStop = state.split?.coreStop;
    const activeStops = evidence?.openStops;
    const sentCancelConfirmed =
      originalCancelRecovery?.recoveryMode === "sent_cancel_confirmed";
    const exactActive = (observed, expectedId) =>
      validObject(observed) && observed.orderId === expectedId &&
      observed.positionId === state.exchangePositionId &&
      Number(observed.quantity) === expectedRemaining &&
      Number(observed.stopPrice) === Number(state.stopPrice);
    if (!validObject(evidence) || evidence.verified !== true ||
        evidence.status !== "filled" || evidence.parentStopId !== stop.orderId ||
        Number(evidence.parentStopPrice) !== Number(stop.stopPrice) ||
        typeof evidence.childOrderId !== "string" || evidence.childOrderId.trim() === "" ||
        !validObject(fill) || fill.orderId !== evidence.childOrderId ||
        fill.triggerOrderId !== stop.orderId ||
        Number(fill.quantity) !== Number(stop.quantity) ||
        !Number.isFinite(Number(fill.price)) || Number(fill.price) <= 0 ||
        !Number.isFinite(Date.parse(fill.at)) ||
        !validObject(fee) || typeof fee.asset !== "string" || fee.asset.trim() === "" ||
        !Number.isFinite(Number(fee.amount)) ||
        !validObject(evidence.residualPosition) ||
        evidence.residualPosition.verified !== true ||
        evidence.residualPosition.positionId !== state.exchangePositionId ||
        Number(evidence.residualPosition.quantity) !== expectedRemaining ||
        Number(exchangePosition?.quantity) !== expectedRemaining ||
        exchangePosition?.positionId !== state.exchangePositionId ||
        !Number.isFinite(expectedRemaining) || expectedRemaining <= 0 ||
        Number(state.coreQty) !== expectedRemaining ||
        Math.abs(Number(state.remainingQty) - Number(stop.quantity) -
          expectedRemaining) > Math.max(1e-10, Number(state.quantity) * 1e-8) ||
        !validObject(coreStop) || coreStop.orderId !== otherStop?.orderId ||
        !Number.isFinite(Number(state.runnerQty)) ||
        Number(state.runnerQty) !== Number(stop.quantity) ||
        typeof originalStopOrderId !== "string" || originalStopOrderId.trim() === "" ||
        originalStopOrderId === coreStop.orderId ||
        !Array.isArray(activeStops) ||
        activeStops.length !== (sentCancelConfirmed ? 1 : 2) ||
        new Set(activeStops.map((item) => item?.orderId)).size !== activeStops.length ||
        sentCancelConfirmed && evidence.originalCancellationConfirmed !== true ||
        !sentCancelConfirmed && !exactActive(activeStops.find((item) =>
          item?.orderId === originalStopOrderId), originalStopOrderId) ||
        !exactActive(activeStops.find((item) =>
          item?.orderId === coreStop.orderId), coreStop.orderId) ||
        exchangePosition?.protectiveStops?.core?.verified !== true ||
        exchangePosition.protectiveStops.core.orderId !== coreStop.orderId ||
        Number(exchangePosition.protectiveStops.core.quantity) !== expectedRemaining ||
        Number(exchangePosition.protectiveStops.core.stopPrice) !== Number(state.stopPrice)) {
      return await unknown("impulse_runner_fill_or_two_stop_residual_not_verified");
    }
    if (originalCancelRecovery
      ? typeof store.recoverOriginalStopCancelRunnerFill !== "function"
      : typeof store.commitVerifiedIntent !== "function") {
      return await unknown("atomic_runner_fill_cleanup_commit_unavailable");
    }
    const runnerFill = {
      price: Number(fill.price),
      quantity: Number(fill.quantity),
      at: fill.at,
      orderId: fill.orderId,
      triggerOrderId: fill.triggerOrderId,
      fee: { asset: fee.asset, amount: fee.amount },
      fees: { asset: fee.asset, amount: fee.amount },
      feeEvidenceAvailable: true,
      exchangeOrderId: evidence.childOrderId,
    };
    let phase;
    let clientOrderId;
    if (originalCancelRecovery) {
      if (typeof store.recoverOriginalStopCancelRunnerFill !== "function") {
        return await unknown("original_stop_cancel_runner_fill_store_unavailable");
      }
      const stopDigest = createHash("sha256")
        .update(`${state.exchangePositionId}:${stop.orderId}:${evidence.childOrderId}`)
        .digest("hex").slice(0, 24);
      phase = `impulse-runner-fill-${stopDigest}`;
      clientOrderId = orderId(record.sourceSignalId, phase);
      const request = {
        operation: "observe_triggered_stop",
        environment: "vst",
        accountId: state.accountId,
        symbol: state.symbol,
        positionId: state.exchangePositionId,
        leg: "runner",
        stopOrderId: stop.orderId,
        stopQuantity: String(stop.quantity),
        stopPrice: String(stop.stopPrice),
        childOrderId: evidence.childOrderId,
        originalStopOrderId,
        coreStopOrderId: coreStop.orderId,
      };
      try {
        await prepareIntentRequest(record.sourceSignalId, phase, request);
      } catch {
        return await unknown("original_stop_cancel_runner_fill_store_unavailable");
      }
      originalCancelRecovery.runnerFillIntent = {
        phase,
        clientOrderId,
        request,
        exchangeOrderId: evidence.childOrderId,
        outcome: {
          status: "filled",
          verified: true,
          operation: "observe_triggered_stop",
          leg: "runner",
          parentStopId: stop.orderId,
          childOrderId: evidence.childOrderId,
          fill: runnerFill,
          residualPosition: evidence.residualPosition,
          openStops: activeStops,
          cleanupStage: sentCancelConfirmed ? "complete" : "cancel_original_pending",
        },
      };
    } else if (resolvingIntent) {
      // Resolve the placement intent and persist runner_cleanup_pending in
      // the same ledger transaction. A second synthetic intent here would
      // leave the original unknown split_runner_stop blocking all progress.
      if (resolvingIntent.sourceSignalId !== record.sourceSignalId ||
          resolvingIntent.request?.operation !== "split_runner_stop" ||
          resolvingIntent.request?.priorPosition?.split?.stage !== "runner_pending" ||
          typeof resolvingIntent.clientOrderId !== "string") {
        return await unknown("impulse_runner_fill_cleanup_intent_identity_mismatch");
      }
      clientOrderId = resolvingIntent.clientOrderId;
    } else {
      const stopDigest = createHash("sha256")
        .update(`${state.exchangePositionId}:${stop.orderId}:${evidence.childOrderId}`)
        .digest("hex").slice(0, 24);
      phase = `impulse-runner-fill-${stopDigest}`;
      clientOrderId = orderId(record.sourceSignalId, phase);
      const request = {
        operation: "observe_triggered_stop",
        environment: "vst",
        accountId: state.accountId,
        symbol: state.symbol,
        positionId: state.exchangePositionId,
        leg: "runner",
        stopOrderId: stop.orderId,
        stopQuantity: String(stop.quantity),
        stopPrice: String(stop.stopPrice),
        childOrderId: evidence.childOrderId,
        originalStopOrderId,
        coreStopOrderId: coreStop.orderId,
      };
      await prepareIntentRequest(record.sourceSignalId, phase, request);
      const reservation = await store.reserveIntent({
        sourceSignalId: record.sourceSignalId,
        phase,
        clientOrderId,
        request,
      });
      if (reservation.kind !== "new" &&
          reservation.intent?.clientOrderId !== clientOrderId) {
        return await unknown("impulse_runner_fill_cleanup_intent_identity_mismatch");
      }
      if (reservation.intent?.state === "unknown" ||
          reservation.intent?.state === "failed") {
        return await unknown("impulse_runner_fill_cleanup_intent_unresolved");
      }
    }
    const pending = {
      stage: "cancel_original_pending",
      parentStopId: stop.orderId,
      childOrderId: evidence.childOrderId,
      runnerQuantity: String(stop.quantity),
      remainingQuantity: String(expectedRemaining),
      originalStopOrderId,
      coreStopOrderId: coreStop.orderId,
      originalStop: {
        orderId: originalStopOrderId,
        quantity: String(expectedRemaining),
        stopPrice: String(state.stopPrice),
      },
      coreStop: { ...coreStop, quantity: String(expectedRemaining) },
      fill: runnerFill,
      startedAt: Number(state.runnerStopStartedAt ?? state.split.createdAt),
    };
    const split = {
      ...state.split,
      stage: "runner_cleanup_pending",
      runnerCleanup: pending,
      baselineOpenOrderIds: [originalStopOrderId, coreStop.orderId].sort(),
    };
    let nextPosition = {
      ...state,
      sourceSignalId: record.sourceSignalId,
      status: "closing",
      executionStatus: "impulse_runner_fill_cleanup_pending",
      coreOpen: true,
      coreQty: expectedRemaining,
      runnerOpen: false,
      runnerQty: 0,
      remainingQty: expectedRemaining,
      lastCloseFill: runnerFill,
      policy: {
        ...state.policy,
        status: "open",
        coreOpen: true,
        coreQty: expectedRemaining,
        runnerOpen: false,
        runnerQty: 0,
        remainingQty: expectedRemaining,
        lastCloseFill: runnerFill,
      },
      split,
    };
    if (sentCancelConfirmed) {
      const completedSplit = {
        ...state.split,
        stage: "complete",
        runnerCleanup: null,
        runnerStop: null,
        coreStop: { ...coreStop, quantity: String(expectedRemaining) },
        activeLegs: ["core"],
        baselineOpenOrderIds: [coreStop.orderId],
      };
      nextPosition = {
        ...nextPosition,
        status: "open",
        executionStatus: "open",
        split: completedSplit,
        coreStopOrderId: coreStop.orderId,
        coreStopPositionId: state.exchangePositionId,
        coreStopQuantity: expectedRemaining,
        runnerStopOrderId: null,
        runnerStopPositionId: null,
        runnerStopQuantity: 0,
        verifiedProtectiveStops: {
          core: { verified: true, ...completedSplit.coreStop },
        },
        baselineOpenOrderIds: [coreStop.orderId],
      };
    }
    let position;
    if (originalCancelRecovery) {
      const accountStateFromProof = {
        verified: true,
        environment: "vst",
        accountId: state.accountId,
        positions: [{
          symbol: state.symbol,
          positionSide: "LONG",
          positionAmt: String(expectedRemaining),
          positionId: state.exchangePositionId,
        }],
        openOrders: activeStops,
      };
      position = {
        ...nextPosition,
        persistedPosition: persistedSplitPosition(
          nextPosition, accountStateFromProof,
        ) ?? null,
      };
    } else {
      position = await withFreshPersistedSplitPosition(nextPosition);
    }
    if (!position.persistedPosition) {
      return await unknown("impulse_runner_fill_persisted_position_not_verified");
    }
    if (originalCancelRecovery) {
      try {
        const settled = await store.recoverOriginalStopCancelRunnerFill({
          ...originalCancelRecovery,
          recoveryMode: sentCancelConfirmed
            ? "sent_cancel_confirmed"
            : "pre_delete_refusal",
          position,
          runnerFillProof: originalCancelRecovery.proof,
        });
        if (settled?.kind !== "recovered" && settled?.kind !== "replayed") {
          return await unknown(
            "original_stop_cancel_runner_fill_compare_and_set_changed",
          );
        }
        return {
          kind: "acted",
          operation: "observe_triggered_stop",
          leg: "runner",
          originalStopCancelRunnerFillRecoveryBoundary: true,
        };
      } catch {
        return await unknown("original_stop_cancel_runner_fill_store_unavailable");
      }
    }
    await store.commitVerifiedIntent({
      sourceSignalId: record.sourceSignalId,
      clientOrderId,
      position,
      signalStatus: "open",
      exchangeOrderId: evidence.childOrderId,
      outcome: {
        status: "filled",
        verified: true,
        operation: "observe_triggered_stop",
        ...(resolvingIntent
          ? { attribution: "exchange_observed_effect_not_post_authorship" } : {}),
        leg: "runner",
        parentStopId: stop.orderId,
        childOrderId: evidence.childOrderId,
        fill: runnerFill,
        residualPosition: evidence.residualPosition,
        openStops: activeStops,
        cleanupStage: "cancel_original_pending",
      },
      eventKind: "vst_impulse_runner_fill_cleanup_pending",
      eventDetail: {
        positionId: state.exchangePositionId,
        ...(resolvingIntent
          ? { attribution: "exchange_observed_effect_not_post_authorship" } : {}),
        runnerStopOrderId: stop.orderId,
        childOrderId: evidence.childOrderId,
        originalStopOrderId,
        coreStopOrderId: coreStop.orderId,
        remainingQuantity: String(expectedRemaining),
      },
    });
    return { kind: "acted", operation: "observe_triggered_stop", leg: "runner" };
  }

  async function reconcileUnknownRunnerStopFill(intent, evidence) {
    const prior = intent.request?.priorPosition;
    if (!validObject(prior) || prior.sourceSignalId !== intent.sourceSignalId ||
        prior.split?.stage !== "runner_pending" ||
        evidence?.runnerFillRecovery !== true || evidence.status !== "filled") {
      return { kind: "unknown", reason: "impulse_runner_fill_recovery_not_verified" };
    }
    const records = await store.listOpenPositions();
    const record = records.find((row) => row.sourceSignalId === intent.sourceSignalId);
    const state = record?.snapshot;
    const stop = {
      orderId: evidence.parentStopId,
      quantity: prior.split.runnerQuantity,
      stopPrice: prior.split.breakEvenPrice,
    };
    if (!record || !validObject(state) || state.split?.stage !== "runner_pending" ||
        state.exchangePositionId !== prior.exchangePositionId ||
        state.split.positionId !== prior.split.positionId ||
        state.split.coreStop?.orderId !== prior.split.coreStop?.orderId ||
        state.split.runnerQuantity !== prior.split.runnerQuantity ||
        state.split.totalQuantity !== prior.split.totalQuantity ||
        state.split.coreQuantity !== prior.split.coreQuantity ||
        evidence.position?.verified !== true ||
        evidence.position.positionId !== state.exchangePositionId) {
      return { kind: "unknown", reason: "impulse_runner_fill_recovery_snapshot_mismatch" };
    }
    const expectedRemaining = Number(state.split.coreQuantity);
    // A runner_pending snapshot stores tranche quantities under split (and
    // policy), while the already-complete triggered-stop path receives the
    // flattened policy fields. Normalize only from these persisted exact
    // quantities so the shared validator can be reused without inventing
    // exchange state.
    const cleanupState = {
      ...state,
      quantity: Number(state.split.totalQuantity),
      remainingQty: Number(state.split.totalQuantity),
      coreQty: expectedRemaining,
      runnerQty: Number(state.split.runnerQuantity),
      stopPrice: Number(state.split.signalStopPrice),
      coreOpen: true,
      runnerOpen: true,
    };
    return await persistTriggeredRunnerCleanup(
      record,
      cleanupState,
      evidence.position,
      stop,
      cleanupState.split.coreStop,
      evidence,
      expectedRemaining,
      intent,
    );
  }

  async function reconcileImpulseTriggeredStop(
    record, state, exchangePosition, allowSourceExitRecovery = false,
  ) {
    let evidence = null;
    let caughtDiagnostic;
    const failClosed = async (
      reason = "impulse_triggered_stop_reconciliation_unknown", existingDiagnostic,
    ) => {
      let diagnostic = existingDiagnostic ?? caughtDiagnostic;
      if (!diagnostic) {
        const proofEvidence = safeVstProofEvidence("triggered_stop_proof", () => {
          const coreStop = state.split?.coreStop;
          const runnerStop = state.split?.runnerStop;
          const residual = evidence?.residualPosition;
          const fill = evidence?.fill;
          const expectedStops = state.runnerOpen && runnerStop?.orderId
            ? [runnerStop.orderId] : [];
          const actualStopIds = Array.isArray(evidence?.openStops)
            ? evidence.openStops.map((item) => item?.orderId) : undefined;
          return {
            positionValid: {
              expected: true,
              actual: residual?.verified === true &&
                residual.positionId === state.exchangePositionId,
              matches: residual?.verified === true &&
                residual.positionId === state.exchangePositionId,
            },
            stopFactsValid: {
              expected: true,
              actual: evidence?.verified === true && evidence?.status === "filled" &&
                fill?.triggerOrderId === evidence?.parentStopId,
              matches: evidence?.verified === true && evidence?.status === "filled" &&
                fill?.triggerOrderId === evidence?.parentStopId,
            },
            evidenceVerified: {
              expected: true, actual: evidence?.verified,
              matches: evidence?.verified === true,
            },
            orderStatus: {
              expected: "FILLED",
              actual: evidence?.status === "filled" ? "FILLED" : evidence?.status,
              matches: evidence?.status === "filled",
            },
            positionId: {
              expected: state.exchangePositionId, actual: residual?.positionId,
              matches: residual?.positionId === state.exchangePositionId,
            },
            parentOrderIds: {
              expected: [coreStop?.orderId, runnerStop?.orderId].filter(Boolean),
              actual: evidence?.parentStopId === undefined
                ? [] : [evidence.parentStopId],
              matches: [coreStop?.orderId, runnerStop?.orderId]
                .filter(Boolean).includes(evidence?.parentStopId),
            },
            stopPrice: {
              expected: evidence?.parentStopId === coreStop?.orderId
                ? coreStop?.stopPrice : runnerStop?.stopPrice,
              actual: evidence?.parentStopPrice,
              matches: Number(evidence?.parentStopPrice) === Number(
                evidence?.parentStopId === coreStop?.orderId
                  ? coreStop?.stopPrice : runnerStop?.stopPrice),
            },
            childOrderId: {
              expected: evidence?.childOrderId, actual: fill?.orderId,
              matches: typeof evidence?.childOrderId === "string" &&
                fill?.orderId === evidence.childOrderId,
            },
            fillOrderId: {
              expected: evidence?.childOrderId, actual: fill?.orderId,
              matches: typeof evidence?.childOrderId === "string" &&
                fill?.orderId === evidence.childOrderId,
            },
            parentOrderId: {
              expected: evidence?.parentStopId, actual: fill?.triggerOrderId,
              matches: fill?.triggerOrderId === evidence?.parentStopId,
            },
            filledQuantity: {
              expected: evidence?.parentStopId === coreStop?.orderId
                ? coreStop?.quantity : runnerStop?.quantity,
              actual: fill?.quantity,
              matches: Number(fill?.quantity) === Number(
                evidence?.parentStopId === coreStop?.orderId
                  ? coreStop?.quantity : runnerStop?.quantity),
            },
            fillPrice: {
              expected: 0, actual: fill?.price,
              matches: Number.isFinite(Number(fill?.price)) && Number(fill?.price) > 0,
            },
            timesAgree: {
              expected: true, actual: Number.isFinite(Date.parse(fill?.at)),
              matches: Number.isFinite(Date.parse(fill?.at)),
            },
            feeAssetsValid: {
              expected: true,
              actual: typeof fill?.fee?.asset === "string" && fill.fee.asset.trim() !== "",
              matches: typeof fill?.fee?.asset === "string" && fill.fee.asset.trim() !== "",
            },
            fillFee: {
              expected: 0, actual: fill?.fee?.amount,
              matches: Number.isFinite(Number(fill?.fee?.amount)),
            },
            coreVerified: {
              expected: state.coreOpen === true,
              actual: exchangePosition?.protectiveStops?.core?.verified === true,
              matches: !state.coreOpen ||
                exchangePosition?.protectiveStops?.core?.verified === true,
            },
            runnerVerified: {
              expected: state.runnerOpen === true,
              actual: exchangePosition?.protectiveStops?.runner?.verified === true,
              matches: !state.runnerOpen ||
                exchangePosition?.protectiveStops?.runner?.verified === true,
            },
            coreOrderId: {
              expected: coreStop?.orderId,
              actual: exchangePosition?.protectiveStops?.core?.orderId,
              matches: exchangePosition?.protectiveStops?.core?.orderId === coreStop?.orderId,
            },
            corePositionId: {
              expected: state.exchangePositionId,
              actual: exchangePosition?.protectiveStops?.core?.positionId,
              matches: exchangePosition?.protectiveStops?.core?.positionId ===
                state.exchangePositionId,
            },
            coreQuantity: {
              expected: coreStop?.quantity,
              actual: exchangePosition?.protectiveStops?.core?.quantity,
              matches: Number(exchangePosition?.protectiveStops?.core?.quantity) ===
                Number(coreStop?.quantity),
            },
            coreStopPrice: {
              expected: coreStop?.stopPrice,
              actual: exchangePosition?.protectiveStops?.core?.stopPrice,
              matches: Number(exchangePosition?.protectiveStops?.core?.stopPrice) ===
                Number(coreStop?.stopPrice),
            },
            runnerOrderId: {
              expected: runnerStop?.orderId,
              actual: exchangePosition?.protectiveStops?.runner?.orderId,
              matches: exchangePosition?.protectiveStops?.runner?.orderId ===
                runnerStop?.orderId,
            },
            runnerPositionId: {
              expected: state.exchangePositionId,
              actual: exchangePosition?.protectiveStops?.runner?.positionId,
              matches: exchangePosition?.protectiveStops?.runner?.positionId ===
                state.exchangePositionId,
            },
            runnerQuantity: {
              expected: runnerStop?.quantity,
              actual: exchangePosition?.protectiveStops?.runner?.quantity,
              matches: Number(exchangePosition?.protectiveStops?.runner?.quantity) ===
                Number(runnerStop?.quantity),
            },
            runnerStopPrice: {
              expected: runnerStop?.stopPrice,
              actual: exchangePosition?.protectiveStops?.runner?.stopPrice,
              matches: Number(exchangePosition?.protectiveStops?.runner?.stopPrice) ===
                Number(runnerStop?.stopPrice),
            },
            remainingQuantity: {
              expected: state.runnerOpen
                ? state.runnerQty : state.coreOpen ? state.coreQty : 0,
              actual: residual?.quantity,
              matches: Number(residual?.quantity) === Number(state.runnerOpen
                ? state.runnerQty : state.coreOpen ? state.coreQty : 0),
            },
            openOrderCount: {
              expected: state.runnerOpen ? 1 : 0,
              actual: evidence?.openStops?.length,
              matches: evidence?.openStops?.length === (state.runnerOpen ? 1 : 0),
            },
            currentOrderIds: {
              expected: expectedStops, actual: actualStopIds,
              matches: Array.isArray(actualStopIds) &&
                JSON.stringify(actualStopIds.slice().sort()) ===
                  JSON.stringify(expectedStops.slice().sort()),
            },
            expectedOrderIds: {
              expected: expectedStops, actual: actualStopIds,
              matches: Array.isArray(actualStopIds) &&
                JSON.stringify(actualStopIds.slice().sort()) ===
                  JSON.stringify(expectedStops.slice().sort()),
            },
          };
        });
        diagnostic = recordVstRefusal("stop_unverified", {
          stage: "positionManagement", operation: "read_position",
          check: "protective_stop", symbol: state.symbol,
          sourceSignalId: record.sourceSignalId,
          ...(proofEvidence ? { proofEvidence } : {}),
        });
      }
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      await store.upsertPosition({
        ...state, sourceSignalId: record.sourceSignalId, status: "unknown",
      });
      return attachVstResultDiagnostic({ kind: "unknown", reason }, diagnostic);
    };
    const candidates = ["core", "runner"].filter((leg) => {
      if (!state[`${leg}Open`]) return false;
      const expected = state.split?.[`${leg}Stop`];
      const observed = exchangePosition?.protectiveStops?.[leg];
      return !expected || observed?.verified !== true ||
        observed.orderId !== expected.orderId ||
        observed.positionId !== state.exchangePositionId ||
        Number(observed.quantity) !== Number(expected.quantity) ||
        Number(observed.stopPrice) !== Number(expected.stopPrice);
    });
    if (candidates.length !== 1 || typeof broker.observeTriggeredStop !== "function") {
      return await failClosed();
    }
    const leg = candidates[0];
    const otherLeg = leg === "core" ? "runner" : "core";
    const stop = state.split?.[`${leg}Stop`];
    const otherStop = state.split?.[`${otherLeg}Stop`];
    if (!validObject(stop) || typeof stop.orderId !== "string" ||
        !Number.isSafeInteger(state.split.createdAt) ||
        !Number.isFinite(Number(stop.quantity)) || Number(stop.quantity) <= 0 ||
        !Number.isFinite(Number(stop.stopPrice)) || Number(stop.stopPrice) <= 0) {
      return await failClosed("impulse_triggered_stop_snapshot_missing");
    }
    try {
      evidence = await broker.observeTriggeredStop({
        symbol: state.symbol,
        positionId: state.exchangePositionId,
        stopOrderId: stop.orderId,
        stopQuantity: Number(stop.quantity),
        stopPrice: Number(stop.stopPrice),
        previousQuantity: Number(state.remainingQty),
        startedAt: state[`${leg}StopStartedAt`] ?? state.split.createdAt,
      });
    } catch (error) {
      const proofEvidence = safeVstProofEvidence("triggered_stop_proof", () => ({
        positionValid: { expected: true, actual: false, matches: false },
        stopFactsValid: { expected: true, actual: false, matches: false },
        evidenceVerified: { expected: true, actual: false, matches: false },
        orderStatus: { expected: "FILLED", actual: undefined, matches: false },
        positionId: {
          expected: state.exchangePositionId, actual: undefined, matches: false,
        },
        parentOrderIds: {
          expected: [state.split?.coreStop?.orderId, state.split?.runnerStop?.orderId]
            .filter(Boolean),
          actual: [], matches: false,
        },
        stopPrice: { expected: stop.stopPrice, actual: undefined, matches: false },
        childOrderId: { expected: undefined, actual: undefined, matches: false },
        fillOrderId: { expected: undefined, actual: undefined, matches: false },
        parentOrderId: { expected: stop.orderId, actual: undefined, matches: false },
        filledQuantity: { expected: stop.quantity, actual: undefined, matches: false },
        fillPrice: { expected: 0, actual: undefined, matches: false },
        timesAgree: { expected: true, actual: false, matches: false },
        feeAssetsValid: { expected: true, actual: false, matches: false },
        fillFee: { expected: 0, actual: undefined, matches: false },
        coreVerified: {
          expected: leg === "core", actual: false, matches: leg !== "core",
        },
        runnerVerified: {
          expected: leg === "runner", actual: false, matches: leg !== "runner",
        },
        ...(leg === "core" ? {
          coreOrderId: { expected: stop.orderId, actual: undefined, matches: false },
          coreQuantity: { expected: stop.quantity, actual: undefined, matches: false },
          coreStopPrice: { expected: stop.stopPrice, actual: undefined, matches: false },
        } : {
          runnerOrderId: { expected: stop.orderId, actual: undefined, matches: false },
          runnerQuantity: { expected: stop.quantity, actual: undefined, matches: false },
          runnerStopPrice: { expected: stop.stopPrice, actual: undefined, matches: false },
        }),
        remainingQuantity: {
          expected: expectedRemaining, actual: undefined, matches: false,
        },
        openOrderCount: {
          expected: expectedRemaining > 0 ? 1 : 0,
          actual: undefined, matches: false,
        },
        currentOrderIds: {
          expected: expectedRemaining > 0 && otherStop?.orderId
            ? [otherStop.orderId] : [],
          actual: undefined, matches: false,
        },
        expectedOrderIds: {
          expected: expectedRemaining > 0 && otherStop?.orderId
            ? [otherStop.orderId] : [],
          actual: undefined, matches: false,
        },
      }));
      caughtDiagnostic = recordVstDiagnostic(error, {
        stage: "positionManagement", operation: "read_position",
        check: "protective_stop", symbol: state.symbol,
        sourceSignalId: record.sourceSignalId,
        ...(proofEvidence ? { proofEvidence } : {}),
      });
      evidence = null;
    }
    const fill = evidence?.fill;
    const fee = fill?.fee;
    const calculatedRemaining = Math.max(
      0, Number(state.remainingQty) - Number(stop.quantity),
    );
    const expectedRemaining = state[`${otherLeg}Open`]
      ? Number(state[`${otherLeg}Qty`]) : 0;
    const quantityTolerance = Math.max(1e-10, Number(state.quantity) * 1e-8);
    const residualQuantity = Number(evidence?.residualPosition?.quantity);
    if (leg === "runner") {
      const cleanup = await persistTriggeredRunnerCleanup(
        record, state, exchangePosition, stop, otherStop, evidence, expectedRemaining,
      );
      return caughtDiagnostic && cleanup?.kind === "unknown"
        ? attachVstResultDiagnostic(cleanup, caughtDiagnostic) : cleanup;
    }
    const expectedOpenStops = expectedRemaining > 0 ? 1 : 0;
    const survivor = evidence?.openStops?.[0];
    const survivorValid = expectedRemaining === 0
      ? evidence?.openStops?.length === 0
      : validObject(otherStop) && evidence?.openStops?.length === 1 &&
        survivor.orderId === otherStop.orderId &&
        survivor.positionId === state.exchangePositionId &&
        Math.abs(Number(survivor.quantity) - expectedRemaining) <= quantityTolerance &&
        Number(survivor.stopPrice) === Number(otherStop.stopPrice) &&
        Math.abs(Number(state[`${otherLeg}Qty`]) - expectedRemaining) <= quantityTolerance &&
        exchangePosition?.protectiveStops?.[otherLeg]?.verified === true &&
        exchangePosition.protectiveStops[otherLeg].orderId === otherStop.orderId &&
        Math.abs(Number(exchangePosition.protectiveStops[otherLeg].quantity) -
          expectedRemaining) <= quantityTolerance &&
        Number(exchangePosition.protectiveStops[otherLeg].stopPrice) ===
          Number(otherStop.stopPrice);
    if (!validObject(evidence) || evidence.verified !== true ||
        evidence.status !== "filled" || evidence.parentStopId !== stop.orderId ||
        Number(evidence.parentStopPrice) !== Number(stop.stopPrice) ||
        typeof evidence.childOrderId !== "string" || evidence.childOrderId.trim() === "" ||
        !validObject(fill) || fill.orderId !== evidence.childOrderId ||
        fill.triggerOrderId !== stop.orderId ||
        Number(fill.quantity) !== Number(stop.quantity) ||
        !Number.isFinite(Number(fill.price)) || Number(fill.price) <= 0 ||
        !Number.isFinite(Date.parse(fill.at)) ||
        !validObject(fee) || typeof fee.asset !== "string" || fee.asset.trim() === "" ||
        !Number.isFinite(Number(fee.amount)) ||
        evidence.residualPosition?.verified !== true ||
        evidence.residualPosition.positionId !== state.exchangePositionId ||
        !Number.isFinite(residualQuantity) ||
        Math.abs(residualQuantity - expectedRemaining) > quantityTolerance ||
        Math.abs(calculatedRemaining - expectedRemaining) > quantityTolerance ||
        evidence.openStops?.length !== expectedOpenStops || !survivorValid ||
        Math.abs(Number(exchangePosition.quantity) - expectedRemaining) >
          quantityTolerance) {
      return await failClosed("impulse_triggered_stop_or_survivor_not_verified");
    }
    if (typeof store.commitVerifiedIntent !== "function") {
      return await failClosed("atomic_triggered_stop_commit_unavailable");
    }
    const nextPolicy = {
      ...state,
      status: expectedRemaining === 0 ? "closed" : "open",
      remainingQty: expectedRemaining,
      lastCloseFill: {
        price: Number(fill.price),
        quantity: Number(fill.quantity),
        at: fill.at,
        orderId: fill.orderId,
        triggerOrderId: fill.triggerOrderId,
        fee: { asset: fee.asset, amount: fee.amount },
        fees: { asset: fee.asset, amount: fee.amount },
        feeEvidenceAvailable: true,
        exchangeOrderId: evidence.childOrderId,
      },
      residualProtectiveStops: expectedRemaining > 0
        ? { [otherLeg]: survivor } : {},
      triggeredStop: {
        parentStopId: evidence.parentStopId,
        parentStopPrice: evidence.parentStopPrice,
        childOrderId: evidence.childOrderId,
      },
    };
    nextPolicy[`${leg}Open`] = false;
    nextPolicy[`${leg}Qty`] = 0;
    if (expectedRemaining === 0) {
      nextPolicy.coreOpen = false;
      nextPolicy.coreQty = 0;
      nextPolicy.runnerOpen = false;
      nextPolicy.runnerQty = 0;
    }
    const split = { ...state.split, stage: "complete" };
    split[`${leg}Stop`] = null;
    if (expectedRemaining > 0) {
      split[`${otherLeg}Stop`] = {
        ...otherStop, quantity: String(expectedRemaining),
      };
      split.activeLegs = [otherLeg];
      split.baselineOpenOrderIds = [otherStop.orderId];
    } else {
      split[`${otherLeg}Stop`] = null;
      split.activeLegs = [];
      split.baselineOpenOrderIds = [];
    }
    let position = {
      ...nextPolicy,
      sourceSignalId: record.sourceSignalId,
      symbol: state.symbol,
      patternId: "impulse_buy",
      status: nextPolicy.status,
      executionStatus: "open",
      split,
      coreStopOrderId: expectedRemaining > 0 && otherLeg === "core"
        ? otherStop.orderId : null,
      coreStopPositionId: expectedRemaining > 0 && otherLeg === "core"
        ? state.exchangePositionId : null,
      coreStopQuantity: expectedRemaining > 0 && otherLeg === "core"
        ? expectedRemaining : 0,
      runnerStopOrderId: expectedRemaining > 0 && otherLeg === "runner"
        ? otherStop.orderId : null,
      runnerStopPositionId: expectedRemaining > 0 && otherLeg === "runner"
        ? state.exchangePositionId : null,
      runnerStopQuantity: expectedRemaining > 0 && otherLeg === "runner"
        ? expectedRemaining : 0,
      verifiedProtectiveStops: expectedRemaining > 0
        ? { [otherLeg]: { verified: true, ...split[`${otherLeg}Stop`] } } : {},
      baselineOpenOrderIds: [...split.baselineOpenOrderIds],
    };
    if (expectedRemaining > 0) {
      position = await withFreshPersistedSplitPosition(position);
      if (!position.persistedPosition) {
        return await failClosed("impulse_triggered_stop_persisted_position_not_verified");
      }
    } else {
      position.persistedPosition = null;
    }
    const stopDigest = createHash("sha256")
      .update(`${state.exchangePositionId}:${stop.orderId}`)
      .digest("hex").slice(0, 24);
    const phase = `impulse-triggered-stop-${stopDigest}`;
    const clientOrderId = orderId(record.sourceSignalId, phase);
    const request = {
      operation: "observe_triggered_stop",
      environment: "vst",
      accountId: state.accountId,
      symbol: state.symbol,
      positionId: state.exchangePositionId,
      leg,
      stopOrderId: stop.orderId,
      stopQuantity: stop.quantity,
      stopPrice: stop.stopPrice,
    };
    await prepareIntentRequest(record.sourceSignalId, phase, request);
    const reservation = await store.reserveIntent({
      sourceSignalId: record.sourceSignalId,
      phase,
      clientOrderId,
      request,
    });
    if (reservation.kind !== "new" &&
        reservation.intent?.clientOrderId !== clientOrderId) {
      return await failClosed("impulse_triggered_stop_intent_identity_mismatch");
    }
    if (reservation.intent?.state === "failed" ||
        reservation.intent?.state === "unknown" && !allowSourceExitRecovery) {
      return await failClosed("impulse_triggered_stop_intent_unresolved");
    }
    await store.commitVerifiedIntent({
      sourceSignalId: record.sourceSignalId,
      clientOrderId,
      position,
      signalStatus: expectedRemaining === 0 ? "closed" : "open",
      exchangeOrderId: evidence.childOrderId,
      outcome: {
        status: "filled",
        verified: true,
        operation: "observe_triggered_stop",
        leg,
        parentStopId: evidence.parentStopId,
        parentStopPrice: evidence.parentStopPrice,
        childOrderId: evidence.childOrderId,
        fill: nextPolicy.lastCloseFill,
        residualPosition: evidence.residualPosition,
        openStops: evidence.openStops,
      },
      eventKind: "vst_impulse_triggered_stop_verified",
      eventDetail: {
        positionId: state.exchangePositionId,
        leg,
        stopOrderId: stop.orderId,
        fill: nextPolicy.lastCloseFill,
        residualQuantity: expectedRemaining,
      },
    });
    return { kind: "acted", operation: "observe_triggered_stop", leg };
  }

  function splitStopRecord(split, tranche) {
    const stop = split?.[`${tranche}Stop`];
    return stop ? {
      tranche,
      orderId: stop.orderId,
      positionId: split.positionId,
      quantity: String(stop.quantity),
      stopPrice: String(stop.stopPrice),
    } : undefined;
  }

  function symbolOrders(accountState, symbol) {
    if (!validObject(accountState) || accountState.verified !== true ||
        !Array.isArray(accountState.openOrders)) return null;
    const compactSymbol = String(symbol).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    return accountState.openOrders.filter((row) =>
      typeof row?.symbol === "string" &&
      row.symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase() === compactSymbol);
  }

  function exactOrderIds(orders) {
    if (!Array.isArray(orders)) return null;
    const ids = orders.map((order) => {
      const value = order?.orderId ?? order?.orderID;
      if (typeof value === "string" && value.trim() !== "") return value;
      return Number.isSafeInteger(value) ? String(value) : null;
    });
    return ids.every((id) => id !== null) && new Set(ids).size === ids.length
      ? ids : null;
  }

  function exactRawSplitStop(state, accountState, expected) {
    if (!validObject(expected) || typeof expected.orderId !== "string") return null;
    const orders = symbolOrders(accountState, state.symbol);
    if (!orders) return null;
    const identifierText = (value) => {
      if (typeof value === "string" && value.trim() !== "") return value;
      return Number.isSafeInteger(value) ? String(value) : null;
    };
    const candidates = orders.filter((order) =>
      identifierText(order.orderId ?? order.orderID) === expected.orderId);
    if (candidates.length !== 1) return null;
    const order = candidates[0];
    const orderPositionId = identifierText(order.positionId ?? order.positionID);
    const parents = [order.mainOrderId, order.parentOrderId]
      .filter((value) => value !== undefined && value !== null && value !== "")
      .map(identifierText);
    if (order.type !== "STOP_MARKET" || order.status !== "NEW" ||
        order.side !== "SELL" || order.positionSide !== "LONG" ||
        order.workingType !== "MARK_PRICE" ||
        orderPositionId !== state.split.positionId ||
        Number(order.origQty) !== Number(expected.quantity) ||
        Number(order.stopPrice) !== Number(expected.stopPrice) ||
        parents.some((parent) => parent === null) ||
        new Set(parents).size > 1 ||
        parents.some((parent) => parent !== state.split.entryOrderId)) {
      return null;
    }
    return {
      verified: true,
      orderId: expected.orderId,
      positionId: state.split.positionId,
      quantity: Number(order.origQty),
      stopPrice: Number(order.stopPrice),
    };
  }

  async function verifyRaiseStopMonotonicity(state, action) {
    let accountState;
    try {
      accountState = await broker.readAccountState();
    } catch {
      return { verified: false, reason: "raise_stop_monotonicity_read_unavailable" };
    }
    if (!validObject(accountState) || accountState.verified !== true ||
        accountState.environment !== "vst" ||
        accountState.accountId !== state.accountId ||
        !Array.isArray(accountState.positions) ||
        !Array.isArray(accountState.openOrders)) {
      return { verified: false, reason: "raise_stop_monotonicity_state_unverified" };
    }
    const leg = action.leg ?? "core";
    const expectedStop = state.verifiedProtectiveStops?.[leg] ??
      state.protectiveStops?.[leg] ??
      state.split?.[`${leg}Stop`] ??
      state[`${leg}Stop`] ??
      (leg === "core" ? state.coreStop : null);
    const positionId = consistentExchangeIdentifier(
      state, "exchangePositionId", "positionId",
    );
    const expectedStopId = consistentExchangeIdentifier(
      expectedStop, "orderId", "orderID",
    );
    const expectedStopPositionId = consistentExchangeIdentifier(
      expectedStop, "positionId", "positionID",
    );
    const expectedStopQuantity = consistentDecimalAliases(
      expectedStop, "quantity", "origQty",
    );
    const expectedStopPrice = expectedStop?.stopPrice;
    const compactSymbol = String(state.symbol ?? "")
      .replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const positions = accountState.positions.filter((row) =>
      typeof row?.symbol === "string" &&
      row.symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase() === compactSymbol);
    const orders = symbolOrders(accountState, state.symbol);
    if (!positionId || !expectedStopId ||
        expectedStop?.verified !== true ||
        expectedStopPositionId !== positionId ||
        !exactDecimalParts(expectedStopQuantity) ||
        !exactDecimalParts(expectedStopPrice) ||
        !exactDecimalParts(action.stopPriceText ?? action.stopPrice) ||
        positions.length !== 1 || !Array.isArray(orders)) {
      return { verified: false, reason: "raise_stop_monotonicity_identity_unverified" };
    }
    const position = positions[0];
    const observedPositionId = consistentExchangeIdentifier(
      position, "positionId", "positionID",
    );
    const observedQuantity = consistentDecimalAliases(
      position, "positionAmt", "quantity",
    );
    // The split total remains the entry quantity after one tranche has
    // closed; current tracked exposure is authoritative for this position
    // snapshot and must take precedence during sole-survivor management.
    const expectedPositionQuantity = state.remainingQty ??
      state.split?.totalQuantity ?? state.quantity;
    if (observedPositionId !== positionId ||
        !exactDecimalParts(observedQuantity) ||
        compareExactDecimals(observedQuantity, 0) <= 0 ||
        !exactDecimalEqual(observedQuantity, expectedPositionQuantity) ||
        position.positionSide !== "LONG") {
      return { verified: false, reason: "raise_stop_monotonicity_position_mismatch" };
    }
    const matches = orders.filter((order) =>
      consistentExchangeIdentifier(order, "orderId", "orderID") === expectedStopId);
    if (matches.length !== 1) {
      return { verified: false, reason: "raise_stop_monotonicity_stop_mismatch" };
    }
    const order = matches[0];
    const parentIds = [
      order.mainOrderId, order.mainOrderID, order.parentOrderId, order.parentOrderID,
    ].filter((value) => value !== undefined && value !== null && value !== "")
      .map(exactExchangeIdentifier);
    const expectedEntryOrderId = state.entryOrderId == null
      ? null : exactExchangeIdentifier(state.entryOrderId);
    if (order.type !== "STOP_MARKET" || order.status !== "NEW" ||
        order.side !== "SELL" || order.positionSide !== "LONG" ||
        order.workingType !== "MARK_PRICE" ||
        consistentExchangeIdentifier(order, "positionId", "positionID") !== positionId ||
        !exactDecimalEqual(
          consistentDecimalAliases(order, "origQty", "quantity"),
          expectedStopQuantity,
        ) ||
        !exactDecimalEqual(order.stopPrice, expectedStopPrice) ||
        parentIds.some((id) => id === null) ||
        new Set(parentIds).size > 1 ||
        expectedEntryOrderId !== null &&
          parentIds.some((id) => id !== expectedEntryOrderId)) {
      return { verified: false, reason: "raise_stop_monotonicity_stop_mismatch" };
    }
    const comparison = compareExactDecimals(
      action.stopPriceText ?? action.stopPrice, order.stopPrice,
    );
    return {
      verified: true,
      relation: comparison > 0 ? "higher" : comparison === 0 ? "equal" : "lower",
      currentStopPrice: String(order.stopPrice),
      positionId,
      quantity: String(observedQuantity),
      stopOrderId: expectedStopId,
    };
  }

  function persistedSplitPosition(state, accountState) {
    const split = state?.split;
    const positionId = state?.exchangePositionId ?? split?.positionId;
    if (!validObject(state) || !validObject(split) ||
        !validObject(accountState) || accountState.verified !== true ||
        state.environment !== "vst" ||
        typeof state.accountId !== "string" || state.accountId.trim() === "" ||
        typeof positionId !== "string" || split.positionId !== positionId ||
        split.upgradePending) {
      return undefined;
    }
    const compactSymbol = String(state.symbol).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const positions = accountState.positions?.filter((row) =>
      typeof row?.symbol === "string" &&
      row.symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase() === compactSymbol) ?? [];
    if (positions.length !== 1) return undefined;
    const position = positions[0];
    const quantity = Number(position.positionAmt ?? position.quantity);
    const rawPositionIdValue = position.positionId ?? position.positionID;
    const rawPositionId = typeof rawPositionIdValue === "string"
      ? rawPositionIdValue
      : Number.isSafeInteger(rawPositionIdValue) ? String(rawPositionIdValue) : null;
    const acceptedQuantities = [
      state.remainingQty,
      state.coreQty,
      state.runnerQty,
      split.totalQuantity,
      split.coreQuantity,
      split.runnerQuantity,
      split.cleanupRemainingQuantity,
      split.runnerCleanup?.remainingQuantity,
    ].map(Number).filter((value) => Number.isFinite(value) && value > 0);
    const closeEnoughQuantity = (left, right) =>
      Math.abs(Number(left) - Number(right)) <= Math.max(1e-10, Number(right) * 1e-8);
    if (rawPositionId !== positionId || !Number.isFinite(quantity) || quantity <= 0 ||
        acceptedQuantities.length === 0 ||
        !acceptedQuantities.some((expected) => closeEnoughQuantity(quantity, expected))) {
      return undefined;
    }

    const orders = symbolOrders(accountState, state.symbol);
    if (!orders || !Array.isArray(orders)) return undefined;
    const protectiveStops = {};
    let originalStop;
    const descriptor = (tranche, raw) => ({
      verified: true,
      tranche,
      orderId: raw.orderId,
      positionId: raw.positionId,
      quantity: String(raw.quantity),
      stopPrice: String(raw.stopPrice),
    });
    const cleanup = split.runnerCleanup;
    if (split.stage === "runner_cleanup_pending" && validObject(cleanup)) {
      const core = exactRawSplitStop(state, accountState, {
        ...cleanup.coreStop,
        orderId: cleanup.coreStopOrderId,
        quantity: cleanup.remainingQuantity,
        stopPrice: state.stopPrice,
      });
      const original = exactRawSplitStop(state, accountState, {
        orderId: cleanup.originalStopOrderId,
        quantity: cleanup.remainingQuantity,
        stopPrice: state.stopPrice,
      });
      if (core) protectiveStops.core = descriptor("core", core);
      if (original) {
        originalStop = {
          ...descriptor("original", original),
          tranche: "original",
        };
      }
    } else {
      for (const tranche of ["core", "runner"]) {
        const expected = split[`${tranche}Stop`];
        if (!validObject(expected)) continue;
        const raw = exactRawSplitStop(state, accountState, {
          ...expected,
          tranche,
        });
        if (raw) protectiveStops[tranche] = descriptor(tranche, raw);
      }
      const stageHasOriginal = [
        "core_pending", "runner_pending", "cancel_original_pending",
      ].includes(split.stage);
      const originalId = split.originalStopOrderId ?? state.originalStopOrderId;
      if (stageHasOriginal && typeof originalId === "string" &&
          originalId.trim() !== "") {
        const raw = exactRawSplitStop(state, accountState, {
          orderId: originalId,
          quantity: split.totalQuantity,
          stopPrice: split.signalStopPrice,
        });
        if (raw) {
          originalStop = {
            ...descriptor("original", raw),
            tranche: "original",
          };
        }
      }
    }
    const persistedOrders = [
      ...Object.values(protectiveStops),
      ...(originalStop ? [originalStop] : []),
    ];
    if (persistedOrders.length === 0 ||
        persistedOrders.length !== orders.length ||
        new Set(persistedOrders.map((stop) => stop.orderId)).size !== orders.length) {
      return undefined;
    }
    return {
      verified: true,
      environment: "vst",
      accountId: state.accountId,
      symbol: state.symbol,
      positionId,
      quantity: String(quantity),
      protectiveStops,
      ...(originalStop ? { originalStop } : {}),
    };
  }

  async function withFreshPersistedSplitPosition(position) {
    const accountState = await broker.readAccountState();
    return {
      ...position,
      persistedPosition: persistedSplitPosition(position, accountState) ?? null,
    };
  }

  function impulseSplitRequest(record, state, operation, overrides = {}) {
    const split = state.split;
    return {
      operation,
      sourceSignalId: record.sourceSignalId,
      signal: record.body ?? state.signal ?? state.policy?.signal ?? state.signalSnapshot,
      symbol: state.symbol,
      accountId: state.accountId,
      environment: "vst",
      positionId: split.positionId,
      originalStopOrderId: split.originalStopOrderId,
      entryOrderId: split.entryOrderId,
      totalQuantity: split.totalQuantity,
      coreQuantity: split.coreQuantity,
      runnerQuantity: split.runnerQuantity,
      signalStopPrice: split.signalStopPrice,
      breakEvenPrice: split.breakEvenPrice,
      actualEntryBreakEvenPrice: split.actualEntryBreakEvenPrice,
      quantityPrecision: split.quantityPrecision,
      pricePrecision: split.pricePrecision,
      baselineOpenOrderIds: [...split.baselineOpenOrderIds],
      createdAt: split.createdAt,
      ...(splitStopRecord(split, "core")
        ? { coreStop: splitStopRecord(split, "core") } : {}),
      ...(splitStopRecord(split, "runner")
        ? { runnerStop: splitStopRecord(split, "runner") } : {}),
      ...overrides,
    };
  }

  function checkSplitPosition(request, evidence, expectedQuantity = request.totalQuantity) {
    const position = evidence?.position;
    if (!validObject(evidence) || evidence.verified !== true ||
        evidence.status !== "filled" || !validObject(position) ||
        position.verified !== true || position.symbol !== request.symbol ||
        position.positionId !== request.positionId ||
        Math.abs(Number(position.quantity) - Number(expectedQuantity)) >
          Math.max(1e-10, Number(request.totalQuantity) * 1e-8)) {
      throw new Error("impulse_split_position_not_verified");
    }
  }

  function checkSplitStop(request, evidence, tranche) {
    checkSplitPosition(request, evidence);
    const stop = evidence?.protectiveStops?.[tranche];
    const expected = request[`${tranche}Stop`] ?? evidence?.stop;
    const expectedPrice = tranche === "core"
      ? request.signalStopPrice : request.breakEvenPrice;
    const expectedQuantity = tranche === "core"
      ? request.coreQuantity : request.runnerQuantity;
    if (!validObject(expected) || typeof expected.orderId !== "string" ||
        expected.orderId.trim() === "" || !validObject(stop) ||
        stop.verified !== true || stop.orderId !== expected.orderId ||
        stop.positionId !== request.positionId ||
        Number(stop.quantity) !== Number(expectedQuantity) ||
        Number(stop.stopPrice) !== Number(expectedPrice) ||
        request.operation !== "cancel_original_stop" &&
          (!validObject(evidence.stop) || evidence.stop.orderId !== expected.orderId ||
           Number(evidence.stop.quantity) !== Number(expectedQuantity) ||
           Number(evidence.stop.stopPrice) !== Number(expectedPrice))) {
      throw new Error(`impulse_${tranche}_split_stop_identity_not_verified`);
    }
    return {
      tranche,
      orderId: expected.orderId,
      positionId: request.positionId,
      quantity: String(expectedQuantity),
      stopPrice: String(expectedPrice),
    };
  }

  function nextSplitPosition(state, request, evidence) {
    const split = { ...state.split };
    let position;
    if (request.operation === "split_core_stop") {
      split.coreStop = checkSplitStop(request, evidence, "core");
      split.stage = "runner_pending";
      split.baselineOpenOrderIds = [
        ...split.baselineOpenOrderIds, split.coreStop.orderId,
      ].sort();
      position = { ...state, status: "closing", executionStatus: "impulse_split_runner_pending" };
    } else if (request.operation === "split_runner_stop") {
      split.runnerStop = checkSplitStop(request, evidence, "runner");
      split.stage = "cancel_original_pending";
      split.baselineOpenOrderIds = [
        ...split.baselineOpenOrderIds, split.runnerStop.orderId,
      ].sort();
      position = { ...state, status: "closing", executionStatus: "impulse_split_cancel_original_pending" };
    } else if (request.operation === "cancel_original_stop") {
      checkSplitPosition(request, evidence);
      const coreStop = checkSplitStop(request, evidence, "core");
      const runnerStop = checkSplitStop(request, evidence, "runner");
      const policy = {
        ...state.policy,
        status: "open",
        coreQty: Number(split.coreQuantity),
        runnerQty: Number(split.runnerQuantity),
        coreOpen: true,
        runnerOpen: true,
        remainingQty: Number(split.totalQuantity),
        stopPrice: Number(split.signalStopPrice),
        runnerStopPrice: Number(split.actualEntryBreakEvenPrice),
      };
      split.coreStop = coreStop;
      split.runnerStop = runnerStop;
      split.baselineOpenOrderIds = [coreStop.orderId, runnerStop.orderId].sort();
      split.stage = "complete";
      split.activeLegs = ["core", "runner"];
      delete split.cancelOriginalRecoveryPhase;
      position = {
        ...policy,
        sourceSignalId: recordIdFor(state),
        symbol: state.symbol,
        status: "open",
        executionStatus: "open",
        exchangePositionId: split.positionId,
        entryOrderId: split.entryOrderId,
        entryClientOrderId: state.entryClientOrderId,
        ...(state.entryOrderType !== undefined
          ? { entryOrderType: state.entryOrderType } : {}),
        ...(validObject(state.verifiedFill)
          ? { verifiedFill: state.verifiedFill } : {}),
        signalSnapshot: state.signalSnapshot,
        originalStopOrderId: split.originalStopOrderId,
        originalStopPositionId: split.positionId,
        originalStopQuantity: Number(split.totalQuantity),
        coreStopOrderId: coreStop.orderId,
        coreStopPositionId: split.positionId,
        coreStopQuantity: Number(coreStop.quantity),
        coreStopStartedAt: split.createdAt,
        runnerStopOrderId: runnerStop.orderId,
        runnerStopPositionId: split.positionId,
        runnerStopQuantity: Number(runnerStop.quantity),
        runnerStopStartedAt: split.createdAt,
        verifiedProtectiveStops: {
          core: { verified: true, ...coreStop },
          runner: { verified: true, ...runnerStop },
        },
        baselineOpenOrderIds: [...split.baselineOpenOrderIds],
        split,
        sizing: state.sizing,
        marginMode: PROFILE_MARGIN,
        leverage: PROFILE_LEVERAGE,
        environment: "vst",
      };
    } else {
      throw new Error("unsupported_impulse_split_stage");
    }
    if (request.operation !== "cancel_original_stop") {
      position.split = split;
    }
    position.sourceSignalId = state.sourceSignalId;
    position.symbol = state.symbol;
    position.sizing = state.sizing;
    position.marginMode = PROFILE_MARGIN;
    position.leverage = PROFILE_LEVERAGE;
    position.environment = "vst";
    position.accountId = state.accountId;
    position.entryClientOrderId = state.entryClientOrderId;
    return position;
  }

  function validateSplitUpgradePosition(request, evidence) {
    const position = evidence?.position;
    if (!validObject(evidence) || evidence.verified !== true ||
        evidence.status !== "filled" || !validObject(position) ||
        position.verified !== true || position.symbol !== request.symbol ||
        position.positionId !== request.positionId ||
        position.side !== "Buy" || Number(position.leverage) !== PROFILE_LEVERAGE ||
        !profileMarginIs(position.marginMode) ||
        Number(position.quantity) !== Number(request.totalQuantity)) {
      throw new Error("impulse_split_upgrade_position_not_verified");
    }
  }

  function checkSplitUpgradePlacement(request, evidence, clientOrderId) {
    validateSplitUpgradePosition(request, evidence);
    const { leg, oldStop, otherStop } = request;
    const placed = evidence.newStop;
    const oldObserved = evidence.oldStop;
    const upgradedObserved = evidence.protectiveStops?.[leg];
    const otherLeg = leg === "core" ? "runner" : "core";
    const otherObserved = evidence.protectiveStops?.[otherLeg];
    if (!["core", "runner"].includes(leg) ||
        request.upgradeIntentId !== clientOrderId ||
        evidence.upgradeIntentId !== clientOrderId ||
        evidence.clientOrderId !== placed?.clientOrderId ||
        !validObject(oldStop) || !validObject(otherStop) ||
        !validObject(oldObserved) ||
        oldStop.tranche !== leg || otherStop.tranche !== otherLeg ||
        !validObject(placed) || placed.verified !== true ||
        placed.tranche !== leg || placed.positionId !== request.positionId ||
        typeof placed.orderId !== "string" || placed.orderId.trim() === "" ||
        typeof placed.clientOrderId !== "string" || placed.clientOrderId.trim() === "" ||
        placed.orderId === oldStop.orderId || placed.orderId === otherStop.orderId ||
        Number(placed.quantity) !== Number(oldStop.quantity) ||
        Number(placed.stopPrice) !== Number(request.newStopPrice) ||
        Number(request.newStopPrice) <= Number(oldStop.stopPrice) ||
        oldObserved?.orderId !== oldStop.orderId ||
        oldObserved.tranche !== leg ||
        Number(oldObserved.quantity) !== Number(oldStop.quantity) ||
        Number(oldObserved.stopPrice) !== Number(oldStop.stopPrice) ||
        upgradedObserved?.verified !== true ||
        upgradedObserved.orderId !== placed.orderId ||
        upgradedObserved.positionId !== request.positionId ||
        Number(upgradedObserved.quantity) !== Number(placed.quantity) ||
        Number(upgradedObserved.stopPrice) !== Number(placed.stopPrice) ||
        otherObserved?.verified !== true || otherObserved.orderId !== otherStop.orderId ||
        otherObserved.positionId !== request.positionId ||
        Number(otherObserved.quantity) !== Number(otherStop.quantity) ||
        Number(otherObserved.stopPrice) !== Number(otherStop.stopPrice) ||
        evidence.oldStop?.orderId !== oldStop.orderId ||
        evidence.otherStop?.orderId !== otherStop.orderId) {
      throw new Error("impulse_split_upgrade_place_evidence_not_verified");
    }
    return {
      tranche: leg,
      orderId: placed.orderId,
      quantity: String(oldStop.quantity),
      stopPrice: String(request.newStopPrice),
      clientOrderId: placed.clientOrderId,
    };
  }

  function checkSplitUpgradeCancellation(request, evidence) {
    validateSplitUpgradePosition(request, evidence);
    const { leg, oldStop, otherStop, newStop } = request;
    const otherLeg = leg === "core" ? "runner" : "core";
    const upgradedObserved = evidence.protectiveStops?.[leg];
    const otherObserved = evidence.protectiveStops?.[otherLeg];
    const upgraded = evidence.newStop;
    if (!validObject(newStop) || evidence.upgradeIntentId !== request.upgradeIntentId ||
        evidence.canceledStopOrderId !== oldStop?.orderId ||
        !validObject(upgraded) || upgraded.verified !== true ||
        upgraded.tranche !== leg || upgraded.orderId !== newStop.orderId ||
        upgraded.clientOrderId !== newStop.clientOrderId ||
        Number(upgraded.quantity) !== Number(newStop.quantity) ||
        Number(upgraded.stopPrice) !== Number(newStop.stopPrice) ||
        upgradedObserved?.verified !== true || upgradedObserved.orderId !== newStop.orderId ||
        upgradedObserved.positionId !== request.positionId ||
        Number(upgradedObserved.quantity) !== Number(newStop.quantity) ||
        Number(upgradedObserved.stopPrice) !== Number(newStop.stopPrice) ||
        !validObject(evidence.otherStop) ||
        evidence.otherStop.orderId !== otherStop?.orderId ||
        otherObserved?.verified !== true || otherObserved.orderId !== otherStop.orderId ||
        otherObserved.positionId !== request.positionId ||
        Number(otherObserved.quantity) !== Number(otherStop.quantity) ||
        Number(otherObserved.stopPrice) !== Number(otherStop.stopPrice)) {
      throw new Error("impulse_split_upgrade_cancel_evidence_not_verified");
    }
    return { ...newStop };
  }

  function stagedSplitUpgradePosition(state, request, evidence, clientOrderId) {
    const newStop = checkSplitUpgradePlacement(request, evidence, clientOrderId);
    const split = {
      ...state.split,
      upgradePending: {
        stage: "cancel_old_pending",
        leg: request.leg,
        oldStop: { ...request.oldStop },
        otherStop: { ...request.otherStop },
        newStop,
        newStopPrice: String(request.newStopPrice),
        upgradeIntentId: clientOrderId,
        pendingPolicy: request.pendingPolicy,
        placedAt: Number(clock()),
      },
    };
    return {
      ...state,
      status: "open",
      executionStatus: `impulse_${request.leg}_stop_upgrade_cancel_pending`,
      split,
    };
  }

  function completedSplitUpgradePosition(state, request, evidence) {
    const pending = state.split?.upgradePending;
    const newStop = checkSplitUpgradeCancellation(request, evidence);
    if (!pending || pending.stage !== "cancel_old_pending" ||
        pending.leg !== request.leg ||
        pending.upgradeIntentId !== request.upgradeIntentId ||
        pending.newStop?.orderId !== newStop.orderId ||
        pending.newStop?.clientOrderId !== newStop.clientOrderId ||
        pending.oldStop?.orderId !== request.oldStop?.orderId ||
        pending.otherStop?.orderId !== request.otherStop?.orderId) {
      throw new Error("impulse_split_upgrade_persisted_phase_mismatch");
    }
    const policy = {
      ...state,
      ...pending.pendingPolicy,
      status: "open",
      executionStatus: "open",
    };
    const split = {
      ...state.split,
      [request.leg === "core" ? "coreStop" : "runnerStop"]: newStop,
      baselineOpenOrderIds: [newStop.orderId, request.otherStop.orderId].sort(),
    };
    delete split.upgradePending;
    const coreStop = request.leg === "core" ? newStop : request.otherStop;
    const runnerStop = request.leg === "runner" ? newStop : request.otherStop;
    policy.split = split;
    policy.baselineOpenOrderIds = [...split.baselineOpenOrderIds];
    policy.verifiedProtectiveStops = {
      core: { verified: true, ...coreStop },
      runner: { verified: true, ...runnerStop },
    };
    policy.coreStopOrderId = coreStop.orderId;
    policy.coreStopPositionId = request.positionId;
    policy.coreStopQuantity = Number(coreStop.quantity);
    policy.runnerStopOrderId = runnerStop.orderId;
    policy.runnerStopPositionId = request.positionId;
    policy.runnerStopQuantity = Number(runnerStop.quantity);
    if (request.leg === "core") policy.coreStopStartedAt = Number(clock());
    else policy.runnerStopStartedAt = Number(clock());
    return policy;
  }

  function completedRunnerCleanupPosition(request, evidence, clientOrderId) {
    const prior = request.priorPosition;
    const cleanup = prior?.split?.runnerCleanup;
    const coreStop = cleanup?.coreStop;
    const position = evidence?.position;
    const survivingCore = evidence?.protectiveStops?.core;
    if (!validObject(cleanup) || cleanup.stage !== "cancel_original_pending" ||
        request.intentId !== clientOrderId ||
        evidence?.verified !== true || evidence.status !== "filled" ||
        evidence.canceledOriginalStopOrderId !== cleanup.originalStopOrderId ||
        evidence.runnerStopOrderId !== cleanup.parentStopId ||
        evidence.runnerChildOrderId !== cleanup.childOrderId ||
        evidence.cancellationIntentId !== clientOrderId ||
        !validObject(position) || position.verified !== true ||
        position.symbol !== prior.symbol ||
        position.positionId !== prior.exchangePositionId ||
        Number(position.quantity) !== Number(cleanup.remainingQuantity) ||
        !validObject(survivingCore) || survivingCore.verified !== true ||
        survivingCore.orderId !== coreStop?.orderId ||
        survivingCore.positionId !== prior.exchangePositionId ||
        Number(survivingCore.quantity) !== Number(cleanup.remainingQuantity) ||
        Number(survivingCore.stopPrice) !== Number(prior.stopPrice)) {
      throw new Error("impulse_runner_cleanup_cancellation_evidence_not_verified");
    }
    const split = {
      ...prior.split,
      stage: "complete",
      runnerCleanup: null,
      runnerStop: null,
      coreStop: { ...coreStop, quantity: String(cleanup.remainingQuantity) },
      activeLegs: ["core"],
      baselineOpenOrderIds: [coreStop.orderId],
    };
    const nextPosition = {
      ...prior,
      status: "open",
      executionStatus: "open",
      coreOpen: true,
      coreQty: Number(cleanup.remainingQuantity),
      runnerOpen: false,
      runnerQty: 0,
      remainingQty: Number(cleanup.remainingQuantity),
      lastCloseFill: cleanup.fill,
      split,
      coreStopOrderId: coreStop.orderId,
      coreStopPositionId: prior.exchangePositionId,
      coreStopQuantity: Number(cleanup.remainingQuantity),
      runnerStopOrderId: null,
      runnerStopPositionId: null,
      runnerStopQuantity: 0,
      verifiedProtectiveStops: {
        core: { verified: true, ...split.coreStop },
      },
      baselineOpenOrderIds: [coreStop.orderId],
    };
    return nextPosition;
  }

  async function commitRunnerCleanup(intent, request, evidence) {
    const position = await withFreshPersistedSplitPosition(completedRunnerCleanupPosition(
      request, evidence, intent.clientOrderId,
    ));
    if (!position.persistedPosition) {
      throw new Error("impulse_runner_cleanup_persisted_position_not_verified");
    }
    await store.commitVerifiedIntent({
      sourceSignalId: intent.sourceSignalId,
      clientOrderId: intent.clientOrderId,
      position,
      signalStatus: "open",
      exchangeOrderId: evidence.runnerChildOrderId,
      outcome: {
        status: "filled",
        verified: true,
        operation: "cancel_original_after_runner_fill",
        canceledOriginalStopOrderId: evidence.canceledOriginalStopOrderId,
        runnerStopOrderId: evidence.runnerStopOrderId,
        runnerChildOrderId: evidence.runnerChildOrderId,
        cancellationIntentId: evidence.cancellationIntentId,
        remainingQuantity: String(position.remainingQty),
        coreStop: position.split.coreStop,
      },
      eventKind: "vst_impulse_runner_cleanup_completed",
      eventDetail: {
        positionId: request.positionId,
        runnerStopOrderId: evidence.runnerStopOrderId,
        runnerChildOrderId: evidence.runnerChildOrderId,
        canceledOriginalStopOrderId: evidence.canceledOriginalStopOrderId,
        coreStopOrderId: position.split.coreStop.orderId,
        remainingQuantity: String(position.remainingQty),
      },
    });
    return position;
  }

  async function commitSplitUpgradePlace(intent, request, evidence) {
    const position = stagedSplitUpgradePosition(
      request.priorPosition, request, evidence, intent.clientOrderId,
    );
    // The adapter's persisted snapshot shape has one record per tranche. The
    // verified place-before-cancel window has two core (or runner) stops, so it
    // cannot be represented without mislabeling one of them.
    position.persistedPosition = null;
    await store.commitVerifiedIntent({
      sourceSignalId: intent.sourceSignalId,
      clientOrderId: intent.clientOrderId,
      position,
      signalStatus: "open",
      exchangeOrderId: evidence.newStop.orderId,
      outcome: {
        status: "filled",
        verified: true,
        operation: request.operation,
        upgradeIntentId: intent.clientOrderId,
        leg: request.leg,
        oldStop: request.oldStop,
        otherStop: request.otherStop,
        newStop: position.split.upgradePending.newStop,
        stage: "cancel_old_pending",
      },
      eventKind: "vst_impulse_split_stop_upgrade_placed",
      eventDetail: {
        leg: request.leg,
        oldStopOrderId: request.oldStop.orderId,
        newStopOrderId: evidence.newStop.orderId,
        upgradeIntentId: intent.clientOrderId,
      },
    });
    return position;
  }

  async function commitSplitUpgradeCancel(intent, request, evidence) {
    const position = await withFreshPersistedSplitPosition(completedSplitUpgradePosition(
      request.priorPosition, request, evidence,
    ));
    if (!position.persistedPosition) {
      throw new Error("impulse_split_stop_upgrade_persisted_position_not_verified");
    }
    await store.commitVerifiedIntent({
      sourceSignalId: intent.sourceSignalId,
      clientOrderId: intent.clientOrderId,
      position,
      signalStatus: "open",
      exchangeOrderId: evidence.newStop.orderId,
      outcome: {
        status: "filled",
        verified: true,
        operation: request.operation,
        leg: request.leg,
        canceledStopOrderId: request.oldStop.orderId,
        upgradeIntentId: request.upgradeIntentId,
        newStop: evidence.newStop,
        otherStop: request.otherStop,
        stage: "complete",
      },
      eventKind: "vst_impulse_split_stop_upgrade_completed",
      eventDetail: {
        leg: request.leg,
        canceledStopOrderId: request.oldStop.orderId,
        newStopOrderId: evidence.newStop.orderId,
        upgradeIntentId: request.upgradeIntentId,
      },
    });
    return position;
  }

  function recordIdFor(state) {
    return state.sourceSignalId;
  }

  async function commitImpulsePhase(intent, request, evidence, nextPosition) {
    nextPosition = await withFreshPersistedSplitPosition(nextPosition);
    if (!nextPosition.persistedPosition) {
      throw new Error("impulse_split_phase_persisted_position_not_verified");
    }
    const outcome = {
      status: "filled",
      verified: true,
      operation: request.operation,
      positionId: request.positionId,
      stage: nextPosition.split?.stage ?? "complete",
      coreStop: nextPosition.split?.coreStop ?? null,
      runnerStop: nextPosition.split?.runnerStop ?? null,
      originalStopOrderId: request.originalStopOrderId,
    };
    await store.commitVerifiedIntent({
      sourceSignalId: intent.sourceSignalId,
      clientOrderId: intent.clientOrderId,
      position: nextPosition,
      signalStatus: nextPosition.split?.stage === "complete" ? "open" : "opening",
      exchangeOrderId: evidence.exchangeOrderId ?? evidence.stop?.orderId ?? null,
      outcome,
      eventKind: "vst_impulse_split_phase_verified",
      eventDetail: {
        operation: request.operation,
        stage: nextPosition.split?.stage ?? "complete",
        positionId: request.positionId,
      },
    });
  }

  async function advanceImpulseSplit(record, state, allowActions) {
    if (record.status === "unknown" || !validObject(state.split) ||
        !["core_pending", "runner_pending", "cancel_original_pending"]
          .includes(state.split.stage)) {
      await store.setSignalStatus(record.sourceSignalId, "unknown",
        "impulse_split_stage_unverified");
      return { kind: "unknown", reason: "impulse_split_stage_unverified" };
    }
    if (!allowActions) {
      return { kind: "waiting", reason: "verified_mutation_capabilities_unavailable" };
    }
    const stage = state.split.stage;
    const operation = stage === "core_pending" ? "split_core_stop"
      : stage === "runner_pending" ? "split_runner_stop" : "cancel_original_stop";
    const retryPhase = state.split.cancelOriginalRecoveryPhase;
    if (stage === "cancel_original_pending" && retryPhase !== undefined &&
        (typeof retryPhase !== "string" ||
          !/^impulse-cancel_original_stop-retry-\d+$/.test(retryPhase))) {
      const reason = "impulse_split_stage_unverified";
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      return { kind: "unknown", reason };
    }
    const phase = stage === "cancel_original_pending" && retryPhase
      ? retryPhase : `impulse-${operation}`;
    let request = impulseSplitRequest(record, state, operation, {
      signal: record.body ?? state.signalSnapshot,
      position: { positionId: state.split.positionId },
      priorPosition: state,
    });
    // This is an account-wide proof read. Its failure remains tick-wide;
    // only the subsequent symbol-scoped position/mark observations may be
    // isolated to this position.
    const accountState = await broker.readAccountState();
    const persistedPosition = persistedSplitPosition(state, accountState);
    let exchangePosition;
    try {
      exchangePosition = await broker.readPosition(state.symbol, {
        persistedPosition,
        allowProcessCache: false,
      });
    } catch (error) {
      const diagnostic = recordVstDiagnostic(error, {
        stage: "positionManagement", operation: "read_position",
        check: "position_row", symbol: state.symbol,
        sourceSignalId: record.sourceSignalId,
      });
      if (isCanonicalVstSymbol(state.symbol) &&
          isBoundedPositionReadFailure(error)) {
        notePositionReadIssue(
          record.sourceSignalId, state.symbol, operation, diagnostic,
        );
        return {
          kind: "unknown",
          reason: "managed_position_read_unavailable",
          scope: "symbol",
          diagnosticRef: diagnostic.ref,
        };
      }
      throw error;
    }
    if (persistedPosition) request.persistedPosition = persistedPosition;
    const rows = symbolOrders(accountState, state.symbol);
    const currentIds = rows
      ? rows.map((row) => row.orderId ?? row.orderID)
        .filter((id) => typeof id === "string").sort()
      : null;
    const expectedQuantity = Number(state.split.totalQuantity);
    const positionValid = validObject(exchangePosition) &&
      exchangePosition.verified === true &&
      exchangePosition.symbol === state.symbol &&
      exchangePosition.positionId === state.split.positionId &&
      Number(exchangePosition.quantity) === expectedQuantity;
    const expectedIds = [...state.split.baselineOpenOrderIds].sort();
    const originalStop = exactRawSplitStop(state, accountState, {
      orderId: state.split.originalStopOrderId,
      quantity: state.split.totalQuantity,
      stopPrice: state.split.signalStopPrice,
    });
    const splitCoreStop = exactRawSplitStop(
      state, accountState, state.split.coreStop,
    );
    const splitRunnerStop = exactRawSplitStop(
      state, accountState, state.split.runnerStop,
    );
    let stopFactsValid = false;
    if (stage === "core_pending") {
      stopFactsValid = originalStop?.verified === true &&
        originalStop.quantity === expectedQuantity &&
        originalStop.stopPrice === Number(state.split.signalStopPrice);
    } else {
      stopFactsValid = originalStop?.verified === true &&
        splitCoreStop?.verified === true &&
        splitCoreStop.quantity === Number(state.split.coreQuantity) &&
        splitCoreStop.stopPrice === Number(state.split.signalStopPrice);
      if (stage === "cancel_original_pending") {
        stopFactsValid = stopFactsValid && splitRunnerStop?.verified === true &&
          splitRunnerStop.quantity === Number(state.split.runnerQuantity) &&
          splitRunnerStop.stopPrice === Number(state.split.breakEvenPrice);
      }
    }
    if (!positionValid || !stopFactsValid || !currentIds ||
        JSON.stringify(currentIds) !== JSON.stringify(expectedIds)) {
      const openOrderIdsMatch = Boolean(currentIds) &&
        JSON.stringify(currentIds) === JSON.stringify(expectedIds);
      const proofEvidence = safeVstProofEvidence("split_preflight", () => ({
        positionValid: { expected: true, actual: positionValid, matches: positionValid },
        stopFactsValid: { expected: true, actual: stopFactsValid, matches: stopFactsValid },
        openOrderIdsMatch: {
          expected: true, actual: openOrderIdsMatch, matches: openOrderIdsMatch,
        },
        accountMatches: {
          expected: true, actual: state.accountId === accountState.accountId,
          matches: state.accountId === accountState.accountId,
        },
        environmentMatches: {
          expected: true, actual: accountState.environment === "vst",
          matches: accountState.environment === "vst",
        },
        positionVerified: {
          expected: true, actual: exchangePosition?.verified,
          matches: exchangePosition?.verified === true,
        },
        symbol: {
          expected: state.symbol, actual: exchangePosition?.symbol,
          matches: exchangePosition?.symbol === state.symbol,
        },
        side: { expected: "Buy", actual: exchangePosition?.side,
          matches: exchangePosition?.side === "Buy" },
        leverage: { expected: 10, actual: exchangePosition?.leverage,
          matches: Number(exchangePosition?.leverage) === PROFILE_LEVERAGE },
        positionId: {
          expected: state.split.positionId, actual: exchangePosition?.positionId,
          matches: exchangePosition?.positionId === state.split.positionId,
        },
        quantity: {
          expected: expectedQuantity, actual: exchangePosition?.quantity,
          matches: Number(exchangePosition?.quantity) === expectedQuantity,
        },
        positionQuantity: {
          expected: expectedQuantity, actual: exchangePosition?.quantity,
          matches: Number(exchangePosition?.quantity) === expectedQuantity,
        },
        originalStopVerified: {
          expected: true, actual: originalStop?.verified,
          matches: originalStop?.verified === true,
        },
        originalOrderId: {
          expected: state.split.originalStopOrderId, actual: originalStop?.orderId,
          matches: originalStop?.orderId === state.split.originalStopOrderId,
        },
        originalPositionId: {
          expected: state.split.positionId, actual: originalStop?.positionId,
          matches: originalStop?.positionId === state.split.positionId,
        },
        originalStopQuantity: {
          expected: state.split.totalQuantity, actual: originalStop?.quantity,
          matches: Number(originalStop?.quantity) === expectedQuantity,
        },
        originalStopPrice: {
          expected: state.split.signalStopPrice, actual: originalStop?.stopPrice,
          matches: Number(originalStop?.stopPrice) === Number(state.split.signalStopPrice),
        },
        coreVerified: {
          expected: stage === "core_pending" ? undefined : true,
          actual: splitCoreStop?.verified,
          applicable: stage !== "core_pending",
          matches: stage === "core_pending" || splitCoreStop?.verified === true,
        },
        coreOrderId: {
          expected: state.split.coreStop?.orderId, actual: splitCoreStop?.orderId,
          applicable: stage !== "core_pending",
          matches: stage === "core_pending" ||
            splitCoreStop?.orderId === state.split.coreStop?.orderId,
        },
        corePositionId: {
          expected: state.split.positionId, actual: splitCoreStop?.positionId,
          applicable: stage !== "core_pending",
          matches: stage === "core_pending" ||
            splitCoreStop?.positionId === state.split.positionId,
        },
        coreQuantity: {
          expected: state.split.coreQuantity, actual: splitCoreStop?.quantity,
          applicable: stage !== "core_pending",
          matches: stage === "core_pending" ||
            Number(splitCoreStop?.quantity) === Number(state.split.coreQuantity),
        },
        coreStopPrice: {
          expected: state.split.signalStopPrice, actual: splitCoreStop?.stopPrice,
          applicable: stage !== "core_pending",
          matches: stage === "core_pending" ||
            Number(splitCoreStop?.stopPrice) === Number(state.split.signalStopPrice),
        },
        runnerVerified: {
          expected: stage === "cancel_original_pending" ? true : undefined,
          actual: splitRunnerStop?.verified,
          applicable: stage === "cancel_original_pending",
          matches: stage !== "cancel_original_pending" ||
            splitRunnerStop?.verified === true,
        },
        runnerOrderId: {
          expected: state.split.runnerStop?.orderId, actual: splitRunnerStop?.orderId,
          applicable: stage === "cancel_original_pending",
          matches: stage !== "cancel_original_pending" ||
            splitRunnerStop?.orderId === state.split.runnerStop?.orderId,
        },
        runnerPositionId: {
          expected: state.split.positionId, actual: splitRunnerStop?.positionId,
          applicable: stage === "cancel_original_pending",
          matches: stage !== "cancel_original_pending" ||
            splitRunnerStop?.positionId === state.split.positionId,
        },
        runnerQuantity: {
          expected: state.split.runnerQuantity, actual: splitRunnerStop?.quantity,
          applicable: stage === "cancel_original_pending",
          matches: stage !== "cancel_original_pending" ||
            Number(splitRunnerStop?.quantity) === Number(state.split.runnerQuantity),
        },
        runnerStopPrice: {
          expected: state.split.breakEvenPrice, actual: splitRunnerStop?.stopPrice,
          applicable: stage === "cancel_original_pending",
          matches: stage !== "cancel_original_pending" ||
            Number(splitRunnerStop?.stopPrice) === Number(state.split.breakEvenPrice),
        },
        openOrderCount: {
          expected: expectedIds.length, actual: currentIds?.length,
          matches: Boolean(currentIds) && currentIds.length === expectedIds.length,
        },
        expectedOpenOrderCount: {
          expected: expectedIds.length, actual: currentIds?.length,
          matches: Boolean(currentIds) && currentIds.length === expectedIds.length,
        },
        currentOrderIds: {
          expected: expectedIds, actual: currentIds,
          matches: openOrderIdsMatch,
        },
        expectedOrderIds: {
          expected: expectedIds, actual: currentIds,
          matches: openOrderIdsMatch,
        },
      }));
      const check = !positionValid ? "position_row"
        : !stopFactsValid ? "protective_stop" : "ownership";
      const diagnostic = recordVstRefusal(
        !positionValid ? "position_unverified"
          : !stopFactsValid ? "stop_unverified" : "position_identity_mismatch",
        { stage: "positionManagement", operation: "read_position",
          check, symbol: state.symbol, sourceSignalId: record.sourceSignalId,
          ...(proofEvidence ? { proofEvidence } : {}) },
      );
      const reason = stage === "runner_pending"
        ? "impulse_runner_abort_original_stop_or_full_position_unverified"
        : "impulse_split_preflight_state_mismatch";
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      await store.upsertPosition({
        ...state, sourceSignalId: record.sourceSignalId, status: "unknown",
      });
      return attachVstResultDiagnostic(
        { kind: "unknown", reason, diagnosticRef: diagnostic.ref }, diagnostic,
      );
    }
    if (operation === "split_runner_stop") {
      // Check exact original/core protection before a mark failure is allowed
      // to leave this symbol's management path and let another candidate run.
      let mark;
      try {
        mark = await broker.readMarketMark(state.symbol);
      } catch (error) {
        const diagnostic = recordVstDiagnostic(error, {
          stage: "positionManagement", operation: "read_market_mark",
          check: "market_mark", symbol: state.symbol,
          sourceSignalId: record.sourceSignalId,
        });
        if (error instanceof Error &&
            error.message === "VST mark is not corroborated by a fresh quote") {
          notePositionReadIssue(
            record.sourceSignalId, state.symbol, operation, diagnostic,
          );
          return {
            kind: "waiting",
            reason: "impulse_runner_be_requires_fresh_mark_above_entry",
          };
        }
        if (isCanonicalVstSymbol(state.symbol) &&
            isBoundedPositionReadFailure(error)) {
          notePositionReadIssue(
            record.sourceSignalId, state.symbol, operation, diagnostic,
          );
          return {
            kind: "unknown",
            reason: "managed_position_read_unavailable",
            scope: "symbol",
            diagnosticRef: diagnostic.ref,
          };
        }
        throw error;
      }
      const observedAt = Date.parse(mark?.observedAt ?? "");
      const fillAt = Date.parse(state.verifiedFill?.at ?? "");
      const now = Number(clock());
      if (!validObject(mark) || mark.verified !== true ||
          mark.symbol !== state.symbol || !Number.isFinite(Number(mark.price)) ||
          !Number.isSafeInteger(observedAt) || observedAt > now ||
          now - observedAt > 10_000 || !Number.isSafeInteger(fillAt) ||
          observedAt < fillAt) {
        const diagnostic = recordVstRefusal("market_mark_unverified", {
          stage: "positionManagement", operation: "read_market_mark",
          check: "market_mark", symbol: state.symbol,
          sourceSignalId: record.sourceSignalId,
        });
        notePositionReadIssue(
          record.sourceSignalId, state.symbol, operation, diagnostic,
        );
        return { kind: "waiting", reason: "impulse_runner_be_requires_fresh_mark_above_entry" };
      }
      if (Number(mark.price) <= Number(state.split.actualEntryBreakEvenPrice)) {
        return await abortRunnerBeforeBreakEven(record, state, allowActions, observedAt);
      }
    }
    const submitted = await reserveAndPerform(record.sourceSignalId, phase, request);
    if (submitted.kind !== "submitted") {
      await store.setSignalStatus(record.sourceSignalId, "unknown",
        "impulse_split_intent_requires_reconciliation");
      return { kind: "unknown", reason: "impulse_split_intent_requires_reconciliation" };
    }
    let evidence;
    try {
      evidence = await broker.reconcileIntent({
        clientOrderId: submitted.clientOrderId, phase, request,
        ...(submitted.exchangeOrderId
          ? { exchangeOrderId: submitted.exchangeOrderId } : {}),
      });
      const nextPosition = nextSplitPosition(state, request, evidence);
      await commitImpulsePhase({
        sourceSignalId: record.sourceSignalId,
        clientOrderId: submitted.clientOrderId,
      }, request, evidence, nextPosition);
      return { kind: "acted", operation };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "impulse_split_phase_unverified";
      await store.markIntent(submitted.clientOrderId, "unknown", {
        exchangeOrderId: evidence?.exchangeOrderId ?? null,
        outcome: { reason },
      });
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      await store.upsertPosition({
        ...state, sourceSignalId: record.sourceSignalId, status: "unknown",
      });
      return { kind: "unknown", reason };
    }
  }

  async function advanceSplitUpgradeCancel(record, state, allowActions) {
    const pending = state.split?.upgradePending;
    if (record.status === "unknown" || pending?.stage !== "cancel_old_pending" ||
        !["core", "runner"].includes(pending.leg) ||
        !validObject(pending.newStop) || !validObject(pending.oldStop) ||
        !validObject(pending.otherStop) || !validObject(pending.pendingPolicy)) {
      await store.setSignalStatus(record.sourceSignalId, "unknown",
        "impulse_split_upgrade_stage_unverified");
      return { kind: "unknown", reason: "impulse_split_upgrade_stage_unverified" };
    }
    if (!allowActions) {
      return { kind: "waiting", reason: "verified_mutation_capabilities_unavailable" };
    }
    const accountState = await broker.readAccountState();
    const persistedPosition = persistedSplitPosition(state, accountState);
    const position = await broker.readPosition(state.symbol, {
      persistedPosition,
      allowProcessCache: false,
    });
    const rows = symbolOrders(accountState, state.symbol);
    const currentIds = rows
      ? rows.map((row) => row.orderId ?? row.orderID)
        .filter((id) => typeof id === "string").sort()
      : null;
    const expectedIds = [
      pending.oldStop.orderId, pending.newStop.orderId, pending.otherStop.orderId,
    ].sort();
    const rawNewStop = exactRawSplitStop(state, accountState, pending.newStop);
    const positionValid = validObject(position) && position.verified === true &&
      position.symbol === state.symbol && position.positionId === state.exchangePositionId &&
      Number(position.quantity) === Number(state.split.totalQuantity) &&
      position.side === "Buy" && Number(position.leverage) === PROFILE_LEVERAGE &&
      profileMarginIs(position.marginMode);
    const rawClientId = rows?.find((row) =>
      (row.orderId ?? row.orderID) === pending.newStop.orderId)?.clientOrderId ??
      rows?.find((row) =>
        (row.orderId ?? row.orderID) === pending.newStop.orderId)?.clientOrderID;
    if (!positionValid || !rawNewStop ||
        rawNewStop.orderId !== pending.newStop.orderId ||
        Number(rawNewStop.quantity) !== Number(pending.newStop.quantity) ||
        Number(rawNewStop.stopPrice) !== Number(pending.newStop.stopPrice) ||
        rawClientId !== pending.newStop.clientOrderId ||
        JSON.stringify(currentIds) !== JSON.stringify(expectedIds)) {
      await store.setSignalStatus(record.sourceSignalId, "unknown",
        "impulse_split_upgrade_cancel_preflight_mismatch");
      await store.upsertPosition({
        ...state, sourceSignalId: record.sourceSignalId, status: "unknown",
      });
      return { kind: "unknown", reason: "impulse_split_upgrade_cancel_preflight_mismatch" };
    }
    const phase = `impulse-stop-upgrade-cancel-${pending.leg}-${pending.upgradeIntentId}`;
    const request = impulseSplitRequest(record, state, "split_raise_stop_cancel", {
      leg: pending.leg,
      oldStop: pending.oldStop,
      otherStop: pending.otherStop,
      newStop: pending.newStop,
      newStopPrice: pending.newStopPrice,
      upgradeIntentId: pending.upgradeIntentId,
      priorPosition: state,
      ...(persistedPosition ? { persistedPosition } : {}),
    });
    const submitted = await reserveAndPerform(record.sourceSignalId, phase, request);
    if (submitted.kind !== "submitted") {
      await store.setSignalStatus(record.sourceSignalId, "unknown",
        "impulse_split_upgrade_cancel_requires_reconciliation");
      return { kind: "unknown", reason: "impulse_split_upgrade_cancel_requires_reconciliation" };
    }
    let evidence;
    try {
      evidence = await broker.reconcileIntent({
        clientOrderId: submitted.clientOrderId, phase, request,
      });
      await commitSplitUpgradeCancel({
        sourceSignalId: record.sourceSignalId,
        clientOrderId: submitted.clientOrderId,
      }, request, evidence);
      return { kind: "acted", operation: "split_raise_stop_cancel", leg: pending.leg };
    } catch (error) {
      const reason = error instanceof Error
        ? error.message : "impulse_split_upgrade_cancel_unverified";
      await store.markIntent(submitted.clientOrderId, "unknown", {
        exchangeOrderId: evidence?.exchangeOrderId ?? null,
        outcome: { reason },
      });
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      await store.upsertPosition({
        ...state, sourceSignalId: record.sourceSignalId, status: "unknown",
      });
      return { kind: "unknown", reason };
    }
  }

  async function advanceRunnerFillCleanup(record, state, allowActions) {
    const cleanup = state.split?.runnerCleanup;
    if (record.status === "unknown" ||
        state.split?.stage !== "runner_cleanup_pending" ||
        cleanup?.stage !== "cancel_original_pending" ||
        !["positionId", "parentStopId", "childOrderId", "originalStopOrderId",
          "coreStopOrderId"].every((field) =>
          typeof (field === "positionId" ? state.exchangePositionId :
            field === "parentStopId" ? cleanup.parentStopId :
              field === "childOrderId" ? cleanup.childOrderId :
                field === "originalStopOrderId" ? cleanup.originalStopOrderId :
                  cleanup.coreStopOrderId) === "string")) {
      const reason = "impulse_runner_cleanup_stage_unverified";
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      return { kind: "unknown", reason };
    }
    if (!allowActions) {
      return { kind: "waiting", reason: "verified_mutation_capabilities_unavailable" };
    }
    const accountState = await broker.readAccountState();
    const persistedPosition = persistedSplitPosition(state, accountState);
    const position = await broker.readPosition(state.symbol, {
      persistedPosition,
      allowProcessCache: false,
    });
    const orders = symbolOrders(accountState, state.symbol);
    const expectedIds = [
      cleanup.originalStopOrderId, cleanup.coreStopOrderId,
    ].sort();
    const currentIds = Array.isArray(orders)
      ? orders.map((row) => row.orderId ?? row.orderID)
        .filter((id) => typeof id === "string").sort()
      : null;
    const exactOrder = (id, quantity, stopPrice) => {
      const matches = orders?.filter((row) =>
        (row.orderId ?? row.orderID) === id &&
        row.type === "STOP_MARKET" &&
        row.status === "NEW" &&
        row.side === "SELL" &&
        row.positionSide === "LONG" &&
        (row.positionId ?? row.positionID) === state.exchangePositionId &&
        Number(row.origQty ?? row.quantity) === Number(quantity) &&
        Number(row.stopPrice) === Number(stopPrice));
      return matches?.length === 1;
    };
    if (!validObject(position) || position.verified !== true ||
        position.symbol !== state.symbol ||
        position.positionId !== state.exchangePositionId ||
        Number(position.quantity) !== Number(cleanup.remainingQuantity) ||
        position.side !== "Buy" || Number(position.leverage) !== PROFILE_LEVERAGE ||
        !profileMarginIs(position.marginMode) ||
        JSON.stringify(currentIds) !== JSON.stringify(expectedIds) ||
        !exactOrder(cleanup.originalStopOrderId, cleanup.remainingQuantity, state.stopPrice) ||
        !exactOrder(cleanup.coreStopOrderId, cleanup.remainingQuantity, state.stopPrice)) {
      const reason = "impulse_runner_cleanup_two_stop_preflight_mismatch";
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      await store.upsertPosition({
        ...state, sourceSignalId: record.sourceSignalId, status: "unknown",
      });
      return { kind: "unknown", reason };
    }
    const expectedRecoveryPhase =
      `impulse-runner-cancel-recovery-${cleanup.childOrderId}`;
    const expectedSecondRecoveryPhase =
      `impulse-runner-cancel-recovery-2-${cleanup.childOrderId}`;
    if (cleanup.recoveryPhase !== undefined &&
        cleanup.recoveryPhase !== expectedRecoveryPhase &&
        cleanup.recoveryPhase !== expectedSecondRecoveryPhase) {
      const reason = "impulse_runner_cleanup_recovery_phase_mismatch";
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      await store.upsertPosition({
        ...state, sourceSignalId: record.sourceSignalId, status: "unknown",
      });
      return { kind: "unknown", reason };
    }
    const phase = cleanup.recoveryPhase === expectedRecoveryPhase ||
      cleanup.recoveryPhase === expectedSecondRecoveryPhase
      ? cleanup.recoveryPhase
      : `impulse-runner-cancel-original-${cleanup.childOrderId}`;
    const cancellationIntentId = orderId(record.sourceSignalId, phase);
    const request = {
      operation: "cancel_original_after_runner_fill",
      environment: "vst",
      accountId: state.accountId,
      sourceSignalId: record.sourceSignalId,
      symbol: state.symbol,
      positionId: state.exchangePositionId,
      runnerStopOrderId: cleanup.parentStopId,
      runnerChildOrderId: cleanup.childOrderId,
      originalStopOrderId: cleanup.originalStopOrderId,
      coreStopOrderId: cleanup.coreStopOrderId,
      totalQuantity: String(state.split.totalQuantity),
      remainingQuantity: cleanup.remainingQuantity,
      signalStopPrice: String(state.stopPrice),
      breakEvenPrice: String(state.split.actualEntryBreakEvenPrice),
      intentId: cancellationIntentId,
      priorPosition: state,
      ...(persistedPosition ? { persistedPosition } : {}),
    };
    const submitted = await reserveAndPerform(
      record.sourceSignalId, phase, request,
    );
    if (submitted.kind !== "submitted") {
      await store.setSignalStatus(record.sourceSignalId, "unknown",
        "impulse_runner_cleanup_requires_reconciliation");
      return { kind: "unknown", reason: "impulse_runner_cleanup_requires_reconciliation" };
    }
    let evidence;
    try {
      evidence = await broker.reconcileIntent({
        clientOrderId: submitted.clientOrderId, phase, request,
      });
      await commitRunnerCleanup({
        sourceSignalId: record.sourceSignalId,
        clientOrderId: submitted.clientOrderId,
      }, request, evidence);
      return { kind: "acted", operation: "cancel_original_after_runner_fill" };
    } catch (error) {
      const reason = error instanceof Error
        ? error.message : "impulse_runner_cleanup_unverified";
      await store.markIntent(submitted.clientOrderId, "unknown", {
        exchangeOrderId: evidence?.exchangeOrderId ?? null,
        outcome: { reason },
      });
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      await store.upsertPosition({
        ...state, sourceSignalId: record.sourceSignalId, status: "unknown",
      });
      return { kind: "unknown", reason };
    }
  }

  async function placeSplitStopUpgrade(record, state, action, observed, capabilities) {
    const leg = action.leg;
    const otherLeg = leg === "core" ? "runner" : "core";
    const oldStop = state.split?.[`${leg}Stop`];
    const otherStop = state.split?.[`${otherLeg}Stop`];
    if (!["core", "runner"].includes(leg) ||
        state.split?.stage !== "complete" ||
        !state.coreOpen || !state.runnerOpen ||
        !validObject(oldStop) || !validObject(otherStop) ||
        typeof store.commitVerifiedIntent !== "function" ||
        !capabilities?.features?.includes("impulse_runner_stop_and_partial_close")) {
      const reason = "impulse_split_stop_upgrade_not_supported_by_verified_broker_contract";
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      await store.upsertPosition({
        ...state, sourceSignalId: record.sourceSignalId, status: "unknown",
      });
      return { kind: "unknown", reason };
    }
    const accountState = await broker.readAccountState();
    const persistedPosition = persistedSplitPosition(state, accountState);
    const exchangePosition = await broker.readPosition(state.symbol, {
      persistedPosition,
      allowProcessCache: false,
    });
    const rows = symbolOrders(accountState, state.symbol);
    const currentIds = rows
      ? rows.map((row) => row.orderId ?? row.orderID)
        .filter((id) => typeof id === "string").sort()
      : null;
    const expectedIds = [oldStop.orderId, otherStop.orderId].sort();
    const oldObserved = exactRawSplitStop(state, accountState, oldStop);
    const otherObserved = exactRawSplitStop(state, accountState, otherStop);
    if (!validObject(exchangePosition) || exchangePosition.verified !== true ||
        exchangePosition.symbol !== state.symbol ||
        exchangePosition.positionId !== state.exchangePositionId ||
        Number(exchangePosition.quantity) !== Number(state.split.totalQuantity) ||
        exchangePosition.side !== "Buy" || Number(exchangePosition.leverage) !== PROFILE_LEVERAGE ||
        !profileMarginIs(exchangePosition.marginMode) ||
        !oldObserved || !otherObserved ||
        JSON.stringify(currentIds) !== JSON.stringify(expectedIds) ||
        !Number.isFinite(Number(action.stopPrice)) ||
        Number(action.stopPrice) <= Number(oldStop.stopPrice)) {
      const reason = "impulse_split_stop_upgrade_preflight_not_verified";
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      await store.upsertPosition({
        ...state, sourceSignalId: record.sourceSignalId, status: "unknown",
      });
      return { kind: "unknown", reason };
    }
    const observedPolicy = intermediatePolicyAfterAction(state, action, observed);
    const phase = `impulse-stop-upgrade-place-${leg}-${Date.parse(observed.observedAt)}`;
    const upgradeIntentId = orderId(record.sourceSignalId, phase);
    const request = impulseSplitRequest(record, state, "split_raise_stop_place", {
      leg,
      oldStop,
      otherStop,
      newStopPrice: action.stopPriceText,
      upgradeIntentId,
      pendingPolicy: observedPolicy,
      priorPosition: state,
      ...(persistedPosition ? { persistedPosition } : {}),
    });
    const submitted = await reserveAndPerform(record.sourceSignalId, phase, request);
    if (submitted.kind !== "submitted") {
      await store.setSignalStatus(record.sourceSignalId, "unknown",
        "impulse_split_stop_upgrade_place_requires_reconciliation");
      return { kind: "unknown", reason: "impulse_split_stop_upgrade_place_requires_reconciliation" };
    }
    let evidence;
    try {
      evidence = await broker.reconcileIntent({
        clientOrderId: submitted.clientOrderId, phase, request,
      });
      await commitSplitUpgradePlace({
        sourceSignalId: record.sourceSignalId,
        clientOrderId: submitted.clientOrderId,
      }, request, evidence);
      return { kind: "acted", operation: "split_raise_stop_place", leg };
    } catch (error) {
      const reason = error instanceof Error
        ? error.message : "impulse_split_stop_upgrade_place_unverified";
      await store.markIntent(submitted.clientOrderId, "unknown", {
        exchangeOrderId: evidence?.exchangeOrderId ?? null,
        outcome: { reason },
      });
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      await store.upsertPosition({
        ...state, sourceSignalId: record.sourceSignalId, status: "unknown",
      });
      return { kind: "unknown", reason };
    }
  }

  async function raiseSoleCoreStop(record, state, action, observed, capabilities) {
    const oldStop = state.split?.coreStop;
    const accountState = await broker.readAccountState();
    const persistedPosition = persistedSplitPosition(state, accountState);
    const position = await broker.readPosition(state.symbol, {
      persistedPosition,
      allowProcessCache: false,
    });
    const orders = symbolOrders(accountState, state.symbol);
    const ids = exactOrderIds(orders);
    const rawStop = exactRawSplitStop(state, accountState, oldStop);
    if (!state.coreOpen || state.runnerOpen || state.split?.stage !== "complete" ||
        !validObject(oldStop) || !rawStop || !Array.isArray(orders) ||
        orders.length !== 1 || !ids || ids[0] !== oldStop.orderId ||
        !validObject(position) || position.verified !== true ||
        position.symbol !== state.symbol ||
        position.positionId !== state.exchangePositionId ||
        Number(position.quantity) !== Number(state.coreQty) ||
        position.side !== "Buy" || Number(position.leverage) !== PROFILE_LEVERAGE ||
        !profileMarginIs(position.marginMode) ||
        Number(action.stopPrice) <= Number(oldStop.stopPrice) ||
        !capabilities?.features?.includes("impulse_runner_stop_and_partial_close") ||
        typeof store.commitVerifiedIntent !== "function") {
      const reason = "impulse_sole_core_stop_upgrade_preflight_not_verified";
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      await store.upsertPosition({
        ...state, sourceSignalId: record.sourceSignalId, status: "unknown",
      });
      return { kind: "unknown", reason };
    }
    const nextPolicy = intermediatePolicyAfterAction(state, action, observed);
    const nextPosition = {
      ...state,
      ...nextPolicy,
      sourceSignalId: record.sourceSignalId,
      status: "open",
      split: { ...state.split },
      sizing: state.sizing,
      marginMode: PROFILE_MARGIN,
      leverage: PROFILE_LEVERAGE,
      environment: "vst",
      accountId: state.accountId,
      entryClientOrderId: state.entryClientOrderId,
    };
    const phase = `impulse-sole-core-stop-${Date.parse(observed.observedAt)}`;
    const request = {
      operation: "raise_stop",
      environment: "vst",
      accountId: state.accountId,
      sourceSignalId: record.sourceSignalId,
      symbol: state.symbol,
      positionId: state.exchangePositionId,
      entryClientOrderId: state.entryClientOrderId,
      ...(state.entryOrderId ? { entryOrderId: state.entryOrderId } : {}),
      ...(state.entryAt !== undefined ? { entryAt: state.entryAt } : {}),
      signal: record.body ?? state.signalSnapshot,
      leg: "core",
      quantity: String(state.coreQty),
      previousQuantity: String(state.remainingQty),
      stopPrice: action.stopPriceText,
      reason: action.reason,
      stopStartedAt: Number(clock()),
      nextPolicy,
      nextPosition,
      priorPosition: state,
      ...(persistedPosition ? { persistedPosition } : {}),
    };
    const entryBinding = await loadRaiseStopEntryProof(
      { sourceSignalId: record.sourceSignalId, request },
      state.exchangePositionId,
    );
    if (!entryBinding) {
      const reason = "raise_stop_original_entry_intent_not_verified";
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      await store.upsertPosition({
        ...state, sourceSignalId: record.sourceSignalId, status: "unknown",
      });
      return { kind: "unknown", reason };
    }
    request.entryProof = entryBinding.proof;
    if (typeof store.commitVerifiedIntent !== "function") {
      const reason = "raise_stop_atomic_commit_unavailable";
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      return { kind: "unknown", reason };
    }
    const submitted = await reserveAndPerform(record.sourceSignalId, phase, request);
    if (submitted.kind !== "submitted") {
      await store.setSignalStatus(record.sourceSignalId, "unknown",
        "impulse_sole_core_stop_upgrade_requires_reconciliation");
      return {
        kind: "unknown",
        reason: "impulse_sole_core_stop_upgrade_requires_reconciliation",
      };
    }
    let evidence;
    try {
      evidence = await broker.reconcileIntent({
        clientOrderId: submitted.clientOrderId, phase, request,
        ...(submitted.exchangeOrderId
          ? { exchangeOrderId: submitted.exchangeOrderId } : {}),
      });
      await commitSoleCoreStopUpgrade({
        sourceSignalId: record.sourceSignalId,
        clientOrderId: submitted.clientOrderId,
        exchangeOrderId: submitted.exchangeOrderId ?? null,
        phase,
      }, request, evidence);
      return { kind: "acted", operation: "raise_stop", leg: "core" };
    } catch (error) {
      const reason = error instanceof Error
        ? error.message : "impulse_sole_core_stop_upgrade_unverified";
      await store.markIntent(submitted.clientOrderId, "unknown", {
        exchangeOrderId: evidence?.exchangeOrderId ?? null,
        outcome: { reason },
      });
      return { kind: "unknown", reason };
    }
  }

  async function advanceImpulseCleanup(record, state, allowActions) {
    const split = state.split;
    const closedLeg = split?.cleanupLeg;
    const retainedLeg = closedLeg === "core" ? "runner" : "core";
    if (record.status === "unknown" || !["core", "runner"].includes(closedLeg) ||
        !split?.[`${closedLeg}Stop`] || !split?.[`${retainedLeg}Stop`] ||
        !validObject(split.pendingClosePolicy) ||
        typeof store.commitVerifiedIntent !== "function") {
      await store.setSignalStatus(record.sourceSignalId, "unknown",
        "impulse_split_cleanup_stage_unverified");
      return { kind: "unknown", reason: "impulse_split_cleanup_stage_unverified" };
    }
    if (!allowActions) {
      return { kind: "waiting", reason: "verified_mutation_capabilities_unavailable" };
    }
    const remainingQuantity = Number(split.cleanupRemainingQuantity);
    const accountState = await broker.readAccountState();
    const persistedPosition = persistedSplitPosition(state, accountState);
    const position = await broker.readPosition(state.symbol, {
      persistedPosition,
      allowProcessCache: false,
    });
    const rows = symbolOrders(accountState, state.symbol);
    const currentIds = rows
      ? rows.map((row) => row.orderId ?? row.orderID)
        .filter((id) => typeof id === "string").sort()
      : null;
    const retainedExpected = split[`${retainedLeg}Stop`];
    const retainedObserved = exactRawSplitStop(state, accountState, retainedExpected);
    const closedExpected = split[`${closedLeg}Stop`];
    const closedObserved = exactRawSplitStop(state, accountState, closedExpected);
    if (!validObject(position) || position.verified !== true ||
        position.symbol !== state.symbol || position.positionId !== split.positionId ||
        Number(position.quantity) !== remainingQuantity ||
        retainedObserved?.verified !== true ||
        retainedObserved.orderId !== retainedExpected.orderId ||
        retainedObserved.positionId !== split.positionId ||
        Number(retainedObserved.quantity) !== remainingQuantity ||
        Number(retainedObserved.stopPrice) !== Number(retainedExpected.stopPrice) ||
        closedObserved?.verified !== true ||
        closedObserved.orderId !== closedExpected.orderId ||
        JSON.stringify(currentIds) !==
          JSON.stringify([...split.baselineOpenOrderIds].sort())) {
      await store.setSignalStatus(record.sourceSignalId, "unknown",
        "impulse_split_cleanup_preflight_state_mismatch");
      await store.upsertPosition({
        ...state, sourceSignalId: record.sourceSignalId, status: "unknown",
      });
      return { kind: "unknown", reason: "impulse_split_cleanup_preflight_state_mismatch" };
    }
    const phase = `impulse-cancel-split-${closedLeg}`;
    const request = impulseSplitRequest(record, state, "cancel_split_stop", {
      signal: record.body ?? state.signalSnapshot,
      leg: closedLeg,
      remainingQuantity: String(remainingQuantity),
      position: { positionId: split.positionId },
      priorPosition: state,
      ...(persistedPosition ? { persistedPosition } : {}),
    });
    const submitted = await reserveAndPerform(record.sourceSignalId, phase, request);
    if (submitted.kind !== "submitted") {
      await store.setSignalStatus(record.sourceSignalId, "unknown",
        "impulse_split_cleanup_intent_requires_reconciliation");
      return { kind: "unknown", reason: "impulse_split_cleanup_intent_requires_reconciliation" };
    }
    let evidence;
    try {
      evidence = await broker.reconcileIntent({
        clientOrderId: submitted.clientOrderId, phase, request,
      });
      if (!validObject(evidence) || evidence.verified !== true ||
          evidence.status !== "filled" || !validObject(evidence.position) ||
          evidence.position.verified !== true ||
          evidence.position.positionId !== split.positionId ||
          evidence.position.symbol !== state.symbol ||
          Number(evidence.position.quantity) !== remainingQuantity ||
          evidence.protectiveStops?.[closedLeg] !== undefined) {
        throw new Error("impulse_split_cleanup_exchange_evidence_not_verified");
      }
      const retained = evidence.protectiveStops?.[retainedLeg];
      if (retained?.verified !== true || retained.orderId !== retainedExpected.orderId ||
          retained.positionId !== split.positionId ||
          Number(retained.quantity) !== remainingQuantity ||
          Number(retained.stopPrice) !== Number(retainedExpected.stopPrice)) {
        throw new Error("impulse_split_cleanup_retained_stop_not_verified");
      }
      const nextPolicy = {
        ...split.pendingClosePolicy,
        status: "open",
        remainingQty: remainingQuantity,
      };
      const completedSplit = { ...split };
      completedSplit.stage = "complete";
      completedSplit[`${closedLeg}Stop`] = null;
      completedSplit[`${retainedLeg}Stop`] = {
        ...retainedExpected, quantity: String(remainingQuantity),
      };
      completedSplit.activeLegs = [retainedLeg];
      completedSplit.baselineOpenOrderIds = [retainedExpected.orderId];
      delete completedSplit.cleanupLeg;
      delete completedSplit.cleanupRemainingQuantity;
      delete completedSplit.pendingClosePolicy;
      const nextPosition = await withFreshPersistedSplitPosition({
        ...state,
        ...nextPolicy,
        status: "open",
        executionStatus: "open",
        split: completedSplit,
        pendingClose: null,
        baselineOpenOrderIds: [...completedSplit.baselineOpenOrderIds],
        coreStopOrderId: retainedLeg === "core" ? retainedExpected.orderId : null,
        coreStopPositionId: retainedLeg === "core" ? split.positionId : null,
        coreStopQuantity: retainedLeg === "core" ? remainingQuantity : 0,
        runnerStopOrderId: retainedLeg === "runner" ? retainedExpected.orderId : null,
        runnerStopPositionId: retainedLeg === "runner" ? split.positionId : null,
        runnerStopQuantity: retainedLeg === "runner" ? remainingQuantity : 0,
        verifiedProtectiveStops: {
          [retainedLeg]: {
            verified: true,
            ...completedSplit[`${retainedLeg}Stop`],
          },
        },
      });
      if (!nextPosition.persistedPosition) {
        throw new Error("impulse_split_cleanup_persisted_position_not_verified");
      }
      await store.commitVerifiedIntent({
        sourceSignalId: record.sourceSignalId,
        clientOrderId: submitted.clientOrderId,
        position: nextPosition,
        signalStatus: "open",
        exchangeOrderId: evidence.exchangeOrderId ?? null,
        outcome: {
          status: "filled",
          verified: true,
          operation: request.operation,
          canceledStopOrderId: closedExpected.orderId,
          retainedStopOrderId: retainedExpected.orderId,
          remainingQuantity: String(remainingQuantity),
          splitStage: "complete",
        },
        eventKind: "vst_impulse_split_cleanup_verified",
        eventDetail: {
          closedLeg,
          retainedLeg,
          canceledStopOrderId: closedExpected.orderId,
          retainedStopOrderId: retainedExpected.orderId,
          remainingQuantity: String(remainingQuantity),
        },
      });
      return { kind: "acted", operation: request.operation, leg: closedLeg };
    } catch (error) {
      const reason = error instanceof Error
        ? error.message : "impulse_split_cleanup_not_verified";
      await store.markIntent(submitted.clientOrderId, "unknown", {
        exchangeOrderId: evidence?.exchangeOrderId ?? null,
        outcome: { reason },
      });
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      return { kind: "unknown", reason };
    }
  }

  function closedSurvivorPosition(request, evidence) {
    const stop = request.stop;
    const fill = evidence?.fill;
    const flat = evidence?.position;
    const feesVerified = validObject(fill?.fee) &&
      typeof fill.fee.asset === "string" && fill.fee.asset.trim() !== "" &&
      Number.isFinite(Number(fill.fee.amount)) ||
      Array.isArray(fill?.fees) && fill.fees.length > 0 &&
      fill.fees.every((fee) => validObject(fee) &&
        typeof fee.currency === "string" && fee.currency.trim() !== "" &&
        Number.isFinite(Number(fee.amount)));
    if (evidence?.verified !== true || evidence.status !== "filled" ||
        typeof evidence.exchangeOrderId !== "string" ||
        evidence.exchangeOrderId.trim() === "" ||
        typeof evidence.clientOrderId !== "string" ||
        evidence.clientOrderId.trim() === "" ||
        evidence.flat !== true || evidence.noOpenStops !== true ||
        evidence.canceledStopOrderId !== stop?.orderId ||
        evidence.closeIntentId !== request.closeIntentId ||
        Number(evidence.closedQuantity) !== Number(request.quantity) ||
        !validObject(flat) || flat.verified !== true ||
        flat.symbol !== request.symbol || Number(flat.quantity) !== 0 ||
        !validObject(fill) || Number(fill.quantity) !== Number(request.quantity) ||
        !Number.isFinite(Number(fill.price)) || Number(fill.price) <= 0 ||
        typeof fill.at !== "string" || !Number.isFinite(Date.parse(fill.at)) ||
        !feesVerified) {
      throw new Error("impulse_sole_leg_close_evidence_not_verified");
    }
    const position = {
      ...request.priorPosition,
      ...request.pendingPolicy,
      status: "closed",
      executionStatus: "closed",
      closedAt: fill.at,
      closeReason: request.closeReason,
      closeFill: fill,
      lastCloseFill: fill,
      coreOpen: false,
      runnerOpen: false,
      coreQty: 0,
      runnerQty: 0,
      remainingQty: 0,
      coreQuantity: 0,
      runnerQuantity: 0,
      remainingQuantity: 0,
      coreStopOrderId: null,
      coreStopPositionId: null,
      coreStopQuantity: 0,
      runnerStopOrderId: null,
      runnerStopPositionId: null,
      runnerStopQuantity: 0,
      verifiedProtectiveStops: {},
      persistedPosition: null,
      baselineOpenOrderIds: [],
      split: {
        ...request.priorPosition.split,
        stage: "closed",
        coreOpen: false,
        runnerOpen: false,
        coreStop: null,
        runnerStop: null,
        activeLegs: [],
        baselineOpenOrderIds: [],
      },
    };
    return position;
  }

  async function commitSurvivorClose(intent, request, evidence) {
    const position = closedSurvivorPosition(request, evidence);
    await store.commitVerifiedIntent({
      sourceSignalId: intent.sourceSignalId,
      clientOrderId: intent.clientOrderId,
      position,
      signalStatus: "closed",
      exchangeOrderId: evidence.exchangeOrderId,
      outcome: {
        status: "filled",
        verified: true,
        operation: "close_survivor",
        leg: request.stop.tranche,
        stopOrderId: request.stop.orderId,
        closeIntentId: request.closeIntentId,
        quantity: String(request.quantity),
        fill: evidence.fill,
        flat: true,
        noOpenStops: true,
      },
      eventKind: "vst_impulse_sole_split_leg_closed",
      eventDetail: {
        leg: request.stop.tranche,
        stopOrderId: request.stop.orderId,
        closeIntentId: request.closeIntentId,
        quantity: String(request.quantity),
        fill: evidence.fill,
      },
    });
    return position;
  }

  function flatPositionFromAccountState(accountState, symbol) {
    if (!validObject(accountState) || accountState.verified !== true ||
        !Array.isArray(accountState.positions) ||
        !Array.isArray(accountState.openOrders)) return false;
    const compactSymbol = String(symbol).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    return accountState.positions.every((position) => {
      if (!validObject(position) || typeof position.symbol !== "string") return false;
      if (position.symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase() !== compactSymbol) return true;
      const quantity = Number(position.quantity ?? position.positionAmt);
      return Number.isFinite(quantity) && quantity === 0;
    });
  }

  function verifiedFlatCloseFill(evidence, quantity) {
    const fill = evidence?.fill;
    const fees = fill?.fees ?? fill?.fee ?? fill?.commission;
    const feeEvidencePresent = validObject(fill) &&
      (Object.hasOwn(fill, "fees") || Object.hasOwn(fill, "fee") ||
       Object.hasOwn(fill, "commission"));
    const feeEvidenceValid = Array.isArray(fees) || validObject(fees) ||
      typeof fees === "string" && fees.trim() !== "" && Number.isFinite(Number(fees)) ||
      typeof fees === "number" && Number.isFinite(fees);
    if (!validObject(fill) ||
        Number(fill.quantity) !== Number(quantity) ||
        !Number.isFinite(Number(fill.price)) || Number(fill.price) <= 0 ||
        typeof fill.at !== "string" || !Number.isFinite(Date.parse(fill.at)) ||
        !feeEvidencePresent || fees === null || fees === undefined || !feeEvidenceValid) {
      throw new Error("impulse_full_split_close_fill_or_fees_unverified");
    }
    return closeFillSnapshot(evidence);
  }

  function closedOrCleanupSplitPosition(request, fill, remainingStopIds) {
    const prior = request.priorPosition;
    const cleanupStops = request.flatCleanupStops;
    const stillNeedsCleanup = remainingStopIds.length > 0;
    const remainingSet = new Set(remainingStopIds);
    const split = {
      ...prior.split,
      stage: stillNeedsCleanup ? "flat_cleanup_pending" : "closed",
      coreOpen: false,
      runnerOpen: false,
      remainingKnownStopOrderIds: [...remainingStopIds],
      flatCleanupStops: cleanupStops.filter((stop) => remainingSet.has(stop.orderId)),
      activeLegs: [],
      baselineOpenOrderIds: [...remainingStopIds],
      fullCloseFill: fill,
      closeIntentId: request.closeIntentId,
      closeReason: request.closeReason,
    };
    return {
      ...prior,
      status: stillNeedsCleanup ? "closing" : "closed",
      executionStatus: stillNeedsCleanup
        ? "impulse_flat_split_stop_cleanup_pending" : "closed",
      closedAt: fill.at,
      closeReason: request.closeReason,
      closeFill: fill,
      lastCloseFill: fill,
      coreOpen: false,
      runnerOpen: false,
      coreQty: 0,
      runnerQty: 0,
      remainingQty: 0,
      coreQuantity: 0,
      runnerQuantity: 0,
      remainingQuantity: 0,
      split,
      persistedPosition: null,
      baselineOpenOrderIds: [...remainingStopIds],
      ...(!stillNeedsCleanup ? {
        coreStopOrderId: null,
        coreStopPositionId: null,
        coreStopQuantity: 0,
        runnerStopOrderId: null,
        runnerStopPositionId: null,
        runnerStopQuantity: 0,
        verifiedProtectiveStops: {},
        baselineOpenOrderIds: [],
      } : {}),
    };
  }

  async function commitFullSplitExit(intent, request, evidence) {
    const totalQuantity = request.operation === "close_split_all" ||
      request.operation === "close_pre_runner_split"
      ? request.totalQuantity : request.quantity;
    let fill;
    if (request.operation === "close_pre_runner_split") {
      const originalStop = request.originalStop;
      const coreStop = request.coreStop;
      const remainingIds = evidence?.remainingKnownStopOrderIds;
      const stopsAreExact = validObject(originalStop) && validObject(coreStop) &&
        originalStop.tranche === "original" && coreStop.tranche === "core" &&
        originalStop.positionId === request.positionId &&
        coreStop.positionId === request.positionId &&
        Number(originalStop.quantity) === Number(totalQuantity) &&
        Math.abs(Number(coreStop.quantity) * 5 - Number(totalQuantity) * 4) <=
          Math.max(1e-10, Number(totalQuantity) * 1e-10) &&
        Number.isFinite(Number(originalStop.stopPrice)) &&
        Number(originalStop.stopPrice) > 0 &&
        Number.isFinite(Number(coreStop.stopPrice)) &&
        Number(coreStop.stopPrice) > 0 &&
        typeof originalStop.orderId === "string" &&
        typeof coreStop.orderId === "string" &&
        originalStop.orderId !== coreStop.orderId &&
        Array.isArray(request.flatCleanupStops) &&
        request.flatCleanupStops.length === 2 &&
        request.flatCleanupStops.some((stop) =>
          stop.tranche === "original" && stop.orderId === originalStop.orderId &&
          Number(stop.quantity) === Number(originalStop.quantity) &&
          Number(stop.stopPrice) === Number(originalStop.stopPrice)) &&
        request.flatCleanupStops.some((stop) =>
          stop.tranche === "core" && stop.orderId === coreStop.orderId &&
          Number(stop.quantity) === Number(coreStop.quantity) &&
          Number(stop.stopPrice) === Number(coreStop.stopPrice));
      const position = evidence?.position;
      if (!stopsAreExact ||
          evidence?.verified !== true || evidence.status !== "filled" ||
          evidence.closeIntentId !== request.closeIntentId ||
          evidence.positionId !== request.positionId ||
          typeof evidence.exchangeOrderId !== "string" ||
          evidence.exchangeOrderId.trim() === "" ||
          typeof evidence.clientOrderId !== "string" ||
          evidence.clientOrderId.trim() === "" ||
          Number(evidence.closedQuantity) !== Number(totalQuantity) ||
          evidence.flat !== true || !validObject(position) ||
          position.verified !== true || position.symbol !== request.symbol ||
          Number(position.quantity) !== 0 ||
          !Array.isArray(remainingIds) || remainingIds.length > 2 ||
          remainingIds.some((id) => typeof id !== "string" ||
            !request.flatCleanupStops.some((stop) => stop.orderId === id)) ||
          new Set(remainingIds).size !== remainingIds.length) {
        throw new Error("impulse_pre_runner_split_close_evidence_not_verified");
      }
      fill = verifiedFlatCloseFill(evidence, totalQuantity);
    } else if (request.operation === "close_split_all") {
      const position = evidence?.position;
      const remainingIds = evidence?.remainingKnownStopOrderIds;
      if (evidence?.verified !== true || evidence.status !== "filled" ||
          evidence.closeIntentId !== request.closeIntentId ||
          evidence.positionId !== request.positionId ||
          typeof evidence.exchangeOrderId !== "string" ||
          evidence.exchangeOrderId.trim() === "" ||
          typeof evidence.clientOrderId !== "string" ||
          evidence.clientOrderId.trim() === "" ||
          Number(evidence.closedQuantity) !== Number(totalQuantity) ||
          evidence.flat !== true || !validObject(position) ||
          position.verified !== true || position.symbol !== request.symbol ||
          Number(position.quantity) !== 0 ||
          !Array.isArray(remainingIds) ||
          remainingIds.some((id) => typeof id !== "string" ||
            !request.flatCleanupStops.some((stop) => stop.orderId === id)) ||
          new Set(remainingIds).size !== remainingIds.length ||
          evidence.fullyCleaned !== (remainingIds.length === 0)) {
        throw new Error("impulse_full_split_close_evidence_not_verified");
      }
      fill = verifiedFlatCloseFill(evidence, totalQuantity);
    } else {
      checkActionEvidence(request, evidence, PROFILE);
      if (evidence.status !== "filled" ||
          evidence.position.positionId !== request.positionId ||
          Number(evidence.position.quantity) !== 0) {
        throw new Error("impulse_guarded_full_close_not_flat");
      }
      fill = verifiedFlatCloseFill(evidence, totalQuantity);
    }

    const accountState = await broker.readAccountState();
    if (!flatPositionFromAccountState(accountState, request.symbol)) {
      throw new Error("impulse_full_close_account_flatness_not_verified");
    }
    const currentOrders = symbolOrders(accountState, request.symbol);
    if (!currentOrders) throw new Error("impulse_full_close_orders_not_verified");
    const currentIds = exactOrderIds(currentOrders);
    if (!currentIds ||
        currentIds.some((id) =>
          !request.flatCleanupStops.some((stop) => stop.orderId === id))) {
      throw new Error("impulse_full_close_unknown_open_order");
    }
    const expectedRemaining = request.operation === "close_split_all" ||
      request.operation === "close_pre_runner_split"
      ? evidence.remainingKnownStopOrderIds.slice().sort()
      : currentIds.slice().sort();
    if (JSON.stringify(currentIds.slice().sort()) !==
        JSON.stringify(expectedRemaining)) {
      throw new Error("impulse_full_close_remaining_stop_set_mismatch");
    }
    for (const id of currentIds) {
      const stop = request.flatCleanupStops.find((item) => item.orderId === id);
      if (!exactRawSplitStop(request.priorPosition, accountState, stop)) {
        throw new Error("impulse_full_close_remaining_stop_identity_unverified");
      }
    }
    const position = closedOrCleanupSplitPosition(request, fill, expectedRemaining);
    await store.commitVerifiedIntent({
      sourceSignalId: intent.sourceSignalId,
      clientOrderId: intent.clientOrderId,
      position,
      signalStatus: expectedRemaining.length ? "open" : "closed",
      exchangeOrderId: evidence.exchangeOrderId ?? null,
      outcome: {
        status: "filled",
        verified: true,
        operation: request.operation,
        closeIntentId: request.closeIntentId,
        quantity: String(totalQuantity),
        fill,
        flat: true,
        cleanupStage: expectedRemaining.length
          ? "pending_flat_cleanup" : "complete",
        remainingKnownStopOrderIds: expectedRemaining,
      },
      eventKind: expectedRemaining.length
        ? "vst_impulse_flat_close_cleanup_pending"
        : "vst_impulse_full_split_position_closed",
      eventDetail: {
        closeReason: request.closeReason,
        quantity: String(totalQuantity),
        remainingKnownStopOrderIds: expectedRemaining,
      },
    });
    return position;
  }

  async function commitFlatSplitStopCancellation(intent, request, evidence) {
    const prior = request.priorPosition;
    const split = prior?.split;
    const knownIds = request.knownRemainingStopOrderIds;
    const remainingIds = evidence?.remainingKnownStopOrderIds;
    const targetId = request.stopToCancel?.orderId;
    const priorStop = split?.flatCleanupStops?.find((stop) => stop.orderId === targetId);
    if (!validObject(prior) || split?.stage !== "flat_cleanup_pending" ||
        request.positionId !== split.positionId ||
        request.cancellationIntentId !== intent.clientOrderId ||
        !Array.isArray(knownIds) ||
        JSON.stringify(knownIds.slice().sort()) !==
          JSON.stringify(split.remainingKnownStopOrderIds.slice().sort()) ||
        !validObject(priorStop) ||
        Number(priorStop.quantity) !== Number(request.stopToCancel.quantity) ||
        Number(priorStop.stopPrice) !== Number(request.stopToCancel.stopPrice) ||
        evidence?.verified !== true || evidence.status !== "canceled" ||
        evidence.positionId !== request.positionId || evidence.flat !== true ||
        evidence.canceledStopOrderId !== targetId ||
        evidence.cancellationIntentId !== request.cancellationIntentId ||
        !Array.isArray(evidence.knownRemainingStopOrderIds) ||
        JSON.stringify(evidence.knownRemainingStopOrderIds.slice().sort()) !==
          JSON.stringify(knownIds.slice().sort()) ||
        !Array.isArray(remainingIds) ||
        remainingIds.includes(targetId) ||
        remainingIds.some((id) => typeof id !== "string" || !knownIds.includes(id)) ||
        new Set(remainingIds).size !== remainingIds.length) {
      throw new Error("impulse_flat_split_stop_cancel_evidence_not_verified");
    }
    const accountState = await broker.readAccountState();
    if (!flatPositionFromAccountState(accountState, prior.symbol)) {
      throw new Error("impulse_flat_split_cleanup_position_not_flat");
    }
    const currentOrders = symbolOrders(accountState, prior.symbol);
    if (!currentOrders) throw new Error("impulse_flat_split_cleanup_orders_not_verified");
    const currentIds = exactOrderIds(currentOrders);
    if (!currentIds) throw new Error("impulse_flat_split_cleanup_order_ids_unverified");
    if (JSON.stringify(currentIds.slice().sort()) !==
        JSON.stringify(remainingIds.slice().sort())) {
      throw new Error("impulse_flat_split_cleanup_remaining_order_mismatch");
    }
    for (const id of currentIds) {
      const stop = split.flatCleanupStops.find((item) => item.orderId === id);
      if (!stop || !exactRawSplitStop(prior, accountState, stop)) {
        throw new Error("impulse_flat_split_cleanup_remaining_stop_unverified");
      }
    }
    const complete = remainingIds.length === 0;
    const nextSplit = {
      ...split,
      stage: complete ? "closed" : "flat_cleanup_pending",
      remainingKnownStopOrderIds: [...remainingIds],
      flatCleanupStops: split.flatCleanupStops.filter((stop) =>
        remainingIds.includes(stop.orderId)),
      activeLegs: [],
      baselineOpenOrderIds: [...remainingIds],
    };
    const position = {
      ...prior,
      split: nextSplit,
      status: complete ? "closed" : "closing",
      executionStatus: complete ? "closed" : "impulse_flat_split_stop_cleanup_pending",
      sourceExitCleanup: complete ? null : {
        ...prior.sourceExitCleanup,
        remainingKnownStopOrderIds: [...remainingIds],
        flatCleanupStops: nextSplit.flatCleanupStops,
      },
      baselineOpenOrderIds: [...remainingIds],
      ...(complete ? {
        coreStopOrderId: null,
        coreStopPositionId: null,
        coreStopQuantity: 0,
        runnerStopOrderId: null,
        runnerStopPositionId: null,
        runnerStopQuantity: 0,
        verifiedProtectiveStops: {},
        baselineOpenOrderIds: [],
      } : {}),
    };
    await store.commitVerifiedIntent({
      sourceSignalId: intent.sourceSignalId,
      clientOrderId: intent.clientOrderId,
      position,
      signalStatus: complete ? "closed" : "open",
      exchangeOrderId: evidence.exchangeOrderId ?? null,
      outcome: {
        status: "canceled",
        verified: true,
        operation: "cancel_flat_split_stop",
        canceledStopOrderId: targetId,
        remainingKnownStopOrderIds: [...remainingIds],
        cleanupStage: complete ? "complete" : "pending_flat_cleanup",
        ...(request.sourceExit ? {
          sourceExitRequestId: request.sourceExit.requestId,
          sourceEvidence: request.sourceExit.evidence,
          sourceExitComplete: complete,
        } : {}),
      },
      eventKind: request.sourceExit
        ? complete ? "vst_source_exit_stops_cleaned"
          : "vst_source_exit_stop_cleanup_progress"
        : prior.protectedExit
          ? complete ? "vst_protected_strategy_exit_stops_cleaned"
            : "vst_protected_strategy_exit_stop_cleanup_progress"
          : complete ? "vst_impulse_flat_stops_cleaned"
            : "vst_impulse_flat_stop_cleanup_progress",
      eventDetail: {
        canceledStopOrderId: targetId,
        remainingKnownStopOrderIds: [...remainingIds],
        ...(request.sourceExit ? {
          sourceExitRequestId: request.sourceExit.requestId,
          sourceEvidence: request.sourceExit.evidence,
        } : {}),
      },
    });
    if (complete && request.sourceExit) {
      await finishSourceExit(request.sourceExit.requestId, {
        outcome: "closed",
        detail: {
          sourceEvidence: request.sourceExit.evidence,
          closeFill: position.closeFill ?? position.lastCloseFill ?? null,
          flat: true,
          noOpenStops: true,
        },
      });
    }
    return position;
  }

  async function commitSoleCoreStopUpgrade(intent, request, evidence) {
    const prior = request.priorPosition;
    const split = prior?.split;
    const stop = evidence?.protectiveStops?.core ??
      evidence?.position?.protectiveStops?.core;
    checkActionEvidence(request, evidence, PROFILE);
    if (!validObject(prior) || prior.patternId !== "impulse_buy" ||
        prior.coreOpen !== true || prior.runnerOpen !== false ||
        split?.stage !== "complete" || request.leg !== "core" ||
        request.positionId !== prior.exchangePositionId ||
        Number(request.quantity) !== Number(prior.coreQty) ||
        Number(request.previousQuantity) !== Number(prior.remainingQty) ||
        evidence.position.positionId !== prior.exchangePositionId ||
        Number(evidence.position.quantity) !== Number(prior.coreQty) ||
        !exactExchangeIdentifier(intent.exchangeOrderId) ||
        exactExchangeIdentifier(evidence.exchangeOrderId) !==
          exactExchangeIdentifier(intent.exchangeOrderId) ||
        stop?.orderId !== exactExchangeIdentifier(intent.exchangeOrderId) ||
        stop?.verified !== true ||
        Number(stop.stopPrice) < Number(request.stopPrice) ||
        Number(stop.quantity) !== Number(prior.coreQty)) {
      throw new Error("impulse_sole_core_stop_upgrade_evidence_not_verified");
    }
    const expectedPosition = await assertRaiseStopPositionStillCurrent(intent, request);
    const accountState = await broker.readAccountState();
    const orders = symbolOrders(accountState, prior.symbol);
    const currentIds = exactOrderIds(orders);
    const rawStop = exactRawSplitStop(prior, accountState, {
      tranche: "core",
      orderId: stop.orderId,
      positionId: stop.positionId,
      quantity: stop.quantity,
      stopPrice: stop.stopPrice,
    });
    if (!Array.isArray(orders) || orders.length !== 1 ||
        !currentIds || currentIds[0] !== stop.orderId ||
        !rawStop || Number(rawStop.quantity) !== Number(prior.coreQty) ||
        Number(rawStop.stopPrice) !== Number(stop.stopPrice)) {
      throw new Error("impulse_sole_core_stop_upgrade_order_not_verified");
    }
    const position = await withFreshPersistedSplitPosition(
      confirmedActionPosition(request, evidence),
    );
    if (!position.persistedPosition) {
      throw new Error("impulse_sole_core_stop_persisted_position_not_verified");
    }
    await store.commitVerifiedIntent({
      sourceSignalId: intent.sourceSignalId,
      clientOrderId: intent.clientOrderId,
      position,
      signalStatus: "open",
      exchangeOrderId: evidence.exchangeOrderId ?? null,
      outcome: {
        status: "filled",
        verified: true,
        operation: request.operation,
        leg: "core",
        stop: position.split.coreStop,
      },
      eventKind: "vst_impulse_sole_core_stop_raised",
      expectedPositionSnapshot: expectedPosition.snapshot,
      expectedPositionUpdatedAt: expectedPosition.updatedAt,
      eventDetail: {
        orderId: position.split.coreStop.orderId,
        stopPrice: position.split.coreStop.stopPrice,
        quantity: position.split.coreStop.quantity,
      },
    });
    return position;
  }

  async function closeSoleSurvivor(record, state, action, observed, allowActions) {
    if (!allowActions) {
      return { kind: "waiting", reason: "verified_mutation_capabilities_unavailable" };
    }
    const leg = action.leg;
    const soleLegIsValid = leg === "core"
      ? state.coreOpen === true && state.runnerOpen === false
      : leg === "runner"
        ? state.runnerOpen === true && state.coreOpen === false
        : false;
    const stop = state.split?.[`${leg}Stop`];
    const expectedQuantity = Number(leg === "core"
      ? state.coreQty : state.runnerQty);
    const accountState = await broker.readAccountState();
    const persistedPosition = persistedSplitPosition(state, accountState);
    const position = await broker.readPosition(state.symbol, {
      persistedPosition,
      allowProcessCache: false,
    });
    const orders = symbolOrders(accountState, state.symbol);
    const rawStop = exactRawSplitStop(state, accountState, stop);
    if (!soleLegIsValid || state.split?.stage !== "complete" ||
        !validObject(stop) || !rawStop || !Array.isArray(orders) ||
        orders.length !== 1 || Number(stop.quantity) !== expectedQuantity ||
        !validObject(position) || position.verified !== true ||
        position.symbol !== state.symbol ||
        position.positionId !== state.exchangePositionId ||
        Number(position.quantity) !== expectedQuantity ||
        position.side !== "Buy" || Number(position.leverage) !== PROFILE_LEVERAGE ||
        !profileMarginIs(position.marginMode)) {
      const reason = "impulse_sole_leg_close_preflight_not_verified";
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      await store.upsertPosition({
        ...state, sourceSignalId: record.sourceSignalId, status: "unknown",
      });
      return { kind: "unknown", reason };
    }
    const pendingPolicy = intermediatePolicyAfterAction(state, action, observed);
    const phase = `impulse-close-survivor-${leg}-${Date.parse(observed.observedAt)}`;
    const closeIntentId = orderId(record.sourceSignalId, phase);
    const request = {
      operation: "close_survivor",
      environment: "vst",
      accountId: state.accountId,
      sourceSignalId: record.sourceSignalId,
      symbol: state.symbol,
      positionId: state.exchangePositionId,
      quantity: String(stop.quantity),
      stop: {
        tranche: leg,
        orderId: stop.orderId,
        quantity: String(stop.quantity),
        stopPrice: String(stop.stopPrice),
      },
      closeIntentId,
      closeReason: action.reason,
      priorPosition: state,
      pendingPolicy,
      ...(persistedPosition ? { persistedPosition } : {}),
    };
    const submitted = await reserveAndPerform(record.sourceSignalId, phase, request);
    if (submitted.kind !== "submitted") {
      await store.setSignalStatus(record.sourceSignalId, "unknown",
        "impulse_sole_leg_close_requires_reconciliation");
      return { kind: "unknown", reason: "impulse_sole_leg_close_requires_reconciliation" };
    }
    let evidence;
    try {
      evidence = await broker.reconcileIntent({
        clientOrderId: submitted.clientOrderId, phase, request,
      });
      await commitSurvivorClose({
        sourceSignalId: record.sourceSignalId,
        clientOrderId: submitted.clientOrderId,
      }, request, evidence);
      return { kind: "acted", operation: "close_survivor", leg };
    } catch (error) {
      const reason = error instanceof Error
        ? error.message : "impulse_sole_leg_close_unverified";
      await store.markIntent(submitted.clientOrderId, "unknown", {
        exchangeOrderId: evidence?.exchangeOrderId ?? null,
        outcome: { reason },
      });
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      return { kind: "unknown", reason };
    }
  }

  async function submitFullSplitClose(record, state, phase, request) {
    const submitted = await reserveAndPerform(record.sourceSignalId, phase, request);
    if (submitted.kind !== "submitted") {
      await store.setSignalStatus(record.sourceSignalId, "unknown",
        "impulse_full_split_close_requires_reconciliation");
      return {
        kind: "unknown",
        reason: "impulse_full_split_close_requires_reconciliation",
      };
    }
    let evidence;
    try {
      evidence = await broker.reconcileIntent({
        clientOrderId: submitted.clientOrderId, phase, request,
      });
      await commitFullSplitExit({
        sourceSignalId: record.sourceSignalId,
        clientOrderId: submitted.clientOrderId,
      }, request, evidence);
      return { kind: "acted", operation: request.operation };
    } catch (error) {
      const reason = error instanceof Error
        ? error.message : "impulse_full_split_close_unverified";
      await store.markIntent(submitted.clientOrderId, "unknown", {
        exchangeOrderId: evidence?.exchangeOrderId ?? null,
        outcome: { reason },
      });
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      await store.upsertPosition({
        ...state,
        sourceSignalId: record.sourceSignalId,
        status: "unknown",
      });
      return { kind: "unknown", reason };
    }
  }

  async function abortRunnerBeforeBreakEven(record, state, allowActions, observedAt) {
    if (!allowActions) {
      return { kind: "waiting", reason: "verified_mutation_capabilities_unavailable" };
    }
    const split = state.split;
    const totalQuantity = Number(split?.totalQuantity);
    const originalStop = {
      tranche: "original",
      orderId: split?.originalStopOrderId,
      positionId: split?.positionId,
      quantity: String(split?.totalQuantity),
      stopPrice: String(split?.signalStopPrice),
    };
    const coreStop = split?.coreStop;
    const accountState = await broker.readAccountState();
    const persistedPosition = persistedSplitPosition(state, accountState);
    const position = await broker.readPosition(state.symbol, {
      persistedPosition,
      allowProcessCache: false,
    });
    const orders = symbolOrders(accountState, state.symbol);
    const rawOriginal = exactRawSplitStop(state, accountState, originalStop);
    const rawCore = exactRawSplitStop(state, accountState, coreStop);
    if (split?.stage !== "runner_pending" ||
        !validObject(coreStop) || !rawOriginal || !rawCore ||
        !Array.isArray(orders) || orders.length !== 2 ||
        JSON.stringify(exactOrderIds(orders)?.sort()) !==
          JSON.stringify([originalStop.orderId, coreStop.orderId].sort()) ||
        Number(originalStop.quantity) !== totalQuantity ||
        Number(originalStop.stopPrice) !== Number(split.signalStopPrice) ||
        !validObject(position) || position.verified !== true ||
        position.symbol !== state.symbol ||
        position.positionId !== split.positionId ||
        Number(position.quantity) !== totalQuantity ||
        position.side !== "Buy" || Number(position.leverage) !== PROFILE_LEVERAGE ||
        !profileMarginIs(position.marginMode) ||
        !Number.isSafeInteger(observedAt) ||
        typeof store.commitVerifiedIntent !== "function") {
      const reason = "impulse_runner_abort_original_stop_or_full_position_unverified";
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      await store.upsertPosition({
        ...state, sourceSignalId: record.sourceSignalId, status: "unknown",
      });
      return { kind: "unknown", reason };
    }
    // Deliberately keyed on the FRESH mark read that justified this attempt
    // (passed in as observedAt), not on state.verifiedFill.at. The fill time
    // never changes for the life of the position, so keying on it would give
    // every retry of this operation the exact same (sourceSignalId, phase)
    // idempotency key. That is correct WHILE the original attempt is still
    // unresolved (exactly the dedup this key is for), but once that intent
    // reaches a TERMINAL state (reconciled or -- after an abandoned, proven-
    // still-open close -- failed), reserveIntent's ON CONFLICT lookup finds
    // the old terminal row, and reserveAndPerform reports "existing" rather
    // than submitting anything new. This function's caller (advanceImpulseSplit)
    // already re-decides to retry on a fresh per-tick mark read, but with a
    // fixed phase that decision could never reach the exchange again: every
    // retry would silently collide with the old failed row and the position
    // would sit unmanaged forever. Keying on the fresh mark's timestamp
    // instead -- the same approach already used by close_leg and
    // close_survivor -- gives a genuine retry its own idempotency key while
    // still deduplicating repeated ticks against the SAME unresolved attempt
    // (advanceImpulseSplit only reaches here when unresolved.length === 0,
    // i.e. no submission from a prior tick is still in flight).
    const phase = `impulse-runner-breakeven-abort-${observedAt}`;
    const closeIntentId = orderId(record.sourceSignalId, phase);
    const coreCloseStop = {
      tranche: "core",
      orderId: coreStop.orderId,
      positionId: split.positionId,
      quantity: String(coreStop.quantity),
      stopPrice: String(coreStop.stopPrice),
    };
    const flatCleanupStops = [originalStop, coreCloseStop];
    const request = {
      operation: "close_pre_runner_split",
      sourceSignalId: record.sourceSignalId,
      symbol: state.symbol,
      environment: "vst",
      accountId: state.accountId,
      positionId: split.positionId,
      totalQuantity: String(split.totalQuantity),
      originalStop,
      coreStop: coreCloseStop,
      closeIntentId,
      closeReason: "runner_break_even_unavailable_at_or_below_entry",
      flatCleanupStops,
      priorPosition: state,
      ...(persistedPosition ? { persistedPosition } : {}),
    };
    if (typeof store.listPreRunnerCloseAttempts === "function") {
      const attempts = await store.listPreRunnerCloseAttempts(record.sourceSignalId);
      const retry = evaluatePreRunnerCloseRetry(request, attempts, Number(clock()));
      if (!retry.allowed) {
        if (retry.limitReached) {
          await store.recordGuardEventOnce(record.sourceSignalId,
            "vst_pre_runner_close_retry_limit", {
              ref: retry.fingerprint, reason: retry.reason,
              symbol: state.symbol, failures: retry.failures,
              operation: "close_pre_runner_split",
            });
        }
        return { kind: retry.limitReached ? "unknown" : "waiting",
          reason: retry.reason, symbol: state.symbol,
          sourceSignalId: record.sourceSignalId,
          operation: "close_pre_runner_split" };
      }
    }
    return await submitFullSplitClose(record, state, phase, request);
  }

  async function advanceFlatSplitCleanup(record, state, allowActions) {
    if (!allowActions) {
      return { kind: "waiting", reason: "verified_mutation_capabilities_unavailable" };
    }
    const split = state.split;
    const knownIds = split?.remainingKnownStopOrderIds;
    if (split?.stage !== "flat_cleanup_pending" ||
        !Array.isArray(knownIds) || knownIds.length < 1 ||
        !Array.isArray(split.flatCleanupStops) ||
        knownIds.some((id) => !split.flatCleanupStops.some((stop) => stop.orderId === id))) {
      const reason = "impulse_flat_stop_cleanup_stage_unverified";
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      await store.upsertPosition({ ...state, sourceSignalId: record.sourceSignalId, status: "unknown" });
      return { kind: "unknown", reason };
    }
    const accountState = await broker.readAccountState();
    if (!flatPositionFromAccountState(accountState, state.symbol)) {
      const reason = "impulse_flat_stop_cleanup_position_not_flat";
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      await store.upsertPosition({ ...state, sourceSignalId: record.sourceSignalId, status: "unknown" });
      return { kind: "unknown", reason };
    }
    const orders = symbolOrders(accountState, state.symbol);
    const currentIds = exactOrderIds(orders);
    if (!Array.isArray(orders) || !currentIds ||
        JSON.stringify(currentIds.slice().sort()) !== JSON.stringify(knownIds.slice().sort())) {
      const reason = "impulse_flat_stop_cleanup_order_set_changed";
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      await store.upsertPosition({ ...state, sourceSignalId: record.sourceSignalId, status: "unknown" });
      return { kind: "unknown", reason };
    }
    for (const stop of split.flatCleanupStops) {
      if (knownIds.includes(stop.orderId) &&
          !exactRawSplitStop(state, accountState, stop)) {
        const reason = "impulse_flat_stop_cleanup_identity_unverified";
        await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
        await store.upsertPosition({ ...state, sourceSignalId: record.sourceSignalId, status: "unknown" });
        return { kind: "unknown", reason };
      }
    }
    const targetId = knownIds[0];
    const stopToCancel = split.flatCleanupStops.find((stop) => stop.orderId === targetId);
    if (!validObject(stopToCancel) ||
        !["original", "core", "runner"].includes(stopToCancel.tranche)) {
      const reason = "impulse_flat_stop_cleanup_target_unverified";
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      await store.upsertPosition({ ...state, sourceSignalId: record.sourceSignalId, status: "unknown" });
      return { kind: "unknown", reason };
    }
    const phase = `impulse-flat-stop-cancel-${targetId}`;
    const cancellationIntentId = orderId(record.sourceSignalId, phase);
    const request = {
      operation: "cancel_flat_split_stop",
      sourceSignalId: record.sourceSignalId,
      symbol: state.symbol,
      environment: "vst",
      accountId: state.accountId,
      positionId: split.positionId,
      stopToCancel: {
        orderId: stopToCancel.orderId,
        quantity: String(stopToCancel.quantity),
        stopPrice: String(stopToCancel.stopPrice),
        ...(stopToCancel.tranche === "core" || stopToCancel.tranche === "runner"
          ? { tranche: stopToCancel.tranche }
          : {}),
      },
      knownRemainingStopOrderIds: [...knownIds],
      cancellationIntentId,
      priorPosition: state,
    };
    const submitted = await reserveAndPerform(record.sourceSignalId, phase, request);
    if (submitted.kind !== "submitted") {
      await store.setSignalStatus(record.sourceSignalId, "unknown",
        "impulse_flat_stop_cancel_requires_reconciliation");
      return {
        kind: "unknown",
        reason: "impulse_flat_stop_cancel_requires_reconciliation",
      };
    }
    let evidence;
    try {
      evidence = await broker.reconcileIntent({
        clientOrderId: submitted.clientOrderId, phase, request,
      });
      await commitFlatSplitStopCancellation({
        sourceSignalId: record.sourceSignalId,
        clientOrderId: submitted.clientOrderId,
      }, request, evidence);
      return { kind: "acted", operation: "cancel_flat_split_stop", stopOrderId: targetId };
    } catch (error) {
      const reason = error instanceof Error
        ? error.message : "impulse_flat_stop_cancel_unverified";
      await store.markIntent(submitted.clientOrderId, "unknown", {
        exchangeOrderId: evidence?.exchangeOrderId ?? null,
        outcome: { reason },
      });
      await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      return { kind: "unknown", reason };
    }
  }

  async function managePosition(
    record,
    capabilities,
    allowActions = true,
    reusableAccountSnapshot = null,
    allowProtectedExit = false,
    directCommand = null,
  ) {
    let state = record.snapshot;
    // This is an explicitly approved executor rule, not a fabricated source
    // instruction. The full-exit lane still verifies exact own fills, account,
    // position quantity, and each residual stop before committing a closure.
    if (exitStrategy === FULL_TAKE_5PCT && allowActions && !directCommand &&
        (Number(state.remainingQty) > 0 ||
          state.sourceExitEvidence?.rule === FULL_TAKE_5PCT)) {
      const requestId = fullTakeRequestId(record.sourceSignalId, state.entryPrice);
      const prior = await store.getIntent(record.sourceSignalId, sourceExitPhase(requestId));
      const saved = prior?.request?.sourceExit?.evidence ?? state.sourceExitEvidence ??
        latchedFullTakeEvidence(record);
      let row = fullTakeEvidenceValid(saved, record.sourceSignalId, state.symbol, requestId)
        ? { requestId, sourceSignalId: record.sourceSignalId, symbol: state.symbol,
          reason: FULL_TAKE_REASON, asOf: saved.asOf, observedAt: saved.observedAt, evidence: saved }
        : null;
      if (!row) {
        let mark;
        try { mark = await broker.readMarketMark(state.symbol); }
        catch { return { kind: "waiting", reason: "verified_market_mark_unavailable" }; }
        row = fullTakeRequest({ ...state, sourceSignalId: record.sourceSignalId }, mark, Number(clock()));
      }
      if (row) {
        directCloseCompletion = { requestId, completed: null };
        try { return await processSourceExitRequest(row, record, capabilities); }
        finally { directCloseCompletion = null; }
      }
    }
    if (state.protectedExit && state.split?.stage === "flat_cleanup_pending") {
      // The position is already exchange-confirmed flat. Only exact owned
      // residual stops may be cleaned up; the old transfer remains ambiguous.
      return await advanceFlatSplitCleanup(record, state, allowProtectedExit || allowActions);
    }
    if (state.protectionDegradation?.version === 1) {
      // A retired legacy stop POST remains quarantined, never re-attributed or
      // replayed. A separate verified full-exit lane may reduce exposure; stop
      // raises/margin writes remain disabled. Triggered fills retain their own
      // exact-ID settlement path.
      allowActions = false;
      const marker = state.protectionDegradation;
      if (marker.status === "protected_degraded" &&
          typeof store.getIntent === "function") {
        let original = await store.getIntent(record.sourceSignalId, marker.originalPhase);
        if (original?.state === "failed" && original.clientOrderId === marker.originalClientOrderId) {
          if (typeof store.claimUncertaintyRead === "function") {
            original = await store.claimUncertaintyRead(original, Number(clock()));
          }
          if (original) {
            const recovered = await recoverUnlinkedRaiseStopProtection(original, true);
            if (recovered.kind === "failed") {
              return { kind: "observed", reason: recovered.reason };
            }
          }
        }
      }
    }
    if (state.pendingStopRetirement !== undefined) {
      return await advanceAdoptedStopRetirement(record, capabilities, allowActions);
    }
    let policyRecovery = null;
    if (state.patternId === "impulse_buy") {
      if (state.split?.stage === "flat_cleanup_pending") {
        return await advanceFlatSplitCleanup(record, state, allowActions);
      }
      if (state.split?.stage === "runner_cleanup_pending") {
        return await advanceRunnerFillCleanup(record, state, allowActions);
      }
      if (state.split?.upgradePending) {
        return await advanceSplitUpgradeCancel(record, state, allowActions);
      }
      if (state.split?.stage === "cleanup_pending") {
        return await advanceImpulseCleanup(record, state, allowActions);
      }
      if (strategyAuthority !== "source" &&
          state.split?.stage && state.split.stage !== "complete") {
        return await continueImpulseSplitPhases(
          record.sourceSignalId, capabilities, allowActions,
        );
      }
      if (strategyAuthority !== "source" &&
          (state.split?.stage !== "complete" ||
          typeof store.commitVerifiedIntent !== "function")) {
        await store.setSignalStatus(record.sourceSignalId, "unknown",
          "impulse_split_state_missing_or_uncommittable");
        await store.upsertPosition({
          ...state, sourceSignalId: record.sourceSignalId, status: "unknown",
        });
        return { kind: "unknown", reason: "impulse_split_state_missing_or_uncommittable" };
      }
    }
    if (record.status === "unknown" ||
        state.executionStatus === "unsupported_after_core_runner_protection") {
      await store.setSignalStatus(record.sourceSignalId, "unknown",
        "position_management_unsupported_or_unverified");
      return { kind: "unknown", reason: "position_management_unsupported_or_unverified" };
    }
    if ((capabilities && state.accountId !== capabilities.accountId) ||
        state.environment !== "vst") {
      await store.setSignalStatus(record.sourceSignalId, "unknown", "position_account_or_environment_mismatch");
      return { kind: "unknown", reason: "position_account_or_environment_mismatch" };
    }
    if (state.patternId === "impulse_buy" && state.version === undefined) {
      const recovery = restoreVersionlessImpulsePolicyState(
        state, record.sourceSignalId,
      );
      if (!recovery.ok) {
        return { kind: "waiting", reason: recovery.reason };
      }
      policyRecovery = recovery.snapshot;
      state = policyRecovery;
    }
    let accountState = null;
    let reusedAccountSnapshotAt = null;
    if (state.patternId === "impulse_buy") {
      const snapshot = reusableAccountSnapshot?.accountState;
      const snapshotAgeMs = Number(performance.now()) -
        Number(reusableAccountSnapshot?.observedAt);
      const reusableSnapshotIsCurrent =
        state.version !== undefined &&
        policyRecovery === null &&
        validObject(snapshot) &&
        snapshot.verified === true &&
        snapshot.environment === "vst" &&
        snapshot.accountId === state.accountId &&
        Array.isArray(snapshot.positions) &&
        Array.isArray(snapshot.openOrders) &&
        Number.isFinite(snapshotAgeMs) &&
        snapshotAgeMs >= 0 &&
        snapshotAgeMs <= POSITION_ACCOUNT_SNAPSHOT_MAX_AGE_MS;
      if (reusableSnapshotIsCurrent) {
        accountState = snapshot;
        reusedAccountSnapshotAt = Number(reusableAccountSnapshot.observedAt);
      } else {
        // A failed account-wide read is not a position-local outage. Let it
        // reach the tick boundary so this symbol-scoped path cannot conceal a
        // global account proof failure.
        accountState = await broker.readAccountState();
      }
    }
    let persistedPosition = state.patternId === "impulse_buy"
      ? persistedSplitPosition(state, accountState) : undefined;
    if (policyRecovery &&
        (!validObject(accountState) || accountState.verified !== true ||
         accountState.environment !== "vst" ||
         accountState.accountId !== state.accountId ||
         !validObject(persistedPosition) ||
         persistedPosition.verified !== true ||
         persistedPosition.positionId !== state.exchangePositionId ||
         !closePolicyNumber(persistedPosition.quantity, state.remainingQty) ||
         persistedPosition.accountId !== state.accountId ||
         persistedPosition.symbol !== state.symbol)) {
      return {
        kind: "waiting",
        reason: "impulse_policy_snapshot_recovery_exchange_state_unverified",
      };
    }
    let exchangePosition;
    try {
      const readPositionOptions = state.patternId === "impulse_buy"
        ? { persistedPosition, allowProcessCache: false }
        : {};
      if (state.patternId === "impulse_buy" &&
          state.version !== undefined &&
          policyRecovery === null &&
          validObject(accountState) &&
          accountState.verified === true &&
          accountState.environment === "vst" &&
          accountState.accountId === state.accountId &&
          Array.isArray(accountState.positions) &&
          Array.isArray(accountState.openOrders)) {
        // The broker recognizes this exact readAccountState object as a
        // one-shot raw-row context. It can satisfy only this ordinary,
        // versioned position observation; versionless policy repair and
        // later action preflights continue to fetch fresh exchange evidence.
        readPositionOptions.accountStateContext = accountState;
      }
      exchangePosition = await withVstDiagnosticContext({
        operation: "read_position", check: "position_row",
      }, () => broker.readPosition(state.symbol, readPositionOptions));
    } catch (error) {
      const diagnostic = recordVstDiagnostic(error, {
        stage: "positionManagement", operation: "read_position",
        check: "position_row", symbol: state.symbol,
        sourceSignalId: record.sourceSignalId,
      });
      if (error instanceof Error &&
          error.message === "VST mark is not corroborated by a fresh quote") {
        notePositionReadIssue(
          record.sourceSignalId, state.symbol, "read_position", diagnostic,
        );
        return { kind: "waiting", reason: "verified_market_mark_unavailable" };
      }
      if (isCanonicalVstSymbol(state.symbol) &&
          isBoundedPositionReadFailure(error)) {
        notePositionReadIssue(
          record.sourceSignalId, state.symbol, "read_position", diagnostic,
        );
        return {
          kind: "unknown",
          reason: "managed_position_read_unavailable",
          scope: "symbol",
          diagnosticRef: diagnostic.ref,
        };
      }
      throw error;
    }
    const exchangeStops = { ...(exchangePosition?.protectiveStops ?? {}) };
    const reusedAccountSnapshotIsCurrent = reusedAccountSnapshotAt !== null &&
      Number(performance.now()) - reusedAccountSnapshotAt <=
        POSITION_ACCOUNT_SNAPSHOT_MAX_AGE_MS;
    if (state.patternId === "impulse_buy") {
      for (const leg of ["core", "runner"]) {
        if (!state[`${leg}Open`]) continue;
        if (reusedAccountSnapshotAt !== null &&
            !reusedAccountSnapshotIsCurrent) continue;
        // An impulse position may have no split at all (entered as a single
        // core leg, runner never opened: IDUSDT 2026-10-25). Its stop is then
        // proven by the regular protective-stop read, not a split stop.
        const raw = exactRawSplitStop(state, accountState, state.split?.[`${leg}Stop`]);
        if (raw) exchangeStops[leg] = raw;
      }
    }
    const verifiedExchangePosition = {
      ...exchangePosition,
      protectiveStops: exchangeStops,
    };
    const verifiedCoreStop = verifiedExchangePosition?.protectiveStops?.core;
    const verifiedRunnerStop = verifiedExchangePosition?.protectiveStops?.runner;
    const currentQuantity = Number(exchangePosition?.quantity);
    const positionQuantityMismatch = !Number.isFinite(currentQuantity) ||
      Math.abs(currentQuantity - Number(state.remainingQty)) >
        Math.max(1e-10, Number(state.quantity) * 1e-8);
    const hasExactStoredCoreStop = typeof state.exchangePositionId === "string" &&
      typeof state.coreStopOrderId === "string" &&
      typeof state.coreStopPositionId === "string" &&
      Number.isFinite(Number(state.coreStopQuantity));
    const exactCoreStopMissingOrChanged = state.coreOpen && hasExactStoredCoreStop &&
      (verifiedCoreStop?.verified !== true ||
       verifiedCoreStop.orderId !== state.coreStopOrderId ||
       verifiedCoreStop.positionId !== state.coreStopPositionId ||
       Number(verifiedCoreStop.quantity) !== Number(state.coreStopQuantity) ||
       Number(verifiedCoreStop.stopPrice) !== Number(state.stopPrice));
    const exactRunnerStopMissingOrChanged = state.patternId === "impulse_buy" &&
      state.runnerOpen &&
      (verifiedRunnerStop?.verified !== true ||
       verifiedRunnerStop.orderId !== state.runnerStopOrderId ||
       verifiedRunnerStop.positionId !== state.runnerStopPositionId ||
       Number(verifiedRunnerStop.quantity) !== Number(state.runnerStopQuantity) ||
       Number(verifiedRunnerStop.stopPrice) !== Number(state.runnerStopPrice));
    if (validObject(verifiedExchangePosition) && verifiedExchangePosition.verified === true &&
        verifiedExchangePosition.symbol === state.symbol &&
        verifiedExchangePosition.side === "Buy" &&
        Number(verifiedExchangePosition.leverage) === PROFILE_LEVERAGE &&
        profileMarginIs(verifiedExchangePosition.marginMode) &&
        (positionQuantityMismatch || exactCoreStopMissingOrChanged ||
          exactRunnerStopMissingOrChanged)) {
      if (policyRecovery) {
        return {
          kind: "waiting",
          reason: "impulse_policy_snapshot_recovery_exchange_state_unverified",
        };
      }
      if (state.patternId === "impulse_buy") {
        return await reconcileImpulseTriggeredStop(record, state, verifiedExchangePosition);
      }
      return await reconcileTriggeredStop(record, state);
    }
    const exchangePositionUnverified =
      !validObject(verifiedExchangePosition) || verifiedExchangePosition.verified !== true ||
      verifiedExchangePosition.side !== "Buy" ||
      verifiedExchangePosition.symbol !== state.symbol ||
      Number(verifiedExchangePosition.leverage) !== PROFILE_LEVERAGE ||
      !profileMarginIs(verifiedExchangePosition.marginMode) ||
      (hasExactStoredCoreStop && verifiedExchangePosition.positionId !== undefined &&
        verifiedExchangePosition.positionId !== state.exchangePositionId) ||
      Math.abs(Number(verifiedExchangePosition.quantity) - Number(state.remainingQty)) >
        Math.max(1e-10, Number(state.quantity) * 1e-8) ||
      (state.coreOpen && (verifiedCoreStop?.verified !== true ||
        (hasExactStoredCoreStop &&
          verifiedCoreStop.positionId !== state.coreStopPositionId) ||
        Number(verifiedCoreStop.stopPrice) !== Number(state.stopPrice) ||
        Number(verifiedCoreStop.quantity) + 1e-10 < Number(state.coreQty))) ||
      (state.runnerOpen && (verifiedRunnerStop?.verified !== true ||
        Number(verifiedRunnerStop.stopPrice) !== Number(state.runnerStopPrice) ||
        Number(verifiedRunnerStop.quantity) + 1e-10 < Number(state.runnerQty) ||
        state.patternId === "impulse_buy" &&
          (verifiedRunnerStop.orderId !== state.runnerStopOrderId ||
           verifiedRunnerStop.positionId !== state.runnerStopPositionId)));
    if (exchangePositionUnverified) {
      const pair = (expected, actual, matches = expected === actual) =>
        ({ expected, actual, matches });
      const diagnostic = recordVstRefusal(
        exactCoreStopMissingOrChanged || exactRunnerStopMissingOrChanged
          ? "stop_unverified" : "position_unverified",
        {
          stage: "positionManagement", operation: "manage_position",
          check: exactCoreStopMissingOrChanged || exactRunnerStopMissingOrChanged
            ? "protective_stop" : "position_row",
          symbol: state.symbol, sourceSignalId: record.sourceSignalId,
          stopEvidence: buildVstPositionCheckEvidence({
            positionVerified: pair(true, verifiedExchangePosition.verified),
            symbol: pair(state.symbol, verifiedExchangePosition.symbol),
            side: pair("Buy", verifiedExchangePosition.side),
            leverage: pair(PROFILE_LEVERAGE, verifiedExchangePosition.leverage,
              Number(verifiedExchangePosition.leverage) === PROFILE_LEVERAGE),
            marginMode: pair(PROFILE_MARGIN, verifiedExchangePosition.marginMode),
            ...(hasExactStoredCoreStop && verifiedExchangePosition.positionId !== undefined
              ? { positionId: pair(state.exchangePositionId, verifiedExchangePosition.positionId) } : {}),
            quantity: pair(state.remainingQty, verifiedExchangePosition.quantity,
              Math.abs(Number(verifiedExchangePosition.quantity) - Number(state.remainingQty)) <=
                Math.max(1e-10, Number(state.quantity) * 1e-8)),
            ...(state.coreOpen ? {
              coreVerified: pair(true, verifiedCoreStop?.verified),
              ...(hasExactStoredCoreStop
                ? { corePositionId: pair(state.coreStopPositionId, verifiedCoreStop?.positionId),
                  coreOrderId: pair(state.coreStopOrderId, verifiedCoreStop?.orderId),
                  coreExactQuantity: pair(state.coreStopQuantity, verifiedCoreStop?.quantity,
                    Number(verifiedCoreStop?.quantity) === Number(state.coreStopQuantity)) } : {}),
              coreStopPrice: pair(state.stopPrice, verifiedCoreStop?.stopPrice,
                Number(verifiedCoreStop?.stopPrice) === Number(state.stopPrice)),
              coreQuantity: pair(state.coreQty, verifiedCoreStop?.quantity,
                Number(verifiedCoreStop?.quantity) + 1e-10 >= Number(state.coreQty)),
            } : {}),
            ...(state.runnerOpen ? {
              runnerVerified: pair(true, verifiedRunnerStop?.verified),
              runnerStopPrice: pair(state.runnerStopPrice, verifiedRunnerStop?.stopPrice,
                Number(verifiedRunnerStop?.stopPrice) === Number(state.runnerStopPrice)),
              runnerQuantity: pair(state.runnerQty, verifiedRunnerStop?.quantity,
                Number(verifiedRunnerStop?.quantity) + 1e-10 >= Number(state.runnerQty)),
              ...(state.patternId === "impulse_buy" ? {
                runnerOrderId: pair(state.runnerStopOrderId, verifiedRunnerStop?.orderId),
                runnerPositionId: pair(state.runnerStopPositionId, verifiedRunnerStop?.positionId),
                runnerExactQuantity: pair(state.runnerStopQuantity, verifiedRunnerStop?.quantity,
                  Number(verifiedRunnerStop?.quantity) === Number(state.runnerStopQuantity)),
              } : {}),
            } : {}),
          }),
        },
      );
      if (policyRecovery) {
        return attachVstResultDiagnostic({
          kind: "waiting",
          reason: "impulse_policy_snapshot_recovery_exchange_state_unverified",
        }, diagnostic);
      }
      await store.setSignalStatus(record.sourceSignalId, "unknown", "exchange_position_or_leverage_mismatch");
      await store.upsertPosition({ ...state, sourceSignalId: record.sourceSignalId, status: "unknown" });
      return { kind: "unknown", reason: "exchange_position_or_leverage_mismatch",
        diagnosticRef: diagnostic.ref };
    }
    let mark;
    try {
      const positionReadForMarket =
        validObject(exchangePosition) &&
        exchangePosition.verified === true &&
        exchangePosition.environment === "vst" &&
        exchangePosition.accountId === state.accountId &&
        exchangePosition.symbol === state.symbol
          ? exchangePosition
          : undefined;
      mark = await withVstDiagnosticContext({
        operation: "read_market_mark", check: "market_mark",
      }, () => positionReadForMarket
        ? broker.readMarketMark(state.symbol, { positionRead: positionReadForMarket })
        : broker.readMarketMark(state.symbol));
    } catch (error) {
      const diagnostic = recordVstDiagnostic(error, {
        stage: "positionManagement", operation: "read_market_mark",
        check: "market_mark", symbol: state.symbol,
        sourceSignalId: record.sourceSignalId,
      });
      if (error instanceof Error &&
          error.message === "VST mark is not corroborated by a fresh quote") {
        notePositionReadIssue(
          record.sourceSignalId, state.symbol, "read_market_mark", diagnostic,
        );
        return { kind: "waiting", reason: "verified_market_mark_unavailable" };
      }
      if (isCanonicalVstSymbol(state.symbol) &&
          isBoundedPositionReadFailure(error)) {
        notePositionReadIssue(
          record.sourceSignalId, state.symbol, "read_market_mark", diagnostic,
        );
        return {
          kind: "unknown",
          reason: "managed_position_read_unavailable",
          scope: "symbol",
        };
      }
      throw error;
    }
    if (!validObject(mark) || mark.verified !== true) {
      const diagnostic = recordVstRefusal("market_mark_unverified", {
        stage: "positionManagement", operation: "read_market_mark",
        check: "market_mark", symbol: state.symbol,
        sourceSignalId: record.sourceSignalId,
      });
      notePositionReadIssue(
        record.sourceSignalId, state.symbol, "read_market_mark", diagnostic,
      );
      return { kind: "waiting", reason: "verified_market_mark_unavailable" };
    }
    if (!capabilities) {
      return { kind: "waiting", reason: "verified_vst_account_identity_unavailable" };
    }
    let evaluationState = state;
    const preservedRunnerStopPrice = state.runnerStopPrice;
    if (state.patternId === "impulse_buy" && state.runnerOpen === false &&
        preservedRunnerStopPrice == null &&
        closePolicyNumber(state.split?.breakEvenPrice, state.entryPrice)) {
      // The policy validator requires a runner stop even after the runner is
      // closed. Use its verified original break-even as an evaluation-only
      // sentinel, then keep the persisted inactive-leg stop field unchanged.
      evaluationState = {
        ...state,
        runnerStopPrice: Number(state.split.breakEvenPrice),
      };
    }
    let result;
    let sourceControl = directCommand ? {
      sourceAction: "hold", sourceSignalId: directCommand.sourceSignalId,
      symbol: directCommand.symbol, sourceStopLossPrice: directCommand.stopPrice,
      observedAt: new Date(clock()).toISOString(), commandId: directCommand.commandId,
    } : undefined;
    if (!directCommand && typeof store.getSourceControl === "function") {
      try {
        sourceControl = await store.getSourceControl(record.sourceSignalId);
        if (["review", "unknown"].includes(sourceControl?.sourceAction) &&
            typeof store.recordSourceControlExchangeObservation === "function") {
          await store.recordSourceControlExchangeObservation(sourceControl, {
            verified: true, positionId: state.exchangePositionId,
            quantity: String(exchangePosition.quantity),
            observedAt: new Date(Number(clock())).toISOString(),
          });
        }
      } catch {
        recordVstRefusal("source_control_read_unavailable", {
          stage: "positionManagement", operation: "read_position", check: "position_binding",
          symbol: state.symbol, sourceSignalId: record.sourceSignalId,
        });
        return { kind: "waiting", reason: "source_control_read_unavailable" };
      }
    }
    try {
      result = strategyAuthority === "source"
        ? evaluateSourceFollower({ ...state, sourceSignalId: record.sourceSignalId },
          sourceControl, Number(mark.price), { observedAt: mark.observedAt })
        : evaluateVstPolicy(evaluationState, {
          price: mark.price, at: mark.observedAt,
        });
      if (evaluationState !== state) {
        result.next.runnerStopPrice = preservedRunnerStopPrice;
      }
      if (strategyAuthority !== "source" && typeof store.getSourceControl === "function") {
        result = applySourceProtection(result, {
          ...state, sourceSignalId: record.sourceSignalId,
        }, sourceControl, Number(mark.price));
      }
    } catch {
      return {
        kind: "waiting",
        reason: policyRecovery
          ? "impulse_policy_snapshot_recovery_policy_evaluation_failed"
          : "position_policy_state_invalid",
      };
    }
    if (policyRecovery) {
      try {
        await store.upsertPosition({
          ...state,
          sourceSignalId: record.sourceSignalId,
        });
      } catch {
        return {
          kind: "waiting",
          reason: "impulse_policy_snapshot_recovery_persist_failed",
        };
      }
    }
    if (!result.actions.length) {
      await store.upsertPosition({
        ...state,
        sourceSignalId: record.sourceSignalId,
        symbol: state.symbol,
        status: result.next.status,
        ...result.next,
        sizing: state.sizing,
        marginMode: PROFILE_MARGIN,
        leverage: PROFILE_LEVERAGE,
        environment: "vst",
        accountId: state.accountId,
        entryClientOrderId: state.entryClientOrderId,
      });
      return { kind: "observed" };
    }
    const executableActions = result.actions.filter(
      (action) => action.type !== "observation_window_elapsed",
    );
    if (!executableActions.length) {
      await store.upsertPosition({
        ...state,
        sourceSignalId: record.sourceSignalId,
        symbol: state.symbol,
        status: result.next.status,
        ...result.next,
        sizing: state.sizing,
        marginMode: PROFILE_MARGIN,
        leverage: PROFILE_LEVERAGE,
        environment: "vst",
        accountId: state.accountId,
        entryClientOrderId: state.entryClientOrderId,
      });
      await store.recordEvent?.(record.sourceSignalId, "vst_observation_window_elapsed", {
        action: "continue_protection",
        observedAt: result.next.observedAt,
      });
      return { kind: "observed" };
    }
    if (state.patternId === "impulse_buy") {
      // Account rows used to observe a position, including a broker-issued
      // one-shot context, are never action preflight evidence. Fetch and
      // validate a separate current snapshot before any executable branch.
      try {
        accountState = await broker.readAccountState();
      } catch {
        return { kind: "waiting", reason: "account_state_not_verified" };
      }
      if (!validObject(accountState) || accountState.verified !== true ||
          accountState.environment !== "vst" ||
          accountState.accountId !== state.accountId ||
          !Array.isArray(accountState.positions) ||
          !Array.isArray(accountState.openOrders)) {
        return { kind: "waiting", reason: "account_state_not_verified" };
      }
      // Preserve this fresh snapshot for the action-specific exact raw-row
      // preflight below. Do not require a persisted stop snapshot here: a
      // mismatch must reach that preflight so it can be recorded as an
      // explicit fail-closed action verdict rather than silently waiting.
      persistedPosition = persistedSplitPosition(state, accountState);
    }
    if (!allowActions) {
      const exit = executableActions.find(action =>
        action.type === "close_core" &&
        Number(action.quantity) === Number(state.remainingQty));
      if (allowProtectedExit && exit &&
          (state.patternId !== "impulse_buy" || state.coreOpen && !state.runnerOpen) &&
          state.protectionDegradation?.version === 1 &&
          assessmentCanMutateSourceExit(capabilities) &&
          !exchangeActionAttemptedThisTick) {
        // Reuse the strict entry-identity + exact owned-stop preflight, NOT a
        // source decision. This remains a strategy exit with its own intent.
        let preflight;
        try {
          preflight = await sourceExitPositionPreflight(record, capabilities);
        } catch (error) {
          const diagnostic = recordVstRefusal(error instanceof Error
            ? error.message : "position_proof_unverified", {
            stage: "positionManagement", operation: "close_leg", check: "ownership",
            symbol: state.symbol, sourceSignalId: record.sourceSignalId,
          });
          return { kind: "waiting", reason: "protected_exit_preflight_not_verified",
            diagnosticRef: diagnostic.ref };
        }
        const next = intermediatePolicyAfterAction(state, exit, result.next);
        const request = {
          operation: "close_leg", sourceSignalId: record.sourceSignalId,
          symbol: state.symbol, leg: "core", accountId: state.accountId,
          environment: "vst", positionId: state.exchangePositionId,
          quantity: preflight.quantity, previousQuantity: preflight.quantity,
          reason: exit.reason, priorPosition: state,
          ...(exit.sourceProtection ? { sourceProtection: exit.sourceProtection } : {}),
          nextPolicy: next, nextPosition: { ...state, ...next },
          entryClientOrderId: preflight.state.entryClientOrderId,
          entryOrderId: preflight.state.entryOrderId,
          entryAt: preflight.state.entryAt,
          entryOrderType: preflight.state.entryOrderType,
          protectedExit: {
            version: 1, sourceSignalId: record.sourceSignalId,
            symbol: state.symbol, positionId: state.exchangePositionId,
            originalClientOrderId: state.protectionDegradation.originalClientOrderId,
            entryOrderId: preflight.state.entryOrderId,
            ownedStops: preflight.ownedStops, quantity: preflight.quantity,
            reason: exit.reason, price: String(mark.price),
            observedAt: new Date(mark.observedAt).toISOString(),
          },
        };
        const entryBinding = await loadRaiseStopEntryProof({
          sourceSignalId: record.sourceSignalId, request,
        }, state.exchangePositionId, state);
        if (!entryBinding || typeof store.commitVerifiedIntent !== "function") {
          return { kind: "waiting", reason: "protected_exit_durable_entry_proof_unavailable" };
        }
        request.entryProof = entryBinding.proof;
        const phase = `protected-exit-${state.protectionDegradation.originalClientOrderId}`;
        const submitted = await reserveAndPerform(record.sourceSignalId, phase, request);
        const intent = await store.getIntent(record.sourceSignalId, phase);
        if (intent && ["submitted", "unknown"].includes(intent.state)) {
          const settled = await reconcileOne(intent, capabilities, false);
          return settled.kind === "reconciled"
            ? { ...settled, kind: "acted" } : settled;
        }
        return { kind: "waiting", reason: "protected_exit_requires_reconciliation",
          clientOrderId: submitted.clientOrderId };
      }
      // Keep the verified exchange stops and quantities authoritative. Record
      // only observations/peaks; do not commit any stop or close from a plan
      // that cannot currently be executed and reconciled.
      await store.upsertPosition({
        ...state,
        sourceSignalId: record.sourceSignalId,
        status: "open",
        observedAt: result.next.observedAt,
        peakPct: result.next.peakPct,
        runnerPeakPct: result.next.runnerPeakPct,
        observationWindowNoted: result.next.observationWindowNoted,
      });
      return { kind: "waiting", reason: "verified_mutation_capabilities_unavailable" };
    }
    const rawAction = executableActions[0];
    const action = rawAction.type === "raise_stop"
      ? (() => {
        const stopPriceText = roundStopPriceUpToPrecision(
          rawAction.stopPrice, exchangePosition.pricePrecision, "policy stop price",
        );
        // Keep stopPrice a Number, matching every other policy field, so
        // persisted state is not silently retyped; stopPriceText is the
        // exact rounded decimal string the exchange call must send.
        return { ...rawAction, stopPrice: Number(stopPriceText), stopPriceText };
      })()
      : rawAction;
    if (action.type === "raise_stop") {
      const monotonicity = await verifyRaiseStopMonotonicity(state, action);
      if (!monotonicity.verified) {
        const reason = monotonicity.reason ??
          "raise_stop_monotonicity_not_verified";
        await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
        await store.upsertPosition({
          ...state, sourceSignalId: record.sourceSignalId, status: "unknown",
        });
        return { kind: "unknown", reason };
      }
      if (monotonicity.relation === "equal") {
        // Policy arithmetic can retain binary floating-point residue after
        // exchange-tick rounding. The exchange stop is authoritative: an
        // equal normalized target is an observation, never an upgrade intent.
        await store.upsertPosition({
          ...state,
          sourceSignalId: record.sourceSignalId,
          status: "open",
          observedAt: result.next.observedAt,
          peakPct: result.next.peakPct,
          runnerPeakPct: result.next.runnerPeakPct,
          observationWindowNoted: result.next.observationWindowNoted,
        });
        return { kind: "observed", reason: "raise_stop_already_at_target" };
      }
      if (monotonicity.relation !== "higher") {
        const reason = "raise_stop_target_not_higher_than_verified_stop";
        await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
        await store.upsertPosition({
          ...state, sourceSignalId: record.sourceSignalId, status: "unknown",
        });
        return { kind: "unknown", reason };
      }
    }
    if (state.patternId === "impulse_buy" && action.type === "raise_stop") {
      if (state.coreOpen === true && state.runnerOpen === false) {
        return await raiseSoleCoreStop(
          record, state, action, result.next, capabilities,
        );
      }
      return await placeSplitStopUpgrade(
        record, state, action, result.next, capabilities,
      );
    }
    if (state.patternId === "impulse_buy" &&
        ["close_core", "close_runner"].includes(action.type) &&
        (state.coreOpen === true) !== (state.runnerOpen === true)) {
      const soleLeg = state.coreOpen ? "core" : "runner";
      if (action.type !== `close_${soleLeg}`) {
        const reason = "impulse_sole_leg_policy_action_mismatch";
        await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
        await store.upsertPosition({
          ...state, sourceSignalId: record.sourceSignalId, status: "unknown",
        });
        return { kind: "unknown", reason };
      }
      return await closeSoleSurvivor(
        record, state, { ...action, leg: soleLeg }, result.next, allowActions,
      );
    }
    const nextPolicy = intermediatePolicyAfterAction(state, action, result.next);
    const nextPosition = {
      ...state,
      sourceSignalId: record.sourceSignalId,
      symbol: state.symbol,
      status: nextPolicy.status,
      ...nextPolicy,
      sizing: state.sizing,
      marginMode: PROFILE_MARGIN,
      leverage: PROFILE_LEVERAGE,
      environment: "vst",
      accountId: state.accountId,
      entryClientOrderId: state.entryClientOrderId,
    };
    const phase = directCommand
      ? `raise_stop-${action.leg ?? "core"}-command-${createHash("sha256").update(directCommand.commandId).digest("hex").slice(0, 24)}`
      : `${action.type}-${action.leg ?? "position"}-${Date.parse(result.next.observedAt)}`;
    let request;
    if (state.patternId === "impulse_buy") {
      const previousQuantity = Number(state.remainingQty);
      const retainedLeg = action.leg === "core" ? "runner" : "core";
      const residualQuantity = Number(state.split?.[`${retainedLeg}Quantity`]);
      const quantityTolerance = Math.max(1e-10, Number(state.quantity) * 1e-8);
      if (!["close_core", "close_runner"].includes(action.type) ||
          state.split?.stage !== "complete" ||
          !state.coreOpen || !state.runnerOpen ||
          !state.split?.coreStop || !state.split?.runnerStop ||
          !Number.isFinite(residualQuantity) || residualQuantity <= 0 ||
          residualQuantity >= previousQuantity ||
          Math.abs(Number(nextPolicy.remainingQty) - residualQuantity) > quantityTolerance ||
          Number(action.quantity) >= previousQuantity ||
          typeof store.commitVerifiedIntent !== "function") {
        const reason = "impulse_split_action_not_supported_without_exact_survivor_proof";
        await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
        await store.upsertPosition({
          ...state, sourceSignalId: record.sourceSignalId, status: "unknown",
        });
        return { kind: "unknown", reason };
      }
      const accountOrders = symbolOrders(accountState, state.symbol);
      const exactIds = exactOrderIds(accountOrders);
      const exactCoreStop = exactRawSplitStop(
        state, accountState, state.split.coreStop,
      );
      const exactRunnerStop = exactRawSplitStop(
        state, accountState, state.split.runnerStop,
      );
      if (!validObject(exchangePosition) || exchangePosition.verified !== true ||
          exchangePosition.positionId !== state.split.positionId ||
          Number(exchangePosition.quantity) !== Number(state.split.totalQuantity) ||
          !Array.isArray(accountOrders) || accountOrders.length !== 2 ||
          !exactIds ||
          JSON.stringify(exactIds.slice().sort()) !== JSON.stringify([
            state.split.coreStop.orderId, state.split.runnerStop.orderId,
          ].sort()) ||
          !exactCoreStop || !exactRunnerStop ||
          Number(exactCoreStop.quantity) !== Number(state.split.coreQuantity) ||
          Number(exactRunnerStop.quantity) !== Number(state.split.runnerQuantity)) {
        const reason = "impulse_split_partial_close_preflight_not_verified";
        await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
        await store.upsertPosition({
          ...state, sourceSignalId: record.sourceSignalId, status: "unknown",
        });
        return { kind: "unknown", reason };
      }
      const pendingClosePolicy = {
        ...intermediatePolicyAfterAction(state, action, result.next),
        remainingQty: residualQuantity,
      };
      const activeIds = [state.split.coreStop.orderId, state.split.runnerStop.orderId].sort();
      const split = {
        ...state.split,
        stage: "cleanup_pending",
        cleanupLeg: action.leg,
        cleanupRemainingQuantity: String(residualQuantity),
        baselineOpenOrderIds: activeIds,
        pendingClosePolicy,
        activeLegs: ["core", "runner"],
      };
      const cleanupPosition = {
        ...state,
        status: "closing",
        executionStatus: "impulse_split_cleanup_pending",
        split,
        pendingClose: {
          closedLeg: action.leg,
          remainingQuantity: String(residualQuantity),
          nextPolicy: pendingClosePolicy,
        },
      };
      request = impulseSplitRequest(record, state, "close_leg", {
        signal: record.body ?? state.signalSnapshot,
        leg: action.leg,
        quantity: String(state.split[`${action.leg}Quantity`]),
        previousQuantity: state.split.totalQuantity,
        exchangeAutoResizeAware: true,
        reason: action.reason,
        nextPolicy: pendingClosePolicy,
        nextPosition: cleanupPosition,
        ...(persistedPosition ? { persistedPosition } : {}),
      });
    } else {
      request = action.type === "raise_stop"
        ? {
          operation: "raise_stop", sourceSignalId: record.sourceSignalId,
          symbol: state.symbol, leg: action.leg,
          accountId: capabilities.accountId, environment: "vst",
          positionId: state.exchangePositionId,
          entryClientOrderId: state.entryClientOrderId,
          ...(state.entryOrderId ? { entryOrderId: state.entryOrderId } : {}),
          ...(state.entryAt !== undefined ? { entryAt: state.entryAt } : {}),
          quantity: action.leg === "runner" ? state.runnerQty : state.coreQty,
           stopPrice: action.stopPriceText, reason: action.reason,
           stopStartedAt: Number(clock()),
          previousQuantity: Number(exchangePosition.quantity), nextPolicy, nextPosition,
          priorPosition: state,
        }
        : {
          operation: "close_leg", sourceSignalId: record.sourceSignalId,
          symbol: state.symbol, leg: action.leg,
          accountId: capabilities.accountId, environment: "vst",
          quantity: action.quantity, reason: action.reason,
           stopStartedAt: Number(clock()),
          previousQuantity: Number(exchangePosition.quantity), nextPolicy, nextPosition,
        };
    }
    if (action.sourceProtection) request.sourceProtection = action.sourceProtection;
    if (request.operation === "raise_stop") {
      const entryBinding = await loadRaiseStopEntryProof(
        { sourceSignalId: record.sourceSignalId, request },
        state.exchangePositionId,
      );
      if (!entryBinding) {
        const reason = "raise_stop_original_entry_intent_not_verified";
        await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
        await store.upsertPosition({
          ...state, sourceSignalId: record.sourceSignalId, status: "unknown",
        });
        return { kind: "unknown", reason };
      }
      request.entryProof = entryBinding.proof;
      if (typeof store.commitVerifiedIntent !== "function") {
        const reason = "raise_stop_atomic_commit_unavailable";
        await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
        return { kind: "unknown", reason };
      }
    }
    const submitted = await reserveAndPerform(record.sourceSignalId, phase, request);
    if (submitted.kind !== "submitted") {
      await store.setSignalStatus(record.sourceSignalId, "unknown", "position_action_requires_reconciliation");
      return { kind: "unknown", reason: "position_action_requires_reconciliation" };
    }
    let evidence;
    try {
      evidence = await broker.reconcileIntent({
        clientOrderId: submitted.clientOrderId, phase, request,
        ...(request.operation === "raise_stop" && submitted.exchangeOrderId
          ? { exchangeOrderId: submitted.exchangeOrderId } : {}),
      });
    } catch {
      evidence = { verified: false, status: "unknown" };
    }
    try {
      checkActionEvidence(request, evidence, PROFILE);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "exchange_action_state_not_verified";
      await store.markIntent(submitted.clientOrderId, "unknown", {
        exchangeOrderId: evidence?.exchangeOrderId ?? null,
        outcome: { reason },
      });
      if (request.operation !== "raise_stop") {
        await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
      }
      return { kind: "unknown", reason };
    }
    if (request.operation === "close_leg" &&
        request.signal?.patternId === "impulse_buy") {
      const nextPosition = await withFreshPersistedSplitPosition(
        confirmedActionPosition(request, evidence),
      );
      if (!nextPosition.persistedPosition) {
        const reason = "impulse_partial_close_persisted_position_not_verified";
        await store.markIntent(submitted.clientOrderId, "unknown", {
          exchangeOrderId: evidence?.exchangeOrderId ?? null,
          outcome: { reason },
        });
        await store.setSignalStatus(record.sourceSignalId, "unknown", reason);
        await store.upsertPosition({
          ...nextPosition, sourceSignalId: record.sourceSignalId, status: "unknown",
        });
        return { kind: "unknown", reason };
      }
      await store.commitVerifiedIntent({
        sourceSignalId: record.sourceSignalId,
        clientOrderId: submitted.clientOrderId,
        position: nextPosition,
        signalStatus: "open",
        exchangeOrderId: evidence.exchangeOrderId ?? null,
        outcome: {
          status: "filled",
          verified: true,
          operation: request.operation,
          fill: closeFillSnapshot(evidence),
          autoResize: evidence.autoResize,
          cleanupStage: "cleanup_pending",
        },
        eventKind: "vst_impulse_partial_close_cleanup_pending",
        eventDetail: {
          leg: request.leg,
          quantity: request.quantity,
          remainingQuantity: evidence.autoResize.observedQuantity,
          retainedStopOrderId: evidence.autoResize.retainedStopOrderId,
        },
      });
      return { kind: "acted", operation: request.operation, leg: action.leg };
    }
    if (request.operation === "raise_stop") {
      try {
        await commitVerifiedRaiseStop({
          sourceSignalId: record.sourceSignalId,
          clientOrderId: submitted.clientOrderId,
          exchangeOrderId: submitted.exchangeOrderId ?? null,
          phase,
          request,
        }, request, evidence);
      } catch (error) {
        const reason = error instanceof Error
          ? error.message : "raise_stop_evidence_not_verified";
        await store.markIntent(submitted.clientOrderId, "unknown", {
          exchangeOrderId: evidence?.exchangeOrderId ??
            submitted.exchangeOrderId ?? null,
          outcome: { reason },
        });
        return { kind: "unknown", reason };
      }
      return { kind: "acted", operation: request.operation, leg: action.leg };
    }
    await store.upsertPosition(confirmedActionPosition(request, evidence));
    await store.markIntent(submitted.clientOrderId, "reconciled", {
      exchangeOrderId: evidence.exchangeOrderId ?? null,
      outcome: {
        status: "filled", verified: true, operation: request.operation,
        ...(request.operation === "close_leg"
          ? {
              fill: closeFillSnapshot(evidence),
              residualProtectiveStops: evidence.protectiveStops ??
                evidence.position.protectiveStops ?? {},
            }
          : {}),
      },
    });
    await store.setSignalStatus(
      record.sourceSignalId, nextPolicy.status === "closed" ? "closed" : "open",
    );
    return { kind: "acted", operation: request.operation, leg: action.leg };
  }

  // One shared incident for the whole pipeline, exactly like before many
  // symbols could progress concurrently: the owner cares about total
  // elapsed time since the pipeline last made genuine progress, not which
  // particular symbol or reason is the proximate cause on any given tick.
  // The underlying cause can change tick to tick (a stuck ETHUSDT intent
  // resolving into a stuck BTCUSDT position, say) without resetting the
  // clock -- only an actual "acted"/"idle"/etc. result (see runOnce) clears
  // it. Per-symbol scoping was tried and reverted: with many symbols now
  // able to act independently, keying this by symbol let one healthy
  // symbol's activity mask a value a DIFFERENT stuck symbol never crossing
  // the alert threshold under its own separate, freshly-started timer.
  // reportUnresolvedIntentsIfDue's independent re-check below covers the
  // remaining risk -- a stuck intent never even becoming `result` because
  // other symbols keep winning the single return slot -- without needing
  // per-symbol timers.
  let blockedSince = null;
  let lastBlockedAlertAt = null;
  let pendingWaitingSince = null;
  let lastPendingWaitingAlertAt = null;
  const positionIssuesThisTick = new Map();
  const positionReadDiagnosticsThisTick = new Map();
  const positionReadsRecoveredThisTick = new Set();
  const positionReadRecovery = createVstReadRecoveryTracker({ now: () => Number(clock()) });
  const positionIssueSince = new Map();
  const lastPositionIssueAlertAt = new Map();
  const lastPositionIssueAlertSignature = new Map();
  const unresolvedIntentSince = new Map();
  const lastUnresolvedIntentAlertAt = new Map();
  const deferredRecoveryReasonByIntent = new Map();
  const deferredRecoveryDiagnosticRefByIntent = new Map();
  const deferredRecoveryAttemptAtByIntent = new Map();
  const lastUnresolvedDiagnosticAt = new Map();
  const lastUnresolvedDiagnosticSignature = new Map();
  const lastUnresolvedIntentAlertSignature = new Map();
  let lastSlowTimingAt = null;
  let lastWaitingTimingAt = null;
  let historicalCloseCursor = null;
  let historicalProofAttemptedThisTick = false;
  const historicalCloseAttempts = new Map();
  const readAlertAggregator = createVstReadAlertAggregator({
    send: async (info) => { await onBlocked(info); },
    now: () => Number(clock()),
    blockedAfterMs: BLOCKED_ALERT_AFTER_MS,
    repeatAfterMs: BLOCKED_ALERT_REPEAT_MS,
  });

  function notePositionReadIssue(sourceSignalId, symbol, operation, diagnostic) {
    if (!isCanonicalVstSymbol(symbol)) return;
    positionReadRecovery.failed(sourceSignalId);
    positionReadDiagnosticsThisTick.set(sourceSignalId, diagnostic);
    const diagnosticRef = diagnostic?.ref;
    const prior = positionIssuesThisTick.get(sourceSignalId);
    const safeRef = typeof diagnosticRef === "string" && /^[a-f0-9]{12}$/.test(diagnosticRef)
      ? diagnosticRef : prior?.diagnosticRef;
    positionIssuesThisTick.set(sourceSignalId, {
      reason: "managed_position_read_unavailable",
      sourceSignalId,
      symbol,
      operation,
      ...(safeRef ? { diagnosticRef: safeRef } : {}),
    });
  }

  function rememberRecoveryDeferredReason(intent, reason, diagnosticRef) {
    const key = reconciliationIntentKey(intent);
    if (SAFE_RECOVERY_DEFERRED_REASONS.has(reason)) {
      deferredRecoveryReasonByIntent.set(key, reason);
      deferredRecoveryAttemptAtByIntent.set(key, Number(clock()));
      if (typeof diagnosticRef === "string" && /^[a-f0-9]{12}$/.test(diagnosticRef)) {
        deferredRecoveryDiagnosticRefByIntent.set(key, diagnosticRef);
      } else {
        deferredRecoveryDiagnosticRefByIntent.delete(key);
      }
    } else {
      deferredRecoveryReasonByIntent.delete(key);
      deferredRecoveryDiagnosticRefByIntent.delete(key);
      deferredRecoveryAttemptAtByIntent.delete(key);
    }
  }

  async function sendBlockedAlert(info) {
    try {
      await onBlocked(info);
    } catch {
      // Alert delivery is best-effort; a Telegram/network failure here must
      // never surface as a trading error or retry the tick.
    }
  }

  // Notification is a side effect of the tick, never a gate on it: a
  // rejected/thrown alert must not change runOnce()'s return value or stop
  // the next tick from running.
  async function reportBlockedIfDue(result) {
    if (typeof onBlocked !== "function") return;
    // Symbol-scoped position failures already have independent alert timers.
    // Returning one at the end of an exhausted candidate scan is for caller
    // visibility only; don't also report it through the shared blocked timer.
    if (result?.kind === "unknown" &&
        result.scope === "symbol" &&
        positionIssuesThisTick.has(result.sourceSignalId)) return;
    // A position management outcome of "unknown" (see the position loop
    // above) stalls that position exactly like an unresolved order intent
    // does. Without this, a position that never resolves on its own (no
    // order intent ever exists for most of these reasons, so
    // reconcileOutstanding's unresolved-intent check never sees it either)
    // would freeze silently forever, with neither this alert nor a
    // per-signal Telegram notification ever firing.
    // A capability/account read that is merely waiting must not reset a
    // blocked-position or unresolved-intent incident. Unresolved intents use
    // their own timers below and are not sent through this shared alert path.
    if (result?.kind === "waiting" ||
        result?.reason === "unresolved_vst_order_intents") return;
    const stalled = result?.kind === "blocked" || result?.kind === "unknown";
    if (!stalled) {
      blockedSince = null;
      lastBlockedAlertAt = null;
      return;
    }
    const now = Number(clock());
    if (blockedSince === null) blockedSince = now;
    const blockedForMs = now - blockedSince;
    if (blockedForMs < BLOCKED_ALERT_AFTER_MS) return;
    if (lastBlockedAlertAt !== null &&
        now - lastBlockedAlertAt < BLOCKED_ALERT_REPEAT_MS) return;
    lastBlockedAlertAt = now;
    await sendBlockedAlert({
      reason: result.reason,
      scope: isCanonicalVstSymbol(result.symbol) ? "symbol" : "account",
      blockedForMs,
      count: result.count,
      sourceSignalId: result.sourceSignalId,
      symbol: result.symbol,
      operation: result.operation,
      entryNotSubmitted: result.entryNotSubmitted === true,
      diagnosticRef: result.diagnosticRef,
    });
  }

  async function reportPositionIssuesIfDue() {
    if (typeof onBlocked !== "function") return;
    const now = Number(clock());
    const issues = [];
    for (const issue of positionIssuesThisTick.values()) {
      const key = issue.sourceSignalId;
      if (!positionIssueSince.has(key)) {
        positionIssueSince.set(key, blockedSince ?? now);
      }
      const blockedForMs = now - positionIssueSince.get(key);
      issues.push({ ...issue, scope: "symbol", blockedForMs, count: 1 });
    }
    const grouped = await readAlertAggregator.report(
      issues.map((issue) => ({
        ...issue, diagnostic: positionReadDiagnosticsThisTick.get(issue.sourceSignalId),
      })), [...positionReadsRecoveredThisTick],
    );
    for (const issue of issues) {
      const key = issue.sourceSignalId;
      const { blockedForMs } = issue;
      if (grouped.has(key)) continue;
      if (blockedForMs < BLOCKED_ALERT_AFTER_MS) continue;
      const diagnostic = positionReadDiagnosticsThisTick.get(key);
      // This reviewed price-refusal cause can alternate API context between
      // failed corroboration reads. That is not a new owner incident.
      // Unclassified, protection and mutation warnings keep their exact keys.
      const signature = diagnostic?.reason === "market_mark_unverified" &&
        issue.reason === "managed_position_read_unavailable" && issue.diagnosticRef
        ? JSON.stringify([issue.reason, "market_mark_unverified", issue.diagnosticRef])
        : JSON.stringify([issue.reason, issue.operation,
        issue.diagnosticRef, diagnostic?.errorClass, diagnostic?.apiMethod,
        diagnostic?.method, diagnostic?.endpoint ?? diagnostic?.requestEndpoint,
        diagnostic?.check, diagnostic?.validationField]);
      const lastAlertAt = lastPositionIssueAlertAt.get(key);
      if (lastPositionIssueAlertSignature.get(key) === signature &&
          lastAlertAt !== undefined &&
          now - lastAlertAt < BLOCKED_ALERT_REPEAT_MS) continue;
      lastPositionIssueAlertAt.set(key, now);
      lastPositionIssueAlertSignature.set(key, signature);
      await sendBlockedAlert({
        ...issue,
        scope: "symbol",
        blockedForMs,
        count: 1,
        diagnostic,
      });
    }
  }

  async function reportPendingSignalsWaiting(result) {
    if (typeof onBlocked !== "function") return;
    if (result?.kind !== "waiting") {
      pendingWaitingSince = null;
      lastPendingWaitingAlertAt = null;
      return;
    }

    let candidates;
    try {
      candidates = typeof store.listPendingCandidates === "function"
        ? await store.listPendingCandidates(200)
        : [await store.getPending()].filter(Boolean);
    } catch {
      candidates = [];
    }
    const waitingSignals = Array.isArray(candidates)
      ? candidates.filter((candidate) => candidate?.status === "pending")
      : [];
    if (!waitingSignals.length) {
      pendingWaitingSince = null;
      lastPendingWaitingAlertAt = null;
      return;
    }

    const now = Number(clock());
    if (pendingWaitingSince === null) pendingWaitingSince = now;
    const blockedForMs = now - pendingWaitingSince;
    if (blockedForMs < BLOCKED_ALERT_AFTER_MS) return;
    if (lastPendingWaitingAlertAt !== null &&
        now - lastPendingWaitingAlertAt < BLOCKED_ALERT_REPEAT_MS) return;
    lastPendingWaitingAlertAt = now;
    const first = waitingSignals[0];
    await sendBlockedAlert({
      reason: "pending_vst_signals_waiting",
      scope: "account",
      blockedForMs,
      count: waitingSignals.length,
      sourceSignalId: first.sourceSignalId,
      symbol: first.body?.symbol,
    });
  }

  // Independent of whatever runOnceInternal returns: each unresolved intent
  // keeps its own timer, so a different waiting/blocked result cannot reset
  // or mask its alert.
  async function reportUnresolvedIntentsIfDue() {
    // Even a confirmed read failure while reconciling an intent is not a
    // read-only incident: a prior POST/DELETE may have changed funds or stops.
    // Keep every intent's financial-risk warning independent of read summaries.
    if (typeof store.listUnresolvedIntents !== "function") return;
    let unresolvedIntents;
    try {
      unresolvedIntents = await store.listUnresolvedIntents();
    } catch {
      return;
    }
    if (!Array.isArray(unresolvedIntents)) return;
    const now = Number(clock());
    const activeKeys = new Set();
    const activeRecoveryKeys = new Set();
    const symbolCounts = new Map();
    for (const intent of unresolvedIntents) {
      const symbol = intent.request?.symbol;
      if (isCanonicalVstSymbol(symbol)) {
        symbolCounts.set(symbol, (symbolCounts.get(symbol) ?? 0) + 1);
      }
    }
    // Preserve the shared incident clock if an intent resolves directly
    // into a stuck position on the next tick; independent per-intent
    // timers below still report intents during unrelated healthy work.
    if (unresolvedIntents.length && blockedSince === null) blockedSince = now;
    for (const intent of unresolvedIntents) {
      const key = typeof intent.clientOrderId === "string" && intent.clientOrderId
        ? intent.clientOrderId
        : `${intent.sourceSignalId ?? "unknown"}:${intent.request?.operation ?? "unknown"}`;
      activeKeys.add(key);
      const recoveryKey = reconciliationIntentKey(intent);
      activeRecoveryKeys.add(recoveryKey);
      if (!unresolvedIntentSince.has(key)) unresolvedIntentSince.set(key, now);
      const blockedForMs = now - unresolvedIntentSince.get(key);
      const deferredReason = deferredRecoveryReasonByIntent.get(
        reconciliationIntentKey(intent),
      );
      const diagnostic = buildVstUnresolvedIntentDiagnostic(intent, {
        symbolUnresolvedCount: symbolCounts.get(intent.request?.symbol) ?? 0,
        accountUnresolvedCount: unresolvedIntents.length,
        recoveryDeferredReason: SAFE_RECOVERY_DEFERRED_REASONS.has(deferredReason)
          ? deferredReason : undefined,
        recoveryDeferredDiagnosticRef: deferredRecoveryDiagnosticRefByIntent.get(
          recoveryKey,
        ),
        lastAttemptAt: deferredRecoveryAttemptAtByIntent.get(recoveryKey),
        now,
      });
      const signature = unresolvedIntentDiagnosticSignature(diagnostic);
      const lastDiagnosticAt = lastUnresolvedDiagnosticAt.get(key);
      if (lastUnresolvedDiagnosticSignature.get(key) !== signature ||
          lastDiagnosticAt === undefined ||
          now - lastDiagnosticAt >= BLOCKED_ALERT_REPEAT_MS) {
        logVstUnresolvedIntentDiagnostic(diagnostic);
        lastUnresolvedDiagnosticAt.set(key, now);
        lastUnresolvedDiagnosticSignature.set(key, signature);
      }
      if (typeof onBlocked !== "function" ||
          blockedForMs < BLOCKED_ALERT_AFTER_MS) continue;
      const lastAlertAt = lastUnresolvedIntentAlertAt.get(key);
      const alertSignature = JSON.stringify([
        signature,
        deferredRecoveryDiagnosticRefByIntent.get(reconciliationIntentKey(intent)) ?? null,
      ]);
      if (lastUnresolvedIntentAlertSignature.get(key) === alertSignature &&
          lastAlertAt !== undefined &&
          now - lastAlertAt < BLOCKED_ALERT_REPEAT_MS) continue;
      lastUnresolvedIntentAlertAt.set(key, now);
      lastUnresolvedIntentAlertSignature.set(key, alertSignature);
      await sendBlockedAlert({
        reason: "unresolved_vst_order_intents",
        scope: isCanonicalVstSymbol(intent.request?.symbol) ? "symbol" : "account",
        blockedForMs,
        count: symbolCounts.get(intent.request?.symbol) ?? unresolvedIntents.length,
        symbolUnresolvedCount: symbolCounts.get(intent.request?.symbol) ?? 0,
        accountUnresolvedCount: unresolvedIntents.length,
        sourceSignalId: intent.sourceSignalId,
        symbol: intent.request?.symbol,
        operation: intent.request?.operation,
        // A rejection bit alone is not reviewed evidence that a request was
        // never written (notably when the original request was a GET).
        entryNotSubmitted: false,
        phase: intent.phase,
        state: intent.state,
        clientOrderId: intent.clientOrderId,
        exchangeOrderId: intent.exchangeOrderId,
        originalDiagnostic: diagnostic.originalDiagnostic,
        ...(diagnostic.lastAttemptAt
          ? {
              lastAttemptAt: diagnostic.lastAttemptAt,
              lastAttemptAgeMs: diagnostic.lastAttemptAgeMs,
            }
          : {}),
        ...(SAFE_RECOVERY_DEFERRED_REASONS.has(deferredReason)
          ? { recoveryDeferredReason: deferredReason } : {}),
        diagnosticRef: deferredRecoveryDiagnosticRefByIntent.get(
          recoveryKey,
        ),
      });
    }
    for (const key of unresolvedIntentSince.keys()) {
      if (!activeKeys.has(key)) {
        unresolvedIntentSince.delete(key);
        lastUnresolvedIntentAlertAt.delete(key);
        lastUnresolvedIntentAlertSignature.delete(key);
        lastUnresolvedDiagnosticAt.delete(key);
        lastUnresolvedDiagnosticSignature.delete(key);
      }
    }
    for (const key of deferredRecoveryReasonByIntent.keys()) {
      if (!activeRecoveryKeys.has(key)) {
        deferredRecoveryReasonByIntent.delete(key);
        deferredRecoveryDiagnosticRefByIntent.delete(key);
        deferredRecoveryAttemptAtByIntent.delete(key);
      }
    }
  }

  async function reconcileOneHistoricalErrorClose(accountState, capabilities, { activeOnly = false } = {}) {
    const listCandidates = activeOnly
      ? store.listFlatPositionCloseCandidates
      : store.listHistoricalCloseCandidates;
    if (typeof listCandidates !== "function" ||
        typeof store.reconcileHistoricalClose !== "function" ||
        typeof broker.readHistoricalErrorClose !== "function" ||
        broker.supportsHistoricalCloseProof === false ||
        historicalProofAttemptedThisTick ||
        exchangeActionAttemptedThisTick ||
        !validObject(accountState) || accountState.verified !== true ||
        accountState.environment !== "vst" ||
        typeof accountState.accountId !== "string" ||
        accountState.accountId.trim() === "" ||
        capabilities?.accountId !== undefined &&
          accountState.accountId !== capabilities.accountId ||
        !Array.isArray(accountState.positions) ||
        !Array.isArray(accountState.openOrders)) {
      return null;
    }

    let candidates;
    try {
      candidates = await listCandidates.call(store, 1, {
        after: historicalCloseCursor,
      });
    } catch {
      historicalCloseCursor = null;
      return null;
    }
    if (!Array.isArray(candidates) || candidates.length > 1) {
      historicalCloseCursor = null;
      return null;
    }
    const candidate = candidates[0];
    if (!candidate) {
      // Keyset wrap: an empty page means every eligible row was considered
      // since the last wrap. Reset for the next tick, never scan a second page
      // or perform a second historical proof in this cycle.
      historicalCloseCursor = null;
      return null;
    }
    if (activeOnly && !["open", "unknown"].includes(candidate.status)) return null;

    if (typeof candidate.positionVersion === "string" &&
        Number.isFinite(Date.parse(candidate.positionVersion)) &&
        typeof candidate.sourceSignalId === "string" &&
        candidate.sourceSignalId.trim() !== "") {
      historicalCloseCursor = {
        positionVersion: candidate.positionVersion,
        sourceSignalId: candidate.sourceSignalId,
      };
    } else {
      historicalCloseCursor = null;
    }
    if (candidate.snapshot?.environment !== "vst" ||
        candidate.snapshot.accountId !== accountState.accountId ||
        candidate.symbol !== candidate.snapshot.symbol) {
      return null;
    }
    // Most confirmed entries are genuinely still open. Do not search their
    // whole history or consume the recovery budget while current exposure or
    // orders for this symbol are present. The adapter still performs its own
    // independent, fresh flat/no-orders proof before any ledger commit.
    if (candidate.status !== "error" &&
        [...accountState.positions, ...accountState.openOrders].some((row) =>
          normalizeSymbolKey(row?.symbol) === normalizeSymbolKey(candidate.symbol))) {
      return null;
    }

    const now = Number(clock());
    if (!Number.isSafeInteger(now) || now <= 0) return null;
    const attempt = historicalCloseAttempts.get(candidate.sourceSignalId);
    if (attempt && now < attempt.nextAttemptAt) return null;

    const defer = () => {
      const attempts = (attempt?.attempts ?? 0) + 1;
      const delay = Math.min(
        candidate.status === "error" ? HISTORICAL_CLOSE_RETRY_MAX_MS : 120_000,
        (candidate.status === "error" ? HISTORICAL_CLOSE_RETRY_BASE_MS : 30_000) *
          (2 ** Math.min(attempts - 1, 8)),
      );
      historicalCloseAttempts.set(candidate.sourceSignalId, {
        attempts,
        nextAttemptAt: now + delay,
      });
      // Candidate history is expected to remain small, but bound per-worker
      // retry bookkeeping if a damaged/legacy database contains many rows.
      if (historicalCloseAttempts.size > 256) {
        const oldest = historicalCloseAttempts.keys().next().value;
        historicalCloseAttempts.delete(oldest);
      }
    };

    try {
      historicalProofAttemptedThisTick = true;
      const proof = await broker.readHistoricalErrorClose(candidate);
      if (proof?.verified !== true) {
        const proofEvidence = safeVstProofEvidence("historical_close_proof", () => ({
          positionValid: {
            expected: true, actual: proof?.flatCheck?.verified === true,
            matches: proof?.flatCheck?.verified === true,
          },
          stopFactsValid: {
            expected: true, actual: proof?.verified === true,
            matches: proof?.verified === true,
          },
          positionVerified: {
            expected: true, actual: proof?.flatCheck?.verified,
            matches: proof?.flatCheck?.verified === true,
          },
          accountMatches: {
            expected: true, actual: proof?.accountId === candidate.snapshot.accountId,
            matches: proof?.accountId === candidate.snapshot.accountId,
          },
          environmentMatches: {
            expected: true, actual: proof?.environment === "vst",
            matches: proof?.environment === "vst",
          },
          symbol: {
            expected: candidate.symbol, actual: proof?.symbol,
            matches: proof?.symbol === candidate.symbol,
          },
          positionId: {
            expected: proof?.entryFill?.positionId,
            actual: proof?.flatCheck?.positionId,
            matches: proof?.entryFill?.positionId === proof?.flatCheck?.positionId,
          },
          positionQuantity: {
            expected: 0, actual: proof?.flatCheck?.positionQuantity,
            matches: Number(proof?.flatCheck?.positionQuantity) === 0,
          },
          openOrderCount: {
            expected: 0, actual: proof?.flatCheck?.openOrderCount,
            matches: Number(proof?.flatCheck?.openOrderCount) === 0,
          },
        }));
        recordVstRefusal("position_proof_unverified", {
          stage: "reconciliation", operation: "reconcile",
          check: "flatness", symbol: candidate.symbol,
          sourceSignalId: candidate.sourceSignalId,
          ...(proofEvidence ? { proofEvidence } : {}),
        });
        defer();
        return null;
      }
      const reconciliation = await store.reconcileHistoricalClose(candidate, proof);
      if (reconciliation?.kind === "reconciled" ||
          reconciliation?.kind === "already_reconciled") {
        historicalCloseAttempts.delete(candidate.sourceSignalId);
        return {
          kind: "acted",
          reason: "historical_close_ledger_reconciled",
          operation: "historical_close_ledger_reconciled",
          sourceSignalId: candidate.sourceSignalId,
          symbol: candidate.symbol,
        };
      }
      if (reconciliation?.kind !== "not_found") defer();
    } catch (error) {
      // Historical repair is opportunistic and strictly read-only at the
      // exchange boundary. A timeout, stale proof, or database CAS failure
      // must never hold up unrelated positions, queued entries, or idle work.
      const proofEvidence = safeVstProofEvidence("historical_close_proof", () => ({
        positionValid: { expected: true, actual: false, matches: false },
        stopFactsValid: { expected: true, actual: false, matches: false },
        positionVerified: { expected: true, actual: false, matches: false },
      }));
      recordVstDiagnostic(error, {
        stage: "reconciliation", operation: "reconcile",
        check: "flatness", symbol: candidate.symbol,
        sourceSignalId: candidate.sourceSignalId,
        ...(proofEvidence ? { proofEvidence } : {}),
      });
      defer();
    }
    return null;
  }

  function sourceExitPhase(requestId) {
    const key = createHash("sha256").update(String(requestId)).digest("hex").slice(0, 24);
    return `source-exit-${key}`;
  }

  function sourceExitCleanupPhase(requestId, stopId) {
    const key = createHash("sha256")
      .update(`${requestId}:${stopId}`).digest("hex").slice(0, 24);
    return `source-exit-cleanup-${key}`;
  }

  function sourceExitRequestValid(row) {
    const evidence = row?.evidence;
    if (row?.reason === FULL_TAKE_REASON) return fullTakeEvidenceValid(
      evidence, row.sourceSignalId, row.symbol, row.requestId);
    if (row?.reason === "source_command_close") {
      try {
        const command = validateSourceCommand(evidence?.command, Number(clock()));
        return command.type === "close" &&
          row.requestId === `direct-command-${command.commandId}` &&
          command.sourceSignalId === row.sourceSignalId && command.symbol === row.symbol &&
          evidence.reason === row.reason && evidence.sourceAction === "close" &&
          Number.isFinite(Date.parse(row.observedAt));
      } catch { return false; }
    }
    const sourceClosedStatuses = new Set([
      "profit", "stop_loss", "bu_stop", "breakeven", "expired",
    ]);
    const evidenceAsOf = Date.parse(evidence?.asOf);
    const evidenceObservedAt = Date.parse(evidence?.observedAt);
    const evidenceDecisionAt = Date.parse(evidence?.exitDecisionAt);
    const updatedAt = evidence?.sourceUpdatedAt === null
      ? null : Date.parse(evidence?.sourceUpdatedAt);
    const closedAt = evidence?.sourceClosedAt === null
      ? null : Date.parse(evidence?.sourceClosedAt);
    const positiveSourceExitPrice =
      (typeof evidence?.sourceExitPrice === "string" &&
        /^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(
          evidence.sourceExitPrice,
        ) ||
        typeof evidence?.sourceExitPrice === "number") &&
      Number.isFinite(Number(evidence.sourceExitPrice)) &&
      Number(evidence.sourceExitPrice) > 0;
    const sourceWithdrawalEvidence = evidence?.reason === "source_withdrawal" &&
      (evidence.sourceStatus === "reclassified" || isSourceCancellation(evidence)) &&
      typeof evidence.sourceUpdatedAt === "string" &&
      Number.isFinite(updatedAt) &&
      evidence.exitDecisionAt === evidence.sourceUpdatedAt &&
      (evidence.sourceExitPrice === null || positiveSourceExitPrice);
    const sourceClosedEvidence = evidence?.reason === "source_closed" &&
      sourceClosedStatuses.has(evidence.sourceStatus) &&
      typeof evidence.sourceClosedAt === "string" &&
      Number.isFinite(closedAt) &&
      (positiveSourceExitPrice || evidence.sourceAction === "close" && evidence.sourceExitPrice === null) &&
      evidence.exitDecisionAt === evidence.sourceClosedAt &&
      (evidence.sourceUpdatedAt === null ||
        typeof evidence.sourceUpdatedAt === "string" &&
          Number.isFinite(updatedAt));
    return validObject(row) &&
      typeof row.requestId === "string" && row.requestId.trim() !== "" &&
      typeof row.sourceSignalId === "string" && row.sourceSignalId.trim() !== "" &&
      isCanonicalVstSymbol(row.symbol) &&
      ["source_withdrawal", "source_closed"].includes(row.reason) &&
      typeof row.asOf === "string" && Number.isFinite(Date.parse(row.asOf)) &&
      typeof row.observedAt === "string" && Number.isFinite(Date.parse(row.observedAt)) &&
      validObject(evidence) &&
      evidence.sourceSignalId === row.sourceSignalId &&
      evidence.symbol === row.symbol &&
      evidence.reason === row.reason &&
      typeof evidence.asOf === "string" &&
      Number.isFinite(Date.parse(evidence.asOf)) &&
      typeof evidence.observedAt === "string" &&
      Number.isFinite(Date.parse(evidence.observedAt)) &&
      ["source_withdrawal", "source_closed"].includes(evidence.reason) &&
      typeof evidence.sourceStatus === "string" &&
      (evidence.sourceUpdatedAt === null ||
        typeof evidence.sourceUpdatedAt === "string" &&
          Number.isFinite(Date.parse(evidence.sourceUpdatedAt))) &&
      (evidence.sourceClosedAt === null ||
        typeof evidence.sourceClosedAt === "string" &&
          Number.isFinite(Date.parse(evidence.sourceClosedAt))) &&
      (evidence.sourceExitPrice === null ||
        typeof evidence.sourceExitPrice === "string" &&
          evidence.sourceExitPrice.trim() !== "" ||
        typeof evidence.sourceExitPrice === "number" &&
          Number.isFinite(evidence.sourceExitPrice)) &&
      (evidence.sourceCancelReason === null ||
        typeof evidence.sourceCancelReason === "string") &&
      typeof evidence.exitDecisionAt === "string" &&
      Number.isFinite(evidenceDecisionAt) &&
      evidenceObservedAt >= evidenceAsOf - 30_000 &&
      evidenceObservedAt - evidenceAsOf <= 60_000 &&
      evidenceDecisionAt <= evidenceAsOf + 30_000 &&
      evidenceDecisionAt <= evidenceObservedAt + 30_000 &&
      (sourceWithdrawalEvidence || sourceClosedEvidence);
  }

  function sourceExitIntentOutcome(intent) {
    if (validObject(intent?.outcome)) return intent.outcome;
    if (validObject(intent?.detail?.outcome)) return intent.detail.outcome;
    return null;
  }

  function sameSourceExitEvidence(left, right) {
    try {
      return validObject(left) && validObject(right) &&
        JSON.stringify(left) === JSON.stringify(right);
    } catch {
      return false;
    }
  }

  function sourceExitClosedSnapshotVerified(
    positionRecord, requestRow, closeIntent, cleanupIntents = [],
  ) {
    const snapshot = positionRecord?.snapshot;
    const closeOutcome = sourceExitIntentOutcome(closeIntent);
    const closeRequest = closeIntent?.request;
    const sourceExit = closeRequest?.sourceExit;
    const closeFill = closeOutcome?.fill;
    if (!validObject(requestRow) ||
        positionRecord?.status !== "closed" || !validObject(snapshot) ||
        snapshot.status !== "closed" ||
        snapshot.sourceExitRequestId !== requestRow.requestId ||
        !sameSourceExitEvidence(snapshot.sourceExitEvidence, requestRow.evidence) ||
        closeIntent?.state !== "reconciled" ||
        closeRequest?.operation !== "close_leg" ||
        sourceExit?.requestId !== requestRow.requestId ||
        sourceExit?.stage !== "close" ||
        !sameSourceExitEvidence(sourceExit.evidence, requestRow.evidence) ||
        closeOutcome?.operation !== "source_exit" ||
        closeOutcome?.status !== "filled" || closeOutcome?.verified !== true ||
        closeOutcome.sourceExitRequestId !== requestRow.requestId ||
        !sameSourceExitEvidence(closeOutcome.sourceEvidence, requestRow.evidence) ||
        closeOutcome.flat !== true ||
        closeOutcome.cleanupStage !== "complete" && closeOutcome.sourceExitComplete === true ||
        !Array.isArray(closeOutcome.remainingKnownStopOrderIds) ||
        !validObject(closeFill) ||
        !sameSourceExitEvidence(snapshot.closeFill, closeFill) ||
        !sameSourceExitEvidence(snapshot.lastCloseFill, closeFill)) {
      return false;
    }
    if (closeOutcome.sourceExitComplete === true) {
      return closeOutcome.cleanupStage === "complete" &&
        closeOutcome.remainingKnownStopOrderIds.length === 0 &&
        snapshot.sourceExitCleanup === null &&
        (!snapshot.split || snapshot.split.stage === "closed" &&
          Array.isArray(snapshot.split.remainingKnownStopOrderIds) &&
          snapshot.split.remainingKnownStopOrderIds.length === 0);
    }
    return cleanupIntents.some((intent) => {
      const outcome = sourceExitIntentOutcome(intent);
      return intent?.state === "reconciled" &&
        intent.request?.operation === "cancel_flat_split_stop" &&
        intent.request?.sourceExit?.requestId === requestRow.requestId &&
        sameSourceExitEvidence(intent.request.sourceExit.evidence, requestRow.evidence) &&
        outcome?.operation === "cancel_flat_split_stop" &&
        outcome.status === "canceled" && outcome.verified === true &&
        outcome.sourceExitRequestId === requestRow.requestId &&
        sameSourceExitEvidence(outcome.sourceEvidence, requestRow.evidence) &&
        outcome.sourceExitComplete === true &&
        outcome.cleanupStage === "complete" &&
        Array.isArray(outcome.remainingKnownStopOrderIds) &&
        outcome.remainingKnownStopOrderIds.length === 0 &&
        snapshot.sourceExitCleanup === null &&
        snapshot.split?.stage === "closed" &&
        Array.isArray(snapshot.split.remainingKnownStopOrderIds) &&
        snapshot.split.remainingKnownStopOrderIds.length === 0;
    });
  }

  async function finishSourceExit(requestId, { outcome, detail }) {
    if (directCloseCompletion?.requestId === requestId) {
      directCloseCompletion.completed = { outcome, detail };
      return true;
    }
    try {
      await store.finishSourceExitRequest(requestId, { outcome, detail });
      return true;
    } catch {
      // Ledger closure and queue retirement are intentionally separate durable
      // steps. A failed retirement leaves the queue row available for the next
      // tick to verify and finish again.
      return false;
    }
  }

  function addSourceExitStop(stops, candidate) {
    if (!validObject(candidate)) return;
    const id = typeof candidate.orderId === "string" && candidate.orderId.trim() !== ""
      ? candidate.orderId : null;
    if (!id) return;
    const stop = {
      orderId: id,
      positionId: candidate.positionId,
      quantity: String(candidate.quantity),
      stopPrice: String(candidate.stopPrice),
      ...(candidate.tranche ? { tranche: candidate.tranche } : {}),
    };
    const previous = stops.find((item) => item.orderId === id);
    if (previous) {
      if (previous.positionId !== stop.positionId ||
          Number(previous.quantity) !== Number(stop.quantity) ||
          Number(previous.stopPrice) !== Number(stop.stopPrice)) {
        throw new Error("source_exit_owned_stop_provenance_conflict");
      }
      return;
    }
    stops.push(stop);
  }

  function sourceExitKnownStops(state, positionId) {
    const stops = [];
    const persisted = state?.persistedPosition;
    const split = state?.split;
    for (const leg of ["core", "runner"]) {
      addSourceExitStop(stops, split?.[`${leg}Stop`]
        ? {
            ...split[`${leg}Stop`],
            positionId: split[`${leg}Stop`].positionId ?? split.positionId,
            tranche: leg,
          }
        : null);
      addSourceExitStop(stops, state?.verifiedProtectiveStops?.[leg]
        ? { ...state.verifiedProtectiveStops[leg], tranche: leg }
        : null);
      addSourceExitStop(stops, persisted?.protectiveStops?.[leg]
        ? { ...persisted.protectiveStops[leg], tranche: leg }
        : null);
    }
    const mayOwnOriginalStop = !validObject(split) ||
      ["core_pending", "runner_pending", "flat_cleanup_pending"].includes(split.stage);
    addSourceExitStop(stops, mayOwnOriginalStop && persisted?.originalStop
      ? { ...persisted.originalStop, tranche: "original" }
      : null);
    const originalStopId = mayOwnOriginalStop
      ? split?.originalStopOrderId ?? state?.originalStopOrderId : null;
    const originalStopPositionId = split?.positionId ??
      state?.originalStopPositionId;
    if (typeof originalStopId === "string" &&
        Number(state?.originalStopQuantity ?? split?.totalQuantity) > 0 &&
        Number(state?.signalStopPrice ?? split?.signalStopPrice) > 0) {
      addSourceExitStop(stops, {
        orderId: originalStopId,
        positionId: originalStopPositionId ?? split?.positionId,
        quantity: state?.originalStopQuantity ?? split?.totalQuantity,
        stopPrice: state?.signalStopPrice ?? split?.signalStopPrice,
        tranche: "original",
      });
    }
    return stops;
  }

  function exactOwnedSourceExitStops(state, accountState, stops) {
    const orders = symbolOrders(accountState, state.symbol);
    if (!Array.isArray(orders) || !Array.isArray(stops) ||
        orders.length !== stops.length || !exactOrderIds(orders)) return false;
    const expectedIds = stops.map((stop) => stop.orderId).sort();
    const actualIds = exactOrderIds(orders).sort();
    if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) return false;
    const exchangeSymbol = normalizeSymbolKey(state.symbol);
    for (const stop of stops) {
      const matches = orders.filter((order) =>
        String(order.orderId ?? order.orderID) === stop.orderId);
      if (matches.length !== 1) return false;
      const order = matches[0];
      const positionId = exactExchangeIdentifier(
        order.positionId ?? order.positionID,
      );
      const quantity = order.origQty ?? order.quantity;
      const expectedEntry = state.entryOrderId ?? state.split?.entryOrderId;
      const parents = [order.mainOrderId, order.parentOrderId]
        .filter((value) => value !== undefined && value !== null && value !== "")
        .map(exactExchangeIdentifier);
      if (normalizeSymbolKey(order.symbol) !== exchangeSymbol ||
          order.type !== "STOP_MARKET" || order.status !== "NEW" ||
          order.side !== "SELL" || order.positionSide !== "LONG" ||
          order.workingType !== "MARK_PRICE" ||
          positionId !== stop.positionId ||
          !closePolicyNumber(quantity, stop.quantity) ||
          !closePolicyNumber(order.stopPrice, stop.stopPrice) ||
          parents.some((parent) => parent === null) ||
          new Set(parents).size > 1 ||
          expectedEntry && parents.some((parent) => parent !== expectedEntry)) {
        return false;
      }
    }
    return true;
  }

  async function commitSourceExitClose(intent, request, evidence) {
    const sourceExit = request.sourceExit;
    const prior = request.priorPosition;
    const quantity = request.quantity;
    const positionId = request.positionId;
    if (sourceExit?.stage !== "close" ||
        sourceExit.requestId !== request.sourceExitRequestId ||
        !sourceExitRequestValid({
          requestId: sourceExit.requestId,
          sourceSignalId: intent.sourceSignalId,
          symbol: request.symbol,
          reason: sourceExit.evidence?.reason,
          asOf: sourceExit.evidence?.asOf,
          observedAt: sourceExit.evidence?.observedAt,
          evidence: sourceExit.evidence,
        }) ||
        !validObject(prior) || prior.sourceSignalId !== intent.sourceSignalId ||
        prior.symbol !== request.symbol ||
        prior.environment !== "vst" ||
        prior.accountId !== request.accountId ||
        request.environment !== "vst" ||
        request.operation !== "close_leg" ||
        !Number.isFinite(Number(quantity)) || Number(quantity) <= 0 ||
        !Number.isFinite(Number(request.previousQuantity)) ||
        Number(quantity) !== Number(request.previousQuantity) ||
        typeof positionId !== "string" || positionId.trim() === "" ||
        evidence?.verified !== true || evidence.status !== "filled" ||
        evidence.position?.positionId != null &&
          evidence.position.positionId !== positionId ||
        Number(evidence.position?.quantity) !== 0) {
      throw new Error("source_exit_close_intent_identity_or_fill_invalid");
    }
    checkActionEvidence(request, evidence, PROFILE);
    const fill = closeFillSnapshot(evidence);
    const accountState = await broker.readAccountState();
    if (!validObject(accountState) || accountState.verified !== true ||
        accountState.environment !== "vst" ||
        accountState.accountId !== request.accountId ||
        !Array.isArray(accountState.positions) ||
        !Array.isArray(accountState.openOrders) ||
        !flatPositionFromAccountState(accountState, request.symbol)) {
      throw new Error("source_exit_flat_account_state_not_verified");
    }
    const remainingStops = symbolOrders(accountState, request.symbol);
    const allKnownStops = request.ownedStops;
    if (!Array.isArray(remainingStops) ||
        !Array.isArray(allKnownStops) ||
        !exactOrderIds(remainingStops) ||
        remainingStops.some((order) =>
          !allKnownStops.some((stop) =>
            stop.orderId === String(order.orderId ?? order.orderID))) ||
        !exactOwnedSourceExitStops(prior, accountState,
          remainingStops.map((order) =>
            allKnownStops.find((stop) =>
              stop.orderId === String(order.orderId ?? order.orderID))))) {
      throw new Error("source_exit_remaining_stops_not_exactly_owned");
    }
    const remainingIds = exactOrderIds(remainingStops);
    const cleanupStops = allKnownStops.filter((stop) =>
      remainingIds.includes(stop.orderId));
    const cleanupPending = remainingIds.length > 0;
    const split = cleanupPending ? {
      ...(validObject(prior.split) ? prior.split : {}),
      stage: "flat_cleanup_pending",
      positionId,
      entryOrderId: prior.entryOrderId ?? prior.split?.entryOrderId,
      remainingKnownStopOrderIds: [...remainingIds],
      flatCleanupStops: cleanupStops,
      activeLegs: [],
      baselineOpenOrderIds: [...remainingIds],
    } : prior.patternId === "impulse_buy" ? {
      ...(validObject(prior.split) ? prior.split : {}),
      stage: "closed",
      positionId,
      coreOpen: false,
      runnerOpen: false,
      coreStop: null,
      runnerStop: null,
      activeLegs: [],
      remainingKnownStopOrderIds: [],
      flatCleanupStops: [],
      baselineOpenOrderIds: [],
    } : prior.split;
    const closedPosition = {
      ...prior,
      ...(split ? { split } : {}),
      status: cleanupPending ? "closing" : "closed",
      executionStatus: cleanupPending ? "source_exit_stop_cleanup_pending" : "closed",
      closedAt: fill.at,
      closeReason: sourceExit.evidence.reason,
      closeFill: fill,
      lastCloseFill: fill,
      sourceExitRequestId: sourceExit.requestId,
      sourceExitEvidence: sourceExit.evidence,
      sourceExitCleanup: cleanupPending ? {
        requestId: sourceExit.requestId,
        positionId,
        remainingKnownStopOrderIds: [...remainingIds],
        flatCleanupStops: cleanupStops,
      } : null,
      ...(prior.patternId === "impulse_buy" ? {
        coreOpen: false,
        runnerOpen: false,
        coreQty: 0,
        runnerQty: 0,
        remainingQty: 0,
        coreQuantity: 0,
        runnerQuantity: 0,
        remainingQuantity: 0,
      } : {}),
      ...(cleanupPending ? {} : {
        coreStopOrderId: null,
        coreStopPositionId: null,
        coreStopQuantity: 0,
        runnerStopOrderId: null,
        runnerStopPositionId: null,
        runnerStopQuantity: 0,
        verifiedProtectiveStops: {},
        persistedPosition: null,
        baselineOpenOrderIds: [],
      }),
    };
    await store.commitVerifiedIntent({
      sourceSignalId: intent.sourceSignalId,
      clientOrderId: intent.clientOrderId,
      position: closedPosition,
      signalStatus: cleanupPending ? "open" : "closed",
      exchangeOrderId: evidence.exchangeOrderId,
      outcome: {
        status: "filled",
        verified: true,
        operation: "source_exit",
        sourceExitRequestId: sourceExit.requestId,
        sourceEvidence: sourceExit.evidence,
        quantity: String(quantity),
        fill,
        flat: true,
        cleanupStage: cleanupPending ? "pending_flat_cleanup" : "complete",
        remainingKnownStopOrderIds: [...remainingIds],
        sourceExitComplete: !cleanupPending,
      },
      eventKind: cleanupPending
        ? "vst_source_exit_flat_cleanup_pending" : "vst_source_exit_closed",
      eventDetail: {
        sourceExitRequestId: sourceExit.requestId,
        sourceEvidence: sourceExit.evidence,
        quantity: String(quantity),
        remainingKnownStopOrderIds: [...remainingIds],
        fill,
      },
    });
    if (!cleanupPending) {
      await finishSourceExit(sourceExit.requestId, {
        outcome: "closed",
        detail: { sourceEvidence: sourceExit.evidence, fill, flat: true, noOpenStops: true },
      });
    }
  }

  async function reconcilePendingSourceIntent(intent, capabilities) {
    if (!intent) return null;
    if (["submitted", "unknown"].includes(intent.state)) {
      const result = await reconcileOne(intent, capabilities, false);
      return result.kind === "reconciled" && result.sourceExit
        ? { kind: "acted", operation: "source_exit_reconciled" }
        : { kind: result.kind === "unknown" ? "unknown" : "waiting",
            reason: result.reason ?? "source_exit_reconciliation_pending" };
    }
    if (intent.state === "reconciled") return null;
    if (intent.state === "failed") {
      const reason = "source_exit_prior_mutation_failed_no_replay";
      await store.setSignalStatus(intent.sourceSignalId, "unknown", reason);
      return { kind: "blocked", reason, sourceSignalId: intent.sourceSignalId,
        symbol: intent.request?.symbol };
    }
    return null;
  }

  async function sourceExitEntryIdentityState(record, capabilities) {
    const state = record?.snapshot;
    if (!validObject(state)) return null;
    const declaredEntryOrderIds = [state.entryOrderId, state.split?.entryOrderId]
      .filter((value) => value !== undefined && value !== null);
    const entryClientOrderId = state.entryClientOrderId;
    if (typeof entryClientOrderId !== "string" ||
        entryClientOrderId.trim() === "" ||
        typeof store.getIntent !== "function") {
      return null;
    }
    let entryIntent;
    try {
      entryIntent = await store.getIntent(record.sourceSignalId, "market-entry");
    } catch {
      return null;
    }
    const request = entryIntent?.request;
    const signal = request?.signal;
    const outcome = entryIntent?.outcome;
    const exchangeOrderId = exactExchangeIdentifier(entryIntent?.exchangeOrderId);
    const snapshotFill = state.verifiedFill;
    const positionId = exactExchangeIdentifier(state.exchangePositionId);
    const exactDecimalsMatch = (left, right) => {
      try {
        return compareExactDecimals(left, right) === 0;
      } catch {
        return false;
      }
    };
    const exactDecimalIsPositive = (value) => {
      try {
        return compareExactDecimals(value, "0") === 1;
      } catch {
        return false;
      }
    };
    const declaredEntryOrderTypes = [
      request?.entryOrderType,
      state.entryOrderType,
      state.split?.entryOrderType,
      state.persistedPosition?.entryOrderType,
    ].filter((value) => value !== undefined && value !== null);
    const entryOrderType = declaredEntryOrderTypes[0];
    const modernEntryOutcome = outcome?.operation === "entry" &&
      exactExchangeIdentifier(outcome.entryOrderId) === exchangeOrderId &&
      exactDecimalIsPositive(outcome.totalQuantity);
    const quantity = modernEntryOutcome
      ? outcome.totalQuantity
      : outcome?.fillQuantity ?? snapshotFill?.quantity ?? state.quantity ??
        state.split?.totalQuantity ?? request?.sizing?.quantity;
    const entryPrice = snapshotFill?.price ?? outcome?.fillPrice ??
      state.entryPrice;
    const modernSplitOutcome = outcome?.operation === "entry" &&
      exactExchangeIdentifier(outcome.entryOrderId) === exchangeOrderId &&
      exactDecimalIsPositive(outcome.totalQuantity) &&
      exactDecimalIsPositive(outcome.coreQuantity) &&
      exactDecimalIsPositive(outcome.runnerQuantity) &&
      typeof outcome.splitStage === "string" &&
      exactDecimalIsPositive(snapshotFill?.price ?? state.entryPrice);
    const hasDurableFillOutcome =
      outcome?.fillPrice !== undefined && outcome?.fillPrice !== null &&
      outcome?.fillQuantity !== undefined && outcome?.fillQuantity !== null;
    if (entryIntent?.sourceSignalId !== record.sourceSignalId ||
        entryIntent?.phase !== "market-entry" ||
        entryIntent?.state !== "reconciled" ||
        entryIntent?.clientOrderId !== entryClientOrderId ||
        declaredEntryOrderIds.some((id) => id !== exchangeOrderId) ||
        declaredEntryOrderTypes.some((type) => type !== entryOrderType) ||
        entryOrderType !== undefined &&
          !["MARKET", "LIMIT"].includes(entryOrderType) ||
        request?.operation !== "entry" ||
        request.environment !== "vst" ||
        request.accountId !== state.accountId ||
        request.accountId !== capabilities?.accountId ||
        request.symbol !== state.symbol ||
        signal?.sourceSignalId !== record.sourceSignalId ||
        signal?.symbol !== state.symbol ||
        signal?.orderType !== "market" ||
        request.sizing?.environment !== "vst" ||
        outcome?.status !== "filled" ||
        outcome?.verified !== true ||
        !hasDurableFillOutcome && !modernSplitOutcome ||
        outcome.entryOrderId !== undefined &&
          exactExchangeIdentifier(outcome.entryOrderId) !== exchangeOrderId ||
        exchangeOrderId === null ||
        positionId === null ||
        exactExchangeIdentifier(outcome.positionId) !== positionId ||
        !exactDecimalIsPositive(quantity) ||
        state.quantity !== undefined &&
          !exactDecimalsMatch(state.quantity, quantity) ||
        !exactDecimalIsPositive(entryPrice) ||
        state.entryPrice !== undefined &&
          !exactDecimalsMatch(state.entryPrice, entryPrice) ||
        outcome.fillQuantity !== undefined &&
          !exactDecimalsMatch(outcome.fillQuantity, quantity) ||
        outcome.totalQuantity !== undefined &&
          !exactDecimalsMatch(outcome.totalQuantity, quantity) ||
        !exactDecimalsMatch(request.sizing?.quantity, quantity) ||
        request.quantity !== undefined &&
          !exactDecimalsMatch(request.quantity, quantity) ||
        outcome.fillPrice !== undefined &&
          !exactDecimalsMatch(outcome.fillPrice, entryPrice) ||
        validObject(snapshotFill) &&
          (!exactDecimalsMatch(snapshotFill.quantity, quantity) ||
           !exactDecimalsMatch(snapshotFill.price, entryPrice))) {
      return null;
    }
    if (typeof broker.verifySourceExitEntryProof !== "function") {
      throw new Error("source_exit_native_entry_proof_unavailable");
    }
    let nativeProof;
    try {
      nativeProof = await withVstDiagnosticContext({
        stage: "entry_proof", operation: "entry",
        check: "entry_history", symbol: request.symbol,
        sourceSignalId: request.sourceSignalId,
      }, () => broker.verifySourceExitEntryProof({
        clientOrderId: entryIntent.clientOrderId,
        request,
        expectedPositionId: positionId,
        expectedOrderId: exchangeOrderId,
        expectedQuantity: quantity,
        expectedEntryAt: state.entryAt ?? state.verifiedFill?.at,
        ...(entryOrderType !== undefined ? { entryOrderType } : {}),
      }));
    } catch (error) {
      recordVstDiagnostic(error, {
        stage: "entry_proof", operation: "entry", check: "entry_history",
        symbol: request.symbol, sourceSignalId: request.sourceSignalId,
      });
      throw new Error("source_exit_native_entry_proof_unavailable");
    }
    if (!validObject(nativeProof) || nativeProof.verified !== true ||
        nativeProof.status !== "filled" ||
        exactExchangeIdentifier(nativeProof.exchangeOrderId) !== exchangeOrderId ||
        exactExchangeIdentifier(nativeProof.positionId) !== positionId ||
        !["MARKET", "LIMIT"].includes(nativeProof.entryOrderType) ||
        entryOrderType !== undefined &&
          nativeProof.entryOrderType !== entryOrderType) {
      if (!getVstResultDiagnosticRef(nativeProof) &&
          !/^[a-f0-9]{12}$/.test(nativeProof?.diagnosticRef ?? "")) {
        recordVstRefusal("entry_proof_unverified", {
          stage: "entry_proof", operation: "entry", check: "entry_history",
          symbol: request.symbol, sourceSignalId: request.sourceSignalId,
        });
      }
      throw new Error("source_exit_native_entry_proof_unavailable");
    }
    if (!exactDecimalsMatch(nativeProof.fill?.quantity, quantity) ||
        !exactDecimalsMatch(nativeProof.fill?.price, entryPrice) ||
        typeof nativeProof.fill?.at !== "string" ||
        !Number.isFinite(Date.parse(nativeProof.fill.at)) ||
        validObject(state.verifiedFill) &&
          (!exactDecimalsMatch(state.verifiedFill.quantity, quantity) ||
           !exactDecimalsMatch(state.verifiedFill.price, entryPrice))) {
      throw new Error("source_exit_native_entry_proof_mismatch");
    }
    const nativeFillAt = Date.parse(nativeProof.fill.at);
    const recordedEntryTimes = [state.entryAt, state.verifiedFill?.at]
      .filter((value) => value !== undefined && value !== null);
    const entryTimestampMillis = (value) => {
      if (typeof value === "string") return Date.parse(value);
      if (!Number.isSafeInteger(value)) return Number.NaN;
      return value < 100_000_000_000 ? value * 1000 : value;
    };
    if (recordedEntryTimes.some((value) =>
      !Number.isSafeInteger(entryTimestampMillis(value)) ||
      entryTimestampMillis(value) !== nativeFillAt)) {
      throw new Error("source_exit_native_entry_proof_mismatch");
    }
    const verifiedFill = Object.freeze({
      price: nativeProof.fill.price,
      quantity: nativeProof.fill.quantity,
      at: state.verifiedFill?.at ?? state.entryAt ?? nativeProof.fill.at,
    });
    return Object.freeze({
      ...state,
      entryOrderId: exchangeOrderId,
      entryOrderType: nativeProof.entryOrderType,
      entryAt: state.entryAt ?? nativeProof.fill.at,
      verifiedFill,
    });
  }

  async function sourceExitPositionPreflight(record, capabilities) {
    const ledgerState = record?.snapshot;
    if (!validObject(ledgerState) ||
        ledgerState.sourceSignalId !== record.sourceSignalId ||
        ledgerState.symbol !== record.symbol || ledgerState.status === "closed" ||
        ledgerState.environment !== "vst" ||
        typeof ledgerState.accountId !== "string" ||
        ledgerState.accountId !== capabilities?.accountId ||
        !isCanonicalVstSymbol(ledgerState.symbol) ||
        typeof ledgerState.exchangePositionId !== "string" ||
        ledgerState.exchangePositionId.trim() === "") {
      throw new Error("source_exit_position_ledger_identity_mismatch");
    }
    const state = await sourceExitEntryIdentityState(record, capabilities);
    if (!validObject(state)) {
      throw new Error("source_exit_entry_identity_unavailable");
    }
    const accountState = await broker.readAccountState();
    if (!validObject(accountState) || accountState.verified !== true ||
        accountState.environment !== "vst" ||
        accountState.accountId !== state.accountId ||
        !Array.isArray(accountState.positions) ||
        !Array.isArray(accountState.openOrders)) {
      throw new Error("source_exit_account_snapshot_not_verified");
    }
    const activeRows = accountState.positions.filter((row) =>
      normalizeSymbolKey(row?.symbol) === normalizeSymbolKey(state.symbol) &&
      Number(row?.positionAmt ?? row?.quantity) !== 0);
    if (activeRows.length !== 1 ||
        exactExchangeIdentifier(activeRows[0].positionId ?? activeRows[0].positionID) !==
          state.exchangePositionId ||
        activeRows[0].positionSide !== "LONG") {
      throw new Error("source_exit_exchange_position_identity_mismatch");
    }
    const actualQuantity = String(activeRows[0].positionAmt ?? activeRows[0].quantity);
    if (!Number.isFinite(Number(actualQuantity)) || Number(actualQuantity) <= 0 ||
        activeRows[0].leverage !== undefined &&
          Number(activeRows[0].leverage) !== PROFILE_LEVERAGE ||
        activeRows[0].marginMode !== undefined &&
          !profileMarginIs(activeRows[0].marginMode)) {
      throw new Error("source_exit_exchange_position_read_not_verified");
    }
    const ownedStops = sourceExitKnownStops(state, state.exchangePositionId);
    if (!ownedStops.length) {
      throw new Error("source_exit_no_known_protective_stops");
    }
    if (ownedStops.some((stop) =>
      stop.positionId !== state.exchangePositionId ||
      !Number.isFinite(Number(stop.quantity)) || Number(stop.quantity) <= 0 ||
      !Number.isFinite(Number(stop.stopPrice)) || Number(stop.stopPrice) <= 0)) {
      throw new Error("source_exit_known_protective_stop_record_invalid");
    }
    if (!exactOwnedSourceExitStops(state, accountState, ownedStops)) {
      throw new Error("source_exit_protective_stop_ownership_not_verified");
    }
    if (typeof (state.entryOrderId ?? state.split?.entryOrderId) !== "string" ||
        (state.entryOrderId ?? state.split?.entryOrderId).trim() === "") {
      throw new Error("source_exit_entry_identity_unavailable");
    }
    return {
      state,
      accountState,
      quantity: actualQuantity,
      ownedStops,
    };
  }

  async function reconcileSourceExitStopResidual(record, capabilities) {
    const state = record?.snapshot;
    if (!validObject(state) || state.environment !== "vst" ||
        state.accountId !== capabilities?.accountId ||
        state.exchangePositionId == null) return null;
    let accountState;
    try {
      accountState = await broker.readAccountState();
    } catch {
      return null;
    }
    if (!validObject(accountState) || accountState.verified !== true ||
        accountState.environment !== "vst" ||
        accountState.accountId !== state.accountId ||
        !Array.isArray(accountState.positions) ||
        !Array.isArray(accountState.openOrders)) return null;
    const symbolRows = accountState.positions.filter((item) =>
      normalizeSymbolKey(item?.symbol) === normalizeSymbolKey(state.symbol) &&
      Number(item?.positionAmt ?? item?.quantity) !== 0);
    const expectedQuantity = Number(state.remainingQty ?? state.quantity);
    const actualQuantity = symbolRows.length === 1
      ? Number(symbolRows[0].positionAmt ?? symbolRows[0].quantity) : 0;
    const positionIdentityMatches = symbolRows.length === 0 ||
      symbolRows.length === 1 &&
        exactExchangeIdentifier(symbolRows[0].positionId ?? symbolRows[0].positionID) ===
          state.exchangePositionId &&
        symbolRows[0].positionSide === "LONG";
    const quantityChanged = positionIdentityMatches &&
      Number.isFinite(expectedQuantity) && expectedQuantity > 0 &&
      (!symbolRows.length ||
        Number.isFinite(actualQuantity) && actualQuantity > 0 &&
          actualQuantity < expectedQuantity -
            Math.max(1e-10, expectedQuantity * 1e-8));
    if (!quantityChanged) return null;

    const knownStops = sourceExitKnownStops(state, state.exchangePositionId);
    const orders = symbolOrders(accountState, state.symbol);
    const actualIds = exactOrderIds(orders);
    if (!knownStops.length || !actualIds) return null;
    const survivingStops = knownStops.filter((stop) =>
      actualIds.includes(stop.orderId));
    const missingStops = knownStops.filter((stop) =>
      !actualIds.includes(stop.orderId));
    if (missingStops.length !== 1 ||
        !exactOwnedSourceExitStops(state, accountState, survivingStops)) {
      return null;
    }

    let exchangePosition;
    try {
      const readPositionOptions = {
        accountStateContext: accountState,
        allowProcessCache: false,
      };
      exchangePosition = await broker.readPosition(state.symbol, readPositionOptions);
    } catch {
      return null;
    }
    if (!validObject(exchangePosition) || exchangePosition.verified !== true ||
        exchangePosition.symbol !== state.symbol ||
        exchangePosition.side !== "Buy" ||
        Number(exchangePosition.leverage) !== PROFILE_LEVERAGE ||
        !profileMarginIs(exchangePosition.marginMode) ||
        Math.abs(Number(exchangePosition.quantity) - actualQuantity) >
          Math.max(1e-10, expectedQuantity * 1e-8) ||
        symbolRows.length === 1 &&
          exchangePosition.positionId !== state.exchangePositionId) {
      return null;
    }
    if (state.patternId === "impulse_buy") {
      const protectiveStops = { ...(exchangePosition.protectiveStops ?? {}) };
      for (const leg of ["core", "runner"]) {
        if (!state[`${leg}Open`]) continue;
        const expected = state.split?.[`${leg}Stop`];
        const raw = exactRawSplitStop(state, accountState, expected);
        if (raw) protectiveStops[leg] = raw;
      }
      exchangePosition = { ...exchangePosition, protectiveStops };
      return await reconcileImpulseTriggeredStop(
        record, state, exchangePosition, true,
      );
    }
    return await reconcileTriggeredStop(record, state);
  }

  async function processSourceExitRequest(
    row, record, capabilities, prerequisiteAttempts = new Set(),
  ) {
    if (row?.reason === "source_withdrawal" && !isSourceCancellation(row.evidence) &&
        typeof store.getSourceControl === "function") {
      return { kind: "blocked", reason: "source_review_no_exit",
        sourceSignalId: row.sourceSignalId, symbol: row.symbol };
    }
    if (!sourceExitRequestValid(row)) {
      return { kind: "blocked", reason: "source_exit_request_invalid",
        sourceSignalId: row?.sourceSignalId, symbol: row?.symbol };
    }
    if (!record) {
      const unresolved = await store.listUnresolvedIntents();
      const entryIntent = unresolved.find((intent) =>
        intent.sourceSignalId === row.sourceSignalId &&
        intent.request?.operation === "entry");
      if (entryIntent) {
        const assessment = capabilities ?? (await inspectCapabilities(broker)).capabilities;
        if (!assessment) {
          return { kind: "waiting", reason: "source_exit_entry_reconciliation_capabilities_unavailable" };
        }
        const result = await reconcileOne(entryIntent, assessment, false);
        return {
          kind: result.kind === "reconciled" ? "acted" : "unknown",
          reason: result.kind === "reconciled"
            ? "source_exit_entry_reconciled_refresh_required"
            : "source_exit_waiting_for_entry_reconciliation",
          sourceSignalId: row.sourceSignalId,
          symbol: row.symbol,
        };
      }
      const phase = sourceExitPhase(row.requestId);
      const closeIntent = await store.getIntent(row.sourceSignalId, phase);
      const cleanupIntents = [];
      for (const stop of closeIntent?.request?.ownedStops ?? []) {
        if (typeof stop?.orderId !== "string") continue;
        const cleanup = await store.getIntent(row.sourceSignalId,
          sourceExitCleanupPhase(row.requestId, stop.orderId));
        if (cleanup) cleanupIntents.push(cleanup);
      }
      let closedRecord;
      try {
        closedRecord = await store.getPosition(row.sourceSignalId);
      } catch {
        return { kind: "waiting", reason: "source_exit_position_ledger_unavailable" };
      }
      if (sourceExitClosedSnapshotVerified(
        closedRecord, row, closeIntent, cleanupIntents,
      )) {
        const closeOutcome = sourceExitIntentOutcome(closeIntent);
        await finishSourceExit(row.requestId, {
          outcome: "closed",
          detail: {
            sourceEvidence: row.evidence,
            fill: closeOutcome.fill,
            flat: true,
            noOpenStops: true,
          },
        });
        return { kind: "acted", operation: "source_exit_request_finished" };
      }
      if (!closeIntent &&
          !unresolved.some(intent => intent.sourceSignalId === row.sourceSignalId) &&
          typeof store.getHistoricalCloseEvent === "function") {
        const historical = committedHistoricalCloseProof(closedRecord, row,
          await store.getHistoricalCloseEvent(row.sourceSignalId));
        if (historical) {
          const finished = await finishSourceExit(row.requestId, {
            outcome: "closed",
            detail: { sourceEvidence: row.evidence, ...historical },
          });
          return finished
            ? { kind: "acted", operation: "source_exit_request_finished" }
            : { kind: "waiting", reason: "source_exit_queue_acknowledgement_unavailable",
                sourceSignalId: row.sourceSignalId, symbol: row.symbol };
        }
      }
      const committedStopClose = !closeIntent &&
        !unresolved.some((intent) => intent.sourceSignalId === row.sourceSignalId)
        ? await readCommittedStopCloseProof(store, closedRecord, row) : null;
      if (committedStopClose) {
        const finished = await finishSourceExit(row.requestId, {
          outcome: "closed",
          detail: {
            sourceEvidence: row.evidence,
            closureOrigin: "already_committed_protective_stop",
            ...committedStopClose,
            flat: true,
            noOpenStops: true,
          },
        });
        return finished
          ? { kind: "acted", operation: "source_exit_request_finished" }
          : { kind: "waiting", reason: "source_exit_queue_acknowledgement_unavailable",
              sourceSignalId: row.sourceSignalId, symbol: row.symbol };
      }
      if (closeIntent && ["submitted", "unknown", "failed"].includes(closeIntent.state)) {
        const attemptKey = reconciliationIntentKey(closeIntent);
        if (prerequisiteAttempts.has(attemptKey)) {
          return { kind: "blocked", reason: "source_exit_close_reconciliation_pending",
            sourceSignalId: row.sourceSignalId, symbol: row.symbol };
        }
        prerequisiteAttempts.add(attemptKey);
        const result = await reconcilePendingSourceIntent(closeIntent, capabilities);
        return result.kind === "acted"
          ? result
          : { kind: "blocked",
              reason: result.reason ?? "source_exit_close_reconciliation_pending",
              sourceSignalId: row.sourceSignalId, symbol: row.symbol };
      }
      const priorEntry = await store.getIntent(row.sourceSignalId, "market-entry");
      if (priorEntry?.state === "reconciled") {
        return { kind: "blocked", reason: "source_exit_entered_position_ledger_missing",
          sourceSignalId: row.sourceSignalId, symbol: row.symbol };
      }
      const sameSymbolUnresolved = unresolved.find((intent) =>
        intent.sourceSignalId === row.sourceSignalId &&
        intent.clientOrderId !== closeIntent?.clientOrderId &&
        intentBlocksSymbol(intent, normalizeSymbolKey(row.symbol)));
      if (sameSymbolUnresolved) {
        const attemptKey = reconciliationIntentKey(sameSymbolUnresolved);
        if (prerequisiteAttempts.has(attemptKey)) {
          return { kind: "blocked", reason: "source_exit_same_symbol_intent_unresolved",
            sourceSignalId: row.sourceSignalId, symbol: row.symbol,
            blockingSourceSignalId: sameSymbolUnresolved.sourceSignalId,
            blockingOperation: sameSymbolUnresolved.request?.operation ?? null,
            blockingClientOrderId: sameSymbolUnresolved.clientOrderId ?? null };
        }
        prerequisiteAttempts.add(attemptKey);
        const assessment = capabilities ??
          (await inspectCapabilities(broker)).capabilities;
        if (!assessment) {
          return { kind: "waiting",
            reason: "source_exit_prerequisite_capabilities_unavailable",
            sourceSignalId: row.sourceSignalId, symbol: row.symbol };
        }
        const prerequisite = await reconcileOne(
          sameSymbolUnresolved, assessment, false,
        );
        return prerequisite.kind === "reconciled"
          ? { kind: "acted", operation: "source_exit_prerequisite_reconciled",
              sourceSignalId: row.sourceSignalId, symbol: row.symbol }
          : { kind: "blocked", reason: "source_exit_same_symbol_intent_unresolved",
              sourceSignalId: row.sourceSignalId, symbol: row.symbol,
              blockingSourceSignalId: sameSymbolUnresolved.sourceSignalId,
            blockingOperation: sameSymbolUnresolved.request?.operation ?? null,
            blockingClientOrderId: sameSymbolUnresolved.clientOrderId ?? null };
      }
      const candidateExists = typeof store.hasPendingSourceExitRequest === "function" &&
        await store.hasPendingSourceExitRequest(row.sourceSignalId);
      if (candidateExists && !closeIntent) {
        const reason = "source_withdrawn_before_entry";
        await store.setSignalStatus(row.sourceSignalId, "rejected", reason);
        await store.recordEvent?.(row.sourceSignalId, "vst_source_exit_unentered", {
          reason, sourceExitRequestId: row.requestId, sourceEvidence: row.evidence,
        });
        await finishSourceExit(row.requestId, {
          outcome: "cancelled_unentered",
          detail: { reason, sourceEvidence: row.evidence },
        });
        return { kind: "acted", operation: "source_exit_unentered_candidate_cancelled" };
      }
      return { kind: "blocked", reason: "source_exit_position_not_in_ledger",
        sourceSignalId: row.sourceSignalId, symbol: row.symbol };
    }
    if (record.sourceSignalId !== row.sourceSignalId ||
        record.symbol !== row.symbol ||
        record.snapshot?.sourceSignalId !== row.sourceSignalId ||
        record.snapshot?.symbol !== row.symbol) {
      return { kind: "blocked", reason: "source_exit_exact_position_identity_mismatch",
        sourceSignalId: row.sourceSignalId, symbol: row.symbol };
    }
    const state = record.snapshot;
    if (state.sourceExitEvidence &&
        JSON.stringify(state.sourceExitEvidence) !== JSON.stringify(row.evidence)) {
      return { kind: "blocked", reason: "source_exit_position_provenance_changed",
        sourceSignalId: row.sourceSignalId, symbol: row.symbol };
    }
    if (state.sourceExitRequestId && state.sourceExitRequestId !== row.requestId) {
      return { kind: "blocked", reason: "source_exit_position_has_different_request",
        sourceSignalId: row.sourceSignalId, symbol: row.symbol };
    }
    const phase = sourceExitPhase(row.requestId);
    const existing = await store.getIntent(row.sourceSignalId, phase);
    if (existing?.request?.sourceExit &&
        JSON.stringify(existing.request.sourceExit.evidence) !==
          JSON.stringify(row.evidence)) {
      return { kind: "blocked", reason: "source_exit_request_provenance_changed",
        sourceSignalId: row.sourceSignalId, symbol: row.symbol };
    }
    if (existing && ["submitted", "unknown", "failed"].includes(existing.state)) {
      return await reconcilePendingSourceIntent(existing, capabilities);
    }
    // Quarantine prevents replay of the ambiguous stop transfer, not an
    // independently authorized full exit. The strict native entry/position/
    // owned-order preflight and final signing guards below still apply.
    const unresolved = await store.listUnresolvedIntents();
    const pendingEntry = unresolved.find((intent) =>
      intent.sourceSignalId === row.sourceSignalId &&
      intent.request?.operation === "entry");
    if (pendingEntry) {
      const attemptKey = reconciliationIntentKey(pendingEntry);
      if (prerequisiteAttempts.has(attemptKey)) {
        return { kind: "blocked", reason: "source_exit_waiting_for_entry_reconciliation",
          sourceSignalId: row.sourceSignalId, symbol: row.symbol };
      }
      prerequisiteAttempts.add(attemptKey);
      const result = await reconcileOne(pendingEntry, capabilities, false);
      return {
        kind: result.kind === "reconciled" ? "acted" : "unknown",
        reason: result.kind === "reconciled"
          ? "source_exit_entry_reconciled_refresh_required"
          : "source_exit_waiting_for_entry_reconciliation",
        sourceSignalId: row.sourceSignalId,
        symbol: row.symbol,
      };
    }
    const sameSymbolConflict = unresolved.find((intent) =>
      intent.clientOrderId !== existing?.clientOrderId &&
      intentBlocksSymbol(intent, normalizeSymbolKey(row.symbol)));
    if (sameSymbolConflict) {
      const attemptKey = reconciliationIntentKey(sameSymbolConflict);
      if (prerequisiteAttempts.has(attemptKey)) {
        return { kind: "blocked", reason: "source_exit_same_symbol_intent_unresolved",
          sourceSignalId: row.sourceSignalId, symbol: row.symbol,
          blockingSourceSignalId: sameSymbolConflict.sourceSignalId,
            blockingOperation: sameSymbolConflict.request?.operation ?? null,
            blockingClientOrderId: sameSymbolConflict.clientOrderId ?? null };
      }
      prerequisiteAttempts.add(attemptKey);
      let prerequisite;
      if (sameSymbolConflict.request?.operation === "observe_triggered_stop") {
        let conflictRecord = sameSymbolConflict.sourceSignalId === record.sourceSignalId
          ? record : null;
        if (!conflictRecord) {
          try {
            conflictRecord = await store.getPosition(sameSymbolConflict.sourceSignalId);
          } catch {}
        }
        prerequisite = conflictRecord
          ? await reconcileSourceExitStopResidual(conflictRecord, capabilities)
          : null;
      } else {
        prerequisite = await reconcileOne(sameSymbolConflict, capabilities, false);
      }
      if (prerequisite?.kind === "acted" ||
          prerequisite?.kind === "reconciled" ||
          prerequisite?.kind === "failed") {
        return { kind: "acted", operation: "source_exit_prerequisite_reconciled",
          sourceSignalId: row.sourceSignalId, symbol: row.symbol };
      }
      return { kind: "blocked", reason: "source_exit_same_symbol_intent_unresolved",
        sourceSignalId: row.sourceSignalId, symbol: row.symbol,
        blockingSourceSignalId: sameSymbolConflict.sourceSignalId,
            blockingOperation: sameSymbolConflict.request?.operation ?? null,
            blockingClientOrderId: sameSymbolConflict.clientOrderId ?? null };
    }
    if (state.sourceExitCleanup?.requestId === row.requestId &&
        state.split?.stage === "flat_cleanup_pending") {
      return await advanceSourceExitStopCleanup(record, row, capabilities);
    }
    if (!capabilities || capabilities.environment !== "vst" ||
        capabilities.verified !== true ||
        capabilities.accountId !== state.accountId) {
      return { kind: "waiting", reason: "source_exit_vst_account_not_verified",
        sourceSignalId: row.sourceSignalId, symbol: row.symbol };
    }
    if (!assessmentCanMutateSourceExit(capabilities)) {
      return { kind: "waiting", reason: "source_exit_verified_close_capability_unavailable",
        sourceSignalId: row.sourceSignalId, symbol: row.symbol };
    }
    if (exchangeActionAttemptedThisTick) {
      return { kind: "waiting", reason: "source_exit_waiting_for_tick_mutation_boundary",
        sourceSignalId: row.sourceSignalId, symbol: row.symbol };
    }
    const residualAttemptKey = `stop-residual:${row.sourceSignalId}`;
    if (!prerequisiteAttempts.has(residualAttemptKey)) {
      prerequisiteAttempts.add(residualAttemptKey);
      const stopResidual = await reconcileSourceExitStopResidual(record, capabilities);
      if (stopResidual?.kind === "acted") {
        return { kind: "acted", operation: "source_exit_stop_fill_reconciled",
          sourceSignalId: row.sourceSignalId, symbol: row.symbol };
      }
      if (stopResidual?.kind === "unknown") {
        return stopResidual;
      }
    }
    let preflight;
    try {
      preflight = await sourceExitPositionPreflight(record, capabilities);
    } catch (error) {
      const reason = error instanceof Error
        ? error.message : "source_exit_position_preflight_failed";
      await store.setSignalStatus(row.sourceSignalId, "unknown", reason);
      await store.upsertPosition({
        ...state,
        sourceExitEvidence: row.evidence,
        sourceExitRequestId: row.requestId,
        sourceExitBlockReason: reason,
        status: state.protectionDegradation?.version === 1 ? state.status : "unknown",
      });
      return { kind: "unknown", reason, sourceSignalId: row.sourceSignalId,
        symbol: row.symbol };
    }
    const sourceExit = {
      stage: "close",
      requestId: row.requestId,
      evidence: row.evidence,
    };
    const signal = validObject(state.signalSnapshot)
      ? { ...state.signalSnapshot, patternId: "source_exit" }
      : { sourceSignalId: row.sourceSignalId, patternId: "source_exit" };
    const closeState = preflight.state;
    const request = {
      operation: "close_leg",
      sourceSignalId: row.sourceSignalId,
      symbol: row.symbol,
      environment: "vst",
      accountId: closeState.accountId,
      positionId: closeState.exchangePositionId,
      quantity: preflight.quantity,
      previousQuantity: preflight.quantity,
      reason: row.reason,
      signal,
      ...(closeState.signalAt !== undefined
        ? { signalAt: closeState.signalAt } : {}),
      priorPosition: Object.freeze({
        ...closeState,
        sourceExitEvidence: row.evidence,
        sourceExitRequestId: row.requestId,
      }),
      ...(validObject(closeState.persistedPosition)
        ? { persistedPosition: closeState.persistedPosition } : {}),
      ownedStops: preflight.ownedStops,
      sourceExitRequestId: row.requestId,
      sourceExit,
    };
    const submitted = await reserveAndPerform(
      row.sourceSignalId, phase, request,
    );
    const intent = await store.getIntent(row.sourceSignalId, phase);
    if (submitted.kind === "existing" && intent?.state === "reconciled") {
      return { kind: "waiting", reason: "source_exit_close_already_reconciled",
        sourceSignalId: row.sourceSignalId, symbol: row.symbol };
    }
    if (intent && ["submitted", "unknown"].includes(intent.state)) {
      const result = await reconcileOne(intent, capabilities, false);
      if (result.kind === "reconciled" && result.sourceExit) {
        return { kind: "acted", operation: "source_exit_close",
          sourceSignalId: row.sourceSignalId, symbol: row.symbol };
      }
      return { kind: "unknown", reason: result.reason ?? "source_exit_close_unconfirmed",
        sourceSignalId: row.sourceSignalId, symbol: row.symbol };
    }
    return { kind: "unknown", reason: "source_exit_close_intent_not_submitted",
      sourceSignalId: row.sourceSignalId, symbol: row.symbol };
  }

  function assessmentCanMutateSourceExit(capabilities) {
    const features = capabilities?.features;
    return Array.isArray(features) &&
      (features.includes("verified_exact_full_position_close") ||
        features.includes("verified_exact_source_full_position_close")) &&
      features.includes("verified_position_state");
  }

  function assessmentCanMutateSourceExitCleanup(capabilities) {
    const features = capabilities?.features;
    return Array.isArray(features) &&
      features.includes("verified_source_flat_stop_cleanup") &&
      features.includes("verified_position_state");
  }

  async function advanceSourceExitStopCleanup(record, row, capabilities) {
    const state = record.snapshot;
    if (!capabilities || capabilities.environment !== "vst" ||
        capabilities.accountId !== state.accountId ||
        !assessmentCanMutateSourceExitCleanup(capabilities)) {
      return { kind: "waiting", reason: "source_exit_stop_cleanup_capability_unavailable",
        sourceSignalId: row.sourceSignalId, symbol: row.symbol };
    }
    if (exchangeActionAttemptedThisTick) {
      return { kind: "waiting", reason: "source_exit_waiting_for_tick_mutation_boundary",
        sourceSignalId: row.sourceSignalId, symbol: row.symbol };
    }
    const accountState = await broker.readAccountState();
    const cleanup = state.sourceExitCleanup;
    const split = state.split;
    if (!flatPositionFromAccountState(accountState, state.symbol) ||
        accountState?.environment !== "vst" ||
        accountState?.accountId !== state.accountId ||
        split?.stage !== "flat_cleanup_pending" ||
        split.positionId !== state.exchangePositionId ||
        !Array.isArray(cleanup?.remainingKnownStopOrderIds) ||
        JSON.stringify(cleanup.remainingKnownStopOrderIds.slice().sort()) !==
          JSON.stringify(split.remainingKnownStopOrderIds?.slice().sort())) {
      const reason = "source_exit_flat_cleanup_ledger_or_exchange_mismatch";
      await store.setSignalStatus(row.sourceSignalId, "unknown", reason);
      await store.upsertPosition({ ...state, status: "unknown",
        sourceExitBlockReason: reason });
      return { kind: "unknown", reason, sourceSignalId: row.sourceSignalId,
        symbol: row.symbol };
    }
    const orders = symbolOrders(accountState, state.symbol);
    const ids = exactOrderIds(orders);
    if (!ids || JSON.stringify(ids.slice().sort()) !==
        JSON.stringify(cleanup.remainingKnownStopOrderIds.slice().sort()) ||
        ids.some((id) => !exactRawSplitStop(state, accountState,
          split.flatCleanupStops.find((stop) => stop.orderId === id)))) {
      const reason = "source_exit_flat_cleanup_stop_identity_unverified";
      await store.setSignalStatus(row.sourceSignalId, "unknown", reason);
      await store.upsertPosition({ ...state, status: "unknown",
        sourceExitBlockReason: reason });
      return { kind: "unknown", reason, sourceSignalId: row.sourceSignalId,
        symbol: row.symbol };
    }
    const targetId = cleanup.remainingKnownStopOrderIds[0];
    const stop = split.flatCleanupStops.find((item) => item.orderId === targetId);
    if (!stop) {
      return { kind: "unknown", reason: "source_exit_flat_cleanup_target_missing",
        sourceSignalId: row.sourceSignalId, symbol: row.symbol };
    }
    const phase = sourceExitCleanupPhase(row.requestId, targetId);
    const cancellationIntentId = orderId(row.sourceSignalId, phase);
    const request = {
      operation: "cancel_flat_split_stop",
      sourceSignalId: row.sourceSignalId,
      symbol: row.symbol,
      environment: "vst",
      accountId: state.accountId,
      positionId: state.exchangePositionId,
      stopToCancel: {
        orderId: targetId,
        quantity: String(stop.quantity),
        stopPrice: String(stop.stopPrice),
      },
      knownRemainingStopOrderIds: [...cleanup.remainingKnownStopOrderIds],
      cancellationIntentId,
      priorPosition: state,
      sourceExit: {
        stage: "cleanup",
        requestId: row.requestId,
        evidence: row.evidence,
      },
    };
    const submitted = await reserveAndPerform(row.sourceSignalId, phase, request);
    const intent = await store.getIntent(row.sourceSignalId, phase);
    if (intent && ["submitted", "unknown"].includes(intent.state)) {
      const result = await reconcileOne(intent, capabilities, false);
      if (result.kind === "reconciled") {
        return { kind: "acted", operation: "source_exit_stop_cleanup",
          sourceSignalId: row.sourceSignalId, symbol: row.symbol };
      }
      return { kind: "unknown", reason: result.reason ??
        "source_exit_stop_cleanup_unconfirmed",
      sourceSignalId: row.sourceSignalId, symbol: row.symbol };
    }
    return { kind: submitted.kind === "existing" ? "waiting" : "unknown",
      reason: "source_exit_stop_cleanup_intent_not_submitted",
      sourceSignalId: row.sourceSignalId, symbol: row.symbol };
  }

  function sourceExitRowExceptionIsolatable(row, record) {
    const state = record?.snapshot;
    return validObject(row) &&
      typeof row.sourceSignalId === "string" &&
      row.sourceSignalId.trim() !== "" &&
      isCanonicalVstSymbol(row.symbol) &&
      record?.sourceSignalId === row.sourceSignalId &&
      record?.symbol === row.symbol &&
      validObject(state) &&
      state.sourceSignalId === row.sourceSignalId &&
      state.symbol === row.symbol &&
      state.environment === "vst" &&
      typeof state.accountId === "string" &&
      state.accountId.trim() !== "" &&
      typeof state.exchangePositionId === "string" &&
      state.exchangePositionId.trim() !== "" &&
      typeof state.entryClientOrderId === "string" &&
      state.entryClientOrderId.trim() !== "";
  }

  function isSourceExitCanonicalizationError(error) {
    return error instanceof TypeError &&
      error.message === "Persisted objects must not contain undefined values";
  }

  async function processPendingSourceExits(
    requests, capabilities = null, recordTiming = null,
  ) {
    const startedAt = performance.now();
    try {
      return await processPendingSourceExitsInternal(requests, capabilities);
    } finally {
      if (typeof recordTiming === "function") {
        recordTiming("sourceExits", performance.now() - startedAt);
      }
    }
  }

  async function processPendingSourceExitsInternal(requests, capabilities = null) {
    if (!sourceExitsEnabled) return null;
    if (!Array.isArray(requests)) {
      return { kind: "waiting", reason: "source_exit_queue_invalid" };
    }
    if (!requests.length) return null;
    let records;
    try {
      records = await store.listOpenPositions();
    } catch {
      return { kind: "waiting", reason: "source_exit_position_ledger_unavailable" };
    }
    let firstGlobalBlock = null;
    let assessment = capabilities;
    for (const row of requests) {
      const record = records.find((item) =>
        item?.sourceSignalId === row?.sourceSignalId);
      const symbolKey = normalizeSymbolKey(row?.symbol);
      if (sourceExitBlockedSymbols.has(symbolKey)) continue;
      const intents = await store.listUnresolvedIntents();
      const needsExchange = Boolean(record) ||
        intents.some((intent) =>
          intent.sourceSignalId === row?.sourceSignalId &&
          (intent.request?.operation === "entry" ||
            intent.request?.sourceExit?.requestId === row?.requestId ||
            intentBlocksSymbol(intent, normalizeSymbolKey(row?.symbol))));
      if (needsExchange && !assessment) {
        const inspected = await inspectCapabilities(
          broker, undefined, SOURCE_EXIT_READ_CAPABILITIES,
        );
        if (inspected.explicitWrongEnvironment) {
          firstGlobalBlock ??= { kind: "blocked", reason: inspected.reason,
            sourceSignalId: row?.sourceSignalId, symbol: row?.symbol };
          continue;
        }
        if (!inspected.safeForVstReads || !inspected.capabilities) {
          firstGlobalBlock ??= { kind: "waiting", reason: inspected.reason ??
            "source_exit_capabilities_unavailable",
          sourceSignalId: row?.sourceSignalId, symbol: row?.symbol };
          continue;
        }
        assessment = inspected.capabilities;
      }
      let result;
      const rowStartedAt = performance.now();
      try {
        result = await processSourceExitRequest(
          row, record, assessment, sourceExitPrerequisiteAttemptsThisTick,
        );
      } catch (error) {
        if (exchangeActionAttemptedThisTick ||
            !sourceExitRowExceptionIsolatable(row, record) ||
            !isSourceExitCanonicalizationError(error)) {
          throw error;
        }
        recordVstDiagnostic(error, {
          stage: "sourceExits", operation: "source_exit",
          symbol: row?.symbol,
          sourceSignalId: row?.sourceSignalId,
        });
        const reason = "source_exit_row_preflight_error";
        result = {
          kind: "unknown",
          reason,
          sourceSignalId: row.sourceSignalId,
          symbol: row.symbol,
        };
        if (typeof onTiming === "function") {
          try {
            const elapsed = Math.max(0, Math.round(performance.now() - rowStartedAt));
            await onTiming({
              kind: "exception",
              totalMs: elapsed,
              stages: { sourceExits: elapsed },
              diagnosticReason: reason,
              diagnosticMessage: safeTickErrorSummary(error),
              sourceSignalId: row.sourceSignalId,
              symbol: row.symbol,
            });
          } catch {}
        }
      }
      if (result?.kind === "acted") return result;
      if (result?.reason) {
        recordVstRefusal(result.reason, {
          stage: "sourceExits", operation: "source_exit",
          check: "ownership", symbol: row.symbol,
          sourceSignalId: row.sourceSignalId,
        });
      }
      const resultSymbolKey = normalizeSymbolKey(result?.symbol ?? row?.symbol);
      const globalBlock = !isCanonicalVstSymbol(result?.symbol ?? row?.symbol) ||
        result?.reason === "source_exit_queue_invalid" ||
        result?.reason === "source_exit_position_ledger_unavailable" ||
        result?.reason === "source_exit_account_snapshot_not_verified" ||
        result?.reason === "source_exit_vst_account_not_verified" ||
        result?.reason === "source_exit_verified_close_capability_unavailable" ||
        result?.reason === "source_exit_capabilities_unavailable" ||
        result?.reason === "source_exit_waiting_for_tick_mutation_boundary";
      if (globalBlock) {
        firstGlobalBlock ??= result ?? {
          kind: "blocked", reason: "source_exit_request_unidentifiable",
        };
        break;
      } else if (result) {
        sourceExitBlockedSymbols.add(resultSymbolKey);
        sourceExitBlockedRows.set(resultSymbolKey, result);
      }
      // A queued source exit is a hard barrier against entries. Continue to
      // later queued exits so a stuck/foreign symbol cannot starve another
      // independently verifiable source close. Local failures are returned
      // to the caller as symbol-scoped barriers, not global tick blockers.
    }
    return firstGlobalBlock;
  }

  async function readPendingSourceExitRequests() {
    if (!sourceExitsEnabled) return [];
    const rows = await store.listPendingSourceExitRequests();
    if (!Array.isArray(rows)) throw new Error("source_exit_queue_invalid");
    return rows;
  }

  async function runOnce() {
    const tickId = `vst-tick-${randomUUID()}`;
    return withVstDiagnosticContext(
      { tickId, stage: "worker_tick" }, () => runOnceTracked(),
    );
  }

  async function runOnceTracked() {
    const started = performance.now();
    const stages = {};
    const stageCounts = {};
    const diagnosticContext = {
      currentManagedSymbol: null,
      failedManagedSymbol: null,
      failedManagedSourceSignalId: null,
    };
    let candidateScanDiagnostics = null;
    const recordTiming = (name, elapsed) => {
      // Position management runs once per open position. Keep its total
      // rather than replacing earlier positions with the last one's time.
      stages[name] = (stages[name] ?? 0) + Math.round(elapsed);
      stageCounts[name] = (stageCounts[name] ?? 0) + 1;
    };
    const reportLargeCandidateScan = ({ pages, candidates, elapsedMs }) => {
      candidateScanDiagnostics = { pages, candidates, elapsedMs };
    };
    let result;
    let failure;
    try {
      result = await runOnceInternal(
        recordTiming, reportLargeCandidateScan, diagnosticContext,
      );
    } catch (error) {
      failure = error;
      const diagnostic = recordVstDiagnostic(error, {
        stage: "worker_tick",
        symbol: diagnosticContext.failedManagedSymbol,
        sourceSignalId: diagnosticContext.failedManagedSourceSignalId,
      });
      diagnosticContext.failureRef = diagnostic.ref;
    }
    const totalMs = Math.round(performance.now() - started);
    const slow = totalMs >= 10_000;
    const now = Number(clock());
    const reportSlow = slow &&
      (lastSlowTimingAt === null || now - lastSlowTimingAt >= 60_000);
    const waiting = !failure && result?.kind === "waiting";
    const reportWaiting = waiting &&
      (lastWaitingTimingAt === null || now - lastWaitingTimingAt >= 60_000);
    const diagnosticReason = failure
      ? "worker_error"
      : SAFE_DIAGNOSTIC_REASONS.has(result?.diagnosticReason)
        ? result.diagnosticReason
        : SAFE_DIAGNOSTIC_REASONS.has(result?.reason)
          ? result.reason
          : undefined;
    const diagnosticCode = Number.isSafeInteger(failure?.code) && failure.code >= 0
      ? failure.code
      : Number.isSafeInteger(result?.diagnosticCode) && result.diagnosticCode >= 0
        ? result.diagnosticCode
        : undefined;
    const diagnosticMessage = failure
      ? safeTickErrorSummary(failure)
      : result?.diagnosticMessage;
    const bingXReadDiagnostic = failure
      ? safeBingXReadDiagnostic(failure)
      : {};
    const managedSymbol = isCanonicalVstSymbol(
      diagnosticContext.failedManagedSymbol,
    ) ? diagnosticContext.failedManagedSymbol : undefined;
    // Diagnostics must never drive trade decisions or leak account balances.
    // Summarize completed stages and slow ticks; repeated idle/blocked ticks
    // are rate-limited so a slow venue does not flood the production logs.
    if (typeof onTiming === "function" &&
        (failure ||
         ["prepared", "top_up_pending", "funded", "unknown", "error", "rejected"].includes(result?.kind) ||
         reportSlow || reportWaiting || candidateScanDiagnostics)) {
      if (reportSlow) lastSlowTimingAt = now;
      if (reportWaiting) lastWaitingTimingAt = now;
      try {
        await onTiming({
          kind: failure ? "exception" : result?.kind ?? "lock_unavailable",
          totalMs,
          stages,
          ...(stageCounts.positionManagement
            ? { positionManagementCount: stageCounts.positionManagement } : {}),
          ...(candidateScanDiagnostics
            ? { candidateScan: candidateScanDiagnostics } : {}),
          ...(diagnosticReason ? { diagnosticReason } : {}),
          ...(diagnosticCode !== undefined ? { diagnosticCode } : {}),
          ...(diagnosticMessage ? { diagnosticMessage } : {}),
          ...(diagnosticContext.failureRef
            ? { diagnosticRef: diagnosticContext.failureRef } : {}),
          ...bingXReadDiagnostic,
          ...(managedSymbol ? { managedSymbol } : {}),
        });
      } catch {}
    }
    if (failure) throw failure;
    // Another worker owns the leader lock. No tick ran, so do not treat
    // this as recovery or reset any waiting/blocked alert timers.
    if (result === null) return null;
    await reportBlockedIfDue(result);
    await reportPositionIssuesIfDue();
    await reportPendingSignalsWaiting(result);
    await reportUnresolvedIntentsIfDue();
    return result;
  }

  async function runOnceInternal(
    recordTiming = () => {},
    reportLargeCandidateScan = () => {},
    diagnosticContext = { currentManagedSymbol: null, failedManagedSymbol: null },
  ) {
    const entryContinuation = preparedEntryContinuation;
    preparedEntryContinuation = null;
    // Retain authenticated VST ingress/ledger while preventing ANY new
    // exchange writes during an exchange-protocol or reconciliation incident.
    if (process.env.BULLET_VST_PAUSED === "1") {
      return { kind: "paused", reason: "vst_execution_paused" };
    }
    return store.withLeaderLock(async () => {
      exchangeActionAttemptedThisTick = false;
      historicalProofAttemptedThisTick = false;
      positionIssuesThisTick.clear();
      positionReadDiagnosticsThisTick.clear();
      positionReadsRecoveredThisTick.clear();
      sourceExitBlockedSymbols = new Set();
      sourceExitBlockedRows = new Map();
      sourceExitPrerequisiteAttemptsThisTick = new Set();
      // Expiration is a ledger-only action: it must not depend on a successful
      // exchange probe. The store protects every signal that has ever started
      // an intent or acquired a position, including ambiguous historical work.
      if (typeof store.retireExpiredUnstartedSignals === "function") {
        await store.retireExpiredUnstartedSignals({
          nowMs: Number(clock()),
          maxAgeMs: 10 * 60_000,
        });
      }
      // Durable source exits are inspected before capabilities, unrelated
      // position work, and new entries. Admission freshness is enforced by
      // the queue writer; once accepted the command is irrevocable and is not
      // aged out if later source polling stops or reports the position active.
      if (sourceExitsEnabled) {
        let sourceRequests;
        try {
          sourceRequests = await readPendingSourceExitRequests();
        } catch (error) {
          recordVstDiagnostic(error, {
            stage: "sourceExits", operation: "source_exit",
          });
          return { kind: "waiting", reason: "source_exit_queue_unavailable" };
        }
        const sourceResult = await processPendingSourceExits(
          sourceRequests, null, recordTiming,
        );
        if (sourceResult) return sourceResult;
      }
      // Latched +5% takes close before any other position or entry work.
      const fullTakeResult = await processLatchedFullTakes(recordTiming);
      if (fullTakeResult) return fullTakeResult;
      let stageStarted = performance.now();
      const assessment = await inspectCapabilities(broker, recordTiming);
      recordTiming("capabilities", performance.now() - stageStarted);
      if (assessment.explicitWrongEnvironment) {
        return {
          kind: "blocked",
          reason: assessment.reason,
          diagnosticReason: assessment.diagnosticReason,
        };
      }
      if (!assessment.safeForVstReads) {
        return {
          kind: "waiting",
          reason: assessment.reason,
          diagnosticReason: assessment.diagnosticReason,
          diagnosticCode: assessment.diagnosticCode,
          ...(assessment.diagnosticMessage
            ? { diagnosticMessage: assessment.diagnosticMessage } : {}),
        };
      }

      if (await urgentWorkPending()) return urgentYield();
      stageStarted = performance.now();
      await resumeExchangeVerifiedFailedEntries();
      if (await recoverOneSubmittedFailedMarginTopUp()) {
        recordTiming("failedEntryRecovery", performance.now() - stageStarted);
        return { kind: "funded", reason: "vst_margin_top_up_verified_refresh_required" };
      }
      recordTiming("failedEntryRecovery", performance.now() - stageStarted);
      // Never prepare another margin-add POST from a historical "failed"
      // verdict based on unchanged initialMargin. That verdict was false on
      // real VST positions. The read-only history repair above is the only
      // automatic recovery path for these records.
      // Resolve durable mutations before considering new signals. Reconciliation
      // is read-only and uses the account/environment persisted in each intent
      // when the capability read itself is temporarily unavailable.
      stageStarted = performance.now();
      const reconciliation = await reconcileOutstanding(
        assessment.capabilities, Boolean(assessment.mutationCapabilities),
      );
      recordTiming("reconciliation", performance.now() - stageStarted);
      const unresolved = reconciliation.unresolved;
      let accountState;
      stageStarted = performance.now();
      // Carry the request-start time so a slow account-wide read does not
      // reset the shared-snapshot freshness window when its responses arrive.
      const accountStateReadAt = performance.now();
      try {
        accountState = await broker.readAccountState();
      } catch (error) {
        recordVstDiagnostic(error, {
          stage: "accountRead", operation: "read_account",
          check: "account_snapshot",
        });
      }
      recordTiming("accountRead", performance.now() - stageStarted);
      if (reconciliation.recoveredPreTransportRunnerCancel) {
        // The recovery transaction only repairs the ledger after proving that
        // the old request never reached DELETE. Keep the next new-ID cancel
        // attempt behind its own tick boundary and strict two-stop preflight.
        return {
          kind: "acted",
          operation: "recover_pretransport_runner_cancel",
        };
      }
      if (reconciliation.recoveredPreRunnerSplitCloseNoWrite) {
        // This read-only boundary retires only the exact attempt proved not
        // to have crossed transport. A fresh tick must make the next policy
        // decision so its mark and split preflight are independently current.
        return {
          kind: "acted",
          operation: "recover_pretransport_pre_runner_split_close",
        };
      }
      if (reconciliation.recoveredRaiseStopEntryProofRefusal) {
        // This settled only a proven pre-adapter refusal. Leave the next
        // policy decision to another tick with its own fresh position read.
        return {
          kind: "reconciled",
          reason: "raise_stop_entry_proof_refusal_recovered",
        };
      }
      if (reconciliation.recoveredRaiseStopCommittedClose) {
        // The exact stop child fill was already committed to a closed ledger
        // position. Retire only the separate pre-adapter refusal, and keep
        // this tick as a no-management/no-write boundary.
        return {
          kind: "reconciled",
          reason: "raise_stop_refusal_settled_after_committed_close",
        };
      }
      if (reconciliation.adoptedUnlinkedRaiseStopProtection) {
        // The fresh native proof was committed atomically, but this was not
        // the original writer's acknowledgement. Let the next tick's ordinary
        // position manager consume the newly adopted stop identity.
        return {
          kind: "reconciled",
          reason: "raise_stop_unlinked_protection_adopted",
        };
      }
      if (reconciliation.recoveredOriginalStopCancelPreReadRefusal) {
        // The old DELETE intent was retired only as a proven read refusal.
        // The distinct retry phase is intentionally left for a later tick's
        // complete, fresh split-stop preflight.
        return {
          kind: "reconciled",
          reason: "original_stop_cancel_pre_read_refusal_recovered",
        };
      }
      const verifiedAccountState = validObject(accountState) &&
        Array.isArray(accountState.positions) &&
        Array.isArray(accountState.openOrders);
      const verifiedCleanupAccountState = verifiedAccountState &&
        accountState.verified === true;
      if (reconciliation.exchangeMutationAttempted ||
          reconciliation.marginMutationAttempted ||
          reconciliation.reconciledMarginTopUp) {
        // Any exchange mutation (including one reported by intent recovery),
        // even with an ambiguous response, is a hard tick boundary: take a
        // fresh account read after it, then do not use that snapshot for
        // further strategy work or another exchange mutation. Read-only
        // reconciliation that verifies an earlier top-up uses the same
        // refresh boundary before normal management resumes next tick.
        if (!verifiedCleanupAccountState) {
          return {
            kind: "waiting",
            reason: "account_state_not_verified_after_margin_top_up",
          };
        }
        return reconciliation.reconciledMarginTopUp
          ? { kind: "funded", reason: "vst_margin_top_up_verified_refresh_required" }
          : { kind: "unknown", reason: "vst_margin_top_up_requires_verified_reconciliation" };
      }
      if (reconciliation.reconciledRunnerFillCleanup) {
        // A recovered trigger is a ledger transition, not permission to
        // cancel the original stop against the same pre-recovery tick. The
        // established cleanup path gets its own next-tick strict preflight.
        return {
          kind: "acted",
          operation: "observe_triggered_stop",
          leg: "runner",
        };
      }
      if (sourceExitsEnabled) {
        let sourceRequests;
        try {
          sourceRequests = await readPendingSourceExitRequests();
        } catch {
          return { kind: "waiting", reason: "source_exit_queue_unavailable" };
        }
        const sourceResult = await processPendingSourceExits(
          sourceRequests, assessment.capabilities, recordTiming,
        );
        if (sourceResult) return sourceResult;
      }
      // Recover ledger-only closes before ordinary management and the write
      // capability gate. Missing exchange protection on an already-flat
      // account must not make the history repair unreachable.
      const historicalRepair = await reconcileOneHistoricalErrorClose(
        accountState, assessment.capabilities, { activeOnly: true },
      );
      if (historicalRepair) return historicalRepair;
      const openPositions = await store.listOpenPositions();
      // Self-healing: a ledger position whose symbol has been flat on the
      // exchange (no position, no open orders, no in-flight write) across
      // several fresh account reads is closed in the ledger automatically.
      const externalClose = await reconcileExternallyFlatPositions(
        openPositions, accountState, unresolved,
      );
      if (externalClose) return externalClose;
      const openPositionIds = new Set(openPositions.map((record) =>
        record?.sourceSignalId).filter((id) => typeof id === "string"));
      for (const key of positionIssueSince.keys()) {
        if (!openPositionIds.has(key)) {
          positionIssueSince.delete(key);
          lastPositionIssueAlertAt.delete(key);
          lastPositionIssueAlertSignature.delete(key);
          positionReadRecovery.forget(key);
          positionReadsRecoveredThisTick.add(key);
        }
      }
      // Many symbols can each carry their own independent position
      // concurrently by design now -- one symbol's unverified margin top-up
      // must never stop OTHER symbols from being managed. It still means
      // THIS position is never touched until reconciliation verifies it.
      const unresolvedMarginTopUpBySymbol = new Map();
      for (const record of openPositions) {
        const topUp = record.snapshot?.marginTopUp;
        // A "failed" top-up that carries an owner manualResolution marker
        // (see vst-store.mjs resolveMarginTopUpKeepOpen) has already been
        // looked at by a human and is not still pending -- it must not keep
        // blocking this symbol (or, via the intent gate below, the whole
        // pipeline) forever. An unresolved "pending"/other-status top-up
        // still blocks exactly as before.
        if (topUp && topUp.status !== "verified" &&
            !(topUp.status === "failed" && topUp.manualResolution)) {
          unresolvedMarginTopUpBySymbol.set(normalizeSymbolKey(record.symbol), record);
        }
      }
      // Only a preparation confirmed AFTER a normal management sweep can take
      // this lane. Source exits, fresh global protection, reconciliation and a
      // new account read have already run on this tick. No cached capability
      // verdict or account snapshot authorizes the next operation.
      if (await urgentWorkPending()) return urgentYield();
      if (!reconciliation.expiredMarginPreparation &&
          !reconciliation.reconciledMarginPreparation) {
        const continued = await continuePreparedEntry(
          entryContinuation, assessment, accountState, openPositions, unresolved,
          unresolvedMarginTopUpBySymbol, recordTiming,
        );
        if (continued) return continued;
      }
      let blockedMarginTopUp = null;
      let policyRecoveryIssue = null;
      let verifiedMarketMarkIssue = null;
      const positionBlockedSymbolsThisTick = new Set();
      let sharedAccountSnapshotOffered = false;
      // Entry latency guard. Every exchange call shares one 1.1s gap, so a
      // full management sweep over many open positions can take minutes and
      // let fresh signals expire (10-minute window) before their turn. While
      // a fresh signal waits, manage only a rotating slice of positions per
      // tick; every position is still visited within a few ticks. Exchange
      // stop-losses stay in place, and source exits and latched +5% takes run
      // before this loop on every tick regardless.
      const managedThisTick = await positionsToManageThisTick(openPositions);
      for (const record of managedThisTick) {
        if (await urgentWorkPending()) return urgentYield();
        // Source withdrawals may be enqueued while a multi-position pass is
        // reading/observing an earlier position. Re-check at every boundary
        // so the next unrelated position cannot consume the rest of the tick.
        if (sourceExitsEnabled) {
          let sourceRequests;
          try {
            sourceRequests = await readPendingSourceExitRequests();
          } catch {
            return { kind: "waiting", reason: "source_exit_queue_unavailable" };
          }
          const sourceResult = await processPendingSourceExits(
            sourceRequests, assessment.capabilities, recordTiming,
          );
          if (sourceResult) return sourceResult;
        }
        const symbolKey = normalizeSymbolKey(record.symbol);
        const sourceExitBlock = sourceExitBlockedRows.get(symbolKey);
        const sourceExitReadOnlyQuarantine =
          sourceExitBlock != null &&
          sourceExitBlock.sourceSignalId === record.sourceSignalId &&
          record.snapshot?.protectionDegradation?.version === 1;
        // Keep the queued source decision as an entry/mutation barrier, not
        // an observation barrier. Only this exact reviewed quarantine may
        // reach management, and its lane cannot POST or DELETE.
        if (sourceExitBlockedSymbols.has(symbolKey) &&
            !sourceExitReadOnlyQuarantine) continue;
        if (unresolvedMarginTopUpBySymbol.has(symbolKey)) {
          if (!blockedMarginTopUp) blockedMarginTopUp = record;
          // Keep the addition quarantined, not the native position reads.
          // Unknown ledger snapshots are not promoted to confirmed positions.
          if (record.status !== "open") continue;
        }
        const state = record.snapshot;
        const flatCleanupStage = (state?.patternId === "impulse_buy" || state?.protectedExit) &&
          state.split?.stage === "flat_cleanup_pending";
        let reusableAccountSnapshot = null;
        if (!sharedAccountSnapshotOffered) {
          // Offer this tick's account snapshot at most once. A later position
          // cannot inherit it after earlier management has spent time reading
          // the exchange or possibly crossed a mutation boundary.
          sharedAccountSnapshotOffered = true;
          const snapshotAgeMs = Number(performance.now()) - accountStateReadAt;
          if (state?.patternId === "impulse_buy" &&
              state.version !== undefined &&
              validObject(accountState) &&
              accountState.verified === true &&
              accountState.environment === "vst" &&
              accountState.accountId === state.accountId &&
              Array.isArray(accountState.positions) &&
              Array.isArray(accountState.openOrders) &&
              Number.isFinite(snapshotAgeMs) &&
              snapshotAgeMs >= 0 &&
              snapshotAgeMs <= POSITION_ACCOUNT_SNAPSHOT_MAX_AGE_MS) {
            reusableAccountSnapshot = {
              accountState,
              observedAt: accountStateReadAt,
            };
          }
        }
        const samePersistedVstAccount = state?.environment === "vst" &&
          typeof state.accountId === "string" &&
          state.accountId === assessment.capabilities?.accountId;
        // Scoped to THIS position's own symbol: a stuck intent for a
        // DIFFERENT (identifiable) symbol must never stop this one from
        // being managed. An intent with no identifiable symbol of its own
        // still fails closed for every position (see intentBlocksSymbol).
        const unresolvedForSymbol = unresolved.filter((intent) =>
          intentBlocksSymbol(intent, symbolKey));
        const regularMutationAllowed = Boolean(assessment.mutationCapabilities) &&
          !capabilityUnverifiedSymbol(assessment.capabilities, symbolKey) &&
          unresolvedForSymbol.length === 0 &&
          !unresolvedMarginTopUpBySymbol.has(symbolKey) &&
          state?.protectionDegradation == null &&
          verifiedAccountState &&
          (state?.patternId !== "impulse_buy" ||
            Boolean(assessment.capabilities &&
              Array.isArray(assessment.capabilities.features) &&
              assessment.capabilities.features.includes(
                "impulse_runner_stop_and_partial_close",
              ) &&
              !assessment.capabilities.missingCapabilities?.some?.((item) =>
                item?.capability === "impulse_runner_stop_and_partial_close")));
        const protectedExitAllowed = state?.protectionDegradation?.version === 1 &&
          (state?.patternId !== "impulse_buy" || state?.coreOpen && !state?.runnerOpen) &&
          samePersistedVstAccount &&
          !sourceExitBlockedSymbols.has(symbolKey) &&
          unresolvedForSymbol.length === 0 &&
          !unresolvedMarginTopUpBySymbol.has(symbolKey) &&
          verifiedAccountState && assessmentCanMutateSourceExit(assessment.capabilities);
        const flatCleanupRecoveryAllowed = flatCleanupStage &&
          samePersistedVstAccount &&
          hasFlatSplitCleanupReadTrust(assessment.capabilities) &&
          typeof broker.performIntent === "function" &&
          typeof store.commitVerifiedIntent === "function" &&
          unresolvedForSymbol.length === 0 &&
          verifiedCleanupAccountState;
        const allowActions = !sourceExitReadOnlyQuarantine && (flatCleanupStage
          ? !reconciliation.reconciledPreRunnerClose &&
            samePersistedVstAccount &&
            (regularMutationAllowed || flatCleanupRecoveryAllowed)
          : regularMutationAllowed);
        stageStarted = performance.now();
        diagnosticContext.currentManagedSymbol =
          isCanonicalVstSymbol(record.symbol) ? record.symbol : null;
        let outcome;
        try {
          outcome = await withVstDiagnosticContext({
            stage: "positionManagement",
            operation: "manage_position",
            symbol: record.symbol,
            sourceSignalId: record.sourceSignalId,
          }, () => managePosition(
            record, assessment.capabilities, allowActions, reusableAccountSnapshot,
            protectedExitAllowed,
          ));
          managementFailures.delete(record.sourceSignalId);
        } catch (error) {
          const diagnostic = recordVstDiagnostic(error, {
            stage: "positionManagement", operation: "manage_position",
            symbol: record.symbol, sourceSignalId: record.sourceSignalId,
          });
          // An unclassified exception could be a ledger commit failure, not
          // an exchange read. Never hide that uncertainty behind symbol scoping.
          const reviewedBrokerFailure =
            diagnostic.proofEvidence?.source === "broker_validation";
          const canIsolate = Boolean(symbolKey && samePersistedVstAccount &&
            !exchangeActionAttemptedThisTick && reviewedBrokerFailure);
          // The same local exception on the same position every tick used to
          // stop the WHOLE bot (no entries for hours: IDUSDT, 2026-10-25).
          // After MANAGEMENT_FAILURE_QUARANTINE_REPEATS identical failures with
          // no exchange action attempted, only THIS position is quarantined.
          // Its exchange stop stays, and the +5% take lane still runs for it.
          const repeats = noteManagementFailure(record.sourceSignalId, diagnostic.ref);
          const quarantine = !canIsolate && Boolean(symbolKey && samePersistedVstAccount) &&
            !exchangeActionAttemptedThisTick &&
            repeats >= MANAGEMENT_FAILURE_QUARANTINE_REPEATS;
          if (typeof store.recordGuardEventOnce === "function") {
            await store.recordGuardEventOnce(record.sourceSignalId,
              "vst_position_management_diagnostic", {
                ref: diagnostic.ref,
                ...(diagnostic.symbol ? { symbol: diagnostic.symbol } : {}),
                scope: canIsolate ? "symbol" : "account",
                reason: "position_management_exception", diagnostic,
              });
          }
          // Isolate a read/validation failure only when its persisted account
          // and symbol are known and this tick has not attempted a mutation.
          // Unknown identity or a potentially sent write remains a hard boundary.
          if (!canIsolate && !quarantine) {
            diagnosticContext.failedManagedSymbol =
              diagnosticContext.currentManagedSymbol;
            diagnosticContext.failedManagedSourceSignalId = record.sourceSignalId;
            throw error;
          }
          if (quarantine) await reportManagementQuarantine(record, diagnostic.ref);
          outcome = { kind: "unknown",
            reason: quarantine ? "position_management_exception_repeating" : "position_management_exception",
            sourceSignalId: record.sourceSignalId, symbol: record.symbol,
            operation: "manage_position", diagnosticRef: diagnostic.ref };
        } finally {
          // Do not let a later stage's exception inherit this position's
          // symbol after its management pass has completed.
          diagnosticContext.currentManagedSymbol = null;
        }
        recordTiming("positionManagement", performance.now() - stageStarted);
        if (outcome.kind === "waiting" &&
            (outcome.reason === "verified_market_mark_unavailable" ||
             outcome.reason ===
               "impulse_runner_be_requires_fresh_mark_above_entry")) {
          // A verified local read/mark failure leaves this position untouched,
          // blocks only its canonical symbol for this tick, and is surfaced by
          // the independent position alert timer.
          positionBlockedSymbolsThisTick.add(symbolKey);
          continue;
        }
        // A position stuck "unknown" here is architecturally separate from an
        // unresolved order intent (most of these branches never create or
        // touch any vst_order_intents row at all -- see e.g.
        // "exchange_position_or_leverage_mismatch" and
        // "position_account_or_environment_mismatch" above). It halts THIS
        // position exactly as completely as an unresolved intent does, but
        // no longer halts unrelated symbols. Attaching sourceSignalId/symbol
        // lets reportBlockedIfDue's alert name which position needs manual
        // review, the same way the unresolved-intent case already names its
        // signal.
        if (outcome.kind === "unknown") {
          if (!isCanonicalVstSymbol(record.symbol)) {
            return {
              ...outcome,
              sourceSignalId: record.sourceSignalId,
              scope: "account",
            };
          }
          positionBlockedSymbolsThisTick.add(symbolKey);
          const readIssue = positionIssuesThisTick.get(record.sourceSignalId);
          positionIssuesThisTick.set(record.sourceSignalId, {
            reason: outcome.reason ?? "position_management_unverified",
            sourceSignalId: record.sourceSignalId,
            symbol: record.symbol,
            operation: outcome.operation ?? readIssue?.operation ??
              (outcome.reason === "managed_position_read_unavailable"
                ? "read_position" : undefined),
            ...((outcome.diagnosticRef ?? getVstResultDiagnosticRef(outcome) ??
                readIssue?.diagnosticRef)
              ? { diagnosticRef: outcome.diagnosticRef ??
                getVstResultDiagnosticRef(outcome) ?? readIssue.diagnosticRef } : {}),
          });
          continue;
        }
        const verifiedReadRecovery = !positionIssuesThisTick.has(record.sourceSignalId) &&
          ["observed", "acted", "closed"].includes(outcome.kind);
        if (verifiedReadRecovery &&
            (outcome.kind === "closed" || positionReadRecovery.recovered(record.sourceSignalId))) {
          positionIssueSince.delete(record.sourceSignalId);
          lastPositionIssueAlertAt.delete(record.sourceSignalId);
          lastPositionIssueAlertSignature.delete(record.sourceSignalId);
          positionReadRecovery.forget(record.sourceSignalId);
          positionReadsRecoveredThisTick.add(record.sourceSignalId);
        }
        if (typeof outcome.reason === "string" &&
            (outcome.reason.startsWith("impulse_policy_snapshot_recovery_") ||
             outcome.reason.startsWith("protected_exit_") ||
             outcome.reason === "source_control_read_unavailable" ||
             outcome.reason === "position_policy_state_invalid")) {
          policyRecoveryIssue ??= {
            kind: "waiting",
            reason: outcome.reason,
            sourceSignalId: record.sourceSignalId,
            symbol: record.symbol,
          };
        }
        if (outcome.reason === "verified_market_mark_unavailable") {
          verifiedMarketMarkIssue ??= {
            kind: "waiting",
            reason: outcome.reason,
            sourceSignalId: record.sourceSignalId,
            symbol: record.symbol,
          };
        }
        if (outcome.kind === "acted") return outcome;
      }
      // An unresolved intent that never recorded its own symbol (see
      // intentBlocksSymbol) genuinely could belong to any position or any
      // brand-new candidate, so it still fails the whole pipeline closed
      // immediately -- exactly like before this symbol-scoping existed.
      // An intent that DOES name its own symbol must no longer stop a BRAND
      // NEW signal on a DIFFERENT symbol from opening this tick: the
      // candidate-selection loop below re-checks each candidate's own
      // symbol against `unresolved` and skips only the ones actually
      // blocked by it. reportUnresolvedIntentsIfDue (see runOnce)
      // independently keeps the stuck intent alerted even on ticks where
      // some other symbol's fresh entry is what gets returned below.
      const globallyBlockingIntent = unresolved.find((intent) =>
        !normalizeSymbolKey(intent?.request?.symbol));
      if (globallyBlockingIntent) {
        return {
          kind: "blocked",
          reason: "unresolved_vst_order_intents",
          count: unresolved.length,
          sourceSignalId: globallyBlockingIntent.sourceSignalId,
          symbol: globallyBlockingIntent?.request?.symbol,
          operation: globallyBlockingIntent?.request?.operation,
        };
      }
      if (sourceExitsEnabled) {
        let sourceRequests;
        try {
          sourceRequests = await readPendingSourceExitRequests();
        } catch {
          return { kind: "waiting", reason: "source_exit_queue_unavailable" };
        }
        const sourceResult = await processPendingSourceExits(
          sourceRequests, assessment.capabilities, recordTiming,
        );
        if (sourceResult) return sourceResult;
      }
      if (reconciliation.expiredMarginPreparation) {
        return {
          kind: "rejected",
          reason: "signal_expired_during_margin_mode_preparation",
        };
      }
      if (reconciliation.reconciledMarginPreparation) {
        return { kind: "prepared", reason: "isolated_margin_mode_confirmed" };
      }
      if (!assessment.mutationCapabilities) {
        return {
          kind: "waiting",
          reason: assessment.reason,
          diagnosticReason: assessment.diagnosticReason,
          diagnosticCode: assessment.diagnosticCode,
          ...(assessment.diagnosticMessage
            ? { diagnosticMessage: assessment.diagnosticMessage } : {}),
        };
      }
      if (!verifiedAccountState) {
        return {
          kind: "waiting",
          reason: "account_state_not_verified",
          diagnosticReason: "account_state_unverified",
        };
      }
      // Keyset pages retain opening/planning priority while letting fresh
      // candidates pass unrelated symbol exposure/intents. `unresolved` can
      // be non-empty here now: each candidate is checked against it via
      // intentBlocksSymbol, the same helper managePosition uses above, so a
      // candidate is held only by its own intent (or an unidentifiable one).
      let pending = null;
      const pendingBatch = [];
      const pendingBatchSymbols = new Set();
      let blockedCandidate = null;
      let blockedCandidateByIntent = null;
      let blockedCandidateByMarginTopUp = null;
      const pageApi = typeof store.listPendingCandidatesPage === "function";
      let scanCursor = null;
      let scanPageCount = 0;
      let scanCandidateCount = 0;
      let pendingBatchBoundary = false;
      const scanStarted = performance.now();
      while (true) {
        let page = null;
        let pendingCandidates;
        if (pageApi) {
          page = await store.listPendingCandidatesPage({
            limit: PENDING_CANDIDATE_PAGE_SIZE,
            after: scanCursor,
          });
          const cursorValid = validObject(page?.nextCursor) &&
            Number.isSafeInteger(page.nextCursor.priority) &&
            page.nextCursor.priority >= 0 &&
            page.nextCursor.priority <= 2 &&
            typeof page.nextCursor.receivedAt === "string" &&
            Number.isFinite(Date.parse(page.nextCursor.receivedAt)) &&
            typeof page.nextCursor.sourceSignalId === "string" &&
            page.nextCursor.sourceSignalId.trim() !== "";
          if (!validObject(page) || !Array.isArray(page.rows) ||
              typeof page.hasMore !== "boolean" ||
              page.rows.length > PENDING_CANDIDATE_PAGE_SIZE ||
              (page.rows.length > 0 &&
                (!cursorValid ||
                 page.nextCursor.sourceSignalId !==
                   page.rows.at(-1)?.sourceSignalId)) ||
              (page.rows.length === 0 &&
                (page.hasMore || page.nextCursor !== null))) {
            throw new Error("vst_pending_candidate_page_invalid");
          }
          pendingCandidates = page.rows;
        } else {
          pendingCandidates = typeof store.listPendingCandidates === "function"
            ? await store.listPendingCandidates(PENDING_CANDIDATE_PAGE_SIZE)
            : await store.getPending().then((row) => row ? [row] : []);
        }
        scanPageCount += 1;
        scanCandidateCount += pendingCandidates.length;
        if (!pendingCandidates.length) {
          break;
        }
        for (const candidate of pendingCandidates) {
          if (sourceExitsEnabled) {
            let hasSourceExit = false;
            try {
              hasSourceExit = await store.hasPendingSourceExitRequest(
                candidate.sourceSignalId,
              );
            } catch {
              return { kind: "waiting", reason: "source_exit_queue_unavailable" };
            }
            if (hasSourceExit) {
              let sourceRequests;
              try {
                sourceRequests = await readPendingSourceExitRequests();
              } catch {
                return { kind: "waiting", reason: "source_exit_queue_unavailable" };
              }
              const queued = sourceRequests.find((item) =>
                item.sourceSignalId === candidate.sourceSignalId);
              if (!queued) {
                return { kind: "waiting",
                  reason: "source_exit_queue_changed_during_candidate_scan",
                  sourceSignalId: candidate.sourceSignalId,
                  symbol: candidate.symbol,
                };
              }
              const reason = "source_withdrawn_before_entry";
              await store.setSignalStatus(candidate.sourceSignalId, "rejected", reason);
              await store.recordEvent?.(candidate.sourceSignalId,
                "vst_source_exit_unentered", {
                  reason,
                  sourceExitRequestId: queued.requestId,
                  sourceEvidence: queued.evidence,
                });
              await finishSourceExit(queued.requestId, {
                outcome: "cancelled_unentered",
                detail: { reason, sourceEvidence: queued.evidence },
              });
              continue;
            }
          }
          // An entry may already have been atomically committed while its
          // follow-up margin top-up keeps the signal in "opening". It is no
          // longer a candidate for entry, even though listPendingCandidates
          // still includes it. Re-planning against its own live position would
          // incorrectly turn a verified fill into a new entry error.
          if (openPositions.some((record) =>
            record.sourceSignalId === candidate.sourceSignalId)) {
            continue;
          }
          const candidateSymbolKey = normalizeSymbolKey(candidate.body?.symbol);
          if (positionBlockedSymbolsThisTick.has(candidateSymbolKey)) {
            continue;
          }
          if (sourceExitBlockedSymbols.has(candidateSymbolKey)) {
            continue;
          }
          // A long exchange-read cycle can outlive several queued signals.
          // Retire only untouched, expired pending rows together instead of
          // spending one whole exchange cycle rejecting each old signal ahead
          // of a newer candidate. Never retire in-flight work or a signal
          // with an unresolved intent: either may already have reached BingX.
          if (candidate.status === "pending" &&
              !unresolved.some((intent) =>
                intent.sourceSignalId === candidate.sourceSignalId) &&
              !isFreshSignalAt(candidate.body?.signalAt, Number(clock()))) {
            const reason = "not_a_fresh_approved_v2_long";
            await store.setSignalStatus(candidate.sourceSignalId, "rejected", reason);
            await store.recordEvent?.(candidate.sourceSignalId, "vst_signal_rejected", { reason });
            continue;
          }
          const candidateBlockedByIntent = unresolved.some((intent) =>
            intentBlocksSymbol(intent, candidateSymbolKey));
          if (candidateBlockedByIntent) {
            if (!blockedCandidateByIntent) blockedCandidateByIntent = candidate;
            continue;
          }
          // Same scoping as the intent check above: a symbol with its own
          // unverified margin top-up still blocks a BRAND NEW candidate on
          // that same symbol (its exposure and margin state are unresolved),
          // but must never stop a fresh signal on a different symbol from
          // opening this tick.
          if (unresolvedMarginTopUpBySymbol.has(candidateSymbolKey)) {
            if (!blockedCandidateByMarginTopUp) blockedCandidateByMarginTopUp = candidate;
            continue;
          }
          // Only a durably confirmed, pre-entry preparation is eligible for a
          // batch continuation. Never re-enter a row with an existing entry
          // phase or an unconfirmed/legacy ACTIVE state through the new lane.
          if (candidate.status !== "pending") {
            if (entryBatchSize === 1) {
              pending = candidate;
              break;
            }
            if (!["planning", "opening"].includes(candidate.status)) continue;
            const [entryIntent, marginIntent, leverageIntent] = await Promise.all([
              store.getIntent(candidate.sourceSignalId, "market-entry"),
              store.getIntent(candidate.sourceSignalId, "isolated-margin-mode"),
              store.getIntent(candidate.sourceSignalId, "isolated-leverage-10"),
            ]);
            const confirmedMargin = marginIntent?.state === "reconciled" &&
              hasConfirmedIsolatedMarginPreparation(marginIntent.outcome, PROFILE);
            const confirmedLeverage = leverageIntent?.state === "reconciled" &&
              leverageIntent.request?.operation === "set_isolated_leverage" &&
              leverageIntent.outcome?.verified === true &&
              profileMarginIs(leverageIntent.outcome?.marginMode) &&
              Number(leverageIntent.outcome?.leverage) === PROFILE_LEVERAGE;
            if (entryIntent || !(confirmedMargin || confirmedLeverage)) {
              if (!pendingBatch.length) pending = candidate;
              else pendingBatchBoundary = true;
              break;
            }
            if (pendingBatchSymbols.has(candidateSymbolKey)) continue;
            const candidateHasOpenPosition = openPositions.some((record) =>
              normalizeSymbolKey(record.symbol) === candidateSymbolKey);
            const candidateHasExchangeExposure = accountState.positions.some((row) =>
              normalizeSymbolKey(row?.symbol) === candidateSymbolKey) ||
              accountState.openOrders.some((row) =>
                normalizeSymbolKey(row?.symbol) === candidateSymbolKey);
            if (candidateHasOpenPosition || candidateHasExchangeExposure) {
              if (!blockedCandidate) blockedCandidate = candidate;
              continue;
            }
            pendingBatch.push(candidate);
            pendingBatchSymbols.add(candidateSymbolKey);
            if (pendingBatch.length >= entryBatchSize) break;
            continue;
          }
          if (candidate.status === "pending" && entryBatchSize > 1) {
            if (pendingBatchSymbols.has(candidateSymbolKey)) continue;
            const candidateHasOpenPosition = openPositions.some((record) =>
              normalizeSymbolKey(record.symbol) === candidateSymbolKey);
            const candidateHasExchangeExposure = accountState.positions.some((row) =>
              normalizeSymbolKey(row?.symbol) === candidateSymbolKey) ||
              accountState.openOrders.some((row) =>
                normalizeSymbolKey(row?.symbol) === candidateSymbolKey);
            if (candidateHasOpenPosition || candidateHasExchangeExposure) {
              if (!blockedCandidate) blockedCandidate = candidate;
              continue;
            }
            const existingEntryPhase = await Promise.all([
              store.getIntent(candidate.sourceSignalId, "market-entry"),
              store.getIntent(candidate.sourceSignalId, "isolated-margin-mode"),
              store.getIntent(candidate.sourceSignalId, "isolated-leverage-10"),
            ]);
            if (existingEntryPhase.some(Boolean)) continue;
            pendingBatch.push(candidate);
            pendingBatchSymbols.add(candidateSymbolKey);
            if (pendingBatch.length >= entryBatchSize) break;
            continue;
          }
          const candidateHasOpenPosition = openPositions.some((record) =>
            normalizeSymbolKey(record.symbol) === candidateSymbolKey);
          const candidateHasExchangeExposure = accountState.positions.some((row) =>
            normalizeSymbolKey(row?.symbol) === candidateSymbolKey) ||
            accountState.openOrders.some((row) =>
              normalizeSymbolKey(row?.symbol) === candidateSymbolKey);
          if (!candidateHasOpenPosition && !candidateHasExchangeExposure) {
            pending = candidate;
            break;
          }
          if (!blockedCandidate) blockedCandidate = candidate;
        }
        if (pending) {
          break;
        }
        if (pendingBatchBoundary ||
            pendingBatch.length >= entryBatchSize) break;
        if (!pageApi || !page.hasMore) break;
        scanCursor = page.nextCursor;
      }
      const scanElapsedMs = Math.round(performance.now() - scanStarted);
      recordTiming("pendingCandidateScan", scanElapsedMs);
      if (scanPageCount > PENDING_CANDIDATE_DIAGNOSTIC_PAGE_THRESHOLD) {
        reportLargeCandidateScan({
          pages: scanPageCount,
          candidates: scanCandidateCount,
          elapsedMs: scanElapsedMs,
        });
      }
      if (pendingBatch.length && !pending) {
        stageStarted = performance.now();
        const batchBudget = {
          reservedAvailableVst: 0,
        };
        let headPlanningHintConsumed = false;
        const entryQueueTelemetryWrites = new Map();
        const persistEntryQueueTelemetry = (sourceSignalId, telemetry) => {
          try {
            if (typeof store.recordEntryQueueTelemetry !== "function") return;
            const previous = entryQueueTelemetryWrites.get(sourceSignalId) ??
              Promise.resolve();
            const write = previous.catch(() => {}).then(() =>
              store.recordEntryQueueTelemetry(sourceSignalId, telemetry),
            );
            entryQueueTelemetryWrites.set(sourceSignalId, write.catch(() => {}));
          } catch {}
        };
        try {
          const coordinated = await coordinateVstEntryBatch({
            candidates: pendingBatch,
            maxEntries: entryBatchSize,
            budgetMs: entryBatchBudgetMs,
            wallClock: clock,
            prepare: async (candidate) => {
              const signal = candidate.body;
              const now = Number(clock());
              if (!validObject(signal) ||
                  !isTradablePatternId(signal.patternId) ||
                  signal.confirmationStatus !== "confirmed" ||
                  signal.side !== "buy" || signal.orderType !== "market" ||
                  signal.payload?.rulesVersion !== "bullet-long-exits-v2" ||
                  !isFreshSignalAt(signal.signalAt, now)) {
                return { invalidReason: "not_a_fresh_approved_v2_long" };
              }
              if (!isCanonicalVstSymbol(signal.symbol)) {
                return { invalidReason: "invalid_canonical_vst_symbol" };
              }
              // Read-only cohort hint. Only the queue-head hint may be used;
              // later candidates must obtain fresh quote/balance inputs after
              // earlier durable phases have run.
              return { input: await broker.readPlanningInputs(signal) };
            },
            execute: async (candidate, planningHint, planningError) => {
              if (await urgentWorkPending()) {
                return { ...urgentYield(), batchStop: true };
              }
              if (planningError) {
                return { kind: "waiting", reason: "entry_batch_planning_read_failed",
                  sourceSignalId: candidate.sourceSignalId,
                  symbol: candidate.body?.symbol };
              }
              if (planningHint.invalidReason) {
                const reason = planningHint.invalidReason;
                await store.setSignalStatus(candidate.sourceSignalId, "rejected", reason);
                await store.recordEvent?.(candidate.sourceSignalId,
                  "vst_signal_rejected", { reason });
                return { kind: "rejected", reason };
              }
              // Source-exit commands can arrive while the parallel read-only
              // cohort is being prepared. Recheck the durable queue before
              // every sequential phase and yield immediately if one exists.
              if (sourceExitsEnabled) {
                let sourceRequests;
                try {
                  sourceRequests = await readPendingSourceExitRequests();
                } catch {
                  return { kind: "waiting",
                    reason: "source_exit_queue_unavailable",
                    batchStop: true };
                }
                if (sourceRequests.length) {
                  return { kind: "waiting",
                    reason: "source_exit_priority_before_entry_batch_phase",
                    batchStop: true };
                }
              }
              if (!isFreshSignalAt(candidate.body?.signalAt, Number(clock()))) {
                const reason = "not_a_fresh_approved_v2_long";
                await store.setSignalStatus(candidate.sourceSignalId, "rejected", reason);
                await store.recordEvent?.(candidate.sourceSignalId,
                  "vst_signal_rejected", { reason });
                return { kind: "rejected", reason };
              }
              const phaseAssessment = await inspectCapabilities(broker, recordTiming);
              if (!phaseAssessment.mutationCapabilities ||
                  phaseAssessment.capabilities?.accountId !==
                    assessment.capabilities.accountId) {
                return {
                  kind: "waiting",
                  reason: phaseAssessment.reason ??
                    "vst_entry_batch_global_protection_not_verified",
                  batchStop: true,
                };
              }
              let phaseAccountState;
              try {
                phaseAccountState = await broker.readAccountState();
              } catch {
                return { kind: "waiting",
                  reason: "vst_entry_batch_global_account_read_failed",
                  batchStop: true };
              }
              if (!validObject(phaseAccountState) ||
                  phaseAccountState.verified !== true ||
                  phaseAccountState.environment !== "vst" ||
                  phaseAccountState.accountId !== phaseAssessment.capabilities.accountId ||
                  !Array.isArray(phaseAccountState.positions) ||
                  !Array.isArray(phaseAccountState.openOrders)) {
                return { kind: "waiting",
                  reason: "vst_entry_batch_global_protection_not_verified",
                  batchStop: true };
              }
              let planningInput = headPlanningHintConsumed
                ? null : planningHint.input;
              headPlanningHintConsumed = true;
              if (planningInput) {
                const observedAt = Number(planningInput.quote?.observedAtMs);
                const nowMs = Number(clock());
                const maxQuoteAgeMs = sizingLimits.maxQuoteAgeMs;
                if (!Number.isSafeInteger(observedAt) ||
                    !Number.isSafeInteger(nowMs) ||
                    observedAt > nowMs ||
                    !Number.isSafeInteger(maxQuoteAgeMs) ||
                    maxQuoteAgeMs <= 0 ||
                    nowMs - observedAt > maxQuoteAgeMs) {
                  planningInput = await broker.readPlanningInputs(candidate.body);
                }
              }
              const result = await openSignal(
                candidate, phaseAssessment.mutationCapabilities,
                phaseAssessment.capabilities, planningInput, true, batchBudget,
              );
              // The normal management sweep has already run. Hand only the
              // current priority head's confirmed preparation to the existing
              // bounded, freshly checked continuation lane. This is a hint,
              // not reuse of a quote, account snapshot or capability verdict.
              const head = await store.getPending();
              if (head?.sourceSignalId === candidate.sourceSignalId) {
                rememberPreparedEntry(candidate, result,
                  phaseAssessment.capabilities.accountId);
              }
              if (result.kind === "waiting" || result.kind === "unknown" ||
                  result.kind === "error" || result.kind === "rejected" ||
                  result.kind === "top_up_pending" ||
                  candidate.body?.patternId === "impulse_buy") {
                // Unsafe/ambiguous work and newly opened exposure needing
                // follow-up protection end the cohort before another entry.
                return { ...result, batchStop: true };
              }
              return result;
            },
            onPreparationStart: ({ sourceSignalId }) => {
              persistEntryQueueTelemetry(sourceSignalId, { event: "preparing" });
            },
            onPreparationComplete: (preparation) => {
              persistEntryQueueTelemetry(preparation.sourceSignalId, {
                event: "prepared",
                prepareMs: preparation.prepareMs,
                prepared: preparation.prepared,
              });
            },
            onDeferred: (deferred) => {
              persistEntryQueueTelemetry(deferred.sourceSignalId, {
                event: "deferred",
                prepareMs: deferred.prepareMs,
                deferReason: deferred.deferReason,
                prepared: deferred.prepared,
              });
            },
            onTiming: async (timing) => {
              recordTiming("entryBatchPreparation", timing.prepareMs);
              recordTiming("entryBatchExecution", timing.executeMs);
              persistEntryQueueTelemetry(timing.sourceSignalId, {
                event: "timing",
                prepareMs: timing.prepareMs,
                executeMs: timing.executeMs,
                queueWaitMs: timing.queueWaitMs,
                prepared: timing.prepared,
                deferReason: timing.deferReason,
              });
              try {
                await onTiming?.({
                  kind: "entry_batch_entry",
                  sourceSignalId: timing.sourceSignalId,
                  queueWaitMs: timing.queueWaitMs,
                  prepareMs: timing.prepareMs,
                  executeMs: timing.executeMs,
                  prepared: timing.prepared,
                });
              } catch {}
            },
          });
          recordTiming("entryBatch", coordinated.elapsedMs);
          const lastResult = coordinated.results.at(-1);
          if (lastResult?.error?.result) return lastResult.error.result;
          if (lastResult) {
            const visibleResult = { ...lastResult };
            delete visibleResult.batchStop;
            return { ...visibleResult, entryBatch: {
              processed: coordinated.processed,
              deferred: coordinated.deferred,
            } };
          }
          return { kind: "waiting", reason: "entry_batch_budget_exhausted",
            entryBatch: { processed: 0, deferred: coordinated.deferred } };
        } finally {
          recordTiming("entryPreparation", performance.now() - stageStarted);
        }
      }
      if (pending) {
        stageStarted = performance.now();
        try {
          const result = await openSignal(
            pending,
            assessment.mutationCapabilities,
            assessment.capabilities,
          );
          rememberPreparedEntry(pending, result, assessment.capabilities.accountId);
          return result;
        } finally {
          recordTiming("entryPreparation", performance.now() - stageStarted);
        }
      }
      const historicalErrorRepair = await reconcileOneHistoricalErrorClose(
        accountState, assessment.capabilities,
      );
      if (historicalErrorRepair) return historicalErrorRepair;
      // No workable candidate opened this tick -- either none is queued, or
      // every queued candidate's own symbol is blocked (by an unresolved
      // intent, or by preexisting exposure). An unresolved intent anywhere
      // still needs manual attention and must keep surfacing even when no
      // new signal happens to be waiting behind it, or every currently
      // queued symbol happens to be free elsewhere.
      if (unresolved.length) {
        const stuck = unresolved[0];
        return {
          kind: "blocked",
          reason: "unresolved_vst_order_intents",
          count: unresolved.length,
          sourceSignalId: stuck?.sourceSignalId,
          symbol: stuck?.request?.symbol,
          operation: stuck?.request?.operation,
          entryNotSubmitted: stuck?.request?.operation === "entry" &&
            stuck?.outcome?.definiteRejection === true &&
            Boolean(stuck?.outcome?.preSignReason),
        };
      }
      if (blockedCandidateByIntent) {
        return {
          kind: "blocked",
          reason: "unresolved_vst_order_intents",
          sourceSignalId: blockedCandidateByIntent.sourceSignalId,
          symbol: blockedCandidateByIntent.body?.symbol,
        };
      }
      // Mirrors the intent case just above: report the margin top-up even
      // though it never stopped a DIFFERENT symbol's candidate from opening.
      // `blockedMarginTopUp` (an existing open position) takes priority when
      // both exist since it names a concrete signal already in the ledger;
      // `blockedCandidateByMarginTopUp` covers the case where the stuck
      // position never even surfaced a fresh candidate of its own this tick.
      if (blockedMarginTopUp || blockedCandidateByMarginTopUp) {
        const stuck = blockedMarginTopUp;
        return {
          kind: "blocked",
          reason: "vst_margin_top_up_requires_verified_reconciliation",
          sourceSignalId: stuck?.sourceSignalId ?? blockedCandidateByMarginTopUp?.sourceSignalId,
          symbol: stuck?.symbol ?? blockedCandidateByMarginTopUp?.body?.symbol,
          operation: "margin_top_up",
        };
      }
      if (blockedCandidate) {
        const reason = "preexisting_exchange_position_or_order";
        return {
          kind: "blocked",
          reason,
          sourceSignalId: blockedCandidate.sourceSignalId,
          symbol: blockedCandidate.body?.symbol,
        };
      }
      if (sourceExitBlockedRows.size) {
        return sourceExitBlockedRows.values().next().value;
      }
      if (positionIssuesThisTick.size) {
        const issue = positionIssuesThisTick.values().next().value;
        return {
          kind: "unknown",
          reason: issue.reason,
          sourceSignalId: issue.sourceSignalId,
          symbol: issue.symbol,
          operation: issue.operation,
          scope: "symbol",
        };
      }
      if (verifiedMarketMarkIssue) return verifiedMarketMarkIssue;
      if (policyRecoveryIssue) return policyRecoveryIssue;
      return { kind: "idle" };
    });
  }

  // Shared by closeErrorPositionNow (owner just clicked the button) AND
  // reconcileOne (a later passive tick revisiting an intent the first
  // attempt could not verify). Both must commit through the exact same
  // store.resolvePositionAsClosed call -- the ONLY write path that stamps
  // manualResolution.outcome === "closed" -- so a transient verification
  // failure can never silently fall through to the generic
  // upsertPosition/setSignalStatus path used by the worker's own automated
  // closes, which lacks that provenance marker entirely.
  async function reconcileManualReviewCloseNow(intent, {
    resolvePosition = (signalId, args) => store.resolvePositionAsClosed(signalId, args),
    closeNote = "Закрыто ботом автоматически (кнопка «Закрыть сейчас»): рыночная заявка выставлена и подтверждена ботом по биржевым данным.",
  } = {}) {
    const { clientOrderId, phase, request, sourceSignalId } = intent;
    let evidence;
    try {
      evidence = await broker.reconcileIntent({ clientOrderId, phase, request });
    } catch {
      evidence = { verified: false, status: "unknown" };
    }
    try {
      checkActionEvidence(request, evidence, PROFILE);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "exchange_action_state_not_verified";
      await store.markIntent(clientOrderId, "unknown", {
        exchangeOrderId: evidence?.exchangeOrderId ?? null,
        outcome: { reason },
      });
      return { kind: "unverified", reason };
    }

    // resolvePositionAsClosed requires a single owner-shaped fee object
    // ({asset, amount}); a real MARKET close order settles in exactly one
    // fee currency, so anything else means the fill cannot be trusted.
    const fees = evidence.fill?.fees;
    if (!Array.isArray(fees) || fees.length !== 1 ||
        typeof fees[0]?.currency !== "string" ||
        !Number.isFinite(Number(fees[0]?.amount))) {
      const reason = "close_fill_fee_currency_ambiguous";
      await store.markIntent(clientOrderId, "unknown", {
        exchangeOrderId: evidence.exchangeOrderId ?? null,
        outcome: { reason },
      });
      return { kind: "unverified", reason };
    }

    let resolved;
    try {
      resolved = await resolvePosition(sourceSignalId, {
        fill: {
          price: evidence.fill.price,
          quantity: evidence.fill.quantity,
          at: evidence.fill.at,
          exchangeOrderId: evidence.exchangeOrderId,
          fee: { asset: fees[0].currency, amount: Number(fees[0].amount) },
        },
        resolvedBy: request.resolvedBy ?? null,
        note: closeNote,
        verifiedExchangeFill: true,
      });
    } catch (error) {
      // The exchange fill is real and already verified above; a ledger write
      // failure here must not read as "nothing happened", and must not be
      // marked any terminal state either -- leaving the intent exactly as it
      // was (never "unknown", never "reconciled") means both a fresh owner
      // click and the next passive tick retry ONLY the already-verified
      // ledger write, never a second live close attempt against an
      // already-flat exchange position.
      return {
        kind: "resolve_failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await store.markIntent(clientOrderId, "reconciled", {
      exchangeOrderId: evidence.exchangeOrderId ?? null,
      outcome: {
        status: "filled", verified: true, operation: "close_leg",
        fill: closeFillSnapshot(evidence),
      },
    });
    return { kind: "reconciled", position: resolved };
  }

  async function hasUnresolvedPreRunnerSplitClose(sourceSignalId) {
    const unresolved = await store.listUnresolvedIntents();
    return Array.isArray(unresolved) && unresolved.some((intent) =>
      intent?.sourceSignalId === sourceSignalId &&
      intent?.request?.operation === "close_pre_runner_split");
  }

  // Owner-triggered recovery action from the manual VST review screen: one
  // click instead of typing seven exchange facts by hand. Reuses the exact
  // same submit-and-verify machinery as an ordinary automated close
  // (reserveAndPerform + broker.reconcileIntent + checkActionEvidence), so a
  // bad read or an unverifiable fill can never fabricate a close -- it only
  // ever reaches store.resolvePositionAsClosed with a real, exchange-
  // confirmed fill, through the very same guarded write path a human-typed
  // resolution uses. If BingX has no matching open position at all, this
  // makes no changes and reports "already_flat": the bot has no reliable way
  // to discover facts about a close it did not itself place, so that case
  // still falls back to the manual form. A verification failure never dead-
  // ends here either: reconcileOne's passive tick reconciles this exact same
  // intent through reconcileManualReviewCloseNow too, so the pipeline-wide
  // unresolved-intent block resolves on its own once evidence clears, not
  // only when the owner happens to click the button again.
  async function closeErrorPositionNow(sourceSignalId, { resolvedBy }) {
    return store.withLeaderLock(async () => {
      if (await hasUnresolvedPreRunnerSplitClose(sourceSignalId)) {
        return { kind: "blocked", reason: "legacy_pre_runner_close_review_required" };
      }
      const assessment = await inspectCapabilities(broker);
      if (!assessment.mutationCapabilities) {
        return {
          kind: "blocked",
          reason: assessment.reason ?? "verified_mutation_capabilities_unavailable",
        };
      }
      const capabilities = assessment.mutationCapabilities;
      const errorPositions = await store.listErrorPositions();
      const record = errorPositions.find((row) => row.sourceSignalId === sourceSignalId);
      if (!record) return { kind: "not_found" };
      const state = record.snapshot ?? {};
      if (state.environment !== "vst" || state.accountId !== capabilities.accountId) {
        return { kind: "blocked", reason: "position_account_or_environment_mismatch" };
      }

      const phase = "manual_review_close_now";
      const clientOrderId = orderId(sourceSignalId, phase);
      let request;
      // A prior attempt for this exact recovery action already exists: never
      // rebuild the request from a fresh exchange read on retry -- the live
      // quantity or clock may have moved on since, and reconciliation must
      // always check the SAME facts that were actually submitted, exactly
      // like the periodic reconciliation sweep does for every other intent.
      const existingIntent = await store.getIntent(sourceSignalId, phase);
      if (existingIntent) {
        request = existingIntent.request;
      } else {
        let exchangePosition;
        try {
          exchangePosition = await broker.readPosition(record.symbol, {});
        } catch {
          return { kind: "read_unavailable" };
        }
        if (!validObject(exchangePosition) || exchangePosition.verified !== true ||
            !(Number(exchangePosition.quantity) > 0)) {
          return { kind: "already_flat" };
        }
        request = {
          operation: "close_leg",
          sourceSignalId,
          symbol: record.symbol,
          accountId: capabilities.accountId,
          environment: "vst",
          quantity: String(exchangePosition.quantity),
          reason: "owner_triggered_manual_review_close_now",
          stopStartedAt: Number(clock()),
          previousQuantity: Number(exchangePosition.quantity),
          nextPolicy: { status: "closed", remainingQty: 0 },
          nextPosition: { ...state, status: "closed", remainingQty: 0 },
          // Persisted on the intent itself (not just passed at call time):
          // a later passive tick reconciling this same intent has no HTTP
          // request to read an owner id from, so the attribution captured
          // at click time must travel with the reserved request.
          resolvedBy: resolvedBy ?? null,
        };
        const submitted = await reserveAndPerform(sourceSignalId, phase, request);
        if (submitted.kind === "existing") {
          request = submitted.intent.request;
        } else if (submitted.kind === "unknown") {
          return { kind: "pending_reconciliation" };
        }
      }

      const outcome = await reconcileManualReviewCloseNow({
        clientOrderId, phase, request, sourceSignalId,
      });
      if (outcome.kind === "reconciled") return { kind: "closed", position: outcome.position };
      if (outcome.kind === "unverified") return { kind: "unverified", reason: outcome.reason };
      return { kind: "closed_but_unrecorded", error: outcome.error };
    });
  }

  // Resolve the owner-entered fallback form only after a new, complete,
  // read-only account snapshot proves the exact stored VST account/symbol is
  // flat and has no surviving orders. This never sends or cancels orders.
  async function resolveOwnerAttestedPositionClosed(sourceSignalId, {
    fill, resolvedBy, note = null,
  }) {
    return store.withLeaderLock(async () => {
      if (await hasUnresolvedPreRunnerSplitClose(sourceSignalId)) {
        return {
          kind: "not_reviewable",
          reason: "legacy_pre_runner_close_review_required",
        };
      }
      const record = await store.getPosition(sourceSignalId);
      if (!record) return { kind: "not_found" };
      const snapshot = validObject(record.snapshot) ? record.snapshot : null;
      if (record.status === "closed" &&
          snapshot?.manualResolution?.outcome === "closed" &&
          snapshot?.manualResolution?.provenance === "owner_attested" &&
          snapshot?.manualResolution?.exchangeFlatCheck?.verified === true) {
        return { kind: "already_closed", position: record };
      }
      if (record.status !== "error") return { kind: "not_reviewable" };
      if (!snapshot || snapshot.environment !== "vst" ||
          typeof snapshot.accountId !== "string" || snapshot.accountId.length === 0 ||
          snapshot.symbol !== record.symbol ||
          typeof broker.readAccountState !== "function") {
        return { kind: "account_mismatch" };
      }

      const expectedSymbol = normalizeSymbolKey(record.symbol);
      if (!expectedSymbol) return { kind: "account_mismatch" };
      let accountState;
      try {
        accountState = await broker.readAccountState();
      } catch {
        return { kind: "exchange_unavailable" };
      }
      if (!validObject(accountState) || accountState.verified !== true ||
          !Array.isArray(accountState.positions) ||
          !Array.isArray(accountState.openOrders)) {
        return { kind: "exchange_unverified" };
      }
      if (accountState.environment !== "vst" ||
          accountState.accountId !== snapshot.accountId) {
        return { kind: "account_mismatch" };
      }

      for (const row of accountState.positions) {
        const symbol = normalizeSymbolKey(row?.symbol);
        const quantity = Number(row?.positionAmt ?? row?.quantity);
        if (!symbol || !Number.isFinite(quantity)) return { kind: "exchange_unverified" };
        if (symbol === expectedSymbol && quantity !== 0) {
          return { kind: "position_open" };
        }
      }
      for (const row of accountState.openOrders) {
        const symbol = normalizeSymbolKey(row?.symbol);
        if (!symbol) return { kind: "exchange_unverified" };
        if (symbol === expectedSymbol) return { kind: "orders_open" };
      }

      const observedAtMs = Number(clock());
      if (!Number.isSafeInteger(observedAtMs) || observedAtMs <= 0) {
        return { kind: "exchange_unverified" };
      }
      try {
        const position = await store.resolvePositionAsClosed(sourceSignalId, {
          fill, resolvedBy, note,
          exchangeFlatCheck: {
            verified: true,
            environment: "vst",
            accountId: accountState.accountId,
            symbol: record.symbol,
            positionQuantity: "0",
            openOrderCount: 0,
            observedAt: new Date(observedAtMs).toISOString(),
          },
        });
        return { kind: "closed", position };
      } catch (error) {
        if (error instanceof Error &&
            error.message === "vst_position_not_in_error_status") {
          const current = await store.getPosition(sourceSignalId);
          if (current?.status === "closed" &&
              current.snapshot?.manualResolution?.provenance === "owner_attested" &&
              current.snapshot?.manualResolution?.exchangeFlatCheck?.verified === true) {
            return { kind: "already_closed", position: current };
          }
          return { kind: "not_reviewable" };
        }
        throw error;
      }
    });
  }

  // Owner-triggered recovery action from the manual VST review screen's
  // "Всё ещё открыта" path: one click reads the live BingX position instead
  // of the owner typing the remaining quantity by hand. Unlike
  // closeErrorPositionNow this never mutates the exchange at all -- it only
  // ever forwards a fresh, verified exchange read into the exact same
  // store.resolvePositionAsStillOpen write path the manual form itself uses,
  // so a bad or ambiguous read can never re-arm management with a fabricated
  // quantity. If BingX shows no open position for this symbol, this makes no
  // changes and reports "already_flat": a genuinely flat position belongs in
  // the "Закрыта на BingX" flow, never guessed here as "still open". A read
  // that throws (network failure, or broker.readPosition's own ambiguous-
  // state guard -- e.g. two matching rows, an unverified Hedge-Mode side)
  // reports "read_unavailable" so the manual quantity form remains the
  // fallback. Gated on the exact same verified mutation-capability bar as
  // closeErrorPositionNow (not merely a plain read) so a broker whose
  // exchange access is otherwise degraded or unverified can never be
  // trusted for this either.
  async function confirmPositionStillOpenNow(sourceSignalId, { resolvedBy }) {
    return store.withLeaderLock(async () => {
      if (await hasUnresolvedPreRunnerSplitClose(sourceSignalId)) {
        return {
          kind: "not_reviewable",
          reason: "legacy_pre_runner_close_review_required",
        };
      }
      const assessment = await inspectCapabilities(broker);
      if (!assessment.mutationCapabilities) {
        return {
          kind: "blocked",
          reason: assessment.reason ?? "verified_mutation_capabilities_unavailable",
        };
      }
      const capabilities = assessment.mutationCapabilities;
      const errorPositions = await store.listErrorPositions();
      const record = errorPositions.find((row) => row.sourceSignalId === sourceSignalId);
      if (!record) return { kind: "not_found" };
      const state = record.snapshot ?? {};
      if (state.environment !== "vst" || state.accountId !== capabilities.accountId) {
        return { kind: "blocked", reason: "position_account_or_environment_mismatch" };
      }

      let exchangePosition;
      try {
        exchangePosition = await broker.readPosition(record.symbol, {});
      } catch {
        return { kind: "read_unavailable" };
      }
      if (!validObject(exchangePosition) || exchangePosition.verified !== true) {
        return { kind: "read_unavailable" };
      }
      if (!(Number(exchangePosition.quantity) > 0)) {
        return { kind: "already_flat" };
      }
      // A same-symbol open position is not proof it is the SAME position
      // that got stuck: if the original trade closed outside the bot and an
      // unrelated position later opened on this symbol, blindly confirming
      // "still open" would re-arm management against the wrong trade using
      // the wrong quantity. Require the exchange's positionId to match the
      // one this ledger row was actually stuck on, exactly like every other
      // exchange-identity check in this file. A record that never captured a
      // positionId (e.g. entry verification itself was abandoned before any
      // fill was confirmed) has nothing to verify against, so it is treated
      // the same as a mismatch: decline the automatic path rather than
      // guess -- the manual quantity form remains available as a fallback.
      if (typeof state.exchangePositionId !== "string" || state.exchangePositionId.length === 0 ||
          exchangePosition.positionId !== state.exchangePositionId) {
        return { kind: "blocked", reason: "position_identity_not_verified" };
      }

      try {
        const resolved = await store.resolvePositionAsStillOpen(sourceSignalId, {
          remainingQty: String(exchangePosition.quantity),
          resolvedBy,
          note: "Подтверждено ботом автоматически по данным BingX (кнопка «Всё ещё открыта»): количество считано с биржи без участия оператора.",
        });
        return { kind: "confirmed_open", position: resolved };
      } catch (error) {
        // The read succeeded and never touched the exchange either way, so a
        // ledger write failure here is always safe to retry: nothing was
        // submitted anywhere, and a fresh retry re-reads the position rather
        // than reusing a stale quantity.
        return {
          kind: "resolve_failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }

  // Route-triggered recovery action for the "Не добавлена маржа" manual
  // review path: the owner claims they checked BingX and the margin top-up
  // was NOT added, but this never accepts that claim alone. A fresh,
  // read-only BingX check requires complete margin history from the original
  // intent timestamp, the unchanged entry-margin baseline, and the original
  // protective stop on the same identified position -- only a corroborated
  // claim ever reaches
  // store.resolveMarginTopUpKeepOpen. This mirrors the anti-fabrication
  // discipline of every other VST manual-resolution path: a click is not
  // evidence by itself, and a mismatch is surfaced rather than silently
  // trusted. Never submits an exchange order either way.
  async function verifyMarginTopUpNotAddedAndResolve(sourceSignalId, { resolvedBy, note = null }) {
    return store.withLeaderLock(async () => {
      const assessment = await inspectCapabilities(broker);
      if (!assessment.mutationCapabilities) {
        return {
          kind: "blocked",
          reason: assessment.reason ?? "verified_mutation_capabilities_unavailable",
        };
      }
      const capabilities = assessment.mutationCapabilities;
      const pending = await store.listMarginTopUpPendingPositions();
      const record = pending.find((row) => row.sourceSignalId === sourceSignalId);
      if (!record) return { kind: "not_found" };
      const state = record.snapshot ?? {};
      if (state.environment !== "vst" || state.accountId !== capabilities.accountId) {
        return { kind: "blocked", reason: "position_account_or_environment_mismatch" };
      }
      const marginTopUp = state.marginTopUp;
      const expectedPositionId = state.exchangePositionId;
      if (!validObject(marginTopUp) || marginTopUp.status !== "pending" ||
          !Number.isFinite(Number(marginTopUp.expectedIsolatedMarginBefore)) ||
          Number(marginTopUp.expectedIsolatedMarginBefore) <= 0 ||
          !Number.isFinite(Number(marginTopUp.amount)) || Number(marginTopUp.amount) <= 0 ||
          typeof expectedPositionId !== "string" || expectedPositionId.trim() === "") {
        return { kind: "blocked", reason: "margin_top_up_marker_not_verifiable" };
      }

      let topUpIntent;
      try {
        topUpIntent = typeof store.getIntent === "function"
          ? await store.getIntent(sourceSignalId, "margin-top-up")
          : null;
      } catch {
        return { kind: "read_unavailable" };
      }
      const request = topUpIntent?.request;
      if (!validObject(request) || request.operation !== "margin_top_up" ||
          request.environment !== "vst" || request.accountId !== capabilities.accountId ||
          request.symbol !== record.symbol || request.positionId !== expectedPositionId ||
          request.stopOrderId !== marginTopUp.stopOrderId ||
          Number(request.amount) !== Number(marginTopUp.amount) ||
          Number(request.approvedTopUpMargin) !== Number(marginTopUp.amount) ||
          Number(request.expectedIsolatedMarginBefore) !==
            Number(marginTopUp.expectedIsolatedMarginBefore) ||
          !Number.isFinite(Number(request.intentCreatedAt)) ||
          Number(request.intentCreatedAt) <= 0) {
        return { kind: "blocked", reason: "margin_top_up_intent_not_verifiable" };
      }
      if (typeof broker.verifyMarginTopUpNotAdded !== "function") {
        return { kind: "read_unavailable" };
      }
      let verification;
      try {
        verification = await broker.verifyMarginTopUpNotAdded(request);
      } catch {
        return { kind: "read_unavailable" };
      }
      if (!validObject(verification) || verification.verified !== true ||
          verification.status !== "not_added" ||
          verification.positionId !== expectedPositionId ||
          verification.symbol !== record.symbol ||
          verification.protectiveStop?.orderId !== marginTopUp.stopOrderId ||
          verification.protectiveStop?.status !== "NEW" ||
          verification.protectiveStop?.workingType !== "MARK_PRICE" ||
          verification.safe !== true) {
        if (verification?.status === "addition_found") {
          return {
            kind: "mismatch_margin_was_added",
            additions: verification.additions ?? null,
          };
        }
        return { kind: "history_or_protection_unverified" };
      }
      try {
        const resolved = await store.resolveMarginTopUpKeepOpen(sourceSignalId, { resolvedBy, note });
        return { kind: "resolved", position: resolved };
      } catch (error) {
        return {
          kind: "resolve_failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }

  // Route-triggered, read-only companion to verifyMarginTopUpNotAddedAndResolve:
  // surfaces a live margin reading only after complete history proves there
  // was no top-up and the original stop/liquidation buffer are still safe.
  // An unchanged initialMargin alone is never shown as proof. Never writes to
  // the ledger and never requires the leader lock -- a plain read
  // cannot race a concurrent tick in any way that matters, since nothing
  // here is a decision.
  async function readMarginTopUpMarginNow(sourceSignalId) {
    const assessment = await inspectCapabilities(broker);
    if (!assessment.mutationCapabilities) {
      return {
        kind: "blocked",
        reason: assessment.reason ?? "verified_mutation_capabilities_unavailable",
      };
    }
    const capabilities = assessment.mutationCapabilities;
    const pending = await store.listMarginTopUpPendingPositions();
    const record = pending.find((row) => row.sourceSignalId === sourceSignalId);
    if (!record) return { kind: "not_found" };
    const state = record.snapshot ?? {};
    if (state.environment !== "vst" || state.accountId !== capabilities.accountId) {
      return { kind: "blocked", reason: "position_account_or_environment_mismatch" };
    }
    const marginTopUp = state.marginTopUp;
    const expectedPositionId = state.exchangePositionId;
    if (!validObject(marginTopUp) || marginTopUp.status !== "pending" ||
        !Number.isFinite(Number(marginTopUp.expectedIsolatedMarginBefore)) ||
        Number(marginTopUp.expectedIsolatedMarginBefore) <= 0 ||
        !Number.isFinite(Number(marginTopUp.amount)) || Number(marginTopUp.amount) <= 0 ||
        typeof expectedPositionId !== "string" || expectedPositionId.trim() === "") {
      return { kind: "blocked", reason: "margin_top_up_marker_not_verifiable" };
    }
    let topUpIntent;
    try {
      topUpIntent = typeof store.getIntent === "function"
        ? await store.getIntent(sourceSignalId, "margin-top-up")
        : null;
    } catch {
      return { kind: "read_unavailable" };
    }
    const request = topUpIntent?.request;
    if (!validObject(request) || request.operation !== "margin_top_up" ||
        request.environment !== "vst" || request.accountId !== capabilities.accountId ||
        request.symbol !== record.symbol || request.positionId !== expectedPositionId ||
        request.stopOrderId !== marginTopUp.stopOrderId ||
        Number(request.amount) !== Number(marginTopUp.amount) ||
        Number(request.approvedTopUpMargin) !== Number(marginTopUp.amount) ||
        Number(request.expectedIsolatedMarginBefore) !==
          Number(marginTopUp.expectedIsolatedMarginBefore) ||
        !Number.isFinite(Number(request.intentCreatedAt)) ||
        Number(request.intentCreatedAt) <= 0) {
      return { kind: "history_or_protection_unverified" };
    }
    if (typeof broker.verifyMarginTopUpNotAdded !== "function") {
      return { kind: "read_unavailable" };
    }
    let verification;
    try {
      verification = await broker.verifyMarginTopUpNotAdded(request);
    } catch {
      return { kind: "read_unavailable" };
    }
    if (!validObject(verification) || verification.verified !== true ||
        verification.status !== "not_added" ||
        verification.safe !== true ||
        verification.positionId !== expectedPositionId ||
        verification.symbol !== record.symbol ||
        verification.protectiveStop?.orderId !== marginTopUp.stopOrderId ||
        verification.protectiveStop?.status !== "NEW" ||
        verification.protectiveStop?.workingType !== "MARK_PRICE") {
      return { kind: "history_or_protection_unverified" };
    }
    const before = Number(marginTopUp.expectedIsolatedMarginBefore);
    const amount = Number(marginTopUp.amount);
    const after = before + amount;
    if (!Number.isFinite(Number(verification.isolatedMargin))) return { kind: "read_unavailable" };
    return {
      kind: "ok",
      symbol: record.symbol,
      isolatedMargin: verification.isolatedMargin,
      expectedIsolatedMarginBefore: marginTopUp.expectedIsolatedMarginBefore,
      expectedIsolatedMarginAfter: String(after),
      observedAt: new Date(clock()).toISOString(),
    };
  }

  // Owner-triggered recovery action from the manual VST review screen's
  // margin-top-up-pending card: the owner would rather close the position
  // than confirm "margin not added, keep open" (verifyMarginTopUpNotAddedAndResolve
  // above). Reuses the exact same submit-and-verify machinery as
  // closeErrorPositionNow -- reserveAndPerform + broker.reconcileIntent +
  // checkActionEvidence -- so a bad read or an unverifiable fill can never
  // fabricate a close. The only difference from closeErrorPositionNow is
  // WHICH positions are eligible (listMarginTopUpPendingPositions, since
  // this position's ledger status never left "open") and which store write
  // path records the result (resolveMarginTopUpPositionAsClosed, which also
  // settles the stuck margin-top-up intent so the pipeline-wide block
  // clears). Uses its own phase name so this recovery action's intent never
  // collides with a same-signal closeErrorPositionNow attempt. If BingX has
  // no matching open position at all, this makes no changes and reports
  // "already_flat": the manual "Закрыта на BingX" form remains the fallback.
  async function closeMarginTopUpPositionNow(sourceSignalId, { resolvedBy }) {
    return store.withLeaderLock(async () => {
      const assessment = await inspectCapabilities(broker);
      if (!assessment.mutationCapabilities) {
        return {
          kind: "blocked",
          reason: assessment.reason ?? "verified_mutation_capabilities_unavailable",
        };
      }
      const capabilities = assessment.mutationCapabilities;
      const pending = await store.listMarginTopUpPendingPositions();
      const record = pending.find((row) => row.sourceSignalId === sourceSignalId);
      if (!record) return { kind: "not_found" };
      const state = record.snapshot ?? {};
      if (state.environment !== "vst" || state.accountId !== capabilities.accountId) {
        return { kind: "blocked", reason: "position_account_or_environment_mismatch" };
      }

      const phase = "manual_review_margin_top_up_close_now";
      const clientOrderId = orderId(sourceSignalId, phase);
      let request;
      // Same replay discipline as closeErrorPositionNow: never rebuild the
      // request from a fresh exchange read on retry.
      const existingIntent = await store.getIntent(sourceSignalId, phase);
      if (existingIntent) {
        request = existingIntent.request;
      } else {
        let exchangePosition;
        try {
          exchangePosition = await broker.readPosition(record.symbol, {});
        } catch {
          return { kind: "read_unavailable" };
        }
        if (!validObject(exchangePosition) || exchangePosition.verified !== true ||
            !(Number(exchangePosition.quantity) > 0)) {
          return { kind: "already_flat" };
        }
        // A same-symbol open position is not proof it is the SAME position
        // this ledger row got stuck on: if the original trade closed outside
        // the bot and an unrelated position later opened on this symbol,
        // blindly closing it here would submit a real order against the
        // wrong trade. Require the exchange's positionId to match the one
        // this record was actually stuck on, exactly like
        // confirmPositionStillOpenNow's identical guard above. A record that
        // never captured a positionId has nothing to verify against, so it
        // is treated the same as a mismatch: decline rather than guess.
        if (typeof state.exchangePositionId !== "string" || state.exchangePositionId.length === 0 ||
            exchangePosition.positionId !== state.exchangePositionId) {
          return { kind: "blocked", reason: "position_identity_not_verified" };
        }
        request = {
          operation: "close_leg",
          sourceSignalId,
          symbol: record.symbol,
          accountId: capabilities.accountId,
          environment: "vst",
          quantity: String(exchangePosition.quantity),
          reason: "owner_triggered_manual_review_margin_top_up_close_now",
          stopStartedAt: Number(clock()),
          previousQuantity: Number(exchangePosition.quantity),
          nextPolicy: { status: "closed", remainingQty: 0 },
          nextPosition: { ...state, status: "closed", remainingQty: 0 },
          resolvedBy: resolvedBy ?? null,
        };
        const submitted = await reserveAndPerform(sourceSignalId, phase, request);
        if (submitted.kind === "existing") {
          request = submitted.intent.request;
        } else if (submitted.kind === "unknown") {
          return { kind: "pending_reconciliation" };
        }
      }

      const outcome = await reconcileManualReviewCloseNow({
        clientOrderId, phase, request, sourceSignalId,
      }, {
        resolvePosition: (signalId, args) => store.resolveMarginTopUpPositionAsClosed(signalId, args),
        closeNote: "Закрыто ботом автоматически (кнопка «Закрыть сейчас» — неподтверждённая маржа): рыночная заявка выставлена и подтверждена ботом по биржевым данным.",
      });
      if (outcome.kind === "reconciled") return { kind: "closed", position: outcome.position };
      if (outcome.kind === "unverified") return { kind: "unverified", reason: outcome.reason };
      return { kind: "closed_but_unrecorded", error: outcome.error };
    });
  }

  async function resolveLegacyPreRunnerClose(sourceSignalId, {
    clientOrderId, confirmation, resolvedBy, note = null,
  } = {}) {
    if (confirmation !== true) {
      return { kind: "refused", reason: "owner_confirmation_required" };
    }
    if (typeof sourceSignalId !== "string" || sourceSignalId.trim() === "" ||
        typeof clientOrderId !== "string" || clientOrderId.trim() === "" ||
        typeof resolvedBy !== "string" || resolvedBy.trim() === "" ||
        note !== null && typeof note !== "string") {
      return { kind: "refused", reason: "owner_review_fields_invalid" };
    }
    return store.withLeaderLock(async () => {
      if (typeof store.resolveLegacyPreRunnerCloseReview !== "function") {
        return { kind: "refused", reason: "legacy_pre_runner_review_unavailable" };
      }

      let intents;
      let records;
      try {
        [intents, records] = await Promise.all([
          store.listUnresolvedIntents(),
          (async () => [
            ...await store.listOpenPositions(),
            ...(typeof store.listErrorPositions === "function" ? await store.listErrorPositions() : []),
          ])(),
        ]);
      } catch {
        return { kind: "refused", reason: "legacy_pre_runner_review_store_unavailable" };
      }
      if (!Array.isArray(intents) || !Array.isArray(records)) {
        return { kind: "refused", reason: "legacy_pre_runner_review_store_unavailable" };
      }

      const unresolved = intents.find((item) =>
        item?.sourceSignalId === sourceSignalId &&
        item?.clientOrderId === clientOrderId);
      if (typeof store.getIntentByClientOrderId !== "function") {
        return { kind: "refused", reason: "legacy_pre_runner_review_store_unavailable" };
      }
      let locatedIntent;
      try {
        locatedIntent = await store.getIntentByClientOrderId(clientOrderId);
      } catch {
        return { kind: "refused", reason: "legacy_pre_runner_review_store_unavailable" };
      }
      if (!validObject(locatedIntent) ||
          locatedIntent.sourceSignalId !== sourceSignalId ||
          typeof locatedIntent.phase !== "string" ||
          locatedIntent.clientOrderId !== clientOrderId) {
        return {
          kind: "refused",
          reason: unresolved
            ? "legacy_pre_runner_close_not_found"
            : "legacy_pre_runner_close_not_unresolved",
        };
      }
      const phase = locatedIntent.phase;
      let intent;
      try {
        intent = await store.getIntent(sourceSignalId, phase);
      } catch {
        return { kind: "refused", reason: "legacy_pre_runner_review_store_unavailable" };
      }
      if (!validObject(intent)) {
        return { kind: "refused", reason: "legacy_pre_runner_close_not_found" };
      }

      const priorReview = intent.outcome?.ownerPreRunnerCloseReview;
      if (validObject(priorReview)) {
        const current = records.find((row) => row.sourceSignalId === sourceSignalId);
        const savedReview = { ...priorReview };
        delete savedReview.originalOutcome;
        let replay;
        try {
          replay = await store.resolveLegacyPreRunnerCloseReview({
            clientOrderId,
            sourceSignalId,
            expectedIntent: intent,
            expectedPositionSnapshot: current?.snapshot,
            review: savedReview,
            position: current?.snapshot,
          });
        } catch {
          return { kind: "refused", reason: "legacy_pre_runner_review_store_unavailable" };
        }
        if (replay?.kind !== "replayed") {
          return {
            kind: "refused",
            reason: typeof replay?.reason === "string"
              ? replay.reason : "legacy_pre_runner_review_replay_refused",
          };
        }
        return {
          kind: "replayed",
          ...(replay?.position ? { position: replay.position } :
            current?.snapshot ? { position: current.snapshot } : {}),
          review: replay?.review ?? priorReview,
        };
      }

      const request = intent.request;
      if (!unresolved) {
        return { kind: "refused", reason: "legacy_pre_runner_close_not_unresolved" };
      }
      const legacyEligible =
        intent.state === "unknown" &&
        intent.sourceSignalId === sourceSignalId &&
        intent.clientOrderId === clientOrderId &&
        request?.operation === "close_pre_runner_split" &&
        request?.environment === "vst" &&
        request?.sourceSignalId === sourceSignalId &&
        request?.closeIntentId === clientOrderId &&
        !request?.sourceExit &&
        /^impulse-runner-breakeven-abort-\d+$/.test(phase) &&
        clientOrderId === orderId(sourceSignalId, phase) &&
        validObject(request.priorPosition) &&
        request.priorPosition.sourceSignalId === sourceSignalId &&
        request.priorPosition.symbol === request.symbol &&
        request.priorPosition.split?.stage === "runner_pending";
      if (!legacyEligible) {
        return { kind: "refused", reason: "legacy_pre_runner_close_not_eligible" };
      }
      const record = records.find((row) => row.sourceSignalId === sourceSignalId);
      const snapshot = record?.snapshot;
      if (!validObject(record) ||
          !["open", "closing", "unknown", "error"].includes(record.status) ||
          !validObject(snapshot) ||
          snapshot.split?.stage !== "runner_pending") {
        return { kind: "refused", reason: "legacy_pre_runner_position_not_found" };
      }

      const openProof = await provePreRunnerSplitCloseStillOpen(intent, { ownerReview: true });
      let outcome;
      let evidence;
      let nextSnapshot;
      let observedAtMs;
      if (openProof) {
        const { state, record: freshRecord } = openProof;
        if (freshRecord.status !== record.status ||
            canonicalPolicyJson(freshRecord.snapshot) !== canonicalPolicyJson(snapshot)) {
          return { kind: "refused", reason: "legacy_pre_runner_position_changed" };
        }
        outcome = "open";
        observedAtMs = openProof.observedAt;
        const split = state.split;
        evidence = {
          verified: true,
          environment: "vst",
          accountId: request.accountId,
          symbol: request.symbol,
          positionId: request.positionId,
          quantity: String(split.totalQuantity),
          stops: [
            {
              orderId: split.originalStopOrderId,
              positionId: split.positionId,
              quantity: String(split.totalQuantity),
              stopPrice: String(split.signalStopPrice),
            },
            {
              orderId: split.coreStop.orderId,
              positionId: split.positionId,
              quantity: String(split.coreStop.quantity),
              stopPrice: String(split.coreStop.stopPrice),
            },
          ],
          observedAt: new Date(observedAtMs).toISOString(),
        };
        nextSnapshot = { ...snapshot, status: "closing" };
      } else {
        if (typeof broker.readHistoricalErrorClose !== "function" ||
            broker.supportsHistoricalCloseProof === false) {
          return { kind: "refused", reason: "legacy_pre_runner_close_history_unavailable" };
        }
        let entryIntent;
        try {
          entryIntent = await store.getIntent(sourceSignalId, "market-entry");
        } catch {
          return { kind: "refused", reason: "legacy_pre_runner_review_store_unavailable" };
        }
        const candidate = {
          sourceSignalId,
          symbol: record.symbol,
          status: record.status,
          snapshot,
          entryIntent,
          closeIntent: intent,
          ownerPreRunnerCloseReview: true,
        };
        let historicalProof;
        try {
          historicalProof = await broker.readHistoricalErrorClose(candidate);
        } catch {
          return { kind: "refused", reason: "legacy_pre_runner_close_history_unverified" };
        }
        observedAtMs = Date.parse(historicalProof?.observedAt);
        const afterProofMs = Number(clock());
        if (!validObject(historicalProof) ||
            historicalProof.verified !== true ||
            historicalProof.environment !== "vst" ||
            historicalProof.accountId !== snapshot.accountId ||
            historicalProof.sourceSignalId !== sourceSignalId ||
            historicalProof.symbol !== record.symbol ||
            historicalProof.positionId !== snapshot.exchangePositionId ||
            historicalProof.flatCheck?.verified !== true ||
            historicalProof.flatCheck?.positionQuantity !== "0" ||
            historicalProof.flatCheck?.openOrderCount !== 0 ||
            !Array.isArray(historicalProof.fills) ||
            (historicalProof.lifecycleVersion === 2
              ? historicalProof.fills.length < 2 ||
                !Array.isArray(historicalProof.entryFills) ||
                historicalProof.entryFills.length === 0 ||
                !Array.isArray(historicalProof.closeFills) ||
                historicalProof.closeFills.length === 0 ||
                historicalProof.entryFills.length + historicalProof.closeFills.length !==
                  historicalProof.fills.length
              : historicalProof.fills.length !== 2) ||
            !Number.isSafeInteger(observedAtMs) ||
            !Number.isSafeInteger(afterProofMs) ||
            afterProofMs - observedAtMs > 5_000) {
          return { kind: "refused", reason: "legacy_pre_runner_close_history_unverified" };
        }
        outcome = "closed";
        evidence = {
          ...historicalProof,
          entryIntent,
          candidate: {
            sourceSignalId,
            symbol: record.symbol,
            status: record.status,
            snapshot,
            entryIntent,
            closeIntent: intent,
            ownerPreRunnerCloseReview: true,
          },
        };
        nextSnapshot = {
          ...snapshot,
          status: "closed",
          remainingQty: 0,
        };
      }

      const checkedAtMs = Number(clock());
      if (!Number.isSafeInteger(checkedAtMs) || checkedAtMs <= 0 ||
          !Number.isSafeInteger(observedAtMs) || observedAtMs <= 0 ||
          checkedAtMs < observedAtMs || checkedAtMs - observedAtMs > 5_000) {
        return { kind: "refused", reason: "legacy_pre_runner_review_evidence_stale" };
      }
      const checkedAt = new Date(checkedAtMs).toISOString();
      const review = {
        outcome,
        resolvedBy: resolvedBy.trim(),
        note: typeof note === "string" && note.trim() ? note.trim() : null,
        checkedAt,
        evidence,
      };
      let result;
      try {
        result = await store.resolveLegacyPreRunnerCloseReview({
          clientOrderId,
          sourceSignalId,
          expectedIntent: intent,
          expectedPositionSnapshot: snapshot,
          review,
          position: nextSnapshot,
        });
      } catch {
        return { kind: "refused", reason: "legacy_pre_runner_review_cas_failed" };
      }
      if (result?.kind === "resolved") {
        if (outcome === "open") {
          const reason = "owner_review_confirmed_pre_runner_split_still_open";
          await store.setSignalStatus(sourceSignalId, "error", reason);
          await store.recordEvent?.(sourceSignalId, "vst_worker_error", {
            reason,
            symbol: record.symbol,
            operation: request.operation,
          });
        }
        return { kind: "resolved", position: result.position ?? nextSnapshot, review };
      }
      if (result?.kind === "replayed") {
        return {
          kind: "replayed",
          ...(result.position ? { position: result.position } : {}),
          ...(result.review ? { review: result.review } : {}),
        };
      }
      return {
        kind: "refused",
        reason: typeof result?.reason === "string"
          ? result.reason : "legacy_pre_runner_review_refused",
      };
    });
  }

  async function executeSourceCommand(value, { cancelEntry, receivedAt } = {}) {
    const command = validateSourceCommand(value, Number(clock()));
    if (strategyAuthority !== "source") return { status: "rejected", reason: "source_authority_required" };
    return await store.withLeaderLock(async () => {
      exchangeActionAttemptedThisTick = false;
      historicalProofAttemptedThisTick = false;
      const record = await store.getPosition(command.sourceSignalId);
      if (record && record.symbol !== command.symbol) {
        return { status: "rejected", reason: "source_symbol_conflict" };
      }
      if (command.type === "cancel_entry") {
        return await cancelEntry(command, "vst");
      }
      if (command.type === "close") {
        const row = directCloseRequest(command, receivedAt ?? command.occurredAt);
        if (!record && !await store.getIntent(command.sourceSignalId, "market-entry")) {
          return await cancelEntry(command, "vst");
        }
        // A later distinct close may acknowledge an earlier committed own exit,
        // but never a bare closed flag. Reuse the same exact-fill guard.
        const priorId = record?.snapshot?.sourceExit?.requestId ??
          record?.snapshot?.sourceExitRequestId;
        if (record?.status === "closed" && priorId) {
          const priorIntent = await store.getIntent(command.sourceSignalId, sourceExitPhase(priorId));
          const priorExit = priorIntent?.request?.sourceExit;
          const cleanupIntents = [];
          for (const stop of priorIntent?.request?.ownedStops ?? []) {
            if (typeof stop?.orderId !== "string") continue;
            const cleanup = await store.getIntent(command.sourceSignalId,
              sourceExitCleanupPhase(priorId, stop.orderId));
            if (cleanup) cleanupIntents.push(cleanup);
          }
          if (sourceExitClosedSnapshotVerified(record, {
            ...row, requestId: priorId,
            ...(priorExit ? { reason: priorIntent.request.reason, evidence: priorExit.evidence } : {}),
          }, priorIntent, cleanupIntents)) {
            return { status: "already_closed", result: "exchange_close_verified" };
          }
        }
        directCloseCompletion = { requestId: row.requestId, completed: null };
        try {
          const caps = record && record.status !== "closed" ? await broker.getCapabilities() : null;
          const result = await processSourceExitRequest(row,
            record && record.status !== "closed" ? record : null, caps);
          const completed = directCloseCompletion.completed;
          if (completed?.outcome === "closed") {
            return { status: record?.status === "closed" ? "already_closed" : "executed",
              result: "exchange_close_verified" };
          }
          if (completed?.outcome === "rejected") return { status: "rejected",
            reason: completed.detail?.reason ?? "source_close_rejected" };
          return { status: "pending", reason: result?.reason ?? "source_close_reconciliation_pending" };
        } finally { directCloseCompletion = null; }
      }
      if (!record || record.status === "closed") {
        return { status: "rejected", reason: "stop_position_not_open" };
      }
      const unresolved = await store.listUnresolvedIntents();
      if (unresolved.some(intent => intent.sourceSignalId === command.sourceSignalId)) {
        return { status: "pending", reason: "intent_requires_reconciliation" };
      }
      const state = record.snapshot;
      const assessment = await inspectCapabilities(broker);
      if (!assessment.mutationCapabilities) {
        return { status: "pending", reason: "command_capabilities_unverified" };
      }
      const accountState = await broker.readAccountState();
      if (accountState?.verified !== true || accountState.environment !== "vst" ||
          accountState.accountId !== state.accountId) {
        return { status: "pending", reason: "command_account_state_unverified" };
      }
      const nativePosition = await broker.readPosition(command.symbol,
        state.patternId === "impulse_buy" ? {
          persistedPosition: persistedSplitPosition(state, accountState), allowProcessCache: false,
        } : {});
      if (nativePosition?.verified !== true || !(Number(nativePosition.quantity) > 0)) {
        return { status: "pending", reason: "position_requires_reconciliation" };
      }
      const normalized = { ...command, stopPrice: roundStopPriceUpToPrecision(
        command.stopPrice, nativePosition.pricePrecision, "source command stop price") };
      const activeStops = ["core", "runner"].filter(leg => state[`${leg}Open`])
        .map(leg => Number(state[leg === "core" ? "stopPrice" : "runnerStopPrice"]));
      if (!activeStops.length) return { status: "pending", reason: "position_active_legs_unverified" };
      if (activeStops.some(price => price > Number(normalized.stopPrice))) {
        return { status: "rejected", reason: "source_stop_would_reduce_protection" };
      }
      const result = await managePosition(record, assessment.capabilities, true, accountState, false, normalized);
      const next = await store.getPosition(command.sourceSignalId);
      const matched = next?.status === "open" && ["core", "runner"]
        .filter(leg => next.snapshot[`${leg}Open`])
        .every(leg => Number(next.snapshot[leg === "core" ? "stopPrice" : "runnerStopPrice"]) >= Number(normalized.stopPrice));
      if (matched && ["acted", "observed"].includes(result?.kind)) {
        return { status: "executed", result: "exchange_stop_verified" };
      }
      return { status: "pending", reason: result?.reason ?? "stop_verification_pending" };
    }) ?? { status: "pending", reason: "worker_busy" };
  }

  return {
    executeSourceCommand,
    ingestSignal(signal) {
      if (sizingLimits.environment !== undefined && sizingLimits.environment !== "vst") {
        throw new Error("VST worker refuses every non-VST environment");
      }
      return store.enqueue(signal);
    },
    runOnce,
    // Convenient ingress/runner aliases; both remain on the isolated ledger.
    enqueue: (signal) => store.enqueue(signal),
    tick: runOnce,
    closeErrorPositionNow,
    resolveOwnerAttestedPositionClosed,
    confirmPositionStillOpenNow,
    verifyMarginTopUpNotAddedAndResolve,
    readMarginTopUpMarginNow,
    closeMarginTopUpPositionNow,
    resolveLegacyPreRunnerClose,
    observeFullTakePrices,
  };
}