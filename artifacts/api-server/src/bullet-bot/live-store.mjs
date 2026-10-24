import { createHash } from "node:crypto";
import Decimal from "decimal.js";

const LOCK_NAMESPACE = 4_348_995;
const LOCK_ID = 1;
const SECRET_KEY = /(api[_-]?key|secret|password|token|authorization|credential)/i;
const INTENT_STATES = new Set(["pending", "submitted", "unknown", "reconciled"]);
const POSITION_STATES = new Set(["open", "opening", "closing", "closed"]);
const CONTROL_DEFAULT_REASON = "Live execution is disabled by default";

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function positiveDecimal(value, name) {
  const number = new Decimal(String(value));
  if (!number.isFinite() || !number.gt(0)) throw new TypeError(`${name} must be positive`);
  return number;
}

function verifiedInstant(value, name) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Persisted values must contain finite numbers");
    return value;
  }
  if (typeof value !== "object") throw new TypeError("Persisted values must be JSON-compatible");
  if (seen.has(value)) throw new TypeError("Persisted values must not contain circular references");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Persisted objects must be plain JSON objects");
    }
    const result = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError("Persisted objects must not contain undefined values");
      result[key] = canonicalize(value[key], seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function assertNoCredentials(value, path = "value") {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw new TypeError(`Credentials are not allowed in persisted ${path}`);
    assertNoCredentials(child, `${path}.${key}`);
  }
}

function serialize(value, name) {
  assertNoCredentials(value, name);
  return JSON.stringify(canonicalize(value));
}

function scopedIdentity(account, environment) {
  return [
    requireString(account, "account"),
    requireString(environment, "environment"),
  ];
}

function rowToPosition(row) {
  if (!row) return null;
  return {
    account: row.account_id,
    environment: row.environment,
    signalId: row.signal_id,
    symbol: row.symbol,
    status: row.status,
    snapshot: row.snapshot,
    capturedAt: row.captured_at,
  };
}

