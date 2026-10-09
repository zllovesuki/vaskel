import type { ComponentProps, ReactNode } from "react";
import {
  HeadphoneOff,
  LogOut,
  MicOff,
  Monitor,
  PictureInPicture2,
  X,
} from "lucide-react";
import { Avatar, type Hue } from "./avatar";
import {
  buttonStyles,
  controlMotionStyles,
  stageWashStyles,
  washStyles,
} from "./control-styles";
import type { Render } from "./element";

/**
 * A call's parts, drawn the same way by the app and by the landing page's
 * preview: the stage, its people and controls, and the dock, strip and
 * picture-in-picture that keep a call in reach elsewhere.
 */

/**
 * Round call toggles; state is carried by fill, outline and a slash. The dark
 * stage is the default surface; the Home dock draws the same states on a
 * light card.
 */
export function toggleStyles({
  state = "idle",
  surface = "stage",
  size = "tall",
  className = "",
}: {
  state?: "idle" | "on" | "off" | "pending" | "locked" | "broadcast";
  surface?: "stage" | "light";
  size?: "tall" | "normal";
  className?: string;
} = {}) {
  const stage = {
    idle: `border-stage-line text-stage-ink ${stageWashStyles}`,
    on: "border-stage-ink bg-stage-ink text-stage",
    off: `border-off-line text-off ${stageWashStyles}`,
    pending: "border-dashed border-stage-muted text-stage-muted",
    locked: "border-stage-raised text-stage-line",
    broadcast: "border-accent bg-accent text-on-accent",
  };
  const light = {
    idle: `border-line bg-surface text-ink ${washStyles}`,
    on: "border-ink bg-ink text-surface",
    off: `border-off-line bg-surface text-off-line ${washStyles}`,
    pending: "border-dashed border-muted bg-surface text-muted",
    locked: "border-line bg-surface text-muted",
    broadcast: "border-accent bg-accent text-on-accent",
  };
  const states = surface === "light" ? light : stage;
  const dimension =
    size === "normal" ? "size-control-normal" : "size-control-tall";
  return `relative inline-flex ${dimension} shrink-0 items-center justify-center rounded-full border-[1.5px] ${controlMotionStyles} pointer-coarse:size-control-touch ${states[state]} ${className}`;
}

function leaveButtonStyles(size: "tall" | "normal" = "tall") {
  const dimensions =
    size === "normal"
      ? "min-h-control-normal px-3 text-caption"
      : "min-h-control-tall px-4 text-ui";
  return `inline-flex ${dimensions} items-center gap-2 rounded-full bg-leave font-semibold text-on-leave ${controlMotionStyles} not-disabled:hover:bg-leave-hover not-disabled:active:bg-leave-hover pointer-coarse:min-h-control-touch`;
}

/** Idle and joining both wait in grey. */
export type CallPhase =
  "idle" | "joining" | "active" | "reconnecting" | "error";

/** The call's live dot, coloured by phase for the surface it sits on. */
export function PhaseDot({
  phase,
  surface,
}: {
  phase: CallPhase;
  surface: "stage" | "light";
}) {
  const colour =
    phase === "active"
      ? ""
      : phase === "reconnecting"
        ? "bg-stage-accent"
        : phase === "error"
          ? surface === "light"
            ? "bg-off-line"
            : "bg-off"
          : surface === "light"
            ? "bg-muted"
            : "bg-stage-muted";
  return <span className={`live-dot ${colour}`} aria-hidden="true" />;
}

/** Icon control whose accessible name is the action or state its label gives. */
export function Toggle({
  state,
  label,
  icon,
  badge,
  surface = "stage",
  size = "tall",
  ...props
}: {
  state: "idle" | "on" | "off" | "pending" | "locked" | "broadcast";
  label: string;
  icon: ReactNode;
  badge?: ReactNode;
  /** The dark stage, or a light card at the dock. */
  surface?: "stage" | "light";
  /** The stage's 40px or the dock's 36px. */
  size?: "tall" | "normal";
} & Omit<ComponentProps<"button">, "children" | "className">) {
  return (
    <button
      type="button"
      className={toggleStyles({ state, surface, size })}
      title={label}
      {...props}
    >
      {icon}
      {badge && (
        <span
          className={`absolute -right-0.5 -bottom-0.5 grid size-4 place-items-center rounded-full ${surface === "light" ? "bg-surface text-muted" : "bg-stage text-stage-muted"}`}
          aria-hidden="true"
        >
          {badge}
        </span>
      )}
      <span className="sr-only">{label}</span>
    </button>
  );
}

