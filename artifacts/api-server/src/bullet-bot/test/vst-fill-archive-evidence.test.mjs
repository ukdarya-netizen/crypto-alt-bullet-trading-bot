import assert from "node:assert/strict";
import test from "node:test";
import { fillHistoryDigest, COMPLETE_FILL_HISTORY_PATH } from "../bingx-fill-history.mjs";
import { createVstBroker } from "../vst-broker.mjs";
import { assertArchiveCoverage, selectArchiveChain, validateArchiveWindow } from "../vst-fill-archive.mjs";

const DAY = 24 * 60 * 60 * 1000;
const WINDOW = 23 * 60 * 60 * 1000;
const now = 1_800_000_000_000;
const accountId = "vst-archive-evidence-test";
const entryOrderId = "2104952955909177345";
const closeOrderId = "2104992365002358785";
const parentOrderId = "2104952956043395073";
const entryAt = now - 10 * DAY;
const closeAt = entryAt + 60 * 60 * 1000;
const name = "US-USDT";

const iso = (time) => new Date(time).toISOString();

function makeOrder(orderId, options = {}) {
  return {
    symbol: name,
    orderId: String(orderId),
    status: "FILLED",
    side: "BUY",
    positionSide: "LONG",
    type: "MARKET",
    time: options.time ?? entryAt - 10_000,
    updateTime: options.time ?? entryAt,
    positionID: "2104952956043395073",
    origQty: "1",
    executedQty: "1",
    avgPrice: "100",
    ...options,
  };
}

function makeFill(tradeId, orderId, time, overrides = {}) {
  return {
    symbol: name,
    tradeId: String(tradeId),
    orderId: String(orderId),
    side: "BUY",
    positionSide: "LONG",
    filledTime: iso(time),
    qty: "1",
    price: "100",
    commission: "-0.01",
    currency: "USDT",
    commissionAsset: "VST",
    realisedPNL: "0",
    clientOrderID: "",
    ...overrides,
  };
}

function makeArchiveWindow(startTs, endTs, rows, orders, observedAt) {
  const coverage = {
    verified: true,
    endpoint: COMPLETE_FILL_HISTORY_PATH,
    currency: "USDT",
    startTs,
    endTs,
    rawCount: rows.length,
    pageSize: 1_000,
    passes: 2,
    terminalPage: 2,
    snapshotSha256: fillHistoryDigest(rows),
    observedAt: iso(observedAt),
  };
  return {
    environment: "vst",
    accountId,
    currency: "USDT",
    coverage,
    rawFills: rows,
    orders,
    archivedAt: iso(observedAt),
  };
}

function historicalArchive() {
  const startTs = entryAt - 70_000;
  const archivedThrough = now - 3 * DAY;
  const sourceFills = [
    makeFill("71001", entryOrderId, entryAt),
    makeFill("71002", closeOrderId, closeAt, {
      side: "SELL",
      realisedPNL: "-0.02",
      price: "99",
    }),
    makeFill("71003", "2104992365002358793", entryAt + 2 * DAY, {
      symbol: "BTC-USDT",
      orderId: "2104992365002358794",
    }),
  ];
  const allOrders = [
    makeOrder(entryOrderId, { time: entryAt - 10_000, updateTime: entryAt }),
    makeOrder(closeOrderId, {
      side: "SELL",
      reduceOnly: true,
      time: closeAt,
      updateTime: closeAt,
      avgPrice: "99",
    }),
    makeOrder("2104992365002358794", {
      symbol: "BTC-USDT",
      orderId: "2104992365002358794",
      time: entryAt + 2 * DAY,
    }),
  ];
  const windows = [];
  for (let cursor = startTs; cursor < archivedThrough;) {
    const end = Math.min(archivedThrough, cursor + WINDOW);
    const rows = sourceFills.filter((fill) => {
      const time = Date.parse(fill.filledTime);
      return time > cursor && time <= end;
    });
    const ids = new Set(rows.map((fill) => `${fill.symbol}:${fill.orderId}`));
    const orders = allOrders.filter((order) => ids.has(`${order.symbol}:${order.orderId}`));
    const observed = Math.max(end, Math.min(now - 3 * DAY, cursor + 7 * DAY - 1_000));
    windows.push(makeArchiveWindow(cursor, end, rows, orders, observed));
    cursor = end;
  }
  return { windows, startTs, archivedThrough, sourceFills, allOrders };
}

