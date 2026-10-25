import { isSourceCancellation } from "./source-exit-evidence.mjs";

const MAX_SOURCE_SNAPSHOT_AGE_MS = 60_000;
const MAX_FUTURE_SKEW_MS = 30_000;
const MAX_PROVIDER_BACKOFF_MS = 5 * 60_000;
const SOURCE_EXIT_STATUSES = new Set([
  "cancelled", "profit", "stop_loss", "bu_stop", "expired", "reclassified",
]);
const NO_QUEUE_RESULT = Object.freeze({ queued: [], refreshed: [], rejected: [] });

function timestamp(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function snapshotIsFresh(snapshot, now) {
  const asOfMs = timestamp(snapshot?.asOf);
  const observedAt = Number(now());
  return asOfMs !== null &&
    asOfMs <= observedAt + MAX_FUTURE_SKEW_MS &&
    observedAt - asOfMs <= MAX_SOURCE_SNAPSHOT_AGE_MS;
}

function sourceExitProjection(snapshot) {
  // This is a projection of an already fully fetched and validated snapshot,
  // not a partial fetch. Only explicitly terminal/withdrawn source records can
  // create commands; absence from the snapshot never implies an exit.
  return {
    ...snapshot,
    allPositions: snapshot.positions,
    positions: new Map([...snapshot.positions].filter(([, source]) =>
      source?.sourceAction !== undefined
        ? source.sourceAction === "close" || isSourceCancellation(source)
        : SOURCE_EXIT_STATUSES.has(source?.sourceStatus))),
  };
}

/**
 * Drives source ingestion independently from any ledger lock, exchange audit,
 * or notification. A successful fetch is the only input to exit persistence;
 * application and observational work run in their own single-flight lanes so
 * a hung consumer cannot starve future snapshots.
 */
export function createSourceLifecycleScheduler({
  fetchSnapshot,
  queuePaperExits,
  queueVstExits,
  applyPaperSnapshot,
  auditSnapshot,
  wakeVst = () => {},
  now = Date.now,
  intervalMs = 60_000,
  paperRetryMs = 500,
  paperMaxRetryAttempts = 5,
  enqueueRetryMs = 500,
  maxEnqueueAttempts = 3,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  onPollStart = () => {},
  onPollEnd = () => {},
  onPollSkip = () => {},
  onAttemptFailure = () => {},
  onError = () => {},
  onQueueResult = () => {},
}) {
  if (typeof fetchSnapshot !== "function") throw new TypeError("fetchSnapshot must be a function");
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new TypeError("intervalMs must be positive");
  if (!Number.isSafeInteger(enqueueRetryMs) || enqueueRetryMs <= 0 ||
      !Number.isSafeInteger(maxEnqueueAttempts) || maxEnqueueAttempts < 1) {
    throw new TypeError("source enqueue retries must be positive integers");
  }

  let stopped = false;
  let started = false;
  let polling = false;
  let pollSequence = 0;
  let timer = null;
  let paperRetryTimer = null;
  let paperRetryResolve = null;
  const enqueueRetryTimers = new Map();
  let paperPending = [];
  let paperRunning = false;
  let paperPersistenceRunning = false;
  let auditPending = null;
  let auditRunning = false;
  let paperLatestPersisted = null;
  let providerBackoffUntil = 0;

  const reportError = (lane, error, snapshot) => {
    if (stopped) return;
    try { onError({ lane, error, snapshot }); } catch {}
  };

  const retryDelay = () => new Promise((resolve) => {
    const handle = setTimeoutFn(() => {
      enqueueRetryTimers.delete(handle);
      resolve();
    }, enqueueRetryMs);
    enqueueRetryTimers.set(handle, resolve);
    handle?.unref?.();
  });

  const persistWithRetry = async (snapshot, persist) => {
    for (let attempt = 0; attempt < maxEnqueueAttempts && !stopped; attempt += 1) {
      if (!snapshotIsFresh(snapshot, now)) {
        const error = new Error("stale_snapshot_before_source_enqueue");
        error.code = "stale_source_snapshot";
        throw error;
      }
      try {
        return await persist(snapshot);
      } catch (error) {
        try { onAttemptFailure({ lane: "enqueue", error, snapshot }); } catch {}
        if (attempt + 1 >= maxEnqueueAttempts || stopped) throw error;
        await retryDelay();
      }
    }
    return null;
  };

  const runAudit = async () => {
    if (stopped || auditRunning || !auditPending || typeof auditSnapshot !== "function") return;
    auditRunning = true;
    while (!stopped && auditPending) {
      const snapshot = auditPending;
      auditPending = null;
      try {
        await auditSnapshot(snapshot);
      } catch (error) {
        reportError("audit", error);
      }
    }
    auditRunning = false;
  };

  const applyLatestPaper = async () => {
    if (stopped || paperRunning || !paperLatestPersisted || typeof applyPaperSnapshot !== "function") return;
    paperRunning = true;
    let retryCount = 0;
    try {
      while (!stopped && paperLatestPersisted) {
        const snapshot = paperLatestPersisted;
        paperLatestPersisted = null;
        if (!snapshotIsFresh(snapshot, now)) {
          reportError("paper_apply", Object.assign(new Error("stale_snapshot_before_paper_apply"), {
            code: "stale_source_snapshot",
          }), snapshot);
          continue;
        }
        let result;
        try {
          result = await applyPaperSnapshot(snapshot);
        } catch (error) {
          reportError("paper_apply", error);
          result = null;
        }
        const deferred = result === null ||
          (Array.isArray(result) && result.some((item) => item?.kind === "error"));
        if (deferred && !stopped) {
          retryCount += 1;
          if (retryCount <= paperMaxRetryAttempts) {
            // A newer persisted snapshot takes precedence over retrying old
            // observations; it also retains withdrawal evidence.
            if (!paperLatestPersisted) paperLatestPersisted = snapshot;
            await new Promise((resolve) => {
              paperRetryResolve = resolve;
              paperRetryTimer = setTimeoutFn(() => {
                paperRetryTimer = null;
                paperRetryResolve = null;
                resolve();
              }, paperRetryMs);
              paperRetryTimer?.unref?.();
            });
            continue;
          }
          reportError("paper_apply", new Error("paper_source_apply_deferred"));
        } else {
          retryCount = 0;
        }
      }
    } finally {
      paperRunning = false;
      if (!stopped && paperLatestPersisted) void applyLatestPaper();
    }
  };

  const drainPaperPersistence = async () => {
    if (stopped || paperPersistenceRunning) return;
    paperPersistenceRunning = true;
    try {
      while (!stopped && paperPending.length) {
        const current = paperPending.shift();
        if (!snapshotIsFresh(current, now)) {
          reportError("paper_persist", Object.assign(new Error("stale_snapshot_before_paper_enqueue"), {
            code: "stale_source_snapshot",
          }), current);
          continue;
        }
        try {
          const candidates = sourceExitProjection(current);
          const result = candidates.positions.size
            ? await persistWithRetry(candidates, queuePaperExits)
            : NO_QUEUE_RESULT;
          if (stopped) return;
          try { onQueueResult("paper", result, current); } catch {}
          paperLatestPersisted = current;
          void applyLatestPaper();
        } catch (error) {
          reportError("paper_persist", error, current);
          if (!stopped && snapshotIsFresh(current, now)) {
            await retryDelay();
            if (!stopped) paperPending.unshift(current);
          }
        }
      }
    } finally {
      paperPersistenceRunning = false;
      if (!stopped && paperPending.length) void drainPaperPersistence();
    }
  };

  const persistPaper = (snapshot) => {
    if (typeof queuePaperExits !== "function") {
      paperLatestPersisted = snapshot;
      void applyLatestPaper();
      return;
    }
    if (stopped) return;
    paperPending.push(snapshot);
    // Persistence and applying are intentionally separate: a stalled PAPER
    // lock/apply cannot prevent later snapshots being durably recorded.
    void drainPaperPersistence();
  };

  let vstPending = [];
  let vstRunning = false;
  const drainVstPersistence = async () => {
    if (stopped || vstRunning) return;
    vstRunning = true;
    try {
      while (!stopped && vstPending.length) {
        const current = vstPending.shift();
        if (!snapshotIsFresh(current, now)) {
          reportError("vst_persist", Object.assign(new Error("stale_snapshot_before_vst_enqueue"), {
            code: "stale_source_snapshot",
          }), current);
          continue;
        }
        try {
          const candidates = sourceExitProjection(current);
          const result = candidates.positions.size
            ? await persistWithRetry(candidates, queueVstExits)
            : NO_QUEUE_RESULT;
          if (stopped) return;
          try { onQueueResult("vst", result, current); } catch {}
          const queued = Array.isArray(result?.queued) ? result.queued : [];
          if (queued.length && !stopped) {
            try { wakeVst(); } catch (error) { reportError("vst_wake", error); }
          }
        } catch (error) {
          reportError("vst_persist", error, current);
          if (!stopped && snapshotIsFresh(current, now)) {
            await retryDelay();
            if (!stopped) vstPending.unshift(current);
          }
        }
      }
    } finally {
      vstRunning = false;
      if (!stopped && vstPending.length) void drainVstPersistence();
    }
  };

  const persistVst = (snapshot) => {
    if (typeof queueVstExits !== "function" || stopped) return;
    vstPending.push(snapshot);
    void drainVstPersistence();
  };

  async function pollNow() {
    if (stopped) return { kind: "stopped" };
    const currentTime = Number(now());
    const remainingBackoffMs = Math.max(0, providerBackoffUntil - currentTime);
    if (remainingBackoffMs > 0) {
      try {
        onPollSkip({ reason: "provider_backoff", remainingDelayMs: remainingBackoffMs });
      } catch {}
      return { kind: "provider_backoff", remainingDelayMs: remainingBackoffMs };
    }
    if (polling) {
      try { onPollSkip({ reason: "poll_in_flight" }); } catch {}
      return { kind: "in_flight" };
    }
    polling = true;
    const startedAt = Number(now());
    const metrics = { startedAt, pollId: ++pollSequence, fetchLatencyMs: null, asOf: null, asOfAgeMs: null };
    let fetchStartedAt = null;
    try {
      onPollStart({ ...metrics });
      fetchStartedAt = Number(now());
      const snapshot = await fetchSnapshot();
      if (stopped) return { kind: "stopped" };
      metrics.fetchLatencyMs = Math.max(0, Number(now()) - fetchStartedAt);
      const asOfMs = timestamp(snapshot?.asOf);
      const observedAt = Number(now());
      metrics.asOf = snapshot?.asOf ?? null;
      metrics.asOfAgeMs = asOfMs === null ? null : observedAt - asOfMs;
      if (!(snapshot?.positions instanceof Map) || asOfMs === null) {
        const error = new Error("invalid_source_snapshot");
        error.code = "invalid_source_snapshot";
        throw error;
      }
      if (asOfMs > observedAt + MAX_FUTURE_SKEW_MS ||
          observedAt - asOfMs > MAX_SOURCE_SNAPSHOT_AGE_MS) {
        const error = new Error("stale_source_snapshot");
        error.code = "stale_source_snapshot";
        throw error;
      }
      const accepted = { ...snapshot, observedAt, pollId: metrics.pollId };
      // These lanes are independent. Do not await ledger persistence, PAPER
      // lock acquisition, exchange audits, or Telegram delivery here.
      void persistPaper(accepted);
      void persistVst(accepted);
      if (typeof auditSnapshot === "function") {
        auditPending = accepted;
        void runAudit();
      }
      const counts = { hold: 0, close: 0, review: 0, unknown: 0, missingAction: 0 };
      for (const source of snapshot.positions.values()) {
        const key = Object.hasOwn(counts, source?.sourceAction) ? source.sourceAction : "missingAction";
        counts[key]++;
      }
      const result = { kind: "ok", ...metrics, recordCount: snapshot.positions.size, sourceActions: counts };
      onPollEnd(result);
      return result;
    } catch (error) {
      try { onAttemptFailure({ lane: "fetch", error }); } catch {}
      const retryAfterMs = Number(error?.retryAfterMs);
      if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        providerBackoffUntil = Math.max(
          providerBackoffUntil,
          Number(now()) + Math.min(MAX_PROVIDER_BACKOFF_MS, retryAfterMs),
        );
      }
      if (metrics.fetchLatencyMs === null && fetchStartedAt !== null) {
        metrics.fetchLatencyMs = Math.max(0, Number(now()) - fetchStartedAt);
      }
      const result = { kind: "error", ...metrics, error };
      reportError("fetch", error);
      onPollEnd(result);
      return result;
    } finally {
      polling = false;
    }
  }

  function start() {
    if (stopped || started) return stop;
    started = true;
    timer = setIntervalFn(() => {
      if (!stopped) void pollNow();
    }, intervalMs);
    timer?.unref?.();
    void pollNow();
    return stop;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearIntervalFn(timer);
    if (paperRetryTimer !== null) clearTimeoutFn(paperRetryTimer);
    paperRetryResolve?.();
    paperRetryResolve = null;
    for (const [handle, resolve] of enqueueRetryTimers) {
      clearTimeoutFn(handle);
      resolve();
    }
    enqueueRetryTimers.clear();
    timer = null;
    paperRetryTimer = null;
    paperPending = [];
    paperLatestPersisted = null;
    auditPending = null;
    vstPending = [];
  }

  return { start, stop, pollNow };
}

