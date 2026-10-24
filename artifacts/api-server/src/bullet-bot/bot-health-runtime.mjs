const POLICY = Object.freeze({
  freshnessMs: 60_000,
  warningAfterMs: 180_000,
  criticalAfterMs: 300_000,
  repeatMs: 1_800_000,
  recoveryStableMs: 30_000,
  recoverySuccesses: 2,
});

const iso = (value) => value === null || value === undefined
  ? null
  : new Date(value).toISOString();

const startedAt = new Date().toISOString();
let source = {
  enabled: false,
  startedAt: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastSnapshotAt: null,
  lastDurationMs: null,
  totalPolls: 0,
  totalFailures: 0,
  consecutiveFailures: 0,
  lastReason: null,
  lastHttpStatus: null,
  incident: null,
  incidentStateKnown: true,
};

const lanes = {
  vst: createLane(),
  paper: createLane(),
};

function createLane() {
  return {
    enabled: false,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastSuccessAt: null,
    lastDurationMs: null,
    lastOutcome: null,
    lastReason: null,
    inFlight: false,
    errorTicks: 0,
    successfulTicks: 0,
    stallAfterMs: 120_000,
    startedAtMs: null,
  };
}

export function configureBotRuntimeHealth({
  sourceEnabled = false,
  vstEnabled = false,
  paperEnabled = false,
  sourceStartedAt = null,
} = {}) {
  source = {
    ...source,
    enabled: sourceEnabled === true,
    startedAt: sourceEnabled === true ? iso(sourceStartedAt ?? Date.now()) : null,
  };
  lanes.vst.enabled = vstEnabled === true;
  lanes.paper.enabled = paperEnabled === true;
}

export function updateBotSourceHealth(patch = {}) {
  source = { ...source, ...patch };
  if ("incident" in patch && patch.incident) source.incident = { ...patch.incident };
}

export function beginBotRuntimeTick(lane, at = Date.now()) {
  const state = lanes[lane];
  if (!state) return;
  state.inFlight = true;
  state.startedAtMs = Number(at);
  state.lastStartedAt = iso(at);
}

export function finishBotRuntimeTick(lane, {
  at = Date.now(),
  outcome = "success",
  reason = null,
} = {}) {
  const state = lanes[lane];
  if (!state) return;
  const finishedAtMs = Number(at);
  const elapsed = state.startedAtMs === null
    ? null : Math.max(0, finishedAtMs - state.startedAtMs);
  state.inFlight = false;
  state.startedAtMs = null;
  state.lastFinishedAt = iso(at);
  state.lastDurationMs = elapsed;
  state.lastOutcome = outcome;
  state.lastReason = reason;
  if (outcome === "success") {
    state.lastSuccessAt = iso(at);
    state.successfulTicks += 1;
  } else {
    state.errorTicks += 1;
  }
}

export function getBotRuntimeHealth() {
  return {
    startedAt,
    source: {
      enabled: source.enabled,
      startedAt: source.startedAt,
      lastAttemptAt: source.lastAttemptAt,
      lastSuccessAt: source.lastSuccessAt,
      lastSnapshotAt: source.lastSnapshotAt,
      lastDurationMs: source.lastDurationMs,
      totalPolls: source.totalPolls,
      totalFailures: source.totalFailures,
      consecutiveFailures: source.consecutiveFailures,
      lastReason: source.lastReason,
      lastHttpStatus: source.lastHttpStatus,
      incident: source.incident ? { ...source.incident } : null,
      incidentStateKnown: source.incidentStateKnown,
      policy: { ...POLICY },
    },
    vst: publicLane(lanes.vst),
    paper: publicLane(lanes.paper),
  };
}

function publicLane(state) {
  return {
    enabled: state.enabled,
    lastStartedAt: state.lastStartedAt,
    lastFinishedAt: state.lastFinishedAt,
    lastSuccessAt: state.lastSuccessAt,
    lastDurationMs: state.lastDurationMs,
    lastOutcome: state.lastOutcome,
    lastReason: state.lastReason,
    inFlight: state.inFlight,
    errorTicks: state.errorTicks,
    successfulTicks: state.successfulTicks,
    stallAfterMs: state.stallAfterMs,
  };
}