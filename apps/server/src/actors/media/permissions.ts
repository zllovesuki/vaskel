import type { MediaFailure, MediaSource } from "@vaskel/contracts/media";
import type { MediaAuthorization } from "@/server/media/authorization";
import type { ParticipantRow, RoomRuntime } from "@/server/actors/media/store";

export function publicationError(
  participant: ParticipantRow,
  authorization: MediaAuthorization,
  sources: readonly MediaSource[],
): MediaFailure | null {
  if (
    sources.some(
      (source) => source === "microphone" || source === "screen_audio",
    ) &&
    (!authorization.canSpeak || participant.muted)
  )
    return { kind: "action_restricted", restriction: "mute" };
  if (sources.includes("camera") && !authorization.canCamera)
    return { kind: "action_restricted", restriction: "camera" };
  if (
    sources.some(
      (source) => source === "screen_video" || source === "screen_audio",
    ) &&
    (!authorization.canScreen || participant.screen_revoked)
  )
    return { kind: "action_restricted", restriction: "screen" };
  return null;
}

export function subscriptionError(
  participant: ParticipantRow,
): MediaFailure | null {
  return participant.deafened
    ? { kind: "action_restricted", restriction: "deafen" }
    : null;
}

export async function availablePublications(
  rt: RoomRuntime,
  participantId: string,
  ids: string[],
) {
  return ids.length
    ? rt.db
        .selectFrom("media_publications")
        .selectAll()
        .where("id", "in", [...new Set(ids)])
        .where("ready", "=", 1)
        .where("participant_id", "!=", participantId)
        .execute()
    : [];
}
