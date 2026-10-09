import { useSyncExternalStore } from "react";
import { Link } from "@tanstack/react-router";
import { textButtonStyles } from "@vaskel/ui/components/control-styles";
import { useOptionalUser } from "@/client/features/auth/session-state";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { StatusStrip } from "@/client/ui/status-strip";
import { cleanupFailed, readEnrollment, subscribeEnrollment } from "./browser";

/**
 * Survives account retirement so failed sign-out cleanup is not hidden. It is
 * never dismissed; it clears once the enrollment is removed or replaced.
 */
export function NotificationCleanupNotice({
  className = "",
}: {
  className?: string;
}) {
  // One primitive snapshot: the account whose cleanup failed, or none.
  const failedAccount = useSyncExternalStore(
    subscribeEnrollment,
    () => (cleanupFailed() ? (readEnrollment()?.accountId ?? null) : null),
    () => null,
  );
  const user = useOptionalUser();
  const { t } = useI18n();
  if (failedAccount === null) return null;
  return (
    <StatusStrip
      className={className}
      action={
        user?.userId === failedAccount && (
          <Link
            to="/settings/notifications"
            search={{}}
            className={textButtonStyles({ size: "small" })}
          >
            {t("notifications.cleanupOpenSettings")}
          </Link>
        )
      }
    >
      {t("notifications.cleanupFailed")}
    </StatusStrip>
  );
}
