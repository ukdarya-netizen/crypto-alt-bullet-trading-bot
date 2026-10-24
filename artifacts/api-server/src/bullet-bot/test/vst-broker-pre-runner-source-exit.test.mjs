import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import test, { after, mock } from "node:test";
import { createVstBroker } from "../vst-broker.mjs";
import { createVstStore } from "../vst-store.mjs";
import { getVstResultDiagnosticRef } from "../vst-diagnostics.mjs";

// Keep the intended two-window historical interval stable as wall time advances.
const now = Date.parse("2026-10-03T04:00:00Z");
mock.timers.enable({ apis: ["Date"], now });
after(() => mock.timers.reset());
const entryAt = Date.parse("2026-10-01T22:15:48.000+08:00");
const entryAtIso = "2026-10-01T22:15:48.000+08:00";
const entryIntentAt = Date.parse("2026-10-01T22:14:48.000+08:00");
const symbol = "BTCUSDT";
const name = "BTC-USDT";
const accountId = "test-vst-account";
const entryClientOrderId = "source-exit-entry-client";
const entryExchangeClientId = `vst-${createHash("sha256")
  .update(entryClientOrderId).digest("hex").slice(0, 28)}`;
const entryOrderId = "entry-parent-102868";
const positionId = "position-102868";
const quantity = "102868";
const coreQuantity = "82294.4";
const entryFill = {
  symbol: name,
  orderId: entryOrderId,
  side: "BUY",
  positionSide: "LONG",
  qty: quantity,
  price: "0.09002",
  filledTm: entryAtIso,
  filledTime: entryAtIso,
  tradeId: "entry-fill-1",
};

