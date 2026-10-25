// Encryption of subscriber BingX API keys at rest. AES-256-GCM with a key
// derived from SUBSCRIBER_KEYS_SECRET (a Replit Secret, never in code). A
// stored value is "v1:<iv>:<tag>:<ciphertext>" in base64url. Decrypted keys
// live only in the memory of that subscriber's worker.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";

function masterKey(secret = process.env.SUBSCRIBER_KEYS_SECRET) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("SUBSCRIBER_KEYS_SECRET must be set (at least 32 characters)");
  }
  return createHash("sha256").update(`cab-subscriber-keys:${secret}`).digest();
}

export function subscriberKeysConfigured(secret = process.env.SUBSCRIBER_KEYS_SECRET) {
  return typeof secret === "string" && secret.length >= 32;
}

export function encryptSecret(plain, secret) {
  if (typeof plain !== "string" || plain.length === 0) throw new TypeError("nothing to encrypt");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(secret), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"),
    body.toString("base64url")].join(":");
}

export function decryptSecret(stored, secret) {
  const parts = typeof stored === "string" ? stored.split(":") : [];
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("unsupported encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", masterKey(secret), Buffer.from(parts[1], "base64url"));
  decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
}

/** BingX keys are long alphanumeric strings; reject anything else early. */
export function plausibleBingXKey(value) {
  return typeof value === "string" && /^[A-Za-z0-9]{16,128}$/.test(value.trim());
}

// BingX key permission codes (BingX API docs, GET /openApi/v1/account/apiPermissions):
// 1 spot trading, 2 read, 3 perpetual futures trading, 4 universal transfer,
// 5 withdraw, 7 sub-account transfer. Any money-moving right is refused.
export const FORBIDDEN_KEY_PERMISSIONS = Object.freeze([4, 5, 7]);

/**
 * Read-only, signed request for the key's own permissions on BingX mainnet.
 * Returns { permissions: number[], raw } or throws with a readable message.
 */
export async function readBingXKeyPermissions({ key, secret }, { fetchImpl = fetch, now = Date.now } = {}) {
  const { createHmac } = await import("node:crypto");
  const query = `timestamp=${now()}`;
  const signature = createHmac("sha256", secret).update(query).digest("hex");
  const response = await fetchImpl(
    `https://open-api.bingx.com/openApi/v1/account/apiPermissions?${query}&signature=${signature}`,
    { method: "GET", headers: { "X-BX-APIKEY": key }, signal: AbortSignal.timeout(10_000) },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || Number(body?.code) !== 0) {
    throw new Error(`проверка прав ключа: ${body?.msg ?? `HTTP ${response.status}`}`);
  }
  const raw = body?.data?.permissions ?? body?.data?.permission ?? null;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : null;
  if (!list) throw new Error("проверка прав ключа: BingX не вернул список прав");
  return { permissions: list.map((value) => Number(String(value).trim())).filter(Number.isFinite), raw };
}

export function forbiddenPermissions(permissions) {
  return permissions.filter((code) => FORBIDDEN_KEY_PERMISSIONS.includes(code));
}
