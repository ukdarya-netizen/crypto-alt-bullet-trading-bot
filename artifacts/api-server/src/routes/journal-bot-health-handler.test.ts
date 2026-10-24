import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { createJournalBotHealthHandler } from "./journal-bot-health-handler";

test("health endpoint does not cache or leak an unavailable runtime/database exception", async () => {
  let status = 200;
  let body: unknown;
  const headers: Record<string, string> = {};
  const res = {
    setHeader: (key: string, value: string) => { headers[key] = value; },
    status: (code: number) => { status = code; return res; },
    json: (value: unknown) => { body = value; return res; },
  } as unknown as Response;
  await createJournalBotHealthHandler(async () => {
    throw new Error("private credentials and database address");
  })({} as Request, res, () => {});
  assert.equal(status, 503);
  assert.equal(headers["Cache-Control"], "no-store");
  assert.deepEqual(body, { error: "BOT_HEALTH_UNAVAILABLE" });
});