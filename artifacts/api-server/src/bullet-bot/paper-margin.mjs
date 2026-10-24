export const PAPER_BASE_MARGIN_USDT = 10;
export const PAPER_MARGIN_MODEL = "isolated-stop-buffer-v1";
export const PAPER_ASSUMED_MAINTENANCE_RATE = 0.01;
export const PAPER_ASSUMED_SAFETY_RATE = 0.01;
export const PAPER_ASSUMED_CLOSE_FEE_RATE = 0.0005;

const SCALE = 1_000_000_000_000n;
const OUTPUT_QUANTUM = 10_000n; // 8 decimal places in 12-decimal internal units.
const MODEL_NOTE =
  "Maintenance and safety rates are assumptions; BingX symbol/tier liquidation terms are not confirmed.";

function scaled(value, name) {
  if (
    (typeof value !== "number" || !Number.isFinite(value)) &&
    typeof value !== "string"
  ) {
    throw new TypeError(`${name} must be a finite decimal`);
  }
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(String(value));
  if (!match) throw new TypeError(`${name} must be a decimal number`);
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) {
    throw new RangeError(`${name} exponent is outside the supported range`);
  }
  const whole = match[2];
  const fraction = match[3] ?? "";
  let units = BigInt(`${whole}${fraction}`);
  const places = fraction.length - exponent;
  if (places <= 12) {
    units *= 10n ** BigInt(12 - places);
  } else {
    units /= 10n ** BigInt(places - 12);
  }
  return match[1] === "-" ? -units : units;
}

function multiplyUp(left, right) {
  const product = left * right;
  return product <= 0n ? 0n : (product + SCALE - 1n) / SCALE;
}

function roundUpToEight(value) {
  if (value <= 0n) return 0n;
  return ((value + OUTPUT_QUANTUM - 1n) / OUTPUT_QUANTUM) * OUTPUT_QUANTUM;
}

function fromScaled(value) {
  return Number(value) / Number(SCALE);
}

function positive(value, name) {
  const result = scaled(value, name);
  if (result <= 0n) throw new RangeError(`${name} must be greater than zero`);
  return result;
}

/**
 * PAPER-only reserve estimate for a long isolated position.
 *
 * BingX's symbol/tier maintenance schedule is not present in the public
 * instrument feed. The 1% maintenance assumption, extra 1% stop-notional
 * reserve and standard 0.05% taker close fee are intentionally visible
 * assumptions, not an exchange-confirmed liquidation price or guarantee.
 */
export function assessPaperMargin({
  entryPrice,
  stopPrice,
  remainingQty,
  marginHeldUsdt,
  closeFeeRate = PAPER_ASSUMED_CLOSE_FEE_RATE,
}) {
  const entry = positive(entryPrice, "entryPrice");
  const stop = positive(stopPrice, "stopPrice");
  const quantity = positive(remainingQty, "remainingQty");
  const margin = scaled(marginHeldUsdt, "marginHeldUsdt");
  const maintenanceRate = positive(PAPER_ASSUMED_MAINTENANCE_RATE, "maintenanceRate");
  const safetyRate = positive(PAPER_ASSUMED_SAFETY_RATE, "safetyRate");
  const closeRate = scaled(closeFeeRate, "closeFeeRate");
  if (margin < 0n || closeRate < 0n || closeRate >= SCALE) {
    throw new RangeError("PAPER margin or close-fee rate is outside the supported range");
  }

  const loss = stop < entry ? multiplyUp(entry - stop, quantity) : 0n;
  const stopNotional = multiplyUp(stop, quantity);
  const maintenance = multiplyUp(stopNotional, maintenanceRate);
  const safety = multiplyUp(stopNotional, safetyRate);
  const closingFee = multiplyUp(stopNotional, closeRate);
  const required = roundUpToEight(loss + maintenance + safety + closingFee);
  const held = roundUpToEight(margin);
  const buffer = held - required;
  const topUp = roundUpToEight(buffer < 0n ? -buffer : 0n);

  return {
    lossAtStopUsdt: fromScaled(roundUpToEight(loss)),
    stopNotionalUsdt: fromScaled(roundUpToEight(stopNotional)),
    maintenanceReserveUsdt: fromScaled(roundUpToEight(maintenance)),
    safetyReserveUsdt: fromScaled(roundUpToEight(safety)),
    modeledCloseFeeUsdt: fromScaled(roundUpToEight(closingFee)),
    requiredMarginUsdt: fromScaled(required),
    marginHeldUsdt: fromScaled(held),
    stopBufferUsdt: fromScaled(buffer),
    topUpUsdt: fromScaled(topUp),
    stopPriceMovePct:
      (Number(stop - entry) / Number(entry)) * 100,
    status: buffer >= 0n ? "buffered" : "insufficient_funds",
  };
}

