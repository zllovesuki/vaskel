import {
  noticeStyles,
  textButtonStyles,
} from "@vaskel/ui/components/control-styles";
import { isCancellation } from "@/client/api/errors";
import type { UiMessage } from "@/client/features/i18n/messages";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { Working } from "@/client/ui/loading-skeleton";
import { notificationErrorMessage } from "./errors";

/**
 * What a section's last command is doing or did, beneath the control that
 * started it: progress where no control can show its own, the failure with
 * its recovery, or the confirmation.
 */
export function CommandOutcome({
  pending,
  error,
  retry,
  success,
}: {
  pending?: string | undefined;
  error: unknown;
  /** Offered only for a transport failure; a rejected command needs a new decision. */
  retry?: (() => void) | undefined;
  success: UiMessage | null;
}) {
  const { t, text } = useI18n();
  if (pending) return <Working>{pending}</Working>;
  if (error && !isCancellation(error))
    return (
      <div role="alert" className={noticeStyles({ error: true })}>
        <p>{text(notificationErrorMessage(error))}</p>
        {retry && (
          <button className={textButtonStyles()} onClick={retry}>
            {t("common.tryAgain")}
          </button>
        )}
      </div>
    );
  if (success)
    return (
      <p role="status" className={noticeStyles()}>
        {text(success)}
      </p>
    );
  return null;
}
