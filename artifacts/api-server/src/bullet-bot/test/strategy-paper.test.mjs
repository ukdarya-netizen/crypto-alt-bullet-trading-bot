import test from "node:test";
import assert from "node:assert/strict";
import { depositPct, paperTradePct, summarizeStrategyPaper } from "../strategy-paper.mjs";

const row = (o) => ({ symbol: "ABCUSDT", pattern_id: "liquidation_cascade", entry_price: "100",
  source_status: "profit", closed_at: new Date("2026-10-29T00:00:00Z"),
  first_seen_at: new Date("2026-10-28T00:00:00Z"), ...o });

test("take N is taken when CAB's peak reached it, else CAB's exit applies", () => {
  const r = row({ peak_price: "109", exit_price: "103" });
  assert.equal(paperTradePct(r, "follow_cab").toFixed(2), "2.90");
  assert.equal(paperTradePct(r, "take5").toFixed(2), "4.90");
  assert.equal(paperTradePct(r, "take8").toFixed(2), "7.90");
  assert.equal(paperTradePct(r, "take10").toFixed(2), "2.90");
  const stopped = row({ peak_price: "101", exit_price: "90", source_status: "stop_loss" });
  assert.equal(paperTradePct(stopped, "take5").toFixed(2), "-10.10");
});

test("BTC follows CAB under every take", () => {
  const r = row({ symbol: "BTCUSDT", peak_price: "112", exit_price: "101" });
  for (const e of ["follow_cab", "take5", "take8", "take10"]) assert.equal(paperTradePct(r, e).toFixed(2), "0.90");
});

test("summary: deposit % = price % x 10x x 1 %, open trades counted, pattern selection summed", () => {
  const rows = [
    row({ peak_price: "106", exit_price: "100" }),
    row({ pattern_id: "impulse_buy", peak_price: "120", exit_price: "115" }),
    row({ source_status: "active", closed_at: null, exit_price: null }),
  ];
  const s = summarizeStrategyPaper(rows, { patterns: ["impulse_buy"] });
  assert.equal(s.openTrades, 1);
  assert.equal(s.exits.take5.trades, 2);
  assert.equal(s.exits.take5.depositPct, Math.round((depositPct(4.9) * 2) * 100) / 100);
  assert.equal(s.selection.follow_cab.trades, 1);
  assert.equal(s.selection.follow_cab.depositPct, Math.round(depositPct(14.9) * 100) / 100);
  assert.equal(s.byPattern.liquidation_cascade.follow_cab.avgTradePct, -0.1);
});

test("only the 4 traded patterns count; others are reported; period by signal time", () => {
  const rows = [
    row({ peak_price: "100", exit_price: "102", signal_at: "2026-10-20T00:00:00Z" }),
    row({ pattern_id: "price_led_momentum", peak_price: "100", exit_price: "90", signal_at: "2026-10-21T00:00:00Z" }),
    row({ peak_price: "100", exit_price: "101", signal_at: "2026-09-01T00:00:00Z" }),
  ];
  const all = summarizeStrategyPaper(rows, { now: Date.parse("2026-10-28T00:00:00Z") });
  assert.equal(all.exits.follow_cab.trades, 2);
  assert.equal(all.otherPatternsExcluded, 1);
  assert.equal(all.signalsFrom, "2026-09-01T00:00:00.000Z");
  const week = summarizeStrategyPaper(rows, { days: 30, now: Date.parse("2026-10-28T00:00:00Z") });
  assert.equal(week.exits.follow_cab.trades, 1);
});
