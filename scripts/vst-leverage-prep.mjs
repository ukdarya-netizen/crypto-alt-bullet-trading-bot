#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBingXLiveApi } from "../artifacts/api-server/src/bullet-bot/bingx-live-api.mjs";

const HOST = "https://open-api-vst.bingx.com";
const SYMBOL = "BTCUSDT";
const API_SYMBOL = "BTC-USDT";
const LEVERAGE_PATH = "/openApi/swap/v2/trade/leverage";
const SIGNED = ["recvWindow", "timestamp", "signature"];
const READ_PATHS = new Map([
  ["/openApi/swap/v2/user/positions", ["symbol"]],
  ["/openApi/swap/v1/positionSide/dual", []],
  ["/openApi/swap/v2/trade/leverage", ["symbol"]],
  ["/openApi/swap/v2/trade/marginType", ["symbol"]],
  ["/openApi/swap/v2/trade/openOrders", ["symbol"]],
]);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_STATE_PATH = resolve(ROOT, ".local/vst-leverage-prep-state.json");
const DEFAULT_PROBE_STATE_PATH = resolve(ROOT, ".local/vst-stop-coexist-state.json");
const DEFAULT_SPLIT_PROBE_STATE_PATH =
  resolve(ROOT, ".local/vst-btc-virtual-split-stop-state.json");
export const SHARED_VST_BTC_LOCK = resolve(ROOT, ".local/vst-btc-operations.lock");
const OBSERVATION_GAP_MS = 10_000;

const COMMANDS = new Set([
  "preview", "status", "prepare-long", "restore-long", "abort-restore-long",
  "restore-long-after-split",
  "archive-aborted", "archive-long-restored", "archive-abort-long-no-fill",
]);
const CONFIRMATION = {
  "prepare-long": "--confirm-prepare-long",
  "restore-long": "--confirm-restore-long",
  "abort-restore-long": "--confirm-abort-restore-long",
  "restore-long-after-split": "--confirm-restore-long-after-split",
  "archive-aborted": "--confirm-archive-aborted",
  "archive-long-restored": "--confirm-archive-long-restored",
  "archive-abort-long-no-fill": "--confirm-archive-abort-long-no-fill",
};
const WRITE_STAGES = new Set([
  "prepare-long", "restore-long", "abort-restore-long", "restore-long-after-split",
]);

export function parseArgs(argv) {
  const [command, ...args] = argv;
  if (!COMMANDS.has(command)) throw new Error("invalid_command");
  const allowed = new Set(["--confirm-vst-only", ...Object.values(CONFIRMATION)]);
  const flags = new Set(args);
  if (flags.size !== args.length || args.some((flag) => !allowed.has(flag))) {
    throw new Error("invalid_arguments");
  }
  if (CONFIRMATION[command] &&
      (!flags.has("--confirm-vst-only") || !flags.has(CONFIRMATION[command]))) {
    throw new Error("confirmation_required");
  }
  if (Object.entries(CONFIRMATION).some(([stage, flag]) =>
    stage !== command && flags.has(flag))) throw new Error("invalid_arguments");
  if (!CONFIRMATION[command] && flags.has("--confirm-vst-only")) {
    throw new Error("invalid_arguments");
  }
  return { command };
}

function signedReadValid(url, allowed) {
  const permitted = new Set([...allowed, ...SIGNED]);
  const keys = [...url.searchParams.keys()];
  return keys.every((key) => permitted.has(key)) &&
    SIGNED.every((key) => url.searchParams.getAll(key).length === 1) &&
    /^\d+$/.test(url.searchParams.get("timestamp") ?? "") &&
    url.searchParams.get("recvWindow") === "5000" &&
    /^[0-9a-f]{64}$/.test(url.searchParams.get("signature") ?? "") &&
    allowed.every((key) => url.searchParams.getAll(key).length <= 1) &&
    (allowed.includes("symbol") ? url.searchParams.get("symbol") === API_SYMBOL
      : !url.searchParams.has("symbol"));
}

export function createGuardedFetch(fetchImpl, { stage } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  let writeUsed = false;
  return async (input, init = {}) => {
    const url = new URL(input);
    const method = String(init.method ?? "GET").toUpperCase();
    if (url.protocol !== "https:" || url.origin !== HOST ||
        url.username || url.password || url.hash) {
      throw new Error("VST host isolation rejected request");
    }
    if (method === "GET") {
      const allowed = READ_PATHS.get(url.pathname);
      if (!allowed || !signedReadValid(url, allowed)) {
        throw new Error("VST signed GET guard rejected request");
      }
    } else {
      const expected = {
        "prepare-long": { leverage: "10", side: "LONG" },
        "restore-long": { leverage: "75", side: "LONG" },
        "abort-restore-long": { leverage: "75", side: "LONG" },
        "restore-long-after-split": { leverage: "75", side: "LONG" },
      }[stage];
      const params = ["symbol", "leverage", "side", ...SIGNED];
      const valid = !writeUsed && expected && method === "POST" &&
        url.pathname === LEVERAGE_PATH &&
        [...url.searchParams.keys()].every((key) => params.includes(key)) &&
        params.every((key) => url.searchParams.getAll(key).length === 1) &&
        url.searchParams.get("symbol") === API_SYMBOL &&
        url.searchParams.get("leverage") === expected.leverage &&
        url.searchParams.get("side") === expected.side &&
        url.searchParams.get("recvWindow") === "5000" &&
        /^\d+$/.test(url.searchParams.get("timestamp") ?? "") &&
        /^[0-9a-f]{64}$/.test(url.searchParams.get("signature") ?? "");
      if (!valid) throw new Error("VST leverage write guard rejected request");
      // Consume this command's sole write before transport; no retry after uncertainty.
      writeUsed = true;
    }
    let response;
    try {
      response = await fetchImpl(input, { ...init, redirect: "error" });
    } catch {
      throw new Error(method === "GET" ? "VST read transport failed" : "VST write result unknown");
    }
    if (response?.redirected === true) throw new Error("VST redirect rejected");
    return response;
  };
}

async function syncDirectory(path) {
  const handle = await open(dirname(path), "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function persistState(path, state, { exclusive = false } = {}) {
  await mkdir(dirname(path), { recursive: true });
  if (exclusive) {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
  } else {
    const temp = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temp, path);
  }
  await syncDirectory(path);
}

async function readState(path) {
  let state;
  try { state = JSON.parse(await readFile(path, "utf8")); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("state_unreadable_or_invalid");
  }
  if (state?.environment !== "vst" || state?.symbol !== SYMBOL ||
      state?.originalLeverage?.long !== 75 || state?.originalLeverage?.short !== 75) {
    throw new Error("state_invalid");
  }
  return state;
}

async function readProbeState(path) {
  let state;
  try { state = JSON.parse(await readFile(path, "utf8")); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("probe_state_unreadable_or_invalid");
  }
  if (state?.environment !== "vst" || state?.symbol !== SYMBOL) {
    throw new Error("probe_state_invalid");
  }
  return state;
}

function probeStateAllowsRestore(state) {
  if (!state) return false;
  const unresolvedStatuses = new Set([
    "entry_submitting",
    "entry_submitted_verifying",
    "entry_unknown_halt_no_retry",
    "add_stop_submitting",
    "add_stop_unknown_halt_no_retry",
    "emergency_close_submitting",
    "emergency_close_unknown_halt_no_retry",
  ]);
  const terminalClosed = ["verified_closed", "emergency_close_verified_flat",
    "emergency_close_verified_closed"]
    .includes(state.status);
  if (unresolvedStatuses.has(state.status) ||
      (!terminalClosed && ["submitting", "unknown_halt"].includes(state.addStop?.status))) {
    return false;
  }
  const reconciledClose = state.status !== "emergency_close_verified_closed" ||
    (state.emergencyClose?.reconciliation?.status === "verified_closed" &&
      state.emergencyClose.reconciliation.firstSnapshot?.openOrdersEmpty === true &&
      state.emergencyClose.reconciliation.secondSnapshot?.openOrdersEmpty === true &&
      state.emergencyClose.reconciliation.firstSnapshot?.closeFillsVerified === true &&
      state.emergencyClose.reconciliation.secondSnapshot?.closeFillsVerified === true &&
      state.emergencyClose.reconciliation.separationMs >= 10_000);
  return terminalClosed &&
    reconciledClose &&
    typeof state.entry?.positionId === "string" && state.entry.positionId.length > 0 &&
    typeof state.entry?.quantity === "string" &&
    typeof state.emergencyClose?.orderId === "string" &&
    state.emergencyClose.orderId.length > 0;
}

