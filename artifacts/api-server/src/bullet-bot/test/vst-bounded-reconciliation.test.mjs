import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createVstWorker } from "../vst-worker.mjs";

const originalPauseSwitch = process.env.BULLET_VST_PAUSED;
process.env.BULLET_VST_PAUSED = "0";
after(() => {
  if (originalPauseSwitch === undefined) delete process.env.BULLET_VST_PAUSED;
  else process.env.BULLET_VST_PAUSED = originalPauseSwitch;
});

const NOW = Date.parse("2026-10-02T00:00:00.000Z");

function unresolvedIntent({
  id,
  operation = "margin_top_up",
  state = "unknown",
  symbol = "AAAUSDT",
} = {}) {
  return {
    sourceSignalId: `signal-${id}`,
    phase: operation === "margin_top_up" ? "margin-top-up" : operation,
    clientOrderId: id,
    state,
    request: {
      operation,
      environment: "vst",
      accountId: "vst-account",
      symbol,
      intentCreatedAt: NOW - 60_000,
    },
  };
}

function independentSignal(sourceSignalId = "independent-signal") {
  return {
    sourceSignalId,
    symbol: "BBBBUSDT",
    patternId: "balanced_grind",
    signalAt: new Date(NOW).toISOString(),
    confirmationStatus: "confirmed",
    patternStatus: "approved",
    side: "buy",
    orderType: "market",
    referencePrice: 100,
    stopLoss: 90,
    payload: { rulesVersion: "bullet-long-exits-v2" },
  };
}

function createFixture(intents, { prepareError = true } = {}) {
  const data = {
    intents,
    events: [],
    planningAttempts: [],
    signalStatuses: new Map(),
    accountReads: 0,
    mutations: [],
    reconciliationOrder: [],
    reverseOnRead: false,
  };
  const candidate = independentSignal();
  const store = {
    data,
    async withLeaderLock(callback) { return callback(); },
    async getPending() { return null; },
    async getIntent(sourceSignalId, phase) {
      return data.intents.find((intent) =>
        intent.sourceSignalId === sourceSignalId && intent.phase === phase) ?? null;
    },
    async listUnresolvedIntents() {
      const rows = data.intents.filter((intent) =>
        ["prepared", "submitted", "unknown"].includes(intent.state));
      return data.reverseOnRead ? rows.reverse() : rows;
    },
    async listOpenPositions() { return []; },
    async listPendingCandidatesPage({ after }) {
      return after
        ? { rows: [], nextCursor: null, hasMore: false }
        : {
            rows: [{
              sourceSignalId: candidate.sourceSignalId,
              body: candidate,
              status: "pending",
              receivedAt: new Date(NOW).toISOString(),
            }],
            nextCursor: {
              priority: 2,
              receivedAt: new Date(NOW).toISOString(),
              sourceSignalId: candidate.sourceSignalId,
            },
            hasMore: false,
          };
    },
    async setSignalStatus(sourceSignalId, status) {
      data.signalStatuses.set(sourceSignalId, status);
    },
    async recordEvent(...event) { data.events.push(event); },
    async markIntent(clientOrderId, state, detail = {}) {
      const intent = data.intents.find((row) => row.clientOrderId === clientOrderId);
      if (intent) {
        intent.state = state;
        intent.outcome = detail.outcome ?? {};
      }
    },
    async reserveIntent(intent) {
      data.intents.push({ ...intent, state: "prepared" });
      return { kind: "new", intent: data.intents.at(-1) };
    },
  };
  const broker = {
    async getCapabilities() {
      return {
        environment: "vst",
        verified: true,
        accountId: "vst-account",
        features: [
          "vst_only",
          "complete_order_lookup",
          "guarded_long10_leverage_preparation",
          "atomic_protected_market_entry",
          "verified_core_stop_state",
          "verified_exact_full_position_close",
          "verified_position_state",
        ],
      };
    },
    async reconcileIntent(intent) {
      data.reconciliationOrder.push(intent.clientOrderId);
      return { verified: true, status: "unknown" };
    },
    async readAccountState() {
      data.accountReads += 1;
      return { verified: true, positions: [], openOrders: [] };
    },
    async readMarketMark() {
      return {
        verified: true,
        symbol: candidate.symbol,
        price: 100,
        observedAt: new Date(NOW).toISOString(),
      };
    },
    async readPosition() { return null; },
    async readPlanningInputs(signal) {
      data.planningAttempts.push(signal.sourceSignalId);
      if (prepareError) throw new Error("test planning read failure");
      throw new Error("unexpected planning path");
    },
    async performIntent(intent) {
      data.mutations.push(intent.clientOrderId);
    },
  };
  return {
    data,
    store,
    worker: createVstWorker({
      store,
      broker,
      clock: () => NOW,
      sizingLimits: { environment: "vst" },
    }),
  };
}

