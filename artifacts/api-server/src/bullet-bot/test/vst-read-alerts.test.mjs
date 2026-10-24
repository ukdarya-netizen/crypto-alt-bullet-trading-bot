import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVstDiagnostic, recordVstDiagnostic, instrumentVstApi,
  noteVstApiDiagnosticRequest, withVstDiagnosticContext, vstReadIncidentKey,
} from "../vst-diagnostics.mjs";
import { createVstReadAlertAggregator, createVstReadRecoveryTracker } from "../vst-read-alerts.mjs";
import { formatVstReadIncidentAlert, createVstBlockedAlerter } from "../vst-telegram.mjs";
import { BingXLiveApiError } from "../bingx-live-api.mjs";

const diagnostic = (symbol = "BTCUSDT", overrides = {}) => ({
  ...buildVstDiagnostic(new BingXLiveApiError(
    "BingX returned invalid margin type for " + symbol.replace("USDT", "-USDT"),
    { method: "GET", endpoint: "/openApi/swap/v2/user/positions" },
  ), {
    stage: "positionManagement", operation: "read_position",
    apiMethod: "getPositions", check: "position_row", symbol,
  }),
  ...overrides,
});
const issue = (symbol, blockedForMs = 0, overrides = {}) => {
  const d = diagnostic(symbol);
  return { reason: "managed_position_read_unavailable", scope: "symbol",
    operation: "read_position",
    sourceSignalId: symbol + "-signal", symbol, blockedForMs,
    diagnosticRef: d.ref, diagnostic: d, ...overrides };
};
function fixture(options = {}) {
  let time = 0;
  const alerts = [];
  const aggregator = createVstReadAlertAggregator({
    send: async (info) => { alerts.push(info); },
    now: () => time, blockedAfterMs: 100, repeatAfterMs: 1000, ...options,
  });
  return { aggregator, alerts, time: (value) => { time = value; } };
}

test("brief successes do not clear an incident; recovery needs three fresh observations over two minutes", () => {
  let at = 0;
  const tracker = createVstReadRecoveryTracker({ now: () => at });
  tracker.failed("BTW");
  assert.equal(tracker.recovered("BTW"), false);
  assert.equal(tracker.recovered("BTW"), false, "one tick cannot count twice");
  at = 60_000;
  assert.equal(tracker.recovered("BTW"), false);
  tracker.failed("BTW");
  at = 120_000;
  assert.equal(tracker.recovered("BTW"), false);
  at = 180_000;
  assert.equal(tracker.recovered("BTW"), false);
  at = 240_000;
  assert.equal(tracker.recovered("BTW"), true);
  assert.equal(tracker.recovered("BTW"), true);
});

test("skipped intervals and backwards clocks cannot manufacture stable read recovery", () => {
  let at = 0;
  const tracker = createVstReadRecoveryTracker({ now: () => at });
  tracker.failed("BTW");
  assert.equal(tracker.recovered("BTW"), false);
  at = 600_000;
  assert.equal(tracker.recovered("BTW"), false);
  at = 660_000;
  assert.equal(tracker.recovered("BTW"), false);
  at = 1;
  assert.equal(tracker.recovered("BTW"), false);
  at = NaN;
  assert.equal(tracker.recovered("BTW"), false);
  tracker.forget("BTW");
  at = 720_000;
  assert.equal(tracker.recovered("BTW"), true, "confirmed closed/removed rows can be forgotten");
});

test("same reviewed cause ignores symbol-dependent exception text/ref", () => {
  const btc = issue("BTCUSDT");
  const eth = issue("ETHUSDT");
  assert.notEqual(btc.diagnosticRef, eth.diagnosticRef);
  assert.equal(vstReadIncidentKey(btc.diagnostic, btc),
    vstReadIncidentKey(eth.diagnostic, eth));
  assert.ok(vstReadIncidentKey(btc.diagnostic, btc));
});

