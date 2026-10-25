import test from "node:test";
import assert from "node:assert/strict";
import { createVstEndpointPacer } from "../vst-endpoint-pacer.mjs";

const POSITIONS = "/openApi/swap/v2/user/positions";
const BALANCE = "/openApi/swap/v3/user/balance";
const MARGIN = "/openApi/swap/v2/trade/marginType";
function fixture() {
  let time = 1_000;
  return {
    pacer: createVstEndpointPacer({
      clock: () => time,
      sleep: async (ms) => { time += ms; },
    }),
  };
}
test("different verified read endpoints no longer wait 1.1 seconds each", async () => {
  const { pacer } = fixture();
  const starts = await Promise.all([POSITIONS, BALANCE, MARGIN].map((endpoint) =>
    pacer.waitForSlot({ method: "GET", endpoint })));
  assert.deepEqual(starts, [1_000, 1_300, 1_600]);
});
test("same endpoint shares its UID floor across all symbols and callers", async () => {
  const { pacer } = fixture();
  const starts = await Promise.all(Array.from({ length: 5 }, () =>
    pacer.waitForSlot({ method: "GET", endpoint: POSITIONS })));
  assert.deepEqual(starts, [1_000, 1_600, 2_200, 2_800, 3_400]);
});
test("writes retain 1.1-second spacing and priority over queued background reads", async () => {
  const { pacer } = fixture();
  const first = pacer.waitForSlot({ method: "POST", endpoint: MARGIN });
  const read = pacer.waitForSlot({ method: "GET", endpoint: POSITIONS });
  const second = pacer.waitForSlot({ method: "POST", endpoint: MARGIN, priority: true });
  const [a, b, c] = await Promise.all([first, read, second]);
  assert.equal(a, 1_000);
  assert.equal(b, 1_300, "reads may use a slot while the write floor is active");
  assert.equal(c, 2_100);
});
test("an eligible protective write wins the next global slot", async () => {
  const { pacer } = fixture();
  await pacer.waitForSlot({ method: "GET", endpoint: POSITIONS });
  const read = pacer.waitForSlot({ method: "GET", endpoint: BALANCE });
  const write = pacer.waitForSlot({ method: "POST", endpoint: MARGIN, priority: true });
  const [a, b] = await Promise.all([read, write]);
  assert.equal(b, 1_300);
  assert.equal(a, 1_600);
});
test("unknown endpoint and callers without metadata keep conservative pacing", async () => {
  const { pacer } = fixture();
  const starts = await Promise.all([
    pacer.waitForSlot({ method: "GET", endpoint: "/unknown" }),
    pacer.waitForSlot(),
    pacer.waitForSlot({ method: "GET", endpoint: "/another" }),
  ]);
  assert.deepEqual(starts, [1_000, 2_100, 3_200]);
});
test("provider cooldown is shared by all endpoints and writes", async () => {
  const { pacer } = fixture();
  await pacer.waitForSlot({ method: "GET", endpoint: POSITIONS });
  pacer.deferFor(5_000);
  const starts = await Promise.all([
    pacer.waitForSlot({ method: "GET", endpoint: BALANCE }),
    pacer.waitForSlot({ method: "POST", endpoint: MARGIN, priority: true }),
  ]);
  assert.ok(starts.every((time) => time >= 6_000));
  assert.equal(Math.abs(starts[0] - starts[1]), 300);
});
test("nonfinite clock rejects requests rather than bypassing pacing", async () => {
  const pacer = createVstEndpointPacer({ clock: () => NaN, sleep: async () => {} });
  await assert.rejects(pacer.waitForSlot({ method: "GET", endpoint: POSITIONS }), /clock/);
});
