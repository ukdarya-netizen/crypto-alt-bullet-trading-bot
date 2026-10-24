-- Install separately for the LIVE ledger. This schema is isolated from the
-- PAPER ledger: it intentionally performs no copy, migration, or replay.
-- The kill switch is persisted in the blocked state on first installation.

CREATE TABLE IF NOT EXISTS btb_live_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton = true),
  kill_switch_on boolean NOT NULL DEFAULT true,
  blocked_reason text NOT NULL DEFAULT 'Live execution is disabled by default',
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO btb_live_control (singleton, kill_switch_on, blocked_reason)
VALUES (true, true, 'Live execution is disabled by default')
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS btb_live_baseline (
  account_id text NOT NULL,
  environment text NOT NULL,
  initial_usdt numeric(30, 12) NOT NULL CHECK (initial_usdt > 0),
  started_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, environment)
);

CREATE TABLE IF NOT EXISTS btb_live_signals (
  account_id text NOT NULL,
  environment text NOT NULL,
  signal_id text NOT NULL,
  body jsonb NOT NULL,
  body_hash text NOT NULL,
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'planned', 'rejected')),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, environment, signal_id)
);

CREATE INDEX IF NOT EXISTS btb_live_signals_account_received_idx
  ON btb_live_signals (account_id, environment, received_at DESC);

CREATE TABLE IF NOT EXISTS btb_live_allocations (
  account_id text NOT NULL,
  environment text NOT NULL,
  signal_id text NOT NULL,
  initial_margin_usdt numeric(30, 12) NOT NULL CHECK (initial_margin_usdt > 0),
  initial_deposit_usdt numeric(30, 12) NOT NULL CHECK (initial_deposit_usdt > 0),
  allocated_percent numeric(30, 12) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, environment, signal_id),
  FOREIGN KEY (account_id, environment, signal_id)
    REFERENCES btb_live_signals (account_id, environment, signal_id)
);

CREATE TABLE IF NOT EXISTS btb_live_funding (
  account_id text NOT NULL,
  environment text NOT NULL,
  signal_id text NOT NULL,
  exchange_transaction_id text NOT NULL,
  amount_usdt numeric(30, 12) NOT NULL,
  settled_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, environment, exchange_transaction_id),
  FOREIGN KEY (account_id, environment, signal_id)
    REFERENCES btb_live_signals (account_id, environment, signal_id)
);

CREATE TABLE IF NOT EXISTS btb_live_funding_coverage (
  account_id text NOT NULL,
  environment text NOT NULL,
  signal_id text NOT NULL,
  covered_through timestamptz NOT NULL,
  PRIMARY KEY (account_id, environment, signal_id),
  FOREIGN KEY (account_id, environment, signal_id)
    REFERENCES btb_live_signals (account_id, environment, signal_id)
);

CREATE TABLE IF NOT EXISTS btb_live_order_intents (
  id bigserial PRIMARY KEY,
  account_id text NOT NULL,
  environment text NOT NULL,
  signal_id text NOT NULL,
  phase text NOT NULL,
  client_order_id text NOT NULL UNIQUE,
  request jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'submitted', 'unknown', 'reconciled')),
  exchange_order_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, environment, client_order_id),
  FOREIGN KEY (account_id, environment, signal_id)
    REFERENCES btb_live_signals (account_id, environment, signal_id)
);

CREATE INDEX IF NOT EXISTS btb_live_order_intents_state_idx
  ON btb_live_order_intents (account_id, environment, state, created_at);

CREATE TABLE IF NOT EXISTS btb_live_order_attempts (
  id bigserial PRIMARY KEY,
  account_id text NOT NULL,
  environment text NOT NULL,
  client_order_id text NOT NULL,
  attempt_number numeric(10, 0) NOT NULL,
  state text NOT NULL DEFAULT 'started'
    CHECK (state IN ('started', 'pending', 'submitted', 'unknown', 'reconciled')),
  request jsonb NOT NULL DEFAULT '{}'::jsonb,
  response jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (account_id, environment, client_order_id, attempt_number),
  FOREIGN KEY (account_id, environment, client_order_id)
    REFERENCES btb_live_order_intents (account_id, environment, client_order_id)
);

CREATE INDEX IF NOT EXISTS btb_live_order_attempts_intent_idx
  ON btb_live_order_attempts (account_id, environment, client_order_id, started_at);

CREATE TABLE IF NOT EXISTS btb_live_fills (
  id bigserial PRIMARY KEY,
  account_id text NOT NULL,
  environment text NOT NULL,
  exchange_fill_id text NOT NULL,
  client_order_id text NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL,
  quantity numeric(30, 12) NOT NULL CHECK (quantity > 0),
  price numeric(30, 12) NOT NULL CHECK (price > 0),
  fee numeric(30, 12),
  fee_asset text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  filled_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, environment, exchange_fill_id),
  FOREIGN KEY (account_id, environment, client_order_id)
    REFERENCES btb_live_order_intents (account_id, environment, client_order_id)
);

CREATE INDEX IF NOT EXISTS btb_live_fills_account_time_idx
  ON btb_live_fills (account_id, environment, filled_at DESC);

CREATE TABLE IF NOT EXISTS btb_live_position_snapshots (
  id bigserial PRIMARY KEY,
  account_id text NOT NULL,
  environment text NOT NULL,
  signal_id text NOT NULL,
  symbol text NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'opening', 'closing', 'closed')),
  quantity numeric(30, 12) NOT NULL,
  entry_price numeric(30, 12),
  mark_price numeric(30, 12),
  unrealized_pnl numeric(30, 12),
  snapshot jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, environment, signal_id)
);

CREATE INDEX IF NOT EXISTS btb_live_position_snapshots_account_symbol_time_idx
  ON btb_live_position_snapshots (account_id, environment, symbol, captured_at DESC);

CREATE TABLE IF NOT EXISTS btb_live_events (
  id bigserial PRIMARY KEY,
  account_id text,
  environment text,
  signal_id text,
  client_order_id text,
  kind text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS btb_live_events_scope_created_idx
  ON btb_live_events (account_id, environment, created_at DESC);

CREATE INDEX IF NOT EXISTS btb_live_events_signal_idx
  ON btb_live_events (account_id, environment, signal_id, created_at DESC);