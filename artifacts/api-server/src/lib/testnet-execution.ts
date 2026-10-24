import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db, pool, tradingAuditEventsTable, tradingControlsTable, tradingOrdersTable, tradingSignalsTable,
} from "@workspace/db";
import {
  cancelOrder, clientOrderId, emergencyClose, findOrder, levelsMatch,
  listOpenOrders, listPositions, marketReferencePrice, placeOrder, testnetConfigured,
  type BybitOrder, type BybitPosition,
} from "./bybit-testnet";
import { logger } from "./logger";

type Signal = {
  id: string; symbol: string; side: string; order_type: string; quantity: string;
  limit_price: string | null; stop_loss: string | null; take_profit: string | null;
  reduce_only: boolean;
};
type LocalOrder = typeof tradingOrdersTable.$inferSelect;

async function halt(reason: string, signalId?: string) {
  await db.update(tradingControlsTable).set({
    acceptingNewEntries: false, killSwitchActive: true,
    exchangeConnected: false, updatedAt: new Date(),
  }).where(eq(tradingControlsTable.id, 1));
  await db.insert(tradingAuditEventsTable).values({
    signalId, eventType: "testnet_safety_halt", message: reason,
  });
  logger.error({ signalId, reason }, "Bybit Testnet execution halted");
}

function active(order: BybitOrder) {
  return ["New", "PartiallyFilled", "Untriggered", "Created"].includes(order.orderStatus);
}

export function classifyExchangeState(order: Pick<BybitOrder, "orderStatus" | "cumExecQty">) {
  const filled = Number(order.cumExecQty) > 0;
  // An absent position is not proof of an exit fill or its price.
  const status = order.orderStatus.toLowerCase();
  return {
    status,
    signalStatus: !filled && ["rejected", "cancelled", "deactivated"].includes(status)
      ? "failed" as const
      : filled && !["new", "partiallyfilled", "created", "untriggered"].includes(status)
        ? "executed" as const : "processing" as const,
  };
}

type ControlFence = {
  mode: string; kill_switch_active: boolean; accepting_new_entries: boolean; max_notional_per_order: string;
};
type FenceClient = {
  query: (sql: string) => Promise<{ rows: ControlFence[] }>;
  release: () => void;
};

export function assertDispatchAllowed(control: ControlFence | undefined, riskNotional: number) {
  if (!control || control.mode !== "testnet" || control.kill_switch_active ||
      !control.accepting_new_entries || !Number.isFinite(riskNotional) ||
      riskNotional <= 0 || riskNotional > Number(control.max_notional_per_order)) {
    throw new Error("Testnet safety controls changed before dispatch.");
  }
}

export async function withTestnetControlFence<T>(
  riskNotional: number,
  submit: () => Promise<T>,
  connect: () => Promise<FenceClient> = async () => await pool.connect() as unknown as FenceClient,
): Promise<T> {
  const client = await connect();
  let locked = false;
  try {
    await client.query("BEGIN");
    locked = true;
    const { rows: [control] } = await client.query(
      "SELECT mode, kill_switch_active, accepting_new_entries, max_notional_per_order FROM trading_controls WHERE id = 1 FOR UPDATE",
    );
    assertDispatchAllowed(control, riskNotional);
    return await submit();
  } finally {
    if (locked) await client.query("ROLLBACK").finally(() => client.release());
    else client.release();
  }
}

