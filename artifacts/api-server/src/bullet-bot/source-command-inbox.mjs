import { validateSourceCommand, sourceCommandHash } from "./source-command-contract.mjs";
import { createOwnerResetStore } from "./owner-reset.mjs";

const KIND = "source_command_received";
const terminal = new Set(["executed", "already_closed", "rejected", "superseded"]);
const modeTable = mode => {
  if (mode === "paper") return { positions: "btb_positions", signals: "btb_signals" };
  if (mode === "vst") return { positions: "vst_positions", signals: "vst_signals" };
  throw new TypeError("unsupported_command_mode");
};
export function commandReceipt(detail) {
  return { ...detail.command, receivedAt: detail.receivedAt,
    deliveries: Object.entries(detail.targets).map(([mode, target]) => ({
      mode, status: target.status, attempts: target.attempts,
      updatedAt: target.updatedAt, lastError: target.lastError ?? null,
      result: target.result ?? null,
    })) };
}

/** An inbox event is stored once in the existing durable event ledger.
 * Advisory serialization makes ID/sequence dedup atomic across processes.
 * Transport events are not trade notifications; native execution events remain
 * on the usual PAPER/VST notification paths. No schema migration is required. */
export function createSourceCommandInbox(pool, { clock = Date.now } = {}) {
  const reset = createOwnerResetStore(pool, { clock });
  async function transaction(run) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('bullet:source-command-inbox'))");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  async function list({ commandId = null, limit = 100 } = {}) {
    const result = await pool.query(
      `SELECT detail FROM vst_events WHERE kind = $1
       AND ($2::text IS NULL OR detail->'command'->>'commandId' = $2)
       ORDER BY CASE WHEN EXISTS (SELECT 1 FROM jsonb_each(detail->'targets') target
         WHERE target.value->>'status' = 'pending') THEN 0 ELSE 1 END,
         id DESC LIMIT $3`, [KIND, commandId, Math.min(Math.max(limit, 1), 100)]);
    return result.rows.map(row => commandReceipt(row.detail));
  }
  return {
    requestReset: reset.requestReset,
    resetStatus: reset.resetStatus,
    list,
    async lookupPosition(mode, sourceSignalId) {
      const tables = modeTable(mode);
      const result = await pool.query(
        `SELECT source_signal_id, snapshot->>'symbol' AS symbol, status, snapshot FROM ${tables.positions}
         WHERE source_signal_id = $1`, [sourceSignalId]);
      const row = result.rows[0];
      return row ? { sourceSignalId: row.source_signal_id, symbol: row.symbol,
        status: row.status, snapshot: row.snapshot } : null;
    },
    async isEntryBlocked(sourceSignalId, mode, signalAt = null) {
      modeTable(mode);
      const resetBlock = await reset.resetBlocksEntry(sourceSignalId, mode, signalAt);
      if (resetBlock) return resetBlock;
      const result = await pool.query(
        `SELECT 1 FROM vst_events WHERE kind = $1
         AND detail->'command'->>'sourceSignalId' = $2
         AND detail->'command'->>'type' IN ('close', 'cancel_entry')
         LIMIT 1`, [KIND, sourceSignalId]);
      return result.rows.length > 0;
    },
    async receive(value, modes) {
      const command = validateSourceCommand(value, clock());
      const hash = sourceCommandHash(command, clock());
      if (!modes.length || modes.some(mode => !["paper", "vst"].includes(mode))) {
        throw new TypeError("unsupported_command_mode");
      }
      return transaction(async client => {
        const existing = await client.query(
          `SELECT detail FROM vst_events WHERE kind = $1
           AND detail->'command'->>'commandId' = $2 LIMIT 1`, [KIND, command.commandId]);
        if (existing.rows[0]) {
          const prior = existing.rows[0].detail;
          return prior.hash === hash
            ? { kind: "duplicate", receipt: commandReceipt(prior) }
            : { kind: "conflict", reason: "command_id_payload_conflict" };
        }
        const sameSequence = await client.query(
          `SELECT 1 FROM vst_events WHERE kind = $1
           AND detail->'command'->>'sourceSignalId' = $2
           AND (detail->'command'->>'sequence')::bigint = $3 LIMIT 1`,
          [KIND, command.sourceSignalId, command.sequence]);
        if (sameSequence.rows.length) return { kind: "conflict", reason: "source_sequence_conflict" };
        for (const mode of modes) {
          const table = modeTable(mode).signals;
          const known = await client.query(
            `SELECT body->>'symbol' AS symbol FROM ${table} WHERE source_signal_id = $1`,
            [command.sourceSignalId]);
          if (known.rows.some(row => row.symbol !== command.symbol)) {
            return { kind: "conflict", reason: "source_symbol_conflict" };
          }
        }
        const identity = await client.query(
          `SELECT detail FROM vst_events WHERE kind = $1
           AND detail->'command'->>'sourceSignalId' = $2`, [KIND, command.sourceSignalId]);
        if (identity.rows.some(row => row.detail.command.symbol !== command.symbol)) {
          return { kind: "conflict", reason: "source_symbol_conflict" };
        }
        const at = new Date(clock()).toISOString();
        const detail = { command, hash, receivedAt: at, targets: {} };
        for (const mode of [...new Set(modes)]) {
          const newerStop = identity.rows.some(row => row.detail.targets[mode] &&
            row.detail.command.type === "move_stop" && row.detail.command.sequence > command.sequence);
          const closed = identity.rows.some(row => row.detail.targets[mode] &&
            row.detail.command.type === "close");
          detail.targets[mode] = { status: command.type === "move_stop" && (newerStop || closed)
            ? "superseded" : "pending", attempts: 0, updatedAt: at };
        }
        // A new stop replaces queued older stop updates, never an exchange
        // write already sent. A close supersedes all pending stop updates.
        for (const row of identity.rows) {
          const prior = row.detail;
          if (prior.command.type !== "move_stop" ||
              command.type !== "close" && !(command.type === "move_stop" &&
                command.sequence > prior.command.sequence)) continue;
          for (const mode of modes) {
            if (prior.targets[mode]?.status === "pending") {
              prior.targets[mode] = { ...prior.targets[mode], status: "superseded", updatedAt: at };
            }
          }
          await client.query(
            `UPDATE vst_events SET detail = $3::jsonb WHERE kind = $1
             AND detail->'command'->>'commandId' = $2`,
            [KIND, prior.command.commandId, JSON.stringify(prior)]);
        }
        await client.query(
          `INSERT INTO vst_events (source_signal_id, kind, detail, telegram_sent_at)
           VALUES (NULL, $1, $2::jsonb, NOW())`, [KIND, JSON.stringify(detail)]);
        return { kind: "received", receipt: commandReceipt(detail) };
      });
    },
    async next(mode) {
      modeTable(mode);
      const result = await pool.query(
        `SELECT e.detail FROM vst_events e WHERE e.kind = $1
         AND e.detail->'targets'->$2->>'status' = 'pending'
         AND COALESCE((e.detail->'targets'->$2->>'nextAttemptAt')::timestamptz,
                      '-infinity'::timestamptz) <= NOW()
         AND (e.detail->'command'->>'type' = 'close' OR NOT EXISTS (
           SELECT 1 FROM vst_events p WHERE p.kind = $1
           AND p.detail->'command'->>'sourceSignalId' = e.detail->'command'->>'sourceSignalId'
           AND p.detail->'targets'->$2->>'status' = 'pending'
           AND (p.detail->'command'->>'sequence')::bigint <
               (e.detail->'command'->>'sequence')::bigint))
         ORDER BY CASE e.detail->'command'->>'type' WHEN 'close' THEN 0 ELSE 1 END,
                  e.id LIMIT 1`, [KIND, mode]);
      return result.rows[0]?.detail ?? null;
    },
    async complete(commandId, mode, outcome) {
      modeTable(mode);
      return transaction(async client => {
        const result = await client.query(
          `SELECT id, detail FROM vst_events WHERE kind = $1
           AND detail->'command'->>'commandId' = $2 FOR UPDATE`, [KIND, commandId]);
        const row = result.rows[0];
        if (!row || !row.detail.targets[mode]) throw new Error("source_command_not_found");
        const prior = row.detail.targets[mode];
        if (terminal.has(prior.status)) return commandReceipt(row.detail);
        const at = new Date(clock()).toISOString();
        const status = terminal.has(outcome?.status) ? outcome.status : "pending";
        const attempts = prior.attempts + 1;
        const reason = typeof outcome?.reason === "string" &&
          /^[a-z0-9_:.-]{1,128}$/.test(outcome.reason) ? outcome.reason : "execution_pending";
        row.detail.targets[mode] = { status, attempts, updatedAt: at,
          lastError: status === "pending" || status === "rejected" ? reason : null,
          result: status === "executed" || status === "already_closed"
            ? outcome.result ?? status : null,
          ...(status === "pending" ? {
            nextAttemptAt: new Date(clock() + Math.min(120_000, 5_000 * 2 ** Math.min(attempts, 5))).toISOString(),
          } : {}) };
        await client.query("UPDATE vst_events SET detail = $2::jsonb WHERE id = $1",
          [row.id, JSON.stringify(row.detail)]);
        return commandReceipt(row.detail);
      });
    },
    async cancelEntry(command, mode) {
      const tables = modeTable(mode);
      return transaction(async client => {
        const signal = await client.query(
          `SELECT source_signal_id, status FROM ${tables.signals}
           WHERE source_signal_id = $1 FOR UPDATE`, [command.sourceSignalId]);
        const positions = await client.query(
          `SELECT status FROM ${tables.positions} WHERE source_signal_id = $1`,
          [command.sourceSignalId]);
        if (positions.rows.length) return { status: "rejected", reason: "entry_already_executed" };
        if (mode === "vst") {
          const intents = await client.query(
            `SELECT 1 FROM vst_order_intents WHERE source_signal_id = $1`,
            [command.sourceSignalId]);
          if (intents.rows.length) return { status: "pending", reason: "entry_requires_reconciliation" };
        }
        if (signal.rows[0] && !["pending", "rejected"].includes(signal.rows[0].status)) {
          return { status: "pending", reason: "entry_requires_reconciliation" };
        }
        await client.query(
          `UPDATE ${tables.signals} SET status = 'rejected', reason = 'source_entry_cancelled'
           WHERE source_signal_id = $1 AND status IN ('pending','rejected')`,
          [command.sourceSignalId]);
        return { status: "executed", result: "entry_cancelled_no_order" };
      });
    },
  };
}
