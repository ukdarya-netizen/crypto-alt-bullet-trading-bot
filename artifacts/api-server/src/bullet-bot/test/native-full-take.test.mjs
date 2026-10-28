import test from "node:test";
import assert from "node:assert/strict";
import { createNativeTakeApi, createNativeTakeManager, nativeTakePrice,
  nativeTakeOpenMatches, nativeTakeQueryMatches, proveNativeTakeFill,
} from "../native-full-take.mjs";
import { vstTradeOutcome } from "../telegram-trade-outcomes.mjs";

const now = 1792920000000;
const base = () => ({ symbol: "BTCUSDT", positionId: "201", entryOrderId: "101",
  entryPrice: "100", quantity: "2", takePrice: "105.00",
  workingType: "CONTRACT_PRICE", clientOrderId: "nt_test", createdAt: now - 10000 });
const stop = () => ({ orderId: "301", symbol: "BTC-USDT", type: "STOP_MARKET",
  side: "SELL", positionSide: "LONG", positionID: "201", status: "NEW",
  origQty: "2", stopPrice: "92", executedQty: "0", workingType: "MARK_PRICE" });
const take = () => ({ ...stop(), orderId: "302", type: "TAKE_PROFIT_MARKET", stopPrice: "105.00" });
const placeholder = () => ({ ...take(), type: "LIMIT", positionID: 0, price: "0.0",
  stopPrice: "", workingType: "CONTRACT_PRICE",
  takeProfit: { type: "TAKE_PROFIT_MARKET", workingType: "CONTRACT_PRICE" } });

function fixture() {
  const state = { positions: [{ symbol: "BTC-USDT", positionSide: "LONG", positionId: "201",
    positionAmt: "2" }], orders: [stop()], mode: "HEDGE", margin: "ISOLATED", leverage: 10,
    posts: 0, deletes: 0, attempted: false, cancelled: new Set(),
    positionReads: 0, orderReads: 0,
    failTransport: false, loseAck: false };
  const raw = {
    getPositions: async () => { state.positionReads++; return structuredClone(state.positions); },
    getOpenOrders: async () => { state.orderReads++; return structuredClone(state.orders); },
    queryOrder: async (_s, key) => {
      if (key.orderId === "101") return { orderId: "101", symbol: "BTC-USDT",
        side: "BUY", positionSide: "LONG", status: "FILLED", avgPrice: "100", executedQty: "2" };
      if (key.clientOrderId && !state.posts) return null;
      if (state.cancelled.has(key.orderId)) return { orderId: key.orderId, status: "CANCELLED" };
      return state.posts || key.orderId === "302" ? placeholder() : null;
    },
  };
  const native = createNativeTakeApi({
    assertVst: () => {}, readOrders: raw.getOpenOrders, readPositions: raw.getPositions,
    queryOrder: raw.queryOrder, contract: async () => ({ pricePrecision: 2 }),
    getPositionMode: async () => state.mode, getMarginType: async () => { state.marginReads = (state.marginReads ?? 0) + 1; return state.margin; },
    getLeverage: async () => ({ longLeverage: state.leverage }),
    exactOrderId: (value) => value.order.orderId, clock: () => now,
    write: async (method, params, options) => {
      await options.beforeSign();
      if (method === "POST") {
        await options.beforeTransport();
        assert.equal(state.attempted, true, "durable submitted marker precedes transport");
        state.posts++;
        if (state.failTransport) throw Error("ambiguous_transport");
        state.orders.push({ ...take(), clientOrderId: params.clientOrderId });
        if (state.loseAck) throw Error("lost_ack");
        return { order: { orderId: "302" } };
      }
      state.deletes++;
      state.orders = state.orders.filter((o) => o.orderId !== params.orderId);
      state.cancelled.add(params.orderId);
      return {};
    },
  });
  const snapshot = { sourceSignalId: "source-1", symbol: "BTCUSDT", status: "open",
    environment: "vst", accountId: "owner", leverage: 10, marginMode: "ISOLATED",
    remainingQty: 2, entryPrice: "100", exchangePositionId: "201", entryOrderId: "101",
    coreStopOrderId: "301", coreStopQuantity: 2, stopPrice: 92 };
  const record = { sourceSignalId: "source-1", symbol: "BTCUSDT", status: "open",
    snapshot, updatedAt: "2026-10-25 10:00:00.123456+00" };
  const intents = [], events = [], commits = [];
  const store = {
    latestNativeTakeIntent: async () => intents.at(-1) ?? null,
    listNativeTakeIntents: async () => structuredClone(intents.filter((i) =>
      ["prepared", "submitted", "unknown"].includes(i.state))),
    listOpenPositions: async () => record.status === "closed" ? [] : [structuredClone(record)],
    getNativeTakePosition: async () => structuredClone(record),
    hasPendingSourceExitRequest: async () => false,
    reserveIntent: async (input) => {
      const intent = { ...structuredClone(input), state: "prepared", exchangeOrderId: null };
      intents.push(intent); return { kind: "new", intent };
    },
    markIntent: async (client, status, data = {}) => {
      const intent = intents.find((i) => i.clientOrderId === client);
      intent.state = status;
      intent.outcome = data.outcome;
      intent.exchangeOrderId = data.exchangeOrderId ?? intent.exchangeOrderId;
      if (data.outcome?.attempted) state.attempted = true;
    },
    recordEvent: async (_source, kind, detail) => events.push({ kind, detail }),
    commitVerifiedIntent: async (input) => {
      assert.equal(input.expectedPositionUpdatedAt, record.updatedAt);
      assert.deepEqual(input.expectedPositionSnapshot, record.snapshot);
      assert.equal(input.retireNativeTakeSiblings, true);
      commits.push(input);
      record.status = "closed"; record.snapshot = input.position;
      intents.find((i) => i.clientOrderId === input.clientOrderId).state = "reconciled";
    },
  };
  const api = { ...raw, nativeFullTake: native };
  return { state, native, api, record, store, intents, events, commits };
}

