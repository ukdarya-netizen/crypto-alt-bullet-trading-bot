import assert from "node:assert/strict";
import test from "node:test";
import { createLiveStore } from "../live-store.mjs";

const fill = {
  account: "owner", environment: "mainnet", tradeId: "fill-1",
  clientOrderId: "entry-1", symbol: "XRPUSDT", side: "BUY",
  quantity: "1", price: "100",
};

function duplicateStore(row) {
  const pool = {
    connect: async () => { throw new Error("A transaction was not expected"); },
    query: async (sql) => sql.includes("INSERT INTO btb_live_fills")
      ? { rowCount: 0 } : { rowCount: row ? 1 : 0, rows: row ? [row] : [] },
  };
  return createLiveStore(pool);
}

test("a duplicate exchange fill is idempotent only when its execution facts agree", async () => {
  const original = {
    client_order_id: "entry-1", symbol: "XRPUSDT", side: "BUY",
    quantity: "1.000000000000", price: "100.000000000000",
    fee: null, fee_asset: null,
  };
  assert.deepEqual(await duplicateStore(original).saveFill(fill), { kind: "existing" });
  for (const changed of [
    { ...original, client_order_id: "external-1" },
    { ...original, side: "SELL" },
    { ...original, quantity: "0.5" },
    null,
  ]) {
    await assert.rejects(duplicateStore(changed).saveFill(fill), /different execution facts/);
  }
});

function closeStore(failOn = "") {
  const statements = [];
  const client = {
    query: async (sql) => {
      statements.push(sql.trim());
      if (failOn && sql.includes(failOn)) throw new Error("injected database failure");
      if (sql.includes("FROM btb_live_order_intents") && sql.includes("FOR UPDATE")) {
        return {
          rowCount: 1,
          rows: [{ account_id: "owner", environment: "mainnet", signal_id: "signal", state: "unknown" }],
        };
      }
      if (sql.includes("UPDATE btb_live_position_snapshots")) {
        return {
          rowCount: 1,
          rows: [{
            account_id: "owner", environment: "mainnet", signal_id: "signal",
            symbol: "XRPUSDT", status: "closed", snapshot: { status: "closed" },
          }],
        };
      }
      if (sql.includes("FROM btb_live_order_attempts")) {
        return { rowCount: 1, rows: [{ count: 1 }] };
      }
      return { rowCount: 1, rows: [{ id: 1 }] };
    },
    release: () => {},
  };
  return {
    store: createLiveStore({ query: client.query, connect: async () => client }),
    statements,
  };
}

test("a verified close commits fills, snapshot and intent together or rolls everything back", async () => {
  const input = {
    account: "owner", environment: "mainnet", signalId: "signal",
    clientOrderId: "close-1",
    fills: [{ ...fill, tradeId: "close-fill", clientOrderId: "close-1", side: "SELL" }],
    snapshot: {
      sourceSignalId: "signal", symbol: "XRPUSDT", status: "closed",
      remainingQty: 0, quantity: 1, entryPrice: 100,
    },
    detail: { status: "FILLED" },
  };
  const done = closeStore();
  assert.equal((await done.store.commitVerifiedClose(input)).status, "closed");
  assert.ok(done.statements.includes("COMMIT"));
  assert.ok(done.statements.some((sql) => sql.includes("INSERT INTO btb_live_fills")));
  assert.ok(done.statements.some((sql) => sql.includes("UPDATE btb_live_position_snapshots")));
  assert.ok(done.statements.some((sql) => sql.includes("UPDATE btb_live_order_intents")));

  for (const failure of ["UPDATE btb_live_position_snapshots", "UPDATE btb_live_order_intents"]) {
    const broken = closeStore(failure);
    await assert.rejects(broken.store.commitVerifiedClose(input), /injected database failure/);
    assert.ok(broken.statements.includes("ROLLBACK"));
    assert.equal(broken.statements.includes("COMMIT"), false);
  }
});

test("the REAL baseline and opening allocation cannot silently change", async () => {
  const queries = [];
  const store = createLiveStore({
    connect: async () => { throw new Error("unexpected transaction"); },
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("SELECT initial_usdt, started_at FROM btb_live_baseline")) {
        return { rows: [{ initial_usdt: "113.031900000000", started_at: new Date("2026-09-27T06:24:14.363Z") }] };
      }
      if (sql.includes("INSERT INTO btb_live_allocations")) return { rowCount: 1 };
      return { rowCount: 1, rows: [] };
    },
  });
  const baseline = {
    account: "bingx-mainnet", environment: "mainnet",
    initialUsdt: "113.0319", startedAt: "2026-09-27T06:24:14.363Z",
  };
  await store.recordBaseline(baseline);
  await assert.rejects(store.recordBaseline({ ...baseline, initialUsdt: "150" }), /different facts/);
  await store.recordInitialAllocation({
    account: "bingx-mainnet", environment: "mainnet", signalId: "signal",
    marginUsdt: "10", entryAt: "2026-09-28T00:00:00Z",
  });
  const allocation = queries.find(({ sql }) => sql.includes("INSERT INTO btb_live_allocations"));
  assert.deepEqual(allocation.params, [
    "bingx-mainnet", "mainnet", "signal", "10", "2026-09-28T00:00:00.000Z",
  ]);
  assert.match(allocation.sql, /started_at <= \$5/);
  await assert.rejects(store.recordInitialAllocation({
    account: "bingx-mainnet", environment: "mainnet", signalId: "signal",
    marginUsdt: "0", entryAt: "2026-09-28T00:00:00Z",
  }), /must be positive/);
});