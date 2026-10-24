import assert from "node:assert/strict";
import test from "node:test";
import { buildVstStopEvidence, buildVstPositionCheckEvidence } from "../vst-stop-evidence.mjs";
import { buildVstDiagnostic, recordVstRefusal } from "../vst-diagnostics.mjs";

const positionId = "2105662972415795200";
const stopId = "2105662972415795201";
const row = { symbol: "AKT-USDT", positionAmt: "100", positionId };
const stop = { symbol: "AKT-USDT", orderId: stopId, positionId, origQty: "100",
  stopPrice: "0.95", type: "STOP_MARKET", status: "NEW", side: "SELL",
  positionSide: "LONG", workingType: "MARK_PRICE" };
const expected = { core: { orderId: stopId, quantity: "100", stopPrice: "0.95" } };
const evidence = (orders, extra = {}) => buildVstStopEvidence({
  symbol: "AKTUSDT", row, orders, expectedStops: expected, ...extra,
});

test("a present matching stop has lossless IDs and reviewed expected/actual fields", () => {
  const result = evidence([stop], { verifiedStops: { core: { verified: true } } });
  assert.equal(result.verdict, "stop_verified");
  assert.equal(result.expectedStops[0].presence, "present_in_response");
  assert.equal(result.expectedStops[0].observations[0].actual.orderId, stopId);
  assert.equal(result.expectedStops[0].expected.positionId, positionId);
  assert.deepEqual(result.expectedStops[0].observations[0].failedChecks, []);
});

test("no returned stop is scoped absence, never global exchange absence", () => {
  const result = evidence([]);
  assert.equal(result.verdict, "expected_stop_not_found_in_response");
  assert.equal(result.readStatus, "succeeded");
  assert.equal(result.openOrderCount, 0);
  assert.equal(result.coverage, "returned_open_orders_only");
  assert.equal(result.expectedStops[0].presence, "not_found_in_response");
  assert.equal(result.stopAbsent, undefined);
});

test("a read failure must not invent presence, absence or an empty returned set", () => {
  const result = buildVstStopEvidence({ readFailed: true, source: "broker_snapshot" });
  assert.equal(result.verdict, "cannot_determine_presence");
  assert.equal(result.readStatus, "failed");
  assert.equal(result.positionPresent, undefined);
  assert.equal(result.openOrderCount, undefined);
  assert.equal(result.expectedStops, undefined);
});

test("a found ID with wrong position, quantity and price reports each mismatch", () => {
  const result = evidence([{ ...stop, positionId: "0", origQty: "90", stopPrice: "0.94" }]);
  const observed = result.expectedStops[0].observations[0];
  assert.equal(result.verdict, "stop_fields_mismatch");
  assert.equal(result.expectedStops[0].presence, "present_in_response");
  assert.deepEqual(observed.failedChecks, ["positionId", "quantity", "stopPrice"]);
  assert.equal(observed.actual.positionId, "0");
  assert.equal(observed.actual.quantity, "90");
  assert.equal(result.expectedStops[0].expected.quantity, "100");
});

test("wrong stop type, side, status and trigger source remain visible on a found ID", () => {
  const result = evidence([{ ...stop, type: "LIMIT", side: "BUY", status: "FILLED",
    workingType: "CONTRACT_PRICE" }], { requireMarkPrice: true });
  assert.deepEqual(result.expectedStops[0].observations[0].failedChecks,
    ["type", "status", "side", "workingType"]);
});

test("original-only protection is recorded as verified staging, not stop_unverified", () => {
  const result = evidence([stop], {
    expectedStops: { original: expected.core }, verifiedOriginalStop: expected.core,
  });
  assert.equal(result.verdict, "original_stop_verified");
  assert.equal(result.originalStopVerified, true);
  assert.equal(result.verifiedStopCount, 0);
});

test("a verified original cannot hide a separately expected but missing runner", () => {
  const result = evidence([stop], {
    expectedStops: { original: expected.core, runner: { ...expected.core,
      orderId: "2105662972415795299" } },
    verifiedOriginalStop: expected.core,
  });
  assert.equal(result.verdict, "expected_stop_not_found_in_response");
});

