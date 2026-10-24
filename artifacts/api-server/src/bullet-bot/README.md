# Bullet → BingX PAPER bot

This is the **active PAPER receiver inside the existing API project**. Bullet's
existing sender URL is routed to it; historical GET endpoints remain on the older
receiver, but new signal POSTs no longer enter the older execution queue. It accepts authenticated
Bullet v2 signals, durably queues them in PostgreSQL, executes a PAPER entry,
tracks the position against BingX's official USDT perpetual price feed, and applies the saved
exit plan. It does **not** place real orders. The `PAPER_ONLY_SIGNAL` guard is
enforced at startup and in the worker.

## Run in this project

### Restart-safe technical health alerts

The source-freshness watchdog uses a separate singleton checkpoint in
`bot_health_incidents`, represented by `lib/db/src/schema/bot-health.ts`
(`health-schema.sql` is its SQL reference). Provision it through the normal
schema publication step; the runtime performs no DDL. No production SQL or
exchange writes are needed to test this feature.

Only production loads/writes this checkpoint. It contains incident timing,
severity, acknowledged Telegram severity/time, failure count, and retry deadline;
it contains no trading events, signal IDs, orders, credentials, or message bodies.
A delivered page retains its 30-minute cooldown across restarts. Escalation to
critical bypasses a warning cooldown, while failed deliveries retry at 60-second
intervals. Recovery stability is intentionally never restored: two new fresh,
distinct complete admissions spanning 30 seconds must establish it again.
An incident with no acknowledged page clears silently on stable recovery.

Loads/writes have a five-second client timeout. An unavailable or invalid
checkpoint is not interpreted as an empty/healthy state: hydration retries
every minute and health delivery waits for persistence. The owner health view
uses its existing unknown status for unavailable checkpoints; paused preview
stays paused. Trading/protection messages and processing are independent.
Checkpoints are serialized and each delivery attempt is saved before transport;
acknowledgements are saved immediately afterwards.

There is no atomic transaction spanning Telegram and PostgreSQL: a hard crash
after Telegram accepted a message but before its acknowledgement was saved can
still cause a bounded retry. This is not an exactly-once delivery guarantee.
The checkpoint assumes one production source monitor, like the existing runtime;
it is not a distributed delivery lease.

The bot uses its own `btb_*` tables and $100 PAPER account in this project's
PostgreSQL database. It does not read or write the older receiver's `trading_*`
tables. The schema is represented in `lib/db/src/schema/bullet-bot.ts` so
development schema updates and publishing preserve these tables; `schema.sql`
is the original standalone SQL reference. The initial account is inserted once
at worker startup if the schema exists and the account row is absent.

The existing API Server workflow hosts its HTTP routes and PAPER worker. It uses
the project's `DATABASE_URL` and `TRADING_INGEST_TOKEN`; never put either value
in a source file. Keep `PAPER_ONLY_SIGNAL=true` (or leave unset) and never set
`EXECUTION_MODE=live`. Run offline tests with
`node --test artifacts/api-server/src/bullet-bot/test/*.test.mjs`.

Routes:

- `POST /api/trading/signals` — the existing Bullet sender URL, now handled by
  this bot. `POST /api/bot/api/trading/signals` is also accepted. Both require
  `x-trading-token`. A successful
  `202 {accepted:true,signal:{status:"pending",sourceSignalId}}` for a new
  signal proves a **durable enqueue**, not a fill. Idempotent retries return
  the stored status; reusing an ID with changed content gets 409.
- `GET /api/bot/api/trading/status` — same token; current PAPER wallet, recent signal
  results and open/closed position snapshots, including simulated realized PnL.
- `GET /api/bot/api/trading/market-health` — same token; checks official BingX
  public instrument and ticker requests from the running worker environment.
  A 503 with `bingx_access_denied` means PAPER entries cannot be quoted there.
  This endpoint never calls private account or order APIs.
- `GET /api/bot/healthz` — liveness and explicit PAPER mode.

Fresh (≤10 minutes), confirmed signals from all pattern IDs pass ingress;
the historical `experimental` label is informational, not an execution gate.
Malformed IDs, changed exit versions, legacy `corePct/runnerPct`, and stale signals fail closed. The worker
checks freshness again **before** an entry. Never replay the frozen samples
from Bullet's public contract: they have expired. No historical backfill or
automatic retransmission of rejected old events is implemented.

