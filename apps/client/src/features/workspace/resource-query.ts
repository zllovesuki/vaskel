import { api } from "@/client/api/contract";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { type OwnerScope } from "@vaskel/contracts/messaging";
import {
  ApiError,
  apiFailure,
  resourceDirectoryKey,
} from "@/client/api/client";
import { useDisplayNames } from "@/client/api/people";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { useAccountEvents } from "@/client/features/account-events/context";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { conversationCounterparts, titledResource } from "./conversation-title";

/** The named owner's authorized metadata; discovery omission never answers this read. */
export function resourceOptions(userId: string, owner: OwnerScope) {
  return queryOptions({
    queryKey: resourceDirectoryKey(userId, owner),
    queryFn: async ({ signal }) => {
      try {
        const resource = await api.resource({ params: owner }, { signal });
        if (
          resource.owner.kind !== owner.kind ||
          resource.owner.id !== owner.id
        )
          throw new ApiError("unavailable", undefined, "contract");
        return resource;
      } catch (error) {
        const failure = apiFailure(error);
        if (failure && ["forbidden", "not_found"].includes(failure.code))
          return null;
        throw error;
      }
    },
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    networkMode: "always",
    retry: false,
  });
}

/** The owner route alone fetches/polls; the sidebar observes the same Query. */
export function useResourceQuery(owner: OwnerScope) {
  const user = useUser();
  const access = useAccess();
  const inbox = useAccountEvents();
  const { language } = useI18n();
  const query = useQuery({
    ...resourceOptions(user.userId, owner),
    enabled: access.canUseNetwork,
    refetchInterval: inbox.connected ? 60_000 : 30_000,
  });
  const { names } = useDisplayNames(
    query.data ? conversationCounterparts(query.data, user.userId) : [],
  );
  return {
    ...query,
    data: query.data
      ? titledResource(query.data, user.userId, names, language)
      : query.data,
  };
}
