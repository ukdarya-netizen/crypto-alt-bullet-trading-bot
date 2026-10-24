import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { createServer, configuredMode, start } from "../server.mjs";

const sample = JSON.parse(
  await readFile(
    new URL("./fixtures/impulse-buy-sample.json", import.meta.url),
    "utf8",
  ),
);
const now = Date.parse(sample.signalAt) + 30_000;
const seen = new Map();
const store = {
  enqueue: async (body) => {
    const prior = seen.get(body.sourceSignalId);
    if (prior) {
      return {
        kind: JSON.stringify(prior) === JSON.stringify(body) ? "duplicate" : "conflict",
      };
    }
    seen.set(body.sourceSignalId, body);
    return { kind: "new", status: "pending" };
  },
  listRecent: async () => [],
  listOpenPositions: async () => [],
  listRecentPositions: async () => [],
  getPaperAccount: async () => ({
    initialUsdt: 100,
    freeUsdt: 100,
    reservedUsdt: 0,
    realizedPnlUsdt: 0,
  }),
};
const server = createServer({ store, token: "test-token", clock: () => now });
before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
});
const url = (path) => `http://127.0.0.1:${server.address().port}${path}`;
const post = (body, token = "test-token") =>
  fetch(url("/api/trading/signals"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-trading-token": token,
    },
    body: JSON.stringify(body),
  });

test("historical impulse wire shape is accepted for offline schema check", async () => {
  const response = await post(sample);
  assert.equal(response.status, 202);
  assert.deepEqual((await response.json()).signal, {
    status: "pending",
    sourceSignalId: sample.sourceSignalId,
    duplicate: false,
  });
  const again = await post(sample);
  assert.equal(again.status, 202);
  assert.equal((await again.json()).signal.duplicate, true);
  assert.equal(seen.size, 1);
});

test("same ID with different body conflicts", async () => {
  assert.equal((await post({ ...sample, quantity: "1" })).status, 409);
  assert.equal(seen.size, 1);
});
test("duplicate receipt reflects the stored result instead of claiming pending", async () => {
  const prior = seen.get(sample.sourceSignalId);
  const oldEnqueue = store.enqueue;
  store.enqueue = async (body) =>
    body.sourceSignalId === sample.sourceSignalId
      ? { kind: "duplicate", status: "closed" }
      : oldEnqueue(body);
  try {
    const response = await post(prior);
    assert.equal(response.status, 202);
    assert.equal((await response.json()).signal.status, "closed");
  } finally {
    store.enqueue = oldEnqueue;
  }
});

test("wrong token cannot enqueue or view status", async () => {
  assert.equal((await post(sample, "bad")).status, 401);
  assert.equal((await fetch(url("/api/trading/status"))).status, 401);
});

test("unsupported runner fields, experimental pattern and expired event reject", async () => {
  const oldRunner = structuredClone(sample);
  oldRunner.sourceSignalId = "cab-signal-888";
  oldRunner.payload.exitRules.runner.corePct = 80;
  delete oldRunner.payload.exitRules.runner.coreFraction;
  assert.equal((await post(oldRunner)).status, 422);
  assert.equal(
    (await post({ ...sample, patternId: "neon_support_bounce" })).status,
    422,
  );
  assert.equal(
    (await post({ ...sample, signalAt: new Date(now - 11 * 60_000).toISOString() })).status,
    422,
  );
});

test("health explicitly identifies PAPER mode", async () => {
  const response = await fetch(url("/healthz"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, mode: "paper" });
  assert.throws(
    () => createServer({ store, token: "test-token", mode: "live" }),
    /PAPER_ONLY_SIGNAL/,
  );
});

