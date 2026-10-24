import assert from "node:assert/strict";
import test from "node:test";
import { createBingXOutboundPacer } from "../bingx-live-api.mjs";

function fixture() {
  let now = 1700000000000;
  const starts = [];
  const pacer = createBingXOutboundPacer({
    gapMs: 1100,
    clock: () => now,
    sleep: async ms => {
      await new Promise(resolve => setImmediate(resolve));
      now += ms;
    },
  });
  const wait = (name, options) => pacer.waitForSlot(options).then(at => {
    starts.push({ name, at });
    return at;
  });
  return { pacer, wait, starts };
}

test("freshly checked writes take the next shared slot ahead of queued background reads", async () => {
  const f = fixture();
  await f.wait("initial");
  await Promise.all([
    f.wait("read-1"),
    f.wait("read-2"),
    f.wait("write", { priority: true }),
  ]);
  assert.deepEqual(f.starts.map(row => row.name), ["initial", "write", "read-1", "read-2"]);
  assert.equal(f.starts[1].at - f.starts[0].at, 1100);
  for (let index = 1; index < f.starts.length; index++) {
    assert.ok(f.starts[index].at - f.starts[index - 1].at >= 1100);
  }
});

test("ordinary reads retain FIFO order and priority never bypasses exchange cooldown", async () => {
  const f = fixture();
  await f.wait("initial");
  f.pacer.deferFor(5000);
  await Promise.all([f.wait("read-1"), f.wait("read-2"), f.wait("write", { priority: true })]);
  assert.deepEqual(f.starts.map(row => row.name), ["initial", "write", "read-1", "read-2"]);
  assert.ok(f.starts[1].at - f.starts[0].at >= 5000);
});
