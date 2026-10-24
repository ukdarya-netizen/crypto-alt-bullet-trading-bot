import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildVstUnresolvedIntentDiagnostic,
  logVstUnresolvedIntentDiagnostic,
  unresolvedIntentDiagnosticSignature,
} from "../vst-intent-diagnostics.mjs";

test("safe unresolved intent diagnostics retain useful BingX cause without private payloads", () => {
  const diagnostic = buildVstUnresolvedIntentDiagnostic({
    sourceSignalId: "cab-signal-101",
    phase: "impulse-cancel_original_stop",
    clientOrderId: "vst-client-101",
    exchangeOrderId: "501",
    state: "unknown",
    request: { symbol: "AKTUSDT", operation: "cancel_original_stop" },
    outcome: {
      submissionError: "BingXLiveApiError",
      submissionErrorMessage: "private body apiKey=SECRET",
      submissionCode: 109400,
      submissionMethod: "GET",
      submissionEndpoint: "/openApi/swap/v2/trade/leverage",
      submissionHttpStatus: 200,
      submissionExchangeMessage: "timestamp is invalid",
      privateAccount: "not-for-logs",
    },
    lastAttemptAt: "2026-09-27T08:00:00.000Z",
  }, {
    symbolUnresolvedCount: 1, accountUnresolvedCount: 3,
    recoveryDeferredReason: "original_stop_cancel_position_changed",
    now: Date.parse("2026-09-27T08:02:00.000Z"),
  });
  assert.equal(diagnostic.symbol, "AKTUSDT");
  assert.equal(diagnostic.phase, "impulse-cancel_original_stop");
  assert.equal(diagnostic.state, "unknown");
  assert.equal(diagnostic.symbolUnresolvedCount, 1);
  assert.equal(diagnostic.accountUnresolvedCount, 3);
  assert.equal(diagnostic.originalDiagnostic.code, "109400");
  assert.equal(diagnostic.originalDiagnostic.providerReason, "timestamp_invalid");
  assert.equal(diagnostic.originalDiagnostic.endpoint, "/openApi/swap/v2/trade/leverage");
  assert.equal(diagnostic.recoveryDeferredReason, "original_stop_cancel_position_changed");
  assert.equal(diagnostic.lastAttemptAgeMs, 120_000);
  assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET|private body|not-for-logs/);
});

test("intent diagnostics reject hostile identifiers and log only bounded structure", () => {
  const diagnostic = buildVstUnresolvedIntentDiagnostic({
    sourceSignalId: "cab-signal-1\nSECRET",
    phase: "unsafe\nphase",
    clientOrderId: "client SECRET",
    exchangeOrderId: "id?secret=1",
    state: "unknown",
    request: {
      symbol: "AKTUSDT\nSECRET",
      operation: "op\nSECRET",
    },
    outcome: { reason: "bingx_vst_entry_history_fills_unverified" },
  }, { symbolUnresolvedCount: 1, accountUnresolvedCount: 3 });
  const output = [];
  logVstUnresolvedIntentDiagnostic(diagnostic, {
    warn: (line) => output.push(line),
  });
  assert.equal(diagnostic.sourceSignalId, undefined);
  assert.equal(diagnostic.phase, undefined);
  assert.equal(diagnostic.clientOrderId, undefined);
  assert.equal(diagnostic.exchangeOrderId, undefined);
  assert.equal(diagnostic.symbol, undefined);
  assert.equal(diagnostic.operation, undefined);
  assert.equal(diagnostic.originalDiagnostic.reviewedReason,
    "bingx_vst_entry_history_fills_unverified");
  assert.doesNotMatch(output.join(""), /SECRET/);
});

test("diagnostic signature changes on recovery-cause change but ignores attempt age", () => {
  const intent = {
    sourceSignalId: "cab-signal-1",
    phase: "impulse-runner-breakeven-abort-1790873680714",
    clientOrderId: "vst-client-1",
    state: "unknown",
    request: { symbol: "KIIUSDT", operation: "close_pre_runner_split" },
    outcome: { submissionCode: 109421 },
  };
  const first = buildVstUnresolvedIntentDiagnostic(intent, {
    symbolUnresolvedCount: 1, accountUnresolvedCount: 3,
    recoveryDeferredReason: "original_stop_cancel_position_changed",
    lastAttemptAt: 500, now: 1000,
  });
  const later = buildVstUnresolvedIntentDiagnostic(intent, {
    symbolUnresolvedCount: 1, accountUnresolvedCount: 3,
    recoveryDeferredReason: "original_stop_cancel_position_changed",
    lastAttemptAt: 1500, now: 2000,
  });
  const changed = buildVstUnresolvedIntentDiagnostic(intent, {
    symbolUnresolvedCount: 1, accountUnresolvedCount: 3,
    recoveryDeferredReason: "original_stop_cancel_stops_changed", now: 2000,
  });
  assert.equal(unresolvedIntentDiagnosticSignature(first),
    unresolvedIntentDiagnosticSignature(later));
  assert.equal(first.lastAttemptAgeMs, 500);
  assert.equal(later.lastAttemptAgeMs, 500);
  assert.notEqual(unresolvedIntentDiagnosticSignature(first),
    unresolvedIntentDiagnosticSignature(changed));
});