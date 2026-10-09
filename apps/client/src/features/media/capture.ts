import {
  message,
  UiMessageError,
  type UiMessage,
} from "@/client/features/i18n/messages";
import type { MediaSource } from "@vaskel/contracts/media";
export class CaptureEnded extends UiMessageError {}
export interface CapturedTrack {
  source: MediaSource;
  track: MediaStreamTrack;
  synthetic?: true;
  dispose?: () => void;
}
export function stopCapture(tracks: CapturedTrack[]) {
  for (const item of tracks) {
    if (item.dispose) item.dispose();
    else item.track.stop();
  }
}
export async function captureDevice(
  source: "microphone" | "camera",
  deviceId?: string,
): Promise<CapturedTrack[]> {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new UiMessageError(message("media.captureUnsupported"));
  const device = deviceId ? { deviceId: { exact: deviceId } } : {};
  const stream = await navigator.mediaDevices.getUserMedia(
    source === "microphone"
      ? {
          audio: { ...device, echoCancellation: true, noiseSuppression: true },
          video: false,
        }
      : {
          video: { ...device, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        },
  );
  const tracks = stream.getTracks().map((track) => ({ source, track }));
  return tracks;
}
/** This function must be called directly from the Share button's click handler. */
export function captureScreen(): Promise<CapturedTrack[]> {
  if (!navigator.mediaDevices?.getDisplayMedia)
    return Promise.reject(
      new UiMessageError(message("media.screenUnsupported")),
    );
  try {
    return navigator.mediaDevices
      .getDisplayMedia({ video: true, audio: true })
      .then((stream) =>
        stream.getTracks().map((track) => ({
          source:
            track.kind === "video"
              ? ("screen_video" as const)
              : ("screen_audio" as const),
          track,
        })),
      );
  } catch (error) {
    return Promise.reject(error);
  }
}
export function captureError(error: unknown, source: MediaSource): UiMessage {
  if (error instanceof UiMessageError) return error.uiMessage;
  const kind = error instanceof DOMException ? error.name : "";
  switch (source) {
    case "microphone":
      if (kind === "NotAllowedError" || kind === "SecurityError")
        return message("media.microphoneDenied");
      if (kind === "NotFoundError" || kind === "DevicesNotFoundError")
        return message("media.microphoneMissing");
      if (kind === "NotReadableError" || kind === "TrackStartError")
        return message("media.microphoneBusy");
      if (kind === "OverconstrainedError")
        return message("media.microphoneUnavailable");
      return message("media.microphoneFailed");
    case "camera":
      if (kind === "NotAllowedError" || kind === "SecurityError")
        return message("media.cameraDenied");
      if (kind === "NotFoundError" || kind === "DevicesNotFoundError")
        return message("media.cameraMissing");
      if (kind === "NotReadableError" || kind === "TrackStartError")
        return message("media.cameraBusy");
      if (kind === "OverconstrainedError")
        return message("media.cameraUnavailable");
      return message("media.cameraFailed");
    case "screen_audio":
    case "screen_video":
      if (kind === "NotAllowedError" || kind === "SecurityError")
        return message("media.screenDenied");
      if (kind === "NotFoundError" || kind === "DevicesNotFoundError")
        return message("media.screenMissing");
      if (kind === "NotReadableError" || kind === "TrackStartError")
        return message("media.screenBusy");
      if (kind === "OverconstrainedError")
        return message("media.screenUnavailable");
      return message("media.screenFailed");
  }
}