test("bounded reconciliation rotates unknown margins and lets an independent signal progress", async () => {
  const { data, worker } = createFixture([
    unresolvedIntent({ id: "margin-c", symbol: "CCCUSDT" }),
    unresolvedIntent({ id: "urgent-stop", operation: "split_runner_stop", symbol: "AAAUSDT" }),
    unresolvedIntent({ id: "margin-a", symbol: "AAAUSDT" }),
    unresolvedIntent({ id: "margin-b", symbol: "BBB2USDT" }),
  ]);

  for (let tick = 0; tick < 3; tick += 1) {
    data.reverseOnRead = tick % 2 === 1;
    const result = await worker.runOnce();
    assert.equal(result.kind, "error");
    assert.equal(data.planningAttempts.at(-1), "independent-signal");
  }

  const expectedMarginIds = new Set(["margin-a", "margin-b", "margin-c"]);
  const reconciledMargins = data.reconciliationOrder.filter((id) =>
    expectedMarginIds.has(id));
  assert.equal(reconciledMargins.length, 3,
    "no tick should spend its bounded routine slot reconciling more than one margin");
  assert.equal(new Set(reconciledMargins).size, 3,
    "stable-ID round robin must visit every old unknown margin despite row reordering");
  assert.deepEqual(
    data.reconciliationOrder.filter((id) => id === "urgent-stop"),
    ["urgent-stop", "urgent-stop", "urgent-stop"],
    "the exposure-critical stop must be inspected before lower-priority adjustments",
  );
  assert.equal(data.mutations.length, 0, "unknown intents must never be re-POSTed");
});

test("bounded reconciliation checks two urgent stops in one tick", async () => {
  const { data, worker } = createFixture([
    unresolvedIntent({
      id: "urgent-stop-b",
      operation: "split_runner_stop",
      symbol: "BBB2USDT",
    }),
    unresolvedIntent({
      id: "urgent-stop-a",
      operation: "split_core_stop",
      symbol: "AAAUSDT",
    }),
    unresolvedIntent({ id: "routine-margin", symbol: "CCCUSDT" }),
  ]);

  await worker.runOnce();

  assert.deepEqual(
    data.reconciliationOrder.slice(0, 2),
    ["urgent-stop-a", "urgent-stop-b"],
    "both exposure-critical stops are inspected before lower-priority work",
  );
  assert.equal(data.reconciliationOrder.filter((id) => id === "routine-margin").length, 1,
    "routine reconciliation remains bounded after the urgent stop checks");
  assert.deepEqual(data.mutations, [], "unknown stop intents must never be re-POSTed");
});

test("a prepared margin POST is unique per tick, refreshes the account, and ends the tick", async () => {
  const prepared = unresolvedIntent({
    id: "prepared-margin",
    state: "prepared",
    symbol: "AAAUSDT",
  });
  const { data, worker } = createFixture([prepared]);
  const first = await worker.runOnce();
  assert.equal(first.kind, "unknown");
  assert.deepEqual(data.mutations, ["prepared-margin"]);
  assert.equal(data.accountReads, 1,
    "the account must be freshly read after the one allowed prepared margin POST");
  assert.deepEqual(data.planningAttempts, [],
    "no strategy work may use the post-mutation tick's account snapshot");

  const second = await worker.runOnce();
  assert.equal(second.kind, "error");
  assert.deepEqual(data.mutations, ["prepared-margin"],
    "a submitted/unknown follow-up must only be reconciled read-only on later ticks");
  assert.equal(data.planningAttempts.at(-1), "independent-signal");
});

