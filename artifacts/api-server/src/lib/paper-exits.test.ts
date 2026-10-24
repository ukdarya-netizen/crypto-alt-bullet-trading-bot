import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Decimal from "decimal.js";
import { pool } from "@workspace/db";
import { nextPaperProtection, processPaperExits } from "./paper-exits";
import { nextImpulsePaperProtection, splitImpulseQuantity } from "./paper-impulse-exits";
import { getJournalTrade } from "./journal";
import { bulletPayload } from "./bullet-test-fixture";

const entryAt = new Date("2026-09-24T00:00:00Z");
function tick(symbol: string, price: string, stop = "90", peak = "100", hours = 1) {
  return nextPaperProtection({
    entry: "100", stop, peak, price, symbol, entryAt,
    now: new Date(entryAt.getTime() + hours * 3600_000),
  });
}

test("normal v2 steps move protection but do not take profit", () => {
  assert.equal(tick("ETHUSDT", "104").stop, "90.000000000000");
  assert.equal(tick("ETHUSDT", "105").stop, "100.000000000000");
  assert.equal(tick("BTCUSDT", "101").stop, "100.000000000000");
  assert.equal(tick("ETHUSDT", "110").stop, "105.000000000000");
  assert.equal(tick("ETHUSDT", "115").stop, "105.000000000000");
  assert.equal(tick("ETHUSDT", "124").stop, "114.000000000000");
  assert.equal(tick("ETHUSDT", "124").reason, null);
});

test("stop never drops and four days do not trigger an invented closure", () => {
  assert.equal(tick("ETHUSDT", "110", "114", "124").stop, "114.000000000000");
  assert.equal(tick("ETHUSDT", "110", "114", "124").reason, "stop");
  assert.equal(tick("ETHUSDT", "89").reason, "stop");
  assert.equal(tick("ETHUSDT", "102", "90", "100", 96).reason, null);
  assert.equal(tick("ETHUSDT", "102", "90", "100", 95).reason, null);
  assert.equal(nextPaperProtection({
    entry: "100", stop: "90", peak: "100", price: "102", symbol: "ETHUSDT",
    entryAt, now: new Date(entryAt.getTime() + 96 * 3_600_000),
    legacyMaxHoldHours: 96,
  }).reason, "recorded_legacy_time_exit");
});

