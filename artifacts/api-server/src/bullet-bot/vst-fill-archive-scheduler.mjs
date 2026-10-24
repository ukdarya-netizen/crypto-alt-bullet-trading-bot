const HOUR_MS = 60 * 60 * 1_000;
const INITIAL_LOOKBACK_MS = 6 * 24 * 60 * 60 * 1_000;
const EXCHANGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const FIXED_TAIL_MS = 60_000;
const REFRESH_INTERVAL_MS = 5 * 60_000;
const REFRESH_LOOKBACK_MS = 24 * 60 * 60_000;
const CATCHUP_INTERVAL_MS = 15_000;
const CURRENT_INTERVAL_MS = 60_000;
const MAX_CALLS_PER_CYCLE = 24;
const MAX_CAPTURE_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_000;

function fail(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function missingRelationError(error) {
  if (String(error?.code ?? "") !== "42P01") return null;
  const detail = error instanceof Error ? error.message : String(error);
  return fail(
    "fill_archive_schema_not_ready",
    `PostgreSQL reports a missing VST fill archive relation (${detail}). ` +
      "For managed production databases, apply the development schema with Publish.",
  );
}

function cursorTimestamp(value) {
  if (value == null) return null;
  const timestamp = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw fail("fill_archive_cursor_invalid");
  }
  return timestamp;
}

function isSaturation(error) {
  return /saturat/i.test(`${error?.code ?? ""} ${error?.message ?? ""}`);
}

function invalidationReason(error) {
  const detail = `${error?.code ?? ""} ${error?.message ?? ""}`;
  if (isSaturation(error)) return "fill_history_saturated";
  if (/snapshot[_\s-]*changed/i.test(detail)) return "fill_history_snapshot_changed";
  if (/(?:conflict.*(?:trade|fill|identity|identifier)|(?:trade|fill|identity|identifier).*conflict|duplicate_fill|identity_mismatch|identifier_mismatch)/i.test(detail)) {
    return "fill_archive_raw_identity_conflict";
  }
  return null;
}

function assertWindow(window, { accountId, currency, startTs, endTs }) {
  const coverage = window?.coverage;
  if (!window || window.environment !== "vst" || window.accountId !== accountId ||
      window.currency !== currency || !coverage || coverage.verified !== true ||
      Number(coverage.startTs) !== startTs || Number(coverage.endTs) !== endTs ||
      coverage.currency !== currency || !Array.isArray(window.rawFills) ||
      !Array.isArray(window.orders) || typeof window.archivedAt !== "string" ||
      !Number.isFinite(Date.parse(window.archivedAt))) {
    throw fail("fill_archive_window_unverified");
  }
}

/**
 * Independently archives verified VST fill history. Every successful save
 * covers exactly the next contiguous interval; any error leaves the cursor in
 * place so the failed interval is retried on a later cycle.
 */
