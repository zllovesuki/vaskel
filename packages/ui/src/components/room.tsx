import type { ComponentProps, ReactNode } from "react";
import {
  ArrowUpRight,
  Forward,
  Hash,
  Reply,
  RotateCcw,
  Volume2,
} from "lucide-react";
import { Avatar, type Hue } from "./avatar";
import { buttonStyles, chatHeaderStyles } from "./control-styles";
import type { Render } from "./element";

/**
 * A room's parts, drawn the same way by the app and by the landing page's
 * preview: the header, the people online, messages and the composer's
 * chrome. Callers supply words and behaviour; these own the look.
 */

/** The composer's outer frame, shared with the startup skeleton so the placeholder keeps its height. */
export const composerFrameStyles =
  "shrink-0 p-page-gutter pb-[max(var(--spacing-page-gutter),env(safe-area-inset-bottom))]";

/** Shared with the skeleton so restoring a draft does not move the timeline. */
export const composerSurfaceStyles = "rounded-2xl border border-composer-line";

/** The composer's box: its outline takes the accent while the field has focus. */
export const composerBoxStyles = `${composerSurfaceStyles} relative bg-surface transition-[border-color,box-shadow] duration-150 ease-out focus-within:border-accent focus-within:ring-1 focus-within:ring-accent`;

export const composerInputStyles =
  "block max-h-[200px] min-h-[72px] w-full min-w-0 resize-none border-0 bg-transparent px-4 pt-4 pb-2 text-[16px] leading-[1.4] text-ink field-sizing-content placeholder:text-muted placeholder:opacity-90 focus:outline-none sm:text-chat";

export const composerToolbarStyles =
  "relative mb-1 flex h-target items-center gap-1 px-2 before:pointer-events-none before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-line/65";

const composerStatusStyles =
  "flex h-full min-w-0 flex-1 items-center gap-2 text-fine text-muted";

const composerSendStyles =
  "group inline-flex h-target w-[48px] shrink-0 items-center justify-center rounded-lg border-0 bg-transparent p-0 disabled:opacity-100";

const composerSendIconStyles =
  "grid h-control-compact w-[40px] place-items-center rounded-[6px] bg-accent text-on-accent transition-colors duration-150 ease-out group-hover:bg-accent-hover group-active:bg-accent-hover group-active:duration-0 group-disabled:bg-subtle group-disabled:text-muted";

function reactionPillStyles(mine: boolean) {
  return `inline-flex min-h-control-compact items-center gap-1 rounded-md border px-2 py-0.5 text-caption leading-5 tabular-nums transition-[color,background-color,border-color,opacity] duration-150 ease-out active:duration-0 ${mine ? "border-accent bg-accent-soft text-accent not-disabled:hover:bg-accent-soft-hover not-disabled:active:bg-accent-soft-hover" : "border-line bg-subtle text-muted not-disabled:hover:border-accent not-disabled:active:border-accent"}`;
}

/** A time as a message prints it: the clock, the machine value and the full date on hover. */
export interface MessageTime {
  text: string;
  dateTime: string;
  title?: string | undefined;
}

/** A message body's type and measure; the app renders Markdown into it. */
export const messageBodyStyles = "message-body text-chat leading-relaxed";

/**
 * A text room, conversation or voice room header. On phones the title keeps
 * one line beside the Home button; wider panes allow two.
 */
export function RoomHeader({
  navigation,
  mark,
  title,
  subtitle,
  subtitleTitle,
  children,
}: {
  navigation: ReactNode;
  /** A room's icon, or the person a conversation is with. */
  mark: "text" | "media" | { name: string; hue: Hue };
  title: string;
  subtitle: string;
  /** The full topic, when the subtitle may truncate it. */
  subtitleTitle?: string | undefined;
  /** Room tools; omitted while they cannot act. */
  children?: ReactNode;
}) {
  const Icon = mark === "media" ? Volume2 : Hash;
  return (
    <header className={chatHeaderStyles}>
      {navigation}
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:flex-initial sm:gap-2.5">
        {typeof mark === "string" ? (
          <Icon
            className="hidden size-5 shrink-0 text-muted sm:block"
            aria-hidden="true"
          />
        ) : (
          <Avatar
            name={mark.name}
            hue={mark.hue}
            size={8}
            className="max-sm:hidden"
          />
        )}
        <div className="min-w-0">
          <h1
            className="truncate text-chat font-semibold tracking-tight sm:line-clamp-2 sm:text-base sm:whitespace-normal sm:wrap-anywhere"
            title={title}
          >
            {title}
          </h1>
          <p className="truncate text-caption text-muted" title={subtitleTitle}>
            {subtitle}
          </p>
        </div>
      </div>
      {children !== undefined && (
        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1.5">
          {children}
        </div>
      )}
    </header>
  );
}

