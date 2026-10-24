// All source pattern IDs are eligible. Confirmation, valid trade parameters,
// exchange availability, ownership and account risk remain separate guards.
export const isTradablePatternId = value =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/.test(value);
