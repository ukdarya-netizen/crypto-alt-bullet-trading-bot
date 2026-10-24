# Compact entry-queue measurements

Apply the additive schema before starting the new writer. The SQL file is an
explicit development migration; production schema changes go through Publish.
No application-startup DDL, cleanup, backfill, or evidence deletion is required.
The Drizzle schema also declares the table and both indexes for managed schema
updates.

The migration's concurrent index statements must run individually, outside a
transaction. On a large live ledger, check that both indexes are valid before
switching code. Stop the previous worker before switching writers: the legacy
worker still appends event measurements, whereas the new worker replaces compact
snapshots. Do not operate both versions concurrently.

Each signal has at most two measurement slots, independent of retry count:
latest preparation state and latest execution timing. Payloads replace the
entire slot, never merge old fields. Missing durations stay unknown. A preparation
retry keeps the previous execution timing, just as the prior reader did. A new
timing record lacking execution duration replaces an old known duration with
unknown. Old event measurements remain readable with partial indexes; nothing
touches trading events, order intents, fills, position snapshots, or Telegram
delivery state.

The queue query counts all eligible signals, pages the first 100, then enriches
only those rows. It uses compact slots when present and legacy fallback only
when a slot is absent. Receipt age still comes exclusively from received_at,
never from source times or snapshot timestamps.

## Repeatable verification

```sh
VST_QUEUE_DB_TEST=1 node --test \
  artifacts/api-server/src/lib/vst-entry-queue-storage.test.mjs
```

Requires the development DATABASE_URL. The fixture creates an isolated schema
inside a transaction and rolls it back even on failure. It generates one million
events and checks real store writes, bounded row count after 1,000 retries,
legacy transition, absent durations/receipt times, total/page behavior,
position/terminal exclusions, unchanged evidence and notification state.

On the development database, the same queue reader without the new partial
indexes took 19,834 ms and touched 2,433,477 event buffers. With both indexes and
legacy fallback it took 2.291 ms and touched 379 event buffers. These are fixture
measurements, not a production latency guarantee. The test asserts indexed
plans and a greater-than-20-fold event-buffer reduction, not a machine-specific
wall-clock threshold.