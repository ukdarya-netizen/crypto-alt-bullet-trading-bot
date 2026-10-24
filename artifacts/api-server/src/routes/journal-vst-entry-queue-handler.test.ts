import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { createJournalVstEntryQueueHandler } from "./journal-vst-entry-queue-handler";
import { buildVstEntryLatency } from "../lib/vst-entry-latency.mjs";

function responseDouble() {
  const result: {
    status: number;
    body?: unknown;
    headers: Record<string, string>;
  } = { status: 200, headers: {} };
  const response = {
    status(code: number) {
      result.status = code;
      return this;
    },
    json(body: unknown) {
      result.body = body;
      return this;
    },
    setHeader(name: string, value: string) {
      result.headers[name] = value;
      return this;
    },
  } as unknown as Response;
  return { result, response };
}

test("queue handler returns a safe 503 instead of leaking database failures", async () => {
  const { result, response } = responseDouble();
  const handler = createJournalVstEntryQueueHandler(async () => {
    throw new Error("database password and connection details");
  });
  await handler({} as Request, response, () => {});
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { error: "VST_ENTRY_QUEUE_UNAVAILABLE" });
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.doesNotMatch(JSON.stringify(result.body), /password|connection/);
});

test("queue handler validates and returns the generated success contract", async () => {
  const { result, response } = responseDouble();
  const handler = createJournalVstEntryQueueHandler(async () => ({
    asOf: "2026-01-01T00:00:00Z",
    total: 0,
    hasMore: false,
    entries: [],
  }));
  await handler({} as Request, response, () => {});
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    asOf: new Date("2026-01-01T00:00:00Z"),
    total: 0,
    hasMore: false,
    entries: [],
  });
});

test("queue contract includes latency cohorts and fails explicitly if their read fails", async () => {
  const queue = { asOf: "2026-01-01T00:00:00Z", total: 0, hasMore: false, entries: [] };
  const latency = buildVstEntryLatency([], { asOf: queue.asOf, since: queue.asOf });
  const { result, response } = responseDouble();
  await createJournalVstEntryQueueHandler(async () => queue, async () => latency)(
    {} as Request, response, () => {});
  assert.equal(result.status, 200);
  assert.equal((result.body as { latency: { cohorts: unknown[] } }).latency.cohorts.length, 3);
  const failed = responseDouble();
  await createJournalVstEntryQueueHandler(async () => queue, async () => {
    throw new Error("secret");
  })({} as Request, failed.response, () => {});
  assert.equal(failed.result.status, 503);
  assert.doesNotMatch(JSON.stringify(failed.result.body), /secret/);
});