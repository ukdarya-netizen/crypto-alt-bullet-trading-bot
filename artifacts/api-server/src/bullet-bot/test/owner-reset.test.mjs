import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../server.mjs";

test("bulk reset is authenticated, explicitly confirmed, and reports queueing rather than fake execution", async () => {
  const calls = [];
  const server = createServer({ token: "test-only-token", store: { enqueue: async () => {} },
    commandInbox: {
      requestReset: async input => { calls.push(input); return { kind: "received",
        reset: { resetId: input.resetId, phase: "closing", pending: 2 } }; },
      resetStatus: async id => ({ resetId: id, phase: "closing", pending: 2 }),
    } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/trading/reset`;
    assert.equal((await fetch(url)).status, 401);
    const headers = { "x-trading-token": "test-only-token", "content-type": "application/json" };
    assert.equal((await fetch(url, { method: "POST", headers,
      body: JSON.stringify({ resetId: "reset-test" }) })).status, 422);
    assert.equal(calls.length, 0);
    const response = await fetch(url, { method: "POST", headers,
      body: JSON.stringify({ resetId: "reset-test", confirm: "cancel_queue_and_close_paper_vst" }) });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).reset.phase, "closing");
    assert.deepEqual(calls, [{ resetId: "reset-test", vstAvailable: false }]);
    assert.equal((await (await fetch(`${url}?resetId=reset-test`, { headers })).json()).reset.pending, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
