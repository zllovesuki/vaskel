# Why a 40-result search read 100,119 rows

A room search requested forty results. SQLite read 100,119 rows to produce them.
At 60 searches per second in a local load test, search p95 reached 4.6–4.8
seconds. In a mixed workload, sending a message in another room of the same
owner also took about five seconds at p95.

The query already had indexes and `LIMIT 40`. Most of its work happened before
that limit could stop anything.

A circle's rooms share one full-text search (FTS) index. Search must find the
newest matching live messages in the requested room, rather than the newest
matches anywhere in the circle. That distinction determines where filtering and
early termination can happen.

## Where the limit arrived too late

The original query used an FTS subquery as a membership test:

```sql
SELECT messages.* FROM messages
WHERE channel_id = :room AND deleted_at IS NULL
  AND created_sequence IN (
    SELECT rowid FROM message_fts WHERE message_fts MATCH :phrase
  )
ORDER BY created_sequence DESC LIMIT 40;
```

The native workerd plan contained:

```text
SEARCH messages USING INDEX messages_history (channel_id=? AND created_sequence=?)
LIST SUBQUERY 1
  SCAN message_fts VIRTUAL TABLE INDEX 0:M2
```

`LIST SUBQUERY` explains the cost. SQLite first collected matching row IDs across
the owner, then used that list to find messages in the room. The outer query
could stop after forty results; building the list still processed every FTS
match. A rare term made a small list and hid the problem. A common term made a
100k-row list for the same page size.

```mermaid
flowchart TB
  subgraph Original[Original plan]
    direction LR
    A[Owner-wide FTS matches] --> B[Collect all matching row IDs]
    B --> C[Find live messages in the room]
    C --> D[Return newest 40]
  end
  subgraph Streaming[Streaming plan]
    direction LR
    E[Read live room endpoints] --> F[Yield FTS matches newest-first]
    F --> G[Look up and filter each message]
    G --> H[Stop at 40 results or end]
  end
```

## Let FTS stop at forty

[Index ingestion](../../apps/server/src/actors/shared/search-index.ts) assigns
each FTS row ID the message's immutable creation sequence. Ordering by FTS row ID
therefore preserves newest-first results without sorting all canonical matches.
The retained query has this shape:

```sql
SELECT messages.* FROM message_fts
CROSS JOIN messages
WHERE message_fts MATCH :phrase
  AND message_fts.rowid >= :oldest
  AND message_fts.rowid <= :newest
  AND messages.id = message_fts.message_id
  AND messages.channel_id = :room
  AND messages.deleted_at IS NULL
ORDER BY message_fts.rowid DESC LIMIT 40;
```

Its native plan traversed FTS and probed the message primary key:

```text
SCAN message_fts VIRTUAL TABLE INDEX 192:M2><
SEARCH messages USING INDEX sqlite_autoindex_messages_1 (id=?)
```

Both queries returned the same forty messages from the dense 100k fixture:

| Query                        |                    Native rows read |
| ---------------------------- | ----------------------------------: |
| Original `IN` subquery       |                             100,119 |
| Ordered FTS with room bounds | 81: 79 for search + 2 for endpoints |

These counters exclude authorization and message enrichment. `SCAN` in the
virtual-table plan does not, by itself, mean all 100k matches were visited. The
row counts show where execution actually stopped.

