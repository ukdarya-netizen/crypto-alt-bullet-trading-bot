import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  deriveVstExchangeClientOrderId, verifyHistoricalCloseEvidence,
} from "../vst-historical-close-evidence.mjs";
import { createVstStore } from "../vst-store.mjs";
import { createVstBroker } from "../vst-broker.mjs";

const sourceSignalId = "legacy-pre-runner-review-test";
const accountId = "vst-legacy-review-account";
const symbol = "USUSDT";
const quantity = "100";
const positionId = "legacy-position-1";
const now = () => Date.now();
const sha = (value) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const entryAt = now() - 120_000;
  const closeAt = now() - 60_000;
  const phase = "impulse-runner-breakeven-abort-1790704999000";
  const clientOrderId = `vst-${sha(`${sourceSignalId}:${phase}`).slice(0, 30)}`;
  const originalStop = {
    orderId: "owner-original-stop",
    quantity,
    stopPrice: "0.019",
  };
  const coreStop = {
    orderId: "owner-core-stop",
    quantity: "40",
    stopPrice: "0.020",
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
    verifiedFill: { price: "0.021", quantity, at: entryAt },
    entryAt: new Date(entryAt).toISOString(),
    split: {
      stage: "runner_pending",
      positionId,
      totalQuantity: quantity,
      originalStopOrderId: originalStop.orderId,
      signalStopPrice: originalStop.stopPrice,
      coreStop: { ...coreStop },
    },
  };
  const request = {
    operation: "close_pre_runner_split",
    sourceSignalId,
    symbol,
    accountId,
    environment: "vst",
    closeIntentId: clientOrderId,
    positionId,
    totalQuantity: quantity,
    originalStop: { ...originalStop },
    coreStop: { ...coreStop },
  };
  const originalOutcome = {
    error: "Error",
    errorMessage: "legacy close request timed out",
  };
  const closeIntent = {
    sourceSignalId,
    phase,
    clientOrderId,
    request,
    state: "unknown",
    exchangeOrderId: null,
    outcome: originalOutcome,
    createdAt: new Date(now() - 120_000),
    updatedAt: new Date(now() - 60_000),
  };
  const entryOrderId = "legacy-entry-order";
  const closeOrderId = "legacy-close-order";
  const entryClientOrderId = "legacy-entry-client";
  const closeExchangeClientOrderId = deriveVstExchangeClientOrderId(clientOrderId);
  const entryIntent = {
    sourceSignalId,
    phase: "market-entry",
    clientOrderId: entryClientOrderId,
    request: { environment: "vst", accountId, symbol, operation: "entry" },
    state: "reconciled",
    exchangeOrderId: entryOrderId,
    outcome: {
      status: "filled", verified: true, fillPrice: "0.021", fillQuantity: quantity,
    },
    createdAt: new Date(entryAt),
    updatedAt: new Date(entryAt),
  };
  const entryOrder = {
    symbol: "US-USDT", orderId: entryOrderId,
    clientOrderId: deriveVstExchangeClientOrderId(entryClientOrderId),
    status: "FILLED", side: "BUY", positionSide: "LONG", type: "LIMIT",
    time: entryAt, updateTime: entryAt, positionID: positionId,
    origQty: quantity, executedQty: quantity, avgPrice: "0.021",
  };
  const closeOrder = {
    symbol: "US-USDT", orderId: closeOrderId,
    clientOrderId: closeExchangeClientOrderId,
    status: "FILLED", side: "SELL", positionSide: "LONG", type: "MARKET",
    reduceOnly: true, time: closeAt, updateTime: closeAt, positionID: positionId,
    origQty: quantity, executedQty: quantity, avgPrice: "0.020",
  };
  const fills = [
    {
      symbol: "US-USDT", orderId: entryOrderId, side: "BUY",
      tradeId: "legacy-entry-fill", positionSide: "LONG",
      filledTime: new Date(entryAt).toISOString(), qty: quantity, price: "0.021",
      commission: "-0.01", currency: "USDT", commissionAsset: "VST",
      realisedPNL: "0", clientOrderID: "",
    },
    {
      symbol: "US-USDT", orderId: closeOrderId, side: "SELL",
      tradeId: "legacy-close-fill", positionSide: "LONG",
      filledTime: new Date(closeAt).toISOString(), qty: quantity, price: "0.020",
      commission: "-0.01", currency: "USDT", commissionAsset: "VST",
      realisedPNL: "-0.1", clientOrderID: "",
    },
  ];
  const coverage = [{
    verified: true,
    endpoint: "/openApi/swap/v2/trade/fillHistory",
    currency: "USDT",
    startTs: entryAt - 60_000,
    endTs: now(),
    rawCount: 2,
    pageSize: 1_000,
    passes: 2,
    terminalPage: 2,
    snapshotSha256: "a".repeat(64),
    observedAt: new Date(now()).toISOString(),
  }];
  const closeCandidate = {
    sourceSignalId,
    symbol,
    status: "closing",
    snapshot,
    entryIntent,
    closeIntent,
    ownerPreRunnerCloseReview: true,
  };
  const verifiedClose = verifyHistoricalCloseEvidence({
    candidate: closeCandidate,
    entryOrder,
    closeOrder,
    fills,
    coverage,
    coverageEndTs: coverage[0].endTs,
    freshPositions: [{ symbol: "US-USDT", positionAmt: "0", positionSide: "LONG" }],
    freshOpenOrders: [],
    expectedExchangeClientOrderId: deriveVstExchangeClientOrderId(entryClientOrderId),
    expectedCloseExchangeClientOrderId: closeExchangeClientOrderId,
    accountId,
    observedAtMs: now(),
    nowMs: now(),
  });
  return {
    snapshot, request, originalOutcome, closeIntent, entryIntent,
    originalStop, coreStop, verifiedClose, entryOrder, closeOrder, fills, coverage,
  };
}

