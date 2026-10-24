# Crypto Alt Bullet → PAPER intake

Use the published HTTPS `/api/trading/signals` with `Content-Type: application/json`
and the private `x-trading-token` matching `TRADING_INGEST_TOKEN`. Never send
exchange credentials or the control token. The owner controls PAPER entries
separately. HTTP 202 is a receipt, not a fill or an exchange order.

The accepted shape is in `lib/api-spec/openapi.yaml`. The receiver requires a
confirmed, approved entry from one of `balanced_grind`, `liquidation_cascade`,
`price_led_momentum`, `impulse_buy`, with `sourceSignalId` matching
`cab-signal-<integer>` and an exact supported `bullet-long-exits-v2` policy.
The sender supplies `side=buy`, `orderType=market`, `reduceOnly=false`,
`quantity`, `referencePrice`, `limitPrice`, `stopLoss`, and the `payload`
including `source=CryptoAltBullet`, isolated 10× and initial margin `"10"`.
The receiver does not substitute a size or stop; $10 is reserved PAPER margin,
not $10 notional or a maximum loss. Supplied nominal exposure cannot exceed
$100 in this PAPER model. `limitPrice` is a market reference, not a limit order.

One supplied `liquidation_cascade` event establishes the exact supported
common policy fields. Fresh matching events from **all four approved patterns**
can enter PAPER while the owner enables PAPER entries. Impulse Buy additionally
requires its exact runner plan, with break-even stop at opening. This is a
receiver-side supported contract, **not proof that all four live relay payloads
have been observed**. Unknown policy fields or values are rejected rather than
interpreted as a substitute strategy. The sample URL
at https://crypto-alt-bullet.replit.app/trading-bot-sample.json served the
login page rather than JSON without authentication. Runner break-even at
opening follows the owner's later direct correction, whereas the public handoff
says after core closure; verify the sender's actual Impulse event before claiming
live compatibility. No live exchange orders are enabled.

Freshness is checked both on arrival and again before PAPER execution: at most
10 minutes old, and no more than 30 seconds in the future. A stale or paused
event can be recorded as `awaiting_rules` with a reason, but cannot later enter
the execution queue. Unknown policies and unsupported patterns are rejected.
An exact replay of an already accepted ID returns `duplicate=true`; changed
details yield 409. Entries have a supplied initial stop. Ordinary/core stops
upgrade at +5% (BTC +1%), +10%, and trail after +15%; there is no fixed TP
or automatic four-day close. The impulse runner gets an entry-price stop at
opening, trails at +30% with a 30-percentage-point gap, and expires at 120
hours. Later smart-cancellations cannot be inferred from an entry event.

PAPER uses a reference-price simulated fill and indicative Binance Spot bids
for subsequent protection checks. They are not Bybit fills or proof that the
same derivatives instrument is available. Consult the journal's order and
audit entries to distinguish signal receipt, simulated entry, and linked exits.
Previously filled v2 PAPER entries retain their recorded stop and 96-hour
policy (core only for `impulse_buy`); the first monitoring pass writes a
`legacy_paper_policy_retained` audit event. That historical exception does
not apply to new entries.