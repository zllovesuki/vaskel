import { useSyncExternalStore } from "react";

/**
 * Whether a CSS media query matches right now, following later changes. A
 * component can then mount exactly one of two layouts rather than hiding one
 * of them, which keeps duplicate landmarks and controls out of the
 * accessibility tree.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", listener);
      return () => list.removeEventListener("change", listener);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** The `sm` breakpoint from @vaskel/ui/theme.css: Home sits beside the page from here up. */
export const WIDE_LAYOUT_QUERY = "(min-width: 640px)";
