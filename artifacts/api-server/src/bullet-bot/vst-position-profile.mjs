// How a VST worker sizes and holds its positions. The owner's bot always uses
// OWNER_POSITION_PROFILE (1% of the total balance as initial margin, isolated,
// LONG 10x). A subscriber chooses their own profile; it is fixed for the
// lifetime of that subscriber's worker and every position it opens.
//
// allocation.mode:
//   "percent" -> initial margin per trade = total VST balance * value / 100
//   "amount"  -> initial margin per trade = value VST
// The position size is initial margin * leverage.

export const MARGIN_MODES = Object.freeze(["ISOLATED", "CROSSED"]);
export const SUBSCRIBER_LEVERAGE_CHOICES = Object.freeze([1, 2, 3, 5, 10, 15, 20, 25]);
export const ALLOCATION_LIMITS = Object.freeze({
  percent: Object.freeze({ min: 0.1, max: 100 }),
  amount: Object.freeze({ min: 1, max: 1_000_000 }),
});

export const OWNER_POSITION_PROFILE = Object.freeze({
  leverage: 10,
  marginMode: "ISOLATED",
  allocation: Object.freeze({ mode: "percent", value: 1 }),
});

/** Validates and freezes a profile; throws a readable error on anything else. */
export function normalizePositionProfile(input = OWNER_POSITION_PROFILE) {
  const leverage = Number(input?.leverage);
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) {
    throw new RangeError("position_profile_leverage_invalid");
  }
  const marginMode = String(input?.marginMode ?? "");
  if (!MARGIN_MODES.includes(marginMode)) throw new RangeError("position_profile_margin_mode_invalid");
  const mode = String(input?.allocation?.mode ?? "");
  const value = Number(input?.allocation?.value);
  const limits = ALLOCATION_LIMITS[mode];
  if (!limits) throw new RangeError("position_profile_allocation_mode_invalid");
  if (!Number.isFinite(value) || value < limits.min || value > limits.max) {
    throw new RangeError("position_profile_allocation_value_invalid");
  }
  return Object.freeze({ leverage, marginMode, allocation: Object.freeze({ mode, value }) });
}

/** Initial-margin budget (VST) for one trade from the total VST balance. */
export function allocationBudget(profile, totalBalance) {
  const balance = Number(totalBalance);
  if (!Number.isFinite(balance) || balance <= 0) return NaN;
  return profile.allocation.mode === "amount"
    ? profile.allocation.value
    : balance * profile.allocation.value / 100;
}

export function isOwnerProfile(profile) {
  return profile.leverage === 10 && profile.marginMode === "ISOLATED" &&
    profile.allocation.mode === "percent" && profile.allocation.value === 1;
}

/** Does an exchange/ledger position snapshot use exactly this profile's leverage and margin mode? */
export function positionMatchesProfile(position, profile) {
  const mode = String(position?.marginMode ?? "").toUpperCase();
  const normalized = mode === "CROSS" ? "CROSSED" : mode;
  return Number(position?.leverage) === profile.leverage && normalized === profile.marginMode;
}
