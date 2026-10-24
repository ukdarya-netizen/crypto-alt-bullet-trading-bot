-- Add invalidation metadata without rewriting the immutable archived window.
BEGIN;

ALTER TABLE vst_fill_archive_windows
  ADD COLUMN IF NOT EXISTS invalidated_at timestamptz,
  ADD COLUMN IF NOT EXISTS invalidation_reason text;

COMMIT;