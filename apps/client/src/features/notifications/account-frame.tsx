import type { ReactNode } from "react";
import { Placeholder } from "@/client/ui/loading-skeleton";

/*
 * Each section of the notification page draws its own bones while its values
 * are unknown, so the notices and titles around them never move. The panel
 * announces the wait once; these placeholders stay out of the accessibility
 * tree, and they stop breathing when nothing is being fetched.
 */

/** A section's bones; `still` while offline or after a failed load. */
export function SectionBones({
  kind,
  still,
  className = "",
  children,
}: {
  kind: string;
  still: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Placeholder
      kind={kind}
      className={`${className} ${still ? "[&_.bone]:animate-none" : ""}`}
    >
      {children}
    </Placeholder>
  );
}

/** A button whose action is not yet known keeps the footprint of the one most likely to appear. */
export function ActionBone({ label }: { label: string }) {
  return (
    <span className="bone inline-flex min-h-control-tall items-center rounded-lg border border-transparent px-3.5 py-2 text-ui font-medium text-transparent select-none pointer-coarse:min-h-control-touch">
      {label}
    </span>
  );
}
