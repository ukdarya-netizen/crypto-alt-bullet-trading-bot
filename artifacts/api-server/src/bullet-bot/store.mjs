import { createHash } from "node:crypto";
import {
  paperFeeModel,
  paperFillCosts,
} from "./paper-fees.mjs";
import { PAPER_BASE_MARGIN_USDT } from "./paper-margin.mjs";
import { buildSourceExitEvidence, sourceExitRequestPredicate } from "./source-exit-evidence.mjs";

const ADVISORY_LOCK_NAMESPACE = 4_348_994;
const ADVISORY_LOCK_ID = 1;

const SIGNAL_STATUSES = new Set([
  "pending",
  "opening",
  "open",
  "closed",
  "rejected",
  "quarantined",
  "error",
]);
const POSITION_STATUSES = new Set(["open", "closing", "closed", "error"]);
const SECRET_KEY = /(api[_-]?key|secret|password|token|authorization|credential)/i;
const MAX_REASON_LENGTH = 2_000;

/**
 * Convert JSON-compatible input to a deterministic JSON value.
 * Sorted object keys ensure semantically identical signal retries hash equally.
 */
function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Signal values must contain only finite numbers");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError("Signal values must be JSON-compatible");
  }
  if (seen.has(value)) {
    throw new TypeError("Signal values must not contain circular references");
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalize(item, seen));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Signal objects must be plain JSON objects");
    }

    const output = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child === undefined) {
        throw new TypeError("Signal objects must not contain undefined values");
      }
      output[key] = canonicalize(child, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function assertNoCredentials(value, path = "value") {
  if (value === null || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      throw new TypeError(`Credentials are not allowed in persisted ${path}`);
    }
    assertNoCredentials(child, `${path}.${key}`);
  }
}

function serializeJson(value, label) {
  assertNoCredentials(value, label);
  return JSON.stringify(canonicalize(value));
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function validateStatus(status, validStatuses, name) {
  if (!validStatuses.has(status)) {
    throw new TypeError(`Unsupported ${name}: ${String(status)}`);
  }
}

function toRow(row) {
  if (!row) return null;
  return {
    sourceSignalId: row.source_signal_id,
    body: row.body,
    bodyHash: row.body_hash,
    status: row.status,
    reason: row.reason,
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
  };
}

function paperAccountFromRow(row) {
  if (!row) return null;
  return {
    initialUsdt: Number(row.initial_usdt),
    freeUsdt: Number(row.free_usdt),
    reservedUsdt: Number(row.reserved_usdt),
    realizedPnlUsdt: Number(row.realized_pnl_usdt),
  };
}

function finiteUsdt(value, name) {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount)) {
    throw new TypeError(`${name} must be a finite USDT amount`);
  }
  return amount;
}

function serializeEvents(events) {
  if (!Array.isArray(events)) {
    throw new TypeError("events must be an array");
  }
  return events.map((event) => {
    requireNonEmptyString(event?.kind, "event.kind");
    return {
      kind: event.kind,
      detail: serializeJson(event.detail ?? {}, "event detail"),
    };
  });
}

function sourceExitRequestKey(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
  throw new TypeError("sourceExitRequestId must be a positive event id");
}

async function finishSourceExitRequestInTransaction(
  client,
  sourceSignalId,
  requestId,
  expectedEvidence,
) {
  const id = sourceExitRequestKey(requestId);
  const request = await client.query(
    `
      SELECT id, detail
      FROM btb_events
      WHERE id = $2::bigint
        AND source_signal_id = $1
        AND kind = 'paper_source_exit_requested'
      FOR UPDATE
    `,
    [sourceSignalId, id],
  );
  if (request.rowCount === 0) return false;
  if (
    !expectedEvidence ||
    serializeJson(expectedEvidence, "source exit completion evidence") !==
      serializeJson(request.rows[0].detail, "source exit request evidence")
  ) return false;

  const alreadyFinished = await client.query(
    `
      SELECT id
      FROM btb_events
      WHERE source_signal_id = $1
        AND kind = 'paper_source_exit_applied'
        AND detail->>'requestId' = $2
      LIMIT 1
    `,
    [sourceSignalId, id],
  );
  if (alreadyFinished.rowCount > 0) return true;

  const detail = serializeJson({
    requestId: id,
    finishedAt: new Date().toISOString(),
  }, "source exit completion");
  await client.query(
    `
      INSERT INTO btb_events (source_signal_id, kind, detail)
      VALUES ($1, 'paper_source_exit_applied', $2::jsonb)
    `,
    [sourceSignalId, detail],
  );
  return true;
}

async function insertEvents(client, sourceSignalId, events) {
  for (const event of events) {
    await client.query(
      `
        INSERT INTO btb_events (source_signal_id, kind, detail)
        VALUES ($1, $2, $3::jsonb)
      `,
      [sourceSignalId, event.kind, event.detail],
    );
  }
}

