import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BINGX_REAL_TEST_MARGIN_MODE,
  BINGX_REAL_TEST_MARGIN_USDT,
  resolveFirstCandidate,
  type BingxRealTestSelection,
} from "./bingx-real-test-selection";

function armedState(): BingxRealTestSelection {
  return {
    state: "armed",
    marginMode: BINGX_REAL_TEST_MARGIN_MODE,
    testMarginUsdt: BINGX_REAL_TEST_MARGIN_USDT,
    armedAfterSequence: 40,
    firstCandidateSequence: null,
    firstCandidateSignalId: null,
    outcomeReason: null,
    armedAt: new Date("2026-01-01T00:00:00Z"),
    resolvedAt: null,
  };
}

test("first post-arm ineligible webhook permanently fails without selecting its successor", () => {
  const armed = armedState();
  const failed = resolveFirstCandidate(armed, 41, "first-signal", "PAPER_SIGNAL_OUTSIDE_WINDOW", new Date());
  assert.equal(failed.state, "failed");
  assert.equal(failed.firstCandidateSequence, 41);
  assert.equal(failed.firstCandidateSignalId, "first-signal");

  const later = resolveFirstCandidate(failed, 42, "later-eligible-signal", null, new Date());
  assert.strictEqual(later, failed);
  assert.equal(later.firstCandidateSignalId, "first-signal");
});

test("an eligible first webhook is claimed once and is idempotent across replay", () => {
  const armed = armedState();
  const claimed = resolveFirstCandidate(armed, 41, "first-signal", null, new Date());
  assert.equal(claimed.state, "claimed");
  assert.equal(claimed.firstCandidateSignalId, "first-signal");

  const replay = resolveFirstCandidate(claimed, 41, "first-signal", null, new Date());
  assert.strictEqual(replay, claimed);
  assert.strictEqual(
    resolveFirstCandidate(claimed, 42, "later-signal", null, new Date()),
    claimed,
  );
});

test("the persisted sequence boundary excludes pre-arm arrivals", () => {
  const armed = armedState();
  assert.strictEqual(
    resolveFirstCandidate(armed, 40, "pre-arm", null, new Date()),
    armed,
  );
  assert.equal(resolveFirstCandidate(armed, 41, "post-arm", null, new Date()).state, "claimed");
});

test("serialized concurrent arrivals and a reloaded terminal record cannot select a successor", async () => {
  // Model the PostgreSQL controls-row lock: each transaction gets one place in
  // the same queue, and state is copied as it would be after a process restart.
  let durableState = armedState();
  let tail = Promise.resolve();
  const intake = (sequence: number, signalId: string, reason: string | null) => {
    const transaction = tail.then(() => {
      durableState = resolveFirstCandidate(
        durableState, sequence, signalId, reason, new Date(),
      );
    });
    tail = transaction.then(() => undefined);
    return transaction;
  };

  await Promise.all([
    intake(41, "first-ineligible", "PAPER_SIGNAL_OUTSIDE_WINDOW"),
    intake(42, "later-eligible", null),
  ]);
  const afterRestart = { ...durableState };
  assert.equal(afterRestart.state, "failed");
  assert.equal(afterRestart.firstCandidateSignalId, "first-ineligible");
  assert.strictEqual(
    resolveFirstCandidate(afterRestart, 43, "replayed-later-signal", null, new Date()),
    afterRestart,
  );
});

test("arm metadata is fixed to isolated mode and 15 USDT total test margin", () => {
  const selection = armedState();
  assert.equal(selection.marginMode, "isolated");
  assert.equal(selection.testMarginUsdt, "15");
});
