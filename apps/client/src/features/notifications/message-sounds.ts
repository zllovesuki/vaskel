import { useSyncExternalStore } from "react";
import type { AccountEventFrame } from "@vaskel/contracts/account-events";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import type { NotificationState } from "@vaskel/contracts/notifications";
import { holdWebLock } from "@/client/browser/locks";
import { roomPreference } from "./room-preference";

export type Arrival = Extract<AccountEventFrame, { type: "activity" }>;

/** One cue per browser in this window: the first plays at once, repeats are dropped. */
export const MESSAGE_SOUND_COOLDOWN_MS = 3_000;
const SWITCH_KEY = "vaskel.messageSounds";
const PLAYED_KEY = "vaskel.messageSoundAt";
/** Chrome leaves resume() pending without user activation; never wait on it for long. */
const RESUME_WAIT_MS = 250;

const listeners = new Set<() => void>();
function readSwitch() {
  try {
    return localStorage.getItem(SWITCH_KEY) !== "off";
  } catch {
    return true;
  }
}
let enabled = readSwitch();
export const messageSoundsEnabled = () => enabled;
export function setMessageSounds(next: boolean) {
  enabled = next;
  try {
    if (next) localStorage.removeItem(SWITCH_KEY);
    else localStorage.setItem(SWITCH_KEY, "off");
  } catch {
    /* Private windows may refuse storage; the choice still applies to this page. */
  }
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== SWITCH_KEY && event.key !== null) return;
    enabled = readSwitch();
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The device-level Message sounds switch. It is not an account setting. */
export function useMessageSounds(): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(
    subscribe,
    messageSoundsEnabled,
    () => true,
  );
  return [value, setMessageSounds];
}

/**
 * Two quick glass strikes rising a fourth (G5, C6), each overtone fading almost
 * at once. About −26 LUFS, about 0.6 s audible.
 */
const CHIME = {
  attack: 0.008,
  master: 0.165,
  notes: [
    { at: 0, frequency: 783.99, gain: 0.75 },
    { at: 0.085, frequency: 1046.5, gain: 1 },
  ],
  partials: [
    { ratio: 1, gain: 1, decay: 0.17 },
    { ratio: 2.756, gain: 0.12, decay: 0.04 },
  ],
};
/** The second note's oscillator stops after eight decay constants, about 1.45 s in. */
const TAIL_MS = 1_600;

/**
 * One tab's audio. Browsers start audio only after a gesture, and Safari only
 * inside one, so the tab's first click or key press prepares the context.
 */
export class SoundPlayer {
  private context: AudioContext | null = null;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private unlocked = false;
  constructor(
    private readonly create: () => AudioContext | null = () =>
      typeof AudioContext === "undefined" ? null : new AudioContext(),
  ) {}
  /** Call from a gesture handler; resolves once the tab can play. */
  unlock(): Promise<boolean> {
    if (this.unlocked) return Promise.resolve(true);
    this.context ??= this.create();
    const context = this.context;
    if (!context) return Promise.resolve(false);
    return context.resume().then(
      () => {
        if (context.state !== "running") return false;
        this.unlocked = true;
        this.rest();
        return true;
      },
      () => false,
    );
  }
  /** Resumes a prepared context without holding any lock while it waits. */
  async prepare() {
    const context = this.context;
    if (!this.unlocked || !context || context.state === "closed") return false;
    if (context.state !== "running")
      await Promise.race([
        context.resume().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, RESUME_WAIT_MS)),
      ]);
    return context.state === "running";
  }
  /** Schedules the chime only while running, so nothing plays late. */
  start() {
    const context = this.context;
    if (!context || context.state !== "running") return false;
    const begin = context.currentTime + 0.01;
    const master = context.createGain();
    master.gain.value = CHIME.master;
    master.connect(context.destination);
    for (const note of CHIME.notes)
      for (const partial of CHIME.partials) {
        const at = begin + note.at;
        const oscillator = context.createOscillator();
        oscillator.frequency.value = note.frequency * partial.ratio;
        const envelope = context.createGain();
        envelope.gain.setValueAtTime(0, at);
        envelope.gain.linearRampToValueAtTime(
          note.gain * partial.gain,
          at + CHIME.attack,
        );
        envelope.gain.setTargetAtTime(0, at + CHIME.attack, partial.decay);
        oscillator.connect(envelope).connect(master);
        oscillator.start(at);
        oscillator.stop(at + CHIME.attack + partial.decay * 8);
      }
    this.rest();
    return true;
  }
  /** Releases the audio device once the tail has finished. */
  private rest() {
    clearTimeout(this.idle);
    const context = this.context;
    this.idle = setTimeout(() => {
      if (context?.state === "running") void context.suspend().catch(() => {});
    }, TAIL_MS);
  }
  close() {
    clearTimeout(this.idle);
    this.unlocked = false;
    void this.context?.close().catch(() => {});
    this.context = null;
  }
}

