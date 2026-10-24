const ACTIVE_STATUSES = new Set(["active", "in_run"]);
const SOURCE_CLOSURE_STATUSES = new Set([
  "cancelled", "profit", "stop_loss", "bu_stop", "reclassified", "breakeven", "expired",
]);
// These states are not evidence that the local exchange position is closed.
// `expired` becomes closure evidence only when it has a valid closedAt and
// positive exit price; otherwise it remains known inactive/unverified.
const SOURCE_INACTIVE_STATUSES = new Set([
  ...SOURCE_CLOSURE_STATUSES,
]);

function isPresent(value) {
  return value !== null && value !== undefined && value !== "";
}

function sourceState(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  return record.sourceStatus ?? null;
}

function hasProvenSourceClosure(record, status) {
  if (record?.sourceAction !== undefined && record.sourceAction !== "close") return false;
  if (!SOURCE_CLOSURE_STATUSES.has(status) || !isPresent(record?.sourceClosedAt)) {
    return false;
  }
  if (typeof record.sourceClosedAt !== "string" ||
      !Number.isFinite(Date.parse(record.sourceClosedAt))) return false;
  if (record.sourceAction === "close") return ["profit", "stop_loss", "bu_stop", "breakeven", "expired"].includes(status);
  const exitPrice = record.sourceExitPrice;
  if (typeof exitPrice !== "string" && typeof exitPrice !== "number") return false;
  const price = String(exitPrice);
  return /^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(price) &&
    Number.isFinite(Number(price)) && Number(price) > 0;
}

function validatePositions(positions) {
  if (!(positions instanceof Map)) {
    throw new TypeError("positions must be a complete Map keyed by sourceSignalId");
  }
  for (const [sourceSignalId, record] of positions) {
    if (typeof sourceSignalId !== "string" || sourceSignalId.length === 0) {
      throw new TypeError("positions keys must be non-empty sourceSignalId strings");
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new TypeError(`positions[${sourceSignalId}] must be a source position object`);
    }
  }
}

function compareLedger(ledger, rows, positions, { asOf, observedAt }) {
  const discrepancies = [];
  const matches = [];
  const observations = [];

  for (const row of rows) {
    const sourceSignalId = ledger === "vst" ? row.source_signal_id : row.signal_id;
    const localStatus = row.status;
    const record = positions.get(sourceSignalId);
    const context = {
      sourceAction: record?.sourceAction ?? null,
      sourceStatus: record?.sourceStatus ?? null,
      sourceUpdatedAt: record?.sourceUpdatedAt ?? null,
      sourceClosedAt: record?.sourceClosedAt ?? null,
      sourceAsOf: asOf,
      observedAt,
    };
    // Alert facts must belong to this successfully acquired snapshot, not to
    // the last entry event or a generic availability/publishing assumption.
    const source = record;
    const localSymbol = row.symbol;

    if (!source) {
      discrepancies.push({
        ledger,
        ...context,
        sourceSignalId,
        kind: "source_missing",
        verification: "unverified",
        localSymbol,
        localStatus,
      });
      continue;
    }

    const sourceSymbol = source.symbol;
    const status = sourceState(source);
    if (source.sourceSignalId !== undefined && source.sourceSignalId !== sourceSignalId) {
      discrepancies.push({
        ledger,
        ...context,
        sourceSignalId,
        kind: "source_signal_id_mismatch",
        verification: "discrepancy",
        localSymbol,
        sourceSymbol: typeof sourceSymbol === "string" ? sourceSymbol : null,
        sourceReportedSignalId: source.sourceSignalId,
        localStatus,
        sourceStatus: status,
      });
      continue;
    }
    if (typeof sourceSymbol !== "string" || sourceSymbol !== localSymbol) {
      discrepancies.push({
        ledger,
        ...context,
        sourceSignalId,
        kind: "symbol_mismatch",
        verification: "discrepancy",
        localSymbol,
        sourceSymbol: typeof sourceSymbol === "string" ? sourceSymbol : null,
        localStatus,
        sourceStatus: status,
      });
      continue;
    }

    if (source.sourceAction !== undefined &&
        (!Number.isFinite(Date.parse(source.sourceUpdatedAt)) ||
         Date.parse(observedAt) - Date.parse(source.sourceUpdatedAt) > 10 * 60_000)) {
      // sourceUpdatedAt is record-change time, not a heartbeat. Retain the
      // requested age diagnostic, but a fresh successful poll is not an outage.
      observations.push({
        ledger, ...context, sourceSignalId, kind: "source_record_update_age", verification: "informational",
        localSymbol, localStatus, sourceStatus: status,
      });
    }
    if (["review", "unknown"].includes(source.sourceAction)) {
      discrepancies.push({
        ledger, ...context, sourceSignalId, kind: `source_action_${source.sourceAction}`,
        verification: "unverified", localSymbol, localStatus, sourceStatus: status,
      });
      continue;
    }
    if (hasProvenSourceClosure(source, status)) {
      discrepancies.push({
        ledger,
        ...context,
        sourceSignalId,
        kind: "source_closed_while_local_active",
        verification: "discrepancy",
        localSymbol,
        localStatus,
        sourceStatus: status,
      });
      continue;
    }

    if (SOURCE_INACTIVE_STATUSES.has(status) || !ACTIVE_STATUSES.has(status)) {
      discrepancies.push({
        ledger,
        ...context,
        sourceSignalId,
        kind: "source_status_unverified",
        verification: "unverified",
        localSymbol,
        localStatus,
        sourceStatus: status,
      });
      continue;
    }

    // Matching local and Bullet statuses do not prove the exchange is still open.
    matches.push({ ledger, sourceSignalId, symbol: localSymbol, localStatus, sourceStatus: status, exchangeVerified: false });
  }

  return { checked: rows.length, matches, discrepancies, observations };
}

