import type { HTMLProps, ReactNode } from "react";
import {
  FloatingFocusManager,
  FloatingPortal,
  type FloatingFocusManagerProps,
} from "@floating-ui/react";
import { floatingPanelStyles } from "@vaskel/ui/components/control-styles";
import type { useFloatingPanel } from "@/client/ui/use-floating-panel";

type Positioned = ReturnType<typeof useFloatingPanel>;

/** One table of panel sizes, so no caller appends a width that loses. */
const sizes = {
  /** A form in a popover. */
  form: "max-h-[min(650px,calc(100dvh-32px))] w-[min(330px,calc(100vw-24px))] overflow-auto p-4",
  /** Choices with long names, such as microphones and cameras. */
  list: "max-h-[min(650px,calc(100dvh-32px))] w-[min(288px,calc(100vw-24px))] overflow-auto p-1.5",
  /** A command menu. */
  menu: "max-h-[min(650px,calc(100dvh-32px))] w-[min(260px,calc(100vw-24px))] overflow-auto p-1.5",
  /** The emoji grid, which never scrolls. */
  picker: "w-[min(296px,calc(100vw-24px))] p-2",
};
export type PanelSize = keyof typeof sizes;

/**
 * The panel: portalled to the body, focus managed without trapping, and
 * entering from the side of the trigger it opened on (`data-side`). The
 * caller spreads its interaction props onto it.
 */
export function FloatingPanel({
  context,
  setFloating,
  floatingStyles,
  side,
  focus,
  size,
  children,
  ...props
}: Omit<Positioned, "setReference"> & {
  focus?: Omit<FloatingFocusManagerProps, "context" | "children" | "modal">;
  size: PanelSize;
  children: ReactNode;
} & Omit<HTMLProps<HTMLDivElement>, "size" | "children" | "className">) {
  return (
    <FloatingPortal>
      <FloatingFocusManager context={context} modal={false} {...focus}>
        <div
          ref={setFloating}
          style={floatingStyles}
          data-side={side}
          className={`z-50 ${sizes[size]} ${floatingPanelStyles}`}
          {...props}
        >
          {children}
        </div>
      </FloatingFocusManager>
    </FloatingPortal>
  );
}
