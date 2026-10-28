import { createHash } from "node:crypto";
import { exactDecimalParts } from "./vst-exact-decimal.mjs";
import { fullTakePct, fullTakeReason } from "./fixed-price-take-profit.mjs";

export const NATIVE_TAKE_PHASE = "native-full-take";
const nativeSymbol = (symbol) => symbol.replace(/-?USDT$/, "-USDT");
const terminal = (row) => ["CANCELED", "CANCELLED", "REJECTED", "EXPIRED"].includes(row?.status);
function id(row, fields = ["orderId", "orderID"]) {
  const values = fields.map((key) => row?.[key]).filter((v) => v !== undefined && v !== null && v !== "");
  if (!values.length || values.some((v) => typeof v !== "string" || !/^[1-9]\d*$/.test(v)) ||
      new Set(values).size !== 1) throw new Error("native_take_identity_unverified");
  return values[0];
}
function equal(a, b) {
  const x = signedParts(a), y = signedParts(b);
  return Boolean(x && y && x.units * 10n ** BigInt(y.scale) === y.units * 10n ** BigInt(x.scale));
}
function signedParts(value) {
  const text = String(value);
  const negative = text.startsWith("-");
  const parts = exactDecimalParts(negative ? text.slice(1) : value);
  return parts && { ...parts, units: negative ? -parts.units : parts.units };
}
function positive(value) {
  const p = exactDecimalParts(value);
  return Boolean(p && p.units > 0n);
}
function decimalText(units, scale) {
  const sign = units < 0n ? "-" : "";
  const text = (units < 0n ? -units : units).toString().padStart(scale + 1, "0");
  return scale ? `${sign}${text.slice(0, -scale)}.${text.slice(-scale)}` : `${sign}${text}`;
}
function sumDecimal(values) {
  const parts = values.map((v) => signedParts(v));
  if (parts.some((p) => !p)) throw new Error("native_take_decimal_invalid");
  const scale = Math.max(0, ...parts.map((p) => p.scale));
  return decimalText(parts.reduce((n, p) => n + p.units * 10n ** BigInt(scale - p.scale), 0n), scale);
}
export function nativeTakePrice(entry, precision, pct = 5) {
  const p = exactDecimalParts(entry);
  if (!p || p.units <= 0n || !Number.isInteger(precision) || precision < 0 || precision > 18)
    throw new Error("native_take_price_precision_unverified");
  if (!Number.isSafeInteger(pct) || pct <= 0) throw new Error("native_take_pct_invalid");
  const divisor = 100n * 10n ** BigInt(p.scale);
  const numerator = p.units * BigInt(100 + pct) * 10n ** BigInt(precision);
  const ticks = (numerator + divisor - 1n) / divisor;
  const digits = ticks.toString().padStart(precision + 1, "0");
  return precision ? `${digits.slice(0, -precision)}.${digits.slice(-precision)}` : digits;
}
export function nativeTakeOpenMatches(row, binding) {
  try {
    return id(row) === binding.orderId && row.symbol === nativeSymbol(binding.symbol) &&
      row.type === "TAKE_PROFIT_MARKET" && row.status === "NEW" &&
      row.side === "SELL" && row.positionSide === "LONG" &&
      id(row, ["positionId", "positionID"]) === binding.positionId &&
      [row.origQty, row.quantity].filter((v) => v != null).every((v) => equal(v, binding.quantity)) &&
      positive(row.origQty ?? row.quantity) && equal(row.stopPrice, binding.takePrice) &&
      [row.executedQty, row.filledQty, row.cumExecQty].filter((v) => v != null)
        .every((v) => equal(v, "0"));
  } catch { return false; }
}
export function nativeTakeQueryMatches(row, binding, open) {
  try {
    if (!nativeTakeOpenMatches(open, binding) || id(row) !== binding.orderId ||
        row.symbol !== nativeSymbol(binding.symbol) || row.status !== "NEW" ||
        row.side !== "SELL" || row.positionSide !== "LONG" ||
        !equal(row.origQty ?? row.quantity, binding.quantity)) return false;
    if ([row.executedQty, row.filledQty, row.cumExecQty].filter((v) => v != null)
      .some((v) => !equal(v, "0"))) return false;
    const positions = ["positionId", "positionID"].map((key) => row[key])
      .filter((v) => v !== undefined && v !== null && v !== "");
    if (positions.some((v) => String(v) !== "0" && v !== binding.positionId) ||
        new Set(positions.map(String)).size > 1) return false;
    if (row.type === "TAKE_PROFIT_MARKET") return equal(row.stopPrice, binding.takePrice);
    return row.type === "LIMIT" && equal(row.price, "0") &&
      (row.stopPrice === "" || row.stopPrice === undefined || row.stopPrice === null ||
        equal(row.stopPrice, "0")) &&
      row.takeProfit?.type === "TAKE_PROFIT_MARKET" &&
      row.takeProfit.workingType === binding.workingType && row.workingType === binding.workingType &&
      positions.length > 0 && positions.every((v) => String(v) === "0");
  } catch { return false; }
}

