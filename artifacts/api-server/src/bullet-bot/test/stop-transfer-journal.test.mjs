import assert from "node:assert/strict";
import test from "node:test";
import { createStopTransferJournal, matchesPreparedStopTransferPosition } from "../stop-transfer-journal.mjs";

const request = { operation: "raise_stop", symbol: "BTCUSDT", stopTransferProtocol: 1 };
const post = { method: "POST", params: {
  symbol: "BTC-USDT", type: "STOP_MARKET", quantity: "0.1", stopPrice: "95",
} };
const cancel = { method: "DELETE", params: { symbol: "BTC-USDT", orderId: "1001" } };

test("preparation recovery tolerates monitoring changes but never changed exposure, stop IDs, or owner resolution", () => {
  const priorPosition = { sourceSignalId: "s", symbol: "BTCUSDT", remainingQty: 1,
    status: "open", verifiedProtectiveStops: {
      core: { orderId: "1001", positionId: "999", quantity: "1", stopPrice: "90" },
    } };
  const request = { priorPosition };
  const current = { ...priorPosition, status: "unknown", peakGainPct: 15 };
  assert.equal(matchesPreparedStopTransferPosition(request, current), true);
  assert.equal(matchesPreparedStopTransferPosition(request, { ...current, remainingQty: 2 }), false);
  assert.equal(matchesPreparedStopTransferPosition(request, {
    ...current, verifiedProtectiveStops: {
      core: { ...priorPosition.verifiedProtectiveStops.core, orderId: "1003" },
    },
  }), false);
  assert.equal(matchesPreparedStopTransferPosition(request, {
    ...current, manualResolution: { outcome: "still_open" },
  }), false);
});

function fixture(progress = { version: 1, stage: "prepared" }) {
  let saved = { ...progress };
  const writes = [];
  const journal = createStopTransferJournal({
    request, progress,
    async persist(expected, next, id) {
      if (saved.stage !== expected) return false;
      writes.push({ expected, next: { ...next }, id });
      saved = { ...next };
      return true;
    },
  });
  return { journal, writes, progress: () => saved };
}

test("stop-transfer boundaries are persisted in order; response acknowledgement is idempotent after cancellation", async () => {
  const f = fixture();
  await f.journal.beforeMutation(post);
  await f.journal.afterMutation({ method: "POST", orderId: "1002" });
  await f.journal.beforeMutation(cancel);
  await f.journal.afterMutation({ method: "DELETE" });
  await f.journal.acknowledge("1002");
  assert.deepEqual(f.writes.map(w => w.next.stage),
    ["post_started", "post_acknowledged", "cancel_started", "cancel_acknowledged"]);
  assert.equal(f.writes[1].id, "1002");
  await assert.rejects(f.journal.beforeMutation(post), /replay_forbidden/);
  await assert.rejects(f.journal.beforeMutation(cancel), /replay_forbidden/);
});

test("a persisted possibly-sent POST is never replayable after restart", async () => {
  const f = fixture({ version: 1, stage: "post_started" });
  await assert.rejects(f.journal.beforeMutation(post), /replay_forbidden/);
  await assert.rejects(f.journal.beforeMutation(cancel), /replay_forbidden/);
  assert.equal(f.writes.length, 0);
});

test("an acknowledged replacement permits the first DELETE after restart, but never a second", async () => {
  const f = fixture({ version: 1, stage: "post_acknowledged", newStopOrderId: "1002" });
  await assert.rejects(f.journal.beforeMutation(post), /replay_forbidden/);
  await f.journal.beforeMutation(cancel);
  const restarted = fixture(f.progress());
  await assert.rejects(restarted.journal.beforeMutation(cancel), /replay_forbidden/);
});

test("only explicit pre-fetch refusal can roll back a durable write boundary", async () => {
  const f = fixture();
  await f.journal.beforeMutation(post);
  await f.journal.mutationNotSent({ method: "POST" });
  assert.equal(f.progress().stage, "prepared");
  await f.journal.beforeMutation(post);
  await f.journal.acknowledge("1002");
  await f.journal.beforeMutation(cancel);
  await f.journal.mutationNotSent({ method: "DELETE" });
  assert.equal(f.progress().stage, "post_acknowledged");
  await f.journal.beforeMutation(cancel);
});

test("failed journal persistence and conflicting exact IDs block mutation", async () => {
  const journal = createStopTransferJournal({
    request, persist: async () => false,
  });
  await assert.rejects(journal.beforeMutation(post), /persistence_failed/);
  assert.equal(journal.getProgress().stage, "prepared");
  const f = fixture();
  await f.journal.beforeMutation(post);
  await assert.rejects(f.journal.acknowledge(9007199254740992), /exact_order_id/);
  await f.journal.acknowledge("1002");
  await assert.rejects(f.journal.acknowledge("1003"), /acknowledgement_conflict/);
  await assert.rejects(f.journal.beforeMutation({
    ...cancel, params: { ...cancel.params, symbol: "ETH-USDT" },
  }), /symbol_conflict/);
});

test("single-leg placement and cancellation cannot cross the other operation's boundary", async () => {
  const place = createStopTransferJournal({
    request: { ...request, operation: "split_raise_stop_place" }, persist: async () => true,
  });
  await place.beforeMutation(post);
  await place.acknowledge("1002");
  await assert.rejects(place.beforeMutation(cancel), /replay_forbidden/);
  const retire = createStopTransferJournal({
    request: { ...request, operation: "split_raise_stop_cancel" }, persist: async () => true,
  });
  await assert.rejects(retire.beforeMutation(post), /replay_forbidden/);
  await retire.beforeMutation(cancel);
  await retire.afterMutation({ method: "DELETE" });
  await assert.rejects(retire.beforeMutation(cancel), /replay_forbidden/);
});