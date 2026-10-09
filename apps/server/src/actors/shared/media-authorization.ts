import type { Kysely } from "kysely";
import type { MediaAuthorization } from "@/server/media/authorization";
import type { Principal } from "@/server/domain/principal";
import type { OwnerDatabase } from "./database";
import {
  access,
  ownerScope,
  principalFailure,
  type AccessFailure,
} from "./policy";

export type OwnerMediaAuthorizationOutcome =
  | AccessFailure
  | { kind: "media_authorized"; authorization: MediaAuthorization };

export async function authorizeMedia(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  input: { channelId: string },
): Promise<OwnerMediaAuthorizationOutcome> {
  return storage.transaction(async () => {
    const authorized = await access(database, principal, input.channelId);
    if (authorized.kind !== "authorized") return authorized;
    const { state, member, channel } = authorized;
    if (state.owner_kind === "server" && channel.kind !== "media")
      return { kind: "forbidden" };
    if (state.owner_kind === "conversation" && channel.id !== state.owner_id)
      return { kind: "forbidden" };
    const expired = principalFailure(principal);
    if (expired) return expired;
    return {
      kind: "media_authorized",
      authorization: {
        room: { owner: ownerScope(state), channelId: channel.id },
        userId: principal.userId,
        sessionId: principal.sessionId,
        permissionGeneration: state.permission_version,
        expiresAt: Math.min(principal.expiresAt, Date.now() + 30_000),
        canJoin: true,
        canSpeak: true,
        canCamera: true,
        canScreen: true,
        canModerate: state.owner_kind === "server" && member.role === "owner",
      },
    };
  });
}