async function inspectOrder(local: LocalOrder, remote: BybitOrder | null, positions: BybitPosition[]) {
  if (!remote) throw new Error(`Order ${local.clientOrderId} is not visible on Bybit; status is uncertain.`);
  if (remote.orderLinkId !== local.clientOrderId || remote.symbol !== local.symbol) {
    throw new Error(`Order ${local.clientOrderId} does not match the reserved order.`);
  }
  const position = positions.find((item) => item.symbol === local.symbol);
  if (local.protectionStatus !== "not_required" && Number(remote.cumExecQty) > 0 && !position) {
    await db.transaction(async (tx) => {
      await tx.update(tradingOrdersTable).set({
        exchangeOrderId: remote.orderId,
        filledQuantity: remote.cumExecQty,
        averagePrice: Number(remote.avgPrice) > 0 ? remote.avgPrice : null,
        status: "closure_unverified", protectionStatus: "reconciliation_required",
        rawResponse: { mode: "testnet", orderStatus: remote.orderStatus },
        updatedAt: new Date(),
      }).where(eq(tradingOrdersTable.id, local.id));
      await tx.insert(tradingAuditEventsTable).values({
        signalId: local.signalId, eventType: "testnet_closure_unverified",
        message: "Bybit entry has a fill but no current position. Close executions must be verified before journal PnL can be reported.",
        details: { clientOrderId: local.clientOrderId, exchangeOrderId: remote.orderId },
      });
    });
    throw new Error(`Bybit position ${local.symbol} is flat after an entry fill. Closure execution and price are unverified; manual review required.`);
  }
  const protectedOnOrder = levelsMatch(remote, local);
  const protectedOnPosition = position && levelsMatch(position, local);
  if (local.protectionStatus !== "not_required" && position && !protectedOnPosition) {
    // Never leave an unprotected filled position open intentionally.
    // The close ID is deterministic; failure still halts the worker for manual intervention.
    if (active(remote)) await cancelOrder(local.symbol, local.clientOrderId!);
    if (position.positionIdx === 0) {
      const closeId = `${local.clientOrderId}-close`;
      if (!await findOrder(local.symbol, closeId)) {
        await emergencyClose(local.symbol, position.side, position.size, local.clientOrderId!);
      }
      throw new Error(`Position ${local.symbol} has missing or mismatched protection; emergency close requested.`);
    }
    throw new Error(`Position ${local.symbol} has missing protection and uses unsupported hedge mode; manual close required.`);
  }
  if (local.protectionStatus !== "not_required" && active(remote) && !protectedOnOrder) {
    await cancelOrder(local.symbol, local.clientOrderId!);
    throw new Error(`Protective levels not verified on open order ${local.clientOrderId}; canceled entry.`);
  }
  const { status, signalStatus } = classifyExchangeState(remote);
  await db.update(tradingOrdersTable).set({
    exchangeOrderId: remote.orderId,
    status,
    filledQuantity: remote.cumExecQty,
    averagePrice: Number(remote.avgPrice) > 0 ? remote.avgPrice : null,
    protectionStatus: local.protectionStatus === "not_required" ? "not_required" : "armed",
    rawResponse: { mode: "testnet", orderStatus: remote.orderStatus },
    updatedAt: new Date(),
  }).where(eq(tradingOrdersTable.id, local.id));
  await db.update(tradingSignalsTable).set({
    status: signalStatus,
    processedAt: signalStatus === "processing" ? null : new Date(),
    leaseUntil: signalStatus === "processing" ? new Date(Date.now() + 30_000) : null,
    updatedAt: new Date(),
    errorCode: signalStatus === "failed" ? "EXCHANGE_ORDER_NOT_FILLED" : null,
    errorMessage: signalStatus === "failed" ? `Bybit order ${status} without a fill.` : null,
  }).where(eq(tradingSignalsTable.id, local.signalId));
  if (status !== local.status && status === "filled") {
    await db.insert(tradingAuditEventsTable).values({
      signalId: local.signalId, eventType: "testnet_order_filled",
      message: "Bybit reported a filled order.",
      details: { clientOrderId: local.clientOrderId, exchangeOrderId: remote.orderId },
    });
  }
  return status;
}

export async function reconcileTestnet() {
  if (!testnetConfigured()) {
    await halt("Bybit Testnet credentials are missing.");
    return false;
  }
  try {
    const positions = await listPositions();
    const local = (await db.select().from(tradingOrdersTable))
      .filter((item) => item.clientOrderId !== null);
    if (local.some((item) => item.status === "closure_unverified")) {
      throw new Error("An exchange closure is unverified; reconcile its execution history before resuming.");
    }
    const knownSymbols = new Set(local.filter((item) => item.status !== "closed").map((item) => item.symbol));
    for (const position of positions) {
      if (!knownSymbols.has(position.symbol)) {
        throw new Error(`Untracked Bybit position on ${position.symbol}; manual review required.`);
      }
    }
    for (const order of local) {
      if (order.status === "closed") continue;
      const open = await listOpenOrders(order.symbol);
      if (open.some((item) => item.orderLinkId !== order.clientOrderId &&
        item.orderLinkId !== `${order.clientOrderId}-close`)) {
        throw new Error(`Untracked open order on ${order.symbol}; manual review required.`);
      }
      const remote = await findOrder(order.symbol, order.clientOrderId!);
      if (order.status === "reserved" && !remote) {
        if (positions.some((position) => position.symbol === order.symbol)) {
          throw new Error(`Untracked position on ${order.symbol} while order is only reserved.`);
        }
        continue;
      }
      await inspectOrder(order, remote, positions);
    }
    await db.update(tradingControlsTable).set({
      exchangeConnected: true, lastReconciledAt: new Date(), updatedAt: new Date(),
    }).where(eq(tradingControlsTable.id, 1));
    return true;
  } catch (error) {
    await halt(error instanceof Error ? error.message : "Testnet reconciliation failed.");
    return false;
  }
}

