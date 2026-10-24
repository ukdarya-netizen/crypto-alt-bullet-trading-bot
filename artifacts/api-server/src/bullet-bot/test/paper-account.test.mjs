import test from "node:test";
import assert from "node:assert/strict";
import {
  ensurePaperAccount, ENSURE_PAPER_ACCOUNT_SQL, PAPER_INITIAL_DEPOSIT_USDT,
} from "../paper-account.mjs";

test("PAPER initialization uses the owner's 1000 USDT deposit in one atomic query", async () => {
  const calls = [];
  await ensurePaperAccount({ query: async (...args) => { calls.push(args); } });
  assert.equal(PAPER_INITIAL_DEPOSIT_USDT, 1000);
  assert.deepEqual(calls, [[ENSURE_PAPER_ACCOUNT_SQL, [1000]]]);
});

test("existing PAPER capital is increased only by the difference without resetting PnL or reservations", () => {
  const update = ENSURE_PAPER_ACCOUNT_SQL.split("DO UPDATE SET")[1];
  assert.match(update, /free_usdt\s*=\s*btb_paper_account.free_usdt\s*\+\s*EXCLUDED.initial_usdt\s*-\s*btb_paper_account.initial_usdt/);
  assert.match(update, /WHERE btb_paper_account.initial_usdt < EXCLUDED.initial_usdt/);
  assert.doesNotMatch(update, /reserved_usdt\s*=|realized_pnl_usdt\s*=/);
});