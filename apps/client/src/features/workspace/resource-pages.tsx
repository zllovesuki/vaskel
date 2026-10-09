import { createContext, useContext, useEffect, type ReactNode } from "react";
import { getRouteApi, Outlet } from "@tanstack/react-router";
import type { ResourceSummary } from "@vaskel/contracts/directory";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import { useUser } from "@/client/features/auth/session-state";
import { ChatPanel } from "@/client/features/chat/chat-panel";
import { MediaRoomPanel } from "@/client/features/media/room-panel";
import { useWorkspace } from "./context";
import { useResourceQuery } from "./resource-query";
import { roomDestination, type RoomDestination } from "./destination";
import { WorkspacePageState, WorkspacePending } from "./page-state";
import { DestinationRedirect } from "./home-page";
import { rememberPlace } from "./resource-selection";
import { PeoplePage } from "./people-page";
import { CircleSettingsPage } from "./circle-settings/page";

const ResourceContext = createContext<ResourceSummary | null>(null);
function useResource() {
  const resource = useContext(ResourceContext);
  if (!resource) throw new Error("Owner pages require authorized metadata.");
  return resource;
}

function ResourceBoundary({
  owner,
  children,
}: {
  owner: OwnerScope;
  children: ReactNode;
}) {
  const query = useResourceQuery(owner);
  // An unsuccessful background read retains the mounted destination and its work.
  if (query.data)
    return <ResourceContext value={query.data}>{children}</ResourceContext>;
  if (query.error)
    return (
      <WorkspacePageState
        state={{ kind: "error", error: query.error, retry: query.refetch }}
      />
    );
  if (query.isPending) return <WorkspacePending />;
  return <WorkspacePageState state={{ kind: "unavailable" }} />;
}

export function ServerLayout() {
  const { serverId } = getRouteApi("/_workspace/servers/$serverId").useParams();
  return (
    <ResourceBoundary owner={{ kind: "server", id: serverId }}>
      <Outlet />
    </ResourceBoundary>
  );
}

export function ServerIndexPage() {
  const resource = useResource();
  const destination = roomDestination(resource);
  if (destination.kind === "missing-channel")
    return <WorkspacePageState state={{ kind: "unavailable" }} />;
  return (
    <DestinationRedirect
      target={{ owner: resource.owner, channelId: destination.channel.id }}
    />
  );
}

export function ChannelPage() {
  const { channelId } = getRouteApi(
    "/_workspace/servers/$serverId/channels/$channelId",
  ).useParams();
  const resource = useResource();
  return (
    <RoomContent
      key={`${resource.owner.id}:${channelId}`}
      destination={roomDestination(resource, channelId)}
    />
  );
}

export function ConversationPage() {
  const { conversationId } = getRouteApi(
    "/_workspace/conversations/$conversationId",
  ).useParams();
  return (
    <ResourceBoundary owner={{ kind: "conversation", id: conversationId }}>
      <DirectRoom />
    </ResourceBoundary>
  );
}
function DirectRoom() {
  const resource = useResource();
  return (
    <RoomContent
      key={resource.owner.id}
      destination={roomDestination(resource)}
    />
  );
}

function RoomContent({ destination }: { destination: RoomDestination }) {
  const user = useUser();
  const { openNavigation } = useWorkspace();
  const room = destination.kind === "missing-channel" ? null : destination;
  const owner = room?.resource.owner;
  const channelId = room?.channel.id;
  useEffect(() => {
    if (owner && channelId) rememberPlace(user.userId, { owner, channelId });
  }, [owner, channelId, user.userId]);
  if (destination.kind === "missing-channel")
    return <WorkspacePageState state={{ kind: "unavailable" }} />;
  const { resource, channel } = destination;
  if (destination.kind === "media")
    return (
      <MediaRoomPanel
        resource={resource}
        channelId={channel.id}
        onNavigation={openNavigation}
      />
    );
  return (
    <ChatPanel
      key={`${user.userId}:${resource.owner.kind}:${resource.owner.id}:${channel.id}`}
      resource={resource}
      channelId={channel.id}
      onNavigation={openNavigation}
    />
  );
}

export function ServerPeoplePage() {
  const resource = useResource();
  const { openNavigation } = useWorkspace();
  return (
    <PeoplePage
      key={resource.owner.id}
      resource={resource}
      onNavigation={openNavigation}
    />
  );
}

export function ServerSettingsPage() {
  const resource = useResource();
  const { openNavigation } = useWorkspace();
  return (
    <CircleSettingsPage
      key={resource.owner.id}
      resource={resource}
      onNavigation={openNavigation}
    />
  );
}
