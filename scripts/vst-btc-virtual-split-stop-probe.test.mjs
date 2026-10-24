import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BingXLiveApiError } from "../artifacts/api-server/src/bullet-bot/bingx-live-api.mjs";
import {
  createVstGuardedFetch,
  runProbe,
  sameDecimal,
} from "./vst-btc-virtual-split-stop-probe.mjs";

const API_SYMBOL = "BTC-USDT";
const POLICY = "vst-btc-hedge-long10-short75";
const positionId = "position-virtual-split";
const entryId = "9007199254740993";
const originalId = "9007199254740994";

function stop(id, quantity, price, status = "NEW", time = Date.now(), posId = positionId) {
  return {
    symbol: API_SYMBOL, orderId: id, positionId: posId, type: "STOP_MARKET",
    status, side: "SELL", positionSide: "LONG", workingType: "MARK_PRICE",
    origQty: quantity, stopPrice: price, time,
  };
}

function newProbeState() {
  return {
    version: 1, environment: "vst", symbol: "BTCUSDT", createdAt: Date.now(),
    status: "entry_verified_full_attached_stop",
    entry: {
      clientOrderId: "vsplit_entry_test", orderId: entryId, positionId,
      quantity: "0.1", currentQuantity: "0.1", maxPrice: "105",
      signalStopPrice: "90", actualEntryPrice: "101",
      quantityPrecision: 3, pricePrecision: 1, stopOrderId: originalId,
      attachedFullStopVerified: true, fillsVerified: true,
    },
  };
}

function mockApi({ markPrice = "110", onCall = () => {}, failSplit = false } = {}) {
  const calls = [];
  const state = {
    positionQuantity: "0.1",
    positionId,
    orders: [stop(originalId, "0.1", "90")],
    history: [{
      symbol: API_SYMBOL, orderId: entryId, clientOrderId: "vsplit_entry_test",
      type: "LIMIT", side: "BUY", positionSide: "LONG", status: "FILLED",
      origQty: "0.1", executedQty: "0.1", avgPrice: "101",
    }],
    fills: {
      [entryId]: [{ symbol: API_SYMBOL, orderId: entryId, side: "BUY", qty: "0.1" }],
    },
  };
  const call = async (name, payload) => {
    calls.push({ name, payload });
    await onCall(name, payload, state);
  };
  const api = {
    contract: async () => ({ quantityPrecision: 3, pricePrecision: 1 }),
    placeVstOnePercentBoundedLong: async (payload) => {
      await call("entry", payload);
      assert.equal(payload.probePolicy, POLICY);
      state.history[0].clientOrderId = payload.clientOrderId;
      return { orderId: entryId };
    },
    queryOrderHistory: async (_symbol, options) => {
      await call("history", options);
      return state.history;
    },
    queryOrder: async (_symbol, { orderId }) => {
      await call("query-order", { orderId });
      return state.orders.find((row) => row.orderId === orderId) ??
        state.history.find((row) => row.orderId === orderId) ?? null;
    },
    queryFills: async (_symbol, { orderId } = {}) => {
      await call("fills", { orderId });
      return orderId === undefined
        ? Object.values(state.fills).flat()
        : state.fills[orderId] ?? [];
    },
    getPositions: async () => {
      await call("positions");
      return [{
        symbol: API_SYMBOL, positionSide: "LONG",
        positionAmt: state.positionQuantity, positionId: state.positionId,
      }];
    },
    getOpenOrders: async () => {
      await call("open-orders");
      return state.orders.map((row) => ({ ...row }));
    },
    getVstMarkPrice: async () => {
      await call("mark");
      return { markPrice, timestamp: Date.now() };
    },
    placeVstVirtualSplitLongStop: async (payload) => {
      await call("split-stop", payload);
      if (failSplit) throw new Error("ambiguous VST write result");
      const id = payload.stopPrice === "90" ? "9007199254740995" : "9007199254740996";
      const newStop = stop(id, payload.quantity, payload.stopPrice);
      state.orders.push(newStop);
      state.history.push({ ...newStop, status: "NEW" });
      return { orderId: id };
    },
    cancelVstAttachedLongStopAfterSplit: async (payload) => {
      await call("cancel-original", payload);
      assert.equal(payload.replacementStops.length, 2);
      state.orders = state.orders.filter((row) => row.orderId !== originalId);
      return { status: "CANCELED" };
    },
    closeVstVirtualSplitTranche: async (payload) => {
      await call("partial-close", payload);
      const id = "partial-close-id";
      state.history.push({
        symbol: API_SYMBOL, orderId: id, clientOrderId: payload.clientOrderId,
        side: "SELL", positionSide: "LONG", type: "MARKET", status: "FILLED",
        origQty: payload.quantity, executedQty: payload.quantity,
      });
      state.fills[id] = [{
        symbol: API_SYMBOL, orderId: id, side: "SELL", qty: payload.quantity,
      }];
      state.positionQuantity = "0.02";
      return { orderId: id };
    },
    cancelVstSplitStopAfterPartial: async (payload) => {
      await call("cancel-tranche-stop", payload);
      state.orders = state.orders.filter((row) =>
        row.orderId !== payload.stopToCancel.orderId);
      return { status: "CANCELED" };
    },
    closeLong: async (_symbol, quantity, clientOrderId) => {
      await call("emergency-close", { quantity, clientOrderId });
      const id = "emergency-close-id";
      state.history.push({
        symbol: API_SYMBOL, orderId: id, clientOrderId, side: "SELL",
        positionSide: "LONG", type: "MARKET", status: "FILLED",
        origQty: quantity, executedQty: quantity,
      });
      state.fills[id] = [{ symbol: API_SYMBOL, orderId: id, side: "SELL", qty: quantity }];
      state.positionQuantity = "0";
      state.orders = [];
      return { orderId: id };
    },
    emergencyCloseVstLong: async (payload) => {
      await call("emergency-close", payload);
      const id = "emergency-close-id";
      state.history.push({
        symbol: API_SYMBOL, orderId: id, clientOrderId: payload.clientOrderId,
        side: "SELL", positionSide: "LONG", type: "MARKET", status: "FILLED",
        origQty: payload.quantity, executedQty: payload.quantity,
      });
      state.fills[id] = [{
        symbol: API_SYMBOL, orderId: id, side: "SELL", qty: payload.quantity,
      }];
      state.positionQuantity = "0";
      state.orders = [];
      return { orderId: id };
    },
  };
  return { api, calls, state };
}

