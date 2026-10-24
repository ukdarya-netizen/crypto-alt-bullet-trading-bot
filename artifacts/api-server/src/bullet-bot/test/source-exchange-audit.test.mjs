import assert from "node:assert/strict";
import test from "node:test";
import { auditExchangeSourcePositions } from "../source-exchange-audit.mjs";

function poolWithRows({ vst = [], live = [] } = {}) {
  const queries = [];
  return {
    queries,
    pool: {
      async query(sql) {
        queries.push(sql);
        if (sql.includes("FROM vst_positions")) return { rows: vst };
        if (sql.includes("FROM btb_live_position_snapshots")) return { rows: live };
        throw new Error("unexpected query");
      },
    },
  };
}

test("a fresh successful hold poll with an old or missing record-change time is not a source failure", async () => {
  const at = "2026-10-05T05:46:45.206Z";
  for (const sourceUpdatedAt of ["2026-10-05T04:47:57.129Z", null]) {
    const { pool } = poolWithRows({
      vst: [{ source_signal_id: "cab-signal-17327", symbol: "CTUSDT", status: "open" }],
    });
    const report = await auditExchangeSourcePositions({
      pool, asOf: at, observedAt: at,
      positions: new Map([["cab-signal-17327", {
        sourceSignalId: "cab-signal-17327", symbol: "CTUSDT",
        sourceAction: "hold", sourceStatus: "active", sourceUpdatedAt,
      }]]),
    });
    assert.equal(report.discrepancies.length, 0);
    assert.equal(report.ledgers.vst.matches.length, 1);
    assert.equal(report.observations[0].sourceUpdatedAt, sourceUpdatedAt);
    assert.equal(report.observations[0].sourceAsOf, at);
    assert.equal(report.observations[0].verification, "informational");
  }
});

test("a real source-close discrepancy retains the fresh poll and exact source facts despite old update time", async () => {
  const at = "2026-10-05T05:46:45.206Z";
  const closedAt = "2026-10-05T04:47:57.129Z";
  const { pool } = poolWithRows({
    vst: [{ source_signal_id: "cab-signal-17327", symbol: "CTUSDT", status: "closing" }],
  });
  const report = await auditExchangeSourcePositions({
    pool, asOf: at, observedAt: at,
    positions: new Map([["cab-signal-17327", {
      sourceSignalId: "cab-signal-17327", symbol: "CTUSDT", sourceAction: "close",
      sourceStatus: "profit", sourceClosedAt: closedAt, sourceUpdatedAt: closedAt,
    }]]),
  });
  assert.equal(report.discrepancies.length, 1);
  assert.equal(report.discrepancies[0].kind, "source_closed_while_local_active");
  assert.equal(report.discrepancies[0].verification, "discrepancy");
  assert.equal(report.discrepancies[0].sourceAction, "close");
  assert.equal(report.discrepancies[0].localStatus, "closing");
  assert.equal(report.discrepancies[0].sourceAsOf, at);
  assert.equal(report.discrepancies[0].sourceClosedAt, closedAt);
});

test("audits exact source IDs and symbols using sourceStatus without writing", async () => {
  const sourcePosition = { symbol: "BTC-USDT", sourceStatus: "active" };
  const positions = new Map([["signal-1", sourcePosition]]);
  const { pool, queries } = poolWithRows({
    vst: [
      { source_signal_id: "signal-1", symbol: "BTC-USDT", status: "open" },
      { source_signal_id: "signal-1-suffix", symbol: "BTC-USDT", status: "open" },
      { source_signal_id: "signal-1", symbol: "BTCUSDT", status: "closing" },
    ],
    live: [{ signal_id: "signal-1", symbol: "BTC-USDT", status: "closing" }],
  });

  const report = await auditExchangeSourcePositions({ pool, positions });
  assert.equal(report.status, "available");
  assert.equal(report.mode, "read_only");
  assert.equal(report.persistence, "disabled");
  assert.equal(report.ledgers.vst.matches.length, 1);
  assert.deepEqual(report.discrepancies.map(({ kind, sourceSignalId }) => [kind, sourceSignalId]), [
    ["source_missing", "signal-1-suffix"],
    ["symbol_mismatch", "signal-1"],
  ]);
  assert.equal(report.ledgers.real.matches[0].sourceSignalId, "signal-1");
  assert.equal(report.ledgers.real.matches[0].exchangeVerified, false);
  assert.equal(sourcePosition.sourceStatus, "active");
  assert.equal(queries.length, 2);
  assert.ok(queries.every((sql) => /^\s*SELECT/i.test(sql)));
});

