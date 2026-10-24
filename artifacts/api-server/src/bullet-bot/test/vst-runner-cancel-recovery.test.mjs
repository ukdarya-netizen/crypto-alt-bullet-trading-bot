import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createVstWorker } from "../vst-worker.mjs";

const NOW = Date.parse("2026-10-02T00:00:00.000Z");
const SOURCE_ID = "runner-cancel-recovery-signal";
const SYMBOL = "ETHUSDT";
const ACCOUNT = "runner-cancel-recovery-account";
const CHILD_ID = "runner-child-1";
const OLD_PHASE = `impulse-runner-cancel-original-${CHILD_ID}`;
const OLD_CLIENT_ID = `vst-${createHash("sha256")
  .update(`${SOURCE_ID}:${OLD_PHASE}`).digest("hex").slice(0, 30)}`;
const FEATURES = [
  "vst_only",
  "complete_order_lookup",
  "guarded_long10_leverage_preparation",
  "atomic_protected_market_entry",
  "verified_core_stop_state",
  "verified_exact_full_position_close",
  "verified_position_state",
];

function fixture({
  mutateOrders, secondAttempt = false, secondError = null, secondOutcome = null,
} = {}) {
  const snapshot = {
    sourceSignalId: SOURCE_ID,
    symbol: SYMBOL,
    status: "closing",
    environment: "vst",
    accountId: ACCOUNT,
    patternId: "impulse_buy",
    exchangePositionId: "position-1",
    stopPrice: 95,
    remainingQty: 0.08,
    coreQty: 0.08,
    runnerQty: 0,
    originalStopOrderId: "original-stop",
    split: {
      stage: "runner_cleanup_pending",
      positionId: "position-1",
      entryOrderId: "entry-order",
      totalQuantity: "0.1",
      coreQuantity: "0.08",
      runnerQuantity: "0.02",
      originalStopOrderId: "original-stop",
      signalStopPrice: "95",
      runnerCleanup: {
        stage: "cancel_original_pending",
        parentStopId: "runner-stop",
        childOrderId: CHILD_ID,
        originalStopOrderId: "original-stop",
        coreStopOrderId: "core-stop",
        remainingQuantity: "0.08",
        runnerQuantity: "0.02",
        fill: { at: new Date(NOW - 60_000).toISOString() },
        coreStop: { orderId: "core-stop", quantity: "0.08", stopPrice: "95" },
      },
    },
  };
  const firstRecoveryPhase = `impulse-runner-cancel-recovery-${CHILD_ID}`;
  if (secondAttempt) {
    snapshot.split.runnerCleanup.recoveryPhase = firstRecoveryPhase;
  }
  const phase = secondAttempt ? firstRecoveryPhase : OLD_PHASE;
  const clientId = secondAttempt
    ? `vst-${createHash("sha256").update(`${SOURCE_ID}:${phase}`)
      .digest("hex").slice(0, 30)}`
    : OLD_CLIENT_ID;
  const intent = {
    sourceSignalId: SOURCE_ID,
    phase,
    clientOrderId: clientId,
    state: "unknown",
    outcome: secondAttempt ? {
      error: "BingXLiveApiError",
      errorMessage: secondError ??
        "VST runner fill history does not uniquely link to its exact parent stop",
    } : {
      submissionError: "BingXLiveApiError",
      submissionErrorMessage:
        "VST runner parent order is not an exact verified 20% BE stop fill",
    },
    request: {
      operation: "cancel_original_after_runner_fill",
      environment: "vst",
      accountId: ACCOUNT,
      sourceSignalId: SOURCE_ID,
      symbol: SYMBOL,
      positionId: "position-1",
      runnerChildOrderId: CHILD_ID,
      originalStopOrderId: "original-stop",
      coreStopOrderId: "core-stop",
      totalQuantity: "0.1",
      signalStopPrice: "95",
      priorPosition: snapshot,
    },
  };
  if (secondAttempt && secondOutcome) intent.outcome = secondOutcome;
  const openOrders = [
    {
      symbol: "ETH-USDT", orderId: "original-stop", mainOrderId: "entry-order",
      type: "STOP_MARKET", status: "NEW", side: "SELL", positionSide: "LONG",
      workingType: "MARK_PRICE", positionId: "position-1",
      origQty: "0.08", stopPrice: "95",
    },
    {
      symbol: "ETH-USDT", orderId: "core-stop", mainOrderId: "entry-order",
      type: "STOP_MARKET", status: "NEW", side: "SELL", positionSide: "LONG",
      workingType: "MARK_PRICE", positionId: "position-1",
      origQty: "0.08", stopPrice: "95",
    },
  ];
  mutateOrders?.(openOrders);
  const accountState = {
    verified: true,
    environment: "vst",
    accountId: ACCOUNT,
    positions: [{
      symbol: "ETH-USDT",
      positionSide: "LONG",
      positionAmt: "0.08",
      positionId: "position-1",
    }],
    openOrders,
  };
  const recoveryCalls = [];
  const reads = [];
  const store = {
    async withLeaderLock(callback) { return callback(); },
    async getPending() { return null; },
    async reserveIntent() { throw new Error("unexpected reservation"); },
    async getIntent() { return intent; },
    async listUnresolvedIntents() {
      return intent.state === "unknown" ? [intent] : [];
    },
    async listOpenPositions() {
      return [{ sourceSignalId: SOURCE_ID, symbol: SYMBOL, status: snapshot.status, snapshot }];
    },
    async recoverPreTransportRunnerCancel(args) {
      recoveryCalls.push({ ...args, expectedSnapshot: structuredClone(args.expectedSnapshot) });
      intent.state = "failed";
      Object.assign(snapshot, args.recoveryPosition);
      return { kind: "recovered" };
    },
  };
  const broker = {
    async getCapabilities() {
      return { environment: "vst", verified: true, accountId: ACCOUNT, features: FEATURES };
    },
    async readAccountState() {
      reads.push("account");
      return accountState;
    },
    async readPosition(symbol, options) {
      reads.push(["position", symbol, options]);
      return {
        verified: true,
        symbol,
        positionId: "position-1",
        quantity: 0.08,
        side: "Buy",
        leverage: 10,
        marginMode: "ISOLATED",
      };
    },
    async readMarketMark() { throw new Error("unexpected mark read"); },
    async reconcileIntent() { throw new Error("old intent must not be reconciled generically"); },
    async readPlanningInputs() { throw new Error("unexpected planning read"); },
    async performIntent() { throw new Error("recovery tick must not mutate"); },
  };
  return {
    worker: createVstWorker({ store, broker, clock: () => NOW }),
    recoveryCalls,
    reads,
    snapshot,
  };
}

