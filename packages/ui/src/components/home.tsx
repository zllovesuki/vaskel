import type { ComponentProps, ReactNode } from "react";
import {
  ChevronDown,
  Hash,
  Lock,
  Menu,
  ScreenShare,
  Search,
  Users,
  Volume2,
  X,
} from "lucide-react";
import { Avatar, type Hue } from "./avatar";
import { buttonStyles } from "./control-styles";
import type { Render } from "./element";

/**
 * Home's parts, drawn the same way by the app and by the landing page's
 * preview. Each caller supplies words, data and the element a row navigates
 * with; these own the look.
 */

/** The wordmark's type, also for places that show it outside Home's header. */
export const wordmarkStyles =
  "text-[1.45rem] leading-none font-bold tracking-[-0.06em] text-ink no-underline [&>span]:text-accent";

const sidebarHeaderStyles = "flex min-h-14 items-center gap-1 px-3 sm:min-h-15";

const navRowStyles =
  "flex min-h-target items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-ui font-medium text-muted no-underline hover:bg-wash hover:text-ink active:bg-press aria-[current=page]:bg-surface aria-[current=page]:font-semibold aria-[current=page]:text-ink aria-[current=page]:shadow-row data-[unread]:font-semibold data-[unread]:text-ink";

const unreadDotStyles = "ml-auto size-1.5 shrink-0 rounded-full bg-accent";

const unreadBadgeStyles =
  "ml-auto inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-[11px] leading-5 font-semibold text-on-accent tabular-nums";

/** A mention inside a circle or Direct messages row: a bare accent glyph; the inbox holds the count. */
const mentionMarkStyles =
  "ml-auto shrink-0 text-[12px] leading-5 font-bold text-accent";

/** A room or circle the viewer has not opened yet: a soft chip, not a count. */
const newMarkerStyles =
  "ml-auto inline-flex shrink-0 items-center rounded-full bg-accent-soft px-1.5 text-[11px] leading-5 font-semibold text-accent";

