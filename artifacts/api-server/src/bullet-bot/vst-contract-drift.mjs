import { createHash } from "node:crypto";

// Observability, NOT exchange evidence. Only fixed keys/types and predicates
// leave this module. Unknown provider key names and all values are discarded.
const ENDPOINTS = new Map([
  ["/openApi/swap/v2/user/positions", "positions"],
  ["/openApi/swap/v2/trade/order", "stop_lookup"],
  ["/openApi/swap/v2/trade/openOrders", "open_stops"],
  ["/openApi/swap/v2/trade/allFillOrders", "fills"],
  ["/openApi/swap/v2/trade/fillHistory", "fill_history"],
  ["/openApi/swap/v1/positionMargin/history", "margin_history"],
]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const type = value => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
const scalar = value => typeof value === "string" || typeof value === "number";
const stringFields = new Set(["symbol", "positionSide", "side", "type",
  "workingType", "status", "changeReason"]);
const identifierFields = new Set(["orderId", "orderID", "positionId", "positionID", "tradeId"]);
const groups = {
  positions: [["symbol"], ["positionId", "positionID"], ["positionSide"],
    ["positionAmt"], ["avgPrice", "entryPrice"], ["initialMargin"]],
  stop_lookup: [["symbol"], ["orderId", "orderID"], ["positionSide"], ["side"], ["type"], ["status"]],
  open_stops: [["symbol"], ["orderId", "orderID"], ["positionSide"], ["side"], ["type"], ["status"]],
  fills: [["symbol"], ["orderId", "orderID"], ["qty", "quantity", "volume"],
    ["price"], ["filledTm", "filledTime", "time"]],
  fill_history: [["symbol"], ["orderId", "orderID"], ["tradeId"], ["filledTime"]],
  margin_history: [["symbol"], ["positionId"], ["changeReason"],
    ["marginChange"], ["marginAfterChange"], ["time"]],
};
const optional = ["positionId", "positionID", "stopPrice", "origQty", "quantity",
  "executedQty", "workingType", "status", "commission", "commissionAsset",
  "fee", "feeCurrency", "realisedPNL", "leverage", "marginMode"];
const pagination = ["total", "pageIndex", "pageSize", "hasMore", "nextPage",
  "nextCursor", "cursor"];

export function summarizeVstContract(endpoint, data, params = {}) {
  const contract = ENDPOINTS.get(endpoint);
  if (!contract) return null;
  const issues = new Set();
  const wrappers = contract === "stop_lookup" ? ["order"]
    : contract === "open_stops" ? ["orders"]
    : contract === "fills" ? ["fill_orders", "orders"]
    : contract === "fill_history" ? ["fill_history_orders"]
    : contract === "margin_history" ? ["records", "list"] : [];
  let wrapper = "direct";
  let rows = data;
  if (object(data)) {
    const present = wrappers.filter(key => Object.hasOwn(data, key));
    if (present.length > 1) issues.add("multiple_containers");
    if (present.length) {
      wrapper = present[0];
      rows = data[wrapper];
    }
  }
  const shape = { contract, root: type(data), wrapper, fields: {}, pagination: {} };
  const history = contract === "fill_history" || contract === "margin_history";
  if (history) {
    if (object(data) && Object.keys(data).some(key =>
      ![...wrappers, ...pagination].includes(key))) issues.add("unreviewed_envelope");
    for (const key of pagination) {
      if (object(data) && Object.hasOwn(data, key)) shape.pagination[key] = type(data[key]);
    }
    const total = contract === "margin_history" && scalar(data?.total) ? Number(data.total) : data?.total;
    if (!Number.isSafeInteger(total) || total < 0) issues.add("total_invalid");
    if (pagination.slice(3).some(key => data?.[key] != null && data[key] !== false &&
        data[key] !== "" && data[key] !== 0)) issues.add("unreviewed_pagination");
    if (Array.isArray(rows) && Number.isSafeInteger(total)) {
      const size = Number(params.pageSize);
      const page = Number(params.pageIndex);
      if (contract === "fill_history") {
        if (page === 1 && total !== rows.length) issues.add("page_count_mismatch");
        if (page === 2 && rows.length !== 0) issues.add("terminal_not_empty");
      } else if (Number.isSafeInteger(size) && Number.isSafeInteger(page)) {
        const expected = Math.min(size, Math.max(0, total - (page - 1) * size));
        if (rows.length !== expected) issues.add("page_count_mismatch");
      }
    }
  }
  if (contract === "stop_lookup") {
    // Absent exact lookups are not a field contract; never invent evidence.
    if (data === null) return { ...shape, coverage: "empty", issues: [] };
    rows = [rows];
  }
  if (!Array.isArray(rows)) {
    issues.add("container_invalid");
    shape.coverage = "invalid";
  } else {
    shape.coverage = rows.length === 0 ? "empty" : rows.length > 32 ? "sampled" : "rows";
    // Bound CPU and retained summary size independently of provider row count.
    const keys = [...new Set([...groups[contract].flat(), ...optional])];
    for (const row of rows.slice(0, 32)) {
      if (!object(row)) { issues.add("row_invalid"); continue; }
      for (const aliases of groups[contract]) {
        const present = aliases.filter(key => row[key] != null);
        if (!present.length) issues.add(`missing:${aliases[0]}`);
        for (const key of present) {
          if (!scalar(row[key]) || (stringFields.has(key) && typeof row[key] !== "string") ||
              (contract === "fill_history" && key === "filledTime" && typeof row[key] !== "string") ||
              (contract === "margin_history" && key === "time" && !Number.isSafeInteger(row[key]))) {
            issues.add(`type:${key}`);
          }
          if (identifierFields.has(key) && typeof row[key] === "number" &&
              !Number.isSafeInteger(row[key])) issues.add(`unsafe_identifier:${key}`);
        }
        // Compare aliases in memory; never retain either value.
        if (present.length > 1 && new Set(present.map(key => String(row[key]))).size > 1) {
          issues.add(`alias_conflict:${aliases[0]}`);
        }
      }
      for (const key of keys) {
        if (Object.hasOwn(row, key)) {
          const types = new Set(shape.fields[key] ?? []);
          types.add(type(row[key]));
          shape.fields[key] = [...types].sort();
          if (row[key] != null && (!scalar(row[key]) ||
              (stringFields.has(key) && typeof row[key] !== "string"))) {
            issues.add(`type:${key}`);
          }
        }
      }
      if ((contract === "stop_lookup" || contract === "open_stops") &&
          row.type === "STOP_MARKET") {
        for (const key of ["stopPrice", "workingType"]) {
          if (!scalar(row[key])) issues.add(`missing:${key}`);
        }
        if (!["origQty", "quantity"].some(key => scalar(row[key]))) issues.add("missing:origQty");
      }
    }
  }
  shape.fields = Object.fromEntries(Object.entries(shape.fields).sort(([a], [b]) => a.localeCompare(b)));
  return { ...shape, issues: [...issues].sort() };
}

export function createVstContractDriftMonitor({ clock = Date.now, onAlert = () => {} } = {}) {
  const states = new Map();
  const sent = new Map();
  let pending = false;
  let lastClock = null;
  return {
    observe(endpoint, data, params) {
      const now = Number(clock());
      if (!Number.isSafeInteger(now)) return;
      if (lastClock !== null && now < lastClock) states.clear();
      lastClock = now;
      const summary = summarizeVstContract(endpoint, data, params);
      if (!summary) return;
      // First/terminal/continuation pages have distinct reviewed contracts.
      // A healthy terminal page must not clear drift on the first page.
      const page = Number(params?.pageIndex);
      const lane = summary.contract === "fill_history" || summary.contract === "margin_history"
        ? (page === 1 ? "first" : "continuation") : "single";
      const key = `${summary.contract}:${lane}`;
      const previous = states.get(key);
      if (!summary.issues.length) {
        states.delete(key);
        return;
      }
      // Repeated pagination reads in a single proof cannot qualify an incident.
      // Fingerprint only the violated contract, not amounts, optional fields,
      // row counts or symbols. This also keeps heterogeneous account rows quiet.
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([key, summary.issues])).digest("hex").slice(0, 16);
      let state = previous;
      if (!state || state.fingerprint !== fingerprint || now - state.last > 30 * 60_000) {
        state = { fingerprint, first: now, last: now, samples: 1, lastAttempt: null };
        states.set(key, state);
        return;
      }
      if (now - state.last < 60_000) return;
      state.last = now;
      state.samples++;
      if (state.samples < 3 || now - state.first < 5 * 60_000 ||
          pending || (state.lastAttempt !== null && now - state.lastAttempt < 5 * 60_000) ||
          (sent.has(fingerprint) && now - sent.get(fingerprint) < 24 * 60 * 60_000)) return;
      state.lastAttempt = now;
      pending = true;
      const report = Object.freeze({
        kind: "bingx_vst_contract_drift", fingerprint, summary,
      });
      // Delivery must not await/block a proof or alter its result.
      Promise.resolve().then(() => onAlert(report)).then(() => {
        sent.set(fingerprint, now);
        if (sent.size > 32) sent.delete(sent.keys().next().value);
      }).catch(() => {
        // No raw error logging: transport errors may contain credentials.
        process.stderr.write("BingX VST contract drift alert delivery failed\n");
      }).finally(() => { pending = false; });
    },
  };
}