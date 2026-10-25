// An explicitly owner-approved, one-position VST probe. Never used by the
// normal worker. The durable journal is required before every exchange write.
import { setTimeout as wait } from "node:timers/promises";
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

// Corroborate the actual open-order contract; do not globally rewrite LIMIT
// rows into takes. BingX's exact-ID query may return a conditional placeholder
// with LIMIT/zero price, nested takeProfit metadata and positionID:0.
export function inspectVstBracketCohort({ orders, stop, take, position, expected }) {
  const matches = (...args) => {
    try { return sameOrder(...args); } catch { return false; }
  };
  const owns = (row) => {
    const pid = positionId(row);
    if (exactId(pid)) return pid === expected.positionId;
    return (row.mainOrderId ?? row.parentOrderId) === expected.entryOrderId;
  };
  const openStop = orders.find((row) => matches(row, expected.stopOrderId,
    "STOP_MARKET", expected.quantity, expected.stopLoss) && owns(row));
  const openTake = orders.find((row) => matches(row, expected.takeOrderId,
    "TAKE_PROFIT_MARKET", expected.quantity, expected.takePrice) && owns(row));
  let conditionalPlaceholder = false;
  try {
    conditionalPlaceholder = Boolean(openTake &&
      orderId(take) === expected.takeOrderId &&
      take.symbol === NATIVE && take.side === "SELL" && take.positionSide === "LONG" &&
      take.status === "NEW" && Number(take.origQty ?? take.quantity) === Number(expected.quantity) &&
      take.type === "LIMIT" && Number(take.price) === 0 &&
      (take.stopPrice === "" || take.stopPrice === null || take.stopPrice === undefined) &&
      take.takeProfit?.type === "TAKE_PROFIT_MARKET" &&
      take.takeProfit.workingType === (expected.takeWorkingType ?? "CONTRACT_PRICE") &&
      take.workingType === take.takeProfit.workingType &&
      Number(take.positionId ?? take.positionID) === 0 &&
      Number(take.executedQty) === 0);
  } catch { /* malformed IDs never qualify as conditional placeholders */ }
  const checks = {
    position: Boolean(position && position.id === expected.positionId &&
      Number(position.quantity) === Number(expected.quantity)),
    count: orders.length === 2,
    stopQuery: matches(stop, expected.stopOrderId, "STOP_MARKET", expected.quantity, expected.stopLoss),
    takeQuery: matches(take, expected.takeOrderId, "TAKE_PROFIT_MARKET",
      expected.quantity, expected.takePrice) || conditionalPlaceholder,
    stopOpen: Boolean(openStop),
    takeOpen: Boolean(openTake),
    noForeign: orders.every((row) => {
      try { return [expected.stopOrderId, expected.takeOrderId].includes(orderId(row)); }
      catch { return false; }
    }),
  };
  const triggerBasis = {
    submitted: expected.takeWorkingType ?? "CONTRACT_PRICE",
    openOrders: openTake?.workingType ?? null,
    exactQuery: take?.workingType ?? null,
  };
  return {
    checks,
    coexistenceVerified: Object.values(checks).every(Boolean),
    takeQuerySource: conditionalPlaceholder ? "corroborated_conditional_placeholder" : "typed_order",
    triggerBasis,
    // Existence and full-quantity ownership are not proof of a disputed
    // trigger basis. Keep that separate; never silently normalize the flags.
    triggerBasisVerified: Object.values(triggerBasis).every((value) =>
      value === triggerBasis.submitted),
  };
}