test("native take target is five percent of actual fill, rounded UP to tick", () => {
  assert.equal(nativeTakePrice("80198.2", 1), "84208.2");
  assert.equal(nativeTakePrice("0.01342", 6), "0.014091");
  assert.equal(nativeTakePrice("100", 2), "105.00");
  assert.throws(() => nativeTakePrice("100", 19));
});

test("active exact-ID LIMIT placeholder needs independent full owned TAKE order", () => {
  const binding = { ...base(), orderId: "302" };
  assert.equal(nativeTakeQueryMatches(placeholder(), binding, take()), true);
  for (const change of [
    { price: "105" }, { executedQty: "1" }, { side: "BUY" }, { origQty: "1" },
    { positionID: "999" }, { takeProfit: { type: "LIMIT" } },
  ]) assert.equal(nativeTakeQueryMatches({ ...placeholder(), ...change }, binding, take()), false);
  assert.equal(nativeTakeQueryMatches(placeholder(), binding, { ...take(), positionID: "999" }), false);
  assert.equal(nativeTakeOpenMatches({ ...take(), orderID: "303" }, binding), false);
});

test("native API posts one full TAKE, keeps original SL, and leaves raw orders visible", async () => {
  const f = fixture();
  const submitted = await f.native.create(base(), [{ orderId: "301", quantity: "2", stopPrice: "92" }],
    async () => { f.state.attempted = true; });
  assert.equal(submitted.orderId, "302");
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.deletes, 0);
  assert.equal((await f.api.getOpenOrders()).length, 2);
  assert.equal(f.native.guardOrders(await f.api.getOpenOrders()).length, 1);
  const evidence = await f.native.inspect(submitted);
  assert.equal(evidence.active, true);
  assert.equal(evidence.triggerBasisVerified, false, "preserve the observed basis disagreement");
  assert.throws(() => f.native.assertEntryAllowed("BTCUSDT"), /cleanup_pending/);
});

