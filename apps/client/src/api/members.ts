import { type OwnerScope } from "@vaskel/contracts/messaging";
import { api } from "@/client/api/contract";
import { queryOptions } from "@tanstack/react-query";

import { membersKey } from "@/client/api/client";

/** The people of one circle or conversation, as its owner actor authorizes them. */
export function membersOptions(userId: string, owner: OwnerScope) {
  return queryOptions({
    queryKey: membersKey(userId, owner),
    staleTime: 60_000,
    queryFn: ({ signal }) => api.members({ params: owner }, { signal: signal }),
  });
}
