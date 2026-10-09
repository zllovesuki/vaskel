import { PendingLabel } from "@/client/ui/loading-skeleton";
import { ArrowDown } from "lucide-react";
import { errorMessage } from "@/client/api/client";
import { useI18n } from "@/client/features/i18n/use-i18n";
import {
  buttonStyles,
  noticeStyles,
} from "@vaskel/ui/components/control-styles";

/**
 * The way back to the newest messages while the reader holds an older
 * position. It floats over the transcript's bottom edge rather than taking a
 * row of its own, so appearing and disappearing never moves a message or the
 * composer. Unseen arrivals turn it accent, the unread colour.
 */
export function TimelineJump({
  visible,
  newer,
  pending,
  disabled,
  error,
  onJump,
}: {
  /** The reader is holding a position short of the newest message. */
  visible: boolean;
  /** Messages arrived beyond the held range and have not been seen. */
  newer: boolean;
  pending: boolean;
  disabled: boolean;
  /** The last history request's failure, shown until the next attempt. */
  error?: unknown;
  onJump: () => void;
}) {
  const { t, text } = useI18n();
  if (!visible && !error) return null;
  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-3 flex flex-col items-center gap-2 sm:inset-x-5 lg:inset-x-7">
      {Boolean(error) && (
        <p
          role="alert"
          className={noticeStyles({
            error: true,
            size: "small",
            className: "pointer-events-auto max-w-full shadow-popover",
          })}
        >
          {text(errorMessage(error))}
        </p>
      )}
      {visible && (
        <>
          {newer && (
            <span role="status" className="sr-only">
              {t("chat.newerMessages")}
            </span>
          )}
          {/* The pill floats over messages, so an opaque surface sits behind
              its washed hover; it rises into place when it appears. */}
          <div className="rounded-full bg-surface shadow-popover transition-[opacity,translate] duration-200 ease-arrive starting:translate-y-2 starting:opacity-0">
            <button
              type="button"
              className={buttonStyles({
                size: "small",
                shape: "round",
                variant: newer ? "primary" : "default",
                className: "pointer-events-auto",
              })}
              disabled={disabled}
              aria-busy={pending}
              onClick={onJump}
            >
              <ArrowDown className="size-4" aria-hidden="true" />
              <PendingLabel pending={pending} label={t("chat.loading")}>
                {newer ? t("chat.newerMessages") : t("chat.returnLatest")}
              </PendingLabel>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
