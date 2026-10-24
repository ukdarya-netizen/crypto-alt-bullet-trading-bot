-- Add the normalized immutable fill identity ledger and idempotent observation
-- key. Both additions preserve existing archive rows and are safe to rerun.
BEGIN;

CREATE TABLE IF NOT EXISTS vst_fill_archive_fills (
  environment text NOT NULL DEFAULT 'vst',
  account_id text NOT NULL,
  currency text NOT NULL DEFAULT 'USDT',
  symbol text NOT NULL,
  trade_id text NOT NULL,
  raw_fill jsonb NOT NULL,
  CONSTRAINT vst_fill_archive_fills_environment_check CHECK (environment = 'vst'),
  CONSTRAINT vst_fill_archive_fills_currency_check CHECK (currency = 'USDT'),
  CONSTRAINT vst_fill_archive_fills_symbol_check CHECK (symbol ~ '^[A-Z0-9]+-USDT$'),
  CONSTRAINT vst_fill_archive_fills_identity_key
    UNIQUE (environment, account_id, currency, symbol, trade_id)
);

-- Fail rather than choosing arbitrarily if older archive rows disagree about
-- an identity; then seed the identity ledger from their original raw rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM vst_fill_archive_windows AS windows
    CROSS JOIN LATERAL jsonb_array_elements(windows.archive_window->'rawFills') AS item(raw_fill)
    WHERE windows.environment = 'vst' AND windows.currency = 'USDT'
    GROUP BY windows.account_id, item.raw_fill->>'symbol', item.raw_fill->>'tradeId'
    HAVING count(DISTINCT item.raw_fill) > 1
  ) THEN
    RAISE EXCEPTION 'vst_fill_archive_existing_identity_conflict';
  END IF;
END
$$;

INSERT INTO vst_fill_archive_fills
  (environment, account_id, currency, symbol, trade_id, raw_fill)
SELECT DISTINCT ON (
    windows.account_id, item.raw_fill->>'symbol', item.raw_fill->>'tradeId'
  )
  'vst', windows.account_id, 'USDT', item.raw_fill->>'symbol',
  item.raw_fill->>'tradeId', item.raw_fill
FROM vst_fill_archive_windows AS windows
CROSS JOIN LATERAL jsonb_array_elements(windows.archive_window->'rawFills') AS item(raw_fill)
WHERE windows.environment = 'vst' AND windows.currency = 'USDT'
ORDER BY windows.account_id, item.raw_fill->>'symbol', item.raw_fill->>'tradeId',
         windows.observed_at, windows.id
ON CONFLICT (environment, account_id, currency, symbol, trade_id) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS vst_fill_archive_windows_observation_idx
  ON vst_fill_archive_windows
    (environment, account_id, currency, start_ts, end_ts, window_hash, observed_at);

COMMIT;