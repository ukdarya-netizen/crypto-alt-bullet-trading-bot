// An explicitly owner-approved, one-position VST probe. Never used by the
// normal worker. The durable journal is required before every exchange write.
const SYMBOL = "BTCUSDT";
const NATIVE = "BTC-USDT";
const active = (rows) => rows.filter((row) => Number(row.positionAmt) !== 0);
const exactId = (value) => typeof value === "string" && /^[1-9]\d*$/.test(value);
function orderId(row) {
  const values = [row?.orderId, row?.orderID, row?.order?.orderId, row?.order?.orderID]
    .filter((value) => value !== undefined && value !== null);
  if (!values.length || values.some((value) => !exactId(value)) ||
      new Set(values).size !== 1) throw Error("probe_order_identity_not_lossless");
  return values[0];
}
const positionId = (row) => row?.positionId ?? row?.positionID;
function rounded(value, precision, direction) {
  const scale = 10 ** precision;
  return (Math[direction](value * scale) / scale).toFixed(precision);
}
function sameOrder(row, id, type, quantity, price) {
  return orderId(row) === id && row.symbol === NATIVE && row.side === "SELL" &&
    row.positionSide === "LONG" && row.type === type && row.status === "NEW" &&
    Number(row.origQty ?? row.quantity) === Number(quantity) &&
    Number(row.stopPrice) === Number(price);
}

