import assert from "node:assert/strict";
import test from "node:test";
import { createBingXLiveApi } from "../bingx-live-api.mjs";
import { createLiveExecutor } from "../live-executor.mjs";

const NOW = Date.parse("2026-09-25T00:05:00.000Z");
const RULES = {
  priceMoveBasis: "unleveraged_percent_from_actual_entry_fill",
  noFixedTakeProfit: true,
  rMultipleTargets: false,
  firstTargetPct: 10,
  firstTargetAction: "milestone_not_full_close",
  breakevenAtPct: 5,
  breakevenStopGainPct: 0,
  breakevenIncludesFees: false,
  protectedProfitAtPct: 10,
  protectedProfitPct: 5,
  trailingActivationPct: 15,
  trailingGapPercentagePoints: 10,
  trailingGapBasis: "percentage_points_of_entry_pnl",
  trailingStopNeverDecreases: true,
  trailingExitAction: "close_remaining_position",
  maxWatchDays: 4,
  expiryExitPrice: "observed_market_quote",
  partialProfitAdvice: {
    minFraction: 0.2,
    maxFraction: 0.25,
    execution: "advice_only_not_automated",
  },
};

function makeSignal(overrides = {}) {
  return {
    sourceSignalId: "cab-signal-123",
    confirmationStatus: "confirmed",
    patternId: "balanced_grind",
    patternStatus: "approved",
    signalAt: "2026-09-25T00:00:00.000Z",
    symbol: "XRPUSDT",
    side: "buy",
    orderType: "market",
    reduceOnly: false,
    quantity: "1",
    referencePrice: "100",
    limitPrice: "100",
    stopLoss: "95",
    payload: {
      source: "CryptoAltBullet",
      rulesVersion: "bullet-long-exits-v2",
      marginMode: "isolated",
      initialMarginUsd: "10",
      leverage: 10,
      exitRules: RULES,
    },
    ...overrides,
  };
}

function fixture({
  enabled = true,
  capability = true,
  submitError = null,
  topUpError = null,
  stopProtected = true,
  fillQuantity = "1",
  positionQuantity = fillQuantity,
  fillPrice = "100",
  ask = 100,
  liquidation = "80",
  initialMargin = 10,
  plannedTopUpUsd = 0,
  fundingAvailable = true,
  existingOpenOrders = [],
  submission = null,
  oneShotCapability = false,
  discoveryMissing = false,
  emergencyCloseError = null,
  emergencyPositionSide = "BOTH",
  emergencyCloseReduceOnly = true,
  queryFillsError = null,
  stopCoverage = true,
  coverageClosePosition = true,
} = {}) {
  const calls = [];
  let entrySubmitted = false;
  let lastClose = null;
  let closeOrderSequence = 73;
  const intents = new Map();
  const claims = new Map();
  const positions = new Map();
  const fills = [];
  const snapshots = new Map();
  const events = [];
  let controlEnabled = enabled;
  const entryExchangeOrderId = submission?.orderID ?? submission?.orderId ?? 71;
  const exchangePosition = {
    symbol: "XRP-USDT",
    positionSide: emergencyPositionSide === "LONG" ? "LONG" : "BOTH",
    positionAmt: positionQuantity,
    markPrice: "100",
    liquidationPrice: liquidation,
    // Real BingX field name (confirmed live) -- never "isolatedMargin".
    initialMargin: String(initialMargin),
  };
  const store = {
    withLock: (callback) => callback(),
    getControl: async () => ({ enabled: controlEnabled }),
    halt: async (reason) => {
      calls.push(["halt", reason]);
      controlEnabled = false;
      return { enabled: controlEnabled, blockedReason: reason };
    },
    claim: async (signal, account, environment) => {
      const key = `${account}/${environment}/${signal.sourceSignalId}`;
      if (claims.has(key)) return { kind: "duplicate" };
      claims.set(key, structuredClone(signal));
      calls.push(["claim"]);
      return { kind: "new" };
    },
    hasClaim: async (account, environment, signalId) =>
      claims.has(`${account}/${environment}/${signalId}`),
    hasUnresolvedIntent: async (_account, _environment, signalId, phase) =>
      [...intents.values()].some((intent) =>
        intent.signalId === signalId && intent.phase === phase &&
        intent.state !== "reconciled"),
    reserveIntent: async (intent) => {
      if (intents.has(intent.clientOrderId)) return { kind: "existing" };
      intents.set(intent.clientOrderId, { ...intent, state: "pending" });
      calls.push(["reserve", intent.phase]);
      return { kind: "new" };
    },
    markIntent: async (id, state, detail) => {
      intents.get(id).state = state;
      calls.push(["mark", state, detail]);
      return intents.get(id);
    },
    saveFill: async (fill) => {
      fills.push(fill);
      return { kind: "new" };
    },
    savePosition: async (row) => {
      snapshots.set(row.signalId, structuredClone(row.snapshot));
      return row;
    },
    commitVerifiedClose: async ({ signalId, clientOrderId, fills: closeFills, snapshot, detail }) => {
      const intent = intents.get(clientOrderId);
      if (!intent || intent.state !== "unknown") {
        throw new Error("Close intent must be unresolved before commit");
      }
      fills.push(...structuredClone(closeFills));
      snapshots.set(signalId, structuredClone(snapshot));
      intent.state = "reconciled";
      calls.push(["commitClose", detail]);
      return { snapshot };
    },
    getPosition: async (account, environment, signalId) => {
      const snapshot = snapshots.get(signalId);
      return snapshot ? { account, environment, signalId, symbol: snapshot.symbol, status: snapshot.status, snapshot } : null;
    },
    listActive: async () => [...snapshots.values()],
    recordEvent: async (event) => {
      events.push(event);
      return event;
    },
  };
  const exchange = {
    contract: async () => ({
      quantityPrecision: 2, pricePrecision: 2, minQuantity: 0.01, minNotional: 5,
    }),
    preflight: async (_symbol, options) => {
      calls.push(["preflight", options]);
      // Mirrors the adapter: requiredMargin is the initial/slippage reserve;
      // plannedTopUpUsd is added by preflight, not by the caller.
      const initialMarginAvailable =
        options.requiredMargin + plannedTopUpUsd <= 10 || fundingAvailable;
      return {
        status: initialMarginAvailable ? "ready" : "blocked",
        environment: "mainnet",
        checks: {
          stopSafe: true, initialMargin: initialMarginAvailable,
          marginTypeIsolated: true,
        },
        stopRisk: { plannedTopUpUsd: String(plannedTopUpUsd) },
      };
    },
    placeLong: async (order) => {
      calls.push(["placeLong", order]);
      entrySubmitted = true;
      if (submitError) throw submitError;
      return submission ?? { orderId: 71, protectiveStopOrderId: 72 };
    },
    queryOrder: async (_symbol, id) => {
      calls.push(["queryOrder", id]);
      const isEntryOrder = String(id) === String(entryExchangeOrderId);
      return {
        orderId: id, status: "FILLED", symbol: "XRP-USDT",
        positionSide: isEntryOrder ? "BOTH" : emergencyPositionSide,
        side: isEntryOrder ? "BUY" : "SELL",
        ...(isEntryOrder
          ? { reduceOnly: false }
          : emergencyCloseReduceOnly == null
            ? {} : { reduceOnly: emergencyCloseReduceOnly }),
        ...(isEntryOrder ? {} : {
          clientOrderId: lastClose?.clientOrderId,
          origQty: lastClose?.quantity,
        }),
        executedQty: isEntryOrder ? fillQuantity : lastClose?.quantity ?? fillQuantity,
      };
    },
    queryFills: async (_symbol, options) => {
      calls.push(["queryFills", options]);
      if (queryFillsError) throw queryFillsError;
      return [{
        tradeId: options.orderId == null ? "external-fill"
          : String(options.orderId) === String(entryExchangeOrderId)
            ? "entry-fill" : `exit-fill-${String(options.orderId)}`,
        orderId: options.orderId ?? 72,
        symbol: "XRP-USDT",
        side: String(options.orderId) === String(entryExchangeOrderId) ? "BUY" : "SELL",
        qty: String(options.orderId) === String(entryExchangeOrderId)
          ? fillQuantity : lastClose?.quantity ?? fillQuantity,
        price: fillPrice, time: NOW,
      }];
    },
    getPositions: async () => entrySubmitted ? [exchangePosition] : [],
    getOpenOrders: async () => existingOpenOrders,
    canVerifyAttachedProtectionOnEntry: async () => true,
    getMarginType: async () => "ISOLATED",
    reconcilePositionAndStop: async (_symbol, options) => ({
      positionOpen: true,
      positionAmount: "1",
      stopProtected,
      expectedStopMatches: stopProtected,
      stopPrice: stopProtected ? options.expectedStopPrice : null,
      stopEvidence: stopProtected ? "order_query_attached_stop" : "unverified",
    }),
    assessProtectiveStopAmendment: async (_symbol, options) => {
      calls.push(["auditStop", options]);
      return { safeToAmend: false, reason: "replacement_could_leave_position_unprotected", existingStopVerified: true };
    },
    auditProtectiveStopCoverage: async (_symbol, options) => {
      calls.push(["auditCoverage", options]);
      return {
        verified: stopCoverage,
        stopProtected: stopCoverage,
        protectiveStopOrderId: options.stopOrderId,
        entryOrderId: options.entryOrderId,
        closePosition: coverageClosePosition,
        canCoverRemainingQuantity: stopCoverage,
        remainingQuantity: String(exchangePosition.positionAmt),
        expectedStopPrice: options.expectedStopPrice,
        positionSide: emergencyPositionSide,
      };
    },
    addIsolatedMargin: async (_symbol, amount, operationId) => {
      calls.push(["addMargin", amount, operationId]);
      if (topUpError) throw topUpError;
      exchangePosition.initialMargin = String(Number(exchangePosition.initialMargin) + Number(amount));
      exchangePosition.liquidationPrice = String(Number(exchangePosition.liquidationPrice) - Number(amount));
      return { success: true };
    },
    closeLong: async (_symbol, quantity, options) => {
      calls.push(["closeLong", quantity, options]);
      if (emergencyCloseError) throw emergencyCloseError;
      lastClose = { quantity: String(quantity), clientOrderId: options };
      exchangePosition.positionAmt = String(Number(exchangePosition.positionAmt) - Number(quantity));
      closeOrderSequence += 1;
      return { orderId: closeOrderSequence };
    },
    discoverAttachedStop: async (_symbol, options) => {
      calls.push(["discoverAttachedStop", options]);
      return discoveryMissing ? null : { protectiveStopOrderId: 73 };
    },
    getConservativeAsk: async () => ask,
  };
  const executor = createLiveExecutor({
    store, exchange, account: "test-account", environment: "mainnet",
    clock: () => NOW,
    writeCapability: async () => capability,
    supervisedOneShotCapability: async () => oneShotCapability,
  });
  return { executor, store, exchange, calls, intents, claims, fills, snapshots, events, exchangePosition };
}

