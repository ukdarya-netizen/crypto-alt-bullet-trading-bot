import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertVstStateSafeToDisable,
  createConfiguredVstWorker,
  createServer,
  loadVstBroker,
  VST_SIZING_LIMITS,
  VST_ENTRY_BATCH_LIMITS,
} from "../server.mjs";
import { createIndependentWorkerTickScheduler } from "../worker-tick-scheduler.mjs";
import { createVstWorker } from "../vst-worker.mjs";

const sample = JSON.parse(
  await readFile(new URL("./fixtures/impulse-buy-sample.json", import.meta.url), "utf8"),
);

function sourceExitStore() {
  return {
    queueSourceExitRequests: async () => ({ queued: [], refreshed: [], rejected: [] }),
    listPendingSourceExitRequests: async () => [],
    finishSourceExitRequest: async () => {},
    hasPendingSourceExitRequest: async () => false,
  };
}

test("both VST entrypoints use the same validated fixed sizing limits", async () => {
  assert.deepEqual(VST_SIZING_LIMITS, {
    environment: "vst",
    maxQuoteAgeMs: 10_000,
    maxSlippageBps: 20,
  });
  assert.equal(Object.isFrozen(VST_SIZING_LIMITS), true);
  const options = createConfiguredVstWorker({
    store: sourceExitStore(),
    broker: {},
    workerFactory: (configuration) => configuration,
  });
  assert.equal(options.sizingLimits, VST_SIZING_LIMITS);
  assert.equal(options.sourceExitsEnabled, true);
  assert.equal(Object.isFrozen(VST_ENTRY_BATCH_LIMITS), true);
  assert.equal(options.entryBatchSize, 3);
  assert.equal(options.entryBatchBudgetMs, 30_000);

  const [standalone, apiRuntime] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../bot-runtime.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(standalone, /createConfiguredVstWorker\(\{ store, broker: loadVstBroker\(\) \}\)/);
  assert.match(apiRuntime,
    /const runtimeVstBroker = vstActive && process\.env\.NODE_ENV === "production"\s*\? loadVstBroker\(\{\s*fillArchiveStore: vstStore,/);
  // Native contract monitoring adds broker options; the worker must still
  // receive the same runtime broker, not construct a second exchange client.
  assert.match(apiRuntime,
    /vstWorker = vstActive && process\.env\.NODE_ENV === "production"\s*\?\s*createConfiguredVstWorker\(\{\s*store: vstStore,\s*broker: runtimeVstBroker,\s*onBlocked:/);
  assert.match(apiRuntime, /createVstFillArchiveScheduler\(\{\s*broker: runtimeVstBroker,\s*store: vstStore/);
  assert.match(standalone, /assertVstStateSafeToDisable\(pool, \{ mode \}\)/);
  assert.match(apiRuntime, /assertVstStateSafeToDisable\(pool, \{ mode \}\)/);
});

test("PAPER does not start a Telegram notifier; VST retains its notifier", async () => {
  const runtime = await readFile(new URL("../bot-runtime.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(runtime, /createPaperTelegramNotifier|paperNotificationTimer|paperAlertsEnabled/);
  assert.match(runtime, /if \(vstAlertsEnabled\) \{\s*const notifier = createVstTelegramNotifier/);
});

test("createConfiguredVstWorker forwards blocked-alert and timing callbacks to the worker factory", async () => {
  const passthrough = createConfiguredVstWorker({
    store: sourceExitStore(),
    broker: {},
    workerFactory: (configuration) => configuration,
  });
  assert.equal(passthrough.onBlocked, undefined);
  assert.equal(passthrough.onTiming, undefined);

  const onBlocked = async () => {};
  const onTiming = async () => {};
  const withCallback = createConfiguredVstWorker({
    store: sourceExitStore(),
    broker: {},
    onBlocked,
    onTiming,
    workerFactory: (configuration) => configuration,
  });
  assert.equal(withCallback.onBlocked, onBlocked);
  assert.equal(withCallback.onTiming, onTiming);
});

test("configured VST worker refuses a store without durable source-exit queue APIs", () => {
  assert.throws(
    () => createConfiguredVstWorker({
      store: {},
      broker: {},
      workerFactory: (configuration) => configuration,
    }),
    /VST source exit queue store contract is unavailable/,
  );
});

function ledgerPool({ tables = true, activePositions = 0, unresolvedIntents = 0, activeSignals = 0 } = {}) {
  return {
    async query(sql) {
      if (sql.includes("information_schema.tables")) {
        return { rows: tables ? [
          "vst_signals", "vst_positions", "vst_order_intents", "vst_events",
        ].map((table_name) => ({ table_name })) : [] };
      }
      return { rows: [{ active_positions: activePositions, unresolved_intents: unresolvedIntents, active_signals: activeSignals }] };
    },
  };
}

test("VST shutdown guard allows legacy PAPER schema and safely paused pending work", async () => {
  await assertVstStateSafeToDisable(ledgerPool({ tables: false }), { mode: "paper" });
  await assertVstStateSafeToDisable(ledgerPool({ activeSignals: 1 }), {
    mode: "vst", paused: true,
  });
  await assertVstStateSafeToDisable(ledgerPool(), { mode: "paper" });
});

test("VST shutdown guard blocks PAPER switch for active or unresolved ledger state", async () => {
  for (const state of [
    { activePositions: 1 },
    { unresolvedIntents: 1 },
    { activeSignals: 1 },
  ]) {
    await assert.rejects(
      assertVstStateSafeToDisable(ledgerPool(state), { mode: "paper" }),
      /Cannot switch to PAPER while VST state requires supervision/,
    );
  }
  await assert.rejects(
    assertVstStateSafeToDisable(ledgerPool({ activePositions: 1 }), {
      mode: "vst", paused: true,
    }),
    /Cannot pause VST/,
  );
  await assert.rejects(
    assertVstStateSafeToDisable(ledgerPool({ unresolvedIntents: 1 }), {
      mode: "vst", paused: true,
    }),
    /Cannot pause VST/,
  );
});

test("VST shutdown guard fails closed on partial schema but leaves unpaused VST alone", async () => {
  const partialSchema = {
    async query() { return { rows: [{ table_name: "vst_signals" }] }; },
  };
  await assert.rejects(
    assertVstStateSafeToDisable(partialSchema, { mode: "paper" }),
    /incomplete VST schema/,
  );
  let reads = 0;
  await assertVstStateSafeToDisable({
    async query() { reads++; throw new Error("must not inspect an unpaused VST worker"); },
  }, { mode: "vst", paused: false });
  assert.equal(reads, 0);
});

function brokerContract() {
  return {
    async getCapabilities() {
      return {
        environment: "vst",
        verified: true,
        accountId: "stable-vst-alias",
        features: [],
      };
    },
    async readPlanningInputs() {},
    async readAccountState() {},
    async readMarketMark() {},
    async performIntent() {},
    async reconcileIntent() {},
    async readPosition() {},
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("independent VST and PAPER loops progress around stalls without overlapping themselves", async () => {
  const intervals = [];
  const cleared = [];
  const vstCalls = { count: 0, active: 0, maxActive: 0 };
  const paperCalls = { count: 0, active: 0, maxActive: 0 };
  const watchdogCalls = { begin: 0, check: 0, complete: 0 };
  let vstGate = deferred();
  let paperGate = null;
  const scheduler = createIndependentWorkerTickScheduler({
    async runVst() {
      vstCalls.count += 1;
      vstCalls.active += 1;
      vstCalls.maxActive = Math.max(vstCalls.maxActive, vstCalls.active);
      try {
        await vstGate.promise;
      } finally {
        vstCalls.active -= 1;
      }
    },
    async runPaper() {
      paperCalls.count += 1;
      paperCalls.active += 1;
      paperCalls.maxActive = Math.max(paperCalls.maxActive, paperCalls.active);
      try {
        if (paperGate) await paperGate.promise;
      } finally {
        paperCalls.active -= 1;
      }
    },
    vstTickWatchdog: {
      begin() { watchdogCalls.begin += 1; },
      check() { watchdogCalls.check += 1; },
      complete() { watchdogCalls.complete += 1; },
    },
    setIntervalFn(callback, delay) {
      const interval = { callback, delay, unrefCalled: false };
      interval.unref = () => { interval.unrefCalled = true; };
      intervals.push(interval);
      return interval;
    },
    clearIntervalFn(interval) { cleared.push(interval); },
  });

  assert.equal(intervals.length, 2);
  assert.deepEqual(intervals.map(({ delay }) => delay), [300, 300]);
  assert.ok(intervals.every(({ unrefCalled }) => unrefCalled));
  const [runVst, runPaper] = intervals.map(({ callback }) => callback);

  // VST is stalled; PAPER can run multiple times, while a second VST timer
  // firing is skipped instead of overlapping the active VST tick.
  const blockedVst = runVst();
  await Promise.resolve();
  await runPaper();
  await runPaper();
  await runVst();
  assert.equal(vstCalls.count, 1);
  assert.equal(paperCalls.count, 2);
  assert.equal(watchdogCalls.check, 1);
  vstGate.resolve();
  await blockedVst;

  // PAPER is now stalled; VST still makes progress, and the second PAPER
  // timer firing cannot start another PAPER tick until its first tick ends.
  paperGate = deferred();
  const blockedPaper = runPaper();
  await Promise.resolve();
  const secondVst = runVst();
  await Promise.resolve();
  await runPaper();
  assert.equal(vstCalls.count, 2);
  assert.equal(paperCalls.count, 3);
  paperGate.resolve();
  await blockedPaper;
  await secondVst;

  assert.equal(vstCalls.maxActive, 1);
  assert.equal(paperCalls.maxActive, 1);
  assert.deepEqual(watchdogCalls, { begin: 2, check: 1, complete: 2 });
  scheduler();
  scheduler();
  assert.deepEqual(cleared, intervals);
});

test("independent worker loops report their own errors and keep the other loop alive", async () => {
  const intervals = [];
  const vstErrors = [];
  const paperErrors = [];
  const watchdogCalls = [];
  const scheduler = createIndependentWorkerTickScheduler({
    async runVst() { throw new Error("VST test failure"); },
    async runPaper() { throw new Error("PAPER test failure"); },
    vstTickWatchdog: {
      begin() { watchdogCalls.push("begin"); },
      check() { watchdogCalls.push("check"); },
      complete() { watchdogCalls.push("complete"); },
      reportError(error) { watchdogCalls.push(`error:${error.message}`); },
    },
    onVstError(error) { vstErrors.push(error.message); },
    onPaperError(error) { paperErrors.push(error.message); },
    setIntervalFn(callback) {
      const interval = { callback };
      intervals.push(interval);
      return interval;
    },
    clearIntervalFn() {},
  });

  await intervals[0].callback();
  await intervals[1].callback();
  assert.deepEqual(vstErrors, ["VST test failure"]);
  assert.deepEqual(paperErrors, ["PAPER test failure"]);
  assert.deepEqual(watchdogCalls, [
    "begin", "error:VST test failure", "complete",
  ]);
  scheduler();
});

test("VST runtime wires the VST API into the bridge with stable explicit settings", () => {
  let apiOptions;
  let bridgeOptions;
  let capabilityCalls = 0;
  const api = { marker: "test-api" };
  const fillArchiveStore = { marker: "archive-store" };
  const broker = brokerContract();
  const getCapabilities = broker.getCapabilities;
  broker.getCapabilities = async () => {
    capabilityCalls += 1;
    return getCapabilities();
  };

  const configured = loadVstBroker({
    configuration: {
      BULLET_VST_ACCOUNT_ALIAS: "stable-vst-alias",
      BULLET_VST_CANARY_SYMBOLS: "BTCUSDT,ETHUSDT",
      BULLET_VST_STOP_BUFFER_RATE: "0.005",
    },
    apiFactory(options) {
      apiOptions = options;
      return api;
    },
    fillArchiveStore,
    brokerFactory(options) {
      bridgeOptions = options;
      return broker;
    },
  });

  assert.equal(configured, broker);
  assert.equal(apiOptions.environment, "vst");
  assert.equal(typeof apiOptions.writePermission, "function");
  assert.equal(apiOptions.writePermission({
    method: "POST", path: "/openApi/swap/v2/trade/order",
  }), true);
  assert.equal(apiOptions.writePermission({
    method: "POST", path: "/openApi/swap/v2/trade/positionMargin",
  }), true);
  assert.equal(apiOptions.writePermission({
    method: "POST", path: "/openApi/swap/v2/trade/unknown",
  }), false);
  assert.equal(apiOptions.writePermission({
    method: "GET", path: "/openApi/swap/v2/trade/order",
  }), false);
  assert.equal(bridgeOptions.api, api);
  assert.equal(bridgeOptions.accountId, "stable-vst-alias");
  assert.deepEqual(bridgeOptions.canarySymbols, ["BTCUSDT", "ETHUSDT"]);
  assert.equal(Object.hasOwn(bridgeOptions, "symbols"), false);
  assert.equal(bridgeOptions.stopBufferRate, 0.005);
  assert.equal(bridgeOptions.fillArchiveStore, fillArchiveStore);
  assert.equal(capabilityCalls, 0);
});

test("VST wiring uses an explicit BTC default and fails invalid safety configuration", () => {
  const api = Object.fromEntries([
    "getVstMarkPrice", "placeVstAutomatedLong", "upgradeVstLongStop", "closeLong",
    "getBalance", "getPositions", "getOpenOrders", "getPositionMode", "getMarginType",
    "getLeverage", "contract", "getRiskTiers", "getFeeRate", "getFunding", "queryOrder",
    "queryOrderHistory", "queryFills", "discoverVstAutomatedLongStop",
    "setVstLongLeverage10",
  ].map((name) => [name, async () => {}]));
  const broker = loadVstBroker({
    configuration: {
      BULLET_VST_ACCOUNT_ALIAS: "stable-vst-alias",
      BULLET_VST_STOP_BUFFER_RATE: "0.01",
    },
    apiFactory: () => api,
  });
  assert.equal(typeof broker.getCapabilities, "function");
  assert.throws(
    () => loadVstBroker({
      configuration: {
        BULLET_VST_ACCOUNT_ALIAS: "stable-vst-alias",
        BULLET_VST_STOP_BUFFER_RATE: "1",
      },
      apiFactory: () => ({}),
    }),
    /BULLET_VST_STOP_BUFFER_RATE/,
  );
});

test("ledger expiration runs before unavailable capabilities without retiring a fresh signal", async () => {
  const clock = Date.parse(sample.signalAt) + 30_000;
  const signal = {
    ...sample,
    sourceSignalId: "cab-signal-881001",
    signalAt: new Date(clock - 1_000).toISOString(),
  };
  let queued = null;
  let status = "pending";
  const statusChanges = [];
  const tickSteps = [];
  const store = {
    async enqueue(value) {
      queued = value;
      return { kind: "new", status };
    },
    async withLeaderLock(callback) { return callback(); },
    async retireExpiredUnstartedSignals(options) {
      assert.equal(options.maxAgeMs, 10 * 60_000);
      tickSteps.push("expiration");
      return 0;
    },
    async reserveIntent() {
      throw new Error("capability waiting must not reserve an order intent");
    },
    async listUnresolvedIntents() { return []; },
    async getIntent() { return null; },
    async getPending() {
      return queued ? { sourceSignalId: queued.sourceSignalId, body: queued, status } : null;
    },
    async setSignalStatus(_id, nextStatus) {
      status = nextStatus;
      statusChanges.push(nextStatus);
    },
    async recordEvent() {},
    async listOpenPositions() { return []; },
  };
  let paperEnqueues = 0;
  const paperStore = {
    async enqueue() {
      paperEnqueues += 1;
      return { kind: "new", status: "pending" };
    },
  };
  const broker = loadVstBroker({
    configuration: {
      BULLET_VST_ACCOUNT_ALIAS: "stable-vst-alias",
      BULLET_VST_STOP_BUFFER_RATE: "0.005",
    },
    apiFactory: () => ({}),
    brokerFactory: () => brokerContract(),
  });
  let capabilityReads = 0;
  const getCapabilities = broker.getCapabilities;
  broker.getCapabilities = async () => {
    tickSteps.push("capabilities");
    capabilityReads += 1;
    return getCapabilities();
  };
  const server = createServer({
    store,
    paperStore,
    token: "test-token",
    mode: "vst",
    clock: () => clock,
    vstEnabledAt: clock - 2_000,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/trading/signals`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-trading-token": "test-token" },
        body: JSON.stringify(signal),
      },
    );
    assert.equal(response.status, 202);
    assert.equal(queued.sourceSignalId, signal.sourceSignalId);
    assert.equal(status, "pending");
    assert.equal(paperEnqueues, 0);

    const result = await createVstWorker({
      store,
      broker,
      sizingLimits: { environment: "vst" },
    }).runOnce();
    if (process.env.BULLET_VST_PAUSED === "1") {
      assert.equal(result.kind, "paused");
      assert.equal(capabilityReads, 0);
    } else {
      assert.equal(result.kind, "waiting");
      assert.match(result.reason, /unsupported_vst_protective_capabilities/);
      assert.equal(capabilityReads, 1);
      assert.deepEqual(tickSteps, ["expiration", "capabilities"]);
    }
    assert.equal(status, "pending");
    assert.deepEqual(statusChanges, []);
    assert.equal((await store.getPending()).sourceSignalId, signal.sourceSignalId);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});