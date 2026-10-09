import { mediaTransaction } from "@/server/actors/media/diagnostics";
import type { MediaFailure, MediaHandle } from "@vaskel/contracts/media";
import type { Principal } from "@/server/domain/principal";
import type { MediaAuthorization } from "@/server/media/authorization";
import { authorizationError } from "@/server/media/runtime";
import { sha256Hex } from "@/server/auth/crypto";
import { participationDisposition } from "@/server/media/disposition";
import { markParticipantClosing } from "@/server/actors/media/cleanup";
import type { RoomRuntime, ParticipantRow } from "@/server/actors/media/store";
export async function authorizeParticipant(
  rt: RoomRuntime,
  principal: Principal,
  authorization: MediaAuthorization,
  handle: MediaHandle,
): Promise<
  MediaFailure | { kind: "participant"; participant: ParticipantRow }
> {
  const denied = authorizationError(principal, authorization, handle.room);
  if (denied) return denied;
  const claim = await rt.env.ACCOUNT_MEDIA.getByName(
    principal.userId,
  ).validateClaim(principal, handle);
  if (claim.kind !== "valid_claim") return claim;
  return mediaTransaction(rt, (rt) =>
    authorizeLocalParticipant(rt, principal, authorization, handle),
  );
}

/** Call only inside the native transaction that uses the participant state. */
export async function authorizeLocalParticipant(
  rt: RoomRuntime,
  principal: Principal,
  authorization: MediaAuthorization,
  handle: MediaHandle,
): Promise<
  MediaFailure | { kind: "participant"; participant: ParticipantRow }
> {
  const denied = authorizationError(principal, authorization, handle.room);
  if (denied) return denied;
  const participant = await rt.db
    .selectFrom("media_participants")
    .selectAll()
    .where("id", "=", handle.participantId)
    .where("generation", "=", handle.accountGeneration)
    .executeTakeFirst();
  if (!participant)
    return { kind: "recovery_required", handle, reason: "transport_closed" };
  if (
    participant.user_id !== principal.userId ||
    participant.session_id !== principal.sessionId ||
    participant.client_id !== handle.clientId ||
    participant.token_hash !== (await sha256Hex(handle.deviceToken))
  )
    return { kind: "forbidden" };
  if (participant.status !== "active")
    return participationDisposition(handle, participant.reason);
  const floor = await rt.db
    .selectFrom("media_permission_floors")
    .selectAll()
    .where("user_id", "=", principal.userId)
    .executeTakeFirst();
  if (authorization.permissionGeneration < (floor?.generation ?? 0)) {
    const closed = await markParticipantClosing(
      rt,
      participant,
      "permission_revoked",
    );
    return participationDisposition(
      handle,
      closed?.reason ?? "permission_revoked",
    );
  }
  await rt.db
    .updateTable("media_participants")
    .set({
      lease_expires: Math.min(authorization.expiresAt, principal.expiresAt),
      permission_generation: Math.max(
        participant.permission_generation,
        authorization.permissionGeneration,
      ),
    })
    .where("id", "=", participant.id)
    .where("generation", "=", participant.generation)
    .execute();
  return { kind: "participant", participant };
}
