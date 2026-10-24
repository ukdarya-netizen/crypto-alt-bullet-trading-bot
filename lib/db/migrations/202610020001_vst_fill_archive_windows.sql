-- Additive VST-only durable archive for complete fill-history observations.
-- No existing table or data is changed.
CREATE TABLE IF NOT EXISTS vst_fill_archive_windows (
  id bigserial PRIMARY KEY,
  environment text NOT NULL DEFAULT 'vst',
  account_id text NOT NULL,
  currency text NOT NULL,
  start_ts bigint NOT NULL,
  end_ts bigint NOT NULL,
  window_hash text NOT NULL,
  archive_window jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  invalidated_at timestamptz,
  invalidation_reason text,
  CONSTRAINT vst_fill_archive_windows_environment_check CHECK (environment = 'vst'),
  CONSTRAINT vst_fill_archive_windows_currency_check CHECK (currency = 'USDT'),
  CONSTRAINT vst_fill_archive_windows_bounds_check CHECK (start_ts > 0 AND end_ts >= start_ts)
);

CREATE INDEX IF NOT EXISTS vst_fill_archive_windows_scope_range_idx
  ON vst_fill_archive_windows (account_id, currency, start_ts, end_ts);
