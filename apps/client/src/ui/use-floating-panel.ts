import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
  type UseFloatingOptions,
} from "@floating-ui/react";

/**
 * Where menus, popovers and pickers open: below the end of their trigger,
 * flipping when there is no room and keeping 12px from the viewport's edge.
 * `gap` is each kind's distance from its trigger. The trigger takes
 * `setReference`; `FloatingPanel` takes the rest.
 */
export function useFloatingPanel({
  open,
  onOpenChange,
  gap,
  reference,
}: {
  open: boolean;
  onOpenChange: NonNullable<UseFloatingOptions["onOpenChange"]>;
  gap: number;
  /** A trigger rendered elsewhere, for panels that do not own theirs. */
  reference?: Element | null;
}) {
  const {
    refs: { setReference, setFloating },
    floatingStyles,
    placement,
    context,
  } = useFloating({
    open,
    onOpenChange,
    placement: "bottom-end",
    whileElementsMounted: autoUpdate,
    middleware: [offset(gap), flip(), shift({ padding: 12 })],
    ...(reference === undefined ? {} : { elements: { reference } }),
  });
  return {
    context,
    setReference,
    setFloating,
    floatingStyles,
    side: placement.split("-")[0],
  };
}
