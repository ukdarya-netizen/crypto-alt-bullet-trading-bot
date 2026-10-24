import { createHash } from "node:crypto";
import { initialPosition, evaluatePosition } from "./engine.mjs";
import { OWNER_LIVE_BASELINE } from "./live-baseline.mjs";
import { validateSignal } from "./contract.mjs";
import { positionInitialMargin } from "./bingx-live-api.mjs";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function millis(clock) {
  const value = clock();
  const result = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(result)) throw new TypeError("clock must return a valid time");
  return result;
}

function floorAtPrecision(value, places) {
  if (!Number.isInteger(places) || places < 0 || places > 12) {
    throw new Error("Exchange contract precision is invalid");
  }
  const [whole, fraction = ""] = String(value).split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) {
    throw new Error("Signal quantity is not a plain decimal");
  }
  const sized = places === 0
    ? whole
    : `${whole}.${fraction.padEnd(places, "0").slice(0, places)}`;
  return sized.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function sameNumber(left, right) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) &&
    Math.abs(a - b) <= Math.max(1e-10, Math.max(Math.abs(a), Math.abs(b)) * 1e-9);
}

function orderIdentifier(value) {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  throw new Error("Exchange order ID is missing or cannot be represented losslessly");
}

function orderIdentifierFrom(record) {
  if (typeof record?.orderID === "string" && record.orderID.trim() !== "") {
    return record.orderID;
  }
  if (record?.orderId !== undefined && record.orderId !== null) {
    return orderIdentifier(record.orderId);
  }
  if (record?.orderID !== undefined && record.orderID !== null) {
    return orderIdentifier(record.orderID);
  }
  throw new Error("Exchange order ID is missing or cannot be represented losslessly");
}

function submissionOrderIdentifier(submission) {
  try {
    return orderIdentifierFrom(submission);
  } catch (error) {
    if (submission?.orderId != null || submission?.orderID != null) throw error;
    if (submission?.id != null) return orderIdentifier(submission.id);
    throw error;
  }
}

function orderIdFor(account, environment, signalId, phase, operationKey = "") {
  const digest = createHash("sha256")
    .update(`${account}\0${environment}\0${signalId}\0${phase}\0${operationKey}`)
    .digest("hex")
    .slice(0, 24);
  return `${phase.slice(0, 7)}-${digest}`;
}

function requiredMethod(target, name) {
  if (!target || typeof target[name] !== "function") {
    throw new TypeError(`Live executor requires ${name}`);
  }
}

function positionAmount(position) {
  if (position?.positionAmt === null || position?.positionAmt === undefined ||
      position.positionAmt === "") return null;
  const amount = Number(position?.positionAmt);
  return Number.isFinite(amount) ? amount : null;
}

