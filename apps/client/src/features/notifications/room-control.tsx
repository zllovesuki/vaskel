import { Bell, BellOff } from "lucide-react";
import { useCallback, useId, useState, useSyncExternalStore } from "react";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import {
  buttonStyles,
  fieldHintStyles,
  fieldStyles,
  formStyles,
  labelStyles,
  noticeStyles,
  textButtonStyles,
} from "@vaskel/ui/components/control-styles";
import { isCancellation } from "@/client/api/errors";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { Unavailable } from "@/client/ui/failure";
import { Working } from "@/client/ui/loading-skeleton";
import { Popover } from "@/client/ui/popover";
import { notificationErrorMessage } from "./errors";
import { roomPreference } from "./room-preference";
import { useNotifications } from "./use-notifications";

/** Local calendar day, so a mute ending today is labelled by its time alone. */
const sameDay = (a: number, b: number) =>
  new Date(a).toDateString() === new Date(b).toDateString();
/** Whether a mute is still ahead; one timer set for its end, not a poll, re-renders the bell when it lapses. */
function useMuted(until: number | null) {
  const subscribe = useCallback(
    (onLapse: () => void) => {
      if (until === null) return () => {};
      const timer = setTimeout(onLapse, Math.max(0, until - Date.now()));
      return () => clearTimeout(timer);
    },
    [until],
  );
  return useSyncExternalStore(
    subscribe,
    () => until !== null && until > Date.now(),
  );
}

/** The header bell: its icon and name carry the room's state, the popover changes it. */
export function RoomNotificationControl({
  owner,
  roomId,
}: {
  owner: OwnerScope;
  roomId: string;
}) {
  const { t } = useI18n();
  const notifications = useNotifications();
  const preference = roomPreference(notifications.query.data, owner, roomId);
  const muted = useMuted(preference?.mutedUntil ?? null);
  const state = preference?.mode === "nothing" ? "off" : muted ? "muted" : "on";
  return (
    <Popover
      label={
        <>
          {state === "on" ? (
            <Bell className="size-4" aria-hidden="true" />
          ) : (
            <BellOff className="size-4" aria-hidden="true" />
          )}
          <span className="sr-only">
            {state === "muted"
              ? t("notifications.roomTitleMuted")
              : state === "off"
                ? t("notifications.roomTitleOff")
                : t("notifications.roomTitle")}
          </span>
        </>
      }
      // Always icon-only, at its neighbours' height.
      buttonClass={buttonStyles({ variant: "quiet", size: "icon" })}
      title={t("notifications.roomTitle")}
    >
      {() => (
        <RoomPreferences
          owner={owner}
          roomId={roomId}
          notifications={notifications}
        />
      )}
    </Popover>
  );
}
function RoomPreferences({
  owner,
  roomId,
  notifications: { query, mutation, change, disabled, retryable, retry },
}: {
  owner: OwnerScope;
  roomId: string;
  notifications: ReturnType<typeof useNotifications>;
}) {
  const { t, text, formatDateTime, formatTime } = useI18n();
  const modeId = useId();
  const muteId = useId();
  const hintId = `${modeId}-hint`;
  const preference = roomPreference(query.data, owner, roomId);
  const mode = preference?.mode ?? "direct";
  const mutedUntil = preference?.mutedUntil ?? null;
  // One reading of the clock per opening, so the mute label does not flip while the popover is open.
  const [openedAt] = useState(() => Date.now());
  const muted = mutedUntil !== null && mutedUntil > openedAt;
  const failure =
    mutation.error && !isCancellation(mutation.error) ? mutation.error : null;
  return (
    <div
      className={`${formStyles} w-64 max-w-full`}
      aria-busy={query.isPending || mutation.isPending}
    >
      <h2>{t("notifications.roomTitle")}</h2>
      {/* Every message in a DM is direct, so only a circle room chooses how much to hear. */}
      {owner.kind === "server" && (
        <div className="flex flex-col gap-1.5">
          <div className={labelStyles}>
            <label htmlFor={modeId}>{t("notifications.roomMode")}</label>
            <select
              id={modeId}
              className={fieldStyles}
              value={mode}
              disabled={disabled}
              aria-describedby={mode === "direct" ? hintId : undefined}
              onChange={(event) => {
                const next = event.target.value;
                if (next === "all" || next === "direct" || next === "nothing")
                  change({
                    kind: "room",
                    owner,
                    roomId,
                    mode: next,
                    mutedUntil,
                  });
              }}
            >
              <option value="all">{t("notifications.all")}</option>
              <option value="direct">{t("notifications.direct")}</option>
              <option value="nothing">{t("notifications.nothing")}</option>
            </select>
          </div>
          {mode === "direct" && (
            <p id={hintId} className={fieldHintStyles}>
              {t("notifications.directHint")}
            </p>
          )}
        </div>
      )}
      <div className={labelStyles}>
        <label htmlFor={muteId}>{t("notifications.mute")}</label>
        <select
          id={muteId}
          className={fieldStyles}
          value={muted ? "active" : "0"}
          disabled={disabled}
          onChange={(event) => {
            if (event.target.value === "active") return;
            const duration = Number(event.target.value);
            change({
              kind: "room",
              owner,
              roomId,
              mode,
              mutedUntil: duration ? Date.now() + duration : null,
            });
          }}
        >
          {muted && (
            // Kept out of the list: it only lets the closed control show when the mute ends.
            <option value="active" hidden>
              {t("notifications.mutedUntil", {
                date: sameDay(mutedUntil, openedAt)
                  ? formatTime(mutedUntil)
                  : formatDateTime(mutedUntil),
              })}
            </option>
          )}
          <option value="0">{t("notifications.notMuted")}</option>
          <option value="3600000">{t("notifications.muteHour")}</option>
          <option value="28800000">{t("notifications.muteEightHours")}</option>
          <option value="86400000">{t("notifications.muteDay")}</option>
        </select>
      </div>
      {query.isPending && <Working>{t("notifications.loading")}</Working>}
      {query.error && (
        <Unavailable
          role={query.data ? "status" : "alert"}
          message={t("notifications.unavailable")}
          onRetry={() => void query.refetch()}
          disabled={query.isFetching}
        />
      )}
      {failure && (
        <div role="alert" className={noticeStyles({ error: true })}>
          <p>{text(notificationErrorMessage(failure))}</p>
          {retryable && (
            <button
              className={textButtonStyles({ size: "small" })}
              disabled={mutation.isPending}
              onClick={() => retry()}
            >
              {t("common.tryAgain")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