export async function executeTestnetOrder(signal: Signal, maxNotional: string) {
  const linkId = clientOrderId(signal.id);
  let [local] = await db.select().from(tradingOrdersTable)
    .where(eq(tradingOrdersTable.signalId, signal.id)).limit(1);
  if (!local) {
    const [inserted] = await db.insert(tradingOrdersTable).values({
      id: randomUUID(), signalId: signal.id, clientOrderId: linkId,
      symbol: signal.symbol, side: signal.side, orderType: signal.order_type,
      quantity: signal.quantity, stopLoss: signal.stop_loss, takeProfit: signal.take_profit,
      status: "reserved", protectionStatus: signal.reduce_only ? "not_required" : "pending",
      rawResponse: { mode: "testnet" },
    }).onConflictDoNothing({ target: tradingOrdersTable.signalId }).returning();
    local = inserted ?? (await db.select().from(tradingOrdersTable)
      .where(eq(tradingOrdersTable.signalId, signal.id)).limit(1))[0];
  }
  if (!local || local.clientOrderId !== linkId) throw new Error("Order reservation mismatch.");
  const existing = await findOrder(signal.symbol, linkId);
  if (existing) {
    await inspectOrder(local, existing, await listPositions());
    return;
  }
  if (local.status !== "reserved") {
    throw new Error(`Order ${linkId} may have been sent; will not send again without manual review.`);
  }
  const positions = await listPositions();
  const openOrders = await listOpenOrders(signal.symbol);
  if ((!signal.reduce_only && positions.some((item) => item.symbol === signal.symbol)) ||
      openOrders.some((item) => item.orderLinkId !== linkId)) {
    throw new Error(`Existing position or order on ${signal.symbol}; entry blocked.`);
  }
  let riskNotional = Number(signal.quantity) * Number(signal.limit_price);
  if (signal.order_type === "market") {
    const price = await marketReferencePrice(signal.symbol, signal.side);
    const reference = Number(signal.limit_price);
    riskNotional = Number(signal.quantity) * price * 1.005;
    if (!Number.isFinite(reference) || Math.abs(price - reference) / reference > 0.01 ||
        riskNotional > Number(maxNotional)) {
      throw new Error("Market price differs from the signal reference or exceeds the notional cap.");
    }
  }
  // Hold the control-row lock through the network POST: a kill-switch update
  // cannot complete between our final check and submission. The reservation
  // transition uses a separate committed connection before POST, so even if
  // this process dies mid-flight a retry cannot send a second entry.
  const placed = await withTestnetControlFence(riskNotional, async () => {
    const [claimed] = await db.update(tradingOrdersTable)
      .set({ status: "dispatching", updatedAt: new Date() })
      .where(and(eq(tradingOrdersTable.id, local.id), eq(tradingOrdersTable.status, "reserved")))
      .returning();
    if (!claimed) throw new Error("Order was already dispatched by another worker.");
    return placeOrder({
      symbol: signal.symbol, side: signal.side, orderType: signal.order_type,
      quantity: signal.quantity, limitPrice: signal.limit_price,
      stopLoss: signal.stop_loss, takeProfit: signal.take_profit,
      reduceOnly: signal.reduce_only, linkId,
    });
  });
  if (placed.orderLinkId !== linkId || !placed.orderId) throw new Error("Bybit acknowledgement did not match client ID.");
  await db.update(tradingOrdersTable).set({
    exchangeOrderId: placed.orderId, status: "acknowledged", updatedAt: new Date(),
  }).where(eq(tradingOrdersTable.id, local.id));
  const remote = await findOrder(signal.symbol, linkId);
  await inspectOrder(local, remote, await listPositions());
  await db.insert(tradingAuditEventsTable).values({
    signalId: signal.id, eventType: "testnet_order_accepted",
    message: "Bybit Testnet order accepted with verified protective levels.",
    details: { clientOrderId: linkId, exchangeOrderId: placed.orderId },
  });
}

export async function haltTestnet(error: unknown, signalId?: string) {
  await halt(error instanceof Error ? error.message : "Unknown Bybit Testnet error.", signalId);
}