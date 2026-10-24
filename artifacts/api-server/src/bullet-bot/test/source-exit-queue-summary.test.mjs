import assert from "node:assert/strict";
import test from "node:test";
import {
  isSourceExitOperationalFailure,
  summarizeSourceExitQueue,
} from "../source-exit-queue-summary.mjs";

test("source queue errors exclude normal skips and safety refusals", () => {
  const result = summarizeSourceExitQueue({
    queued: [{}], refreshed: [{}, {}],
    rejected: [
      { reason: "unknown_vst_signal", detail: "never log this" },
      { reason: "unknown_vst_signal" },
      { reason: "source_exit_evidence_conflict" },
      { reason: "source_exit_evidence_not_eligible" },
      { reason: "source_exit_queue_error", evidence: { private: "raw" } },
      { reason: "source_exit_evidence_error" },
    ],
  });
  assert.equal(result.queued, 1);
  assert.equal(result.refreshed, 2);
  assert.equal(result.rejected, 6);
  assert.equal(result.errors, 2);
  assert.equal(result.rejectedByReason.unknown_vst_signal, 2);
  assert.equal(result.rejectedByReason.source_exit_evidence_conflict, 1);
  assert.equal(isSourceExitOperationalFailure({ reason: "source_exit_queue_error" }), true);
  assert.equal(isSourceExitOperationalFailure({ reason: "source_exit_evidence_conflict" }), false);
  assert.doesNotMatch(JSON.stringify(result), /never log|private|raw|evidence":/);
});

test("source queue reason cardinality and unsafe input are bounded", () => {
  const rejected = Array.from({ length: 100 }, (_, i) => ({
    reason: `rejection_${i}`, detail: "sensitive",
  }));
  rejected.push({ reason: "source_exit_evidence_error" });
  const result = summarizeSourceExitQueue({ rejected });
  assert.equal(result.errors, 1, "overflow never hides operational failures");
  assert.ok(Object.keys(result.rejectedByReason).length <= 17);
  assert.equal(Object.values(result.rejectedByReason).reduce((a, b) => a + b, 0), 101);
  const unsafe = summarizeSourceExitQueue({
    rejected: [{ reason: "user@example.com" }, {}, { reason: "__proto__" }],
  });
  assert.deepEqual(unsafe.rejectedByReason, { unclassified_rejection: 3 });
  assert.doesNotMatch(JSON.stringify(result), /sensitive/);
});