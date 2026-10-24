-- Independently provisioned VST-only ledger. This schema is deliberately
-- separate from btb_* PAPER tables; do not copy or replay PAPER records here.
-- Installation is a deployment/migration step, never runtime DDL.

CREATE TABLE IF NOT EXISTS vst_signals (
  source_signal_id text PRIMARY KEY,
  body jsonb NOT NULL,
  body_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'planning', 'opening', 'open', 'closed',
                      'rejected', 'error', 'unsupported', 'unknown')),
  reason text,
  received_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vst_signals_pending_idx
  ON vst_signals (received_at, source_signal_id)
  WHERE status IN ('pending', 'planning', 'opening');

CREATE TABLE IF NOT EXISTS vst_positions (
  source_signal_id text PRIMARY KEY REFERENCES vst_signals(source_signal_id),
  symbol text NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'closing', 'closed', 'error', 'unknown')),
  snapshot jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vst_positions_open_idx
  ON vst_positions (updated_at, source_signal_id)
  WHERE status IN ('open', 'closing', 'unknown');

CREATE TABLE IF NOT EXISTS vst_order_intents (
  id bigserial PRIMARY KEY,
  source_signal_id text NOT NULL REFERENCES vst_signals(source_signal_id),
  phase text NOT NULL,
  client_order_id text NOT NULL UNIQUE,
  request jsonb NOT NULL,
  state text NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared', 'submitted', 'unknown', 'reconciled', 'failed')),
  exchange_order_id text,
  outcome jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_signal_id, phase)
);

CREATE INDEX IF NOT EXISTS vst_order_intents_unresolved_idx
  ON vst_order_intents (created_at, source_signal_id)
  WHERE state IN ('prepared', 'submitted', 'unknown');

CREATE TABLE IF NOT EXISTS vst_events (
  id bigserial PRIMARY KEY,
  source_signal_id text REFERENCES vst_signals(source_signal_id),
  client_order_id text,
  kind text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  telegram_sent_at timestamptz
);

CREATE INDEX IF NOT EXISTS vst_events_signal_idx
  ON vst_events (source_signal_id, created_at DESC);

-- Legacy measurements remain immutable; indexed fallback avoids a history scan.
CREATE INDEX IF NOT EXISTS vst_events_queue_latest_idx
  ON vst_events (source_signal_id, id DESC)
  WHERE kind = 'vst_entry_queue_telemetry';
CREATE INDEX IF NOT EXISTS vst_events_queue_timing_idx
  ON vst_events (source_signal_id, id DESC)
  WHERE kind = 'vst_entry_queue_telemetry' AND detail->>'event' = 'timing';

-- Internal display metadata only, not trading evidence or notification records.
-- Two bounded slots per signal; replacing a slot must not merge stale fields.
CREATE TABLE IF NOT EXISTS vst_entry_queue_snapshots (
  source_signal_id text NOT NULL REFERENCES vst_signals(source_signal_id),
  slot text NOT NULL CHECK (slot IN ('latest', 'timing')),
  detail jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (source_signal_id, slot)
);