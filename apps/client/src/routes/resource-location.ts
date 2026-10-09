import type { OwnerScope } from "@vaskel/contracts/messaging";

/** Typed destinations shared by directory links, mutations, search and calls. */
export function resourceLocation(owner: OwnerScope, channelId?: string) {
  if (owner.kind === "conversation")
    return {
      to: "/conversations/$conversationId" as const,
      params: { conversationId: owner.id },
    };
  if (channelId)
    return {
      to: "/servers/$serverId/channels/$channelId" as const,
      params: { serverId: owner.id, channelId },
    };
  return {
    to: "/servers/$serverId" as const,
    params: { serverId: owner.id },
  };
}
