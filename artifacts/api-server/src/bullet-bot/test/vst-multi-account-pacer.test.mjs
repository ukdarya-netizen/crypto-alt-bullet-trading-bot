import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createStopTransferJournal } from "../stop-transfer-journal.mjs";
import {
  mixedLoadHarness, EPOCH, ORDER, BALANCE, raiseStop, close,
} from "./helpers/vst-mixed-load.mjs";

const POSITIONS = "/openApi/swap/v2/user/positions";
const OPEN_ORDERS = "/openApi/swap/v2/trade/openOrders";
const FAST_READS = new Set([BALANCE, POSITIONS, OPEN_ORDERS, ORDER,
  "/openApi/swap/v1/positionSide/dual", "/openApi/swap/v2/trade/leverage",
  "/openApi/swap/v2/trade/marginType", "/openApi/swap/v2/trade/allOrders",
  "/openApi/swap/v2/trade/allFillOrders", "/openApi/swap/v1/positionMargin/history",
  "/openApi/swap/v2/user/commissionRate", "/openApi/swap/v2/user/income"]);

function flood(f, count = 120) {
  return f.run("noisy-account", api => Promise.all(Array.from({ length: count }, (_, i) =>
    [() => api.getBalance(), () => api.getPositions("SOLUSDT"),
      () => api.getOpenOrders("SOLUSDT")][i % 3]())));
}

function alignProtectiveWrites(f, roles, onReady = () => {}) {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const ready = new Set();
  f.hooks.onPriority = async row => {
    if (!roles.includes(row.role) || ready.has(row.role)) return;
    ready.add(row.role);
    if (ready.size === roles.length) {
      onReady();
      release();
    }
    await barrier;
  };
}

function assertBudgets(f) {
  const lastEndpoint = new Map();
  let lastWrite = -Infinity;
  for (let i = 0; i < f.requests.length; i++) {
    const row = f.requests[i];
    if (i) assert.ok(row.at - f.requests[i - 1].at >= 300, "global start floor");
    if (i >= 4) assert.ok(row.at - f.requests[i - 4].at >= 1000,
      "no more than four starts per rolling second");
    const fast = row.method === "GET" && FAST_READS.has(row.path);
    const key = fast ? row.path : "conservative";
    assert.ok(row.at - (lastEndpoint.get(key) ?? -Infinity) >= (fast ? 600 : 1100),
      `shared endpoint floor: ${key}`);
    lastEndpoint.set(key, row.at);
    if (row.method !== "GET") {
      assert.ok(row.at - lastWrite >= 1100, "all clients share the write floor");
      lastWrite = row.at;
    }
  }
  for (const pause of f.cooldowns) assert.equal(
    f.requests.some(row => row.at > pause.at && row.at < pause.until), false,
    "all accounts and writes respect provider cooldown");
}

test("three independent accounts make bounded progress despite a large fourth-account backlog", async () => {
  const f = mixedLoadHarness({ endpointPacing: true });
  const noisy = flood(f);
  const peers = ["subscriber-a", "subscriber-b", "owner"];
  const work = peers.map(role => f.run(role, async api => {
    for (let i = 0; i < 8; i++) await api.getBalance();
  }));
  await f.drain(Promise.all([noisy, ...work]));
  for (const role of peers) {
    const indices = f.requests.flatMap((row, i) => row.role === role ? [i] : []);
    assert.equal(indices.length, 8);
    // The peers all need balance's 600 ms lane. The noisy client may use
    // otherwise idle 300 ms slots for other endpoints, not steal balance turns.
    assert.ok(indices[0] <= 6, `${role} must not wait for the noisy account's backlog`);
    for (let i = 1; i < indices.length; i++) assert.ok(indices[i] - indices[i - 1] <= 6,
      `${role} keeps making progress while every account has pending work`);
    assert.ok(f.requests.slice(indices.at(-1) + 1).some(row => row.role === "noisy-account"));
  }
  const identities = ["noisy-account", ...peers].map(role => {
    const callers = new Set(f.reservations.filter(row => row.role === role).map(row => row.caller));
    assert.equal(callers.size, 1, "one stable queue identity per client");
    const [caller] = callers;
    assert.equal(typeof caller, "object");
    assert.deepEqual(Object.keys(caller), [], "identity contains no credentials");
    return caller;
  });
  assert.equal(new Set(identities).size, 4, "different clients never share a queue identity");
  assert.equal(f.requests.filter(row => row.role === "noisy-account").length, 120);
  assertBudgets(f);
});

