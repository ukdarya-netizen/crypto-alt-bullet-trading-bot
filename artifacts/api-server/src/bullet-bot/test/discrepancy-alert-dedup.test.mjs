import assert from "node:assert/strict";
import { test } from "node:test";
import {
  provenKey,
  selectNewlyProvenDiscrepancies,
  markDiscrepanciesAlerted,
} from "../discrepancy-alert-dedup.mjs";

function item(overrides = {}) {
  return { ledger: "vst", sourceSignalId: "sig-1", kind: "symbol_mismatch", ...overrides };
}

test("provenKey identifies a discrepancy by ledger, source signal, and kind", () => {
  assert.equal(provenKey(item()), "vst:sig-1:symbol_mismatch");
  assert.notEqual(provenKey(item({ ledger: "real" })), provenKey(item()));
  assert.notEqual(provenKey(item({ sourceSignalId: "sig-2" })), provenKey(item()));
  assert.notEqual(provenKey(item({ kind: "source_missing" })), provenKey(item()));
});

test("a new discrepancy is selected for alerting", () => {
  const alerted = new Set();
  const newlyProven = selectNewlyProvenDiscrepancies(alerted, [item()]);
  assert.deepEqual(newlyProven, [item()]);
  // Selection alone must not mark it alerted -- only the caller, after a
  // successful send, does that (so a failed send stays retryable).
  assert.equal(alerted.size, 0);
});

test("a discrepancy already alerted is not repeated on the next sync pass while it persists", () => {
  const alerted = new Set([provenKey(item())]);
  const newlyProven = selectNewlyProvenDiscrepancies(alerted, [item()]);
  assert.deepEqual(newlyProven, []);
  assert.equal(alerted.size, 1);
});

test("a resolved discrepancy is forgotten and re-alerts if it recurs later", () => {
  const alerted = new Set([provenKey(item())]);
  // Pass with the discrepancy no longer proven (resolved).
  const resolvedPass = selectNewlyProvenDiscrepancies(alerted, []);
  assert.deepEqual(resolvedPass, []);
  assert.equal(alerted.has(provenKey(item())), false);

  // It recurs on a later pass: must be selected as newly proven again.
  const recurredPass = selectNewlyProvenDiscrepancies(alerted, [item()]);
  assert.deepEqual(recurredPass, [item()]);
});

test("markDiscrepanciesAlerted records items so the next pass treats them as already alerted", () => {
  const alerted = new Set();
  const items = [item(), item({ sourceSignalId: "sig-2" })];
  markDiscrepanciesAlerted(alerted, items);
  assert.equal(alerted.size, 2);
  assert.deepEqual(selectNewlyProvenDiscrepancies(alerted, items), []);
});

test("only unresolved keys are pruned; an unrelated still-proven key survives", () => {
  const alerted = new Set([provenKey(item()), provenKey(item({ sourceSignalId: "sig-2" }))]);
  const newlyProven = selectNewlyProvenDiscrepancies(alerted, [item({ sourceSignalId: "sig-2" })]);
  assert.deepEqual(newlyProven, []);
  assert.deepEqual([...alerted], [provenKey(item({ sourceSignalId: "sig-2" }))]);
});

test("simulates the full sync-loop dedup/recovery lifecycle across multiple passes", () => {
  const alerted = new Set();
  const send = (items) => { send.calls.push(items); };
  send.calls = [];

  function pass(proven) {
    const newlyProven = selectNewlyProvenDiscrepancies(alerted, proven);
    if (newlyProven.length) {
      send(newlyProven);
      markDiscrepanciesAlerted(alerted, newlyProven);
    }
  }

  const discrepancy = item();
  pass([discrepancy]); // first sighting: alerts once
  pass([discrepancy]); // still present 5 minutes later: must not repeat
  pass([discrepancy]); // still present again: must not repeat
  pass([]); // resolved
  pass([discrepancy]); // recurs: must alert again

  assert.equal(send.calls.length, 2);
  assert.deepEqual(send.calls[0], [discrepancy]);
  assert.deepEqual(send.calls[1], [discrepancy]);
});
