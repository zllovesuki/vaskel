import { ORPCError } from "@orpc/client";
import {
  message,
  UiMessageError,
  type UiMessage,
} from "@/client/features/i18n/messages";

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status?: number,
    /**
     * Where the failure was observed. Transport itself reports `http` denials
     * to the access coordinator; `socket` is a room frame and `directory` an
     * authorized directory that does not list the owner.
     */
    public readonly failure:
      | "http"
      | "contract"
      | "network"
      | "blocked"
      | "socket"
      | "directory" = "http",
    public readonly requestId?: string,
  ) {
    super(`vaskel. request failed: ${code}`);
    this.name = "ApiError";
  }
}
const protocolCodes = new Map([
  ["BAD_REQUEST", "invalid_input"],
  ["PAYLOAD_TOO_LARGE", "invalid_input"],
  ["INTERNAL_SERVER_ERROR", "unavailable"],
]);
const unreadableDenials = new Map([
  [400, "invalid_input"],
  [413, "invalid_input"],
  [401, "unauthenticated"],
  [403, "forbidden"],
  [404, "not_found"],
]);

/** A validated native failure is authoritative; unreadable bodies retain HTTP denial facts. */
export function responseFailure(
  response: Response,
  error?: unknown,
): ApiError | ORPCError<string, unknown> {
  const requestId = responseRequestId(response);
  if (
    error instanceof ORPCError &&
    error.defined &&
    error.status === response.status
  ) {
    Object.assign(error, { requestId });
    return error;
  }
  return new ApiError(
    unreadableDenials.get(response.status) ?? "unavailable",
    response.status,
    response.ok ? "contract" : "http",
    requestId,
  );
}

/** Accept correlation tokens, never arbitrary response text as UI copy. */
export function responseRequestId(
  response: Response,
  fallback?: string,
): string | undefined {
  for (const value of [response.headers.get("X-Request-ID"), fallback]) {
    if (value && /^[A-Za-z0-9_-]{1,128}$/.test(value)) return value;
  }
  return undefined;
}

/** A common view of HTTP failure facts for browser retirement and UI recovery. */
export function apiFailure(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error;
  if (!(error instanceof ORPCError)) return null;
  const code = protocolCodes.get(error.code) ?? error.code.toLowerCase();
  const requestId =
    "requestId" in error && typeof error.requestId === "string"
      ? error.requestId
      : undefined;
  return new ApiError(code, error.status, "http", requestId);
}

export class NetworkError extends ApiError {
  constructor(requestId?: string) {
    super("unavailable", undefined, "network", requestId);
    this.name = "NetworkError";
  }
}
export const isNetworkError = (error: unknown): error is NetworkError =>
  error instanceof ApiError && error.failure === "network";
export const isCancellation = (error: unknown) =>
  error instanceof Error && error.name === "AbortError";

const failureMessages = new Map<string, UiMessage>([
  ["unauthenticated", message("api.unauthenticated")],
  ["forbidden", message("api.forbidden")],
  ["source_unavailable", message("chat.forwardUnavailable")],
  ["message_unavailable", message("chat.messageUnavailable")],
  ["dm_blocked", message("api.dmBlocked")],
  ["stale_revision", message("api.staleRevision")],
  ["origin_rejected", message("api.originRejected")],
  ["not_found", message("api.notFound")],
  ["invalid_credentials", message("api.invalidCredentials")],
  ["email_unverified", message("api.emailUnverified")],
  ["invalid_token", message("api.invalidToken")],
  ["bootstrap_complete", message("api.bootstrapComplete")],
  ["bootstrap_expired", message("api.bootstrapExpired")],
  ["email_taken", message("api.emailTaken")],
  ["rate_limited", message("api.rateLimited")],
  ["capacity", message("api.capacity")],
  ["storage_capacity", message("api.storageCapacity")],
  ["instance_capacity", message("api.instanceCapacity")],
  ["stale_version", message("api.staleVersion")],
  ["command_expired", message("api.commandExpired")],
  ["command_conflict", message("api.commandConflict")],
  ["query_too_short", message("api.queryTooShort")],
  ["invalid_input", message("api.invalidInput")],
  ["invalid_request", message("api.invalidInput")],
  ["unavailable", message("api.unavailable")],
  ["offline", message("api.offline")],
  ["attachment_not_ready", message("api.attachmentNotReady")],
  ["attachment_expired", message("api.attachmentExpired")],
  ["attachment_claimed", message("api.attachmentClaimed")],
  ["upload_in_progress", message("api.uploadInProgress")],
  ["integrity_mismatch", message("api.integrityMismatch")],
]);
export function failureMessage(code: string): UiMessage {
  return failureMessages.get(code) ?? message("api.unknown");
}
export function errorMessage(error: unknown): UiMessage {
  if (error instanceof UiMessageError) return error.uiMessage;
  const failure = apiFailure(error);
  if (failure) {
    if (
      failure.requestId &&
      (failure.code === "unavailable" || !failureMessages.has(failure.code))
    )
      return message("api.unknownWithReference", {
        requestId: failure.requestId,
      });
    return failureMessage(failure.code);
  }
  return message("api.unknown");
}
