import { pool } from "@workspace/db";
// @ts-expect-error LIVE funding auditor is an isolated JavaScript module.
import { reconcileLiveFunding } from "../bullet-bot/live-funding.mjs";
// @ts-expect-error LIVE ledger is an isolated JavaScript module.
import { createLiveStore } from "../bullet-bot/live-store.mjs";
// @ts-expect-error Private exchange adapter is an isolated JavaScript module.
import { createBingXLiveApi } from "../bullet-bot/bingx-live-api.mjs";

export async function auditLiveFunding(): Promise<Array<{
  signalId: string;
  status: string;
  reason?: string;
}> | null> {
  const store = createLiveStore(pool);
  return store.withLock(() => reconcileLiveFunding({
    store, exchange: createBingXLiveApi({ environment: "mainnet" }),
    account: "bingx-mainnet",
  }));
}