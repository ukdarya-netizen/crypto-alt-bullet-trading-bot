import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createVstStore } from "../vst-store.mjs";

const signalId = "unlinked-adoption-signal";
const accountId = "unlinked-adoption-account";
const symbol = "VVVUSDT";
const positionId = "2105753865954525185";
const entryClientOrderId = "entry-client";
const entryOrderId = "2105753865832890369";
const oldStopId = "2105753866745765888";
const newStopId = "2105896637783695360";
const now = Date.parse("2026-10-02T09:05:00.000Z");
const updatedAt = new Date(now - 5_000).toISOString();
const intentAt = now - 8 * 60 * 60_000;
const phase = `raise_stop-core-${intentAt}`;
const clientOrderId = `vst-${createHash("sha256")
  .update(`${signalId}:${phase}`).digest("hex").slice(0, 30)}`;
const entryProof = {
  entryClientOrderId,
  entryOrderId,
  positionId,
  entryOrderType: "MARKET",
  intentCreatedAt: intentAt - 60_000,
  quantity: "340.9732",
};
const oldStop = {
  verified: true,
  orderId: oldStopId,
  positionId,
  quantity: "340.9732",
  stopPrice: "24.541",
};
const snapshot = {
  sourceSignalId: signalId,
  environment: "vst",
  accountId,
  symbol,
  status: "unknown",
  coreOpen: true,
  runnerOpen: false,
  quantity: "340.9732",
  remainingQty: "340.9732",
  coreQty: "340.9732",
  runnerQty: "0",
  exchangePositionId: positionId,
  positionId,
  entryClientOrderId,
  entryOrderId,
  entryOrderType: "MARKET",
  entryAt: new Date(intentAt + 5_000).toISOString(),
  coreStopOrderId: oldStopId,
  coreStopPositionId: positionId,
  coreStopQuantity: "340.9732",
  coreStopPrice: 24.541,
  stopPrice: 24.541,
  verifiedProtectiveStops: { core: oldStop },
};
const priorPosition = { ...snapshot, status: "open" };
const request = {
  operation: "raise_stop",
  sourceSignalId: signalId,
  environment: "vst",
  accountId,
  symbol,
  leg: "core",
  positionId,
  quantity: "340.9732",
  previousQuantity: "340.9732",
  stopPrice: "26.665",
  intentCreatedAt: intentAt,
  entryClientOrderId,
  entryOrderId,
  entryQuantity: "340.9732",
  entryOrderType: "MARKET",
  entryAt: priorPosition.entryAt,
  entryProof,
  priorPosition,
};
const outcome = { reason: "exchange_state_not_verified" };
const entryIntent = {
  sourceSignalId: signalId,
  phase: "market-entry",
  clientOrderId: entryClientOrderId,
  state: "reconciled",
  request: {
    operation: "entry",
    environment: "vst",
    accountId,
    symbol,
    entryOrderType: "MARKET",
    quantity: "340.9732",
    intentCreatedAt: entryProof.intentCreatedAt,
  },
  exchangeOrderId: entryOrderId,
  outcome: {
    verified: true,
    status: "filled",
    positionId,
    fillQuantity: "340.9732",
  },
};
const expectedPosition = {
  ...snapshot,
  status: "open",
  stopPrice: 26.665,
  coreStopOrderId: newStopId,
  coreStopPositionId: positionId,
  coreStopQuantity: "340.9732",
  coreStopPrice: 26.665,
  verifiedProtectiveStops: {
    core: {
      verified: true,
      tranche: "core",
      orderId: newStopId,
      positionId,
      quantity: "340.9732",
      stopPrice: "26.665",
    },
  },
};
const currentProtection = {
  orderId: newStopId,
  positionId,
  quantity: "340.9732",
  stopPrice: "26.665",
  status: "NEW",
  workingType: "MARK_PRICE",
};

