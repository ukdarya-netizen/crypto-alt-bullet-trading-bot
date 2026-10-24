import assert from "node:assert/strict";
import { test } from "node:test";
import { closeReasonGroup, dailySeries, formatUsdt, inPeriod, summarize, type ResultTrade } from "./performance";

const t = (id: string, closedAt: string, pnlUsdt: number | null, roePercent: number | null = null): ResultTrade =>
  ({ id, symbol: "WOOUSDT", patternId: "impulse_buy", closedAt, pnlUsdt, roePercent });

test("summary never counts an unproven result as zero", () => {
  const s = summarize([
    t("a", "2026-10-20T10:00:00Z", 5, 50), t("b", "2026-10-21T10:00:00Z", -2, -20),
    t("c", "2026-10-22T10:00:00Z", null), t("d", "2026-10-22T11:00:00Z", 0),
  ]);
  assert.equal(s.trades, 4);
  assert.equal(s.counted, 3);
  assert.equal(s.unknown, 1);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 1);
  assert.equal(s.breakeven, 1);
  assert.equal(s.netUsdt, 3);
  assert.equal(s.winRate, 50);
  assert.equal(s.profitFactor, 2.5);
  assert.equal(s.avgRoePercent, 15);
  assert.equal(s.best?.id, "a");
  assert.equal(s.worst?.id, "b");
  assert.equal(s.maxDrawdownUsdt, 2);
});

test("only-winning and empty sets have honest factors", () => {
  assert.equal(summarize([t("a", "2026-10-20T10:00:00Z", 1)]).profitFactor, Infinity);
  const empty = summarize([]);
  assert.equal(empty.profitFactor, null);
  assert.equal(empty.winRate, null);
  assert.equal(empty.avgUsdt, null);
});

test("daily series fills quiet days and accumulates in Samara time", () => {
  const points = dailySeries([
    t("a", "2026-10-20T21:30:00Z", 2), // 01:30 on the 21st in Samara (UTC+4)
    t("b", "2026-10-23T10:00:00Z", -1), t("c", "2026-10-23T11:00:00Z", null),
  ]);
  assert.deepEqual(points.map((p) => [p.day, p.pnl, p.cumulative, p.trades]), [
    ["2026-10-21", 2, 2, 1], ["2026-10-22", 0, 2, 0], ["2026-10-23", -1, 1, 1],
  ]);
});

test("period filter, reason groups and formatting", () => {
  const now = Date.parse("2026-10-24T00:00:00Z");
  const rows = [t("old", "2026-09-01T00:00:00Z", 1), t("new", "2026-10-20T00:00:00Z", 1)];
  assert.deepEqual(inPeriod(rows, "7d", now).map((r) => r.id), ["new"]);
  assert.equal(inPeriod(rows, "all", now).length, 2);
  assert.equal(closeReasonGroup("fixed_price_take_profit_5pct").label, "Тейк +5%");
  assert.equal(closeReasonGroup("protective_stop").id, "stop");
  assert.equal(closeReasonGroup("source_closed").id, "source");
  assert.equal(formatUsdt(1.234), "+1,23");
  assert.equal(formatUsdt(-0.0012), "-0,0012");
  assert.equal(formatUsdt(null), "—");
});