// This registry contains immutable, durably journalled identities, never a
// cached position/order observation. Every guard partitions a NEW native read.
// The public account/open-order API remains unfiltered.
export function createNativeTakeApi({ assertVst, readOrders, readPositions, queryOrder,
  contract, getPositionMode, getMarginType, getLeverage, write, exactOrderId, clock }) {
  const bindings = new Map();
  function register(binding) {
    assertVst();
    if (!/^[A-Z0-9]+USDT$/.test(binding.symbol) || !positive(binding.quantity) ||
        !positive(binding.takePrice) || !/^[1-9]\d*$/.test(binding.positionId) ||
        !/^[1-9]\d*$/.test(binding.entryOrderId) || binding.workingType !== "CONTRACT_PRICE" ||
        !/^[A-Za-z0-9_-]{1,40}$/.test(binding.clientOrderId ?? ""))
      throw new Error("native_take_binding_invalid");
    const previous = bindings.get(binding.clientOrderId);
    if (previous?.orderId && binding.orderId && previous.orderId !== binding.orderId)
      throw new Error("native_take_binding_identity_conflict");
    bindings.set(binding.clientOrderId, { ...binding,
      ...(previous?.orderId && !binding.orderId ? { orderId: previous.orderId } : {}) });
  }
  function remove(binding) { bindings.delete(binding.clientOrderId); }
  function guardOrders(rows) {
    return rows.filter((row) => {
      const matches = [...bindings.values()].filter((b) => {
        try { return b.orderId && id(row) === b.orderId; } catch { return false; }
      });
      if (!matches.length) return true;
      if (matches.length !== 1 || !nativeTakeOpenMatches(row, matches[0]))
        throw new Error("native_take_guard_order_conflict");
      return false;
    });
  }
  function positionRows(rows, binding) {
    const active = rows.filter((r) => r.symbol === nativeSymbol(binding.symbol) &&
      Number(r.positionAmt) !== 0);
    if (active.some((r) => !Number.isFinite(Number(r.positionAmt)) || r.positionSide !== "LONG") ||
        active.length > 1) throw new Error("native_take_position_ambiguous");
    if (active.length && id(active[0], ["positionId", "positionID"]) !== binding.positionId)
      throw new Error("native_take_position_changed");
    return active;
  }
  function checkStopRows(rows, binding, stops) {
    if (!stops.length || rows.length !== stops.length) throw new Error("native_take_stop_set_changed");
    for (const row of rows) {
      const expected = stops.find((s) => s.orderId === id(row));
      if (!expected || row.symbol !== nativeSymbol(binding.symbol) || row.type !== "STOP_MARKET" ||
          row.status !== "NEW" || row.side !== "SELL" || row.positionSide !== "LONG" ||
          row.workingType !== "MARK_PRICE" ||
          id(row, ["positionId", "positionID"]) !== binding.positionId ||
          !equal(row.origQty ?? row.quantity, expected.quantity) ||
          !equal(row.stopPrice, expected.stopPrice) || Number(row.executedQty ?? 0) !== 0)
        throw new Error("native_take_original_stop_not_verified");
    }
    if (!equal(sumDecimal(stops.map((s) => s.quantity)), binding.quantity))
      throw new Error("native_take_stop_coverage_changed");
  }
  async function create(binding, stops, onAttemptStarted) {
    assertVst();
    const filters = await contract(binding.symbol);
    if (!equal(binding.takePrice,
      nativeTakePrice(binding.entryPrice, filters.pricePrecision, binding.takePct ?? 5)))
      throw new Error("native_take_target_is_not_the_strategy_take");
    const verify = async () => {
      const [positions, orders, mode, margin, leverage, entry] = await Promise.all([
        readPositions(binding.symbol), readOrders(binding.symbol), getPositionMode(),
        getMarginType(binding.symbol), getLeverage(binding.symbol),
        queryOrder(binding.symbol, { orderId: binding.entryOrderId }),
      ]);
      const active = positionRows(positions, binding);
      // Name the first failing check (the bare "settings changed" hid which one).
      const failed = mode !== "HEDGE" ? "position_mode"
        : margin !== "ISOLATED" ? "margin_type"
          : Number(leverage.longLeverage) !== 10 ? "leverage"
            : active.length !== 1 ? "position_absent"
              : !equal(active[0].positionAmt, binding.quantity) ? "position_quantity"
                : !entry || id(entry) !== binding.entryOrderId ? "entry_order_identity"
                  : entry.status !== "FILLED" || !positive(entry.executedQty) ? "entry_order_status"
                    : entry.symbol !== nativeSymbol(binding.symbol) || entry.side !== "BUY" ||
                        entry.positionSide !== "LONG" ? "entry_order_side"
                      : !equal(entry.avgPrice, binding.entryPrice) ? "entry_avg_price" : null;
      if (failed) throw new Error(`native_take_entry_or_settings_changed:${failed}`);
      checkStopRows(orders, binding, stops);
    };
    await verify();
    const response = await write("POST", {
      symbol: nativeSymbol(binding.symbol), type: "TAKE_PROFIT_MARKET", side: "SELL",
      positionSide: "LONG", quantity: binding.quantity, stopPrice: binding.takePrice,
      workingType: binding.workingType, closePosition: "true", clientOrderId: binding.clientOrderId,
    }, { beforeSign: verify, beforeTransport: onAttemptStarted });
    const orderId = exactOrderId(response);
    if (orderId === binding.entryOrderId || stops.some((s) => s.orderId === orderId))
      throw new Error("native_take_ack_conflicts_with_existing_order");
    const submitted = { ...binding, orderId };
    register(submitted);
    return submitted;
  }
  async function inspect(binding, snapshot = null) {
    assertVst();
    if (snapshot && binding.orderId) {
      const positions = positionRows(snapshot.positions, binding);
      const orders = snapshot.orders.filter((r) => r.symbol === nativeSymbol(binding.symbol));
      if (positions.length === 1 && equal(positions[0].positionAmt, binding.quantity) &&
          orders.filter((r) => nativeTakeOpenMatches(r, binding)).length === 1)
        return { binding, positions, orders, queried: null, active: true,
          triggerBasisVerified: false };
    }
    const [positions, orders, queried] = await Promise.all([
      readPositions(binding.symbol), readOrders(binding.symbol),
      queryOrder(binding.symbol, binding.orderId
        ? { orderId: binding.orderId } : { clientOrderId: binding.clientOrderId }),
    ]);
    const activePositions = positionRows(positions, binding);
    if (!binding.orderId && queried) {
      const clients = [queried.clientOrderId, queried.clientOrderID].filter((v) => v != null && v !== "");
      if (!clients.length || clients.some((v) => v !== binding.clientOrderId))
        throw new Error("native_take_recovery_client_id_unverified");
      binding = { ...binding, orderId: exactOrderId(queried) };
      register(binding);
    }
    const open = orders.find((row) => { try { return id(row) === binding.orderId; } catch { return false; } });
    return { binding, positions: activePositions, orders, queried,
      active: Boolean(open && nativeTakeQueryMatches(queried, binding, open)),
      triggerBasisVerified: Boolean(open && open.workingType === binding.workingType &&
        queried?.workingType === binding.workingType) };
  }
  async function cancelWhenFlat(binding, expected = null, allowSamePosition = false) {
    assertVst();
    const order = expected ?? { orderId: binding.orderId, quantity: binding.quantity,
      stopPrice: binding.takePrice, type: "TAKE_PROFIT_MARKET" };
    let absent = false;
    const verify = async () => {
      const [positions, orders] = await Promise.all([
        readPositions(binding.symbol), readOrders(binding.symbol),
      ]);
      const active = positionRows(positions, binding);
      if (active.length && (!allowSamePosition || expected !== null))
        throw new Error("native_take_cleanup_requires_flat_symbol");
      const rows = orders.filter((r) => id(r) === order.orderId);
      if (!rows.length) { absent = true; return; }
      const row = rows[0];
      if (rows.length !== 1 || row.symbol !== nativeSymbol(binding.symbol) ||
          row.type !== order.type || row.status !== "NEW" || row.side !== "SELL" ||
          row.positionSide !== "LONG" || id(row, ["positionId", "positionID"]) !== binding.positionId ||
          !equal(row.origQty ?? row.quantity, order.quantity) || !equal(row.stopPrice, order.stopPrice) ||
          Number(row.executedQty ?? 0) !== 0) throw new Error("native_take_cleanup_order_not_owned");
    };
    await verify();
    if (!absent) await write("DELETE", {
      symbol: nativeSymbol(binding.symbol), orderId: order.orderId,
    }, { beforeSign: async () => {
      await verify();
      if (absent) throw new Error("native_take_cleanup_order_already_terminal");
    } });
    const [queried, remaining] = await Promise.all([
      queryOrder(binding.symbol, { orderId: order.orderId }), readOrders(binding.symbol),
    ]);
    if (!queried || id(queried) !== order.orderId ||
        ![...["CANCELED", "CANCELLED", "REJECTED", "EXPIRED"], "FILLED"].includes(queried.status) ||
        remaining.some((r) => id(r) === order.orderId))
      throw new Error("native_take_cleanup_not_confirmed");
    return queried;
  }
  return Object.freeze({ register, remove, guardOrders, create, inspect, cancelWhenFlat,
    restore(intents) {
      const active = new Set(intents.map((i) => i.clientOrderId));
      for (const key of bindings.keys()) if (!active.has(key)) bindings.delete(key);
      for (const intent of intents) {
        if (intent.request?.binding &&
            (intent.exchangeOrderId || intent.state !== "prepared"))
          register({ ...intent.request.binding,
            ...(intent.exchangeOrderId ? { orderId: intent.exchangeOrderId } : {}) });
      }
    },
    async readAccount() {
      assertVst();
      const [positions, orders] = await Promise.all([readPositions(), readOrders()]);
      if (!Array.isArray(positions) || !Array.isArray(orders))
        throw new Error("native_take_account_cohort_invalid");
      return { positions, orders };
    },
    plan: async (symbol, entryPrice, pct = 5) =>
      nativeTakePrice(entryPrice, (await contract(symbol)).pricePrecision, pct),
    async hasPosition(binding) {
      const rows = positionRows(await readPositions(binding.symbol), binding);
      return rows.length === 1 && equal(rows[0].positionAmt, binding.quantity);
    },
    assertEntryAllowed(symbol) {
      if ([...bindings.values()].some((b) => b.symbol === symbol))
        throw new Error("native_take_previous_position_cleanup_pending");
    } });
}

