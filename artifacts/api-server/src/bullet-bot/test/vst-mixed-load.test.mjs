import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createVstBroker } from "../vst-broker.mjs";
import { createVstWorker } from "../vst-worker.mjs";
import { mixedLedger } from "./helpers/vst-mixed-ledger.mjs";
import { fetchBulletPositions } from "../source-position-sync.mjs";
import {
  mixedLoadHarness, EPOCH, ORDER, entry, raiseStop, close, assertSharedBudget,
} from "./helpers/vst-mixed-load.mjs";

const originalPause = process.env.BULLET_VST_PAUSED;
process.env.BULLET_VST_PAUSED = "0";
after(() => {
  if (originalPause === undefined) delete process.env.BULLET_VST_PAUSED;
  else process.env.BULLET_VST_PAUSED = originalPause;
});

// Source HTTP does NOT consume BingX slots. Its resulting exchange operations
// do. Keep the actual source adapter in this workload instead of incorrectly
// routing the source's own HTTP request through the exchange pacer.
async function sourceClose(f) {
  const result = await fetchBulletPositions({
    token: "local-source-token", clock: f.clock,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        asOf: new Date(f.clock()).toISOString(),
        snapshotAsOf: new Date(EPOCH).toISOString(),
        nextAfterId: null,
        positions: [{
          sourceSignalId: "source-closed", signalAt: new Date(EPOCH - 60000).toISOString(),
          botEnqueuedAt: null, symbol: "ETHUSDT", initialStopPrice: 95,
          sourceStatus: "profit", sourceAction: "close",
          sourceUpdatedAt: new Date(EPOCH).toISOString(),
          sourceClosedAt: new Date(EPOCH).toISOString(),
          sourceEntryPrice: 100, sourceExitPrice: 105, sourcePnlPercent: 5,
          sourcePeakPrice: 105, sourceStopLossPrice: 95,
          sourceTrailingStopLevel: null, sourceLastMilestone: null, sourceCancelReason: null,
        }],
      }),
    }),
  });
  assert.equal(result.positions.get("source-closed").sourceAction, "close");
  return f.run("source-close", api => close(api, result.positions.get("source-closed")));
}

function archive(f) {
  return f.run("archive", api => createVstBroker({
    api, accountId: "local-mixed-account", canarySymbols: ["BTCUSDT"], clock: f.clock,
    stopBufferRate: 0.01,
  }).captureFillArchiveWindow({ startTs: EPOCH - 3600000, endTs: EPOCH - 1000 }));
}

function backlog(f, count = 30) {
  return Promise.all(["history-read", "source-exchange-read"].map(role =>
    f.run(role, async api => {
      for (let i = 0; i < count; i++) await api.getPositions("SOLUSDT");
    })));
}

test("native entries, stop management, source close and broker archive share one paced budget without starving protection", async () => {
  const f = mixedLoadHarness();
  const [entered, stopped, closed, archived] = await f.drain(Promise.all([
    f.run("entry", api => entry(api)), f.run("stop", raiseStop),
    sourceClose(f), archive(f), backlog(f),
  ]));
  assert.equal(entered.orderId, "market-DOGE-USDT");
  assert.equal(stopped.newStopOrderId, "300");
  assert.equal(stopped.verified, true);
  assert.equal(f.orders.find(row => row.orderId === "200").status, "CANCELED");
  assert.equal(closed.orderId, "market-ETH-USDT");
  assert.equal(Object.isFrozen(archived), true);
  assert.equal(archived.rawFills.length, 1);
  assert.equal(archived.rawFills[0].tradeId, "90071992547409931235");
  assert.equal(archived.orders[0].orderId, "90071992547409931234");
  assertSharedBudget(f);
  const writes = f.requests.filter(row => row.method === "POST");
  assert.deepEqual(new Set(writes.map(row => row.role)),
    new Set(["entry", "stop", "source-close"]));
  for (const role of ["stop", "source-close"]) {
    const ready = f.reservations.find(row => row.role === role && row.priority);
    assert.ok(ready, `${role} completed its real native final guard`);
    assert.ok(ready.selectedAt - ready.queuedAt <= 1100,
      `${role} takes the next slot rather than draining the read backlog`);
    const post = writes.find(row => row.role === role);
    assert.ok(f.requests.some(row => row.at > post.at && row.role === "history-read"),
      `${role} is submitted while competing work remains`);
    assert.ok(post.at - EPOCH < 120000, `${role} preflight is not starved either`);
  }
  assert.equal(writes.find(row => row.role === "entry").params.type, "MARKET");
  assert.equal(writes.find(row => row.role === "entry").params.stopLoss,
    '{"type":"STOP_MARKET","stopPrice":98.0}');
});

