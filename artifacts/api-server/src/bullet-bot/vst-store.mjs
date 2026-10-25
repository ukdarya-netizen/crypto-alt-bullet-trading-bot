import { createHash } from "node:crypto";
import { nextUncertaintyRead, classifyVstUncertainty, protectedDegradedMarker, uncertaintyEvidenceKeys } from "./vst-uncertainty.mjs";
import Decimal from "decimal.js";
import { assertHistoricalFillCoverage, verifyHistoricalCloseEvidence, deriveVstExchangeClientOrderId, isVerifiedEntryCloseCandidate, corroborateHistoricalEntryPrice } from "./vst-historical-close-evidence.mjs";
import { buildSourceExitEvidence, isSourceCancellation, sourceExitRequestPredicate } from "./source-exit-evidence.mjs";
import { createSourceControlStore } from "./source-position-control.mjs";
import { compareExactDecimals, exactDecimalParts } from "./vst-exact-decimal.mjs";
import { archiveExactId, validateArchiveWindow } from "./vst-fill-archive.mjs";
import { fillHistoryDigest } from "./bingx-fill-history.mjs";
import { safeVstEntryDeferReason } from "./vst-entry-batch/safe-reasons.mjs";
import { committedHistoricalCloseProof } from "./vst-source-exit-closed-proof.mjs";

const LOCK_NAMESPACE = 4_348_996;
const LOCK_ID = 1;
const INTENT_SERIALIZATION_LOCK_NAMESPACE = 4_348_997;
const FILL_ARCHIVE_LOCK_NAMESPACE = 4_348_998;
const SECRET_KEY = /(api[_-]?key|secret|password|token|authorization|credential)/i;
const RAISE_STOP_ENTRY_PROOF_REFUSAL = "bingx_vst_entry_history_fills_unverified";
const RAISE_STOP_ENTRY_PROOF_REFUSAL_PRE_SIGN =
  "bingx_vst_raise_stop_entry_fill_proof_refused_before_upgrade";
const RAISE_STOP_EQUAL_PRICE_REJECTION_MESSAGE =
  "VST protective stop upgrades may only raise the stop";
const SIGNAL_STATUSES = new Set([
  "pending", "planning", "opening", "open", "closed", "rejected", "error",
  "unsupported", "unknown",
]);
const POSITION_STATUSES = new Set(["open", "closing", "closed", "error", "unknown"]);
const INTENT_STATES = new Set(["prepared", "submitted", "unknown", "reconciled", "failed"]);
const DEFAULT_EXPIRED_SIGNAL_MAX_AGE_MS = 10 * 60 * 1_000;
const READ_ONLY_RECOVERY_MAX_EVIDENCE_AGE_MS = 5_000;
const MAX_PRE_RUNNER_OPEN_PROOF_AGE_MS = 120_000;
const EXECUTION_QUANTITY_ALIASES = Object.freeze([
  "executedQty", "executedQuantity", "cumExecQty", "filledQty",
]);

import { matchesPreparedStopTransferPosition } from "./stop-transfer-journal.mjs";

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