function candidate() {
  const quantity = "1";
  const clientOrderId = "parentvst-archive-evidence";
  return {
    sourceSignalId: "archive-evidence-signal",
    symbol: "USUSDT",
    status: "error",
    snapshot: {
      environment: "vst",
      accountId,
      symbol: "USUSDT",
      exchangePositionId: parentOrderId,
      verifiedFill: { price: "100", quantity, at: entryAt },
      remainingQty: quantity,
    },
    entryIntent: {
      sourceSignalId: "archive-evidence-signal",
      phase: "market-entry",
      clientOrderId,
      request: {
        environment: "vst",
        accountId,
        symbol: "USUSDT",
        operation: "entry",
        entryOrderType: "MARKET",
      },
      state: "reconciled",
      exchangeOrderId: entryOrderId,
      outcome: { status: "filled", fillPrice: "100", fillQuantity: quantity },
    },
  };
}

function fakeApi({ archive, liveMode = "normal", orderGetsFail = false } = {}) {
  const calls = [];
  let writes = 0;
  const historicalOrders = new Map(
    archive.windows.flatMap((window) => window.orders)
      .map((order) => [`${order.symbol}:${order.orderId}`, order]),
  );
  const liveCoverage = [];
  const api = {
    getVstMarkPrice: async () => ({ symbol: name, markPrice: "1", timestamp: now }),
    placeVstAutomatedLong: async () => { writes += 1; throw new Error("unexpected write"); },
    upgradeVstLongStop: async () => { writes += 1; throw new Error("unexpected write"); },
    closeLong: async () => { writes += 1; throw new Error("unexpected write"); },
    getBalance: async () => [],
    getPositions: async (symbol) => {
      calls.push(["positions", symbol]);
      return liveMode === "nonflat"
        ? [{ symbol: name, positionAmt: "0.1", positionSide: "LONG" }]
        : [{ symbol: name, positionAmt: "0", positionSide: "LONG" }];
    },
    getOpenOrders: async (symbol) => {
      calls.push(["openOrders", symbol]);
      return liveMode === "open-order" ? [{ symbol: name, orderId: "active" }] : [];
    },
    getPositionMode: async () => "HEDGE",
    getMarginType: async () => "ISOLATED",
    getLeverage: async () => ({ longLeverage: 10, shortLeverage: 10 }),
    contract: async () => ({}),
    getRiskTiers: async () => [],
    getFeeRate: async () => ({}),
    getFunding: async () => ({}),
    queryOrderHistory: async () => { throw new Error("unexpected history lookup"); },
    queryFills: async () => { throw new Error("unexpected legacy fill lookup"); },
    queryOrder: async (symbol, params) => {
      calls.push(["order", symbol, params.orderId]);
      if (orderGetsFail) throw new Error("expired exact order GET");
      const orderSymbol = symbol.endsWith("USDT")
        ? `${symbol.slice(0, -4)}-USDT` : symbol;
      return historicalOrders.get(`${orderSymbol}:${params.orderId}`);
    },
    supportsCompleteFillHistory: true,
    queryCompleteFillHistory: async (symbol, params) => {
      calls.push(["fills", symbol, params.startTs, params.endTs, params.currency]);
      if (liveMode === "saturated") {
        const coverage = {
          verified: true, endpoint: COMPLETE_FILL_HISTORY_PATH, currency: "USDT",
          startTs: params.startTs, endTs: params.endTs, rawCount: 1_000,
          pageSize: 1_000, passes: 2, terminalPage: 2,
          snapshotSha256: "a".repeat(64), observedAt: iso(now),
        };
        return { fills: [], rawFills: [], coverage };
      }
      const coverage = {
        verified: true, endpoint: COMPLETE_FILL_HISTORY_PATH, currency: "USDT",
        startTs: params.startTs, endTs: params.endTs, rawCount: 0,
        pageSize: 1_000, passes: 2, terminalPage: 2,
        snapshotSha256: fillHistoryDigest([]), observedAt: iso(now),
      };
      liveCoverage.push(coverage);
      return { fills: [], rawFills: [], coverage };
    },
    setVstLongLeverage10: async () => { writes += 1; throw new Error("unexpected write"); },
  };
  return { api, calls, liveCoverage, get writes() { return writes; } };
}