test("exchange 429 cooldown applies across all native clients, including protective writes", async () => {
  const f = mixedLoadHarness();
  let limited = 0;
  f.hooks.rateLimit = ({ role }) => role === "rate-probe" && ++limited <= 2;
  await f.drain(Promise.all([
    f.run("entry", api => entry(api)), f.run("stop", raiseStop),
    sourceClose(f), archive(f), backlog(f),
    assert.rejects(f.run("rate-probe", api => api.getBalance())),
  ]));
  assert.equal(limited, 2, "GET retries once, then stops");
  assert.deepEqual(f.cooldowns.map(row => row.until - row.at), [1100, 5000]);
  assertSharedBudget(f);
  assert.equal(f.requests.filter(row => row.method === "POST").length, 3);
});

test("a burst of three fresh native entries cannot starve stop transfer and source close", async () => {
  const f = mixedLoadHarness();
  const attempts = ["DOGEUSDT", "SOLUSDT", "XRPUSDT"].map((symbol, index) =>
    f.run(`entry-${index}`, api => entry(api, {
      symbol, clientOrderId: `burst-${index}`,
    })).then(value => ({ value }), error => ({ error })));
  const results = await f.drain(Promise.all([
    ...attempts, f.run("stop", raiseStop), sourceClose(f), archive(f), backlog(f, 60),
  ]));
  assert.equal(results[3].verified, true);
  assert.equal(results[4].orderId, "market-ETH-USDT");
  for (const outcome of results.slice(0, 3)) {
    if (outcome.error) {
      assert.equal(outcome.error.transportStage, "pre_transport");
      assert.equal(outcome.error.preSignReason, "final_pre_sign_pacing_expired");
    } else assert.ok(outcome.value.orderId);
  }
  for (const role of ["stop", "source-close"]) {
    const post = f.requests.find(row => row.role === role && row.method === "POST");
    assert.ok(post.at - EPOCH <= 150000, `${role} preflight has a bounded wait`);
    assert.ok(f.requests.some(row => row.role === "history-read" && row.at > post.at));
  }
  const ids = f.requests.filter(row => row.path === ORDER && row.method === "POST" &&
    row.params.side === "BUY").map(row => row.params.clientOrderId);
  assert.equal(new Set(ids).size, ids.length, "one POST maximum per entry intent");
  assertSharedBudget(f);
});

test("rate-limited protective POST is never retried and its cooldown blocks the other clients", async () => {
  const f = mixedLoadHarness();
  f.hooks.rateLimit = ({ role, options }) => role === "stop" && options.method === "POST";
  const [error] = await f.drain(Promise.all([
    f.run("stop", raiseStop).then(() => assert.fail("429 accepted"), error => error),
    f.run("entry", api => entry(api)), archive(f), backlog(f, 30),
  ]));
  assert.equal(error.httpStatus, 429);
  assert.equal(error.transportStage, "exchange_response");
  assert.equal(f.requests.filter(row => row.role === "stop" && row.method === "POST").length, 1);
  assert.equal(f.requests.some(row => row.method === "DELETE"), false);
  assert.equal(f.orders.find(row => row.orderId === "200").status, "NEW");
  assert.ok(f.cooldowns.some(row => row.until - row.at === 5000));
  assertSharedBudget(f);
});

test("a delayed 429 after final checks expires queued entry instead of bypassing cooldown or retrying POST", async () => {
  const f = mixedLoadHarness();
  let release;
  // Hold an actual HTTP response, not a fake pacer verdict. This models a
  // background read that was sent earlier but returns 429 just as entry is ready.
  let attempts = 0;
  const delayedResponse = new Promise(resolve => { release = resolve; });
  f.hooks.rateLimit = ({ role }) => {
    if (role !== "late-limit") return false;
    attempts++;
    return attempts === 2 ? delayedResponse : true;
  };
  const limitRead = assert.rejects(f.run("late-limit", api => api.getBalance()));
  f.hooks.onPriority = row => {
    if (row.role === "entry") release(true);
  };
  const result = f.run("entry", api => entry(api)).then(
    () => assert.fail("stale entry must not reach transport"), error => error);
  const error = await f.drain(Promise.all([result, archive(f), backlog(f, 10), limitRead]))
    .then(rows => rows[0]);
  assert.equal(error.transportStage, "pre_transport");
  assert.equal(error.preSignReason, "final_pre_sign_pacing_expired");
  assert.equal(f.requests.some(row => row.method === "POST"), false);
  await assert.rejects(f.run("entry", api => entry(api)), /already submitted/);
  assertSharedBudget(f);
});

