import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import {
  createJournalVstReviewClosedHandler,
  type JournalVstReviewCloseHandlerDependencies,
} from "./journal-vst-review-close-handler";

const request = {
  params: { sourceSignalId: "review-signal-1" },
  body: {
    fill: {
      price: "22.7",
      quantity: "12",
      at: "2026-09-27T11:00:00.000Z",
      exchangeOrderId: "owner-attested-order-id",
      fee: { asset: "USDT", amount: "0.05" },
    },
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

function handlerFor(resolveClosed: JournalVstReviewCloseHandlerDependencies["resolveClosed"]) {
  return createJournalVstReviewClosedHandler({
    resolveClosed,
    getResolvedBy: () => "owner-user",
  });
}

test("resolve-closed passes owner facts to the guarded worker and returns an idempotent success", async () => {
  let received: unknown;
  const { result, response } = responseDouble();
  const handler = handlerFor(async (sourceSignalId, input) => {
    received = { sourceSignalId, input };
    return {
      kind: "already_closed",
      position: {
        sourceSignalId: "review-signal-1",
        symbol: "ENSUSDT",
        status: "closed",
        updatedAt: "2026-09-27T11:01:00.000Z",
      },
    };
  });
  await handler(request, response, () => {});
  assert.equal(result.status, 200);
  assert.deepEqual(
    { ...(result.body as Record<string, unknown>), updatedAt: undefined },
    {
      sourceSignalId: "review-signal-1",
      symbol: "ENSUSDT",
      status: "closed",
      updatedAt: undefined,
    },
  );
  assert.equal(
    (result.body as { updatedAt: Date }).updatedAt.toISOString(),
    "2026-09-27T11:01:00.000Z",
  );
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.deepEqual(received, {
    sourceSignalId: "review-signal-1",
    input: {
      fill: {
        price: "22.7",
        quantity: "12",
        at: "2026-09-27T11:00:00.000Z",
        exchangeOrderId: "owner-attested-order-id",
        fee: { asset: "USDT", amount: "0.05" },
      },
      resolvedBy: "owner-user",
      note: "checked on BingX",
    },
  });
});

test("resolve-closed maps open position, open orders and account mismatch to explicit conflicts", async () => {
  for (const [kind, error] of [
    ["position_open", "VST_REVIEW_POSITION_NOT_FLAT"],
    ["orders_open", "VST_REVIEW_ORDERS_REMAIN"],
    ["account_mismatch", "VST_REVIEW_ACCOUNT_MISMATCH"],
  ]) {
    const { result, response } = responseDouble();
    await handlerFor(async () => ({ kind }))(request, response, () => {});
    assert.equal(result.status, 409);
    assert.deepEqual(result.body, { error });
  }
});

test("resolve-closed maps exchange outage, stale worker and busy lock to retryable service unavailable", async () => {
  for (const outcome of [
    { kind: "exchange_unavailable" },
    { kind: "exchange_unverified" },
    null,
  ]) {
    const { result, response } = responseDouble();
    await handlerFor(async () => outcome)(request, response, () => {});
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { error: "VST_REVIEW_EXCHANGE_CHECK_UNAVAILABLE" });
  }
  const { result, response } = responseDouble();
  await handlerFor(async () => { throw new Error("vst_worker_not_active"); })(
    request, response, () => {},
  );
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { error: "VST_REVIEW_EXCHANGE_CHECK_UNAVAILABLE" });
});

test("resolve-closed returns a conflict for a record that is no longer awaiting review", async () => {
  const { result, response } = responseDouble();
  await handlerFor(async () => ({ kind: "not_reviewable" }))(
    request, response, () => {},
  );
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { error: "VST_POSITION_NOT_AWAITING_REVIEW" });
});

test("resolve-closed does not call the verifier for an invalid request", async () => {
  let calls = 0;
  const { result, response } = responseDouble();
  await handlerFor(async () => { calls += 1; return { kind: "closed" }; })(
    { ...request, body: {} } as Request,
    response,
    () => {},
  );
  assert.equal(result.status, 400);
  assert.equal(calls, 0);
});
