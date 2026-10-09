import type { ReactNode } from "react";

export function SkipLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a
      className="fixed -top-24 left-4 z-100 rounded-lg bg-surface px-4 py-2.5 focus:top-4"
      href={href}
    >
      {children}
    </a>
  );
}
