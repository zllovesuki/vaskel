# Synchronization and timeline

HTTP carries commands and authorized snapshots; the room socket carries committed
events, while account events carry references. Neither socket replaces owner
authorization. Both follow the
[client account lifetime](frontend.md#request-and-account-lifetimes).

## Replay and direct events

Persist owner sequence high-water independently of retained events. Pruning
every replay row must not reuse a sequence. Cursors bind owner scope, replay
generation and a minimum resumable floor; expired cursors require a fresh
authorized snapshot. A truncated page advances through delivered events only.
Private-channel filtering creates legitimate sequence gaps, so a client cannot
infer loss merely from nonconsecutive global numbers.

Each committed channel event stores its predecessor and advances independent
channel high-water in the mutation transaction. Direct application requires
matching owner/channel/generation, a cursor at or above `replayFloor`, and
`previous <= cursor.sequence < event.sequence`. Otherwise reconcile through
replay/reset. A retained predecessor cannot turn into zero after pruning.
Observing an event or recovering a receipt is not automatically proof of
contiguous replay.

Snapshot/subscription admission defines an owner sequence boundary.
Buffer/deduplicate newer events during catch-up. Reconnect and periodic safety
reads repair gaps, including a final lost event that no subsequent frame would
reveal. Complete accepted replay restarts the sixty-second safety deadline;
failed or partial replay, socket readiness and pongs do not postpone it. This
lets successful catch-up satisfy repair without an independent redundant read.
An authorization renewal supplies no replay progress and leaves that deadline
intact. Genuine socket admission/reconnect still performs unconditional
catch-up, including generation/floor recovery and offline-cache refill; matching
ready cursors alone do not replace it. Slow clients have bounded buffers and
resume work; disconnect them for history recovery rather than accumulating
unbounded events.

Implementation:
[owner synchronization](../apps/server/src/actors/shared/synchronization.ts),
[socket producer](../apps/server/src/actors/shared/sockets.ts),
[client connection](../apps/client/src/features/chat/connection.ts),
[reconciliation](../apps/client/src/features/chat/reconcile.ts).

## Socket authority and liveness

Both transports obtain a fresh single-use hashed ticket for each connection
through the WebSocket subprotocol. PartySocket owns bounded reconnect backoff;
the application owns ready, heartbeat, authorization and replay. Outgoing
buffering is disabled. Offline/disposal aborts admission and fences late
tickets; terminal authorization rejection stops reconnecting.

A revoked [account-events connection](../apps/server/src/routes/account-events.ts)
stops immediately and forces a coordinator identity check. A valid replacement
cookie can then establish a new connection;
confirmed account/session loss performs normal teardown. Both the check and
readmission are fenced by the captured account lifetime. Optional hub admission
or presence availability failures leave otherwise working account access and
media intact.

The Worker forwards primary-backed identity and its bounded assertion expiry
through overwritten private headers. The owner checks current access and ticket
binding in its admission transaction without materializing the resource
directory. Admission refusals use the shared
[HTTP error contract](engineering.md#http-contracts-and-validation). Every room
broadcast (commits, private reads, typing, DM policy and the alarm sweep)
rechecks each accepted socket's lease and current channel access inside the
owner transaction before sending, closing expired sockets with `lease_expired`
and revoked ones with `access_changed`; the
[socket producer](../apps/server/src/actors/shared/sockets.ts) applies that recheck
through one authorized-socket iterator. It batches current readers for distinct
accounts in each channel using the same visibility predicate as individual
reads. Those results stay within the transaction; each connection's lease is
checked again after the reads before delivery.

The room authorization lease is at most thirty seconds from the primary
identity read, capped by actual session expiry. Before expiry, authenticated
HTTP renews the existing connection using its random connection ID. The owner
matches that ID, account, session and channel, rechecks current permission in its
native transaction and updates the hibernation attachment. An older renewal
cannot shorten an already accepted lease; no renewal can revive an expired or
closed connection. Missing or mismatched connections require ordinary admission,
without treating that transport failure as lost room/account access.

The client retains its current lease deadline while renewal is pending and
fences delayed responses by connection lifetime. A successful response changes
only the lease; it neither satisfies a pending pong nor triggers replay. Lost
responses, expiry and connection failures recover with a new single-use ticket
and catch-up. A live account-events connection is not a room revocation channel; extending
the authorization bound needs a separate revocation design. Account-event leases are
capped at fifteen minutes and actual session expiry, independently of short
Worker assertions. Primary
session/credential changes install persistent account-event ticket/socket fences;
delayed old-epoch revocation cannot invalidate a newer login.

Readiness and ping deadlines detect a silently open socket. Ordinary frames show
receive activity, but only a valid pong satisfies an outstanding ping; HTTP
replay cannot mark a pre-ready socket connected. Typing is authorized for sender
and recipient, throttled and short-lived. Failed close acknowledgement must not
prevent presence recomputation.

Sources: [ticket transport](../apps/client/src/api/ticket-socket.ts),
[liveness](../apps/client/src/api/socket-liveness.ts),
[dispatch sockets](../apps/server/src/actors/event-dispatch/sockets.ts),
[revocation](../apps/server/src/actors/event-dispatch/revocation.ts).
Local workerd and client tests do not establish deployed disconnect timing.

## Reference hints and presence

Account event frames contain references and private read positions, never
message bodies. Owners select authorized recipient IDs without connectivity
replicas, group bounded batches by hub, and recheck permission before detached
dispatch. Fresh activity excludes its author; accepted retries do not announce
another send. Each recipient learns only whether the message
[addressed](notifications.md#message-eligibility) them when it was sent. Private
read and notification settings hints target only that account. Directory
removal can notify the departed member, while an unmaterialized block-only DM
pair remains undisclosed. A slow or unavailable hub cannot delay an already
committed Send response or its direct room event.

Hints are best effort. Foreground/reconnect and independent safety reads repair
loss; presence has no durable notification retry, enrollment or acknowledgement
protocol. Permission enforcement and media cleanup retain their own required
obligations.

Online means at least one eligible live account-events socket, independent of
text-room focus or call participation. Native auto-response timestamps provide
ninety-second silence detection without periodically writing last-seen rows.
A current sample returns offline as soon as no eligible connection remains.
The persisted online bit detects first/last transitions across tabs and
hibernation; it never overrides the sampled state. Lifecycle callbacks,
revocation and expiry sweeps reconcile that bit. Ordinary hint delivery only
checks socket eligibility and sends the common frame.

A read-only presence request supplies bounded owner scopes with either a member
page cursor or selected account IDs. One directory batch discovers ready owners
through the request's D1 session. A directory exception or timeout makes every requested scope
unavailable; after successful discovery, absent, pending and wrong-kind owners
are denied. Each owner authorizes the viewer and pages or intersects current
members in its native transaction; the Worker deduplicates and samples the
corresponding hubs outside those transactions. One original authority deadline bounds the composed read
and is checked again after I/O. Denied scopes, unavailable scopes and unknown
samples are explicit. The response is neither an atomic multi-owner snapshot
nor proof of a complete online count.

One document-level Query owner services mounted, unhidden presence surfaces.
It deduplicates scopes, fairly drains bounded continuations and coalesces
changed IDs per mounted scope. Full scans finish before queued targeted reads;
selection overflow requests a full refresh. Targeted responses replace only
the requested samples, including clearing accounts no longer returned as members.
An unavailable targeted read makes only those samples unknown. Initial,
foreground/reconnect and nominal sixty-second visible full scans repair missed
hints. Hidden work waits for foreground. Samples older than ninety seconds
expire to unknown. Account replacement, owner denial and scope removal reject
late pages. Member/role data remains independently useful
when presence fails, and presence never gates startup, commands or calls.
First/last connection transitions can discover a bounded D1 candidate page and
ask owners to emit authorized hints naming the changed person. Hints request
a current sample, so delayed delivery cannot replay an obsolete online value.
Lost discovery or hints are repaired by samples; no recurring membership scan is maintained.

MediaRoomDO projects visible call state durably into the message owner. The
owner filters occupancy through current permissions, returning null when no
visible participant remains. `occupancy` hints refresh Home and call state;
`call` hints refresh call state only. Permission filtering can change without a
room revision change, so clients refetch instead of applying a local occupancy
revision. Private subscription completion produces no projection feedback loop.
Call membership follows participant leases independently of presence. A brief
account-events reconnect preserves the same participant generation, roster and
healthy WebRTC while HTTP authorization renewal continues.

Sources: [dispatch actor](../apps/server/src/actors/event-dispatch),
[authorized fanout](../apps/server/src/actors/shared/event-notices.ts),
[presence contract](../packages/contracts/src/presence.ts),
[client presence](../apps/client/src/features/presence),
[room projection](../apps/server/src/actors/media/occupancy.ts),
[hint application](../apps/client/src/features/account-events/apply.ts).

## Private activity and repair reads

Positive unread/mention counts come only from owner summaries. Count qualifying
creations above the private read cursor, excluding own messages and tombstones;
event sequences also include other channels and mutations and cannot be
subtracted to derive unread. Capped counts display `99+`. Fetching history does
not mutate reads. Activity summaries expose no message/file content and report
unavailable owners and continuation explicitly; partial coverage cannot mean
globally caught up.

The client merges read positions monotonically, clears counts when known caught
up, and rejects summaries behind observed creation/read positions. One coalescer
retains a trailing refresh for hints arriving during an in-flight request.
Neither resident rows nor hints invent counts. Badges can lag the coalescing
interval and request, longer after failure.

Repair reads are separate from liveness and authorization. Feature Query
options own polling periods and adjust them when account events are unavailable.
The active timeline retains its [replay repair deadline](#replay-and-direct-events);
active media uses its own heartbeat instead of a second roster poll.

Directory repair preserves pagination progress so a missed hint can reveal new
memberships beyond the first page. Presence only samples already-known owners
and cannot discover membership.

Hints, focus and reconnect trigger the corresponding authoritative reads. Active
media has one serialized heartbeat with trailing refresh, no second roster poll.
Account-events loss alone neither stops peers nor clears a roster. Query polling periods
are nominal foreground repair cadences, not maximum freshness guarantees:
query updates restart their timers, hidden tabs pause interval reads, and
scheduling, request latency and failures can delay repair. Identity checks and
active-call heartbeats have separate lifetimes and continue while hidden.
Account-event-triggered directory, activity, member and block refreshes coalesce while
hidden and resume when visible, including trailing reads owed to hints received
during a request. Content retirement, access checks and call refreshes remain
immediate. Pre-join snapshot and administration invalidations retain their
existing behavior. Revocation/disposal discards deferred metadata work.
Sources:
[activity owner](../apps/server/src/actors/shared/activity.ts),
[client activity](../apps/client/src/features/activity/use-activity.ts),
[account-event refresh](../apps/client/src/features/account-events/apply.ts),
[media lifecycle](media.md).

## Bounded resident timeline

Query retains at most 200 accepted messages in the active window, independently
of DOM virtualization and offline storage. Inactive timelines are immediately
collectible. Contiguous replay, newest observed creation, observed mutation and
private read position remain separate and never decrease when rows are evicted.

| Reader state                | Arrival and navigation behavior                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Following latest            | Append and evict the oldest edge; preserve following while socket observations run ahead of replay                     |
| Reading a held range        | Keep that range and anchor; apply resident edits/deletions and show an unseen-tail action                              |
| Open at a message           | Install explicitly historical intent even when the page includes the newest row; fetching never marks the backlog read |
| Load newer / Jump to latest | Follow only after explicit navigation reaches the latest edge; reads still require an active visible following view    |

One cancellable navigation request owns the window revision. Later navigation,
account/owner retirement, generation change or unmount invalidates its response.
Latest temporarily holds replay, waits for pending replay, installs an
authoritative snapshot and resumes from that boundary. Reject snapshots behind
contiguous progress or observed mutations; bounded race retries leave the old
window with an error on exhaustion. A failed jump restores an originally
following window rather than stranding it in held mode.

Older/forward pages must continue the resident edge and must not evict the row
the person has since scrolled to. An around response merges reads/observations
monotonically without inventing replay progress. Native Virtual anchoring
preserves prepend/trim geometry; preserve the boundary-row decoration correction
and measured-size pruning when upgrading the virtualizer. The application chooses
the scroll destination, seeding the virtualizer's opening offset rather than
scrolling behind its back; the virtualizer owns convergence as rows measure.
Accepted navigation requests alignment independently of reading mode and
highlight timing.
A viewport resize requests the end only while following; it must not leave a
second adjustment loop that can override a later message jump. Exact-original
dialogs are independent of the resident range.

Historical browsing never exports a replacement recent offline window. Known
edits/deletions withhold disk content even when the affected row is absent;
replay of an earlier send can materialize a later mutation and must also trigger
withholding. Retire the export lifetime immediately and serialize purge after
pending saves. Direct frames update Query synchronously through an already
accepted cache lease; they do not block on disk or acquire fresh authority.
Mutation/directory hints retire affected offline scope first, then reach each
mounted timeline of that owner through the account-events provider's listener registry,
never as a Query invalidation; the timeline reconciles through replay, a hint
arriving mid-replay still earns a trailing read, and no socket restart or
snapshot is forced. Held history remains held.
[Client storage](client-storage.md) owns durable fences.

Changes to anchoring, fonts or row structure require browser geometry checks;
physical-device behavior remains [acceptance work](readiness.md#evidence-limits).

## Owner maintenance lifetime

The shared owner alarm performs bounded local expiry and receipt reclamation,
committing the successor before external attachment, media-invalidation and
directory work. After local success, the final native transaction reads every
current obligation and OPEN socket, replacing or deleting the alarm; a concurrent enqueue cannot be
lost to a snapshot taken before I/O. Required leases and retries, uncertain writer
probes and held-file policy retain their own settlement rules. Settled owners
with only canonical state and permanent fences have no alarm.

After required maintenance succeeds, the owner asks SQLite to optimize planner
statistics. This uses existing alarm runs without scheduling another wake.
Optimization failure is logged and does not retry completed cleanup; statistics
freshness is not a prerequisite for serving requests.

Receipt producers commit each record and its wake atomically. Reclamation
groups future expiries into fixed buckets derived from the original timestamp;
repeated requests cannot postpone them. Another alarm may reclaim already-expired
rows sooner. Each table has a bounded oldest-first batch, including rows exactly
at expiry. Empty tables contribute no wake; residual backlog schedules another
pass. These scheduling choices never extend authorization or command validity.
The [retention implementation](../apps/server/src/actors/shared/retention.ts)
defines bucket and batch sizes.

Socket closure attempts the native close even when its explanatory frame fails.
An expired or malformed socket that remains OPEN still consumes capacity and
waits for a later cleanup sweep. Socket/ticket cleanup wakes round up to the
next thirty-second boundary; idle transports can occupy capacity until that
sweep, or longer if platform scheduling is delayed. Stored authority deadlines
and admission, renewal and delivery checks remain exact. Other expiry and
cleanup obligations keep their own deadlines and may wake the owner sooner.
Residual non-socket backlog continues after one second. Failed
local transactions remain observable and do not promise recovery after a failed
durable write.

Implementation: [maintenance](../apps/server/src/actors/shared/maintenance.ts),
[retention](../apps/server/src/actors/shared/retention.ts).
