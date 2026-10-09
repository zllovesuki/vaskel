import { api } from "./contract";
import { queryOptions } from "@tanstack/react-query";
import { privateKey } from "./client";

export const administrationKey = (userId: string, serverId?: string) =>
  [
    ...privateKey(userId),
    "administration",
    ...(serverId ? [serverId] : []),
  ] as const;

/** Administrative metadata remains separate from readable chat navigation. */
export function administrationOptions(userId: string, serverId: string) {
  return queryOptions({
    queryKey: administrationKey(userId, serverId),
    queryFn: ({ signal }) =>
      api.administration({ params: { id: serverId } }, { signal }),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
}
