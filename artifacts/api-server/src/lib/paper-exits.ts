import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { pool } from "@workspace/db";
import { BULLET_RULES_VERSION, hasExactBulletRules, hasLegacyPaperRules, PAPER_AUTO_EXIT_PATTERNS } from "./paper-intent";
import { nextImpulsePaperProtection, splitImpulseQuantity } from "./paper-impulse-exits";

type Entry = {
  id: string; signal_id: string; symbol: string; filled_quantity: string;
  average_price: string; stop_loss: string; created_at: Date;
  raw_response: Record<string, unknown> | null; pattern_id: string | null;
  raw_payload: Record<string, unknown> | null;
};

// Public Binance Spot book bid is an indicative paper mark, not a Bybit fill
// or a guarantee that an identical derivatives market exists.
export async function paperMarketPrice(symbol: string): Promise<Decimal> {
  if (!/^[A-Z0-9]{2,30}USDT$/.test(symbol)) throw new Error("Unsupported paper quote symbol");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=${symbol}`, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Paper quote unavailable: HTTP ${response.status}`);
    const data = await response.json() as { symbol?: string; bidPrice?: string };
    if (data.symbol !== symbol) throw new Error("Paper quote symbol mismatch");
    const value = new Decimal(data.bidPrice ?? "NaN");
    if (!value.isFinite() || value.lte(0) || value.decimalPlaces() > 12) throw new Error("Invalid paper bid quote");
    return value;
  } finally {
    clearTimeout(timer);
  }
}

export function nextPaperProtection(input: {
  entry: string; stop: string; peak: string; price: string; symbol: string;
  entryAt: Date; now: Date;
  legacyMaxHoldHours?: number;
}) {
  const entry = new Decimal(input.entry);
  const price = new Decimal(input.price);
  let stop = new Decimal(input.stop);
  let peak = new Decimal(input.peak);
  if (![entry, price, stop, peak].every((n) => n.isFinite() && n.gt(0)) || stop.gte(entry) && peak.eq(entry)) {
    throw new Error("Invalid paper protection state");
  }
  peak = Decimal.max(peak, price);
  const gain = peak.div(entry).minus(1).mul(100);
  if (gain.gte(input.symbol === "BTCUSDT" ? 1 : 5)) stop = Decimal.max(stop, entry);
  if (gain.gte(10)) stop = Decimal.max(stop, entry.mul("1.05"));
  if (gain.gte(15)) stop = Decimal.max(stop, entry.mul(gain.minus(10).div(100).plus(1)));
  const timedOut = input.legacyMaxHoldHours !== undefined &&
    input.now.getTime() - input.entryAt.getTime() >= input.legacyMaxHoldHours * 3_600_000;
  return {
    stop: stop.toDecimalPlaces(12, Decimal.ROUND_DOWN).toFixed(12),
    peak: peak.toDecimalPlaces(12, Decimal.ROUND_DOWN).toFixed(12),
    reason: price.lte(stop) ? "stop" : timedOut ? "recorded_legacy_time_exit" : null,
  };
}

