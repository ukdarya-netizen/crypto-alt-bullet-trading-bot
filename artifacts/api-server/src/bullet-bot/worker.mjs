import { createHash } from "node:crypto";
import { capturePositionStrategy, positionStrategy, pinPositionStrategy } from "./position-strategy.mjs";
import { SIGNAL_TTL_MS, validateSignal } from "./contract.mjs";
import { initialPosition, evaluatePosition, isPaperAllocationFeasible } from "./engine.mjs";
import { startScenarios, observeScenarios } from "./scenario-model.mjs";
import {
  PAPER_TAKER_FEE_RATE,
  PAPER_FEE_MODEL_VERSION,
  paperFillCosts,
  resolvePaperFeeModel,
} from "./paper-fees.mjs";
import {
  PAPER_BASE_MARGIN_USDT,
  PAPER_ASSUMED_CLOSE_FEE_RATE,
  assessPaperMargin,
  paperMarginSnapshot,
  unverifiedPaperMargin,
} from "./paper-margin.mjs";
import {
  fundingIntervalFromHours,
  inferFundingInterval,
  reconcilePaperFunding,
} from "./paper-funding.mjs";
import { buildSourceExitEvidence } from "./source-exit-evidence.mjs";
import { applySourceProtection, evaluateSourceFollower } from "./source-position-control.mjs";
import { FULL_TAKE_5PCT, applyFullTake } from "./fixed-price-take-profit.mjs";
import { validateSourceCommand, directCloseRequest } from "./source-command-contract.mjs";

const MAX_PAPER_ENTRIES_PER_TICK = 10;
const PAPER_QUOTE_CONCURRENCY = 6;
const PAPER_SCENARIO_PASS_INTERVAL_MS = 15_000;
const MAX_PAPER_SCENARIO_OBSERVATIONS_PER_PASS = 10;

const safeReason = (error) =>
  error instanceof Error ? error.name + ": " + error.message.slice(0, 300) : "Unknown error";

function validatedPrice(value, field) {
  if (
    typeof value !== "string" ||
    !/^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) ||
    !Number.isFinite(Number(value)) ||
    Number(value) <= 0
  ) {
    throw new TypeError(`BingX ticker returned an invalid ${field}`);
  }
  return value;
}

const validatedLastPrice = (value) => validatedPrice(value, "lastPrice");

function validatedMarkObservation(mark) {
  if (
    !mark ||
    typeof mark !== "object" ||
    typeof mark.markPrice !== "string" ||
    !Number.isFinite(Number(mark.markPrice)) ||
    Number(mark.markPrice) <= 0 ||
    typeof mark.observedAt !== "string" ||
    !Number.isFinite(Date.parse(mark.observedAt)) ||
    mark.source !== "BingX public swap premiumIndex"
  ) {
    throw new TypeError("BingX premiumIndex returned an invalid mark observation");
  }
  return {
    price: mark.markPrice,
    at: new Date(Date.parse(mark.observedAt)).toISOString(),
    source: mark.source,
  };
}

async function readFundingHistory(exchange, position, now, maxPages = 10) {
  if (typeof exchange.fundingHistory !== "function") {
    throw new Error("BingX public funding history is unavailable");
  }
  const startTime = Date.parse(position.entryAt);
  const endTime = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(startTime) || !Number.isSafeInteger(endTime) || endTime <= startTime) {
    return [];
  }

  const all = [];
  let cursor = startTime;
  for (let page = 0; page < maxPages; page += 1) {
    const batch = await exchange.fundingHistory(position.symbol, {
      startTime: cursor,
      endTime,
      limit: 1000,
    });
    if (!Array.isArray(batch)) throw new Error("BingX funding history response is invalid");
    all.push(...batch);
    if (batch.length < 1000) return all;
    const lastTime = Number(batch.at(-1)?.fundingTime);
    if (!Number.isSafeInteger(lastTime) || lastTime < cursor) {
      throw new Error("BingX funding history pagination did not advance");
    }
    cursor = lastTime + 1;
    if (cursor > endTime) return all;
  }
  throw new Error("BingX funding history exceeded the safe pagination limit");
}

async function historicalSettlementPrice(exchange, symbol, fundingTime) {
  if (typeof exchange.historicalKlines !== "function") return null;
  const klines = await exchange.historicalKlines(symbol, {
    startTime: Math.max(0, fundingTime - 120_000),
    endTime: fundingTime + 120_000,
    limit: 10,
  });
  if (!Array.isArray(klines)) return null;
  const nearest = klines
    .map((kline) => ({
      ...kline,
      observedAt: Number(kline.time) + 60_000,
      distance: Math.abs(Number(kline.time) + 60_000 - fundingTime),
    }))
    .filter((kline) =>
      Number.isFinite(kline.distance) &&
      kline.distance <= 90_000 &&
      Number.isFinite(Number(kline.close)) &&
      Number(kline.close) > 0)
    .sort((a, b) => a.distance - b.distance)[0];
  if (!nearest) return null;
  return {
    price: nearest.close,
    observedAt: new Date(nearest.observedAt).toISOString(),
    source: "BingX public 1m last-trade kline close",
    estimation: "last_trade_kline_close_proxy",
  };
}

function orderLinkId(id, suffix = "") {
  return `btb-${createHash("sha256").update(id).digest("hex").slice(0, 25)}${suffix}`;
}

