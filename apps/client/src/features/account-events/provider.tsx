import { usePresenceOwner } from "@/client/features/presence/context";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { connectAccountEvents, type AccountEventsStatus } from "./connection";
import {
  AccountEventsContext,
  type ActivityListener,
  type CallListener,
  type ContentListener,
} from "./context";

/** Listeners registered for the provider's lifetime; subscribing returns the removal. */
function useListeners<Listener>() {
  const [listeners] = useState(() => new Set<Listener>());
  const subscribe = useCallback(
    (listener: Listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    [listeners],
  );
  return [listeners, subscribe] as const;
}

/** One account-events socket per signed-in account while the network may be used. */
export function AccountEventsProvider({ children }: { children: ReactNode }) {
  const user = useUser();
  const client = useQueryClient();
  const presence = usePresenceOwner();
  const {
    canUseNetwork,
    checkSession,
    accountToken,
    accountCurrent,
    invalidateOwnerContent,
    invalidateCrossSearch,
  } = useAccess();
  const [status, setStatus] = useState<AccountEventsStatus>("connecting");
  const [callListeners, subscribeCalls] = useListeners<CallListener>();
  const [contentListeners, subscribeContent] = useListeners<ContentListener>();
  const [activityListeners, subscribeActivity] =
    useListeners<ActivityListener>();
  useEffect(() => {
    if (!canUseNetwork) return;
    let current = true;
    let connection: ReturnType<typeof connectAccountEvents> | undefined;
    const connect = () => {
      if (!current) return;
      connection = connectAccountEvents({
        client,
        userId: user.userId,
        status: setStatus,
        effects: {
          contentChanged: (owner, accessChanged) => {
            // Timelines replay only after durable retirement, and only for this
            // account's event connection; a snapshot refetch would replace a held window.
            void invalidateOwnerContent(owner, accessChanged).then(() => {
              if (!current) return;
              for (const listener of contentListeners) listener(owner);
            });
          },
          resync: invalidateCrossSearch,
          presenceChanged: (owner, userId) => presence?.refresh(owner, userId),
          callChanged: (room) =>
            Promise.all([...callListeners].map((listener) => listener(room))),
          messageArrived: (notice) => {
            for (const listener of activityListeners) listener(notice);
          },
        },
        onRevoked: () => {
          // A replaced cookie may still be valid. Admission must wait for the
          // forced current-account check, including its queued trailing read.
          const token = accountToken();
          void checkSession().then(() => {
            if (current && accountCurrent(token)) connect();
          });
        },
      });
    };
    connect();
    return () => {
      current = false;
      connection?.dispose();
    };
  }, [
    client,
    presence,
    checkSession,
    accountToken,
    accountCurrent,
    user.userId,
    canUseNetwork,
    invalidateOwnerContent,
    invalidateCrossSearch,
    callListeners,
    contentListeners,
    activityListeners,
  ]);
  const shown: AccountEventsStatus = canUseNetwork ? status : "offline";
  return (
    <AccountEventsContext
      value={{
        status: shown,
        connected: shown === "connected",
        subscribeCalls,
        subscribeContent,
        subscribeActivity,
      }}
    >
      {children}
    </AccountEventsContext>
  );
}