function delayedObservationPair(state, expectedLong, expectedShort) {
  const observations = Array.isArray(state?.readOnlyObservations)
    ? state.readOnlyObservations : [];
  const qualifies = (item) => item?.flat === true && item.openOrderCount === 0 &&
    item.positionMode === "HEDGE" && item.marginMode === "ISOLATED" &&
    item.leverage?.long === expectedLong && item.leverage?.short === expectedShort &&
    Number.isSafeInteger(item.observedAt);
  const latest = observations.at(-1);
  if (!qualifies(latest)) return null;
  const earlier = observations.slice(0, -1).find((item) =>
    qualifies(item) && latest.observedAt - item.observedAt >= OBSERVATION_GAP_MS);
  return earlier ? [earlier, latest] : null;
}

function archiveAbortedObservationsReady(state, currentSnapshot) {
  return delayedObservationPair(state, 75, 75) !== null &&
    currentSnapshot?.flat === true && currentSnapshot.openOrderCount === 0 &&
    currentSnapshot.positionMode === "HEDGE" && currentSnapshot.marginMode === "ISOLATED" &&
    currentSnapshot.leverage.long === 75 && currentSnapshot.leverage.short === 75;
}

function archiveLongRestoredObservationsReady(state, currentSnapshot) {
  return delayedObservationPair(state, 75, 75) !== null &&
    currentSnapshot?.flat === true && currentSnapshot.openOrderCount === 0 &&
    currentSnapshot.positionMode === "HEDGE" && currentSnapshot.marginMode === "ISOLATED" &&
    currentSnapshot.leverage.long === 75 && currentSnapshot.leverage.short === 75;
}

function abortLongNoFillStateEligible(state) {
  const abort = state?.abortRestoreLong;
  const preparation = abort?.preparationEvidence;
  const preparationStatusObservedAt = abort?.preparationStatusObservedAt;
  const expectedPreparation = preparation === undefined ||
    (preparation !== null && preparation.command === "prepare-long" &&
      preparation.side === "LONG" && preparation.from === 75 &&
      preparation.target === 10 &&
      preparation.verification === "adapter_setVstLeverage_get_verified" &&
      Number.isSafeInteger(preparation.verifiedAt) &&
      Number.isSafeInteger(preparationStatusObservedAt) &&
      preparation.verifiedAt <= preparationStatusObservedAt &&
      preparationStatusObservedAt <= abort.startedAt);
  return state?.workflow === "vst-btc-long-only" &&
    ["abort_restore_long_verified_75x_75x", "restored_long_only_75x_75x"]
      .includes(state.status) &&
    state.originalLeverage?.long === 75 && state.originalLeverage?.short === 75 &&
    abort?.status === "verified_75x_75x" &&
    abort.side === "LONG" && abort.from === 10 && abort.target === 75 &&
    Number.isSafeInteger(state.createdAt) &&
    Number.isSafeInteger(abort.startedAt) &&
    abort.startedAt >= state.createdAt &&
    state.lastConfirmedWrite?.command === "abort-restore-long" &&
    state.lastConfirmedWrite?.side === "LONG" &&
    state.lastConfirmedWrite?.from === 10 &&
    state.lastConfirmedWrite?.target === 75 &&
    state.lastConfirmedWrite?.verification === "adapter_setVstLeverage_get_verified" &&
    Number.isSafeInteger(state.lastConfirmedWrite?.verifiedAt) &&
    state.lastConfirmedWrite.verifiedAt >= abort.startedAt &&
    expectedPreparation &&
    !state.pendingWrite && !state.longWriteDiverged &&
    !state.restoreLong && !state.abortRestoreShort &&
    !state.archivedAbort && !state.archivedLongRestored;
}

function archiveAbortLongNoFillObservationsReady(state, currentSnapshot) {
  const observations = delayedObservationPair(state, 75, 75);
  return abortLongNoFillStateEligible(state) &&
    observations !== null &&
    observations[0].observedAt >= state.lastConfirmedWrite.verifiedAt &&
    observations[1].observedAt >= state.lastConfirmedWrite.verifiedAt &&
    currentSnapshot?.flat === true && currentSnapshot.openOrderCount === 0 &&
    currentSnapshot.positionMode === "HEDGE" && currentSnapshot.marginMode === "ISOLATED" &&
    currentSnapshot.leverage?.long === 75 && currentSnapshot.leverage?.short === 75 &&
    state.statusObservedAt >= state.lastConfirmedWrite.verifiedAt &&
    state.lastObservedLeverage?.long === currentSnapshot.leverage.long &&
    state.lastObservedLeverage?.short === currentSnapshot.leverage.short;
}

function archivedNoFillObservationValid(observation, clientOrderId, attemptStartedAt,
  historyWindowStart) {
  return observation?.clientOrderId === clientOrderId &&
    observation.attemptStartedAt === attemptStartedAt &&
    observation.allOrdersWindowStart === historyWindowStart &&
    Number.isSafeInteger(observation.observedAt) &&
    Number.isSafeInteger(observation.allOrdersWindowEnd) &&
    observation.allOrdersWindowEnd >= historyWindowStart &&
    observation.signedOrderLookupNotFoundCode === "109421" &&
    observation.clientOrderIdAbsentFromAllOrders === true &&
    observation.zeroBtcFillsVst === true &&
    observation.zeroBtcFillsUsdt === true &&
    observation.flatBtcBeforeAndAfterHistory === true &&
    observation.noOpenOrdersBeforeAndAfterHistory === true;
}

function exactArchivedNoFillProbeState(probeState, leverageState) {
  const entry = probeState?.entry;
  const proof = entry?.noFillArchive;
  const attemptStartedAt = Number(entry?.attemptStartedAt ?? probeState?.createdAt);
  const historyWindowStart = proof?.historyWindowStart;
  const first = proof?.firstObservation;
  const second = proof?.secondObservation;
  const probeCreatedAt = probeState?.createdAt;
  const abortStartedAt = leverageState?.abortRestoreLong?.startedAt;
  if (probeState?.status !== "archived_no_fill_operator_verified" ||
      proof?.status !== "verified" || proof.operatorConfirmed !== true ||
      typeof entry?.clientOrderId !== "string" || !entry.clientOrderId ||
      !Number.isSafeInteger(attemptStartedAt) || attemptStartedAt <= 0 ||
      !Number.isSafeInteger(historyWindowStart) ||
      historyWindowStart >= attemptStartedAt ||
      !Number.isSafeInteger(probeCreatedAt) ||
      !Number.isSafeInteger(leverageState?.createdAt) ||
      !Number.isSafeInteger(abortStartedAt) ||
      probeCreatedAt < leverageState.createdAt || probeCreatedAt >= abortStartedAt ||
      attemptStartedAt < probeCreatedAt || attemptStartedAt >= abortStartedAt ||
      proof.attemptStartedAt !== attemptStartedAt ||
      !Number.isSafeInteger(proof.separationMs) ||
      proof.separationMs < OBSERVATION_GAP_MS ||
      !archivedNoFillObservationValid(first, entry.clientOrderId, attemptStartedAt,
        historyWindowStart) ||
      !archivedNoFillObservationValid(second, entry.clientOrderId, attemptStartedAt,
        historyWindowStart) ||
      second.observedAt - first.observedAt < OBSERVATION_GAP_MS ||
      second.allOrdersWindowEnd < first.allOrdersWindowEnd) return false;
  return true;
}

