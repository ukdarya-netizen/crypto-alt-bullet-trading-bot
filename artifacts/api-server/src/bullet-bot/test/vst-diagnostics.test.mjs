import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVstDiagnostic, recordVstDiagnostic, recordVstRefusal,
  withVstDiagnosticContext, instrumentVstApi, noteVstApiDiagnosticRequest,
  attachVstResultDiagnostic, getVstResultDiagnosticRef,
} from "../vst-diagnostics.mjs";
import { safeTickErrorSummary } from "../vst-tick-watchdog.mjs";
import { BingXLiveApiError, createBingXLiveApi } from "../bingx-live-api.mjs";

const tickId = "vst-tick-00000000-0000-4000-a000-000000000001";
test("mark corroboration diagnostics retain bounded numeric evidence, never provider payloads", () => {
  const error = new BingXLiveApiError("VST mark is not corroborated by a fresh quote");
  error.vstMarkEvidence = [
    {
      attempt: 0, predicate: "mark_above_ask_buffer", markPrice: 11.2,
      bid: 11.139, ask: 11.168, upperBound: 11.179168,
      fundingResponseReceivedAt: 1790945060799, tickerObservedAt: 1790945061353,
      exchangeTimestampStatus: "missing", exchangeMarkTimestamp: null,
      rawResponse: { token: "private-payload" }, headers: "private-headers",
      password: "private-password",
      positionMarkReadStatus: "mismatch", positionMarkPrice: 11.3,
      positionMarkErrorCode: 100001,
    },
    { attempt: 1, predicate: "mark_above_ask_buffer", markPrice: Infinity, ask: 11.17 },
    { predicate: "mark_below_bid_buffer", markPrice: 10 },
  ];
  const diagnostic = buildVstDiagnostic(error);
  assert.equal(diagnostic.reason, "market_mark_unverified");
  assert.equal(diagnostic.markEvidence.length, 2);
  assert.equal(diagnostic.markEvidence[0].markPrice, 11.2);
  assert.equal(diagnostic.markEvidence[0].upperBound, 11.179168);
  assert.equal(diagnostic.markEvidence[0].exchangeTimestampStatus, "missing");
  assert.equal(diagnostic.markEvidence[0].positionMarkReadStatus, "mismatch");
  assert.equal(diagnostic.markEvidence[0].positionMarkPrice, 11.3);
  assert.equal(diagnostic.markEvidence[0].positionMarkErrorCode, 100001);
  assert.equal(Object.hasOwn(diagnostic.markEvidence[1], "markPrice"), false);
  assert.equal(JSON.stringify(diagnostic).includes("private-"), false);
  error.vstMarkEvidence = [{ predicate: "unreviewed-private-payload", markPrice: 11.2 }];
  assert.equal(buildVstDiagnostic(error).markEvidence, undefined);
});

test("non-increasing stop rejection is diagnosed without claiming a submission or fill", () => {
  const diagnostic = buildVstDiagnostic(
    new BingXLiveApiError("VST protective stop upgrades may only raise the stop"),
  );
  assert.equal(diagnostic.reason, "stop_upgrade_not_increasing");
  assert.equal(diagnostic.mutationRequestSent, undefined);
});

async function capture(callback) {
  const original = process.stderr.write;
  const lines = [];
  process.stderr.write = (line) => { lines.push(String(line)); return true; };
  try {
    const result = await callback();
    return { result, text: lines.join(""),
      diagnostics: lines.flatMap((line) => line.startsWith("Bullet VST diagnostic: ")
        ? [JSON.parse(line.slice("Bullet VST diagnostic: ".length))] : []) };
  } finally { process.stderr.write = original; }
}

