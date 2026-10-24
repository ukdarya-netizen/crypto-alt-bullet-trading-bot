import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Decimal from "decimal.js";
import { pool } from "@workspace/db";
import { getJournalTrade, journalOverview } from "./journal";
import { closePaperPosition, PaperCloseError } from "./manual-paper-close";
import { ensureTradingControls } from "./trading-store";

test("a manual paper close is owner-supplied, idempotent and frees the allocation", async (t) => {
  const controls = await ensureTradingControls();
  if (!controls.killSwitchActive || controls.acceptingNewEntries) {
    t.skip("Integration test requires paused entries; do not change trading controls.");
    return;
  }
  const entryId = randomUUID();
  const signalId = randomUUID();
  const requestId = randomUUID();
  const sourceId = `manual-close-test-${signalId}`;
  try {
    await pool.query(
      `INSERT INTO trading_signals (id, source_signal_id, symbol, side, order_type,
        quantity, limit_price, reduce_only, status)
       VALUES ($1, $2, 'BTCUSDT', 'buy', 'limit', 1, 10, false, 'executed')`,
      [signalId, sourceId],
    );
    await pool.query(
      `INSERT INTO trading_orders (id, signal_id, exchange_order_id, symbol, side,
        order_type, status, quantity, filled_quantity, average_price, protection_status)
       VALUES ($1, $2, $3, 'BTCUSDT', 'buy', 'limit', 'simulated_filled', 1, 1, 10, 'simulated')`,
      [entryId, signalId, `paper-${entryId}`],
    );
    const before = await journalOverview();
    await assert.rejects(closePaperPosition(entryId, "0", randomUUID(), "test-owner"),
      (error: unknown) => error instanceof PaperCloseError && error.code === "INVALID_PAPER_EXIT_PRICE");
    await Promise.all([
      closePaperPosition(entryId, "12", requestId, "test-owner"),
      closePaperPosition(entryId, "12", requestId, "test-owner"),
    ]);
    const closed = await getJournalTrade(entryId);
    assert.equal(closed?.status, "closed");
    assert.equal(closed?.environment, "paper");
    assert.equal(closed?.exitPrice, "12");
    assert.equal(closed?.grossPnl, "2.00000000");
    const after = await journalOverview();
    assert.equal(new Decimal(after.paperReserved).minus(before.paperReserved).toString(), "-10");
    assert.equal(new Decimal(after.paperAvailable).minus(before.paperAvailable).toString(), "12");
    const exits = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM trading_orders WHERE paper_entry_order_id = $1", [entryId],
    );
    assert.equal(exits.rows[0].count, "1");
    await assert.rejects(closePaperPosition(entryId, "13", randomUUID(), "test-owner"),
      (error: unknown) => error instanceof PaperCloseError && error.code === "PAPER_POSITION_ALREADY_CLOSED");
  } finally {
    const ids = await pool.query<{ id: string }>(
      "SELECT id FROM trading_signals WHERE source_signal_id IN ($1, $2)",
      [sourceId, `owner-paper-close:${requestId}`],
    );
    const signalIds = ids.rows.map((row) => row.id);
    if (signalIds.length) {
      await pool.query("DELETE FROM trading_audit_events WHERE signal_id = ANY($1::uuid[])", [signalIds]);
      await pool.query("DELETE FROM trading_orders WHERE paper_entry_order_id = $1", [entryId]);
      await pool.query("DELETE FROM trading_orders WHERE id = $1", [entryId]);
      await pool.query("DELETE FROM trading_signals WHERE id = ANY($1::uuid[])", [signalIds]);
    }
  }
});