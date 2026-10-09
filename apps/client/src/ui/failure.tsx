import { errorMessage } from "@/client/api/client";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { textButtonStyles } from "@vaskel/ui/components/control-styles";

/** A failed command, as one red line; nothing while there is no error. */
export function Failure({
  error,
  className = "",
}: {
  error: unknown;
  className?: string;
}) {
  const { text } = useI18n();
  if (!error) return null;
  return (
    <p role="alert" className={`text-ui text-error ${className}`}>
      {text(errorMessage(error))}
    </p>
  );
}

/**
 * A list or check that could not load: what is missing, then Try again while
 * the network is usable. `role` follows the site: an alert for a failed read,
 * a status for a partial one.
 */
export function Unavailable({
  message,
  onRetry,
  disabled,
  role = "alert",
  className = "",
}: {
  message: string;
  onRetry: () => void;
  disabled: boolean;
  role?: "alert" | "status";
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <div className={`text-caption text-muted ${className}`}>
      <p role={role}>{message}</p>
      <button
        className={textButtonStyles()}
        disabled={disabled}
        onClick={onRetry}
      >
        {t("common.tryAgain")}
      </button>
    </div>
  );
}
