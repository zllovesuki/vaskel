import { api } from "@/client/api/contract";
import { useMemo } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { privateKey } from "@/client/api/client";

import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";

export function peopleByIdOptions(userId: string, userIds: readonly string[]) {
  const ids = [...new Set(userIds)].sort();
  return queryOptions({
    queryKey: [...privateKey(userId), "people-by-id", ids],
    enabled: ids.length > 0,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const chunks: string[][] = [];
      for (let start = 0; start < ids.length; start += 40)
        chunks.push(ids.slice(start, start + 40));
      const results = await Promise.all(
        chunks.map((chunk) =>
          api.people({ query: { ids: chunk.join(",") } }, { signal: signal }),
        ),
      );
      return results.flatMap((result) => result.people);
    },
  });
}

/**
 * Display names for a set of accounts, read while the network is usable and
 * kept from the last read otherwise. `includeViewer` names the signed-in
 * account from its session rather than from the directory; `enabled` lets a
 * caller hold the read for its own reasons, such as lost access.
 */
export function useDisplayNames(
  userIds: readonly string[],
  {
    includeViewer = false,
    enabled = true,
  }: { includeViewer?: boolean; enabled?: boolean } = {},
) {
  const user = useUser();
  const { canUseNetwork } = useAccess();
  const people = useQuery({
    ...peopleByIdOptions(user.userId, userIds),
    enabled: enabled && canUseNetwork && userIds.length > 0,
  });
  const names = useMemo(() => {
    const names = new Map(
      people.data?.map((person) => [person.userId, person.displayName]),
    );
    if (includeViewer) names.set(user.userId, user.displayName);
    return names;
  }, [people.data, includeViewer, user.userId, user.displayName]);
  return { names, isPending: people.isPending, error: people.error };
}
