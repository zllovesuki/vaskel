# Media negotiation and cleanup

## Admission and provider boundary

The Worker verifies identity and obtains scoped, short-lived media permission
from ServerDO/ConversationDO. Room admission verifies the current account claim
and endpoint capability. Explicitly check join, speak, camera, screen and
moderation authority; an SFU track/session locator grants none. Safe snapshots
contain no capability or provider identifiers.

The message owner commits permission invalidation and a durable wakeup together.
Grants, queued invalidations and room permission floors share the owner's
[permission version](access.md#owner-authorization), which advances only for
permission-affecting mutations; a metadata edit during an in-flight exchange
never ends participation.
Generation-fenced retries coordinate room forwarding cleanup; no transaction
spans owner SQL, account/room actors and SFU. Keep pending enforcement visible
until closure converges. Operator SFU credentials remain Worker secrets and the
browser never receives an unrestricted provider proxy.

External JSON, provider responses, stored data and public outputs retain runtime
schemas. Internal typed RPC avoids duplicate ingress parsing while owners retain
state checks. Convert only classified provider exceptions to provider outcomes;
SQL/RPC/invariant failures follow sanitized unexpected-error handling after
cleanup obligations are secured.

The [provider client](../apps/server/src/providers/realtime/client.ts) owns the fixed
SFU host, redirect policy, response-byte ceiling and deadline through body
consumption. HTTP success can contain item failures: retain successful
allocations before classifying/retrying failed items. Status alone cannot decide
retryability. Timeout leaves allocation uncertain, and an application command ID
does not make a provider endpoint idempotent. Preserve reconciliation state
instead of blindly allocating on retry.

## One complete exchange per session

Publishing and receiving use separate provider sessions/PeerConnections. Each
session has one operation queue; different sessions may proceed concurrently.
Every source, snapshot and subscription change enters that queue _before_
creating SDP or sending a request. Cloudflare's
[negotiation guide](https://developers.cloudflare.com/realtime/sfu/concepts/negotiation/)
describes the full exchange that each queued operation must complete.

Admission creates logical sessions. Allocate the producer SFU session when its
first publish offer is ready and the consumer on its first nonempty subscription,
within the reserved exchange. An unconnected session can expire before its first
operation; activity on the participant's other connection does not keep it alive.
That [setup expiry](https://developers.cloudflare.com/realtime/sfu/concepts/sessions-tracks/)
is separate from the
[media inactivity timeout](https://developers.cloudflare.com/realtime/sfu/platform/limits/).

1. Reserve operation ID, phase, generation, deadline and expected answer under
   current room authority.
2. Perform provider I/O outside SQL, retaining every allocated identifier even
   on partial failure.
3. Recheck session/lifecycle/moderation in the completion transaction. For a
   producer, apply the answer and establish connectivity before ACK makes
   publication ready.
4. For a consumer offer, hold ownership through browser answer creation and
   successful backend renegotiation. Returning an offer or reaching browser
   signaling stability does not finish the exchange.

Authorized muted entry publishes generated silence to establish the producer
without physical capture. Unmute replaces it through the existing
[device-switching path](media.md#device-switching). Later self-mute disables the
captured track while retaining its publication; server restrictions retain
[enforced closure](#forwarding-enforcement). A suspended generated source waits
for browser activation before publication.

Consumer completion returns the entire subscription-to-MID map, including an
empty map and the no-renegotiation path. Subscribe/answer schemas require that
map; producer ACK/unpublish completions may omit it. Eviction/retry preserves the
phase; stale generation/version/phase replies cannot mutate replacements. Recover
completed responses through bounded receipts or explicitly replace an
unrecoverable uncertain generation. Exact retained completed receipts resolve
after current account, capability and generation checks, before the new-command
age limit. Pending exchanges still expire; missing receipts cannot allocate aged
commands. A timeout does not release serialization while external work remains
unsettled. Never lock the whole room waiting for one endpoint's answer.

Sources: [backend map](../apps/server/src/actors/media/README.md),
[media schemas](../packages/contracts/src/media.ts),
[HTTP schemas](../packages/contracts/src/media-http.ts),
[operation ownership](../apps/server/src/actors/media/operations.ts),
[publication/ACK](../apps/server/src/actors/media/negotiation/publications.ts),
[subscription/answer](../apps/server/src/actors/media/negotiation/subscriptions.ts),
[browser session](../apps/client/src/features/media/session.ts).

## Replacement reception and source removal

Desired publications select only current eligible generations. On explicit
publisher transfer, receivers detach obsolete playback before replacement and
may discard obsolete subscription mappings without first closing those MIDs.
The mapping retains its source session identity; explicit transfer marks it
locally before source details can be pruned. Missing publication rows alone
never grant this exception: ordinary source stops retain track closure, including
after publication removal. Keep MIDs in allocation records so deafen, removal
and Leave can still enforce all receiver forwarding and retained allocations
still count toward the cap. Late tracks/answers check the latest desired set and
room revision before presentation.

Camera reception follows visible tiles; selected screen/audio follows stage or
picture-in-picture visibility. Source kind is explicit because microphone/screen
audio and camera/screen video share media kinds. Simulcast choices/fallback are
deliberate; subscription policy and concurrent source counts matter
independently of logical participant admission.

Transfer churn, room session rows and receiving-session allocations have
separate bounds in [account admission](../apps/server/src/actors/account-media/lifecycle.ts),
[room membership](../apps/server/src/actors/media/membership.ts) and
[subscription admission](../apps/server/src/actors/media/negotiation/subscriptions.ts).
Accepted retries consume no extra transfer allowance. Refuse exhausted
allocation capacity before reserving a new exchange and offer explicit recovery.
Disposable predecessor pruning does not await provider closure, but executing
admission/provider scopes remain protected.

The browser uses candidate-bearing local SDP with a bundled transport and a
bounded no-candidate wait shortened by the owner deadline.
Cancellation/failed-peer checks remain active. A candidate permits an attempt,
not a publication-ready claim. Unpublish stops capture and removes the sender
while retaining its inactive transceiver section; permanently stopping the first
bundled section broke later source restart in a recorded live check. Full Leave
closes peers. Track initial producer and consumer connection independently so
first connection is not mislabeled recovery.

## Forwarding enforcement

Mute, deafen, screen/camera restriction, removal and permission loss enforce
provider forwarding; a malicious endpoint may ignore UI controls. Current
restrictions apply at reservation and after every external await. If a
restriction arrives during the affected pending exchange, the moderation
transaction closes that participant generation before external cleanup. Lifting
the restriction cannot revive its offer/answer. An idle/completed exchange
retains scoped track cleanup and completed receipt replay.

Scoped cleanup reserves the affected session until provider work settles.
Lifting a restriction or timing out a waiting caller does not release it. New
negotiation can wait once, bounded by ten seconds and the cleanup deadline, then
rechecks authority, command age and session state. If cleanup still owns the
session, it returns `session_busy`. Completion checks its phase and command
before changing mappings; interrupted cleanup remains owned by the alarm path.

Moderation compares the displayed target's participant generation and control
version, independently of unrelated room activity. Every new accepted command,
including an unchanged boolean, advances that control version with its restriction
and caller-scoped receipt in one transaction. Fresh moderation authority is
required even for replay. Exact retries recover the receipt before target
conflict checks; changed payloads conflict. A missing, ended or replaced target
or changed control version returns an operation-local conflict: refresh the roster and let
the moderator try again, preserving the call. Room revision orders visible
snapshots; private subscription completion reads it without advancing it.
`cleanupPending` records the accepted request's cleanup knowledge, not live
cleanup status. Provider failure or interruption can leave it true after later
cleanup succeeds. Replay never reapplies the action to a newer participant
generation.

Producer ACK/consumer answer must inspect the retained operation before treating
a restriction as preflight. Moderation may already have deleted publication
rows, so pending-source checks use the negotiation receipt. Stop new
departing-generation work, invalidate pending phases, retain late allocations
and close known resources. Already-absent responses prove convergence only where
the provider contract establishes absence. Clearing a room must never delete
message-owner history.

Room cleanup records the closure disposition defined in
[participation](media.md#participation-outcomes-and-closure). Permission floors
survive ended rows and can cancel inherited account intent. The exception for
disposable transferred generations must never weaken terminal enforcement.
[Moderation](../apps/server/src/actors/media/moderation.ts) and
[cleanup](../apps/server/src/actors/media/cleanup.ts) implement these boundaries.

## Settled retention and wakeups

Ordinary `closed_at` records successful forwarding closure; delayed
terminal-cancellation acknowledgement restarts eligibility when account intent
is durably canceled. Details become eligible after five minutes, covering the
receipt horizon and exceeding new-command/grant/exchange windows. Closing rows,
unacknowledged cancellation and unsettled allocations do not disappear on a
timer. Explicit-transfer retirement records ended application authority and
permits disposable pruning without forwarding proof.

Prune within one shared bounded transaction budget across parent and child rows,
including expired negotiation and moderation receipts. Moderation receipts use
the same five-minute horizon; after pruning, the original target generation and
control version cannot accept the action again. Keep parents when the budget
runs out; never hide unbounded work in cascades. Protect executing scopes, live
negotiation and unsettled cleanup. A live consumer can retain a subscription whose source
disappeared; it grants no access and is omitted from visible materialization,
while its MID remains enforceable until reconciliation/closure.

**Keep the latest participant row as a compact closure fence.** Exact account
receipts outlive the new-command window; deleting all evidence of a closed
generation could let an exact Join retry allocate it again. Older generations
may disappear behind a newer monotonic generation. Never reset room revision,
account claim generation, permission floors or persistent restrictions. The
account's single authority row is bounded state, not disposable session history.

Ordinary finalization settles even id-less sessions before recording closure and
never infers a missing timestamp. Each closing generation has one nullable
`cleanup_at` obligation, retained through forwarding closure while terminal
cancellation acknowledgement is pending. Expired leases and negotiations initiate
closure only for participating generations; their original validity deadlines
never become retry deadlines. Repeated expiry and callbacks preserve the existing
cause precedence and cleanup progress. Explicit-transfer retirement clears the
mandatory obligation under its disposable policy.

Select due generations oldest-first within a bounded pass. Claim each successor
transactionally before external work; failed, protected and still-running
candidates advance their retry deadline so later generations can progress.
The maintenance pool bounds unsettled operations, caller waits and each pass.
A timed-out caller does not cancel an already-started provider operation, release
its slot or authorize overlapping effects. Unexpected local failures remain
observable.

Reconstruct cleanup/retention deadlines after eviction from stored times. Final
refresh reads every current domain in one native transaction and replaces the
exact next wake, including live validity and occupancy leases, or deletes it when
nothing remains. Fresh work committed during external I/O survives this refresh.
Retention pruning excludes executing scopes before applying its batch limit.
Protected retained details keep a durable recovery wake, so interruption before
scope settlement cannot strand disposable rows. Compact fence rows alone never
schedule a wake.
Residual eligible backlog continues after one second. Finite automatic alarm
retries cannot guarantee indefinite progress after a failed durable write.
Dormant rooms rearm when awakened; deployment does not enumerate them.

This bounds each pass and settled-detail lifetimes, not global storage or
billing. Pending provider/incident obligations can live longer. Message history,
file holds, audit data and R2 belong to other owners.
[Retention](../apps/server/src/actors/media/retention.ts) and
[alarm](../apps/server/src/actors/media/alarm.ts) own selection, timing and batch
limits under these constraints.

## Evidence limits

Published provider guidance and reviewed source revisions are in
[sources.json](sources.json). Provider limits and optional
DataChannel/media-adapter features do not establish a supported room workload,
durable chat, recording or remote-control feature. SFU/TURN transport encryption
is not participant-to-participant E2EE; that would require client keys,
transforms, recovery and new product decisions.

The [media verification scope](media.md#verification-and-references)
distinguishes synthetic actor responses, native loopback peers and actual SFU
traffic. Changes to negotiation/cleanup need relevant concurrent joins, missing answers, eviction,
stale responses, partial allocation and uncooperative-client tests. Physical
capture/speakers, TURN-only networks, backgrounding, device replacement and live
adversarial interleavings remain separately scoped acceptance.
