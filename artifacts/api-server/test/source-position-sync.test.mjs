import assert from "node:assert/strict";
import test from "node:test";
import { BulletPositionSyncError, fetchBulletPositions } from "../src/bullet-bot/source-position-sync.mjs";

const now = Date.parse("2026-01-01T12:00:00.000Z");
const asOf = new Date(now).toISOString();

function response(payload, ok = true, status = 200) {
  return { ok, status, json: async () => payload };
}

function sourcePosition(id, overrides = {}) {
  return {
    sourceSignalId: id,
    signalAt: asOf,
    botEnqueuedAt: null,
    symbol: "BTCUSDT",
    initialStopPrice: "10",
    sourceStatus: "active",
    sourceUpdatedAt: null,
    sourceClosedAt: null,
    sourceEntryPrice: "11",
    sourceExitPrice: null,
    sourcePnlPercent: null,
    sourcePeakPrice: null,
    sourceStopLossPrice: null,
    sourceTrailingStopLevel: null,
    sourceLastMilestone: null,
    sourceCancelReason: null,
    ...overrides,
  };
}

function closedPosition(id) {
  return sourcePosition(id, {
    sourceStatus: "profit",
    sourceClosedAt: asOf,
    sourceExitPrice: "12.5",
    sourcePnlPercent: "13.6",
  });
}

test("fetches every page with caller token and afterId, returning a complete map", async () => {
  const requests = [];
  const pages = [
    response({ asOf, nextAfterId: 10, positions: [sourcePosition(1)] }),
    response({ asOf, nextAfterId: null, positions: [closedPosition(2)] }),
  ];
  const result = await fetchBulletPositions({
    token: "secret-value",
    clock: () => now,
    fetchImpl: async (url, init) => {
      requests.push({ url: new URL(url), init });
      return pages.shift();
    },
  });

  assert.deepEqual([...result.positions.keys()], ["1", "2"]);
  assert.equal(result.positions.get("2").sourceSignalId, 2);
  assert.equal(result.asOf, asOf);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.search, "");
  assert.equal(requests[1].url.searchParams.get("afterId"), "10");
  for (const request of requests) {
    assert.equal(request.url.searchParams.has("limit"), false);
    assert.equal(request.init.headers["x-trading-token"], "secret-value");
    assert.equal(request.init.method, "GET");
  }
});

test("accepts an expired historical row alongside active and explicitly closed positions", async () => {
  const expired = sourcePosition("signal-expired", {
    sourceStatus: "expired",
    sourceUpdatedAt: asOf,
    sourceClosedAt: asOf,
    sourceExitPrice: "12.25",
  });
  const payload = {
    asOf,
    nextAfterId: null,
    positions: [
      expired,
      sourcePosition("signal-active"),
      closedPosition("signal-closed"),
    ],
  };
  const result = await fetchBulletPositions({
    token: "x",
    clock: () => now,
    fetchImpl: async () => response(payload),
  });

  assert.deepEqual([...result.positions.keys()], [
    "signal-expired",
    "signal-active",
    "signal-closed",
  ]);
  assert.equal(result.positions.get("signal-expired").sourceStatus, "expired");
  assert.equal(result.positions.get("signal-expired").sourceClosedAt, asOf);
  assert.equal(result.positions.get("signal-expired").sourceExitPrice, "12.25");
  assert.equal(result.positions.get("signal-active").sourceStatus, "active");
  assert.equal(result.positions.get("signal-closed").sourceStatus, "profit");
});

test("accepts expired source status without claiming missing closure evidence", async () => {
  const result = await fetchBulletPositions({
    token: "x",
    clock: () => now,
    fetchImpl: async () => response({
      asOf,
      nextAfterId: null,
      positions: [sourcePosition("expired-unclosed", { sourceStatus: "expired" })],
    }),
  });
  const expired = result.positions.get("expired-unclosed");
  assert.equal(expired.sourceStatus, "expired");
  assert.equal(expired.sourceClosedAt, null);
  assert.equal(expired.sourceExitPrice, null);
});

