import assert from "node:assert/strict";
import test from "node:test";
import { sortPositionsNewestFirst } from "./position-order.ts";

const sort = (positions) =>
  sortPositionsNewestFirst(positions, (position) => position.openedAt, (position) => position.id);

test("open positions remain newest first regardless of response order", () => {
  const positions = [
    { id: "old", openedAt: "2026-09-23T12:00:00.000Z" },
    { id: "new", openedAt: "2026-09-26T12:00:00.000Z" },
    { id: "middle", openedAt: "2026-09-25T12:00:00.000Z" },
  ];
  const expected = ["new", "middle", "old"];
  assert.deepEqual(sort(positions).map((position) => position.id), expected);
  assert.deepEqual(sort(positions.toReversed()).map((position) => position.id), expected);
  assert.deepEqual(positions.map((position) => position.id), ["old", "new", "middle"]);
});

test("equal and unknown opening times have stable ordering without inventing dates", () => {
  const positions = [
    { id: "missing-b", openedAt: null },
    { id: "tie-z", openedAt: "2026-09-26T12:00:00.000Z" },
    { id: "invalid", openedAt: "not a date" },
    { id: "tie-a", openedAt: "2026-09-26T12:00:00.000Z" },
  ];
  const expected = ["tie-a", "tie-z", "invalid", "missing-b"];
  assert.deepEqual(sort(positions).map((position) => position.id), expected);
  assert.deepEqual(sort(positions.toReversed()).map((position) => position.id), expected);
});