export function LeaveButton({
  label,
  size = "tall",
  ...props
}: {
  label: string;
  size?: "tall" | "normal";
} & Omit<ComponentProps<"button">, "children" | "className">) {
  return (
    <button type="button" className={leaveButtonStyles(size)} {...props}>
      <LogOut className="size-4" aria-hidden="true" />
      {label}
    </button>
  );
}

/**
 * The call's home while its stage is off screen, pinned under Home's list
 * from the `sm` breakpoint up: a light card in Home's own idiom.
 */
export function CallDock({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="shrink-0 border-t border-line p-2">
      <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-2 shadow-row">
        {children}
      </div>
    </section>
  );
}

/** The phone strip above the single pane, on the stage's dark surface. */
export function CallStrip({
  label,
  className = "",
  children,
}: {
  label: string;
  /** Placement only. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className={`z-20 shrink-0 bg-stage text-stage-ink ${className}`}
    >
      {children}
    </section>
  );
}

/**
 * Which call this is and how it is going: the phase dot, the room (a link
 * back to it) and a status line, then the controls that fit.
 */
export function CallSummary({
  surface,
  phase,
  render,
  room,
  status,
  failed = false,
  children,
}: {
  /** The dock's light card, or the phone strip's stage. */
  surface: "light" | "stage";
  phase: CallPhase;
  render: Render;
  room: string;
  status: string;
  failed?: boolean;
  children?: ReactNode;
}) {
  const light = surface === "light";
  return (
    <div
      className={
        light
          ? "flex items-center gap-2"
          : "flex items-center gap-x-2 px-3 py-1.5"
      }
    >
      <PhaseDot phase={phase} surface={surface} />
      <div className="min-w-0 flex-1 leading-snug">
        {render({
          className: light
            ? "block truncate text-ui font-semibold text-ink no-underline hover:underline"
            : "text-ui font-semibold text-stage-ink no-underline hover:underline",
          children: room,
        })}
        <p
          className={
            light
              ? `truncate text-caption ${failed ? "text-error" : "text-muted"}`
              : "truncate text-caption text-stage-muted tabular-nums"
          }
          role="status"
        >
          {status}
        </p>
      </div>
      {children}
    </div>
  );
}

/**
 * A shared screen kept in a corner while the viewer is elsewhere. The
 * caller places it; the link returns to the room.
 */
export function SharePip({
  render,
  media,
  room,
  close,
  className = "",
}: {
  render: Render;
  media: ReactNode;
  room: string;
  /** Hides the picture until the viewer asks for it again. */
  close?: ReactNode;
  /** Placement only. */
  className?: string;
}) {
  return (
    <div
      className={`group/pip overflow-hidden rounded-xl border border-stage-line bg-stage text-stage-ink shadow-popover ${className}`}
    >
      {render({
        className: "block no-underline",
        children: (
          <>
            {media}
            <p className="flex items-center gap-2 px-3 py-1.5 text-caption text-stage-muted">
              <span className="live-dot" aria-hidden="true" />
              <span className="min-w-0 truncate text-stage-ink">{room}</span>
            </p>
          </>
        ),
      })}
      {close}
    </div>
  );
}

/** Appears over the picture on hover or focus, and always on touch screens. */
export function SharePipClose({
  label,
  ...props
}: { label: string } & Omit<
  ComponentProps<"button">,
  "children" | "className"
>) {
  return (
    <button
      type="button"
      className="absolute top-1.5 right-1.5 grid size-7 place-items-center rounded-full bg-stage/80 text-stage-ink opacity-0 transition-opacity group-hover/pip:opacity-100 focus-visible:opacity-100 pointer-coarse:size-control-touch pointer-coarse:opacity-100 [@media(hover:none)]:opacity-100"
      aria-label={label}
      {...props}
    >
      <X className="size-4" aria-hidden="true" />
    </button>
  );
}

/** The call filling the room pane while the viewer is in its room. */
export function Stage({
  children,
  ...props
}: Omit<ComponentProps<"div">, "className">) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-stage text-stage-ink"
      {...props}
    >
      {children}
    </div>
  );
}

