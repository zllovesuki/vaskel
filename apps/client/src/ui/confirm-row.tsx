import {
  useEffect,
  useId,
  useRef,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { PendingLabel } from "@/client/ui/loading-skeleton";
import {
  buttonRowStyles,
  buttonStyles,
} from "@vaskel/ui/components/control-styles";

/**
 * An inline second step for a decision that cannot be taken back. It stays in
 * the row it belongs to, so the answer never leaves the thing it is about.
 * Focus moves to the confirming button, which would otherwise repeat the label
 * just pressed, so the group is named by its question and the button describes
 * itself with it (and with `detail`, a consequence worth its own line).
 * The control that asked may step aside while the question is open; Cancel
 * then hands focus back to it (`returnFocus`) once it shows again.
 */
export function ConfirmRow({
  question,
  detail,
  confirmLabel,
  busyLabel,
  busy = false,
  disabled = false,
  cancelLabel,
  cancelDisabled,
  returnFocus,
  onConfirm,
  onCancel,
  ...props
}: {
  question: ReactNode;
  detail?: ReactNode;
  confirmLabel: ReactNode;
  /** What confirming is doing while `busy`. */
  busyLabel: string;
  busy?: boolean;
  /** Disables the confirming button only. */
  disabled?: boolean;
  /** Cancel, unless the step keeps something worth naming. */
  cancelLabel?: string;
  /** Defaults to `busy`: a command under way is not cancelled from here. */
  cancelDisabled?: boolean;
  /** The control that opened the question, refocused after Cancel. */
  returnFocus?: RefObject<HTMLElement | null>;
  onConfirm: () => void;
  onCancel: () => void;
} & Omit<ComponentProps<"div">, "children" | "className" | "role">) {
  const { t } = useI18n();
  const questionId = useId();
  const detailId = useId();
  const cancelled = useRef(false);
  // Passive cleanup runs after the commit that removes the question, when the
  // control that stepped aside is showing again and can take focus.
  useEffect(
    () => () => {
      if (cancelled.current) returnFocus?.current?.focus();
    },
    [returnFocus],
  );
  return (
    <div
      role="group"
      aria-labelledby={questionId}
      className="mt-2 flex flex-col gap-2.5 rounded-lg bg-subtle p-3 text-caption"
      {...props}
    >
      <div>
        <p id={questionId}>{question}</p>
        {detail && (
          <p id={detailId} className="mt-1 text-muted">
            {detail}
          </p>
        )}
      </div>
      <div className={buttonRowStyles}>
        <button
          type="button"
          className={buttonStyles({ variant: "danger", size: "small" })}
          autoFocus
          aria-describedby={detail ? `${questionId} ${detailId}` : questionId}
          aria-busy={busy}
          disabled={disabled || busy}
          onClick={onConfirm}
        >
          <PendingLabel pending={busy} label={busyLabel}>
            {confirmLabel}
          </PendingLabel>
        </button>
        <button
          type="button"
          className={buttonStyles({ variant: "quiet", size: "small" })}
          disabled={cancelDisabled ?? busy}
          onClick={() => {
            cancelled.current = true;
            onCancel();
          }}
        >
          {cancelLabel ?? t("chat.cancel")}
        </button>
      </div>
    </div>
  );
}
