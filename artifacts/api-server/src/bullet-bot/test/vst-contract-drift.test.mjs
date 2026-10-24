import assert from "node:assert/strict";
import test from "node:test";
import { createVstContractDriftMonitor, summarizeVstContract } from "../vst-contract-drift.mjs";
import { createBingXLiveApi } from "../bingx-live-api.mjs";
import { nativeContractResponses } from "./fixtures/native-contract-responses.mjs";

const positionPath = "/openApi/swap/v2/user/positions";
const historyPath = "/openApi/swap/v2/trade/fillHistory";
const settle = () => new Promise(resolve => setImmediate(resolve));
const bad = { positions: [{ secret: "never retained" }] };

test("all six reviewed native shapes and documented accepted wrappers are quiet", () => {
  for (const [path, data, params] of nativeContractResponses()) {
    assert.deepEqual(summarizeVstContract(path, data, params).issues, [], path);
  }
  const responses = nativeContractResponses();
  assert.deepEqual(summarizeVstContract(responses[2][0], responses[2][1].orders).issues, []);
  assert.deepEqual(summarizeVstContract(responses[3][0], { orders: responses[3][1].fill_orders }).issues, []);
  const margin = responses[5];
  assert.deepEqual(summarizeVstContract(margin[0],
    { list: margin[1].records, total: "1" }, margin[2]).issues, []);
});

test("missing aliases, type/alias conflicts and unsupported wrappers are drift", () => {
  const [path, data] = nativeContractResponses()[0];
  const row = data[0];
  assert.ok(summarizeVstContract(path, [{ ...row, positionId: undefined, renamedId: row.positionId }])
    .issues.includes("missing:positionId"));
  assert.ok(summarizeVstContract(path, [{ ...row, positionID: "456" }])
    .issues.includes("alias_conflict:positionId"));
  assert.ok(summarizeVstContract(path, [{ ...row, symbol: {} }]).issues.includes("type:symbol"));
  assert.ok(summarizeVstContract(path, { positions: data }).issues.includes("container_invalid"));
  assert.ok(summarizeVstContract(path, [{ ...row, positionId: Number.MAX_SAFE_INTEGER + 1 }])
    .issues.includes("unsafe_identifier:positionId"));
});

test("complete history detects changed envelope, pagination and terminal/count contracts", () => {
  const [, data, params] = nativeContractResponses()[4];
  assert.ok(summarizeVstContract(historyPath, { ...data, total: "1" }, params)
    .issues.includes("total_invalid"));
  assert.ok(summarizeVstContract(historyPath, { ...data, nextCursor: "secret" }, params)
    .issues.includes("unreviewed_pagination"));
  assert.ok(summarizeVstContract(historyPath, { ...data, userSuppliedKey: "secret" }, params)
    .issues.includes("unreviewed_envelope"));
  assert.ok(summarizeVstContract(historyPath, { ...data, total: 2 }, params)
    .issues.includes("page_count_mismatch"));
  assert.ok(summarizeVstContract(historyPath, data, { ...params, pageIndex: 2 })
    .issues.includes("terminal_not_empty"));
  assert.deepEqual(summarizeVstContract(historyPath,
    { fill_history_orders: [], total: 0 }, { pageIndex: 2 }).issues, []);
  const margin = nativeContractResponses()[5];
  assert.ok(summarizeVstContract(margin[0], { ...margin[1], total: 101 }, margin[2])
    .issues.includes("page_count_mismatch"));
});

test("summaries are bounded value-free allowlists, never provider key names or data", () => {
  const [path, data] = nativeContractResponses()[0];
  const row = { ...data[0], injectedSensitiveKey: "credential-secret", apiKey: "api-secret" };
  const summary = summarizeVstContract(path, Array.from({ length: 2000 }, () => row));
  const serialized = JSON.stringify(summary);
  assert.equal(summary.coverage, "sampled");
  for (const forbidden of ["injectedSensitiveKey", "credential-secret", "apiKey", "api-secret",
    row.positionId, row.symbol, row.avgPrice]) assert.ok(!serialized.includes(forbidden), forbidden);
  assert.ok(serialized.length < 3000);
  assert.equal(summarizeVstContract("/unreviewed", row), null);
});