async function discoverArchivedNoFillProbeEvidence(probeStatePath, leverageState) {
  const activeProbe = await readProbeState(probeStatePath);
  if (activeProbe) throw new Error("archive_abort_long_no_fill_requires_no_active_probe");

  const absoluteProbePath = resolve(probeStatePath);
  const parent = dirname(absoluteProbePath);
  const archivePrefix = `${basename(absoluteProbePath)}.archive-no-fill-`;
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("archive_abort_long_no_fill_probe_archive_discovery_failed");
  }
  const candidateEntries = entries.filter((entry) => entry.name.startsWith(archivePrefix));
  if (candidateEntries.some((entry) => !entry.isDirectory())) {
    throw new Error("archive_abort_long_no_fill_probe_archive_unreadable_or_invalid");
  }
  const archiveDirectories = candidateEntries;
  const matching = [];
  for (const directory of archiveDirectories) {
    const archivePath = resolve(parent, directory.name, basename(absoluteProbePath));
    let fileStat;
    try {
      fileStat = await lstat(archivePath);
    } catch {
      throw new Error("archive_abort_long_no_fill_probe_archive_unreadable_or_invalid");
    }
    if (!fileStat.isFile()) {
      throw new Error("archive_abort_long_no_fill_probe_archive_unreadable_or_invalid");
    }
    let probeState;
    try {
      probeState = JSON.parse(await readFile(archivePath, "utf8"));
    } catch {
      throw new Error("archive_abort_long_no_fill_probe_archive_unreadable_or_invalid");
    }
    if (probeState?.environment !== "vst" || probeState?.symbol !== SYMBOL) {
      throw new Error("archive_abort_long_no_fill_probe_archive_unreadable_or_invalid");
    }
    const createdAt = probeState?.createdAt;
    const inLeverageSession = Number.isSafeInteger(createdAt) &&
      Number.isSafeInteger(leverageState?.createdAt) &&
      Number.isSafeInteger(leverageState?.abortRestoreLong?.startedAt) &&
      createdAt >= leverageState.createdAt &&
      createdAt < leverageState.abortRestoreLong.startedAt;
    if (!inLeverageSession) continue;
    if (!exactArchivedNoFillProbeState(probeState, leverageState)) {
      throw new Error("archive_abort_long_no_fill_requires_matching_verified_probe_evidence");
    }
    matching.push({ archivePath, state: probeState });
  }
  if (matching.length > 1) {
    throw new Error("archive_abort_long_no_fill_probe_evidence_is_ambiguous");
  }
  return matching[0] ?? null;
}

function exactReconciledProbeClose(state, { archived = false } = {}) {
  const terminal = archived
    ? ["archived_closed", "emergency_close_verified_closed"].includes(state?.status) &&
      probeStateAllowsRestore({ ...state, status: "emergency_close_verified_closed" })
    : state?.status === "emergency_close_verified_closed" &&
      probeStateAllowsRestore(state);
  if (!terminal) return false;
  const close = state.emergencyClose;
  const proof = close?.reconciliation;
  const first = proof?.firstSnapshot;
  const second = proof?.secondSnapshot;
  const positionId = state.entry?.positionId;
  const quantity = close?.quantity;
  const stopId = state.entry?.stopOrderId;
  if (proof?.status !== "verified_closed" ||
      typeof close?.clientOrderId !== "string" || !close.clientOrderId ||
      close.positionId !== positionId ||
      !/^\d+(?:\.\d+)?$/.test(String(quantity)) ||
      !stopId || !Number.isSafeInteger(first?.observedAt) ||
      !Number.isSafeInteger(second?.observedAt) ||
      second.observedAt - first.observedAt < OBSERVATION_GAP_MS ||
      proof.separationMs < OBSERVATION_GAP_MS) return false;
  const matches = (snapshot) => snapshot?.orderId === close.orderId &&
    snapshot.positionId === positionId && snapshot.quantity === quantity &&
    snapshot.originalStopId === stopId &&
    snapshot.closeFillsVerified === true &&
    snapshot.originalStopCanceledNoFills === true &&
    snapshot.flatBtcPositionRows === 0 && snapshot.openOrdersEmpty === true;
  const exactClose = matches(first) && matches(second);
  if (!exactClose || !archived) return exactClose;
  const archive = state.archiveClosed;
  return archive?.status === "verified" &&
    archive.closeClientOrderId === close.clientOrderId &&
    archive.closeOrderId === close.orderId &&
    archive.positionId === positionId &&
    archive.quantity === quantity &&
    Number.isSafeInteger(archive.firstSnapshot?.observedAt) &&
    Number.isSafeInteger(archive.secondSnapshot?.observedAt) &&
    archive.secondSnapshot.observedAt - archive.firstSnapshot.observedAt >= OBSERVATION_GAP_MS &&
    archive.firstSnapshot.flatBtcPositionRows === 0 &&
    archive.secondSnapshot.flatBtcPositionRows === 0 &&
    archive.firstSnapshot.openOrdersEmpty === true &&
    archive.secondSnapshot.openOrdersEmpty === true &&
    Number.isSafeInteger(archive.separationMs) &&
    archive.separationMs >= OBSERVATION_GAP_MS;
}

function archivedProbeWasCreatedInLeverageSession(probeState, leverageState) {
  const restoreStartedAt = leverageState?.restoreLong?.startedAt;
  const probeCreatedAt = probeState?.createdAt;
  const attemptStartedAt = probeState?.entry?.attemptStartedAt;
  return Number.isSafeInteger(leverageState?.createdAt) &&
    Number.isSafeInteger(restoreStartedAt) &&
    Number.isSafeInteger(probeCreatedAt) &&
    probeCreatedAt >= leverageState.createdAt &&
    probeCreatedAt < restoreStartedAt &&
    Number.isSafeInteger(attemptStartedAt) &&
    attemptStartedAt >= probeCreatedAt &&
    attemptStartedAt < restoreStartedAt;
}

function archivedProbeMatchesLeverageSession(probeState, leverageState) {
  const restoreStartedAt = leverageState?.restoreLong?.startedAt;
  const attemptStartedAt = probeState?.entry?.attemptStartedAt;
  const closeProof = probeState?.emergencyClose?.reconciliation;
  const firstCloseSnapshotAt = closeProof?.firstSnapshot?.observedAt;
  const secondCloseSnapshotAt = closeProof?.secondSnapshot?.observedAt;
  const archiveFirstSnapshotAt = probeState?.archiveClosed?.firstSnapshot?.observedAt;
  const archiveSecondSnapshotAt = probeState?.archiveClosed?.secondSnapshot?.observedAt;
  const leverageVerifiedAt = leverageState?.lastConfirmedWrite?.verifiedAt;
  return archivedProbeWasCreatedInLeverageSession(probeState, leverageState) &&
    Number.isSafeInteger(leverageVerifiedAt) &&
    leverageVerifiedAt >= restoreStartedAt &&
    Number.isSafeInteger(attemptStartedAt) &&
    Number.isSafeInteger(firstCloseSnapshotAt) &&
    firstCloseSnapshotAt >= attemptStartedAt &&
    Number.isSafeInteger(secondCloseSnapshotAt) &&
    secondCloseSnapshotAt >= firstCloseSnapshotAt &&
    secondCloseSnapshotAt <= restoreStartedAt &&
    Number.isSafeInteger(archiveFirstSnapshotAt) &&
    archiveFirstSnapshotAt >= secondCloseSnapshotAt &&
    Number.isSafeInteger(archiveSecondSnapshotAt) &&
    archiveSecondSnapshotAt >= archiveFirstSnapshotAt &&
    typeof probeState?.entry?.clientOrderId === "string" &&
    probeState.entry.clientOrderId.length > 0 &&
    typeof probeState?.entry?.positionId === "string" &&
    probeState.entry.positionId.length > 0 &&
    typeof probeState?.entry?.stopOrderId === "string" &&
    probeState.entry.stopOrderId.length > 0;
}