test("creation refuses foreign exposure, wrong leverage, missing stop and an incorrect +5% target", async () => {
  for (const mutate of [
    (f) => { f.state.leverage = 20; }, (f) => { f.state.margin = "CROSSED"; },
    (f) => { f.state.mode = "ONE_WAY"; },
    (f) => { f.state.positions[0].positionId = "999"; },
    (f) => { f.state.orders[0].stopPrice = "91"; },
    (f) => { f.state.orders.push(take()); },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.native.create(base(),
      [{ orderId: "301", quantity: "2", stopPrice: "92" }], async () => {}));
    assert.equal(f.state.posts, 0);
  }
  const f = fixture();
  await assert.rejects(f.native.create({ ...base(), takePrice: "104" }, [], async () => {}), /five_percent/);
});

test("guard view never hides an unowned, changed or wrong-quantity take", () => {
  const f = fixture(), binding = { ...base(), orderId: "302" };
  f.native.register(binding);
  assert.equal(f.native.guardOrders([stop(), { ...take(), orderId: "999" }]).length, 2);
  for (const change of [{ origQty: "1" }, { stopPrice: "106" }, { positionID: "999" },
    { type: "LIMIT" }, { status: "FILLED" }, { side: "BUY" }])
    assert.throws(() => f.native.guardOrders([{ ...take(), ...change }]), /conflict/);
});

test("durable native manager creates immediately and never repeats a submitted POST after restart", async () => {
  const f = fixture();
  const create = () => createNativeTakeManager({ api: f.api, store: f.store,
    proveFill: async () => ({ verified: false }), clock: () => now });
  await create().ensure(f.record);
  assert.equal(f.state.posts, 1);
  await create().sweep();
  await create().sweep();
  assert.equal(f.state.posts, 1);
  assert.equal(f.events.filter((e) => e.kind === "vst_native_take_verified").length, 1);
});

test("a resting take uses a single fresh account cohort, without per-position re-query loops", async () => {
  const f = fixture();
  const manager = createNativeTakeManager({ api: f.api, store: f.store,
    proveFill: async () => ({ verified: false }), clock: () => now });
  await manager.ensure(f.record);
  f.state.positionReads = 0; f.state.orderReads = 0;
  await manager.sweep();
  assert.equal(f.state.positionReads, 1);
  assert.equal(f.state.orderReads, 1);
  assert.equal(manager.ownsPosition("source-1"), true, "reserve flat attribution for the owned take");
});

test("a non-scalp position never acquires a +5% native take from new worker defaults", async () => {
  const f = fixture();
  f.record.snapshot.executionStrategy = {
    version: 1, exitStrategy: "source", strategyAuthority: "policy",
  };
  const manager = createNativeTakeManager({ api: f.api, store: f.store,
    proveFill: async () => ({ verified: false }), clock: () => now });
  await manager.ensure(f.record);
  assert.equal(f.state.posts, 0);
  assert.equal(f.intents.length, 0);
});

test("an unknown pinned strategy version cannot place a native take", async () => {
  const f = fixture();
  f.record.snapshot.executionStrategy = {
    version: 2, exitStrategy: "full_take_5pct", strategyAuthority: "source",
  };
  const manager = createNativeTakeManager({ api: f.api, store: f.store,
    proveFill: async () => ({ verified: false }), clock: () => now });
  await assert.rejects(manager.ensure(f.record), /Unsupported position strategy version/);
  assert.equal(f.state.posts, 0);
});

test("a previously pinned +5% position retains its native take with non-scalp worker defaults", async () => {
  const f = fixture();
  f.record.snapshot.executionStrategy = {
    version: 1, exitStrategy: "full_take_5pct", strategyAuthority: "source",
  };
  const manager = createNativeTakeManager({ api: f.api, store: f.store,
    legacyExitStrategy: "source",
    proveFill: async () => ({ verified: false }), clock: () => now });
  await manager.ensure(f.record);
  assert.equal(f.state.posts, 1);
});

