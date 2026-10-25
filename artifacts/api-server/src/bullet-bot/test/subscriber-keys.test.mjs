import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decryptSecret, encryptSecret, forbiddenPermissions, plausibleBingXKey, readBingXKeyPermissions,
  subscriberKeysConfigured,
} from "../subscriber-keys.mjs";

const SECRET = "x".repeat(40);

test("keys round-trip encrypted, never stored in plain text, and fail closed on tampering", () => {
  const stored = encryptSecret("AbCdEf1234567890KEY", SECRET);
  assert.ok(stored.startsWith("v1:"));
  assert.ok(!stored.includes("AbCdEf1234567890KEY"));
  assert.notEqual(encryptSecret("AbCdEf1234567890KEY", SECRET), stored, "random IV");
  assert.equal(decryptSecret(stored, SECRET), "AbCdEf1234567890KEY");
  const parts = stored.split(":");
  parts[3] = Buffer.from("tampered").toString("base64url");
  assert.throws(() => decryptSecret(parts.join(":"), SECRET));
  assert.throws(() => decryptSecret(stored, "y".repeat(40)), "another secret cannot decrypt");
  assert.throws(() => encryptSecret("k", "short"), /SUBSCRIBER_KEYS_SECRET/);
  assert.equal(subscriberKeysConfigured("short"), false);
  assert.equal(subscriberKeysConfigured(SECRET), true);
});

test("key format and money-moving permissions are refused", async () => {
  assert.equal(plausibleBingXKey("abc"), false);
  assert.equal(plausibleBingXKey("A1b2C3d4E5f6G7h8I9"), true);
  const fetchWith = (data) => async (url, options) => {
    assert.match(url, /^https:\/\/open-api\.bingx\.com\/openApi\/v1\/account\/apiPermissions\?timestamp=\d+&signature=[0-9a-f]{64}$/);
    assert.equal(options.headers["X-BX-APIKEY"], "KEY1234567890ABCDEF");
    return { ok: true, status: 200, json: async () => ({ code: 0, data }) };
  };
  const creds = { key: "KEY1234567890ABCDEF", secret: "SECRET1234567890ABC" };
  const safe = await readBingXKeyPermissions(creds, { fetchImpl: fetchWith({ permissions: [2, 3] }) });
  assert.deepEqual(forbiddenPermissions(safe.permissions), []);
  const withdraw = await readBingXKeyPermissions(creds, { fetchImpl: fetchWith({ permissions: "2,3,5" }) });
  assert.deepEqual(forbiddenPermissions(withdraw.permissions), [5]);
  await assert.rejects(readBingXKeyPermissions(creds, { fetchImpl: fetchWith({}) }), /не вернул список прав/);
  await assert.rejects(readBingXKeyPermissions(creds, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: 100001, msg: "signature verification failed" }) }),
  }), /signature verification failed/);
});