function makeBroker(api, fillArchiveStore) {
  return createVstBroker({
    api,
    accountId,
    canarySymbols: ["USUSDT"],
    clock: () => now,
    stopBufferRate: 0.01,
    ...(fillArchiveStore ? { fillArchiveStore } : {}),
  });
}

test("native archive capture preserves currency-wide raw rows, exact IDs and parent links without writes", async () => {
  const observedAt = now - DAY;
  const startTs = observedAt - 60_000;
  const endTs = observedAt - 1_000;
  const child = makeFill("71011", entryOrderId, startTs + 10_000, {
    triggerOrderId: parentOrderId,
  });
  const otherSymbol = makeFill("71012", "2104952955909177346", startTs + 20_000, {
    symbol: "BTC-USDT",
    orderId: "2104952955909177346",
  });
  const rawFills = [child, otherSymbol];
  const coverage = {
    verified: true,
    endpoint: COMPLETE_FILL_HISTORY_PATH,
    currency: "USDT",
    startTs,
    endTs,
    rawCount: rawFills.length,
    pageSize: 1_000,
    passes: 2,
    terminalPage: 2,
    snapshotSha256: fillHistoryDigest(rawFills),
    observedAt: iso(observedAt),
  };
  const capturedOrders = [
    makeOrder(entryOrderId, { triggerOrderId: parentOrderId }),
    makeOrder(parentOrderId, { status: "CANCELED" }),
    makeOrder("2104952955909177346", { symbol: "BTC-USDT", orderId: "2104952955909177346" }),
  ];
  const harness = fakeApi({ archive: { windows: [] } });
  harness.api.queryCompleteFillHistory = async (symbol, range) => {
    assert.equal(symbol, "USUSDT");
    assert.deepEqual(range, { startTs, endTs, currency: "USDT" });
    return { rawFills, coverage };
  };
  harness.api.queryOrder = async (symbol, params) => {
    harness.calls.push(["order", symbol, params.orderId]);
    const orderSymbol = symbol.endsWith("USDT")
      ? `${symbol.slice(0, -4)}-USDT` : symbol;
    return capturedOrders.find((order) => order.symbol === orderSymbol &&
      order.orderId === params.orderId);
  };
  const broker = makeBroker(harness.api);
  const saved = await broker.captureFillArchiveWindow({ startTs, endTs });
  assert.equal(Object.isFrozen(saved), true);
  assert.equal(Object.isFrozen(saved.rawFills[0]), true);
  assert.deepEqual(saved.rawFills, rawFills);
  assert.deepEqual(saved.rawFills.map((fill) => fill.symbol), ["US-USDT", "BTC-USDT"]);
  assert.equal(saved.coverage.snapshotSha256, fillHistoryDigest(rawFills));
  assert.deepEqual(saved.orders.map((order) => order.orderId), [
    entryOrderId, parentOrderId, "2104952955909177346",
  ]);
  assert.deepEqual(harness.calls.filter(([kind]) => kind === "order").map(([, , id]) => id), [
    entryOrderId, parentOrderId, "2104952955909177346",
  ]);
  assert.equal(harness.writes, 0);
});

