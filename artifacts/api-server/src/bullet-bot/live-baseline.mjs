// The owner explicitly chose this read-only observation of the shared
// BingX account's free USDT margin as the fixed starting reference.
// It is not a bot-only balance; never refresh it from current funds.
export const OWNER_LIVE_BASELINE = Object.freeze({
  initialUsdt: "113.0319",
  startedAt: "2026-09-27T06:24:14.363Z",
});