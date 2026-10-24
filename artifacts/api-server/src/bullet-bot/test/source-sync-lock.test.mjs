import assert from "node:assert/strict";
import { test } from "node:test";
import { syncSourceWithLockRetry } from "../source-sync-lock.mjs";

test("a busy PAPER monitor lock is retried until source reconciliation runs", async () => {
  const positions = new Map([["source-1", {}]]);
  let calls = 0;
  let waits = 0;
  const worker = {
    syncSourcePositions: async (received) => {
      assert.equal(received, positions);
      calls += 1;
      return calls < 3 ? null : [{ sourceSignalId: "source-1", kind: "closed" }];
    },
  };
  const outcomes = await syncSourceWithLockRetry(worker, positions, {
    maxAttempts: 3,
    sleep: async () => { waits += 1; },
  });
  assert.equal(outcomes[0].kind, "closed");
  assert.equal(calls, 3);
  assert.equal(waits, 2);
});

test("a lock that never becomes available fails visibly, not as a successful empty poll", async () => {
  let calls = 0;
  await assert.rejects(
    syncSourceWithLockRetry({
      syncSourcePositions: async () => { calls += 1; return null; },
    }, new Map(), { maxAttempts: 3, sleep: async () => {} }),
    /source_sync_lock_unavailable/,
  );
  assert.equal(calls, 3);
});