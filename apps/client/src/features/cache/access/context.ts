import { createContext, useContext } from "react";
import type { AccessCoordinator } from "@/client/features/cache/access/coordinator";
import type { AccessSnapshot } from "./presentation";

export type Access = AccessSnapshot &
  Pick<
    AccessCoordinator,
    | "retry"
    | "checkSession"
    | "logout"
    | "signOutFailed"
    | "removeCached"
    | "ownerDenied"
    | "ownerReady"
    | "ownerToken"
    | "accountToken"
    | "accountCurrent"
    | "crossSearchToken"
    | "crossSearchCurrent"
    | "invalidateCrossSearch"
    | "invalidateOwnerContent"
    | "invalidateOwnerView"
    | "preferenceToken"
    | "acceptPreferences"
  >;
export const AccessContext = createContext<Access | null>(null);
export function useAccess() {
  const access = useContext(AccessContext);
  if (!access) throw new Error("The access coordinator is required.");
  return access;
}