export async function runControlledVstBracketProbe({
  api, submitTake, cancelProtective, save, state = null, clock = Date.now,
  makeId, closePolicy,
}) {
  if (typeof save !== "function") throw Error("probe_requires_durable_journal");
  if (state !== null && (state.version !== 1 || state.symbol !== SYMBOL ||
      !/^vbp_[a-z0-9]+$/.test(state.entryClientId ?? "") ||
      !/^vbp_[a-z0-9]+$/.test(state.closeClientId ?? ""))) {
    throw Error("invalid_probe_journal");
  }
  if (state?.finished) return state;
  const record = async (fields) => {
    state = { ...state, ...fields, updatedAt: new Date(clock()).toISOString() };
    await save(state);
  };
  const readPosition = async () => {
    const rows = active(await api.getPositions(SYMBOL));
    if (!rows.length) return null;
    if (rows.length !== 1 || rows[0].positionSide !== "LONG" ||
        !exactId(positionId(rows[0])) ||
        state.positionId && positionId(rows[0]) !== state.positionId ||
        Number(rows[0].positionAmt) !== Number(state.quantity)) {
      throw Error("probe_position_identity_changed");
    }
    return rows[0];
  };
  async function verifyStop() {
    const [position, orders, mode, margin, leverage] = await Promise.all([
      readPosition(), api.getOpenOrders(SYMBOL), api.getPositionMode(),
      api.getMarginType(SYMBOL), api.getLeverage(SYMBOL),
    ]);
    if (!position || mode !== "HEDGE" || margin !== "ISOLATED" ||
        Number(leverage.longLeverage) !== 10 || orders.length !== 1 ||
        !sameOrder(orders[0], state.stopOrderId, "STOP_MARKET", state.quantity, state.stopLoss)) {
      throw Error("probe_original_stop_or_settings_changed");
    }
    return orders;
  }
  if (state === null) {
    const [positions, orders, mode, margin, filters] = await Promise.all([
      api.getPositions(SYMBOL), api.getOpenOrders(SYMBOL), api.getPositionMode(),
      api.getMarginType(SYMBOL), api.contract(SYMBOL),
    ]);
    if (active(positions).length || orders.length || mode !== "HEDGE" ||
        margin !== "ISOLATED") throw Error("probe_requires_flat_isolated_hedge_symbol");
    state = {
      version: 1, symbol: SYMBOL, entryClientId: makeId(), closeClientId: makeId(),
      startedAt: new Date(clock()).toISOString(), pricePrecision: filters.pricePrecision,
    };
    await record({ phase: "prepared" });
    const leverage = await api.getLeverage(SYMBOL);
    if (Number(leverage.longLeverage) !== 10) {
      await record({ leveragePreparationAttempted: true });
      await api.setVstLongLeverage10(SYMBOL);
    }
    const quote = await api.getVstMarkPrice(SYMBOL);
    const ask = Number(quote.markCorroboration?.ask ?? quote.markPrice);
    if (!Number.isFinite(ask) || ask <= 0 ||
        clock() - quote.timestamp > 10_000 || clock() < quote.timestamp) {
      throw Error("probe_quote_not_fresh");
    }
    const maxPrice = rounded(ask * 1.001, filters.pricePrecision, "ceil");
    const quantity = rounded(90 / Number(maxPrice), filters.quantityPrecision, "floor");
    const stopLoss = rounded(ask * 0.98, filters.pricePrecision, "floor");
    const notional = Number(maxPrice) * Number(quantity);
    if (Number(quantity) < filters.minQuantity || notional < filters.minNotional ||
        notional > 100 || notional / 10 > 10) throw Error("probe_budget_invalid");
    // Entry uses existing price-capped FOK helper, with stop attached.
    // An ambiguous or unfilled attempt is never submitted again.
    await record({ phase: "entry_attempted", quantity, maxPrice, stopLoss,
      entryAttemptedAt: new Date(clock()).toISOString() });
    try {
      await api.placeVstBoundedLong({
        symbol: SYMBOL, quantity, maxPrice, stopLoss, clientOrderId: state.entryClientId,
      });
    } catch (error) {
      await record({ entryTransportError: error.message });
    }
  }

  // Recover by exact client ID even after an ambiguous entry acknowledgement.
  const entry = await api.queryOrder(SYMBOL, { clientOrderId: state.entryClientId });
  const entryId = orderId(entry);
  if (entry.symbol !== NATIVE || entry.side !== "BUY" || entry.positionSide !== "LONG" ||
      entry.clientOrderId !== state.entryClientId || entry.status !== "FILLED" ||
      Number(entry.executedQty) !== Number(state.quantity) ||
      !(Number(entry.avgPrice) > 0 && Number(entry.avgPrice) <= Number(state.maxPrice))) {
    throw Error("probe_entry_not_confirmed_no_replay");
  }
  let failure;
  try {
    const position = await readPosition();
    if (!position) throw Error("probe_position_already_flat");
    await record({ positionId: positionId(position), entryOrderId: entryId,
      entryPrice: entry.avgPrice, entryConfirmedAt: new Date(clock()).toISOString() });
    if (!state.stopOrderId) {
      const orders = await api.getOpenOrders(SYMBOL);
      if (orders.length !== 1) throw Error("probe_initial_stop_count_invalid");
      const id = orderId(orders[0]);
      if (!sameOrder(orders[0], id, "STOP_MARKET", state.quantity, state.stopLoss)) {
        throw Error("probe_initial_stop_not_verified");
      }
      const parent = orders[0].mainOrderId ?? orders[0].parentOrderId;
      const pid = positionId(orders[0]);
      if (parent !== entryId && pid !== state.positionId) {
        throw Error("probe_stop_owner_not_verified");
      }
      await record({ stopOrderId: id, stop: orders[0] });
    }
    if (!state.takeAttempted) {
      const takePrice = rounded(Number(entry.avgPrice) * 1.05, state.pricePrecision, "ceil");
      await verifyStop();
      await record({ takeAttempted: true, takePrice,
        takeAttemptedAt: new Date(clock()).toISOString() });
      const result = await submitTake({
        symbol: NATIVE, side: "SELL", positionSide: "LONG",
        type: "TAKE_PROFIT_MARKET", quantity: state.quantity,
        stopPrice: takePrice, workingType: "CONTRACT_PRICE", closePosition: "true",
      }, verifyStop);
      await record({ takeOrderId: orderId(result) });
    }
    if (!state.takeOrderId) throw Error("probe_take_submission_unknown_no_replay");
    const [orders, stop, take, current] = await Promise.all([
      api.getOpenOrders(SYMBOL),
      api.queryOrder(SYMBOL, { orderId: state.stopOrderId }),
      api.queryOrder(SYMBOL, { orderId: state.takeOrderId }), readPosition(),
    ]);
    if (!current || orders.length !== 2 ||
        !sameOrder(stop, state.stopOrderId, "STOP_MARKET", state.quantity, state.stopLoss) ||
        !sameOrder(take, state.takeOrderId, "TAKE_PROFIT_MARKET", state.quantity, state.takePrice) ||
        !orders.some((row) => sameOrder(row, state.stopOrderId, "STOP_MARKET",
          state.quantity, state.stopLoss)) ||
        !orders.some((row) => sameOrder(row, state.takeOrderId, "TAKE_PROFIT_MARKET",
          state.quantity, state.takePrice))) {
      throw Error("probe_dual_orders_not_independently_verified");
    }
    await record({ phase: "dual_orders_verified", stop, take,
      dualVerifiedAt: new Date(clock()).toISOString() });
  } catch (error) {
    failure = error;
    await record({ failure: error.message });
  } finally {
    // Never remove protection before closing the exact test position.
    const remaining = await readPosition();
    if (remaining && state.positionId) {
      if (state.closeAttempted) throw Error("probe_close_unknown_no_replay");
      await record({ closeAttempted: true, closeAttemptedAt: new Date(clock()).toISOString() });
      try {
        await api.closeLong(SYMBOL, state.quantity, state.closeClientId, state.positionId,
          { automatedLongPolicy: closePolicy });
      } catch (error) {
        await record({ closeTransportError: error.message });
      }
      const close = await api.queryOrder(SYMBOL, { clientOrderId: state.closeClientId });
      if (close.status !== "FILLED" || close.side !== "SELL" ||
          close.positionSide !== "LONG" || Number(close.executedQty) !== Number(state.quantity)) {
        throw Error("probe_close_not_confirmed_no_replay");
      }
      await record({ closeOrderId: orderId(close), closePrice: close.avgPrice });
    }
    if (await readPosition()) throw Error("probe_residual_position");
    const orders = await api.getOpenOrders(SYMBOL);
    for (const row of orders) {
      const id = orderId(row);
      const known = id === state.stopOrderId || id === state.takeOrderId;
      if (!known) throw Error("probe_foreign_or_unattributed_order_not_cancelled");
      if (state.cancelAttempted?.includes(id)) throw Error("probe_cancel_unknown_no_replay");
      await record({ cancelAttempted: [...(state.cancelAttempted ?? []), id] });
      const guard = async () => {
        if (await readPosition()) throw Error("probe_cancel_requires_flat");
        const fresh = await api.queryOrder(SYMBOL, { orderId: id });
        if (!sameOrder(fresh, id, row.type, state.quantity, row.stopPrice)) {
          throw Error("probe_cancel_order_changed");
        }
      };
      await cancelProtective({ symbol: NATIVE, orderId: id }, guard);
    }
    if (await readPosition() || (await api.getOpenOrders(SYMBOL)).length) {
      throw Error("probe_cleanup_not_confirmed");
    }
    await record({ finished: true, phase: failure ? "closed_after_failure" : "completed",
      finishedAt: new Date(clock()).toISOString(), finalPositionCount: 0, finalOrderCount: 0 });
  }
  if (failure) throw failure;
  return state;
}
