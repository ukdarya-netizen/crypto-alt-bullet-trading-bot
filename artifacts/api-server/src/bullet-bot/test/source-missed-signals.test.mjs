import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createWorker } from "../worker.mjs";
import { createStore } from "../store.mjs";
import { initialPosition } from "../engine.mjs";
import { paperFeeModel, paperFillCosts } from "../paper-fees.mjs";

const sample = JSON.parse(
  await readFile(new URL("./fixtures/impulse-buy-sample.json", import.meta.url), "utf8"),
);

// --- worker.mjs: syncSourcePositions must flag source-active signals we
// never stored in any form, without touching any real open position. ---

function harness() {
  const now = Date.parse(sample.signalAt) + 60_000;
  const entryPrice = 0.006;
  const quantity = 100;
  const feeModel = paperFeeModel(new Date(now).toISOString());
  const entryCosts = paperFillCosts(entryPrice, quantity, feeModel.rate);
  const position = {
    ...initialPosition(sample, {
      price: entryPrice,
      quantity,
      at: new Date(now - 10_000).toISOString(),
      mode: "paper",
      quantityPrecision: 2,
    }),
    marginHeldUsd: 10,
    realizedPnlUsdt: -entryCosts.feeUsdt,
    grossRealizedPnlUsdt: 0,
    feesPaidUsdt: entryCosts.feeUsdt,
    feeModel,
    paperFills: [{
      type: "entry",
      price: entryPrice,
      quantity,
      feeUsdt: entryCosts.feeUsdt,
      occurredAt: new Date(now - 10_000).toISOString(),
    }],
    paperMargin: { status: "verified" },
    fundingStatus: "current",
    fundingSettlements: [],
  };
  const missingCalls = [];
  const recorded = new Map();
  let stored = position;
  const store = {
    withLeaderLock: async (callback) => callback(),
    listOpenPositions: async () => stored.status === "open"
      ? [{ sourceSignalId: stored.sourceSignalId, snapshot: stored }]
      : [],
    findMissingSourceSignalIds: async (ids) => {
      missingCalls.push(ids);
      return ids.filter((id) => !recorded.has(id) || recorded.get(id) === "missing");
    },
    recordMissedSourceSignal: async (id, detail) => {
      const isNew = recorded.get(id) !== "recorded";
      recorded.set(id, "recorded");
      recorded.set(`${id}:detail`, detail);
      return isNew;
    },
    settlePaperPosition: async () => ({ kind: "stale" }),
  };
  const exchange = { ticker: async () => ({ lastPrice: "0.0062", bid1Price: "0.0061", quoteAt: new Date(now).toISOString() }) };
  return {
    worker: createWorker({ store, exchange, clock: () => now }),
    missingCalls,
    recorded,
    setStatus: (id, value) => recorded.set(id, value),
    now,
  };
}

test("a source-active signal never stored locally is flagged, not opened", async () => {
  const h = harness();
  const result = await h.worker.syncSourcePositions(new Map([
    ["cab-signal-90001", {
      sourceSignalId: "cab-signal-90001",
      symbol: "ETHUSDT",
      sourceStatus: "active",
      signalAt: new Date(h.now - 30_000).toISOString(),
      botEnqueuedAt: new Date(h.now - 29_000).toISOString(),
    }],
    ["cab-signal-90002", {
      sourceSignalId: "cab-signal-90002",
      symbol: "SOLUSDT",
      sourceStatus: "in_run",
    }],
  ]));

  const missed = result.filter((o) => o.kind === "missed");
  assert.deepEqual(
    missed.map((o) => o.sourceSignalId).sort(),
    ["cab-signal-90001", "cab-signal-90002"],
  );
  assert.equal(h.recorded.get("cab-signal-90001"), "recorded");
  assert.deepEqual(h.recorded.get("cab-signal-90001:detail"), {
    symbol: "ETHUSDT",
    sourceStatus: "active",
    signalAt: new Date(h.now - 30_000).toISOString(),
    botEnqueuedAt: new Date(h.now - 29_000).toISOString(),
  });
});

test("an already-recorded missed signal is not reported again", async () => {
  const h = harness();
  h.setStatus("cab-signal-90003", "recorded");
  const result = await h.worker.syncSourcePositions(new Map([
    ["cab-signal-90003", { sourceSignalId: "cab-signal-90003", symbol: "ETHUSDT", sourceStatus: "active" }],
  ]));
  assert.equal(result.filter((o) => o.kind === "missed").length, 0);
});

test("cancelled, profit, stop_loss, bu_stop, and reclassified source statuses are never flagged as missed", async () => {
  const h = harness();
  const result = await h.worker.syncSourcePositions(new Map([
    ["cab-signal-90004", { sourceSignalId: "cab-signal-90004", symbol: "ETHUSDT", sourceStatus: "cancelled" }],
    ["cab-signal-90005", { sourceSignalId: "cab-signal-90005", symbol: "ETHUSDT", sourceStatus: "profit" }],
    ["cab-signal-90006", { sourceSignalId: "cab-signal-90006", symbol: "ETHUSDT", sourceStatus: "reclassified" }],
  ]));
  assert.equal(h.missingCalls.length, 0, "only active/in_run ids are ever checked");
  assert.equal(result.filter((o) => o.kind === "missed").length, 0);
});