async function discoverArchivedProbeCloseEvidence(probeStatePath, leverageState) {
  const absoluteProbePath = resolve(probeStatePath);
  const parent = dirname(absoluteProbePath);
  const archivePrefix = `${basename(absoluteProbePath)}.archive-`;
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("archive_long_restored_probe_archive_discovery_failed");
  }
  const candidateEntries = entries.filter((entry) => entry.name.startsWith(archivePrefix));
  if (candidateEntries.some((entry) => !entry.isDirectory())) {
    throw new Error("archive_long_restored_probe_archive_unreadable_or_invalid");
  }
  const matching = [];
  for (const directory of candidateEntries) {
    const archivePath = resolve(parent, directory.name, basename(absoluteProbePath));
    let probeState;
    try {
      const fileStat = await lstat(archivePath);
      if (!fileStat.isFile()) throw new Error("not_file");
      probeState = JSON.parse(await readFile(archivePath, "utf8"));
    } catch {
      throw new Error("archive_long_restored_probe_archive_unreadable_or_invalid");
    }
    if (probeState?.environment !== "vst" || probeState?.symbol !== SYMBOL) {
      throw new Error("archive_long_restored_probe_archive_unreadable_or_invalid");
    }
    if (!archivedProbeWasCreatedInLeverageSession(probeState, leverageState)) continue;
    if (!archivedProbeMatchesLeverageSession(probeState, leverageState) ||
        !exactReconciledProbeClose(probeState, { archived: true })) {
      throw new Error("archive_long_restored_requires_exact_terminal_probe_close_evidence");
    }
    matching.push({ archivePath, state: probeState });
  }
  if (matching.length > 1) {
    throw new Error("archive_long_restored_probe_close_evidence_is_ambiguous");
  }
  return matching[0] ?? null;
}

function decimalUnits(value, scale) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > scale) return null;
  return BigInt(`${match[1]}${fraction.padEnd(scale, "0")}`);
}

function decimalSumExactlyMatches(total, parts) {
  const values = [total, ...parts].map((value) => {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value));
    return match ? match[2]?.length ?? 0 : null;
  });
  if (values.some((value) => value === null)) return false;
  const scale = Math.max(...values);
  const totalUnits = decimalUnits(total, scale);
  const partUnits = parts.map((value) => decimalUnits(value, scale));
  return totalUnits !== null && partUnits.every((value) => value !== null) &&
    partUnits.reduce((sum, value) => sum + value, 0n) === totalUnits;
}

function exactArchivedSplitStopProof(probeState, leverageState, restoreStartedAt) {
  const entry = probeState?.entry;
  const core = probeState?.core;
  const runner = probeState?.runner;
  const triggered = probeState?.triggeredRunner;
  const childFill = triggered?.childFill;
  const close = probeState?.emergencyClose;
  const reconciliation = close?.reconciliation;
  const entryQuantity = entry?.quantity;
  const closeObservedAt = reconciliation?.observedAt;
  if (probeState?.environment !== "vst" || probeState?.symbol !== SYMBOL ||
      probeState?.status !== "emergency_close_verified_flat_no_orders_fills" ||
      !Number.isSafeInteger(leverageState?.createdAt) ||
      !Number.isSafeInteger(probeState?.createdAt) ||
      probeState.createdAt < leverageState.createdAt ||
      probeState.createdAt >= restoreStartedAt ||
      !Number.isSafeInteger(restoreStartedAt) ||
      !entry || entry.fillsVerified !== true || entry.positionVerified !== true ||
      entry.attachedFullStopVerified !== true ||
      typeof entry.clientOrderId !== "string" || !entry.clientOrderId ||
      typeof entry.orderId !== "string" || !entry.orderId ||
      (entry.responseOrderId && entry.responseOrderId !== entry.orderId) ||
      typeof entry.positionId !== "string" || !entry.positionId ||
      !/^\d+(?:\.\d+)?$/.test(String(entryQuantity)) ||
      !core || typeof core.orderId !== "string" || !core.orderId ||
      !runner || typeof runner.orderId !== "string" || !runner.orderId ||
      !Number.isSafeInteger(runner.startedAt) ||
      runner.startedAt < probeState.createdAt ||
      !decimalSumExactlyMatches(entryQuantity, [core.quantity, runner.quantity]) ||
      !triggered ||
      triggered.status !== "triggered_runner_fill_and_residual_protection_verified" ||
      triggered.runnerOrderId !== runner.orderId ||
      triggered.positionId !== entry.positionId ||
      !Number.isSafeInteger(triggered.verifiedAt) ||
      triggered.verifiedAt < runner.startedAt ||
      triggered.verifiedAt >= close?.startedAt ||
      !decimalSumExactlyMatches(triggered.priorQuantity, [entryQuantity]) ||
      !decimalSumExactlyMatches(triggered.fillQuantity, [runner.quantity]) ||
      !decimalSumExactlyMatches(triggered.residualQuantity, [
        triggered.remainingQuantity,
      ]) ||
      !decimalSumExactlyMatches(entryQuantity, [
        runner.quantity, triggered.remainingQuantity,
      ]) ||
      !decimalSumExactlyMatches(entry.currentQuantity, [
        triggered.remainingQuantity,
      ]) ||
      !childFill || typeof childFill.orderId !== "string" || !childFill.orderId ||
      childFill.triggerOrderId !== runner.orderId ||
      childFill.symbol !== API_SYMBOL || childFill.side !== "SELL" ||
      !decimalSumExactlyMatches(childFill.quantity, [runner.quantity]) ||
      !/^\d+(?:\.\d+)?$/.test(String(childFill.price)) ||
      !/^-?\d+(?:\.\d+)?$/.test(String(childFill.feeAmount)) ||
      typeof childFill.feeAsset !== "string" || !childFill.feeAsset ||
      (probeState.originalStopCancellation &&
        probeState.originalStopCancellation.status !== "canceled_no_fills_verified") ||
      !close || typeof close.clientOrderId !== "string" || !close.clientOrderId ||
      typeof close.orderId !== "string" || !close.orderId ||
      close.positionId !== entry.positionId ||
      !decimalSumExactlyMatches(close.quantity, [triggered.remainingQuantity]) ||
      !Number.isSafeInteger(close.startedAt) ||
      close.startedAt >= restoreStartedAt ||
      close.startedAt <= triggered.verifiedAt ||
      reconciliation?.status !== "verified_flat_no_open_orders_fills" ||
      !Number.isSafeInteger(reconciliation.fillCount) ||
      reconciliation.fillCount < 1 ||
      !Number.isSafeInteger(reconciliation.flatPositionRows) ||
      reconciliation.flatPositionRows !== 0 ||
      reconciliation.openOrderCount !== 0 ||
      !Number.isSafeInteger(closeObservedAt) ||
      closeObservedAt < close.startedAt ||
      closeObservedAt >= restoreStartedAt) return false;
  return true;
}

