import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import {
  createJournalVstReviewOpenHandler,
  type JournalVstReviewOpenHandlerDependencies,
} from "./journal-vst-review-open-handler";

const request = {
  params: { sourceSignalId: "review-signal-1" },
  body: { remainingQty: "10", note: "verified open" },
} as unknown as Request;

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

function handlerFor(
  dependencies: Partial<JournalVstReviewOpenHandlerDependencies> = {},
) {
  return createJournalVstReviewOpenHandler({
    listUnresolvedIntents: async () => [],
    resolveStillOpen: async () => ({
      sourceSignalId: "review-signal-1",
      symbol: "ENSUSDT",
      status: "open",
      updatedAt: "2026-09-27T11:01:00.000Z",
    }),
    getResolvedBy: () => "authenticated-owner",
    ...dependencies,
  });
}

test("resolve-open refuses to bypass an unknown close_pre_runner_split intent", async () => {
  let storeResolveCalls = 0;
  const { result, response } = responseDouble();
  await handlerFor({
    listUnresolvedIntents: async () => [{
      sourceSignalId: "review-signal-1",
      state: "unknown",
      request: { operation: "close_pre_runner_split" },
    }],
    resolveStillOpen: async () => {
      storeResolveCalls += 1;
      throw new Error("must not resolve");
    },
  })(request, response, () => {});

  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { error: "VST_LEGACY_CLOSE_REVIEW_REQUIRED" });
  assert.equal(storeResolveCalls, 0);
});

test("resolve-open proceeds when no matching unknown pre-runner close intent exists", async () => {
  let received: unknown;
  const { result, response } = responseDouble();
  await handlerFor({
    listUnresolvedIntents: async () => [
      {
        sourceSignalId: "another-signal",
        state: "unknown",
        request: { operation: "close_pre_runner_split" },
      },
      {
        sourceSignalId: "review-signal-1",
        state: "completed",
        request: { operation: "close_pre_runner_split" },
      },
    ],
    resolveStillOpen: async (sourceSignalId, input) => {
      received = { sourceSignalId, input };
      return {
        sourceSignalId,
        symbol: "ENSUSDT",
        status: "open",
        updatedAt: "2026-09-27T11:01:00.000Z",
      };
    },
  })(request, response, () => {});

  assert.equal(result.status, 200);
  assert.deepEqual(received, {
    sourceSignalId: "review-signal-1",
    input: {
      remainingQty: "10",
      resolvedBy: "authenticated-owner",
      note: "verified open",
    },
  });
});