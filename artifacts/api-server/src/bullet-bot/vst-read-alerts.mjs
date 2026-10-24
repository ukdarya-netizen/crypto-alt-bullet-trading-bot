import { vstReadIncidentKey } from "./vst-diagnostics.mjs";

// Recovery is notification evidence only, never permission for an exchange
// action. Skipped ticks and incomplete reads cannot contribute a success.
export function createVstReadRecoveryTracker({
  now = Date.now, stableMs = 120_000, successes = 3,
} = {}) {
  const incidents = new Map();
  return {
    failed(id) {
      incidents.set(id, { since: null, lastAt: null, successes: 0 });
    },
    recovered(id) {
      const incident = incidents.get(id);
      if (!incident) return true;
      const at = Number(now());
      if (!Number.isFinite(at)) return false;
      if (incident.since === null || at < incident.lastAt ||
          at - incident.lastAt > stableMs) {
        incident.since = at;
        incident.successes = 0;
      }
      if (incident.lastAt !== at) incident.successes += 1;
      incident.lastAt = at;
      if (incident.successes < successes || at - incident.since < stableMs) return false;
      incidents.delete(id);
      return true;
    },
    forget(id) { incidents.delete(id); },
  };
}

// Notification-only state. Never infer recovery from an omitted/skipped tick,
// changed cause, leader-lock wait, or a failed list/read.
export function createVstReadAlertAggregator({
  send, now = Date.now, repeatAfterMs = 30 * 60_000,
  blockedAfterMs = 5 * 60_000, maxGroups = 256,
} = {}) {
  const groups = new Map();
  async function deliver(group, status) {
    const members = [...group.members.values()];
    const info = {
      reason: "vst_read_incident", incidentStatus: status,
      scope: "symbol_read_only", incidentKey: group.key,
      blockedForMs: now() - group.since, occurrences: group.occurrences,
      symbols: [...group.symbols].sort(),
      activeSymbols: [...new Set(members.map((m) => m.symbol))].sort(),
      diagnosticRefs: [...group.refs],
      diagnostic: group.diagnostic,
    };
    try {
      await send(info);
      group.lastSentAt = now();
      group.announced = true;
      return true;
    } catch {
      // Retry notification on a later tick; never retry an exchange operation.
      return false;
    }
  }
  return {
    async report(issues, recoveredIds = []) {
      const handled = new Set();
      const touched = new Set();
      for (const issue of issues) {
        // The complete safe object is captured at the failing read. A ref is
        // not a unique context key: identical text can fail at different APIs.
        const diagnostic = issue.diagnostic;
        const key = vstReadIncidentKey(diagnostic, issue);
        for (const [oldKey, oldGroup] of groups) {
          if (oldKey !== key && oldGroup.members.delete(issue.sourceSignalId)) {
            oldGroup.changed = true;
          }
        }
        if (!key) continue;
        let group = groups.get(key);
        // Capacity exhaustion fails open to the independent warning path.
        if (!group && groups.size >= maxGroups) continue;
        if (!group) {
          group = { key, diagnostic, since: now() - issue.blockedForMs,
            occurrences: 0, symbols: new Set(), refs: new Set(),
            members: new Map(), lastSentAt: null, announced: false };
          groups.set(key, group);
        }
        group.since = Math.min(group.since, now() - issue.blockedForMs);
        group.members.set(issue.sourceSignalId, { symbol: issue.symbol });
        group.symbols.add(issue.symbol);
        // Keep bounded log links; structured logs retain the individual events.
        if (group.refs.size < 20) group.refs.add(diagnostic.ref);
        group.occurrences += 1;
        touched.add(key);
        handled.add(issue.sourceSignalId);
      }
      for (const [key, group] of groups) {
        for (const id of recoveredIds) group.members.delete(id);
        if (!group.members.size) {
          if (!group.announced ||
              await deliver(group, group.changed ? "changed" : "recovered")) groups.delete(key);
          continue;
        }
        if (!touched.has(key) || now() - group.since < blockedAfterMs) continue;
        if (group.lastSentAt === null || now() - group.lastSentAt >= repeatAfterMs) {
          await deliver(group, group.announced ? "summary" : "first");
        }
      }
      return handled;
    },
  };
}