test("signals that expire during shared queueing and stale native quotes cannot submit an entry", async () => {
  for (const staleQuote of [false, true]) {
    const f = mixedLoadHarness({ staleQuote });
    const result = f.run("entry", api => entry(api, staleQuote ? {} : {
      signalAt: new Date(EPOCH - 590000).toISOString(),
    })).then(() => assert.fail("unsafe entry submitted"), error => error);
    const [error] = await f.drain(Promise.all([result, archive(f), backlog(f, 10)]));
    assert.equal(error.preSignReason,
      staleQuote ? "final_quote_unavailable_or_stale" : "signal_expired");
    assert.equal(f.requests.some(row => row.method === "POST"), false);
    assertSharedBudget(f);
  }
});

test("lost native entry, stop and close POST responses stay ambiguous and cannot be resubmitted under load", async () => {
  const f = mixedLoadHarness({ ambiguous: ["entry", "stop", "source-close"] });
  const outcomes = await f.drain(Promise.all([
    ...[
      ["entry", api => entry(api)], ["stop", raiseStop], ["source-close", close],
    ].map(([role, operation]) =>
      f.run(role, operation).then(() => assert.fail("lost response succeeded"), error => error)),
    archive(f), backlog(f),
  ]));
  for (const error of outcomes.slice(0, 3)) {
    assert.equal(error.transportStage, "network_request");
  }
  const before = f.requests.length;
  await assert.rejects(f.run("entry", api => entry(api)), /already submitted/);
  await assert.rejects(f.run("stop", raiseStop), /already submitted/);
  await assert.rejects(f.run("source-close", close), /already submitted/);
  assert.equal(f.requests.length, before, "no retry reads or writes for ambiguous operations");
  assert.equal(f.requests.filter(row => row.method === "POST").length, 3);
  assert.equal(f.positions.find(row => row.symbol === "ETH-USDT").positionAmt, "0");
  assert.equal(f.orders.filter(row => row.orderId === "300").length, 1);
  assert.equal(f.orders.find(row => row.orderId === "200").status, "NEW",
    "unknown replacement must never cancel original protection");
  assertSharedBudget(f);
});

test("real worker and broker persist an ambiguous entry and reconcile read-only after client restart under competing load", async () => {
  const f = mixedLoadHarness({ ambiguous: ["worker"] });
  const store = mixedLedger();
  const makeWorker = () => createVstWorker({
    store, clock: f.clock,
    sizingLimits: { environment: "vst", maxQuoteAgeMs: 10000, maxSlippageBps: 20 },
    broker: createVstBroker({
      api: f.api("worker"), accountId: "local-mixed-account",
      canarySymbols: ["DOGEUSDT"], clock: f.clock, stopBufferRate: 0.01,
    }),
  });
  const worker = makeWorker();
  const [prepared] = await f.drain(Promise.all([
    f.run("worker", () => worker.runOnce()), archive(f), backlog(f, 30),
  ]));
  assert.equal(prepared.kind, "prepared", JSON.stringify(prepared));
  const [result] = await f.drain(Promise.all([
    f.run("worker", () => worker.runOnce()), archive(f), backlog(f, 30),
  ]));
  const intent = store.intents.find(row => row.request.operation === "entry");
  assert.ok(intent, JSON.stringify({ result, signal: store.candidate, intents: store.intents }));
  assert.equal(intent.state, "unknown", JSON.stringify(result));
  assert.equal(f.requests.filter(row => row.method === "POST" && row.path === ORDER).length, 1);
  const before = f.requests.length;
  // Drop ALL adapter/broker in-memory duplicate-ID sets. Only the persisted
  // worker intent may prevent another POST across this restart.
  f.restartClient("worker");
  const restarted = makeWorker();
  await f.drain(Promise.all([
    f.run("worker", () => restarted.runOnce()), archive(f), backlog(f, 10),
  ]));
  assert.ok(f.requests.slice(before).some(row => row.role === "worker" && row.method === "GET"),
    "restart performs native reconciliation rather than ignoring the intent");
  assert.equal(f.requests.filter(row => row.method === "POST" && row.path === ORDER).length, 1);
  assert.equal(store.intents.filter(row => row.request.operation === "entry").length, 1);
  assert.equal(intent.state, "unknown");
  assertSharedBudget(f);
});
