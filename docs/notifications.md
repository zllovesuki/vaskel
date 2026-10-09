# Browser notifications

[Product policy](product-review.md#browser-notifications) defines notification
controls and attention choices. Canonical messages and private reads remain
with ServerDO and ConversationDO; this guide explains the independent
alert lifecycle.

## Enrollment and account lifetime

The account's [NotificationDO](../apps/server/src/actors/notification/notification-do.ts)
owns subscriptions, persistent VAPID keys, preferences and waiting groups.
Management uses normal authenticated account routes. Enrollment is independent
of password and session changes; delivery requires no D1 identity lookup.

Enable, remove and preference commands retain exact retry identity and compare
local revisions. A delayed Enable cannot undo a confirmed removal. Provider
feedback matches the attempted device version and endpoint before removing a
dead subscription, so a replacement survives late feedback.

The [browser enrollment controller](../apps/client/src/features/notifications/browser.ts)
records its account binding and serializes subscription changes across tabs.
Enable and remove read the actor's current state inside that lock, so a tab
holding stale settings cannot replace a live subscription or send a stale
revision. It does not adopt another account's subscription or automatically
recreate a removed enrollment; a browser subscription that no local binding
owns can be released only by an explicit action of the signed-in person.
Logout attempts removal of the captured enrollment and browser unsubscribe
without delaying authentication logout. Failed cleanup remains visible once
the attempt has finished; later actor management requires authentication.
There is no guaranteed background reconciliation after logout.

Subscription encryption secrets and the VAPID private key stay with the actor.
Notification language is saved on enrollment and preference changes. Sender and
room labels come from authenticated Send and the message owner; renamed labels
may remain in waiting work. Delivery does not fetch profiles for presentation.

## Message eligibility

After a new Send commits, its owner returns a bounded reference and candidate
account IDs privately to the Worker. The Worker offers that reference in
`waitUntil`, keeping recipient RPC fan-out outside the message actor. Owners gain
no notification outbox or schedule. An interrupted offer can lose an alert;
receipt recovery creates no new offer.

When work becomes due, the private [owner resolver](../apps/server/src/actors/shared/notification-source.ts)
checks current generation, destination access, blocking, deletion, private read
cursor and message eligibility together in native SQL. Direct eligibility uses
the current mentions and captured quote author, or the conversation's DM scope.
An unrelated unread message cannot preserve an alert for a message that was read.
Quote recipients must currently be able to read the destination. NotificationDO
supplies its selection criteria, and the owner returns the newest qualifying
message through private RPC with no browser content endpoint. Text is included
only for message previews. NotificationDO masks spoilers and formats that
authorized snapshot before encryption, keeping presentation work outside the
message owner's transaction. Generic and who-and-where previews need no message
text or Markdown rendering.

All messages preferences are private to recipient actors, so the owner selects
current readers without consulting a preference index. This isolates
notification controls while making room fan-out a cost of message activity.

## Waiting, dispatch and transport

A fixed short wait gives private read positions time to suppress unnecessary
alerts. New dispatches are spaced per conversation, independently of connection
presence. The [timing settings](../packages/contracts/src/notifications.ts) are
evaluation defaults, not promises about when an operating system alerts. Absent
recipients also wait, and slow read propagation can still produce an alert.

Waiting work is durable. The alarm consumes bounded groups and preserves
successor wakeups before external I/O. Each group gets one owner eligibility
read, current local preferences and enrollments, and an encrypted request per
device. Local revisions invalidate obsolete preparation after awaited work;
offers and commands can only advance the persisted wake. The alarm recomputes
its schedule from current work, so overlapping offers cannot postpone due groups.
A timeout, failed eligibility/enqueue attempt or crash after consumption can lose
that group's alert. Failed attempts emit content-free diagnostics; consumed
groups are not replayed.

The final actor decision is the cancellation boundary. Local changes observed
before it suppress or change preparation; later changes cannot recall a queued
request. The source answer checks access and reads at a point in time, not for
the duration of a lease. Queue delay can therefore increase the gap between the
source check and provider delivery. Opening an alert still checks current access.

The [Queue consumer](../apps/server/src/notifications/transport.ts) performs
bounded provider HTTP and transient retries. It obtains no actor claim and does
not reload identity or resolve the message again. Application work expires
fifteen minutes after message creation; provider storage expires at most
twenty-four hours after creation. Retries cannot restart either lifetime.
Dead-endpoint feedback is best effort; losing it leaves a removable stale device.

Queue redelivery and ambiguous HTTP retries may repeat an alert. Tags and
provider Topics reduce some duplicates but cannot promise exactly-once display.
Conversation spacing governs new actor dispatches, not every provider attempt.
Queue bodies contain sensitive endpoint, ciphertext and provider headers; those
values are neither logged nor exposed through browser management APIs.

## Browser display and return

Permission requests begin in an explicit browser action. The service worker
always displays a visible notification, including for empty or invalid payloads;
push is not an application synchronization channel.

Local protocol and Chromium fixtures do not establish live-provider delivery or
browser/OS background behavior; [Readiness](readiness.md#evidence-limits) records
that evidence boundary.

Click destinations are constructed from validated account and conversation
references, never provider-supplied URLs. The return route preserves the intended
account through sign-in and does not replace a different signed-in account.
Normal navigation checks destination access and owns any later read advancement;
the click itself advances no read cursor. A stale alert can legitimately open a
changed or unavailable conversation. Returning clears the approximate activity
badge without claiming that every unread message was read.

## Message sounds

Activity hints carry send-time addressing, so an open tab
[decides](../apps/client/src/features/notifications/message-sounds.ts) with the
settings it last read instead of waiting on the notification actor. Tabs read
settings when the account opens and after a settings hint or reconnect. Nothing
sounds before the first read, so a room's Nothing or mute is never guessed; a
change made elsewhere can still let a sound through before it arrives. One tab
plays each cue, none while a tab shows that conversation, and a short cooldown
drops repeats. A tab cannot play before a click, tap or key press there, and
frozen or discarded tabs cannot play.
