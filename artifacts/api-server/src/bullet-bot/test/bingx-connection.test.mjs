import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createBingXConnectionProbe } from "../bingx-connection.mjs";

test("uses only signed GET balance, returns connection state without account or credentials", async () => {
  let calls = 0;
  const probe = createBingXConnectionProbe({
    clock: () => 1700000000000,
    credentials: () => ({ key: "fixture-key", secret: "fixture-secret" }),
    fetchImpl: async (raw, options) => {
      calls++;
      const url = new URL(raw);
      assert.equal(url.origin, "https://open-api.bingx.com");
      assert.equal(url.pathname, "/openApi/swap/v3/user/balance");
      assert.equal(options.method, "GET");
      assert.equal(options.headers["X-BX-APIKEY"], "fixture-key");
      assert.equal(options.headers["X-SOURCE-KEY"], "BX-AI-SKILL");
      assert.equal(url.searchParams.get("signature"), createHmac("sha256", "fixture-secret")
        .update("recvWindow=5000&timestamp=1700000000000").digest("hex"));
      return new Response(JSON.stringify({
        code: 0, data: { balance: { equity: "12345.67", userId: "private-user" } },
      }), { status: 200 });
    },
  });
  assert.deepEqual(await probe(), {
    status: "connected", environment: "mainnet",
    checkedAt: "2023-11-14T22:13:20.000Z", httpStatus: 200,
  });
  assert.equal(calls, 1);
});

test("unconfigured, rejected, and blocked connection checks expose no exchange response", async () => {
  const noKeys = createBingXConnectionProbe({
    credentials: () => ({ key: undefined, secret: undefined }),
    fetchImpl: () => { throw new Error("must not call BingX"); },
  });
  assert.equal((await noKeys()).status, "not_configured");

  const rejected = createBingXConnectionProbe({
    credentials: () => ({ key: "fixture-key", secret: "fixture-secret" }),
    fetchImpl: async () => new Response(JSON.stringify({
      code: 100001, msg: "private text", data: null,
    }), { status: 200 }),
  });
  const rejection = await rejected();
  assert.equal(rejection.status, "exchange_rejected");
  assert.equal(JSON.stringify(rejection).includes("private text"), false);

  const blocked = createBingXConnectionProbe({
    credentials: () => ({ key: "fixture-key", secret: "fixture-secret" }),
    fetchImpl: async () => new Response("private edge text", { status: 403 }),
  });
  assert.deepEqual(
    (({ status, httpStatus }) => ({ status, httpStatus }))(await blocked()),
    { status: "unavailable", httpStatus: 403 },
  );
});