import { useMatches } from "@tanstack/react-router";

/**
 * What a matched route shows. Each route declares its page as `staticData`,
 * so screens read the match instead of comparing pathnames.
 */
export type RoutePage =
  | "home"
  | "search"
  | "server"
  | "channel"
  | "people"
  | "circleSettings"
  | "conversation"
  | "account"
  | "notifications"
  | "blocked"
  | "host"
  | "signIn"
  | "invite"
  | "bootstrap"
  | "verifyEmail"
  | "resetPassword"
  | "forgotPassword"
  | "notificationReturn";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    page?: RoutePage;
  }
}

const workspacePages: ReadonlySet<RoutePage> = new Set<RoutePage>([
  "home",
  "search",
  "server",
  "channel",
  "people",
  "circleSettings",
  "conversation",
  "account",
  "notifications",
  "blocked",
  "host",
]);

/** Pages that render inside the signed-in workspace rather than the entry flow. */
export const isWorkspacePage = (page: RoutePage) => workspacePages.has(page);

export function useRoutePage(): RoutePage {
  const matches = useMatches();
  return matches[matches.length - 1]?.staticData.page ?? "home";
}
