import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateSignal } from "../contract.mjs";
import { initialPosition } from "../engine.mjs";
import { createVstPolicy } from "../vst-policy.mjs";

const sample = JSON.parse(await readFile(
  new URL("./fixtures/impulse-buy-sample.json", import.meta.url), "utf8"));

test("all confirmed pattern IDs pass ingress and both position builders regardless of old experimental label", () => {
  for (const patternId of ["balanced_grind", "new_pattern", "previously_experimental"]) {
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
