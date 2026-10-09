import type { OwnerScope } from "@vaskel/contracts/messaging";
import { api } from "@/client/api/contract";
import {
  infiniteQueryOptions,
  replaceEqualDeep,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  type ActivityPage,
  type OwnerActivity,
} from "@vaskel/contracts/activity";

import { mergeChannelActivity } from "@/client/features/activity/counts";
import { privateKey } from "@/client/api/client";

export type ActivityPageResult = Extract<ActivityPage, { kind: "activity" }>;
export type ActivityData = InfiniteData<ActivityPageResult, string | null>;
export type OwnerActivityData = InfiniteData<OwnerActivity, string | null>;
export const activityKey = (userId: string) =>
  [...privateKey(userId), "activity"] as const;
export const accountActivityKey = (userId: string) =>
  [...activityKey(userId), "account"] as const;
export const ownerActivityKey = (userId: string, owner: OwnerScope) =>
  [...activityKey(userId), "owner", owner.kind, owner.id] as const;
export const ownerIdentity = (owner: OwnerScope) => `${owner.kind}:${owner.id}`;

// A response started before a socket/read update must not move positions backwards.
// Only channels returned by the current authorization check survive a refresh.
export function mergeOwnerActivity(
  previous: OwnerActivity | undefined,
  incoming: OwnerActivity,
): OwnerActivity {
  if (!previous || previous.generation !== incoming.generation) return incoming;
  const channels = new Map(
    previous.channels.map((channel) => [channel.channelId, channel]),
  );
  return {
    ...incoming,
    channels: incoming.channels.map((channel) =>
      mergeChannelActivity(channels.get(channel.channelId), channel),
    ),
  };
}
function mergeAccountPages(
  old: ActivityData | undefined,
  incoming: ActivityData,
): ActivityData {
  const owners = new Map(
    old?.pages.flatMap((page) =>
      page.owners.map((owner) => [ownerIdentity(owner.owner), owner] as const),
    ),
  );
  return {
    ...incoming,
    pages: incoming.pages.map((page) => ({
      ...page,
      owners: page.owners.map((owner) =>
        mergeOwnerActivity(owners.get(ownerIdentity(owner.owner)), owner),
      ),
    })),
  };
}
export function accountActivityOptions(userId: string) {
  return infiniteQueryOptions({
    queryKey: accountActivityKey(userId),
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      api.activity(
        { query: { after: pageParam ?? undefined } },
        { signal: signal },
      ),
    getNextPageParam: (page) => page.nextCursor,
    maxPages: 3,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: false,
    structuralSharing: (old, incoming) =>
      replaceEqualDeep(
        old,
        mergeAccountPages(
          old as ActivityData | undefined,
          incoming as ActivityData,
        ),
      ),
  });
}
export function ownerActivityOptions(
  userId: string,
  owner: OwnerScope,
  after: string | null,
) {
  return infiniteQueryOptions({
    queryKey: [...ownerActivityKey(userId, owner), after],
    initialPageParam: after,
    queryFn: ({ signal, pageParam }) =>
      api.ownerActivity(
        { params: owner, query: { after: pageParam ?? undefined } },
        { signal: signal },
      ),
    getNextPageParam: (page) => page.nextCursor,
    maxPages: 2,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: false,
    structuralSharing: (old, incoming) => {
      const previous = old as OwnerActivityData | undefined;
      const next = incoming as OwnerActivityData;
      const combined = previous?.pages[0] && {
        ...previous.pages[0],
        channels: previous.pages.flatMap((page) => page.channels),
      };
      return replaceEqualDeep(old, {
        ...next,
        pages: next.pages.map((page) => mergeOwnerActivity(combined, page)),
      });
    },
  });
}