test("unexpected order count is explicit even when the expected stop itself matches", () => {
  const result = evidence([stop, { ...stop, orderId: "2105662972415795202" }],
    { expectedOpenOrderCount: 1 });
  assert.equal(result.openOrderCountMatches, false);
  assert.equal(result.expectedOpenOrderCount, 1);
  assert.equal(result.verdict, "unexpected_open_order_count");
});

test("field getters, forged evidence, payloads and arbitrary enum values cannot leak", () => {
  const secret = "PRIVATE_TOKEN_DO_NOT_LOG";
  const result = evidence([{ ...stop, positionId: secret, origQty: secret, type: secret,
    headers: { authorization: secret }, response: secret }]);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(buildVstDiagnostic(new Error("dummy"), {
    stopEvidence: { verdict: secret, actual: { headers: secret } },
  }).stopEvidence, undefined);
  const hostile = {};
  Object.defineProperty(hostile, "orders", { get() { throw new Error(secret); } });
  assert.equal(JSON.stringify(buildVstStopEvidence(hostile)).includes(secret), false);
  assert.equal(Object.isFrozen(result.expectedStops[0].observations[0].actual), true);
});

test("decimal comparison follows the caller's actual tolerance and cannot log arbitrary results", () => {
  const rounded = { ...stop, origQty: "100.0000001" };
  const tolerant = evidence([rounded], { verifiedStops: { core: { verified: true } },
    compareDecimal: (a, b) => Math.abs(Number(a) - Number(b)) <= 0.000001 });
  assert.equal(tolerant.expectedStops[0].observations[0].checks.quantity, true);
  const malicious = evidence([stop], { compareDecimal: () => "PRIVATE_TOKEN" });
  assert.equal(JSON.stringify(malicious).includes("PRIVATE_TOKEN"), false);
  assert.equal(malicious.expectedStops[0].observations[0].checks.quantity, "unreadable");
});

test("a changed mismatch is logged immediately rather than suppressed under the same ref", () => {
  const originalWrite = process.stderr.write;
  const lines = [];
  process.stderr.write = (line) => { lines.push(String(line)); return true; };
  try {
    const context = { stage: "broker_read", operation: "read_position",
      check: "protective_stop", symbol: "AKTUSDT", sourceSignalId: "cab-signal-99001" };
    recordVstRefusal("stop_unverified", { ...context, stopEvidence: evidence([]) });
    recordVstRefusal("stop_unverified", { ...context, stopEvidence: evidence([{
      ...stop, positionId: "0",
    }]) });
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1].split("Bullet VST diagnostic: ")[1])
      .stopEvidence.verdict, "stop_fields_mismatch");
  } finally { process.stderr.write = originalWrite; }
});

test("worker checks expose exact leverage/quantity/stop mismatch without raw values", () => {
  const result = buildVstPositionCheckEvidence({
    leverage: { expected: 10, actual: 5, matches: false },
    coreQuantity: { expected: "100", actual: "90", matches: false },
    corePositionId: { expected: positionId, actual: "0", matches: false },
    runnerOrderId: { expected: stopId, actual: "PRIVATE_TOKEN", matches: false },
    headers: { expected: "PRIVATE_TOKEN", actual: "PRIVATE_TOKEN", matches: false },
  });
  assert.deepEqual(result.failedChecks,
    ["leverage", "corePositionId", "coreQuantity", "runnerOrderId"]);
  assert.equal(JSON.stringify(result).includes("PRIVATE_TOKEN"), false);
  assert.equal(buildVstDiagnostic(new Error("dummy"), { stopEvidence: result })
    .stopEvidence, result);
});

test("exact core identity and stored quantities cannot disappear behind successful minimum checks", () => {
  const result = buildVstPositionCheckEvidence({
    coreOrderId: { expected: stopId, actual: "2105662972415795999", matches: false },
    coreQuantity: { expected: "80", actual: "90", matches: true },
    coreExactQuantity: { expected: "80", actual: "90", matches: false },
    runnerExactQuantity: { expected: "20", actual: undefined, matches: false },
  });
  assert.deepEqual(result.failedChecks, ["coreOrderId", "coreExactQuantity", "runnerExactQuantity"]);
  assert.equal(result.checks.find((item) => item.field === "coreOrderId").actual,
    "2105662972415795999");
  assert.equal(result.checks.find((item) => item.field === "runnerExactQuantity").actualState,
    "missing_or_unreadable");
});