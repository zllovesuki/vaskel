import { useSyncExternalStore } from "react";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { message, type UiMessage } from "@/client/features/i18n/messages";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { SettingsSection } from "@/client/ui/settings-section";
import { ReceivingDevices } from "./account-devices";
import { MessageSounds } from "./account-message-sounds";
import { CommandOutcome } from "./account-outcome";
import { PauseAndPreview } from "./account-preferences";
import { ThisDevice, type Phase } from "./account-this-device";
import {
  readEnrollment,
  subscribeEnrollment,
  type BrowserEnrollment,
} from "./browser";
import {
  useNotifications,
  type NotificationOperation,
} from "./use-notifications";

type Section = "device" | "preferences" | "devices";
/** The section that issued a command keeps its progress and outcome beside the control that started it. */
function sectionOf(operation: NotificationOperation): Section {
  if (operation.kind === "command" && operation.command.kind === "preferences")
    return "preferences";
  return operation.kind === "remove-device" ? "devices" : "device";
}
function successOf(operation: NotificationOperation): UiMessage {
  switch (operation.kind) {
    case "enable":
      return message("notifications.enabled");
    case "remove-device":
      return message("notifications.deviceRemoved");
    case "remove-this-device":
    case "release":
      return message("notifications.turnedOff");
    case "command":
      return message(
        operation.command.kind === "test"
          ? "notifications.testSent"
          : "notifications.saved",
      );
  }
}

/** The three sections of the page share one reading of the account's state and one command channel. */
export function NotificationAccountPanel() {
  const { t } = useI18n();
  const user = useUser();
  const { canUseNetwork } = useAccess();
  const notifications = useNotifications();
  const { query, mutation, operation, retryable, retry } = notifications;
  // Endpoint and pending-command changes can keep the same device identity.
  const enrollment = useSyncExternalStore(
    subscribeEnrollment,
    () => JSON.stringify(readEnrollment()),
    () => "null",
  );
  // The stable string contains only the schema-validated enrollment above.
  const binding = JSON.parse(enrollment) as BrowserEnrollment | null;
  const localDevice = binding?.deviceId ?? null;
  const state = query.data;
  const here =
    binding?.accountId === user.userId
      ? state?.devices.find((item) => item.deviceId === localDevice)
      : undefined;
  const phase: Phase = state
    ? "ready"
    : query.error
      ? "failed"
      : canUseNetwork
        ? "loading"
        : "offline";
  const still = phase !== "loading";
  const issued = operation ? sectionOf(operation) : null;
  const busy = (section: Section) => issued === section && mutation.isPending;
  const outcome = (section: Section) =>
    issued === section ? (
      <CommandOutcome
        pending={
          section === "preferences" && mutation.isPending
            ? t("account.saving")
            : undefined
        }
        error={mutation.error}
        retry={retryable ? retry : undefined}
        success={mutation.isSuccess && operation ? successOf(operation) : null}
      />
    ) : null;
  return (
    <>
      {phase === "loading" && (
        <p role="status" className="sr-only">
          {t("notifications.loading")}
        </p>
      )}
      <SettingsSection
        title={t("notifications.messageSounds")}
        description={t("account.appearanceHint")}
      >
        <MessageSounds />
      </SettingsSection>
      <SettingsSection
        title={t("notifications.push")}
        description={t("notifications.description")}
      >
        <ThisDevice
          notifications={notifications}
          state={state}
          here={here}
          binding={binding}
          localDevice={localDevice}
          phase={phase}
          busy={busy("device")}
          outcome={outcome("device")}
        />
      </SettingsSection>
      <SettingsSection title={t("notifications.pauseAndPreview")}>
        <PauseAndPreview
          notifications={notifications}
          state={state}
          still={still}
          busy={busy("preferences")}
          outcome={outcome("preferences")}
        />
      </SettingsSection>
      <SettingsSection
        title={t("notifications.devices")}
        description={t("notifications.devicesHint")}
        width="full"
      >
        <ReceivingDevices
          notifications={notifications}
          state={state}
          here={here}
          still={still}
          busy={busy("devices")}
          outcome={outcome("devices")}
        />
      </SettingsSection>
    </>
  );
}
