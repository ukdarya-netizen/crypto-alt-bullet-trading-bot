// Small JSON client for the subscriber endpoints (same-origin session cookie).
export type Subscription = {
  id: number;
  status: "pending" | "approved" | "rejected" | "blocked";
  email: string | null;
  name: string | null;
  requestedAt: string;
  strategy: string | null;
  apiKeyLast4: string | null;
  apiKeyVerifiedAt: string | null;
  apiKeyError: string | null;
  positionSettings: PositionSettings;
  tradingEnabled: boolean;
  tradingStartedAt: string | null;
  runtimeStatus: string | null;
  runtimeReason: string | null;
  runtimeAt: string | null;
};

export type PositionSettings = {
  allocationMode: "percent" | "amount";
  allocationValue: number;
  leverage: number;
  marginMode: "ISOLATED" | "CROSSED";
};

export type PositionChoices = {
  leverage: number[];
  allocation: { percent: { min: number; max: number }; amount: { min: number; max: number } };
};

/** "1% от баланса · изолированная · 10x" */
export function positionSettingsText(s: PositionSettings): string {
  const size = s.allocationMode === "percent" ? `${s.allocationValue}% от баланса` : `${s.allocationValue} VST`;
  return `${size} · ${s.marginMode === "CROSSED" ? "кросс" : "изолированная"} · ${s.leverage}x`;
}

export type StrategyOption = { id: string; label: string; available: boolean };

export type PerformanceTrade = {
  sourceSignalId: string; symbol: string; patternId: string | null; closedAt: string;
  pnlUsdt: number | null; roePercent: number | null; closeReason: string | null;
};

export class ApiFailure extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message); }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: init.body === undefined ? undefined : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
  if (!response.ok) {
    throw new ApiFailure(data?.error?.message ?? "Не удалось выполнить запрос", data?.error?.code ?? "error", response.status);
  }
  return data as T;
}

export const STRATEGY_TEXT: Record<string, string> = {
  take5: "Вся позиция закрывается, когда цена прошла +5% от входа. Стоп — из сигнала AltBullet. Если AltBullet закрыл сделку раньше — бот тоже закрывает.",
  classic: "Защита в безубыток на +5%, стоп на +5% при +10%, дальше трейлинг.",
  ladder: "25% позиции на +5%, ещё 25% на +10%, остаток на +15%.",
  patterns: "Свои правила выхода для каждого паттерна AltBullet.",
};

/** Plain-language state of a subscriber worker. */
export function runtimeText(sub: Subscription): { text: string; tone: "ok" | "wait" | "bad" | "off" } {
  if (!sub.tradingEnabled) {
    return sub.runtimeStatus && !["stopped", null].includes(sub.runtimeStatus)
      ? { text: "Остановлено: новые сделки не открываются, открытые позиции бот доводит до закрытия", tone: "wait" }
      : { text: "Торговля выключена", tone: "off" };
  }
  switch (sub.runtimeStatus) {
    case null:
    case "stopped":
      return { text: "Запускается… (до 15 секунд)", tone: "wait" };
    case "error":
      return { text: `Ошибка: ${sub.runtimeReason ?? "неизвестно"}`, tone: "bad" };
    case "blocked":
    case "waiting":
      return { text: `Работает, ждёт: ${sub.runtimeReason ?? "условий биржи"}`, tone: "wait" };
    default:
      return { text: "Работает: ждёт сигналы AltBullet и ведёт сделки", tone: "ok" };
  }
}