test("impulse allocation and independent core/runner rules use exact decimal quantities", () => {
  const split = splitImpulseQuantity("0.123456789123");
  assert.equal(split.core, "0.098765431298");
  assert.equal(split.runner, "0.024691357825");
  assert.equal(new Decimal(split.core).plus(split.runner).toFixed(12), "0.123456789123");

  const initial = nextImpulsePaperProtection({
    entry: "100", initialStop: "91", coreStop: "91", corePeak: "100",
    runnerStop: "100", runnerPeak: "100", price: "105", symbol: "ETHUSDT",
    entryAt, now: new Date(entryAt.getTime() + 3600_000),
  });
  assert.equal(initial.coreStop, "100.000000000000");
  assert.equal(initial.runnerStop, "100.000000000000");
  assert.equal(initial.coreReason, null);
  assert.equal(initial.runnerReason, null);

  const btcBreakEven = nextImpulsePaperProtection({
    entry: "100", initialStop: "90", coreStop: "90", corePeak: "100",
    runnerStop: "90", runnerPeak: "100", price: "101", symbol: "BTCUSDT",
    entryAt, now: new Date(entryAt.getTime() + 3600_000),
  });
  assert.equal(btcBreakEven.coreStop, "100.000000000000");
  const runnerBreakEven = nextImpulsePaperProtection({
    entry: "100", initialStop: "90", coreStop: "90", corePeak: "100",
    runnerStop: "100", runnerPeak: "100", price: "99", symbol: "ETHUSDT",
    entryAt, now: new Date(entryAt.getTime() + 3600_000),
  });
  assert.equal(runnerBreakEven.coreReason, null);
  assert.equal(runnerBreakEven.runnerReason, "stop");
  const coreProtectFive = nextImpulsePaperProtection({
    entry: "100", initialStop: "90", coreStop: "90", corePeak: "100",
    runnerStop: "90", runnerPeak: "100", price: "110", symbol: "ETHUSDT",
    entryAt, now: new Date(entryAt.getTime() + 3600_000),
  });
  assert.equal(coreProtectFive.coreStop, "105.000000000000");

  const coreTrailing = nextImpulsePaperProtection({
    entry: "100", initialStop: "90", coreStop: "130", corePeak: "140",
    runnerStop: "110", runnerPeak: "140", price: "129", symbol: "ETHUSDT",
    entryAt, now: new Date(entryAt.getTime() + 2 * 3600_000),
  });
  assert.equal(coreTrailing.coreReason, "trailing");
  assert.equal(coreTrailing.runnerStop, "110.000000000000");
  assert.equal(coreTrailing.runnerReason, null);
  const unconfirmedCore = nextImpulsePaperProtection({
    entry: "100", initialStop: "90", coreStop: "105", corePeak: "115",
    runnerStop: "90", runnerPeak: "115", price: "104", symbol: "ETHUSDT",
    entryAt, now: new Date(entryAt.getTime() + 2 * 3600_000),
  });
  assert.equal(unconfirmedCore.coreReason, "trailing");
  assert.equal(unconfirmedCore.runnerStop, "100.000000000000");
  const confirmedCore = nextImpulsePaperProtection({
    entry: "100", initialStop: "90", coreStop: "105", corePeak: "115",
    runnerStop: "90", runnerPeak: "115", price: "104", symbol: "ETHUSDT",
    entryAt, now: new Date(entryAt.getTime() + 2 * 3600_000),
    coreActive: false,
  });
  assert.equal(confirmedCore.runnerStop, "100.000000000000");
  const runnerTrail = nextImpulsePaperProtection({
    entry: "100", initialStop: "90", coreStop: "100", corePeak: "105",
    runnerStop: "90", runnerPeak: "100", price: "150", symbol: "ETHUSDT",
    entryAt, now: new Date(entryAt.getTime() + 2 * 3600_000),
    coreActive: false,
  });
  assert.equal(runnerTrail.runnerStop, "120.000000000000");
  assert.equal(runnerTrail.runnerReason, null);

  const nonTrailingCoreExit = nextImpulsePaperProtection({
    entry: "100", initialStop: "90", coreStop: "100", corePeak: "105",
    runnerStop: "90", runnerPeak: "105", price: "99", symbol: "ETHUSDT",
    entryAt, now: new Date(entryAt.getTime() + 2 * 3600_000),
  });
  assert.equal(nonTrailingCoreExit.coreReason, "stop");
  assert.equal(nonTrailingCoreExit.runnerStop, "100.000000000000");
  assert.equal(nonTrailingCoreExit.runnerReason, "stop");

  const coreTimeout = nextImpulsePaperProtection({
    entry: "100", initialStop: "90", coreStop: "90", corePeak: "100",
    runnerStop: "90", runnerPeak: "100", price: "102", symbol: "ETHUSDT",
    entryAt, now: new Date(entryAt.getTime() + 96 * 3600_000),
  });
  assert.equal(coreTimeout.coreReason, null);
  assert.equal(nextImpulsePaperProtection({
    entry: "100", initialStop: "90", coreStop: "90", corePeak: "100",
    runnerStop: "100", runnerPeak: "100", price: "102", symbol: "ETHUSDT",
    entryAt, now: new Date(entryAt.getTime() + 96 * 3_600_000),
    coreMaxHoldHours: 96,
  }).coreReason, "recorded_legacy_time_exit");
  assert.equal(coreTimeout.runnerStop, "100.000000000000");

  const runnerTimeout = nextImpulsePaperProtection({
    entry: "100", initialStop: "90", coreStop: "100", corePeak: "105",
    runnerStop: "90", runnerPeak: "105", price: "102", symbol: "ETHUSDT",
    entryAt, now: new Date(entryAt.getTime() + 120 * 3600_000),
    coreActive: false, runnerActive: true,
  });
  assert.equal(runnerTimeout.coreReason, null);
  assert.equal(runnerTimeout.runnerReason, "runner_five_day");
});

