import { useState } from "react";
import {
  Check,
  HeadphoneOff,
  Headphones,
  Lock,
  Mic,
  MicOff,
  ScreenShare,
  Settings2,
  Smartphone,
  Video,
  VideoOff,
  Volume2,
} from "lucide-react";
import { useAccess } from "@/client/features/cache/access/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import {
  buttonStyles,
  menuItemStyles,
  textButtonStyles,
} from "@vaskel/ui/components/control-styles";
import {
  LeaveButton as LeaveButtonView,
  Toggle,
  toggleStyles,
} from "@vaskel/ui/components/call";
import { Popover } from "@/client/ui/popover";
import { useMedia } from "./context";
import {
  readDeviceChoices,
  speakerSelectionSupported,
  useDeviceList,
  type DeviceKind,
} from "./devices";

/** Where a toggle is drawn: the dark stage or a light card, at the stage's 40px or the dock's 36px. */
export interface ToggleSurface {
  surface?: "stage" | "light";
  size?: "tall" | "normal";
}

/**
 * The mic, camera and share toggles, shared by the stage, the Home dock and the
 * phone strip. `pending` draws all three dashed and inert while a join or a
 * reconnect is still in flight.
 */
export function PrimaryToggles({
  surface = "stage",
  size = "tall",
  pending = false,
  only,
}: ToggleSurface & {
  pending?: boolean;
  /** The phone strip has room for the microphone alone; the stage holds the rest. */
  only?: "microphone";
} = {}) {
  const { t } = useI18n();
  const look = { surface, size };
  const { controller, state } = useMedia();
  const { canUseNetwork } = useAccess();
  const session = state.session;
  const self = session?.snapshot.participants.find(
    (p) => p.id === session?.participantId,
  );
  const camera = session?.local.some((item) => item.source === "camera");
  const sharing = session?.local.some((item) => item.source === "screen_video");
  const micPending = state.pendingSources.includes("microphone");
  const cameraPending = state.pendingSources.includes("camera");
  const sharePending = state.pendingSources.includes("screen_video");
  const micLabel = self?.muted
    ? t("media.mutedByOwner")
    : micPending
      ? t("media.openingMic")
      : state.muted
        ? t("media.unmute")
        : t("media.mute");
  const cameraLabel = cameraPending
    ? t("media.openingCamera")
    : camera
      ? t("media.stopCamera")
      : t("media.camera");
  const shareLabel = self?.screenRevoked
    ? t("media.sharingDisabled")
    : sharePending
      ? t("media.choosingScreen")
      : sharing
        ? t("media.stopSharing")
        : t("media.shareScreen");
  return (
    <>
      <Toggle
        {...look}
        state={
          pending
            ? "pending"
            : self?.muted
              ? "locked"
              : micPending
                ? "pending"
                : state.muted
                  ? "off"
                  : "on"
        }
        label={micLabel}
        icon={
          state.muted || self?.muted ? (
            <MicOff className="size-5" aria-hidden="true" />
          ) : (
            <Mic className="size-5" aria-hidden="true" />
          )
        }
        badge={self?.muted ? <Lock className="size-2.5" /> : undefined}
        disabled={
          pending ||
          (!canUseNetwork && state.muted) ||
          self?.muted ||
          micPending
        }
        aria-pressed={state.muted || Boolean(self?.muted)}
        onClick={controller.toggleMute}
      />
      {only === undefined && (
        <>
          <Toggle
            {...look}
            state={
              pending || cameraPending ? "pending" : camera ? "on" : "idle"
            }
            label={cameraLabel}
            icon={
              camera ? (
                <Video className="size-5" aria-hidden="true" />
              ) : (
                <VideoOff className="size-5" aria-hidden="true" />
              )
            }
            disabled={pending || (!canUseNetwork && !camera) || cameraPending}
            aria-pressed={camera}
            onClick={() =>
              camera
                ? void controller.stopSource("camera")
                : void controller.startDevice("camera")
            }
          />
          <Toggle
            {...look}
            state={
              pending
                ? "pending"
                : self?.screenRevoked
                  ? "locked"
                  : sharePending
                    ? "pending"
                    : sharing
                      ? "broadcast"
                      : "idle"
            }
            label={shareLabel}
            icon={<ScreenShare className="size-5" aria-hidden="true" />}
            badge={
              self?.screenRevoked ? <Lock className="size-2.5" /> : undefined
            }
            disabled={
              pending ||
              (!canUseNetwork && !sharing) ||
              self?.screenRevoked ||
              sharePending
            }
            aria-pressed={sharing}
            onClick={() =>
              sharing
                ? void controller.stopSource("screen_video")
                : controller.shareScreen()
            }
          />
        </>
      )}
    </>
  );
}

