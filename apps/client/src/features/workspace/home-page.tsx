import { useEffect } from "react";
import { Navigate, useSearch } from "@tanstack/react-router";
import { useAccess } from "@/client/features/cache/access/context";
import { useUser } from "@/client/features/auth/session-state";
import { resourceLocation } from "@/client/routes/resource-location";
import { useWorkspace } from "./context";
import { defaultDestination } from "./destination";
import {
  readRememberedPlace,
  type RememberedPlace,
} from "./resource-selection";
import { WorkspacePageState, WorkspacePending } from "./page-state";

export function DestinationRedirect({ target }: { target: RememberedPlace }) {
  const search = useSearch({ strict: false });
  return (
    <>
      <Navigate
        {...resourceLocation(target.owner, target.channelId)}
        search={{ q: search.q, token: search.token }}
        replace
      />
      <WorkspacePending />
    </>
  );
}

/** Home alone discovers a default; opening a named destination never enters this workflow. */
export function HomePage() {
  const user = useUser();
  const access = useAccess();
  const {
    navigation: { directory, resources },
  } = useWorkspace();
  const destination = defaultDestination(
    resources,
    readRememberedPlace(user.userId),
    {
      isPending: directory.isPending,
      error: directory.error,
      refetch: directory.refetch,
      hasNextPage: Boolean(directory.hasNextPage),
      partial: directory.data?.pages.some((page) => page.partial) ?? false,
      pageCount: directory.data?.pages.length ?? 0,
    },
  );
  const { fetchNextPage, isFetchingNextPage } = directory;
  useEffect(() => {
    if (
      access.canUseNetwork &&
      destination.kind === "discovering" &&
      !isFetchingNextPage
    )
      void fetchNextPage();
  }, [
    access.canUseNetwork,
    destination.kind,
    isFetchingNextPage,
    fetchNextPage,
  ]);
  if (destination.kind === "redirect")
    return <DestinationRedirect target={destination.target} />;
  if (destination.kind === "discovering") return <WorkspacePending />;
  return <WorkspacePageState state={destination} />;
}
