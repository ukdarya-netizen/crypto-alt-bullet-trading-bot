import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  createGuardedFetch,
  parseArgs,
  runLeveragePrep,
  SHARED_VST_BTC_LOCK,
} from "./vst-leverage-prep.mjs";
import { SHARED_VST_BTC_LOCK as probeLock } from "./vst-stop-coexist-probe.mjs";

const host = "https://open-api-vst.bingx.com";
const path = "/openApi/swap/v2/trade/leverage";

function signedLeverage({ symbol = "BTC-USDT", leverage = "10", side = "LONG" } = {}) {
  const url = new URL(`${host}${path}`);
  for (const [key, value] of Object.entries({
    symbol, leverage, side, recvWindow: "5000", timestamp: String(Date.now()),
    signature: "a".repeat(64),
  })) url.searchParams.set(key, value);
  return url;
}

function mockApi() {
  const leverage = { longLeverage: 75, shortLeverage: 75 };
  const writes = [];
  let positions = [];
  let orders = [];
  return {
    leverage,
    writes,
    setPositions(value) { positions = value; },
    setOrders(value) { orders = value; },
    async getPositions() { return positions; },
    async getOpenOrders() { return orders; },
    async getPositionMode() { return "HEDGE"; },
    async getMarginType() { return "ISOLATED"; },
    async getLeverage() { return { ...leverage }; },
    async setVstLeverage(symbol, value, side) {
      if (side !== "LONG") throw new Error("test_forbids_short_leverage_write");
      writes.push({ symbol, value, side });
      leverage.longLeverage = value;
    },
  };
}

function restoredLongState(readOnlyObservations = []) {
  return {
    environment: "vst",
    symbol: "BTCUSDT",
    workflow: "vst-btc-long-only",
    originalLeverage: { long: 75, short: 75 },
    status: "restored_long_only_75x_75x",
    probeReady: false,
    pendingWrite: null,
    restoreLong: {
      status: "verified_75x_75x",
      side: "LONG",
      from: 10,
      target: 75,
      probeTerminalStatus: "emergency_close_verified_closed",
    },
    lastConfirmedWrite: {
      command: "restore-long",
      side: "LONG",
      from: 10,
      target: 75,
      verification: "adapter_setVstLeverage_get_verified",
    },
    lastObservedLeverage: { long: 75, short: 75 },
    statusObservedAt: 90_000,
    readOnlyObservations,
  };
}

function abortedLongState(readOnlyObservations = []) {
  return {
    environment: "vst",
    symbol: "BTCUSDT",
    workflow: "vst-btc-long-only",
    createdAt: 50_000,
    originalLeverage: { long: 75, short: 75 },
    status: "restored_long_only_75x_75x",
    probeReady: true,
    pendingWrite: null,
    abortRestoreLong: {
      status: "verified_75x_75x",
      side: "LONG",
      from: 10,
      target: 75,
      startedAt: 300_000,
      preparationEvidence: {
        command: "prepare-long",
        side: "LONG",
        from: 75,
        target: 10,
        verification: "adapter_setVstLeverage_get_verified",
        verifiedAt: 70_000,
      },
      preparationStatusObservedAt: 80_000,
    },
    lastConfirmedWrite: {
      command: "abort-restore-long",
      side: "LONG",
      from: 10,
      target: 75,
      verification: "adapter_setVstLeverage_get_verified",
      verifiedAt: 310_000,
    },
    lastObservedLeverage: { long: 75, short: 75 },
    statusObservedAt: 390_000,
    readOnlyObservations,
  };
}

function flatLeverageObservation(observedAt) {
  return {
    observedAt,
    leverage: { long: 75, short: 75 },
    flat: true,
    openOrderCount: 0,
    positionMode: "HEDGE",
    marginMode: "ISOLATED",
  };
}

function archivedNoFillProbeState() {
  const attemptStartedAt = 100_000;
  const historyWindowStart = attemptStartedAt - 60_000;
  const firstObservation = {
    observedAt: 200_001,
    attemptStartedAt,
    allOrdersWindowStart: historyWindowStart,
    allOrdersWindowEnd: 200_000,
    clientOrderId: "entry-client-1",
    signedOrderLookupNotFoundCode: "109421",
    clientOrderIdAbsentFromAllOrders: true,
    zeroBtcFillsVst: true,
    zeroBtcFillsUsdt: true,
    flatBtcBeforeAndAfterHistory: true,
    noOpenOrdersBeforeAndAfterHistory: true,
  };
  const secondObservation = {
    ...firstObservation,
    observedAt: 210_002,
    allOrdersWindowEnd: 210_000,
  };
  return {
    environment: "vst",
    symbol: "BTCUSDT",
    createdAt: 90_000,
    status: "archived_no_fill_operator_verified",
    entry: {
      clientOrderId: "entry-client-1",
      attemptStartedAt,
      noFillArchive: {
        status: "verified",
        operatorConfirmed: true,
        firstObservation,
        secondObservation,
        separationMs: 10_001,
        attemptStartedAt,
        historyWindowStart,
      },
    },
  };
}

function reconciledProbeCloseState() {
  const firstSnapshot = {
    observedAt: 100_000,
    orderId: "close-order-1",
    positionId: "position-1",
    quantity: "0.01",
    closeFillsVerified: true,
    originalStopId: "stop-order-1",
    originalStopCanceledNoFills: true,
    flatBtcPositionRows: 0,
    openOrdersEmpty: true,
  };
  const secondSnapshot = { ...firstSnapshot, observedAt: 110_001 };
  return {
    environment: "vst",
    symbol: "BTCUSDT",
    status: "emergency_close_verified_closed",
    entry: {
      clientOrderId: "entry-client-1",
      positionId: "position-1",
      quantity: "0.01",
      stopOrderId: "stop-order-1",
    },
    emergencyClose: {
      clientOrderId: "close-client-1",
      orderId: "close-order-1",
      positionId: "position-1",
      quantity: "0.01",
      reconciliation: {
        status: "verified_closed",
        firstSnapshot,
        secondSnapshot,
        separationMs: 10_001,
      },
    },
  };
}