export function createVstFillArchiveScheduler({
  broker,
  store,
  accountId,
  currency = "USDT",
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  maxCallsPerCycle = MAX_CALLS_PER_CYCLE,
  maxCaptureAttempts = MAX_CAPTURE_ATTEMPTS,
  retryDelayMs = RETRY_DELAY_MS,
  checkSchema,
  onError = () => {},
  onRecovery = () => {},
  onProgress = () => {},
}) {
  if (!broker || typeof broker.captureFillArchiveWindow !== "function") {
    throw new TypeError("broker.captureFillArchiveWindow is required");
  }
  if (!store || typeof store.saveFillArchiveWindow !== "function" ||
      typeof store.getFillArchiveCursor !== "function") {
    throw new TypeError("VST fill archive store methods are required");
  }
  if (typeof accountId !== "string" || accountId.trim() === "") {
    throw new TypeError("accountId must be a stable VST account alias");
  }
  if (currency !== "USDT") throw new TypeError("VST fill archive currency must be USDT");
  if (!Number.isSafeInteger(maxCallsPerCycle) || maxCallsPerCycle < 1 ||
      !Number.isSafeInteger(maxCaptureAttempts) || maxCaptureAttempts < 1 ||
      !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new TypeError("fill archive bounds must be positive integers");
  }

  let stopped = false;
  let running = false;
  let started = false;
  let timer = null;
  let retryTimer = null;
  let retryResolve = null;
  let lastRefreshAt = Number(now());
  let lastRefreshedWindow = null;
  let schemaDegradedKey = null;

  const reportError = (error, details = {}) => {
    if (stopped) return;
    const schemaError = missingRelationError(error) ?? error;
    if (schemaError?.code === "fill_archive_schema_not_ready" ||
        schemaError?.code === "fill_archive_schema_preflight_failed") {
      const key = `${schemaError.code}:${schemaError.message}`;
      if (schemaDegradedKey === key) return;
      schemaDegradedKey = key;
    }
    try { onError({ error: schemaError, code: schemaError?.code ?? null, ...details }); } catch {}
  };

  const markSchemaReady = () => {
    if (schemaDegradedKey === null) return;
    const previous = schemaDegradedKey;
    schemaDegradedKey = null;
    try {
      onRecovery({
        code: "fill_archive_schema_recovered",
        previousIncident: previous,
      });
    } catch {}
  };

  const delay = () => new Promise((resolve) => {
    retryResolve = resolve;
    retryTimer = setTimeoutFn(() => {
      retryTimer = null;
      retryResolve = null;
      resolve();
    }, retryDelayMs);
    retryTimer?.unref?.();
  });

  const getCursor = async (bootstrapAt) => {
    const cursor = cursorTimestamp(await store.getFillArchiveCursor({ accountId, currency }));
    return cursor ?? bootstrapAt;
  };

  const invalidateIfUntrusted = async (error, interval) => {
    const reason = invalidationReason(error);
    if (!reason) return;
    if (typeof store.invalidateFillArchiveWindows !== "function") {
      throw fail("fill_archive_invalidation_unavailable",
        `Cannot invalidate untrusted fill archive windows after ${reason}`);
    }
    await store.invalidateFillArchiveWindows({
      accountId,
      currency,
      startTs: interval.startTs,
      endTs: interval.endTs,
      reason,
    });
  };

  async function pollNow() {
    if (stopped) return { kind: "stopped" };
    if (running) return { kind: "in_flight" };
    running = true;
    let calls = 0;
    let failed = false;
    let schemaUnavailable = false;
    let saved = 0;
    const cycleNow = Number(now());
    const endLimit = cycleNow - FIXED_TAIL_MS;
    const bootstrapAt = cycleNow - INITIAL_LOOKBACK_MS;
    const earliestSafeStart = cycleNow - EXCHANGE_RETENTION_MS;
    try {
      if (typeof checkSchema === "function") {
        try {
          const readiness = await checkSchema();
          if (readiness !== true && readiness?.ready !== true) {
            const missing = Array.isArray(readiness?.missing)
              ? readiness.missing.join(", ")
              : "required archive tables or columns";
            throw fail(
              "fill_archive_schema_not_ready",
              `VST fill archive schema is not ready; missing: ${missing}. ` +
                "For managed production databases, apply the development schema with Publish.",
            );
          }
          markSchemaReady();
        } catch (error) {
          let readinessError = error;
          if (error?.code !== "fill_archive_schema_not_ready") {
            const databaseCode = typeof error?.code === "string"
              ? ` (SQLSTATE ${error.code})`
              : "";
            readinessError = fail(
              "fill_archive_schema_preflight_failed",
              `Read-only VST fill archive schema preflight failed${databaseCode}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            readinessError.databaseCode = error?.code ?? null;
            readinessError.cause = error;
          }
          reportError(readinessError, { schemaReadiness: true, startTs: null });
          failed = true;
          schemaUnavailable = true;
        }
      }
      while (!stopped && !schemaUnavailable && calls < maxCallsPerCycle) {
        let startTs;
        try {
          startTs = await getCursor(bootstrapAt);
        } catch (error) {
          reportError(error, { startTs: null });
          failed = true;
          break;
        }
        if (startTs < earliestSafeStart) {
          reportError(fail("fill_archive_retention_gap",
            `fill archive cursor ${startTs} predates safe retention boundary ${earliestSafeStart}`),
          { startTs, endTs: endLimit });
          failed = true;
          break;
        }
        if (startTs >= endLimit) break;

        // A work stack lets a saturated interval be replaced by its exact
        // oldest-first halves without ever advancing over the parent interval.
        const work = [{ startTs, endTs: Math.min(startTs + HOUR_MS, endLimit) }];
        while (!stopped && work.length && calls < maxCallsPerCycle) {
          const interval = work.shift();
          let window;
          let lastError;
          for (let attempt = 0; attempt < maxCaptureAttempts &&
              calls < maxCallsPerCycle && !stopped; attempt += 1) {
            calls += 1;
            try {
              window = await broker.captureFillArchiveWindow({
                startTs: interval.startTs,
                endTs: interval.endTs,
                currency,
              });
              break;
            } catch (error) {
              lastError = missingRelationError(error) ?? error;
              if (lastError.code === "fill_archive_schema_not_ready") break;
              try {
                await invalidateIfUntrusted(error, interval);
              } catch (invalidationError) {
                lastError = invalidationError;
                break;
              }
              if (isSaturation(error)) break;
              if (attempt + 1 < maxCaptureAttempts &&
                  calls < maxCallsPerCycle) await delay();
            }
          }
          if (stopped) break;
          if (lastError && !window) {
            if (isSaturation(lastError)) {
              if (interval.endTs - interval.startTs <= 1) {
                reportError(fail("fill_archive_minimum_window_saturated",
                  `fill archive remained saturated at 1ms: ${interval.startTs}-${interval.endTs}`),
                interval);
                failed = true;
                break;
              }
              const midpoint = interval.startTs +
                Math.floor((interval.endTs - interval.startTs) / 2);
              // Queue the earlier half first; together they exactly partition
              // (startTs, endTs] and neither skips nor duplicates a boundary.
              work.unshift(
                { startTs: midpoint, endTs: interval.endTs },
              );
              work.unshift(
                { startTs: interval.startTs, endTs: midpoint },
              );
              continue;
            }
            reportError(lastError, interval);
            failed = true;
            break;
          }
          try {
            assertWindow(window, { accountId, currency, ...interval });
            if (!Object.isFrozen(window)) {
              throw fail("fill_archive_window_mutable");
            }
            if (stopped) break;
            try {
              await store.saveFillArchiveWindow(window);
            } catch (error) {
              await invalidateIfUntrusted(error, interval);
              throw error;
            }
            const persistedCursor = cursorTimestamp(
              await store.getFillArchiveCursor({ accountId, currency }),
            );
            if (persistedCursor === null || persistedCursor < interval.endTs) {
              throw fail("fill_archive_cursor_did_not_advance",
                `fill archive save did not advance contiguous cursor to ${interval.endTs}`);
            }
            saved += 1;
            try { onProgress({ ...interval, saved, calls }); } catch {}
          } catch (error) {
            reportError(error, interval);
            failed = true;
            break;
          }
        }
        if (failed || stopped || work.length) break;
        // Re-read the durable contiguous cursor; never infer progress from the
        // requested interval if persistence did not commit it.
      }

      // A complete two-pass capture proves a stable snapshot within one
      // request. Periodically re-observe the most recent completed window as
      // well, so late history changes are not hidden by an old cursor.
      if (!stopped && !failed && calls < maxCallsPerCycle &&
          typeof store.listFillArchiveWindows === "function" &&
          cycleNow - lastRefreshAt >= REFRESH_INTERVAL_MS) {
        lastRefreshAt = cycleNow;
        try {
          const refreshCursor = cursorTimestamp(
            await store.getFillArchiveCursor({ accountId, currency }),
          );
          if (refreshCursor !== null && refreshCursor >= endLimit) {
            const windows = await store.listFillArchiveWindows({
              accountId,
              currency,
              startTs: Math.max(1, refreshCursor - REFRESH_LOOKBACK_MS),
              endTs: refreshCursor,
            });
            if (!Array.isArray(windows)) {
              throw fail("fill_archive_refresh_windows_invalid");
            }
            const uniqueWindows = new Map();
            for (const item of windows) {
              const start = Number(item?.coverage?.startTs);
              const end = Number(item?.coverage?.endTs);
              if (Number.isSafeInteger(start) && start > 0 &&
                  Number.isSafeInteger(end) && end > start && end <= refreshCursor) {
                uniqueWindows.set(`${start}:${end}`, { startTs: start, endTs: end });
              }
            }
            const candidates = [...uniqueWindows.entries()]
              .filter(([, interval]) =>
                interval.startTs >= Math.max(1, refreshCursor - REFRESH_LOOKBACK_MS))
              .sort(([, left], [, right]) =>
                left.startTs - right.startTs || left.endTs - right.endTs);
            if (candidates.length === 0) {
              throw fail("fill_archive_refresh_window_missing");
            }
            let refreshIndex = lastRefreshedWindow === null
              ? 0
              : candidates.findIndex(([, interval]) =>
                interval.startTs > lastRefreshedWindow.startTs ||
                (interval.startTs === lastRefreshedWindow.startTs &&
                 interval.endTs > lastRefreshedWindow.endTs));
            if (refreshIndex < 0) refreshIndex = 0;
            const [, selectedInterval] = candidates[refreshIndex];
            const work = [selectedInterval];
            while (!stopped && work.length && calls < maxCallsPerCycle) {
              const interval = work.shift();
              let window;
              let lastError;
              for (let attempt = 0; attempt < maxCaptureAttempts &&
                  calls < maxCallsPerCycle && !stopped; attempt += 1) {
                calls += 1;
                try {
                  window = await broker.captureFillArchiveWindow({
                    ...interval, currency,
                  });
                  break;
                } catch (error) {
                  lastError = missingRelationError(error) ?? error;
                  if (lastError.code === "fill_archive_schema_not_ready") break;
                  try {
                    await invalidateIfUntrusted(error, interval);
                  } catch (invalidationError) {
                    lastError = invalidationError;
                    break;
                  }
                  if (isSaturation(error)) break;
                  if (attempt + 1 < maxCaptureAttempts &&
                      calls < maxCallsPerCycle) await delay();
                }
              }
              if (stopped) break;
              if (!window) {
                if (lastError && isSaturation(lastError) &&
                    interval.endTs - interval.startTs > 1) {
                  const midpoint = interval.startTs +
                    Math.floor((interval.endTs - interval.startTs) / 2);
                  work.unshift(
                    { startTs: interval.startTs, endTs: midpoint },
                    { startTs: midpoint, endTs: interval.endTs },
                  );
                  continue;
                }
                throw lastError ??
                  (calls >= maxCallsPerCycle
                    ? fail("fill_archive_refresh_call_budget_exhausted")
                    : fail("fill_archive_capture_empty"));
              }
              assertWindow(window, { accountId, currency, ...interval });
              if (!Object.isFrozen(window)) throw fail("fill_archive_window_mutable");
              try {
                await store.saveFillArchiveWindow(window);
              } catch (error) {
                await invalidateIfUntrusted(error, interval);
                throw error;
              }
              saved += 1;
              try { onProgress({ ...interval, saved, calls, refresh: true }); } catch {}
            }
            if (!stopped && work.length === 0) {
              const refreshedCursor = cursorTimestamp(
                await store.getFillArchiveCursor({ accountId, currency }),
              );
              if (refreshedCursor === null || refreshedCursor < refreshCursor) {
                throw fail("fill_archive_refresh_changed_cursor");
              }
              lastRefreshedWindow = selectedInterval;
            }
          }
        } catch (error) {
          reportError(error, { refresh: true, startTs: null, endTs: endLimit });
          failed = true;
        }
      }
    } finally {
      running = false;
    }
    if (stopped) return { kind: "stopped", calls, saved };
    if (schemaUnavailable) {
      return { kind: "error", calls, saved, caughtUp: false };
    }
    const cursor = schemaDegradedKey === null
      ? await getCursor(bootstrapAt).catch(() => null)
      : null;
    const caughtUp = cursor !== null && cursor >= endLimit;
    return { kind: failed ? "error" : "ok", calls, saved, caughtUp };
  }

  function schedule(delayMs) {
    if (stopped) return;
    timer = setTimeoutFn(() => {
      timer = null;
      void pollNow().then((result) => {
        if (!stopped) schedule(result.caughtUp ? CURRENT_INTERVAL_MS : CATCHUP_INTERVAL_MS);
      }).catch((error) => {
        reportError(error);
        schedule(CATCHUP_INTERVAL_MS);
      });
    }, delayMs);
    timer?.unref?.();
  }

  function start() {
    if (stopped || started) return stop;
    started = true;
    void pollNow().then((result) => {
      if (!stopped) schedule(result.caughtUp ? CURRENT_INTERVAL_MS : CATCHUP_INTERVAL_MS);
    }).catch((error) => {
      reportError(error);
      schedule(CATCHUP_INTERVAL_MS);
    });
    return stop;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearTimeoutFn(timer);
    if (retryTimer !== null) clearTimeoutFn(retryTimer);
    retryResolve?.();
    timer = null;
    retryTimer = null;
    retryResolve = null;
  }

  return { start, stop, pollNow };
}