import type { BotRuntimeTelemetry } from "../lib/bot-health";

export function getBotRuntimeHealth(): BotRuntimeTelemetry;

export function configureBotRuntimeHealth(options?: {
  sourceEnabled?: boolean;
  vstEnabled?: boolean;
  paperEnabled?: boolean;
  sourceStartedAt?: string | number | Date | null;
}): void;

export function updateBotSourceHealth(
  patch?: Partial<BotRuntimeTelemetry["source"]>,
): void;

export function beginBotRuntimeTick(lane: "vst" | "paper", at?: number): void;

export function finishBotRuntimeTick(
  lane: "vst" | "paper",
  result?: {
    at?: number;
    outcome?: "success" | "error";
    reason?: string | null;
  },
): void;