test("rejects invalid, stale, or inconsistent responses", async (t) => {
  const cases = [
    ["missing envelope fields", { asOf, positions: [] }, "incomplete_response"],
    ["invalid source status", { asOf, nextAfterId: null, positions: [sourcePosition(1, { sourceStatus: "unknown" })] }, "invalid_source_status"],
    ["terminal position without exit price", { asOf, nextAfterId: null, positions: [sourcePosition(1, { sourceStatus: "profit", sourceClosedAt: asOf })] }, "invalid_response"],
    ["stale snapshot", {
      asOf: "2025-12-31T00:00:00.000Z",
      nextAfterId: null,
      positions: [sourcePosition(2, { sourceStatus: "expired" })],
    }, "stale_response"],
  ];
  for (const [name, payload, code] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        fetchBulletPositions({ token: "x", clock: () => now, fetchImpl: async () => response(payload) }),
        (error) => error instanceof BulletPositionSyncError && error.code === code,
      );
    });
  }
});

test("invalid source status diagnostics never echo untrusted status payloads", async () => {
  const untrustedStatus = "Bearer secret-value\narbitrary source fields";
  await assert.rejects(
    fetchBulletPositions({
      token: "x",
      clock: () => now,
      fetchImpl: async () => response({
        asOf,
        nextAfterId: null,
        positions: [sourcePosition(1, { sourceStatus: untrustedStatus })],
      }),
    }),
    (error) => {
      assert.equal(error.code, "invalid_source_status");
      assert.equal(error.message, "Position sync response contains an unsupported source status");
      assert.equal(error.message.includes("secret-value"), false);
      assert.equal(error.message.includes(untrustedStatus), false);
      return true;
    },
  );
});

test("an unrelated malformed position still rejects a page containing an expired row", async () => {
  await assert.rejects(
    fetchBulletPositions({
      token: "x",
      clock: () => now,
      fetchImpl: async () => response({
        asOf,
        nextAfterId: null,
        positions: [
          sourcePosition("signal-expired", { sourceStatus: "expired" }),
          sourcePosition("signal-malformed", { symbol: "" }),
        ],
      }),
    }),
    (error) => error.code === "invalid_response" &&
      error.message === "Position sync response contains an invalid symbol",
  );
});

test("fails closed on duplicate ids and stalled cursors", async (t) => {
  await t.test("duplicate position ids across pages", async () => {
    const pages = [
      response({ asOf, nextAfterId: 2, positions: [sourcePosition(1)] }),
      response({ asOf, nextAfterId: null, positions: [sourcePosition(1)] }),
    ];
    await assert.rejects(
      fetchBulletPositions({ token: "x", clock: () => now, fetchImpl: async () => pages.shift() }),
      (error) => error.code === "duplicate_id",
    );
  });

  await t.test("cursor cannot repeat", async () => {
    let calls = 0;
    await assert.rejects(
      fetchBulletPositions({
        token: "x",
        clock: () => now,
        fetchImpl: async () => {
          calls += 1;
          return response({ asOf, nextAfterId: 2, positions: [sourcePosition(calls)] });
        },
      }),
      (error) => error.code === "cursor_stalled",
    );
    assert.equal(calls, 2);
  });
});

test("reclassified source positions are not treated as closed without explicit terminal closure", async () => {
  const position = sourcePosition("signal-3", {
    sourceStatus: "reclassified",
    sourceClosedAt: null,
    sourceExitPrice: null,
  });
  const result = await fetchBulletPositions({
    token: "x",
    clock: () => now,
    fetchImpl: async () => response({ asOf, nextAfterId: null, positions: [position] }),
  });
  assert.equal(result.positions.get("signal-3").sourceStatus, "reclassified");
  assert.equal(result.positions.get("signal-3").sourceClosedAt, null);
});

test("preserves large string cursors and never sends limit or pageSize", async () => {
  const largeCursor = "9223372036854775000";
  let callCount = 0;
  const result = await fetchBulletPositions({
    token: "x",
    clock: () => now,
    fetchImpl: async (url) => {
      callCount += 1;
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.has("limit"), false);
      assert.equal(parsed.searchParams.has("pageSize"), false);
      if (callCount === 1) {
        return response({ asOf, nextAfterId: largeCursor, positions: [sourcePosition("signal-a")] });
      }
      assert.equal(parsed.searchParams.get("afterId"), largeCursor);
      return response({ asOf, nextAfterId: null, positions: [sourcePosition("signal-b")] });
    },
  });
  assert.equal(callCount, 2);
  assert.equal(result.positions.size, 2);
});

test("does not include token values in surfaced network errors", async () => {
  await assert.rejects(
    fetchBulletPositions({
      token: "do-not-leak-this",
      clock: () => now,
      fetchImpl: async () => { throw new Error("network rejected request"); },
    }),
    (error) => {
      assert.equal(error.code, "request_failed");
      assert.equal(error.message.includes("do-not-leak-this"), false);
      return true;
    },
  );
});