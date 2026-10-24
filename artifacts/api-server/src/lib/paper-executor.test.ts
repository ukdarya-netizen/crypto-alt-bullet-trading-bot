import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { pool } from "@workspace/db";
import { EnqueueTradingSignalBody, EnqueueTradingSignalResponse } from "@workspace/api-zod";
import { bulletPayload } from "./bullet-test-fixture";
import { enqueueSignal, enqueueSignalIntent, ensureTradingControls } from "./trading-store";
import { toTradingSignal } from "./trading-mappers";
import { approvedPatternIds, signalEligibility } from "./signal-eligibility";
import { mapJournalRows } from "./journal";
import {
  claimNextSignal,
  finalizePaperSignal,
  recordPaperFailure,
  type ClaimedSignal,
  type PaperDbClient,
} from "./paper-executor";

function signal(attempts = 1): ClaimedSignal {
  return {
    id: randomUUID(),
    source_signal_id: `test-${randomUUID()}`,
    confirmation_status: "confirmed",
    pattern_id: "liquidation_cascade",
    pattern_status: "approved",
    symbol: "BTCUSDT",
    side: "buy",
    order_type: "limit",
    quantity: "2",
    limit_price: "10",
    stop_loss: "9",
    take_profit: null,
    reduce_only: false,
    attempts,
  };
}

const allowed = new Set(["liquidation_cascade"]);

test("relay must provide the execution plan", () => {
  const input = {
    sourceSignalId: "cab-signal-1", confirmationStatus: "confirmed", patternId: "balanced_grind",
    patternStatus: "approved", symbol: "BTCUSDT",
    signalAt: "2026-09-23T16:00:00Z", referencePrice: "65000",
    side: "buy", orderType: "market", quantity: "0.001538461538",
    limitPrice: "65000", stopLoss: "62000", reduceOnly: false, payload: bulletPayload(),
  };
  assert.equal(EnqueueTradingSignalBody.safeParse(input).success, true);
  assert.equal(EnqueueTradingSignalBody.safeParse({
    ...input, referencePrice: undefined,
  }).success, false);
  assert.equal(EnqueueTradingSignalBody.safeParse({
    ...input, signalAt: undefined,
  }).success, false);
});

type FakeState = {
  controls: { mode: string; kill_switch_active: boolean; accepting_new_entries: boolean; max_notional_per_order: string };
  current: {
    status: string; attempts: number; lease_until: Date | null;
    confirmation_status: string; pattern_id: string; pattern_status: string;
    signal_at?: Date;
    raw_payload?: unknown;
  };
  orderStatus: string | null;
  orderSignalId: string | null;
  ordersCreated: number;
  paperState: Record<string, unknown> | null;
  audits: string[];
  committed: boolean;
  entries: { id: string; filled_quantity: string; side: string; symbol: string }[];
  closes: { entryId: string; quantity: string }[];
  paperLedger: { realized_gross: string; open_count: string; invalid: boolean };
};

