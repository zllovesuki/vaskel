import type { ReactNode } from "react";

/**
 * What a shared view hands to an element it does not own. The view decides
 * the look, content and state; the caller decides the element and what it
 * does: a router link in the app, a button or a static span in the landing
 * page's preview.
 */
export interface ElementProps {
  className: string;
  children: ReactNode;
  "aria-current"?: "page" | undefined;
  "data-unread"?: "" | undefined;
  title?: string | undefined;
}

export type Render = (props: ElementProps) => ReactNode;