async function discoverArchivedSplitStopEvidence(
  splitProbeStatePath, leverageState, restoreStartedAt,
) {
  let activeStat;
  try {
    activeStat = await lstat(splitProbeStatePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error("restore_long_after_split_probe_state_unreadable");
    }
  }
  if (activeStat) throw new Error("restore_long_after_split_requires_archived_probe_state");

  const absolutePath = resolve(splitProbeStatePath);
  const parent = dirname(absolutePath);
  const archivePrefix = `${basename(absolutePath)}.archive-`;
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("restore_long_after_split_archive_discovery_failed");
  }
  const candidates = entries.filter((entry) =>
    entry.name.startsWith(archivePrefix) &&
    /^\d+-/.test(entry.name.slice(archivePrefix.length)));
  if (candidates.some((entry) => !entry.isDirectory() && !entry.isFile())) {
    throw new Error("restore_long_after_split_archive_unreadable_or_invalid");
  }
  const matches = [];
  for (const directory of candidates) {
    const archiveTimestamp = /^(\d+)-/.exec(directory.name.slice(archivePrefix.length));
    if (!archiveTimestamp || !Number.isSafeInteger(Number(archiveTimestamp[1]))) {
      throw new Error("restore_long_after_split_archive_unreadable_or_invalid");
    }
    const archivedAt = Number(archiveTimestamp[1]);
    const archiveDirectory = resolve(parent, directory.name);
    const archivePath = directory.isFile()
      ? archiveDirectory
      : await (async () => {
      let files;
      try {
        files = await readdir(archiveDirectory, { withFileTypes: true });
      } catch {
        throw new Error("restore_long_after_split_archive_unreadable_or_invalid");
      }
      if (files.length !== 1 || !files[0].isFile() ||
          ![directory.name, basename(absolutePath)].includes(files[0].name)) {
        throw new Error("restore_long_after_split_archive_unreadable_or_invalid");
      }
      return resolve(archiveDirectory, files[0].name);
    })();
    let probeState;
    try {
      const fileStat = await lstat(archivePath);
      if (!fileStat.isFile()) throw new Error("not_file");
      probeState = JSON.parse(await readFile(archivePath, "utf8"));
    } catch {
      throw new Error("restore_long_after_split_archive_unreadable_or_invalid");
    }
    if (probeState?.environment !== "vst" || probeState?.symbol !== SYMBOL) {
      throw new Error("restore_long_after_split_archive_unreadable_or_invalid");
    }
    if (!Number.isSafeInteger(probeState?.createdAt) ||
        probeState.createdAt < leverageState?.createdAt ||
        probeState.createdAt >= restoreStartedAt) continue;
    if (!exactArchivedSplitStopProof(probeState, leverageState, restoreStartedAt)) {
      throw new Error("restore_long_after_split_requires_exact_archived_split_close_proof");
    }
    const closeObservedAt = probeState.emergencyClose.reconciliation.observedAt;
    if (archivedAt < closeObservedAt || archivedAt >= restoreStartedAt) {
      throw new Error("restore_long_after_split_archive_timestamp_outside_session");
    }
    matches.push({ archivePath, archivedAt, state: probeState });
  }
  if (matches.length > 1) {
    throw new Error("restore_long_after_split_archived_split_proof_is_ambiguous");
  }
  return matches[0] ?? null;
}

function appendReadOnlyObservation(state, snapshot) {
  const observation = {
    observedAt: snapshot.observedAt,
    leverage: snapshot.leverage,
    flat: snapshot.flat,
    openOrderCount: snapshot.openOrderCount,
    positionMode: snapshot.positionMode,
    marginMode: snapshot.marginMode,
  };
  const prior = Array.isArray(state.readOnlyObservations) ? state.readOnlyObservations : [];
  state.readOnlyObservations = [...prior, observation].slice(-8);
  state.lastReadOnlyObservation = observation;
}

async function acquireLock(lockPath = SHARED_VST_BTC_LOCK) {
  await mkdir(dirname(lockPath), { recursive: true });
  let handle;
  try { handle = await open(lockPath, "wx", 0o600); } catch {
    throw new Error("vst_btc_operation_busy_or_locked");
  }
  return async () => {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  };
}

function exactFlatPositions(rows) {
  return Array.isArray(rows) && rows.every((row) =>
    row && typeof row.symbol === "string" &&
    (row.symbol !== API_SYMBOL ||
      (/^-?\d+(?:\.\d+)?$/.test(String(row.positionAmt)) &&
       Number(row.positionAmt) === 0 &&
       ["LONG", "SHORT", "BOTH"].includes(row.positionSide))));
}

async function readSnapshot(api, clock = Date.now) {
  const [positions, orders, mode, marginType, leverage] = await Promise.all([
    api.getPositions(SYMBOL), api.getOpenOrders(SYMBOL), api.getPositionMode(),
    api.getMarginType(SYMBOL), api.getLeverage(SYMBOL),
  ]);
  if (!exactFlatPositions(positions)) throw new Error("btc_positions_not_verified_flat");
  if (!Array.isArray(orders)) throw new Error("btc_open_orders_unverified");
  if (orders.length) throw new Error("btc_open_orders_present");
  if (mode !== "HEDGE") throw new Error("hedge_mode_required");
  if (marginType !== "ISOLATED") throw new Error("isolated_margin_required");
  if (![leverage?.longLeverage, leverage?.shortLeverage].every((value) =>
    Number.isInteger(value) && [10, 75].includes(value))) {
    throw new Error("btc_leverage_pair_unverified");
  }
  return {
    observedAt: clock(),
    positionMode: mode,
    marginMode: marginType,
    flat: true,
    openOrderCount: 0,
    leverage: { long: leverage.longLeverage, short: leverage.shortLeverage },
  };
}

function summary(command, state, snapshot, extra = {}) {
  return {
    command,
    environment: "vst",
    symbol: SYMBOL,
    status: state?.status ?? "no_leverage_prep_state",
    originalLeverage: state?.originalLeverage ?? null,
    operatorReconciliationRequired: Boolean(state?.pendingWrite),
    instruction: state?.pendingWrite
      ? "An exchange write has an unknown result. Do not retry it; this state remains halted."
      : state?.abortRestoreLong?.status === "verified_75x_75x"
        ? "The LONG-only entry was explicitly aborted and restored to 75x; archive it as a no-fill abort, not as a closed-trade restoration."
        : state?.abortRestoreLong
          ? `LONG-only abort status is ${state.abortRestoreLong.status}; do not retry or label it as a closed-trade restoration.`
          : state?.abortRestoreShort
            ? `Legacy SHORT abort is ${state.abortRestoreShort.status}; archive it explicitly before beginning a new LONG-only session.`
            : null,
    archiveAbortedObservationCount: Array.isArray(state?.readOnlyObservations)
      ? state.readOnlyObservations.filter((item) => item?.flat === true &&
        item.openOrderCount === 0 && item.positionMode === "HEDGE" &&
        item.marginMode === "ISOLATED" &&
        item.leverage?.long === 75 && item.leverage?.short === 75).length
      : 0,
    archiveAbortedObservationsReady: Boolean(
      state?.abortRestoreShort && archiveAbortedObservationsReady(state, snapshot),
    ),
    archiveLongRestoredObservationCount: Array.isArray(state?.readOnlyObservations)
      ? state.readOnlyObservations.filter((item) => item?.flat === true &&
        item.openOrderCount === 0 && item.positionMode === "HEDGE" &&
        item.marginMode === "ISOLATED" &&
        item.leverage?.long === 75 && item.leverage?.short === 75).length
      : 0,
    archiveLongRestoredObservationsReady: Boolean(
      state?.workflow === "vst-btc-long-only" &&
      !state.abortRestoreLong &&
      state.status === "restored_long_only_75x_75x" &&
      archiveLongRestoredObservationsReady(state, snapshot),
    ),
    archiveAbortLongNoFillObservationCount: Array.isArray(state?.readOnlyObservations)
      ? state.readOnlyObservations.filter((item) => item?.flat === true &&
        item.openOrderCount === 0 && item.positionMode === "HEDGE" &&
        item.marginMode === "ISOLATED" &&
        item.leverage?.long === 75 && item.leverage?.short === 75).length
      : 0,
    archiveAbortLongNoFillObservationsReady: Boolean(
      archiveAbortLongNoFillObservationsReady(state, snapshot),
    ),
    observed: snapshot,
    readOnly: !WRITE_STAGES.has(command),
    freshness: snapshot ? {
      observedAt: new Date(snapshot.observedAt).toISOString(),
      ageMs: Math.max(0, Date.now() - snapshot.observedAt),
      note: "Freshness applies only to these signed GET observations; re-run status immediately before the next confirmed stage.",
    } : null,
    ...extra,
  };
}