/** Who is online in a circle; the app links it to the circle's People page. */
export function PresenceStrip({
  render,
  people,
  label,
}: {
  render: Render;
  people: readonly { name: string; hue: Hue }[];
  label: string;
}) {
  return render({
    className: buttonStyles({
      variant: "quiet",
      size: "small",
      className: "group max-sm:px-2 sm:px-2.5",
    }),
    children: (
      <>
        {/* Cutout rings follow the control's own wash on hover. */}
        <span className="flex -space-x-1.5 empty:hidden" aria-hidden="true">
          {people.map((person, index) => (
            <Avatar
              key={index}
              name={person.name}
              hue={person.hue}
              size={5}
              className="ring-2 ring-surface group-hover:ring-surface-hover"
            />
          ))}
        </span>
        <span className="text-caption font-medium text-muted">{label}</span>
      </>
    ),
  });
}

/**
 * A day or unread marker on the timeline. One hairline carries both when a
 * day starts at the unread position: the day first, then Unread in the
 * accent that the line also takes.
 */
export function TimelineDivider({
  day,
  unread,
}: {
  day?: string | undefined;
  unread?: string | undefined;
}) {
  return (
    <div
      className="timeline-divider"
      data-new={unread !== undefined ? "" : undefined}
    >
      {day !== undefined && (
        <span className={unread !== undefined ? "text-muted" : undefined}>
          {day}
        </span>
      )}
      {unread !== undefined && <span>{unread}</span>}
    </div>
  );
}

/**
 * One message in the timeline. A run from one author shows its avatar, name
 * and time once; later messages keep the time in the gutter. `children` is
 * the content column: quote, body, files, reactions and any open step.
 */
export function MessageRow({
  author,
  time,
  edited,
  grouped = false,
  mentioned = false,
  jumped = false,
  divider,
  className = "",
  children,
  ...props
}: {
  author: { name: string; hue: Hue };
  time: MessageTime;
  /** The edited note beside the time, for a message that starts a run. */
  edited?: string | undefined;
  /** Continues the previous author's run: no repeated avatar or name. */
  grouped?: boolean;
  /** This message names the reader; the row carries a quiet accent. */
  mentioned?: boolean;
  /** The row a jump opened at: it warms briefly while focus arrives. */
  jumped?: boolean;
  /** A day or unread marker above the row. */
  divider?: ReactNode;
  className?: string;
  children: ReactNode;
} & Omit<ComponentProps<"article">, "children" | "className">) {
  return (
    <div>
      {divider && <div className="px-page-gutter pt-4 pb-1">{divider}</div>}
      <article
        {...props}
        data-jump-target={jumped || undefined}
        data-mentioned={mentioned || undefined}
        // Mention tint and landing glow live in timeline.css so hover and
        // focus never replace them; reduced motion holds the glow steady.
        className={`message-row group/message relative px-page-gutter hover:bg-message-hover focus-within:bg-message-hover data-[actions-open=true]:bg-message-hover motion-reduce:data-[jump-target=true]:bg-accent-soft ${grouped ? "" : "mt-2.5"} ${className}`}
      >
        {/* An overlay marker, so naming the reader never moves the row. */}
        {mentioned && (
          <span
            aria-hidden="true"
            className="absolute inset-y-0 left-0 w-0.5 bg-accent"
          />
        )}
        {!grouped && (
          <div className="message-heading">
            <div className="relative" aria-hidden="true">
              <Avatar
                name={author.name}
                hue={author.hue}
                className="absolute top-0 left-0"
              />
            </div>
            <div className="flex min-w-0 flex-wrap items-baseline gap-2">
              <strong className="text-ui font-semibold">{author.name}</strong>
              <time
                className="text-caption text-muted tabular-nums"
                dateTime={time.dateTime}
                title={time.title}
              >
                {time.text}
              </time>
              {edited !== undefined && (
                <span className="text-fine text-muted">{edited}</span>
              )}
            </div>
          </div>
        )}
        {/* Every message shares one content/action row; the optional header
            never changes the menu's alignment or the spacing between bodies. */}
        <div className="message-line">
          <span className="relative">
            {grouped && (
              // A 12-hour clock outgrows the phone gutter, so it starts at `sm`.
              <time
                className="message-gutter-time absolute top-1.5 -right-2 hidden whitespace-nowrap text-fine text-muted tabular-nums sm:inline-flex"
                dateTime={time.dateTime}
                title={time.title}
              >
                {time.text}
              </time>
            )}
          </span>
          <div className="message-content min-w-0 pr-control-normal">
            {children}
          </div>
        </div>
      </article>
    </div>
  );
}

/**
 * A quoted message reads as a smaller message inside this one: a reply or
 * forward icon beside the author, time and an action on one row, the excerpt
 * beneath. The timeline gives it a quiet tinted block; the composer's
 * preview is already framed by the composer, so it renders `plain`.
 */
