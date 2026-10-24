# Fresh VST entry sizing and refusal monitoring

## Approved boundary

VST only. Source stop and exit rules are unchanged. Native MARKET still has
no exchange-enforced fill-price cap. The final quote, account/protection,
budget and freshness guards remain mandatory. No historic signal replay.

`maxSlippageBps: 20` comes from the shared configuration in server.mjs:
20 basis points = 0.2%, plus rounding upward to one contract price tick.
There is no liquidity-dependent adjustment. This change does not widen it.

## Submission sequence

1. Reserve the unique intent and mark submission started, as before.
2. Finish the full native exchange preflight's slow reads.
3. Read a fresh ask; recompute quantity, margin, fee reserve, funding reserve,
   top-up estimate and the bounded planning price from that snapshot.
4. Check native stop risk, settings, symbol flatness and funding availability
   against the recalculated quantity/price using the same native read results.
5. Atomically replace only the pricing fields of the unacknowledged intent.
   The old request must match, it must still be at submission_started, and a
   second reprice is prohibited. Persistence failure means no order POST.
6. Read the final ask and apply the unchanged bound and budget checks.
7. At the transport guard, refuse stale sizing/source quote or an expired
   signal. Capture the actual transport-start timing without an awaited
   telemetry write delaying the order.

Impulse entries are still floored to representable 80/20 lots. Both tranches
are recomputed and persisted with the new total. Post-fill verification uses
the same updated durable request.

The reprice happens AFTER reservation but BEFORE transport, not before
reservation: otherwise the native preflight could make it stale again.
An ambiguous transport is never permission to resize or submit a second time.

## Permanent monitoring

Every five minutes, the API runtime emits `Bullet VST entry health` with
1-hour, 24-hour and 7-day windows, distinct attempted signal counts,
`final_quote_out_of_bounds` counts and refusal percentages. Windows use signal
receipt times, matching the original investigation. Two cohorts are shown:

- `all`: legacy and new attempts combined.
- `fresh_sizing`: only new intents using the fresh-sizing submission policy.

The ledger provides durable counters across restarts. Missing historical
submission causes cannot be reconstructed; the counts are observed failures.
Empty windows have a null percentage, not a claimed 0% success/failure rate.

Transport events provide p95/max calculation-to-actual-transport latency.
Null timing means no observed transport-start evidence, not zero latency.
Telemetry persistence errors produce diagnostics without delaying submission.

Production Telegram alert: fresh-sizing 24-hour cohort has at least 5 attempts,
at least 3 quote-bound refusals, and a refusal fraction of at least 20%.
Alerts are limited to one per six hours, with sent-alert evidence in the
existing telemetry ledger for restart cooldown. Telegram uses the same
production/chat configuration as the other VST alerts. No automatic widening,
retry of expired signals, REAL activation, or order submission by the monitor.

## Before/after evaluation

Read-only production baseline at 2026-10-03 19:09 UTC:

| Window | Attempted signals | Quote-bound refusals | Fraction |
|---|---:|---:|---:|
| 24 hours | 14 | 8 | 57.1% |
| 7 days | 43 | 12 | 27.9% |

The new cohort was empty at that time: code changes had not been published.
After publishing, use fresh_sizing rather than the mixed legacy window to
judge the fix. Report sample counts alongside percentages; do not claim
improvement from an empty/tiny sample. Compare refusal fraction and p95/max
calculation-to-transport age together. Persistent high refusal fraction with
low age does NOT prove illiquidity by itself; spread/depth evidence and an
explicitly approved price-buffer policy would be separate work.