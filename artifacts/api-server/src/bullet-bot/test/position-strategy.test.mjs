import test from "node:test";
import assert from "node:assert/strict";
import { capturePositionStrategy, pinPositionStrategy, positionStrategy } from "../position-strategy.mjs";

const scalp = { exitStrategy: "full_take_5pct", strategyAuthority: "source" };
const classic = { exitStrategy: "source", strategyAuthority: "policy" };

test("a position retains its entry rules after a change of executor defaults", () => {
  const position = pinPositionStrategy({ sourceSignalId: "first", remainingQty: 2 }, scalp);
  assert.deepEqual(positionStrategy(position, classic), { version: 1, ...scalp });
  assert.deepEqual(pinPositionStrategy(position, classic), position);
  const next = pinPositionStrategy({ sourceSignalId: "next" }, classic);
  assert.deepEqual(positionStrategy(next, scalp), { version: 1, ...classic });
});

test("strategy binding survives JSON persistence and a worker restart", () => {
  const saved = JSON.parse(JSON.stringify(pinPositionStrategy({ remainingQty: 2 }, classic)));
  assert.deepEqual(positionStrategy(saved, scalp), { version: 1, ...classic });
  assert.equal(saved.remainingQty, 2);
});

test("caller mutation cannot change captured settings", () => {
  const options = { ...scalp };
  const saved = capturePositionStrategy(options);
  options.exitStrategy = "source";
  assert.equal(saved.exitStrategy, "full_take_5pct");
  assert.throws(() => { saved.exitStrategy = "source"; }, TypeError);
});

test("unknown persisted versions are refused instead of replaced by current defaults", () => {
  assert.throws(() => positionStrategy({ executionStrategy: { ...scalp, version: 2 } }, scalp),
    /Unsupported position strategy version/);
  assert.throws(() => positionStrategy({ executionStrategy: { ...scalp, version: 1,
    exitStrategy: "made_up" } }, scalp), /Invalid exit strategy/);
});