function positionFromRow(row) {
  if (!row) return null;
  return {
    sourceSignalId: row.source_signal_id,
    snapshot: row.snapshot,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

export function hashSignal(signal) {
  const canonicalJson = serializeJson(signal, "signal");
  return createHash("sha256").update(canonicalJson).digest("hex");
}

/**
 * Create accessors for the separately provisioned btb_* tables.
 * Schema installation is intentionally a manual deployment/migration step.
 */
export function createStore(pool) {
  if (
    !pool ||
    typeof pool.query !== "function" ||
    typeof pool.connect !== "function"
  ) {
    throw new TypeError("createStore requires a PostgreSQL pool");
  }

  return {
    /**
     * Persist the event before acknowledging it. A duplicate with the same ID
     * and canonical body is safe to acknowledge; reuse of an ID with changed
     * content is returned as a conflict and must not create another trade.
     */
    async enqueue(signal) {
      const sourceSignalId = requireNonEmptyString(
        signal?.sourceSignalId,
        "sourceSignalId",
      );
      const body = serializeJson(signal, "signal");
      const bodyHash = createHash("sha256").update(body).digest("hex");
      const inserted = await pool.query(
        `
          INSERT INTO btb_signals
            (source_signal_id, body, body_hash, status)
          VALUES ($1, $2::jsonb, $3, 'pending')
          ON CONFLICT (source_signal_id) DO NOTHING
          RETURNING source_signal_id, status
        `,
        [sourceSignalId, body, bodyHash],
      );
      if (inserted.rowCount > 0) {
        return {
          kind: "new",
          status: inserted.rows[0].status,
        };
      }

      // ON CONFLICT waits for a concurrent insert to commit before this read.
      const existing = await pool.query(
        `
          SELECT body_hash, status
          FROM btb_signals
          WHERE source_signal_id = $1
        `,
        [sourceSignalId],
      );
      if (existing.rowCount === 0) {
        throw new Error("Signal insert conflict could not be resolved");
      }

      const row = existing.rows[0];
      return {
        kind: row.body_hash === bodyHash ? "duplicate" : "conflict",
        status: row.status,
      };
    },

    /**
     * Serialize worker activity across replicas. Advisory locks are held on a
     * dedicated session for the whole callback and explicitly released even
     * when the callback fails.
     */
    async withLeaderLock(callback) {
      if (typeof callback !== "function") {
        throw new TypeError("withLeaderLock requires a callback");
      }
      const client = await pool.connect();
      let lockAcquired = false;
      let destroyClient = false;
      try {
        const result = await client.query(
          "SELECT pg_try_advisory_lock($1, $2) AS acquired",
          [ADVISORY_LOCK_NAMESPACE, ADVISORY_LOCK_ID],
        );
        lockAcquired = result.rows[0]?.acquired === true;
        if (!lockAcquired) return null;
        return await callback();
      } finally {
        if (lockAcquired) {
          try {
            const unlocked = await client.query(
              "SELECT pg_advisory_unlock($1, $2) AS released",
              [ADVISORY_LOCK_NAMESPACE, ADVISORY_LOCK_ID],
            );
            if (unlocked.rows[0]?.released !== true) destroyClient = true;
          } catch {
            // Returning a session with a possibly held session lock to the pool
            // could permanently block the worker; destroy it instead.
            destroyClient = true;
          }
        }
        client.release(destroyClient);
      }
    },

    /**
     * Must be called by the leader-locked worker. "opening" rows are surfaced
     * first so an exchange submission with an uncertain response can be
     * reconciled using its deterministic order link ID, not blindly retried.
     */
    async getPending(now = Date.now()) {
      const timestamp = now instanceof Date ? now.getTime() : Number(now);
      if (!Number.isFinite(timestamp)) {
        throw new TypeError("now must be a valid timestamp");
      }
      const result = await pool.query(
        `
          SELECT source_signal_id, body, body_hash, status, reason,
                 received_at, updated_at
          FROM btb_signals
          WHERE status IN ('opening', 'pending')
          ORDER BY CASE WHEN status = 'opening' THEN 0 ELSE 1 END,
                   received_at ASC, source_signal_id ASC
          LIMIT 1
        `,
      );
      return toRow(result.rows[0]);
    },

    async setSignalStatus(sourceSignalId, status, reason = null) {
      requireNonEmptyString(sourceSignalId, "sourceSignalId");
      validateStatus(status, SIGNAL_STATUSES, "signal status");
      if (reason !== null && typeof reason !== "string") {
        throw new TypeError("reason must be a string or null");
      }
      if (reason !== null && reason.length > MAX_REASON_LENGTH) {
        throw new RangeError(`reason must be at most ${MAX_REASON_LENGTH} characters`);
      }

      const result = await pool.query(
        `
          UPDATE btb_signals
          SET status = $2, reason = $3, updated_at = now()
          WHERE source_signal_id = $1
          RETURNING source_signal_id, body, body_hash, status, reason,
                    received_at, updated_at
        `,
        [sourceSignalId, status, reason],
      );
      return toRow(result.rows[0]);
    },

    async upsertPosition(position) {
      const sourceSignalId = requireNonEmptyString(
        position?.sourceSignalId,
        "position.sourceSignalId",
      );
      validateStatus(position.status, POSITION_STATUSES, "position status");
      const snapshot = serializeJson(position, "position");
      const result = await pool.query(
        `
          INSERT INTO btb_positions
            (source_signal_id, snapshot, status)
          VALUES ($1, $2::jsonb, $3)
          ON CONFLICT (source_signal_id)
          DO UPDATE SET
            snapshot = EXCLUDED.snapshot,
            status = EXCLUDED.status,
            updated_at = now()
          RETURNING source_signal_id, snapshot, status, updated_at
        `,
        [sourceSignalId, snapshot, position.status],
      );
      return {
        sourceSignalId: result.rows[0].source_signal_id,
        snapshot: result.rows[0].snapshot,
        status: result.rows[0].status,
        updatedAt: result.rows[0].updated_at,
      };
    },

    async listOpenPositions() {
      const result = await pool.query(
        `
          SELECT source_signal_id, snapshot, status, updated_at
          FROM btb_positions
          WHERE status IN ('open', 'closing')
          ORDER BY updated_at ASC, source_signal_id ASC
        `,
      );
      return result.rows.map((row) => ({
        sourceSignalId: row.source_signal_id,
        snapshot: row.snapshot,
        status: row.status,
        updatedAt: row.updated_at,
      }));
    },

    /**
     * Durably enqueue source-confirmed closures and reclassification
     * withdrawals for open PAPER positions. The position row lock serializes
     * concurrent polls with each other and with PAPER settlement; an existing
     * request remains authoritative even if a later source poll is active.
     */
    async queueSourceExitRequests({ asOf, positions, observedAt } = {}) {
      let sourceById;
      if (positions instanceof Map) {
        sourceById = positions;
      } else if (Array.isArray(positions)) {
        sourceById = new Map(positions
          .filter((source) => source && typeof source === "object")
          .map((source) => [source.sourceSignalId, source]));
      } else {
        throw new TypeError("positions must be a Map or an array of source positions");
      }

      const client = await pool.connect();
      let transactionOpen = false;
      const result = { queued: [], refreshed: [], rejected: [] };
      try {
        await client.query("BEGIN");
        transactionOpen = true;
        const open = await client.query(
          `
            SELECT source_signal_id
            FROM btb_positions
            WHERE status = 'open'
              AND COALESCE(snapshot->>'mode', 'paper') = 'paper'
            ORDER BY source_signal_id
          `,
        );
        for (const { source_signal_id: sourceSignalId } of open.rows) {
          const source = sourceById.get(sourceSignalId);
          if (!source || typeof source !== "object") continue;
          const currentResult = await client.query(
            `
              SELECT snapshot
              FROM btb_positions
              WHERE source_signal_id = $1
                AND status = 'open'
                AND COALESCE(snapshot->>'mode', 'paper') = 'paper'
              FOR UPDATE
            `,
            [sourceSignalId],
          );
          if (currentResult.rowCount === 0) continue;
          const rawSnapshot = currentResult.rows[0].snapshot;
          const snapshot = typeof rawSnapshot === "string"
            ? JSON.parse(rawSnapshot)
            : rawSnapshot;
          if (
            !Number.isFinite(Number(snapshot?.remainingQty)) ||
            Number(snapshot.remainingQty) <= 0
          ) continue;
          const evidence = buildSourceExitEvidence(source, {
            sourceSignalId,
            symbol: snapshot?.symbol,
            entryAt: snapshot?.entryAt,
            signalAt: source.signalAt ?? snapshot?.signalAt,
            asOf,
            observedAt,
          });
          if (!evidence) continue;

          const existing = await client.query(
            `
              SELECT id, detail, created_at
              FROM btb_events
              WHERE source_signal_id = $1
                AND kind = 'paper_source_exit_requested'
                AND ${sourceExitRequestPredicate("detail")}
              ORDER BY id
              LIMIT 1
              FOR UPDATE
            `,
            [sourceSignalId],
          );
          if (existing.rowCount > 0) {
            const row = existing.rows[0];
            result.refreshed.push({
              id: row.id,
              sourceSignalId,
              evidence: row.detail,
              createdAt: row.created_at,
            });
            continue;
          }

          const detail = serializeJson(evidence, "source exit evidence");
          const inserted = await client.query(
            `
              INSERT INTO btb_events (source_signal_id, kind, detail)
              VALUES ($1, 'paper_source_exit_requested', $2::jsonb)
              RETURNING id, detail, created_at
            `,
            [sourceSignalId, detail],
          );
          const row = inserted.rows[0];
          result.queued.push({
            id: row.id,
            sourceSignalId,
            evidence: row.detail ?? evidence,
            createdAt: row.created_at,
          });
        }
        await client.query("COMMIT");
        transactionOpen = false;
        return result;
      } catch (error) {
        if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async listPendingSourceExitRequests({ sourceSignalId = null, limit = 100 } = {}) {
      if (sourceSignalId !== null) {
        requireNonEmptyString(sourceSignalId, "sourceSignalId");
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
        throw new RangeError("source exit request limit must be 1..1000");
      }
      const result = await pool.query(
        `
          SELECT request.id, request.source_signal_id, request.detail, request.created_at
          FROM btb_events request
          WHERE request.kind = 'paper_source_exit_requested'
            AND ${sourceExitRequestPredicate("request.detail")}
            AND ($1::text IS NULL OR request.source_signal_id = $1)
            AND NOT EXISTS (
              SELECT 1
              FROM btb_events applied
              WHERE applied.source_signal_id = request.source_signal_id
                AND applied.kind = 'paper_source_exit_applied'
                AND applied.detail->>'requestId' = request.id::text
            )
          ORDER BY request.id
          LIMIT $2
        `,
        [sourceSignalId, limit],
      );
      return result.rows.map((row) => ({
        id: row.id,
        sourceSignalId: row.source_signal_id,
        evidence: row.detail,
        createdAt: row.created_at,
      }));
    },

    async hasPendingSourceExitRequest(sourceSignalId) {
      requireNonEmptyString(sourceSignalId, "sourceSignalId");
      const result = await pool.query(
        `
          SELECT request.id
          FROM btb_events request
          WHERE request.source_signal_id = $1
            AND request.kind = 'paper_source_exit_requested'
            AND ${sourceExitRequestPredicate("request.detail")}
            AND NOT EXISTS (
              SELECT 1
              FROM btb_events applied
              WHERE applied.source_signal_id = request.source_signal_id
                AND applied.kind = 'paper_source_exit_applied'
                AND applied.detail->>'requestId' = request.id::text
            )
          LIMIT 1
        `,
        [sourceSignalId],
      );
      return result.rowCount > 0;
    },

    /**
     * Explicit completion is safe only after the matching PAPER position has
     * committed closed provenance. settlePaperPosition normally records this
     * acknowledgement atomically with the close.
     */
    async finishSourceExitRequest(sourceSignalId, requestId) {
      requireNonEmptyString(sourceSignalId, "sourceSignalId");
      const client = await pool.connect();
      let transactionOpen = false;
      try {
        await client.query("BEGIN");
        transactionOpen = true;
        const positionResult = await client.query(
          `
            SELECT status, snapshot
            FROM btb_positions
            WHERE source_signal_id = $1
            FOR UPDATE
          `,
          [sourceSignalId],
        );
        if (positionResult.rowCount === 0) {
          throw new Error("Cannot finish a source exit request without its PAPER position");
        }
        const row = positionResult.rows[0];
        const snapshot = typeof row.snapshot === "string"
          ? JSON.parse(row.snapshot)
          : row.snapshot;
        const provenance = snapshot?.sourceWithdrawal ?? snapshot?.sourceClosure;
        if (
          row.status !== "closed" ||
          snapshot?.status !== "closed" ||
          provenance?.sourceSignalId !== sourceSignalId
        ) {
          throw new Error("Cannot finish a source exit request before its PAPER close is committed");
        }
        const finished = await finishSourceExitRequestInTransaction(
          client,
          sourceSignalId,
          requestId,
          provenance,
        );
        if (!finished) throw new Error("Source exit request was not found");
        await client.query("COMMIT");
        transactionOpen = false;
        return true;
      } catch (error) {
        if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async listPendingScenarios() {
      const result = await pool.query(`
        SELECT source_signal_id, snapshot, status, updated_at
        FROM btb_positions
        WHERE status = 'closed'
          AND snapshot->>'mode' = 'paper'
          AND snapshot->'scenarioModel'->>'version' = 'prospective_observed_quotes_v1'
          AND (
            snapshot->'scenarioModel'->'variants'->'1'->>'status' = 'open'
            OR snapshot->'scenarioModel'->'variants'->'2'->>'status' = 'open'
            OR snapshot->'scenarioModel'->'variants'->'3'->>'status' = 'open'
            OR snapshot->'scenarioModel'->'variants'->'4'->>'status' = 'open'
          )
        ORDER BY updated_at ASC
      `);
      return result.rows.map(positionFromRow);
    },

    async updateClosedScenarios(sourceSignalId, previous, next) {
      const result = await pool.query(`
        UPDATE btb_positions
        SET snapshot = jsonb_set(snapshot, '{scenarioModel}', $3::jsonb),
            updated_at = now()
        WHERE source_signal_id = $1 AND status = 'closed'
          AND snapshot->'scenarioModel' = $2::jsonb
        RETURNING source_signal_id
      `, [
        requireNonEmptyString(sourceSignalId, "sourceSignalId"),
        serializeJson(previous, "previous scenario"),
        serializeJson(next, "next scenario"),
      ]);
      return result.rowCount === 1;
    },

    async listClosedPaperPositions(limit = 10) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new RangeError("Closed PAPER position limit must be 1..50");
      }
      const result = await pool.query(
        `
          SELECT source_signal_id, snapshot, status, updated_at
          FROM btb_positions
          WHERE status = 'closed'
            AND COALESCE(snapshot->>'mode', 'paper') = 'paper'
          ORDER BY updated_at DESC, source_signal_id DESC
          LIMIT $1
        `,
        [limit],
      );
      return result.rows.map(positionFromRow);
    },

    async updatePosition(sourceSignalId, patch) {
      requireNonEmptyString(sourceSignalId, "sourceSignalId");
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw new TypeError("patch must be a JSON object");
      }
      const serializedPatch = serializeJson(patch, "position patch");
      const status =
        patch.status === undefined ? null : patch.status;
      if (status !== null) {
        validateStatus(status, POSITION_STATUSES, "position status");
      }

      const result = await pool.query(
        `
          UPDATE btb_positions
          SET snapshot = snapshot || $2::jsonb,
              status = COALESCE($3, status),
              updated_at = now()
          WHERE source_signal_id = $1
          RETURNING source_signal_id, snapshot, status, updated_at
        `,
        [sourceSignalId, serializedPatch, status],
      );
      if (result.rowCount === 0) return null;
      return {
        sourceSignalId: result.rows[0].source_signal_id,
        snapshot: result.rows[0].snapshot,
        status: result.rows[0].status,
        updatedAt: result.rows[0].updated_at,
      };
    },

    async getPaperAccount() {
      const result = await pool.query(
        `
          SELECT initial_usdt, free_usdt, reserved_usdt, realized_pnl_usdt
          FROM btb_paper_account
          WHERE singleton = true
        `,
      );
      if (result.rowCount === 0) {
        throw new Error("Paper account is not initialized; apply schema.sql first");
      }
      return paperAccountFromRow(result.rows[0]);
    },

    /**
     * One SQL statement means every wallet, open-position and funding read
     * observes the same PostgreSQL MVCC snapshot while the worker commits.
     */
    async getPaperDashboardSnapshot() {
      const result = await pool.query(`
        SELECT
          (
            SELECT row_to_json(account_row)
            FROM (
              SELECT initial_usdt, free_usdt, reserved_usdt, realized_pnl_usdt
              FROM btb_paper_account
              WHERE singleton = true
            ) account_row
          ) AS account,
          COALESCE((
            SELECT json_agg(row_to_json(position_row))
            FROM (
              SELECT source_signal_id, snapshot, status, updated_at
              FROM btb_positions
              WHERE status IN ('open', 'closing')
              ORDER BY updated_at ASC, source_signal_id ASC
            ) position_row
          ), '[]'::json) AS positions,
          COALESCE((
            SELECT json_agg(row_to_json(position_row))
            FROM (
              SELECT source_signal_id, snapshot, status, updated_at
              FROM btb_positions
              WHERE status = 'closed'
                AND COALESCE(snapshot->>'mode', 'paper') = 'paper'
              ORDER BY updated_at DESC, source_signal_id DESC
              LIMIT 10
            ) position_row
          ), '[]'::json) AS recent_closed_positions,
          (
            SELECT row_to_json(health_row)
            FROM (
              SELECT
                COUNT(*) FILTER (
                  WHERE snapshot->>'fundingStatus' = 'incomplete'
                )::integer AS incomplete_count,
                COUNT(*) FILTER (
                  WHERE snapshot->>'fundingStatus' IS DISTINCT FROM 'current'
                    AND snapshot->>'fundingStatus' IS DISTINCT FROM 'incomplete'
                )::integer AS legacy_unknown_count,
                COALESCE(SUM((
                  SELECT count(*) FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(snapshot->'fundingSettlements') = 'array'
                      THEN snapshot->'fundingSettlements' ELSE '[]'::jsonb END
                  ) settlement WHERE settlement->>'status' = 'applied'
                )), 0)::integer AS verified_settlement_count,
                COALESCE(SUM((
                  SELECT COALESCE(SUM((settlement->>'signedCostUsdt')::numeric), 0)
                  FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(snapshot->'fundingSettlements') = 'array'
                      THEN snapshot->'fundingSettlements' ELSE '[]'::jsonb END
                  ) settlement WHERE settlement->>'status' = 'applied'
                )), 0)::text AS verified_net_cost_usdt,
                COALESCE(json_agg(json_build_object(
                  'symbol', COALESCE(snapshot->>'symbol', 'Неизвестный контракт'),
                  'fromAt', snapshot->>'entryAt',
                  'status', status,
                  'verifiedSettlements', (
                    SELECT count(*) FROM jsonb_array_elements(
                      CASE WHEN jsonb_typeof(snapshot->'fundingSettlements') = 'array'
                        THEN snapshot->'fundingSettlements' ELSE '[]'::jsonb END
                    ) settlement WHERE settlement->>'status' = 'applied'
                  ),
                  'verifiedFundingTimes', (
                    SELECT COALESCE(json_agg((settlement->>'fundingTime')::bigint ORDER BY (settlement->>'fundingTime')::bigint), '[]'::json)
                    FROM jsonb_array_elements(
                      CASE WHEN jsonb_typeof(snapshot->'fundingSettlements') = 'array'
                        THEN snapshot->'fundingSettlements' ELSE '[]'::jsonb END
                    ) settlement WHERE settlement->>'status' = 'applied'
                  )
                ) ORDER BY snapshot->>'entryAt')
                FILTER (WHERE snapshot->>'fundingStatus' IS DISTINCT FROM 'current'), '[]'::json
                ) AS unverified_positions
              FROM btb_positions
              WHERE COALESCE(snapshot->>'mode', 'paper') = 'paper'
            ) health_row
          ) AS funding_health
      `);
      const row = result.rows[0];
      if (!row?.account) {
        throw new Error("Paper account is not initialized; apply schema.sql first");
      }
      return {
        paperAccount: paperAccountFromRow(row.account),
        positions: row.positions.map(positionFromRow),
        recentClosedPositions: row.recent_closed_positions.map(positionFromRow),
        fundingHealth: {
          incompleteCount: Number(row.funding_health?.incomplete_count ?? 0),
          legacyUnknownCount: Number(row.funding_health?.legacy_unknown_count ?? 0),
          verifiedSettlementCount: Number(row.funding_health?.verified_settlement_count ?? 0),
          verifiedNetCostUsdt: row.funding_health?.verified_net_cost_usdt ?? "0",
          unverifiedPositions: row.funding_health?.unverified_positions ?? [],
        },
      };
    },

    /**
     * Reserve base plus any stop-buffer top-up and create the PAPER position in
     * one transaction. Duplicate IDs never debit the wallet a second time.
     */
    async openPaperPosition(position) {
      const sourceSignalId = requireNonEmptyString(
        position?.sourceSignalId,
        "position.sourceSignalId",
      );
      validateStatus(position.status, POSITION_STATUSES, "position status");
      if (position.status !== "open") {
        throw new TypeError("A new paper position must have status 'open'");
      }
      if ((position.mode ?? "paper") !== "paper") {
        throw new TypeError("Only PAPER positions can be opened in the PAPER wallet");
      }
      const entryPrice = finiteUsdt(position.entryPrice, "position.entryPrice");
      const quantity = finiteUsdt(position.quantity, "position.quantity");
      if (entryPrice <= 0 || quantity <= 0) {
        throw new RangeError("PAPER entry price and quantity must be positive");
      }
      const feeModel = position.feeModel ?? paperFeeModel();
      const costs = paperFillCosts(entryPrice, quantity, feeModel.rate);
      const realizedPnlUsdt = -costs.feeUsdt;
      const marginHeldUsd = finiteUsdt(
        position.marginHeldUsd ?? PAPER_BASE_MARGIN_USDT,
        "position.marginHeldUsd",
      );
      if (marginHeldUsd < PAPER_BASE_MARGIN_USDT) {
        throw new RangeError("A new PAPER position must reserve at least its base margin");
      }
      const snapshot = {
        ...position,
        realizedPnlUsdt,
        grossRealizedPnlUsdt: 0,
        feesPaidUsdt: costs.feeUsdt,
        feeModel,
        paperFills: [{
          type: "entry",
          price: entryPrice,
          quantity,
          notionalUsdt: costs.notionalUsdt,
          feeUsdt: costs.feeUsdt,
          feeRate: feeModel.rate,
          feeModelVersion: feeModel.version,
          feeTierVerified: feeModel.accountTierVerified,
          feeSource: feeModel.source,
          feeCheckedAt: feeModel.checkedAt,
          feeScheduleUrl: feeModel.scheduleUrl,
          executionType: "simulated_market_taker",
          reason: "market_entry",
          occurredAt: position.entryAt,
        }],
        marginHeldUsd,
      };
      const serializedSnapshot = serializeJson(snapshot, "paper position");
      const client = await pool.connect();
      let transactionOpen = false;

      try {
        await client.query("BEGIN");
        transactionOpen = true;

        const existing = await client.query(
          `
            SELECT source_signal_id
            FROM btb_positions
            WHERE source_signal_id = $1
            FOR UPDATE
          `,
          [sourceSignalId],
        );
        if (existing.rowCount > 0) {
          await client.query("COMMIT");
          transactionOpen = false;
          return { kind: "duplicate" };
        }

        const account = await client.query(
          `
            UPDATE btb_paper_account
            SET free_usdt = free_usdt - $1::numeric - $2::numeric,
                reserved_usdt = reserved_usdt + $1::numeric,
                realized_pnl_usdt = realized_pnl_usdt - $2::numeric
            WHERE singleton = true AND free_usdt >= $1::numeric + $2::numeric
            RETURNING singleton
          `,
          [marginHeldUsd, costs.feeUsdt],
        );
        if (account.rowCount === 0) {
          const initialized = await client.query(
            "SELECT singleton FROM btb_paper_account WHERE singleton = true",
          );
          await client.query("ROLLBACK");
          transactionOpen = false;
          if (initialized.rowCount === 0) {
            throw new Error(
              "Paper account is not initialized; apply schema.sql first",
            );
          }

          // A concurrent opener for this same ID may have committed while the
          // conditional wallet update waited on the singleton account row.
          const racedDuplicate = await pool.query(
            `
              SELECT source_signal_id
              FROM btb_positions
              WHERE source_signal_id = $1
            `,
            [sourceSignalId],
          );
          return racedDuplicate.rowCount > 0
            ? { kind: "duplicate" }
            : { kind: "insufficient" };
        }

        const inserted = await client.query(
          `
            INSERT INTO btb_positions
              (source_signal_id, snapshot, status)
            VALUES ($1, $2::jsonb, 'open')
            ON CONFLICT (source_signal_id) DO NOTHING
            RETURNING source_signal_id
          `,
          [sourceSignalId, serializedSnapshot],
        );
        if (inserted.rowCount === 0) {
          // Concurrent insert: roll back the reservation before reporting it.
          await client.query("ROLLBACK");
          transactionOpen = false;
          return { kind: "duplicate" };
        }

        await client.query("COMMIT");
        transactionOpen = false;
        return { kind: "opened", position: snapshot };
      } catch (error) {
        if (transactionOpen) {
          await client.query("ROLLBACK").catch(() => {});
        }
        throw error;
      } finally {
        client.release();
      }
    },

    /**
     * Apply the position's realized-PnL and released-margin deltas exactly
     * once. A retry based on an older snapshot is returned as stale without
     * changing the wallet, snapshot, signal-close status, or audit events.
     */
    async settlePaperPosition(
      previous,
      next,
      { events = [], closeSignal = false, sourceExitRequestId = null } = {},
    ) {
      const sourceSignalId = requireNonEmptyString(
        previous?.sourceSignalId,
        "previous.sourceSignalId",
      );
      if (next?.sourceSignalId !== sourceSignalId) {
        throw new TypeError("previous and next must identify the same position");
      }
      const previousRealized = finiteUsdt(
        previous.realizedPnlUsdt,
        "previous.realizedPnlUsdt",
      );
      const previousMargin = finiteUsdt(
        previous.marginHeldUsd,
        "previous.marginHeldUsd",
      );
      const nextRealized = finiteUsdt(
        next.realizedPnlUsdt,
        "next.realizedPnlUsdt",
      );
      const nextMargin = finiteUsdt(next.marginHeldUsd, "next.marginHeldUsd");
      validateStatus(previous.status, POSITION_STATUSES, "previous position status");
      validateStatus(next.status, POSITION_STATUSES, "next position status");
      if (previousMargin < 0 || nextMargin < 0) {
        throw new RangeError("Paper position margin cannot be negative");
      }
      const deltaRealized = nextRealized - previousRealized;
      const deltaMargin = previousMargin - nextMargin;
      if (deltaMargin < 0) {
        throw new RangeError("settlePaperPosition cannot increase held margin");
      }
      if (typeof closeSignal !== "boolean") {
        throw new TypeError("closeSignal must be a boolean");
      }
      if (closeSignal && next.status !== "closed") {
        throw new TypeError("Only a closed PAPER position can close its signal");
      }
      const sourceExitRequestKeyValue = sourceExitRequestId === null
        ? null
        : sourceExitRequestKey(sourceExitRequestId);
      if (sourceExitRequestKeyValue !== null &&
          (!closeSignal || next.status !== "closed")) {
        throw new TypeError("A source exit request can only finish with a closed PAPER position");
      }
      const serializedEvents = serializeEvents(events);
      const serializedNext = serializeJson(next, "paper position");
      const client = await pool.connect();
      let transactionOpen = false;

      try {
        await client.query("BEGIN");
        transactionOpen = true;
        const currentResult = await client.query(
          `
            SELECT snapshot, status
            FROM btb_positions
            WHERE source_signal_id = $1
            FOR UPDATE
          `,
          [sourceSignalId],
        );
        if (currentResult.rowCount === 0) {
          await client.query("ROLLBACK");
          transactionOpen = false;
          return { kind: "stale" };
        }

        const current = currentResult.rows[0];
        const currentSnapshot =
          typeof current.snapshot === "string"
            ? JSON.parse(current.snapshot)
            : current.snapshot;
        const fieldsMatch =
          current.status === previous.status &&
          currentSnapshot.status === previous.status &&
          serializeJson(currentSnapshot, "stored paper position") ===
            serializeJson(previous, "previous paper position");
        if (!fieldsMatch) {
          await client.query("ROLLBACK");
          transactionOpen = false;
          return { kind: "stale" };
        }
        if (sourceExitRequestKeyValue === null && current.status === "open") {
          const pendingSourceExit = await client.query(
            `
              SELECT request.id
              FROM btb_events request
              WHERE request.source_signal_id = $1
                AND request.kind = 'paper_source_exit_requested'
                AND NOT EXISTS (
                  SELECT 1
                  FROM btb_events applied
                  WHERE applied.source_signal_id = request.source_signal_id
                    AND applied.kind = 'paper_source_exit_applied'
                    AND applied.detail->>'requestId' = request.id::text
                )
              ORDER BY request.id
              LIMIT 1
              FOR UPDATE
            `,
            [sourceSignalId],
          );
          if (pendingSourceExit.rowCount > 0) {
            await client.query("ROLLBACK");
            transactionOpen = false;
            return { kind: "stale" };
          }
        }

        const account = await client.query(
          `
            UPDATE btb_paper_account
            SET free_usdt = free_usdt + $1::numeric + $2::numeric,
                reserved_usdt = reserved_usdt - $2::numeric,
                realized_pnl_usdt = realized_pnl_usdt + $1::numeric
            WHERE singleton = true AND reserved_usdt >= $2::numeric
            RETURNING initial_usdt, free_usdt, reserved_usdt, realized_pnl_usdt
          `,
          [deltaRealized, deltaMargin],
        );
        if (account.rowCount === 0) {
          const initialized = await client.query(
            "SELECT singleton FROM btb_paper_account WHERE singleton = true",
          );
          if (initialized.rowCount === 0) {
            throw new Error(
              "Paper account is not initialized; apply schema.sql first",
            );
          }
          throw new Error(
            "Paper wallet reserved margin is below the position margin release",
          );
        }

        await client.query(
          `
            UPDATE btb_positions
            SET snapshot = $2::jsonb, status = $3, updated_at = now()
            WHERE source_signal_id = $1
          `,
          [sourceSignalId, serializedNext, next.status],
        );

        if (closeSignal) {
          const signal = await client.query(
            `
              UPDATE btb_signals
              SET status = 'closed', reason = NULL, updated_at = now()
              WHERE source_signal_id = $1
              RETURNING source_signal_id
            `,
            [sourceSignalId],
          );
          if (signal.rowCount === 0) {
            throw new Error("Cannot close PAPER position without its signal row");
          }
        }
        await insertEvents(client, sourceSignalId, serializedEvents);
        if (sourceExitRequestKeyValue !== null) {
          const finished = await finishSourceExitRequestInTransaction(
            client,
            sourceSignalId,
            sourceExitRequestKeyValue,
            next.sourceWithdrawal ?? next.sourceClosure,
          );
          if (!finished) throw new Error("Source exit request was not found");
        }

        await client.query("COMMIT");
        transactionOpen = false;
        return {
          kind: "settled",
          position: next,
          account: paperAccountFromRow(account.rows[0]),
        };
      } catch (error) {
        if (transactionOpen) {
          await client.query("ROLLBACK").catch(() => {});
        }
        throw error;
      } finally {
        client.release();
      }
    },

    /**
     * Move PAPER funds from free to reserved margin and persist the resulting
     * snapshot and optional audit event in one optimistic, idempotent
     * transaction. This does not affect PnL and is intentionally unavailable
     * to live-position paths.
     */
    async topUpPaperPosition(previous, next, amountUsdt, auditEvent = null) {
      const sourceSignalId = requireNonEmptyString(
        previous?.sourceSignalId,
        "previous.sourceSignalId",
      );
      if (next?.sourceSignalId !== sourceSignalId) {
        throw new TypeError("previous and next must identify the same position");
      }
      if ((previous.mode ?? "paper") !== "paper" || (next.mode ?? "paper") !== "paper") {
        throw new TypeError("Margin top-ups are available only for PAPER positions");
      }
      const amount = finiteUsdt(amountUsdt, "amountUsdt");
      const previousMargin = finiteUsdt(
        previous.marginHeldUsd,
        "previous.marginHeldUsd",
      );
      const nextMargin = finiteUsdt(next.marginHeldUsd, "next.marginHeldUsd");
      if (amount <= 0 || previousMargin < 0 || nextMargin < 0) {
        throw new RangeError("PAPER margin top-up and held margin must be positive");
      }
      if (
        Number(amount.toFixed(8)) !== amount ||
        Number((previousMargin + amount).toFixed(8)) !== nextMargin
      ) {
        throw new RangeError("Next held margin must include exactly the requested top-up");
      }
      if (
        finiteUsdt(next.realizedPnlUsdt, "next.realizedPnlUsdt") !==
        finiteUsdt(previous.realizedPnlUsdt, "previous.realizedPnlUsdt")
      ) {
        throw new TypeError("A PAPER margin top-up cannot change realized PnL");
      }
      validateStatus(previous.status, POSITION_STATUSES, "previous position status");
      validateStatus(next.status, POSITION_STATUSES, "next position status");
      if (previous.status !== "open" || next.status !== "open") {
        throw new TypeError("Only open PAPER positions can receive margin top-ups");
      }
      const serializedNext = serializeJson(next, "paper position");
      const serializedAuditEvents = auditEvent === null
        ? []
        : serializeEvents([auditEvent]);
      const client = await pool.connect();
      let transactionOpen = false;

      try {
        await client.query("BEGIN");
        transactionOpen = true;
        const currentResult = await client.query(
          `
            SELECT snapshot, status
            FROM btb_positions
            WHERE source_signal_id = $1
            FOR UPDATE
          `,
          [sourceSignalId],
        );
        if (currentResult.rowCount === 0) {
          await client.query("ROLLBACK");
          transactionOpen = false;
          return { kind: "stale" };
        }
        const current = currentResult.rows[0];
        const snapshot = typeof current.snapshot === "string"
          ? JSON.parse(current.snapshot)
          : current.snapshot;
        const fieldsMatch =
          current.status === previous.status &&
          serializeJson(snapshot, "stored paper position") ===
            serializeJson(previous, "previous paper position");
        if (!fieldsMatch) {
          await client.query("ROLLBACK");
          transactionOpen = false;
          return { kind: "stale" };
        }

        const account = await client.query(
          `
            UPDATE btb_paper_account
            SET free_usdt = free_usdt - $1,
                reserved_usdt = reserved_usdt + $1
            WHERE singleton = true AND free_usdt >= $1
            RETURNING initial_usdt, free_usdt, reserved_usdt, realized_pnl_usdt
          `,
          [amount],
        );
        if (account.rowCount === 0) {
          const initialized = await client.query(
            "SELECT singleton FROM btb_paper_account WHERE singleton = true",
          );
          if (initialized.rowCount === 0) {
            throw new Error("Paper account is not initialized; apply schema.sql first");
          }
          await client.query("ROLLBACK");
          transactionOpen = false;
          return { kind: "insufficient" };
        }

        await client.query(
          `
            UPDATE btb_positions
            SET snapshot = $2::jsonb, status = $3, updated_at = now()
            WHERE source_signal_id = $1
          `,
          [sourceSignalId, serializedNext, next.status],
        );
        await insertEvents(client, sourceSignalId, serializedAuditEvents);
        await client.query("COMMIT");
        transactionOpen = false;
        return {
          kind: "topped_up",
          position: next,
          account: paperAccountFromRow(account.rows[0]),
        };
      } catch (error) {
        if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async listPaperFundingCandidates(now = Date.now(), limit = 1) {
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new TypeError("now must be a non-negative safe integer timestamp");
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
        throw new RangeError("limit must be an integer between 1 and 20");
      }
      const result = await pool.query(
        `
          SELECT source_signal_id, snapshot, status, updated_at
          FROM btb_positions
          WHERE COALESCE(snapshot->>'mode', 'paper') = 'paper'
            AND status IN ('open', 'closed')
            AND (
              (snapshot->>'fundingStatus' = 'legacy_unknown'
                AND status = 'open'
                AND CASE WHEN jsonb_typeof(snapshot->'paperFills') = 'array'
                  THEN jsonb_array_length(snapshot->'paperFills') = 0
                  ELSE true END
                AND snapshot->>'quantity' = snapshot->>'remainingQty'
                AND EXISTS (
                  SELECT 1 FROM btb_events entry_event
                  WHERE entry_event.source_signal_id = btb_positions.source_signal_id
                    AND entry_event.kind = 'paper_entry'
                )
                AND NOT EXISTS (
                  SELECT 1 FROM btb_events e
                  WHERE e.source_signal_id = btb_positions.source_signal_id
                    AND e.kind LIKE 'paper_close_%'
                ))
              OR (snapshot->>'fundingStatus' IS DISTINCT FROM 'legacy_unknown'
                AND CASE
                  WHEN jsonb_typeof(snapshot->'paperFills') = 'array'
                    THEN jsonb_array_length(snapshot->'paperFills') > 0
                  ELSE false
                END)
            )
            AND (
              snapshot->>'fundingStatus' = 'incomplete'
              OR snapshot->>'fundingStatus' = 'legacy_unknown'
              OR (
                status = 'open'
                AND CASE
                  WHEN snapshot->>'fundingNextFundingTime' ~ '^[0-9]+$'
                    THEN (snapshot->>'fundingNextFundingTime')::numeric <= $1
                  ELSE false
                END
              )
            )
            AND COALESCE(
              NULLIF(snapshot->>'fundingHistoryAttemptAt', '')::timestamptz,
              '-infinity'::timestamptz
            ) <= to_timestamp($1::double precision / 1000) - interval '5 minutes'
          ORDER BY COALESCE(
            NULLIF(snapshot->>'fundingHistoryAttemptAt', '')::timestamptz,
            '-infinity'::timestamptz
          ) ASC, updated_at ASC, source_signal_id ASC
          LIMIT $2
        `,
        [now, limit],
      );
      return result.rows.map(positionFromRow);
    },

    async getLegacyFundingEntry(sourceSignalId) {
      const result = await pool.query(
        `SELECT e.detail, e.created_at
         FROM btb_events e
         JOIN btb_positions p ON p.source_signal_id = e.source_signal_id
         WHERE e.source_signal_id = $1
           AND p.status = 'open'
           AND p.snapshot->>'fundingStatus' = 'legacy_unknown'
           AND e.kind = 'paper_entry'
           AND NOT EXISTS (
             SELECT 1 FROM btb_events exit_event
             WHERE exit_event.source_signal_id = e.source_signal_id
               AND exit_event.kind LIKE 'paper_close_%'
           )`,
        [sourceSignalId],
      );
      return result.rows.length === 1 ? result.rows[0] : null;
    },

    async getPaperFundingHealth() {
      const result = await pool.query(
        `
          SELECT
            COUNT(*) FILTER (
              WHERE snapshot->>'fundingStatus' = 'incomplete'
            )::integer AS incomplete_count,
            COUNT(*) FILTER (
              WHERE snapshot->>'fundingStatus' IS DISTINCT FROM 'current'
                AND snapshot->>'fundingStatus' IS DISTINCT FROM 'incomplete'
            )::integer AS legacy_unknown_count
          FROM btb_positions
          WHERE COALESCE(snapshot->>'mode', 'paper') = 'paper'
        `,
      );
      const row = result.rows[0] ?? {};
      return {
        incompleteCount: Number(row.incomplete_count ?? 0),
        legacyUnknownCount: Number(row.legacy_unknown_count ?? 0),
      };
    },

    async listRecentPositions(limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new RangeError("limit must be an integer between 1 and 500");
      }
      const result = await pool.query(
        `
          SELECT source_signal_id, snapshot, status, updated_at
          FROM btb_positions
          WHERE status IN ('open', 'closing', 'closed')
          ORDER BY updated_at DESC, source_signal_id DESC
          LIMIT $1
        `,
        [limit],
      );
      return result.rows.map(positionFromRow);
    },

    async recordEvent(sourceSignalId, kind, detail = {}) {
      if (sourceSignalId !== null) {
        requireNonEmptyString(sourceSignalId, "sourceSignalId");
      }
      requireNonEmptyString(kind, "kind");
      const serializedDetail = serializeJson(detail, "event detail");
      const result = await pool.query(
        `
          INSERT INTO btb_events (source_signal_id, kind, detail)
          VALUES ($1, $2, $3::jsonb)
          RETURNING id, source_signal_id, kind, detail, created_at
        `,
        [sourceSignalId, kind, serializedDetail],
      );
      const row = result.rows[0];
      return {
        id: row.id,
        sourceSignalId: row.source_signal_id,
        kind: row.kind,
        detail: row.detail,
        createdAt: row.created_at,
      };
    },

    async findSignal(sourceSignalId) {
      requireNonEmptyString(sourceSignalId, "sourceSignalId");
      const result = await pool.query(
        `
          SELECT source_signal_id, body, body_hash, status, reason,
                 received_at, updated_at
          FROM btb_signals
          WHERE source_signal_id = $1
        `,
        [sourceSignalId],
      );
      return toRow(result.rows[0]);
    },

    /**
     * Given source signal ids the source currently reports as active/in_run,
     * return the subset we have never stored in any form (not even a
     * rejection). Used to surface source signals that never reached this
     * bot's ingress at all, which the normal enqueue/reject paths cannot
     * record because a pre-enqueue rejection leaves no row.
     */
    async findMissingSourceSignalIds(ids) {
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || id.trim() === "")) {
        throw new TypeError("ids must be an array of non-empty strings");
      }
      if (ids.length === 0) return [];
      // The bot ingests every source-active signal into exactly one ledger:
      // btb_signals in PAPER mode, vst_signals in VST mode (see
      // configuredMode() in server.mjs). A signal absent from btb_signals
      // while VST mode is active is not missing -- it was correctly routed
      // to vst_signals instead. Only flag ids absent from BOTH ledgers.
      // to_regclass guards environments where vst-schema.sql was never
      // applied (e.g. a plain PAPER-only database).
      const result = await pool.query(
        `
          SELECT id
          FROM unnest($1::text[]) AS id
          WHERE NOT EXISTS (
            SELECT 1 FROM btb_signals WHERE source_signal_id = id
          )
          AND (
            to_regclass('public.vst_signals') IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM vst_signals WHERE source_signal_id = id
            )
          )
        `,
        [ids],
      );
      return result.rows.map((row) => row.id);
    },

    /**
     * Durably record that a source-active signal reached neither btb_signals
     * nor vst_signals. Idempotent: only the first call per sourceSignalId
     * inserts a row, so a signal that stays missing across repeated sync
     * passes is not spammed. Returns whether this call newly recorded it
     * (false if already known).
     */
    async recordMissedSourceSignal(sourceSignalId, detail = {}) {
      requireNonEmptyString(sourceSignalId, "sourceSignalId");
      const serializedDetail = serializeJson(detail, "missed signal detail");
      const result = await pool.query(
        `
          INSERT INTO btb_events (source_signal_id, kind, detail)
          SELECT $1, 'source_signal_never_ingested', $2::jsonb
          WHERE NOT EXISTS (
            SELECT 1 FROM btb_events
            WHERE source_signal_id = $1 AND kind = 'source_signal_never_ingested'
          )
          RETURNING id
        `,
        [sourceSignalId, serializedDetail],
      );
      return result.rows.length > 0;
    },

    /**
     * Currently-outstanding source signals recorded as missed that still
     * have no btb_signals row (self-heals if one later arrives under the
     * same id through another path).
     */
    async getMissedSourceSignalsSummary(limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new RangeError("limit must be an integer between 1 and 500");
      }
      const result = await pool.query(
        `
          SELECT DISTINCT ON (e.source_signal_id)
            e.source_signal_id, e.detail, e.created_at
          FROM btb_events e
          WHERE e.kind = 'source_signal_never_ingested'
            AND NOT EXISTS (
              SELECT 1 FROM btb_signals s WHERE s.source_signal_id = e.source_signal_id
            )
            AND (
              to_regclass('public.vst_signals') IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM vst_signals v WHERE v.source_signal_id = e.source_signal_id
              )
            )
          ORDER BY e.source_signal_id, e.created_at ASC
        `,
      );
      const items = result.rows
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .slice(0, limit)
        .map((row) => ({
          sourceSignalId: row.source_signal_id,
          detectedAt: row.created_at,
          ...row.detail,
        }));
      return { count: result.rows.length, items };
    },

    async listRecent(limit = 50) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new RangeError("limit must be an integer between 1 and 200");
      }
      const result = await pool.query(
        `
          SELECT source_signal_id, body, body_hash, status, reason,
                 received_at, updated_at
          FROM btb_signals
          ORDER BY received_at DESC, source_signal_id DESC
          LIMIT $1
        `,
        [limit],
      );
      return result.rows.map(toRow);
    },
  };
}