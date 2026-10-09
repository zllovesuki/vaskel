import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  directoryKey,
  resourceDirectoryKey,
  installRequestAccess,
  ownerSearchKey,
  ownerTimelineKey,
  PRIVATE_ROOT,
} from "@/client/api/client";
import { readSession } from "@/client/features/auth/session-state";
import { AccessCoordinator } from "@/client/features/cache/access/coordinator";
import { AccessContext } from "@/client/features/cache/access/context";
import { invalidateActivityAccess } from "@/client/features/activity/reconcile";
import { invalidateCrossSearch } from "@/client/features/search/invalidate";
import { historyCache } from "@/client/features/cache/storage";
import { accessSnapshot } from "./presentation";

export function AccessProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [coordinator] = useState(
    () =>
      new AccessCoordinator({
        cache: historyCache,
        identity: readSession,
        stopPrivateWork() {
          void client.cancelQueries({ queryKey: PRIVATE_ROOT });
          void client.invalidateQueries({
            queryKey: PRIVATE_ROOT,
            refetchType: "none",
          });
        },
        closeAccount() {
          void client.cancelQueries({ queryKey: PRIVATE_ROOT });
          client.removeQueries({ queryKey: PRIVATE_ROOT });
        },
        invalidateCrossSearch(accountId, owner) {
          invalidateCrossSearch(client, accountId, owner);
        },
        invalidateOwner(owner, accountId, discard) {
          if (!accountId) return;
          for (const queryKey of [
            ownerTimelineKey(accountId, owner),
            ownerSearchKey(accountId, owner),
          ]) {
            void client.cancelQueries({ queryKey });
            if (discard) client.removeQueries({ queryKey });
          }
          // A denial also ends the owner's private positions and refreshes
          // the directory now; hidden history only marks the directory stale.
          if (discard) invalidateActivityAccess(client, accountId, owner);
          void client.invalidateQueries({
            queryKey: directoryKey(accountId),
            exact: true,
            refetchType: discard ? "active" : "none",
          });
          // Let an in-flight direct denial settle instead of restarting itself.
          void client.invalidateQueries(
            {
              queryKey: resourceDirectoryKey(accountId, owner),
              refetchType: discard ? "active" : "none",
            },
            { cancelRefetch: false },
          );
        },
      }),
  );
  const state = useSyncExternalStore(
    coordinator.subscribe,
    coordinator.getSnapshot,
  );
  useEffect(() => {
    const removeTransport = installRequestAccess(coordinator.transport);
    const removeCache = historyCache.subscribe(coordinator.cacheChanged);
    const offline = () => coordinator.disconnected();
    const online = () => void coordinator.retry();
    const foreground = () => {
      const visible = document.visibilityState === "visible";
      coordinator.setVisible(visible);
      if (visible) {
        void coordinator.recheck();
        void coordinator.checkSession();
      }
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    window.addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    coordinator.start(navigator.onLine, document.visibilityState === "visible");
    return () => {
      coordinator.stop();
      removeTransport();
      removeCache();
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      window.removeEventListener("focus", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [coordinator]);
  return (
    <AccessContext
      value={{
        ...accessSnapshot(state),
        retry: coordinator.retry,
        checkSession: coordinator.checkSession,
        logout: coordinator.logout,
        signOutFailed: coordinator.signOutFailed,
        removeCached: coordinator.removeCached,
        ownerDenied: coordinator.ownerDenied,
        ownerReady: coordinator.ownerReady,
        ownerToken: coordinator.ownerToken,
        accountToken: coordinator.accountToken,
        accountCurrent: coordinator.accountCurrent,
        crossSearchToken: coordinator.crossSearchToken,
        crossSearchCurrent: coordinator.crossSearchCurrent,
        invalidateCrossSearch: coordinator.invalidateCrossSearch,
        invalidateOwnerContent: coordinator.invalidateOwnerContent,
        invalidateOwnerView: coordinator.invalidateOwnerView,
        preferenceToken: coordinator.preferenceToken,
        acceptPreferences: coordinator.acceptPreferences,
      }}
    >
      {children}
    </AccessContext>
  );
}