/** A Home row: quiet by default, lifted when current, bold when unread. */
export function NavRow({
  render,
  current = false,
  unread = false,
  className = "",
  children,
}: {
  render: Render;
  current?: boolean;
  unread?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return render({
    // `group/row` lets a cutout ring follow the row's own fill.
    className: `${navRowStyles} group/row ${className}`,
    "aria-current": current ? "page" : undefined,
    "data-unread": unread ? "" : undefined,
    children,
  });
}

export function ChannelIcon({
  kind,
  locked = false,
}: {
  kind: "text" | "media";
  locked?: boolean;
}) {
  const Icon = kind === "media" ? Volume2 : locked ? Lock : Hash;
  return <Icon className="size-4 shrink-0 opacity-70" aria-hidden="true" />;
}

export function SearchRow({
  render,
  current,
  label,
}: {
  render: Render;
  current?: boolean;
  label: string;
}) {
  return (
    <NavRow render={render} current={current ?? false} className="mb-3">
      <Search className="size-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </NavRow>
  );
}

export function PeopleRow({
  render,
  current,
  label,
  detail,
}: {
  render: Render;
  current?: boolean;
  label: string;
  /** Who is online, or how many people the circle has. */
  detail?: string | undefined;
}) {
  return (
    <NavRow render={render} current={current ?? false} className="mt-0.5">
      <Users className="size-4 shrink-0 opacity-70" aria-hidden="true" />
      <span className="truncate">{label}</span>
      {detail !== undefined && (
        <span className="ml-auto text-fine font-normal text-muted tabular-nums">
          {detail}
        </span>
      )}
    </NavRow>
  );
}

/** A room in a circle; `children` carries its marks and hidden descriptions. */
export function ChannelRow({
  render,
  kind,
  locked,
  name,
  current,
  unread,
  children,
}: {
  render: Render;
  kind: "text" | "media";
  locked?: boolean;
  name: string;
  current?: boolean;
  unread?: boolean;
  children?: ReactNode;
}) {
  return (
    <NavRow
      render={render}
      current={current ?? false}
      unread={unread ?? false}
      className="mt-0.5"
    >
      <ChannelIcon kind={kind} locked={locked ?? false} />
      <span className="truncate" title={name}>
        {name}
      </span>
      {children}
    </NavRow>
  );
}

/** A conversation: the counterpart's tile, their presence and name. */
export function DirectRow({
  render,
  name,
  hue,
  online = false,
  current,
  unread,
  children,
}: {
  render: Render;
  name: string;
  hue: Hue;
  online?: boolean;
  current?: boolean;
  unread?: boolean;
  children?: ReactNode;
}) {
  return (
    <NavRow
      render={render}
      current={current ?? false}
      unread={unread ?? false}
      className="mt-0.5"
    >
      <span className="relative shrink-0">
        <Avatar name={name} hue={hue} size={6} />
        {/* The cutout ring matches the row behind it in every state. */}
        {online && (
          <span
            className="live-dot absolute -right-0.5 -bottom-0.5 ring-2 ring-sidebar group-hover/row:ring-sidebar-hover group-aria-[current=page]/row:ring-surface"
            aria-hidden="true"
          />
        )}
      </span>
      <span className="truncate" title={name}>
        {name}
      </span>
      {children}
    </NavRow>
  );
}

/** An Unread inbox destination: a room under its circle's name, or a person. */
export function InboxRow({
  render,
  name,
  place,
  hue,
  locked,
  children,
}: {
  render: Render;
  name: string;
  /** The circle a room belongs to. */
  place?: string | undefined;
  /** A conversation is drawn as the person it is with. */
  hue?: Hue | undefined;
  locked?: boolean;
  children?: ReactNode;
}) {
  return (
    <NavRow render={render} unread className="mt-0.5">
      {hue === undefined ? (
        <ChannelIcon kind="text" locked={locked ?? false} />
      ) : (
        <Avatar name={name} hue={hue} size={6} />
      )}
      <span className="min-w-0 flex-1 leading-snug">
        <span className="block truncate">{name}</span>
        {place !== undefined && (
          <span className="block truncate text-fine font-normal text-muted">
            {place}
          </span>
        )}
      </span>
      {children}
    </NavRow>
  );
}

/**
 * How a Home row marks unread activity: a count badge, a bare "@" for a
 * mention inside a circle, a dot, or a New chip for a room never opened.
 */
export function UnreadMark({
  kind,
  text,
  label,
}: {
  kind: "badge" | "mention" | "dot" | "new";
  /** What a badge shows. */
  text?: string;
  /** The words a reader hears, or the chip's text. */
  label: string;
}) {
  if (kind === "new") return <span className={newMarkerStyles}>{label}</span>;
  if (kind === "badge")
    return (
      <span className={unreadBadgeStyles} aria-label={label}>
        {text}
      </span>
    );
  return (
    <>
      {kind === "mention" ? (
        <span aria-hidden="true" className={mentionMarkStyles}>
          @
        </span>
      ) : (
        <span aria-hidden="true" className={unreadDotStyles} />
      )}
      <span className="sr-only">{label}</span>
    </>
  );
}

/**
 * A Home section under its small-caps label. A count or an action sits on
 * the label's row; without either the label stands alone.
 */
export function HomeSection({
  label,
  count,
  action,
  children,
  ...props
}: {
  label: ReactNode;
  count?: string | undefined;
  action?: ReactNode;
} & ComponentProps<"section">) {
  return (
    <section {...props}>
      {count === undefined && action === undefined ? (
        <h2 className={"section-label mb-1 px-2.5"}>{label}</h2>
      ) : (
        <div className="mb-1 flex min-h-7 items-center justify-between gap-3 px-2.5">
          <h2 className="section-label">{label}</h2>
          {count !== undefined && (
            <span className="text-fine text-muted tabular-nums">{count}</span>
          )}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** Home's header, in its fixed order: the wordmark, then close, add and account. */
export function HomeHeader({
  wordmark,
  close,
  add,
  account,
}: {
  wordmark: ReactNode;
  close?: ReactNode;
  add?: ReactNode;
  account?: ReactNode;
}) {
  return (
    <header className={sidebarHeaderStyles}>
      {wordmark}
      {close}
      {add}
      {account}
    </header>
  );
}

export function Wordmark({ render }: { render: Render }) {
  return render({
    className: `${wordmarkStyles} mr-auto px-1`,
    children: (
      <>
        vaskel<span aria-hidden="true">.</span>
      </>
    ),
  });
}

/**
 * Opens Home over a phone's single pane, or closes it again. The workspace
 * returns focus to one of these (`data-navigation-toggle`) when Home closes.
 */
export function NavigationToggle({
  action,
  label,
  ...props
}: {
  action: "open" | "close";
  label: string;
} & Omit<ComponentProps<"button">, "children" | "className">) {
  const Icon = action === "open" ? Menu : X;
  return (
    <button
      type="button"
      className={buttonStyles({
        variant: "quiet",
        size: "icon",
        className: "sm:hidden",
      })}
      data-navigation-toggle
      aria-label={label}
      {...props}
    >
      <Icon aria-hidden="true" />
    </button>
  );
}

/**
 * A circle's heading: the toggle that folds its rooms away (chevron, tile,
 * name and, while folded, the current room and its marks), then the owner's
 * actions.
 */
export function CircleHeader({
  toggle,
  name,
  initial,
  expanded,
  detail,
  marks,
  children,
}: {
  toggle: Render;
  name: string;
  initial: string;
  expanded: boolean;
  /** The current room, shown while the circle is folded. */
  detail?: string | undefined;
  marks?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <h3 className="flex items-center gap-1 text-ui font-semibold">
      {toggle({
        className: buttonStyles({
          variant: "quiet",
          size: "small",
          justify: "start",
          className: "min-w-0 flex-1 text-left",
        }),
        children: (
          <>
            <ChevronDown
              className={`size-4 shrink-0 transition-transform ${expanded ? "" : "-rotate-90"}`}
              aria-hidden="true"
            />
            {/* Translucent ink, so the tile stays a step apart from its header
                whether or not the header is washed on hover. */}
            <span
              className="grid size-6 shrink-0 place-items-center rounded-md bg-ink/8 text-fine font-bold"
              aria-hidden="true"
            >
              {initial}
            </span>
            <span className="min-w-0 flex-1">
              <span
                className="line-clamp-2 font-semibold wrap-anywhere"
                title={name}
              >
                {name}
              </span>
              {detail !== undefined && (
                <span className="block truncate text-caption text-muted">
                  {detail}
                </span>
              )}
            </span>
            {marks}
          </>
        ),
      })}
      {children}
    </h3>
  );
}

/** A folded circle's unread total, in the accent. */
export function CircleUnreadCount({
  text,
  label,
}: {
  text: string;
  label: string;
}) {
  return (
    <span
      className="text-caption font-semibold text-accent tabular-nums"
      aria-label={label}
    >
      {text}
    </span>
  );
}

/**
 * A live voice room in Happening now: the room, where it is and whether
 * the viewer is in it, then who is there and for how long, then who is
 * sharing. The room name underlines like the room names in the dock and
 * the phone strip.
 */
export function LiveCallCard({
  render,
  people,
  more,
  room,
  place,
  inCall,
  duration,
  sharing,
  youAreIn,
  join,
}: {
  render: Render;
  /** The first few people, drawn as overlapping tiles. */
  people: readonly { name: string; hue: Hue }[];
  /** How many more are there, already formatted. */
  more?: string | undefined;
  room: string;
  place?: string | undefined;
  inCall: string;
  duration?: string | undefined;
  sharing?: string | undefined;
  /** Shown instead of `join` while the viewer is in this call. */
  youAreIn?: string | undefined;
  join?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-stage px-3 py-2.5 text-stage-ink shadow-row">
      {/* The whole card opens the room. Each line has the card's width: the
          room and the viewer's own state, then who is there, then who shares.
          Join, when offered, takes a row of its own. */}
      {render({
        className:
          "group block min-w-0 leading-tight text-stage-ink no-underline",
        children: (
          <>
            <span className="flex items-center gap-1.5 text-ui font-semibold">
              <Volume2
                className="size-3.5 shrink-0 text-live"
                aria-hidden="true"
              />
              <span className="truncate group-hover:underline group-active:underline">
                {room}
              </span>
              {place !== undefined && (
                <span className="truncate font-normal text-stage-muted">
                  · {place}
                </span>
              )}
              {youAreIn !== undefined && (
                <span className="ml-auto shrink-0 pl-2 text-caption font-semibold text-live">
                  {youAreIn}
                </span>
              )}
            </span>
            <span className="mt-1.5 flex items-center gap-2 text-caption text-stage-muted">
              <span className="flex shrink-0 -space-x-1.5" aria-hidden="true">
                {people.map((person, index) => (
                  <Avatar
                    key={index}
                    name={person.name}
                    hue={person.hue}
                    size={5}
                    className="ring-2 ring-stage"
                  />
                ))}
                {more !== undefined && (
                  <span className="grid size-5 place-items-center rounded-[30%] bg-stage-raised text-[10px] font-semibold ring-2 ring-stage">
                    +{more}
                  </span>
                )}
              </span>
              <span className="truncate">
                {inCall}
                {duration ? ` · ${duration}` : ""}
              </span>
            </span>
            {sharing !== undefined && (
              <span className="mt-1 flex items-center gap-1.5 text-caption text-stage-muted">
                <ScreenShare className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{sharing}</span>
              </span>
            )}
          </>
        ),
      })}
      {youAreIn === undefined && join}
    </div>
  );
}