export async function processPaperExits(
  quote: (symbol: string) => Promise<Decimal> = paperMarketPrice,
  now = new Date(),
  onlyEntryId?: string,
) {
  // Candidate list is advisory; the locked transaction rechecks remaining
  // quantity and eligibility. Never apply v2 to historical or legacy entries.
  const candidates = await pool.query<{ id: string; symbol: string }>(`
    SELECT o.id, o.symbol FROM trading_orders o
    JOIN trading_signals s ON s.id = o.signal_id
    WHERE o.status = 'simulated_filled' AND o.paper_entry_order_id IS NULL
      AND s.reduce_only = false AND s.raw_payload->>'rulesVersion' = $1
      AND s.pattern_id = ANY($2::text[])
      AND ($3::uuid IS NULL OR o.id = $3)
    ORDER BY o.created_at
  `, [BULLET_RULES_VERSION, [...PAPER_AUTO_EXIT_PATTERNS], onlyEntryId ?? null]);
  const quotes = new Map<string, Decimal>();
  for (const { id, symbol } of candidates.rows) {
    let price = quotes.get(symbol);
    if (!price) {
      try {
        price = await quote(symbol);
      } catch {
        // A missing Spot pair must not starve unrelated symbols.
        continue;
      }
      if (!price.isFinite() || price.lte(0) || price.decimalPlaces() > 12) continue;
      quotes.set(symbol, price);
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const controls = await client.query<{ mode: string }>("SELECT mode FROM trading_controls WHERE id = 1 FOR UPDATE");
      if (controls.rows[0]?.mode !== "paper") {
        await client.query("COMMIT");
        return;
      }
      const row = await client.query<Entry>(`
        SELECT o.id, o.signal_id, o.symbol, o.filled_quantity, o.average_price,
          o.stop_loss, o.created_at, o.raw_response, s.pattern_id, s.raw_payload
        FROM trading_orders o JOIN trading_signals s ON s.id = o.signal_id
        WHERE o.id = $1 AND o.status = 'simulated_filled'
          AND o.paper_entry_order_id IS NULL AND s.reduce_only = false
        FOR UPDATE OF o
      `, [id]);
      const entry = row.rows[0];
      const verified = entry && hasExactBulletRules(entry.raw_payload, entry.pattern_id ?? "", true) &&
        entry.raw_payload?.relayContractVerified === true;
      const legacy = entry && hasLegacyPaperRules(entry.raw_payload);
      if (!entry || (!verified && !legacy) ||
          !PAPER_AUTO_EXIT_PATTERNS.has(entry.pattern_id ?? "") ||
          entry.raw_response?.mode !== "paper" || !entry.stop_loss ||
          !entry.average_price || !entry.filled_quantity) {
        await client.query("COMMIT");
        continue;
      }
      const closed = await client.query<{ quantity: string }>(`
        SELECT COALESCE(SUM(filled_quantity), 0)::text AS quantity
        FROM trading_orders WHERE paper_entry_order_id = $1 AND status = 'simulated_filled'
      `, [id]);
      const remaining = new Decimal(entry.filled_quantity).minus(closed.rows[0]?.quantity ?? "0");
      if (!remaining.isFinite() || remaining.lt(0)) throw new Error("Invalid linked paper fills");
      if (remaining.eq(0)) {
        await client.query("COMMIT");
        continue;
      }
      const state = entry.raw_response;
      // Old already-filled positions retain their *recorded* 96h rule; new
      // entries never inherit it. Make the transition visible to the owner.
      if (legacy && state.legacyPolicyRecorded !== true) {
        await client.query(`INSERT INTO trading_audit_events
          (signal_id, event_type, message, details)
          VALUES ($1, 'legacy_paper_policy_retained',
            'Existing paper position continues under its recorded v2 policy; new Bullet entries require a verified relay event.',
            $2)`, [entry.signal_id, JSON.stringify({ entryOrderId: id, recordedMaxHoldHours: 96 })]);
        state.legacyPolicyRecorded = true;
        await client.query("UPDATE trading_orders SET raw_response = $2, updated_at = NOW() WHERE id = $1",
          [id, JSON.stringify(state)]);
      }

      if (entry.pattern_id === "impulse_buy") {
        if (state.impulseExitBlocked === true) {
          await client.query("COMMIT");
          continue;
        }
        const quantities = splitImpulseQuantity(entry.filled_quantity);
        const coreSourceId = `paper-auto-exit:${id}:impulse-core`;
        const runnerSourceId = `paper-auto-exit:${id}:impulse-runner`;
        const linked = await client.query<{ source_signal_id: string; quantity: string }>(`
          SELECT s.source_signal_id, COALESCE(SUM(o.filled_quantity), 0)::text AS quantity
          FROM trading_orders o JOIN trading_signals s ON s.id = o.signal_id
          WHERE o.paper_entry_order_id = $1 AND o.status = 'simulated_filled'
          GROUP BY s.source_signal_id
        `, [id]);
        const coreClosed = linked.rows.filter((fill) => fill.source_signal_id === coreSourceId)
          .reduce((sum, fill) => sum.plus(fill.quantity), new Decimal(0));
        const runnerClosed = linked.rows.filter((fill) => fill.source_signal_id === runnerSourceId)
          .reduce((sum, fill) => sum.plus(fill.quantity), new Decimal(0));
        const unknownClosed = new Decimal(closed.rows[0]?.quantity ?? "0").minus(coreClosed).minus(runnerClosed);
        const coreRemaining = new Decimal(quantities.core).minus(coreClosed);
        const runnerRemaining = new Decimal(quantities.runner).minus(runnerClosed);
        if (coreRemaining.lt(0) || runnerRemaining.lt(0) || unknownClosed.lt(0)) {
          throw new Error("Invalid linked impulse paper fills");
        }
        // A separately-created linked close does not identify which strategy
        // leg it consumed. Do not guess how to reallocate the remaining legs.
        if (unknownClosed.gt(0) || !coreRemaining.plus(runnerRemaining).eq(remaining)) {
          const reason = unknownClosed.gt(0)
            ? "linked_close_leg_unknown"
            : "linked_impulse_fill_quantity_mismatch";
          if (state.impulseExitBlocked !== true) {
            const blockDetails = {
              entryOrderId: id,
              reason,
              unallocatedClosedQuantity: unknownClosed.toString(),
              coreRemaining: coreRemaining.toString(),
              runnerRemaining: runnerRemaining.toString(),
              actualRemaining: remaining.toString(),
            };
            await client.query(`INSERT INTO trading_audit_events
              (signal_id, event_type, message, details)
              VALUES ($1, 'paper_auto_exit_blocked',
                'Automatic impulse exits halted because linked partial fills cannot be assigned safely to a strategy leg.',
                $2)`, [entry.signal_id, JSON.stringify(blockDetails)]);
            await client.query("UPDATE trading_orders SET raw_response = $2, updated_at = NOW() WHERE id = $1",
              [id, JSON.stringify({ ...state, impulseExitBlocked: true, impulseExitBlockReason: reason })]);
          }
          await client.query("COMMIT");
          continue;
        }
        const initialStop = entry.stop_loss;
        const next = nextImpulsePaperProtection({
          entry: entry.average_price,
          initialStop,
          coreStop: String(state.coreStop ?? initialStop),
          corePeak: String(state.corePeak ?? entry.average_price),
          runnerStop: String(state.runnerStop ?? entry.average_price),
          runnerPeak: String(state.runnerPeak ?? entry.average_price),
          price: price.toString(),
          symbol: entry.symbol,
          entryAt: entry.created_at,
          now,
          coreActive: coreRemaining.gt(0),
          runnerActive: runnerRemaining.gt(0),
          ...(legacy ? { coreMaxHoldHours: 96 } : {}),
        });
        const nextState: Record<string, unknown> = {
          ...state,
          coreStop: next.coreStop,
          corePeak: next.corePeak,
          runnerStop: next.runnerStop,
          runnerPeak: next.runnerPeak,
        };
        if (next.coreReason) nextState.coreClosedReason = next.coreReason;

        const createImpulseFill = async (
          leg: "core" | "runner",
          qty: Decimal,
          reason: string,
          sourceSignalId: string,
        ) => {
          if (!qty.gt(0)) return;
          const closeId = randomUUID();
          const created = await client.query<{ id: string }>(`
            INSERT INTO trading_signals
              (id, source_signal_id, confirmation_status, pattern_id, pattern_status,
               symbol, signal_at, reference_price, side, order_type, quantity, limit_price,
               reduce_only, status, processed_at, raw_payload)
            VALUES ($1, $2, 'confirmed', 'impulse_buy', 'approved', $3, $4, $5,
                    'sell', 'market', $6, $5, true, 'executed', NOW(), $7)
            ON CONFLICT (source_signal_id) DO NOTHING RETURNING id
          `, [closeId, sourceSignalId, entry.symbol, now, price.toFixed(12), qty.toFixed(12),
            JSON.stringify({ paperAutoExit: reason, leg })]);
          if (!created.rowCount) throw new Error("Paper impulse exit ID already exists without a confirmed linked fill");
          await client.query(`
            INSERT INTO trading_orders
              (id, signal_id, exchange_order_id, symbol, side, order_type, status,
               quantity, filled_quantity, average_price, protection_status, raw_response, paper_entry_order_id)
            VALUES ($1, $1, $2, $3, 'sell', 'market', 'simulated_filled',
                    $4, $4, $5, 'not_required', $6, $7)
          `, [closeId, `paper-${closeId}`, entry.symbol, qty.toFixed(12), price.toFixed(12),
            JSON.stringify({ mode: "paper", quoteSource: "binance-spot-bid", observedPrice: price.toString(), reason, leg }), id]);
          await client.query(`INSERT INTO trading_audit_events (signal_id, event_type, message, details)
            VALUES ($1, 'paper_auto_exit', 'Paper impulse leg closed at observed bid; not an exchange fill.', $2)`,
          [closeId, JSON.stringify({ entryOrderId: id, leg, reason, price: price.toString(), quantity: qty.toString() })]);
        };

        if (next.coreReason && coreRemaining.gt(0)) {
          await createImpulseFill("core", coreRemaining, next.coreReason, coreSourceId);
        }
        if (next.runnerReason && runnerRemaining.gt(0)) {
          await createImpulseFill("runner", runnerRemaining, next.runnerReason, runnerSourceId);
        }
        await client.query("UPDATE trading_orders SET raw_response = $2, updated_at = NOW() WHERE id = $1",
          [id, JSON.stringify(nextState)]);
        await client.query("COMMIT");
        continue;
      }

      const next = nextPaperProtection({
        entry: entry.average_price, stop: String(state.stop ?? entry.stop_loss),
        peak: String(state.peak ?? entry.average_price), price: price.toString(),
        symbol: entry.symbol, entryAt: entry.created_at, now,
        ...(legacy ? { legacyMaxHoldHours: 96 } : {}),
      });
      if (!next.reason) {
        await client.query("UPDATE trading_orders SET raw_response = $2, updated_at = NOW() WHERE id = $1",
          [id, JSON.stringify({ ...state, stop: next.stop, peak: next.peak })]);
      } else {
        const closeId = randomUUID();
        const sourceSignalId = `paper-auto-exit:${id}`;
        const created = await client.query<{ id: string }>(`
          INSERT INTO trading_signals
            (id, source_signal_id, confirmation_status, pattern_id, pattern_status,
             symbol, signal_at, reference_price, side, order_type, quantity, limit_price,
             reduce_only, status, processed_at, raw_payload)
          VALUES ($1, $2, 'confirmed', $3, 'approved', $4, $5, $6,
                  'sell', 'market', $7, $6, true, 'executed', NOW(), $8)
          ON CONFLICT (source_signal_id) DO NOTHING RETURNING id
        `, [closeId, sourceSignalId, entry.pattern_id, entry.symbol, now, price.toFixed(12),
          remaining.toFixed(12), JSON.stringify({ paperAutoExit: next.reason, observedStop: next.stop })]);
        if (!created.rowCount) throw new Error("Paper exit ID already exists without a confirmed linked fill");
        await client.query(`
          INSERT INTO trading_orders
            (id, signal_id, exchange_order_id, symbol, side, order_type, status,
             quantity, filled_quantity, average_price, protection_status, raw_response, paper_entry_order_id)
          VALUES ($1, $1, $2, $3, 'sell', 'market', 'simulated_filled',
                  $4, $4, $5, 'not_required', $6, $7)
        `, [closeId, `paper-${closeId}`, entry.symbol, remaining.toFixed(12), price.toFixed(12),
          JSON.stringify({ mode: "paper", quoteSource: "binance-spot-bid", observedPrice: price.toString(), reason: next.reason }), id]);
        await client.query("UPDATE trading_orders SET raw_response = $2, updated_at = NOW() WHERE id = $1",
          [id, JSON.stringify({ ...state, stop: next.stop, peak: next.peak })]);
        await client.query(`INSERT INTO trading_audit_events (signal_id, event_type, message, details)
          VALUES ($1, 'paper_auto_exit', 'Paper position closed at observed bid; not an exchange fill.', $2)`,
          [closeId, JSON.stringify({ entryOrderId: id, reason: next.reason, price: price.toString(), quantity: remaining.toString() })]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}