test("first warning batches symbols, counts every observation, periodically summarizes and recovers", async () => {
  const f = fixture();
  await f.aggregator.report([issue("BTCUSDT"), issue("ETHUSDT")]);
  assert.equal(f.alerts.length, 0);
  f.time(100);
  await f.aggregator.report([issue("BTCUSDT", 100), issue("ETHUSDT", 100)]);
  assert.equal(f.alerts.length, 1);
  assert.equal(f.alerts[0].incidentStatus, "first");
  assert.deepEqual(f.alerts[0].symbols, ["BTCUSDT", "ETHUSDT"]);
  assert.equal(f.alerts[0].occurrences, 4);
  f.time(300);
  await f.aggregator.report([issue("BTCUSDT", 300), issue("ETHUSDT", 300), issue("SOLUSDT", 0)]);
  assert.equal(f.alerts.length, 1);
  f.time(1100);
  await f.aggregator.report([issue("ETHUSDT", 1100), issue("SOLUSDT", 800)], ["BTCUSDT-signal"]);
  assert.equal(f.alerts[1].incidentStatus, "summary");
  assert.deepEqual(f.alerts[1].symbols, ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  assert.deepEqual(f.alerts[1].activeSymbols, ["ETHUSDT", "SOLUSDT"]);
  assert.equal(f.alerts[1].blockedForMs, 1100);
  assert.equal(f.alerts[1].occurrences, 9);
  await f.aggregator.report([]); // No observations, NOT a recovery.
  assert.equal(f.alerts.length, 2);
  f.time(1200);
  await f.aggregator.report([], ["ETHUSDT-signal", "SOLUSDT-signal"]);
  assert.equal(f.alerts[2].incidentStatus, "recovered");
  await f.aggregator.report([], ["ETHUSDT-signal"]);
  assert.equal(f.alerts.length, 3);
  f.time(1400);
  await f.aggregator.report([issue("BTCUSDT", 100)]);
  assert.equal(f.alerts[3].incidentStatus, "first");
});

test("new cause is visible at existing threshold even while another cause is throttled", async () => {
  const f = fixture();
  f.time(100);
  await f.aggregator.report([issue("BTCUSDT", 100)]);
  f.time(101);
  await f.aggregator.report([
    issue("BTCUSDT", 101),
    issue("ETHUSDT", 100, { diagnostic: diagnostic("ETHUSDT", {
      validationField: "position quantity",
    }) }),
  ]);
  assert.equal(f.alerts.length, 2);
  assert.equal(f.alerts[1].incidentStatus, "first");
  assert.deepEqual(f.alerts[1].symbols, ["ETHUSDT"]);
});

test("class, stage, API, endpoint, check, field and transport distinguish causes", () => {
  const base = issue("BTCUSDT");
  const key = vstReadIncidentKey(base.diagnostic, base);
  const variants = [
    { errorClass: "TypeError" },
    { check: "market_mark" },
    { operation: "read_market_mark" },
    { validationField: "initialMargin" },
    { apiMethod: "getLeverage", endpoint: "/openApi/swap/v2/trade/leverage",
      validationField: "long leverage" },
    { apiMethod: "getMarginType", endpoint: "/openApi/swap/v2/trade/marginType" },
    { reason: "exchange_transport_error", validationField: undefined,
      transportStage: "network_request" },
    { reason: "exchange_transport_error", validationField: undefined,
      transportStage: "network_response_read" },
  ];
  for (const variant of variants) {
    const other = vstReadIncidentKey({ ...base.diagnostic, ...variant }, base);
    assert.ok(other, JSON.stringify(variant));
    assert.notEqual(other, key);
  }
  assert.equal(vstReadIncidentKey({ ...base.diagnostic, stage: "reconciliation" }, base), null);
});

test("missing or generic context, shared provider codes, mutation and protection risks never group", async () => {
  const f = fixture();
  const base = issue("BTCUSDT", 100);
  for (const field of ["stage", "operation", "check", "apiMethod",
    "endpoint", "method", "errorClass", "validationField", "symbol", "ref"]) {
    const d = { ...base.diagnostic };
    delete d[field];
    assert.equal(vstReadIncidentKey(d, base), null, field);
  }
  for (const d of [
    undefined, {}, { ref: base.diagnosticRef }, { code: "109400" },
    diagnostic("BTCUSDT", { reason: "exchange_provider_error", code: "109400" }),
    diagnostic("BTCUSDT", { requestContextAmbiguous: true }),
    diagnostic("BTCUSDT", { method: "POST" }),
    diagnostic("BTCUSDT", { requestMethod: "DELETE" }),
    diagnostic("BTCUSDT", { mutationPhase: "pre_mutation_read", mutationRequestSent: false }),
    diagnostic("BTCUSDT", { apiMethod: "cancelVstOrder" }),
    diagnostic("BTCUSDT", { check: "protective_stop" }),
    diagnostic("BTCUSDT", { validationField: "order ID" }),
    diagnostic("BTCUSDT", { validationField: "stop price" }),
    diagnostic("BTCUSDT", { reason: "stop_unverified" }),
    diagnostic("BTCUSDT", { reason: "exchange_transport_error", transportStage: "unknown" }),
    diagnostic("BTCUSDT", { errorClassReviewed: false }),
    diagnostic("ETHUSDT"),
  ]) {
    assert.equal((await f.aggregator.report([{ ...base, diagnostic: d }])).size, 0);
  }
  for (const reason of ["unresolved_vst_order_intents", "exchange_position_or_leverage_mismatch",
    "entry_verification_abandoned_confirmed_open_unprotected", "vst_worker_error"]) {
    assert.equal((await f.aggregator.report([{ ...base, reason }])).size, 0);
  }
  assert.equal((await f.aggregator.report([{ ...base, scope: "account" }])).size, 0);
  for (const operation of ["entry", "cancel_original_stop", "margin_top_up", "split_runner_stop"]) {
    assert.equal((await f.aggregator.report([{ ...base, operation }])).size, 0);
  }
  assert.equal(f.alerts.length, 0);
});

test("cause changes and missing context do not claim recovery; independent path is returned", async () => {
  const f = fixture();
  f.time(100);
  await f.aggregator.report([issue("BTCUSDT", 100)]);
  const handled = await f.aggregator.report([issue("BTCUSDT", 100, { diagnostic: undefined })]);
  assert.equal(handled.size, 0);
  assert.equal(f.alerts[1].incidentStatus, "changed");
  assert.doesNotMatch(formatVstReadIncidentAlert(f.alerts[1]), /чтение восстановлено/);
});

test("notification failure is retried without dropping the group; capacity fails open", async () => {
  let attempts = 0;
  const f = fixture({ maxGroups: 1, send: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("offline delivery failure");
  } });
  f.time(100);
  const other = issue("ETHUSDT", 100, { diagnostic: diagnostic("ETHUSDT", {
    validationField: "position quantity",
  }) });
  assert.deepEqual([...(await f.aggregator.report([issue("BTCUSDT", 100), other]))],
    ["BTCUSDT-signal"]);
  await f.aggregator.report([issue("BTCUSDT", 100)]);
  assert.equal(attempts, 2);
});

