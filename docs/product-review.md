# Product policies

## Membership and authority

One independent invite-only instance shares accounts and DMs across circles. A
valid circle invitation lets a new person register, verify and join as a member;
existing accounts join directly. It grants no unrelated membership or host
authority. Invitations expire, may have use limits and can be revoked. Only
creation reveals the raw token.

Joining opens the circle after membership commits; directory listings may
update later.

Circle creation is available to the host and accounts granted that capability.
Members may read existing history in rooms they can currently access; joining
does not impose a new-history-only boundary.

Instance policy defaults to `members`, delegating invitation creation to each
circle's `membersMayInvite`; `owners` restricts new invites to circle owners.
Existing invitations remain valid. Owners manage circle settings, roles,
invitations and atomic ownership transfer to an existing member. Moderators may
delete others' messages only in readable rooms; they gain no private-room
access, owner settings or media moderation. Owners can manage private-room
rosters without reading their content. [Access](access.md) owns enforcement.

Losing room/circle access removes that scope and prevents new authorized reads,
sends, search, files and media under their revocation contracts; unrelated
circles/DMs survive. Disconnected/downloaded copies may persist until a new
check or removal. They grant no offline mutation authority.

## Conversation and privacy

Stable IDs define authors and individual mentions; names are labels. Private
read positions synchronize across devices from visible content in an active
following view. Fetching history, opening a mention or prefetching never marks
backlog read. There are no public read receipts. Presence reveals authorized
circle/conversation connectivity, not which text room somebody is reading.

Online display is approximate: an eligible account notification connection
means online at sample time. A brief disconnect can show offline, then online
after reconnection; explicit session revocation removes eligibility immediately.
Presence changes send best-effort scoped hints naming the changed person;
visible presence surfaces also refresh nominally every minute. Missing, expired or incomplete samples remain unknown
and cannot imply that everyone else is offline. Calls have their own
participation lifetime and do not depend on presence availability.

Name search requires current shared membership. Authenticated lookup by supplied
UUID intentionally discloses matching verified profiles without
shared-membership or readable-author proof, preserving departed-author labels.
It grants no conversation, file, membership or presence access.

Blocking prevents new DM sends in both directions while preserving history and
accepted-send recovery. It does not terminate existing DM calls. Shared-call
notices offer explicit receive/hide choices; hiding does not stop others
receiving the viewer's publications. Automatic default hiding/muting remains
proposed.

Ordinary staff access stays circle-scoped or limited to explicitly submitted
report evidence. Staff tools do not browse arbitrary DMs or deleted bodies.
Seven-day physical retention grants no extra visibility; after payload GC retain
action metadata, with submitted evidence governed separately. Host
infrastructure access is a separate trust boundary, not an application
DM-reading feature.

## Browser notifications

People can turn off message sounds on a device, enable and test push
notifications on this browser, remove enrolled devices and pause push
notifications for the account. Room controls remain in the conversation.
DMs, individual mentions and replies or quotes offer alerts; a quote recipient
must be able to read the destination. Rooms default to Direct only, with
explicit All messages, Nothing and timed mute choices. Edits can change a
pending alert's eligibility but do not start new alerts. Reactions, mass mentions
and call ringing do not create alerts. An invitation to a call is an ordinary
message.

Burst activity is grouped. Reading the qualifying message while it waits
suppresses it; having a connected tab or being in a call alone does not. Generic
preview is the default, with who-and-where and message preview choices. An
approximate badge indicates activity without claiming an exact unread count.

While vaskel. is open, a message eligible for an alert also plays a short sound,
unless its conversation is on screen in a focused window. Room choices and
mutes apply to sounds too, and a change made elsewhere takes effect once this
browser receives it. Sounds are on by default and can be turned off per device;
pausing push notifications and Deafen leave them on. Pages cannot follow
operating system Do Not Disturb, and a later push alert can also sound.

Enrollment survives login expiry and password/session changes. Removal and
pause stop subsequent preparation, but already prepared alerts may arrive.
Alerts can be missed, repeated or stale; message history remains authoritative.
Opening one uses normal sign-in and current access, without marking history read
merely because it was clicked. [Notifications](notifications.md) owns enrollment,
eligibility and the dispatch boundary.

## Accounts and media

Accounts require email verification, expiring password reset and auditable
operator assistance. Installation finishes with verified host sign-in;
[release preparation](readiness.md) defines the release acceptance scope.
Assistance never reveals passwords. Signed-in password change verifies the current password,
preserves this session and can revoke others; wrong-current-password is an
inline failure.

