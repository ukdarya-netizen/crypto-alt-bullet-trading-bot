import Decimal from "decimal.js";
import { pool } from "@workspace/db";
// @ts-expect-error The fixed owner-selected baseline is a JavaScript module.
import { OWNER_LIVE_BASELINE } from "../bullet-bot/live-baseline.mjs";

type JsonRecord = Record<string, unknown>;
type StrategyTrade = {
  id: string;
  patternId: string | null;
  executedStrategyId: number | null;
  environment: "paper" | "live" | "testnet";
  symbol: string;
  status: "open" | "closed";
  accountingStatus: "open" | "verified" | "incomplete";
  entryAt: string | null;
  closedAt: string | null;
  profitUsdt: string | null;
  profitPercent: string | null;
  tradeProfitPercent: string | null;
  allocatedUsdt: string | null;
  allocatedPercent: string | null;
  scenarios: Array<{
    strategyId: number;
    status: "unobserved" | "open" | "closed" | "incomplete";
    closedAt: string | null;
    profitUsdt: string | null;
    profitPercent: string | null;
    allocatedPercent: string | null;
    grossUsdt: string | null;
    estimatedCostUsdt: string | null;
    exits: Array<{ at: string; quantity: string; price: string; reason: string; grossUsdt: string }>;
  }>;
};

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function decimal(value: unknown): Decimal | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && !value.trim()) return null;
  try {
    const number = new Decimal(value);
    return number.isFinite() ? number : null;
  } catch {
    return null;
  }
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function amount(value: Decimal): string {
  return value.toDecimalPlaces(8).toFixed(8);
}

function percentage(numerator: Decimal | null, deposit: Decimal | null): string | null {
  return numerator && deposit?.gt(0)
    ? numerator.div(deposit).times(100).toDecimalPlaces(6).toFixed(6)
    : null;
}

function paperScenarios(snapshot: JsonRecord, deposit: Decimal | null, allocation: Decimal | null): StrategyTrade["scenarios"] {
  const model = record(snapshot.scenarioModel);
  const variants = record(model.variants);
  return [1, 2, 3, 4].map((strategyId) => {
    const variant = record(variants[String(strategyId)]);
    const rawExits = Array.isArray(variant.exits) ? variant.exits : [];
    const exits = rawExits.map(record);
    const valid = model.version === "prospective_observed_quotes_v1" &&
      ["open", "closed", "incomplete"].includes(String(variant.status)) &&
      exits.every((exit) => iso(exit.at) !== null && decimal(exit.quantity)?.gt(0) &&
        decimal(exit.price)?.gt(0) && decimal(exit.grossUsdt) !== null);
    const gross = valid ? exits.reduce((sum, exit) => sum.plus(decimal(exit.grossUsdt)!), new Decimal(0)) : null;
    const cost = valid ? decimal(variant.costUsdt) : null;
    const initialQuantity = decimal(record(variant.position).quantity);
    const exitedQuantity = exits.reduce((sum, exit) => sum.plus(decimal(exit.quantity) ?? NaN), new Decimal(0));
    const complete = valid && variant.status === "closed" && iso(variant.closedAt) !== null &&
      exits.length > 0 && initialQuantity?.gt(0) && exitedQuantity.eq(initialQuantity) &&
      cost?.gte(0) && allocation?.gt(0) && deposit?.gt(0);
    const net = complete ? gross!.minus(cost!) : null;
    return {
      strategyId,
      status: !model.version || !variants[String(strategyId)] ? "unobserved" as const :
        valid ? variant.status === "closed" && !complete ? "incomplete" as const :
          variant.status as "open" | "closed" | "incomplete" : "incomplete" as const,
      closedAt: complete ? iso(variant.closedAt) : null,
      profitUsdt: net ? amount(net) : null,
      profitPercent: percentage(net, deposit),
      allocatedPercent: percentage(allocation, deposit),
      grossUsdt: gross ? amount(gross) : null,
      estimatedCostUsdt: cost?.gte(0) ? amount(cost) : null,
      exits: valid ? exits.map((exit) => ({
        at: iso(exit.at)!,
        quantity: String(exit.quantity),
        price: String(exit.price),
        reason: String(exit.reason ?? ""),
        grossUsdt: amount(decimal(exit.grossUsdt)!),
      })) : [],
    };
  });
}

