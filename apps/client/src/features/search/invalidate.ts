import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import type { SearchPage } from "@/client/api/search";
import { privateKey } from "@/client/api/client";

export const crossSearchKey = (accountId: string) =>
  [...privateKey(accountId), "cross-search"] as const;

/** Cancel the current aggregate before retiring a scope, retaining other owners and cursors. */
export function invalidateCrossSearch(
  client: QueryClient,
  accountId: string,
  owner?: OwnerScope,
) {
  if (owner?.kind === "conversation") return;
  const queryKey = crossSearchKey(accountId);
  void client.cancelQueries({ queryKey });
  if (!owner) client.removeQueries({ queryKey });
  else
    client.setQueriesData<InfiniteData<SearchPage, string | null>>(
      { queryKey },
      (data) =>
        data && {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            hits: page.hits.filter((hit) => hit.serverId !== owner.id),
          })),
        },
    );
}