/**
 * Read-only comparison of local active position rows with a complete source
 * position map. Event tables have no uniqueness constraint for audit identity,
 * so this deliberately does not persist events: a query-then-insert "dedupe"
 * is racy and cannot provide a safe durable audit across both ledgers.
 */
export async function auditExchangeSourcePositions({
  pool, positions, asOf = null, observedAt = new Date().toISOString(),
} = {}) {
  validatePositions(positions);
  if (!pool || typeof pool.query !== "function") {
    return {
      status: "unavailable",
      mode: "read_only",
      reason: "database_not_configured",
      persistence: "disabled",
      persistenceLimitation: "vst_events and btb_live_events have no unique audit key; safe deduplication is not supported by the existing schema.",
      ledgers: null,
      discrepancies: [],
    };
  }

  try {
    const [vstResult, liveResult] = await Promise.all([
      pool.query(
        `SELECT source_signal_id, symbol, status
         FROM vst_positions
         WHERE status IN ('open', 'closing')
         ORDER BY source_signal_id`,
      ),
      pool.query(
        `SELECT signal_id, symbol, status
         FROM btb_live_position_snapshots
         WHERE status IN ('open', 'closing')
         ORDER BY signal_id`,
      ),
    ]);
    const vst = compareLedger("vst", vstResult.rows, positions, { asOf, observedAt });
    const live = compareLedger("real", liveResult.rows, positions, { asOf, observedAt });
    const discrepancies = [...vst.discrepancies, ...live.discrepancies];
    return {
      status: "available",
      mode: "read_only",
      persistence: "disabled",
      persistenceLimitation: "vst_events and btb_live_events have no unique audit key; safe deduplication is not supported by the existing schema.",
      ledgers: { vst, real: live },
      discrepancies,
      observations: [...vst.observations, ...live.observations],
    };
  } catch (error) {
    const schemaMissing = error?.code === "42P01" || error?.code === "42703";
    return {
      status: "unavailable",
      mode: "read_only",
      reason: schemaMissing ? "required_schema_missing" : "database_read_failed",
      persistence: "disabled",
      persistenceLimitation: "vst_events and btb_live_events have no unique audit key; safe deduplication is not supported by the existing schema.",
      ledgers: null,
      discrepancies: [],
    };
  }
}