function liquidationPrice(position) {
  for (const key of ["liquidationPrice", "liquidation_price"]) {
    const value = Number(position?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

// Field-name resolution ("initialMargin", never "isolatedMargin") comes from
// the one shared helper in bingx-live-api.mjs -- see its comment for the
// live-verified evidence. Only the numeric parsing/validation belongs here.
function positionMargin(position) {
  const value = Number(positionInitialMargin(position));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function matchingPosition(positions, symbol) {
  const exchangeSymbol = `${symbol.slice(0, -4)}-USDT`;
  if (positions.some((row) => row?.symbol === exchangeSymbol &&
      (positionAmount(row) === null ||
        (row.positionSide === "SHORT" && positionAmount(row) !== 0) ||
        !["BOTH", "LONG", "SHORT", null, undefined].includes(row.positionSide)))) {
    throw new Error("Ambiguous same-symbol exchange exposure");
  }
  const rows = positions.filter((row) => row?.symbol === exchangeSymbol &&
    (row.positionSide === "BOTH" || row.positionSide === "LONG" || row.positionSide == null));
  if (rows.some((row) => positionAmount(row) === null)) {
    throw new Error("Exchange position amount is invalid");
  }
  const open = rows.filter((row) => positionAmount(row) !== 0);
  if (open.length > 1) throw new Error("Exchange reported multiple matching open positions");
  return open[0] ?? null;
}

function normalizeFills(fills, clientOrderId, symbol, side, orderId, startTs, endTs) {
  if (!Array.isArray(fills) || fills.length === 0) throw new Error("Exchange returned no confirmed fills");
  const exchangeSymbol = `${symbol.slice(0, -4)}-USDT`;
  const seen = new Set();
  return fills.map((fill) => {
    const tradeId = fill?.tradeId ?? fill?.tradeID ?? fill?.id;
    const quantity = fill?.qty ?? fill?.quantity;
    const price = fill?.price;
    const time = Number(fill?.time);
    if (tradeId == null || String(tradeId) === "" || seen.has(String(tradeId)) ||
        orderIdentifierFrom(fill) !== orderIdentifier(orderId) || fill?.symbol !== exchangeSymbol ||
        fill?.side !== side ||
        !Number.isFinite(Number(quantity)) || Number(quantity) <= 0 ||
        !Number.isFinite(Number(price)) || Number(price) <= 0 ||
        !Number.isSafeInteger(time) || time < startTs || time > endTs) {
      throw new Error("Exchange returned an invalid fill");
    }
    seen.add(String(tradeId));
    return {
      tradeId: String(tradeId),
      clientOrderId,
      symbol,
      side,
      quantity: String(quantity),
      price: String(price),
      ...(fill.fee == null ? {} : { fee: String(fill.fee) }),
      ...(fill.feeAsset == null ? {} : { feeAsset: String(fill.feeAsset) }),
      filledAt: new Date(time).toISOString(),
      detail: {},
    };
  });
}

function sumFillQuantity(fills) {
  return fills.reduce((total, fill) => total + Number(fill.quantity), 0);
}

function weightedFillPrice(fills) {
  const quantity = sumFillQuantity(fills);
  return fills.reduce((total, fill) => total + Number(fill.quantity) * Number(fill.price), 0) / quantity;
}

function orderStatus(order) {
  return String(order?.status ?? order?.orderStatus ?? "").toUpperCase();
}

function verifyFilledOrder(order, symbol, id, side, fills) {
  if (orderIdentifierFrom(order) !== orderIdentifier(id) ||
      order?.symbol !== `${symbol.slice(0, -4)}-USDT` ||
      order?.side !== side || !["BOTH", "LONG"].includes(order?.positionSide) ||
      orderStatus(order) !== "FILLED" ||
      !sameNumber(order.executedQty, sumFillQuantity(fills)) ||
      (order.origQty != null && !sameNumber(order.origQty, sumFillQuantity(fills)))) {
    throw new Error("Exchange order, fills, and position side do not agree");
  }
}

function safeSnapshot(position, exchangePosition, extra = {}) {
  return {
    ...position,
    ...extra,
    exchangePosition: {
      positionAmt: String(exchangePosition?.positionAmt ?? "0"),
      liquidationPrice: String(exchangePosition?.liquidationPrice ?? ""),
      ...(positionMargin(exchangePosition) == null
        ? {} : { isolatedMargin: String(positionMargin(exchangePosition)) }),
    },
  };
}

/**
 * Isolated live executor. This module is intentionally opt-in: it is not
 * imported by a runtime entry point, and live writes require a capability on
 * the executor as well as the exchange adapter's own write permission.
 *
 * This is not a recurring live service. The supervised one-shot exception
 * does not implement order cancellation before entry, automated partial takes,
 * breakeven/trailing stop replacement, or a safe cancel-and-replace protocol.
 * Those execution paths remain fail-closed; do not enable this module through
 * normal runtime configuration.
 * A deployment supplying the supervised capability must consume it atomically
 * across workers; this module only adds a per-instance replay guard.
 */
export function createLiveExecutor({
  store,
  exchange,
  account,
  environment,
  clock = Date.now,
  writeCapability = () => false,
  getConservativeAsk = null,
  supervisedOneShotCapability = () => false,
}) {
  requiredMethod(store, "withLock");
  for (const method of [
    "getControl", "halt", "claim", "hasClaim", "hasUnresolvedIntent", "reserveIntent", "markIntent", "saveFill",
    "savePosition", "commitVerifiedClose", "getPosition", "listActive", "recordEvent",
  ]) requiredMethod(store, method);
  for (const method of [
    "preflight", "contract", "getOpenOrders", "placeLong", "queryOrder", "queryFills",
    "getPositions", "reconcilePositionAndStop", "addIsolatedMargin", "closeLong",
    "assessProtectiveStopAmendment", "canVerifyAttachedProtectionOnEntry",
  ]) requiredMethod(exchange, method);
  if (typeof account !== "string" || !account.trim()) {
    throw new TypeError("An explicit account ID is required");
  }
  if (environment !== "mainnet") {
    throw new TypeError('Live executor environment must be exactly "mainnet"');
  }
  if (typeof clock !== "function" || typeof writeCapability !== "function" ||
      typeof supervisedOneShotCapability !== "function" ||
      (getConservativeAsk !== null && typeof getConservativeAsk !== "function")) {
    throw new TypeError("clock, writeCapability, and supervisedOneShotCapability must be functions; getConservativeAsk must be a function when supplied");
  }
  let supervisedOneShotConsumed = false;

  async function halt(reason, signalId = null) {
    await store.halt(reason);
    if (signalId) await store.recordEvent({
      account, environment, signalId, kind: "live_halted", detail: { reason },
    });
    return { status: "halted", reason };
  }

  async function haltWithObservedExposure(reason, signalId, position, actual) {
    await store.savePosition({
      account, environment, signalId,
      snapshot: safeSnapshot(position, actual, {
        exchangeObservation: reason,
        exchangeObservedAt: new Date(millis(clock)).toISOString(),
      }),
    });
    return halt(reason, signalId);
  }

  async function requireLiveEnabled() {
    const control = await store.getControl();
    if (!control || control.enabled !== true) {
      throw new Error(control?.blockedReason || "Live execution kill switch is on");
    }
  }

  async function requireWrite(phase) {
    if (!(await writeCapability({ account, environment, phase }))) {
      throw new Error("Live write capability was not granted");
    }
  }

  async function reserveAndMarkUnknown(signalId, phase, details, operationKey = "") {
    const clientOrderId = orderIdFor(account, environment, signalId, phase, operationKey);
    const reservation = await store.reserveIntent({
      account, environment, signalId, phase, clientOrderId, details,
    });
    if (reservation?.kind !== "new") {
      throw new Error(`Live ${phase} intent already exists; reconcile before retrying`);
    }
    await store.markIntent(clientOrderId, "unknown", { phase, reservedBeforeNetwork: true });
    return clientOrderId;
  }

  async function markReconciled(clientOrderId, detail) {
    await store.markIntent(clientOrderId, "reconciled", detail);
  }

  async function validateExchangeStop(symbol, expectedStop, orderId, stopOrderId, expectedQuantity) {
    const stopId = orderIdentifier(stopOrderId);
    const proof = await exchange.reconcilePositionAndStop(symbol, {
      expectedStopPrice: String(expectedStop),
      orderId: orderIdentifier(orderId),
      stopOrderId: stopId,
      expectedQuantity: String(expectedQuantity),
    });
    if (proof?.positionOpen !== true || proof.stopProtected !== true ||
        proof.expectedStopMatches !== true || !sameNumber(proof.stopPrice, expectedStop)) {
      throw new Error("Exchange protective stop is missing or unverified");
    }
    return proof;
  }

  async function auditFullPositionStopCoverage(symbol, {
    stopOrderId, expectedStopPrice, expectedQuantity, entryOrderId,
  }) {
    if (typeof exchange.auditProtectiveStopCoverage !== "function") {
      throw new Error("Exchange protective-stop coverage audit is unavailable");
    }
    const proof = await exchange.auditProtectiveStopCoverage(symbol, {
      stopOrderId: orderIdentifier(stopOrderId),
      expectedStopPrice: String(expectedStopPrice),
      expectedQuantity: String(expectedQuantity),
      entryOrderId: orderIdentifier(entryOrderId),
    });
    const proofStopId = proof?.protectiveStopOrderId ?? proof?.stopOrderId;
    const proofEntryId = proof?.entryOrderId;
    if (proof?.verified !== true || proof.stopProtected !== true ||
        !(proof?.closePosition === true || proof?.closePosition === "true") ||
        proof.canCoverRemainingQuantity !== true ||
        orderIdentifier(proofStopId) !== orderIdentifier(stopOrderId) ||
        proofEntryId == null || orderIdentifier(proofEntryId) !== orderIdentifier(entryOrderId) ||
        !["LONG", "BOTH"].includes(proof.positionSide) ||
        !sameNumber(proof.expectedStopPrice, expectedStopPrice) ||
        !sameNumber(proof.remainingQuantity, expectedQuantity)) {
      throw new Error("Independent full-position STOP_MARKET coverage was not verified");
    }
    return proof;
  }

  function supervisedPartialSnapshot(position, evaluated, action, exitQuantity, actual) {
    const remainingQuantity = Number(position.remainingQty) - exitQuantity;
    const policy = { ...position.liveExitPolicy };
    const targetFlag = action.reason === "strategy4_live_first_target_partial"
      ? "firstTargetExecuted"
      : action.reason === "strategy4_live_second_target_partial"
        ? "secondTargetExecuted" : null;
    if (!targetFlag || !(remainingQuantity > 0)) {
      throw new Error("Unsupported supervised partial-take action");
    }
    policy[targetFlag] = true;
    return safeSnapshot(position, actual, {
      ...position,
      remainingQty: Number(remainingQuantity.toPrecision(14)),
      coreQty: Number((Number(position.coreQty) - exitQuantity).toPrecision(14)),
      status: "open",
      coreOpen: true,
      runnerOpen: false,
      stopPrice: position.originalProtectiveStopPrice,
      liveExitPolicy: policy,
      peakPct: evaluated.next.peakPct,
      milestones: { ...evaluated.next.milestones },
      markPrice: Number(evaluated.next.markPrice ?? actual.markPrice ?? position.markPrice),
      partialTakeCount: Number(position.partialTakeCount ?? 0) + 1,
    });
  }

  async function recordFills(fills, signalId) {
    for (const fill of fills) {
      const result = await store.saveFill({
        account, environment, ...fill,
      });
      if (result?.kind !== "new" && result?.kind !== "existing") {
        throw new Error("Could not durably record an exchange fill");
      }
    }
    await store.recordEvent({
      account, environment, signalId, kind: "live_fills_recorded",
      detail: { count: fills.length },
    });
  }

  async function applyEntryProtectionTopUp({
    signalId,
    symbol,
    stopLoss,
    quantity,
    entryOrderId,
    entryClientOrderId,
    amount,
    stopBuffer,
    previousSnapshot,
  }) {
    const operationKey = `entry-protection-v1:${signalId}`;
    const oldMargin = positionMargin(previousSnapshot.exchangePosition);
    if (oldMargin == null) {
      await halt("Planned protection top-up lacks a verified pre-top-up margin baseline", signalId);
      return { status: "halted", operationId: null };
    }
    if (oldMargin + amount > 15 + 1e-9) {
      await halt("Planned protection top-up would exceed the $15 total test margin ceiling", signalId);
      return { status: "halted", operationId: null };
    }
    const control = await store.getControl();
    if (!control || control.enabled !== true) {
      await halt("Planned protection top-up blocked by live kill switch", signalId);
      return { status: "halted", operationId: null };
    }
    try {
      await requireWrite("margin");
    } catch {
      await halt("Planned protection top-up blocked by write capability", signalId);
      return { status: "halted", operationId: null };
    }
    let operationId;
    try {
      operationId = await reserveAndMarkUnknown(signalId, "margin", {
        symbol,
        amount: String(amount),
        purpose: "planned_entry_protection",
        entryClientOrderId,
      }, operationKey);
    } catch {
      await halt("Planned protection top-up intent already exists or could not be reserved", signalId);
      return { status: "halted", operationId: null };
    }

    try {
      await exchange.addIsolatedMargin(symbol, String(amount), operationId);
    } catch {
      // A timeout is ambiguous. Read-only reconciliation may preserve the
      // observed exchange facts, but this intent must never be retried.
      try {
        const observed = matchingPosition(await exchange.getPositions(symbol), symbol);
        if (observed && sameNumber(positionAmount(observed), quantity)) {
          const snapshot = safeSnapshot(previousSnapshot, observed, {
            ...previousSnapshot,
            entryOrderId,
            entryClientOrderId,
            protectionTopUpOperationId: operationId,
            protectionTopUpState: "unknown",
          });
          await store.savePosition({ account, environment, signalId, snapshot });
        }
      } catch {
        // Keep the already-durable pre-top-up exposure snapshot.
      }
      await halt("Planned protection top-up outcome is unknown", signalId);
      return { status: "halted", operationId };
    }

    try {
      const after = matchingPosition(await exchange.getPositions(symbol), symbol);
      const newMargin = positionMargin(after);
      const liq = liquidationPrice(after);
      if (!after || !sameNumber(positionAmount(after), quantity) ||
          newMargin == null || liq == null ||
          !sameNumber(newMargin - oldMargin, amount) ||
          liq + stopBuffer >= stopLoss) {
        throw new Error("post-top-up protection verification failed");
      }
      await validateExchangeStop(symbol, stopLoss, entryOrderId,
        previousSnapshot.protectiveStopOrderId, quantity);
      const snapshot = safeSnapshot(previousSnapshot, after, {
        ...previousSnapshot,
        entryOrderId,
        entryClientOrderId,
        protectionTopUpUsd: String(amount),
        protectionTopUpOperationId: operationId,
        protectionTopUpState: "verified",
        liquidationPrice: liq,
      });
      await store.savePosition({ account, environment, signalId, snapshot });
      await markReconciled(operationId, {
        status: "verified",
        amount: String(amount),
        liquidationPrice: liq,
      });
      return { status: "verified", operationId, snapshot };
    } catch {
      try {
        const observed = matchingPosition(await exchange.getPositions(symbol), symbol);
        if (observed && sameNumber(positionAmount(observed), quantity)) {
          const snapshot = safeSnapshot(previousSnapshot, observed, {
            ...previousSnapshot,
            entryOrderId,
            entryClientOrderId,
            protectionTopUpOperationId: operationId,
            protectionTopUpState: "unverified",
          });
          await store.savePosition({ account, environment, signalId, snapshot });
        }
      } catch {
        // Keep the durable pre-top-up exposure snapshot on read failure.
      }
      await halt("Planned protection top-up verification discrepancy", signalId);
      return { status: "halted", operationId };
    }
  }

  async function emergencyCloseUnprotectedEntry({
    signalId, symbol, quantity, entryOrderId, entryClientOrderId, snapshot,
  }) {
    let clientOrderId = null;
    let closeCommitted = false;
    const preserveAndHalt = async (reason, state = "unknown") => {
      let committedSnapshot = closeCommitted;
      if (!committedSnapshot && clientOrderId) {
        try {
          const durable = await store.getPosition(account, environment, signalId);
          committedSnapshot = durable?.status === "closed" &&
            durable.snapshot?.emergencyCloseClientOrderId === clientOrderId;
        } catch {
          // Continue with the conservative open/unknown snapshot below.
        }
      }
      if (!committedSnapshot) {
        try {
          const observed = matchingPosition(await exchange.getPositions(symbol), symbol);
          await store.savePosition({
            account, environment, signalId,
            snapshot: safeSnapshot(snapshot, observed, {
              ...snapshot,
              stopProof: "unverified",
              emergencyCloseState: state,
              emergencyCloseQuantity: String(quantity),
              manualInterventionRequired: true,
            }),
          });
        } catch {
          // The filled-entry snapshot and unknown intent remain durable.
        }
      }
      return halt(reason, signalId);
    };

    const control = await store.getControl();
    if (!control || control.enabled !== true) {
      return preserveAndHalt("Unprotected entry emergency close blocked by live kill switch", "not_attempted");
    }
    try {
      await requireWrite("emergency-close");
    } catch {
      return preserveAndHalt("Unprotected entry emergency close blocked by write capability", "not_attempted");
    }

    try {
      clientOrderId = await reserveAndMarkUnknown(signalId, "emergency", {
        symbol,
        quantity: String(quantity),
        purpose: "one_shot_unprotected_entry_reduce_only_close",
        entryOrderId: String(entryOrderId),
        entryClientOrderId,
        reduceOnly: true,
      }, `unprotected-entry-close-v1:${signalId}`);
    } catch {
      return preserveAndHalt("Unprotected entry emergency-close intent could not be reserved", "unknown");
    }

    let submission;
    try {
      submission = await exchange.closeLong(symbol, String(quantity), clientOrderId);
      const id = submissionOrderIdentifier(submission);
      const order = await exchange.queryOrder(symbol, id);
      const reduceOnly = order?.reduceOnly === true || order?.reduceOnly === "true";
      const omittedReduceOnlyHedgeClose = order?.positionSide === "LONG" &&
        order?.reduceOnly == null;
      if (orderStatus(order) !== "FILLED" || order?.side !== "SELL" ||
          (!reduceOnly && !omittedReduceOnlyHedgeClose) ||
          !sameNumber(order.executedQty, quantity) ||
          (order.origQty != null && !sameNumber(order.origQty, quantity))) {
        throw new Error("Emergency close was not verified as an exact-quantity reduce-only fill");
      }
      const endTs = millis(clock);
      const startTs = endTs - 60_000;
      const closeFills = normalizeFills(
        await exchange.queryFills(symbol, {
          orderId: id, startTs, endTs, currency: "USDT",
        }),
        clientOrderId, symbol, "SELL", id, startTs, endTs,
      );
      verifyFilledOrder(order, symbol, id, "SELL", closeFills);
      if (!sameNumber(sumFillQuantity(closeFills), quantity)) {
        throw new Error("Emergency close fill quantity differs from the reserved quantity");
      }
      const actual = matchingPosition(await exchange.getPositions(symbol), symbol);
      const pending = await exchange.getOpenOrders(symbol);
      if (actual || !Array.isArray(pending) || pending.length !== 0) {
        throw new Error("Emergency close did not leave a verified flat symbol with no pending orders");
      }
      await recordFills(closeFills, signalId);
      const closed = {
        ...snapshot,
        status: "closed",
        remainingQty: 0,
        coreOpen: false,
        runnerOpen: false,
        stopProof: "unverified",
        emergencyCloseOrderId: String(id),
        emergencyCloseClientOrderId: clientOrderId,
        emergencyCloseState: "verified",
        exchangePosition: { positionAmt: "0", liquidationPrice: "" },
      };
      await store.commitVerifiedClose({
        account, environment, signalId,
        clientOrderId,
        fills: closeFills,
        snapshot: closed,
        detail: {
          status: "verified_unprotected_entry_emergency_close",
          orderId: String(id),
          entryOrderId: String(entryOrderId),
          quantity: String(quantity),
        },
      });
      closeCommitted = true;
      await halt("Unprotected entry was emergency closed; operator review required", signalId);
      await markReconciled(entryClientOrderId, {
        status: "filled_then_emergency_closed",
        orderId: String(entryOrderId),
      });
      return {
        status: "halted",
        reason: "Attached protection was unverified; exact-quantity emergency close was verified and live execution halted",
        emergencyCloseOrderId: String(id),
      };
    } catch {
      return preserveAndHalt("Unprotected entry emergency-close outcome is unknown", "unknown");
    }
  }

  async function processSignal(signal) {
    return store.withLock(async () => {
      const now = millis(clock);
      if (isObject(signal) && signal.patternId === "impulse_buy") {
        return {
          status: "rejected",
          reason: "impulse_buy is disabled for live execution until its 20% runner has independently verified exchange protection",
        };
      }
      const validation = validateSignal(signal, now);
      if (validation.status !== 200) {
        return { status: "rejected", validation };
      }
      try {
        await requireLiveEnabled();
        // Persist the immutable baseline before any exchange submission.
        // Older injected test stores do not expose accounting methods.
        if (typeof store.recordBaseline === "function") {
          await store.recordBaseline({ account, environment, ...OWNER_LIVE_BASELINE });
        }
        const signalId = signal.sourceSignalId;
        if (await store.hasClaim(account, environment, signalId)) {
          return { status: "duplicate" };
        }
        const askReader = getConservativeAsk ??
          (typeof exchange.getConservativeAsk === "function"
            ? exchange.getConservativeAsk.bind(exchange) : null);
        if (!askReader) {
          return { status: "rejected", reason: "Conservative market ask unavailable; live market entry blocked" };
        }
        const askValue = await askReader(signal.symbol);
        const conservativeAsk = Number(
          isObject(askValue) ? askValue.ask ?? askValue.price : askValue,
        );
        if (!Number.isFinite(conservativeAsk) || conservativeAsk <= 0 ||
            conservativeAsk > Number(signal.referencePrice)) {
          return { status: "rejected", reason: "Market ask drifted above the approved signal price" };
        }
        const contract = await exchange.contract(signal.symbol);
        if (!Number.isInteger(contract.pricePrecision) ||
            contract.pricePrecision < 0 || contract.pricePrecision > 12) {
          return { status: "rejected", reason: "Exchange contract price precision is invalid" };
        }
        const quantity = floorAtPrecision(signal.quantity, contract.quantityPrecision);
        const amount = Number(quantity);
        const plannedEntryPrice = Number(signal.referencePrice);
        const notional = amount * conservativeAsk;
        if (!Number.isFinite(amount) || amount <= 0 ||
            amount < Number(contract.minQuantity) ||
            notional < Number(contract.minNotional) ||
            notional > 100 || amount * plannedEntryPrice > 100) {
          return { status: "rejected", reason: "Entry notional must satisfy contract minimums and stay at or below $100 at 10x" };
        }
        const preflightOptions = {
          requiredMargin: 10,
          quantity,
          entryPrice: String(conservativeAsk),
          stopLoss: String(signal.stopLoss),
        };
        const assessment = await exchange.preflight(signal.symbol, preflightOptions);
        const topUpValue = Number(assessment?.stopRisk?.plannedTopUpUsd);
        if (!assessment?.stopRisk || !Number.isFinite(topUpValue) || topUpValue < 0 ||
            assessment?.status !== "ready" || assessment.environment !== "mainnet" ||
            assessment.checks?.stopSafe !== true) {
          return { status: "rejected", reason: "Strict exchange preflight did not pass", readiness: assessment };
        }
        // Margin cannot be added to a position until it exists. Never open
        // while the submitted stop is only safe *after* a future top-up.
        if (topUpValue > 0) {
          return { status: "rejected", reason: "Entry stop needs margin before a position exists; unsafe entry blocked" };
        }
        const slippageReserve = amount * Math.max(0, plannedEntryPrice - conservativeAsk);
        const fundedMargin = 10 + topUpValue + slippageReserve;
        if (!Number.isFinite(fundedMargin) || fundedMargin > 15 + 1e-9) {
          return { status: "rejected", reason: "Total test margin including protection top-ups must not exceed $15" };
        }
        const readiness = await exchange.preflight(signal.symbol, {
          ...preflightOptions,
          // The adapter adds plannedTopUpUsd to requiredMargin itself.
          // Reserve the slippage capacity once, not the top-up twice.
          requiredMargin: 10 + slippageReserve,
        });
        if (readiness?.status !== "ready" || readiness.environment !== "mainnet" ||
            readiness.checks?.initialMargin !== true ||
            readiness.checks?.stopSafe !== true ||
            !readiness.stopRisk ||
            !sameNumber(readiness.stopRisk.plannedTopUpUsd, topUpValue)) {
          return { status: "rejected", reason: "Insufficient available USDT to fund initial margin and planned protection" };
        }
        // Recheck under the execution lock, as near to claiming/submission as
        // possible. The adapter performs this again before its own POST.
        const openOrders = await exchange.getOpenOrders(signal.symbol);
        const sameSymbolPositions = await exchange.getPositions(signal.symbol);
        if (!Array.isArray(openOrders) || openOrders.length !== 0 ||
            !Array.isArray(sameSymbolPositions) ||
            sameSymbolPositions.some((row) => row?.symbol === `${signal.symbol.slice(0, -4)}-USDT` &&
              positionAmount(row) !== 0)) {
          return { status: "rejected", reason: "Existing same-symbol position or open order blocks live entry" };
        }
        const freshNow = millis(clock);
        const freshValidation = validateSignal(signal, freshNow);
        if (freshValidation.status !== 200) {
          return { status: "rejected", validation: freshValidation };
        }
        // The normal live path stays fail-closed. Only an explicitly granted,
        // pattern-scoped one-shot experiment may proceed when the adapter has
        // a post-fill discovery route for the attached stop.
        const canVerifyOnEntry = await exchange.canVerifyAttachedProtectionOnEntry();
        let supervisedOneShot = false;
        if (signal.patternId === "liquidation_cascade" &&
            supervisedOneShotConsumed !== true) {
          supervisedOneShot = await supervisedOneShotCapability({
            account, environment, signalId, phase: "supervised-one-shot-entry",
            consume: true,
          }) === true;
          if (supervisedOneShot) supervisedOneShotConsumed = true;
        }
        if (canVerifyOnEntry !== true && !supervisedOneShot) {
          return {
            status: "rejected",
            reason: "Exchange cannot identify and verify the attached protective order before live entry",
          };
        }
        if (supervisedOneShot && readiness.checks?.marginTypeIsolated !== true) {
          return {
            status: "rejected",
            reason: "Supervised partial-take test requires exchange-verified isolated margin",
          };
        }

        await requireWrite("entry");
        const claim = await store.claim(signal, account, environment);
        if (claim?.kind !== "new") {
          return { status: claim?.kind === "duplicate" ? "duplicate" : "conflict" };
        }
        const clientOrderId = await reserveAndMarkUnknown(signalId, "entry", {
          symbol: signal.symbol,
          quantity,
          entryPrice: String(conservativeAsk),
          stopLoss: String(signal.stopLoss),
          plannedTopUpUsd: String(topUpValue),
          prefundedTopUpCapacityUsd: String(topUpValue + slippageReserve),
        });

        let submission;
        try {
          submission = await exchange.placeLong({
            symbol: signal.symbol,
            quantity,
            entryPrice: String(conservativeAsk),
            stopLoss: String(signal.stopLoss),
            clientOrderId,
          });
        } catch (error) {
          // A network timeout is not a failed order. Read by the reserved
          // client ID and snapshot exposure, but never mark it filled or retry.
          let observedOrderStatus = "unverified";
          try {
            const observedOrder = await exchange.queryOrder(signal.symbol, { clientOrderId });
            observedOrderStatus = orderStatus(observedOrder) || "unverified";
          } catch {
            // The exchange may be unreachable or may not have indexed it yet.
          }
          try {
            const observed = matchingPosition(
              await exchange.getPositions(signal.symbol), signal.symbol,
            );
            const pending = await exchange.getOpenOrders(signal.symbol);
            await store.savePosition({
              account, environment, signalId,
              snapshot: {
                sourceSignalId: signalId,
                symbol: signal.symbol,
                status: "opening",
                mode: "live",
                remainingQty: observed ? positionAmount(observed) : 0,
                entryClientOrderId: clientOrderId,
                stopProof: "unverified",
                protectionState: "unknown",
                manualInterventionRequired: true,
                exchangeOrderObservation: observedOrderStatus,
                exchangeOpenOrderCount: pending.length,
                exchangePosition: {
                  positionAmt: String(observed?.positionAmt ?? "0"),
                  liquidationPrice: String(observed?.liquidationPrice ?? ""),
                },
              },
            });
          } catch {
            try {
              await store.savePosition({
                account, environment, signalId,
                snapshot: {
                  sourceSignalId: signalId,
                  symbol: signal.symbol,
                  status: "opening",
                  mode: "live",
                  remainingQty: 0,
                  entryClientOrderId: clientOrderId,
                  stopProof: "unverified",
                  protectionState: "unknown",
                  manualInterventionRequired: true,
                  exchangeOrderObservation: observedOrderStatus,
                  exchangePosition: { positionAmt: "0", liquidationPrice: "" },
                },
              });
            } catch {
              // The reserved unknown entry intent still prevents a retry.
            }
          }
          await halt("Entry submission outcome is unknown", signalId);
          return { status: "unknown", clientOrderId };
        }

        try {
          const id = submissionOrderIdentifier(submission);
          const order = await exchange.queryOrder(signal.symbol, id);
          if (orderStatus(order) !== "FILLED") throw new Error("Entry order was not completely FILLED");
          const fillStart = freshNow - 5000;
          const fillEnd = millis(clock);
          const fills = normalizeFills(
            await exchange.queryFills(signal.symbol, {
              orderId: id, startTs: fillStart,
              endTs: fillEnd, currency: "USDT",
            }),
            clientOrderId, signal.symbol, "BUY", id, fillStart, fillEnd,
          );
          verifyFilledOrder(order, signal.symbol, id, "BUY", fills);
          const filledQuantity = sumFillQuantity(fills);
          const actualPrice = weightedFillPrice(fills);
          const discrepancies = [];
          if (!sameNumber(filledQuantity, amount)) {
            discrepancies.push("entry_fill_quantity_differs_from_reserved_order");
          }
          if (!(actualPrice > Number(signal.stopLoss))) discrepancies.push("entry_at_or_below_stop");
          if (actualPrice > plannedEntryPrice || amount * actualPrice > 100) {
            discrepancies.push("market_price_exceeded_approved_notional");
          }
          const actualTopUp = topUpValue +
            amount * Math.max(0, actualPrice - conservativeAsk);
          const prefundedTopUpCapacity = topUpValue + slippageReserve;
          if (actualTopUp > prefundedTopUpCapacity + 1e-9) {
            discrepancies.push("actual_fill_exceeds_prefunded_protection");
          }
          const positions = await exchange.getPositions(signal.symbol);
          const livePosition = matchingPosition(positions, signal.symbol);
          if (!livePosition) {
            discrepancies.push("exchange_position_missing");
          } else if (!sameNumber(positionAmount(livePosition), filledQuantity)) {
            discrepancies.push("exchange_quantity_differs_from_confirmed_fills");
          }
          const liq = liquidationPrice(livePosition);
          if (supervisedOneShot &&
              (positionMargin(livePosition) == null || positionMargin(livePosition) <= 0 ||
               positionMargin(livePosition) > 15 + 1e-9)) {
            discrepancies.push("supervised_test_isolated_margin_unverified_or_over_limit");
          }
          const stopBuffer = Math.max(actualPrice * 0.005, 10 ** -contract.pricePrecision);
          if (actualTopUp === 0 &&
              (liq == null || Number(signal.stopLoss) < liq + stopBuffer)) {
            discrepancies.push("protective_stop_inside_liquidation_buffer");
          }
          let stopVerified = false;
          let protectiveStopOrderId = null;
          if (supervisedOneShot) {
            try {
              if (typeof exchange.discoverAttachedStop !== "function") {
                throw new Error("Post-fill attached-stop discovery is not implemented");
              }
              const discovered = await exchange.discoverAttachedStop(signal.symbol, {
                entryOrderId: String(id),
                expectedStopPrice: String(signal.stopLoss),
                expectedQuantity: String(filledQuantity),
              });
              protectiveStopOrderId = orderIdentifier(
                discovered?.protectiveStopOrderId ?? discovered?.stopOrderId ??
                discovered?.orderId ?? discovered?.orderID,
              );
              await validateExchangeStop(signal.symbol, signal.stopLoss, id,
                protectiveStopOrderId, filledQuantity);
              stopVerified = true;
            } catch {
              discrepancies.push("protective_stop_unverified");
            }
          } else {
            try {
              protectiveStopOrderId = orderIdentifier(submission?.protectiveStopOrderId);
            } catch {
              // An unrepresentable stop ID cannot be persisted as identity proof.
            }
            try {
              if (protectiveStopOrderId == null) throw new Error("Protective order identity missing");
              await validateExchangeStop(signal.symbol, signal.stopLoss, id,
                protectiveStopOrderId, filledQuantity);
              stopVerified = true;
            } catch {
              discrepancies.push("protective_stop_unverified");
            }
          }
          await recordFills(fills, signalId);
          const actualQuantity = livePosition && positionAmount(livePosition) > 0
            ? positionAmount(livePosition) : filledQuantity;
          let snapshot;
          try {
            if (!(actualPrice > Number(signal.stopLoss))) throw new Error("invalid actual entry");
            const position = initialPosition(signal, {
              price: actualPrice,
              quantity: actualQuantity,
              at: freshNow,
              mode: "live",
            });
            snapshot = safeSnapshot(position, livePosition, {
              entryOrderId: String(id),
              entryClientOrderId: clientOrderId,
              ...(protectiveStopOrderId == null ? {} : {
                protectiveStopOrderId,
              }),
              ...(supervisedOneShot ? {
                supervisedPartialTakeMode: true,
                originalProtectiveStopPrice: Number(signal.stopLoss),
                partialTakeCount: 0,
              } : {}),
              stopProof: stopVerified ? "active_open_protective_order" : "unverified",
              liquidationPrice: liq ?? 0,
              markPrice: Number(livePosition?.markPrice) > 0
                ? Number(livePosition.markPrice) : actualPrice,
            });
          } catch {
            snapshot = {
              sourceSignalId: signalId,
              symbol: signal.symbol,
              status: "opening",
              mode: "live",
              quantity: actualQuantity,
              remainingQty: actualQuantity,
              entryPrice: actualPrice,
              entryAt: new Date(freshNow).toISOString(),
              entryOrderId: String(id),
              entryClientOrderId: clientOrderId,
              ...(protectiveStopOrderId == null ? {} : {
                protectiveStopOrderId,
              }),
              ...(supervisedOneShot ? {
                supervisedPartialTakeMode: true,
                originalProtectiveStopPrice: Number(signal.stopLoss),
                partialTakeCount: 0,
              } : {}),
              stopPrice: Number(signal.stopLoss),
              stopProof: "unverified",
              exchangePosition: {
                positionAmt: String(livePosition?.positionAmt ?? "0"),
                liquidationPrice: liq == null ? "" : String(liq),
              },
            };
          }
          await store.savePosition({ account, environment, signalId, snapshot });
           // Freeze the opening allocation from the bot's verified isolated
           // position, not from the shared account's later margin balance.
           if (positionMargin(livePosition) > 0 && typeof store.recordInitialAllocation === "function") {
             await store.recordInitialAllocation({
               account, environment, signalId,
               marginUsdt: String(positionMargin(livePosition)),
               entryAt: snapshot.entryAt,
             });
           }
          if (discrepancies.length) {
            if (supervisedOneShot &&
                discrepancies.includes("protective_stop_unverified") && livePosition &&
                Number.isFinite(positionAmount(livePosition)) &&
                positionAmount(livePosition) > 0) {
              return emergencyCloseUnprotectedEntry({
                signalId, symbol: signal.symbol,
                quantity: String(positionAmount(livePosition)),
                entryOrderId: String(id), entryClientOrderId: clientOrderId,
                snapshot,
              });
            }
            if (discrepancies.includes("protective_stop_unverified")) {
              snapshot = {
                ...snapshot,
                protectionState: "unknown",
                manualInterventionRequired: true,
              };
              await store.savePosition({ account, environment, signalId, snapshot });
            }
            await halt("Entry verification discrepancy", signalId);
            return { status: "halted", reason: "Entry verification discrepancy", clientOrderId };
          }
           // Pre-entry symbol/order checks and the post-fill quantity check
           // establish the starting boundary for later read-only funding audits.
           snapshot = {
             ...snapshot, fundingIsolationAtEntry: true,
             fundingIsolationStartedAt: new Date(freshNow).toISOString(),
           };
           await store.savePosition({ account, environment, signalId, snapshot });
          await markReconciled(clientOrderId, {
            orderId: String(id), status: "FILLED", quantity: String(actualQuantity),
            actualEntryPrice: actualPrice,
          });
          if (actualTopUp > 0) {
            const protectionResult = await applyEntryProtectionTopUp({
              signalId,
              symbol: signal.symbol,
              stopLoss: Number(signal.stopLoss),
              quantity: actualQuantity,
              entryOrderId: String(id),
              entryClientOrderId: clientOrderId,
              amount: actualTopUp,
              stopBuffer,
              previousSnapshot: snapshot,
            });
            if (protectionResult.status !== "verified") {
              return {
                status: "halted",
                reason: "Planned protective margin top-up was not verified",
                clientOrderId,
                topUpOperationId: protectionResult.operationId,
              };
            }
            snapshot = protectionResult.snapshot;
          }
          return { status: "opened", signalId, clientOrderId, entryPrice: actualPrice, quantity };
        } catch (error) {
          // A filled entry may exist even if a later read failed. Preserve
          // observed exposure without inventing a confirmed strategy result.
          try {
            const existing = await store.getPosition(account, environment, signalId);
            if (existing?.status !== "closed") {
              let observed = null;
              try {
                observed = matchingPosition(
                  await exchange.getPositions(signal.symbol), signal.symbol,
                );
              } catch {
                // Keep existing exchange evidence, if any, and flag manual review.
              }
              const existingSnapshot = existing?.snapshot ?? {};
              await store.savePosition({
                account, environment, signalId,
                snapshot: {
                  ...existingSnapshot,
                  sourceSignalId: signalId,
                  symbol: signal.symbol,
                  status: existingSnapshot.status ?? "opening",
                  mode: "live",
                  remainingQty: observed ? positionAmount(observed) :
                    (existingSnapshot.remainingQty ?? 0),
                  entryOrderId: existingSnapshot.entryOrderId ?? (() => {
                    try { return submissionOrderIdentifier(submission); } catch { return ""; }
                  })(),
                  entryClientOrderId: clientOrderId,
                  stopProof: "unverified",
                  protectionState: "unknown",
                  manualInterventionRequired: true,
                  exchangePosition: observed
                    ? {
                      positionAmt: String(observed.positionAmt),
                      liquidationPrice: String(observed.liquidationPrice ?? ""),
                    }
                    : (existingSnapshot.exchangePosition ??
                      { positionAmt: "0", liquidationPrice: "" }),
                },
              });
            }
          } catch {
            // Keep the durable unknown intent and kill switch if reads fail.
          }
          await halt("Entry verification discrepancy", signalId);
          return { status: "halted", reason: error.message, clientOrderId };
        }
      } catch (error) {
        return { status: "rejected", reason: error.message };
      }
    });
  }

  async function reconcilePosition(signalId, observedPrice) {
    return store.withLock(async () => {
      try {
        const current = await store.getPosition(account, environment, signalId);
        if (!current || current.status !== "open" || current.snapshot?.mode !== "live") {
          return { status: "not_found" };
        }
        const position = current.snapshot;
        const positions = await exchange.getPositions(position.symbol);
        const actual = matchingPosition(positions, position.symbol);
        if (await store.hasUnresolvedIntent(account, environment, signalId, "entry") ||
            await store.hasUnresolvedIntent(account, environment, signalId, "margin")) {
          return haltWithObservedExposure(
            "Entry or margin intent is unresolved; manual exchange reconciliation required",
            signalId, position, actual,
          );
        }
        if (!actual) {
          if (await store.hasUnresolvedIntent(account, environment, signalId, "exit")) {
            return haltWithObservedExposure(
              "Position is flat but an own exit is unresolved; manual order/fill reconciliation required",
              signalId, position, null,
            );
          }
          const startTs = Date.parse(position.entryAt);
          const endTs = millis(clock);
          if (!Number.isSafeInteger(startTs) || startTs <= 0 || startTs > endTs) {
            return haltWithObservedExposure("Cannot bound external-close fill history", signalId, position, null);
          }
          let exitRows;
          try {
            exitRows = await exchange.queryFills(position.symbol, {
              startTs, endTs, currency: "USDT",
            });
          } catch {
            return haltWithObservedExposure(
              "External-close fill history unavailable; exchange outcome unknown",
              signalId, position, null,
            );
          }
          if (!Array.isArray(exitRows)) {
            return haltWithObservedExposure("Exchange returned invalid fills while reconciling an external close", signalId, position, null);
          }
          const seenHistory = new Set();
          if (exitRows.some((fill) => {
            const id = fill?.tradeId ?? fill?.tradeID ?? fill?.id;
            const time = Number(fill?.time);
            const quantity = Number(fill?.qty ?? fill?.quantity);
            const price = Number(fill?.price);
            let fillOrderId;
            try {
              fillOrderId = orderIdentifierFrom(fill);
            } catch {
              return true;
            }
            if (fill?.symbol !== `${position.symbol.slice(0, -4)}-USDT` ||
                id == null || String(id) === "" ||
                seenHistory.has(String(id)) ||
                !Number.isSafeInteger(time) || time < startTs || time > endTs ||
                !Number.isFinite(quantity) || quantity <= 0 ||
                !Number.isFinite(price) || price <= 0) return true;
            seenHistory.add(String(id));
            return fill.side !== "SELL" &&
              !(fill.side === "BUY" &&
                fillOrderId === orderIdentifier(position.entryOrderId));
          })) {
            return haltWithObservedExposure("Unattributable same-symbol fills after entry", signalId, position, null);
          }
          const sellRows = exitRows.filter((fill) =>
            fill?.side === "SELL");
          const grouped = new Map();
          for (const fill of sellRows) {
            const id = orderIdentifierFrom(fill);
            if (!grouped.has(id)) grouped.set(id, []);
            grouped.get(id).push(fill);
          }
          if (sellRows.length === 0 ||
              !sameNumber(sellRows.reduce((total, fill) =>
                total + Number(fill.qty ?? fill.quantity), 0), position.remainingQty)) {
            return haltWithObservedExposure("Exchange position disappeared without exact attributable exit fills; possible liquidation", signalId, position, null);
          }
          const verifiedFills = [];
          for (const [id, rows] of grouped) {
            try {
              const order = await exchange.queryOrder(position.symbol, id);
              const normalized = normalizeFills(
                rows, orderIdFor(account, environment, signalId, "external"),
                position.symbol, "SELL", id, startTs, endTs,
              );
              verifyFilledOrder(order, position.symbol, id, "SELL", normalized);
              if (order.positionSide === "BOTH" &&
                  order.reduceOnly !== true && order.reduceOnly !== "true" &&
                  order.closePosition !== true && order.closePosition !== "true") {
                throw new Error("One-way external close is not reduce-only");
              }
              verifiedFills.push(...normalized);
            } catch {
              return haltWithObservedExposure("External exit order/fill reconciliation failed", signalId, position, null);
            }
          }
          let pending;
          try {
            pending = await exchange.getOpenOrders(position.symbol);
          } catch {
            return haltWithObservedExposure(
              "External close pending-order read failed", signalId, position, null,
            );
          }
          if (new Set(verifiedFills.map((fill) => fill.tradeId)).size !== verifiedFills.length ||
              !sameNumber(sumFillQuantity(verifiedFills), position.remainingQty) ||
              !Array.isArray(pending) || pending.length !== 0) {
            return haltWithObservedExposure("External close has conflicting fills or pending orders", signalId, position, null);
          }
          if (await store.hasUnresolvedIntent(account, environment, signalId, "external")) {
            return haltWithObservedExposure("Previous external-close reconciliation is unresolved", signalId, position, null);
          }
          const operationId = await reserveAndMarkUnknown(signalId, "external", {
            symbol: position.symbol, quantity: String(position.remainingQty),
          });
          const closed = {
            ...position,
            status: "closed",
            remainingQty: 0,
            coreOpen: false,
            runnerOpen: false,
            externalClose: true,
            externalExitOrderIds: [...grouped.keys()],
            exchangePosition: { positionAmt: "0", liquidationPrice: "" },
          };
          await store.commitVerifiedClose({
            account, environment, signalId, clientOrderId: operationId,
            fills: verifiedFills, snapshot: closed,
            detail: {
              status: "verified_external_close",
              exitOrderIds: [...grouped.keys()],
              fillCount: verifiedFills.length,
            },
          });
          return { status: "closed_external", position: closed };
        }
        if (!sameNumber(position.remainingQty, positionAmount(actual))) {
          return haltWithObservedExposure(
            "Exchange quantity differs from the durable live position; possible partial close or liquidation",
            signalId, position, actual,
          );
        }
        if (position.supervisedPartialTakeMode === true &&
            (!sameNumber(position.stopPrice, position.originalProtectiveStopPrice) ||
             !Number.isFinite(Number(position.originalProtectiveStopPrice)))) {
          return haltWithObservedExposure(
            "Supervised partial-take state does not preserve the original protective stop",
            signalId, position, actual,
          );
        }
        const stop = position.runnerOpen ? position.runnerStopPrice : position.stopPrice;
        const filters = await exchange.contract(position.symbol);
        const liq = liquidationPrice(actual);
        const buffer = Math.max(Number(position.entryPrice) * 0.005,
          10 ** -filters.pricePrecision);
        if (liq == null || !Number.isFinite(buffer) || liq + buffer >= Number(stop)) {
          return haltWithObservedExposure(
            "Exchange liquidation price no longer supports the protective stop",
            signalId, position, actual,
          );
        }
        try {
          await validateExchangeStop(position.symbol, stop, position.entryOrderId,
            position.protectiveStopOrderId, position.remainingQty);
        } catch (error) {
          return halt("Protective-stop discrepancy", signalId);
        }
        if (observedPrice === undefined || !Number.isFinite(Number(observedPrice)) ||
            Number(observedPrice) <= 0) {
          return { status: "reconciled", position };
        }

        const evaluated = evaluatePosition(position, {
          price: Number(observedPrice), at: millis(clock),
        });
        if (position.supervisedPartialTakeMode === true) {
          const partials = evaluated.actions.filter((action) =>
            action.type === "close_partial");
          const preserveAndHaltPartial = async (reason) => {
            try {
              const observed = matchingPosition(
                await exchange.getPositions(position.symbol), position.symbol,
              );
              await store.savePosition({
                account, environment, signalId,
                snapshot: safeSnapshot(position, observed, {
                  ...position,
                  exchangeObservation: "supervised_partial_take_unverified",
                  exchangeObservedAt: new Date(millis(clock)).toISOString(),
                  partialTakeState: "unknown",
                  manualInterventionRequired: true,
                }),
              });
            } catch {
              // Keep the original exposure and unresolved order intent durable.
            }
            return halt(reason, signalId);
          };
          if (partials.length > 0) {
            const action = partials[0];
            if (![
              "strategy4_live_first_target_partial",
              "strategy4_live_second_target_partial",
            ].includes(action.reason) || Number(position.partialTakeCount ?? 0) >= 2) {
              return halt("Supervised liquidation-cascade mode permits only its two partial takes", signalId);
            }
            if (await store.hasUnresolvedIntent(account, environment, signalId, "exit")) {
              return halt("Previous exit outcome is unresolved; do not submit another order", signalId);
            }
            let isolatedMode;
            const beforeMargin = positionMargin(actual);
            let beforeCoverage;
            try {
              if (typeof exchange.getMarginType !== "function") {
                throw new Error("Isolated margin mode cannot be reverified");
              }
              isolatedMode = await exchange.getMarginType(position.symbol);
              if (isolatedMode !== "ISOLATED" || beforeMargin == null ||
                  beforeMargin <= 0 || beforeMargin > 15 + 1e-9) {
                throw new Error("Isolated margin or the $15 test ceiling is not verified");
              }
              beforeCoverage = await auditFullPositionStopCoverage(position.symbol, {
                stopOrderId: position.protectiveStopOrderId,
                expectedStopPrice: position.originalProtectiveStopPrice,
                expectedQuantity: position.remainingQty,
                entryOrderId: position.entryOrderId,
              });
            } catch {
              return preserveAndHaltPartial(
                "Partial take blocked: independently verified full-position stop coverage is unavailable",
              );
            }
            const exitQuantity = Number(action.quantity);
            if (!Number.isFinite(exitQuantity) || exitQuantity <= 0 ||
                exitQuantity >= Number(position.remainingQty)) {
              return halt("Supervised partial-take quantity is invalid", signalId);
            }
            const control = await store.getControl();
            if (!control || control.enabled !== true) {
              return {
                status: "blocked",
                reason: "Live kill switch is on; no supervised partial take was submitted",
              };
            }
            try {
              await requireWrite("exit");
            } catch {
              return { status: "blocked", reason: "Supervised partial take lacks write capability" };
            }
            let clientOrderId;
            try {
              clientOrderId = await reserveAndMarkUnknown(signalId, "exit", {
                symbol: position.symbol,
                quantity: String(exitQuantity),
                reason: action.reason,
                entryOrderId: position.entryOrderId,
                protectiveStopOrderId: position.protectiveStopOrderId,
                originalStopPrice: String(position.originalProtectiveStopPrice),
                supervisedPartialTake: true,
              }, `supervised-partial-v1:${action.reason}`);
            } catch {
              return halt("Supervised partial-take intent could not be reserved", signalId);
            }
            try {
              const submission = await exchange.closeLong(
                position.symbol, String(exitQuantity), clientOrderId,
              );
              const id = submissionOrderIdentifier(submission);
              const order = await exchange.queryOrder(position.symbol, id);
              const exactClientOrderId = order?.clientOrderId ?? order?.clientOrderID;
              const reduceOnly = order?.reduceOnly === true || order?.reduceOnly === "true";
              if (exactClientOrderId !== clientOrderId ||
                  orderStatus(order) !== "FILLED" ||
                  order?.side !== "SELL" ||
                  !["LONG", "BOTH"].includes(order?.positionSide) ||
                  order.positionSide !== beforeCoverage.positionSide ||
                  (order.positionSide === "BOTH" && !reduceOnly) ||
                  !sameNumber(order.executedQty, exitQuantity) ||
                  !sameNumber(order.origQty, exitQuantity)) {
                throw new Error("Partial-take order identity, side, or quantity is not exact");
              }
              const fillEnd = millis(clock);
              const fillStart = fillEnd - 60_000;
              const fills = normalizeFills(
                await exchange.queryFills(position.symbol, {
                  orderId: id, startTs: fillStart, endTs: fillEnd, currency: "USDT",
                }),
                clientOrderId, position.symbol, "SELL", id, fillStart, fillEnd,
              );
              verifyFilledOrder(order, position.symbol, id, "SELL", fills);
              if (!sameNumber(sumFillQuantity(fills), exitQuantity)) {
                throw new Error("Partial-take fill quantity differs from the exact order quantity");
              }
              const remaining = matchingPosition(
                await exchange.getPositions(position.symbol), position.symbol,
              );
              const expectedRemaining = Number(position.remainingQty) - exitQuantity;
              if (!remaining || !sameNumber(positionAmount(remaining), expectedRemaining) ||
                  positionMargin(remaining) == null || positionMargin(remaining) <= 0 ||
                  positionMargin(remaining) > 15 + 1e-9 ||
                  await exchange.getMarginType(position.symbol) !== "ISOLATED") {
                throw new Error("Partial-take remaining isolated position is not exact");
              }
              await auditFullPositionStopCoverage(position.symbol, {
                stopOrderId: position.protectiveStopOrderId,
                expectedStopPrice: position.originalProtectiveStopPrice,
                expectedQuantity: String(expectedRemaining),
                entryOrderId: position.entryOrderId,
              });
              const next = supervisedPartialSnapshot(
                position, evaluated, action, exitQuantity, remaining,
              );
              next.exitOrderId = String(id);
              next.exitClientOrderId = clientOrderId;
              next.partialTakeState = "verified";
              await recordFills(fills, signalId);
              await store.savePosition({ account, environment, signalId, snapshot: next });
              await markReconciled(clientOrderId, {
                orderId: String(id),
                clientOrderId,
                status: "verified_partial_take",
                quantity: String(exitQuantity),
                remainingQuantity: String(expectedRemaining),
                protectiveStopOrderId: position.protectiveStopOrderId,
                stopPrice: String(position.originalProtectiveStopPrice),
              });
              return { status: "partially_closed", position: next, exitOrderId: String(id) };
            } catch {
              return preserveAndHaltPartial(
                "Supervised partial-take verification discrepancy; exposure and unresolved intent preserved",
              );
            }
          }
          if (evaluated.actions.some((action) =>
            action.type === "close_all" &&
            action.reason === "strategy4_live_final_target_close")) {
            // A target close is allowed only after the two preceding partials;
            // retain the exchange-installed floor in persisted state and never
            // turn an accompanying engine raise into a stop amendment.
            evaluated.next.stopPrice = position.originalProtectiveStopPrice;
          }
          if (evaluated.actions.length > 0 &&
              evaluated.actions.every((action) => action.type === "raise_stop")) {
            const unchangedStop = safeSnapshot(evaluated.next, actual, {
              ...position,
              stopPrice: position.originalProtectiveStopPrice,
              markPrice: Number(observedPrice),
            });
            await store.savePosition({
              account, environment, signalId, snapshot: unchangedStop,
            });
            return { status: "updated", position: unchangedStop };
          }
        }
        // The engine may propose multiple target exits on one quote, including
        // a final close of only the remaining 50%. Never filter out the partials
        // and accidentally submit that residual quantity as a full-position exit.
        // A runner exit likewise needs its own verified remaining-stop protocol.
        if (evaluated.actions.some((action) =>
          !["raise_stop", "close_all", "close_core"].includes(action.type)) ||
          evaluated.actions.filter((action) => action.type !== "raise_stop").length > 1) {
          return halt("Live partial/runner exit requires verified fill and continuous stop coverage", signalId);
        }
        const supervisedFinalTarget = position.supervisedPartialTakeMode === true &&
          evaluated.actions.some((action) =>
            action.type === "close_all" &&
            action.reason === "strategy4_live_final_target_close");
        if (evaluated.actions.some((action) => action.type === "raise_stop") &&
            !supervisedFinalTarget) {
          const raises = evaluated.actions.filter((action) => action.type === "raise_stop");
          if (raises.length !== 1) return halt("Ambiguous protective stop amendment", signalId);
          let assessment;
          try {
            assessment = await exchange.assessProtectiveStopAmendment(position.symbol, {
              stopOrderId: position.protectiveStopOrderId,
              entryOrderId: position.entryOrderId,
              expectedStopPrice: String(stop),
              expectedQuantity: String(position.remainingQty),
              nextStopPrice: String(raises[0].stopPrice),
            });
          } catch {
            return halt("Protective stop audit failed; no amendment submitted", signalId);
          }
          // There is intentionally no write path: BingX can cancel the old
          // stop even when its cancelReplace replacement fails.
          return halt(`Protective stop amendment blocked: ${assessment?.reason ?? "unverified"}`, signalId);
        }
        const closes = evaluated.actions.filter((action) =>
          action.type === "close_all" || action.type === "close_core");
        if (closes.length === 0) {
          const refreshed = safeSnapshot(evaluated.next, actual, {
            ...position,
            markPrice: Number(observedPrice),
          });
          await store.savePosition({ account, environment, signalId, snapshot: refreshed });
          return { status: "updated", position: refreshed };
        }
        if (closes.length !== 1 || evaluated.next.status !== "closed") {
          return halt("Exit plan requires unsupported partial close or stop amendment", signalId);
        }
        const exitQty = Number(closes[0].quantity);
        if (supervisedFinalTarget) {
          try {
            if (typeof exchange.getMarginType !== "function" ||
                await exchange.getMarginType(position.symbol) !== "ISOLATED" ||
                positionMargin(actual) == null || positionMargin(actual) <= 0 ||
                positionMargin(actual) > 15 + 1e-9 ||
                !sameNumber(exitQty, position.remainingQty)) {
              throw new Error("Final target lacks exact isolated exposure within the test margin ceiling");
            }
          } catch {
            return haltWithObservedExposure(
              "Supervised final target is not verified as an exact isolated full close",
              signalId, position, actual,
            );
          }
        }
        if (await store.hasUnresolvedIntent(account, environment, signalId, "exit")) {
          return halt("Previous exit outcome is unresolved; do not submit another order", signalId);
        }
        const control = await store.getControl();
        if (!control || control.enabled !== true) {
          return {
            status: "blocked",
            reason: "Live kill switch is on; existing exposure was reconciled without submitting an exit",
          };
        }
        await requireWrite("exit");
        const clientOrderId = await reserveAndMarkUnknown(signalId, "exit", {
          symbol: position.symbol, quantity: String(exitQty), reason: closes[0].reason,
        });
        let submission;
        try {
          submission = await exchange.closeLong(position.symbol, String(exitQty), clientOrderId);
        } catch (error) {
          try {
            const observed = matchingPosition(
              await exchange.getPositions(position.symbol), position.symbol,
            );
            const pending = await exchange.getOpenOrders(position.symbol);
            await store.savePosition({
              account, environment, signalId,
              snapshot: safeSnapshot(position, observed, {
                exchangeObservation: "own_exit_submission_unknown",
                exchangeOpenOrderCount: pending.length,
                exchangeObservedAt: new Date(millis(clock)).toISOString(),
              }),
            });
          } catch {
            // Keep the unknown intent and do not infer a completed exit.
          }
          return halt("Exit submission outcome is unknown", signalId);
        }
        try {
          const id = submissionOrderIdentifier(submission);
          const order = await exchange.queryOrder(position.symbol, id);
          if (orderStatus(order) !== "FILLED") throw new Error("Exit order was not completely FILLED");
          if (supervisedFinalTarget) {
            const exactClientOrderId = order?.clientOrderId ?? order?.clientOrderID;
            const reduceOnly = order?.reduceOnly === true || order?.reduceOnly === "true";
            const expectedSide = actual.positionSide === "LONG" ? "LONG" : "BOTH";
            if (exactClientOrderId !== clientOrderId ||
                order?.side !== "SELL" || order.positionSide !== expectedSide ||
                (expectedSide === "BOTH" && !reduceOnly) ||
                !sameNumber(order.executedQty, exitQty) ||
                !sameNumber(order.origQty, exitQty)) {
              throw new Error("Final-target close order identity or quantity is not exact");
            }
          }
          const fillStart = millis(clock) - 60_000;
          const fillEnd = millis(clock);
          const fills = normalizeFills(
            await exchange.queryFills(position.symbol, {
              orderId: id,
              startTs: fillStart,
              endTs: fillEnd,
              currency: "USDT",
            }),
            clientOrderId, position.symbol, "SELL", id, fillStart, fillEnd,
          );
          verifyFilledOrder(order, position.symbol, id, "SELL", fills);
          if (!sameNumber(sumFillQuantity(fills), exitQty)) {
            throw new Error("Exit fill quantity differs from the reserved exit quantity");
          }
          const remaining = matchingPosition(await exchange.getPositions(position.symbol), position.symbol);
          if (remaining) throw new Error("Exchange position remains after confirmed full exit");
          const pending = await exchange.getOpenOrders(position.symbol);
          if (!Array.isArray(pending) || pending.length !== 0) {
            throw new Error("Exchange still has same-symbol orders after full exit");
          }
          const next = {
            ...evaluated.next,
            exitOrderId: String(id),
            exitClientOrderId: clientOrderId,
            markPrice: Number(observedPrice),
            exchangePosition: { positionAmt: "0", liquidationPrice: "" },
          };
          await store.commitVerifiedClose({
            account, environment, signalId, clientOrderId,
            fills, snapshot: next,
            detail: { orderId: String(id), status: "FILLED" },
          });
          return { status: "closed", position: next };
        } catch (error) {
          try {
            const observed = matchingPosition(
              await exchange.getPositions(position.symbol), position.symbol,
            );
            const pending = await exchange.getOpenOrders(position.symbol);
            await store.recordEvent({
              account, environment, signalId, kind: "live_exit_unknown_observation",
              detail: {
                positionAmt: String(observed?.positionAmt ?? "0"),
                pendingOrderCount: pending.length,
              },
            });
          } catch {
            // Never overwrite a close if the transaction committed before a
            // lost DB acknowledgement. The unknown intent blocks repeats.
          }
          return halt("Exit verification discrepancy", signalId);
        }
      } catch (error) {
        return halt("Live exposure reconciliation failed; exchange outcome is unknown", signalId);
      }
    });
  }

  async function addIsolatedMargin(signalId, amount, operationKey) {
    return store.withLock(async () => {
      try {
        await requireLiveEnabled();
        if (typeof operationKey !== "string" || operationKey.trim() === "") {
          return { status: "rejected", reason: "A stable margin operation key is required" };
        }
        operationKey = operationKey.trim();
        const value = Number(amount);
        if (!Number.isFinite(value) || value <= 0) {
          return { status: "rejected", reason: "Margin amount must be positive" };
        }
        const current = await store.getPosition(account, environment, signalId);
        if (!current || current.status !== "open" || current.snapshot?.mode !== "live") {
          return { status: "rejected", reason: "No open live position for margin top-up" };
        }
        const position = current.snapshot;
        const readiness = await exchange.preflight(position.symbol, { requiredMargin: value });
        if (readiness?.environment !== "mainnet" ||
            readiness?.checks?.initialMargin !== true) {
          return { status: "rejected", reason: "Insufficient available USDT for margin top-up" };
        }
        const before = matchingPosition(await exchange.getPositions(position.symbol), position.symbol);
        if (!before || !sameNumber(position.remainingQty, positionAmount(before))) {
          return halt("Exchange position discrepancy before margin top-up", signalId);
        }
        const oldMargin = positionMargin(before);
        const oldLiq = liquidationPrice(before);
        if (oldMargin == null || oldLiq == null) {
          return halt("Exchange did not provide verifiable isolated margin and liquidation price", signalId);
        }
        if (oldMargin + value > 15 + 1e-9) {
          return { status: "rejected", reason: "Total test margin including top-ups must not exceed $15" };
        }
        try {
          await validateExchangeStop(position.symbol,
            position.runnerOpen ? position.runnerStopPrice : position.stopPrice,
            position.entryOrderId, position.protectiveStopOrderId, position.remainingQty);
        } catch (error) {
          return halt("Protective-stop discrepancy before margin top-up", signalId);
        }

        await requireWrite("margin");
        const operationId = await reserveAndMarkUnknown(signalId, "margin", {
          symbol: position.symbol, amount: String(value),
        }, operationKey);
        try {
          await exchange.addIsolatedMargin(position.symbol, String(value), operationId);
        } catch (error) {
          return halt("Margin top-up outcome is unknown", signalId);
        }
        try {
          const after = matchingPosition(await exchange.getPositions(position.symbol), position.symbol);
          const newMargin = positionMargin(after);
          const newLiq = liquidationPrice(after);
          if (!after || !sameNumber(position.remainingQty, positionAmount(after)) ||
              newMargin == null || newLiq == null ||
              !sameNumber(newMargin - oldMargin, value) || newLiq >= oldLiq) {
            throw new Error("Exchange position margin/liquidation did not verify the top-up");
          }
          await validateExchangeStop(position.symbol,
            position.runnerOpen ? position.runnerStopPrice : position.stopPrice,
            position.entryOrderId, position.protectiveStopOrderId, position.remainingQty);
          const snapshot = safeSnapshot(position, after, {
            ...position,
            lastMarginOperationId: operationId,
            marginAdded: String(value),
            liquidationPrice: newLiq,
          });
          await store.savePosition({ account, environment, signalId, snapshot });
          await markReconciled(operationId, {
            status: "verified", marginAdded: String(value), liquidationPrice: newLiq,
          });
          return { status: "added", operationId, liquidationPrice: newLiq };
        } catch (error) {
          return halt("Margin top-up verification discrepancy", signalId);
        }
      } catch (error) {
        return { status: "rejected", reason: error.message };
      }
    });
  }

  return Object.freeze({
    processSignal,
    reconcilePosition,
    addIsolatedMargin,
  });
}