export function QuoteBlock({
  label,
  kind = "reply",
  author,
  time,
  action,
  plain = false,
  attachments,
  expander,
  children,
}: {
  /** What the block is, for readers who cannot see the tint. */
  label: string;
  /** Whether the quote answers its own room or was carried in from elsewhere. */
  kind?: "reply" | "forward";
  author: string;
  time: MessageTime;
  action?: ReactNode;
  plain?: boolean;
  /** The files the original carried, already counted. */
  attachments?: string | undefined;
  /** Expands or collapses a long excerpt. */
  expander?: ReactNode;
  /** The excerpt, styled with `quoteBodyStyles`. */
  children?: ReactNode;
}) {
  const Marker = kind === "forward" ? Forward : Reply;
  return (
    <blockquote
      aria-label={label}
      className={`grid max-w-[65ch] grid-cols-[20px_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-caption text-muted ${
        plain ? "my-0 py-1" : "my-1.5 rounded-lg bg-subtle px-3 py-2"
      }`}
    >
      <Marker
        className="mt-0.5 size-4 justify-self-center"
        aria-hidden="true"
      />
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <strong className="font-semibold text-ink">{author}</strong>
        <time
          className="text-caption tabular-nums"
          dateTime={time.dateTime}
          title={time.title}
          aria-label={time.title}
        >
          {time.text}
        </time>
        {action}
      </div>
      {children}
      {attachments !== undefined && (
        <p className="col-start-2 text-fine">{attachments}</p>
      )}
      {expander !== undefined && (
        <div className="col-start-2 mt-0.5">{expander}</div>
      )}
    </blockquote>
  );
}

/** The excerpt's column and clamp; a plain quote keeps one line on phones. */
export function quoteBodyStyles({
  expanded = false,
  plain = false,
}: { expanded?: boolean; plain?: boolean } = {}) {
  return `col-start-2 ${expanded ? "" : plain ? "line-clamp-1 sm:line-clamp-3" : "line-clamp-3"}`;
}

/**
 * A text action inside a quote. It keeps the row one caption line tall: the
 * hit area grows to the shared target through padding that matching negative
 * margins take back.
 */
export function QuoteAction(
  props: Omit<ComponentProps<"button">, "className">,
) {
  return (
    <button
      type="button"
      className="-mx-1 -my-target-inset inline-flex items-center border-0 bg-transparent px-1 py-target-inset text-caption font-medium text-accent underline decoration-transparent underline-offset-3 hover:decoration-current"
      {...props}
    />
  );
}

export function ReactionBar({
  children,
  ...props
}: Omit<ComponentProps<"div">, "className">) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" {...props}>
      {children}
    </div>
  );
}

/**
 * One reaction and its count. Your own keeps its accent outline and fill;
 * an unconfirmed toggle dims until the owner's count returns.
 */
export function ReactionPill({
  emoji,
  count,
  mine,
  settled = true,
  ...props
}: {
  emoji: string;
  /** Already formatted; omitted until the owner has counted it. */
  count?: string | undefined;
  mine: boolean;
  settled?: boolean;
} & Omit<ComponentProps<"button">, "children" | "className">) {
  return (
    <button
      type="button"
      aria-pressed={mine}
      data-pending={settled ? undefined : ""}
      className={`${reactionPillStyles(mine)} ${settled ? "" : "opacity-70"}`}
      {...props}
    >
      <span aria-hidden="true">{emoji}</span>
      {count !== undefined && (
        <span aria-hidden="true" className="font-medium">
          {count}
        </span>
      )}
    </button>
  );
}

/**
 * The composer toolbar's flexible middle: one notice at a time and its
 * action. A hint gives way on touch screens; a problem stays readable and
 * scrolls within the toolbar's height.
 */
export function ComposerNotice({
  text,
  problem = false,
  hint = false,
  children,
}: {
  text: string;
  problem?: boolean;
  hint?: boolean;
  /** The notice's own action. */
  children?: ReactNode;
}) {
  return (
    <div className={composerStatusStyles} data-composer-status>
      <span
        className={`min-w-0 flex-1 ${problem ? "max-h-full overflow-y-auto overscroll-contain wrap-anywhere text-error" : "truncate"}`}
        role="status"
        aria-atomic="true"
        tabIndex={problem ? 0 : undefined}
        title={text}
      >
        <span className={hint ? "pointer-coarse:hidden" : undefined}>
          {text}
        </span>
      </span>
      {children}
    </div>
  );
}

/** The wide Send target; its visible key is the icon inside it. */
export function SendButton({
  label,
  retry = false,
  ...props
}: {
  label: string;
  /** A failed send offers Retry in the same place. */
  retry?: boolean;
} & Omit<ComponentProps<"button">, "children" | "className">) {
  return (
    <button type="submit" className={composerSendStyles} {...props}>
      <span className={composerSendIconStyles}>
        {retry ? (
          <RotateCcw className="size-4" aria-hidden="true" />
        ) : (
          <ArrowUpRight className="size-4" aria-hidden="true" />
        )}
      </span>
      <span className="sr-only">{label}</span>
    </button>
  );
}
