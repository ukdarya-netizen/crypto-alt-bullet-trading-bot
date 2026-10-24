import assert from "node:assert/strict";
import test from "node:test";
import { collectCompleteFillHistory, COMPLETE_FILL_HISTORY_PATH } from "../bingx-fill-history.mjs";
import { createBingXLiveApi } from "../bingx-live-api.mjs";

const now = 1790850000000;
const startTs = now - 3600000;
const endTs = now - 10000;
const row = (tradeId = "1", symbol = "US-USDT") => ({
  tradeId, symbol, orderId: "2104952955909177345", qty: "1",
  price: "100", commission: "-0.05", commissionAsset: "VST",
  filledTime: new Date(startTs + 1000).toISOString(),
});
const page = (rows, total = rows.length) => ({ fill_history_orders: rows, total });
const options = { startTs, endTs, currency: "USDT", clock: () => now };

function run(pages, extra = {}) {
  const calls = [];
  return {
    calls,
    promise: collectCompleteFillHistory({
      ...options, ...extra,
      readPage: async (params) => {
        calls.push(params);
        return pages[calls.length - 1];
      },
    }),
  };
}

test("collects both raw snapshots and terminal pages before symbol selection", async () => {
  const rows = [row("2", "ONDO-USDT"), row()];
  const { promise, calls } = run([page(rows), page([]), page([...rows].reverse()), page([], 2)]);
  const result = await promise;
  assert.equal(result.fills.length, 2);
  assert.equal(result.coverage.rawCount, 2);
  assert.equal(result.coverage.passes, 2);
  assert.equal(result.coverage.terminalPage, 2);
  assert.match(result.coverage.snapshotSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(calls.map((p) => p.pageIndex), [1, 2, 1, 2]);
  assert.ok(calls.every((p) => p.pageSize === 1000 && p.startTs === startTs &&
    p.endTs === endTs && p.currency === "USDT" && !Object.hasOwn(p, "symbol") &&
    !Object.hasOwn(p, "lastFillId") && !Object.hasOwn(p, "orderId")));
});

test("rejects raw saturation even if all but two fills belong to other symbols", async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => row(String(i + 1),
    i < 2 ? "US-USDT" : "BTC-USDT"));
  const { promise, calls } = run([page(rows)]);
  await assert.rejects(promise, /saturated/);
  assert.equal(calls.length, 1);
  await assert.rejects(run([page([row()], 1000)]).promise, /saturated/);
});

test("rejects missing counts, partial totals and a nonterminal next page", async () => {
  for (const first of [{ fill_history_orders: [row()] }, page([row()], 2),
    page([row()], -1), page([row()], "1")]) {
    await assert.rejects(run([first]).promise, /page_invalid|count_mismatch/);
  }
  for (const terminal of [page([row("2")]), {}, page([], 3)]) {
    await assert.rejects(run([page([row()]), terminal]).promise, /terminal_page_unverified/);
  }
});

test("terminal page alone and a changed second snapshot cannot prove completeness", async () => {
  await assert.rejects(run([page([]), page([row()])]).promise, /terminal_page_unverified/);
  await assert.rejects(run([
    page([row()]), page([]), page([{ ...row(), commission: "-0.04" }]), page([]),
  ]).promise, /snapshot_changed/);
  await assert.rejects(run([
    page([row()]), page([]), page([row(), row("2")]), page([]),
  ]).promise, /snapshot_changed/);
});

test("rejects duplicate fills, rounded IDs and rows outside the fixed interval", async () => {
  for (const rows of [[row(), row()], [{ ...row(), orderId: 2104952955909177345 }],
    [{ ...row(), tradeId: 99999999999999999 }],
    [{ ...row(), filledTime: new Date(startTs).toISOString() }],
    [{ ...row(), filledTime: new Date(endTs + 1).toISOString() }],
    [{ ...row(), filledTime: "bad" }]]) {
    await assert.rejects(run([page(rows)]).promise, /duplicate_fill|identifier_invalid|row_outside_window/);
  }
});

test("fails closed outside seven-day retention, even when reads cross its boundary", async () => {
  await assert.rejects(run([], { startTs: now - 7 * 86400000 - 1 }).promise,
    /window_outside_retention/);
  await assert.rejects(run([], { endTs: now + 1 }).promise, /window_outside_retention/);
  await assert.rejects(run([], { currency: "VST" }).promise, /currency_invalid/);
  let ticks = 0;
  await assert.rejects(run([page([]), page([])], {
    startTs: now - 7 * 86400000,
    clock: () => now + (ticks++ < 2 ? 0 : 1),
  }).promise, /window_outside_retention/);
});

test("signed VST API uses documented fillHistory only and filters after raw proof", async () => {
  const calls = [];
  const rows = [row(), row("2", "ONDO-USDT")];
  const api = createBingXLiveApi({
    environment: "vst", clock: () => now,
    credentials: () => ({ key: "fixture-key", secret: "fixture-secret" }),
    requestPacer: { waitForSlot: async () => {}, deferFor() {} },
    fetchImpl: async (url, init) => {
      calls.push(new URL(url));
      assert.equal(init.method, "GET");
      assert.equal(new URL(url).pathname, COMPLETE_FILL_HISTORY_PATH);
      assert.equal(new URL(url).searchParams.has("symbol"), false);
      return { ok: true, status: 200, text: async () => JSON.stringify({
        code: 0, data: page(new URL(url).searchParams.get("pageIndex") === "1" ? rows : []),
      }) };
    },
  });
  const result = await api.queryCompleteFillHistory("USUSDT", { startTs, endTs, currency: "USDT" });
  assert.deepEqual(result.fills, [row()]);
  assert.equal(result.coverage.rawCount, 2);
  assert.equal(calls.length, 4);
  await assert.rejects(api.queryFills("USUSDT", {
    startTs, endTs, currency: "USDT", requireComplete: true, orderId: "123",
  }), /cannot be order-filtered/);
  const mainnet = createBingXLiveApi({ environment: "mainnet" });
  assert.equal(mainnet.supportsCompleteFillHistory, false);
  await assert.rejects(mainnet.queryCompleteFillHistory("USUSDT", {
    startTs, endTs, currency: "USDT",
  }), /only verified for VST/);
});