test("entry reserves and marks unknown before network, then persists only exact verified live fills", async () => {
  const f = fixture();
  const result = await f.executor.processSignal(makeSignal());
  assert.equal(result.status, "opened");
  assert.equal(result.entryPrice, 100);
  assert.equal(f.fills.length, 1);
  assert.equal(f.snapshots.get("cab-signal-123").mode, "live");
  assert.equal(f.snapshots.get("cab-signal-123").entryPrice, 100);
  assert.equal(f.snapshots.get("cab-signal-123").protectiveStopOrderId, "72");
  const reserveAt = f.calls.findIndex(([kind]) => kind === "reserve");
  const unknownAt = f.calls.findIndex(([kind, state]) => kind === "mark" && state === "unknown");
  const submitAt = f.calls.findIndex(([kind]) => kind === "placeLong");
  assert.ok(reserveAt < unknownAt && unknownAt < submitAt);
  assert.equal([...f.intents.values()][0].state, "reconciled");
});

test("executor refuses unsafe numeric submission IDs and prefers a lossless orderID string", async () => {
  const unsafe = fixture({
    submission: { orderId: 9007199254740992, protectiveStopOrderId: 72 },
  });
  const refused = await unsafe.executor.processSignal(makeSignal());
  assert.equal(refused.status, "halted");
  assert.equal(unsafe.fills.length, 0);
  assert.equal(unsafe.snapshots.get("cab-signal-123").status, "opening");
  assert.equal([...unsafe.intents.values()][0].state, "unknown");

  const exact = "9007199254740993";
  const lossless = fixture({
    submission: {
      orderId: 9007199254740992,
      orderID: exact,
      protectiveStopOrderId: 72,
    },
  });
  lossless.exchange.queryFills = async () => [{
    tradeId: "entry-fill",
    orderId: 9007199254740992,
    orderID: exact,
    symbol: "XRP-USDT",
    side: "BUY",
    qty: "1",
    price: "100",
    time: NOW,
  }];
  const opened = await lossless.executor.processSignal(makeSignal());
  assert.equal(opened.status, "opened");
  assert.equal(lossless.snapshots.get("cab-signal-123").entryOrderId, exact);
  assert.equal(lossless.fills[0].tradeId, "entry-fill");

  const unsafeFill = fixture();
  unsafeFill.exchange.queryFills = async () => [{
    tradeId: "entry-fill",
    orderId: 9007199254740992,
    symbol: "XRP-USDT",
    side: "BUY",
    qty: "1",
    price: "100",
    time: NOW,
  }];
  const refusedFill = await unsafeFill.executor.processSignal(makeSignal());
  assert.equal(refusedFill.status, "halted");
  assert.equal(unsafeFill.fills.length, 0);
});