function review(outcome, evidence, at = now()) {
  return {
    outcome,
    resolvedBy: "owner@example.test",
    note: "Checked the VST account directly",
    checkedAt: new Date(at).toISOString(),
    evidence,
  };
}

function openEvidence(data, overrides = {}) {
  return {
    verified: true,
    environment: "vst",
    accountId,
    symbol,
    positionId,
    observedAt: new Date(now()).toISOString(),
    quantity,
    stops: [
      {
        orderId: data.originalStop.orderId,
        positionId,
        quantity,
        stopPrice: data.originalStop.stopPrice,
      },
      {
        orderId: data.coreStop.orderId,
        positionId,
        quantity: data.coreStop.quantity,
        stopPrice: data.coreStop.stopPrice,
      },
    ],
    ...overrides,
  };
}

function dbPool(data) {
  const database = {
    signal: { source_signal_id: sourceSignalId, status: "error", reason: "legacy_error" },
    position: {
      source_signal_id: sourceSignalId,
      symbol,
      status: "closing",
      snapshot: structuredClone(data.snapshot),
      updated_at: new Date().toISOString(),
    },
    intents: [
      structuredClone(data.closeIntent),
      structuredClone(data.entryIntent),
    ],
    events: [],
  };
  let transactionStart = null;
  const transactions = [];
  const client = {
    async query(sql, params = []) {
      const text = sql.trim();
      transactions.push(text);
      if (text === "BEGIN") {
        transactionStart = structuredClone(database);
        return { rowCount: 0, rows: [] };
      }
      if (text === "COMMIT") {
        transactionStart = null;
        return { rowCount: 0, rows: [] };
      }
      if (text === "ROLLBACK") {
        if (transactionStart) {
          Object.assign(database, transactionStart);
          transactionStart = null;
        }
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("pg_advisory_xact_lock")) {
        return { rowCount: 1, rows: [] };
      }
      if (text.startsWith("SELECT source_signal_id, status FROM vst_signals")) {
        return { rowCount: 1, rows: [{ ...database.signal }] };
      }
      if (text.startsWith("SELECT source_signal_id, symbol, status, snapshot, updated_at")) {
        return { rowCount: 1, rows: [structuredClone(database.position)] };
      }
      if (text.includes("FROM vst_order_intents") && text.includes("client_order_id = $2")) {
        const intent = database.intents.find((row) => row.clientOrderId === params[1]);
        return { rowCount: intent ? 1 : 0, rows: intent ? [intentRow(intent)] : [] };
      }
      if (text.includes("FROM vst_order_intents") && text.includes("phase = 'market-entry'")) {
        const intent = database.intents.find((row) => row.phase === "market-entry");
        return { rowCount: intent ? 1 : 0, rows: intent ? [intentRow(intent)] : [] };
      }
      if (text.startsWith("UPDATE vst_positions")) {
        database.position.status = params[1];
        database.position.snapshot = JSON.parse(params[2]);
        database.position.updated_at = new Date().toISOString();
        return { rowCount: 1, rows: [structuredClone(database.position)] };
      }
      if (text.startsWith("UPDATE vst_order_intents")) {
        const intent = database.intents.find((row) => row.clientOrderId === params[1]);
        if (!intent || intent.state !== "unknown") return { rowCount: 0, rows: [] };
        intent.state = "failed";
        intent.outcome = JSON.parse(params[2]);
        intent.updatedAt = new Date().toISOString();
        return { rowCount: 1, rows: [{ client_order_id: intent.clientOrderId }] };
      }
      if (text.startsWith("UPDATE vst_signals")) {
        database.signal.status = params[1];
        database.signal.reason = params[2];
        return { rowCount: 1, rows: [{ source_signal_id: sourceSignalId }] };
      }
      if (text.startsWith("INSERT INTO vst_events")) {
        database.events.push({
          source_signal_id: params[0],
          client_order_id: params[1],
          kind: "vst_pre_runner_close_owner_reviewed",
          detail: JSON.parse(params[2]),
        });
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected mock SQL: ${text}`);
    },
    release() {},
  };
  return {
    database,
    transactions,
    async connect() { return client; },
    async query(sql) { throw new Error(`Unexpected pool SQL: ${sql}`); },
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

function submitArgs(data, outcome = "open", evidence = openEvidence(data), overrides = {}) {
  const expectedPosition = {
    ...structuredClone(data.snapshot),
    status: outcome === "open" ? "closing" : "closed",
    ...(outcome === "closed" ? { remainingQty: 0 } : {}),
  };
  return {
    sourceSignalId,
    clientOrderId: data.closeIntent.clientOrderId,
    expectedIntent: structuredClone(data.closeIntent),
    expectedPositionSnapshot: structuredClone(data.snapshot),
    review: review(outcome, evidence),
    position: expectedPosition,
    ...overrides,
  };
}

function multiCloseInput(data) {
  const entryTime = data.entryOrder.time;
  const stopTime = data.closeOrder.time - 10_000;
  const marketTime = data.closeOrder.time;
  const stopId = data.coreStop.orderId;
  const childId = "core-stop-child";
  const child = {
    ...data.closeOrder, orderId: childId, clientOrderId: "",
    type: "STOP_MARKET", triggerOrderId: stopId, stopPrice: data.coreStop.stopPrice,
    workingType: "MARK_PRICE", origQty: "40", executedQty: "40", avgPrice: "0.020",
    time: stopTime, updateTime: stopTime + 500,
  };
  const parent = {
    ...child, orderId: stopId, positionID: "0",
    childOrderId: childId, mainOrderId: data.entryOrder.orderId,
    triggerOrderId: undefined,
  };
  const market = {
    ...data.closeOrder, origQty: "60", executedQty: "60", avgPrice: "0.021",
    updateTime: marketTime + 500,
  };
  const entryBase = data.fills[0];
  const closeBase = data.fills[1];
  const makeFill = (base, id, order, amount, fillPrice, time, pnl, fee = "-0.002") => ({
    ...base, tradeId: id, orderId: order, qty: amount, price: fillPrice,
    filledTime: new Date(time).toISOString(), realisedPNL: pnl, commission: fee,
  });
  const fills = [
    makeFill(entryBase, "entry-part-1", data.entryOrder.orderId, "50", "0.020",
      entryTime, "0", "-0.005"),
    makeFill(entryBase, "entry-part-2", data.entryOrder.orderId, "50", "0.022",
      entryTime + 500, "0", "-0.005"),
    { ...makeFill(closeBase, "stop-part-1", childId, "20", "0.020",
      stopTime, "-0.12"), triggerOrderId: stopId },
    { ...makeFill(closeBase, "stop-part-2", childId, "20", "0.020",
      stopTime + 500, "0.05"), triggerOrderId: stopId },
    makeFill(closeBase, "market-part-1", market.orderId, "30", "0.021",
      marketTime, "0.013"),
    makeFill(closeBase, "market-part-2", market.orderId, "30", "0.021",
      marketTime + 500, "0.017"),
  ];
  return {
    candidate: {
      sourceSignalId, symbol, status: "closing", snapshot: data.snapshot,
      entryIntent: data.entryIntent, closeIntent: data.closeIntent,
      ownerPreRunnerCloseReview: true,
    },
    entryOrder: { ...data.entryOrder, updateTime: entryTime + 500 },
    closeOrder: market, closeOrders: [child, market], stopOrders: [parent],
    fills,
    coverage: [{ ...data.coverage[0], rawCount: fills.length }],
    coverageEndTs: data.coverage[0].endTs,
    freshPositions: [{ symbol: "US-USDT", positionAmt: "0", positionSide: "LONG" }],
    freshOpenOrders: [],
    expectedExchangeClientOrderId: deriveVstExchangeClientOrderId(data.entryIntent.clientOrderId),
    expectedCloseExchangeClientOrderId: deriveVstExchangeClientOrderId(data.closeIntent.clientOrderId),
    accountId, observedAtMs: now(), nowMs: now(),
  };
}

function verifiedMultiClose(data) {
  return {
    ...verifyHistoricalCloseEvidence(multiCloseInput(data)),
    entryIntent: structuredClone(data.entryIntent),
  };
}

function roundedMultiCloseInput(data) {
  const input = multiCloseInput(data);
  input.contract = { symbol: "US-USDT", pricePrecision: 6 };
  data.snapshot.verifiedFill.price = "0.02133333";
  input.entryOrder.avgPrice = "0.02133333";
  input.fills[0].qty = "33.33333333";
  input.fills[1].qty = "66.66666667";
  const market = input.closeOrders.find((row) => row.type === "MARKET");
  market.avgPrice = "0.02066667";
  input.fills[4].qty = "20";
  input.fills[4].price = "0.020";
  input.fills[5].qty = "40";
  return input;
}

test("rounded entry and repeating exit averages are reverified inside the atomic store, without changing native PnL", async () => {
  const data = fixture();
  const input = roundedMultiCloseInput(data);
  const evidence = {
    ...verifyHistoricalCloseEvidence(input), entryIntent: structuredClone(data.entryIntent),
  };
  const pool = dbPool(data);
  const result = await createVstStore(pool).resolveLegacyPreRunnerCloseReview(
    submitArgs(data, "closed", evidence),
  );
  assert.equal(result.kind, "resolved");
  assert.equal(result.position.snapshot.exchangeHistoryProvenance.closeFill.price, "0.0204");
  assert.equal(Number(result.position.snapshot.closeFill.realisedPnl), -0.04);
  assert.equal(result.review.evidence.contract.pricePrecision, 6);

  const second = fixture();
  const secondInput = roundedMultiCloseInput(second);
  const forged = {
    ...verifyHistoricalCloseEvidence(secondInput), entryIntent: structuredClone(second.entryIntent),
  };
  forged.closeOrders.find((row) => row.type === "MARKET").avgPrice = "0.02066668";
  const refusedPool = dbPool(second);
  const before = structuredClone(refusedPool.database);
  await assert.rejects(createVstStore(refusedPool).resolveLegacyPreRunnerCloseReview(
    submitArgs(second, "closed", forged),
  ), /close_order_price_mismatch/);
  assert.deepEqual(refusedPool.database, before);
});

test("multi-fill owner close persists exact component fees and native PnL atomically and replays once", async () => {
  const data = fixture();
  const evidence = verifiedMultiClose(data);
  const pool = dbPool(data);
  const result = await createVstStore(pool).resolveLegacyPreRunnerCloseReview(
    submitArgs(data, "closed", evidence),
  );
  assert.equal(result.kind, "resolved");
  const history = result.position.snapshot.exchangeHistoryProvenance;
  assert.equal(history.lifecycleVersion, 2);
  assert.equal(history.entryFills.length, 2);
  assert.equal(history.closeFills.length, 4);
  assert.equal(Number(history.entryFill.fee.amount), -0.01);
  assert.equal(Number(history.closeFill.fee.amount), -0.008);
  assert.equal(Number(history.closeFill.realisedPnl), -0.04);
  assert.equal(Number(history.closeFill.price), 0.0206);
  assert.equal(history.closeFill.realisedPnlProvenance, "bingx_fill_history.realisedPNL");
  assert.equal(history.closeFill.quantity, "100");
  assert.equal(history.closeOrderIds.length, 2);
  assert.equal(pool.database.intents[0].state, "failed");
  assert.equal(pool.database.signal.status, "closed");
  assert.deepEqual(pool.database.intents[0].outcome.ownerPreRunnerCloseReview.originalOutcome,
    data.originalOutcome);
  const savedIntent = structuredClone(pool.database.intents[0]);
  const savedPosition = structuredClone(pool.database.position.snapshot);
  const replay = await createVstStore(pool).resolveLegacyPreRunnerCloseReview({
    ...submitArgs(data, "closed", evidence),
    expectedIntent: savedIntent, expectedPositionSnapshot: savedPosition,
    position: savedPosition,
  });
  assert.equal(replay.kind, "replayed");
  assert.equal(pool.database.events.length, 1);
});

test("multi-fill store revalidates raw proof, ownership and accounting under the lock", async () => {
  const corruptions = [
    ["coverage missing", (e) => { delete e.coverage; }],
    ["raw window saturated", (e) => { e.coverage[0].rawCount = 1000; }],
    ["missing fill", (e) => { e.fills.pop(); }],
    ["duplicate fill", (e) => { e.fills.push(structuredClone(e.fills[0])); }],
    ["foreign child", (e) => { e.closeOrders[0].positionID = "other-position"; }],
    ["foreign stop", (e) => { e.stopOrders[0].orderId = "unowned-stop"; }],
    ["missing stop proof", (e) => { e.stopOrders = []; }],
    ["missing native fee", (e) => { delete e.fills[2].commissionAsset; }],
    ["missing native PnL", (e) => { delete e.fills[2].realisedPNL; }],
    ["forged aggregate", (e) => { e.closeFill.realisedPnl = "999"; }],
    ["stale evidence", (e) => { e.observedAt = new Date(now() - 6000).toISOString(); }],
  ];
  for (const [label, corrupt] of corruptions) {
    const data = fixture();
    const evidence = verifiedMultiClose(data);
    corrupt(evidence);
    const pool = dbPool(data);
    const before = structuredClone(pool.database);
    let result;
    try {
      result = await createVstStore(pool).resolveLegacyPreRunnerCloseReview(
        submitArgs(data, "closed", evidence),
      );
    } catch (error) {
      assert.match(error.message, /historical_close|proof_invalid/, label);
    }
    assert.notEqual(result?.kind, "resolved", label);
    assert.deepEqual(pool.database, before, `${label} leaves the ledger unchanged`);
  }
});

test("multi-fill store refuses changed locked entry and rolls back all writes on atomic update failure", async () => {
  const data = fixture();
  const evidence = verifiedMultiClose(data);
  const changed = dbPool(data);
  changed.database.intents[1].outcome.fillQuantity = "99";
  const before = structuredClone(changed.database);
  assert.equal((await createVstStore(changed).resolveLegacyPreRunnerCloseReview(
    submitArgs(data, "closed", evidence),
  )).kind, "refused");
  assert.deepEqual(changed.database, before);

  const pool = dbPool(data);
  const client = await pool.connect();
  const query = client.query.bind(client);
  client.query = async (sql, params) =>
    sql.trim().startsWith("UPDATE vst_signals") ? { rowCount: 0, rows: [] } : query(sql, params);
  const initial = structuredClone(pool.database);
  await assert.rejects(createVstStore(pool).resolveLegacyPreRunnerCloseReview(
    submitArgs(data, "closed", evidence),
  ), /atomic_transition_failed/);
  assert.deepEqual(pool.database, initial);
  assert.ok(pool.transactions.includes("ROLLBACK"));
});

test("multi-fill broker queries every exact exit and stop parent before fresh flat reads, never writes", async () => {
  const data = fixture();
  const input = roundedMultiCloseInput(data);
  const calls = [];
  const unexpectedWrite = async () => { throw new Error("unexpected exchange write"); };
  const queriedOrders = [input.entryOrder, ...input.closeOrders, ...input.stopOrders];
  const api = {
    placeVstAutomatedLong: unexpectedWrite, upgradeVstLongStop: unexpectedWrite,
    closeLong: unexpectedWrite, setVstLongLeverage10: unexpectedWrite,
    getBalance: async () => [], getPositionMode: async () => "HEDGE",
    getMarginType: async () => "ISOLATED", getLeverage: async () => ({ longLeverage: 10 }),
    contract: async () => {
      calls.push(["contract"]);
      return input.contract;
    },
    getRiskTiers: async () => [], getFeeRate: async () => ({}),
    getFunding: async () => ({}), getVstMarkPrice: async () => ({}),
    queryOrderHistory: async () => { throw new Error("unsupported history path"); },
    queryFills: async () => { throw new Error("incomplete history path"); },
    supportsCompleteFillHistory: true,
    queryCompleteFillHistory: async (_, range) => {
      calls.push(["history", range]);
      return { fills: input.fills, coverage: {
        ...input.coverage[0], startTs: range.startTs, endTs: range.endTs,
        observedAt: new Date(now()).toISOString(),
      } };
    },
    queryOrder: async (_, { orderId }) => {
      calls.push(["order", orderId]);
      return queriedOrders.find((order) => order.orderId === orderId);
    },
    getPositions: async () => { calls.push(["flatPositions"]); return input.freshPositions; },
    getOpenOrders: async () => { calls.push(["flatOrders"]); return []; },
  };
  const proof = await createVstBroker({
    api, accountId, canarySymbols: [symbol], clock: now, stopBufferRate: 0.01,
  })
    .readHistoricalErrorClose(input.candidate);
  assert.equal(proof.verified, true);
  assert.equal(proof.lifecycleVersion, 2);
  assert.equal(proof.closeFills.length, 4);
  assert.deepEqual(calls.filter(([kind]) => kind === "order").map(([, id]) => id).sort(),
    queriedOrders.map((order) => order.orderId).sort());
  assert.ok(calls.slice(-2).every(([kind]) => kind.startsWith("flat")));
  assert.equal(Number(proof.closeFill.realisedPnl), -0.04);
  assert.deepEqual(proof.contract, input.contract);
  assert.ok(calls.findIndex(([kind]) => kind === "contract") <
    calls.findIndex(([kind]) => kind === "flatPositions"));
  input.closeOrders.find((row) => row.type === "MARKET").avgPrice = "0.02066668";
  await assert.rejects(createVstBroker({
    api, accountId, canarySymbols: [symbol], clock: now, stopBufferRate: 0.01,
  }).readHistoricalErrorClose(input.candidate), /close_order_price_mismatch/);
});

test("open review accepts missing mutation provenance, preserves the original error, and replays after restart", async () => {
  const data = fixture();
  assert.equal(Object.hasOwn(data.originalOutcome, "mutationProvenance"), false);
  const pool = dbPool(data);
  const firstStore = createVstStore(pool);
  const result = await firstStore.resolveLegacyPreRunnerCloseReview(
    submitArgs(data),
  );

  assert.equal(result.kind, "resolved");
  assert.equal(result.position.status, "closing");
  assert.equal(result.position.snapshot.status, "closing");
  assert.equal(pool.database.signal.status, "error");
  assert.equal(pool.database.signal.reason,
    "owner_reviewed_legacy_pre_runner_close_still_open");
  assert.equal(pool.database.intents[0].state, "failed");
  assert.equal(pool.database.intents[0].outcome.error, data.originalOutcome.error);
  assert.equal(pool.database.intents[0].outcome.errorMessage, data.originalOutcome.errorMessage);
  assert.equal(Object.hasOwn(pool.database.intents[0].outcome, "mutationProvenance"), false);
  assert.deepEqual(pool.database.intents[0].outcome.ownerPreRunnerCloseReview.originalOutcome,
    data.originalOutcome);
  assert.equal(pool.database.events.length, 1);
  assert.equal(pool.database.events[0].kind, "vst_pre_runner_close_owner_reviewed");

  const savedIntent = structuredClone(pool.database.intents[0]);
  const replayArgs = submitArgs(data);
  replayArgs.expectedIntent = savedIntent;
  replayArgs.expectedPositionSnapshot = structuredClone(pool.database.position.snapshot);
  replayArgs.position = structuredClone(pool.database.position.snapshot);
  const restartedStore = createVstStore(pool);
  const replay = await restartedStore.resolveLegacyPreRunnerCloseReview(replayArgs);
  assert.equal(replay.kind, "replayed");
  assert.equal(pool.database.events.length, 1);
});

test("open review refuses changed request, changed snapshot, mismatched stops, quantity, and stale proof", async () => {
  const cases = [
    {
      name: "request",
      args: (data) => {
        const expectedIntent = structuredClone(data.closeIntent);
        expectedIntent.request.symbol = "OTHERUSDT";
        return submitArgs(data, "open", openEvidence(data), { expectedIntent });
      },
    },
    {
      name: "request quantity",
      prepare: (data) => { data.closeIntent.request.totalQuantity = "99"; },
      args: (data) => submitArgs(data),
    },
    {
      name: "snapshot",
      args: (data) => submitArgs(data, "open", openEvidence(data), {
        expectedPositionSnapshot: { ...structuredClone(data.snapshot), remainingQty: "99" },
      }),
    },
    {
      name: "stop",
      args: (data) => submitArgs(data, "open", openEvidence(data, {
        stops: openEvidence(data).stops.map((stop) => stop.orderId === data.originalStop.orderId
          ? { ...stop, stopPrice: "0.018" } : stop),
      })),
    },
    {
      name: "quantity",
      args: (data) => submitArgs(data, "open", openEvidence(data, { quantity: "99" })),
    },
    {
      name: "stale proof",
      args: (data) => {
        const stale = openEvidence(data, {
          observedAt: new Date(now() - 6_000).toISOString(),
        });
        return submitArgs(data, "open", stale);
      },
    },
  ];
  for (const entry of cases) {
    const data = fixture();
    entry.prepare?.(data);
    const pool = dbPool(data);
    const before = structuredClone(pool.database);
    const result = await createVstStore(pool)
      .resolveLegacyPreRunnerCloseReview(entry.args(data));
    assert.equal(result.kind, "refused", entry.name);
    assert.deepEqual(pool.database, before, `${entry.name} refusal leaves the ledger unchanged`);
  }
});

test("closed review requires complete verified native historical evidence", async () => {
  const data = fixture();
  const evidence = {
    ...structuredClone(data.verifiedClose),
    verified: true,
    environment: "vst",
    accountId,
    symbol,
    positionId,
    observedAt: new Date(now()).toISOString(),
    entryIntent: structuredClone(data.entryIntent),
    entryOrder: structuredClone(data.entryOrder),
    closeOrder: structuredClone(data.closeOrder),
    fills: structuredClone(data.fills),
    coverage: structuredClone(data.coverage),
    coverageEndTs: data.coverage[0].endTs,
    freshPositions: [{ symbol: "US-USDT", positionAmt: "0", positionSide: "LONG" }],
    freshOpenOrders: [],
  };
  const pool = dbPool(data);
  const result = await createVstStore(pool).resolveLegacyPreRunnerCloseReview(
    submitArgs(data, "closed", evidence),
  );
  assert.equal(result.kind, "resolved");
  assert.equal(result.position.status, "closed");
  assert.equal(result.position.snapshot.remainingQty, 0);
  assert.equal(result.position.snapshot.manualResolution.provenance,
    "verified_exchange_fill");
  assert.equal(result.position.snapshot.closeFill.quantity, quantity);
  assert.equal(result.position.snapshot.exchangeHistoryProvenance.verified, true);
  assert.deepEqual(result.position.snapshot.exchangeHistoryProvenance.closeFill,
    result.position.snapshot.closeFill);
  assert.equal(result.position.snapshot.exchangeHistoryProvenance.fundingStatus, "unverified");
  assert.deepEqual(result.position.snapshot.closeFill.fee, {
    asset: "VST", amount: "-0.01",
  });
  assert.equal(pool.database.signal.status, "closed");
  assert.equal(pool.database.events.length, 1);
});

test("closed review refuses missing fill-history coverage", async () => {
  const data = fixture();
  const evidence = {
    ...structuredClone(data.verifiedClose),
    verified: true,
    environment: "vst",
    accountId,
    symbol,
    positionId,
    observedAt: new Date(now()).toISOString(),
    entryIntent: structuredClone(data.entryIntent),
    entryOrder: structuredClone(data.entryOrder),
    closeOrder: structuredClone(data.closeOrder),
    fills: structuredClone(data.fills),
    coverageEndTs: data.coverage[0].endTs,
    freshPositions: [{ symbol: "US-USDT", positionAmt: "0", positionSide: "LONG" }],
    freshOpenOrders: [],
  };
  delete evidence.coverage;
  const pool = dbPool(data);
  const before = structuredClone(pool.database);
  await assert.rejects(
    createVstStore(pool).resolveLegacyPreRunnerCloseReview(
      submitArgs(data, "closed", evidence),
    ),
    /fill_coverage_unverified|proof_invalid/,
  );
  assert.deepEqual(pool.database, before);
  assert.ok(pool.transactions.includes("ROLLBACK"));
});

test("failed atomic signal update rolls back position, intent, and event writes", async () => {
  const data = fixture();
  const pool = dbPool(data);
  const baseClient = await pool.connect();
  const originalQuery = baseClient.query.bind(baseClient);
  // The test client returns an unsuccessful signal update after the earlier
  // position and intent writes have succeeded, exercising transaction rollback.
  const client = {
    async query(sql, params = []) {
      if (sql.trim().startsWith("UPDATE vst_signals")) {
        pool.transactions.push(sql.trim());
        return { rowCount: 0, rows: [] };
      }
      return originalQuery(sql, params);
    },
    release() {},
  };
  pool.connect = async () => client;
  const before = structuredClone(pool.database);
  await assert.rejects(
    createVstStore(pool).resolveLegacyPreRunnerCloseReview(submitArgs(data)),
    /legacy_pre_runner_review_atomic_transition_failed/,
  );
  assert.deepEqual(pool.database, before);
  assert.ok(pool.transactions.includes("ROLLBACK"));
  assert.equal(pool.database.events.length, 0);
});