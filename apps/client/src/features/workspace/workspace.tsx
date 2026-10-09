import { Suspense, useState, useEffect, useRef } from "react";
import { Outlet } from "@tanstack/react-router";
import { PresenceVisibleContext } from "@/client/features/presence/context";
import { useMediaQuery, WIDE_LAYOUT_QUERY } from "@/client/ui/media-query";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { NotificationCleanupNotice } from "@/client/features/notifications/cleanup-notice";
import {
  workspaceGridStyles,
  workspaceMainStyles,
} from "@vaskel/ui/components/control-styles";
import { SkipLink } from "@/client/ui/skip-link";
import { useWorkspaceNavigation } from "./use-navigation";
import { WorkspaceSidebar } from "./sidebar";
import { WorkspaceContext } from "./context";
import { WorkspacePending } from "./page-state";
import { WorkspaceStatus } from "./status";

/** Account admission mounts the shell; each route/section owns its own readiness. */
export function Workspace() {
  const { t } = useI18n();
  const wide = useMediaQuery(WIDE_LAYOUT_QUERY);
  const [mobileOpen, setMobileOpen] = useState(false);
  const closeNavigation = useRef<HTMLButtonElement>(null);
  const conversation = useRef<HTMLElement>(null);
  const wasMobileOpen = useRef(false);
  useEffect(() => {
    if (mobileOpen) closeNavigation.current?.focus();
    else if (wasMobileOpen.current) {
      const toggle = conversation.current?.querySelector<HTMLButtonElement>(
        "[data-navigation-toggle]",
      );
      (toggle ?? conversation.current)?.focus();
    }
    wasMobileOpen.current = mobileOpen;
  }, [mobileOpen]);
  const navigation = useWorkspaceNavigation();

  return (
    <WorkspaceContext
      value={{ navigation, openNavigation: () => setMobileOpen(true) }}
    >
      <div
        className={`${workspaceGridStyles} h-full`}
        data-navigation-open={mobileOpen}
      >
        <SkipLink href="#conversation">{t("workspace.skip")}</SkipLink>
        <PresenceVisibleContext value={wide || mobileOpen}>
          <WorkspaceSidebar
            navigation={navigation}
            mobileOpen={mobileOpen}
            closeNavigation={closeNavigation}
            onNavigate={() => setMobileOpen(false)}
          />
        </PresenceVisibleContext>
        <PresenceVisibleContext value={wide || !mobileOpen}>
          <main
            ref={conversation}
            id="conversation"
            className={workspaceMainStyles}
            tabIndex={-1}
          >
            <WorkspaceStatus />
            <NotificationCleanupNotice />
            <Suspense fallback={<WorkspacePending />}>
              <Outlet />
            </Suspense>
          </main>
        </PresenceVisibleContext>
      </div>
    </WorkspaceContext>
  );
}
