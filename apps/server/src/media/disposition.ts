import type {
  MediaEndReason,
  MediaFailure,
  MediaHandle,
  MediaRecoveryReason,
} from "@vaskel/contracts/media";

export type MediaClosureCause =
  | "leave"
  | "replace"
  | "transfer"
  | "removed"
  | "permission_revoked"
  | "lease_expired"
  | "negotiation_expired"
  | "uncertain_allocation"
  | "allocation_failed"
  | "stale_admission"
  | "negotiation_failed"
  | "publication_revoked"
  | "stale_publication"
  | "publication_unavailable"
  | "stale_subscription"
  | "subscription_revoked"
  | "stale_answer"
  | "answer_revoked"
  | "stale_unpublish"
  | "unpublish_revoked"
  | "moderation_cleanup";

export type MediaClosureDisposition =
  | { kind: "recoverable"; reason: MediaRecoveryReason }
  | { kind: "terminal"; reason: MediaEndReason };

export function closureDisposition(
  cause: MediaClosureCause | null,
): MediaClosureDisposition {
  switch (cause) {
    case "leave":
      return { kind: "terminal", reason: "left" };
    case "removed":
    case "permission_revoked":
      return { kind: "terminal", reason: cause };
    case "lease_expired":
    case "negotiation_expired":
      return { kind: "recoverable", reason: cause };
    case "uncertain_allocation":
    case "allocation_failed":
    case "stale_admission":
      return { kind: "recoverable", reason: "admission_failed" };
    default:
      return { kind: "recoverable", reason: "transport_closed" };
  }
}

export function participationDisposition(
  handle: MediaHandle,
  cause: MediaClosureCause | null,
): MediaFailure {
  const disposition = closureDisposition(cause);
  return disposition.kind === "terminal"
    ? {
        kind: "participation_ended",
        generation: handle.accountGeneration,
        reason: disposition.reason,
      }
    : { kind: "recovery_required", handle, reason: disposition.reason };
}
