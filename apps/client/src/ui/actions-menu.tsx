import { useRef, useState, type ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import {
  useClick,
  useDismiss,
  useInteractions,
  useListNavigation,
  useRole,
  useTypeahead,
} from "@floating-ui/react";
import {
  buttonStyles,
  menuItemStyles,
} from "@vaskel/ui/components/control-styles";
import { FloatingPanel } from "@/client/ui/floating-panel";
import { useFloatingPanel } from "@/client/ui/use-floating-panel";

export interface ActionsMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  disabled?: boolean;
  destructive?: boolean;
}

/** Command menus only; forms retain the separate dialog-style Popover. */
export function ActionsMenu({
  label,
  items,
  children = <Ellipsis aria-hidden="true" />,
  buttonClass = buttonStyles({ variant: "quiet", size: "icon" }),
  buttonLabel,
  descriptionId,
  onOpenChange,
}: {
  label: string;
  items: readonly ActionsMenuItem[];
  children?: ReactNode;
  buttonClass?: string;
  /** Names and titles the trigger when it sits among other named controls. */
  buttonLabel?: string;
  descriptionId?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<Array<HTMLButtonElement | null>>([]);
  const labelsRef = useRef<Array<string | null>>([]);
  const { setReference, ...position } = useFloatingPanel({
    open,
    onOpenChange: (value, _event, reason) => {
      if (!value && reason === "escape-key")
        triggerRef.current?.focus({ preventScroll: true });
      setOpen(value);
      onOpenChange?.(value);
    },
    gap: 4,
  });
  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions(
    [
      useClick(position.context),
      useDismiss(position.context),
      useRole(position.context, { role: "menu" }),
      useListNavigation(position.context, {
        listRef,
        activeIndex,
        onNavigate: setActiveIndex,
        loop: true,
        focusItemOnOpen: true,
        disabledIndices: items.flatMap((item, index) =>
          item.disabled ? [index] : [],
        ),
      }),
      useTypeahead(position.context, {
        listRef: labelsRef,
        activeIndex,
        onMatch: setActiveIndex,
        enabled: open,
      }),
    ],
  );
  return (
    <>
      <button
        type="button"
        ref={(element) => {
          triggerRef.current = element;
          setReference(element);
        }}
        className={buttonClass}
        aria-label={buttonLabel ?? label}
        title={buttonLabel}
        aria-describedby={descriptionId}
        {...getReferenceProps()}
      >
        {children}
      </button>
      {open && (
        <FloatingPanel
          {...position}
          focus={{ initialFocus: -1 }}
          size="menu"
          aria-label={label}
          {...getFloatingProps()}
        >
          {items.map((item, index) => (
            <button
              key={item.id}
              ref={(element) => {
                listRef.current[index] = element;
                labelsRef.current[index] = item.disabled ? null : item.label;
              }}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              data-destructive={item.destructive || undefined}
              tabIndex={activeIndex === index ? 0 : -1}
              className={`${menuItemStyles} data-[destructive=true]:text-error`}
              {...getItemProps()}
              onClick={() => {
                triggerRef.current?.focus({
                  preventScroll: true,
                });
                setOpen(false);
                onOpenChange?.(false);
                item.onSelect();
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </FloatingPanel>
      )}
    </>
  );
}
