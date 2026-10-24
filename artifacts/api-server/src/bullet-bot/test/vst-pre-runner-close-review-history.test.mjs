import assert from "node:assert/strict";
import test from "node:test";
import { createVstStore } from "../vst-store.mjs";

test("history reads persisted owner reviews without status joins or exchange actions", async () => {
  const savedReview = {
    outcome: "closed",
    checkedAt: "2026-10-02T10:00:00.000Z",
    resolvedBy: "owner-test",
    note: "Verified on BingX",
    originalOutcome: { error: "Error", errorMessage: "original failure" },
    evidence: {
      observedAt: "2026-10-02T09:59:59.000Z",
      verified: true,
      coverage: [{ startTs: 1, endTs: 2, verified: true }],
    },
  };
  const row = {
    source_signal_id: "test-signal",
    phase: "impulse-runner-breakeven-abort-1",
    client_order_id: "test-client",
    request: { operation: "close_pre_runner_split", symbol: "BTCUSDT" },
    state: "failed",
    exchange_order_id: null,
    outcome: { error: "Error", ownerPreRunnerCloseReview: savedReview },
    created_at: new Date("2026-10-01T10:00:00Z"),
    updated_at: new Date(savedReview.checkedAt),
  };
  let reads = 0;
  const pool = {
    async query(sql) {
      reads++;
      assert.match(sql, /FROM vst_order_intents/);
      assert.match(sql, /request->>'operation' = 'close_pre_runner_split'/);
      assert.match(sql, /jsonb_typeof\(outcome->'ownerPreRunnerCloseReview'\) = 'object'/);
      assert.match(sql, /checkedAt' DESC, id DESC/);
      assert.doesNotMatch(sql, /\b(UPDATE|INSERT|DELETE|JOIN|LIMIT)\b/);
      return { rows: [structuredClone(row)] };
    },
    async connect() { throw new Error("History must not open a write transaction"); },
  };
  // A new store instance after a restart sees the same saved decision.
  for (let i = 0; i < 2; i++) {
    const result = await createVstStore(pool).listLegacyPreRunnerCloseReviews();
    assert.equal(result.length, 1);
    assert.equal(result[0].clientOrderId, row.client_order_id);
    assert.deepEqual(result[0].outcome.ownerPreRunnerCloseReview, savedReview);
    assert.equal(result[0].state, "failed");
    assert.equal(result[0].outcome.mutationProvenance, undefined);
  }
  assert.equal(reads, 2);
});

test("empty saved history is an empty list", async () => {
  const store = createVstStore({
    async query() { return { rows: [] }; },
    async connect() { throw new Error("Unexpected transaction"); },
  });
  assert.deepEqual(await store.listLegacyPreRunnerCloseReviews(), []);
});