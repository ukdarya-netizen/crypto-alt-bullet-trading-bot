import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

const TOKEN = "offline-bot-runtime-ingress-fixture-token";
const ENV_KEYS = [
  "NODE_ENV",
  "BULLET_VST_MODE",
  "TRADING_INGEST_TOKEN",
  "PAPER_ONLY_SIGNAL",
  "EXECUTION_MODE",
];
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
let moduleId = 0;

function restoreEnv() {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function requestBotRuntime({
  nodeEnv = "development",
  mode,
  method = "POST",
  path = "/api/trading/signals",
  authorization = TOKEN,
} = {}) {
  process.env.NODE_ENV = nodeEnv;
  if (mode === undefined) delete process.env.BULLET_VST_MODE;
  else process.env.BULLET_VST_MODE = mode;
  process.env.TRADING_INGEST_TOKEN = TOKEN;
  delete process.env.PAPER_ONLY_SIGNAL;
  delete process.env.EXECUTION_MODE;

  try {
    // A distinct runtime module instance isolates its lazily-created receiver
    // between cases. Its real store is never queried: requests below are
    // rejected before persistence or stop after auth/route parsing.
    const { botRequestHandler } = await import(
      `../bot-runtime.mjs?ingress-guard-test=${++moduleId}`
    );
    const req = Readable.from([]);
    req.method = method;
    req.url = path;
    req.headers = { "x-trading-token": authorization };

    let resolveResponse;
    const responseReady = new Promise((resolve) => {
      resolveResponse = resolve;
    });
    const response = {
      headers: {},
      statusCode: 200,
      writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        this.headers = headers;
      },
      end(body = "") {
        resolveResponse({
          statusCode: this.statusCode,
          headers: this.headers,
          body: String(body),
          json() {
            return JSON.parse(this.body);
          },
        });
      },
    };

    botRequestHandler(req, response);
    return await responseReady;
  } finally {
    restoreEnv();
  }
}

test("development refuses authenticated VST signal ingress before queueing", async () => {
  const response = await requestBotRuntime({
    mode: "vst",
    path: "/api/trading/signals",
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    accepted: false,
    error: { code: "vst_ingress_not_available_outside_production" },
  });
});

test("development refuses both-mode ingress without silently downgrading to PAPER", async () => {
  const response = await requestBotRuntime({
    mode: "both",
    path: "/api/bot/api/trading/signals",
  });

  assert.equal(response.statusCode, 503);
  assert.equal(
    response.json().error.code,
    "vst_ingress_not_available_outside_production",
  );
});

test("the VST ingress guard preserves authentication and does not cover reads", async () => {
  const unauthorizedPost = await requestBotRuntime({
    mode: "vst",
    authorization: "wrong-offline-fixture-token",
  });
  assert.equal(unauthorizedPost.statusCode, 401);
  assert.equal(unauthorizedPost.json().error.code, "unauthorized");

  const health = await requestBotRuntime({
    mode: "vst",
    method: "GET",
    path: "/api/bot/healthz",
  });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().mode, "vst");

  const statusAuthorization = await requestBotRuntime({
    mode: "both",
    method: "GET",
    path: "/api/bot/api/trading/status",
    authorization: "wrong-offline-fixture-token",
  });
  assert.equal(statusAuthorization.statusCode, 401);
  assert.equal(statusAuthorization.json().error.code, "unauthorized");
});

test("development's explicit PAPER and unset default modes retain ingress behavior", async () => {
  // PAPER is selected by an unset/empty mode, not the unsupported string "paper".
  const explicitPaper = await requestBotRuntime({ mode: "" });
  assert.equal(explicitPaper.statusCode, 400);
  assert.equal(explicitPaper.json().error.code, "invalid_json");

  const defaultMode = await requestBotRuntime();
  assert.equal(defaultMode.statusCode, 400);
  assert.equal(defaultMode.json().error.code, "invalid_json");
});

test("production VST and both-mode requests still reach the existing receiver", async () => {
  for (const mode of ["vst", "both"]) {
    const response = await requestBotRuntime({
      nodeEnv: "production",
      mode,
    });

    // The deliberately empty request body is rejected by the existing signal
    // parser before any persistence or exchange check can run. Receiving this
    // validation response proves production was not intercepted by the dev
    // guard.
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "invalid_json");
  }
});