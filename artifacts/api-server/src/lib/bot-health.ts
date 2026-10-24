import type {
  BotHealthCheck, BotHealthMetric, BotHealthPolicy, BotHealthStatus,
  JournalBotHealth,
} from "@workspace/api-zod";

type WorkerTelemetry = {
  enabled: boolean;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastSuccessAt: string | null;
  lastDurationMs: number | null;
  lastOutcome: string | null;
  lastReason: string | null;
  inFlight: boolean;
  errorTicks: number;
  successfulTicks: number;
  stallAfterMs: number;
};
export type BotRuntimeTelemetry = {
  startedAt: string | null;
  source: {
    enabled: boolean;
    startedAt: string | null;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastSnapshotAt: string | null;
    lastDurationMs: number | null;
    totalPolls: number;
    totalFailures: number;
    consecutiveFailures: number;
    lastReason: string | null;
    lastHttpStatus: number | null;
    // Internal readiness only; the public API uses existing status/summary fields.
    incidentStateKnown?: boolean;
    incident: {
      startedAt: string;
      severity: "warning" | "critical";
      alertedAt: string | null;
      recoverySince: string | null;
    } | null;
    policy: {
      freshnessMs: number;
      warningAfterMs: number;
      criticalAfterMs: number;
      repeatMs: number;
      recoveryStableMs: number;
      recoverySuccesses: number;
    };
  };
  vst: WorkerTelemetry;
  paper: WorkerTelemetry;
};
type LedgerValues = {
  queued: number;
  queueOldestAt: Date | null;
  unresolved: number;
  unresolvedOldestAt: Date | null;
  unknownIntents: number;
  reviewPositions: number;
  pendingSourceExits: number;
  sourceExitOldestAt: Date | null;
  unsent: number;
  unsentOldestAt: Date | null;
};
export type LedgerHealth = { checkedAt: Date | null; values: LedgerValues | null };
type ReadPool = {
  query: (config: { text: string; query_timeout: number }) =>
    Promise<{ rows: Record<string, unknown>[] }>;
};

function date(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const result = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(result.getTime()) ? result : null;
}
function number(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}
function age(value: unknown, now: number): number | null {
  const timestamp = date(value)?.getTime();
  if (timestamp === undefined || timestamp > now + 30_000) return null;
  return Math.max(0, now - timestamp);
}
function metric(
  key: string, label: string, value: unknown, unit: BotHealthMetric["unit"],
  normalMax: number | null = null,
): BotHealthMetric {
  return { key, label, value: number(value), unit, normalMax };
}
function safeReason(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9_:-]{1,100}$/i.test(value)
    ? value : null;
}

// Read the same durable events the VST notifier drains, excluding internal
// measurements. A local aggregate is not an exchange/protection verification.
const LEDGER_SQL = `
  WITH queued AS (
    SELECT received_at FROM vst_signals s
    WHERE status IN ('pending', 'planning', 'opening')
      AND NOT EXISTS (
        SELECT 1 FROM vst_positions p WHERE p.source_signal_id = s.source_signal_id
      )
  ), unresolved AS (
    SELECT created_at, state FROM vst_order_intents
    WHERE state IN ('prepared', 'submitted', 'unknown')
  ), source_exits AS (
    SELECT created_at FROM vst_events requested
    WHERE kind = 'source_exit_requested'
      AND NOT EXISTS (
        SELECT 1 FROM vst_events completed
        WHERE completed.source_signal_id = requested.source_signal_id
          AND completed.kind = 'source_exit_completed'
          AND completed.detail->>'requestId' = requested.detail->>'requestId'
      )
  ), outbox AS (
    SELECT created_at FROM vst_events
    WHERE telegram_sent_at IS NULL AND kind <> 'vst_entry_queue_telemetry'
  )
  SELECT (SELECT count(*) FROM queued) AS queued,
    (SELECT min(received_at) FROM queued) AS queue_oldest_at,
    (SELECT count(*) FROM unresolved) AS unresolved,
    (SELECT min(created_at) FROM unresolved) AS unresolved_oldest_at,
    (SELECT count(*) FROM unresolved WHERE state = 'unknown') AS unknown_intents,
    (SELECT count(*) FROM vst_positions WHERE status IN ('error', 'unknown')) AS review_positions,
    (SELECT count(*) FROM source_exits) AS pending_source_exits,
    (SELECT min(created_at) FROM source_exits) AS source_exit_oldest_at,
    (SELECT count(*) FROM outbox) AS unsent,
    (SELECT min(created_at) FROM outbox) AS unsent_oldest_at`;

