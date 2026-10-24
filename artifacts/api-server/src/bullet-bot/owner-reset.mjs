import { createHash } from "node:crypto";
import { sourceCommandHash, validateSourceCommand } from "./source-command-contract.mjs";

const RESET = "owner_reset_requested";
const COMMAND = "source_command_received";
// Same two-key leader locks as store.mjs / vst-store.mjs. TRY, never wait
// while holding the command-inbox lock a worker's cancel may also need.
const LEADERS = [[4_348_994, 1], [4_348_996, 1]];
const tables = {
  paper: { positions: "btb_positions", signals: "btb_signals" },
  vst: { positions: "vst_positions", signals: "vst_signals" },
};

export function createOwnerResetStore(pool, { clock = Date.now, leaderLocks = LEADERS } = {}) {
  async function status(resetId = null, db = pool) {
    const result = await db.query(
      `SELECT detail FROM vst_events WHERE kind = $1
       AND ($2::text IS NULL OR detail->>'resetId' = $2) ORDER BY id DESC LIMIT 1`,
      [RESET, resetId]);
    const reset = result.rows[0]?.detail;
    if (!reset) return null;
    const commands = await db.query(
      `SELECT detail FROM vst_events WHERE kind = $1 AND detail->>'resetId' = $2`,
      [COMMAND, reset.resetId]);
    const deliveries = commands.rows.flatMap(row => Object.values(row.detail.targets));
    const pending = deliveries.filter(row => row.status === "pending").length;
    const rejected = deliveries.filter(row => !["executed", "already_closed", "pending"].includes(row.status)).length;
    return { ...reset, pending, rejected,
      phase: rejected ? "needs_review" : pending ? "closing" : "completed" };
  }
  async function blocksEntry(sourceSignalId, mode, signalAt = null) {
    if (!tables[mode]) throw new TypeError("unsupported_command_mode");
    const result = await pool.query(
      `WITH latest AS (SELECT detail FROM vst_events WHERE kind = $1 ORDER BY id DESC LIMIT 1)
       SELECT (
         COALESCE($4::timestamptz,
           (SELECT COALESCE((body->>'signalAt')::timestamptz, received_at)
            FROM ${tables[mode].signals} WHERE source_signal_id = $3)) <=
              (r.detail->>'cutoff')::timestamptz) AS old_signal,
         EXISTS (SELECT 1 FROM vst_events c, jsonb_each(c.detail->'targets') t
           WHERE c.kind = $2 AND c.detail->>'resetId' = r.detail->>'resetId'
           AND t.value->>'status' NOT IN ('executed', 'already_closed')) AS active
       FROM latest r`,
      [RESET, COMMAND, sourceSignalId, signalAt]);
    if (result.rows[0]?.old_signal) return true;
    // Fresh ingress is retained in the queue. Workers wait without rejecting
    // it until the reset completes; normal signal TTL is not extended.
    return result.rows[0]?.active && signalAt === null ? "maintenance" : false;
  }
  async function request({ resetId, vstAvailable }) {
    if (typeof resetId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(resetId)) {
      throw new TypeError("invalid_reset_id");
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('bullet:source-command-inbox'))");
      const duplicate = await client.query(
        `SELECT 1 FROM vst_events WHERE kind = $1 AND detail->>'resetId' = $2`, [RESET, resetId]);
      if (duplicate.rows.length) {
        await client.query("COMMIT");
        return { kind: "duplicate", reset: await status(resetId, client) };
      }
      for (const key of leaderLocks) {
        const lock = await client.query("SELECT pg_try_advisory_xact_lock($1,$2) AS acquired", key);
        if (!lock.rows[0]?.acquired) {
          await client.query("ROLLBACK");
          return { kind: "busy" };
        }
      }
      const existing = await client.query(
        `SELECT detail FROM vst_events WHERE kind = $1 ORDER BY id DESC LIMIT 1`, [RESET]);
      if (existing.rows[0]) {
        const active = await client.query(
          `SELECT 1 FROM vst_events c, jsonb_each(c.detail->'targets') t
           WHERE c.kind = $1 AND c.detail->>'resetId' = $2
           AND t.value->>'status' NOT IN ('executed','already_closed') LIMIT 1`,
          [COMMAND, existing.rows[0].detail.resetId]);
        if (active.rows.length) {
          await client.query("ROLLBACK");
          return { kind: "conflict", reason: "reset_already_active" };
        }
      }
      const cutoff = new Date(clock()).toISOString();
      const grouped = new Map();
      let closeRequests = 0;
      let cancelRequests = 0;
      for (const [mode, table] of Object.entries(tables)) {
        const rows = await client.query(
          `SELECT source_signal_id, snapshot->>'symbol' AS symbol, 'close' AS action
           FROM ${table.positions} WHERE status <> 'closed'
           UNION ALL SELECT s.source_signal_id, s.body->>'symbol', 'cancel_entry'
           FROM ${table.signals} s WHERE s.status IN ('pending','opening')
           AND NOT EXISTS (SELECT 1 FROM ${table.positions} p
             WHERE p.source_signal_id = s.source_signal_id AND p.status <> 'closed')`);
        if (mode === "vst" && rows.rows.length && !vstAvailable) {
          await client.query("ROLLBACK");
          return { kind: "conflict", reason: "vst_worker_required" };
        }
        for (const row of rows.rows) {
          const key = row.source_signal_id;
          const prior = grouped.get(key);
          if (prior && (prior.symbol !== row.symbol || prior.type !== row.action)) {
            // One mode can still be pending while the other has a position.
            if (prior.symbol !== row.symbol) throw new Error("reset_symbol_conflict");
            prior.type = "close"; // no position: close safely delegates to cancel-entry
          }
          const item = prior ?? { sourceSignalId: key, symbol: row.symbol, type: row.action, modes: [] };
          item.modes.push(mode);
          grouped.set(key, item);
          if (row.action === "close") closeRequests++; else cancelRequests++;
        }
      }
      // All old queued commands are superseded under both leader locks. Native
      // intents/fills are deliberately untouched and must still reconcile.
      const old = await client.query(`SELECT id, detail FROM vst_events WHERE kind = $1`, [COMMAND]);
      for (const row of old.rows) {
        let changed = false;
        for (const target of Object.values(row.detail.targets)) {
          if (target.status === "pending") {
            Object.assign(target, { status: "superseded", updatedAt: cutoff, result: "owner_reset" });
            changed = true;
          }
        }
        if (changed) await client.query(`UPDATE vst_events SET detail=$2::jsonb WHERE id=$1`,
          [row.id, JSON.stringify(row.detail)]);
      }
      for (const item of grouped.values()) {
        const sequence = await client.query(
          `SELECT MAX((detail->'command'->>'sequence')::bigint) AS n FROM vst_events
           WHERE kind=$1 AND detail->'command'->>'sourceSignalId'=$2`,
          [COMMAND, item.sourceSignalId]);
        const command = validateSourceCommand({
          commandId: `reset-${createHash("sha256").update(`${resetId}:${item.sourceSignalId}`).digest("hex").slice(0,40)}`,
          sourceSignalId: item.sourceSignalId, symbol: item.symbol, type: item.type,
          sequence: Number(sequence.rows[0]?.n ?? 0) + 1, occurredAt: cutoff,
          reason: "owner_reset", ...(item.type === "close" ? { scope: "all" } : {}),
        }, clock());
        const detail = { resetId, command, hash: sourceCommandHash(command, clock()), receivedAt: cutoff,
          targets: Object.fromEntries(item.modes.map(mode =>
            [mode, { status: "pending", attempts: 0, updatedAt: cutoff }])) };
        await client.query(
          `INSERT INTO vst_events (kind,detail,telegram_sent_at) VALUES ($1,$2::jsonb,NOW())`,
          [COMMAND, JSON.stringify(detail)]);
      }
      const reset = { resetId, cutoff, positionCloseRequests: closeRequests,
        queuedEntryCancellations: cancelRequests, queuedCommands: grouped.size };
      await client.query(
        `INSERT INTO vst_events(kind,detail,telegram_sent_at) VALUES($1,$2::jsonb,NOW())`,
        [RESET, JSON.stringify(reset)]);
      await client.query("COMMIT");
      return { kind: "received", reset: await status(resetId, client) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  return { resetStatus: status, requestReset: request, resetBlocksEntry: blocksEntry };
}