test("diagnostic ref stays compatible with existing Telegram tick references", () => {
  const error = new BingXLiveApiError("timestamp failure", {
    code: 109400, method: "GET", endpoint: "/openApi/swap/v2/trade/leverage",
    httpStatus: 400, transportStage: "exchange_response",
    exchangeMessage: "timestamp is invalid",
  });
  const diagnostic = buildVstDiagnostic(error);
  assert.match(safeTickErrorSummary(error), new RegExp(`ref:${diagnostic.ref}`));
  assert.equal(diagnostic.code, "109400");
  assert.equal(diagnostic.providerReason, "timestamp_invalid");
  assert.equal(diagnostic.method, "GET");
  assert.equal(diagnostic.endpoint, "/openApi/swap/v2/trade/leverage");
  assert.equal(diagnostic.transportStage, "exchange_response");
  assert.equal(diagnostic.httpStatus, 400);
});

test("raw messages, provider payloads, queries, arbitrary names and params never serialize", () => {
  const secret = "PRIVATE_TOKEN_SHOULD_NEVER_APPEAR";
  const error = new Error(`${secret} signature=other_secret`);
  Object.assign(error, {
    name: secret, code: secret, method: secret, exchangeMessage: secret,
    endpoint: `/openApi/swap/v2/trade/order?signature=${secret}`,
    httpStatus: secret, transportStage: secret, accountId: secret,
    params: { apiKey: secret }, response: { msg: secret }, headers: { authorization: secret },
    preSignReason: secret,
    stack: `Error: ${secret}\n    at ${secret} (/private/${secret}.mjs:1:2)\n` +
      `    at secret (/private/vst-worker.mjs?signature=${secret}:3:4)`,
  });
  const text = JSON.stringify(buildVstDiagnostic(error, {
    symbol: secret, sourceSignalId: secret, stage: secret, operation: secret,
    apiMethod: secret, tickId: secret, check: secret, password: secret,
  }));
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes("other_secret"), false);
  assert.equal(text.includes("signature"), false);
  assert.equal(text.includes("params"), false);
  assert.equal(text.includes("accountId"), false);
});

test("unknown but path-shaped endpoints are omitted rather than leaking embedded values", () => {
  const error = Object.assign(new Error("unsafe endpoint"), {
    endpoint: "/openApi/PRIVATE_TOKEN_SHOULD_NEVER_APPEAR", method: "GET",
  });
  assert.equal(buildVstDiagnostic(error).endpoint, undefined);
});

test("response validation identifies only reviewed field names and safe code location", () => {
  const error = new BingXLiveApiError("BingX returned invalid position isolated margin");
  error.stack = "BingXLiveApiError: PRIVATE_TOKEN\n" +
    "    at strictNumeric (/home/runner/workspace/artifacts/api-server/src/bullet-bot/bingx-live-api.mjs:286:11)";
  const diagnostic = buildVstDiagnostic(error);
  assert.equal(diagnostic.reason, "invalid_exchange_response");
  assert.equal(diagnostic.validationField, "position isolated margin");
  assert.equal(diagnostic.origin, "bingx-live-api.mjs:286:11");
  assert.equal(JSON.stringify(diagnostic).includes("PRIVATE_TOKEN"), false);
  const unreviewed = new BingXLiveApiError("BingX returned invalid PRIVATE_TOKEN");
  assert.equal(buildVstDiagnostic(unreviewed).validationField, undefined);
});

test("symbol-bearing marginType validation gives a field, not raw response data", () => {
  const error = new BingXLiveApiError("BingX returned invalid margin type for AVAX-USDT");
  assert.equal(buildVstDiagnostic(error).validationField, "marginType");
});

test("network request, response body read and parse stages remain distinguishable", () => {
  for (const stage of ["network_request", "network_response_read", "response_parse"]) {
    const diagnostic = buildVstDiagnostic(Object.assign(new Error(`failed ${stage}`),
      { transportStage: stage }));
    assert.equal(diagnostic.transportStage, stage);
    assert.equal(diagnostic.reason, "exchange_transport_error");
  }
});

