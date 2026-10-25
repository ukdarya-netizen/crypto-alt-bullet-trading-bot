# Crypto Alt Bullet Trading Executor

An isolated, fail-closed execution service that receives confirmed bot signals and processes them independently from scanning and Telegram workloads.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/api-server run worker:dev` — run the separate trading executor worker
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Runtime-managed env: `DATABASE_URL` — Postgres connection string
- Required before signal/control writes: `TRADING_INGEST_TOKEN`, `TRADING_CONTROL_TOKEN`
- `TRADING_APPROVED_PATTERN_IDS` is a comma-separated allowlist; signal intake fails closed without it. See `docs/signal-intake.md` for the sender contract.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — trading API contract
- `lib/db/src/schema/trading.ts` — durable queue, controls, orders, and audit tables
- `artifacts/api-server/src/routes/trading.ts` — signal intake and controls
- `artifacts/api-server/src/worker.ts` — isolated trading executor process

## Architecture decisions

- Signal intake and order execution run in different processes and communicate through Postgres.
- The private journal has exactly one server-authorized owner, identified by `JOURNAL_OWNER_USER_ID` in production. No sign-up, account creation, or client-side state may grant journal access to another user; fail closed if the owner is unset. Do not hardcode the owner's ID in source.
- All mutating endpoints require dedicated tokens and fail closed when tokens are absent.
- Defaults are deliberately safe: paper mode, kill switch active, and new entries disabled.
- Source signal IDs are unique so retries cannot create duplicate orders.
- New PAPER entries require a confirmed, fresh `bullet-long-exits-v2` relay event with the sender's exact size and stop, isolated 10x and $10 initial margin. All four owner-approved patterns (`liquidation_cascade`, `balanced_grind`, `price_led_momentum`, `impulse_buy`) may queue PAPER entries while owner controls permit and their exit policy matches the strict supported contract. Only `liquidation_cascade` has a supplied concrete relay example; do not claim the other senders' live formats are verified. Never replay historical signals or reinterpret legacy seven-field events. `impulse_buy` splits core/runner and puts the runner stop at entry price on opening, following the owner's correction. A 20–25% partial exit is advice, not an order. No exchange orders are enabled. See `docs/trading-strategy.md` and `docs/signal-intake.md`; never substitute an invented R-multiple schedule.
- The paper simulator starts with 100 USDT, adds realized gross linked paper PnL, and allocates 10 USDT per open paper position. An entry with less than 10 USDT free is terminally skipped and logged in the signal journal (not retried after a close); a later fresh signal may use the freed funds. This is only simulated allocation, not verified exchange margin or the future signal-specific stop-margin calculation.
- Only paper and Bybit Testnet execution modes are supported; mainnet has no order endpoint or execution mode. Owner-only BingX mainnet account checks use signed GET requests and do not grant trade permission.
- Testnet uses Replit Secrets BYBIT_TESTNET_API_KEY and BYBIT_TESTNET_API_SECRET. Never put credentials in code or chat.

## Required exchange risk policy (not yet implemented)

- Never open an exchange position in cross margin mode. Before placing a new order, set and verify **isolated margin at 10x leverage** for the relevant symbol/position; fail closed if the exchange state differs.
- The owner must retain the ability to close a position manually at Bybit. Reconcile exchange position and fills after external manual closes so the journal and executor do not treat a closed position as still open or recreate it.
- The owner may manually close a PAPER position from its journal detail using an explicitly entered simulated exit price; the atomic linked close releases the 10-USDT paper allocation and is never an exchange order. For Testnet, the journal links to Bybit for direct manual closure. A flat Bybit position without verified close executions is flagged `closure_unverified` and halts entries; its price/PnL must not be invented. Exchange fill reconciliation and placing a Bybit close from the journal are not implemented.
- Before entry, calculate the *planned post-top-up* liquidation buffer against the signal stop using the exchange risk tier, expected fill, maintenance margin and fees; verify available funds and reject an entry if the buffer cannot be planned or funded. The owner explicitly chose to keep isolated 10x at entry and add the preplanned margin immediately after confirmed fill, accepting the brief unprotected interval. Only **after** the fill and confirmed top-up, verify the exchange-provided liquidation price against the stop; if the top-up or verification fails, halt new entries and safely close the unprotected position with exchange confirmation. A stop order or extra margin must never be described as a guarantee against liquidation.
- The owner explicitly authorized fully automatic isolated-margin top-ups without a fixed cap or alerts to move liquidation below the **signal-provided `stopLoss` for new v2 signals**; this is **not implemented**. Do not replace that stop with a universal percentage or impose an invented top-up cap. Never represent the stop as guaranteed against liquidation; do not enable top-ups until exchange-side calculations, position checks and recovery paths are implemented and verified. Any top-up must be idempotent, audited, and reconciled with the exchange; additional isolated margin lowers effective leverage and increases funds at risk.
- The owner also selected no fixed cap for **future BingX** isolated-margin top-ups. This may use funds beyond the $10 initial margin. It is a risk-policy choice for preparation, not approval to enable live orders or write to BingX; BingX-specific preflight, funded top-up, protection, and reconciliation must be independently implemented and verified.
- Calculate required extra isolated margin and verify available funds **before submitting an entry**, using the signal-specific stop, exchange risk tier, estimated fill, maintenance margin and fees; skip an unaffordable entry. Bybit's add-margin endpoint requires an existing position, so under the owner's isolated 10x setting the preplanned funds can only be added **immediately after a confirmed fill**, followed by exchange-side liquidation-price verification. Do not claim funds are already in position before fill or that the fill-to-top-up interval is risk-free. This preflight/top-up flow is not implemented.

## Subscribers (family) — VST only
- Any signed-in non-owner gets a pending request (`subscribers` table, drizzle). Owner approves/rejects/blocks in Journal → «Подписчики».
- Approved subscriber: saves a BingX key (checked: GET /openApi/v1/account/apiPermissions must NOT contain 4/5/7 transfer/withdraw rights, then a read-only VST balance), picks a strategy (only «Тейк +5%» is executable now), presses «Старт».
- Keys are AES-256-GCM encrypted with the Replit Secret `SUBSCRIBER_KEYS_SECRET` (32+ random chars). Never returned by any endpoint. Rotating that secret makes saved keys unreadable (subscribers re-enter them).
- Each started subscriber runs an isolated copy of the VST worker (`bullet-bot/subscriber-trading.mjs`): own schema `sub_<id>` (vst_* tables copied with LIKE public.*), own leader lock, own BingX key/pacer. Signals and AltBullet exits the owner's bot receives are copied to it. «Стоп» blocks new entries; open positions are still managed until closed.
- Mainnet is NOT enabled for subscribers.

## Product

- Accept confirmed, idempotent trading signals into a durable queue.
- Apply stop-loss and maximum-notional checks before paper or testnet execution.
- Expose worker heartbeat, queue depth, execution mode, and emergency controls.
- Keep a durable audit trail of signals, decisions, and simulated orders.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Do not disable the kill switch or enable entries before paper/testnet validation.
- Never make live trading the default or silently fall back from paper to live.
- Market signals without a risk-check reference price are rejected by the worker.
- Testnet assumes Bybit USDT linear one-way positions. The kill switch blocks new entries, but reconciliation continues so existing exchange exposure is visible.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
