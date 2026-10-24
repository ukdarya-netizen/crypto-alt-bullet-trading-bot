import Decimal from "decimal.js";
import { pool } from "@workspace/db";
import { approvedPatternIds, signalEligibility } from "./signal-eligibility";
import { hasExactBulletRules, PAPER_AUTO_EXIT_PATTERNS, PAPER_POSITION_RESERVE_USDT, PAPER_SIGNAL_MAX_AGE_MS, PAPER_STARTING_DEPOSIT_USDT } from "./paper-intent";

async function getClient() {
  return pool.connect();
}
export type PaperDbClient = Awaited<ReturnType<typeof getClient>>;

export type ClaimedSignal = {
  id: string;
  source_signal_id: string;
  confirmation_status: string | null;
  pattern_id: string | null;
  pattern_status: string | null;
  symbol: string;
  side: string;
  order_type: string;
  quantity: string;
  limit_price: string | null;
  stop_loss: string | null;
  take_profit: string | null;
  reduce_only: boolean;
  attempts: number;
  signal_at?: Date | null;
};

// The lease is a recovery timer, not permission to execute: attempts is a
// fencing generation. Every finalization rechecks it under a row lock.
export async function claimNextSignal(query: typeof pool.query = pool.query.bind(pool)): Promise<ClaimedSignal | null> {
  const result = await query<ClaimedSignal>(`
    WITH next_signal AS (
      SELECT id FROM trading_signals
      WHERE status = 'pending'
         OR (status = 'processing' AND lease_until < NOW())
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE trading_signals AS signal
    SET status = 'processing', attempts = signal.attempts + 1,
        lease_until = NOW() + INTERVAL '30 seconds', updated_at = NOW()
    FROM next_signal
    WHERE signal.id = next_signal.id
    RETURNING signal.id, signal.source_signal_id, signal.confirmation_status,
              signal.pattern_id, signal.pattern_status, signal.symbol, signal.side,
              signal.order_type, signal.quantity, signal.limit_price,
              signal.stop_loss, signal.take_profit, signal.reduce_only,
              signal.attempts, signal.signal_at
  `);
  return result.rows[0] ?? null;
}

type Outcome = "executed" | "rejected" | "failed" | "deferred" | "stale";
type ControlRow = {
  mode: string;
  kill_switch_active: boolean;
  accepting_new_entries: boolean;
  max_notional_per_order: string;
};
type SignalRow = {
  status: string;
  attempts: number;
  lease_until: Date | null;
  confirmation_status: string | null;
  pattern_id: string | null;
  pattern_status: string | null;
  signal_at?: Date | null;
  raw_payload?: unknown;
};

function positive(value: string | null): Decimal | null {
  if (!value) return null;
  try {
    const amount = new Decimal(value);
    return amount.isFinite() && amount.greaterThan(0) ? amount : null;
  } catch {
    return null;
  }
}