test("post-fill protection top-up runs after the verified entry and is persisted independently", async () => {
  const f = fixture({ plannedTopUpUsd: 0, ask: 99, fillPrice: "100" });
  const result = await f.executor.processSignal(makeSignal());
  assert.equal(result.status, "opened");
  const entryIntent = [...f.intents.values()].find((intent) => intent.phase === "entry");
  assert.equal(entryIntent.details.plannedTopUpUsd, "0");
  const marginIntent = [...f.intents.values()].find((intent) => intent.phase === "margin");
  assert.equal(marginIntent.state, "reconciled");
  assert.equal(f.exchangePosition.initialMargin, "11");
  assert.equal(f.exchangePosition.liquidationPrice, "79");
  assert.equal(f.snapshots.get("cab-signal-123").protectionTopUpState, "verified");
  assert.equal(f.snapshots.get("cab-signal-123").protectionTopUpUsd, "1");
  // The persisted snapshot must actually carry the exchange's isolated
  // margin figure -- reading the wrong raw field silently drops it instead
  // of erroring, so a real value here (not undefined/blank) is the proof.
  assert.equal(f.snapshots.get("cab-signal-123").exchangePosition.isolatedMargin, "11");
  assert.equal(f.calls.filter(([kind]) => kind === "preflight")[1][1].requiredMargin, 11);
  assert.equal(f.fills.length, 1);
  const entryWriteAt = f.calls.findIndex(([kind]) => kind === "placeLong");
  const topUpUnknownAt = f.calls.findIndex(([kind, state, detail]) =>
    kind === "mark" && state === "unknown" && detail.phase === "margin");
  const topUpWriteAt = f.calls.findIndex(([kind]) => kind === "addMargin");
  assert.ok(entryWriteAt < topUpUnknownAt && topUpUnknownAt < topUpWriteAt);
});

test("a funded pre-entry top-up plan is still unsafe before margin can be added", async () => {
  const f = fixture({ plannedTopUpUsd: 2.5 });
  const result = await f.executor.processSignal(makeSignal());
  assert.equal(result.status, "rejected");
  assert.match(result.reason, /before a position exists/);
  assert.equal(f.calls.some(([kind]) => kind === "claim" || kind === "placeLong"), false);
});

test("insufficient planned protection funding is rejected before signal claim or entry submission", async () => {
  const f = fixture({ plannedTopUpUsd: 2.5, fundingAvailable: false });
  const result = await f.executor.processSignal(makeSignal());
  assert.equal(result.status, "rejected");
  assert.match(result.reason, /preflight did not pass/);
  assert.equal(f.claims.size, 0);
  assert.equal(f.calls.some(([kind]) => kind === "placeLong"), false);
});

test("uncertain post-fill top-up preserves exposure, halts, and cannot retry", async () => {
  const f = fixture({
    ask: 99, fillPrice: "100",
    topUpError: new Error("timeout"),
  });
  const first = await f.executor.processSignal(makeSignal());
  assert.equal(first.status, "halted");
  assert.equal(f.fills.length, 1);
  assert.equal(f.snapshots.get("cab-signal-123").status, "open");
  assert.equal(f.snapshots.get("cab-signal-123").protectionTopUpState, "unknown");
  assert.equal([...f.intents.values()].find((intent) => intent.phase === "margin").state, "unknown");
  assert.equal(f.calls.filter(([kind]) => kind === "addMargin").length, 1);
  const repeated = await f.executor.processSignal(makeSignal());
  assert.equal(repeated.status, "rejected");
  assert.equal(f.calls.filter(([kind]) => kind === "addMargin").length, 1);
});

test("expired signal, disabled kill switch, and denied write capability never claim or submit", async () => {
  const old = fixture();
  const result = await old.executor.processSignal(makeSignal({ signalAt: "2026-09-24T23:00:00.000Z" }));
  assert.equal(result.status, "rejected");
  assert.equal(old.claims.size, 0);

  const halted = fixture({ enabled: false });
  assert.equal((await halted.executor.processSignal(makeSignal())).status, "rejected");
  assert.equal(halted.claims.size, 0);

  const denied = fixture({ capability: false });
  assert.equal((await denied.executor.processSignal(makeSignal())).status, "rejected");
  assert.equal(denied.claims.size, 0);
  assert.equal(denied.calls.some(([kind]) => kind === "placeLong"), false);
});

test("ambiguous entry timeout stays unknown, halts, and is never resubmitted", async () => {
  const f = fixture({ submitError: new Error("timeout") });
  const first = await f.executor.processSignal(makeSignal());
  assert.equal(first.status, "unknown");
  assert.equal([...f.intents.values()][0].state, "unknown");
  assert.equal(f.snapshots.get("cab-signal-123").status, "opening");
  assert.equal(f.snapshots.get("cab-signal-123").exchangePosition.positionAmt, "1");
  assert.equal(f.snapshots.get("cab-signal-123").stopProof, "unverified");
  assert.equal(f.snapshots.get("cab-signal-123").manualInterventionRequired, true);
  assert.equal(f.calls.filter(([kind]) => kind === "placeLong").length, 1);
  const second = await f.executor.processSignal(makeSignal());
  assert.equal(second.status, "rejected");
  assert.equal(f.calls.filter(([kind]) => kind === "placeLong").length, 1);
  assert.equal(f.calls.some(([kind]) => kind === "halt"), true);
});

test("claim and order intent duplicates cannot cause a second exchange submission", async () => {
  const f = fixture();
  assert.equal((await f.executor.processSignal(makeSignal())).status, "opened");
  assert.equal((await f.executor.processSignal(makeSignal())).status, "duplicate");
  assert.equal(f.calls.filter(([kind]) => kind === "placeLong").length, 1);
});

test("partial fills, missing stops, market drift, and unsafe liquidation buffer halt and retain confirmed exposure", async () => {
  const partial = fixture({ fillQuantity: "0.5" });
  assert.equal((await partial.executor.processSignal(makeSignal())).status, "halted");
  assert.equal(partial.snapshots.get("cab-signal-123").status, "open");
  assert.equal([...partial.intents.values()][0].state, "unknown");
  assert.equal((await partial.executor.reconcilePosition("cab-signal-123", 90)).status, "halted");
  assert.equal(partial.calls.some(([kind]) => kind === "closeLong"), false);
  assert.equal(partial.calls.some(([kind]) => kind === "halt"), true);

  const noStop = fixture({ stopProtected: false });
  assert.equal((await noStop.executor.processSignal(makeSignal())).status, "halted");
  assert.equal(noStop.snapshots.get("cab-signal-123").stopProof, "unverified");
  assert.equal(noStop.fills.length, 1);

  const drift = fixture({ ask: 101 });
  assert.equal((await drift.executor.processSignal(makeSignal())).status, "rejected");
  assert.equal(drift.claims.size, 0);

  const fillDrift = fixture({ fillPrice: "101" });
  assert.equal((await fillDrift.executor.processSignal(makeSignal())).status, "halted");
  assert.equal(fillDrift.snapshots.get("cab-signal-123").entryPrice, 101);

  const unsafeLiquidationBuffer = fixture({ liquidation: "94.6" });
  assert.equal((await unsafeLiquidationBuffer.executor.processSignal(makeSignal())).status, "halted");
  assert.equal(unsafeLiquidationBuffer.snapshots.get("cab-signal-123").liquidationPrice, 94.6);
});