function archivedReconciledProbeCloseState() {
  const state = reconciledProbeCloseState();
  state.createdAt = 1_790_500_641_637;
  state.entry.attemptStartedAt = 1_790_500_642_000;
  state.emergencyClose.reconciliation.firstSnapshot.observedAt = 1_790_500_842_361;
  state.emergencyClose.reconciliation.secondSnapshot.observedAt = 1_790_500_852_362;
  state.archiveClosed = {
    status: "verified",
    closeClientOrderId: state.emergencyClose.clientOrderId,
    closeOrderId: state.emergencyClose.orderId,
    positionId: state.entry.positionId,
    quantity: state.emergencyClose.quantity,
    firstSnapshot: {
      observedAt: 1_790_500_862_000,
      flatBtcPositionRows: 0,
      openOrdersEmpty: true,
    },
    secondSnapshot: {
      observedAt: 1_790_500_872_001,
      flatBtcPositionRows: 0,
      openOrdersEmpty: true,
    },
    separationMs: 10_001,
  };
  return state;
}

function restoredLongStateForArchivedProbe() {
  const state = restoredLongState([
    flatLeverageObservation(1_790_500_900_000),
    flatLeverageObservation(1_790_500_910_001),
  ]);
  state.createdAt = 1_790_500_609_868;
  state.restoreLong.startedAt = 1_790_500_874_184;
  state.statusObservedAt = 1_790_500_910_001;
  state.lastConfirmedWrite = {
    command: "restore-long",
    side: "LONG",
    from: 10,
    target: 75,
    verification: "adapter_setVstLeverage_get_verified",
    verifiedAt: 1_790_500_880_000,
  };
  return state;
}

function archivedSplitStopState() {
  return {
    version: 1,
    environment: "vst",
    symbol: "BTCUSDT",
    createdAt: 60_000,
    status: "emergency_close_verified_flat_no_orders_fills",
    entry: {
      clientOrderId: "split-entry-client-1",
      orderId: "split-entry-order-1",
      responseOrderId: null,
      positionId: "split-position-1",
      quantity: "0.1095",
      fillsVerified: true,
      positionVerified: true,
      attachedFullStopVerified: true,
      currentQuantity: "0.0876",
    },
    core: { orderId: "split-core-stop-1", quantity: "0.0876" },
    runner: {
      orderId: "split-runner-stop-1",
      quantity: "0.0219",
      startedAt: 70_000,
      status: "filled_triggered_verified",
    },
    triggeredRunner: {
      status: "triggered_runner_fill_and_residual_protection_verified",
      runnerOrderId: "split-runner-stop-1",
      childFill: {
        orderId: "runner-child-fill-1",
        triggerOrderId: "split-runner-stop-1",
        symbol: "BTC-USDT",
        side: "SELL",
        quantity: "0.0219",
        price: "100",
        feeAmount: "0.0001",
        feeAsset: "VST",
      },
      priorQuantity: "0.1095",
      fillQuantity: "0.0219",
      residualQuantity: "0.0876",
      remainingQuantity: "0.0876",
      positionId: "split-position-1",
      verifiedAt: 85_000,
    },
    emergencyClose: {
      clientOrderId: "split-close-client-1",
      orderId: "split-close-order-1",
      quantity: "0.0876",
      positionId: "split-position-1",
      startedAt: 95_000,
      reconciliation: {
        status: "verified_flat_no_open_orders_fills",
        fillCount: 1,
        flatPositionRows: 0,
        openOrderCount: 0,
        observedAt: 100_000,
      },
    },
  };
}

function leveragePreparedForSplitRestore() {
  return {
    environment: "vst",
    symbol: "BTCUSDT",
    workflow: "vst-btc-long-only",
    createdAt: 50_000,
    originalLeverage: { long: 75, short: 75 },
    status: "probe_ready_long_only",
    probeReady: true,
    pendingWrite: null,
    lastConfirmedWrite: {
      command: "prepare-long",
      side: "LONG",
      from: 75,
      target: 10,
      verification: "adapter_setVstLeverage_get_verified",
      verifiedAt: 55_000,
    },
    lastObservedLeverage: { long: 10, short: 75 },
    statusObservedAt: 59_000,
    readOnlyObservations: [],
  };
}