export function paperStrategyTrade(row: {
  source_signal_id: string;
  pattern_id: string | null;
  symbol: string | null;
  status: string;
  snapshot: unknown;
  entry_margin: string | null;
}, deposit: Decimal | null): StrategyTrade {
  const snapshot = record(row.snapshot);
  const closed = row.status === "closed";
  const fills = Array.isArray(snapshot.paperFills) ? snapshot.paperFills : [];
  const exitTimes = fills
    .map(record)
    .filter((fill) => fill.type === "exit")
    .map((fill) => iso(fill.occurredAt))
    .filter((date): date is string => date !== null)
    .sort();
  const closedAt = closed ? exitTimes.at(-1) ?? null : null;
  const realized = decimal(snapshot.realizedPnlUsdt);
  const funding = decimal(snapshot.fundingPaidUsdt);
  const complete = closed && closedAt !== null && snapshot.fundingStatus === "current" &&
    realized !== null && funding !== null;
  // The PAPER funding reconciler already debits/credits realizedPnlUsdt when
  // it updates fundingPaidUsdt. Subtracting funding here would count it twice.
  const net = complete ? realized : null;
  const margin = decimal(row.entry_margin);
  const allocated = margin?.gt(0) ? margin : null;
  return {
    id: `paper:${row.source_signal_id}`,
    patternId: row.pattern_id,
    executedStrategyId: record(snapshot.paperExitPolicy).version === "owner_strategy_4_v1" ? 4 : null,
    environment: "paper",
    symbol: row.symbol ?? (typeof snapshot.symbol === "string" ? snapshot.symbol : "—"),
    status: closed ? "closed" : "open",
    accountingStatus: closed ? complete ? "verified" : "incomplete" : "open",
    entryAt: iso(snapshot.entryAt),
    closedAt,
    profitUsdt: net ? amount(net) : null,
    profitPercent: percentage(net, deposit),
    tradeProfitPercent: percentage(net, allocated),
    allocatedUsdt: allocated ? amount(allocated) : null,
    allocatedPercent: percentage(allocated, deposit),
    scenarios: paperScenarios(snapshot, deposit, allocated),
  };
}

