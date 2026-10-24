import assert from "node:assert/strict";
import { test } from "node:test";
import { BulletPositionSyncError, fetchBulletPositions } from "../source-position-sync.mjs";

function position(id) {
  return {
    sourceSignalId: id,
    signalAt: "2027-01-01T00:00:00.000Z",
    botEnqueuedAt: null,
    symbol: "BTCUSDT",
    initialStopPrice: null,
    sourceStatus: "active",
    sourceUpdatedAt: null,
    sourceClosedAt: null,
    sourceEntryPrice: null,
    sourceExitPrice: null,
    sourcePnlPercent: null,
    sourcePeakPrice: null,
    sourceStopLossPrice: null,
    sourceTrailingStopLevel: null,
    sourceLastMilestone: null,
    sourceCancelReason: null,
  };
}

function response(payload) {
  return { ok: true, json: async () => payload };
}

test("page-local timestamps require two identical complete sweeps, including record 201", async () => {
  const now = Date.now();
  const signals = [];
  let calls = 0;
  const result = await fetchBulletPositions({
    token: "test-token",
    async fetchImpl(url, options) {
      signals.push(options.signal);
      calls += 1;
      const last = url.searchParams.has("afterId");
      return response({
        asOf: new Date(now + calls).toISOString(),
        nextAfterId: last ? null : 200,
        positions: last ? [position("201")]
          : Array.from({ length: 200 }, (_, i) => position(String(i + 1))),
      });
    },
  });
  assert.equal(calls, 4);
  assert.equal(new Set(signals).size, 1);
  assert.equal(result.positions.size, 201);
  assert.ok(result.positions.has("201"));
  assert.equal(result.asOf, new Date(now + 3).toISOString());
});

test("confirmation refuses insertions, deletions and lifecycle changes instead of a partial snapshot", async () => {
  for (const change of ["insert", "delete", "status", "price"]) {
    const now = Date.now();
    let calls = 0;
    await assert.rejects(fetchBulletPositions({
      token: "test-token",
      async fetchImpl(url) {
        calls += 1;
        const last = url.searchParams.has("afterId");
        let positions = last ? [position("201")] : [position("200")];
        if (calls === 4) {
          if (change === "insert") positions.push(position("202"));
          if (change === "delete") positions = [];
          if (change === "status") positions[0].sourceStatus = "in_run";
          if (change === "price") positions[0].sourcePeakPrice = 123;
        }
        return response({
          asOf: new Date(now + calls).toISOString(),
          nextAfterId: last ? null : 200, positions,
        });
      },
    }), (error) => error.code === "incomplete_response" &&
      /confirmation sweeps/.test(error.message), change);
    assert.equal(calls, 4);
  }
});

test("a failed confirmation page rejects the whole source acquisition", async () => {
  const now = Date.now();
  let calls = 0;
  await assert.rejects(fetchBulletPositions({
    token: "test-token",
    async fetchImpl(url) {
      calls += 1;
      if (calls === 4) return response({ asOf: new Date(now).toISOString() });
      const last = url.searchParams.has("afterId");
      return response({
        asOf: new Date(now + calls).toISOString(),
        nextAfterId: last ? null : 200,
        positions: [position(last ? "201" : "200")],
      });
    },
  }), (error) => error.code === "incomplete_response" && error.pageNumber === 2);
  assert.equal(calls, 4);
});

test("confirmation does not reset the source acquisition deadline", async () => {
  let calls = 0;
  const now = Date.now();
  await assert.rejects(fetchBulletPositions({
    token: "test-token", timeoutMs: 30,
    async fetchImpl(url) {
      calls += 1;
      if (calls === 3) return new Promise(() => {});
      const last = url.searchParams.has("afterId");
      return response({
        asOf: new Date(now + calls).toISOString(),
        nextAfterId: last ? null : 200,
        positions: [position(last ? "201" : "200")],
      });
    },
  }), (error) => error.code === "request_timeout");
  assert.equal(calls, 3);
});

test("all pagination requests share one overall abort signal and only return a complete snapshot", async () => {
  const asOf = new Date().toISOString();
  const requestSignals = [];
  const result = await fetchBulletPositions({
    token: "test-token",
    async fetchImpl(url, options) {
      requestSignals.push(options.signal);
      if (!url.searchParams.has("afterId")) {
        return response({ asOf, nextAfterId: "cursor-1", positions: [position("signal-1")] });
      }
      return response({ asOf, nextAfterId: null, positions: [position("signal-2")] });
    },
  });
  assert.equal(requestSignals.length, 2);
  assert.equal(requestSignals[0], requestSignals[1]);
  assert.deepEqual([...result.positions.keys()], ["signal-1", "signal-2"]);
});

test("the total source request deadline aborts a hung page before returning partial data", async () => {
  let observedSignal;
  await assert.rejects(
    fetchBulletPositions({
      token: "test-token",
      timeoutMs: 20,
      fetchImpl(_url, options) {
        observedSignal = options.signal;
        return new Promise(() => {});
      },
    }),
    (error) => error instanceof BulletPositionSyncError && error.code === "request_timeout",
  );
  assert.equal(observedSignal.aborted, true);
});

test("the same overall deadline also bounds a stalled response body", async () => {
  let observedSignal;
  await assert.rejects(
    fetchBulletPositions({
      token: "test-token",
      timeoutMs: 20,
      async fetchImpl(_url, options) {
        observedSignal = options.signal;
        return { ok: true, json: () => new Promise(() => {}) };
      },
    }),
    (error) => error instanceof BulletPositionSyncError && error.code === "request_timeout",
  );
  assert.equal(observedSignal.aborted, true);
});

