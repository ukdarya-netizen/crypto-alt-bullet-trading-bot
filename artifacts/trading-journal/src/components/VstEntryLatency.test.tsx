import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VstEntryLatency } from "./VstEntryLatency";
import type { JournalVstEntryLatency } from "@workspace/api-client-react";

const empty: JournalVstEntryLatency = {
  asOf: "2026-10-24T10:00:00Z", since: "2026-10-17T10:00:00Z",
  total: 0, hasMore: false, entries: [],
  cohorts: (["measured", "historical", "not_attempted"] as const).map((cohort) => ({
    cohort, count: 0, timedCount: 0, p50Ms: null, p95Ms: null,
    refusals: 0, freshnessRefusals: 0, freshnessRefusalPercent: null,
  })),
};
test("empty latency renders unknown percentiles, three groups and a clear empty state", () => {
  const html = renderToStaticMarkup(<VstEntryLatency data={empty} />);
  assert.match(html, /p50 Неизвестно/);
  assert.match(html, /p95 Неизвестно/);
  assert.match(html, /Пока нет попыток этой группы/);
  assert.equal((html.match(/data-testid="latency-summary-/g) ?? []).length, 3);
  assert.doesNotMatch(html, /NaN|undefined|0 мс/);
});
test("measured refusal renders its stages without claiming transport or a fill; sampling is explicit", () => {
  const data: JournalVstEntryLatency = {
    ...empty, total: 1001, hasMore: true,
    cohorts: [{ ...empty.cohorts[0], count: 1, refusals: 1, freshnessRefusals: 1, freshnessRefusalPercent: 100 }],
    entries: [{
      sourceSignalId: "latency-fixture", symbol: "GRASSUSDT", status: "unknown", cohort: "measured",
      receivedAt: empty.asOf, transportAt: null, receiptToTransportMs: null,
      receiptToNativeAttemptMs: 2000, marginModeMs: 500, leverageMs: null, nativeChecksMs: 3000,
      finalPriceMs: 400, pacingMs: 2001, refusedBeforeTransport: true, freshnessRefusal: true,
    }],
  };
  const html = renderToStaticMarkup(<VstEntryLatency data={data} />);
  assert.match(html, /GRASSUSDT/);
  assert.match(html, /Отказ до отправки/);
  assert.match(html, /истекла свежесть/);
  assert.match(html, /1 из 1 подтверждённых отказов/);
  assert.match(html, /100\.0%/);
  assert.match(html, /последним 1 из 1001 сигналов/);
  assert.match(html, /500 мс/);
  assert.doesNotMatch(html, /Позиция открыта|NaN|undefined/);
});