/** Plays the chime once from a settings click, which also satisfies autoplay rules. */
export function previewMessageSound() {
  const player = new SoundPlayer();
  void player
    .unlock()
    .then((ready) => ready && player.start())
    .finally(() => setTimeout(() => player.close(), TAIL_MS));
}

export const viewingLockName = (
  accountId: string,
  owner: OwnerScope,
  channelId: string,
) => `vaskel:viewing:${accountId}:${owner.kind}:${owner.id}:${channelId}`;
/** Conversations this tab shows in a focused window; the Web Lock tells other tabs. */
const viewingHere = new Set<string>();

/** Holds a viewing lock until the returned release runs. */
export function holdViewing(name: string) {
  viewingHere.add(name);
  const locks = navigator.locks;
  const held = locks ? holdWebLock(locks, name) : undefined;
  void held?.acquired.catch(() => {});
  return () => {
    viewingHere.delete(name);
    held?.release();
  };
}

function readPlayedAt() {
  try {
    const value = Number(localStorage.getItem(PLAYED_KEY));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return playedHere;
  }
}
let playedHere = 0;
function startOnce(player: SoundPlayer) {
  const now = Date.now();
  const last = Math.max(readPlayedAt(), playedHere);
  if (now >= last && now - last < MESSAGE_SOUND_COOLDOWN_MS) return false;
  if (!player.start()) return false;
  playedHere = now;
  try {
    localStorage.setItem(PLAYED_KEY, String(now));
  } catch {
    /* This tab still observes its own cooldown. */
  }
  return true;
}

/**
 * The account's settings as this tab last read them. A message addressed to the
 * reader sounds by default; other room activity only in rooms set to All.
 * Pausing stops push notifications only. Without settings nothing sounds, so a
 * room's Nothing or mute is never guessed.
 */
export function wantsSound(
  settings: NotificationState | undefined,
  arrival: Arrival,
  now: number,
) {
  if (!settings) return false;
  const room = roomPreference(settings, arrival.owner, arrival.channelId);
  const mode = room?.mode ?? "direct";
  if (mode === "nothing" || (room?.mutedUntil ?? 0) > now) return false;
  return arrival.direct || mode === "all";
}

/**
 * Plays one cue for a fresh arrival that the settings allow, unless the browser
 * just played one or a tab is showing that conversation. Only a started sound
 * consumes the cooldown.
 */
export async function playMessageSound(
  accountId: string,
  arrival: Arrival,
  settings: NotificationState | undefined,
  player: SoundPlayer,
  current: () => boolean,
) {
  if (
    !messageSoundsEnabled() ||
    !wantsSound(settings, arrival, Date.now()) ||
    !(await player.prepare()) ||
    !current()
  )
    return false;
  const viewing = viewingLockName(accountId, arrival.owner, arrival.channelId);
  if (viewingHere.has(viewing)) return false;
  const locks = navigator.locks;
  // Without Web Locks each tab keeps its own view and cooldown; duplicates are accepted.
  if (!locks) return startOnce(player);
  const held = await locks
    .query()
    .then((snapshot) => snapshot.held ?? [])
    .catch(() => []);
  if (!current() || held.some((lock) => lock.name === viewing)) return false;
  return locks.request(
    `vaskel:message-sound:${accountId}`,
    { ifAvailable: true },
    (lock) => lock !== null && current() && startOnce(player),
  );
}
