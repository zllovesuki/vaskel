import type { ComponentProps, ReactNode } from "react";

/** Eight hues spaced around the wheel; equal lightness and chroma come from the theme. */
const HUES = [25, 60, 110, 160, 200, 250, 300, 340] as const;
export type Hue = (typeof HUES)[number];

/**
 * One literal class per hue: Tailwind generates each, and no hue needs an
 * inline style, which the site's content security policy refuses. The
 * `.person-hue` class in styles.css turns `--hue` into the tile's colours.
 */
const hueClasses: Record<Hue, string> = {
  25: "[--hue:25]",
  60: "[--hue:60]",
  110: "[--hue:110]",
  160: "[--hue:160]",
  200: "[--hue:200]",
  250: "[--hue:250]",
  300: "[--hue:300]",
  340: "[--hue:340]",
};

/** A stable hue for a person, derived from their account id. */
export function personHue(id: string): Hue {
  let hash = 2166136261;
  for (const unit of id) {
    hash ^= unit.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return HUES[(hash >>> 0) % HUES.length]!;
}

const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });

/** Avatar text must keep supplementary Han, combining marks and emoji intact. */
export function initial(name: string): string {
  return graphemes.segment(name)[Symbol.iterator]().next().value?.segment ?? "";
}

/** Each size pairs the tile with the type size of its initial. */
const sizes = {
  5: "size-5 text-[10px]",
  6: "size-6 text-fine",
  7: "size-7 text-fine",
  8: "size-8 text-caption",
  9: "size-9 text-ui",
  12: "size-12 text-lg",
  16: "size-16 text-[1.6rem]",
};

/**
 * A monogram tile: a person's initial in their hue, or a place's initial in
 * neutral when no hue is given (a circle, a room, this vaskel.); colour
 * identifies people. Decorative unless the caller gives it a role.
 */
export function Avatar({
  name,
  hue,
  size = 9,
  shape = "rounded",
  className = "",
  children,
  ...props
}: {
  name: string;
  hue?: Hue | undefined;
  size?: keyof typeof sizes;
  /** Message and navigation avatars are rounded squares; call avatars are circular. */
  shape?: "rounded" | "round";
  /** Additions such as placement or a ring; the tile owns its size, shape and colours. */
  className?: string;
  /** Replaces the initial, as a room's tile shows its icon. */
  children?: ReactNode;
} & Omit<ComponentProps<"span">, "children" | "className">) {
  const tone =
    hue === undefined ? "bg-subtle text-ink" : `person-hue ${hueClasses[hue]}`;
  const radius = shape === "round" ? "rounded-full" : "rounded-[30%]";
  return (
    <span
      aria-hidden="true"
      {...props}
      className={`grid shrink-0 place-items-center ${radius} font-bold ${tone} ${sizes[size]} ${className}`}
    >
      {children ?? initial(name)}
    </span>
  );
}
