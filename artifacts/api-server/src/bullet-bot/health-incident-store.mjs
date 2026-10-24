// One versioned checkpoint per technical monitor. Never append trading events.
export function validateHealthCheckpoint(state) {
  if (!state || state.version !== 1) throw new TypeError("Invalid health checkpoint version");
  if (state.incident === null) return { version: 1, incident: null };
  const i = state.incident;
  const time = (n) => Number.isSafeInteger(n) && n >= 0;
  const severity = (s) => s === null || s === "warning" || s === "critical";
  if (!i || !time(i.startedAt) || !time(i.referenceAt) ||
      !severity(i.severity) || !severity(i.deliveredSeverity) ||
      !(i.alertedAt === null || time(i.alertedAt)) || !time(i.nextAlertAt) ||
      !Number.isSafeInteger(i.failureCount) || i.failureCount < 0 ||
      (i.alertedAt === null) !== (i.deliveredSeverity === null) ||
      (i.deliveredSeverity !== null && i.severity === null) ||
      (i.deliveredSeverity === "critical" && i.severity !== "critical")) {
    throw new TypeError("Invalid health incident checkpoint");
  }
  return { version: 1, incident: {
    startedAt: i.startedAt, referenceAt: i.referenceAt, severity: i.severity,
    deliveredSeverity: i.deliveredSeverity, alertedAt: i.alertedAt,
    nextAlertAt: i.nextAlertAt, failureCount: i.failureCount,
  } };
}

export function createHealthIncidentStore(pool) {
  const key = "source-freshness";
  return {
    async load() {
      const result = await pool.query(
        { text: "SELECT state FROM bot_health_incidents WHERE key = $1",
          values: [key], query_timeout: 5_000 },
      );
      return result.rows.length ? validateHealthCheckpoint(result.rows[0].state) : null;
    },
    async save(state) {
      const validated = validateHealthCheckpoint(state);
      await pool.query(
        { text: `INSERT INTO bot_health_incidents (key, state) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
          values: [key, JSON.stringify(validated)], query_timeout: 5_000 },
      );
    },
  };
}