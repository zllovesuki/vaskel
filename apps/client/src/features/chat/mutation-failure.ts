import type { QueryClient } from "@tanstack/react-query";
import { ApiError, apiFailure } from "@/client/api/client";
import { blockKey } from "@/client/api/blocks";

/** A rejected send keeps editable text/files, without ambiguous receipt recovery. */
export function isDefiniteSendRejection(
  error: unknown,
  previouslyUncertain = false,
): boolean {
  const failure = apiFailure(error);
  return (
    !previouslyUncertain &&
    failure !== null &&
    failure.failure === "http" &&
    [
      "dm_blocked",
      "source_unavailable",
      "message_unavailable",
      "attachment_not_ready",
      "attachment_expired",
      "integrity_mismatch",
      "invalid_input",
      "capacity",
      "storage_capacity",
    ].includes(failure.code)
  );
}

/** Denials close the local view; the access coordinator owns their purge. */
export function handleTimelineMutationFailure(
  error: unknown,
  {
    client,
    userId,
    deny,
    reconcile,
  }: {
    client: QueryClient;
    userId: string;
    deny: (error: ApiError) => void;
    reconcile: () => void;
  },
) {
  const failure = apiFailure(error);
  if (!failure) return;
  if (["forbidden", "unauthenticated", "not_found"].includes(failure.code)) {
    deny(failure);
  } else if (failure.code === "dm_blocked") {
    // Sending policy does not revoke history, search, downloads or private reads.
    void client.invalidateQueries({ queryKey: blockKey(userId) });
  } else if (failure.code === "stale_version") {
    reconcile();
  }
}