test("recovers exact pre-DELETE runner cancel proof read-only and stops the tick", async () => {
  const { worker, recoveryCalls, reads, snapshot } = fixture();
  const result = await worker.runOnce();

  assert.deepEqual(result, {
    kind: "acted",
    operation: "recover_pretransport_runner_cancel",
  });
  assert.equal(recoveryCalls.length, 1);
  assert.equal(recoveryCalls[0].sourceSignalId, SOURCE_ID);
  assert.equal(recoveryCalls[0].clientOrderId, OLD_CLIENT_ID);
  assert.equal(recoveryCalls[0].expectedRequest.operation,
    "cancel_original_after_runner_fill");
  assert.equal(recoveryCalls[0].expectedSnapshot.split.runnerCleanup.recoveryPhase,
    undefined);
  assert.equal(recoveryCalls[0].recoveryPhase,
    `impulse-runner-cancel-recovery-${CHILD_ID}`);
  assert.equal(recoveryCalls[0].recoveryPosition.status, "closing");
  assert.equal(recoveryCalls[0].recoveryPosition.split.runnerCleanup.recoveryPhase,
    `impulse-runner-cancel-recovery-${CHILD_ID}`);
  assert.deepEqual(reads.map((item) => Array.isArray(item) ? item[0] : item),
    ["account", "position", "account"]);
});

test("does not recover when either verified residual stop differs", async () => {
  const { worker, recoveryCalls } = fixture({
    mutateOrders(orders) { orders[0].stopPrice = "94"; },
  });
  await worker.runOnce();
  assert.equal(recoveryCalls.length, 0);
});

test("second pre-DELETE refusal requires its exact error and a new deterministic phase", async () => {
  const { worker, recoveryCalls } = fixture({ secondAttempt: true });
  assert.deepEqual(await worker.runOnce(), {
    kind: "acted", operation: "recover_pretransport_runner_cancel",
  });
  assert.equal(recoveryCalls.length, 1);
  assert.equal(recoveryCalls[0].recoveryAttempt, 2);
  assert.equal(recoveryCalls[0].recoveryPhase,
    `impulse-runner-cancel-recovery-2-${CHILD_ID}`);
  assert.equal(recoveryCalls[0].expectedSnapshot.split.runnerCleanup.recoveryPhase,
    `impulse-runner-cancel-recovery-${CHILD_ID}`);
  assert.equal(recoveryCalls[0].recoveryPosition.split.runnerCleanup.recoveryPhase,
    `impulse-runner-cancel-recovery-2-${CHILD_ID}`);

  const persisted = fixture({
    secondAttempt: true,
    secondOutcome: {
      reason: "exchange_state_not_verified",
      submissionError: "BingXLiveApiError",
      submissionErrorMessage:
        "VST runner fill history does not uniquely link to its exact parent stop",
    },
  });
  assert.equal((await persisted.worker.runOnce()).operation,
    "recover_pretransport_runner_cancel");
  assert.equal(persisted.recoveryCalls.length, 1);

  const conflicting = fixture({
    secondAttempt: true,
    secondOutcome: {
      error: "BingXLiveApiError",
      errorMessage: "VST runner fill history does not uniquely link to its exact parent stop",
      submissionError: "BingXLiveApiError",
      submissionErrorMessage: "a conflicting transport result",
    },
  });
  await assert.rejects(conflicting.worker.runOnce());
  assert.equal(conflicting.recoveryCalls.length, 0);

  const bad = fixture({
    secondAttempt: true,
    secondError: "VST triggered-runner cancellation intent already used; reconcile, never retry",
  });
  await assert.rejects(bad.worker.runOnce());
  assert.equal(bad.recoveryCalls.length, 0);
});

test("second recovery is blocked when either residual stop no longer matches", async () => {
  const { worker, recoveryCalls } = fixture({
    secondAttempt: true,
    mutateOrders(orders) { orders[1].origQty = "0.07"; },
  });
  await worker.runOnce();
  assert.equal(recoveryCalls.length, 0);
});