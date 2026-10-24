import { fillHistoryDigest, COMPLETE_FILL_HISTORY_PATH } from "./bingx-fill-history.mjs";

export const FILL_ARCHIVE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const FILL_ARCHIVE_WINDOW_MS = 23 * 60 * 60 * 1000;

function fail(reason) {
  throw new Error(`vst_fill_archive_${reason}`);
}

export function archiveExactId(value) {
  if (typeof value === "string" && /^\d+$/.test(value) && !/^0+$/.test(value)) return value;
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  fail("identifier_invalid");
}

export function archiveOrderId(row) {
  const ids = [row?.orderId, row?.orderID].filter((v) => v != null).map(archiveExactId);
  if (!ids.length || new Set(ids).size !== 1) fail("order_id_invalid");
  return ids[0];
}

export function archiveParentIds(row) {
  return [row?.triggerOrderId, row?.triggerOrderID]
    .filter((v) => v != null && v !== "" && v !== 0 && v !== "0")
    .map(archiveExactId);
}

export function archiveCanonical(value) {
  if (Array.isArray(value)) return value.map(archiveCanonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, archiveCanonical(value[key])]),
  );
  return value;
}

/** Exact parent-ID GETs may return the filled child. Preserve that raw
 * response, not a fabricated order with its ID replaced by the parent ID. */
export function archiveParentLookupMatches(lookup, symbol, parentId) {
  try {
    const response = lookup?.response;
    return lookup?.symbol === symbol &&
      archiveExactId(lookup.requestedOrderId) === parentId &&
      response?.symbol === symbol &&
      archiveOrderId(response) !== parentId &&
      String(response.status).toUpperCase() === "FILLED" &&
      archiveParentIds(response).length > 0 &&
      archiveParentIds(response).every((id) => id === parentId);
  } catch {
    return false;
  }
}

export function archiveParentLookupMatchesChild(lookup, child) {
  if (!archiveParentLookupMatches(lookup, child?.symbol, lookup?.requestedOrderId)) {
    return false;
  }
  const response = structuredClone(lookup.response);
  const saved = structuredClone(child);
  // Native parent-ID lookups omit the child position association (0) and
  // report closePosition:"" instead of "false". Neither is position proof.
  // Keep every other raw field and reject conflicting nonzero identities.
  for (const key of ["positionID", "positionId"]) {
    if ([0, "0", "", null, undefined].includes(response[key])) {
      delete response[key];
      delete saved[key];
    }
  }
  if (response.closePosition === "" &&
      [false, "false"].includes(saved.closePosition)) {
    delete response.closePosition;
    delete saved.closePosition;
  }
  return JSON.stringify(archiveCanonical(response)) ===
    JSON.stringify(archiveCanonical(saved));
}

export function freezeArchiveWindow(window) {
  const copy = structuredClone(window);
  function freeze(value) {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  }
  freeze(copy);
  return copy;
}

/** Validate at capture time, not at today's clock. Never upgrade legacy rows
 * or a symbol-filtered snapshot to currency-wide completeness. */