test("async context carries tick/symbol/signal while parallel symbols remain isolated", async () => {
  const observations = await withVstDiagnosticContext({ tickId, stage: "positionManagement" },
    () => Promise.all(["AVAXUSDT", "EPICUSDT"].map((symbol) =>
      withVstDiagnosticContext({ symbol, sourceSignalId: "cab-signal-16018" },
        async () => {
          await Promise.resolve();
          return buildVstDiagnostic(new Error("context-only"));
        }))));
  assert.deepEqual(observations.map((item) => item.symbol), ["AVAXUSDT", "EPICUSDT"]);
  assert.ok(observations.every((item) => item.tickId === tickId &&
    item.stage === "positionManagement" && item.sourceSignalId === "cab-signal-16018"));
  assert.equal(buildVstDiagnostic(new Error("outside-context")).tickId, undefined);
});

test("logger failure cannot replace the original exception or introduce a retry", async () => {
  const originalWrite = process.stderr.write;
  const error = Object.freeze(new Error("exact_original_exception"));
  let calls = 0;
  const api = instrumentVstApi({ getPositions: async () => { calls += 1; throw error; } }, "vst");
  process.stderr.write = () => { throw new Error("logging sink failed"); };
  try {
    await assert.rejects(api.getPositions("AVAXUSDT"), (actual) => actual === error);
    assert.equal(calls, 1);
    assert.equal(recordVstDiagnostic(error).ref.length, 12);
  } finally { process.stderr.write = originalWrite; }
});

test("instrumentation preserves capabilities and result identity; mainnet is untouched", async () => {
  const position = [{ positionAmt: "1" }];
  const original = { supportsCompleteFillHistory: true, getPositions: async () => position };
  assert.equal(instrumentVstApi(original, "mainnet"), original);
  const instrumented = instrumentVstApi(original, "vst");
  assert.equal(instrumented.supportsCompleteFillHistory, true);
  assert.equal(await instrumented.getPositions("AVAXUSDT"), position);
});

test("repeated same failures are bounded, counted, but a new signal is logged independently", async () => {
  const originalNow = Date.now;
  let now = 2_000_000_000_000;
  Date.now = () => now;
  try {
    const { diagnostics } = await capture(() => {
      const error = new Error("unique-dedup-test");
      const context = { stage: "position_read", symbol: "AVAXUSDT",
        sourceSignalId: "cab-signal-16018" };
      recordVstDiagnostic(error, context);
      recordVstDiagnostic(error, context);
      recordVstDiagnostic(error, context);
      recordVstDiagnostic(error, { ...context, sourceSignalId: "cab-signal-16019" });
      now += 60_001;
      recordVstDiagnostic(error, context);
    });
    assert.equal(diagnostics.length, 3);
    assert.equal(diagnostics[2].suppressedRepeats, 2);
    assert.equal(diagnostics[1].sourceSignalId, "cab-signal-16019");
  } finally { Date.now = originalNow; }
});

test("proof refusals have stable refs and explicit checks, without claiming an API transport", async () => {
  const { result } = await capture(() =>
    recordVstRefusal("entry_fills_unverified", {
      stage: "entry_proof", symbol: "REUSDT", check: "fills",
    }));
  assert.equal(result.reason, "entry_fills_unverified");
  assert.equal(result.check, "fills");
  assert.equal(result.method, undefined);
  assert.equal(result.transportStage, undefined);
  const { result: second } = await capture(() =>
    recordVstRefusal("entry_fills_unverified", { stage: "entry_proof", check: "fills" }));
  assert.equal(result.ref, second.ref);
  const { result: unknown } = await capture(() => recordVstRefusal("PRIVATE_TOKEN"));
  assert.equal(unknown.reason, "unclassified_refusal");
  assert.equal(JSON.stringify(unknown).includes("PRIVATE_TOKEN"), false);
});

test("bad error getters cannot break diagnostics", () => {
  const error = {};
  for (const key of ["name", "message", "stack", "code", "endpoint"]) {
    Object.defineProperty(error, key, { get() { throw new Error("unsafe getter"); } });
  }
  assert.match(buildVstDiagnostic(error).ref, /^[a-f0-9]{12}$/);
});

