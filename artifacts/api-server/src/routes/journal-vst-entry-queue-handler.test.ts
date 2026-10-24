import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { createJournalVstEntryQueueHandler } from "./journal-vst-entry-queue-handler";

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