import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import {
  fieldHintStyles,
  labelStyles,
} from "@vaskel/ui/components/control-styles";
import { settingsListStyles } from "@/client/ui/settings-section";

/*
 * Loading placeholders draw only what has not arrived: names, values, bodies
 * and pictures become bones (`bone` in the client's styles.css, one
 * translucent ink fill that breathes as a group). Section titles, field
 * labels and action names stay text, and every placeholder keeps the geometry
 * of the rows it precedes so nothing moves when the content lands.
 */

/** A block standing in for an avatar, a field or a picture; the caller sets size and radius. */
export function Bone({ className = "" }: { className?: string }) {
  return <span className={`bone block rounded-lg ${className}`} />;
}

const lineSizes = {
  fine: "text-fine",
  caption: "text-caption",
  ui: "text-ui",
  chat: "text-chat",
  h1: "text-[1.8rem] leading-[1.2]",
};

/** One line of text that has not arrived, occupying that text's own line box. */
export function Line({
  size = "ui",
  width = "w-32",
  className = "",
}: {
  size?: keyof typeof lineSizes;
  width?: string;
  className?: string;
}) {
  // The width sits on the line box so percentages resolve against the row.
  return (
    <span
      className={`flex h-[1lh] max-w-full items-center ${lineSizes[size]} ${width} ${className}`}
    >
      <span className="bone h-[0.7em] w-full rounded-full" />
    </span>
  );
}

/** The progress mark for a request in flight; base.css stills it under reduced motion. */
export function Spinner({ className = "" }: { className?: string }) {
  return (
    <LoaderCircle
      className={`size-3.5 shrink-0 animate-spin ${className}`}
      aria-hidden="true"
    />
  );
}

/** A status line for a short check that is still text, marked as in progress. */
export function Working({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <p
      role="status"
      className={`flex items-center gap-1.5 text-caption text-muted ${className}`}
    >
      <Spinner />
      {children}
    </p>
  );
}

/**
 * Announces one localized wait and hides the bones from assistive technology.
 * Without a label the surface already names the state, so the bones only draw.
 */
export function Placeholder({
  label,
  kind,
  className = "",
  children,
}: {
  label?: string | undefined;
  kind: string;
  className?: string;
  children: ReactNode;
}) {
  if (label === undefined)
    return (
      <div aria-hidden="true" data-skeleton={kind} className={className}>
        {children}
      </div>
    );
  return (
    <div role="status">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" data-skeleton={kind} className={className}>
        {children}
      </div>
    </div>
  );
}

const nameWidths = ["w-32", "w-24", "w-36"];
const captionWidths = ["w-24", "w-28", "w-20"];

/** Member rows: hue monogram, name and caption, then the row's one action. */
export function PeopleSkeleton({
  label,
  rows = 3,
  lines = 2,
  action,
  className = "flex flex-col gap-1",
  rowClassName = "py-1.5",
}: {
  label: string;
  rows?: number;
  lines?: 1 | 2;
  action?: "button" | "menu";
  className?: string;
  rowClassName?: string;
}) {
  return (
    <Placeholder label={label} kind="people" className={className}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={`flex items-center gap-3 ${rowClassName}`}>
          <Bone className="size-9 rounded-[30%]" />
          <span className="min-w-0 flex-1 leading-snug">
            <Line width={nameWidths[index % 3] ?? "w-32"} />
            {lines > 1 && (
              <Line size="caption" width={captionWidths[index % 3] ?? "w-24"} />
            )}
          </span>
          {action === "button" && <Bone className="h-target w-20" />}
          {action === "menu" && (
            <Bone className="size-control-compact pointer-coarse:size-control-touch" />
          )}
        </div>
      ))}
    </Placeholder>
  );
}

/** Settings rows: hairline-separated text with a trailing action, never cards. */
export function RowsSkeleton({
  label,
  rows = 3,
  lines = 2,
  action = true,
  className = "",
  rowClassName = "py-2.5",
}: {
  label: string;
  rows?: number;
  lines?: 1 | 2;
  action?: boolean;
  className?: string;
  rowClassName?: string;
}) {
  return (
    <Placeholder
      label={label}
      kind="rows"
      className={`${settingsListStyles} ${className}`}
    >
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={`flex items-center gap-3 ${rowClassName}`}>
          <span className="min-w-0 flex-1 leading-snug">
            <Line width={index % 2 ? "w-40" : "w-48"} />
            {lines > 1 && <Line size="caption" width="w-64" />}
          </span>
          {action && <Bone className="h-target w-20" />}
        </div>
      ))}
    </Placeholder>
  );
}

/** Search results: author line, excerpt and the open action, in the results' own rows. */
export function ResultsSkeleton({
  label,
  rows = 3,
  avatar = true,
}: {
  label?: string;
  rows?: number;
  /** Home's search shows the author's monogram and place; a room's search does not. */
  avatar?: boolean;
}) {
  return (
    <Placeholder label={label} kind="results">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className={`flex gap-3 border-b border-line last:border-b-0 ${avatar ? "py-3.5" : "py-3"}`}
        >
          {avatar && <Bone className="size-9 rounded-[30%]" />}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
              <Line size={avatar ? "ui" : "caption"} width="w-28" />
              <Line size="fine" width="w-14" />
              {avatar && <Line size="fine" width="w-36" />}
            </div>
            <div className="message-body">
              <Line
                size={avatar ? "chat" : "ui"}
                width={index % 2 ? "w-[58%]" : "w-[76%]"}
              />
              <Line size={avatar ? "chat" : "ui"} width="w-[40%]" />
            </div>
            {avatar && <Line size="ui" width="w-28" className="min-h-target" />}
          </div>
        </div>
      ))}
    </Placeholder>
  );
}

/** A field whose label is known and whose value is not. */
export function FieldSkeleton({
  label,
  hint,
  control = "field",
}: {
  label: ReactNode;
  hint?: ReactNode;
  control?: "field" | "checkbox";
}) {
  if (control === "checkbox")
    return (
      <span className="flex items-start gap-2.5 text-ui">
        <Bone className="mt-1 size-4 rounded-sm" />
        <span className="min-w-0">
          <span className="block font-medium">{label}</span>
          {hint && <span className={fieldHintStyles}>{hint}</span>}
        </span>
      </span>
    );
  return (
    <span className={labelStyles}>
      {label}
      <Bone className="min-h-control-tall w-full pointer-coarse:min-h-control-touch" />
      {hint && <span className={fieldHintStyles}>{hint}</span>}
    </span>
  );
}

/**
 * A control whose request is running keeps its footprint: both labels occupy
 * one grid cell, and only the pending one, with its progress mark, is visible.
 */
export function PendingLabel({
  pending,
  label,
  children,
}: {
  pending: boolean;
  /** What the control is doing, such as "Loading…". */
  label: string;
  children: ReactNode;
}) {
  return (
    <span className="grid place-items-center *:col-start-1 *:row-start-1">
      <span className={pending ? "invisible" : undefined}>{children}</span>
      <span
        className={`inline-flex items-center gap-1.5 ${pending ? "" : "invisible"}`}
      >
        <Spinner />
        {label}
      </span>
    </span>
  );
}
