/**
 * The class-string recipes the shared components and both apps build on:
 * buttons, text buttons, fields and menus, the wash, motion and panel
 * layers, notices and strips, the page header and the workspace layout. A
 * recipe that only one component draws lives in that component instead.
 */

/** Shared Lucide geometry, including icons sized through CSS utilities. */
export const iconDefaults = {
  size: 18,
  strokeWidth: 1.75,
  absoluteStrokeWidth: true,
} as const;

/**
 * Hover, press and open feedback: translucent ink over whatever the control
 * sits on (see theme.css), so it always shows and never matches its background.
 */
export const washStyles =
  "not-disabled:hover:bg-wash not-disabled:active:bg-press popup-open:bg-wash";
/** The same feedback on the dark call stage. */
export const stageWashStyles =
  "not-disabled:hover:bg-stage-wash not-disabled:active:bg-stage-press popup-open:bg-stage-wash";
/**
 * Controls ease colour changes; a press lands at once and eases back. Rows and
 * menu items change instantly, so pointer sweeps and arrow keys stay immediate.
 */
export const controlMotionStyles =
  "transition-colors duration-150 ease-out active:duration-0";
/**
 * Menus, popovers and pickers share one panel that fades in and travels 4 px
 * from its trigger. `data-side` names the side of the trigger it opened on.
 */
export const floatingPanelStyles =
  "rounded-xl border border-line bg-surface text-ink shadow-popover transition-[opacity,translate] duration-150 ease-arrive starting:opacity-0 data-[side=bottom]:starting:-translate-y-1 data-[side=top]:starting:translate-y-1";

/** Shared control styles work with native elements, router links and popover triggers. */
export function buttonStyles({
  variant = "default",
  size = "default",
  shape = "rounded",
  justify = "center",
  className = "",
}: {
  /**
   * `muted` recedes until hovered; `stage` and `stage-muted` are the quiet and
   * muted controls on the dark call stage.
   */
  variant?:
    | "default"
    | "primary"
    | "quiet"
    | "muted"
    | "stage"
    | "stage-muted"
    | "danger";
  /**
   * `inset` and `icon-inset` sit inside another control, a field or a
   * toolbar, where a 44px touch target would overflow it: they grow to 36px
   * on touch screens instead and take the host's smaller radius.
   */
  size?: "default" | "small" | "icon" | "icon-small" | "inset" | "icon-inset";
  /** `round` is for circular controls; an appended `rounded-full` would lose to the base radius. */
  shape?: "rounded" | "round";
  /** `start` for row-like controls whose content aligns left. */
  justify?: "center" | "start";
  /** Only utilities the shared string does not set: a same-property append loses to it. */
  className?: string;
} = {}) {
  // Disabled filled controls drop to the subtle surface and muted ink at full
  // opacity, so nothing inert keeps the accent; quiet controls only dim.
  const inert =
    "disabled:border-line disabled:bg-subtle disabled:text-muted disabled:opacity-100 disabled:shadow-none";
  // Filled controls wash too: hovered, a default button shows its container
  // one step darker, whatever that container is. A floating one needs an
  // opaque surface behind it (timeline-jump.tsx).
  const variants = {
    default: `border-line bg-surface text-ink shadow-row ${washStyles} ${inert}`,
    primary: `border-accent bg-accent text-on-accent not-disabled:hover:bg-accent-hover not-disabled:hover:border-accent-hover not-disabled:active:bg-accent-hover not-disabled:active:border-accent-hover ${inert}`,
    quiet: `border-transparent bg-transparent text-ink ${washStyles}`,
    muted: `border-transparent bg-transparent text-muted ${washStyles} not-disabled:hover:text-ink popup-open:text-ink focus-visible:text-ink`,
    // A pressed stage toggle (picture-in-picture) keeps a raised fill and a
    // hairline, so the wash never hides its state.
    stage: `border-transparent bg-transparent text-stage-ink ${stageWashStyles} aria-pressed:border-stage-line aria-pressed:bg-stage-raised`,
    "stage-muted": `border-transparent bg-transparent text-stage-muted ${stageWashStyles} not-disabled:hover:text-stage-ink popup-open:text-stage-ink focus-visible:text-stage-ink`,
    danger: `border-error-line bg-surface text-error not-disabled:hover:bg-error-soft not-disabled:active:bg-error-soft ${inert}`,
  };
  const sizes = {
    default:
      "min-h-control-tall px-3.5 py-2 text-ui pointer-coarse:min-h-control-touch pointer-coarse:min-w-control-touch",
    small:
      "min-h-target px-3 py-1.5 text-caption pointer-coarse:min-w-control-touch",
    icon: "size-target shrink-0 p-0",
    "icon-small":
      "size-control-compact shrink-0 p-0 pointer-coarse:size-control-touch",
    inset: "h-full min-w-control-compact shrink-0 px-2 text-fine",
    "icon-inset":
      "size-control-compact shrink-0 p-0 pointer-coarse:size-control-normal",
  };
  const radius =
    shape === "round"
      ? "rounded-full"
      : size === "inset" || size === "icon-inset"
        ? "rounded-md"
        : "rounded-lg";
  const alignment = justify === "start" ? "justify-start" : "justify-center";
  return `inline-flex items-center ${alignment} gap-2 ${radius} border font-medium no-underline ${controlMotionStyles} ${variants[variant]} ${sizes[size]} ${className}`;
}

