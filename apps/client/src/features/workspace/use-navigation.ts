import { api } from "@/client/api/contract";
import { DirectoryRepair } from "./directory-repair";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { useEffect, useRef } from "react";
import { useInfiniteQuery, useQueries } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";

import { directoryKey } from "@/client/api/client";
import { useUser } from "@/client/features/auth/session-state";
import { useAccess } from "@/client/features/cache/access/context";
import { useAccountEvents } from "@/client/features/account-events/context";
import {
  conversationCounterparts,
  titledResource,
} from "@/client/features/workspace/conversation-title";
import { useDisplayNames } from "@/client/api/people";
import { useActivity } from "@/client/features/activity/use-activity";
import { resourceOptions } from "./resource-query";

/** Sidebar discovery and its display projection do not resolve the active route. */
export function useWorkspaceNavigation() {
  const { language } = useI18n();
  const user = useUser();
  const access = useAccess();
  const inbox = useAccountEvents();
  const params = useParams({ strict: false });
  const directory = useInfiniteQuery({
    queryKey: directoryKey(user.userId),
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      api.directory(
        { query: { after: pageParam ?? undefined } },
        { signal: signal },
      ),
    getNextPageParam: (page) => page.nextCursor,
    staleTime: 15_000,
    enabled: access.canUseNetwork,
    networkMode: "always",
    retry: false,
  });
  const requestedOwner = params.serverId
    ? { kind: "server" as const, id: params.serverId }
    : params.conversationId
      ? { kind: "conversation" as const, id: params.conversationId }
      : null;
  const activeOwners = requestedOwner ? [requestedOwner] : [];
  const [destination] = useQueries({
    queries: activeOwners.map((owner) => ({
      ...resourceOptions(user.userId, owner),
      enabled: false,
    })),
  });
  const delivered =
    directory.data?.pages.flatMap((page) => page.resources) ?? [];
  // Discovery is a list, not proof that an explicitly named owner is absent.
  const matches = (resource: (typeof delivered)[number]) =>
    resource.owner.kind === requestedOwner?.kind &&
    resource.owner.id === requestedOwner.id;
  const visible = delivered.map((resource) =>
    matches(resource) && destination?.data ? destination.data : resource,
  );
  if (destination?.data && !delivered.some(matches))
    visible.push(destination.data);
  // Conversations are named after the people in them, in the viewer's language.
  const counterpartIds = visible.flatMap((resource) =>
    conversationCounterparts(resource, user.userId),
  );
  const { names: counterpartNames } = useDisplayNames(counterpartIds);
  const resources = visible.map((resource) =>
    titledResource(resource, user.userId, counterpartNames, language),
  );
  const activity = useActivity(
    user.userId,
    resources,
    Boolean(
      directory.hasNextPage ||
      directory.error ||
      directory.data?.pages.some((page) => page.partial),
    ),
  );
  const { refetch: refetchDirectory, fetchNextPage: nextDirectoryPage } =
    directory;
  const discovery = useRef<DirectoryRepair | null>(null);
  useEffect(() => {
    if (!access.canUseNetwork) return;
    const repair = new DirectoryRepair({
      interval: 60_000,
      visible: () => document.visibilityState !== "hidden",
      refresh: async () => {
        const result = await refetchDirectory({
          cancelRefetch: false,
          throwOnError: true,
        });
        return { hasNextPage: Boolean(result.data?.pages.at(-1)?.nextCursor) };
      },
      next: () =>
        nextDirectoryPage({ cancelRefetch: false, throwOnError: true }),
    });
    discovery.current = repair;
    const foreground = () => {
      void repair.refresh();
    };
    document.addEventListener("visibilitychange", foreground);
    window.addEventListener("focus", foreground);
    return () => {
      repair.dispose();
      discovery.current = null;
      document.removeEventListener("visibilitychange", foreground);
      window.removeEventListener("focus", foreground);
    };
  }, [access.canUseNetwork, refetchDirectory, nextDirectoryPage]);
  useEffect(() => {
    discovery.current?.setInterval(inbox.connected ? 60_000 : 30_000);
  }, [inbox.connected, access.canUseNetwork]);
  const canCreate =
    directory.data?.pages[0]?.canCreateServers ?? user.isOperator;

  return { directory, resources, activity, canCreate };
}

export type WorkspaceNavigation = ReturnType<typeof useWorkspaceNavigation>;