test("the existing sender URL reaches the isolated PAPER queue", async () => {
  const received = [];
  let marketCalls = 0;
  let marketDenied = false;
  const receiver = createServer({
    store: {
      ...store,
      enqueue: async (signal) => {
        received.push(signal);
        return { kind: "new", status: "pending" };
      },
    },
    token: "test-token",
    clock: () => now,
    basePath: "/api/bot",
    ingestAliases: ["/api/trading/signals"],
    marketCheck: async () => {
      marketCalls++;
      if (marketDenied) throw Object.assign(new Error("blocked"), { httpStatus: 403 });
    },
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const at = (path) => `http://127.0.0.1:${receiver.address().port}${path}`;
  try {
    const response = await fetch(at("/api/trading/signals"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-trading-token": "test-token" },
      body: JSON.stringify(sample),
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).signal.sourceSignalId, sample.sourceSignalId);
    assert.equal(received.length, 1);
    assert.equal((await fetch(at("/api/trading/signals"), {
      headers: { "x-trading-token": "test-token" },
    })).status, 404);
    assert.equal((await fetch(at("/api/bot/api/trading/status"), {
      headers: { "x-trading-token": "test-token" },
    })).status, 200);
    const healthPath = at("/api/bot/api/trading/market-health");
    assert.equal((await fetch(healthPath)).status, 401);
    assert.equal(marketCalls, 0);
    const healthy = await fetch(healthPath, { headers: { "x-trading-token": "test-token" } });
    assert.equal(healthy.status, 200);
    assert.deepEqual(await healthy.json(), { ok: true, source: "BingX", mode: "paper" });
    marketDenied = true;
    const denied = await fetch(healthPath, { headers: { "x-trading-token": "test-token" } });
    assert.equal(denied.status, 503);
    assert.deepEqual(await denied.json(), {
      ok: false, source: "BingX", error: "bingx_access_denied", httpStatus: 403,
    });
    assert.equal((await fetch(at("/api/trading/signals"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-trading-token": "wrong" },
      body: JSON.stringify(sample),
    })).status, 401);
    assert.equal(received.length, 1);
  } finally {
    await new Promise((resolve) => receiver.close(resolve));
  }
});

test("configuredMode resolves unset/vst/both and rejects any other value", () => {
  const original = process.env.BULLET_VST_MODE;
  try {
    delete process.env.BULLET_VST_MODE;
    assert.equal(configuredMode(), "paper");
    process.env.BULLET_VST_MODE = "";
    assert.equal(configuredMode(), "paper");
    process.env.BULLET_VST_MODE = "vst";
    assert.equal(configuredMode(), "vst");
    process.env.BULLET_VST_MODE = "both";
    assert.equal(configuredMode(), "both");
    process.env.BULLET_VST_MODE = "live";
    assert.throws(() => configuredMode(), /BULLET_VST_MODE must be unset, or exactly 'vst' or 'both'/);
  } finally {
    if (original === undefined) delete process.env.BULLET_VST_MODE;
    else process.env.BULLET_VST_MODE = original;
  }
});

test("standalone development receiver refuses VST before loading the database or broker", async () => {
  const names = ["TRADING_INGEST_TOKEN", "BULLET_VST_MODE", "NODE_ENV", "PAPER_ONLY_SIGNAL", "EXECUTION_MODE"];
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.TRADING_INGEST_TOKEN = "test-only";
    process.env.NODE_ENV = "development";
    process.env.PAPER_ONLY_SIGNAL = "true";
    process.env.EXECUTION_MODE = "paper";
    for (const mode of ["vst", "both"]) {
      process.env.BULLET_VST_MODE = mode;
      await assert.rejects(start(), /VST execution is disabled outside the published production runtime/);
    }
  } finally {
    for (const name of names) {
      if (prior[name] === undefined) delete process.env[name];
      else process.env[name] = prior[name];
    }
  }
});

test("both mode enqueues every fresh signal into PAPER and VST concurrently", async () => {
  const enabledAt = now - 1_000;
  const fresh = {
    ...sample,
    sourceSignalId: "cab-signal-991001",
    signalAt: new Date(now - 500).toISOString(),
  };
  const vstRows = new Map();
  const paperRows = new Map();
  const vstStore = {
    async enqueue(signal) {
      const previous = vstRows.get(signal.sourceSignalId);
      if (previous) {
        return {
          kind: JSON.stringify(previous) === JSON.stringify(signal) ? "duplicate" : "conflict",
          status: "pending",
        };
      }
      vstRows.set(signal.sourceSignalId, signal);
      return { kind: "new", status: "pending" };
    },
    async listOpenPositions() { return []; },
  };
  const paperStore = {
    async enqueue(signal) {
      const previous = paperRows.get(signal.sourceSignalId);
      if (previous) {
        return {
          kind: JSON.stringify(previous) === JSON.stringify(signal) ? "duplicate" : "conflict",
          status: "pending",
        };
      }
      paperRows.set(signal.sourceSignalId, signal);
      return { kind: "new", status: "pending" };
    },
    async listRecent() { return []; },
    async listRecentPositions() { return []; },
    async getPaperAccount() { return { initialUsdt: 100, freeUsdt: 90, reservedUsdt: 10, realizedPnlUsdt: 0 }; },
  };
  const receiver = createServer({
    store: vstStore,
    paperStore,
    token: "test-token",
    mode: "both",
    clock: () => now,
    vstEnabledAt: enabledAt,
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const at = (path) => `http://127.0.0.1:${receiver.address().port}${path}`;
  try {
    const send = (body) => fetch(at("/api/trading/signals"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-trading-token": "test-token" },
      body: JSON.stringify(body),
    });
    const accepted = await send(fresh);
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json()).signal.duplicate, false);
    assert.equal(vstRows.size, 1);
    assert.equal(paperRows.size, 1);

    // Exact resend: both sides independently detect the duplicate.
    const replay = await send(fresh);
    assert.equal(replay.status, 202);
    assert.equal((await replay.json()).signal.duplicate, true);

    // A pre-enable signal is blocked from reaching EITHER ledger, not just
    // VST -- a single ingestion pipe cannot let PAPER and VST diverge on
    // which signals they each saw.
    const stale = await send({ ...fresh, sourceSignalId: "cab-signal-991002", signalAt: sample.signalAt });
    assert.equal(stale.status, 422);
    assert.equal(vstRows.size, 1);
    assert.equal(paperRows.size, 1);

    const statusResponse = await fetch(at("/api/trading/status"), {
      headers: { "x-trading-token": "test-token" },
    });
    const status = await statusResponse.json();
    assert.equal(status.mode, "both");
    assert.equal(status.paperHistory.readOnly, false);
  } finally {
    await new Promise((resolve) => receiver.close(resolve));
  }
});

test("both mode reports a conflict when either ledger's stored body disagrees, without silently accepting", async () => {
  const enabledAt = now - 1_000;
  const original = {
    ...sample,
    sourceSignalId: "cab-signal-991101",
    signalAt: new Date(now - 500).toISOString(),
  };
  const vstStore = {
    async enqueue(signal) {
      return signal.sourceSignalId === original.sourceSignalId && signal.quantity !== original.quantity
        ? { kind: "conflict", status: "pending" }
        : { kind: "new", status: "pending" };
    },
    async listOpenPositions() { return []; },
  };
  let paperEnqueues = 0;
  const paperStore = {
    async enqueue() { paperEnqueues += 1; return { kind: "new", status: "pending" }; },
  };
  const receiver = createServer({
    store: vstStore,
    paperStore,
    token: "test-token",
    mode: "both",
    clock: () => now,
    vstEnabledAt: enabledAt,
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const at = (path) => `http://127.0.0.1:${receiver.address().port}${path}`;
  try {
    const send = (body) => fetch(at("/api/trading/signals"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-trading-token": "test-token" },
      body: JSON.stringify(body),
    });
    const changed = await send({ ...original, quantity: "0.02" });
    assert.equal(changed.status, 409);
    assert.equal((await changed.json()).error.code, "source_signal_id_conflict");
    // Both sides are still invoked -- the two ledgers are independent
    // tables and this call does not attempt cross-store transactionality.
    assert.equal(paperEnqueues, 1);
  } finally {
    await new Promise((resolve) => receiver.close(resolve));
  }
});

test("both mode requires a VST position store and a PAPER signal store", () => {
  const paperOnly = { async enqueue() {} };
  assert.throws(
    () => createServer({ store: paperOnly, paperStore: paperOnly, token: "t", mode: "both" }),
    /VST mode requires a VST position store/,
  );
  const vstLike = { async enqueue() {}, async listOpenPositions() { return []; } };
  assert.throws(
    () => createServer({ store: vstLike, paperStore: null, token: "t", mode: "both" }),
    /both mode requires a PAPER signal store/,
  );
});

test("VST ingress only queues fresh post-enable signals in VST storage", async () => {
  const enabledAt = now - 1_000;
  const fresh = {
    ...sample,
    sourceSignalId: "cab-signal-990001",
    signalAt: new Date(now - 500).toISOString(),
  };
  const vstRows = new Map();
  let paperEnqueues = 0;
  let paperReads = 0;
  const vstStore = {
    async enqueue(signal) {
      const previous = vstRows.get(signal.sourceSignalId);
      if (previous) {
        return {
          kind: JSON.stringify(previous) === JSON.stringify(signal) ? "duplicate" : "conflict",
          status: "pending",
        };
      }
      vstRows.set(signal.sourceSignalId, signal);
      return { kind: "new", status: "pending" };
    },
    async listOpenPositions() {
      return [{
        sourceSignalId: "vst-open-1",
        status: "open",
        snapshot: { environment: "vst", symbol: "ETHUSDT" },
      }];
    },
  };
  const paperStore = {
    async enqueue() { paperEnqueues += 1; return { kind: "new", status: "pending" }; },
    async listRecent() { paperReads += 1; return [{ sourceSignalId: "paper-old", body: sample, bodyHash: "hash", status: "closed" }]; },
    async listRecentPositions() { return [{ sourceSignalId: "paper-old", status: "closed", snapshot: { mode: "paper" } }]; },
    async getPaperAccount() { return { initialUsdt: 100, freeUsdt: 80, reservedUsdt: 20, realizedPnlUsdt: 1 }; },
  };
  const receiver = createServer({
    store: vstStore,
    paperStore,
    token: "test-token",
    mode: "vst",
    clock: () => now,
    vstEnabledAt: enabledAt,
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const at = (path) => `http://127.0.0.1:${receiver.address().port}${path}`;
  try {
    const send = (body) => fetch(at("/api/trading/signals"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-trading-token": "test-token" },
      body: JSON.stringify(body),
    });
    const accepted = await send(fresh);
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json()).signal.duplicate, false);
    assert.equal((await send(fresh)).status, 202);
    const changed = await send({ ...fresh, quantity: "0.01" });
    assert.equal(changed.status, 409);
    const replay = await send({ ...fresh, sourceSignalId: "cab-signal-990002", signalAt: sample.signalAt });
    assert.equal(replay.status, 422);
    assert.equal(vstRows.size, 1);
    assert.equal(paperEnqueues, 0);

    const statusResponse = await fetch(at("/api/trading/status"), {
      headers: { "x-trading-token": "test-token" },
    });
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.mode, "vst");
    assert.equal(status.positions[0].snapshot.environment, "vst");
    assert.equal(status.paperHistory.readOnly, true);
    assert.equal(status.paperHistory.signals[0].sourceSignalId, "paper-old");
    assert.equal(status.paperHistory.positions[0].snapshot.mode, "paper");
    assert.equal(paperReads, 1);
    assert.deepEqual(await (await fetch(at("/healthz"))).json(), {
      ok: true, mode: "vst", executionPaused: process.env.BULLET_VST_PAUSED === "1",
    });
  } finally {
    await new Promise((resolve) => receiver.close(resolve));
  }
});

test("ingress logs safe pre-enqueue rejection codes without request data", async () => {
  const events = [];
  const receiver = createServer({
    store,
    token: "test-token",
    clock: () => now,
    onIngress: (event) => events.push(event),
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const at = `http://127.0.0.1:${receiver.address().port}/api/trading/signals`;
  try {
    const unauthorized = await fetch(at, {
      method: "POST",
      headers: { "content-type": "application/json", "x-trading-token": "wrong" },
      body: JSON.stringify(sample),
    });
    assert.equal(unauthorized.status, 401);
    const invalid = await fetch(at, {
      method: "POST",
      headers: { "content-type": "application/json", "x-trading-token": "test-token" },
      body: JSON.stringify({ ...sample, confirmationStatus: "pending" }),
    });
    assert.equal(invalid.status, 422);
    const malformed = await fetch(at, {
      method: "POST",
      headers: { "content-type": "application/json", "x-trading-token": "test-token" },
      body: "{secret",
    });
    assert.equal(malformed.status, 400);

    assert.deepEqual(events, [
      {
        type: "bot_signal_ingress",
        mode: "paper",
        status: 401,
        outcome: "unauthorized",
        rejection: { code: "unauthorized" },
      },
      {
        type: "bot_signal_ingress",
        mode: "paper",
        status: 422,
        outcome: "rejected",
        sourceSignalId: sample.sourceSignalId,
        rejection: { code: "unconfirmed_signal", field: "confirmationStatus" },
      },
      {
        type: "bot_signal_ingress",
        mode: "paper",
        status: 400,
        outcome: "rejected",
        rejection: { code: "invalid_json", field: "body" },
      },
    ]);
  } finally {
    await new Promise((resolve) => receiver.close(resolve));
  }
});

test("both mode logs partial persistence and an idempotent retry completes both stores", async () => {
  const events = [];
  const fresh = {
    ...sample,
    sourceSignalId: "cab-signal-992001",
    signalAt: new Date(now - 500).toISOString(),
  };
  const vstRows = new Map();
  const paperRows = new Map();
  let failPaperOnce = true;
  const memoryStore = (rows, shouldFail = () => false) => ({
    async enqueue(signal) {
      if (shouldFail()) throw new Error("private storage/provider detail");
      const prior = rows.get(signal.sourceSignalId);
      if (prior) {
        return {
          kind: JSON.stringify(prior) === JSON.stringify(signal) ? "duplicate" : "conflict",
          status: "pending",
        };
      }
      rows.set(signal.sourceSignalId, signal);
      return { kind: "new", status: "pending" };
    },
    async listOpenPositions() { return []; },
  });
  const receiver = createServer({
    store: memoryStore(vstRows),
    paperStore: memoryStore(paperRows, () => {
      if (!failPaperOnce) return false;
      failPaperOnce = false;
      return true;
    }),
    token: "test-token",
    mode: "both",
    clock: () => now,
    vstEnabledAt: now - 1_000,
    onIngress: (event) => events.push(event),
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const at = `http://127.0.0.1:${receiver.address().port}/api/trading/signals`;
  const send = () => fetch(at, {
    method: "POST",
    headers: { "content-type": "application/json", "x-trading-token": "test-token" },
    body: JSON.stringify(fresh),
  });
  try {
    const first = await send();
    assert.equal(first.status, 503);
    assert.deepEqual(events[0], {
      type: "bot_signal_ingress",
      mode: "both",
      status: 503,
      outcome: "partial_dual_write",
      sourceSignalId: fresh.sourceSignalId,
      rejection: { code: "storage_unavailable" },
      stores: { vst: "received", paper: "failed" },
    });
    assert.equal(vstRows.size, 1);
    assert.equal(paperRows.size, 0);

    const retry = await send();
    assert.equal(retry.status, 202);
    assert.equal((await retry.json()).signal.duplicate, false);
    assert.deepEqual(events[1], {
      type: "bot_signal_ingress",
      mode: "both",
      status: 202,
      outcome: "both_received",
      sourceSignalId: fresh.sourceSignalId,
      stores: { vst: "received", paper: "received" },
      duplicate: false,
    });
    const exactReplay = await send();
    assert.equal(exactReplay.status, 202);
    assert.equal((await exactReplay.json()).signal.duplicate, true);
    assert.equal(events[2].duplicate, true);
    assert.equal(vstRows.size, 1);
    assert.equal(paperRows.size, 1);
    assert.equal(JSON.stringify(events).includes("private storage/provider detail"), false);
  } finally {
    await new Promise((resolve) => receiver.close(resolve));
  }
});