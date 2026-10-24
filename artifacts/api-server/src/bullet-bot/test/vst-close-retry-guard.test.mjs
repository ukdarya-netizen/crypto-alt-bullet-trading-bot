import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePreRunnerCloseRetry, preRunnerCloseIdentity } from "../vst-close-retry-guard.mjs";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const request = {
  operation: "close_pre_runner_split", sourceSignalId: "signal",
  environment: "vst", accountId: "test-account", symbol: "ETHUSDT",
  positionId: "123", totalQuantity: "2",
  originalStop: { orderId: "111", quantity: "2", stopPrice: "90" },
  coreStop: { orderId: "222", quantity: "1", stopPrice: "100" },
  closeReason: "runner_break_even_unavailable_at_or_below_entry",
};
const failed = (updatedAt = NOW, override = {}) => ({
  request: { ...request, intentCreatedAt: NOW, closeIntentId: "old-id" },
  state: "failed",
  outcome: { reason: "close_pre_runner_split_abandoned_confirmed_still_open" },
  updatedAt: new Date(updatedAt).toISOString(), ...override,
});

test("retry identity excludes phase bookkeeping but retains exact owned stops", () => {
  assert.equal(preRunnerCloseIdentity(request), preRunnerCloseIdentity({
    ...request, closeIntentId: "new", intentCreatedAt: NOW + 1, priorPosition: {},
  }));
  assert.notEqual(preRunnerCloseIdentity(request), preRunnerCloseIdentity({
    ...request, coreStop: { ...request.coreStop, orderId: "333" },
  }));
});

test("restarts respect durable five/fifteen minute backoff and stop after three failures", () => {
  assert.equal(evaluatePreRunnerCloseRetry(request, [], NOW).allowed, true);
  assert.equal(evaluatePreRunnerCloseRetry(request, [failed()], NOW + 299999).allowed, false);
  assert.equal(evaluatePreRunnerCloseRetry(request, [failed()], NOW + 300000).allowed, true);
  assert.equal(evaluatePreRunnerCloseRetry(request, [failed(), failed(NOW - 600000)], NOW + 300000).allowed, false);
  assert.equal(evaluatePreRunnerCloseRetry(request, [failed(), failed(NOW - 600000)], NOW + 900000).allowed, true);
  const result = evaluatePreRunnerCloseRetry(request, [failed(), failed(), failed()], NOW + 86400000);
  assert.equal(result.allowed, false);
  assert.equal(result.limitReached, true);
});

test("success resets the failure streak, changed identity does not inherit it, malformed time fails closed", () => {
  assert.equal(evaluatePreRunnerCloseRetry(request, [
    failed(NOW, { state: "reconciled" }), failed(), failed(), failed(),
  ], NOW).allowed, true);
  assert.equal(evaluatePreRunnerCloseRetry({ ...request, positionId: "456" },
    [failed(), failed(), failed()], NOW).allowed, true);
  assert.equal(evaluatePreRunnerCloseRetry(request, [failed(NOW, { updatedAt: "invalid" })], NOW).allowed, false);
});