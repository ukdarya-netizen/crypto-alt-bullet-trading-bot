import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildVstProofEvidence } from "../vst-proof-evidence.mjs";
import { recordVstDiagnostic, recordVstRefusal } from "../vst-diagnostics.mjs";
import { createVstWorker } from "../vst-worker.mjs";

const workerSource = await readFile(fileURLToPath(
  new URL("../vst-worker.mjs", import.meta.url),
), "utf8");

function check(expected, actual, matches = expected === actual) {
  return { expected, actual, matches };
}

test("split preflight proof records count, numeric ID, and quantity mismatches", () => {
  const proofEvidence = buildVstProofEvidence({
    source: "split_preflight",
    checks: {
      positionValid: check(true, false, false),
      stopFactsValid: check(true, false, false),
      openOrderIdsMatch: check(true, false, false),
      quantity: check("0.1", "0.08", false),
      openOrderCount: check("3", "2", false),
      currentOrderIds: check(["1001", "1002", "1003"], ["1001", "1004"], false),
      expectedOrderIds: check(["1001", "1002", "1003"], ["1001", "1004"], false),
    },
  });
  assert.equal(proofEvidence?.source, "split_preflight");
  const serialized = JSON.stringify(proofEvidence);
  for (const mismatch of ["openOrderCount", "currentOrderIds", "quantity"]) {
    assert.ok(serialized.includes(mismatch), `proof retains ${mismatch}`);
  }
  assert.match(serialized, /1002/);
  assert.match(serialized, /0\.08/);

  let diagnosticLine = "";
  const originalWrite = process.stderr.write;
  process.stderr.write = function (chunk, ...args) {
    diagnosticLine += String(chunk);
    return true;
  };
  try {
    recordVstRefusal("position_identity_mismatch", {
      stage: "positionManagement",
      operation: "read_position",
      check: "ownership",
      symbol: "ETHUSDT",
      proofEvidence,
    });
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.match(diagnosticLine, /Bullet VST diagnostic:/);
  assert.match(diagnosticLine, /split_preflight/);
  assert.match(diagnosticLine, /1002/);
});

test("worker keeps split proof out of state and records triggered read exceptions", () => {
  const splitStart = workerSource.indexOf("const proofEvidence = safeVstProofEvidence(\"split_preflight\"");
  const splitEnd = workerSource.indexOf("if (operation === \"split_runner_stop\")", splitStart);
  const splitPreflight = workerSource.slice(splitStart, splitEnd);
  assert.ok(splitStart >= 0 && splitEnd > splitStart);
  assert.match(splitPreflight, /recordVstRefusal\([\s\S]{0,500}proofEvidence/);
  assert.match(splitPreflight, /openOrderCount:/);
  assert.match(splitPreflight, /currentOrderIds:/);
  assert.match(splitPreflight, /positionQuantity:/);
  assert.match(splitPreflight, /attachVstResultDiagnostic/);
  assert.match(workerSource, /buildVstProofEvidence\(\{ source, checks: getChecks\(\) \}\)/);
  assert.match(workerSource,
    /catch \(error\) \{[\s\S]{0,1500}recordVstDiagnostic\(error, \{[\s\S]{0,500}\.\.\.\(proofEvidence \? \{ proofEvidence \} : \{\}\)/);
  assert.match(workerSource, /attachVstResultDiagnostic\(\s*\{ kind: "unknown", reason \}, diagnostic\)/);
  const historicalStart = workerSource.indexOf("async function reconcileOneHistoricalErrorClose");
  const historicalEnd = workerSource.indexOf("function sourceExitPhase", historicalStart);
  const historicalRepair = workerSource.slice(historicalStart, historicalEnd);
  assert.ok(historicalStart >= 0 && historicalEnd > historicalStart);
  assert.match(historicalRepair, /catch \(error\) \{[\s\S]{0,1000}recordVstDiagnostic\(error/);
  assert.equal((historicalRepair.match(/broker\.readHistoricalErrorClose\(candidate\)/g) ?? []).length, 1,
    "diagnostics do not add historical proof reads");

  const proofEvidence = buildVstProofEvidence({
    source: "triggered_stop_proof",
    checks: {
      positionValid: check(true, false, false),
      stopFactsValid: check(true, false, false),
      coreVerified: check(true, false, false),
      positionId: check("1001", "1002", false),
    },
  });
  let diagnosticLine = "";
  const originalWrite = process.stderr.write;
  process.stderr.write = function (chunk, ...args) {
    diagnosticLine += String(chunk);
    return true;
  };
  try {
    const thrown = new Error("private exchange response text");
    recordVstDiagnostic(thrown, {
      stage: "positionManagement",
      operation: "read_position",
      check: "protective_stop",
      symbol: "ETHUSDT",
      proofEvidence,
    });
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.match(diagnosticLine, /triggered_stop_proof/);
  assert.doesNotMatch(diagnosticLine, /private exchange response text/);
  assert.match(diagnosticLine, /positionId/);
});

test("every raise-stop execution route shares a verified strict-monotonicity gate before reservation", () => {
  const manageStart = workerSource.indexOf("async function managePosition(");
  const actionGuard = workerSource.indexOf(
    "const monotonicity = await verifyRaiseStopMonotonicity(state, action);",
    manageStart,
  );
  const equalNoop = workerSource.indexOf(
    'reason: "raise_stop_already_at_target"',
    actionGuard,
  );
  const soleRoute = workerSource.indexOf("return await raiseSoleCoreStop(", actionGuard);
  const splitRoute = workerSource.indexOf("return await placeSplitStopUpgrade(", actionGuard);
  const genericReserve = workerSource.indexOf(
    "const submitted = await reserveAndPerform(record.sourceSignalId, phase, request);",
    actionGuard,
  );
  assert.ok(manageStart >= 0 && actionGuard > manageStart);
  assert.ok(equalNoop > actionGuard);
  assert.ok(soleRoute > equalNoop && splitRoute > equalNoop);
  assert.ok(genericReserve > actionGuard);
  assert.match(workerSource.slice(actionGuard, genericReserve),
    /relation !== "higher"[\s\S]*raise_stop_target_not_higher_than_verified_stop/);
  assert.match(workerSource.slice(actionGuard, genericReserve),
    /status: "open"[\s\S]*kind: "observed"/);
  assert.match(workerSource,
    /compareExactDecimals\([\s\S]{0,120}action\.stopPriceText[\s\S]{0,120}order\.stopPrice/);
});

test("worker split preflight logs exact refusal evidence without placing an order", async () => {
  const sourceSignalId = "cab-signal-812347";
  const accountId = "private-test-account-id";
  const symbol = "ETHUSDT";
  const positionId = "1101";
  const entryOrderId = "1301";
  const originalStopOrderId = "1201";
  const state = {
    sourceSignalId,
    symbol,
    patternId: "impulse_buy",
    environment: "vst",
    accountId,
    status: "closing",
    exchangePositionId: positionId,
    quantity: "0.1",
    remainingQty: "0.1",
    split: {
      stage: "core_pending",
      positionId,
      entryOrderId,
      totalQuantity: "0.1",
      coreQuantity: "0.08",
      runnerQuantity: "0.02",
      quantityPrecision: 3,
      pricePrecision: 2,
      minQuantity: "0.001",
      originalStopOrderId,
      signalStopPrice: "95",
      breakEvenPrice: "100",
      baselineOpenOrderIds: [originalStopOrderId],
      createdAt: 1_800_000_000_000,
      coreStop: null,
      runnerStop: null,
    },
  };
  const record = { sourceSignalId, symbol, status: "closing", snapshot: state };
  const store = {
    async withLeaderLock(callback) { return callback(); },
    async getPending() { return null; },
    async reserveIntent() { throw new Error("split preflight must not reserve an intent"); },
    async getIntent() { return null; },
    async listUnresolvedIntents() { return []; },
    async listOpenPositions() { return [record]; },
    async setSignalStatus(_sourceSignalId, status, reason) {
      record.status = status;
      record.snapshot = { ...record.snapshot, status };
      record.reason = reason;
    },
    async upsertPosition(position) {
      record.status = position.status;
      record.snapshot = position;
    },
  };
  let accountReads = 0;
  let positionReads = 0;
  let mutationCalls = 0;
  const accountState = {
    verified: true,
    environment: "vst",
    accountId,
    positions: [{
      symbol: "ETH-USDT",
      positionSide: "LONG",
      positionAmt: "0.1",
      positionId,
    }],
    openOrders: [
      {
        symbol: "ETH-USDT", orderId: originalStopOrderId,
        mainOrderId: entryOrderId, type: "STOP_MARKET", status: "NEW",
        side: "SELL", positionSide: "LONG", workingType: "MARK_PRICE",
        positionId, origQty: "0.1", stopPrice: "95",
      },
      {
        symbol: "ETH-USDT", orderId: "1401", type: "LIMIT", status: "NEW",
        side: "SELL", positionSide: "LONG", positionId, origQty: "0.01",
      },
    ],
  };
  const broker = {
    async getCapabilities() {
      return {
        environment: "vst",
        verified: true,
        accountId,
        features: [
          "vst_only",
          "complete_order_lookup",
          "guarded_long10_leverage_preparation",
          "atomic_protected_market_entry",
          "verified_core_stop_state",
          "verified_exact_full_position_close",
          "verified_position_state",
          "impulse_runner_stop_and_partial_close",
        ],
      };
    },
    async readAccountState() {
      accountReads += 1;
      return structuredClone(accountState);
    },
    async readPosition() {
      positionReads += 1;
      return {
        verified: true,
        symbol,
        positionId,
        quantity: "0.1",
        side: "Buy",
        leverage: 10,
        marginMode: "ISOLATED",
      };
    },
    async readMarketMark() { throw new Error("preflight refusal must not read a mark"); },
    async reconcileIntent() { throw new Error("no unresolved intents are expected"); },
    async readPlanningInputs() { return {}; },
    async performIntent() {
      mutationCalls += 1;
      throw new Error("split preflight must not place or cancel an order");
    },
  };
  const worker = createVstWorker({
    store,
    broker,
    clock: () => 1_800_000_000_000,
    sizingLimits: { environment: "vst" },
  });

  let diagnosticLine = "";
  const originalWrite = process.stderr.write;
  process.stderr.write = function (chunk, ...args) {
    diagnosticLine += String(chunk);
    return true;
  };
  let result;
  try {
    result = await worker.runOnce();
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(result.kind, "unknown");
  assert.equal(result.reason, "impulse_split_preflight_state_mismatch");
  assert.equal(record.status, "unknown");
  assert.equal(record.reason, "impulse_split_preflight_state_mismatch");
  assert.equal(accountReads, 2);
  assert.equal(positionReads, 1);
  assert.equal(mutationCalls, 0);
  assert.equal((diagnosticLine.match(/Bullet VST diagnostic:/g) ?? []).length, 1);
  const logged = JSON.parse(diagnosticLine.slice(diagnosticLine.indexOf("{")));
  const proof = logged.proofEvidence;
  assert.equal(proof.source, "split_preflight");
  const checkByField = Object.fromEntries(proof.checks.map((check) => [check.field, check]));
  assert.equal(checkByField.positionValid.matches, true);
  assert.equal(checkByField.stopFactsValid.matches, true);
  assert.equal(checkByField.accountMatches.expected, true);
  assert.equal(checkByField.accountMatches.actual, true);
  assert.equal(checkByField.environmentMatches.expected, true);
  assert.equal(checkByField.environmentMatches.actual, true);
  assert.equal(checkByField.openOrderIdsMatch.matches, false);
  assert.equal(checkByField.openOrderCount.expected, "1");
  assert.equal(checkByField.openOrderCount.actual, "2");
  assert.deepEqual(checkByField.currentOrderIds.actual, ["1201", "1401"]);
  assert.ok(proof.failedChecks.includes("openOrderIdsMatch"));
  assert.ok(proof.failedChecks.includes("openOrderCount"));
  assert.ok(!proof.failedChecks.includes("corePositionId"));
  assert.ok(!proof.failedChecks.includes("runnerPositionId"));
  assert.doesNotMatch(diagnosticLine, new RegExp(accountId));
});