test("archive preserves a triggered parent's exact GET returning its filled child without rewriting IDs", async () => {
  const startTs = now - 60_000, endTs = now - 1_000;
  const child = makeOrder(closeOrderId, {
    status: "FILLED", side: "SELL", type: "STOP_MARKET", triggerOrderId: parentOrderId,
    positionID: "2104157262508457985", closePosition: "false",
  });
  const fill = makeFill("399", closeOrderId, endTs - 100, {
    side: "SELL", triggerOrderId: parentOrderId,
  });
  const window = makeArchiveWindow(startTs, endTs, [fill], [child], now);
  const harness = fakeApi({ archive: { windows: [] } });
  harness.api.queryCompleteFillHistory = async () =>
    ({ rawFills: window.rawFills, coverage: window.coverage });
  harness.api.queryOrder = async (_, { orderId }) => {
    assert.ok([closeOrderId, parentOrderId].includes(orderId));
    return orderId === parentOrderId
      ? { ...structuredClone(child), positionID: 0, closePosition: "" }
      : structuredClone(child);
  };
  const captured = await makeBroker(harness.api)
    .captureFillArchiveWindow({ startTs, endTs });
  assert.equal(captured.orders.length, 1);
  assert.equal(captured.orders[0].orderId, closeOrderId);
  assert.equal(captured.parentOrderLookups[0].requestedOrderId, parentOrderId);
  assert.equal(captured.parentOrderLookups[0].response.orderId, closeOrderId);
  assert.equal(harness.writes, 0);
  assertArchiveCoverage({ archiveWindows: [captured], coverage: [captured.coverage],
    fills: captured.rawFills, accountId });
  for (const mutate of [
    (w) => { w.parentOrderLookups[0].requestedOrderId = entryOrderId; },
    (w) => { w.parentOrderLookups[0].response.triggerOrderId = entryOrderId; },
    (w) => { w.parentOrderLookups[0].response.symbol = "BTC-USDT"; },
    (w) => { w.parentOrderLookups[0].response.status = "NEW"; },
    (w) => { w.parentOrderLookups[0].response.avgPrice = "999"; },
    (w) => { w.parentOrderLookups[0].response.positionID = "999"; },
    (w) => { w.parentOrderLookups = []; },
  ]) {
    const damaged = structuredClone(captured); mutate(damaged);
    assert.throws(() => validateArchiveWindow(damaged, { accountId }));
  }
  harness.api.queryOrder = async (_, { orderId }) =>
    orderId === closeOrderId ? child : { ...child, orderId: entryOrderId };
  await assert.rejects(makeBroker(harness.api)
    .captureFillArchiveWindow({ startTs, endTs }), /order_unverified/);
});

test("ten-day-old close proof joins contiguous archived windows to a live tail and uses archived terminal orders", async () => {
  const archive = historicalArchive();
  const harness = fakeApi({ archive, orderGetsFail: true });
  const store = {
    async listFillArchiveWindows(query) {
      assert.equal(query.accountId, accountId);
      assert.equal(query.currency, "USDT");
      return archive.windows;
    },
  };
  const broker = makeBroker(harness.api, store);
  const proof = await broker.readHistoricalErrorClose(candidate());
  assert.equal(proof.verified, true);
  assert.equal(proof.entryOrderId, entryOrderId);
  assert.equal(proof.closeOrderId, closeOrderId);
  assert.equal(proof.archiveWindows.length, archive.windows.length);
  assert.deepEqual(proof.archiveWindows.map((window) => window.coverage.startTs),
    archive.windows.map((window) => window.coverage.startTs));
  assert.equal(proof.coverage.length, archive.windows.length + harness.liveCoverage.length);
  assert.equal(proof.coverage.at(-1).endTs, now);
  assert.ok(harness.calls.filter(([kind]) => kind === "fills")
    .every(([, , , , currency]) => currency === "USDT"));
  assert.ok(harness.calls.filter(([kind]) => kind === "fills").length > 0);
  assert.ok(harness.calls.filter(([kind]) => kind === "order")
    .some(([, , id]) => id === entryOrderId));
  assert.equal(harness.writes, 0);
});

test("archive helper rejects a missing historical segment and a changed currency-wide digest", () => {
  const archive = historicalArchive();
  const chain = selectArchiveChain(archive.windows, {
    accountId, startTs: archive.startTs, endTs: archive.archivedThrough,
  });
  assert.equal(chain.length, archive.windows.length);
  const gap = archive.windows.filter((_, index) => index !== 2);
  assert.ok(selectArchiveChain(gap, {
    accountId, startTs: archive.startTs, endTs: archive.archivedThrough,
  }).length < archive.windows.length);

  const altered = structuredClone(archive.windows[0]);
  altered.rawFills.push(makeFill("71099", "2104952955909178000",
    altered.coverage.startTs + 1_000, { symbol: "ETH-USDT", orderId: "2104952955909178000" }));
  assert.throws(() => selectArchiveChain([altered], {
    accountId, startTs: altered.coverage.startTs, endTs: altered.coverage.endTs,
  }), /vst_fill_archive_(window_invalid|digest_mismatch)/);
});