async function withState(callback) {
  const directory = await mkdtemp(join(tmpdir(), "vst-leverage-test-"));
  try {
    await callback({
      directory,
      statePath: join(directory, "state.json"),
      probeStatePath: join(directory, "probe-state.json"),
      splitProbeStatePath: join(directory, "vst-btc-virtual-split-stop-state.json"),
      lockPath: join(directory, "operation.lock"),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function execute(options) {
  return runLeveragePrep({
    ...options,
    confirmed: [
      "prepare-long", "restore-long", "abort-restore-long", "archive-aborted",
      "restore-long-after-split", "archive-long-restored", "archive-abort-long-no-fill",
    ].includes(options.command),
  });
}

async function prepareLongAndStatus(options) {
  const prepared = await execute({ ...options, command: "prepare-long" });
  const status = await execute({ ...options, command: "status" });
  return { prepared, status };
}

test("only LONG-only commands exist; confirmations and shared BTC lock are enforced", () => {
  assert.equal(SHARED_VST_BTC_LOCK, probeLock);
  assert.throws(() => parseArgs(["prepare-long", "--confirm-vst-only"]),
    /confirmation_required/);
  assert.equal(parseArgs([
    "prepare-long", "--confirm-vst-only", "--confirm-prepare-long",
  ]).command, "prepare-long");
  assert.equal(parseArgs([
    "restore-long", "--confirm-vst-only", "--confirm-restore-long",
  ]).command, "restore-long");
  assert.equal(parseArgs([
    "restore-long-after-split", "--confirm-vst-only",
    "--confirm-restore-long-after-split",
  ]).command, "restore-long-after-split");
  assert.throws(() => parseArgs([
    "restore-long-after-split", "--confirm-vst-only",
  ]), /confirmation_required/);
  assert.equal(parseArgs([
    "abort-restore-long", "--confirm-vst-only", "--confirm-abort-restore-long",
  ]).command, "abort-restore-long");
  assert.equal(parseArgs([
    "archive-aborted", "--confirm-vst-only", "--confirm-archive-aborted",
  ]).command, "archive-aborted");
  assert.throws(() => parseArgs([
    "archive-long-restored", "--confirm-vst-only",
  ]), /confirmation_required/);
  assert.equal(parseArgs([
    "archive-long-restored", "--confirm-vst-only", "--confirm-archive-long-restored",
  ]).command, "archive-long-restored");
  assert.throws(() => parseArgs([
    "archive-abort-long-no-fill", "--confirm-vst-only",
  ]), /confirmation_required/);
  assert.equal(parseArgs([
    "archive-abort-long-no-fill", "--confirm-vst-only",
    "--confirm-archive-abort-long-no-fill",
  ]).command, "archive-abort-long-no-fill");
  for (const disabled of ["prepare-short", "restore-short", "abort-restore-short"]) {
    assert.throws(() => parseArgs([disabled]), /invalid_command/);
  }
  assert.throws(() => parseArgs(["status", "--confirm-vst-only"]), /invalid_arguments/);
});

test("exact VST write guards allow only one LONG leverage POST per stage", async () => {
  for (const [stage, expected] of [
    ["prepare-long", "10"],
    ["restore-long", "75"],
    ["abort-restore-long", "75"],
    ["restore-long-after-split", "75"],
  ]) {
    let calls = 0;
    const guard = createGuardedFetch(async (_url, init) => {
      calls += 1;
      assert.equal(init.redirect, "error");
      return new Response("ok");
    }, { stage });
    await assert.rejects(guard("https://open-api.bingx.com/openApi/swap/v2/trade/leverage",
      { method: "POST" }), /host isolation/);
    await assert.rejects(guard(signedLeverage({ symbol: "ETH-USDT", leverage: expected }),
      { method: "POST" }), /write guard/);
    await assert.rejects(guard(signedLeverage({ leverage: expected, side: "SHORT" }),
      { method: "POST" }), /write guard/);
    await assert.rejects(guard(signedLeverage({ leverage: expected === "10" ? "75" : "10" }),
      { method: "POST" }), /write guard/);
    await guard(signedLeverage({ leverage: expected }), { method: "POST" });
    await assert.rejects(guard(signedLeverage({ leverage: expected }), { method: "POST" }),
      /write guard/);
    assert.equal(calls, 1);
  }
});

test("prepare-long persists intent, writes LONG only, and status alone enables probe readiness", async () => {
  await withState(async ({ statePath, probeStatePath, lockPath }) => {
    const api = mockApi();
    const setVstLeverage = api.setVstLeverage.bind(api);
    api.setVstLeverage = async (...args) => {
      const saved = JSON.parse(await readFile(statePath, "utf8"));
      assert.equal(saved.pendingWrite.command, "prepare-long");
      assert.equal(saved.pendingWrite.side, "LONG");
      assert.deepEqual(saved.originalLeverage, { long: 75, short: 75 });
      return setVstLeverage(...args);
    };

    const prepared = await execute({ command: "prepare-long", api, statePath, probeStatePath, lockPath });
    assert.equal(prepared.status, "prepare_long_adapter_verified_status_required");
    assert.deepEqual(api.writes, [{ symbol: "BTCUSDT", value: 10, side: "LONG" }]);
    assert.deepEqual(api.leverage, { longLeverage: 10, shortLeverage: 75 });

    const status = await execute({ command: "status", api, statePath, probeStatePath, lockPath });
    assert.equal(status.status, "probe_ready_long_only");
    assert.deepEqual(status.observed.leverage, { long: 10, short: 75 });
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.probeReady, true);
    assert.deepEqual(saved.originalLeverage, { long: 75, short: 75 });

    await assert.rejects(execute({
      command: "prepare-long", api, statePath, probeStatePath, lockPath,
    }), /active_state_blocks_new_prepare/);
    assert.equal(api.writes.length, 1);
  });
});

test("LONG/SHORT pair mismatch never labels the session probe-ready", async () => {
  await withState(async ({ statePath, probeStatePath, lockPath }) => {
    const api = mockApi();
    await execute({ command: "prepare-long", api, statePath, probeStatePath, lockPath });
    api.leverage.shortLeverage = 10;
    const status = await execute({ command: "status", api, statePath, probeStatePath, lockPath });
    assert.equal(status.status, "long_only_not_probe_ready");
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).probeReady, false);
    await assert.rejects(execute({
      command: "abort-restore-long", api, statePath, probeStatePath, lockPath,
    }), /probe_ready_10x_75x/);
    assert.deepEqual(api.writes, [{ symbol: "BTCUSDT", value: 10, side: "LONG" }]);
  });
});

test("restore-long requires a terminal verified probe close and writes LONG only", async () => {
  await withState(async ({ statePath, probeStatePath, lockPath }) => {
    const api = mockApi();
    await prepareLongAndStatus({ api, statePath, probeStatePath, lockPath });
    await assert.rejects(execute({
      command: "restore-long", api, statePath, probeStatePath, lockPath,
    }), /terminal_verified_probe_close/);

    await writeFile(probeStatePath, JSON.stringify({
      environment: "vst",
      symbol: "BTCUSDT",
      status: "emergency_close_unknown_halt_no_retry",
      entry: { positionId: "position-1", quantity: "0.01" },
      emergencyClose: {},
    }));
    await assert.rejects(execute({
      command: "restore-long", api, statePath, probeStatePath, lockPath,
    }), /terminal_verified_probe_close/);

    await writeFile(probeStatePath, JSON.stringify({
      environment: "vst",
      symbol: "BTCUSDT",
      status: "emergency_close_verified_flat",
      entry: { positionId: "position-1", quantity: "0.01" },
      emergencyClose: { orderId: "close-order-1" },
    }));
    const result = await execute({
      command: "restore-long", api, statePath, probeStatePath, lockPath,
    });
    assert.equal(result.probeStateGate, "terminal_verified_closed");
    assert.deepEqual(api.writes, [
      { symbol: "BTCUSDT", value: 10, side: "LONG" },
      { symbol: "BTCUSDT", value: 75, side: "LONG" },
    ]);
    assert.deepEqual(api.leverage, { longLeverage: 75, shortLeverage: 75 });
    const status = await execute({ command: "status", api, statePath, probeStatePath, lockPath });
    assert.equal(status.status, "restored_long_only_75x_75x");
    assert.deepEqual(api.writes.at(-1), { symbol: "BTCUSDT", value: 75, side: "LONG" });
  });
});

test("restore-long accepts reconciled emergency_close_verified_closed only with evidence", async () => {
  const verifiedCloseState = {
    environment: "vst",
    symbol: "BTCUSDT",
    status: "emergency_close_verified_closed",
    entry: { positionId: "position-1", quantity: "0.01" },
    emergencyClose: {
      orderId: "close-order-1",
      reconciliation: {
        status: "verified_closed",
        firstSnapshot: {
          observedAt: 100_000,
          orderId: "close-order-1",
          positionId: "position-1",
          quantity: "0.01",
          closeFillsVerified: true,
          originalStopId: "stop-order-1",
          originalStopCanceledNoFills: true,
          flatBtcPositionRows: 0,
          openOrdersEmpty: true,
        },
        secondSnapshot: {
          observedAt: 110_001,
          orderId: "close-order-1",
          positionId: "position-1",
          quantity: "0.01",
          closeFillsVerified: true,
          originalStopId: "stop-order-1",
          originalStopCanceledNoFills: true,
          flatBtcPositionRows: 0,
          openOrdersEmpty: true,
        },
        separationMs: 10_001,
      },
    },
  };

  await withState(async ({ statePath, probeStatePath, lockPath }) => {
    const api = mockApi();
    await prepareLongAndStatus({ api, statePath, probeStatePath, lockPath });
    await writeFile(probeStatePath, JSON.stringify(verifiedCloseState));
    const result = await execute({
      command: "restore-long", api, statePath, probeStatePath, lockPath,
    });
    assert.equal(result.probeStateGate, "terminal_verified_closed");
    assert.deepEqual(api.writes, [
      { symbol: "BTCUSDT", value: 10, side: "LONG" },
      { symbol: "BTCUSDT", value: 75, side: "LONG" },
    ]);
  });

  await withState(async ({ statePath, probeStatePath, lockPath }) => {
    const api = mockApi();
    await prepareLongAndStatus({ api, statePath, probeStatePath, lockPath });
    const incompleteProofs = [
      {
        ...structuredClone(verifiedCloseState),
        emergencyClose: {
          ...structuredClone(verifiedCloseState.emergencyClose),
          reconciliation: { status: "verified_closed" },
        },
      },
      {
        ...structuredClone(verifiedCloseState),
        emergencyClose: {
          ...structuredClone(verifiedCloseState.emergencyClose),
          reconciliation: {
            ...structuredClone(verifiedCloseState.emergencyClose.reconciliation),
            separationMs: 9_999,
          },
        },
      },
      {
        ...structuredClone(verifiedCloseState),
        emergencyClose: {
          ...structuredClone(verifiedCloseState.emergencyClose),
          reconciliation: {
            ...structuredClone(verifiedCloseState.emergencyClose.reconciliation),
            secondSnapshot: {
              ...structuredClone(
                verifiedCloseState.emergencyClose.reconciliation.secondSnapshot,
              ),
              closeFillsVerified: false,
            },
          },
        },
      },
    ];
    for (const incompleteProof of incompleteProofs) {
      await writeFile(probeStatePath, JSON.stringify(incompleteProof));
      await assert.rejects(execute({
        command: "restore-long", api, statePath, probeStatePath, lockPath,
      }), /terminal_verified_probe_close/);
    }
    assert.deepEqual(api.writes, [{ symbol: "BTCUSDT", value: 10, side: "LONG" }]);
  });
});

test("abort-restore-long is explicit, one-time, and only available when probe never started", async () => {
  await withState(async ({ statePath, probeStatePath, lockPath }) => {
    const api = mockApi();
    await prepareLongAndStatus({ api, statePath, probeStatePath, lockPath });
    await writeFile(probeStatePath, JSON.stringify({
      environment: "vst", symbol: "BTCUSDT", status: "entry_unknown_halt_no_retry",
    }));
    await assert.rejects(execute({
      command: "abort-restore-long", api, statePath, probeStatePath, lockPath,
    }), /requires_no_probe_state/);
    await rm(probeStatePath);

    const setVstLeverage = api.setVstLeverage.bind(api);
    api.setVstLeverage = async (...args) => {
      const saved = JSON.parse(await readFile(statePath, "utf8"));
      assert.equal(saved.abortRestoreLong.status, "intent_persisted");
      assert.equal(saved.abortRestoreLong.side, "LONG");
      return setVstLeverage(...args);
    };
    const result = await execute({
      command: "abort-restore-long", api, statePath, probeStatePath, lockPath,
    });
    assert.equal(result.abort, true);
    assert.deepEqual(api.writes, [
      { symbol: "BTCUSDT", value: 10, side: "LONG" },
      { symbol: "BTCUSDT", value: 75, side: "LONG" },
    ]);
    const status = await execute({ command: "status", api, statePath, probeStatePath, lockPath });
    assert.equal(status.status, "abort_restore_long_verified_75x_75x");
    assert.deepEqual(api.leverage, { longLeverage: 75, shortLeverage: 75 });
    const laterStatus = await execute({
      command: "status", api, statePath, probeStatePath, lockPath,
    });
    assert.equal(laterStatus.status, "abort_restore_long_verified_75x_75x");
    assert.equal(laterStatus.archiveLongRestoredObservationsReady, false);
    assert.equal(laterStatus.archiveAbortLongNoFillObservationsReady, false);
  });
});

test("unknown LONG write is durably terminal and is never retried", async () => {
  await withState(async ({ statePath, probeStatePath, lockPath }) => {
    const api = mockApi();
    let attempts = 0;
    api.setVstLeverage = async () => {
      attempts += 1;
      throw new Error("mock response lost");
    };
    const options = { api, statePath, probeStatePath, lockPath };
    await assert.rejects(execute({ command: "prepare-long", ...options }), /unknown_halt_no_retry/);
    await assert.rejects(execute({ command: "prepare-long", ...options }), /unknown_write_halt_no_retry/);
    await execute({ command: "status", ...options });
    await assert.rejects(execute({ command: "abort-restore-long", ...options }),
      /unknown_write_halt_no_retry/);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.pendingWrite.command, "prepare-long");
    assert.equal(saved.pendingWrite.side, "LONG");
    assert.equal(saved.status, "leverage_write_unknown_halt_no_retry");
    assert.equal(attempts, 1);
  });
});

