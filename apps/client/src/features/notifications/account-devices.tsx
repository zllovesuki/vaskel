import { useRef, useState, type ReactNode } from "react";
import type {
  NotificationDevice,
  NotificationState,
} from "@vaskel/contracts/notifications";
import { buttonStyles } from "@vaskel/ui/components/control-styles";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { Bone, Line } from "@/client/ui/loading-skeleton";
import { settingsListStyles } from "@/client/ui/settings-section";
import { SectionBones } from "./account-frame";
import type { Notifications } from "./use-notifications";
import { ConfirmRow } from "@/client/ui/confirm-row";

/** Every device receiving this account's notifications, this one first. */
export function ReceivingDevices({
  notifications: { mutation, removeDevice, disabled },
  state,
  here,
  still,
  busy,
  outcome,
}: {
  notifications: Notifications;
  state: NotificationState | undefined;
  here: NotificationDevice | undefined;
  still: boolean;
  busy: boolean;
  outcome: ReactNode;
}) {
  const { t, formatDateTime } = useI18n();
  const [confirming, setConfirming] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const rows = state
    ? here
      ? [
          here,
          ...state.devices.filter(
            (device) => device.deviceId !== here.deviceId,
          ),
        ]
      : state.devices
    : null;
  return (
    <div className="flex flex-col gap-4" aria-busy={busy}>
      {!rows && (
        <SectionBones
          kind="devices"
          still={still}
          className={settingsListStyles}
        >
          {["w-40", "w-32"].map((width) => (
            <div key={width} className="flex items-center gap-3 py-2.5">
              <span className="min-w-0 flex-1 leading-snug">
                <Line width={width} />
                <Line size="caption" width="w-44" />
              </span>
              <Bone className="h-target w-28" />
            </div>
          ))}
        </SectionBones>
      )}
      {rows && rows.length === 0 && (
        <p className="text-caption text-muted">
          {t("notifications.noDevices")}
        </p>
      )}
      {rows && rows.length > 0 && (
        <ul
          ref={list}
          tabIndex={-1}
          aria-label={t("notifications.devices")}
          className={`${settingsListStyles} focus-visible:outline-none`}
        >
          {rows.map((device) => {
            const mine = device.deviceId === here?.deviceId;
            return (
              <li key={device.deviceId} className="py-2.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="min-w-0 flex-1 leading-snug">
                    <span className="flex items-center gap-2 text-ui font-medium">
                      <span className="truncate">{device.label}</span>
                      {mine && (
                        <span className="rounded-full bg-subtle px-2 py-0.5 text-fine font-semibold text-muted">
                          {t("account.thisDevice")}
                        </span>
                      )}
                    </span>
                    <span className="block text-caption text-muted">
                      {t("notifications.enabledAt", {
                        date: formatDateTime(device.createdAt),
                      })}
                    </span>
                  </span>
                  {/* This browser turns itself off above; that is the one verb for its own enrollment. */}
                  {!mine && (
                    <button
                      className={buttonStyles({
                        size: "small",
                        // While its question is open, the question holds the only Remove.
                        className:
                          confirming === device.deviceId ? "invisible" : "",
                      })}
                      disabled={disabled}
                      aria-label={t("notifications.removeNamed", {
                        name: device.label,
                      })}
                      onClick={(event) => {
                        trigger.current = event.currentTarget;
                        setConfirming(device.deviceId);
                      }}
                    >
                      {t("notifications.remove")}
                    </button>
                  )}
                </div>
                {confirming === device.deviceId && (
                  <ConfirmRow
                    question={t("notifications.removeConfirm", {
                      name: device.label,
                    })}
                    confirmLabel={t("notifications.remove")}
                    busyLabel={t("notifications.removing")}
                    busy={busy}
                    disabled={disabled}
                    cancelDisabled={mutation.isPending}
                    onConfirm={() =>
                      removeDevice(device.deviceId, {
                        // The row may not return; restore focus to the list after settlement.
                        onSettled: () => {
                          setConfirming(null);
                          list.current?.focus();
                        },
                      })
                    }
                    // Cancelling returns focus to the control that opened it.
                    returnFocus={trigger}
                    onCancel={() => setConfirming(null)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {outcome}
      <p className="text-caption text-muted">
        {t("notifications.deliveryHint")}
      </p>
    </div>
  );
}