/** One leader-locked pass; all durable operations use the store's PostgreSQL tables. */
export function createWorker({ store, exchange, feeReader, mode = "paper", clock = Date.now,
  strategyAuthority = "policy", entryGuard, exitStrategy = "source" }) {
  if (!["source", FULL_TAKE_5PCT].includes(exitStrategy)) throw new TypeError("Invalid exit strategy");
  if (!["policy", "source"].includes(strategyAuthority)) {
    throw new TypeError("PAPER strategyAuthority must be source or policy");
  }
  const strategyDefaults = capturePositionStrategy({ exitStrategy, strategyAuthority });
  if (!["paper", "live"].includes(mode)) throw new Error("Invalid execution mode");
  // The exchange adapter is implemented, but live exit reconciliation is not
  // independently proven. Never open a real position that this worker cannot
  // subsequently manage safely.
  if (mode === "live")
    throw new Error("PAPER_ONLY_SIGNAL: live execution is not available");
  if (!store || !exchange) throw new Error("Store and exchange are required");

  async function open(row) {
    const signal = row.body;
    const id = signal.sourceSignalId;
    const entryBlock = entryGuard ? await entryGuard(id) : false;
    if (entryBlock === "maintenance") return { kind: "waiting", reason: "owner_reset_in_progress" };
    if (entryBlock) {
      await store.setSignalStatus(id, "rejected", "source_entry_cancelled");
      return;
    }
    if (row.status === "opening") {
      const existing = (await store.listOpenPositions()).find((p) => p.sourceSignalId === id);
      if (existing) {
        await store.setSignalStatus(id, "open");
        return;
      }
      if (mode === "live") {
        // A lost HTTP response is not proof that a market order failed. An
        // operator must reconcile exchange orders before any new entry.
        await store.setSignalStatus(id, "error", "entry_outcome_requires_exchange_reconciliation");
        return;
      }
    }
    const result = validateSignal(signal, clock());
    if (result.status !== 200) {
      await store.setSignalStatus(id, "rejected", result.error.code);
      return;
    }
    if (clock() - Date.parse(signal.signalAt) >= SIGNAL_TTL_MS) {
      await store.setSignalStatus(id, "rejected", "stale_at_execution");
      return;
    }

    // Instrument validation happens before an attempted entry; a confirmed
    // Sender quantities were sized for another venue. Use a BingX-compatible
    // quantity rounded down only; never enlarge the PAPER position or its risk.
    let validated;
    try {
      validated = await exchange.validateOrder(signal);
    } catch (error) {
      // A network/429/5xx failure says nothing about the instrument: leave
      // the signal pending so the next tick retries while it is fresh.
      if (mode === "paper" && error?.transient === true) throw error;
      await store.setSignalStatus(id, "rejected", safeReason(error));
      return;
    }
    await store.setSignalStatus(id, "opening");
    if (mode === "paper") {
      const quote = await exchange.ticker(signal.symbol);
      const price = Number(quote.ask1Price || quote.lastPrice);
      const quantity = Number(
        exchange.capQuantity?.(validated, quote.ask1Price || quote.lastPrice)
        ?? validated?.quantity ?? signal.quantity,
      );
      // Sender sizing is for $10 initial isolated margin at 10x. A market
      // move cannot silently enlarge the PAPER position beyond $100 notional.
      if (!Number.isFinite(price) || price <= 0 ||
          !Number.isFinite(quantity) || quantity <= 0 ||
          quantity > Number(signal.quantity) ||
          quantity * price > 100.000001) {
        await store.setSignalStatus(id, "rejected", "entry_notional_exceeds_10_usd_at_10x");
        return;
      }
      if (validated?.instrument?.minQuantity &&
          quantity < validated.instrument.minQuantity) {
        await store.setSignalStatus(id, "rejected", "bingx_min_quantity_at_entry");
        return;
      }
      if (validated?.minNotional && quantity * price < validated.minNotional) {
        await store.setSignalStatus(id, "rejected", "bingx_min_notional_at_entry");
        return;
      }
      if (
        signal.patternId === "impulse_buy" &&
        (signal.symbol === "BTCUSDT" || signal.symbol === "BTC-USDT")
      ) {
        await store.setSignalStatus(
          id,
          "rejected",
          "strategy4_paper_impulse_btc_runner_unsupported",
        );
        return;
      }
      let marketMark = null;
      let nextFundingTime = null;
      let fundingIntervalMs = null;
      try {
        const mark = await exchange.premiumIndex(signal.symbol);
        marketMark = validatedMarkObservation(mark);
        nextFundingTime = Number(mark.nextFundingTime);
        if (!Number.isSafeInteger(nextFundingTime) || nextFundingTime <= 0) {
          throw new TypeError("BingX premiumIndex returned an invalid funding time");
        }
        fundingIntervalMs = fundingIntervalFromHours(mark.fundingIntervalHours);
        if (fundingIntervalMs === null && typeof exchange.fundingHistory === "function") {
          try {
            const recentFunding = await exchange.fundingHistory(signal.symbol, {
              startTime: Math.max(0, clock() - 7 * 24 * 60 * 60_000),
              endTime: clock(),
              limit: 1000,
            });
            fundingIntervalMs = inferFundingInterval(recentFunding);
          } catch {
            // A missing cadence sample is kept explicitly unknown. The first
            // nextFundingTime is still monitored; long downtime stays unsafe.
          }
        }
      } catch {
        // Entry is based on the validated ask, never on premiumIndex. A missing
        // mark is exposed as incomplete rather than substituted with lastPrice.
      }
      const position = pinPositionStrategy(initialPosition({
        ...signal, stopLoss: validated?.stopLoss ?? signal.stopLoss,
      }, {
        price,
        quantity,
        at: new Date(clock()).toISOString(),
        mode,
        quantityPrecision: Number.isInteger(validated?.instrument?.quantityPrecision)
          ? validated.instrument.quantityPrecision
          : undefined,
        quantityPrecisionSource: Number.isInteger(validated?.instrument?.quantityPrecision)
          ? "bingx_contract_metadata"
          : "conservative_default",
      }), strategyDefaults);
      if (strategyAuthority === "source") {
        Object.assign(position, { strategyAuthority, coreQty: position.remainingQty,
          coreOpen: true, runnerQty: 0, runnerOpen: false, runnerStopPrice: null });
      }
      if (strategyAuthority !== "source" && !isPaperAllocationFeasible(position)) {
        const rejectionReason = position.patternId === "impulse_buy" &&
          (position.symbol === "BTCUSDT" || position.symbol === "BTC-USDT")
          ? "strategy4_paper_impulse_btc_runner_unsupported"
          : "paper_allocation_unsplittable_at_contract_precision";
        await store.setSignalStatus(
          id,
          "rejected",
          rejectionReason,
        );
        return;
      }
      position.feeModel = await resolvePaperFeeModel(feeReader, signal.symbol, clock);
      position.scenarioModel = startScenarios(position);
      const initialMarginAssessment = assessPaperMargin({
        entryPrice: position.entryPrice,
        stopPrice: position.stopPrice,
        remainingQty: position.remainingQty,
        marginHeldUsdt: PAPER_BASE_MARGIN_USDT,
        closeFeeRate: position.feeModel.rate,
      });
      const initialTopUp = initialMarginAssessment.topUpUsdt;
      const initialMarginHeld = Number(
        (PAPER_BASE_MARGIN_USDT + initialTopUp).toFixed(8),
      );
      const fundedAssessment = assessPaperMargin({
        entryPrice: position.entryPrice,
        stopPrice: position.stopPrice,
        remainingQty: position.remainingQty,
        marginHeldUsdt: initialMarginHeld,
        closeFeeRate: position.feeModel.rate,
      });
      const initialMarginTopUps = initialTopUp > 0
        ? [{
            amountUsdt: initialTopUp,
            at: new Date(clock()).toISOString(),
            reason: "entry_stop_buffer_deficit",
            source: "paper_free_balance",
          }]
        : [];
      position.marginHeldUsd = initialMarginHeld;
      position.paperMargin = paperMarginSnapshot({
        assessment: fundedAssessment,
        assessedAt: new Date(clock()).toISOString(),
        addedMarginUsdt: initialTopUp,
        topUps: initialMarginTopUps,
        closeFeeRateAssumed: position.feeModel.rate,
      });
      position.marketMark = marketMark;
      position.marketMarkStatus = marketMark ? "current" : "unavailable";
      position.fundingPaidUsdt = 0;
      position.fundingStatus = marketMark ? "current" : "incomplete";
      position.fundingNextFundingTime = nextFundingTime;
      position.fundingIntervalMs = fundingIntervalMs;
      position.fundingObservedNextFundingTime = nextFundingTime;
      position.fundingObservedAt = marketMark?.at ?? null;
      position.fundingObservedIntervalMs = fundingIntervalMs;
      position.fundingHistoryAttemptAt = null;
      position.fundingSettlements = [];
      const reserved = await store.openPaperPosition({
        ...position,
        marginHeldUsd: initialMarginHeld,
        realizedPnlUsdt: 0,
      });
      if (reserved.kind === "insufficient") {
        // Deliberately terminal, not retried later: getPending() only ever
        // surfaces 'pending'/'opening' rows, so a 'rejected' signal is never
        // revisited even once other positions close and free up balance.
        // Owner-confirmed policy (2026-09-29): a delayed retry would have to
        // fetch a fresh quote and would fill at whatever price the market has
        // moved to by the time capital frees up, hours or days after
        // signal.signalAt -- divorced from the SIGNAL_TTL_MS (10 min)
        // freshness guarantee every other entry path enforces, and no longer
        // comparable to the price the source itself traded at. Treated as an
        // accepted capital limitation instead: PAPER's fixed $100/10x sizing
        // means simultaneous signals can outrun free balance by design.
        await store.setSignalStatus(id, "rejected", "insufficient_free_paper_balance");
        try {
          // Best-effort: this notification record must never flip an
          // already-correctly-set "rejected" status to "error" (the caller's
          // catch block would do exactly that if this threw uncaught).
          await store.recordEvent(id, "paper_rejected_insufficient_balance", {
            symbol: signal.symbol,
            requiredUsdt: initialMarginHeld,
          });
        } catch {
          // Telegram delivery is not this signal's terminal outcome.
        }
        return;
      }
      await store.setSignalStatus(id, "open");
      if (reserved.kind === "opened") {
        const saved = reserved.position ?? position;
        const entryFill = saved.paperFills?.[0];
        await store.recordEvent(id, "paper_entry", {
          source: "BingX",
          price,
          requestedQuantity: signal.quantity,
          quantity: position.quantity,
          requestedStopLoss: signal.stopLoss,
          initialStop: position.stopPrice,
          feeUsdt: entryFill?.feeUsdt ?? null,
          feeRate: entryFill?.feeRate ?? PAPER_TAKER_FEE_RATE,
          feeModelVersion: entryFill?.feeModelVersion ?? PAPER_FEE_MODEL_VERSION,
          feeTierVerified: entryFill?.feeTierVerified ?? false,
          feeSource: entryFill?.feeSource ?? null,
          feeCheckedAt: entryFill?.feeCheckedAt ?? null,
          marginHeldUsd: saved.marginHeldUsd,
          paperMargin: saved.paperMargin,
        });
      }
      return;
    }

    // One-way netting cannot safely represent independent Bullet trades in
    // the same symbol. No market order is sent if one already exists.
    const other = await exchange.getPosition(signal.symbol);
    if (other.length) {
      await store.setSignalStatus(id, "rejected", "existing_exchange_position_same_symbol");
      return;
    }
    const wallet = await exchange.walletBalance();
    if (
      !Number.isFinite(Number(wallet.totalAvailableBalance)) ||
      Number(wallet.totalAvailableBalance) < 10
    ) {
      await store.setSignalStatus(id, "rejected", "insufficient_initial_margin");
      return;
    }
    const link = orderLinkId(id);
    // The live adapter attaches a market protective stop atomically to its
    // market entry; an accepted create-order response is NOT a fill.
    await exchange.openProtected(signal, { orderLinkId: link });
    const order = await exchange.getOrder(link);
    const positions = await exchange.getPosition(signal.symbol);
    const fill = positions.length === 1 ? positions[0] : null;
    if (
      order?.orderStatus !== "Filled" ||
      !fill ||
      fill.side !== "Buy" ||
      +fill.size <= 0 ||
      +fill.avgPrice <= 0 ||
      +fill.stopLoss <= 0
    ) {
      await store.setSignalStatus(id, "error", "entry_not_confirmed_or_stop_missing");
      return;
    }
    const position = pinPositionStrategy(initialPosition(signal, {
      price: Number(fill.avgPrice),
      quantity: Number(fill.size),
      at: new Date(clock()).toISOString(),
      mode,
    }), strategyDefaults);
    if (strategyAuthority === "source") {
      Object.assign(position, { strategyAuthority, coreQty: position.remainingQty,
        coreOpen: true, runnerQty: 0, runnerOpen: false, runnerStopPrice: null });
    }
    await store.upsertPosition(position);
    await store.setSignalStatus(id, "open");
    await store.recordEvent(id, "exchange_entry_verified", {
      orderLinkId: link,
      price: position.entryPrice,
      quantity: position.quantity,
    });
  }

  async function refreshPaperMark(position) {
    if (typeof exchange.premiumIndex !== "function") return position;
    let mark;
    let observation;
    try {
      mark = await exchange.premiumIndex(position.symbol);
      observation = validatedMarkObservation(mark);
    } catch {
      const next = { ...position, marketMarkStatus: "unavailable" };
      const saved = await store.settlePaperPosition(position, next);
      return saved.kind === "settled" ? (saved.position ?? next) : position;
    }
    const next = {
      ...position,
      marketMark: observation,
      marketMarkStatus: "current",
    };
    const nextFundingTime = Number(mark.nextFundingTime);
    if (Number.isSafeInteger(nextFundingTime) && nextFundingTime > 0) {
      next.fundingObservedNextFundingTime = nextFundingTime;
      next.fundingObservedAt = observation.at;
    }
    const interval = fundingIntervalFromHours(mark.fundingIntervalHours);
    if (interval !== null) {
      next.fundingObservedIntervalMs = interval;
      next.fundingIntervalObservedAt = observation.at;
      const storedInterval = Number(next.fundingIntervalMs);
      if (
        !Number.isSafeInteger(storedInterval) ||
        storedInterval < 30 * 60_000 ||
        storedInterval > 24 * 60 * 60_000
      ) {
        next.fundingIntervalMs = interval;
      }
    }
    const saved = await store.settlePaperPosition(position, next);
    return saved.kind === "settled" ? (saved.position ?? next) : position;
  }

  async function watchPaper(
    record,
    sourceExitEvidence = null,
    sourceExitRequestId = null,
    directCommand = null,
  ) {
    const position = record.snapshot;
    const { strategyAuthority, exitStrategy } = positionStrategy(position, strategyDefaults);
    if (!sourceExitEvidence &&
        mode === "paper" &&
        typeof store.listPendingSourceExitRequests === "function") {
      const [pending] = await store.listPendingSourceExitRequests({
        sourceSignalId: position.sourceSignalId,
        limit: 1,
      });
      if (pending) {
        sourceExitEvidence = pending.evidence;
        sourceExitRequestId = pending.id;
      }
    }
    if (sourceExitEvidence &&
        (!Number.isFinite(Number(position.remainingQty)) ||
         Number(position.remainingQty) <= 0)) {
      throw new Error("A source-directed PAPER close requires a positive remaining quantity");
    }
    const quote = await quoteFor(position.symbol);
    const quotePrice = validatedLastPrice(quote?.lastPrice);
    if (sourceExitEvidence) {
      const quoteAt = Date.parse(quote?.quoteAt ?? "");
      if (!Number.isFinite(quoteAt) || Math.abs(clock() - quoteAt) > 60_000) {
        throw new Error("A source-directed PAPER close requires a fresh exchange-timestamped quote");
      }
    }
    const observedAt = new Date(clock()).toISOString();
    const price = Number(quotePrice);
    let evaluationPosition = position;
    if (
      !Number.isInteger(position.paperQuantityPrecision) &&
      typeof exchange.instrument === "function"
    ) {
      try {
        const filters = await exchange.instrument(position.symbol);
        if (
          Number.isInteger(filters?.quantityPrecision) &&
          filters.quantityPrecision >= 0 &&
          filters.quantityPrecision <= 12
        ) {
          evaluationPosition = {
            ...position,
            paperQuantityPrecision: filters.quantityPrecision,
            paperQuantityPrecisionSource: "bingx_contract_metadata",
          };
        }
      } catch {
        // Legacy PAPER fills stay conservatively rounded down if filters are
        // unavailable; no quantity is ever increased to manufacture a tranche.
      }
    }
    let result = strategyAuthority === "source"
      ? evaluateSourceFollower(evaluationPosition, directCommand ? {
        sourceAction: "hold", sourceSignalId: position.sourceSignalId, symbol: position.symbol,
        sourceStopLossPrice: directCommand.stopPrice, observedAt,
        commandId: directCommand.commandId,
      } : {
        ...position.sourceObservation,
        sourceSignalId: position.sourceSignalId, symbol: position.symbol,
      }, price, { observedAt })
      : evaluatePosition(evaluationPosition, { price, at: observedAt });
    if (strategyAuthority !== "source" && position.sourceObservation?.sourceAction === "hold") {
      result = applySourceProtection(result, evaluationPosition, {
        ...position.sourceObservation,
        sourceSignalId: position.sourceSignalId, symbol: position.symbol,
      }, price, { observedAt });
    }
    if (exitStrategy === FULL_TAKE_5PCT) {
      result = applyFullTake(result, evaluationPosition, price, observedAt);
      result.next.exitStrategy = FULL_TAKE_5PCT;
    }
    if (sourceExitEvidence) {
      // A source close or withdrawal is a PAPER-only exit instruction. Source
      // prices remain provenance only; the simulated fill uses the fresh bid.
      const withdrawal = sourceExitEvidence.reason === "source_withdrawal";
      result.actions = [{
        type: "close_all",
        quantity: Number(position.remainingQty),
        price,
        reason: withdrawal ? "source_bullet_withdrawn" : "source_bullet_closed",
      }];
      result.next.remainingQty = 0;
      result.next.coreOpen = false;
      result.next.runnerOpen = false;
      result.next.status = "closed";
      result.next[withdrawal ? "sourceWithdrawal" : "sourceClosure"] = {
        ...sourceExitEvidence,
      };
    }
    if (position.scenarioModel) {
      result.next.scenarioModel = observeScenarios(position.scenarioModel, {
        price,
        bid: Number(quote?.bid1Price),
        at: observedAt,
      });
    }
    const closingActions = result.actions.filter(
      (action) => action.type !== "raise_stop",
    );
    const bidPrice = closingActions.length
      ? Number(validatedPrice(quote?.bid1Price, "bid1Price"))
      : null;
    result.next.marketQuote = {
      price: quotePrice,
      at: observedAt,
      source: "BingX public swap ticker",
    };
    if (position.fundingStatus === "legacy_unknown" ||
        !Array.isArray(position.paperFills) || position.paperFills.length === 0) {
      result.next.fundingStatus = "legacy_unknown";
    } else {
      const expectedFundingTime = Number(position.fundingNextFundingTime);
      if (Number.isSafeInteger(expectedFundingTime) &&
          expectedFundingTime > 0 && expectedFundingTime <= clock()) {
        // A protective close must commit before slow market-data requests.
        // Keep the funding debt visible and eligible for closed-position
        // backfill instead of making its released margin look final.
        result.next.fundingStatus = "incomplete";
      }
    }
    let realized = Number(position.realizedPnlUsdt ?? 0);
    let grossRealized = Number(
      position.grossRealizedPnlUsdt ?? position.realizedPnlUsdt ?? 0,
    );
    let feesPaid = Number(position.feesPaidUsdt ?? 0);
    const paperFills = Array.isArray(position.paperFills)
      ? [...position.paperFills]
      : [];
    const exitFills = [];
    if (result.actions.length) {
      const exitFeeModel = closingActions.length
        ? await resolvePaperFeeModel(feeReader, position.symbol, clock)
        : null;
      for (const action of result.actions) {
        if (action.type !== "raise_stop") {
          const triggerPrice = Number(action.price);
          const fillPrice = bidPrice;
          const costs = paperFillCosts(fillPrice, action.quantity, exitFeeModel.rate);
          const grossPnl = Number(
            (action.quantity * (fillPrice - position.entryPrice)).toFixed(8),
          );
          realized = Number((realized + grossPnl - costs.feeUsdt).toFixed(8));
          grossRealized = Number((grossRealized + grossPnl).toFixed(8));
          feesPaid = Number((feesPaid + costs.feeUsdt).toFixed(8));
          const fill = {
            type: "exit",
            price: fillPrice,
            fillPrice,
            fillPriceSource: "BingX public swap ticker bid1Price",
            triggerPrice,
            triggerPriceSource: "BingX public swap ticker lastPrice",
            quantity: action.quantity,
            notionalUsdt: costs.notionalUsdt,
            feeUsdt: costs.feeUsdt,
            feeRate: exitFeeModel.rate,
            feeModelVersion: exitFeeModel.version,
            feeTierVerified: exitFeeModel.accountTierVerified,
            feeSource: exitFeeModel.source,
            feeCheckedAt: exitFeeModel.checkedAt,
            feeScheduleUrl: exitFeeModel.scheduleUrl,
            executionType: "simulated_market_taker",
            reason: action.reason,
            occurredAt: observedAt,
          };
          paperFills.push(fill);
          exitFills.push({ action, fill });
        }
      }
    }
    if (exitFills.length) {
      result.next.realizedPnlUsdt = realized;
      result.next.grossRealizedPnlUsdt = grossRealized;
      result.next.feesPaidUsdt = feesPaid;
      result.next.paperFills = paperFills;
    }

    const previousHeld = Number(position.marginHeldUsd);
    const positionFeeRate = Number(position.feeModel?.rate);
    const closeFeeRate = Number.isFinite(positionFeeRate) &&
      positionFeeRate >= 0 && positionFeeRate < 0.1
      ? positionFeeRate : PAPER_ASSUMED_CLOSE_FEE_RATE;
    result.next.marginHeldUsd =
      result.next.status === "closed"
        ? 0
        : Number((
            previousHeld * result.next.remainingQty /
            Number(position.remainingQty)
          ).toFixed(8));
    let settlementPrevious = position;
    const marginAt = observedAt;
    const existingMargin = position.paperMargin ?? {};
    const priorTopUps = Array.isArray(existingMargin.topUps)
      ? existingMargin.topUps
      : [];
    const priorAddedMargin = Number(existingMargin.addedMarginUsdt ?? 0);
    const riskStopPrice = (snapshot) =>
      snapshot.coreOpen === false && snapshot.runnerOpen
        ? Number(snapshot.runnerStopPrice ?? snapshot.stopPrice)
        : Number(snapshot.stopPrice);

    if (result.next.status === "closed") {
      const prior = position.paperMargin ?? unverifiedPaperMargin({
        assessedAt: marginAt,
        reason: "legacy_margin_assessment_unavailable",
      });
      result.next.paperMargin = {
        ...prior,
        status: "closed",
        stopRequiredMarginUsdt: 0,
        stopBufferUsdt: 0,
        topUpRequiredUsdt: 0,
        assessedAt: marginAt,
      };
    } else {
      let assessment = null;
      let currentStopAssessment = null;
      try {
        if (!Number.isFinite(previousHeld) || previousHeld <= 0) {
          throw new TypeError("Historical PAPER held margin is unavailable");
        }
        assessment = assessPaperMargin({
          entryPrice: result.next.entryPrice,
          stopPrice: riskStopPrice(result.next),
          remainingQty: result.next.remainingQty,
          marginHeldUsdt: result.next.marginHeldUsd,
          closeFeeRate,
        });
        currentStopAssessment = assessPaperMargin({
          entryPrice: position.entryPrice,
          stopPrice: riskStopPrice(position),
          remainingQty: position.remainingQty,
          marginHeldUsdt: result.next.marginHeldUsd,
          closeFeeRate,
        });
      } catch {
        result.next.paperMargin = unverifiedPaperMargin({
          assessedAt: marginAt,
          addedMarginUsdt: Number.isFinite(priorAddedMargin) && priorAddedMargin >= 0
            ? priorAddedMargin
            : 0,
          topUps: priorTopUps,
          reason: "legacy_margin_fields_unavailable",
        });
      }

      // A stop hit is settled first; adding funds immediately before closing
      // would be unnecessary. Stops which remain active are checked and topped
      // up from the PAPER wallet only.
      if (assessment && closingActions.length === 0) {
        const requiredTopUp = Math.max(
          assessment.topUpUsdt,
          currentStopAssessment?.topUpUsdt ?? 0,
        );
        const riskAssessment =
          (currentStopAssessment?.topUpUsdt ?? 0) > assessment.topUpUsdt
            ? currentStopAssessment
            : assessment;
        const topUp = requiredTopUp;
        const topUps = topUp > 0
          ? [...priorTopUps, {
              amountUsdt: topUp,
              at: marginAt,
              reason: "stop_buffer_deficit",
              source: "paper_free_balance",
            }]
          : priorTopUps;
        const addedMargin = priorAddedMargin + topUp;
        if (topUp > 0) {
          const nextHeld = Number((result.next.marginHeldUsd + topUp).toFixed(8));
          const fundedAssessment = assessPaperMargin({
            entryPrice: result.next.entryPrice,
            stopPrice: riskStopPrice(result.next),
            remainingQty: result.next.remainingQty,
            marginHeldUsdt: nextHeld,
            closeFeeRate,
          });
          const fundedCurrentStopAssessment = assessPaperMargin({
            entryPrice: position.entryPrice,
            stopPrice: riskStopPrice(position),
            remainingQty: position.remainingQty,
            marginHeldUsdt: nextHeld,
            closeFeeRate,
          });
          const candidate = {
            ...position,
            marginHeldUsd: nextHeld,
            paperMargin: paperMarginSnapshot({
              assessment: fundedCurrentStopAssessment,
              assessedAt: marginAt,
              addedMarginUsdt: addedMargin,
              topUps,
              closeFeeRateAssumed: closeFeeRate,
            }),
          };
          const toppedUp = await store.topUpPaperPosition(
            position,
            candidate,
            topUp,
            {
              kind: "paper_margin_top_up",
              detail: {
                amountUsdt: topUp,
                marginHeldUsd: nextHeld,
                requiredMarginUsdt: fundedCurrentStopAssessment.requiredMarginUsdt,
                stopBufferUsdt: fundedCurrentStopAssessment.stopBufferUsdt,
                model: candidate.paperMargin.model,
              },
            },
          );
          if (toppedUp.kind === "stale") return;
          if (toppedUp.kind === "topped_up") {
            settlementPrevious = toppedUp.position;
            result.next = {
              ...result.next,
              marginHeldUsd: toppedUp.position.marginHeldUsd,
              paperMargin: paperMarginSnapshot({
                assessment: fundedAssessment,
                assessedAt: marginAt,
                addedMarginUsdt: addedMargin,
                topUps,
                closeFeeRateAssumed: closeFeeRate,
              }),
            };
          } else {
            // Preserve normal stop monitoring and persist the explicit shortfall.
            result.next.paperMargin = paperMarginSnapshot({
              assessment: riskAssessment,
              assessedAt: marginAt,
              addedMarginUsdt: priorAddedMargin,
              topUps: priorTopUps,
              closeFeeRateAssumed: closeFeeRate,
            });
          }
        } else {
          result.next.paperMargin = paperMarginSnapshot({
            assessment: riskAssessment,
            assessedAt: marginAt,
            addedMarginUsdt: priorAddedMargin,
            topUps: priorTopUps,
            closeFeeRateAssumed: closeFeeRate,
          });
        }
      } else if (assessment) {
        result.next.paperMargin = paperMarginSnapshot({
          assessment,
          assessedAt: marginAt,
          addedMarginUsdt: priorAddedMargin,
          topUps: priorTopUps,
          closeFeeRateAssumed: closeFeeRate,
        });
      }
    }
    // The wallet delta and the snapshot commit together; a failed event log
    // cannot double-credit a replayed paper close.
    const actionEvents = result.actions.map((action) => {
      const exit = exitFills.find((entry) => entry.action === action)?.fill;
      return {
        kind: `paper_${action.type}`,
        detail: {
          price,
          quantity: action.quantity,
          stopPrice: action.stopPrice ?? null,
          ...(action.sourceProtection ? { sourceProtection: action.sourceProtection } : {}),
          reason: action.reason,
          triggerPrice: exit?.triggerPrice ?? null,
          triggerPriceSource: exit?.triggerPriceSource ?? null,
          fillPrice: exit?.fillPrice ?? null,
          fillPriceSource: exit?.fillPriceSource ?? null,
          feeUsdt: exit?.feeUsdt ?? null,
          ...(sourceExitEvidence
            ? {
                [sourceExitEvidence.reason === "source_withdrawal"
                  ? "sourceWithdrawal"
                  : "sourceClosure"]: { ...sourceExitEvidence },
              }
            : {}),
        },
      };
    });
    const settled = await store.settlePaperPosition(
      settlementPrevious,
      result.next,
      {
        events: actionEvents,
        closeSignal: result.next.status === "closed",
        ...(sourceExitRequestId !== null
          ? { sourceExitRequestId }
          : {}),
      },
    );
    if (settled.kind === "stale") return;
    return settled.position ?? result.next;
  }

  function closedAt(position, fallback) {
    if (position.status !== "closed") return fallback;
    const exitTimes = (position.paperFills ?? [])
      .filter((fill) => fill?.type === "exit")
      .map((fill) => Date.parse(fill.occurredAt))
      .filter(Number.isSafeInteger);
    return exitTimes.length ? Math.max(...exitTimes) : fallback;
  }

  function validFundingInterval(value) {
    const interval = Number(value);
    return Number.isSafeInteger(interval) &&
      interval >= 30 * 60_000 &&
      interval <= 24 * 60 * 60_000
      ? interval
      : null;
  }

  function validSourceTimestamp(value) {
    if (typeof value !== "string") return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  async function observeSourcePosition(position, source) {
    const { strategyAuthority } = positionStrategy(position, strategyDefaults);
    const sourceUpdatedAtMs = validSourceTimestamp(source.sourceUpdatedAt);
    if ((sourceUpdatedAtMs === null && source.sourceAction !== "unknown") ||
        sourceUpdatedAtMs > clock()) return false;
    const sourceObservation = {
      status: source.sourceStatus,
      sourceAction: source.sourceAction ?? null,
      sourceStopLossPrice: source.sourceStopLossPrice ?? null,
      sourceTrailingStopLevel: source.sourceTrailingStopLevel ?? null,
      sourceLastMilestone: source.sourceLastMilestone ?? null,
      sourceUpdatedAt: sourceUpdatedAtMs === null ? null : new Date(sourceUpdatedAtMs).toISOString(),
      sourceCancelReason: typeof source.sourceCancelReason === "string"
        ? source.sourceCancelReason.slice(0, 300)
        : null,
      observedAt: new Date(clock()).toISOString(),
    };
    const previousObservation = position.sourceObservation;
    if (strategyAuthority !== "source" && sourceObservation.sourceAction === "hold" &&
        previousObservation?.sourceAction === "hold") {
      sourceObservation.sourceTrailingStopLevel = Math.max(
        Number(sourceObservation.sourceTrailingStopLevel) || 0,
        Number(previousObservation.sourceTrailingStopLevel) || 0,
      ) || null;
      sourceObservation.sourceLastMilestone = Math.max(
        Number(sourceObservation.sourceLastMilestone) || 0,
        Number(previousObservation.sourceLastMilestone) || 0,
      ) || null;
    }
    if (
      previousObservation?.status === sourceObservation.status &&
      previousObservation?.sourceAction === sourceObservation.sourceAction &&
      previousObservation?.sourceStopLossPrice === sourceObservation.sourceStopLossPrice &&
      previousObservation?.sourceTrailingStopLevel === sourceObservation.sourceTrailingStopLevel &&
      previousObservation?.sourceLastMilestone === sourceObservation.sourceLastMilestone &&
      previousObservation?.sourceUpdatedAt === sourceObservation.sourceUpdatedAt
    ) {
      if (strategyAuthority === "source") {
        // Refresh receipt evidence without repeatedly notifying unchanged holds.
        await store.settlePaperPosition(position, { ...position, sourceObservation }, { events: [] });
      }
      return false;
    }
    const next = { ...position, sourceObservation };
    const saved = await store.settlePaperPosition(position, next, {
      events: [{
        kind: "paper_source_observation",
        detail: { sourceObservation },
      }],
      closeSignal: false,
    });
    return saved.kind === "settled";
  }

  async function reconcileFundingCandidate(record) {
    const original = record.snapshot;
    const legacy = original.fundingStatus === "legacy_unknown";
    let fundingPosition = original;
    if (legacy) {
      // The old simulator recorded neither fills nor funding. Only a single
      // durable entry event plus an unchanged, still-open quantity proves the
      // position was held at each observed exchange settlement.
      if (record.status !== "open" ||
          (Array.isArray(original.paperFills) && original.paperFills.length > 0) ||
          !Number.isFinite(Number(original.quantity)) ||
          Number(original.quantity) <= 0 ||
          Number(original.quantity) !== Number(original.remainingQty) ||
          typeof store.getLegacyFundingEntry !== "function") return;
      const previousSettlements = original.fundingSettlements ?? [];
      if (!Array.isArray(previousSettlements) ||
          previousSettlements.some((item) =>
            !["applied", "incomplete", "not_held"].includes(item?.status) ||
            (item.status === "applied" && !Number.isFinite(Number(item.signedCostUsdt)))) ||
          (original.fundingPaidUsdt !== undefined &&
            Number(original.fundingPaidUsdt).toFixed(8) !== previousSettlements
              .filter((item) => item.status === "applied")
              .reduce((sum, item) => sum + Number(item.signedCostUsdt), 0).toFixed(8))) return;
      const entry = await store.getLegacyFundingEntry(original.sourceSignalId);
      const entryAt = Date.parse(original.entryAt ?? "");
      const eventAt = new Date(entry?.created_at ?? NaN).getTime();
      if (!entry || entry.detail?.source !== "BingX" ||
          Number(entry.detail.quantity) !== Number(original.quantity) ||
          Number(entry.detail.price) !== Number(original.entryPrice) ||
          !Number.isFinite(entryAt) || !Number.isFinite(eventAt) ||
          eventAt < entryAt || eventAt - entryAt > 60_000) return;
      fundingPosition = {
        ...original,
        paperFills: [{
          type: "entry",
          quantity: Number(original.quantity),
          occurredAt: original.entryAt,
        }],
      };
    } else if (!Array.isArray(original.paperFills) || original.paperFills.length === 0) return;
    const now = clock();
    const previousAttempt = Date.parse(original.fundingHistoryAttemptAt ?? "");
    if (Number.isFinite(previousAttempt) && now - previousAttempt < 5 * 60_000) return;

    const expectedTime = Number(original.fundingNextFundingTime);
    const reconciliationTime = closedAt(original, now);
    const expectedDue =
      Number.isSafeInteger(expectedTime) &&
      expectedTime > 0 &&
      expectedTime <= reconciliationTime;
    const incompleteSettlement = (original.fundingSettlements ?? []).some(
      (settlement) => settlement?.status === "incomplete",
    );
    const attempted = {
      ...original,
      fundingHistoryAttemptAt: new Date(now).toISOString(),
      ...(expectedDue && !legacy ? { fundingStatus: "incomplete" } : {}),
    };
    const attemptCommit = await store.settlePaperPosition(original, attempted);
    if (attemptCommit.kind === "stale") return;
    const base = attemptCommit.position ?? attempted;
    let next = { ...base };
    let currentNextFundingTime = null;
    let observedInterval = validFundingInterval(base.fundingObservedIntervalMs);
    const observedAt = Date.parse(base.fundingObservedAt ?? "");
    if (
      !Number.isSafeInteger(Number(base.fundingObservedNextFundingTime)) ||
      Number(base.fundingObservedNextFundingTime) <= 0 ||
      !Number.isFinite(observedAt) ||
      now - observedAt > 5 * 60_000
    ) {
      if (typeof exchange.premiumIndex === "function") {
        try {
          const mark = await exchange.premiumIndex(base.symbol);
          const observation = validatedMarkObservation(mark);
          next.marketMark = observation;
          next.marketMarkStatus = "current";
          const nextFundingTime = Number(mark.nextFundingTime);
          if (Number.isSafeInteger(nextFundingTime) && nextFundingTime > 0) {
            currentNextFundingTime = nextFundingTime;
            next.fundingObservedNextFundingTime = nextFundingTime;
            next.fundingObservedAt = observation.at;
          }
          const interval = fundingIntervalFromHours(mark.fundingIntervalHours);
          if (interval !== null) {
            observedInterval = interval;
            next.fundingObservedIntervalMs = interval;
            next.fundingIntervalObservedAt = observation.at;
          }
        } catch {
          // Funding reconciliation remains incomplete without trustworthy data.
        }
      }
    } else {
      currentNextFundingTime = Number(base.fundingObservedNextFundingTime);
    }

    try {
      const history = await readFundingHistory(
        exchange,
        next,
        reconciliationTime,
        10,
      );
      const inferredInterval = inferFundingInterval(history);
      const savedInterval = validFundingInterval(next.fundingIntervalMs);
      const interval = savedInterval ?? observedInterval ?? inferredInterval;
      const conflictingCadence =
        savedInterval !== null &&
        observedInterval !== null &&
        savedInterval !== observedInterval;
      const funding = await reconcilePaperFunding(legacy ? {
        ...next, paperFills: fundingPosition.paperFills,
      } : next, {
        history,
        now: reconciliationTime,
        expectedFundingTime: expectedDue ? expectedTime : null,
        expectedIntervalMs: interval,
        historicalPrice: (fundingTime) =>
          historicalSettlementPrice(exchange, next.symbol, fundingTime),
      });
      Object.assign(next, funding.next);
      if (legacy) {
        // Funding-rate records prove individual debits, not that a retired
        // simulator captured every older interval. Never certify its total.
        delete next.paperFills;
        next.fundingStatus = "legacy_unknown";
      }
      if (interval !== null) next.fundingIntervalMs = interval;

      if (expectedDue) {
        if (interval === null || !funding.expectedMatched || conflictingCadence) {
          next.fundingStatus = "incomplete";
          next.fundingNextFundingTime = expectedTime;
        } else {
          let nextBoundary = expectedTime;
          let crossed = 0;
          while (nextBoundary <= reconciliationTime && crossed < 1000) {
            nextBoundary += interval;
            crossed += 1;
          }
          if (nextBoundary <= reconciliationTime) {
            next.fundingStatus = "incomplete";
            next.fundingNextFundingTime = expectedTime;
          } else {
            if (
              currentNextFundingTime !== null &&
              currentNextFundingTime > expectedTime
            ) {
              // A later exchange hint cannot skip a locally inferred boundary.
              nextBoundary = Math.min(nextBoundary, currentNextFundingTime);
            }
            next.fundingNextFundingTime = nextBoundary;
            if (conflictingCadence) next.fundingStatus = "incomplete";
          }
        }
      } else if (
        original.fundingStatus === "incomplete" &&
        !incompleteSettlement
      ) {
        // A failed opening mark or unknown future boundary cannot be cleared
        // by an empty history response before the next boundary is due.
        next.fundingStatus = "incomplete";
      }
      if (conflictingCadence && !legacy) next.fundingStatus = "incomplete";
    } catch {
      next.fundingStatus = legacy ? "legacy_unknown" : "incomplete";
      if (expectedDue) next.fundingNextFundingTime = expectedTime;
    }
    if (legacy) next.fundingStatus = "legacy_unknown";

    const previousSettlements = new Set(
      (base.fundingSettlements ?? [])
        .filter((entry) => entry?.status === "applied")
        .map((entry) => Number(entry.fundingTime)),
    );
    const fundingEvents = (next.fundingSettlements ?? [])
      .filter((settlement) => settlement?.status === "applied" &&
        !previousSettlements.has(Number(settlement.fundingTime)))
      .map((settlement) => ({
        kind: "paper_funding_settlement",
        detail: {
          fundingTime: settlement.fundingTime,
          fundingRate: settlement.fundingRate,
          quantity: settlement.quantity,
          settlementPrice: settlement.settlementPrice,
          priceSource: settlement.priceSource,
          priceEstimation: settlement.priceEstimation,
          signedCostUsdt: settlement.signedCostUsdt,
          fundingStatus: next.fundingStatus,
        },
      }));
    const settled = await store.settlePaperPosition(base, next, {
      events: fundingEvents,
    });
    if (settled.kind === "stale") return;
  }

  async function watchLive(record) {
    const position = record.snapshot;
    const positions = await exchange.getPosition(position.symbol);
    const actual = positions.length === 1 ? positions[0] : null;
    if (
      !actual ||
      actual.side !== "Buy" ||
      Math.abs(Number(actual.size) - Number(position.remainingQty)) > 1e-8 ||
      +actual.stopLoss <= 0
    ) {
      // An external stop or manual action may have changed the position. Do
      // not issue another order until exchange state is reconciled.
      await store.upsertPosition({ ...position, status: "error" });
      await store.setSignalStatus(position.sourceSignalId, "error", "exchange_position_mismatch");
      return;
    }
    const quote = await exchange.ticker(position.symbol);
    const result = evaluatePosition(position, {
      price: Number(quote.lastPrice),
      at: new Date(clock()).toISOString(),
    });
    if (!result.actions.length) {
      await store.upsertPosition(result.next);
      return;
    }
    // A live stop update or reduce-only fill requires order-status and
    // position reconciliation; paper transitions must never be substituted
    // for exchange-confirmed fills.
    await store.upsertPosition({ ...position, status: "error" });
    await store.setSignalStatus(
      position.sourceSignalId,
      "error",
      "live_exit_requires_order_and_stop_reconciliation",
    );
  }

  async function watchClosedScenarios(record) {
    const position = record.snapshot;
    const quote = await quoteFor(position.symbol);
    const price = Number(validatedLastPrice(quote?.lastPrice));
    const updated = observeScenarios(position.scenarioModel, {
      price,
      bid: Number(quote?.bid1Price),
      at: new Date(clock()).toISOString(),
    });
    await store.updateClosedScenarios(position.sourceSignalId, position.scenarioModel, updated);
  }

  // One quote per symbol per tick, fetched in parallel. Before this every
  // open position and every closed-scenario observation did its own
  // sequential HTTP ticker call, so a tick grew linearly with history and
  // new signals waited behind it until they went stale (10 min TTL).
  let tickQuotes = null;
  let lastScenarioPassAt = -Infinity;
  let scenarioCursor = 0;
  function quoteFor(symbol) {
    if (!tickQuotes) return exchange.ticker(symbol);
    let pending = tickQuotes.get(symbol);
    if (!pending) {
      pending = exchange.ticker(symbol);
      pending.catch(() => {});
      tickQuotes.set(symbol, pending);
    }
    return pending;
  }
  async function prefetchQuotes(symbols) {
    let unique = [...new Set(symbols.filter((symbol) =>
      typeof symbol === "string" && symbol !== ""))];
    if (unique.length > 1 && typeof exchange.tickers === "function") {
      // One bulk request instead of one paced (1.1 s) request per symbol.
      try {
        const bulk = await exchange.tickers(unique);
        for (const [symbol, quote] of bulk) {
          tickQuotes.set(symbol, Promise.resolve(quote));
        }
        unique = unique.filter((symbol) => !bulk.has(symbol));
      } catch {
        // Fall back to single-symbol quotes below.
      }
    }
    let cursor = 0;
    const workers = Array.from({ length: Math.min(PAPER_QUOTE_CONCURRENCY, unique.length) },
      async () => {
        while (cursor < unique.length) {
          const symbol = unique[cursor++];
          try { await quoteFor(symbol); } catch {}
        }
      });
    await Promise.all(workers);
  }

  async function drainPendingEntries() {
    // Several signals can arrive together; one entry per tick let later ones
    // expire (stale_at_execution) behind the monitoring work.
    const seen = new Set();
    for (let index = 0; index < MAX_PAPER_ENTRIES_PER_TICK; index += 1) {
      const next = await store.getPending(clock());
      if (!next || seen.has(next.sourceSignalId)) return;
      seen.add(next.sourceSignalId);
      try {
        const outcome = await open(next);
        if (outcome?.kind === "waiting") return;
      } catch (error) {
        if (mode === "paper" &&
            clock() - Date.parse(next.body?.signalAt) < SIGNAL_TTL_MS) {
          // PAPER submits nothing to an exchange: a transient quote/instrument
          // read failure is safely retried next tick while the signal is
          // fresh (the TTL check in open() rejects it once it is not).
          continue;
        }
        // Unknown exchange outcomes remain terminal for automated entry:
        // never retry a market order merely because a request timed out.
        await store.setSignalStatus(next.sourceSignalId, "error", safeReason(error));
      }
    }
  }

  async function tick() {
    return store.withLeaderLock(async () => {
      tickQuotes = null;
      await drainPendingEntries();
      const openRecords = await store.listOpenPositions();
      let scenarioRecords = [];
      if (mode === "paper" && typeof store.listPendingScenarios === "function" &&
          clock() - lastScenarioPassAt >= PAPER_SCENARIO_PASS_INTERVAL_MS) {
        lastScenarioPassAt = clock();
        const all = await store.listPendingScenarios();
        if (scenarioCursor >= all.length) scenarioCursor = 0;
        scenarioRecords = all.slice(scenarioCursor,
          scenarioCursor + MAX_PAPER_SCENARIO_OBSERVATIONS_PER_PASS);
        scenarioCursor += scenarioRecords.length;
      }
      if (mode === "paper") {
        tickQuotes = new Map();
        await prefetchQuotes([
          ...openRecords.map((record) => record?.snapshot?.symbol),
          ...scenarioRecords.map((record) => record?.snapshot?.symbol),
        ]);
      }
      const positionsToRefresh = [];
      for (const record of openRecords) {
        try {
          if (mode === "paper") {
            const updated = await watchPaper(record);
            if (updated) positionsToRefresh.push(updated);
          }
          else await watchLive(record);
        } catch (error) {
          // Keep prior protection/position state on a transient price outage.
          // A paper quote failure can retry next tick; live errors fail closed.
          if (mode === "live") {
            await store.upsertPosition({ ...record.snapshot, status: "error" });
            await store.setSignalStatus(record.sourceSignalId, "error", safeReason(error));
          }
        }
      }
      tickQuotes = null;
      for (const position of positionsToRefresh) {
        try {
          await refreshPaperMark(position);
        } catch {
          // The ticker-driven position transition was committed already.
        }
      }
      if (scenarioRecords.length) {
        tickQuotes = new Map();
        for (const record of scenarioRecords) {
          try {
            await watchClosedScenarios(record);
          } catch {
            // Preserve the previous observation; never fabricate a price
            // during an exchange outage.
          }
        }
        tickQuotes = null;
      }
      if (mode === "paper" && typeof store.listPaperFundingCandidates === "function") {
        try {
          const [candidate] = await store.listPaperFundingCandidates(clock(), 1);
          if (candidate) await reconcileFundingCandidate(candidate);
        } catch {
          // The funding job is bounded and best effort; ticker/exit monitoring
          // and its durable transitions have already completed this pass.
        }
      }
    });
  }

  async function syncSourcePositions(sourceMap, { asOf = sourceMap?.asOf ?? null } = {}) {
    if (!(sourceMap instanceof Map)) {
      throw new TypeError("sourceMap must be a Map of sourceSignalId to source item");
    }
    if (
      mode === "paper" &&
      asOf !== null &&
      typeof store.queueSourceExitRequests === "function"
    ) {
      // Persist an accepted command before trying to enter the PAPER monitor
      // lock. Runtime callers may queue the same snapshot independently; the
      // store deduplicates by sourceSignalId.
      await store.queueSourceExitRequests({
        asOf,
        positions: sourceMap,
        observedAt: new Date(clock()).toISOString(),
      });
    }
    return store.withLeaderLock(async () => {
      const outcomes = [];
      if (mode !== "paper") return outcomes;
      for (const record of await store.listOpenPositions()) {
        const position = record?.snapshot;
        const id = record?.sourceSignalId;
        const source = sourceMap.get(id);
        if (
          typeof id !== "string" ||
          !position ||
          position.status !== "open" ||
          position.mode !== "paper" ||
          position.sourceSignalId !== id
        ) continue;

        try {
          let pending = null;
          if (typeof store.listPendingSourceExitRequests === "function") {
            [pending] = await store.listPendingSourceExitRequests({
              sourceSignalId: id,
              limit: 1,
            });
          }
          const matchingSource = source &&
            typeof source === "object" &&
            source.sourceSignalId === id &&
            source.symbol === position.symbol;
          let evidence = pending?.evidence ?? null;
          if (!evidence && matchingSource) {
            evidence = buildSourceExitEvidence(source, {
              sourceSignalId: id,
              symbol: position.symbol,
              entryAt: position.entryAt,
              signalAt: source.signalAt ?? position.signalAt,
              asOf,
              observedAt: new Date(clock()).toISOString(),
            });
          }

          if (!evidence) {
            if (matchingSource && source.sourceAction !== undefined) {
              await observeSourcePosition(position, source);
            } else if (!source) {
              await observeSourcePosition(position, {
                sourceAction: "unknown", sourceStatus: null, sourceUpdatedAt: null,
              });
            } else if (
              matchingSource &&
              (source.sourceStatus === "active" || source.sourceStatus === "in_run") &&
              position.sourceObservation?.status === "reclassified"
            ) {
              await observeSourcePosition(position, source);
            } else if (
              matchingSource &&
              source.sourceStatus === "reclassified"
            ) {
              await observeSourcePosition(position, source);
            }
            continue;
          }

          const settled = await watchPaper(
            record,
            evidence,
            pending?.id ?? null,
          );
          outcomes.push({
            sourceSignalId: id,
            kind: settled?.status === "closed" ? "closed" : "stale",
          });
        } catch {
          // One unavailable quote/fee must not prevent reconciliation of
          // other positions. Keep this PAPER position open for the next pass.
          outcomes.push({ sourceSignalId: id, kind: "error" });
        }
      }

      // The loop above only ever looks at positions we already opened. A
      // source signal the sender never delivered, or that failed the strict
      // ingress contract before store.enqueue() ran, leaves zero trace and
      // was previously invisible forever. Flag any source-active signal we
      // have never stored in any form, without opening or backfilling a
      // PAPER position for it -- that would fabricate a fill that never
      // happened at its intended time and price.
      const activeSourceIds = [];
      for (const [id, source] of sourceMap) {
        if (
          typeof id === "string" &&
          source &&
          typeof source === "object" &&
          (source.sourceStatus === "active" || source.sourceStatus === "in_run")
        ) {
          activeSourceIds.push(id);
        }
      }
      if (activeSourceIds.length > 0) {
        const missingIds = await store.findMissingSourceSignalIds(activeSourceIds);
        for (const id of missingIds) {
          const source = sourceMap.get(id);
          try {
            const isNew = await store.recordMissedSourceSignal(id, {
              symbol: source.symbol,
              sourceStatus: source.sourceStatus,
              signalAt: source.signalAt ?? null,
              botEnqueuedAt: source.botEnqueuedAt ?? null,
            });
            if (isNew) outcomes.push({ sourceSignalId: id, kind: "missed" });
          } catch {
            // Best-effort observability; do not let one recording failure
            // block reconciliation of the rest of this sync pass.
          }
        }
      }
      return outcomes;
    });
  }
  async function executeSourceCommand(value, { cancelEntry, lookupPosition } = {}) {
    const command = validateSourceCommand(value, clock());
    if (mode !== "paper" || strategyAuthority !== "source") {
      return { status: "rejected", reason: "source_paper_authority_required" };
    }
    return await store.withLeaderLock(async () => {
      const record = await lookupPosition("paper", command.sourceSignalId);
      if (record && record.symbol !== command.symbol) return { status: "rejected", reason: "source_symbol_conflict" };
      if (command.type === "cancel_entry") return cancelEntry(command, "paper");
      if (command.type === "close") {
        if (record?.status === "closed") return { status: "already_closed", result: "paper_already_closed" };
        if (!record) return cancelEntry(command, "paper");
        await watchPaper(record, directCloseRequest(command, new Date(clock()).toISOString()).evidence);
        const closed = await lookupPosition("paper", command.sourceSignalId);
        return closed?.status === "closed"
          ? { status: "executed", result: "paper_close_simulated" }
          : { status: "pending", reason: "paper_close_pending" };
      }
      if (!record || record.status === "closed") return { status: "rejected", reason: "stop_position_not_open" };
      if (["core", "runner"].filter(leg => record.snapshot[`${leg}Open`])
        .some(leg => Number(record.snapshot[leg === "core" ? "stopPrice" : "runnerStopPrice"]) > Number(command.stopPrice))) {
        return { status: "rejected", reason: "source_stop_would_reduce_protection" };
      }
      await watchPaper(record, null, null, command);
      const next = await lookupPosition("paper", command.sourceSignalId);
      const matched = next?.status === "open" && ["core", "runner"]
        .filter(leg => next.snapshot[`${leg}Open`])
        .every(leg => Number(next.snapshot[leg === "core" ? "stopPrice" : "runnerStopPrice"]) >= Number(command.stopPrice));
      return matched ? { status: "executed", result: "paper_stop_updated" }
        : { status: "pending", reason: "stop_update_pending" };
    }) ?? { status: "pending", reason: "worker_busy" };
  }
  return { tick, syncSourcePositions, executeSourceCommand };
}