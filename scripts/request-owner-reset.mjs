import { parseArgs } from "node:util";
const { values } = parseArgs({ options: {
  url: { type: "string" }, "reset-id": { type: "string" },
  confirm: { type: "boolean", default: false }, status: { type: "boolean", default: false },
} });
if (!values.url || !values["reset-id"] || (!values.confirm && !values.status)) {
  throw new Error("Required: --url VERIFIED_PRODUCTION_URL --reset-id SAME_ID and --confirm or --status");
}
const base = new URL(values.url);
if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/") {
  throw new Error("Use the verified HTTPS production origin, without credentials or a path");
}
if (!/^[A-Za-z0-9_-]{1,100}$/.test(values["reset-id"])) throw new Error("Invalid reset ID");
if (!process.env.TRADING_INGEST_TOKEN) throw new Error("Trading token is not configured");
const url = new URL("/api/trading/reset", base);
if (values.status) url.searchParams.set("resetId", values["reset-id"]);
const response = await fetch(url, { method: values.status ? "GET" : "POST",
  redirect: "error", signal: AbortSignal.timeout(30_000),
  headers: { "x-trading-token": process.env.TRADING_INGEST_TOKEN, "content-type": "application/json" },
  ...(values.status ? {} : { body: JSON.stringify({
    resetId: values["reset-id"], confirm: "cancel_queue_and_close_paper_vst",
  }) }),
});
if (!response.ok) throw new Error(`Reset HTTP ${response.status}; no completion is assumed; retry with SAME reset ID`);
console.log(JSON.stringify({ httpStatus: response.status, ...await response.json() }));
