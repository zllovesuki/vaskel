# Identity and access

## Identity and session authority

Stable local user IDs identify people; names, emails, slugs and provider IDs do
not. Email/password authentication, verification and recovery use Better Auth
with vaskel.'s native D1 batches. An invitation is not proof of email ownership.
OIDC remains deferred; future verified `(issuer, subject)` mappings must
preserve local IDs.

Authentication, capability decisions and mutations use primary D1 even when a
directory request supplies a consistency bookmark. Directory bookmarks are a
consistency floor, not current permission. The browser retains an opaque bookmark
in account/origin-scoped memory and sends it on API requests whenever available.
Server procedures choose whether a directory read resumes from that bookmark or
requires primary D1; shared HTTP contracts carry no database routing policy.
[D1 sessions](../apps/server/src/directory/database.ts) implement this boundary;
remote replica placement and latency remain unmeasured.

Short actor assertions expire within thirty seconds of the primary identity
read's start, or earlier at session expiry. Later dispatch, retries and actor
work cannot restart that window.
[Socket renewal](synchronization.md#socket-authority-and-liveness) retains the
same bound across an existing connection.

Password reset rotates the credential epoch so an old-password sign-in finishing
late cannot receive current authority. Signed-in password changes verify the old
credential and atomically rotate password/epoch while preserving the selected
sessions. Retaining the current account-events socket does not extend its lease; newer
reset and exact-session fences still win. Direct SQL must explicitly propagate
revocation because it can bypass library hooks. Keep library cookie handling
intact.

Session and credential changes do not remove independently enrolled browser
notification devices. Their [management and logout cleanup](notifications.md#enrollment-and-account-lifetime)
retain ordinary authenticated account authority.

Self-service exposes bounded session metadata, never tokens or IP addresses.
Sessions show their sign-in time (`createdAt`), with the current session first
and other sessions ordered newest first. Authentication does not record
periodic activity or extend the seven-day expiry. Better Auth's required
`updatedAt` column remains library metadata.

Better Auth instances are created within the request that uses them to avoid
reusing request-bound asynchronous context across Workers invocations. Identity
results are never cached, and sign-in's captured credential epoch stays local to
its attempt. Native joins fetch the library's session and user together,
followed by vaskel.'s fresh primary authority join. Schema compatibility is
checked by the [native auth database proof](../apps/server/tests/auth-database.test.ts)
before release, without schema introspection on ordinary requests.

Separate account-keyed read, management and password limits prevent session
listing from consuming password attempts; sign-in retains its separate IP limit.
See [account mutations](../apps/server/src/auth/account.ts) and
[client request classification](frontend.md#request-and-account-lifetimes).

## Client identity freshness

The document access coordinator owns a thirty-second validity deadline. A
successfully decoded private HTTP response may advance it only while its
captured account and request lifetime are still current. The deadline begins at
request start, so a slow response cannot buy another thirty seconds on arrival.
Public requests, cleanup exemptions, malformed or failed outcomes, stale results
and socket pongs supply no evidence. Account-authenticated API requests still
check primary D1; client freshness grants no server authority.

Idle identity checks continue in hidden documents. Successful `/me` reads refresh
both deadlines; other accepted private traffic refreshes only validity.
Profile/preferences refresh remains due after five foreground minutes. Hidden
profile repair adds no independent poll.
Foreground, reconnect and relevant account mutations force a current `/me`
read; a forced check during an in-flight read waits for a coalesced trailing
read. `/me` still observes shared-cookie account replacement and performs normal
private-data retirement before admitting the replacement account.

Failed operations supply no freshness evidence, so the existing identity deadline
still causes another check. [Request failure handling](frontend.md#request-and-account-lifetimes)
distinguishes local failures from account-wide disconnection and denial. See the
[coordinator](../apps/client/src/features/cache/access/coordinator.ts) and
[request policy](../apps/client/src/features/cache/access/request-policy.ts).
Browser deadlines are nominal while suspended or offline; server authorization
bounds are unchanged.

## Owner authorization

ServerDO owns membership, roles and channel access. ConversationDO owns its
participants and send policy. IDs locate those actors without granting a
capability. Content materialization, search, socket delivery and download-grant
issuance check the relevant current authority. Issued grants follow the
[attachment download boundary](attachments.md#grants-downloads-and-cancellation).
D1 references and eventually consistent indexes cannot authorize private access.
A channel is visible to a member when it is public or lists the member in its
roster. The shared
[owner policy](../apps/server/src/actors/shared/policy.ts) applies that rule to
individual channels, directory/activity/search queries, member removal and
recipient selection for hints, mentions and occupancy.

Owners manage circle settings, roles, invitations and ownership. Moderators can
delete others' messages only in readable channels; editing and attachment
removal remain author-only. Moderator status grants neither private-room access
nor circle settings or media moderation. Owners may administer private-room
rosters and metadata without access to their content or occupancy. Instance
hosting authority is separate from ordinary application access to DMs.

Owners keep two counters. The directory version orders every administrative
mutation for expected-version checks and summaries. The permission version
advances only when a mutation can change somebody's authority: role changes,
private-room roster changes, member removal and ownership transfer. Media grants
and queued media invalidations carry the permission version, so renames, topics,
ordering, invite policy, new rooms and member joins never end a call.
[Search](messaging.md#search-admission-and-continuation) rechecks access on each
page and uses creation-position cursors. DM blocking changes send policy and
touches neither counter.

Ownership transfer promotes an existing member and demotes the former owner
atomically, with the unique-owner constraint. Whole-circle room reorder
validates the complete unique roster and expected server version in one
transaction; it cannot be implemented as independent channel writes. Individual
metadata updates retain channel-version checks. Channels append after the
current maximum position. Server creation fingerprints the effective first-room
name, including the default, so renaming later cannot break its immutable
initialization receipt.

Implementation: [owner policy](../apps/server/src/actors/shared/policy.ts),
[circle administration](../apps/server/src/actors/server/circle-administration.ts),
[metadata](../apps/server/src/actors/server/metadata.ts).

## Directory and people

Creation spans a pending D1 directory receipt and idempotent actor
initialization. Incomplete resources remain unavailable and repairable; there is
no distributed SQL commit. Pending rows retain both retry identity and capacity
liability. [Instance admission](operations.md#instance-admission) defines that
allocation boundary.

Invitation admission commits membership, receipt, a coalesced reconciliation
deadline and the shared alarm together. The HTTP response acknowledges this
commit under the [membership policy](product-review.md#membership-and-authority).
The owner alarm publishes membership to D1 and sends best-effort hints. Bounded
publication records a recovery wakeup before I/O and acknowledges only the
matching owner revision.
Concurrent joins, failed batches and lost acknowledgements retain another pass;
unrelated wakeups and reconciled idle owners do no repair reads. This makes
committed membership discoverable after the Worker disappears without making the
directory authoritative. See
[directory repair](../apps/server/src/actors/shared/directory-sync.ts).

Direct resource reads authorize through the owner without querying or repairing
the membership index; the ready-resource registry and identity/policy reads
remain prerequisites. Index exhaustion does not prove that all canonical
memberships have been published, so discovery omission cannot reject a named
destination. Opening it does not repair a missing entry without pending
reconciliation.

Name search uses bounded D1 candidates followed by current shared-membership
checks in owners. Literal substring matching treats wildcard characters as text.
Stale or forged candidates grant nothing. Authenticated lookup by
supplied UUID intentionally returns verified profiles without shared-membership
or author-provenance proof, including departed-author labels. This discloses
limited profile data, not messages, files, membership or presence. See
[people queries](../apps/server/src/directory/people.ts) and
[directory contracts](../packages/contracts/src/directory.ts).

Directory, member, activity, block and usage aggregation must distinguish
unavailable coverage from absence. A timeout cannot mean unblocked, caught up or
no members. Directory owner refusals establish absence only for forbidden or
not-found results; expired authority and invalid outcomes leave coverage
incomplete. Bounded RPC waits retain their slot until settlement; required
identity/D1 reads have separate lifetimes. Refetching the same page can recover
omitted owners.

## Invitation policy

The instance policy controls new invitation creation: `owners` permits only
circle owners; `members` delegates to each circle's `membersMayInvite`. Existing
invitations remain valid. The Worker supplies a short-lived primary-backed
instance-policy assertion; ServerDO combines it with current local authority
inside its transaction. The assertion can remain in flight for its bounded
lifetime; this is not immediate cross-store revocation.

The UI uses effective `canCreateInvite`, while the actor still enforces
permission. Only creation reveals a raw invite token; owner lists return safe
metadata and a hash usable for revocation. Only usable invitations count against
the outstanding cap. Inspecting an invite excludes the verified holder's own
reservation, without lending that reservation to anonymous or different
accounts. Exact accepted registration recovery precedes fresh invitation checks
and does not itself grant circle membership.
Owner registration authorizations retain thirty-five days from creation, beyond
the maximum thirty-day invitation validity. Reservations last ten minutes.
[Owner retention](operations.md#retention-and-incident-handling) defines bounded
reclamation and its durable wakeup independently of invitation validity.

## Direct-message blocking

The deterministic sorted-pair ConversationDO owns both directed block rules,
even before a DM exists. Pre-DM initialization creates only pair policy, not
membership, channels or navigation. Either direction blocks new sends and
attachment reservation, begin, completion and claim. A send committed before a
block remains accepted; a later send is refused. Exact accepted-send recovery
remains available under read authority.

Blocking preserves history, search, downloads, reads and text edit/delete
access. It does not terminate a DM call or create new call-admission rules.
Shared-call warnings and explicit receive/hide choices affect reception only;
automatic default hiding remains proposed. Other participants can still receive
the viewer's publications.

The caller sees only their directed rule/revision and combined send eligibility,
never the other person's rule. Each mutation uses an expected revision and
stable receipt; exact retry returns its immutable result alongside current
status. Mutations, including retries and unblocks, publish a D1 candidate before
owner dispatch so an acknowledged block is discoverable after response loss.
Extra candidates are harmless and remain after unblock to avoid a cross-store
deletion race. Block-list reads start on primary, resolve owner state and report
unavailable targets explicitly; even an empty page can have a continuation.

Status reads validate live identity and verified targets on primary D1 without
updating discovery. Positive results and DM status recheck those facts after
owner lookup. A missing candidate stays absent from the block list until a
mutation republishes it; the pair owner still enforces its block rule.

Block invalidation refreshes policy without revoking the timeline or advancing
replay. Upload completion still accounts for a trusted writer before retiring
blocked unattached bytes; unblocking cannot revive that retired upload.
Implementations: [pair policy](../apps/server/src/actors/conversation/blocks.ts),
[candidate reads](../apps/server/src/directory/blocks.ts),
[wire contract](../packages/contracts/src/blocking.ts).