test("archive proofs refuse forged coverage, symbol-scoped snapshots, saturated windows and unsafe freshness", async () => {
  const archive = historicalArchive();
  const window = archive.windows.find((item) => item.rawFills.length > 0);
  assert.ok(window);
  assert.throws(() => assertArchiveCoverage({
    archiveWindows: [window],
    coverage: [{ ...window.coverage, snapshotSha256: "b".repeat(64) }],
    fills: [],
    accountId,
  }), /vst_fill_archive_coverage_mismatch/);

  const scoped = structuredClone(archive.windows.find((item) =>
    item.rawFills.some((fill) => fill.symbol !== name)));
  assert.ok(scoped);
  scoped.rawFills = scoped.rawFills.filter((fill) => fill.symbol === name);
  scoped.coverage.rawCount = scoped.rawFills.length;
  scoped.coverage.snapshotSha256 = fillHistoryDigest(scoped.rawFills);
  // A symbol-only replacement is not the original currency-wide evidence.
  assert.throws(() => assertArchiveCoverage({
    archiveWindows: [scoped],
    coverage: [window.coverage],
    fills: [],
    accountId,
  }), /vst_fill_archive_(coverage_mismatch|digest_mismatch)/);

  const saturated = structuredClone(window);
  saturated.coverage.rawCount = 1_000;
  assert.throws(() => selectArchiveChain([saturated], {
    accountId,
    startTs: saturated.coverage.startTs,
    endTs: saturated.coverage.endTs,
  }), /vst_fill_archive_window_invalid/);

  for (const liveMode of ["nonflat", "open-order"]) {
    const harness = fakeApi({ archive, liveMode });
    const broker = makeBroker(harness.api, {
      async listFillArchiveWindows() { return archive.windows; },
    });
    await assert.rejects(broker.readHistoricalErrorClose(candidate()), /symbol_not_flat/);
  }
  const saturatedLive = fakeApi({ archive, liveMode: "saturated" });
  const saturatedBroker = makeBroker(saturatedLive.api, {
    async listFillArchiveWindows() { return archive.windows; },
  });
  await assert.rejects(saturatedBroker.readHistoricalErrorClose(candidate()),
    /fill_coverage_unverified/);

  const stale = fakeApi({ archive, liveMode: "stale" });
  let staleClock = now;
  stale.api.getPositions = async () => {
    staleClock = now + 31_000;
    return [{ symbol: name, positionAmt: "0" }];
  };
  const staleBroker = createVstBroker({
    api: stale.api,
    accountId,
    canarySymbols: ["USUSDT"],
    clock: () => staleClock,
    stopBufferRate: 0.01,
    fillArchiveStore: { async listFillArchiveWindows() { return archive.windows; } },
  });
  await assert.rejects(staleBroker.readHistoricalErrorClose(candidate()),
    /flat_read_stale_or_unverified/);
});

test("archive capture refuses symbol-filtered data and historical reads stop at archive gaps", async () => {
  const archive = historicalArchive();
  const missingRaw = fakeApi({ archive });
  missingRaw.api.queryCompleteFillHistory = async () => ({
    fills: [], coverage: archive.windows[0].coverage,
  });
  await assert.rejects(makeBroker(missingRaw.api)
    .captureFillArchiveWindow(archive.windows[0].coverage), /raw_snapshot_missing/);

  const hole = archive.windows.filter((_, index) => index !== 2);
  const harness = fakeApi({ archive: { ...archive, windows: hole }, orderGetsFail: true });
  const broker = makeBroker(harness.api, {
    async listFillArchiveWindows() { return hole; },
  });
  await assert.rejects(broker.readHistoricalErrorClose(candidate()),
    /archive_gap_or_history_too_old/);
  assert.equal(harness.writes, 0);
});