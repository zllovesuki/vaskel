import { InstanceCapacityFailureSchema } from "../instance-capacity";
import { z } from "zod";
import { MessagingFailureSchema } from "../messaging";
import { AttachmentFailureSchema } from "../attachments";
import { MediaFailureSchema } from "../media";
import { BlockFailureSchema } from "../blocking";
import { NotificationOutcomeSchema } from "../notifications";
import { IdentityFailureSchema } from "../identity";
import { outcome, identityResult, type Tag } from "./outcome";

const domainFailures = z.union([
  InstanceCapacityFailureSchema,
  MessagingFailureSchema,
  AttachmentFailureSchema,
  MediaFailureSchema,
  BlockFailureSchema,
  NotificationOutcomeSchema,
]);
function domain<V extends Tag<z.output<typeof domainFailures>, "kind">>(
  kind: V,
  status: number,
) {
  return { status, data: outcome(domainFailures, kind) };
}
function identity<
  V extends Tag<z.output<typeof IdentityFailureSchema>, "status">,
>(status: V, httpStatus: number) {
  return {
    status: httpStatus,
    data: identityResult(IdentityFailureSchema, status),
  };
}

/** Semantic error codes are shared by the HTTP contract and actor-outcome boundary. */
export const apiErrors = {
  BAD_REQUEST: { status: 400, data: z.unknown().optional() },
  INTERNAL_SERVER_ERROR: { status: 500 },
  INVALID_INPUT: domain("invalid_input", 400),
  UNAUTHENTICATED: { status: 401 },
  FORBIDDEN: { status: 403 },
  NOT_FOUND: { status: 404 },
  CAPACITY: domain("capacity", 429),
  STORAGE_CAPACITY: domain("storage_capacity", 429),
  INSTANCE_CAPACITY: {
    status: 429,
    data: z.union([
      outcome(domainFailures, "instance_capacity"),
      identityResult(IdentityFailureSchema, "instance_capacity"),
    ]),
  },
  DM_BLOCKED: domain("dm_blocked", 409),
  SOURCE_UNAVAILABLE: domain("source_unavailable", 409),
  MESSAGE_UNAVAILABLE: domain("message_unavailable", 409),
  COMMAND_CONFLICT: domain("command_conflict", 409),
  COMMAND_EXPIRED: domain("command_expired", 409),
  STALE_VERSION: domain("stale_version", 409),
  STALE_REVISION: domain("stale_revision", 409),
  QUERY_TOO_SHORT: domain("query_too_short", 400),
  RESET_REQUIRED: domain("reset_required", 409),
  ATTACHMENT_NOT_READY: domain("attachment_not_ready", 409),
  ATTACHMENT_EXPIRED: domain("attachment_expired", 409),
  ATTACHMENT_CLAIMED: domain("attachment_claimed", 409),
  UPLOAD_IN_PROGRESS: domain("upload_in_progress", 409),
  INTEGRITY_MISMATCH: domain("integrity_mismatch", 400),
  CLEANUP_PENDING: domain("cleanup_pending", 409),
  SOCKET_UNAVAILABLE: { status: 409 },
  UNAVAILABLE: { status: 503 },
  PROVIDER_ERROR: domain("provider_error", 502),
  STALE_GENERATION: domain("stale_generation", 409),
  MODERATION_CHANGED: domain("moderation_changed", 409),
  TRANSFER_REQUIRED: domain("transfer_required", 409),
  SESSION_BUSY: domain("session_busy", 409),
  NEGOTIATION_EXPIRED: domain("negotiation_expired", 409),
  RECOVERY_REQUIRED: domain("recovery_required", 409),
  PARTICIPATION_ENDED: domain("participation_ended", 409),
  PUBLICATION_UNAVAILABLE: domain("publication_unavailable", 409),
  ACTION_RESTRICTED: domain("action_restricted", 403),
  INVALID_REQUEST: identity("invalid_request", 400),
  INVALID_CREDENTIALS: identity("invalid_credentials", 401),
  EMAIL_UNVERIFIED: identity("email_unverified", 403),
  INVALID_TOKEN: identity("invalid_token", 400),
  BOOTSTRAP_COMPLETE: identity("bootstrap_complete", 409),
  BOOTSTRAP_EXPIRED: identity("bootstrap_expired", 409),
  EMAIL_TAKEN: identity("email_taken", 409),
  AUTHORIZATION_CONFLICT: identity("authorization_conflict", 409),
  RATE_LIMITED: { status: 429 },
  PAYLOAD_TOO_LARGE: { status: 413 },
  ORIGIN_REJECTED: { status: 403 },
} as const;
export type ApiErrorCode = keyof typeof apiErrors;

export function errorsFor<const Keys extends readonly ApiErrorCode[]>(
  ...keys: Keys
): Pick<typeof apiErrors, Keys[number]> {
  return Object.fromEntries(keys.map((key) => [key, apiErrors[key]])) as Pick<
    typeof apiErrors,
    Keys[number]
  >;
}
export const identityErrors = errorsFor(
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "RATE_LIMITED",
  "INVALID_REQUEST",
  "INVALID_CREDENTIALS",
  "EMAIL_UNVERIFIED",
  "INVALID_TOKEN",
  "BOOTSTRAP_COMPLETE",
  "BOOTSTRAP_EXPIRED",
  "EMAIL_TAKEN",
  "AUTHORIZATION_CONFLICT",
  "INSTANCE_CAPACITY",
);
export const messagingErrors = errorsFor(
  "STORAGE_CAPACITY",
  "DM_BLOCKED",
  "SOURCE_UNAVAILABLE",
  "MESSAGE_UNAVAILABLE",
  "COMMAND_CONFLICT",
  "COMMAND_EXPIRED",
  "STALE_VERSION",
  "QUERY_TOO_SHORT",
  "RESET_REQUIRED",
  "ATTACHMENT_NOT_READY",
  "ATTACHMENT_EXPIRED",
  "ATTACHMENT_CLAIMED",
  "UPLOAD_IN_PROGRESS",
  "INTEGRITY_MISMATCH",
  "SOCKET_UNAVAILABLE",
);
export const mediaErrors = errorsFor(
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CAPACITY",
  "COMMAND_CONFLICT",
  "COMMAND_EXPIRED",
  "STALE_VERSION",
  "CLEANUP_PENDING",
  "PROVIDER_ERROR",
  "STALE_GENERATION",
  "MODERATION_CHANGED",
  "TRANSFER_REQUIRED",
  "SESSION_BUSY",
  "NEGOTIATION_EXPIRED",
  "RECOVERY_REQUIRED",
  "PARTICIPATION_ENDED",
  "PUBLICATION_UNAVAILABLE",
  "ACTION_RESTRICTED",
);
export const commandErrors = errorsFor(
  "COMMAND_CONFLICT",
  "COMMAND_EXPIRED",
  "STALE_REVISION",
);
