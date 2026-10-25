// An executor's current defaults are not the strategy of an existing trade.
// Capture before entry transport and keep the same immutable settings through
// reconciliation, position management and restarts.
export function capturePositionStrategy({ exitStrategy, strategyAuthority }) {
  if (!["source", "full_take_5pct"].includes(exitStrategy) ||
      !["source", "policy"].includes(strategyAuthority)) {
    throw new TypeError("Unsupported executable position strategy");
  }
  return Object.freeze({ version: 1, exitStrategy, strategyAuthority });
}

export function positionStrategy(position, defaults) {
  const saved = position?.executionStrategy;
  if (!saved) return capturePositionStrategy(defaults);
  if (saved.version !== 1) throw new TypeError("Unsupported position strategy version");
  return capturePositionStrategy(saved);
}

export function pinPositionStrategy(position, defaults) {
  return { ...position, executionStrategy: positionStrategy(position, defaults) };
}
