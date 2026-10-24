import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import {
  ResolveJournalVstReviewPreRunnerCloseBody,
} from "@workspace/api-zod";
import {
  createJournalVstReviewPreRunnerHandler,
  type JournalVstReviewPreRunnerHandlerDependencies,
} from "./journal-vst-review-pre-runner-handler";

const request = {
  params: { sourceSignalId: "review-signal-1" },
  body: {
    clientOrderId: "legacy-close-order-1",
    confirmation: true,
    note: "checked on BingX",
  },
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
  resolveLegacyClose: JournalVstReviewPreRunnerHandlerDependencies["resolveLegacyClose"],
) {
  return createJournalVstReviewPreRunnerHandler({
    resolveLegacyClose,
    getResolvedBy: () => "authenticated-owner",
  });
}

test("confirmation must be an explicit true value; false, missing and null are invalid", async () => {
  assert.equal(ResolveJournalVstReviewPreRunnerCloseBody.safeParse({
    clientOrderId: "legacy-close-order-1",
    confirmation: true,
  }).success, true);
  for (const body of [
    { clientOrderId: "legacy-close-order-1", confirmation: false },
    { clientOrderId: "legacy-close-order-1" },
    { clientOrderId: "legacy-close-order-1", confirmation: null },
  ]) {
    assert.equal(ResolveJournalVstReviewPreRunnerCloseBody.safeParse(body).success, false);
    let calls = 0;
    const { result, response } = responseDouble();
    await handlerFor(async () => {
      calls += 1;
      return { kind: "resolved" };
    })({ ...request, body } as Request, response, () => {});
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { error: "INVALID_VST_REVIEW_RESOLUTION_REQUEST" });
    assert.equal(calls, 0);
  }
});

test("attributes the review to the authenticated owner and returns record-shaped resolved/replayed results", async () => {
  for (const kind of ["resolved", "replayed"]) {
    let received: unknown;
    const { result, response } = responseDouble();
    await handlerFor(async (sourceSignalId, input) => {
      received = { sourceSignalId, input };
      return {
        kind,
        position: {
          sourceSignalId: "review-signal-1",
          symbol: "ENSUSDT",
          status: "open",
          updatedAt: "2026-09-27T11:01:00.000Z",
        },
      };
    })({
      ...request,
      body: { ...request.body, resolvedBy: "forged-body-owner" },
    } as Request, response, () => {});

    assert.equal(result.status, 200);
    assert.equal(result.headers["Cache-Control"], "no-store");
    assert.deepEqual(result.body, {
      outcome: kind,
      position: {
        sourceSignalId: "review-signal-1",
        symbol: "ENSUSDT",
        status: "open",
        updatedAt: new Date("2026-09-27T11:01:00.000Z"),
      },
    });
    assert.deepEqual(received, {
      sourceSignalId: "review-signal-1",
      input: {
        clientOrderId: "legacy-close-order-1",
        confirmation: true,
        resolvedBy: "authenticated-owner",
        note: "checked on BingX",
      },
    });
  }
});

test("fail-closed verification refusals, including unavailable or incomplete history, remain explicit conflicts", async () => {
  for (const reason of [
    "legacy_pre_runner_close_history_unavailable",
    "legacy_pre_runner_close_history_unverified",
  ]) {
    const { result, response } = responseDouble();
    await handlerFor(async () => ({ kind: "refused", reason }))(
      request, response, () => {},
    );
    assert.equal(result.status, 409);
    assert.deepEqual(result.body, {
      error: "VST_LEGACY_CLOSE_RESOLUTION_REFUSED",
      reason,
    });
  }
});

test("inactive worker and busy leader lock are retryable service unavailable responses", async () => {
  const { result: inactive, response: inactiveResponse } = responseDouble();
  await handlerFor(async () => { throw new Error("vst_worker_not_active"); })(
    request, inactiveResponse, () => {},
  );
  assert.equal(inactive.status, 503);
  assert.deepEqual(inactive.body, { error: "VST_WORKER_NOT_ACTIVE" });

  for (const resolveLegacyClose of [
    async () => ({ kind: "busy", reason: "leader_lock_busy" }),
    async () => ({ kind: "refused", reason: "worker_lock_busy" }),
  ]) {
    const { result, response } = responseDouble();
    await handlerFor(resolveLegacyClose as JournalVstReviewPreRunnerHandlerDependencies["resolveLegacyClose"])(
      request, response, () => {},
    );
    assert.equal(result.status, 503);
    assert.equal((result.body as { error: string }).error, "VST_WORKER_BUSY");
  }
});