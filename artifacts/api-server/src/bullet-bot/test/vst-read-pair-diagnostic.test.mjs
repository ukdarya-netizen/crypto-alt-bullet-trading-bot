import assert from "node:assert/strict";
import test from "node:test";
import { buildVstDiagnostic } from "../vst-diagnostics.mjs";
import { buildVstUnresolvedIntentDiagnostic } from "../vst-intent-diagnostics.mjs";

test("mark-pair diagnostics retain reviewed transport-age evidence, never arbitrary fields", () => {
  const error = new Error("VST mark became stale before use");
  error.vstMarkEvidence = [{
    attempt: 0, predicate: "funding_timestamp_stale_at_pair_end",
    fundingRequestStartedAt: 100, tickerRequestStartedAt: 120,
    fundingTimestampAgeAtPairEndMs: 11000, fundingReadAgeAtPairEndMs: 11000,
    tickerReadAgeAtPairEndMs: 10980, readStartSeparationMs: 20,
    fundingAgeAtPairEndMs: 10000, tickerAgeAtPairEndMs: 11000,
    rawResponse: "PRIVATE",
  }];
  const diagnostic = buildVstDiagnostic(error);
  assert.equal(diagnostic.reason, "market_mark_unverified");
  assert.equal(diagnostic.markEvidence[0].readStartSeparationMs, 20);
  assert.equal(diagnostic.markEvidence[0].fundingReadAgeAtPairEndMs, 11000);
  assert.equal(diagnostic.markEvidence[0].tickerReadAgeAtPairEndMs, 10980);
  assert.equal(diagnostic.markEvidence[0].fundingTimestampAgeAtPairEndMs, 11000);
  assert.equal(diagnostic.markEvidence[0].rawResponse, undefined);
});

test("legacy missing submission provenance is not reported as a known internal exception", () => {
  const diagnostic = buildVstUnresolvedIntentDiagnostic({
    sourceSignalId: "cab-signal-1", clientOrderId: "vst-legacy",
    phase: "raise_stop-core-1", state: "unknown",
    request: { operation: "raise_stop", symbol: "VVVUSDT" },
    outcome: { reason: "exchange_state_not_verified" },
  }, { now: 1000 });
  assert.equal(diagnostic.originalDiagnostic.reason, "submission_provenance_unavailable");
});

test("a preserved submission error retains its reviewed cause", () => {
  const diagnostic = buildVstUnresolvedIntentDiagnostic({
    sourceSignalId: "cab-signal-2", clientOrderId: "vst-actual",
    phase: "raise_stop-core-2", state: "unknown",
    request: { operation: "raise_stop", symbol: "VVVUSDT" },
    outcome: { submissionError: "BingXLiveApiError",
      submissionErrorMessage: "bingx_vst_entry_history_fills_unverified" },
  }, { now: 1000 });
  assert.equal(diagnostic.originalDiagnostic.reason, "entry_fills_unverified");
});

test("initial caught-error provenance is recognized before reconciliation renames the fields", () => {
  const diagnostic = buildVstUnresolvedIntentDiagnostic({
    sourceSignalId: "cab-signal-3", clientOrderId: "vst-initial",
    phase: "raise_stop-core-3", state: "unknown",
    request: { operation: "raise_stop", symbol: "VVVUSDT" },
    outcome: { error: "BingXLiveApiError",
      errorMessage: "bingx_vst_entry_history_fills_unverified" },
  }, { now: 1000 });
  assert.equal(diagnostic.originalDiagnostic.errorClass, "BingXLiveApiError");
  assert.equal(diagnostic.originalDiagnostic.reason, "entry_fills_unverified");
});