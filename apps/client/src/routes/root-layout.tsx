import { PresenceProvider } from "@/client/features/presence/provider";
import { lazy, Suspense } from "react";
import { Outlet } from "@tanstack/react-router";
import { AccountScope } from "@/client/features/auth/account-scope";
import { AccessProvider } from "@/client/features/cache/access/provider";
import { useAccess } from "@/client/features/cache/access/context";
import { LanguageProvider } from "@/client/features/i18n/provider";
import { AccountEventsProvider } from "@/client/features/account-events/provider";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { isWorkspacePage, useRoutePage } from "@/client/routes/route-page";
import { WorkspaceSkeleton } from "@/client/ui/workspace-skeleton";
import { AccessOpening, EntryOpening } from "./access-opening";

const AuthenticatedProviders = lazy(() => import("./authenticated-providers"));
const CachedWorkspace = lazy(() =>
  import("@/client/features/cache/cached-workspace").then((module) => ({
    default: module.CachedWorkspace,
  })),
);

export function RootLayout() {
  return (
    <AccessProvider>
      <LanguageProvider>
        <RootAccess />
      </LanguageProvider>
    </AccessProvider>
  );
}
function RootAccess() {
  return (
    <>
      <StartupAnnouncement />
      <RootView />
    </>
  );
}
/** Account admission has one announcement; mounted sections announce their own loading. */
function StartupAnnouncement() {
  const { view } = useAccess();
  const { t } = useI18n();
  const starting =
    isWorkspacePage(useRoutePage()) &&
    (view.kind === "opening" ||
      (view.kind === "cached" && view.connection.kind === "checking"));
  return (
    <p role="status" className="sr-only">
      {starting ? t("root.opening") : null}
    </p>
  );
}
function RootView() {
  const access = useAccess();
  const { text } = useI18n();
  const page = useRoutePage();
  const workspaceRoute = isWorkspacePage(page);
  const { view } = access;
  switch (view.kind) {
    case "cached":
      return (
        <Suspense fallback={<EntryOpening />}>
          <CachedWorkspace
            account={view.account}
            connection={view.connection}
            onReconnect={() => void access.retry()}
            onRemove={() => void access.removeCached()}
          />
        </Suspense>
      );
    case "opening":
      return <AccessOpening />;
    case "failed":
      return <AccessOpening error={view.error} />;
    case "signed-out":
      return (
        <>
          {view.notice && (
            <p role="status" className="bg-subtle px-6 py-3 text-ui text-muted">
              {text(view.notice)}
            </p>
          )}
          <Outlet />
        </>
      );
  }
  // Normal reconnects preserve controllers; changing accounts starts a new lifetime.
  return (
    <AccountScope key={view.user.userId} user={view.user}>
      <PresenceProvider>
        <AccountEventsProvider>
          <Suspense
            fallback={workspaceRoute ? <WorkspaceSkeleton /> : <EntryOpening />}
          >
            <AuthenticatedProviders>
              <Outlet />
            </AuthenticatedProviders>
          </Suspense>
        </AccountEventsProvider>
      </PresenceProvider>
    </AccountScope>
  );
}