test("only sustained observations alert; fingerprints dedupe, recovery/gaps reset", async () => {
  let now = 1_000_000;
  const alerts = [];
  const monitor = createVstContractDriftMonitor({ clock: () => now, onAlert: r => alerts.push(r) });
  monitor.observe(positionPath, bad);
  for (let n = 0; n < 50; n++) monitor.observe(positionPath, bad);
  await settle();
  assert.equal(alerts.length, 0);
  now += 60_000; monitor.observe(positionPath, bad);
  now += 240_000; monitor.observe(positionPath, bad);
  await settle();
  assert.equal(alerts.length, 1);
  now += 300_000; monitor.observe(positionPath, bad);
  await settle();
  assert.equal(alerts.length, 1);
  monitor.observe(positionPath, []);
  now += 60_000; monitor.observe(positionPath, bad);
  now += 31 * 60_000; monitor.observe(positionPath, bad);
  await settle();
  assert.equal(alerts.length, 1);
  // New drift fingerprint qualifies independently.
  const changed = [{ symbol: {} }];
  monitor.observe(positionPath, changed);
  now += 60_000; monitor.observe(positionPath, changed);
  now += 240_000; monitor.observe(positionPath, changed);
  await settle();
  assert.equal(alerts.length, 2);
});

test("healthy terminal page does not hide first-page drift; cold restart requalifies", async () => {
  let now = 1_000_000;
  const alerts = [];
  const opts = { clock: () => now, onAlert: r => alerts.push(r) };
  const monitor = createVstContractDriftMonitor(opts);
  for (const delta of [0, 60_000, 240_000]) {
    now += delta;
    monitor.observe(historyPath, { orders: [], total: 0 }, { pageIndex: 1 });
    monitor.observe(historyPath, { fill_history_orders: [], total: 0 }, { pageIndex: 2 });
  }
  await settle();
  assert.equal(alerts.length, 1);
  createVstContractDriftMonitor(opts).observe(historyPath, { orders: [] }, { pageIndex: 1 });
  await settle();
  assert.equal(alerts.length, 1);
});

test("failed delivery retries on later qualified reads, never every GET", async () => {
  let now = 1_000_000;
  let calls = 0;
  const monitor = createVstContractDriftMonitor({
    clock: () => now, onAlert: () => { calls++; throw new Error("sensitive"); },
  });
  for (const delta of [0, 60_000, 240_000]) {
    now += delta; monitor.observe(positionPath, bad);
  }
  await settle();
  now += 60_000; monitor.observe(positionPath, bad);
  await settle();
  assert.equal(calls, 1);
  now += 240_000; monitor.observe(positionPath, bad);
  await settle();
  assert.equal(calls, 2);
});

test("native hook is GET/VST/success-only, no new reads, refusal remains strict", async () => {
  let observations = 0;
  const methods = [];
  const api = createBingXLiveApi({
    environment: "vst", credentials: () => ({ key: "fake-key", secret: "fake-secret" }),
    requestPacer: { waitForSlot: async () => {}, deferFor: () => {} }, sleep: async () => {},
    contractDriftMonitor: { observe(path, data) {
      observations++; assert.equal(path, positionPath); assert.deepEqual(data, bad);
      throw new Error("observability failed");
    } },
    fetchImpl: async (_url, options) => {
      methods.push(options.method);
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: bad }) };
    },
  });
  await assert.rejects(api.getPositions("BTCUSDT"), /invalid positions data/);
  assert.equal(observations, 1);
  assert.deepEqual(methods, ["GET"]);
});

test("outages and mainnet responses do not enter drift monitoring", async () => {
  let observations = 0;
  for (const [environment, payload, status] of [
    ["mainnet", { code: 0, data: [] }, 200],
    ["vst", { code: 123456, msg: "private provider error", data: bad }, 200],
    ["vst", { code: 0, data: bad }, 503],
  ]) {
    const api = createBingXLiveApi({
      environment, credentials: () => ({ key: "fake-key", secret: "fake-secret" }),
      requestPacer: { waitForSlot: async () => {}, deferFor: () => {} }, sleep: async () => {},
      contractDriftMonitor: { observe() { observations++; } },
      fetchImpl: async () => ({
        ok: status === 200, status, text: async () => JSON.stringify(payload),
      }),
    });
    if (environment === "mainnet") assert.deepEqual(await api.getPositions("BTCUSDT"), []);
    else await assert.rejects(api.getPositions("BTCUSDT"));
  }
  assert.equal(observations, 0);
});

test("successful responses, rollback and 30-minute gaps reset qualification", async () => {
  let now = 1_000_000;
  const alerts = [];
  const monitor = createVstContractDriftMonitor({ clock: () => now, onAlert: r => alerts.push(r) });
  monitor.observe(positionPath, bad);
  now += 60_000; monitor.observe(positionPath, bad);
  monitor.observe(positionPath, []);
  now += 240_000; monitor.observe(positionPath, bad);
  await settle();
  assert.equal(alerts.length, 0);
  now += 60_000; monitor.observe(positionPath, bad);
  now -= 60_000; monitor.observe(positionPath, bad);
  now += 240_000; monitor.observe(positionPath, bad);
  await settle();
  assert.equal(alerts.length, 0);
  now += 31 * 60_000; monitor.observe(positionPath, bad);
  now += 60_000; monitor.observe(positionPath, bad);
  await settle();
  assert.equal(alerts.length, 0);
});