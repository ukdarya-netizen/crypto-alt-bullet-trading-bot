import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  eligibleHistoricalCascadeCandidate,
  HISTORICAL_CASCADE_MARGIN_MODE,
  HISTORICAL_CASCADE_TOTAL_MARGIN_USDT,
  transitionHistoricalCascade,
  type HistoricalPaperSignalRow,
  type HistoricalCascadeSelection,
} from "./historical-cascade-selection";

const timestamp = new Date("2026-10-01T12:00:00.000Z");

function disarmed(): HistoricalCascadeSelection {
  return {
    state: "disarmed",
    sourceSignalId: null,
    symbol: null,
    marginMode: HISTORICAL_CASCADE_MARGIN_MODE,
    totalMarginUsdt: HISTORICAL_CASCADE_TOTAL_MARGIN_USDT,
    selectedAt: null,
    cancelledAt: null,
    entryIntentReservedAt: null,
    attemptStartedAt: null,
    updatedAt: null,
  };
}

const candidate = { sourceSignalId: "cab-signal-123", symbol: "BTCUSDT" };

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function historicalSignal(patternId = "liquidation_cascade"): HistoricalPaperSignalRow {
  const body = {
    sourceSignalId: "cab-signal-123",
    confirmationStatus: "confirmed",
    patternId,
    patternStatus: "approved",
    symbol: "BTCUSDT",
    signalAt: "2026-09-01T12:00:00.000Z",
    side: "buy",
    orderType: "market",
    reduceOnly: false,
    payload: {
      source: "CryptoAltBullet",
      rulesVersion: "bullet-long-exits-v2",
      marginMode: "isolated",
      initialMarginUsd: "10",
      leverage: 10,
    },
  };
  const canonicalBody = JSON.stringify(canonicalize(body));
  return {
    source_signal_id: "cab-signal-123",
    body,
    body_hash: createHash("sha256").update(canonicalBody).digest("hex"),
    status: "rejected",
    reason: "insufficient_free_paper_balance",
    position_status: null,
    position_mode: null,
    position_updated_at: null,
  };
}

test("eligible PAPER insufficient-balance rejection can be selected without a PAPER position", () => {
  const rejected = historicalSignal();
  const candidate = eligibleHistoricalCascadeCandidate(rejected);
  assert.deepEqual(candidate, {
    sourceSignalId: "cab-signal-123",
    symbol: "BTCUSDT",
    signalAt: "2026-09-01T12:00:00.000Z",
    historicalPaperOutcome: "rejected_insufficient_free_paper_balance",
  });
  const claimed = transitionHistoricalCascade(disarmed(), "select", timestamp, candidate!);
  assert.equal(claimed.sourceSignalId, rejected.source_signal_id);
});

test("candidate proof rejects unrelated patterns and tampered source/body", () => {
  assert.equal(eligibleHistoricalCascadeCandidate(historicalSignal("impulse_buy")), null);
  const wrongSource = historicalSignal();
  (wrongSource.body as Record<string, unknown>).sourceSignalId = "cab-signal-999";
  assert.equal(eligibleHistoricalCascadeCandidate(wrongSource), null);
  const wrongAuth = historicalSignal();
  ((wrongAuth.body as Record<string, unknown>).payload as Record<string, unknown>).source = "untrusted";
  assert.equal(eligibleHistoricalCascadeCandidate(wrongAuth), null);
});

test("owner claim is one-shot and exposes no stored historical price", () => {
  const claimed = transitionHistoricalCascade(disarmed(), "select", timestamp, candidate);
  assert.equal(claimed.state, "claimed");
  assert.equal(claimed.sourceSignalId, candidate.sourceSignalId);
  assert.equal(claimed.symbol, "BTCUSDT");
  assert.equal(claimed.marginMode, "isolated");
  assert.equal(claimed.totalMarginUsdt, "15");
  assert.equal("referencePrice" in claimed, false);
  assert.throws(
    () => transitionHistoricalCascade(claimed, "select", timestamp, candidate),
    /one-shot/,
  );
});

test("cancel-before-entry is idempotent and permanently consumes the selector", () => {
  const claimed = transitionHistoricalCascade(disarmed(), "select", timestamp, candidate);
  const cancelled = transitionHistoricalCascade(claimed, "cancel", timestamp);
  assert.equal(cancelled.state, "cancelled");
  assert.strictEqual(transitionHistoricalCascade(cancelled, "cancel", new Date()), cancelled);
  assert.throws(
    () => transitionHistoricalCascade(cancelled, "select", timestamp, candidate),
    /one-shot/,
  );
  assert.throws(
    () => transitionHistoricalCascade(cancelled, "reserve-entry", timestamp),
    /cannot be reserved/,
  );
});

test("entry intent reservation fences cancellation and attempt is permanently one-shot", () => {
  const claimed = transitionHistoricalCascade(disarmed(), "select", timestamp, candidate);
  const reserved = transitionHistoricalCascade(claimed, "reserve-entry", timestamp);
  assert.equal(reserved.state, "entry_intent_reserved");
  assert.strictEqual(transitionHistoricalCascade(reserved, "reserve-entry", new Date()), reserved);
  assert.throws(
    () => transitionHistoricalCascade(reserved, "cancel", timestamp),
    /after entry intent reservation/,
  );

  const attempted = transitionHistoricalCascade(reserved, "start-attempt", timestamp);
  assert.equal(attempted.state, "attempted");
  assert.strictEqual(transitionHistoricalCascade(attempted, "start-attempt", new Date()), attempted);
  assert.throws(
    () => transitionHistoricalCascade(attempted, "select", timestamp, candidate),
    /one-shot/,
  );
});

test("parallel claims have a single winner when serialized by the singleton row lock", async () => {
  let durable = disarmed();
  let queue = Promise.resolve();
  const claim = (id: string) => {
    const operation = queue.then(() => {
      durable = transitionHistoricalCascade(durable, "select", timestamp, {
        sourceSignalId: id,
        symbol: "BTCUSDT",
      });
    });
    queue = operation.then(() => undefined, () => undefined);
    return operation;
  };

  const results = await Promise.allSettled([claim("first"), claim("second")]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  assert.ok(["first", "second"].includes(durable.sourceSignalId ?? ""));
  assert.equal(durable.state, "claimed");
});