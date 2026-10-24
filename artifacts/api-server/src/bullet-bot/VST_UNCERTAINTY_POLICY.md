# VST uncertainty: classification and autonomous outcomes

Status: assessment and proposed policy, not an implemented recovery mechanism.
Scope: BingX VST only. This document does not enable REAL trading, authorize
blind exchange-write retries, or resolve any existing production intent.

## Classification is by evidence and phase, not operation name

1. **Read uncertainty:** a known identity can be checked, but a current request
   failed, returned an incomplete history, or preceded exchange visibility.
   Retry bounded reads with backoff and independent corroboration. Preserve
   the first failure, subsequent failures and successful verification.
2. **Execution-attribution uncertainty:** a write might have crossed transport,
   but there is no independently recoverable identity or unique adjustment
   attribution. More reads may establish current safety without establishing
   whether that write executed.
3. **New/unclassified failure:** no reviewed autonomous outcome applies.
   Isolate it, preserve evidence and escalate explicitly.

Finite retries cannot guarantee eventual evidence: outages, history retention,
missing aliases and interrupted persistence can outlast the read budget. Budget
exhaustion must not be converted into evidence that a write did not execute.

## Operation matrix

| Operation | Recoverable read path | Structural / attribution gap | Conservative autonomous outcome |
| --- | --- | --- | --- |
| `entry` | Original client ID or exact exchange ID, order history, unique fills, exact position and independent protection. | Missing/contradictory identity after a possibly sent MARKET request; history is not guaranteed to retain a usable client alias. | No duplicate entry and no replay of an expired signal. Continue independent reads; isolate that symbol and report observed exposure/protection separately from entry attribution. |
| `raise_stop` | Persisted new-stop ID, old/new stop states, exact position and quantities; durable stop-transfer stages. | Native STOP_MARKET lacks a supported client-order identity; a pre-protocol request may lose its acknowledgement. A parent stop-loss echo is not a child-stop proof. | Retain independently verified full protection. A reviewed protected-degraded outcome may retire active waiting without claiming the old POST failed or succeeded. It must not implicitly authorize resending that POST or treat the requested higher level as installed. |
| `cancel_original_stop` | Exact predecessor ID, cancellation/fill status and independently verified replacement coverage. | Interrupted DELETE without durable outcome; absence in a returned list alone does not prove cancellation or exclude a fill. | Preserve replacement coverage; do not cancel by approximate identity. A fresh attempt requires operation-specific permission/provenance and the existing final protection guard. |
| `margin_top_up` | Complete adjustment history tied to the exact position, unique amount/window and validated baseline; independent liquidation/stop checks. | No exchange-side idempotency key or operation ID. Same-amount adjustments can be externally initiated. Entry `initialMargin` and account balance are not current margin-addition proofs. | No blind second top-up. Adopt corroborated observed margin with honest attribution; if still ambiguous, prohibit further additions and continue approved risk/protection monitoring. |
| `close_pre_runner_split` | Exact order/client identity, complete entry-anchored fills, remaining quantity and owned stops. | Missing transport provenance or incomplete lifecycle history. An unchanged current quantity alone is not universal no-send proof. | Only existing evidence-qualified retry paths, with bounded backoff. Preserve uncertainty otherwise; do not recreate a closed runner or substitute current flatness for exact exit fills. |
| `source_exit` | Durable source decision plus exact exchange close/fill proof and stop cleanup. | Source closure does not establish an exchange close; an ambiguous MARKET close has the same attribution gap as other exits. | Keep the source decision durable. Reconcile exchange effects independently; no duplicate close from repeated source observations and no fabricated fills. |

## Protected-degraded is not successful execution

For a known stop-transfer ambiguity, the intended autonomous fallback is:

- Check exact current position ownership, quantity and full active protection.
- Preserve the unresolved original write attribution and original requested
  level permanently.
- Distinguish the verified current protection from the deferred stronger level.
- Isolate unsafe writes, not unrelated symbols or all read-only monitoring.
- Report a known degraded outcome without requiring routine owner approval.
- Never enable a new stop write merely because the original intent has been
  removed from the active queue. That permission needs a separate reviewed
  protocol, fresh guards and operation-specific evidence.

This fallback requires its own persistence, restart and concurrency semantics.
It must not be implemented as setting an existing unknown intent to successful,
discarding it, or routing it through an unrelated manual-resolution procedure.

## Evidence and references

- `BINGX_EXCHANGE_CHECK.md`: historical controlled VST observations, missing
  client aliases, margin ambiguity and limitations of cancel-first replacement.
- `bingx-live-api.mjs`: current native reads and transport guards; STOP_MARKET
  client-ID restriction, exact-ID recovery and persisted stop-transfer stages.
- `vst-worker.mjs`: current reconciliation, operation-specific recovery,
  symbol isolation and source-exit decisions.
- `vst-close-retry-guard.mjs`: bounded retry policy for one qualified close
  scenario, not a generic unknown-to-retry permission.
- BingX official swap endpoint reference:
  https://github.com/BingX-API/api-ai-skills/blob/main/skills/swap-trade/api-reference.md

The historical cancelReplace limitation does not describe the whole current
VST implementation: the current durable transfer protocol keeps the predecessor,
places/verifies the replacement and only then performs guarded retirement.
Historical records do not retroactively acquire that transport provenance.