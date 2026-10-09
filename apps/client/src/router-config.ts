import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  type RouteComponent,
} from "@tanstack/react-router";
import { z } from "zod";
import { CrossSearchQuerySchema } from "@vaskel/contracts/search";
import { ChannelSchema } from "@vaskel/contracts/resources";
import { RootLayout } from "@/client/routes/root-layout";
import { EntryScreen } from "@/client/routes/entry-screen";
import { EntryOpening } from "@/client/routes/access-opening";
import { NotFoundScreen } from "@/client/routes/not-found-screen";
import { RouteErrorScreen } from "@/client/routes/error-screen";
import { NotificationReturn } from "@/client/routes/notification-return";
import { SignInPage } from "@/client/features/auth/sign-in";
import {
  applicationPaths,
  authenticationPaths,
  notificationPaths,
} from "@/client/routes/application-paths";
import type { RoutePage } from "@/client/routes/route-page";

// A malformed value in a shared or hand-edited link is dropped, not fatal;
// the route error screen is for genuine failures.
const SearchSchema = z.object({
  q: z.string().optional().catch(undefined),
  token: z.string().optional().catch(undefined),
  /** Opens a room at one message, by its creation position. */
  at: z.number().int().optional().catch(undefined),
});
const rootRoute = createRootRoute({
  component: RootLayout,
  validateSearch: (search) => SearchSchema.parse(search),
  notFoundComponent: NotFoundScreen,
});
const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_workspace",
  component: EntryScreen,
});
const resourcePages = () =>
  import("@/client/features/workspace/resource-pages");
const globalPages = () => import("@/client/features/workspace/global-pages");
const serverRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: applicationPaths.server,
  component: lazyRouteComponent(resourcePages, "ServerLayout"),
  staticData: { page: "server" },
});
function workspacePage<Path extends string>(
  path: Path,
  name: RoutePage,
  component: RouteComponent,
) {
  return createRoute({
    getParentRoute: () => workspaceRoute,
    path,
    component,
    staticData: { page: name },
  });
}
const workspaceRoutes = workspaceRoute.addChildren([
  workspacePage(
    applicationPaths.home,
    "home",
    lazyRouteComponent(
      () => import("@/client/features/workspace/home-page"),
      "HomePage",
    ),
  ),
  createRoute({
    getParentRoute: () => workspaceRoute,
    path: applicationPaths.search,
    component: lazyRouteComponent(globalPages, "SearchPage"),
    staticData: { page: "search" },
    validateSearch: (search) =>
      z
        .object({
          q: CrossSearchQuerySchema.optional(),
          server: z.uuid().optional(),
          channel: ChannelSchema.shape.id.optional(),
        })
        .refine((value) => !value.channel || Boolean(value.server))
        .parse(search),
  }),
  serverRoute.addChildren([
    createRoute({
      getParentRoute: () => serverRoute,
      path: "/",
      component: lazyRouteComponent(resourcePages, "ServerIndexPage"),
      staticData: { page: "server" },
    }),
    createRoute({
      getParentRoute: () => serverRoute,
      path: "channels/$channelId",
      component: lazyRouteComponent(resourcePages, "ChannelPage"),
      staticData: { page: "channel" },
    }),
    createRoute({
      getParentRoute: () => serverRoute,
      path: "people",
      component: lazyRouteComponent(resourcePages, "ServerPeoplePage"),
      staticData: { page: "people" },
    }),
    createRoute({
      getParentRoute: () => serverRoute,
      path: "settings",
      component: lazyRouteComponent(resourcePages, "ServerSettingsPage"),
      staticData: { page: "circleSettings" },
    }),
  ]),
  workspacePage(
    applicationPaths.conversation,
    "conversation",
    lazyRouteComponent(resourcePages, "ConversationPage"),
  ),
  workspacePage(
    applicationPaths.account,
    "account",
    lazyRouteComponent(globalPages, "AccountPage"),
  ),
  workspacePage(
    applicationPaths.notifications,
    "notifications",
    lazyRouteComponent(globalPages, "NotificationsPage"),
  ),
  workspacePage(
    applicationPaths.blocked,
    "blocked",
    lazyRouteComponent(globalPages, "BlockedPage"),
  ),
  workspacePage(
    applicationPaths.host,
    "host",
    lazyRouteComponent(globalPages, "InstancePage"),
  ),
]);
const authenticationPages = {
  "/sign-in": {
    page: "signIn",
    component: SignInPage,
  },
  "/invite": {
    page: "invite",
    component: lazyRouteComponent(
      () => import("@/client/features/auth/invitation"),
      "InvitationPage",
    ),
  },
  "/bootstrap": {
    page: "bootstrap",
    component: lazyRouteComponent(
      () => import("@/client/features/auth/bootstrap"),
      "BootstrapPage",
    ),
  },
  "/verify-email": {
    page: "verifyEmail",
    component: lazyRouteComponent(
      () => import("@/client/features/auth/verification"),
      "VerificationPage",
    ),
  },
  "/reset-password": {
    page: "resetPassword",
    component: lazyRouteComponent(
      () => import("@/client/features/auth/password-recovery"),
      "ResetPasswordPage",
    ),
  },
  "/forgot-password": {
    page: "forgotPassword",
    component: lazyRouteComponent(
      () => import("@/client/features/auth/password-recovery"),
      "RequestPasswordResetPage",
    ),
  },
} as const satisfies Record<
  (typeof authenticationPaths)[number],
  { page: RoutePage; component: RouteComponent }
>;
function entryPage<Path extends keyof typeof authenticationPages>(path: Path) {
  const { page, component } = authenticationPages[path];
  return createRoute({
    getParentRoute: () => rootRoute,
    path,
    component,
    pendingComponent: EntryOpening,
    staticData: { page },
  });
}
export const routeTree = rootRoute.addChildren([
  workspaceRoutes,
  ...authenticationPaths.map((path) => entryPage(path)),
  ...notificationPaths.map((path) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: NotificationReturn,
      staticData: { page: "notificationReturn" },
    }),
  ),
]);
export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultErrorComponent: RouteErrorScreen,
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
