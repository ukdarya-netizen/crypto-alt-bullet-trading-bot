import assert from "node:assert/strict";
import test from "node:test";
import { createVstStore } from "../vst-store.mjs";

// A minimal pool double for listErrorPositions: a single joined SELECT, no
// transaction involved.
function listErrorPositionsTestPool(rows) {
  return {
    async query(sql) {
      assert.match(sql, /FROM vst_positions p/);
      assert.match(sql, /JOIN vst_signals s/);
      assert.match(sql, /WHERE p\.status = 'error'/);
      return { rowCount: rows.length, rows };
    },
    async connect() { throw new Error("not needed"); },
  };
}

// A minimal pool + client double for exercising the real
// resolvePositionAsClosed / resolvePositionAsStillOpen transactions (a
// locked SELECT, then UPDATE vst_positions, UPDATE vst_signals, and INSERT
// vst_events) without a live database.
function reviewResolutionTestPool({ positionRow, signalRow, unresolvedPreRunnerClose = false }) {
  let position = positionRow ? {
    ...positionRow,
    snapshot: {
      environment: "vst",
      accountId: "account-test",
      symbol: positionRow.symbol,
      ...positionRow.snapshot,
    },
  } : null;
  let signal = signalRow ? { ...signalRow } : null;
  const events = [];
  const client = {
    async query(sql, params = []) {
      const trimmed = sql.trim();
      if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK") {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("FROM vst_order_intents")) {
        const rows = unresolvedPreRunnerClose ? [{ client_order_id: "vst-legacy-unknown" }] : [];
        return { rowCount: rows.length, rows };
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("FROM vst_positions") && sql.includes("FOR UPDATE")) {
        const [sourceSignalId] = params;
        const match = position && position.source_signal_id === sourceSignalId ? position : null;
        return { rowCount: match ? 1 : 0, rows: match ? [match] : [] };
      }
      if (sql.includes("UPDATE vst_positions SET status =")) {
        const [sourceSignalId, snapshotJson] = params;
        const status = sql.includes("status = 'closed'") ? "closed" : "open";
        position = {
          ...position,
          source_signal_id: sourceSignalId,
          status,
          snapshot: JSON.parse(snapshotJson),
          updated_at: new Date().toISOString(),
        };
        return { rowCount: 1, rows: [position] };
      }
      if (sql.includes("UPDATE vst_signals SET status =")) {
        const [sourceSignalId] = params;
        if (!signal || signal.source_signal_id !== sourceSignalId) return { rowCount: 0, rows: [] };
        const status = sql.includes("status = 'closed'") ? "closed" : "open";
        signal = { ...signal, status, reason: null };
        return { rowCount: 1, rows: [{ source_signal_id: sourceSignalId }] };
      }
      if (sql.includes("INSERT INTO vst_events")) {
        events.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query in reviewResolutionTestPool: ${sql}`);
    },
    release() {},
  };
  return {
    events,
    getPosition: () => position,
    getSignal: () => signal,
    async connect() { return client; },
    async query() { throw new Error("not needed at pool level"); },
  };
}

const baseFill = {
  price: "22.7",
  quantity: "12",
  at: "2026-09-27T11:00:00.000Z",
  exchangeOrderId: "9988776655",
  fee: { asset: "USDT", amount: "0.05" },
};
const exchangeFlatCheck = {
  verified: true,
  environment: "vst",
  accountId: "account-test",
  symbol: "ENSUSDT",
  positionQuantity: "0",
  openOrderCount: 0,
  observedAt: "2026-09-27T11:01:00.000Z",
};

test("generic owner open/closed forms cannot bypass an unresolved pre-runner close under the transaction lock", async () => {
  const pool = reviewResolutionTestPool({
    positionRow: {
      source_signal_id: "cab-signal-review-1", symbol: "ENSUSDT",
      status: "error", snapshot: { remainingQty: 12 },
    },
    signalRow: { source_signal_id: "cab-signal-review-1", status: "unknown" },
    unresolvedPreRunnerClose: true,
  });
  const store = createVstStore(pool);
  await assert.rejects(store.resolvePositionAsStillOpen("cab-signal-review-1", {
    remainingQty: "12", resolvedBy: "owner",
  }), /vst_legacy_pre_runner_close_review_required/);
  await assert.rejects(store.resolvePositionAsClosed("cab-signal-review-1", {
    fill: baseFill, resolvedBy: "owner", exchangeFlatCheck,
  }), /vst_legacy_pre_runner_close_review_required/);
  assert.equal(pool.getPosition().status, "error");
  assert.equal(pool.getSignal().status, "unknown");
  assert.equal(pool.events.length, 0);
});

test("listErrorPositions lists positions stuck in review joined with their signal reason", async () => {
  const rows = [
    {
      source_signal_id: "cab-signal-review-1",
      symbol: "ENSUSDT",
      status: "error",
      snapshot: {
        remainingQty: 12,
        verifiedFill: { price: "22.5" },
        protectiveStops: [{ stopPrice: "21.0" }],
      },
      updated_at: "2026-09-27T10:00:00.000Z",
      signal_reason: "close_leg_abandoned_unconfirmed_outcome",
    },
  ];
  const store = createVstStore(listErrorPositionsTestPool(rows));
  const positions = await store.listErrorPositions();
  assert.equal(positions.length, 1);
  assert.equal(positions[0].sourceSignalId, "cab-signal-review-1");
  assert.equal(positions[0].status, "error");
  assert.equal(positions[0].signalReason, "close_leg_abandoned_unconfirmed_outcome");
});

test("resolvePositionAsClosed closes a position from complete owner-attested fill facts", async () => {
  const positionRow = {
    source_signal_id: "cab-signal-review-1",
    symbol: "ENSUSDT",
    status: "error",
    snapshot: {
      remainingQty: 12, coreQty: 12, runnerQty: 0, coreOpen: true, runnerOpen: false,
    },
    updated_at: "2026-09-27T10:00:00.000Z",
  };
  const signalRow = {
    source_signal_id: "cab-signal-review-1", status: "error",
    reason: "close_leg_abandoned_unconfirmed_outcome",
  };
  const pool = reviewResolutionTestPool({ positionRow, signalRow });
  const store = createVstStore(pool);
  const result = await store.resolvePositionAsClosed("cab-signal-review-1", {
    fill: baseFill,
    resolvedBy: "owner-user-id",
    note: "Confirmed closed manually on BingX",
    exchangeFlatCheck,
  });
  assert.equal(result.status, "closed");
  assert.equal(pool.getSignal().status, "closed");
  assert.equal(pool.getSignal().reason, null);
  const snapshot = pool.getPosition().snapshot;
  assert.equal(snapshot.remainingQty, 0);
  assert.equal(snapshot.coreQty, 0);
  assert.equal(snapshot.runnerQty, 0);
  assert.equal(snapshot.coreOpen, false);
  assert.equal(snapshot.runnerOpen, false);
  assert.equal(snapshot.closeFill.price, "22.7");
  assert.equal(snapshot.closeFill.exchangeOrderId, "9988776655");
  assert.equal(snapshot.closeFill.provenance, "owner_attested");
  assert.equal(snapshot.manualResolution.outcome, "closed");
  assert.equal(snapshot.manualResolution.resolvedBy, "owner-user-id");
  assert.equal(snapshot.manualResolution.previousStatus, "error");
  assert.equal(snapshot.manualResolution.provenance, "owner_attested");
  assert.equal(snapshot.manualResolution.exchangeFlatCheck.verified, true);
  assert.equal(pool.events.length, 1);
  assert.match(pool.events[0].sql, /vst_manual_resolution_closed/);
});

test("resolvePositionAsClosed rejects partial and oversized fills without closing the ledger", async () => {
  for (const quantity of ["11", "13", "12.000000000001"]) {
    const pool = reviewResolutionTestPool({
      positionRow: {
        source_signal_id: "s1", symbol: "ENSUSDT", status: "error",
        snapshot: { remainingQty: "12.000000000000" },
      },
      signalRow: { source_signal_id: "s1", status: "error", reason: "review" },
    });
    await assert.rejects(
      createVstStore(pool).resolvePositionAsClosed("s1", {
        fill: { ...baseFill, quantity }, resolvedBy: "owner-user-id", exchangeFlatCheck,
      }),
      /vst_manual_close_quantity_mismatch/,
    );
    assert.equal(pool.getPosition().status, "error");
    assert.equal(pool.getSignal().status, "error");
    assert.equal(pool.events.length, 0);
  }
});

test("resolvePositionAsClosed compares decimal quantities exactly and fails closed without a stored remainder", async () => {
  const row = {
    source_signal_id: "s1", symbol: "ENSUSDT", status: "error",
    snapshot: { remainingQty: "12.000000000000" },
  };
  const signal = { source_signal_id: "s1", status: "error", reason: "review" };
  const pool = reviewResolutionTestPool({ positionRow: row, signalRow: signal });
  await createVstStore(pool).resolvePositionAsClosed("s1", {
    fill: { ...baseFill, quantity: "12" }, resolvedBy: "owner-user-id", exchangeFlatCheck,
  });
  assert.equal(pool.getPosition().status, "closed");
  const missing = reviewResolutionTestPool({
    positionRow: { ...row, snapshot: {} }, signalRow: signal,
  });
  await assert.rejects(
    createVstStore(missing).resolvePositionAsClosed("s1", {
      fill: baseFill, resolvedBy: "owner-user-id", exchangeFlatCheck,
    }),
    /stored remainingQty/,
  );
  assert.equal(missing.getPosition().status, "error");
});

test("resolvePositionAsClosed rejects an unknown position", async () => {
  const pool = reviewResolutionTestPool({ positionRow: null, signalRow: null });
  const store = createVstStore(pool);
  await assert.rejects(
    store.resolvePositionAsClosed("missing-signal", {
      fill: baseFill, resolvedBy: "owner-user-id", exchangeFlatCheck,
    }),
    /vst_position_not_found/,
  );
});

test("resolvePositionAsClosed refuses a position that is not awaiting review", async () => {
  const positionRow = {
    source_signal_id: "s1", symbol: "ENSUSDT", status: "open",
    snapshot: {}, updated_at: "2026-09-27T10:00:00.000Z",
  };
  const signalRow = { source_signal_id: "s1", status: "open", reason: null };
  const store = createVstStore(reviewResolutionTestPool({ positionRow, signalRow }));
  await assert.rejects(
    store.resolvePositionAsClosed("s1", {
      fill: baseFill, resolvedBy: "owner-user-id", exchangeFlatCheck,
    }),
    /vst_position_not_in_error_status/,
  );
});

test("resolvePositionAsClosed never fabricates a fill from incomplete evidence", async () => {
  const positionRow = {
    source_signal_id: "s1", symbol: "ENSUSDT", status: "error",
    snapshot: {}, updated_at: "2026-09-27T10:00:00.000Z",
  };
  const signalRow = { source_signal_id: "s1", status: "error", reason: "x" };
  const store = createVstStore(reviewResolutionTestPool({ positionRow, signalRow }));
  const { exchangeOrderId: _dropped, ...incompleteFill } = baseFill;
  await assert.rejects(
    store.resolvePositionAsClosed("s1", {
      fill: incompleteFill, resolvedBy: "owner-user-id", exchangeFlatCheck,
    }),
    TypeError,
  );
});

test("resolvePositionAsStillOpen re-arms management with the owner-confirmed quantity", async () => {
  const positionRow = {
    source_signal_id: "s1", symbol: "ENSUSDT", status: "error",
    snapshot: { remainingQty: 12, coreQty: 12, runnerQty: 0 },
    updated_at: "2026-09-27T10:00:00.000Z",
  };
  const signalRow = { source_signal_id: "s1", status: "error", reason: "x" };
  const pool = reviewResolutionTestPool({ positionRow, signalRow });
  const store = createVstStore(pool);
  const result = await store.resolvePositionAsStillOpen("s1", {
    remainingQty: "12", resolvedBy: "owner-user-id", note: null,
  });
  assert.equal(result.status, "open");
  assert.equal(pool.getSignal().status, "open");
  const snapshot = pool.getPosition().snapshot;
  assert.equal(snapshot.remainingQty, 12);
  assert.equal(snapshot.coreQty, 12);
  assert.equal(snapshot.manualResolution.outcome, "still_open");
  assert.equal(pool.events.length, 1);
  assert.match(pool.events[0].sql, /vst_manual_resolution_still_open/);
});

test("resolvePositionAsStillOpen leaves both legs untouched when it cannot tell which one the quantity belongs to", async () => {
  const positionRow = {
    source_signal_id: "s1", symbol: "ENSUSDT", status: "error",
    snapshot: { remainingQty: 20, coreQty: 12, runnerQty: 8 },
    updated_at: "2026-09-27T10:00:00.000Z",
  };
  const signalRow = { source_signal_id: "s1", status: "error", reason: "x" };
  const store = createVstStore(reviewResolutionTestPool({ positionRow, signalRow }));
  const result = await store.resolvePositionAsStillOpen("s1", { remainingQty: "15", resolvedBy: "owner-user-id" });
  assert.equal(result.status, "open");
});

test("resolvePositionAsStillOpen rejects a position that is not awaiting review", async () => {
  const positionRow = {
    source_signal_id: "s1", symbol: "ENSUSDT", status: "closed",
    snapshot: {}, updated_at: "2026-09-27T10:00:00.000Z",
  };
  const signalRow = { source_signal_id: "s1", status: "closed", reason: null };
  const store = createVstStore(reviewResolutionTestPool({ positionRow, signalRow }));
  await assert.rejects(
    store.resolvePositionAsStillOpen("s1", { remainingQty: "1", resolvedBy: "owner-user-id" }),
    /vst_position_not_in_error_status/,
  );
});

test("resolvePositionAsStillOpen requires an explicit owner-supplied quantity rather than defaulting", async () => {
  const positionRow = {
    source_signal_id: "s1", symbol: "ENSUSDT", status: "error",
    snapshot: { remainingQty: 12 }, updated_at: "2026-09-27T10:00:00.000Z",
  };
  const signalRow = { source_signal_id: "s1", status: "error", reason: "x" };
  const store = createVstStore(reviewResolutionTestPool({ positionRow, signalRow }));
  await assert.rejects(
    store.resolvePositionAsStillOpen("s1", { remainingQty: undefined, resolvedBy: "owner-user-id" }),
    TypeError,
  );
});

test("resolvePositionAsStillOpen rejects a zero remaining quantity instead of re-arming a flat position as open", async () => {
  const positionRow = {
    source_signal_id: "s1", symbol: "ENSUSDT", status: "error",
    snapshot: { remainingQty: 12 }, updated_at: "2026-09-27T10:00:00.000Z",
  };
  const signalRow = { source_signal_id: "s1", status: "error", reason: "x" };
  const pool = reviewResolutionTestPool({ positionRow, signalRow });
  const store = createVstStore(pool);
  await assert.rejects(
    store.resolvePositionAsStillOpen("s1", { remainingQty: "0", resolvedBy: "owner-user-id" }),
    TypeError,
  );
  // The rejected attempt must never have reached the database writes.
  assert.equal(pool.getPosition().status, "error");
  assert.equal(pool.getSignal().status, "error");
});

test("resolvePositionAsClosed accepts a VST-denominated fee exactly as the owner reports it, never assuming USDT", async () => {
  const positionRow = {
    source_signal_id: "s1", symbol: "ENSUSDT", status: "error",
    snapshot: { remainingQty: 12, coreQty: 12, runnerQty: 0 },
    updated_at: "2026-09-27T10:00:00.000Z",
  };
  const signalRow = { source_signal_id: "s1", status: "error", reason: "x" };
  const pool = reviewResolutionTestPool({ positionRow, signalRow });
  const store = createVstStore(pool);
  const result = await store.resolvePositionAsClosed("s1", {
    fill: { ...baseFill, fee: { asset: "VST", amount: "0.02" } },
    resolvedBy: "owner-user-id",
    exchangeFlatCheck,
  });
  assert.equal(result.status, "closed");
  const snapshot = pool.getPosition().snapshot;
  assert.equal(snapshot.closeFill.fee.asset, "VST");
  assert.equal(snapshot.closeFill.fee.amount, "0.02");
});

test("resolvePositionAsClosed refuses owner-attested facts without a verified flat-account check", async () => {
  const pool = reviewResolutionTestPool({
    positionRow: {
      source_signal_id: "s1", symbol: "ENSUSDT", status: "error",
      snapshot: { remainingQty: 12 },
    },
    signalRow: { source_signal_id: "s1", status: "error", reason: "review" },
  });
  await assert.rejects(
    createVstStore(pool).resolvePositionAsClosed("s1", {
      fill: baseFill, resolvedBy: "owner-user-id",
    }),
    /vst_manual_close_exchange_verification_required/,
  );
  assert.equal(pool.getPosition().status, "error");
  assert.equal(pool.getSignal().status, "error");
  assert.equal(pool.events.length, 0);
});

test("resolvePositionAsClosed rejects a mismatched or non-flat check inside the ledger transaction", async () => {
  for (const exchangeFlatCheckOverride of [
    { accountId: "another-account" },
    { environment: "real" },
    { symbol: "BTCUSDT" },
    { positionQuantity: "12" },
    { openOrderCount: 1 },
  ]) {
    const pool = reviewResolutionTestPool({
      positionRow: {
        source_signal_id: "s1", symbol: "ENSUSDT", status: "error",
        snapshot: { remainingQty: 12 },
      },
      signalRow: { source_signal_id: "s1", status: "error", reason: "review" },
    });
    await assert.rejects(
      createVstStore(pool).resolvePositionAsClosed("s1", {
        fill: baseFill,
        resolvedBy: "owner-user-id",
        exchangeFlatCheck: { ...exchangeFlatCheck, ...exchangeFlatCheckOverride },
      }),
      /vst_manual_close_exchange_flat_check_invalid/,
    );
    assert.equal(pool.getPosition().status, "error");
    assert.equal(pool.events.length, 0);
  }
});

test("resolvePositionAsClosed rejects a blank fee amount instead of silently defaulting it to zero", async () => {
  const positionRow = {
    source_signal_id: "s1", symbol: "ENSUSDT", status: "error",
    snapshot: {}, updated_at: "2026-09-27T10:00:00.000Z",
  };
  const signalRow = { source_signal_id: "s1", status: "error", reason: "x" };
  const pool = reviewResolutionTestPool({ positionRow, signalRow });
  const store = createVstStore(pool);
  await assert.rejects(
    store.resolvePositionAsClosed("s1", {
      fill: { ...baseFill, fee: { asset: "USDT", amount: "" } },
      resolvedBy: "owner-user-id",
      exchangeFlatCheck,
    }),
    TypeError,
  );
  assert.equal(pool.getPosition().status, "error");
});

test("resolvePositionAsClosed rejects a blank fee asset instead of assuming USDT", async () => {
  const positionRow = {
    source_signal_id: "s1", symbol: "ENSUSDT", status: "error",
    snapshot: {}, updated_at: "2026-09-27T10:00:00.000Z",
  };
  const signalRow = { source_signal_id: "s1", status: "error", reason: "x" };
  const store = createVstStore(reviewResolutionTestPool({ positionRow, signalRow }));
  await assert.rejects(
    store.resolvePositionAsClosed("s1", {
      fill: { ...baseFill, fee: { asset: "", amount: "0.05" } },
      resolvedBy: "owner-user-id",
      exchangeFlatCheck,
    }),
    TypeError,
  );
});