function fakeConnection(initial: Omit<Partial<FakeState>, "current"> & { current?: Partial<FakeState["current"]> } = {}) {
  const state: FakeState = {
    controls: { mode: "paper", kill_switch_active: false, accepting_new_entries: true, max_notional_per_order: "100" },
    orderStatus: null,
    orderSignalId: null,
    ordersCreated: 0,
    paperState: null,
    audits: [],
    committed: false,
    entries: [],
    closes: [],
    paperLedger: { realized_gross: "0", open_count: "0", invalid: false },
    ...initial,
    current: {
      status: "processing", attempts: 1, lease_until: new Date(Date.now() + 30_000),
      confirmation_status: "confirmed", pattern_id: "liquidation_cascade", pattern_status: "approved",
      signal_at: new Date(), raw_payload: { ...bulletPayload(), relay: {
        side: "buy", orderType: "market", reduceOnly: false,
      }, relayContractVerified: true },
      ...initial.current,
    },
  };
  const client = {
    async query(sql: string, params: unknown[] = []) {
      if (sql === "BEGIN") return { rows: [], rowCount: null };
      if (sql === "COMMIT") {
        state.committed = true;
        return { rows: [], rowCount: null };
      }
      if (sql === "ROLLBACK") return { rows: [], rowCount: null };
      if (sql.startsWith("SELECT mode, kill_switch_active")) return { rows: [state.controls], rowCount: 1 };
      if (sql.startsWith("SELECT status, attempts, lease_until")) return { rows: [state.current], rowCount: 1 };
      if (sql.startsWith("SELECT status FROM trading_orders")) {
        const found = state.orderStatus && (!state.orderSignalId || state.orderSignalId === params[0]);
        return { rows: found ? [{ status: state.orderStatus }] : [], rowCount: found ? 1 : 0 };
      }
      if (sql.includes("WITH entries AS")) return { rows: [state.paperLedger], rowCount: 1 };
      if (sql.includes("SELECT entry.id, entry.filled_quantity")) {
        return { rows: state.entries.filter((entry) =>
          entry.symbol === params[0] && entry.side === params[1]), rowCount: state.entries.length };
      }
      if (sql.includes("COALESCE(SUM(filled_quantity)")) {
        const quantity = state.closes.filter((close) => close.entryId === params[0])
          .reduce((sum, close) => sum + Number(close.quantity), 0).toString();
        return { rows: [{ quantity }], rowCount: 1 };
      }
      if (sql.includes("UPDATE trading_signals SET status = 'pending'")) {
        state.current.status = "pending";
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE trading_signals SET status = $2")) {
        state.current.status = String(params[1]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO trading_orders")) {
        if (state.orderStatus && state.orderSignalId === params[0]) return { rows: [], rowCount: 0 };
        state.orderStatus = "simulated_filled";
        state.orderSignalId = String(params[0]);
        state.ordersCreated++;
        state.paperState = JSON.parse(String(params[10])) as Record<string, unknown>;
        if (params[11]) state.closes.push({ entryId: String(params[11]), quantity: String(params[5]) });
        return { rows: [{ id: params[0] }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO trading_audit_events")) {
        state.audits.push(sql.includes("'execution_deferred'") ? "execution_deferred" : String(params[1]));
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in fake executor: ${sql}`);
    },
    release() {},
  };
  const connect = async () => ({ ...client }) as unknown as PaperDbClient;
  return { state, connect };
}

test("duplicate delivery after commit does not create a second paper order", async () => {
  const s = signal();
  const { state, connect } = fakeConnection();
  assert.equal(await finalizePaperSignal(s, connect, allowed), "executed");
  assert.equal(await finalizePaperSignal(s, connect, allowed), "stale");
  assert.equal(state.ordersCreated, 1);
  assert.deepEqual(state.audits, ["paper_order_executed"]);
});

test("supported impulse payload opens a paper entry with runner break-even at opening", async () => {
  const s = { ...signal(), pattern_id: "impulse_buy", quantity: "0.1",
    limit_price: "100", stop_loss: "90", order_type: "market" };
  const { state, connect } = fakeConnection({ current: {
    pattern_id: "impulse_buy",
    raw_payload: { ...bulletPayload(true), relay: {
      side: "buy", orderType: "market", reduceOnly: false,
    }, relayContractVerified: true },
  } });
  assert.equal(await finalizePaperSignal(s, connect, new Set(["impulse_buy"])), "executed");
  assert.equal(state.committed, true);
  assert.equal(state.ordersCreated, 1);
  assert.equal(state.paperState?.runnerStop, "100.000000000000");
  assert.equal(state.paperState?.coreStop, "90");
});

test("partial reduction survives reclaim and repeated reduce-only signals cannot overclose", async () => {
  const entryId = randomUUID();
  const { state, connect } = fakeConnection({
    entries: [{ id: entryId, filled_quantity: "2", side: "buy", symbol: "BTCUSDT" }],
  });
  const first = { ...signal(), side: "sell", reduce_only: true, stop_loss: null, quantity: "0.75", limit_price: "12" };
  assert.equal(await finalizePaperSignal(first, connect, allowed), "executed");
  assert.deepEqual(state.closes, [{ entryId, quantity: "0.75" }]);
  // A new worker with a reclaimed lease reads committed reductions, not local state.
  state.current = { ...state.current, status: "processing", attempts: 2,
    lease_until: new Date(Date.now() + 30_000) };
  const second = { ...signal(2), side: "sell", reduce_only: true, stop_loss: null, quantity: "1.25" };
  assert.equal(await finalizePaperSignal(second, connect, allowed), "executed");
  state.current = { ...state.current, status: "processing", attempts: 1,
    lease_until: new Date(Date.now() + 30_000) };
  const third = { ...signal(), side: "sell", reduce_only: true, stop_loss: null, quantity: "0.1" };
  assert.equal(await finalizePaperSignal(third, connect, allowed), "rejected");
  assert.equal(state.ordersCreated, 2);
  assert.equal(state.closes.reduce((sum, close) => sum + Number(close.quantity), 0), 2);
});

test("journal only closes linked paper entries and reports simulated gross result", () => {
  const entryId = randomUUID();
  const baseOrder = {
    id: entryId, status: "simulated_filled", paperEntryOrderId: null,
    symbol: "BTCUSDT", side: "buy", filledQuantity: "2", averagePrice: "10",
    quantity: "2", createdAt: new Date("2026-01-01T00:00:00Z"),
    exchangeOrderId: "paper-entry", stopLoss: "9", takeProfit: null, protectionStatus: "simulated",
  };
  const baseSignal = { sourceSignalId: "entry", reduceOnly: false };
  const row = (order: Record<string, unknown>, reduceOnly: boolean) => ({
    order: { ...baseOrder, ...order },
    signal: { ...baseSignal, reduceOnly },
    detail: null,
  });
  const entry = row({}, false);
  const unlinked = row({ id: randomUUID(), side: "sell", filledQuantity: "1",
    averagePrice: "100", paperEntryOrderId: null }, true);
  const first = row({ id: randomUUID(), side: "sell", filledQuantity: "0.75",
    averagePrice: "12", paperEntryOrderId: entryId }, true);
  const second = row({ id: randomUUID(), side: "sell", filledQuantity: "1.25",
    averagePrice: "8", paperEntryOrderId: entryId }, true);
  type Rows = Parameters<typeof mapJournalRows>[0];
  const asRows = (rows: ReturnType<typeof row>[]) => rows as unknown as Rows;
  const partial = mapJournalRows(asRows([entry, unlinked, first]));
  assert.equal(partial.length, 1);
  assert.equal(partial[0].status, "open");
  assert.equal(partial[0].quantity, "1.25");
  assert.equal(partial[0].grossPnl, "1.50000000");
  assert.equal(partial[0].netPnl, null);
  assert.equal(partial[0].calculationStatus, "paper");
  const closed = mapJournalRows(asRows([entry, unlinked, first, second]));
  assert.equal(closed.length, 1);
  assert.equal(closed[0].status, "closed");
  assert.equal(closed[0].quantity, "2");
  assert.equal(closed[0].grossPnl, "-1.00000000");
  assert.equal(mapJournalRows(asRows([entry, unlinked]))[0].status, "open");
});

test("expired lease is reclaimable, but stale attempt cannot finalize", async () => {
  const s = signal(1);
  const { state, connect } = fakeConnection({
    current: { status: "processing", attempts: 2, lease_until: new Date(Date.now() + 30_000) },
  });
  assert.equal(await finalizePaperSignal(s, connect, allowed), "stale");
  assert.equal(state.ordersCreated, 0);
  assert.equal(await finalizePaperSignal({ ...s, attempts: 2 }, connect, allowed), "executed");
  assert.equal(state.ordersCreated, 1);

  let inspectedSql = "";
  const claimed = await claimNextSignal((async (sql: string) => {
    inspectedSql = sql;
    return { rows: [{ ...s, attempts: 2 }] };
  }) as typeof pool.query);
  assert.equal(claimed?.attempts, 2);
  assert.match(inspectedSql, /status = 'processing' AND lease_until < NOW\(\)/);
  assert.match(inspectedSql, /FOR UPDATE SKIP LOCKED/);
});

test("kill switch changed after claim defers without inserting", async () => {
  const { state, connect } = fakeConnection({
    controls: { mode: "paper", kill_switch_active: true, accepting_new_entries: true, max_notional_per_order: "100" },
  });
  assert.equal(await finalizePaperSignal(signal(), connect, allowed), "deferred");
  assert.equal(state.current.status, "pending");
  assert.equal(state.ordersCreated, 0);
  assert.deepEqual(state.audits, ["execution_deferred"]);
});

test("lower concurrent max-notional is checked while control row is locked", async () => {
  const { state, connect } = fakeConnection({
    controls: { mode: "paper", kill_switch_active: false, accepting_new_entries: true, max_notional_per_order: "19.99999999" },
  });
  assert.equal(await finalizePaperSignal(signal(), connect, allowed), "rejected");
  assert.equal(state.current.status, "rejected");
  assert.equal(state.ordersCreated, 0);
  assert.deepEqual(state.audits, ["signal_rejected"]);
  assert.equal(state.committed, true);
});

test("insufficient paper funds skips the signal permanently without creating an order", async () => {
  const { state, connect } = fakeConnection({
    paperLedger: { realized_gross: "0", open_count: "10", invalid: false },
  });
  const s = signal();
  assert.equal(await finalizePaperSignal(s, connect, allowed), "rejected");
  assert.equal(state.current.status, "rejected");
  assert.equal(state.ordersCreated, 0);
  assert.deepEqual(state.audits, ["paper_entry_skipped"]);
  assert.equal(await finalizePaperSignal(s, connect, allowed), "stale");
});

test("released paper allocation permits a new signal, not a skipped old one", async () => {
  const { state, connect } = fakeConnection({
    paperLedger: { realized_gross: "0", open_count: "10", invalid: false },
  });
  const skipped = signal();
  assert.equal(await finalizePaperSignal(skipped, connect, allowed), "rejected");
  state.paperLedger.open_count = "9";
  state.current = { ...state.current, status: "processing", attempts: 1,
    lease_until: new Date(Date.now() + 30_000) };
  assert.equal(await finalizePaperSignal(signal(), connect, allowed), "executed");
  assert.equal(state.ordersCreated, 1);
});

test("realized paper losses can leave insufficient funds even after a close", async () => {
  const { state, connect } = fakeConnection({
    paperLedger: { realized_gross: "-11", open_count: "8", invalid: false },
  });
  assert.equal(await finalizePaperSignal(signal(), connect, allowed), "rejected");
  assert.equal(state.ordersCreated, 0);
});

test("invalid linked paper fills fail closed instead of spending unverified funds", async () => {
  const { state, connect } = fakeConnection({
    paperLedger: { realized_gross: "0", open_count: "0", invalid: true },
  });
  await assert.rejects(finalizePaperSignal(signal(), connect, allowed), /cannot be verified/);
  assert.equal(state.ordersCreated, 0);
});

test("worker failure reaches terminal status and audit at retry limit", async () => {
  const s = signal(3);
  const { state, connect } = fakeConnection({
    current: { status: "processing", attempts: 3, lease_until: new Date(Date.now() + 30_000) },
  });
  await recordPaperFailure(s, new Error("simulated DB failure"), connect);
  assert.equal(state.current.status, "failed");
  assert.equal(state.ordersCreated, 0);
  assert.deepEqual(state.audits, ["signal_failed"]);
  assert.equal(state.committed, true);
});

test("candidates, experimental patterns and unlisted patterns are rejected", async () => {
  assert.equal(signalEligibility({
    confirmationStatus: "candidate", patternStatus: "approved", patternId: "reliability-approved",
  }, allowed), "CONFIRMED_SIGNAL_REQUIRED");
  assert.equal(signalEligibility({
    confirmationStatus: "confirmed", patternStatus: "experimental", patternId: "reliability-approved",
  }, allowed), "EXPERIMENTAL_PATTERN");
  assert.equal(signalEligibility({
    confirmationStatus: "confirmed", patternStatus: "approved", patternId: "other",
  }, allowed), "PATTERN_NOT_APPROVED");
  assert.deepEqual(approvedPatternIds("one, two ,"), new Set(["one", "two"]));

  const { state, connect } = fakeConnection({ current: { confirmation_status: "candidate" } });
  assert.equal(await finalizePaperSignal(signal(), connect, allowed), "rejected");
  assert.equal(state.ordersCreated, 0);
  assert.deepEqual(state.audits, ["signal_rejected"]);
});

test("concurrent duplicate intake and database uniqueness on orders", async (t) => {
  const controls = await ensureTradingControls();
  if (!controls.killSwitchActive || controls.acceptingNewEntries) {
    t.skip("Integration checks require the executor paused; never change live safety controls in a test.");
    return;
  }
  const sourceSignalId = `reliability-test-${randomUUID()}`;
  let signalId: string | null = null;
  try {
    const input = {
      sourceSignalId, confirmationStatus: "confirmed" as const,
      patternId: "reliability-approved", patternStatus: "approved" as const,
      symbol: "BTCUSDT", side: "buy" as const,
      orderType: "limit" as const, quantity: "1", limitPrice: "10",
      stopLoss: "9", reduceOnly: false,
      payload: { sequence: 1, labels: ["test"] },
    };
    const results = await Promise.all(Array.from({ length: 8 }, () => enqueueSignal(input)));
    signalId = results[0].signal.id;
    assert.equal(results.filter((r) => !r.duplicate).length, 1);
    assert.equal(new Set(results.map((r) => r.signal.id)).size, 1);
    assert.equal(results.filter((r) => r.conflict).length, 0);

    const equivalent = await enqueueSignal({ ...input, quantity: "1.000000000000", payload: { labels: ["test"], sequence: 1 } });
    assert.equal(equivalent.duplicate, true);
    assert.equal(equivalent.conflict, false);
    const conflict = await enqueueSignal({ ...input, stopLoss: "8" });
    assert.equal(conflict.conflict, true);
    const classificationConflict = await enqueueSignal({ ...input, patternId: "other" });
    assert.equal(classificationConflict.conflict, true);
    const audit = await pool.query<{ event_type: string }>(
      "SELECT event_type FROM trading_audit_events WHERE signal_id = $1", [signalId],
    );
    assert.equal(audit.rows.filter((row) => row.event_type === "idempotency_conflict").length, 2);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const values = [randomUUID(), signalId, "paper-first", "BTCUSDT", "buy", "limit", "1", "10", "simulated"];
      const sql = `INSERT INTO trading_orders
        (id, signal_id, exchange_order_id, symbol, side, order_type, status,
         quantity, filled_quantity, average_price, protection_status)
        VALUES ($1, $2, $3, $4, $5, $6, 'simulated_filled', $7, $7, $8, $9)
        ON CONFLICT (signal_id) DO NOTHING RETURNING id`;
      assert.equal((await client.query(sql, values)).rowCount, 1);
      assert.equal((await client.query(sql, [randomUUID(), signalId, "paper-second", ...values.slice(3)])).rowCount, 0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  } finally {
    if (signalId) {
      await pool.query("DELETE FROM trading_audit_events WHERE signal_id = $1", [signalId]);
      await pool.query("DELETE FROM trading_signals WHERE id = $1", [signalId]);
    }
  }
});

test("raw signal intake is idempotent and cannot enter the execution queue", async () => {
  const sourceSignalId = `intent-test-${randomUUID()}`;
  let signalId: string | null = null;
  try {
    const input = {
      sourceSignalId,
      confirmationStatus: "confirmed" as const,
      patternId: "liquidation_cascade",
      patternStatus: "approved" as const,
      symbol: "BTCUSDT",
      signalAt: new Date("2026-09-23T16:00:00Z"),
      referencePrice: "65000",
      side: "buy" as const, orderType: "market" as const,
      quantity: "0.001538461538", limitPrice: "65000", stopLoss: "62000",
      reduceOnly: false as const, payload: bulletPayload(),
    };
    const results = await Promise.all(Array.from({ length: 5 }, () => enqueueSignalIntent(input)));
    signalId = results[0].signal.id;
    assert.equal(results.filter((result) => !result.duplicate).length, 1);
    assert.equal(new Set(results.map((result) => result.signal.id)).size, 1);
    assert.equal(results.filter((result) => result.conflict).length, 0);
    assert.equal(results[0].signal.status, "awaiting_rules");
    assert.equal(results[0].signal.quantity, null);
    assert.equal(results[0].signal.side, null);
    assert.equal(results[0].signal.stopLoss, null);
    assert.equal(results[0].signal.errorCode, "PAPER_RULES_UNSUPPORTED");
    assert.equal(EnqueueTradingSignalResponse.parse({
      accepted: true, duplicate: false, signal: toTradingSignal(results[0].signal),
    }).signal.status, "awaiting_rules");
    assert.equal((await enqueueSignalIntent({ ...input, referencePrice: "65000.000" })).conflict, false);
    assert.equal((await enqueueSignalIntent({ ...input, referencePrice: "65001" })).conflict, true);
    const stored = await pool.query<{ status: string }>(
      "SELECT status FROM trading_signals WHERE id = $1", [signalId],
    );
    assert.equal(stored.rows[0].status, "awaiting_rules");
  } finally {
    if (signalId) {
      await pool.query("DELETE FROM trading_audit_events WHERE signal_id = $1", [signalId]);
      await pool.query("DELETE FROM trading_signals WHERE id = $1", [signalId]);
    }
  }
});

test("expired relay-shaped event is journaled but never queued, even when PAPER is enabled", async () => {
  const sourceSignalId = `cab-signal-${Date.now()}`;
  let signalId: string | null = null;
  try {
    await ensureTradingControls();
    const result = await enqueueSignalIntent({
      sourceSignalId, confirmationStatus: "confirmed", patternId: "balanced_grind",
      patternStatus: "approved", symbol: "ETHUSDT", signalAt: new Date(Date.now() - 601_000),
      referencePrice: "100", limitPrice: "100", quantity: "1",
      stopLoss: "94", side: "buy", orderType: "market", reduceOnly: false,
      payload: bulletPayload(),
    });
    signalId = result.signal.id;
    assert.equal(result.signal.status, "awaiting_rules");
    assert.equal(result.signal.errorCode, "PAPER_SIGNAL_OUTSIDE_WINDOW");
    assert.equal(result.signal.quantity, null);
    const audit = await pool.query<{ event_type: string }>(
      "SELECT event_type FROM trading_audit_events WHERE signal_id = $1", [signalId],
    );
    assert.equal(audit.rows[0]?.event_type, "signal_received");
  } finally {
    if (signalId) {
      await pool.query("DELETE FROM trading_audit_events WHERE signal_id = $1", [signalId]);
      await pool.query("DELETE FROM trading_signals WHERE id = $1", [signalId]);
    }
  }
});