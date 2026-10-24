/**
 * Preview and publication share the source credential. Only the publication
 * subscribes automatically by default; preview polling is an explicit opt-in.
 */
export function sourcePollingPolicy(configuration = {}) {
  if (configuration.NODE_ENV === "production") {
    return { enabled: true, reason: null };
  }
  if (configuration.BULLET_SOURCE_SYNC_ALLOW_DEVELOPMENT === "true") {
    return { enabled: true, reason: null };
  }
  return { enabled: false, reason: "source_sync_disabled_outside_production" };
}

/**
 * Do not log request URLs, headers, response bodies, arbitrary error messages
 * or causes. These reviewed scalars explain the failed read without credentials.
 */
export function sourceFailureMetadata(error) {
  const result = {};
  const integer = (value, min, max) =>
    Number.isSafeInteger(value) && value >= min && value <= max;
  if (integer(error?.httpStatus, 400, 599)) result.httpStatus = error.httpStatus;
  if (["transport", "http", "body", "validation"].includes(error?.failureStage)) {
    result.failureStage = error.failureStage;
  }
  if (integer(error?.pageNumber, 1, 100)) result.page = error.pageNumber;
  if (integer(error?.attempts, 1, 2)) result.attempts = error.attempts;
  if (integer(error?.retryAfterMs, 0, 300_000)) {
    result.retryAfterMs = error.retryAfterMs;
  }
  return result;
}