export function liveStrategyTrade(row: {
  signal_id: string;
  pattern_id: string | null;
  environment: string;
  symbol: string;
  status: string;
  snapshot: unknown;
  signal_at: string | null;
  allocation_usdt?: string | null;
  allocation_deposit_usdt?: string | null;
  coverage_through?: string | null;
  fills?: unknown;
  funding?: unknown;
  unresolved_intents?: number;
}, deposit: Decimal | null = null, baselineAt: string | null = null): StrategyTrade {
  const snapshot = record(row.snapshot);
  const closed = row.status === "closed";
  const mainnet = row.environment === "mainnet";
  const entryAt = iso(snapshot.entryAt) ?? iso(row.signal_at);
  const allocated = decimal(row.allocation_usdt);
  const originalAllocationDeposit = decimal(row.allocation_deposit_usdt);
  const fills = Array.isArray(row.fills) ? row.fills.map(record) : [];
  const funding = Array.isArray(row.funding) ? row.funding.map(record) : [];
  const buys = fills.filter((fill) => (fill.phase === "entry" || fill.phase === "supervised-one-shot-entry") &&
    fill.side === "BUY" && fill.state === "reconciled");
  const sells = fills.filter((fill) => fill.phase !== "entry" && fill.phase !== "supervised-one-shot-entry" &&
    fill.phase !== "external" &&
    fill.side === "SELL" && fill.state === "reconciled");
  const exitDates = sells.map((fill) => iso(fill.filledAt)).filter((value): value is string => value !== null).sort();
  // Exchange fill time, not an operator/snapshot timestamp, owns the
  // realized month's boundary and the end of funding coverage.
  const closedAt = closed ? exitDates.at(-1) ?? null : null;
  const allOwn = fills.length === buys.length + sells.length;
  const buyQty = buys.reduce((sum, fill) => sum.plus(decimal(fill.quantity) ?? NaN), new Decimal(0));
  const sellQty = sells.reduce((sum, fill) => sum.plus(decimal(fill.quantity) ?? NaN), new Decimal(0));
  const feesValid = fills.every((fill) => decimal(fill.fee)?.gte(0) && fill.feeAsset === "USDT" &&
    iso(fill.filledAt) !== null && decimal(fill.price)?.gt(0) && decimal(fill.quantity)?.gt(0));
  const fillTimesValid = entryAt !== null && closedAt !== null &&
    fills.every((fill) => iso(fill.filledAt)! >= entryAt && iso(fill.filledAt)! <= closedAt);
  const fundingValid = funding.every((item) => decimal(item.amount)?.isFinite() &&
    iso(item.settledAt) !== null && entryAt !== null && closedAt !== null &&
    iso(item.settledAt)! >= entryAt && iso(item.settledAt)! <= closedAt);
  const complete = mainnet && closed && entryAt !== null && closedAt !== null &&
    baselineAt !== null && entryAt >= baselineAt && closedAt >= entryAt &&
    iso(row.coverage_through) !== null && iso(row.coverage_through)! >= closedAt &&
    allocated?.gt(0) === true && originalAllocationDeposit?.gt(0) === true &&
    deposit?.eq(originalAllocationDeposit) === true &&
    snapshot.remainingQty === 0 && snapshot.externalClose !== true &&
    !row.unresolved_intents && buys.length > 0 && sells.length > 0 &&
    allOwn && feesValid && fillTimesValid && fundingValid && buyQty.gt(0) && buyQty.eq(sellQty);
  // Funding amounts are signed account credits (positive) or debits (negative).
  // Fees are exchange-reported positive USDT charges; no estimated tariff.
  const net = complete
    ? sells.reduce((sum, fill) => sum.plus(new Decimal(String(fill.quantity)).times(String(fill.price))), new Decimal(0))
      .minus(buys.reduce((sum, fill) => sum.plus(new Decimal(String(fill.quantity)).times(String(fill.price))), new Decimal(0)))
      .minus(fills.reduce((sum, fill) => sum.plus(String(fill.fee)), new Decimal(0)))
      .plus(funding.reduce((sum, item) => sum.plus(String(item.amount)), new Decimal(0)))
    : null;
  return {
    id: `${row.environment}:${row.signal_id}`,
    patternId: row.pattern_id,
    // A live exit plan is not evidence that its planned partials/trailing were
    // actually executed. Only a future execution-proven policy may be attributed.
    executedStrategyId: null,
    environment: row.environment === "mainnet" || row.environment === "live" ? "live" : "testnet",
    symbol: row.symbol,
    status: closed ? "closed" : "open",
    accountingStatus: closed ? complete ? "verified" : "incomplete" : "open",
    entryAt,
    closedAt,
    profitUsdt: net ? amount(net) : null,
    profitPercent: percentage(net, deposit),
    tradeProfitPercent: percentage(net, allocated),
    allocatedUsdt: allocated ? amount(allocated) : null,
    allocatedPercent: allocated && originalAllocationDeposit
      ? percentage(allocated, originalAllocationDeposit) : null,
    scenarios: [],
  };
}

