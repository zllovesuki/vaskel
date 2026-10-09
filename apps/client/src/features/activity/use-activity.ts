import { useEffect, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { ResourceSummary } from "@vaskel/contracts/directory";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import {
  accountActivityKey,
  accountActivityOptions,
  ownerActivityOptions,
  ownerActivityKey,
  ownerIdentity,
} from "@/client/api/activity";
import { useOnline } from "@/client/features/chat/use-timeline";
import { useAccountEvents } from "@/client/features/account-events/context";
import { activityModel } from "@/client/features/activity/model";
import { syncActivityReads } from "@/client/features/activity/reconcile";
import { useCircleStatus } from "./use-circle-status";

export function useActivity(
  userId: string,
  resources: ResourceSummary[],
  directoryIncomplete: boolean,
) {
  const client = useQueryClient();
  const circles = useCircleStatus(userId);
  const online = useOnline();
  const inbox = useAccountEvents();
  // Live hints carry unread changes; the poll becomes a safety net.
  const interval = inbox.connected ? 300_000 : 60_000;
  const account = useInfiniteQuery({
    ...accountActivityOptions(userId),
    enabled: online,
    refetchInterval: online ? interval : false,
  });
  const [continuation, setContinuation] = useState<{
    owner: OwnerScope;
    after: string;
  } | null>(null);
  const extra = useInfiniteQuery({
    ...ownerActivityOptions(
      userId,
      continuation?.owner ?? { kind: "server", id: "pending" },
      continuation?.after ?? null,
    ),
    enabled: online && continuation !== null,
    refetchInterval: online ? interval : false,
  });
  const accountData = account.data;
  const extraData = extra.data;
  useEffect(() => {
    if (accountData && !account.isError)
      syncActivityReads(
        client,
        userId,
        accountData.pages.flatMap((page) => page.owners),
      );
    if (extraData && !extra.isError)
      syncActivityReads(client, userId, extraData.pages);
  }, [client, userId, accountData, extraData, account.isError, extra.isError]);
  const owners = account.isError
    ? []
    : (accountData?.pages.flatMap((page) => page.owners) ?? []);
  const unavailable =
    accountData?.pages.flatMap((page) => page.unavailableOwners) ?? [];
  const currentOwner =
    continuation &&
    owners.find(
      (owner) =>
        ownerIdentity(owner.owner) === ownerIdentity(continuation.owner),
    );
  const extraCurrent =
    !extra.isError &&
    extraData &&
    (!currentOwner ||
      extraData.pages.every(
        (page) => page.generation === currentOwner.generation,
      ));
  if (extraCurrent) owners.push(...extraData.pages);
  const model = activityModel(
    resources,
    owners,
    unavailable,
    online && !account.isError,
    circles.status,
  );
  // Circles first seen unopened are remembered as new until dismissed or
  // fully opened, so the hint survives landing in the first room.
  circles.remember(model.newOwners, model.settledOwners);
  const moreChannels = new Map(
    accountData?.pages.flatMap((page) =>
      page.owners
        .filter((owner) => owner.nextCursor)
        .map(
          (owner) => [ownerIdentity(owner.owner), owner.nextCursor!] as const,
        ),
    ),
  );
  if (continuation && extraCurrent) {
    const next = extraData.pages.at(-1)?.nextCursor;
    if (next) moreChannels.set(ownerIdentity(continuation.owner), next);
    else moreChannels.delete(ownerIdentity(continuation.owner));
  }
  return {
    ...model,
    account,
    online,
    incomplete:
      directoryIncomplete ||
      model.incomplete ||
      Boolean(account.hasNextPage) ||
      unavailable.length > 0 ||
      moreChannels.size > 0 ||
      accountData?.pageParams[0] !== null,
    moreChannels,
    earlierChannelsOwner:
      continuation &&
      extraData &&
      extraData.pageParams[0] !== continuation.after
        ? continuation.owner
        : undefined,
    restartChannels() {
      if (online && continuation)
        void client.resetQueries({
          queryKey: ownerActivityKey(userId, continuation.owner),
        });
    },
    channelErrorOwner: extra.isError ? continuation?.owner : undefined,
    channelLoadingOwner: extra.isFetching ? continuation?.owner : undefined,
    checkChannels(owner: OwnerScope, after: string) {
      if (!online) return;
      if (
        continuation &&
        ownerIdentity(continuation.owner) === ownerIdentity(owner)
      ) {
        if (extra.isError) void extra.refetch();
        else if (!extraCurrent) void extra.refetch();
        else if (extra.hasNextPage) void extra.fetchNextPage();
        else
          void client.resetQueries({
            queryKey: ownerActivityKey(userId, owner),
          });
      } else setContinuation({ owner, after });
    },
    restart() {
      if (!online) return;
      void client.resetQueries({
        queryKey: accountActivityKey(userId),
        exact: true,
      });
    },
    /** The viewer has seen the start-here hint for this circle. */
    dismissNew: circles.dismiss,
  };
}
