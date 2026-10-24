-- Apply this once to the dedicated PostgreSQL database before starting the bot.
-- The application intentionally does not create or migrate tables at startup.

CREATE TABLE IF NOT EXISTS btb_signals (
  source_signal_id text PRIMARY KEY,
  body jsonb NOT NULL,
  body_hash text NOT NULL,
  status text NOT NULL CHECK (
    status IN (
      'pending',
      'opening',
      'open',
      'closed',
      'rejected',
      'quarantined',
      'error'
    )
  ),
  reason text,
  received_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS btb_signals_worker_queue_idx
  ON btb_signals (status, received_at, source_signal_id)
  WHERE status IN ('pending', 'opening');

CREATE TABLE IF NOT EXISTS btb_positions (
  source_signal_id text PRIMARY KEY
    REFERENCES btb_signals (source_signal_id),
  snapshot jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'closing', 'closed', 'error')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS btb_positions_open_idx
  ON btb_positions (updated_at, source_signal_id)
  WHERE status IN ('open', 'closing');

CREATE TABLE IF NOT EXISTS btb_events (
  id bigserial PRIMARY KEY,
  source_signal_id text,
  kind text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  telegram_sent_at timestamptz
);

CREATE INDEX IF NOT EXISTS btb_events_signal_created_idx
  ON btb_events (source_signal_id, created_at DESC);

CREATE TABLE IF NOT EXISTS btb_paper_account (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton = true),
  initial_usdt numeric(24, 8) NOT NULL CHECK (initial_usdt >= 0),
  free_usdt numeric(24, 8) NOT NULL,
  reserved_usdt numeric(24, 8) NOT NULL CHECK (reserved_usdt >= 0),
  realized_pnl_usdt numeric(24, 8) NOT NULL DEFAULT 0
);

-- Seed only on first schema installation. Re-applying this file never resets
-- an existing paper wallet.
INSERT INTO btb_paper_account
  (singleton, initial_usdt, free_usdt, reserved_usdt, realized_pnl_usdt)
VALUES
  (true, 1000, 1000, 0, 0)
ON CONFLICT (singleton) DO NOTHING;