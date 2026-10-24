import { createHmac } from "node:crypto";

const DEFAULT_BASE_URL = "https://api.bybit.com";
const RECEIVE_WINDOW_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
const CATEGORY = "linear";

/**
 * A definite API rejection (the server returned a non-zero retCode).
 * `retCode`, `httpStatus`, `method`, and `path` are safe to log; request
 * headers, API credentials and signed request bodies are intentionally omitted.
 */
export class BybitApiError extends Error {
  constructor(message, { retCode, httpStatus, method, path } = {}) {
    super(message);
    this.name = "BybitApiError";
    this.retCode = retCode;
    this.httpStatus = httpStatus;
    this.method = method;
    this.path = path;
  }
}

/**
 * A create-order request may have reached Bybit even though the client did not
 * receive a conclusive response. Reconcile this orderLinkId before doing
 * anything else; never blindly submit the market order again.
 */
export class UnknownOrderOutcomeError extends Error {
  constructor(orderLinkId, cause) {
    super(
      `Bybit order outcome is unknown for orderLinkId ${orderLinkId}; reconcile the order before retrying`,
      { cause },
    );
    this.name = "UnknownOrderOutcomeError";
    this.orderLinkId = orderLinkId;
  }
}

function decimalParts(value, label) {
  const input = typeof value === "number" ? String(value) : value;
  if (
    typeof input !== "string" ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(input)
  ) {
    throw new TypeError(`${label} must be a positive plain decimal string`);
  }
  const [whole, fraction = ""] = input.split(".");
  return { whole, fraction };
}

function decimalToScaledInteger(value, scale, label) {
  const { whole, fraction } = decimalParts(value, label);
  if (fraction.length > scale) {
    const extraDigits = fraction.slice(scale);
    if (/[1-9]/.test(extraDigits)) {
      throw new RangeError(`${label} has more decimal places than supported`);
    }
  }
  return BigInt(whole) * 10n ** BigInt(scale) +
    BigInt((fraction.slice(0, scale) + "0".repeat(scale)).slice(0, scale) || "0");
}

function precisionOf(...values) {
  return Math.max(
    ...values.map((value) => decimalParts(value, "decimal").fraction.length),
  );
}

function isExactMultiple(value, step) {
  const scale = precisionOf(value, step);
  const amount = decimalToScaledInteger(value, scale, "quantity");
  const increment = decimalToScaledInteger(step, scale, "qtyStep");
  return increment > 0n && amount > 0n && amount % increment === 0n;
}

function atLeastNotional(quantity, price, minimum) {
  const scale = Math.max(
    precisionOf(quantity, price, minimum),
    12,
  );
  const q = decimalToScaledInteger(quantity, scale, "quantity");
  const p = decimalToScaledInteger(price, scale, "referencePrice");
  const min = decimalToScaledInteger(minimum, scale * 2, "minNotionalValue");
  return q * p >= min;
}

function assertPositiveDecimal(value, label) {
  decimalParts(value, label);
  if (Number(value) <= 0 || !Number.isFinite(Number(value))) {
    throw new TypeError(`${label} must be greater than zero`);
  }
}

function assertSymbol(symbol) {
  if (typeof symbol !== "string" || !/^[A-Z0-9]+USDT$/.test(symbol)) {
    throw new TypeError("symbol must be an uppercase USDT linear contract");
  }
}

function assertPositionIndex(positionIdx = 0) {
  if (positionIdx !== 0 && positionIdx !== 1) {
    throw new RangeError(
      "Only one-way positions (0) and long hedge positions (1) are supported",
    );
  }
  return positionIdx;
}

function canonicalQuery(query = {}) {
  return Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
    )
    .join("&");
}

function formatApiError(result, httpStatus, method, path) {
  const retCode = Number.isInteger(result?.retCode) ? result.retCode : undefined;
  const description =
    typeof result?.retMsg === "string" && result.retMsg
      ? result.retMsg
      : "Bybit request failed";
  return new BybitApiError(description, {
    retCode,
    httpStatus,
    method,
    path,
  });
}

