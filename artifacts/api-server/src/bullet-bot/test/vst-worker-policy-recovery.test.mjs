import assert from "node:assert/strict";
import test from "node:test";
import { createVstPolicy, VST_POLICY_VERSION } from "../vst-policy.mjs";
import { restoreVersionlessImpulsePolicyState } from "../vst-worker.mjs";

const NOW = Date.parse("2026-10-02T00:00:00.000Z");
const SOURCE_ID = "source-zen-policy-recovery";
const SIGNAL = {
  sourceSignalId: SOURCE_ID,
  confirmationStatus: "confirmed",
  patternStatus: "approved",
  side: "buy",
  orderType: "market",
  patternId: "impulse_buy",
  symbol: "ZENUSDT",
  signalAt: new Date(NOW - 5_000).toISOString(),
  stopLoss: "95",
  payload: {
    rulesVersion: VST_POLICY_VERSION,
    exitRules: {
      priceMoveBasis: "unleveraged_percent_from_actual_entry_fill",
      noFixedTakeProfit: true,
      rMultipleTargets: false,
      firstTargetAction: "milestone_not_full_close",
      firstTargetPct: 10,
      breakevenAtPct: 5,
      breakevenStopGainPct: 0,
      breakevenIncludesFees: false,
      protectedProfitAtPct: 10,
      protectedProfitPct: 5,
      trailingActivationPct: 15,
      trailingGapPercentagePoints: 10,
      trailingGapBasis: "percentage_points_of_entry_pnl",
      trailingStopNeverDecreases: true,
      trailingExitAction: "close_remaining_position",
      maxWatchDays: 4,
      expiryExitPrice: "observed_market_quote",
      partialProfitAdvice: {
        execution: "advice_only_not_automated",
        minFraction: 0.2,
        maxFraction: 0.25,
      },
      runner: {
        policyVersion: "impulse_runner_v1",
        coreExit: "standard_trailing_stop",
        coreFraction: 0.8,
        runnerFraction: 0.2,
        afterCoreEmergencyStop: "original_entry_breakeven",
        trailingActivationPct: 30,
        trailingGapPercentagePoints: 30,
        trailingGapBasis: "percentage_points_of_entry_pnl",
        maxAgeHoursFromOriginalEntry: 120,
        expiryExitPrice: "observed_market_quote",
      },
    },
  },
};

function completedCoreOnlySnapshot() {
  const fill = {
    price: 100,
    quantity: 0.1,
    at: new Date(NOW - 1_000).toISOString(),
  };
  const initialPolicy = createVstPolicy({ signal: SIGNAL, fill });
  const lastCloseFill = {
    price: "100",
    quantity: "0.02",
    at: new Date(NOW - 500).toISOString(),
    exchangeOrderId: "runner-close-1",
  };
  const savedPolicy = {
    ...initialPolicy,
    status: "open",
    stopPrice: 95,
    peakPct: 22,
    coreQty: 0.08,
    coreOpen: true,
    runnerQty: 0,
    runnerOpen: false,
    runnerStopPrice: null,
    runnerPeakPct: 9,
    remainingQty: 0.08,
    observedAt: new Date(NOW + 1_000).toISOString(),
    lastCloseFill,
  };
  return {
    sourceSignalId: SOURCE_ID,
    symbol: SIGNAL.symbol,
    patternId: SIGNAL.patternId,
    signalAt: SIGNAL.signalAt,
    status: "open",
    executionStatus: "open",
    environment: "vst",
    accountId: "zen-vst-account",
    marginMode: "ISOLATED",
    leverage: 10,
    entryClientOrderId: "entry-client-1",
    entryOrderId: "entry-order-1",
    signalSnapshot: structuredClone(SIGNAL),
    exchangePositionId: "position-zen-1",
    verifiedFill: fill,
    quantity: 0.1,
    stopPrice: 95,
    signalStopPrice: "95",
    actualEntryBreakEvenPrice: "100",
    baselineOpenOrderIds: ["core-stop-1"],
    coreStopOrderId: "core-stop-1",
    coreStopPositionId: "position-zen-1",
    coreStopQuantity: 0.08,
    coreStopPrice: 95,
    runnerStopOrderId: null,
    runnerStopPositionId: null,
    runnerStopQuantity: 0,
    runnerStopPrice: null,
    peakPct: 30,
    runnerPeakPct: 11,
    lastCloseFill: structuredClone(lastCloseFill),
    split: {
      stage: "complete",
      totalQuantity: "0.1",
      coreQuantity: "0.08",
      runnerQuantity: "0.02",
      quantityPrecision: 3,
      pricePrecision: 2,
      minQuantity: "0.001",
      signalStopPrice: "95",
      breakEvenPrice: "100",
      actualEntryBreakEvenPrice: "100",
      positionId: "position-zen-1",
      entryOrderId: "entry-order-1",
      originalStopOrderId: "attached-entry-stop",
      activeLegs: ["core"],
      baselineOpenOrderIds: ["core-stop-1"],
      createdAt: NOW - 500,
      coreStop: {
        orderId: "core-stop-1",
        positionId: "position-zen-1",
        quantity: "0.08",
        stopPrice: "95",
      },
      runnerStop: null,
    },
    policy: savedPolicy,
  };
}

