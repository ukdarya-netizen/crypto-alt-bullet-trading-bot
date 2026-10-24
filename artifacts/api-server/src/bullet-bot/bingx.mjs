const BASE_URL = "https://open-api.bingx.com";
const REQUEST_GAP_MS = 1100; // Public swap endpoints allow one request per second per IP.
const TIMEOUT_MS = 10_000;
const CONTRACT_TTL_MS = 5 * 60_000;

export class BingXApiError extends Error {
  constructor(message, { httpStatus, code, transient = false } = {}) {
    super(message);
    this.name = "BingXApiError";
    this.httpStatus = httpStatus;
    this.code = code;
    // Network failure, timeout, 429 or 5xx: says nothing about the symbol.
    this.transient = transient === true;
  }
}

function exchangeSymbol(symbol) {
  if (typeof symbol !== "string" || !/^[A-Z0-9]+USDT$/.test(symbol)) {
    throw new TypeError("Invalid USDT perpetual symbol");
  }
  return `${symbol.slice(0, -4)}-USDT`;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function fundingIntervalHours(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const intervalMs = value * 60 * 60_000;
  return Number.isSafeInteger(intervalMs) && intervalMs >= 30 * 60_000 && intervalMs <= 24 * 60 * 60_000
    ? value
    : null;
}

function fundingMarkPrice(value) {
  return typeof value === "string" &&
    /^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) &&
    positiveNumber(value)
    ? value
    : null;
}

function precision(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 12) {
    throw new BingXApiError(`BingX returned invalid ${name}`);
  }
  return value;
}

function floorQuantity(value, places) {
  // Work on the sender's decimal string, not floating point, to ensure the
  // PAPER entry never becomes larger than the requested exchange quantity.
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new BingXApiError("Quantity must be a plain decimal for BingX");
  }
  const [whole, fraction = ""] = value.split(".");
  const floored = places === 0
    ? whole
    : `${whole}.${fraction.padEnd(places, "0").slice(0, places)}`;
  return floored.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function ceilStop(value, places) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new BingXApiError("Stop loss must be a plain decimal for BingX");
  }
  const [whole, fraction = ""] = value.split(".");
  const scale = 10n ** BigInt(places);
  const digits = fraction.slice(0, places).padEnd(places, "0");
  let ticks = BigInt(whole) * scale + BigInt(digits || "0");
  // For a long position a higher stop is closer to entry, never more risky.
  if (/[1-9]/.test(fraction.slice(places))) ticks += 1n;
  const decimal = places
    ? `${ticks / scale}.${String(ticks % scale).padStart(places, "0")}`
    : String(ticks);
  return decimal.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function decimalParts(value) {
  const text = String(value);
  if (!/^\d+(?:\.\d+)?$/.test(text) || !positiveNumber(text)) {
    throw new BingXApiError("BingX quote must be a positive plain decimal");
  }
  const [whole, fraction = ""] = text.split(".");
  return {
    units: BigInt(whole + fraction),
    scale: 10n ** BigInt(fraction.length),
  };
}

