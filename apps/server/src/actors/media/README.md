# Media backend

MediaRoomDO owns room membership, publications/subscriptions, negotiation and
forwarding cleanup. AccountMediaDO owns one account's participation intent and
generations across devices. Canonical messages and permissions remain in
ServerDO/ConversationDO; identity remains in D1.

| Module                                                                       | Responsibility                                                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [media-room-do.ts](media-room-do.ts)                                         | Typed room RPC entry point.                                                                      |
| [negotiation/publications.ts](negotiation/publications.ts)                   | Publish, producer ACK and unpublish.                                                             |
| [negotiation/subscriptions.ts](negotiation/subscriptions.ts)                 | Subscribe and consumer answer.                                                                   |
| [operations.ts](operations.ts)                                               | Durable operation ownership, phases, receipts and allocation tracking.                           |
| [authorization.ts](authorization.ts), [permissions.ts](permissions.ts)       | Handle/claim admission and current source/subscription restrictions.                             |
| [membership.ts](membership.ts), [moderation.ts](moderation.ts)               | Participant admission, leases, scoped cleanup ownership and moderation receipts.                 |
| [cleanup.ts](cleanup.ts), [alarm.ts](alarm.ts), [retention.ts](retention.ts) | Forwarding cleanup, durable wakeups and bounded terminal retention.                              |
| [occupancy.ts](occupancy.ts)                                                 | Durable room-to-owner projection for occupancy and call-change hints.                            |
| [account lifecycle](../account-media/lifecycle.ts)                           | Account Join/Transfer/Resume, Leave and revocation, with local claim, store and cleanup modules. |

Helpers execute on their owning actor. Permission checks, reservations and
completion stay inside native transactions; external SFU and actor calls stay at
their existing boundaries. Late allocations remain cleanup obligations.

See [Media participation](../../../../../docs/media.md) for account intent and
replacement, [Media transport](../../../../../docs/media-transport.md) for
negotiation and cleanup, and
[Synchronization](../../../../../docs/synchronization.md) for account-event hints.
[Media verification](../../../../../docs/media.md#verification-and-references)
distinguishes local, provider and device evidence and remaining acceptance.