// A native fill is established from complete, bounded exchange executions,
// exact parent/child linkage and a fresh flat position. A missing position,
// an acknowledgement, or a positive PnL is never fill evidence.
export async function proveNativeTakeFill(api, binding, knownStops, now = Date.now()) {
  try {
    const [parent, positions, orders, fills] = await Promise.all([
      api.queryOrder(binding.symbol, { orderId: binding.orderId }),
      api.getPositions(binding.symbol), api.getOpenOrders(binding.symbol),
      api.queryFills(binding.symbol, {
        startTs: Math.max(1, binding.createdAt - 60_000, now - 86_400_000),
        endTs: now, currency: "USDT", requireComplete: true,
      }),
    ]);
    if (!parent || parent.status !== "FILLED" || parent.symbol !== nativeSymbol(binding.symbol) ||
        parent.side !== "SELL" || parent.positionSide !== "LONG" ||
        !["TAKE_PROFIT_MARKET", "MARKET", "LIMIT"].includes(parent.type) ||
        parent.type === "LIMIT" && (parent.takeProfit?.type !== "TAKE_PROFIT_MARKET" ||
          !equal(parent.price, "0")) ||
        positions.some((p) => p.symbol === nativeSymbol(binding.symbol) && Number(p.positionAmt) !== 0))
      return { verified: false };
    for (const order of orders) {
      const expected = knownStops.find((s) => s.orderId === id(order));
      if (!expected || order.symbol !== nativeSymbol(binding.symbol) || order.type !== "STOP_MARKET" ||
          order.status !== "NEW" || order.side !== "SELL" || order.positionSide !== "LONG" ||
          id(order, ["positionId", "positionID"]) !== binding.positionId ||
          !equal(order.origQty ?? order.quantity, expected.quantity) ||
          !equal(order.stopPrice, expected.stopPrice)) return { verified: false };
    }
    let linked = fills.filter((f) => {
      const values = [f.triggerOrderId, f.triggerOrderID].filter((v) => v != null);
      if (!values.some((v) => v === binding.orderId)) return false;
      return id(f, ["triggerOrderId", "triggerOrderID"]) === binding.orderId;
    });
    // NOT 2026-10-28: the complete VST fill history carries no triggerOrderId.
    // The exchange links the take itself: querying the take's ID returns the
    // executed child order (its own orderId) with triggerOrderId = the take and
    // our clientOrderId. Fills of exactly that child order are the take's fills.
    let parentIsChild = false;
    if (!linked.length && id(parent) !== binding.orderId &&
        id(parent, ["triggerOrderId", "triggerOrderID"]) === binding.orderId &&
        (binding.clientOrderId == null || parent.clientOrderId === binding.clientOrderId)) {
      const childId = id(parent);
      linked = fills.filter((f) => {
        const trigger = [f.triggerOrderId, f.triggerOrderID].filter((v) => v != null && v !== "");
        return id(f) === childId && trigger.every((v) => v === binding.orderId);
      });
      parentIsChild = linked.length > 0;
    }
    if (!linked.length) return { verified: false };
    const childIds = new Set(linked.map((f) => id(f)));
    if (childIds.size !== 1) return { verified: false };
    const childOrderId = [...childIds][0];
    if (id(parent) !== binding.orderId && id(parent) !== childOrderId) return { verified: false };
    const child = parentIsChild ? parent
      : await api.queryOrder(binding.symbol, { orderId: childOrderId });
    if (!child || id(child) !== childOrderId || child.status !== "FILLED" ||
        child.symbol !== nativeSymbol(binding.symbol) || child.side !== "SELL" ||
        child.positionSide !== "LONG" || !["MARKET", "TAKE_PROFIT_MARKET"].includes(child.type) ||
        !equal(child.executedQty, binding.quantity)) return { verified: false };
    for (const row of [parent, child, ...linked]) {
      const supplied = [row.positionId, row.positionID].filter((v) => v != null && String(v) !== "0");
      if (supplied.some((v) => v !== binding.positionId)) return { verified: false };
    }
    const aliases = (row, fields, timestamp = false) => {
      const values = fields.map((k) => row[k]).filter((v) => v !== undefined && v !== null);
      if (!values.length) throw new Error("native_take_fill_fields_missing");
      if (timestamp) {
        const times = values.map((v) => /^\d+$/.test(String(v)) ? Number(v) : Date.parse(v));
        if (times.some((t) => !Number.isSafeInteger(t) || t < binding.createdAt || t > now + 2000) ||
            new Set(times).size !== 1) throw new Error("native_take_fill_time_conflict");
        return times[0];
      }
      if (values.some((v) => !equal(v, values[0]))) throw new Error("native_take_fill_alias_conflict");
      return String(values[0]);
    };
    const quantities = [], fees = [], times = [], products = [];
    const trades = new Set(), assets = new Set();
    for (const f of linked) {
      if (f.symbol !== nativeSymbol(binding.symbol) || f.side !== "SELL" || f.positionSide !== "LONG")
        return { verified: false };
      if (linked.length > 1) {
        const trade = id(f, ["tradeId", "tradeID", "fillId", "fillID"]);
        if (trades.has(trade)) return { verified: false };
        trades.add(trade);
      }
      const quantity = aliases(f, ["qty", "quantity", "volume"]);
      const price = aliases(f, ["price", "tradePrice", "fillPrice"]);
      const fee = aliases(f, ["commission", "fee", "commissionAmount", "feeAmount"]);
      const currencies = ["commissionAsset", "feeAsset", "feeCurrency", "currency"]
        .map((k) => f[k]).filter((v) => v != null);
      if (!currencies.length || new Set(currencies).size !== 1 ||
          !["VST", "USDT"].includes(currencies[0]) || !positive(quantity) || !positive(price))
        return { verified: false };
      assets.add(currencies[0]);
      quantities.push(quantity); fees.push(fee);
      times.push(aliases(f, ["filledTm", "filledTime", "time", "timestamp", "tradeTime"], true));
      const q = exactDecimalParts(quantity), p = exactDecimalParts(price);
      products.push(decimalText(q.units * p.units, q.scale + p.scale));
    }
    if (assets.size !== 1 || !equal(sumDecimal(quantities), binding.quantity)) return { verified: false };
    const total = exactDecimalParts(sumDecimal(products)), quantity = exactDecimalParts(binding.quantity);
    const average = decimalText(total.units * 10n ** BigInt(quantity.scale + 18) /
      (quantity.units * 10n ** BigInt(total.scale)), 18);
    return { verified: true, status: "filled", childOrderId,
      fill: { orderId: childOrderId, triggerOrderId: binding.orderId,
        quantity: binding.quantity, price: average,
        fee: { asset: [...assets][0], amount: sumDecimal(fees) },
        at: new Date(Math.max(...times)).toISOString() },
      residualPosition: { verified: true, positionId: binding.positionId, quantity: "0" } };
  } catch { return { verified: false }; }
}

