import { useContext, useEffect } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import { presenceKey } from "@/client/api/presence";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { PresenceVisibleContext, usePresenceOwner } from "./context";
import type { PresenceData } from "./owner";

export function usePresence(owner: OwnerScope, shown = true) {
  const user = useUser();
  const access = useAccess();
  const presence = usePresenceOwner();
  const visible = useContext(PresenceVisibleContext);
  const { kind, id } = owner;
  const token = access.ownerToken(owner);
  const enabled =
    shown &&
    visible &&
    access.canUseNetwork &&
    !access.deniedOwners.includes(`${kind}:${id}`);
  useEffect(() => {
    if (enabled) return presence?.register({ kind, id });
  }, [presence, enabled, kind, id, token]);
  const { data } = useQuery<PresenceData>({
    queryKey: presenceKey(user.userId, owner),
    queryFn: skipToken,
    staleTime: Infinity,
  });
  const current = enabled && data?.token === token ? data : undefined;
  const state = (
    userId: string | undefined,
  ): "online" | "offline" | "unknown" => {
    const sample = userId ? current?.samples[userId] : undefined;
    return sample?.state ?? "unknown";
  };
  const complete =
    current?.complete === true &&
    Object.values(current.samples).every(
      (sample) => state(sample.userId) !== "unknown",
    );
  return {
    state,
    completeFor: (ids: readonly string[]) =>
      complete && ids.every((id) => state(id) !== "unknown"),
  };
}
