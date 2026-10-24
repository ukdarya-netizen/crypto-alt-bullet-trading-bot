import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { pool } from "@workspace/db";

export class PaperCloseError extends Error {
  constructor(public readonly status: 400 | 404 | 409, public readonly code: string) {
    super(code);
  }
}

async function getClient() {
  return pool.connect();
}
type CloseClient = Awaited<ReturnType<typeof getClient>>;
type Entry = {
  id: string; symbol: string; side: string; status: string;
  filled_quantity: string | null; average_price: string | null;
  paper_entry_order_id: string | null; reduce_only: boolean;
};

/** An owner-authorized PAPER close, never an exchange order. */
export async function closePaperPosition(
  entryId: string,
  requestedPrice: string,
  requestId: string,
  actorUserId: string,
  connect: () => Promise<CloseClient> = getClient,
): Promise<void> {
  if (!/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,12})?$/.test(requestedPrice)) {
    throw new PaperCloseError(400, "INVALID_PAPER_EXIT_PRICE");
  }
  const price = new Decimal(requestedPrice);
  if (!price.isFinite() || price.lte(0)) {
    throw new PaperCloseError(400, "INVALID_PAPER_EXIT_PRICE");
  }
  const sourceId = `owner-paper-close:${requestId}`;
  const client = await connect();
  try {
    await client.query("BEGIN");
    // Same lock order as the paper executor: controls first, entry second.
    // A kill switch prevents entries, not the owner's ability to reduce risk.
    const control = await client.query("SELECT id FROM trading_controls WHERE id = 1 FOR UPDATE");
    if (!control.rowCount) throw new Error("Trading controls are unavailable.");
    const found = await client.query<Entry>(
      `SELECT entry.id, entry.symbol, entry.side, entry.status, entry.filled_quantity,
              entry.average_price, entry.paper_entry_order_id, signal.reduce_only
       FROM trading_orders entry
       JOIN trading_signals signal ON signal.id = entry.signal_id
       WHERE entry.id = $1 FOR UPDATE OF entry`,
      [entryId],
    );
    const entry = found.rows[0];
    if (!entry) throw new PaperCloseError(404, "TRADE_NOT_FOUND");
    if (entry.status !== "simulated_filled" || entry.paper_entry_order_id ||
        entry.reduce_only || !entry.symbol.endsWith("USDT") ||
        !["buy", "sell"].includes(entry.side) ||
        !entry.average_price || !entry.filled_quantity ||
        new Decimal(entry.filled_quantity).lte(0) || new Decimal(entry.average_price).lte(0)) {
      throw new PaperCloseError(409, "NOT_OPEN_PAPER_POSITION");
    }

    const prior = await client.query<{
      id: string; raw_payload: { entryOrderId?: string; exitPrice?: string } | null;
    }>("SELECT id, raw_payload FROM trading_signals WHERE source_signal_id = $1", [sourceId]);
    if (prior.rows.length) {
      const priorSignal = prior.rows[0];
      const priorExit = await client.query<{ id: string }>(
        `SELECT id FROM trading_orders WHERE signal_id = $1 AND paper_entry_order_id = $2
         AND status = 'simulated_filled'`,
        [priorSignal.id, entryId],
      );
      if (priorSignal.raw_payload?.entryOrderId !== entryId ||
          !priorSignal.raw_payload?.exitPrice ||
          !new Decimal(priorSignal.raw_payload.exitPrice).eq(price) ||
          priorExit.rows.length !== 1) {
        throw new PaperCloseError(409, "PAPER_CLOSE_REQUEST_CONFLICT");
      }
      await client.query("COMMIT");
      return;
    }

    const exits = await client.query<{
      symbol: string; side: string; filled_quantity: string | null;
      average_price: string | null; reduce_only: boolean;
    }>(
      `SELECT closed.symbol, closed.side, closed.filled_quantity, closed.average_price,
              close_signal.reduce_only
       FROM trading_orders closed
       JOIN trading_signals close_signal ON close_signal.id = closed.signal_id
       WHERE closed.paper_entry_order_id = $1 AND closed.status = 'simulated_filled'`,
      [entryId],
    );
    let remaining = new Decimal(entry.filled_quantity);
    for (const exit of exits.rows) {
      if (!exit.reduce_only || exit.symbol !== entry.symbol || exit.side === entry.side ||
          !exit.filled_quantity || !exit.average_price ||
          new Decimal(exit.filled_quantity).lte(0) || new Decimal(exit.average_price).lte(0)) {
        throw new Error("Existing paper closes cannot be verified.");
      }
      remaining = remaining.minus(exit.filled_quantity);
    }
    if (remaining.lte(0)) throw new PaperCloseError(409, "PAPER_POSITION_ALREADY_CLOSED");
    const signalId = randomUUID();
    const exitSide = entry.side === "buy" ? "sell" : "buy";
    await client.query(
      `INSERT INTO trading_signals
       (id, source_signal_id, confirmation_status, pattern_id, pattern_status,
        symbol, side, order_type, quantity, limit_price, reduce_only,
        status, processed_at, raw_payload)
       VALUES ($1, $2, 'confirmed', 'owner_manual_close', 'approved',
               $3, $4, 'market', $5, $6, true, 'executed', NOW(), $7)`,
      [signalId, sourceId, entry.symbol, exitSide, remaining.toFixed(12),
        price.toFixed(12), JSON.stringify({ entryOrderId: entryId, exitPrice: requestedPrice })],
    );
    await client.query(
      `INSERT INTO trading_orders
       (id, signal_id, exchange_order_id, symbol, side, order_type, status,
        quantity, filled_quantity, average_price, protection_status, raw_response, paper_entry_order_id)
       VALUES ($1, $1, $2, $3, $4, 'market', 'simulated_filled',
               $5, $5, $6, 'not_required', $7, $8)`,
      [signalId, `paper-${signalId}`, entry.symbol, exitSide,
        remaining.toFixed(12), price.toFixed(12),
        JSON.stringify({ mode: "paper", source: "owner_manual_close" }), entryId],
    );
    await client.query(
      `INSERT INTO trading_audit_events (signal_id, event_type, message, details)
       VALUES ($1, 'paper_manual_close', 'Owner manually closed the remaining paper position.', $2)`,
      [signalId, JSON.stringify({
        actorUserId, entryOrderId: entryId, exitPrice: requestedPrice,
        quantity: remaining.toString(), requestId,
      })],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}