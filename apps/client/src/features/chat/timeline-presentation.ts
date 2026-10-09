import type { FetchStatus, QueryStatus } from "@tanstack/react-query";
import type { Timeline } from "./reconcile";

type Retry = () => Promise<unknown>;
type Recovery =
  | { kind: "offline" }
  | { kind: "checking" }
  | { kind: "failed"; error: unknown; retry: Retry };
export type ConversationRead =
  | {
      kind: "visible";
      data: Timeline;
      interaction: Recovery | { kind: "ready" };
    }
  | { kind: "withheld"; interaction: Recovery };
export type TimelinePresentation =
  | { kind: "denied"; reason: string }
  | { kind: "loading" }
  | { kind: "failed"; error: unknown; retry: Retry | null }
  | { kind: "conversation"; read: ConversationRead };

interface SnapshotRead {
  data: Timeline | undefined;
  status: QueryStatus;
  fetchStatus: FetchStatus;
  error: unknown;
}

/** A projection of existing owners, never another mutable request lifecycle. */
export function timelinePresentation(
  query: SnapshotRead,
  access: {
    canUseNetwork: boolean;
    denial: string | null;
    historyHidden: boolean;
  },
  retry: Retry,
): TimelinePresentation {
  if (access.denial) return { kind: "denied", reason: access.denial };
  if (!query.data) {
    if (query.fetchStatus === "fetching") return { kind: "loading" };
    if (query.status === "error")
      return {
        kind: "failed",
        error: query.error,
        retry: access.canUseNetwork ? retry : null,
      };
    return { kind: "loading" };
  }

  let recovery: Recovery | null = null;
  if (!access.canUseNetwork) recovery = { kind: "offline" };
  else if (query.fetchStatus === "fetching") recovery = { kind: "checking" };
  else if (query.status === "error")
    recovery = { kind: "failed", error: query.error, retry };

  if (access.historyHidden)
    return {
      kind: "conversation",
      read: { kind: "withheld", interaction: recovery ?? { kind: "checking" } },
    };
  return {
    kind: "conversation",
    read: {
      kind: "visible",
      data: query.data,
      interaction: recovery ?? { kind: "ready" },
    },
  };
}

/** Only a current, visible snapshot admits conversation interaction. */
export function canInteractWithTimeline(view: TimelinePresentation) {
  return view.kind === "conversation" && view.read.interaction.kind === "ready";
}