export function paperMarginSnapshot({
  assessment,
  assessedAt,
  addedMarginUsdt = 0,
  topUps = [],
  closeFeeRateAssumed = PAPER_ASSUMED_CLOSE_FEE_RATE,
}) {
  if (!assessment || typeof assessment !== "object") {
    throw new TypeError("A margin assessment is required");
  }
  if (typeof assessedAt !== "string" || !Number.isFinite(Date.parse(assessedAt))) {
    throw new TypeError("assessedAt must be a valid ISO timestamp");
  }
  const added = scaled(addedMarginUsdt, "addedMarginUsdt");
  if (added < 0n) throw new RangeError("addedMarginUsdt cannot be negative");
  if (!Array.isArray(topUps)) throw new TypeError("topUps must be an array");

  return {
    model: PAPER_MARGIN_MODEL,
    baseMarginUsdt: PAPER_BASE_MARGIN_USDT,
    addedMarginUsdt: fromScaled(added),
    stopRequiredMarginUsdt: assessment.requiredMarginUsdt,
    stopBufferUsdt: assessment.stopBufferUsdt,
    topUpRequiredUsdt: assessment.topUpUsdt,
    status: assessment.status,
    maintenanceRateAssumed: PAPER_ASSUMED_MAINTENANCE_RATE,
    safetyRateAssumed: PAPER_ASSUMED_SAFETY_RATE,
    closeFeeRateAssumed,
    maintenanceTierVerified: false,
    liquidationEstimateGuaranteed: false,
    assumptionNote: MODEL_NOTE,
    assessedAt: new Date(Date.parse(assessedAt)).toISOString(),
    topUps,
  };
}

export function unverifiedPaperMargin({
  assessedAt,
  addedMarginUsdt = 0,
  topUps = [],
  reason = "legacy_margin_fields_unavailable",
}) {
  if (typeof assessedAt !== "string" || !Number.isFinite(Date.parse(assessedAt))) {
    throw new TypeError("assessedAt must be a valid ISO timestamp");
  }
  const added = scaled(addedMarginUsdt, "addedMarginUsdt");
  if (added < 0n || !Array.isArray(topUps)) {
    throw new TypeError("Legacy margin history is invalid");
  }
  return {
    model: PAPER_MARGIN_MODEL,
    baseMarginUsdt: PAPER_BASE_MARGIN_USDT,
    addedMarginUsdt: fromScaled(added),
    stopRequiredMarginUsdt: null,
    stopBufferUsdt: null,
    topUpRequiredUsdt: null,
    status: "unverified",
    maintenanceRateAssumed: PAPER_ASSUMED_MAINTENANCE_RATE,
    safetyRateAssumed: PAPER_ASSUMED_SAFETY_RATE,
    closeFeeRateAssumed: PAPER_ASSUMED_CLOSE_FEE_RATE,
    maintenanceTierVerified: false,
    liquidationEstimateGuaranteed: false,
    assumptionNote: MODEL_NOTE,
    assessedAt: new Date(Date.parse(assessedAt)).toISOString(),
    topUps,
    reason,
  };
}