test("automatic stop creates one linked full close and releases the reserve", async (t) => {
  const controls = await pool.query<{ mode: string }>("SELECT mode FROM trading_controls WHERE id = 1");
  if (controls.rows[0]?.mode !== "paper") {
    t.skip("Integration check requires paper mode.");
    return;
  }
  const entryId = randomUUID();
  const entrySignalId = randomUUID();
  const sourceId = `paper-exit-test-${entryId}`;
  try {
    await pool.query(`
      INSERT INTO trading_signals
        (id, source_signal_id, confirmation_status, pattern_id, pattern_status,
         symbol, side, order_type, quantity, limit_price, stop_loss,
         reduce_only, status, raw_payload)
      VALUES ($1, $2, 'confirmed', 'balanced_grind', 'approved',
              'TESTUSDT', 'buy', 'market', 1, 100, 90, false, 'executed', $3)
    `, [entrySignalId, sourceId, JSON.stringify({ ...bulletPayload(), relay: {
      side: "buy", orderType: "market", reduceOnly: false,
    }, relayContractVerified: true })]);
    await pool.query(`
      INSERT INTO trading_orders
        (id, signal_id, symbol, side, order_type, status, quantity,
         filled_quantity, average_price, stop_loss, protection_status, raw_response)
      VALUES ($1, $2, 'TESTUSDT', 'buy', 'market', 'simulated_filled',
              1, 1, 100, 90, 'simulated', '{"mode":"paper"}')
    `, [entryId, entrySignalId]);
    const quote = async () => new Decimal("89");
    await processPaperExits(quote, new Date(), entryId);
    await processPaperExits(quote, new Date(), entryId);
    const fills = await pool.query<{ filled_quantity: string; average_price: string }>(`
      SELECT filled_quantity, average_price FROM trading_orders
      WHERE paper_entry_order_id = $1 AND status = 'simulated_filled'
    `, [entryId]);
    assert.equal(fills.rowCount, 1);
    assert.equal(Number(fills.rows[0].filled_quantity), 1);
    assert.equal(Number(fills.rows[0].average_price), 89);
    const balance = await pool.query<{ open_count: string; gross: string }>(`
      SELECT (CASE WHEN 1 - SUM(o.filled_quantity) > 0 THEN 1 ELSE 0 END)::text AS open_count,
        SUM((o.average_price - 100) * o.filled_quantity)::text AS gross
      FROM trading_orders o WHERE o.paper_entry_order_id = $1
    `, [entryId]);
    assert.equal(balance.rows[0].open_count, "0");
    assert.equal(Number(balance.rows[0].gross), -11);
    assert.equal(100 + Number(balance.rows[0].gross) - 10 * Number(balance.rows[0].open_count), 89);
  } finally {
    await pool.query(`DELETE FROM trading_audit_events WHERE signal_id IN
      (SELECT id FROM trading_signals WHERE source_signal_id = $1 OR source_signal_id = $2)`,
    [sourceId, `paper-auto-exit:${entryId}`]);
    await pool.query("DELETE FROM trading_orders WHERE paper_entry_order_id = $1", [entryId]);
    await pool.query("DELETE FROM trading_orders WHERE id = $1", [entryId]);
    await pool.query("DELETE FROM trading_signals WHERE source_signal_id = $1", [`paper-auto-exit:${entryId}`]);
    await pool.query("DELETE FROM trading_signals WHERE id = $1", [entrySignalId]);
  }
});

