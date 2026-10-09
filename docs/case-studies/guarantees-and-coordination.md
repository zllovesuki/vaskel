# Case study: simplify the guarantee before the mechanism

Device transfer and Web Push reviews began by treating a strong guarantee as
fixed. Asking “if we can relax the guarantee, can we simplify the code?” changed
which failures had to block progress and where the work belonged.

Transfer was implemented in commit `0c1f704`. The initial Web Push review
produced a proposal. [Media participation](../media.md#replacement-policy),
[product policies](../product-review.md) and [Readiness](../readiness.md) own
behavior and acceptance.

## Device transfer: remove the unnecessary prerequisite

A person wanted to move a call from device A to device B, including when A was
slow or unreachable. The implementation required confirmed closure of old
forwarding before admitting the replacement. Account coordination waited for
the old room, which waited for SFU teardown. Failure to clean up A could prevent
an otherwise valid call on B.

Codex initially judged the explicit phases and generation checks to be sound
and found no transaction committing atomically across services. That
classification missed the availability dependency. The workflow still required
successful work in another failure domain before the replacement could proceed,
without providing an atomic cutover across all participants.

Pocket Radio, an ESP32 project that streams audio to browsers through
Cloudflare Realtime SFU, supplied a concrete precedent. Its
[publisher lifecycle change (`83c0617`)](https://github.com/zllovesuki/esp32-radio/commit/83c06177411720c110b1f90079f2827f8a478d9f)
let a new board boot discard the previous generation and start without
contacting its old SFU sessions. Those transports were left to expire, while
cleanup within the current generation and rejection of stale requests remained
enforced. vaskel's stricter transfer policy required an explicit product decision
before applying that approach.

The user allowed overlapping transports provided other people did not see or
hear the same person twice. Devices and rooms could learn the replacement state
eventually. This separated the account's authority, each listener's playback
and the lifetime of obsolete provider resources.

AccountMediaDO could commit one current generation while each listener detached
old playback before presenting its replacement. Listeners could switch at
different times. Disposal no longer gated admission or replacement subscriptions.
The change preserved authorization, accepted-command identity and rejection of
stale generations. Resume, deliberate Leave and moderation retained their
required enforcement; disposable transfer resources did not prove old forwarding
absent.

## Web Push: reconsider the boundary after changing the promise

The proposed benefit was a background alert for a message. ServerDO and
ConversationDO already owned messages and unread state. Losing an alert and
losing a message therefore had different consequences, but the initial designs
coupled message commit to durable notification intent.

When the user suggested a separate outbox actor, Claude argued that the outbox
“has to start in the owner no matter what.” A crash between message commit and
a call to another service could lose the alert. Under that premise, a separate
actor would add a durable handoff and acknowledgement protocol while leaving
work in the message owner.

The user asked, “do we really need atomic consistency though?” Accepting a
possible missed alert removed the need to make notification intent part of the
message's committed outcome. That changed the terms of the architecture
question. A notification service could receive a best-effort offer without
participating in message acceptance.

Revisions moved scheduling into the account inbox and then back beside the
messages, where access and
unread checks were local. A small scheduling table could avoid an eligibility
callback without restoring delivery retries. Local durable state could be
cheaper than a protocol, but avoiding the callback also assigned notification
state and maintenance to the actors responsible for
messages.

The user wanted the most product capability with the least engineering
complexity and continued to question keeping notification state in the message
owners. Simplification could not be evaluated only by removing features, tables
or network hops. Notification failures, preferences and scheduling also needed
an appropriate home.

An alternative-design review compared those responsibilities under the requested
boundary: message owners would emit candidates and answer read-only questions,
while notification state lived elsewhere. The designers favored different
mechanisms. Their comparisons exposed costs the earlier line estimates had
hidden, including waking recipients for every room message and sharing
notification failures with an owner's other maintenance. The critic recommended
a dedicated `NotificationDO` for the bounded instance.

In that proposal, the message owner would offer candidates after commit. The
notification actor would own waiting, grouping and delivery, asking the message
owner for eligibility when work became due. Subscriptions would remain with
identity data in D1, avoiding another copy of session authority. The new actor
and callback had a cost, but they isolated an optional responsibility from the
message lifecycle.

This returned to the separate actor that Claude had initially rejected, with
different guarantees. A lost offer could mean a missed alert while the message
remained intact. Once an offer was stored, its wait could be durable. Before
sending, the notification actor would ask the existing owners for the facts
needed to authorize delivery. A failed check could suppress or defer an alert
without undoing the message.

The callback was not a distributed commit barrier. It let the message owner
remain authoritative without making it own the notification schedule. The
original objection had depended on a stronger delivery obligation and assumed
replication of identity state. Once those assumptions changed, the separate
service deserved a fresh evaluation.

The [notification product case](web-push-product-boundary.md) continues this
discussion: later reviews rebuilt coordination around enrollment and delivery
freshness before reconsidering which behavior the product needed.

## What the comparison establishes

For transfer, confirmed predecessor closure blocked replacement. For push,
durable notification intent constrained placement. Evaluating either guarantee
required describing what failure would mean to the person.

A local table can remove a protocol; another actor can give optional behavior
an independent lifecycle. Compare equivalent product scope, including state,
retries, acknowledgements and failures each design must handle. Moving code
leaves those obligations intact, and dropping a useful feature changes the
product. Actor, RPC and line counts alone do not capture the maintenance cost.

A useful simplification names the benefit it preserves, the responsibility it
removes and the failure it deliberately permits. Authorization, command
identity, stale-result rejection and required enforcement remain explicit.
The [startup skeleton case study](startup-skeleton.md) applies this reasoning to
progressive pane reveal.

## Evidence and limits

The [native transfer tests](../../apps/server/tests/media-transfer.test.ts),
[receiver tests](../../apps/server/tests/media-subscription-transfer.test.ts) and
[browser fixture](../../tests/e2e/media-transfer.spec.ts) exercise the
retained boundary, including replacement while obsolete media continues flowing.
[Media verification](../media.md#verification-and-references) summarizes the live
SFU scope and its device and transport limits. The transfer commit added source and
tests overall; its demonstrated simplification was a removed blocking obligation.

The push alternatives were designs. Their code estimates used different
accounting until the critic normalized them. The review also identified runtime
assumptions that required further measurement. Protocol and browser experiments
did not validate an application architecture. The recommendation for a dedicated
actor records how the reasoning changed; it does not establish that topology as
a general winner or adopt its delivery and notification policies.

## Sources

The transfer account comes from Codex review session
`01a0b8fb-8afa-78f3-839f-413cb07ee085`, implementation session
`01a0b98a-8027-70d1-9353-dd075e2e5509` and commit `0c1f704`. The push account
comes from Claude Code session `790238ff-2dc2-4b5d-942c-3312aad4dae9`, including
the alternative-design reports and critic's comparison. These identifiers
preserve provenance; the account is self-contained and does not require private
artifacts or local transcripts.
