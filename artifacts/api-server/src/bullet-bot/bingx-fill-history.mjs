import { createHash } from "node:crypto";

export const COMPLETE_FILL_HISTORY_PATH = "/openApi/swap/v2/trade/fillHistory";
const MAX_ROWS = 1000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function fail(reason) {
  throw new Error(`bingx_complete_fill_history_${reason}`);
}

function id(value) {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  fail("identifier_invalid");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function fillHistoryDigest(rows) {
  return createHash("sha256").update(JSON.stringify(canonical(
    [...rows].sort((a, b) => `${a.symbol}:${id(a.tradeId)}`.localeCompare(
      `${b.symbol}:${id(b.tradeId)}`,
    )),
  ))).digest("hex");
}

/**
 * The documented recent-history endpoint has a hard 1000-record ceiling.
 * Never try to paginate past that ceiling or borrow allFillOrders semantics.
 * Collect the entire currency-wide first page at maximum page size, require a
 * terminal page, then repeat the identical fixed window. No local filtering
 * happens until both raw snapshots have passed these checks.
 *
 * Official contract (checked 2026-10-01):
 * https://bingx-api.github.io/docs-v3/#/en/Swap/Trades%20Endpoints/Query%20historical%20transaction%20details
 * Supports pageIndex > 0, pageSize <= 1000, tradeId and total records;
 * interval startTs < fills <= endTs, within the past seven days.
 * VST currently returns reverse time order and page-local total on an empty
 * page. Do not rely on the documented ascending sort or combine a cursor with
 * pageIndex. Saturated, changed, malformed or nonterminal snapshots are not
 * proofs, even if only two of their rows match the requested symbol.
 */
export async function collectCompleteFillHistory({
  readPage, clock = Date.now, startTs, endTs, currency,
}) {
  const start = Number(startTs);
  const end = Number(endTs);
  const startedAt = Number(clock());
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start <= 0 || end < start || !Number.isSafeInteger(startedAt) ||
      end > startedAt || start < startedAt - RETENTION_MS) {
    fail("window_outside_retention");
  }
  if (!["USDT", "USDC"].includes(currency)) fail("currency_invalid");
  const params = { startTs: start, endTs: end, currency, pageSize: MAX_ROWS };
  const snapshots = [];
  for (let pass = 0; pass < 2; pass += 1) {
    if (start < Number(clock()) - RETENTION_MS) fail("window_outside_retention");
    const first = await readPage({ ...params, pageIndex: 1 });
    const rows = first?.fill_history_orders;
    if (!Array.isArray(rows) || !Number.isSafeInteger(first?.total) || first.total < 0) {
      fail("page_invalid");
    }
    // Inspect the unfiltered raw response, including other account symbols.
    if (rows.length >= MAX_ROWS || first.total >= MAX_ROWS) fail("saturated");
    if (first.total !== rows.length) fail("count_mismatch");
    const identities = new Set();
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row) ||
          typeof row.symbol !== "string" || !/^[A-Z0-9]+-(USDT|USDC)$/.test(row.symbol)) {
        fail("row_invalid");
      }
      const tradeId = id(row.tradeId);
      const orderId = id(row.orderId ?? row.orderID);
      if (row.orderID != null && id(row.orderID) !== orderId) fail("identifier_mismatch");
      const identity = `${row.symbol}:${tradeId}`;
      if (identities.has(identity)) fail("duplicate_fill");
      identities.add(identity);
      const time = typeof row.filledTime === "string" ? Date.parse(row.filledTime) : NaN;
      if (!Number.isSafeInteger(time) || time <= start || time > end) {
        fail("row_outside_window");
      }
    }
    const terminal = await readPage({ ...params, pageIndex: 2 });
    if (!Array.isArray(terminal?.fill_history_orders) ||
        terminal.fill_history_orders.length !== 0 ||
        !Number.isSafeInteger(terminal?.total) ||
        ![0, first.total].includes(terminal.total)) {
      fail("terminal_page_unverified");
    }
    snapshots.push({ rows, hash: fillHistoryDigest(rows), total: first.total });
  }
  if (snapshots[0].total !== snapshots[1].total ||
      snapshots[0].hash !== snapshots[1].hash) fail("snapshot_changed");
  if (start < Number(clock()) - RETENTION_MS) fail("window_outside_retention");
  return {
    fills: snapshots[1].rows,
    coverage: {
      verified: true,
      endpoint: COMPLETE_FILL_HISTORY_PATH,
      startTs: start,
      endTs: end,
      currency,
      rawCount: snapshots[1].total,
      pageSize: MAX_ROWS,
      passes: 2,
      terminalPage: 2,
      snapshotSha256: snapshots[1].hash,
      observedAt: new Date(Number(clock())).toISOString(),
    },
  };
}