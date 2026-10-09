import type { ResourceSummary } from "@vaskel/contracts/directory";
import type { OwnerScope } from "@vaskel/contracts/messaging";

export interface ResourceParams {
  serverId?: string | undefined;
  channelId?: string | undefined;
  conversationId?: string | undefined;
}
/** The room or conversation this account last opened on this device. */
export interface RememberedPlace {
  owner: OwnerScope;
  channelId: string;
}
const placeKey = (userId: string) => `vaskel.place:${userId}`;
export function readRememberedPlace(userId: string): RememberedPlace | null {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(placeKey(userId)) ?? "null",
    );
    if (typeof value !== "object" || value === null) return null;
    const { owner, channelId } = value as Partial<RememberedPlace>;
    return (owner?.kind === "server" || owner?.kind === "conversation") &&
      typeof owner.id === "string" &&
      typeof channelId === "string"
      ? { owner: { kind: owner.kind, id: owner.id }, channelId }
      : null;
  } catch {
    return null;
  }
}
/** A per-device convenience like section expansion, never account state. */
export function rememberPlace(userId: string, place: RememberedPlace) {
  try {
    localStorage.setItem(placeKey(userId), JSON.stringify(place));
  } catch {
    /* Private windows may refuse storage; the next visit starts at the default. */
  }
}

export function selectResource(
  resources: ResourceSummary[],
  params: ResourceParams,
  remembered: RememberedPlace | null = null,
) {
  const requested = Boolean(params.serverId || params.conversationId);
  // Without a requested place, return to the one last opened here while the
  // directory still lists it; otherwise the first place with a room.
  const rememberedResource =
    requested || !remembered
      ? undefined
      : resources.find(
          (item) =>
            item.owner.kind === remembered.owner.kind &&
            item.owner.id === remembered.owner.id &&
            item.channels.some(
              (channel) => channel.id === remembered.channelId,
            ),
        );
  const rememberedChannel = rememberedResource && remembered?.channelId;
  const resource = params.serverId
    ? resources.find(
        (item) =>
          item.owner.kind === "server" && item.owner.id === params.serverId,
      )
    : params.conversationId
      ? resources.find(
          (item) =>
            item.owner.kind === "conversation" &&
            item.owner.id === params.conversationId,
        )
      : (rememberedResource ??
        resources.find((item) => item.channels.length > 0));
  // Directory channels are already permission-filtered by their owning actor.
  // Never replace a missing explicit channel with another conversation.
  const channel = params.channelId
    ? resource?.channels.find((item) => item.id === params.channelId)
    : rememberedChannel
      ? resource?.channels.find((item) => item.id === rememberedChannel)
      : resource?.channels[0];
  return { requested, resource, channel };
}