test("ambiguous transport is never retried even when exact client lookup has no result", async () => {
  const f = fixture(); f.state.failTransport = true;
  const manager = () => createNativeTakeManager({ api: f.api, store: f.store,
    proveFill: async () => ({ verified: false }), clock: () => now });
  await manager().ensure(f.record);
  f.api.queryOrder = async () => null;
  await manager().sweep();
  await manager().sweep();
  assert.equal(f.state.posts, 1);
});

test("fresh flat observation cancels only known TAKE; leaves stop attribution to the original worker", async () => {
  const f = fixture();
  const manager = createNativeTakeManager({ api: f.api, store: f.store,
    proveFill: async () => ({ verified: false }), clock: () => now });
  await manager.ensure(f.record);
  f.state.positions = [];
  await manager.sweep();
  assert.equal(f.state.deletes, 1);
  assert.equal(f.state.orders[0].orderId, "301", "do not cancel SL before proving the exit");
  assert.equal(f.commits.length, 0, "flat does not prove a profit take");
  assert.equal(manager.ownsPosition("source-1"), false, "SL proof can proceed once the TP is cancelled");
});

test("cleanup is forbidden while any live position remains", async () => {
  const f = fixture();
  await assert.rejects(f.native.cancelWhenFlat({ ...base(), orderId: "302" }), /requires_flat/);
  assert.equal(f.state.deletes, 0);
});

test("native full fill closes atomically, cleans owned SL and emits the real +5% Telegram outcome", async () => {
  const f = fixture();
  let filled = false;
  const query = f.api.queryOrder;
  f.api.queryOrder = async (...args) => filled && args[1].orderId === "302"
    ? { ...take(), status: "FILLED" } : query(...args);
  // inspect uses the independently captured query transport from fixture.
  const inspect = f.native.inspect;
  f.api.nativeFullTake = { ...f.native, inspect: async (b) => filled
    ? { ...(await inspect(b)), queried: { ...take(), status: "FILLED" }, active: false } : inspect(b) };
  const manager = createNativeTakeManager({ api: f.api, store: f.store, clock: () => now,
    proveFill: async () => ({ verified: true, status: "filled", childOrderId: "401",
      fill: { orderId: "401", triggerOrderId: "302", price: "105", quantity: "2",
        fee: { asset: "VST", amount: "0.1" }, at: new Date(now).toISOString() },
      residualPosition: { verified: true, quantity: "0" } }) });
  await manager.ensure(f.record);
  filled = true; f.state.positions = []; f.state.orders = [stop()];
  await manager.sweep();
  assert.equal(f.commits.length, 1);
  assert.equal(f.record.snapshot.remainingQty, 0);
  assert.equal(f.state.orders.length, 0);
  assert.equal(f.state.posts, 1);
  assert.equal(vstTradeOutcome({ kind: f.commits[0].eventKind, detail: f.commits[0].eventDetail }), "take");
});

function fillFixture() {
  const binding = { ...base(), orderId: "302" };
  const fills = [1, 2].map((n) => ({ tradeId: String(500 + n), orderId: "401",
    triggerOrderId: "302", symbol: "BTC-USDT", side: "SELL", positionSide: "LONG",
    qty: "1", price: n === 1 ? "105" : "105.02", commission: "-0.01",
    commissionAsset: "VST", filledTm: now - n }));
  const api = { queryOrder: async (_s, { orderId }) => orderId === "302"
    ? { ...take(), status: "FILLED" }
    : { orderId: "401", symbol: "BTC-USDT", status: "FILLED", type: "TAKE_PROFIT_MARKET",
      side: "SELL", positionSide: "LONG", executedQty: "2" },
    getPositions: async () => [], getOpenOrders: async () => [stop()],
    queryFills: async (_s, opts) => {
      assert.equal(opts.requireComplete, true);
      assert.equal(opts.currency, "USDT", "history uses the quote contract, not the demo wallet asset");
      return fills;
    } };
  return { api, binding, fills };
}