test("a pre-change filled v2 entry keeps its recorded stop and gets one visible transition audit", async (t) => {
  const controls = await pool.query<{ mode: string }>("SELECT mode FROM trading_controls WHERE id = 1");
  if (controls.rows[0]?.mode !== "paper") {
    t.skip("Integration check requires paper mode.");
    return;
  }
  const id = randomUUID();
  const signalId = randomUUID();
  const source = `pre-change-paper-${id}`;
  const exitSource = `paper-auto-exit:${id}`;
  try {
    await pool.query(`INSERT INTO trading_signals
      (id, source_signal_id, confirmation_status, pattern_id, pattern_status,
       symbol, side, order_type, quantity, limit_price, stop_loss, reduce_only, status, raw_payload)
      VALUES ($1, $2, 'confirmed', 'balanced_grind', 'approved', 'TESTUSDT',
              'buy', 'market', 1, 100, 90, false, 'executed', $3)`,
    [signalId, source, JSON.stringify({
      direction: "LONG", stopLoss: "90", rulesVersion: "bullet-long-exits-v2",
      exitRules: { breakEvenAtPercent: 5, btcBreakEvenAtPercent: 1,
        protectFiveAtPercent: 10, trailAtPercent: 15,
        trailDistancePercentagePoints: 10, maxHoldHours: 96 },
    })]);
    await pool.query(`INSERT INTO trading_orders
      (id, signal_id, symbol, side, order_type, status, quantity,
       filled_quantity, average_price, stop_loss, protection_status, raw_response)
      VALUES ($1, $2, 'TESTUSDT', 'buy', 'market', 'simulated_filled',
              1, 1, 100, 90, 'simulated', '{"mode":"paper"}')`, [id, signalId]);
    const quote = async () => new Decimal("89");
    await processPaperExits(quote, new Date(), id);
    await processPaperExits(quote, new Date(), id);
    const audits = await pool.query<{ event_type: string }>(
      "SELECT event_type FROM trading_audit_events WHERE signal_id = $1", [signalId]);
    assert.deepEqual(audits.rows.map((row) => row.event_type), ["legacy_paper_policy_retained"]);
    const closes = await pool.query<{ filled_quantity: string }>(
      "SELECT filled_quantity FROM trading_orders WHERE paper_entry_order_id = $1", [id]);
    assert.equal(closes.rows.length, 1);
    assert.equal(Number(closes.rows[0].filled_quantity), 1);
  } finally {
    await pool.query(`DELETE FROM trading_audit_events WHERE signal_id IN
      (SELECT id FROM trading_signals WHERE source_signal_id IN ($1, $2))`, [source, exitSource]);
    await pool.query("DELETE FROM trading_orders WHERE paper_entry_order_id = $1", [id]);
    await pool.query("DELETE FROM trading_orders WHERE id = $1", [id]);
    await pool.query("DELETE FROM trading_signals WHERE source_signal_id = $1", [exitSource]);
    await pool.query("DELETE FROM trading_signals WHERE id = $1", [signalId]);
  }
});