The worker validates BingX USDT perpetual contract filters in PAPER mode,
converts incoming `BTCUSDT`-style symbols to BingX `BTC-USDT`, and rounds
incoming quantities **down** to the exchange's quantity precision. It never
rounds up past the sender's size; it rounds down further against the actual
entry quote so a small market move does not push PAPER notional above $100.
The ledger conservatively
reserves the full $10 PAPER budget even if rounding produces a smaller position
(thus its effective leverage may be below 10x). The worker rejects unavailable
contracts and below-minimum orders. For long positions it rounds an unaligned
stop **up** to BingX price precision (toward entry, never enlarging downside);
if this reaches entry, it rejects the signal. It also rejects quotes exceeding the risk
cap. This is a separate execution result; a `202` alone is not proof that
the exchange would accept the order. There are no placeholders for
`supportsPlan` or `enqueue`: the validated contract is implemented in
`contract.mjs`, and `store.mjs` commits the queue before HTTP acknowledges.

The PAPER wallet starts at $100 and atomically reserves $10 per accepted
entry. Released collateral and simulated PnL are applied once on partial or
full exits. These figures omit fees, slippage, funding, liquidation, and
margin top-ups; they are **not** a live or guaranteed PnL statement. Partial
profit *advice* does not execute a sale. Impulse Buy uses 80% core and
20% runner; BTC uses its separate +1/+2/1-point ladder. The worker observes
public ticker prices every 3 seconds, not exchange order fills or continuous
intrabar highs/lows.

## Exchange execution

`bingx.mjs` implements only public contract and ticker reads. It contains
no API signing, wallet access, or order method. `bybit.mjs` is retained only as
inactive historical source; the active PAPER process does not import it.
Separately, the owner-only `GET /api/journal/bingx-connection` uses
`BINGX_API_KEY` and `BINGX_API_SECRET` for one signed read-only BingX mainnet
balance request. It returns a sanitized status, not account data or credentials.
The owner-only `GET /api/journal/bingx-live-preflight` performs three signed
read-only checks: initial USDT margin, existing positions, and one-way position
mode. Its response contains only booleans and blockers, never balances or
position details. Even if all three checks pass, it remains blocked: exchange
stops, fill/exit reconciliation, and isolated-margin top-ups are not implemented.
The owner chose no fixed cap on future BingX margin top-ups; $10 initial margin
is not a loss or funding cap. This choice does **not** activate trading.
The PAPER executor does not use these keys.
Live execution is unavailable. Disabling `PAPER_ONLY_SIGNAL` stops the service
instead of enabling trades. A queued receipt cannot be used as approval to trade.

## Staged LIVE components (not activated)

`live-store.mjs` and `btb_live_*` tables form a separate account/environment-scoped
ledger; the kill switch is on by default. `bingx-live-api.mjs` contains signed
read methods and capability-gated order/margin methods; `live-executor.mjs`
is injectable for offline tests only. Neither is imported by the production
PAPER request handler or worker. No historical PAPER or legacy rows are
backfilled into the live ledger, and receipt IDs must not be reused as a
reason to replay an old order. The published owner-only preflight remains
read-only and blocked on the current hedge account with an open position.
The isolated staged adapter can assess an otherwise clear symbol in hedge
mode, but requires no existing position or open order on that symbol, and
does not touch positions on other symbols. Do not alter the existing position,
account mode, leverage, or margin automatically. Pre-entry signals whose
stop requires a margin top-up are
rejected: margin cannot be added before a position exists, and opening first
would leave a liquidation gap. The separate post-fill top-up path records its
intent before a single attempt and halts on uncertain results. Stop amendments
and the `impulse_buy` runner are not executable with verified protection;
live activation must wait for those gaps to be resolved. A successful mock
does not authorize real writes.
The owner separately approved a non-executing API check. On September 25,
2026 a single signed request to BingX's documented `/openApi/swap/v2/trade/order/test`
returned HTTP 200, code 0. The request did not use `/trade/order`, submit
an account-setting change, add margin or close a position. Per BingX's API
documentation, `/order/test` does not create or fill an order and does not
enforce every check of the real order endpoint. It cannot establish that a
protective stop exists, that fills can be reconciled, or that an exit will work.
No live activation was approved. A real order must not be attempted as a
follow-up to this test without a separate explicit owner authorization.

The earlier receiver's stored history is preserved; rejected historical signals
are not replayed. A `202` from either POST URL proves enqueue, not a live BingX trade.