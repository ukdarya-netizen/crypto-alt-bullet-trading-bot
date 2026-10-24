import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { createVstStore } from "../vst-store.mjs";

const sourceSignalId = "pre-runner-source-exit-adoption";
const accountId = "vst-adoption-account";
const symbol = "BTCUSDT";
const positionId = "position-991";
const quantity = "102868";
const nowMs = Date.now();
const intentCreatedAt = nowMs - 120_000;
const phase = `impulse-runner-breakeven-abort-${intentCreatedAt}`;
const clientOrderId = `vst-${createHash("sha256")
  .update(`${sourceSignalId}:${phase}`).digest("hex").slice(0, 30)}`;
const entryClientOrderId = "market-entry-client";
const entryOrderId = "market-entry-order";
const originalStopId = "original-full-stop";
const coreStopId = "core-80-stop";
const entryAt = new Date(nowMs - 110_000).toISOString();

function fixture() {
  const coreStop = {
    orderId: coreStopId, positionId, quantity: "82294.4", stopPrice: "0.019",
  };
  const originalStop = {
    orderId: originalStopId, positionId, quantity, stopPrice: "0.018",
  };
  const snapshot = {
    environment: "vst",
    sourceSignalId,
    accountId,
    symbol,
    patternId: "impulse_buy",
    status: "closing",
    exchangePositionId: positionId,
    remainingQty: quantity,
    entryAt,
    entryOrderType: "MARKET",
    entryClientOrderId,
    entryOrderId,
    verifiedFill: { at: entryAt, price: "0.09001", quantity },
    split: {
      stage: "runner_pending",
      positionId,
      totalQuantity: quantity,
      originalStopOrderId: originalStopId,
      signalStopPrice: originalStop.stopPrice,
      coreStop,
    },
  };
  const request = {
    operation: "close_pre_runner_split",
    sourceSignalId,
    environment: "vst",
    accountId,
    symbol,
    closeIntentId: clientOrderId,
    positionId,
    totalQuantity: quantity,
    originalStop,
    coreStop,
  };
  const originalOutcome = {
    error: "Error",
    errorMessage: "legacy timeout after request",
  };
  const intent = {
    sourceSignalId, phase, clientOrderId, request, state: "unknown",
    exchangeOrderId: null, outcome: originalOutcome,
    createdAt: new Date(intentCreatedAt), updatedAt: new Date(nowMs - 30_000),
  };
  const entryRequest = {
    operation: "entry",
    environment: "vst",
    accountId,
    symbol,
    entryOrderType: "MARKET",
    quantity,
    intentCreatedAt: new Date(intentCreatedAt - 1_000).toISOString(),
  };
  const entryOutcome = {
    verified: true,
    status: "filled",
    positionId,
    fillPrice: "0.09001",
    fillQuantity: quantity,
  };
  const entryIntent = {
    sourceSignalId,
    phase: "market-entry",
    clientOrderId: entryClientOrderId,
    request: entryRequest,
    state: "reconciled",
    exchangeOrderId: entryOrderId,
    outcome: entryOutcome,
    createdAt: new Date(intentCreatedAt - 1_000),
    updatedAt: new Date(intentCreatedAt),
  };
  const sourceExitRequestId = `source-exit-${createHash("sha256")
    .update(sourceSignalId).digest("hex")}`;
  const sourceExitDetail = {
    requestId: sourceExitRequestId,
    sourceSignalId,
    symbol,
    reason: "source_withdrawal",
    evidence: {
      sourceSignalId,
      symbol,
      reason: "source_withdrawal",
      sourceStatus: "reclassified",
      sourceUpdatedAt: new Date(nowMs - 60_000).toISOString(),
    },
    asOf: new Date(nowMs - 10_000).toISOString(),
    observedAt: new Date(nowMs - 10_000).toISOString(),
    latestAsOf: new Date(nowMs - 10_000).toISOString(),
    latestObservedAt: new Date(nowMs - 10_000).toISOString(),
  };
  const sourceExitRequest = {
    id: sourceExitRequestId,
    requestId: sourceExitRequestId,
    sourceSignalId,
    symbol,
    reason: "source_withdrawal",
    evidence: sourceExitDetail.evidence,
    asOf: sourceExitDetail.latestAsOf,
    observedAt: sourceExitDetail.latestObservedAt,
    createdAt: new Date(nowMs - 8_000).toISOString(),
    eventId: 77,
  };
  const firstHistoryEndTs = nowMs - 31_000;
  const historyCoverage = [{
    verified: true,
    endpoint: "/openApi/swap/v2/trade/fillHistory",
    currency: "USDT",
    startTs: intentCreatedAt - 32_000,
    endTs: firstHistoryEndTs,
    rawCount: 1,
    pageSize: 1_000,
    passes: 2,
    terminalPage: 2,
    snapshotSha256: "a".repeat(64),
    observedAt: new Date(nowMs - 30_501).toISOString(),
  }, {
    verified: true,
    endpoint: "/openApi/swap/v2/trade/fillHistory",
    currency: "USDT",
    startTs: firstHistoryEndTs,
    endTs: nowMs - 21_000,
    rawCount: 0,
    pageSize: 1_000,
    passes: 2,
    terminalPage: 2,
    snapshotSha256: "b".repeat(64),
    observedAt: new Date(nowMs - 20_501).toISOString(),
  }];
  const evidence = {
    verified: true,
    environment: "vst",
    accountId,
    symbol,
    positionId,
    quantity,
    observedAt: new Date(nowMs - 500).toISOString(),
    stops: [
      { ...originalStop },
      { ...coreStop },
    ],
    entryProof: {
      entryClientOrderId,
      entryOrderId,
      positionId,
      entryOrderType: "MARKET",
      intentCreatedAt: entryRequest.intentCreatedAt,
      quantity,
    },
    entryOrder: {
      symbol: "BTC-USDT",
      orderId: entryOrderId,
      positionID: positionId,
      clientOrderId: entryClientOrderId,
      status: "FILLED",
      side: "BUY",
      positionSide: "LONG",
      type: "MARKET",
      executedQty: quantity,
      origQty: quantity,
      avgPrice: "0.09001",
    },
    positionAveragePrice: "0.09001",
    entryPriceTickSize: "0.00001",
    historyCoverage,
    coverageEndTs: historyCoverage[1].endTs,
    entryFills: [
      {
        symbol: "BTC-USDT", orderId: entryOrderId, tradeId: "trade-a",
        side: "BUY", positionSide: "LONG",
        filledTime: new Date(Date.parse(entryAt) + 28_800_000)
          .toISOString().replace("Z", "+08:00"),
        qty: quantity, price: "0.09002",
      },
    ],
  };
  const database = {
    signal: { source_signal_id: sourceSignalId, body: { symbol }, status: "error" },
    position: {
      source_signal_id: sourceSignalId, symbol, status: "closing",
      snapshot: structuredClone(snapshot), updated_at: new Date(nowMs - 1_000),
    },
    intents: [structuredClone(intent), structuredClone(entryIntent)],
    sourceExit: {
      id: 77, source_signal_id: sourceSignalId, kind: "source_exit_requested",
      detail: structuredClone(sourceExitDetail),
      created_at: sourceExitRequest.createdAt,
    },
    completions: [],
    events: [],
  };
  const pool = createPool(database);
  return {
    database, pool, snapshot, intent, entryIntent, sourceExitRequest, evidence,
    originalOutcome,
    args(overrides = {}) {
      return {
        sourceSignalId,
        clientOrderId,
        expectedIntent: structuredClone(intent),
        expectedPositionSnapshot: structuredClone(snapshot),
        expectedSourceExitRequest: structuredClone(sourceExitRequest),
        evidence: structuredClone(evidence),
        ...overrides,
      };
    },
  };
}

