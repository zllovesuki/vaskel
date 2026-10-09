import { useEffect, useLayoutEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { IdentityProfile } from "@vaskel/contracts/identity";
import { activateTransport } from "@/client/api/bookmark";
import { PRIVATE_ROOT } from "@/client/api/client";
import { UserContext } from "@/client/features/auth/session-state";

export function AccountScope({
  user,
  children,
}: {
  user: IdentityProfile;
  children: ReactNode;
}) {
  const client = useQueryClient();
  useLayoutEffect(() => activateTransport(user.userId), [user.userId]);
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: PRIVATE_ROOT });
      client.removeQueries({ queryKey: PRIVATE_ROOT });
    },
    [client, user.userId],
  );
  return <UserContext value={user}>{children}</UserContext>;
}