export function validateArchiveWindow(window, { accountId, currency = "USDT" } = {}) {
  const c = window?.coverage;
  const observed = Date.parse(c?.observedAt);
  const archived = Date.parse(window?.archivedAt);
  if (window?.environment !== "vst" ||
      typeof accountId !== "string" || !accountId ||
      window.accountId !== accountId || window.currency !== currency ||
      currency !== "USDT" || c?.currency !== currency ||
      c?.verified !== true || c.endpoint !== COMPLETE_FILL_HISTORY_PATH ||
      !Number.isSafeInteger(c.startTs) || c.startTs <= 0 ||
      !Number.isSafeInteger(c.endTs) || c.endTs <= c.startTs ||
      c.endTs - c.startTs > FILL_ARCHIVE_WINDOW_MS ||
      !Number.isSafeInteger(observed) || c.endTs > observed ||
      c.startTs < observed - FILL_ARCHIVE_RETENTION_MS ||
      !Number.isSafeInteger(archived) || archived < observed ||
      c.startTs < archived - FILL_ARCHIVE_RETENTION_MS ||
      c.pageSize !== 1000 || c.passes !== 2 || c.terminalPage !== 2 ||
      !Number.isSafeInteger(c.rawCount) || c.rawCount < 0 || c.rawCount >= 1000 ||
      !Array.isArray(window.rawFills) || window.rawFills.length !== c.rawCount ||
      !Array.isArray(window.orders)) fail("window_invalid");
  const identities = new Set();
  const orders = new Map();
  for (const order of window.orders) {
    const key = `${order?.symbol}:${archiveOrderId(order)}`;
    if (typeof order?.symbol !== "string" ||
        !/^[A-Z0-9]+-USDT$/.test(order.symbol) || orders.has(key)) fail("order_invalid");
    orders.set(key, order);
  }
  const parentLookups = new Map();
  if (window.parentOrderLookups !== undefined &&
      !Array.isArray(window.parentOrderLookups)) fail("parent_lookup_invalid");
  for (const lookup of window.parentOrderLookups ?? []) {
    const parentId = archiveExactId(lookup?.requestedOrderId);
    const key = `${lookup?.symbol}:${parentId}`;
    if (!archiveParentLookupMatches(lookup, lookup?.symbol, parentId) ||
        parentLookups.has(key)) fail("parent_lookup_invalid");
    const savedChild = orders.get(`${lookup.symbol}:${archiveOrderId(lookup.response)}`);
    if (!savedChild || !archiveParentLookupMatchesChild(lookup, savedChild)) {
      fail("parent_lookup_conflict");
    }
    parentLookups.set(key, lookup);
  }
  for (const fill of window.rawFills) {
    const tradeId = archiveExactId(fill?.tradeId);
    const key = `${fill?.symbol}:${tradeId}`;
    const time = typeof fill?.filledTime === "string" ? Date.parse(fill.filledTime) : NaN;
    if (!/^[A-Z0-9]+-USDT$/.test(fill?.symbol ?? "") || identities.has(key) ||
        !Number.isSafeInteger(time) || time <= c.startTs || time > c.endTs) fail("fill_invalid");
    identities.add(key);
    const order = orders.get(`${fill.symbol}:${archiveOrderId(fill)}`);
    if (!order) fail("exact_order_missing");
    const parents = [...archiveParentIds(fill), ...archiveParentIds(order)];
    if (new Set(parents).size > 1) fail("parent_conflict");
    for (const parent of parents) {
      const lookup = parentLookups.get(`${fill.symbol}:${parent}`);
      if (lookup && archiveOrderId(lookup.response) !== archiveOrderId(fill)) {
        fail("parent_lookup_conflict");
      }
      if (!orders.has(`${fill.symbol}:${parent}`) && !lookup) fail("parent_missing");
    }
  }
  if (fillHistoryDigest(window.rawFills) !== c.snapshotSha256) fail("digest_mismatch");
  return window;
}

/** Pick a complete contiguous chain without clipping raw windows or claiming a
 * gap is covered. Overlapping/repeated observations do not add coverage. */
export function selectArchiveChain(windows, { accountId, startTs, endTs }) {
  const validated = windows.map((window) => validateArchiveWindow(window, { accountId }));
  const chain = [];
  let cursor = startTs;
  while (cursor < endTs) {
    const candidates = validated.filter((w) => chain.length
      ? w.coverage.startTs === cursor
      : w.coverage.startTs <= cursor && w.coverage.endTs > cursor);
    candidates.sort((a, b) => b.coverage.endTs - a.coverage.endTs ||
      Date.parse(b.coverage.observedAt) - Date.parse(a.coverage.observedAt));
    const next = candidates[0];
    if (!next || next.coverage.endTs > endTs) break;
    chain.push(next);
    cursor = next.coverage.endTs;
  }
  return chain;
}

/** Historical coverage is accepted only with original raw rows and exact
 * stored windows. Fresh flat/no-orders is deliberately outside this helper. */
export function assertArchiveCoverage({ archiveWindows, coverage, fills, accountId }) {
  if (!Array.isArray(archiveWindows) || !archiveWindows.length) fail("proof_missing");
  const seen = new Map();
  for (const window of archiveWindows) {
    validateArchiveWindow(window, { accountId });
    const matches = coverage.filter((c) =>
      JSON.stringify(archiveCanonical(c)) === JSON.stringify(archiveCanonical(window.coverage)));
    if (matches.length !== 1) fail("coverage_mismatch");
    for (const fill of window.rawFills) {
      const key = `${fill.symbol}:${archiveExactId(fill.tradeId)}`;
      const encoded = JSON.stringify(archiveCanonical(fill));
      if (seen.has(key) && seen.get(key) !== encoded) fail("fill_conflict");
      seen.set(key, encoded);
    }
  }
  for (const fill of fills) {
    const time = Date.parse(fill.filledTime);
    if (!archiveWindows.some((w) => time > w.coverage.startTs && time <= w.coverage.endTs)) continue;
    const key = `${fill.symbol}:${archiveExactId(fill.tradeId)}`;
    if (seen.get(key) !== JSON.stringify(archiveCanonical(fill))) fail("fill_mismatch");
  }
  // A caller cannot drop another fill of the same symbol from a certified window.
  const symbols = new Set(fills.map((f) => f.symbol));
  const supplied = new Set(fills.map((f) => `${f.symbol}:${archiveExactId(f.tradeId)}`));
  for (const window of archiveWindows) for (const fill of window.rawFills) {
    if (symbols.has(fill.symbol) && !supplied.has(`${fill.symbol}:${archiveExactId(fill.tradeId)}`)) {
      fail("fill_omitted");
    }
  }
}