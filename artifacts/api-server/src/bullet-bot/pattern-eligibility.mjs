// All source pattern IDs are eligible. Confirmation, valid trade parameters,
// exchange availability, ownership and account risk remain separate guards.
export const isTradablePatternId = value =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/.test(value);

// Pattern-specific source milestones are metadata, not an allowlist of entry
// strategies. The runtime's full +5% take and source controls remain authoritative.
// Still refuse missing, nonnumeric or incoherent stop thresholds.
export function isSupportedSourceLadder(rules) {
  if (!rules || typeof rules !== "object") return false;
  const positiveFields = [
    "firstTargetPct", "breakevenAtPct", "trailingActivationPct",
    "trailingGapPercentagePoints",
  ];
  if (!positiveFields.every(key =>
    typeof rules[key] === "number" && Number.isFinite(rules[key]) && rules[key] > 0)) {
    return false;
  }
  return ["protectedProfitAtPct", "protectedProfitPct"].every(key =>
    typeof rules[key] === "number" && Number.isFinite(rules[key]) && rules[key] >= 0) &&
    rules.protectedProfitPct <= rules.protectedProfitAtPct &&
    rules.trailingGapPercentagePoints < rules.trailingActivationPct;
}