SQLite normally chooses join order. Here,
[CROSS JOIN](https://www.sqlite.org/optoverview.html#manual_control_of_query_plans_using_cross_join)
keeps FTS as the outer traversal. The equality predicate still connects each
match to one canonical message through its primary key. Room and deletion
filters run before `LIMIT`, so another room's matches cannot consume the page.

## A quiet room still has expensive neighbors

The dense fixture let the query stop almost immediately: its newest matches
belonged to the requested room. Put only the oldest hundred messages in that
room, with all newer matches elsewhere, and streaming without bounds still
overloaded. The limit could stop only after finding forty matches that survived
the room filter.

Reading the room's oldest and newest live creation positions first gives FTS a
range. This avoids canonical lookups for matches outside that range and skips
FTS entirely when the room has no live messages. Other rooms can still have
interleaved positions, so the room filter remains necessary. FTS itself can still
visit out-of-range entries internally; the bounds do not make total work
independent of the owner's history.

Inlining the bounds into a creation-position join produced per-message MATCH
operations or canonical range scans in the tested plans. A separate endpoint read
and message-ID join retained the FTS-first traversal and primary-key lookup.
In the [implementation](../../apps/server/src/actors/shared/synchronization.ts),
authorization, endpoints and search remain in one native transaction, preserving
the [search contract](../messaging.md#search-admission-and-continuation).

## Finding nothing took 20,001 reads

Finding the two endpoints introduced another search. Without explicit index
selection, a room with 10k live messages took two reads. Soft-delete every
message, and it took 20,001 reads to discover that the room was empty.

SQLite had selected the general history index, which includes tombstones. It
walked deleted messages from both ends to prove that none remained live. The
existing partial index could answer that question without visiting tombstones:

```sql
CREATE INDEX messages_live_history
ON messages(channel_id, created_sequence DESC, author_id)
WHERE deleted_at IS NULL;
```

Comparing planner choices in native workerd, for a room containing 10k messages:

| Room contents                                      | Unforced, no statistics | Unforced, after `PRAGMA optimize` | Forced live index |
| -------------------------------------------------- | ----------------------: | --------------------------------: | ----------------: |
| All live                                           |                       2 |                                 2 |                 2 |
| One live message in the middle, all others deleted |                  10,001 |                                 2 |                 2 |
| All deleted                                        |                  20,001 |                                 0 |                 0 |

These are total endpoint reads; each fixture also had one live message elsewhere.
The same pattern held at 100 and 100k messages. The empty 100k room required
200,001 reads without statistics.

`PRAGMA optimize` populated `sqlite_stat1`, and SQLite chose the live index on its
own for the tombstone fixtures. For all-live rooms, it kept `messages_history`
and still needed only two reads. Choosing a different index mattered only when
the general index contained rows the query had to skip.

The timing of statistics collection changed the result. Collect them while all
10k room messages are live, then soft-delete those messages, and both
`PRAGMA optimize` and its startup form, `PRAGMA optimize=0x10002`, keep the old
statistics. The query reads 20,001 rows again. Explicit `ANALYZE messages`
refreshed the statistics and reduced endpoint reads to zero, at a cost of 40,017
reads for the analysis itself.

SQLite's current [optimization heuristic](https://www.sqlite.org/pragma.html#pragma_optimize)
uses missing index statistics or a tenfold change in table size to trigger
analysis. Soft deletion shrinks the live index while retaining the table's rows.
Running `optimize` more often therefore does not necessarily refresh the
statistics that matter here.

The current endpoint queries still use
`FROM messages INDEXED BY messages_live_history`.
[INDEXED BY](https://www.sqlite.org/lang_indexedby.html) is a requirement, not a
hint: preparing the statement fails if the named index is missing or unusable.
SQLite documents it as a last resort for locking down a plan, not a tuning tool.
Removing it alone reproduced the tombstone regression, and scheduled `optimize`
alone would not cover the stale-statistics case. These findings explain the
current guard; they do not establish that pinning is the only viable query or
index design.

Existing [owner-alarm passes](../synchronization.md#owner-maintenance-lifetime)
also request opportunistic statistics maintenance. Search still needs its bound
when those statistics lag.

Both inefficient queries returned correct results. The
[regression tests](../../apps/server/tests/room-search.test.ts) also measure
native row reads, so a correct page cannot hide a return to history-sized work.

## Search was also delaying chat

With 100k messages and 10 searches/s, the first streaming query reduced
dense-search p95 from about 24 to 8 milliseconds. At 60/s, the difference grew
to seconds: four alternating
original–streaming–streaming–original runs measured 4.78/4.62 seconds for the
original and 6.21/6.26 milliseconds for streaming. Each run lasted 60 seconds.
The larger gap includes avoiding overload and accumulated waiting, beyond the
reduction in individual query work.

The final query added room bounds and explicit live-index selection. Compared
with the original query, using the same synthetic 100k-message owner and 60
searches/s:

| Workload                                 | Original query p95 (ms) | Final query p95 (ms) |
| ---------------------------------------- | ----------------------: | -------------------: |
| Dense room                               |           4,779 / 4,623 |          6.24 / 6.31 |
| Only the oldest 100 messages in the room |                  10,000 |        53.56 / 48.77 |
| Empty room                               |                   3,382 |                 5.38 |
| Dense search during mixed traffic        |           5,007 / 5,061 |                31.43 |
| Same-owner Send during mixed traffic     |           5,340 / 5,147 |                37.70 |
| Same-owner snapshot during mixed traffic |           5,391 / 5,107 |                42.91 |
| Same-owner replay during mixed traffic   |           5,147 / 5,170 |                40.65 |

Slashes separate repeated runs. Original dense runs lasted 60 seconds; final
dense runs lasted 30 seconds. Oldest-only and empty-room runs lasted 30 seconds,
and mixed runs lasted 60 seconds. The final measurements were follow-ups to the
original comparison, not another alternating series.

Mixed traffic offered Send, snapshot and replay at 5/s each in a second room of
the search owner and in a different owner, alongside 60 searches/s. Original
dense runs had 113/122 errors out of 3,601 attempts each. The original oldest-only
run had 448 errors and 397 dropped iterations; mixed runs dropped 419/424
iterations and had errors across all operation classes. The final cases had no
errors or dropped iterations, and successful searches returned the expected
ordered IDs. The percentiles include failed attempts; they are not successful
response-time guarantees.

## What the measurements establish

Native comparisons covered 1k/10k/100k histories, common/rare/absent terms and
dense, interleaved, oldest-only and empty-room distributions. Rare, absent and
interleaved HTTP controls were measured after adding room bounds, before explicit
endpoint index selection. The core SQL plan and row-count excerpts above are
also from that stage. The HTTP runs did not include opportunistic statistics
maintenance.

HTTP tests used disk-backed local workerd through Wrangler, with k6 on an AMD
EPYC 4344P. Application and load generator used separate CPU allocations; local
tracing was disabled. Each run restored the synthetic fixture and checked search
results against independently selected canonical message IDs.

All local actors shared the runtime. The mixed-load results do not isolate
owner-local waiting from shared CPU pressure or establish interference between
distributed production actors. The oldest-only case still used approximately
one logical CPU at 60 searches/s; total FTS work remains sensitive to owner-wide
match volume. Cross-circle search, larger-history capacity and long-running
stability were outside the experiment.