export async function journalStrategyHistory() {
  // Owner chose the read-only observed free USDT margin at this exact instant
  // as the fixed starting reference. Do not refresh it from the shared account.
  // Idempotent seed also records it in the published ledger after schema publish.
  await pool.query(`
    INSERT INTO btb_live_baseline (account_id, environment, initial_usdt, started_at)
    VALUES ('bingx-mainnet', 'mainnet', $1, $2)
    ON CONFLICT (account_id, environment) DO NOTHING
  `, [OWNER_LIVE_BASELINE.initialUsdt, OWNER_LIVE_BASELINE.startedAt]);
  const [account, paper, live, baseline] = await Promise.all([
    pool.query("SELECT initial_usdt FROM btb_paper_account WHERE singleton = true"),
    pool.query(`
      SELECT p.source_signal_id, s.body->>'patternId' AS pattern_id,
             s.body->>'symbol' AS symbol, p.status, p.snapshot,
             entry_event.detail->>'marginHeldUsd' AS entry_margin
      FROM btb_positions p
      JOIN btb_signals s ON s.source_signal_id = p.source_signal_id
      LEFT JOIN LATERAL (
        SELECT e.detail FROM btb_events e
        WHERE e.source_signal_id = p.source_signal_id AND e.kind = 'paper_entry'
        ORDER BY e.id ASC LIMIT 1
      ) entry_event ON true
      WHERE COALESCE(p.snapshot->>'mode', 'paper') = 'paper'
      ORDER BY p.source_signal_id
    `),
    pool.query(`
       SELECT p.account_id, p.signal_id, s.body->>'patternId' AS pattern_id,
             p.environment, p.symbol, p.status, p.snapshot,
              s.body->>'signalAt' AS signal_at,
              a.initial_margin_usdt AS allocation_usdt,
              a.initial_deposit_usdt AS allocation_deposit_usdt,
              c.covered_through AS coverage_through,
              (SELECT count(*)::int FROM btb_live_order_intents i
               WHERE i.account_id = p.account_id AND i.environment = p.environment
                 AND i.signal_id = p.signal_id AND i.state <> 'reconciled') AS unresolved_intents,
              (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'phase', i.phase, 'state', i.state, 'side', f.side,
                'quantity', f.quantity, 'price', f.price, 'fee', f.fee,
                'feeAsset', f.fee_asset, 'filledAt', f.filled_at
              )), '[]'::jsonb)
               FROM btb_live_fills f JOIN btb_live_order_intents i
                 ON (i.account_id, i.environment, i.client_order_id) =
                    (f.account_id, f.environment, f.client_order_id)
               WHERE i.account_id = p.account_id AND i.environment = p.environment
                 AND i.signal_id = p.signal_id AND f.symbol = p.symbol) AS fills,
              (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'amount', f.amount_usdt, 'settledAt', f.settled_at
              )), '[]'::jsonb) FROM btb_live_funding f
               WHERE f.account_id = p.account_id AND f.environment = p.environment
                 AND f.signal_id = p.signal_id) AS funding
      FROM btb_live_position_snapshots p
      JOIN btb_live_signals s
        ON (s.account_id, s.environment, s.signal_id) =
           (p.account_id, p.environment, p.signal_id)
       LEFT JOIN btb_live_allocations a
         ON (a.account_id, a.environment, a.signal_id) =
            (p.account_id, p.environment, p.signal_id)
       LEFT JOIN btb_live_funding_coverage c
         ON (c.account_id, c.environment, c.signal_id) =
            (p.account_id, p.environment, p.signal_id)
      ORDER BY p.signal_id
    `),
    pool.query("SELECT account_id, initial_usdt, started_at FROM btb_live_baseline WHERE environment = 'mainnet'"),
  ]);
  const originalDeposit = decimal(account.rows[0]?.initial_usdt);
  const validBaselines = baseline.rows.length > 0 && baseline.rows.every((row) =>
    decimal(row.initial_usdt)?.eq(OWNER_LIVE_BASELINE.initialUsdt) &&
    iso(row.started_at) === OWNER_LIVE_BASELINE.startedAt);
  const realBaseline = validBaselines ? baseline.rows[0] : null;
  const realDeposit = decimal(realBaseline?.initial_usdt);
  const baselineAt = iso(realBaseline?.started_at);
  return {
    paperInitialDepositUsdt: originalDeposit ? amount(originalDeposit) : null,
    realInitialDepositUsdt: realDeposit ? amount(realDeposit) : null,
    realBaselineAt: baselineAt,
    trades: [
      ...paper.rows.map((row) => paperStrategyTrade(row, originalDeposit)),
      ...live.rows.map((row) => liveStrategyTrade(row,
        validBaselines && baseline.rows.some((b) => b.account_id === row.account_id)
          ? realDeposit : null, baselineAt)),
    ],
  };
}