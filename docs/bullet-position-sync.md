# Bullet → executor position reconciliation

The bot worker reads `GET https://crypto-alt-bullet.replit.app/api/trading/position-sync`
every 60 seconds (within the producer's 1–5 minute contract) in production using the existing `TRADING_INGEST_TOKEN` in the
`x-trading-token` header. It requests every page with `afterId`; a failed,
stale, invalid, or incomplete response does not change any position. Do not
log or expose the token or the complete response.

Preview does not subscribe automatically: it shares the source credential and
provider request budget with the publication. Local source-polling tests can
explicitly opt in with `BULLET_SOURCE_SYNC_ALLOW_DEVELOPMENT=true`; do not leave
that enabled alongside production without accounting for the shared budget.
This does not disable the published source-sync watchdog or trading worker.

Recognized transient GET failures get at most two attempts per page within the
same 10-second deadline for the entire snapshot. Authentication errors and
invalid/incomplete snapshots are not retried as transient failures. A bounded
`Retry-After` pauses subsequent polls (up to five minutes), not existing durable
queue consumers. The 60-second freshness status remains active during outages;
it is deliberately separate from Telegram paging.

## Health notifications

Short HTTP/transport failures are recorded in Bot Health rather than immediately
sent to the owner. A source warning requires three minutes without a fresh
complete admitted snapshot and at least three failed attempts. Five minutes
without fresh evidence is critical even when a request hangs and cannot finish.
Severity escalation is sent separately; identical unresolved alerts repeat no
more often than every 30 minutes.

Recovery requires at least two successful complete admissions spanning 30
seconds, with failures or renewed staleness resetting the stability window.
Only a successfully delivered warning can produce a recovery message. If an
undelivered incident stabilizes, it clears silently instead of sending an
outdated alarm. These rules do not filter trade-state or protection notifications.

The owner-only `/journal/health` page reads local runtime telemetry and ledger
aggregates. Its API does not query the exchange or initiate trading/Telegram
actions. Source freshness, worker cycles, received entry queue, unresolved
operations and the VST event outbox remain separate measurements. Missing or
stale evidence is unknown, disabled components are paused, and a successful
worker cycle does not prove any particular fill or protective stop.
Logs and alerts retain reviewed HTTP/transport metadata, never response bodies
or credentials. Recovery requires a fresh full snapshot admitted to all required
queues; it is not proof that every exchange close has executed.

Production requires explicit `sourceAction` on every returned record. An old
producer publication is refused as `source_action_contract_not_published`;
publish both the source and the executor to activate the new contract.
Pagination retains every page (200 records by the producer's contract), exact
sourceSignalId matching, and the full-snapshot consistency checks. The action
is included in double-sweep fingerprints.

### Nullable source status

A read-only production check on 2026-10-25 found three cards on page 3
with the exact pair `sourceStatus: null`, `sourceAction: "unknown"` in a
443-record response. The previous local status enum rejected that pair as
`invalid_source_status`. The producer's prior written contract did not specify
nullable statuses; the observed pair provides no lifecycle meaning beyond the
explicit unknown action.

Accept **only** that null/unknown pair as an observation, preserving the raw
null. It is not a synonym for expired, cancelled, closed, or absent. Even
populated closure/price/stop fields on that card do not authorize an exit or a
protection change. Null with hold/close/review, a missing status, and novel
unrecognized statuses remain validation failures.

Other cards' independently validated explicit commands may proceed only after
the entire collection is acquired and validated, including both stable sweeps
when page timestamps differ. This is not partial-result recovery: transport,
body, pagination, freshness, duplicate or consistency failures still reject
the whole acquisition. Unknown and absent cards never prove position closure;
VST still requires exchange-backed execution and REAL remains read-only.

Every completed poll logs record count and hold/close/review/unknown counts.
Permanent contract/authentication failures produce an immediate, throttled
Telegram alert. Transport outages retain the existing sustained-fault policy
above. Poll failures log to stderr. An absent or >10-minute-old sourceUpdatedAt
is logged as informational record-change metadata, not an availability alarm.
An unchanged signal may legitimately retain its update time while fresh complete
polls succeed. Availability uses snapshot asOf and successful admission; record
age never fabricates a fill or rejects a historical close. Discrepancy alerts
include the current source action/status, local ledger status, and snapshot/check
timestamps. Authorization and missing/invalid action-contract failures have
distinct messages; identity mismatches do not suggest an unproven publication
failure or claim an exchange position is still open.

Bullet only returns signals previously delivered to this bot. The fields
`sourceStatus`, `sourceClosedAt`, `sourceExitPrice`, source PnL, and source stops
describe **Bullet's** state, not an executor or exchange fill.

- `sourceAction=close`: Only `profit`, `stop_loss`, `bu_stop`, `breakeven`, or
  `expired` with a valid sourceClosedAt after local entry authorizes an exit.
  sourceExitPrice may be null; it is not required to reduce the position.
  BTW and other historical positions take this same path on the first poll.
  PAPER: Exact source ID and symbol must match an open local position.
  The source exit price is evidence of a lifecycle transition, **not** the
  PAPER fill price. The worker gets a fresh BingX public swap bid, applies
  its own fee/funding/accounting rules, and atomically closes the remaining
  quantity with source provenance. Retrying cannot settle the same close
  twice.
- VST: Explicit source closure queues an immutable,
  idempotent exit instruction. The guarded VST worker requires verified exchange
  execution, flatness and owned-stop cleanup before recording closure.
  Source PnL and stops never update VST exchange facts.
- `sourceAction=hold`: A numeric sourceLastMilestone >=5 for altcoins requests
  breakeven at the executor's actual entry price. A positive
  sourceTrailingStopLevel is an absolute USDT contract price; it can only raise
  the requested floor. It applies to each surviving core/runner leg, never
  revives closed quantities, and never lowers an exchange-confirmed stop.
  Source levels enter the existing guarded stop-transfer mechanism, not direct
  exchange writes. A crossed source floor requests an exit at a fresh observed
  quote, never a fill at that historical level. An ambiguous prior transfer
  still forbids replay/raises; independently proved exits remain separate.
  BTC retains its separately approved local breakeven policy.
- `review` (`cancelled`/`reclassified`) and `unknown` (including absent rows):
  Persist/log observational markers; never create source-driven closes.
  Legacy withdrawal/cancelled queue records are excluded from new dispatch,
  without erasing history or declaring ambiguous writes unsent. Already sent
  operations still require exact reconciliation and cleanup.
- REAL: A source/local mismatch is reported for inspection. This sync does
  not enable live execution, modify orders, or implement a recurring REAL
  exchange reconciliation worker. REAL ledger corrections require verified
  BingX fills/positions and the separately authorized live execution flow.

Exchange-mode comparisons currently appear in API worker logs; they are
read-only and are not durable ledger events. The new sync becomes active in
the published app only after this project is published.