function makeFixture(overrides = {}) {
  const originalStop = {
    orderId: "original-stop", quantity, stopPrice: "0.08000",
  };
  const coreStop = {
    orderId: "core-stop", quantity: coreQuantity, stopPrice: "0.08000",
  };
  const request = {
    operation: "close_pre_runner_split",
    environment: "vst",
    accountId,
    sourceSignalId: "signal-source-exit",
    symbol,
    positionId,
    totalQuantity: quantity,
    closeIntentId: "close-intent-legacy",
    originalStop,
    coreStop,
    priorPosition: {
      sourceSignalId: "signal-source-exit",
      environment: "vst",
      accountId,
      symbol,
      patternId: "impulse_buy",
      entryOrderId,
      entryClientOrderId,
      entryOrderType: "MARKET",
      verifiedFill: {
        at: entryAtIso,
        price: "0.09002",
        quantity,
      },
      quantity,
      signalStopPrice: "0.08000",
      signalSnapshot: { stopLoss: "0.08000" },
      exchangePositionId: positionId,
      split: {
        stage: "runner_pending",
        entryOrderId,
        positionId,
        totalQuantity: quantity,
        originalStopOrderId: originalStop.orderId,
        signalStopPrice: "0.08000",
        coreStop: {
          orderId: coreStop.orderId,
          quantity: coreQuantity,
          stopPrice: "0.08000",
        },
      },
    },
  };
  const entryProof = {
    entryClientOrderId,
    entryOrderId,
    positionId,
    intentCreatedAt: entryIntentAt,
    quantity,
    entryOrderType: "MARKET",
  };
  const position = {
    symbol: name,
    positionId,
    positionSide: "LONG",
    positionAmt: quantity,
    avgPrice: "0.09001",
  };
  const makeStop = ({ id, qty, query = false }) => ({
    symbol: name,
    orderId: id,
    positionID: query ? 0 : positionId,
    mainOrderId: "",
    type: "STOP_MARKET",
    status: "NEW",
    side: "SELL",
    positionSide: "LONG",
    workingType: "MARK_PRICE",
    origQty: qty,
    executedQty: "0",
    stopPrice: "0.08000",
  });
  const orders = [
    makeStop({ id: originalStop.orderId, qty: quantity }),
    makeStop({ id: coreStop.orderId, qty: coreQuantity }),
  ];
  const queriedOrders = {
    [entryOrderId]: {
      symbol: name,
      orderId: entryOrderId,
      clientOrderId: entryExchangeClientId,
      positionId,
      status: "FILLED",
      side: "BUY",
      positionSide: "LONG",
      type: "MARKET",
      origQty: quantity,
      executedQty: quantity,
      avgPrice: "0.09002",
      time: entryAt,
    },
    [originalStop.orderId]: makeStop({
      id: originalStop.orderId, qty: quantity, query: true,
    }),
    [coreStop.orderId]: makeStop({
      id: coreStop.orderId, qty: coreQuantity, query: true,
    }),
  };
  let historyRows = [entryFill];
  let completeCoverageMode = "valid";
  let closeOrder = null;
  let positionReads = 0;
  let currentTime = now;
  let historyAdvanceMs = 0;
  let finalPairDelayMs = 0;
  const calls = [];
  const api = {
    async queryOrderHistory(_symbol, range) {
      calls.push(["history", range]);
      return [{
        ...queriedOrders[entryOrderId],
        time: entryAt,
      }];
    },
    async queryFills(_symbol, range) {
      calls.push(["fills", range]);
      return historyRows.filter((row) =>
        String(row.orderId) === String(range.orderId));
    },
    async queryCompleteFillHistory(_symbol, range) {
      calls.push(["complete", range]);
      const startTs = range.startTs;
      const endTs = range.endTs;
      const rows = historyRows.filter((row) =>
        Date.parse(row.filledTime) > startTs &&
          Date.parse(row.filledTime) <= endTs);
      const coverage = {
        verified: true,
        endpoint: "/openApi/swap/v2/trade/fillHistory",
        startTs,
        endTs,
        currency: "USDT",
        rawCount: rows.length,
        pageSize: 1_000,
        passes: 2,
        terminalPage: 2,
        snapshotSha256: createHash("sha256")
          .update(`${startTs}-${endTs}-${JSON.stringify(rows)}`).digest("hex"),
          observedAt: new Date(currentTime).toISOString(),
      };
      if (completeCoverageMode === "incomplete") {
        coverage.verified = false;
      } else if (completeCoverageMode === "saturated") {
        coverage.rawCount = 1_000;
      } else if (completeCoverageMode === "changed") {
        coverage.snapshotSha256 = "invalid-coverage-digest";
      }
      const result = {
        rawFills: rows,
        fills: rows.filter((row) => row.symbol === name),
        coverage,
      };
      if (historyAdvanceMs !== 0) {
        currentTime += historyAdvanceMs;
        historyAdvanceMs = 0;
      }
      return result;
    },
    async queryOrder(_symbol, selector) {
      calls.push(["order", selector]);
      if (selector.clientOrderId) return closeOrder;
      return queriedOrders[selector.orderId] ?? null;
    },
    async getPositions() {
      positionReads += 1;
      calls.push(["positions", positionReads]);
      return [position];
    },
    async getOpenOrders() {
      calls.push(["openOrders"]);
      if (positionReads >= 3 && finalPairDelayMs !== 0) {
        currentTime += finalPairDelayMs;
        finalPairDelayMs = 0;
      }
      return orders;
    },
    async getPositionMode() { return "HEDGE"; },
    async getMarginType() { return "ISOLATED"; },
    async getLeverage() { return { longLeverage: 10 }; },
    async getBalance() { return [{ asset: "VST", balance: "1000" }]; },
    async getRiskTiers() { return []; },
    async getFeeRate() { return { maker: 0, taker: 0 }; },
    async getFunding() { return { rate: 0, nextFundingTime: now + 60_000 }; },
    async setVstLongLeverage10() { throw new Error("unused"); },
    async contract() { return { pricePrecision: 5 }; },
    async getVstMarkPrice() { throw new Error("unused"); },
    async placeVstAutomatedLong() { throw new Error("unused"); },
    async upgradeVstLongStop() { throw new Error("unused"); },
    async closeLong() { throw new Error("unused"); },
  };
  const broker = createVstBroker({
    api,
    accountId,
    canarySymbols: [symbol],
    clock: () => currentTime,
    stopBufferRate: 0.005,
  });
  return {
    broker, api, calls, request, entryProof, orders, position, queriedOrders,
    setHistory(rows) { historyRows = rows; },
    setCoverageMode(value) { completeCoverageMode = value; },
    setCloseOrder(value) { closeOrder = value; },
    setTiming({ startAt = now, advanceAfterHistoryMs = 0,
      finalPairDelay = 0 } = {}) {
      currentTime = startAt;
      historyAdvanceMs = advanceAfterHistoryMs;
      finalPairDelayMs = finalPairDelay;
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

function adoptionPool(database) {
  let beforeTransaction;
  const client = {
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, " ").trim();
      if (text === "BEGIN") {
        beforeTransaction = structuredClone(database);
        return { rows: [], rowCount: 0 };
      }
      if (text === "COMMIT") {
        beforeTransaction = null;
        return { rows: [], rowCount: 0 };
      }
      if (text === "ROLLBACK") {
        if (beforeTransaction) {
          for (const key of Object.keys(database)) delete database[key];
          Object.assign(database, beforeTransaction);
          beforeTransaction = null;
        }
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 1 };
      }
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

test("legacy pre-runner proof verifies old full entry and two zero-ID queried stops read-only", async () => {
  const fixture = makeFixture();
  const proof = await fixture.broker.verifyPreRunnerOpenForSourceExit({
    request: fixture.request,
    entryProof: fixture.entryProof,
  });
  assert.equal(proof.verified, true);
  assert.equal(proof.environment, "vst");
  assert.equal(proof.positionId, positionId);
  assert.equal(proof.quantity, quantity);
  assert.deepEqual(proof.entryProof, fixture.entryProof);
  assert.equal(proof.entryFills[0].price, "0.09002");
  assert.equal(proof.entryOrder.positionId, positionId);
  assert.equal(proof.positionAveragePrice, "0.09001");
  assert.equal(proof.entryPriceTickSize, "0.00001");
  assert.equal(proof.coverageEndTs, now);
  assert.deepEqual(proof.stops.map(({ orderId: id, positionId: idPosition,
    quantity: qty, stopPrice }) => ({ orderId: id, positionId: idPosition,
    quantity: qty, stopPrice })), [
    { orderId: "original-stop", positionId, quantity, stopPrice: "0.08" },
    { orderId: "core-stop", positionId, quantity: coreQuantity, stopPrice: "0.08" },
  ]);
  assert.equal(proof.historyCoverage.length, 2);
  assert.equal(fixture.calls.filter(([name]) => name === "complete").length, 2);
  assert.ok(fixture.calls.some(([name, selector]) =>
    name === "order" && selector.clientOrderId?.startsWith("vst-")));
  assert.equal(fixture.calls.some(([name]) =>
    ["entry", "close", "cancel", "upgradeStop"].includes(name)), false);
});

test("pre-runner proof refuses non-entry lifecycle fills, partials, sells and foreign orders", async () => {
  const cases = [
    [{ ...entryFill, qty: "102867" }],
    [{ ...entryFill, side: "SELL" }],
    [{ ...entryFill, positionSide: "SHORT" }],
    [{ ...entryFill, orderId: "foreign-entry" }],
    [entryFill, { ...entryFill, tradeId: "other-fill", qty: "1",
      orderId: "foreign-entry" }],
  ];
  for (const rows of cases) {
    const fixture = makeFixture();
    fixture.setHistory(rows);
    const proof = await fixture.broker.verifyPreRunnerOpenForSourceExit({
      request: fixture.request, entryProof: fixture.entryProof,
    });
    assert.deepEqual(proof, { verified: false, status: "unknown" });
  }
});

test("pre-runner proof refuses incomplete, saturated or changed collector coverage", async () => {
  for (const mode of ["incomplete", "saturated", "changed"]) {
    const fixture = makeFixture();
    fixture.setCoverageMode(mode);
    const proof = await fixture.broker.verifyPreRunnerOpenForSourceExit({
      request: fixture.request, entryProof: fixture.entryProof,
    });
    assert.deepEqual(proof, { verified: false, status: "unknown" });
  }
});

test("pre-runner proof separates the 120s read budget from the 5s final-state budget", async () => {
  const realistic = makeFixture();
  realistic.setTiming({
    startAt: Date.now() - 31_000,
    advanceAfterHistoryMs: 31_000,
  });
  const agedCoverage = await realistic.broker.verifyPreRunnerOpenForSourceExit({
    request: realistic.request, entryProof: realistic.entryProof,
  });
  assert.equal(agedCoverage.verified, true);
  assert.ok(Date.parse(agedCoverage.observedAt) -
    Date.parse(agedCoverage.historyCoverage[0].observedAt) >= 31_000);

  const proofOverBudget = makeFixture();
  proofOverBudget.setTiming({ advanceAfterHistoryMs: 120_001 });
  const expired = await proofOverBudget.broker.verifyPreRunnerOpenForSourceExit({
    request: proofOverBudget.request, entryProof: proofOverBudget.entryProof,
  });
  assert.deepEqual(expired, { verified: false, status: "unknown" });
  assert.match(getVstResultDiagnosticRef(expired), /^[a-f0-9]{12}$/);

  const finalPairOverBudget = makeFixture();
  finalPairOverBudget.setTiming({ finalPairDelay: 5_001 });
  const stalePair =
    await finalPairOverBudget.broker.verifyPreRunnerOpenForSourceExit({
      request: finalPairOverBudget.request,
      entryProof: finalPairOverBudget.entryProof,
    });
  assert.deepEqual(stalePair, { verified: false, status: "unknown" });
  assert.match(getVstResultDiagnosticRef(stalePair), /^[a-f0-9]{12}$/);
});

test("pre-runner proof refuses an existing close client order or changed position", async () => {
  const existingClose = makeFixture();
  existingClose.setCloseOrder({ symbol: name, orderId: "close-order" });
  assert.deepEqual(await existingClose.broker.verifyPreRunnerOpenForSourceExit({
    request: existingClose.request, entryProof: existingClose.entryProof,
  }), { verified: false, status: "unknown" });

  const changedPosition = makeFixture();
  changedPosition.position.positionAmt = "102867";
  assert.deepEqual(await changedPosition.broker.verifyPreRunnerOpenForSourceExit({
    request: changedPosition.request, entryProof: changedPosition.entryProof,
  }), { verified: false, status: "unknown" });

  const changedAverage = makeFixture();
  changedAverage.position.avgPrice = "0.08999";
  assert.deepEqual(await changedAverage.broker.verifyPreRunnerOpenForSourceExit({
    request: changedAverage.request, entryProof: changedAverage.entryProof,
  }), { verified: false, status: "unknown" });

  const foreignParent = makeFixture();
  foreignParent.queriedOrders["original-stop"].parentOrderId = "foreign-parent";
  const refused = await foreignParent.broker.verifyPreRunnerOpenForSourceExit({
    request: foreignParent.request, entryProof: foreignParent.entryProof,
  });
  assert.deepEqual(refused, { verified: false, status: "unknown" });
  assert.match(getVstResultDiagnosticRef(refused), /^[a-f0-9]{12}$/);
});

test("actual broker evidence round-trips through source-exit adoption store", async () => {
  const fixture = makeFixture();
  const sourceSignalId = "joined-pre-runner-source-exit";
  const phase = `impulse-runner-breakeven-abort-${now}`;
  const clientOrderId = `vst-${createHash("sha256")
    .update(`${sourceSignalId}:${phase}`).digest("hex").slice(0, 30)}`;
  fixture.request.sourceSignalId = sourceSignalId;
  fixture.request.closeIntentId = clientOrderId;
  fixture.request.priorPosition.sourceSignalId = sourceSignalId;
  fixture.request.priorPosition.status = "closing";
  fixture.request.priorPosition.entryAt = entryAtIso;
  fixture.request.priorPosition.remainingQty = quantity;
  fixture.request.priorPosition.signalSnapshot = {
    ...fixture.request.priorPosition.signalSnapshot,
    sourceSignalId,
    symbol,
    stopLoss: "0.08000",
  };
  fixture.entryProof.intentCreatedAt = new Date(entryIntentAt).toISOString();
  const snapshot = structuredClone(fixture.request.priorPosition);
  const sourceExitRequestId = `source-exit-${createHash("sha256")
    .update(sourceSignalId).digest("hex")}`;
  const sourceExitEvidence = {
    sourceSignalId,
    symbol,
    reason: "source_withdrawal",
    sourceStatus: "reclassified",
    sourceUpdatedAt: new Date(now - 60_000).toISOString(),
  };
  const sourceExitDetail = {
    requestId: sourceExitRequestId,
    sourceSignalId,
    symbol,
    reason: "source_withdrawal",
    evidence: sourceExitEvidence,
    asOf: new Date(now - 10_000).toISOString(),
    observedAt: new Date(now - 10_000).toISOString(),
    latestAsOf: new Date(now - 10_000).toISOString(),
    latestObservedAt: new Date(now - 10_000).toISOString(),
  };
  const sourceExitRequest = {
    id: sourceExitRequestId,
    requestId: sourceExitRequestId,
    sourceSignalId,
    symbol,
    reason: "source_withdrawal",
    evidence: sourceExitEvidence,
    asOf: sourceExitDetail.latestAsOf,
    observedAt: sourceExitDetail.latestObservedAt,
    createdAt: new Date(now - 8_000).toISOString(),
    eventId: 77,
  };
  const legacyIntent = {
    sourceSignalId,
    phase,
    clientOrderId,
    request: structuredClone(fixture.request),
    state: "unknown",
    exchangeOrderId: null,
    outcome: { error: "Error", errorMessage: "legacy timeout after request" },
    createdAt: new Date(now - 30_000),
    updatedAt: new Date(now - 20_000),
  };
  const entryRequest = {
    operation: "entry",
    environment: "vst",
    accountId,
    symbol,
    entryOrderType: "MARKET",
    quantity,
    intentCreatedAt: fixture.entryProof.intentCreatedAt,
  };
  const entryIntent = {
    sourceSignalId,
    phase: "market-entry",
    clientOrderId: entryClientOrderId,
    request: entryRequest,
    state: "reconciled",
    exchangeOrderId: entryOrderId,
    outcome: {
      verified: true,
      status: "filled",
      positionId,
      fillPrice: "0.09002",
      fillQuantity: quantity,
    },
    createdAt: new Date(entryIntentAt),
    updatedAt: new Date(entryAt),
  };
  const database = {
    signal: {
      source_signal_id: sourceSignalId,
      body: { symbol },
      status: "error",
    },
    position: {
      source_signal_id: sourceSignalId,
      symbol,
      status: "closing",
      snapshot: structuredClone(snapshot),
      updated_at: new Date(now - 1_000),
    },
    intents: [legacyIntent, entryIntent],
    sourceExit: {
      id: 77,
      source_signal_id: sourceSignalId,
      kind: "source_exit_requested",
      detail: sourceExitDetail,
      created_at: sourceExitRequest.createdAt,
    },
    completions: [],
    events: [],
  };
  const evidence = await fixture.broker.verifyPreRunnerOpenForSourceExit({
    request: fixture.request,
    entryProof: fixture.entryProof,
  });
  assert.equal(evidence.verified, true);
  assert.equal(evidence.positionAveragePrice, "0.09001");
  assert.equal(evidence.entryPriceTickSize, "0.00001");
  assert.equal(evidence.entryOrder.positionId, positionId);
  assert.equal(evidence.entryOrder.avgPrice, "0.09002");
  assert.equal(evidence.entryFills[0].positionId, undefined);
  const storeResult = await createVstStore(adoptionPool(database))
    .adoptPreRunnerOpenForSourceExit({
      sourceSignalId,
      clientOrderId,
      expectedIntent: structuredClone(legacyIntent),
      expectedPositionSnapshot: structuredClone(snapshot),
      expectedSourceExitRequest: sourceExitRequest,
      evidence,
    });
  assert.deepEqual(storeResult, { kind: "adopted" });
});