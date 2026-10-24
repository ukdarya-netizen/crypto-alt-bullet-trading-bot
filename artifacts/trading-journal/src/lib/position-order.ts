function openedAtMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function sortPositionsNewestFirst<T>(
  positions: readonly T[],
  openedAt: (position: T) => unknown,
  stableKey: (position: T) => string,
): T[] {
  return [...positions].sort((a, b) => {
    const aTime = openedAtMs(openedAt(a));
    const bTime = openedAtMs(openedAt(b));
    if (aTime !== bTime) {
      if (aTime === null) return 1;
      if (bTime === null) return -1;
      return bTime > aTime ? 1 : -1;
    }
    const aKey = stableKey(a);
    const bKey = stableKey(b);
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
}