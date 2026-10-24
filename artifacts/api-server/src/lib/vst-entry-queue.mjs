import { safeVstEntryDeferReason } from "../bullet-bot/vst-entry-batch/safe-reasons.mjs";

const DISPLAY_LIMIT = 100;
const ENTRY_PHASES = new Set([
  "isolated-margin-mode",
  "isolated-leverage-10",
  "market-entry",
]);
const INTENT_STATES = new Set([
  "prepared", "submitted", "unknown", "reconciled", "failed",
]);
function isoTimestamp(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function nonNegativeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function safeSymbol(value) {
  return typeof value === "string" &&
    /^[A-Z0-9]+-?USDT$/.test(value) ? value : null;
}

function queueEntryFromRow(row, asOf) {
  const receivedAt = isoTimestamp(row.received_at);
  const updatedAt = isoTimestamp(row.updated_at);
  const intentPhase = ENTRY_PHASES.has(row.intent_phase)
    ? row.intent_phase : null;
  const intentState = INTENT_STATES.has(row.intent_state)
    ? row.intent_state : null;
  const telemetryEvent = ["preparing", "prepared", "timing", "deferred"]
    .includes(row.telemetry_event) ? row.telemetry_event : null;
  const telemetryCompletionEvent = ["prepared", "timing", "deferred"]
    .includes(telemetryEvent);
  const latestTelemetryStage = telemetryEvent === "preparing"
    ? "preparing"
    : telemetryCompletionEvent && row.telemetry_prepared === false
      ? "preparation_failed"
      : telemetryCompletionEvent &&
          (row.telemetry_prepared === true ||
            (telemetryEvent === "deferred" && row.telemetry_prepared == null))
      ? "prepared" : null;
  const stage = intentPhase && intentState
    ? `${intentPhase}:${intentState}`
    : row.status === "opening"
      ? "executing"
      : latestTelemetryStage ?? (row.status === "planning" ? "preparing" : "queued");
  const stageConfirmedAt = intentPhase && intentState
    ? isoTimestamp(row.intent_updated_at)
    : latestTelemetryStage
      ? isoTimestamp(row.telemetry_created_at)
      : row.status === "opening" || row.status === "planning"
        ? updatedAt : receivedAt;
  const receivedMs = receivedAt === null ? NaN : Date.parse(receivedAt);
  const asOfMs = Date.parse(asOf);
  const queueWaitMs = Number.isFinite(receivedMs) &&
    receivedMs > 0 && Number.isFinite(asOfMs) && asOfMs >= receivedMs
    ? Math.round(asOfMs - receivedMs) : null;
  const deferReason = safeVstEntryDeferReason(row.defer_reason) ??
    safeVstEntryDeferReason(row.signal_reason);
  return {
    sourceSignalId: String(row.source_signal_id),
    symbol: safeSymbol(row.symbol),
    status: String(row.status),
    receivedAt,
    updatedAt,
    queueWaitMs,
    prepareMs: nonNegativeNumber(row.prepare_ms),
    executeMs: nonNegativeNumber(row.execute_ms),
    stage,
    stageConfirmedAt,
    deferReason,
  };
}

/**
 * Reads only the VST ledger, compact measurements and legacy event/intent history.
 * The window count reports all eligible signals while the returned page stays
 * bounded to the first 100 queue rows.
 */
export async function readVstEntryQueue(pool, { now = () => Date.now() } = {}) {
  const asOf = new Date(now()).toISOString();
  const result = await pool.query(
    `WITH queue_page AS MATERIALIZED (
       SELECT s.*, COUNT(*) OVER() AS total
       FROM vst_signals s
       WHERE s.status IN ('pending', 'planning', 'opening')
         AND NOT EXISTS (
           SELECT 1 FROM vst_positions p
           WHERE p.source_signal_id = s.source_signal_id
         )
       ORDER BY CASE WHEN s.status = 'opening' THEN 0
                     WHEN s.status = 'planning' THEN 1 ELSE 2 END,
                s.received_at NULLS LAST, s.source_signal_id
       LIMIT ${DISPLAY_LIMIT}
     )
     SELECT s.source_signal_id, s.body->>'symbol' AS symbol, s.status,
            s.reason AS signal_reason,
            s.received_at::text AS received_at, s.updated_at::text AS updated_at,
             s.total,
            telemetry.detail->>'event' AS telemetry_event,
            telemetry.detail->>'prepared' = 'true' AS telemetry_prepared,
            telemetry.detail->>'deferReason' AS defer_reason,
            telemetry.created_at::text AS telemetry_created_at,
            telemetry.detail->>'prepareMs' AS prepare_ms,
            timing.detail->>'executeMs' AS execute_ms,
            intent.phase AS intent_phase, intent.state AS intent_state,
            intent.updated_at::text AS intent_updated_at
     FROM queue_page s
     LEFT JOIN LATERAL (
       SELECT i.phase, i.state, i.updated_at
       FROM vst_order_intents i
       WHERE i.source_signal_id = s.source_signal_id
         AND i.phase IN ('isolated-margin-mode', 'isolated-leverage-10', 'market-entry')
       ORDER BY i.updated_at DESC, i.created_at DESC, i.phase DESC
       LIMIT 1
     ) intent ON true
     LEFT JOIN vst_entry_queue_snapshots latest_snapshot
       ON latest_snapshot.source_signal_id = s.source_signal_id
       AND latest_snapshot.slot = 'latest'
     LEFT JOIN vst_entry_queue_snapshots timing_snapshot
       ON timing_snapshot.source_signal_id = s.source_signal_id
       AND timing_snapshot.slot = 'timing'
     LEFT JOIN LATERAL (
       SELECT COALESCE(latest_snapshot.detail, legacy.detail) AS detail,
              COALESCE(latest_snapshot.recorded_at, legacy.created_at) AS created_at
       FROM (SELECT 1) seed
       LEFT JOIN LATERAL (
         SELECT e.detail, e.created_at FROM vst_events e
         WHERE latest_snapshot.source_signal_id IS NULL
           AND e.source_signal_id = s.source_signal_id
           AND e.kind = 'vst_entry_queue_telemetry'
         ORDER BY e.id DESC LIMIT 1
       ) legacy ON true
     ) telemetry ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(timing_snapshot.detail, legacy.detail) AS detail
       FROM (SELECT 1) seed
       LEFT JOIN LATERAL (
         SELECT e.detail FROM vst_events e
         WHERE timing_snapshot.source_signal_id IS NULL
           AND e.source_signal_id = s.source_signal_id
           AND e.kind = 'vst_entry_queue_telemetry'
           AND e.detail->>'event' = 'timing'
         ORDER BY e.id DESC LIMIT 1
       ) legacy ON true
     ) timing ON true
     ORDER BY CASE WHEN s.status = 'opening' THEN 0
                   WHEN s.status = 'planning' THEN 1 ELSE 2 END,
               s.received_at NULLS LAST, s.source_signal_id`,
  );
  const total = result.rows.length ? Number(result.rows[0].total) : 0;
  const entries = result.rows.map((row) => queueEntryFromRow(row, asOf));
  return {
    asOf,
    total: Number.isSafeInteger(total) && total >= 0 ? total : entries.length,
    hasMore: total > entries.length,
    entries,
  };
}