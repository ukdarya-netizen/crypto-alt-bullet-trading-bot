let status = {
  state: "pending",
  checkedAt: null,
  lastSuccessAt: null,
  reason: null,
};

export function getSourceSyncStatus() {
  return { ...status };
}

export function reportSourceSyncSuccess() {
  const now = new Date().toISOString();
  status = { state: "ok", checkedAt: now, lastSuccessAt: now, reason: null };
}

export function reportSourceSyncStart() {
  // Keep an established degraded state visible while another poll is running;
  // a request starting is not evidence that the source has recovered.
  if (status.lastSuccessAt !== null || status.state === "error") {
    status = { ...status, checkedAt: new Date().toISOString() };
    return;
  }
  status = {
    ...status,
    state: "pending",
    checkedAt: new Date().toISOString(),
    reason: null,
  };
}

export function reportSourceSyncFailure(reason) {
  status = {
    ...status,
    state: "error",
    checkedAt: new Date().toISOString(),
    reason,
  };
}