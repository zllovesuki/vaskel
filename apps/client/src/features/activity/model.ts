import type { OwnerActivity } from "@vaskel/contracts/activity";
import type { ResourceSummary } from "@vaskel/contracts/directory";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import { ownerIdentity } from "@/client/api/activity";

export type UnreadState = "unread" | "read" | "unknown";
/** New: the start-here hint shows. Done: the viewer dismissed it or opened every room. */
export type CircleStatus = "new" | "done";
export const channelIdentity = (owner: OwnerScope, channelId: string) =>
  `${ownerIdentity(owner)}:${channelId}`;
export function activityModel(
  resources: ResourceSummary[],
  owners: OwnerActivity[],
  unavailable: OwnerScope[],
  trusted: boolean,
  circleStatus: ReadonlyMap<string, CircleStatus> = new Map(),
) {
  const states = new Map<string, UnreadState>();
  // Capped counts of messages from other authors above the read cursor.
  const counts = new Map<string, number>();
  // The subset of those messages that name the reader.
  const mentions = new Map<string, number>();
  const denied = new Set(unavailable.map(ownerIdentity));
  const positions = new Map<string, { last: number; read: number }>();
  const generations = new Map<string, string>();
  if (trusted)
    for (const owner of owners) {
      const identity = ownerIdentity(owner.owner);
      if (denied.has(identity)) continue;
      const generation = generations.get(identity);
      if (generation && generation !== owner.generation) continue;
      generations.set(identity, owner.generation);
      for (const channel of owner.channels) {
        const key = channelIdentity(owner.owner, channel.channelId);
        const previous = positions.get(key);
        // Positions never move backwards. The counts follow the entry with
        // the furthest read cursor, since that one saw the newer state.
        if (
          !previous ||
          channel.readSequence > previous.read ||
          (channel.readSequence === previous.read &&
            channel.lastCreatedSequence >= previous.last)
        ) {
          counts.set(key, channel.unreadCount);
          mentions.set(key, channel.mentionCount);
        }
        positions.set(key, {
          last: Math.max(previous?.last ?? 0, channel.lastCreatedSequence),
          read: Math.max(previous?.read ?? 0, channel.readSequence),
        });
      }
    }
  for (const [key, position] of positions) {
    if (position.read >= position.last) {
      counts.set(key, 0);
      mentions.set(key, 0);
    }
    states.set(key, (counts.get(key) ?? 0) > 0 ? "unread" : "read");
  }
  // A circle first seen with none of its rooms opened is new to the viewer and
  // stays so until dismissed or every room has been opened: its unopened rooms
  // with messages are new rather than unread, and the inbox leaves them out,
  // since it lists places already followed.
  const newOwners = new Set<string>();
  const settledOwners = new Set<string>();
  const fresh = new Set<string>();
  for (const resource of resources) {
    if (resource.owner.kind !== "server") continue;
    const identity = ownerIdentity(resource.owner);
    const status = circleStatus.get(identity);
    if (status === "done") continue;
    const keys = resource.channels
      .filter((channel) => channel.kind === "text")
      .map((channel) => channelIdentity(resource.owner, channel.id));
    const known = keys.length > 0 && keys.every((key) => positions.has(key));
    if (status === undefined) {
      if (!known || !keys.every((key) => positions.get(key)?.read === 0))
        continue;
    } else if (
      known &&
      keys.every((key) => (positions.get(key)?.read ?? 0) > 0)
    ) {
      settledOwners.add(identity);
      continue;
    }
    newOwners.add(identity);
    // A room that names the viewer is never merely new: it stays unread.
    for (const key of keys) {
      const position = positions.get(key);
      if (
        position &&
        position.read === 0 &&
        position.last > 0 &&
        (mentions.get(key) ?? 0) === 0
      )
        fresh.add(key);
    }
  }
  const destinations = resources.flatMap((resource) =>
    resource.channels
      .filter((channel) => channel.kind === "text")
      .map((channel) => ({
        owner: resource.owner,
        participantIds: resource.participantIds,
        channelId: channel.id,
        resourceName: resource.name,
        channelName: channel.name,
        private: channel.private,
        label:
          resource.owner.kind === "server"
            ? `${resource.name} / ${channel.name}`
            : resource.name,
        count: counts.get(channelIdentity(resource.owner, channel.id)) ?? 0,
        mentionCount:
          mentions.get(channelIdentity(resource.owner, channel.id)) ?? 0,
      })),
  );
  return {
    states,
    counts,
    mentions,
    newOwners,
    settledOwners,
    fresh,
    incomplete: destinations.some(
      (destination) =>
        !states.has(channelIdentity(destination.owner, destination.channelId)),
    ),
    unread: destinations.filter((destination) => {
      const key = channelIdentity(destination.owner, destination.channelId);
      return states.get(key) === "unread" && !fresh.has(key);
    }),
  };
}
