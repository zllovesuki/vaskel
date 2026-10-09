# Messages, quotes and search

## Durable command acceptance

A successful Send acknowledges committed state, not recipient delivery. Current
authorization, command identity, expected version, message/file claims, FTS,
sequence, replay event and receipt commit in one owner transaction. Broadcast
follows commit. Infrastructure failures must reject the transaction before
becoming sanitized errors; returning normally after a partial write would
acknowledge broken state.

Retry the original command ID, issue time and exact payload. Bind its
fingerprint to sender, scope and operation; changed payloads conflict. Recover
accepted receipts under current read authority before applying new-send
blocking/capacity or claiming files again. Expired retries cannot become new
messages after receipt pruning. Send receipts and socket events may arrive in
either order and reconcile to one message.
[Command admission](../apps/server/src/actors/shared/message-command.ts) owns retry
validity. Command and block receipts become eligible for physical reclamation
after seven days; [owner retention](operations.md#retention-and-incident-handling)
defines the shared bounded schedule and durable wakeup.

The client completes an accepted command from its durable receipt and lets the
active connection reconcile independently. A cleared composer does not promise
that its row is already visible; receipts insert no optimistic row and advance
neither replay nor private reads.

Only a newly committed Send offers a best-effort [browser push reference](notifications.md#message-eligibility).
Receipt recovery does not offer again, and alert failure cannot undo Send.

Creation position is independent of edit/delete event position. Edits and
reactions must not create new unread arrivals. Reactions advance the update
sequence without consuming a text-edit version; every materializer computes the
reader's own reaction flags. Tombstones expose no reactions or mentions.
Authoritative mentions are derived from the shared parser and validated against
current channel access inside send/edit, never accepted from a separate client
list. Edits replace that set without moving creation position.

Implementation: [mutations](../apps/server/src/actors/shared/messages.ts),
[wire schema](../packages/contracts/src/messaging.ts),
[text grammar](../packages/contracts/src/message-text.ts).

## Captured quotes

Reply and Forward use ordinary Send with one source reference. Reply retains the
destination; Forward chooses another normal composer and preserves existing work
there. The server captures authorized text and attribution. The resulting
snapshot belongs to the destination: later source edits/deletion do not rewrite
it. Original navigation separately checks current source access. Quotes contain
no file identity, filename, bytes, URL or media preview; an attachment count is
neutral context.

| Selected message                                            | Captured content                                                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Has commentary                                              | That commentary under the selected author's identity/reference                          |
| Pure quote, with no commentary or new files                 | Existing flat snapshot and original attribution, without rereading the earlier original |
| Files without commentary, including files alongside a quote | Empty text, the selected reference and neutral attachment count                         |

The selected message must be readable. There are no nested quotes or provenance
chains. Display collapse does not truncate stored text. A message may be
quote-only or combine commentary, one quote and newly uploaded files.

Same-owner capture shares the destination transaction, including when its
channel differs. Cross-owner capture uses this order:

1. Ask the destination for admission or its accepted Send receipt; return an
   accepted receipt before source lookup.
2. Authorize and capture in the source owner's read transaction. That authorizes
   sharing the snapshot; no later source lock or deletion/version check is
   promised.
3. Refresh the same authenticated account/session, then submit a trusted
   captured envelope to destination Send, which rechecks current destination
   authority and commits locally.

The envelope binds the selected reference to the command even when flattening
preserves a different original reference. Fingerprints include the public
reference and sender-authored body/file IDs, not the derived snapshot.
Concurrent captures of different source revisions therefore recover one accepted
receipt. There is no distributed commit, media-copy job or extra forwarding
cancellation protocol. See [capture](../apps/server/src/actors/shared/quotes.ts) and
[cross-owner coordinator](../apps/server/src/routes/message-send.ts).

A first definite `source_unavailable` refusal permits editing. After a
network/invalid-response ambiguity, a later source refusal cannot prove the
earlier Send will never commit; retain the immutable attempt for receipt retry.
Missing/deleted/denied originals are a local unavailable result, not loss of
destination access. Exact original lookup can reach beyond the current history
page.

Only the author can remove a claimed attachment through the versioned message
command. Removing the last file preserves remaining text or a quote; otherwise
it tombstones the message. Upload cancellation cannot remove a claimed file.

## Deletion and derived text

Deletion atomically hides body and quote, removes FTS content, retires file
claims and emits a contentless tombstone. Ordinary retained payloads become
eligible for GC after seven days. Compact synchronization records and sequence
high-water have independent lifetimes. Grace-period storage gives neither
moderators a deleted-body browser nor users an undo action. Already downloaded
copies and backups have separate boundaries.

Destination FTS includes its commentary and captured quote through
[one search-body definition](../apps/server/src/actors/shared/message-search.ts).
The contentless index retains message UUIDs for canonical row joins without
storing another copy of the searchable text. Immutable creation sequences make
indexed positions usable for pagination despite later edits. All FTS maintenance
shares the message transaction.

The operator-authorized [rebuild](../apps/server/src/actors/shared/search-index.ts)
replaces the index and its marker in one native transaction, indexing live
canonical messages through the same text definition while preserving messages,
receipts, read positions and replay state. A [failed rebuild](../apps/server/tests/search-index.test.ts)
restores the previous index and marker. A repeat after a lost response rebuilds
from current data. Batches limit documents held in memory and SQL parameters, but
the whole rebuild occupies its owner until the transaction settles; large-owner
runtime capacity remains unmeasured. Restore does not automatically rebuild the
index.
Source deletion does not chase a reverse-quote index. Offline copies follow
destination invalidation. File bytes additionally require the reference,
writer-settlement and preservation checks in
[Attachments](attachments.md#retirement-and-late-writes).
[GC tests](../apps/server/tests/operations-gc.test.ts) exercise native storage with
controlled policy time and forced alarms. They do not establish a seven-day
soak or deployed alarm timing.

## Search admission and continuation

Body search uses literal quoted FTS5 trigram matching with a
three-Unicode-code-point minimum. Keep original text and native analysis; no
short-query scan fallback, stemming or linguistic normalization is adopted.
Short title/member pickers have a separate bounded substring policy. Tokenizer
changes require an ingestion/query version and rebuild; the
[search document module](../apps/server/src/actors/shared/message-search.ts) owns
both the indexed body and the query phrase so they version together.
[Internationalization](internationalization.md#search-contract) owns language
expectations.

The [room-search deep dive](case-studies/search-query-work.md) covers the FTS
execution plans, room bounds and measured costs behind the room-local query.

Owner-local search filters current access before snippets or counts leave the
actor. Every cross-circle page discovers bounded D1 candidates anew, then asks
owners for authorized creation/version keys. Refused owners do not consume the
authorized-owner allowance. Discovery and fanout have candidate, concurrency and
time limits; stale references or outages can still leave results incomplete. An
explicit circle filter bypasses candidate discovery without bypassing authority.
DM search remains owner-local.

The Worker merges keys recent-first and materializes only selected owners.
Each materialization checks current access, message version and creation position
in the owner's native transaction; changed or deleted selections are omitted.
Enrichment reads channel labels without occupancy. The Worker refreshes the same
cookie session on primary D1 before release. A page does not recertify earlier
bodies, and these reads do not form a global snapshot.

Cursors contain only a validated creation position and grant no access. Binary
ID ties make unchanged data deterministic and unique. Continuation advances
through the selected window, including rows subsequently omitted or unavailable.
Concurrent changes can shorten pages or miss results; Refresh starts a fresh
search. An empty incomplete page can continue when candidate lookahead provides
a frontier; otherwise it needs Refresh. The client never automatically drains
empty pages. There is no total count or global relevance promise.

The client retains at most five account/query-scoped Query pages with no inactive
retention. Ordinary edits, deletions and reactions leave those point-in-time
copies in place until Refresh, while timelines and durable history retain their
own retirement behavior. Known owner denial removes that owner's earlier hits;
temporary unavailability or absence from a later page does not. Directory/access
invalidation cancels the in-flight aggregate and retires the affected owner's
hits without restarting other retained pages. Incomplete coverage is derived
from retained pages. Account replacement rejects old work; foreground/reconnect
and explicit Refresh start cursorless. Search remains online-only, never enters
offline history and never advances reads. Locale changes preserve its lifetime.

Implementation: [search coordinator](../apps/server/src/search/coordinator.ts),
[wire schema](../packages/contracts/src/search.ts),
[cursor](../apps/server/src/search/cursor.ts),
[owner search](../apps/server/src/actors/server/search.ts),
[client query](../apps/client/src/features/search/query.ts).