/** The stage's first line: phase, room, place, who is here and for how long. */
export function StageHeader({
  phase,
  title,
  context,
  status,
  duration,
  children,
}: {
  phase: CallPhase;
  title: string;
  /** The circle's name, or what a conversation is. */
  context: string;
  status: string;
  duration?: string | undefined;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-stage-line px-4 py-2.5 text-caption text-stage-muted sm:px-5">
      <PhaseDot phase={phase} surface="stage" />
      <strong className="text-ui text-stage-ink">{title}</strong>
      <span className="truncate">{context}</span>
      <span>·</span>
      <span>{status}</span>
      {duration && (
        <>
          <span>·</span>
          <span className="tabular-nums">{duration}</span>
        </>
      )}
      {children}
    </div>
  );
}

/** Sends the shared screen to a corner of the tab, or brings it back. */
export function PipToggle({
  label,
  ...props
}: { label: string } & Omit<
  ComponentProps<"button">,
  "children" | "className"
>) {
  return (
    <button
      type="button"
      className={buttonStyles({
        variant: "stage",
        size: "small",
        className: "ml-auto",
      })}
      aria-label={label}
      {...props}
    >
      <PictureInPicture2 className="size-4" aria-hidden="true" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

export function StageBody({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-5">
      {children}
    </div>
  );
}

/** The screens being shared, one chip each; `note` tells the viewer theirs is out. */
export function ScreenChips({
  label,
  note,
  children,
}: {
  label: string;
  note?: string | undefined;
  children?: ReactNode;
}) {
  return (
    <div className="mb-2.5 flex flex-wrap items-center gap-2">
      <span className="flex items-center gap-1.5 text-caption text-stage-muted">
        <Monitor className="size-4" aria-hidden="true" />
        {label}
      </span>
      {children}
      {note !== undefined && (
        <span className="text-caption font-semibold text-stage-accent">
          {note}
        </span>
      )}
    </div>
  );
}

export function ScreenChip({
  selected,
  children,
  ...props
}: {
  selected: boolean;
  children: ReactNode;
} & Omit<ComponentProps<"button">, "children" | "className">) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={`inline-flex min-h-target items-center rounded-full border px-3 text-caption font-semibold ${controlMotionStyles} ${selected ? "border-stage-ink bg-stage-ink text-stage" : `border-stage-line text-stage-ink ${stageWashStyles}`}`}
      {...props}
    >
      {children}
    </button>
  );
}

/** Where the selected shared screen plays. */
export function StageScreen({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto mb-3 max-w-5xl [&_video]:max-h-[56dvh]">
      {children}
    </div>
  );
}

/** Everyone in the call, under its label. */
export function ParticipantList({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <>
      <p className="mb-2 text-caption text-stage-muted">{label}</p>
      <div className="flex flex-wrap items-center gap-2 pb-1">{children}</div>
    </>
  );
}

/** A person at the table: their chip, a ring while they speak, and what they cannot do. */
export function ParticipantChip({
  name,
  hue,
  speaking = false,
  muted = false,
  deafened = false,
  leaving = false,
  status,
  children,
}: {
  name: string;
  hue: Hue;
  speaking?: boolean;
  muted?: boolean;
  deafened?: boolean;
  leaving?: boolean;
  /** Their state in words, for readers who cannot see the ring or icons. */
  status: string;
  /** The owner's moderation menu. */
  children?: ReactNode;
}) {
  return (
    <div
      className={`inline-flex min-h-target max-w-full items-center gap-2 rounded-lg bg-stage-raised pr-1.5 pl-1 text-caption font-semibold ${leaving ? "opacity-60" : ""}`}
    >
      <Avatar
        name={name}
        hue={hue}
        size={7}
        shape="round"
        className={`transition-shadow ${speaking ? "ring-2 ring-live ring-offset-2 ring-offset-stage-raised" : ""}`}
      />
      <span className="min-w-0 truncate pr-1">{name}</span>
      {deafened ? (
        <HeadphoneOff className="size-4 shrink-0 text-off" aria-hidden="true" />
      ) : muted ? (
        <MicOff className="size-4 shrink-0 text-off" aria-hidden="true" />
      ) : null}
      <span className="sr-only">{status}</span>
      {children}
    </div>
  );
}

/** The stage's control row: toggles, devices and Leave. */
export function StageControls({
  children,
  ...props
}: Omit<ComponentProps<"div">, "className">) {
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-2.5 border-t border-stage-line px-4 py-3 sm:px-5"
      {...props}
    >
      {children}
    </div>
  );
}
