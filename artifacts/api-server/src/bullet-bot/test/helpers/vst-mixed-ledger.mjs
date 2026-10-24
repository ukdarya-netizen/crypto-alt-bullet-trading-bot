import assert from "node:assert/strict";
import { EPOCH } from "./vst-mixed-load.mjs";

// Deliberately only persistence is substituted: worker, policy, sizing,
// broker, signed native adapter and shared pacer are production modules.
export function mixedLedger() {
  const signal = {
    sourceSignalId: "mixed-worker-entry", symbol: "DOGEUSDT",
    confirmationStatus: "confirmed", patternStatus: "approved",
    patternId: "balanced_grind", side: "buy", orderType: "market",
    signalAt: new Date(EPOCH).toISOString(), referencePrice: "100", stopLoss: "98",
    payload: {
      rulesVersion: "bullet-long-exits-v2",
      exitRules: {
        priceMoveBasis: "unleveraged_percent_from_actual_entry_fill",
        noFixedTakeProfit: true, rMultipleTargets: false,
        firstTargetAction: "milestone_not_full_close", firstTargetPct: 10,
        breakevenAtPct: 5, breakevenStopGainPct: 0, breakevenIncludesFees: false,
        protectedProfitAtPct: 10, protectedProfitPct: 5,
        trailingActivationPct: 15, trailingGapPercentagePoints: 10,
        trailingGapBasis: "percentage_points_of_entry_pnl", trailingStopNeverDecreases: true,
        trailingExitAction: "close_remaining_position", maxWatchDays: 4,
        expiryExitPrice: "observed_market_quote",
        partialProfitAdvice: {
          execution: "advice_only_not_automated", minFraction: 0.2, maxFraction: 0.25,
        },
      },
    },
  };
  const candidate = { sourceSignalId: signal.sourceSignalId, body: signal,
    status: "pending", receivedAt: new Date(EPOCH).toISOString() };
  const intents = [];
  const events = [];
  return {
    candidate, intents, events,
    async withLeaderLock(fn) { return fn(); },
    async getPending() {
      return ["pending", "planning", "opening"].includes(candidate.status) ? candidate : null;
    },
    async listUnresolvedIntents() {
      return intents.filter(row => ["prepared", "submitted", "unknown"].includes(row.state));
    },
    async getIntent(id, phase) {
      return intents.find(row => row.sourceSignalId === id && row.phase === phase) ?? null;
    },
    async reserveIntent(intent) {
      const existing = await this.getIntent(intent.sourceSignalId, intent.phase);
      if (existing) return { kind: "existing", intent: existing };
      const row = structuredClone({ ...intent, state: "prepared" });
      intents.push(row);
      return { kind: "new", intent: row };
    },
    async markIntent(clientOrderId, state, detail = {}) {
      const row = intents.find(intent => intent.clientOrderId === clientOrderId);
      assert.ok(row, "intent must be durable before submission");
      Object.assign(row, { state, ...structuredClone(detail) });
    },
    async setSignalStatus(id, status, reason) {
      assert.equal(id, signal.sourceSignalId);
      Object.assign(candidate, { status, reason });
    },
    async refreshPendingEntryIntent({ clientOrderId, expectedRequest, request }) {
      const row = intents.find(intent => intent.clientOrderId === clientOrderId);
      assert.equal(row.state, "submitted");
      assert.deepEqual(row.request, expectedRequest);
      row.request = structuredClone(request);
      return true;
    },
    async recordEvent(...event) { events.push(structuredClone(event)); },
    async listOpenPositions() { return []; },
    async getPosition() { return null; },
    async upsertPosition() { assert.fail("ambiguous entry cannot create a position"); },
    async commitVerifiedIntent() { assert.fail("missing exact fills cannot be committed"); },
  };
}