test("API diagnostic survives an outer worker catch without changing error or DTO", async () => {
  const error = new BingXLiveApiError("BingX returned invalid position margin");
  const before = { ...error };
  const api = instrumentVstApi({ getPositions: async () => {
    noteVstApiDiagnosticRequest("GET", "/openApi/swap/v2/user/positions");
    throw error;
  } }, "vst");
  await withVstDiagnosticContext({
    stage: "positionManagement", operation: "read_position", check: "position_row",
  }, async () => {
    await assert.rejects(api.getPositions("BTCUSDT"), (e) => e === error);
    const d = recordVstDiagnostic(error, { stage: "positionManagement",
      operation: "read_position", check: "position_row", symbol: "BTCUSDT" });
    assert.equal(d.apiMethod, "getPositions");
    assert.equal(d.requestEndpoint, "/openApi/swap/v2/user/positions");
    assert.ok(vstReadIncidentKey(d, issue("BTCUSDT")));
    assert.deepEqual({ ...error }, before);
  });
});

test("same ref at different API contexts is never used as a grouping key", () => {
  const d = diagnostic();
  const other = { ...d, apiMethod: "getMarginType",
    endpoint: "/openApi/swap/v2/trade/marginType" };
  assert.equal(d.ref, other.ref);
  assert.notEqual(vstReadIncidentKey(d, issue("BTCUSDT")),
    vstReadIncidentKey(other, issue("BTCUSDT")));
});

test("Telegram summary includes safe log refs and cause, withholds unreviewed input and chunks large lists", async () => {
  const f = fixture();
  f.time(100);
  await f.aggregator.report([issue("BTCUSDT", 100), issue("ETHUSDT", 100)]);
  const text = formatVstReadIncidentAlert(f.alerts[0]);
  assert.match(text, /BTCUSDT, ETHUSDT/);
  assert.match(text, /поле: marginType/);
  assert.match(text, /ref:[a-f0-9]{12}/);
  assert.doesNotMatch(formatVstReadIncidentAlert({
    symbols: ["private-token"], activeSymbols: ["private-token"],
    diagnostic: { apiMethod: "private-token" }, diagnosticRefs: ["private-token"],
  }), /private-token/);
  const messages = [];
  const alerter = createVstBlockedAlerter({
    token: "123:offline", chatId: "123",
    fetcher: async (_url, init) => {
      messages.push(JSON.parse(init.body).text);
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  const big = { ...f.alerts[0], symbols: Array.from({ length: 600 }, (_, i) => `SYMBOL${i}USDT`) };
  await alerter.send(big);
  assert.ok(messages.length > 1);
  assert.ok(messages.every((m) => m.length <= 3900));
  assert.equal(messages.join(""), formatVstReadIncidentAlert(big));
});