export async function finalizePaperSignal(
  signal: ClaimedSignal,
  connect: () => Promise<PaperDbClient> = getClient,
  allowlist: Set<string> = approvedPatternIds(process.env.TRADING_APPROVED_PATTERN_IDS),
): Promise<Outcome> {
  const client = await connect();
  try {
    await client.query("BEGIN");
    const controls = await client.query<ControlRow>(
      "SELECT mode, kill_switch_active, accepting_new_entries, max_notional_per_order FROM trading_controls WHERE id = 1 FOR UPDATE",
    );
    const row = await client.query<SignalRow>(
      "SELECT status, attempts, lease_until, confirmation_status, pattern_id, pattern_status, signal_at, raw_payload FROM trading_signals WHERE id = $1 FOR UPDATE",
      [signal.id],
    );
    const current = row.rows[0];
    if (!current || current.status !== "processing" ||
        current.attempts !== signal.attempts ||
        !current.lease_until || current.lease_until.getTime() <= Date.now()) {
      await client.query("COMMIT");
      return "stale";
    }

    async function terminal(
      status: "executed" | "rejected" | "failed",
      eventType: string,
      message: string,
      errorCode: string | null,
      details?: Record<string, unknown>,
    ): Promise<Outcome> {
      await client.query(
        `UPDATE trading_signals SET status = $2, error_code = $3, error_message = $4,
         processed_at = NOW(), lease_until = NULL, updated_at = NOW() WHERE id = $1`,
        [signal.id, status, errorCode, errorCode ? message : null],
      );
      await client.query(
        "INSERT INTO trading_audit_events (signal_id, event_type, message, details) VALUES ($1, $2, $3, $4)",
        [signal.id, eventType, message, details ? JSON.stringify(details) : null],
      );
      await client.query("COMMIT");
      return status;
    }

    const control = controls.rows[0];
    if (!control || control.mode !== "paper" || control.kill_switch_active ||
        !control.accepting_new_entries) {
      await client.query(
        "UPDATE trading_signals SET status = 'pending', lease_until = NULL, updated_at = NOW() WHERE id = $1",
        [signal.id],
      );
      await client.query(
        "INSERT INTO trading_audit_events (signal_id, event_type, message) VALUES ($1, 'execution_deferred', 'Safety controls changed before execution.')",
        [signal.id],
      );
      await client.query("COMMIT");
      return "deferred";
    }

    if (allowlist.size === 0) {
      await client.query(
        "UPDATE trading_signals SET status = 'pending', lease_until = NULL, updated_at = NOW() WHERE id = $1",
        [signal.id],
      );
      await client.query(
        "INSERT INTO trading_audit_events (signal_id, event_type, message) VALUES ($1, 'execution_deferred', 'Approved pattern allowlist is not configured.')",
        [signal.id],
      );
      await client.query("COMMIT");
      return "deferred";
    }
    const eligibility = signalEligibility({
      confirmationStatus: current.confirmation_status as "candidate" | "confirmed",
      patternStatus: current.pattern_status as "approved" | "experimental",
      patternId: current.pattern_id ?? "",
    }, allowlist);
    if (eligibility) {
      return terminal("rejected", "signal_rejected", "Signal is not confirmed or its pattern is not approved.", eligibility);
    }
    if (!current.signal_at || Date.now() - current.signal_at.getTime() > PAPER_SIGNAL_MAX_AGE_MS ||
        current.signal_at.getTime() - Date.now() > 30_000) {
      return terminal("rejected", "signal_rejected", "Paper signal expired before simulation.", "STALE_PAPER_SIGNAL");
    }
    if (!PAPER_AUTO_EXIT_PATTERNS.has(current.pattern_id ?? "") ||
        !hasExactBulletRules(current.raw_payload, current.pattern_id ?? "", true) ||
        !current.raw_payload || typeof current.raw_payload !== "object" ||
        (current.raw_payload as { relay?: unknown; relayContractVerified?: unknown }).relay === undefined ||
        (current.raw_payload as { relayContractVerified?: unknown }).relayContractVerified !== true) {
      return terminal("rejected", "signal_rejected", "Relay rules were not verified for paper execution.", "UNSUPPORTED_BULLET_RULES");
    }

    const existing = await client.query<{ status: string }>(
      "SELECT status FROM trading_orders WHERE signal_id = $1 FOR UPDATE",
      [signal.id],
    );
    if (existing.rows.length) {
      return existing.rows[0].status === "simulated_filled"
        ? terminal("executed", "paper_order_reconciled", "Existing paper order reconciled after recovery.", null)
        : terminal("failed", "signal_failed", "Signal already has a non-paper order.", "ORDER_ALREADY_EXISTS");
    }

    if (signal.attempts > 3) {
      return terminal("failed", "signal_failed", "Retry limit exceeded without a committed order.", "RETRY_LIMIT_EXCEEDED");
    }
    if (!signal.reduce_only && !signal.symbol.endsWith("USDT")) {
      return terminal("rejected", "signal_rejected",
        "Only USDT-quoted paper positions can use the USDT paper deposit.", "PAPER_USDT_ONLY");
    }
    if (!signal.reduce_only && !positive(signal.stop_loss)) {
      return terminal("rejected", "signal_rejected", "New positions require a stop loss.", "STOP_LOSS_REQUIRED");
    }
    const quantity = positive(signal.quantity);
    const price = positive(signal.limit_price);
    if (!quantity || !price) {
      return terminal("rejected", "signal_rejected", "Positive quantity and reference price are required.", "REFERENCE_PRICE_REQUIRED");
    }
    const notional = quantity.mul(price);
    const maxNotional = positive(control.max_notional_per_order);
    if (!maxNotional || notional.greaterThan(maxNotional)) {
      return terminal("rejected", "signal_rejected", "Order exceeds the current max notional.", "MAX_NOTIONAL_EXCEEDED", {
        notional: notional.toString(),
        maxNotional: control.max_notional_per_order,
      });
    }

    if (!signal.reduce_only) {
      // The controls row is locked for the whole transaction, serializing
      // paper entries and reductions. Recalculate from committed linked fills
      // rather than trusting an in-memory balance or the latest 100 trades.
      const ledger = await client.query<{
        realized_gross: string; open_count: string; invalid: boolean;
      }>(`
        WITH entries AS (
          SELECT entry.id, entry.symbol, entry.side, entry.filled_quantity,
                 entry.average_price,
                 COALESCE(SUM(closed.filled_quantity), 0) AS closed_quantity,
                 COALESCE(SUM(
                   (closed.average_price - entry.average_price) * closed.filled_quantity *
                   CASE WHEN entry.side = 'buy' THEN 1 ELSE -1 END
                 ), 0) AS gross,
                 COALESCE(BOOL_OR(closed.id IS NOT NULL AND
                   (closed.symbol <> entry.symbol OR closed.side = entry.side OR
                    closed.filled_quantity IS NULL OR closed.average_price IS NULL OR
                    close_signal.reduce_only IS DISTINCT FROM true)), false) AS invalid_close
          FROM trading_orders entry
          JOIN trading_signals entry_signal ON entry_signal.id = entry.signal_id
          LEFT JOIN trading_orders closed ON closed.paper_entry_order_id = entry.id
            AND closed.status = 'simulated_filled'
          LEFT JOIN trading_signals close_signal ON close_signal.id = closed.signal_id
          WHERE entry.status = 'simulated_filled'
            AND entry.paper_entry_order_id IS NULL AND entry_signal.reduce_only = false
          GROUP BY entry.id
        )
        SELECT COALESCE(SUM(gross), 0)::text AS realized_gross,
               COUNT(*) FILTER (WHERE closed_quantity < filled_quantity)::text AS open_count,
               COALESCE(BOOL_OR(invalid_close OR closed_quantity > filled_quantity OR
                 filled_quantity IS NULL OR average_price IS NULL OR
                 symbol NOT LIKE '%USDT'), false) AS invalid
        FROM entries
      `);
      const summary = ledger.rows[0];
      if (!summary || summary.invalid) throw new Error("Paper funds cannot be verified from linked fills.");
      const realized = new Decimal(summary.realized_gross);
      const openCount = new Decimal(summary.open_count);
      if (!realized.isFinite() || !openCount.isInteger() || openCount.isNegative()) {
        throw new Error("Paper funds contain invalid amounts.");
      }
      const free = new Decimal(PAPER_STARTING_DEPOSIT_USDT).plus(realized)
        .minus(openCount.mul(PAPER_POSITION_RESERVE_USDT));
      if (free.lessThan(PAPER_POSITION_RESERVE_USDT)) {
        return terminal("rejected", "paper_entry_skipped",
          `Не открыта: недостаточно свободных средств симулятора. Нужно ${PAPER_POSITION_RESERVE_USDT} USDT, доступно ${free.toFixed(2)} USDT.`,
          "PAPER_INSUFFICIENT_FUNDS", {
            required: PAPER_POSITION_RESERVE_USDT, available: free.toFixed(8),
            openPositions: openCount.toNumber(),
          });
      }
    }

    let paperEntryOrderId: string | null = null;
    if (signal.reduce_only) {
      if (signal.side !== "buy" && signal.side !== "sell") {
        return terminal("rejected", "signal_rejected", "Invalid reduce-only side.", "INVALID_SIDE");
      }
      // Serialize reductions against the entry row. Read the sum in a separate
      // statement after acquiring the lock, so a waiting transaction sees the
      // exit committed by the previous holder.
      const entries = await client.query<{ id: string; filled_quantity: string }>(
        `SELECT entry.id, entry.filled_quantity FROM trading_orders entry
         JOIN trading_signals entry_signal ON entry_signal.id = entry.signal_id
         WHERE entry.symbol = $1 AND entry.side = $2
           AND entry.status = 'simulated_filled' AND entry_signal.reduce_only = false
           AND entry.paper_entry_order_id IS NULL
         ORDER BY entry.created_at, entry.id FOR UPDATE OF entry`,
        [signal.symbol, signal.side === "buy" ? "sell" : "buy"],
      );
      for (const entry of entries.rows) {
        const closed = await client.query<{ quantity: string }>(
          `SELECT COALESCE(SUM(filled_quantity), 0)::text AS quantity
           FROM trading_orders WHERE paper_entry_order_id = $1 AND status = 'simulated_filled'`,
          [entry.id],
        );
        const remaining = new Decimal(entry.filled_quantity).minus(closed.rows[0]?.quantity ?? "0");
        if (remaining.greaterThanOrEqualTo(quantity)) {
          paperEntryOrderId = entry.id;
          break;
        }
      }
      if (!paperEntryOrderId) {
        return terminal("rejected", "signal_rejected",
          "No matching paper entry has enough remaining quantity.", "PAPER_POSITION_NOT_FOUND");
      }
    }

    const paperOrderId = `paper-${signal.id}`;
    const impulseV2 = !signal.reduce_only && current.pattern_id === "impulse_buy";
    const entryPrice = price.toFixed(12);
    const paperState = {
      mode: "paper",
      sourceSignalId: signal.source_signal_id,
      ...(impulseV2 ? {
        coreStop: signal.stop_loss,
        corePeak: entryPrice,
        runnerStop: entryPrice,
        runnerPeak: entryPrice,
      } : {}),
    };
    const inserted = await client.query(
      `INSERT INTO trading_orders
       (id, signal_id, exchange_order_id, symbol, side, order_type, status,
        quantity, filled_quantity, average_price, protection_status, stop_loss,
         take_profit, raw_response, paper_entry_order_id)
        VALUES ($1, $1, $2, $3, $4, $5, 'simulated_filled', $6, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (signal_id) DO NOTHING RETURNING id`,
      [signal.id, paperOrderId, signal.symbol, signal.side, signal.order_type,
       signal.quantity, signal.limit_price,
       signal.stop_loss || signal.take_profit ? "simulated" : "not_required",
       signal.stop_loss, signal.take_profit,
         JSON.stringify(paperState), paperEntryOrderId],
    );
    if (!inserted.rowCount) {
      return terminal("failed", "signal_failed", "Order already exists; execution was not repeated.", "ORDER_ALREADY_EXISTS");
    }
    return terminal("executed", "paper_order_executed", "Paper order and safety checks committed atomically.", null, {
      paperOrderId, notional: notional.toString(),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recordPaperFailure(
  signal: ClaimedSignal,
  error: unknown,
  connect: () => Promise<PaperDbClient> = getClient,
) {
  const client = await connect();
  try {
    await client.query("BEGIN");
    const row = await client.query<SignalRow>(
      "SELECT status, attempts, lease_until FROM trading_signals WHERE id = $1 FOR UPDATE",
      [signal.id],
    );
    const current = row.rows[0];
    if (current?.status !== "processing" || current.attempts !== signal.attempts) {
      await client.query("COMMIT");
      return;
    }
    const code = error instanceof Error ? error.name : "UNKNOWN_ERROR";
    // DB failures are retryable for a bounded number of leases. Never declare
    // a successful order failed unless we have checked the durable order row.
    const existing = await client.query<{ status: string }>(
      "SELECT status FROM trading_orders WHERE signal_id = $1",
      [signal.id],
    );
    const recovered = existing.rows[0]?.status === "simulated_filled";
    const terminal = recovered || signal.attempts >= 3;
    const next = recovered ? "executed" : terminal ? "failed" : "pending";
    await client.query(
      `UPDATE trading_signals SET status = $2, lease_until = NULL, updated_at = NOW(),
       processed_at = CASE WHEN $3 THEN NOW() ELSE processed_at END,
       error_code = $4, error_message = $5 WHERE id = $1`,
      [signal.id, next, terminal, recovered ? null : code, recovered ? null : "Paper execution failed; see worker log."],
    );
    await client.query(
      "INSERT INTO trading_audit_events (signal_id, event_type, message, details) VALUES ($1, $2, $3, $4)",
      [signal.id, recovered ? "paper_order_reconciled" : terminal ? "signal_failed" : "signal_retry_scheduled",
       recovered ? "Existing paper order recovered." : terminal ? "Paper execution failed after retry limit." : "Paper execution failed; queued for retry.",
       JSON.stringify({ errorCode: code, attempt: signal.attempts })],
    );
    await client.query("COMMIT");
  } catch (failure) {
    await client.query("ROLLBACK");
    throw failure;
  } finally {
    client.release();
  }
}