test("an unknown ZEN stop cannot block a prepared top-up on an independent symbol", async () => {
  const { data, worker } = createFixture([
    unresolvedIntent({ id: "older-margin-a", symbol: "AAAUSDT" }),
    unresolvedIntent({
      id: "zen-urgent-stop",
      operation: "split_runner_stop",
      symbol: "ZENUSDT",
    }),
    unresolvedIntent({
      id: "prepared-pengu-top-up",
      state: "prepared",
      symbol: "PENGUUSDT",
    }),
    unresolvedIntent({ id: "older-margin-b", symbol: "AVAXUSDT" }),
    unresolvedIntent({ id: "older-margin-c", symbol: "REUSDT" }),
  ]);

  const first = await worker.runOnce();
  assert.equal(first.kind, "unknown");
  assert.deepEqual(data.reconciliationOrder, [
    "zen-urgent-stop",
    "older-margin-a",
    "prepared-pengu-top-up",
  ]);
  assert.deepEqual(data.mutations, ["prepared-pengu-top-up"],
    "the unrelated ZEN stop must not defer PENGU's one authorized top-up POST");
  assert.equal(data.accountReads, 1,
    "a prepared independent-symbol top-up must be followed by a fresh account read");
  assert.deepEqual(data.planningAttempts, [],
    "the mutation ends this tick before independent strategy work");

  const second = await worker.runOnce();
  assert.equal(second.kind, "error");
  assert.equal(data.mutations.length, 1,
    "the now-unknown PENGU intent must never repeat its POST");
  assert.equal(data.planningAttempts.at(-1), "independent-signal",
    "independent strategy work resumes on the next tick");
});

test("unknown margins get a rotating read every tick despite a stream of prepared top-ups", async () => {
  const { data, worker } = createFixture([
    unresolvedIntent({ id: "old-margin-c", symbol: "CCCUSDT" }),
    unresolvedIntent({ id: "old-margin-a", symbol: "AAAUSDT" }),
    unresolvedIntent({ id: "old-margin-b", symbol: "BBB2USDT" }),
  ]);
  const preparedIds = ["new-prepared-a", "new-prepared-b", "new-prepared-c"];

  for (let tick = 0; tick < preparedIds.length; tick += 1) {
    data.intents.push(unresolvedIntent({
      id: preparedIds[tick],
      state: "prepared",
      symbol: `NEW${tick}USDT`,
    }));
    const beforeWrites = data.mutations.length;
    const result = await worker.runOnce();
    assert.equal(result.kind, "unknown");
    assert.equal(data.mutations.length, beforeWrites + 1,
      "at most one prepared margin POST is attempted in a tick");
    assert.equal(data.accountReads, tick + 1,
      "every prepared POST is followed by a fresh account read");
    assert.deepEqual(data.planningAttempts, [],
      "strategy work does not run against a post-mutation account snapshot");
    assert.equal(data.intents.find((intent) =>
      intent.clientOrderId === preparedIds[tick]).state, "unknown");
  }

  const oldMarginsRead = data.reconciliationOrder.filter((id) =>
    id.startsWith("old-margin-"));
  assert.deepEqual(
    new Set(oldMarginsRead),
    new Set(["old-margin-a", "old-margin-b", "old-margin-c"]),
    "the stable-ID cursor gives every older ambiguous margin a read despite new prepared work",
  );
  assert.deepEqual(data.mutations, preparedIds,
    "each newly prepared top-up is attempted once and never replayed after it becomes unknown");

  await worker.runOnce();
  assert.deepEqual(data.mutations, preparedIds,
    "later read-only reconciliation does not repeat any previous POST");
  assert.equal(data.planningAttempts.at(-1), "independent-signal",
    "the independent candidate progresses when no new mutation is queued");
});

test("an unresolved urgent stop on the same symbol defers its prepared top-up", async () => {
  const { data, worker } = createFixture([
    unresolvedIntent({
      id: "same-symbol-stop",
      operation: "split_runner_stop",
      symbol: "PENGUUSDT",
    }),
    unresolvedIntent({
      id: "same-symbol-prepared-margin",
      state: "prepared",
      symbol: "PENGUUSDT",
    }),
    unresolvedIntent({ id: "independent-unknown-margin", symbol: "AVAXUSDT" }),
  ]);

  const result = await worker.runOnce();
  assert.equal(result.kind, "error");
  assert.deepEqual(data.reconciliationOrder, [
    "same-symbol-stop",
    "independent-unknown-margin",
  ]);
  assert.deepEqual(data.mutations, [],
    "same-symbol uncertain stop state must fail closed without submitting margin");
  assert.deepEqual(data.planningAttempts, ["independent-signal"],
    "the same-symbol hold must not block an unrelated signal");
});