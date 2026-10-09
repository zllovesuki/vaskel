import type { ReactNode } from "react";
import { stripStyles } from "@vaskel/ui/components/control-styles";

/**
 * A status line with an optional text action that follows the message and
 * wraps below it on narrow panes. The message is padded by the room the
 * action's target leaves around its label, so the strip stays even whether
 * the action sits on the message's line or on its own.
 */
export function StatusStrip({
  children,
  action,
  className = "",
}: {
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={`${stripStyles} flex flex-wrap items-baseline gap-x-3 ${className}`}
    >
      <p className={action ? "pt-target-inset" : undefined}>{children}</p>
      {action}
    </div>
  );
}
