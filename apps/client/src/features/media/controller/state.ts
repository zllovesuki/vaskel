import type { UiMessage } from "@/client/features/i18n/messages";
import { mediaErrorMessage } from "@/client/features/media/protocol";
import type {
  MediaRoomRef,
  MediaSnapshot,
  MediaSource,
} from "@vaskel/contracts/media";
import type { CallIntent } from "@/client/features/media/intent";
import type { SessionView } from "@/client/features/media/session";

export interface CallState {
  /** Active means admitted membership; each media exchange owns transport readiness. */
  phase: "idle" | "joining" | "active" | "reconnecting" | "error";
  configured: boolean | null;
  room: MediaRoomRef | null;
  label: string;
  canModerate: boolean;
  /** Available once admitted, including session callbacks during joining. */
  session: SessionView | null;
  muted: boolean;
  pendingSources: MediaSource[];
  error: UiMessage | null;
  transfer: {
    room: MediaRoomRef;
    label: string;
    canModerate: boolean;
    generation: number;
  } | null;
  playbackBlocked: boolean;
  hiddenUserIds: string[];
  /** Set when the call first becomes active in this tab; the stage shows elapsed time. */
  joinedAt: number | null;
  /** Client-only: silences everything received, never the moderation RPC. */
  deafened: boolean;
  /** Client-only: show the shared screen as a thumbnail while away from the room. */
  pictureInPicture: boolean;
}

export type LifecycleTransition =
  | { kind: "joining"; intent: CallIntent }
  | { kind: "ready"; snapshot?: MediaSnapshot }
  | { kind: "failed"; error: unknown }
  | { kind: "action_failed"; message: UiMessage }
  | { kind: "transfer"; target: NonNullable<CallState["transfer"]> }
  | { kind: "left" };

export function initialCallState(
  intent: CallIntent | null,
  muted: boolean,
  pictureInPicture: boolean,
): CallState {
  return {
    phase: "idle",
    configured: null,
    room: null,
    label: "",
    canModerate: false,
    session: null,
    muted: muted,
    pendingSources: [],
    error: null,
    transfer: null,
    playbackBlocked: false,
    hiddenUserIds: intent?.hiddenUserIds ?? [],
    joinedAt: null,
    deafened: intent?.deafened ?? false,
    pictureInPicture: pictureInPicture,
  };
}

export function joiningCallState(intent: CallIntent): Partial<CallState> {
  return {
    phase: "joining",
    hiddenUserIds: intent.hiddenUserIds ?? [],
    deafened: intent.deafened ?? false,
    joinedAt: null,
    room: intent.room,
    label: intent.label,
    canModerate: intent.canModerate,
    error: null,
    transfer: null,
    session: null,
    pendingSources: [],
  };
}

export function leftCallState(): Partial<CallState> {
  return {
    phase: "idle",
    room: null,
    label: "",
    session: null,
    pendingSources: [],
    transfer: null,
    error: null,
    playbackBlocked: false,
    hiddenUserIds: [],
    joinedAt: null,
    deafened: false,
  };
}

export function failedCallState(
  intent: CallIntent | null,
  error: unknown,
): Partial<CallState> {
  return {
    phase: "error",
    room: intent?.room ?? null,
    label: intent?.label ?? "",
    transfer: null,
    pendingSources: [],
    session: null,
    joinedAt: null,
    error: mediaErrorMessage(error),
  };
}
