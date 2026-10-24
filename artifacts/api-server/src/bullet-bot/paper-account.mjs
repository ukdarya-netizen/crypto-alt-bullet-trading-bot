export const PAPER_INITIAL_DEPOSIT_USDT = 1000;

// Increasing the owner's virtual starting capital must not erase PnL,
// reserved margin or positions. Credit only the difference, once, under
// PostgreSQL's account-row lock (also shared by entry/exit accounting).
export const ENSURE_PAPER_ACCOUNT_SQL = `
  INSERT INTO btb_paper_account
    (singleton, initial_usdt, free_usdt, reserved_usdt, realized_pnl_usdt)
  VALUES (true, $1, $1, 0, 0)
  ON CONFLICT (singleton) DO UPDATE SET
    free_usdt = btb_paper_account.free_usdt
      + EXCLUDED.initial_usdt - btb_paper_account.initial_usdt,
    initial_usdt = EXCLUDED.initial_usdt
  WHERE btb_paper_account.initial_usdt < EXCLUDED.initial_usdt
`;

export async function ensurePaperAccount(pool) {
  await pool.query(ENSURE_PAPER_ACCOUNT_SQL, [PAPER_INITIAL_DEPOSIT_USDT]);
}