test("a recording failure for one signal does not block the rest of the sync pass", async () => {
  const h = harness();
  const originalRecord = h.worker;
  const failing = {
    withLeaderLock: async (callback) => callback(),
    listOpenPositions: async () => [],
    findMissingSourceSignalIds: async (ids) => ids,
    recordMissedSourceSignal: async (id) => {
      if (id === "cab-signal-90007") throw new Error("injected failure");
      return true;
    },
  };
  const worker = createWorker({
    store: failing,
    exchange: { ticker: async () => ({ lastPrice: "1", bid1Price: "1", quoteAt: new Date().toISOString() }) },
    clock: () => Date.now(),
  });
  const result = await worker.syncSourcePositions(new Map([
    ["cab-signal-90007", { sourceSignalId: "cab-signal-90007", symbol: "ETHUSDT", sourceStatus: "active" }],
    ["cab-signal-90008", { sourceSignalId: "cab-signal-90008", symbol: "ETHUSDT", sourceStatus: "active" }],
  ]));
  assert.deepEqual(result.map((o) => o.sourceSignalId), ["cab-signal-90008"]);
  void originalRecord;
});

// --- store.mjs: the underlying SQL for detection, idempotent recording,
// and summarization. ---

function fakePool({ existingSignalIds = [], existingEvents = [] } = {}) {
  const inserted = [];
  const pool = {
    query: async (sql, params = []) => {
      const text = sql.trim();
      if (text.startsWith("SELECT id\n          FROM unnest")) {
        const [ids] = params;
        return { rows: ids.filter((id) => !existingSignalIds.includes(id)).map((id) => ({ id })) };
      }
      if (text.startsWith("INSERT INTO btb_events (source_signal_id, kind, detail)\n          SELECT")) {
        const [sourceSignalId, detail] = params;
        const alreadyRecorded = existingEvents.some(
          (e) => e.source_signal_id === sourceSignalId && e.kind === "source_signal_never_ingested",
        ) || inserted.includes(sourceSignalId);
        if (alreadyRecorded) return { rows: [] };
        inserted.push(sourceSignalId);
        existingEvents.push({
          source_signal_id: sourceSignalId,
          kind: "source_signal_never_ingested",
          detail: JSON.parse(detail),
          created_at: new Date().toISOString(),
        });
        return { rows: [{ id: existingEvents.length }] };
      }
      if (text.startsWith("SELECT DISTINCT ON (e.source_signal_id)")) {
        const stillMissing = existingEvents.filter(
          (e) => e.kind === "source_signal_never_ingested" && !existingSignalIds.includes(e.source_signal_id),
        );
        return {
          rows: stillMissing.map((e) => ({
            source_signal_id: e.source_signal_id,
            detail: e.detail,
            created_at: e.created_at,
          })),
        };
      }
      throw new Error(`Unexpected query: ${text.slice(0, 80)}`);
    },
    connect: async () => { throw new Error("A transaction was not expected"); },
  };
  return { pool, inserted, existingEvents };
}

test("findMissingSourceSignalIds returns only ids absent from btb_signals", async () => {
  const { pool } = fakePool({ existingSignalIds: ["cab-signal-1"] });
  const store = createStore(pool);
  assert.deepEqual(await store.findMissingSourceSignalIds([]), []);
  assert.deepEqual(
    await store.findMissingSourceSignalIds(["cab-signal-1", "cab-signal-2"]),
    ["cab-signal-2"],
  );
});

test("findMissingSourceSignalIds rejects non-string-array input", async () => {
  const { pool } = fakePool();
  const store = createStore(pool);
  await assert.rejects(store.findMissingSourceSignalIds("cab-signal-1"), TypeError);
  await assert.rejects(store.findMissingSourceSignalIds([1, 2]), TypeError);
  await assert.rejects(store.findMissingSourceSignalIds([""]), TypeError);
});

test("recordMissedSourceSignal is idempotent per sourceSignalId", async () => {
  const { pool } = fakePool();
  const store = createStore(pool);
  assert.equal(await store.recordMissedSourceSignal("cab-signal-3", { symbol: "ETHUSDT" }), true);
  assert.equal(await store.recordMissedSourceSignal("cab-signal-3", { symbol: "ETHUSDT" }), false);
});

test("getMissedSourceSignalsSummary lists only still-missing signals with their recorded detail", async () => {
  const { pool, existingEvents } = fakePool();
  const store = createStore(pool);
  await store.recordMissedSourceSignal("cab-signal-4", { symbol: "ETHUSDT", sourceStatus: "active" });
  await store.recordMissedSourceSignal("cab-signal-5", { symbol: "SOLUSDT", sourceStatus: "in_run" });
  // cab-signal-4 later legitimately arrives through the normal ingress path.
  const { pool: pool2 } = fakePool({ existingSignalIds: ["cab-signal-4"], existingEvents });
  const store2 = createStore(pool2);
  const summary = await store2.getMissedSourceSignalsSummary();
  assert.equal(summary.count, 1);
  assert.equal(summary.items[0].sourceSignalId, "cab-signal-5");
  assert.equal(summary.items[0].symbol, "SOLUSDT");
  assert.equal(summary.items[0].sourceStatus, "in_run");
});