The client refreshes session validity and profile/preferences under the
[identity freshness policy](access.md#client-identity-freshness).
Account-authenticated API requests independently check the session. Delayed
display updates never extend server authorization.

Persistent voice rooms are audio-oriented with opt-in camera, concurrent screen
shares and a 16-person logical cap. There is one current participation per
account, with explicit Move between tabs/devices. Refresh restores authorized
room intent and prior mute preference; camera/screen capture never silently
restarts. Browser permissions/autoplay may require a useful gesture/recovery
state. Leave, removal and revoked membership prevent automatic rejoin.

Explicit transfer accepts new ownership without waiting for the old endpoint,
room or SFU cleanup. Old transports may overlap briefly, but a room presents one
entry per person and each listener plays at most one generation. Listeners may
switch at different times. The obsolete transfer session is disposable;
moderation, permission revocation and terminal intent retain enforced cleanup.
This is eventual handoff, not atomic coordination or proof the old provider
resources are absent. [Media](media.md) owns the exact lifecycle.

## Search, retention and capacity

Body search uses literal native trigram matching with a three-Unicode-code-point
minimum and no custom short-query/linguistic fallback. Short title/member
pickers are separate. Cross-circle search is recent-first with circle/room
filters and explicit incomplete coverage; it excludes DMs, whose search remains
owner-local. Each page checks current access. Earlier results are point-in-time
copies: ordinary message changes and temporary failures do not restart the
search. Refresh starts again; observed access loss retires the affected owner's
results. Concurrent changes or bounded discovery can leave pages incomplete.

History has no automatic expiry. Warn or refuse new growth as capacity fills.
[Operations](operations.md#capacity-boundaries) distinguishes engineering
admission bounds from measured workloads.

Deletion immediately hides ordinary body/quote material from new reads, search
responses, replay and new download grants; a download URL issued earlier stays
usable until its fixed expiry. Ordinary payloads become eligible
for GC after seven days; compact sync records can outlive payloads, and sequences never
repeat. Files require reference/preservation checks and safe retryable cleanup.
Downloaded copies and backups have separate lifetimes. This creates neither
deleted-body browsing nor user-facing undo.

## Quotes and authored work

Reply and Forward share one authorized captured-text quote. The destination owns
that snapshot; source edits/deletion do not rewrite it. Opening the original
still checks source access. Quotes copy no files or media previews. A pure quote
forwards without nesting; commentary is quoted as the selected message, and a
file-only original uses neutral attachment context. A message supports
commentary, one quote and up to four new files, including quote-only sends.
Removing the last file preserves remaining text/quote.
[Messaging](messaging.md#captured-quotes) owns capture/receipt details.

Forward opens the destination's normal composer and preserves existing work.
Browser-local new-message drafts, File bytes and exact pending Send survive
navigation/reload; sending and retry stay explicit. Online draft persistence
does not authorize offline authoring, delayed automatic sending or cross-device
draft sync. Offline history is read-only. [Client storage](client-storage.md)
owns the distinct lifetimes.

## Languages and clients

Browser first, with English, Simplified Chinese, Traditional Chinese and
Japanese UI. CJK text/input is core; Korean content works without a promised
Korean UI. Accessibility, native IME, native-speaker and physical-device
acceptance remain distinct from implementation.
[Internationalization](internationalization.md) and [Readiness](readiness.md)
define the boundaries.

## Proposed additions

| Proposal                   | Unresolved decision                                                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wider moderation           | Timeouts, circle bans, report/audit UI and actor/target/reason/outcome records for new elevated actions                                                                |
| Owner departure/deletion   | Transfer or explicit deletion before departure; sole-owner/account deletion and host resolution of abandoned ownership; no automatic circle deletion when others leave |
| Default block-media hiding | Whether blocked participants begin hidden/muted, preserving reception-versus-publication clarity                                                                       |
| Mass mentions              | Privileged/admin-only policy requires mapping to current roles, notification scope and abuse limits; capability is unavailable                                         |
| Richer search filters      | Author/date filters beyond current circle/room scope                                                                                                                   |

## Deferred scope

Group-DM management/blocking policy, threads/forums, custom-role editing and
elaborate inheritance remain deferred despite schema representability. OIDC,
email change, user avatars, native applications, ringing DM calls, remote
control, recording/transcription, external bots/custom commands, polls, rich
document editing, AI moderation and semantic search are outside current
delivery. Link unfurling needs a separate bounded-fetch/safety policy.

Offline authoring/queued sends, export/backup import/automated restore and RTL
remain deferred. [Readiness](readiness.md#deferred-engineering-proposals) owns
research candidates.