test("native execution proof aggregates unique partial fills and signed fees exactly", async () => {
  const f = fillFixture();
  const result = await proveNativeTakeFill(f.api, f.binding,
    [{ orderId: "301", quantity: "2", stopPrice: "92" }], now);
  assert.equal(result.verified, true);
  assert.equal(Number(result.fill.price), 105.01);
  assert.equal(result.fill.fee.amount, "-0.02");
});

test("fill proof rejects incomplete quantity, wrong parent, duplicate trade, foreign SL and missing fees", async () => {
  for (const mutate of [
    (f) => { f.fills.pop(); },
    (f) => { f.fills[0].triggerOrderId = "999"; },
    (f) => { f.fills[0].tradeId = f.fills[1].tradeId; },
    (f) => { f.fills[0].positionId = "999"; },
    (f) => { delete f.fills[0].commission; },
    (f) => { f.api.getOpenOrders = async () => [{ ...stop(), orderId: "999" }]; },
    (f) => { f.api.getPositions = async () => [{ symbol: "BTC-USDT", positionAmt: "1" }]; },
  ]) {
    const f = fillFixture(); mutate(f);
    assert.equal((await proveNativeTakeFill(f.api, f.binding,
      [{ orderId: "301", quantity: "2", stopPrice: "92" }], now)).verified, false);
  }
});

test("NOT 2026-10-28: fills without triggerOrderId are linked through the queried take (child order + clientOrderId)", async () => {
  const binding = { ...base(), orderId: "302" };
  const fills = [{ tradeId: "640793875", orderId: "401", symbol: "BTC-USDT", side: "SELL",
    positionSide: "LONG", qty: "2", price: "104.9", commission: "-0.02", commissionAsset: "VST",
    filledTime: new Date(now - 5).toISOString() }];
  const executed = { orderId: "401", triggerOrderId: "302", clientOrderId: "nt_test",
    symbol: "BTC-USDT", status: "FILLED", type: "TAKE_PROFIT_MARKET", side: "SELL",
    positionSide: "LONG", executedQty: "2", positionID: 0, price: "0" };
  const api = {
    queryOrder: async (_s, { orderId }) => (orderId === "302" ? executed : null),
    getPositions: async () => [], getOpenOrders: async () => [],
    queryFills: async () => fills,
  };
  const stops = [{ orderId: "301", quantity: "2", stopPrice: "92" }];
  const ok = await proveNativeTakeFill(api, binding, stops, now);
  assert.equal(ok.verified, true);
  assert.equal(ok.childOrderId, "401");
  assert.equal(Number(ok.fill.price), 104.9);
  for (const mutate of [
    () => { executed.clientOrderId = "nt_other"; },
    () => { executed.triggerOrderId = "999"; },
    () => { fills[0].orderId = "402"; },
    () => { fills[0].qty = "1"; },
  ]) {
    const saved = structuredClone({ executed, fills });
    mutate();
    assert.equal((await proveNativeTakeFill(api, binding, stops, now)).verified, false);
    Object.assign(executed, saved.executed); fills[0] = saved.fills[0];
  }
});

test("a take that cannot be placed backs off (2,4,8.. min) and names the failing check", async () => {
  const f = fixture();
  f.state.margin = "CROSSED";
  let t = now;
  const manager = createNativeTakeManager({ api: f.api, store: f.store,
    proveFill: async () => ({ verified: false }), clock: () => t });
  await manager.ensure(f.record);
  const pending = f.events.filter((e) => e.kind === "vst_native_take_pending");
  assert.match(pending.at(-1).detail.reason, /native_take_entry_or_settings_changed:margin_type/);
  t += 60_000;
  const before = f.state.marginReads ?? 0;
  await manager.ensure(f.record);
  await manager.sweep();
  assert.equal(f.state.posts, 0);
  assert.equal((f.state.marginReads ?? 0) - before, 0, "no margin-type read inside the backoff window");
  t += 61_000; // past the 2-minute backoff
  f.state.margin = "ISOLATED";
  await manager.sweep();
  assert.equal(f.state.posts, 1, "retried after the backoff and placed");
});