export async function runControlledVstBracketProbe({
  api, submitTake, cancelProtective, save, state = null, clock = Date.now,
  makeId, closePolicy, readDelay = () => wait(300),
}) {
  if (typeof save !== "function") throw Error("probe_requires_durable_journal");
  if (state !== null && (state.version !== 1 || state.symbol !== SYMBOL ||
      !/^vbp_[a-z0-9]+$/.test(state.entryClientId ?? "") ||
      !/^vbp_[a-z0-9]+$/.test(state.closeClientId ?? ""))) {
    throw Error("invalid_probe_journal");
  }
  if (state?.finished) {
    if (state.phase !== "completed") throw Error(state.failure ?? "probe_did_not_pass");
    return state;
  }
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
  // This one documented refusal occurs before request()/transport. The
  // original implementation applied the old symmetric 10x check to BTC's
  // explicit LONG10/SHORT75 probe profile. A correction may resume ONLY the
  // same client ID, after a successful null exact-ID query and flat/no orders.
  // No ambiguous or transported attempt is ever eligible.
  if (state?.entryTransportError === "VST bounded entry preflight blocked: leverage10" &&
      !state.entrySentAt && !state.preflightRefusalCorrected) {
    const [prior, positions, orders] = await Promise.all([
      api.queryOrder(SYMBOL, { clientOrderId: state.entryClientId }),
      api.getPositions(SYMBOL), api.getOpenOrders(SYMBOL),
    ]);
    if (prior !== null || active(positions).length || orders.length) {
      throw Error("probe_pre_sign_recovery_not_proven");
    }
    await record({ preflightRefusalCorrected: true, entryTransportError: null,
      entryAttemptedAt: null, phase: "prepared" });
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
  }
  if (!state.entryAttemptedAt) {
    const filters = await api.contract(SYMBOL);
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
        onAttemptStarted: async () => record({ entrySentAt: new Date(clock()).toISOString() }),
        beforeSign: async () => {
          const [positions, orders, mode, margin, leverage] = await Promise.all([
            api.getPositions(SYMBOL), api.getOpenOrders(SYMBOL),
            api.getPositionMode(), api.getMarginType(SYMBOL), api.getLeverage(SYMBOL),
          ]);
          if (active(positions).length || orders.length || mode !== "HEDGE" ||
              margin !== "ISOLATED" || Number(leverage.longLeverage) !== 10) {
            throw Error("probe_pre_transport_state_changed");
          }
        },
      });
    } catch (error) {
      await record({ entryTransportError: error.message });
    }
  }

  // Recover by exact client ID even after an ambiguous entry acknowledgement.
  const entry = await api.queryOrder(SYMBOL, { clientOrderId: state.entryClientId });
  const entryId = orderId(entry);
  const clientIds = [entry.clientOrderId, entry.clientOrderID]
    .filter((value) => value !== undefined && value !== null && value !== "");
  if (entry.symbol !== NATIVE || entry.side !== "BUY" || entry.positionSide !== "LONG" ||
      !clientIds.length || clientIds.some((value) => value !== state.entryClientId) ||
      entry.status !== "FILLED" ||
      Number(entry.executedQty) !== Number(state.quantity) ||
      !(Number(entry.avgPrice) > 0 && Number(entry.avgPrice) <= Number(state.maxPrice))) {
    throw Error("probe_entry_not_confirmed_no_replay");
  }
  let failure;
  try {
    if (!state.closeAttempted) {
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
    for (let attempt = 0; attempt < 3; attempt++) {
      const [orders, stop, take, current] = await Promise.all([
        api.getOpenOrders(SYMBOL),
        api.queryOrder(SYMBOL, { orderId: state.stopOrderId }),
        api.queryOrder(SYMBOL, { orderId: state.takeOrderId }), readPosition(),
      ]);
      const currentPosition = current && { id: positionId(current), quantity: current.positionAmt };
      const observation = inspectVstBracketCohort({
        orders, stop, take, position: currentPosition, expected: state,
      });
      const { checks } = observation;
      // Persist both actual response cohorts before deciding; a later closed
      // history row cannot reconstruct a failed active-order observation.
      await record({ verificationReads: [...(state.verificationReads ?? []), {
        at: new Date(clock()).toISOString(), attempt, ...observation, orders, stop, take,
        position: currentPosition,
      }] });
      if (Object.values(checks).every(Boolean)) {
        await record({ phase: "dual_orders_verified", stop, take,
          coexistenceVerified: true, triggerBasisVerified: observation.triggerBasisVerified,
          dualVerifiedAt: new Date(clock()).toISOString() });
        break;
      }
      if (!checks.position || !checks.stopQuery || !checks.stopOpen || !checks.noForeign ||
          attempt === 2) throw Error("probe_dual_orders_not_independently_verified");
      // Only bounded GET confirmation while the original SL stays proven.
      // Never resubmit an order or widen a quantity/price/identity check.
      await readDelay();
    }
    }
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
      const type = id === state.stopOrderId ? "STOP_MARKET" : "TAKE_PROFIT_MARKET";
      const price = id === state.stopOrderId ? state.stopLoss : state.takePrice;
      if (state.cancelAttempted?.includes(id)) throw Error("probe_cancel_unknown_no_replay");
      await record({ cancelAttempted: [...(state.cancelAttempted ?? []), id] });
      const guard = async () => {
        if (await readPosition()) throw Error("probe_cancel_requires_flat");
        const fresh = await api.queryOrder(SYMBOL, { orderId: id });
        if (!sameOrder(fresh, id, type, state.quantity, price)) {
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