function createStrictPool({
  positionMismatch = false,
  committedPosition = expectedPosition,
} = {}) {
  const state = {
    signalStatus: "unknown",
    positionStatus: "unknown",
    positionSnapshot: structuredClone(snapshot),
    intentState: "unknown",
    intentExchangeOrderId: null,
    intentRequest: structuredClone(request),
    intentOutcome: structuredClone(outcome),
    statements: [],
  };
  const client = {
    async query(sql, params = []) {
      state.statements.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("FROM vst_signals") && sql.includes("FOR UPDATE")) {
        return { rows: [{ status: state.signalStatus }], rowCount: 1 };
      }
      if (sql.includes("FROM vst_positions") && sql.includes("FOR UPDATE")) {
        return {
          rows: positionMismatch ? [] : [{
            status: state.positionStatus,
            snapshot: state.positionSnapshot,
            updated_at_text: updatedAt,
          }],
          rowCount: positionMismatch ? 0 : 1,
        };
      }
      if (sql.includes("FROM vst_order_intents") &&
          sql.includes("client_order_id = $2")) {
        return { rows: [{
          phase,
          state: state.intentState,
          request: state.intentRequest,
          exchange_order_id: state.intentExchangeOrderId,
          outcome: state.intentOutcome,
        }], rowCount: 1 };
      }
      if (sql.includes("phase = 'market-entry'")) {
        return { rows: [{
          phase: "market-entry",
          client_order_id: entryIntent.clientOrderId,
          request: entryIntent.request,
          state: entryIntent.state,
          exchange_order_id: entryIntent.exchangeOrderId,
          outcome: entryIntent.outcome,
        }], rowCount: 1 };
      }
      if (sql.includes("SELECT client_order_id FROM vst_order_intents")) {
        assert.match(sql, /request->>'positionId'/,
          "the conflict query is scoped to the exact exchange position");
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("UPDATE vst_order_intents")) {
        assert.equal(params[1], clientOrderId);
        assert.deepEqual(JSON.parse(params[3]), request);
        assert.deepEqual(JSON.parse(params[5]), outcome);
        assert.equal(params[2], phase);
        state.intentState = "failed";
        state.intentOutcome = JSON.parse(params[4]);
        return { rows: [{ client_order_id: clientOrderId }], rowCount: 1 };
      }
      if (sql.includes("UPDATE vst_positions")) {
        assert.deepEqual(JSON.parse(params[2]), committedPosition);
        assert.equal(params[3], updatedAt);
        assert.deepEqual(JSON.parse(params[4]), snapshot);
        state.positionStatus = "open";
        state.positionSnapshot = JSON.parse(params[2]);
        return { rows: [{ source_signal_id: signalId }], rowCount: 1 };
      }
      if (sql.includes("UPDATE vst_signals")) {
        state.signalStatus = "open";
        return { rows: [{ source_signal_id: signalId }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO vst_events")) {
        assert.equal(params[3], "vst_stop_protection_adopted");
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in strict VST adoption store test: ${sql}`);
    },
    release() {},
  };
  return {
    state,
    pool: {
      async connect() { return client; },
      async query(sql, params) { return client.query(sql, params); },
    },
  };
}

function args(overrides = {}) {
  return {
    sourceSignalId: signalId,
    clientOrderId,
    phase,
    expectedRequest: request,
    expectedOutcome: outcome,
    expectedPositionSnapshot: snapshot,
    expectedPositionUpdatedAt: updatedAt,
    expectedEntryIntent: entryIntent,
    entryProof,
    currentProtection,
    position: expectedPosition,
    eventDetail: { originalWriteAttributed: false },
    requestStartedAtMs: now,
    maxEvidenceAgeMs: 5_000,
    clock: () => now,
    ...overrides,
  };
}

test("unlinked protection adoption uses a strict transaction and preserves unknown execution attribution", async () => {
  const { pool, state } = createStrictPool();
  const store = createVstStore(pool);
  const result = await store.adoptUnlinkedRaiseStopProtection(args());

  assert.deepEqual(result, { kind: "recovered" });
  assert.equal(state.intentState, "failed");
  assert.equal(state.intentExchangeOrderId, null);
  assert.deepEqual(state.intentRequest, request);
  assert.equal(state.intentOutcome.reason, "raise_stop_unlinked_protection_adopted");
  assert.equal(state.intentOutcome.originalExecution, "unknown_unproven");
  assert.deepEqual(state.positionSnapshot, expectedPosition);
  assert.equal(state.positionStatus, "open");
  assert.equal(state.signalStatus, "open");
  assert.equal(state.statements.filter(({ sql }) =>
    sql.includes("UPDATE vst_order_intents")).length, 1);
  assert.equal(state.statements.filter(({ sql }) =>
    sql.includes("INSERT INTO vst_events")).length, 1);

  const replay = await store.adoptUnlinkedRaiseStopProtection(args());
  assert.deepEqual(replay, { kind: "ineligible" },
    "a cold replay cannot recommit or attribute the original write");
  assert.equal(state.statements.filter(({ sql }) =>
    sql.includes("UPDATE vst_order_intents")).length, 1);
});

test("unlinked protection adoption does not retire the intent after a position CAS mismatch", async () => {
  const { pool, state } = createStrictPool({ positionMismatch: true });
  const result = await createVstStore(pool).adoptUnlinkedRaiseStopProtection(args());
  assert.deepEqual(result, { kind: "ineligible" });
  assert.equal(state.intentState, "unknown");
  assert.equal(state.positionStatus, "unknown");
  assert.equal(state.signalStatus, "unknown");
  assert.equal(state.statements.some(({ sql }) =>
    sql.includes("UPDATE vst_order_intents")), false);
});

test("coexisting-stop adoption stores the retirement proof and cannot be replayed", async () => {
  const retirement = {
    oldStop: {
      orderId: oldStopId, positionId, quantity: "340.9732", stopPrice: "24.541",
    },
    adoptedStop: {
      orderId: newStopId, positionId, quantity: "340.9732", stopPrice: "26.665",
    },
  };
  const committedPosition = {
    ...expectedPosition,
    pendingStopRetirement: {
      ...retirement,
      entryProof,
      originalIntent: { clientOrderId, phase },
    },
  };
  const { pool, state } = createStrictPool({ committedPosition });
  const store = createVstStore(pool);
  assert.deepEqual(await store.adoptUnlinkedRaiseStopProtection(
    args({ oldStopRetirement: retirement, position: committedPosition }),
  ), { kind: "recovered" });
  assert.deepEqual(state.positionSnapshot.pendingStopRetirement,
    committedPosition.pendingStopRetirement);
  assert.deepEqual(state.intentOutcome.oldStopRetirement,
    committedPosition.pendingStopRetirement);
  assert.equal(state.intentState, "failed");
  assert.equal(state.intentExchangeOrderId, null);
  assert.equal(state.intentOutcome.originalExecution, "unknown_unproven");

  assert.deepEqual(await store.adoptUnlinkedRaiseStopProtection(
    args({ oldStopRetirement: retirement, position: committedPosition }),
  ), { kind: "ineligible" });
  assert.equal(state.statements.filter(({ sql }) =>
    sql.includes("UPDATE vst_order_intents")).length, 1);
});

test("coexisting-stop adoption rejects mismatched proof and unexplained snapshot markers", async (t) => {
  const retirement = {
    oldStop: {
      orderId: oldStopId, positionId, quantity: "340.9732", stopPrice: "24.541",
    },
    adoptedStop: {
      orderId: newStopId, positionId, quantity: "340.9732", stopPrice: "26.665",
    },
  };
  await t.test("old stop differs from the persisted verified core", async () => {
    const { pool, state } = createStrictPool();
    const mismatched = structuredClone(retirement);
    mismatched.oldStop.stopPrice = "24.542";
    assert.deepEqual(await createVstStore(pool).adoptUnlinkedRaiseStopProtection(
      args({ oldStopRetirement: mismatched }),
    ), { kind: "ineligible" });
    assert.equal(state.statements.length, 0);
  });
  await t.test("marker cannot be injected without the read-only coexistence proof", async () => {
    const injectedPosition = {
      ...expectedPosition,
      pendingStopRetirement: {
        ...retirement, entryProof, originalIntent: { clientOrderId, phase },
      },
    };
    const { pool, state } = createStrictPool();
    assert.deepEqual(await createVstStore(pool).adoptUnlinkedRaiseStopProtection(
      args({ position: injectedPosition }),
    ), { kind: "ineligible" });
    assert.equal(state.statements.length, 0);
  });
});

function retirementCommitFixture({
  storedSnapshot,
  outcome = {
    operation: "retire_adopted_stop",
    verified: true,
    status: "filled",
    exchangeOrderId: oldStopId,
    canceledStopOrderId: oldStopId,
    adoptedStopOrderId: newStopId,
  },
} = {}) {
  const updatedAtText = new Date(now - 1_000).toISOString();
  const marker = {
    oldStop: {
      orderId: oldStopId, positionId, quantity: "340.9732", stopPrice: "24.541",
    },
    adoptedStop: {
      orderId: newStopId, positionId, quantity: "340.9732", stopPrice: "26.665",
    },
    entryProof,
    originalIntent: { clientOrderId, phase },
  };
  const priorPosition = { ...expectedPosition, pendingStopRetirement: marker };
  const nextPosition = { ...priorPosition };
  delete nextPosition.pendingStopRetirement;
  const retireRequest = {
    operation: "retire_adopted_stop",
    oldStop: marker.oldStop,
    adoptedStop: marker.adoptedStop,
    priorPosition,
  };
  const retireClientOrderId = "retire-adopted-stop-client";
  const retirePhase = "retire-adopted-stop";
  const state = {
    statements: [],
    position: {
      source_signal_id: signalId,
      symbol,
      status: "open",
      snapshot: structuredClone(storedSnapshot ?? priorPosition),
      updated_at: updatedAtText,
    },
    intent: {
      source_signal_id: signalId,
      phase: retirePhase,
      client_order_id: retireClientOrderId,
      request: retireRequest,
      state: "unknown",
      exchange_order_id: null,
      outcome: null,
      created_at: updatedAtText,
      updated_at: updatedAtText,
    },
    signal: {
      source_signal_id: signalId,
      body: { sourceSignalId: signalId },
      body_hash: "hash",
      status: "open",
      reason: null,
      received_at: updatedAtText,
      updated_at: updatedAtText,
    },
  };
  const client = {
    async query(sql, params = []) {
      state.statements.push({ sql, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("FROM vst_order_intents i")) {
        return {
          rows: [{
            ...state.intent,
            signal_source_signal_id: signalId,
            signal_body: state.signal.body,
            signal_body_hash: state.signal.body_hash,
            signal_status: state.signal.status,
            signal_reason: state.signal.reason,
            signal_received_at: state.signal.received_at,
            signal_updated_at: state.signal.updated_at,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM vst_positions") && sql.includes("FOR UPDATE")) {
        return { rows: [state.position], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO vst_positions")) {
        state.position = {
          source_signal_id: params[0],
          symbol: params[1],
          status: params[2],
          snapshot: JSON.parse(params[3]),
          updated_at: updatedAtText,
        };
        return { rows: [state.position], rowCount: 1 };
      }
      if (sql.includes("UPDATE vst_order_intents")) {
        Object.assign(state.intent, {
          state: "reconciled",
          exchange_order_id: params[1],
          outcome: JSON.parse(params[2]),
        });
        return { rows: [state.intent], rowCount: 1 };
      }
      if (sql.includes("UPDATE vst_signals")) {
        state.signal.status = params[1];
        return { rows: [state.signal], rowCount: 1 };
      }
      throw new Error(`Unexpected retirement commit SQL: ${sql}`);
    },
    release() {},
  };
  const pool = {
    async query() {
      throw new Error("retirement commit must use a transaction");
    },
    async connect() { return client; },
  };
  const commit = (commitOutcome = outcome, expected = priorPosition) =>
    createVstStore(pool).commitVerifiedIntent({
      sourceSignalId: signalId,
      clientOrderId: retireClientOrderId,
      position: nextPosition,
      signalStatus: "open",
      exchangeOrderId: oldStopId,
      outcome: commitOutcome,
      expectedPositionSnapshot: expected,
      expectedPositionUpdatedAt: updatedAtText,
    });
  return { state, marker, priorPosition, nextPosition, commit };
}

test("real store retirement commit validates proof/CAS and removes only the pending marker", async (t) => {
  await t.test("verified old-stop cancellation commits transactionally", async () => {
    const fixture = retirementCommitFixture();
    const result = await fixture.commit();
    assert.equal(result.replayed, false);
    assert.deepEqual(fixture.state.position.snapshot, fixture.nextPosition);
    assert.equal(Object.hasOwn(fixture.state.position.snapshot,
      "pendingStopRetirement"), false);
    assert.equal(fixture.state.intent.state, "reconciled");
    assert.equal(fixture.state.intent.exchange_order_id, oldStopId);
    assert.equal(fixture.state.intent.outcome.adoptedStopOrderId, newStopId);
    assert.deepEqual(fixture.state.statements
      .filter(({ sql }) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql))
      .map(({ sql }) => sql), ["BEGIN", "COMMIT"]);
  });

  await t.test("cancellation attributed to the adopted stop is rejected", async () => {
    const fixture = retirementCommitFixture({
      outcome: {
        operation: "retire_adopted_stop",
        verified: true,
        status: "filled",
        exchangeOrderId: oldStopId,
        canceledStopOrderId: newStopId,
        adoptedStopOrderId: newStopId,
      },
    });
    await assert.rejects(fixture.commit(),
      /VST adopted-stop retirement proof does not match pending position/);
    assert.equal(fixture.state.statements.some(({ sql }) =>
      sql.includes("INSERT INTO vst_positions")), false);
    assert.equal(fixture.state.statements.at(-1).sql, "ROLLBACK");
  });

  await t.test("persisted-position CAS mismatch is rejected without writes", async () => {
    const stale = { ...expectedPosition, unrelatedConcurrentChange: true,
      pendingStopRetirement: retirementCommitFixture().marker };
    const fixture = retirementCommitFixture({ storedSnapshot: stale });
    await assert.rejects(fixture.commit(),
      /VST position changed before verified intent commit/);
    assert.equal(fixture.state.statements.some(({ sql }) =>
      sql.includes("INSERT INTO vst_positions")), false);
    assert.equal(fixture.state.statements.at(-1).sql, "ROLLBACK");
  });
});
