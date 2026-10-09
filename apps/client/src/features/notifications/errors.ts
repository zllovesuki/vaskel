import { apiFailure } from "@/client/api/errors";
import { NOTIFICATION_DEVICE_LIMIT } from "@vaskel/contracts/notifications";
import { errorMessage } from "@/client/api/errors";
import { message, type UiMessage } from "@/client/features/i18n/messages";

/** Notification commands explain their own outcomes; the shared table speaks for chat. */
export function notificationErrorMessage(error: unknown): UiMessage {
  if (apiFailure(error) && apiFailure(error)?.failure === "http")
    switch (apiFailure(error)?.code) {
      case "stale_revision":
        return message("notifications.staleRevision");
      case "not_found":
        return message("notifications.deviceGone");
      case "command_conflict":
      case "command_expired":
        return message("notifications.enableConflict");
      case "capacity":
        return message("notifications.deviceLimit", {
          count: NOTIFICATION_DEVICE_LIMIT,
        });
    }
  return errorMessage(error);
}