function intentRow(intent) {
  return {
    source_signal_id: intent.sourceSignalId,
    phase: intent.phase,
    client_order_id: intent.clientOrderId,
    request: structuredClone(intent.request),
    state: intent.state,
    exchange_order_id: intent.exchangeOrderId,
    outcome: structuredClone(intent.outcome),
    created_at: intent.createdAt,
    updated_at: intent.updatedAt,
  };
}

function createPool(database, { forceIntentCasConflict = false } = {}) {
  let beginState;
  const client = {
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, " ").trim();
      if (text === "BEGIN") {
        beginState = structuredClone(database);
        return { rows: [], rowCount: 0 };
      }
      if (text === "COMMIT") {
        beginState = null;
        return { rows: [], rowCount: 0 };
      }
      if (text === "ROLLBACK") {
        if (beginState) {
          for (const key of Object.keys(database)) delete database[key];
          Object.assign(database, beginState);
          beginState = null;
        }
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (text.startsWith("SELECT source_signal_id, body, status FROM vst_signals")) {
        return { rows: [structuredClone(database.signal)], rowCount: 1 };
      }
      if (text.startsWith("SELECT source_signal_id, symbol, status, snapshot, updated_at")) {
        return { rows: [structuredClone(database.position)], rowCount: 1 };
      }
      if (text.includes("FROM vst_order_intents") && text.includes("client_order_id = $2")) {
        const row = database.intents.find((item) => item.clientOrderId === params[1]);
        return { rows: row ? [intentRow(row)] : [], rowCount: row ? 1 : 0 };
      }
      if (text.includes("FROM vst_order_intents") && text.includes("phase = 'market-entry'")) {
        const row = database.intents.find((item) => item.phase === "market-entry");
        return { rows: row ? [intentRow(row)] : [], rowCount: row ? 1 : 0 };
      }
      if (text.includes("FROM vst_order_intents") && text.includes("FOR UPDATE")) {
        return { rows: database.intents.map(intentRow), rowCount: database.intents.length };
      }
      if (text.includes("FROM vst_events") && text.includes("source_exit_requested")) {
        const row = database.sourceExit &&
          database.sourceExit.detail.requestId === params[1]
          ? database.sourceExit : null;
        return { rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 };
      }
      if (text.includes("FROM vst_events") && text.includes("source_exit_completed")) {
        const rows = database.completions.filter((row) =>
          row.detail.requestId === params[1]);
        return { rows, rowCount: rows.length };
      }
      if (text.startsWith("UPDATE vst_order_intents")) {
        if (forceIntentCasConflict) return { rows: [], rowCount: 0 };
        const row = database.intents.find((item) =>
          item.sourceSignalId === params[0] && item.clientOrderId === params[1]);
        if (!row || row.phase !== params[2] || row.state !== "unknown" ||
            row.exchangeOrderId !== null ||
            !isDeepStrictEqual(row.request, JSON.parse(params[4])) ||
            !isDeepStrictEqual(row.outcome, JSON.parse(params[5]))) {
          return { rows: [], rowCount: 0 };
        }
        row.state = "failed";
        row.outcome = JSON.parse(params[3]);
        return { rows: [{ client_order_id: row.clientOrderId }], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO vst_events")) {
        database.events.push({
          source_signal_id: params[0],
          client_order_id: params[1],
          kind: "vst_pre_runner_open_adopted_for_source_exit",
          detail: JSON.parse(params[2]),
        });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected adoption store query: ${text}`);
    },
    release() {},
  };
  return {
    async connect() { return client; },
    async query(sql) { throw new Error(`Unexpected non-transactional query: ${sql}`); },
  };
}

test("accepts the actual split-entry outcome with totalQuantity and no duplicated fill fields", async () => {
  const data = fixture();
  const outcome = data.database.intents.find((row) => row.phase === "market-entry").outcome;
  outcome.totalQuantity = outcome.fillQuantity;
  delete outcome.fillQuantity;
  delete outcome.fillPrice;
  const result = await createVstStore(data.pool).adoptPreRunnerOpenForSourceExit(data.args());
  assert.deepEqual(result, { kind: "adopted" });
  assert.equal(data.database.intents[0].outcome.originalExecution, "unknown_unproven");
});

test("a routine source observation refresh does not revoke the immutable exit decision", async () => {
  const data = fixture();
  const args = data.args();
  data.database.sourceExit.detail.latestAsOf = new Date(nowMs).toISOString();
  data.database.sourceExit.detail.latestObservedAt = new Date(nowMs).toISOString();
  const result = await createVstStore(data.pool).adoptPreRunnerOpenForSourceExit(args);
  assert.deepEqual(result, { kind: "adopted" });
});

test("rejects conflicting duplicate quantities in an otherwise verified split-entry outcome", async () => {
  const data = fixture();
  const outcome = data.database.intents.find((row) => row.phase === "market-entry").outcome;
  outcome.totalQuantity = "1";
  const result = await createVstStore(data.pool).adoptPreRunnerOpenForSourceExit(data.args());
  assert.equal(result.kind, "refused");
  assert.equal(data.database.intents[0].state, "unknown");
});

test("adopts the protected legacy position from native fill history without position ids and within one price tick", async () => {
  const data = fixture();
  const result = await createVstStore(data.pool).adoptPreRunnerOpenForSourceExit(data.args());
  assert.deepEqual(result, { kind: "adopted" });
  const oldIntent = data.database.intents[0];
  assert.equal(oldIntent.state, "failed");
  assert.equal(oldIntent.exchangeOrderId, null);
  assert.deepEqual(oldIntent.request, data.intent.request);
  assert.deepEqual(oldIntent.outcome, {
    ...data.originalOutcome,
    originalExecution: "unknown_unproven",
    sourceExitCurrentPositionAdoption: {
      reason: "source_withdrawal",
      entryProof: data.evidence.entryProof,
      observedAt: data.evidence.observedAt,
      sourceExitRequestId: data.sourceExitRequest.requestId,
    },
  });
  assert.equal(Object.hasOwn(oldIntent.outcome, "mutationProvenance"), false);
  assert.equal(Object.hasOwn(oldIntent.outcome, "manualResolution"), false);
  assert.equal(Object.hasOwn(oldIntent.outcome, "ownerReview"), false);
  assert.deepEqual(data.database.position.snapshot, data.snapshot);
  assert.equal(data.database.position.status, "closing");
  assert.equal(data.database.signal.status, "error");
  assert.equal(data.database.events.length, 1);
  assert.equal(data.database.events[0].kind,
    "vst_pre_runner_open_adopted_for_source_exit");
  assert.deepEqual(data.database.completions, []);
});

test("legacy adoption refuses CAS conflicts, missing or terminal source exits, and competing intents without writes", async (t) => {
  const cases = [
    ["intent expected state differs", (data) => {
      const expectedIntent = structuredClone(data.intent);
      expectedIntent.outcome.errorMessage = "stale expected value";
      return { expectedIntent };
    }],
    ["snapshot CAS differs", () => ({
      expectedPositionSnapshot: { unexpected: "snapshot" },
    })],
    ["source exit expectation differs", (data) => ({
      expectedSourceExitRequest: { ...data.sourceExitRequest, symbol: "OTHERUSDT" },
    })],
    ["source exit missing", (data) => { data.database.sourceExit = null; return {}; }],
    ["source exit completed", (data) => {
      data.database.completions.push({ detail: {
        requestId: data.sourceExitRequest.requestId,
      } });
      return {};
    }],
    ["unresolved other intent", (data) => {
      data.database.intents.push({
        sourceSignalId, phase: "another-close", clientOrderId: "other-order",
        request: { operation: "close" }, state: "unknown",
        exchangeOrderId: null, outcome: {}, createdAt: new Date(), updatedAt: new Date(),
      });
      return {};
    }],
  ];
  for (const [name, prepare] of cases) {
    await t.test(name, async () => {
      const data = fixture();
      const overrides = prepare(data);
      const before = structuredClone(data.database);
      const result = await createVstStore(data.pool)
        .adoptPreRunnerOpenForSourceExit(data.args(overrides));
      assert.equal(result.kind, "refused");
      assert.deepEqual(data.database, before);
    });
  }
  await t.test("atomic intent compare-and-set conflict leaves every record unchanged", async () => {
    const data = fixture();
    const pool = createPool(data.database, { forceIntentCasConflict: true });
    const before = structuredClone(data.database);
    const result = await createVstStore(pool).adoptPreRunnerOpenForSourceExit(data.args());
    assert.deepEqual(result, { kind: "refused", reason: "pre_runner_open_adoption_state_changed" });
    assert.deepEqual(data.database, before);
  });
});

test("invalid, stale, foreign, or stop-mismatched read-only evidence never retires the legacy intent", async (t) => {
  const corruptions = [
    ["stale proof", (evidence) => {
      evidence.observedAt = new Date(nowMs - 6_000).toISOString();
    }],
    ["incomplete history window", (evidence) => {
      evidence.historyCoverage[0].passes = 1;
    }],
    ["changed terminal page proof", (evidence) => {
      evidence.historyCoverage[0].terminalPage = 1;
    }],
    ["foreign entry order", (evidence) => {
      evidence.entryFills[0].orderId = "foreign-entry-order";
    }],
    ["foreign side", (evidence) => {
      evidence.entryFills[0].side = "SELL";
    }],
    ["foreign position", (evidence) => {
      evidence.entryFills[0].positionID = "other-position";
    }],
    ["duplicate trade identity", (evidence) => {
      evidence.entryFills.push(structuredClone(evidence.entryFills[0]));
    }],
    ["wrong total quantity", (evidence) => {
      evidence.entryFills[0].qty = "102867";
    }],
    ["unsafe numeric trade id", (evidence) => {
      evidence.entryFills[0].tradeId = Number.MAX_SAFE_INTEGER + 1;
    }],
    ["declared zero fill position id", (evidence) => {
      evidence.entryFills[0].positionID = "0";
    }],
    ["native parent order mismatch", (evidence) => {
      evidence.entryOrder.orderId = "foreign-entry-order";
    }],
    ["position average exceeds one tick", (evidence) => {
      evidence.positionAveragePrice = "0.08999";
    }],
    ["native fill average exceeds one tick", (evidence) => {
      evidence.entryFills[0].price = "0.09003";
    }],
    ["stop order mismatch", (evidence) => {
      evidence.stops[1].orderId = "unowned-stop";
    }],
    ["stop quantity mismatch", (evidence) => {
      evidence.stops[1].quantity = "79";
    }],
    ["wrong environment", (evidence) => {
      evidence.environment = "paper";
    }],
  ];
  for (const [name, corrupt] of corruptions) {
    await t.test(name, async () => {
      const data = fixture();
      const evidence = structuredClone(data.evidence);
      corrupt(evidence);
      const before = structuredClone(data.database);
      const result = await createVstStore(data.pool)
        .adoptPreRunnerOpenForSourceExit(data.args({ evidence }));
      assert.equal(result.kind, "refused", name);
      assert.deepEqual(data.database, before, `${name} leaves ledger unchanged`);
    });
  }
});