test("margin top-up reserves a separate unknown operation and persists only verified improvement", async () => {
  const f = fixture();
  assert.equal((await f.executor.processSignal(makeSignal())).status, "opened");
  const result = await f.executor.addIsolatedMargin("cab-signal-123", 2.5, "top-up-1");
  assert.equal(result.status, "added");
  assert.equal(f.exchangePosition.initialMargin, "12.5");
  assert.equal(f.exchangePosition.liquidationPrice, "77.5");
  const marginIntent = [...f.intents.values()].find((intent) => intent.phase === "margin");
  assert.ok(marginIntent);
  assert.equal(marginIntent.state, "reconciled");
  assert.equal(f.snapshots.get("cab-signal-123").liquidationPrice, 77.5);
  const marginUnknownAt = f.calls.findIndex(([kind, state, detail]) =>
    kind === "mark" && state === "unknown" && detail.phase === "margin");
  const marginWriteAt = f.calls.findIndex(([kind]) => kind === "addMargin");
  assert.ok(marginUnknownAt >= 0 && marginUnknownAt < marginWriteAt);
  const repeated = await f.executor.addIsolatedMargin("cab-signal-123", 2.5, "top-up-1");
  assert.equal(repeated.status, "rejected");
  assert.equal(f.calls.filter(([kind]) => kind === "addMargin").length, 1);
});

test("unknown margin operation is not retried by a restarted executor with the same stable key", async () => {
  const f = fixture();
  assert.equal((await f.executor.processSignal(makeSignal())).status, "opened");
  f.exchange.addIsolatedMargin = async (_symbol, _amount, operationId) => {
    f.calls.push(["addMargin", operationId]);
    throw new Error("timeout");
  };
  const first = await f.executor.addIsolatedMargin("cab-signal-123", 2.5, "recovery-key-7");
  assert.equal(first.status, "halted");
  assert.equal([...f.intents.values()].find((intent) => intent.phase === "margin").state, "unknown");

  const restarted = createLiveExecutor({
    store: f.store,
    exchange: f.exchange,
    account: "test-account",
    environment: "mainnet",
    clock: () => NOW,
    writeCapability: async () => true,
  });
  const retry = await restarted.addIsolatedMargin("cab-signal-123", 2.5, "recovery-key-7");
  assert.equal(retry.status, "rejected");
  assert.equal(f.calls.filter(([kind]) => kind === "addMargin").length, 1);
});

test("entry sizing rejects a notional below the contract minimum and impulse runner is disabled", async () => {
  const f = fixture();
  const result = await f.executor.processSignal(makeSignal({ quantity: "0.04" }));
  assert.equal(result.status, "rejected");
  assert.equal(f.claims.size, 0);
  assert.equal(f.calls.some(([kind]) => kind === "placeLong"), false);

  const belowHundred = fixture({ fillQuantity: "0.1" });
  const accepted = await belowHundred.executor.processSignal(makeSignal({ quantity: "0.1" }));
  assert.equal(accepted.status, "opened");

  const impulse = await f.executor.processSignal(makeSignal({ patternId: "impulse_buy" }));
  assert.equal(impulse.status, "rejected");
  assert.match(impulse.reason, /20% runner/);
  assert.equal(f.claims.size, 0);
});

test("kill switch does not prevent live exposure reconciliation, but blocks an exit write", async () => {
  const f = fixture();
  assert.equal((await f.executor.processSignal(makeSignal())).status, "opened");
  f.store.getControl = async () => ({ enabled: false, blockedReason: "halted" });
  const monitored = await f.executor.reconcilePosition("cab-signal-123");
  assert.equal(monitored.status, "reconciled");
  const blockedExit = await f.executor.reconcilePosition("cab-signal-123", 90);
  assert.equal(blockedExit.status, "blocked");
  assert.equal(f.calls.some(([kind]) => kind === "closeLong"), false);
});

test("stop raise audits existing protection but never changes it or repeats a trading write", async () => {
  const f = fixture();
  assert.equal((await f.executor.processSignal(makeSignal({
    patternId: "price_led_momentum",
  }))).status, "opened");
  const original = structuredClone(f.snapshots.get("cab-signal-123"));
  const intentsBefore = f.intents.size;
  const first = await f.executor.reconcilePosition("cab-signal-123", 105);
  const repeated = await f.executor.reconcilePosition("cab-signal-123", 105);
  assert.equal(first.status, "halted");
  assert.match(first.reason, /replacement_could_leave_position_unprotected/);
  assert.equal(repeated.status, "halted");
  assert.equal(f.calls.filter(([kind]) => kind === "auditStop").length, 2);
  assert.equal(f.intents.size, intentsBefore);
  assert.deepEqual(f.snapshots.get("cab-signal-123"), original);
  assert.equal(f.calls.some(([kind]) => kind === "closeLong"), false);
  const trailing = await f.executor.reconcilePosition("cab-signal-123", 116);
  assert.equal(trailing.status, "halted");
  assert.match(trailing.reason, /replacement_could_leave_position_unprotected/);
  assert.equal(f.calls.filter(([kind]) => kind === "auditStop").length, 3);
  assert.deepEqual(f.snapshots.get("cab-signal-123"), original);

  f.exchange.assessProtectiveStopAmendment = async () => { throw new Error("timeout"); };
  const timedOut = await f.executor.reconcilePosition("cab-signal-123", 105);
  assert.equal(timedOut.status, "halted");
  assert.match(timedOut.reason, /audit failed/);
  assert.equal(f.intents.size, intentsBefore);
  assert.deepEqual(f.snapshots.get("cab-signal-123"), original);
});

test("REAL +5/+10/+15 plans never submit a partial or the remaining 50% as a full close", async () => {
  for (const price of [105, 110, 115]) {
    const f = fixture();
    assert.equal((await f.executor.processSignal(makeSignal())).status, "opened");
    const before = structuredClone(f.snapshots.get("cab-signal-123"));
    assert.deepEqual(before.liveExitPolicy.targetPcts, [5, 10, 15]);

    const result = await f.executor.reconcilePosition("cab-signal-123", price);
    assert.equal(result.status, "halted");
    assert.match(result.reason, /partial\/runner exit requires verified fill/);
    assert.deepEqual(f.snapshots.get("cab-signal-123"), before);
    assert.equal(f.calls.some(([kind]) => kind === "closeLong"), false);
    assert.equal(f.calls.some(([kind]) => kind === "auditStop"), false);
  }
});

test("the real adapter blocks entry before claiming or submitting when active stop identity cannot be obtained", async () => {
  const f = fixture();
  const realAdapter = createBingXLiveApi({
    credentials: () => ({ key: "mock-key", secret: "mock-secret" }),
    fetchImpl: async () => { throw new Error("No exchange request expected"); },
  });
  f.exchange.canVerifyAttachedProtectionOnEntry = realAdapter.canVerifyAttachedProtectionOnEntry;
  const result = await f.executor.processSignal(makeSignal());
  assert.equal(result.status, "rejected");
  assert.match(result.reason, /cannot identify and verify/);
  assert.equal(f.claims.size, 0);
  assert.equal(f.intents.size, 0);
  assert.equal(f.calls.some(([kind]) => kind === "placeLong"), false);
});

test("only an explicit supervised liquidation-cascade one-shot bypasses pre-submit stop discovery", async () => {
  const f = fixture({ oneShotCapability: true });
  f.exchange.canVerifyAttachedProtectionOnEntry = async () => false;
  const result = await f.executor.processSignal(makeSignal({ patternId: "liquidation_cascade" }));
  assert.equal(result.status, "opened");
  const discoveryAt = f.calls.findIndex(([kind]) => kind === "discoverAttachedStop");
  const submitAt = f.calls.findIndex(([kind]) => kind === "placeLong");
  assert.ok(submitAt < discoveryAt);
  assert.deepEqual(f.calls[discoveryAt][1], {
    entryOrderId: "71", expectedStopPrice: "95", expectedQuantity: "1",
  });
  assert.equal(f.snapshots.get("cab-signal-123").protectiveStopOrderId, "73");

  const wrongPattern = fixture({ oneShotCapability: true });
  wrongPattern.exchange.canVerifyAttachedProtectionOnEntry = async () => false;
  assert.equal((await wrongPattern.executor.processSignal(makeSignal())).status, "rejected");
  assert.equal(wrongPattern.calls.some(([kind]) => kind === "placeLong"), false);
});