test("unknown abort restore preserves an intent and blocks all retry attempts", async () => {
  await withState(async ({ statePath, probeStatePath, lockPath }) => {
    const api = mockApi();
    await prepareLongAndStatus({ api, statePath, probeStatePath, lockPath });
    api.setVstLeverage = async () => { throw new Error("mock response lost"); };
    const options = { api, statePath, probeStatePath, lockPath };
    await assert.rejects(execute({ command: "abort-restore-long", ...options }),
      /abort_restore_long_unknown_halt_no_retry/);
    await assert.rejects(execute({ command: "abort-restore-long", ...options }),
      /unknown_write_halt_no_retry/);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.abortRestoreLong.status, "unknown_halt_no_retry");
    assert.equal(saved.pendingWrite.side, "LONG");
  });
});

test("archive-aborted is operator-gated, delayed, evidence-preserving, and starts no new session", async () => {
  await withState(async ({ statePath, probeStatePath, lockPath }) => {
    const api = mockApi();
    const oldState = {
      environment: "vst",
      symbol: "BTCUSDT",
      originalLeverage: { long: 75, short: 75 },
      status: "abort_restore_short_verified_75x_75x",
      pendingWrite: null,
      lastConfirmedWrite: {
        command: "abort-restore-short",
        side: "SHORT",
        from: 10,
        target: 75,
        verification: "adapter_setVstLeverage_get_verified",
      },
      abortRestoreShort: {
        status: "verified_75x_75x",
        side: "SHORT",
        from: 10,
        target: 75,
      },
      evidenceToPreserve: { observedLongOnlyProblem: "short-side setting changed observed long leverage" },
      readOnlyObservations: [10_000, 15_000].map((observedAt) => ({
        observedAt,
        leverage: { long: 75, short: 75 },
        flat: true,
        openOrderCount: 0,
        positionMode: "HEDGE",
        marginMode: "ISOLATED",
      })),
    };
    await writeFile(statePath, JSON.stringify(oldState));
    let now = 20_001;
    const runAt = (command) => execute({
      command, api, statePath, probeStatePath, lockPath, clock: () => now,
    });

    await assert.rejects(runAt("archive-aborted"), /two_delayed_75x_75x/);
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).evidenceToPreserve,
      oldState.evidenceToPreserve);

    now = 30_000;
    const status = await runAt("status");
    assert.equal(status.archiveAbortedObservationsReady, true);
    const beforeArchive = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(beforeArchive.evidenceToPreserve, oldState.evidenceToPreserve);

    const archive = await runAt("archive-aborted");
    assert.equal(archive.archived, true);
    assert.equal(api.writes.length, 0);
    await assert.rejects(readFile(statePath, "utf8"), { code: "ENOENT" });
    const archived = JSON.parse(await readFile(archive.archivePath, "utf8"));
    assert.equal(archived.status, "archived_aborted_terminal");
    assert.deepEqual(archived.evidenceToPreserve, oldState.evidenceToPreserve);
    assert.equal(archived.abortRestoreShort.status, "verified_75x_75x");
    assert.equal(archived.archivedAbort.abortEvidenceRetained, true);

    await runAt("prepare-long");
    const fresh = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(fresh.workflow, "vst-btc-long-only");
    assert.equal(fresh.abortRestoreShort, undefined);
    assert.deepEqual(api.writes, [{ symbol: "BTCUSDT", value: 10, side: "LONG" }]);
  });
});

