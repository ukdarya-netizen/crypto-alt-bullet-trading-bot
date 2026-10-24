import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { collectCompleteFillHistory } from "../bingx-fill-history.mjs";
import { createVstStore } from "../vst-store.mjs";
import { createVstFillArchiveScheduler } from "../vst-fill-archive-scheduler.mjs";

function archivePool() {
  const rows = [];
  const fills = new Map();
  let nextId = 1;
  const query = async (sql, params = []) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" ||
        sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
    if (sql.includes("UPDATE vst_fill_archive_windows")) {
      const overlapping = sql.includes("id = ANY")
        ? rows.filter((row) => params[0].includes(row.id) && row.invalidatedAt === null)
        : rows.filter((row) => row.environment === "vst" &&
        row.accountId === params[0] && row.currency === params[1] &&
        row.startTs < Number(params[3]) && row.endTs > Number(params[2]) &&
        row.invalidatedAt === null);
      for (const row of overlapping) {
        row.invalidatedAt = new Date().toISOString();
        row.invalidationReason = sql.includes("id = ANY")
          ? "successful_snapshot_contradiction" : params[4];
      }
      return { rows: overlapping.map((row) => ({ id: row.id })), rowCount: overlapping.length };
    }
    if (sql.includes("SELECT id, archive_window")) {
      const selected = rows.filter((row) => row.environment === "vst" &&
        row.accountId === params[0] && row.currency === params[1] &&
        row.startTs < Number(params[3]) && row.endTs > Number(params[2]) &&
        row.invalidatedAt === null);
      return {
        rows: selected.map((row) => ({ id: row.id, archive_window: row.archiveWindow })),
        rowCount: selected.length,
      };
    }
    if (sql.includes("INSERT INTO vst_fill_archive_fills")) {
      const key = `vst:${params[0]}:USDT:${params[1]}:${params[2]}`;
      if (fills.has(key)) return { rows: [], rowCount: 0 };
      const rawFill = JSON.parse(params[3]);
      fills.set(key, rawFill);
      return { rows: [{ raw_fill: rawFill }], rowCount: 1 };
    }
    if (sql.includes("SELECT raw_fill FROM vst_fill_archive_fills")) {
      const key = `vst:${params[0]}:USDT:${params[1]}:${params[2]}`;
      return fills.has(key)
        ? { rows: [{ raw_fill: fills.get(key) }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO vst_fill_archive_windows")) {
      const archiveWindow = JSON.parse(params[5]);
      const observationKey = [
        "vst", params[0], params[1], params[2], params[3], params[4], params[6],
      ].join(":");
      if (rows.some((row) => row.observationKey === observationKey)) {
        return { rows: [], rowCount: 0 };
      }
      const row = {
        id: nextId++, environment: "vst", accountId: params[0], currency: params[1],
        startTs: Number(params[2]), endTs: Number(params[3]),
        windowHash: params[4], observedAt: params[6], archiveWindow, observationKey,
        invalidatedAt: null, invalidationReason: null,
      };
      rows.push(row);
      return { rows: [{ archive_window: archiveWindow }], rowCount: 1 };
    }
    if (sql.includes("SELECT window_hash, archive_window")) {
      if (sql.includes("invalidated_at IS NULL")) {
        const row = rows.find((candidate) => candidate.environment === "vst" &&
          candidate.accountId === params[0] && candidate.currency === params[1] &&
          candidate.startTs === Number(params[2]) && candidate.endTs === Number(params[3]) &&
          candidate.observedAt === params[4] && candidate.invalidatedAt === null);
        return row
          ? { rows: [{ window_hash: row.windowHash, archive_window: row.archiveWindow }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      const row = rows.find((candidate) => candidate.environment === "vst" &&
        candidate.accountId === params[0] && candidate.currency === params[1] &&
        candidate.startTs === Number(params[2]) && candidate.endTs === Number(params[3]) &&
        candidate.windowHash === params[4] && candidate.observedAt === params[5]);
      return row
        ? { rows: [{ window_hash: row.windowHash, archive_window: row.archiveWindow }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT archive_window") && sql.includes("FROM vst_fill_archive_windows")) {
      const selected = rows
        .filter((row) => row.environment === "vst" &&
          row.accountId === params[0] && row.currency === params[1] &&
          row.invalidatedAt === null &&
          (params[2] === null || row.endTs >= Number(params[2])) &&
          (params[3] === null || row.startTs <= Number(params[3])))
        .sort((a, b) => a.startTs - b.startTs || a.endTs - b.endTs ||
          a.observedAt.localeCompare(b.observedAt) || a.id - b.id);
      return {
        rows: selected.map((row) => ({ archive_window: row.archiveWindow })),
        rowCount: selected.length,
      };
    }
    if (sql.includes("SELECT start_ts::text AS start_ts")) {
      const selected = rows
        .filter((row) => row.environment === "vst" &&
          row.accountId === params[0] && row.currency === params[1])
        .sort((a, b) => a.startTs - b.startTs || a.endTs - b.endTs ||
          a.observedAt.localeCompare(b.observedAt) || a.id - b.id);
      return {
        rows: selected.map((row) => ({
          start_ts: String(row.startTs), end_ts: String(row.endTs),
          invalidated_at: row.invalidatedAt,
        })),
        rowCount: selected.length,
      };
    }
    throw new Error(`Unexpected archive test SQL: ${sql}`);
  };
  return {
    query,
    getFillCount: () => fills.size,
    getWindows: () => structuredClone(rows),
    async connect() {
      return { query, release() {} };
    },
  };
}

async function capture({
  startTs, endTs, accountId = "test-account", fills = [],
  archivedAt = new Date().toISOString(),
}) {
  const result = await collectCompleteFillHistory({
    startTs,
    endTs,
    currency: "USDT",
    clock: () => Date.parse(archivedAt),
    readPage: async ({ pageIndex }) => pageIndex === 1
      ? { fill_history_orders: fills, total: fills.length }
      : { fill_history_orders: [], total: fills.length },
  });
  return {
    environment: "vst",
    accountId,
    currency: "USDT",
    coverage: result.coverage,
    rawFills: result.fills,
    orders: [...new Map(fills.map((fill) => [String(fill.orderId), {
      symbol: fill.symbol,
      orderId: String(fill.orderId),
      orderID: String(fill.orderId),
      status: "FILLED",
      side: "BUY",
      positionSide: "LONG",
      type: "MARKET",
      origQty: fill.qty,
      executedQty: fill.qty,
    }])).values()],
    archivedAt,
  };
}

const fillAt = (timestamp, price = "100") => ({
  symbol: "BTC-USDT",
  tradeId: "7001",
  orderId: "8001",
  filledTime: new Date(timestamp).toISOString(),
  price,
  qty: "1",
});

test("VST archive retains repeated observations, filters by intersection, and cursor stops at gaps", async () => {
  const pool = archivePool();
  const store = createVstStore(pool);
  const now = Date.now();
  const a = await capture({
    startTs: now - 20_000, endTs: now - 15_000,
    fills: [fillAt(now - 18_000)],
    archivedAt: new Date(now - 300).toISOString(),
  });
  const repeat = { ...a, archivedAt: new Date(now - 200).toISOString() };
  const b = await capture({
    startTs: now - 15_000, endTs: now - 10_000,
    archivedAt: new Date(now - 100).toISOString(),
  });
  const gap = await capture({
    startTs: now - 5_000, endTs: now - 1_000,
    archivedAt: new Date(now).toISOString(),
  });

  assert.deepEqual(await store.saveFillArchiveWindow(a), a);
  assert.deepEqual(await store.saveFillArchiveWindow(a), a);
  assert.deepEqual(await store.saveFillArchiveWindow(repeat), repeat);
  await store.saveFillArchiveWindow(b);
  await store.saveFillArchiveWindow(gap);

  assert.equal((await store.listFillArchiveWindows({ accountId: "test-account" })).length, 4);
  assert.equal(pool.getFillCount(), 1);
  assert.deepEqual(
    await store.listFillArchiveWindows({
      accountId: "test-account", startTs: now - 15_000, endTs: now - 10_000,
    }),
    [a, repeat, b],
  );
  assert.equal(await store.getFillArchiveCursor({ accountId: "test-account" }), now - 10_000);
  assert.equal(await store.getFillArchiveCursor({ accountId: "another-account" }), null);
});

test("VST archive rejects changed raw content for an existing trade identity", async () => {
  const pool = archivePool();
  const store = createVstStore(pool);
  const now = Date.now();
  const startTs = now - 10_000;
  const endTs = now - 1_000;
  const first = await capture({
    startTs, endTs, fills: [fillAt(now - 5_000, "100")],
  });
  const changed = await capture({
    startTs: startTs + 1, endTs,
    fills: [fillAt(now - 5_000, "101")],
  });
  await store.saveFillArchiveWindow(first);
  await assert.rejects(
    store.saveFillArchiveWindow(changed),
    /vst_fill_archive_conflicting_trade_content/,
  );
  assert.deepEqual(await store.listFillArchiveWindows({ accountId: "test-account" }), [first]);
  assert.equal(pool.getFillCount(), 1);
});

test("successful added/removed fill snapshots atomically revoke older completeness", async () => {
  for (const change of ["added", "removed"]) {
    const pool = archivePool();
    const store = createVstStore(pool);
    const now = Date.now();
    const original = await capture({
      startTs: now - 20_000, endTs: now - 5_000,
      fills: change === "removed" ? [fillAt(now - 10_000)] : [],
      archivedAt: new Date(now - 100).toISOString(),
    });
    const replacement = await capture({
      startTs: original.coverage.startTs, endTs: original.coverage.endTs,
      fills: change === "added" ? [fillAt(now - 10_000)] : [],
      archivedAt: new Date(now).toISOString(),
    });
    await store.saveFillArchiveWindow(original);
    const alreadyBuiltProof = { archiveWindows: [structuredClone(original)] };
    await store.saveFillArchiveWindow(replacement);
    assert.deepEqual(await store.listFillArchiveWindows({ accountId: "test-account" }),
      [replacement], change);
    assert.deepEqual(pool.getWindows()[0].archiveWindow, original);
    assert.equal(pool.getWindows()[0].invalidationReason, "successful_snapshot_contradiction");
    await assert.rejects(store.reconcileHistoricalClose({
      sourceSignalId: "built-before-refresh", snapshot: { accountId: "test-account" },
      symbol: "BTCUSDT",
    }, alreadyBuiltProof), /vst_fill_archive_window_not_persisted/);
    // Re-delivery of an older observation cannot revoke or resurrect anything.
    await store.saveFillArchiveWindow(original);
    assert.deepEqual(await store.listFillArchiveWindows({ accountId: "test-account" }),
      [replacement]);
  }
});

test("overlap comparisons detect set changes but ignore fills outside their intersection", async () => {
  const pool = archivePool();
  const store = createVstStore(pool);
  const now = Date.now();
  const outside = fillAt(now - 25_000);
  const broad = await capture({
    startTs: now - 30_000, endTs: now - 5_000, fills: [outside],
    archivedAt: new Date(now - 200).toISOString(),
  });
  const matchingOverlap = await capture({
    startTs: now - 20_000, endTs: now - 1_000, fills: [],
    archivedAt: new Date(now - 100).toISOString(),
  });
  await store.saveFillArchiveWindow(broad);
  await store.saveFillArchiveWindow(matchingOverlap);
  assert.equal((await store.listFillArchiveWindows({ accountId: "test-account" })).length, 2);
  const lateFill = { ...fillAt(now - 10_000), tradeId: "7002", orderId: "8002" };
  const changedOverlap = await capture({
    startTs: matchingOverlap.coverage.startTs,
    endTs: matchingOverlap.coverage.endTs,
    fills: [lateFill], archivedAt: new Date(now).toISOString(),
  });
  await store.saveFillArchiveWindow(changedOverlap);
  assert.deepEqual(await store.listFillArchiveWindows({ accountId: "test-account" }),
    [changedOverlap]);
  assert.ok(pool.getWindows().slice(0, 2).every((row) =>
    row.invalidationReason === "successful_snapshot_contradiction"));
});

test("a slow older contradictory capture cannot revoke a later stable observation", async () => {
  const pool = archivePool();
  const store = createVstStore(pool);
  const now = Date.now();
  const range = { startTs: now - 20_000, endTs: now - 5_000 };
  const older = await capture({
    ...range, fills: [], archivedAt: new Date(now - 100).toISOString(),
  });
  const newer = await capture({
    ...range, fills: [fillAt(now - 10_000)], archivedAt: new Date(now).toISOString(),
  });
  await store.saveFillArchiveWindow(newer);
  await assert.rejects(store.saveFillArchiveWindow(older),
    /vst_fill_archive_stale_contradictory_observation/);
  assert.deepEqual(await store.listFillArchiveWindows({ accountId: "test-account" }), [newer]);
});

test("invalidation excludes shared (start,end] boundaries from neighboring windows", async () => {
  const pool = archivePool();
  const store = createVstStore(pool);
  const now = Date.now();
  const windows = [];
  for (let index = 0; index < 3; index += 1) {
    const window = await capture({
      startTs: now - 30_000 + index * 5_000,
      endTs: now - 25_000 + index * 5_000,
      archivedAt: new Date(now).toISOString(),
    });
    windows.push(window);
    await store.saveFillArchiveWindow(window);
  }
  assert.equal(await store.invalidateFillArchiveWindows({
    accountId: "test-account",
    startTs: windows[1].coverage.startTs,
    endTs: windows[1].coverage.endTs,
    reason: "saturated",
  }), 1);
  assert.deepEqual(await store.listFillArchiveWindows({ accountId: "test-account" }),
    [windows[0], windows[2]]);
  assert.equal(await store.getFillArchiveCursor({ accountId: "test-account" }),
    windows[0].coverage.endTs);
});

test("earliest refresh gap survives exhausted retries/call budget and scheduler restart", async () => {
  for (const budget of [24, 2]) {
    const pool = archivePool();
    const store = createVstStore(pool);
    const now = Date.now();
    const originalStart = now - 180_000;
    const firstEnd = now - 120_000;
    const tail = now - 60_000;
    const first = await capture({
      startTs: originalStart, endTs: firstEnd,
      archivedAt: new Date(now - 200).toISOString(),
    });
    const second = await capture({
      startTs: firstEnd, endTs: tail,
      archivedAt: new Date(now - 100).toISOString(),
    });
    await store.saveFillArchiveWindow(first);
    await store.saveFillArchiveWindow(second);
    const ranges = [];
    let failRefresh = true;
    let clock = now - 5 * 60_000;
    const broker = {
      captureFillArchiveWindow: async ({ startTs, endTs }) => {
        ranges.push({ startTs, endTs });
        if (failRefresh) throw new Error("bingx_complete_fill_history_snapshot_changed");
        return Object.freeze(await capture({
          startTs, endTs, archivedAt: new Date(now).toISOString(),
        }));
      },
    };
    const options = {
      broker, store, accountId: "test-account", now: () => clock,
      maxCallsPerCycle: budget, retryDelayMs: 0,
      setTimeoutFn: (callback, ms) => ({ handle: setTimeout(callback, ms) }),
      clearTimeoutFn: (timer) => clearTimeout(timer.handle),
    };
    const beforeRestart = createVstFillArchiveScheduler(options);
    clock = now;
    const failed = await beforeRestart.pollNow();
    assert.equal(failed.kind, "error");
    assert.equal(failed.calls, Math.min(3, budget));
    assert.equal(failed.caughtUp, false);
    assert.equal(await store.getFillArchiveCursor({ accountId: "test-account" }),
      originalStart);
    assert.deepEqual(await store.listFillArchiveWindows({ accountId: "test-account" }),
      [second]);
    beforeRestart.stop();

    failRefresh = false;
    ranges.length = 0;
    // New scheduler and store instances know nothing about the previous poll;
    // the archived invalidated row alone preserves the missing prefix.
    const afterRestart = createVstFillArchiveScheduler({
      ...options, store: createVstStore(pool),
    });
    const recovered = await afterRestart.pollNow();
    assert.equal(recovered.kind, "ok");
    assert.equal(recovered.caughtUp, true);
    assert.equal(ranges[0].startTs, originalStart);
    assert.ok(ranges[0].endTs >= firstEnd);
    assert.equal(await store.getFillArchiveCursor({ accountId: "test-account" }), tail);
    afterRestart.stop();
  }
});

test("invalidated archive windows stay excluded until a new observation is saved", async () => {
  const pool = archivePool();
  const store = createVstStore(pool);
  const now = Date.now();
  const original = await capture({
    startTs: now - 10_000, endTs: now - 2_000,
    fills: [fillAt(now - 5_000)],
    archivedAt: new Date(now - 100).toISOString(),
  });
  const replacement = { ...original, archivedAt: new Date(now).toISOString() };

  await store.saveFillArchiveWindow(original);
  assert.equal(await store.invalidateFillArchiveWindows({
    accountId: "test-account", startTs: original.coverage.startTs,
    endTs: original.coverage.endTs, reason: "snapshot_changed",
  }), 1);

  assert.deepEqual(pool.getWindows()[0].archiveWindow, original);
  assert.equal(pool.getWindows()[0].invalidationReason, "snapshot_changed");
  assert.deepEqual(await store.listFillArchiveWindows({ accountId: "test-account" }), []);
  assert.equal(await store.getFillArchiveCursor({ accountId: "test-account" }),
    original.coverage.startTs);
  await assert.rejects(
    store.reconcileHistoricalClose(
      {
        sourceSignalId: "test-signal",
        snapshot: { accountId: "test-account" },
        symbol: "BTCUSDT",
      },
      { archiveWindows: [original] },
    ),
    /vst_fill_archive_window_not_persisted/,
  );

  // A retry of the same observation is idempotent but cannot resurrect it.
  assert.deepEqual(await store.saveFillArchiveWindow(original), original);
  assert.deepEqual(await store.listFillArchiveWindows({ accountId: "test-account" }), []);

  await store.saveFillArchiveWindow(replacement);
  assert.deepEqual(
    await store.listFillArchiveWindows({ accountId: "test-account" }),
    [replacement],
  );
  assert.equal(
    await store.getFillArchiveCursor({ accountId: "test-account" }),
    replacement.coverage.endTs,
  );
});

test("real PostgreSQL archive store operations roll back their isolated development rows", {
  skip: process.env.VST_FILL_ARCHIVE_PG_INTEGRATION !== "development",
}, async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for opted-in development PostgreSQL integration tests");
  }
  const dbRequire = createRequire(new URL("../../../../../lib/db/package.json", import.meta.url));
  const { Pool } = dbRequire("pg");
  const databasePool = new Pool({ connectionString: process.env.DATABASE_URL });
  const databaseClient = await databasePool.connect();
  const accountId = `vst-fill-archive-test:${randomUUID()}`;
  let savepointNumber = 0;
  const savepoints = [];
  await databaseClient.query("BEGIN");
  const rollbackPool = {
    query: (sql, params) => databaseClient.query(sql, params),
    async connect() {
      return {
        async query(sql, params) {
          const statement = sql.trim().toUpperCase();
          if (statement === "BEGIN") {
            const name = `vst_archive_test_${++savepointNumber}`;
            savepoints.push(name);
            await databaseClient.query(`SAVEPOINT ${name}`);
            return { rows: [], rowCount: 0 };
          }
          if (statement === "COMMIT") {
            const name = savepoints.pop();
            await databaseClient.query(`RELEASE SAVEPOINT ${name}`);
            return { rows: [], rowCount: 0 };
          }
          if (statement === "ROLLBACK") {
            const name = savepoints.pop();
            await databaseClient.query(`ROLLBACK TO SAVEPOINT ${name}`);
            await databaseClient.query(`RELEASE SAVEPOINT ${name}`);
            return { rows: [], rowCount: 0 };
          }
          return databaseClient.query(sql, params);
        },
        release() {},
      };
    },
  };

  try {
    const store = createVstStore(rollbackPool);
    const endTs = Date.now() - 2_000;
    const startTs = endTs - 8_000;
    const fill = {
      symbol: "BTC-USDT",
      tradeId: String(Date.now()),
      orderId: String(Date.now() + 1),
      filledTime: new Date(endTs - 1_000).toISOString(),
      price: "100",
      qty: "1",
    };
    const original = await capture({
      accountId, startTs, endTs, fills: [fill],
      archivedAt: new Date(Date.now()).toISOString(),
    });
    assert.deepEqual(await store.saveFillArchiveWindow(original), original);
    assert.deepEqual(await store.saveFillArchiveWindow(original), original);
    assert.deepEqual(await store.listFillArchiveWindows({ accountId }), [original]);
    assert.equal(await store.getFillArchiveCursor({ accountId }), endTs);

    const rawRows = await rollbackPool.query(
      `SELECT count(*)::integer AS count
       FROM vst_fill_archive_fills
       WHERE environment = 'vst' AND account_id = $1 AND currency = 'USDT'
         AND symbol = $2 AND trade_id = $3`,
      [accountId, fill.symbol, fill.tradeId],
    );
    assert.equal(rawRows.rows[0].count, 1);

    const conflicting = await capture({
      accountId, startTs, endTs,
      fills: [{ ...fill, price: "101" }],
      archivedAt: new Date(Date.now() + 1).toISOString(),
    });
    await assert.rejects(
      store.saveFillArchiveWindow(conflicting),
      /vst_fill_archive_conflicting_trade_content/,
    );

    assert.equal(await store.invalidateFillArchiveWindows({
      accountId, startTs, endTs, reason: "snapshot_changed",
    }), 1);
    assert.deepEqual(await store.listFillArchiveWindows({ accountId }), []);
    assert.equal(await store.getFillArchiveCursor({ accountId }), startTs);
    await assert.rejects(
      store.reconcileHistoricalClose(
        { sourceSignalId: "integration", snapshot: { accountId }, symbol: "BTCUSDT" },
        { archiveWindows: [original] },
      ),
      /vst_fill_archive_window_not_persisted/,
    );

    const replacement = {
      ...original,
      archivedAt: new Date(Date.now() + 10_000).toISOString(),
    };
    assert.deepEqual(await store.saveFillArchiveWindow(replacement), replacement);
    assert.deepEqual(await store.listFillArchiveWindows({ accountId }), [replacement]);
    assert.equal(await store.getFillArchiveCursor({ accountId }), endTs);
    const removal = await capture({
      accountId, startTs, endTs, fills: [],
      archivedAt: new Date(Date.now() + 20_000).toISOString(),
    });
    await store.saveFillArchiveWindow(removal);
    assert.deepEqual(await store.listFillArchiveWindows({ accountId }), [removal]);
    await assert.rejects(store.reconcileHistoricalClose(
      { sourceSignalId: "already-built", snapshot: { accountId }, symbol: "BTCUSDT" },
      { archiveWindows: [replacement] },
    ), /vst_fill_archive_window_not_persisted/);
    const addition = await capture({
      accountId, startTs, endTs, fills: [fill],
      archivedAt: new Date(Date.now() + 30_000).toISOString(),
    });
    await store.saveFillArchiveWindow(addition);
    assert.deepEqual(await store.listFillArchiveWindows({ accountId }), [addition]);
    const invalidated = await rollbackPool.query(
      `SELECT invalidation_reason, archive_window FROM vst_fill_archive_windows
       WHERE account_id = $1 AND invalidation_reason = 'successful_snapshot_contradiction'`,
      [accountId],
    );
    assert.equal(invalidated.rowCount, 2);
    assert.ok(invalidated.rows.some((row) =>
      JSON.stringify(row.archive_window.rawFills) === JSON.stringify(removal.rawFills)));
    const prefixAccount = `${accountId}-prefix`;
    const prefix = await capture({
      accountId: prefixAccount, startTs, endTs,
      archivedAt: new Date(Date.now()).toISOString(),
    });
    const suffix = await capture({
      accountId: prefixAccount, startTs: endTs, endTs: endTs + 1_000,
      archivedAt: new Date(Date.now()).toISOString(),
    });
    await store.saveFillArchiveWindow(prefix);
    await store.saveFillArchiveWindow(suffix);
    await store.invalidateFillArchiveWindows({
      accountId: prefixAccount, startTs, endTs, reason: "snapshot_changed",
    });
    assert.equal(await store.getFillArchiveCursor({ accountId: prefixAccount }), startTs);
    const prefixReplacement = await capture({
      accountId: prefixAccount, startTs, endTs,
      archivedAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await store.saveFillArchiveWindow(prefixReplacement);
    assert.equal(await store.getFillArchiveCursor({ accountId: prefixAccount }), endTs + 1_000);
  } finally {
    try {
      await databaseClient.query("ROLLBACK");
    } finally {
      databaseClient.release();
      try {
        const remaining = await databasePool.query(
          `SELECT
             (SELECT count(*)::integer FROM vst_fill_archive_windows
              WHERE environment = 'vst' AND account_id = $1) AS windows,
             (SELECT count(*)::integer FROM vst_fill_archive_fills
              WHERE environment = 'vst' AND account_id = $1) AS fills`,
          [accountId],
        );
        assert.deepEqual(remaining.rows[0], { windows: 0, fills: 0 });
      } finally {
        await databasePool.end();
      }
    }
  }
});