/** Silences everything this tab hears; the microphone is untouched. */
export function DeafenToggle() {
  const { t } = useI18n();
  const { controller, state } = useMedia();
  const label = state.deafened
    ? t("media.undeafenSelf")
    : t("media.deafenSelf");
  return (
    <Toggle
      state={state.deafened ? "off" : "idle"}
      label={label}
      icon={
        state.deafened ? (
          <HeadphoneOff className="size-5" aria-hidden="true" />
        ) : (
          <Headphones className="size-5" aria-hidden="true" />
        )
      }
      aria-pressed={state.deafened}
      onClick={() => controller.setDeafened(!state.deafened)}
    />
  );
}

function DeviceGroup({
  kind,
  title,
  devices,
  chosen,
  onChoose,
}: {
  kind: DeviceKind;
  title: string;
  devices: MediaDeviceInfo[];
  chosen: string | undefined;
  onChoose: (kind: DeviceKind, id: string | null) => void;
}) {
  const { t } = useI18n();
  const options: { id: string | null; label: string }[] = [
    { id: null, label: t("media.defaultDevice") },
    ...devices.map((device, index) => ({
      id: device.deviceId,
      label: device.label || `${title} ${index + 1}`,
    })),
  ];
  return (
    <div role="group" aria-label={title}>
      <p className="px-2.5 pt-2 pb-1 text-fine font-semibold text-muted uppercase">
        {title}
      </p>
      {options.map((option) => {
        const current = (option.id ?? undefined) === chosen;
        return (
          <button
            key={option.id ?? "default"}
            type="button"
            role="menuitemradio"
            aria-checked={current}
            className={menuItemStyles}
            onClick={() => onChoose(kind, option.id)}
          >
            <Check
              className={`size-4 shrink-0 ${current ? "" : "invisible"}`}
              aria-hidden="true"
            />
            <span className="min-w-0 truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The menu body enumerates devices while it is open and forgets them when closed. */
export function DeviceGroups() {
  const { t } = useI18n();
  const { controller } = useMedia();
  const [choices, setChoices] = useState(readDeviceChoices);
  const devices = useDeviceList(true);
  const choose = (kind: DeviceKind, id: string | null) => {
    void controller.switchDevice(kind, id);
    setChoices(readDeviceChoices());
  };
  return (
    <div className="flex flex-col gap-0.5">
      <DeviceGroup
        kind="microphone"
        title={t("media.microphoneDevice")}
        devices={devices.microphones}
        chosen={choices.microphone}
        onChoose={choose}
      />
      <DeviceGroup
        kind="camera"
        title={t("media.cameraDevice")}
        devices={devices.cameras}
        chosen={choices.camera}
        onChoose={choose}
      />
      {speakerSelectionSupported() && (
        <DeviceGroup
          kind="speaker"
          title={t("media.speakerDevice")}
          devices={devices.speakers}
          chosen={choices.speaker}
          onChoose={choose}
        />
      )}
    </div>
  );
}

/** Microphone, camera and (where supported) speaker choice for this tab. */
export function DevicesMenu() {
  const { t } = useI18n();
  return (
    <Popover
      label={
        <>
          <Settings2 className="size-5" aria-hidden="true" />
          <span className="sr-only">{t("media.devices")}</span>
        </>
      }
      buttonClass={toggleStyles({ state: "idle" })}
      size="list"
    >
      {() => <DeviceGroups />}
    </Popover>
  );
}

export function LeaveButton({
  size = "tall",
}: {
  size?: "tall" | "normal";
} = {}) {
  const { t } = useI18n();
  const { controller } = useMedia();
  return (
    <LeaveButtonView
      label={t("media.leave")}
      size={size}
      onClick={() => void controller.leave()}
    />
  );
}

/**
 * The call's failure line, shared by the stage, the strip and the dock: what
 * went wrong, then Reconnect for a room that was lost or Dismiss otherwise.
 */
export function CallErrorRow({
  surface = "stage",
}: Pick<ToggleSurface, "surface"> = {}) {
  const { t, text } = useI18n();
  const { controller, state } = useMedia();
  const { canUseNetwork } = useAccess();
  if (!state.error) return null;
  const light = surface === "light";
  const action = textButtonStyles({
    size: light ? "small" : "default",
    surface,
  });
  return (
    <div
      className={
        light
          ? "flex items-center gap-2"
          : "flex items-center gap-3 px-4 pt-2 text-ui sm:px-5"
      }
      role="status"
    >
      <p
        className={
          light ? "min-w-0 flex-1 text-caption text-error" : "flex-1 text-off"
        }
      >
        {text(state.error)}
      </p>
      {state.phase === "error" && state.room ? (
        <button
          className={action}
          disabled={!canUseNetwork}
          onClick={() => void controller.resume()}
        >
          {t("media.reconnect")}
        </button>
      ) : (
        <button className={action} onClick={controller.dismissError}>
          {t("media.dismiss")}
        </button>
      )}
    </div>
  );
}

/** Sound the browser held back until a gesture; nothing while playback is allowed. */
export function EnableAudioButton() {
  const { t } = useI18n();
  const { controller, state } = useMedia();
  if (!state.playbackBlocked) return null;
  return (
    <button
      className={buttonStyles({ variant: "primary", size: "small" })}
      onClick={controller.enableAudio}
    >
      <Volume2 className="size-4" aria-hidden="true" />
      {t("media.enableCallAudio")}
    </button>
  );
}

/**
 * The question a second room asks while a call is running: one row across the
 * phone strip, two rows on the dock's card.
 */
export function TransferPrompt({
  surface = "stage",
}: Pick<ToggleSurface, "surface"> = {}) {
  const { t } = useI18n();
  const { controller, state } = useMedia();
  const { canUseNetwork } = useAccess();
  if (!state.transfer) return null;
  const light = surface === "light";
  const question = t("media.moveCallConfirm", { label: state.transfer.label });
  const actions = (
    <>
      <button
        className={buttonStyles({ variant: "primary", size: "small" })}
        disabled={!canUseNetwork}
        onClick={() => void controller.moveCall()}
      >
        {t("media.moveCall")}
      </button>
      <button
        className={buttonStyles({
          variant: light ? "quiet" : "stage",
          size: "small",
        })}
        onClick={controller.cancelTransfer}
      >
        {t("media.cancel")}
      </button>
    </>
  );
  if (light)
    return (
      <>
        <div className="flex items-start gap-2">
          <Smartphone
            className="mt-0.5 size-4 shrink-0 text-muted"
            aria-hidden="true"
          />
          <p className="min-w-0 flex-1 text-caption leading-snug">{question}</p>
        </div>
        <div className="flex items-center gap-2">{actions}</div>
      </>
    );
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-stage-line px-4 py-2.5 text-ui sm:px-5">
      <Smartphone
        className="size-5 shrink-0 text-stage-muted"
        aria-hidden="true"
      />
      <p className="flex-1">{question}</p>
      {actions}
    </div>
  );
}
