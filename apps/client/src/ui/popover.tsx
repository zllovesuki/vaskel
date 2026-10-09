import { buttonStyles } from "@vaskel/ui/components/control-styles";
import { useState, type ReactNode } from "react";
import {
  useClick,
  useDismiss,
  useInteractions,
  useRole,
} from "@floating-ui/react";
import { FloatingPanel, type PanelSize } from "@/client/ui/floating-panel";
import { useFloatingPanel } from "@/client/ui/use-floating-panel";

export function Popover({
  label,
  title,
  children,
  size = "form",
  buttonClass = buttonStyles({ variant: "quiet" }),
}: {
  label: ReactNode;
  /** Native tooltip for icon-only triggers whose name lives in sr-only text. */
  title?: string;
  children: (close: () => void) => ReactNode;
  /** A form, or a list of choices. */
  size?: Extract<PanelSize, "form" | "list">;
  buttonClass?: string;
}) {
  const [open, setOpen] = useState(false);
  const { setReference, ...position } = useFloatingPanel({
    open,
    onOpenChange: setOpen,
    gap: 8,
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useClick(position.context),
    useDismiss(position.context),
    useRole(position.context, { role: "dialog" }),
  ]);
  return (
    <>
      <button
        type="button"
        title={title}
        className={buttonClass}
        ref={setReference}
        {...getReferenceProps()}
      >
        {label}
      </button>
      {open && (
        <FloatingPanel {...position} size={size} {...getFloatingProps()}>
          {children(() => setOpen(false))}
        </FloatingPanel>
      )}
    </>
  );
}
