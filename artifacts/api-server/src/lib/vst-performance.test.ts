import assert from "node:assert/strict";
import { test } from "node:test";
import { vstPerformanceRow } from "./vst-performance";

const base = { source_signal_id: "s1", symbol: "WOOUSDT", pattern_id: "impulse_buy",
  updated_at: "2026-10-24T19:00:00.000Z" };

test("bot close: (close - entry) x qty minus the close fee, ROE on 10x margin", () => {
  const row = vstPerformanceRow({ ...base, snapshot: {
    verifiedFill: { price: "0.01", at: "2026-10-24T10:00:00.000Z" },
    closeFill: { price: "0.0105", quantity: "1000", at: "2026-10-24T12:00:00.000Z", fee: { amount: "0.005", asset: "USDT" } },
    closedAt: "2026-10-24T12:00:00.000Z", closeReason: "fixed_price_take_profit_5pct",
  } });
  assert.equal(row.pnlUsdt, 0.495);
  assert.equal(row.marginUsdt, 1);
  assert.equal(row.roePercent, 49.5);
  assert.equal(row.closeReason, "fixed_price_take_profit_5pct");
  assert.equal(row.accounting, "exchange_fills");
  assert.equal(row.entryAt, "2026-10-24T10:00:00.000Z");
  assert.equal(row.patternId, "impulse_buy");
});

test("exchange-history repair uses BingX realised PnL after both USDT fees", () => {
  const row = vstPerformanceRow({ ...base, snapshot: { exchangeHistoryProvenance: {
    verified: true, environment: "vst",
    entryFill: { price: "2", at: "2026-10-24T10:00:00.000Z", fee: { amount: "-0.01", asset: "USDT" } },
    closeFill: { price: "1.9", quantity: "10", at: "2026-10-24T11:00:00.000Z",
      fee: { amount: "-0.01", asset: "USDT" }, realisedPnl: "-1",
      realisedPnlProvenance: "bingx_fill_history.realisedPNL", realisedPnlAsset: "USDT" },
  } } });
  assert.equal(row.pnlUsdt, -1.02);
  assert.equal(row.accounting, "exchange_history");
  assert.equal(row.closedAt, "2026-10-24T11:00:00.000Z");
});

test("missing fills never produce a fabricated result", () => {
  const row = vstPerformanceRow({ ...base, snapshot: { manualResolution: { outcome: "closed" } } });
  assert.equal(row.pnlUsdt, null);
  assert.equal(row.roePercent, null);
  assert.equal(row.manual, true);
  assert.equal(row.closeReason, "manual_owner_resolution");
  assert.equal(row.closedAt, "2026-10-24T19:00:00.000Z");
  const history = vstPerformanceRow({ ...base, snapshot: { exchangeHistoryProvenance: {
    verified: true, environment: "vst", entryFill: { fee: { amount: "-1", asset: "VST" } },
    closeFill: { fee: { amount: "-1", asset: "VST" }, realisedPnl: "3",
      realisedPnlProvenance: "bingx_fill_history.realisedPNL", realisedPnlAsset: "USDT" } } } });
  assert.equal(history.pnlUsdt, null, "VST-denominated fees are not converted");
});
