import test from "node:test";
import assert from "node:assert/strict";
import { runSourceCommandOrTick } from "../source-command-runtime.mjs";

for (const mode of ["paper", "vst"]) {
  test(`${mode}: completed cancel/close does not wait through ordinary management before the next command`, async () => {
    let ticks = 0;
    let commands = 0;
    const queue = [{ command: { commandId: "cancel-1" } }, { command: { commandId: "close-2" } }];
    const inbox = {
      next: async () => queue.shift(),
      complete: async (id, _mode, outcome) => ({ id, ...outcome }),
    };
    const worker = {
      executeSourceCommand: async () => { commands++; return { status: "executed" }; },
      tick: async () => { ticks++; return { kind: "idle" }; },
    };
    await runSourceCommandOrTick(inbox, mode, worker);
    await runSourceCommandOrTick(inbox, mode, worker);
    assert.equal(commands, 2);
    assert.equal(ticks, 0);
    await runSourceCommandOrTick(inbox, mode, worker);
    assert.equal(ticks, 1);
  });

  test(`${mode}: an ambiguous command still runs reconciliation and is never blindly repeated`, async () => {
    let ticks = 0;
    const worker = {
      executeSourceCommand: async () => { throw Error("transport unknown"); },
      tick: async () => { ticks++; return { kind: "reconciled" }; },
    };
    const result = await runSourceCommandOrTick({
      next: async () => ({ command: { commandId: "uncertain" } }),
      complete: async (_id, _mode, outcome) => outcome,
    }, mode, worker);
    assert.equal(ticks, 1);
    assert.equal(result.kind, "reconciled");
  });
}
