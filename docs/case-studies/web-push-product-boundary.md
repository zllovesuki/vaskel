# Case study: give notifications a product boundary

A notification service became simpler when message acceptance stopped promising
an alert. Later reviews rebuilt coordination around enrollment and delivery
freshness. The [earlier coordination case](guarantees-and-coordination.md)
explains the first change; this continuation examines why it did not settle
the design.

## Why the service kept growing

The user proposed one notification actor per account. It would own subscription
keys, support several devices and expose a small interface for enrollment and
notification requests. Message owners would retain messages and permissions.

Enrollment was expected to survive login expiry. Codex separated it from the
session lifetime but initially retained checks against the password credential
epoch: a version used to invalidate old credential authority. That preserved
another login-security dependency without first establishing whether password
changes should end notification enrollment.

A review against the existing case studies removed durable recovery for each
delivery target and credentials for finishing cleanup after logout. These were
useful reductions. Other obligations survived the review and shaped subsequent
changes.

When the user suggested Queues to isolate provider HTTP, the design queued an
account wake-up. The consumer returned to the actor to claim work, obtain fresh
eligibility checks and receive expiring prepared requests. This kept checks
after the Queue wait and prevented redelivery from replaying consumed work. It
also required claim handling, deadlines and coordination between the scheduler
and executor.

Frequent D1 checks then prompted a discussion of cached validity snapshots and
independent notification enrollment. Independence removed the routine D1 reads,
but the plan still introduced a notification-specific authority assertion for
the internal owner call. The user had asked for a component with its own domain;
the design kept reconstructing fresh identity authority for its background work.

Each mechanism answered a plausible concern. The accumulated promise had not
been evaluated as a product choice. Moving subscriptions into an actor did not
by itself require copying login validity, and moving HTTP into a Queue did not
by itself require the actor and consumer to coordinate a final sending decision.

## Research changed the question

The user recognized the recurring pattern and asked to reconsider what push
should contribute to vaskel. Codex initially offered a choice between an alert
about an authorized past event and an alert about something still unread and
accessible. The user asked for research into comparable products before making
that choice.

Slack described suppressing a mobile alert when the message was read during
its notification delay. Google Chat described routing by recent activity,
including notifying multiple devices when inactive. Discord documented
conversation controls and suppression while its mobile app was open and focused.
These were evidence that avoiding unnecessary interruption had product value.
[Slack's explanation](https://slack.com/resources/using-slack/customize-your-notifications-in-slack),
[Google Chat's notification help](https://support.google.com/chat/answer/7655718?hl=en&co=GENIE.Platform%3DDesktop)
and [Discord's mobile guide](https://support.discord.com/hc/en-us/articles/218892547--Mobile-Notifications-Settings-101)
described that behavior without establishing their internal backend protocols.

For vaskel, the benefit was that friends could reach someone who was away and
bring them back to the conversation, without first contacting them through
another app. Home and unread state already supplied recovery once the person
returned. Push supplied the invitation to return.

That purpose supported read suppression. If someone read a message during a
short wait, an additional interruption served little purpose. An existing
private read cursor supplied the decision. A connected tab or participation in
a call did not prove that someone had seen the text, so the feature did not need
another system for tracking device activity.

The earlier either/or question was too broad. The app could suppress alerts for
messages already read before dispatch while accepting that a dispatched alert
might later become outdated. Those choices did not need the same guarantee.

## The smaller responsibility

The revised design kept subscriptions, keys, preferences, grouping and durable
waiting in the account actor. Message owners offered references after commit
and answered a narrow eligibility read when work became due. Current access,
blocking, deletion and the qualifying message's read state remained checked
with their owning data.

After that decision, the actor could hand ready encrypted requests to Queues.
The consumer would perform bounded provider calls and retries without returning
to claim work or reconstruct identity authority. Authentication remained
necessary for enrollment and device management. The internal owner read used a
trusted application boundary and checked the recipient's access; it did not
need to impersonate a browser session.

This moved the eligibility decision before the Queue wait. An alert could
therefore arrive after a later read, mute, permission change or device removal.
Retries could repeat it. Those consequences were stated separately: earlier
acceptance of missed alerts had not automatically accepted duplicates or an
earlier permission check. Opening an alert still required current application
access.

The same product framing removed exact lock-screen unread totals and the
online/offline timing branch. A short fixed wait, activity or a preview, and
an approximate badge served the purpose. This preserved conversation controls
and read suppression while removing additional state comparisons.

Local stale-operation safeguards remained. A delayed Enable must not undo a
device removal, and a provider error for an old subscription must not delete
its replacement. These protect concrete user actions. A credential epoch, a
cached identity result and a device-record version have different purposes;
calling each a version or snapshot does not make their lifetimes interchangeable.

## Why the first simplification did not stick

The first review removed the obligation to deliver an alert for every accepted
message. Later reviews continued to optimize other assumptions: notification
lifetime should follow credential changes, eligibility should remain fresh
across a Queue wait, and transport should never repeat consumed work. The
mechanisms changed while those promises remained.

The second reset evaluated those promises against the intended experience.
Research helped identify behavior worth keeping, and existing data owners
supplied the checks. Reading the earlier case studies had not been enough;
the remaining obligations still needed that evaluation.

A small service can retain a domain callback when it protects useful behavior.
The source eligibility read earned its place because read suppression and
access mattered. The executor claim protocol served stronger delivery promises
that the product could relax. Removing both would have discarded useful
behavior along with unnecessary coordination.

The review produced a design with fewer coordination responsibilities. Its
effect on implementation size, latency and delivery quality remained to be
measured.