test("native GET validator logs request context after the successful response, no new requests", async () => {
  const calls = [];
  const api = createBingXLiveApi({
    environment: "vst", requestPacer: { waitForSlot: async () => {}, deferFor: () => {} },
    credentials: () => ({ key: "PRIVATE_DUMMY_KEY", secret: "PRIVATE_DUMMY_SECRET" }),
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), method: options.method });
      return new Response(JSON.stringify({ code: 0, data: { marginType: "PRIVATE_RESPONSE" } }));
    },
  });
  const { diagnostics, text } = await capture(() =>
    withVstDiagnosticContext({ tickId, stage: "positionManagement", sourceSignalId: "cab-signal-16018" },
      () => assert.rejects(api.getMarginType("AVAXUSDT"), BingXLiveApiError)));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].apiMethod, "getMarginType");
  assert.equal(diagnostics[0].requestEndpoint, "/openApi/swap/v2/trade/marginType");
  assert.equal(diagnostics[0].requestMethod, "GET");
  assert.equal(diagnostics[0].tickId, tickId);
  assert.equal(diagnostics[0].symbol, "AVAXUSDT");
  assert.equal(diagnostics[0].validationField, "marginType");
  assert.equal(diagnostics[0].stage, "positionManagement");
  assert.equal(text.includes("PRIVATE_"), false);
  assert.equal(text.includes("signature"), false);
});

test("request context cannot survive into a different API method that did not request anything", async () => {
  const api = instrumentVstApi({
    getPositions: async () => {
      noteVstApiDiagnosticRequest("GET", "/openApi/swap/v2/user/positions");
      throw new Error("first API context test");
    },
    getBalance: async () => { throw new Error("second API context test"); },
  }, "vst");
  const { diagnostics } = await capture(async () => {
    await assert.rejects(api.getPositions("AVAXUSDT"));
    await assert.rejects(api.getBalance());
  });
  assert.equal(diagnostics[0].requestEndpoint, "/openApi/swap/v2/user/positions");
  assert.equal(diagnostics[1].requestEndpoint, undefined);
});

test("mutation provenance is reported only as supplied, not inferred from a GET failure", () => {
  const error = new BingXLiveApiError("preliminary GET failed", { method: "GET" });
  assert.equal(buildVstDiagnostic(error).mutationRequestSent, undefined);
  error.mutationProvenance = Object.freeze({
    operation: "cancel_original_stop", mutationMethod: "DELETE",
    mutationEndpoint: "/openApi/swap/v2/trade/order", mutationRequestSent: false,
    phase: "pre_mutation_read",
  });
  assert.equal(buildVstDiagnostic(error).mutationRequestSent, false);
  assert.equal(buildVstDiagnostic(error).mutationPhase, "pre_mutation_read");
});

test("result diagnostics never change broker DTO JSON, equality, or frozen objects", () => {
  const result = Object.freeze({ verified: false, status: "unknown" });
  const before = JSON.stringify(result);
  const diagnostic = buildVstDiagnostic(new Error("result-side-channel-test"));
  assert.equal(attachVstResultDiagnostic(result, diagnostic), result);
  assert.equal(getVstResultDiagnosticRef(result), diagnostic.ref);
  assert.equal(JSON.stringify(result), before);
  assert.deepEqual(result, { verified: false, status: "unknown" });
  assert.deepEqual(Object.keys(result), ["verified", "status"]);
  assert.equal(getVstResultDiagnosticRef(null), undefined);
});

test("multi-endpoint API routines do not pretend the last request caused a local validation error", async () => {
  const api = instrumentVstApi({ preflight: async () => {
    noteVstApiDiagnosticRequest("GET", "/openApi/swap/v2/user/positions");
    noteVstApiDiagnosticRequest("GET", "/openApi/swap/v2/trade/leverage");
    throw new BingXLiveApiError("BingX returned invalid position quantity");
  } }, "vst");
  const { diagnostics } = await capture(() => assert.rejects(api.preflight("AVAXUSDT")));
  assert.equal(diagnostics[0].requestContextAmbiguous, true);
  assert.equal(diagnostics[0].requestEndpoint, undefined);
  assert.equal(diagnostics[0].method, undefined);
  assert.equal(diagnostics[0].apiMethod, "preflight");
  assert.equal(diagnostics[0].validationField, "position quantity");
});