test("recovers only validated entry policy and preserves a completed core-only lifecycle", () => {
  const snapshot = completedCoreOnlySnapshot();
  const result = restoreVersionlessImpulsePolicyState(snapshot, SOURCE_ID);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.snapshot.version, VST_POLICY_VERSION);
  assert.equal(result.snapshot.entryAt, snapshot.policy.entryAt);
  assert.equal(result.snapshot.entryPrice, snapshot.policy.entryPrice);
  assert.equal(result.snapshot.quantity, 0.1);
  assert.equal(result.snapshot.remainingQty, 0.08);
  assert.equal(result.snapshot.coreQty, 0.08);
  assert.equal(result.snapshot.coreOpen, true);
  assert.equal(result.snapshot.runnerQty, 0);
  assert.equal(result.snapshot.runnerOpen, false);
  assert.equal(result.snapshot.runnerStopPrice, null);
  assert.equal(result.snapshot.peakPct, 30);
  assert.equal(result.snapshot.runnerPeakPct, 11);
  assert.equal(result.snapshot.observedAt, snapshot.policy.observedAt);
  assert.deepEqual(result.snapshot.lastCloseFill, snapshot.lastCloseFill);
  assert.deepEqual(result.snapshot.split, snapshot.split);
  assert.equal(result.snapshot.status, "open");
  assert.equal(result.snapshot.executionStatus, "open");
  assert.equal(result.snapshot.entryClientOrderId, snapshot.entryClientOrderId);
});

test("last-close-fill comparison ignores serialized object key order", () => {
  const snapshot = completedCoreOnlySnapshot();
  snapshot.lastCloseFill = Object.fromEntries(
    Object.entries(snapshot.lastCloseFill).reverse(),
  );
  const result = restoreVersionlessImpulsePolicyState(snapshot, SOURCE_ID);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.snapshot.lastCloseFill, snapshot.lastCloseFill);
});

test("refuses unsupported, conflicting, or stale policy provenance without mutating the snapshot", () => {
  const cases = [
    ["saved policy version", (snapshot) => {
      snapshot.policy.version = "unsupported-policy";
    }],
    ["saved policy pattern", (snapshot) => {
      snapshot.policy.patternId = "balanced_grind";
    }],
    ["saved signal source", (snapshot) => {
      snapshot.signalSnapshot.sourceSignalId = "different-source";
    }],
    ["rules version", (snapshot) => {
      snapshot.signalSnapshot.payload.rulesVersion = "unsupported-rules";
    }],
    ["saved entry quantity", (snapshot) => {
      snapshot.policy.quantity = 0.2;
    }],
    ["split stop identity", (snapshot) => {
      snapshot.split.coreStop.orderId = "unrelated-stop";
    }],
  ];
  for (const [name, mutate] of cases) {
    const snapshot = completedCoreOnlySnapshot();
    mutate(snapshot);
    const before = structuredClone(snapshot);
    const result = restoreVersionlessImpulsePolicyState(snapshot, SOURCE_ID);
    assert.equal(result.ok, false, name);
    assert.equal(typeof result.reason, "string", name);
    assert.deepEqual(snapshot, before, name);
  }

  const validSnapshot = completedCoreOnlySnapshot();
  const wrongRecord = restoreVersionlessImpulsePolicyState(
    validSnapshot, "other-record-source",
  );
  assert.equal(wrongRecord.ok, false);
  assert.equal(wrongRecord.reason,
    "impulse_policy_snapshot_recovery_provenance_mismatch");
});