test("archive-aborted refuses any existing probe state", async () => {
  await withState(async ({ statePath, probeStatePath, lockPath }) => {
    const api = mockApi();
    const observations = [10_000, 20_000].map((observedAt) => ({
      observedAt,
      leverage: { long: 75, short: 75 },
      flat: true,
      openOrderCount: 0,
      positionMode: "HEDGE",
      marginMode: "ISOLATED",
    }));
    await writeFile(statePath, JSON.stringify({
      environment: "vst",
      symbol: "BTCUSDT",
      originalLeverage: { long: 75, short: 75 },
      pendingWrite: null,
      abortRestoreShort: { status: "verified_75x_75x" },
      readOnlyObservations: observations,
    }));
    await writeFile(probeStatePath, JSON.stringify({
      environment: "vst", symbol: "BTCUSDT", status: "entry_unknown_halt_no_retry",
    }));
    await assert.rejects(execute({
      command: "archive-aborted", api, statePath, probeStatePath, lockPath,
    }), /requires_no_probe_state/);
    assert.equal(api.writes.length, 0);
  });
});

test("archive-abort-long-no-fill is confirmed, delayed, evidence-preserving, and read-only", async () => {
  await withState(async ({ statePath, probeStatePath, lockPath }) => {
    const api = mockApi();
    const probeState = archivedNoFillProbeState();
    const probeArchiveDirectory = `${probeStatePath}.archive-no-fill-test`;
    const probeArchivePath = join(probeArchiveDirectory, basename(probeStatePath));
    await mkdir(probeArchiveDirectory);
    await writeFile(probeArchivePath, JSON.stringify(probeState));

    await writeFile(statePath, JSON.stringify(abortedLongState([
      flatLeverageObservation(400_000),
    ])));
    let now = 409_999;
    const runAt = (command) => execute({
      command, api, statePath, probeStatePath, lockPath, clock: () => now,
    });

    const earlyStatus = await runAt("status");
    assert.equal(earlyStatus.status, "abort_restore_long_verified_75x_75x");
    assert.equal(earlyStatus.archiveAbortLongNoFillObservationsReady, false);
    assert.equal(earlyStatus.archiveLongRestoredObservationsReady, false);
    await assert.rejects(runAt("archive-abort-long-no-fill"),
      /two_delayed_75x_75x_flat_observations/);
    assert.equal(api.writes.length, 0);

    now = 410_000;
    const ready = await runAt("status");
    assert.equal(ready.status, "abort_restore_long_verified_75x_75x");
    assert.equal(ready.archiveAbortLongNoFillObservationsReady, true);
    assert.equal(ready.archiveLongRestoredObservationsReady, false);

    const archive = await runAt("archive-abort-long-no-fill");
    assert.equal(archive.archived, true);
    assert.equal(archive.readOnly, true);
    assert.equal(archive.exchangeWrites, 0);
    assert.equal(archive.probeNoFillEvidenceFound, true);
    assert.equal(api.writes.length, 0);
    await assert.rejects(readFile(statePath, "utf8"), { code: "ENOENT" });

    const archived = JSON.parse(await readFile(archive.archivePath, "utf8"));
    assert.equal(archived.status, "archived_abort_long_no_fill_terminal");
    assert.equal(archived.abortRestoreLong.status, "verified_75x_75x");
    assert.equal(archived.lastConfirmedWrite.command, "abort-restore-long");
    assert.equal(archived.archivedAbortLongNoFill.probeNoFillEvidenceFound, true);
    assert.deepEqual(
      archived.archivedAbortLongNoFill.probeNoFillEvidence,
      probeState,
    );
    assert.equal(archived.archivedLongRestored, undefined);

    await runAt("prepare-long");
    assert.deepEqual(api.writes, [{ symbol: "BTCUSDT", value: 10, side: "LONG" }]);
  });
});

