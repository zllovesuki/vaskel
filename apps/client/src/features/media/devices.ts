import { useEffect, useState } from "react";

export type DeviceKind = "microphone" | "camera" | "speaker";
export interface DeviceChoices {
  microphone?: string;
  camera?: string;
  speaker?: string;
}
export interface DeviceList {
  microphones: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
}

const CHOICES_KEY = "vaskel.media.devices";
const empty: DeviceList = { microphones: [], cameras: [], speakers: [] };

/** The person's chosen devices for this tab; absent means the browser default. */
export function readDeviceChoices(): DeviceChoices {
  try {
    const raw = sessionStorage.getItem(CHOICES_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const choices: DeviceChoices = {};
    for (const kind of ["microphone", "camera", "speaker"] as const) {
      const value = (parsed as Record<string, unknown>)[kind];
      if (typeof value === "string" && value) choices[kind] = value;
    }
    return choices;
  } catch {
    return {};
  }
}
export function writeDeviceChoices(choices: DeviceChoices) {
  try {
    if (Object.keys(choices).length === 0)
      sessionStorage.removeItem(CHOICES_KEY);
    else sessionStorage.setItem(CHOICES_KEY, JSON.stringify(choices));
  } catch {
    /* Memory-only choice when storage is unavailable. */
  }
}

/** Output selection needs setSinkId, which Safari and Firefox lack. */
export function speakerSelectionSupported(): boolean {
  return (
    typeof HTMLMediaElement !== "undefined" &&
    "setSinkId" in HTMLMediaElement.prototype
  );
}

/** Labels are only revealed after a capture permission; ids stay stable per origin. */
export async function listDevices(): Promise<DeviceList> {
  if (!navigator.mediaDevices?.enumerateDevices) return empty;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      microphones: devices.filter((device) => device.kind === "audioinput"),
      cameras: devices.filter((device) => device.kind === "videoinput"),
      speakers: speakerSelectionSupported()
        ? devices.filter((device) => device.kind === "audiooutput")
        : [],
    };
  } catch {
    return empty;
  }
}

/** The device list while `enabled`, refreshed when devices are plugged or unplugged. */
export function useDeviceList(enabled: boolean): DeviceList {
  const [list, setList] = useState<DeviceList>(empty);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const refresh = () => {
      void listDevices().then((devices) => {
        if (active) setList(devices);
      });
    };
    refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => {
      active = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
    };
  }, [enabled]);
  return list;
}