async function inTransaction(pool, callback) {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query("BEGIN");
    open = true;
    const result = await callback(client);
    await client.query("COMMIT");
    open = false;
    return result;
  } catch (error) {
    if (open) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * PostgreSQL-only persistence for the isolated LIVE ledger. This store never
 * reads, copies, migrates, or reprocesses rows from the PAPER ledger and has no
 * exchange/private API integration. Live submission remains disabled here.
 */
export function createLiveStore(pool) {
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw new TypeError("createLiveStore requires a PostgreSQL pool");
  }

  return {
    // An owner-confirmed, immutable observation; never derived by this store
    // from an account balance. A second, different baseline is rejected.
    async recordBaseline({ account, environment, initialUsdt, startedAt }) {
      const [accountId, env] = scopedIdentity(account, environment);
      const amount = positiveDecimal(initialUsdt, "initialUsdt").toString();
      const at = verifiedInstant(startedAt, "startedAt");
      await pool.query(
        `INSERT INTO btb_live_baseline (account_id, environment, initial_usdt, started_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT (account_id, environment) DO NOTHING`,
        [accountId, env, amount, at],
      );
      const result = await pool.query(
        `SELECT initial_usdt, started_at FROM btb_live_baseline
         WHERE account_id = $1 AND environment = $2`,
        [accountId, env],
      );
      const row = result.rows[0];
      if (!row || !new Decimal(row.initial_usdt).eq(amount) ||
          new Date(row.started_at).toISOString() !== at) {
        throw new Error("LIVE baseline already recorded with different facts");
      }
      return row;
    },

    async recordInitialAllocation({ account, environment, signalId, marginUsdt, entryAt }) {
      const [accountId, env] = scopedIdentity(account, environment);
      requireString(signalId, "signalId");
      const margin = positiveDecimal(marginUsdt, "marginUsdt");
      const entry = verifiedInstant(entryAt, "entryAt");
      const result = await pool.query(
        `INSERT INTO btb_live_allocations
           (account_id, environment, signal_id, initial_margin_usdt, initial_deposit_usdt, allocated_percent)
         SELECT $1, $2, $3, $4, initial_usdt, $4::numeric / initial_usdt * 100
         FROM btb_live_baseline WHERE account_id = $1 AND environment = $2 AND started_at <= $5
         ON CONFLICT (account_id, environment, signal_id) DO NOTHING`,
        [accountId, env, signalId, margin.toString(), entry],
      );
      if (result.rowCount === 0) {
        const previous = await pool.query(
          `SELECT initial_margin_usdt FROM btb_live_allocations
           WHERE account_id = $1 AND environment = $2 AND signal_id = $3`,
          [accountId, env, signalId],
        );
        if (!previous.rows[0] || !margin.eq(previous.rows[0].initial_margin_usdt)) {
          throw new Error("LIVE allocation baseline missing or conflicting");
        }
      }
    },

    async recordFunding({ account, environment, signalId, transactionId, amountUsdt, settledAt }) {
      const [accountId, env] = scopedIdentity(account, environment);
      requireString(signalId, "signalId");
      requireString(transactionId, "transactionId");
      const value = new Decimal(String(amountUsdt));
       if (!value.isFinite() || !/^-?\d{1,18}(?:\.\d{1,12})?$/.test(String(amountUsdt))) {
         throw new TypeError("Invalid funding amount");
       }
      const at = verifiedInstant(settledAt, "settledAt");
      await pool.query(
        `INSERT INTO btb_live_funding (account_id, environment, signal_id, exchange_transaction_id, amount_usdt, settled_at)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [accountId, env, signalId, transactionId, value.toString(), at],
      );
      const existing = await pool.query(
        `SELECT signal_id, amount_usdt, settled_at FROM btb_live_funding
         WHERE account_id = $1 AND environment = $2 AND exchange_transaction_id = $3`,
        [accountId, env, transactionId],
      );
      if (existing.rows[0]?.signal_id !== signalId ||
          !value.eq(existing.rows[0]?.amount_usdt) ||
          new Date(existing.rows[0]?.settled_at).toISOString() !== at) {
        throw new Error("Funding transaction conflicts with recorded exchange facts");
      }
    },

    // Call only after verifying the exchange's COMPLETE settlement history
    // for this bot-owned position through its final exit. Never infer from
    // the absence of funding rows.
    async certifyFundingCoverage({ account, environment, signalId, coveredThrough }) {
      const [accountId, env] = scopedIdentity(account, environment);
      requireString(signalId, "signalId");
      const at = verifiedInstant(coveredThrough, "coveredThrough");
      await pool.query(
        `INSERT INTO btb_live_funding_coverage (account_id, environment, signal_id, covered_through)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (account_id, environment, signal_id) DO UPDATE
         SET covered_through = GREATEST(btb_live_funding_coverage.covered_through, EXCLUDED.covered_through)`,
        [accountId, env, signalId, at],
      );
    },

    async listFundingCandidates(account, environment) {
      const [accountId, env] = scopedIdentity(account, environment);
      const result = await pool.query(
        `SELECT p.signal_id, p.symbol, p.snapshot,
                (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                  'side', f.side, 'quantity', f.quantity, 'filledAt', f.filled_at,
                  'clientOrderId', f.client_order_id,
                  'state', i.state, 'phase', i.phase
                ) ORDER BY f.filled_at), '[]'::jsonb)
                 FROM btb_live_fills f JOIN btb_live_order_intents i
                   ON (f.account_id, f.environment, f.client_order_id) =
                      (i.account_id, i.environment, i.client_order_id)
                 WHERE i.account_id = p.account_id AND i.environment = p.environment
                   AND i.signal_id = p.signal_id AND f.symbol = p.symbol) AS fills,
                (SELECT COALESCE(jsonb_agg(i.client_order_id), '[]'::jsonb)
                 FROM btb_live_order_intents i WHERE i.account_id = p.account_id
                   AND i.environment = p.environment AND i.signal_id = p.signal_id
                   AND i.state = 'reconciled') AS client_ids,
                (SELECT count(*)::int FROM btb_live_order_intents i
                 WHERE i.account_id = p.account_id AND i.environment = p.environment
                   AND i.signal_id = p.signal_id AND i.state <> 'reconciled') AS unresolved
         FROM btb_live_position_snapshots p
         LEFT JOIN btb_live_funding_coverage c
           ON (p.account_id, p.environment, p.signal_id) =
              (c.account_id, c.environment, c.signal_id)
         WHERE p.account_id = $1 AND p.environment = $2 AND p.status = 'closed'
           AND c.covered_through IS NULL
         ORDER BY p.signal_id`,
        [accountId, env],
      );
      return result.rows;
    },

    async withLock(callback) {
      if (typeof callback !== "function") throw new TypeError("withLock requires a callback");
      const client = await pool.connect();
      let acquired = false;
      let destroyClient = false;
      try {
        const lock = await client.query(
          "SELECT pg_try_advisory_lock($1, $2) AS acquired",
          [LOCK_NAMESPACE, LOCK_ID],
        );
        acquired = lock.rows[0]?.acquired === true;
        if (!acquired) return null;
        return await callback();
      } finally {
        if (acquired) {
          try {
            const unlock = await client.query(
              "SELECT pg_advisory_unlock($1, $2) AS released",
              [LOCK_NAMESPACE, LOCK_ID],
            );
            if (unlock.rows[0]?.released !== true) destroyClient = true;
          } catch {
            destroyClient = true;
          }
        }
        client.release(destroyClient);
      }
    },

    async getControl() {
      const result = await pool.query(
        `SELECT kill_switch_on, blocked_reason
         FROM btb_live_control WHERE singleton = true`,
      );
      const row = result.rows[0];
      // Missing control state must be interpreted as halted, never enabled.
      const killSwitchOn = row ? row.kill_switch_on !== false : true;
      return {
        enabled: !killSwitchOn,
        blockedReason: killSwitchOn
          ? row?.blocked_reason || CONTROL_DEFAULT_REASON
          : null,
      };
    },

    async halt(reason) {
      requireString(reason, "reason");
      const detail = reason.slice(0, 2_000);
      await pool.query(
        `INSERT INTO btb_live_control (singleton, kill_switch_on, blocked_reason)
         VALUES (true, true, $1)
         ON CONFLICT (singleton) DO UPDATE SET
           kill_switch_on = true,
           blocked_reason = EXCLUDED.blocked_reason,
           updated_at = now()`,
        [detail],
      );
      return { enabled: false, blockedReason: detail };
    },

    async claim(signal, account, environment) {
      const [accountId, env] = scopedIdentity(account, environment);
      if (!signal || typeof signal !== "object" || Array.isArray(signal)) {
        throw new TypeError("signal must be a JSON object");
      }
      const signalId = requireString(
        signal.signalId ?? signal.sourceSignalId ?? signal.id,
        "signal.signalId",
      );
      const body = serialize(signal, "signal");
      const bodyHash = createHash("sha256").update(body).digest("hex");
      return inTransaction(pool, async (client) => {
        const inserted = await client.query(
          `INSERT INTO btb_live_signals
             (account_id, environment, signal_id, body, body_hash, status)
           VALUES ($1, $2, $3, $4::jsonb, $5, 'received')
           ON CONFLICT (account_id, environment, signal_id) DO NOTHING
           RETURNING signal_id`,
          [accountId, env, signalId, body, bodyHash],
        );
        if (inserted.rowCount > 0) return { kind: "new" };
        const existing = await client.query(
          `SELECT body_hash FROM btb_live_signals
           WHERE account_id = $1 AND environment = $2 AND signal_id = $3`,
          [accountId, env, signalId],
        );
        if (existing.rowCount === 0) throw new Error("Signal claim conflict could not be resolved");
        return { kind: existing.rows[0].body_hash === bodyHash ? "duplicate" : "conflict" };
      });
    },

    async hasClaim(account, environment, signalId) {
      const [accountId, env] = scopedIdentity(account, environment);
      requireString(signalId, "signalId");
      const result = await pool.query(
        `SELECT 1 FROM btb_live_signals
         WHERE account_id = $1 AND environment = $2 AND signal_id = $3`,
        [accountId, env, signalId],
      );
      return result.rowCount > 0;
    },

    async hasUnresolvedIntent(account, environment, signalId, phase) {
      const [accountId, env] = scopedIdentity(account, environment);
      requireString(signalId, "signalId");
      requireString(phase, "phase");
      const result = await pool.query(
        `SELECT 1 FROM btb_live_order_intents
         WHERE account_id = $1 AND environment = $2 AND signal_id = $3
           AND phase = $4 AND state IN ('pending', 'submitted', 'unknown')
         LIMIT 1`,
        [accountId, env, signalId, phase],
      );
      return result.rowCount > 0;
    },

    async reserveIntent({ account, environment, signalId, phase, clientOrderId, details }) {
      const [accountId, env] = scopedIdentity(account, environment);
      requireString(signalId, "signalId");
      requireString(phase, "phase");
      requireString(clientOrderId, "clientOrderId");
      const request = serialize(details ?? {}, "intent details");
      return inTransaction(pool, async (client) => {
        const inserted = await client.query(
          `INSERT INTO btb_live_order_intents
             (account_id, environment, signal_id, phase, client_order_id, request, state)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'pending')
           ON CONFLICT (client_order_id) DO NOTHING
           RETURNING id`,
          [accountId, env, signalId, phase, clientOrderId, request],
        );
        if (inserted.rowCount > 0) return { kind: "new" };
        const existing = await client.query(
          `SELECT account_id, environment, signal_id, phase, request
           FROM btb_live_order_intents WHERE client_order_id = $1`,
          [clientOrderId],
        );
        if (existing.rowCount === 0) throw new Error("Order intent conflict could not be resolved");
        const row = existing.rows[0];
        if (
          row.account_id !== accountId ||
          row.environment !== env ||
          row.signal_id !== signalId ||
          row.phase !== phase ||
          JSON.stringify(canonicalize(row.request)) !== request
        ) {
          throw new Error("clientOrderId is already reserved for a different order intent");
        }
        return { kind: "existing" };
      });
    },

    async markIntent(clientOrderId, state, detail = {}) {
      requireString(clientOrderId, "clientOrderId");
      if (!INTENT_STATES.has(state)) throw new TypeError(`Unsupported intent state: ${String(state)}`);
      const serializedDetail = serialize(detail, "intent detail");
      return inTransaction(pool, async (client) => {
        const intent = await client.query(
          `SELECT account_id, environment, state
           FROM btb_live_order_intents WHERE client_order_id = $1 FOR UPDATE`,
          [clientOrderId],
        );
        if (intent.rowCount === 0) return null;
        const row = intent.rows[0];
        const allowedTransitions = {
          pending: new Set(["pending", "submitted", "unknown", "reconciled"]),
          submitted: new Set(["submitted", "unknown", "reconciled"]),
          unknown: new Set(["unknown", "reconciled"]),
          reconciled: new Set(["reconciled"]),
        };
        if (!allowedTransitions[row.state]?.has(state)) {
          throw new Error(`Invalid live intent transition: ${row.state} -> ${state}`);
        }
        const attemptCount = await client.query(
          `SELECT count(*)::int AS count FROM btb_live_order_attempts
           WHERE account_id = $1 AND environment = $2 AND client_order_id = $3`,
          [row.account_id, row.environment, clientOrderId],
        );
        const attemptNumber = attemptCount.rows[0].count + 1;
        await client.query(
          `INSERT INTO btb_live_order_attempts
             (account_id, environment, client_order_id, attempt_number, state, response, finished_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())`,
          [row.account_id, row.environment, clientOrderId, attemptNumber, state, serializedDetail],
        );
        const updated = await client.query(
          `UPDATE btb_live_order_intents SET state = $2, updated_at = now()
           WHERE client_order_id = $1
           RETURNING account_id, environment, signal_id, phase, client_order_id, state, updated_at`,
          [clientOrderId, state],
        );
        return updated.rows[0];
      });
    },

    async saveFill(fill) {
      const [accountId, env] = scopedIdentity(fill?.account, fill?.environment);
      const tradeId = requireString(fill?.tradeId, "tradeId");
      const clientOrderId = requireString(fill?.clientOrderId, "clientOrderId");
      const symbol = requireString(fill?.symbol, "symbol");
      const side = requireString(fill?.side, "side");
      const quantity = String(fill?.quantity);
      const price = String(fill?.price);
      if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) throw new TypeError("quantity must be positive");
      if (!Number.isFinite(Number(price)) || Number(price) <= 0) throw new TypeError("price must be positive");
      const detail = serialize(fill.detail ?? {}, "fill detail");
      const result = await pool.query(
        `INSERT INTO btb_live_fills
           (account_id, environment, exchange_fill_id, client_order_id, symbol, side,
            quantity, price, fee, fee_asset, detail, filled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
         ON CONFLICT (account_id, environment, exchange_fill_id) DO NOTHING
         RETURNING id`,
        [
          accountId, env, tradeId, clientOrderId, symbol, side, quantity, price,
          fill.fee == null ? null : String(fill.fee), fill.feeAsset ?? null,
          detail, fill.filledAt ?? null,
        ],
      );
      if (result.rowCount === 0) {
        const existing = await pool.query(
          `SELECT client_order_id, symbol, side, quantity, price, fee, fee_asset
           FROM btb_live_fills
           WHERE account_id = $1 AND environment = $2 AND exchange_fill_id = $3`,
          [accountId, env, tradeId],
        );
        const row = existing.rows[0];
        if (existing.rowCount !== 1 || row.client_order_id !== clientOrderId ||
            row.symbol !== symbol || row.side !== side ||
            Number(row.quantity) !== Number(quantity) ||
            Number(row.price) !== Number(price) ||
            (row.fee == null ? null : Number(row.fee)) !==
              (fill.fee == null ? null : Number(fill.fee)) ||
            row.fee_asset !== (fill.feeAsset ?? null)) {
          throw new Error("Exchange fill ID already belongs to different execution facts");
        }
      }
      return { kind: result.rowCount > 0 ? "new" : "existing" };
    },

    async savePosition({ account, environment, signalId, snapshot }) {
      const [accountId, env] = scopedIdentity(account, environment);
      requireString(signalId, "signalId");
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
        throw new TypeError("snapshot must be a JSON object");
      }
      const symbol = requireString(snapshot.symbol, "snapshot.symbol");
      const status = snapshot.status ?? "open";
      if (!POSITION_STATES.has(status)) throw new TypeError(`Unsupported position status: ${String(status)}`);
      const serialized = serialize(snapshot, "position snapshot");
      const result = await pool.query(
        `INSERT INTO btb_live_position_snapshots
           (account_id, environment, signal_id, symbol, status, quantity,
            entry_price, mark_price, unrealized_pnl, snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
         ON CONFLICT (account_id, environment, signal_id) DO UPDATE SET
           symbol = EXCLUDED.symbol,
           status = EXCLUDED.status,
           quantity = EXCLUDED.quantity,
           entry_price = EXCLUDED.entry_price,
           mark_price = EXCLUDED.mark_price,
           unrealized_pnl = EXCLUDED.unrealized_pnl,
           snapshot = EXCLUDED.snapshot,
           captured_at = now()
         RETURNING account_id, environment, signal_id, symbol, status, snapshot, captured_at`,
        [
          accountId, env, signalId, symbol, status,
          snapshot.quantity == null ? "0" : String(snapshot.quantity),
          snapshot.entryPrice == null ? null : String(snapshot.entryPrice),
          snapshot.markPrice == null ? null : String(snapshot.markPrice),
          snapshot.unrealizedPnl == null ? null : String(snapshot.unrealizedPnl),
          serialized,
        ],
      );
      return rowToPosition(result.rows[0]);
    },

    async commitVerifiedClose({ account, environment, signalId, clientOrderId, fills, snapshot, detail }) {
      const [accountId, env] = scopedIdentity(account, environment);
      requireString(signalId, "signalId");
      requireString(clientOrderId, "clientOrderId");
      if (snapshot?.status !== "closed" || snapshot.remainingQty !== 0 ||
          !Array.isArray(fills) || fills.length === 0) {
        throw new TypeError("A verified close requires a flat snapshot and fills");
      }
      const symbol = requireString(snapshot.symbol, "snapshot.symbol");
      const serializedSnapshot = serialize(snapshot, "position snapshot");
      const serializedDetail = serialize(detail, "intent detail");
      return inTransaction(pool, async (client) => {
        const intent = await client.query(
          `SELECT account_id, environment, signal_id, state
           FROM btb_live_order_intents WHERE client_order_id = $1 FOR UPDATE`,
          [clientOrderId],
        );
        const row = intent.rows[0];
        if (intent.rowCount !== 1 || row.account_id !== accountId ||
            row.environment !== env || row.signal_id !== signalId ||
            row.state !== "unknown") {
          throw new Error("Verified close intent is missing, changed, or already reconciled");
        }
        for (const fill of fills) {
          if (fill.clientOrderId !== clientOrderId ||
              fill.symbol !== symbol || fill.side !== "SELL" ||
              !Number.isFinite(Number(fill.quantity)) || Number(fill.quantity) <= 0 ||
              !Number.isFinite(Number(fill.price)) || Number(fill.price) <= 0) {
            throw new Error("Verified close contains an invalid fill");
          }
          const result = await client.query(
            `INSERT INTO btb_live_fills
               (account_id, environment, exchange_fill_id, client_order_id, symbol, side,
                quantity, price, fee, fee_asset, detail, filled_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
             ON CONFLICT (account_id, environment, exchange_fill_id) DO NOTHING
             RETURNING id`,
            [
              accountId, env, requireString(fill.tradeId, "tradeId"),
              clientOrderId, symbol, "SELL", String(fill.quantity), String(fill.price),
              fill.fee == null ? null : String(fill.fee), fill.feeAsset ?? null,
              serialize(fill.detail ?? {}, "fill detail"), fill.filledAt ?? null,
            ],
          );
          if (result.rowCount === 0) {
            const previous = await client.query(
              `SELECT client_order_id, symbol, side, quantity, price, fee, fee_asset
               FROM btb_live_fills WHERE account_id = $1 AND environment = $2 AND exchange_fill_id = $3`,
              [accountId, env, fill.tradeId],
            );
            const old = previous.rows[0];
            if (previous.rowCount !== 1 || old.client_order_id !== clientOrderId ||
                old.symbol !== symbol || old.side !== "SELL" ||
                Number(old.quantity) !== Number(fill.quantity) ||
                Number(old.price) !== Number(fill.price) ||
                (old.fee == null ? null : Number(old.fee)) !==
                  (fill.fee == null ? null : Number(fill.fee)) ||
                old.fee_asset !== (fill.feeAsset ?? null)) {
              throw new Error("Exchange fill ID already belongs to different execution facts");
            }
          }
        }
        const closed = await client.query(
          `UPDATE btb_live_position_snapshots
           SET status = 'closed', quantity = $4, entry_price = $5, mark_price = $6,
               unrealized_pnl = $7, snapshot = $8::jsonb, captured_at = now()
           WHERE account_id = $1 AND environment = $2 AND signal_id = $3 AND status = 'open'
           RETURNING account_id, environment, signal_id, symbol, status, snapshot, captured_at`,
          [
            accountId, env, signalId,
            snapshot.quantity == null ? "0" : String(snapshot.quantity),
            snapshot.entryPrice == null ? null : String(snapshot.entryPrice),
            snapshot.markPrice == null ? null : String(snapshot.markPrice),
            snapshot.unrealizedPnl == null ? null : String(snapshot.unrealizedPnl),
            serializedSnapshot,
          ],
        );
        if (closed.rowCount !== 1 || closed.rows[0].symbol !== symbol) {
          throw new Error("Verified close has no matching open position snapshot");
        }
        const attempts = await client.query(
          `SELECT count(*)::int AS count FROM btb_live_order_attempts
           WHERE account_id = $1 AND environment = $2 AND client_order_id = $3`,
          [accountId, env, clientOrderId],
        );
        await client.query(
          `INSERT INTO btb_live_order_attempts
             (account_id, environment, client_order_id, attempt_number, state, response, finished_at)
           VALUES ($1, $2, $3, $4, 'reconciled', $5::jsonb, now())`,
          [accountId, env, clientOrderId, attempts.rows[0].count + 1, serializedDetail],
        );
        await client.query(
          `UPDATE btb_live_order_intents SET state = 'reconciled', updated_at = now()
           WHERE client_order_id = $1`,
          [clientOrderId],
        );
        await client.query(
          `INSERT INTO btb_live_events
             (account_id, environment, signal_id, client_order_id, kind, detail)
           VALUES ($1, $2, $3, $4, 'live_fills_recorded', $5::jsonb)`,
          [accountId, env, signalId, clientOrderId,
            serialize({ count: fills.length }, "event detail")],
        );
        return rowToPosition(closed.rows[0]);
      });
    },

    async getPosition(account, environment, signalId) {
      const [accountId, env] = scopedIdentity(account, environment);
      requireString(signalId, "signalId");
      const result = await pool.query(
        `SELECT account_id, environment, signal_id, symbol, status, snapshot, captured_at
         FROM btb_live_position_snapshots
         WHERE account_id = $1 AND environment = $2 AND signal_id = $3`,
        [accountId, env, signalId],
      );
      return rowToPosition(result.rows[0]);
    },

    async listActive(account, environment) {
      const [accountId, env] = scopedIdentity(account, environment);
      const result = await pool.query(
        `SELECT account_id, environment, signal_id, symbol, status, snapshot, captured_at
         FROM btb_live_position_snapshots
         WHERE account_id = $1 AND environment = $2 AND status IN ('open', 'opening', 'closing')
         ORDER BY captured_at ASC, signal_id ASC`,
        [accountId, env],
      );
      return result.rows.map(rowToPosition);
    },

    async recordEvent({ account = null, environment = null, signalId = null, clientOrderId = null, kind, detail = {} }) {
      requireString(kind, "kind");
      const serialized = serialize(detail, "event detail");
      const result = await pool.query(
        `INSERT INTO btb_live_events
           (account_id, environment, signal_id, client_order_id, kind, detail)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         RETURNING id, account_id, environment, signal_id, client_order_id, kind, detail, created_at`,
        [account, environment, signalId, clientOrderId, kind, serialized],
      );
      return result.rows[0];
    },
  };
}