test("archive-abort-long-no-fill rejects active probe and mismatched archived proof", async () => {
  await withState(async ({ statePath, probeStatePath, lockPath }) => {
    const api = mockApi();
    const observations = [400_000, 410_000].map(flatLeverageObservation);
    const state = abortedLongState(observations);
    await writeFile(statePath, JSON.stringify(state));
    const run = () => execute({
      command: "archive-abort-long-no-fill",
      api, statePath, probeStatePath, lockPath, clock: () => 420_000,
    });

    await writeFile(probeStatePath, JSON.stringify({
      environment: "vst",
      symbol: "BTCUSDT",
      status: "entry_unknown_halt_no_retry",
    }));
    await assert.rejects(run(), /requires_no_active_probe/);
    await rm(probeStatePath);

    const probeArchiveDirectory = `${probeStatePath}.archive-no-fill-invalid`;
    await mkdir(probeArchiveDirectory);
    const invalidProof = archivedNoFillProbeState();
    invalidProof.entry.noFillArchive.secondObservation.zeroBtcFillsUsdt = false;
    await writeFile(
      join(probeArchiveDirectory, basename(probeStatePath)),
      JSON.stringify(invalidProof),
    );
    await assert.rejects(run(), /matching_verified_probe_evidence/);
    assert.equal(api.writes.length, 0);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).status,
      "restored_long_only_75x_75x");

    await writeFile(statePath, JSON.stringify({
      ...state,
      pendingWrite: { command: "abort-restore-long", side: "LONG", target: 75 },
    }));
    await assert.rejects(run(), /verified_long_abort_and_no_pending_intents/);
    assert.equal(api.writes.length, 0);
  });
});

test("archive-long-restored requires delayed status proof and archives leverage plus close evidence", async () => {
  await withState(async ({ statePath, probeStatePath, lockPath }) => {
    const api = mockApi();
    const probeClose = reconciledProbeCloseState();
    const probeText = JSON.stringify(probeClose);
    await writeFile(statePath, JSON.stringify(restoredLongState()));
    await writeFile(probeStatePath, probeText);
    let now = 100_000;
    const runAt = (command) => execute({
      command, api, statePath, probeStatePath, lockPath, clock: () => now,
    });

    await runAt("status");
    now = 109_999;
    const tooSoon = await runAt("status");
    assert.equal(tooSoon.archiveLongRestoredObservationsReady, false);
    await assert.rejects(runAt("archive-long-restored"),
      /two_delayed_75x_75x_flat_observations/);
    assert.notEqual(await readFile(statePath, "utf8"), undefined);
    assert.equal(api.writes.length, 0);

    now = 110_000;
    const ready = await runAt("status");
    assert.equal(ready.status, "restored_long_only_75x_75x");
    assert.equal(ready.archiveLongRestoredObservationsReady, true);
    const archive = await runAt("archive-long-restored");
    assert.equal(archive.archived, true);
    assert.equal(archive.readOnly, true);
    assert.equal(archive.exchangeWrites, 0);
    assert.equal(archive.allPriorLeverageEvidenceRetained, true);
    assert.equal(archive.probeCloseEvidenceRetained, true);
    assert.equal(api.writes.length, 0);

    await assert.rejects(readFile(statePath, "utf8"), { code: "ENOENT" });
    const archived = JSON.parse(await readFile(archive.archivePath, "utf8"));
    assert.equal(archived.status, "archived_long_restored_terminal");
    assert.deepEqual(archived.restoreLong, restoredLongState().restoreLong);
    assert.deepEqual(
      archived.archivedLongRestored.leverageObservationTimes,
      [100_000, 110_000],
    );
    assert.deepEqual(archived.archivedLongRestored.finalSnapshot.leverage,
      { long: 75, short: 75 });
    assert.deepEqual(archived.archivedLongRestored.probeCloseEvidence, probeClose);
    assert.equal(await readFile(probeStatePath, "utf8"), probeText);

    // The probe script owns archiving its terminal state; don't silently move it here.
    await assert.rejects(runAt("prepare-long"), /prepare_long_requires_no_existing_probe_state/);
    assert.equal(api.writes.length, 0);
    await rm(probeStatePath);
    await runAt("prepare-long");
    assert.deepEqual(api.writes, [{ symbol: "BTCUSDT", value: 10, side: "LONG" }]);
  });
});

