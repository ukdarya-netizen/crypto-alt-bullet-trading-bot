import { createHash } from "node:crypto";
import { exactDecimalParts } from "./vst-exact-decimal.mjs";
import { FULL_TAKE_REASON } from "./fixed-price-take-profit.mjs";

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
  const x = exactDecimalParts(a), y = exactDecimalParts(b);
  return Boolean(x && y && x.units * 10n ** BigInt(y.scale) === y.units * 10n ** BigInt(x.scale));
}
function positive(value) {
  const p = exactDecimalParts(value);
  return Boolean(p && p.units > 0n);
}
export function nativeTakePrice(entry, precision) {
  const p = exactDecimalParts(entry);
  if (!p || p.units <= 0n || !Number.isInteger(precision) || precision < 0 || precision > 18)
    throw new Error("native_take_price_precision_unverified");
  const divisor = 100n * 10n ** BigInt(p.scale);
  const numerator = p.units * 105n * 10n ** BigInt(precision);
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
      equal(row.origQty ?? row.quantity, binding.quantity) &&
      equal(row.stopPrice, binding.takePrice) && Number(row.executedQty ?? 0) === 0;
  } catch { return false; }
}
export function nativeTakeQueryMatches(row, binding, open) {
  try {
    if (!nativeTakeOpenMatches(open, binding) || id(row) !== binding.orderId ||
        row.symbol !== nativeSymbol(binding.symbol) || row.status !== "NEW" ||
        row.side !== "SELL" || row.positionSide !== "LONG" ||
        !equal(row.origQty ?? row.quantity, binding.quantity)) return false;
    const positions = ["positionId", "positionID"].map((key) => row[key])
      .filter((v) => v !== undefined && v !== null && v !== "");
    if (positions.some((v) => String(v) !== "0" && v !== binding.positionId) ||
        new Set(positions.map(String)).size > 1) return false;
    if (row.type === "TAKE_PROFIT_MARKET") return equal(row.stopPrice, binding.takePrice);
    return row.type === "LIMIT" && equal(row.price, "0") &&
      (row.stopPrice === "" || row.stopPrice === undefined || row.stopPrice === null) &&
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
        !/^[1-9]\d*$/.test(binding.entryOrderId) || binding.workingType !== "CONTRACT_PRICE")
      throw new Error("native_take_binding_invalid");
    bindings.set(binding.clientOrderId, { ...binding });
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
          id(row, ["positionId", "positionID"]) !== binding.positionId ||
          !equal(row.origQty ?? row.quantity, expected.quantity) ||
          !equal(row.stopPrice, expected.stopPrice) || Number(row.executedQty ?? 0) !== 0)
        throw new Error("native_take_original_stop_not_verified");
    }
    if (!equal(stops.reduce((sum, s) => sum + Number(s.quantity), 0).toFixed(12)
      .replace(/0+$/, "").replace(/\.$/, ""), binding.quantity))
      throw new Error("native_take_stop_coverage_changed");
  }
  async function create(binding, stops, onAttemptStarted) {
    assertVst();
    const verify = async () => {
      const [positions, orders, mode, margin, leverage, entry] = await Promise.all([
        readPositions(binding.symbol), readOrders(binding.symbol), getPositionMode(),
        getMarginType(binding.symbol), getLeverage(binding.symbol),
        queryOrder(binding.symbol, { orderId: binding.entryOrderId }),
      ]);
      const active = positionRows(positions, binding);
      if (mode !== "HEDGE" || margin !== "ISOLATED" || Number(leverage.longLeverage) !== 10 ||
          active.length !== 1 || !equal(active[0].positionAmt, binding.quantity) ||
          !entry || id(entry) !== binding.entryOrderId || entry.status !== "FILLED" ||
          entry.symbol !== nativeSymbol(binding.symbol) || entry.side !== "BUY" ||
          entry.positionSide !== "LONG" || !equal(entry.avgPrice, binding.entryPrice))
        throw new Error("native_take_entry_or_settings_changed");
      checkStopRows(orders, binding, stops);
    };
    await verify();
    const response = await write("POST", {
      symbol: nativeSymbol(binding.symbol), type: "TAKE_PROFIT_MARKET", side: "SELL",
      positionSide: "LONG", quantity: binding.quantity, stopPrice: binding.takePrice,
      workingType: binding.workingType, closePosition: "true", clientOrderId: binding.clientOrderId,
    }, { beforeSign: verify, beforeTransport: onAttemptStarted });
    const submitted = { ...binding, orderId: exactOrderId(response) };
    register(submitted);
    return submitted;
  }
  async function inspect(binding) {
    assertVst();
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
  async function cancelWhenFlat(binding, expected = null) {
    assertVst();
    const order = expected ?? { orderId: binding.orderId, quantity: binding.quantity,
      stopPrice: binding.takePrice, type: "TAKE_PROFIT_MARKET" };
    let absent = false;
    const verify = async () => {
      const [positions, orders] = await Promise.all([
        readPositions(binding.symbol), readOrders(binding.symbol),
      ]);
      if (positions.some((r) => r.symbol === nativeSymbol(binding.symbol) && Number(r.positionAmt) !== 0))
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
    plan: async (symbol, entryPrice) => nativeTakePrice(entryPrice, (await contract(symbol)).pricePrecision),
    assertEntryAllowed(symbol) {
      if ([...bindings.values()].some((b) => b.symbol === symbol))
        throw new Error("native_take_previous_position_cleanup_pending");
    } });
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
export function createNativeTakeManager({ api, store, proveFill, clock = Date.now }) {
  const native = api.nativeFullTake;
  const blocked = new Set();
  async function report(sourceSignalId, error) {
    await store.recordEvent(sourceSignalId, "vst_native_take_pending", {
      reason: error instanceof Error ? error.message : "native_take_unverified",
    });
  }
  async function ensure(record) {
    const state = record.snapshot ?? record;
    if (record.status !== "open" || state.environment !== "vst" || Number(state.leverage) !== 10 ||
        !positive(state.remainingQty) || !state.exchangePositionId || !state.entryOrderId ||
        !state.accountId || state.marginMode !== "ISOLATED") return;
    if (await store.hasPendingSourceExitRequest?.(record.sourceSignalId)) return;
    const existing = await store.getIntent(record.sourceSignalId, NATIVE_TAKE_PHASE);
    if (existing) return;
    const takePrice = await native.plan(state.symbol, state.entryPrice);
    const clientOrderId = `nt_${createHash("sha256").update(JSON.stringify([
      state.accountId, record.sourceSignalId, state.entryOrderId, state.exchangePositionId,
    ])).digest("hex").slice(0, 28)}`;
    const binding = { symbol: state.symbol, positionId: state.exchangePositionId,
      entryOrderId: state.entryOrderId, entryPrice: String(state.entryPrice),
      quantity: String(state.remainingQty), takePrice, workingType: "CONTRACT_PRICE",
      clientOrderId, createdAt: Number(clock()) };
    const reservation = await store.reserveIntent({ sourceSignalId: record.sourceSignalId,
      phase: NATIVE_TAKE_PHASE, clientOrderId, request: {
        operation: "native_full_take", environment: "vst", accountId: state.accountId, binding,
      } });
    if (reservation.kind !== "new") return;
    try {
      const submitted = await native.create(binding, nativeStopBindings(state), async () => {
        await store.markIntent(clientOrderId, "submitted", { outcome: { attempted: true } });
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
    } catch (error) { await report(record.sourceSignalId, error); }
  }
  async function reconcile(intent) {
    let binding = { ...intent.request.binding,
      ...(intent.exchangeOrderId ? { orderId: intent.exchangeOrderId } : {}) };
    if (binding.orderId) native.register(binding);
    const record = await store.getPosition(intent.sourceSignalId);
    const observation = await native.inspect(binding);
    binding = observation.binding;
    if (binding.orderId && binding.orderId !== intent.exchangeOrderId) {
      await store.markIntent(intent.clientOrderId, "submitted", {
        exchangeOrderId: binding.orderId, outcome: { attempted: true, binding },
      });
    }
    if (observation.positions.length) {
      if (terminal(observation.queried)) {
        native.remove(binding);
        await store.markIntent(intent.clientOrderId, "failed", {
          exchangeOrderId: binding.orderId ?? null, outcome: { reason: "native_take_cancelled_on_exchange" },
        });
      } else if (!observation.active) await report(intent.sourceSignalId,
        new Error("native_take_order_not_confirmed_no_resubmission"));
      return;
    }
    if (!binding.orderId) {
      blocked.add(intent.sourceSignalId);
      return;
    }
    if (observation.queried?.status === "FILLED" && record?.status !== "closed") {
      blocked.add(intent.sourceSignalId);
      const evidence = await proveFill(binding);
      if (!evidence?.verified || evidence.status !== "filled" ||
          !equal(evidence.fill?.quantity, binding.quantity) ||
          !equal(evidence.residualPosition?.quantity, "0")) return;
      for (const stop of nativeStopBindings(record.snapshot))
        await native.cancelWhenFlat(binding, stop);
      // Verify cleanup before committing an irreversible closed ledger row.
      const after = await native.inspect(binding);
      if (after.positions.length || after.orders.length) return;
      const fill = { ...evidence.fill, reason: FULL_TAKE_REASON, leg: "core" };
      const position = { ...record.snapshot, sourceSignalId: intent.sourceSignalId,
        status: "closed", remainingQty: 0, coreQty: 0, runnerQty: 0, coreOpen: false,
        runnerOpen: false, closedAt: fill.at, closeReason: FULL_TAKE_REASON,
        lastCloseFill: fill, nativeTake: { ...binding, status: "filled" },
        sourceExit: { reason: FULL_TAKE_REASON, fill, origin: "native_take_profit" } };
      await store.commitVerifiedIntent({
        sourceSignalId: intent.sourceSignalId, clientOrderId: intent.clientOrderId,
        position, signalStatus: "closed", exchangeOrderId: evidence.childOrderId,
        outcome: { verified: true, status: "filled", fill, binding },
        eventKind: "vst_source_exit_closed",
        eventDetail: { reason: FULL_TAKE_REASON, closureOrigin: "native_take_profit",
          positionId: binding.positionId, fill },
        expectedPositionSnapshot: { ...record.snapshot, symbol: record.symbol, status: record.status },
        expectedPositionUpdatedAt: record.updatedAt,
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
    native.remove(binding);
    await store.markIntent(intent.clientOrderId, "failed", {
      exchangeOrderId: binding.orderId, outcome: { reason: "position_flat_native_take_not_filled" },
    });
  }
  return Object.freeze({
    ensure,
    blocksPosition: (sourceSignalId) => blocked.has(sourceSignalId),
    async sweep() {
      const intents = await store.listNativeTakeIntents();
      for (const intent of intents) {
        if (intent.exchangeOrderId) native.register({
          ...intent.request.binding, orderId: intent.exchangeOrderId,
        });
      }
      for (const intent of intents) {
        try { await reconcile(intent); }
        catch (error) { blocked.add(intent.sourceSignalId); await report(intent.sourceSignalId, error); }
      }
      for (const record of await store.listOpenPositions()) {
        try { await ensure(record); }
        catch (error) { await report(record.sourceSignalId, error); }
      }
    },
  });
}
