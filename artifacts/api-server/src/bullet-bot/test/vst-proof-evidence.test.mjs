import assert from "node:assert/strict";
import test from "node:test";
import { buildVstProofEvidence } from "../vst-proof-evidence.mjs";
import { buildVstDiagnostic, recordVstDiagnostic, recordVstRefusal } from "../vst-diagnostics.mjs";

const pair = (expected, actual, matches = expected === actual) => ({ expected, actual, matches });
test("proof checks distinguish missing, null and malformed values without losing numeric IDs", () => {
  const evidence = buildVstProofEvidence({
    source: "triggered_stop_proof", condition: "surviving_stop_fields",
    checks: {
      positionId: pair("2105662972415795200", "0", false),
      stopQuantity: pair("100", undefined, false),
      stopPrice: pair("95", "PRIVATE_TOKEN", false),
      orderStatus: pair("NEW", null, false),
    },
  });
  assert.equal(evidence.coverage, "queried_rows_and_interval_only");
  assert.equal(evidence.condition, "surviving_stop_fields");
  assert.deepEqual(evidence.failedChecks, ["stopQuantity", "stopPrice", "positionId", "orderStatus"]);
  assert.equal(evidence.checks.find((item) => item.field === "positionId").actual, "0");
  assert.equal(evidence.checks.find((item) => item.field === "stopQuantity").actualState, "missing");
  assert.equal(evidence.checks.find((item) => item.field === "orderStatus").actualState, "null");
  assert.equal(evidence.checks.find((item) => item.field === "stopPrice").actualState, "not_finite_decimal");
  assert.equal(JSON.stringify(evidence).includes("PRIVATE_TOKEN"), false);
  assert.ok(Object.isFrozen(evidence.checks[0]));
});

test("phase-inapplicable protection is visible but is not reported as a failed guard", () => {
  const evidence = buildVstProofEvidence({
    source: "split_preflight",
    checks: {
      positionValid: pair(true, false),
      corePositionId: { ...pair("100", undefined, false), applicable: false },
    },
  });
  assert.deepEqual(evidence.failedChecks, ["positionValid"]);
  assert.equal(evidence.checks.find((item) => item.field === "corePositionId").matches, "not_applicable");
});

test("redacted list members retain positions/counts and cannot become false absence", () => {
  const evidence = buildVstProofEvidence({
    source: "split_preflight",
    checks: {
      currentOrderIds: pair(["100"], ["100", "PRIVATE_TOKEN", 9007199254740992], false),
      quantityValues: pair(undefined, ["10", "PRIVATE_TOKEN"], false),
      response: pair("PRIVATE_TOKEN", "PRIVATE_TOKEN", false),
    },
  });
  const ids = evidence.checks.find((item) => item.field === "currentOrderIds");
  assert.deepEqual(ids.actual, ["100", null, null]);
  assert.equal(ids.actualCount, 3);
  assert.equal(ids.actualState, "contains_invalid_or_redacted_values");
  assert.equal(JSON.stringify(evidence).includes("PRIVATE_TOKEN"), false);
  assert.equal(evidence.checks.some((item) => item.field === "response"), false);
});

test("forged evidence and arbitrary condition/validation labels cannot leak into a diagnostic", () => {
  assert.equal(buildVstDiagnostic(new Error("test"), {
    proofEvidence: { response: "PRIVATE_TOKEN" },
  }).proofEvidence, undefined);
  const evidence = buildVstProofEvidence({
    source: "PRIVATE_TOKEN", condition: "PRIVATE_TOKEN", validationField: "PRIVATE_TOKEN",
    checks: { numericValue: pair(undefined, "PRIVATE_TOKEN", false) },
  });
  assert.equal(JSON.stringify(evidence).includes("PRIVATE_TOKEN"), false);
});

test("snapshot and tranche validators keep the reviewed field name, not only a numeric failure", () => {
  for (const validationField of ["protective_stop_price", "position_average_price",
    "core_persisted_stop_quantity", "runner_snapshot_stop_price",
    "pre_runner_split_runner_stop_quantity"]) {
    assert.equal(buildVstProofEvidence({
      source: "broker_validation", condition: "decimal_validation", validationField,
      checks: { numericValue: pair(undefined, "0", false) },
    }).validationField, validationField);
  }
});

test("outer proof observations preserve precise inherited API context and inner proof", () => {
  const originalWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    const error = new Error("unique-proof-context-inheritance");
    const inner = buildVstProofEvidence({
      source: "broker_validation", condition: "decimal_validation", validationField: "triggered_fill_quantity",
      checks: { numericValue: pair(undefined, "PRIVATE_TOKEN", false) },
    });
    recordVstDiagnostic(error, {
      stage: "api_call", apiMethod: "getPositions", proofEvidence: inner,
    });
    const outer = recordVstDiagnostic(error, {
      stage: "positionManagement", operation: "read_position",
      proofEvidence: buildVstProofEvidence({ source: "triggered_stop_proof" }),
    });
    assert.equal(outer.apiMethod, "getPositions");
    assert.equal(outer.proofEvidence, inner);
    assert.equal(outer.stage, "positionManagement");
  } finally { process.stderr.write = originalWrite; }
});

test("a changed failed proof emits immediately under the same refusal ref", () => {
  const originalWrite = process.stderr.write;
  const lines = [];
  process.stderr.write = (line) => { lines.push(String(line)); return true; };
  try {
    for (const value of ["90", "80"]) {
      recordVstRefusal("stop_proof_unverified", {
        symbol: "BTCUSDT", sourceSignalId: "cab-signal-99111", check: "protective_stop",
        proofEvidence: buildVstProofEvidence({
          source: "triggered_stop_proof", condition: "fill_quantity",
          checks: { filledQuantity: pair("100", value, false) },
        }),
      });
    }
    assert.equal(lines.length, 2);
  } finally { process.stderr.write = originalWrite; }
});