test("supervised liquidation cascade allows only verified partial takes and preserves the original stop", async () => {
  const unarmed = fixture();
  assert.equal((await unarmed.executor.processSignal(
    makeSignal({ patternId: "liquidation_cascade" }),
  )).status, "opened");
  assert.equal((await unarmed.executor.reconcilePosition("cab-signal-123", 105)).status, "halted");
  assert.equal(unarmed.calls.filter(([kind]) => kind === "closeLong").length, 0);

  const f = fixture({ oneShotCapability: true });
  const signal = makeSignal({ patternId: "liquidation_cascade" });
  assert.equal((await f.executor.processSignal(signal)).status, "opened");
  const initial = f.snapshots.get("cab-signal-123");
  assert.equal(initial.supervisedPartialTakeMode, true);
  assert.equal(initial.originalProtectiveStopPrice, 95);

  const first = await f.executor.reconcilePosition("cab-signal-123", 105);
  assert.equal(first.status, "partially_closed");
  assert.equal(first.position.remainingQty, 0.75);
  assert.equal(first.position.stopPrice, 95);
  assert.equal(first.position.originalProtectiveStopPrice, 95);
  assert.equal(first.position.liveExitPolicy.firstTargetExecuted, true);
  assert.equal(first.position.liveExitPolicy.secondTargetExecuted, false);
  assert.equal(f.calls.filter(([kind]) => kind === "auditCoverage").length, 2);
  assert.equal(f.calls.filter(([kind]) => kind === "closeLong").length, 1);
  assert.equal([...f.intents.values()].find((intent) => intent.phase === "exit").state, "reconciled");
  assert.equal(f.calls.some(([kind]) => kind === "auditStop"), false);

  const second = await f.executor.reconcilePosition("cab-signal-123", 110);
  assert.equal(second.status, "partially_closed");
  assert.equal(second.position.remainingQty, 0.5);
  assert.equal(second.position.stopPrice, 95);
  assert.equal(second.position.liveExitPolicy.secondTargetExecuted, true);
  assert.equal(f.calls.filter(([kind]) => kind === "closeLong").length, 2);
  const noBreakEven = await f.executor.reconcilePosition("cab-signal-123", 112);
  assert.equal(noBreakEven.status, "updated");
  assert.equal(noBreakEven.position.stopPrice, 95);
  assert.equal(noBreakEven.position.originalProtectiveStopPrice, 95);
  assert.equal(f.calls.filter(([kind]) => kind === "auditStop").length, 0);
  assert.equal(f.calls.filter(([kind]) => kind === "closeLong").length, 2);

  const finalTarget = await f.executor.reconcilePosition("cab-signal-123", 115);
  assert.equal(finalTarget.status, "closed");
  assert.equal(finalTarget.position.status, "closed");
  assert.equal(finalTarget.position.stopPrice, 95);
  assert.equal(finalTarget.position.originalProtectiveStopPrice, 95);
  assert.equal(finalTarget.position.liveExitPolicy.thirdTargetExecuted, true);
  assert.equal(f.calls.filter(([kind]) => kind === "closeLong").length, 3);
  assert.equal(f.fills.length, 4);
  assert.equal([...f.intents.values()].filter((intent) => intent.phase === "exit")
    .every((intent) => intent.state === "reconciled"), true);
});

test("supervised partial take fails closed unless closePosition coverage is independently verified", async () => {
  const fixedQuantityStop = fixture({
    oneShotCapability: true,
    coverageClosePosition: false,
  });
  assert.equal((await fixedQuantityStop.executor.processSignal(
    makeSignal({ patternId: "liquidation_cascade" }),
  )).status, "opened");
  const blocked = await fixedQuantityStop.executor.reconcilePosition("cab-signal-123", 105);
  assert.equal(blocked.status, "halted");
  assert.match(blocked.reason, /full-position stop coverage/);
  assert.equal(fixedQuantityStop.calls.filter(([kind]) => kind === "closeLong").length, 0);
  assert.equal(fixedQuantityStop.snapshots.get("cab-signal-123").remainingQty, 1);

  const lostCoverage = fixture({ oneShotCapability: true });
  assert.equal((await lostCoverage.executor.processSignal(
    makeSignal({ patternId: "liquidation_cascade" }),
  )).status, "opened");
  let auditCount = 0;
  lostCoverage.exchange.auditProtectiveStopCoverage = async (_symbol, options) => {
    auditCount += 1;
    lostCoverage.calls.push(["auditCoverage", options]);
    return {
      verified: auditCount === 1,
      stopProtected: auditCount === 1,
      protectiveStopOrderId: options.stopOrderId,
      entryOrderId: options.entryOrderId,
      closePosition: true,
      canCoverRemainingQuantity: auditCount === 1,
      remainingQuantity: String(lostCoverage.exchangePosition.positionAmt),
      expectedStopPrice: options.expectedStopPrice,
      positionSide: "BOTH",
    };
  };
  assert.equal((await lostCoverage.executor.reconcilePosition("cab-signal-123", 105)).status, "halted");
  assert.equal(lostCoverage.calls.filter(([kind]) => kind === "closeLong").length, 1);
  assert.equal([...lostCoverage.intents.values()].find((intent) => intent.phase === "exit").state, "unknown");
  assert.equal(lostCoverage.snapshots.get("cab-signal-123").remainingQty, 1);
  assert.equal(lostCoverage.snapshots.get("cab-signal-123").stopPrice, 95);
  assert.equal(lostCoverage.snapshots.get("cab-signal-123").manualInterventionRequired, true);
});

test("BingX adapter audit returns the full-position coverage proof consumed by executor", async () => {
  const requests = [];
  const adapter = createBingXLiveApi({
    credentials: () => ({ key: "mock-key", secret: "mock-secret" }),
    clock: () => NOW,
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      const request = new URL(url);
      requests.push({ path: request.pathname, method: options.method });
      let data;
      if (request.pathname === "/openApi/swap/v1/positionSide/dual") {
        data = { dualSidePosition: false };
      } else if (request.pathname === "/openApi/swap/v2/user/positions") {
        data = [{ symbol: "XRP-USDT", positionSide: "BOTH", positionAmt: "0.75" }];
      } else if (request.pathname === "/openApi/swap/v2/trade/openOrders") {
        data = [{
          symbol: "XRP-USDT", orderId: "72", type: "STOP_MARKET", status: "NEW",
          side: "SELL", positionSide: "BOTH", origQty: "0", stopPrice: "95",
          closePosition: true, workingType: "MARK_PRICE", mainOrderId: "71",
        }];
      } else if (request.pathname === "/openApi/swap/v2/quote/contracts") {
        data = [{
          symbol: "XRP-USDT", status: 1, currency: "USDT", apiStateOpen: "true",
          quantityPrecision: 2, pricePrecision: 2,
          tradeMinQuantity: "0.01", tradeMinUSDT: "5",
        }];
      } else {
        throw new Error(`Unexpected adapter request: ${request.pathname}`);
      }
      return new Response(JSON.stringify({ code: 0, data }), { status: 200 });
    },
  });
  assert.equal(typeof adapter.auditProtectiveStopCoverage, "function");
  const proof = await adapter.auditProtectiveStopCoverage("XRPUSDT", {
    stopOrderId: "72",
    expectedStopPrice: "95",
    expectedQuantity: "0.75",
    entryOrderId: "71",
  });
  assert.deepEqual(proof, {
    verified: true,
    stopProtected: true,
    protectiveStopOrderId: "72",
    closePosition: true,
    canCoverRemainingQuantity: true,
    remainingQuantity: "0.75",
    expectedStopPrice: "95",
    positionSide: "BOTH",
    entryOrderId: "71",
  });
  assert.ok(requests.length >= 4);
  assert.ok(requests.every((request) => request.method === "GET"));
});

