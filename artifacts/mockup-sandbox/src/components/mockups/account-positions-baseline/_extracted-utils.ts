export function formatNumber(value: string | number | null, decimals: number = 2) {
  if (value === null || value === undefined) return "—";
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "—";
  return new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(num);
}

export function formatDate(dateString: string | null) {
  if (!dateString) return "—";
  return new Date(dateString).toLocaleString("ru-RU", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}
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