async function withStateFile(run, initialState) {
  const directory = await mkdtemp(join(tmpdir(), "vst-virtual-split-"));
  const statePath = join(directory, "state.json");
  try {
    if (initialState) await writeFile(statePath, `${JSON.stringify(initialState)}\n`);
    return await run(statePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("entry preserves exact signal stop; independently verified core80 and runner20 precede original cancel", async () => {
  await withStateFile(async (statePath) => {
    const { api, calls, state } = mockApi({
      onCall: async (name) => {
        if (!["entry", "split-stop", "cancel-original"].includes(name)) return;
        const persisted = JSON.parse(await readFile(statePath, "utf8"));
        const expected = name === "entry" ? "entry_intent_persisted"
          : name === "cancel-original" ? "original_stop_cancel_submitting_no_retry"
            : persisted.status;
        assert.equal(persisted.status, expected);
        if (name === "split-stop") {
          assert.match(persisted.status, /_stop_submitting_no_retry$/);
        }
      },
    });
    const entered = await runProbe({
      command: "enter", api, statePath, operatorConfirmed: true,
      quantity: "0.1", maxPrice: "105", stopPrice: "90",
    });
    assert.equal(entered.status, "entry_verified_full_attached_stop");
    assert.equal(entered.entry.signalStopPrice, "90");
    assert.equal(entered.entry.actualEntryPrice, "101");
    assert.equal(calls.find((row) => row.name === "entry").payload.stopLoss, "90");
    const entryClientId = calls.find((row) => row.name === "entry").payload.clientOrderId;
    assert.ok(entryClientId.length <= 32);
    assert.match(entryClientId, /^[A-Za-z0-9_-]+$/);
    assert.equal(state.orders.length, 1);
    assert.equal(state.orders[0].origQty, "0.1");

    const core = await runProbe({
      command: "split-core", api, statePath, operatorConfirmed: true,
    });
    assert.equal(core.status, "core_stop_verified_original_still_active");
    assert.equal(core.core.quantity, "0.08");
    assert.equal(core.core.stopPrice, "90");
    assert.equal(core.core.status, "independently_verified_open_and_history");

    const runner = await runProbe({
      command: "split-runner", api, statePath, operatorConfirmed: true,
    });
    assert.equal(runner.status, "both_replacement_stops_verified_original_still_active");
    assert.equal(runner.runner.quantity, "0.02");
    assert.equal(runner.runner.stopPrice, "101");
    assert.equal(runner.runner.status, "independently_verified_open_and_history");

    const canceled = await runProbe({
      command: "cancel-original", api, statePath, operatorConfirmed: true,
    });
    assert.equal(canceled.status, "split_stops_active_original_canceled");
    assert.equal(calls.findIndex((row) => row.name === "cancel-original") >
      calls.findIndex((row) => row.name === "split-stop"), true);
    assert.equal(state.orders.length, 2);
    assert.equal(state.orders.some((row) => row.orderId === originalId), false);
    assert.equal(state.orders.every((row) =>
      row.orderId === core.core.orderId || row.orderId === runner.runner.orderId), true);
    assert.equal(sameDecimal("0.08", "0.080"), true);
  });
});

test("BE at or above fresh mark blocks the split and leaves emergency close available", async () => {
  await withStateFile(async (statePath) => {
    const initial = newProbeState();
    initial.status = "core_stop_verified_original_still_active";
    initial.core = {
      orderId: "core-stop", quantity: "0.08", stopPrice: "90",
      status: "independently_verified_open_and_history",
    };
    await writeFile(statePath, `${JSON.stringify(initial)}\n`);
    const { api, calls, state } = mockApi({ markPrice: "101" });
    const coreStop = stop("core-stop", "0.08", "90");
    state.orders.push(coreStop);
    state.history.push({ ...coreStop, status: "NEW" });
    const blocked = await runProbe({
      command: "split-runner", api, statePath, operatorConfirmed: true,
    });
    assert.equal(blocked.status, "split_blocked_be_not_below_fresh_mark");
    assert.equal(calls.some((row) => row.name === "split-stop"), false);
    assert.equal(calls.some((row) => row.name === "cancel-original"), false);
    const closed = await runProbe({
      command: "emergency-close", api, statePath, operatorConfirmed: true,
    });
    assert.equal(closed.status, "emergency_close_submitted_reconcile_required");
    assert.equal(calls.find((row) => row.name === "emergency-close")
      .payload.quantity, "0.1");
  }, newProbeState());
});

test("ambiguous stop POST is persisted as terminal and never submitted again", async () => {
  await withStateFile(async (statePath) => {
    const { api, calls } = mockApi({ failSplit: true });
    const first = await runProbe({
      command: "split-core", api, statePath, operatorConfirmed: true,
    });
    assert.equal(first.status, "core_stop_unknown_halt_no_retry");
    await assert.rejects(runProbe({
      command: "split-core", api, statePath, operatorConfirmed: true,
    }), /split_stage_status_not_retryable/);
    assert.equal(calls.filter((row) => row.name === "split-stop").length, 1);
    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(persisted.core.status, "unknown_halt_no_retry");
  }, newProbeState());
});

test("original full stop cannot be canceled before both independent replacement verifications", async () => {
  await withStateFile(async (statePath) => {
    const { api, calls } = mockApi();
    await assert.rejects(runProbe({
      command: "cancel-original", api, statePath, operatorConfirmed: true,
    }), /no_probe_state/);
    assert.equal(calls.some((row) => row.name === "cancel-original"), false);
  });
});

test("guard isolates VST and burns a single stage permission before transport", async () => {
  let posts = 0;
  const guard = createVstGuardedFetch(async () => {
    posts += 1;
    return new Response("ok");
  }, { stage: "split-core", expected: { quantity: "0.08", stopPrice: "90" } });
  const url = new URL(`${"https://open-api-vst.bingx.com"}/openApi/swap/v2/trade/order`);
  for (const [key, value] of Object.entries({
    symbol: API_SYMBOL, side: "SELL", positionSide: "LONG", type: "STOP_MARKET",
    quantity: "0.08", stopPrice: "90", workingType: "MARK_PRICE",
    recvWindow: "5000", timestamp: String(Date.now()), signature: "a".repeat(64),
  })) url.searchParams.set(key, value);
  await guard(url, { method: "POST" });
  await assert.rejects(guard(url, { method: "POST" }), /single-write guard/);
  assert.equal(posts, 1);
  const mainnet = new URL(url);
  mainnet.hostname = "open-api.bingx.com";
  await assert.rejects(guard(mainnet, { method: "POST" }), /host isolation/);
});

test("guard permits signed broad positions reads and rejects invalid symbols or extra params", async () => {
  const diagnostics = [];
  let transports = 0;
  const guard = createVstGuardedFetch(async () => {
    transports += 1;
    return new Response("ok");
  }, { stage: "entry", onDiagnostic: (event) => diagnostics.push(event) });
  const baseUrl = new URL(
    "https://open-api-vst.bingx.com/openApi/swap/v2/user/positions",
  );
  for (const [key, value] of Object.entries({
    recvWindow: "5000", timestamp: String(Date.now()), signature: "a".repeat(64),
  })) baseUrl.searchParams.set(key, value);
  await guard(baseUrl, { method: "GET" });
  assert.equal(transports, 1);

  const wrongSymbol = new URL(baseUrl);
  wrongSymbol.searchParams.set("symbol", "ETH-USDT");
  await assert.rejects(guard(wrongSymbol, { method: "GET" }), /signed read guard/);

  const extraParam = new URL(baseUrl);
  extraParam.searchParams.set("unexpected", "value");
  await assert.rejects(guard(extraParam, { method: "GET" }), /signed read guard/);
  assert.equal(transports, 1);
  assert.deepEqual(diagnostics, [
    {
      method: "GET", path: "/openApi/swap/v2/user/positions", errorName: "Error",
    },
    {
      method: "GET", path: "/openApi/swap/v2/user/positions", errorName: "Error",
    },
  ]);
  assert.equal(JSON.stringify(diagnostics).includes("signature"), false);

  const symbolRoute = new URL(
    "https://open-api-vst.bingx.com/openApi/swap/v2/trade/openOrders",
  );
  for (const [key, value] of Object.entries({
    recvWindow: "5000", timestamp: String(Date.now()), signature: "a".repeat(64),
  })) symbolRoute.searchParams.set(key, value);
  await assert.rejects(guard(symbolRoute, { method: "GET" }), /signed read guard/);
  const correctSymbolRoute = new URL(symbolRoute);
  correctSymbolRoute.searchParams.set("symbol", API_SYMBOL);
  await guard(correctSymbolRoute, { method: "GET" });
  assert.equal(transports, 2);
});

test("guard diagnostic metadata never includes signed query data", async () => {
  const diagnostics = [];
  const guard = createVstGuardedFetch(async () => new Response("ok"), {
    stage: "entry", onDiagnostic: (event) => diagnostics.push(event),
  });
  const url = new URL(
    "https://open-api-vst.bingx.com/openApi/swap/v2/user/positions?signature=bad",
  );
  await assert.rejects(guard(url, { method: "GET" }), /signed read guard/);
  assert.deepEqual(diagnostics, [{
    method: "GET", path: "/openApi/swap/v2/user/positions", errorName: "Error",
  }]);
  assert.equal(JSON.stringify(diagnostics).includes("signature"), false);
});

test("market partial close selects exactly core or runner and verifies residual plus retained stop", async () => {
  await withStateFile(async (statePath) => {
    const { api, calls, state } = mockApi({
      onCall: async (name) => {
        if (!["partial-close", "cancel-tranche-stop"].includes(name)) return;
        const persisted = JSON.parse(await readFile(statePath, "utf8"));
        assert.match(persisted.status, name === "partial-close"
          ? /^core_partial_close_submitting_no_retry$/
          : /^core_partial_close_cleanup_submitting_no_retry$/);
      },
    });
    state.orders = [stop("core-stop", "0.08", "90"), stop("runner-stop", "0.02", "101")];
    const result = await runProbe({
      command: "partial-close", tranche: "core", api, statePath, operatorConfirmed: true,
    });
    assert.equal(result.status, "core_partial_close_verified_remaining_runner_protected");
    const closePayload = calls.find((row) => row.name === "partial-close").payload;
    assert.equal(closePayload.quantity, "0.08");
    assert.ok(closePayload.clientOrderId.length <= 32);
    assert.equal(closePayload.trancheStop.orderId, "core-stop");
    assert.equal(closePayload.retainedStop.orderId, "runner-stop");
    assert.equal(state.positionQuantity, "0.02");
    assert.deepEqual(state.orders.map((row) => row.orderId), ["runner-stop"]);
  }, {
    ...newProbeState(),
    status: "split_stops_active_original_canceled",
    core: {
      orderId: "core-stop", quantity: "0.08", stopPrice: "90",
      status: "independently_verified_open_and_history",
    },
    runner: {
      orderId: "runner-stop", quantity: "0.02", stopPrice: "101",
      status: "independently_verified_open_and_history",
    },
  });
});

test("full emergency close is independently reconciled against exact fills, flat position, and no orders", async () => {
  await withStateFile(async (statePath) => {
    const { api, calls } = mockApi();
    const state = await runProbe({
      command: "emergency-close", api, statePath, operatorConfirmed: true,
    });
    assert.equal(state.status, "emergency_close_submitted_reconcile_required");
    assert.ok(calls.find((row) => row.name === "emergency-close")
      .payload.clientOrderId.length <= 32);
    const reconciled = await runProbe({ command: "reconcile-close", api, statePath });
    assert.equal(reconciled.status, "emergency_close_verified_flat_no_orders_fills");
    assert.equal(reconciled.emergencyClose.reconciliation.openOrderCount, 0);
    assert.equal(calls.some((row) => row.name === "emergency-close"), true);
  }, newProbeState());
});

test("entry intent restart accepts delayed history without repost and reconciles exact protection", async () => {
  await withStateFile(async (statePath) => {
    const intent = newProbeState();
    intent.status = "entry_intent_persisted";
    intent.entry = {
      clientOrderId: "vsplit_entry_delayed", quantity: "0.1",
      signalStopPrice: "90", quantityPrecision: 3, pricePrecision: 1,
    };
    await writeFile(statePath, `${JSON.stringify(intent)}\n`);
    const { api, calls, state } = mockApi();
    state.history[0].clientOrderId = "unrelated-entry";

    const waiting = await runProbe({ command: "reconcile-entry", api, statePath });
    assert.equal(waiting.status, "entry_position_known_stop_unknown");
    assert.equal(waiting.entry.emergencyDiscoveredProtectedPosition, undefined);
    assert.equal(waiting.entry.positionId, positionId);
    assert.equal(waiting.entry.protectiveStopVerified, true);
    assert.equal(calls.some((row) => row.name === "entry"), false);

    state.history[0].clientOrderId = "vsplit_entry_delayed";
    const recovered = await runProbe({ command: "reconcile-entry", api, statePath });
    assert.equal(recovered.status, "entry_verified_full_attached_stop");
    assert.equal(recovered.entry.orderId, entryId);
    assert.equal(calls.some((row) => row.name === "entry"), false);
  });
});

test("core and runner recover from two spaced exact open-order snapshots without history", async () => {
  const realNow = Date.now;
  let now = realNow();
  try {
    Date.now = () => now;
    await withStateFile(async (statePath) => {
      const intent = newProbeState();
      intent.status = "core_stop_unknown_halt_no_retry";
      intent.entry.quantity = "0.1095";
      intent.entry.currentQuantity = "0.1095";
      intent.entry.signalStopPrice = "83171.4";
      intent.entry.quantityPrecision = 4;
      intent.entry.stopOrderId = "2104157263396167680";
      intent.core = {
        quantity: "0.0876", stopPrice: "83171.4", startedAt: now - 60_000,
        status: "unknown_halt_no_retry",
      };
      await writeFile(statePath, `${JSON.stringify(intent)}\n`);
      const { api, calls, state } = mockApi();
      state.positionQuantity = "0.1095";
      state.history = [];
      const original = stop("2104157263396167680", "0.1095", "83171.4",
        "NEW", now - 120_000);
      const coreStop = stop("2104157386398326784", "0.0876", "83171.4",
        "NEW", now - 30_000);
      state.orders = [original, coreStop];

      const coreFirst = await runProbe({
        command: "reconcile-split", tranche: "core", api, statePath,
      });
      assert.equal(coreFirst.status, "core_stop_unknown_halt_no_retry");
      assert.equal(coreFirst.core.orderId, undefined);
      assert.equal(coreFirst.core.reconciliationSnapshots.length, 1);
      assert.equal(calls.some((row) => row.name === "history"), false);
      now += 30_001;
      const coreRecovered = await runProbe({
        command: "reconcile-split", tranche: "core", api, statePath,
      });
      assert.equal(coreRecovered.status, "core_stop_verified_original_still_active");
      assert.equal(coreRecovered.core.orderId, "2104157386398326784");
      assert.equal(coreRecovered.core.status,
        "independently_verified_open_and_spaced_snapshots");
      assert.equal(coreRecovered.core.reconciliationSnapshots.length, 2);

      const current = JSON.parse(await readFile(statePath, "utf8"));
      current.status = "runner_stop_unknown_halt_no_retry";
      current.runner = {
        quantity: "0.0219", stopPrice: "101", startedAt: now,
        status: "unknown_halt_no_retry",
      };
      await writeFile(statePath, `${JSON.stringify(current)}\n`);
      const runnerStop = stop("runner-stop", "0.0219", "101", "NEW", now + 1_000);
      state.orders.push(runnerStop);
      now += 2_000;
      const runnerFirst = await runProbe({
        command: "reconcile-split", tranche: "runner", api, statePath,
      });
      assert.equal(runnerFirst.status, "runner_stop_unknown_halt_no_retry");
      assert.equal(runnerFirst.runner.orderId, undefined);
      now += 30_001;
      const runnerRecovered = await runProbe({
        command: "reconcile-split", tranche: "runner", api, statePath,
      });
      assert.equal(runnerRecovered.status,
        "both_replacement_stops_verified_original_still_active");
      assert.equal(runnerRecovered.runner.orderId, "runner-stop");
      assert.equal(calls.some((row) => row.name === "history"), false);
      assert.equal(calls.some((row) => row.name === "split-stop"), false);
    });
  } finally {
    Date.now = realNow;
  }
});

test("split reconciliation permanently halts on duplicate stops or changed exposure", async () => {
  const realNow = Date.now;
  const now = realNow();
  try {
    Date.now = () => now;
    await withStateFile(async (statePath) => {
      const intent = newProbeState();
      intent.status = "core_stop_unknown_halt_no_retry";
      intent.core = {
        quantity: "0.08", stopPrice: "90", startedAt: now - 60_000,
        status: "unknown_halt_no_retry",
      };
      await writeFile(statePath, `${JSON.stringify(intent)}\n`);
      const { api, calls, state } = mockApi();
      state.orders.push(
        stop("duplicate-core-a", "0.08", "90", "NEW", now - 30_000),
        stop("duplicate-core-b", "0.08", "90", "NEW", now - 30_000),
      );
      const duplicate = await runProbe({
        command: "reconcile-split", tranche: "core", api, statePath,
      });
      assert.equal(duplicate.core.reconciliationBlocked, true);
      assert.equal(duplicate.core.orderId, undefined);
      assert.equal(calls.some((row) => row.name === "split-stop"), false);
    });

    await withStateFile(async (statePath) => {
      const intent = newProbeState();
      intent.status = "core_stop_unknown_halt_no_retry";
      intent.core = {
        quantity: "0.08", stopPrice: "90", startedAt: now - 60_000,
        status: "unknown_halt_no_retry",
      };
      await writeFile(statePath, `${JSON.stringify(intent)}\n`);
      const { api, calls, state } = mockApi();
      state.orders.push(stop("core-stop-exposure-change", "0.08", "90",
        "NEW", now - 30_000));
      await runProbe({ command: "reconcile-split", tranche: "core", api, statePath });
      state.positionQuantity = "0.08";
      const changed = await runProbe({
        command: "reconcile-split", tranche: "core", api, statePath,
      });
      assert.equal(changed.core.reconciliationBlocked, true);
      assert.equal(changed.core.orderId, undefined);
      assert.equal(changed.status, "core_stop_unknown_halt_no_retry");
      assert.equal(calls.some((row) => row.name === "split-stop"), false);
    });
  } finally {
    Date.now = realNow;
  }
});

test("split reconciliation rejects a matching stop created before the persisted POST intent", async () => {
  const now = Date.now();
  const intent = newProbeState();
  intent.status = "core_stop_unknown_halt_no_retry";
  intent.core = {
    quantity: "0.08", stopPrice: "90", startedAt: now - 30_000,
    status: "unknown_halt_no_retry",
  };
  await withStateFile(async (statePath) => {
    await writeFile(statePath, `${JSON.stringify(intent)}\n`);
    const { api, calls, state } = mockApi();
    state.orders.push(stop("old-core-stop", "0.08", "90", "NEW", now - 60_000));
    const result = await runProbe({
      command: "reconcile-split", tranche: "core", api, statePath,
    });
    assert.equal(result.core.orderId, undefined);
    assert.equal(result.core.observation, "no_exact_new_stop_in_open_orders");
    assert.equal(result.core.reconciliationSnapshots, undefined);
    assert.equal(calls.some((row) => row.name === "history"), false);
    assert.equal(calls.some((row) => row.name === "split-stop"), false);
  });
});

test("triggered runner child fill verifies exact residual protection and permits one full close", async () => {
  await withStateFile(async (statePath) => {
    const actualPositionId = "2104157262508457985";
    const originalStopId = "2104157263396167680";
    const coreStopId = "2104157386398326784";
    const runnerStopId = "2104158374836396032";
    const childFillId = "2104158803529302017";
    const intent = {
      ...newProbeState(),
      status: "both_replacement_stops_verified_original_still_active",
      entry: {
        ...newProbeState().entry,
        quantity: "0.1095", currentQuantity: "0.1095",
        quantityPrecision: 4, signalStopPrice: "83171.4",
        actualEntryPrice: "84858.1", positionId: actualPositionId,
        stopOrderId: originalStopId,
      },
      core: {
        orderId: coreStopId, quantity: "0.0876", stopPrice: "83171.4",
        status: "independently_verified_open_and_spaced_snapshots",
      },
      runner: {
        orderId: runnerStopId, quantity: "0.0219", stopPrice: "84858.1",
        startedAt: Date.now() - 120_000,
        status: "independently_verified_open_and_history",
      },
    };
    await writeFile(statePath, `${JSON.stringify(intent)}\n`);
    const { api, calls, state } = mockApi();
    state.positionId = actualPositionId;
    state.positionQuantity = "0.0876";
    state.orders = [
      stop(originalStopId, "0.0876", "83171.4", "NEW",
        Date.now() - 300_000, actualPositionId),
      stop(coreStopId, "0.0876", "83171.4", "NEW",
        Date.now() - 240_000, actualPositionId),
    ];
    state.history.push({
      symbol: API_SYMBOL, orderId: runnerStopId, positionId: actualPositionId,
      type: "STOP_MARKET", status: "FILLED", side: "SELL",
      positionSide: "LONG", workingType: "MARK_PRICE",
      origQty: "0.0219", executedQty: "0.0219", stopPrice: "84858.1",
    });
    state.fills[childFillId] = [{
      symbol: API_SYMBOL, orderId: childFillId,
      triggerOrderId: runnerStopId, positionId: actualPositionId,
      side: "SELL", positionSide: "LONG",
      qty: "0.0219", volume: "0.0219", price: "84858.1",
      commission: "-0.929196", commissionAsset: "USDT",
    }];

    const reconciled = await runProbe({
      command: "reconcile-triggered-runner", api, statePath,
    });
    assert.equal(reconciled.status,
      "runner_triggered_residual_protected_emergency_close_available");
    assert.equal(reconciled.entry.currentQuantity, "0.0876");
    assert.equal(reconciled.runner.status, "filled_triggered_verified");
    assert.equal(reconciled.triggeredRunner.childFill.orderId, childFillId);
    assert.equal(reconciled.triggeredRunner.childFill.triggerOrderId, runnerStopId);
    assert.equal(reconciled.triggeredRunner.childFill.quantity, "0.0219");
    assert.equal(reconciled.triggeredRunner.childFill.price, "84858.1");
    assert.equal(reconciled.triggeredRunner.childFill.feeAmount, "-0.929196");
    assert.equal(reconciled.triggeredRunner.childFill.feeAsset, "USDT");
    assert.deepEqual(state.orders.map((row) => row.orderId),
      [originalStopId, coreStopId]);
    assert.equal(calls.some((row) =>
      ["split-stop", "partial-close", "cancel-original", "cancel-tranche-stop"]
        .includes(row.name)), false);

    const closeIntent = await runProbe({
      command: "emergency-close", api, statePath, operatorConfirmed: true,
    });
    assert.equal(closeIntent.emergencyClose.quantity, "0.0876");
    assert.equal(calls.find((row) => row.name === "emergency-close")
      .payload.quantity, "0.0876");
    await assert.rejects(runProbe({
      command: "emergency-close", api, statePath, operatorConfirmed: true,
    }), /emergency_close_requires_known_persisted_position/);
    assert.equal(calls.filter((row) => row.name === "emergency-close").length, 1);

    const closed = await runProbe({ command: "reconcile-close", api, statePath });
    assert.equal(closed.status, "emergency_close_verified_flat_no_orders_fills");
    assert.equal(closed.emergencyClose.reconciliation.openOrderCount, 0);
    assert.equal(state.positionQuantity, "0");
    assert.deepEqual(state.orders, []);
  });
});

test("triggered runner reconciliation accepts exact child queryOrder ID with zero positionID", async () => {
  await withStateFile(async (statePath) => {
    const actualPositionId = "2104157262508457985";
    const originalStopId = "2104157263396167680";
    const coreStopId = "2104157386398326784";
    const runnerStopId = "2104158374836396032";
    const childFillId = "2104158803529302017";
    const intent = {
      ...newProbeState(),
      status: "both_replacement_stops_verified_original_still_active",
      entry: {
        ...newProbeState().entry,
        quantity: "0.1095", currentQuantity: "0.1095",
        quantityPrecision: 4, signalStopPrice: "83171.4",
        actualEntryPrice: "84858.1", positionId: actualPositionId,
        stopOrderId: originalStopId,
      },
      core: {
        orderId: coreStopId, quantity: "0.0876", stopPrice: "83171.4",
        status: "independently_verified_open_and_spaced_snapshots",
      },
      runner: {
        orderId: runnerStopId, quantity: "0.0219", stopPrice: "84858.1",
        startedAt: Date.now() - 120_000,
        status: "independently_verified_open_and_history",
      },
    };
    await writeFile(statePath, `${JSON.stringify(intent)}\n`);
    const { api, calls, state } = mockApi();
    state.positionId = actualPositionId;
    state.positionQuantity = "0.0876";
    state.orders = [
      stop(originalStopId, "0.0876", "83171.4", "NEW",
        Date.now() - 300_000, actualPositionId),
      stop(coreStopId, "0.0876", "83171.4", "NEW",
        Date.now() - 240_000, actualPositionId),
    ];
    const filledParent = {
      symbol: API_SYMBOL, orderId: runnerStopId, positionId: actualPositionId,
      type: "STOP_MARKET", status: "FILLED", side: "SELL",
      positionSide: "LONG", workingType: "MARK_PRICE",
      origQty: "0.0219", executedQty: "0.0219",
    };
    state.history.push(filledParent);
    api.queryOrder = async (_symbol, { orderId }) => {
      calls.push({ name: "query-order", payload: { orderId } });
      assert.equal(orderId, runnerStopId);
      return {
        ...filledParent, orderId: childFillId, orderID: childFillId,
        positionId: 0, positionID: 0,
        workingType: undefined,
      };
    };
    state.fills[childFillId] = [{
      symbol: API_SYMBOL, orderId: childFillId,
      triggerOrderId: runnerStopId, positionId: 0, positionID: 0,
      side: "SELL", positionSide: "LONG",
      volume: "0.0219", price: "84858.1",
      commission: "-0.929196", commissionAsset: "USDT",
    }];

    const recovered = await runProbe({
      command: "reconcile-triggered-runner", api, statePath,
    });
    assert.equal(recovered.status,
      "runner_triggered_residual_protected_emergency_close_available");
    assert.equal(recovered.triggeredRunner.runnerOrderId, runnerStopId);
    assert.equal(recovered.triggeredRunner.childFill.orderId, childFillId);
    assert.equal(recovered.triggeredRunner.childFill.triggerOrderId, runnerStopId);
    assert.equal(recovered.entry.currentQuantity, "0.0876");
    assert.equal(calls.some((row) => row.name === "emergency-close"), false);
    assert.equal(calls.some((row) => row.name === "cancel-original"), false);
    assert.equal(calls.some((row) => row.name === "cancel-tranche-stop"), false);
  });
});

test("original-stop DELETE intent recovers by read-only order/history/fill evidence after restart", async () => {
  await withStateFile(async (statePath) => {
    const intent = {
      ...newProbeState(), status: "original_stop_cancel_submitting_no_retry",
      core: {
        orderId: "core-stop", quantity: "0.08", stopPrice: "90",
        startedAt: Date.now() - 5 * 60_000,
        status: "independently_verified_open_and_history",
      },
      runner: {
        orderId: "runner-stop", quantity: "0.02", stopPrice: "101",
        startedAt: Date.now() - 3 * 60_000,
        status: "independently_verified_open_and_history",
      },
      originalStopCancellation: {
        orderId: originalId, startedAt: Date.now(), status: "persisted_no_retry",
      },
    };
    await writeFile(statePath, `${JSON.stringify(intent)}\n`);
    const { api, calls, state } = mockApi();
    const original = stop(originalId, "0.1", "90");
    const coreStop = stop("core-stop", "0.08", "90");
    const runnerStop = stop("runner-stop", "0.02", "101");
    state.orders = [original, coreStop, runnerStop];
    state.history.push({ ...coreStop, status: "NEW" }, { ...runnerStop, status: "NEW" });
    state.history.push({ ...original, status: "NEW" });

    const stillOpen = await runProbe({
      command: "reconcile-cancel-original", api, statePath,
    });
    assert.equal(stillOpen.status, "original_stop_cancel_unknown_halt_no_retry");
    assert.equal(calls.some((row) => row.name === "cancel-original"), false);
    const historyWindows = calls.filter((row) => row.name === "history")
      .map((row) => row.payload.startTs);
    assert.ok(historyWindows.includes(intent.core.startedAt - 60_000));
    assert.ok(historyWindows.includes(intent.runner.startedAt - 60_000));

    state.orders = [coreStop, runnerStop];
    state.history[state.history.length - 1].status = "CANCELED";
    const recovered = await runProbe({
      command: "reconcile-cancel-original", api, statePath,
    });
    assert.equal(recovered.status, "split_stops_active_original_canceled");
    assert.equal(calls.some((row) => row.name === "cancel-original"), false);
  });
});

test("emergency-close submitting intent survives delayed history/fills and repeated read-only reconciliation", async () => {
  await withStateFile(async (statePath) => {
    const intent = newProbeState();
    intent.status = "emergency_close_submitting_no_retry";
    intent.emergencyClose = {
      clientOrderId: "vsplit_emergency_delayed", quantity: "0.1",
      startedAt: Date.now(), status: "intent_persisted_no_retry",
    };
    await writeFile(statePath, `${JSON.stringify(intent)}\n`);
    const { api, calls, state } = mockApi();

    const delayed = await runProbe({ command: "reconcile-close", api, statePath });
    assert.equal(delayed.status, "emergency_close_reconciliation_incomplete");
    assert.equal(calls.some((row) => row.name === "emergency-close"), false);

    const emergencyId = "emergency-delayed-id";
    state.history.push({
      symbol: API_SYMBOL, orderId: emergencyId,
      clientOrderId: "vsplit_emergency_delayed",
      side: "SELL", positionSide: "LONG", type: "MARKET", status: "FILLED",
      origQty: "0.1", executedQty: "0.1",
    });
    state.fills[emergencyId] = [{
      symbol: API_SYMBOL, orderId: emergencyId, side: "SELL", qty: "0.1",
    }];
    state.positionQuantity = "0";
    state.orders = [];
    const recovered = await runProbe({ command: "reconcile-close", api, statePath });
    assert.equal(recovered.status, "emergency_close_verified_flat_no_orders_fills");
    assert.equal(calls.some((row) => row.name === "emergency-close"), false);
  });
});

test("partial market-fill and cleanup-delete crash boundaries recover from delayed exact reads only", async () => {
  await withStateFile(async (statePath) => {
    const intent = {
      ...newProbeState(), status: "core_partial_close_submitting_no_retry",
      core: {
        orderId: "core-stop", quantity: "0.08", stopPrice: "90",
        status: "independently_verified_open_and_history",
      },
      runner: {
        orderId: "runner-stop", quantity: "0.02", stopPrice: "101",
        status: "independently_verified_open_and_history",
      },
      partialClose: {
        role: "core", clientOrderId: "vsplit_core_close_delayed",
        quantity: "0.08", remainingQuantity: "0.02",
        startedAt: Date.now(), status: "market_intent_persisted_no_retry",
      },
    };
    await writeFile(statePath, `${JSON.stringify(intent)}\n`);
    const { api, calls, state } = mockApi();
    const coreStop = stop("core-stop", "0.08", "90");
    const runnerStop = stop("runner-stop", "0.02", "101");
    state.orders = [coreStop, runnerStop];

    const delayed = await runProbe({
      command: "reconcile-partial-close", api, statePath,
    });
    assert.equal(delayed.status, "core_partial_close_unknown_halt_no_retry");
    assert.equal(calls.some((row) => row.name === "partial-close"), false);

    const partialId = "partial-close-delayed";
    state.history.push({
      symbol: API_SYMBOL, orderId: partialId,
      clientOrderId: "vsplit_core_close_delayed",
      side: "SELL", positionSide: "LONG", type: "MARKET", status: "FILLED",
      origQty: "0.08", executedQty: "0.08",
    });
    state.fills[partialId] = [{
      symbol: API_SYMBOL, orderId: partialId, side: "SELL", qty: "0.08",
    }];
    state.positionQuantity = "0.02";
    const ready = await runProbe({
      command: "reconcile-partial-close", api, statePath,
    });
    assert.equal(ready.status, "core_partial_close_cleanup_ready");
    assert.equal(calls.some((row) => row.name === "partial-close"), false);
  });

  await withStateFile(async (statePath) => {
    const intent = {
      ...newProbeState(), status: "core_partial_close_cleanup_submitting_no_retry",
      core: {
        orderId: "core-stop", quantity: "0.08", stopPrice: "90",
        status: "independently_verified_open_and_history",
      },
      runner: {
        orderId: "runner-stop", quantity: "0.02", stopPrice: "101",
        status: "independently_verified_open_and_history",
      },
      partialClose: {
        role: "core", clientOrderId: "vsplit_core_close_done",
        quantity: "0.08", remainingQuantity: "0.02",
        startedAt: Date.now(), orderId: "partial-close-done",
        status: "unknown_halt_no_retry", remainingPositionVerified: true,
        cancelIntent: {
          stopOrderId: "core-stop", startedAt: Date.now(),
          status: "persisted_no_retry",
        },
      },
      entry: {
        ...newProbeState().entry, currentQuantity: "0.02",
      },
    };
    await writeFile(statePath, `${JSON.stringify(intent)}\n`);
    const { api, calls, state } = mockApi();
    const runnerStop = stop("runner-stop", "0.02", "101");
    const canceledCore = stop("core-stop", "0.08", "90", "CANCELED");
    state.orders = [runnerStop];
    state.history.push({
      symbol: API_SYMBOL, orderId: "partial-close-done",
      clientOrderId: "vsplit_core_close_done",
      side: "SELL", positionSide: "LONG", type: "MARKET", status: "FILLED",
      origQty: "0.08", executedQty: "0.08",
    });
    state.fills["partial-close-done"] = [{
      symbol: API_SYMBOL, orderId: "partial-close-done",
      side: "SELL", qty: "0.08",
    }];
    state.history.push(canceledCore);
    state.positionQuantity = "0.02";
    const recovered = await runProbe({
      command: "reconcile-partial-close", api, statePath,
    });
    assert.equal(recovered.status, "core_partial_close_verified_remaining_runner_protected");
    assert.equal(calls.some((row) => row.name === "cancel-tranche-stop"), false);
  });
});

test("uncertain entry with exact attached protection retains emergency close path", async () => {
  await withStateFile(async (statePath) => {
    const intent = newProbeState();
    intent.status = "entry_intent_persisted";
    intent.entry.clientOrderId = "vsplit_entry_uncertain";
    delete intent.entry.positionId;
    delete intent.entry.orderId;
    await writeFile(statePath, `${JSON.stringify(intent)}\n`);
    const { api, calls } = mockApi();
    const recovered = await runProbe({
      command: "emergency-close", api, statePath, operatorConfirmed: true,
    });
    assert.equal(recovered.status, "emergency_close_submitted_reconcile_required");
    assert.equal(recovered.entry.emergencyDiscoveredProtectedPosition, true);
    assert.equal(calls.find((row) => row.name === "emergency-close")
      .payload.quantity, "0.1");
    assert.equal(calls.some((row) => row.name === "entry"), false);
  });
});

test("flat-stop cleanup persisted before DELETE can be reconciled after restart without retry", async () => {
  await withStateFile(async (statePath) => {
    const intent = newProbeState();
    intent.status = "emergency_close_flat_or_orders_unverified";
    intent.emergencyClose = {
      clientOrderId: "vsplit_emergency_flat_cleanup",
      quantity: "0.1", startedAt: Date.now(),
      status: "submitted_reconcile_required",
    };
    intent.flatStopCleanup = {
      [originalId]: {
        orderId: originalId, startedAt: Date.now(), status: "persisted_no_retry",
      },
    };
    await writeFile(statePath, `${JSON.stringify(intent)}\n`);
    const { api, calls, state } = mockApi();
    state.positionQuantity = "0";
    state.orders = [];
    state.history.push(stop(originalId, "0.1", "90", "CANCELED"));
    const recovered = await runProbe({
      command: "reconcile-flat-stop", orderId: originalId, api, statePath,
    });
    assert.equal(recovered.flatStopCleanup[originalId].status,
      "canceled_no_fills_verified");
    assert.equal(calls.some((row) => row.name === "query-order"), true);
    assert.equal(calls.some((row) => row.name === "cancel-tranche-stop"), false);
    assert.equal(calls.some((row) => row.name === "emergency-close"), false);
  });
});

test("verified partial fill with vanished retained stop persists exact residual and allows one emergency close", async () => {
  await withStateFile(async (statePath) => {
    const intent = {
      ...newProbeState(), status: "core_partial_close_submitting_no_retry",
      core: {
        orderId: "core-stop", quantity: "0.08", stopPrice: "90",
        status: "independently_verified_open_and_history",
      },
      runner: {
        orderId: "runner-stop", quantity: "0.02", stopPrice: "101",
        status: "independently_verified_open_and_history",
      },
      partialClose: {
        role: "core", clientOrderId: "vsplit_core_close_missing_stop",
        quantity: "0.08", remainingQuantity: "0.02",
        startedAt: Date.now(), status: "market_intent_persisted_no_retry",
      },
    };
    await writeFile(statePath, `${JSON.stringify(intent)}\n`);
    const { api, calls, state } = mockApi();
    state.positionQuantity = "0.02";
    state.orders = [];
    state.history.push({
      symbol: API_SYMBOL, orderId: "partial-close-missing-stop",
      clientOrderId: "vsplit_core_close_missing_stop",
      side: "SELL", positionSide: "LONG", type: "MARKET", status: "FILLED",
      origQty: "0.08", executedQty: "0.08",
    });

    const delayedFill = await runProbe({
      command: "reconcile-partial-close", api, statePath,
    });
    assert.equal(delayedFill.status, "core_partial_close_unknown_halt_no_retry");
    await assert.rejects(runProbe({
      command: "emergency-close", api, statePath, operatorConfirmed: true,
    }), /emergency_close_known_position_does_not_match/);
    assert.equal(calls.some((row) => row.name === "emergency-close"), false);

    state.fills["partial-close-missing-stop"] = [{
      symbol: API_SYMBOL, orderId: "partial-close-missing-stop",
      side: "SELL", qty: "0.08",
    }];
    const reconciled = await runProbe({
      command: "reconcile-partial-close", api, statePath,
    });
    assert.equal(reconciled.status,
      "core_partial_close_residual_unprotected_emergency_required");
    assert.equal(reconciled.entry.currentQuantity, "0.02");
    assert.equal(reconciled.partialClose.remainingPositionVerified, true);
    assert.equal(reconciled.partialClose.orderId, "partial-close-missing-stop");
    assert.equal(reconciled.partialClose.positionId, positionId);
    assert.equal(reconciled.partialClose.remainingQuantity, "0.02");
    assert.equal(reconciled.partialClose.protectionReconciliation,
      "retained_protective_stop_missing_or_not_exact");

    const closed = await runProbe({
      command: "emergency-close", api, statePath, operatorConfirmed: true,
    });
    assert.equal(closed.status, "emergency_close_submitted_reconcile_required");
    assert.equal(calls.find((row) => row.name === "emergency-close")
      .payload.quantity, "0.02");
    await assert.rejects(runProbe({
      command: "emergency-close", api, statePath, operatorConfirmed: true,
    }), /emergency_close_requires_known_persisted_position/);
    assert.equal(calls.filter((row) => row.name === "emergency-close").length, 1);
  });
});

test("overlong pre-sign entry attempt is archived only after two delayed flat no-fill snapshots", async () => {
  await withStateFile(async (statePath) => {
    const failedClientId = "vsplit_entry_cd909baec6c54c3a84e7ef3f";
    const intent = {
      ...newProbeState(),
      status: "entry_reconciliation_incomplete",
      entry: {
        ...newProbeState().entry,
        clientOrderId: failedClientId,
        quantity: "0.1095", maxPrice: "85120.3",
        signalStopPrice: "83251.2",
      },
      error: "A unique clientOrderId is required for duplicate-order protection",
    };
    await writeFile(statePath, `${JSON.stringify(intent)}\n`);
    const { api, calls, state } = mockApi();
    state.positionQuantity = "0";
    state.orders = [];
    state.history = [];
    state.fills = {};

    const realNow = Date.now;
    let simulatedNow = realNow();
    let first;
    let archived;
    try {
      Date.now = () => simulatedNow;
      first = await runProbe({ command: "archive-no-fill", api, statePath });
      assert.equal(first.status, "entry_reconciliation_incomplete");
      assert.equal(first.entry.noFillArchive.status, "second_delayed_snapshot_required");
      assert.equal(first.entry.noFillArchive.snapshots.length, 1);
      assert.equal(calls.some((row) =>
        ["entry", "split-stop", "cancel-original", "emergency-close"].includes(row.name)), false);
      simulatedNow += 30_001;
      archived = await runProbe({ command: "archive-no-fill", api, statePath });
    } finally {
      Date.now = realNow;
    }
    assert.equal(archived.status, "archived_no_fill");
    assert.equal(archived.entry.clientOrderId, failedClientId);
    assert.equal(archived.error, intent.error);
    assert.equal(archived.entry.noFillArchive.proofMethod,
      "two_delayed_complete_no_fill_snapshots");
    assert.equal(archived.entry.noFillArchive.snapshots.length, 2);
    assert.ok(archived.entry.noFillArchive.snapshots[1].observedAt -
      archived.entry.noFillArchive.snapshots[0].observedAt >= 30_000);
    await assert.rejects(readFile(statePath, "utf8"));
    const preserved = JSON.parse(await readFile(archived.archivePath, "utf8"));
    assert.equal(preserved.status, "archived_no_fill");
    assert.equal(preserved.entry.clientOrderId, failedClientId);
    assert.equal(preserved.error, intent.error);
    assert.equal(calls.filter((row) => row.name === "history").length, 2);
    assert.equal(calls.filter((row) => row.name === "fills").length, 2);
    assert.equal(calls.filter((row) => row.name === "positions").length, 2);
    assert.equal(calls.filter((row) => row.name === "open-orders").length, 2);
    assert.equal(calls.some((row) =>
      ["entry", "split-stop", "cancel-original", "emergency-close"].includes(row.name)), false);
  });
});

test("archive-no-fill refuses a matching entry order despite flat snapshots", async () => {
  await withStateFile(async (statePath) => {
    const intent = {
      ...newProbeState(), status: "entry_reconciliation_incomplete",
      entry: { ...newProbeState().entry, clientOrderId: "vsplit_entry_ambiguous" },
    };
    await writeFile(statePath, `${JSON.stringify(intent)}\n`);
    const { api, state } = mockApi();
    state.positionQuantity = "0";
    state.orders = [];
    state.history = [{
      symbol: API_SYMBOL, orderId: "ambiguous-entry",
      clientOrderId: "vsplit_entry_ambiguous",
    }];
    const result = await runProbe({ command: "archive-no-fill", api, statePath });
    assert.equal(result.status, "entry_reconciliation_incomplete");
    assert.equal(result.entry.noFillArchive.status, "proof_incomplete_retry_read_only");
    assert.deepEqual(result.entry.noFillArchive.snapshots, []);
    assert.equal(result.entry.noFillArchive.lastObservation.matchingEntryRows, 1);
  });
});

test("typed adapter pre-sign client-id rejection is persisted as no-POST evidence", async () => {
  await withStateFile(async (statePath) => {
    const { api } = mockApi();
    api.contract = async () => ({
      quantityPrecision: 4, pricePrecision: 1, minQuantity: "0.0001",
    });
    api.placeVstOnePercentBoundedLong = async () => {
      throw new BingXLiveApiError(
        "A unique clientOrderId is required for duplicate-order protection",
        { code: "INVALID_CLIENT_ORDER_ID", transportStage: "pre-sign" },
      );
    };
    const result = await runProbe({
      command: "enter", api, statePath, quantity: "0.1095",
      maxPrice: "85120.3", stopPrice: "83251.2", operatorConfirmed: true,
    });
    assert.equal(result.status, "entry_unknown_halt_no_retry");
    assert.equal(result.entry.postAttemptEvidence.status, "signed_post_not_attempted");
    assert.equal(result.entry.postAttemptEvidence.code, "INVALID_CLIENT_ORDER_ID");
    assert.ok(result.entry.clientOrderId.length <= 32);
  });
});