test("supervised partial requires the queried order's exact stable clientOrderId", async () => {
  const f = fixture({ oneShotCapability: true });
  assert.equal((await f.executor.processSignal(
    makeSignal({ patternId: "liquidation_cascade" }),
  )).status, "opened");
  const query = f.exchange.queryOrder;
  f.exchange.queryOrder = async (symbol, id) => {
    const order = await query(symbol, id);
    return String(id) === "74" ? { ...order, clientOrderId: "different-order" } : order;
  };
  assert.equal((await f.executor.reconcilePosition("cab-signal-123", 105)).status, "halted");
  assert.equal([...f.intents.values()].find((intent) => intent.phase === "exit").state, "unknown");
  assert.equal(f.snapshots.get("cab-signal-123").remainingQty, 1);
  assert.equal(f.snapshots.get("cab-signal-123").manualInterventionRequired, true);
  assert.equal(f.calls.filter(([kind]) => kind === "closeLong").length, 1);
});

test("supervised partial accepts hedge LONG and requires reduceOnly for one-way BOTH", async () => {
  const hedge = fixture({
    oneShotCapability: true,
    emergencyPositionSide: "LONG",
    emergencyCloseReduceOnly: false,
  });
  assert.equal((await hedge.executor.processSignal(
    makeSignal({ patternId: "liquidation_cascade" }),
  )).status, "opened");
  assert.equal((await hedge.executor.reconcilePosition("cab-signal-123", 105)).status, "partially_closed");

  const oneWay = fixture({
    oneShotCapability: true,
    emergencyPositionSide: "BOTH",
    emergencyCloseReduceOnly: false,
  });
  assert.equal((await oneWay.executor.processSignal(
    makeSignal({ patternId: "liquidation_cascade" }),
  )).status, "opened");
  assert.equal((await oneWay.executor.reconcilePosition("cab-signal-123", 105)).status, "halted");
  assert.equal([...oneWay.intents.values()].find((intent) => intent.phase === "exit").state, "unknown");
  assert.equal(oneWay.snapshots.get("cab-signal-123").remainingQty, 1);
});

test("missing one-shot attached protection attempts one reserved exact reduce-only emergency close", async () => {
  const f = fixture({ oneShotCapability: true, discoveryMissing: true, stopProtected: false });
  f.exchange.canVerifyAttachedProtectionOnEntry = async () => false;
  const result = await f.executor.processSignal(makeSignal({ patternId: "liquidation_cascade" }));
  assert.equal(result.status, "halted");
  assert.match(result.reason, /emergency close was verified/);
  const closeCall = f.calls.find(([kind]) => kind === "closeLong");
  assert.equal(closeCall[1], "1");
  assert.match(closeCall[2], /^emergen-/);
  const emergencyIntent = [...f.intents.values()].find((intent) => intent.phase === "emergency");
  assert.equal(emergencyIntent.details.reduceOnly, true);
  assert.equal(f.snapshots.get("cab-signal-123").status, "closed");
  assert.equal(f.snapshots.get("cab-signal-123").emergencyCloseState, "verified");
  assert.equal(emergencyIntent.state, "reconciled");
  assert.equal((await f.store.getControl()).enabled, false);
  assert.equal(f.calls.some(([kind, reason]) =>
    kind === "halt" && /operator review required/.test(reason)), true);
  assert.equal(f.calls.filter(([kind]) => kind === "closeLong").length, 1);
});

test("a committed emergency-close snapshot survives a lost commit acknowledgement", async () => {
  const f = fixture({ oneShotCapability: true, discoveryMissing: true, stopProtected: false });
  f.exchange.canVerifyAttachedProtectionOnEntry = async () => false;
  const commit = f.store.commitVerifiedClose;
  f.store.commitVerifiedClose = async (args) => {
    await commit(args);
    throw new Error("commit acknowledgement lost");
  };
  const result = await f.executor.processSignal(makeSignal({ patternId: "liquidation_cascade" }));
  assert.equal(result.status, "halted");
  assert.equal(f.snapshots.get("cab-signal-123").status, "closed");
  assert.equal(f.snapshots.get("cab-signal-123").emergencyCloseState, "verified");
  assert.equal((await f.store.getControl()).enabled, false);
});

test("uncertain one-shot emergency close remains unknown, preserves exposure, and is never retried", async () => {
  const f = fixture({
    oneShotCapability: true,
    discoveryMissing: true,
    stopProtected: false,
    emergencyCloseError: new Error("timeout"),
  });
  f.exchange.canVerifyAttachedProtectionOnEntry = async () => false;
  const candidate = makeSignal({ patternId: "liquidation_cascade" });
  assert.equal((await f.executor.processSignal(candidate)).status, "halted");
  assert.equal([...f.intents.values()].find((intent) => intent.phase === "emergency").state, "unknown");
  assert.equal(f.snapshots.get("cab-signal-123").status, "open");
  assert.equal(f.snapshots.get("cab-signal-123").stopProof, "unverified");
  assert.equal(f.snapshots.get("cab-signal-123").manualInterventionRequired, true);
  assert.equal((await f.executor.processSignal(candidate)).status, "rejected");
  assert.equal(f.calls.filter(([kind]) => kind === "closeLong").length, 1);
});

test("verified hedge LONG close may omit reduceOnly only when flat with no same-symbol orders", async () => {
  const f = fixture({
    oneShotCapability: true,
    discoveryMissing: true,
    stopProtected: false,
    emergencyPositionSide: "LONG",
    emergencyCloseReduceOnly: null,
  });
  f.exchange.canVerifyAttachedProtectionOnEntry = async () => false;
  const result = await f.executor.processSignal(makeSignal({ patternId: "liquidation_cascade" }));
  assert.equal(result.status, "halted");
  assert.match(result.reason, /emergency close was verified/);
  assert.equal(f.snapshots.get("cab-signal-123").status, "closed");
  assert.equal((await f.store.getControl()).enabled, false);

  const pendingOrders = [];
  const conflicted = fixture({
    oneShotCapability: true,
    discoveryMissing: true,
    stopProtected: false,
    emergencyPositionSide: "LONG",
    emergencyCloseReduceOnly: null,
    existingOpenOrders: pendingOrders,
  });
  conflicted.exchange.canVerifyAttachedProtectionOnEntry = async () => false;
  // The pre-entry order check must remain empty; introduce a conflicting order
  // only after the emergency close has been submitted.
  const originalClose = conflicted.exchange.closeLong;
  conflicted.exchange.closeLong = async (...args) => {
    const response = await originalClose(...args);
    pendingOrders.push({ symbol: "XRP-USDT", orderId: 999 });
    return response;
  };
  const rejectedHedge = await conflicted.executor.processSignal(makeSignal({ patternId: "liquidation_cascade" }));
  assert.equal(rejectedHedge.status, "halted");
  assert.equal([...conflicted.intents.values()].find((intent) => intent.phase === "emergency").state, "unknown");
  assert.equal(conflicted.snapshots.get("cab-signal-123").status, "open");
});

