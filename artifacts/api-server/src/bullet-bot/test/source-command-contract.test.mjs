import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../server.mjs";
import { validateSourceCommand, sourceCommandHash, directCloseRequest } from "../source-command-contract.mjs";
import { processSourceCommand } from "../source-command-runtime.mjs";

const command = () => ({ commandId: "cmd-test-1", sourceSignalId: "cab-signal-test",
  symbol: "ETHUSDT", type: "close", sequence: 1,
  occurredAt: new Date().toISOString(), reason: "trailing_exit" });

test("source commands normalize their immutable identity and full-close scope", () => {
  const value = command();
  const parsed = validateSourceCommand(value);
  assert.equal(parsed.scope, "all");
  assert.equal(sourceCommandHash(value), sourceCommandHash({ ...value, scope: "all" }));
  assert.equal(directCloseRequest(parsed, parsed.occurredAt).evidence.sourceStatus, "command");
});
test("source commands refuse partial/ambiguous closes and unwanted trading fields", () => {
  for (const extra of [{ scope: "partial" }, { fractionOfInitial: 0.2 },
    { reduceOnly: true }, { mode: "real" }, { stopPrice: "110" }]) {
    assert.throws(() => validateSourceCommand({ ...command(), ...extra }), TypeError);
  }
});
test("stop commands require a positive decimal string and a sequence", () => {
  for (const stopPrice of [null, undefined, -1, 100, "0", "Infinity", "1e2"]) {
    assert.throws(() => validateSourceCommand({ ...command(), type: "move_stop", stopPrice }), TypeError);
  }
  assert.equal(validateSourceCommand({ ...command(), type: "move_stop", stopPrice: "101.23" }).stopPrice, "101.23");
  assert.throws(() => validateSourceCommand({ ...command(), sequence: 0 }), TypeError);
});
test("execution acknowledgement is independent and exceptions stay retryable", async () => {
  const saved = [];
  const inbox = {
    next: async mode => ({ command: command(), targets: { [mode]: { status: "pending" } } }),
    complete: async (...args) => { saved.push(args); return args[2]; },
  };
  assert.equal((await processSourceCommand(inbox, "vst", {
    executeSourceCommand: async () => { throw new Error("transport unknown"); },
  })).status, "pending");
  assert.equal(saved[0][2].reason, "command_execution_unavailable");
  assert.equal((await processSourceCommand(inbox, "paper", {
    executeSourceCommand: async () => ({ status: "executed", result: "paper_close_simulated" }),
  })).result, "paper_close_simulated");
});

test("command HTTP endpoints authenticate before reading, persist before 202, and expose no execution claim", async t => {
  const calls = [];
  const inbox = {
    receive: async (body, modes) => {
      calls.push({ body, modes });
      return { kind: calls.length === 1 ? "received" : "duplicate",
        receipt: { ...validateSourceCommand(body), deliveries: [
          { mode: "paper", status: "pending" }, { mode: "vst", status: "pending" },
        ] } };
    },
    list: async () => [calls[0].body],
  };
  const server = createServer({ store: { enqueue: async () => ({ kind: "accepted" }), listOpenPositions: async () => [] },
    token: "test-not-a-secret", mode: "both", commandInbox: inbox });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/trading/commands`;
  const body = JSON.stringify(command());
  assert.equal((await fetch(url, { method: "POST", body })).status, 401);
  assert.equal(calls.length, 0);
  const headers = { "x-trading-token": "test-not-a-secret", "content-type": "application/json" };
  const first = await fetch(url, { method: "POST", body, headers });
  assert.equal(first.status, 202);
  const receipt = await first.json();
  assert.equal(receipt.command.deliveries.every(delivery => delivery.status === "pending"), true);
  assert.deepEqual(calls[0].modes, ["paper", "vst"]);
  assert.equal((await fetch(url, { method: "POST", body, headers })).status, 200);
  assert.equal((await fetch(url, { headers })).status, 200);
  assert.equal((await fetch(`${url}?limit=0`, { headers })).status, 422);
  assert.equal((await fetch(url, { method: "POST", body: "{}", headers })).status, 422);
});