// Number(...) alone treats "", "   ", null, and false as the valid value 0,
// which would let a blank or omitted field silently pass as an explicit
// zero. Every caller here is transcribing an owner-attested or exchange
// fact, so a blank/non-numeric-looking input must fail loudly rather than
// coerce to zero.
function toFiniteNumber(value, name) {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new TypeError(`${name} must be a number or numeric string`);
  }
  if (typeof value === "string" && value.trim() === "") {
    throw new TypeError(`${name} must be a number or numeric string`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return number;
}

function requirePositiveNumber(value, name) {
  const number = toFiniteNumber(value, name);
  if (number <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return number;
}

// A single owner-attested fill can prove the entire tracked position closed
// only when its quantity covers exactly the remaining ledger exposure. A
// partial fill (or a larger/unrelated one) is not evidence of a full close.
// Use decimal comparison rather than Number equality for exchange quantities.
function assertFullCloseQuantity(fillQuantity, snapshot) {
  requirePositiveNumber(snapshot.remainingQty, "stored remainingQty");
  if (!new Decimal(String(fillQuantity)).eq(new Decimal(String(snapshot.remainingQty)))) {
    throw new RangeError("vst_manual_close_quantity_mismatch");
  }
}

function requireNonNegativeNumber(value, name) {
  const number = toFiniteNumber(value, name);
  if (number < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
  return number;
}

function requireIsoTimestamp(value, name) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} must be an ISO timestamp string`);
  }
  return value;
}

function parseSignalTimestamp(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    , , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] ||
      hour > 23 || minute > 59 || second > 59 ||
      (offsetHourText !== undefined &&
        (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59))) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function requirePlainObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function validObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Persisted values must contain finite numbers");
    return value;
  }
  if (typeof value !== "object") throw new TypeError("Persisted values must be JSON-compatible");
  if (seen.has(value)) throw new TypeError("Persisted values must not contain circular references");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Persisted objects must be plain JSON objects");
    }
    const result = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError("Persisted objects must not contain undefined values");
      result[key] = canonicalize(value[key], seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function assertNoCredentials(value, path = "value") {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw new TypeError(`Credentials are not allowed in persisted ${path}`);
    assertNoCredentials(child, `${path}.${key}`);
  }
}

function serialize(value, name) {
  assertNoCredentials(value, name);
  return JSON.stringify(canonicalize(value));
}

// intentCreatedAt is bookkeeping (only ever read back to decide whether an
// unresolved intent has aged past its abandon threshold) -- never a real
// order fact. Every place that compares a freshly-built intent request
// against one already on file (reserveIntent, and commitVerifiedIntent's
// follow-up-intent checks) must not reject the attempt as "conflicting"
// when this is the only field that differs from what is already persisted.
function withoutIntentTimestamp(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const { intentCreatedAt, ...rest } = value;
  return rest;
}

function validStatus(status, choices, name) {
  if (!choices.has(status)) throw new TypeError(`Unsupported ${name}: ${String(status)}`);
}

function signalFromRow(row) {
  return row ? {
    sourceSignalId: row.source_signal_id,
    body: row.body,
    bodyHash: row.body_hash,
    status: row.status,
    reason: row.reason,
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
  } : null;
}

function positionFromRow(row) {
  return row ? {
    sourceSignalId: row.source_signal_id,
    symbol: row.symbol,
    status: row.status,
    snapshot: row.snapshot,
    updatedAt: row.updated_at,
  } : null;
}

function intentFromRow(row) {
  return row ? {
    sourceSignalId: row.source_signal_id,
    phase: row.phase,
    clientOrderId: row.client_order_id,
    request: row.request,
    state: row.state,
    exchangeOrderId: row.exchange_order_id,
    outcome: row.outcome,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : null;
}

function exactPositiveIdentifier(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function exactNativeIdentifier(value) {
  if (typeof value === "string") return value.trim() !== "" ? value : null;
  return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}

function exactDecimalEqual(left, right) {
  try {
    if ((typeof left !== "string" && typeof left !== "number") ||
        (typeof right !== "string" && typeof right !== "number") ||
        String(left).trim() === "" || String(right).trim() === "") return false;
    const a = new Decimal(String(left));
    const b = new Decimal(String(right));
    return a.isFinite() && b.isFinite() && a.eq(b);
  } catch {
    return false;
  }
}

function explicitZeroExecutionProofMatches(proof, expectedOrderId) {
  if (!proof || typeof proof !== "object" || Array.isArray(proof) ||
      proof.orderId !== expectedOrderId ||
      !Object.hasOwn(proof, "executedQty")) {
    return false;
  }
  const allowedKeys = new Set(["orderId", ...EXECUTION_QUANTITY_ALIASES]);
  if (Object.keys(proof).some((key) => !allowedKeys.has(key))) return false;
  return EXECUTION_QUANTITY_ALIASES.every((key) =>
    !Object.hasOwn(proof, key) ||
      exactZeroExecutionQuantity(proof[key]));
}

function exactZeroExecutionQuantity(value) {
  if (typeof value !== "string" && typeof value !== "number") return false;
  const match = /^0+(?:\.0+)?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match) return false;
  const exponent = Number(match[1] ?? 0);
  return Number.isSafeInteger(exponent) && Math.abs(exponent) <= 30;
}

function consistentIdentifierAliases(row, ...keys) {
  const values = keys.map((key) => row?.[key])
    .filter((value) => value !== undefined && value !== null);
  if (values.length === 0) return null;
  const identifiers = values.map(exactPositiveIdentifier);
  return identifiers.some((value) => value === null) ||
      new Set(identifiers).size !== 1
    ? null : identifiers[0];
}

function consistentDecimalAliases(row, ...keys) {
  const values = keys.map((key) => row?.[key])
    .filter((value) => value !== undefined && value !== null);
  if (values.length === 0 || values.slice(1).some((value) =>
    !exactDecimalEqual(value, values[0]))) return null;
  return values[0];
}

function exactRaiseStopRefusal(outcome, phase, request) {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return false;
  const keys = uncertaintyEvidenceKeys(outcome).sort();
  const knownPhase = /^raise_stop-core-\d+$/.test(phase) ||
    /^impulse-sole-core-stop-\d+$/.test(phase);
  if (!knownPhase || request?.operation !== "raise_stop" || request?.leg !== "core") {
    return false;
  }
  const explicit = outcome.error === "Error" &&
    outcome.preSignReason === RAISE_STOP_ENTRY_PROOF_REFUSAL_PRE_SIGN &&
    outcome.errorMessage ===
      `${RAISE_STOP_ENTRY_PROOF_REFUSAL} (${RAISE_STOP_ENTRY_PROOF_REFUSAL_PRE_SIGN})` &&
    JSON.stringify(keys) === JSON.stringify(["error", "errorMessage", "preSignReason"]);
  const legacy = outcome.error === "Error" &&
    outcome.preSignReason === undefined &&
    request?.entryProof === undefined &&
    outcome.errorMessage === RAISE_STOP_ENTRY_PROOF_REFUSAL &&
    JSON.stringify(keys) === JSON.stringify(["error", "errorMessage"]);
  const normalizedExplicit =
    outcome.reason === "exchange_state_not_verified" &&
    outcome.submissionError === "Error" &&
    outcome.submissionErrorMessage ===
      `${RAISE_STOP_ENTRY_PROOF_REFUSAL} (${RAISE_STOP_ENTRY_PROOF_REFUSAL_PRE_SIGN})` &&
    outcome.preSignReason === RAISE_STOP_ENTRY_PROOF_REFUSAL_PRE_SIGN &&
    JSON.stringify(keys) === JSON.stringify([
      "preSignReason", "reason", "submissionError", "submissionErrorMessage",
    ]);
  const normalizedLegacy =
    outcome.reason === "exchange_state_not_verified" &&
    outcome.submissionError === "Error" &&
    outcome.submissionErrorMessage === RAISE_STOP_ENTRY_PROOF_REFUSAL &&
    request?.entryProof === undefined &&
    JSON.stringify(keys) === JSON.stringify([
      "reason", "submissionError", "submissionErrorMessage",
    ]);
  return explicit || legacy || normalizedExplicit || normalizedLegacy;
}

function exactRaiseStopEqualPriceRejection(outcome, phase, request) {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome) ||
      !/^raise_stop-core-\d+$/.test(String(phase)) ||
      request?.operation !== "raise_stop" || request?.leg !== "core") {
    return false;
  }
  const outcomeKeys = uncertaintyEvidenceKeys(outcome).sort();
  const legacyKeys = ["reason", "submissionError", "submissionErrorMessage"];
  const provenance = outcome.mutationProvenance;
  const strictNoWrite = provenance && typeof provenance === "object" &&
    !Array.isArray(provenance) &&
    provenance.operation === "raise_stop" &&
    provenance.method === "POST" &&
    provenance.phase === "pre_mutation_guard" &&
    provenance.mutationRequestSent === false &&
    provenance.reason === "non_increasing_stop" &&
    JSON.stringify(Object.keys(provenance).sort()) === JSON.stringify([
      "method", "mutationRequestSent", "operation", "phase", "reason",
    ]) &&
    JSON.stringify(outcomeKeys) === JSON.stringify([
      ...legacyKeys, "mutationProvenance",
    ].sort());
  return outcome.reason === "exchange_state_not_verified" &&
    outcome.submissionError === "BingXLiveApiError" &&
    outcome.submissionErrorMessage === RAISE_STOP_EQUAL_PRICE_REJECTION_MESSAGE &&
    (JSON.stringify(outcomeKeys) === JSON.stringify(legacyKeys) || strictNoWrite);
}

async function transaction(pool, callback) {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query("BEGIN");
    open = true;
    const value = await callback(client);
    await client.query("COMMIT");
    open = false;
    return value;
  } catch (error) {
    if (open) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Historical-close reconciliation and every transactional intent writer take
// this same per-signal transaction lock before acquiring ledger row locks.
// hashtext collisions only serialize unrelated signals; they cannot weaken
// exclusion for equal source_signal_id values.
async function lockSignalIntents(client, sourceSignalId) {
  await client.query(
    "SELECT pg_advisory_xact_lock($1, hashtext($2))",
    [INTENT_SERIALIZATION_LOCK_NAMESPACE, sourceSignalId],
  );
}

async function guardLegacyPreRunnerReview(client, sourceSignalId) {
  await lockSignalIntents(client, sourceSignalId);
  const unresolved = await client.query(
    `SELECT client_order_id FROM vst_order_intents
     WHERE source_signal_id = $1 AND state IN ('prepared', 'submitted', 'unknown')
       AND request->>'operation' = 'close_pre_runner_split' FOR UPDATE`,
    [sourceSignalId],
  );
  if (unresolved.rowCount) throw new Error("vst_legacy_pre_runner_close_review_required");
}

function sourceExitRequestId(sourceSignalId) {
  return `source-exit-${createHash("sha256").update(sourceSignalId).digest("hex")}`;
}

function sourceExitEventFromRow(row) {
  if (!row) return null;
  const detail = validObject(row.detail) ? row.detail : {};
  return {
    eventId: row.id,
    sourceSignalId: row.source_signal_id,
    kind: row.kind,
    detail,
    createdAt: row.created_at,
  };
}

function sourceExitRequestFromEvent(row) {
  const event = sourceExitEventFromRow(row);
  if (!event) return null;
  const detail = event.detail;
  return {
    id: detail.requestId,
    requestId: detail.requestId,
    sourceSignalId: event.sourceSignalId,
    symbol: detail.symbol,
    reason: detail.reason,
    evidence: detail.evidence,
    asOf: detail.latestAsOf ?? detail.asOf,
    observedAt: detail.latestObservedAt ?? detail.observedAt,
    createdAt: event.createdAt,
    eventId: event.eventId,
  };
}

function archiveWindowFromRow(row) {
  return row ? row.archive_window : null;
}

function archiveFillIdentity(fill) {
  if (typeof fill?.symbol !== "string") {
    throw new TypeError("Validated VST archive contains a fill without a stable identity");
  }
  return { symbol: fill.symbol, tradeId: archiveExactId(fill.tradeId) };
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function requireArchiveCurrency(value = "USDT") {
  if (value !== "USDT") {
    throw new TypeError("VST fill archive currency must be USDT");
  }
  return value;
}

async function lockFillArchiveScope(client, accountId, currency = "USDT") {
  await client.query(
    "SELECT pg_advisory_xact_lock($1, hashtext($2))",
    [FILL_ARCHIVE_LOCK_NAMESPACE, `${accountId}:${currency}`],
  );
}

async function validatePersistedArchiveWindows(database, archiveWindows, accountId) {
  if (archiveWindows === undefined) return undefined;
  if (!Array.isArray(archiveWindows)) {
    throw new TypeError("historical archiveWindows must be an array when supplied");
  }
  const validated = [];
  for (const candidate of archiveWindows) {
    const currency = candidate?.currency ?? "USDT";
    const window = validateArchiveWindow(candidate, { accountId, currency });
    if (window.environment !== "vst") {
      throw new Error("vst_fill_archive_window_scope_invalid");
    }
    const startTs = window.coverage.startTs;
    const endTs = window.coverage.endTs;
    const windowJson = canonicalJson(window);
    const windowHash = createHash("sha256").update(windowJson).digest("hex");
    const result = await database.query(
      `SELECT window_hash, archive_window
       FROM vst_fill_archive_windows
       WHERE environment = 'vst' AND account_id = $1 AND currency = $2
         AND start_ts = $3::bigint AND end_ts = $4::bigint
         AND observed_at = $5::timestamptz AND invalidated_at IS NULL`,
      [accountId, window.currency, startTs, endTs, window.archivedAt],
    );
    const persisted = result.rows.some((row) =>
      row.window_hash === windowHash && canonicalJson(row.archive_window) === windowJson);
    if (!persisted) throw new Error("vst_fill_archive_window_not_persisted");
    validated.push(window);
  }
  return validated;
}

function sameSourceExitProvenance(left, right) {
  if (!validObject(left) || !validObject(right)) return false;
  const { asOf: _leftAsOf, observedAt: _leftObservedAt, ...leftProvenance } = left;
  const { asOf: _rightAsOf, observedAt: _rightObservedAt, ...rightProvenance } = right;
  try {
    return JSON.stringify(canonicalize(leftProvenance)) ===
      JSON.stringify(canonicalize(rightProvenance));
  } catch {
    return false;
  }
}

/**
 * PostgreSQL persistence exclusively for VST. It has no PAPER-table access,
 * no schema installation, and no broker/network calls.
 */
// Each subscriber's ledger (its own schema) gets its own leader lock id so
// the owner's worker and every subscriber worker tick independently.
export function createVstStore(pool, { leaderLockId = LOCK_ID } = {}) {
  if (!Number.isSafeInteger(leaderLockId) || leaderLockId < 1 || leaderLockId > 2_147_483_647) {
    throw new RangeError("VST leader lock id must be a positive int4");
  }
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw new TypeError("createVstStore requires a PostgreSQL pool");
  }

  return {
    async saveFillArchiveWindow(input) {
      const window = validateArchiveWindow(input, {
        accountId: input?.accountId,
        currency: input?.currency ?? "USDT",
      });
      if (window.environment !== "vst") {
        throw new TypeError("VST fill archive only accepts environment 'vst'");
      }
      const accountId = requireString(window.accountId, "accountId");
      const currency = requireArchiveCurrency(window.currency);
      const startTs = window.coverage.startTs;
      const endTs = window.coverage.endTs;
      const observedAt = window.archivedAt;
      const serializedWindow = canonicalJson(window);
      const windowHash = createHash("sha256").update(serializedWindow).digest("hex");

      return transaction(pool, async (client) => {
        // Serialize writes for a scope so concurrent captures cannot both miss
        // a conflicting version of the same exchange trade.
        await lockFillArchiveScope(client, accountId, currency);
        // Exact retries preserve their audit observation, including an already
        // invalidated one. They must not revoke a newer observation's trust.
        const retry = await client.query(
          `SELECT window_hash, archive_window FROM vst_fill_archive_windows
           WHERE environment = 'vst' AND account_id = $1 AND currency = $2
             AND start_ts = $3::bigint AND end_ts = $4::bigint
             AND window_hash = $5 AND observed_at = $6::timestamptz`,
          [accountId, currency, startTs, endTs, windowHash, observedAt],
        );
        if (retry.rows.length) {
          const row = retry.rows[0];
          if (row.window_hash !== windowHash ||
              canonicalJson(row.archive_window) !== serializedWindow) {
            throw new Error("vst_fill_archive_window_idempotency_conflict");
          }
          return archiveWindowFromRow(row);
        }
        // A stable NEW snapshot can still contradict an older stable snapshot.
        // Compare the entire currency-wide fill set in each exact (start,end]
        // intersection, not just identities present in the new response.
        const overlapping = await client.query(
          `SELECT id, archive_window FROM vst_fill_archive_windows
           WHERE environment = 'vst' AND account_id = $1 AND currency = $2
             AND invalidated_at IS NULL
             AND start_ts < $4::bigint AND end_ts > $3::bigint
           FOR UPDATE`,
          [accountId, currency, startTs, endTs],
        );
        const contradicted = [];
        for (const row of overlapping.rows) {
          const previous = validateArchiveWindow(row.archive_window, { accountId, currency });
          const lower = Math.max(startTs, previous.coverage.startTs);
          const upper = Math.min(endTs, previous.coverage.endTs);
          const inIntersection = (fill) => {
            const time = Date.parse(fill.filledTime);
            return time > lower && time <= upper;
          };
          if (fillHistoryDigest(previous.rawFills.filter(inIntersection)) ===
              fillHistoryDigest(window.rawFills.filter(inIntersection))) continue;
          // A slow older capture finishing after a newer one cannot overwrite
          // the newer observation. Refuse before inserting or invalidating.
          if (Date.parse(window.coverage.observedAt) < Date.parse(previous.coverage.observedAt)) {
            throw new Error("vst_fill_archive_stale_contradictory_observation");
          }
          contradicted.push(row.id);
        }
        for (const fill of window.rawFills) {
          const { symbol, tradeId } = archiveFillIdentity(fill);
          const content = canonicalJson(fill);
          const insertedFill = await client.query(
            `INSERT INTO vst_fill_archive_fills
               (environment, account_id, currency, symbol, trade_id, raw_fill)
             VALUES ('vst', $1, 'USDT', $2, $3, $4::jsonb)
             ON CONFLICT (environment, account_id, currency, symbol, trade_id) DO NOTHING
             RETURNING raw_fill`,
            [accountId, symbol, tradeId, content],
          );
          if (insertedFill.rowCount) continue;
          const existingFill = await client.query(
            `SELECT raw_fill FROM vst_fill_archive_fills
             WHERE environment = 'vst' AND account_id = $1 AND currency = 'USDT'
               AND symbol = $2 AND trade_id = $3`,
            [accountId, symbol, tradeId],
          );
          if (!existingFill.rowCount ||
              canonicalJson(existingFill.rows[0].raw_fill) !== content) {
            throw new Error("vst_fill_archive_conflicting_trade_content");
          }
        }

        if (contradicted.length) {
          await client.query(
            `UPDATE vst_fill_archive_windows
             SET invalidated_at = now(),
                 invalidation_reason = 'successful_snapshot_contradiction'
             WHERE id = ANY($1::bigint[]) AND invalidated_at IS NULL`,
            [contradicted],
          );
        }
        const inserted = await client.query(
          `INSERT INTO vst_fill_archive_windows
             (environment, account_id, currency, start_ts, end_ts, window_hash, archive_window, observed_at)
           VALUES ('vst', $1, $2, $3::bigint, $4::bigint, $5, $6::jsonb, $7::timestamptz)
           ON CONFLICT (environment, account_id, currency, start_ts, end_ts,
                        window_hash, observed_at) DO NOTHING
           RETURNING archive_window`,
          [accountId, currency, startTs, endTs, windowHash, serializedWindow, observedAt],
        );
        if (inserted.rowCount) return archiveWindowFromRow(inserted.rows[0]);
        const existingWindow = await client.query(
          `SELECT window_hash, archive_window FROM vst_fill_archive_windows
           WHERE environment = 'vst' AND account_id = $1 AND currency = $2
             AND start_ts = $3::bigint AND end_ts = $4::bigint
             AND window_hash = $5 AND observed_at = $6::timestamptz`,
          [accountId, currency, startTs, endTs, windowHash, observedAt],
        );
        const row = existingWindow.rows[0];
        if (!row || row.window_hash !== windowHash ||
            canonicalJson(row.archive_window) !== serializedWindow) {
          throw new Error("vst_fill_archive_window_idempotency_conflict");
        }
        return archiveWindowFromRow(row);
      });
    },

    async invalidateFillArchiveWindows({
      accountId, currency = "USDT", startTs, endTs, reason,
    } = {}) {
      const id = requireString(accountId, "accountId");
      const scopedCurrency = requireArchiveCurrency(currency);
      if (!Number.isSafeInteger(startTs) || startTs <= 0 ||
          !Number.isSafeInteger(endTs) || endTs < startTs) {
        throw new TypeError("Invalid VST fill archive invalidation range");
      }
      const invalidationReason = requireString(reason, "reason").trim();
      return transaction(pool, async (client) => {
        await lockFillArchiveScope(client, id, scopedCurrency);
        const invalidated = await client.query(
          `UPDATE vst_fill_archive_windows
           SET invalidated_at = now(), invalidation_reason = $5
           WHERE environment = 'vst' AND account_id = $1 AND currency = $2
             AND start_ts < $4::bigint AND end_ts > $3::bigint
             AND invalidated_at IS NULL
           RETURNING id`,
          [id, scopedCurrency, startTs, endTs, invalidationReason],
        );
        return invalidated.rowCount;
      });
    },

    async listFillArchiveWindows({
      accountId, currency = "USDT", startTs, endTs,
    } = {}) {
      const id = requireString(accountId, "accountId");
      const scopedCurrency = requireArchiveCurrency(currency);
      if (startTs !== undefined && (!Number.isSafeInteger(startTs) || startTs <= 0)) {
        throw new TypeError("startTs must be a positive safe integer");
      }
      if (endTs !== undefined && (!Number.isSafeInteger(endTs) || endTs <= 0)) {
        throw new TypeError("endTs must be a positive safe integer");
      }
      if (startTs !== undefined && endTs !== undefined && endTs < startTs) {
        throw new TypeError("endTs must be greater than or equal to startTs");
      }
      const result = await pool.query(
        `SELECT archive_window
         FROM vst_fill_archive_windows
         WHERE environment = 'vst' AND account_id = $1 AND currency = $2
           AND invalidated_at IS NULL
           AND ($3::bigint IS NULL OR end_ts >= $3::bigint)
           AND ($4::bigint IS NULL OR start_ts <= $4::bigint)
         ORDER BY start_ts, end_ts, observed_at, id`,
        [id, scopedCurrency, startTs ?? null, endTs ?? null],
      );
      return result.rows.map(archiveWindowFromRow);
    },

    async getFillArchiveCursor({ accountId, currency = "USDT" } = {}) {
      const id = requireString(accountId, "accountId");
      const scopedCurrency = requireArchiveCurrency(currency);
      const result = await pool.query(
        `SELECT start_ts::text AS start_ts, end_ts::text AS end_ts, invalidated_at
         FROM vst_fill_archive_windows
         WHERE environment = 'vst' AND account_id = $1 AND currency = $2
         ORDER BY start_ts, end_ts, observed_at, id`,
        [id, scopedCurrency],
      );
      let cursor = null;
      for (const row of result.rows) {
        const start = Number(row.start_ts);
        const end = Number(row.end_ts);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
          throw new Error("vst_fill_archive_bounds_invalid");
        }
        if (cursor === null) {
          // Original observations remain durable even after invalidation.
          // Their earliest start is the archive's repair boundary, not the
          // first currently trusted window (which could be beyond a gap).
          cursor = start;
        }
        if (row.invalidated_at != null) continue;
        if (start <= cursor) {
          cursor = Math.max(cursor, end);
        } else {
          break;
        }
      }
      return cursor;
    },

    async getPosition(sourceSignalId) {
      const id = requireString(sourceSignalId, "sourceSignalId");
      const result = await pool.query(
        `SELECT source_signal_id, symbol, status, snapshot, updated_at::text AS updated_at
         FROM vst_positions WHERE source_signal_id = $1`,
        [id],
      );
      return positionFromRow(result.rows[0]);
    },

    async enqueue(signal) {
      const id = requireString(signal?.sourceSignalId, "sourceSignalId");
      const body = serialize(signal, "signal");
      const hash = createHash("sha256").update(body).digest("hex");
      const inserted = await pool.query(
        `INSERT INTO vst_signals (source_signal_id, body, body_hash)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (source_signal_id) DO NOTHING
         RETURNING status`,
        [id, body, hash],
      );
      if (inserted.rowCount) return { kind: "new", status: inserted.rows[0].status };
      const existing = await pool.query(
        `SELECT body_hash, status FROM vst_signals WHERE source_signal_id = $1`,
        [id],
      );
      if (!existing.rowCount) throw new Error("VST signal insert conflict could not be resolved");
      return {
        kind: existing.rows[0].body_hash === hash ? "duplicate" : "conflict",
        status: existing.rows[0].status,
      };
    },

    async withLeaderLock(callback) {
      if (typeof callback !== "function") throw new TypeError("withLeaderLock requires a callback");
      const client = await pool.connect();
      let acquired = false;
      let destroyClient = false;
      try {
        const result = await client.query(
          "SELECT pg_try_advisory_lock($1, $2) AS acquired",
          [LOCK_NAMESPACE, leaderLockId],
        );
        acquired = result.rows[0]?.acquired === true;
        if (!acquired) return null;
        return await callback();
      } finally {
        if (acquired) {
          try {
            const unlocked = await client.query(
              "SELECT pg_advisory_unlock($1, $2) AS released",
              [LOCK_NAMESPACE, leaderLockId],
            );
            if (unlocked.rows[0]?.released !== true) destroyClient = true;
          } catch {
            destroyClient = true;
          }
        }
        client.release(destroyClient);
      }
    },

    async getPending() {
      const result = await pool.query(
        `SELECT source_signal_id, body, body_hash, status, reason, received_at, updated_at
         FROM vst_signals
         WHERE status IN ('opening', 'planning', 'pending')
         ORDER BY CASE WHEN status = 'opening' THEN 0 WHEN status = 'planning' THEN 1 ELSE 2 END,
                  received_at, source_signal_id
         LIMIT 1`,
      );
      return signalFromRow(result.rows[0]);
    },

    // Legacy bounded list in the same order as getPending(). Callers that
    // need to scan beyond this diagnostic/compatibility window must use
    // listPendingCandidatesPage() below.
    async listPendingCandidates(limit = 200) {
      const cappedLimit = Math.max(1, Math.min(Number(limit) || 200, 1000));
      const result = await pool.query(
        `SELECT source_signal_id, body, body_hash, status, reason, received_at, updated_at
         FROM vst_signals
         WHERE status IN ('opening', 'planning', 'pending')
         ORDER BY CASE WHEN status = 'opening' THEN 0 WHEN status = 'planning' THEN 1 ELSE 2 END,
                  received_at, source_signal_id
         LIMIT $1`,
        [cappedLimit],
      );
      return result.rows.map(signalFromRow);
    },

    // Keyset-paged form of listPendingCandidates(). The cursor is the exact
    // sort tuple (priority, received_at, source_signal_id), not an OFFSET:
    // rejecting a stale row while scanning therefore cannot shift later rows
    // behind the cursor. Preserve timestamp microseconds in the opaque cursor;
    // node-postgres Date values have millisecond precision and would otherwise
    // lose the database ordering key when multiple rows arrive in one ms.
    async listPendingCandidatesPage({ limit = 200, after = null } = {}) {
      const cappedLimit = Math.max(1, Math.min(Number(limit) || 200, 1000));
      if (after !== null &&
          (!Number.isSafeInteger(after?.priority) ||
           after.priority < 0 || after.priority > 2 ||
           typeof after?.receivedAt !== "string" ||
           !Number.isFinite(Date.parse(after.receivedAt)) ||
           typeof after?.sourceSignalId !== "string" ||
           after.sourceSignalId.trim() === "")) {
        throw new TypeError("VST pending candidate cursor is invalid");
      }
      const result = await pool.query(
        `WITH ordered_candidates AS (
           SELECT source_signal_id, body, body_hash, status, reason, received_at, updated_at,
                  CASE WHEN status = 'opening' THEN 0
                       WHEN status = 'planning' THEN 1 ELSE 2 END AS priority
           FROM vst_signals
           WHERE status IN ('opening', 'planning', 'pending')
         )
         SELECT source_signal_id, body, body_hash, status, reason, received_at, updated_at,
                priority AS candidate_priority,
                to_char(received_at AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_received_at
         FROM ordered_candidates
         WHERE $1::integer IS NULL OR
               (priority, received_at, source_signal_id) >
               ($1::integer, $2::timestamptz, $3::text)
         ORDER BY priority, received_at, source_signal_id
         LIMIT $4`,
        [
          after?.priority ?? null,
          after?.receivedAt ?? null,
          after?.sourceSignalId ?? null,
          cappedLimit + 1,
        ],
      );
      const pageRows = result.rows.slice(0, cappedLimit);
      const last = pageRows.at(-1);
      return {
        rows: pageRows.map(signalFromRow),
        nextCursor: last ? Object.freeze({
          priority: Number(last.candidate_priority),
          receivedAt: last.cursor_received_at,
          sourceSignalId: last.source_signal_id,
        }) : null,
        hasMore: result.rows.length > cappedLimit,
      };
    },

    // This intentionally handles only untouched pending rows. Any intent,
    // regardless of phase or state, and any position (including a closed or
    // error position) makes the signal historic/ambiguous and therefore
    // ineligible for retirement.
    async retireExpiredUnstartedSignals({
      nowMs = Date.now(),
      maxAgeMs = DEFAULT_EXPIRED_SIGNAL_MAX_AGE_MS,
      // Why the worker could not reach the signal (e.g. capability_read_failed);
      // carried into the rejection event so the owner sees the real cause.
      blockedBy = null,
    } = {}) {
      const blockedDetail = typeof blockedBy === "string" && /^[a-z0-9_]{1,80}$/.test(blockedBy)
        ? { blockedBy } : {};
      const now = toFiniteNumber(nowMs, "nowMs");
      const requestedMaxAge = requirePositiveNumber(maxAgeMs, "maxAgeMs");
      // Never let a caller shorten the established ten-minute entry window.
      const maxAge = Math.max(DEFAULT_EXPIRED_SIGNAL_MAX_AGE_MS, requestedMaxAge);
      const cutoff = now - maxAge;
      if (!Number.isFinite(cutoff)) throw new TypeError("nowMs and maxAgeMs are out of range");

      return transaction(pool, async (client) => {
        const candidates = await client.query(
          `SELECT source_signal_id, body, body_hash, status
           FROM vst_signals
           WHERE status = 'pending'
           ORDER BY received_at, source_signal_id
           FOR UPDATE SKIP LOCKED`,
        );
        if (!candidates.rowCount) return 0;

        const sourceSignalIds = candidates.rows.map((row) => row.source_signal_id);
        const [intentRows, positionRows] = await Promise.all([
          client.query(
            `SELECT DISTINCT source_signal_id
             FROM vst_order_intents
             WHERE source_signal_id = ANY($1::text[])`,
            [sourceSignalIds],
          ),
          client.query(
            `SELECT source_signal_id
             FROM vst_positions
             WHERE source_signal_id = ANY($1::text[])`,
            [sourceSignalIds],
          ),
        ]);
        const protectedIds = new Set([
          ...intentRows.rows.map((row) => row.source_signal_id),
          ...positionRows.rows.map((row) => row.source_signal_id),
        ]);

        let retired = 0;
        for (const row of candidates.rows) {
          if (row.status !== "pending" || protectedIds.has(row.source_signal_id)) continue;
          const signalAt = parseSignalTimestamp(row.body?.signalAt);
          // Require an ISO date-time string and a successfully parsed value.
          // In particular, never cast untrusted/malformed JSON values to
          // timestamptz in SQL (which could abort this whole cleanup).
          if (signalAt === null || signalAt >= cutoff) continue;

          const reason = "signal_expired_before_entry_reservation";
          const updated = await client.query(
            `UPDATE vst_signals
             SET status = 'rejected', reason = $4, updated_at = now()
             WHERE source_signal_id = $1 AND status = 'pending'
               AND body = $2::jsonb AND body_hash = $3
             RETURNING source_signal_id`,
            [row.source_signal_id, JSON.stringify(row.body), row.body_hash, reason],
          );
          if (!updated.rowCount) continue;

          await client.query(
            `INSERT INTO vst_events (source_signal_id, client_order_id, kind, detail)
             VALUES ($1, NULL, 'vst_signal_status_changed', $2::jsonb)`,
            [row.source_signal_id, serialize({
              from: "pending", to: "rejected", reason,
            }, "VST event detail")],
          );
          await client.query(
            `INSERT INTO vst_events (source_signal_id, client_order_id, kind, detail)
             VALUES ($1, NULL, 'vst_signal_rejected', $2::jsonb)`,
            [row.source_signal_id, serialize({ reason, ...blockedDetail }, "VST event detail")],
          );
          retired += 1;
        }
        return retired;
      });
    },

    // Every actual status change is recorded as a vst_events row in the same
    // transaction, independent of whether the caller also records a more
    // specific event. Many call sites in vst-worker.mjs move a signal to
    // 'unknown'/'error'/'rejected' etc. without an adjacent recordEvent --
    // without this safety net those transitions produce nothing in the
    // Telegram outbox at all, silently dropping the notification. A
    // no-op re-set (same status, e.g. a repeated "still unknown" tick) is
    // intentionally not re-recorded, matching the existing call-site
    // convention of only notifying once per genuine transition.
    async setSignalStatus(id, status, reason = null) {
      requireString(id, "sourceSignalId");
      validStatus(status, SIGNAL_STATUSES, "VST signal status");
      if (reason !== null && typeof reason !== "string") throw new TypeError("reason must be a string or null");
      const boundedReason = reason?.slice(0, 2_000) ?? null;
      return transaction(pool, async (client) => {
        const previous = await client.query(
          `SELECT status FROM vst_signals WHERE source_signal_id = $1 FOR UPDATE`,
          [id],
        );
        if (!previous.rowCount) return null;
        const previousStatus = previous.rows[0].status;
        const result = await client.query(
          `UPDATE vst_signals SET status = $2, reason = $3, updated_at = now()
           WHERE source_signal_id = $1
           RETURNING source_signal_id, body, body_hash, status, reason, received_at, updated_at`,
          [id, status, boundedReason],
        );
        if (previousStatus !== status) {
          await client.query(
            `INSERT INTO vst_events (source_signal_id, client_order_id, kind, detail)
             VALUES ($1, NULL, 'vst_signal_status_changed', $2::jsonb)`,
            [id, serialize(
              { from: previousStatus, to: status, reason: boundedReason }, "VST event detail",
            )],
          );
        }
        return signalFromRow(result.rows[0]);
      });
    },

    async upsertPosition(position) {
      const id = requireString(position?.sourceSignalId, "position.sourceSignalId");
      const symbol = requireString(position?.symbol, "position.symbol");
      validStatus(position.status, POSITION_STATUSES, "VST position status");
      const snapshot = serialize(position, "VST position");
      const result = await pool.query(
        `INSERT INTO vst_positions (source_signal_id, symbol, status, snapshot)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (source_signal_id) DO UPDATE SET
           symbol = EXCLUDED.symbol, status = EXCLUDED.status,
           snapshot = EXCLUDED.snapshot, updated_at = now()
         RETURNING source_signal_id, symbol, status, snapshot, updated_at`,
        [id, symbol, position.status, snapshot],
      );
      return positionFromRow(result.rows[0]);
    },

    // Durable latch for an observed fixed +5% take. Only fills an empty slot
    // on a still-open position; never changes status, quantity or protection.
    async latchFullTakeEvidence(sourceSignalId, evidence) {
      const id = requireString(sourceSignalId, "sourceSignalId");
      if (!validObject(evidence) || evidence.sourceSignalId !== id) {
        throw new TypeError("Invalid full-take latch evidence");
      }
      const payload = serialize(evidence, "full-take latch");
      await pool.query(
        `UPDATE vst_positions
         SET snapshot = jsonb_set(snapshot, '{fullTakeLatch}', $2::jsonb, true)
         WHERE source_signal_id = $1 AND status = 'open'
           AND NOT (snapshot ? 'fullTakeLatch')`,
        [id, payload],
      );
    },

    // Durable full-take touches and escalations for still-unclosed positions.
    // vst_events is append-only, so a touch survives restarts and snapshot
    // rewrites by the worker.
    async listFullTakeEvents() {
      const result = await pool.query(
        `SELECT e.source_signal_id, e.kind, e.detail, e.created_at
         FROM vst_events e
         JOIN vst_positions p ON p.source_signal_id = e.source_signal_id
         WHERE e.kind IN ('vst_full_take_touched', 'vst_full_take_close_delayed',
                          'vst_full_take_close_stuck')
           AND p.status IN ('open', 'closing', 'unknown')
         ORDER BY e.id`,
      );
      return result.rows.map((row) => ({
        sourceSignalId: row.source_signal_id, kind: row.kind,
        detail: row.detail, createdAt: row.created_at,
      }));
    },

    async listOpenPositions() {
      const result = await pool.query(
        `SELECT source_signal_id, symbol, status, snapshot, updated_at
         FROM vst_positions WHERE status IN ('open', 'closing', 'unknown')
         ORDER BY updated_at, source_signal_id`,
      );
      return result.rows.map(positionFromRow);
    },

    // "closed" is terminal: the worker only ever polls status IN ('open',
    // 'closing', 'unknown'), and a closed position's originating signal is
    // marked 'closed' too (outside getPending()'s pending/planning/opening
    // set), so nothing revisits or mutates this snapshot afterward. Covers
    // both the bot's own exit flow and resolvePositionAsClosed below -- the
    // two are told apart by the caller reading the stored snapshot fields
    // (manualResolution / closeReason), never re-derived here.
    async listRecentClosedPositions(limit = 10) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new RangeError("Recent closed VST position limit must be 1..50");
      }
      const result = await pool.query(
        `SELECT source_signal_id, symbol, status, snapshot, updated_at
         FROM vst_positions WHERE status = 'closed'
         ORDER BY updated_at DESC, source_signal_id DESC
         LIMIT $1`,
        [limit],
      );
      return result.rows.map(positionFromRow);
    },

    // "error" positions are the terminal outcome of an ambiguous close
    // abandon (see vst-worker.mjs CLOSE_ABANDON_OPERATIONS): no further
    // automated action is ever taken on them. They only leave this status
    // through an owner-attested manual resolution below.
    async listErrorPositions() {
      const result = await pool.query(
        `SELECT p.source_signal_id, p.symbol, p.status, p.snapshot, p.updated_at,
                s.reason AS signal_reason
         FROM vst_positions p
         JOIN vst_signals s ON s.source_signal_id = p.source_signal_id
         WHERE p.status = 'error'
         ORDER BY p.updated_at, p.source_signal_id`,
      );
      return result.rows.map((row) => ({
        ...positionFromRow(row),
        signalReason: row.signal_reason,
      }));
    },

    // Candidates are deliberately limited to the two known historical
    // failure shapes: an unprotected failed entry with a saved exchange order
    // ID, or a position whose failed margin top-up followed a reconciled
    // entry. A single tick may inspect at most two rows. Any unresolved intent
    // for the signal, including an exit or margin operation, protects it.
    async listFlatPositionCloseCandidates(limit = 1, options = {}) {
      return this.listHistoricalCloseCandidates(limit, { ...options, activeOnly: true });
    },

    async listHistoricalCloseCandidates(limit = 2, { after = null, activeOnly = false } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 2) {
        throw new RangeError("Historical VST close candidate limit must be 1..2");
      }
      if (after !== null &&
          (typeof after?.positionVersion !== "string" ||
           !Number.isFinite(Date.parse(after.positionVersion)) ||
           typeof after?.sourceSignalId !== "string" ||
           after.sourceSignalId.trim() === "")) {
        throw new TypeError("Historical VST close candidate cursor is invalid");
      }
      const result = await pool.query(
        `SELECT p.source_signal_id, p.symbol, p.status, p.snapshot, p.updated_at,
                to_char(p.updated_at AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS position_version,
                s.status AS signal_status, s.reason AS signal_reason,
                i.source_signal_id AS intent_source_signal_id,
                i.phase AS intent_phase, i.client_order_id AS intent_client_order_id,
                i.request AS intent_request, i.state AS intent_state,
                i.exchange_order_id AS intent_exchange_order_id,
                i.outcome AS intent_outcome, i.created_at AS intent_created_at,
                i.updated_at AS intent_updated_at
         FROM vst_positions p
         JOIN vst_signals s ON s.source_signal_id = p.source_signal_id
         JOIN vst_order_intents i ON i.source_signal_id = p.source_signal_id
           AND i.phase = 'market-entry'
         WHERE p.status IN ('error', 'open', 'unknown')
           AND (NOT $4::boolean OR p.status IN ('open', 'unknown'))
           AND ($1::timestamptz IS NULL OR
                (p.updated_at, p.source_signal_id) >
                ($1::timestamptz, $2::text))
           AND s.status IN ('error', 'unknown', 'open')
           AND p.snapshot->>'environment' = 'vst'
           AND p.snapshot->'manualResolution' IS NULL
           AND p.snapshot->>'symbol' = p.symbol
           AND p.snapshot->>'accountId' IS NOT NULL
           AND i.request->>'operation' = 'entry'
           AND i.request->>'environment' = 'vst'
           AND i.request->>'accountId' = p.snapshot->>'accountId'
           AND i.request->>'symbol' = p.symbol
           AND i.state IN ('failed', 'reconciled')
           AND i.exchange_order_id IS NOT NULL
           AND (
             p.snapshot->'verifiedFill' IS NOT NULL
             OR (
               i.outcome->>'status' = 'filled' AND
               i.outcome->>'verified' = 'true' AND
               i.outcome->>'fillPrice' IS NOT NULL AND
               i.outcome->>'fillQuantity' IS NOT NULL AND
               p.snapshot->>'entryAt' IS NOT NULL
             )
           )
           AND (
             (p.status = 'error' AND i.state = 'failed' AND
               i.outcome->>'reason' =
                 'entry_verification_abandoned_confirmed_open_unprotected')
             OR
             (p.status = 'error' AND i.state = 'reconciled' AND
               p.snapshot->'marginTopUp'->>'status' = 'failed' AND
               p.snapshot->'marginTopUp'->>'failureReason' =
                 'margin_top_up_abandoned_confirmed_not_applied')
             OR (
               p.status IN ('open', 'unknown')
               AND s.status IN ('open', 'unknown')
               AND i.state = 'reconciled'
               AND i.outcome->>'status' = 'filled'
               AND i.outcome->>'verified' = 'true'
               AND p.snapshot->>'sourceSignalId' = p.source_signal_id
               AND p.snapshot->>'entryOrderId' = i.exchange_order_id
               AND p.snapshot->>'exchangePositionId' = i.outcome->>'positionId'
               AND p.snapshot->>'coreOpen' = 'true'
               AND p.snapshot->>'runnerOpen' = 'false'
               AND (p.snapshot->>'patternId' <> 'impulse_buy'
                 OR p.snapshot->>'strategyAuthority' = 'source')
               AND p.snapshot->'split' IS NULL
               AND p.snapshot->'protectedExit' IS NULL
               AND p.snapshot->'externalClose' IS NULL
               AND p.snapshot->'exchangeExternalClose' IS NULL
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM vst_order_intents unresolved
             WHERE unresolved.source_signal_id = p.source_signal_id
               AND unresolved.state IN ('prepared', 'submitted', 'unknown')
           )
           AND NOT EXISTS (
             SELECT 1 FROM vst_events e
             WHERE e.source_signal_id = p.source_signal_id
               AND e.kind = 'exchange_history_provenance'
           )
         ORDER BY p.updated_at, p.source_signal_id
         LIMIT $3`,
        [after?.positionVersion ?? null, after?.sourceSignalId ?? null, limit, activeOnly],
      );
      return result.rows.map((row) => ({
        ...positionFromRow(row),
        positionVersion: row.position_version,
        signalStatus: row.signal_status,
        signalReason: row.signal_reason,
        entryIntent: intentFromRow({
          source_signal_id: row.intent_source_signal_id,
          phase: row.intent_phase,
          client_order_id: row.intent_client_order_id,
          request: row.intent_request,
          state: row.intent_state,
          exchange_order_id: row.intent_exchange_order_id,
          outcome: row.intent_outcome,
          created_at: row.intent_created_at,
          updated_at: row.intent_updated_at,
        }),
      }));
    },

    // This is not an owner/manual resolution and not an external-close
    // classification. It atomically preserves the failed-entry history,
    // writes the actual two exchange fills/fees, and transitions only the
    // exact, freshly corroborated stored candidate to closed.
    async reconcileHistoricalClose(candidate, evidence, {
      nowMs = Date.now(), clock = Date.now,
    } = {}) {
      const signalId = requireString(candidate?.sourceSignalId, "candidate.sourceSignalId");
      const accountId = requireString(candidate?.snapshot?.accountId, "candidate.snapshot.accountId");
      const symbol = requireString(candidate?.symbol, "candidate.symbol");
      const archiveWindows = await validatePersistedArchiveWindows(
        pool, evidence?.archiveWindows, accountId,
      );
      const now = toFiniteNumber(nowMs, "nowMs");
      if (typeof clock !== "function") {
        throw new TypeError("historical reconciliation clock must be a function");
      }
      if (typeof candidate.positionVersion !== "string" ||
          !Number.isFinite(Date.parse(candidate.positionVersion))) {
        throw new Error("vst_historical_close_candidate_version_missing");
      }
      const candidateSnapshotJson = serialize(candidate.snapshot, "historical close candidate snapshot");
      const intentPrecondition = (intent) => ({
        sourceSignalId: intent?.sourceSignalId,
        phase: intent?.phase,
        clientOrderId: intent?.clientOrderId,
        request: intent?.request,
        state: intent?.state,
        exchangeOrderId: intent?.exchangeOrderId,
        outcome: intent?.outcome,
      });
      const candidateIntentJson = serialize(
        intentPrecondition(candidate.entryIntent), "historical close candidate intent",
      );

      function evidenceDecimal(value, label, { signed = false } = {}) {
        const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
        const pattern = signed ? /^[+-]?\d+(?:\.\d+)?$/ : /^\d+(?:\.\d+)?$/;
        if (!pattern.test(text)) throw new TypeError(`${label} is invalid`);
        const negative = text.startsWith("-");
        const unsigned = text.replace(/^[+-]/, "");
        const [whole, fraction = ""] = unsigned.split(".");
        if (fraction.length > 30) throw new TypeError(`${label} is invalid`);
        return {
          amount: BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n),
          scale: fraction.length,
        };
      }
      function sameEvidenceDecimal(left, right, label, { signed = false } = {}) {
        const a = evidenceDecimal(left, label, { signed });
        const b = evidenceDecimal(right, label, { signed });
        const scale = Math.max(a.scale, b.scale);
        return a.amount * (10n ** BigInt(scale - a.scale)) ===
          b.amount * (10n ** BigInt(scale - b.scale));
      }
      function feeIsVerified(fee, label) {
        if (!fee || fee.asset !== "VST") {
          throw new Error(`vst_historical_close_${label}_fee_unknown`);
        }
        evidenceDecimal(fee.amount, `${label} fee`, { signed: true });
      }
      function positiveEvidence(value, label) {
        if (evidenceDecimal(value, label).amount <= 0n) {
          throw new Error(`vst_historical_close_${label}_invalid`);
        }
      }
      function rawIdentifier(value) {
        if (typeof value === "string" && value.trim() !== "") return value;
        if (typeof value === "number" && Number.isSafeInteger(value)) {
          return String(value);
        }
        return null;
      }
      function rawFillId(fill) {
        const values = [fill?.orderId, fill?.orderID]
          .filter((value) => value !== undefined && value !== null)
          .map(rawIdentifier);
        if (values.length === 0 || values.some((value) => value === null) ||
            new Set(values).size !== 1) {
          throw new Error("vst_historical_close_raw_fill_order_id_invalid");
        }
        return values[0];
      }
      function rawTradeId(fill) {
        const values = [fill?.tradeId, fill?.tradeID]
          .filter((value) => value !== undefined && value !== null)
          .map(rawIdentifier);
        if (values.length === 0 || values.some((value) => value === null) ||
            new Set(values).size !== 1) {
          throw new Error("vst_historical_close_raw_fill_trade_id_invalid");
        }
        return values[0];
      }
      function rawFillTime(fill) {
        const value = fill?.filledTm ?? fill?.filledTime ?? fill?.time ??
          fill?.timestamp ?? fill?.tradeTime;
        const time = typeof value === "string" &&
          !/^\d+(?:\.\d+)?$/.test(value) ? Date.parse(value) : Number(value);
        const millis = time < 100_000_000_000 ? time * 1000 : time;
        if (!Number.isSafeInteger(millis) || millis <= 0) {
          throw new Error("vst_historical_close_raw_fill_timestamp_invalid");
        }
        return millis;
      }

      const entryIntent = candidate.entryIntent;
      const storedFill = candidate.snapshot?.verifiedFill ?? (
        entryIntent?.outcome?.status === "filled" &&
          entryIntent.outcome.verified === true &&
          entryIntent.outcome.fillPrice !== undefined &&
          entryIntent.outcome.fillQuantity !== undefined &&
          candidate.snapshot?.entryAt !== undefined
          ? {
              price: entryIntent.outcome.fillPrice,
              quantity: entryIntent.outcome.fillQuantity,
              at: candidate.snapshot.entryAt,
            }
          : null
      );
      const closeFill = evidence?.closeFill;
      const entryFill = evidence?.entryFill;
      const observedAt = typeof evidence?.flatCheck?.observedAt === "string"
        ? Date.parse(evidence.flatCheck.observedAt) : NaN;
      if (!(candidate.status === "error" &&
            ["error", "unknown"].includes(candidate.signalStatus) ||
            isVerifiedEntryCloseCandidate(candidate)) ||
          candidate.snapshot?.environment !== "vst" ||
          candidate.snapshot?.symbol !== symbol ||
          candidate.snapshot?.manualResolution ||
          entryIntent?.sourceSignalId !== signalId ||
          entryIntent?.phase !== "market-entry" ||
          !["failed", "reconciled"].includes(entryIntent?.state) ||
          entryIntent?.request?.operation !== "entry" ||
          entryIntent?.request?.environment !== "vst" ||
          entryIntent?.request?.accountId !== accountId ||
          entryIntent?.request?.symbol !== symbol ||
          !entryIntent.exchangeOrderId ||
          evidence?.verified !== true || evidence.environment !== "vst" ||
          evidence.accountId !== accountId || evidence.sourceSignalId !== signalId ||
          evidence.symbol !== symbol || !evidence.positionId ||
          evidence.entryOrderId !== entryIntent.exchangeOrderId ||
          evidence.closeOrderId !== closeFill?.exchangeOrderId ||
          evidence?.flatCheck?.verified !== true ||
          evidence.flatCheck.environment !== "vst" ||
          evidence.flatCheck.accountId !== accountId ||
          evidence.flatCheck.symbol !== symbol ||
          evidence.flatCheck.positionQuantity !== "0" ||
          evidence.flatCheck.openOrderCount !== 0 ||
          evidence.flatCheck.positionId !== evidence.positionId ||
          !Number.isSafeInteger(observedAt) || observedAt > now + 2_000 ||
          now - observedAt > 30_000 ||
          !Array.isArray(evidence.fills) || evidence.fills.length !== 2 ||
          !Array.isArray(evidence.coverage) ||
          entryFill?.exchangeOrderId !== entryIntent.exchangeOrderId ||
          entryFill?.positionId !== evidence.positionId ||
          closeFill?.positionId !== evidence.positionId ||
          !corroborateHistoricalEntryPrice(storedFill?.price, entryFill?.price).verified ||
          !sameEvidenceDecimal(entryFill?.quantity, storedFill?.quantity, "entry quantity") ||
          !sameEvidenceDecimal(closeFill?.quantity, candidate.snapshot?.remainingQty,
            "close quantity") ||
          !sameEvidenceDecimal(closeFill?.quantity, entryFill?.quantity,
            "full close quantity") ||
          !evidence?.clientIdAttribution ||
          evidence.clientIdAttribution.savedClientOrderId !== entryIntent?.clientOrderId ||
          typeof entryFill?.at !== "string" || !Number.isFinite(Date.parse(entryFill.at)) ||
          typeof closeFill?.at !== "string" || !Number.isFinite(Date.parse(closeFill.at)) ||
          Date.parse(closeFill.at) < Date.parse(entryFill.at) ||
          typeof closeFill?.price !== "string" && typeof closeFill?.price !== "number") {
        throw new Error("vst_historical_close_proof_invalid");
      }
      assertHistoricalFillCoverage({
        coverage: evidence.coverage,
        coverageEndTs: evidence.coverageEndTs,
        fills: evidence.fills,
        archiveWindows,
        accountId,
        requiredStartBeforeMs: Date.parse(entryFill.at),
        requiredEndAtLeastMs: Date.parse(closeFill.at),
        freshReadAtMs: observedAt,
        nowMs: now,
      });
      positiveEvidence(entryFill.price, "entry_price");
      positiveEvidence(closeFill.price, "close_price");
      feeIsVerified(entryFill.fee, "entry");
      feeIsVerified(closeFill.fee, "close");
      const rawByOrderId = new Map();
      const rawTradeIds = new Set();
      for (const fill of evidence.fills) {
        const id = rawFillId(fill);
        const tradeId = rawTradeId(fill);
        if (rawByOrderId.has(id) || fill?.symbol !== `${symbol.slice(0, -4)}-USDT` ||
            String(fill?.positionSide ?? "").toUpperCase() !== "LONG") {
          throw new Error("vst_historical_close_raw_fills_ambiguous");
        }
        if (rawTradeIds.has(tradeId)) {
          throw new Error("vst_historical_close_raw_fills_ambiguous");
        }
        rawByOrderId.set(id, fill);
        rawTradeIds.add(tradeId);
      }
      const assertRawFillMatches = (raw, recorded, expectedSide, expectedType) => {
        if (!raw || String(raw.side ?? "").toUpperCase() !== expectedSide ||
            raw.type != null &&
              String(raw.type).toUpperCase() !== expectedType ||
            !sameEvidenceDecimal(raw.qty ?? raw.quantity ?? raw.volume,
              recorded.quantity, "raw fill quantity") ||
            !sameEvidenceDecimal(raw.price, recorded.price, "raw fill price") ||
            rawFillTime(raw) !== Date.parse(recorded.at) ||
            raw.commissionAsset !== "VST" ||
            !sameEvidenceDecimal(
              raw.commission ?? raw.fee ?? raw.commissionAmount ?? raw.feeAmount,
              recorded.fee.amount, "raw fill fee", { signed: true },
            )) {
          throw new Error("vst_historical_close_raw_fill_mismatch");
        }
      };
      assertRawFillMatches(
        rawByOrderId.get(evidence.entryOrderId), entryFill, "BUY",
        String(entryIntent.request.entryOrderType ?? "LIMIT").toUpperCase(),
      );
      assertRawFillMatches(
        rawByOrderId.get(evidence.closeOrderId), closeFill, "SELL",
        String(evidence.closeOrder?.type ?? "MARKET").toUpperCase(),
      );
      const rawCloseFill = rawByOrderId.get(evidence.closeOrderId);
      if (closeFill.realisedPnlAsset !== "USDT" ||
          closeFill.realisedPnlProvenance !== "bingx_fill_history.realisedPNL" ||
          rawCloseFill?.realisedPNL === undefined ||
          !sameEvidenceDecimal(rawCloseFill.realisedPNL, closeFill.realisedPnl,
            "raw close realised PnL", { signed: true })) {
        throw new Error("vst_historical_close_raw_fill_realised_pnl_mismatch");
      }
      if (rawByOrderId.size !== 2) {
        throw new Error("vst_historical_close_raw_fills_ambiguous");
      }

      const recordedEntryAt = storedFill?.at;
      const recordedEntryAtMs = typeof recordedEntryAt === "number"
        ? recordedEntryAt
        : typeof recordedEntryAt === "string" ? Date.parse(recordedEntryAt) : NaN;
      if (!Number.isFinite(recordedEntryAtMs) ||
          Date.parse(entryFill.at) > recordedEntryAtMs + 60_000 ||
          recordedEntryAtMs > Date.parse(closeFill.at) + 2_000 ||
          candidate.snapshot.exchangePositionId !== undefined &&
            candidate.snapshot.exchangePositionId !== evidence.positionId) {
        throw new Error("vst_historical_close_entry_proof_mismatch");
      }

      const reverified = verifyHistoricalCloseEvidence({
        candidate, entryOrder: evidence.entryOrder, closeOrder: evidence.closeOrder,
        fills: evidence.fills, coverage: evidence.coverage,
        coverageEndTs: evidence.coverageEndTs, archiveWindows,
        freshPositions: evidence.freshPositions, freshOpenOrders: evidence.freshOpenOrders,
        expectedExchangeClientOrderId: deriveVstExchangeClientOrderId(entryIntent.clientOrderId),
        accountId, observedAtMs: observedAt, nowMs: now,
      });
      return transaction(pool, async (client) => {
        if (archiveWindows?.length) {
          await lockFillArchiveScope(client, accountId);
          await validatePersistedArchiveWindows(client, archiveWindows, accountId);
        }
        await lockSignalIntents(client, signalId);
        const locked = await client.query(
          `SELECT p.source_signal_id, p.symbol, p.status, p.snapshot, p.updated_at,
                  to_char(p.updated_at AT TIME ZONE 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS position_version,
                  s.status AS signal_status, s.reason AS signal_reason
           FROM vst_positions p
           JOIN vst_signals s ON s.source_signal_id = p.source_signal_id
           WHERE p.source_signal_id = $1
           FOR UPDATE OF p, s`,
          [signalId],
        );
        const row = locked.rows[0];
        if (!row) return { kind: "not_found" };

        const priorEvent = await client.query(
          `SELECT id FROM vst_events
           WHERE source_signal_id = $1 AND kind = 'exchange_history_provenance'
           LIMIT 1`,
          [signalId],
        );
        if (row.status === "closed" && priorEvent.rowCount) {
          return { kind: "already_reconciled", position: positionFromRow(row) };
        }
        if (row.status !== candidate.status || row.symbol !== symbol ||
            row.position_version !== candidate.positionVersion ||
            row.signal_status !== candidate.signalStatus ||
            row.signal_reason !== candidate.signalReason ||
            serialize(row.snapshot, "stored historical close snapshot") !== candidateSnapshotJson ||
            priorEvent.rowCount) {
          return { kind: "precondition_changed" };
        }

        const entryResult = await client.query(
          `SELECT source_signal_id, phase, client_order_id, request, state,
                  exchange_order_id, outcome, created_at, updated_at
           FROM vst_order_intents
           WHERE source_signal_id = $1 AND phase = 'market-entry'
           FOR UPDATE`,
          [signalId],
        );
        const storedIntent = intentFromRow(entryResult.rows[0]);
        if (!storedIntent || serialize(intentPrecondition(storedIntent),
          "stored historical close intent") !==
            candidateIntentJson ||
            storedIntent.exchangeOrderId !== evidence.entryOrderId) {
          return { kind: "precondition_changed" };
        }
        const unresolved = await client.query(
          `SELECT phase, state FROM vst_order_intents
           WHERE source_signal_id = $1
             AND state IN ('prepared', 'submitted', 'unknown')
           FOR UPDATE`,
          [signalId],
        );
        if (unresolved.rowCount) return { kind: "protected_by_unresolved_intent" };

        const priorReason = row.signal_reason ?? null;
        const storedSnapshot = requirePlainObject(row.snapshot, "stored VST position snapshot");
        const fillAt = closeFill.at;
        const retainedCloseFill = {
          ...closeFill,
          provenance: "exchange_history_provenance",
          fee: { ...closeFill.fee },
          fees: { ...closeFill.fee },
        };
        const updatedSnapshot = {
          ...storedSnapshot,
          status: "closed",
          closedAt: fillAt,
          closeReason: "exchange_history_provenance",
          closeFill: retainedCloseFill,
          lastCloseFill: retainedCloseFill,
          remainingQty: 0,
          ...(typeof storedSnapshot.coreQty === "number" ? { coreQty: 0 } : {}),
          ...(typeof storedSnapshot.runnerQty === "number" ? { runnerQty: 0 } : {}),
          ...(typeof storedSnapshot.coreOpen === "boolean" ? { coreOpen: false } : {}),
          ...(typeof storedSnapshot.runnerOpen === "boolean" ? { runnerOpen: false } : {}),
          exchangeHistoryProvenance: {
            verified: true,
            environment: "vst",
            accountId,
            symbol,
            positionId: evidence.positionId,
            entryOrderId: evidence.entryOrderId,
            closeOrderId: evidence.closeOrderId,
            entryFill: { ...entryFill, fee: { ...entryFill.fee } },
            entryPriceCorroboration: reverified.entryPriceCorroboration,
            closeOrderType: String(reverified.closeOrder.type).toUpperCase(),
            closeTriggerOrderId: reverified.closeOrder.triggerOrderId ??
              reverified.closeOrder.triggerOrderID ?? null,
            closeFill: retainedCloseFill,
            fills: evidence.fills,
            coverage: evidence.coverage,
            ...(archiveWindows !== undefined ? { archiveWindows } : {}),
            coverageEndTs: evidence.coverageEndTs,
            clientIdAttribution: evidence.clientIdAttribution,
            exchangeFlatCheck: evidence.flatCheck,
            observedAt: evidence.observedAt,
            previousSignalStatus: row.signal_status,
            previousSignalReason: priorReason,
          },
        };
        const lockedNow = toFiniteNumber(clock(), "historical reconciliation clock");
        if (!Number.isSafeInteger(lockedNow) || lockedNow <= 0 ||
            lockedNow < observedAt - 2_000 || lockedNow - observedAt > 30_000) {
          throw new Error("vst_historical_close_flat_read_stale_after_lock");
        }
        const updatedPosition = await client.query(
          `UPDATE vst_positions
           SET status = 'closed', snapshot = $3::jsonb, updated_at = now()
           WHERE source_signal_id = $1 AND status = $4 AND snapshot = $2::jsonb
           RETURNING source_signal_id, symbol, status, snapshot, updated_at`,
          [signalId, candidateSnapshotJson, serialize(updatedSnapshot, "VST position"),
            candidate.status],
        );
        if (!updatedPosition.rowCount) return { kind: "precondition_changed" };
        const updatedSignal = await client.query(
          `UPDATE vst_signals SET status = 'closed', updated_at = now()
           WHERE source_signal_id = $1 AND status = $2
           RETURNING source_signal_id`,
          [signalId, row.signal_status],
        );
        if (!updatedSignal.rowCount) throw new Error("vst_historical_close_signal_cas_failed");
        await client.query(
          `INSERT INTO vst_events (source_signal_id, client_order_id, kind, detail)
           VALUES ($1, NULL, 'exchange_history_provenance', $2::jsonb)`,
          [signalId, serialize({
            sourceSignalId: signalId,
            symbol,
            accountId,
            previousSignalStatus: row.signal_status,
            previousSignalReason: priorReason,
            entryOrderId: evidence.entryOrderId,
            closeOrderId: evidence.closeOrderId,
            entryFill,
            closeFill: retainedCloseFill,
            fills: evidence.fills,
            coverage: evidence.coverage,
            coverageEndTs: evidence.coverageEndTs,
            clientIdAttribution: evidence.clientIdAttribution,
            exchangeFlatCheck: evidence.flatCheck,
          }, "VST historical close event detail")],
        );
        return {
          kind: "reconciled",
          position: positionFromRow(updatedPosition.rows[0]),
        };
      });
    },

    // A position can be stuck exactly as badly as an "error" position while
    // its own status stays "open": entry and its initial stop are verified,
    // but the post-entry margin top-up never reached a confirmed outcome
    // (BingX read-after-write couldn't prove it landed). That leaves
    // snapshot.marginTopUp.status === "pending" and halts the entire VST
    // pipeline (see vst-worker.mjs's unresolvedMarginTopUpBySymbol gate) --
    // yet listErrorPositions() above never surfaces it, so the owner has no
    // way to find or act on it from the app. Surface it here as its own
    // review category instead of silently hiding behind "open".
    async listMarginTopUpPendingPositions() {
      const result = await pool.query(
        `SELECT p.source_signal_id, p.symbol, p.status, p.snapshot, p.updated_at,
                s.reason AS signal_reason
         FROM vst_positions p
         JOIN vst_signals s ON s.source_signal_id = p.source_signal_id
         WHERE p.status = 'open' AND p.snapshot->'marginTopUp'->>'status' = 'pending'
         ORDER BY p.updated_at, p.source_signal_id`,
      );
      return result.rows.map((row) => ({
        ...positionFromRow(row),
        signalReason: row.signal_reason,
      }));
    },

    // Only the exchange-proven "not applied" failure is eligible. This is a
    // NEW one-shot operation, not a replay of the original ambiguous POST.
    async listRecoverableFailedMarginTopUps() {
      const result = await pool.query(
        `SELECT p.source_signal_id, p.symbol, p.status, p.snapshot, p.updated_at,
                i.client_order_id, i.phase, i.request, i.state, i.outcome,
                i.exchange_order_id, i.created_at AS intent_created_at,
                i.updated_at AS intent_updated_at
         FROM vst_positions p
         JOIN vst_order_intents i ON i.source_signal_id = p.source_signal_id
           AND i.phase = 'margin-top-up'
         WHERE p.status = 'error'
           AND p.snapshot->'marginTopUp'->>'status' = 'failed'
           AND p.snapshot->'marginTopUp'->>'failureReason' =
             'margin_top_up_abandoned_confirmed_not_applied'
           AND NOT (p.snapshot->'marginTopUp' ? 'manualResolution')
           AND i.state = 'failed'
           AND i.outcome->>'reason' = 'margin_top_up_abandoned_confirmed_not_applied'
           AND NOT EXISTS (
             SELECT 1 FROM vst_order_intents r
             WHERE r.source_signal_id = p.source_signal_id
               AND r.phase = 'margin-top-up-recovery'
           )
         ORDER BY p.updated_at LIMIT 20`,
      );
      return result.rows.map((row) => ({
        ...positionFromRow(row),
        failedIntent: {
          clientOrderId: row.client_order_id,
          request: row.request,
          outcome: row.outcome,
        },
      }));
    },

    // An older worker could falsely fail a *submitted* adjustment because
    // entry initialMargin did not change. Only these evidence-specific
    // terminal records are eligible for a read-only exchange-history repair.
    async listFailedSubmittedMarginTopUps() {
      const result = await pool.query(
        `SELECT p.source_signal_id, p.symbol, p.status, p.snapshot, p.updated_at,
                i.client_order_id, i.phase, i.request, i.state, i.outcome
         FROM vst_positions p
         JOIN vst_order_intents i ON i.source_signal_id = p.source_signal_id
         WHERE p.status = 'error'
           AND p.snapshot->'marginTopUp'->>'status' = 'failed'
           AND p.snapshot->'marginTopUp'->>'failureReason' =
             'margin_top_up_abandoned_confirmed_not_applied'
           AND NOT (p.snapshot->'marginTopUp' ? 'manualResolution')
           AND i.state = 'failed'
           AND i.request->>'operation' = 'margin_top_up'
           AND i.outcome->>'reason' = 'margin_top_up_abandoned_confirmed_not_applied'
           AND i.outcome->>'submissionErrorMessage' =
             'VST margin top-up was submitted but exact read-after-write margin change is unverified'
           AND NOT EXISTS (
             SELECT 1 FROM vst_order_intents later
             WHERE later.source_signal_id = i.source_signal_id
               AND later.request->>'operation' = 'margin_top_up'
               AND later.created_at > i.created_at
           )
         ORDER BY p.updated_at LIMIT 20`,
      );
      return result.rows.map((row) => ({
        ...positionFromRow(row),
        failedIntent: {
          sourceSignalId: row.source_signal_id, phase: row.phase,
          clientOrderId: row.client_order_id, state: row.state,
          request: row.request, outcome: row.outcome,
        },
      }));
    },

    // Explicit owner authorization is limited to these two existing VST
    // positions. No other historical failed margin attempt may opt into an
    // extra exchange write merely by having the same error text.
    async listRecoverableFailedPermissionMarginTopUps() {
      const result = await pool.query(
        `SELECT p.source_signal_id, p.symbol, p.status, p.snapshot, p.updated_at,
                i.client_order_id, i.phase, i.request, i.state, i.outcome
         FROM vst_positions p
         JOIN vst_order_intents i ON i.source_signal_id = p.source_signal_id
           AND i.phase = 'margin-top-up-recovery'
         WHERE p.status = 'error'
           AND ((p.source_signal_id = 'cab-signal-15471' AND p.symbol = 'HBARUSDT')
             OR (p.source_signal_id = 'cab-signal-15892' AND p.symbol = 'GRTUSDT'))
           AND p.snapshot->'marginTopUp'->>'status' = 'failed'
           AND p.snapshot->'marginTopUp'->>'failureReason' =
             'margin_top_up_abandoned_confirmed_not_applied'
           AND NOT (p.snapshot->'marginTopUp' ? 'manualResolution')
           AND i.state = 'failed'
           AND i.outcome->>'reason' = 'margin_top_up_abandoned_confirmed_not_applied'
           AND i.outcome->>'submissionErrorMessage' =
             'BingX live writes are disabled: explicit permission was not granted'
           AND i.outcome->>'isolatedMarginObserved' =
             i.request->>'expectedIsolatedMarginBefore'
           AND EXISTS (
             SELECT 1 FROM vst_order_intents first
             WHERE first.source_signal_id = p.source_signal_id
               AND first.phase = 'margin-top-up'
               AND first.state = 'failed'
               AND first.outcome->>'reason' = 'margin_top_up_abandoned_confirmed_not_applied'
           )
           AND NOT EXISTS (
             SELECT 1 FROM vst_order_intents next
             WHERE next.source_signal_id = p.source_signal_id
               AND next.phase = 'margin-top-up-permission-recovery'
           )
         ORDER BY p.updated_at LIMIT 20`,
      );
      return result.rows.map((row) => ({
        ...positionFromRow(row),
        recoveryPhase: "margin-top-up-permission-recovery",
        failedIntent: {
          clientOrderId: row.client_order_id,
          request: row.request,
          outcome: row.outcome,
        },
      }));
    },

    async prepareFailedMarginTopUpRecovery({
      sourceSignalId, clientOrderId, request, marker,
      recoveryPhase = "margin-top-up-recovery",
    }) {
      if (!["margin-top-up-recovery", "margin-top-up-permission-recovery"]
        .includes(recoveryPhase)) {
        throw new Error("Unsupported margin top-up recovery phase");
      }
      const permissionRecovery = recoveryPhase === "margin-top-up-permission-recovery";
      const signalId = requireString(sourceSignalId, "sourceSignalId");
      if (permissionRecovery &&
          !((signalId === "cab-signal-15471" && request?.symbol === "HBARUSDT") ||
            (signalId === "cab-signal-15892" && request?.symbol === "GRTUSDT"))) {
        return false;
      }
      const orderId = requireString(clientOrderId, "clientOrderId");
      const requestJson = serialize(request, "recovery request");
      return transaction(pool, async (client) => {
        await lockSignalIntents(client, signalId);
        const positionResult = await client.query(
          `SELECT source_signal_id, symbol, status, snapshot, updated_at
           FROM vst_positions WHERE source_signal_id = $1 FOR UPDATE`,
          [signalId],
        );
        const position = positionFromRow(positionResult.rows[0]);
        const oldResult = await client.query(
          `SELECT client_order_id, request, state, outcome FROM vst_order_intents
           WHERE source_signal_id = $1 AND phase = '${
             permissionRecovery ? "margin-top-up-recovery" : "margin-top-up"
           }' FOR UPDATE`,
          [signalId],
        );
        const old = oldResult.rows[0];
        const original = old?.request;
        if (!position || position.status !== "error" ||
            position.snapshot?.marginTopUp?.status !== "failed" ||
            position.snapshot.marginTopUp.failureReason !==
              "margin_top_up_abandoned_confirmed_not_applied" ||
            position.snapshot.marginTopUp.manualResolution ||
            old?.state !== "failed" ||
            old.outcome?.reason !== "margin_top_up_abandoned_confirmed_not_applied" ||
            (permissionRecovery &&
              old.outcome?.submissionErrorMessage !==
                "BingX live writes are disabled: explicit permission was not granted") ||
            !original ||
            old.outcome.isolatedMarginObserved !== original.expectedIsolatedMarginBefore ||
            request?.environment !== "vst" ||
            request?.operation !== "margin_top_up" ||
            request?.accountId !== original.accountId ||
            request?.symbol !== original.symbol || position.symbol !== original.symbol ||
            request?.positionId !== original.positionId ||
            request?.entryOrderId !== original.entryOrderId ||
            request?.stopOrderId !== original.stopOrderId ||
            String(request?.quantity) !== String(original.quantity) ||
            String(request?.stopLoss) !== String(original.stopLoss) ||
            String(request?.expectedIsolatedMarginBefore) !==
              String(original.expectedIsolatedMarginBefore) ||
            position.snapshot?.exchangePositionId !== original.positionId ||
            marker?.status !== "pending" ||
            String(marker.amount) !== String(request.amount) ||
            String(request.amount) !== String(request.approvedTopUpMargin)) {
          return false;
        }
        const inserted = await client.query(
          `INSERT INTO vst_order_intents
             (source_signal_id, phase, client_order_id, request, state)
           VALUES ($1, '${recoveryPhase}', $2, $3::jsonb, 'prepared')
           ON CONFLICT (source_signal_id, phase) DO NOTHING
           RETURNING client_order_id`,
          [signalId, orderId, requestJson],
        );
        if (!inserted.rowCount) return false;
      const { failureReason: _oldFailure, ...recoveryMarker } = marker;
      const snapshot = {
          ...position.snapshot,
          status: "open",
          marginTopUp: {
          ...recoveryMarker,
            previousAttempt: {
              clientOrderId: oldResult.rows[0].client_order_id ?? null,
              reason: old.outcome.reason,
            },
          },
        };
        await client.query(
          `UPDATE vst_positions SET status = 'open', snapshot = $2::jsonb, updated_at = now()
           WHERE source_signal_id = $1`,
          [signalId, serialize(snapshot, "recovery position")],
        );
        await client.query(
          `UPDATE vst_signals SET status = 'opening', reason = NULL, updated_at = now()
           WHERE source_signal_id = $1`,
          [signalId],
        );
        await client.query(
          `INSERT INTO vst_events (source_signal_id, client_order_id, kind, detail)
           VALUES ($1, $2, 'vst_margin_top_up_recovery_prepared', $3::jsonb)`,
          [signalId, orderId, serialize({
            symbol: request.symbol, positionId: request.positionId,
            amount: request.amount, originalIntentNotReplayed: true,
          }, "recovery event")],
        );
        return true;
      });
    },

    // Owner-attested resolution for a stuck margin top-up: the owner checked
    // BingX directly and the additional margin was NOT added, but the
    // position's original entry stop is unaffected (it was verified at entry
    // time, independent of this top-up). This does not fabricate exchange
    // evidence -- it records the honest negative fact the owner observed --
    // and lets vst-worker.mjs's blocking gate treat this symbol as resolved
    // (an owner-acknowledged "failed" top-up, not a still-pending one) so
    // the rest of the pipeline can continue. It intentionally leaves the
    // position status "open": the position is still real and still being
    // managed by its original stop, only with a smaller safety margin than
    // planned.
    async resolveMarginTopUpKeepOpen(sourceSignalId, { resolvedBy, note = null }) {
      const signalId = requireString(sourceSignalId, "sourceSignalId");
      requireString(resolvedBy, "resolvedBy");
      if (note !== null && typeof note !== "string") throw new TypeError("note must be a string or null");
      return transaction(pool, async (client) => {
        await lockSignalIntents(client, signalId);
        const existing = await client.query(
          `SELECT source_signal_id, symbol, status, snapshot, updated_at
           FROM vst_positions WHERE source_signal_id = $1 FOR UPDATE`,
          [signalId],
        );
        const record = positionFromRow(existing.rows[0]);
        if (!record) throw new Error("vst_position_not_found");
        if (record.status !== "open" || record.snapshot?.marginTopUp?.status !== "pending") {
          throw new Error("vst_position_not_awaiting_margin_top_up_review");
        }
        // The original margin-top-up attempt left its own order intent
        // unresolved (state "prepared"/"submitted"/"unknown"), and
        // listUnresolvedIntents() blocks the ENTIRE pipeline -- not just this
        // symbol -- for as long as that row stays unresolved. Recording the
        // owner's resolution on the position alone would leave that global
        // gate in place forever. Settle the SAME intent row, identified by
        // its fixed phase name, atomically in this same transaction: a
        // locked read first confirms it is still in an unresolved state (a
        // later reconciliation could not have raced ahead of this lock), so
        // neither this call nor a concurrent tick can silently override the
        // other.
        const intentRow = await client.query(
          `SELECT client_order_id, state
           FROM vst_order_intents WHERE source_signal_id = $1 AND phase = 'margin-top-up' FOR UPDATE`,
          [signalId],
        );
        const intent = intentRow.rows[0] ?? null;
        if (!intent || !["prepared", "submitted", "unknown"].includes(intent.state)) {
          throw new Error("vst_margin_top_up_intent_not_unresolved");
        }
        await client.query(
          `UPDATE vst_order_intents
           SET state = 'failed', outcome = $2::jsonb, updated_at = now()
           WHERE source_signal_id = $1 AND phase = 'margin-top-up'`,
          [signalId, serialize({
            reason: "owner_confirmed_not_added_keep_open", resolvedBy, note,
          }, "VST order intent outcome")],
        );
        const resolvedSnapshot = {
          ...record.snapshot,
          marginTopUp: {
            ...record.snapshot.marginTopUp,
            status: "failed",
            failureReason: "owner_confirmed_not_added_keep_open",
            manualResolution: {
              outcome: "keep_open",
              resolvedBy,
              resolvedAt: new Date().toISOString(),
              note,
            },
          },
        };
        const positionResult = await client.query(
          `UPDATE vst_positions SET snapshot = $2::jsonb, updated_at = now()
           WHERE source_signal_id = $1
           RETURNING source_signal_id, symbol, status, snapshot, updated_at`,
          [signalId, serialize(resolvedSnapshot, "VST position")],
        );
        const signalResult = await client.query(
          `UPDATE vst_signals SET status = 'open', reason = NULL, updated_at = now()
           WHERE source_signal_id = $1
           RETURNING source_signal_id`,
          [signalId],
        );
        if (!signalResult.rowCount) throw new Error("vst_signal_not_found");
        await client.query(
          `INSERT INTO vst_events (source_signal_id, client_order_id, kind, detail)
           VALUES ($1, NULL, 'vst_margin_top_up_manually_resolved_keep_open', $2::jsonb)`,
          [signalId, serialize({ resolvedBy, note }, "VST event detail")],
        );
        return positionFromRow(positionResult.rows[0]);
      });
    },

    // This is a separate owner-authorized retirement, not a no-POST verdict.
    // Preserve the original request/outcome and commit all ledger changes together.
    async resolveLegacyPreRunnerCloseReview({
      sourceSignalId, clientOrderId, expectedIntent, expectedPositionSnapshot,
      review, position,
    }) {
      const signalId = requireString(sourceSignalId, "sourceSignalId");
      const orderId = requireString(clientOrderId, "clientOrderId");
      const ownerArchiveWindows = await validatePersistedArchiveWindows(
        pool, review?.evidence?.archiveWindows,
        requireString(expectedPositionSnapshot?.accountId, "expectedPositionSnapshot.accountId"),
      );
      const comparableIntent = (intent) => ({
        sourceSignalId: intent.sourceSignalId, phase: intent.phase,
        clientOrderId: intent.clientOrderId, state: intent.state,
        request: intent.request, outcome: intent.outcome,
        exchangeOrderId: intent.exchangeOrderId,
      });
      const refuse = (reason) => ({ kind: "refused", reason });
      return transaction(pool, async (client) => {
        if (ownerArchiveWindows?.length) {
          const accountId = requireString(
            expectedPositionSnapshot?.accountId, "expectedPositionSnapshot.accountId",
          );
          await lockFillArchiveScope(client, accountId);
          await validatePersistedArchiveWindows(client, ownerArchiveWindows, accountId);
        }
        await lockSignalIntents(client, signalId);
        const signalResult = await client.query(
          `SELECT source_signal_id, status FROM vst_signals
           WHERE source_signal_id = $1 FOR UPDATE`, [signalId],
        );
        const positionResult = await client.query(
          `SELECT source_signal_id, symbol, status, snapshot, updated_at
           FROM vst_positions WHERE source_signal_id = $1 FOR UPDATE`, [signalId],
        );
        const intentResult = await client.query(
          `SELECT source_signal_id, phase, client_order_id, request, state,
                  exchange_order_id, outcome, created_at, updated_at
           FROM vst_order_intents WHERE source_signal_id = $1
             AND client_order_id = $2 FOR UPDATE`, [signalId, orderId],
        );
        const record = positionFromRow(positionResult.rows[0]);
        const intent = intentFromRow(intentResult.rows[0]);
        if (!record || !intent || !signalResult.rows[0]) {
          return refuse("legacy_pre_runner_close_not_found");
        }
        const priorReview = intent.outcome?.ownerPreRunnerCloseReview;
        if (validObject(priorReview) && intent.state === "failed") {
          return { kind: "replayed", position: record, review: priorReview };
        }
        const request = intent.request;
        const snapshot = record.snapshot;
        const split = snapshot?.split;
        if (!validObject(expectedIntent) ||
            serialize(comparableIntent(intent), "locked intent") !==
              serialize(comparableIntent(expectedIntent), "expected intent") ||
            serialize(snapshot, "locked position") !==
              serialize(expectedPositionSnapshot, "expected position")) {
          return refuse("legacy_pre_runner_review_state_changed");
        }
        if (intent.state !== "unknown" ||
            request?.operation !== "close_pre_runner_split" ||
            request.environment !== "vst" || request.sourceExit ||
            request.sourceSignalId !== signalId || request.closeIntentId !== orderId ||
            !/^impulse-runner-breakeven-abort-\d+$/.test(intent.phase) ||
            orderId !== `vst-${createHash("sha256").update(`${signalId}:${intent.phase}`).digest("hex").slice(0, 30)}` ||
            !["open", "closing", "unknown", "error"].includes(record.status) ||
            snapshot?.environment !== "vst" || snapshot.sourceSignalId !== signalId ||
            snapshot.accountId !== request.accountId || snapshot.symbol !== request.symbol ||
            record.symbol !== request.symbol || snapshot.patternId !== "impulse_buy" ||
            split?.stage !== "runner_pending" ||
            snapshot.exchangePositionId !== request.positionId ||
            split.positionId !== request.positionId ||
            !validObject(review) || !["open", "closed"].includes(review.outcome)) {
          return refuse("legacy_pre_runner_close_not_eligible");
        }
        requireString(review.resolvedBy, "review.resolvedBy");
        if (review.note !== null && (typeof review.note !== "string" || review.note.length > 2000)) {
          return refuse("owner_review_fields_invalid");
        }
        const evidence = review.evidence;
        const checkedAt = Date.parse(review.checkedAt);
        const observedAt = Date.parse(evidence?.observedAt);
        const now = Date.now();
        if (!Number.isSafeInteger(checkedAt) || !Number.isSafeInteger(observedAt) ||
            observedAt > checkedAt || checkedAt > now ||
            now - observedAt > READ_ONLY_RECOVERY_MAX_EVIDENCE_AGE_MS ||
            evidence.verified !== true || evidence.environment !== "vst" ||
            evidence.accountId !== snapshot.accountId || evidence.symbol !== snapshot.symbol ||
            evidence.positionId !== split.positionId) {
          return refuse("legacy_pre_runner_review_evidence_stale_or_mismatched");
        }
        let nextSnapshot;
        let verifiedCloseEvidence;
        if (review.outcome === "open") {
          const equal = (a, b) => compareExactDecimals(a, b) === 0;
          const stops = evidence.stops;
          if (!equal(evidence.quantity, split.totalQuantity) ||
              !equal(split.totalQuantity, request.totalQuantity) ||
              !equal(snapshot.remainingQty, split.totalQuantity) ||
              !Array.isArray(stops) || stops.length !== 2 ||
              new Set(stops.map((stop) => stop.orderId)).size !== 2) {
            return refuse("legacy_pre_runner_open_evidence_mismatch");
          }
          const expectedStops = [
            { orderId: split.originalStopOrderId, positionId: split.positionId,
              quantity: split.totalQuantity, stopPrice: split.signalStopPrice },
            split.coreStop,
          ];
          const requestedStops = [request.originalStop, request.coreStop];
          for (let index = 0; index < 2; index++) {
            const expected = expectedStops[index];
            const stop = stops.find((row) => row.orderId === expected?.orderId);
            const requested = requestedStops[index];
            if (!stop || !requested || stop.positionId !== split.positionId ||
                requested.orderId !== expected.orderId ||
                !equal(stop.quantity, expected.quantity) ||
                !equal(stop.stopPrice, expected.stopPrice) ||
                !equal(requested.quantity, expected.quantity) ||
                !equal(requested.stopPrice, expected.stopPrice)) {
              return refuse("legacy_pre_runner_owned_stops_mismatch");
            }
          }
          nextSnapshot = { ...snapshot, status: "closing" };
        } else {
          const entryResult = await client.query(
            `SELECT source_signal_id, phase, client_order_id, request, state,
                    exchange_order_id, outcome, created_at, updated_at
             FROM vst_order_intents WHERE source_signal_id = $1
               AND phase = 'market-entry' FOR UPDATE`, [signalId],
          );
          const entryIntent = intentFromRow(entryResult.rows[0]);
          if (!entryIntent || !evidence.entryIntent ||
              serialize(comparableIntent(entryIntent), "locked entry") !==
                serialize(comparableIntent(evidence.entryIntent), "expected entry")) {
            return refuse("legacy_pre_runner_entry_evidence_changed");
          }
          const candidate = {
            sourceSignalId: signalId, symbol: record.symbol, status: record.status,
            snapshot, entryIntent, closeIntent: intent, ownerPreRunnerCloseReview: true,
          };
          const verified = verifyHistoricalCloseEvidence({
            candidate, entryOrder: evidence.entryOrder, closeOrder: evidence.closeOrder,
            contract: evidence.contract,
            ...(evidence.lifecycleVersion === 2 || evidence.closeOrders !== undefined ||
                evidence.stopOrders !== undefined
              ? { closeOrders: evidence.closeOrders, stopOrders: evidence.stopOrders } : {}),
            fills: evidence.fills, coverage: evidence.coverage,
            ...(ownerArchiveWindows !== undefined ? { archiveWindows: ownerArchiveWindows } : {}),
            coverageEndTs: evidence.coverageEndTs,
            freshPositions: evidence.freshPositions, freshOpenOrders: evidence.freshOpenOrders,
            expectedExchangeClientOrderId: deriveVstExchangeClientOrderId(entryIntent.clientOrderId),
            expectedCloseExchangeClientOrderId: deriveVstExchangeClientOrderId(intent.clientOrderId),
            accountId: snapshot.accountId, observedAtMs: observedAt, nowMs: now,
          });
          if (serialize(verified.closeFill, "verified close") !==
              serialize(evidence.closeFill, "submitted close")) {
            return refuse("legacy_pre_runner_close_fill_mismatch");
          }
          verifiedCloseEvidence = verified;
          assertFullCloseQuantity(verified.closeFill.quantity, snapshot);
          nextSnapshot = {
            ...snapshot, status: "closed", remainingQty: 0,
            closedAt: verified.closeFill.at,
            closeReason: "owner_reviewed_legacy_pre_runner_close",
            closeFill: verified.closeFill,
            lastCloseFill: verified.closeFill,
            ...(typeof snapshot.coreQty === "number" ? { coreQty: 0 } : {}),
            ...(typeof snapshot.runnerQty === "number" ? { runnerQty: 0 } : {}),
            ...(typeof snapshot.coreOpen === "boolean" ? { coreOpen: false } : {}),
            ...(typeof snapshot.runnerOpen === "boolean" ? { runnerOpen: false } : {}),
            // Reuse the exchange accounting view, which never computes a
            // replacement PnL from rounded prices or converts native VST fees.
            exchangeHistoryProvenance: {
              verified: true, environment: "vst", accountId: snapshot.accountId,
              symbol: snapshot.symbol, positionId: verified.positionId,
              entryFill: verified.entryFill, closeFill: verified.closeFill,
              entryOrderId: verified.entryOrderId, closeOrderId: verified.closeOrderId,
              ...(ownerArchiveWindows !== undefined
                ? { archiveWindows: ownerArchiveWindows } : {}),
              ...(verified.lifecycleVersion === 2 ? {
                lifecycleVersion: 2,
                entryFills: verified.entryFills, closeFills: verified.closeFills,
                closeOrderIds: verified.closeOrderIds,
                ...(verified.priceRounding ? { priceRounding: verified.priceRounding } : {}),
              } : {}),
              observedAt: verified.observedAt, fundingStatus: "unverified",
            },
            manualResolution: {
              outcome: "closed", provenance: "verified_exchange_fill",
              resolvedBy: review.resolvedBy, resolvedAt: review.checkedAt,
              note: review.note, exchangeFlatCheck: verified.flatCheck,
            },
          };
        }
        // The caller cannot smuggle unrelated policy changes into this transaction.
        const expectedNext = { ...snapshot, status: review.outcome === "open" ? "closing" : "closed",
          ...(review.outcome === "closed" ? { remainingQty: 0 } : {}) };
        if (serialize(position, "proposed position") !== serialize(expectedNext, "expected next position")) {
          return refuse("legacy_pre_runner_position_transition_mismatch");
        }
        // Keep reconstructed accounting, not caller-provided component totals.
        // The complete raw proof is reverified against the locked candidate.
        const savedEvidence = { ...evidence, ...(verifiedCloseEvidence ?? {}) };
        // SQL timestamps on intent records are Date objects, not JSON proof.
        // Persist the exact comparison fields, not redundant candidate wrappers.
        delete savedEvidence.candidate;
        if (savedEvidence.entryIntent) {
          savedEvidence.entryIntent = comparableIntent(savedEvidence.entryIntent);
        }
        const savedReview = { ...review, confirmation: true, evidence: savedEvidence, originalOutcome: intent.outcome };
        const nextOutcome = { ...(intent.outcome ?? {}), ownerPreRunnerCloseReview: savedReview };
        if (Date.now() - observedAt > READ_ONLY_RECOVERY_MAX_EVIDENCE_AGE_MS) {
          return refuse("legacy_pre_runner_review_evidence_stale");
        }
        const updatedPosition = await client.query(
          `UPDATE vst_positions SET status = $2, snapshot = $3::jsonb, updated_at = now()
           WHERE source_signal_id = $1
           RETURNING source_signal_id, symbol, status, snapshot, updated_at`,
          [signalId, nextSnapshot.status, serialize(nextSnapshot, "resolved position")],
        );
        const updatedIntent = await client.query(
          `UPDATE vst_order_intents SET state = 'failed', outcome = $3::jsonb, updated_at = now()
           WHERE source_signal_id = $1 AND client_order_id = $2 AND state = 'unknown'
           RETURNING client_order_id`,
          [signalId, orderId, serialize(nextOutcome, "reviewed intent outcome")],
        );
        const updatedSignal = await client.query(
          `UPDATE vst_signals SET status = $2, reason = $3, updated_at = now()
           WHERE source_signal_id = $1 RETURNING source_signal_id`,
          [signalId, review.outcome === "open" ? "error" : "closed",
            review.outcome === "open" ? "owner_reviewed_legacy_pre_runner_close_still_open" : null],
        );
        if (!updatedPosition.rowCount || !updatedIntent.rowCount || !updatedSignal.rowCount) {
          throw new Error("legacy_pre_runner_review_atomic_transition_failed");
        }
        await client.query(
          `INSERT INTO vst_events (source_signal_id, client_order_id, kind, detail)
           VALUES ($1, $2, 'vst_pre_runner_close_owner_reviewed', $3::jsonb)`,
          [signalId, orderId, serialize(savedReview, "owner review event")],
        );
        return { kind: "resolved", position: positionFromRow(updatedPosition.rows[0]), review: savedReview };
      });
    },

    // Adopt only read-only proof that this legacy close's position is still
    // protected and open. This retires the ambiguous historical intent; it is
    // not a verdict that the old exchange mutation was never sent.
    async adoptPreRunnerOpenForSourceExit({
      sourceSignalId, clientOrderId, expectedIntent, expectedPositionSnapshot,
      expectedSourceExitRequest, evidence,
    }) {
      const signalId = requireString(sourceSignalId, "sourceSignalId");
      const orderId = requireString(clientOrderId, "clientOrderId");
      const refuse = (reason) => ({ kind: "refused", reason });
      const comparableIntent = (intent) => ({
        sourceSignalId: intent?.sourceSignalId,
        phase: intent?.phase,
        clientOrderId: intent?.clientOrderId,
        state: intent?.state,
        request: intent?.request,
        outcome: intent?.outcome,
        exchangeOrderId: intent?.exchangeOrderId,
      });
      const millis = (value) => {
        const parsed = typeof value === "number" ? value : Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
      };
      const nativeIdentifierAliases = (row, ...keys) => {
        const values = keys.map((key) => row?.[key])
          .filter((value) => value !== undefined && value !== null);
        if (values.length === 0) return null;
        const identifiers = values.map(exactNativeIdentifier);
        return identifiers.some((value) => value === null) ||
            new Set(identifiers).size !== 1
          ? null : identifiers[0];
      };
      const withinOneTick = (left, right, tick) => {
        try {
          const a = new Decimal(String(left));
          const b = new Decimal(String(right));
          const step = new Decimal(String(tick));
          return a.isFinite() && b.isFinite() && step.isFinite() &&
            step.gt(0) && a.minus(b).abs().lte(step);
        } catch {
          return false;
        }
      };

      return transaction(pool, async (client) => {
        await lockSignalIntents(client, signalId);
        const signalResult = await client.query(
          `SELECT source_signal_id, body, status FROM vst_signals
           WHERE source_signal_id = $1 FOR UPDATE`, [signalId],
        );
        const positionResult = await client.query(
          `SELECT source_signal_id, symbol, status, snapshot, updated_at
           FROM vst_positions WHERE source_signal_id = $1 FOR UPDATE`, [signalId],
        );
        const intentResult = await client.query(
          `SELECT source_signal_id, phase, client_order_id, request, state,
                  exchange_order_id, outcome, created_at, updated_at
           FROM vst_order_intents WHERE source_signal_id = $1
             AND client_order_id = $2 FOR UPDATE`, [signalId, orderId],
        );
        // Lock every intent for the signal, not merely the legacy and entry
        // rows, so another unresolved operation cannot race this decision.
        const allIntentsResult = await client.query(
          `SELECT source_signal_id, phase, client_order_id, request, state,
                  exchange_order_id, outcome, created_at, updated_at
           FROM vst_order_intents WHERE source_signal_id = $1 FOR UPDATE`,
          [signalId],
        );
        const entryResult = await client.query(
          `SELECT source_signal_id, phase, client_order_id, request, state,
                  exchange_order_id, outcome, created_at, updated_at
           FROM vst_order_intents WHERE source_signal_id = $1
             AND phase = 'market-entry' FOR UPDATE`, [signalId],
        );
        const sourceExitResult = await client.query(
          `SELECT id, source_signal_id, kind, detail, created_at::text AS created_at
           FROM vst_events WHERE source_signal_id = $1
             AND kind = 'source_exit_requested'
             AND ${sourceExitRequestPredicate("detail", "detail->'evidence'")}
             AND detail->>'requestId' = $2 FOR UPDATE`,
          [signalId, expectedSourceExitRequest?.requestId ??
            expectedSourceExitRequest?.id ?? ""],
        );
        const sourceExitRow = sourceExitResult.rows[0];
        const sourceExitRequest = sourceExitRequestFromEvent(sourceExitRow);
        const completionResult = sourceExitRow
          ? await client.query(
            `SELECT id FROM vst_events WHERE source_signal_id = $1
             AND kind = 'source_exit_completed'
             AND detail->>'requestId' = $2 FOR UPDATE`,
            [signalId, sourceExitRequest.requestId],
          )
          : { rowCount: 0, rows: [] };
        const record = positionFromRow(positionResult.rows[0]);
        const intent = intentFromRow(intentResult.rows[0]);
        const entryIntent = intentFromRow(entryResult.rows[0]);
        if (!signalResult.rows[0] || !record || !intent || !entryIntent ||
            !sourceExitRequest || !expectedSourceExitRequest ||
            completionResult.rowCount !== 0) {
          return refuse("pre_runner_source_exit_not_pending");
        }
        try {
          // Source polling refreshes the observation headers every few seconds.
          // They are not a new exit decision and must not invalidate a bounded
          // exchange proof. Keep the original evidence and every identity in
          // the comparison; completion is separately checked under this lock.
          const sourceExitDecision = (row) => ({
            id: row.id,
            requestId: row.requestId,
            sourceSignalId: row.sourceSignalId,
            symbol: row.symbol,
            reason: row.reason,
            evidence: row.evidence,
            createdAt: row.createdAt,
            eventId: row.eventId,
          });
          if (serialize(sourceExitDecision(sourceExitRequest), "locked source exit decision") !==
              serialize(sourceExitDecision(expectedSourceExitRequest), "expected source exit decision")) {
            return refuse("pre_runner_source_exit_changed");
          }
        } catch {
          return refuse("pre_runner_source_exit_changed");
        }
        if (!validObject(expectedIntent) ||
            serialize(comparableIntent(intent), "locked intent") !==
              serialize(comparableIntent(expectedIntent), "expected intent") ||
            serialize(record.snapshot, "locked position") !==
              serialize(expectedPositionSnapshot, "expected position")) {
          return refuse("pre_runner_open_adoption_state_changed");
        }
        if (allIntentsResult.rows.some((row) =>
          row.client_order_id !== orderId &&
          ["prepared", "submitted", "unknown"].includes(row.state))) {
          return refuse("pre_runner_open_adoption_competing_intent");
        }

        const request = intent.request;
        const snapshot = record.snapshot;
        const split = snapshot?.split;
        const phaseMatch = /^impulse-runner-breakeven-abort-(\d+)$/.exec(intent.phase);
        const expectedClientId = `vst-${createHash("sha256")
          .update(`${signalId}:${intent.phase}`).digest("hex").slice(0, 30)}`;
        const sourceSignalBody = signalResult.rows[0].body;
        const sourceBodySymbol = validObject(sourceSignalBody) ? sourceSignalBody.symbol : null;
        if (intent.state !== "unknown" || intent.exchangeOrderId !== null ||
            request?.operation !== "close_pre_runner_split" ||
            request.environment !== "vst" || request.sourceExit ||
            request.sourceSignalId !== signalId || request.closeIntentId !== orderId ||
            orderId !== expectedClientId || !phaseMatch ||
            !["closing", "open", "unknown"].includes(record.status) ||
            snapshot?.status !== record.status ||
            snapshot?.environment !== "vst" || snapshot.sourceSignalId !== signalId ||
            snapshot.accountId !== request.accountId || snapshot.symbol !== request.symbol ||
            sourceBodySymbol !== request.symbol || record.symbol !== request.symbol ||
            snapshot.patternId !== "impulse_buy" || split?.stage !== "runner_pending" ||
            snapshot.exchangePositionId !== request.positionId ||
            split.positionId !== request.positionId ||
            request.positionId !== split.positionId ||
            !validObject(intent.outcome) ||
            Object.hasOwn(intent.outcome, "mutationProvenance") ||
            !validObject(evidence) ||
            sourceExitRequest.sourceSignalId !== signalId ||
            sourceExitRequest.requestId !== sourceExitRequestId(signalId) ||
            sourceExitRequest.symbol !== request.symbol ||
            !validObject(sourceExitRequest.evidence) ||
            !["source_withdrawal", "source_closed"].includes(sourceExitRequest.reason) ||
            sourceExitRequest.evidence.sourceSignalId !== signalId ||
            sourceExitRequest.evidence.symbol !== request.symbol ||
            sourceExitRequest.evidence.reason !== sourceExitRequest.reason ||
            sourceExitRequest.reason === "source_withdrawal" &&
              sourceExitRequest.evidence.sourceStatus !== "reclassified" &&
              !isSourceCancellation(sourceExitRequest.evidence) ||
            sourceExitRequest.reason === "source_closed" &&
              !["cancelled", "profit", "stop_loss", "bu_stop", "expired"]
                .includes(sourceExitRequest.evidence.sourceStatus)) {
          return refuse("pre_runner_open_adoption_not_eligible");
        }

        const entryRequest = entryIntent.request;
        const entryOutcome = entryIntent.outcome;
        const entryProof = evidence?.entryProof;
        const entryOrder = evidence?.entryOrder;
        const verifiedFill = snapshot.verifiedFill;
        const nativeEntryOrderId = entryOrder && nativeIdentifierAliases(
          entryOrder, "orderId", "orderID",
        );
        const nativeEntryPositionId = entryOrder && nativeIdentifierAliases(
          entryOrder, "positionID", "positionId",
        );
        const nativeEntryClientOrderIds = entryOrder && [
          entryOrder.clientOrderId, entryOrder.clientOrderID,
        ].filter((value) => value !== undefined && value !== null);
        const expectedLinkedEntryClientOrderId = entryProof &&
          typeof entryProof.entryClientOrderId === "string"
          ? `vst-${createHash("sha256")
            .update(entryProof.entryClientOrderId).digest("hex").slice(0, 28)}`
          : null;
        const evidenceObservedAt = millis(evidence?.observedAt);
        const now = Date.now();
        if (!validObject(entryProof) || !validObject(entryOrder) ||
            !validObject(verifiedFill) ||
            entryIntent.phase !== "market-entry" || entryIntent.state !== "reconciled" ||
            entryIntent.sourceSignalId !== signalId ||
            entryRequest?.operation !== "entry" ||
            entryRequest.environment !== "vst" ||
            entryRequest.accountId !== snapshot.accountId ||
            entryRequest.symbol !== snapshot.symbol ||
            entryOutcome?.verified !== true || entryOutcome.status !== "filled" ||
            entryIntent.exchangeOrderId !== entryProof.entryOrderId ||
            nativeEntryOrderId !== entryProof.entryOrderId ||
            nativeEntryPositionId !== request.positionId ||
            entryOrder.symbol !== `${snapshot.symbol.slice(0, -4)}-USDT` ||
            entryOrder.status !== "FILLED" ||
            String(entryOrder.side ?? "").toUpperCase() !== "BUY" ||
            entryOrder.positionSide !== "LONG" ||
            entryOrder.type !== entryProof.entryOrderType ||
            nativeEntryClientOrderIds.some((value) =>
              value !== entryProof.entryClientOrderId &&
              value !== expectedLinkedEntryClientOrderId) ||
            !exactDecimalEqual(entryOrder.executedQty ??
              entryOrder.executedQuantity ?? entryOrder.cumExecQty ??
              entryOrder.filledQty, entryProof.quantity) ||
            entryOrder.origQty !== undefined && entryOrder.origQty !== null &&
              !exactDecimalEqual(entryOrder.origQty, entryProof.quantity) ||
            entryIntent.clientOrderId !== entryProof.entryClientOrderId ||
            entryOutcome.positionId !== request.positionId ||
            entryProof.positionId !== request.positionId ||
            entryProof.entryOrderType !== entryRequest.entryOrderType ||
            entryProof.entryOrderType !== snapshot.entryOrderType ||
            !["MARKET", "LIMIT"].includes(entryProof.entryOrderType) ||
            !exactDecimalEqual(entryProof.quantity, request.totalQuantity) ||
            !exactDecimalEqual(entryProof.quantity, split.totalQuantity) ||
            !exactDecimalEqual(entryProof.quantity, snapshot.remainingQty) ||
            !exactDecimalEqual(entryProof.quantity, entryRequest.quantity) ||
            !exactDecimalEqual(entryProof.quantity,
              entryOutcome.fillQuantity ?? entryOutcome.totalQuantity) ||
            entryOutcome.fillQuantity !== undefined &&
              !exactDecimalEqual(entryProof.quantity, entryOutcome.fillQuantity) ||
            entryOutcome.totalQuantity !== undefined &&
              !exactDecimalEqual(entryProof.quantity, entryOutcome.totalQuantity) ||
            !exactDecimalEqual(entryProof.quantity, verifiedFill.quantity) ||
            !exactDecimalEqual(entryProof.quantity, snapshot.quantity ?? entryProof.quantity) ||
            entryProof.intentCreatedAt !== entryRequest.intentCreatedAt ||
            entryProof.intentCreatedAt !== entryIntent.request.intentCreatedAt ||
            entryOutcome.fillPrice !== undefined &&
              !exactDecimalEqual(verifiedFill.price, entryOutcome.fillPrice) ||
            !exactDecimalEqual(verifiedFill.price, snapshot.entryPrice ?? verifiedFill.price) ||
            millis(verifiedFill.at) === null ||
            millis(snapshot.entryAt) === null ||
            millis(verifiedFill.at) !== millis(snapshot.entryAt)) {
          return refuse("pre_runner_open_adoption_entry_identity_mismatch");
        }
        const entryPriceTickSize = evidence?.entryPriceTickSize;
        const positionAveragePrice = evidence?.positionAveragePrice;
        try {
          const fillPrice = new Decimal(String(verifiedFill.price));
          const averagePrice = new Decimal(String(positionAveragePrice));
          const tickSize = new Decimal(String(entryPriceTickSize));
          if (!fillPrice.isFinite() || !fillPrice.gt(0) ||
              !averagePrice.isFinite() || !averagePrice.gt(0) ||
              !tickSize.isFinite() || !tickSize.gt(0) ||
              !withinOneTick(fillPrice, averagePrice, tickSize)) {
            return refuse("pre_runner_open_adoption_entry_average_price_mismatch");
          }
        } catch {
          return refuse("pre_runner_open_adoption_entry_average_price_mismatch");
        }

        const equal = exactDecimalEqual;
        const requestedStops = [request.originalStop, request.coreStop];
        const expectedStops = [
          { orderId: split.originalStopOrderId, positionId: split.positionId,
            quantity: split.totalQuantity, stopPrice: split.signalStopPrice },
          split.coreStop,
        ];
        const stops = evidence.stops;
        if (!Array.isArray(stops) || stops.length !== 2 ||
            new Set(stops.map((stop) => stop?.orderId)).size !== 2 ||
            !equal(evidence.quantity, request.totalQuantity) ||
            !equal(split.totalQuantity, request.totalQuantity) ||
            !equal(snapshot.remainingQty, split.totalQuantity) ||
            snapshot.quantity !== undefined &&
              !equal(snapshot.quantity, split.totalQuantity) ||
            !equal(split.coreStop?.quantity, new Decimal(String(split.totalQuantity))
              .mul("0.8").toString())) {
          return refuse("pre_runner_open_adoption_stop_mismatch");
        }
        for (let index = 0; index < expectedStops.length; index++) {
          const expected = expectedStops[index];
          const requested = requestedStops[index];
          const stop = stops.find((item) => item?.orderId === expected?.orderId);
          if (!expected || !requested || !stop ||
              expected.orderId !== requested.orderId ||
              stop.positionId !== split.positionId ||
              requested.positionId !== undefined && requested.positionId !== split.positionId ||
              !equal(stop.quantity, expected.quantity) ||
              !equal(stop.stopPrice, expected.stopPrice) ||
              !equal(requested.quantity, expected.quantity) ||
              !equal(requested.stopPrice, expected.stopPrice)) {
            return refuse("pre_runner_open_adoption_stop_mismatch");
          }
        }

        const observedAt = evidenceObservedAt;
        const coverageEndTs = evidence?.coverageEndTs;
        const entryIntentAt = millis(entryProof.intentCreatedAt);
        if (evidence?.verified !== true || evidence.environment !== "vst" ||
            evidence.accountId !== snapshot.accountId || evidence.symbol !== snapshot.symbol ||
            evidence.positionId !== request.positionId ||
            !Number.isSafeInteger(observedAt) || observedAt > now ||
            now - observedAt > READ_ONLY_RECOVERY_MAX_EVIDENCE_AGE_MS ||
            !Number.isSafeInteger(entryIntentAt) || entryIntentAt <= 0 ||
            !Number.isSafeInteger(coverageEndTs) || coverageEndTs > observedAt ||
            observedAt - coverageEndTs > MAX_PRE_RUNNER_OPEN_PROOF_AGE_MS ||
            !Array.isArray(evidence.entryFills) || evidence.entryFills.length === 0) {
          return refuse("pre_runner_open_adoption_history_invalid");
        }
        try {
          assertHistoricalFillCoverage({
            coverage: evidence.historyCoverage,
            coverageEndTs,
            fills: evidence.entryFills,
            requiredStartBeforeMs: entryIntentAt - 30_000,
            requiredEndAtLeastMs: coverageEndTs,
            freshReadAtMs: observedAt,
            nowMs: observedAt,
          maxSnapshotAgeMs: MAX_PRE_RUNNER_OPEN_PROOF_AGE_MS,
          });
        } catch {
          return refuse("pre_runner_open_adoption_history_invalid");
        }
        let totalEntryQuantity = new Decimal(0);
        let totalEntryNotional = new Decimal(0);
        const tradeIds = new Set();
        const exchangeSymbol = `${snapshot.symbol.slice(0, -4)}-USDT`;
        for (const fill of evidence.entryFills) {
          const ids = [fill?.tradeId, fill?.tradeID]
            .filter((value) => value !== undefined && value !== null)
            .map(exactNativeIdentifier);
          const fillOrderId = nativeIdentifierAliases(fill, "orderId", "orderID");
          const positionAliases = [fill?.positionID, fill?.positionId]
            .filter((value) => value !== undefined && value !== null);
          const fillPositionId = nativeIdentifierAliases(
            fill, "positionID", "positionId",
          );
          const fillQty = fill?.qty ?? fill?.quantity ?? fill?.volume;
          const fillPrice = fill?.price;
          const fillTime = millis(fill?.filledTm ?? fill?.filledTime ?? fill?.time ??
            fill?.timestamp ?? fill?.tradeTime);
          if (ids.length === 0 || ids.some((value) => value === null) ||
              new Set(ids).size !== 1 || tradeIds.has(ids[0]) ||
              fillOrderId !== entryProof.entryOrderId ||
              positionAliases.length > 0 && fillPositionId !== request.positionId ||
              fill?.symbol !== exchangeSymbol || fill?.side !== "BUY" ||
              fill?.positionSide !== "LONG" ||
              !exactDecimalEqual(fillQty, fillQty) ||
              !Number.isSafeInteger(fillTime) ||
              fillTime <= entryIntentAt - 30_000 || fillTime > coverageEndTs) {
            return refuse("pre_runner_open_adoption_entry_fill_mismatch");
          }
          try {
            const quantity = new Decimal(String(fillQty));
            const price = new Decimal(String(fillPrice));
            if (!quantity.isFinite() || !quantity.gt(0) ||
                !price.isFinite() || !price.gt(0)) {
              return refuse("pre_runner_open_adoption_entry_fill_mismatch");
            }
            totalEntryQuantity = totalEntryQuantity.plus(quantity);
            totalEntryNotional = totalEntryNotional.plus(quantity.mul(price));
          } catch {
            return refuse("pre_runner_open_adoption_entry_fill_mismatch");
          }
          tradeIds.add(ids[0]);
        }
        const expectedEntryNotional = new Decimal(String(verifiedFill.price))
          .mul(entryProof.quantity);
        const entryNotionalTolerance = new Decimal(String(entryPriceTickSize))
          .mul(entryProof.quantity);
        if (!equal(totalEntryQuantity.toString(), entryProof.quantity) ||
            totalEntryNotional.minus(expectedEntryNotional).abs()
              .gt(entryNotionalTolerance) ||
            !withinOneTick(entryOrder.avgPrice ?? entryOrder.averagePrice ??
              entryOrder.avgFillPrice ?? verifiedFill.price,
            verifiedFill.price, entryPriceTickSize)) {
          return refuse("pre_runner_open_adoption_entry_fill_mismatch");
        }

        const sourceExitAdoption = {
          reason: sourceExitRequest.reason,
          entryProof,
          observedAt: evidence.observedAt,
          sourceExitRequestId: sourceExitRequest.requestId,
        };
        const nextOutcome = {
          ...(intent.outcome ?? {}),
          originalExecution: "unknown_unproven",
          sourceExitCurrentPositionAdoption: sourceExitAdoption,
        };
        if (Date.now() - observedAt > READ_ONLY_RECOVERY_MAX_EVIDENCE_AGE_MS) {
          return refuse("pre_runner_open_adoption_evidence_stale");
        }
        const updatedIntent = await client.query(
          `UPDATE vst_order_intents
           SET state = 'failed', outcome = $4::jsonb, updated_at = now()
           WHERE source_signal_id = $1 AND client_order_id = $2 AND phase = $3
             AND state = 'unknown' AND exchange_order_id IS NULL
             AND request = $5::jsonb AND outcome = $6::jsonb
           RETURNING client_order_id`,
          [signalId, orderId, intent.phase,
            serialize(nextOutcome, "adopted legacy intent outcome"),
            serialize(intent.request, "legacy intent request"),
            serialize(intent.outcome, "legacy intent original outcome")],
        );
        if (!updatedIntent.rowCount) {
          return refuse("pre_runner_open_adoption_state_changed");
        }
        await client.query(
          `INSERT INTO vst_events (source_signal_id, client_order_id, kind, detail)
           VALUES ($1, $2, 'vst_pre_runner_open_adopted_for_source_exit', $3::jsonb)`,
          [signalId, orderId, serialize(sourceExitAdoption, "source exit adoption event")],
        );
        if (Date.now() - observedAt > READ_ONLY_RECOVERY_MAX_EVIDENCE_AGE_MS) {
          throw new Error("pre_runner_open_adoption_evidence_stale_at_commit");
        }
        return { kind: "adopted" };
      });
    },

    // Owner-attested resolution paths for a position stuck in "error". These
    // never match owner-entered fill facts against order history themselves.
    // An owner-attested resolution must instead include the worker's fresh,
    // exact-account VST flat/open-order check. Bot-submitted closes provide a
    // separate explicit verifiedExchangeFill proof.
    // Automatic resolution of a position that is no longer on the exchange
    // (closed by hand on BingX, liquidated, or closed by an order whose
    // outcome the bot never saw). The worker calls this only after repeated
    // fresh account reads over minutes showed the symbol flat with no open
    // orders and no in-flight write. Status changes to closed; no exit price
    // is invented (closeFill stays absent, the journal shows "—"). Unresolved
    // intents of this signal are retired with the same proof, since nothing
    // they could still do can change a flat symbol with no orders.
    async closeVerifiedFlatPosition(sourceSignalId, { observation }) {
      const signalId = requireString(sourceSignalId, "sourceSignalId");
      requirePlainObject(observation, "observation");
      return transaction(pool, async (client) => {
        const existing = await client.query(
          `SELECT source_signal_id, symbol, status, snapshot, updated_at
           FROM vst_positions WHERE source_signal_id = $1 FOR UPDATE`,
          [signalId],
        );
        const record = positionFromRow(existing.rows[0]);
        if (!record || !["open", "closing", "unknown"].includes(record.status)) return null;
        const snapshot = requirePlainObject(record.snapshot, "stored VST position snapshot");
        if (snapshot.environment !== "vst" || snapshot.accountId !== observation.accountId ||
            record.symbol !== observation.symbol) {
          throw new Error("vst_external_close_observation_mismatch");
        }
        const closedAt = new Date().toISOString();
        const closed = {
          ...snapshot,
          status: "closed",
          closedAt,
          closeReason: "external_close_verified_flat",
          remainingQty: 0,
          ...(typeof snapshot.coreQty === "number" ? { coreQty: 0 } : {}),
          ...(typeof snapshot.runnerQty === "number" ? { runnerQty: 0 } : {}),
          ...(typeof snapshot.coreOpen === "boolean" ? { coreOpen: false } : {}),
          ...(typeof snapshot.runnerOpen === "boolean" ? { runnerOpen: false } : {}),
          externalClose: { ...observation, previousStatus: record.status, resolvedAt: closedAt },
        };
        const positionResult = await client.query(
          `UPDATE vst_positions SET status = 'closed', snapshot = $2::jsonb, updated_at = now()
           WHERE source_signal_id = $1
           RETURNING source_signal_id, symbol, status, snapshot, updated_at`,
          [signalId, serialize(closed, "VST position")],
        );
        await client.query(
          `UPDATE vst_signals SET status = 'closed', reason = 'external_close_verified_flat', updated_at = now()
           WHERE source_signal_id = $1`,
          [signalId],
        );
        const retired = await client.query(
          `UPDATE vst_order_intents
           SET state = 'failed',
               outcome = COALESCE(outcome, '{}'::jsonb) || $2::jsonb,
               updated_at = now()
           WHERE source_signal_id = $1 AND state IN ('prepared', 'submitted', 'unknown')
           RETURNING client_order_id`,
          [signalId, serialize({ reason: "superseded_by_verified_flat_symbol", observedAt: observation.lastObservedAt },
            "VST intent outcome")],
        );
        await client.query(
          `INSERT INTO vst_events (source_signal_id, client_order_id, kind, detail)
           VALUES ($1, NULL, 'vst_external_close_verified', $2::jsonb)`,
          [signalId, serialize({
            ...observation, previousStatus: record.status,
            retiredIntents: retired.rows.map((row) => row.client_order_id),
          }, "VST event detail")],
        );
        return positionFromRow(positionResult.rows[0]);
      });
    },

    async resolvePositionAsClosed(sourceSignalId, {
      fill, resolvedBy, note = null, exchangeFlatCheck = null,
      verifiedExchangeFill = false,
    }) {
      const signalId = requireString(sourceSignalId, "sourceSignalId");
      requireString(resolvedBy, "resolvedBy");
      if (note !== null && typeof note !== "string") throw new TypeError("note must be a string or null");
      if (exchangeFlatCheck === null && verifiedExchangeFill !== true) {
        throw new Error("vst_manual_close_exchange_verification_required");
      }
      requirePlainObject(fill, "fill");
      const price = requirePositiveNumber(fill.price, "fill.price");
      const quantity = requirePositiveNumber(fill.quantity, "fill.quantity");
      const at = requireIsoTimestamp(fill.at, "fill.at");
      const exchangeOrderId = requireString(fill.exchangeOrderId, "fill.exchangeOrderId");
      requirePlainObject(fill.fee, "fill.fee");
      const feeAsset = requireString(fill.fee.asset, "fill.fee.asset");
      const feeAmount = requireNonNegativeNumber(fill.fee.amount, "fill.fee.amount");
      const normalizedFill = {
        price: String(price),
        quantity: String(quantity),
        at,
        exchangeOrderId,
        fee: { asset: feeAsset, amount: String(feeAmount) },
      };

      return transaction(pool, async (client) => {
        await guardLegacyPreRunnerReview(client, signalId);
        const existing = await client.query(
          `SELECT source_signal_id, symbol, status, snapshot, updated_at
           FROM vst_positions WHERE source_signal_id = $1 FOR UPDATE`,
          [signalId],
        );
        const record = positionFromRow(existing.rows[0]);
        if (!record) throw new Error("vst_position_not_found");
        if (record.status !== "error") throw new Error("vst_position_not_in_error_status");
        const snapshot = requirePlainObject(record.snapshot, "stored VST position snapshot");
        let verifiedFlatCheck = null;
        if (exchangeFlatCheck !== null) {
          requirePlainObject(exchangeFlatCheck, "exchangeFlatCheck");
          const flatSymbol = requireString(exchangeFlatCheck.symbol, "exchangeFlatCheck.symbol");
          const flatAccountId = requireString(exchangeFlatCheck.accountId, "exchangeFlatCheck.accountId");
          const flatObservedAt = requireIsoTimestamp(
            exchangeFlatCheck.observedAt, "exchangeFlatCheck.observedAt",
          );
          if (exchangeFlatCheck.verified !== true ||
              exchangeFlatCheck.environment !== "vst" ||
              snapshot.environment !== "vst" ||
              snapshot.symbol !== record.symbol ||
              flatAccountId !== snapshot.accountId ||
              flatSymbol !== record.symbol ||
              exchangeFlatCheck.positionQuantity !== "0" ||
              exchangeFlatCheck.openOrderCount !== 0) {
            throw new Error("vst_manual_close_exchange_flat_check_invalid");
          }
          verifiedFlatCheck = {
            verified: true,
            environment: "vst",
            accountId: flatAccountId,
            symbol: flatSymbol,
            positionQuantity: "0",
            openOrderCount: 0,
            observedAt: flatObservedAt,
          };
        }
        if (!verifiedFlatCheck && verifiedExchangeFill !== true) {
          throw new Error("vst_manual_close_exchange_verification_required");
        }
        const recordedFill = {
          ...normalizedFill,
          provenance: verifiedFlatCheck ? "owner_attested" : "exchange_verified_fill",
        };
        assertFullCloseQuantity(fill.quantity, snapshot);
        const resolvedSnapshot = {
          ...snapshot,
          status: "closed",
          closedAt: at,
          closeReason: "manual_owner_resolution",
          closeFill: recordedFill,
          lastCloseFill: recordedFill,
          remainingQty: 0,
          ...(typeof snapshot.coreQty === "number" ? { coreQty: 0 } : {}),
          ...(typeof snapshot.runnerQty === "number" ? { runnerQty: 0 } : {}),
          ...(typeof snapshot.coreOpen === "boolean" ? { coreOpen: false } : {}),
          ...(typeof snapshot.runnerOpen === "boolean" ? { runnerOpen: false } : {}),
          manualResolution: {
            outcome: "closed",
            provenance: verifiedFlatCheck ? "owner_attested" : "exchange_verified_fill",
            resolvedBy,
            resolvedAt: new Date().toISOString(),
            note,
            previousStatus: "error",
            ...(verifiedFlatCheck ? { exchangeFlatCheck: verifiedFlatCheck } : {}),
          },
        };
        const positionResult = await client.query(
          `UPDATE vst_positions SET status = 'closed', snapshot = $2::jsonb, updated_at = now()
           WHERE source_signal_id = $1
           RETURNING source_signal_id, symbol, status, snapshot, updated_at`,
          [signalId, serialize(resolvedSnapshot, "VST position")],
        );
        const signalResult = await client.query(
          `UPDATE vst_signals SET status = 'closed', reason = NULL, updated_at = now()
           WHERE source_signal_id = $1
           RETURNING source_signal_id`,
          [signalId],
        );
        if (!signalResult.rowCount) throw new Error("vst_signal_not_found");
        await client.query(
          `INSERT INTO vst_events (source_signal_id, client_order_id, kind, detail)
           VALUES ($1, NULL, 'vst_manual_resolution_closed', $2::jsonb)`,
          [signalId, serialize({
            resolvedBy,
            note,
            fill: recordedFill,
            provenance: verifiedFlatCheck ? "owner_attested" : "exchange_verified_fill",
            ...(verifiedFlatCheck ? { exchangeFlatCheck: verifiedFlatCheck } : {}),
          }, "VST event detail")],
        );
        return positionFromRow(positionResult.rows[0]);
      });
    },

    // The margin-top-up-pending counterpart to resolvePositionAsClosed
    // above: unlike an "error" position, this one never left status "open"
    // (only snapshot.marginTopUp.status stayed "pending"), so it needs its
    // own status/marker check rather than reusing the "error" gate. Requires
    // the exact same owner-attested, concrete fill facts. Also settles the
    // stuck margin-top-up intent (identified by its fixed phase name) in the
    // SAME transaction, exactly like resolveMarginTopUpKeepOpen does -- that
    // intent is what listUnresolvedIntents() uses to block the ENTIRE VST
    // pipeline, and closing the position alone would leave that gate in
    // place forever.
    async resolveMarginTopUpPositionAsClosed(sourceSignalId, { fill, resolvedBy, note = null }) {
      const signalId = requireString(sourceSignalId, "sourceSignalId");
      requireString(resolvedBy, "resolvedBy");
      if (note !== null && typeof note !== "string") throw new TypeError("note must be a string or null");
      requirePlainObject(fill, "fill");
      const price = requirePositiveNumber(fill.price, "fill.price");
      const quantity = requirePositiveNumber(fill.quantity, "fill.quantity");
      const at = requireIsoTimestamp(fill.at, "fill.at");
      const exchangeOrderId = requireString(fill.exchangeOrderId, "fill.exchangeOrderId");
      requirePlainObject(fill.fee, "fill.fee");
      const feeAsset = requireString(fill.fee.asset, "fill.fee.asset");
      const feeAmount = requireNonNegativeNumber(fill.fee.amount, "fill.fee.amount");
      const verifiedFill = {
        price: String(price),
        quantity: String(quantity),
        at,
        exchangeOrderId,
        fee: { asset: feeAsset, amount: String(feeAmount) },
      };

      return transaction(pool, async (client) => {
        await lockSignalIntents(client, signalId);
        const existing = await client.query(
          `SELECT source_signal_id, symbol, status, snapshot, updated_at
           FROM vst_positions WHERE source_signal_id = $1 FOR UPDATE`,
          [signalId],
        );
        const record = positionFromRow(existing.rows[0]);
        if (!record) throw new Error("vst_position_not_found");
        if (record.status !== "open" || record.snapshot?.marginTopUp?.status !== "pending") {
          throw new Error("vst_position_not_awaiting_margin_top_up_review");
        }
        const snapshot = requirePlainObject(record.snapshot, "stored VST position snapshot");
        assertFullCloseQuantity(fill.quantity, snapshot);
        const intentRow = await client.query(
          `SELECT client_order_id, state
           FROM vst_order_intents WHERE source_signal_id = $1 AND phase = 'margin-top-up' FOR UPDATE`,
          [signalId],
        );
        const intent = intentRow.rows[0] ?? null;
        if (!intent || !["prepared", "submitted", "unknown"].includes(intent.state)) {
          throw new Error("vst_margin_top_up_intent_not_unresolved");
        }
        await client.query(
          `UPDATE vst_order_intents
           SET state = 'failed', outcome = $2::jsonb, updated_at = now()
           WHERE source_signal_id = $1 AND phase = 'margin-top-up'`,
          [signalId, serialize({
            reason: "owner_closed_position_via_manual_review_close_now", resolvedBy, note,
          }, "VST order intent outcome")],
        );
        const resolvedSnapshot = {
          ...snapshot,
          status: "closed",
          closedAt: at,
          closeReason: "manual_owner_resolution",
          closeFill: verifiedFill,
          lastCloseFill: verifiedFill,
          remainingQty: 0,
          ...(typeof snapshot.coreQty === "number" ? { coreQty: 0 } : {}),
          ...(typeof snapshot.runnerQty === "number" ? { runnerQty: 0 } : {}),
          ...(typeof snapshot.coreOpen === "boolean" ? { coreOpen: false } : {}),
          ...(typeof snapshot.runnerOpen === "boolean" ? { runnerOpen: false } : {}),
          marginTopUp: {
            ...snapshot.marginTopUp,
            status: "abandoned",
            failureReason: "owner_closed_position_via_manual_review_close_now",
          },
          manualResolution: {
            outcome: "closed",
            resolvedBy,
            resolvedAt: new Date().toISOString(),
            note,
            previousStatus: "open_margin_top_up_pending",
          },
        };
        const positionResult = await client.query(
          `UPDATE vst_positions SET status = 'closed', snapshot = $2::jsonb, updated_at = now()
           WHERE source_signal_id = $1
           RETURNING source_signal_id, symbol, status, snapshot, updated_at`,
          [signalId, serialize(resolvedSnapshot, "VST position")],
        );
        const signalResult = await client.query(
          `UPDATE vst_signals SET status = 'closed', reason = NULL, updated_at = now()
           WHERE source_signal_id = $1
           RETURNING source_signal_id`,
          [signalId],
        );
        if (!signalResult.rowCount) throw new Error("vst_signal_not_found");
        await client.query(
          `INSERT INTO vst_events (source_signal_id, client_order_id, kind, detail)
           VALUES ($1, NULL, 'vst_margin_top_up_manually_resolved_closed', $2::jsonb)`,
          [signalId, serialize({ resolvedBy, note, fill: verifiedFill }, "VST event detail")],
        );
        return positionFromRow(positionResult.rows[0]);
      });
    },

    // The companion resolution: the owner checked BingX and the position is
    // still open. Every CLOSE_ABANDON_OPERATIONS operation targets a single
    // already-isolated leg or the sole remaining position, so when the close
    // never executed the pre-existing snapshot quantities already describe
    // reality -- remainingQty is still required from the caller (never
    // defaulted) so the owner actively confirms a real number off the
    // exchange rather than reflexively re-arming a stale one.
    async resolvePositionAsStillOpen(sourceSignalId, { remainingQty, resolvedBy, note = null }) {
      const signalId = requireString(sourceSignalId, "sourceSignalId");
      requireString(resolvedBy, "resolvedBy");
      if (note !== null && typeof note !== "string") throw new TypeError("note must be a string or null");
      // Zero (or negative) is refused, not treated as a valid "still open"
      // quantity: a flat position is a closed position, and re-arming it as
      // open with remainingQty=0 would leave position management watching a
      // position the exchange no longer has. A genuinely flat position must
      // go through resolvePositionAsClosed with real close-fill evidence
      // instead.
      const qty = requirePositiveNumber(remainingQty, "remainingQty");

      return transaction(pool, async (client) => {
        await guardLegacyPreRunnerReview(client, signalId);
        const existing = await client.query(
          `SELECT source_signal_id, symbol, status, snapshot, updated_at
           FROM vst_positions WHERE source_signal_id = $1 FOR UPDATE`,
          [signalId],
        );
        const record = positionFromRow(existing.rows[0]);
        if (!record) throw new Error("vst_position_not_found");
        if (record.status !== "error") throw new Error("vst_position_not_in_error_status");
        const snapshot = requirePlainObject(record.snapshot, "stored VST position snapshot");
        // Only one leg can be unambiguously re-priced from a single
        // owner-supplied quantity: when exactly one of core/runner is still
        // open (the ordinary case, since every abandoned close operation
        // targets a single isolated leg or the sole remaining position). If
        // both legs still show a nonzero quantity, this cannot know which
        // one the owner's number belongs to -- leave both leg fields
        // untouched rather than guess. remainingQty (the field position
        // management actually checks against the exchange) is always
        // corrected either way, so the worst case is a later per-leg stop
        // mismatch surfacing as "unknown" again for further review, never a
        // wrong trade action.
        let legUpdate = {};
        const hasCoreQty = typeof snapshot.coreQty === "number";
        const hasRunnerQty = typeof snapshot.runnerQty === "number";
        if (hasCoreQty && hasRunnerQty) {
          const coreOpen = Number(snapshot.coreQty) > 0;
          const runnerOpen = Number(snapshot.runnerQty) > 0;
          if (coreOpen && !runnerOpen) legUpdate = { coreQty: qty };
          else if (runnerOpen && !coreOpen) legUpdate = { runnerQty: qty };
        } else if (hasCoreQty) {
          legUpdate = { coreQty: qty };
        }
        const resolvedSnapshot = {
          ...snapshot,
          status: "open",
          remainingQty: qty,
          ...legUpdate,
          manualResolution: {
            outcome: "still_open",
            resolvedBy,
            resolvedAt: new Date().toISOString(),
            note,
            previousStatus: "error",
            confirmedRemainingQty: qty,
          },
        };
        const positionResult = await client.query(
          `UPDATE vst_positions SET status = 'open', snapshot = $2::jsonb, updated_at = now()
           WHERE source_signal_id = $1
           RETURNING source_signal_id, symbol, status, snapshot, updated_at`,
          [signalId, serialize(resolvedSnapshot, "VST position")],
        );
        const signalResult = await client.query(
          `UPDATE vst_signals SET status = 'open', reason = NULL, updated_at = now()
           WHERE source_signal_id = $1
           RETURNING source_signal_id`,
          [signalId],
        );
        if (!signalResult.rowCount) throw new Error("vst_signal_not_found");
        await client.query(
          `INSERT INTO vst_events (source_signal_id, client_order_id, kind, detail)
           VALUES ($1, NULL, 'vst_manual_resolution_still_open', $2::jsonb)`,
          [signalId, serialize({ resolvedBy, note, remainingQty: qty }, "VST event detail")],
        );
        return positionFromRow(positionResult.rows[0]);
      });
    },

    async reserveIntent({ sourceSignalId, phase, clientOrderId, request }) {
      const signalId = requireString(sourceSignalId, "sourceSignalId");
      const phaseName = requireString(phase, "phase");
      const orderId = requireString(clientOrderId, "clientOrderId");
      const serialized = serialize(request ?? {}, "VST order intent");
      // prepareIntentRequest (vst-worker.mjs) already tries to reuse the
      // persisted intentCreatedAt so a routine re-entry into an existing
      // phase serializes identically to what is stored. That lookup runs
      // before this transaction and is not atomic with it, so a rare timing
      // gap can still leave it stamping a fresh timestamp even though every
      // real order fact is unchanged. Comparing with intentCreatedAt
      // excluded makes this transactional check the authoritative guard: a
      // genuine difference in any other field still throws below.
      const comparableSerialized = serialize(
        withoutIntentTimestamp(request ?? {}), "VST order intent",
      );
      return transaction(pool, async (client) => {
        await lockSignalIntents(client, signalId);
        // Keep this order aligned with historical reconciliation and manual
        // resolution: ledger position/signal rows precede any intent row lock.
        const positionState = await client.query(
          `SELECT status FROM vst_positions WHERE source_signal_id = $1 FOR UPDATE`,
          [signalId],
        );
        const signalState = await client.query(
          `SELECT status FROM vst_signals WHERE source_signal_id = $1 FOR UPDATE`,
          [signalId],
        );
        const existing = await client.query(
          `SELECT source_signal_id, phase, client_order_id, request, state,
                  exchange_order_id, outcome, created_at, updated_at
           FROM vst_order_intents WHERE source_signal_id = $1 AND phase = $2 FOR UPDATE`,
          [signalId, phaseName],
        );
        const existingIntent = intentFromRow(existing.rows[0]);
        if (existingIntent) {
          if (existingIntent.clientOrderId !== orderId ||
              serialize(withoutIntentTimestamp(existingIntent.request),
                "stored VST intent") !== comparableSerialized) {
            throw new Error("VST intent phase already exists with conflicting order facts");
          }
          return { kind: "existing", intent: existingIntent };
        }
        if (signalState.rows[0]?.status === "closed" ||
            positionState.rows[0]?.status === "closed") {
          throw new Error("VST closed source cannot reserve a new order intent");
        }
        const inserted = await client.query(
          `INSERT INTO vst_order_intents
             (source_signal_id, phase, client_order_id, request, state)
           VALUES ($1, $2, $3, $4::jsonb, 'prepared')
           ON CONFLICT (source_signal_id, phase) DO NOTHING
           RETURNING source_signal_id, phase, client_order_id, request, state,
                     exchange_order_id, outcome, created_at, updated_at`,
          [signalId, phaseName, orderId, serialized],
        );
        if (inserted.rowCount) return { kind: "new", intent: intentFromRow(inserted.rows[0]) };
        const conflicted = await client.query(
          `SELECT source_signal_id, phase, client_order_id, request, state,
                  exchange_order_id, outcome, created_at, updated_at
           FROM vst_order_intents WHERE source_signal_id = $1 AND phase = $2 FOR UPDATE`,
          [signalId, phaseName],
        );
        const intent = intentFromRow(conflicted.rows[0]);
        if (!intent || intent.clientOrderId !== orderId ||
            serialize(withoutIntentTimestamp(intent.request), "stored VST intent") !==
              comparableSerialized) {
          throw new Error("VST intent phase already exists with conflicting order facts");
        }
        return { kind: "existing", intent };
      });
    },

    async refreshPendingEntryIntent({ clientOrderId, expectedRequest, request }) {
      const result = await pool.query(
        `UPDATE vst_order_intents SET request = $3::jsonb, updated_at = now()
         WHERE client_order_id = $1 AND state = 'submitted'
           AND exchange_order_id IS NULL AND request = $2::jsonb
           AND request->>'operation' = 'entry'
           AND request->>'entrySizingPolicy' = 'fresh-before-sign-v1'
           AND NOT (request ? 'entryPricingTelemetry')
           AND outcome->>'phase' = 'submission_started'
           AND ($3::jsonb - ARRAY['quantity','maxEntryPrice','sizing',
                 'approvedTopUpMargin','impulseSplit','entryPricingTelemetry'])
             = (request - ARRAY['quantity','maxEntryPrice','sizing',
                 'approvedTopUpMargin','impulseSplit','entryPricingTelemetry'])
         RETURNING client_order_id`,
        [requireString(clientOrderId, "clientOrderId"),
          serialize(expectedRequest, "VST preliminary entry"),
          serialize(request, "VST fresh entry")],
      );
      return result.rowCount === 1;
    },

    async advanceStopTransfer({ clientOrderId, request, expectedStage, progress, exchangeOrderId = null }) {
      const result = await pool.query(
        `UPDATE vst_order_intents
         SET outcome = outcome || jsonb_build_object('stopTransfer', $3::jsonb),
             exchange_order_id = COALESCE($4, exchange_order_id), updated_at = now()
         WHERE client_order_id = $1 AND request = $5::jsonb
           AND request->>'stopTransferProtocol' = '1'
           AND state IN ('prepared','submitted','unknown')
           AND COALESCE(outcome->'stopTransfer'->>'stage', 'prepared') = $2
           AND ($4::text IS NULL OR exchange_order_id IS NULL OR exchange_order_id = $4)
         RETURNING client_order_id`,
        [requireString(clientOrderId, "clientOrderId"), expectedStage,
          serialize(progress, "stop transfer progress"), exchangeOrderId,
          serialize(request, "stop transfer request")],
      );
      return result.rowCount === 1;
    },

    async settlePreparedStopTransfer({ clientOrderId, request, expectedPosition }) {
      if (!matchesPreparedStopTransferPosition(request, expectedPosition?.snapshot)) return false;
      return transaction(pool, async (client) => {
        await lockSignalIntents(client, requireString(request.sourceSignalId, "sourceSignalId"));
        const result = await client.query(
          `UPDATE vst_order_intents i
           SET state = 'failed', outcome = outcome ||
             '{"reason":"stop_transfer_prepared_not_sent"}'::jsonb, updated_at = now()
           WHERE i.client_order_id = $1 AND i.request = $2::jsonb
             AND i.request->>'stopTransferProtocol' = '1'
             AND i.request->>'operation' IN ('raise_stop','split_raise_stop_place')
             AND i.state IN ('prepared','submitted','unknown')
             AND i.exchange_order_id IS NULL
             AND ((i.outcome->'stopTransfer'->>'version' = '1'
               AND i.outcome->'stopTransfer'->>'stage' = 'prepared')
               OR (i.state = 'prepared' AND NOT (i.outcome ? 'stopTransfer')))
             AND EXISTS (
               SELECT 1 FROM vst_positions p WHERE p.source_signal_id = i.source_signal_id
                 AND p.snapshot = $3::jsonb AND p.updated_at = $4::timestamptz
                 AND p.status IN ('open','unknown')
             )
           RETURNING source_signal_id`,
          [clientOrderId, serialize(request, "stop transfer request"),
            serialize(expectedPosition.snapshot, "stop transfer position"), expectedPosition.updatedAt],
        );
        if (!result.rowCount) return false;
        const signalId = result.rows[0].source_signal_id;
        await client.query(
          `UPDATE vst_positions p SET status = 'open',
             snapshot = jsonb_set(snapshot, '{status}', '"open"'::jsonb), updated_at = now()
           WHERE p.source_signal_id = $1 AND NOT EXISTS (
             SELECT 1 FROM vst_order_intents i WHERE i.source_signal_id = $1
               AND i.state IN ('prepared','submitted','unknown'))`,
          [signalId],
        );
        const previousSignal = await client.query(
          `SELECT status FROM vst_signals WHERE source_signal_id = $1 FOR UPDATE`,
          [signalId],
        );
        const reopenedSignal = await client.query(
          `UPDATE vst_signals s SET status = 'open', reason = NULL, updated_at = now()
           WHERE s.source_signal_id = $1 AND s.status IN ('open','unknown')
             AND NOT EXISTS (SELECT 1 FROM vst_order_intents i
               WHERE i.source_signal_id = $1 AND i.state IN ('prepared','submitted','unknown'))
           RETURNING status`,
          [signalId],
        );
        if (reopenedSignal.rowCount && previousSignal.rows[0]?.status !== "open") {
          await client.query(
            `INSERT INTO vst_events (source_signal_id, client_order_id, kind, detail)
             VALUES ($1,$2,'vst_signal_status_changed',$3::jsonb)`,
            [signalId, clientOrderId, serialize({
              from: previousSignal.rows[0].status, to: "open",
              reason: "stop_transfer_prepared_not_sent",
            }, "stop transfer status event")],
          );
        }
        await client.query(
          `INSERT INTO vst_events (source_signal_id, client_order_id, kind, detail)
           VALUES ($1,$2,'vst_stop_transfer_not_sent',
             '{"reason":"durable_pre_transport_boundary_not_crossed"}'::jsonb)`,
          [signalId, clientOrderId],
        );
        return true;
      });
    },

    async claimUncertaintyRead(intent, now) {
      const progress = nextUncertaintyRead(intent, now);
      if (!progress) return null;
      const outcome = {
        ...intent.outcome,
        uncertaintyRead: progress,
        uncertainty: classifyVstUncertainty(intent),
        originalSubmissionOutcome: intent.outcome?.originalSubmissionOutcome ?? intent.outcome,
      };
      const result = await pool.query(
        `UPDATE vst_order_intents SET outcome = $3::jsonb, updated_at = now()
         WHERE client_order_id = $1 AND state = $6
           AND (state IN ('submitted','unknown') OR
             (state = 'failed' AND outcome->>'reason' = 'raise_stop_protected_degraded'))
           AND outcome = $2::jsonb AND request = $4::jsonb
           AND exchange_order_id IS NOT DISTINCT FROM $5
         RETURNING source_signal_id, phase, client_order_id, request, state,
                   exchange_order_id, outcome, created_at, updated_at`,
        [intent.clientOrderId, serialize(intent.outcome, "uncertainty prior outcome"),
          serialize(outcome, "uncertainty progress"), serialize(intent.request, "uncertainty request"),
          intent.exchangeOrderId ?? null, intent.state],
      );
      return result.rowCount === 1 ? intentFromRow(result.rows[0]) : null;
    },

    async claimPreparedMarginAddition(intent) {
      const result = await pool.query(
        `UPDATE vst_order_intents SET state = 'submitted',
           outcome = '{"phase":"submission_started"}'::jsonb, updated_at = now()
         WHERE client_order_id = $1 AND state = 'prepared' AND phase = 'margin-top-up'
           AND request = $2::jsonb AND request->>'operation' = 'margin_top_up'
           AND request->>'environment' = 'vst'
         RETURNING client_order_id`,
        [intent.clientOrderId, serialize(intent.request, "margin addition request")],
      );
      return result.rowCount === 1;
    },

    async markIntent(clientOrderId, state, { exchangeOrderId = null, outcome = {} } = {}) {
      const orderId = requireString(clientOrderId, "clientOrderId");
      validStatus(state, INTENT_STATES, "VST intent state");
      const detail = serialize(outcome, "VST intent outcome");
      return transaction(pool, async (client) => {
        const owner = await client.query(
          `SELECT source_signal_id FROM vst_order_intents WHERE client_order_id = $1`,
          [orderId],
        );
        if (!owner.rowCount) return null;
        await lockSignalIntents(
          client, requireString(owner.rows[0].source_signal_id, "intent.sourceSignalId"),
        );
        const previous = await client.query(
          `SELECT state FROM vst_order_intents WHERE client_order_id = $1 FOR UPDATE`,
          [orderId],
        );
        if (!previous.rowCount) return null;
        const allowed = {
          prepared: new Set(["submitted", "unknown", "reconciled", "failed"]),
          submitted: new Set(["submitted", "unknown", "reconciled", "failed"]),
          unknown: new Set(["unknown", "reconciled", "failed"]),
          reconciled: new Set(["reconciled"]),
          failed: new Set(["failed"]),
        };
        const current = previous.rows[0].state;
        if (!allowed[current].has(state)) throw new Error(`Invalid VST intent transition: ${current} -> ${state}`);
        const result = await client.query(
          `UPDATE vst_order_intents
           SET state = $2, exchange_order_id = COALESCE($3, exchange_order_id),
               outcome = CASE WHEN request->>'stopTransferProtocol' = '1'
                   AND outcome ? 'stopTransfer'
                 THEN $4::jsonb || jsonb_build_object('stopTransfer', outcome->'stopTransfer')
                 ELSE $4::jsonb END
                 || CASE WHEN outcome ? 'uncertaintyRead' THEN
                   jsonb_build_object('uncertaintyRead', outcome->'uncertaintyRead',
                     'uncertainty', COALESCE($4::jsonb->'uncertainty', outcome->'uncertainty'),
                     'originalSubmissionOutcome', outcome->'originalSubmissionOutcome')
                   ELSE '{}'::jsonb END
                 || CASE WHEN $2 = 'unknown' AND request->>'operation' IN
                     ('entry','raise_stop','cancel_original_stop','margin_top_up',
                      'close_pre_runner_split','close_leg') THEN
                   jsonb_build_object('originalSubmissionOutcome',
                     COALESCE(outcome->'originalSubmissionOutcome',
                       CASE WHEN state IN ('prepared','submitted') THEN $4::jsonb ELSE outcome END))
                   ELSE '{}'::jsonb END, updated_at = now()
           WHERE client_order_id = $1
           RETURNING source_signal_id, phase, client_order_id, request, state,
                     exchange_order_id, outcome, created_at, updated_at`,
          [orderId, state, exchangeOrderId, detail],
        );
        return intentFromRow(result.rows[0]);
      });
    },

    async commitVerifiedIntent({
      sourceSignalId,
      clientOrderId,
      position,
      signalStatus,
      exchangeOrderId = null,
      outcome = {},
      eventKind = null,
      eventDetail = {},
      followUpIntent = null,
      recoverFailedMarginTopUp = false,
      expectedPositionSnapshot = null,
      expectedPositionUpdatedAt = null,
      retireNativeTakeSiblings = false,
      expectedPositionStatus = null,
    }) {
      const signalId = requireString(sourceSignalId, "sourceSignalId");
      const orderId = requireString(clientOrderId, "clientOrderId");
      if (position?.sourceSignalId !== signalId) {
        throw new Error("VST verified intent source signal does not match position");
      }
      const symbol = requireString(position?.symbol, "position.symbol");
      validStatus(position.status, POSITION_STATUSES, "VST position status");
      validStatus(signalStatus, SIGNAL_STATUSES, "VST signal status");
      if (exchangeOrderId !== null) requireString(exchangeOrderId, "exchangeOrderId");
      const positionJson = serialize(position, "VST position");
      const outcomeJson = serialize(outcome, "VST intent outcome");
      const eventJson = serialize(eventDetail, "VST event detail");
      if ((expectedPositionSnapshot === null) !==
          (expectedPositionUpdatedAt === null)) {
        throw new TypeError(
          "expectedPositionSnapshot and expectedPositionUpdatedAt must be supplied together",
        );
      }
      const expectedPositionJson = expectedPositionSnapshot === null
        ? null : serialize(expectedPositionSnapshot, "expected VST position");
      if (expectedPositionUpdatedAt !== null) {
        requireString(expectedPositionUpdatedAt, "expectedPositionUpdatedAt");
      }
      if (eventKind !== null) requireString(eventKind, "event.kind");
      let followUp = null;
      if (followUpIntent !== null) {
        if (followUpIntent.sourceSignalId !== signalId) {
          throw new Error("VST follow-up intent source signal mismatch");
        }
        const followUpRequest = followUpIntent.request ?? {};
        followUp = {
          sourceSignalId: signalId,
          phase: requireString(followUpIntent.phase, "followUpIntent.phase"),
          clientOrderId: requireString(
            followUpIntent.clientOrderId, "followUpIntent.clientOrderId",
          ),
          request: serialize(followUpRequest, "VST follow-up intent"),
          // The caller (finalizeEntry) rebuilds this request from scratch on
          // every call, including a fresh intentCreatedAt bookkeeping
          // timestamp, and has no persisted value to reuse the way
          // prepareIntentRequest does for other phases. A replayed commit
          // must not be rejected as conflicting merely because this
          // timestamp differs from what was already persisted.
          comparableRequest: serialize(
            withoutIntentTimestamp(followUpRequest), "VST follow-up intent",
          ),
        };
        if (followUp.phase === "market-entry" ||
            followUp.clientOrderId === orderId ||
            followUpRequest.operation !== "margin_top_up" ||
            followUpRequest.environment !== "vst" ||
            followUpRequest.accountId !== position.accountId ||
            followUpRequest.symbol !== symbol) {
          throw new Error("VST follow-up intent is not a matching VST margin top-up");
        }
      }

      return transaction(pool, async (client) => {
        await lockSignalIntents(client, signalId);
        const locked = await client.query(
          `SELECT i.source_signal_id, i.phase, i.client_order_id, i.request, i.state,
                  i.exchange_order_id, i.outcome, i.created_at, i.updated_at,
                  s.source_signal_id AS signal_source_signal_id, s.body AS signal_body,
                  s.body_hash AS signal_body_hash, s.status AS signal_status,
                  s.reason AS signal_reason, s.received_at AS signal_received_at,
                  s.updated_at AS signal_updated_at
           FROM vst_order_intents i
           JOIN vst_signals s ON s.source_signal_id = i.source_signal_id
           WHERE i.client_order_id = $1
           FOR UPDATE OF i, s`,
          [orderId],
        );
        const intent = intentFromRow(locked.rows[0]);
        const row = locked.rows[0];
        if (!intent || !row) throw new Error("VST verified intent was not found");
        if (retireNativeTakeSiblings &&
            (intent.request?.operation !== "native_full_take" ||
             outcome?.verified !== true || outcome?.status !== "filled" ||
             position.status !== "closed" || Number(position.remainingQty) !== 0 ||
             position.nativeTake?.orderId !== intent.exchangeOrderId ||
             outcome.fill?.triggerOrderId !== intent.exchangeOrderId ||
             expectedPositionSnapshot === null)) {
          throw new Error("Native take closure requires exact submitted-order and position proof");
        }
        if (intent.sourceSignalId !== signalId || row.signal_source_signal_id !== signalId) {
          throw new Error("VST verified intent source signal mismatch");
        }

        if (intent.request?.operation === "retire_adopted_stop") {
          const request = intent.request;
          const prior = request.priorPosition;
          const pending = prior?.pendingStopRetirement;
          const markerKeys = ["adoptedStop", "entryProof", "oldStop", "originalIntent"];
          const stopKeys = ["orderId", "positionId", "quantity", "stopPrice"];
          const exactKeys = (value, keys) => validObject(value) &&
            Object.keys(value).length === keys.length &&
            keys.every((key) => Object.hasOwn(value, key));
          const validId = (value) => typeof value === "string" &&
            /^\d+$/.test(value) && BigInt(value) > 0n;
          const stopMatches = (left, right) => exactKeys(left, stopKeys) &&
            exactKeys(right, stopKeys) &&
            left.orderId === right.orderId &&
            left.positionId === right.positionId &&
            exactDecimalEqual(left.quantity, right.quantity) &&
            exactDecimalEqual(left.stopPrice, right.stopPrice);
          const oldId = exactPositiveIdentifier(pending?.oldStop?.orderId);
          const adoptedId = exactPositiveIdentifier(pending?.adoptedStop?.orderId);
          const priorCore = prior?.verifiedProtectiveStops?.core;
          const nextCore = position?.verifiedProtectiveStops?.core;
          if (!expectedPositionSnapshot ||
              !exactKeys(pending, markerKeys) ||
              !stopMatches(request.oldStop, pending.oldStop) ||
              !stopMatches(request.adoptedStop, pending.adoptedStop) ||
              !validId(oldId) || !validId(adoptedId) || oldId === adoptedId ||
              request.oldStop.orderId !== oldId ||
              request.adoptedStop.orderId !== adoptedId ||
              !validId(pending.oldStop.positionId) ||
              pending.oldStop.positionId !== pending.adoptedStop.positionId ||
              !exactDecimalEqual(pending.oldStop.quantity, pending.adoptedStop.quantity) ||
              compareExactDecimals(pending.adoptedStop.stopPrice,
                pending.oldStop.stopPrice) <= 0 ||
              !validObject(pending.entryProof) ||
              !exactKeys(pending.originalIntent, ["clientOrderId", "phase"]) ||
              typeof pending.originalIntent.clientOrderId !== "string" ||
              typeof pending.originalIntent.phase !== "string" ||
              !stopMatches({
                orderId: priorCore?.orderId,
                positionId: priorCore?.positionId,
                quantity: priorCore?.quantity,
                stopPrice: priorCore?.stopPrice,
              }, pending.adoptedStop) ||
              !stopMatches({
                orderId: nextCore?.orderId,
                positionId: nextCore?.positionId,
                quantity: nextCore?.quantity,
                stopPrice: nextCore?.stopPrice,
              }, pending.adoptedStop) ||
              Object.hasOwn(position, "pendingStopRetirement") ||
              serialize(prior, "retire adopted-stop prior position") !==
                expectedPositionJson ||
              outcome?.verified !== true || outcome?.status !== "filled" ||
              outcome?.canceledStopOrderId !== oldId ||
              outcome?.exchangeOrderId !== oldId || exchangeOrderId !== oldId) {
            throw new Error("VST adopted-stop retirement proof does not match pending position");
          }
        }

        if (intent.state === "reconciled") {
          if (intent.outcome === null ||
              serialize(intent.outcome, "stored VST intent outcome") !== outcomeJson ||
              intent.exchangeOrderId !== exchangeOrderId) {
            throw new Error("VST reconciled intent conflicts with verified outcome");
          }
          const existingPosition = await client.query(
            `SELECT source_signal_id, symbol, status, snapshot, updated_at
             FROM vst_positions WHERE source_signal_id = $1`,
            [signalId],
          );
          if (!existingPosition.rowCount) {
            throw new Error("VST reconciled intent has no committed position record");
          }
          if (followUp) {
            const existingFollowUp = await client.query(
              `SELECT source_signal_id, phase, client_order_id, request, state,
                      exchange_order_id, outcome, created_at, updated_at
               FROM vst_order_intents WHERE source_signal_id = $1 AND phase = $2`,
              [signalId, followUp.phase],
            );
            const row = existingFollowUp.rows[0];
            if (!row || row.client_order_id !== followUp.clientOrderId ||
                serialize(withoutIntentTimestamp(row.request), "stored VST follow-up intent") !==
                  followUp.comparableRequest) {
              throw new Error("VST reconciled entry has a conflicting follow-up intent");
            }
          }
          return {
            intent,
            position: positionFromRow(existingPosition.rows[0]),
            signal: signalFromRow({
              source_signal_id: row.signal_source_signal_id,
              body: row.signal_body,
              body_hash: row.signal_body_hash,
              status: row.signal_status,
              reason: row.signal_reason,
              received_at: row.signal_received_at,
              updated_at: row.signal_updated_at,
            }),
            replayed: true,
          };
        }
        if (recoverFailedMarginTopUp && intent.state === "failed") {
          const priorPosition = await client.query(
            `SELECT status, snapshot FROM vst_positions
             WHERE source_signal_id = $1 FOR UPDATE`, [signalId],
          );
          const prior = priorPosition.rows[0];
          if (intent.request?.operation !== "margin_top_up" ||
              intent.outcome?.reason !== "margin_top_up_abandoned_confirmed_not_applied" ||
              intent.outcome?.submissionErrorMessage !==
                "VST margin top-up was submitted but exact read-after-write margin change is unverified" ||
              prior?.status !== "error" ||
              prior.snapshot?.marginTopUp?.status !== "failed" ||
              prior.snapshot.marginTopUp.failureReason !==
                "margin_top_up_abandoned_confirmed_not_applied" ||
              prior.snapshot.marginTopUp.manualResolution ||
              outcome.marginHistory?.source !== "bingx_position_margin_history" ||
              outcome.marginHistory.positionId !== intent.request.positionId ||
              outcome.marginHistory.changeReason !== "ManualMarginAddition" ||
              !Number.isSafeInteger(outcome.marginHistory.time) ||
              outcome.marginHistory.time < Number(intent.request.intentCreatedAt) ||
              outcome.marginHistory.time > Number(intent.request.intentCreatedAt) + 120_000) {
            throw new Error("VST failed margin adjustment cannot be recovered without exchange history");
          }
        } else if (!new Set(["prepared", "submitted", "unknown"]).has(intent.state)) {
          throw new Error(`VST intent cannot be committed from state: ${intent.state}`);
        }

        if (expectedPositionSnapshot !== null) {
          const currentPosition = await client.query(
            `SELECT source_signal_id, symbol, status, snapshot,
                    updated_at::text AS updated_at
             FROM vst_positions WHERE source_signal_id = $1 FOR UPDATE`,
            [signalId],
          );
          const current = positionFromRow(currentPosition.rows[0]);
          if (!current ||
              current.updatedAt !== expectedPositionUpdatedAt ||
              current.symbol !== expectedPositionSnapshot.symbol ||
              current.status !== (expectedPositionStatus ?? expectedPositionSnapshot.status) ||
              serialize(current.snapshot, "locked VST position") !==
                expectedPositionJson) {
            throw new Error("VST position changed before verified intent commit");
          }
        }

        const positionResult = await client.query(
          `INSERT INTO vst_positions (source_signal_id, symbol, status, snapshot)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (source_signal_id) DO UPDATE SET
             symbol = EXCLUDED.symbol, status = EXCLUDED.status,
             snapshot = EXCLUDED.snapshot, updated_at = now()
           RETURNING source_signal_id, symbol, status, snapshot, updated_at`,
          [signalId, symbol, position.status, positionJson],
        );
        const intentResult = await client.query(
          `UPDATE vst_order_intents
           SET state = 'reconciled', exchange_order_id = $2,
               outcome = $3::jsonb, updated_at = now()
           WHERE client_order_id = $1
           RETURNING source_signal_id, phase, client_order_id, request, state,
                     exchange_order_id, outcome, created_at, updated_at`,
          [orderId, exchangeOrderId, outcomeJson],
        );
        const signalResult = await client.query(
          `UPDATE vst_signals SET status = $2, reason = NULL, updated_at = now()
           WHERE source_signal_id = $1
           RETURNING source_signal_id, body, body_hash, status, reason, received_at, updated_at`,
          [signalId, signalStatus],
        );
        if (retireNativeTakeSiblings) {
          await client.query(
            `UPDATE vst_order_intents SET state = 'failed',
               outcome = outcome || $3::jsonb, updated_at = now()
             WHERE source_signal_id = $1 AND client_order_id <> $2
               AND state IN ('prepared', 'submitted', 'unknown')`,
            [signalId, orderId, serialize({
              reason: "position_closed_by_verified_native_take",
              nativeTakeOrderId: intent.exchangeOrderId,
            }, "native take sibling retirement")],
          );
        }
        let followUpResult = null;
        if (followUp) {
          followUpResult = await client.query(
            `INSERT INTO vst_order_intents
               (source_signal_id, phase, client_order_id, request, state)
             VALUES ($1, $2, $3, $4::jsonb, 'prepared')
             ON CONFLICT (source_signal_id, phase) DO NOTHING
             RETURNING source_signal_id, phase, client_order_id, request, state,
                       exchange_order_id, outcome, created_at, updated_at`,
            [signalId, followUp.phase, followUp.clientOrderId, followUp.request],
          );
          if (!followUpResult.rows[0]) {
            const existingFollowUp = await client.query(
              `SELECT client_order_id, request
               FROM vst_order_intents WHERE source_signal_id = $1 AND phase = $2 FOR UPDATE`,
              [signalId, followUp.phase],
            );
            const row = existingFollowUp.rows[0];
            if (!row || row.client_order_id !== followUp.clientOrderId ||
                serialize(withoutIntentTimestamp(row.request), "stored VST follow-up intent") !==
                  followUp.comparableRequest) {
              throw new Error("VST follow-up intent conflicts with an existing phase");
            }
          }
        }
        let event = null;
        if (eventKind !== null) {
          const eventResult = await client.query(
            `INSERT INTO vst_events (source_signal_id, client_order_id, kind, detail)
             VALUES ($1, $2, $3, $4::jsonb)
             RETURNING id, source_signal_id, client_order_id, kind, detail, created_at`,
            [signalId, orderId, eventKind, eventJson],
          );
          event = eventResult.rows[0] ?? null;
        }
        if (!positionResult.rows[0] || !intentResult.rows[0] || !signalResult.rows[0]) {
          throw new Error("VST verified intent commit did not update all ledger records");
        }
        return {
          intent: intentFromRow(intentResult.rows[0]),
          position: positionFromRow(positionResult.rows[0]),
          signal: signalFromRow(signalResult.rows[0]),
          event,
          followUpIntent: followUpResult?.rows[0]
            ? intentFromRow(followUpResult.rows[0])
            : null,
          replayed: false,
        };
      });
    },

    async getIntentByClientOrderId(clientOrderId) {
      const result = await pool.query(
        `SELECT source_signal_id, phase, client_order_id, request, state,
                exchange_order_id, outcome, created_at, updated_at
         FROM vst_order_intents WHERE client_order_id = $1`,
        [requireString(clientOrderId, "clientOrderId")],
      );
      return intentFromRow(result.rows[0]);
    },

    async getIntent(sourceSignalId, phase) {
      const signalId = requireString(sourceSignalId, "sourceSignalId");
      const phaseName = requireString(phase, "phase");
      const result = await pool.query(
        `SELECT source_signal_id, phase, client_order_id, request, state,
                exchange_order_id, outcome, created_at, updated_at
         FROM vst_order_intents WHERE source_signal_id = $1 AND phase = $2`,
        [signalId, phaseName],
      );
      return intentFromRow(result.rows[0]);
    },

    // Persisted owner decisions remain visible after retirement and subsequent
    // position transitions. Do not join current positions or call the broker.
    async listLegacyPreRunnerCloseReviews() {
      const result = await pool.query(
        `SELECT source_signal_id, phase, client_order_id, request, state,
                exchange_order_id, outcome, created_at, updated_at
         FROM vst_order_intents
         WHERE request->>'operation' = 'close_pre_runner_split'
           AND jsonb_typeof(outcome->'ownerPreRunnerCloseReview') = 'object'
         ORDER BY outcome->'ownerPreRunnerCloseReview'->>'checkedAt' DESC, id DESC`,
      );
      return result.rows.map(intentFromRow);
    },

    async getNativeTakePosition(sourceSignalId) {
      const result = await pool.query(
        `SELECT source_signal_id, symbol, status, snapshot,
                updated_at::text AS updated_at
         FROM vst_positions WHERE source_signal_id = $1`,
        [requireString(sourceSignalId, "sourceSignalId")],
      );
      return positionFromRow(result.rows[0]);
    },

    async latestNativeTakeIntent(sourceSignalId) {
      requireString(sourceSignalId, "sourceSignalId");
      const result = await pool.query(
        `SELECT source_signal_id, phase, client_order_id, request, state,
                exchange_order_id, outcome, created_at, updated_at
         FROM vst_order_intents WHERE source_signal_id = $1
           AND phase LIKE 'native-full-take-%' ORDER BY id DESC LIMIT 1`,
        [sourceSignalId],
      );
      return result.rows[0] ? intentFromRow(result.rows[0]) : null;
    },

    async listNativeTakeIntents() {
      const result = await pool.query(
        `SELECT source_signal_id, phase, client_order_id, request, state,
                exchange_order_id, outcome, created_at, updated_at
         FROM vst_order_intents WHERE phase LIKE 'native-full-take-%'
           AND state IN ('prepared', 'submitted', 'unknown') ORDER BY id`,
      );
      return result.rows.map(intentFromRow);
    },

    async listUnresolvedIntents() {
      const result = await pool.query(
        `SELECT source_signal_id, phase, client_order_id, request, state,
                exchange_order_id, outcome, created_at, updated_at
         FROM vst_order_intents WHERE state IN ('prepared', 'submitted', 'unknown')
           AND phase NOT LIKE 'native-full-take-%'
         ORDER BY created_at, id`,
      );
      return result.rows.map(intentFromRow);
    },

    async listPreRunnerCloseAttempts(sourceSignalId) {
      requireString(sourceSignalId, "sourceSignalId");
      const result = await pool.query(
        `SELECT source_signal_id, phase, client_order_id, request, state,
                exchange_order_id, outcome, created_at, updated_at
         FROM vst_order_intents
         WHERE source_signal_id = $1
           AND request->>'operation' = 'close_pre_runner_split'
         ORDER BY created_at DESC, id DESC LIMIT 100`,
        [sourceSignalId],
      );
      return result.rows.map(intentFromRow);
    },

    async recordGuardEventOnce(sourceSignalId, kind, detail) {
      requireString(sourceSignalId, "sourceSignalId");
      if (!["vst_position_management_diagnostic", "vst_pre_runner_close_retry_limit"]
        .includes(kind) || typeof detail?.ref !== "string" || !detail.ref) {
        throw new TypeError("Invalid VST guard event");
      }
      const payload = serialize(detail, "guard event detail");
      await pool.query(
        `INSERT INTO vst_events (source_signal_id, kind, detail)
         SELECT $1, $2, $3::jsonb
         WHERE NOT EXISTS (
           SELECT 1 FROM vst_events
           WHERE source_signal_id = $1 AND kind = $2 AND detail->>'ref' = $4
         )`,
        [sourceSignalId, kind, payload, detail.ref],
      );
    },

    // A failed entry may have been retired solely because a rounded position
    // average prevented proof of an otherwise filled, stopped order. Never
    // resubmit it: offer recent candidates for read-only exchange verification.
    async listRecoverableFailedEntries() {
      const result = await pool.query(
        `SELECT i.source_signal_id, i.phase, i.client_order_id, i.request, i.state,
                i.exchange_order_id, i.outcome, i.created_at, i.updated_at
         FROM vst_order_intents i
         JOIN vst_positions p ON p.source_signal_id = i.source_signal_id
         JOIN vst_signals s ON s.source_signal_id = i.source_signal_id
         WHERE i.phase = 'market-entry' AND i.state = 'failed'
           AND i.request->>'operation' = 'entry'
           AND i.outcome->>'reason' = 'entry_verification_abandoned_confirmed_open_unprotected'
           AND p.status = 'error' AND s.status = 'error'
           AND p.snapshot->>'manualResolution' IS NULL
           AND i.created_at > now() - interval '22 hours'
           AND NOT EXISTS (
             SELECT 1 FROM vst_events e
             WHERE e.source_signal_id = i.source_signal_id
               AND e.kind = 'vst_failed_entry_recovery_started'
           )
         ORDER BY i.created_at DESC LIMIT 5`,
      );
      return result.rows.map(intentFromRow);
    },

    async resumeVerifiedFailedEntry(clientOrderId) {
      const id = requireString(clientOrderId, "clientOrderId");
      return transaction(pool, async (client) => {
        const owner = await client.query(
          `SELECT source_signal_id FROM vst_order_intents WHERE client_order_id = $1`,
          [id],
        );
        if (!owner.rowCount) return false;
        await lockSignalIntents(
          client, requireString(owner.rows[0].source_signal_id, "intent.sourceSignalId"),
        );
        const result = await client.query(
          `SELECT i.source_signal_id
           FROM vst_order_intents i
           JOIN vst_positions p ON p.source_signal_id = i.source_signal_id
           JOIN vst_signals s ON s.source_signal_id = i.source_signal_id
           WHERE i.client_order_id = $1 AND i.phase = 'market-entry'
             AND i.state = 'failed' AND i.request->>'operation' = 'entry'
             AND i.outcome->>'reason' = 'entry_verification_abandoned_confirmed_open_unprotected'
             AND p.status = 'error' AND s.status = 'error'
             AND p.snapshot->>'manualResolution' IS NULL
             AND i.created_at > now() - interval '22 hours'
             AND NOT EXISTS (
               SELECT 1 FROM vst_events e
               WHERE e.source_signal_id = i.source_signal_id
                 AND e.kind = 'vst_failed_entry_recovery_started'
             )
           FOR UPDATE OF i, p, s`,
          [id],
        );
        if (result.rowCount !== 1) return false;
        await client.query(
          `UPDATE vst_order_intents SET state = 'unknown', updated_at = now()
           WHERE client_order_id = $1`,
          [id],
        );
        await client.query(
          `UPDATE vst_signals SET status = 'unknown',
             reason = 'entry_exchange_verified_reconciliation_pending', updated_at = now()
           WHERE source_signal_id = $1`,
          [result.rows[0].source_signal_id],
        );
        // A later failure must not create an endless auto-recovery loop.
        await client.query(
          `INSERT INTO vst_events (source_signal_id, kind, detail)
           VALUES ($1, 'vst_failed_entry_recovery_started', '{}'::jsonb)`,
          [result.rows[0].source_signal_id],
        );
        return true;
      });
    },

    // Atomically settles only the exact pre-adapter raise_stop refusal after
    // the worker supplies fresh exchange evidence. The position is never
    // rewritten: its snapshot and timestamp are a transactional read boundary.
    async recoverRaiseStopPreUpgradeRefusal({
      sourceSignalId, clientOrderId, phase, expectedRequest, expectedOutcome,
      expectedPositionSnapshot, expectedPositionUpdatedAt, expectedEntryIntent,
      entryProof, oldPositionAndStop, requestStartedAtMs, maxEvidenceAgeMs, clock,
    }) {
      const signalId = requireString(sourceSignalId, "sourceSignalId");
      const orderId = requireString(clientOrderId, "clientOrderId");
      const intentPhase = requireString(phase, "phase");
      const requestJson = serialize(expectedRequest, "expected raise_stop request");
      const outcomeJson = serialize(expectedOutcome, "expected raise_stop outcome");
      const positionJson = serialize(
        expectedPositionSnapshot, "expected raise_stop position snapshot",
      );
      const updatedAt = requireString(
        expectedPositionUpdatedAt, "expected raise_stop position updatedAt",
      );
      const entryIntent = requirePlainObject(expectedEntryIntent, "expected market-entry intent");
      const entryRequestJson = serialize(entryIntent.request, "expected market-entry request");
      const entryOutcomeJson = serialize(entryIntent.outcome, "expected market-entry outcome");
      const proof = requirePlainObject(entryProof, "raise_stop entry proof");
      const oldProof = requirePlainObject(oldPositionAndStop, "old position and stop proof");
      const evidenceStartedAt = Number(requestStartedAtMs);
      const maxEvidenceAge = Number(maxEvidenceAgeMs);
      if (!Number.isSafeInteger(evidenceStartedAt) || evidenceStartedAt <= 0 ||
          !Number.isSafeInteger(maxEvidenceAge) || maxEvidenceAge <= 0 ||
          maxEvidenceAge > READ_ONLY_RECOVERY_MAX_EVIDENCE_AGE_MS ||
          typeof clock !== "function") {
        return { kind: "ineligible" };
      }
      const knownPhase = /^raise_stop-core-\d+$/.test(intentPhase) ||
        /^impulse-sole-core-stop-\d+$/.test(intentPhase);
      const deterministicId = `vst-${createHash("sha256")
        .update(`${signalId}:${intentPhase}`).digest("hex").slice(0, 30)}`;
      const noManualResolution = (snapshot) =>
        snapshot?.manualResolution == null &&
        snapshot?.marginTopUp?.manualResolution == null;
      const prior = expectedRequest?.priorPosition;
      const nextPosition = expectedRequest?.nextPosition;
      const coreStops = (snapshot) => [
        snapshot?.verifiedProtectiveStops?.core,
        snapshot?.protectiveStops?.core,
        snapshot?.split?.coreStop,
        snapshot?.coreStop,
      ].filter((stop) => stop && typeof stop === "object" && !Array.isArray(stop));
      const baselineStops = coreStops(expectedPositionSnapshot);
      const nextStops = coreStops(nextPosition);
      const oldStops = [
        ...coreStops(prior),
        ...nextStops,
        ...baselineStops,
      ];
      const optionalIdMatches = (row, expected, ...keys) => {
        const present = keys.some((key) => row?.[key] !== undefined &&
          row?.[key] !== null);
        return !present || consistentIdentifierAliases(row, ...keys) === expected;
      };
      const optionalDecimalMatches = (row, expected, ...keys) => {
        const present = keys.some((key) => row?.[key] !== undefined &&
          row?.[key] !== null);
        return !present ||
          exactDecimalEqual(consistentDecimalAliases(row, ...keys), expected);
      };
      const optionalTimestampMatches = (row) => {
        if (row?.entryAt === undefined || expectedPositionSnapshot?.entryAt === undefined) {
          return true;
        }
        const millis = (value) => typeof value === "number" && Number.isSafeInteger(value)
          ? value
          : typeof value === "string" && Number.isFinite(Date.parse(value))
            ? Date.parse(value) : null;
        const actual = millis(row.entryAt);
        const expected = millis(expectedPositionSnapshot.entryAt);
        return actual !== null && expected !== null && actual === expected;
      };
      const entryIntentValid =
        entryIntent.sourceSignalId === signalId &&
        entryIntent.phase === "market-entry" &&
        entryIntent.state === "reconciled" &&
        typeof entryIntent.clientOrderId === "string" &&
        entryIntent.clientOrderId.trim() !== "" &&
        entryIntent.request?.operation === "entry" &&
        entryIntent.request?.environment === "vst" &&
        entryIntent.request?.accountId === expectedRequest?.accountId &&
        entryIntent.request?.symbol === expectedRequest?.symbol &&
        entryIntent.outcome?.verified === true &&
        entryIntent.outcome?.status === "filled" &&
        exactPositiveIdentifier(entryIntent.exchangeOrderId) !== null &&
        entryIntent.outcome?.positionId === proof.positionId &&
        proof.entryClientOrderId === entryIntent.clientOrderId &&
        proof.entryOrderId === entryIntent.exchangeOrderId &&
        proof.entryOrderType === (entryIntent.request.entryOrderType ?? "LIMIT") &&
        proof.intentCreatedAt === entryIntent.request.intentCreatedAt &&
        exactDecimalEqual(
          proof.quantity,
          entryIntent.outcome.fillQuantity ?? entryIntent.outcome.totalQuantity,
        ) &&
        exactDecimalEqual(proof.quantity, entryIntent.request.quantity);
      const oldStopValid = oldStops.length > 0 && oldStops.every((stop) => {
        const parents = [
          stop.mainOrderId, stop.mainOrderID,
          stop.parentOrderId, stop.parentOrderID,
        ].filter((value) => value !== undefined && value !== null);
        return consistentIdentifierAliases(stop, "orderId", "orderID") ===
            oldProof.stopOrderId &&
          consistentIdentifierAliases(stop, "positionId", "positionID") ===
            oldProof.positionId &&
          exactDecimalEqual(
            consistentDecimalAliases(stop, "quantity", "origQty"), oldProof.quantity,
          ) &&
          exactDecimalEqual(stop.stopPrice, oldProof.stopPrice) &&
          explicitZeroExecutionProofMatches(
            oldProof.executionProof, oldProof.stopOrderId,
          ) &&
          parents.every((parent) => parent === proof.entryOrderId);
      });
      const targetStopIsHigher =
        exactDecimalEqual(expectedRequest?.previousQuantity, oldProof.quantity) &&
        exactDecimalEqual(expectedRequest?.quantity, oldProof.quantity) &&
        exactDecimalEqual(
          expectedPositionSnapshot?.remainingQty ??
            expectedPositionSnapshot?.quantity, oldProof.quantity,
        ) &&
        exactDecimalEqual(
          nextPosition?.remainingQty ?? nextPosition?.quantity,
          oldProof.quantity,
        ) &&
        (() => {
          try {
            return new Decimal(String(expectedRequest.stopPrice))
              .gt(new Decimal(String(oldProof.stopPrice)));
          } catch {
            return false;
          }
        })();
      if (!knownPhase || orderId !== deterministicId ||
          expectedRequest?.operation !== "raise_stop" ||
          expectedRequest?.leg !== "core" ||
          expectedRequest?.sourceSignalId !== undefined &&
            expectedRequest?.sourceSignalId !== signalId ||
          expectedRequest?.environment !== "vst" ||
          typeof expectedRequest?.accountId !== "string" ||
          expectedRequest?.symbol !== expectedPositionSnapshot?.symbol ||
          expectedRequest?.positionId !== undefined &&
            exactPositiveIdentifier(expectedRequest.positionId) !== oldProof.positionId ||
          prior?.sourceSignalId !== undefined && prior.sourceSignalId !== signalId ||
          !validObject(nextPosition) ||
          nextPosition.entryClientOrderId !== proof.entryClientOrderId ||
          nextPosition.symbol !== undefined &&
            nextPosition.symbol !== expectedRequest.symbol ||
          nextPosition.sourceSignalId !== undefined &&
            nextPosition.sourceSignalId !== signalId ||
          nextPosition.status !== undefined && nextPosition.status !== "open" ||
          nextPosition.environment !== undefined && nextPosition.environment !== "vst" ||
          nextPosition.accountId !== undefined &&
            nextPosition.accountId !== expectedRequest.accountId ||
          expectedPositionSnapshot.symbol !== expectedRequest.symbol ||
          consistentIdentifierAliases(
            nextPosition, "exchangePositionId", "positionId",
          ) !== oldProof.positionId ||
          expectedPositionSnapshot.entryClientOrderId !== proof.entryClientOrderId ||
          consistentIdentifierAliases(
            expectedPositionSnapshot, "exchangePositionId", "positionId",
          ) !== oldProof.positionId ||
          baselineStops.length === 0 || nextStops.length === 0 ||
          !optionalIdMatches(expectedRequest, proof.entryClientOrderId,
            "entryClientOrderId") ||
          !optionalIdMatches(prior, proof.entryClientOrderId,
            "entryClientOrderId") ||
          !optionalIdMatches(nextPosition, proof.entryClientOrderId,
            "entryClientOrderId") ||
          !optionalIdMatches(expectedPositionSnapshot, proof.entryClientOrderId,
            "entryClientOrderId") ||
          !optionalIdMatches(expectedRequest, proof.entryOrderId, "entryOrderId") ||
          !optionalIdMatches(prior, proof.entryOrderId, "entryOrderId") ||
          !optionalIdMatches(nextPosition, proof.entryOrderId, "entryOrderId") ||
          !optionalIdMatches(expectedPositionSnapshot, proof.entryOrderId, "entryOrderId") ||
          !optionalIdMatches(expectedRequest, oldProof.positionId, "positionId") ||
          !optionalIdMatches(prior, oldProof.positionId,
            "exchangePositionId", "positionId") ||
          !optionalIdMatches(nextPosition, oldProof.positionId,
            "exchangePositionId", "positionId") ||
          !optionalIdMatches(expectedPositionSnapshot, oldProof.positionId,
            "exchangePositionId", "positionId") ||
          !optionalDecimalMatches(expectedRequest, oldProof.quantity,
            "previousQuantity", "quantity") ||
          !optionalDecimalMatches(prior, oldProof.quantity,
            "remainingQty", "quantity") ||
          !optionalDecimalMatches(nextPosition, oldProof.quantity,
            "remainingQty", "quantity") ||
          !optionalDecimalMatches(expectedPositionSnapshot, oldProof.quantity,
            "remainingQty", "quantity") ||
          !optionalTimestampMatches(prior) ||
          !optionalTimestampMatches(nextPosition) ||
          expectedPositionSnapshot?.status !== "open" ||
          expectedPositionSnapshot?.sourceSignalId !== signalId ||
          !noManualResolution(expectedPositionSnapshot) ||
          !entryIntentValid ||
          !targetStopIsHigher || !oldStopValid ||
          expectedPositionSnapshot.environment !== "vst" ||
          expectedPositionSnapshot.accountId !== expectedRequest.accountId ||
          !exactRaiseStopRefusal(expectedOutcome, intentPhase, expectedRequest)) {
        return { kind: "ineligible" };
      }

      const refusalReason = "raise_stop_entry_proof_refused_before_upgrade";
      const recoveryOutcome = {
        reason: refusalReason,
        error: "Error",
        errorMessage: expectedOutcome.errorMessage ??
          expectedOutcome.submissionErrorMessage,
        ...(expectedOutcome.preSignReason === undefined
          ? { provenance: "historical_exact_pre_adapter_error" }
          : { preSignReason: RAISE_STOP_ENTRY_PROOF_REFUSAL_PRE_SIGN }),
        noWriteConfirmed: true,
        entryProof: proof,
        oldPositionAndStop: oldProof,
      };
      const recoveryOutcomeJson = serialize(
        recoveryOutcome, "raise_stop pre-upgrade recovery outcome",
      );
      const eventDetailJson = serialize({
        operation: "raise_stop",
        outcome: "failed_before_adapter",
        reason: refusalReason,
        noWriteConfirmed: true,
        entryProof: proof,
        oldPositionAndStop: oldProof,
      }, "raise_stop pre-upgrade recovery event");

      return transaction(pool, async (client) => {
        await lockSignalIntents(client, signalId);
        const lockedAt = Number(clock());
        if (!Number.isSafeInteger(lockedAt) ||
            lockedAt < evidenceStartedAt ||
            lockedAt - evidenceStartedAt > maxEvidenceAge) {
          return { kind: "ineligible" };
        }
        const signalResult = await client.query(
          `SELECT source_signal_id, status, reason
           FROM vst_signals WHERE source_signal_id = $1 FOR UPDATE`,
          [signalId],
        );
        const signalRow = signalResult.rows[0];
        if (!signalRow || signalRow.status !== "unknown") {
          return { kind: "ineligible" };
        }
        const positionResult = await client.query(
          `SELECT source_signal_id, symbol, status, snapshot,
                  updated_at::text AS updated_at_text
           FROM vst_positions
           WHERE source_signal_id = $1 AND status = 'open'
             AND updated_at = $2::timestamptz
           FOR UPDATE`,
          [signalId, updatedAt],
        );
        const positionRow = positionResult.rows[0];
        if (!positionRow || positionRow.updated_at_text !== updatedAt ||
            serialize(positionRow.snapshot, "stored raise_stop position") !== positionJson ||
            !noManualResolution(positionRow.snapshot)) {
          return { kind: "ineligible" };
        }
        const targetResult = await client.query(
          `SELECT source_signal_id, phase, client_order_id, request, state,
                  exchange_order_id, outcome
           FROM vst_order_intents
           WHERE source_signal_id = $1 AND client_order_id = $2 FOR UPDATE`,
          [signalId, orderId],
        );
        const target = targetResult.rows[0];
        if (!target || target.phase !== intentPhase || target.state !== "unknown" ||
            target.exchange_order_id !== null ||
            serialize(target.request, "stored raise_stop request") !== requestJson ||
            serialize(target.outcome, "stored raise_stop outcome") !== outcomeJson ||
            !exactRaiseStopRefusal(target.outcome, target.phase, target.request)) {
          return { kind: "ineligible" };
        }
        const entryResult = await client.query(
          `SELECT source_signal_id, phase, client_order_id, request, state,
                  exchange_order_id, outcome
           FROM vst_order_intents
           WHERE source_signal_id = $1 AND phase = 'market-entry' FOR UPDATE`,
          [signalId],
        );
        const currentEntry = entryResult.rows[0];
        if (!currentEntry ||
            currentEntry.client_order_id !== entryIntent.clientOrderId ||
            currentEntry.state !== entryIntent.state ||
            currentEntry.exchange_order_id !== entryIntent.exchangeOrderId ||
            serialize(currentEntry.request, "stored market-entry request") !==
              entryRequestJson ||
            serialize(currentEntry.outcome, "stored market-entry outcome") !==
              entryOutcomeJson) {
          return { kind: "ineligible" };
        }
        const competing = await client.query(
          `SELECT client_order_id
           FROM vst_order_intents
           WHERE source_signal_id = $1 AND client_order_id <> $2
             AND state IN ('prepared', 'submitted', 'unknown')
           ORDER BY client_order_id FOR UPDATE`,
          [signalId, orderId],
        );
        if (competing.rows.length > 0) return { kind: "ineligible" };

        const settlementAt = Number(clock());
        if (!Number.isSafeInteger(settlementAt) ||
            settlementAt < evidenceStartedAt ||
            settlementAt - evidenceStartedAt > maxEvidenceAge) {
          return { kind: "ineligible" };
        }
        const updatedIntent = await client.query(
          `UPDATE vst_order_intents
           SET state = 'failed', outcome = $5::jsonb, updated_at = now()
           WHERE source_signal_id = $1 AND client_order_id = $2
             AND phase = $3 AND state = 'unknown'
             AND exchange_order_id IS NULL
             AND request = $4::jsonb AND outcome = $6::jsonb
           RETURNING client_order_id`,
          [signalId, orderId, intentPhase, requestJson,
            recoveryOutcomeJson, outcomeJson],
        );
        if (updatedIntent.rowCount !== 1) {
          throw new Error("VST raise_stop refusal intent compare-and-set failed");
        }
        const updatedSignal = await client.query(
          `UPDATE vst_signals SET status = 'open', reason = NULL, updated_at = now()
           WHERE source_signal_id = $1 AND status = 'unknown'
           RETURNING source_signal_id`,
          [signalId],
        );
        if (updatedSignal.rowCount !== 1) {
          throw new Error("VST raise_stop refusal signal compare-and-set failed");
        }
        await client.query(
          `INSERT INTO vst_events (source_signal_id, client_order_id, kind, detail)
           VALUES ($1, $2, 'vst_raise_stop_pre_upgrade_refusal_confirmed', $3::jsonb)`,
          [signalId, orderId, eventDetailJson],
        );
        return { kind: "recovered" };
      });
    },

    // Separate legacy repair boundary for the adapter's exact equal-price
    // pre-POST refusal. This is deliberately not a relaxation of the entry
    // proof-refusal recovery, whose target must be strictly higher.
    async recoverRaiseStopEqualPriceNoop({
      sourceSignalId, clientOrderId, phase, expectedRequest, expectedOutcome,
      expectedPositionSnapshot, expectedPositionUpdatedAt, expectedEntryIntent,
      entryProof, oldPositionAndStop, requestStartedAtMs, maxEvidenceAgeMs, clock,
    }) {
      const signalId = requireString(sourceSignalId, "sourceSignalId");
      const orderId = requireString(clientOrderId, "clientOrderId");
      const intentPhase = requireString(phase, "phase");
      const requestJson = serialize(expectedRequest, "expected equal-price raise_stop request");
      const outcomeJson = serialize(expectedOutcome, "expected equal-price raise_stop outcome");
      const snapshotJson = serialize(
        expectedPositionSnapshot, "expected equal-price raise_stop snapshot",
      );
      const updatedAt = requireString(
        expectedPositionUpdatedAt, "expected equal-price raise_stop updatedAt",
      );
      const entryIntent = requirePlainObject(expectedEntryIntent, "expected market-entry intent");
      const entryRequestJson = serialize(entryIntent.request, "expected market-entry request");
      const entryOutcomeJson = serialize(entryIntent.outcome, "expected market-entry outcome");
      const proof = requirePlainObject(entryProof, "equal-price raise_stop entry proof");
      const oldProof = requirePlainObject(
        oldPositionAndStop, "equal-price old position and stop proof",
      );
      const evidenceStartedAt = Number(requestStartedAtMs);
      const maxEvidenceAge = Number(maxEvidenceAgeMs);
      const deterministicId = `vst-${createHash("sha256")
        .update(`${signalId}:${intentPhase}`).digest("hex").slice(0, 30)}`;
      const positionId = exactPositiveIdentifier(oldProof.positionId);
      const stopOrderId = exactPositiveIdentifier(oldProof.stopOrderId);
      const positionQuantity = oldProof.quantity;
      const stopPrice = oldProof.stopPrice;
      const prior = expectedRequest?.priorPosition;
      const next = expectedRequest?.nextPosition;
      const stopsFor = (snapshot) => [
        snapshot?.verifiedProtectiveStops?.core,
        snapshot?.protectiveStops?.core,
        snapshot?.split?.coreStop,
        snapshot?.coreStop,
      ].filter((stop) => stop && typeof stop === "object" && !Array.isArray(stop));
      const baselineStops = stopsFor(expectedPositionSnapshot);
      const nextStops = stopsFor(next);
      const oldStops = [
        ...stopsFor(prior), ...nextStops, ...baselineStops,
      ];
      const sameStop = (stop) =>
        consistentIdentifierAliases(stop, "orderId", "orderID") === stopOrderId &&
        consistentIdentifierAliases(stop, "positionId", "positionID") === positionId &&
        exactDecimalEqual(
          consistentDecimalAliases(stop, "quantity", "origQty"), positionQuantity,
        ) &&
        exactDecimalEqual(stop.stopPrice, stopPrice);
      const exactEntry =
        entryIntent.sourceSignalId === signalId &&
        entryIntent.phase === "market-entry" &&
        entryIntent.state === "reconciled" &&
        typeof entryIntent.clientOrderId === "string" &&
        entryIntent.request?.operation === "entry" &&
        entryIntent.request?.environment === "vst" &&
        entryIntent.request?.accountId === expectedRequest?.accountId &&
        entryIntent.request?.symbol === expectedRequest?.symbol &&
        entryIntent.outcome?.verified === true &&
        entryIntent.outcome?.status === "filled" &&
        exactPositiveIdentifier(entryIntent.exchangeOrderId) !== null &&
        entryIntent.outcome?.positionId === proof.positionId &&
        proof.entryClientOrderId === entryIntent.clientOrderId &&
        proof.entryOrderId === entryIntent.exchangeOrderId &&
        proof.entryOrderType ===
          (entryIntent.request.entryOrderType ?? "LIMIT") &&
        proof.intentCreatedAt === entryIntent.request.intentCreatedAt &&
        exactDecimalEqual(proof.quantity,
          entryIntent.outcome.fillQuantity ?? entryIntent.outcome.totalQuantity) &&
        exactDecimalEqual(proof.quantity, entryIntent.request.quantity);
      const noManualResolution =
        expectedPositionSnapshot?.manualResolution == null &&
        expectedPositionSnapshot?.marginTopUp?.manualResolution == null;
      const targetExactlyEqual =
        exactDecimalEqual(expectedRequest?.stopPrice, stopPrice) &&
        exactDecimalEqual(expectedRequest?.quantity, positionQuantity) &&
        exactDecimalEqual(expectedRequest?.previousQuantity, positionQuantity) &&
        exactDecimalEqual(
          expectedPositionSnapshot?.remainingQty ??
            expectedPositionSnapshot?.quantity, positionQuantity,
        ) &&
        exactDecimalEqual(next?.remainingQty ?? next?.quantity, positionQuantity);
      const durableEntryOrderIds = [
        expectedRequest?.entryOrderId,
        expectedRequest?.entryProof?.entryOrderId,
        prior?.entryOrderId,
        next?.entryOrderId,
        expectedPositionSnapshot?.entryOrderId,
      ].filter((value) => value !== undefined && value !== null)
        .map(exactPositiveIdentifier);
      const requestEntryProof = expectedRequest?.entryProof;
      const requestEntryProofMatches = validObject(requestEntryProof) &&
        requestEntryProof.entryClientOrderId === proof.entryClientOrderId &&
        exactPositiveIdentifier(requestEntryProof.entryOrderId) === proof.entryOrderId &&
        exactPositiveIdentifier(requestEntryProof.positionId) === proof.positionId &&
        requestEntryProof.entryOrderType === proof.entryOrderType &&
        requestEntryProof.intentCreatedAt === proof.intentCreatedAt &&
        exactDecimalEqual(requestEntryProof.quantity, proof.quantity);
      if (!/^raise_stop-core-\d+$/.test(intentPhase) ||
          orderId !== deterministicId ||
          !exactRaiseStopEqualPriceRejection(
            expectedOutcome, intentPhase, expectedRequest,
          ) ||
          expectedRequest?.sourceSignalId !== signalId ||
          expectedRequest?.environment !== "vst" ||
          typeof expectedRequest?.accountId !== "string" ||
          expectedRequest?.symbol !== expectedPositionSnapshot?.symbol ||
          expectedPositionSnapshot?.status !== "open" ||
          expectedPositionSnapshot?.sourceSignalId !== signalId ||
          expectedPositionSnapshot?.environment !== "vst" ||
          expectedPositionSnapshot?.accountId !== expectedRequest.accountId ||
          expectedPositionSnapshot?.entryClientOrderId !== proof.entryClientOrderId ||
          consistentIdentifierAliases(
            expectedPositionSnapshot, "exchangePositionId", "positionId",
          ) !== positionId ||
          prior?.entryClientOrderId !== proof.entryClientOrderId ||
          next?.entryClientOrderId !== proof.entryClientOrderId ||
          consistentIdentifierAliases(prior, "exchangePositionId", "positionId") !==
            positionId ||
          consistentIdentifierAliases(next, "exchangePositionId", "positionId") !==
            positionId ||
          baselineStops.length === 0 || nextStops.length === 0 ||
          oldStops.some((stop) => !sameStop(stop)) ||
          !exactDecimalParts(positionQuantity) ||
          !exactDecimalParts(stopPrice) ||
          !positionId || !stopOrderId ||
          !explicitZeroExecutionProofMatches(oldProof.executionProof, stopOrderId) ||
          !exactEntry || !targetExactlyEqual || !noManualResolution ||
          expectedRequest?.entryClientOrderId !== proof.entryClientOrderId ||
          durableEntryOrderIds.length === 0 ||
          durableEntryOrderIds.some((id) => id !== proof.entryOrderId) ||
          (requestEntryProof !== undefined && !requestEntryProofMatches) ||
          exactPositiveIdentifier(expectedRequest?.positionId) !== positionId ||
          !Number.isSafeInteger(evidenceStartedAt) || evidenceStartedAt <= 0 ||
          !Number.isSafeInteger(maxEvidenceAge) || maxEvidenceAge <= 0 ||
          maxEvidenceAge > READ_ONLY_RECOVERY_MAX_EVIDENCE_AGE_MS ||
          typeof clock !== "function") {
        return { kind: "ineligible" };
      }

      const recoveryOutcome = {
        reason: "raise_stop_equal_price_noop_confirmed",
        noWriteConfirmed: true,
        noExchangeOrderId: true,
        entryProof: proof,
        oldPositionAndStop: oldProof,
      };
      const recoveryOutcomeJson = serialize(
        recoveryOutcome, "equal-price raise_stop recovery outcome",
      );
      const eventDetailJson = serialize({
        operation: "raise_stop",
        outcome: "equal_price_noop",
        reason: "raise_stop_equal_price_noop_confirmed",
        noWriteConfirmed: true,
        oldPositionAndStop: oldProof,
      }, "equal-price raise_stop recovery event");

      return transaction(pool, async (client) => {
        await lockSignalIntents(client, signalId);
        const lockedAt = Number(clock());
        if (!Number.isSafeInteger(lockedAt) ||
            lockedAt < evidenceStartedAt ||
            lockedAt - evidenceStartedAt > maxEvidenceAge) {
          return { kind: "ineligible" };
        }
        const signalResult = await client.query(
          `SELECT source_signal_id, status FROM vst_signals
           WHERE source_signal_id = $1 FOR UPDATE`,
          [signalId],
        );
        if (signalResult.rows[0]?.status !== "unknown") {
          return { kind: "ineligible" };
        }
        const positionResult = await client.query(
          `SELECT source_signal_id, status, snapshot, updated_at::text AS updated_at_text
           FROM vst_positions
           WHERE source_signal_id = $1 AND status = 'open'
             AND updated_at = $2::timestamptz
           FOR UPDATE`,
          [signalId, updatedAt],
        );
        const positionRow = positionResult.rows[0];
        if (!positionRow || positionRow.updated_at_text !== updatedAt ||
            serialize(positionRow.snapshot, "stored equal-price position") !== snapshotJson ||
            positionRow.snapshot?.manualResolution != null ||
            positionRow.snapshot?.marginTopUp?.manualResolution != null) {
          return { kind: "ineligible" };
        }
        const targetResult = await client.query(
          `SELECT source_signal_id, phase, client_order_id, request, state,
                  exchange_order_id, outcome
           FROM vst_order_intents
           WHERE source_signal_id = $1 AND client_order_id = $2 FOR UPDATE`,
          [signalId, orderId],
        );
        const target = targetResult.rows[0];
        if (!target || target.phase !== intentPhase || target.state !== "unknown" ||
            target.exchange_order_id !== null ||
            serialize(target.request, "stored equal-price request") !== requestJson ||
            serialize(target.outcome, "stored equal-price outcome") !== outcomeJson ||
            !exactRaiseStopEqualPriceRejection(
              target.outcome, target.phase, target.request,
            )) {
          return { kind: "ineligible" };
        }
        const entryResult = await client.query(
          `SELECT source_signal_id, phase, client_order_id, request, state,
                  exchange_order_id, outcome
           FROM vst_order_intents
           WHERE source_signal_id = $1 AND phase = 'market-entry' FOR UPDATE`,
          [signalId],
        );
        const currentEntry = entryResult.rows[0];
        if (!currentEntry ||
            currentEntry.client_order_id !== entryIntent.clientOrderId ||
            currentEntry.state !== entryIntent.state ||
            currentEntry.exchange_order_id !== entryIntent.exchangeOrderId ||
            serialize(currentEntry.request, "stored market-entry request") !==
              entryRequestJson ||
            serialize(currentEntry.outcome, "stored market-entry outcome") !==
              entryOutcomeJson) {
          return { kind: "ineligible" };
        }
        const competing = await client.query(
          `SELECT client_order_id FROM vst_order_intents
           WHERE source_signal_id = $1 AND client_order_id <> $2
             AND state IN ('prepared', 'submitted', 'unknown')
           ORDER BY client_order_id FOR UPDATE`,
          [signalId, orderId],
        );
        if (competing.rows.length) return { kind: "ineligible" };
        const settledAt = Number(clock());
        if (!Number.isSafeInteger(settledAt) ||
            settledAt < evidenceStartedAt ||
            settledAt - evidenceStartedAt > maxEvidenceAge) {
          return { kind: "ineligible" };
        }
        const updated = await client.query(
          `UPDATE vst_order_intents
           SET state = 'failed', outcome = $5::jsonb, updated_at = now()
           WHERE source_signal_id = $1 AND client_order_id = $2
             AND phase = $3 AND state = 'unknown'
             AND exchange_order_id IS NULL
             AND request = $4::jsonb AND outcome = $6::jsonb
           RETURNING client_order_id`,
          [signalId, orderId, intentPhase, requestJson,
            recoveryOutcomeJson, outcomeJson],
        );
        if (updated.rowCount !== 1) {
          throw new Error("VST equal-price raise_stop intent compare-and-set failed");
        }
        const updatedSignal = await client.query(
          `UPDATE vst_signals SET status = 'open', reason = NULL, updated_at = now()
           WHERE source_signal_id = $1 AND status = 'unknown'
           RETURNING source_signal_id`,
          [signalId],
        );
        if (updatedSignal.rowCount !== 1) {
          throw new Error("VST equal-price raise_stop signal compare-and-set failed");
        }
        await client.query(
          `INSERT INTO vst_events (source_signal_id, client_order_id, kind, detail)
           VALUES ($1, $2, 'vst_raise_stop_equal_price_noop_confirmed', $3::jsonb)`,
          [signalId, orderId, eventDetailJson],
        );
        return { kind: "recovered" };
      });
    },

    // Retire a NULL-ID legacy raise-stop only after an independently linked,
    // currently active protection has been read and verified. The original
    // execution remains explicitly unknown; the active stop is not attributed
    // to the original POST.
    async adoptUnlinkedRaiseStopProtection({
      sourceSignalId, clientOrderId, phase, expectedRequest, expectedOutcome,
      expectedPositionSnapshot, expectedPositionUpdatedAt, expectedEntryIntent,
      position, currentProtection, entryProof, eventDetail, requestStartedAtMs,
      maxEvidenceAgeMs, clock, oldStopRetirement, protectedDegraded = false,
      observedDegradedRecovery = false,
    }) {
      const signalId = requireString(sourceSignalId, "sourceSignalId");
      const orderId = requireString(clientOrderId, "clientOrderId");
      const intentPhase = requireString(phase, "phase");
      const requestJson = serialize(expectedRequest, "unlinked raise_stop request");
      const outcomeJson = serialize(expectedOutcome, "unlinked raise_stop outcome");
      const snapshotJson = serialize(expectedPositionSnapshot, "unlinked position snapshot");
      const positionJson = serialize(position, "adopted VST position");
      const eventJson = serialize(eventDetail, "adopted protection event");
      const proof = requirePlainObject(entryProof, "unlinked raise_stop entry proof");
      const protection = requirePlainObject(currentProtection, "verified current protection");
      const entryIntent = requirePlainObject(expectedEntryIntent, "market-entry intent");
      const entryRequestJson = serialize(entryIntent.request, "market-entry request");
      const entryOutcomeJson = serialize(entryIntent.outcome, "market-entry outcome");
      const updatedAt = requireString(expectedPositionUpdatedAt,
        "expectedPositionUpdatedAt");
      const startedAt = Number(requestStartedAtMs);
      const maxAge = Number(maxEvidenceAgeMs);
      const deterministicId = `vst-${createHash("sha256")
        .update(`${signalId}:${intentPhase}`).digest("hex").slice(0, 30)}`;
      const stopId = exactPositiveIdentifier(protection.orderId);
      const positionId = exactPositiveIdentifier(protection.positionId);
      const prior = expectedRequest?.priorPosition;
      const oldStop = prior?.verifiedProtectiveStops?.core;
      const requestEntryProof = expectedRequest?.entryProof;
      const hasOldStopRetirement = oldStopRetirement !== undefined;
      const marker = expectedPositionSnapshot?.protectionDegradation;
      if (observedDegradedRecovery && (protectedDegraded || hasOldStopRetirement ||
          marker?.version !== 1 || marker.status !== "protected_degraded" ||
          marker.originalClientOrderId !== orderId || marker.originalPhase !== intentPhase ||
          !exactDecimalEqual(marker.requestedStopPrice, expectedRequest?.stopPrice) ||
          marker.originalExecution !== "unknown_unproven" ||
          marker.originalWriteAttributed !== false ||
          expectedOutcome?.reason !== "raise_stop_protected_degraded" ||
          expectedOutcome?.originalExecution !== "unknown_unproven")) return { kind: "ineligible" };
      if (protectedDegraded && (hasOldStopRetirement ||
          (expectedRequest?.stopTransferProtocol != null &&
            !(expectedRequest.stopTransferProtocol === 1 &&
              expectedOutcome?.stopTransfer?.version === 1 &&
              expectedOutcome.stopTransfer.stage === "post_started")) ||
          protection.orderId !== oldStop?.orderId ||
          !exactDecimalEqual(protection.stopPrice, oldStop?.stopPrice) ||
          compareExactDecimals(expectedRequest?.stopPrice, protection.stopPrice) <= 0 ||
          expectedPositionSnapshot?.protectionDegradation != null)) {
        return { kind: "ineligible" };
      }
      let retirementMarker = null;
      if (hasOldStopRetirement) {
        const exactKeys = (value, keys) => validObject(value) &&
          Object.keys(value).length === keys.length &&
          keys.every((key) => Object.hasOwn(value, key));
        const retirementStopKeys = ["orderId", "positionId", "quantity", "stopPrice"];
        const validId = (value) => typeof value === "string" &&
          /^\d+$/.test(value) && BigInt(value) > 0n;
        const suppliedOld = oldStopRetirement?.oldStop;
        const suppliedAdopted = oldStopRetirement?.adoptedStop;
        const oldId = suppliedOld?.orderId;
        const adoptedId = suppliedAdopted?.orderId;
        const oldStopMatches = exactKeys(suppliedOld, retirementStopKeys) &&
          validId(oldId) && oldId === exactPositiveIdentifier(oldStop?.orderId) &&
          suppliedOld.positionId === exactPositiveIdentifier(oldStop?.positionId) &&
          exactDecimalEqual(suppliedOld.quantity, oldStop?.quantity) &&
          exactDecimalEqual(suppliedOld.stopPrice, oldStop?.stopPrice);
        const adoptedStopMatches = exactKeys(suppliedAdopted, retirementStopKeys) &&
          validId(adoptedId) && adoptedId === stopId &&
          suppliedAdopted.positionId === positionId &&
          exactDecimalEqual(suppliedAdopted.quantity, protection.quantity) &&
          exactDecimalEqual(suppliedAdopted.stopPrice, protection.stopPrice);
        if (!exactKeys(oldStopRetirement, ["oldStop", "adoptedStop"]) ||
            !validId(oldId) || !validId(adoptedId) || oldId === adoptedId ||
            !oldStopMatches || !adoptedStopMatches ||
            !validId(positionId) || oldId === stopId ||
            !exactDecimalEqual(suppliedOld.quantity, suppliedAdopted.quantity) ||
            suppliedOld.positionId !== suppliedAdopted.positionId ||
            compareExactDecimals(suppliedAdopted.stopPrice, suppliedOld.stopPrice) <= 0 ||
            Object.hasOwn(expectedPositionSnapshot ?? {}, "pendingStopRetirement")) {
          return { kind: "ineligible" };
        }
        retirementMarker = {
          oldStop: suppliedOld,
          adoptedStop: suppliedAdopted,
          entryProof: proof,
          originalIntent: { clientOrderId: orderId, phase: intentPhase },
        };
      } else if (Object.hasOwn(expectedPositionSnapshot ?? {}, "pendingStopRetirement") ||
          Object.hasOwn(position ?? {}, "pendingStopRetirement")) {
        return { kind: "ineligible" };
      }
      if (orderId !== deterministicId ||
          !/^raise_stop-core-\d+(?:-\d+)?$/.test(intentPhase) ||
          expectedRequest?.operation !== "raise_stop" ||
          expectedRequest?.sourceSignalId !== signalId ||
          expectedRequest?.environment !== "vst" ||
          expectedRequest?.leg !== "core" ||
          expectedRequest?.accountId !== expectedPositionSnapshot?.accountId ||
          expectedRequest?.symbol !== expectedPositionSnapshot?.symbol ||
          expectedPositionSnapshot?.sourceSignalId !== signalId ||
          !["unknown", "open"].includes(expectedPositionSnapshot?.status) ||
          (!observedDegradedRecovery && expectedOutcome?.reason !== "exchange_state_not_verified") ||
          expectedRequest?.priorPosition?.coreOpen !== true ||
          expectedRequest?.priorPosition?.runnerOpen !== false ||
          expectedRequest?.priorPosition?.split != null ||
          expectedPositionSnapshot?.coreOpen !== true ||
          expectedPositionSnapshot?.runnerOpen !== false ||
          expectedPositionSnapshot?.split != null ||
          oldStop?.verified !== true ||
          !exactPositiveIdentifier(oldStop.orderId) ||
          !exactPositiveIdentifier(expectedPositionSnapshot?.coreStopOrderId) ||
          exactPositiveIdentifier(oldStop.orderId) !==
            exactPositiveIdentifier(expectedPositionSnapshot?.coreStopOrderId) ||
          exactPositiveIdentifier(oldStop.positionId) !== positionId ||
          !exactDecimalEqual(oldStop.quantity, expectedRequest?.previousQuantity) ||
          !exactDecimalEqual(expectedPositionSnapshot?.remainingQty ??
            expectedPositionSnapshot?.quantity, expectedRequest?.previousQuantity) ||
          !exactDecimalEqual(expectedRequest?.quantity, expectedRequest?.previousQuantity) ||
          !validObject(requestEntryProof) ||
          requestEntryProof.entryClientOrderId !== proof.entryClientOrderId ||
          exactPositiveIdentifier(requestEntryProof.entryOrderId) !==
            exactPositiveIdentifier(proof.entryOrderId) ||
          exactPositiveIdentifier(requestEntryProof.positionId) !==
            exactPositiveIdentifier(proof.positionId) ||
          requestEntryProof.entryOrderType !== proof.entryOrderType ||
          requestEntryProof.intentCreatedAt !== proof.intentCreatedAt ||
          !exactDecimalEqual(requestEntryProof.quantity, proof.quantity) ||
          !stopId || !positionId ||
          protection.status !== "NEW" ||
          protection.workingType !== "MARK_PRICE" ||
          exactPositiveIdentifier(expectedRequest.positionId) !== positionId ||
          !exactDecimalEqual(protection.quantity, expectedRequest.quantity) ||
          (!protectedDegraded && (!exactDecimalEqual(protection.stopPrice, expectedRequest.stopPrice) ||
          compareExactDecimals(protection.stopPrice,
            expectedRequest.priorPosition?.verifiedProtectiveStops?.core?.stopPrice) <= 0)) ||
          !validObject(position) || position.sourceSignalId !== signalId ||
          position.status !== "open" || position.symbol !== expectedRequest.symbol ||
          position.accountId !== expectedRequest.accountId ||
          exactPositiveIdentifier(position.exchangePositionId ??
            position.positionId) !== positionId ||
          !exactDecimalEqual(position.quantity ?? position.remainingQty,
            expectedRequest.quantity) ||
          entryIntent.sourceSignalId !== signalId ||
          entryIntent.phase !== "market-entry" || entryIntent.state !== "reconciled" ||
          entryIntent.request?.operation !== "entry" ||
          entryIntent.request?.environment !== "vst" ||
          entryIntent.request?.accountId !== expectedRequest.accountId ||
          entryIntent.request?.symbol !== expectedRequest.symbol ||
          entryIntent.outcome?.verified !== true ||
          entryIntent.outcome?.status !== "filled" ||
          entryIntent.exchangeOrderId !== proof.entryOrderId ||
          entryIntent.clientOrderId !== proof.entryClientOrderId ||
          entryIntent.outcome?.positionId !== proof.positionId ||
          !exactDecimalEqual(entryIntent.outcome.fillQuantity ??
            entryIntent.outcome.totalQuantity, proof.quantity) ||
          !Number.isSafeInteger(startedAt) || startedAt <= 0 ||
          !Number.isSafeInteger(Number(expectedRequest?.intentCreatedAt)) ||
          startedAt < Number(expectedRequest.intentCreatedAt) ||
          !Number.isSafeInteger(maxAge) || maxAge <= 0 ||
          maxAge > READ_ONLY_RECOVERY_MAX_EVIDENCE_AGE_MS ||
          typeof clock !== "function") {
        return { kind: "ineligible" };
      }
      const expectedRecoveredPosition = {
        ...expectedPositionSnapshot,
        status: "open",
        stopPrice: Number(protection.stopPrice),
        coreStopOrderId: stopId,
        coreStopPositionId: positionId,
        coreStopQuantity: String(protection.quantity),
        coreStopPrice: Number(protection.stopPrice),
        verifiedProtectiveStops: {
          ...expectedPositionSnapshot.verifiedProtectiveStops,
          core: {
            verified: true,
            tranche: "core",
            orderId: stopId,
            positionId,
            quantity: String(protection.quantity),
            stopPrice: String(protection.stopPrice),
          },
        },
      };
      if (retirementMarker) {
        expectedRecoveredPosition.pendingStopRetirement = retirementMarker;
      }
      if (protectedDegraded) {
        expectedRecoveredPosition.protectionDegradation = protectedDegradedMarker({
          clientOrderId: orderId, phase: intentPhase, request: expectedRequest,
        }, protection, startedAt);
      }
      if (observedDegradedRecovery) {
        expectedRecoveredPosition.protectionDegradation = {
          ...marker, status: "protection_observed_attribution_unknown",
          currentProtection: protection, protectionObservedAt: startedAt,
        };
      }
      if (serialize(expectedRecoveredPosition, "expected adopted position") !==
          positionJson) return { kind: "ineligible" };
      const recoveredOutcome = {
        reason: protectedDegraded ? "raise_stop_protected_degraded" : observedDegradedRecovery
          ? "raise_stop_degraded_protection_observed" : "raise_stop_unlinked_protection_adopted",
        originalExecution: "unknown_unproven",
        originalOutcome: observedDegradedRecovery ? expectedOutcome.originalOutcome : expectedOutcome,
        currentProtection: protection,
        entryProof: proof,
        ...(expectedOutcome?.originalSubmissionOutcome ? {
          originalSubmissionOutcome: expectedOutcome.originalSubmissionOutcome,
        } : {}),
        ...(expectedOutcome?.uncertaintyRead ? {
          uncertaintyRead: expectedOutcome.uncertaintyRead,
        } : {}),
        ...(expectedOutcome?.stopTransfer ? { stopTransfer: expectedOutcome.stopTransfer } : {}),
      };
      if (retirementMarker) recoveredOutcome.oldStopRetirement = retirementMarker;
      const recoveredOutcomeJson = serialize(recoveredOutcome,
        "unlinked raise_stop adoption outcome");
      return transaction(pool, async (client) => {
        await lockSignalIntents(client, signalId);
        const now = Number(clock());
        if (!Number.isSafeInteger(now) || now < startedAt || now - startedAt > maxAge) {
          return { kind: "ineligible" };
        }
        const signalResult = await client.query(
          `SELECT status FROM vst_signals WHERE source_signal_id = $1 FOR UPDATE`,
          [signalId],
        );
        const signalStatus = signalResult.rows[0]?.status;
        if (signalStatus !== "unknown" && !((protectedDegraded || observedDegradedRecovery) && signalStatus === "open")) {
          return { kind: "ineligible" };
        }
        const positionResult = await client.query(
          `SELECT status, snapshot, updated_at::text AS updated_at_text
           FROM vst_positions WHERE source_signal_id = $1 AND status IN ('unknown','open')
             AND updated_at = $2::timestamptz FOR UPDATE`,
          [signalId, updatedAt],
        );
        const positionRow = positionResult.rows[0];
        if (!positionRow || positionRow.updated_at_text !== updatedAt ||
            !["unknown", "open"].includes(positionRow.status) ||
            serialize(positionRow.snapshot, "stored unlinked position") !== snapshotJson) {
          return { kind: "ineligible" };
        }
        const targetResult = await client.query(
          `SELECT phase, state, request, exchange_order_id, outcome
           FROM vst_order_intents
           WHERE source_signal_id = $1 AND client_order_id = $2 FOR UPDATE`,
          [signalId, orderId],
        );
        const target = targetResult.rows[0];
        const expectedState = observedDegradedRecovery ? "failed" : "unknown";
        if (!target || target.phase !== intentPhase || target.state !== expectedState ||
            target.exchange_order_id !== null ||
            serialize(target.request, "stored unlinked request") !== requestJson ||
            serialize(target.outcome, "stored unlinked outcome") !== outcomeJson) {
          return { kind: "ineligible" };
        }
        const entryResult = await client.query(
          `SELECT phase, client_order_id, request, state, exchange_order_id, outcome
           FROM vst_order_intents
           WHERE source_signal_id = $1 AND phase = 'market-entry' FOR UPDATE`,
          [signalId],
        );
        const currentEntry = entryResult.rows[0];
        if (!currentEntry || currentEntry.client_order_id !== entryIntent.clientOrderId ||
            currentEntry.state !== "reconciled" ||
            currentEntry.exchange_order_id !== entryIntent.exchangeOrderId ||
            serialize(currentEntry.request, "stored market entry request") !== entryRequestJson ||
            serialize(currentEntry.outcome, "stored market entry outcome") !== entryOutcomeJson) {
          return { kind: "ineligible" };
        }
        const competing = await client.query(
          `SELECT client_order_id FROM vst_order_intents
           WHERE client_order_id <> $1
             AND state IN ('prepared','submitted','unknown')
             AND request->>'environment' = 'vst'
             AND request->>'accountId' = $2
             AND request->>'symbol' = $3
             AND (request->>'positionId' = $4
               OR request->>'exchangePositionId' = $4
               OR request->'entryProof'->>'positionId' = $4
               OR request->'priorPosition'->>'exchangePositionId' = $4)
           ORDER BY client_order_id FOR UPDATE`,
          [orderId, expectedRequest.accountId, expectedRequest.symbol,
            positionId],
        );
        if (competing.rows.length) return { kind: "ineligible" };
        const settledAt = Number(clock());
        if (!Number.isSafeInteger(settledAt) || settledAt < startedAt ||
            settledAt - startedAt > maxAge) return { kind: "ineligible" };
        const updatedIntent = await client.query(
          `UPDATE vst_order_intents SET state = 'failed', outcome = $5::jsonb,
             updated_at = now()
           WHERE source_signal_id = $1 AND client_order_id = $2 AND phase = $3
             AND state = $7 AND exchange_order_id IS NULL
             AND request = $4::jsonb AND outcome = $6::jsonb
           RETURNING client_order_id`,
          [signalId, orderId, intentPhase, requestJson,
            recoveredOutcomeJson, outcomeJson, expectedState],
        );
        if (updatedIntent.rowCount !== 1) return { kind: "ineligible" };
        const updatedPosition = await client.query(
          `UPDATE vst_positions SET status = 'open', snapshot = $3::jsonb, updated_at = now()
           WHERE source_signal_id = $1 AND status = $2
             AND updated_at = $4::timestamptz AND snapshot = $5::jsonb
           RETURNING source_signal_id`,
          [signalId, positionRow.status, positionJson, updatedAt, snapshotJson],
        );
        if (updatedPosition.rowCount !== 1) {
          throw new Error("VST unlinked raise_stop position compare-and-set failed");
        }
        const updatedSignal = await client.query(
          `UPDATE vst_signals SET status = 'open', reason = NULL, updated_at = now()
           WHERE source_signal_id = $1 AND status = $2
           RETURNING source_signal_id`,
          [signalId, signalStatus],
        );
        if (updatedSignal.rowCount !== 1) {
          throw new Error("VST unlinked raise_stop signal compare-and-set failed");
        }
        await client.query(
          `INSERT INTO vst_events (source_signal_id, client_order_id, kind, detail)
           VALUES ($1, $2, $4, $3::jsonb)`,
          [signalId, orderId, eventJson,
            protectedDegraded ? "vst_stop_protection_degraded" : observedDegradedRecovery
              ? "vst_stop_degraded_protection_observed" : "vst_stop_protection_adopted"],
        );
        return { kind: "recovered" };
      });
    },

    // An exact no-send raise_stop refusal can be retired only after the
    // position's own stop-triggered close has already been committed from its
    // child-fill ledger evidence. A flat account or a zero local quantity is
    // not accepted as closure proof.
    async settleRaiseStopRefusalAfterVerifiedClose({
      sourceSignalId, clientOrderId, phase, expectedRequest, expectedOutcome,
      expectedPositionSnapshot, expectedPositionUpdatedAt, oldStopOrderId,
      closePhase, closeIntent,
    }) {
      const signalId = requireString(sourceSignalId, "sourceSignalId");
      const oldOrderId = requireString(clientOrderId, "clientOrderId");
      const intentPhase = requireString(phase, "phase");
      const stopId = requireString(oldStopOrderId, "oldStopOrderId");
      const closeIntentPhase = requireString(closePhase, "closePhase");
      const requestJson = serialize(expectedRequest, "expected raise_stop request");
      const outcomeJson = serialize(expectedOutcome, "expected raise_stop outcome");
      const snapshotJson = serialize(
        expectedPositionSnapshot, "expected verified closed position",
      );
      const updatedAt = requireString(
        expectedPositionUpdatedAt, "expected closed position updatedAt",
      );
      const closeRequest = closeIntent?.request;
      const closeOutcome = closeIntent?.outcome;
      const fill = closeOutcome?.fill;
      const snapshotFill = expectedPositionSnapshot?.lastCloseFill;
      const positionId = consistentIdentifierAliases(
        expectedPositionSnapshot, "exchangePositionId", "positionId",
      );
      const expectedQuantity = expectedRequest?.previousQuantity ??
        expectedRequest?.quantity;
      const oldStop = [
        expectedRequest?.priorPosition?.verifiedProtectiveStops?.core,
        expectedRequest?.priorPosition?.protectiveStops?.core,
        expectedRequest?.priorPosition?.split?.coreStop,
        expectedRequest?.priorPosition?.coreStop,
        expectedRequest?.oldStop,
      ].filter(validObject);
      const oldStopIds = oldStop.map((row) =>
        consistentIdentifierAliases(row, "orderId", "orderID"));
      const oldStopPrice = oldStop[0]?.stopPrice;
      const deterministicCloseId = `vst-${createHash("sha256")
        .update(`${signalId}:${closeIntentPhase}`).digest("hex").slice(0, 30)}`;
      const exactCloseFill =
        closeIntent?.state === "reconciled" &&
        closeIntent.clientOrderId === deterministicCloseId &&
        closeIntent.exchangeOrderId === fill?.orderId &&
        closeRequest?.operation === "observe_triggered_stop" &&
        closeRequest?.environment === "vst" &&
        closeRequest?.accountId === expectedPositionSnapshot?.accountId &&
        closeRequest?.symbol === expectedPositionSnapshot?.symbol &&
        consistentIdentifierAliases(closeRequest, "positionId", "positionID") ===
          positionId &&
        consistentIdentifierAliases(closeRequest, "stopOrderId") === stopId &&
        exactDecimalEqual(closeRequest?.stopQuantity, expectedQuantity) &&
        exactDecimalEqual(closeRequest?.stopPrice, oldStopPrice) &&
        closeOutcome?.verified === true &&
        closeOutcome.status === "filled" &&
        closeOutcome.operation === "observe_triggered_stop" &&
        consistentIdentifierAliases(closeOutcome, "parentStopId") === stopId &&
        exactDecimalEqual(closeOutcome.parentStopPrice, oldStopPrice) &&
        closeOutcome.childOrderId === fill?.orderId &&
        fill?.triggerOrderId === stopId &&
        typeof fill?.orderId === "string" && fill.orderId.trim() !== "" &&
        exactDecimalEqual(fill.quantity, expectedQuantity) &&
        compareExactDecimals(fill.price, 0) === 1 &&
        Number.isSafeInteger(Date.parse(fill.at ?? "")) &&
        fill?.feeEvidenceAvailable === true &&
        validObject(fill.fee) &&
        typeof fill.fee.asset === "string" && fill.fee.asset.trim() !== "" &&
        (typeof fill.fee.amount === "string" ||
          typeof fill.fee.amount === "number") &&
        Number.isFinite(Number(fill.fee.amount)) &&
        closeOutcome.residualPosition?.verified === true &&
        consistentIdentifierAliases(
          closeOutcome.residualPosition, "positionId", "positionID",
        ) === positionId &&
        exactDecimalEqual(closeOutcome.residualPosition.quantity, 0) &&
        Array.isArray(closeOutcome.openStops) &&
        closeOutcome.openStops.length === 0 &&
        expectedPositionSnapshot?.status === "closed" &&
        exactDecimalEqual(expectedPositionSnapshot.remainingQty, 0) &&
        snapshotFill?.orderId === fill.orderId &&
        snapshotFill?.triggerOrderId === stopId &&
        exactDecimalEqual(snapshotFill?.quantity, expectedQuantity) &&
        exactDecimalEqual(snapshotFill?.price, fill.price) &&
        snapshotFill?.at === fill.at &&
        snapshotFill?.feeEvidenceAvailable === true &&
        snapshotFill?.fee?.asset === fill.fee.asset &&
        exactDecimalEqual(snapshotFill?.fee?.amount, fill.fee.amount) &&
        expectedPositionSnapshot.triggeredStop?.parentStopId === stopId &&
        exactDecimalEqual(
          expectedPositionSnapshot.triggeredStop?.parentStopPrice, oldStopPrice,
        ) &&
        expectedPositionSnapshot.triggeredStop?.childOrderId === fill.orderId;
      if (oldOrderId !== `vst-${createHash("sha256")
        .update(`${signalId}:${intentPhase}`).digest("hex").slice(0, 30)}` ||
          !/^raise_stop-core-\d+$/.test(intentPhase) &&
            !/^impulse-sole-core-stop-\d+$/.test(intentPhase) ||
          expectedRequest?.operation !== "raise_stop" ||
          expectedRequest?.leg !== "core" ||
          expectedRequest?.sourceSignalId !== undefined &&
            expectedRequest.sourceSignalId !== signalId ||
          expectedRequest?.environment !== "vst" ||
          expectedRequest?.accountId !== expectedPositionSnapshot?.accountId ||
          expectedRequest?.symbol !== expectedPositionSnapshot?.symbol ||
          !exactRaiseStopRefusal(expectedOutcome, intentPhase, expectedRequest) ||
          expectedPositionSnapshot?.sourceSignalId !== signalId ||
          expectedPositionSnapshot?.environment !== "vst" ||
          typeof expectedPositionSnapshot?.accountId !== "string" ||
          expectedPositionSnapshot?.manualResolution != null ||
          expectedQuantity === undefined ||
          oldStop.length === 0 ||
          oldStopIds.some((id) => id !== stopId) ||
          oldStop.some((row) =>
            row.verified !== true ||
            consistentIdentifierAliases(row, "positionId", "positionID") !==
              positionId ||
            !exactDecimalEqual(consistentDecimalAliases(row, "quantity", "origQty"),
              expectedQuantity) ||
            !exactDecimalEqual(row.stopPrice, oldStopPrice)) ||
          closeIntentPhase !== `triggered-stop-${createHash("sha256")
            .update(stopId).digest("hex").slice(0, 24)}` ||
          closeIntent?.sourceSignalId !== signalId ||
          !exactCloseFill) {
        return { kind: "ineligible", reason: "proof_shape_mismatch" };
      }
      const eventDetailJson = serialize({
        outcome: "raise_stop_refusal_retired_after_committed_close",
        stopOrderId: stopId,
        childOrderId: fill.orderId,
        closePhase: closeIntentPhase,
        closeIntentEvidence: closeIntent.outcome,
      }, "raise_stop committed-close settlement event");

      return transaction(pool, async (client) => {
        await lockSignalIntents(client, signalId);
        const signalResult = await client.query(
          `SELECT source_signal_id, status
           FROM vst_signals WHERE source_signal_id = $1 FOR UPDATE`,
          [signalId],
        );
        const positionResult = await client.query(
          `SELECT source_signal_id, symbol, status, snapshot,
                  updated_at::text AS updated_at_text
           FROM vst_positions WHERE source_signal_id = $1 AND status = 'closed'
           FOR UPDATE`,
          [signalId],
        );
        const oldIntentResult = await client.query(
          `SELECT source_signal_id, phase, client_order_id, request, state,
                  exchange_order_id, outcome
           FROM vst_order_intents
           WHERE source_signal_id = $1 AND client_order_id = $2 FOR UPDATE`,
          [signalId, oldOrderId],
        );
        const closeIntentResult = await client.query(
          `SELECT source_signal_id, phase, client_order_id, request, state,
                  exchange_order_id, outcome
           FROM vst_order_intents
           WHERE source_signal_id = $1 AND phase = $2 FOR UPDATE`,
          [signalId, closeIntentPhase],
        );
        const signal = signalResult.rows[0];
        const positionRow = positionResult.rows[0];
        const oldIntent = oldIntentResult.rows[0];
        const committedClose = closeIntentResult.rows[0];
        const replayed = signal?.status === "closed" &&
          positionRow?.status === "closed" &&
          serialize(positionRow.snapshot, "stored closed position") === snapshotJson &&
          oldIntent?.state === "failed" &&
          oldIntent.exchange_order_id === null &&
          serialize(oldIntent.request, "stored raise_stop request") === requestJson &&
          serialize(oldIntent.outcome, "stored raise_stop outcome") === outcomeJson &&
          committedClose?.client_order_id === closeIntent.clientOrderId &&
          committedClose.state === "reconciled" &&
          committedClose.exchange_order_id === closeIntent.exchangeOrderId &&
          serialize(committedClose.request, "stored stop-close request") ===
            serialize(closeIntent.request, "expected stop-close request") &&
          serialize(committedClose.outcome, "stored stop-close outcome") ===
            serialize(closeIntent.outcome, "expected stop-close outcome");
        if (replayed) return { kind: "replayed" };
        if (signal?.status !== "closed" ||
            positionRow?.status !== "closed" ||
            positionRow.symbol !== expectedPositionSnapshot.symbol ||
            positionRow?.updated_at_text !== updatedAt ||
            serialize(positionRow.snapshot, "stored closed position") !== snapshotJson ||
            oldIntent?.phase !== intentPhase ||
            oldIntent.state !== "unknown" ||
            oldIntent.exchange_order_id !== null ||
            serialize(oldIntent.request, "stored raise_stop request") !== requestJson ||
            serialize(oldIntent.outcome, "stored raise_stop outcome") !== outcomeJson ||
            committedClose?.client_order_id !== closeIntent.clientOrderId ||
            committedClose.state !== "reconciled" ||
            committedClose.exchange_order_id !== closeIntent.exchangeOrderId ||
            serialize(committedClose.request, "stored stop-close request") !==
              serialize(closeIntent.request, "expected stop-close request") ||
            serialize(committedClose.outcome, "stored stop-close outcome") !==
              serialize(closeIntent.outcome, "expected stop-close outcome")) {
          return { kind: "ineligible", reason: "position_changed" };
        }
        const updatedIntent = await client.query(
          `UPDATE vst_order_intents
           SET state = 'failed', updated_at = now()
           WHERE source_signal_id = $1 AND client_order_id = $2
             AND phase = $3 AND state = 'unknown'
             AND exchange_order_id IS NULL
             AND request = $4::jsonb AND outcome = $5::jsonb
           RETURNING client_order_id`,
          [signalId, oldOrderId, intentPhase, requestJson, outcomeJson],
        );
        if (updatedIntent.rowCount !== 1) {
          throw new Error("VST raise_stop closed-fill settlement CAS failed");
        }
        await client.query(
          `INSERT INTO vst_events (source_signal_id, client_order_id, kind, detail)
           VALUES ($1, $2, 'vst_raise_stop_refusal_settled_after_closed_fill', $3::jsonb)`,
          [signalId, oldOrderId, eventDetailJson],
        );
        return { kind: "recovered" };
      });
    },

    // Retires only the exact original-split-stop cancellation whose leverage
    // GET was proven to fail before DELETE. The old intent is never marked
    // canceled; a durable retry phase is written into the unchanged split
    // state so a later tick must create a distinct cancellation intent.
    async recoverPreDeleteOriginalStopCancel({
      sourceSignalId, clientOrderId, phase, expectedRequest, expectedOutcome,
      expectedPositionSnapshot, expectedPositionUpdatedAt, recoveryPosition,
      recoveryPhase, requestStartedAtMs, maxEvidenceAgeMs, clock,
      verifiedPositionAndStops,
    }) {
      const signalId = requireString(sourceSignalId, "sourceSignalId");
      const orderId = requireString(clientOrderId, "clientOrderId");
      const intentPhase = requireString(phase, "phase");
      const retryPhase = requireString(recoveryPhase, "recoveryPhase");
      const requestJson = serialize(
        expectedRequest, "expected original-stop cancellation request",
      );
      const outcomeJson = serialize(
        expectedOutcome, "expected original-stop cancellation outcome",
      );
      const positionJson = serialize(
        expectedPositionSnapshot, "expected original-stop cancellation position",
      );
      const recoveryPositionJson = serialize(
        recoveryPosition, "original-stop cancellation recovery position",
      );
      const evidenceAt = Number(requestStartedAtMs);
      const maxEvidenceAge = Number(maxEvidenceAgeMs);
      if (!Number.isSafeInteger(evidenceAt) || evidenceAt <= 0 ||
          !Number.isSafeInteger(maxEvidenceAge) || maxEvidenceAge <= 0 ||
          maxEvidenceAge > READ_ONLY_RECOVERY_MAX_EVIDENCE_AGE_MS ||
          typeof clock !== "function") {
        return { kind: "ineligible", reason: "invalid_evidence_time" };
      }
      const mutationProvenance = expectedOutcome?.mutationProvenance;
      const exactMutationProvenance = mutationProvenance &&
        typeof mutationProvenance === "object" &&
        !Array.isArray(mutationProvenance) &&
        Object.keys(mutationProvenance).sort().join("|") ===
          "mutationEndpoint|mutationMethod|mutationRequestSent|operation|phase" &&
        mutationProvenance.operation === "cancel_original_stop" &&
        mutationProvenance.mutationMethod === "DELETE" &&
        mutationProvenance.mutationEndpoint === "/openApi/swap/v2/trade/order" &&
        mutationProvenance.mutationRequestSent === false &&
        mutationProvenance.phase === "pre_mutation_read";
      const expectedLegacyMessage =
        "BingX request failed (GET /openApi/swap/v2/trade/leverage, HTTP 200, code 109400, msg: timestamp is invalid)";
      const outcomeKeys = uncertaintyEvidenceKeys(expectedOutcome ?? {}).sort().join("|");
      const structuredInitial =
        exactMutationProvenance &&
        [
          "error|errorMessage|mutationProvenance",
          "definiteRejection|error|errorMessage|mutationProvenance",
        ].includes(outcomeKeys) &&
        expectedOutcome.error === "BingXLiveApiError" &&
        (expectedOutcome.definiteRejection === undefined ||
          expectedOutcome.definiteRejection === true);
      const structuredNormalized =
        exactMutationProvenance &&
        [
          "mutationProvenance|reason|submissionError|submissionErrorMessage",
          "definiteRejection|mutationProvenance|reason|submissionError|submissionErrorMessage",
        ].includes(outcomeKeys) &&
        expectedOutcome.reason === "exchange_state_not_verified" &&
        expectedOutcome.submissionError === "BingXLiveApiError" &&
        (expectedOutcome.definiteRejection === undefined ||
          expectedOutcome.definiteRejection === true);
      const legacyReadRefusal = !exactMutationProvenance &&
        outcomeKeys ===
          "definiteRejection|reason|submissionError|submissionErrorMessage" &&
        expectedOutcome.reason === "exchange_state_not_verified" &&
        expectedOutcome.submissionError === "BingXLiveApiError" &&
        expectedOutcome.submissionErrorMessage === expectedLegacyMessage &&
        expectedOutcome.definiteRejection === true;
      const split = expectedPositionSnapshot?.split;
      const requestSplit = expectedRequest?.priorPosition?.split;
      const prior = expectedRequest?.priorPosition;
      const priorSplit = prior?.split;
      const originalId = split?.originalStopOrderId;
      const coreStop = split?.coreStop;
      const runnerStop = split?.runnerStop;
      const expectedStopIds = [
        originalId,
        coreStop?.orderId,
        runnerStop?.orderId,
      ];
      const verifiedStopIds = verifiedPositionAndStops?.stopOrderIds;
      const stopExecutionProofs = verifiedPositionAndStops?.stopExecutionProofs;
      const sortedIds = (ids) => Array.isArray(ids) &&
        ids.every((id) => typeof id === "string" && id.trim() !== "") &&
        new Set(ids).size === ids.length
        ? [...ids].sort() : null;
      const expectedIdsSorted = sortedIds(expectedStopIds);
      const baselineIdsSorted = sortedIds(split?.baselineOpenOrderIds);
      const requestIdsSorted = sortedIds(expectedRequest?.baselineOpenOrderIds);
      const verifiedIdsSorted = sortedIds(verifiedStopIds);
      const executionIdsSorted = Array.isArray(stopExecutionProofs)
        ? sortedIds(stopExecutionProofs.map((proof) => proof?.orderId))
        : null;
      const executionProofsValid =
        Array.isArray(stopExecutionProofs) &&
        stopExecutionProofs.length === 3 &&
        executionIdsSorted?.length === 3 &&
        JSON.stringify(executionIdsSorted) ===
          JSON.stringify(expectedIdsSorted) &&
        stopExecutionProofs.every((proof) =>
          explicitZeroExecutionProofMatches(proof, proof?.orderId));
      const originalParentsMatch = (stop) => {
        const parents = [
          stop?.mainOrderId, stop?.mainOrderID,
          stop?.parentOrderId, stop?.parentOrderID,
        ].filter((value) =>
          value !== undefined && value !== null && value !== "");
        return parents.every((parent) =>
          exactPositiveIdentifier(parent) === split?.entryOrderId);
      };
      const snapshotIdentity =
        expectedPositionSnapshot?.sourceSignalId === signalId &&
        ["open", "closing"].includes(expectedPositionSnapshot?.status) &&
        expectedPositionSnapshot.environment === "vst" &&
        typeof expectedPositionSnapshot.accountId === "string" &&
        typeof expectedPositionSnapshot.symbol === "string" &&
        expectedPositionSnapshot.manualResolution == null &&
        expectedPositionSnapshot.marginTopUp?.manualResolution == null &&
        (expectedPositionSnapshot.exchangePositionId ??
          split?.positionId) === split?.positionId;
      const requestIdentity =
        expectedRequest?.operation === "cancel_original_stop" &&
        expectedRequest?.sourceSignalId === signalId &&
        expectedRequest?.environment === "vst" &&
        expectedRequest?.accountId === expectedPositionSnapshot?.accountId &&
        expectedRequest?.symbol === expectedPositionSnapshot?.symbol &&
        expectedRequest?.positionId === split?.positionId &&
        expectedRequest?.originalStopOrderId === originalId &&
        expectedRequest?.entryOrderId === split?.entryOrderId &&
        expectedRequest?.priorPosition?.sourceSignalId === signalId &&
        expectedRequest?.priorPosition?.split?.stage === "cancel_original_pending";
      const stableSplitMatches = priorSplit?.stage === "cancel_original_pending" &&
        priorSplit.positionId === split?.positionId &&
        priorSplit.originalStopOrderId === split?.originalStopOrderId &&
        priorSplit.entryOrderId === split?.entryOrderId &&
        exactDecimalEqual(priorSplit.totalQuantity, split?.totalQuantity) &&
        exactDecimalEqual(priorSplit.coreQuantity, split?.coreQuantity) &&
        exactDecimalEqual(priorSplit.runnerQuantity, split?.runnerQuantity) &&
        exactDecimalEqual(priorSplit.signalStopPrice, split?.signalStopPrice) &&
        priorSplit.coreStop?.orderId === coreStop?.orderId &&
        priorSplit.runnerStop?.orderId === runnerStop?.orderId &&
        exactDecimalEqual(priorSplit.coreStop?.quantity, coreStop?.quantity) &&
        exactDecimalEqual(priorSplit.runnerStop?.quantity, runnerStop?.quantity) &&
        exactDecimalEqual(priorSplit.coreStop?.stopPrice, coreStop?.stopPrice) &&
        exactDecimalEqual(priorSplit.runnerStop?.stopPrice, runnerStop?.stopPrice);
      const stopProofValid =
        expectedIdsSorted?.length === 3 &&
        baselineIdsSorted?.length === 3 &&
        requestIdsSorted?.length === 3 &&
        verifiedIdsSorted?.length === 3 &&
        JSON.stringify(expectedIdsSorted) === JSON.stringify(baselineIdsSorted) &&
        JSON.stringify(expectedIdsSorted) === JSON.stringify(requestIdsSorted) &&
        JSON.stringify(expectedIdsSorted) === JSON.stringify(verifiedIdsSorted) &&
        executionProofsValid &&
        verifiedPositionAndStops?.positionId === split?.positionId &&
        exactDecimalEqual(expectedRequest?.totalQuantity, split?.totalQuantity) &&
        exactDecimalEqual(expectedRequest?.coreQuantity, split?.coreQuantity) &&
        exactDecimalEqual(expectedRequest?.runnerQuantity, split?.runnerQuantity) &&
        exactDecimalEqual(expectedPositionSnapshot.remainingQty ??
          expectedPositionSnapshot.quantity, split?.totalQuantity) &&
        exactDecimalEqual(coreStop?.quantity, split?.coreQuantity) &&
        exactDecimalEqual(coreStop?.stopPrice, split?.signalStopPrice) &&
        exactDecimalEqual(runnerStop?.quantity, split?.runnerQuantity) &&
        originalParentsMatch(coreStop) && originalParentsMatch(runnerStop);
      const markerOnlyPositionChange = (() => {
        try {
          const copy = JSON.parse(recoveryPositionJson);
          if (copy?.split) delete copy.split.cancelOriginalRecoveryPhase;
          return serialize(copy, "original-stop position comparison") === positionJson;
        } catch {
          return false;
        }
      })();
      const recoveryMarkerValid =
        retryPhase === "impulse-cancel_original_stop-retry-1" &&
        recoveryPosition?.split?.cancelOriginalRecoveryPhase === retryPhase &&
        markerOnlyPositionChange;
      const deterministicId = `vst-${createHash("sha256")
        .update(`${signalId}:${intentPhase}`).digest("hex").slice(0, 30)}`;
      if (intentPhase !== "impulse-cancel_original_stop" ||
          orderId !== deterministicId ||
          !(structuredInitial || structuredNormalized || legacyReadRefusal) ||
          !snapshotIdentity || !requestIdentity || !stableSplitMatches ||
          !stopProofValid || !recoveryMarkerValid) {
        return { kind: "ineligible", reason: "proof_shape_mismatch" };
      }
      const evidenceHash = createHash("sha256")
        .update(`${requestJson}\n${outcomeJson}`).digest("hex");
      const recoveryOutcome = {
        reason: "cancel_original_stop_pre_mutation_read_refused",
        operation: "cancel_original_stop",
        canceled: false,
        mutationRequestSent: false,
        mutationProvenance: {
          operation: "cancel_original_stop",
          mutationMethod: "DELETE",
          mutationEndpoint: "/openApi/swap/v2/trade/order",
          mutationRequestSent: false,
          phase: "pre_mutation_read",
        },
        recoveryPhase: retryPhase,
        originalIntentEvidenceHash: evidenceHash,
      };
      const recoveryOutcomeJson = serialize(
        recoveryOutcome, "original-stop pre-mutation recovery outcome",
      );
      const eventDetailJson = serialize({
        operation: "cancel_original_stop",
        outcome: "pre_mutation_read_refused",
        canceled: false,
        mutationRequestSent: false,
        recoveryPhase: retryPhase,
        stopOrderIds: expectedIdsSorted,
      }, "original-stop pre-mutation recovery event");

      return transaction(pool, async (client) => {
        await lockSignalIntents(client, signalId);
        const lockedAt = Number(clock());
        if (!Number.isSafeInteger(lockedAt) || lockedAt < evidenceAt ||
            lockedAt - evidenceAt > maxEvidenceAge) {
          return { kind: "ineligible", reason: "evidence_stale" };
        }
        const signalResult = await client.query(
          `SELECT source_signal_id, status, reason
           FROM vst_signals WHERE source_signal_id = $1 FOR UPDATE`,
          [signalId],
        );
        const signalRow = signalResult.rows[0];
        const positionResult = await client.query(
          `SELECT source_signal_id, symbol, status, snapshot,
                  updated_at::text AS updated_at_text
           FROM vst_positions
           WHERE source_signal_id = $1 AND status IN ('open', 'closing')
           FOR UPDATE`,
          [signalId],
        );
        const positionRow = positionResult.rows[0];
        const targetResult = await client.query(
          `SELECT source_signal_id, phase, client_order_id, request, state,
                  exchange_order_id, outcome
           FROM vst_order_intents
           WHERE source_signal_id = $1 AND client_order_id = $2 FOR UPDATE`,
          [signalId, orderId],
        );
        const target = targetResult.rows[0];
        const priorRecovered =
          signalRow?.status === "opening" &&
          positionRow &&
          target &&
          target.phase === intentPhase &&
          target.state === "failed" &&
          target.exchange_order_id === null &&
          serialize(target.request, "stored original-stop request") === requestJson &&
          target.outcome?.reason === recoveryOutcome.reason &&
          target.outcome?.originalIntentEvidenceHash === evidenceHash &&
          serialize(target.outcome, "stored pre-mutation recovery outcome") ===
            recoveryOutcomeJson &&
          positionRow.status === expectedPositionSnapshot.status &&
          serialize(positionRow.snapshot, "stored recovery position") ===
            recoveryPositionJson;
        if (priorRecovered) {
          const existingRetry = await client.query(
            `SELECT client_order_id FROM vst_order_intents
             WHERE source_signal_id = $1 AND phase = $2 FOR UPDATE`,
            [signalId, retryPhase],
          );
          if (existingRetry.rows.length === 0) return { kind: "replayed" };
          return { kind: "ineligible", reason: "position_changed" };
        }
        const currentPositionMatches =
          positionRow &&
          positionRow.updated_at_text === expectedPositionUpdatedAt &&
          positionRow.status === expectedPositionSnapshot.status &&
          serialize(positionRow.snapshot, "stored original-stop position") === positionJson;
        const targetMatches =
          target && target.phase === intentPhase &&
          target.state === "unknown" && target.exchange_order_id === null &&
          serialize(target.request, "stored original-stop request") === requestJson &&
          serialize(target.outcome, "stored original-stop outcome") === outcomeJson;
        const competing = await client.query(
          `SELECT client_order_id
           FROM vst_order_intents
           WHERE source_signal_id = $1 AND client_order_id <> $2
             AND state IN ('prepared', 'submitted', 'unknown')
           ORDER BY client_order_id FOR UPDATE`,
          [signalId, orderId],
        );
        if (!signalRow || !currentPositionMatches || !targetMatches ||
            signalRow.status !== "unknown" || competing.rows.length > 0) {
          return { kind: "ineligible", reason: "position_changed" };
        }
        const existingRetry = await client.query(
          `SELECT client_order_id FROM vst_order_intents
           WHERE source_signal_id = $1 AND phase = $2 FOR UPDATE`,
          [signalId, retryPhase],
        );
        if (existingRetry.rows.length > 0 ||
            !target || target.state !== "unknown" ||
            target.exchange_order_id !== null) {
          return { kind: "ineligible", reason: "position_changed" };
        }
        const settlementAt = Number(clock());
        if (!Number.isSafeInteger(settlementAt) || settlementAt < evidenceAt ||
            settlementAt - evidenceAt > maxEvidenceAge) {
          return { kind: "ineligible", reason: "evidence_stale" };
        }
        const updatedIntent = await client.query(
          `UPDATE vst_order_intents
           SET state = 'failed', outcome = $5::jsonb, updated_at = now()
           WHERE source_signal_id = $1 AND client_order_id = $2
             AND phase = $3 AND state = 'unknown'
             AND exchange_order_id IS NULL
             AND request = $4::jsonb AND outcome = $6::jsonb
           RETURNING client_order_id`,
          [signalId, orderId, intentPhase, requestJson,
            recoveryOutcomeJson, outcomeJson],
        );
        if (updatedIntent.rowCount !== 1) {
          throw new Error(
            "VST original-stop pre-mutation recovery intent compare-and-set failed",
          );
        }
        const updatedPosition = await client.query(
          `UPDATE vst_positions SET snapshot = $3::jsonb, updated_at = now()
           WHERE source_signal_id = $1 AND status = $4
             AND updated_at = $5::timestamptz AND snapshot = $2::jsonb
           RETURNING source_signal_id`,
          [signalId, positionJson, recoveryPositionJson,
            positionRow.status, expectedPositionUpdatedAt],
        );
        if (updatedPosition.rowCount !== 1) {
          throw new Error(
            "VST original-stop pre-mutation recovery position compare-and-set failed",
          );
        }
        const updatedSignal = await client.query(
          `UPDATE vst_signals SET status = 'opening', reason = NULL, updated_at = now()
           WHERE source_signal_id = $1 AND status = 'unknown'
           RETURNING source_signal_id`,
          [signalId],
        );
        if (updatedSignal.rowCount !== 1) {
          throw new Error(
            "VST original-stop pre-mutation recovery signal compare-and-set failed",
          );
        }
        await client.query(
          `INSERT INTO vst_events (source_signal_id, client_order_id, kind, detail)
           VALUES ($1, $2, 'vst_original_stop_cancel_pre_mutation_read_refused', $3::jsonb)`,
          [signalId, orderId, eventDetailJson],
        );
        return { kind: "recovered" };
      });
    },

    // Atomically retires the exact no-DELETE original-stop refusal and books
    // an independently verified runner fill. The original refusal outcome is
    // preserved verbatim; the separate runner-cleanup intent is committed in
    // the same transaction as the position fill and old-intent CAS.
    async recoverOriginalStopCancelRunnerFill({
      sourceSignalId, oldCancelClientOrderId, oldCancelPhase,
      expectedRequest, expectedOutcome, expectedPositionSnapshot,
      expectedPositionUpdatedAt, requestStartedAtMs, maxEvidenceAgeMs,
      clock, runnerFillProof, runnerFillIntent, position,
      recoveryMode = "pre_delete_refusal",
      expectedOldIntentState = "unknown",
    }) {
      const signalId = requireString(sourceSignalId, "sourceSignalId");
      const oldOrderId = requireString(
        oldCancelClientOrderId, "oldCancelClientOrderId",
      );
      const oldPhase = requireString(oldCancelPhase, "oldCancelPhase");
      const requestSplit = expectedRequest?.priorPosition?.split;
      const requestJson = serialize(
        expectedRequest, "expected original-stop refusal request",
      );
      const outcomeJson = serialize(
        expectedOutcome, "expected original-stop refusal outcome",
      );
      const snapshotJson = serialize(
        expectedPositionSnapshot, "expected original-stop refusal position",
      );
      const updatedAt = requireString(
        expectedPositionUpdatedAt, "expected original-stop refusal updatedAt",
      );
      const positionJson = serialize(position, "runner-fill cleanup position");
      const evidenceAt = Number(requestStartedAtMs);
      const maxEvidenceAge = Number(maxEvidenceAgeMs);
      if (!Number.isSafeInteger(evidenceAt) || evidenceAt <= 0 ||
          !Number.isSafeInteger(maxEvidenceAge) || maxEvidenceAge <= 0 ||
          maxEvidenceAge > READ_ONLY_RECOVERY_MAX_EVIDENCE_AGE_MS ||
          typeof clock !== "function") {
        return { kind: "ineligible", reason: "invalid_evidence_time" };
      }

      const sentCancelConfirmed = recoveryMode === "sent_cancel_confirmed";
      if (!["pre_delete_refusal", "sent_cancel_confirmed"].includes(recoveryMode) ||
          !["unknown", "submitted"].includes(expectedOldIntentState)) {
        return { kind: "ineligible", reason: "invalid_recovery_mode" };
      }
      const provenance = expectedOutcome?.mutationProvenance;
      const exactProvenance = provenance &&
        typeof provenance === "object" && !Array.isArray(provenance) &&
        Object.keys(provenance).sort().join("|") ===
          "mutationEndpoint|mutationMethod|mutationRequestSent|operation|phase" &&
        provenance.operation === "cancel_original_stop" &&
        provenance.mutationMethod === "DELETE" &&
        provenance.mutationEndpoint === "/openApi/swap/v2/trade/order" &&
        provenance.mutationRequestSent === sentCancelConfirmed &&
        provenance.phase === (sentCancelConfirmed
          ? "mutation_transport_started" : "pre_mutation_read");
      const outcomeKeys = uncertaintyEvidenceKeys(expectedOutcome ?? {}).sort().join("|");
      const exactStructuredRefusal =
        exactProvenance &&
        [
          "error|errorMessage|mutationProvenance",
          "definiteRejection|error|errorMessage|mutationProvenance",
          "mutationProvenance|reason|submissionError|submissionErrorMessage",
          "definiteRejection|mutationProvenance|reason|submissionError|submissionErrorMessage",
        ].includes(outcomeKeys) &&
        (expectedOutcome.error === "BingXLiveApiError" ||
          expectedOutcome.reason === "exchange_state_not_verified" &&
            expectedOutcome.submissionError === "BingXLiveApiError") &&
        (expectedOutcome.definiteRejection === undefined ||
          expectedOutcome.definiteRejection === true);
      const exactLegacyRefusal =
        !sentCancelConfirmed && !exactProvenance &&
        outcomeKeys ===
          "definiteRejection|reason|submissionError|submissionErrorMessage" &&
        expectedOutcome.reason === "exchange_state_not_verified" &&
        expectedOutcome.submissionError === "BingXLiveApiError" &&
        expectedOutcome.submissionErrorMessage ===
          "BingX request failed (GET /openApi/swap/v2/trade/leverage, HTTP 200, code 109400, msg: timestamp is invalid)" &&
        expectedOutcome.definiteRejection === true;
      const exactSentOutcome = sentCancelConfirmed &&
        (expectedOldIntentState === "submitted"
          ? outcomeKeys === "phase" &&
            expectedOutcome.phase === "submission_started"
          : exactProvenance &&
            expectedOutcome.definiteRejection !== true &&
            (outcomeKeys === "error|errorMessage|mutationProvenance" &&
              expectedOutcome.error === "BingXLiveApiError" ||
             outcomeKeys ===
               "mutationProvenance|reason|submissionError|submissionErrorMessage" &&
              expectedOutcome.reason === "exchange_state_not_verified" &&
              expectedOutcome.submissionError === "BingXLiveApiError"));
      const split = expectedPositionSnapshot?.split;
      const originalId = split?.originalStopOrderId;
      const coreId = split?.coreStop?.orderId;
      const runnerId = split?.runnerStop?.orderId;
      const runnerQuantity = split?.runnerQuantity;
      const coreQuantity = split?.coreQuantity;
      const totalParts = exactDecimalParts(split?.totalQuantity);
      const coreParts = exactDecimalParts(coreQuantity);
      const runnerParts = exactDecimalParts(runnerQuantity);
      const ratioScale = totalParts && coreParts && runnerParts
        ? Math.max(totalParts.scale, coreParts.scale, runnerParts.scale) : null;
      const totalUnits = ratioScale === null ? null
        : totalParts.units * (10n ** BigInt(ratioScale - totalParts.scale));
      const coreUnits = ratioScale === null ? null
        : coreParts.units * (10n ** BigInt(ratioScale - coreParts.scale));
      const runnerUnits = ratioScale === null ? null
        : runnerParts.units * (10n ** BigInt(ratioScale - runnerParts.scale));
      const exactSplitRatio = ratioScale !== null &&
        coreUnits * 5n === totalUnits * 4n &&
        runnerUnits * 5n === totalUnits &&
        coreUnits + runnerUnits === totalUnits;
      const runnerStopPrice = split?.actualEntryBreakEvenPrice ??
        split?.breakEvenPrice ?? split?.runnerStop?.stopPrice;
      const fill = runnerFillProof?.fill;
      const originalStop = runnerFillProof?.originalStop;
      const coreStop = runnerFillProof?.coreStop;
      const runnerStop = runnerFillProof?.runnerStop;
      const originalQuantity = consistentDecimalAliases(
        originalStop, "origQty", "quantity",
      );
      const originalQuantityIsAllowed = sentCancelConfirmed
        ? (runnerFillProof.originalStopQuantityBasis === undefined
            ? exactDecimalEqual(originalQuantity, split?.totalQuantity) ||
              exactDecimalEqual(originalQuantity, coreQuantity)
            : runnerFillProof.originalStopQuantityBasis === "entry_total"
              ? exactDecimalEqual(originalQuantity, split?.totalQuantity)
              : runnerFillProof.originalStopQuantityBasis ===
                  "post_runner_residual" &&
                exactDecimalEqual(originalQuantity, coreQuantity))
        : exactDecimalEqual(originalQuantity, coreQuantity);
      const proofPosition = runnerFillProof?.position;
      const canonicalSymbol = expectedPositionSnapshot?.symbol;
      const equivalentExchangeSymbol = typeof canonicalSymbol === "string" &&
        /^([A-Z0-9]{1,20})USDT$/.exec(canonicalSymbol);
      const symbolMatches = (value) =>
        value === canonicalSymbol ||
        Boolean(equivalentExchangeSymbol &&
          value === `${equivalentExchangeSymbol[1]}-USDT`);
      const executionProofValid = (stop, expectedId) =>
        explicitZeroExecutionProofMatches({
          orderId: stop?.orderId ?? stop?.orderID,
          ...Object.fromEntries(EXECUTION_QUANTITY_ALIASES
            .filter((key) => Object.hasOwn(stop ?? {}, key))
            .map((key) => [key, stop[key]])),
        }, expectedId);
      const stopValid = (stop, id, quantity, price, status) =>
        validObject(stop) &&
        stop.verified === true &&
        consistentIdentifierAliases(stop, "orderId", "orderID") === id &&
        consistentIdentifierAliases(stop, "positionId", "positionID") ===
          split?.positionId &&
        symbolMatches(stop.symbol) &&
        String(stop.status ?? "").toUpperCase() === status &&
        exactDecimalEqual(consistentDecimalAliases(stop, "origQty", "quantity"),
          quantity) &&
        exactDecimalEqual(stop.stopPrice, price);
      const fillAt = Date.parse(fill?.at ?? "");
      const runnerChildId = consistentIdentifierAliases(
        runnerStop, "childOrderId", "childOrderID",
      );
      const positionProofValid =
        proofPosition?.verified === true &&
        proofPosition.symbol === expectedPositionSnapshot?.symbol &&
        consistentIdentifierAliases(proofPosition, "positionId", "positionID") ===
          split?.positionId &&
        exactDecimalEqual(proofPosition.quantity, coreQuantity) &&
        proofPosition.side === "Buy" &&
        Number(proofPosition.leverage) === Number(expectedPositionSnapshot?.leverage ?? 10) &&
        proofPosition.marginMode === (expectedPositionSnapshot?.marginMode ?? "ISOLATED");
      const stopParentsValid = [originalStop, coreStop, runnerStop].every((stop) => {
        const parents = [
          stop?.mainOrderId, stop?.mainOrderID,
          stop?.parentOrderId, stop?.parentOrderID,
        ].filter((value) =>
          value !== undefined && value !== null && value !== "");
        return parents.every((parent) =>
          exactPositiveIdentifier(parent) === split?.entryOrderId);
      });
      const runnerFillValid =
        runnerFillProof?.verified === true &&
        runnerFillProof.outcome === (sentCancelConfirmed
          ? "confirmed_sent_original_stop_cancel_runner_fill"
          : "confirmed_original_stop_cancel_runner_fill") &&
        runnerFillProof.runnerFillRecovery === true &&
        (!sentCancelConfirmed ||
          runnerFillProof.originalCancellationConfirmed === true) &&
        Number.isSafeInteger(runnerFillProof.requestStartedAtMs) &&
        runnerFillProof.requestStartedAtMs === evidenceAt &&
        positionProofValid &&
        originalQuantityIsAllowed &&
        stopValid(originalStop, originalId, originalQuantity,
          split?.signalStopPrice, sentCancelConfirmed ? "CANCELED" : "NEW") &&
        executionProofValid(originalStop, originalId) &&
        stopValid(coreStop, coreId, coreQuantity, split?.signalStopPrice, "NEW") &&
        executionProofValid(coreStop, coreId) &&
        stopParentsValid &&
        stopValid(runnerStop, runnerId, runnerQuantity, runnerStopPrice, "FILLED") &&
        exactDecimalEqual(runnerStop.executedQty, runnerQuantity) &&
        EXECUTION_QUANTITY_ALIASES.filter((key) =>
          Object.hasOwn(runnerStop, key)).every((key) =>
          exactDecimalEqual(runnerStop[key], runnerQuantity)) &&
        runnerChildId !== null &&
        typeof fill?.orderId === "string" && fill.orderId === runnerChildId &&
        fill.triggerOrderId === runnerId &&
        exactDecimalEqual(fill.quantity, runnerQuantity) &&
        compareExactDecimals(fill.price, 0) === 1 &&
        Number.isSafeInteger(fillAt) && fillAt > 0 &&
        validObject(fill.fee) &&
        typeof fill.fee.asset === "string" && fill.fee.asset.trim() !== "" &&
        (typeof fill.fee.amount === "string" ||
          typeof fill.fee.amount === "number") &&
        Number.isFinite(Number(fill.fee.amount)) &&
        (!sentCancelConfirmed ||
          runnerFillProof.openStops === undefined ||
            Array.isArray(runnerFillProof.openStops) &&
              runnerFillProof.openStops.length === 1 &&
              stopValid(runnerFillProof.openStops[0], coreId, coreQuantity,
                split?.signalStopPrice, "NEW") &&
              executionProofValid(runnerFillProof.openStops[0], coreId));
      const cleanup = position?.split?.runnerCleanup;
      const fillIntent = requirePlainObject(runnerFillIntent, "runner-fill intent");
      const fillIntentRequestJson = serialize(
        fillIntent.request, "runner-fill intent request",
      );
      const fillIntentOutcomeJson = serialize(
        fillIntent.outcome, "runner-fill intent outcome",
      );
      const fillDigest = createHash("sha256")
        .update(`${split?.positionId}:${runnerId}:${fill?.orderId}`)
        .digest("hex").slice(0, 24);
      const deterministicFillPhase = `impulse-runner-fill-${fillDigest}`;
      const deterministicFillId = `vst-${createHash("sha256")
        .update(`${signalId}:${deterministicFillPhase}`)
        .digest("hex").slice(0, 30)}`;
      const fillOutcomeExact =
        fillIntent.phase === deterministicFillPhase &&
        fillIntent.clientOrderId === deterministicFillId &&
        fillIntent.request?.operation === "observe_triggered_stop" &&
        fillIntent.request?.environment === "vst" &&
        fillIntent.request?.accountId === expectedPositionSnapshot?.accountId &&
        fillIntent.request?.symbol === expectedPositionSnapshot?.symbol &&
        fillIntent.request?.positionId === split?.positionId &&
        fillIntent.request?.leg === "runner" &&
        fillIntent.request?.stopOrderId === runnerId &&
        exactDecimalEqual(fillIntent.request?.stopQuantity, runnerQuantity) &&
        exactDecimalEqual(fillIntent.request?.stopPrice, runnerStopPrice) &&
        fillIntent.request?.childOrderId === fill?.orderId &&
        fillIntent.request?.originalStopOrderId === originalId &&
        fillIntent.request?.coreStopOrderId === coreId &&
        fillIntent.exchangeOrderId === fill?.orderId &&
        fillIntent.outcome?.verified === true &&
        fillIntent.outcome?.status === "filled" &&
        fillIntent.outcome?.operation === "observe_triggered_stop" &&
        fillIntent.outcome?.leg === "runner" &&
        fillIntent.outcome?.parentStopId === runnerId &&
        fillIntent.outcome?.childOrderId === fill?.orderId &&
        exactDecimalEqual(fillIntent.outcome?.fill?.price, fill?.price) &&
        exactDecimalEqual(fillIntent.outcome?.fill?.quantity, runnerQuantity) &&
        fillIntent.outcome?.fill?.at === fill?.at &&
        fillIntent.outcome?.fill?.orderId === fill?.orderId &&
        fillIntent.outcome?.fill?.triggerOrderId === runnerId &&
        fillIntent.outcome?.fill?.fee?.asset === fill?.fee?.asset &&
        exactDecimalEqual(fillIntent.outcome?.fill?.fee?.amount, fill?.fee?.amount) &&
        fillIntent.outcome?.cleanupStage ===
          (sentCancelConfirmed ? "complete" : "cancel_original_pending");
      const recoveryPositionValid =
        position?.sourceSignalId === signalId &&
        position?.status === (sentCancelConfirmed ? "open" : "closing") &&
        position?.split?.stage ===
          (sentCancelConfirmed ? "complete" : "runner_cleanup_pending") &&
        position?.persistedPosition?.verified === true &&
        position.persistedPosition.environment === "vst" &&
        position.persistedPosition.accountId === expectedPositionSnapshot?.accountId &&
        position.persistedPosition.symbol === expectedPositionSnapshot?.symbol &&
        consistentIdentifierAliases(
          position.persistedPosition, "positionId", "exchangePositionId",
        ) === split?.positionId &&
        exactDecimalEqual(position.persistedPosition.quantity, coreQuantity) &&
        position.persistedPosition.protectiveStops?.core?.verified === true &&
        position.persistedPosition.protectiveStops.core.orderId === coreId &&
        (sentCancelConfirmed
          ? cleanup === null &&
            position.split.runnerStop === null &&
            position.split.activeLegs?.length === 1 &&
            position.split.activeLegs[0] === "core" &&
            position.split.baselineOpenOrderIds?.length === 1 &&
            position.split.baselineOpenOrderIds[0] === coreId
          : position.persistedPosition.originalStop?.verified === true &&
            position.persistedPosition.originalStop.orderId === originalId &&
            cleanup?.stage === "cancel_original_pending" &&
            cleanup?.parentStopId === runnerId &&
            cleanup?.childOrderId === fill?.orderId &&
            cleanup?.originalStopOrderId === originalId &&
            cleanup?.coreStopOrderId === coreId &&
            exactDecimalEqual(cleanup?.runnerQuantity, runnerQuantity) &&
            exactDecimalEqual(cleanup?.remainingQuantity, coreQuantity) &&
            cleanup?.fill?.orderId === fill?.orderId &&
            cleanup?.fill?.triggerOrderId === runnerId &&
            cleanup?.fill?.at === fill?.at &&
            exactDecimalEqual(cleanup?.fill?.price, fill?.price) &&
            exactDecimalEqual(cleanup?.fill?.quantity, runnerQuantity) &&
            cleanup?.fill?.feeEvidenceAvailable === true &&
            cleanup?.fill?.fee?.asset === fill?.fee?.asset &&
            exactDecimalEqual(cleanup?.fill?.fee?.amount, fill?.fee?.amount)) &&
        exactDecimalEqual(position.remainingQty, coreQuantity) &&
        exactDecimalEqual(position.lastCloseFill?.quantity, runnerQuantity) &&
        exactDecimalEqual(position.lastCloseFill?.price, fill?.price) &&
        position.lastCloseFill?.orderId === fill?.orderId &&
        position.lastCloseFill?.triggerOrderId === runnerId &&
        position.lastCloseFill?.at === fill?.at &&
        position.lastCloseFill?.feeEvidenceAvailable === true &&
        position.lastCloseFill?.fee?.asset === fill?.fee?.asset &&
        exactDecimalEqual(position.lastCloseFill?.fee?.amount, fill?.fee?.amount) &&
        position.policy?.lastCloseFill?.orderId === fill?.orderId &&
        position.policy.lastCloseFill.triggerOrderId === runnerId &&
        exactDecimalEqual(position.policy.lastCloseFill.quantity, runnerQuantity) &&
        exactDecimalEqual(position.policy.lastCloseFill.price, fill?.price) &&
        position.policy.lastCloseFill.fee?.asset === fill?.fee?.asset &&
        exactDecimalEqual(position.policy.lastCloseFill.fee?.amount, fill?.fee?.amount);
      const eligibleOldOutcome = sentCancelConfirmed
        ? exactSentOutcome
        : exactStructuredRefusal || exactLegacyRefusal;
      if (oldPhase !== "impulse-cancel_original_stop" ||
          oldOrderId !== `vst-${createHash("sha256")
            .update(`${signalId}:${oldPhase}`).digest("hex").slice(0, 30)}` ||
          !eligibleOldOutcome ||
          expectedRequest?.operation !== "cancel_original_stop" ||
          expectedRequest?.environment !== "vst" ||
          expectedRequest?.sourceSignalId !== signalId ||
          expectedRequest?.accountId !== expectedPositionSnapshot?.accountId ||
          expectedRequest?.symbol !== expectedPositionSnapshot?.symbol ||
          expectedRequest?.positionId !== split?.positionId ||
          expectedRequest?.originalStopOrderId !== originalId ||
          expectedRequest?.entryOrderId !== split?.entryOrderId ||
          !exactDecimalEqual(expectedRequest?.totalQuantity, split?.totalQuantity) ||
          !exactDecimalEqual(expectedRequest?.coreQuantity, split?.coreQuantity) ||
          !exactDecimalEqual(expectedRequest?.runnerQuantity, split?.runnerQuantity) ||
          !exactSplitRatio ||
          requestSplit?.stage !== "cancel_original_pending" ||
          serialize(expectedRequest.priorPosition,
            "stored cancellation prior position") !== snapshotJson ||
          requestSplit.positionId !== split?.positionId ||
          requestSplit.originalStopOrderId !== originalId ||
          requestSplit.coreStop?.orderId !== coreId ||
          requestSplit.runnerStop?.orderId !== runnerId ||
          !exactDecimalEqual(requestSplit.totalQuantity, split?.totalQuantity) ||
          !exactDecimalEqual(requestSplit.coreQuantity, split?.coreQuantity) ||
          !exactDecimalEqual(requestSplit.runnerQuantity, split?.runnerQuantity) ||
          !exactDecimalEqual(expectedRequest?.signalStopPrice, split?.signalStopPrice) ||
          !exactDecimalEqual(expectedRequest?.breakEvenPrice,
            split?.breakEvenPrice ?? runnerStopPrice) ||
          expectedPositionSnapshot?.manualResolution != null ||
          expectedPositionSnapshot?.marginTopUp?.manualResolution != null ||
          expectedPositionSnapshot?.sourceSignalId !== signalId ||
          !["open", "closing"].includes(expectedPositionSnapshot?.status) ||
          expectedPositionSnapshot?.environment !== "vst" ||
          !runnerFillValid || !fillOutcomeExact || !recoveryPositionValid) {
        return { kind: "ineligible", reason: "proof_shape_mismatch" };
      }
      const eventDetailJson = serialize({
        operation: "observe_triggered_stop",
        leg: "runner",
        parentStopId: runnerId,
        childOrderId: fill.orderId,
        originalStopOrderId: originalId,
        coreStopOrderId: coreId,
        remainingQuantity: String(coreQuantity),
        ...(sentCancelConfirmed
          ? { originalCancellationConfirmed: true }
          : {}),
        fill,
      }, "original-stop refusal runner-fill event");
      const retiredOldOutcome = sentCancelConfirmed
        ? {
            ...expectedOutcome,
            status: "canceled",
            verified: true,
            operation: "cancel_original_stop",
            originalCancellationConfirmed: true,
            canceledOriginalStopOrderId: originalId,
            runnerFillOrderId: fill.orderId,
          }
        : expectedOutcome;
      const retiredOldOutcomeJson = serialize(
        retiredOldOutcome, "reconciled original-stop cancellation outcome",
      );
      const oldTerminalState = sentCancelConfirmed ? "reconciled" : "failed";
      const oldExchangeOrderId = sentCancelConfirmed ? originalId : null;

      return transaction(pool, async (client) => {
        await lockSignalIntents(client, signalId);
        const lockedAt = Number(clock());
        if (!Number.isSafeInteger(lockedAt) || lockedAt < evidenceAt ||
            lockedAt - evidenceAt > maxEvidenceAge) {
          return { kind: "ineligible", reason: "evidence_stale" };
        }
        const signalResult = await client.query(
          `SELECT source_signal_id, status
           FROM vst_signals WHERE source_signal_id = $1 FOR UPDATE`,
          [signalId],
        );
        const positionResult = await client.query(
          `SELECT source_signal_id, symbol, status, snapshot,
                  updated_at::text AS updated_at_text
           FROM vst_positions
           WHERE source_signal_id = $1 AND status IN ('open', 'closing')
           FOR UPDATE`,
          [signalId],
        );
        const oldIntentResult = await client.query(
          `SELECT source_signal_id, phase, client_order_id, request, state,
                  exchange_order_id, outcome
           FROM vst_order_intents
           WHERE source_signal_id = $1 AND client_order_id = $2 FOR UPDATE`,
          [signalId, oldOrderId],
        );
        const fillIntentResult = await client.query(
          `SELECT source_signal_id, phase, client_order_id, request, state,
                  exchange_order_id, outcome
           FROM vst_order_intents
           WHERE source_signal_id = $1 AND phase = $2 FOR UPDATE`,
          [signalId, fillIntent.phase],
        );
        const signalRow = signalResult.rows[0];
        const positionRow = positionResult.rows[0];
        const oldIntent = oldIntentResult.rows[0];
        const existingFill = fillIntentResult.rows[0];
        const replayed =
          signalRow?.status === "open" &&
          positionRow?.status === position.status &&
          serialize(positionRow.snapshot, "stored runner-fill position") === positionJson &&
           oldIntent?.state === oldTerminalState &&
           oldIntent.exchange_order_id === oldExchangeOrderId &&
          serialize(oldIntent.request, "stored original-stop request") === requestJson &&
           serialize(oldIntent.outcome, "stored original-stop outcome") ===
             retiredOldOutcomeJson &&
          existingFill?.client_order_id === fillIntent.clientOrderId &&
          existingFill.state === "reconciled" &&
          existingFill.exchange_order_id === fillIntent.exchangeOrderId &&
          serialize(existingFill.request, "stored runner-fill request") ===
            fillIntentRequestJson &&
          serialize(existingFill.outcome, "stored runner-fill outcome") ===
            fillIntentOutcomeJson;
        if (replayed) return { kind: "replayed" };
        if (signalRow?.status !== "unknown" ||
            positionRow?.status !== expectedPositionSnapshot.status ||
            positionRow?.updated_at_text !== updatedAt ||
            serialize(positionRow.snapshot, "stored original-stop position") !==
              snapshotJson ||
            oldIntent?.phase !== oldPhase ||
            oldIntent.state !== expectedOldIntentState ||
            oldIntent.exchange_order_id !== null ||
            serialize(oldIntent.request, "stored original-stop request") !== requestJson ||
            serialize(oldIntent.outcome, "stored original-stop outcome") !== outcomeJson ||
            existingFill) {
          return { kind: "ineligible", reason: "position_changed" };
        }
        const competing = await client.query(
          `SELECT client_order_id
           FROM vst_order_intents
           WHERE source_signal_id = $1 AND client_order_id <> $2
             AND state IN ('prepared', 'submitted', 'unknown')
           ORDER BY client_order_id FOR UPDATE`,
          [signalId, oldOrderId],
        );
        if (competing.rows.length > 0) {
          return { kind: "ineligible", reason: "competing_intent" };
        }
        const settlementAt = Number(clock());
        if (!Number.isSafeInteger(settlementAt) || settlementAt < evidenceAt ||
            settlementAt - evidenceAt > maxEvidenceAge) {
          return { kind: "ineligible", reason: "evidence_stale" };
        }
        const retired = await client.query(
          `UPDATE vst_order_intents
           SET state = $7, exchange_order_id = $8,
               outcome = $9::jsonb, updated_at = now()
           WHERE source_signal_id = $1 AND client_order_id = $2
             AND phase = $3 AND state = $6
             AND exchange_order_id IS NULL
             AND request = $4::jsonb AND outcome = $5::jsonb
           RETURNING client_order_id`,
          [signalId, oldOrderId, oldPhase, requestJson, outcomeJson,
            expectedOldIntentState, oldTerminalState, oldExchangeOrderId,
            retiredOldOutcomeJson],
        );
        const updatedPosition = await client.query(
          `UPDATE vst_positions SET status = $3, snapshot = $4::jsonb, updated_at = now()
           WHERE source_signal_id = $1 AND status = $5
             AND updated_at = $6::timestamptz AND snapshot = $2::jsonb
           RETURNING source_signal_id`,
          [signalId, snapshotJson, position.status, positionJson,
            expectedPositionSnapshot.status, updatedAt],
        );
        const updatedSignal = await client.query(
          `UPDATE vst_signals SET status = 'open', reason = NULL, updated_at = now()
           WHERE source_signal_id = $1 AND status = 'unknown'
           RETURNING source_signal_id`,
          [signalId],
        );
        const insertedFill = await client.query(
          `INSERT INTO vst_order_intents
             (source_signal_id, phase, client_order_id, request, state,
              exchange_order_id, outcome)
           VALUES ($1, $2, $3, $4::jsonb, 'reconciled', $5, $6::jsonb)
           RETURNING client_order_id`,
          [signalId, fillIntent.phase, fillIntent.clientOrderId,
            fillIntentRequestJson, fillIntent.exchangeOrderId,
            fillIntentOutcomeJson],
        );
        if (retired.rowCount !== 1 || updatedPosition.rowCount !== 1 ||
            updatedSignal.rowCount !== 1 || insertedFill.rowCount !== 1) {
          throw new Error("VST original-stop runner-fill recovery CAS failed");
        }
        await client.query(
          `INSERT INTO vst_events (source_signal_id, client_order_id, kind, detail)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [signalId, fillIntent.clientOrderId,
            sentCancelConfirmed
              ? "vst_impulse_runner_fill_cleanup_completed"
              : "vst_impulse_runner_fill_cleanup_pending",
            eventDetailJson],
        );
        return { kind: "recovered" };
      });
    },

    // Settles only the exact, known pre-transport refusal of the one
    // runner-fill cancellation. This records that no DELETE was attempted;
    // it deliberately does not reserve or submit a replacement intent.
    async recoverPreTransportRunnerCancel({
      sourceSignalId, clientOrderId, expectedRequest, expectedSnapshot,
      recoveryPhase, recoveryPosition, recoveryAttempt = 1,
    }) {
      const signalId = requireString(sourceSignalId, "sourceSignalId");
      const orderId = requireString(clientOrderId, "clientOrderId");
      const phase = requireString(recoveryPhase, "recoveryPhase");
      if (![1, 2].includes(recoveryAttempt)) {
        throw new Error("VST runner cancellation recovery attempt must be 1 or 2");
      }
      const requestJson = serialize(expectedRequest, "expected runner cancellation request");
      const expectedSnapshotJson = serialize(expectedSnapshot, "expected runner cancellation snapshot");
      const childOrderId = expectedRequest?.runnerChildOrderId;
      if (typeof childOrderId !== "string" || childOrderId.trim() === "") {
        throw new Error("VST runner cancellation recovery facts are not deterministic");
      }
      const originalRecoveryPhase = `impulse-runner-cancel-recovery-${childOrderId}`;
      const expectedRecoveryPhase = recoveryAttempt === 1
        ? originalRecoveryPhase
        : `impulse-runner-cancel-recovery-2-${childOrderId}`;
      const intentPhase = recoveryAttempt === 1
        ? `impulse-runner-cancel-original-${childOrderId}`
        : originalRecoveryPhase;
      const refusalError = recoveryAttempt === 1
        ? "VST runner parent order is not an exact verified 20% BE stop fill"
        : "VST runner fill history does not uniquely link to its exact parent stop";
      if (phase !== expectedRecoveryPhase) {
        throw new Error("VST runner cancellation recovery phase is not deterministic");
      }
      if (recoveryPosition?.sourceSignalId !== signalId ||
          recoveryPosition?.status !== "closing" ||
          recoveryPosition?.split?.runnerCleanup?.recoveryPhase !== phase) {
        throw new Error("VST runner cancellation recovery position has an invalid recovery marker");
      }
      const recoveryPositionJson = serialize(recoveryPosition, "runner cancellation recovery position");
      const comparablePosition = (value) => {
        const copy = JSON.parse(serialize(value, "runner cancellation position comparison"));
        delete copy.status;
        if (copy.split?.runnerCleanup) {
          delete copy.split.runnerCleanup.recoveryPhase;
        }
        return serialize(copy, "runner cancellation position comparison");
      };
      if (comparablePosition(expectedSnapshot) !== comparablePosition(recoveryPosition)) {
        throw new Error("VST runner cancellation recovery may only set closing status and recoveryPhase");
      }
      if (expectedRequest?.operation !== "cancel_original_after_runner_fill" ||
          expectedRequest?.sourceSignalId !== signalId) {
        throw new Error("VST runner cancellation recovery facts are not deterministic");
      }
      if (phase === intentPhase) {
        throw new Error("VST runner cancellation recovery phase must be unique from the original intent");
      }
      if (recoveryAttempt === 2 &&
          expectedSnapshot?.split?.runnerCleanup?.recoveryPhase !== originalRecoveryPhase) {
        throw new Error("VST second runner cancellation recovery requires the first recovery marker");
      }

      return transaction(pool, async (client) => {
        await lockSignalIntents(client, signalId);
        // Signal is the per-position serialization point: even if no
        // cancellation row existed when a competing transaction started,
        // only one can pass the check-and-transition below.
        const signalResult = await client.query(
          `SELECT source_signal_id, body, body_hash, status, reason, received_at, updated_at
           FROM vst_signals WHERE source_signal_id = $1 FOR UPDATE`,
          [signalId],
        );
        const signalRow = signalResult.rows[0];
        if (!signalRow) return { kind: "ineligible" };

        const positionResult = await client.query(
          `SELECT source_signal_id, symbol, status, snapshot, updated_at
           FROM vst_positions WHERE source_signal_id = $1 FOR UPDATE`,
          [signalId],
        );
        const positionRow = positionResult.rows[0];
        if (!positionRow) return { kind: "ineligible" };

        const oldResult = await client.query(
          `SELECT source_signal_id, phase, client_order_id, request, state,
                  exchange_order_id, outcome, created_at, updated_at
           FROM vst_order_intents
           WHERE source_signal_id = $1 AND client_order_id = $2 FOR UPDATE`,
          [signalId, orderId],
        );
        const old = oldResult.rows[0];
        if (!old) return { kind: "ineligible" };

        const cancellationResult = await client.query(
          `SELECT source_signal_id, phase, client_order_id, request, state, outcome
           FROM vst_order_intents
           WHERE source_signal_id = $1
             AND request->>'operation' = 'cancel_original_after_runner_fill'
           ORDER BY client_order_id FOR UPDATE`,
          [signalId],
        );
        if (old.phase !== intentPhase ||
            serialize(old.request, "stored runner cancellation request") !== requestJson) {
          throw new Error("VST runner cancellation recovery request or deterministic phase mismatch");
        }
        const expectedStopId = expectedRequest.originalStopOrderId;
        if (typeof expectedStopId !== "string" || expectedStopId.trim() === "") {
          throw new Error("VST runner cancellation recovery has no original stop identity");
        }

        const recoveryOutcome = {
          ...old.outcome,
          status: "pre_transport_refused_no_delete",
          recoveryPhase: phase,
        };
        const recoveryOutcomeJson = serialize(recoveryOutcome, "runner cancellation recovery outcome");
        const samePosition = serialize(positionRow.snapshot, "stored runner cancellation snapshot") ===
          expectedSnapshotJson;
        const hasExactBoundaryRefusal =
          (old.outcome?.error === "BingXLiveApiError" &&
            old.outcome?.errorMessage === refusalError ||
            old.outcome?.submissionError === "BingXLiveApiError" &&
            old.outcome?.submissionErrorMessage === refusalError) &&
          (old.outcome?.error === undefined ||
            old.outcome.error === "BingXLiveApiError" &&
            old.outcome.errorMessage === refusalError) &&
          (old.outcome?.submissionError === undefined ||
            old.outcome.submissionError === "BingXLiveApiError" &&
            old.outcome.submissionErrorMessage === refusalError);
        const exactRefusal = recoveryAttempt === 1
          ? old.outcome?.submissionError === "BingXLiveApiError" &&
            old.outcome?.submissionErrorMessage === refusalError
          : hasExactBoundaryRefusal;

        if (recoveryAttempt === 2) {
          const initialPhaseIntent = cancellationResult.rows.find((row) =>
            row.phase === `impulse-runner-cancel-original-${childOrderId}`);
          const exactFirstRefusal = initialPhaseIntent?.state === "failed" &&
            initialPhaseIntent.outcome?.status === "pre_transport_refused_no_delete" &&
            initialPhaseIntent.outcome?.recoveryPhase === originalRecoveryPhase;
          const sameHistoryIdentity = [old, initialPhaseIntent].every((row) =>
            row?.request?.operation === "cancel_original_after_runner_fill" &&
            row.request.sourceSignalId === signalId &&
            row.request.originalStopOrderId === expectedStopId &&
            row.request.runnerChildOrderId === childOrderId);
          if (cancellationResult.rows.length !== 2 ||
              cancellationResult.rows.some((row) =>
                ![intentPhase, `impulse-runner-cancel-original-${childOrderId}`]
                  .includes(row.phase)) ||
              !exactFirstRefusal || !sameHistoryIdentity) {
            return { kind: "ineligible" };
          }
        } else if (cancellationResult.rows.length !== 1 ||
            cancellationResult.rows[0].client_order_id !== orderId) {
          return { kind: "ineligible" };
        }

        if (old.state === "failed" &&
            old.outcome?.status === "pre_transport_refused_no_delete" &&
            old.outcome?.recoveryPhase === phase &&
            serialize(old.outcome, "stored runner cancellation recovery outcome") === recoveryOutcomeJson &&
            positionRow.status === "closing" &&
            serialize(positionRow.snapshot, "stored runner cancellation recovery position") === recoveryPositionJson &&
            signalRow.status === "open" &&
            (recoveryAttempt === 1 || cancellationResult.rows.length === 2)) {
          return { kind: "replayed" };
        }
        if (old.state !== "unknown" || !exactRefusal || !samePosition ||
            positionRow.status !== "closing" || signalRow.status !== "unknown" ||
            (recoveryAttempt === 2 &&
              positionRow.snapshot?.split?.runnerCleanup?.recoveryPhase !== originalRecoveryPhase)) {
          return { kind: "ineligible" };
        }

        const updatedIntent = await client.query(
          `UPDATE vst_order_intents SET state = 'failed', outcome = $3::jsonb, updated_at = now()
           WHERE source_signal_id = $1 AND client_order_id = $2 AND state = 'unknown'
           RETURNING client_order_id`,
          [signalId, orderId, recoveryOutcomeJson],
        );
        if (updatedIntent.rowCount !== 1) {
          throw new Error("VST runner cancellation recovery intent compare-and-set failed");
        }
        const updatedPosition = await client.query(
          `UPDATE vst_positions SET snapshot = $3::jsonb, updated_at = now()
           WHERE source_signal_id = $1 AND status = 'closing' AND snapshot = $2::jsonb
           RETURNING source_signal_id`,
          [signalId, expectedSnapshotJson, recoveryPositionJson],
        );
        if (updatedPosition.rowCount !== 1) {
          throw new Error("VST runner cancellation recovery position compare-and-set failed");
        }
        const updatedSignal = await client.query(
          `UPDATE vst_signals SET status = 'open', reason = NULL, updated_at = now()
           WHERE source_signal_id = $1 AND status = 'unknown'
           RETURNING source_signal_id`,
          [signalId],
        );
        if (updatedSignal.rowCount !== 1) {
          throw new Error("VST runner cancellation recovery signal compare-and-set failed");
        }
        await client.query(
          `INSERT INTO vst_events (source_signal_id, client_order_id, kind, detail)
           VALUES ($1, $2, 'vst_runner_cancel_pre_transport_refused', $3::jsonb)`,
          [signalId, orderId, serialize({
            operation: "cancel_original_after_runner_fill",
            outcome: "pre_transport_refused_no_delete",
            recoveryAttempt,
            recoveryPhase: phase,
            canceled: false,
            message: recoveryAttempt === 1
              ? "Runner parent order refusal occurred before transport; no cancellation was made"
              : "Runner fill history refusal occurred before transport; no cancellation was made",
          }, "runner cancellation recovery event")],
        );
        return { kind: "recovered" };
      });
    },

    /**
     * Persist fresh source exit decisions in vst_events. The signal row lock
     * serializes independent pollers; request events are durable queue records
     * and completion events are never removed or reverted.
     */
    async queueSourceExitRequests({ asOf, positions, observedAt = Date.now() } = {}) {
      requireIsoTimestamp(asOf, "asOf");
      if (!(positions instanceof Map)) {
        throw new TypeError("positions must be a Map keyed by sourceSignalId");
      }
      const observedAtMs = observedAt instanceof Date
        ? observedAt.getTime()
        : typeof observedAt === "string"
          ? Date.parse(observedAt)
          : toFiniteNumber(observedAt, "observedAt");
      if (!Number.isFinite(observedAtMs)) {
        throw new TypeError("observedAt must be a valid timestamp");
      }
      const latestObservedAt = new Date(observedAtMs);
      if (!Number.isFinite(latestObservedAt.getTime())) {
        throw new TypeError("observedAt must be a valid timestamp");
      }
      const latestObservedAtIso = latestObservedAt.toISOString();

      const results = await Promise.all([...positions.entries()].map(async ([idValue, source]) => {
        const id = typeof idValue === "string" ? idValue : "";
        if (id.trim() === "") {
          return { type: "rejected", item: { sourceSignalId: null, reason: "invalid_source_signal_id" } };
        }
        try {
          return await transaction(pool, async (client) => {
            const known = await client.query(
              `SELECT s.source_signal_id, s.body, s.status AS signal_status,
                      p.symbol AS position_symbol, p.status AS position_status,
                      p.snapshot AS position_snapshot
               FROM vst_signals s
               LEFT JOIN vst_positions p ON p.source_signal_id = s.source_signal_id
               WHERE s.source_signal_id = $1
               FOR UPDATE OF s`,
              [id],
            );
            if (!known.rowCount) {
              return {
                type: "rejected",
                item: { sourceSignalId: id, reason: "unknown_vst_signal" },
              };
            }

            const row = known.rows[0];
            const signalBody = validObject(row.body) ? row.body : {};
            const localSymbol = signalBody.symbol;
            if (source?.sourceSignalId !== id) {
              return {
                type: "rejected",
                item: { sourceSignalId: id, reason: "source_signal_id_mismatch" },
              };
            }
            if (typeof localSymbol !== "string" || localSymbol.trim() === "" ||
                (row.position_symbol !== null && row.position_symbol !== undefined &&
                  row.position_symbol !== localSymbol)) {
              return {
                type: "rejected",
                item: { sourceSignalId: id, reason: "vst_signal_symbol_conflict" },
              };
            }
            if (source?.symbol !== localSymbol) {
              return {
                type: "rejected",
                item: { sourceSignalId: id, reason: "source_symbol_mismatch" },
              };
            }

            const requestResult = await client.query(
              `SELECT id, source_signal_id, kind, detail, created_at::text AS created_at
               FROM vst_events
               WHERE source_signal_id = $1 AND kind = 'source_exit_requested'
                 AND ${sourceExitRequestPredicate("detail", "detail->'evidence'")}
               ORDER BY id
               LIMIT 1`,
              [id],
            );
            const requestRow = requestResult.rows[0] ?? null;
            const requestDetail = validObject(requestRow?.detail) ? requestRow.detail : null;
            const requestId = sourceExitRequestId(id);

            if (requestRow && requestDetail?.requestId !== requestId) {
              return {
                type: "rejected",
                item: { sourceSignalId: id, reason: "source_exit_request_identity_conflict" },
              };
            }

            let evidence = null;
            try {
              const positionExists = row.position_status !== null &&
                row.position_status !== undefined;
              const snapshot = validObject(row.position_snapshot) ? row.position_snapshot : {};
              const entryAt = positionExists
                ? (snapshot.entryAt ?? signalBody.signalAt)
                : signalBody.signalAt;
              evidence = buildSourceExitEvidence(source, {
                sourceSignalId: id,
                symbol: localSymbol,
                entryAt,
                signalAt: signalBody.signalAt,
                asOf,
                observedAt: observedAtMs,
              });
            } catch (error) {
              return {
                type: "rejected",
                item: {
                  sourceSignalId: id,
                  ...(requestRow ? { requestId } : {}),
                  reason: "source_exit_evidence_error",
                  detail: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
                },
              };
            }

            if (requestRow) {
              if (!evidence) {
                return {
                  type: "rejected",
                  item: {
                    sourceSignalId: id,
                    requestId,
                    reason: "source_exit_evidence_not_eligible",
                  },
                };
              }
              if (!sameSourceExitProvenance(requestDetail.evidence, evidence)) {
                return {
                  type: "rejected",
                  item: {
                    sourceSignalId: id,
                    requestId,
                    reason: "source_exit_evidence_conflict",
                  },
                };
              }
              const refresh = JSON.stringify({
                latestAsOf: asOf,
                latestObservedAt: latestObservedAtIso,
              });
              await client.query(
                `UPDATE vst_events
                 SET detail = detail || $2::jsonb
                 WHERE id = $1 AND kind = 'source_exit_requested'`,
                [requestRow.id, refresh],
              );
              const completion = await client.query(
                `SELECT id
                 FROM vst_events
                 WHERE source_signal_id = $1 AND kind = 'source_exit_completed'
                   AND detail->>'requestId' = $2
                 ORDER BY id
                 LIMIT 1`,
                [id, requestId],
              );
              return {
                type: "refreshed",
                item: {
                  requestId,
                  sourceSignalId: id,
                  symbol: requestDetail.symbol,
                  reason: requestDetail.reason,
                  completed: completion.rowCount > 0,
                  asOf,
                  observedAt: latestObservedAtIso,
                },
              };
            }

            if (row.position_status === "closed") {
              return {
                type: "rejected",
                item: { sourceSignalId: id, reason: "vst_position_already_closed" },
              };
            }
            if (!row.position_status &&
                ["closed", "rejected", "unsupported"].includes(row.signal_status)) {
              return {
                type: "rejected",
                item: { sourceSignalId: id, reason: "terminal_no_entry_signal" },
              };
            }
            if (!evidence) {
              return {
                type: "rejected",
                item: {
                  sourceSignalId: id,
                  reason: "source_exit_evidence_not_eligible",
                },
              };
            }

            const requestDetailToSave = {
              requestId,
              sourceSignalId: id,
              symbol: localSymbol,
              reason: evidence.reason,
              evidence,
              asOf: evidence.asOf,
              observedAt: evidence.observedAt,
              latestAsOf: asOf,
              latestObservedAt: latestObservedAtIso,
            };
            await client.query(
              `INSERT INTO vst_events (source_signal_id, client_order_id, kind, detail)
               VALUES ($1, NULL, 'source_exit_requested', $2::jsonb)`,
              [id, serialize(requestDetailToSave, "source exit request event detail")],
            );
            return {
              type: "queued",
              item: {
                requestId,
                sourceSignalId: id,
                symbol: localSymbol,
                reason: evidence.reason,
                evidence,
                asOf,
                observedAt: latestObservedAtIso,
              },
            };
          });
        } catch (error) {
          return {
            type: "rejected",
            item: {
              sourceSignalId: id,
              reason: "source_exit_queue_error",
              detail: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
            },
          };
        }
      }));

      return {
        queued: results.filter((result) => result?.type === "queued").map(({ item }) => item),
        refreshed: results.filter((result) => result?.type === "refreshed").map(({ item }) => item),
        rejected: results.filter((result) => result?.type === "rejected").map(({ item }) => item),
      };
    },

    async getSourceControl(sourceSignalId) {
      return createSourceControlStore(pool).getSourceControl(sourceSignalId);
    },

    async syncSourceControls(snapshot) {
      return createSourceControlStore(pool).syncSourceControls(snapshot);
    },

    async recordSourceControlExchangeObservation(control, observation) {
      return createSourceControlStore(pool).recordSourceControlExchangeObservation(control, observation);
    },

    async listPendingSourceExitRequests({ sourceSignalId = null, limit = Infinity } = {}) {
      if (sourceSignalId !== null) requireString(sourceSignalId, "sourceSignalId");
      if (limit !== Infinity &&
          (!Number.isInteger(limit) || limit < 1 || limit > 1_000)) {
        throw new RangeError("Pending VST source exit request limit must be 1..1000");
      }
      const result = await pool.query(
        `SELECT request.id, request.source_signal_id, request.kind, request.detail,
                request.created_at::text AS created_at
         FROM vst_events AS request
         WHERE request.kind = 'source_exit_requested'
           AND ${sourceExitRequestPredicate("request.detail", "request.detail->'evidence'")}
           AND NOT EXISTS (
             SELECT 1
             FROM vst_events AS completion
             WHERE completion.kind = 'source_exit_completed'
               AND completion.source_signal_id = request.source_signal_id
               AND completion.detail->>'requestId' = request.detail->>'requestId'
           )
         ORDER BY request.id, request.source_signal_id`,
      );
      return result.rows
        .map((row) => sourceExitRequestFromEvent(row))
        .filter((request) =>
          request && (sourceSignalId === null || request.sourceSignalId === sourceSignalId))
        .slice(0, limit);
    },

    async hasPendingSourceExitRequest(sourceSignalId) {
      const id = requireString(sourceSignalId, "sourceSignalId");
      const result = await pool.query(
        `SELECT EXISTS (
           SELECT 1
           FROM vst_events AS request
           WHERE request.source_signal_id = $1
             AND request.kind = 'source_exit_requested'
             AND ${sourceExitRequestPredicate("request.detail", "request.detail->'evidence'")}
             AND NOT EXISTS (
               SELECT 1
               FROM vst_events AS completion
               WHERE completion.source_signal_id = request.source_signal_id
                 AND completion.kind = 'source_exit_completed'
                 AND completion.detail->>'requestId' = request.detail->>'requestId'
             )
         ) AS pending`,
        [id],
      );
      return result.rows[0]?.pending === true;
    },

    async getHistoricalCloseEvent(sourceSignalId) {
      const result = await pool.query(
        `SELECT detail FROM vst_events
         WHERE source_signal_id = $1 AND kind = 'exchange_history_provenance'
         ORDER BY id DESC LIMIT 1`,
        [requireString(sourceSignalId, "sourceSignalId")],
      );
      return result.rows[0]?.detail ?? null;
    },

    async finishSourceExitRequest(requestId, { outcome, detail = {} } = {}) {
      const id = requireString(requestId, "requestId");
      requireString(outcome, "outcome");
      requirePlainObject(detail, "detail");
      const completionDetailJson = serialize(detail, "source exit completion detail");
      const found = await pool.query(
        `SELECT source_signal_id
         FROM vst_events
         WHERE kind = 'source_exit_requested' AND detail->>'requestId' = $1
           AND ${sourceExitRequestPredicate("detail", "detail->'evidence'")}
         ORDER BY id
         LIMIT 1`,
        [id],
      );
      if (!found.rowCount) throw new RangeError("VST source exit request was not found");
      const sourceSignalId = found.rows[0].source_signal_id;

      return transaction(pool, async (client) => {
        const signal = await client.query(
          `SELECT source_signal_id FROM vst_signals
           WHERE source_signal_id = $1
           FOR UPDATE`,
          [sourceSignalId],
        );
        if (!signal.rowCount) throw new Error("VST source exit request lost its signal row");
        const request = await client.query(
          `SELECT id, source_signal_id, detail
           FROM vst_events
           WHERE kind = 'source_exit_requested' AND detail->>'requestId' = $1
             AND ${sourceExitRequestPredicate("detail", "detail->'evidence'")}
           ORDER BY id
           LIMIT 1`,
          [id],
        );
        if (!request.rowCount || request.rows[0].source_signal_id !== sourceSignalId) {
          throw new Error("VST source exit request changed while completing");
        }
        if (detail.closureOrigin === "already_committed_exchange_history") {
          const closed = await client.query(
            `SELECT p.source_signal_id, p.symbol, p.status, p.snapshot, p.updated_at,
                    e.detail AS history_event
             FROM vst_positions p
             JOIN vst_events e ON e.source_signal_id = p.source_signal_id
               AND e.kind = 'exchange_history_provenance'
             WHERE p.source_signal_id = $1
               AND NOT EXISTS (
                 SELECT 1 FROM vst_order_intents i
                 WHERE i.source_signal_id = p.source_signal_id
                   AND i.state IN ('prepared','submitted','unknown'))
             ORDER BY e.id DESC LIMIT 1 FOR UPDATE OF p`,
            [sourceSignalId],
          );
          const persisted = closed.rows[0];
          const command = request.rows[0].detail;
          const proof = persisted && committedHistoricalCloseProof(
            positionFromRow(persisted),
            { sourceSignalId, symbol: command.symbol },
            persisted.history_event,
          );
          if (outcome !== "closed" || !proof ||
              proof.closeOrderId !== detail.closeOrderId ||
              proof.entryOrderId !== detail.entryOrderId) {
            throw new Error("VST historical source close proof changed while completing");
          }
        }
        const prior = await client.query(
          `SELECT id, source_signal_id, kind, detail, created_at::text AS created_at
           FROM vst_events
           WHERE source_signal_id = $1 AND kind = 'source_exit_completed'
             AND detail->>'requestId' = $2
           ORDER BY id
           LIMIT 1`,
          [sourceSignalId, id],
        );
        if (prior.rowCount) return sourceExitEventFromRow(prior.rows[0]);

        const requestDetail = validObject(request.rows[0].detail)
          ? request.rows[0].detail : {};
        const completionDetail = {
          requestId: id,
          sourceSignalId,
          symbol: requestDetail.symbol,
          reason: requestDetail.reason,
          evidence: requestDetail.evidence,
          outcome,
          detail: JSON.parse(completionDetailJson),
        };
        const inserted = await client.query(
          `INSERT INTO vst_events (source_signal_id, client_order_id, kind, detail)
           VALUES ($1, NULL, 'source_exit_completed', $2::jsonb)
           RETURNING id, source_signal_id, kind, detail, created_at::text AS created_at`,
          [sourceSignalId, serialize(completionDetail, "source exit completion event detail")],
        );
        return sourceExitEventFromRow(inserted.rows[0]);
      });
    },

    async recordEvent(sourceSignalId, kind, detail = {}, clientOrderId = null) {
      if (sourceSignalId !== null) requireString(sourceSignalId, "sourceSignalId");
      requireString(kind, "event.kind");
      const serialized = serialize(detail, "VST event detail");
      await pool.query(
        `INSERT INTO vst_events (source_signal_id, client_order_id, kind, detail)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [sourceSignalId, clientOrderId, kind, serialized],
      );
    },

    async recordEntryQueueTelemetry(sourceSignalId, telemetry) {
      const id = requireString(sourceSignalId, "sourceSignalId");
      if (!validObject(telemetry) ||
          !["preparing", "prepared", "timing", "deferred"].includes(telemetry.event)) {
        throw new TypeError("Invalid VST entry queue telemetry");
      }
      const detail = { event: telemetry.event };
      const copyDuration = (key) => {
        if (telemetry[key] === undefined) return;
        if (!Number.isSafeInteger(telemetry[key]) || telemetry[key] < 0) {
          throw new TypeError(`Invalid VST entry queue ${key}`);
        }
        detail[key] = telemetry[key];
      };
      if (telemetry.event === "preparing") {
        if (Object.keys(telemetry).some((key) =>
          !["event", "sourceSignalId"].includes(key))) {
          throw new TypeError("Invalid VST entry queue telemetry fields");
        }
      } else if (telemetry.event === "prepared") {
        if (Object.keys(telemetry).some((key) =>
          !["event", "sourceSignalId", "prepareMs", "prepared"].includes(key)) ||
            typeof telemetry.prepared !== "boolean") {
          throw new TypeError("Invalid VST entry queue telemetry fields");
        }
        copyDuration("prepareMs");
        detail.prepared = telemetry.prepared;
      } else if (telemetry.event === "timing") {
        if (Object.keys(telemetry).some((key) =>
          !["event", "sourceSignalId", "prepareMs", "executeMs", "queueWaitMs", "prepared", "deferReason"].includes(key)) ||
            typeof telemetry.prepared !== "boolean") {
          throw new TypeError("Invalid VST entry queue telemetry fields");
        }
        copyDuration("prepareMs");
        copyDuration("executeMs");
        if (telemetry.queueWaitMs !== null && telemetry.queueWaitMs !== undefined) {
          copyDuration("queueWaitMs");
        } else {
          detail.queueWaitMs = null;
        }
        detail.prepared = telemetry.prepared;
        if (telemetry.deferReason !== undefined &&
            telemetry.deferReason !== null) {
          if (!safeVstEntryDeferReason(telemetry.deferReason)) {
            throw new TypeError("Invalid VST entry queue telemetry deferReason");
          }
          detail.deferReason = telemetry.deferReason;
        }
      } else {
        if (Object.keys(telemetry).some((key) =>
          !["event", "sourceSignalId", "prepareMs", "deferReason", "prepared"].includes(key)) ||
            !safeVstEntryDeferReason(telemetry.deferReason)) {
          throw new TypeError("Invalid VST entry queue telemetry fields");
        }
        copyDuration("prepareMs");
        detail.deferReason = telemetry.deferReason;
        if (telemetry.prepared !== undefined) {
          if (typeof telemetry.prepared !== "boolean") {
            throw new TypeError("Invalid VST entry queue telemetry prepared");
          }
          detail.prepared = telemetry.prepared;
        }
      }
      await pool.query(
        `INSERT INTO vst_entry_queue_snapshots (source_signal_id, slot, detail, recorded_at)
         SELECT $1, slot, $2::jsonb, clock_timestamp()
         FROM (VALUES ('latest'), ('timing')) AS slots(slot)
         WHERE slot = 'latest' OR $2::jsonb->>'event' = 'timing'
         ON CONFLICT (source_signal_id, slot) DO UPDATE
         SET detail = EXCLUDED.detail, recorded_at = EXCLUDED.recorded_at`,
        [id, serialize(detail, "VST entry queue telemetry")],
      );
    },
  };
}