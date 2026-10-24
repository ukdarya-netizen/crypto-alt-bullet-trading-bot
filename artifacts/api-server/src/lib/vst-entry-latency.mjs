const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LIMIT = 1000;
const FRESHNESS_REASONS = new Set([
  "final_pre_sign_pacing_expired",
]);
const PRE_SIGN_REASONS = new Set([
  "signal_expired", "final_balance_unavailable", "final_balance_invalid",
  "final_preflight_unavailable", "final_preflight_blocked", "final_budget_exceeded",
  "final_quote_unavailable_or_stale", "final_quote_out_of_bounds",
  "final_sizing_persistence_failed", "final_pre_sign_pacing_expired",
]);
function instant(value) {
  if (value === null || value === undefined || value === "") return null;
  const ms = value instanceof Date ? value.getTime() :
    typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}
const duration = (start, end) => {
  const a = instant(start), b = instant(end);
  return a !== null && b !== null && b >= a ? b - a : null;
};
const iso = (value) => instant(value) === null ? null : new Date(instant(value)).toISOString();
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * p) - 1];
}
function phaseDuration(intents, phase) {
  const intent = intents.find((i) => i.phase === phase && i.state === "reconciled");
  return intent ? duration(intent.createdAt, intent.updatedAt) : null;
}

export function buildVstEntryLatency(rows, { asOf, since, total = rows.length }) {
  const entries = rows.map((row) => {
    const intents = row.intents ?? [];
    const market = intents.find((i) => i.phase === "market-entry");
    // Match the exact durable entry attempt; never borrow another client's times.
    const events = (row.measurements ?? []).filter((e) =>
      e.version === "entry-latency-v1" && e.clientOrderId === market?.clientOrderId);
    const start = events.find((e) => e.boundary === "started");
    const sent = events.find((e) => e.boundary === "transport_started");
    const refusal = events.find((e) => e.boundary === "refused_before_transport");
    const detail = sent ?? refusal ?? start;
    const oldTransport = row.legacy_transport;
    const transportAt = sent?.transportStartedAtMs ?? oldTransport?.transportStartedAtMs;
    const reason = refusal?.preSignReason ??
      market?.outcome?.originalSubmissionError?.preSignReason ??
      market?.outcome?.preSignReason ?? null;
    // A definite venue rejection can follow a real POST; it is not no-transport proof.
    const noPost = !sent && (!!refusal || (PRE_SIGN_REASONS.has(reason) &&
      (market?.outcome?.originalSubmissionError?.definiteRejection === true ||
        market?.outcome?.definiteRejection === true)));
    const cohort = events.length ? "measured" : market ? "historical" : "not_attempted";
    const nativeChecksMs = duration(detail?.attemptStartedAtMs, detail?.finalPriceStartedAtMs);
    return {
      sourceSignalId: row.source_signal_id,
      symbol: /^[A-Z0-9]+-?USDT$/.test(row.symbol ?? "") ? row.symbol : null,
      status: row.status, cohort,
      receivedAt: iso(row.received_at), transportAt: iso(transportAt),
      receiptToTransportMs: duration(row.received_at, transportAt),
      receiptToNativeAttemptMs: duration(row.received_at, detail?.attemptStartedAtMs),
      marginModeMs: phaseDuration(intents, "isolated-margin-mode"),
      leverageMs: phaseDuration(intents, "isolated-leverage-10"),
      nativeChecksMs,
      finalPriceMs: duration(detail?.finalPriceStartedAtMs, detail?.finalPriceCompletedAtMs),
      pacingMs: duration(detail?.checksCompletedAtMs,
        sent?.transportStartedAtMs ?? refusal?.refusedAtMs),
      refusedBeforeTransport: noPost,
      freshnessRefusal: noPost && (refusal?.freshnessExpired === true || FRESHNESS_REASONS.has(reason)),
    };
  });
  const cohorts = ["measured", "historical", "not_attempted"].map((cohort) => {
    const group = entries.filter((e) => e.cohort === cohort);
    const timings = group.map((e) => e.receiptToTransportMs).filter((v) => v !== null);
    const refusals = group.filter((e) => e.refusedBeforeTransport).length;
    const freshnessRefusals = group.filter((e) => e.freshnessRefusal).length;
    return {
      cohort, count: group.length, timedCount: timings.length,
      p50Ms: percentile(timings, .5), p95Ms: percentile(timings, .95),
      refusals, freshnessRefusals,
      freshnessRefusalPercent: refusals ? freshnessRefusals / refusals * 100 : null,
    };
  });
  return { asOf, since, total, hasMore: total > entries.length, cohorts, entries };
}

export async function readVstEntryLatency(pool, { now = () => Date.now() } = {}) {
  const asOf = new Date(now()).toISOString();
  const since = new Date(Date.parse(asOf) - WINDOW_MS).toISOString();
  const result = await pool.query(`
    WITH signals AS MATERIALIZED (
      SELECT s.*, count(*) OVER() AS total FROM vst_signals s
      WHERE s.received_at >= $1 AND s.received_at <= $2
      ORDER BY s.received_at DESC, s.source_signal_id LIMIT ${LIMIT}
    )
    SELECT s.source_signal_id, s.body->>'symbol' AS symbol, s.status,
      s.received_at::text AS received_at, s.total,
      COALESCE(i.intents, '[]'::json) AS intents,
      COALESCE(e.measurements, '[]'::json) AS measurements,
      legacy.detail AS legacy_transport
    FROM signals s
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('phase', phase, 'state', state,
        'clientOrderId', client_order_id, 'createdAt', created_at,
        'updatedAt', updated_at, 'outcome', outcome) ORDER BY created_at) AS intents
      FROM vst_order_intents WHERE source_signal_id = s.source_signal_id
        AND phase IN ('isolated-margin-mode', 'isolated-leverage-10', 'market-entry')
    ) i ON true
    LEFT JOIN LATERAL (
      SELECT json_agg(detail ORDER BY id) AS measurements FROM vst_events
      WHERE source_signal_id = s.source_signal_id AND kind = 'vst_entry_latency'
    ) e ON true
    LEFT JOIN LATERAL (
      SELECT detail FROM vst_events
      WHERE source_signal_id = s.source_signal_id AND kind = 'vst_entry_queue_telemetry'
        AND detail->>'event' = 'entry_transport_ready'
      ORDER BY id LIMIT 1
    ) legacy ON true
    ORDER BY s.received_at DESC, s.source_signal_id`, [since, asOf]);
  return buildVstEntryLatency(result.rows, {
    asOf, since, total: Number(result.rows[0]?.total ?? 0),
  });
}