/** Alerts after loss of admitted source data; recovery evidence is process-local. */
export function createSourceFreshnessWatchdog({
  sendAlert,
  persistence,
  now = Date.now,
  staleAfterMs = 60_000,
  warningAfterMs = 180_000,
  criticalAfterMs = 300_000,
  repeatAfterMs = 1_800_000,
  recoveryStableMs = 30_000,
  recoverySuccesses = 2,
  warningFailureThreshold = 3,
  retryAfterMs = 60_000,
  checkIntervalMs = 5_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onError = () => {},
  onStale = () => {},
  onRecovered = () => {},
  onState = () => {},
  onPersistenceState = () => {},
}) {
  let stopped = false;
  let busy = false;
  let timer = null;
  const startedAt = Number(now());
  let lastHealthyAt = null;
  let failureCount = 0;
  let incidentStartedAt = null;
  let severity = null;
  let deliveredSeverity = null;
  let alertedAt = null;
  let nextAlertAt = 0;
  let recoverySince = null;
  let recoveryCount = 0;
  let recoveryLastAt = null;
  let recoverySnapshotAt = null;
  let staleReported = false;
  let restored = !persistence;
  let restoring = false;
  let restoreAfter = 0;
  let writes = Promise.resolve();
  let savedState = null;
  const persistenceStatus = (known) => { try { onPersistenceState(known); } catch {} };
  persistenceStatus(restored);

  const checkpoint = () => ({
    version: 1,
    incident: incidentStartedAt === null ? null : {
      startedAt: incidentStartedAt,
      referenceAt: lastHealthyAt ?? startedAt,
      severity, deliveredSeverity, alertedAt, nextAlertAt, failureCount,
    },
  });
  // Serialize snapshots so a slow older write cannot overwrite an acknowledgement
  // or a silent clear. Failed snapshots remain eligible for a later retry.
  const persist = () => {
    if (!persistence || !restored) return Promise.resolve();
    const state = checkpoint();
    const encoded = JSON.stringify(state);
    writes = writes.catch(() => {}).then(async () => {
      try {
        if (savedState !== encoded) {
          await persistence.save(state);
          savedState = encoded;
        }
        persistenceStatus(true);
      } catch (error) {
        persistenceStatus(false);
        throw error;
      }
    });
    return writes;
  };
  const reportError = (error) => { try { onError(error); } catch {} };
  const publish = () => {
    try { onState(incidentSnapshot()); } catch {}
    void persist().catch(reportError);
  };
  const restore = async () => {
    if (restoring || Number(now()) < restoreAfter) return;
    restoring = true;
    try {
      const state = await persistence.load();
      if (stopped) return;
      const i = state?.incident;
      if (i) {
        incidentStartedAt = i.startedAt;
        lastHealthyAt = i.referenceAt;
        severity = i.severity;
        deliveredSeverity = i.deliveredSeverity;
        alertedAt = i.alertedAt;
        nextAlertAt = i.nextAlertAt;
        failureCount = i.failureCount;
      }
      // Do NOT restore recovery counts/windows or health success telemetry.
      restored = true;
      persistenceStatus(true);
      if (state) savedState = JSON.stringify(state);
      publish();
    } catch (error) {
      persistenceStatus(false);
      restoreAfter = Number(now()) + retryAfterMs;
      reportError(error);
    } finally {
      restoring = false;
    }
  };

  const incidentSnapshot = () => incidentStartedAt === null || severity === null ? null : ({
    startedAt: new Date(incidentStartedAt).toISOString(),
    severity,
    alertedAt: alertedAt === null ? null : new Date(alertedAt).toISOString(),
    recoverySince: recoverySince === null ? null : new Date(recoverySince).toISOString(),
  });

  const clearIncident = () => {
    incidentStartedAt = null;
    severity = null;
    deliveredSeverity = null;
    alertedAt = null;
    recoverySince = null;
    recoveryCount = 0;
    recoveryLastAt = null;
    recoverySnapshotAt = null;
    nextAlertAt = 0;
    failureCount = 0;
    publish();
  };

  const deliver = async (kind, staleForMs, nextSeverity = severity) => {
    if (stopped || busy || typeof sendAlert !== "function") return;
    busy = true;
    try {
      // Checkpoint the attempt before transport. A crash/unknown delivery is
      // retried no sooner than the bounded retry interval, never in a tight loop.
      nextAlertAt = Number(now()) + retryAfterMs;
      await persist();
      if (stopped) return;
      if (kind === "stale" && alertedAt === null &&
          recoveryCount >= recoverySuccesses &&
          recoveryLastAt - recoverySince >= recoveryStableMs) {
        clearIncident();
        await persist();
        return;
      }
      await sendAlert({ kind, severity: nextSeverity, staleForMs });
      if (kind === "recovered") {
        try { onRecovered(); } catch {}
        clearIncident();
      } else {
        alertedAt = Number(now());
        deliveredSeverity = nextSeverity;
        recoverySince = null;
        recoveryCount = 0;
        recoveryLastAt = Number(now());
        recoverySnapshotAt = null;
      }
      nextAlertAt = 0;
      publish();
      await persist();
    } catch (error) {
      nextAlertAt = Number(now()) + retryAfterMs;
      publish();
      reportError(error);
    } finally {
      busy = false;
    }
  };

  const check = () => {
    if (stopped) return;
    if (!restored) {
      void restore();
      return;
    }
    const current = Number(now());
    const reference = lastHealthyAt ?? startedAt;
    const staleForMs = Math.max(0, current - reference);
    const stale = staleForMs > staleAfterMs;
    if (stale) {
      if (incidentStartedAt === null) {
        incidentStartedAt = reference;
        recoverySince = null;
        recoveryCount = 0;
        recoveryLastAt = null;
        recoverySnapshotAt = null;
      }
      if (recoverySince !== null) {
        recoverySince = null;
        recoveryCount = 0;
        recoveryLastAt = null;
        recoverySnapshotAt = null;
      }
      if (!staleReported) {
        staleReported = true;
        try { onStale(staleForMs); } catch {}
      }
      const targetSeverity = staleForMs >= criticalAfterMs
        ? "critical"
        : staleForMs >= warningAfterMs && failureCount >= warningFailureThreshold
          ? "warning" : null;
      if (targetSeverity) {
        const isEscalation = severity !== "critical" && targetSeverity === "critical";
        if (severity === null || (targetSeverity === "critical" && severity !== "critical")) {
          severity = targetSeverity;
        }
        const due = alertedAt === null || deliveredSeverity !== severity ||
          current - alertedAt >= repeatAfterMs;
        if (typeof sendAlert === "function" && (isEscalation || due) &&
            (isEscalation || current >= nextAlertAt) && !busy) {
          void deliver("stale", staleForMs, severity);
        }
      }
      publish();
      return;
    }
    staleReported = false;

    // A page that Telegram did not acknowledge remains pending through healthy
    // blips. Retry its delivery independently of the current freshness gap.
    const recoveryQualified = recoveryCount >= recoverySuccesses &&
      recoveryLastAt - recoverySince >= recoveryStableMs;
    if (recoveryQualified && alertedAt === null && !busy) {
      clearIncident();
      return;
    }
    if (!recoveryQualified && incidentStartedAt !== null && severity !== null &&
        (alertedAt === null || deliveredSeverity !== severity) &&
        typeof sendAlert === "function" && current >= nextAlertAt && !busy) {
      void deliver("stale", Math.max(0, current - incidentStartedAt), severity);
    }

    // A healthy blip does not clear a pending incident. Recovery requires two
    // complete snapshots admitted at least 30 seconds apart; callers only
    // invoke healthy() after all required durable queues accepted the snapshot.
    if (incidentStartedAt !== null && alertedAt !== null) {
      if (recoveryCount >= recoverySuccesses && recoveryLastAt - recoverySince >= recoveryStableMs &&
          !busy && current >= nextAlertAt) {
        void deliver("recovered", staleForMs, severity);
      }
    }
    publish();
  };

  const healthy = (snapshotTime) => {
    if (stopped || !restored) return;
    const current = Number(now());
    const staleForMs = Math.max(0, current - (lastHealthyAt ?? startedAt));
    const parsedSnapshotTime = typeof snapshotTime === "string" ? Date.parse(snapshotTime)
      : Number.isFinite(snapshotTime) ? Number(snapshotTime) : current;
    // Old/replayed snapshots cannot establish stable recovery.
    if (!Number.isFinite(parsedSnapshotTime) || parsedSnapshotTime > current + 30_000 ||
        current - parsedSnapshotTime > staleAfterMs) {
      recoverySince = null;
      recoveryCount = 0;
      recoveryLastAt = null;
      recoverySnapshotAt = null;
      check();
      return;
    }
    lastHealthyAt = Math.max(lastHealthyAt ?? 0, Math.min(current, parsedSnapshotTime));
    failureCount = 0;
    if (incidentStartedAt !== null) {
      if (recoverySince === null) {
        recoverySince = current;
        recoveryCount = 1;
        recoveryLastAt = current;
        recoverySnapshotAt = parsedSnapshotTime;
      } else if (current - recoveryLastAt >= recoveryStableMs &&
                 parsedSnapshotTime > recoverySnapshotAt) {
        recoveryCount += 1;
        recoveryLastAt = current;
        recoverySnapshotAt = parsedSnapshotTime;
      }
      const recoveryQualified = recoveryCount >= recoverySuccesses &&
        recoveryLastAt - recoverySince >= recoveryStableMs;
      if (recoveryQualified && alertedAt === null && !busy) {
        clearIncident();
      } else {
        check();
      }
    }
    publish();
    if (incidentStartedAt === null && staleForMs < warningAfterMs) {
      recoverySince = null;
      recoveryCount = 0;
      recoveryLastAt = null;
      recoverySnapshotAt = null;
    }
  };

  const failed = () => {
    if (stopped || !restored) return;
    failureCount += 1;
    recoverySince = null;
    recoveryCount = 0;
    recoveryLastAt = null;
    recoverySnapshotAt = null;
    check();
    publish();
  };

  const start = () => {
    if (stopped || timer !== null) return stop;
    timer = setIntervalFn(check, checkIntervalMs);
    timer?.unref?.();
    check();
    return stop;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearIntervalFn(timer);
    timer = null;
  };

  return {
    start,
    stop,
    healthy,
    failed,
    check,
    getIncident: incidentSnapshot,
    // Useful for orderly shutdown/tests; delivery awaits its own acknowledgement.
    flushPersistence: () => writes,
    getState: () => ({
      lastHealthyAt: lastHealthyAt === null ? null : new Date(lastHealthyAt).toISOString(),
      failureCount,
      incident: incidentSnapshot(),
    }),
  };
}