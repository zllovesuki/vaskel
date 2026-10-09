import { apiFailure } from "@/client/api/errors";
import { errorMessage } from "@/client/api/errors";
import {
  message,
  UiMessageError,
  type UiMessage,
} from "@/client/features/i18n/messages";
import type {
  MediaFailure,
  MediaOutcome,
  MediaPublication,
  MediaRoomRef,
  MediaSnapshot,
} from "@vaskel/contracts/media";

export class MediaError extends Error {
  constructor(readonly outcome: MediaFailure) {
    super(outcome.kind);
  }
}
export class ReplacedGeneration extends Error {}
export class RosterUnavailable extends UiMessageError {
  constructor() {
    super(message("media.connectionEnded"));
  }
}
export function actionFailure(error: unknown): error is MediaError {
  return (
    error instanceof MediaError &&
    (error.outcome.kind === "action_restricted" ||
      error.outcome.kind === "publication_unavailable")
  );
}
export function mediaFailureMessage(failure: MediaFailure): UiMessage {
  switch (failure.kind) {
    case "recovery_required":
      return message("media.connectionEnded");
    case "participation_ended":
      return failure.reason === "removed"
        ? message("media.removed")
        : failure.reason === "permission_revoked"
          ? message("media.permissionRevoked")
          : message("media.left");
    case "action_restricted":
      return failure.restriction === "deafen"
        ? message("media.listeningRestricted")
        : failure.restriction === "mute"
          ? message("media.audioRestricted")
          : failure.restriction === "camera"
            ? message("media.cameraRestricted")
            : message("media.screenRestricted");
    case "moderation_changed":
      return message("media.moderationChanged");
    case "publication_unavailable":
      return message("media.publicationUnavailable");
    case "forbidden":
      return message("media.permissionRevoked");
    case "unauthenticated":
      return message("media.sessionEnded");
    case "not_found":
      return message("media.unavailableRoom");
    case "stale_generation":
      return message("media.staleGeneration");
    case "transfer_required":
      return message("media.transferRequired");
    case "capacity":
      return message("media.capacity");
    case "cleanup_pending":
      return message("media.cleanupPending");
    case "unavailable":
      return message("media.unavailable");
    case "provider_error":
      return message("media.providerFailure");
    case "negotiation_expired":
    case "session_busy":
    case "stale_version":
      return message("media.connectionChanged");
    default:
      return message("media.actionFailed");
  }
}
export function expectMedia<K extends MediaOutcome["kind"]>(
  result: MediaOutcome,
  kind: K,
): Extract<MediaOutcome, { kind: K }> {
  if (result.kind !== kind) throw new MediaError(result as MediaFailure);
  return result as Extract<MediaOutcome, { kind: K }>;
}
export function sameRoom(
  left: MediaRoomRef | null | undefined,
  right: MediaRoomRef | null | undefined,
) {
  return Boolean(
    left &&
    right &&
    left.owner.kind === right.owner.kind &&
    left.owner.id === right.owner.id &&
    left.channelId === right.channelId,
  );
}
/** Audio for permitted peers, four visible cameras, and one explicitly selected screen. */
export function desiredPublications(
  snapshot: MediaSnapshot,
  participantId: string,
  selectedScreen: string | null,
  visible: { cameras: boolean; screen: boolean },
  hiddenUserIds: ReadonlySet<string> = new Set(),
): MediaPublication[] {
  const self = snapshot.participants.find((p) => p.id === participantId);
  if (!self || self.deafened) return [];
  const peers = snapshot.participants.filter(
    (p) =>
      p.id !== participantId &&
      p.status === "active" &&
      !hiddenUserIds.has(p.userId),
  );
  const cameras = visible.cameras
    ? peers
        .flatMap((p) => p.publications)
        .filter((p) => p.source === "camera")
        .slice(0, 4)
    : [];
  const selected = visible.screen
    ? peers
        .flatMap((p) => p.publications)
        .find((p) => p.id === selectedScreen && p.source === "screen_video")
    : undefined;
  return peers.flatMap((peer) =>
    peer.publications.filter(
      (pub) =>
        (pub.source === "microphone" && !peer.muted) ||
        cameras.some((camera) => camera.id === pub.id) ||
        (pub.source === "screen_video" && pub.id === selected?.id) ||
        (pub.source === "screen_audio" &&
          !peer.muted &&
          peer.id === selected?.participantId),
    ),
  );
}
/** A failed exchange still releases its queue, but the owner fences that generation. */
export class SessionQueue {
  private tail: Promise<void> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function mediaErrorMessage(error: unknown): UiMessage {
  if (error instanceof MediaError) return mediaFailureMessage(error.outcome);
  if (error instanceof UiMessageError) return error.uiMessage;
  if (apiFailure(error)) return errorMessage(error);
  return message("media.actionFailed");
}

export function terminalMediaFailure(error: unknown) {
  if (apiFailure(error))
    return ["unauthenticated", "forbidden", "not_found"].includes(
      apiFailure(error)?.code ?? "",
    );
  return (
    error instanceof MediaError &&
    [
      "participation_ended",
      "stale_generation",
      "unauthenticated",
      "forbidden",
      "not_found",
    ].includes(error.outcome.kind)
  );
}
