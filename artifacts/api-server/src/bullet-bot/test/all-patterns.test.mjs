import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateSignal } from "../contract.mjs";
import { initialPosition } from "../engine.mjs";
import { createVstPolicy } from "../vst-policy.mjs";
import { createServer } from "../server.mjs";
import { applyFullTake } from "../fixed-price-take-profit.mjs";

const sample = JSON.parse(await readFile(
  new URL("./fixtures/impulse-buy-sample.json", import.meta.url), "utf8"));

test("all confirmed pattern IDs pass ingress and both position builders regardless of old experimental label", () => {
  for (const patternId of ["balanced_grind", "neon_support_bounce", "stealth_breakout",
    "new_pattern", "previously_experimental"]) {
    for (const patternStatus of ["approved", "experimental", undefined]) {
      const signal = structuredClone(sample);
      signal.patternId = patternId;
      signal.patternStatus = patternStatus;
      signal.symbol = "ETHUSDT";
      delete signal.payload.exitRules.runner;
      const now = Date.parse(signal.signalAt);
      assert.equal(validateSignal(signal, now).status, 200, `${patternId}/${patternStatus}`);
      const fill = { price: Number(signal.referencePrice), quantity: 10,
        at: signal.signalAt, mode: "paper" };
      assert.equal(initialPosition(signal, fill).patternId, patternId);
      assert.equal(createVstPolicy({ signal, fill }).patternId, patternId);
      signal.confirmationStatus = "candidate";
      assert.equal(validateSignal(signal, now).status, 422);
    }
  }
});

test("all-pattern admission still rejects malformed IDs and expired signals", () => {
  for (const patternId of ["", "bad pattern", "../path", "x".repeat(101), null]) {
    const signal = { ...sample, patternId };
    assert.equal(validateSignal(signal, Date.parse(signal.signalAt)).status, 422);
  }
  assert.equal(validateSignal(sample, Date.parse(sample.signalAt) + 601_000).status, 422);
});

test("pattern-specific source ladders pass intake and both position builders", () => {
  for (const patternId of ["neon_support_bounce", "stealth_breakout", "future_pattern"]) {
    const signal = structuredClone(sample);
    signal.patternId = patternId;
    signal.patternStatus = "experimental";
    signal.symbol = "APRUSDT";
    Object.assign(signal.payload.exitRules, {
      firstTargetPct: 5, breakevenAtPct: 2, protectedProfitAtPct: 4,
      protectedProfitPct: 2, trailingActivationPct: 6, trailingGapPercentagePoints: 3,
    });
    delete signal.payload.exitRules.runner;
    const now = Date.parse(signal.signalAt);
    const fill = { price: Number(signal.referencePrice),
      quantity: Number(signal.quantity), at: new Date(now).toISOString(), mode: "paper" };
    assert.equal(validateSignal(signal, now).status, 200, patternId);
    assert.equal(initialPosition(signal, fill).patternId, patternId);
    assert.equal(createVstPolicy({ signal, fill }).patternId, patternId);
    const position = initialPosition(signal, fill);
    const take = applyFullTake({ next: { ...position }, actions: [] }, position,
      position.entryPrice * 1.051, now + 1_000);
    assert.equal(take.next.status, "closed", "source ladder does not replace full +5% take");
    assert.equal(take.next.remainingQty, 0);

    for (const invalid of [NaN, Infinity, -1, 0, "5", undefined]) {
      const broken = structuredClone(signal);
      broken.payload.exitRules.firstTargetPct = invalid;
      assert.equal(validateSignal(broken, now).error.code, "unsupported_ladder");
      assert.throws(() => initialPosition(broken, fill));
      assert.throws(() => createVstPolicy({ signal: broken, fill }));
    }
    const badStop = structuredClone(signal);
    badStop.stopLoss = badStop.referencePrice;
    assert.equal(validateSignal(badStop, now).error.code, "invalid_entry_or_stop");
    assert.equal(validateSignal(signal, now + 601_000).error.code, "expired_or_future_signal");
  }
});

test("Neon and Stealth source ladders reach PAPER and VST through the HTTP receiver", async () => {
  const paper = [], vst = [];
  const now = Date.parse(sample.signalAt) + 1_000;
  const server = createServer({
    token: "test-token", mode: "both", clock: () => now, vstEnabledAt: now - 2_000,
    store: {
      listOpenPositions: async () => [],
      enqueue: async signal => { vst.push(signal); return { kind: "new", status: "pending" }; },
    },
    paperStore: {
      enqueue: async signal => { paper.push(signal); return { kind: "new", status: "pending" }; },
    },
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const [index, patternId] of ["neon_support_bounce", "stealth_breakout"].entries()) {
      const signal = structuredClone(sample);
      signal.sourceSignalId = `cab-signal-${90001 + index}`;
      signal.patternId = patternId;
      signal.patternStatus = "experimental";
      signal.symbol = "APRUSDT";
      delete signal.payload.exitRules.runner;
      Object.assign(signal.payload.exitRules, {
        firstTargetPct: 3, breakevenAtPct: 1, protectedProfitAtPct: 3,
        protectedProfitPct: 1, trailingActivationPct: 5, trailingGapPercentagePoints: 2,
      });
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/trading/signals`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-trading-token": "test-token" },
        body: JSON.stringify(signal),
      });
      assert.equal(response.status, 202, JSON.stringify(await response.json()));
      assert.deepEqual(paper.at(-1), signal, "retain original producer payload");
      assert.deepEqual(vst.at(-1), signal);
    }
    assert.equal(paper.length, 2);
    assert.equal(vst.length, 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
