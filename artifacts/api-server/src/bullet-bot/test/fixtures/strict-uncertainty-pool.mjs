import assert from "node:assert/strict";

// Strict SQL contract double. It rejects unknown statements and simulates
// row/CAS checks, transaction rollback and serialized connections. No DB/network.
export function strictUncertaintyPool(fixture, {
  positionChanged = false, competing = false, commitDelay = null,
} = {}) {
  const state = {
    intent: structuredClone(fixture.intent),
    entry: structuredClone(fixture.entryIntent),
    position: structuredClone(fixture.position),
    signalStatus: fixture.signalStatus ?? "open",
    events: [], statements: [],
  };
  const canonical = value => value && typeof value === "object"
    ? Array.isArray(value) ? value.map(canonical)
      : Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]))
    : value;
  const eq = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  const row = i => ({
    source_signal_id: i.sourceSignalId, phase: i.phase,
    client_order_id: i.clientOrderId, state: i.state, request: i.request,
    outcome: i.outcome, exchange_order_id: i.exchangeOrderId,
    created_at: new Date(i.request.intentCreatedAt).toISOString(),
    updated_at: state.position.updatedAt,
  });
  let tail = Promise.resolve();
  async function query(sql, p = []) {
    state.statements.push({ sql, params: p });
    const result = rows => ({ rows, rowCount: rows.length });
    if (sql.includes("pg_advisory_xact_lock")) return result([]);
    if (sql.includes("FROM vst_signals") && sql.includes("FOR UPDATE")) {
      return result([{ status: state.signalStatus }]);
    }
    if (sql.includes("FROM vst_positions") && sql.includes("FOR UPDATE")) {
      return result(positionChanged || p[1] !== state.position.updatedAt ? [] : [{
        status: state.position.status, snapshot: state.position.snapshot,
        updated_at_text: state.position.updatedAt,
      }]);
    }
    if (sql.includes("SELECT client_order_id FROM vst_order_intents")) {
      return result(competing ? [{ client_order_id: "other-unresolved-intent" }] : []);
    }
    if (sql.includes("phase = 'market-entry'") && sql.includes("SELECT")) {
      return result([row(state.entry)]);
    }
    if (sql.includes("FROM vst_order_intents") && sql.includes("client_order_id = $2")) {
      return result(p[1] === state.intent.clientOrderId ? [row(state.intent)] : []);
    }
    if (sql.includes("UPDATE vst_order_intents SET outcome = $3::jsonb")) {
      assert.match(sql, /exchange_order_id IS NOT DISTINCT FROM \$5/);
      if (p[0] !== state.intent.clientOrderId || p[5] !== state.intent.state ||
          !eq(JSON.parse(p[1]), state.intent.outcome) ||
          !eq(JSON.parse(p[3]), state.intent.request) ||
          p[4] !== state.intent.exchangeOrderId) return result([]);
      state.intent.outcome = JSON.parse(p[2]);
      return result([row(state.intent)]);
    }
    if (sql.includes("UPDATE vst_order_intents SET state = 'submitted'")) {
      assert.match(sql, /state = 'prepared' AND phase = 'margin-top-up'/);
      if (state.intent.clientOrderId !== p[0] || state.intent.state !== "prepared" ||
          state.intent.phase !== "margin-top-up" ||
          state.intent.request.operation !== "margin_top_up" ||
          state.intent.request.environment !== "vst" ||
          !eq(state.intent.request, JSON.parse(p[1]))) return result([]);
      state.intent.state = "submitted";
      state.intent.outcome = { phase: "submission_started" };
      return result([{ client_order_id: state.intent.clientOrderId }]);
    }
    if (sql.includes("UPDATE vst_order_intents SET state = 'failed'")) {
      assert.match(sql, /state = \$7/);
      if (commitDelay) await commitDelay(state);
      if (p[1] !== state.intent.clientOrderId || p[2] !== state.intent.phase ||
          p[6] !== state.intent.state || state.intent.exchangeOrderId !== null ||
          !eq(JSON.parse(p[3]), state.intent.request) ||
          !eq(JSON.parse(p[5]), state.intent.outcome)) return result([]);
      state.intent.state = "failed";
      state.intent.outcome = JSON.parse(p[4]);
      return result([{ client_order_id: state.intent.clientOrderId }]);
    }
    if (sql.includes("UPDATE vst_positions")) {
      if (state.position.status !== p[1] || state.position.updatedAt !== p[3] ||
          !eq(state.position.snapshot, JSON.parse(p[4]))) return result([]);
      state.position.status = "open";
      state.position.snapshot = JSON.parse(p[2]);
      return result([{ source_signal_id: state.position.sourceSignalId }]);
    }
    if (sql.includes("UPDATE vst_signals")) {
      assert.equal(p[1], state.signalStatus);
      state.signalStatus = "open";
      return result([{ source_signal_id: state.position.sourceSignalId }]);
    }
    if (sql.includes("INSERT INTO vst_events")) {
      state.events.push({ kind: p[3], detail: JSON.parse(p[2]) });
      return result([]);
    }
    throw new Error(`Unsupported uncertainty SQL: ${sql}`);
  }
  return {
    state, pool: {
      query,
      async connect() {
        const previous = tail;
        let unlock;
        tail = new Promise(resolve => { unlock = resolve; });
        await previous;
        let backup;
        return {
          async query(sql, p) {
            if (sql === "BEGIN") {
              backup = structuredClone(state);
              return { rows: [], rowCount: 0 };
            }
            if (sql === "COMMIT") return { rows: [], rowCount: 0 };
            if (sql === "ROLLBACK") {
              const statements = state.statements;
              Object.assign(state, backup, { statements });
              return { rows: [], rowCount: 0 };
            }
            return query(sql, p);
          },
          release() { unlock(); },
        };
      },
    },
  };
}