/**
 * Inline text actions; `small` follows caption-sized copy and `stage` sits on
 * the dark call stage. The label is centred in the shared target whether the
 * element is a button or a router link.
 */
export function textButtonStyles({
  size = "default",
  surface = "light",
  className = "",
}: {
  size?: "default" | "small";
  surface?: "light" | "stage";
  className?: string;
} = {}) {
  const type = size === "small" ? "text-caption" : "text-ui";
  const tone =
    surface === "stage"
      ? "px-1 font-semibold text-stage-accent disabled:text-stage-muted"
      : "font-medium text-accent disabled:text-muted";
  return `inline-flex min-h-target items-center border-0 bg-transparent py-1 text-left ${type} ${tone} underline decoration-transparent underline-offset-3 not-disabled:hover:decoration-current not-disabled:active:decoration-current disabled:opacity-100 ${controlMotionStyles} pointer-coarse:min-w-control-touch ${className}`;
}
/**
 * Every text field, select and textarea. `touch-manipulation` is here for the
 * same reason the composer carries it (see mention-field.tsx): Android Firefox
 * can auto-zoom a focused field even at 16px, which with its bottom toolbar
 * and the keyboard open made scrolling feel stuck; `manipulation` suppresses
 * the focus zoom and keeps panning and pinch zoom.
 */
export const fieldStyles =
  "min-h-control-tall w-full min-w-0 touch-manipulation rounded-lg border border-line bg-surface px-3 py-2 text-ink placeholder:text-muted placeholder:opacity-90 pointer-coarse:min-h-control-touch pointer-coarse:text-[16px]";
export const labelStyles = "flex flex-col gap-1.5 text-ui font-medium";
export const formStyles = "flex flex-col gap-4";
export const buttonRowStyles = "flex flex-wrap items-center gap-2.5";
export const fieldHintStyles =
  "text-caption font-normal leading-relaxed text-muted";
/**
 * A status line under a header, on the page gutter: reconnecting, checking
 * access, what a call still needs. Beside a text action, the message takes
 * `pt-target-inset` so the strip stays even whether the action fits on the
 * message's line or wraps below it.
 */
export const stripStyles =
  "shrink-0 border-b border-line bg-subtle px-page-gutter py-1.5 text-caption text-muted";
export function noticeStyles({
  error = false,
  size = "default",
  className = "",
}: {
  error?: boolean;
  /** `small` for a notice floating over the timeline. */
  size?: "default" | "small";
  className?: string;
} = {}) {
  return `rounded-lg border px-4 py-3 ${size === "small" ? "text-caption" : "text-ui"} ${error ? "border-error-line bg-error-soft text-error" : "border-line bg-subtle"} ${className}`;
}
export const emptyStateStyles =
  "flex flex-1 flex-col items-center justify-center gap-4 px-6 py-12 text-center [&>p]:max-w-[46ch] [&>p]:leading-relaxed";
export const chatHeaderStyles =
  "flex min-h-14 shrink-0 items-center justify-between gap-2 border-b border-line bg-surface px-page-gutter py-2 sm:min-h-15 sm:gap-3";
/** The workspace grid: Home beside the conversation from `sm`, one pane at a time below it. */
export const workspaceGridStyles =
  "group/workspace overflow-hidden sm:grid sm:grid-cols-[240px_minmax(0,1fr)] lg:grid-cols-[264px_minmax(0,1fr)]";
/** On phones Home replaces the conversation, arriving from the side it occupies on wider screens. */
export const workspaceSidebarStyles =
  "hidden h-full min-h-0 flex-col border-r border-line bg-sidebar group-data-[navigation-open=true]/workspace:flex sm:flex max-sm:transition-[opacity,translate] max-sm:duration-200 max-sm:ease-arrive max-sm:starting:-translate-x-4 max-sm:starting:opacity-0";
export const sidebarBodyStyles = "min-h-0 flex-1 overflow-auto px-2.5 pb-4";
export const workspaceMainStyles =
  "flex h-full min-h-0 min-w-0 flex-col bg-surface group-data-[navigation-open=true]/workspace:hidden sm:group-data-[navigation-open=true]/workspace:flex";
/** Menu items inside popovers; the keyboard's item shows the same wash as the pointer's. */
export const menuItemStyles =
  "flex min-h-target w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-ui text-ink not-disabled:hover:bg-wash not-disabled:active:bg-press focus-visible:bg-wash";