/** Coalesce visitors into one bounded read; failed reads stay explicitly unknown. */
export function createLedgerHealthReader(
  pool: ReadPool, { clock = Date.now, ttlMs = 10_000 } = {},
) {
  let cached: LedgerHealth | null = null;
  let cacheUntil = 0;
  let inFlight: Promise<LedgerHealth> | null = null;
  return async (): Promise<LedgerHealth> => {
    if (cached && clock() < cacheUntil) return cached;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const { rows } = await pool.query({ text: LEDGER_SQL, query_timeout: 3_000 });
        const row = rows[0];
        if (!row) throw new Error("bot_health_empty_aggregate");
        const counts = [
          row.queued, row.unresolved, row.unknown_intents, row.review_positions, row.unsent,
          row.pending_source_exits,
        ].map(number);
        if (counts.some((value) => value === null || !Number.isSafeInteger(value))) {
          throw new Error("bot_health_invalid_aggregate");
        }
        const [queued, unresolved, unknownIntents, reviewPositions, unsent,
          pendingSourceExits] = counts as number[];
        const values = {
          queued, unresolved, unknownIntents, reviewPositions, unsent,
          pendingSourceExits, sourceExitOldestAt: date(row.source_exit_oldest_at),
          queueOldestAt: date(row.queue_oldest_at),
          unresolvedOldestAt: date(row.unresolved_oldest_at),
          unsentOldestAt: date(row.unsent_oldest_at),
        };
        if ((queued > 0 && values.queueOldestAt === null) ||
            (unresolved > 0 && values.unresolvedOldestAt === null) ||
            (unsent > 0 && values.unsentOldestAt === null) ||
            (pendingSourceExits > 0 && values.sourceExitOldestAt === null)) {
          throw new Error("bot_health_missing_aggregate_timestamp");
        }
        cached = { checkedAt: new Date(clock()), values };
      } catch {
        cached = { checkedAt: null, values: null };
      }
      cacheUntil = clock() + ttlMs;
      return cached;
    })();
    try { return await inFlight; } finally { inFlight = null; }
  };
}

function workerCheck(
  key: string, title: string, worker: WorkerTelemetry, startedAt: unknown, now: number,
): BotHealthCheck {
  const limit = number(worker.stallAfterMs) || 120_000;
  const runningAge = worker.inFlight ? age(worker.lastStartedAt, now) : null;
  const finishedAge = age(worker.lastFinishedAt, now);
  const startAge = age(startedAt, now);
  let status: BotHealthStatus = "unknown";
  let summary = "Ещё нет измеренного цикла. Наличие процесса не доказывает работу обработчика.";
  if (!worker.enabled) {
    status = "paused";
    summary = "Этот обработчик отключён в текущем режиме.";
  } else if ((runningAge !== null && runningAge >= limit) ||
      (!worker.inFlight && (finishedAge ?? startAge ?? 0) >= limit)) {
    status = "critical";
    summary = "Цикл обработки превысил допустимое время или перестал завершаться.";
  } else if (worker.lastFinishedAt !== null) {
    const lastTickFailed = worker.lastOutcome === "error" ||
      (date(worker.lastSuccessAt)?.getTime() ?? -1) <
        (date(worker.lastFinishedAt)?.getTime() ?? 0);
    status = lastTickFailed || (worker.lastDurationMs ?? 0) >= limit
      ? "degraded" : "healthy";
    summary = status === "healthy"
      ? "Обработчик завершает циклы. Это не подтверждение исполнения каждого ордера."
      : "Последний цикл завершился ошибкой или был медленнее нормы.";
    const reason = safeReason(worker.lastReason);
    if (status === "degraded" && reason) summary += ` Код: ${reason}.`;
  }
  return {
    key, title, status, summary, lastSuccessAt: date(worker.lastSuccessAt),
    metrics: [
      metric("heartbeat_age", "С последнего завершённого цикла", finishedAge, "ms", limit),
      metric("cycle_duration", "Длительность последнего цикла", worker.lastDurationMs, "ms", limit),
      metric("in_flight_age", "Текущий незавершённый цикл", runningAge, "ms", limit),
      metric("successful_ticks", "Успешных циклов после запуска", worker.successfulTicks, "count"),
      metric("error_ticks", "Ошибок цикла после запуска", worker.errorTicks, "count"),
    ],
  };
}

