import type { MediaFailure, MediaRoomRef } from "@vaskel/contracts/media";
import type { Principal } from "@/server/domain/principal";
import {
  mediaRoomKey,
  type MediaAuthorization,
} from "@/server/media/authorization";
export function principalError(principal: Principal): MediaFailure | null {
  return principal.expiresAt <= Date.now() ? { kind: "unauthenticated" } : null;
}
export function authorizationError(
  principal: Principal,
  grant: MediaAuthorization,
  room: MediaRoomRef,
): MediaFailure | null {
  return principalError(principal) ?? grantError(principal, grant, room);
}
/** Trusted claims carry endpoint identity, not the authenticated session expiry. */
export function grantError(
  identity: Pick<Principal, "userId" | "sessionId">,
  grant: MediaAuthorization,
  room: MediaRoomRef,
): MediaFailure | null {
  if (
    grant.userId !== identity.userId ||
    grant.sessionId !== identity.sessionId ||
    mediaRoomKey(grant.room) !== mediaRoomKey(room) ||
    !grant.canJoin ||
    grant.expiresAt > Date.now() + 31_000
  )
    return { kind: "forbidden" };
  if (grant.expiresAt <= Date.now()) return { kind: "unavailable" };
  return null;
}
export function commandTimeError(issuedAt: number): MediaFailure | null {
  return issuedAt < Date.now() - 90_000 || issuedAt > Date.now() + 30_000
    ? { kind: "command_expired" }
    : null;
}
