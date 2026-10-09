import { useId, type ReactNode } from "react";
import type { NotificationState } from "@vaskel/contracts/notifications";
import {
  fieldHintStyles,
  fieldStyles,
  labelStyles,
} from "@vaskel/ui/components/control-styles";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { FieldSkeleton } from "@/client/ui/loading-skeleton";
import { SectionBones } from "./account-frame";
import type { Notifications } from "./use-notifications";

/** Account-wide delivery choices; each control saves as it changes. */
export function PauseAndPreview({
  notifications: { change, disabled },
  state,
  still,
  busy,
  outcome,
}: {
  notifications: Notifications;
  state: NotificationState | undefined;
  still: boolean;
  busy: boolean;
  outcome: ReactNode;
}) {
  const { t, language } = useI18n();
  const previewId = useId();
  const hintId = `${previewId}-hint`;
  return (
    <div className="flex flex-col gap-4" aria-busy={busy}>
      {state ? (
        <>
          <label className="flex cursor-pointer items-start gap-2.5 text-ui">
            <input
              type="checkbox"
              className="mt-1 size-4 shrink-0 accent-accent"
              checked={state.preferences.paused}
              disabled={disabled}
              onChange={(event) =>
                change({
                  kind: "preferences",
                  ...state.preferences,
                  language,
                  paused: event.target.checked,
                })
              }
            />
            <span className="min-w-0 font-medium">
              {t("notifications.pause")}
            </span>
          </label>
          <div className={labelStyles}>
            <label htmlFor={previewId}>{t("notifications.preview")}</label>
            <select
              id={previewId}
              className={fieldStyles}
              value={state.preferences.preview}
              disabled={disabled}
              aria-describedby={hintId}
              onChange={(event) => {
                const preview = event.target.value;
                if (
                  preview === "generic" ||
                  preview === "who-and-where" ||
                  preview === "message"
                )
                  change({
                    kind: "preferences",
                    ...state.preferences,
                    language,
                    preview,
                  });
              }}
            >
              <option value="generic">
                {t("notifications.previewGeneric")}
              </option>
              <option value="who-and-where">
                {t("notifications.previewWho")}
              </option>
              <option value="message">
                {t("notifications.previewMessage")}
              </option>
            </select>
            <p id={hintId} className={fieldHintStyles}>
              {t("notifications.previewHint")}
            </p>
          </div>
        </>
      ) : (
        <SectionBones
          kind="preferences"
          still={still}
          className="flex flex-col gap-4"
        >
          <FieldSkeleton control="checkbox" label={t("notifications.pause")} />
          <FieldSkeleton
            label={t("notifications.preview")}
            hint={t("notifications.previewHint")}
          />
        </SectionBones>
      )}
      {outcome}
    </div>
  );
}
