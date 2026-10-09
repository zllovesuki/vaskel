import type { ResourceSummary } from "@vaskel/contracts/directory";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import { message, UiMessageError } from "@/client/features/i18n/messages";
import { selectResource, type RememberedPlace } from "./resource-selection";

type Channel = ResourceSummary["channels"][number];
export type PageState =
  | { kind: "loading" }
  | { kind: "error"; error: unknown; retry(): Promise<unknown> }
  | { kind: "empty" }
  | { kind: "unavailable" };
export type DefaultDestination =
  | PageState
  | { kind: "discovering" }
  | { kind: "redirect"; target: RememberedPlace };
export type RoomDestination =
  | { kind: "missing-channel"; owner: OwnerScope }
  | {
      kind: "text";
      resource: ResourceSummary;
      channel: Channel & { kind: "text" };
    }
  | {
      kind: "media";
      resource: ResourceSummary;
      channel: Channel & { kind: "media" };
    };

interface Read {
  isPending: boolean;
  error: unknown;
  refetch(): Promise<unknown>;
}
interface Discovery extends Read {
  hasNextPage: boolean;
  partial: boolean;
  pageCount: number;
}

/** Only Home searches discovery for a default; a failed page is a stopped read. */
export function defaultDestination(
  resources: ResourceSummary[],
  remembered: RememberedPlace | null,
  directory: Discovery,
): DefaultDestination {
  const { resource, channel } = selectResource(resources, {}, remembered);
  if (resource && channel)
    return {
      kind: "redirect",
      target: { owner: resource.owner, channelId: channel.id },
    };
  if (directory.error)
    return { kind: "error", error: directory.error, retry: directory.refetch };
  if (directory.isPending) return { kind: "loading" };
  if (directory.hasNextPage && directory.pageCount < 21)
    return { kind: "discovering" };
  if (directory.partial || directory.hasNextPage)
    return {
      kind: "error",
      error: new UiMessageError(message("workspace.incompleteCheck")),
      retry: directory.refetch,
    };
  return { kind: "empty" };
}

/** Only an authorized owner result supplies a room; sidebar data is never a fallback. */
export function roomDestination(
  resource: ResourceSummary,
  channelId?: string,
): RoomDestination {
  const channel = channelId
    ? resource.channels.find((channel) => channel.id === channelId)
    : resource.channels[0];
  if (!channel) return { kind: "missing-channel", owner: resource.owner };
  if (channel.kind === "media")
    return { kind: "media", resource, channel: { ...channel, kind: "media" } };
  return { kind: "text", resource, channel: { ...channel, kind: "text" } };
}
