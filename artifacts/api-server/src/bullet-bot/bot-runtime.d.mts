import type { IncomingMessage, ServerResponse } from "node:http";

export function botRequestHandler(req: IncomingMessage, res: ServerResponse): void;
export function startBotWorker(): Promise<void>;
export function stopBotWorker(): Promise<void>;
export function listSourceCommands(): Promise<unknown[]>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- outcome kinds are checked at runtime, as with every other VST worker accessor.
export function closeVstReviewPositionNow(sourceSignalId: string, resolvedBy: string): Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveVstReviewOwnerAttestedClosed(
  sourceSignalId: string,
  input: {
    fill: {
      price: string;
      quantity: string;
      at: string;
      exchangeOrderId: string;
      fee: { asset: string; amount: string };
    };
    resolvedBy: string;
    note: string | null;
  },
): Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function confirmVstReviewPositionStillOpenNow(sourceSignalId: string, resolvedBy: string): Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveVstReviewMarginTopUpKeepOpenNow(
  sourceSignalId: string,
  resolvedBy: string,
  note: string | null,
): Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readVstReviewMarginTopUpMarginNow(sourceSignalId: string): Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function closeVstReviewMarginTopUpPositionNow(sourceSignalId: string, resolvedBy: string): Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveLegacyPreRunnerClose(
  sourceSignalId: string,
  input: {
    clientOrderId: string;
    confirmation: true;
    resolvedBy: string;
    note: string | null;
  },
): Promise<any>;
