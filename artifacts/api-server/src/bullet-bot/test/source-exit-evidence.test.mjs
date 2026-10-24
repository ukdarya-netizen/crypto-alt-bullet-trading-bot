import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSourceExitEvidence } from "../source-exit-evidence.mjs";

const sourceSignalId = "cab-signal-10536";
const symbol = "WAXPUSDT";
const signalAt = "2026-09-25T00:35:48.399Z";
const entryAt = "2026-09-25T00:36:38.399Z";
const asOf = "2026-10-01T12:00:00.000Z";
const observedAt = "2026-10-01T12:00:01.000Z";

function providerPosition(overrides = {}) {
  return {
    sourceSignalId,
    signalAt,
    botEnqueuedAt: "2026-09-25T00:35:49.000Z",
    symbol,
    initialStopPrice: "0.00555",
    sourceStatus: "reclassified",
    sourceUpdatedAt: "2026-10-01T11:59:59.000Z",
    sourceClosedAt: null,
    sourceEntryPrice: "0.006035",
    sourceExitPrice: null,
    sourcePnlPercent: null,
    sourcePeakPrice: null,
    sourceStopLossPrice: null,
    sourceTrailingStopLevel: null,
    sourceLastMilestone: null,
    sourceCancelReason: "lc_no_lower_ob_moved_to_wait",
    ...overrides,
  };
}

function build(source, options = {}) {
  return buildSourceExitEvidence(source, {
    sourceSignalId,
    symbol,
    entryAt,
    signalAt,
    asOf,
    observedAt,
    ...options,
  });
}

test("provider-shaped reclassifications authorize withdrawal without claiming a source fill", () => {
  const providerCases = [
    { sourceCancelReason: "lc_no_lower_ob_moved_to_wait" },
    { sourceCancelReason: "lc_no_lower_ob_moved_to_wait", sourcePnlPercent: "0" },
    { sourceCancelReason: "lc_no_lower_ob_moved_to_wait", sourcePeakPrice: "0.0061" },
    { sourceCancelReason: "lc_no_lower_ob_moved_to_wait", sourceEntryPrice: null },
  ];
  for (const overrides of providerCases) {
    const evidence = build(providerPosition(overrides));
    assert.deepEqual(evidence, {
      sourceSignalId,
      symbol,
      reason: "source_withdrawal",
      sourceStatus: "reclassified",
      sourceUpdatedAt: "2026-10-01T11:59:59.000Z",
      sourceClosedAt: null,
      sourceExitPrice: null,
      sourceCancelReason: "lc_no_lower_ob_moved_to_wait",
      exitDecisionAt: "2026-10-01T11:59:59.000Z",
      asOf,
      observedAt,
    });
    assert.equal(Object.isFrozen(evidence), true);
  }
});

test("explicit terminal closures retain source proof while authorizing a local exit", () => {
  for (const sourceStatus of [
    "cancelled",
    "profit",
    "stop_loss",
    "bu_stop",
    "expired",
  ]) {
    const evidence = build(providerPosition({
      sourceStatus,
      sourceUpdatedAt: null,
      sourceClosedAt: "2026-10-01T11:59:58.000Z",
      sourceExitPrice: "0.005",
    }));
    assert.equal(evidence.reason, "source_closed");
    assert.equal(evidence.sourceStatus, sourceStatus);
    assert.equal(evidence.exitDecisionAt, "2026-10-01T11:59:58.000Z");
    assert.equal(evidence.sourceClosedAt, evidence.exitDecisionAt);
    assert.equal(evidence.sourceExitPrice, "0.005");
  }
});

test("reclassification takes withdrawal precedence even when closure proof is present", () => {
  const evidence = build(providerPosition({
    sourceClosedAt: "2026-10-01T11:59:58.000Z",
    sourceExitPrice: "0.005",
  }));
  assert.equal(evidence.reason, "source_withdrawal");
  assert.equal(evidence.exitDecisionAt, "2026-10-01T11:59:59.000Z");
  assert.equal(evidence.sourceClosedAt, "2026-10-01T11:59:58.000Z");
  assert.equal(evidence.sourceExitPrice, "0.005");
});

test("missing, mismatched, incomplete, stale, and chronologically invalid evidence is rejected", () => {
  const invalidSources = [
    null,
    providerPosition({ sourceSignalId: "different-signal" }),
    providerPosition({ symbol: "OTHERUSDT" }),
    providerPosition({ sourceStatus: "active" }),
    providerPosition({ sourceStatus: "in_run" }),
    providerPosition({ sourceUpdatedAt: null }),
    providerPosition({ sourceUpdatedAt: "not-a-time" }),
    providerPosition({ sourceUpdatedAt: "2026-09-25T00:36:37.000Z" }),
    providerPosition({ sourceClosedAt: "not-a-time" }),
    providerPosition({ sourceCancelReason: 4 }),
    providerPosition({
      sourceStatus: "cancelled",
      sourceUpdatedAt: null,
      sourceClosedAt: null,
      sourceExitPrice: "0.005",
    }),
    providerPosition({
      sourceStatus: "cancelled",
      sourceUpdatedAt: null,
      sourceClosedAt: "2026-10-01T11:59:58.000Z",
      sourceExitPrice: null,
    }),
    providerPosition({
      sourceStatus: "cancelled",
      sourceUpdatedAt: null,
      sourceClosedAt: "2026-10-01T11:59:58.000Z",
      sourceExitPrice: "0",
    }),
  ];
  for (const source of invalidSources) assert.equal(build(source), null);

  assert.equal(build(providerPosition(), { asOf: undefined }), null);
  assert.equal(build(providerPosition(), { asOf: "not-a-time" }), null);
  assert.equal(
    build(providerPosition(), { asOf: "2026-10-01T11:58:59.999Z" }),
    null,
    "snapshot older than 60 seconds is rejected",
  );
  assert.equal(
    build(providerPosition(), { asOf: "2026-10-01T12:00:31.001Z" }),
    null,
    "snapshot more than 30 seconds in the future is rejected",
  );
  assert.equal(
    build(providerPosition(), { observedAt: "not-a-time" }),
    null,
  );
  assert.equal(
    build(providerPosition(), { entryAt: "not-a-time" }),
    null,
  );
  assert.equal(
    build(providerPosition(), {
      entryAt: "2026-10-01T12:00:00.001Z",
    }),
    null,
    "decision must not precede entry",
  );
  assert.equal(
    build(providerPosition(), {
      signalAt: "not-a-time",
    }),
    null,
    "every supplied chronology timestamp must be valid",
  );
  assert.equal(
    build(providerPosition(), {
      entryAt: null,
      signalAt: "2026-10-01T12:00:00.001Z",
    }),
    null,
    "signal timestamp is the fallback chronology bound",
  );
  assert.equal(
    build(providerPosition({ sourceUpdatedAt: "2026-10-01T12:00:32.000Z" })),
    null,
    "decision cannot be beyond asOf/current time tolerance",
  );
});