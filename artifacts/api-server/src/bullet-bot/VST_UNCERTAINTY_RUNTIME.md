# VST uncertainty runtime boundaries

`VST_UNCERTAINTY_POLICY.md` remains an assessment, not an authorization to
write to the exchange. The implementation below is VST-only. It adds no REAL
approval, schema migration, runtime DDL, expired-entry replay or wider price,
freshness or liquidation buffers.

## Shared reads and reporting

All six reviewed operations use the uncertainty classification/reporting
framework and their existing native proof adapters. Classification never
returns permission to retry a mutation. The durable read claim compares the
exact request, previous outcome, intent state and acknowledged native ID.
It records the original submission outcome, current refusal, attempt count
and next allowed read. Four attempts form an episode, followed by a five-minute
cooldown before another read-only episode. Exhaustion is not no-execution proof.

| Operation | Autonomous safe outcome when proof remains insufficient |
| --- | --- |
| entry | Isolate possibly filled exposure by symbol; reconcile exact order/fills/position/protection. Neither elapsed time nor present flatness proves an earlier POST did not execute. Do not replay an expired entry. |
| raise_stop | Independently verify the original floor and exact bot-owned position, then atomically retire active waiting into protected-degraded quarantine. If current protection cannot be proved, retain read-only isolation. |
| cancel_original_stop | Keep replacement protection. Reconcile the exact predecessor. Only a separately proven pre-transport refusal may use the existing guarded cancellation recovery; a possibly sent DELETE is not repeatable by classification. |
| margin_top_up | Quarantine all additional POSTs. Adopt an observed adjustment only with complete bounded native history, the exact position and corroborated baseline. Unchanged initialMargin/balance is not failure evidence. |
| close_pre_runner_split | Preserve existing leg accounting/protection. Reconcile exact close/fills and cancellation facts. Preserve the close-specific bounded retry guard and no-write provenance. |
| source_exit | Preserve the source decision separately from exchange close facts. Existing exact close/fill/cancellation adapters determine settlement; a source CLOSED state is not a MARKET fill. |

Unknown classes remain fail-closed and observable. This does not promise that
exchange uncertainty can always be eliminated.

## Protected-degraded stop retirement

Eligibility includes the pre-protocol persisted unknown core-only raise-stop
and journaled `post_started` ambiguity without an acknowledged native order ID.
The original request and its stronger price remain immutable.

The broker verifies exact entry identity/fills, a separate exact stop lookup,
the native position, full active stop coverage, settings, zero stop execution
and alias consistency. It reads two independent position/open-order cohorts,
not cached mutable evidence. A lookup's `positionID:0` needs exact independent
open-list linkage. Historical proof has a bounded read budget, followed by
the existing fresh evidence-to-ledger deadline.

The store locks the signal, position and intent; checks their exact saved
request/outcome/position version and reconciled entry; excludes competing
same-position intents; and atomically commits the position marker, retired
intent and notification. Position/CAS mismatch rolls everything back.
Intent retirement is **not successful original execution**: it keeps
`originalExecution: unknown_unproven`, no fabricated acknowledgement and
the original submission provenance.

Safe later actions: native observations, passive policy/peak observation and
the existing exact triggered-stop-fill reconciliation. Other symbols continue.
Quarantined effects: new stop POSTs, stop DELETEs, margin POSTs and strategy
MARKET closes for that position. Fresh source-exit decisions stay pending;
already submitted closes retain their exact reconciliation path.
The exact degraded source-exit barrier also admits an explicitly no-actions
management lane for that same source position. It remains a hard barrier for
entries and mutations, while native observations and exact protective-stop
settlement continue. A committed exact stop close can finish the source request
on the next tick, including after a cold restart.

If the requested stronger protection later appears, a distinct read-only
adapter can verify its current full coverage without using its timestamp as
proof of the original POST. An atomic second transition records
`protection_observed_attribution_unknown`; all quarantined effects remain
quarantined. It does not cancel the original floor or re-arm ordinary strategy
writes. Current journal and Telegram messages distinguish the verified floor,
deferred requested level, observation time and unknown original attribution.

## Read-only provider contract drift

The production VST native adapter observes successful existing GET responses
before normalization or proof refusal. This adds **zero** exchange requests,
orders, account-setting changes or database writes. It covers positions,
exact order/stop lookup, open stops, order fills, complete fill history and
margin-adjustment history. It neither repairs nor bypasses a failed proof.

Only fixed reviewed field names, primitive type sets, container names,
coverage categories and violation predicates enter reports. All field values,
IDs, symbols, quantities, prices, unknown key names, credentials and raw bodies
are discarded. At most 32 rows are inspected per response. Empty lists prove
no row shape; unsampled rows remain the strict adapters' responsibility.
Unknown row fields unrelated to proof are ignored; new history envelopes,
missing required aliases, conflicting aliases, invalid types, cursor metadata
and page-count/terminal shape changes are detected. This is not a completeness
certificate: totals across pages, exact fills and lifecycle coverage still
belong to the existing native proofs.

An incident requires three matching violations sampled at least a minute
apart, spanning at least five minutes. Healthy responses clear that lane's
qualification; first and continuation history pages are independent. Outages,
non-success provider responses and parse failures never count as shape drift.
A 30-minute observation gap or clock rollback restarts qualification. This
passive check has no coverage of endpoints that have not recently been read;
it makes no claim that an idle or unreachable endpoint still meets its contract.

Alerts have their own production-only Telegram/log path, not the signal-health
or conflicting-intent path. Delivery is non-blocking, retries require another
qualified read and five minutes, and an acknowledged fingerprint is suppressed
for 24 hours. Six endpoint lanes (two history lanes each) and 32 acknowledged
fingerprints bound in-memory state. Dedupe is process-local: a restart requires
fresh sustained observations and can alert again; no production rows are
mutated to persist monitoring state. No per-GET outage or recovery alerts.

## Offline verification

The BTW fixture is a read-only copy of the actual pre-protocol persisted
intent, position and reconciled entry. Runtime tests use its unedited request
through native broker evidence and strict transaction/CAS persistence, including
restart, read outage, stale/changed evidence, racing claims, rollback and
observational recovery. No test connects to BingX or changes production data.
Runtime coverage also enables source-exit processing with a pending decision:
it verifies stronger-stop observation, exact triggered-fill ledger settlement
and subsequent durable source-request completion without exchange mutations.

The broader bot suite retains operation-specific entry, margin-history,
stop-transfer, source-exit and pre-runner-close safety tests. Passing development
tests is not a claim that the published position has recovered: runtime adoption
occurs only after publication and successful fresh exchange proofs.