import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../store.mjs";
import {
  PAPER_TAKER_FEE_RATE,
  createPaperFeeReader,
  paperFeeModel,
  paperFillCosts,
  resolvePaperFeeModel,
} from "../paper-fees.mjs";

function paperStore({ freeUsdt = 100 } = {}) {
  let account = {
    initial_usdt: 100,
    free_usdt: freeUsdt,
    reserved_usdt: 0,
    realized_pnl_usdt: 0,
  };
  let positions = new Map();
  let signals = new Map();
  let events = [];
  let nextEventId = 1;
  let transaction = null;

  const row = (sourceSignalId) => transaction?.positions.get(sourceSignalId)
    ?? positions.get(sourceSignalId);
  const accountState = () => transaction?.account ?? account;
  const accountRow = (value) => ({
    initial_usdt: String(value.initial_usdt),
    free_usdt: String(value.free_usdt),
    reserved_usdt: String(value.reserved_usdt),
    realized_pnl_usdt: String(value.realized_pnl_usdt),
  });
  const query = async (sql, params = []) => {
    const text = sql.trim();
    if (text === "BEGIN") {
      transaction = {
        account: { ...account },
        positions: new Map(positions),
        signals: new Map(signals),
        events: [...events],
      };
      return { rowCount: 0, rows: [] };
    }
    if (text === "COMMIT") {
      account = transaction.account;
      positions = transaction.positions;
      signals = transaction.signals;
      events = transaction.events;
      transaction = null;
      return { rowCount: 0, rows: [] };
    }
    if (text === "ROLLBACK") {
      transaction = null;
      return { rowCount: 0, rows: [] };
    }
    if (text.includes("FROM btb_events request") &&
        text.includes("paper_source_exit_requested")) {
      const [sourceSignalId] = params;
      const pending = (transaction?.events ?? events).find((event) =>
        event.source_signal_id === sourceSignalId &&
        event.kind === "paper_source_exit_requested" &&
        !(transaction?.events ?? events).some((applied) =>
          applied.source_signal_id === sourceSignalId &&
          applied.kind === "paper_source_exit_applied" &&
          applied.detail.requestId === String(event.id)));
      return {
        rowCount: pending ? 1 : 0,
        rows: pending ? [{ id: pending.id }] : [],
      };
    }
    if (text.includes("WHERE id = $2::bigint")) {
      const [sourceSignalId, requestId] = params;
      const request = (transaction?.events ?? events).find((event) =>
        event.source_signal_id === sourceSignalId &&
        event.kind === "paper_source_exit_requested" &&
        String(event.id) === String(requestId));
      return {
        rowCount: request ? 1 : 0,
        rows: request ? [{ id: request.id, detail: request.detail }] : [],
      };
    }
    if (text.includes("kind = 'paper_source_exit_applied'")) {
      const [sourceSignalId, requestId] = params;
      const applied = (transaction?.events ?? events).find((event) =>
        event.source_signal_id === sourceSignalId &&
        event.kind === "paper_source_exit_applied" &&
        event.detail.requestId === requestId);
      return {
        rowCount: applied ? 1 : 0,
        rows: applied ? [{ id: applied.id }] : [],
      };
    }
    if (text.includes("INSERT INTO btb_events")) {
      if (failEventInsert) {
        failEventInsert = false;
        throw new Error("simulated audit insert failure");
      }
      const sourceExitApplied = text.includes("'paper_source_exit_applied'");
      const [sourceSignalId, kindOrDetail, maybeDetail] = params;
      const kind = sourceExitApplied ? "paper_source_exit_applied" : kindOrDetail;
      const detail = sourceExitApplied ? kindOrDetail : maybeDetail;
      transaction.events.push({
        id: nextEventId++,
        source_signal_id: sourceSignalId,
        kind,
        detail: JSON.parse(detail),
      });
      return { rowCount: 1, rows: [] };
    }
    if (text.includes("UPDATE btb_signals")) {
      const [sourceSignalId] = params;
      if (!transaction.signals.has(sourceSignalId)) return { rowCount: 0, rows: [] };
      transaction.signals.set(sourceSignalId, "closed");
      return { rowCount: 1, rows: [{ source_signal_id: sourceSignalId }] };
    }
    if (text.includes("UPDATE btb_paper_account")) {
      const current = accountState();
      if (text.includes("free_usdt = free_usdt - $1::numeric - $2::numeric")) {
        const [margin, fee] = params.map(Number);
        if (current.free_usdt < margin + fee) return { rowCount: 0, rows: [] };
        current.free_usdt -= margin + fee;
        current.reserved_usdt += margin;
        current.realized_pnl_usdt -= fee;
      } else if (text.includes("reserved_usdt = reserved_usdt + $1")) {
        const amount = Number(params[0]);
        if (current.free_usdt < amount) return { rowCount: 0, rows: [] };
        current.free_usdt -= amount;
        current.reserved_usdt += amount;
      } else {
        const [realizedDelta, marginDelta] = params.map(Number);
        if (current.reserved_usdt < marginDelta) {
          return { rowCount: 0, rows: [] };
        }
        current.free_usdt += realizedDelta + marginDelta;
        current.reserved_usdt -= marginDelta;
        current.realized_pnl_usdt += realizedDelta;
      }
      return { rowCount: 1, rows: [accountRow(current)] };
    }
    if (text.includes("SELECT singleton FROM btb_paper_account")) {
      return { rowCount: 1, rows: [{ singleton: true }] };
    }
    if (text.includes("COUNT(*) FILTER") && text.includes("incomplete_count")) {
      const all = [...(transaction?.positions ?? positions).values()]
        .filter((entry) => (entry.snapshot.mode ?? "paper") === "paper");
      return {
        rowCount: 1,
        rows: [{
          incomplete_count: all.filter((entry) =>
            entry.snapshot.fundingStatus === "incomplete").length,
          legacy_unknown_count: all.filter((entry) =>
            entry.snapshot.fundingStatus !== "current" &&
            entry.snapshot.fundingStatus !== "incomplete").length,
        }],
      };
    }
    if (text.includes("FROM btb_positions") && text.includes("fundingHistoryAttemptAt")) {
      const [now, limit] = params.map(Number);
      const rows = [...(transaction?.positions ?? positions).entries()]
        .filter(([, entry]) => {
          const snapshot = entry.snapshot;
          const attempt = Date.parse(snapshot.fundingHistoryAttemptAt ?? "");
          return (snapshot.mode ?? "paper") === "paper" &&
            ["open", "closed"].includes(entry.status) &&
            snapshot.fundingStatus !== "legacy_unknown" &&
            Array.isArray(snapshot.paperFills) &&
            snapshot.paperFills.length > 0 &&
            (snapshot.fundingStatus === "incomplete" ||
              Number(snapshot.fundingNextFundingTime) <= now) &&
            (!Number.isFinite(attempt) || now - attempt >= 5 * 60_000);
        })
        .slice(0, limit)
        .map(([sourceSignalId, entry]) => ({
          source_signal_id: sourceSignalId,
          snapshot: entry.snapshot,
          status: entry.status,
          updated_at: null,
        }));
      return { rowCount: rows.length, rows };
    }
    if (text.includes("FROM btb_positions") && text.includes("FOR UPDATE")) {
      const current = row(params[0]);
      return current
        ? { rowCount: 1, rows: [{ snapshot: current.snapshot, status: current.status }] }
        : { rowCount: 0, rows: [] };
    }
    if (text.includes("FROM btb_positions")) {
      const current = row(params[0]);
      return current
        ? { rowCount: 1, rows: [{ source_signal_id: params[0] }] }
        : { rowCount: 0, rows: [] };
    }
    if (text.includes("INSERT INTO btb_positions")) {
      const [sourceSignalId, serializedSnapshot, status] = params;
      const current = transaction.positions.get(sourceSignalId);
      if (current) return { rowCount: 0, rows: [] };
      const snapshot = JSON.parse(serializedSnapshot);
      transaction.positions.set(sourceSignalId, {
        snapshot,
        status: status ?? snapshot.status,
      });
      transaction.signals.set(sourceSignalId, "open");
      return { rowCount: 1, rows: [{ source_signal_id: sourceSignalId }] };
    }
    if (text.includes("UPDATE btb_positions")) {
      const [sourceSignalId, serializedSnapshot, status] = params;
      transaction.positions.set(sourceSignalId, {
        snapshot: JSON.parse(serializedSnapshot),
        status,
      });
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected PAPER store SQL: ${text}`);
  };
  const client = { query, release() {} };
  let failEventInsert = false;
  const pool = {
    query,
    connect: async () => client,
  };
  return {
    store: createStore(pool),
    account: () => ({ ...account }),
    events: () => [...events],
    signalStatus: (id) => signals.get(id),
    positionSnapshot: (id) => positions.get(id)?.snapshot,
    failNextEventInsert() { failEventInsert = true; },
    seedPosition(sourceSignalId, snapshot) {
      positions.set(sourceSignalId, { snapshot, status: snapshot.status });
      account.free_usdt -= snapshot.marginHeldUsd;
      account.reserved_usdt += snapshot.marginHeldUsd;
      account.realized_pnl_usdt += snapshot.realizedPnlUsdt ?? 0;
    },
    seedSourceExitRequest(sourceSignalId, detail) {
      const id = nextEventId++;
      events.push({
        id,
        source_signal_id: sourceSignalId,
        kind: "paper_source_exit_requested",
        detail,
      });
      return id;
    },
  };
}

function newPosition(sourceSignalId = "cab-signal-123") {
  return {
    sourceSignalId,
    symbol: "BTCUSDT",
    entryPrice: 100,
    entryAt: "2026-01-01T00:00:00.000Z",
    quantity: 1,
    remainingQty: 1,
    marginHeldUsd: 10,
    stopPrice: 90,
    status: "open",
    realizedPnlUsdt: 0,
  };
}

test("standard taker fees use precise USDT rounding", () => {
  assert.equal(PAPER_TAKER_FEE_RATE, 0.0005);
  assert.deepEqual(paperFillCosts("1234.56789", "2"), {
    notionalUsdt: 2469.13578,
    feeUsdt: 1.23456789,
  });
  assert.deepEqual(paperFillCosts("0.00000001", "1"), {
    notionalUsdt: 0.00000001,
    feeUsdt: 0,
  });
});

test("read-only personal fee uses signed GET and never returns account data", async () => {
  let calls = 0;
  const reader = createPaperFeeReader({
    clock: () => Date.parse("2026-09-26T12:00:00Z"),
    credentials: () => ({ key: "test-key", secret: "test-secret" }),
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(options.method, "GET");
      assert.equal(new URL(url).pathname, "/openApi/swap/v2/user/commissionRate");
      assert.equal(new URL(url).searchParams.get("symbol"), "BTC-USDT");
      assert.ok(new URL(url).searchParams.get("signature"));
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: { takerCommissionRate: "0.00035", makerCommissionRate: "0.0002", balance: "private" },
        }),
      };
    },
  });
  const model = await resolvePaperFeeModel(reader, "BTCUSDT", () => Date.parse("2026-09-26T12:00:00Z"));
  assert.equal(calls, 1);
  assert.equal(model.rate, 0.00035);
  assert.equal(model.accountTierVerified, true);
  assert.equal(model.checkedAt, "2026-09-26T12:00:00.000Z");
  assert.equal(JSON.stringify(model).includes("balance"), false);
  assert.equal(paperFillCosts(100, 1, model.rate).feeUsdt, 0.035);
});

test("missing credentials, invalid fees and exchange failure retain a dated assumption", async () => {
  const now = () => Date.parse("2026-09-26T12:00:00Z");
  const missing = createPaperFeeReader({ credentials: () => ({}) });
  const invalid = createPaperFeeReader({
    clock: now,
    credentials: () => ({ key: "key", secret: "secret" }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ code: 0, data: { takerCommissionRate: null } }) }),
  });
  for (const reader of [missing, invalid, async () => { throw new Error("network failed"); }]) {
    const model = await resolvePaperFeeModel(reader, "BTCUSDT", now);
    assert.equal(model.rate, PAPER_TAKER_FEE_RATE);
    assert.equal(model.accountTierVerified, false);
    assert.equal(model.checkedAt, "2026-09-26T12:00:00.000Z");
    assert.match(model.source, /assumption/);
  }
});

test("personal entry fee debits once and keeps its original observation", async () => {
  const h = paperStore();
  const model = {
    ...paperFeeModel("2026-09-26T12:00:00Z"),
    version: "bingx-perpetual-personal-taker-v1",
    rate: 0.00035,
    source: "BingX private swap commissionRate GET",
    accountTierVerified: true,
    assumption: null,
  };
  const opened = await h.store.openPaperPosition({ ...newPosition(), feeModel: model });
  assert.equal(opened.position.feesPaidUsdt, 0.035);
  assert.equal(opened.position.paperFills[0].feeRate, 0.00035);
  assert.equal(opened.position.paperFills[0].feeCheckedAt, model.checkedAt);
  assert.equal(opened.position.paperFills[0].feeTierVerified, true);
  assert.equal((await h.store.openPaperPosition({ ...newPosition(), feeModel: paperFeeModel() })).kind, "duplicate");
  assert.equal(h.account().realized_pnl_usdt, -0.035);
});

test("entry fee is debited with the reservation exactly once and its tier is labelled", async () => {
  const h = paperStore();
  const opened = await h.store.openPaperPosition(newPosition());
  const fee = paperFillCosts(100, 1).feeUsdt;
  assert.equal(opened.kind, "opened");
  assert.equal(opened.position.realizedPnlUsdt, -fee);
  assert.equal(opened.position.grossRealizedPnlUsdt, 0);
  assert.equal(opened.position.feesPaidUsdt, fee);
  assert.deepEqual(opened.position.feeModel, paperFeeModel());
  assert.equal(opened.position.paperFills[0].feeUsdt, fee);
  assert.equal(opened.position.paperFills[0].feeTierVerified, false);
  assert.deepEqual(h.account(), {
    initial_usdt: 100,
    free_usdt: 90 - fee,
    reserved_usdt: 10,
    realized_pnl_usdt: -fee,
  });

  assert.equal((await h.store.openPaperPosition(newPosition())).kind, "duplicate");
  assert.deepEqual(h.account(), {
    initial_usdt: 100,
    free_usdt: 90 - fee,
    reserved_usdt: 10,
    realized_pnl_usdt: -fee,
  });
});

test("insufficient PAPER balance rolls back both the fee and margin reservation", async () => {
  const h = paperStore({ freeUsdt: 10.04 });
  const result = await h.store.openPaperPosition(newPosition());
  assert.equal(result.kind, "insufficient");
  assert.deepEqual(h.account(), {
    initial_usdt: 100,
    free_usdt: 10.04,
    reserved_usdt: 0,
    realized_pnl_usdt: 0,
  });
});

test("entry reservation uses the exact modeled stop-margin shortfall", async () => {
  const h = paperStore();
  const position = { ...newPosition("cab-signal-larger-margin"), marginHeldUsd: 12.34567891 };
  const opened = await h.store.openPaperPosition(position);
  const fee = paperFillCosts(100, 1).feeUsdt;
  assert.equal(opened.kind, "opened");
  assert.equal(opened.position.marginHeldUsd, 12.34567891);
  assert.deepEqual(h.account(), {
    initial_usdt: 100,
    free_usdt: 100 - 12.34567891 - fee,
    reserved_usdt: 12.34567891,
    realized_pnl_usdt: -fee,
  });
});

test("PAPER stop-margin top-up is atomic, PnL-neutral, and idempotent", async () => {
  const h = paperStore();
  const opened = await h.store.openPaperPosition(newPosition("cab-signal-margin-topup"));
  const previous = opened.position;
  const amount = 1.23456789;
  const next = {
    ...previous,
    marginHeldUsd: previous.marginHeldUsd + amount,
    paperMargin: {
      model: "isolated-stop-buffer-v1",
      status: "buffered",
      topUps: [{
        amountUsdt: amount,
        at: "2026-01-01T00:01:00.000Z",
        source: "paper_free_balance",
      }],
    },
  };
  const result = await h.store.topUpPaperPosition(previous, next, amount);
  assert.equal(result.kind, "topped_up");
  const afterTopUp = h.account();
  assert.ok(Math.abs(afterTopUp.free_usdt - (100 - 10 - 0.05 - amount)) < 0.00000001);
  assert.equal(afterTopUp.reserved_usdt, 10 + amount);
  assert.equal(afterTopUp.realized_pnl_usdt, -0.05);
  assert.equal(
    (await h.store.topUpPaperPosition(previous, next, amount)).kind,
    "stale",
  );
  assert.deepEqual(h.account(), afterTopUp);
});

test("insufficient PAPER free balance does not alter top-up accounting", async () => {
  const h = paperStore({ freeUsdt: 10.05 });
  const opened = await h.store.openPaperPosition(newPosition("cab-signal-margin-low"));
  const previous = opened.position;
  const next = {
    ...previous,
    marginHeldUsd: previous.marginHeldUsd + 1,
    paperMargin: { model: "isolated-stop-buffer-v1", status: "insufficient_funds", topUps: [] },
  };
  const before = h.account();
  assert.equal(
    (await h.store.topUpPaperPosition(previous, next, 1)).kind,
    "insufficient",
  );
  assert.deepEqual(h.account(), before);
});

test("partial and final exit fees settle net PnL once; stale retries do not debit again", async () => {
  const h = paperStore();
  const opened = await h.store.openPaperPosition(newPosition());
  const prior = opened.position;
  const exitPrice = 110;
  const exitQuantity = 0.4;
  const { feeUsdt } = paperFillCosts(exitPrice, exitQuantity);
  const gross = (exitPrice - prior.entryPrice) * exitQuantity;
  const partial = {
    ...prior,
    remainingQty: 0.6,
    marginHeldUsd: 6,
    grossRealizedPnlUsdt: gross,
    feesPaidUsdt: prior.feesPaidUsdt + feeUsdt,
    realizedPnlUsdt: prior.realizedPnlUsdt + gross - feeUsdt,
    paperFills: [...prior.paperFills, {
      type: "exit",
      price: exitPrice,
      quantity: exitQuantity,
      feeUsdt,
      reason: "protective_stop",
      occurredAt: "2026-01-01T00:01:00.000Z",
    }],
  };
  assert.equal((await h.store.settlePaperPosition(prior, partial)).kind, "settled");
  const afterPartial = h.account();
  assert.equal(afterPartial.reserved_usdt, 6);
  assert.equal(afterPartial.realized_pnl_usdt, partial.realizedPnlUsdt);
  assert.equal((await h.store.settlePaperPosition(prior, partial)).kind, "stale");
  assert.deepEqual(h.account(), afterPartial);

  const finalFee = paperFillCosts(120, 0.6).feeUsdt;
  const finalGross = (120 - prior.entryPrice) * 0.6;
  const closed = {
    ...partial,
    remainingQty: 0,
    marginHeldUsd: 0,
    status: "closed",
    grossRealizedPnlUsdt: gross + finalGross,
    feesPaidUsdt: partial.feesPaidUsdt + finalFee,
    realizedPnlUsdt: partial.realizedPnlUsdt + finalGross - finalFee,
    paperFills: [...partial.paperFills, {
      type: "exit",
      price: 120,
      quantity: 0.6,
      feeUsdt: finalFee,
      reason: "protective_stop",
      occurredAt: "2026-01-01T00:02:00.000Z",
    }],
  };
  assert.equal((await h.store.settlePaperPosition(partial, closed)).kind, "settled");
  assert.equal(h.account().reserved_usdt, 0);
  assert.equal(h.account().realized_pnl_usdt, closed.realizedPnlUsdt);
  assert.equal((await h.store.settlePaperPosition(partial, closed)).kind, "stale");
  assert.equal(h.account().realized_pnl_usdt, closed.realizedPnlUsdt);
});

test("PAPER close, signal status, wallet, snapshot, and audit event commit atomically", async () => {
  const h = paperStore();
  const opened = await h.store.openPaperPosition(newPosition("cab-signal-atomic-close"));
  const prior = opened.position;
  const closed = {
    ...prior,
    remainingQty: 0,
    marginHeldUsd: 0,
    status: "closed",
    paperFills: [...prior.paperFills, {
      type: "exit",
      price: 110,
      quantity: 1,
      feeUsdt: 0.055,
      reason: "core_trailing_stop",
      occurredAt: "2026-01-01T00:01:00.000Z",
    }],
  };
  const events = [{
    kind: "paper_close_core",
    detail: { reason: "core_trailing_stop", fillPrice: 110 },
  }];
  const beforeAccount = h.account();
  h.failNextEventInsert();
  await assert.rejects(
    h.store.settlePaperPosition(prior, closed, { events, closeSignal: true }),
    /simulated audit insert failure/,
  );
  assert.deepEqual(h.account(), beforeAccount);
  assert.equal(h.signalStatus(prior.sourceSignalId), "open");
  assert.deepEqual(h.positionSnapshot(prior.sourceSignalId), prior);
  assert.deepEqual(h.events(), []);

  assert.equal(
    (await h.store.settlePaperPosition(prior, closed, { events, closeSignal: true })).kind,
    "settled",
  );
  assert.equal(h.signalStatus(prior.sourceSignalId), "closed");
  assert.deepEqual(h.positionSnapshot(prior.sourceSignalId), closed);
  assert.deepEqual(h.events().map((event) => event.kind), ["paper_close_core"]);
  const afterCommit = h.account();
  assert.equal(
    (await h.store.settlePaperPosition(prior, closed, { events, closeSignal: true })).kind,
    "stale",
  );
  assert.deepEqual(h.account(), afterCommit);
  assert.equal(h.events().length, 1);
});

test("a durable source exit blocks stale closes and is acknowledged atomically with its fill", async () => {
  const h = paperStore();
  const opened = await h.store.openPaperPosition(newPosition("cab-signal-source-withdrawal"));
  const prior = opened.position;
  const evidence = {
    sourceSignalId: prior.sourceSignalId,
    symbol: prior.symbol,
    reason: "source_withdrawal",
    sourceStatus: "reclassified",
    sourceUpdatedAt: "2026-01-01T00:00:05.000Z",
    sourceClosedAt: null,
    sourceExitPrice: null,
    sourceCancelReason: "lc_no_lower_ob_moved_to_wait",
    exitDecisionAt: "2026-01-01T00:00:05.000Z",
    asOf: "2026-01-01T00:00:06.000Z",
    observedAt: "2026-01-01T00:00:06.000Z",
  };
  const requestId = h.seedSourceExitRequest(prior.sourceSignalId, evidence);
  const ordinaryClose = {
    ...prior,
    remainingQty: 0,
    marginHeldUsd: 0,
    status: "closed",
  };
  const before = h.account();
  assert.equal(
    (await h.store.settlePaperPosition(prior, ordinaryClose, { closeSignal: true })).kind,
    "stale",
  );
  assert.deepEqual(h.account(), before);
  assert.equal(h.positionSnapshot(prior.sourceSignalId).status, "open");

  const sourceClose = {
    ...ordinaryClose,
    sourceWithdrawal: evidence,
  };
  assert.equal(
    (await h.store.settlePaperPosition(prior, sourceClose, {
      closeSignal: true,
      sourceExitRequestId: requestId,
      events: [{
        kind: "paper_close_all",
        detail: {
          reason: "source_bullet_withdrawn",
          sourceWithdrawal: evidence,
        },
      }],
    })).kind,
    "settled",
  );
  assert.equal(h.positionSnapshot(prior.sourceSignalId).status, "closed");
  assert.deepEqual(
    h.events().map((event) => event.kind),
    [
      "paper_source_exit_requested",
      "paper_close_all",
      "paper_source_exit_applied",
    ],
  );
});

test("PAPER margin top-up audit event commits once with its wallet reservation", async () => {
  const h = paperStore();
  const opened = await h.store.openPaperPosition(newPosition("cab-signal-atomic-topup"));
  const previous = opened.position;
  const amount = 1;
  const next = {
    ...previous,
    marginHeldUsd: previous.marginHeldUsd + amount,
    paperMargin: { model: "isolated-stop-buffer-v1", status: "buffered", topUps: [] },
  };
  const audit = {
    kind: "paper_margin_top_up",
    detail: { amountUsdt: amount, marginHeldUsd: next.marginHeldUsd },
  };
  const beforeTopUp = h.account();
  h.failNextEventInsert();
  await assert.rejects(
    h.store.topUpPaperPosition(previous, next, amount, audit),
    /simulated audit insert failure/,
  );
  assert.deepEqual(h.account(), beforeTopUp);
  assert.deepEqual(h.positionSnapshot(previous.sourceSignalId), previous);
  assert.deepEqual(h.events(), []);

  assert.equal(
    (await h.store.topUpPaperPosition(previous, next, amount, audit)).kind,
    "topped_up",
  );
  assert.equal(h.events().length, 1);
  assert.equal(h.events()[0].kind, audit.kind);
  const afterTopUp = h.account();
  assert.equal(
    (await h.store.topUpPaperPosition(previous, next, amount, audit)).kind,
    "stale",
  );
  assert.deepEqual(h.account(), afterTopUp);
  assert.equal(h.events().length, 1);
});

test("an applied zero-rate funding ledger event is transactionally idempotent", async () => {
  const h = paperStore();
  const opened = await h.store.openPaperPosition(newPosition("cab-signal-funding"));
  const prior = opened.position;
  const settled = {
    ...prior,
    fundingPaidUsdt: 0,
    fundingSettlements: [{
      fundingTime: Date.parse("2026-01-01T08:00:00.000Z"),
      fundingRate: "0",
      quantity: 1,
      settlementPrice: 100,
      priceSource: "BingX public premiumIndex mark near funding time",
      priceEstimation: "near_settlement_mark",
      priceObservedAt: "2026-01-01T08:00:00.000Z",
      signedCostUsdt: 0,
      status: "applied",
    }],
  };
  const before = h.account();
  assert.equal((await h.store.settlePaperPosition(prior, settled)).kind, "settled");
  assert.deepEqual(h.account(), before);
  assert.equal((await h.store.settlePaperPosition(prior, settled)).kind, "stale");
  assert.deepEqual(h.account(), before);
});

test("paper funding health counts incomplete and legacy snapshots across the account", async () => {
  const h = paperStore();
  h.seedPosition("cab-signal-incomplete", {
    ...newPosition("cab-signal-incomplete"),
    fundingStatus: "incomplete",
  });
  h.seedPosition("cab-signal-legacy", {
    ...newPosition("cab-signal-legacy"),
  });
  h.seedPosition("cab-signal-live", {
    ...newPosition("cab-signal-live"),
    mode: "live",
    fundingStatus: "incomplete",
  });
  assert.deepEqual(await h.store.getPaperFundingHealth(), {
    incompleteCount: 1,
    legacyUnknownCount: 1,
  });
});

test("closed funding candidates are limited and attempts are throttled", async () => {
  const h = paperStore();
  h.seedPosition("cab-signal-closed-incomplete", {
    ...newPosition("cab-signal-closed-incomplete"),
    status: "closed",
    mode: "paper",
    fundingStatus: "incomplete",
    fundingHistoryAttemptAt: "2026-01-01T00:00:00.000Z",
    paperFills: [{
      type: "entry",
      quantity: 1,
      occurredAt: "2026-01-01T00:00:00.000Z",
    }],
  });
  h.seedPosition("cab-signal-closed-legacy", {
    ...newPosition("cab-signal-closed-legacy"),
    status: "closed",
    mode: "paper",
    fundingStatus: "legacy_unknown",
  });
  const due = Date.parse("2026-01-01T00:06:00.000Z");
  const candidates = await h.store.listPaperFundingCandidates(due, 1);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sourceSignalId, "cab-signal-closed-incomplete");
  assert.equal(candidates[0].status, "closed");
  assert.deepEqual(await h.store.listPaperFundingCandidates(due - 120_001, 1), []);
  await assert.rejects(h.store.listPaperFundingCandidates(due, 21), /between 1 and 20/);
});

test("legacy snapshots pay only fees for newly simulated exit fills", async () => {
  const h = paperStore();
  const legacy = {
    ...newPosition("cab-signal-legacy"),
    realizedPnlUsdt: 2,
  };
  h.seedPosition(legacy.sourceSignalId, legacy);
  const { feeUsdt } = paperFillCosts(105, 1);
  const closed = {
    ...legacy,
    remainingQty: 0,
    marginHeldUsd: 0,
    status: "closed",
    grossRealizedPnlUsdt: 2 + 5,
    feesPaidUsdt: feeUsdt,
    realizedPnlUsdt: 2 + 5 - feeUsdt,
    paperFills: [{
      type: "exit",
      price: 105,
      quantity: 1,
      feeUsdt,
      reason: "protective_stop",
      occurredAt: "2026-01-01T00:01:00.000Z",
    }],
  };
  assert.equal((await h.store.settlePaperPosition(legacy, closed)).kind, "settled");
  assert.equal(h.account().realized_pnl_usdt, closed.realizedPnlUsdt);
  assert.equal(closed.feesPaidUsdt, feeUsdt);
  assert.equal(closed.paperFills.length, 1);
});