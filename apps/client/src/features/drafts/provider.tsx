import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { historyCache, draftStorage } from "@/client/features/cache/storage";
import { DraftManager } from "./manager";
import { DraftContext } from "./context";

export function DraftProvider({ children }: { children: ReactNode }) {
  const user = useUser();
  const access = useAccess();
  const [manager] = useState(() => new DraftManager(user.userId, draftStorage));
  useLayoutEffect(() => {
    manager.setAccess(access.accountFence, access.canUseNetwork);
    for (const key of access.deniedOwners) {
      const separator = key.indexOf(":");
      const kind = key.slice(0, separator);
      if (kind === "server" || kind === "conversation")
        manager.retire({ kind, id: key.slice(separator + 1) });
    }
  }, [manager, access.accountFence, access.canUseNetwork, access.deniedOwners]);
  useEffect(() => {
    const detach = manager.attach();
    const unsubscribe = historyCache.subscribe((event) => {
      if (event.type !== "cache" && !manager.matchesAccount(event)) return;
      if (event.type === "drafts_retired" && event.accountId === user.userId)
        manager.retire(event.owner, false);
      else if (event.type === "owner") manager.clearPreviews(event.owner);
    });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (manager.needsUnloadWarning()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const flush = () => {
      void manager.flush();
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
      unsubscribe();
      detach();
    };
  }, [manager, user.userId]);
  return <DraftContext value={manager}>{children}</DraftContext>;
}