test("archive-long-restored rejects unresolved leverage writes and incomplete probe close proof", async () => {
  await withState(async ({ statePath, probeStatePath, lockPath }) => {
    const api = mockApi();
    let now = 120_000;
    const runAt = (command) => execute({
      command, api, statePath, probeStatePath, lockPath, clock: () => now,
    });
    const observations = [100_000, 110_000].map(flatLeverageObservation);
    await writeFile(statePath, JSON.stringify({
      ...restoredLongState(observations),
      pendingWrite: { command: "restore-long", side: "LONG", target: 75 },
    }));
    await writeFile(probeStatePath, JSON.stringify(reconciledProbeCloseState()));
    await assert.rejects(runAt("archive-long-restored"), /no_pending_intents/);
    assert.equal(api.writes.length, 0);

    await writeFile(statePath, JSON.stringify(restoredLongState(observations)));
    const incompleteProbe = reconciledProbeCloseState();
    incompleteProbe.emergencyClose.reconciliation.secondSnapshot.openOrdersEmpty = false;
    await writeFile(probeStatePath, JSON.stringify(incompleteProbe));
    await assert.rejects(runAt("archive-long-restored"), /exact_terminal_probe_close_evidence/);
    assert.equal(api.writes.length, 0);
    await readFile(statePath, "utf8");
  });
});

test("archive-long-restored uses one exact already-archived probe close without moving either archive", async () => {
  await withState(async ({ statePath, probeStatePath, lockPath }) => {
    const api = mockApi();
    const probe = archivedReconciledProbeCloseState();
    const probeArchiveDirectory = `${probeStatePath}.archive-closed-test`;
    const probeArchivePath = join(probeArchiveDirectory, basename(probeStatePath));
    const probeText = JSON.stringify(probe);
    await mkdir(probeArchiveDirectory);
    await writeFile(probeArchivePath, probeText);
    await writeFile(statePath, JSON.stringify(restoredLongStateForArchivedProbe()));

    const result = await execute({
      command: "archive-long-restored",
      api, statePath, probeStatePath, lockPath, clock: () => 1_790_500_920_000,
    });
    assert.equal(result.archived, true);
    assert.equal(result.probeCloseEvidenceRetained, true);
    assert.equal(result.probeCloseEvidenceArchivePath, probeArchivePath);
    assert.equal(result.exchangeWrites, 0);
    assert.equal(api.writes.length, 0);
    assert.equal(await readFile(probeArchivePath, "utf8"), probeText);
    await assert.rejects(readFile(probeStatePath, "utf8"), { code: "ENOENT" });

    const leverageArchive = await readFile(result.archivePath, "utf8");
    const saved = JSON.parse(leverageArchive);
    assert.equal(saved.status, "archived_long_restored_terminal");
    assert.deepEqual(saved.archivedLongRestored.probeCloseEvidence, probe);
    assert.equal(
      saved.archivedLongRestored.probeCloseEvidenceArchivePath,
      probeArchivePath,
    );
    assert.equal(await readFile(probeArchivePath, "utf8"), probeText);
  });
});

test("archive-long-restored rejects missing, ambiguous, and session-mismatched archived probe evidence", async () => {
  await withState(async ({ statePath, probeStatePath, lockPath }) => {
    const api = mockApi();
    const state = restoredLongStateForArchivedProbe();
    const run = () => execute({
      command: "archive-long-restored",
      api, statePath, probeStatePath, lockPath, clock: () => 1_790_500_920_000,
    });
    await writeFile(statePath, JSON.stringify(state));
    await assert.rejects(run(), /exact_terminal_probe_close_evidence/);

    const firstDirectory = `${probeStatePath}.archive-closed-first`;
    await mkdir(firstDirectory);
    const probe = archivedReconciledProbeCloseState();
    await writeFile(join(firstDirectory, basename(probeStatePath)), JSON.stringify(probe));
    const secondDirectory = `${probeStatePath}.archive-closed-second`;
    await mkdir(secondDirectory);
    await writeFile(join(secondDirectory, basename(probeStatePath)), JSON.stringify(probe));
    await assert.rejects(run(), /probe_close_evidence_is_ambiguous/);

    await rm(secondDirectory, { recursive: true });
    probe.archiveClosed.closeOrderId = "different-close-order";
    await writeFile(join(firstDirectory, basename(probeStatePath)), JSON.stringify(probe));
    await assert.rejects(run(), /exact_terminal_probe_close_evidence/);
    assert.equal(api.writes.length, 0);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).status,
      "restored_long_only_75x_75x");
  });
});

