export function createIndependentWorkerTickScheduler({
  runVst,
  runPaper,
  vstTickWatchdog,
  onVstError = () => {},
  onPaperError = () => {},
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  intervalMs = 300,
}) {
  const timers = [];
  let vstBusy = false;
  let paperBusy = false;
  let stopped = false;
  const drainWaiters = [];
  const notifyIdle = () => {
    if (!vstBusy && !paperBusy) {
      for (const resolve of drainWaiters.splice(0)) resolve();
    }
  };
  let vstWakePending = false;
  let scheduleVstWake = () => {};

  const schedule = (tick) => {
    const handle = setIntervalFn(tick, intervalMs);
    handle?.unref?.();
    timers.push(handle);
  };

  if (typeof runVst === "function") {
    const runVstTick = async () => {
      if (stopped || vstBusy) return;
      vstWakePending = false;
      vstBusy = true;
      try {
        vstTickWatchdog?.begin();
        await runVst();
      } catch (error) {
        vstTickWatchdog?.reportError?.(error);
        onVstError(error);
      } finally {
        try {
          vstTickWatchdog?.complete();
        } finally {
          vstBusy = false;
          notifyIdle();
        }
      }
      if (!stopped && vstWakePending) void runVstTick();
    };
    scheduleVstWake = () => {
      if (stopped || vstWakePending) return;
      vstWakePending = true;
      if (!vstBusy) {
        // Coalesce multiple enqueue notifications into one immediate tick.
        Promise.resolve().then(runVstTick);
      }
    };
    schedule(async () => {
      if (stopped) return;
      if (vstBusy) {
        vstTickWatchdog?.check();
        return;
      }
      await runVstTick();
    });
  }

  if (typeof runPaper === "function") {
    schedule(async () => {
      if (stopped || paperBusy) return;
      paperBusy = true;
      try {
        await runPaper();
      } catch (error) {
        onPaperError(error);
      } finally {
        paperBusy = false;
        notifyIdle();
      }
    });
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    vstWakePending = false;
    for (const handle of timers) clearIntervalFn(handle);
  };
  // The returned function remains the historical stop handle; the additional
  // method lets durable source-exit enqueues wake this same single-flight VST
  // worker without creating a parallel runner.
  stop.wakeVst = () => {
    if (stopped || typeof runVst !== "function") return false;
    scheduleVstWake();
    return true;
  };
  stop.drain = async () => {
    stop();
    if (vstBusy || paperBusy) {
      await new Promise(resolve => drainWaiters.push(resolve));
    }
  };
  return stop;
}