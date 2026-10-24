// The existing intent ledger is the durable counter. No schema change or
// process-local counter is needed; restarts do not reset the denominators.
export const ENTRY_HEALTH_SQL = `
WITH windows AS (SELECT unnest(ARRAY[1,24,168]) AS hours),
entries AS (
  SELECT i.source_signal_id, s.received_at AS created_at,
    i.request->>'entrySizingPolicy' = 'fresh-before-sign-v1' AS refreshed,
    COALESCE(i.outcome->>'preSignReason' = 'final_quote_out_of_bounds', false)
      OR COALESCE(i.outcome->>'submissionErrorMessage' LIKE '%final_quote_out_of_bounds%', false)
      OR COALESCE(i.outcome->>'errorMessage' LIKE '%final_quote_out_of_bounds%', false) AS refused,
    CASE WHEN i.request->'entryPricingTelemetry'->>'calculatedAtMs' ~ '^[0-9]+$'
      AND i.request->'entryPricingTelemetry'->>'checkedAtMs' ~ '^[0-9]+$'
      THEN (i.request->'entryPricingTelemetry'->>'checkedAtMs')::bigint
        - (i.request->'entryPricingTelemetry'->>'calculatedAtMs')::bigint END AS pricing_persist_age_ms
  FROM vst_order_intents i JOIN vst_signals s ON s.source_signal_id = i.source_signal_id
  WHERE i.request->>'operation' = 'entry'
    AND s.received_at >= now() - interval '7 days'
),
transport AS (
  SELECT source_signal_id,
    max((detail->>'sizingAgeAtSubmitMs')::bigint) AS sizing_age_at_submit_ms
  FROM vst_events WHERE kind = 'vst_entry_queue_telemetry'
    AND detail->>'event' = 'entry_transport_ready'
    AND detail->>'sizingAgeAtSubmitMs' ~ '^[0-9]+$'
    AND created_at >= now() - interval '7 days'
  GROUP BY source_signal_id
)
SELECT w.hours, c.cohort, now() AS as_of,
  count(DISTINCT e.source_signal_id)::int AS attempts,
  count(DISTINCT e.source_signal_id) FILTER (WHERE e.refused)::int AS refusals,
  max(e.pricing_persist_age_ms) AS max_pricing_persist_age_ms,
  max(t.sizing_age_at_submit_ms) AS max_sizing_age_at_submit_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY t.sizing_age_at_submit_ms)
    AS p95_sizing_age_at_submit_ms
FROM windows w CROSS JOIN (VALUES ('all'),('fresh_sizing')) c(cohort)
LEFT JOIN entries e ON e.created_at >= now() - w.hours * interval '1 hour'
  AND (c.cohort = 'all' OR e.refreshed IS TRUE)
LEFT JOIN transport t ON t.source_signal_id = e.source_signal_id
GROUP BY w.hours, c.cohort ORDER BY w.hours, c.cohort`;

export async function readVstEntryHealth(pool) {
  const result = await pool.query(ENTRY_HEALTH_SQL);
  return result.rows.map((row) => ({
    ...row, hours: Number(row.hours), attempts: Number(row.attempts),
    refusals: Number(row.refusals),
    refusalPct: Number(row.attempts) > 0
      ? Number((Number(row.refusals) / Number(row.attempts) * 100).toFixed(2)) : null,
  }));
}

// Aggregated, persistent faults only. Never one alarm per transient refusal.
export function createVstEntryHealthMonitor({ pool, alert, log, clock = Date.now }) {
  let busy = false;
  let lastAlertAt = -Infinity;
  return {
    async tick() {
      if (busy) return;
      busy = true;
      try {
        const rows = await readVstEntryHealth(pool);
        log({ kind: "vst_entry_health", rows });
        const current = rows.find((row) => row.hours === 24 && row.cohort === "fresh_sizing");
        const unhealthy = current && current.attempts >= 5 &&
          current.refusals >= 3 && current.refusalPct >= 20;
        if (!unhealthy) {
          return rows;
        }
        if (alert && clock() - lastAlertAt >= 6 * 60 * 60 * 1000) {
          const prior = await pool.query(
            `SELECT max(created_at) AS alert_at FROM vst_events
             WHERE kind = 'vst_entry_queue_telemetry'
               AND detail->>'event' = 'entry_health_alert_sent'`,
          );
          const priorAt = prior.rows[0]?.alert_at;
          if (priorAt && clock() - new Date(priorAt).getTime() < 6 * 60 * 60 * 1000) {
            lastAlertAt = new Date(priorAt).getTime();
            return rows;
          }
          await alert(current);
          lastAlertAt = clock();
          await pool.query(
            `INSERT INTO vst_events (source_signal_id, kind, detail)
             SELECT source_signal_id, 'vst_entry_queue_telemetry', $1::jsonb
             FROM vst_order_intents
             WHERE request->>'entrySizingPolicy' = 'fresh-before-sign-v1'
             ORDER BY created_at DESC LIMIT 1`,
            [JSON.stringify({ event: "entry_health_alert_sent",
              attempts: current.attempts, refusals: current.refusals,
              refusalPct: current.refusalPct, windowHours: 24 })],
          );
        }
        return rows;
      } finally {
        busy = false;
      }
    },
  };
}