function requireList(result, method, path) {
  if (!Array.isArray(result?.list)) {
    throw new BybitApiError("Bybit response did not contain a result list", {
      method,
      path,
    });
  }
  return result.list;
}

/**
 * Create a Bybit V5 REST adapter.
 *
 * All decimal amounts/prices are sent to Bybit as strings. Public methods
 * (`ticker`, `instrument`) do not require credentials. Private method results:
 *
 * - `ticker(symbol)` -> { symbol, lastPrice, markPrice, bid1Price, ask1Price }
 * - `instrument(symbol)` -> normalized linear-perpetual filter fields
 * - `validateOrder(signal)` -> validated values and normalized instrument
 * - `openProtected(...)` -> accepted_not_filled acknowledgment; it is NOT a
 *   fill report. The caller must reconcile orderLinkId and actual position.
 * - `getPosition(symbol)` -> array of normalized non-zero positions
 * - `getOrder(orderLinkId)` -> matching normalized order, or null
 * - `walletBalance()` -> normalized UNIFIED account totals and USDT coin row
 *
 * Methods do not enable a caller's live-trading mode. The service must enforce
 * its own explicit execution-mode guard before calling private order methods.
 */
export function createBybit({
  apiKey,
  apiSecret,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  clock = () => Date.now(),
  timeoutMs = REQUEST_TIMEOUT_MS,
  recvWindow = RECEIVE_WINDOW_MS,
} = {}) {
  const root = new URL(baseUrl);
  if (
    root.protocol !== "https:" ||
    (root.pathname !== "/" && root.pathname !== "") ||
    root.username ||
    root.password ||
    root.search ||
    root.hash
  ) {
    throw new TypeError("Bybit baseUrl must be a clean HTTPS URL");
  }
  const normalizedBaseUrl = root.toString().replace(/\/+$/, "");

  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("timeoutMs must be a positive integer");
  }
  if (!Number.isInteger(recvWindow) || recvWindow < 1) {
    throw new TypeError("recvWindow must be a positive integer");
  }

  function requireCredentials() {
    if (
      typeof apiKey !== "string" ||
      !apiKey ||
      typeof apiSecret !== "string" ||
      !apiSecret
    ) {
      throw new Error("BYBIT_API_KEY and BYBIT_API_SECRET are required");
    }
  }

  async function request(path, { method = "GET", query, body, isPrivate = false, orderLinkId } = {}) {
    const upperMethod = method.toUpperCase();
    const queryString = canonicalQuery(query);
    const url = `${normalizedBaseUrl}${path}${queryString ? `?${queryString}` : ""}`;
    const headers = { Accept: "application/json" };
    let serializedBody;

    if (body !== undefined) {
      serializedBody = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }

    if (isPrivate) {
      requireCredentials();
      const timestamp = String(clock());
      const signingValue = `${timestamp}${apiKey}${recvWindow}${
        upperMethod === "GET" ? queryString : serializedBody ?? ""
      }`;
      const signature = createHmac("sha256", apiSecret)
        .update(signingValue)
        .digest("hex");
      headers["X-BAPI-API-KEY"] = apiKey;
      headers["X-BAPI-TIMESTAMP"] = timestamp;
      headers["X-BAPI-RECV-WINDOW"] = String(recvWindow);
      headers["X-BAPI-SIGN-TYPE"] = "2";
      headers["X-BAPI-SIGN"] = signature;
    }

    let response;
    try {
      response = await fetchImpl(url, {
        method: upperMethod,
        headers,
        ...(serializedBody === undefined ? {} : { body: serializedBody }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (path === "/v5/order/create" && upperMethod === "POST") {
        throw new UnknownOrderOutcomeError(orderLinkId, error);
      }
      throw error;
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      if (path === "/v5/order/create" && upperMethod === "POST") {
        throw new UnknownOrderOutcomeError(orderLinkId, error);
      }
      throw new BybitApiError("Bybit returned invalid JSON", {
        httpStatus: response.status,
        method: upperMethod,
        path,
      });
    }

    if (!response.ok) {
      if (
        path === "/v5/order/create" &&
        upperMethod === "POST" &&
        response.status >= 500
      ) {
        throw new UnknownOrderOutcomeError(
          orderLinkId,
          new Error(`HTTP ${response.status}`),
        );
      }
      throw formatApiError(payload, response.status, upperMethod, path);
    }

    if (payload?.retCode !== 0) {
      throw formatApiError(payload, response.status, upperMethod, path);
    }

    return payload.result ?? {};
  }

  async function instrument(symbol) {
    assertSymbol(symbol);
    const path = "/v5/market/instruments-info";
    const result = await request(path, {
      query: { category: CATEGORY, symbol },
    });
    const [raw] = requireList(result, "GET", path);

    if (
      !raw ||
      raw.symbol !== symbol ||
      raw.status !== "Trading" ||
      raw.contractType !== "LinearPerpetual" ||
      raw.quoteCoin !== "USDT" ||
      raw.settleCoin !== "USDT"
    ) {
      throw new BybitApiError(
        `${symbol} is not an active USDT-settled linear perpetual`,
        { method: "GET", path },
      );
    }

    const lot = raw.lotSizeFilter;
    const price = raw.priceFilter;
    if (
      !lot ||
      !price ||
      typeof lot.qtyStep !== "string" ||
      typeof lot.minOrderQty !== "string" ||
      typeof lot.minNotionalValue !== "string" ||
      typeof lot.maxMktOrderQty !== "string" ||
      typeof price.tickSize !== "string"
    ) {
      throw new BybitApiError(
        `${symbol} instrument response is missing required trading filters`,
        { method: "GET", path },
      );
    }

    return {
      symbol: raw.symbol,
      status: raw.status,
      contractType: raw.contractType,
      baseCoin: raw.baseCoin,
      quoteCoin: raw.quoteCoin,
      settleCoin: raw.settleCoin,
      qtyStep: lot.qtyStep,
      minOrderQty: lot.minOrderQty,
      maxMktOrderQty: lot.maxMktOrderQty,
      minNotionalValue: lot.minNotionalValue,
      tickSize: price.tickSize,
    };
  }

  async function validateQuantityAndPrice({
    symbol,
    quantity,
    referencePrice,
    stopLoss,
  }) {
    assertSymbol(symbol);
    assertPositiveDecimal(quantity, "quantity");
    assertPositiveDecimal(referencePrice, "referencePrice");
    assertPositiveDecimal(stopLoss, "stopLoss");

    const filters = await instrument(symbol);
    if (Number(stopLoss) >= Number(referencePrice)) {
      throw new RangeError("stopLoss must be strictly below referencePrice");
    }
    if (!isExactMultiple(quantity, filters.qtyStep)) {
      throw new RangeError(
        `quantity ${quantity} is not an exact multiple of Bybit qtyStep ${filters.qtyStep}`,
      );
    }
    if (Number(quantity) < Number(filters.minOrderQty)) {
      throw new RangeError(
        `quantity ${quantity} is below Bybit minOrderQty ${filters.minOrderQty}`,
      );
    }
    if (Number(quantity) > Number(filters.maxMktOrderQty)) {
      throw new RangeError(
        `quantity ${quantity} exceeds Bybit maxMktOrderQty ${filters.maxMktOrderQty}`,
      );
    }
    if (!atLeastNotional(quantity, referencePrice, filters.minNotionalValue)) {
      throw new RangeError(
        `order notional is below Bybit minNotionalValue ${filters.minNotionalValue}`,
      );
    }
    if (!isExactMultiple(stopLoss, filters.tickSize)) {
      throw new RangeError(
        `stopLoss ${stopLoss} is not aligned to Bybit tickSize ${filters.tickSize}`,
      );
    }

    return filters;
  }

  async function validateOrder(signal) {
    if (!signal || typeof signal !== "object" || Array.isArray(signal)) {
      throw new TypeError("signal must be an object");
    }
    if (
      signal.side !== "buy" ||
      signal.orderType !== "market" ||
      signal.reduceOnly !== false
    ) {
      throw new RangeError("only non-reduce-only market buy signals are supported");
    }
    if (
      signal.payload?.marginMode !== "isolated" ||
      signal.payload?.leverage !== 10 ||
      signal.payload?.initialMarginUsd !== "10"
    ) {
      throw new RangeError(
        "signal must request isolated margin, 10x leverage and $10 initial margin",
      );
    }
    if (
      typeof signal.limitPrice !== "string" ||
      typeof signal.referencePrice !== "string" ||
      Number(signal.limitPrice) !== Number(signal.referencePrice)
    ) {
      throw new RangeError(
        "limitPrice must match referencePrice for a market-entry reference",
      );
    }

    const filters = await validateQuantityAndPrice({
      symbol: signal.symbol,
      quantity: signal.quantity,
      referencePrice: signal.referencePrice,
      stopLoss: signal.stopLoss,
    });
    return {
      symbol: signal.symbol,
      quantity: signal.quantity,
      referencePrice: signal.referencePrice,
      stopLoss: signal.stopLoss,
      notional: (
        Number(signal.quantity) * Number(signal.referencePrice)
      ).toString(),
      leverage: 10,
      marginMode: "isolated",
      instrument: filters,
    };
  }

  async function ticker(symbol) {
    assertSymbol(symbol);
    const path = "/v5/market/tickers";
    const result = await request(path, {
      query: { category: CATEGORY, symbol },
    });
    const [row] = requireList(result, "GET", path);
    if (
      !row ||
      row.symbol !== symbol ||
      !row.lastPrice ||
      !Number.isFinite(Number(row.lastPrice)) ||
      Number(row.lastPrice) <= 0
    ) {
      throw new BybitApiError(`No valid live ticker for ${symbol}`, {
        method: "GET",
        path,
      });
    }
    return {
      symbol,
      lastPrice: row.lastPrice,
      markPrice: row.markPrice ?? null,
      bid1Price: row.bid1Price ?? null,
      ask1Price: row.ask1Price ?? null,
      updatedAt: row.ts ?? null,
    };
  }

  async function setMarginMode(mode = "ISOLATED_MARGIN") {
    if (mode !== "ISOLATED_MARGIN") {
      throw new RangeError("only isolated margin mode is supported");
    }
    const path = "/v5/account/set-margin-mode";
    try {
      return await request(path, {
        method: "POST",
        body: { setMarginMode: "ISOLATED_MARGIN" },
        isPrivate: true,
      });
    } catch (error) {
      // Bybit explicitly reports this code when the requested mode is already
      // active; it is a no-op, not a failure to establish isolated margin.
      if (error instanceof BybitApiError && error.retCode === 110026) {
        return { unchanged: true, setMarginMode: "ISOLATED_MARGIN" };
      }
      throw error;
    }
  }

  async function setLeverage(symbol, leverage = 10) {
    assertSymbol(symbol);
    if (Number(leverage) !== 10) {
      throw new RangeError("this receiver only supports the contracted 10x leverage");
    }
    const path = "/v5/position/set-leverage";
    try {
      return await request(path, {
        method: "POST",
        body: {
          category: CATEGORY,
          symbol,
          buyLeverage: "10",
          sellLeverage: "10",
        },
        isPrivate: true,
      });
    } catch (error) {
      // Same leverage is already in place; the requested value is fixed at 10x.
      if (error instanceof BybitApiError && error.retCode === 110043) {
        return { unchanged: true, leverage: "10" };
      }
      throw error;
    }
  }

  async function walletBalance() {
    const path = "/v5/account/wallet-balance";
    const result = await request(path, {
      query: { accountType: "UNIFIED", coin: "USDT" },
      isPrivate: true,
    });
    const [account] = requireList(result, "GET", path);
    const coin = account?.coin?.find((item) => item.coin === "USDT") ?? null;
    return {
      accountType: account?.accountType ?? null,
      totalEquity: account?.totalEquity ?? null,
      totalWalletBalance: account?.totalWalletBalance ?? null,
      totalAvailableBalance: account?.totalAvailableBalance ?? null,
      usdt: coin
        ? {
            walletBalance: coin.walletBalance ?? null,
            equity: coin.equity ?? null,
            availableToWithdraw: coin.availableToWithdraw ?? null,
          }
        : null,
    };
  }

  async function getPosition(symbol) {
    assertSymbol(symbol);
    const path = "/v5/position/list";
    const result = await request(path, {
      query: { category: CATEGORY, symbol },
      isPrivate: true,
    });
    return requireList(result, "GET", path)
      .filter((row) => row.symbol === symbol && Number(row.size) > 0)
      .map((row) => ({
        symbol: row.symbol,
        side: row.side,
        size: row.size,
        avgPrice: row.avgPrice,
        markPrice: row.markPrice,
        positionIdx: Number(row.positionIdx),
        leverage: row.leverage,
        liqPrice: row.liqPrice,
        positionIM: row.positionIM,
        stopLoss: row.stopLoss,
        updatedTime: row.updatedTime,
      }));
  }

  async function getOrder(orderLinkId) {
    if (
      typeof orderLinkId !== "string" ||
      !/^[A-Za-z0-9_-]{1,36}$/.test(orderLinkId)
    ) {
      throw new TypeError("orderLinkId must be 1-36 safe ASCII characters");
    }
    const path = "/v5/order/realtime";
    const result = await request(path, {
      query: {
        category: CATEGORY,
        settleCoin: "USDT",
        orderLinkId,
        openOnly: 1,
      },
      isPrivate: true,
    });
    const matches = requireList(result, "GET", path).filter(
      (row) => row.orderLinkId === orderLinkId,
    );
    const order = matches[0];
    if (!order) return null;
    return {
      orderId: order.orderId,
      orderLinkId: order.orderLinkId,
      symbol: order.symbol,
      side: order.side,
      orderType: order.orderType,
      qty: order.qty,
      leavesQty: order.leavesQty,
      cumExecQty: order.cumExecQty,
      avgPrice: order.avgPrice,
      orderStatus: order.orderStatus,
      reduceOnly: order.reduceOnly,
      createdTime: order.createdTime,
      updatedTime: order.updatedTime,
    };
  }

  async function openProtected(
    signal,
    { orderLinkId, positionIdx = 0 } = {},
  ) {
    if (
      typeof orderLinkId !== "string" ||
      !/^[A-Za-z0-9_-]{1,36}$/.test(orderLinkId)
    ) {
      throw new TypeError("orderLinkId must be 1-36 safe ASCII characters");
    }
    const hedgeIndex = assertPositionIndex(positionIdx);
    const valid = await validateOrder(signal);

    // Configure the account first. If margin-mode or leverage cannot be
    // established, the market order is not sent.
    await setMarginMode("ISOLATED_MARGIN");
    await setLeverage(signal.symbol, valid.leverage);

    const path = "/v5/order/create";
    const body = {
      category: CATEGORY,
      symbol: signal.symbol,
      side: "Buy",
      orderType: "Market",
      qty: signal.quantity,
      timeInForce: "IOC",
      positionIdx: hedgeIndex,
      orderLinkId,
      tpslMode: "Full",
      stopLoss: signal.stopLoss,
      slTriggerBy: "MarkPrice",
      slOrderType: "Market",
      reduceOnly: false,
    };

    let result;
    try {
      result = await request(path, {
        method: "POST",
        body,
        isPrivate: true,
        orderLinkId,
      });
    } catch (error) {
      if (
        error instanceof BybitApiError &&
        error.retCode === 0
      ) {
        throw new UnknownOrderOutcomeError(orderLinkId, error);
      }
      throw error;
    }

    if (
      typeof result.orderId !== "string" ||
      !result.orderId ||
      typeof result.orderLinkId !== "string" ||
      result.orderLinkId !== orderLinkId
    ) {
      throw new UnknownOrderOutcomeError(
        orderLinkId,
        new Error("Bybit response omitted a matching order ID"),
      );
    }
    return {
      status: "accepted_not_filled",
      symbol: signal.symbol,
      side: "Buy",
      qty: signal.quantity,
      stopLoss: signal.stopLoss,
      orderId: result.orderId,
      orderLinkId: result.orderLinkId,
      positionIdx: hedgeIndex,
      submittedAt: result.createdTime ?? null,
    };
  }

  async function updateStop(
    symbol,
    stopPrice,
    { positionIdx = 0 } = {},
  ) {
    assertSymbol(symbol);
    assertPositionIndex(positionIdx);
    assertPositiveDecimal(stopPrice, "stopPrice");
    const filters = await instrument(symbol);
    if (!isExactMultiple(stopPrice, filters.tickSize)) {
      throw new RangeError(
        `stopPrice ${stopPrice} is not aligned to Bybit tickSize ${filters.tickSize}`,
      );
    }
    const path = "/v5/position/trading-stop";
    return request(path, {
      method: "POST",
      body: {
        category: CATEGORY,
        symbol,
        tpslMode: "Full",
        positionIdx,
        stopLoss: stopPrice,
        slTriggerBy: "MarkPrice",
        slOrderType: "Market",
      },
      isPrivate: true,
    });
  }

  async function closeReduceOnly(
    symbol,
    quantity,
    { orderLinkId, positionIdx = 0 } = {},
  ) {
    assertSymbol(symbol);
    assertPositionIndex(positionIdx);
    if (
      typeof orderLinkId !== "string" ||
      !/^[A-Za-z0-9_-]{1,36}$/.test(orderLinkId)
    ) {
      throw new TypeError("orderLinkId must be 1-36 safe ASCII characters");
    }
    const filters = await instrument(symbol);
    assertPositiveDecimal(quantity, "quantity");
    if (
      !isExactMultiple(quantity, filters.qtyStep) ||
      Number(quantity) < Number(filters.minOrderQty) ||
      Number(quantity) > Number(filters.maxMktOrderQty)
    ) {
      throw new RangeError("close quantity does not satisfy Bybit quantity filters");
    }
    const path = "/v5/order/create";
    const result = await request(path, {
      method: "POST",
      body: {
        category: CATEGORY,
        symbol,
        side: "Sell",
        orderType: "Market",
        qty: quantity,
        timeInForce: "IOC",
        positionIdx,
        orderLinkId,
        reduceOnly: true,
        closeOnTrigger: true,
      },
      isPrivate: true,
      orderLinkId,
    });
    if (
      typeof result.orderId !== "string" ||
      !result.orderId ||
      result.orderLinkId !== orderLinkId
    ) {
      throw new UnknownOrderOutcomeError(
        orderLinkId,
        new Error("Bybit response omitted a matching order ID"),
      );
    }
    return {
      status: "accepted_not_filled",
      symbol,
      side: "Sell",
      qty: quantity,
      reduceOnly: true,
      orderId: result.orderId,
      orderLinkId,
      positionIdx,
    };
  }

  async function addMargin(
    symbol,
    amount,
    { positionIdx = 0 } = {},
  ) {
    assertSymbol(symbol);
    assertPositionIndex(positionIdx);
    assertPositiveDecimal(amount, "amount");
    const path = "/v5/position/add-margin";
    return request(path, {
      method: "POST",
      body: {
        category: CATEGORY,
        symbol,
        margin: amount,
        positionIdx,
      },
      isPrivate: true,
    });
  }

  return {
    ticker,
    instrument,
    validateOrder,
    setMarginMode,
    setLeverage,
    walletBalance,
    getPosition,
    getOrder,
    openProtected,
    updateStop,
    closeReduceOnly,
    addMargin,
  };
}