test("one-way emergency close without reduceOnly is not accepted", async () => {
  const f = fixture({
    oneShotCapability: true,
    discoveryMissing: true,
    stopProtected: false,
    emergencyPositionSide: "BOTH",
    emergencyCloseReduceOnly: null,
  });
  f.exchange.canVerifyAttachedProtectionOnEntry = async () => false;
  const result = await f.executor.processSignal(makeSignal({ patternId: "liquidation_cascade" }));
  assert.equal(result.status, "halted");
  assert.match(result.reason, /outcome is unknown/);
  assert.equal([...f.intents.values()].find((intent) => intent.phase === "emergency").state, "unknown");
  assert.equal(f.snapshots.get("cab-signal-123").manualInterventionRequired, true);
});

test("entry fill-read failure preserves an unknown unprotected entry for manual intervention", async () => {
  const f = fixture({ queryFillsError: new Error("fill history unavailable") });
  const result = await f.executor.processSignal(makeSignal());
  assert.equal(result.status, "halted");
  const snapshot = f.snapshots.get("cab-signal-123");
  assert.equal(snapshot.status, "opening");
  assert.equal(snapshot.stopProof, "unverified");
  assert.equal(snapshot.protectionState, "unknown");
  assert.equal(snapshot.manualInterventionRequired, true);
  assert.equal([...f.intents.values()].find((intent) => intent.phase === "entry").state, "unknown");
});

test("test margin ceiling includes every top-up and slippage reserve", async () => {
  const slippage = fixture({ ask: 94 });
  const tooMuchReserve = await slippage.executor.processSignal(makeSignal());
  assert.equal(tooMuchReserve.status, "rejected");
  assert.match(tooMuchReserve.reason, /must not exceed \$15/);
  assert.equal(slippage.calls.some(([kind]) => kind === "placeLong"), false);

  const capped = fixture();
  assert.equal((await capped.executor.processSignal(makeSignal())).status, "opened");
  assert.equal((await capped.executor.addIsolatedMargin("cab-signal-123", 5, "cap-15")).status, "added");
  const blocked = await capped.executor.addIsolatedMargin("cab-signal-123", 0.01, "over-cap");
  assert.equal(blocked.status, "rejected");
  assert.match(blocked.reason, /must not exceed \$15/);
  assert.equal(capped.exchangePosition.initialMargin, "15");
  assert.equal(capped.calls.filter(([kind]) => kind === "addMargin").length, 1);
});

test("full exit needs matching exchange order, fills, flat position and no pending stop", async () => {
  const f = fixture();
  assert.equal((await f.executor.processSignal(makeSignal())).status, "opened");
  const result = await f.executor.reconcilePosition("cab-signal-123", 90);
  assert.equal(result.status, "closed");
  assert.equal(f.snapshots.get("cab-signal-123").status, "closed");
  assert.equal(f.fills.length, 2);
  assert.equal([...f.intents.values()].find((intent) => intent.phase === "exit").state, "reconciled");
  assert.equal((await f.executor.reconcilePosition("cab-signal-123", 90)).status, "not_found");
  assert.equal(f.calls.filter(([kind]) => kind === "closeLong").length, 1);
});

test("wrong entry fill identity halts and preserves observed exposure without a strategy result", async () => {
  const f = fixture();
  f.exchange.queryFills = async () => [{
    symbol: "XRP-USDT", orderId: 999, tradeId: "other",
    side: "SELL", qty: "1", price: "100", time: NOW,
  }];
  const result = await f.executor.processSignal(makeSignal());
  assert.equal(result.status, "halted");
  assert.equal(f.snapshots.get("cab-signal-123").status, "opening");
  assert.equal(f.snapshots.get("cab-signal-123").exchangePosition.positionAmt, "1");
  assert.equal(f.fills.length, 0);
  assert.equal([...f.intents.values()][0].state, "unknown");
  assert.equal((await f.executor.processSignal(makeSignal())).status, "rejected");
  assert.equal(f.calls.filter(([kind]) => kind === "placeLong").length, 1);
});

test("a partial manual reduction or unsafe liquidation price halts without marking a strategy exit", async () => {
  const partial = fixture();
  assert.equal((await partial.executor.processSignal(makeSignal())).status, "opened");
  partial.exchangePosition.positionAmt = "0.4";
  assert.equal((await partial.executor.reconcilePosition("cab-signal-123", 90)).status, "halted");
  const observed = partial.snapshots.get("cab-signal-123");
  assert.equal(observed.status, "open");
  assert.equal(observed.remainingQty, 1);
  assert.equal(observed.exchangePosition.positionAmt, "0.4");
  assert.equal(partial.calls.some(([kind]) => kind === "closeLong"), false);

  const unsafe = fixture();
  assert.equal((await unsafe.executor.processSignal(makeSignal())).status, "opened");
  unsafe.exchangePosition.liquidationPrice = "94.9";
  const result = await unsafe.executor.reconcilePosition("cab-signal-123", 90);
  assert.equal(result.status, "halted");
  assert.match(result.reason, /liquidation price/);
  assert.equal(unsafe.snapshots.get("cab-signal-123").status, "open");
  assert.equal(unsafe.calls.some(([kind]) => kind === "closeLong"), false);
});

test("verified manual full close is separate from a strategy exit, but unexplained disappearance is not", async () => {
  const external = fixture();
  assert.equal((await external.executor.processSignal(makeSignal())).status, "opened");
  external.exchangePosition.positionAmt = "0";
  const closed = await external.executor.reconcilePosition("cab-signal-123");
  assert.equal(closed.status, "closed_external");
  assert.equal(closed.position.externalClose, true);
  assert.equal(closed.position.exitOrderId, undefined);
  assert.equal(external.calls.some(([kind]) => kind === "closeLong"), false);
  assert.equal((await external.executor.reconcilePosition("cab-signal-123")).status, "not_found");

  const liquidation = fixture();
  assert.equal((await liquidation.executor.processSignal(makeSignal())).status, "opened");
  liquidation.exchangePosition.positionAmt = "0";
  liquidation.exchange.queryFills = async () => [];
  const unknown = await liquidation.executor.reconcilePosition("cab-signal-123");
  assert.equal(unknown.status, "halted");
  assert.match(unknown.reason, /possible liquidation/);
  assert.equal(liquidation.snapshots.get("cab-signal-123").status, "open");
  assert.equal(liquidation.snapshots.get("cab-signal-123").externalClose, undefined);
  assert.equal(liquidation.snapshots.get("cab-signal-123").exchangePosition.positionAmt, "0");
});