async function archiveAbortedState(statePath, state, snapshot, clock) {
  const archivedAt = clock();
  const timestamp = new Date(archivedAt).toISOString()
    .replaceAll(":", "-").replaceAll(".", "-");
  let archiveDirectory;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    archiveDirectory = `${statePath}.archive-${timestamp}-${randomUUID()}`;
    try {
      await mkdir(archiveDirectory, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt === 4) throw error;
    }
  }
  const archivePath = resolve(archiveDirectory, "state.json");
  const proof = delayedObservationPair(state, 75, 75);
  state.archivedAbort = {
    archivedAt,
    archivePath,
    observationTimes: proof.map((item) => item.observedAt),
    finalSnapshot: snapshot,
    abortEvidenceRetained: true,
  };
  state.status = "archived_aborted_terminal";
  // Sync all archival evidence before moving the live state out of the active path.
  await persistState(statePath, state);
  await rename(statePath, archivePath);
  await syncDirectory(archiveDirectory);
  await syncDirectory(statePath);
  return archivePath;
}

async function archiveLongRestoredState(
  statePath, state, snapshot, probeState, clock, probeArchivePath = null,
  splitProbeEvidence = null,
) {
  const archivedAt = clock();
  const timestamp = new Date(archivedAt).toISOString()
    .replaceAll(":", "-").replaceAll(".", "-");
  let archiveDirectory;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    archiveDirectory = `${statePath}.archive-${timestamp}-${randomUUID()}`;
    try {
      await mkdir(archiveDirectory, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt === 4) throw error;
    }
  }
  const archivePath = resolve(archiveDirectory, "state.json");
  const observationProof = delayedObservationPair(state, 75, 75);
  state.archivedLongRestored = {
    archivedAt,
    archivePath,
    leverageObservationTimes: observationProof.map((item) => item.observedAt),
    finalSnapshot: snapshot,
    ...(splitProbeEvidence ? {
      splitProbeStatus: splitProbeEvidence.state.status,
      splitProbeEvidence: splitProbeEvidence.state,
      splitProbeEvidenceArchivePath: splitProbeEvidence.archivePath,
    } : {
      probeCloseStatus: probeState.status,
      probeCloseEvidence: probeState,
      ...(probeArchivePath ? { probeCloseEvidenceArchivePath: probeArchivePath } : {}),
    }),
    allPriorLeverageEvidenceRetained: true,
  };
  state.status = "archived_long_restored_terminal";
  // Persist the complete evidence bundle before atomically moving the live state.
  await persistState(statePath, state);
  await rename(statePath, archivePath);
  await syncDirectory(archiveDirectory);
  await syncDirectory(statePath);
  return archivePath;
}

async function archiveAbortLongNoFillState(statePath, state, snapshot, probeEvidence, clock) {
  const archivedAt = clock();
  const timestamp = new Date(archivedAt).toISOString()
    .replaceAll(":", "-").replaceAll(".", "-");
  let archiveDirectory;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    archiveDirectory = `${statePath}.archive-abort-long-no-fill-${timestamp}-${randomUUID()}`;
    try {
      await mkdir(archiveDirectory, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt === 4) throw error;
    }
  }
  const archivePath = resolve(archiveDirectory, "state.json");
  const observationProof = delayedObservationPair(state, 75, 75);
  state.archivedAbortLongNoFill = {
    archivedAt,
    archivePath,
    leverageObservationTimes: observationProof.map((item) => item.observedAt),
    finalSnapshot: snapshot,
    abortStatus: state.abortRestoreLong.status,
    probeNoFillEvidenceFound: Boolean(probeEvidence),
    ...(probeEvidence ? {
      probeNoFillArchivePath: probeEvidence.archivePath,
      probeNoFillEvidence: probeEvidence.state,
    } : {}),
    allPriorLeverageEvidenceRetained: true,
  };
  state.status = "archived_abort_long_no_fill_terminal";
  // Persist the complete evidence bundle before atomically moving the live state.
  await persistState(statePath, state);
  await rename(statePath, archivePath);
  await syncDirectory(archiveDirectory);
  await syncDirectory(statePath);
  return archivePath;
}

