import { createHmac } from "node:crypto";

export const PAPER_TAKER_FEE_RATE = 0.0005;
export const PAPER_FEE_MODEL_VERSION = "bingx-perpetual-standard-taker-v1";
export const PAPER_FEE_SCHEDULE_URL =
  "https://bingx.com/en/support/articles/360046487573-programa-de-tarifas-futuros-perpetuo-";
const PERSONAL_FEE_PATH = "/openApi/swap/v2/user/commissionRate";
const PERSONAL_FEE_SOURCE = "BingX private swap commissionRate GET";

const USDT_SCALE = 100_000_000n;

function decimalParts(value, name) {
  if (
    !(typeof value === "number" && Number.isFinite(value)) &&
    typeof value !== "string"
  ) {
    throw new TypeError(`${name} must be a finite positive decimal`);
  }
  const text = String(value);
  const match = /^(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) throw new TypeError(`${name} must be a finite positive decimal`);
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? match[3] ?? "";
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) {
    throw new RangeError(`${name} exponent is outside the supported range`);
  }
  let units = BigInt(whole + fraction);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    units *= 10n ** BigInt(-scale);
    scale = 0;
  }
  if (units <= 0n) throw new RangeError(`${name} must be greater than zero`);
  return { units, scale };
}

function roundedUnits(numerator, denominator) {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return quotient + (remainder * 2n >= denominator ? 1n : 0n);
}

function asUsdt(units) {
  const amount = Number(units) / Number(USDT_SCALE);
  if (!Number.isFinite(amount)) throw new RangeError("PAPER fee is outside the supported range");
  return amount;
}

function validRate(value) {
  if ((typeof value !== "string" && typeof value !== "number") ||
      !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(String(value)) ||
      !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) >= 1) {
    throw new TypeError("Invalid PAPER taker fee rate");
  }
  if (Number(value) === 0) return { units: 0n, scale: 0 };
  return decimalParts(value, "taker fee rate");
}

/** Calculate a USDT notional and its 8-decimal taker fee without float drift. */
export function paperFillCosts(price, quantity, rate = PAPER_TAKER_FEE_RATE) {
  const parsedPrice = decimalParts(price, "price");
  const parsedQuantity = decimalParts(quantity, "quantity");
  const parsedRate = validRate(rate);
  const product = parsedPrice.units * parsedQuantity.units;
  const productScale = 10n ** BigInt(parsedPrice.scale + parsedQuantity.scale);
  const notionalUnits = roundedUnits(product * USDT_SCALE, productScale);
  const feeUnits = roundedUnits(
    product * parsedRate.units * USDT_SCALE,
    productScale * 10n ** BigInt(parsedRate.scale),
  );
  return {
    notionalUsdt: asUsdt(notionalUnits),
    feeUsdt: asUsdt(feeUnits),
  };
}

export function paperFeeModel(checkedAt = null) {
  return {
    version: PAPER_FEE_MODEL_VERSION,
    venue: "BingX USDT perpetual",
    executionType: "simulated_market_taker",
    rate: PAPER_TAKER_FEE_RATE,
    scheduleUrl: PAPER_FEE_SCHEDULE_URL,
    accountTierVerified: false,
    assumption: "BingX standard taker fee; account-specific fee tier is unverified",
    source: "BingX published standard taker schedule (assumption)",
    checkedAt,
  };
}

/** Credentialed GET only; never shares the live trading client's write surface. */
export function createPaperFeeReader({
  fetchImpl = globalThis.fetch,
  clock = Date.now,
  credentials = () => ({
    key: process.env.BINGX_API_KEY,
    secret: process.env.BINGX_API_SECRET,
  }),
} = {}) {
  return async function readPaperFee(symbol) {
    if (typeof symbol !== "string" || !/^[A-Z0-9]+USDT$/.test(symbol)) {
      throw new TypeError("Invalid BingX perpetual symbol");
    }
    const { key, secret } = credentials() ?? {};
    if (!key || !secret) throw new Error("BingX fee credentials unavailable");
    const symbolName = `${symbol.slice(0, -4)}-USDT`;
    const signingText = `recvWindow=5000&symbol=${symbolName}&timestamp=${clock()}`;
    const params = new URLSearchParams(signingText);
    const signature = createHmac("sha256", secret).update(signingText).digest("hex");
    params.set("signature", signature);
    const response = await fetchImpl(`https://open-api.bingx.com${PERSONAL_FEE_PATH}?${params}`, {
      method: "GET",
      headers: { "X-BX-APIKEY": key, "X-SOURCE-KEY": "BX-AI-SKILL" },
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) throw new Error("BingX fee endpoint unavailable");
    const payload = await response.json();
    if (payload?.code !== 0) throw new Error("BingX fee endpoint rejected request");
    const row = Array.isArray(payload.data) ? payload.data[0] : payload.data;
    const rate = row?.takerCommissionRate ?? row?.takerFeeRate;
    // Reject coercion of null/empty values; do not silently treat missing data as zero.
    validRate(rate);
    return {
      version: "bingx-perpetual-personal-taker-v1",
      venue: "BingX USDT perpetual",
      executionType: "simulated_market_taker",
      rate: Number(rate),
      source: PERSONAL_FEE_SOURCE,
      checkedAt: new Date(clock()).toISOString(),
      scheduleUrl: PAPER_FEE_SCHEDULE_URL,
      accountTierVerified: true,
      assumption: null,
    };
  };
}

/** Failure is an explicit standard assumption, never a previously cached VIP rate. */
export async function resolvePaperFeeModel(reader, symbol, clock = Date.now) {
  const checkedAt = new Date(clock()).toISOString();
  try {
    if (typeof reader !== "function") throw new Error("Fee reader unavailable");
    const model = await reader(symbol);
    if (model?.source !== PERSONAL_FEE_SOURCE || model.accountTierVerified !== true ||
        !Number.isFinite(Date.parse(model.checkedAt)) ||
        Math.abs(Date.parse(model.checkedAt) - clock()) > 30_000) {
      throw new Error("Invalid fee observation");
    }
    validRate(model.rate);
    return model;
  } catch {
    return paperFeeModel(checkedAt);
  }
}