test("failure on a later page rejects the whole snapshot instead of reusing its first page", async () => {
  let count = 0;
  const asOf = new Date().toISOString();
  await assert.rejects(
    fetchBulletPositions({
      token: "test-token",
      async fetchImpl(url) {
        count += 1;
        if (count === 1) {
          return response({ asOf, nextAfterId: "cursor-1", positions: [position("signal-1")] });
        }
        return { ok: false, status: 503 };
      },
    }),
    (error) => error instanceof BulletPositionSyncError && error.code === "request_failed",
  );
  assert.equal(count, 3, "the transient HTTP failure receives one bounded retry");
});

test("retries one transient transport failure and returns only after the full page succeeds", async () => {
  const asOf = new Date().toISOString();
  let calls = 0;
  const result = await fetchBulletPositions({
    token: "test-token",
    async fetchImpl() {
      calls += 1;
      if (calls === 1) throw new TypeError("socket reset");
      return response({ asOf, nextAfterId: null, positions: [position("recovered")] });
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual([...result.positions.keys()], ["recovered"]);
});

test("does not retry unclassified transport exceptions", async () => {
  let calls = 0;
  await assert.rejects(fetchBulletPositions({
    token: "test-token",
    async fetchImpl() {
      calls += 1;
      throw new Error("unexpected local failure");
    },
  }), (error) => error.failureStage === "transport" && error.attempts === 1);
  assert.equal(calls, 1);
});

test("does not retry authentication failures and reports bounded HTTP diagnostics", async () => {
  let calls = 0;
  await assert.rejects(fetchBulletPositions({
    token: "secret-token",
    fetchImpl: async () => { calls += 1; return { ok: false, status: 401 }; },
  }), (error) => {
    assert.equal(error.code, "request_failed");
    assert.equal(error.httpStatus, 401);
    assert.equal(error.failureStage, "http");
    assert.equal(error.pageNumber, 1);
    assert.equal(error.attempts, 1);
    assert.equal(error.message.includes("secret-token"), false);
    return true;
  });
  assert.equal(calls, 1);
});

test("preserves Retry-After on an over-budget 429 without retrying", async () => {
  let calls = 0;
  let sleeps = 0;
  const now = Date.parse("2026-10-02T10:00:00.000Z");
  await assert.rejects(fetchBulletPositions({
    token: "test-token",
    clock: () => now,
    timeoutMs: 100,
    sleepImpl: async () => { sleeps += 1; },
    async fetchImpl() {
      calls += 1;
      return {
        ok: false,
        status: 429,
        headers: { get: (name) => name === "retry-after" ? "30" : null },
      };
    },
  }), (error) => {
    assert.equal(error.httpStatus, 429);
    assert.equal(error.retryAfterMs, 30_000);
    assert.equal(error.failureStage, "http");
    assert.equal(error.attempts, 1);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(sleeps, 0);
});

test("a 503 Retry-After wait is abort-bounded by the single global pagination deadline", async () => {
  const now = new Date().toISOString();
  let calls = 0;
  let sleepSignal;
  await assert.rejects(fetchBulletPositions({
    token: "test-token",
    timeoutMs: 30,
    sleepImpl: (_ms, { signal }) => {
      sleepSignal = signal;
      return new Promise(() => {});
    },
    async fetchImpl() {
      calls += 1;
      return {
        ok: false,
        status: 503,
        headers: { get: () => "0.01" },
      };
    },
  }), (error) => error.code === "request_timeout");
  assert.equal(calls, 1);
  assert.equal(sleepSignal.aborted, true);
});

test("the global deadline is not reset when pagination advances to another page", async () => {
  const asOf = new Date().toISOString();
  let calls = 0;
  let secondPageSignal;
  await assert.rejects(fetchBulletPositions({
    token: "test-token",
    timeoutMs: 30,
    async fetchImpl(url, { signal }) {
      calls += 1;
      if (!url.searchParams.has("afterId")) {
        return response({ asOf, nextAfterId: "cursor", positions: [position("first")] });
      }
      secondPageSignal = signal;
      return new Promise(() => {});
    },
  }), (error) => error.code === "request_timeout");
  assert.equal(calls, 2);
  assert.equal(secondPageSignal.aborted, true);
});

test("parses an HTTP-date Retry-After using the injected clock", async () => {
  const now = Date.parse("2026-10-02T10:00:00.000Z");
  const asOf = new Date(now).toISOString();
  let calls = 0;
  const waits = [];
  const result = await fetchBulletPositions({
    token: "test-token",
    clock: () => now,
    sleepImpl: async (milliseconds) => { waits.push(milliseconds); },
    async fetchImpl() {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: () => "Fri, 02 Oct 2026 10:00:02 GMT" },
        };
      }
      return response({ asOf, nextAfterId: null, positions: [] });
    },
  });
  assert.deepEqual(waits, [2_000]);
  assert.equal(calls, 2);
  assert.equal(result.positions.size, 0);
});

test("invalid response bodies are never retried as transport failures", async () => {
  let calls = 0;
  await assert.rejects(fetchBulletPositions({
    token: "test-token",
    async fetchImpl() {
      calls += 1;
      return { ok: true, status: 200, json: async () => { throw new Error("bad body"); } };
    },
  }), (error) => {
    assert.equal(error.code, "incomplete_response");
    assert.equal(error.failureStage, "body");
    assert.equal(error.pageNumber, 1);
    assert.equal(error.attempts, 1);
    return true;
  });
  assert.equal(calls, 1);
});