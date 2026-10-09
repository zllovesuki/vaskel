import type { QueryClient } from "@tanstack/react-query";
import type { OwnerActivity } from "@vaskel/contracts/activity";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import {
  accountActivityKey,
  activityKey,
  ownerActivityKey,
  ownerIdentity,
  type ActivityData,
} from "@/client/api/activity";
import { timelineKey } from "@/client/api/client";
import type { Timeline } from "@/client/features/chat/reconcile";
import { updateActivity } from "@/client/features/account-events/apply";
import { withActivityCounts } from "./counts";

/** Positions are monotonic; positive badge counts come only from owner summaries. */
export function syncTimelineActivity(
  client: QueryClient,
  userId: string,
  owner: OwnerScope,
  channelId: string,
  timeline: Timeline,
) {
  const lastCreatedSequence = timeline.lastCreatedSequence;
  let refresh = false;
  function update(current: OwnerActivity): OwnerActivity {
    if (
      ownerIdentity(current.owner) !== ownerIdentity(owner) ||
      current.generation !== timeline.cursor.generation
    )
      return current;
    let changed = false;
    const channels = current.channels.map((channel) => {
      if (channel.channelId !== channelId) return channel;
      const last = Math.max(channel.lastCreatedSequence, lastCreatedSequence);
      const read = Math.max(channel.readSequence, timeline.readSequence);
      if (last === channel.lastCreatedSequence && read === channel.readSequence)
        return channel;
      if (read < last) refresh = true;
      changed = true;
      return withActivityCounts({
        ...channel,
        lastCreatedSequence: last,
        readSequence: read,
      });
    });
    return changed ? { ...current, channels } : current;
  }
  updateActivity(client, userId, owner, update);
  // New creations and partial reads need an authoritative count.
  if (refresh) void client.invalidateQueries({ queryKey: activityKey(userId) });
}

export function syncActivityReads(
  client: QueryClient,
  userId: string,
  owners: OwnerActivity[],
) {
  for (const owner of owners)
    for (const channel of owner.channels) {
      const key = timelineKey(userId, owner.owner, channel.channelId);
      const current = client.getQueryData<Timeline>(key);
      if (!current || current.cursor.generation !== owner.generation) continue;
      const next =
        channel.readSequence > current.readSequence
          ? { ...current, readSequence: channel.readSequence }
          : current;
      if (next !== current) client.setQueryData<Timeline>(key, next);
      // A read/socket update may arrive before the first summary request resolves.
      syncTimelineActivity(
        client,
        userId,
        owner.owner,
        channel.channelId,
        next,
      );
    }
}

export function invalidateActivityAccess(
  client: QueryClient,
  userId: string,
  owner: OwnerScope,
) {
  // Cancel older summaries before removing a denied owner's private positions.
  void client.cancelQueries({ queryKey: activityKey(userId) });
  client.setQueriesData<ActivityData>(
    { queryKey: accountActivityKey(userId) },
    (data) =>
      data && {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          owners: page.owners.filter(
            (item) => ownerIdentity(item.owner) !== ownerIdentity(owner),
          ),
          unavailableOwners: [
            ...page.unavailableOwners.filter(
              (item) => ownerIdentity(item) !== ownerIdentity(owner),
            ),
            owner,
          ],
          partial: true,
        })),
      },
  );
  client.removeQueries({ queryKey: ownerActivityKey(userId, owner) });
  void client.invalidateQueries({ queryKey: activityKey(userId) });
}