test("source absence and unproven closures are unverified, never closures", async () => {
  const { pool, queries } = poolWithRows({
    vst: [
      { source_signal_id: "missing", symbol: "BTC-USDT", status: "open" },
      { source_signal_id: "reclassified", symbol: "ETH-USDT", status: "closing" },
      { source_signal_id: "unproven", symbol: "ADA-USDT", status: "open" },
      { source_signal_id: "expired", symbol: "DOGE-USDT", status: "open" },
      { source_signal_id: "expired-unproven", symbol: "AVAX-USDT", status: "open" },
      { source_signal_id: "closed", symbol: "XRP-USDT", status: "open" },
      { source_signal_id: "reclassified-closed", symbol: "SOL-USDT", status: "open" },
    ],
  });
  const report = await auditExchangeSourcePositions({
    pool,
    positions: new Map([
      ["reclassified", { symbol: "ETH-USDT", sourceStatus: "reclassified" }],
      ["unproven", { symbol: "ADA-USDT", sourceStatus: "stop_loss", sourceClosedAt: "2025-01-01T00:00:00Z" }],
      ["expired", {
        symbol: "DOGE-USDT",
        sourceStatus: "expired",
        sourceClosedAt: "2025-01-01T00:00:00Z",
        sourceExitPrice: "0.5",
      }],
      ["expired-unproven", {
        symbol: "AVAX-USDT",
        sourceStatus: "expired",
        sourceClosedAt: null,
        sourceExitPrice: null,
      }],
      ["closed", {
        symbol: "XRP-USDT",
        sourceStatus: "profit",
        sourceClosedAt: "2025-01-01T00:00:00Z",
        sourceExitPrice: "0.5",
      }],
      ["reclassified-closed", {
        symbol: "SOL-USDT",
        sourceStatus: "reclassified",
        sourceClosedAt: "2025-01-01T00:00:00Z",
        sourceExitPrice: 100,
      }],
    ]),
  });
  assert.deepEqual(report.discrepancies.map(({ kind, verification }) => [kind, verification]), [
    ["source_missing", "unverified"],
    ["source_status_unverified", "unverified"],
    ["source_status_unverified", "unverified"],
    ["source_closed_while_local_active", "discrepancy"],
    ["source_status_unverified", "unverified"],
    ["source_closed_while_local_active", "discrepancy"],
    ["source_closed_while_local_active", "discrepancy"],
  ]);
  assert.equal(queries.length, 2);
  assert.ok(queries.every((sql) => /^\s*SELECT/i.test(sql)));
});

test("ignores non-source status aliases and accepts only real active source states", async () => {
  const { pool } = poolWithRows({
    vst: [
      { source_signal_id: "wrong-alias", symbol: "BTC-USDT", status: "open" },
      { source_signal_id: "active", symbol: "BTC-USDT", status: "closing" },
      { source_signal_id: "in-run", symbol: "ETH-USDT", status: "open" },
    ],
  });
  const report = await auditExchangeSourcePositions({
    pool,
    positions: new Map([
      ["wrong-alias", { symbol: "BTC-USDT", status: "profit" }],
      ["active", { symbol: "BTC-USDT", sourceStatus: "active" }],
      ["in-run", { symbol: "ETH-USDT", sourceStatus: "in_run" }],
    ]),
  });
  assert.deepEqual(report.discrepancies.map(({ sourceSignalId, kind }) => [sourceSignalId, kind]), [
    ["wrong-alias", "source_status_unverified"],
  ]);
  assert.deepEqual(report.ledgers.vst.matches.map(({ sourceSignalId }) => sourceSignalId), [
    "active", "in-run",
  ]);
});

test("missing required ledger schema fails closed with an explicit report", async () => {
  const report = await auditExchangeSourcePositions({
    pool: { query: async () => { const error = new Error("relation absent"); error.code = "42P01"; throw error; } },
    positions: new Map(),
  });
  assert.equal(report.status, "unavailable");
  assert.equal(report.reason, "required_schema_missing");
  assert.equal(report.ledgers, null);
});

test("an unconfigured database reports unavailable without attempting persistence", async () => {
  const report = await auditExchangeSourcePositions({ positions: new Map() });
  assert.equal(report.status, "unavailable");
  assert.equal(report.reason, "database_not_configured");
  assert.equal(report.persistence, "disabled");
});