test("restore-long-after-split requires unique archived split proof and archives its evidence", async () => {
  await withState(async ({ statePath, probeStatePath, splitProbeStatePath, lockPath }) => {
    const api = mockApi();
    api.leverage.longLeverage = 10;
    const probeArchivePath =
      `${splitProbeStatePath}.archive-120000-9ddbd865-0238-459c-9593-7ce086188689`;
    const noFillArchivePath =
      `${splitProbeStatePath}.archive-no-fill-120001-9ddbd865-0238-459c-9593-7ce086188689`;
    const probe = archivedSplitStopState();
    const probeText = JSON.stringify(probe);
    await writeFile(probeArchivePath, probeText);
    const noFillState = {
      environment: "vst",
      symbol: "BTCUSDT",
      createdAt: 65_000,
      status: "archived_no_fill",
    };
    const noFillText = JSON.stringify(noFillState);
    await writeFile(noFillArchivePath, noFillText);
    await writeFile(statePath, JSON.stringify(leveragePreparedForSplitRestore()));

    let now = 200_000;
    const options = () => ({
      api, statePath, probeStatePath, splitProbeStatePath, lockPath, clock: () => now,
    });
    const setVstLeverage = api.setVstLeverage.bind(api);
    api.setVstLeverage = async (...args) => {
      const saved = JSON.parse(await readFile(statePath, "utf8"));
      assert.equal(saved.restoreLong.command, "restore-long-after-split");
      assert.equal(saved.restoreLong.status, "intent_persisted");
      assert.equal(saved.pendingWrite.command, "restore-long-after-split");
      assert.equal(saved.restoreLong.splitProbeArchivePath, probeArchivePath);
      assert.equal(saved.restoreLong.splitEntryClientOrderId, probe.entry.clientOrderId);
      return setVstLeverage(...args);
    };

    const restored = await execute({
      command: "restore-long-after-split", ...options(),
    });
    assert.equal(restored.writePerformed, true);
    assert.equal(api.leverage.longLeverage, 75);
    assert.equal(api.leverage.shortLeverage, 75);
    assert.deepEqual(api.writes, [{ symbol: "BTCUSDT", value: 75, side: "LONG" }]);
    assert.equal(await readFile(probeArchivePath, "utf8"), probeText);
    assert.equal(await readFile(noFillArchivePath, "utf8"), noFillText);

    now = 210_000;
    await execute({ command: "status", ...options() });
    now = 220_001;
    await execute({ command: "status", ...options() });
    now = 230_000;
    const archivedResult = await execute({
      command: "archive-long-restored", ...options(),
    });
    assert.equal(archivedResult.archived, true);
    assert.equal(archivedResult.splitProbeEvidenceRetained, true);
    assert.equal(archivedResult.splitProbeEvidenceArchivePath, probeArchivePath);
    assert.equal(api.writes.length, 1);
    assert.equal(await readFile(probeArchivePath, "utf8"), probeText);
    assert.equal(await readFile(noFillArchivePath, "utf8"), noFillText);
    const archivedLeverage = JSON.parse(await readFile(archivedResult.archivePath, "utf8"));
    assert.equal(archivedLeverage.status, "archived_long_restored_terminal");
    assert.deepEqual(archivedLeverage.archivedLongRestored.splitProbeEvidence, probe);
    assert.equal(
      archivedLeverage.archivedLongRestored.splitProbeEvidenceArchivePath,
      probeArchivePath,
    );
  });
});

test("restore-long-after-split rejects missing, ambiguous, active, or inexact split proof", async () => {
  await withState(async ({ statePath, probeStatePath, splitProbeStatePath, lockPath }) => {
    const api = mockApi();
    api.leverage.longLeverage = 10;
    await writeFile(statePath, JSON.stringify(leveragePreparedForSplitRestore()));
    const options = () => ({
      command: "restore-long-after-split",
      api, statePath, probeStatePath, splitProbeStatePath, lockPath,
      clock: () => 200_000,
    });
    await assert.rejects(execute(options()),
      /requires_unique_matching_archived_split_proof/);

    const active = archivedSplitStopState();
    await writeFile(splitProbeStatePath, JSON.stringify(active));
    await assert.rejects(execute(options()), /requires_archived_probe_state/);
    await rm(splitProbeStatePath);

    const firstArchivePath =
      `${splitProbeStatePath}.archive-120000-9ddbd865-0238-459c-9593-7ce086188689`;
    const probe = archivedSplitStopState();
    probe.triggeredRunner.childFill.quantity = "0.0218";
    await writeFile(firstArchivePath, JSON.stringify(probe));
    await assert.rejects(execute(options()), /exact_archived_split_close_proof/);

    probe.triggeredRunner.childFill.quantity = "0.0219";
    await writeFile(firstArchivePath, JSON.stringify(probe));
    const secondArchivePath =
      `${splitProbeStatePath}.archive-120001-8ddbd865-0238-459c-9593-7ce086188689`;
    await writeFile(secondArchivePath, JSON.stringify(probe));
    await assert.rejects(execute(options()), /archived_split_proof_is_ambiguous/);
    assert.equal(api.writes.length, 0);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).status,
      "probe_ready_long_only");
  });
});

test("restore-long-after-split halts after an ambiguous write result without retry", async () => {
  await withState(async ({ statePath, probeStatePath, splitProbeStatePath, lockPath }) => {
    const api = mockApi();
    api.leverage.longLeverage = 10;
    let attempts = 0;
    api.setVstLeverage = async () => {
      attempts += 1;
      throw new Error("result unknown");
    };
    const probeArchivePath =
      `${splitProbeStatePath}.archive-120000-9ddbd865-0238-459c-9593-7ce086188689`;
    await writeFile(probeArchivePath, JSON.stringify(archivedSplitStopState()));
    await writeFile(statePath, JSON.stringify(leveragePreparedForSplitRestore()));
    const options = {
      command: "restore-long-after-split",
      api, statePath, probeStatePath, splitProbeStatePath, lockPath,
      clock: () => 200_000,
    };
    await assert.rejects(execute(options), /restore_long_after_split_unknown_halt_no_retry/);
    await assert.rejects(execute(options), /unknown_write_halt_no_retry/);
    assert.equal(attempts, 1);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.pendingWrite.command, "restore-long-after-split");
    assert.equal(saved.restoreLong.status, "unknown_halt_no_retry");
  });
});