test("an apparently full external close without closing-order proof stays unverified", async () => {
  const f = fixture();
  assert.equal((await f.executor.processSignal(makeSignal())).status, "opened");
  f.exchangePosition.positionAmt = "0";
  const queryOrder = f.exchange.queryOrder;
  f.exchange.queryOrder = async (symbol, id) => {
    const order = await queryOrder(symbol, id);
    return { ...order, reduceOnly: false, closePosition: false };
  };
  const result = await f.executor.reconcilePosition("cab-signal-123");
  assert.equal(result.status, "halted");
  assert.equal(f.snapshots.get("cab-signal-123").status, "open");
  assert.equal(f.snapshots.get("cab-signal-123").externalClose, undefined);
  assert.equal(f.calls.some(([kind]) => kind === "closeLong"), false);
});

test("unknown same-symbol activity prevents an external close even when SELL quantity matches", async () => {
  const f = fixture();
  assert.equal((await f.executor.processSignal(makeSignal())).status, "opened");
  f.exchangePosition.positionAmt = "0";
  const queryFills = f.exchange.queryFills;
  f.exchange.queryFills = async (symbol, options) => [
    ...(await queryFills(symbol, options)),
    { symbol: "XRP-USDT", orderId: 73, tradeId: "unrecognized",
      side: "UNKNOWN", qty: "0.2", price: "100", time: NOW },
  ];
  const result = await f.executor.reconcilePosition("cab-signal-123");
  assert.equal(result.status, "halted");
  assert.equal(f.snapshots.get("cab-signal-123").status, "open");
  assert.equal(f.intents.size, 1);
});

test("a failed exit commit leaves an unresolved intent and never rewrites the snapshot as closed", async () => {
  const f = fixture();
  assert.equal((await f.executor.processSignal(makeSignal())).status, "opened");
  f.store.commitVerifiedClose = async () => { throw new Error("database commit failed"); };
  assert.equal((await f.executor.reconcilePosition("cab-signal-123", 90)).status, "halted");
  assert.equal(f.snapshots.get("cab-signal-123").status, "open");
  assert.equal([...f.intents.values()].find((intent) => intent.phase === "exit").state, "unknown");
  assert.equal((await f.executor.reconcilePosition("cab-signal-123", 90)).status, "halted");
  assert.equal(f.calls.filter(([kind]) => kind === "closeLong").length, 1);

  const manual = fixture();
  assert.equal((await manual.executor.processSignal(makeSignal())).status, "opened");
  manual.exchangePosition.positionAmt = "0";
  manual.store.commitVerifiedClose = async () => { throw new Error("database commit failed"); };
  assert.equal((await manual.executor.reconcilePosition("cab-signal-123")).status, "halted");
  assert.equal(manual.snapshots.get("cab-signal-123").status, "open");
  assert.equal([...manual.intents.values()].find((intent) => intent.phase === "external").state, "unknown");
});

test("unknown own exit is observed but cannot be repeated or mislabelled as manual close", async () => {
  const f = fixture();
  assert.equal((await f.executor.processSignal(makeSignal())).status, "opened");
  f.exchange.closeLong = async () => {
    f.calls.push(["closeLong"]);
    f.exchangePosition.positionAmt = "0";
    throw new Error("timeout");
  };
  const first = await f.executor.reconcilePosition("cab-signal-123", 90);
  assert.equal(first.status, "halted");
  assert.equal(f.snapshots.get("cab-signal-123").exchangeObservation, "own_exit_submission_unknown");
  assert.equal([...f.intents.values()].find((intent) => intent.phase === "exit").state, "unknown");
  const repeated = await f.executor.reconcilePosition("cab-signal-123", 90);
  assert.equal(repeated.status, "halted");
  assert.match(repeated.reason, /own exit is unresolved/);
  assert.equal(f.calls.filter(([kind]) => kind === "closeLong").length, 1);
  assert.equal(f.snapshots.get("cab-signal-123").externalClose, undefined);
});

test("mismatched exit fill or leftover protective order cannot produce a confirmed exit", async () => {
  const mismatch = fixture();
  assert.equal((await mismatch.executor.processSignal(makeSignal())).status, "opened");
  const originalFills = mismatch.exchange.queryFills;
  mismatch.exchange.queryFills = async (symbol, options) => {
    const rows = await originalFills(symbol, options);
    return rows.map((row) => ({ ...row, qty: "0.5" }));
  };
  assert.equal((await mismatch.executor.reconcilePosition("cab-signal-123", 90)).status, "halted");
  assert.equal(mismatch.snapshots.get("cab-signal-123").status, "open");
  assert.equal(mismatch.fills.length, 1);
  assert.equal([...mismatch.intents.values()].find((intent) => intent.phase === "exit").state, "unknown");

  const pending = [];
  const stale = fixture({ existingOpenOrders: pending });
  assert.equal((await stale.executor.processSignal(makeSignal())).status, "opened");
  pending.push({ symbol: "XRP-USDT", orderId: 72 });
  assert.equal((await stale.executor.reconcilePosition("cab-signal-123", 90)).status, "halted");
  assert.equal(stale.snapshots.get("cab-signal-123").status, "open");
});

test("fresh same-symbol open orders block entry even if preflight reported ready", async () => {
  const f = fixture({ existingOpenOrders: [{ symbol: "XRP-USDT", orderId: 987 }] });
  const result = await f.executor.processSignal(makeSignal());
  assert.equal(result.status, "rejected");
  assert.match(result.reason, /open order/);
  assert.equal(f.claims.size, 0);
  assert.equal(f.calls.some(([kind]) => kind === "placeLong"), false);
});

test("entry and external-close fill queries use the real adapter's required fields", async () => {
  const f = fixture();
  const requests = [];
  const adapter = createBingXLiveApi({
    credentials: () => ({ key: "mock-key", secret: "mock-secret" }),
    clock: () => NOW,
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      const request = new URL(url);
      assert.equal(options.method, "GET");
      assert.equal(request.pathname, "/openApi/swap/v2/trade/allFillOrders");
      assert.equal(request.searchParams.get("currency"), "USDT");
      assert.equal(request.searchParams.get("tradingUnit"), "COIN");
      assert.ok(Number(request.searchParams.get("startTs")) > 0);
      assert.ok(Number(request.searchParams.get("endTs")) >= Number(request.searchParams.get("startTs")));
      requests.push(request);
      return new Response(JSON.stringify({
        code: 0,
        data: request.searchParams.has("orderId")
          ? [{ symbol: "XRP-USDT", orderId: 71, tradeId: "entry-fill", qty: "1", price: "100", side: "BUY", time: NOW }]
          : [{ symbol: "XRP-USDT", orderId: 72, tradeId: "external-fill", qty: "1", price: "102", side: "SELL", time: NOW }],
      }), { status: 200 });
    },
  });
  f.exchange.queryFills = adapter.queryFills;
  assert.equal((await f.executor.processSignal(makeSignal())).status, "opened");
  f.exchangePosition.positionAmt = "0";
  assert.equal((await f.executor.reconcilePosition("cab-signal-123")).status, "closed_external");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].searchParams.get("orderId"), "71");
  assert.equal(requests[1].searchParams.get("orderId"), null);
});