export function nativeStopBindings(state) {
  const result = [];
  for (const leg of ["core", "runner"]) {
    const saved = state.verifiedProtectiveStops?.[leg];
    const orderId = saved?.orderId ?? state[`${leg}StopOrderId`];
    const quantity = saved?.quantity ?? state[`${leg}StopQuantity`];
    const stopPrice = saved?.stopPrice ?? (leg === "core" ? state.stopPrice : state.runnerStopPrice);
    if (orderId && positive(quantity) && positive(stopPrice))
      result.push({ orderId, quantity: String(quantity), stopPrice: String(stopPrice), type: "STOP_MARKET" });
  }
  return result;
}

// Each operation runs under the existing worker leader lock. Its durable
// submitted marker precedes transport; a restart may only LOOK UP that client
// ID, never replay the POST.
export function createNativeTakeManager({ api, store, proveFill, clock = Date.now,
  legacyExitStrategy = "full_take_5pct" }) {
  const native = api.nativeFullTake;
  const blocked = new Set();
  const owned = new Set();
  const reported = new Map();
  // A take that cannot be placed must not be retried every sweep: each attempt
  // reads position mode, margin type, leverage, positions, orders and the entry.
  // 2026-10-26/27 the retries kept GET /trade/marginType in BingX's 100410
  // "disabled period", and new entries (which read the same endpoint) expired.
  // Backoff 2, 4, 8, 16, 30 min per position; reset after a placed take.
  const createRetry = new Map();
  const CREATE_BACKOFF_MS = [120_000, 240_000, 480_000, 960_000, 1_800_000];
  const createDeferred = (sourceSignalId) =>
    Number(clock()) < (createRetry.get(sourceSignalId)?.at ?? 0);
  function noteCreateFailure(sourceSignalId) {
    const failures = (createRetry.get(sourceSignalId)?.failures ?? 0) + 1;
    createRetry.set(sourceSignalId, { failures,
      at: Number(clock()) + CREATE_BACKOFF_MS[Math.min(failures, CREATE_BACKOFF_MS.length) - 1] });
  }
  async function report(sourceSignalId, error) {
    const reason = error instanceof Error ? error.message : "native_take_unverified";
    const key = `${sourceSignalId}:${reason}`;
    if (Number(clock()) - (reported.get(key) ?? -Infinity) < 60_000) return;
    reported.set(key, Number(clock()));
    await store.recordEvent(sourceSignalId, "vst_native_take_pending", {
      reason,
    });
  }
  async function ensure(record) {
    const state = record.snapshot ?? record;
    if (state.executionStrategy && state.executionStrategy.version !== 1)
      throw new TypeError("Unsupported position strategy version");
    // +5 / +8 / +10 % (owner 2026-10-28); any other strategy has no native take.
    const takePct = fullTakePct(state.executionStrategy?.exitStrategy ?? legacyExitStrategy);
    if (takePct === null) return;
    if (createDeferred(record.sourceSignalId)) return;
    if (record.status !== "open" || state.environment !== "vst" || Number(state.leverage) !== 10 ||
        !positive(state.remainingQty) || !state.exchangePositionId || !state.entryOrderId ||
        !state.accountId || String(state.marginMode).toUpperCase() !== "ISOLATED") return;
    if (await store.hasPendingSourceExitRequest?.(record.sourceSignalId)) return;
    const existing = await store.latestNativeTakeIntent(record.sourceSignalId);
    if (existing && !["failed", "reconciled"].includes(existing.state)) return;
    if (existing && Number(clock()) - Date.parse(existing.updatedAt) < 5_000) return;
    const revision = existing ? Number(existing.request.revision ?? 0) + 1 : 0;
    const takePrice = await native.plan(state.symbol, state.entryPrice, takePct);
    const clientOrderId = `nt_${createHash("sha256").update(JSON.stringify([
      state.accountId, record.sourceSignalId, state.entryOrderId, state.exchangePositionId, revision,
    ])).digest("hex").slice(0, 28)}`;
    const binding = { symbol: state.symbol, positionId: state.exchangePositionId,
      entryOrderId: state.entryOrderId, entryPrice: String(state.entryPrice),
      quantity: String(state.remainingQty), takePrice, workingType: "CONTRACT_PRICE",
      clientOrderId, createdAt: Number(clock()), ...(takePct === 5 ? {} : { takePct }) };
    if (!await native.hasPosition(binding)) return;
    const reservation = await store.reserveIntent({ sourceSignalId: record.sourceSignalId,
      phase: `${NATIVE_TAKE_PHASE}-${revision}`, clientOrderId, request: {
        operation: "native_full_take", environment: "vst", accountId: state.accountId, binding, revision,
      } });
    if (reservation.kind !== "new") return;
    owned.add(record.sourceSignalId);
    try {
      const submitted = await native.create(binding, nativeStopBindings(state), async () => {
        if (await store.hasPendingSourceExitRequest?.(record.sourceSignalId))
          throw new Error("native_take_source_exit_queued_before_transport");
        await store.markIntent(clientOrderId, "submitted", { outcome: { attempted: true } });
        native.register(binding);
      });
      await store.markIntent(clientOrderId, "submitted", {
        exchangeOrderId: submitted.orderId, outcome: { attempted: true, binding: submitted },
      });
      const evidence = await native.inspect(submitted);
      if (!evidence.active) throw new Error("native_take_active_order_not_yet_verified");
      await store.recordEvent(record.sourceSignalId, "vst_native_take_verified", {
        orderId: submitted.orderId, takePrice, quantity: binding.quantity,
        triggerBasisVerified: evidence.triggerBasisVerified,
      }, clientOrderId);
      createRetry.delete(record.sourceSignalId);
    } catch (error) {
      noteCreateFailure(record.sourceSignalId);
      await report(record.sourceSignalId, error);
    }
  }
  async function reconcile(intent, snapshot) {
    blocked.delete(intent.sourceSignalId);
    let binding = { ...intent.request.binding,
      ...(intent.exchangeOrderId ? { orderId: intent.exchangeOrderId } : {}) };
    if (intent.state !== "prepared" || binding.orderId) native.register(binding);
    if (intent.state === "prepared" &&
        await store.hasPendingSourceExitRequest?.(intent.sourceSignalId)) return;
    const record = await store.getNativeTakePosition(intent.sourceSignalId);
    const observation = await native.inspect(binding, snapshot);
    binding = observation.binding;
    if (binding.orderId && binding.orderId !== intent.exchangeOrderId) {
      await store.markIntent(intent.clientOrderId, "submitted", {
        exchangeOrderId: binding.orderId, outcome: { attempted: true, binding },
      });
    }
    if (observation.positions.length) {
      if (intent.state === "prepared" && !observation.queried && record?.status === "open") {
        if (createDeferred(intent.sourceSignalId)) return;
        let submitted;
        try {
          submitted = await native.create(binding, nativeStopBindings(record.snapshot), async () => {
            if (await store.hasPendingSourceExitRequest?.(intent.sourceSignalId))
              throw new Error("native_take_source_exit_queued_before_transport");
            await store.markIntent(intent.clientOrderId, "submitted", { outcome: { attempted: true } });
            native.register(binding);
          });
        } catch (error) {
          noteCreateFailure(intent.sourceSignalId);
          throw error;
        }
        createRetry.delete(intent.sourceSignalId);
        await store.markIntent(intent.clientOrderId, "submitted", {
          exchangeOrderId: submitted.orderId, outcome: { attempted: true, binding: submitted },
        });
        return;
      }
      if (terminal(observation.queried)) {
        await store.markIntent(intent.clientOrderId, "failed", {
          exchangeOrderId: binding.orderId ?? null, outcome: { reason: "native_take_cancelled_on_exchange" },
        });
        native.remove(binding);
      } else if (observation.active && !equal(observation.positions[0].positionAmt, binding.quantity)) {
        const cancelled = await native.cancelWhenFlat(binding, null, true);
        if (terminal(cancelled)) {
          await store.markIntent(intent.clientOrderId, "failed", {
            exchangeOrderId: binding.orderId, outcome: { reason: "native_take_resize_after_verified_quantity_change" },
          });
          native.remove(binding);
        }
      } else if (!observation.active) await report(intent.sourceSignalId,
        new Error("native_take_order_not_confirmed_no_resubmission"));
      return;
    }
    if (!binding.orderId) {
      if (intent.state === "prepared" && !observation.queried) {
        await store.markIntent(intent.clientOrderId, "failed", {
          outcome: { reason: "position_flat_before_native_take_transport", attempted: false },
        });
        native.remove(binding);
        return;
      }
      blocked.add(intent.sourceSignalId);
      return;
    }
    if (observation.queried?.status === "FILLED" && record) {
      blocked.add(intent.sourceSignalId);
      const evidence = await proveFill(binding, nativeStopBindings(record.snapshot));
      if (!evidence?.verified || evidence.status !== "filled" ||
          !equal(evidence.fill?.quantity, binding.quantity) ||
          !equal(evidence.residualPosition?.quantity, "0")) {
        // Leave a trace: a filled take whose proof fails used to stay silent.
        await report(intent.sourceSignalId, new Error("native_take_filled_fill_not_proven"));
        return;
      }
      for (const stop of nativeStopBindings(record.snapshot))
        await native.cancelWhenFlat(binding, stop);
      // Verify cleanup before committing an irreversible closed ledger row.
      const after = await native.inspect(binding);
      if (after.positions.length || after.orders.length) return;
      const takeReason = fullTakeReason(binding.takePct ?? 5);
      const fill = { ...evidence.fill, reason: takeReason };
      const position = { ...record.snapshot, sourceSignalId: intent.sourceSignalId,
        status: "closed", remainingQty: 0, coreQty: 0, runnerQty: 0, coreOpen: false,
        runnerOpen: false, closedAt: fill.at, closeReason: takeReason,
        closeFill: fill, lastCloseFill: fill, nativeTake: { ...binding, status: "filled" },
        sourceExit: { reason: takeReason, fill, origin: "native_take_profit" } };
      await store.commitVerifiedIntent({
        sourceSignalId: intent.sourceSignalId, clientOrderId: intent.clientOrderId,
        position, signalStatus: "closed", exchangeOrderId: evidence.childOrderId,
        outcome: { verified: true, status: "filled", fill, binding },
        eventKind: "vst_source_exit_closed",
        eventDetail: { reason: takeReason,
          sourceEvidence: { reason: takeReason, issuer: "executor_policy" },
          closureOrigin: "native_take_profit",
          positionId: binding.positionId, fill },
        expectedPositionSnapshot: record.snapshot,
        expectedPositionUpdatedAt: record.updatedAt,
        expectedPositionStatus: record.status,
        retireNativeTakeSiblings: true,
      });
      native.remove(binding);
      blocked.delete(intent.sourceSignalId);
      return;
    }
    if (observation.active) {
      const cancelled = await native.cancelWhenFlat(binding);
      if (cancelled.status === "FILLED") {
        blocked.add(intent.sourceSignalId);
        return;
      }
    } else if (!terminal(observation.queried)) {
      blocked.add(intent.sourceSignalId);
      return;
    }
    await store.markIntent(intent.clientOrderId, "failed", {
      exchangeOrderId: binding.orderId, outcome: { reason: "position_flat_native_take_not_filled" },
    });
    native.remove(binding);
  }
  return Object.freeze({
    ensure,
    blocksPosition: (sourceSignalId) => blocked.has(sourceSignalId),
    ownsPosition: (sourceSignalId) => owned.has(sourceSignalId),
    async sweep() {
      const intents = await store.listNativeTakeIntents();
      owned.clear();
      for (const intent of intents) owned.add(intent.sourceSignalId);
      native.restore(intents);
      // A fresh account cohort covers all resting takes. Initial proof,
      // missing orders and closures still require exact-ID/native-fill reads.
      const snapshot = intents.length ? await native.readAccount() : null;
      for (const intent of intents) {
        try { await reconcile(intent, snapshot); }
        catch (error) { blocked.add(intent.sourceSignalId); await report(intent.sourceSignalId, error); }
      }
      owned.clear();
      for (const intent of await store.listNativeTakeIntents()) owned.add(intent.sourceSignalId);
      for (const record of await store.listOpenPositions()) {
        try { await ensure(record); }
        catch (error) { await report(record.sourceSignalId, error); }
      }
    },
  });
}