export async function runLeveragePrepUnlocked({
  command, api, statePath = DEFAULT_STATE_PATH,
  probeStatePath = DEFAULT_PROBE_STATE_PATH,
  splitProbeStatePath = DEFAULT_SPLIT_PROBE_STATE_PATH,
  confirmed = false, clock = Date.now,
}) {
  if (!COMMANDS.has(command)) throw new Error("invalid_command");
  if (CONFIRMATION[command] && confirmed !== true) throw new Error("confirmation_required");
  let state = await readState(statePath);
  const snapshot = await readSnapshot(api, clock);

  if (command === "preview") {
    const validStart = snapshot.leverage.long === 75 && snapshot.leverage.short === 75;
    return summary(command, state, snapshot, {
      status: validStart ? "ready_for_long_only_probe_prep" : "review_current_leverage",
      plan: [
        "Prepare LONG 75x to 10x only; SHORT remains untouched at 75x.",
        "Run read-only status; probe-ready requires LONG10/SHORT75, HEDGE, ISOLATED, flat, and no BTC orders.",
        "After terminal verified probe close, use restore-long; if no probe started, explicitly use abort-restore-long.",
      ],
      noWrites: true,
    });
  }

  if (command === "status") {
    if (state) appendReadOnlyObservation(state, snapshot);
    if (state?.pendingWrite) {
      state.status = state.abortRestoreLong
        ? "abort_restore_long_unknown_halt_no_retry"
        : state.restoreLong?.command === "restore-long-after-split"
          ? "restore_long_after_split_unknown_halt_no_retry"
          : "leverage_write_unknown_halt_no_retry";
      await persistState(statePath, state);
    } else if (state) {
      state.lastObservedLeverage = snapshot.leverage;
      if (state.abortRestoreShort) {
        const wasVerified = ["verified_75x_75x", "verified"].includes(
          state.abortRestoreShort.status,
        );
        if (wasVerified && snapshot.leverage.long === 75 && snapshot.leverage.short === 75) {
          state.status = "abort_restore_short_verified_75x_75x";
          state.statusObservedAt = snapshot.observedAt;
        } else {
          state.status = "legacy_abort_short_terminal_manual_review";
        }
      } else if (state.abortRestoreLong ||
          state.restoreLong?.status === "adapter_verified_status_required") {
        const aborting = Boolean(state.abortRestoreLong);
        const restoreRecord = state.abortRestoreLong ?? state.restoreLong;
        const expectedCommand = aborting ? "abort-restore-long"
          : restoreRecord?.command ?? "restore-long";
        if (["adapter_verified_status_required", "verified_75x_75x"]
            .includes(restoreRecord?.status) &&
            snapshot.leverage.long === 75 && snapshot.leverage.short === 75 &&
            state.lastConfirmedWrite?.command === expectedCommand &&
            state.lastConfirmedWrite?.side === "LONG" &&
            state.lastConfirmedWrite?.target === 75) {
          restoreRecord.status = "verified_75x_75x";
          restoreRecord.statusObservedAt = snapshot.observedAt;
          if (aborting) state.probeReady = false;
          state.status = aborting
            ? "abort_restore_long_verified_75x_75x"
            : "restored_long_only_75x_75x";
          state.statusObservedAt = snapshot.observedAt;
        } else if (restoreRecord?.status === "diverged_halt_no_retry") {
          state.probeReady = false;
          state.status = "long_restore_diverged_halt_no_retry";
        } else {
          state.probeReady = false;
          if (restoreRecord) restoreRecord.status = "diverged_halt_no_retry";
          state.status = "long_restore_diverged_halt_no_retry";
        }
      } else if (state.workflow === "vst-btc-long-only") {
        if (state.longWriteDiverged) {
          state.probeReady = false;
          state.status = "long_write_diverged_halt_no_retry";
        } else if (state.lastConfirmedWrite?.side === "LONG" &&
            snapshot.leverage.long !== state.lastConfirmedWrite.target) {
          state.longWriteDiverged = true;
          state.probeReady = false;
          state.status = "long_write_diverged_halt_no_retry";
        } else {
          state.statusObservedAt = snapshot.observedAt;
          if (state.lastConfirmedWrite?.command === "prepare-long" &&
              state.lastConfirmedWrite.target === 10 &&
              snapshot.leverage.long === 10 && snapshot.leverage.short === 75) {
            state.probeReady = true;
            state.status = "probe_ready_long_only";
          } else if (snapshot.leverage.long === 75 && snapshot.leverage.short === 75 &&
              state.lastConfirmedWrite?.target === 75) {
            state.probeReady = false;
            state.status = "restored_long_only_75x_75x";
          } else {
            state.probeReady = false;
            state.status = "long_only_not_probe_ready";
          }
        }
      } else {
        state.status = "legacy_state_manual_review";
      }
      await persistState(statePath, state);
    }
    return summary(command, state, snapshot, { noWrites: true });
  }

  if (command === "archive-aborted") {
    const terminalAbort = ["verified_75x_75x", "verified"].includes(
      state?.abortRestoreShort?.status,
    );
    if (!state || !terminalAbort || state.pendingWrite ||
        state.originalLeverage?.long !== 75 || state.originalLeverage?.short !== 75 ||
        state.archivedAbort) {
      throw new Error("archive_aborted_requires_terminal_verified_abort_and_original_75x_75x");
    }
    if (!archiveAbortedObservationsReady(state, snapshot)) {
      throw new Error("archive_aborted_requires_two_delayed_75x_75x_flat_observations");
    }
    if (await readProbeState(probeStatePath)) {
      throw new Error("archive_aborted_requires_no_probe_state");
    }
    const archivePath = await archiveAbortedState(statePath, state, snapshot, clock);
    return summary(command, state, snapshot, {
      archivePath,
      archived: true,
      abortEvidenceRetained: true,
      instruction: "The aborted legacy session was archived intact and is never loaded as a live pending intent. New preparation requires an explicit fresh LONG-only command.",
    });
  }

  if (command === "archive-abort-long-no-fill") {
    if (!state || !abortLongNoFillStateEligible(state) ||
        state.statusObservedAt === undefined ||
        state.lastObservedLeverage?.long !== snapshot.leverage.long ||
        state.lastObservedLeverage?.short !== snapshot.leverage.short) {
      throw new Error("archive_abort_long_no_fill_requires_verified_long_abort_and_no_pending_intents");
    }
    if (!archiveAbortLongNoFillObservationsReady(state, snapshot)) {
      throw new Error("archive_abort_long_no_fill_requires_two_delayed_75x_75x_flat_observations");
    }
    const probeEvidence = await discoverArchivedNoFillProbeEvidence(
      probeStatePath, state,
    );
    const archivePath = await archiveAbortLongNoFillState(
      statePath, state, snapshot, probeEvidence, clock,
    );
    return summary(command, state, snapshot, {
      archivePath,
      archived: true,
      exchangeWrites: 0,
      allPriorLeverageEvidenceRetained: true,
      probeNoFillEvidenceFound: Boolean(probeEvidence),
      ...(probeEvidence
        ? { probeNoFillArchivePath: probeEvidence.archivePath }
        : {}),
      instruction: probeEvidence
        ? "The LONG-only no-fill abort is archived with its matching persisted probe evidence. It is not a closed-trade restoration."
        : "The LONG-only no-fill abort is archived with all leverage evidence. No matching archived no-fill probe record was safely discoverable; this is not a closed-trade restoration.",
    });
  }

  if (command === "archive-long-restored") {
    const splitRestore = state?.restoreLong?.evidenceType === "vst-btc-virtual-split-stop";
    const expectedProbeTerminalStatus = splitRestore
      ? "split_stop_emergency_close_verified"
      : "emergency_close_verified_closed";
    if (!state || state.workflow !== "vst-btc-long-only" ||
        state.status !== "restored_long_only_75x_75x" ||
        state.restoreLong?.status !== "verified_75x_75x" ||
        state.restoreLong?.probeTerminalStatus !== expectedProbeTerminalStatus ||
        state.pendingWrite || state.abortRestoreLong || state.abortRestoreShort ||
        state.longWriteDiverged || state.archivedLongRestored ||
        state.originalLeverage?.long !== 75 || state.originalLeverage?.short !== 75 ||
        state.lastConfirmedWrite?.command !==
          (splitRestore ? "restore-long-after-split" : "restore-long") ||
        state.lastConfirmedWrite?.side !== "LONG" ||
        state.lastConfirmedWrite?.target !== 75 ||
        state.lastConfirmedWrite?.verification !== "adapter_setVstLeverage_get_verified" ||
        state.statusObservedAt === undefined ||
        state.lastObservedLeverage?.long !== snapshot.leverage.long ||
        state.lastObservedLeverage?.short !== snapshot.leverage.short) {
      throw new Error("archive_long_restored_requires_verified_terminal_restore_and_no_pending_intents");
    }
    if (!archiveLongRestoredObservationsReady(state, snapshot)) {
      throw new Error("archive_long_restored_requires_two_delayed_75x_75x_flat_observations");
    }
    if (splitRestore) {
      const splitEvidence = await discoverArchivedSplitStopEvidence(
        splitProbeStatePath, state, state.restoreLong.startedAt,
      );
      const proofObservedAt = splitEvidence?.state?.emergencyClose?.reconciliation?.observedAt;
      const observations = delayedObservationPair(state, 75, 75);
      if (!splitEvidence ||
          splitEvidence.archivePath !== state.restoreLong.splitProbeArchivePath ||
          splitEvidence.state.entry.clientOrderId !==
            state.restoreLong.splitEntryClientOrderId ||
          splitEvidence.state.entry.orderId !== state.restoreLong.splitEntryOrderId ||
          splitEvidence.state.entry.positionId !== state.restoreLong.splitPositionId ||
          splitEvidence.state.emergencyClose.orderId !== state.restoreLong.splitCloseOrderId ||
          !Number.isSafeInteger(proofObservedAt) ||
          !Number.isSafeInteger(state.lastConfirmedWrite?.verifiedAt) ||
          !observations ||
          observations.some((item) =>
            item.observedAt < proofObservedAt ||
            item.observedAt < state.restoreLong.startedAt ||
            item.observedAt < state.lastConfirmedWrite.verifiedAt) ||
          state.statusObservedAt < state.lastConfirmedWrite.verifiedAt) {
        throw new Error("archive_long_restored_requires_matching_split_proof_and_fresh_observations");
      }
      const archivePath = await archiveLongRestoredState(
        statePath, state, snapshot, null, clock, null, splitEvidence,
      );
      return summary(command, state, snapshot, {
        archivePath,
        archived: true,
        exchangeWrites: 0,
        allPriorLeverageEvidenceRetained: true,
        splitProbeEvidenceRetained: true,
        splitProbeEvidenceArchivePath: splitEvidence.archivePath,
        instruction: "Leverage and split-stop evidence are archived intact. The split-probe archive remains unchanged.",
      });
    }
    const activeProbeState = await readProbeState(probeStatePath);
    const archivedProbeEvidence = activeProbeState
      ? null
      : await discoverArchivedProbeCloseEvidence(probeStatePath, state);
    const probeState = activeProbeState ?? archivedProbeEvidence?.state ?? null;
    const exactProbeClose = activeProbeState
      ? exactReconciledProbeClose(activeProbeState)
      : Boolean(archivedProbeEvidence &&
        exactReconciledProbeClose(archivedProbeEvidence.state, { archived: true }) &&
        archivedProbeMatchesLeverageSession(archivedProbeEvidence.state, state));
    if (!exactProbeClose) {
      throw new Error("archive_long_restored_requires_exact_terminal_probe_close_evidence");
    }
    const archivePath = await archiveLongRestoredState(
      statePath, state, snapshot, probeState, clock, archivedProbeEvidence?.archivePath,
    );
    return summary(command, state, snapshot, {
      archivePath,
      archived: true,
      exchangeWrites: 0,
      allPriorLeverageEvidenceRetained: true,
      probeCloseEvidenceRetained: true,
      ...(archivedProbeEvidence
        ? { probeCloseEvidenceArchivePath: archivedProbeEvidence.archivePath }
        : {}),
      instruction: archivedProbeEvidence
        ? "Leverage evidence is archived intact with the matching already-archived terminal probe evidence. Both archives remain intact."
        : "Leverage evidence is archived intact. Archive the terminal probe state through its own read-only archive stage before beginning the next supervised probe session.",
    });
  }

  if (command === "prepare-long") {
    if (state?.pendingWrite) throw new Error("unknown_write_halt_no_retry");
    if (state) throw new Error("active_state_blocks_new_prepare_archive_aborted_state_first");
    if (snapshot.leverage.long !== 75 || snapshot.leverage.short !== 75) {
      throw new Error("initial_prepare_requires_verified_75x_75x");
    }
    if (await readProbeState(probeStatePath)) {
      throw new Error("prepare_long_requires_no_existing_probe_state");
    }
    state = {
      environment: "vst",
      symbol: SYMBOL,
      workflow: "vst-btc-long-only",
      createdAt: clock(),
      originalLeverage: { long: 75, short: 75 },
      status: "original_pair_persisted",
      probeReady: false,
      lastObservedLeverage: snapshot.leverage,
      statusObservedAt: snapshot.observedAt,
    };
    await persistState(statePath, state, { exclusive: true });
  }
  if (!state || state.workflow !== "vst-btc-long-only" ||
      state.originalLeverage?.long !== 75 || state.originalLeverage?.short !== 75) {
    throw new Error("long_only_state_with_original_75x_75x_required");
  }
  if (state.pendingWrite) throw new Error("unknown_write_halt_no_retry");
  if (state.longWriteDiverged) throw new Error("long_write_diverged_halt_no_retry");
  if (state.statusObservedAt === undefined ||
      state.lastObservedLeverage?.long !== snapshot.leverage.long ||
      state.lastObservedLeverage?.short !== snapshot.leverage.short) {
    throw new Error("fresh_read_only_status_required_before_write");
  }

  let operation;
  if (command === "prepare-long") {
    if (state.lastConfirmedWrite || snapshot.leverage.long !== 75 ||
        snapshot.leverage.short !== 75) {
      throw new Error("prepare_long_is_one_time_from_original_75x_75x_only");
    }
    operation = { side: "LONG", from: 75, target: 10, command };
  } else {
    const isAbort = command === "abort-restore-long";
    const isSplitRestore = command === "restore-long-after-split";
    if (!state.probeReady || state.lastConfirmedWrite?.command !== "prepare-long" ||
        state.lastConfirmedWrite?.target !== 10 ||
        snapshot.leverage.long !== 10 || snapshot.leverage.short !== 75) {
      throw new Error("restore_long_requires_status_verified_probe_ready_10x_75x");
    }
    if (isSplitRestore) {
      if (state.restoreLong || state.abortRestoreLong) {
        throw new Error("restore_long_after_split_is_already_started_or_terminal");
      }
      if (await readProbeState(probeStatePath)) {
        throw new Error("restore_long_after_split_requires_no_active_stop_coexist_probe");
      }
      const startedAt = clock();
      const splitEvidence = await discoverArchivedSplitStopEvidence(
        splitProbeStatePath, state, startedAt,
      );
      if (!splitEvidence) {
        throw new Error("restore_long_after_split_requires_unique_matching_archived_split_proof");
      }
      state.restoreLong = {
        command: "restore-long-after-split",
        status: "intent_persisted",
        side: "LONG",
        from: 10,
        target: 75,
        startedAt,
        probeTerminalStatus: "split_stop_emergency_close_verified",
        evidenceType: "vst-btc-virtual-split-stop",
        splitProbeArchivePath: splitEvidence.archivePath,
        splitEntryClientOrderId: splitEvidence.state.entry.clientOrderId,
        splitEntryOrderId: splitEvidence.state.entry.orderId,
        splitPositionId: splitEvidence.state.entry.positionId,
        splitCloseOrderId: splitEvidence.state.emergencyClose.orderId,
      };
    } else if (isAbort) {
      const probeState = await readProbeState(probeStatePath);
      if (probeState !== null) throw new Error("abort_restore_long_requires_no_probe_state");
      if (state.abortRestoreLong) throw new Error("abort_restore_long_is_one_time_terminal_no_retry");
      state.abortRestoreLong = {
        status: "intent_persisted",
        side: "LONG",
        from: 10,
        target: 75,
        startedAt: clock(),
        preparationEvidence: state.lastConfirmedWrite
          ? { ...state.lastConfirmedWrite } : null,
        preparationStatusObservedAt: state.statusObservedAt ?? null,
      };
    } else {
      const probeState = await readProbeState(probeStatePath);
      if (!probeStateAllowsRestore(probeState)) {
        throw new Error("restore_long_requires_terminal_verified_probe_close");
      }
      if (state.restoreLong) throw new Error("restore_long_is_already_started_or_terminal");
      state.restoreLong = {
        status: "intent_persisted",
        side: "LONG",
        from: 10,
        target: 75,
        startedAt: clock(),
        probeTerminalStatus: probeState.status,
      };
    }
    operation = {
      side: "LONG", from: 10, target: 75, command, isAbort, isSplitRestore,
    };
  }

  state.pendingWrite = { ...operation, startedAt: clock() };
  state.lastWriteAt = state.pendingWrite.startedAt;
  state.statusObservedAt = undefined;
  state.status = `${command.replaceAll("-", "_")}_submitting`;
  await persistState(statePath, state);
  try {
    await api.setVstLeverage(SYMBOL, operation.target, "LONG");
  } catch (error) {
    state.status = `${command.replaceAll("-", "_")}_unknown_halt_no_retry`;
    state.error = String(error?.message ?? "write_result_unknown").slice(0, 160);
    if (operation.isAbort) state.abortRestoreLong.status = "unknown_halt_no_retry";
    if (command === "restore-long" || operation.isSplitRestore) {
      state.restoreLong.status = "unknown_halt_no_retry";
    }
    await persistState(statePath, state);
    throw new Error(`${command.replaceAll("-", "_")}_unknown_halt_no_retry`);
  }

  state.pendingWrite = null;
  state.lastConfirmedWrite = {
    command,
    side: "LONG",
    from: operation.from,
    target: operation.target,
    verifiedAt: clock(),
    verification: "adapter_setVstLeverage_get_verified",
  };
  state.lastObservedLeverage = { ...snapshot.leverage, long: operation.target };
  state.statusObservedAt = undefined;
  state.status = `${command.replaceAll("-", "_")}_adapter_verified_status_required`;
  if (operation.isAbort) state.abortRestoreLong.status = "adapter_verified_status_required";
  if (command === "restore-long" || operation.isSplitRestore) {
    state.restoreLong.status = "adapter_verified_status_required";
  }
  await persistState(statePath, state);
  return summary(command, state, snapshot, {
    writePerformed: true,
    adapterVerifiedLeverage: { side: "LONG", leverage: operation.target },
    postWriteSnapshot: "deferred_to_required_read_only_status",
    nextWriteBlockedUntilStatus: true,
    ...(command === "restore-long" ? { probeStateGate: "terminal_verified_closed" } : {}),
    ...(operation.isAbort ? { abort: true } : {}),
  });
}

export async function runLeveragePrep(options) {
  const release = await acquireLock(options.lockPath ?? SHARED_VST_BTC_LOCK);
  try { return await runLeveragePrepUnlocked(options); } finally { await release(); }
}

function makeApi(stage) {
  const fetchImpl = createGuardedFetch(globalThis.fetch, { stage });
  return createBingXLiveApi({
    environment: "vst",
    fetchImpl,
    writePermission: ({ method, path }) =>
      method === "POST" && path === LEVERAGE_PATH && WRITE_STAGES.has(stage),
  });
}

export async function main(argv = process.argv.slice(2)) {
  const { command } = parseArgs(argv);
  const api = makeApi(command);
  const result = await runLeveragePrep({
    command, api, confirmed: Boolean(CONFIRMATION[command]),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error?.message ?? "vst_leverage_prep_failed");
    process.exitCode = 1;
  });
}