export function buildBotHealth(
  runtime: BotRuntimeTelemetry, ledger: LedgerHealth,
  { now = Date.now(), production = false } = {},
): JournalBotHealth {
  const source = runtime.source;
  const policy: BotHealthPolicy = {
    sourceFreshnessMs: source.policy.freshnessMs,
    sourceWarningAfterMs: source.policy.warningAfterMs,
    sourceCriticalAfterMs: source.policy.criticalAfterMs,
    sourceWarningFailures: 3,
    repeatMs: source.policy.repeatMs,
    recoveryStableMs: source.policy.recoveryStableMs,
    recoverySuccesses: source.policy.recoverySuccesses,
    workerStallAfterMs: runtime.vst.stallAfterMs || 120_000,
    queueWarningAfterMs: 180_000,
    telegramWarningAfterMs: 180_000,
  };
  const successAge = age(source.lastSuccessAt, now);
  const snapshotAge = age(source.lastSnapshotAt, now);
  const sourceAge = successAge !== null || snapshotAge !== null
    ? Math.max(successAge ?? 0, snapshotAge ?? 0)
    : age(source.startedAt ?? runtime.startedAt, now);
  let sourceStatus: BotHealthStatus = source.enabled ? "unknown" : "paused";
  let sourceSummary = source.enabled
    ? "Свежий полный снимок ещё не подтверждён."
    : "Автоматическая синхронизация здесь отключена; это не сбой рабочего бота.";
  if (source.enabled && sourceAge !== null) {
    if (sourceAge >= policy.sourceCriticalAfterMs) {
      sourceStatus = "critical";
      sourceSummary = "Длительная потеря свежих данных. Обработка новых закрытий источника может задерживаться.";
    } else if (source.incidentStateKnown === false) {
      sourceStatus = "unknown";
      sourceSummary = "Состояние технических тревог ещё не восстановлено или не удалось его сохранить. Доставка health-уведомлений не подтверждена.";
    } else if (successAge !== null && successAge < policy.sourceFreshnessMs &&
        snapshotAge !== null && snapshotAge < policy.sourceFreshnessMs &&
        !source.incident && source.consecutiveFailures === 0) {
      sourceStatus = "healthy";
      sourceSummary = "Полный свежий снимок принят. Исполнение закрытий проверяется отдельно.";
    } else if (sourceAge >= policy.sourceFreshnessMs ||
        source.consecutiveFailures > 0 || source.incident) {
      sourceStatus = "degraded";
      sourceSummary = source.incident?.recoverySince
        ? "Данные снова поступают; ожидается подтверждение устойчивого восстановления."
        : "Краткий сбой или задержка. Одна минута ухудшает статус, но ещё не вызывает тревогу Telegram.";
    }
  }
  const checks: BotHealthCheck[] = [{
    key: "source", title: "Источник сигналов", status: sourceStatus,
    summary: sourceSummary, lastSuccessAt: date(source.lastSuccessAt),
    metrics: [
      metric("success_age", "С последнего принятого снимка", successAge, "ms", policy.sourceFreshnessMs),
      metric("snapshot_age", "Возраст данных источника", snapshotAge, "ms", policy.sourceFreshnessMs),
      metric("poll_duration", "Длительность последней попытки", source.lastDurationMs, "ms", 10_000),
      metric("consecutive_failures", "Ошибок подряд", source.consecutiveFailures, "count"),
      metric("last_http_status", "Последний HTTP-статус ошибки", source.lastHttpStatus, "http"),
      metric("polls", "Попыток после запуска", source.totalPolls, "count"),
      metric("failures", "Неуспешных попыток после запуска", source.totalFailures, "count"),
    ],
  }, workerCheck("vst_worker", "Обработчик VST", runtime.vst, runtime.startedAt, now),
  workerCheck("paper_worker", "Обработчик PAPER", runtime.paper, runtime.startedAt, now)];
  const values = ledger.values;
  const ledgerStatus: BotHealthStatus = !values ? "unknown"
    : runtime.vst.enabled ? "healthy" : "paused";
  const unknownSummary = "Не удалось прочитать журнал. Пустая очередь и нормальная работа не подтверждены.";
  const queueAge = values?.queued ? age(values.queueOldestAt, now) : values ? 0 : null;
  const intentAge = values?.unresolved ? age(values.unresolvedOldestAt, now) : values ? 0 : null;
  const outboxAge = values?.unsent ? age(values.unsentOldestAt, now) : values ? 0 : null;
  checks.push({
    key: "entry_queue", title: "Очередь входов VST",
    status: ledgerStatus === "healthy" && (queueAge ?? 0) >= policy.queueWarningAfterMs
      ? "degraded" : ledgerStatus,
    summary: !values ? unknownSummary : !runtime.vst.enabled
      ? "Исполнение VST отключено; ниже показан только сохранённый журнал."
      : values.queued ? "Есть ожидающие входы. Их ожидание измеряется отдельно от работы обработчика."
      : "Принятых сигналов, ожидающих входа, нет. Это не означает отсутствие новых сигналов у источника.",
    lastSuccessAt: ledger.checkedAt,
    metrics: [
      metric("queued", "Ожидающих входа сигналов", values?.queued, "count"),
      metric("oldest_wait", "Ожидание самого старого сигнала", queueAge, "ms", policy.queueWarningAfterMs),
    ],
  }, {
    key: "reconciliation", title: "Ордеры и сверка позиций",
    status: ledgerStatus !== "healthy" ? ledgerStatus
      : (values!.reviewPositions > 0 || (intentAge ?? 0) >= policy.workerStallAfterMs ||
          (age(values!.sourceExitOldestAt, now) ?? 0) >= policy.workerStallAfterMs)
        ? "critical" : values!.unknownIntents > 0 ? "degraded" : "healthy",
    summary: !values ? unknownSummary : !runtime.vst.enabled
      ? "VST отключён. Сохранённые операции ниже не являются свежей проверкой биржи."
      : values.pendingSourceExits > 0
        ? "Есть незавершённые заявки на выход от источника. Их отсутствие среди ордеров не означает, что очередь завершена."
        : values.reviewPositions > 0 || values.unknownIntents > 0
        ? "Есть позиции или операции, требующие сверки. Защита и фактический результат не подтверждаются этим экраном."
        : values.unresolved
          ? "Идёт исполнение или сверка. Ненулевое число операций допустимо в пределах времени цикла."
          : "В журнале нет незавершённых операций или позиций со статусом ошибки/неопределённости.",
    lastSuccessAt: ledger.checkedAt,
    metrics: [
      metric("unresolved", "Незавершённых операций", values?.unresolved, "count"),
      metric("unresolved_age", "Возраст старейшей операции", intentAge, "ms", policy.workerStallAfterMs),
      metric("unknown_intents", "Операций с неопределённым результатом", values?.unknownIntents, "count", 0),
      metric("review_positions", "Позиций, требующих проверки", values?.reviewPositions, "count", 0),
      metric("pending_source_exits", "Незавершённых заявок источника на выход", values?.pendingSourceExits, "count"),
      metric("source_exit_age", "Возраст старейшей заявки на выход",
        age(values?.sourceExitOldestAt, now), "ms", policy.workerStallAfterMs),
    ],
  }, {
    key: "telegram_outbox", title: "Telegram · события VST",
    status: ledgerStatus === "healthy" && (outboxAge ?? 0) >= policy.telegramWarningAfterMs
      ? "degraded" : ledgerStatus,
    summary: !values ? unknownSummary : !runtime.vst.enabled
      ? "Доставка VST-событий отключена в этом режиме."
      : values.unsent ? "Есть ещё не подтверждённые отправки. Краткое ожидание допустимо."
      : "Все события VST в журнале отмечены отправленными. Прямые системные тревоги учитываются отдельно.",
    lastSuccessAt: ledger.checkedAt,
    metrics: [
      metric("unsent", "Событий, ожидающих отправки", values?.unsent, "count"),
      metric("unsent_age", "Возраст старейшего сообщения", outboxAge, "ms", policy.telegramWarningAfterMs),
    ],
  });
  const status: BotHealthStatus = checks.some((check) => check.status === "critical") ? "critical"
    : checks.some((check) => check.status === "degraded") ? "degraded"
      : checks.some((check) => check.status === "unknown") ? "unknown"
        : checks.every((check) => check.status === "paused") ? "paused" : "healthy";
  const summaries = {
    healthy: "Активные компоненты работают в пределах нормы. Исполнение и защиту отдельных сделок нужно проверять отдельно.",
    degraded: "Есть задержка или незавершённая сверка. Не каждая такая ситуация требует сообщения Telegram.",
    critical: "Есть затяжная проблема или состояние, требующее проверки.",
    unknown: "Для части компонентов нет достоверных измерений. Нормальная работа не подтверждена.",
    paused: "Обработчики отключены в текущем режиме.",
  };
  return {
    asOf: new Date(now), startedAt: date(runtime.startedAt),
    environment: production ? "production" : "preview",
    status, summary: summaries[status], freshnessMs: 30_000, readOnly: true, checks,
    incidents: source.enabled && source.incident ? [{
      component: "source", severity: source.incident.severity,
      startedAt: date(source.incident.startedAt)!,
      alertedAt: date(source.incident.alertedAt),
      recoverySince: date(source.incident.recoverySince),
    }] : [],
    policy,
  };
}