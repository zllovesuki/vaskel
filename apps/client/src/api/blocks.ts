import { type SetBlock } from "@vaskel/contracts/blocking";
import { api } from "@/client/api/contract";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { privateKey } from "@/client/api/client";

export const blockKey = (userId: string) =>
  [...privateKey(userId), "blocks"] as const;
/** Block state arrives as inbox hints when connected; polling is the safety net. */
export const blockPollInterval = (connected: boolean) =>
  connected ? 300_000 : 15_000;

export function blockStatusOptions(
  userId: string,
  targetId: string,
  refetchInterval = 15_000,
) {
  return queryOptions({
    queryKey: [...blockKey(userId), "person", targetId],
    queryFn: ({ signal }) =>
      api
        .blockStatus({ params: { targetId: targetId } }, { signal: signal })
        .then((result) => result.status),
    retry: false,
    refetchInterval,
  });
}

export function directBlockOptions(
  userId: string,
  conversationId: string,
  refetchInterval = 15_000,
) {
  return queryOptions({
    queryKey: [...blockKey(userId), "conversation", conversationId],
    queryFn: ({ signal }) =>
      api
        .directStatus(
          { params: { kind: "conversation", id: conversationId } },
          { signal: signal },
        )
        .then((result) => result.status),
    retry: false,
    refetchInterval,
  });
}

export function blockedPeopleOptions(userId: string, refetchInterval = 15_000) {
  return infiniteQueryOptions({
    queryKey: [...blockKey(userId), "list"],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      api.blocks(
        { query: { after: pageParam ?? undefined } },
        { signal: signal },
      ),
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
    refetchInterval,
  });
}

export function roomBlockOptions(
  userId: string,
  targetIds: readonly string[],
  refetchInterval = 15_000,
) {
  const ids = [...new Set(targetIds)].filter((id) => id !== userId).sort();
  return queryOptions({
    queryKey: [...blockKey(userId), "room-people", ids],
    enabled: ids.length > 0,
    queryFn: ({ signal }) =>
      api.resolveBlocks({ body: { targetIds: ids } }, { signal: signal }),
    retry: false,
    refetchInterval,
  });
}

export function updateBlock(
  targetId: string,
  command: SetBlock,
  signal: AbortSignal,
) {
  return api.updateBlock({ params: { targetId }, body: command }, { signal });
}