/** Official public BingX USDT perpetual market data only. No private/order methods. */
export function createBingX({
  fetchImpl = globalThis.fetch,
  clock = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  baseUrl = BASE_URL,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  const root = new URL(baseUrl);
  if (root.protocol !== "https:" || root.username || root.password ||
      root.pathname !== "/" || root.search || root.hash) {
    throw new TypeError("BingX baseUrl must be a clean HTTPS origin");
  }
  let nextRequestAt = 0;
  const contractCache = new Map();
  const premiumIndexCache = new Map();

  async function request(path, symbol, parameters = {}) {
    const slot = Math.max(clock(), nextRequestAt);
    nextRequestAt = slot + REQUEST_GAP_MS;
    if (slot > clock()) await sleep(slot - clock());
    const url = new URL(path, root);
    if (symbol !== null) url.searchParams.set("symbol", symbol);
    for (const [key, value] of Object.entries(parameters)) {
      url.searchParams.set(key, String(value));
    }
    url.searchParams.set("timestamp", String(clock()));
    let response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new BingXApiError(`BingX public market request failed: ${error instanceof Error ? error.name : "network error"}`,
        { transient: true });
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new BingXApiError("BingX returned invalid JSON", {
        httpStatus: response.status,
        transient: response.status === 429 || response.status >= 500,
      });
    }
    if (!response.ok || payload?.code !== 0) {
      throw new BingXApiError(
        `BingX public market request failed (HTTP ${response.status}, code ${String(payload?.code ?? "unknown")})`,
        { httpStatus: response.status, code: payload?.code,
          transient: response.status === 429 || response.status >= 500 },
      );
    }
    return payload.data;
  }

  async function instrument(symbol, { fresh = false } = {}) {
    const name = exchangeSymbol(symbol);
    const cached = contractCache.get(name);
    if (!fresh && cached && cached.until > clock()) return cached.value;
    const data = await request("/openApi/swap/v2/quote/contracts", name);
    const row = Array.isArray(data) ? data.find((entry) => entry?.symbol === name) : null;
    if (!row || row.status !== 1 || row.currency !== "USDT" ||
        row.apiStateOpen !== "true") {
      throw new BingXApiError(`${name} is not an active API-tradeable BingX USDT perpetual`);
    }
    const value = {
      symbol: name,
      quantityPrecision: precision(row.quantityPrecision, "quantityPrecision"),
      pricePrecision: precision(row.pricePrecision, "pricePrecision"),
      minQuantity: positiveNumber(row.tradeMinQuantity),
      minNotional: positiveNumber(row.tradeMinUSDT),
    };
    if (!value.minQuantity || !value.minNotional ||
        (row.maxLongLeverage != null && Number(row.maxLongLeverage) < 10)) {
      throw new BingXApiError(`${name} does not support the contracted PAPER order`);
    }
    contractCache.set(name, { value, until: clock() + CONTRACT_TTL_MS });
    return value;
  }

  async function ticker(symbol) {
    const name = exchangeSymbol(symbol);
    const row = await request("/openApi/swap/v2/quote/ticker", name);
    if (!row || Array.isArray(row) || row.symbol !== name ||
        !positiveNumber(row.lastPrice) || !positiveNumber(row.askPrice)) {
      throw new BingXApiError(`BingX returned no valid live quote for ${name}`);
    }
    if (row.closeTime != null &&
        (!Number.isFinite(Number(row.closeTime)) ||
         Math.abs(clock() - Number(row.closeTime)) > 60_000)) {
      throw new BingXApiError(`BingX quote is stale for ${name}`);
    }
    return {
      symbol,
      lastPrice: String(row.lastPrice),
      ask1Price: String(row.askPrice),
      bid1Price: row.bidPrice == null ? null : String(row.bidPrice),
      quoteAt: row.closeTime == null ? null : new Date(Number(row.closeTime)).toISOString(),
    };
  }

  // One public request for every USDT perpetual quote (symbol omitted).
  // Returns a Map keyed by the caller's symbols; a symbol missing from the
  // bulk answer, or failing validation, is simply absent (caller falls back
  // to the single-symbol ticker).
  async function tickers(symbols) {
    const wanted = new Map(symbols.map((symbol) => [exchangeSymbol(symbol), symbol]));
    const rows = await request("/openApi/swap/v2/quote/ticker", null);
    if (!Array.isArray(rows)) throw new BingXApiError("BingX returned no bulk ticker list");
    const quotes = new Map();
    for (const row of rows) {
      const symbol = wanted.get(row?.symbol);
      if (!symbol || !positiveNumber(row.lastPrice) || !positiveNumber(row.askPrice)) continue;
      if (row.closeTime != null &&
          (!Number.isFinite(Number(row.closeTime)) ||
           Math.abs(clock() - Number(row.closeTime)) > 60_000)) continue;
      quotes.set(symbol, {
        symbol,
        lastPrice: String(row.lastPrice),
        ask1Price: String(row.askPrice),
        bid1Price: row.bidPrice == null ? null : String(row.bidPrice),
        quoteAt: row.closeTime == null ? null : new Date(Number(row.closeTime)).toISOString(),
      });
    }
    return quotes;
  }

  async function premiumIndex(symbol) {
    const name = exchangeSymbol(symbol);
    const cached = premiumIndexCache.get(name);
    if (cached && cached.until > clock()) return cached.value;
    const data = await request("/openApi/swap/v2/quote/premiumIndex", name);
    const row = Array.isArray(data)
      ? data.find((entry) => entry?.symbol === name)
      : data;
    const markPrice = positiveNumber(row?.markPrice);
    const nextFundingTime = Number(row?.nextFundingTime);
    const fundingRate = Number(row?.lastFundingRate);
    if (
      row?.symbol !== name ||
      !markPrice ||
      !Number.isSafeInteger(nextFundingTime) ||
      nextFundingTime <= 0 ||
      typeof row?.lastFundingRate !== "string" ||
      !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(row.lastFundingRate) ||
      !Number.isFinite(fundingRate) ||
      Math.abs(fundingRate) >= 1
    ) {
      throw new BingXApiError(`BingX returned invalid premium index data for ${name}`);
    }
    const value = {
      symbol,
      markPrice: String(row.markPrice),
      indexPrice: positiveNumber(row.indexPrice) ? String(row.indexPrice) : null,
      lastFundingRate: row.lastFundingRate,
      nextFundingTime,
      fundingIntervalHours: fundingIntervalHours(row.fundingIntervalHours),
      observedAt: new Date(clock()).toISOString(),
      source: "BingX public swap premiumIndex",
    };
    premiumIndexCache.set(name, { value, until: clock() + 5_000 });
    return value;
  }

  async function fundingHistory(symbol, { startTime, endTime, limit = 1000 } = {}) {
    const name = exchangeSymbol(symbol);
    if (
      !Number.isSafeInteger(startTime) ||
      !Number.isSafeInteger(endTime) ||
      startTime < 0 ||
      endTime <= startTime ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1000
    ) {
      throw new TypeError("Funding history requires valid millisecond bounds and limit 1..1000");
    }
    const data = await request("/openApi/swap/v2/quote/fundingRate", name, {
      startTime,
      endTime,
      limit,
    });
    if (!Array.isArray(data)) {
      throw new BingXApiError(`BingX returned invalid funding history for ${name}`);
    }
    return data.map((row) => {
      const fundingRate = Number(row?.fundingRate);
      const fundingTime = Number(row?.fundingTime);
      if (
        row?.symbol !== name ||
        typeof row?.fundingRate !== "string" ||
        !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(row.fundingRate) ||
        !Number.isFinite(fundingRate) ||
        Math.abs(fundingRate) >= 1 ||
        !Number.isSafeInteger(fundingTime) ||
        fundingTime < startTime ||
        fundingTime > endTime
      ) {
        throw new BingXApiError(`BingX returned invalid funding history for ${name}`);
      }
      return {
        symbol,
        fundingRate: row.fundingRate,
        fundingTime,
        markPrice: fundingMarkPrice(row.markPrice),
      };
    }).sort((a, b) => a.fundingTime - b.fundingTime);
  }

  async function historicalKlines(symbol, { startTime, endTime, limit = 10 } = {}) {
    const name = exchangeSymbol(symbol);
    if (
      !Number.isSafeInteger(startTime) ||
      !Number.isSafeInteger(endTime) ||
      startTime < 0 ||
      endTime <= startTime ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new TypeError("Historical klines require valid millisecond bounds and limit 1..100");
    }
    const data = await request("/openApi/swap/v2/quote/klines", name, {
      interval: "1m",
      startTime,
      endTime,
      limit,
    });
    if (!Array.isArray(data)) {
      throw new BingXApiError(`BingX returned invalid historical klines for ${name}`);
    }
    return data.map((row) => {
      const time = Number(row?.time);
      const close = positiveNumber(row?.close);
      if (!Number.isSafeInteger(time) || time < startTime || time > endTime || !close) {
        throw new BingXApiError(`BingX returned invalid historical klines for ${name}`);
      }
      return { time, close: String(row.close), source: "BingX public 1m last-trade kline close" };
    }).sort((a, b) => a.time - b.time);
  }

  async function validateOrder(signal) {
    const filters = await instrument(signal.symbol);
    const quantity = floorQuantity(signal.quantity, filters.quantityPrecision);
    if (!positiveNumber(quantity) || Number(quantity) < filters.minQuantity) {
      throw new BingXApiError(`BingX quantity below minimum after rounding down for ${filters.symbol}`);
    }
    const stopLoss = ceilStop(signal.stopLoss, filters.pricePrecision);
    if (!positiveNumber(signal.referencePrice) ||
        Number(quantity) * Number(signal.referencePrice) < filters.minNotional) {
      throw new BingXApiError(`BingX order below minimum USDT value for ${filters.symbol}`);
    }
    if (Number(stopLoss) >= Number(signal.referencePrice)) {
      throw new BingXApiError(`BingX stop would not be below entry for ${filters.symbol}`);
    }
    return { quantity, stopLoss, minNotional: filters.minNotional, instrument: filters };
  }

  function capQuantity(validated, quotePrice) {
    const places = precision(validated?.instrument?.quantityPrecision, "quantityPrecision");
    const requested = decimalParts(validated.quantity);
    const price = decimalParts(quotePrice);
    const quantityScale = 10n ** BigInt(places);
    const requestedUnits = requested.units * quantityScale / requested.scale;
    const maxUnits = 100n * quantityScale * price.scale / price.units;
    const units = requestedUnits < maxUnits ? requestedUnits : maxUnits;
    const decimal = places
      ? `${units / quantityScale}.${String(units % quantityScale).padStart(places, "0")}`
      : String(units);
    return decimal.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  }

  return {
    instrument,
    ticker,
    tickers,
    premiumIndex,
    fundingHistory,
    historicalKlines,
    validateOrder,
    capQuantity,
  };
}