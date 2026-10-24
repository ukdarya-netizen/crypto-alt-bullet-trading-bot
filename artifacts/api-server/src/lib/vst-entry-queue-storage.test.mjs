import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { createVstStore } from "../bullet-bot/vst-store.mjs";
import { readVstEntryQueue } from "./vst-entry-queue.mjs";

// Explicit opt-in; all fixture data lives in a rolled-back isolated schema.
test("compact queue storage preserves evidence/unknowns and scales over a million events", {
  skip: process.env.VST_QUEUE_DB_TEST !== "1",
  timeout: 120_000,
}, async (t) => {
  const require = createRequire(new URL("../../../../lib/db/package.json", import.meta.url));
  const { Client } = require("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    const schema = `queue_test_${process.pid}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    await client.query(await readFile(new URL("../bullet-bot/vst-schema.sql", import.meta.url), "utf8"));
    // Simulate an old ledger missing receipt times without changing real tables.
    await client.query("ALTER TABLE vst_signals ALTER COLUMN received_at DROP NOT NULL");
    await client.query(`INSERT INTO vst_signals (source_signal_id, body, body_hash, received_at)
      SELECT 'signal-' || g, '{"symbol":"BTCUSDT"}', 'fixture',
             CASE WHEN g = 1 THEN NULL ELSE '2026-01-01'::timestamptz END
      FROM generate_series(1, 120) g`);
    await client.query("UPDATE vst_signals SET status = 'planning' WHERE source_signal_id = 'signal-1'");
    await client.query(`INSERT INTO vst_events (source_signal_id, kind, detail)
      SELECT 'signal-' || (1 + (g - 1) % 120),
             CASE WHEN g % 5 = 0 THEN 'entry_confirmed' ELSE 'vst_entry_queue_telemetry' END,
             CASE WHEN g <= 120 THEN '{"event":"timing","prepared":true,"executeMs":41}'::jsonb
                  ELSE '{"event":"prepared","prepared":false,"prepareMs":12}'::jsonb END
      FROM generate_series(1, 1000000) g`);
    // Measure the identical reader without the new legacy indexes, then with them.
    await client.query("DROP INDEX vst_events_queue_latest_idx, vst_events_queue_timing_idx");
    await client.query("ANALYZE vst_events");
    let sql;
    await readVstEntryQueue({ async query(statement) { sql = statement; return { rows: [] }; } });
    const explain = async () => (await client.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
    )).rows[0]["QUERY PLAN"][0];
    const baseline = await explain();
    await client.query(`CREATE INDEX vst_events_queue_latest_idx ON vst_events (source_signal_id, id DESC)
      WHERE kind = 'vst_entry_queue_telemetry'`);
    await client.query(`CREATE INDEX vst_events_queue_timing_idx ON vst_events (source_signal_id, id DESC)
      WHERE kind = 'vst_entry_queue_telemetry' AND detail->>'event' = 'timing'`);
    await client.query("ANALYZE vst_events");
    const indexed = await explain();
    const nodes = (plan) => [plan, ...(plan.Plans ?? []).flatMap(nodes)];
    const eventBuffers = (plan) => Math.max(0, ...nodes(plan.Plan)
      .filter((node) => node["Relation Name"] === "vst_events")
      .map((node) => (node["Shared Hit Blocks"] ?? 0) + (node["Shared Read Blocks"] ?? 0)));
    assert.ok(eventBuffers(indexed) < eventBuffers(baseline) / 20);
    assert.match(JSON.stringify(indexed), /vst_events_queue_latest_idx/);
    assert.match(JSON.stringify(indexed), /vst_events_queue_timing_idx/);
    t.diagnostic(JSON.stringify({
      historyRows: 1_000_000,
      baselineMs: baseline["Execution Time"], indexedMs: indexed["Execution Time"],
      baselineEventBuffers: eventBuffers(baseline), indexedEventBuffers: eventBuffers(indexed),
    }));
    const now = () => Date.parse("2026-01-01T00:01:00Z");
    const legacy = await readVstEntryQueue(client, { now });
    assert.equal(legacy.total, 120);
    assert.equal(legacy.entries.length, 100);
    assert.equal(legacy.hasMore, true);
    const entry = (queue, id) => queue.entries.find((row) => row.sourceSignalId === id);
    assert.equal(entry(legacy, "signal-1").queueWaitMs, null);
    assert.equal(entry(legacy, "signal-2").executeMs, 41);
    assert.equal(entry(legacy, "signal-5").executeMs, null);

    // Real store SQL, thousands of retries, still only two slots.
    const store = createVstStore({
      query: client.query.bind(client),
      async connect() { throw new Error("snapshot writes must use one atomic statement"); },
    });
    await store.recordEntryQueueTelemetry("signal-2", {
      event: "timing", prepared: true, executeMs: 77, prepareMs: 3, queueWaitMs: null,
    });
    for (let i = 0; i < 1000; i++) {
      await store.recordEntryQueueTelemetry("signal-2", { event: "preparing" });
    }
    assert.equal((await client.query("SELECT count(*) FROM vst_entry_queue_snapshots")).rows[0].count, "2");
    const preparing = await readVstEntryQueue(client, { now });
    assert.equal(entry(preparing, "signal-2").prepareMs, null);
    assert.equal(entry(preparing, "signal-2").executeMs, 77);
    assert.equal(entry(preparing, "signal-2").stage, "preparing");
    // A new missing duration is unknown, not a fallback to an older known value.
    await store.recordEntryQueueTelemetry("signal-2", { event: "timing", prepared: false });
    const unknown = await readVstEntryQueue(client, { now });
    assert.equal(entry(unknown, "signal-2").executeMs, null);
    assert.equal(entry(unknown, "signal-2").prepareMs, null);
    assert.equal(entry(unknown, "signal-2").stage, "preparation_failed");
    await store.recordEntryQueueTelemetry("signal-1", { event: "prepared", prepared: true });
    const transition = await readVstEntryQueue(client, { now });
    assert.equal(entry(transition, "signal-1").executeMs, 41); // legacy timing retained
    assert.equal(entry(transition, "signal-1").queueWaitMs, null);
    assert.equal((await client.query("SELECT count(*) FROM vst_events")).rows[0].count, "1000000");
    assert.equal((await client.query("SELECT count(*) FROM vst_events WHERE telegram_sent_at IS NOT NULL")).rows[0].count, "0");
    await client.query(`INSERT INTO vst_positions VALUES ('signal-2', 'BTC-USDT', 'closed', '{}', now())`);
    await client.query("UPDATE vst_signals SET status = 'closed' WHERE source_signal_id = 'signal-3'");
    assert.equal((await readVstEntryQueue(client, { now })).total, 118);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});