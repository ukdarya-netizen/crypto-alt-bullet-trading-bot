-- Apply before starting the compact-telemetry writer.
-- No backfill or deletion: old workers may be stopped before switching writers;
-- legacy measurements remain available through indexed read-only fallback.
CREATE TABLE IF NOT EXISTS vst_entry_queue_snapshots (
  source_signal_id text NOT NULL REFERENCES vst_signals(source_signal_id),
  slot text NOT NULL CHECK (slot IN ('latest', 'timing')),
  detail jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (source_signal_id, slot)
);

-- Run outside a transaction; concurrent builds do not block trading writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS vst_events_queue_latest_idx
  ON vst_events (source_signal_id, id DESC)
  WHERE kind = 'vst_entry_queue_telemetry';
CREATE INDEX CONCURRENTLY IF NOT EXISTS vst_events_queue_timing_idx
  ON vst_events (source_signal_id, id DESC)
  WHERE kind = 'vst_entry_queue_telemetry' AND detail->>'event' = 'timing';