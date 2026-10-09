import type { OwnerActivity } from "@vaskel/contracts/activity";

export type ChannelActivity = OwnerActivity["channels"][number];
const COUNT_CAP = 100;

/** Unread and mention counts describe the same private read position. */
export function withActivityCounts(channel: ChannelActivity): ChannelActivity {
  const caughtUp = channel.readSequence >= channel.lastCreatedSequence;
  const unreadCount = caughtUp
    ? 0
    : Math.min(COUNT_CAP, Math.max(0, channel.unreadCount));
  return {
    ...channel,
    unreadCount,
    mentionCount: caughtUp
      ? 0
      : Math.min(unreadCount, Math.max(0, channel.mentionCount)),
    hasUnread: unreadCount > 0,
  };
}

/** Preserve positions observed after an authoritative request began. */
export function mergeChannelActivity(
  previous: ChannelActivity | undefined,
  incoming: ChannelActivity,
): ChannelActivity {
  const lastCreatedSequence = Math.max(
    incoming.lastCreatedSequence,
    previous?.lastCreatedSequence ?? 0,
  );
  const readSequence = Math.max(
    incoming.readSequence,
    previous?.readSequence ?? 0,
  );
  // A response below either known position cannot replace counts for newer state.
  const counts =
    previous &&
    (incoming.lastCreatedSequence < previous.lastCreatedSequence ||
      incoming.readSequence < previous.readSequence)
      ? previous
      : incoming;
  return withActivityCounts({
    ...incoming,
    lastCreatedSequence,
    readSequence,
    unreadCount: counts.unreadCount,
    mentionCount: counts.mentionCount,
  });
}