test("subscriber runners and key verification use the process-wide VST pacer, not private lanes", () => {
  // Construction sites must not override the native client's shared default.
  // Keep this wiring check offline: importing the runner/routes starts DB/auth dependencies.
  for (const file of ["../subscriber-trading.mjs", "../../routes/subscribers.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const options = source.match(/createBingXLiveApi\(\{([\s\S]*?)\n\s*\}\);/);
    assert.ok(options, `native VST client construction exists in ${file}`);
    assert.match(options[1], /environment: "vst"/);
    assert.doesNotMatch(options[1], /requestPacer:/, "subscriber must retain the shared default");
    assert.doesNotMatch(source, /createBingXOutboundPacer/);
  }
});

test("native protective replacement and close complete before another account's backlog drains", async () => {
  const f = mixedLoadHarness({ endpointPacing: true });
  const [stopped, closed] = await f.drain(Promise.all([
    f.run("stop-account", raiseStop), f.run("close-account", close), flood(f),
  ]));
  assert.equal(stopped.verified, true);
  assert.equal(closed.orderId, "market-ETH-USDT");
  const writes = f.requests.filter(row => row.method !== "GET");
  assert.deepEqual(writes.map(row => row.method).sort(), ["DELETE", "POST", "POST"]);
  const replacement = writes.find(row => row.role === "stop-account" && row.method === "POST");
  const cancellation = writes.find(row => row.method === "DELETE");
  assert.ok(cancellation.at > replacement.at, "replacement is verified before old stop cancellation");
  assert.ok(f.requests.some(row => row.role === "stop-account" && row.method === "GET" &&
    row.at > replacement.at && row.at < cancellation.at), "fresh post-write proof");
  for (const role of ["stop-account", "close-account"]) {
    const ready = f.reservations.filter(row => row.role === role && row.priority);
    assert.ok(ready.length);
    for (const slot of ready) assert.ok(slot.selectedAt - slot.queuedAt <= 2200,
      "protective writes are not queued behind background reads");
    const last = f.requests.findLastIndex(row => row.role === role);
    assert.ok(f.requests.slice(last + 1).some(row => row.role === "noisy-account"));
  }
  assertBudgets(f);
});

test("429 on a protective write pauses every account without replaying POST", async () => {
  const f = mixedLoadHarness({ endpointPacing: true });
  let limited = false;
  f.hooks.rateLimit = ({ role, options }) => {
    if (role !== "stop-account" || options.method !== "POST") return false;
    limited = true;
    return true;
  };
  const [error] = await f.drain(Promise.all([
    f.run("stop-account", raiseStop).then(() => assert.fail("429 accepted"), error => error),
    f.run("close-account", close), flood(f),
  ]));
  assert.equal(limited, true);
  assert.equal(error.httpStatus, 429);
  assert.equal(f.requests.filter(row => row.role === "stop-account" && row.method === "POST").length, 1);
  assert.equal(f.requests.some(row => row.method === "DELETE"), false);
  assert.ok(f.cooldowns.some(row => row.until - row.at === 5000));
  const before = f.requests.length;
  await assert.rejects(f.run("stop-account", raiseStop), /already submitted/);
  assert.equal(f.requests.length, before);
  assertBudgets(f);
});

test("repeated GET throttling extends the shared pause but does not starve other accounts", async () => {
  const f = mixedLoadHarness({ endpointPacing: true });
  f.hooks.rateLimit = ({ role }) => role === "limited-account";
  await f.drain(Promise.all([
    assert.rejects(f.run("limited-account", api => api.getBalance())),
    flood(f),
    f.run("subscriber", async api => {
      for (let i = 0; i < 10; i++) await api.getPositions("SOLUSDT");
    }),
  ]));
  assert.equal(f.requests.filter(row => row.role === "limited-account").length, 2);
  assert.deepEqual(f.cooldowns.map(row => row.until - row.at), [1100, 5000]);
  assert.ok(f.requests.findIndex(row => row.role === "subscriber") <= 3);
  assert.ok(f.requests.filter(row => row.role === "subscriber").at(-1).at < EPOCH + 30000);
  assertBudgets(f);
});

test("lost protective responses under multi-account load stay ambiguous and are never replayed", async () => {
  const f = mixedLoadHarness({
    endpointPacing: true, ambiguous: ["stop-account", "close-account"],
  });
  const actions = [["stop-account", raiseStop], ["close-account", close]];
  const outcomes = await f.drain(Promise.all([
    ...actions.map(([role, action]) => f.run(role, action).then(
      () => assert.fail("lost response cannot be treated as confirmed"), error => error)),
    flood(f),
  ]));
  for (const error of outcomes.slice(0, 2)) assert.equal(error.transportStage, "network_request");
  assert.equal(f.requests.filter(row => row.method === "POST").length, 2);
  assert.equal(f.requests.some(row => row.method === "DELETE"), false);
  assert.equal(f.orders.find(row => row.orderId === "200").status, "NEW",
    "do not cancel original protection after an ambiguous replacement");
  assert.equal(f.positions.find(row => row.symbol === "ETH-USDT").positionAmt, "0",
    "fake venue applied the close even though its response was lost");
  const before = f.requests.length;
  for (const [role, action] of actions) {
    await assert.rejects(f.run(role, action), /already submitted/);
  }
  assert.equal(f.requests.length, before, "no automatic retry of ambiguous operations");
  assertBudgets(f);
});

test("three simultaneous protective writes revalidate expired evidence and each reaches transport once", async () => {
  const f = mixedLoadHarness({ endpointPacing: true, isolateAccounts: true });
  const roles = ["stop-a", "stop-b", "stop-c"];
  alignProtectiveWrites(f, roles);
  const stages = new Map(roles.map(role => [role, []]));
  const journals = new Map(roles.map(role => [role, createStopTransferJournal({
    request: { operation: "raise_stop", symbol: "BTCUSDT", stopTransferProtocol: 1 },
    persist: async (_prior, next) => { stages.get(role).push(next.stage); return true; },
  })]));
  const results = await f.drain(Promise.all([
    ...roles.map(role => f.run(role, api =>
      api.withStopTransferJournal(journals.get(role), () => raiseStop(api)))), flood(f),
  ]));
  for (const result of results.slice(0, 3)) assert.equal(result.verified, true);
  const expired = f.reservations.filter(row => roles.includes(row.role) &&
    row.method === "POST" && row.priority && row.selectedAt - row.queuedAt > 2000);
  assert.ok(expired.length, "exercise an actual expired pre-sign reservation");
  for (const slot of expired) {
    const write = f.requests.find(row => row.role === slot.role && row.method === "POST");
    assert.ok(write.at > slot.selectedAt, "expired reservation must not reach transport");
    for (const path of [POSITIONS, OPEN_ORDERS, "/openApi/swap/v2/trade/leverage"]) {
      assert.ok(f.requests.some(row => row.role === slot.role && row.method === "GET" &&
        row.path === path && row.at >= slot.selectedAt && row.at < write.at),
      `reacquire final ${path} evidence after expiry`);
    }
  }
  for (const role of roles) {
    assert.equal(f.requests.filter(row => row.role === role && row.method === "POST").length, 1);
    assert.equal(f.requests.filter(row => row.role === role && row.method === "DELETE").length, 1);
    assert.equal(f.stateFor(role).orders.find(row => row.orderId === "200").status, "CANCELED");
    assert.deepEqual(stages.get(role),
      ["post_started", "post_acknowledged", "cancel_started", "cancel_acknowledged"],
      "refresh never reserves or acknowledges the same durable mutation twice");
  }
  assertBudgets(f);
});

test("revalidation refuses changed protective evidence before any transport", async () => {
  const f = mixedLoadHarness({ endpointPacing: true, isolateAccounts: true });
  const roles = ["stop-a", "stop-b", "stop-c"];
  alignProtectiveWrites(f, roles, () => {
    f.stateFor("stop-a").orders.find(row => row.orderId === "200").stopPrice = "94";
  });
  const results = await f.drain(Promise.all([
    ...roles.map(role => f.run(role, raiseStop).then(value => ({ value }), error => ({ error }))),
    flood(f),
  ]));
  assert.equal(results[0].error?.transportStage, "pre_transport");
  assert.equal(f.requests.some(row => row.role === "stop-a" && row.method !== "GET"), false,
    "no mutation can use the invalidated original final check");
  assert.equal(results[1].value?.verified, true);
  assert.equal(results[2].value?.verified, true);
  assert.ok(f.reservations.some(row => row.role === "stop-a" && row.method === "POST" &&
    row.selectedAt - row.queuedAt > 2000));
  assertBudgets(f);
});
