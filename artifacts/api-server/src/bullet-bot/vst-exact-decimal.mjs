// Recovery quantities and stop prices must compare without floating-point
// rounding. Return null for malformed or unsupported scalar representations.
export function exactDecimalParts(value) {
  const text = typeof value === "string" || typeof value === "number"
    ? String(value) : "";
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) return null;
  const whole = match[1];
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 30) return null;
  const digits = `${whole}${fraction}`;
  const point = whole.length + exponent;
  const expandedWhole = point <= 0
    ? "0" : point >= digits.length
      ? `${digits}${"0".repeat(point - digits.length)}`
      : digits.slice(0, point);
  const expandedFraction = point <= 0
    ? `${"0".repeat(-point)}${digits}` : digits.slice(point);
  const normalizedWhole = expandedWhole.replace(/^0+(?=\d)/, "");
  const normalizedFraction = expandedFraction.replace(/0+$/, "");
  if (normalizedFraction.length > 30) return null;
  return {
    units: BigInt(`${normalizedWhole}${normalizedFraction}`),
    scale: normalizedFraction.length,
  };
}

export function compareExactDecimals(left, right) {
  const a = exactDecimalParts(left);
  const b = exactDecimalParts(right);
  if (!a || !b) return null;
  const scale = Math.max(a.scale, b.scale);
  const aUnits = a.units * (10n ** BigInt(scale - a.scale));
  const bUnits = b.units * (10n ** BigInt(scale - b.scale));
  return aUnits < bUnits ? -1 : aUnits > bUnits ? 1 : 0;
}