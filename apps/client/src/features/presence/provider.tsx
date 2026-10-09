import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { samplePresence } from "@/client/api/presence";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { PresenceContext } from "./context";
import { PresenceOwner } from "./owner";

export function PresenceProvider({ children }: { children: ReactNode }) {
  const user = useUser();
  const client = useQueryClient();
  const {
    ownerToken,
    accountToken,
    accountCurrent,
    canUseNetwork,
    deniedOwners,
  } = useAccess();
  const [presence] = useState(
    () =>
      new PresenceOwner({
        client,
        userId: user.userId,
        token: ownerToken,
        accountCurrent,
        sample: samplePresence,
      }),
  );
  const account = accountToken();
  useLayoutEffect(
    () => presence.setDenied(deniedOwners),
    [presence, deniedOwners],
  );
  useEffect(() => {
    presence.attach();
    const visible = () => {
      presence.setEnabled(
        canUseNetwork && document.visibilityState !== "hidden",
        account,
      );
    };
    const refresh = () => {
      visible();
      if (document.visibilityState !== "hidden") presence.refresh();
    };
    visible();
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => {
      presence.setEnabled(false);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [presence, account, canUseNetwork]);
  useEffect(() => () => presence.dispose(), [presence]);
  return <PresenceContext value={presence}>{children}</PresenceContext>;
}
