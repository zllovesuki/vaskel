import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { userAgentFamily } from "@vaskel/contracts/account";
import type {
  NotificationDevice,
  NotificationState,
} from "@vaskel/contracts/notifications";
import {
  buttonRowStyles,
  buttonStyles,
  fieldHintStyles,
  fieldStyles,
  labelStyles,
  noticeStyles,
} from "@vaskel/ui/components/control-styles";
import { notificationsKey } from "@/client/api/notifications";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { Unavailable } from "@/client/ui/failure";
import { FieldSkeleton, PendingLabel } from "@/client/ui/loading-skeleton";
import { ActionBone, SectionBones } from "./account-frame";
import {
  browserNotificationSupport,
  readBrowserSubscription,
  type BrowserEnrollment,
} from "./browser";
import type { Notifications } from "./use-notifications";

export type Phase = "ready" | "loading" | "failed" | "offline";

/**
 * `Notification.permission` has no event of its own: it is read again when the
 * tab returns, and on the Permissions API's change where the browser offers it.
 */
function subscribePermission(listener: () => void) {
  window.addEventListener("focus", listener);
  document.addEventListener("visibilitychange", listener);
  let status: PermissionStatus | null = null;
  let active = true;
  navigator.permissions
    ?.query({ name: "notifications" })
    .then((result) => {
      if (!active) return;
      status = result;
      result.addEventListener("change", listener);
    })
    .catch(() => {});
  return () => {
    active = false;
    window.removeEventListener("focus", listener);
    document.removeEventListener("visibilitychange", listener);
    status?.removeEventListener("change", listener);
  };
}
const readPermission = (): NotificationPermission =>
  "Notification" in window ? Notification.permission : "default";

/** This browser's enrollment: the notices that constrain it, then the one action it can take. */
export function ThisDevice({
  notifications: {
    query,
    operation,
    change,
    enable,
    removeThisDevice,
    releaseOrphan,
    disabled,
  },
  state,
  here,
  binding,
  localDevice,
  phase,
  busy,
  outcome,
}: {
  notifications: Notifications;
  state: NotificationState | undefined;
  /** This browser's device as the actor lists it. */
  here: NotificationDevice | undefined;
  binding: BrowserEnrollment | null;
  localDevice: string | null;
  phase: Phase;
  busy: boolean;
  outcome: ReactNode;
}) {
  const { t, language } = useI18n();
  const user = useUser();
  const { canUseNetwork } = useAccess();
  const nameId = useId();
  const hintId = `${nameId}-hint`;
  const [deviceName, setDeviceName] = useState("");
  const supported = browserNotificationSupport();
  const permission = useSyncExternalStore(
    subscribePermission,
    readPermission,
    () => "default",
  );
  const blocked = supported && permission === "denied";
  const foreign = binding !== null && binding.accountId !== user.userId;
  const subscription = useQuery({
    queryKey: [
      ...notificationsKey(user.userId),
      "push-subscription",
      localDevice,
    ],
    queryFn: readBrowserSubscription,
    enabled: supported,
  });
  // A subscription this account's binding does not own can only be released, never adopted.
  const orphaned =
    !here &&
    !!subscription.data &&
    (binding === null ||
      (!foreign && binding.endpoint !== subscription.data.endpoint));
  // The stored label appears in every device's list, so it must not say "this device".
  const family = userAgentFamily(navigator.userAgent);
  const defaultLabel = family === "Other" ? t("account.browserOther") : family;
  const running = busy
    ? operation?.kind === "command"
      ? operation.command.kind
      : operation?.kind
    : undefined;
  const canEnable = !disabled && supported && !blocked;
  let content: ReactNode;
  if (phase === "failed")
    content = (
      <Unavailable
        message={t("notifications.unavailable")}
        onRetry={() => void query.refetch()}
        disabled={!canUseNetwork || query.isFetching}
      />
    );
  // Another account's enrollment leaves nothing to do here but read the notice.
  else if (foreign) content = null;
  else if (!state)
    content = (
      <SectionBones
        kind="device"
        still={phase !== "loading"}
        className="flex flex-col gap-4"
      >
        {binding ? (
          <span className={buttonRowStyles}>
            <ActionBone label={t("notifications.test")} />
            <ActionBone label={t("notifications.disable")} />
          </span>
        ) : orphaned ? (
          <span className={buttonRowStyles}>
            <ActionBone label={t("notifications.disable")} />
          </span>
        ) : (
          <>
            <FieldSkeleton
              label={t("notifications.deviceName")}
              hint={t("notifications.deviceNameHint")}
            />
            <span className={buttonRowStyles}>
              <ActionBone label={t("notifications.enable")} />
            </span>
          </>
        )}
      </SectionBones>
    );
  else if (here)
    content = (
      <div className={buttonRowStyles}>
        <button
          className={buttonStyles()}
          disabled={disabled || blocked}
          aria-busy={running === "test"}
          onClick={() =>
            change({
              kind: "test",
              deviceId: here.deviceId,
              subscriptionVersion: here.subscriptionVersion,
            })
          }
        >
          <PendingLabel
            pending={running === "test"}
            label={t("notifications.sending")}
          >
            {t("notifications.test")}
          </PendingLabel>
        </button>
        <button
          className={buttonStyles()}
          disabled={disabled}
          aria-busy={running === "remove-this-device"}
          onClick={() => removeThisDevice(here.deviceId)}
        >
          <PendingLabel
            pending={running === "remove-this-device"}
            label={t("notifications.turningOff")}
          >
            {t("notifications.disable")}
          </PendingLabel>
        </button>
      </div>
    );
  else if (orphaned)
    content = (
      <div className={buttonRowStyles}>
        <button
          className={buttonStyles()}
          disabled={disabled}
          aria-busy={running === "release"}
          onClick={releaseOrphan}
        >
          <PendingLabel
            pending={running === "release"}
            label={t("notifications.turningOff")}
          >
            {t("notifications.disable")}
          </PendingLabel>
        </button>
      </div>
    );
  else
    content = (
      <>
        <div className={labelStyles}>
          <label htmlFor={nameId}>{t("notifications.deviceName")}</label>
          <input
            id={nameId}
            className={fieldStyles}
            value={deviceName}
            maxLength={80}
            placeholder={defaultLabel}
            disabled={!canEnable}
            aria-describedby={hintId}
            onChange={(event) => setDeviceName(event.target.value)}
          />
          <p id={hintId} className={fieldHintStyles}>
            {t("notifications.deviceNameHint")}
          </p>
        </div>
        <div className={buttonRowStyles}>
          <button
            className={buttonStyles({ variant: "primary" })}
            disabled={!canEnable}
            aria-busy={running === "enable"}
            onClick={() => enable(deviceName.trim() || defaultLabel, language)}
          >
            <PendingLabel
              pending={running === "enable"}
              label={t("notifications.enabling")}
            >
              {t("notifications.enable")}
            </PendingLabel>
          </button>
        </div>
      </>
    );
  return (
    <div className="flex flex-col gap-4" aria-busy={busy}>
      {!supported && (
        <p className={noticeStyles()}>{t("notifications.unsupported")}</p>
      )}
      {blocked && (
        <p className={noticeStyles()}>{t("notifications.permissionBlocked")}</p>
      )}
      {foreign && (
        <p className={noticeStyles()}>{t("notifications.otherAccount")}</p>
      )}
      {orphaned && (
        <p className={noticeStyles()}>
          {t("notifications.orphanedSubscription")}
        </p>
      )}
      {content}
      {outcome}
    </div>
  );
}
