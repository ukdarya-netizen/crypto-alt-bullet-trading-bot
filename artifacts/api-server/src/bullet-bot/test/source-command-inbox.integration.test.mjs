import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSourceCommandInbox } from "../source-command-inbox.mjs";

test("PostgreSQL command inbox survives reconstruction, serializes duplicates and fences late stops/entries",
  { skip: process.env.RUN_SOURCE_COMMAND_DB_TESTS !== "1" }, async t => {
    const { pool } = await import("@workspace/db");
    const sourceSignalId = `command-db-test-${randomUUID()}`;
    t.after(async () => {
      await pool.query(`DELETE FROM vst_events WHERE kind = 'source_command_received'
        AND detail->'command'->>'sourceSignalId' = $1`, [sourceSignalId]);
      await pool.end();
    });
    const inbox = createSourceCommandInbox(pool);
    const restarted = createSourceCommandInbox(pool);
    const command = { commandId: `cmd-${randomUUID()}`, sourceSignalId, symbol: "ETHUSDT",
      type: "move_stop", stopPrice: "101.23", sequence: 1,
      occurredAt: new Date().toISOString(), reason: "test_stop" };
    // VST is not executed in development; these isolated, nonexistent source
    // IDs never refer to a real trading position or make an exchange call.
    const results = await Promise.all([inbox.receive(command, ["vst"]), restarted.receive(command, ["vst"])]);
    assert.deepEqual(results.map(result => result.kind).sort(), ["duplicate", "received"]);
    assert.equal((await restarted.list({ commandId: command.commandId }))[0].deliveries[0].status, "pending");
    assert.equal((await inbox.receive({ ...command, stopPrice: "102" }, ["vst"])).kind, "conflict");
    assert.equal((await inbox.receive({ ...command, commandId: `cmd-${randomUUID()}` }, ["vst"])).kind, "conflict");
    const close = { ...command, commandId: `cmd-${randomUUID()}`, type: "close", sequence: 3 };
    delete close.stopPrice;
    assert.equal((await inbox.receive(close, ["vst"])).kind, "received");
    assert.equal((await restarted.list({ commandId: command.commandId }))[0].deliveries[0].status, "superseded");
    const lateStop = { ...command, commandId: `cmd-${randomUUID()}`, sequence: 2 };
    assert.equal((await inbox.receive(lateStop, ["vst"])).receipt.deliveries[0].status, "superseded");
    assert.equal(await inbox.isEntryBlocked(sourceSignalId, "paper"), true);
    assert.equal(await inbox.isEntryBlocked(sourceSignalId, "vst"), true);
    assert.equal((await inbox.complete(close.commandId, "vst",
      { status: "pending", reason: "exchange_read_temporarily_unavailable" })).deliveries[0].attempts, 1);
    assert.equal((await restarted.list({ commandId: close.commandId }))[0].deliveries[0].status, "pending");
    assert.equal((await inbox.complete(close.commandId, "vst",
      { status: "executed", result: "exchange_close_verified" })).deliveries[0].status, "executed");
    assert.equal((await restarted.receive(close, ["paper", "vst"])).receipt.deliveries.length, 1);
    assert.equal(await inbox.lookupPosition("paper", sourceSignalId), null);
    assert.equal((await inbox.cancelEntry({ ...command, type: "cancel_entry" }, "paper")).status, "executed");
    assert.equal((await inbox.cancelEntry({ ...command, type: "cancel_entry" }, "vst")).status, "executed");
  });
