# Bounded BingX VST historical-close evidence

## Official contract checked on 2026-10-01

The official [Query historical transaction details](https://bingx-api.github.io/docs-v3/#/en/Swap/Trades%20Endpoints/Query%20historical%20transaction%20details)
documents `GET /openApi/swap/v2/trade/fillHistory`, including the VST host.
The deployed documentation source is
`https://bingx-api.github.io/docs-v3/static/js/app.8bc50bc0c8a6a308c3e4.js`;
the same official asset is preserved at
`https://raw.githubusercontent.com/BingX-API/docs-v3/1e8fae7f702525e99fdf7cf96b67070b51c33644/static/js/app.8bc50bc0c8a6a308c3e4.js`.

Relevant documented clauses:

- “Maximum range: [From current date] up to past 7 days & maximum of 1000 historical filled orders.”
- “startTs < orderList <= endTs.”
- `pageIndex` must be greater than zero, default 1.
- `pageSize` must be greater than zero, default 50, maximum 1000.
- `lastFillId`: “The last tradeId of the last query, default is 0 if not filled in.”
- `data.fill_history_orders`, `data.total` (“total records”), exact `tradeId`
  and `orderId`, quantity, price, signed commission, commission asset,
  `filledTime`, side, position side and `realisedPNL`.

The older `allFillOrders` endpoint still lacks a verified completeness
contract. It is never used as complete-history evidence. No operator flag
can make its ordinary filtered responses complete.

## Supported proof and explicit limitations

Only a recent, unsaturated fixed window is supported. The collector requests
the **entire settlement-currency scope**, without an order or symbol filter:

1. Request page 1 with maximum `pageSize=1000`.
2. Reject a missing/invalid count, a count different from the number of raw
   rows, or either count/row length reaching 1000. Do this before filtering.
3. Validate every raw fill's lossless IDs, symbol, unique symbol/trade identity
   and timestamp within the documented exclusive-start/inclusive-end interval.
4. Require page 2 to contain no rows. An empty terminal page without the
   preceding verified page is not proof.
5. Repeat the identical first and terminal pages. Require identical raw
   contents (canonical SHA-256, order independent) and counts.
6. Filter by symbol only after these checks. Record scope, bounds, raw counts,
   endpoint, terminal page, pass count, digest and observation time.

This is intentionally not cursor pagination beyond 1000 rows. The documented
ceiling means such a result may have been truncated. Larger, changing,
malformed or out-of-retention windows fail closed; the ledger is not repaired.
The broker covers the interval before entry through a fixed current end with
contiguous `(start,end]` windows, without gaps.

Observed VST responses sort newest first despite the documentation's
ascending-sort clause. The empty second page returns `total=0` while the
nonempty first page reports its raw record count. The collector therefore
does not assume ascending order, a global terminal-page total, cursor/page
interaction, or a provider snapshot token. Two identical bounded snapshots
are the collected evidence, not an unbounded historical guarantee.

## Read-only confirmation of the two existing cases

Checked on 2026-10-01 at approximately 05:24 UTC with the real broker proof
path and a GET-only, VST-host-only transport; no exchange writes or production
database writes were performed.

| Symbol | Entry order | Close order | Position | Full quantity |
| --- | --- | --- | --- | --- |
| ONDO-USDT | 2104525915665989633 | 2104898311866548225 | 2104525915800207361 | 18879.30 |
| US-USDT | 2104952955909177345 | 2104992365002358785 | 2104952956043395073 | 486594.7 |

ONDO's three raw windows contained 1, 5 and 8 records; US's two windows
contained 8 and 4 records. Every window passed both full snapshots and
terminal pages. Each symbol yielded exactly its one entry and one full exit.
Exact order lookups corroborated position IDs, executed volume, prices,
FILLED status, LONG side and reduce-only market exits. Fresh symbol position
and open-order lists were empty. The proof run made 28 GET requests.

Native signed commissions from `fillHistory`:

- ONDO: entry `-4.911639 VST`, close `-4.912394 VST`.
- US: entry `-4.905391 VST`, close `-4.592221 VST`.

The provider's close `realisedPNL` is retained verbatim (`1.51021000` for
ONDO, `-626.34076770` for US). It differs from multiplying the rounded fill
prices by quantity. The journal must not substitute that calculation.
VST commissions are displayed in their own asset, without an invented
conversion to USDT; funding and final net PnL remain unverified.

## Atomic recovery, not manual resolution or replay

Recovery remains a guarded, post-management worker action: at most one
candidate per otherwise eligible tick, never after an exchange action was
attempted in that tick. It sends no new orders and never replays a signal.

The store checks proof facts again, uses the exact candidate snapshot,
timestamp version, signal state/reason and entry-intent preconditions, and
rejects unresolved own intents. A shared transaction-scoped per-signal lock
serializes intent writers and recovery, including absent-row insertion races.
Fresh flat-read evidence is rechecked after locks. Position, signal and
exchange-history provenance commit together; repetition is idempotent.
Original error details remain in the retained snapshot/provenance.

This document records a read-only confirmation, **not** a claim that the
published ledger has already been changed. The published worker must receive
the new code and obtain fresh proof before it can repair those records.