test("impulse core and runner close as idempotent linked paper fills", async (t) => {
  const controls = await pool.query<{ mode: string }>("SELECT mode FROM trading_controls WHERE id = 1");
  if (controls.rows[0]?.mode !== "paper") {
    t.skip("Integration check requires paper mode.");
    return;
  }
  const entryId = randomUUID();
  const entrySignalId = randomUUID();
  const sourceId = `paper-impulse-exit-test-${entryId}`;
  const coreSourceId = `paper-auto-exit:${entryId}:impulse-core`;
  const runnerSourceId = `paper-auto-exit:${entryId}:impulse-runner`;
  const now = new Date(Date.now() + 2_000);
  try {
    await pool.query(`
      INSERT INTO trading_signals
        (id, source_signal_id, confirmation_status, pattern_id, pattern_status,
         symbol, side, order_type, quantity, limit_price, stop_loss,
         reduce_only, status, raw_payload)
      VALUES ($1, $2, 'confirmed', 'impulse_buy', 'approved',
              'TESTUSDT', 'buy', 'market', 1, 100, 90, false, 'executed', $3)
    `, [entrySignalId, sourceId, JSON.stringify({ ...bulletPayload(true), relay: {
      side: "buy", orderType: "market", reduceOnly: false,
    }, relayContractVerified: true })]);
    await pool.query(`
      INSERT INTO trading_orders
        (id, signal_id, symbol, side, order_type, status, quantity,
         filled_quantity, average_price, stop_loss, protection_status, raw_response)
      VALUES ($1, $2, 'TESTUSDT', 'buy', 'market', 'simulated_filled',
              1, 1, 100, 90, 'simulated', '{"mode":"paper"}')
    `, [entryId, entrySignalId]);

    await processPaperExits(async () => { throw new Error("quote unavailable"); }, now, entryId);
    const noQuoteFills = await pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM trading_orders
      WHERE paper_entry_order_id = $1 AND status = 'simulated_filled'
    `, [entryId]);
    assert.equal(noQuoteFills.rows[0].count, "0");

    await processPaperExits(async () => new Decimal("140"), now, entryId);
    await processPaperExits(async () => new Decimal("129"), now, entryId);
    await processPaperExits(async () => new Decimal("129"), now, entryId);
    const coreOnly = await pool.query<{ quantity: string }>(`
      SELECT COALESCE(SUM(filled_quantity), 0)::text AS quantity
      FROM trading_orders WHERE paper_entry_order_id = $1 AND status = 'simulated_filled'
    `, [entryId]);
    assert.equal(coreOnly.rows[0].quantity, "0.800000000000");
    const partialJournal = await getJournalTrade(entryId);
    assert.equal(partialJournal?.status, "open");
    assert.equal(partialJournal?.quantity, "0.2");
    assert.equal(partialJournal?.exitPrice, "129");

    await processPaperExits(async () => new Decimal("109"), now, entryId);
    await processPaperExits(async () => new Decimal("109"), now, entryId);
    const fills = await pool.query<{ source_signal_id: string; filled_quantity: string }>(`
      SELECT s.source_signal_id, o.filled_quantity::text
      FROM trading_orders o JOIN trading_signals s ON s.id = o.signal_id
      WHERE o.paper_entry_order_id = $1 AND o.status = 'simulated_filled'
      ORDER BY s.source_signal_id
    `, [entryId]);
    assert.equal(fills.rowCount, 2);
    assert.deepEqual(new Set(fills.rows.map((fill) => fill.source_signal_id)),
      new Set([coreSourceId, runnerSourceId]));
    assert.equal(new Decimal(fills.rows[0].filled_quantity)
      .plus(fills.rows[1].filled_quantity).toFixed(12), "1.000000000000");

    const journal = await getJournalTrade(entryId);
    assert.equal(journal?.status, "closed");
    assert.equal(journal?.exitPrice, "125");
    assert.equal(journal?.grossPnl, "25.00000000");
  } finally {
    const childSignals = await pool.query<{ id: string }>(`
      SELECT id FROM trading_signals WHERE source_signal_id = ANY($1::text[])
    `, [[sourceId, coreSourceId, runnerSourceId]]);
    const signalIds = childSignals.rows.map((row) => row.id);
    if (signalIds.length) {
      await pool.query("DELETE FROM trading_audit_events WHERE signal_id = ANY($1::uuid[])", [signalIds]);
    }
    await pool.query("DELETE FROM trading_orders WHERE paper_entry_order_id = $1", [entryId]);
    await pool.query("DELETE FROM trading_orders WHERE id = $1", [entryId]);
    if (signalIds.length) {
      await pool.query("DELETE FROM trading_signals WHERE id = ANY($1::uuid[])", [signalIds]);
    }
  }
});

test("an unallocated manual partial close blocks impulse automation with one audit record", async (t) => {
  const controls = await pool.query<{ mode: string }>("SELECT mode FROM trading_controls WHERE id = 1");
  if (controls.rows[0]?.mode !== "paper") {
    t.skip("Integration check requires paper mode.");
    return;
  }
  const entryId = randomUUID();
  const entrySignalId = randomUUID();
  const manualSignalId = randomUUID();
  const sourceId = `paper-impulse-block-test-${entryId}`;
  const manualSourceId = `manual-impulse-partial:${entryId}`;
  const now = new Date(Date.now() + 2_000);
  try {
    const payload = JSON.stringify({ ...bulletPayload(true), relay: {
      side: "buy", orderType: "market", reduceOnly: false,
    }, relayContractVerified: true });
    await pool.query(`
      INSERT INTO trading_signals
        (id, source_signal_id, confirmation_status, pattern_id, pattern_status,
         symbol, side, order_type, quantity, limit_price, stop_loss,
         reduce_only, status, raw_payload)
      VALUES ($1, $2, 'confirmed', 'impulse_buy', 'approved',
              'TESTUSDT', 'buy', 'market', 1, 100, 90, false, 'executed', $3)
    `, [entrySignalId, sourceId, payload]);
    await pool.query(`
      INSERT INTO trading_orders
        (id, signal_id, symbol, side, order_type, status, quantity,
         filled_quantity, average_price, stop_loss, protection_status, raw_response)
      VALUES ($1, $2, 'TESTUSDT', 'buy', 'market', 'simulated_filled',
              1, 1, 100, 90, 'simulated', '{"mode":"paper"}')
    `, [entryId, entrySignalId]);
    await pool.query(`
      INSERT INTO trading_signals
        (id, source_signal_id, confirmation_status, pattern_id, pattern_status,
         symbol, signal_at, reference_price, side, order_type, quantity, limit_price,
         reduce_only, status, processed_at, raw_payload)
      VALUES ($1, $2, 'confirmed', 'owner_manual_close', 'approved', 'TESTUSDT',
              $3, 100, 'sell', 'market', 0.2, 100, true, 'executed', NOW(), $4)
    `, [manualSignalId, manualSourceId, now, JSON.stringify({ entryOrderId: entryId })]);
    await pool.query(`
      INSERT INTO trading_orders
        (id, signal_id, exchange_order_id, symbol, side, order_type, status,
         quantity, filled_quantity, average_price, protection_status, raw_response, paper_entry_order_id)
      VALUES ($1, $1, $2, 'TESTUSDT', 'sell', 'market', 'simulated_filled',
              0.2, 0.2, 100, 'not_required', '{"mode":"paper"}', $3)
    `, [manualSignalId, `paper-${manualSignalId}`, entryId]);

    await processPaperExits(async () => new Decimal("140"), now, entryId);
    await processPaperExits(async () => new Decimal("140"), now, entryId);
    const result = await pool.query<{ blocked: string | null; fills: string; audits: string }>(`
      SELECT entry.raw_response->>'impulseExitBlocked' AS blocked,
        (SELECT COUNT(*)::text FROM trading_orders
          WHERE paper_entry_order_id = entry.id AND status = 'simulated_filled') AS fills,
        (SELECT COUNT(*)::text FROM trading_audit_events
          WHERE signal_id = $2 AND event_type = 'paper_auto_exit_blocked') AS audits
      FROM trading_orders entry WHERE entry.id = $1
    `, [entryId, entrySignalId]);
    assert.equal(result.rows[0].blocked, "true");
    assert.equal(result.rows[0].fills, "1");
    assert.equal(result.rows[0].audits, "1");
    const blockedJournal = await getJournalTrade(entryId);
    assert.equal(blockedJournal?.status, "open");
    assert.equal(blockedJournal?.protectionStatus, "paper_auto_exit_blocked");
  } finally {
    const signals = await pool.query<{ id: string }>(`
      SELECT id FROM trading_signals WHERE source_signal_id = ANY($1::text[])
    `, [[sourceId, manualSourceId]]);
    const signalIds = signals.rows.map((row) => row.id);
    if (signalIds.length) {
      await pool.query("DELETE FROM trading_audit_events WHERE signal_id = ANY($1::uuid[])", [signalIds]);
    }
    await pool.query("DELETE FROM trading_orders WHERE paper_entry_order_id = $1", [entryId]);
    await pool.query("DELETE FROM trading_orders WHERE id = $1", [entryId]);
    if (signalIds.length) {
      await pool.query("DELETE FROM trading_signals WHERE id = ANY($1::uuid[])", [signalIds]);
    }
  }
});